// A part's triangles cut across at a height: the outline of its material there, as an area. The mesh is turned
// so the tool comes down -Z (from above), its corners welded where faces meet, and each cut walks from triangle to
// triangle by the edges they share, so the loops close exactly. Flat faces facing the tool are the floors a
// pocket stops on.

import { fromLoops, type Loop, type Region } from "./clip";

export interface CamMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

type V3 = [number, number, number];

/** Rows of a rotation that turns `dir` (the way the tool comes from) to +Z, keeping +X as X where it can. */
export function setupRotation(dir: V3): number[] {
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const z: V3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  // x: the part's X square to z (or its Y when z lies along X)
  const seed: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = seed[0] * z[0] + seed[1] * z[1] + seed[2] * z[2];
  let x: V3 = [seed[0] - d * z[0], seed[1] - d * z[1], seed[2] - d * z[2]];
  const lx = Math.hypot(x[0], x[1], x[2]);
  x = [x[0] / lx, x[1] / lx, x[2] / lx];
  const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [...x, ...y, ...z];
}

export class Slicer {
  /** welded corners, turned: x, y, z */
  readonly v: Float64Array;
  /** triangles by welded corner */
  readonly t: Uint32Array;
  readonly lo: V3;
  readonly hi: V3;
  private cache = new Map<number, Region>();
  /** triangle index ranges sorted by their lowest corner, for cuts that only look at the triangles they cross */
  private byLow: Uint32Array;
  private lowZ: Float64Array;
  private highZ: Float64Array;
  /** whether the cuts left loops open (the mesh is not closed), counted */
  open = 0;

  constructor(mesh: CamMesh, rot: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]) {
    const p = mesh.positions;
    const weld = new Map<string, number>();
    const map = new Uint32Array(p.length / 3);
    const pts: number[] = [];
    for (let i = 0; i < p.length / 3; i++) {
      const x = p[3 * i],
        y = p[3 * i + 1],
        z = p[3 * i + 2];
      const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      let k = weld.get(key);
      if (k === undefined) {
        k = pts.length / 3;
        weld.set(key, k);
        pts.push(rot[0] * x + rot[1] * y + rot[2] * z, rot[3] * x + rot[4] * y + rot[5] * z, rot[6] * x + rot[7] * y + rot[8] * z);
      }
      map[i] = k;
    }
    this.v = new Float64Array(pts);
    const tri: number[] = [];
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const a = map[mesh.indices[i]],
        b = map[mesh.indices[i + 1]],
        c = map[mesh.indices[i + 2]];
      if (a !== b && b !== c && a !== c) tri.push(a, b, c);
    }
    this.t = new Uint32Array(tri);
    const lo: V3 = [Infinity, Infinity, Infinity],
      hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.v.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], this.v[i + k]);
        hi[k] = Math.max(hi[k], this.v[i + k]);
      }
    this.lo = lo;
    this.hi = hi;
    const n = this.t.length / 3;
    this.lowZ = new Float64Array(n);
    this.highZ = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      const za = this.v[3 * this.t[3 * f] + 2],
        zb = this.v[3 * this.t[3 * f + 1] + 2],
        zc = this.v[3 * this.t[3 * f + 2] + 2];
      this.lowZ[f] = Math.min(za, zb, zc);
      this.highZ[f] = Math.max(za, zb, zc);
    }
    this.byLow = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => this.lowZ[a] - this.lowZ[b]);
  }

  /** Flat areas facing the tool (normals up), by height: where pockets and steps stop. */
  floors(minArea = 0.5): { z: number; area: number }[] {
    const by = new Map<number, number>();
    const { v, t } = this;
    for (let f = 0; f < t.length; f += 3) {
      const a = 3 * t[f],
        b = 3 * t[f + 1],
        c = 3 * t[f + 2];
      const ux = v[b] - v[a],
        uy = v[b + 1] - v[a + 1],
        uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a],
        wy = v[c + 1] - v[a + 1],
        wz = v[c + 2] - v[a + 2];
      const nx = uy * wz - uz * wy,
        ny = uz * wx - ux * wz,
        nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12 || nz / len < 0.9995) continue;
      const z = Math.round(((v[a + 2] + v[b + 2] + v[c + 2]) / 3) * 1000) / 1000;
      by.set(z, (by.get(z) ?? 0) + len / 2);
    }
    return [...by]
      .filter(([, a]) => a >= minArea)
      .map(([z, area]) => ({ z, area }))
      .sort((a, b) => b.z - a.z);
  }

  /** The part's material just above height z, as an area. */
  section(z: number): Region {
    const key = Math.round(z * 1e4) / 1e4;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const r = fromLoops(this.loops(key + 0.0013));
    this.cache.set(key, r);
    return r;
  }

  private loops(z0: number): Loop[] {
    const { v, t } = this;
    // each crossing edge (by its two corners) and the two cut points on it, joined triangle by triangle
    const next = new Map<string, string[]>();
    const point = new Map<string, [number, number]>();
    const cut = (i: number, j: number): string => {
      const a = Math.min(i, j),
        b = Math.max(i, j);
      const key = `${a}_${b}`;
      if (!point.has(key)) {
        const za = v[3 * a + 2],
          zb = v[3 * b + 2];
        const s = (z0 - za) / (zb - za);
        point.set(key, [v[3 * a] + s * (v[3 * b] - v[3 * a]), v[3 * a + 1] + s * (v[3 * b + 1] - v[3 * a + 1])]);
      }
      return key;
    };
    const link = (a: string, b: string) => {
      (next.get(a) ?? next.set(a, []).get(a)!).push(b);
      (next.get(b) ?? next.set(b, []).get(b)!).push(a);
    };
    // triangles whose lowest corner is below z0
    let hiIdx = this.byLow.length;
    {
      let l = 0,
        h = this.byLow.length;
      while (l < h) {
        const m = (l + h) >> 1;
        if (this.lowZ[this.byLow[m]] < z0) l = m + 1;
        else h = m;
      }
      hiIdx = l;
    }
    for (let k = 0; k < hiIdx; k++) {
      const f = this.byLow[k];
      if (this.highZ[f] < z0) continue;
      const ids = [t[3 * f], t[3 * f + 1], t[3 * f + 2]];
      const up = ids.map((i) => v[3 * i + 2] >= z0);
      const n = up.filter(Boolean).length;
      if (n === 0 || n === 3) continue;
      const edges: string[] = [];
      for (let e = 0; e < 3; e++) {
        const i = ids[e],
          j = ids[(e + 1) % 3];
        if (up[e] !== up[(e + 1) % 3]) edges.push(cut(i, j));
      }
      if (edges.length === 2) link(edges[0], edges[1]);
    }
    const loops: Loop[] = [];
    const seen = new Set<string>();
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const loop: Loop = [];
      let prev = "",
        cur = start,
        closed = false;
      while (!seen.has(cur)) {
        seen.add(cur);
        loop.push(point.get(cur)!);
        const ns = next.get(cur)!;
        const nxt = ns.find((x) => x !== prev && !seen.has(x)) ?? ns.find((x) => x !== prev);
        if (nxt === undefined) break;
        if (nxt === start) {
          closed = true;
          break;
        }
        prev = cur;
        cur = nxt;
      }
      if (!closed) this.open++;
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }
}
