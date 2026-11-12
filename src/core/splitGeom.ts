// Where a split part is cut and where its pins go, worked out from the part's
// mesh as built: the extent along each cut direction, the fewest pieces that
// fit the machine (the envelope check's own test), and for each joint the
// spots where a pin's hole has solid material all round it for its whole
// depth in both pieces, as far apart as the joint allows. Each joint is
// sliced from the mesh at the cut and at the depths the holes reach, filled
// on a raster and given a distance transform, so the clearance of every spot
// to the nearest wall is read off directly. Pure geometry; no kernel calls.

import type { MeshData } from "../kernel/build";
import type { V3 } from "../kernel/recipe";
import { DOWEL_SIZES, axisFrame, axisWord, dowelLength, pinDepth, pinHoleClearance, splitPrinted, type SplitCell, type SplitInfo, type SplitJoint, type SplitQuery, type SplitSpec } from "../lang/split";
import type { Model } from "./model";
import { rulesOnMachine } from "../mfg/report";
import { envelopeFit } from "../mfg/analyze";
import { NO_MACHINES, type MachineContext } from "../mfg/machines";

export interface SplitEnv {
  size: V3;
  frame: V3 | null;
  what: string;
}

export interface SplitOptions {
  /** the part is printed (holes a little over the pin; thicker walls round them) */
  printed: boolean;
  /** the machine the pieces must fit, when a direction is left to the bed */
  env?: SplitEnv | null;
  /** the envelope check's test of a piece's extent */
  fits?: (ext: V3) => boolean;
}

const fmt = (n: number, d = 1) => String(+n.toFixed(d));

interface AxisData {
  n: V3;
  u: V3;
  v: V3;
  /** every vertex along n, u and v */
  pn: Float64Array;
  pu: Float64Array;
  pv: Float64Array;
  lo: number;
  hi: number;
}

function axisData(P: Float32Array, dir: V3): AxisData {
  const { u, v, n } = axisFrame(dir);
  const N = P.length / 3;
  const pn = new Float64Array(N);
  const pu = new Float64Array(N);
  const pv = new Float64Array(N);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const x = P[3 * i];
    const y = P[3 * i + 1];
    const z = P[3 * i + 2];
    pn[i] = x * n[0] + y * n[1] + z * n[2];
    pu[i] = x * u[0] + y * u[1] + z * u[2];
    pv[i] = x * v[0] + y * v[1] + z * v[2];
    if (pn[i] < lo) lo = pn[i];
    if (pn[i] > hi) hi = pn[i];
  }
  return { n, u, v, pn, pu, pv, lo, hi };
}

/** Where the plane along the axis at t cuts the mesh: segments (u1, v1, u2, v2) in the plane's coordinates. */
function slice(I: Uint32Array, ax: AxisData, t: number): Float64Array {
  const out: number[] = [];
  const { pn, pu, pv } = ax;
  for (let k = 0; k + 2 < I.length; k += 3) {
    const a = I[k];
    const b = I[k + 1];
    const c = I[k + 2];
    // a vertex on the plane counts as above it, so every crossing triangle has exactly two crossing edges
    const da = pn[a] - t;
    const db = pn[b] - t;
    const dc = pn[c] - t;
    const sa = da >= 0;
    const sb = db >= 0;
    const sc = dc >= 0;
    if (sa === sb && sb === sc) continue;
    const pts: number[] = [];
    const edge = (i: number, j: number, di: number, dj: number) => {
      const f = di / (di - dj);
      pts.push(pu[i] + f * (pu[j] - pu[i]), pv[i] + f * (pv[j] - pv[i]));
    };
    if (sa !== sb) edge(a, b, da, db);
    if (sb !== sc) edge(b, c, db, dc);
    if (sc !== sa) edge(c, a, dc, da);
    if (pts.length === 4) out.push(pts[0], pts[1], pts[2], pts[3]);
  }
  return Float64Array.from(out);
}

/** A cell's limits on the other cut directions, as linear limits lo ≤ k0 + ka·a + kb·b ≤ hi in a plane's (a, b). */
interface Limit {
  k0: number;
  ka: number;
  kb: number;
  lo: number;
  hi: number;
}

function limitsFor(axes: AxisData[], me: number, t: number, ranges: [number, number][]): Limit[] {
  const A = axes[me];
  const out: Limit[] = [];
  axes.forEach((B, i) => {
    if (i === me) return;
    const [lo, hi] = ranges[i];
    if (!Number.isFinite(lo) && !Number.isFinite(hi)) return;
    const d = (x: V3) => x[0] * B.n[0] + x[1] * B.n[1] + x[2] * B.n[2];
    out.push({ k0: t * d(A.n), ka: d(A.u), kb: d(A.v), lo, hi });
  });
  return out;
}

interface Raster {
  a0: number;
  b0: number;
  h: number;
  W: number;
  H: number;
}

/** Inside (1) or outside (0) of the sliced section on a raster, by the even-odd rule along each row, inside the cell's limits. */
function fill(seg: Float64Array, r: Raster, limits: Limit[]): Uint8Array {
  const { a0, b0, h, W, H } = r;
  const rows: number[][] = Array.from({ length: H }, () => []);
  for (let k = 0; k + 3 < seg.length; k += 4) {
    let a1 = seg[k];
    let b1 = seg[k + 1];
    let a2 = seg[k + 2];
    let b2 = seg[k + 3];
    if (b1 === b2) continue;
    if (b1 > b2) [a1, b1, a2, b2] = [a2, b2, a1, b1];
    // rows whose centre y is in [b1, b2)
    const j0 = Math.max(0, Math.ceil((b1 - b0) / h - 0.5));
    const j1 = Math.min(H - 1, Math.ceil((b2 - b0) / h - 0.5) - 1);
    for (let j = j0; j <= j1; j++) {
      const y = b0 + (j + 0.5) * h;
      rows[j].push(a1 + ((y - b1) * (a2 - a1)) / (b2 - b1));
    }
  }
  const m = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const xs = rows[j].sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - a0) / h - 0.5));
      const i1 = Math.min(W - 1, Math.ceil((xs[k + 1] - a0) / h - 0.5) - 1);
      for (let i = i0; i <= i1; i++) m[j * W + i] = 1;
    }
  }
  if (limits.length)
    for (let j = 0; j < H; j++) {
      const b = b0 + (j + 0.5) * h;
      for (let i = 0; i < W; i++) {
        if (!m[j * W + i]) continue;
        const a = a0 + (i + 0.5) * h;
        for (const l of limits) {
          const x = l.k0 + l.ka * a + l.kb * b;
          if (x < l.lo || x > l.hi) {
            m[j * W + i] = 0;
            break;
          }
        }
      }
    }
  return m;
}

/** Squared distance transform of one line (Felzenszwalb and Huttenlocher), in place. */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Each inside pixel's distance to the nearest outside one, mm (less half a pixel, so it errs short). */
function clearance(m: Uint8Array, r: Raster): Float64Array {
  const { W, H, h } = r;
  // large but finite: differences of two of them stay exact enough for the envelope of parabolas
  const BIG = 1e12;
  const g = new Float64Array(W * H);
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < H; j++) f[j] = m[j * W + i] ? BIG : 0;
    dt1(f, H, d, v, z);
    for (let j = 0; j < H; j++) g[j * W + i] = d[j];
  }
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) f[i] = g[j * W + i];
    dt1(f, W, d, v, z);
    for (let i = 0; i < W; i++) g[j * W + i] = m[j * W + i] ? Math.max(0, (Math.sqrt(d[i]) - 0.5) * h) : 0;
  }
  return g;
}

/** Nearest distance from (a, b) to any segment, mm. */
function segDistance(seg: Float64Array, a: number, b: number): number {
  let best = Infinity;
  for (let k = 0; k + 3 < seg.length; k += 4) {
    const x1 = seg[k];
    const y1 = seg[k + 1];
    const dx = seg[k + 2] - x1;
    const dy = seg[k + 3] - y1;
    const L = dx * dx + dy * dy;
    const s = L > 0 ? Math.max(0, Math.min(1, ((a - x1) * dx + (b - y1) * dy) / L)) : 0;
    const ex = x1 + s * dx - a;
    const ey = y1 + s * dy - b;
    const q = ex * ex + ey * ey;
    if (q < best) best = q;
  }
  return Math.sqrt(best);
}

function limitDistance(limits: Limit[], a: number, b: number): number {
  let best = Infinity;
  for (const l of limits) {
    const g = Math.hypot(l.ka, l.kb);
    if (g < 1e-9) continue;
    const x = l.k0 + l.ka * a + l.kb * b;
    best = Math.min(best, (x - l.lo) / g, (l.hi - x) / g);
  }
  return best;
}

/** One joint's clearance map: the least room at the cut and at the depths the holes reach on both sides. */
interface JointMap {
  r: Raster;
  /** clearance at each pixel, mm (0 outside) */
  c: Float64Array;
  /** the section at the cut, for checking spots exactly */
  seg: Float64Array;
  limits: Limit[];
  area: number;
  room: number;
  /** material at the cut at all */
  any: boolean;
}

function jointMap(I: Uint32Array, axes: AxisData[], me: number, t: number, depth: number, cell: [number, number][]): JointMap {
  const seg = slice(I, axes[me], t);
  const limits = limitsFor(axes, me, t, cell);
  let a0 = Infinity;
  let a1 = -Infinity;
  let b0 = Infinity;
  let b1 = -Infinity;
  for (let k = 0; k + 1 < seg.length; k += 2) {
    a0 = Math.min(a0, seg[k]);
    a1 = Math.max(a1, seg[k]);
    b0 = Math.min(b0, seg[k + 1]);
    b1 = Math.max(b1, seg[k + 1]);
  }
  const empty: JointMap = { r: { a0: 0, b0: 0, h: 1, W: 0, H: 0 }, c: new Float64Array(0), seg, limits, area: 0, room: 0, any: false };
  if (!Number.isFinite(a0)) return empty;
  const size = Math.max(a1 - a0, b1 - b0);
  const h = Math.max(0.12, size / 480);
  const pad = 2 * h;
  const W = Math.ceil((a1 - a0 + 2 * pad) / h);
  const H = Math.ceil((b1 - b0 + 2 * pad) / h);
  const r: Raster = { a0: a0 - pad, b0: b0 - pad, h, W, H };
  const at = fill(seg, r, limits);
  let area = 0;
  for (let i = 0; i < at.length; i++) area += at[i];
  if (!area) return { ...empty, r };
  const c = clearance(at, r);
  // the holes go depth into each piece: the material must be there all the way
  for (const dt of [-depth, -depth / 2, depth / 2, depth]) {
    const s = slice(I, axes[me], t + dt);
    const m = fill(s, r, limitsFor(axes, me, t + dt, cell));
    const cc = clearance(m, r);
    for (let i = 0; i < c.length; i++) if (cc[i] < c[i]) c[i] = cc[i];
  }
  let room = 0;
  for (let i = 0; i < c.length; i++) if (c[i] > room) room = c[i];
  return { r, c, seg, limits, area: area * h * h, room, any: true };
}

/** Up to n spots at least `need` from every wall and `gap` apart, spread as far as the joint allows. */
function pickSpots(j: JointMap, need: number, n: number, gap: number): [number, number][] {
  if (!j.any || n <= 0) return [];
  const { r, c } = j;
  // a little more wall than the least where the joint has room for it
  const want = need + Math.min(1, Math.max(0, 0.25 * (j.room - need)));
  const cand: [number, number, number][] = [];
  for (let jj = 0; jj < r.H; jj++)
    for (let i = 0; i < r.W; i++) {
      const v = c[jj * r.W + i];
      if (v >= want) cand.push([r.a0 + (i + 0.5) * r.h, r.b0 + (jj + 0.5) * r.h, v]);
    }
  if (!cand.length) return [];
  const ok = (p: [number, number, number]) => segDistance(j.seg, p[0], p[1]) >= need - 0.05 && limitDistance(j.limits, p[0], p[1]) >= need - 0.05;
  const out: [number, number][] = [];
  if (n === 1) {
    // one pin: the most central spot
    const best = [...cand].sort((p, q) => q[2] - p[2]).find(ok);
    return best ? [[best[0], best[1]]] : [];
  }
  let ca = 0;
  let cb = 0;
  for (const p of cand) {
    ca += p[0];
    cb += p[1];
  }
  ca /= cand.length;
  cb /= cand.length;
  const dist = new Float64Array(cand.length);
  for (let i = 0; i < cand.length; i++) dist[i] = Math.hypot(cand[i][0] - ca, cand[i][1] - cb) + 1e-6 * cand[i][2];
  const used = new Uint8Array(cand.length);
  while (out.length < n) {
    let bi = -1;
    for (let i = 0; i < cand.length; i++) if (!used[i] && (bi < 0 || dist[i] > dist[bi])) bi = i;
    if (bi < 0) break;
    used[bi] = 1;
    const p = cand[bi];
    if (out.length && dist[bi] < gap) break;
    if (!ok(p)) continue;
    out.push([p[0], p[1]]);
    for (let i = 0; i < cand.length; i++) {
      const d = Math.hypot(cand[i][0] - p[0], cand[i][1] - p[1]);
      // the first spot was the farthest from the middle; from now on the farthest from the spots so far
      dist[i] = out.length === 1 ? d : Math.min(dist[i], d);
    }
  }
  return out;
}

interface CellBox {
  lo: V3;
  hi: V3;
  any: boolean;
}

const emptyBox = (): CellBox => ({ lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], any: false });
function grow(b: CellBox, p: V3) {
  for (let k = 0; k < 3; k++) {
    if (p[k] < b.lo[k]) b.lo[k] = p[k];
    if (p[k] > b.hi[k]) b.hi[k] = p[k];
  }
  b.any = true;
}

/** Which interval of the cuts x falls in. */
function band(cuts: number[], x: number): number {
  let k = 0;
  while (k < cuts.length && x >= cuts[k]) k++;
  return k;
}

/** Strides of a grid of cells, last axis fastest. */
function strides(counts: number[]): number[] {
  const s = new Array(counts.length).fill(1);
  for (let i = counts.length - 2; i >= 0; i--) s[i] = s[i + 1] * counts[i + 1];
  return s;
}

/** The box of every cell of the cuts, from the vertices in it and where the cut planes cross the mesh. */
function cellBoxes(P: Float32Array, I: Uint32Array, axes: AxisData[], cuts: number[][]): CellBox[] {
  const counts = cuts.map((c) => c.length + 1);
  const st = strides(counts);
  const total = counts.reduce((x, y) => x * y, 1);
  const boxes = Array.from({ length: total }, emptyBox);
  const N = P.length / 3;
  for (let i = 0; i < N; i++) {
    let idx = 0;
    for (let a = 0; a < axes.length; a++) idx += st[a] * band(cuts[a], axes[a].pn[i]);
    grow(boxes[idx], [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
  }
  // the cut faces bound the cells on either side
  axes.forEach((A, a) => {
    cuts[a].forEach((t, c) => {
      const seg = slice(I, A, t);
      for (let k = 0; k + 1 < seg.length; k += 2) {
        const p: V3 = [
          A.n[0] * t + A.u[0] * seg[k] + A.v[0] * seg[k + 1],
          A.n[1] * t + A.u[1] * seg[k] + A.v[1] * seg[k + 1],
          A.n[2] * t + A.u[2] * seg[k] + A.v[2] * seg[k + 1],
        ];
        let idx = 0;
        for (let b = 0; b < axes.length; b++) if (b !== a) idx += st[b] * band(cuts[b], p[0] * axes[b].n[0] + p[1] * axes[b].n[1] + p[2] * axes[b].n[2]);
        grow(boxes[idx + st[a] * c], p);
        grow(boxes[idx + st[a] * (c + 1)], p);
      }
    });
  });
  return boxes;
}

const ext = (b: CellBox): V3 => [b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]];

/** Equal cuts over [lo, hi] into n pieces. */
const equalCuts = (lo: number, hi: number, n: number) => Array.from({ length: n - 1 }, (_, i) => lo + ((i + 1) * (hi - lo)) / n);

/**
 * Where to cut a part and where its pins go, from its mesh (part coordinates): cuts given at: are kept where they
 * fall inside the part, count: cuts it equally, and a direction with neither gets the fewest pieces that fit
 * the machine. Pins go where their holes have solid material round them in both pieces.
 */
export function computeSplit(mesh: MeshData, spec: SplitSpec, opts: SplitOptions): SplitInfo {
  const P = mesh.positions;
  const I = mesh.indices;
  const warnings: string[] = [];
  const none = (error: string): SplitInfo => ({ cuts: [], range: [], across: [], cells: [], joints: [], pin: 0, length: 0, warnings, error });
  if (!P.length || !I.length) return none("the part has no shape to cut");
  const axes = spec.axes.map((a) => axisData(P, a.dir));
  const range = axes.map((a) => [a.lo, a.hi] as [number, number]);
  const across = axes.map((A) => {
    let ua = Infinity;
    let ub = -Infinity;
    let va = Infinity;
    let vb = -Infinity;
    for (let i = 0; i < A.pu.length; i++) {
      ua = Math.min(ua, A.pu[i]);
      ub = Math.max(ub, A.pu[i]);
      va = Math.min(va, A.pv[i]);
      vb = Math.max(vb, A.pv[i]);
    }
    return [
      [ua, ub],
      [va, vb],
    ] as [[number, number], [number, number]];
  });

  // ---- the cuts ----
  const cuts: number[][] = spec.axes.map((a, i) => {
    const { lo, hi } = axes[i];
    const w = axisWord(a.dir);
    if (a.at) {
      const inside = a.at.filter((t) => t > lo + 1 && t < hi - 1);
      const out = a.at.filter((t) => !(t > lo + 1 && t < hi - 1));
      if (out.length) warnings.push(`the cut${out.length > 1 ? "s" : ""} at ${w} = ${out.map((t) => fmt(t)).join(", ")} ${out.length > 1 ? "miss" : "misses"} the part, which runs from ${fmt(lo)} to ${fmt(hi)} along ${w}: left out`);
      return inside;
    }
    if (a.count) return equalCuts(lo, hi, a.count);
    return [];
  });
  const auto = spec.axes.map((a, i) => (!a.at && !a.count ? i : -1)).filter((i) => i >= 0);
  let bed: SplitInfo["bed"];
  if (auto.length) {
    if (!opts.env || !opts.fits) return none(`the part has no machine to fit (give it a process such as mfg.fdm()), so say where to cut it: pieces(${axisWord(spec.axes[auto[0]].dir).toUpperCase()}, at: [..]) or pieces(..., count: 2)`);
    bed = { size: opts.env.size, what: opts.env.what };
    // the fewest pieces in all, trying more cuts across the directions left to the bed
    const tries: number[][] = [];
    const MAX = 12;
    const rec = (k: number, acc: number[]) => {
      if (k === auto.length) return void tries.push(acc);
      for (let n = 1; n <= MAX; n++) rec(k + 1, [...acc, n]);
    };
    rec(0, []);
    tries.sort((x, y) => x.reduce((p, q) => p * q, 1) - y.reduce((p, q) => p * q, 1) || Math.max(...x) - Math.max(...y));
    let found = false;
    for (const t of tries) {
      const c = cuts.map((x) => [...x]);
      auto.forEach((ai, k) => (c[ai] = equalCuts(axes[ai].lo, axes[ai].hi, t[k])));
      const boxes = cellBoxes(P, I, axes, c);
      if (boxes.every((b) => !b.any || opts.fits!(ext(b)))) {
        auto.forEach((ai) => (cuts[ai] = c[ai]));
        found = true;
        break;
      }
    }
    if (!found) return none(`even ${MAX} pieces across ${auto.map((i) => axisWord(spec.axes[i].dir)).join(" and ")} do not fit the ${opts.env.what} (${opts.env.size.map((x) => fmt(x, 0)).join(" × ")} mm): cut it across another direction too, like split: [X, Y]`);
  }
  if (cuts.every((c) => !c.length)) {
    if (bed) {
      const b = cellBoxes(P, I, axes, cuts)[0];
      return { cuts, range, across, cells: [{ index: cuts.map(() => 0), box: [b.lo, b.hi] }], joints: [], pin: 0, length: 0, bed, warnings: [`it fits the ${bed.what} in one piece, so it is not cut`] };
    }
    return none("there is nothing to cut: every cut misses the part");
  }

  // ---- the pins ----
  const pinned = spec.join === "dowel" || spec.join === "printed";
  const clr = pinHoleClearance(spec.join, opts.printed);
  const wallFor = (d: number) => (opts.printed ? 1.6 : 1) + 0.1 * d;
  // the widest pin whose hole leaves wallFor(d) of material all round, in a joint with this much room
  const widest = (room: number) => Math.max(0, (2 * room - clr - 2 * (opts.printed ? 1.6 : 1)) / 1.2);
  // the joints, each a cut between two neighbouring cells
  const counts = cuts.map((c) => c.length + 1);
  const st = strides(counts);
  const total = counts.reduce((x, y) => x * y, 1);
  const indexOf = (cell: number) => counts.map((n, a) => Math.floor(cell / st[a]) % n);
  const intervals = (idx: number[]): [number, number][] => idx.map((k, a) => [k === 0 ? -Infinity : cuts[a][k - 1], k === counts[a] - 1 ? Infinity : cuts[a][k]]);
  const pairs: { axis: number; cut: number; below: number; above: number }[] = [];
  for (let cell = 0; cell < total; cell++) {
    const idx = indexOf(cell);
    idx.forEach((k, a) => {
      if (k < counts[a] - 1) pairs.push({ axis: a, cut: k, below: cell, above: cell + st[a] });
    });
  }
  // thickness of a cell along an axis, for holes from both of its ends
  const thick = (cell: number, a: number) => {
    const [lo, hi] = intervals(indexOf(cell))[a];
    return Math.min(hi, axes[a].hi) - Math.max(lo, axes[a].lo);
  };
  const ends = (cell: number, a: number) => {
    const k = indexOf(cell)[a];
    return (k > 0 ? 1 : 0) + (k < counts[a] - 1 ? 1 : 0);
  };

  const maps = new Map<string, JointMap>();
  const mapFor = (p: (typeof pairs)[number], depth: number) => {
    const key = `${p.axis}|${p.cut}|${p.below}|${fmt(depth, 2)}`;
    let m = maps.get(key);
    if (!m) {
      const cell = intervals(indexOf(p.below)).map((x, a) => (a === p.axis ? ([-Infinity, Infinity] as [number, number]) : x));
      m = jointMap(I, axes, p.axis, cuts[p.axis][p.cut], depth, cell);
      maps.set(key, m);
    }
    return m;
  };
  // the joints there are: material at the cut between the two cells
  const live = pairs.filter((p) => mapFor(p, 0.5).any);

  let pin = 0;
  let length = 0;
  let spots = new Map<(typeof pairs)[number], [number, number][]>();
  if (pinned && spec.pins > 0 && live.length) {
    const fitsDepth = (p: (typeof pairs)[number], L: number) => {
      const D = pinDepth(L) + 1;
      return [p.below, p.above].every((c) => thick(c, p.axis) >= D * ends(c, p.axis));
    };
    const tryD = (d: number, L: number) => {
      const need = (d + clr) / 2 + wallFor(d);
      const gap = d + clr + wallFor(d);
      const got = new Map<(typeof pairs)[number], [number, number][]>();
      for (const p of live) got.set(p, fitsDepth(p, L) ? pickSpots(mapFor(p, pinDepth(L) + 0.5), need, spec.pins, gap) : []);
      return got;
    };
    const minArea = Math.min(...live.map((p) => mapFor(p, 0.5).area));
    const sizes = spec.pin !== undefined ? [spec.pin] : DOWEL_SIZES.map(([d]) => d).filter((d) => d <= Math.max(2, Math.min(opts.printed ? 6 : 8, 0.12 * Math.sqrt(minArea)))).reverse();
    let best: { d: number; L: number; got: Map<(typeof pairs)[number], [number, number][]>; n: number } | null = null;
    for (const d of sizes) {
      const L = spec.length ?? dowelLength(d);
      const got = tryD(d, L);
      const n = [...got.values()].reduce((s, x) => s + x.length, 0);
      if (!best || n > best.n) best = { d, L, got, n };
      if ([...got.values()].every((x) => x.length >= spec.pins)) {
        best = { d, L, got, n };
        break;
      }
    }
    if (best && best.n) {
      pin = best.d;
      length = best.L;
      spots = best.got;
    }
    for (const p of live) {
      const got = spots.get(p)?.length ?? 0;
      if (got >= spec.pins) continue;
      const t = cuts[p.axis][p.cut];
      const w = axisWord(spec.axes[p.axis].dir);
      const m = mapFor(p, 0.5);
      const L = length || spec.length || dowelLength(spec.pin ?? 3);
      const thin = !fitsDepth(p, L);
      const why = thin
        ? `a piece beside it is too short along ${w} for the pins' holes`
        : `the material there leaves room for a pin of at most Ø${fmt(widest(m.room))} mm with walls round its hole`;
      warnings.push(`the joint at ${w} = ${fmt(t)} has ${got ? `room for only ${got} of the ${spec.pins} pins` : "no room for pins"}: ${why}. ${got ? "Fewer pins hold it" : "Glue it there"}, use a smaller pin:, or move the cut to where the part is solid`);
    }
  }

  // ---- the pieces ----
  const boxes = cellBoxes(P, I, axes, cuts);
  // a cell with no vertex in it but material across a joint still has material (the middle of a large plate)
  for (const p of live) {
    for (const cell of [p.below, p.above]) {
      const b = boxes[cell];
      if (b.any) continue;
      const m = mapFor(p, 0.5);
      const A = axes[p.axis];
      const t = cuts[p.axis][p.cut];
      const { a0, b0, h, W, H } = m.r;
      for (const [i, j] of [
        [0, 0],
        [W, H],
      ])
        grow(b, [A.n[0] * t + A.u[0] * (a0 + i * h) + A.v[0] * (b0 + j * h), A.n[1] * t + A.u[1] * (a0 + i * h) + A.v[1] * (b0 + j * h), A.n[2] * t + A.u[2] * (a0 + i * h) + A.v[2] * (b0 + j * h)]);
    }
  }
  const cellIds = new Map<number, number>();
  const cells: SplitCell[] = [];
  boxes.forEach((b, cell) => {
    if (!b.any) return;
    cellIds.set(cell, cells.length);
    cells.push({ index: indexOf(cell), box: [b.lo, b.hi] });
  });
  if (cells.length < 2) return none("every cut misses the part's material, so it would be one piece");
  const joints: SplitJoint[] = [];
  for (const p of live) {
    const below = cellIds.get(p.below);
    const above = cellIds.get(p.above);
    if (below === undefined || above === undefined) continue;
    const A = axes[p.axis];
    const t = cuts[p.axis][p.cut];
    const m = mapFor(p, 0.5);
    joints.push({
      axis: p.axis,
      cut: p.cut,
      below,
      above,
      spots: (spots.get(p) ?? []).map(([a, b]) => [A.n[0] * t + A.u[0] * a + A.v[0] * b, A.n[1] * t + A.u[1] * a + A.v[1] * b, A.n[2] * t + A.u[2] * a + A.v[2] * b] as V3),
      area: Math.round(m.area),
      room: +widest(m.room).toFixed(1),
    });
  }
  if (opts.fits && bed === undefined && opts.env)
    cells.forEach((c, k) => {
      const e: V3 = [c.box[1][0] - c.box[0][0], c.box[1][1] - c.box[0][1], c.box[1][2] - c.box[0][2]];
      if (!opts.fits!(e)) warnings.push(`piece ${k + 1} (${e.map((x) => fmt(x, 0)).join(" × ")} mm) is still too big for the ${opts.env!.what}`);
    });
  return { cuts, range, across, cells, joints, pin, length, ...(bed ? { bed } : {}), warnings };
}

/**
 * The cuts and pins of split parts, by the split asked for, the part's geometry and (when the count is left to the
 * bed) the machine the pieces must fit, so choosing another printer works them out again. The engine keeps one for
 * the design, fed from the meshes it builds; lookup is what the evaluator reads.
 */
export function splitTable(machines: () => MachineContext = () => NO_MACHINES) {
  const cache = new Map<string, SplitInfo>();
  const envOf = (q: SplitQuery) => {
    if (!q.spec.axes.some((a) => !a.at && !a.count) || !q.process) return null;
    return rulesOnMachine(q.process, q.material, machines()).envelope ?? null;
  };
  const keyOf = (q: SplitQuery) => {
    const env = envOf(q);
    return env ? `${q.key}|${env.size.join(",")}|${env.frame?.join(",") ?? ""}` : q.key;
  };
  return {
    lookup: (q: SplitQuery): SplitInfo | undefined => {
      const key = keyOf(q);
      const info = cache.get(key);
      // the ones in use stay newest, so trimming the table drops ones no design reads now
      if (info) {
        cache.delete(key);
        cache.set(key, info);
      }
      return info;
    },
    /** Work out the splits a model waits for from the meshes built so far; true when there are new ones to read the design with. */
    resolve(model: Model, meshOf: (hash: string) => MeshData | undefined): boolean {
      let added = false;
      for (const q of model.splitQueries ?? []) {
        const key = keyOf(q);
        if (cache.has(key)) continue;
        const mesh = meshOf(q.hash);
        if (!mesh) continue;
        const env = envOf(q);
        let info: SplitInfo;
        try {
          info = computeSplit(mesh, q.spec, { printed: splitPrinted(q), env, fits: env ? (e) => envelopeFit(e, env).fits : undefined });
        } catch (e) {
          info = { cuts: [], range: [], across: [], cells: [], joints: [], pin: 0, length: 0, warnings: [], error: `the cuts could not be worked out (${e instanceof Error ? e.message : String(e)})` };
        }
        cache.set(key, info);
        added = true;
      }
      if (cache.size > 300) for (const k of [...cache.keys()].slice(0, cache.size - 300)) cache.delete(k);
      return added;
    },
  };
}
