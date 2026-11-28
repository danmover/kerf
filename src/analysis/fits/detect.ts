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
  // a bolt through a bearing is an axle whose inner race the bolt clamps between its head and nut (the joint check
  // sees that the stack meets): the clamp holds the race, so the shank only has to pass through the bore
  if (hole.role === "bearing-bore") return shaft.role === "screw" ? "screw" : "bearing-shaft";
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

/**
 * A round fit drawn with clearance, between a part the design says slides along the fit's own axis and one that does
 * not slide with it (a piston in its cylinder, a rod through its gland, a plunger in a bush): a guide, meant to run
 * free, however small the clearance is drawn. Drawn line to line or tighter, it stays a fit that holds.
 */
function slidesIn(hole: Cyl, shaft: Cyl): boolean {
  const ma = hole.part.motion;
  const mb = shaft.part.motion;
  const along = (m: typeof ma) => !!m && m.kind === "slide" && !m.link && Math.abs(vdot(m.axis, hole.axis)) > 0.999;
  if (along(ma) !== along(mb)) return true;
  return along(ma) && ma !== mb && ma!.travel !== mb!.travel;
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

const found = new WeakMap<Model, FoundFits>();

/** Every fit, gear pair and screw joint in the model (worked out once per model: the fit check, the hold check and the exploded view all ask). */
export function findFits(model: Model): FoundFits {
  const work = findFitsWork(model);
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
  }
}

/** a model's fits being read a piece at a time, by whoever asked first */
const reading = new WeakMap<Model, Generator<void, FoundFits>>();

/**
 * findFits a piece at a time, for a caller with a page to keep moving (core/slices.ts). Two callers working on one
 * model at once (the fit check and the hold check both start with this) share the one reading of it.
 */
export function* findFitsWork(model: Model): Generator<void, FoundFits> {
  for (;;) {
    const f = found.get(model);
    if (f) return f;
    let work = reading.get(model);
    if (!work) reading.set(model, (work = readFits(model)));
    let step: IteratorResult<void, FoundFits>;
    try {
      step = work.next();
    } catch (e) {
      // a reading that failed is not left for the next caller to pick up where it broke
      reading.delete(model);
      throw e;
    }
    if (step.done) {
      reading.delete(model);
      found.set(model, step.value);
      return step.value;
    }
    yield;
  }
}

/** Grid cell for the shafts' middles, mm, and the length past which a shaft is asked about by every hole. */
const CELL = 16;
const LONG = 64;

/**
 * The shafts a hole has to be tried against, in their own order: those whose middle is near the hole's line where
 * the two could overlap, and every long shaft. A shaft that fits has its middle within `off` of the line, no
 * further past either end of the hole than half its own length; the rest are left out without being looked at.
 */
function shaftGrid(shafts: Cyl[], mids: V3[]): (h: Cyl, off: number) => number[] {
  const cell = (x: number) => Math.max(-32768, Math.min(32767, Math.floor(x / CELL))) + 32768;
  const cells = new Map<number, number[]>();
  const long: number[] = [];
  for (let j = 0; j < shafts.length; j++) {
    const m = mids[j];
    // (and one whose place is not a number: left to the tests, as before)
    if (!(shafts[j].length <= LONG) || !Number.isFinite(m[0] + m[1] + m[2])) {
      long.push(j);
      continue;
    }
    const k = (cell(m[0]) * 65536 + cell(m[1])) * 65536 + cell(m[2]);
    const list = cells.get(k);
    if (list) list.push(j);
    else cells.set(k, [j]);
  }
  const all = shafts.map((_, j) => j);
  return (h, off) => {
    // the box of the hole's line, a long shaft's half length past each end, grown by how far off the line a middle may be
    const lo = [0, 0, 0];
    const hi = [0, 0, 0];
    const pad = off + 1e-3;
    let n = 1;
    for (let k = 0; k < 3; k++) {
      const a = h.at[k] - h.axis[k] * (LONG / 2);
      const b = h.at[k] + h.axis[k] * (h.length + LONG / 2);
      lo[k] = cell(Math.min(a, b) - pad);
      hi[k] = cell(Math.max(a, b) + pad);
      n *= hi[k] - lo[k] + 1;
    }
    // a hole that long (or one that is not a number): every shaft
    if (!(n <= 4096)) return all;
    const out = long.slice();
    for (let i = lo[0]; i <= hi[0]; i++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let k = lo[2]; k <= hi[2]; k++) {
          const list = cells.get((i * 65536 + j) * 65536 + k);
          if (list) for (const x of list) out.push(x);
        }
    return out.sort((a, b) => a - b);
  };
}

function* readFits(model: Model): Generator<void, FoundFits> {
  const holes: Cyl[] = [];
  const shafts: Cyl[] = [];
  // each part's component instance, read once: the search below compares them for every hole against every shaft
  const instance = new Map<EvalPart, string>();
  for (const p of model.parts) {
    if (p.hidden || rubbery(p)) continue;
    instance.set(p, instanceOf(p));
    for (const c of partCylinders(p)) (c.side === "hole" ? holes : shafts).push(c);
  }

  const mids = shafts.map(cylMid);
  const shaftInstance = shafts.map((s) => instance.get(s.part));

  const instances: { kind: FitKind; inst: FitInstance }[] = [];
  const located = new Map<string, Set<EvalPart>>(); // screw part id -> parts it threads into
  const near = shaftGrid(shafts, mids);
  let since = 0;
  for (const h of holes) {
    const cands: { s: Cyl; score: number; overlap: number; ecc: number }[] = [];
    const mine = instance.get(h.part);
    const [hx, hy, hz] = h.at;
    const [ax, ay, az] = h.axis;
    const off = Math.max(0.3, 0.03 * h.d);
    // only the shafts whose middles are near the hole's line can fit it: a design has thousands of each
    const ask = near(h, off);
    // a breath every few thousand tries
    if ((since += ask.length) > 20000) {
      since = 0;
      yield;
    }
    for (const j of ask) {
      const s = shafts[j];
      // the two tests nearly every shaft fails come first, on numbers read once: is it along the hole, and on its line
      const sa = s.axis;
      if (Math.abs(sa[0] * ax + sa[1] * ay + sa[2] * az) < 0.995) continue;
      const m = mids[j];
      const vx = m[0] - hx,
        vy = m[1] - hy,
        vz = m[2] - hz;
      const t = vx * ax + vy * ay + vz * az;
      const ecc = Math.hypot(vx - t * ax, vy - t * ay, vz - t * az);
      if (ecc > off) continue;
      if (s.part === h.part || shaftInstance[j] === mine) continue;
      if (s.role === "insert") continue;
      const overlap = axialOverlap(h, s);
      if (overlap < Math.min(0.5, 0.3 * Math.min(h.length, s.length))) continue;
      // a screw in a hole much smaller than its thread is screwed in, not fitted
      if (s.role === "screw" && (h.role === "thread" || h.d < s.d - 0.2)) {
        // a nut (or a T-nut in a slot) goes wherever the screw is: it does not locate it
        if (h.part.libKind !== "nut") located.set(s.part.id, (located.get(s.part.id) ?? new Set()).add(h.part));
        continue;
      }
      if (h.role === "thread") continue;
      const c = h.d - s.d;
      if (c < -maxInterference(h.d) || c > maxClearance(h.d)) continue;
      cands.push({ s, score: overlap / (1 + Math.abs(c) * 4), overlap, ecc });
    }
    // the best fit, and others of the same kind further along the same hole (two bearings in one bore)
    cands.sort((a, b) => b.score - a.score);
    const picked: typeof cands = [];
    for (const c of cands) if (!picked.length || (c.s.role === picked[0].s.role && picked.every((p) => axialOverlap(p.s, c.s) <= 0.3))) picked.push(c);
    for (const c of picked) instances.push({ kind: kindOf(h, c.s, c.overlap), inst: { hole: h, shaft: c.s, ecc: c.ecc, at: picked.length > 1 ? cylMid(c.s) : cylMid(h) } });
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
    const intent = g.kind === "pin" && nominal > 1e-6 && slidesIn(first.hole, first.shaft) ? "clearance" : intentOf(g.kind, nominal, first.hole.d);
    fits.push({ key, kind: g.kind, intent, title: titleOf(g.kind, first.hole, first.shaft, g.list.length), nominal, instances: g.list });
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
