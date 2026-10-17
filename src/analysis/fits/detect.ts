// Finds the fits in a design: every round thing that goes into a round hole
// in another part (a bearing in its seat, a shaft through a bearing or a
// gear, a screw through a clearance hole, a motor's pilot in its recess, a
// pin in a hole), the gear pairs that mesh, and the screw patterns that have
// to line up through two parts. Pure model reading; no kernel needed.

import type { EvalPart, Model } from "../../core/model";
import { materialRecord } from "../../library/materialDb";
import { vdot, vlen, vsub, type V3 } from "../../kernel/recipe";
import { axialOverlap, cylMid, lineDistance, partCylinders, type Cyl } from "./geometry";

export type FitKind = "bearing-seat" | "bearing-shaft" | "gear-bore" | "screw" | "head" | "locating" | "pin";
export type FitIntent = "press" | "transition" | "clearance";

export interface FitInstance {
  hole: Cyl;
  shaft: Cyl;
  /** offset between the two axes as drawn, mm */
  ecc: number;
  /** where the fit is, for markers: the middle of the overlap */
  at: V3;
}

export interface FitDef {
  key: string;
  kind: FitKind;
  intent: FitIntent;
  title: string;
  /** drawn diametral clearance (hole − shaft); negative is interference */
  nominal: number;
  instances: FitInstance[];
}

export interface GearPair {
  key: string;
  title: string;
  a: EvalPart;
  b: EvalPart;
}

/** A screw that threads into one part (or a nut or insert in it) and passes through clearance holes in others. */
export interface ScrewJoint {
  screw: EvalPart;
  /** fits of the screw's shank in plain holes */
  through: FitInstance[];
  /** parts the screw threads into: they locate it */
  threads: EvalPart[];
}

export interface FoundFits {
  fits: FitDef[];
  gears: GearPair[];
  joints: ScrewJoint[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** the component instance a solid belongs to: "motor" for "motor.shaft", "screws#2" for itself */
const instanceOf = (p: EvalPart) => p.id.split(".")[0];

/** Largest interference still read as a deliberate press fit, and largest clearance still read as a fit at all. */
const maxInterference = (d: number) => Math.max(0.35, 0.025 * d);
const maxClearance = (d: number) => Math.max(1.0, 0.06 * d);

function kindOf(hole: Cyl, shaft: Cyl, overlap: number): FitKind {
  if (shaft.role === "bearing-od") return "bearing-seat";
  if (hole.role === "bearing-bore") return "bearing-shaft";
  if (hole.role === "gear-bore") return "gear-bore";
  if (shaft.role === "screw") return "screw";
  if (shaft.role === "head") return "head";
  // a short, wide spigot in a recess (a motor pilot, a flange register) locates a part rather than carrying it
  if (overlap < 0.35 * shaft.d && shaft.d >= 8) return "locating";
  return "pin";
}

function intentOf(kind: FitKind, nominal: number, d: number): FitIntent {
  if (kind === "screw" || kind === "head" || kind === "locating") return "clearance";
  if (nominal < -0.004 - 0.0002 * d) return "press";
  // bearings and gear hubs are meant to sit snug however they are drawn (printed holes are often drawn
  // oversize to allow for the plastic closing up); a pin drawn with a small clearance may be either
  if (kind === "bearing-seat" || kind === "bearing-shaft" || kind === "gear-bore") return "transition";
  if (nominal > 0.3 + 0.002 * d) return "clearance";
  return "transition";
}

const what = (p: EvalPart) => (p.kind === "component" ? p.name : p.name);
const fmt = (n: number) => String(Math.round(n * 100) / 100);

function titleOf(kind: FitKind, hole: Cyl, shaft: Cyl, count: number): string {
  const many = count > 1 ? ` (×${count})` : "";
  const H = what(hole.part);
  const S = what(shaft.part);
  switch (kind) {
    case "bearing-seat":
      return `${S} (${shaft.part.bearing?.code ?? ""} bearing) in ${H}${many}`;
    case "bearing-shaft":
      return `${S} in ${H} (${hole.part.bearing?.code ?? ""} bearing)${many}`;
    case "gear-bore":
      return `${S} in ${H} bore${many}`;
    case "screw":
      return `${shaft.thread?.name ?? "Screw"} ${S} through ${H}${many}`;
    case "head":
      return `${shaft.thread?.name ?? "Screw"} heads in ${H} counterbores${many}`;
    case "locating":
      return `${S} Ø${fmt(shaft.d)} spigot in ${H}${many}`;
    default:
      return `${S} Ø${fmt(shaft.d)} in ${H}${many}`;
  }
}

/** Rubber and seals stretch over whatever they sit on: they are not fits. */
function rubbery(p: EvalPart): boolean {
  if (p.libKind === "seal" || p.libKind === "o_ring" || p.libKind === "grommet") return true;
  const E = materialRecord(p.material)?.mech.E;
  return E !== undefined && E < 200;
}

/** Every fit, gear pair and screw joint in the model. */
export function findFits(model: Model): FoundFits {
  const holes: Cyl[] = [];
  const shafts: Cyl[] = [];
  for (const p of model.parts) {
    if (p.hidden || rubbery(p)) continue;
    for (const c of partCylinders(p)) (c.side === "hole" ? holes : shafts).push(c);
  }

  const instances: { kind: FitKind; inst: FitInstance }[] = [];
  const located = new Map<string, Set<EvalPart>>(); // screw part id -> parts it threads into
  for (const h of holes) {
    let best: { s: Cyl; score: number; overlap: number; ecc: number } | null = null;
    for (const s of shafts) {
      if (s.part === h.part || instanceOf(s.part) === instanceOf(h.part)) continue;
      if (s.role === "insert") continue;
      if (Math.abs(vdot(s.axis, h.axis)) < 0.995) continue;
      const ecc = lineDistance(cylMid(s), h.at, h.axis);
      if (ecc > Math.max(0.3, 0.03 * h.d)) continue;
      const overlap = axialOverlap(h, s);
      if (overlap < Math.min(0.5, 0.3 * Math.min(h.length, s.length))) continue;
      // a screw in a hole much smaller than its thread is screwed in, not fitted
      if (s.role === "screw" && (h.role === "thread" || h.d < s.d - 0.2)) {
        located.set(s.part.id, (located.get(s.part.id) ?? new Set()).add(h.part));
        continue;
      }
      if (h.role === "thread") continue;
      const c = h.d - s.d;
      if (c < -maxInterference(h.d) || c > maxClearance(h.d)) continue;
      const score = overlap / (1 + Math.abs(c) * 4);
      if (!best || score > best.score) best = { s, score, overlap, ecc };
    }
    if (!best) continue;
    const s = best.s;
    const mid = cylMid(h);
    instances.push({ kind: kindOf(h, s, best.overlap), inst: { hole: h, shaft: s, ecc: best.ecc, at: mid } });
  }

  // group identical fits: same parts by name, same kind and sizes
  const groups = new Map<string, { kind: FitKind; list: FitInstance[] }>();
  for (const { kind, inst } of instances) {
    const key = `${kind}|${inst.hole.part.name}|${inst.shaft.part.name}|${r3(inst.hole.d)}|${r3(inst.shaft.d)}`;
    const g = groups.get(key) ?? { kind, list: [] };
    g.list.push(inst);
    groups.set(key, g);
  }
  const fits: FitDef[] = [];
  for (const [key, g] of groups) {
    const first = g.list[0];
    const nominal = first.hole.d - first.shaft.d;
    fits.push({ key, kind: g.kind, intent: intentOf(g.kind, nominal, first.hole.d), title: titleOf(g.kind, first.hole, first.shaft, g.list.length), nominal, instances: g.list });
  }

  // gear pairs (each once)
  const gears: GearPair[] = [];
  const gp = model.parts.filter((p) => p.gear && !p.hidden);
  for (const g of gp) {
    const other = gp.find((q) => q.name === g.gear!.meshWith);
    if (!other) continue;
    gears.push({ key: `${other.id}|${g.id}`, title: `${other.name} → ${g.name}`, a: other, b: g });
  }

  // screw joints: a screw through clearance holes, located by what it threads into
  const joints: ScrewJoint[] = [];
  const byScrew = new Map<string, FitInstance[]>();
  for (const { kind, inst } of instances) if (kind === "screw") byScrew.set(inst.shaft.part.id, [...(byScrew.get(inst.shaft.part.id) ?? []), inst]);
  for (const p of model.parts) {
    if (!p.fastener) continue;
    const through = byScrew.get(p.id) ?? [];
    const threads = [...(located.get(p.id) ?? [])];
    if (through.length) joints.push({ screw: p, through, threads });
  }
  return { fits, gears, joints };
}

/** Fits whose axis runs along a gear's axis: they let the gear move off its drawn centre. */
export function fitsOnAxis(fits: FitDef[], at: V3, axis: V3, tol = 0.3): { fit: FitDef; inst: FitInstance; index: number }[] {
  const out: { fit: FitDef; inst: FitInstance; index: number }[] = [];
  for (const f of fits) {
    if (f.kind === "screw" || f.kind === "head") continue;
    f.instances.forEach((inst, index) => {
      if (Math.abs(vdot(inst.hole.axis, axis)) < 0.995) return;
      if (lineDistance(inst.at, at, axis) > tol) return;
      out.push({ fit: f, inst, index });
    });
  }
  return out;
}

/** Centre distance between two parallel axes. */
export function axisDistance(a: V3, b: V3, axis: V3): number {
  const d = vsub(b, a);
  const t = vdot(d, axis);
  return vlen([d[0] - t * axis[0], d[1] - t * axis[1], d[2] - t * axis[2]]);
}
