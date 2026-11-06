// How the parts of a design hold together, read from its fasteners and fits:
// what each screw clamps (washers, the parts between head and thread, then
// the nut, insert, standoff or tapped hole it bites into), whether that stack
// is closed so tightening the screw really clamps it, and which parts are
// joined to which. A screw whose nut or head stands off its part is loose,
// as it would be on the bench: it holds nothing.
//
// Moving parts carry what is fastened to them. A screw, its nut and washers,
// and a seat bolted to a turning cup all travel with the cup, so the motion
// preview and the simulation move them together; parts fastened together but
// told to move differently are a conflict the checks report.
//
// With part meshes at hand each stack is measured on them, along rays round
// the shank inside the head's footprint (so slots, pockets, counterbores and
// captive nuts count); without them it is read from the round holes in the
// recipes. Pure model reading on the main thread; no kernel calls.

import { turns, type EvalPart, type Model, type Motion } from "./model";
import type { MeshData } from "../kernel/build";
import { applyXforms, frameFor, vadd, vdot, vscale, vsub, xformMatrix, type V3 } from "../kernel/recipe";
import { axialOverlap, cylEnd, cylMid, lineDistance, partCylinders, recipeBounds, type Cyl } from "../analysis/fits/geometry";
import { findFits } from "../analysis/fits/detect";
import { TriBVH } from "../mfg/bvh";
import { catalogPart } from "../machine/catalog";

export type MeshLookup = (hash: string) => MeshData | undefined;

export type HostKind = "nut" | "nyloc" | "insert" | "tapped" | "plastic" | "standoff" | "bought";

/** A part's material along a screw: mm from the seat under the head, toward the tip. */
export interface Layer {
  part: EvalPart;
  a: number;
  b: number;
}

export interface Gap {
  at: "head" | "between" | "nut";
  /** mm, and where it starts along the screw from the seat */
  size: number;
  s: number;
  after?: EvalPart;
  before: EvalPart;
}

export interface Stack {
  screw: EvalPart;
  /** the seat under the head, the shank's direction, its length and thread diameter (mm, world) */
  seat: V3;
  axis: V3;
  length: number;
  d: number;
  /** every part round the shank from the head to a little past the tip, in order */
  layers: Layer[];
  /** what holds the thread */
  host?: EvalPart;
  hostKind?: HostKind;
  /** for an insert, the part it is melted into */
  pocket?: EvalPart;
  /** nuts or inserts on the parts list that it threads into, not drawn (hostKind "bought") */
  bought?: string;
  /** the parts pressed together from the head to the thread, in order (washers and the host included) */
  clamped: EvalPart[];
  /** where the stack is open, so tightening the screw clamps nothing: under the head, between two parts, or the nut off its part */
  gap?: Gap;
  /** the head and every face down to the thread meet, so the screw can be tightened */
  tight: boolean;
  /** a lock nut left with running clearance: the screw holds the parts on it and they turn about it */
  hinge?: boolean;
  /** parts in the stack that turn about the screw's own axis: it is their pivot */
  pivots: EvalPart[];
  /** a set screw: its tip bears on what it holds */
  set: boolean;
  /** measured on meshes rather than read from round holes */
  measured: boolean;
}

export type JoinKind = "screw" | "insert" | "fit" | "pivot" | "thread" | "bought" | "band" | "board";

/** Two parts held to each other. Pivots and bearings hold a part in place while letting it turn. */
export interface Join {
  a: EvalPart;
  b: EvalPart;
  kind: JoinKind;
  /** the screw, insert or fit's name, for messages */
  by: string;
}

export interface MotionConflict {
  /** the fasteners or fits joining them */
  by: string[];
  /** parts told to turn, and parts that stay still (a bought part's fixed half, or the base on the floor), joined together */
  moving: EvalPart[];
  still: EvalPart[];
}

export interface Holds {
  stacks: Stack[];
  /** joins that hold parts in place */
  joins: Join[];
  /** parts that take another part's motion (fasteners, and parts fastened to a moving part), by part id */
  carried: Map<string, { motion: Motion; from: EvalPart }>;
  conflicts: MotionConflict[];
  /** screws, nuts and washers of loose stacks: the screw's axis and how far they can rattle along it */
  loose: Map<string, { axis: V3; play: number }>;
}

/** Faces this close count as seated against each other, mm. */
export const SEAT_TOL = 0.15;
/** A gap between two parts this narrow is a sliding clearance the screw closes as it tightens, mm. */
const CLEARANCE = 0.3;
/** Wider than this a gap is a loose screw, not running clearance, mm. */
export const LOOSE_GAP = 0.5;

const FASTENER_KINDS = new Set(["screw", "nut", "washer", "insert", "standoff"]);
export const isFastener = (p: EvalPart) => !!p.fastener || FASTENER_KINDS.has(p.libKind ?? "");
/** the component instance a solid belongs to: "motor" for "motor.shaft" */
const instanceOf = (p: EvalPart) => p.id.split(".")[0];
const solidPart = (p: EvalPart) => !p.hidden && !(p.imported && p.imported.kind !== "solid");

type Box = [V3, V3];

// ---------- part boxes and meshes ----------

const boxCache = new WeakMap<EvalPart, Box | null>();

/** A part's box in the assembly: from its recipe, or its mesh when the recipe is too free-form to bound. */
export function worldBox(p: EvalPart, mesh?: MeshLookup): Box | null {
  if (boxCache.has(p)) return boxCache.get(p)!;
  let local: Box | null = recipeBounds(p.recipe);
  if (!local && mesh) {
    const m = mesh(p.hash);
    if (m && m.positions.length) {
      const lo: V3 = [Infinity, Infinity, Infinity];
      const hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], m.positions[i + k]);
          hi[k] = Math.max(hi[k], m.positions[i + k]);
        }
      local = [lo, hi];
    }
  }
  let out: Box | null = null;
  if (local) {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const w = applyXforms([c & 1 ? local[1][0] : local[0][0], c & 2 ? local[1][1] : local[0][1], c & 4 ? local[1][2] : local[0][2]], p.xf);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], w[k]);
        hi[k] = Math.max(hi[k], w[k]);
      }
    }
    out = [lo, hi];
  }
  // a mesh may still come: only keep what is final
  if (out || !mesh) boxCache.set(p, out);
  return out;
}

const bvhCache = new WeakMap<MeshData, TriBVH>();
const bvhOf = (m: MeshData) => {
  let b = bvhCache.get(m);
  if (!b) {
    b = new TriBVH(m.positions, m.indices);
    bvhCache.set(m, b);
  }
  return b;
};

const cylCache = new WeakMap<EvalPart, Cyl[]>();
export const cylsOf = (p: EvalPart) => {
  let c = cylCache.get(p);
  if (!c) {
    c = partCylinders(p);
    cylCache.set(p, c);
  }
  return c;
};

/** Merge overlapping or touching intervals. */
function unite(xs: [number, number][]): [number, number][] {
  const s = [...xs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

// ---------- one screw's stack ----------

export interface Shank {
  seat: V3;
  axis: V3;
  length: number;
  d: number;
  headD: number;
}

/** Material of a part round the shank, from its round holes: the coaxial holes narrower than the head. */
export function holeIntervals(p: EvalPart, sh: Shank): [number, number][] {
  const out: [number, number][] = [];
  // threads are cut a little past a nut's or standoff's faces: keep to the part itself
  const box = worldBox(p);
  const span = box ? lineBoxSpan(box, sh.seat, sh.axis) : null;
  for (const h of cylsOf(p)) {
    if (h.side !== "hole" || h.holeFit === "cbore") continue;
    if (Math.abs(vdot(h.axis, sh.axis)) < 0.995) continue;
    if (lineDistance(cylMid(h), sh.seat, sh.axis) > Math.max(0.3, 0.03 * h.d)) continue;
    // a bore wider than the head is a recess the head sits in, not a face it presses on
    if (h.d >= sh.headD * 0.98) continue;
    const a = vdot(vsub(h.at, sh.seat), sh.axis);
    const b = vdot(vsub(cylEnd(h), sh.seat), sh.axis);
    const lo = Math.max(Math.min(a, b), span ? span[0] : -Infinity);
    const hi = Math.min(Math.max(a, b), span ? span[1] : Infinity);
    if (hi > lo) out.push([lo, hi]);
  }
  return unite(out);
}

/** Where the line through p along unit n is inside the box, as distances along n; null when it misses. */
function lineBoxSpan(b: Box, p: V3, n: V3): [number, number] | null {
  let t0 = -Infinity,
    t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(n[i]) < 1e-9) {
      if (p[i] < b[0][i] - 1e-6 || p[i] > b[1][i] + 1e-6) return null;
      continue;
    }
    let a = (b[0][i] - p[i]) / n[i];
    let c = (b[1][i] - p[i]) / n[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
  }
  return t1 > t0 ? [t0, t1] : null;
}

const ANGLES = 8;
/** angles that keep clear of the axes and diagonals, where mesh vertices line up */
const ANGLE0 = 0.37;

/**
 * Material of a part round the shank, measured on its mesh: rays parallel to the axis at two radii inside the
 * head's footprint, eight round. A part counts when it surrounds the shank (material on most of the rays): a
 * wall beside the head does not. Null when the part is not round the shank at all. minAngles: how many of the
 * eight directions must find material (1 to find anything in the way, like a probe for a tool's path).
 */
export function meshIntervals(p: EvalPart, m: MeshData, sh: Shank, s0: number, s1: number, minAngles = 5): [number, number][] | null {
  const bvh = bvhOf(m);
  if (!bvh.count) return null;
  const M = xformMatrix(p.xf);
  // world to the part's own frame: placements are rotations, mirrors and moves, so the inverse is the transpose
  const inv = (q: V3): V3 => {
    const x = q[0] - M[12],
      y = q[1] - M[13],
      z = q[2] - M[14];
    return [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z];
  };
  const invDir = (d: V3): V3 => [M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[4] * d[0] + M[5] * d[1] + M[6] * d[2], M[8] * d[0] + M[9] * d[1] + M[10] * d[2]];
  const { u, v } = frameFor(sh.axis);
  const r1 = Math.min(0.5 * (sh.d / 2 + sh.headD / 2) * 1.05, 0.9 * (sh.headD / 2));
  const r2 = 0.92 * (sh.headD / 2);
  const dl = invDir(sh.axis);
  // how far back to start so the ray begins outside the part
  const lb = localBounds(m);
  const reach = Math.hypot(lb[1][0] - lb[0][0], lb[1][1] - lb[0][1], lb[1][2] - lb[0][2]) + 1;
  const all: [number, number][] = [];
  let hitAngles = 0;
  for (let k = 0; k < ANGLES; k++) {
    const ang = ANGLE0 + (2 * Math.PI * k) / ANGLES;
    let hit = false;
    for (const r of [r1, r2]) {
      const off = vadd(vscale(u, r * Math.cos(ang)), vscale(v, r * Math.sin(ang)));
      const startW = vadd(vadd(sh.seat, off), vscale(sh.axis, s0 - reach));
      const o = inv(startW);
      // crossings from outside, until the part is left behind past s1
      const tmax = s1 - s0 + 2 * reach;
      let t = 0;
      let skip = -1;
      let inside = false;
      let enter = 0;
      let last = -Infinity;
      for (let n = 0; n < 64; n++) {
        const h = bvh.raycast(o[0], o[1], o[2], dl[0], dl[1], dl[2], t, tmax, skip);
        if (!h) break;
        t = h.t + 1e-7;
        skip = h.tri;
        // the same crossing again through a shared edge
        if (h.t - last < 1e-5) continue;
        last = h.t;
        const s = h.t - reach + s0;
        if (!inside) {
          if (s >= s1) break;
          enter = s;
        } else if (s > s0) {
          all.push([enter, s]);
          hit = true;
        }
        inside = !inside;
      }
    }
    if (hit) hitAngles++;
  }
  if (hitAngles < minAngles) return null;
  return unite(all);
}

const boundsCache = new WeakMap<MeshData, Box>();
function localBounds(m: MeshData): Box {
  let b = boundsCache.get(m);
  if (!b) {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], m.positions[i + k]);
        hi[k] = Math.max(hi[k], m.positions[i + k]);
      }
    b = [lo, hi];
    boundsCache.set(m, b);
  }
  return b;
}

/** Does the box come within `r` of the segment from p along unit n for `len`? (a slab test on the grown box) */
export function boxNearSegment(b: Box, p: V3, n: V3, len: number, r: number): boolean {
  let t0 = 0,
    t1 = len;
  for (let i = 0; i < 3; i++) {
    const lo = b[0][i] - r;
    const hi = b[1][i] + r;
    if (Math.abs(n[i]) < 1e-9) {
      if (p[i] < lo || p[i] > hi) return false;
      continue;
    }
    let a = (lo - p[i]) / n[i];
    let c = (hi - p[i]) / n[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t1 < t0) return false;
  }
  return true;
}

/** What a threaded hole is. */
function hostKindOf(host: EvalPart, hole: Cyl): HostKind {
  if (host.libKind === "nut") return /\|nyloc\|/.test(host.bom?.key ?? "") ? "nyloc" : "nut";
  if (host.libKind === "insert" || hole.holeFit === "insert") return "insert";
  if (host.libKind === "standoff") return "standoff";
  if (hole.role === "thread") return "tapped";
  return "plastic";
}

/** The thread the screw bites into: a nut, insert or standoff on its axis first, then the most engaged hole. */
function findHost(screw: EvalPart, sh: Shank, cands: EvalPart[]): { host: EvalPart; kind: HostKind; hole: Cyl } | undefined {
  let best: { host: EvalPart; kind: HostKind; hole: Cyl; rank: number } | undefined;
  for (const p of cands) {
    if (instanceOf(p) === instanceOf(screw)) continue;
    for (const h of cylsOf(p)) {
      if (h.side !== "hole") continue;
      if (Math.abs(vdot(h.axis, sh.axis)) < 0.995) continue;
      if (lineDistance(cylMid(h), sh.seat, sh.axis) > Math.max(0.3, 0.03 * h.d)) continue;
      const threaded = h.role === "thread" || h.d < sh.d - 0.2;
      if (!threaded) continue;
      const a = vdot(vsub(h.at, sh.seat), sh.axis);
      const b = vdot(vsub(cylEnd(h), sh.seat), sh.axis);
      const overlap = Math.min(sh.length, Math.max(a, b)) - Math.max(0, Math.min(a, b));
      if (overlap < 0.3) continue;
      const kind = hostKindOf(p, h);
      const rank = (kind === "nut" || kind === "nyloc" || kind === "insert" || kind === "standoff" ? 1000 : 0) + overlap;
      if (!best || rank > best.rank) best = { host: p, kind, hole: h, rank };
    }
  }
  return best;
}

/** The part an insert is melted into: a hole round it, along most of its length. */
function pocketOf(insert: EvalPart, cands: EvalPart[]): EvalPart | undefined {
  const body = cylsOf(insert).find((c) => c.role === "insert") ?? cylsOf(insert).find((c) => c.side === "hole");
  if (!body) return undefined;
  for (const p of cands) {
    if (p === insert || isFastener(p)) continue;
    for (const h of cylsOf(p)) {
      if (h.side !== "hole" || Math.abs(vdot(h.axis, body.axis)) < 0.995) continue;
      if (lineDistance(cylMid(h), body.at, body.axis) > Math.max(0.3, 0.05 * h.d)) continue;
      const a = vdot(vsub(h.at, body.at), body.axis);
      const b = vdot(vsub(cylEnd(h), body.at), body.axis);
      const overlap = Math.min(body.length, Math.max(a, b)) - Math.max(0, Math.min(a, b));
      if (overlap >= 0.5 * body.length) return p;
    }
  }
  return undefined;
}

function stackOf(screw: EvalPart, parts: EvalPart[], mesh: MeshLookup | undefined, boughtFor: (thread: string) => string | undefined): Stack | null {
  const cs = cylsOf(screw);
  const shank = cs.find((c) => c.role === "screw");
  if (!shank) return null;
  const f = screw.fastener!;
  const head = cs.find((c) => c.role === "head");
  const d = shank.d;
  const sh: Shank = { seat: shank.at, axis: shank.axis, length: shank.length, d, headD: Math.max(f.headD || head?.d || 0, 1.6 * d) };
  const set = f.head === "set";
  // from a little behind the seat to a nut's height past the tip
  const s0 = -0.5;
  const s1 = sh.length + Math.max(2, d);
  const near = parts.filter((p) => {
    if (p === screw || instanceOf(p) === instanceOf(screw) || p.libKind === "screw") return false;
    const b = worldBox(p, mesh);
    return !!b && boxNearSegment(b, vadd(sh.seat, vscale(sh.axis, s0)), sh.axis, s1 - s0, sh.headD / 2 + 0.5);
  });
  const layers: Layer[] = [];
  let measured = false;
  for (const p of near) {
    const m = mesh?.(p.hash);
    const iv = m ? meshIntervals(p, m, sh, s0, s1) : holeIntervals(p, sh);
    if (m) measured = true;
    for (const [a, b] of iv ?? []) if (b > s0 && a < s1) layers.push({ part: p, a, b });
  }
  layers.sort((x, y) => x.a - y.a || x.b - y.b);
  let found = findHost(screw, sh, near);
  if (!found) {
    // a bought part (a motor, a supply, a sensor) has threaded holes where its screws go: the tip ends inside it
    const tipIn = layers.find((l) => l.part.kind === "component" && !isFastener(l.part) && !l.part.bearing && l.a < sh.length - 0.5 && l.b >= sh.length - 0.5);
    if (tipIn) found = { host: tipIn.part, kind: "tapped", hole: shank };
  }
  const bought = !found && !set ? boughtFor(f.size) : undefined;
  const host = found?.host;
  const pocket = host && found?.kind === "insert" && host.libKind === "insert" ? pocketOf(host, near) : undefined;
  // parts that turn about this very axis: the screw is their pivot
  const pivots = [...new Set(layers.map((l) => l.part))].filter((p) => p.motion && Math.abs(vdot(p.motion.axis, sh.axis)) > 0.995 && lineDistance(p.motion.origin, sh.seat, sh.axis) < 0.3 && Math.abs(p.motion.ratio) > 1e-9);

  const stack: Stack = { screw, seat: sh.seat, axis: sh.axis, length: sh.length, d, layers, host, hostKind: found?.kind ?? (bought ? "bought" : undefined), pocket, bought, clamped: [], tight: false, pivots, set, measured };
  // into nuts on the parts list: the parts it passes through must still meet, down to the last one it reaches
  const reachedLast = bought ? layers.filter((l) => l.a < sh.length - 0.3 && l.b > 0).at(-1) : undefined;
  if (!host && !reachedLast) return stack;
  const ends = new Set<EvalPart>(host ? [host, ...(pocket ? [pocket] : [])] : [reachedLast!.part]);

  if (set && host) {
    // a set screw threads through its host and bears on what is past it
    const hostEnd = Math.max(...layers.filter((l) => l.part === host).map((l) => l.b), 0);
    const past = layers.filter((l) => l.part !== host && l.a >= hostEnd - SEAT_TOL && l.a <= sh.length + SEAT_TOL);
    stack.clamped = [host, ...new Set(past.map((l) => l.part))];
    stack.tight = past.length > 0;
    return stack;
  }

  // walk the stack from the seat: each face must meet the next, down to the thread
  let x = 0;
  const chain: EvalPart[] = [];
  const gaps: Gap[] = [];
  let reached = false;
  let lastPart: EvalPart | undefined;
  const nutLike = host?.libKind === "nut" || host?.libKind === "standoff";
  // the thread bites in the last of the host's layers the shank reaches (a part can be passed through first: a shelf
  // over a floor of the same print)
  const endLayers = layers.filter((l) => ends.has(l.part));
  const endA = Math.max(...endLayers.filter((l) => l.a < sh.length - 0.3).map((l) => l.a), Math.min(...endLayers.map((l) => l.a)));
  for (let guard = 0; guard < 64 && !reached; guard++) {
    const at = layers.filter((l) => l.a <= x + SEAT_TOL && l.b > x + SEAT_TOL);
    if (at.length) {
      for (const l of at) if (!chain.includes(l.part)) chain.push(l.part);
      x = Math.max(...at.map((l) => l.b));
      lastPart = at.reduce((p, q) => (q.b > p.b ? q : p)).part;
      if (at.some((l) => ends.has(l.part) && l.a >= endA - SEAT_TOL)) reached = true;
      continue;
    }
    const ahead = layers.filter((l) => l.a > x + SEAT_TOL).sort((p, q) => p.a - q.a)[0];
    if (!ahead) break;
    gaps.push({ at: !chain.length ? "head" : ends.has(ahead.part) && nutLike ? "nut" : "between", size: ahead.a - x, after: lastPart, before: ahead.part, s: x });
    x = ahead.a;
  }
  // a countersunk head sits down in its cone, so its seat is not a face to meet
  const csk = f.head === "flat";
  const real = gaps.filter((g) => !(g.at === "head" && csk));
  // a lock nut (nyloc, or a thin nut with threadlocker) left with running clearance is a hinge: it holds the parts
  // on the screw and lets them turn
  const locking = host?.libKind === "nut" && /^nut\|[^|]*\|(nyloc|thin)\|/.test(host.bom?.key ?? "");
  stack.hinge = reached && locking && !!real.length && real.every((g) => g.at !== "head" && g.size <= LOOSE_GAP + 1e-6);
  // otherwise a screw draws parts together across a sliding clearance (a core in its tube) as it tightens
  const open = stack.hinge ? [] : real.filter((g) => !(g.at === "between" && g.size <= CLEARANCE + 1e-6));
  if (stack.hinge) {
    // the parts past the first clearance turn about the screw (the nut stays locked on its thread)
    const past = real[0].s + real[0].size - SEAT_TOL;
    for (const p of chain) if (p !== host && !stack.pivots.includes(p) && layers.filter((l) => l.part === p).every((l) => l.a >= past)) stack.pivots.push(p);
  } else stack.gap = open[0];
  stack.clamped = chain;
  stack.tight = reached && !open.length && !stack.hinge;
  return stack;
}

// ---------- the whole design ----------

const cache = new WeakMap<Model, { key: string; holds: Holds }>();

/**
 * How the design holds together. Cached per model; pass the mesh lookup when meshes are built and the result is
 * measured on them (it is redone as more meshes arrive).
 */
export function findHolds(model: Model, mesh?: MeshLookup): Holds {
  const parts = model.parts.filter(solidPart);
  const key = mesh ? `m${parts.filter((p) => mesh(p.hash)).length}` : "r";
  const hit = cache.get(model);
  if (hit && hit.key === key) return hit.holds;
  const holds = compute(model, parts, mesh);
  cache.set(model, { key, holds });
  return holds;
}

function compute(model: Model, parts: EvalPart[], mesh: MeshLookup | undefined): Holds {
  const stacks: Stack[] = [];
  // nuts or inserts bought for a thread size but not drawn ("M5 drop-in T-nuts")
  const items = model.machine?.items ?? [];
  const boughtFor = (thread: string) => items.find((it) => new RegExp(`(^|[^\\w.])${thread.replace(".", "\\.")}(?![\\d.])`, "i").test(it.label) && /nut|insert|threaded|tapped/i.test(it.label))?.label;
  for (const s of parts) {
    if (!s.fastener || s.libKind !== "screw") continue;
    const st = stackOf(s, parts, mesh, boughtFor);
    if (st) stacks.push(st);
  }

  const joins: Join[] = [];
  const join = (a: EvalPart, b: EvalPart, kind: JoinKind, by: string) => {
    if (a !== b) joins.push({ a, b, kind, by });
  };
  for (const st of stacks) {
    if (!st.tight && !st.hinge) continue;
    for (const p of st.clamped) join(st.screw, p, st.pivots.includes(p) ? "pivot" : "screw", st.screw.name);
    if (st.pocket && st.host) join(st.host, st.pocket, "insert", st.host.name);
    // washers and nuts on the shank past the clamp travel with it
  }
  // a T-nut in a profile's slot grips the slot's lips: the screw clamps the profile as well
  for (const st of stacks) {
    if (!(st.tight || st.hinge) || !st.host || !isTnut(st.host)) continue;
    const at = applyXforms([0, 0, 0], st.host.xf);
    const profile = parts.find((p) => p !== st.host && isProfile(p) && boxHas(worldBox(p, mesh), at, 0.6));
    if (profile && !st.clamped.includes(profile)) join(st.screw, profile, "screw", st.screw.name);
  }
  const inserts = parts.filter((p) => p.libKind === "insert");
  for (const ins of inserts) {
    const b = worldBox(ins, mesh);
    const cands = b ? parts.filter((p) => p !== ins && boxesTouch(b, worldBox(p, mesh))) : parts;
    const pk = pocketOf(ins, cands);
    if (pk) join(ins, pk, "insert", ins.name);
  }
  // round things in round holes: bearings in seats, shafts through bearings and gears, pins
  const fits = findFits(model).fits;
  for (const f of fits) {
    if (f.kind === "screw" || f.kind === "head") continue;
    const kind: JoinKind = f.kind === "bearing-shaft" || (f.kind === "pin" && f.intent === "clearance") ? "pivot" : "fit";
    for (const inst of f.instances) join(inst.hole.part, inst.shaft.part, kind, f.title);
  }
  // male threads (a standoff's stud, a threaded rod) screwed into a hole
  for (const p of parts) {
    if (p.fastener) continue;
    for (const c of cylsOf(p)) {
      if (c.side !== "shaft" || c.role !== "thread") continue;
      for (const q of parts) {
        if (q === p || instanceOf(q) === instanceOf(p)) continue;
        if (!cylsOf(q).some((h) => h.side === "hole" && Math.abs(vdot(h.axis, c.axis)) > 0.995 && lineDistance(cylMid(h), c.at, c.axis) < Math.max(0.3, 0.05 * h.d) && h.d <= c.d + 0.3 && axialOverlap(c, h) > 0.3)) continue;
        join(p, q, "thread", p.name);
      }
    }
  }
  // the solids of one bought part (a motor's body and shaft) come as one
  const byInstance = new Map<string, EvalPart[]>();
  for (const p of parts) if (p.kind === "component") byInstance.set(instanceOf(p), [...(byInstance.get(instanceOf(p)) ?? []), p]);
  for (const list of byInstance.values()) for (let i = 1; i < list.length; i++) join(list[0], list[i], "bought", list[0].name);
  // bands hold what they wrap; parts on a circuit board are soldered to it
  for (const p of parts) if (p.band) for (const o of [...p.band.around, ...(p.band.holds ? [p.band.holds] : [])]) for (const q of parts) if (q.name === o) join(p, q, "band", p.name);
  const onBoard = new Map((model.machine?.components ?? []).filter((c) => c.pcb).map((c) => [c.name, c.pcb!.board]));
  for (const p of parts) {
    const board = onBoard.get(p.name);
    if (board) for (const q of parts) if (q.name === board) join(p, q, "board", board);
  }

  const { carried, conflicts } = carryMotion(model, parts, stacks, joins, mesh);
  const loose = new Map<string, { axis: V3; play: number }>();
  for (const st of stacks) {
    if (st.tight || !st.gap || !st.host) continue;
    const play = Math.min(st.gap.size, 3);
    loose.set(st.screw.id, { axis: st.axis, play });
    for (const l of st.layers) if (isFastener(l.part) && l.part.libKind !== "insert" && l.part.libKind !== "standoff") loose.set(l.part.id, { axis: st.axis, play });
  }
  return { stacks, joins, carried, conflicts, loose };
}

/** A drop-in T-nut for a profile's slot. */
export const isTnut = (p: EvalPart) => p.libKind === "nut" && /^nut\|[^|]*\|tslot20\|/.test(p.bom?.key ?? "");
/** An aluminium profile (2020, 2040...) from the catalog. */
export const isProfile = (p: EvalPart) => p.kind === "component" && !!p.bom?.catalogId && catalogPart(p.bom.catalogId)?.kind === "extrusion";
const boxHas = (b: Box | null, q: V3, r: number) => !!b && q.every((x, i) => x >= b[0][i] - r && x <= b[1][i] + r);
const boxesTouch = (a: Box, b: Box | null) => !!b && a[0].every((_, i) => a[0][i] <= b[1][i] + 0.5 && b[0][i] <= a[1][i] + 0.5);

// ---------- motion carried through fastenings ----------

const r4 = (x: number) => Math.round(x * 1e4) / 1e4 || 0;
/** Two motions are the same turn when they share an axis line (wherever along it the origin was put) and rate. */
function motionKey(m: Motion | undefined): string {
  if (!m) return "";
  // a part on a connecting rod moves as its rod says: one motion per rod and role
  if (m.link) return `${m.kind}:${m.link.id}`;
  // one direction for the line, flipping the rate with it
  const k = m.axis.findIndex((x) => Math.abs(x) > 1e-6);
  const sg = k >= 0 && m.axis[k] < 0 ? -1 : 1;
  const a = vscale(m.axis, sg);
  const foot = vsub(m.origin, vscale(a, vdot(m.origin, a)));
  return `${foot.map((x) => Math.round(x * 20) || 0).join(",")}|${a.map(r4).join(",")}|${r4(sg * m.ratio)}|${motionKey(m.parent)}`;
}

/**
 * Parts fastened rigidly together move together: one turning part in a fastened group carries the rest. A group
 * with two motions, or a turning part fastened to a still one (a motor's body, or the base standing on the
 * floor), is a conflict: those fastenings would stop it turning.
 */
function carryMotion(model: Model, parts: EvalPart[], stacks: Stack[], joins: Join[], mesh: MeshLookup | undefined) {
  // a bearing's rings turn on each other: its seat holds the outer ring and its bore the inner
  const idx = new Map<string, number>();
  const names: string[] = [];
  const node = (id: string) => {
    let i = idx.get(id);
    if (i === undefined) {
      i = names.length;
      idx.set(id, i);
      names.push(id);
    }
    return i;
  };
  const root: number[] = [];
  const find = (i: number): number => {
    while (root[i] !== i) i = root[i] = root[root[i]];
    return i;
  };
  const nodeOf = (p: EvalPart, ring?: "in" | "out") => {
    const i = node(p.bearing && ring ? `${p.id}#${ring}` : p.id);
    while (root.length <= i) root.push(root.length);
    return i;
  };
  const by = new Map<number, Set<string>>();
  const link = (a: number, b: number, what: string) => {
    const ra = find(a);
    const rb = find(b);
    const s = new Set([...(by.get(ra) ?? []), ...(by.get(rb) ?? []), ...(what ? [what] : [])]);
    if (ra !== rb) root[ra] = rb;
    by.set(rb, s);
  };
  for (const p of parts) nodeOf(p);
  // a bearing is drawn with its outer ring: it goes round with what it is seated in
  for (const p of parts) if (p.bearing) link(nodeOf(p), nodeOf(p, "out"), "");
  // every screw rides with what it passes through, tight or not (a loose screw still rattles round in its holes)
  for (const st of stacks) {
    const s = nodeOf(st.screw);
    const on = st.layers.filter((l) => l.b > -0.3 && l.a < st.length + 0.3 && !st.pivots.includes(l.part));
    for (const l of on) link(s, nodeOf(l.part, "in"), st.screw.name);
    if (st.host && !st.pivots.includes(st.host) && st.host.libKind !== "screw") link(s, nodeOf(st.host, "in"), st.screw.name);
    if (st.pocket) link(s, nodeOf(st.pocket), st.screw.name);
  }
  for (const j of joins) {
    if (j.kind === "pivot" || j.kind === "bought" || j.kind === "screw" || j.kind === "band" || j.kind === "board") continue;
    // a bearing in its seat holds the outer ring; anything else in a bearing's bore holds the inner
    const ringA = j.a.bearing ? (j.kind === "fit" && seatOf(j.a, j.b) ? "out" : "in") : undefined;
    const ringB = j.b.bearing ? (j.kind === "fit" && seatOf(j.b, j.a) ? "out" : "in") : undefined;
    link(nodeOf(j.a, ringA), nodeOf(j.b, ringB), j.by);
  }

  // which parts are still: the fixed half of a bought part that turns, and the base on the floor
  const moving = (p: EvalPart) => !!p.motion && turns(p.motion);
  const turningInstances = new Set(parts.filter((p) => p.kind === "component" && moving(p)).map(instanceOf));
  let zmin = Infinity;
  const boxes = new Map<string, Box>();
  for (const p of parts) {
    const b = worldBox(p, mesh);
    if (!b) continue;
    boxes.set(p.id, b);
    // screw heads under a base do not stand on the floor: the base does
    if (!isFastener(p)) zmin = Math.min(zmin, b[0][2]);
  }
  const still = (p: EvalPart) => {
    if (moving(p)) return false;
    if (p.kind === "component" && turningInstances.has(instanceOf(p))) return true;
    const b = boxes.get(p.id);
    return !!b && !isFastener(p) && b[0][2] <= zmin + 0.5;
  };

  const groups = new Map<number, EvalPart[]>();
  for (const p of parts) {
    const r = find(nodeOf(p));
    groups.set(r, [...(groups.get(r) ?? []), p]);
  }
  const carried = new Map<string, { motion: Motion; from: EvalPart }>();
  const conflicts: MotionConflict[] = [];
  for (const [r, members] of groups) {
    if (members.length < 2) continue;
    const movers = members.filter(moving);
    if (!movers.length) continue;
    const kinds = new Map<string, EvalPart>();
    for (const p of movers) if (!kinds.has(motionKey(p.motion))) kinds.set(motionKey(p.motion), p);
    const stills = members.filter(still);
    if (kinds.size === 1 && !stills.length) {
      const from = movers[0];
      for (const p of members) if (!moving(p)) carried.set(p.id, { motion: from.motion!, from });
      continue;
    }
    conflicts.push({ by: [...(by.get(r) ?? [])], moving: [...kinds.values()], still: stills });
  }
  return { carried, conflicts };
}

function seatOf(bearing: EvalPart, other: EvalPart): boolean {
  // the other part's hole is round the bearing's outside
  const b = bearing.bearing!;
  return cylsOf(other).some((h) => h.side === "hole" && Math.abs(h.d - b.od) < Math.max(1, 0.06 * b.od) && Math.abs(vdot(h.axis, b.axis)) > 0.99 && lineDistance(cylMid(h), b.center, b.axis) < 0.5);
}

/** The motion a part shows: its own, or the one it is carried by. */
export function motionOfPart(p: EvalPart, holds: Holds | null | undefined): Motion | undefined {
  return turns(p.motion) ? p.motion : (holds?.carried.get(p.id)?.motion ?? p.motion);
}
