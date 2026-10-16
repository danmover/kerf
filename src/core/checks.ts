// Engineering checks: turns a Model plus kernel results into a check report.
// Some checks run in the kernel (solid booleans, distances, tool access,
// swept envelopes); gear meshing is checked here with exact 2D tooth outlines.

import type { Model, EvalPart, ReqStatus } from "./model";
import type { Span } from "../lang/ast";
import type { ChecksRequest, ChecksResult, PlacedItem } from "../kernel/protocol";
import { frameFor, vdot, vsub, vlen, type V2, type V3 } from "../kernel/recipe";
import { centerDistance, densify, gearOutline, maxPenetration, tipDiameter } from "../library/gears";
import { materialDensity } from "../library/standards";
import { isPrinted } from "../library/materials";
import { fmtNum } from "../lang/values";
import { briefChecks, type GeomLookup } from "./briefChecks";
import { machineChecks } from "../machine/checks";

export type CheckCategory = "brief" | "requirement" | "interference" | "access" | "motion" | "gears" | "build" | "electrical" | "engineering" | "testing" | "info";
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
  /** how the result was established */
  basis: "geometry" | "parameters" | "needs analysis" | "electrical rules" | "calculation" | "physical test";
}

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
    .map((p) => ({ id: p.id, headTop: p.fastener!.headTop, outward: p.fastener!.outward, diameter: p.fastener!.key + 1.5, length: 35 }));
  const envelopes = visible
    .filter((p) => p.gear && p.motion)
    .map((p) => {
      const g = p.gear!;
      const partners = visible.filter((q) => q.gear && (q.gear.meshWith === p.name || g.meshWith === q.name)).map((q) => q.id);
      return { id: p.id, at: g.center, axis: g.axis, d: tipDiameter(g.m, g.z) + 0.2, length: g.width, exclude: partners };
    });
  return { placed, queries: model.geoQueries, access, envelopes, ignorePairs: [] };
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
      const r1 = other.motion?.ratio ?? 1;
      const r2 = g.motion?.ratio ?? (-r1 * go.z) / gi.z;
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
    if (!g.motion) {
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

export function assembleReport(model: Model, geoModel: Model | null, kernel: ChecksResult | null, buildErrors: Map<string, string>, partsById: Map<string, EvalPart>, geom: GeomLookup = () => undefined): CheckReport {
  const t0 = performance.now();
  const items: CheckItem[] = [];
  const label = (id: string) => partsById.get(id)?.label ?? id;

  // source errors: a statement that fails to evaluate drops out of the model, so say so loudly
  model.diagnostics.forEach((d, i) => {
    if (d.severity !== "error") return;
    items.push({ id: `diag:${i}`, category: "build", status: "fail", title: "Design source error", detail: d.message, span: { start: d.start, end: d.end }, basis: "parameters" });
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

  if (kernel) {
    for (const i of kernel.interferences) {
      items.push({
        id: `int:${i.a}|${i.b}`,
        category: "interference",
        status: "fail",
        title: `${label(i.a)} overlaps ${label(i.b)}`,
        detail: `${fmtNum(i.volume, 1)} mm³ of solid overlap`,
        parts: [i.a, i.b],
        span: partsById.get(i.a)?.span,
        basis: "geometry",
      });
    }
    const solids = model.parts.length;
    if (!kernel.interferences.length) {
      items.push({ id: "int:none", category: "interference", status: "pass", title: "No solid interference", detail: `${solids} solids, ${kernel.pairsTested} touching pairs tested with exact booleans`, basis: "geometry" });
    }
    for (const a of kernel.access) {
      const p = partsById.get(a.id);
      items.push({
        id: `access:${a.id}`,
        category: "access",
        status: a.blockedBy.length ? "fail" : "pass",
        title: `Tool access: ${p?.label ?? a.id}`,
        detail: a.blockedBy.length ? `A ${p?.fastener ? fmtNum(p.fastener.key) + " mm hex key" : "tool"} is blocked by ${a.blockedBy.map(label).join(", ")}` : `${p?.fastener ? fmtNum(p.fastener.key) + " mm hex key" : "Tool"} reaches the head (removable covers off)`,
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
        parts: [env.id, ...env.hits],
        span: p?.span,
        basis: "geometry",
      });
    }
  }
  items.push(...gearChecks(model));
  if (model.machine) items.push(...machineChecks(model.machine));

  // things geometry cannot prove
  if (model.parts.some((p) => p.gear && p.motion)) {
    items.push({ id: "analysis:loads", category: "info", status: "info", title: "Torque, tooth strength and wear", detail: "Not verified by geometry. Check gear tooth bending stress and bearing loads for the expected torque, then test a printed prototype.", basis: "needs analysis" });
  } else if (model.parts.some((p) => p.motion)) {
    items.push({ id: "analysis:loads", category: "info", status: "info", title: "Strength and wear of moving parts", detail: "Not verified by geometry. Printed parts that carry torque or thrust can creep, wear or crack: test a printed prototype under load before relying on it.", basis: "needs analysis" });
  }
  if (model.parts.some((p) => p.kind === "part" && isPrinted(p.material))) {
    items.push({ id: "analysis:print", category: "info", status: "info", title: "Print tolerances", detail: "Hole and boss fits assume a calibrated printer (±0.15 mm). Print a fit test before a full build.", basis: "needs analysis" });
  }

  const order: Record<CheckStatus, number> = { fail: 0, warn: 1, pending: 2, pass: 3, info: 4 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, pending: 0, info: 0 };
  for (const i of items) counts[i.status]++;
  return { items, counts, ms: performance.now() - t0 + (kernel?.ms ?? 0) };
}

function mapReq(s: ReqStatus, level: "hard" | "soft"): CheckStatus {
  if (s === "pass") return "pass";
  if (s === "pending") return "pending";
  if (s === "error") return "fail";
  return level === "soft" ? "warn" : "fail";
}

import { geoKey } from "../lang/values";
const keyOf = geoKey;
