// Checks that moving parts clear everything through their whole motion, not
// only where they are drawn. Each moving part is swept through a full cycle
// of the drive against every part that does not move with it: points spread
// over each part's surface are tested against the other's closed surface
// mesh at every position. A part that cuts into another on the way round
// fails, saying at what angle, how deep, where, and how far to move what; one
// that only comes to touch a part it is well clear of at rest warns that it
// rubs. Parts are posed with motionPose, as the preview and simulation are.

import { turns, type EvalPart, type Model, type Motion } from "./model";
import type { CheckItem } from "./checks";
import type { ChecksResult } from "../kernel/protocol";
import type { MeshData } from "../kernel/build";
import { closedSurface } from "../kernel/apart";
import { TriBVH } from "../mfg/bvh";
import { applyMat, identity, motionPose, mul, type Mat4 } from "./kinematics";
import { xformMatrix, type V3 } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { motionOfPart, type Holds, type MeshLookup } from "./holds";

/** Deeper than this into another part is a collision: two preview meshes together can be off by about 0.5 mm. */
export const HIT_DEPTH = 0.75;
/** Parts this far apart at rest that come within RUB_GAP while moving touch on the way round. */
const RUB_REST = 0.6;
const RUB_GAP = 0.1;
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
}

/** Driver angles (degrees) to sample: one cycle of the slowest motion, no step coarser than 7.5° of the fastest (up to 360 steps). */
export function sweepAngles(motions: (Motion | undefined)[]): number[] {
  const rates: number[] = [];
  const add = (m?: Motion) => {
    for (let x = m; x; x = x.parent) {
      if (x.link) add(x.link.driver);
      else if (Math.abs(x.ratio) > 1e-12) rates.push(Math.abs(x.ratio));
    }
  };
  for (const m of motions) add(m);
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
function sweepPair(A: Body, B: Body, angles: number[], wantGap: boolean): PairResult | null {
  const key = `${A.p.hash}|${B.p.hash}|${matKey(A.X)}|${matKey(B.X)}|${motionKey(A.motion)}|${motionKey(B.motion)}|${angles.length}|${wantGap}`;
  if (pairCache.has(key)) {
    const r = pairCache.get(key)!;
    pairCache.delete(key);
    pairCache.set(key, r);
    return r;
  }
  const out = sweepPairCold(A, B, angles, wantGap);
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

function sweepPairCold(A: Body, B: Body, angles: number[], wantGap: boolean): PairResult | null {
  // how A moves relative to B (in the assembly as drawn), at each angle
  const rels = angles.map((deg) => mul(rigidInverse(pose(B.motion, deg)), pose(A.motion, deg)));
  const rel0 = rels[0];
  // turning about one line: if either part is round about it, turning changes nothing (a shaft in its bearing)
  const line = fixedLine(rels.map((r) => mul(r, rigidInverse(rel0))));
  if (line && (roundAbout(A, line.o, line.u) || roundAbout(B, line.o, line.u))) return { depth: 0, deg: 0, at: [0, 0, 0], gap: Infinity, rest: Infinity, gapDeg: 0 };
  // A's own frame to B's at each angle
  const Ls: (Mat4 | null)[] = rels.map((rel, i) => (i > 0 && same(rel, rel0) ? null : mul(B.Xi, mul(rel, A.X))));
  if (!Ls.slice(1).some(Boolean)) return null;
  // the furthest any point of A moves (in B's frame) from one angle to the next: a corner of its box, as the
  // move of a point under a rigid motion grows linearly with where it is
  const cs = corners(A.s);
  let step = 0;
  for (let i = 0; i < Ls.length; i++) {
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
  let rest = Infinity;
  const reach = wantGap ? RUB_REST : 0;
  for (let i = 0; i < Ls.length; ) {
    const L = Ls[i];
    if (!L) {
      i++;
      continue;
    }
    const deg = angles[i];
    const r1 = probe(A.s, B.s, L, reach);
    const r2 = probe(B.s, A.s, rigidInverse(L), reach);
    const depth = Math.max(r1.depth, r2.depth);
    const g = depth > 0 ? 0 : Math.min(r1.gap, r2.gap);
    if (i === 0) rest = g;
    else if (g < gap) {
      gap = g;
      gapDeg = deg;
    }
    if (i > 0 && depth > (best?.depth ?? 0)) {
      // where it happens, in the assembly as posed: the deep point of whichever part went in
      const local = r1.depth >= r2.depth ? r1.at : applyMat(rigidInverse(L), r2.at);
      best = { depth, deg, at: applyMat(pose(A.motion, deg), applyMat(A.X, local)) };
    }
    // while they are this far apart they cannot meet: skip the angles A cannot cross the gap in
    const clear = Math.max(r1.clear, r2.clear) - reach;
    i += clear > 0 && step > 0 ? Math.max(1, Math.floor(clear / step)) : 1;
  }
  return { ...(best ?? { depth: 0, deg: 0, at: [0, 0, 0] as V3 }), gap, rest, gapDeg };
}

/**
 * Points of `from` placed by `L` into `to`'s frame: the deepest inside it (and where, in from's frame), the
 * nearest outside within `reach`, and a distance the two surfaces are certainly apart by (0 when unsure).
 */
function probe(from: SweepSurface, to: SweepSurface, L: Mat4, reach: number): { depth: number; at: V3; gap: number; clear: number } {
  // the box of `from` in `to`'s frame first: most positions keep well clear
  let lo: V3 = [Infinity, Infinity, Infinity];
  let hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners(from)) {
    const q = applyMat(L, c);
    lo = lo.map((x, k) => Math.min(x, q[k])) as V3;
    hi = hi.map((x, k) => Math.max(x, q[k])) as V3;
  }
  const out = { depth: 0, at: [0, 0, 0] as V3, gap: Infinity, clear: Infinity };
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
      } else if (reach > 0 && out.gap > 0) {
        out.gap = Math.min(out.gap, d);
      }
    }
  }
  return out;
}

/** What drives a motion, for saying when along the turn something happens. */
function drivenBy(model: Model, m: Motion | undefined): { part?: EvalPart; rate: number } {
  let root = m;
  while (root?.parent) root = root.parent;
  if (root?.link) root = root.link.driver;
  const part = root && model.parts.find((p) => p.motion === root);
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
    if (p.hidden || (p.imported && p.imported.kind !== "solid") || !built[p.id] || p.band || p.libKind === "belt") continue;
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
  // parts that already overlap where they are drawn are the interference check's
  for (const i of kernel.interferences) skip.add(i.a < i.b ? `${i.a}|${i.b}` : `${i.b}|${i.a}`);
  const pairKey = (a: EvalPart, b: EvalPart) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
  const meshes = (a: EvalPart, b: EvalPart) => !!a.gear && !!b.gear && (a.gear.meshWith === b.name || b.gear.meshWith === a.name);

  const hits = new Map<string, { A: Body; B: Body; r: PairResult; names: string[] }>();
  const rubs = new Map<string, { A: Body; B: Body; r: PairResult; names: string[] }>();
  const swept = new Set<string>();
  let left = 0;
  let angles = 0;
  for (const A of movers) {
    for (const B of bodies) {
      if (A === B || B.motion === A.motion || instanceOf(A.p) === instanceOf(B.p)) continue;
      // each pair of moving parts once
      if (turns(B.motion) && movers.indexOf(B) < movers.indexOf(A)) continue;
      if (skip.has(pairKey(A.p, B.p)) || meshes(A.p, B.p)) continue;
      // gears are the gear checks': teeth through the mesh, and the swept tip circle against still parts
      if (A.p.gear || B.p.gear) continue;
      if (performance.now() - t0 > budgetMs) {
        left++;
        continue;
      }
      const at = sweepAngles([A.motion, B.motion]);
      angles = Math.max(angles, at.length);
      const r = sweepPair(A, B, at, !touching.has(pairKey(A.p, B.p)));
      if (!r) continue;
      swept.add(B.p.id);
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
      fix: `Open the gap where they pass to at least 0.5 mm for printed parts (0.2 mm machined): move ${B.p.name} out of ${A.p.name}'s path or trim ${A.p.name}. The motion preview at that angle shows where.`,
      parts: [A.p.id, B.p.id],
      span: A.p.span,
      basis: "geometry",
    });
  }
  if (left) {
    out.push({ id: "sweep:partial", category: "motion", status: "pending", title: "Sweeping the moving parts", detail: `${left} pair${left === 1 ? "" : "s"} of parts still to sweep through the motion: the report updates when they are done.`, basis: "geometry" });
  }
  if (!hits.size && !rubs.size && swept.size) {
    out.push({ id: "sweep:ok", category: "motion", status: "pass", title: "Moving parts clear through their motion", detail: `${movers.length} moving part${movers.length === 1 ? "" : "s"} swept through a full cycle (${angles} positions) against the ${swept.size} part${swept.size === 1 ? "" : "s"} that do not move with ${movers.length === 1 ? "it" : "them"}: nothing collides or rubs.`, basis: "geometry" });
  }
  return out;
}
