// Bounding-volume hierarchy over a triangle mesh for fast ray casts: wall
// thickness, gap widths and reachability are all measured by shooting rays.
// The interference check also asks two of them whether their meshes come close.

export interface Hit {
  t: number;
  tri: number;
}

export class TriBVH {
  readonly tris: Float64Array; // 9 per triangle
  readonly count: number;
  private order: Uint32Array;
  private bounds: Float64Array; // 6 per node
  private left: Int32Array; // child index, or -1 for leaves
  private right: Int32Array;
  private start: Uint32Array;
  private len: Uint32Array;
  private nodes = 0;
  private stack = new Int32Array(128);
  private q = new Float64Array(3);

  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    const n = Math.floor(indices.length / 3);
    this.count = n;
    this.tris = new Float64Array(n * 9);
    const cent = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = indices[i * 3 + k] * 3;
        this.tris[i * 9 + k * 3] = positions[v];
        this.tris[i * 9 + k * 3 + 1] = positions[v + 1];
        this.tris[i * 9 + k * 3 + 2] = positions[v + 2];
      }
      for (let a = 0; a < 3; a++) cent[i * 3 + a] = (this.tris[i * 9 + a] + this.tris[i * 9 + 3 + a] + this.tris[i * 9 + 6 + a]) / 3;
    }
    const maxNodes = Math.max(1, 2 * n);
    this.order = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    this.bounds = new Float64Array(maxNodes * 6);
    this.left = new Int32Array(maxNodes);
    this.right = new Int32Array(maxNodes);
    this.start = new Uint32Array(maxNodes);
    this.len = new Uint32Array(maxNodes);
    if (n) this.build(0, n, cent, 0);
  }

  private build(lo: number, hi: number, cent: Float64Array, depth: number): number {
    const node = this.nodes++;
    const b = this.bounds;
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity;
    let cx0 = Infinity,
      cy0 = Infinity,
      cz0 = Infinity,
      cx1 = -Infinity,
      cy1 = -Infinity,
      cz1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const t = this.order[i];
      for (let k = 0; k < 3; k++) {
        const x = this.tris[t * 9 + k * 3],
          y = this.tris[t * 9 + k * 3 + 1],
          z = this.tris[t * 9 + k * 3 + 2];
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (z < z0) z0 = z;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        if (z > z1) z1 = z;
      }
      const cx = cent[t * 3],
        cy = cent[t * 3 + 1],
        cz = cent[t * 3 + 2];
      if (cx < cx0) cx0 = cx;
      if (cy < cy0) cy0 = cy;
      if (cz < cz0) cz0 = cz;
      if (cx > cx1) cx1 = cx;
      if (cy > cy1) cy1 = cy;
      if (cz > cz1) cz1 = cz;
    }
    b[node * 6] = x0;
    b[node * 6 + 1] = y0;
    b[node * 6 + 2] = z0;
    b[node * 6 + 3] = x1;
    b[node * 6 + 4] = y1;
    b[node * 6 + 5] = z1;
    const count = hi - lo;
    const ex = cx1 - cx0,
      ey = cy1 - cy0,
      ez = cz1 - cz0;
    if (count <= 4 || depth > 60 || Math.max(ex, ey, ez) < 1e-9) {
      this.left[node] = -1;
      this.start[node] = lo;
      this.len[node] = count;
      return node;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = (axis === 0 ? cx0 + cx1 : axis === 1 ? cy0 + cy1 : cz0 + cz1) / 2;
    // partition around the midpoint of the centroid bounds
    let i = lo;
    let j = hi - 1;
    while (i <= j) {
      if (cent[this.order[i] * 3 + axis] < mid) i++;
      else {
        const tmp = this.order[i];
        this.order[i] = this.order[j];
        this.order[j] = tmp;
        j--;
      }
    }
    let split = i;
    if (split === lo || split === hi) split = (lo + hi) >> 1;
    this.left[node] = this.build(lo, split, cent, depth + 1);
    this.right[node] = this.build(split, hi, cent, depth + 1);
    return node;
  }

  /** Nearest hit along o + t·d for t in (tmin, tmax). Triangles are two-sided. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, tmax: number, skip = -1, any = false): Hit | null {
    if (!this.count) return null;
    const ix = 1 / dx,
      iy = 1 / dy,
      iz = 1 / dz;
    let best = tmax;
    let bestTri = -1;
    let sp = 0;
    const stack = this.stack;
    stack[sp++] = 0;
    const b = this.bounds;
    const T = this.tris;
    while (sp) {
      const node = stack[--sp];
      // slab test
      let t0 = tmin,
        t1 = best;
      let a = (b[node * 6] - ox) * ix,
        c = (b[node * 6 + 3] - ox) * ix;
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) continue;
      a = (b[node * 6 + 1] - oy) * iy;
      c = (b[node * 6 + 4] - oy) * iy;
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) continue;
      a = (b[node * 6 + 2] - oz) * iz;
      c = (b[node * 6 + 5] - oz) * iz;
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) continue;
      if (this.left[node] < 0) {
        const s = this.start[node];
        const e = s + this.len[node];
        for (let k = s; k < e; k++) {
          const tri = this.order[k];
          if (tri === skip) continue;
          const p = tri * 9;
          const e1x = T[p + 3] - T[p],
            e1y = T[p + 4] - T[p + 1],
            e1z = T[p + 5] - T[p + 2];
          const e2x = T[p + 6] - T[p],
            e2y = T[p + 7] - T[p + 1],
            e2z = T[p + 8] - T[p + 2];
          const px = dy * e2z - dz * e2y,
            py = dz * e2x - dx * e2z,
            pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-14) continue;
          const inv = 1 / det;
          const sx = ox - T[p],
            sy = oy - T[p + 1],
            sz = oz - T[p + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < -1e-9 || u > 1 + 1e-9) continue;
          const qx = sy * e1z - sz * e1y,
            qy = sz * e1x - sx * e1z,
            qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < -1e-9 || u + v > 1 + 1e-9) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > tmin && t < best) {
            best = t;
            bestTri = tri;
            if (any) return { t, tri };
          }
        }
      } else {
        if (sp + 2 > stack.length) {
          const bigger = new Int32Array(stack.length * 2);
          bigger.set(stack);
          this.stack = bigger;
          return this.raycast(ox, oy, oz, dx, dy, dz, tmin, tmax, skip, any);
        }
        stack[sp++] = this.left[node];
        stack[sp++] = this.right[node];
      }
    }
    return bestTri >= 0 ? { t: best, tri: bestTri } : null;
  }

  /** Distance from a point to the nearest triangle (optionally only triangles keep() accepts), up to maxDist. */
  nearest(x: number, y: number, z: number, maxDist = Infinity, keep?: (tri: number) => boolean): number {
    if (!this.count) return Infinity;
    let best2 = maxDist * maxDist;
    let sp = 0;
    let stack = this.stack;
    stack[sp++] = 0;
    const b = this.bounds;
    while (sp) {
      const node = stack[--sp];
      const dx = Math.max(b[node * 6] - x, 0, x - b[node * 6 + 3]);
      const dy = Math.max(b[node * 6 + 1] - y, 0, y - b[node * 6 + 4]);
      const dz = Math.max(b[node * 6 + 2] - z, 0, z - b[node * 6 + 5]);
      if (dx * dx + dy * dy + dz * dz >= best2) continue;
      if (this.left[node] < 0) {
        const s = this.start[node];
        const e = s + this.len[node];
        for (let k = s; k < e; k++) {
          const tri = this.order[k];
          if (keep && !keep(tri)) continue;
          const d2 = pointTriDist2(this.tris, tri * 9, x, y, z);
          if (d2 < best2) best2 = d2;
        }
      } else {
        if (sp + 2 > stack.length) {
          const bigger = new Int32Array(stack.length * 2);
          bigger.set(stack);
          this.stack = stack = bigger;
        }
        stack[sp++] = this.left[node];
        stack[sp++] = this.right[node];
      }
    }
    return Math.sqrt(best2);
  }

  /**
   * The nearest point on the mesh to (x, y, z), up to maxDist: its distance, with the point
   * written to out[0..2] and the triangle to out[3]. Infinity (out untouched) when none is that close.
   */
  closest(x: number, y: number, z: number, maxDist: number, out: Float64Array): number {
    if (!this.count) return Infinity;
    let best2 = maxDist * maxDist;
    let bestTri = -1;
    let sp = 0;
    let stack = this.stack;
    stack[sp++] = 0;
    const b = this.bounds;
    const q = this.q;
    while (sp) {
      const node = stack[--sp];
      const dx = Math.max(b[node * 6] - x, 0, x - b[node * 6 + 3]);
      const dy = Math.max(b[node * 6 + 1] - y, 0, y - b[node * 6 + 4]);
      const dz = Math.max(b[node * 6 + 2] - z, 0, z - b[node * 6 + 5]);
      if (dx * dx + dy * dy + dz * dz >= best2) continue;
      if (this.left[node] < 0) {
        const s = this.start[node];
        const e = s + this.len[node];
        for (let k = s; k < e; k++) {
          const tri = this.order[k];
          closestOnTri(this.tris, tri * 9, x, y, z, q);
          const d2 = (q[0] - x) ** 2 + (q[1] - y) ** 2 + (q[2] - z) ** 2;
          if (d2 < best2) {
            best2 = d2;
            bestTri = tri;
            out[0] = q[0];
            out[1] = q[1];
            out[2] = q[2];
          }
        }
      } else {
        if (sp + 2 > stack.length) {
          const bigger = new Int32Array(stack.length * 2);
          bigger.set(stack);
          this.stack = stack = bigger;
        }
        stack[sp++] = this.left[node];
        stack[sp++] = this.right[node];
      }
    }
    if (bestTri < 0) return Infinity;
    out[3] = bestTri;
    return Math.sqrt(best2);
  }

  /** The (unnormalised) winding normal of triangle `tri`: outward on a closed mesh wound counter-clockwise. */
  normal(tri: number, out: Float64Array) {
    const T = this.tris;
    const o = tri * 9;
    const ax = T[o + 3] - T[o],
      ay = T[o + 4] - T[o + 1],
      az = T[o + 5] - T[o + 2];
    const bx = T[o + 6] - T[o],
      by = T[o + 7] - T[o + 1],
      bz = T[o + 8] - T[o + 2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
  }

  /** Signed volume enclosed by the triangles: positive when they are wound with their normals out. */
  signedVolume(): number {
    const T = this.tris;
    let v = 0;
    for (let o = 0; o < T.length; o += 9) v += T[o] * (T[o + 4] * T[o + 8] - T[o + 5] * T[o + 7]) - T[o + 1] * (T[o + 3] * T[o + 8] - T[o + 5] * T[o + 6]) + T[o + 2] * (T[o + 3] * T[o + 7] - T[o + 4] * T[o + 6]);
    return v / 6;
  }

  /** Calls `fn` for every triangle whose bounds meet the box lo..hi (the caller tests the triangle itself). */
  trianglesNear(lo: readonly number[], hi: readonly number[], fn: (tri: number) => boolean | void) {
    if (!this.count) return;
    const b = this.bounds;
    const T = this.tris;
    const stack: number[] = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (b[node * 6] > hi[0] || b[node * 6 + 3] < lo[0] || b[node * 6 + 1] > hi[1] || b[node * 6 + 4] < lo[1] || b[node * 6 + 2] > hi[2] || b[node * 6 + 5] < lo[2]) continue;
      if (this.left[node] >= 0) {
        stack.push(this.left[node], this.right[node]);
        continue;
      }
      for (let s = this.start[node], e = s + this.len[node]; s < e; s++) {
        const tri = this.order[s];
        const o = tri * 9;
        if (Math.min(T[o], T[o + 3], T[o + 6]) > hi[0] || Math.max(T[o], T[o + 3], T[o + 6]) < lo[0]) continue;
        if (Math.min(T[o + 1], T[o + 4], T[o + 7]) > hi[1] || Math.max(T[o + 1], T[o + 4], T[o + 7]) < lo[1]) continue;
        if (Math.min(T[o + 2], T[o + 5], T[o + 8]) > hi[2] || Math.max(T[o + 2], T[o + 5], T[o + 8]) < lo[2]) continue;
        if (fn(tri) === true) return;
      }
    }
  }

  /** Whether any triangle of this mesh comes within `gap` of a triangle of `other` (both in the same frame). */
  near(other: TriBVH, gap: number): boolean {
    if (!this.count || !other.count) return false;
    const A = this.bounds;
    const B = other.bounds;
    const g2 = gap * gap;
    // pairs of nodes, one from each tree, whose boxes come within the gap
    const stack: number[] = [0, 0];
    while (stack.length) {
      const j = stack.pop()!;
      const i = stack.pop()!;
      let d2 = 0;
      for (let k = 0; k < 3; k++) {
        const d = Math.max(0, A[i * 6 + k] - B[j * 6 + 3 + k], B[j * 6 + k] - A[i * 6 + 3 + k]);
        d2 += d * d;
      }
      if (d2 > g2) continue;
      const leafA = this.left[i] < 0;
      const leafB = other.left[j] < 0;
      if (leafA && leafB) {
        for (let s = this.start[i], e = s + this.len[i]; s < e; s++)
          for (let t = other.start[j], f = t + other.len[j]; t < f; t++) if (trianglesWithin(this.tris, this.order[s] * 9, other.tris, other.order[t] * 9, gap)) return true;
      } else if (leafB || (!leafA && boxSize(A, i) >= boxSize(B, j))) {
        // open the bigger box
        stack.push(this.left[i], j, this.right[i], j);
      } else {
        stack.push(i, other.left[j], i, other.right[j]);
      }
    }
    return false;
  }

  /**
   * Calls `fn` with each pair of triangles, one from this mesh and one from `other`, that come within `gap` of each
   * other (both in the same frame), until it returns true.
   */
  pairsWithin(other: TriBVH, gap: number, fn: (mine: number, theirs: number) => boolean | void): void {
    if (!this.count || !other.count) return;
    const A = this.bounds;
    const B = other.bounds;
    const g2 = gap * gap;
    const stack: number[] = [0, 0];
    while (stack.length) {
      const j = stack.pop()!;
      const i = stack.pop()!;
      let d2 = 0;
      for (let k = 0; k < 3; k++) {
        const d = Math.max(0, A[i * 6 + k] - B[j * 6 + 3 + k], B[j * 6 + k] - A[i * 6 + 3 + k]);
        d2 += d * d;
      }
      if (d2 > g2) continue;
      const leafA = this.left[i] < 0;
      const leafB = other.left[j] < 0;
      if (leafA && leafB) {
        for (let s = this.start[i], e = s + this.len[i]; s < e; s++)
          for (let t = other.start[j], f = t + other.len[j]; t < f; t++) {
            const ta = this.order[s];
            const tb = other.order[t];
            if (trianglesWithin(this.tris, ta * 9, other.tris, tb * 9, gap) && fn(ta, tb) === true) return;
          }
      } else if (leafB || (!leafA && boxSize(A, i) >= boxSize(B, j))) {
        stack.push(this.left[i], j, this.right[i], j);
      } else {
        stack.push(i, other.left[j], i, other.right[j]);
      }
    }
  }

  /** Inside test by counting crossings along a skew ray (in direction d). */
  contains(x: number, y: number, z: number, d: readonly number[] = [0.5773, 0.5774, 0.5772]): boolean {
    let crossings = 0;
    let t = 0;
    for (let guard = 0; guard < 64; guard++) {
      const h = this.raycast(x, y, z, d[0], d[1], d[2], t + 1e-7, Infinity);
      if (!h) break;
      crossings++;
      t = h.t;
    }
    return crossings % 2 === 1;
  }
}

/** Squared distance from p to the triangle stored at T[o..o+9] (closest-point method from Ericson, Real-Time Collision Detection). */
export function pointTriDist2(T: ArrayLike<number>, o: number, px: number, py: number, pz: number): number {
  const ax = T[o],
    ay = T[o + 1],
    az = T[o + 2];
  const bx = T[o + 3],
    by = T[o + 4],
    bz = T[o + 5];
  const cx = T[o + 6],
    cy = T[o + 7],
    cz = T[o + 8];
  const abx = bx - ax,
    aby = by - ay,
    abz = bz - az;
  const acx = cx - ax,
    acy = cy - ay,
    acz = cz - az;
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const sq = (x: number, y: number, z: number) => x * x + y * y + z * z;
  if (d1 <= 0 && d2 <= 0) return sq(apx, apy, apz);
  const bpx = px - bx,
    bpy = py - by,
    bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return sq(bpx, bpy, bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return sq(apx - v * abx, apy - v * aby, apz - v * abz);
  }
  const cpx = px - cx,
    cpy = py - cy,
    cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return sq(cpx, cpy, cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return sq(apx - w * acx, apy - w * acy, apz - w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return sq(bpx - w * (cx - bx), bpy - w * (cy - by), bpz - w * (cz - bz));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return sq(apx - abx * v - acx * w, apy - aby * v - acy * w, apz - abz * v - acz * w);
}

/** The point of the triangle at T[o..o+9] nearest to p, into out (the same regions as pointTriDist2). */
export function closestOnTri(T: ArrayLike<number>, o: number, px: number, py: number, pz: number, out: Float64Array) {
  const ax = T[o],
    ay = T[o + 1],
    az = T[o + 2];
  const abx = T[o + 3] - ax,
    aby = T[o + 4] - ay,
    abz = T[o + 5] - az;
  const acx = T[o + 6] - ax,
    acy = T[o + 7] - ay,
    acz = T[o + 8] - az;
  const set = (u: number, v: number) => {
    out[0] = ax + abx * u + acx * v;
    out[1] = ay + aby * u + acy * v;
    out[2] = az + abz * u + acz * v;
  };
  const apx = px - ax,
    apy = py - ay,
    apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(0, 0);
  const bpx = px - T[o + 3],
    bpy = py - T[o + 4],
    bpz = pz - T[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(d1 / (d1 - d3), 0);
  const cpx = px - T[o + 6],
    cpy = py - T[o + 7],
    cpz = pz - T[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return set(1 - w, w);
  }
  const denom = 1 / (va + vb + vc);
  set(vb * denom, vc * denom);
}

/** Sum of a node box's sides, to choose which of two boxes to open first. */
function boxSize(b: Float64Array, n: number): number {
  return b[n * 6 + 3] - b[n * 6] + (b[n * 6 + 4] - b[n * 6 + 1]) + (b[n * 6 + 5] - b[n * 6 + 2]);
}

/**
 * Whether triangles T[o..o+9] and U[p..p+9] come within `gap` of each other.
 * Apart, the closest points are a corner and a face or two edges; touching or
 * crossing, an edge of one meets the other or two edges meet.
 */
export function trianglesWithin(T: ArrayLike<number>, o: number, U: ArrayLike<number>, p: number, gap: number): boolean {
  // boxes first: most pairs that get here are still apart
  for (let k = 0; k < 3; k++) {
    const t0 = Math.min(T[o + k], T[o + 3 + k], T[o + 6 + k]);
    const t1 = Math.max(T[o + k], T[o + 3 + k], T[o + 6 + k]);
    const u0 = Math.min(U[p + k], U[p + 3 + k], U[p + 6 + k]);
    const u1 = Math.max(U[p + k], U[p + 3 + k], U[p + 6 + k]);
    if (u0 - t1 > gap || t0 - u1 > gap) return false;
  }
  const g2 = gap * gap;
  for (let c = 0; c < 9; c += 3) {
    if (pointTriDist2(U, p, T[o + c], T[o + c + 1], T[o + c + 2]) <= g2) return true;
    if (pointTriDist2(T, o, U[p + c], U[p + c + 1], U[p + c + 2]) <= g2) return true;
  }
  for (let a = 0; a < 9; a += 3) {
    const a2 = (a + 3) % 9;
    for (let b = 0; b < 9; b += 3) if (segmentDist2(T, o + a, o + a2, U, p + b, p + (b + 3) % 9) <= g2) return true;
    if (segmentCrosses(T, o + a, o + a2, U, p) || segmentCrosses(U, p + a, p + a2, T, o)) return true;
  }
  return false;
}

/** Squared distance between segments S[i]→S[j] and R[k]→R[l] (Ericson, Real-Time Collision Detection 5.1.9). */
function segmentDist2(S: ArrayLike<number>, i: number, j: number, R: ArrayLike<number>, k: number, l: number): number {
  const d1x = S[j] - S[i],
    d1y = S[j + 1] - S[i + 1],
    d1z = S[j + 2] - S[i + 2];
  const d2x = R[l] - R[k],
    d2y = R[l + 1] - R[k + 1],
    d2z = R[l + 2] - R[k + 2];
  const rx = S[i] - R[k],
    ry = S[i + 1] - R[k + 1],
    rz = S[i + 2] - R[k + 2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  let s = 0;
  let t = 0;
  if (a <= 1e-18 && e <= 1e-18) {
    // both are points
  } else if (a <= 1e-18) {
    t = clamp(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-18) s = clamp(-c / a);
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 0 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const x = rx + d1x * s - d2x * t,
    y = ry + d1y * s - d2y * t,
    z = rz + d1z * s - d2z * t;
  return x * x + y * y + z * z;
}

/** Whether segment S[i]→S[j] passes through triangle T[o..o+9] (Möller–Trumbore, limited to the segment). */
function segmentCrosses(S: ArrayLike<number>, i: number, j: number, T: ArrayLike<number>, o: number): boolean {
  const dx = S[j] - S[i],
    dy = S[j + 1] - S[i + 1],
    dz = S[j + 2] - S[i + 2];
  const e1x = T[o + 3] - T[o],
    e1y = T[o + 4] - T[o + 1],
    e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o],
    e2y = T[o + 7] - T[o + 1],
    e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y,
    py = dz * e2x - dx * e2z,
    pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  // parallel: any contact is edge on edge or corner on face, which the distance tests catch
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  const sx = S[i] - T[o],
    sy = S[i + 1] - T[o + 1],
    sz = S[i + 2] - T[o + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y,
    qy = sz * e1x - sx * e1z,
    qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 && t <= 1;
}
