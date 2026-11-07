// Engineering checks: turns a Model plus kernel results into a check report.
// Some checks run in the kernel (solid booleans, distances, tool access,
// swept envelopes); gear meshing is checked here with exact 2D tooth outlines.

import { absRate, massVolume, partMass, type Model, type EvalPart, type ReqStatus } from "./model";
import type { Span } from "../lang/ast";
import type { ChecksRequest, ChecksResult, PlacedItem } from "../kernel/protocol";
import { applyXforms, frameFor, vdot, vsub, vlen, type V2, type V3 } from "../kernel/recipe";
import { preloadOverlap } from "./preload";
import { centerDistance, densify, gearOutline, maxPenetration, tipDiameter } from "../library/gears";
import { materialDensity } from "../library/standards";
import { isPrinted } from "../library/materials";
import { fmtNum } from "../lang/values";
import { briefChecks, type GeomLookup } from "./briefChecks";
import { machineChecks } from "../machine/checks";
import { fastenerChecks } from "./fastenerChecks";
import { carriedGroups, findHolds, type MeshLookup } from "./holds";
import { completeChecks } from "./completeChecks";
import { holdChecks } from "./holdChecks";
import { linkChecks } from "./linkChecks";
import { stashSweep, sweepChecks } from "./sweepChecks";
import { stabilityChecks } from "./stability";
import { sheetChecks } from "./sheetChecks";
import { chainChecks } from "./chainChecks";
import { uciChecks } from "./uciChecks";
import type { SettingValue } from "../mfg/types";
import { hexPockets } from "../mfg/dfa";

export type CheckCategory =
  | "brief"
  | "requirement"
  | "interference"
  | "access"
  | "motion"
  | "gears"
  | "process"
  | "assembly"
  | "build"
  | "analysis"
  | "simulation"
  | "electrical"
  | "engineering"
  | "testing"
  | "fit"
  | "vibration"
  | "knocks"
  | "springs"
  | "info";
export type CheckStatus = "pass" | "fail" | "warn" | "pending" | "info";

export interface CheckItem {
  id: string;
  category: CheckCategory;
  status: CheckStatus;
  title: string;
  detail: string;
  parts?: string[];
  span?: Span;
  level?: "hard" | "soft";
  margin?: number;
  /** brief uses this check serves */
  uses?: string[];
  /** how the result was established: simulation is the finite-element or circuit solver, calculation a textbook formula, electrical rules the wiring check, physical test a test still to do */
  basis: "geometry" | "parameters" | "needs analysis" | "simulation" | "virtual test" | "calculation" | "electrical rules" | "physical test";
  /** what to change, in plain words */
  fix?: string;
  /** a change the app can make in one click */
  action?: CheckAction;
}

/** One-click fixes: for now, a setting of a part's manufacturing process (print upside down, add a setup). */
export type CheckAction = { kind: "process-setting"; label: string; part: string; setting: string; value: SettingValue };

export interface CheckReport {
  items: CheckItem[];
  counts: Record<CheckStatus, number>;
  ms: number;
}

export function buildChecksRequest(model: Model, builtHashes: Set<string>): ChecksRequest {
  const visible = model.parts.filter((p) => builtHashes.has(p.hash));
  const placed: PlacedItem[] = visible.map((p) => ({
    id: p.id,
    name: p.name,
    label: p.label,
    hash: p.hash,
    xf: p.xf,
    removable: p.removable,
    moving: !!p.motion,
    density: materialDensity(p.material),
    noInterference: !!p.gear || (!!p.imported && p.imported.kind !== "solid"),
  }));
  const access = visible
    .filter((p) => p.fastener)
    .map((p) => ({ id: p.id, headTop: p.fastener!.headTop, outward: p.fastener!.outward, diameter: p.fastener!.toolD ?? p.fastener!.key + 1.5, length: 35 }));
  const envelopes = visible
    .filter((p) => p.gear && p.motion)
    .map((p) => {
      const g = p.gear!;
      const partners = visible.filter((q) => q.gear && (q.gear.meshWith === p.name || g.meshWith === q.name)).map((q) => q.id);
      return { id: p.id, at: g.center, axis: g.axis, d: tipDiameter(g.m, g.z) + 0.2, length: g.width, ...(g.bore ? { bore: g.bore } : {}), exclude: partners };
    });
  return { placed, queries: model.geoQueries, access, envelopes, ignorePairs: contactPairs(model, visible) };
}

/** Pairs of parts that press into each other by design, so overlap checks leave them alone. */
export function contactPairs(model: Model, visible: EvalPart[] = model.parts): [string, string][] {
  // leads of parts soldered to a Kerf circuit board pass through its (undrawn) holes
  const ignorePairs: [string, string][] = [];
  const onBoard = new Map((model.machine?.components ?? []).filter((c) => c.pcb).map((c) => [c.name, c.pcb!.board]));
  for (const p of visible) {
    const board = onBoard.get(p.name);
    if (board && /\.(leads|pins|legs|headerpins)$/.test(p.id)) ignorePairs.push([p.id, board]);
    // a band presses on the tube it wraps and sits on its hooks
    if (p.band) for (const other of [...p.band.around, ...(p.band.holds ? [p.band.holds] : [])]) for (const q of visible) if (q.name === other) ignorePairs.push([p.id, q.id]);
    // a chain's rollers sit in its sprockets' tooth gaps (the chain checks look after the fit)
    if (p.chain) for (const n of p.chain.nodes) for (const q of visible) if (q.name === n.name) ignorePairs.push([p.id, q.id]);
  }
  return ignorePairs;
}

/** Pure-JS gear checks: module match, centre distance, face overlap, tooth clearance through a rotation. */
export function gearChecks(model: Model): CheckItem[] {
  const out: CheckItem[] = [];
  const gears = model.parts.filter((p) => p.gear);
  for (const g of gears) {
    const gi = g.gear!;
    if (!gi.meshWith) continue;
    const other = gears.find((q) => q.name === gi.meshWith);
    if (!other) continue;
    const go = other.gear!;
    const pair = `${other.name} → ${g.name}`;
    const base = { category: "gears" as const, parts: [g.id, other.id], span: g.span, basis: "geometry" as const };
    if (Math.abs(go.m - gi.m) > 1e-9) {
      out.push({ ...base, id: `gear-module:${g.id}`, status: "fail", title: `Gear modules match (${pair})`, detail: `m${fmtNum(go.m)} cannot mesh with m${fmtNum(gi.m)}. Meshing gears need the same module.` });
      continue;
    }
    const { u, v } = frameFor(gi.axis);
    const d = vsub(gi.center, go.center);
    const axial = vdot(d, gi.axis);
    const radial: V3 = [d[0] - gi.axis[0] * axial, d[1] - gi.axis[1] * axial, d[2] - gi.axis[2] * axial];
    const cd = vlen(radial);
    const ideal = centerDistance(gi.m, go.z, gi.z);
    const err = cd - ideal;
    const cdStatus = Math.abs(err) <= 0.05 ? "pass" : Math.abs(err) <= 0.15 ? "warn" : "fail";
    out.push({
      ...base,
      id: `gear-cd:${g.id}`,
      status: cdStatus,
      margin: -Math.abs(err),
      title: `Centre distance ${pair}`,
      detail: `${fmtNum(cd, 3)} mm, ideal ${fmtNum(ideal, 3)} mm for m${fmtNum(gi.m)} z${go.z}/z${gi.z}${cdStatus === "pass" ? "" : ` (off by ${fmtNum(err, 3)} mm)`}`,
    });
    // face width overlap along the axis
    const s1 = 0;
    const e1 = go.width;
    const s2 = axial;
    const e2 = axial + gi.width;
    const overlap = Math.min(e1, e2) - Math.max(s1, s2);
    const need = 0.5 * Math.min(go.width, gi.width);
    out.push({
      ...base,
      id: `gear-face:${g.id}`,
      status: overlap >= need - 1e-6 ? "pass" : overlap > 0 ? "warn" : "fail",
      margin: overlap - need,
      title: `Face overlap ${pair}`,
      detail: overlap > 0 ? `${fmtNum(overlap)} mm of ${fmtNum(Math.min(go.width, gi.width))} mm face width engaged` : "The gears do not overlap along their axis",
    });
    // tooth clearance through one tooth pitch of rotation
    if (cdStatus !== "fail" && overlap > 0) {
      const c2: V2 = [vdot(d, u), vdot(d, v)];
      // turning rates in the frame of the carrier both ride on (a planet and its sun), about this gear's axis
      const carrier = g.motion?.parent ?? other.motion?.parent;
      const rel = (p: EvalPart) => absRate(p.motion, gi.axis) - absRate(carrier, gi.axis);
      const r1 = other.motion || carrier ? rel(other) : 1;
      const r2 = g.motion ? rel(g) : (-r1 * go.z) / gi.z;
      let worst = 0;
      const steps = 10;
      const pitchDeg = 360 / go.z;
      for (let k = 0; k < steps; k++) {
        const a = (pitchDeg * k) / steps / (Math.abs(r1) || 1);
        const p1 = densify(gearOutline({ m: go.m, z: go.z, pa: go.pa, backlash: go.backlash, phase: go.phase + r1 * a }), 0.06 * go.m + 0.02);
        const p2 = densify(gearOutline({ m: gi.m, z: gi.z, pa: gi.pa, backlash: gi.backlash, phase: gi.phase + r2 * a }), 0.06 * gi.m + 0.02).map(([x, y]) => [x + c2[0], y + c2[1]] as V2);
        worst = Math.max(worst, maxPenetration(p1, p2), maxPenetration(p2, p1));
      }
      out.push({
        ...base,
        id: `gear-teeth:${g.id}`,
        status: worst < 0.01 ? "pass" : worst < 0.05 ? "warn" : "fail",
        margin: -worst,
        title: `Teeth clear through rotation ${pair}`,
        detail: worst < 0.01 ? `No tooth interference across ${steps} positions` : `Teeth overlap by up to ${fmtNum(worst, 3)} mm`,
      });
    }
  }
  // gears that should move but are not driven
  for (const g of gears) {
    // a fixed centre gear that planets ride round is meant to stay still
    const sun = gears.some((q) => q.gear?.meshWith === g.name && q.motion?.parent);
    if (!g.motion && !sun) {
      out.push({ category: "motion", id: `gear-driven:${g.id}`, status: "warn", title: `${g.label} is driven`, detail: `${g.name} has no spin:, mesh: or turns_with:, so nothing turns it`, parts: [g.id], span: g.span, basis: "parameters" });
    }
  }
  // overall ratio (info)
  const moving = gears.filter((g) => g.motion && Math.abs(g.motion.ratio) > 1e-9);
  if (moving.length >= 2) {
    const speeds = moving.map((g) => Math.abs(g.motion!.ratio));
    const fast = Math.max(...speeds);
    const slow = Math.min(...speeds);
    out.push({ category: "info", id: "gear-ratio", status: "info", title: "Gear train ratio", detail: `${fmtNum(fast / slow, 2)} : 1 between the fastest and slowest gear`, basis: "parameters" });
  }
  return out;
}

/** What the core checks are worked out from, besides the model. */
export interface ReportInputs {
  /** the model evaluated again with the kernel's geometric query results */
  geoModel?: Model | null;
  kernel?: ChecksResult | null;
  buildErrors?: Map<string, string>;
  /** defaults to the model's parts */
  partsById?: Map<string, EvalPart>;
  /** meshes by geometry hash, for the brief's size checks */
  geom?: GeomLookup;
  /** part meshes by geometry hash, to measure what each screw clamps */
  mesh?: MeshLookup;
  /** leave the motion sweep to the live sweep pass (sweepRuntime), which works through it a slice at a time */
  sweepLater?: boolean;
}

/**
 * The core checks. Checks from other modules (manufacturing processes,
 * analyses) are added afterwards by the passes in reportPasses.
 */
const pt = (p: V3) => `(${p.map((x) => fmtNum(x, 1)).join(", ")})`;

export function assembleReport(model: Model, inputs: ReportInputs = {}): CheckReport {
  const { geoModel = null, kernel = null, buildErrors = new Map<string, string>(), geom = () => undefined } = inputs;
  const partsById = inputs.partsById ?? new Map(model.parts.map((p) => [p.id, p]));
  const t0 = performance.now();
  const items: CheckItem[] = [];
  const label = (id: string) => partsById.get(id)?.label ?? id;

  // source errors: a statement that fails to evaluate drops out of the model, so say so loudly
  model.diagnostics.forEach((d, i) => {
    if (d.severity === "error") items.push({ id: `diag:${i}`, category: "build", status: "fail", title: "Design source error", detail: d.message, span: { start: d.start, end: d.end }, basis: "parameters" });
    // design-rule warnings from evaluation (a snap hook bent past its material's limit)
    else if (d.severity === "warning" && d.rule) items.push({ id: `diag:${i}`, category: "build", status: "warn", title: d.rule, detail: d.message, span: { start: d.start, end: d.end }, basis: "parameters" });
  });

  // build errors
  for (const p of model.parts) {
    const err = buildErrors.get(p.hash);
    if (err) items.push({ id: `build:${p.id}`, category: "build", status: "fail", title: `${p.label} builds`, detail: err, parts: [p.id], span: p.span, basis: "geometry" });
  }

  // requirements (use the geometry-resolved evaluation when available)
  const reqs = (geoModel ?? model).requirements;
  for (const r of reqs) {
    const status: CheckStatus = mapReq(r.status, r.level);
    let detail = r.detail;
    if (r.status === "pending" && kernel) {
      const errs = r.geo.map((q) => kernel.geoErrors[keyOf(q)]).filter(Boolean);
      if (errs.length) detail = errs.join("; ");
    }
    items.push({ id: `req:${r.label}`, category: "requirement", status, title: r.label, detail, span: r.span, level: r.level, margin: r.margin, uses: r.uses.length ? r.uses : undefined, basis: r.geo.length ? "geometry" : "parameters" });
  }
  items.push(...briefChecks(model, items.filter((i) => i.category === "requirement"), geom));

  const holds = findHolds(model, inputs.mesh);
  const carried = carriedGroups(model, holds);
  if (kernel) {
    let clashes = 0;
    for (const i of kernel.interferences) {
      // a sprung blade drawn unbent, pressing on its mate by its preload
      const pre = preloadOverlap(i, (id) => partsById.get(id));
      if (pre) {
        items.push({
          id: `int:${i.a}|${i.b}`,
          category: "interference",
          status: "pass",
          title: `${label(pre.host.id)} presses on ${label(pre.mate.id)} with its spring`,
          detail: `They are drawn ${fmtNum(i.volume, 1)} mm³ into each other, nowhere deeper than ${fmtNum(pre.depth, 2)} mm along the way ${pre.flex.name} bends: the ${fmtNum(pre.flex.preload!, 2)} mm it stays bent pressing on ${label(pre.mate.id)}, not a clash`,
          parts: [i.a, i.b],
          span: pre.flex.span,
          basis: "geometry",
        });
        continue;
      }
      clashes++;
      items.push({
        id: `int:${i.a}|${i.b}`,
        category: "interference",
        status: "fail",
        title: `${label(i.a)} overlaps ${label(i.b)}`,
        detail: `${fmtNum(i.volume, 1)} mm³ of solid overlap`,
        fix: overlapFix(i, partsById.get(i.a), partsById.get(i.b), kernel, geom),
        parts: [i.a, i.b],
        span: partsById.get(i.a)?.span,
        basis: "geometry",
      });
    }
    // a made part in several solids that do not touch: a feature that misses the body, or two parts in one
    // (not bought or stand-in parts, such as a printed number's separate digits)
    const split = new Set<string>();
    for (const p of model.parts) {
      const pc = kernel.pieces?.[p.hash];
      if (!pc || p.kind !== "part" || p.imported || p.processNone || split.has(p.hash)) continue;
      split.add(p.hash);
      const same = model.parts.filter((q) => q.hash === p.hash);
      const where = pc.others.map((o) => `${fmtNum(o.volume, 1)} mm³ at ${pt(applyXforms(o.at, p.xf))}`).join("; ");
      items.push({
        id: `pieces:${p.name}`,
        category: "build",
        status: "warn",
        title: `${p.label} is ${pc.count} separate pieces`,
        detail: `It is made of ${pc.count} solids that do not touch. Besides the main body: ${where}${pc.count - 1 > pc.others.length ? " and more" : ""}${same.length > 1 ? ` (in each of its ${same.length} copies)` : ""}. A feature placed where it misses the body floats in the air and would fall off when made.`,
        fix: "Move or extend the loose feature so it overlaps the body slightly, or make it a part of its own if it really is separate.",
        parts: same.map((q) => q.id),
        span: p.span,
        basis: "geometry",
      });
    }
    const solids = model.parts.length;
    if (!clashes) {
      items.push({ id: "int:none", category: "interference", status: "pass", title: "No solid interference", detail: `${solids} solids, ${kernel.pairsTested} touching pairs tested with exact booleans`, basis: "geometry" });
    }
    // a hex head sitting in a hex pocket is held by it: it needs no tool, the nut at the other end is turned
    const pockets = hexPockets(model.parts.filter((p) => p.kind === "part"));
    const captiveHead = (p: EvalPart | undefined): boolean => {
      const f = p?.fastener;
      if (!f || f.head !== "hex") return false;
      // headD is across the corners; a spanner fits across the flats
      const af = (f.headD * Math.sqrt(3)) / 2;
      const h = Math.max(1, af * 0.4);
      const c: V3 = [f.headTop[0] - f.outward[0] * (h / 2), f.headTop[1] - f.outward[1] * (h / 2), f.headTop[2] - f.outward[2] * (h / 2)];
      return pockets.some((pk) => pk.af >= af - 0.2 && pk.af <= af + 1.2 && vlen(vsub(pk.center, c)) <= pk.depth / 2 + h / 2 + 1);
    };
    for (const k of kernel.access) {
      const p = partsById.get(k.id);
      if (k.blockedBy.length && captiveHead(p)) {
        items.push({
          id: `access:${k.id}`,
          category: "access",
          status: "pass",
          title: `Tool access: ${p?.label ?? k.id}`,
          detail: "Its head sits in a hex pocket that stops it turning, so it needs no tool; the nut at the other end is the one turned",
          parts: [k.id],
          span: p?.span,
          basis: "geometry",
        });
        continue;
      }
      // a part that slides with an axis (or a screw that does) is moved out of the way by hand to reach the screw
      const slid = k.blockedBy.filter((b) => (carried.has(b) || carried.has(k.id)) && carried.get(b) !== carried.get(k.id));
      const a = slid.length ? { ...k, blockedBy: k.blockedBy.filter((b) => !slid.includes(b)) } : k;
      items.push({
        id: `access:${a.id}`,
        category: "access",
        status: a.blockedBy.length ? "fail" : "pass",
        title: `Tool access: ${p?.label ?? a.id}`,
        detail: a.blockedBy.length
          ? `A ${p?.fastener ? (p.fastener.tool ?? fmtNum(p.fastener.key) + " mm hex key") : "tool"} is blocked by ${a.blockedBy.map(label).join(", ")}`
          : `${p?.fastener ? (p.fastener.tool ?? fmtNum(p.fastener.key) + " mm hex key").replace(/^./, (c) => c.toUpperCase()) : "Tool"} reaches the head (${slid.length ? `with ${[...new Set(slid.map(label))].join(", ")} slid along ${slid.length === 1 ? "its" : "their"} axis out of the way` : "removable covers off"})`,
        ...(a.blockedBy.length && p?.fastener
          ? { fix: `The tool needs a straight path of ${fmtNum(p.fastener.toolD ?? p.fastener.key + 1.5, 1)} mm across and 35 mm long out from the head along ${dirName(p.fastener.outward)}. Cut an access hole of at least ${fmtNum((p.fastener.toolD ?? p.fastener.key + 1.5) + 1, 1)} mm through ${a.blockedBy.map(label).join(", ")} in line with the screw, move the screw clear of ${a.blockedBy.length === 1 ? "it" : "them"}, put it in from the other side with the nut here, or mark the part in the way removable if it comes off to assemble.` }
          : {}),
        parts: [a.id, ...a.blockedBy],
        span: p?.span,
        basis: "geometry",
      });
    }
    for (const env of kernel.envelopes) {
      const p = partsById.get(env.id);
      items.push({
        id: `env:${env.id}`,
        category: "motion",
        status: env.hits.length ? "fail" : "pass",
        title: `${p?.label ?? env.id} turns freely`,
        detail: env.hits.length ? `Its swept tip circle cuts into ${env.hits.map(label).join(", ")}` : "Swept tip circle clears all static parts",
        ...(env.hits.length && p?.gear ? { fix: `Keep ${env.hits.map(label).join(", ")} out of the ${fmtNum(tipDiameter(p.gear.m, p.gear.z), 1)} mm circle the teeth sweep about the axis through ${pt(p.gear.center)}: at least ${fmtNum(tipDiameter(p.gear.m, p.gear.z) / 2 + 1, 1)} mm from the axis over the gear's ${fmtNum(p.gear.width, 1)} mm face, or recess ${env.hits.length === 1 ? "it" : "them"} there.` } : {}),
        parts: [env.id, ...env.hits],
        span: p?.span,
        basis: "geometry",
      });
    }
  }
  items.push(...gearChecks(model));
  items.push(...fastenerChecks(model));
  // a part given its real mass (a hollow frame modelled solid) weighs that, wherever weight matters
  const volumeOf = (p: EvalPart) => massVolume(p, geom(p.hash)?.volume, materialDensity(p.material));
  items.push(...holdChecks(model, holds, kernel, volumeOf));
  items.push(...completeChecks(model, holds, kernel, inputs.mesh));
  items.push(...linkChecks(model));
  if (kernel && inputs.mesh) {
    const sweep = { model, holds, kernel, mesh: inputs.mesh, ignore: contactPairs(model) };
    if (inputs.sweepLater) stashSweep(sweep);
    else items.push(...sweepChecks(sweep.model, sweep.holds, sweep.kernel, sweep.mesh, sweep.ignore));
    items.push(...stabilityChecks(model, holds, kernel, inputs.mesh, volumeOf));
  }
  items.push(...sheetChecks(model));
  items.push(...chainChecks(model));
  items.push(...uciChecks(model, inputs.mesh, (p) => partMass(p, geom(p.hash)?.volume, materialDensity(p.material))));
  if (model.machine) items.push(...machineChecks(model.machine));

  // things geometry cannot prove
  if (model.parts.some((p) => p.motion)) {
    items.push({ id: "analysis:loads", category: "info", status: "info", title: "Torque, tooth strength and wear", detail: "Not verified yet. Add an analysis block with drive:, torque: and speed: (or ask Claude to) to check tooth bending, bearing life and shaft torsion, then test a printed prototype.", basis: "needs analysis" });
  }
  if (model.parts.some((p) => p.kind === "part" && isPrinted(p.material))) {
    items.push({ id: "analysis:print", category: "info", status: "info", title: "Print tolerances", detail: "Hole and boss fits assume a calibrated printer (±0.15 mm). Print a fit test before a full build.", basis: "needs analysis" });
  }

  return finishReport(items, performance.now() - t0 + (kernel?.ms ?? 0));
}

/** Order items by status and count them (also used when analysis results are merged in later). */
export function finishReport(items: CheckItem[], ms: number): CheckReport {
  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, pending: 2, pass: 3, info: 4 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, pending: 0, info: 0 };
  for (const i of items) counts[i.status]++;
  return { items, counts, ms };
}

const dirName = (d: V3) => {
  const k = [0, 1, 2].reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a), 0);
  return Math.abs(d[k]) > 0.97 ? `${d[k] > 0 ? "+" : "-"}${"XYZ"[k]}` : pt(d);
};

/**
 * What to do about an overlap, worked out from where the parts overlap: the same part twice, one part sunk
 * wholly in another (a pocket or bore not cut), or a slab of overlap whose thinnest side says how far to move.
 */
function overlapFix(i: NonNullable<ReportInputs["kernel"]>["interferences"][number], a: EvalPart | undefined, b: EvalPart | undefined, kernel: NonNullable<ReportInputs["kernel"]>, geom: GeomLookup): string | undefined {
  if (!a || !b) return undefined;
  const va = geom(a.hash)?.volume;
  const vb = geom(b.hash)?.volume;
  if (a.hash === b.hash && va && i.volume > 0.9 * va) return `${a.name} and ${b.name} are the same shape in the same place: one is a copy left behind. Delete it, or move it to where the second one belongs.`;
  const small = va !== undefined && vb !== undefined ? (va <= vb ? a : b) : undefined;
  const big = small === a ? b : a;
  const vs = small === a ? va : vb;
  if (small && vs && i.volume > 0.85 * vs) return `${small.name} sits wholly inside ${big.name}. If it fits into ${big.name}, cut its seat: cut ${small.libKind ? "a pocket or bore the size of " + small.name : small.name} from ${big.name} (with running or press clearance); otherwise move ${small.name} out to where it mounts.`;
  // the overlap's thinnest side is how far apart to move them, along that axis
  let lo: V3 = [i.center[0], i.center[1], i.center[2]];
  let hi: V3 = [...lo];
  const P = i.mesh?.positions;
  if (P && P.length >= 9) {
    lo = [Infinity, Infinity, Infinity];
    hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < P.length; k += 3)
      for (let d = 0; d < 3; d++) {
        lo[d] = Math.min(lo[d], P[k + d]);
        hi[d] = Math.max(hi[d], P[k + d]);
      }
  } else {
    const r = Math.cbrt(i.volume) / 2;
    lo = lo.map((x) => x - r) as V3;
    hi = hi.map((x) => x + r) as V3;
  }
  const ext = [0, 1, 2].map((d) => hi[d] - lo[d]);
  const axis = [0, 1, 2].reduce((m, d) => (ext[d] < ext[m] ? d : m), 0);
  const ba = kernel.boxes?.[i.a];
  const bb = kernel.boxes?.[i.b];
  const ca = ba ? (ba[0][axis] + ba[1][axis]) / 2 : 0;
  const cb = bb ? (bb[0][axis] + bb[1][axis]) / 2 : 0;
  const sign = ca >= cb ? "+" : "-";
  const other = sign === "+" ? "-" : "+";
  const by = fmtNum(ext[axis] + 0.1, 2);
  return `They overlap in a ${ext.map((x) => fmtNum(x, 1)).join(" × ")} mm region around ${pt([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2])}, ${fmtNum(ext[axis], 2)} mm deep along ${"XYZ"[axis]}. Move ${a.name} ${by} mm along ${sign}${"XYZ"[axis]} (or ${b.name} along ${other}${"XYZ"[axis]}), or trim the one that should give way. Place them from the same numbers as the faces they meet, so they touch without overlapping.`;
}

function mapReq(s: ReqStatus, level: "hard" | "soft"): CheckStatus {
  if (s === "pass") return "pass";
  if (s === "pending") return "pending";
  if (s === "error") return "fail";
  return level === "soft" ? "warn" : "fail";
}

import { geoKey } from "../lang/values";
const keyOf = geoKey;
