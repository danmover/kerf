// Simplifies a closed mesh to fewer triangles by collapsing its edges, cheapest
// first, where the cost is how far the surface would move (Garland and
// Heckbert's quadric error). Flat areas lose their extra triangles first and
// curved ones keep their shape; shells stay closed, nothing folds over, and the
// edges between colours stay where they are. Pure TypeScript.

import type { MeshBody } from "./meshRepair";

type P3 = [number, number, number];

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);

/** A binary heap of edge collapses in typed arrays; stale entries are skipped by their stamps. */
class Heap {
  cost = new Float64Array(1024);
  a = new Int32Array(1024);
  b = new Int32Array(1024);
  sa = new Int32Array(1024);
  sb = new Int32Array(1024);
  size = 0;
  private grow() {
    const n = this.cost.length * 2;
    const g = <T extends Float64Array | Int32Array>(x: T): T => {
      const y = new (x.constructor as new (n: number) => T)(n);
      y.set(x);
      return y;
    };
    this.cost = g(this.cost);
    this.a = g(this.a);
    this.b = g(this.b);
    this.sa = g(this.sa);
    this.sb = g(this.sb);
  }
  private swap(i: number, j: number) {
    const c = this.cost[i];
    this.cost[i] = this.cost[j];
    this.cost[j] = c;
    let t = this.a[i];
    this.a[i] = this.a[j];
    this.a[j] = t;
    t = this.b[i];
    this.b[i] = this.b[j];
    this.b[j] = t;
    t = this.sa[i];
    this.sa[i] = this.sa[j];
    this.sa[j] = t;
    t = this.sb[i];
    this.sb[i] = this.sb[j];
    this.sb[j] = t;
  }
  push(cost: number, a: number, b: number, sa: number, sb: number) {
    if (this.size === this.cost.length) this.grow();
    let i = this.size++;
    this.cost[i] = cost;
    this.a[i] = a;
    this.b[i] = b;
    this.sa[i] = sa;
    this.sb[i] = sb;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** index 0 is the cheapest; remove it */
  pop() {
    this.size--;
    if (this.size === 0) return;
    this.swap(0, this.size);
    let i = 0;
    for (;;) {
      const l = i * 2 + 1,
        r = l + 1;
      let m = i;
      if (l < this.size && this.cost[l] < this.cost[m]) m = l;
      if (r < this.size && this.cost[r] < this.cost[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
}

/** Simplify a body to about `target` triangles. */
export function simplifyMesh(body: MeshBody, target: number): MeshBody {
  const P = Float64Array.from(body.positions);
  const T = Int32Array.from(body.triangles);
  const nT = T.length / 3;
  const nV = P.length / 3;
  if (nT <= target) return body;
  const pt = (i: number): P3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const color = (t: number) => (body.triColor ? body.triColor[t] : 0);
  const shellOfTri = new Int32Array(nT);
  for (let s = 0; s < body.shellStarts.length; s++) {
    const end = s + 1 < body.shellStarts.length ? body.shellStarts[s + 1] : nT;
    for (let t = body.shellStarts[s]; t < end; t++) shellOfTri[t] = s;
  }

  // triangles round each corner
  const ring: number[][] = Array.from({ length: nV }, () => []);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) ring[T[t * 3 + k]].push(t);
  const dead = new Uint8Array(nT);
  const gone = new Uint8Array(nV);
  const stamp = new Int32Array(nV);

  // quadrics: 10 numbers per corner (the upper triangle of a symmetric 4×4)
  const Q = new Float64Array(nV * 10);
  const addPlane = (v: number, n: P3, d: number, w: number) => {
    const q = [n[0] * n[0], n[0] * n[1], n[0] * n[2], n[0] * d, n[1] * n[1], n[1] * n[2], n[1] * d, n[2] * n[2], n[2] * d, d * d];
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += q[k] * w;
  };
  const triNormal = (t: number): P3 => {
    const a = pt(T[t * 3]),
      b = pt(T[t * 3 + 1]),
      c = pt(T[t * 3 + 2]);
    return cross(sub(b, a), sub(c, a));
  };
  for (let t = 0; t < nT; t++) {
    const n = triNormal(t);
    const l = len(n);
    if (l <= 0) continue;
    const u: P3 = [n[0] / l, n[1] / l, n[2] / l];
    const d = -dot(u, pt(T[t * 3]));
    for (let k = 0; k < 3; k++) addPlane(T[t * 3 + k], u, d, l / 2);
  }
  // edges between colours hold their line: a plane through the edge, square to the face, with a heavy weight
  if (body.triColor) {
    const seen = new Map<number, number>();
    for (let t = 0; t < nT; t++)
      for (let k = 0; k < 3; k++) {
        const a = T[t * 3 + k],
          b = T[t * 3 + ((k + 1) % 3)];
        const key = Math.min(a, b) * nV + Math.max(a, b);
        const o = seen.get(key);
        if (o === undefined) {
          seen.set(key, t);
          continue;
        }
        if (color(o) === color(t)) continue;
        const e = sub(pt(b), pt(a));
        const n = triNormal(t);
        const side = cross(e, n);
        const l = len(side);
        if (l <= 0) continue;
        const u: P3 = [side[0] / l, side[1] / l, side[2] / l];
        const d = -dot(u, pt(a));
        const w = len(e) * len(e) * 100;
        addPlane(a, u, d, w);
        addPlane(b, u, d, w);
      }
  }

  const qs = new Float64Array(10);
  const best = new Float64Array(3);
  const err = (q: Float64Array, x: number, y: number, z: number) =>
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  /** the best place for the merged corner (left in `best`) and what it costs */
  const plan = (u: number, v: number): number => {
    for (let k = 0; k < 10; k++) qs[k] = Q[u * 10 + k] + Q[v * 10 + k];
    const a = qs[0],
      b = qs[1],
      c = qs[2],
      d = qs[3],
      e = qs[4],
      f = qs[5],
      g = qs[6],
      h = qs[7],
      i = qs[8];
    const ux = P[u * 3],
      uy = P[u * 3 + 1],
      uz = P[u * 3 + 2];
    const vx = P[v * 3],
      vy = P[v * 3 + 1],
      vz = P[v * 3 + 2];
    const mx = (ux + vx) / 2,
      my = (uy + vy) / 2,
      mz = (uz + vz) / 2;
    let cost = err(qs, mx, my, mz);
    best[0] = mx;
    best[1] = my;
    best[2] = mz;
    const cu = err(qs, ux, uy, uz);
    if (cu < cost) {
      cost = cu;
      best[0] = ux;
      best[1] = uy;
      best[2] = uz;
    }
    const cv = err(qs, vx, vy, vz);
    if (cv < cost) {
      cost = cv;
      best[0] = vx;
      best[1] = vy;
      best[2] = vz;
    }
    const det = a * (e * h - f * f) - b * (b * h - f * c) + c * (b * f - e * c);
    const sc = Math.abs(a) + Math.abs(e) + Math.abs(h);
    if (Math.abs(det) > 1e-12 * sc * sc * sc) {
      // the point of least error, from the 3×3 solve
      const i0 = (e * h - f * f) / det,
        i1 = (c * f - b * h) / det,
        i2 = (b * f - c * e) / det,
        i3 = (a * h - c * c) / det,
        i4 = (b * c - a * f) / det,
        i5 = (a * e - b * b) / det;
      const x = -(i0 * d + i1 * g + i2 * i),
        y = -(i1 * d + i3 * g + i4 * i),
        z = -(i2 * d + i4 * g + i5 * i);
      // only near the edge: far off it the solve is fitting noise
      const span2 = (ux - vx) ** 2 + (uy - vy) ** 2 + (uz - vz) ** 2;
      if ((x - mx) ** 2 + (y - my) ** 2 + (z - mz) ** 2 <= span2 * 4) {
        const cx = err(qs, x, y, z);
        if (cx < cost) {
          cost = cx;
          best[0] = x;
          best[1] = y;
          best[2] = z;
        }
      }
    }
    return Math.max(0, cost);
  };

  const heap = new Heap();
  const pushEdge = (u: number, v: number) => heap.push(plan(u, v), u, v, stamp[u], stamp[v]);
  {
    const seen = new Set<number>();
    for (let t = 0; t < nT; t++)
      for (let k = 0; k < 3; k++) {
        const a = T[t * 3 + k],
          b = T[t * 3 + ((k + 1) % 3)];
        const key = Math.min(a, b) * nV + Math.max(a, b);
        if (seen.has(key)) continue;
        seen.add(key);
        pushEdge(Math.min(a, b), Math.max(a, b));
      }
  }

  const mark = new Int32Array(nV);
  let tag = 0;
  /** the corners joined to v by an edge */
  const neighbours = (v: number, out: number[]) => {
    out.length = 0;
    const own = ++tag;
    for (const t of ring[v]) {
      if (dead[t]) continue;
      for (let k = 0; k < 3; k++) {
        const x = T[t * 3 + k];
        if (x === v || mark[x] === own) continue;
        mark[x] = own;
        out.push(x);
      }
    }
    return out;
  };
  const nu: number[] = [];
  const nv: number[] = [];
  let alive = nT;
  let guard = 0;
  while (alive > target && heap.size > 0 && guard++ < nT * 8) {
    const u = heap.a[0],
      v = heap.b[0];
    const fresh = !gone[u] && !gone[v] && heap.sa[0] === stamp[u] && heap.sb[0] === stamp[v];
    heap.pop();
    if (!fresh) continue;
    // the edge's triangles, and the corners across from it
    const shared: number[] = [];
    for (const t of ring[u]) if (!dead[t] && (T[t * 3] === v || T[t * 3 + 1] === v || T[t * 3 + 2] === v)) shared.push(t);
    if (shared.length !== 2) continue;
    // link condition: the corners both ends see are exactly the two across the edge, or the shell would pinch
    neighbours(u, nu);
    neighbours(v, nv);
    let common = 0;
    for (const x of nv) if (nu.includes(x)) common++;
    if (common !== 2) continue;
    plan(u, v);
    const x: P3 = [best[0], best[1], best[2]];
    // nothing round either end may fold over or collapse to a sliver
    let ok = true;
    for (let side = 0; side < 2 && ok; side++) {
      const w = side ? v : u;
      for (const t of ring[w]) {
        if (dead[t] || t === shared[0] || t === shared[1]) continue;
        // the triangle's corners, with w moved to x
        let k = 0;
        while (T[t * 3 + k] !== w) k++;
        const i1 = T[t * 3 + ((k + 1) % 3)],
          i2 = T[t * 3 + ((k + 2) % 3)];
        const wx = P[w * 3],
          wy = P[w * 3 + 1],
          wz = P[w * 3 + 2];
        const ax = P[i1 * 3],
          ay = P[i1 * 3 + 1],
          az = P[i1 * 3 + 2];
        const bx = P[i2 * 3],
          by = P[i2 * 3 + 1],
          bz = P[i2 * 3 + 2];
        // normal before: (a - w) × (b - w); after: (a - x) × (b - x)
        const e1x = ax - wx,
          e1y = ay - wy,
          e1z = az - wz,
          e2x = bx - wx,
          e2y = by - wy,
          e2z = bz - wz;
        const n0x = e1y * e2z - e1z * e2y,
          n0y = e1z * e2x - e1x * e2z,
          n0z = e1x * e2y - e1y * e2x;
        const f1x = ax - x[0],
          f1y = ay - x[1],
          f1z = az - x[2],
          f2x = bx - x[0],
          f2y = by - x[1],
          f2z = bz - x[2];
        const n1x = f1y * f2z - f1z * f2y,
          n1y = f1z * f2x - f1x * f2z,
          n1z = f1x * f2y - f1y * f2x;
        const lb = Math.hypot(n0x, n0y, n0z),
          la = Math.hypot(n1x, n1y, n1z);
        if (la <= lb * 1e-3 || n0x * n1x + n0y * n1y + n0z * n1z < 0.25 * lb * la) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    // collapse v into u
    for (const t of shared) {
      dead[t] = 1;
      alive--;
    }
    for (const t of ring[v]) {
      if (dead[t]) continue;
      for (let k = 0; k < 3; k++) if (T[t * 3 + k] === v) T[t * 3 + k] = u;
      ring[u].push(t);
    }
    ring[v] = [];
    ring[u] = ring[u].filter((t) => !dead[t]);
    gone[v] = 1;
    P[u * 3] = x[0];
    P[u * 3 + 1] = x[1];
    P[u * 3 + 2] = x[2];
    for (let k = 0; k < 10; k++) Q[u * 10 + k] += Q[v * 10 + k];
    stamp[u]++;
    for (const w of neighbours(u, nu)) pushEdge(Math.min(u, w), Math.max(u, w));
    // the heap fills with stale entries; drop them now and then
    if (heap.size > nT * 4) compact(heap, stamp, gone);
  }

  // ---- compact, keeping shells in order
  const map = new Int32Array(nV).fill(-1);
  const pos: number[] = [];
  const tri: number[] = [];
  const col: number[] = [];
  const starts: number[] = [];
  for (let s = 0; s < body.shellStarts.length; s++) {
    starts.push(tri.length / 3);
    for (let t = 0; t < nT; t++) {
      if (dead[t] || shellOfTri[t] !== s) continue;
      for (let k = 0; k < 3; k++) {
        const v = T[t * 3 + k];
        if (map[v] < 0) {
          map[v] = pos.length / 3;
          pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
        }
        tri.push(map[v]);
      }
      col.push(color(t));
    }
  }
  return {
    positions: Float64Array.from(pos),
    triangles: Uint32Array.from(tri),
    triColor: body.triColor ? Uint16Array.from(col) : undefined,
    shellStarts: starts,
    closed: body.closed,
    volume: body.volume,
  };
}

function compact(h: Heap, stamp: Int32Array, gone: Uint8Array) {
  const keep: number[] = [];
  for (let i = 0; i < h.size; i++) if (!gone[h.a[i]] && !gone[h.b[i]] && h.sa[i] === stamp[h.a[i]] && h.sb[i] === stamp[h.b[i]]) keep.push(i);
  const items = keep.map((i) => [h.cost[i], h.a[i], h.b[i], h.sa[i], h.sb[i]] as const);
  h.size = 0;
  for (const [c, a, b, sa, sb] of items) h.push(c, a, b, sa, sb);
}
