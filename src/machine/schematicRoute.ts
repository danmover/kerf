// Routing a schematic's wires: square paths on a half-grid that go round the symbols, keep clear of other pins and
// of each other (a wire running along another, or through a pin, would read as a connection), and bend as little as
// they can. A* over (cell, heading), shortest connections first; one that finds no way through gets a plain route.

export type P2 = [number, number];

export interface RoutePin {
  at: P2;
  out: P2;
}

export interface RouteObstacles {
  /** symbol outlines with their pin stubs: left, top, right, bottom */
  boxes: [number, number, number, number][];
  /** title and part-name text above and below the symbols: wires keep off them where they can */
  soft: [number, number, number, number][];
  /** every pin on the sheet (no wire runs through one) */
  pins: RoutePin[];
}

const STEP = 2.5;
const BEND = 6;
const OVERLAP = 400;
const CROSS = 4;
const SOFT = 10;
/** in front of another pin: free for its own wire, costly for the rest */
const FRONT = 25;
const DIRS: P2[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const dirOf = (d: P2) => (d[0] > 0 ? 0 : d[0] < 0 ? 1 : d[1] > 0 ? 2 : 3);

/** A plain route: out of each pin and across in a lane of its own (what a wire gets when routing is off or fails). */
export function plainRoute(a: RoutePin, b: RoutePin, lane: number, grid: number): P2[] {
  const a1: P2 = [a.at[0] + a.out[0] * grid, a.at[1] + a.out[1] * grid];
  const b1: P2 = [b.at[0] + b.out[0] * grid, b.at[1] + b.out[1] * grid];
  const shift = ((lane % 5) - 2) * 1.5;
  if (a.out[1] === 0 && b.out[1] === 0) {
    const mx = (a1[0] + b1[0]) / 2 + shift;
    return simplify([a.at, a1, [mx, a1[1]], [mx, b1[1]], b1, b.at]);
  }
  const my = (a1[1] + b1[1]) / 2 + shift;
  return simplify([a.at, a1, [a1[0], my], [b1[0], my], b1, b.at]);
}

/** Routes every pair, shortest first, each keeping off the ones before it. Returns the paths in the pairs' order. */
export function routeWires(pairs: { a: RoutePin; b: RoutePin }[], obs: RouteObstacles, grid: number): P2[][] {
  if (!pairs.length) return [];
  // the area to route in: everything on the sheet with room round it
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number) => ((x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y)));
  for (const b of obs.boxes) (grow(b[0], b[1]), grow(b[2], b[3]));
  for (const p of obs.pins) grow(p.at[0], p.at[1]);
  x0 = Math.floor((x0 - 30) / grid) * grid;
  y0 = Math.floor((y0 - 30) / grid) * grid;
  x1 = Math.ceil((x1 + 30) / grid) * grid;
  y1 = Math.ceil((y1 + 30) / grid) * grid;
  const nx = Math.round((x1 - x0) / STEP) + 1;
  const ny = Math.round((y1 - y0) / STEP) + 1;
  // too big a sheet to route cell by cell: plain routes
  if (nx * ny > 400_000) return pairs.map((p, i) => plainRoute(p.a, p.b, i, grid));
  const cell = (x: number, y: number) => {
    const i = Math.round((x - x0) / STEP);
    const j = Math.round((y - y0) / STEP);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  const N = nx * ny;
  const blocked = new Uint8Array(N);
  const extra = new Float32Array(N);
  const usedH = new Uint8Array(N);
  const usedV = new Uint8Array(N);
  const fill = (b: [number, number, number, number], f: (c: number) => void) => {
    const i0 = Math.max(0, Math.ceil((b[0] - x0) / STEP - 1e-9));
    const i1 = Math.min(nx - 1, Math.floor((b[2] - x0) / STEP + 1e-9));
    const j0 = Math.max(0, Math.ceil((b[1] - y0) / STEP - 1e-9));
    const j1 = Math.min(ny - 1, Math.floor((b[3] - y0) / STEP + 1e-9));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * nx + i);
  };
  for (const b of obs.boxes) fill(b, (c) => (blocked[c] = 1));
  for (const b of obs.soft) fill(b, (c) => (extra[c] += SOFT));
  // pins: their tips are walls, and the cell in front of each is kept for its own wire
  const front = new Map<number, number>();
  obs.pins.forEach((p, k) => {
    const t = cell(p.at[0], p.at[1]);
    if (t >= 0) blocked[t] = 1;
    const f = cell(p.at[0] + p.out[0] * grid, p.at[1] + p.out[1] * grid);
    if (f >= 0) front.set(f, k);
  });
  const pinIndex = new Map(obs.pins.map((p, k) => [p, k] as const));

  // shortest first: short connections get the direct way, long ones go round them
  const order = pairs.map((p, i) => ({ i, d: Math.abs(p.a.at[0] - p.b.at[0]) + Math.abs(p.a.at[1] - p.b.at[1]) })).sort((u, v) => u.d - v.d);
  const out: P2[][] = new Array(pairs.length);
  const g = new Float32Array(N * 4);
  const from = new Int32Array(N * 4);
  const closed = new Uint8Array(N * 4);
  for (const { i } of order) {
    const { a, b } = pairs[i];
    const ka = pinIndex.get(a) ?? -1;
    const kb = pinIndex.get(b) ?? -1;
    const a1: P2 = [a.at[0] + a.out[0] * grid, a.at[1] + a.out[1] * grid];
    const b1: P2 = [b.at[0] + b.out[0] * grid, b.at[1] + b.out[1] * grid];
    const s = cell(a1[0], a1[1]);
    const t = cell(b1[0], b1[1]);
    const path = s >= 0 && t >= 0 ? astar(s, dirOf(a.out), t, dirOf([-b.out[0], -b.out[1]])) : null;
    const pts = path ? simplify([a.at, ...path.map((c) => [x0 + (c % nx) * STEP, y0 + Math.floor(c / nx) * STEP] as P2), b.at]) : plainRoute(a, b, i, grid);
    out[i] = pts;
    mark(pts);

    function astar(start: number, d0: number, goal: number, dGoal: number): number[] | null {
      g.fill(Infinity);
      closed.fill(0);
      const gx = goal % nx;
      const gy = Math.floor(goal / nx);
      const h = (c: number) => Math.abs((c % nx) - gx) + Math.abs(Math.floor(c / nx) - gy);
      const heap = new Heap();
      const s0 = start * 4 + d0;
      g[s0] = 0;
      from[s0] = -1;
      heap.push(s0, h(start));
      let budget = 250_000;
      while (heap.size && budget-- > 0) {
        const st = heap.pop();
        if (closed[st]) continue;
        closed[st] = 1;
        const c = st >> 2;
        const d = st & 3;
        if (c === goal) return unwind(st);
        const ci = c % nx;
        const cj = Math.floor(c / nx);
        for (let nd = 0; nd < 4; nd++) {
          // no turning straight back
          if ((nd ^ 1) === d) continue;
          const ni = ci + DIRS[nd][0];
          const nj = cj + DIRS[nd][1];
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
          const n = nj * nx + ni;
          if (blocked[n] && n !== goal) continue;
          const horiz = nd < 2;
          let cost = 1 + (nd !== d ? BEND : 0) + extra[n];
          if (horiz ? usedH[n] : usedV[n]) cost += OVERLAP;
          else if (horiz ? usedV[n] : usedH[n]) cost += CROSS;
          // turning where another wire runs makes a corner on it: as bad as running along it
          if (nd !== d && (usedH[c] || usedV[c])) cost += OVERLAP;
          const f = front.get(n);
          if (f !== undefined && f !== ka && f !== kb) cost += FRONT;
          if (n === goal && nd !== dGoal) cost += BEND;
          const ns = n * 4 + nd;
          const ng = g[st] + cost;
          if (ng < g[ns]) {
            g[ns] = ng;
            from[ns] = st;
            heap.push(ns, ng + h(n));
          }
        }
      }
      return null;
    }

    function unwind(st: number): number[] {
      const cells: number[] = [];
      for (let x = st; x >= 0; x = from[x]) cells.push(x >> 2);
      return cells.reverse();
    }
  }

  function mark(pts: P2[]) {
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1];
      const [bx, by] = pts[k];
      const n = Math.round(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) / STEP);
      const horiz = ay === by;
      for (let q = 0; q <= n; q++) {
        const c = cell(ax + ((bx - ax) * q) / Math.max(n, 1), ay + ((by - ay) * q) / Math.max(n, 1));
        if (c < 0) continue;
        if (horiz) usedH[c] = 1;
        else usedV[c] = 1;
      }
      // a corner holds both ways
      if (k < pts.length - 1) {
        const c = cell(bx, by);
        if (c >= 0) usedH[c] = usedV[c] = 1;
      }
    }
  }
  return out;
}

/** Drops the points in the middle of straight runs. */
export function simplify(pts: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1]) continue;
    const r = out[out.length - 2];
    if (q && r && ((r[0] === q[0] && q[0] === p[0]) || (r[1] === q[1] && q[1] === p[1]))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** A binary min-heap of states keyed by cost. */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.v.length;
  }
  push(state: number, key: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(state);
    let i = v.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = state;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (v.length) {
      let i = 0;
      const n = v.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}
