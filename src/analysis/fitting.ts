// How a design goes together by hand and what then keeps it there, as steps
// the viewport plays: a part held on by bands comes up to what they wrap,
// each band is hooked over its first pin, pulled round and stretched over the
// second pin's head (with its real stretch and pull as it goes), a part that
// clicks onto a peg slides along the arm until it clicks, and each analysis
// that checks a seat shows its loads and how much of the grip they use. Parts
// that sit inside another's box (a pad in a seat, the print on a sign) ride
// along with it.

import type { EvalPart, FlexInfo, Model } from "../core/model";
import { applyXforms, applyXformsToDir, vadd, vdot, vlen, vnorm, vscale, vsub, type V3 } from "../kernel/recipe";
import { fittingPose, rubberOf, sectionOf, type BandCord, type BandLayout, type FitPose, type Section } from "../library/bands";
import { flexCalc } from "../library/springs";
import { fmtNum } from "../lang/values";
import type { StructuralSpec } from "./spec";
import type { StructuralResult } from "./fe/structural";
import { contactVerdicts } from "./summary";

export interface FitArrow {
  at: V3;
  /** unit direction the load pushes */
  dir: V3;
  /** N */
  size: number;
}

export type FitStep =
  | { kind: "seat"; part: string; riders: string[]; from: V3; title: string; caption: string; dur: number }
  | { kind: "band"; part: string; name: string; around: string; holds: string; layout: BandLayout; sections: Section[]; cord: BandCord; title: string; dur: number }
  | { kind: "slide"; part: string; riders: string[]; host: string; from: V3; peg: V3; title: string; caption: string; dur: number }
  | { kind: "hold"; spec: StructuralSpec; parts: string[]; hooks: V3[]; centre: V3; title: string; dur: number };

const pct = (stretch: number) => `${fmtNum((stretch - 1) * 100, 0)} %`;
/** A band's name as words: o_ring and oring read "O-ring". */
const bandName = (name: string) => name.replace(/_/g, " ").replace(/\bo ?ring\b/i, "O-ring");

/** Every part that moves when the given one does: the parts whose box lies inside its own. */
export const moves = (s: Extract<FitStep, { kind: "seat" | "slide" }>) => [s.part, ...s.riders];

/** Whether the design has anything that goes on by hand worth showing: a band hooked at both ends, or a snap or a sprung pin that holds a part by a hole. */
export function hasFitting(model: Model): boolean {
  return model.parts.some((p) => p.band?.layout.doubled || p.flex?.some((f) => (f.kind === "snap" || f.kind === "flexure") && f.peg));
}

/**
 * The steps, in the order a person does them. bbox gives a part's own
 * bounding box (before its placement), to find what a peg clicks into;
 * results are the latest structural runs by analysis label.
 */
export function fittingSteps(model: Model, bbox: (p: EvalPart) => [V3, V3] | undefined): FitStep[] {
  const steps: FitStep[] = [];
  const byName = new Map(model.parts.map((p) => [p.name, p]));
  const bands = model.parts.filter((p) => p.band?.layout.doubled);
  const seated = new Set<string>();
  const riders = riderMap(model, bbox);
  const riding = new Set([...riders.values()].flat());
  for (const b of bands) {
    const info = b.band!;
    const holds = info.holds ? byName.get(info.holds) : undefined;
    const around = info.around.map((n) => byName.get(n)).filter((p): p is EvalPart => !!p);
    const sections: Section[] = [];
    for (const a of around) {
      try {
        sections.push(sectionOf(a.recipe, a.xf));
      } catch {
        // the band check already says why it cannot read the outline
      }
    }
    const rubber = rubberOf(info.rubber);
    if (!sections.length || !rubber) continue;
    const aroundLabel = around.map((p) => p.label).join(" and ");
    if (holds && !seated.has(holds.id)) {
      seated.add(holds.id);
      steps.push({ kind: "seat", part: holds.id, riders: riders.get(holds.id) ?? [], from: vscale(info.layout.u, -40), title: `Put ${holds.label} on`, caption: `Hold ${holds.label} against ${aroundLabel}.`, dur: 1.5 });
    }
    steps.push({
      kind: "band",
      part: b.id,
      name: b.name,
      around: aroundLabel,
      holds: holds?.label ?? "it",
      layout: info.layout,
      sections,
      cord: { rubber, shore: info.shore, cs: info.cs, id: info.id },
      title: `Fit ${bandName(b.name)}`,
      dur: 4.6,
    });
  }

  // a part that clicks onto a peg slides in along the arm, toward its root; one a sprung arm pins through its hole
  // slides in along its own length, the end with the hole first
  for (const { host: p, flex: f, mate, peg } of pegMates(model, bbox, riding)) {
    const along = (f.kind === "flexure" && slideAlong(mate, bbox(mate), vnorm(applyXformsToDir(f.facing, p.xf)), peg)) || vnorm(applyXformsToDir(f.dir, p.xf));
    const calc = flexCalc(f, p.material, 1);
    const caption =
      f.kind === "snap"
        ? `Slide ${mate.label} in along the tongue until the peg clicks into its hole: about ${fmtNum(calc.push ?? 0, 1)} N. Lift the tongue to slide it out.`
        : `Pull the arm back (about ${fmtNum(calc.load ?? 0, 1)} N), slide ${mate.label} in and let go: the pin goes through its hole and on into the far side, so it cannot slip past. Pull the arm back again to take it out.`;
    steps.push({
      kind: "slide",
      part: mate.id,
      riders: riders.get(mate.id) ?? [],
      host: p.id,
      from: vscale(along, 2 * f.length + 10),
      peg,
      title: `Slide ${mate.label} in`,
      caption,
      dur: 3,
    });
  }

  // what keeps it there: each analysis that checks a seat, with its loads and the share of the grip they use
  // where the bands pull: each pin, or each prong of a double hook
  const hooks = bands.flatMap((b) => {
    const L = b.band!.layout;
    return L.hooks.flatMap((h) => (L.spread > 0 ? [1, -1].map((up) => vadd(h.at, vscale(L.n, (up * L.spread) / 2))) : [h.at]));
  });
  // under load everything but what the bands wrap moves together
  const wrapped = new Set(bands.flatMap((b) => b.band!.around));
  const moving = model.parts.filter((p) => !wrapped.has(p.name));
  const held = steps.find((s) => s.kind === "seat")?.part;
  const heldPart = model.parts.find((p) => p.id === held);
  const box = heldPart && bbox(heldPart);
  const centre = box ? applyXforms(vscale(vadd(box[0], box[1]), 0.5), heldPart.xf) : ([0, 0, 0] as V3);
  if (steps.length)
    for (const spec of model.analyses) {
      if (spec.kind !== "structural" || !spec.supports.some((s) => s.contact)) continue;
      steps.push({ kind: "hold", spec, parts: moving.map((p) => p.id), hooks, centre, title: spec.label, dur: 3 });
    }
  return steps;
}

/**
 * The way a part pinned through its hole slides off: its longest own side that runs across the pin, pointing from the
 * pin toward the part's middle.
 */
function slideAlong(mate: EvalPart, box: [V3, V3] | undefined, pin: V3, peg: V3): V3 | undefined {
  if (!box) return undefined;
  const size = [0, 1, 2].map((d) => box[1][d] - box[0][d]);
  const mid = applyXforms(vscale(vadd(box[0], box[1]), 0.5), mate.xf);
  for (const d of [0, 1, 2].sort((a, b) => size[b] - size[a])) {
    const u = vnorm(applyXformsToDir([d === 0 ? 1 : 0, d === 1 ? 1 : 0, d === 2 ? 1 : 0], mate.xf));
    if (Math.abs(vdot(u, pin)) > 0.5) continue;
    return vdot(vsub(mid, peg), u) < 0 ? vscale(u, -1) : u;
  }
  return undefined;
}

const volumeOf = (b: [V3, V3]) => (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]) * (b[1][2] - b[0][2]);

/**
 * Each peg snap or pinned flexure and the part it holds: the smallest part round the peg (or anywhere along the pin), not
 * what the whole thing sits on nor the print on it (riding).
 */
function pegMates(model: Model, bbox: (p: EvalPart) => [V3, V3] | undefined, riding: ReadonlySet<string>): { host: EvalPart; flex: FlexInfo; mate: EvalPart; peg: V3 }[] {
  const out: { host: EvalPart; flex: FlexInfo; mate: EvalPart; peg: V3 }[] = [];
  for (const p of model.parts)
    for (const f of p.flex ?? []) {
      if ((f.kind !== "snap" && f.kind !== "flexure") || !f.peg) continue;
      const face = vnorm(f.facing);
      // a snap's peg stands half its catch out of the arm; a flexure's pin reaches through what it holds and beyond
      const base = vadd(f.at, vscale(vnorm(f.dir), f.kind === "snap" ? f.length - f.peg / 2 : (f.pinAt ?? f.length - f.peg / 2)));
      const along = f.kind === "snap" ? [f.t / 2 + f.deflection / 2] : [0.2, 0.4, 0.6, 0.8, 0.95].map((k) => f.t / 2 + k * (f.reach ?? 0));
      const best = along
        .map((s) => applyXforms(vadd(base, vscale(face, s)), p.xf))
        .flatMap((peg) =>
          model.parts
            .filter((q) => q.id !== p.id && !q.band && !riding.has(q.id) && contains(q, bbox(q), peg))
            .map((q) => ({ q, peg, size: volumeOf(bbox(q)!) })),
        )
        .sort((a, b) => a.size - b.size)[0];
      if (best) out.push({ host: p, flex: f, mate: best.q, peg: best.peg });
    }
  return out;
}

/**
 * What each part carries: the parts riding inside its box and the parts
 * clicked onto its pegs. Bands and what they wrap are never carried.
 */
export function carriedBy(model: Model, bbox: (p: EvalPart) => [V3, V3] | undefined): Map<string, string[]> {
  const out = riderMap(model, bbox);
  const riding = new Set([...out.values()].flat());
  for (const { host, mate } of pegMates(model, bbox, riding)) if (!out.get(host.id)?.includes(mate.id)) out.set(host.id, [...(out.get(host.id) ?? []), mate.id]);
  return out;
}

/** A part's box as placed, square to the world axes. */
export function placedBox(p: EvalPart, box: [V3, V3]): [V3, V3] {
  const corners: V3[] = [];
  for (const x of [box[0][0], box[1][0]]) for (const y of [box[0][1], box[1][1]]) for (const z of [box[0][2], box[1][2]]) corners.push(applyXforms([x, y, z], p.xf));
  const lo = [0, 1, 2].map((d) => Math.min(...corners.map((c) => c[d]))) as V3;
  const hi = [0, 1, 2].map((d) => Math.max(...corners.map((c) => c[d]))) as V3;
  return [lo, hi];
}

function contains(p: EvalPart, box: [V3, V3] | undefined, world: V3): boolean {
  if (!box) return false;
  const [lo, hi] = placedBox(p, box);
  return [0, 1, 2].every((d) => world[d] >= lo[d] - 1 && world[d] <= hi[d] + 1);
}

/**
 * Which parts ride along with which: a part whose placed box lies inside
 * another's (within 1 mm) goes where the smallest such part goes, like a pad
 * in a seat or the print and stickers on a sign. Bands and what they wrap
 * stay put.
 */
function riderMap(model: Model, bbox: (p: EvalPart) => [V3, V3] | undefined): Map<string, string[]> {
  const wrapped = new Set(model.parts.flatMap((p) => p.band?.around ?? []));
  const boxes = model.parts
    .filter((p) => !p.band && !wrapped.has(p.name))
    .map((p) => ({ p, box: bbox(p) }))
    .filter((x): x is { p: EvalPart; box: [V3, V3] } => !!x.box)
    .map((x) => ({ p: x.p, box: placedBox(x.p, x.box) }));
  const inside = (a: [V3, V3], b: [V3, V3]) => [0, 1, 2].every((d) => a[0][d] >= b[0][d] - 1 && a[1][d] <= b[1][d] + 1);
  const out = new Map<string, string[]>();
  for (const a of boxes) {
    const host = boxes
      .filter((b) => b.p.id !== a.p.id && volumeOf(b.box) > volumeOf(a.box) && inside(a.box, b.box))
      .sort((x, y) => volumeOf(x.box) - volumeOf(y.box))[0];
    if (host) out.set(host.p.id, [...(out.get(host.p.id) ?? []), a.p.id]);
  }
  return out;
}

/** A seat check's loads as arrows (the bands' pull on their pins aside: the bands show that) and what they use of the grip, from its latest run when there is one. */
export function holdDetails(step: Extract<FitStep, { kind: "hold" }>, r: StructuralResult | undefined): { arrows: FitArrow[]; caption: string } {
  const spec = step.spec;
  const arrows: FitArrow[] = [];
  spec.loads.forEach((l, i) => {
    if (l.t !== "force" || vlen(l.f) < 1e-6) return;
    // drawn where it really acts: a gust on the middle of a sign, not the zone that carries it in
    const at = l.from ?? (r && r.loads.length === spec.loads.length ? r.loads[i].at : regionCentre(l.region));
    if (!at || step.hooks.some((h) => vlen(vsub(h, at)) < 3)) return;
    arrows.push({ at, dir: vnorm(l.f), size: vlen(l.f) });
  });
  // a shock throws the part's weight the way of the jolt (plain gravity is left out)
  if (spec.accel && vlen(spec.accel) > 1.5) {
    const g = r?.gravity;
    arrows.push({ at: g?.at ?? step.centre, dir: vnorm(spec.accel), size: g ? vlen(g.vector) : 0 });
  }
  return { arrows, caption: holdCaption(spec, r) };
}

function regionCentre(r: StructuralSpec["supports"][number]["region"]): V3 | undefined {
  if (r.t === "sphere" || r.t === "box") return r.at;
  if (r.t === "cyl") return vadd(r.at, vscale(r.axis, r.length / 2));
  return undefined;
}

function holdCaption(spec: StructuralSpec, r: StructuralResult | undefined): string {
  if (!r) return `${spec.label}: its analysis is still running, so the grip it uses is not known yet.`;
  const c = contactVerdicts(spec, r)[0];
  const seat = r.supports.find((s) => s.contact)?.contact;
  const safety = fmtNum(r.minSafety.value, 1);
  if (!c || !seat) return `${spec.label}: the weakest spot has a safety factor of ${safety}.`;
  if (seat.pressing <= 0) return `${spec.label}: the loads pull it off its seat.`;
  const stays = seat.use > 1 ? "it slips" : seat.lift >= 1 ? "it rocks on its seat" : "it stays put";
  return `${spec.label}: ${stays} and uses ${fmtNum(seat.use * 100, 0)} % of its grip; the weakest spot has a safety factor of ${safety}.`;
}

/** The caption for a band part way on, with its stretch and pull as they are at that moment. */
export function bandCaption(step: Extract<FitStep, { kind: "band" }>, pose: FitPose): string {
  const name = bandName(step.name);
  switch (pose.phase) {
    case "hook":
      return `Hook the ${name} over its first pin.`;
    case "wrap":
      return `Pull it round ${step.around}: stretched ${pct(pose.stretch)}, ${fmtNum(2 * pose.tension, 0)} N in your hand.`;
    case "over":
      return `Over the second pin's head and down onto the pin: stretched ${pct(pose.stretch)}.`;
    case "seated":
      return `Seated: stretched ${pct(pose.stretch)}, ${fmtNum(pose.tension, 1)} N in each strand, pressing ${step.holds} on with ${fmtNum(step.layout.squeeze, 0)} N.`;
  }
}

/** Where the band is at k (0..1) of its step. */
export function bandPoseAt(step: Extract<FitStep, { kind: "band" }>, k: number): FitPose {
  return fittingPose(step.layout, step.sections, step.cord, k);
}

/** Strain colour for a band: 0 slack, 1 at the stretch it may be held at, beyond that toward red. */
export function bandStrainShare(step: Extract<FitStep, { kind: "band" }>, stretch: number): number {
  const hold = 1 + 0.5 * step.cord.rubber.breakStrain;
  return Math.max(0, (stretch - 1) / Math.max(1e-6, hold - 1));
}

