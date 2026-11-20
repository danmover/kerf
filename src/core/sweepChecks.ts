// Checks that moving parts clear everything through their whole motion, not
// only where they are drawn. Each moving part is swept through a full cycle
// of the drive against every part that does not move with it: points spread
// over each part's surface are tested against the other's closed surface
// mesh at every position. A part that cuts into another on the way round
// fails, saying at what angle, how deep, where, and how far to move what; one
// that only comes to touch a part it is well clear of at rest warns that it
// rubs. Contact that is meant is neither: a wheel on its track, a roller on a
// tower or a tyre on the disc it drives (rolls_on:, or any two surfaces that
// meet without sliding as the parts turn against each other) is held to what
// rolling needs instead: the two meet, and the soft one is pressed in no
// further than rubber gives. Parts are posed with motionPose, as the preview
// and simulation are.

import { turns, type EvalPart, type Model, type Motion } from "./model";
import type { CheckItem } from "./checks";
import type { ChecksResult } from "../kernel/protocol";
import type { MeshData } from "../kernel/build";
import { closedSurface } from "../kernel/apart";
import { TriBVH } from "../mfg/bvh";
import { applyMat, identity, motionPose, mul, rollRate, type Mat4 } from "./kinematics";
import { NO_SLIP_GAP, isSoft, ownAxis, radial, rollsOnEachOther, slipAt, squeezeAllowed, type Slip } from "./rolling";
import { xformMatrix, type V3 } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { motionOfPart, type Holds, type MeshLookup } from "./holds";

/** Deeper than this into another part is a collision: two preview meshes together can be off by about 0.5 mm. */
export const HIT_DEPTH = 0.75;
/** Parts this far apart at rest that come within RUB_GAP while moving touch on the way round. */
const RUB_REST = 0.6;
const RUB_GAP = 0.1;
/** Two parts that roll on each other are in contact when their preview meshes are this close: a round rim's facets leave about this. */
const ROLL_GAP = 0.3;
/** Most points spread over one part's surface. */
const MAX_POINTS = 2000;

const pt = (p: V3) => `(${p.map((x) => fmtNum(Math.abs(x) < 0.005 ? 0 : x, 1)).join(", ")})`;
const listOf = (names: string[]) => {
  const a = [...new Set(names)];
  return a.length <= 3 ? a.join(", ").replace(/, ([^,]*)$/, " and $1") : `${a.slice(0, 3).join(", ")} and ${a.length - 3} more`;
};
const instanceOf = (p: EvalPart) => p.id.split(".")[0];

/** The inverse of a placement or pose: they turn, mirror and move, so the inverse turn is the transpose. */
export function rigidInverse(m: Mat4): Mat4 {
  const t: V3 = [m[12], m[13], m[14]];
  return [
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]),
    -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]),
    -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]),
    1,
  ]; // prettier-ignore
}

// ---------- each part's surface, indexed, with points spread over it ----------

export interface SweepSurface {
  bvh: TriBVH;
  /** points on the surface, in the part's own frame, cluster by cluster */
  pts: Float64Array;
  /** clusters of nearby points: centre (3 each), radius, first point and point count */
  cc: Float64Array;
  cr: Float64Array;
  cs: Uint32Array;
  cn: Uint32Array;
  lo: V3;
  hi: V3;
  /** +1 when the triangles wind with their normals out */
  out: number;
}

const surfaceCache = new WeakMap<MeshData, SweepSurface | null>();

/** The part's closed surface and points spread over it about evenly (corners, edges and faces), or null when the mesh is open. */
export function sweepSurface(m: MeshData): SweepSurface | null {
  if (surfaceCache.has(m)) return surfaceCache.get(m)!;
  const s = closedSurface(m);
  let out: SweepSurface | null = null;
  if (s) {
    const P = s.positions;
    const T = s.triangles;
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], P[i + k]);
        hi[k] = Math.max(hi[k], P[i + k]);
      }
    let area = 0;
    for (let t = 0; t < T.length; t += 3) area += triArea(P, T[t], T[t + 1], T[t + 2]);
    let spacing = Math.max(0.8, Math.sqrt(area / MAX_POINTS));
    let pts = spread(P, T, spacing);
    while (pts.length / 3 > MAX_POINTS * 1.5 && spacing < 1e4) {
      spacing *= 1.4;
      pts = spread(P, T, spacing);
    }
    const bvh = new TriBVH(P, T);
    out = { bvh, ...clusters(pts, lo, hi), lo, hi, out: bvh.signedVolume() >= 0 ? 1 : -1 };
  }
  surfaceCache.set(m, out);
  return out;
}

/** Points grouped by grid cell, so a cluster far from the other part's surface is settled with one test. */
function clusters(pts: Float64Array, lo: V3, hi: V3): Pick<SweepSurface, "pts" | "cc" | "cr" | "cs" | "cn"> {
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const h = Math.min(10, Math.max(2, diag / 20));
  const cells = new Map<string, number[]>();
  for (let i = 0; i < pts.length; i += 3) {
    const k = `${Math.floor((pts[i] - lo[0]) / h)},${Math.floor((pts[i + 1] - lo[1]) / h)},${Math.floor((pts[i + 2] - lo[2]) / h)}`;
    const c = cells.get(k);
    if (c) c.push(i);
    else cells.set(k, [i]);
  }
  const n = cells.size;
  const out = { pts: new Float64Array(pts.length), cc: new Float64Array(n * 3), cr: new Float64Array(n), cs: new Uint32Array(n), cn: new Uint32Array(n) };
  let at = 0;
  let c = 0;
  for (const idx of cells.values()) {
    const m: V3 = [0, 0, 0];
    for (const i of idx) for (let k = 0; k < 3; k++) m[k] += pts[i + k] / idx.length;
    let r = 0;
    out.cs[c] = at / 3;
    out.cn[c] = idx.length;
    for (const i of idx) {
      for (let k = 0; k < 3; k++) out.pts[at + k] = pts[i + k];
      r = Math.max(r, Math.hypot(pts[i] - m[0], pts[i + 1] - m[1], pts[i + 2] - m[2]));
      at += 3;
    }
    out.cc.set(m, c * 3);
    out.cr[c] = r;
    c++;
  }
  return out;
}

function triArea(P: number[], a: number, b: number, c: number): number {
  const ux = P[b * 3] - P[a * 3],
    uy = P[b * 3 + 1] - P[a * 3 + 1],
    uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3],
    vy = P[c * 3 + 1] - P[a * 3 + 1],
    vz = P[c * 3 + 2] - P[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** The corners, then a grid of points over each triangle no coarser than `spacing`. */
function spread(P: number[], T: number[], spacing: number): Float64Array {
  const out: number[] = [...P];
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3,
      b = T[t + 1] * 3,
      c = T[t + 2] * 3;
    const edge = Math.max(
      Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]),
      Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]),
      Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1], P[a + 2] - P[c + 2]),
    );
    const k = Math.min(48, Math.ceil(edge / spacing));
    if (k < 2) continue;
    for (let i = 0; i <= k; i++)
      for (let j = 0; i + j <= k; j++) {
        // the corners are in already
        if ((i === 0 && j === 0) || i === k || j === k) continue;
        const u = i / k,
          v = j / k,
          w = 1 - u - v;
        out.push(w * P[a] + u * P[b] + v * P[c], w * P[a + 1] + u * P[b + 1] + v * P[c + 1], w * P[a + 2] + u * P[b + 2] + v * P[c + 2]);
      }
  }
  return Float64Array.from(out);
}

// a point counts as inside a part only when two rays agree, so one grazing an edge cannot invent a collision
const RAYS = [
  [0.5773, 0.5774, 0.5772],
  [-0.6, 0.48, 0.64],
  [0.36, -0.8, 0.48],
] as const;

function insideDepth(s: SweepSurface, q: V3, need: number): number {
  if (!s.bvh.contains(q[0], q[1], q[2], RAYS[0])) return 0;
  const d = s.bvh.nearest(q[0], q[1], q[2], 1e4);
  if (d < need) return d;
  if (s.bvh.contains(q[0], q[1], q[2], RAYS[1])) return d;
  return s.bvh.contains(q[0], q[1], q[2], RAYS[2]) ? d : 0;
}

const near = new Float64Array(4);
const nrm = new Float64Array(3);

/**
 * How far a point is from the surface (up to maxD) and whether it is inside: decided by the nearest face's
 * normal when the nearest point is inside that face, else by rays.
 */
function sideOf(s: SweepSurface, q: V3, maxD: number): { d: number; inside: boolean } {
  const d = s.bvh.closest(q[0], q[1], q[2], maxD, near);
  if (!Number.isFinite(d)) return { d: maxD, inside: insideDepth(s, q, 0) > 0 };
  s.bvh.normal(near[3], nrm);
  const nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
  const along = ((q[0] - near[0]) * nrm[0] + (q[1] - near[1]) * nrm[1] + (q[2] - near[2]) * nrm[2]) / nl;
  if (Math.abs(along) >= 0.999 * d) return { d, inside: along * s.out < 0 };
  return { d, inside: insideDepth(s, q, 0) > 0 };
}

// ---------- the sweep ----------

interface Body {
  p: EvalPart;
  /** placement: the part's own frame to the assembly as drawn */
  X: Mat4;
  Xi: Mat4;
  s: SweepSurface;
  motion?: Motion;
}

interface PairResult {
  /** deepest point of either part inside the other, mm, at driver angle `deg`, at world point `at` */
  depth: number;
  deg: number;
  at: V3;
  /** closest the two come while moving (0 when they touch), and how far apart they are as drawn */
  gap: number;
  rest: number;
  gapDeg: number;
  /** where they come closest while moving, in the assembly as posed at `gapDeg` (when the gap was measured) */
  gapAt?: V3;
  /** how deep they are into each other as drawn, and where (measured only for parts meant to run on each other) */
  restDepth?: number;
  restAt?: V3;
  /** of the positions looked at, how many have the two within ROLL_GAP of each other (parts meant to run on each other) */
  touching?: number;
  positions?: number;
}

/**
 * Driver angles (degrees) to sample: one cycle of the slowest motion, no step coarser than 7.5° of the fastest (up to
 * 360 steps). A design whose travel ends is sampled from the start of its run to the end (the way back passes through
 * the same positions), no step moving a slide more than 2 mm.
 */
export function sweepAngles(motions: (Motion | undefined)[]): number[] {
  const rates: number[] = [];
  let run: number | undefined;
  let slide = 0;
  const seen = new Set<Motion>();
  const add = (m?: Motion) => {
    for (let x = m; x && !seen.has(x); x = x.parent) {
      seen.add(x);
      run ??= x.range;
      if (x.link) add(x.link.driver);
      else if (x.kind === "slide") slide = Math.max(slide, Math.abs(x.rate ?? 0));
      else if (x.roll) {
        const r = (Math.abs(rollRate(x, 0.5 * (x.range ?? 360))) * 180) / Math.PI;
        if (r > 1e-9) rates.push(r);
        add(x.roll.on);
      } else if (Math.abs(x.ratio) > 1e-12) rates.push(Math.abs(x.ratio));
    }
  };
  for (const m of motions) add(m);
  if (run) {
    const steps = Math.max(48, Math.min(360, Math.ceil(Math.max((run * Math.max(0, ...rates)) / 7.5, (run * slide) / 2))));
    return Array.from({ length: steps + 1 }, (_, i) => (run! * i) / steps);
  }
  if (!rates.length) return [0];
  const cycle = 360 / Math.min(...rates);
  const steps = Math.max(48, Math.min(360, Math.ceil((cycle * Math.max(...rates)) / 7.5)));
  return Array.from({ length: steps }, (_, i) => (cycle * i) / steps);
}

const motionKeys = new WeakMap<Motion, string>();
const motionKey = (m?: Motion) => {
  if (!m) return "-";
  let k = motionKeys.get(m);
  if (!k) motionKeys.set(m, (k = JSON.stringify(m)));
  return k;
};
const matKey = (m: Mat4) => m.map((x) => x.toFixed(5)).join(",");

const pairCache = new Map<string, PairResult | null>();

/** Forget swept pairs (tests time a cold sweep). */
export function clearSweepCache() {
  pairCache.clear();
}

function pose(m: Motion | undefined, deg: number): Mat4 {
  return m && turns(m) ? motionPose(m, deg) : identity();
}

const same = (a: Mat4, b: Mat4) => a.every((x, i) => Math.abs(x - b[i]) < 1e-7);
const corners = (s: SweepSurface): V3[] => Array.from({ length: 8 }, (_, c) => [c & 1 ? s.hi[0] : s.lo[0], c & 2 ? s.hi[1] : s.lo[1], c & 4 ? s.hi[2] : s.lo[2]] as V3);

const roundCache = new Map<string, boolean>();

/**
 * Whether a part is round about a line (world, as drawn): its surface turned about the line lands on itself,
 * like a shaft, a bearing or a plain hub. Turning about that line then changes nothing.
 */
function roundAbout(b: Body, origin: V3, axis: V3): boolean {
  const key = `${b.p.hash}|${matKey(b.X)}|${origin.map((x) => x.toFixed(3))}|${axis.map((x) => x.toFixed(4))}`;
  const known = roundCache.get(key);
  if (known !== undefined) return known;
  const P = b.s.pts;
  const step = Math.max(1, Math.floor(P.length / 3 / 400));
  let round = true;
  for (const deg of [37, 113, 211]) {
    // into the world, turn about the line, back into the part's own frame
    const M = mul(b.Xi, mul(rotationAbout(origin, axis, deg), b.X));
    for (let i = 0; i < P.length && round; i += 3 * step) {
      const q = applyMat(M, [P[i], P[i + 1], P[i + 2]]);
      if (b.s.bvh.nearest(q[0], q[1], q[2], 0.4) >= 0.4) round = false;
    }
    if (!round) break;
  }
  roundCache.set(key, round);
  if (roundCache.size > 4000) roundCache.delete(roundCache.keys().next().value!);
  return round;
}

const rotationAbout = (o: V3, a: V3, deg: number): Mat4 => motionPose({ origin: o, axis: a, ratio: 1 }, deg);

/** Sweep one pair through the angles: the deepest either part gets into the other, and the closest they come. */
function sweepPair(A: Body, B: Body, angles: number[], wantGap: boolean, meant = false): PairResult | null {
  const key = `${A.p.hash}|${B.p.hash}|${matKey(A.X)}|${matKey(B.X)}|${motionKey(A.motion)}|${motionKey(B.motion)}|${angles.length}|${wantGap}|${meant}`;
  if (pairCache.has(key)) {
    const r = pairCache.get(key)!;
    pairCache.delete(key);
    pairCache.set(key, r);
    return r;
  }
  const out = sweepPairCold(A, B, angles, wantGap, meant);
  pairCache.set(key, out);
  for (const k of pairCache.keys()) {
    if (pairCache.size <= 4000) break;
    pairCache.delete(k);
  }
  return out;
}

/**
 * The line every one of these rigid moves turns about, when they all turn about one line and slide along
 * none (a part turning on its axle, a cup turning on its carrier): null otherwise.
 */
function fixedLine(rels: Mat4[]): { o: V3; u: V3 } | null {
  let line: { o: V3; u: V3 } | null = null;
  for (const R of rels) {
    const c = (R[0] + R[5] + R[10] - 1) / 2;
    if (c > 1 - 1e-9) {
      if (Math.hypot(R[12], R[13], R[14]) > 1e-6) return null;
      continue;
    }
    if (!line) {
      // axis from the skew part, then the point on it nearest the origin from the move
      let u: V3 = [R[6] - R[9], R[8] - R[2], R[1] - R[4]];
      const ul = Math.hypot(u[0], u[1], u[2]);
      if (ul < 1e-9) return null;
      u = [u[0] / ul, u[1] / ul, u[2] / ul];
      const t: V3 = [R[12], R[13], R[14]];
      const tu = t[0] * u[0] + t[1] * u[1] + t[2] * u[2];
      if (Math.abs(tu) > 1e-4) return null;
      const th = Math.acos(Math.max(-1, Math.min(1, c)));
      const tp: V3 = [t[0] - tu * u[0], t[1] - tu * u[1], t[2] - tu * u[2]];
      const x: V3 = [u[1] * tp[2] - u[2] * tp[1], u[2] * tp[0] - u[0] * tp[2], u[0] * tp[1] - u[1] * tp[0]];
      const k = 1 / Math.tan(th / 2);
      line = { o: [0.5 * (tp[0] + k * x[0]), 0.5 * (tp[1] + k * x[1]), 0.5 * (tp[2] + k * x[2])], u };
    }
    // the line stays where it is
    for (const q of [line.o, [line.o[0] + 50 * line.u[0], line.o[1] + 50 * line.u[1], line.o[2] + 50 * line.u[2]] as V3]) {
      const r = applyMat(R, q);
      if (Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2]) > 1e-4) return null;
    }
  }
  return line;
}

function sweepPairCold(A: Body, B: Body, angles: number[], wantGap: boolean, meant: boolean): PairResult | null {
  // how A moves relative to B (in the assembly as drawn), at each angle
  const rels = angles.map((deg) => mul(rigidInverse(pose(B.motion, deg)), pose(A.motion, deg)));
  const rel0 = rels[0];
  const reach = wantGap ? RUB_REST : 0;
  // turning about one line: if either part is round about it, turning changes nothing (a shaft in its bearing)
  const line = fixedLine(rels.map((r) => mul(r, rigidInverse(rel0))));
  if (line && (roundAbout(A, line.o, line.u) || roundAbout(B, line.o, line.u))) {
    if (!meant) return { depth: 0, deg: 0, at: [0, 0, 0], gap: Infinity, rest: Infinity, gapDeg: 0 };
    // a wheel meant to run on this part: how they sit as drawn is how they sit all the way round
    const L = mul(B.Xi, mul(rel0, A.X));
    const r1 = probe(A.s, B.s, L, reach);
    const r2 = probe(B.s, A.s, rigidInverse(L), reach);
    const depth = Math.max(r1.depth, r2.depth);
    const g = depth > 0 ? 0 : Math.min(r1.gap, r2.gap);
    const inv = rigidInverse(L);
    const at = applyMat(A.X, r1.depth >= r2.depth ? r1.at : applyMat(inv, r2.at));
    const gapAt = applyMat(A.X, r1.gap <= r2.gap ? r1.gapAt : applyMat(inv, r2.gapAt));
    return { depth, deg: 0, at, gap: g, rest: g, gapDeg: 0, gapAt: depth > 0 ? at : gapAt, restDepth: depth, restAt: at, touching: g < ROLL_GAP ? angles.length : 0, positions: angles.length };
  }
  // A's own frame to B's at each angle
  const Ls: (Mat4 | null)[] = rels.map((rel, i) => (i > 0 && same(rel, rel0) ? null : mul(B.Xi, mul(rel, A.X))));
  if (!Ls.slice(1).some(Boolean)) return null;
  // the furthest any point of A moves (in B's frame) from one angle to the next: a corner of its box, as the
  // move of a point under a rigid motion grows linearly with where it is. A run that ends does not wrap round.
  const open = !!(A.motion?.range ?? B.motion?.range);
  const cs = corners(A.s);
  let step = 0;
  for (let i = 0; i < Ls.length - (open ? 1 : 0); i++) {
    const L0 = Ls[i] ?? Ls[0]!;
    const L1 = Ls[(i + 1) % Ls.length] ?? Ls[0]!;
    for (const c of cs) {
      const a = applyMat(L0, c);
      const b = applyMat(L1, c);
      step = Math.max(step, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  let best: Pick<PairResult, "depth" | "deg" | "at"> | null = null;
  let gap = Infinity;
  let gapDeg = 0;
  let gapAt: V3 | undefined;
  let rest = Infinity;
  let restDepth = 0;
  let restAt: V3 | undefined;
  let touching = 0;
  for (let i = 0; i < Ls.length; ) {
    const L = Ls[i];
    if (!L) {
      // back where it is drawn
      if (meant && rest < ROLL_GAP) touching++;
      i++;
      continue;
    }
    const deg = angles[i];
    const r1 = probe(A.s, B.s, L, reach);
    const r2 = probe(B.s, A.s, rigidInverse(L), reach);
    const depth = Math.max(r1.depth, r2.depth);
    const g = depth > 0 ? 0 : Math.min(r1.gap, r2.gap);
    // in the assembly as posed: a point of A's own frame, or of B's brought into it
    const world = (inA: V3) => applyMat(pose(A.motion, deg), applyMat(A.X, inA));
    const deepAt = () => world(r1.depth >= r2.depth ? r1.at : applyMat(rigidInverse(L), r2.at));
    if (g < ROLL_GAP) touching++;
    if (i === 0) {
      rest = g;
      if (meant && depth > 0) {
        restDepth = depth;
        restAt = deepAt();
      }
    } else if (g < gap) {
      gap = g;
      gapDeg = deg;
      if (reach > 0) gapAt = depth > 0 ? deepAt() : world(r1.gap <= r2.gap ? r1.gapAt : applyMat(rigidInverse(L), r2.gapAt));
    }
    if (i > 0 && depth > (best?.depth ?? 0)) {
      // where it happens, in the assembly as posed: the deep point of whichever part went in
      best = { depth, deg, at: deepAt() };
    }
    // while they are this far apart they cannot meet: skip the angles A cannot cross the gap in
    const clear = Math.max(r1.clear, r2.clear) - reach;
    i += clear > 0 && step > 0 ? Math.max(1, Math.floor(clear / step)) : 1;
  }
  return { ...(best ?? { depth: 0, deg: 0, at: [0, 0, 0] as V3 }), gap, rest, gapDeg, ...(gapAt ? { gapAt } : {}), ...(meant ? { restDepth, ...(restAt ? { restAt } : {}), touching, positions: Ls.length } : {}) };
}

/**
 * Points of `from` placed by `L` into `to`'s frame: the deepest inside it (and where, in from's frame), the
 * nearest outside within `reach`, and a distance the two surfaces are certainly apart by (0 when unsure).
 */
function probe(from: SweepSurface, to: SweepSurface, L: Mat4, reach: number): { depth: number; at: V3; gap: number; gapAt: V3; clear: number } {
  // the box of `from` in `to`'s frame first: most positions keep well clear
  let lo: V3 = [Infinity, Infinity, Infinity];
  let hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners(from)) {
    const q = applyMat(L, c);
    lo = lo.map((x, k) => Math.min(x, q[k])) as V3;
    hi = hi.map((x, k) => Math.max(x, q[k])) as V3;
  }
  const out = { depth: 0, at: [0, 0, 0] as V3, gap: Infinity, gapAt: [0, 0, 0] as V3, clear: Infinity };
  const boxGap = Math.hypot(...[0, 1, 2].map((k) => Math.max(0, lo[k] - to.hi[k], to.lo[k] - hi[k])));
  const m = Math.max(reach, 0.01);
  if (boxGap > m) {
    out.clear = boxGap;
    return out;
  }
  const P = from.pts;
  const toBox = (q: V3) => Math.hypot(...[0, 1, 2].map((k) => Math.max(0, to.lo[k] - q[k], q[k] - to.hi[k])));
  for (let c = 0; c < from.cr.length; c++) {
    const r = from.cr[c];
    const q = applyMat(L, [from.cc[c * 3], from.cc[c * 3 + 1], from.cc[c * 3 + 2]]);
    const bd = toBox(q) - r;
    if (bd > m) {
      out.clear = Math.min(out.clear, bd);
      continue;
    }

    // distance to a surface changes no faster than the point moves, so the cluster's centre bounds all its points
    const { d: far, inside } = sideOf(to, q, r + m + HIT_DEPTH + 20);
    if (!inside && far >= r + m) {
      out.clear = Math.min(out.clear, far - r);
      continue;
    }
    if (inside && far - r > HIT_DEPTH) {
      if (far > out.depth) {
        out.depth = far;
        out.at = [from.cc[c * 3], from.cc[c * 3 + 1], from.cc[c * 3 + 2]];
      }
      out.gap = 0;
      out.clear = 0;
      continue;
    }
    out.clear = 0;
    // none of its points can be a collision deep, and the gap is not wanted
    if (!reach && !inside && far >= r - HIT_DEPTH) continue;
    const s0 = from.cs[c] * 3;
    const s1 = s0 + from.cn[c] * 3;
    for (let i = s0; i < s1; i += 3) {
      const p = applyMat(L, [P[i], P[i + 1], P[i + 2]]);
      if (toBox(p) > m) continue;
      // a point closer to the surface than a collision is deep only matters for the gap
      if (!reach && to.bvh.nearest(p[0], p[1], p[2], HIT_DEPTH) < HIT_DEPTH) continue;
      const { d, inside } = sideOf(to, p, 2 * r + HIT_DEPTH + 20);
      if (inside) {
        if (d > out.depth) {
          out.depth = d;
          out.at = [P[i], P[i + 1], P[i + 2]];
        }
        out.gap = 0;
      } else if (reach > 0 && out.gap > 0 && d < out.gap) {
        out.gap = d;
        out.gapAt = [P[i], P[i + 1], P[i + 2]];
      }
    }
  }
  return out;
}

/** What drives a motion, for saying when along the turn something happens. */
function drivenBy(model: Model, m: Motion | undefined): { part?: EvalPart; rate: number; slide?: number } {
  let root = m;
  while (root?.parent) root = root.parent;
  if (root?.link) root = root.link.driver;
  if (root?.roll?.on) return drivenBy(model, root.roll.on);
  const part = root && model.parts.find((p) => p.motion === root);
  // a part with travel of its own: where it is along it says when
  if (root?.kind === "slide" && root.rate) return { part, rate: 1, slide: Math.abs(root.rate) };
  return { part, rate: Math.abs(root?.ratio ?? 1) || 1 };
}

/**
 * For a part turning about a fixed axis and a still part in its way: how far out the turning part reaches
 * from the axis there, and how close in the still one comes, over the axial band where they meet.
 */
function radialFix(A: Body, B: Body, at: V3): { reach: number; inner: number; along: number } | null {
  const m = A.motion;
  if (!m || m.parent || m.link || B.motion) return null;
  const a = m.axis;
  const al = Math.hypot(a[0], a[1], a[2]) || 1;
  const u: V3 = [a[0] / al, a[1] / al, a[2] / al];
  const o = m.origin;
  const coords = (w: V3) => {
    const d: V3 = [w[0] - o[0], w[1] - o[1], w[2] - o[2]];
    const z = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    return { z, r: Math.hypot(d[0] - z * u[0], d[1] - z * u[1], d[2] - z * u[2]) };
  };
  const z0 = coords(at).z;
  const band = 1.5;
  let reach = 0;
  for (let i = 0; i < A.s.pts.length; i += 3) {
    const c = coords(applyMat(A.X, [A.s.pts[i], A.s.pts[i + 1], A.s.pts[i + 2]]));
    if (Math.abs(c.z - z0) <= band) reach = Math.max(reach, c.r);
  }
  let inner = Infinity;
  for (let i = 0; i < B.s.pts.length; i += 3) {
    const c = coords(applyMat(B.X, [B.s.pts[i], B.s.pts[i + 1], B.s.pts[i + 2]]));
    if (Math.abs(c.z - z0) <= band && c.r < reach) inner = Math.min(inner, c.r);
  }
  return reach > 0 && Number.isFinite(inner) ? { reach, inner, along: z0 } : null;
}

/**
 * How the two surfaces pass each other where they meet (a point in the assembly as posed at that angle). They roll
 * when the line the parts turn about each other on runs through the meeting point in both surfaces, give or take what
 * the preview meshes and a pressed-in tyre (`depth`) allow, and they do not slide along it.
 */
function contactSlip(A: Body, B: Body, deg: number, at: V3, depth: number): Slip & { rolling: boolean } {
  const s = slipAt(A.motion, B.motion, deg, at);
  if (!s.axis) return { ...s, rolling: false };
  const p = s.axis.at;
  const off = Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
  // the meeting point is one of the points spread over a part, so it can sit a little off the true line of contact
  const ax = ownAxis(A.p.motion) ?? ownAxis(B.p.motion);
  const slack = 1 + (ax ? 0.25 * radial(ax, at).r : 2);
  const tol = NO_SLIP_GAP + depth;
  const from = (b: Body) => {
    const q = applyMat(b.Xi, applyMat(rigidInverse(pose(b.motion, deg)), p));
    return b.s.bvh.nearest(q[0], q[1], q[2], tol + 1);
  };
  const rolling = off <= slack && Math.abs(s.axis.along) <= 0.02 * s.spin * Math.max(1, off + 5) && from(A) <= tol && from(B) <= tol;
  return { ...s, rolling };
}

/** A wheel or roller: it turns on its own axle and is round about it. */
function wheelLike(b: Body): boolean {
  const ax = ownAxis(b.p.motion);
  return !!ax && roundAbout(b, ax.o, ax.u);
}

const softWheel = (b: Body) => isSoft(b.p) && wheelLike(b);

/** A wheel's rolling radius where it meets the other part: from its axle to the deep point, or to where they come closest. */
function tyreRadius(wheel: Body, r: PairResult): number | undefined {
  const ax = ownAxis(wheel.p.motion);
  const p = r.depth > 0 ? r.at : r.gapAt;
  return ax && p ? radial(ax, p).r : undefined;
}

/** Why two parts' contact is taken as meant: the design says so (rolls_on:), their surfaces roll without sliding, or one is a rubber wheel. */
type Meant = "said" | "rolling" | "tyre";

/** For a collision or a rub that could be a wheel doing its job: how to say the contact is meant. */
function meantHint(A: Body, B: Body, depth: number): string {
  const wheel = wheelLike(A) ? A : wheelLike(B) ? B : isSoft(A.p) ? A : isSoft(B.p) ? B : null;
  if (!wheel || depth > 6) return "";
  const other = wheel === A ? B : A;
  const press = isSoft(wheel.p) || isSoft(other.p) ? "" : " (two hard parts must then only touch: only rubber can be drawn pressed in)";
  return ` If ${wheel.p.name} is meant to run on ${other.p.name} there (a wheel or roller on its track, a tyre that drives by friction), say so instead: give ${wheel.p.name} rolls_on: ${other.p.name}${press}.`;
}

/**
 * The finding for two parts that run on each other: they must meet somewhere in the motion, and where they do the
 * soft one may be pressed in only as far as rubber of its size gives (hard on hard: not at all, beyond what the
 * preview meshes can tell). Null when the overlap is all in how they are drawn: the interference check reports that.
 */
function rollItem(A: Body, B: Body, r: PairResult, why: Meant, overlapped: boolean, when: (A: Body, deg: number) => string): CheckItem | null {
  // the wheel is the one that turns on its own axle; when both do, the one whose rolls_on: it is, else the soft one
  const wa = !!ownAxis(A.p.motion);
  const wb = !!ownAxis(B.p.motion);
  const says = (x: Body, y: Body) => !!x.p.rollsOn?.names.includes(y.p.name);
  const wheel = wa && wb ? (says(B, A) && !says(A, B) ? B : !says(A, B) && isSoft(B.p) && !isSoft(A.p) ? B : A) : wb ? B : wa ? A : says(B, A) ? B : A;
  const track = wheel === A ? B : A;
  const w = wheel.p.name;
  const t = track.p.name;
  const base = { category: "motion" as const, parts: [A.p.id, B.p.id], span: wheel.p.span, basis: "geometry" as const };
  const restDepth = r.restDepth ?? 0;
  const moving = r.depth >= restDepth;
  const depth = Math.max(r.depth, restDepth);
  const deepAt = moving ? r.at : (r.restAt ?? r.at);
  const axis = ownAxis(wheel.p.motion);
  const radius = wheel.p.motion?.roll?.r ?? (axis && depth > 0 ? radial(axis, deepAt).r : axis && r.gapAt ? radial(axis, r.gapAt).r : undefined);
  const allowed = squeezeAllowed(A.p, B.p, radius);
  const soft = isSoft(A.p) || isSoft(B.p);
  const where = moving ? `at ${when(A, r.deg)}` : "where they are drawn";
  if (depth > allowed + HIT_DEPTH) {
    // drawn into each other no deeper than they then move: the overlap as drawn is the interference check's to report
    if (overlapped && r.depth <= restDepth + 0.2) return null;
    return {
      ...base,
      id: `roll:digs:${w}|${t}`,
      status: "fail",
      title: `${w} runs ${fmtNum(depth, 1)} mm into ${t}`,
      detail: soft
        ? `${w} runs on ${t}, but ${where} it is ${fmtNum(depth, 1)} mm into it near ${pt(deepAt)}: rubber of this size gives about ${fmtNum(allowed, 1)} mm, so the rest jams the motion or tears the tyre.`
        : `${w} runs on ${t}, but ${where} it is ${fmtNum(depth, 1)} mm into it near ${pt(deepAt)}. Neither part is rubber, so nothing gives: the motion jams there.`,
      fix: soft
        ? `Move ${w} at least ${fmtNum(depth - allowed, 1)} mm away from ${t} there (a tyre pressed in 0.5 to ${fmtNum(Math.max(0.5, allowed), 1)} mm grips well), or make its rolling surface that much smaller.`
        : `Move ${w} ${fmtNum(depth, 1)} mm away from ${t} there so they only touch, or give ${w} a rubber tyre (material: "TPU" or "Natural rubber") to be pressed in.`,
      margin: allowed - depth,
    };
  }
  const closest = Math.min(r.gap, r.rest);
  if (depth <= 0 && closest >= ROLL_GAP) {
    const gap = Number.isFinite(closest) ? `${fmtNum(closest, 1)} mm` : `${fmtNum(RUB_REST, 1)} mm or more`;
    return {
      ...base,
      id: `roll:apart:${w}|${t}`,
      status: "warn",
      title: `${w} never touches ${t}`,
      detail: `${w} has rolls_on: ${t}, but the closest the two come, drawn or moving, is ${gap}: nothing presses them together, so it would not grip or turn.`,
      fix: `Move ${w} toward ${t} until they touch${soft ? " (a rubber tyre pressed in 0.5 to 1 mm grips)" : ""}, name the part it really runs on, or take rolls_on: off if they are not meant to touch.`,
    };
  }
  const n = r.positions ?? 0;
  const share = n ? (r.touching ?? 0) / n : 1;
  // a wheel whose turning Kerf works out from the contact is turned as if it never left: say when it does
  if (wheel.p.motion?.kind === "roll" && wheel.p.motion.roll?.onName === t && share < 0.9) {
    return {
      ...base,
      id: `roll:leaves:${w}|${t}`,
      status: "warn",
      title: `${w} runs off ${t}`,
      detail: `${w} rolls on ${t}, but it is on it for only ${fmtNum(share * 100, 0)}% of the motion: for the rest there is nothing under it, so it guides and carries nothing there (the preview still turns it as if it stayed on).`,
      fix: `Make ${t} reach the whole way ${w} travels, shorten the travel so ${w} stays on it, or move ${w} to where ${t} always is.`,
    };
  }
  // a pair Kerf worked out to be rolling was swept as a possible collision, with no count of where it touches
  const reach = !n ? `at about ${when(A, r.gapDeg)}` : share > 0.97 ? "through the whole motion" : share < 0.03 ? `as it passes, about ${when(A, r.gapDeg)}` : `for ${fmtNum(share * 100, 0)}% of the motion`;
  const pressed = depth > 0.05 ? `, pressed in ${fmtNum(depth, 1)} mm at most${soft ? ` (rubber of this size gives about ${fmtNum(allowed, 1)} mm)` : ""}` : "";
  // how the two surfaces pass each other where they meet
  const at = depth > 0 && moving ? { deg: r.deg, p: r.at } : r.gapAt ? { deg: r.gapDeg, p: r.gapAt } : r.restAt ? { deg: 0, p: r.restAt } : null;
  const s = at ? contactSlip(A, B, at.deg, at.p, depth) : null;
  const perTurn = (x: number) => `${fmtNum(x * 360, x * 360 < 10 ? 1 : 0)} mm`;
  const slip = !s
    ? ""
    : s.rolling || s.slip <= 1e-7
      ? " Their surfaces move together there: it rolls without slipping."
      : ` Its surface passes ${t}'s at about ${perTurn(s.slip)} for each turn of the drive there, so it drives by friction and slips until what it drives is up to speed (the simulation gives that speed).${why === "said" ? " For a part turned by the contact alone, give it rolls_on: with touch: and no spin:." : ""}`;
  if (why === "tyre") {
    return {
      ...base,
      id: `roll:tyre:${w}|${t}`,
      status: "info",
      title: `${w} touches ${t} as a tyre would`,
      detail: `${w} is a rubber wheel and meets ${t} ${reach}${pressed}, so Kerf takes it as a tyre doing its job, not a collision.${slip}`,
      fix: `If they are meant to touch, give ${w} rolls_on: ${t} to say so. If not, move them at least 0.5 mm apart.`,
    };
  }
  return {
    ...base,
    id: `roll:ok:${w}|${t}`,
    status: "pass",
    title: `${w} runs on ${t}`,
    detail: `${why === "rolling" ? "Not said with rolls_on:, but the two meet without sliding. " : ""}${w} is on ${t} ${reach}${pressed}.${slip}`,
  };
}

/**
 * How long a moving group stays on something. At each of `angles` (the first is where it is drawn): is any part
 * that moves with it within touching distance of a part that does not (of the parts `only` picks, when given).
 * "never" when it touches none even as drawn, "always" when it stays on one all the way; else the drive angle
 * at which it is first on nothing, and the last part it was on.
 */
export function contactRun(model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, member: (p: EvalPart) => boolean, angles: number[], only?: (p: EvalPart) => boolean): "never" | "always" | { deg: number; last: EvalPart } {
  const built = kernel.boxes;
  if (!built || !angles.length) return "never";
  // a part with its box as drawn; its surface is made only once something comes near it
  interface Near {
    p: EvalPart;
    box: [V3, V3];
    motion?: Motion;
    body?: Body | null;
  }
  const mine: Near[] = [];
  const others: Near[] = [];
  for (const p of model.parts) {
    if (p.hidden || (p.imported && p.imported.kind !== "solid") || !built[p.id] || p.band || p.libKind === "belt" || p.libKind === "rope" || p.spring) continue;
    const own = member(p);
    if (!own && only && !only(p)) continue;
    (own ? mine : others).push({ p, box: built[p.id] as [V3, V3], motion: motionOfPart(p, holds) });
  }
  if (!mine.length || !others.length) return "never";
  const bodyOf = (n: Near): Body | null => {
    if (n.body !== undefined) return n.body;
    const md = mesh(n.p.hash);
    const s = md && sweepSurface(md);
    const X = xformMatrix(n.p.xf) as Mat4;
    return (n.body = s ? { p: n.p, X, Xi: rigidInverse(X), s, motion: n.motion } : null);
  };
  // a part's box in the assembly at a drive angle
  const boxAt = (n: Near, deg: number): [V3, V3] => {
    if (!turns(n.motion)) return n.box;
    const T = pose(n.motion, deg);
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const w = applyMat(T, [n.box[c & 1][0], n.box[(c >> 1) & 1][1], n.box[(c >> 2) & 1][2]]);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], w[k]);
        hi[k] = Math.max(hi[k], w[k]);
      }
    }
    return [lo, hi];
  };
  const on = (deg: number, first?: Near): Near | null => {
    const list = first ? [first, ...others.filter((o) => o !== first)] : others;
    for (const a of mine) {
      const ab = boxAt(a, deg);
      for (const o of list) {
        const ob = boxAt(o, deg);
        if ([0, 1, 2].some((k) => ab[0][k] > ob[1][k] + ROLL_GAP || ob[0][k] > ab[1][k] + ROLL_GAP)) continue;
        const A = bodyOf(a);
        const B = bodyOf(o);
        if (!A || !B) continue;
        const L = mul(B.Xi, mul(mul(rigidInverse(pose(B.motion, deg)), pose(A.motion, deg)), A.X));
        const r1 = probe(A.s, B.s, L, RUB_REST);
        if (r1.depth > 0 || r1.gap < ROLL_GAP) return o;
        const r2 = probe(B.s, A.s, rigidInverse(L), RUB_REST);
        if (r2.depth > 0 || r2.gap < ROLL_GAP) return o;
      }
    }
    return null;
  };
  let last = on(angles[0]);
  if (!last) return "never";
  for (let i = 1; i < angles.length; i++) {
    const now = on(angles[i], last);
    if (now) {
      last = now;
      continue;
    }
    // between the last angle it was on something and this one: close in on where it leaves
    let a = angles[i - 1];
    let b = angles[i];
    for (let k = 0; k < 7; k++) {
      const mid = (a + b) / 2;
      const m = on(mid, last);
      if (m) {
        a = mid;
        last = m;
      } else b = mid;
    }
    return { deg: b, last: last.p };
  }
  return "always";
}

export interface SweepInputs {
  model: Model;
  holds: Holds;
  kernel: ChecksResult;
  mesh: MeshLookup;
  ignore: [string, string][];
}

let stashed: SweepInputs | null = null;

/** Keep the live design's inputs for the sweep to work through a slice at a time (sweepRuntime). */
export function stashSweep(s: SweepInputs) {
  stashed = s;
}
export const sweepInputs = () => stashed;

/**
 * The sweep's findings. With a budget, pairs it has no time for are left for a later call (their results are
 * kept as they are found) and an info item says how many are left.
 */
export function sweepChecks(model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, ignore: [string, string][] = [], budgetMs = Infinity): CheckItem[] {
  const t0 = performance.now();
  const built = kernel.boxes;
  if (!built) return [];
  const bodies: Body[] = [];
  for (const p of model.parts) {
    if (p.hidden || (p.imported && p.imported.kind !== "solid") || !built[p.id] || p.band || p.libKind === "belt" || p.libKind === "rope") continue;
    const md = mesh(p.hash);
    const s = md && sweepSurface(md);
    if (!s) continue;
    const X = xformMatrix(p.xf) as Mat4;
    bodies.push({ p, X, Xi: rigidInverse(X), s, motion: motionOfPart(p, holds) });
  }
  const movers = bodies.filter((b) => turns(b.motion));
  if (!movers.length) return [];
  const skip = new Set(ignore.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  const touching = new Set((kernel.contacts ?? []).map((c) => (c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`)));
  // parts that already overlap where they are drawn are the interference check's (it knows a tyre pressed on its track)
  const overlapping = new Set(kernel.interferences.map((i) => (i.a < i.b ? `${i.a}|${i.b}` : `${i.b}|${i.a}`)));
  const pairKey = (a: EvalPart, b: EvalPart) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  const meshes = (a: EvalPart, b: EvalPart) => !!a.gear && !!b.gear && (a.gear.meshWith === b.name || b.gear.meshWith === a.name);

  const hits = new Map<string, { A: Body; B: Body; r: PairResult; names: string[] }>();
  const rubs = new Map<string, { A: Body; B: Body; r: PairResult; names: string[] }>();
  const rolls: { A: Body; B: Body; r: PairResult; why: Meant; overlapped: boolean }[] = [];
  const swept = new Set<string>();
  let left = 0;
  let angles = 0;
  for (const A of movers) {
    for (const B of bodies) {
      if (A === B || B.motion === A.motion || instanceOf(A.p) === instanceOf(B.p)) continue;
      // each pair of moving parts once
      if (turns(B.motion) && movers.indexOf(B) < movers.indexOf(A)) continue;
      if (skip.has(pairKey(A.p, B.p)) || meshes(A.p, B.p)) continue;
      // a wheel on its track, a tyre on the disc it turns: the design says they touch
      const said = rollsOnEachOther(A.p, B.p);
      const overlapped = overlapping.has(pairKey(A.p, B.p));
      if (overlapped && !said) continue;
      // gears are the gear checks': teeth through the mesh, and the swept tip circle against still parts
      if (A.p.gear || B.p.gear) continue;
      if (performance.now() - t0 > budgetMs) {
        left++;
        continue;
      }
      const at = sweepAngles([A.motion, B.motion]);
      angles = Math.max(angles, at.length);
      // a rubber wheel is there to touch things: its contact is measured as a tyre's, said or not
      const tyre = !said && (softWheel(A) || softWheel(B));
      const r = sweepPair(A, B, at, said || tyre || !touching.has(pairKey(A.p, B.p)), said || tyre);
      if (!r) continue;
      swept.add(B.p.id);
      if (said) {
        rolls.push({ A, B, r, why: "said", overlapped });
        continue;
      }
      // surfaces that meet without sliding while the parts turn against each other roll on each other, said or not
      if (r.depth <= HIT_DEPTH && r.rest >= RUB_REST && r.gap < RUB_GAP && r.gapAt && contactSlip(A, B, r.gapDeg, r.gapAt, 0).rolling) {
        rolls.push({ A, B, r, why: "rolling", overlapped });
        continue;
      }
      // a rubber wheel that meets a part passing it, pressed in no further than rubber gives: taken as a tyre doing its job
      if (tyre && r.rest >= RUB_REST && (r.depth > 0 || r.gap < RUB_GAP) && r.depth <= squeezeAllowed(A.p, B.p, tyreRadius(softWheel(A) ? A : B, r)) + HIT_DEPTH) {
        rolls.push({ A, B, r, why: "tyre", overlapped });
        continue;
      }
      const group = `${motionKey(A.motion)}|${B.p.name}|${motionKey(B.motion)}`;
      if (r.depth > HIT_DEPTH) {
        const g = hits.get(group);
        if (!g) hits.set(group, { A, B, r, names: [A.p.name] });
        else {
          g.names.push(A.p.name);
          if (r.depth > g.r.depth) Object.assign(g, { A, B, r });
        }
      } else if (r.rest >= RUB_REST && r.gap < RUB_GAP) {
        const g = rubs.get(group);
        if (!g) rubs.set(group, { A, B, r, names: [A.p.name] });
        else g.names.push(A.p.name);
      }
    }
  }

  const out: CheckItem[] = [];
  const when = (A: Body, deg: number) => {
    const d = drivenBy(model, A.motion);
    if (d.slide) return d.part ? `${fmtNum(deg * d.slide, 0)} mm into ${d.part.name}'s travel` : `${fmtNum(deg * d.slide, 0)} mm into the travel`;
    const own = ((deg * d.rate) % 360 + 360) % 360;
    return d.part ? `${fmtNum(own, 0)}° into ${d.part.name}'s turn` : `${fmtNum(own, 0)}° into the drive's turn`;
  };
  for (const { A, B, r, names } of hits.values()) {
    const moving = listOf(names);
    const rest = touching.has(pairKey(A.p, B.p)) || r.rest === 0 ? "They only touch where they are drawn" : "They are clear where they are drawn";
    const both = turns(B.motion);
    const radial = radialFix(A, B, r.at);
    const depth = fmtNum(r.depth, 1);
    let fix: string;
    if (radial) {
      const out = fmtNum(radial.reach - radial.inner + 1, 1);
      fix = `${A.p.name} sweeps out to ${fmtNum(radial.reach, 1)} mm from its axis where it meets ${B.p.name}, and ${B.p.name} comes in to ${fmtNum(radial.inner, 1)} mm. Keep ${B.p.name} at least ${fmtNum(radial.reach + 1, 1)} mm from the axis there (move it out ${out} mm or cut a pocket in it), trim ${A.p.name} to under ${fmtNum(Math.max(0, radial.inner - 1), 1)} mm from the axis there, or move one of them along the axis so they no longer share that band.`;
    } else if (both) {
      fix = `${A.p.name} and ${B.p.name} move differently and meet at ${when(A, r.deg)}. Space them apart along the direction they close (at least ${fmtNum(r.depth + 1, 1)} mm more), shorten the one that reaches into the other's path, or change the travel (crank throw, rod length, swing) so they pass clear. The motion preview at that angle shows where.`;
    } else {
      fix = `Move ${B.p.name} at least ${fmtNum(r.depth + 1, 1)} mm clear of ${A.p.name}'s path near ${pt(r.at)}, cut a recess in it there, or change the travel (crank throw, rod length, swing) so ${A.p.name} stops short of it. The motion preview at that angle shows where.`;
    }
    fix += meantHint(A, B, r.depth);
    out.push({
      id: `sweep:hit:${A.p.name}|${B.p.name}`,
      category: "motion",
      status: "fail",
      title: `${moving} ${names.length === 1 ? "hits" : "hit"} ${B.p.name} as ${names.length === 1 ? "it moves" : "they move"}`,
      detail: `At ${when(A, r.deg)}, ${both ? `${A.p.name} and ${B.p.name} run ${depth} mm into each other` : `${A.p.name} runs ${depth} mm into ${B.p.name}`} near ${pt(r.at)}. ${rest}, so only the motion shows it: the drive jams there or breaks a part.`,
      fix,
      parts: [...new Set([...names.flatMap((n) => model.parts.filter((p) => p.name === n).map((p) => p.id)), B.p.id])],
      span: A.p.span,
      margin: -r.depth,
      basis: "geometry",
    });
  }
  for (const { A, B, r, names } of rubs.values()) {
    out.push({
      id: `sweep:rub:${A.p.name}|${B.p.name}`,
      category: "motion",
      status: "warn",
      title: `${listOf(names)} ${names.length === 1 ? "rubs" : "rub"} ${B.p.name} on the way round`,
      detail: `${A.p.name} is ${Number.isFinite(r.rest) ? `${fmtNum(r.rest, 1)} mm from` : "well clear of"} ${B.p.name} as drawn but comes into contact with it at ${when(A, r.gapDeg)}, so it scrapes, knocks or wears there.`,
      fix: `Open the gap where they pass to at least 0.5 mm for printed parts (0.2 mm machined): move ${B.p.name} out of ${A.p.name}'s path or trim ${A.p.name}. The motion preview at that angle shows where.${meantHint(A, B, 0)}`,
      parts: [A.p.id, B.p.id],
      span: A.p.span,
      basis: "geometry",
    });
  }
  const rolling = rolls.flatMap((x) => rollItem(x.A, x.B, x.r, x.why, x.overlapped, when) ?? []);
  out.push(...rolling);
  if (left) {
    out.push({ id: "sweep:partial", category: "motion", status: "pending", title: "Sweeping the moving parts", detail: `${left} pair${left === 1 ? "" : "s"} of parts still to sweep through the motion: the report updates when they are done.`, basis: "geometry" });
  }
  if (!hits.size && !rubs.size && swept.size && !rolling.some((i) => i.status === "fail")) {
    out.push({ id: "sweep:ok", category: "motion", status: "pass", title: "Moving parts clear through their motion", detail: `${movers.length} moving part${movers.length === 1 ? "" : "s"} swept through ${model.driveRange ? "their whole travel" : "a full cycle"} (${angles} positions) against the ${swept.size} part${swept.size === 1 ? "" : "s"} that do not move with ${movers.length === 1 ? "it" : "them"}: nothing collides or rubs.`, basis: "geometry" });
  }
  return out;
}
