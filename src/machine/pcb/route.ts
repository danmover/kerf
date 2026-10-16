// Grid router for two-layer through-hole boards.
//
// Tracks run between points of a square grid (rules.grid apart) on both
// layers, in eight directions, and change layer through vias. Each net is
// split into a minimum spanning tree of pad-to-pad connections, routed short
// ones first with A*; a connection may end on any copper its net already has,
// so nets grow as Steiner trees rather than strings of pad-to-pad runs.
// Top tracks prefer to run left-right and bottom tracks up-down, which keeps
// the two layers from fencing each other in.
//
// Clearance is decided per grid point: a point is open to a net when every
// other net's copper is far enough from it for a track of that net, with a
// small margin so that the straight run between two open neighbours is clear
// too (the worst case is a corner exactly between them). Each kind of thing
// placed (each track width, and vias) gets its own map of blocked points.
// Instead of a list of nets per point, a map keeps the count, sum and sum of
// squares of the net ids covering it: the point is open to net n exactly
// when all of them are n (count·n = sum and count·n² = sum of squares).
//
// When a connection finds no way through, it is routed again allowed to cross
// other nets' tracks at a price that grows each time a spot is fought over
// (negotiated congestion, as in PathFinder); the tracks it crosses are ripped
// up and their connections queued again, until everything routes or time is
// up. The copper pours and the final rule check run on exact geometry after.

import { boardRules, placedHoles, placedPads, type PlacedPad } from "./board";
import { Buckets, capsule, circle, edgeDist, grow, padShape, shapeBox, shapeDist, um, type BBox, type Pt, type Shape } from "./geom";
import { boardDrc, connectivity } from "./drc";
import { makePours } from "./pour";
import type { BoardRules, BoardSpec, RoutedBoard, Track, Via } from "./types";

export const now = () => globalThis.performance?.now?.() ?? Date.now();

const FREE = -2;
const BLOCKED = -1;
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

// Costs in grid steps. A step against the layer's direction costs more, as do
// diagonals (a little), turns and vias; sharp turns cost a lot and U-turns are
// never taken.
const OFF_AXIS = 1.7;
const DIAG = 1.2;
const TURN = [0, 0.35, 1.2, 6, Infinity];
const VIA_COST = 12;
const RIP_COST = 30;
const HIST_STEP = 6;
const HEURISTIC = 1.25;

interface Probe {
  /** radius of the thing placed: half a track width, or a via pad's radius */
  r: number;
  /** a point is blocked when another net's copper is nearer than this */
  needClr: number;
  /** ... or the board edge or a non-plated hole */
  needEdge: number;
  layers: number;
  /** fixed copper (pads, edge, holes): FREE, BLOCKED or the one net allowed */
  own: Int32Array;
  /** tracks and vias: count, sum and sum of squares of the net ids covering each point */
  dc: Int32Array;
  ds: Int32Array;
  dq: Int32Array;
}

interface RPad {
  p: PlacedPad;
  shape: Shape;
  net: number;
  /** grid cells inside the copper (connectivity) */
  cells: number[];
  /** grid cells a track of a given half-width can end on, by half-width */
  term: Map<number, number[]>;
}

interface Conn {
  net: RNet;
  a: number;
  b: number;
  len: number;
  queued: boolean;
  failed: boolean;
}

interface Seg {
  layer: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

interface RPath {
  id: number;
  net: RNet;
  nodes: Int32Array;
  /** polylines per layer, pad stubs included */
  runs: { layer: number; pts: Pt[] }[];
  /** the segments that block other nets (stubs inside pads excluded) */
  segs: Seg[];
  vias: Pt[];
  buckets: number[];
}

interface RNet {
  name: string;
  id: number;
  hw: number;
  w: number;
  pour: boolean;
  /** indices into Router.pads */
  pads: number[];
  conns: Conn[];
  paths: Set<RPath>;
  probe: Probe;
  comps?: { pad: Map<number, number>; path: Map<RPath, number> };
}

class Heap {
  k = new Float64Array(1 << 14);
  v = new Int32Array(1 << 14);
  n = 0;
  push(key: number, val: number) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2);
      const v = new Int32Array(this.n * 2);
      k.set(this.k);
      v.set(this.v);
      this.k = k;
      this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0];
    const n = --this.n;
    if (n > 0) {
      const key = this.k[n];
      const val = this.v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= key) break;
        this.k[i] = this.k[c];
        this.v[i] = this.v[c];
        i = c;
      }
      this.k[i] = key;
      this.v[i] = val;
    }
    return top;
  }
}

class UF {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n).map((_, i) => i);
  }
  find(a: number): number {
    while (this.p[a] !== a) a = this.p[a] = this.p[this.p[a]];
    return a;
  }
  union(a: number, b: number) {
    this.p[this.find(a)] = this.find(b);
  }
}

class Router {
  readonly g: number;
  readonly nx: number;
  readonly ny: number;
  readonly NC: number;
  readonly pads: RPad[];
  readonly nets: RNet[] = [];
  readonly probes = new Map<number, Probe>();
  readonly via: Probe;
  readonly viaR: number;
  /** vias may not go here: over any pad, or too near another via */
  readonly drill: Uint16Array;
  readonly hist: Float32Array;
  readonly buckets: Buckets<RPath>;
  readonly bucketReach: number;
  private nextPath = 0;
  // search state, sized for both layers
  private G: Float64Array;
  private par: Int32Array;
  private seen: Uint32Array;
  private closed: Uint32Array;
  private tgt: Uint32Array;
  private dirIn: Int8Array;
  private sinceVia: Uint8Array;
  private gen = 0;
  private heap = new Heap();
  private readonly viaGap: number;
  private readonly moveCost: Float64Array;
  expansions = 0;

  constructor(
    readonly spec: BoardSpec,
    readonly rules: BoardRules,
  ) {
    const g = (this.g = rules.grid);
    this.nx = Math.floor(spec.w / g + 1e-9) + 1;
    this.ny = Math.floor(spec.h / g + 1e-9) + 1;
    const NC = (this.NC = this.nx * this.ny);
    this.viaR = rules.via.pad / 2;
    this.viaGap = Math.ceil((rules.via.pad + 0.3) / g);
    this.G = new Float64Array(2 * NC);
    this.par = new Int32Array(2 * NC);
    this.seen = new Uint32Array(2 * NC);
    this.closed = new Uint32Array(2 * NC);
    this.tgt = new Uint32Array(2 * NC);
    this.dirIn = new Int8Array(2 * NC);
    this.sinceVia = new Uint8Array(2 * NC);
    this.hist = new Float32Array(2 * NC);
    this.drill = new Uint16Array(NC);
    this.moveCost = new Float64Array(16);
    for (let L = 0; L < 2; L++)
      for (let d = 0; d < 8; d++) {
        const horiz = d === 0 || d === 4;
        const vert = d === 2 || d === 6;
        this.moveCost[L * 8 + d] = horiz ? (L === 0 ? 1 : OFF_AXIS) : vert ? (L === 1 ? 1 : OFF_AXIS) : Math.SQRT2 * DIAG;
      }

    // nets and pads
    const placed = placedPads(spec);
    const netIdx = new Map<string, RNet>();
    for (const n of spec.nets) {
      if (netIdx.has(n.name)) continue;
      const w = n.width ?? rules.track;
      const net: RNet = { name: n.name, id: this.nets.length, hw: w / 2, w, pour: !!n.pour, pads: [], conns: [], paths: new Set(), probe: undefined as unknown as Probe };
      this.nets.push(net);
      netIdx.set(n.name, net);
    }
    this.pads = placed.map((p, i) => {
      const net = p.net !== undefined ? netIdx.get(p.net) : undefined;
      if (net) net.pads.push(i);
      // a pad on no net blocks everyone: give it an id no net has
      return { p, shape: padShape(p), net: net ? net.id : this.nets.length + i, cells: [], term: new Map() };
    });

    this.via = this.makeProbe(this.viaR, 1, 0);
    for (const n of this.nets) n.probe = this.probeFor(n.hw);
    this.bucketReach = Math.max(...[...this.probes.values()].map((p) => p.needClr), this.via.needClr) + Math.max(this.viaR, ...this.nets.map((n) => n.hw));
    this.buckets = new Buckets<RPath>(spec.w, spec.h, 2.5);

    for (const rp of this.pads) {
      this.rasterize(rp.shape, 0, (c) => rp.cells.push(c));
      // vias stay off every pad, the net's own included (their drills would meet)
      this.rasterize(rp.shape, this.viaR + 0.05, (c) => this.drill[c]++);
    }
    for (const n of this.nets) this.planNet(n);
  }

  private margin(d: number) {
    return Math.sqrt(d * d + (this.g * this.g) / 2) - d + 0.002;
  }

  private probeFor(hw: number): Probe {
    const key = Math.round(hw * 1e4);
    let p = this.probes.get(key);
    if (!p) {
      p = this.makeProbe(hw, 2, 1);
      this.probes.set(key, p);
    }
    return p;
  }

  /** Builds a map of blocked points for things of radius r, with the fixed copper, edge and holes in it. */
  private makeProbe(r: number, layers: number, segMargin: number): Probe {
    const { rules, spec, NC, g, nx, ny } = this;
    const clr = r + rules.clearance;
    const edg = r + rules.edge;
    const pr: Probe = {
      r,
      needClr: clr + (segMargin ? this.margin(clr) : 0.002),
      needEdge: edg + (segMargin ? this.margin(edg) : 0.002),
      layers,
      own: new Int32Array(layers * NC).fill(FREE),
      dc: new Int32Array(layers * NC),
      ds: new Int32Array(layers * NC),
      dq: new Int32Array(layers * NC),
    };
    // pads, counted like the dynamic map, then folded into one owner per point
    const fc = new Int32Array(NC);
    const fs = new Int32Array(NC);
    const fq = new Int32Array(NC);
    for (const rp of this.pads)
      this.rasterize(rp.shape, pr.needClr, (c) => {
        fc[c]++;
        fs[c] += rp.net;
        fq[c] += rp.net * rp.net;
      });
    // the edge is concave from inside, so no margin is needed against it
    const edgeNeed = edg + 0.002;
    const holes = placedHoles(spec);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        let o = FREE;
        if (edgeDist(spec, i * g, j * g) < edgeNeed) o = BLOCKED;
        else if (fc[c] > 0) {
          const n = fs[c] / fc[c];
          o = Number.isInteger(n) && fs[c] === n * fc[c] && fq[c] === n * n * fc[c] ? n : BLOCKED;
        }
        for (let L = 0; L < layers; L++) pr.own[L * NC + c] = o;
      }
    for (const h of holes)
      this.rasterize(circle(h.x, h.y, h.d / 2), pr.needEdge, (c) => {
        for (let L = 0; L < layers; L++) pr.own[L * NC + c] = BLOCKED;
      });
    return pr;
  }

  /** Calls fn for every grid cell whose point is nearer than `need` to the shape. */
  rasterize(s: Shape, need: number, fn: (c: number) => void) {
    const { g, nx, ny } = this;
    const b = shapeBox(s);
    const i0 = Math.max(0, Math.ceil((b[0] - need) / g));
    const i1 = Math.min(nx - 1, Math.floor((b[2] + need) / g));
    const j0 = Math.max(0, Math.ceil((b[1] - need) / g));
    const j1 = Math.min(ny - 1, Math.floor((b[3] + need) / g));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (shapeDist(s, i * g, j * g) < need) fn(j * nx + i);
  }

  // ---------------------------------------------------------------- nets

  /** Prim's minimum spanning tree over the net's pads. */
  private planNet(n: RNet) {
    const P = n.pads.length;
    if (P < 2) return;
    const inTree = new Uint8Array(P);
    const best = new Float64Array(P).fill(Infinity);
    const from = new Int32Array(P).fill(-1);
    best[0] = 0;
    for (let k = 0; k < P; k++) {
      let u = -1;
      for (let i = 0; i < P; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
      inTree[u] = 1;
      if (from[u] >= 0) n.conns.push({ net: n, a: n.pads[from[u]], b: n.pads[u], len: best[u], queued: false, failed: false });
      const pu = this.pads[n.pads[u]].p;
      for (let i = 0; i < P; i++) {
        if (inTree[i]) continue;
        const pi = this.pads[n.pads[i]].p;
        const d = Math.hypot(pu.x - pi.x, pu.y - pi.y);
        if (d < best[i]) {
          best[i] = d;
          from[i] = u;
        }
      }
    }
  }

  /** Cells a track of this net can start or end on inside a pad: deep enough that the track stays on the pad. */
  private terminals(pi: number, n: RNet): number[] {
    const rp = this.pads[pi];
    const key = Math.round(n.hw * 1e4);
    let t = rp.term.get(key);
    if (t) return t;
    const own = n.probe.own;
    const open = (c: number) => (own[c] === FREE || own[c] === n.id) && (own[this.NC + c] === FREE || own[this.NC + c] === n.id);
    t = [];
    this.rasterize(rp.shape, -n.hw + 1e-9, (c) => {
      if (open(c)) t!.push(c);
    });
    if (!t.length) {
      // pad smaller than the track: the open cell nearest its centre
      let bestD = Infinity;
      let bestC = -1;
      this.rasterize(rp.shape, this.g, (c) => {
        if (!open(c)) return;
        const d = Math.hypot((c % this.nx) * this.g - rp.p.x, Math.floor(c / this.nx) * this.g - rp.p.y);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      });
      if (bestC >= 0) t.push(bestC);
    }
    rp.term.set(key, t);
    return t;
  }

  /** Which pads and paths of a net are joined, from the grid nodes they share. */
  comps(n: RNet): { pad: Map<number, number>; path: Map<RPath, number> } {
    if (n.comps) return n.comps;
    const paths = [...n.paths];
    const P = n.pads.length;
    const uf = new UF(P + paths.length);
    const at = new Map<number, number>();
    const mark = (node: number, item: number) => {
      const o = at.get(node);
      if (o === undefined) at.set(node, item);
      else uf.union(o, item);
    };
    n.pads.forEach((pi, k) => {
      for (const c of this.pads[pi].cells) {
        mark(c, k);
        mark(this.NC + c, k);
      }
    });
    paths.forEach((p, q) => {
      for (const node of p.nodes) mark(node, P + q);
    });
    const pad = new Map<number, number>();
    const path = new Map<RPath, number>();
    n.pads.forEach((pi, k) => pad.set(pi, uf.find(k)));
    paths.forEach((p, q) => path.set(p, uf.find(P + q)));
    return (n.comps = { pad, path });
  }

  /** Grid nodes of one component: pad terminals on both layers and every node of its paths. */
  compNodes(n: RNet, comp: number, owner: Map<number, number>): number[] {
    const cm = this.comps(n);
    const out: number[] = [];
    for (const pi of n.pads) {
      if (cm.pad.get(pi) !== comp) continue;
      for (const c of this.terminals(pi, n)) {
        out.push(c, this.NC + c);
        owner.set(c, pi);
        owner.set(this.NC + c, pi);
      }
    }
    for (const [p, c] of cm.path) if (c === comp) for (const node of p.nodes) out.push(node);
    return out;
  }

  // ---------------------------------------------------------------- search

  private blockedDyn(pr: Probe, k: number, net: number): boolean {
    const c = pr.dc[k];
    return c !== 0 && !(pr.ds[k] === net * c && pr.dq[k] === net * net * c);
  }

  /**
   * A* from any source node to any target node. `win` limits the search to a
   * box of grid cells; `rip` lets it cross other nets' tracks and vias at a price.
   */
  search(n: RNet, src: number[], dst: number[], win: [number, number, number, number], rip: boolean, owner?: Map<number, number>): Int32Array | null {
    const { NC, nx, G, par, seen, closed, tgt, dirIn, sinceVia, heap, hist, moveCost } = this;
    const pr = n.probe;
    const via = this.via;
    const net = n.id;
    const own = pr.own;
    const dc = pr.dc;
    const ds = pr.ds;
    const dq = pr.dq;
    const nsq = net * net;
    const gen = ++this.gen;
    heap.n = 0;
    let ti0 = Infinity;
    let ti1 = -Infinity;
    let tj0 = Infinity;
    let tj1 = -Infinity;
    for (const node of dst) {
      tgt[node] = gen;
      const c = node % NC;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i < ti0) ti0 = i;
      if (i > ti1) ti1 = i;
      if (j < tj0) tj0 = j;
      if (j > tj1) tj1 = j;
    }
    const [wi0, wj0, wi1, wj1] = win;
    const h = (i: number, j: number) => {
      const dx = i < ti0 ? ti0 - i : i > ti1 ? i - ti1 : 0;
      const dy = j < tj0 ? tj0 - j : j > tj1 ? j - tj1 : 0;
      return HEURISTIC * (dx > dy ? dx + 0.4142 * dy : dy + 0.4142 * dx);
    };
    for (const node of src) {
      if (seen[node] === gen) continue;
      const c = node % NC;
      const i = c % nx;
      const j = (c - i) / nx;
      // a track starting off a pad's centre pays for the stub back to it
      let g0 = owner ? this.stubCost(node, owner) : 0;
      if (this.blockedDyn(pr, node, net)) {
        if (!rip) continue;
        g0 += RIP_COST + hist[node];
      }
      seen[node] = gen;
      G[node] = g0;
      par[node] = -1;
      dirIn[node] = -1;
      sinceVia[node] = 255;
      heap.push(g0 + h(i, j), node);
    }
    let found = -1;
    while (heap.n > 0) {
      const node = heap.pop();
      if (closed[node] === gen) continue;
      closed[node] = gen;
      this.expansions++;
      if (tgt[node] === gen) {
        found = node;
        break;
      }
      const L = node >= NC ? 1 : 0;
      const c = node - L * NC;
      const i = c % nx;
      const j = (c - i) / nx;
      const gn = G[node];
      const din = dirIn[node];
      const sv = sinceVia[node];
      for (let d = 0; d < 8; d++) {
        let tc = 0;
        if (din >= 0) {
          let t = d > din ? d - din : din - d;
          if (t > 4) t = 8 - t;
          if (t === 4) continue;
          tc = TURN[t];
        }
        const ii = i + DX[d];
        const jj = j + DY[d];
        if (ii < wi0 || ii > wi1 || jj < wj0 || jj > wj1) continue;
        const nn = L * NC + jj * nx + ii;
        if (closed[nn] === gen) continue;
        const o = own[nn];
        if (o !== FREE && o !== net) continue;
        let extra = 0;
        const cnt = dc[nn];
        if (cnt !== 0 && !(ds[nn] === net * cnt && dq[nn] === nsq * cnt)) {
          if (!rip) continue;
          extra = RIP_COST + hist[nn];
        }
        let ng = gn + moveCost[L * 8 + d] + tc + extra;
        if (owner && tgt[nn] === gen) ng += this.stubCost(nn, owner);
        if (seen[nn] !== gen || ng < G[nn]) {
          seen[nn] = gen;
          G[nn] = ng;
          par[nn] = node;
          dirIn[nn] = d;
          sinceVia[nn] = sv < 255 ? sv + 1 : 255;
          heap.push(ng + h(ii, jj), nn);
        }
      }
      // change layer through a via
      if (sv >= this.viaGap && this.drill[c] === 0) {
        const on = L ? c : NC + c;
        if (closed[on] === gen) continue;
        const vo = via.own[c];
        if (vo !== FREE && vo !== net) continue;
        const oo = own[on];
        if (oo !== FREE && oo !== net) continue;
        let extra = 0;
        if (this.blockedDyn(via, c, net) || this.blockedDyn(pr, on, net)) {
          if (!rip) continue;
          extra = RIP_COST + hist[on];
        }
        const ng = gn + VIA_COST + extra;
        if (seen[on] !== gen || ng < G[on]) {
          seen[on] = gen;
          G[on] = ng;
          par[on] = node;
          dirIn[on] = -1;
          sinceVia[on] = 0;
          heap.push(ng + h(i, j), on);
        }
      }
    }
    if (found < 0) return null;
    const rev: number[] = [];
    for (let k = found; k >= 0; k = par[k]) rev.push(k);
    return Int32Array.from(rev.reverse());
  }

  /** Length of the stub from a pad terminal to the pad's centre, in grid steps. */
  private stubCost(node: number, owner: Map<number, number>): number {
    const pi = owner.get(node);
    if (pi === undefined) return 0;
    const c = node % this.NC;
    const p = this.pads[pi].p;
    return Math.hypot((c % this.nx) * this.g - p.x, Math.floor(c / this.nx) * this.g - p.y) / this.g;
  }

  private pt(node: number): Pt {
    const c = node % this.NC;
    return [um((c % this.nx) * this.g), um(Math.floor(c / this.nx) * this.g)];
  }

  /** Turns a node list into tracks and vias, merging straight runs, with stubs to the centres of the pads it ends on. */
  makePath(n: RNet, nodes: Int32Array, owner: Map<number, number>): RPath {
    const { NC } = this;
    const runs: RPath["runs"] = [];
    const vias: Pt[] = [];
    let cur = { layer: nodes[0] >= NC ? 1 : 0, pts: [this.pt(nodes[0])] };
    for (let k = 1; k < nodes.length; k++) {
      const a = nodes[k - 1];
      const b = nodes[k];
      if (a % NC === b % NC) {
        runs.push(cur);
        vias.push(this.pt(b));
        cur = { layer: b >= NC ? 1 : 0, pts: [this.pt(b)] };
      } else cur.pts.push(this.pt(b));
    }
    runs.push(cur);
    const segs: Seg[] = [];
    for (const r of runs) {
      r.pts = straighten(r.pts);
      for (let k = 1; k < r.pts.length; k++) segs.push({ layer: r.layer, ax: r.pts[k - 1][0], ay: r.pts[k - 1][1], bx: r.pts[k][0], by: r.pts[k][1] });
    }
    const first = owner.get(nodes[0]);
    const last = owner.get(nodes[nodes.length - 1]);
    if (first !== undefined) runs[0].pts.unshift([this.pads[first].p.x, this.pads[first].p.y]);
    if (last !== undefined) runs[runs.length - 1].pts.push([this.pads[last].p.x, this.pads[last].p.y]);
    for (const r of runs) r.pts = straighten(r.pts);
    return { id: this.nextPath++, net: n, nodes, runs: runs.filter((r) => r.pts.length > 1), segs, vias, buckets: [] };
  }

  private stampPath(p: RPath, sign: number) {
    const net = p.net.id;
    const nsq = net * net;
    const hw = p.net.hw;
    const add = (pr: Probe, L: number) => (c: number) => {
      const k = L * this.NC + c;
      pr.dc[k] += sign;
      pr.ds[k] += sign * net;
      pr.dq[k] += sign * nsq;
    };
    for (const s of p.segs) {
      const sh = capsule(s.ax, s.ay, s.bx, s.by, hw);
      for (const pr of this.probes.values()) this.rasterize(sh, pr.needClr, add(pr, s.layer));
      this.rasterize(sh, this.via.needClr, add(this.via, 0));
    }
    for (const [x, y] of p.vias) {
      const sh = circle(x, y, this.viaR);
      for (const pr of this.probes.values()) {
        this.rasterize(sh, pr.needClr, add(pr, 0));
        this.rasterize(sh, pr.needClr, add(pr, 1));
      }
      this.rasterize(sh, this.via.needClr, add(this.via, 0));
      this.rasterize(sh, this.viaR + 0.1, (c) => (this.drill[c] += sign));
    }
  }

  commit(p: RPath) {
    p.net.paths.add(p);
    p.net.comps = undefined;
    this.stampPath(p, 1);
    const seen = new Set<number>();
    const reach = this.bucketReach;
    const addBox = (b: BBox) => {
      const bs = this.buckets;
      const i0 = Math.max(0, Math.floor(b[0] / bs.size) + 1);
      const i1 = Math.min(bs.nx - 1, Math.floor(b[2] / bs.size) + 1);
      const j0 = Math.max(0, Math.floor(b[1] / bs.size) + 1);
      const j1 = Math.min(bs.ny - 1, Math.floor(b[3] / bs.size) + 1);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = j * bs.nx + i;
          if (seen.has(k)) continue;
          seen.add(k);
          bs.cells[k].push(p);
          p.buckets.push(k);
        }
    };
    for (const s of p.segs) addBox(grow([Math.min(s.ax, s.bx), Math.min(s.ay, s.by), Math.max(s.ax, s.bx), Math.max(s.ay, s.by)], reach));
    for (const [x, y] of p.vias) addBox(grow([x, y, x, y], reach));
  }

  remove(p: RPath) {
    if (!p.net.paths.delete(p)) return;
    p.net.comps = undefined;
    this.stampPath(p, -1);
    for (const k of p.buckets) {
      const list = this.buckets.cells[k];
      const i = list.indexOf(p);
      if (i >= 0) list.splice(i, 1);
    }
    p.buckets = [];
  }

  /** Paths of other nets whose copper blocks a node of a new path. */
  victims(n: RNet, nodes: Int32Array): Set<RPath> {
    const out = new Set<RPath>();
    const { NC, nx, g } = this;
    const test = (x: number, y: number, need: number, layer: number) => {
      const bs = this.buckets;
      const bi = Math.min(bs.nx - 1, Math.max(0, Math.floor(x / bs.size) + 1));
      const bj = Math.min(bs.ny - 1, Math.max(0, Math.floor(y / bs.size) + 1));
      for (const p of bs.cells[bj * bs.nx + bi]) {
        if (p.net === n || out.has(p)) continue;
        let hit = false;
        for (const s of p.segs) {
          if (layer >= 0 && s.layer !== layer) continue;
          if (shapeDist(capsule(s.ax, s.ay, s.bx, s.by, p.net.hw), x, y) < need) {
            hit = true;
            break;
          }
        }
        if (!hit) for (const [vx, vy] of p.vias) if (Math.hypot(vx - x, vy - y) - this.viaR < need) hit = true;
        if (hit) out.add(p);
      }
    };
    for (let k = 0; k < nodes.length; k++) {
      const node = nodes[k];
      const L = node >= NC ? 1 : 0;
      const c = node - L * NC;
      const x = (c % nx) * g;
      const y = Math.floor(c / nx) * g;
      if (this.blockedDyn(n.probe, node, n.id)) {
        this.hist[node] += HIST_STEP;
        test(x, y, n.probe.needClr, L);
      }
      if (k > 0 && nodes[k - 1] % NC === c && this.blockedDyn(this.via, c, n.id)) {
        this.hist[node] += HIST_STEP;
        test(x, y, this.via.needClr, -1);
      }
    }
    return out;
  }

  /** Removes paths left hanging (touching at most one other thing of their net) after a rip-up. */
  prune(n: RNet) {
    for (let changed = true; changed; ) {
      changed = false;
      const at = new Map<number, number>();
      n.pads.forEach((pi, k) => {
        for (const c of this.pads[pi].cells) {
          at.set(c, k);
          at.set(this.NC + c, k);
        }
      });
      const paths = [...n.paths];
      const P = n.pads.length;
      const touch: Set<number>[] = paths.map(() => new Set());
      const owners = new Map<number, number[]>();
      paths.forEach((p, q) => {
        for (const node of p.nodes) {
          const pad = at.get(node);
          if (pad !== undefined) touch[q].add(pad);
          const os = owners.get(node);
          if (os) {
            for (const o of os) {
              if (o === q) continue;
              touch[q].add(P + o);
              touch[o].add(P + q);
            }
            if (!os.includes(q)) os.push(q);
          } else owners.set(node, [q]);
        }
      });
      paths.forEach((p, q) => {
        if (touch[q].size <= 1) {
          this.remove(p);
          changed = true;
        }
      });
    }
  }
}

/** Drops points where a polyline goes straight on. */
export function straighten(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-9 && Math.abs(out[out.length - 1][1] - p[1]) < 1e-9) continue;
    while (out.length >= 2) {
      const [ax, ay] = out[out.length - 2];
      const [bx, by] = out[out.length - 1];
      const cross = (bx - ax) * (p[1] - by) - (by - ay) * (p[0] - bx);
      const dot = (bx - ax) * (p[0] - bx) + (by - ay) * (p[1] - by);
      if (Math.abs(cross) < 1e-9 && dot > 0) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- driver

export function routeBoard(spec: BoardSpec, opts: { maxMs?: number } = {}): RoutedBoard {
  const t0 = now();
  const maxMs = opts.maxMs ?? 3000;
  const rules = boardRules(spec);
  const R = new Router(spec, rules);
  const all: Conn[] = R.nets.flatMap((n) => n.conns);
  // short connections first; wide nets slightly earlier, they are the hardest to fit later
  const key = (c: Conn) => c.len * (c.net.w > rules.track + 1e-9 ? 0.7 : 1);
  const queue = [...all].sort((a, b) => key(a) - key(b));
  for (const c of queue) c.queued = true;
  const { g, nx, ny } = R;
  const cell = (pi: number): [number, number] => [Math.round(R.pads[pi].p.x / g), Math.round(R.pads[pi].p.y / g)];
  const box = (c: Conn, m: number): [number, number, number, number] => {
    const [ai, aj] = cell(c.a);
    const [bi, bj] = cell(c.b);
    const mc = Math.ceil(m / g);
    return [Math.max(0, Math.min(ai, bi) - mc), Math.max(0, Math.min(aj, bj) - mc), Math.min(nx - 1, Math.max(ai, bi) + mc), Math.min(ny - 1, Math.max(aj, bj) + mc)];
  };
  const whole: [number, number, number, number] = [0, 0, nx - 1, ny - 1];
  let rips = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    if (now() - t0 > maxMs) break;
    const c = queue[qi];
    c.queued = false;
    const n = c.net;
    const cm = R.comps(n);
    const ca = cm.pad.get(c.a)!;
    const cb = cm.pad.get(c.b)!;
    if (ca === cb) continue;
    const owner = new Map<number, number>();
    let src = R.compNodes(n, ca, owner);
    let dst = R.compNodes(n, cb, owner);
    if (src.length > dst.length) [src, dst] = [dst, src];
    if (!src.length || !dst.length) {
      c.failed = true;
      continue;
    }
    let nodes = R.search(n, src, dst, box(c, 5), false, owner) ?? R.search(n, src, dst, whole, false, owner);
    if (!nodes) {
      // the last fifth of the time only fits in what still fits, so a board that can't be finished ends settled
      if (now() - t0 > maxMs * 0.8) {
        c.failed = true;
        continue;
      }
      nodes = R.search(n, src, dst, box(c, 12), true, owner) ?? R.search(n, src, dst, whole, true, owner);
      if (!nodes) {
        c.failed = true;
        continue;
      }
      const hit = R.victims(n, nodes);
      const touched = new Set<RNet>();
      for (const p of hit) {
        R.remove(p);
        touched.add(p.net);
        rips++;
      }
      for (const tn of touched) {
        R.prune(tn);
        const tc = R.comps(tn);
        for (const k of tn.conns)
          if (!k.queued && tc.pad.get(k.a) !== tc.pad.get(k.b)) {
            k.queued = true;
            k.failed = false;
            queue.push(k);
          }
      }
    }
    R.commit(R.makePath(n, nodes, owner));
  }
  const routeMs = now() - t0;

  // output
  const tracks: Track[] = [];
  const vias: Via[] = [];
  for (const n of R.nets)
    for (const p of n.paths) {
      for (const r of p.runs) tracks.push({ net: n.name, layer: r.layer ? "B" : "F", w: n.w, pts: r.pts });
      for (const [x, y] of p.vias) vias.push({ net: n.name, x, y, pad: rules.via.pad, drill: rules.via.drill });
    }
  const unrouted: RoutedBoard["unrouted"] = [];
  for (const n of R.nets) {
    const cm = R.comps(n);
    // join the leftover components greedily, nearest pads first, to list what is missing
    const groups = new Map<number, number[]>();
    for (const pi of n.pads) {
      const k = cm.pad.get(pi)!;
      groups.set(k, [...(groups.get(k) ?? []), pi]);
    }
    let parts = [...groups.values()];
    while (parts.length > 1) {
      let best = { d: Infinity, i: 0, j: 1, a: parts[0][0], b: parts[1][0] };
      for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++)
          for (const a of parts[i])
            for (const b of parts[j]) {
              const d = Math.hypot(R.pads[a].p.x - R.pads[b].p.x, R.pads[a].p.y - R.pads[b].p.y);
              if (d < best.d) best = { d, i, j, a, b };
            }
      const pa = R.pads[best.a].p;
      const pb = R.pads[best.b].p;
      unrouted.push({ net: n.name, a: { ref: pa.ref, pin: pa.pin }, b: { ref: pb.ref, pin: pb.pin } });
      parts[best.i] = [...parts[best.i], ...parts[best.j]];
      parts = parts.filter((_, k) => k !== best.j);
    }
  }

  const { pours, vias: stitches } = makePours({ spec, rules, tracks, vias });
  vias.push(...stitches);
  const board: RoutedBoard = { spec, rules, tracks, vias, pours, unrouted, drc: [], stats: { connections: all.length, routed: 0, vias: vias.length, trackLength: 0, ms: 0 } };
  // a pour net the tracks didn't finish may still be joined by its pour
  if (pours.length && unrouted.some((u) => spec.nets.find((n) => n.name === u.net)?.pour)) {
    const joined = connectivity(board);
    board.unrouted = unrouted.filter((u) => !joined.sameNode(u.net, u.a, u.b));
  }
  board.drc = boardDrc(board);
  let len = 0;
  for (const t of tracks) for (let k = 1; k < t.pts.length; k++) len += Math.hypot(t.pts[k][0] - t.pts[k - 1][0], t.pts[k][1] - t.pts[k - 1][1]);
  board.stats = { connections: all.length, routed: all.length - board.unrouted.length, vias: vias.length, trackLength: Math.round(len * 10) / 10, ms: Math.round(now() - t0) };
  debugStats = { routeMs, rips, expansions: R.expansions };
  return board;
}

/** Numbers from the last routeBoard call, for tuning. */
export let debugStats = { routeMs: 0, rips: 0, expansions: 0 };
