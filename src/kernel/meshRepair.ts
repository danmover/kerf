// Mends a triangle mesh so it can become a solid: corners that repeat are merged,
// flat and doubled triangles go, triangles are turned to face the same way as
// their neighbours, gaps are closed, inside-out shells are turned out, and shells
// inside other shells become their hollows. What was done is counted, so the
// import can say so. Pure TypeScript, run in the kernel worker and in tests.

import { earClip } from "./meshRead";

type P3 = [number, number, number];

export interface RepairReport {
  /** triangles the file had */
  trianglesIn: number;
  /** corners merged with the copies other triangles had of them */
  welded: number;
  /** triangles with no area, removed or split into their neighbour */
  degenerate: number;
  /** triangles that were in the file twice */
  duplicates: number;
  /** triangles turned to face the same way as their neighbours */
  flipped: number;
  /** gaps in the surface that were closed, and how many edges ran round them */
  holes: number;
  holeEdges: number;
  /** edges still open after filling */
  openEdges: number;
  /** edges shared by more than two triangles */
  nonManifold: number;
  /** closed shells that were inside out */
  insideOut: number;
  /** shells inside other shells, kept as hollows */
  voids: number;
}

/** One solid's worth of the mesh: its outer shell first, then the hollows inside it. */
export interface MeshBody {
  positions: Float64Array;
  triangles: Uint32Array;
  /** per triangle an index into the mesh's palette, when triangles have their own colours */
  triColor?: Uint16Array;
  /** where each shell's triangles start in `triangles` (in triangles, not indices); the first shell is the outside */
  shellStarts: number[];
  /** true when every shell is closed, so the body has an inside */
  closed: boolean;
  /** enclosed volume in mm³ (outer shell less its hollows); 0 when open */
  volume: number;
}

export interface RepairInput {
  positions: ArrayLike<number>;
  triangles: ArrayLike<number>;
  triColor?: ArrayLike<number>;
}

export interface RepairOptions {
  /** corners closer than this are one corner (mm); default from the size of the mesh */
  weld?: number;
  /** holes with more edges than this are left open */
  maxHoleEdges?: number;
}

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);

export function meshBox(pos: ArrayLike<number>): [P3, P3] {
  const lo: P3 = [Infinity, Infinity, Infinity];
  const hi: P3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  return [lo, hi];
}

/**
 * Merge corners that sit within `tol` of each other, by a hash of their rounded
 * position. Returns the merged positions and, per input corner, its new index.
 */
export function weldCorners(pos: ArrayLike<number>, tol: number): { positions: Float64Array; remap: Uint32Array } {
  const n = Math.floor(pos.length / 3);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const keys = new Float64Array(n * 3);
  const out = new Float64Array(n * 3);
  const remap = new Uint32Array(n);
  let count = 0;
  const q = 1 / tol;
  for (let i = 0; i < n; i++) {
    const x = Math.round(pos[i * 3] * q);
    const y = Math.round(pos[i * 3 + 1] * q);
    const z = Math.round(pos[i * 3 + 2] * q);
    let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & (size - 1);
    for (;;) {
      const j = table[h];
      if (j < 0) {
        table[h] = count;
        keys[count * 3] = x;
        keys[count * 3 + 1] = y;
        keys[count * 3 + 2] = z;
        out[count * 3] = pos[i * 3];
        out[count * 3 + 1] = pos[i * 3 + 1];
        out[count * 3 + 2] = pos[i * 3 + 2];
        remap[i] = count++;
        break;
      }
      if (keys[j * 3] === x && keys[j * 3 + 1] === y && keys[j * 3 + 2] === z) {
        remap[i] = j;
        break;
      }
      h = (h + 1) & (size - 1);
    }
  }
  return { positions: out.slice(0, count * 3), remap };
}

/**
 * Undirected edges of a triangle list, each with the triangles that use it: an
 * open-addressed table in typed arrays, since a mesh can have millions of edges.
 * Most edges have two users; more are kept on the side.
 */
export class EdgeTable {
  private cap = 0;
  private ka!: Int32Array;
  private kb!: Int32Array;
  private t0!: Int32Array;
  private t1!: Int32Array;
  private n!: Int32Array;
  private extra = new Map<number, number[]>();
  private used = 0;
  constructor(expected: number) {
    this.alloc(Math.max(64, expected * 2));
  }
  private alloc(want: number) {
    let cap = 64;
    while (cap < want) cap <<= 1;
    this.cap = cap;
    this.ka = new Int32Array(cap).fill(-1);
    this.kb = new Int32Array(cap);
    this.t0 = new Int32Array(cap).fill(-1);
    this.t1 = new Int32Array(cap).fill(-1);
    this.n = new Int32Array(cap);
    this.used = 0;
  }
  private hash(a: number, b: number) {
    return (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77)) & (this.cap - 1);
  }
  private find(a: number, b: number, create: boolean): number {
    if (a > b) [a, b] = [b, a];
    let h = this.hash(a, b);
    for (;;) {
      const x = this.ka[h];
      if (x === -1) {
        if (!create) return -1;
        if ((this.used + 1) * 2 > this.cap) {
          this.grow();
          return this.find(a, b, true);
        }
        this.ka[h] = a;
        this.kb[h] = b;
        this.used++;
        return h;
      }
      if (x === a && this.kb[h] === b) return h;
      h = (h + 1) & (this.cap - 1);
    }
  }
  private grow() {
    const old = { ka: this.ka, kb: this.kb, t0: this.t0, t1: this.t1, n: this.n, extra: this.extra, cap: this.cap };
    this.extra = new Map();
    this.alloc(old.cap * 2);
    for (let s = 0; s < old.cap; s++) {
      if (old.ka[s] === -1) continue;
      const h = this.find(old.ka[s], old.kb[s], true);
      this.n[h] = old.n[s];
      this.t0[h] = old.t0[s];
      this.t1[h] = old.t1[s];
      const e = old.extra.get(s);
      if (e) this.extra.set(h, e);
    }
  }
  private list(s: number): number[] {
    const c = this.n[s];
    if (c === 0) return [];
    if (c === 1) return [this.t0[s]];
    if (c === 2) return [this.t0[s], this.t1[s]];
    return [this.t0[s], this.t1[s], ...(this.extra.get(s) ?? [])];
  }
  private store(s: number, l: number[]) {
    this.n[s] = l.length;
    this.t0[s] = l[0] ?? -1;
    this.t1[s] = l[1] ?? -1;
    if (l.length > 2) this.extra.set(s, l.slice(2));
    else this.extra.delete(s);
  }
  add(a: number, b: number, t: number) {
    const s = this.find(a, b, true);
    const c = this.n[s];
    if (c === 0) this.t0[s] = t;
    else if (c === 1) this.t1[s] = t;
    else {
      const e = this.extra.get(s);
      if (e) e.push(t);
      else this.extra.set(s, [t]);
    }
    this.n[s] = c + 1;
  }
  remove(a: number, b: number, t: number) {
    const s = this.find(a, b, false);
    if (s < 0) return;
    const l = this.list(s);
    const i = l.indexOf(t);
    if (i < 0) return;
    l.splice(i, 1);
    this.store(s, l);
  }
  users(a: number, b: number): number[] {
    const s = this.find(a, b, false);
    return s < 0 ? [] : this.list(s);
  }
  count(a: number, b: number): number {
    const s = this.find(a, b, false);
    return s < 0 ? 0 : this.n[s];
  }
  /** every edge in use: its two corners (lower first) and the triangles on it */
  each(fn: (a: number, b: number, users: number[]) => void) {
    for (let s = 0; s < this.cap; s++) if (this.ka[s] !== -1 && this.n[s] > 0) fn(this.ka[s], this.kb[s], this.list(s));
  }
}

/**
 * Repair a mesh and split it into solids. Corners closer than the weld
 * tolerance merge; triangles are cleaned, oriented, closed and grouped into
 * bodies of an outer shell and its hollows.
 */
export function repairMesh(input: RepairInput, opts: RepairOptions = {}): { bodies: MeshBody[]; report: RepairReport } {
  const report: RepairReport = { trianglesIn: Math.floor(input.triangles.length / 3), welded: 0, degenerate: 0, duplicates: 0, flipped: 0, holes: 0, holeEdges: 0, openEdges: 0, nonManifold: 0, insideOut: 0, voids: 0 };
  const [lo, hi] = meshBox(input.positions);
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const tol = opts.weld ?? Math.min(1e-2, Math.max(1e-4, diag * 1e-7));
  const maxHole = opts.maxHoleEdges ?? 20000;

  // ---- merge corners
  const corners = Math.floor(input.positions.length / 3);
  const w = weldCorners(input.positions, tol);
  report.welded = corners - w.positions.length / 3;
  const P: number[] = Array.from(w.positions);
  const pt = (i: number): P3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

  // triangles as a growable list; a dead one has -1 for its first corner
  const T: number[] = [];
  const C: number[] = [];
  const hasColor = !!input.triColor;
  for (let t = 0; t + 2 < input.triangles.length; t += 3) {
    const a = w.remap[input.triangles[t]];
    const b = w.remap[input.triangles[t + 1]];
    const c = w.remap[input.triangles[t + 2]];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (a === b || b === c || a === c) {
      report.degenerate++;
      continue;
    }
    T.push(a, b, c);
    C.push(hasColor ? (input.triColor![t / 3] ?? 0) : 0);
  }
  const nT = () => T.length / 3;
  const alive = (t: number) => T[t * 3] >= 0;
  const edges = new EdgeTable(Math.ceil(nT() * 1.6) + 16);
  for (let t = 0; t < nT(); t++) {
    const a = T[t * 3],
      b = T[t * 3 + 1],
      c = T[t * 3 + 2];
    edges.add(a, b, t);
    edges.add(b, c, t);
    edges.add(c, a, t);
  }
  const triPts = (t: number): [P3, P3, P3] => [pt(T[t * 3]), pt(T[t * 3 + 1]), pt(T[t * 3 + 2])];
  const kill = (t: number) => {
    const a = T[t * 3],
      b = T[t * 3 + 1],
      c = T[t * 3 + 2];
    edges.remove(a, b, t);
    edges.remove(b, c, t);
    edges.remove(c, a, t);
    T[t * 3] = -1;
  };
  const addTri = (a: number, b: number, c: number, color: number) => {
    const t = nT();
    T.push(a, b, c);
    C.push(color);
    edges.add(a, b, t);
    edges.add(b, c, t);
    edges.add(c, a, t);
    return t;
  };
  /** +1 when triangle t runs a → b, -1 when it runs b → a, 0 when it does not have that edge */
  const runs = (t: number, a: number, b: number) => {
    for (let i = 0; i < 3; i++) {
      if (T[t * 3 + i] === a && T[t * 3 + ((i + 1) % 3)] === b) return 1;
      if (T[t * 3 + i] === b && T[t * 3 + ((i + 1) % 3)] === a) return -1;
    }
    return 0;
  };
  const flip = (t: number) => {
    const b = T[t * 3 + 1];
    T[t * 3 + 1] = T[t * 3 + 2];
    T[t * 3 + 2] = b;
  };
  const third = (t: number, a: number, b: number) => {
    for (let i = 0; i < 3; i++) {
      const v = T[t * 3 + i];
      if (v !== a && v !== b) return v;
    }
    return -1;
  };

  // ---- doubled triangles: the same three corners twice. Facing apart they are a wall of no thickness, so both go
  {
    const gone = new Set<number>();
    edges.each((a, b, users) => {
      if (users.length < 2) return;
      for (let i = 0; i < users.length; i++)
        for (let j = i + 1; j < users.length; j++) {
          const x = users[i],
            y = users[j];
          if (gone.has(x) || gone.has(y) || third(x, a, b) !== third(y, a, b)) continue;
          gone.add(y);
          if (runs(x, a, b) !== runs(y, a, b)) gone.add(x);
        }
    });
    for (const t of gone) kill(t);
    report.duplicates = gone.size;
  }

  /** A triangle whose corner lies on its opposite edge has no area: it goes, and its neighbour across that edge is split at the corner. */
  const mendFlat = (from: number) => {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (let t = from; t < nT(); t++) {
        if (!alive(t)) continue;
        const v = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
        const p = v.map(pt);
        // the longest edge, u → w as the triangle runs, and the corner r across from it
        let k = 0;
        let best = -1;
        for (let i = 0; i < 3; i++) {
          const l = len(sub(p[(i + 1) % 3], p[i]));
          if (l > best) {
            best = l;
            k = i;
          }
        }
        if (best <= 0 || len(cross(sub(p[1], p[0]), sub(p[2], p[0]))) / best > tol) continue;
        const u = v[k],
          wv = v[(k + 1) % 3],
          r = v[(k + 2) % 3];
        const other = edges.users(u, wv).filter((x) => x !== t);
        kill(t);
        report.degenerate++;
        changed = true;
        if (other.length !== 1) continue;
        const n = other[0];
        if (runs(n, wv, u) !== 1) continue;
        const d = third(n, u, wv);
        if (d === r || d < 0) continue;
        const col = C[n];
        kill(n);
        addTri(wv, r, d, col);
        addTri(r, u, d, col);
      }
      if (!changed) break;
    }
  };
  mendFlat(0);
  edges.each((_a, _b, users) => {
    if (users.length > 2) report.nonManifold++;
  });

  // ---- shells: triangles joined through edges that exactly two triangles share, turned to agree with each other
  let shells: number[][] = [];
  const orient = () => {
    const shellOf = new Int32Array(nT()).fill(-1);
    shells = [];
    for (let s = 0; s < nT(); s++) {
      if (!alive(s) || shellOf[s] >= 0) continue;
      const id = shells.length;
      const list: number[] = [s];
      shellOf[s] = id;
      for (let qi = 0; qi < list.length; qi++) {
        const t = list[qi];
        for (let i = 0; i < 3; i++) {
          const a = T[t * 3 + i],
            b = T[t * 3 + ((i + 1) % 3)];
          const users = edges.users(a, b);
          if (users.length !== 2) continue;
          const n = users[0] === t ? users[1] : users[0];
          if (shellOf[n] >= 0) continue;
          // neighbours run their shared edge in opposite directions
          if (runs(n, a, b) === 1) {
            flip(n);
            report.flipped++;
          }
          shellOf[n] = id;
          list.push(n);
        }
      }
      shells.push(list);
    }
  };
  orient();

  // ---- close gaps: edges only one triangle uses, chained into loops and filled
  const open: { a: number; b: number; t: number }[] = [];
  edges.each((x, y, users) => {
    if (users.length !== 1) return;
    const t = users[0];
    // the fill runs the edge the other way from the triangle beside it
    if (runs(t, x, y) === 1) open.push({ a: y, b: x, t });
    else open.push({ a: x, b: y, t });
  });
  if (open.length) {
    const from = new Map<number, number[]>();
    open.forEach((e, i) => {
      const l = from.get(e.a);
      if (l) l.push(i);
      else from.set(e.a, [i]);
    });
    const used = new Uint8Array(open.length);
    const firstNew = nT();
    for (let i = 0; i < open.length; i++) {
      if (used[i]) continue;
      const loop: number[] = [];
      let cur = i;
      let closed = false;
      for (let guard = 0; guard <= open.length; guard++) {
        used[cur] = 1;
        loop.push(cur);
        const next = (from.get(open[cur].b) ?? []).find((j) => j === i || !used[j]);
        if (next === undefined) break;
        if (next === i) {
          closed = true;
          break;
        }
        cur = next;
      }
      if (!closed || loop.length < 3 || loop.length > maxHole) continue;
      const ids = loop.map((e) => open[e].a);
      const color = C[open[loop[0]].t];
      const tris = earClip(ids.map(pt));
      if (tris && tris.length) {
        for (let k = 0; k < tris.length; k += 3) addTri(ids[tris[k]], ids[tris[k + 1]], ids[tris[k + 2]], color);
      } else {
        // too tangled to clip: a fan from a new corner in the middle
        const mid: P3 = [0, 0, 0];
        for (const v of ids) {
          const q = pt(v);
          for (let k = 0; k < 3; k++) mid[k] += q[k] / ids.length;
        }
        const m = P.length / 3;
        P.push(mid[0], mid[1], mid[2]);
        for (let k = 0; k < ids.length; k++) addTri(ids[k], ids[(k + 1) % ids.length], m, color);
      }
      report.holes++;
      report.holeEdges += loop.length;
    }
    // fills can leave slivers of their own; mend them, then orient again with the new triangles in
    mendFlat(firstNew);
    orient();
  }

  // ---- each shell: closed or not, which way out, and whether it sits inside another
  const info = shells.map((list) => {
    let openEdges = 0;
    const lo: P3 = [Infinity, Infinity, Infinity];
    const hi: P3 = [-Infinity, -Infinity, -Infinity];
    for (const t of list)
      for (let i = 0; i < 3; i++) {
        const a = T[t * 3 + i],
          b = T[t * 3 + ((i + 1) % 3)];
        if (edges.count(a, b) !== 2) openEdges++;
        for (let k = 0; k < 3; k++) {
          const v = P[a * 3 + k];
          if (v < lo[k]) lo[k] = v;
          if (v > hi[k]) hi[k] = v;
        }
      }
    return { list, closed: openEdges === 0, openEdges, lo, hi, volume: 0 };
  });
  for (const s of info) {
    report.openEdges += s.openEdges;
    const o: P3 = [(s.lo[0] + s.hi[0]) / 2, (s.lo[1] + s.hi[1]) / 2, (s.lo[2] + s.hi[2]) / 2];
    let v = 0;
    for (const t of s.list) {
      const [a, b, c] = triPts(t).map((q) => sub(q, o)) as [P3, P3, P3];
      v += dot(a, cross(b, c)) / 6;
    }
    if (s.closed && v < 0) {
      for (const t of s.list) flip(t);
      v = -v;
      report.insideOut++;
    }
    s.volume = s.closed ? v : 0;
  }

  // a closed shell inside an odd number of others is a hollow of the innermost one
  const order = info.map((_, i) => i).sort((a, b) => info[b].volume - info[a].volume);
  const parent = new Int32Array(info.length).fill(-1);
  const depth = new Int32Array(info.length);
  let budget = 6e7;
  for (let oi = 0; oi < order.length && budget > 0; oi++) {
    const i = order[oi];
    const s = info[i];
    if (!s.closed) continue;
    const probe = pt(T[s.list[0] * 3]);
    // look from the smallest bigger shell outwards: the first that holds it is the innermost
    for (let oj = oi - 1; oj >= 0; oj--) {
      const j = order[oj];
      const o = info[j];
      if (!o.closed || o.volume <= s.volume) continue;
      if (!(o.lo[0] <= s.lo[0] && o.lo[1] <= s.lo[1] && o.lo[2] <= s.lo[2] && o.hi[0] >= s.hi[0] && o.hi[1] >= s.hi[1] && o.hi[2] >= s.hi[2])) continue;
      budget -= o.list.length;
      if (budget < 0) break;
      if (insideShell(probe, o.list, T, P)) {
        parent[i] = j;
        depth[i] = depth[j] + 1;
        break;
      }
    }
  }

  // ---- bodies: each outer shell with the hollows directly inside it
  const bodies: MeshBody[] = [];
  const hollows = new Map<number, number[]>();
  info.forEach((_, i) => {
    if (depth[i] % 2 === 1) hollows.set(parent[i], [...(hollows.get(parent[i]) ?? []), i]);
  });
  for (const i of order) {
    if (depth[i] % 2 === 1) continue;
    const list = [i, ...(hollows.get(i) ?? [])];
    const map = new Map<number, number>();
    const pos: number[] = [];
    const tri: number[] = [];
    const col: number[] = [];
    const starts: number[] = [];
    let volume = info[i].volume;
    list.forEach((si, k) => {
      const s = info[si];
      starts.push(tri.length / 3);
      const inner = k > 0;
      if (inner) {
        report.voids++;
        volume -= s.volume;
      }
      for (const t of s.list) {
        const v = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
        // a hollow faces into itself
        if (inner) [v[1], v[2]] = [v[2], v[1]];
        for (const x of v) {
          let j = map.get(x);
          if (j === undefined) {
            j = pos.length / 3;
            map.set(x, j);
            pos.push(P[x * 3], P[x * 3 + 1], P[x * 3 + 2]);
          }
          tri.push(j);
        }
        col.push(C[t]);
      }
    });
    if (!tri.length) continue;
    const closed = list.every((si) => info[si].closed);
    bodies.push({
      positions: Float64Array.from(pos),
      triangles: Uint32Array.from(tri),
      triColor: hasColor ? Uint16Array.from(col) : undefined,
      shellStarts: starts,
      closed,
      volume: closed ? volume : 0,
    });
  }
  return { bodies, report };
}

/** Whether a point is inside a closed shell: a ray along a slanted direction crosses it an odd number of times. */
export function insideShell(p: P3, list: number[], T: ArrayLike<number>, P: ArrayLike<number>): boolean {
  // an irrational-looking direction misses edges and corners in practice
  const d: P3 = [0.5773502691896258 + 0.0123, 0.5773502691896258 - 0.0071, 0.5773502691896258 + 0.0049];
  let hits = 0;
  for (const t of list) {
    const a: P3 = [P[T[t * 3] * 3], P[T[t * 3] * 3 + 1], P[T[t * 3] * 3 + 2]];
    const b: P3 = [P[T[t * 3 + 1] * 3], P[T[t * 3 + 1] * 3 + 1], P[T[t * 3 + 1] * 3 + 2]];
    const c: P3 = [P[T[t * 3 + 2] * 3], P[T[t * 3 + 2] * 3 + 1], P[T[t * 3 + 2] * 3 + 2]];
    // Möller–Trumbore
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const h = cross(d, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-18) continue;
    const f = 1 / det;
    const s = sub(p, a);
    const u = f * dot(s, h);
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = f * dot(d, q);
    if (v < 0 || u + v > 1) continue;
    if (f * dot(e2, q) > 1e-9) hits++;
  }
  return hits % 2 === 1;
}
