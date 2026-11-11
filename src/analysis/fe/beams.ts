// Frames as beams. Each member is a line of 3D beam elements (bending both ways with shear, stretching and twisting)
// through the joints where the members meet, joined rigidly as welds and well-made bracket joints are. That is quick
// and exact for slender members, where small cubes would have to be tiny to follow a 2 mm wall. The results are drawn
// on the members' real shapes: each point moves with the beam's bending shape and turn, and its stress comes from the
// section forces (stretch, bending both ways, twist and shear) at that point of the section.
//
// Joints: a member whose end lies on another member's line (at its end: a corner; part way along: a tee) is joined
// to it there; ends that land on another member's face are carried to its centre line.

import type { BeamSection } from "../../lang/frames";
import { allowableStress, type MechMaterial } from "../materials";
import { describeRegion, type RegionSpec } from "../spec";
import { FeaError, type BucklingResult, type PartField, type Progress, type SafetyAt, type StructuralInput, type StructuralResult } from "./structural";
import type { V3 } from "./voxel";

const G0 = 9.80665;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** A frame member as a beam: the line it was drawn on, its section's own axes across it, and its section. */
export interface BeamMember {
  a: V3;
  b: V3;
  u: V3;
  v: V3;
  section: BeamSection;
}

export interface BeamMemberResult {
  part: string;
  /** between its end joints, mm */
  length: number;
  /** axial force of the larger size along it, N: positive pulls (tension), negative pushes (compression) */
  axial: number;
  /** largest shear force, N */
  shear: number;
  /** largest twisting moment, N·mm */
  torque: number;
  /** largest bending moment, N·mm */
  moment: number;
  /** peak von Mises stress in the member, MPa, and where */
  stress: number;
  at: V3;
  safety: number;
}

export interface BeamResult {
  members: BeamMemberResult[];
  elements: number;
  nodes: number;
  /** points where two or more members are joined */
  joints: number;
  /** the lowest buckling factor of the loads as given, and the member that moves most in that shape */
  buckling?: { factor: number; member: string };
  /** how the frame was modelled, in words */
  notes: string[];
}

// ---------------------------------------------------------------- small vectors

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const AXIS = ["X", "Y", "Z"];

// ---------------------------------------------------------------- the model

interface Mem {
  part: number;
  name: string;
  group?: string;
  a: V3;
  b: V3;
  L: number;
  d: V3;
  u: V3;
  v: V3;
  sec: BeamSection;
  mat: number;
  E: number;
  G: number;
  /** kg/mm³ */
  rho: number;
  /** principal axes across the member: y' = ca·u + sa·v, z' = −sa·u + ca·v; Iy = ∫z'² dA, Iz = ∫y'² dA */
  ca: number;
  sa: number;
  Iy: number;
  Iz: number;
  /** the centroid in principal coordinates */
  cy: number;
  cz: number;
  /** half the section's extent along y' and z' from the centroid, for the shear spread */
  hy: number;
  hz: number;
  /** the section's outline points (y', z') from the centroid, where bending stress peaks */
  corners: [number, number][];
  size: number;
  els: number[];
}

interface Elem {
  m: number;
  n0: number;
  n1: number;
  L: number;
  /** local axes: x along it, y and z the section's principal axes */
  ex: V3;
  ey: V3;
  ez: V3;
}

/** The section's outline across the member in its own (u, v), for where stresses peak. */
function outline(sec: BeamSection): [number, number][] {
  const { w, h } = sec;
  if (sec.round) {
    const out: [number, number][] = [];
    for (let i = 0; i < 16; i++) out.push([(w / 2) * Math.cos((i * Math.PI) / 8), (w / 2) * Math.sin((i * Math.PI) / 8)]);
    return out;
  }
  if (sec.kind === "angle") {
    const t = sec.t ?? 0;
    const x0 = -w / 2,
      y0 = -h / 2;
    return [
      [x0, y0],
      [w / 2, y0],
      [w / 2, y0 + t],
      [x0 + t, y0 + t],
      [x0 + t, h / 2],
      [x0, h / 2],
    ];
  }
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
}

/** How far a member reaches from its centre line in direction dir (across it). */
function reachOf(m: Mem, dir: V3): number {
  if (m.sec.round) return (m.sec.w / 2) * len(sub(dir, scale(m.d, dot(dir, m.d))));
  return (Math.abs(dot(dir, m.u)) * m.sec.w) / 2 + (Math.abs(dot(dir, m.v)) * m.sec.h) / 2;
}

// ---------------------------------------------------------------- element matrices

/** The 12 × 12 stiffness of a beam element in its own axes (DOFs per end: ux uy uz rx ry rz), shear included. */
function localK(m: Mem, L: number): Float64Array {
  const k = new Float64Array(144);
  const s = m.sec;
  const set = (i: number, j: number, v: number) => {
    k[12 * i + j] = v;
    k[12 * j + i] = v;
  };
  const EA = (m.E * s.A) / L,
    GJ = (m.G * s.J) / L;
  set(0, 0, EA);
  set(0, 6, -EA);
  set(6, 6, EA);
  set(3, 3, GJ);
  set(3, 9, -GJ);
  set(9, 9, GJ);
  const As = Math.max(1e-9, s.kappa * s.A);
  // bending that moves it along y (turning about z): Iz
  {
    const ph = (12 * m.E * m.Iz) / (m.G * As * L * L);
    const c = (m.E * m.Iz) / (1 + ph);
    const a = (12 * c) / L ** 3,
      b = (6 * c) / L ** 2,
      cc = ((4 + ph) * c) / L,
      d = ((2 - ph) * c) / L;
    set(1, 1, a);
    set(1, 5, b);
    set(1, 7, -a);
    set(1, 11, b);
    set(5, 5, cc);
    set(5, 7, -b);
    set(5, 11, d);
    set(7, 7, a);
    set(7, 11, -b);
    set(11, 11, cc);
  }
  // bending that moves it along z (turning about y): Iy
  {
    const ph = (12 * m.E * m.Iy) / (m.G * As * L * L);
    const c = (m.E * m.Iy) / (1 + ph);
    const a = (12 * c) / L ** 3,
      b = (6 * c) / L ** 2,
      cc = ((4 + ph) * c) / L,
      d = ((2 - ph) * c) / L;
    set(2, 2, a);
    set(2, 4, -b);
    set(2, 8, -a);
    set(2, 10, -b);
    set(4, 4, cc);
    set(4, 8, b);
    set(4, 10, d);
    set(8, 8, a);
    set(8, 10, b);
    set(10, 10, cc);
  }
  return k;
}

/** The geometric (stress) stiffness of an element carrying axial force N (positive in tension), in its own axes. */
function localKg(m: Mem, L: number, N: number): Float64Array {
  const k = new Float64Array(144);
  const set = (i: number, j: number, v: number) => {
    k[12 * i + j] = v;
    k[12 * j + i] = v;
  };
  const g = N / (30 * L);
  set(1, 1, 36 * g);
  set(1, 5, 3 * L * g);
  set(1, 7, -36 * g);
  set(1, 11, 3 * L * g);
  set(5, 5, 4 * L * L * g);
  set(5, 7, -3 * L * g);
  set(5, 11, -L * L * g);
  set(7, 7, 36 * g);
  set(7, 11, -3 * L * g);
  set(11, 11, 4 * L * L * g);
  set(2, 2, 36 * g);
  set(2, 4, -3 * L * g);
  set(2, 8, -36 * g);
  set(2, 10, -3 * L * g);
  set(4, 4, 4 * L * L * g);
  set(4, 8, 3 * L * g);
  set(4, 10, -L * L * g);
  set(8, 8, 36 * g);
  set(8, 10, 3 * L * g);
  set(10, 10, 4 * L * L * g);
  const t = (N * (m.Iy + m.Iz)) / (m.sec.A * L);
  set(3, 3, t);
  set(3, 9, -t);
  set(9, 9, t);
  return k;
}

/** T k Tᵀ … the element matrix in world axes: each 3 × 3 block Λᵀ k Λ, with Λ's rows the element's own axes. */
function toWorld(kl: Float64Array, e: Elem): Float64Array {
  const R = [e.ex, e.ey, e.ez];
  const out = new Float64Array(144);
  for (let bi = 0; bi < 4; bi++)
    for (let bj = 0; bj < 4; bj++) {
      // block (bi, bj): Σ_pq R[p][i] k[p][q] R[q][j]
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          let s = 0;
          for (let p = 0; p < 3; p++) {
            const rpi = R[p][i];
            if (rpi === 0) continue;
            for (let q = 0; q < 3; q++) s += rpi * kl[12 * (3 * bi + p) + 3 * bj + q] * R[q][j];
          }
          out[12 * (3 * bi + i) + 3 * bj + j] = s;
        }
    }
  return out;
}

/** World displacements of an element's ends (12) into its own axes. */
function toLocal(e: Elem, dw: ArrayLike<number>, out: Float64Array) {
  const R = [e.ex, e.ey, e.ez];
  for (let b = 0; b < 4; b++)
    for (let p = 0; p < 3; p++) out[3 * b + p] = R[p][0] * dw[3 * b] + R[p][1] * dw[3 * b + 1] + R[p][2] * dw[3 * b + 2];
}

// ---------------------------------------------------------------- the skyline solver

/** A symmetric matrix stored by columns down to the diagonal, from each column's first non-zero row (a profile). */
class Skyline {
  readonly diag: Int32Array;
  readonly top: Int32Array;
  readonly a: Float64Array;
  constructor(readonly n: number, top: Int32Array) {
    this.top = top;
    this.diag = new Int32Array(n);
    let at = -1;
    for (let j = 0; j < n; j++) {
      at += j - top[j] + 1;
      this.diag[j] = at;
    }
    this.a = new Float64Array(at + 1);
  }
  /** add v at (i, j), i ≤ j */
  add(i: number, j: number, v: number) {
    if (i > j) [i, j] = [j, i];
    this.a[this.diag[j] - (j - i)] += v;
  }
  get(i: number, j: number): number {
    if (i > j) [i, j] = [j, i];
    if (i < this.top[j]) return 0;
    return this.a[this.diag[j] - (j - i)];
  }
  /** y = A x */
  mul(x: Float64Array, y: Float64Array) {
    y.fill(0);
    const { a, diag, top } = this;
    for (let j = 0; j < this.n; j++) {
      const dj = diag[j];
      let s = a[dj] * x[j];
      for (let i = top[j]; i < j; i++) {
        const v = a[dj - (j - i)];
        s += v * x[i];
        y[i] += v * x[j];
      }
      y[j] += s;
    }
  }
  /** LDLᵀ in place; the first equation whose pivot vanishes (the structure can move there freely), or -1 */
  factor(): number {
    const { a, diag, top } = this;
    let big = 0;
    for (let j = 0; j < this.n; j++) big = Math.max(big, Math.abs(a[diag[j]]));
    for (let j = 0; j < this.n; j++) {
      const tj = top[j],
        dj = diag[j];
      const orig = a[dj];
      for (let i = tj + 1; i < j; i++) {
        const ti = top[i],
          di = diag[i];
        const k0 = Math.max(ti, tj);
        let s = 0;
        for (let k = k0; k < i; k++) s += a[di - (i - k)] * a[dj - (j - k)];
        a[dj - (j - i)] -= s;
      }
      let s = 0;
      for (let i = tj; i < j; i++) {
        const g = a[dj - (j - i)];
        const l = g / a[diag[i]];
        s += l * g;
        a[dj - (j - i)] = l;
      }
      a[dj] -= s;
      if (!(a[dj] > 1e-9 * Math.max(orig, 1e-30)) || a[dj] < 1e-14 * big) return j;
    }
    return -1;
  }
  /** solve with the factors, in place */
  solve(b: Float64Array) {
    const { a, diag, top, n } = this;
    for (let j = 0; j < n; j++) {
      const dj = diag[j];
      let s = 0;
      for (let k = top[j]; k < j; k++) s += a[dj - (j - k)] * b[k];
      b[j] -= s;
    }
    for (let j = 0; j < n; j++) b[j] /= a[diag[j]];
    for (let j = n - 1; j >= 0; j--) {
      const dj = diag[j],
        bj = b[j];
      for (let k = top[j]; k < j; k++) b[k] -= a[dj - (j - k)] * bj;
    }
  }
}

/** Nodes in reverse Cuthill–McKee order, so the profile stays narrow. */
function rcm(nn: number, adj: number[][]): number[] {
  const order: number[] = [];
  const seen = new Uint8Array(nn);
  const deg = adj.map((a) => a.length);
  const byDeg = [...Array(nn).keys()].sort((a, b) => deg[a] - deg[b]);
  for (const start of byDeg) {
    if (seen[start]) continue;
    // a far node of this piece to start from
    let s = start;
    for (let pass = 0; pass < 2; pass++) {
      const lvl = new Int32Array(nn).fill(-1);
      lvl[s] = 0;
      const q = [s];
      for (let h = 0; h < q.length; h++) for (const t of adj[q[h]]) if (lvl[t] < 0) (lvl[t] = lvl[q[h]] + 1), q.push(t);
      const far = q[q.length - 1];
      if (far === s) break;
      s = far;
    }
    const q = [s];
    seen[s] = 1;
    for (let h = 0; h < q.length; h++) {
      const next = adj[q[h]].filter((t) => !seen[t]).sort((x, y) => deg[x] - deg[y]);
      for (const t of next) {
        seen[t] = 1;
        q.push(t);
      }
    }
    order.push(...q);
  }
  return order.reverse();
}

/** Eigenvalues and vectors of a small symmetric matrix (Jacobi rotations); vectors as columns of V (row-major). */
function jacobi(A: Float64Array, n: number): { val: number[]; V: Float64Array } {
  const a = Float64Array.from(A);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p],
            akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k],
            aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p],
            vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  return { val: [...Array(n).keys()].map((i) => a[i * n + i]), V };
}

// ---------------------------------------------------------------- the solve

/** Analyse a frame whose parts are all beams (FeaPart.beam). */
export function runBeams(inp: StructuralInput, progress: Progress = () => undefined): StructuralResult {
  const t0 = now();
  const warnings: string[] = [];
  const notes: string[] = [];
  progress("Beams: joining the members", 0.05);
  // ---- members ----
  const mems: Mem[] = [];
  for (let pi = 0; pi < inp.parts.length; pi++) {
    const p = inp.parts[pi];
    const bm = p.beam;
    if (!bm) throw new FeaError(`${p.name} is not a frame member, so it cannot be analysed as a beam. Analyse the frame on its own, or use elements: "solid".`);
    const mat = inp.materials[p.material];
    const L = len(sub(bm.b, bm.a));
    if (L < 1e-6) continue;
    const d = norm(sub(bm.b, bm.a));
    const s = bm.section;
    const al = 0.5 * Math.atan2(-2 * s.Iuv, s.Iu - s.Iv);
    const ca = Math.cos(al),
      sa = Math.sin(al);
    const Iy = sa * sa * s.Iv - 2 * ca * sa * s.Iuv + ca * ca * s.Iu;
    const Iz = ca * ca * s.Iv + 2 * ca * sa * s.Iuv + sa * sa * s.Iu;
    const cy = ca * s.c[0] + sa * s.c[1],
      cz = -sa * s.c[0] + ca * s.c[1];
    const corners = outline(s).map(([pu, pv]): [number, number] => [ca * pu + sa * pv - cy, -sa * pu + ca * pv - cz]);
    const hy = Math.max(...corners.map((c) => Math.abs(c[0]))),
      hz = Math.max(...corners.map((c) => Math.abs(c[1])));
    mems.push({
      part: pi,
      name: p.name,
      ...(p.group ? { group: p.group } : {}),
      a: bm.a,
      b: bm.b,
      L,
      d,
      u: bm.u,
      v: bm.v,
      sec: s,
      mat: p.material,
      E: mat.E,
      G: mat.E / (2 * (1 + mat.nu)),
      rho: mat.density * 1e-6,
      ca,
      sa,
      Iy: Math.max(Iy, 1e-9),
      Iz: Math.max(Iz, 1e-9),
      cy,
      cz,
      hy,
      hz,
      corners,
      size: Math.max(s.w, s.h),
      els: [],
    });
  }
  if (!mems.length) throw new FeaError("Nothing to analyse: the frame has no members with a length.");
  const nm = mems.length;

  // ---- joints: ends that lie on another member's line, at its end or part way along ----
  interface Pt {
    m: number;
    s: number;
    p: V3;
    tee: boolean;
  }
  const pts: Pt[] = [];
  for (let i = 0; i < nm; i++) pts.push({ m: i, s: 0, p: mems[i].a, tee: false }, { m: i, s: mems[i].L, p: mems[i].b, tee: false });
  const parent: number[] = pts.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let q = 0; q < nm; q++)
    for (let e = 0; e < 2; e++) {
      const P = e ? mems[q].b : mems[q].a;
      for (let mi = 0; mi < nm; mi++) {
        if (mi === q) continue;
        const m = mems[mi];
        const tol = 0.55 * Math.max(m.size, mems[q].size) + 0.5;
        const s = dot(sub(P, m.a), m.d);
        if (s < -tol || s > m.L + tol) continue;
        const sc = Math.max(0, Math.min(m.L, s));
        if (len(sub(P, add(m.a, scale(m.d, sc)))) > tol) continue;
        if (sc < tol) union(2 * q + e, 2 * mi);
        else if (sc > m.L - tol) union(2 * q + e, 2 * mi + 1);
        else {
          pts.push({ m: mi, s: sc, p: add(m.a, scale(m.d, sc)), tee: true });
          parent.push(pts.length - 1);
          union(2 * q + e, pts.length - 1);
        }
      }
    }
  // stations along each member, close ones merged
  const stations: { s: number; pt: number }[][] = mems.map(() => []);
  pts.forEach((p, i) => stations[p.m].push({ s: p.s, pt: i }));
  for (let mi = 0; mi < nm; mi++) {
    const st = stations[mi].sort((x, y) => x.s - y.s);
    const merged: { s: number; pt: number }[] = [];
    for (const x of st) {
      const last = merged[merged.length - 1];
      if (last && x.s - last.s < Math.max(0.01, 1e-4 * mems[mi].L)) union(last.pt, x.pt);
      else merged.push(x);
    }
    stations[mi] = merged;
  }
  // one node per joined group: on the through member's centre line for a tee, else where the ends meet
  const nodePos: V3[] = [];
  const nodeOf = new Map<number, number>();
  const groupPts = new Map<number, number[]>();
  pts.forEach((_, i) => {
    const r = find(i);
    groupPts.set(r, [...(groupPts.get(r) ?? []), i]);
  });
  const groupMembers = new Map<number, Set<number>>();
  for (const [r, list] of groupPts) {
    const tee = list.find((i) => pts[i].tee);
    let p: V3;
    if (tee !== undefined) p = pts[tee].p;
    else {
      p = [0, 0, 0];
      for (const i of list) p = add(p, pts[i].p);
      p = scale(p, 1 / list.length);
      // where the members' lines cross (the point nearest all of them), unless they run the same way
      const ms = [...new Set(list.map((i) => pts[i].m))];
      if (ms.length > 1) {
        const M = new Float64Array(9);
        let b: V3 = [0, 0, 0];
        for (const mi of ms) {
          const { d, a } = mems[mi];
          const Pa: V3 = [0, 0, 0];
          for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++) {
              const v = (i === j ? 1 : 0) - d[i] * d[j];
              M[3 * i + j] += v;
              Pa[i] += v * a[j];
            }
          b = add(b, Pa);
        }
        const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
        const tr = M[0] + M[4] + M[8];
        if (Math.abs(det) > 1e-6 * tr ** 3) {
          const inv = [
            M[4] * M[8] - M[5] * M[7],
            M[2] * M[7] - M[1] * M[8],
            M[1] * M[5] - M[2] * M[4],
            M[5] * M[6] - M[3] * M[8],
            M[0] * M[8] - M[2] * M[6],
            M[2] * M[3] - M[0] * M[5],
            M[3] * M[7] - M[4] * M[6],
            M[1] * M[6] - M[0] * M[7],
            M[0] * M[4] - M[1] * M[3],
          ].map((x) => x / det);
          const q: V3 = [inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2], inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2], inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2]];
          const reachMax = Math.max(...ms.map((mi) => mems[mi].size));
          if (len(sub(q, p)) <= 2 * reachMax + 1) p = q;
        }
      }
    }
    nodeOf.set(r, nodePos.length);
    nodePos.push(p);
    groupMembers.set(r, new Set(list.map((i) => pts[i].m)));
  }
  const joints = [...groupMembers.values()].filter((s) => s.size > 1).length;

  // ---- elements along each member ----
  const perMember = nm <= 30 ? 10 : nm <= 80 ? 6 : 4;
  const els: Elem[] = [];
  const memOfNode: number[][] = nodePos.map(() => []);
  for (let mi = 0; mi < nm; mi++) {
    const m = mems[mi];
    const st = stations[mi];
    // the principal y across the member
    const yP: V3 = add(scale(m.u, m.ca), scale(m.v, m.sa));
    for (let k = 0; k + 1 < st.length; k++) {
      const na = nodeOf.get(find(st[k].pt))!,
        nb = nodeOf.get(find(st[k + 1].pt))!;
      if (na === nb) continue;
      const pa = nodePos[na],
        pb = nodePos[nb];
      const span = len(sub(pb, pa));
      if (span < 1e-6) continue;
      let n = Math.max(1, Math.round((perMember * (st[k + 1].s - st[k].s)) / m.L));
      if (span > 4 * m.size) n = Math.max(n, 2);
      let prev = na;
      for (let j = 1; j <= n; j++) {
        let nx: number;
        if (j === n) nx = nb;
        else {
          nx = nodePos.length;
          nodePos.push(add(pa, scale(sub(pb, pa), j / n)));
          memOfNode.push([]);
        }
        const p0 = nodePos[prev],
          p1 = nodePos[nx];
        const ex = norm(sub(p1, p0));
        const ey = norm(sub(yP, scale(ex, dot(yP, ex))));
        const ez = cross(ex, ey);
        m.els.push(els.length);
        els.push({ m: mi, n0: prev, n1: nx, L: len(sub(p1, p0)), ex, ey, ez });
        prev = nx;
      }
    }
    if (!m.els.length) warnings.push(`${m.name} is shorter than the joints at its ends, so it was left out of the beams.`);
  }
  for (const e of els) {
    if (!memOfNode[e.n0].includes(e.m)) memOfNode[e.n0].push(e.m);
    if (!memOfNode[e.n1].includes(e.m)) memOfNode[e.n1].push(e.m);
  }
  const nn = nodePos.length;
  const ne = els.length;
  if (!ne) throw new FeaError("Nothing to analyse: no frame member is longer than its joints.");
  let scaleLen = 0;
  for (const p of nodePos) scaleLen = Math.max(scaleLen, len(p));
  const tMesh = now();

  // ---- regions → nodes ----
  const byName = new Map<string, number[]>();
  mems.forEach((m, i) => {
    byName.set(m.name, [...(byName.get(m.name) ?? []), i]);
    if (m.group && m.group !== m.name) byName.set(m.group, [...(byName.get(m.group) ?? []), i]);
  });
  const allMems = mems.map((_, i) => i);
  interface Sel {
    nodes: number[];
    w: number[];
    area: number;
    face: boolean;
    /** a face's outward direction */
    dir?: V3;
  }
  const inZone = (z: Extract<RegionSpec, { t: "sphere" | "box" | "cyl" }>, p: V3, pad: number): boolean => {
    switch (z.t) {
      case "sphere":
        return len(sub(p, z.at)) <= z.r + pad;
      case "box":
        return Math.abs(p[0] - z.at[0]) <= z.size[0] / 2 + pad && Math.abs(p[1] - z.at[1]) <= z.size[1] / 2 + pad && Math.abs(p[2] - z.at[2]) <= z.size[2] / 2 + pad;
      case "cyl": {
        const ax = norm(z.axis);
        const v = sub(p, z.at);
        const s = dot(v, ax);
        if (s < -pad || s > z.length + pad) return false;
        return len(sub(v, scale(ax, s))) <= z.d / 2 + pad;
      }
    }
  };
  const select = (r: RegionSpec): Sel => {
    let ms: number[];
    let picked: number[] = [];
    let dir: V3 | undefined;
    if (r.t === "face" || r.t === "extreme") {
      if (r.t === "face") {
        const idx = byName.get(r.part);
        if (!idx) throw new FeaError(`face(${r.part}, …): "${r.part}" is not one of the analysed members (${[...new Set(mems.map((m) => m.group ?? m.name))].join(", ")}).`);
        ms = idx;
      } else ms = allMems;
      dir = norm(r.dir);
      const reach = new Map<number, number>();
      for (const mi of ms)
        for (const ei of mems[mi].els) {
          const rr = reachOf(mems[mi], dir);
          for (const n of [els[ei].n0, els[ei].n1]) reach.set(n, Math.max(reach.get(n) ?? -Infinity, rr));
        }
      let best = -Infinity;
      for (const [n, rr] of reach) best = Math.max(best, dot(nodePos[n], dir) + rr);
      const tol = 1e-4 * scaleLen + 0.01;
      for (const [n, rr] of reach) if (dot(nodePos[n], dir) + rr >= best - tol) picked.push(n);
    } else {
      ms = allMems;
      for (let n = 0; n < nn; n++) {
        const pad = Math.max(0, ...memOfNode[n].map((mi) => mems[mi].size / 2));
        if (inZone(r, nodePos[n], pad) && (!r.within || inZone(r.within, nodePos[n], pad))) picked.push(n);
      }
    }
    if (!picked.length) throw new FeaError(`${describeRegion(r)} reaches no member's centre line, so it holds or loads nothing in the beams. Use face(member, dir) or a zone around a joint.`);
    // weights: the length of member each node stands for, along the elements the region covers
    const set = new Set(picked);
    const w = new Map<number, number>(picked.map((n) => [n, 0]));
    let area = 0;
    let lengthCovered = 0;
    const msSet = new Set(ms);
    for (let ei = 0; ei < ne; ei++) {
      const e = els[ei];
      if (!msSet.has(e.m) || !set.has(e.n0) || !set.has(e.n1)) continue;
      w.set(e.n0, w.get(e.n0)! + e.L / 2);
      w.set(e.n1, w.get(e.n1)! + e.L / 2);
      lengthCovered += e.L;
      const m = mems[e.m];
      // the face's width across the member: the section's extent at right angles to both the member and dir
      const across = dir ? cross(e.ex, dir) : null;
      const width = across && len(across) > 1e-6 ? 2 * reachOf(m, norm(across)) : m.size;
      area += e.L * width;
    }
    let ws = picked.map((n) => w.get(n)!);
    if (!(lengthCovered > 0)) {
      // only ends: share alike; the area is the ends' sections
      ws = picked.map(() => 1);
      area = picked.reduce((t, n) => t + Math.max(0, ...memOfNode[n].filter((mi) => msSet.has(mi)).map((mi) => mems[mi].sec.A)), 0);
    }
    return { nodes: picked, w: ws, area, face: r.t === "face" || r.t === "extreme", ...(dir ? { dir } : {}) };
  };

  // ---- loads ----
  const F = new Float64Array(6 * nn);
  const loadsOut: StructuralResult["loads"] = [];
  const centroid = (sel: Sel): V3 => {
    let c: V3 = [0, 0, 0];
    const tw = sel.w.reduce((a, b) => a + b, 0);
    sel.nodes.forEach((n, i) => (c = add(c, scale(nodePos[n], sel.w[i] / tw))));
    return c;
  };
  const spread = (sel: Sel, f: V3, off: number) => {
    const tw = sel.w.reduce((a, b) => a + b, 0);
    sel.nodes.forEach((n, i) => {
      for (let k = 0; k < 3; k++) F[6 * n + off + k] += (f[k] * sel.w[i]) / tw;
    });
  };
  for (const ld of inp.loads) {
    const sel = select(ld.region);
    const c = centroid(sel);
    if (ld.t === "force" || ld.t === "bearing") {
      spread(sel, ld.f, 0);
      if (ld.t === "force" && ld.from) spread(sel, cross(sub(ld.from, c), ld.f), 3);
      loadsOut.push({ kind: ld.t, region: describeRegion(ld.region), at: ld.t === "force" && ld.from ? ld.from : c, vector: ld.f, magnitude: len(ld.f), area: sel.area, nodes: sel.nodes.length });
    } else if (ld.t === "pressure") {
      if (!sel.dir) throw new FeaError(`pressure() on a frame analysed as beams needs face(member, dir), so it knows which way it presses; ${describeRegion(ld.region)} has no side.`);
      const f = scale(sel.dir, -ld.p * sel.area);
      spread(sel, f, 0);
      loadsOut.push({ kind: "pressure", region: describeRegion(ld.region), at: c, vector: f, magnitude: len(f), area: sel.area, nodes: sel.nodes.length });
    } else if (ld.t === "torque") {
      const ax = norm(ld.axis);
      spread(sel, scale(ax, ld.torque), 3);
      loadsOut.push({ kind: "torque", region: describeRegion(ld.region), at: ld.at ?? c, vector: [0, 0, 0], magnitude: ld.torque, area: sel.area, nodes: sel.nodes.length, axis: ax });
    }
  }
  // the members' own weight (and what they carry) under gravity or an acceleration
  let gravity: StructuralResult["gravity"] = null;
  let massKg = 0;
  let volume = 0;
  let com: V3 = [0, 0, 0];
  for (const e of els) {
    const m = mems[e.m];
    const me = m.rho * m.sec.A * e.L;
    massKg += me;
    volume += m.sec.A * e.L;
    com = add(com, scale(add(nodePos[e.n0], nodePos[e.n1]), me / 2));
  }
  if (inp.accel) {
    const a = inp.accel;
    let mt = 0;
    let c: V3 = [0, 0, 0];
    for (const e of els) {
      const m = mems[e.m];
      const me = m.rho * m.sec.A * e.L;
      for (const n of [e.n0, e.n1]) for (let k = 0; k < 3; k++) F[6 * n + k] += (me / 2) * a[k] * G0;
      mt += me;
      c = add(c, scale(add(nodePos[e.n0], nodePos[e.n1]), me / 2));
    }
    for (const ms of inp.masses ?? []) {
      const sel = select(ms.region);
      const kg = ms.grams / 1000;
      spread(sel, scale(a, kg * G0), 0);
      mt += kg;
      c = add(c, scale(centroid(sel), kg));
    }
    if (mt > 0) gravity = { vector: scale(a, mt * G0), at: scale(c, 1 / mt) };
  }

  // ---- supports: held directions per node ----
  // per node and kind (0 translations, 1 turns): held directions with their set values
  interface Hold {
    n: V3;
    val: number;
    sup: number;
  }
  const holds: Hold[][][] = nodePos.map(() => [[], []]);
  const springs: { n: number; k: number; dir?: V3; sup: number }[] = [];
  const supportSel: Sel[] = [];
  const supWarn = new Set<string>();
  const perp = (d: V3): [V3, V3] => {
    const a: V3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const p = norm(cross(d, a));
    return [p, cross(d, p)];
  };
  inp.supports.forEach((s, si) => {
    const sel = select(s.region);
    supportSel.push(sel);
    const dir = s.dir ? norm(s.dir) : undefined;
    if (s.spring) {
      const rate = s.spring.rate ?? (s.spring.perArea ?? 0) * sel.area;
      const tw = sel.w.reduce((a, b) => a + b, 0);
      sel.nodes.forEach((n, i) => springs.push({ n, k: (rate * sel.w[i]) / tw, ...(dir ? { dir } : {}), sup: si }));
      return;
    }
    if (s.contact) supWarn.add("Seats that are only pressed on (contact:) are taken as held both ways in beams.");
    if (s.pin && !s.pin.tight) supWarn.add("Pins are taken as tight in beams (held all round, free to turn).");
    for (const n of sel.nodes) {
      const T = holds[n][0],
        Rt = holds[n][1];
      if (s.pin) {
        // through a bore: held across it (and along it unless it slides), free to turn about it
        const ax = norm(s.region.t === "cyl" ? s.region.axis : (dir ?? [0, 0, 1]));
        const [p1, p2] = perp(ax);
        T.push({ n: p1, val: 0, sup: si }, { n: p2, val: 0, sup: si });
        if (!s.pin.slide) T.push({ n: ax, val: 0, sup: si });
        Rt.push({ n: p1, val: 0, sup: si }, { n: p2, val: 0, sup: si });
        continue;
      }
      const mv = s.move ?? [0, 0, 0];
      if (dir) {
        T.push({ n: dir, val: dot(mv, dir), sup: si });
        // a face held along dir stays flat: it cannot tilt; a zone is a point that can
        if (sel.face) {
          const [p1, p2] = perp(dir);
          Rt.push({ n: p1, val: 0, sup: si }, { n: p2, val: 0, sup: si });
        }
      } else {
        T.push({ n: [1, 0, 0], val: mv[0], sup: si }, { n: [0, 1, 0], val: mv[1], sup: si }, { n: [0, 0, 1], val: mv[2], sup: si });
        Rt.push({ n: [1, 0, 0], val: 0, sup: si }, { n: [0, 1, 0], val: 0, sup: si }, { n: [0, 0, 1], val: 0, sup: si });
      }
    }
  });
  warnings.push(...supWarn);
  // axis-aligned holds remove the DOF; others are stiff springs
  const fixedVal = new Float64Array(6 * nn);
  const isFixed = new Uint8Array(6 * nn);
  const penalties: { dof0: number; n: V3; val: number }[] = [];
  const supOfNode = new Int32Array(nn).fill(-1);
  for (let n = 0; n < nn; n++)
    for (let kind = 0; kind < 2; kind++)
      for (const h of holds[n][kind]) {
        if (supOfNode[n] < 0) supOfNode[n] = h.sup;
        const k = h.n.findIndex((x) => Math.abs(x) > 1 - 1e-9);
        if (k >= 0) {
          const dof = 6 * n + 3 * kind + k;
          isFixed[dof] = 1;
          fixedVal[dof] = h.val * Math.sign(h.n[k]);
        } else penalties.push({ dof0: 6 * n + 3 * kind, n: h.n, val: h.val });
      }
  for (const s of springs) if (supOfNode[s.n] < 0) supOfNode[s.n] = s.sup;

  // every member must reach a support through the joints
  {
    const adj: number[][] = nodePos.map(() => []);
    for (const e of els) adj[e.n0].push(e.n1), adj[e.n1].push(e.n0);
    const seen = new Uint8Array(nn);
    const q: number[] = [];
    for (let n = 0; n < nn; n++) if (supOfNode[n] >= 0) (seen[n] = 1), q.push(n);
    for (let h = 0; h < q.length; h++) for (const t of adj[q[h]]) if (!seen[t]) (seen[t] = 1), q.push(t);
    const loose = mems.filter((m) => m.els.length && !seen[els[m.els[0]].n0]).map((m) => m.name);
    if (loose.length) throw new FeaError(`${loose.slice(0, 4).join(", ")}${loose.length > 4 ? ` and ${loose.length - 4} more` : ""} ${loose.length > 1 ? "are" : "is"} not joined to anything held: ${loose.length > 1 ? "their" : "its"} ends do not meet the rest of the frame. Join ${loose.length > 1 ? "them" : "it"} to another member, or fix it too.`);
  }

  // ---- equations, in RCM node order ----
  const adj: number[][] = nodePos.map(() => []);
  for (const e of els) {
    adj[e.n0].push(e.n1);
    adj[e.n1].push(e.n0);
  }
  const order = rcm(nn, adj);
  const eq = new Int32Array(6 * nn).fill(-1);
  let neq = 0;
  for (const n of order) for (let k = 0; k < 6; k++) if (!isFixed[6 * n + k]) eq[6 * n + k] = neq++;
  if (!neq) throw new FeaError("Every joint of the frame is held, so nothing can bend.");
  const top = new Int32Array(neq);
  for (let j = 0; j < neq; j++) top[j] = j;
  const dofsOf = (e: Elem) => {
    const d = new Int32Array(12);
    for (let k = 0; k < 6; k++) {
      d[k] = 6 * e.n0 + k;
      d[6 + k] = 6 * e.n1 + k;
    }
    return d;
  };
  for (const e of els) {
    const d = dofsOf(e);
    let lo = Infinity;
    for (const g of d) if (eq[g] >= 0) lo = Math.min(lo, eq[g]);
    for (const g of d) if (eq[g] >= 0) top[eq[g]] = Math.min(top[eq[g]], lo);
  }
  // a node's own 6 DOFs couple through springs and oblique holds
  for (let n = 0; n < nn; n++) {
    let lo = Infinity;
    for (let k = 0; k < 6; k++) if (eq[6 * n + k] >= 0) lo = Math.min(lo, eq[6 * n + k]);
    for (let k = 0; k < 6; k++) if (eq[6 * n + k] >= 0) top[eq[6 * n + k]] = Math.min(top[eq[6 * n + k]], lo);
  }
  const K = new Skyline(neq, top);
  const rhs = new Float64Array(neq);
  for (let g = 0; g < 6 * nn; g++) if (eq[g] >= 0) rhs[eq[g]] += F[g];
  const kWorld: Float64Array[] = [];
  for (const e of els) {
    const kw = toWorld(localK(mems[e.m], e.L), e);
    kWorld.push(kw);
    const d = dofsOf(e);
    for (let i = 0; i < 12; i++) {
      const gi = eq[d[i]];
      if (gi < 0) continue;
      for (let j = 0; j < 12; j++) {
        const v = kw[12 * i + j];
        if (v === 0) continue;
        const gj = eq[d[j]];
        if (gj < 0) rhs[gi] -= v * fixedVal[d[j]];
        else if (gj >= gi) K.add(gi, gj, v);
      }
    }
  }
  let maxDiag = 0;
  for (let j = 0; j < neq; j++) maxDiag = Math.max(maxDiag, K.a[K.diag[j]]);
  const addBlock = (dof0: number, M: number[], val: V3 | null) => {
    for (let i = 0; i < 3; i++) {
      const gi = eq[dof0 + i];
      if (gi < 0) continue;
      if (val) rhs[gi] += val[i];
      for (let j = 0; j < 3; j++) {
        const gj = eq[dof0 + j];
        if (gj >= gi && M[3 * i + j] !== 0) K.add(gi, gj, M[3 * i + j]);
      }
    }
  };
  const outer = (n: V3, k: number) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => k * n[i] * n[j]));
  const kPen = 1e6 * maxDiag;
  for (const p of penalties) addBlock(p.dof0, outer(p.n, kPen), scale(p.n, kPen * p.val));
  for (const s of springs) addBlock(6 * s.n, s.dir ? outer(s.dir, s.k) : [s.k, 0, 0, 0, s.k, 0, 0, 0, s.k], null);
  const tSetup = now();
  progress("Beams: solving", 0.3);
  const factored = K.factor();
  if (factored >= 0) {
    let g = 0;
    while (g < 6 * nn && eq[g] !== factored) g++;
    const n = Math.floor(g / 6),
      k = g % 6;
    const names = [...new Set(memOfNode[n].map((mi) => mems[mi].name))].join(" and ");
    throw new FeaError(
      `The frame is not held enough: it can ${k < 3 ? `move along ${AXIS[k]}` : `turn about ${AXIS[k - 3]}`} at ${names || "a joint"} without bending anything. Hold it more firmly (fix: rather than a roller), or brace it.`,
    );
  }
  const x = Float64Array.from(rhs);
  K.solve(x);
  const U = new Float64Array(6 * nn);
  for (let g = 0; g < 6 * nn; g++) U[g] = eq[g] >= 0 ? x[eq[g]] : fixedVal[g];
  const tSolve = now();
  progress("Beams: stresses", 0.6);

  // ---- element forces, internal forces at the nodes, reactions ----
  const Fint = new Float64Array(6 * nn);
  const res0: Float64Array[] = [];
  const res1: Float64Array[] = [];
  const dl = new Float64Array(12);
  const dw = new Float64Array(12);
  const kLoc: Float64Array[] = [];
  for (let ei = 0; ei < ne; ei++) {
    const e = els[ei];
    const d = dofsOf(e);
    for (let i = 0; i < 12; i++) dw[i] = U[d[i]];
    const kw = kWorld[ei];
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += kw[12 * i + j] * dw[j];
      Fint[d[i]] += s;
    }
    toLocal(e, dw, dl);
    const kl = localK(mems[e.m], e.L);
    kLoc.push(kl);
    const f = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += kl[12 * i + j] * dl[j];
      f[i] = s;
    }
    const r0 = new Float64Array(6),
      r1 = new Float64Array(6);
    for (let k = 0; k < 6; k++) {
      r0[k] = -f[k];
      r1[k] = f[6 + k];
    }
    res0.push(r0);
    res1.push(r1);
  }
  // springs push back on the frame too
  const Fspring = new Float64Array(6 * nn);
  for (const s of springs)
    for (let i = 0; i < 3; i++) {
      let v = 0;
      for (let j = 0; j < 3; j++) v += (s.dir ? s.k * s.dir[i] * s.dir[j] : i === j ? s.k : 0) * U[6 * s.n + j];
      Fspring[6 * s.n + i] += v;
    }
  // equilibrium where nothing holds: the solve's residual
  let resid = 0,
    fmax = 0;
  const held = new Uint8Array(nn);
  for (let n = 0; n < nn; n++) if (holds[n][0].length || holds[n][1].length) held[n] = 1;
  for (let g = 0; g < 6 * nn; g++) {
    fmax = Math.max(fmax, Math.abs(F[g]));
    if (!held[Math.floor(g / 6)]) resid = Math.max(resid, Math.abs(Fint[g] + Fspring[g] - F[g]));
  }
  const residual = fmax > 0 ? resid / fmax : 0;

  // reactions: what each support pushes on the frame with (what holds the nodes balances the elements)
  const supportsOut: StructuralResult["supports"] = inp.supports.map((s, si) => {
    const sel = supportSel[si];
    const R: V3 = [0, 0, 0];
    for (const n of sel.nodes) {
      if (supOfNode[n] !== si) continue;
      for (let k = 0; k < 3; k++) R[k] += s.spring ? -Fspring[6 * n + k] : Fint[6 * n + k] + Fspring[6 * n + k] - F[6 * n + k];
    }
    const at = centroid(sel);
    const markers = new Float32Array(3 * sel.nodes.length);
    sel.nodes.forEach((n, i) => markers.set(nodePos[n], 3 * i));
    let give = 0;
    if (s.spring) {
      for (const n of sel.nodes) give += s.dir ? Math.abs(dot([U[6 * n], U[6 * n + 1], U[6 * n + 2]], norm(s.dir))) : Math.hypot(U[6 * n], U[6 * n + 1], U[6 * n + 2]);
      give /= sel.nodes.length;
    }
    return {
      region: describeRegion(s.region),
      ...(s.dir ? { dir: norm(s.dir) } : {}),
      at,
      nodes: sel.nodes.length,
      reaction: R,
      markers,
      ...(s.spring ? { kind: "spring" as const, spring: { ...(s.spring.rate !== undefined ? { rate: s.spring.rate } : {}), ...(s.spring.perArea !== undefined ? { perArea: s.spring.perArea } : {}), give } } : {}),
      ...(s.move ? { kind: "move" as const, moved: s.move } : {}),
      ...(s.pin
        ? {
            kind: "pin" as const,
            pin: { tight: true, slide: s.pin.slide, share: 1, pressure: s.region.t === "cyl" && s.region.d * s.region.length > 0 ? len(R) / (s.region.d * s.region.length) : 0, d: s.region.t === "cyl" ? s.region.d : 0, length: s.region.t === "cyl" ? s.region.length : 0, axis: norm(s.region.t === "cyl" ? s.region.axis : (s.dir ?? [0, 0, 1])), rounds: 0 },
          }
        : {}),
    };
  });
  const applied: V3 = [0, 0, 0];
  for (let n = 0; n < nn; n++) for (let k = 0; k < 3; k++) applied[k] += F[6 * n + k];
  const reaction: V3 = [0, 0, 0];
  for (const s of supportsOut) for (let k = 0; k < 3; k++) reaction[k] += s.reaction[k];
  const equilibrium = len(applied) > 1e-9 ? len(add(applied, reaction)) / len(applied) : 0;

  // ---- stresses: section forces at each point of the real members ----
  const cycles = inp.cycles;
  const allow = inp.materials.map((m) => allowableStress(m, cycles));
  /** von Mises at a point (y', z') of a section, from the section forces there */
  const vmAt = (m: Mem, r: ArrayLike<number>, y: number, z: number): { vm: number; sx: number } => {
    const [N, Vy, Vz, T, My, Mz] = [r[0], r[1], r[2], r[3], r[4], r[5]];
    const sx = N / m.sec.A + (My * z) / m.Iy - (Mz * y) / m.Iz;
    const As = m.sec.kappa * m.sec.A;
    const tv = (Math.abs(Vy) / As) * Math.max(0, 1 - (y / Math.max(m.hy, 1e-9)) ** 2) + (Math.abs(Vz) / As) * Math.max(0, 1 - (z / Math.max(m.hz, 1e-9)) ** 2);
    const tau = Math.abs(T) * m.sec.tau + tv;
    return { vm: Math.sqrt(sx * sx + 3 * tau * tau), sx };
  };
  const rAt = (ei: number, xi: number, out: Float64Array) => {
    const r0 = res0[ei],
      r1 = res1[ei];
    for (let k = 0; k < 6; k++) out[k] = k < 4 ? 0.5 * (r0[k] + r1[k]) : (1 - xi) * r0[k] + xi * r1[k];
  };
  // per member: the section forces and the peak stress at the section's corners
  const rr = new Float64Array(6);
  const memberOut: BeamMemberResult[] = mems
    .map((m) => {
      let axial = 0,
        shear = 0,
        torque = 0,
        moment = 0,
        stress = 0;
      let at: V3 = m.a;
      for (const ei of m.els) {
        const e = els[ei];
        for (const xi of [0, 1]) {
          rAt(ei, xi, rr);
          if (Math.abs(rr[0]) > Math.abs(axial)) axial = rr[0];
          shear = Math.max(shear, Math.hypot(rr[1], rr[2]));
          torque = Math.max(torque, Math.abs(rr[3]));
          moment = Math.max(moment, Math.hypot(rr[4], rr[5]));
          // the corners, and the neutral axis where shear peaks
          for (const [y, z] of [...m.corners, [0, 0] as [number, number]]) {
            const v = vmAt(m, rr, y, z).vm;
            if (v > stress) {
              stress = v;
              at = add(xi ? nodePos[e.n1] : nodePos[e.n0], add(scale(e.ey, y + m.cy), scale(e.ez, z + m.cz)));
            }
          }
        }
      }
      return { part: m.name, length: m.L, axial, shear, torque, moment, stress, at, safety: stress > 0 ? Math.min(allow[m.mat].value / stress, 1e6) : 1e6 };
    })
    .filter((_, i) => mems[i].els.length > 0);

  // ---- fields on the members' meshes ----
  const ranges: StructuralResult["ranges"] = { stress: [Infinity, -Infinity], disp: [0, 0], strain: [Infinity, -Infinity], safety: [Infinity, -Infinity] };
  let maxDisp = { value: 0, at: [0, 0, 0] as V3 };
  let maxStress = { value: 0, at: [0, 0, 0] as V3 };
  let maxStrain = { value: 0, at: [0, 0, 0] as V3 };
  let minSafety: SafetyAt = { value: Infinity, at: [0, 0, 0], mode: allow[0].basis, allowable: allow[0].value, material: inp.materials[0].name };
  const memOfPart = new Map<number, number>();
  mems.forEach((m, i) => memOfPart.set(m.part, i));
  /** where a point sits on a member: the nearest of its elements and how far along it */
  const locate = (m: Mem, p: V3): { ei: number; xi: number } => {
    let best = { ei: m.els[0], xi: 0, d: Infinity };
    for (const ei of m.els) {
      const e = els[ei];
      const p0 = nodePos[e.n0];
      const t = Math.max(0, Math.min(1, dot(sub(p, p0), e.ex) / e.L));
      const q = add(p0, scale(e.ex, t * e.L));
      const dd = len(sub(p, q));
      if (dd < best.d - 1e-9) best = { ei, xi: t, d: dd };
    }
    return best;
  };
  /** the displacement of a point of a member at (ei, xi) offset r across it, from a field of node DOFs, in world axes */
  const dispAt = (ei: number, xi: number, ry: number, rz: number, field: Float64Array, out: Float64Array) => {
    const e = els[ei];
    const d = dofsOf(e);
    for (let i = 0; i < 12; i++) dw[i] = field[d[i]];
    toLocal(e, dw, dl);
    const L = e.L;
    const N1 = 1 - 3 * xi * xi + 2 * xi ** 3,
      N2 = xi - 2 * xi * xi + xi ** 3,
      N3 = 3 * xi * xi - 2 * xi ** 3,
      N4 = -xi * xi + xi ** 3;
    const D1 = -6 * xi + 6 * xi * xi,
      D2 = 1 - 4 * xi + 3 * xi * xi,
      D3 = 6 * xi - 6 * xi * xi,
      D4 = -2 * xi + 3 * xi * xi;
    const ux = (1 - xi) * dl[0] + xi * dl[6];
    const uy = N1 * dl[1] + N2 * L * dl[5] + N3 * dl[7] + N4 * L * dl[11];
    const uz = N1 * dl[2] - N2 * L * dl[4] + N3 * dl[8] - N4 * L * dl[10];
    const tx = (1 - xi) * dl[3] + xi * dl[9];
    const tz = (D1 * dl[1] + D2 * L * dl[5] + D3 * dl[7] + D4 * L * dl[11]) / L;
    const ty = -(D1 * dl[2] - D2 * L * dl[4] + D3 * dl[8] - D4 * L * dl[10]) / L;
    // the point turns with the section: θ × (0, ry, rz)
    const lx = ux + ty * rz - tz * ry,
      ly = uy - tx * rz,
      lz = uz + tx * ry;
    for (let k = 0; k < 3; k++) out[k] = e.ex[k] * lx + e.ey[k] * ly + e.ez[k] * lz;
  };
  const tmp = new Float64Array(3);
  const partsOut: PartField[] = inp.parts.map((p, pi) => {
    const mi = memOfPart.get(pi);
    const P = p.mesh.positions;
    const nv = P.length / 3;
    const disp = new Float32Array(3 * nv),
      stress = new Float32Array(nv),
      strain = new Float32Array(nv),
      safety = new Float32Array(nv).fill(1e6);
    if (mi !== undefined && mems[mi].els.length) {
      const m = mems[mi];
      const al = allow[m.mat].value;
      for (let v = 0; v < nv; v++) {
        const q: V3 = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
        const { ei, xi } = locate(m, q);
        const e = els[ei];
        const c = add(nodePos[e.n0], scale(e.ex, xi * e.L));
        const off = sub(q, c);
        const ry = dot(off, e.ey),
          rz = dot(off, e.ez);
        dispAt(ei, xi, ry, rz, U, tmp);
        disp[3 * v] = tmp[0];
        disp[3 * v + 1] = tmp[1];
        disp[3 * v + 2] = tmp[2];
        rAt(ei, xi, rr);
        const { vm, sx } = vmAt(m, rr, ry - m.cy, rz - m.cz);
        stress[v] = vm;
        strain[v] = sx / m.E;
        safety[v] = vm > 0 ? Math.min(al / vm, 1e6) : 1e6;
        const dm = Math.hypot(tmp[0], tmp[1], tmp[2]);
        if (dm > maxDisp.value) maxDisp = { value: dm, at: q };
        if (vm > maxStress.value) maxStress = { value: vm, at: q };
        if (Math.abs(strain[v]) > Math.abs(maxStrain.value)) maxStrain = { value: strain[v], at: q };
        if (safety[v] < minSafety.value) minSafety = { value: safety[v], at: q, mode: allow[m.mat].basis, allowable: al, material: inp.materials[m.mat].name };
      }
    }
    for (let v = 0; v < nv; v++) {
      ranges.disp[1] = Math.max(ranges.disp[1], Math.hypot(disp[3 * v], disp[3 * v + 1], disp[3 * v + 2]));
      ranges.stress[0] = Math.min(ranges.stress[0], stress[v]);
      ranges.stress[1] = Math.max(ranges.stress[1], stress[v]);
      ranges.strain[0] = Math.min(ranges.strain[0], strain[v]);
      ranges.strain[1] = Math.max(ranges.strain[1], strain[v]);
      ranges.safety[0] = Math.min(ranges.safety[0], safety[v]);
      ranges.safety[1] = Math.max(ranges.safety[1], safety[v]);
    }
    return { id: p.id, name: p.name, positions: Float32Array.from(P), normals: p.normals ?? null, indices: p.mesh.indices, disp, stress, strain, safety };
  });
  // the section corners can peak between mesh vertices: the members' own peaks count too
  for (const mo of memberOut) {
    if (mo.stress > maxStress.value) maxStress = { value: mo.stress, at: mo.at };
    const m = mems.find((x) => x.name === mo.part)!;
    if (mo.safety < minSafety.value) minSafety = { value: mo.safety, at: mo.at, mode: allow[m.mat].basis, allowable: allow[m.mat].value, material: inp.materials[m.mat].name };
  }
  // the beam nodes' own movement (a mesh may be coarser than the bending shape)
  for (let n = 0; n < nn; n++) {
    const dm = Math.hypot(U[6 * n], U[6 * n + 1], U[6 * n + 2]);
    if (dm > maxDisp.value) maxDisp = { value: dm, at: nodePos[n] };
  }
  ranges.disp[1] = Math.max(ranges.disp[1], maxDisp.value);
  const hotSpots = [...memberOut]
    .sort((a, b) => b.stress - a.stress)
    .slice(0, 5)
    .filter((h) => h.stress > 0)
    .map((h) => ({ at: h.at, stress: h.stress, safety: h.safety }));
  const tPost = now();

  // ---- buckling: K + λ·Kg singular, Kg from the members' axial forces ----
  let buckling: BucklingResult | undefined;
  let beamBuckling: BeamResult["buckling"];
  const pushed = memberOut.some((m) => m.axial < -1e-6 * Math.max(1, ...memberOut.map((x) => Math.abs(x.axial))));
  const loaded = inp.loads.length > 0 || !!inp.accel;
  if (pushed && loaded) {
    progress("Beams: buckling", 0.75);
    const tb = now();
    const want = Math.max(1, inp.buckling?.modes ?? 1);
    const Kg = new Skyline(neq, top);
    for (let ei = 0; ei < ne; ei++) {
      const e = els[ei];
      const N = 0.5 * (res0[ei][0] + res1[ei][0]);
      const kg = toWorld(localKg(mems[e.m], e.L, N), e);
      const d = dofsOf(e);
      for (let i = 0; i < 12; i++) {
        const gi = eq[d[i]];
        if (gi < 0) continue;
        for (let j = 0; j < 12; j++) {
          const gj = eq[d[j]];
          if (gj >= gi && kg[12 * i + j] !== 0) Kg.add(gi, gj, kg[12 * i + j]);
        }
      }
    }
    // subspace iteration on K⁻¹(−Kg): its largest μ is 1/λ of the lowest buckling factor
    const q = Math.min(neq, 2 * want + 6);
    const dotv = (a: Float64Array, b: Float64Array) => {
      let t = 0;
      for (let j = 0; j < neq; j++) t += a[j] * b[j];
      return t;
    };
    const seed = (i: number) => {
      const v = new Float64Array(neq);
      for (let j = 0; j < neq; j++) v[j] = Math.sin(1.3 * (j + 1) * (i + 1) + 0.4 * i) + 0.3 * Math.cos(0.7 * j * (i + 1) + i);
      return v;
    };
    let X: Float64Array[] = [...Array(q).keys()].map(seed);
    let seeds = q;
    const tmpV = new Float64Array(neq);
    let mus: number[] = [];
    let prev: number[] = [];
    let iterations = 0;
    let converged = false;
    for (; iterations < 100; iterations++) {
      // Y = K⁻¹(−Kg X), keeping K Y = −Kg X
      const Q: Float64Array[] = [],
        KQ: Float64Array[] = [];
      for (const xv of X) {
        Kg.mul(xv, tmpV);
        const ky = new Float64Array(neq);
        for (let j = 0; j < neq; j++) ky[j] = -tmpV[j];
        const y = Float64Array.from(ky);
        K.solve(y);
        // made K-orthonormal to the ones before (twice, for round-off); a vector that adds nothing is dropped
        const n0 = dotv(y, ky);
        for (let pass = 0; pass < 2; pass++)
          for (let j = 0; j < Q.length; j++) {
            const c = dotv(KQ[j], y);
            for (let t = 0; t < neq; t++) {
              y[t] -= c * Q[j][t];
              ky[t] -= c * KQ[j][t];
            }
          }
        const nn2 = dotv(y, ky);
        if (!(nn2 > 1e-12 * Math.abs(n0)) || !(nn2 > 0)) continue;
        const sc = 1 / Math.sqrt(nn2);
        for (let t = 0; t < neq; t++) {
          y[t] *= sc;
          ky[t] *= sc;
        }
        Q.push(y);
        KQ.push(ky);
      }
      const qq = Q.length;
      if (!qq) break;
      // Rayleigh–Ritz in the K-orthonormal basis: Qᵀ(−Kg)Q z = μ z
      const Ar = new Float64Array(qq * qq);
      for (let j = 0; j < qq; j++) {
        Kg.mul(Q[j], tmpV);
        for (let i = 0; i <= j; i++) Ar[i * qq + j] = Ar[j * qq + i] = -dotv(Q[i], tmpV);
      }
      const { val, V } = jacobi(Ar, qq);
      const idx = [...val.keys()].sort((a, b) => val[b] - val[a]);
      mus = idx.map((i) => val[i]);
      X = idx.map((ci) => {
        const v = new Float64Array(neq);
        for (let a = 0; a < qq; a++) {
          const za = V[a * qq + ci];
          if (za === 0) continue;
          const y = Q[a];
          for (let t = 0; t < neq; t++) v[t] += za * y[t];
        }
        let mx = 0;
        for (let t = 0; t < neq; t++) mx = Math.max(mx, Math.abs(v[t]));
        if (mx > 0) for (let t = 0; t < neq; t++) v[t] /= mx;
        return v;
      });
      // vectors dropped as dependent come back as fresh ones
      while (X.length < q) X.push(seed(seeds++));
      const pos = mus.filter((m) => m > 0).slice(0, want);
      if (prev.length === pos.length && pos.every((m, i) => Math.abs(m - prev[i]) <= 1e-9 * Math.abs(m)) && (pos.length || iterations > 8)) {
        converged = true;
        iterations++;
        break;
      }
      prev = pos;
    }
    const factors = mus.filter((m) => m > 0).slice(0, want).map((m) => 1 / m);
    const neg = mus.filter((m) => m < 0);
    const reversed = neg.length ? 1 / -Math.min(...neg) : null;
    // the shapes on the members, and where each moves most
    const shapes = X.slice(0, factors.length).map((v) => {
      const full = new Float64Array(6 * nn);
      for (let g = 0; g < 6 * nn; g++) full[g] = eq[g] >= 0 ? v[eq[g]] : 0;
      return full;
    });
    const peaks: V3[] = [];
    for (const sh of shapes) {
      let best = 0,
        at: V3 = [0, 0, 0],
        bm = "";
      for (let n = 0; n < nn; n++) {
        const dm = Math.hypot(sh[6 * n], sh[6 * n + 1], sh[6 * n + 2]);
        if (dm > best) {
          best = dm;
          at = nodePos[n];
          bm = memOfNode[n].map((mi) => mems[mi].name)[0] ?? "";
        }
      }
      peaks.push(at);
      if (!beamBuckling && factors.length) beamBuckling = { factor: factors[0], member: bm };
    }
    if (inp.buckling) {
      buckling = { factors, peaks, reversed, iterations, converged, ms: now() - tb };
      // the buckled shapes on the meshes, scaled so the largest movement is 1
      partsOut.forEach((pf, pi) => {
        const mi = memOfPart.get(pi);
        if (mi === undefined || !mems[mi].els.length) return;
        const m = mems[mi];
        const P = pf.positions;
        const nv = P.length / 3;
        pf.modes = shapes.map((sh) => {
          let mx = 0;
          for (let n = 0; n < nn; n++) mx = Math.max(mx, Math.hypot(sh[6 * n], sh[6 * n + 1], sh[6 * n + 2]));
          const out = new Float32Array(3 * nv);
          for (let v = 0; v < nv; v++) {
            const q: V3 = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
            const { ei, xi } = locate(m, q);
            const e = els[ei];
            const off = sub(q, add(nodePos[e.n0], scale(e.ex, xi * e.L)));
            dispAt(ei, xi, dot(off, e.ey), dot(off, e.ez), sh, tmp);
            for (let k = 0; k < 3; k++) out[3 * v + k] = mx > 0 ? tmp[k] / mx : 0;
          }
          return out;
        });
      });
    } else if (beamBuckling && beamBuckling.factor < 3)
      warnings.push(
        `The frame would buckle at ${beamBuckling.factor.toFixed(2)}× these loads (${beamBuckling.member} moves most): pushed members that slender bow out sideways long before they crush. Add buckling to the analysis to see the shape, and brace or thicken ${beamBuckling.member}.`,
      );
  }

  // ---- notes ----
  const secs = [...new Set(mems.map((m) => m.sec.estimated).filter((s): s is string => !!s))];
  notes.push(`${nm} member${nm === 1 ? "" : "s"} as beams through their centre lines (${ne} elements), joined rigidly at ${joints} joint${joints === 1 ? "" : "s"} as welds are`);
  if (mems.some((m) => m.sec.kind === "extrusion")) notes.push("bolted extrusion corners with brackets give a little at the joints, so the real frame bends somewhat more than this");
  if (mems.some((m) => m.sec.kind === "angle")) notes.push("angles are taken at their centroid and principal axes, so loads off their centroid twist them less than in reality");
  notes.push(...secs);
  if (residual > 1e-6) warnings.push(`The beam solve left a residual of ${residual.toExponential(1)}; the frame may be close to moving freely somewhere.`);

  const hAvg = els.reduce((t, e) => t + e.L, 0) / ne;
  const materials = inp.materials.map((m: MechMaterial, i) => ({ name: m.name, E: m.E, yield: m.yield, allowable: allow[i].value, basis: allow[i].basis, layerFactor: m.layerFactor, assumed: !!m.assumed }));
  const tEnd = now();
  progress("Beams: done", 1);
  return {
    label: inp.label,
    mesh: { h: hAvg, cell: [hAvg, hAvg, hAvg], grid: [ne, 0, 0], elements: ne, nodes: nn, dofs: neq, levels: 0, partial: 0 },
    solve: { iterations: 1, residual, converged: residual < 1e-6, history: [residual], ms: { mesh: tMesh - t0, setup: tSetup - tMesh, solve: tSolve - tSetup, post: tPost - tSolve, total: tEnd - t0 } },
    maxDisp,
    maxStress: { ...maxStress, nearBoundary: false, away: null },
    maxStrain,
    minSafety: { ...minSafety, value: Number.isFinite(minSafety.value) ? minSafety.value : 1e6, nearBoundary: false, away: null },
    layer: null,
    hotSpots,
    applied,
    reaction,
    equilibrium,
    mass: massKg * 1000,
    volume,
    loads: loadsOut,
    supports: supportsOut,
    gravity,
    parts: partsOut,
    ranges,
    warnings,
    materials,
    ...(buckling ? { buckling } : {}),
    beams: { members: memberOut, elements: ne, nodes: nn, joints, ...(beamBuckling ? { buckling: beamBuckling } : {}), notes },
  };
}
