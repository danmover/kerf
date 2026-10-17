// Routes cables through the assembly. The parts' surfaces are marked in a
// voxel grid, and each cable is found with A* over the free cells, preferring
// to run along surfaces (as cables are tied along a frame), to keep straight
// and to join cables already routed, so they gather into a harness. The cell
// path is then pushed apart where cables share it and smoothed into bends,
// never into a part. Plain arithmetic on typed arrays: it runs in a worker
// and in Node tests.

import type { V3 } from "../../kernel/recipe";

export interface RouteGeometry {
  positions: Float32Array;
  indices: Uint32Array;
}

/** A solid placed in the assembly: geometry index and column-major placement. */
export interface RoutePlaced {
  geo: number;
  m: number[];
  /** a bought part: cables go round it, never through its openings (fan bores, vents), so its whole box is solid (part frame) */
  box?: [V3, V3];
}

export interface RouteEnd {
  /** where the free run starts, just past the plug's straight lead */
  p: V3;
  /** the way the lead leaves the plug */
  dir: V3;
}

export interface RouteWire {
  id: string;
  a: RouteEnd;
  b: RouteEnd;
  /** outer diameter of the cable, mm */
  d: number;
  /** keep-out groups (bits of RouteKeepOut.bit) this cable stays out of where it can */
  avoid?: number;
}

/** Space a cable should not be tied in: where a moving part or a drag chain goes (assembly coordinates). */
export interface RouteKeepOut {
  lo: V3;
  hi: V3;
  /** its group, one bit of 16 */
  bit: number;
}

export interface RouteInput {
  geos: RouteGeometry[];
  placed: RoutePlaced[];
  wires: RouteWire[];
  keepOut?: RouteKeepOut[];
  /** grid cell size, mm (chosen from the region's size when left out) */
  cell?: number;
}

export interface RoutedWire {
  id: string;
  /** smooth centre line from a.p to b.p, assembly coordinates */
  points: V3[];
  /** length of the centre line, mm */
  length: number;
  /** cells of the path that are inside a part's surface: the router had to go through one */
  through: number;
  /** no path was found in the search budget: a straight line is drawn instead */
  straight: boolean;
}

export interface RouteResult {
  wires: RoutedWire[];
  cell: number;
  ms: number;
}

const COST_HUG = 1;
const COST_FREE = 1.8;
const COST_SOLID = 400;
/** a cell a moving part sweeps through: avoided, but a plug inside one can still get out */
const COST_KEEP = 8;
const BUNDLE = 0.55;
const TURN = 1.6;
const MAX_CELLS = 2_400_000;
const MAX_EXPAND = 2_000_000;
/** cells a plug's end may search through to get out of a solid */
const MAX_ESCAPE = 400_000;

class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly solid: Uint8Array;
  /** 1: a free cell next to a solid one */
  readonly hug: Uint8Array;
  /** how many routed cables pass through each cell */
  readonly use: Uint16Array;
  /** keep-out groups covering each cell */
  readonly keep: Uint16Array;

  constructor(
    readonly min: V3,
    readonly h: number,
    max: V3,
  ) {
    this.nx = Math.max(1, Math.ceil((max[0] - min[0]) / h));
    this.ny = Math.max(1, Math.ceil((max[1] - min[1]) / h));
    this.nz = Math.max(1, Math.ceil((max[2] - min[2]) / h));
    this.n = this.nx * this.ny * this.nz;
    this.solid = new Uint8Array(this.n);
    this.hug = new Uint8Array(this.n);
    this.use = new Uint16Array(this.n);
    this.keep = new Uint16Array(this.n);
  }

  markKeepOut(k: RouteKeepOut) {
    const [i0, j0, k0] = this.cellOf(k.lo);
    const [i1, j1, k1] = this.cellOf(k.hi);
    for (let z = k0; z <= k1; z++) for (let y = j0; y <= j1; y++) for (let x = i0; x <= i1; x++) this.keep[this.index(x, y, z)] |= k.bit;
  }

  index(i: number, j: number, k: number) {
    return i + this.nx * (j + this.ny * k);
  }

  cellOf(p: V3): [number, number, number] {
    const c = (v: number, o: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((v - o) / this.h)));
    return [c(p[0], this.min[0], this.nx), c(p[1], this.min[1], this.ny), c(p[2], this.min[2], this.nz)];
  }

  center(idx: number): V3 {
    const i = idx % this.nx;
    const j = Math.floor(idx / this.nx) % this.ny;
    const k = Math.floor(idx / (this.nx * this.ny));
    return [this.min[0] + (i + 0.5) * this.h, this.min[1] + (j + 0.5) * this.h, this.min[2] + (k + 0.5) * this.h];
  }

  solidAt(p: V3): boolean {
    const [i, j, k] = this.cellOf(p);
    return this.solid[this.index(i, j, k)] === 1;
  }

  /** mark the cells a triangle passes through, by sampling it finer than a cell */
  markTriangle(a: V3, b: V3, c: V3) {
    // start at the corner shared by the longest and shortest edges so a sliver needs few samples
    const pts = [a, b, c];
    const len = (p: V3, q: V3) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const e = [len(b, c), len(c, a), len(a, b)]; // edge opposite each corner
    const longest = e.indexOf(Math.max(...e));
    const shortest = e.indexOf(Math.min(...e));
    // the corner on both edges is the one opposite neither
    const o = longest === shortest ? 0 : 3 - longest - shortest;
    const p0 = pts[o];
    const p1 = pts[(o + 1) % 3];
    const p2 = pts[(o + 2) % 3];
    const s = this.h * 0.45;
    const n1 = Math.max(1, Math.ceil(len(p0, p1) / s));
    const n2 = Math.max(1, Math.ceil(len(p0, p2) / s));
    const { nx, ny, nz, min, h } = this;
    for (let i = 0; i <= n1; i++) {
      const u = i / n1;
      const jmax = Math.floor((1 - u) * n2 + 1e-9);
      for (let j = 0; j <= jmax; j++) {
        const v = j / n2;
        const x = p0[0] + u * (p1[0] - p0[0]) + v * (p2[0] - p0[0]);
        const y = p0[1] + u * (p1[1] - p0[1]) + v * (p2[1] - p0[1]);
        const z = p0[2] + u * (p1[2] - p0[2]) + v * (p2[2] - p0[2]);
        const ci = Math.floor((x - min[0]) / h);
        const cj = Math.floor((y - min[1]) / h);
        const ck = Math.floor((z - min[2]) / h);
        if (ci < 0 || cj < 0 || ck < 0 || ci >= nx || cj >= ny || ck >= nz) continue;
        this.solid[ci + nx * (cj + ny * ck)] = 1;
      }
    }
  }

  /** mark every cell whose centre is inside a box in a part's frame */
  fillBox(m: number[], box: [V3, V3]) {
    const inv = invert(m);
    if (!inv) return;
    const [lo, hi] = box;
    const wlo: V3 = [Infinity, Infinity, Infinity];
    const whi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = transform(m, c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]);
      for (let k = 0; k < 3; k++) {
        wlo[k] = Math.min(wlo[k], p[k]);
        whi[k] = Math.max(whi[k], p[k]);
      }
    }
    const [i0, j0, k0] = this.cellOf(wlo);
    const [i1, j1, k1] = this.cellOf(whi);
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const q = transform(inv, this.min[0] + (i + 0.5) * this.h, this.min[1] + (j + 0.5) * this.h, this.min[2] + (k + 0.5) * this.h);
          if (q[0] >= lo[0] && q[0] <= hi[0] && q[1] >= lo[1] && q[1] <= hi[1] && q[2] >= lo[2] && q[2] <= hi[2]) this.solid[this.index(i, j, k)] = 1;
        }
  }

  /** close openings one cell wide (vents, slots between parts) so cables don't thread through them */
  close() {
    const { nx, ny, nz } = this;
    const sxy = nx * ny;
    const grown = this.solid.slice();
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          if (this.solid[idx]) continue;
          const s = this.solid;
          if ((i > 0 && s[idx - 1]) || (i < nx - 1 && s[idx + 1]) || (j > 0 && s[idx - nx]) || (j < ny - 1 && s[idx + nx]) || (k > 0 && s[idx - sxy]) || (k < nz - 1 && s[idx + sxy])) grown[idx] = 1;
        }
    // shrink back: a grown cell stays solid only if all its neighbours are solid after growing
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          if (this.solid[idx] || !grown[idx]) continue;
          const g = grown;
          const all = (i === 0 || g[idx - 1]) && (i === nx - 1 || g[idx + 1]) && (j === 0 || g[idx - nx]) && (j === ny - 1 || g[idx + nx]) && (k === 0 || g[idx - sxy]) && (k === nz - 1 || g[idx + sxy]);
          if (all) this.solid[idx] = 1;
        }
  }

  buildHug() {
    const { nx, ny, nz, solid, hug } = this;
    const sxy = nx * ny;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          if (solid[idx]) continue;
          if ((i > 0 && solid[idx - 1]) || (i < nx - 1 && solid[idx + 1]) || (j > 0 && solid[idx - nx]) || (j < ny - 1 && solid[idx + nx]) || (k > 0 && solid[idx - sxy]) || (k < nz - 1 && solid[idx + sxy])) hug[idx] = 1;
        }
  }
}

/** Binary min-heap of cell indices keyed by f. */
class Heap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;
  clear() {
    this.size = 0;
  }
  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.size * 2);
      v.set(this.vals);
      this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }
  pop(): number {
    const top = this.vals[0];
    const lastK = this.keys[--this.size];
    const lastV = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastK) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = lastK;
    this.vals[i] = lastV;
    return top;
  }
}

function transform(m: number[], x: number, y: number, z: number): V3 {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** Inverse of a column-major affine 4×4. */
function invert(m: number[]): number[] | null {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (Math.abs(det) < 1e-12) return null;
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const t = [m[12], m[13], m[14]];
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, -(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]), -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]), -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]), 1];
}

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** the region cables can use: around their ends, inside the assembly's bounds plus a margin */
function region(input: RouteInput, world: Float32Array[]): { min: V3; max: V3 } {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  const grow = (p: ArrayLike<number>, o = 0) => {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[o + k]);
      hi[k] = Math.max(hi[k], p[o + k]);
    }
  };
  for (const w of input.wires) {
    grow(w.a.p);
    grow(w.b.p);
  }
  const margin = 70;
  const elo: V3 = [lo[0] - margin, lo[1] - margin, lo[2] - margin];
  const ehi: V3 = [hi[0] + margin, hi[1] + margin, hi[2] + margin];
  // no further than the parts themselves reach, plus room to pass around the outside
  const glo: V3 = [Infinity, Infinity, Infinity];
  const ghi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const pos of world)
    for (let i = 0; i < pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (pos[i + k] < glo[k]) glo[k] = pos[i + k];
        if (pos[i + k] > ghi[k]) ghi[k] = pos[i + k];
      }
  const min: V3 = [0, 0, 0];
  const max: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    min[k] = Number.isFinite(glo[k]) ? Math.max(elo[k], Math.min(lo[k], glo[k]) - 20) : elo[k];
    max[k] = Number.isFinite(ghi[k]) ? Math.min(ehi[k], Math.max(hi[k], ghi[k]) + 20) : ehi[k];
  }
  return { min, max };
}

/** Route every cable. Cables are routed in the order given, each one drawn to the ones before it. */
export function routeCables(input: RouteInput): RouteResult {
  const t0 = Date.now();
  // place every solid's vertices in the assembly once
  const world = input.placed.map((pl) => {
    const g = input.geos[pl.geo];
    const out = new Float32Array(g.positions.length);
    for (let i = 0; i < g.positions.length; i += 3) {
      const p = transform(pl.m, g.positions[i], g.positions[i + 1], g.positions[i + 2]);
      out[i] = p[0];
      out[i + 1] = p[1];
      out[i + 2] = p[2];
    }
    return out;
  });
  const { min, max } = region(input, world);
  const vol = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  const h = input.cell ?? Math.max(2.5, Math.cbrt(vol / MAX_CELLS) * 1.02);
  const grid = new Grid(min, h, max);
  input.placed.forEach((pl, n) => {
    const idx = input.geos[pl.geo].indices;
    const pos = world[n];
    const v = (i: number): V3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    for (let t = 0; t < idx.length; t += 3) grid.markTriangle(v(idx[t]), v(idx[t + 1]), v(idx[t + 2]));
    if (pl.box) grid.fillBox(pl.m, pl.box);
  });
  grid.close();
  grid.buildHug();
  for (const k of input.keepOut ?? []) grid.markKeepOut(k);

  const search = new Search(grid);
  const paths: { wire: RouteWire; cells: number[] }[] = [];
  for (const w of input.wires) {
    const cells = search.find(w);
    for (const c of cells) if (grid.use[c] < 65535) grid.use[c]++;
    paths.push({ wire: w, cells });
  }
  const wires = paths.map((p, n) => finish(grid, p.wire, p.cells, n, paths));
  return { wires, cell: h, ms: Date.now() - t0 };
}

class Search {
  private g: Float32Array;
  private parent: Int32Array;
  private stamp: Uint16Array;
  private closed: Uint16Array;
  private gen = 0;
  private heap = new Heap();

  constructor(private grid: Grid) {
    this.g = new Float32Array(grid.n);
    this.parent = new Int32Array(grid.n);
    this.stamp = new Uint16Array(grid.n);
    this.closed = new Uint16Array(grid.n);
  }

  /**
   * The cells from a plug's end out to free space: just the nearest free cell
   * when there is one close by (looking along the plug's direction first), or
   * the shortest way out when the end is deep inside a part's filled box (a
   * speaker's tabs under its basket).
   */
  private entry(e: RouteEnd): number[] {
    const gr = this.grid;
    for (let s = 0; s <= 8; s++) {
      const [i, j, k] = gr.cellOf(add(e.p, e.dir, s * gr.h * 0.75));
      const idx = gr.index(i, j, k);
      if (!gr.solid[idx]) return [idx];
    }
    const [i0, j0, k0] = gr.cellOf(e.p);
    for (let r = 1; r <= 6; r++)
      for (let dk = -r; dk <= r; dk++)
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
            const i = i0 + di;
            const j = j0 + dj;
            const k = k0 + dk;
            if (i < 0 || j < 0 || k < 0 || i >= gr.nx || j >= gr.ny || k >= gr.nz) continue;
            const idx = gr.index(i, j, k);
            if (!gr.solid[idx]) return [idx];
          }
    // breadth first through the solid to the nearest free cell
    const from = gr.index(i0, j0, k0);
    const parent = new Map<number, number>([[from, -1]]);
    const { nx, ny, nz } = gr;
    const sxy = nx * ny;
    let queue = [from];
    while (queue.length && parent.size < MAX_ESCAPE) {
      const next: number[] = [];
      for (const u of queue) {
        const ui = u % nx;
        const uj = Math.floor(u / nx) % ny;
        const uk = Math.floor(u / sxy);
        const around = [ui < nx - 1 ? u + 1 : -1, ui > 0 ? u - 1 : -1, uj < ny - 1 ? u + nx : -1, uj > 0 ? u - nx : -1, uk < nz - 1 ? u + sxy : -1, uk > 0 ? u - sxy : -1];
        for (const v of around) {
          if (v < 0 || parent.has(v)) continue;
          parent.set(v, u);
          if (!gr.solid[v]) {
            const out: number[] = [];
            for (let c = v; c >= 0; c = parent.get(c)!) out.push(c);
            return out.reverse();
          }
          next.push(v);
        }
      }
      queue = next;
    }
    return [from];
  }

  find(w: RouteWire): number[] {
    const gr = this.grid;
    const { nx, ny, nz } = gr;
    const sxy = nx * ny;
    const leadA = this.entry(w.a);
    const leadB = this.entry(w.b);
    const start = leadA[leadA.length - 1];
    const goal = leadB[leadB.length - 1];
    const join = (core: number[]) => [...leadA.slice(0, -1), ...core, ...leadB.slice(0, -1).reverse()];
    if (start === goal) return join([start]);
    if (++this.gen === 65535) {
      this.gen = 1;
      this.stamp.fill(0);
      this.closed.fill(0);
    }
    const gen = this.gen;
    const { g, parent, stamp, closed, heap } = this;
    const gi = goal % nx;
    const gj = Math.floor(goal / nx) % ny;
    const gk = Math.floor(goal / sxy);
    const hcost = (idx: number) => {
      const i = idx % nx;
      const j = Math.floor(idx / nx) % ny;
      const k = Math.floor(idx / sxy);
      return Math.abs(i - gi) + Math.abs(j - gj) + Math.abs(k - gk);
    };
    heap.clear();
    g[start] = 0;
    parent[start] = -1;
    stamp[start] = gen;
    heap.push(hcost(start), start);
    const steps = [1, -1, nx, -nx, sxy, -sxy];
    const avoid = w.avoid ?? 0;
    let expanded = 0;
    let found = false;
    while (heap.size) {
      const u = heap.pop();
      if (closed[u] === gen) continue;
      closed[u] = gen;
      if (u === goal) {
        found = true;
        break;
      }
      if (++expanded > MAX_EXPAND) break;
      const ui = u % nx;
      const uj = Math.floor(u / nx) % ny;
      const uk = Math.floor(u / sxy);
      const pu = parent[u];
      const inDir = pu < 0 ? 0 : u - pu;
      for (let s = 0; s < 6; s++) {
        const d = steps[s];
        if ((s === 0 && ui === nx - 1) || (s === 1 && ui === 0) || (s === 2 && uj === ny - 1) || (s === 3 && uj === 0) || (s === 4 && uk === nz - 1) || (s === 5 && uk === 0)) continue;
        const v = u + d;
        if (closed[v] === gen) continue;
        let c = gr.solid[v] ? COST_SOLID : gr.hug[v] ? COST_HUG : COST_FREE;
        if (gr.use[v]) c *= BUNDLE;
        if (avoid && gr.keep[v] & avoid) c += COST_KEEP;
        if (inDir && d !== inDir) c += TURN;
        const ng = g[u] + c;
        if (stamp[v] !== gen || ng < g[v]) {
          stamp[v] = gen;
          g[v] = ng;
          parent[v] = u;
          heap.push(ng + hcost(v), v);
        }
      }
    }
    if (!found) return [];
    const out: number[] = [];
    for (let c = goal; c >= 0; c = parent[c]) out.push(c);
    return join(out.reverse());
  }
}

/** Spread cables that share cells into a loose bundle, smooth the bends, and measure the result. */
function finish(grid: Grid, w: RouteWire, cells: number[], n: number, all: { wire: RouteWire; cells: number[] }[]): RoutedWire {
  if (!cells.length) {
    const points = [w.a.p, w.b.p];
    return { id: w.id, points, length: dist(w.a.p, w.b.p), through: 0, straight: true };
  }
  const centers = cells.map((c) => grid.center(c));
  // cables in each shared cell sit side by side, in routing order, across the run's direction
  const offsets = cells.map((c, i) => {
    const users = grid.use[c];
    if (users <= 1) return [0, 0, 0] as V3;
    let rank = 0;
    for (let m = 0; m < n; m++) if (all[m].cells.includes(c)) rank++;
    const prev = centers[Math.max(0, i - 1)];
    const next = centers[Math.min(centers.length - 1, i + 1)];
    const axis = [Math.abs(next[0] - prev[0]), Math.abs(next[1] - prev[1]), Math.abs(next[2] - prev[2])];
    const along = axis.indexOf(Math.max(...axis));
    const u = (along + 1) % 3;
    const v = (along + 2) % 3;
    // rings around the bundle's centre, about a cable apart
    const pitch = Math.min(grid.h * 0.45, w.d * 1.15 + 0.3);
    const slot = rank;
    const ring = slot === 0 ? 0 : Math.ceil((Math.sqrt(1 + (4 * slot) / 3) - 1) / 2);
    const inRing = slot === 0 ? 0 : slot - (3 * ring * (ring - 1) + 1);
    const count = Math.max(1, 6 * ring);
    const a = (inRing / count) * Math.PI * 2 + ring * 0.5;
    const o: V3 = [0, 0, 0];
    o[u] = Math.cos(a) * ring * pitch;
    o[v] = Math.sin(a) * ring * pitch;
    return o;
  });
  // smooth the offsets along the run so cables do not jump as others join or leave
  const smoothOff = offsets.map((_, i) => {
    const s: V3 = [0, 0, 0];
    let k = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(offsets.length - 1, i + 3); j++) {
      s[0] += offsets[j][0];
      s[1] += offsets[j][1];
      s[2] += offsets[j][2];
      k++;
    }
    return [s[0] / k, s[1] / k, s[2] / k] as V3;
  });
  let pts: V3[] = [w.a.p, ...centers.map((c, i) => add(c, smoothOff[i])), w.b.p];
  // drop cell centres that double back past the exact end points
  pts = trimEnds(pts);
  const through = cells.filter((c) => grid.solid[c]).length;
  pts = smooth(grid, pts, 6);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += dist(pts[i - 1], pts[i]);
  return { id: w.id, points: pts, length, through, straight: false };
}

/** Skip the first and last cell centres when the exact end lies beyond them along the path. */
function trimEnds(pts: V3[]): V3[] {
  if (pts.length < 4) return pts;
  const out = [...pts];
  const dot = (a: V3, b: V3, c: V3) => (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) + (b[2] - a[2]) * (c[2] - b[2]);
  if (dot(out[0], out[1], out[2]) < 0) out.splice(1, 1);
  const n = out.length;
  if (n >= 4 && dot(out[n - 3], out[n - 2], out[n - 1]) < 0) out.splice(n - 2, 1);
  return out;
}

/** Laplacian smoothing that keeps the ends and never moves a point into a part. */
function smooth(grid: Grid, pts: V3[], iterations: number): V3[] {
  let cur = pts.map((p) => [...p] as V3);
  for (let it = 0; it < iterations; it++) {
    const next = cur.map((p) => [...p] as V3);
    for (let i = 1; i < cur.length - 1; i++) {
      const q: V3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) q[k] = cur[i][k] * 0.5 + (cur[i - 1][k] + cur[i + 1][k]) * 0.25;
      // a point that was clear stays clear
      if (!grid.solidAt(q) || grid.solidAt(cur[i])) next[i] = q;
    }
    cur = next;
  }
  return cur;
}
