// Design-for-manufacture analysis of one solid against one process's rules.
// Works on the B-rep-tagged triangle mesh from brep.ts: wall thickness, gap
// widths and reachability are measured with rays; draft, overhangs and
// inside corners come from face normals, B-rep surface types and the mesh's
// sharp edges. Pure TypeScript, so it runs in the kernel worker and in tests.

import { TriBVH } from "./bvh";
import { triCentroid, triNormal, type AnalysisMesh, type FaceInfo } from "./brep";
import { axisName, fmt, slowestTool, toolName } from "./profiles";
import { isMetal } from "./materials";
import type { Alternative, ProcessFinding, ProcessId, ProcessStats, Rules, Tool } from "./types";
import type { V3 } from "../kernel/recipe";

const AXES: V3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const DEG = Math.PI / 180;

const dot = (a: ArrayLike<number>, b: ArrayLike<number>, ao = 0) => a[ao] * b[0] + a[ao + 1] * b[1] + a[ao + 2] * b[2];
const sameDir = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0.9999;

/**
 * Per-solid analysis state: triangle data, samples and lazily computed ray
 * results. Nothing in it depends on the rules, so one context serves every
 * process a part is checked or compared against.
 */
export class Ctx {
  readonly n: number;
  readonly tn: Float64Array; // nx, ny, nz, area per triangle
  readonly tc: Float64Array; // centroid per triangle
  readonly lo: V3;
  readonly hi: V3;
  readonly diag: number;
  readonly eps: number;
  readonly clearEps: number;
  readonly samples: Int32Array;
  readonly sampleOf: Int32Array; // triangle -> sample slot
  readonly sampleArea: Float64Array;
  private _bvh: TriBVH | null = null;
  private _thick: Float64Array | null = null;
  private _local: Float64Array | null = null;
  private _gap: Float64Array | null = null;
  private clearCache = new Map<string, Uint8Array>();
  private _sharp: SharpEdge[] | null = null;
  private _volume: number | null = null;

  constructor(
    readonly m: AnalysisMesh,
    maxSamples: number,
    /** the mesh's chordal deflection: facets sit up to this far inside curved faces */
    tolerance = 0,
  ) {
    const n = m.idx.length / 3;
    this.n = n;
    this.tn = new Float64Array(n * 4);
    this.tc = new Float64Array(n * 3);
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < n; t++) {
      const nn = triNormal(m.pos, m.idx, t);
      this.tn.set(nn, t * 4);
      const c = triCentroid(m.pos, m.idx, t);
      this.tc.set(c, t * 3);
    }
    for (let i = 0; i < m.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (m.pos[i + k] < lo[k]) lo[k] = m.pos[i + k];
        if (m.pos[i + k] > hi[k]) hi[k] = m.pos[i + k];
      }
    this.lo = lo;
    this.hi = hi;
    this.diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    this.eps = Math.max(2e-3, this.diag * 2e-5);
    // a ray leaving almost along its own curved face (a hole wall seen from a crossing hole) grazes the
    // neighbouring facets unless it starts further out than they sag
    this.clearEps = Math.max(this.eps, 2.5 * tolerance);
    // sample every k-th triangle of each face, so every face gets at least one
    const k = Math.max(1, Math.ceil(n / maxSamples));
    const list: number[] = [];
    this.sampleOf = new Int32Array(n);
    for (const f of m.faces) {
      for (let t = f.start; t < f.start + f.count; t++) {
        if ((t - f.start) % k === 0) list.push(t);
        this.sampleOf[t] = list.length - 1;
      }
    }
    this.samples = Int32Array.from(list);
    this.sampleArea = new Float64Array(list.length);
    for (let t = 0; t < n; t++) this.sampleArea[this.sampleOf[t]] += this.tn[t * 4 + 3];
  }

  get bvh() {
    if (!this._bvh) this._bvh = new TriBVH(this.m.pos, this.m.idx);
    return this._bvh;
  }

  face(t: number): FaceInfo {
    return this.m.faces[this.m.faceOf[t]];
  }

  /** Ray thickness: distance through the material along the inward normal (NaN where the ray escapes). */
  thickness(): Float64Array {
    if (this._thick) return this._thick;
    const out = new Float64Array(this.samples.length).fill(NaN);
    const { tn, tc, eps } = this;
    for (let s = 0; s < this.samples.length; s++) {
      const t = this.samples[s];
      if (tn[t * 4 + 3] <= 0) continue;
      const nx = tn[t * 4],
        ny = tn[t * 4 + 1],
        nz = tn[t * 4 + 2];
      const h = this.bvh.raycast(tc[t * 3] - nx * eps, tc[t * 3 + 1] - ny * eps, tc[t * 3 + 2] - nz * eps, -nx, -ny, -nz, 0, Infinity, t);
      // a wall's far side faces the other way; a ray that leaves through a side face near an edge measures the edge, not a wall
      if (h && tn[h.tri * 4] * nx + tn[h.tri * 4 + 1] * ny + tn[h.tri * 4 + 2] * nz < -0.5) out[s] = h.t + eps;
    }
    return (this._thick = out);
  }

  /**
   * Local thickness: the diameter of the largest ball centred halfway along the
   * inward ray. Unlike the ray length it is not fooled by rims and edge faces.
   */
  localThickness(): Float64Array {
    if (this._local) return this._local;
    const th = this.thickness();
    const out = new Float64Array(this.samples.length).fill(NaN);
    const { tn, tc } = this;
    for (let s = 0; s < this.samples.length; s++) {
      if (!Number.isFinite(th[s])) continue;
      const t = this.samples[s];
      const half = th[s] / 2;
      const x = tc[t * 3] - tn[t * 4] * half,
        y = tc[t * 3 + 1] - tn[t * 4 + 1] * half,
        z = tc[t * 3 + 2] - tn[t * 4 + 2] * half;
      out[s] = 2 * this.bvh.nearest(x, y, z, half + 1e-6);
    }
    return (this._local = out);
  }

  /** Gap: distance across empty space along the outward normal to a facing wall (NaN if open). */
  gap(): Float64Array {
    if (this._gap) return this._gap;
    const out = new Float64Array(this.samples.length).fill(NaN);
    const { tn, tc, eps } = this;
    for (let s = 0; s < this.samples.length; s++) {
      const t = this.samples[s];
      const nx = tn[t * 4],
        ny = tn[t * 4 + 1],
        nz = tn[t * 4 + 2];
      const h = this.bvh.raycast(tc[t * 3] + nx * eps, tc[t * 3 + 1] + ny * eps, tc[t * 3 + 2] + nz * eps, nx, ny, nz, 0, Infinity, t);
      if (h && tn[h.tri * 4] * nx + tn[h.tri * 4 + 1] * ny + tn[h.tri * 4 + 2] * nz < -0.5) out[s] = h.t + eps;
    }
    return (this._gap = out);
  }

  /** 1 where a straight line from the sample along d leaves the part without hitting it. */
  clear(d: V3): Uint8Array {
    const key = d.map((x) => x.toFixed(5)).join(",");
    const hit = this.clearCache.get(key);
    if (hit) return hit;
    const out = new Uint8Array(this.samples.length);
    const { tn, tc } = this;
    const eps = this.clearEps;
    for (let s = 0; s < this.samples.length; s++) {
      const t = this.samples[s];
      const nx = tn[t * 4],
        ny = tn[t * 4 + 1],
        nz = tn[t * 4 + 2];
      if (nx * d[0] + ny * d[1] + nz * d[2] < -0.02) continue;
      const ox = tc[t * 3] + nx * eps + d[0] * eps,
        oy = tc[t * 3 + 1] + ny * eps + d[1] * eps,
        oz = tc[t * 3 + 2] + nz * eps + d[2] * eps;
      out[s] = this.bvh.raycast(ox, oy, oz, d[0], d[1], d[2], 0, Infinity, t, true) ? 0 : 1;
    }
    this.clearCache.set(key, out);
    return out;
  }

  /** Enclosed volume, mm³ (divergence theorem over the outward-facing triangles). */
  volume(): number {
    if (this._volume !== null) return this._volume;
    const { pos, idx } = this.m;
    let v = 0;
    for (let t = 0; t < this.n; t++) {
      const a = idx[t * 3] * 3,
        b = idx[t * 3 + 1] * 3,
        c = idx[t * 3 + 2] * 3;
      v +=
        pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) +
        pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
    }
    return (this._volume = Math.abs(v) / 6);
  }

  /** Sharp edges between different B-rep faces, from the welded mesh. */
  sharpEdges(): SharpEdge[] {
    if (this._sharp) return this._sharp;
    return (this._sharp = findSharpEdges(this));
  }

  /** Triangles whose sample satisfies pred, as mark geometry. */
  marks(pred: (s: number, t: number) => boolean): { marks: Float32Array; area: number; tris: number } {
    const { m } = this;
    const out: number[] = [];
    let area = 0;
    let tris = 0;
    for (let t = 0; t < this.n; t++) {
      if (!pred(this.sampleOf[t], t)) continue;
      area += this.tn[t * 4 + 3];
      tris++;
      for (let k = 0; k < 3; k++) {
        const v = m.idx[t * 3 + k] * 3;
        out.push(m.pos[v], m.pos[v + 1], m.pos[v + 2]);
      }
    }
    return { marks: Float32Array.from(out), area, tris };
  }

  /** Mark whole faces. */
  faceMarks(faces: Set<number>) {
    return this.marks((_s, t) => faces.has(this.m.faceOf[t]));
  }
}

interface SharpEdge {
  a: V3;
  b: V3;
  dir: V3;
  len: number;
  concave: boolean;
  /** angle between the two face normals, degrees */
  angle: number;
  n1: V3;
  n2: V3;
  f1: number;
  f2: number;
  va: number; // welded vertex ids, for grouping into corners
  vb: number;
}

function findSharpEdges(c: Ctx): SharpEdge[] {
  const { m, tn } = c;
  // weld coincident vertices (each B-rep face has its own copies along shared edges)
  const q = c.eps * 0.5;
  const weld = new Int32Array(m.pos.length / 3);
  const map = new Map<string, number>();
  for (let v = 0; v < weld.length; v++) {
    const key = `${Math.round(m.pos[v * 3] / q)},${Math.round(m.pos[v * 3 + 1] / q)},${Math.round(m.pos[v * 3 + 2] / q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = map.size;
      map.set(key, id);
    }
    weld[v] = id;
  }
  const edges = new Map<string, { t: number; opp: number }[]>();
  for (let t = 0; t < c.n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = weld[m.idx[t * 3 + k]];
      const b = weld[m.idx[t * 3 + ((k + 1) % 3)]];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const list = edges.get(key) ?? [];
      list.push({ t, opp: m.idx[t * 3 + ((k + 2) % 3)] });
      edges.set(key, list);
    }
  }
  const out: SharpEdge[] = [];
  const cos20 = Math.cos(20 * DEG);
  for (const [key, list] of edges) {
    if (list.length !== 2) continue;
    const [e1, e2] = list;
    const f1 = m.faceOf[e1.t];
    const f2 = m.faceOf[e2.t];
    if (f1 === f2) continue;
    const n1: V3 = [tn[e1.t * 4], tn[e1.t * 4 + 1], tn[e1.t * 4 + 2]];
    const n2: V3 = [tn[e2.t * 4], tn[e2.t * 4 + 1], tn[e2.t * 4 + 2]];
    const cosA = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    if (cosA > cos20) continue;
    const [ia, ib] = key.split("_").map(Number);
    // recover positions from any original vertex of the triangle with that weld id
    const pa = vertexOf(c, e1.t, weld, ia);
    const pb = vertexOf(c, e1.t, weld, ib);
    const dir: V3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const len = Math.hypot(...dir);
    if (len < 1e-9) continue;
    // concave when the second triangle rises above the first one's plane (on its outward side)
    const o = e2.opp * 3;
    const mid: V3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    const rise = (m.pos[o] - mid[0]) * n1[0] + (m.pos[o + 1] - mid[1]) * n1[1] + (m.pos[o + 2] - mid[2]) * n1[2];
    out.push({ a: pa, b: pb, dir: [dir[0] / len, dir[1] / len, dir[2] / len], len, concave: rise > c.eps, angle: Math.acos(Math.max(-1, Math.min(1, cosA))) / DEG, n1, n2, f1, f2, va: ia, vb: ib });
  }
  return out;
}

function vertexOf(c: Ctx, t: number, weld: Int32Array, id: number): V3 {
  for (let k = 0; k < 3; k++) {
    const v = c.m.idx[t * 3 + k];
    if (weld[v] === id) return [c.m.pos[v * 3], c.m.pos[v * 3 + 1], c.m.pos[v * 3 + 2]];
  }
  return [0, 0, 0];
}

/** Count connected chains of edge segments (one chain per physical corner). */
function chains(edges: SharpEdge[]): number {
  return chainLengths(edges).length;
}

/** Total length of each chain of connected edges. */
function chainLengths(edges: SharpEdge[]): number[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.va)) parent.set(e.va, e.va);
    if (!parent.has(e.vb)) parent.set(e.vb, e.vb);
    parent.set(find(e.va), find(e.vb));
  }
  const len = new Map<number, number>();
  for (const e of edges) len.set(find(e.va), (len.get(find(e.va)) ?? 0) + e.len);
  return [...len.values()];
}

function lineMarks(edges: SharpEdge[]): Float32Array {
  const out = new Float32Array(edges.length * 6);
  edges.forEach((e, i) => out.set([...e.a, ...e.b], i * 6));
  return out;
}

function weightedPercentile(vals: Float64Array, w: Float64Array, p: number): number {
  const idx: number[] = [];
  for (let i = 0; i < vals.length; i++) if (Number.isFinite(vals[i]) && w[i] > 0) idx.push(i);
  if (!idx.length) return NaN;
  idx.sort((a, b) => vals[a] - vals[b]);
  const total = idx.reduce((s, i) => s + w[i], 0);
  let acc = 0;
  for (const i of idx) {
    acc += w[i];
    if (acc >= p * total) return vals[i];
  }
  return vals[idx[idx.length - 1]];
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const mm2 = (a: number) => (a >= 100 ? `${Math.round(a)} mm²` : `${fmt(a, 1)} mm²`);

export interface AnalyzeOptions {
  maxSamples?: number;
  /** the tolerance the mesh was made with, mm */
  tolerance?: number;
}

export function prepareSolid(m: AnalysisMesh, opts: AnalyzeOptions = {}): Ctx {
  return new Ctx(m, opts.maxSamples ?? 24000, opts.tolerance ?? 0);
}

export function analyzeSolid(solid: AnalysisMesh | Ctx, rules: Rules, opts: AnalyzeOptions = {}): { findings: ProcessFinding[]; stats: ProcessStats } {
  const c = solid instanceof Ctx ? solid : prepareSolid(solid, opts);
  const m = c.m;
  const findings: ProcessFinding[] = [];
  const stats: ProcessStats = { triangles: c.n, samples: c.samples.length };
  if (!c.n) return { findings: [{ rule: "geometry", status: "fail", title: "No geometry to check", detail: "The part has no surface to analyse." }], stats };

  if (rules.envelope) findings.push(envelope(c, rules.envelope));
  if (rules.wall && !rules.sheet && !rules.profile) findings.push(...walls(c, rules, stats));
  if (rules.reach?.what === "mould") findings.push(...mould(c, rules));
  else if (rules.reach) findings.push(...setups(c, rules));
  if (rules.layup) findings.push(layup(c, rules, stats));
  if (rules.innerRadius) findings.push(...insideCorners(c, rules, stats));
  if (rules.gap) findings.push(...gaps(c, rules));
  if (rules.machining) findings.push(...machining(c, rules, stats));
  if (rules.overhang) findings.push(...overhangs(c, rules));
  if (rules.supportAccess) findings.push(...supportAccess(c, rules));
  if (rules.fuse) findings.push(...fusedGaps(c, rules));
  if (rules.printer) findings.push(...printerFit(rules));
  if (rules.press) findings.push(...pressFit(c, rules, stats));
  if (rules.pour) findings.push(...pourFit(c, rules));
  if (rules.revolve) findings.push(...turning(c, rules));
  if (rules.sheet) findings.push(...sheet(c, rules, stats));
  if (rules.profile) findings.push(...profile(c, rules, stats));
  if (rules.holes) findings.push(...holes(c, rules, stats));
  if (rules.voids) {
    findings.push(
      m.voids > 0
        ? {
            rule: "voids",
            status: rules.voids.severity,
            title: "Sealed internal void",
            detail: `The part encloses ${plural(m.voids, "sealed void")}.`,
            fix: `Open the void to the outside: ${rules.voids.why}.`,
          }
        : { rule: "voids", status: "pass", title: "No sealed voids", detail: "Every cavity opens to the outside." },
    );
  }
  return { findings, stats };
}

// ---------------- envelope ----------------

/**
 * The turn on the bed, in whole degrees, that fits a w × d footprint (w ≥ d) on a W × D bed (W ≥ D) with the most room
 * to spare: 0 when it fits square, undefined when no turn fits. A part too long for the bed can lie across it, the way
 * a slicer places it; the pack's STL is turned the same way.
 */
export function bedTurn(w: number, d: number, W: number, D: number): number | undefined {
  if (w <= W + 1e-6 && d <= D + 1e-6) return 0;
  let best: number | undefined;
  let room = -1e-6;
  for (let deg = 1; deg < 90; deg++) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const r = Math.min(W - (w * c + d * s), D - (w * s + d * c));
    if (r > room + 1e-9) {
      room = r;
      best = deg;
    }
  }
  return best;
}

/**
 * The same for a footprint that is not a rectangle: an L, a V or an arch fits across the corners of a bed its bounding
 * box does not. pos holds the part's points, `stride` numbers each, with the footprint's two coordinates at offsets
 * ox and oy (only their convex hull matters). Returns the turn about the vertical, in whole degrees from 0 to 179,
 * that leaves the most room on a bx × by bed, and the footprint's size after it; undefined when no turn fits.
 */
export function footprintTurn(pos: ArrayLike<number>, stride: number, ox: number, oy: number, bx: number, by: number): { deg: number; w: number; d: number } | undefined {
  const pts: [number, number][] = [];
  for (let i = 0; i + stride <= pos.length; i += stride) pts.push([pos[i + ox], pos[i + oy]]);
  if (!pts.length) return undefined;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (order: [number, number][]) => {
    const h: [number, number][] = [];
    for (const p of order) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    return h;
  };
  const lower = half(pts);
  const upper = half([...pts].reverse());
  const hull = lower.length > 1 ? lower.slice(0, -1).concat(upper.slice(0, -1)) : lower;
  let best: { deg: number; w: number; d: number } | undefined;
  let room = -1e-6;
  for (let deg = 0; deg < 180; deg++) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c - y * s;
      const v = x * s + y * c;
      if (u < x0) x0 = u;
      if (u > x1) x1 = u;
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
    const r = Math.min(bx - (x1 - x0), by - (y1 - y0));
    if (r > room + 1e-9) {
      room = r;
      best = { deg, w: x1 - x0, d: y1 - y0 };
    }
  }
  return best;
}

/** Whether a part of this extent (its own x, y, z) fits the machine, and its size in words; the envelope check's test. */
export function envelopeFit(ext: V3, env: NonNullable<Rules["envelope"]>): { fits: boolean; dims: string } {
  const size = env.size;
  let fits: boolean;
  let dims: string;
  if (env.frame) {
    const b = env.frame;
    const ax = Math.abs(b[0]) > 0.99 ? 0 : Math.abs(b[1]) > 0.99 ? 1 : 2;
    const h = ext[ax];
    const foot = ext.filter((_, i) => i !== ax).sort((a, b2) => b2 - a);
    const bed = [size[0], size[1]].sort((a, b2) => b2 - a);
    const turn = h <= size[2] + 1e-6 ? bedTurn(foot[0], foot[1], bed[0], bed[1]) : undefined;
    fits = turn !== undefined;
    dims = `${fmt(foot[0], 1)} × ${fmt(foot[1], 1)} mm footprint, ${fmt(h, 1)} mm tall${turn ? `, laid ${turn}° across the bed` : ""}`;
  } else {
    const a = [...ext].sort((x, y) => y - x);
    const b2 = [...size].sort((x, y) => y - x);
    fits = a.every((v, i) => v <= b2[i] + 1e-6);
    dims = `${ext.map((v) => fmt(v, 1)).join(" × ")} mm`;
  }
  return { fits, dims };
}

function envelope(c: Ctx, env: NonNullable<Rules["envelope"]>): ProcessFinding {
  const ext: V3 = [c.hi[0] - c.lo[0], c.hi[1] - c.lo[1], c.hi[2] - c.lo[2]];
  const size = env.size;
  let { fits, dims } = envelopeFit(ext, env);
  if (!fits && env.frame) {
    // its bounding box fits no way: its real outline may, turned across the bed's corners (an L, a V, an arch)
    const b = env.frame;
    const ax = Math.abs(b[0]) > 0.99 ? 0 : Math.abs(b[1]) > 0.99 ? 1 : 2;
    const [u, v] = [0, 1, 2].filter((i) => i !== ax);
    const t = ext[ax] <= size[2] + 1e-6 ? footprintTurn(c.m.pos, 3, u, v, size[0], size[1]) : undefined;
    if (t) {
      fits = true;
      dims = `${dims}, laid ${t.deg}° across the bed, where its outline takes ${fmt(t.w, 1)} × ${fmt(t.d, 1)} mm`;
    }
  }
  return fits
    ? { rule: "envelope", status: "pass", title: `Fits the ${env.what}`, detail: `${dims}, within ${size.map((v) => fmt(v)).join(" × ")} mm` }
    : {
        rule: "envelope",
        status: "fail",
        title: `Too big for the ${env.what}`,
        detail: `${dims}; the limit is ${size.map((v) => fmt(v)).join(" × ")} mm.`,
        fix: `Make it in pieces: split: ${"XYZ"[ext.indexOf(Math.max(...ext))]} on the part cuts it across its length into the fewest pieces that fit, joined on dowel pins. Or reorient it, or use a bigger machine.`,
      };
}

// ---------------- walls ----------------

/** What goes wrong at a knife edge, by process (machining and cutting otherwise). */
const KNIFE_EDGE: Partial<Record<ProcessId, string>> = {
  fdm: "It prints ragged or not at all",
  sla: "It prints ragged or not at all",
  sls: "It prints ragged or not at all",
  metal_print: "It prints ragged or not at all",
  injection: "It fills poorly and the tool edge wears",
  die_cast: "It fills poorly and the tool edge wears",
  vacuum_cast: "It fills poorly and tears out of the silicone mould",
  sand_cast: "The metal freezes before it fills it, and the sand there crumbles",
  investment_cast: "The metal freezes before it fills it",
  carbon_layup: "The plies cannot follow it, leaving a resin-rich edge that chips",
};

function walls(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding[] {
  const w = rules.wall!;
  const th = c.thickness();
  const out: ProcessFinding[] = [];
  const nominal = weightedPercentile(th, c.sampleArea, 0.5);
  const thin = weightedPercentile(th, c.sampleArea, 0.01);
  stats.nominalWall = nominal;
  stats.minWall = thin;
  // ignore slivers smaller than a couple of wall-widths squared (knife edges at chamfers)
  const minArea = Math.max(1, 0.5 * w.warn * w.warn);
  // A wall that is thin all over is a thin wall. Where two features meet at a
  // shallow angle the material tapers to a knife edge instead: thin samples on
  // that face spread from nearly nothing up to the limit. Report those apart.
  const taper = taperedFaces(c, th, w.warn, w.fail);
  const uniform = (s: number) => !taper.has(c.m.faceOf[c.samples[s]]);
  const fail = c.marks((s) => th[s] < w.fail - 1e-6 && uniform(s));
  const warn = c.marks((s) => th[s] < w.warn - 1e-6 && uniform(s));
  let minFlag = Infinity;
  for (let s = 0; s < th.length; s++) if (th[s] < w.warn - 1e-6 && th[s] < minFlag && uniform(s)) minFlag = th[s];
  const edges = c.marks((s) => th[s] < w.fail - 1e-6 && !uniform(s));
  if (edges.area >= minArea) {
    out.push({
      rule: "knife-edge",
      status: "warn",
      title: "Knife edges",
      detail: `${mm2(edges.area)} tapers to a sharp edge thinner than ${fmt(w.fail)} mm where features meet at a shallow angle. ${KNIFE_EDGE[rules.process] ?? "It bends or burrs when cut"}.`,
      fix: `Trim the sliver, let the features meet at a right angle, or blend it with a radius so the material is at least ${fmt(w.warn)} mm across.`,
      value: 0,
      limit: w.fail,
      marks: edges.marks,
    });
  }
  if (fail.area >= minArea) {
    out.push({
      rule: "wall-thin",
      status: "fail",
      title: `Walls under ${fmt(w.fail)} mm`,
      detail: `${mm2(fail.area)} of wall is as thin as ${fmt(minFlag)} mm (${w.why}).`,
      fix: `Thicken these walls to at least ${fmt(w.warn)} mm.`,
      value: minFlag,
      limit: w.fail,
      marks: fail.marks,
    });
  } else if (warn.area >= minArea && w.warn > w.fail) {
    out.push({
      rule: "wall-thin",
      status: "warn",
      title: `Walls under ${fmt(w.warn)} mm`,
      detail: `${mm2(warn.area)} of wall is ${fmt(minFlag)} mm thick (${w.why}).`,
      fix: `Thicken these walls to ${fmt(w.warn)} mm or more.`,
      value: minFlag,
      limit: w.warn,
      marks: warn.marks,
    });
  } else {
    out.push({
      rule: "wall-thin",
      status: "pass",
      title: `Walls at least ${fmt(w.warn)} mm`,
      detail: Number.isFinite(nominal) ? `Thinnest ${fmt(Math.max(thin, 0))} mm, typical ${fmt(nominal)} mm` : "No thin walls found",
      value: thin,
      limit: w.warn,
    });
  }
  if (w.max !== undefined || w.thickRatio) {
    const local = c.localThickness();
    const limit = Math.min(w.max ?? Infinity, w.thickRatio && Number.isFinite(nominal) ? Math.max(w.thickRatio * nominal, w.warn * 1.5) : Infinity);
    stats.maxWall = weightedPercentile(local, c.sampleArea, 0.99);
    const thick = c.marks((s) => local[s] > limit + 1e-6);
    let maxFlag = 0;
    for (let s = 0; s < local.length; s++) if (local[s] > limit && local[s] > maxFlag) maxFlag = local[s];
    if (thick.area >= Math.max(4, limit * limit)) {
      const overMax = w.max !== undefined && maxFlag > w.max;
      // a part with no thin walls at all is a solid block, not a walled part with thick spots
      const solid = w.max !== undefined && !(nominal <= w.max);
      const target = Math.max(w.warn, Math.min(Number.isFinite(nominal) ? nominal : w.warn, w.max ?? Infinity, (w.max ?? 2 * w.warn) * 0.7));
      out.push({
        rule: "wall-thick",
        status: "warn",
        title: overMax ? `Sections over ${fmt(w.max!)} mm` : "Thick sections",
        detail: `${mm2(thick.area)} of the part is up to ${fmt(maxFlag, 1)} mm thick${solid ? `, but ${rules.material} moulds well only up to ${fmt(w.max!)} mm` : ` against a ${fmt(nominal)} mm nominal wall`}. Thick areas shrink unevenly: sink marks, voids and long cycle times.`,
        fix: `${solid ? "Shell the part" : "Core out thick areas"} to a uniform ${fmt(target)} mm wall and add ribs of about ${fmt(0.6 * target, 1)} mm where stiffness is needed.`,
        value: maxFlag,
        limit,
        marks: thick.marks,
      });
    } else {
      out.push({ rule: "wall-thick", status: "pass", title: "Even wall thickness", detail: `No section thicker than ${fmt(limit, 1)} mm` });
    }
  }
  return out;
}

/** Faces whose thin samples run from almost nothing up to the limit: knife edges rather than thin walls. */
function taperedFaces(c: Ctx, th: Float64Array, warn: number, fail: number): Set<number> {
  const byFace = new Map<number, { t: number[]; a: number[] }>();
  for (let s = 0; s < th.length; s++) {
    if (!(th[s] < warn)) continue;
    const f = c.m.faceOf[c.samples[s]];
    let e = byFace.get(f);
    if (!e) byFace.set(f, (e = { t: [], a: [] }));
    e.t.push(th[s]);
    e.a.push(c.sampleArea[s]);
  }
  const out = new Set<number>();
  for (const [f, e] of byFace) {
    const t = Float64Array.from(e.t);
    const a = Float64Array.from(e.a);
    const lo = weightedPercentile(t, a, 0.1);
    const hi = weightedPercentile(t, a, 0.9);
    if (lo < fail && hi - lo > 0.4 * warn) out.add(f);
  }
  return out;
}

// ---------------- moulding: draft and undercuts ----------------

/** Undercuts against the mould's pull, and draft on the faces along it when the process needs draft. */
function mould(c: Ctx, rules: Rules): ProcessFinding[] {
  const out: ProcessFinding[] = [];
  const reach = rules.reach!;
  const pull = rules.draft?.pull ?? reach.dirs[0];
  const up = c.clear(pull);
  const down = c.clear([-pull[0], -pull[1], -pull[2]]);
  const { tn } = c;
  const sinSide = Math.sin(45 * DEG);
  const draftOf = new Float64Array(c.samples.length).fill(NaN);
  const undercut = new Uint8Array(c.samples.length);
  // mould slides: further pieces that pull out sideways, for faces neither half reaches
  const slides = reach.dirs.slice(2).map((d) => ({ d, clear: c.clear(d), area: 0 }));
  for (let s = 0; s < c.samples.length; s++) {
    const t = c.samples[s];
    const np = dot(tn, pull, t * 4);
    if (!up[s] && !down[s]) {
      const slide = slides.find((sl) => sl.clear[s]);
      if (slide) slide.area += c.sampleArea[s];
      else undercut[s] = 1;
      continue;
    }
    if (Math.abs(np) > sinSide) continue;
    // draft relative to the side it releases to
    const a = up[s] ? Math.asin(Math.max(-1, Math.min(1, np))) / DEG : -Infinity;
    const b = down[s] ? Math.asin(Math.max(-1, Math.min(1, -np))) / DEG : -Infinity;
    draftOf[s] = Math.max(a, b);
  }
  const pullName = axisName(pull);
  const d = rules.draft;
  if (d) {
    const failM = c.marks((s) => draftOf[s] < d.fail - 1e-6);
    const warnM = c.marks((s) => draftOf[s] < d.warn - 1e-6);
    const flaggedFaces = new Set<number>();
    let worst = Infinity;
    for (let s = 0; s < c.samples.length; s++) {
      if (draftOf[s] < d.warn - 1e-6) {
        flaggedFaces.add(c.m.faceOf[c.samples[s]]);
        worst = Math.min(worst, draftOf[s]);
      }
    }
    if (warnM.area > 0.5) {
      const status = failM.area > 0.5 ? "fail" : "warn";
      out.push({
        rule: "draft",
        status,
        title: worst < -0.25 ? "Negative draft" : worst < 0.1 ? "No draft on side faces" : `Draft under ${fmt(d.warn)}°`,
        detail: `${plural(flaggedFaces.size, "face")} along the pull ${pullName} ${worst < 0.1 && worst > -0.25 ? (flaggedFaces.size === 1 ? "is straight" : "are straight") : `${flaggedFaces.size === 1 ? "has" : "have"} as little as ${fmt(worst, 2)}°`} (${mm2(warnM.area)}). ${rules.process === "sand_cast" ? "Without draft the pattern tears the sand as it is drawn out of the mould." : "Without draft the part drags and scuffs coming out of the mould."}`,
        fix: `Taper these faces by at least ${fmt(d.warn)}° so they open toward the side they release to${rules.process === "injection" ? "; textured faces need 3° or more" : rules.process === "sand_cast" ? "; otherwise the patternmaker adds draft, which moves these faces" : ""}.`,
        value: worst,
        limit: d.warn,
        marks: warnM.marks,
      });
    } else {
      out.push({ rule: "draft", status: "pass", title: `Draft at least ${fmt(d.warn)}°`, detail: `Every side face tapers along the pull ${pullName}` });
    }
  }
  const uc = c.marks((s) => undercut[s] === 1);
  if (uc.area > 0.5) {
    const alt = bestPull(c, pull, uc.area);
    // side actions in a steel mould, or cores in a sand or wax mould
    const relief = reach.relief ?? "side actions";
    const cost = reach.relief ? "cost" : "tool cost";
    out.push({
      rule: "undercut",
      status: reach.severity === "info" ? "info" : reach.severity,
      title: "Undercuts",
      detail: `${mm2(uc.area)} of surface is hidden from both mould halves (pull ${pullName})${reach.severity === "info" ? ` and needs ${relief}, which you've allowed; each adds ${cost}` : ". The part would lock in the mould"}.`,
      fix:
        reach.severity === "info"
          ? `${alt ? `${alt.detail} ` : ""}Opening these features to the pull direction would save the ${relief} and their cost.`
          : alt
            ? `${alt.detail} Otherwise open these features to the pull direction, or allow ${relief}.`
            : `Open these features to the pull direction (through-holes along the pull, open-sided clips), or allow ${reach.relief ?? "side actions or lifters"} at extra ${cost}.`,
      marks: uc.marks,
      alt,
    });
  } else {
    out.push({ rule: "undercut", status: "pass", title: "No undercuts", detail: `Everything releases straight along ${pullName}${slides.length ? ` or with the ${plural(slides.length, "slide")}` : ""}` });
  }
  const used = slides.filter((sl) => sl.area > 0.5);
  if (used.length) {
    out.push({
      rule: "slides",
      status: "info",
      title: `${plural(used.length, "mould slide")}`,
      detail: `${used.map((sl) => `${mm2(sl.area)} releases with a slide pulled along ${axisName(sl.d)}`).join("; ")}. Each slide is a further steel piece in the mould and adds tool cost.`,
    });
  }
  for (const sl of slides) {
    if (sl.area <= 0.5) out.push({ rule: "slides", status: "warn", title: `Slide along ${axisName(sl.d)} is not needed`, detail: `No face needs the slide pulled along ${axisName(sl.d)}: the mould halves reach everything it would.`, fix: `Remove ${axisName(sl.d)} from slides: to save a mould piece.` });
  }
  return out;
}

// ---------------- moulded composites ----------------

/** What the laminate over the part's outer surface weighs: the part is modelled as its outer surface, hollow inside. */
function layup(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding {
  const { wall, density, plies } = rules.layup!;
  let area = 0;
  for (let s = 0; s < c.samples.length; s++) area += c.sampleArea[s];
  const grams = (area * wall * density) / 1000;
  stats.nominalWall = wall;
  // its own plies: the ply book, ply by ply from the outer surface in
  if (plies)
    return {
      rule: "layup",
      status: "info",
      title: `Laminate about ${fmt(grams, 0)} g, ${plies.count} plies`,
      detail: `Ply book, from the outer surface in: ${plies.lines.join("; ")}${plies.zones.length ? `; then, inside the stack where they lie, ${plies.zones.join("; ")}` : ""}. The ${fmt(wall)} mm stack weighs ${fmt(plies.arealMass, 0)} g/m², about ${fmt(grams, 0)} g over ${fmt(area / 100, 0)} cm² of surface, before ${plies.zones.length ? "the zones' plies, " : ""}metal inserts, filler and paint.`,
      value: grams,
    };
  return {
    rule: "layup",
    status: "info",
    title: `Laminate about ${fmt(grams, 0)} g`,
    detail: `A ${fmt(wall)} mm laminate (about ${Math.max(1, Math.round(wall / 0.12))} plies of 0.12 mm prepreg) over ${fmt(area / 100, 0)} cm² of surface weighs about ${fmt(grams, 0)} g, before metal inserts, filler and paint. The factory's ply book builds it up at joints and round bearings, axles and bolts, and thins it where the load is low.`,
    value: grams,
  };
}

function undercutArea(c: Ctx, axis: V3): number {
  const a = c.clear(axis);
  const b = c.clear([-axis[0], -axis[1], -axis[2]]);
  let area = 0;
  for (let s = 0; s < c.samples.length; s++) if (!a[s] && !b[s]) area += c.sampleArea[s];
  return area;
}

function bestPull(c: Ctx, pull: V3, current: number): Alternative | undefined {
  let best: { axis: V3; area: number } | null = null;
  for (const axis of [AXES[0], AXES[2], AXES[4]]) {
    if (Math.abs(axis[0] * pull[0] + axis[1] * pull[1] + axis[2] * pull[2]) > 0.999) continue;
    const area = undercutArea(c, axis);
    if (!best || area < best.area) best = { axis, area };
  }
  if (!best || best.area > current * 0.5) return undefined;
  return {
    setting: "pull",
    value: best.axis,
    label: `Mould along ${axisName(best.axis)}`,
    detail:
      best.area < 0.5
        ? `Opening the mould along ${axisName(best.axis)} removes every undercut.`
        : `Opening the mould along ${axisName(best.axis)} cuts undercuts from ${mm2(current)} to ${mm2(best.area)}.`,
  };
}

// ---------------- machining setups ----------------

function setups(c: Ctx, rules: Rules): ProcessFinding[] {
  const reach = rules.reach!;
  const masks = reach.dirs.map((d) => c.clear(d));
  const unreached = (s: number, extra: Uint8Array[] = []) => !masks.some((mk) => mk[s]) && !extra.some((mk) => mk[s]);
  const um = c.marks((s) => unreached(s));
  const names = reach.dirs.map(axisName).join(", ");
  if (um.area <= 0.5) return [{ rule: "reach", status: "pass", title: "Every face is reachable", detail: `A tool reaches all surfaces from the ${plural(reach.dirs.length, "setup")} (${names})` }];
  // greedily add the setups that reach the most of what is left
  const added: V3[] = [];
  const extra: Uint8Array[] = [];
  let left = um.area;
  for (let round = 0; round < 3 && left > 0.5; round++) {
    let best: { d: V3; mask: Uint8Array; left: number } | null = null;
    for (const d of AXES) {
      if (reach.dirs.some((r) => sameDir(r, d)) || added.some((r) => sameDir(r, d))) continue;
      const mask = c.clear(d);
      let l = 0;
      for (let s = 0; s < c.samples.length; s++) if (unreached(s, [...extra, mask])) l += c.sampleArea[s];
      if (!best || l < best.left) best = { d, mask, left: l };
    }
    if (!best || best.left >= left - 0.5) break;
    added.push(best.d);
    extra.push(best.mask);
    left = best.left;
  }
  const alt: Alternative | undefined = added.length
    ? {
        setting: "setups",
        value: [...reach.dirs, ...added],
        label: `Add ${added.map(axisName).join(" and ")} ${added.length > 1 ? "setups" : "setup"}`,
        detail:
          left <= 0.5
            ? `Adding ${plural(added.length, "setup")} from ${added.map(axisName).join(", ")} reaches everything.`
            : `Adding setups from ${added.map(axisName).join(", ")} leaves ${mm2(left)} unreachable.`,
      }
    : undefined;
  const internal = left > 0.5;
  return [
    {
      rule: "reach",
      status: reach.severity === "info" ? "info" : reach.severity,
      title: internal && !added.length ? (rules.machining && rules.machining.axes > 3 ? "Undercut no tool direction reaches" : "Undercut a 3-axis tool cannot reach") : "Faces the setups cannot reach",
      detail: `${mm2(um.area)} of surface cannot be reached from ${names}.${internal ? ` ${mm2(left)} is not reachable from any straight direction (an internal undercut).` : ""}`,
      fix: `${alt ? alt.detail + " " : ""}${internal ? "Reshape the hidden features so a straight tool reaches them, split the part, or plan 5-axis machining or a T-slot cutter." : "Each extra setup adds cost; reshaping the feature may avoid it."}`,
      marks: um.marks,
      alt,
    },
  ];
}

// ---------------- inside corners ----------------

function insideCorners(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding[] {
  const ir = rules.innerRadius!;
  let min = ir.min;
  if (ir.factor) {
    const nominal = Math.min(stats.nominalWall ?? weightedPercentile(c.thickness(), c.sampleArea, 0.5), rules.wall?.max ?? Infinity);
    if (Number.isFinite(nominal)) min = Math.max(ir.min, ir.factor * nominal);
  }
  const along = (d: V3) => !ir.dirs || ir.dirs.some((x) => Math.abs(d[0] * x[0] + d[1] * x[1] + d[2] * x[2]) > 0.98);
  const perp = (n: V3) => !ir.dirs || ir.dirs.some((x) => Math.abs(n[0] * x[0] + n[1] * x[1] + n[2] * x[2]) < 0.1);
  // sharp concave edges
  // a drilled hole's bottom (or a counterbore's) is shaped by the drill along the hole, not by an end mill's corner
  const drilled = (f: number) => {
    const x = c.m.faces[f];
    return !!x && x.type === "CYLINDRE" && !!x.fullTurn && !!x.concave;
  };
  const sharp = c.sharpEdges().filter((e) => e.concave && e.angle > 30 && along(e.dir) && (!ir.dirs || (perp(e.n1) && perp(e.n2))) && !drilled(e.f1) && !drilled(e.f2));
  // fillets tighter than the minimum
  const tight = new Set<number>();
  let tightest = Infinity;
  c.m.faces.forEach((f, i) => {
    if (f.type !== "CYLINDRE" || !f.concave || f.fullTurn || f.radius === undefined || !f.axis) return;
    if (!along(f.axis.d)) return;
    if (f.radius < min - 1e-3) {
      tight.add(i);
      tightest = Math.min(tightest, f.radius);
    }
  });
  const scope = ir.dirs ? `along the tool axis (${ir.dirs.map(axisName).join(", ")})` : "";
  if (!sharp.length && !tight.size) {
    return [
      {
        rule: "inside-corners",
        status: "pass",
        title: `Inside corners R${fmt(min)} or more`,
        detail: ir.dirs ? `Every inside corner ${scope} has a radius the tool can cut` : "No sharp inside corners",
      },
    ];
  }
  const corners = chains(sharp);
  const length = sharp.reduce((s, e) => s + e.len, 0);
  const parts: string[] = [];
  if (corners) parts.push(ir.dirs ? plural(corners, "sharp inside corner") : `${plural(corners, "sharp inside edge")} (${fmt(length, 0)} mm in all)`);
  if (tight.size) parts.push(`${plural(tight.size, "fillet")} as tight as R${fmt(tightest)}`);
  const fm = c.faceMarks(tight);
  return [
    {
      rule: "inside-corners",
      status: ir.severity,
      title: corners ? (ir.dirs ? "Sharp inside corners" : "Sharp inside edges") : `Inside corners under R${fmt(min)}`,
      detail: `${parts.join(" and ")}${scope ? " " + scope : ""}. ${cap(ir.why)}.`,
      fix: `Round ${corners + tight.size > 1 ? "these" : "this"} to at least R${fmt(min * (ir.dirs ? 1.1 : 1), 1)}${ir.dirs ? " (a little over the tool radius cuts cleaner)" : ""}.`,
      value: corners ? 0 : tightest,
      limit: min,
      marks: fm.tris ? fm.marks : undefined,
      lines: sharp.length ? lineMarks(sharp) : undefined,
    },
  ];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------- narrow slots and deep pockets ----------------

function gaps(c: Ctx, rules: Rules): ProcessFinding[] {
  const g = rules.gap!;
  const gap = c.gap();
  const { tn } = c;
  const wallish = (t: number) => g.dirs.some((d) => Math.abs(dot(tn, d, t * 4)) < 0.2);
  const narrow = (s: number) => {
    const t = c.samples[s];
    const f = c.face(t);
    if (f.type === "CYLINDRE" && f.fullTurn) return false; // drilled holes
    return wallish(t) && gap[s] < g.min - 1e-3;
  };
  const out: ProcessFinding[] = [];
  const nm = c.marks((s) => narrow(s));
  let w = Infinity;
  for (let s = 0; s < c.samples.length; s++) if (narrow(s)) w = Math.min(w, gap[s]);
  if (nm.area > 0.5) {
    out.push({
      rule: "narrow",
      status: "fail",
      title: `Slots narrower than Ø${fmt(g.min)} tool`,
      detail: `Gaps as narrow as ${fmt(w)} mm: a Ø${fmt(g.min)} mm end mill cannot get in.`,
      fix: `Widen these slots to at least ${fmt(g.min)} mm, or allow a smaller tool (tool_d: ${fmt(Math.max(0.5, Math.floor(w * 2) / 2))}) at the cost of slower cutting.`,
      value: w,
      limit: g.min,
      marks: nm.marks,
    });
  } else {
    out.push({ rule: "narrow", status: "pass", title: `Slots fit a Ø${fmt(g.min)} tool`, detail: "Every slot and pocket is wide enough to cut" });
  }
  return out;
}

// ---------------- 3D printing overhangs ----------------

/** Downward faces this close to the bed (mm) need no support. */
const NEAR_BED = 0.5;

/** Flat ceilings up to this wide (mm) bridge without support, unless the process says otherwise. */
const BRIDGE_SPAN = 10;

function overhangArea(c: Ctx, b: V3, o: NonNullable<Rules["overhang"]>, flag?: Uint8Array): { area: number; contact: number; bridged: number } {
  const { tn, tc, m } = c;
  let minB = Infinity;
  for (let i = 0; i < m.pos.length; i += 3) minB = Math.min(minB, m.pos[i] * b[0] + m.pos[i + 1] * b[1] + m.pos[i + 2] * b[2]);
  const sinMax = Math.sin(o.max * DEG);
  const bridgeFace = new Map<number, boolean>();
  let area = 0;
  let contact = 0;
  let bridged = 0;
  for (let t = 0; t < c.n; t++) {
    const down = -dot(tn, b, t * 4);
    const a = tn[t * 4 + 3];
    const h = tc[t * 3] * b[0] + tc[t * 3 + 1] * b[1] + tc[t * 3 + 2] * b[2] - minB;
    if (down > 0.999 && h < 0.05) {
      contact += a;
      continue;
    }
    // the first layers squash onto the bed, so a small fillet or chamfer along the bottom edge prints without support
    if (down <= sinMax + 1e-6 || h < NEAR_BED) continue;
    const fi = m.faceOf[t];
    let ok = bridgeFace.get(fi);
    if (ok === undefined) {
      ok = bridgeable(c, m.faces[fi], b, o.bridgeR, o.span ?? BRIDGE_SPAN);
      bridgeFace.set(fi, ok);
    }
    if (ok) {
      bridged += a;
      continue;
    }
    area += a;
    if (flag) flag[t] = 1;
  }
  return { area, contact, bridged };
}

/** Faces a printer can bridge or arch over without support: small horizontal holes, short flat spans. */
function bridgeable(c: Ctx, f: FaceInfo, b: V3, bridgeR: number, span: number): boolean {
  if (f.type === "CYLINDRE" && f.concave && f.radius !== undefined && f.radius <= bridgeR && f.axis && Math.abs(dot(f.axis.d, b)) < 0.05) return true;
  if (f.type === "PLANE" && f.normal && -dot(f.normal, b) > 0.999) return minWidth(c, f, b) <= span;
  return false;
}

/** Smallest in-plane extent of a planar face across 12 directions (its span for bridging). */
function minWidth(c: Ctx, f: FaceInfo, n: V3): number {
  const u: V3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const a: V3 = norm(cross(n, u));
  const bb: V3 = cross(n, a);
  let best = Infinity;
  for (let k = 0; k < 12; k++) {
    const th = (k * Math.PI) / 12;
    const d: V3 = [a[0] * Math.cos(th) + bb[0] * Math.sin(th), a[1] * Math.cos(th) + bb[1] * Math.sin(th), a[2] * Math.cos(th) + bb[2] * Math.sin(th)];
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = f.start; t < f.start + f.count; t++)
      for (let j = 0; j < 3; j++) {
        const v = c.m.idx[t * 3 + j] * 3;
        const p = c.m.pos[v] * d[0] + c.m.pos[v + 1] * d[1] + c.m.pos[v + 2] * d[2];
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
    best = Math.min(best, hi - lo);
  }
  return best;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(v: V3): V3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function overhangs(c: Ctx, rules: Rules): ProcessFinding[] {
  const o = rules.overhang!;
  const flag = new Uint8Array(c.n);
  const cur = overhangArea(c, o.build, o, flag);
  const out: ProcessFinding[] = [];
  // the best of the six axis orientations: least support, then most bed contact
  let best: { b: V3; area: number; contact: number } | null = null;
  for (const b of AXES) {
    const r = sameDir(b, o.build) ? cur : overhangArea(c, b, o);
    if (!best || r.area < best.area - 1 || (Math.abs(r.area - best.area) <= 1 && r.contact > best.contact)) best = { b, area: r.area, contact: r.contact };
  }
  const better = best && !sameDir(best.b, o.build) && cur.area > 20 && best.area < cur.area * 0.6 && best.contact > 0;
  const alt: Alternative | undefined = better
    ? {
        setting: "build",
        value: best!.b,
        label: `Print with ${axisName(best!.b)} up`,
        detail: `Printing with ${axisName(best!.b)} as the build direction cuts supported area from ${mm2(cur.area)} to ${mm2(best!.area)}.`,
      }
    : undefined;
  if (cur.area > 5) {
    const m = c.marks((_s, t) => flag[t] === 1);
    out.push({
      rule: "overhang",
      status: o.severity,
      title: o.severity === "fail" ? "Overhangs without support" : "Needs support material",
      detail: `${mm2(cur.area)} of downward surface is steeper than ${fmt(o.max)}° from vertical (build direction ${axisName(o.build)}). ${rules.process === "metal_print" ? "Metal supports are cut or machined away afterwards and leave rough marks." : "Supports leave rough marks and add print time."}`,
      fix: alt
        ? `${alt.detail} Or chamfer ledges at 45° and use teardrop holes.`
        : "Chamfer the undersides of ledges to 45°, turn wide flat ceilings into 45° roofs, or split the part so each piece prints flat side down.",
      value: cur.area,
      marks: m.marks,
      alt,
    });
  } else {
    out.push({
      rule: "overhang",
      status: "pass",
      title: "Prints without support",
      detail: `No overhang steeper than ${fmt(o.max)}°${cur.bridged > 1 ? `; ${mm2(cur.bridged)} of short bridges and small holes print as bridges` : ""}`,
    });
  }
  if (rules.bedContact) {
    let foot = 0;
    const b = rules.bedContact.build;
    const ax = Math.abs(b[0]) > 0.99 ? 0 : Math.abs(b[1]) > 0.99 ? 1 : 2;
    const ext = [c.hi[0] - c.lo[0], c.hi[1] - c.lo[1], c.hi[2] - c.lo[2]].filter((_, i) => i !== ax);
    foot = ext[0] * ext[1];
    if (cur.contact < Math.max(10, 0.05 * foot)) {
      out.push({
        rule: "bed",
        status: "warn",
        title: "Small contact with the bed",
        detail: `Only ${mm2(cur.contact)} of flat face touches the bed. The print can tip or lift.`,
        fix: alt ? alt.detail : "Add a flat face on the bottom, print on a brim, or reorient the part so a large flat face is down.",
        value: cur.contact,
        alt,
      });
    }
  }
  return out;
}

// ---------------- turning ----------------

function turning(c: Ctx, rules: Rules): ProcessFinding[] {
  const rv = rules.revolve!;
  const a = rv.axis;
  const faces = c.m.faces;
  // axis line: through the largest coaxial-candidate surface
  let p0: V3 = [(c.lo[0] + c.hi[0]) / 2, (c.lo[1] + c.hi[1]) / 2, (c.lo[2] + c.hi[2]) / 2];
  let bestArea = 0;
  for (const f of faces) {
    if (f.type === "CYLINDRE" && f.axis && Math.abs(dot(f.axis.d, a)) > 0.999 && f.area > bestArea) {
      bestArea = f.area;
      p0 = f.axis.p;
    }
  }
  const tol = Math.max(0.01, c.diag * 1e-4);
  const onAxis = (p: V3) => {
    const r: V3 = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
    const s = dot(r, a);
    return Math.hypot(r[0] - a[0] * s, r[1] - a[1] * s, r[2] - a[2] * s) < tol;
  };
  // any surface of revolution about the axis has every normal in a plane through the axis
  const meridian = (f: FaceInfo) => {
    let err = 0;
    let area = 0;
    for (let t = f.start; t < f.start + f.count; t++) {
      const w = c.tn[t * 4 + 3];
      const n: V3 = [c.tn[t * 4], c.tn[t * 4 + 1], c.tn[t * 4 + 2]];
      const r: V3 = [c.tc[t * 3] - p0[0], c.tc[t * 3 + 1] - p0[1], c.tc[t * 3 + 2] - p0[2]];
      const s = dot(r, a);
      const radial: V3 = [r[0] - a[0] * s, r[1] - a[1] * s, r[2] - a[2] * s];
      const rl = Math.hypot(...radial);
      if (rl < tol) continue;
      // the normal's component around the axis, which a revolved surface does not have
      const tang = (a[1] * radial[2] - a[2] * radial[1]) * n[0] + (a[2] * radial[0] - a[0] * radial[2]) * n[1] + (a[0] * radial[1] - a[1] * radial[0]) * n[2];
      err += Math.abs(tang / rl) * w;
      area += w;
    }
    return area <= 0 || err / area < 0.1;
  };
  const bad = new Set<number>();
  faces.forEach((f, i) => {
    let ok = false;
    if (f.type === "PLANE") ok = !!f.normal && Math.abs(dot(f.normal, a)) > 0.999;
    else if (f.type === "CYLINDRE") ok = !!f.axis && Math.abs(dot(f.axis.d, a)) > 0.999 && onAxis(f.axis.p);
    else if (f.type === "SPHERE") ok = !!f.axis && onAxis(f.axis.p);
    else ok = meridian(f);
    if (!ok) bad.add(i);
  });
  const out: ProcessFinding[] = [];
  const total = faces.reduce((s, f) => s + f.area, 0);
  if (bad.size) {
    const m = c.faceMarks(bad);
    const major = m.area > 0.5 * total;
    if (!major && rv.liveTools) {
      out.push({
        rule: "revolve",
        status: "info",
        title: "Milled on the lathe's live tools",
        detail: `${plural(bad.size, "face")} (${mm2(m.area)}) ${bad.size === 1 ? "does" : "do"} not revolve about ${axisName(a)}: flats, cross holes or off-axis features, milled by the live tooling in the same setup.`,
        fix: "Nothing to change; each one adds a little cycle time.",
        marks: m.marks,
      });
      return out.concat(turningSize(c, rv, p0));
    }
    out.push({
      rule: "revolve",
      status: major ? "fail" : "warn",
      title: major ? "Not a turned shape" : "Needs a second operation",
      detail: `${plural(bad.size, "face")} (${mm2(m.area)}) ${bad.size === 1 ? "does" : "do"} not revolve about the spindle axis ${axisName(a)}: flats, cross holes or off-axis features.`,
      fix: major
        ? "Mill this part instead (process cnc_mill), or turn the axis setting to the part's round axis."
        : "These need milling or cross drilling after turning (a mill-turn machine does both). Remove them if they are not needed.",
      marks: m.marks,
    });
  } else {
    out.push({ rule: "revolve", status: "pass", title: "Every surface turns", detail: `All faces revolve about ${axisName(a)}` });
  }
  return out.concat(turningSize(c, rv, p0));
}

/** Size, slenderness and bores of a turned part. */
function turningSize(c: Ctx, rv: NonNullable<Rules["revolve"]>, p0: V3): ProcessFinding[] {
  const a = rv.axis;
  const faces = c.m.faces;
  const out: ProcessFinding[] = [];
  const tol = Math.max(0.01, c.diag * 1e-4);
  const onAxis = (p: V3) => {
    const r: V3 = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
    const s = dot(r, a);
    return Math.hypot(r[0] - a[0] * s, r[1] - a[1] * s, r[2] - a[2] * s) < tol;
  };
  // size and slenderness
  let rMax = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < c.m.pos.length; i += 3) {
    const r: V3 = [c.m.pos[i] - p0[0], c.m.pos[i + 1] - p0[1], c.m.pos[i + 2] - p0[2]];
    const s = dot(r, a);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
    rMax = Math.max(rMax, Math.hypot(r[0] - a[0] * s, r[1] - a[1] * s, r[2] - a[2] * s));
  }
  const L = hi - lo;
  const D = 2 * rMax;
  if (D > rv.maxD || L > rv.maxLength) {
    out.push({
      rule: "envelope",
      status: "fail",
      title: "Too big for the lathe",
      detail: `Ø${fmt(D, 1)} × ${fmt(L, 1)} mm; the machine takes Ø${fmt(rv.maxD)} × ${fmt(rv.maxLength)} mm.`,
      fix: "Use a larger lathe (set max_d / max_length) or split the part.",
    });
  } else {
    out.push({ rule: "envelope", status: "pass", title: "Fits the lathe", detail: `Ø${fmt(D, 1)} × ${fmt(L, 1)} mm` });
  }
  const slender = L / Math.max(D, 1e-6);
  if (slender > rv.maxSlender)
    out.push({
      rule: "slender",
      status: "warn",
      title: "Long and slender",
      detail: `${fmt(slender, 1)}× longer than its diameter (over ${rv.maxSlender}× bends away from the tool).`,
      fix: "Support it with a tailstock or steady rest (note it on the drawing), shorten it, or thicken it.",
      value: slender,
      limit: rv.maxSlender,
    });
  const bores = new Set<number>();
  let worst = 0;
  faces.forEach((f, i) => {
    if (f.type !== "CYLINDRE" || !f.concave || !f.fullTurn || !f.axis || !f.radius || !f.length) return;
    if (Math.abs(dot(f.axis.d, a)) < 0.999 || !onAxis(f.axis.p)) return;
    const r = f.length / (2 * f.radius);
    if (r > rv.maxBoreRatio) {
      bores.add(i);
      worst = Math.max(worst, r);
    }
  });
  if (bores.size)
    out.push({
      rule: "bore",
      status: "warn",
      title: "Deep bores",
      detail: `${plural(bores.size, "bore")} up to ${fmt(worst, 1)}× deeper than wide (over ${rv.maxBoreRatio}× needs long boring bars that chatter).`,
      fix: "Bore from both ends, enlarge the bore, or shorten it.",
      value: worst,
      limit: rv.maxBoreRatio,
      marks: c.faceMarks(bores).marks,
    });
  return out;
}

// ---------------- sheet metal ----------------

function modeThickness(c: Ctx, keep: (s: number) => boolean): number {
  const th = c.thickness();
  const bins = new Map<number, number>();
  for (let s = 0; s < th.length; s++) {
    if (!keep(s) || !(th[s] > 0) || th[s] > 50) continue;
    const k = Math.round(th[s] / 0.02);
    bins.set(k, (bins.get(k) ?? 0) + c.sampleArea[s]);
  }
  let best = -1;
  let bestW = 0;
  for (const [k, w] of bins) {
    const around = w + (bins.get(k - 1) ?? 0) + (bins.get(k + 1) ?? 0);
    if (around > bestW) {
      bestW = around;
      best = k;
    }
  }
  if (best < 0) return NaN;
  // refine: weighted median of the samples near the peak
  const near = new Float64Array(th.length).fill(NaN);
  for (let s = 0; s < th.length; s++) if (keep(s) && Math.abs(th[s] - best * 0.02) <= 0.05 + 0.03 * best * 0.02) near[s] = th[s];
  const med = weightedPercentile(near, c.sampleArea, 0.5);
  return Math.round((Number.isFinite(med) ? med : best * 0.02) * 100) / 100;
}

function sheet(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding[] {
  const sh = rules.sheet!;
  const faces = c.m.faces;
  const out: ProcessFinding[] = [];
  const t =
    sh.t ??
    modeThickness(c, (s) => {
      const f = c.face(c.samples[s]);
      return f.type === "PLANE" || f.type === "CYLINDRE";
    });
  if (!Number.isFinite(t)) return [{ rule: "sheet", status: "fail", title: "No sheet thickness found", detail: "The part has no pair of parallel faces a constant distance apart." }];
  stats.sheetT = t;
  const th = c.thickness();
  const tol = Math.max(0.05, 0.1 * t);
  // skins measure t straight through; edge faces (the outline, hole walls) are strips t wide
  const median = (vals: number[]) => (vals.length ? vals.sort((a, b) => a - b)[vals.length >> 1] : NaN);
  const perFace = faces.map(() => [] as number[]);
  const faceSamples = faces.map(() => [] as number[]);
  for (let s = 0; s < th.length; s++) {
    const fi = c.m.faceOf[c.samples[s]];
    if (Number.isFinite(th[s])) perFace[fi].push(th[s]);
    faceSamples[fi].push(s);
  }
  // a sheet() part's own forms are judged as forms: its louvres are pressed after the blank is cut (the design checks
  // cover their room and depth), and its hems are folded back flat on purpose
  const forms = sh.forms;
  const inLouvre = (x: number, y: number, z: number) =>
    !!forms?.louvres.some((b) => b.axes.every((a, k) => Math.abs((x - b.c[0]) * a[0] + (y - b.c[1]) * a[1] + (z - b.c[2]) * a[2]) <= b.half[k]));
  const louvreFace = faces.map((f) => {
    if (!forms?.louvres.length) return false;
    for (let tri = f.start; tri < f.start + f.count; tri++) if (!inLouvre(c.tc[tri * 3], c.tc[tri * 3 + 1], c.tc[tri * 3 + 2])) return false;
    return true;
  });
  const hemR = forms?.hems ?? [];
  const about = (r: number, want: number) => Math.abs(r - want) <= Math.max(0.02, 0.05 * want);
  const hemFace = faces.map((f) => f.type === "CYLINDRE" && !f.fullTurn && f.radius !== undefined && hemR.some((r) => about(f.radius!, r) || about(f.radius!, r + t)));
  const role: ("skin" | "edge" | "bad" | "form")[] = faces.map((f, i) => {
    if (louvreFace[i] || hemFace[i]) return "form";
    if (Math.abs(median(perFace[i]) - t) <= tol) return "skin";
    if (f.type === "CYLINDRE" && f.length !== undefined && Math.abs(f.length - t) <= tol) return "edge";
    if (f.type === "PLANE") {
      const list = faceSamples[i];
      const step = Math.max(1, Math.floor(list.length / 24));
      const widths: number[] = [];
      for (let k = 0; k < list.length; k += step) widths.push(stripWidth(c, list[k]));
      if (Math.abs(median(widths) - t) <= Math.max(tol, 0.15 * t)) return "edge";
    }
    return "bad";
  });
  const flatBad = new Set<number>();
  faces.forEach((f, i) => {
    if (role[i] !== "form" && f.type !== "PLANE" && f.type !== "CYLINDRE") flatBad.add(i);
  });
  if (flatBad.size) {
    out.push({
      rule: "flatten",
      status: "fail",
      title: "Surfaces that cannot be flattened",
      detail: `${plural(flatBad.size, "face")} ${flatBad.size === 1 ? "is" : "are"} not flat or a simple cylindrical bend (${[...new Set([...flatBad].map((i) => faces[i].type.toLowerCase()))].join(", ")}).`,
      fix: "Sheet metal is flat faces joined by cylindrical bends. Replace these surfaces, or make this part another way.",
      marks: c.faceMarks(flatBad).marks,
    });
  }
  const thick = new Set<number>();
  role.forEach((r, i) => r === "bad" && !flatBad.has(i) && thick.add(i));
  if (thick.size) {
    out.push({
      rule: "sheet-uniform",
      status: "fail",
      title: "Not one sheet thickness",
      detail: `${plural(thick.size, "face")} ${thick.size === 1 ? "belongs" : "belong"} to features thicker or thinner than the ${fmt(t)} mm sheet (bosses, ribs, pockets or solid blocks).`,
      fix: `Make every wall ${fmt(t)} mm. Replace bosses with PEM press-in nuts or standoffs, and pockets with cut-outs.`,
      marks: c.faceMarks(thick).marks,
    });
  } else if (!flatBad.size) {
    out.push({ rule: "sheet-uniform", status: "pass", title: `One ${fmt(t)} mm sheet`, detail: "Every wall is the same thickness" });
  }
  // bends
  const bendR = sh.bendR ?? sh.bendFactor * t;
  const tight = new Set<number>();
  let tightest = Infinity;
  faces.forEach((f, i) => {
    if (f.type === "CYLINDRE" && f.concave && !f.fullTurn && role[i] === "skin" && f.radius !== undefined && f.radius < bendR * 0.98 - 1e-3) {
      tight.add(i);
      tightest = Math.min(tightest, f.radius);
    }
  });
  const sharp = c.sharpEdges().filter((e) => e.concave && role[e.f1] === "skin" && role[e.f2] === "skin");
  const bendFaces = faces.filter((f, i) => f.type === "CYLINDRE" && f.concave && !f.fullTurn && role[i] === "skin").length;
  stats.bends = bendFaces + chains(sharp) + hemR.length;
  if (tight.size || sharp.length) {
    const n = chains(sharp);
    out.push({
      rule: "bend-radius",
      status: "fail",
      title: sharp.length ? "Bends with no inside radius" : `Bends tighter than R${fmt(bendR)}`,
      detail: `${[n ? plural(n, "sharp bend") : "", tight.size ? `${plural(tight.size, "bend")} as tight as R${fmt(tightest)}` : ""].filter(Boolean).join(" and ")}. ${rules.material} needs an inside radius of at least ${fmt(bendR)} mm (${fmt(bendR / t, 1)}× the thickness) or it cracks.`,
      fix: `Give every bend an inside radius of ${fmt(bendR)} mm and an outside radius of ${fmt(bendR + t)} mm.`,
      value: sharp.length ? 0 : tightest,
      limit: bendR,
      marks: tight.size ? c.faceMarks(tight).marks : undefined,
      lines: sharp.length ? lineMarks(sharp) : undefined,
    });
  } else {
    const bends = bendFaces;
    out.push({ rule: "bend-radius", status: "pass", title: bends ? `Bends R${fmt(bendR)} or more` : "Flat sheet", detail: bends ? `${plural(bends, "bend")}, all at a safe radius` : "No bends" });
  }
  // hems: folded flat (closed) is fine in soft sheet and cracks along the fold in the hard alloys
  if (hemR.length) {
    const closed = hemR.filter((r) => r < 0.5 * t).length;
    const open = hemR.length - closed;
    const brittle = /6061|7075|2024|4140|A3[58]\d/.test(rules.material);
    if (closed && brittle)
      out.push({
        rule: "hem",
        status: "warn",
        title: `${closed === 1 ? "A closed hem" : "Closed hems"} in ${rules.material}`,
        detail: `${plural(closed, "hem")} ${closed === 1 ? "is" : "are"} folded back flat, and ${rules.material} cracks along a fold that tight.`,
        fix: `Open ${closed === 1 ? "it" : "them"} into a teardrop with hem_gap: (at least ${fmt(t)} mm), or make the part from Aluminum 5052 or mild steel.`,
      });
    else
      out.push({
        rule: "hem",
        status: "pass",
        title: plural(hemR.length, "hem"),
        detail: `${[closed ? `${plural(closed, "hem")} folded back flat` : "", open ? `${plural(open, "open hem")}` : ""].filter(Boolean).join(" and ")}: ${rules.material} takes ${closed ? "a closed hem" : "them"} without cracking, and each is two hits on the brake`,
      });
  }
  const louvres = forms?.louvres.length ?? 0;
  if (louvres) out.push({ rule: "louvre", status: "pass", title: plural(louvres, "louvre"), detail: "Pressed with a louvre tool after the blank is cut, so the flat is plain sheet there; the design checks cover the room round each and how deep it goes" });
  // the press brake: bend length and sheet thickness
  if (sh.brake && stats.bends) {
    let longest = 0;
    const long = new Set<number>();
    faces.forEach((f, i) => {
      if (f.type !== "CYLINDRE" || !f.concave || f.fullTurn || role[i] !== "skin" || !f.length) return;
      longest = Math.max(longest, f.length);
      if (f.length > sh.brake! + 1e-6) long.add(i);
    });
    // a sharp bend (flagged above) is still bent on the brake once it has its radius
    const sharpLong = chainLengths(sharp).filter((l) => l > sh.brake! + 1e-6);
    for (const l of chainLengths(sharp)) longest = Math.max(longest, l);
    const brake = rules.machine ? `the ${rules.machine}` : "a typical press brake";
    if (long.size || sharpLong.length)
      out.push({
        rule: "brake",
        status: "fail",
        title: "Bend longer than the press brake",
        detail: `A ${fmt(longest, 0)} mm long bend; ${brake} bends up to ${fmt(sh.brake, 0)} mm.`,
        fix: "Shorten the bend, break it into separate flanges with relief cuts, or use a longer brake.",
        value: longest,
        limit: sh.brake,
        marks: long.size ? c.faceMarks(long).marks : undefined,
        lines: sharpLong.length ? lineMarks(sharp) : undefined,
      });
    if (sh.maxT && t > sh.maxT + 1e-6)
      out.push({
        rule: "brake",
        status: "fail",
        title: "Sheet too thick for the press brake",
        detail: `${fmt(t)} mm ${rules.material}; ${brake} bends up to ${fmt(sh.maxT)} mm of it.`,
        fix: "Use thinner sheet and stiffen it with a return flange or bead, or use a bigger brake.",
        value: t,
        limit: sh.maxT,
      });
    if (!long.size && !sharpLong.length && !(sh.maxT && t > sh.maxT + 1e-6)) out.push({ rule: "brake", status: "pass", title: "Fits the press brake", detail: `Longest bend ${fmt(longest, 0)} mm in ${fmt(t)} mm sheet, within ${fmt(sh.brake, 0)} mm and ${fmt(sh.maxT ?? 0)} mm` });
  }
  // holes close to edges and bends
  const holeFaces = faces.map((f, i) => (f.type === "CYLINDRE" && f.concave && f.fullTurn && role[i] === "edge" ? i : -1)).filter((i) => i >= 0);
  const edgeOrBend = (tri: number) => {
    const fi = c.m.faceOf[tri];
    const f = faces[fi];
    return !holeFaces.includes(fi) && (role[fi] === "edge" || (f.type === "CYLINDRE" && !f.fullTurn && role[fi] === "skin"));
  };
  const close = new Set<number>();
  let closest = Infinity;
  const limit = sh.holeEdge * t;
  for (const hf of holeFaces) {
    const f = faces[hf];
    let dmin = Infinity;
    for (let tri = f.start; tri < f.start + f.count; tri++)
      for (let k = 0; k < 3; k++) {
        const v = c.m.idx[tri * 3 + k] * 3;
        dmin = Math.min(dmin, c.bvh.nearest(c.m.pos[v], c.m.pos[v + 1], c.m.pos[v + 2], limit, edgeOrBend));
      }
    if (dmin < limit - 1e-3) {
      close.add(hf);
      closest = Math.min(closest, dmin);
    }
  }
  if (close.size)
    out.push({
      rule: "hole-edge",
      status: "warn",
      title: "Holes close to an edge or bend",
      detail: `${plural(close.size, "hole")} ${close.size === 1 ? "sits" : "sit"} ${fmt(closest)} mm from an edge or bend; keep at least ${fmt(limit)} mm (${sh.holeEdge}× thickness) or they tear and distort.`,
      fix: `Move these holes at least ${fmt(limit)} mm from edges and bends, or add a relief cut.`,
      value: closest,
      limit,
      marks: c.faceMarks(close).marks,
    });
  return out;
}

/** Narrowest chord through the material just behind a planar sample, across the face: a sheet's edge strip is t wide. */
function stripWidth(c: Ctx, s: number): number {
  const t = c.samples[s];
  const n: V3 = [c.tn[t * 4], c.tn[t * 4 + 1], c.tn[t * 4 + 2]];
  const e = 2 * c.eps;
  const p: V3 = [c.tc[t * 3] - n[0] * e, c.tc[t * 3 + 1] - n[1] * e, c.tc[t * 3 + 2] - n[2] * e];
  const a = norm(cross(n, Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]));
  const b = cross(n, a);
  let best = Infinity;
  for (let k = 0; k < 8; k++) {
    const th = (k * Math.PI) / 8;
    const d: V3 = [a[0] * Math.cos(th) + b[0] * Math.sin(th), a[1] * Math.cos(th) + b[1] * Math.sin(th), a[2] * Math.cos(th) + b[2] * Math.sin(th)];
    const h1 = c.bvh.raycast(p[0], p[1], p[2], d[0], d[1], d[2], 0, Infinity, t);
    const h2 = c.bvh.raycast(p[0], p[1], p[2], -d[0], -d[1], -d[2], 0, Infinity, t);
    if (h1 && h2) best = Math.min(best, h1.t + h2.t);
  }
  return best;
}

// ---------------- flat profile cutting ----------------

function profile(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding[] {
  const pr = rules.profile!;
  const { tn, tc } = c;
  let N = pr.normal;
  if (!N) {
    let best = -1;
    for (const ax of [AXES[0], AXES[2], AXES[4]]) {
      let a = 0;
      for (let t = 0; t < c.n; t++) if (Math.abs(dot(tn, ax, t * 4)) > 0.999) a += tn[t * 4 + 3];
      if (a > best) {
        best = a;
        N = ax;
      }
    }
  }
  const n = N!;
  const out: ProcessFinding[] = [];
  const bevel = c.marks((_s, t) => {
    const d = Math.abs(dot(tn, n, t * 4));
    return d > 0.01 && d < 0.999;
  });
  // levels of the faces parallel to the plate
  const levels: { h: number; area: number }[] = [];
  for (let t = 0; t < c.n; t++) {
    if (Math.abs(dot(tn, n, t * 4)) <= 0.999) continue;
    const h = tc[t * 3] * n[0] + tc[t * 3 + 1] * n[1] + tc[t * 3 + 2] * n[2];
    const l = levels.find((x) => Math.abs(x.h - h) < 0.01);
    if (l) l.area += tn[t * 4 + 3];
    else levels.push({ h, area: tn[t * 4 + 3] });
  }
  levels.sort((a, b) => a.h - b.h);
  const t = pr.t ?? (levels.length >= 2 ? levels[levels.length - 1].h - levels[0].h : NaN);
  stats.sheetT = t;
  const lo = levels[0]?.h ?? 0;
  const hi = levels[levels.length - 1]?.h ?? 0;
  const steps = c.marks((_s, tri) => {
    if (Math.abs(dot(tn, n, tri * 4)) <= 0.999) return false;
    const h = tc[tri * 3] * n[0] + tc[tri * 3 + 1] * n[1] + tc[tri * 3 + 2] * n[2];
    return Math.abs(h - lo) > 0.01 && Math.abs(h - hi) > 0.01;
  });
  if (bevel.area > 0.5 || steps.area > 0.5) {
    out.push({
      rule: "flat-profile",
      status: "fail",
      title: "Not a flat profile",
      detail:
        [bevel.area > 0.5 ? `${mm2(bevel.area)} of sloped or curved surface` : "", steps.area > 0.5 ? `pockets or steps at ${plural(levels.length - 2, "extra level")}` : ""]
          .filter(Boolean)
          .join(" and ") + `. A ${rules.process === "laser_cut" ? "laser" : "cutter"} cuts straight through the plate along ${axisName(n)}.`,
      fix: "Keep every edge square to the plate and cut all the way through. Machine pockets and chamfers afterwards (CNC), or use a different process.",
      marks: Float32Array.from([...bevel.marks, ...steps.marks]),
    });
  } else {
    out.push({ rule: "flat-profile", status: "pass", title: `Flat ${fmt(t)} mm profile`, detail: `Cut straight through along ${axisName(n)}` });
  }
  const cutter = rules.cutter;
  const tool = !cutter || cutter.source === "any" ? "laser" : cutter.source === "waterjet" ? "waterjet" : cutter.source === "plasma" ? "plasma cutter" : `${cutter.source === "co2" ? "CO2" : cutter.source} laser`;
  const named = rules.machine ? `the ${rules.machine}` : `a typical ${tool}`;
  if (cutter && t > cutter.maxT + 1e-6)
    out.push({
      rule: "plate-thickness",
      status: "fail",
      title: `Plate too thick for the ${tool}`,
      detail: `${fmt(t)} mm plate; ${named} cuts up to ${fmt(cutter.maxT)} mm.`,
      fix: "Use thinner plate, or have it waterjet cut or milled.",
      value: t,
      limit: cutter.maxT,
    });
  else if (t > pr.maxT)
    out.push({
      rule: "plate-thickness",
      status: "warn",
      title: `Plate too thick to ${tool === "waterjet" || tool === "plasma cutter" ? "cut" : "laser"} cleanly`,
      detail: `${fmt(t)} mm ${rules.material} is over the ${fmt(pr.maxT)} mm a ${tool} cuts cleanly.`,
      fix: "Waterjet or mill it, or use thinner plate.",
      value: t,
      limit: pr.maxT,
    });
  if (cutter) {
    // the outline must fit the bed in some orientation
    const [u0, v0] = perpPair(n);
    let fit: { w: number; h: number } | null = null;
    let smallest: { w: number; h: number } | null = null;
    for (let k = 0; k < 18; k++) {
      const th = (k * Math.PI) / 36;
      const u: V3 = [u0[0] * Math.cos(th) + v0[0] * Math.sin(th), u0[1] * Math.cos(th) + v0[1] * Math.sin(th), u0[2] * Math.cos(th) + v0[2] * Math.sin(th)];
      const v = cross(n, u);
      let lu = Infinity,
        hu = -Infinity,
        lv = Infinity,
        hv = -Infinity;
      for (let i = 0; i < c.m.pos.length; i += 3) {
        const pu = c.m.pos[i] * u[0] + c.m.pos[i + 1] * u[1] + c.m.pos[i + 2] * u[2];
        const pv = c.m.pos[i] * v[0] + c.m.pos[i + 1] * v[1] + c.m.pos[i + 2] * v[2];
        lu = Math.min(lu, pu);
        hu = Math.max(hu, pu);
        lv = Math.min(lv, pv);
        hv = Math.max(hv, pv);
      }
      const dims = [hu - lu, hv - lv].sort((a, b) => b - a);
      const box = { w: dims[0], h: dims[1] };
      if (!smallest || box.w * box.h < smallest.w * smallest.h) smallest = box;
      const bed = [...cutter.bed].sort((a, b) => b - a);
      if (box.w <= bed[0] + 1e-6 && box.h <= bed[1] + 1e-6) {
        fit = box;
        break;
      }
    }
    if (!fit && smallest)
      out.push({
        rule: "cut-bed",
        status: "fail",
        title: `Too big for the ${tool}'s bed`,
        detail: `The outline is ${fmt(smallest.w, 0)} × ${fmt(smallest.h, 0)} mm; ${named} cuts up to ${fmt(cutter.bed[0], 0)} × ${fmt(cutter.bed[1], 0)} mm.`,
        fix: "Split the plate into pieces that join with tabs or a lap joint, or use a bigger machine.",
      });
    if (cutter.status !== "pass")
      out.push({
        rule: "cutter-material",
        status: cutter.status,
        title: cutter.status === "fail" ? `The ${tool} cannot cut ${rules.material}` : `Rough cut in ${rules.material}`,
        detail: `${cap(cutter.why)}.`,
        fix: cutter.status === "fail" ? `Order it cut by a shop with a ${isMetal(rules.material) ? "fiber laser, waterjet or plasma" : "CO2 laser or waterjet"}, or choose a material the ${tool} cuts.` : "Expect to clean up the edges, or have it waterjet cut.",
      });
  }
  // narrow webs: material width across, measured from the cut walls
  const th = c.thickness();
  const web = (s: number) => Math.abs(dot(tn, n, c.samples[s] * 4)) < 0.01 && th[s] < pr.minWeb - 1e-3;
  const wm = c.marks((s) => web(s));
  if (wm.area > 0.5) {
    let w = Infinity;
    for (let s = 0; s < th.length; s++) if (web(s)) w = Math.min(w, th[s]);
    out.push({
      rule: "web",
      status: "warn",
      title: "Narrow webs",
      detail: `Material as narrow as ${fmt(w)} mm between cuts (keep ${fmt(pr.minWeb)} mm or more): it warps or burns away.`,
      fix: `Widen these webs to at least ${fmt(pr.minWeb)} mm.`,
      value: w,
      limit: pr.minWeb,
      marks: wm.marks,
    });
  }
  return out;
}

// ---------------- holes ----------------

function holes(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding[] {
  const hr = rules.holes!;
  // holes narrower than the thickness only trouble metal: acrylic and wood cut fine holes in thick plate
  const minD = rules.sheet || (rules.profile && isMetal(rules.material)) ? Math.max(hr.minD, stats.sheetT ?? 0) : hr.minD;
  const minDFail = rules.sheet ? minD : hr.minDFail;
  const small = new Set<number>();
  const deep = new Set<number>();
  let smallest = Infinity;
  let deepest = 0;
  let count = 0;
  c.m.faces.forEach((f, i) => {
    if (f.type !== "CYLINDRE" || !f.concave || !f.fullTurn || f.radius === undefined) return;
    count++;
    const d = 2 * f.radius;
    if (d < minD - 1e-3) {
      small.add(i);
      smallest = Math.min(smallest, d);
    }
    if (hr.maxDepthRatio && f.length && f.length / d > hr.maxDepthRatio) {
      deep.add(i);
      deepest = Math.max(deepest, f.length / d);
    }
  });
  stats.holes = count;
  const out: ProcessFinding[] = [];
  if (small.size) {
    const failing = minDFail !== undefined && smallest < minDFail - 1e-3;
    out.push({
      rule: "hole-small",
      status: failing ? "fail" : "warn",
      title: `Holes under Ø${fmt(minD)}`,
      detail: `${plural(small.size, "hole")} as small as Ø${fmt(smallest)} mm: ${hr.why}.`,
      fix: `Enlarge to Ø${fmt(minD)} mm or more, or drill them afterwards (note it on the drawing).`,
      value: smallest,
      limit: minD,
      marks: c.faceMarks(small).marks,
    });
  }
  if (deep.size)
    out.push({
      rule: "hole-deep",
      status: "warn",
      title: "Deep holes",
      detail: `${plural(deep.size, "hole")} up to ${fmt(deepest, 1)}× deeper than wide (limit ${hr.maxDepthRatio}×).`,
      fix: "Shorten them, enlarge them, or make them from both sides.",
      value: deepest,
      limit: hr.maxDepthRatio,
      marks: c.faceMarks(deep).marks,
    });
  if (!small.size && !deep.size && count) out.push({ rule: "holes", status: "pass", title: "Hole sizes", detail: `${plural(count, "hole")}, all Ø${fmt(minD)} mm or larger` });
  return out;
}

// ---------------- support removal ----------------

/** Ways out of a support, looked for from the middle of its column: the axes and the twelve edge diagonals. */
const ESCAPE: V3[] = [
  ...AXES,
  ...(
    [
      [1, 1, 0],
      [1, -1, 0],
      [-1, 1, 0],
      [-1, -1, 0],
      [1, 0, 1],
      [1, 0, -1],
      [-1, 0, 1],
      [-1, 0, -1],
      [0, 1, 1],
      [0, 1, -1],
      [0, -1, 1],
      [0, -1, -1],
    ] as V3[]
  ).map(norm),
];

/** Half-widths tried around a way out, mm: the widest bundle of parallel lines that still gets out is the opening a tool has. */
const OPEN_R = [0.5, 1, 1.5, 2.5, 4, 6, 9, 15];

/** How a support can be got at: freely, only deep in, only through a gap narrower than the tool, or not at all. */
type Reach = "open" | "deep" | "narrow" | "trapped";

interface SupportPoint {
  reach: Reach;
  /** half-width of the best way out, mm */
  r: number;
  /** how far in from the part's outline the support sits along that way out, mm */
  depth: number;
  /** the column stands on the part rather than the bed */
  onPart: boolean;
  /** column height, mm */
  h: number;
}

function perpPair(d: V3): [V3, V3] {
  const u = norm(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  return [u, cross(d, u)];
}

/** Distance from p along d to where it leaves the part's bounding box. */
function boxExit(c: Ctx, p: V3, d: V3): number {
  let t = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) continue;
    t = Math.min(t, ((d[k] > 0 ? c.hi[k] : c.lo[k]) - p[k]) / d[k]);
  }
  return Math.max(0, t);
}

/** Whether a bundle of four lines r from p, parallel to d, all get out of the part, or run len clear (and r of space reaches them from p). */
function bundleClear(c: Ctx, p: V3, d: V3, u: V3, v: V3, r: number, len = Infinity): boolean {
  for (const w of [u, v])
    for (const sg of [1, -1]) {
      const wx = w[0] * sg,
        wy = w[1] * sg,
        wz = w[2] * sg;
      if (c.bvh.raycast(p[0], p[1], p[2], wx, wy, wz, 0, r, -1, true)) return false;
      if (c.bvh.raycast(p[0] + wx * r, p[1] + wy * r, p[2] + wz * r, d[0], d[1], d[2], 0, len, -1, true)) return false;
    }
  return true;
}

/**
 * Whether an opening r wide gets to p along d with p anywhere in it, not just
 * at its centre: a support beside a wall of a wide pocket is still reached
 * through the pocket's mouth. Tries the bundle centred on p, then shifted r
 * toward eight sides; returns the centre that works.
 */
function shiftedClear(c: Ctx, p: V3, d: V3, u: V3, v: V3, r: number, len = Infinity): V3 | null {
  if (bundleClear(c, p, d, u, v, r, len)) return p;
  const k = Math.SQRT1_2;
  for (const [a, bb] of [[1, 0], [-1, 0], [0, 1], [0, -1], [k, k], [-k, k], [k, -k], [-k, -k]]) {
    const w: V3 = [u[0] * a + v[0] * bb, u[1] * a + v[1] * bb, u[2] * a + v[2] * bb];
    if (c.bvh.raycast(p[0], p[1], p[2], w[0], w[1], w[2], 0, r, -1, true)) continue;
    const center: V3 = [p[0] + w[0] * r, p[1] + w[1] * r, p[2] + w[2] * r];
    if (bundleClear(c, center, d, u, v, r, len)) return center;
  }
  return null;
}

/** The widest straight way out from p (half-width r) and how far it runs inside the part's box; null when every line from p hits the part. */
function wayOut(c: Ctx, p: V3, opening: number): { r: number; depth: number } | null {
  let best: { r: number; depth: number } | null = null;
  const free: V3[] = [];
  for (const d of ESCAPE) {
    if (c.bvh.raycast(p[0], p[1], p[2], d[0], d[1], d[2], 0, Infinity, -1, true)) continue;
    free.push(d);
    const [u, v] = perpPair(d);
    // only a wider way out (or the first one) is worth measuring
    let r = 0;
    let i = 0;
    if (best) {
      i = OPEN_R.findIndex((x) => x > best!.r);
      if (i < 0 || !bundleClear(c, p, d, u, v, OPEN_R[i])) continue;
      r = OPEN_R[i++];
    }
    for (; i < OPEN_R.length && bundleClear(c, p, d, u, v, OPEN_R[i]); i++) r = OPEN_R[i];
    const depth = boxExit(c, p, d);
    if (!best || r > best.r || (r === best.r && depth < best.depth)) best = { r, depth };
    if (r >= OPEN_R[OPEN_R.length - 1]) break;
  }
  if (best && 2 * best.r < opening - 1e-6) {
    // near a wall: the tool need not be centred on the support
    const r = opening / 2;
    for (const d of free) {
      const [u, v] = perpPair(d);
      const center = shiftedClear(c, p, d, u, v, r);
      if (center) return { r, depth: boxExit(c, center, d) };
    }
  }
  return best;
}

/**
 * A way out with one turn: a tool reaches in through an opening, then across
 * the cavity to the support (the inside of a jar's shoulder, through its
 * neck). The first leg runs halfway to the wall it faces and must be as wide
 * as the opening too.
 */
function aroundCorner(c: Ctx, p: V3, opening: number): { r: number; depth: number } | null {
  const r = opening / 2;
  for (const d of ESCAPE) {
    const hit = c.bvh.raycast(p[0], p[1], p[2], d[0], d[1], d[2], 0, Infinity, -1);
    if (!hit || hit.t < 2 * opening) continue;
    const len = hit.t / 2;
    const [u, v] = perpPair(d);
    const start = shiftedClear(c, p, d, u, v, r, len);
    if (!start) continue;
    const turn: V3 = [start[0] + d[0] * len, start[1] + d[1] * len, start[2] + d[2] * len];
    const out = wayOut(c, turn, opening);
    if (out && 2 * out.r >= opening - 1e-6) return { r: out.r, depth: len + out.depth };
  }
  return null;
}

/** Where the support under triangle t stands, and how a tool (opening wide) gets to it. */
function supportPoint(c: Ctx, t: number, b: V3, minB: number, opening: number, deepOk: boolean): SupportPoint {
  const n: V3 = [c.tn[t * 4], c.tn[t * 4 + 1], c.tn[t * 4 + 2]];
  const e = c.clearEps;
  const o: V3 = [c.tc[t * 3] + n[0] * e, c.tc[t * 3 + 1] + n[1] * e, c.tc[t * 3 + 2] + n[2] * e];
  // the column runs straight down to whatever is below: the part or the bed
  const hit = c.bvh.raycast(o[0], o[1], o[2], -b[0], -b[1], -b[2], 0, Infinity, t);
  const toBed = dot(o, b) - minB;
  const onPart = !!hit && hit.t < toBed - e;
  const h = onPart ? hit!.t : Math.max(0, toBed);
  const m: V3 = [o[0] - (b[0] * h) / 2, o[1] - (b[1] * h) / 2, o[2] - (b[2] * h) / 2];
  let best = wayOut(c, m, opening);
  if (!best || 2 * best.r < opening - 1e-6) best = aroundCorner(c, m, opening) ?? best;
  if (!best) return { reach: "trapped", r: 0, depth: Infinity, onPart, h };
  if (2 * best.r < opening - 1e-6) return { reach: "narrow", ...best, onPart, h };
  if (!deepOk && best.r < OPEN_R[OPEN_R.length - 1] && best.depth > Math.max(20, 8 * best.r)) return { reach: "deep", ...best, onPart, h };
  return { reach: "open", ...best, onPart, h };
}

interface SupportSurvey {
  area: Record<Reach, number>;
  /** each supported face's class */
  faces: Map<number, Reach>;
  /** support volume, mm³ */
  volume: number;
  /** supported area whose supports stand on the part */
  onPart: number;
  /** narrowest way out among the narrow points, and the deepest among the deep ones */
  narrowest: number;
  deepest: { depth: number; r: number } | null;
  /** flat face resting on the bed, mm² */
  contact: number;
}

/**
 * Supports for one build direction: which faces need them (as overhangs()
 * decides), how much there is, and how hard each face's supports are to get
 * at, judged from a few points per face (a third of them decides).
 */
function surveySupports(c: Ctx, b: V3, o: NonNullable<Rules["overhang"]>, opening: number, deepOk: boolean, perFace: number, budget: number): { flag: Uint8Array; survey: SupportSurvey; total: number } {
  const flag = new Uint8Array(c.n);
  const { area: total, contact } = overhangArea(c, b, o, flag);
  const survey: SupportSurvey = { area: { open: 0, deep: 0, narrow: 0, trapped: 0 }, faces: new Map(), volume: 0, onPart: 0, narrowest: Infinity, deepest: null, contact };
  if (total <= 5) return { flag, survey, total };
  let minB = Infinity;
  for (let i = 0; i < c.m.pos.length; i += 3) minB = Math.min(minB, c.m.pos[i] * b[0] + c.m.pos[i + 1] * b[1] + c.m.pos[i + 2] * b[2]);
  const byFace = new Map<number, number[]>();
  for (let t = 0; t < c.n; t++) {
    if (!flag[t]) continue;
    const f = c.m.faceOf[t];
    const list = byFace.get(f);
    if (list) list.push(t);
    else byFace.set(f, [t]);
  }
  const per = Math.max(1, Math.min(perFace, Math.floor(budget / Math.max(1, byFace.size))));
  for (const [f, tris] of byFace) {
    const counts: Record<Reach, number> = { open: 0, deep: 0, narrow: 0, trapped: 0 };
    let k = 0;
    let hSum = 0;
    let on = 0;
    const step = Math.max(1, Math.floor(tris.length / per));
    for (let i = Math.floor(step / 2); i < tris.length && k < per; i += step, k++) {
      const pt = supportPoint(c, tris[i], b, minB, opening, deepOk);
      counts[pt.reach]++;
      hSum += pt.h;
      if (pt.onPart) on++;
      if (pt.reach === "narrow") survey.narrowest = Math.min(survey.narrowest, 2 * pt.r);
      if (pt.reach === "deep" && (!survey.deepest || pt.depth > survey.deepest.depth)) survey.deepest = { depth: pt.depth, r: pt.r };
    }
    if (!k) continue;
    const third = k / 3 - 1e-9;
    const cls: Reach = counts.trapped >= third ? "trapped" : counts.trapped + counts.narrow >= third ? "narrow" : counts.trapped + counts.narrow + counts.deep >= third ? "deep" : "open";
    let a = 0;
    let projected = 0;
    for (const t of tris) {
      a += c.tn[t * 4 + 3];
      projected += c.tn[t * 4 + 3] * Math.abs(dot(c.tn, b, t * 4));
    }
    survey.area[cls] += a;
    survey.faces.set(f, cls);
    survey.volume += projected * (hSum / k);
    if (on * 2 >= k) survey.onPart += a;
  }
  return { flag, survey, total };
}

function supportAccess(c: Ctx, rules: Rules): ProcessFinding[] {
  const sa = rules.supportAccess!;
  const o = { build: sa.build, max: sa.max, severity: "warn" as const, bridgeR: sa.bridgeR, span: sa.span };
  // soluble supports only need a way in for the solvent, at any depth
  const opening = sa.soluble ? 1 : sa.opening;
  const { flag, survey, total } = surveySupports(c, sa.build, o, opening, sa.soluble, 10, 900);
  if (total <= 5)
    return rules.overhang ? [] : [{ rule: "support-access", status: "pass", title: "No supports needed", detail: `No surface faces the ${rules.process === "sla" ? "vat" : "bed"} more steeply than ${fmt(sa.max)}° from vertical` }];
  const s = survey;
  const vol = `about ${fmt(s.volume / 1000, s.volume < 1000 ? 2 : 1)} cm³ of support`;
  const marksOf = (cls: Reach) => c.marks((_s, t) => flag[t] === 1 && s.faces.get(c.m.faceOf[t]) === cls);
  const bad = s.area.trapped + s.area.narrow;
  const alt = bad > 0.5 ? betterBuild(c, rules, opening, bad) : undefined;
  const turn = alt ? ` ${alt.detail}` : "";
  const out: ProcessFinding[] = [];
  if (s.area.trapped > 0.5)
    out.push({
      rule: "support-trapped",
      status: "fail",
      title: "Supports trapped inside",
      detail: `${mm2(s.area.trapped)} of overhang sits in a closed space, so the support printed under it could never be taken out${sa.soluble ? ", even dissolved: no solvent gets in" : ` (supports here are ${sa.how})`}.`,
      fix: `Make that ceiling self-supporting (a 45° roof, or a teardrop or diamond hole instead of a flat top), open the cavity toward the ${rules.process === "sla" ? "build plate" : "bed"} so its supports come out through the opening, or split the part along the cavity.${turn}`,
      marks: marksOf("trapped").marks,
      alt,
    });
  if (s.area.narrow > 0.5) {
    const w = Number.isFinite(s.narrowest) ? s.narrowest : 0;
    out.push({
      rule: "support-narrow",
      status: sa.soluble ? "warn" : "fail",
      title: sa.soluble ? "Supports the solvent can barely reach" : "Supports behind a narrow opening",
      detail: sa.soluble
        ? `${mm2(s.area.narrow)} of overhang is supported in a space whose way out is under 1 mm wide: the solvent hardly circulates and the support may never fully dissolve.`
        : `${mm2(s.area.narrow)} of overhang is supported in a space whose way out is ${w > 0 ? `only about ${fmt(w, 1)} mm wide` : "a crack"}, narrower than the ${fmt(sa.opening)} mm a tool needs, so the support cannot be ${sa.how}.`,
      fix: `Widen the opening to at least ${fmt(sa.soluble ? 2 : sa.opening)} mm, make the ceiling self-supporting (45° roofs, teardrop holes, chamfered ledges), or turn the part so the overhang faces up.${turn}`,
      value: w,
      limit: sa.soluble ? 1 : sa.opening,
      marks: marksOf("narrow").marks,
      alt,
    });
  }
  if (s.area.deep > 0.5) {
    const d = s.deepest;
    out.push({
      rule: "support-deep",
      status: "warn",
      title: "Supports deep in a narrow channel",
      detail: `${mm2(s.area.deep)} of overhang is supported ${d ? `about ${fmt(d.depth, 0)} mm in through an opening about ${fmt(2 * d.r, 0)} mm wide` : "deep in a narrow space"}: hard to reach, and it tends to break off and stay behind.`,
      fix: "Make that ceiling self-supporting (a teardrop or diamond channel, 45° roofs), shorten the channel or open a second way in, or turn the part so the channel prints upright.",
      value: d?.depth,
      marks: marksOf("deep").marks,
    });
  }
  if (!out.length)
    out.push({
      rule: "support-access",
      status: "pass",
      title: "Supports come off",
      detail: `${cap(vol)}, all reachable from outside${s.onPart > 0.5 ? `; ${mm2(s.onPart)} of it stands on the part's own faces and marks both` : ""}`,
    });
  else out[0].detail += ` In all, ${vol}${s.onPart > 0.5 ? `, ${mm2(s.onPart)} of it standing on the part's own faces` : ""}.`;
  return out;
}

/** The axis build direction whose supports are easiest to remove, if it is clearly better. */
function betterBuild(c: Ctx, rules: Rules, opening: number, current: number): Alternative | undefined {
  const sa = rules.supportAccess!;
  let best: { b: V3; bad: number; total: number } | null = null;
  for (const b of AXES) {
    if (sameDir(b, sa.build)) continue;
    const o = { build: b, max: sa.max, severity: "warn" as const, bridgeR: sa.bridgeR, span: sa.span };
    const { survey, total } = surveySupports(c, b, o, opening, sa.soluble, 3, 240);
    if (survey.contact <= 0) continue;
    const bad = survey.area.trapped + survey.area.narrow;
    if (!best || bad < best.bad - 1 || (Math.abs(bad - best.bad) <= 1 && total < best.total)) best = { b, bad, total };
  }
  if (!best || best.bad > current * 0.5) return undefined;
  return {
    setting: "build",
    value: best.b,
    label: `Print with ${axisName(best.b)} up`,
    detail:
      best.bad < 0.5
        ? `Printing with ${axisName(best.b)} as the build direction leaves no support that cannot be removed (${mm2(best.total)} supported in all).`
        : `Printing with ${axisName(best.b)} as the build direction cuts supports that cannot be removed from ${mm2(current)} to ${mm2(best.bad)}.`,
  };
}

// ---------------- gaps that fuse shut ----------------

function fusedGaps(c: Ctx, rules: Rules): ProcessFinding[] {
  const f = rules.fuse!;
  const gap = c.gap();
  // a gap is two faces squarely facing each other: parallel planes, or cylinders round parallel axes (a pin in a hole). A
  // wedge where a boss meets a wall at an angle, or a round boss that just touches a flat wall, is only a corner
  const facing = new Uint8Array(gap.length);
  const parallel = (a: FaceInfo, b: FaceInfo) =>
    a.type === "CYLINDRE" && b.type === "CYLINDRE" ? !!a.axis && !!b.axis && Math.abs(dot(a.axis.d, b.axis.d)) > 0.99 : !(a.type === "CYLINDRE" || b.type === "CYLINDRE");
  const { tn, tc, eps } = c;
  for (let s = 0; s < gap.length; s++) {
    if (!(gap[s] > 2 * eps && gap[s] < f.min - 1e-6)) continue;
    const t = c.samples[s];
    const n: V3 = [tn[t * 4], tn[t * 4 + 1], tn[t * 4 + 2]];
    const h = c.bvh.raycast(tc[t * 3] + n[0] * eps, tc[t * 3 + 1] + n[1] * eps, tc[t * 3 + 2] + n[2] * eps, n[0], n[1], n[2], 0, Infinity, t);
    if (h && dot(tn, n, h.tri * 4) < -0.95 && parallel(c.face(t), c.face(h.tri))) facing[s] = 1;
  }
  const tight = (s: number) => facing[s] === 1;
  const m = c.marks((s) => tight(s));
  if (m.area < 1) return [{ rule: "clearance", status: "pass", title: `Gaps at least ${fmt(f.min)} mm`, detail: "No faces close enough to fuse together" }];
  let w = Infinity;
  for (let s = 0; s < gap.length; s++) if (tight(s)) w = Math.min(w, gap[s]);
  return [
    {
      rule: "clearance",
      status: "warn",
      title: `Gaps under ${fmt(f.min)} mm fuse shut`,
      detail: `${mm2(m.area)} of facing surfaces are as little as ${fmt(w)} mm apart: ${f.why}. Anything meant to move, slide or come apart there ends up stuck.`,
      fix: `Open these gaps to at least ${fmt(f.min)} mm (more for parts that move), or close them completely if the faces should be one piece.`,
      value: w,
      limit: f.min,
      marks: m.marks,
    },
  ];
}

// ---------------- the printer against the material ----------------

function printerFit(rules: Rules): ProcessFinding[] {
  const p = rules.printer!;
  if (p.needTemp === undefined) return [];
  const who = rules.machine ? `the ${rules.machine}` : "the printer";
  if (p.needTemp > p.maxTemp + 1e-6)
    return [
      {
        rule: "printer",
        status: "fail",
        title: `Printer too cold for ${rules.material}`,
        detail: `${rules.material} prints at about ${fmt(p.needTemp, 0)} °C at the nozzle; ${who} reaches ${fmt(p.maxTemp, 0)} °C.`,
        fix: `Print it in a filament ${who} melts (PETG or PLA where the part's temperature and toughness allow), or use a printer whose hot end reaches ${fmt(p.needTemp, 0)} °C.`,
        value: p.needTemp,
        limit: p.maxTemp,
      },
    ];
  if (p.warps && !p.enclosed)
    return [
      {
        rule: "printer",
        status: "warn",
        title: `${rules.material} warps on an open printer`,
        detail: `${rules.material} shrinks as it cools; without an enclosure around ${who} its corners lift off the bed and tall walls split between layers.`,
        fix: "Print it in an enclosed printer, or in PETG if the part's temperature and toughness allow. Rounded corners and a brim help a little.",
      },
    ];
  return [{ rule: "printer", status: "pass", title: `Printer suits ${rules.material}`, detail: `about ${fmt(p.needTemp, 0)} °C at the nozzle${p.warps ? ", inside an enclosure" : ""}` }];
}

// ---------------- the milling machine ----------------

/** Highest point of the part along d. */
function topAlong(c: Ctx, d: V3): number {
  let top = -Infinity;
  for (let i = 0; i < c.m.pos.length; i += 3) top = Math.max(top, c.m.pos[i] * d[0] + c.m.pos[i + 1] * d[1] + c.m.pos[i + 2] * d[2]);
  return top;
}

/**
 * Checks that depend on the mill: every wall and corner has a tool that fits
 * and reaches it, the spindle drives the smallest tool needed, the frame cuts
 * the material, the stock can be held, and the plan: setups, tools and stock.
 */
function machining(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding[] {
  const mc = rules.machining!;
  const dirs = rules.reach!.dirs;
  const tools = mc.tools;
  const smallest = tools[0]?.[0] ?? Infinity;
  const gap = c.gap();
  const { tn, tc } = c;
  const masks = dirs.map((d) => c.clear(d));
  const tops = dirs.map((d) => topAlong(c, d));
  const out: ProcessFinding[] = [];
  const used = new Map<number, number>(); // tool diameter → deepest cut, for the plan
  let worst: { limit: number; depth: number; gap: number } | null = null;
  let tightest: { d: number; corner: boolean } | null = null;
  const short = new Uint8Array(c.samples.length);
  for (let s = 0; s < c.samples.length; s++) {
    const t = c.samples[s];
    const f = c.face(t);
    if (f.type === "CYLINDRE" && f.fullTurn) continue; // drilled or bored
    const corner = f.type === "CYLINDRE" && !!f.concave && f.radius !== undefined && !!f.axis;
    let limit = Number.isFinite(gap[s]) ? gap[s] : Infinity;
    if (corner) limit = Math.min(limit, 2 * f.radius!);
    // side walls along the tool, and corner fillets whose axis runs along it
    const from = dirs.map((d, i) => i).filter((i) => masks[i][s] && (corner ? Math.abs(dot(f.axis!.d, dirs[i])) > 0.98 : Math.abs(dot(tn, dirs[i], t * 4)) < 0.2));
    // the bottom of the wall has to be reached too: depth at the middle and each corner of the triangle (just inside it), from the setup that comes closest
    let depth = from.length ? 0 : Infinity;
    for (let k = 0; k < 4 && from.length; k++) {
      const v = c.m.idx[t * 3 + Math.min(k, 2)] * 3;
      const p: V3 = [0, 1, 2].map((j) => (k < 3 ? 0.9 * c.m.pos[v + j] + 0.1 * tc[t * 3 + j] : tc[t * 3 + j])) as V3;
      let near = Infinity;
      for (const i of from) near = Math.min(near, tops[i] - dot(p, dirs[i]));
      depth = Math.max(depth, near);
    }
    // floors, faces no setup reaches (the reach check reports those), slots no tool fits (the slot and corner checks do), and
    // the outside: any tool cuts round it from either side, or it is the stock's own face
    if (!Number.isFinite(depth) || !Number.isFinite(limit) || limit < smallest - 1e-3) continue;
    let pick: Tool | null = null;
    for (const tool of tools) if (tool[0] <= limit + 1e-3 && tool[1] >= depth - 1e-3 && (!pick || tool[0] > pick[0])) pick = tool;
    if (pick) {
      used.set(pick[0], Math.max(used.get(pick[0]) ?? 0, depth));
      if (Number.isFinite(limit) && (!tightest || pick[0] < tightest.d)) tightest = { d: pick[0], corner };
    } else {
      short[s] = 1;
      if (!worst || depth / Math.min(limit, 1e6) > worst.depth / Math.min(worst.limit, 1e6)) worst = { limit, depth, gap: gap[s] };
    }
  }
  const named = rules.machine ? `the ${rules.machine}` : "the machine";
  const sm = c.marks((s) => short[s] === 1);
  if (sm.area > 0.5 && worst) {
    const fits = tools.filter((x) => x[0] <= worst!.limit + 1e-3);
    const longest = fits.reduce<Tool | null>((a, x) => (!a || x[1] > a[1] ? x : a), null);
    const reaching = tools.find((x) => x[1] >= worst!.depth - 1e-3);
    const wanted: Tool = [Number.isFinite(worst.limit) ? Math.floor(worst.limit * 10) / 10 : smallest, Math.ceil(worst.depth)];
    out.push({
      rule: "tool-reach",
      status: mc.library ? "fail" : "warn",
      title: "Deeper than the tools reach",
      detail: `${mm2(sm.area)} of walls and corners sit up to ${fmt(worst.depth, 1)} mm deep where ${Number.isFinite(worst.limit) ? `only a tool of Ø${fmt(worst.limit)} or less fits` : "a tool has to reach"}; ${longest ? `the longest-reaching one ${mc.library ? `${named} has` : "in a standard set"} is ${toolName(longest)}` : "no tool fits"}${mc.library ? "" : ` (standard end mills reach about ${fmt(tools[0][1] / tools[0][0], 1)}× their diameter)`}.`,
      fix: `${reaching && Number.isFinite(worst.limit) ? `Open the corners to R${fmt(reaching[0] / 2 + 0.1, 1)} or slots to ${fmt(reaching[0] + 0.2, 1)} mm so the ${toolName(reaching)} tool fits, ` : ""}make the feature shallower, cut it from the other side (another setup), or add a long-reach ${toolName(wanted)} tool to ${mc.library ? `${named}'s` : "the"} tools list.`,
      value: worst.depth,
      limit: longest?.[1],
      marks: sm.marks,
    });
  } else {
    out.push({ rule: "tool-reach", status: "pass", title: "Tools reach every wall", detail: `Every wall and corner has a tool that fits and reaches it (${tools.map(toolName).join(", ")})` });
  }
  // the smallest tool the part needs, against the spindle
  const minD = slowestTool(mc.cutSpeed, mc.rpm);
  if (tightest && tightest.d < minD - 1e-6) {
    const need = (mc.cutSpeed * 1000) / (Math.PI * tightest.d);
    const ok = tools.find((x) => x[0] >= minD)?.[0] ?? Math.ceil(minD);
    out.push({
      rule: "spindle",
      status: "warn",
      title: "Spindle too slow for the smallest tool",
      detail: `The part needs tools as small as Ø${fmt(tightest.d)} mm (for its ${tightest.corner ? "tightest inside corners" : "narrowest slots"}). In ${rules.material} they cut best at about ${fmt(Math.round(need / 1000) * 1000, 0)} rpm, and ${named}'s spindle reaches ${fmt(mc.rpm, 0)} rpm, so they cut slowly and break more often.`,
      fix: `Open the tightest corners to R${fmt(ok / 2 + 0.1, 1)} and slots to ${fmt(ok + 0.2, 1)} mm or more so a Ø${fmt(ok)} mm tool does the work.`,
      value: tightest.d,
      limit: minD,
    });
  }
  // the frame against the material
  if (mc.frame.status !== "pass")
    out.push({
      rule: "machine-material",
      status: mc.frame.status,
      title: mc.frame.status === "fail" ? `${cap(mc.frame.name === "router" ? "a router" : "this mill")} cannot cut ${rules.material}` : `Slow going in ${rules.material}`,
      detail: `${cap(mc.frame.why)}.`,
      fix: mc.frame.status === "fail" ? `Order it from a shop with a machining centre, or make it in aluminium or plastic if the part allows.` : "Expect slow, light passes and keep corners generous so larger tools do the work, or order it from a shop.",
    });
  else out.push({ rule: "machine-material", status: "pass", title: `The mill cuts ${rules.material}`, detail: cap(mc.frame.why) });
  out.push(...holding(c, rules, dirs[0]));
  out.push(machiningPlan(c, rules, masks, used, stats));
  return out;
}

/** Whether the stock can be held for the first setup: in the vise, and not a thin flexing plate. */
function holding(c: Ctx, rules: Rules, d: V3): ProcessFinding[] {
  const mc = rules.machining!;
  const ax = Math.abs(d[0]) > 0.99 ? 0 : Math.abs(d[1]) > 0.99 ? 1 : Math.abs(d[2]) > 0.99 ? 2 : -1;
  if (ax < 0) return [];
  const ext = [c.hi[0] - c.lo[0], c.hi[1] - c.lo[1], c.hi[2] - c.lo[2]];
  const across = ext.filter((_, i) => i !== ax).sort((a, b) => a - b);
  const height = ext[ax];
  const stock = across[0] + 4;
  const out: ProcessFinding[] = [];
  if (mc.vise > 0 && stock > mc.vise + 1e-6)
    out.push({
      rule: "holding",
      status: "info",
      title: "Too wide for the vise",
      detail: `The stock is at least ${fmt(stock, 0)} mm across even turned its narrow way, and the vise opens ${fmt(mc.vise, 0)} mm.`,
      fix: "Clamp it to the table or screw it to a fixture plate through its own holes (allow for the clamps in the tool paths), or use a wider vise.",
      value: stock,
      limit: mc.vise,
    });
  if (height < 4 && across[0] > 40)
    out.push({
      rule: "holding",
      status: "warn",
      title: "Thin plate to hold",
      detail: `Only ${fmt(height, 1)} mm thick across ${fmt(across[0], 0)} × ${fmt(across[1], 0)} mm: it flexes in a vise and lifts under the tool.`,
      fix: "Screw it to a fixture plate, hold it on a vacuum table or with tabs, or cut the outline by laser or waterjet and mill only the details.",
    });
  return out;
}

/** The setups, tools and stock the part needs: an info line for the user and Claude, and setups for the cost estimate. */
function machiningPlan(c: Ctx, rules: Rules, masks: Uint8Array[], used: Map<number, number>, stats: ProcessStats): ProcessFinding {
  const mc = rules.machining!;
  const dirs = rules.reach!.dirs;
  // directions one setup covers: everything round the rotary axis on a 4-axis, everything from above on a 5-axis
  const group = (d: V3) => (mc.axes >= 5 ? (d[2] > -0.1 ? "tilting from above" : axisName(d)) : mc.axes === 4 ? (Math.abs(d[0]) < 0.1 ? "on the rotary axis" : axisName(d)) : `from ${axisName(d)}`);
  const groups = new Map<string, Uint8Array[]>();
  dirs.forEach((d, i) => groups.set(group(d), [...(groups.get(group(d)) ?? []), masks[i]]));
  const reached = (s: number, ms: Uint8Array[]) => ms.some((mk) => mk[s]);
  const left = new Uint8Array(c.samples.length);
  let remaining = 0;
  const all = [...groups.values()].flat();
  for (let s = 0; s < c.samples.length; s++)
    if (reached(s, all)) {
      left[s] = 1;
      remaining += c.sampleArea[s];
    }
  const chosen: string[] = [];
  while (remaining > 0.5 && chosen.length < groups.size) {
    let best: { key: string; gain: number } | null = null;
    for (const [key, ms] of groups) {
      if (chosen.includes(key)) continue;
      let gain = 0;
      for (let s = 0; s < c.samples.length; s++) if (left[s] && reached(s, ms)) gain += c.sampleArea[s];
      if (!best || gain > best.gain) best = { key, gain };
    }
    if (!best || best.gain <= 0.5) break;
    chosen.push(best.key);
    const ms = groups.get(best.key)!;
    for (let s = 0; s < c.samples.length; s++)
      if (left[s] && reached(s, ms)) {
        left[s] = 0;
        remaining -= c.sampleArea[s];
      }
  }
  stats.setups = Math.max(1, chosen.length);
  const ext = [c.hi[0] - c.lo[0], c.hi[1] - c.lo[1], c.hi[2] - c.lo[2]];
  const stock = ext.map((x) => fmt(Math.ceil(x + 4), 0)).join(" × ");
  const toolList = [...used.entries()].sort((a, b) => b[0] - a[0]).slice(0, 6);
  const holes = c.m.faces.filter((f) => f.type === "CYLINDRE" && f.concave && f.fullTurn && f.radius !== undefined).map((f) => 2 * f.radius!);
  const sizes = [...new Set(holes.map((d) => fmt(d, 1)))];
  const kind = mc.axes === 5 ? "5-axis" : mc.axes === 4 ? "4-axis" : "3-axis";
  return {
    rule: "plan",
    status: "info",
    title: `Machining plan: ${plural(stats.setups, "setup")} on ${rules.machine ? `the ${rules.machine}` : `a ${kind} mill`}`,
    detail: [
      `Stock about ${stock} mm${mc.vise > 0 ? ` in a vise opening ${fmt(mc.vise, 0)} mm` : ", clamped to the table"}.`,
      `Setups: ${chosen.join("; ") || "one"}.`,
      toolList.length ? `End mills: ${toolList.map(([d, depth]) => `Ø${fmt(d)} (to ${fmt(depth, 0)} mm deep)`).join(", ")}.` : "",
      holes.length ? `Holes: ${holes.length}, Ø${sizes.slice(0, 6).join(", Ø")}${sizes.length > 6 ? "…" : ""}, drilled or bored.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

// ---------------- presses: moulding and die casting ----------------

/** Area of the part's shadow along d, mm², rasterised on a grid of about 256 cells across. */
function shadowArea(c: Ctx, d: V3): number {
  const [u, v] = perpPair(d);
  const P = c.m.pos;
  const nv = P.length / 3;
  const pu = new Float64Array(nv);
  const pv = new Float64Array(nv);
  let lu = Infinity,
    hu = -Infinity,
    lv = Infinity,
    hv = -Infinity;
  for (let i = 0; i < nv; i++) {
    pu[i] = P[i * 3] * u[0] + P[i * 3 + 1] * u[1] + P[i * 3 + 2] * u[2];
    pv[i] = P[i * 3] * v[0] + P[i * 3 + 1] * v[1] + P[i * 3 + 2] * v[2];
    lu = Math.min(lu, pu[i]);
    hu = Math.max(hu, pu[i]);
    lv = Math.min(lv, pv[i]);
    hv = Math.max(hv, pv[i]);
  }
  const cs = Math.max(hu - lu, hv - lv, 1e-6) / 256;
  const nu = Math.ceil((hu - lu) / cs) + 1;
  const nvv = Math.ceil((hv - lv) / cs) + 1;
  const grid = new Uint8Array(nu * nvv);
  const idx = c.m.idx;
  for (let t = 0; t < c.n; t++) {
    if (Math.abs(dot(c.tn, d, t * 4)) < 1e-3) continue;
    const a = idx[t * 3],
      b = idx[t * 3 + 1],
      e = idx[t * 3 + 2];
    const x0 = (pu[a] - lu) / cs,
      y0 = (pv[a] - lv) / cs,
      x1 = (pu[b] - lu) / cs,
      y1 = (pv[b] - lv) / cs,
      x2 = (pu[e] - lu) / cs,
      y2 = (pv[e] - lv) / cs;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const sgn = area > 0 ? 1 : -1;
    const i0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))),
      i1 = Math.min(nu - 1, Math.ceil(Math.max(x0, x1, x2)));
    const j0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))),
      j1 = Math.min(nvv - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        if (grid[j * nu + i]) continue;
        const px = i + 0.5,
          py = j + 0.5;
        const w0 = sgn * ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0));
        const w1 = sgn * ((x2 - x1) * (py - y1) - (px - x1) * (y2 - y1));
        const w2 = sgn * ((x0 - x2) * (py - y2) - (px - x2) * (y0 - y2));
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) grid[j * nu + i] = 1;
      }
  }
  let n = 0;
  for (let i = 0; i < grid.length; i++) n += grid[i];
  return n * cs * cs;
}

function pressFit(c: Ctx, rules: Rules, stats: ProcessStats): ProcessFinding[] {
  const p = rules.press!;
  const out: ProcessFinding[] = [];
  const shadow = shadowArea(c, p.pull);
  const cav = p.cavities > 1 ? ` × ${p.cavities} cavities` : "";
  const named = rules.machine ? `the ${rules.machine}` : `a typical ${p.what}`;
  // runners and the gate add about a tenth to the shadow
  const tonnes = (shadow * p.pressure * p.cavities * 1.1) / 9806.65;
  if (tonnes > p.clamp + 1e-6)
    out.push({
      rule: "clamp",
      status: "fail",
      title: "Needs a bigger press",
      detail: `The part's shadow along the pull is ${fmt(shadow / 100, 1)} cm²${cav}; at about ${fmt(p.pressure, 0)} MPa in the cavity it takes about ${fmt(tonnes, 0)} t to hold the mould shut, and ${named} has ${fmt(p.clamp, 0)} t. The mould would open and flash.`,
      fix: `Use a press of at least ${fmt(Math.ceil((tonnes * 1.2) / 10) * 10, 0)} t, mould fewer parts per shot, or reduce the area the part covers seen along the pull (split it).`,
      value: tonnes,
      limit: p.clamp,
    });
  else out.push({ rule: "clamp", status: "pass", title: `Clamp force about ${fmt(Math.max(1, tonnes), 0)} t`, detail: `${fmt(shadow / 100, 1)} cm² shadow${cav}, within ${named}'s ${fmt(p.clamp, 0)} t` });
  const cm3 = c.volume() / 1000;
  const shot = cm3 * p.cavities * 1.15;
  if (shot > 0.8 * p.shot + 1e-6)
    out.push({
      rule: "shot",
      status: "fail",
      title: "Shot too big for the press",
      detail: `${fmt(cm3, 1)} cm³ of part${cav} plus runners is about ${fmt(shot, 0)} cm³ a shot; ${named} shoots up to ${fmt(p.shot, 0)} cm³, and a shot over 80 % of that fills unevenly.`,
      fix: "Use a bigger press, mould fewer parts per shot, or core out thick sections to cut the volume.",
      value: shot,
      limit: 0.8 * p.shot,
    });
  else if (p.flowRatio && shot < 0.1 * p.shot)
    out.push({
      rule: "shot",
      status: "warn",
      title: "Shot small for the press",
      detail: `About ${fmt(shot, 1)} cm³ a shot is under a tenth of ${named}'s ${fmt(p.shot, 0)} cm³: the plastic waits in the hot barrel for many shots and degrades.`,
      fix: "Mould more parts per shot (cavities:) or use a smaller press.",
      value: shot,
    });
  else out.push({ rule: "shot", status: "pass", title: `Shot about ${fmt(shot, shot < 10 ? 1 : 0)} cm³`, detail: `within ${named}'s ${fmt(p.shot, 0)} cm³` });
  const wall = stats.nominalWall;
  if (p.flowRatio && wall && wall > 0) {
    const flow = flowLength(c, p.pull);
    const ratio = flow / wall;
    if (ratio > p.flowRatio)
      out.push({
        rule: "flow",
        status: "warn",
        title: "Long flow for the wall",
        detail: `Plastic flows about ${fmt(flow, 0)} mm from a centre gate to the farthest corner through a ${fmt(wall, 1)} mm wall (${fmt(ratio, 0)}:1); ${rules.material} fills reliably to about ${p.flowRatio}:1, so the far end may not fill.`,
        fix: "Thicken the wall, plan two or more gates (tell the toolmaker), or use an easier-flowing grade.",
        value: ratio,
        limit: p.flowRatio,
      });
    else out.push({ rule: "flow", status: "pass", title: "Fills from one gate", detail: `${fmt(ratio, 0)}:1 flow to wall, under ${p.flowRatio}:1` });
  }
  return out;
}

/** Path from a gate at the middle of the face seen along the pull to the farthest point: across, then along the pull. */
function flowLength(c: Ctx, pull: V3): number {
  const mid: V3 = [(c.lo[0] + c.hi[0]) / 2, (c.lo[1] + c.hi[1]) / 2, (c.lo[2] + c.hi[2]) / 2];
  let across = 0;
  let lo = Infinity;
  let hi = -Infinity;
  const P = c.m.pos;
  for (let i = 0; i < P.length; i += 3) {
    const r: V3 = [P[i] - mid[0], P[i + 1] - mid[1], P[i + 2] - mid[2]];
    const s = dot(r, pull);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
    across = Math.max(across, Math.hypot(r[0] - pull[0] * s, r[1] - pull[1] * s, r[2] - pull[2] * s));
  }
  return across + (hi - lo);
}

// ---------------- casting: the pour ----------------

function pourFit(c: Ctx, rules: Rules): ProcessFinding[] {
  const p = rules.pour!;
  const kg = ((c.volume() / 1000) * p.density) / 1000;
  const poured = kg / p.yield;
  const named = rules.machine ? `the ${rules.machine}` : `a typical ${p.what.replace(/'s .*/, "")}`;
  const kgText = (x: number) => (x < 1 ? `${fmt(x * 1000, 0)} g` : `${fmt(x, 1)} kg`);
  if (poured > p.maxKg + 1e-9)
    return [
      {
        rule: "pour",
        status: "fail",
        title: "Too much to pour at once",
        detail: `The casting weighs about ${kgText(kg)} in ${rules.material}; with gates and risers that is about ${kgText(poured)} poured, and ${named} pours at most ${kgText(p.maxKg)}.`,
        fix: "Lighten it (core out thick areas, ribs instead of solid sections), split it into castings that bolt together, or use a larger foundry or caster.",
        value: poured,
        limit: p.maxKg,
      },
    ];
  return [{ rule: "pour", status: "pass", title: `About ${kgText(poured)} poured`, detail: `${kgText(kg)} casting; ${named} pours up to ${kgText(p.maxKg)}` }];
}
