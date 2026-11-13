// Routes cables through the assembly. The parts are filled into a voxel
// grid (surface and inside), a signed distance field says how much room
// each free cell has, and each cable is found with A* over the cells it
// fits through, preferring to run along surfaces (as cables are tied along a
// frame), to keep straight and to run beside cables already routed, so they
// gather into a harness. Wires that start together and end together (the
// conductors of a servo lead, a motor's three phases, a sensor's four wires)
// are routed as one cable and lie side by side all the way along it. Each
// cell path is then dressed like a real cable: straight out of its plug,
// pulled straight where it crosses open space and where it only zigzagged
// along a face, never through a part, and bent no tighter than a cable of its
// size bends. The dressed runs are relaxed together (relax.ts): smoothed and
// kept out of the parts and of each other.
// Plain arithmetic on typed arrays: it runs in a worker and in Node tests.

import type { V3 } from "../../kernel/recipe";
import { inCone, zoneBounds, type FlowZone } from "./flow";
import { relaxCables, type SignedField } from "./relax";
import { Solids, invert, transform, type SolidRole } from "./solids";

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
  /** the part's id, its component instance and what it is, for the wiring checks */
  id?: string;
  comp?: string;
  role?: SolidRole;
  removable?: boolean;
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
  /** places the cable passes on its way, in order: where it crosses a pivot, beside the axis */
  via?: RouteVia[];
  /** keep-out groups for each leg between a, the via points and b (in place of avoid) */
  legAvoid?: number[];
}

/** Where a cable crosses a pivot: near `c`, as close to the axis (through `at`) as there is room for it. */
export interface RouteVia {
  c: V3;
  axis: V3;
  at: V3;
  /** cross at `c` itself (the design's own crossing point), not as near the axis as there is room */
  here?: boolean;
}

/** Space a cable should not be tied in: where a moving part or a drag chain goes (assembly coordinates). */
export interface RouteKeepOut {
  lo: V3;
  hi: V3;
  /** its group, one bit of 16 */
  bit: number;
  /** lo and hi are in this frame (column-major), not the assembly's: a moving part's box at one place in its travel */
  m?: number[];
}

export interface RouteInput {
  geos: RouteGeometry[];
  placed: RoutePlaced[];
  wires: RouteWire[];
  keepOut?: RouteKeepOut[];
  /** fans' intakes and jets: no cable runs in them */
  flow?: FlowZone[];
  /** grid cell size, mm (chosen from the region's size when left out) */
  cell?: number;
}

export interface RoutedWire {
  id: string;
  /** smooth centre line from a.p to b.p, assembly coordinates */
  points: V3[];
  /** length of the centre line, mm */
  length: number;
  /** cells of the path that are inside a part: the router had to go through one */
  through: number;
  /** no path was found in the search budget: a straight line is drawn instead */
  straight: boolean;
  /** outer radius of the cable, mm */
  r: number;
  /** where it crossed each pivot (the via cells' centres), and how far from the axis; null where there was no room beside the bearing */
  via?: ({ p: V3; r: number } | null)[];
}

export interface RouteResult {
  wires: RoutedWire[];
  cell: number;
  ms: number;
  /** time spent in each stage, ms */
  stages?: Record<string, number>;
}

/** Room the router leaves between a cable and a part, mm, on top of the cable's radius. */
export const CLEAR = 0.25;
const COST_HUG = 1;
/** A cable may reach this far from a surface and still be tied to it, mm. */
export const TIE_REACH = 6;
/** a cell off a part but still within reach of a tie to it: a cable may bridge a hollow or cut a corner without leaving the structure */
const COST_NEAR = 1.25;
/** a cell out in the open, where a cable hangs free */
const COST_FREE = 3;
const COST_SOLID = 4000;
/** a cell outside the assembly, for a cable whose ends are both inside it: out through a hole and back in is a cable left in the open */
const COST_OUT = 200;
/** holes narrower than twice this are closed when finding the outside, mm */
const OUT_REACH = 8;
/** a free cell too close to a part for the cable to pass without pressing on it */
const COST_TIGHT = 30;
/** a cell a moving part sweeps through: avoided, but a plug inside one can still get out */
const COST_KEEP = 8;
/** a cell in a fan's intake or jet: as good as closed to cables (a plug inside one can still get out) */
const COST_FLOW = 60;
/** how far round a pivot's crossing point to look for room for the cable, mm */
const VIA_REACH = 40;
/** the cells beside a routed cable, on the same part, cost less: the next cable runs alongside it and they gather into a bundle, laid side by side (a cable on top of another is out of reach of a tie to the part) */
const BUNDLE = 0.6;
/** a cell another cable already runs in: two do not fit in one, so the next one goes beside it unless there is no room */
const COST_SHARE = 2.4;
const TURN = 3;
/**
 * How much of the straight-line distance the search counts on: under 1 it looks wider and finds runs that follow the
 * structure and the cables already there, where a greedy search takes the first way through
 */
const AIM = 0.8;
/** wires whose ends are no further apart than this, at both ends, run as one cable, mm */
const SPAN = 22;
/** room between the wires of one cable, mm (a little more than relax.ts keeps between any two, so it leaves them be) */
const LAY = 0.14;
/** the least bend radius of a run, in cable diameters, and in mm for the thinnest wire */
const BEND = 3;
const BEND_MIN = 4;
/** a cell beside a run's own straight start, closer than a bend's width: the run comes back past its plug in a bend it can make, not a fold */
const COST_FOLD = 12;
/** a dressed run stays within this many cells of the path the search found */
const STRAY = 1.5;
const MAX_CELLS = 2_400_000;
const MAX_EXPAND = 2_000_000;
/** cells a plug's end may search through to get out of a solid */
const MAX_ESCAPE = 400_000;
/** a part bigger than this many cells is marked by its surface only */
const MAX_PART_CELLS = 6_000_000;

class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly solid: Uint8Array;
  /** signed distance from each cell centre to the parts' surfaces, mm: positive in free space, negative inside a part */
  phi: Float32Array;
  /** free cells outside the assembly (1), from buildOutside */
  outside: Uint8Array;
  /** which closed-off space each free cell inside the assembly is in (1, 2, ...; 0 outside it or in a part) */
  region: Int32Array;
  /** how many routed cables pass through each cell */
  readonly use: Uint16Array;
  /** cells next to one a routed cable passes through (1) */
  readonly side: Uint8Array;
  /** keep-out groups covering each cell */
  readonly keep: Uint16Array;
  /** cells in a fan's intake or jet (1) */
  readonly flow: Uint8Array;

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
    this.phi = new Float32Array(0);
    this.outside = new Uint8Array(0);
    this.region = new Int32Array(0);
    this.use = new Uint16Array(this.n);
    this.side = new Uint8Array(this.n);
    this.keep = new Uint16Array(this.n);
    this.flow = new Uint8Array(this.n);
  }

  markKeepOut(k: RouteKeepOut) {
    if (k.m) return this.markKeepBox(k);
    const [i0, j0, k0] = this.cellOf(k.lo);
    const [i1, j1, k1] = this.cellOf(k.hi);
    for (let z = k0; z <= k1; z++) for (let y = j0; y <= j1; y++) for (let x = i0; x <= i1; x++) this.keep[this.index(x, y, z)] |= k.bit;
  }

  /** a keep-out box in its own frame: the cells whose centres are inside it */
  private markKeepBox(k: RouteKeepOut) {
    const m = k.m!;
    const inv = invert(m);
    if (!inv) return;
    const { lo, hi } = k;
    const wlo: V3 = [Infinity, Infinity, Infinity];
    const whi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = transform(m, c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]);
      for (let a = 0; a < 3; a++) {
        wlo[a] = Math.min(wlo[a], p[a]);
        whi[a] = Math.max(whi[a], p[a]);
      }
    }
    const [i0, j0, k0] = this.cellOf(wlo);
    const [i1, j1, k1] = this.cellOf(whi);
    // half a cell of give, so a box no wider than a cell still marks the cells it runs through
    const g = this.h / 2;
    for (let z = k0; z <= k1; z++)
      for (let y = j0; y <= j1; y++)
        for (let x = i0; x <= i1; x++) {
          const q = transform(inv, this.min[0] + (x + 0.5) * this.h, this.min[1] + (y + 0.5) * this.h, this.min[2] + (z + 0.5) * this.h);
          if (q[0] >= lo[0] - g && q[0] <= hi[0] + g && q[1] >= lo[1] - g && q[1] <= hi[1] + g && q[2] >= lo[2] - g && q[2] <= hi[2] + g) this.keep[this.index(x, y, z)] |= k.bit;
        }
  }

  /**
   * Mark a fan's intake or jet: the free cells in its cone that the axis can see. A cell behind a wall (outside a
   * duct, round the back of a lip) is out of the flow, so the march toward the axis stops at the first solid cell; it
   * stops short of the axis itself, where the fan's own hub is.
   */
  markFlow(z: FlowZone) {
    const [lo, hi] = zoneBounds(z);
    const [i0, j0, k0] = this.cellOf(lo);
    const [i1, j1, k1] = this.cellOf(hi);
    const step = this.h * 0.8;
    for (let kz = k0; kz <= k1; kz++)
      for (let jy = j0; jy <= j1; jy++)
        for (let ix = i0; ix <= i1; ix++) {
          const c = this.index(ix, jy, kz);
          if (this.solid[c] || this.flow[c]) continue;
          const p = this.center(c);
          const s = inCone(z, p);
          if (s < 0) continue;
          const foot: V3 = [z.o[0] + z.dir[0] * s, z.o[1] + z.dir[1] * s, z.o[2] + z.dir[2] * s];
          const r = dist(p, foot);
          const stop = Math.min(r, 0.5 * z.r0);
          let open = true;
          for (let t = step; t < r - stop; t += step) {
            const q: V3 = [p[0] + ((foot[0] - p[0]) * t) / r, p[1] + ((foot[1] - p[1]) * t) / r, p[2] + ((foot[2] - p[2]) * t) / r];
            if (this.solidAt(q)) {
              open = false;
              break;
            }
          }
          if (open) this.flow[c] = 1;
        }
  }

  private comps: Int32Array | null = null;
  /** which connected piece of free space each cell is in (0 in a part), worked out the first time it is asked */
  freeComp(): Int32Array {
    if (this.comps) return this.comps;
    const { nx, ny, nz, solid } = this;
    const sxy = nx * ny;
    const comp = new Int32Array(this.n);
    const queue = new Int32Array(this.n);
    let next = 0;
    for (let c0 = 0; c0 < this.n; c0++) {
      if (comp[c0] || solid[c0]) continue;
      comp[c0] = ++next;
      let head = 0;
      let tail = 0;
      queue[tail++] = c0;
      while (head < tail) {
        const c = queue[head++];
        const i = c % nx;
        const j = Math.floor(c / nx) % ny;
        const k = Math.floor(c / sxy);
        const visit = (v: number) => {
          if (comp[v] || solid[v]) return;
          comp[v] = next;
          queue[tail++] = v;
        };
        if (i > 0) visit(c - 1);
        if (i < nx - 1) visit(c + 1);
        if (j > 0) visit(c - nx);
        if (j < ny - 1) visit(c + nx);
        if (k > 0) visit(c - sxy);
        if (k < nz - 1) visit(c + sxy);
      }
    }
    this.comps = comp;
    return comp;
  }

  flowAt(x: number, y: number, z: number): boolean {
    const [i, j, k] = this.cellOf([x, y, z]);
    return this.flow[this.index(i, j, k)] === 1;
  }

  keepAt(x: number, y: number, z: number): number {
    const [i, j, k] = this.cellOf([x, y, z]);
    return this.keep[this.index(i, j, k)];
  }

  /**
   * A cable of radius r now runs through these cells: count it in every cell it fills, and mark the cells beside it
   * for the next one.
   */
  occupy(cells: number[], r = 0) {
    const { nx, ny, nz, use, side, h } = this;
    const sxy = nx * ny;
    // cells out from the centre line the cable fills
    const k = Math.max(0, Math.round(r / h - 0.5));
    const filled = new Set<number>();
    for (const c of cells) {
      if (k === 0) {
        filled.add(c);
        continue;
      }
      const ci = c % nx;
      const cj = Math.floor(c / nx) % ny;
      const ck = Math.floor(c / sxy);
      for (let dk = -k; dk <= k; dk++)
        for (let dj = -k; dj <= k; dj++)
          for (let di = -k; di <= k; di++) {
            if (di * di + dj * dj + dk * dk > (k + 0.3) * (k + 0.3)) continue;
            const i = ci + di;
            const j = cj + dj;
            const l = ck + dk;
            if (i < 0 || j < 0 || l < 0 || i >= nx || j >= ny || l >= nz) continue;
            filled.add(i + nx * (j + ny * l));
          }
    }
    for (const c of filled) {
      if (use[c] < 65535) use[c]++;
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const l = Math.floor(c / sxy);
      if (i > 0) side[c - 1] = 1;
      if (i < nx - 1) side[c + 1] = 1;
      if (j > 0) side[c - nx] = 1;
      if (j < ny - 1) side[c + nx] = 1;
      if (l > 0) side[c - sxy] = 1;
      if (l < nz - 1) side[c + sxy] = 1;
    }
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

  /**
   * Mark one part: its surface cells, and the cells inside it (those its
   * surface closes off from the outside of its own box), so a cable that
   * goes in has to come out through solid again.
   */
  markPart(pos: Float32Array, idx: Uint32Array, probe?: PartProbe) {
    const { h } = this;
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], pos[i + k]);
        hi[k] = Math.max(hi[k], pos[i + k]);
      }
    if (!Number.isFinite(lo[0])) return;
    // the part's own little grid, one cell wider than it all round and aligned with this one
    const i0 = Math.floor((lo[0] - this.min[0]) / h) - 1;
    const j0 = Math.floor((lo[1] - this.min[1]) / h) - 1;
    const k0 = Math.floor((lo[2] - this.min[2]) / h) - 1;
    const lx = Math.floor((hi[0] - this.min[0]) / h) + 2 - i0;
    const ly = Math.floor((hi[1] - this.min[1]) / h) + 2 - j0;
    const lz = Math.floor((hi[2] - this.min[2]) / h) + 2 - k0;
    // clear of the grid altogether
    if (i0 + lx < 0 || j0 + ly < 0 || k0 + lz < 0 || i0 >= this.nx || j0 >= this.ny || k0 >= this.nz) return;
    const fill = lx * ly * lz <= MAX_PART_CELLS;
    const lmin: V3 = [this.min[0] + i0 * h, this.min[1] + j0 * h, this.min[2] + k0 * h];
    if (!fill) {
      // too big to fill: its surface alone, straight into the grid
      for (let t = 0; t < idx.length; t += 3) markTriangle(this.solid, this.min, h, this.nx, this.ny, this.nz, pos, idx[t], idx[t + 1], idx[t + 2]);
      return;
    }
    const cells = new Uint8Array(lx * ly * lz);
    for (let t = 0; t < idx.length; t += 3) markTriangle(cells, lmin, h, lx, ly, lz, pos, idx[t], idx[t + 1], idx[t + 2]);
    // keep only the cells whose centre is within half a cell of the surface: still a wall no step can pass (a step is one cell),
    // but a hole a few cells across stays open, where every cell its edge touches would close it
    const at = (c: number): V3 => [lmin[0] + ((c % lx) + 0.5) * h, lmin[1] + ((Math.floor(c / lx) % ly) + 0.5) * h, lmin[2] + (Math.floor(c / (lx * ly)) + 0.5) * h];
    if (probe)
      for (let c = 0; c < cells.length; c++) {
        if (cells[c] !== 1) continue;
        const p = at(c);
        if (probe.surface(p[0], p[1], p[2], h / 2 + 1e-3) > h / 2) cells[c] = 0;
      }
    // flood the outside in from the little grid's border; what it never reaches is inside
    const sxy = lx * ly;
    const queue = new Int32Array(lx * ly * lz);
    let head = 0;
    let tail = 0;
    const seed = (c: number) => {
      if (cells[c]) return;
      cells[c] = 2;
      queue[tail++] = c;
    };
    for (let z = 0; z < lz; z++)
      for (let y = 0; y < ly; y++)
        for (let x = 0; x < lx; x++) if (x === 0 || y === 0 || z === 0 || x === lx - 1 || y === ly - 1 || z === lz - 1) seed(x + lx * (y + ly * z));
    while (head < tail) {
      const c = queue[head++];
      const x = c % lx;
      const y = Math.floor(c / lx) % ly;
      const z = Math.floor(c / sxy);
      if (x > 0) seed(c - 1);
      if (x < lx - 1) seed(c + 1);
      if (y > 0) seed(c - lx);
      if (y < ly - 1) seed(c + lx);
      if (z > 0) seed(c - sxy);
      if (z < lz - 1) seed(c + sxy);
    }
    // what the flood never reached is the part's material, or a hollow it closes in (a sealed box's inside, a sleeve's bore
    // closed at both ends): one inside test for each pocket of unreached cells tells which, and a hollow stays free
    if (probe) {
      for (let c = 0; c < cells.length; c++) {
        if (cells[c] !== 0) continue;
        const p = at(c);
        const keep = probe.inside(p[0], p[1], p[2]) ? 3 : 2;
        cells[c] = keep;
        head = tail = 0;
        queue[tail++] = c;
        while (head < tail) {
          const u = queue[head++];
          const x = u % lx;
          const y = Math.floor(u / lx) % ly;
          const z = Math.floor(u / sxy);
          const visit = (v: number) => {
            if (cells[v] !== 0) return;
            cells[v] = keep;
            queue[tail++] = v;
          };
          if (x > 0) visit(u - 1);
          if (x < lx - 1) visit(u + 1);
          if (y > 0) visit(u - lx);
          if (y < ly - 1) visit(u + lx);
          if (z > 0) visit(u - sxy);
          if (z < lz - 1) visit(u + sxy);
        }
      }
    }
    for (let z = 0; z < lz; z++) {
      const gk = k0 + z;
      if (gk < 0 || gk >= this.nz) continue;
      for (let y = 0; y < ly; y++) {
        const gj = j0 + y;
        if (gj < 0 || gj >= this.ny) continue;
        for (let x = 0; x < lx; x++) {
          const gi = i0 + x;
          if (gi < 0 || gi >= this.nx) continue;
          if (cells[x + lx * (y + ly * z)] !== 2) this.solid[gi + this.nx * (gj + this.ny * gk)] = 1;
        }
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

  /** The signed distance field, from the distances to the nearest solid and the nearest free cell centres. */
  buildField() {
    const toSolid = edt3(this.solid, 1, this.nx, this.ny, this.nz);
    const toFree = edt3(this.solid, 0, this.nx, this.ny, this.nz);
    const phi = new Float32Array(this.n);
    const half = this.h / 2;
    for (let i = 0; i < this.n; i++) phi[i] = this.solid[i] ? -(Math.sqrt(toFree[i]) * this.h - half) : Math.sqrt(toSolid[i]) * this.h - half;
    this.phi = phi;
  }

  /**
   * Measure the cells along the routed runs exactly. The field from the grid alone is a cell coarse next to a part
   * (a part's skin cells stand up to half a cell proud of it), which would leave a cable that follows a part up to a
   * cell off it. With the true distance in the cells around each run, out to where the cable lies with its room, a
   * run can be laid on the part it follows. `exact` gives the signed distance from a point to the nearest part
   * within reach (Infinity when there is none).
   */
  sharpen(runs: { cells: number[]; reach: number }[], exact: (x: number, y: number, z: number, reach: number) => number) {
    const { h, phi, solid, nx, ny, nz } = this;
    const sxy = nx * ny;
    const done = new Uint8Array(this.n);
    for (const run of runs)
      for (const c of run.cells) {
        const ci = c % nx;
        const cj = Math.floor(c / nx) % ny;
        const ck = Math.floor(c / sxy);
        for (let dk = -2; dk <= 2; dk++)
          for (let dj = -2; dj <= 2; dj++)
            for (let di = -2; di <= 2; di++) {
              const i = ci + di;
              const j = cj + dj;
              const k = ck + dk;
              if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
              const v = i + nx * (j + ny * k);
              if (done[v]) continue;
              // the cells out to where the cable lies, and the parts' skin under them
              if (solid[v] ? phi[v] < -1.6 * h : phi[v] > run.reach) continue;
              done[v] = 1;
              const d = exact(this.min[0] + (i + 0.5) * h, this.min[1] + (j + 0.5) * h, this.min[2] + (k + 0.5) * h, run.reach + 1.2 * h);
              if (Number.isFinite(d)) phi[v] = d;
            }
      }
  }

  /**
   * The free cells outside the assembly: those reached from the grid's
   * border through gaps wider than 2·reach, and every free cell within reach
   * of them. A hole smaller than that (a grommet, an access hole) closes the
   * inside of an enclosure off from the outside.
   */
  buildOutside(reach: number) {
    const { nx, ny, nz, phi } = this;
    const sxy = nx * ny;
    const far = new Uint8Array(this.n);
    const queue = new Int32Array(this.n);
    let head = 0;
    let tail = 0;
    const seed = (c: number) => {
      if (far[c] || phi[c] < reach) return;
      far[c] = 1;
      queue[tail++] = c;
    };
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) seed(i + nx * (j + ny * k));
    while (head < tail) {
      const c = queue[head++];
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const k = Math.floor(c / sxy);
      if (i > 0) seed(c - 1);
      if (i < nx - 1) seed(c + 1);
      if (j > 0) seed(c - nx);
      if (j < ny - 1) seed(c + nx);
      if (k > 0) seed(c - sxy);
      if (k < nz - 1) seed(c + sxy);
    }
    const d = edt3(far, 1, nx, ny, nz);
    const lim = (reach / this.h + 0.5) ** 2;
    const out = new Uint8Array(this.n);
    for (let c = 0; c < this.n; c++) if (!this.solid[c] && d[c] <= lim) out[c] = 1;
    this.outside = out;
    // the spaces inside, each on its own: an enclosure's compartments joined by a gap are one, two sealed boxes are two
    const region = new Int32Array(this.n);
    let next = 0;
    for (let c0 = 0; c0 < this.n; c0++) {
      if (region[c0] || this.solid[c0] || out[c0]) continue;
      region[c0] = ++next;
      head = tail = 0;
      queue[tail++] = c0;
      while (head < tail) {
        const c = queue[head++];
        const i = c % nx;
        const j = Math.floor(c / nx) % ny;
        const k = Math.floor(c / sxy);
        const visit = (v: number) => {
          if (region[v] || this.solid[v] || out[v]) return;
          region[v] = next;
          queue[tail++] = v;
        };
        if (i > 0) visit(c - 1);
        if (i < nx - 1) visit(c + 1);
        if (j > 0) visit(c - nx);
        if (j < ny - 1) visit(c + nx);
        if (k > 0) visit(c - sxy);
        if (k < nz - 1) visit(c + sxy);
      }
    }
    this.region = region;
  }

  regionAt(x: number, y: number, z: number): number {
    if (!this.region.length) return 0;
    const [i, j, k] = this.cellOf([x, y, z]);
    return this.region[this.index(i, j, k)];
  }

  outsideAt(x: number, y: number, z: number): boolean {
    if (!this.outside.length) return false;
    const [i, j, k] = this.cellOf([x, y, z]);
    return this.outside[this.index(i, j, k)] === 1;
  }

  /** The field at any point, by trilinear interpolation between cell centres (far outside the grid: a large clearance). */
  phiAt(x: number, y: number, z: number): number {
    const { nx, ny, nz, h, min, phi } = this;
    const u = (x - min[0]) / h - 0.5;
    const v = (y - min[1]) / h - 0.5;
    const w = (z - min[2]) / h - 0.5;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(u)));
    const j = Math.max(0, Math.min(ny - 2, Math.floor(v)));
    const k = Math.max(0, Math.min(nz - 2, Math.floor(w)));
    if (nx < 2 || ny < 2 || nz < 2) return phi[this.index(Math.min(nx - 1, Math.max(0, Math.round(u))), Math.min(ny - 1, Math.max(0, Math.round(v))), Math.min(nz - 1, Math.max(0, Math.round(w))))] ?? 1e3;
    const fu = Math.max(0, Math.min(1, u - i));
    const fv = Math.max(0, Math.min(1, v - j));
    const fw = Math.max(0, Math.min(1, w - k));
    const at = (a: number, b: number, c: number) => phi[i + a + nx * (j + b + ny * (k + c))];
    const c00 = at(0, 0, 0) * (1 - fu) + at(1, 0, 0) * fu;
    const c10 = at(0, 1, 0) * (1 - fu) + at(1, 1, 0) * fu;
    const c01 = at(0, 0, 1) * (1 - fu) + at(1, 0, 1) * fu;
    const c11 = at(0, 1, 1) * (1 - fu) + at(1, 1, 1) * fu;
    const val = (c00 * (1 - fv) + c10 * fv) * (1 - fw) + (c01 * (1 - fv) + c11 * fv) * fw;
    // beyond the grid the parts are further away still
    const out = Math.max(0, -u - 0.5, u - (nx - 0.5), -v - 0.5, v - (ny - 0.5), -w - 0.5, w - (nz - 0.5)) * h;
    return val + out;
  }
}

/** Squared distances (in cells) from every cell to the nearest cell whose mask value is `site`, by the separable transform of Felzenszwalb and Huttenlocher. */
function edt3(mask: Uint8Array, site: number, nx: number, ny: number, nz: number): Float32Array {
  const BIG = 1e20;
  const n = nx * ny * nz;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = mask[i] === site ? 0 : BIG;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m);
  const out = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const pass = (count: number, len: number, stride: number, start: (line: number) => number) => {
    for (let line = 0; line < count; line++) {
      const s = start(line);
      for (let q = 0; q < len; q++) f[q] = d[s + q * stride];
      edt1(f, len, out, v, z);
      for (let q = 0; q < len; q++) d[s + q * stride] = out[q];
    }
  };
  pass(ny * nz, nx, 1, (l) => l * nx);
  pass(nx * nz, ny, nx, (l) => (l % nx) + nx * ny * Math.floor(l / nx));
  pass(nx * ny, nz, nx * ny, (l) => l);
  return d;
}

function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
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

/** Exact questions about one part's mesh, for marking it finely: distance to its surface (Infinity beyond maxD) and inside or out. */
interface PartProbe {
  surface(x: number, y: number, z: number, maxD: number): number;
  inside(x: number, y: number, z: number): boolean;
}

/** Mark the cells of a grid (origin min, cell h) that a triangle of pos passes through, by sampling it finer than a cell. */
function markTriangle(cells: Uint8Array, min: V3, h: number, nx: number, ny: number, nz: number, pos: Float32Array, ia: number, ib: number, ic: number) {
  const a: V3 = [pos[3 * ia], pos[3 * ia + 1], pos[3 * ia + 2]];
  const b: V3 = [pos[3 * ib], pos[3 * ib + 1], pos[3 * ib + 2]];
  const c: V3 = [pos[3 * ic], pos[3 * ic + 1], pos[3 * ic + 2]];
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
  const s = h * 0.45;
  const n1 = Math.max(1, Math.ceil(len(p0, p1) / s));
  const n2 = Math.max(1, Math.ceil(len(p0, p2) / s));
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
      cells[ci + nx * (cj + ny * ck)] = 1;
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

/** Route every cable. Cables are routed in the order given, each one drawn to the ones before it, then all are relaxed together. */
export function routeCables(input: RouteInput, solids?: Solids): RouteResult {
  return routeWithField(input, solids).result;
}

/** routeCables, with the signed distance field it routed in (for the wiring checks that follow it in the same worker). */
export function routeWithField(input: RouteInput, solids?: Solids): { result: RouteResult; field: SignedField } {
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
  const stages: Record<string, number> = {};
  let t = Date.now();
  const lap = (name: string) => {
    const now = Date.now();
    stages[name] = now - t;
    t = now;
  };
  const sol = solids ?? new Solids(input.geos, input.placed);
  const near = new Float64Array(4);
  input.placed.forEach((pl, n) => {
    const inv = invert(pl.m);
    const bvh = inv && !pl.box ? sol.bvh(pl.geo) : null;
    grid.markPart(
      world[n],
      input.geos[pl.geo].indices,
      bvh
        ? {
            surface: (x, y, z, maxD) => {
              const q = transform(inv!, x, y, z);
              return bvh.closest(q[0], q[1], q[2], maxD, near);
            },
            inside: (x, y, z) => {
              const q = transform(inv!, x, y, z);
              return bvh.contains(q[0], q[1], q[2]);
            },
          }
        : undefined,
    );
    if (pl.box) grid.fillBox(pl.m, pl.box);
  });
  lap("grid");
  grid.buildField();
  grid.buildOutside(OUT_REACH);
  lap("field");
  for (const k of input.keepOut ?? []) grid.markKeepOut(k);
  for (const z of input.flow ?? []) grid.markFlow(z);
  if (input.flow?.length || input.keepOut?.length) lap("keep");

  const search = new Search(grid, sol);
  // wires that start together and end together are one cable: the search routes it once, as thick as all of them
  const paths = bundles(input.wires).map((cable) => {
    const w = cable.trunk;
    // a crossing point in the free space the cable's ends are in (not a sealed pocket beside the bearing)
    const reach = w.via?.length ? search.ends(w, cable.stub).map((c) => grid.freeComp()[c]) : [];
    const via = (w.via ?? []).map((v) => search.viaCell(v, w.d / 2 + CLEAR, reach));
    const found = search.find(w, via, cable.stub, cable.bend);
    grid.occupy(found.cells, w.d / 2);
    return { cable, via, cells: found.cells, stub: found.stub };
  });
  lap("search");
  // the true distance to the parts around each run: to their surfaces, or to the box a bought part fills
  const boxed = input.placed.flatMap((pl) => {
    const inv = pl.box && invert(pl.m);
    return inv ? [{ inv, lo: pl.box![0], hi: pl.box![1] }] : [];
  });
  const at: V3 = [0, 0, 0];
  grid.sharpen(
    paths.map((p) => ({ cells: p.cells, reach: p.cable.trunk.d / 2 + CLEAR + 1.1 * h })),
    (x, y, z, reach) => {
      at[0] = x;
      at[1] = y;
      at[2] = z;
      const hit = sol.nearest(at, reach);
      let d = hit ? (hit.inside ? -hit.d : hit.d) : Infinity;
      for (const b of boxed) {
        const q = transform(b.inv, x, y, z);
        const out = Math.hypot(Math.max(b.lo[0] - q[0], 0, q[0] - b.hi[0]), Math.max(b.lo[1] - q[1], 0, q[1] - b.hi[1]), Math.max(b.lo[2] - q[2], 0, q[2] - b.hi[2]));
        const db = out > 0 ? out : -Math.min(q[0] - b.lo[0], b.hi[0] - q[0], q[1] - b.lo[1], b.hi[1] - q[1], q[2] - b.lo[2], b.hi[2] - q[2]);
        if (db < d) d = db;
      }
      return d;
    },
  );
  lap("exact");
  const wires: RoutedWire[] = new Array(input.wires.length);
  for (const p of paths) {
    const { cable } = p;
    const trunk = finish(grid, cable.trunk, p.cells, p.via, p.stub, cable.bend, sol);
    if (p.via.length && !trunk.straight)
      trunk.via = p.via.map((c, i) => {
        if (c < 0) return null;
        const v = cable.trunk.via![i];
        const q = grid.center(c);
        return { p: q, r: axisDistance(q, v.at, v.axis) };
      });
    if (cable.members.length === 1) {
      wires[cable.members[0]] = trunk;
      continue;
    }
    const lines = trunk.straight ? null : strands(cable, input.wires, trunk.points, h);
    cable.members.forEach((m, k) => {
      const w = input.wires[m];
      const points = lines ? lines[k] : [w.a.p, w.b.p];
      const run: RoutedWire = { id: w.id, points, length: pathLength(points), through: trunk.through, straight: trunk.straight, r: w.d / 2 };
      if (trunk.via) run.via = cable.flip[k] ? [...trunk.via].reverse() : trunk.via;
      wires[m] = run;
    });
  }
  lap("dress");
  // push the runs out of the parts by their radius and apart from each other
  const field: SignedField = { h, phi: (x, y, z) => grid.phiAt(x, y, z), outside: (x, y, z) => grid.outsideAt(x, y, z), region: (x, y, z) => grid.regionAt(x, y, z) };
  if (input.flow?.length) field.flow = (x, y, z) => grid.flowAt(x, y, z);
  const live = wires.filter((w) => !w.straight);
  relaxCables(
    live.map((w) => ({ id: w.id, pts: w.points, r: w.r })),
    field,
    sol,
  ).forEach((pts, i) => {
    live[i].points = pts;
    live[i].length = pathLength(pts);
  });
  lap("relax");
  return { result: { wires, cell: h, ms: Date.now() - t0, stages }, field };
}

/** distance from p to the line through `at` along unit `axis` */
function axisDistance(p: V3, at: V3, axis: V3): number {
  const v: V3 = [p[0] - at[0], p[1] - at[1], p[2] - at[2]];
  const s = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  return Math.hypot(v[0] - axis[0] * s, v[1] - axis[1] * s, v[2] - axis[2] * s);
}

const pathLength = (pts: V3[]) => {
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += dist(pts[i - 1], pts[i]);
  return length;
};

class Search {
  private g: Float32Array;
  private parent: Int32Array;
  private stamp: Uint16Array;
  private closed: Uint16Array;
  private gen = 0;
  /** cells beside the straight starts of the cable being routed (those stamped with `folds`) */
  private fold: Uint16Array;
  private folds = 0;
  private heap = new Heap();

  constructor(
    private grid: Grid,
    private solids?: Solids,
  ) {
    this.g = new Float32Array(grid.n);
    this.parent = new Int32Array(grid.n);
    this.stamp = new Uint16Array(grid.n);
    this.closed = new Uint16Array(grid.n);
    this.fold = new Uint16Array(grid.n);
  }

  /**
   * Mark the cells beside a run's straight start (and a little behind its plug), out to the width of the tightest
   * bend the cable makes: a run that has to come back past its own plug goes round them.
   */
  private besideStart(e: RouteEnd, tip: number, bend: number) {
    const gr = this.grid;
    const reach = 2 * bend;
    const lo: V3 = [0, 0, 0];
    const hi: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const a = e.p[k] - e.dir[k] * bend;
      const b = e.p[k] + e.dir[k] * tip;
      lo[k] = Math.min(a, b) - reach;
      hi[k] = Math.max(a, b) + reach;
    }
    const [i0, j0, k0] = gr.cellOf(lo);
    const [i1, j1, k1] = gr.cellOf(hi);
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const c = gr.index(i, j, k);
          const q = gr.center(c);
          const v: V3 = [q[0] - e.p[0], q[1] - e.p[1], q[2] - e.p[2]];
          const along = v[0] * e.dir[0] + v[1] * e.dir[1] + v[2] * e.dir[2];
          if (along < -bend || along > tip - 0.5 * gr.h) continue;
          const off = Math.hypot(v[0] - e.dir[0] * along, v[1] - e.dir[1] * along, v[2] - e.dir[2] * along);
          if (off > 0.75 * gr.h && off <= reach) this.fold[c] = this.folds;
        }
  }

  /**
   * The cells from a plug's end out to free space, and how many of them are the straight start of the run. Just the
   * nearest free cell when there is one close by (looking along the plug's direction first, and never one that is
   * only free because it is on the far side of a wall or a board), or the shortest way out when the end is deep
   * inside a part's filled box (a speaker's tabs under its basket). From a free cell on the
   * plug's own line the run carries straight on for `stub` mm, as far as there is room for the cable: a lead leaves
   * its plug straight before it bends.
   */
  private entry(e: RouteEnd, d = 0, stub = 0): { cells: number[]; stub: number } {
    const gr = this.grid;
    for (let s = 0; s <= 8; s++) {
      const q = add(e.p, e.dir, s * gr.h * 0.75);
      const [i, j, k] = gr.cellOf(q);
      const idx = gr.index(i, j, k);
      if (gr.solid[idx]) continue;
      // free, but on the far side of a wall or a board: the lead does not go through it
      if (s > 0 && !this.sees(e.p, q)) break;
      const cells = [idx];
      // straight on along the plug's line while the cable fits
      const need = d / 2 + CLEAR;
      const from = s * gr.h * 0.75;
      for (let t = gr.h * 0.5; t <= stub + 1e-6; t += gr.h * 0.5) {
        const [a, b, c] = gr.cellOf(add(e.p, e.dir, from + t));
        const v = gr.index(a, b, c);
        if (v === cells[cells.length - 1]) continue;
        if (gr.solid[v] || gr.flow[v] || gr.phi[v] < Math.min(need, gr.phi[cells[cells.length - 1]])) break;
        // the next cell along the line shares a face with the last one, or the search could not walk it
        const last = cells[cells.length - 1];
        const step = Math.abs(v - last);
        if (step !== 1 && step !== gr.nx && step !== gr.nx * gr.ny) {
          const mid = this.between(last, v);
          if (mid < 0) break;
          cells.push(mid);
        }
        cells.push(v);
      }
      return { cells, stub: cells.length - 1 };
    }
    // the nearest free cell the lead can reach in a straight line: a plug in the narrow gap behind a board, or inside
    // a bought part's filled box, leaves by the open side, not through the board to the free space behind it
    const [i0, j0, k0] = gr.cellOf(e.p);
    let blind = -1;
    for (let r = 1; r <= 6; r++) {
      let seen = -1;
      let seenD = Infinity;
      for (let dk = -r; dk <= r; dk++)
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
            const i = i0 + di;
            const j = j0 + dj;
            const k = k0 + dk;
            if (i < 0 || j < 0 || k < 0 || i >= gr.nx || j >= gr.ny || k >= gr.nz) continue;
            const idx = gr.index(i, j, k);
            if (gr.solid[idx]) continue;
            if (!this.solids) return { cells: [idx], stub: 0 };
            if (blind < 0) blind = idx;
            const c = gr.center(idx);
            const dd = dist(c, e.p);
            if (dd < seenD && this.sees(e.p, c)) {
              seen = idx;
              seenD = dd;
            }
          }
      if (seen >= 0) return { cells: [seen], stub: 0 };
    }
    if (blind >= 0) return { cells: [blind], stub: 0 };
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
            return { cells: out.reverse(), stub: 0 };
          }
          next.push(v);
        }
      }
      queue = next;
    }
    return { cells: [from], stub: 0 };
  }

  /** Whether the straight line from p to q meets no part: their drawn solids, exactly (true when there are none to ask). */
  private sees(p: V3, q: V3): boolean {
    const sol = this.solids;
    if (!sol) return true;
    const v: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-6) return true;
    return !sol.raycast(p, [v[0] / len, v[1] / len, v[2] / len], len);
  }

  /** A free cell that shares a face with both of two cells that touch only at an edge or a corner (-1: none). */
  private between(a: number, b: number): number {
    const gr = this.grid;
    const { nx, ny } = gr;
    const sxy = nx * ny;
    const ai = a % nx;
    const aj = Math.floor(a / nx) % ny;
    const ak = Math.floor(a / sxy);
    const bi = b % nx;
    const bj = Math.floor(b / nx) % ny;
    const bk = Math.floor(b / sxy);
    if (Math.abs(ai - bi) + Math.abs(aj - bj) + Math.abs(ak - bk) !== 2) return -1;
    for (const c of [gr.index(bi, aj, ak), gr.index(ai, bj, ak), gr.index(ai, aj, bk)]) {
      if (c === a || c === b || gr.solid[c]) continue;
      const ci = c % nx;
      const cj = Math.floor(c / nx) % ny;
      const ck = Math.floor(c / sxy);
      if (Math.abs(ci - ai) + Math.abs(cj - aj) + Math.abs(ck - ak) === 1 && Math.abs(ci - bi) + Math.abs(cj - bj) + Math.abs(ck - bk) === 1) return c;
    }
    return -1;
  }

  /**
   * The free cell to cross a pivot at: within reach of the crossing point, with room for the cable, as close to the
   * axis as it can be (the nearer the axis, the less the cable stretches as the joint turns), and not far along it.
   * -1 when there is none.
   */
  viaCell(v: RouteVia, need: number, comps: number[] = []): number {
    const gr = this.grid;
    const reach = Math.ceil(VIA_REACH / gr.h);
    const comp = comps.length ? gr.freeComp() : null;
    const [ci, cj, ck] = gr.cellOf(v.c);
    let best = -1;
    let bestCost = Infinity;
    for (let dk = -reach; dk <= reach; dk++)
      for (let dj = -reach; dj <= reach; dj++)
        for (let di = -reach; di <= reach; di++) {
          const i = ci + di;
          const j = cj + dj;
          const k = ck + dk;
          if (i < 0 || j < 0 || k < 0 || i >= gr.nx || j >= gr.ny || k >= gr.nz) continue;
          const idx = gr.index(i, j, k);
          if (gr.solid[idx] || gr.phi[idx] < need || gr.flow[idx] || (comp && !comps.includes(comp[idx]))) continue;
          const p = gr.center(idx);
          const along = Math.abs((p[0] - v.c[0]) * v.axis[0] + (p[1] - v.c[1]) * v.axis[1] + (p[2] - v.c[2]) * v.axis[2]);
          if (along > VIA_REACH / 2) continue;
          // a cell a cable already crosses in is taken: the next one crosses beside it
          const cost = (v.here ? Math.hypot(p[0] - v.c[0], p[1] - v.c[1], p[2] - v.c[2]) : axisDistance(p, v.at, v.axis) + 0.5 * along) + gr.use[idx] * gr.h * 1.5;
          if (cost < bestCost) {
            bestCost = cost;
            best = idx;
          }
        }
    return best;
  }

  /** The free cells a cable's run starts and ends in. */
  ends(w: RouteWire, stub: [number, number] = [0, 0]): number[] {
    const a = this.entry(w.a, w.d, stub[0]).cells;
    const b = this.entry(w.b, w.d, stub[1]).cells;
    return [a[a.length - 1], b[b.length - 1]];
  }

  /**
   * The cells from end a to end b of a cable, through its via cells in order (empty when no way was found), and how
   * many cells at each end are its straight start out of the plug (of `stub` mm at most). A via of -1 had no room:
   * the legs either side of it join, keeping out of what both of them keep out of.
   */
  find(w: RouteWire, via: number[] = [], stub: [number, number] = [0, 0], bend = 0): { cells: number[]; stub: [number, number] } {
    const gr = this.grid;
    const ea = this.entry(w.a, w.d, stub[0]);
    const eb = this.entry(w.b, w.d, stub[1]);
    const leadA = ea.cells;
    const leadB = eb.cells;
    const start = leadA[leadA.length - 1];
    const goal = leadB[leadB.length - 1];
    if (++this.folds === 65535) {
      this.folds = 1;
      this.fold.fill(0);
    }
    if (bend > 0) {
      const tip = (e: RouteEnd, c: number) => {
        const q = gr.center(c);
        return (q[0] - e.p[0]) * e.dir[0] + (q[1] - e.p[1]) * e.dir[1] + (q[2] - e.p[2]) * e.dir[2];
      };
      if (ea.stub > 0) this.besideStart(w.a, tip(w.a, start), bend);
      if (eb.stub > 0) this.besideStart(w.b, tip(w.b, goal), bend);
    }
    const join = (core: number[]) => [...leadA.slice(0, -1), ...core, ...leadB.slice(0, -1).reverse()];
    // a cable from inside the assembly to inside it stays inside
    const outer = gr.outside;
    const outCost = outer.length && gr.region[start] && gr.region[start] === gr.region[goal] ? COST_OUT : 0;
    const avoidOf = (i: number) => w.legAvoid?.[i] ?? w.avoid ?? 0;
    const stops: { cell: number; avoid: number }[] = [];
    let avoid = avoidOf(0);
    via.forEach((c, i) => {
      if (c < 0) {
        avoid &= avoidOf(i + 1);
        return;
      }
      stops.push({ cell: c, avoid });
      avoid = avoidOf(i + 1);
    });
    stops.push({ cell: goal, avoid });
    const core: number[] = [start];
    let from = start;
    // the straight starts are not walked again: a run that has to turn back does it beside its start, with a real bend
    const shut = [...leadA.slice(0, -1), ...leadB.slice(0, -1)];
    for (const st of stops) {
      const leg = this.leg(from, st.cell, w.d, st.avoid, outCost, shut);
      if (!leg) return { cells: [], stub: [0, 0] };
      core.push(...leg.slice(1));
      from = st.cell;
    }
    return { cells: join(core), stub: [ea.stub, eb.stub] };
  }

  /** A* from one cell to another for a cable of diameter d, keeping out of the keep-out groups in `avoid`. */
  private leg(start: number, goal: number, d: number, avoid: number, outCost: number, shut: number[] = []): number[] | null {
    if (start === goal) return [start];
    const gr = this.grid;
    const { nx, ny, nz } = gr;
    const sxy = nx * ny;
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
      return (Math.abs(i - gi) + Math.abs(j - gj) + Math.abs(k - gk)) * AIM;
    };
    heap.clear();
    for (const c of shut) if (c !== start && c !== goal) closed[c] = gen;
    g[start] = 0;
    parent[start] = -1;
    stamp[start] = gen;
    heap.push(hcost(start), start);
    const steps = [1, -1, nx, -nx, sxy, -sxy];
    // the room this cable needs from a part, and the band along a surface it is happy to run in
    const need = d / 2 + CLEAR;
    const hugTo = need + gr.h;
    // the field reads up to a cell short next to a part, so a cell under this is surely within a tie's reach
    const nearTo = Math.max(hugTo, d / 2 + TIE_REACH - gr.h);
    const phi = gr.phi;
    const outer = gr.outside;
    const flow = gr.flow;
    const fold = this.fold;
    const folds = this.folds;
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
        const dd = steps[s];
        if ((s === 0 && ui === nx - 1) || (s === 1 && ui === 0) || (s === 2 && uj === ny - 1) || (s === 3 && uj === 0) || (s === 4 && uk === nz - 1) || (s === 5 && uk === 0)) continue;
        const v = u + dd;
        if (closed[v] === gen) continue;
        const room = phi[v];
        let c = gr.solid[v] ? COST_SOLID : room < need ? COST_TIGHT : room < hugTo ? COST_HUG : room < nearTo ? COST_NEAR : COST_FREE;
        if (gr.use[v]) c += COST_SHARE;
        else if (gr.side[v] && room < hugTo) c *= BUNDLE;
        if (outCost && outer[v]) c += outCost;
        if (avoid && gr.keep[v] & avoid) c += COST_KEEP;
        if (flow[v]) c += COST_FLOW;
        if (fold[v] === folds) c += COST_FOLD;
        if (inDir && dd !== inDir) c += TURN;
        const ng = g[u] + c;
        if (stamp[v] !== gen || ng < g[v]) {
          stamp[v] = gen;
          g[v] = ng;
          parent[v] = u;
          heap.push(ng + hcost(v), v);
        }
      }
    }
    if (!found) return null;
    const out: number[] = [];
    for (let c = goal; c >= 0; c = parent[c]) out.push(c);
    return out.reverse();
  }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Wires routed as one cable (one wire on its own is a cable of one). */
interface Cable {
  /** the wires, as indices into the list routed; the others' ends are measured from the first one's */
  members: number[];
  /** members that run the other way: their a end is at the cable's b end */
  flip: boolean[];
  /** where each member lies across the cable, mm from its centre line */
  slots: [number, number][];
  /** the cable as the search routes it: one run between the middles of its wires' ends, as thick as all of them */
  trunk: RouteWire;
  /** how far the run carries straight on out of each end before it may bend, mm */
  stub: [number, number];
  /** how far from each end the wires have gathered into the cable, mm */
  fan: [number, number];
  /** the least radius the run bends to, mm */
  bend: number;
}

/**
 * Gather the wires into cables. Wires whose ends are close together at both ends (and leave the same way, cross the
 * same pivots and keep out of the same sweeps) are the conductors of one cable, whatever they are: a servo's lead, a
 * motor's three phases, the four wires of a sensor. The rest are cables of one.
 */
function bundles(wires: RouteWire[]): Cable[] {
  const bendOf = (d: number) => Math.max(BEND_MIN, BEND * d);
  const way = (w: RouteWire, flipped: boolean) => {
    const via = (w.via ?? []).map((v) => [...v.at, ...v.axis, ...(v.here ? v.c : [])].map((x) => Math.round(x * 10)).join(","));
    const legs = [...(w.legAvoid ?? [])];
    if (flipped) {
      via.reverse();
      legs.reverse();
    }
    return `${via.join("|")}#${legs.join(",")}#${w.avoid ?? 0}`;
  };
  const out: Cable[] = [];
  const taken = new Uint8Array(wires.length);
  wires.forEach((ref, i) => {
    if (taken[i]) return;
    taken[i] = 1;
    const members = [i];
    const flip = [false];
    // short wires only pair up with ones right beside them
    const span = Math.min(SPAN, 0.35 * dist(ref.a.p, ref.b.p));
    // a row of plugs chains: a wire joins when it is beside one already in the cable at both ends (a motor's three
    // leads are a row, and the outer two of a short run are further apart than a wire that short pairs up over),
    // as long as it is no further from the first than two wires ever gather over
    for (let grew = true; grew; ) {
      grew = false;
      for (let j = i + 1; j < wires.length; j++) {
        if (taken[j]) continue;
        const w = wires[j];
        let same = Infinity;
        let swap = Infinity;
        members.forEach((m, k) => {
          const [ma, mb] = flip[k] ? [wires[m].b, wires[m].a] : [wires[m].a, wires[m].b];
          same = Math.min(same, Math.max(dist(w.a.p, ma.p), dist(w.b.p, mb.p)));
          swap = Math.min(swap, Math.max(dist(w.a.p, mb.p), dist(w.b.p, ma.p)));
        });
        const flipped = swap < same;
        if (Math.min(same, swap) > span) continue;
        const [wa, wb] = flipped ? [w.b, w.a] : [w.a, w.b];
        if (Math.max(dist(wa.p, ref.a.p), dist(wb.p, ref.b.p)) > SPAN) continue;
        if (dot(wa.dir, ref.a.dir) < 0.3 || dot(wb.dir, ref.b.dir) < 0.3) continue;
        if (way(w, flipped) !== way(ref, false)) continue;
        members.push(j);
        flip.push(flipped);
        taken[j] = 1;
        grew = true;
      }
    }
    if (members.length === 1) {
      const bend = bendOf(ref.d);
      out.push({ members, flip, slots: [[0, 0]], trunk: ref, stub: [bend, bend], fan: [0, 0], bend });
      return;
    }
    const ends = members.map((m, k) => (flip[k] ? [wires[m].b, wires[m].a] : [wires[m].a, wires[m].b]));
    const middle = (e: 0 | 1): RouteEnd => {
      const p: V3 = [0, 0, 0];
      const dir: V3 = [0, 0, 0];
      for (const x of ends)
        for (let k = 0; k < 3; k++) {
          p[k] += x[e].p[k] / ends.length;
          dir[k] += x[e].dir[k];
        }
      return { p, dir: unit(dir) };
    };
    const a = middle(0);
    const b = middle(1);
    const lay = pack(members.map((m) => wires[m].d / 2));
    const bend = Math.max(bendOf(Math.max(...members.map((m) => wires[m].d))), 3 * lay.r);
    // the wires come together over a length that suits how far apart their plugs are
    const fan = (e: 0 | 1, c: V3) => Math.max(bend, 1.5 * Math.max(...ends.map((x) => dist(x[e].p, c))));
    const gather: [number, number] = [fan(0, a.p), fan(1, b.p)];
    out.push({ members, flip, slots: lay.at, trunk: { id: ref.id, a, b, d: 2 * lay.r, avoid: ref.avoid, via: ref.via, legAvoid: ref.legAvoid }, stub: gather, fan: gather, bend });
  });
  return out;
}

/**
 * Lay round wires of the given radii side by side as a compact cable: the thickest in the middle, each next one in
 * the hollow between two already laid that is nearest the middle. Each wire's centre, and the radius of the circle
 * round them all.
 */
function pack(radii: number[]): { at: [number, number][]; r: number } {
  const order = radii.map((_, i) => i).sort((a, b) => radii[b] - radii[a]);
  const laid: { x: number; y: number; r: number; i: number }[] = [];
  for (const i of order) {
    const r = radii[i] + LAY / 2;
    if (!laid.length) {
      laid.push({ x: 0, y: 0, r, i });
      continue;
    }
    const cx = laid.reduce((t, c) => t + c.x, 0) / laid.length;
    const cy = laid.reduce((t, c) => t + c.y, 0) / laid.length;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let a = 0; a < laid.length; a++)
      for (let b = a + 1; b < laid.length; b++) {
        const A = laid[a];
        const B = laid[b];
        const da = A.r + r;
        const db = B.r + r;
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const l = Math.hypot(dx, dy);
        if (l < 1e-9 || l > da + db) continue;
        const t = (da * da - db * db + l * l) / (2 * l);
        const hh = da * da - t * t;
        if (hh < 0) continue;
        const up = Math.sqrt(hh);
        for (const side of [1, -1]) {
          const x = A.x + (dx * t - side * dy * up) / l;
          const y = A.y + (dy * t + side * dx * up) / l;
          if (laid.some((c) => Math.hypot(c.x - x, c.y - y) < c.r + r - 1e-6)) continue;
          const d = Math.hypot(x - cx, y - cy);
          if (d < bestD - 1e-9) {
            bestD = d;
            best = { x, y };
          }
        }
      }
    // the second wire, or one no hollow takes: beside the last
    const last = laid[laid.length - 1];
    laid.push({ ...(best ?? { x: last.x + last.r + r, y: last.y }), r, i });
  }
  const cx = laid.reduce((t, c) => t + c.x, 0) / laid.length;
  const cy = laid.reduce((t, c) => t + c.y, 0) / laid.length;
  const at: [number, number][] = radii.map(() => [0, 0]);
  let r = 0;
  for (const c of laid) {
    at[c.i] = [c.x - cx, c.y - cy];
    r = Math.max(r, Math.hypot(c.x - cx, c.y - cy) + c.r);
  }
  return { at, r };
}

/** Points along a run no more than `step` apart, every one of its own points among them. */
function densify(pts: V3[], step: number): V3[] {
  const out: V3[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, a[2] + ((b[2] - a[2]) * k) / n]);
  }
  return out;
}

/**
 * The centre lines of a cable's wires. Each leaves its own plug, gathers into its place in the cable, runs beside the
 * others along the cable's dressed run, and fans out to its own plug at the far end. The places are carried along
 * the run without twisting, and turned at the start whichever way lines the wires up best with their plugs at both
 * ends (wires of one size trade places for the same reason), so they fan out with as little crossing as there can be.
 */
function strands(cable: Cable, wires: RouteWire[], trunk: V3[], h: number): V3[][] {
  const count = cable.members.length;
  const ends = cable.members.map((m, k) => (cable.flip[k] ? [wires[m].b.p, wires[m].a.p] : [wires[m].a.p, wires[m].b.p]));
  const whole = (k: number, pts: V3[]) => (cable.flip[k] ? pts.reverse() : pts);
  const line = densify(trunk, Math.max(0.7, h * 0.4));
  const n = line.length;
  const at = [0];
  for (let i = 1; i < n; i++) at.push(at[i - 1] + dist(line[i - 1], line[i]));
  const length = at[n - 1];
  if (n < 4 || length < 2) return ends.map((e, k) => whole(k, [e[0], e[1]]));
  let [fa, fb] = cable.fan;
  if (fa + fb > 0.8 * length) {
    const k = (0.8 * length) / (fa + fb);
    fa *= k;
    fb *= k;
  }
  let i0 = 0;
  while (i0 < n - 1 && at[i0] < fa) i0++;
  let i1 = n - 1;
  while (i1 > i0 && at[i1] > length - fb) i1--;
  // the way the run goes at each point, and a frame carried along it without twisting
  const T = line.map((_, i) => unit(sub(line[Math.min(n - 1, i + 1)], line[Math.max(0, i - 1)])));
  const N: V3[] = [];
  const B: V3[] = [];
  let up: V3 = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  for (let i = 0; i < n; i++) {
    const flat = sub(up, [T[i][0] * dot(up, T[i]), T[i][1] * dot(up, T[i]), T[i][2] * dot(up, T[i])]);
    if (Math.hypot(flat[0], flat[1], flat[2]) > 1e-6) up = unit(flat);
    N.push(up);
    B.push(cross(T[i], up));
  }
  // each wire's plug at both ends, seen across the run where the wires have gathered
  const across = (i: number, p: V3): [number, number] => {
    const q = sub(p, line[i]);
    return [dot(q, N[i]), dot(q, B[i])];
  };
  const qa = ends.map((e) => across(i0, e[0]));
  const qb = ends.map((e) => across(i1, e[1]));
  const radii = cable.members.map((m) => wires[m].d / 2);
  let best: [number, number][] = cable.slots;
  let bestCost = Infinity;
  for (let hand = 0; hand < 2; hand++)
    for (let turn = 0; turn < 24; turn++) {
      const c = Math.cos((turn * Math.PI) / 12);
      const s = Math.sin((turn * Math.PI) / 12);
      const place = cable.slots.map(([x, y]): [number, number] => {
        const yy = hand ? -y : y;
        return [x * c - yy * s, x * s + yy * c];
      });
      const pairs: { k: number; j: number; d: number }[] = [];
      for (let k = 0; k < count; k++)
        for (let j = 0; j < count; j++) {
          if (Math.abs(radii[k] - radii[j]) > 1e-6) continue;
          const d = (qa[k][0] - place[j][0]) ** 2 + (qa[k][1] - place[j][1]) ** 2 + (qb[k][0] - place[j][0]) ** 2 + (qb[k][1] - place[j][1]) ** 2;
          pairs.push({ k, j, d });
        }
      pairs.sort((x, y) => x.d - y.d);
      const slot = new Array<number>(count).fill(-1);
      const used = new Uint8Array(count);
      let cost = 0;
      for (const pr of pairs) {
        if (slot[pr.k] >= 0 || used[pr.j]) continue;
        slot[pr.k] = pr.j;
        used[pr.j] = 1;
        cost += pr.d;
      }
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = slot.map((j) => place[j]);
      }
    }
  return cable.members.map((_, k) => {
    const [x, y] = best[k];
    const pts: V3[] = [ends[k][0]];
    let last: V3 | null = null;
    for (let i = i0; i <= i1; i++) {
      const p: V3 = [line[i][0] + N[i][0] * x + B[i][0] * y, line[i][1] + N[i][1] * x + B[i][1] * y, line[i][2] + N[i][2] * x + B[i][2] * y];
      // on the inside of a tight bend a wire's place runs backwards: those points are left out, and the wire cuts the corner
      if (last && dot(sub(p, last), T[i]) <= 0) continue;
      pts.push(p);
      last = p;
    }
    pts.push(ends[k][1]);
    return whole(k, pts);
  });
}

/**
 * Dress the path the search found for a cable and measure the result: straight out of each plug as far as the
 * search carried it, pulled taut between there, the pivot crossings and the far end (see dress), and its corners
 * rounded to the radius the cable bends to.
 */
function finish(grid: Grid, w: RouteWire, cells: number[], via: number[], stub: [number, number], bend: number, sol?: Solids): RoutedWire {
  if (!cells.length) {
    const points = [w.a.p, w.b.p];
    return { id: w.id, points, length: dist(w.a.p, w.b.p), through: 0, straight: true, r: w.d / 2 };
  }
  const through = cells.filter((c) => grid.solid[c]).length;
  const run: V3[] = [w.a.p, ...cells.map((c) => grid.center(c)), w.b.p];
  const n = run.length;
  // the legs between the pivot crossings, each with the keep-out groups it stayed out of
  const avoidOf = (i: number) => w.legAvoid?.[i] ?? w.avoid ?? 0;
  const legs: { from: number; to: number; avoid: number }[] = [];
  let avoid = avoidOf(0);
  let from = 0;
  via.forEach((c, i) => {
    if (c < 0) {
      avoid &= avoidOf(i + 1);
      return;
    }
    const at = cells.indexOf(c, Math.max(0, from - 1)) + 1;
    if (at > from) {
      legs.push({ from, to: at, avoid });
      from = at;
    }
    avoid = avoidOf(i + 1);
  });
  legs.push({ from, to: n - 1, avoid });
  // where the straight start out of each plug ends: on the plug's own line, and the run is dressed from there
  const onLine = (e: RouteEnd, p: V3) => add(e.p, e.dir, Math.max(0, dot(sub(p, e.p), e.dir)));
  const pinA = stub[0] > 0 ? 1 + stub[0] : 0;
  const pinB = stub[1] > 0 && n - 2 - stub[1] > pinA ? n - 2 - stub[1] : n - 1;
  if (pinA > 0) run[pinA] = onLine(w.a, run[pinA]);
  if (pinB < n - 1) run[pinB] = onLine(w.b, run[pinB]);
  const pins = [pinA, pinB].filter((x) => x > 0 && x < n - 1);
  // the cells' centres stand up to a cell off the parts the run follows: lay it down on them
  const held = new Set<number>(legs.flatMap((l) => [l.from, l.to]));
  for (let i = pinA + 1; i < pinB; i++) if (!held.has(i)) run[i] = settle(grid, run[i], w.d / 2 + CLEAR);
  // a cable from inside the assembly to inside it stays inside
  const first = cells[0];
  const last = cells[cells.length - 1];
  const inside = grid.outside.length > 0 && grid.region[first] > 0 && grid.region[first] === grid.region[last];
  let pts: V3[] = [];
  for (const leg of legs) {
    const cuts = [leg.from, ...pins.filter((x) => x > leg.from && x < leg.to), leg.to];
    for (let k = 0; k + 1 < cuts.length; k++) {
      let piece = run.slice(cuts[k], cuts[k + 1] + 1);
      // drop a cell centre that doubles back past the exact end point
      if (cuts[k] === 0) piece = trimStart(piece);
      if (cuts[k + 1] === n - 1) piece = trimStart(piece.reverse()).reverse();
      const taut = dress(grid, piece, w.d, leg.avoid, inside, sol);
      pts = pts.length ? [...pts, ...taut.slice(1)] : taut;
    }
  }
  pts = fillet(pts, bend, Math.max(0.6, grid.h * 0.3));
  return { id: w.id, points: pts, length: pathLength(pts), through, straight: false, r: w.d / 2 };
}

/**
 * Round every corner of a dressed run to the radius a cable of its size bends to, or as near to it as the straights
 * either side leave room for: half of each, and nearly all of a run's first and last straight (the start out of a
 * plug is there to be bent from).
 */
function fillet(pts: V3[], radius: number, step: number): V3[] {
  const n = pts.length;
  if (n < 3) return pts;
  const out: V3[] = [pts[0]];
  for (let i = 1; i < n - 1; i++) {
    const b = pts[i];
    const u = sub(b, pts[i - 1]);
    const v = sub(pts[i + 1], b);
    const lu = Math.hypot(u[0], u[1], u[2]);
    const lv = Math.hypot(v[0], v[1], v[2]);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const cos = Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)));
    const turn = Math.acos(cos);
    // as good as straight, or doubled back on itself: left as it is
    if (turn < 0.05 || turn > 3) {
      out.push(b);
      continue;
    }
    const tan = Math.tan(turn / 2);
    const t = Math.min(radius * tan, lu * (i === 1 ? 0.95 : 0.5), lv * (i === n - 2 ? 0.95 : 0.5));
    const r = t / tan;
    if (t < 0.2 || !(r > 0.2)) {
      out.push(b);
      continue;
    }
    const un: V3 = [u[0] / lu, u[1] / lu, u[2] / lu];
    const vn: V3 = [v[0] / lv, v[1] / lv, v[2] / lv];
    // into the bend, square to the way in
    const inward = unit(sub(vn, [un[0] * cos, un[1] * cos, un[2] * cos]));
    const p1 = add(b, un, -t);
    const c = add(p1, inward, r);
    const steps = Math.max(2, Math.ceil((r * turn) / step));
    for (let s = 0; s <= steps; s++) {
      const a = (turn * s) / steps;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      out.push([c[0] + r * (un[0] * sa - inward[0] * ca), c[1] + r * (un[1] * sa - inward[1] * ca), c[2] + r * (un[2] * sa - inward[2] * ca)]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

/**
 * A point of a run that follows a part, moved down onto it: to where the cable just has its room, when it is no more
 * than a cell and a half further off than that (a point further off is crossing open space, and stays).
 */
function settle(grid: Grid, p: V3, need: number): V3 {
  const h = grid.h;
  const e = 0.3 * h;
  let q = p;
  for (let pass = 0; pass < 3; pass++) {
    const f = grid.phiAt(q[0], q[1], q[2]);
    const off = f - need;
    if (off <= 0.02 || f > need + 1.5 * h) break;
    const g: V3 = [grid.phiAt(q[0] + e, q[1], q[2]) - grid.phiAt(q[0] - e, q[1], q[2]), grid.phiAt(q[0], q[1] + e, q[2]) - grid.phiAt(q[0], q[1] - e, q[2]), grid.phiAt(q[0], q[1], q[2] + e) - grid.phiAt(q[0], q[1], q[2] - e)];
    const l = Math.hypot(g[0], g[1], g[2]);
    if (l < 1e-6) break;
    const to: V3 = [q[0] - (g[0] / l) * off, q[1] - (g[1] / l) * off, q[2] - (g[2] / l) * off];
    // never into the airflow, or out of the corridor the search cleared
    if (grid.flowAt(to[0], to[1], to[2]) || dist(to, p) > 1.6 * h) break;
    q = to;
  }
  return q !== p && grid.phiAt(q[0], q[1], q[2]) < need - 0.1 ? p : q;
}

/** distance from p to the segment a-b */
function segmentDistance(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
}

/**
 * Dress a cell path as a cable is dressed. The search leaves a staircase of cell centres; a real cable pulled snug
 * is straight between the places it bends. Each stretch is replaced by a straight run as long as that run stays
 * within a cell or so of the path (so the path's corners stay, square to the parts it runs along, and only its
 * cell-sized steps go), keeps the cable's room from every part, stays out of the airflow and the moving parts' sweeps
 * the path stayed out of, and lifts no further off the parts than a tie reaches. Where the path itself has less than
 * the cable's room (leaving a plug in a tight place), a straight run must also miss every part's own solid.
 */
function dress(grid: Grid, pts: V3[], d: number, avoid: number, inside: boolean, sol?: Solids): V3[] {
  const n = pts.length;
  if (n < 3) return pts;
  const h = grid.h;
  const need = d / 2 + CLEAR;
  const phi = new Float64Array(n);
  const flags = new Uint8Array(n);
  const FLOW = 1;
  const KEEP = 2;
  const OUT = 4;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = pts[i];
    phi[i] = grid.phiAt(x, y, z);
    let f = 0;
    if (grid.flowAt(x, y, z)) f |= FLOW;
    if (avoid && grid.keepAt(x, y, z) & avoid) f |= KEEP;
    if (inside && grid.outsideAt(x, y, z)) f |= OUT;
    flags[i] = f;
  }
  // the airflow is marked by the cell: a straight run keeps most of a cell clear of it
  const e = 0.6 * h;
  const nearFlow = (x: number, y: number, z: number) =>
    grid.flowAt(x, y, z) || grid.flowAt(x + e, y, z) || grid.flowAt(x - e, y, z) || grid.flowAt(x, y + e, z) || grid.flowAt(x, y - e, z) || grid.flowAt(x, y, z + e) || grid.flowAt(x, y, z - e);
  const stray = STRAY * h;
  const ok = (i: number, j: number): boolean => {
    if (j - i < 2) return true;
    const a = pts[i];
    const b = pts[j];
    let lo = Infinity;
    let hi = -Infinity;
    let any = 0;
    for (let k = i; k <= j; k++) {
      if (phi[k] < lo) lo = phi[k];
      if (phi[k] > hi) hi = phi[k];
      any |= flags[k];
      if (k > i && k < j && segmentDistance(pts[k], a, b) > stray) return false;
    }
    const floor = Math.min(need, lo) - 0.05;
    // a stretch that starts in a tight place (a socket behind a board, a plug inside a bought part's filled box) has
    // no room to measure by: there the straight run is tested against the parts' own solids, so it never cuts a
    // corner through the board beside it
    if (sol && lo < need) {
      const len = dist(a, b);
      if (len > 1e-6 && sol.raycast(a, [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len], len)) return false;
    }
    // bridging a hollow or cutting a corner, the run stays within reach of a tie (or as far out as the path itself went)
    const ceil = Math.max(d / 2 + TIE_REACH - 0.5, hi);
    const steps = Math.max(2, Math.ceil(dist(a, b) / (h * 0.5)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      const f = grid.phiAt(x, y, z);
      if (f < floor || f > ceil) return false;
      if (!(any & FLOW) && nearFlow(x, y, z)) return false;
      if (avoid && !(any & KEEP) && grid.keepAt(x, y, z) & avoid) return false;
      if (inside && !(any & OUT) && grid.outsideAt(x, y, z)) return false;
    }
    return true;
  };
  const out: V3[] = [pts[0]];
  let i = 0;
  while (i < n - 1) {
    // the furthest point a straight run reaches: double the stride while it holds, then close in
    let good = i + 1;
    let stride = 2;
    while (i + stride <= n - 1 && ok(i, i + stride)) {
      good = i + stride;
      stride *= 2;
    }
    let bad = Math.min(n - 1, i + stride);
    if (bad > good && ok(i, bad)) good = bad;
    else
      while (bad - good > 1) {
        const mid = (good + bad) >> 1;
        if (ok(i, mid)) good = mid;
        else bad = mid;
      }
    out.push(pts[good]);
    i = good;
  }
  return out;
}

/** Skip the first cell centre when the exact end lies beyond it along the path. */
function trimStart(pts: V3[]): V3[] {
  if (pts.length < 4) return pts;
  const a = pts[0];
  const b = pts[1];
  const c = pts[2];
  const back = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) + (b[2] - a[2]) * (c[2] - b[2]) < 0;
  return back ? [a, ...pts.slice(2)] : pts;
}
