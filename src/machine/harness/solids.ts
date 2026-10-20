// The assembly's solids for the wiring checks: each placed part's mesh in a
// BVH (shared by every placement of the same geometry), queried in the
// assembly's coordinates. Answers how far a point is from the nearest
// surface and which side it is on, ray casts, and whether a box (a plug, a
// board's edge) meets a part. Plain arithmetic: it runs in the cable worker
// and in Node tests.

import { TriBVH } from "../../mfg/bvh";
import type { V3 } from "../../kernel/recipe";

/** What a solid is to the wiring: a made part, a fastener, an electronics module whose holding is checked, or another bought part. */
export type SolidRole = "made" | "fastener" | "mount" | "part";

export interface SolidGeometry {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface SolidPlaced {
  geo: number;
  /** column-major placement */
  m: number[];
  /** the part's id in the model */
  id?: string;
  /** the component instance it belongs to (its main part's id), for leaving a part's own solids out */
  comp?: string;
  role?: SolidRole;
  /** a cover that comes off (lids): plugs can be pulled once it is off */
  removable?: boolean;
}

export interface SolidItem {
  geo: number;
  m: number[];
  inv: number[];
  lo: V3;
  hi: V3;
  id: string;
  comp: string;
  role: SolidRole;
  removable: boolean;
}

/** A hit on the nearest surface: the point, its distance, the item, and whether the query point is inside that solid. */
export interface Nearest {
  d: number;
  at: V3;
  item: number;
  inside: boolean;
}

export type Skip = (item: SolidItem, index: number) => boolean;

export function transform(m: number[], x: number, y: number, z: number): V3 {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

export function transformDir(m: number[], x: number, y: number, z: number): V3 {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/** Inverse of a column-major affine 4×4 (null when singular). */
export function invert(m: number[]): number[] | null {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  if (Math.abs(det) < 1e-12) return null;
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const t = [m[12], m[13], m[14]];
  return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, -(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]), -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]), -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]), 1];
}

/** An oriented box: origin and unit axes, with its extent along each axis from lo to hi. */
export interface OBox {
  o: V3;
  x: V3;
  y: V3;
  z: V3;
  lo: V3;
  hi: V3;
}

export class Solids {
  readonly items: SolidItem[] = [];
  private bvhs: (TriBVH | null)[];
  /** +1 when a geometry's triangles are wound with their normals out, −1 inward, 0 when it is not closed */
  private orient: number[];
  private scratch = new Float64Array(4);
  private nrm = new Float64Array(3);

  constructor(
    private geos: SolidGeometry[],
    placed: SolidPlaced[],
  ) {
    this.bvhs = geos.map(() => null);
    this.orient = geos.map(() => NaN);
    const local = geos.map((g) => {
      const lo: V3 = [Infinity, Infinity, Infinity];
      const hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < g.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], g.positions[i + k]);
          hi[k] = Math.max(hi[k], g.positions[i + k]);
        }
      return [lo, hi] as const;
    });
    placed.forEach((pl, n) => {
      const inv = invert(pl.m);
      const [a, b] = local[pl.geo];
      if (!inv || !Number.isFinite(a[0])) return;
      const lo: V3 = [Infinity, Infinity, Infinity];
      const hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        const p = transform(pl.m, c & 1 ? b[0] : a[0], c & 2 ? b[1] : a[1], c & 4 ? b[2] : a[2]);
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
      }
      const id = pl.id ?? `#${n}`;
      this.items.push({ geo: pl.geo, m: pl.m, inv, lo, hi, id, comp: pl.comp ?? id, role: pl.role ?? "part", removable: !!pl.removable });
    });
  }

  bvh(geo: number): TriBVH {
    let b = this.bvhs[geo];
    if (!b) {
      b = new TriBVH(this.geos[geo].positions, this.geos[geo].indices);
      this.bvhs[geo] = b;
      const v = b.signedVolume();
      this.orient[geo] = Math.abs(v) < 1e-6 ? 0 : Math.sign(v);
    }
    return b;
  }

  /** Items whose box comes within `grow` of the box lo..hi. */
  near(lo: V3, hi: V3, grow = 0, skip?: Skip): number[] {
    const out: number[] = [];
    this.items.forEach((it, i) => {
      if (it.lo[0] > hi[0] + grow || it.hi[0] < lo[0] - grow || it.lo[1] > hi[1] + grow || it.hi[1] < lo[1] - grow || it.lo[2] > hi[2] + grow || it.hi[2] < lo[2] - grow) return;
      if (skip?.(it, i)) return;
      out.push(i);
    });
    return out;
  }

  /** The nearest surface to p within maxD, among the items `skip` lets through. */
  nearest(p: V3, maxD: number, skip?: Skip): Nearest | null {
    let best: Nearest | null = null;
    let limit = maxD;
    for (const i of this.near(p, p, maxD, skip)) {
      const it = this.items[i];
      const bvh = this.bvh(it.geo);
      const q = transform(it.inv, p[0], p[1], p[2]);
      const d = bvh.closest(q[0], q[1], q[2], limit, this.scratch);
      if (!(d < limit)) continue;
      limit = d;
      const at = transform(it.m, this.scratch[0], this.scratch[1], this.scratch[2]);
      best = { d, at, item: i, inside: this.sideInside(it, q, this.scratch, d) };
    }
    return best;
  }

  /** Inside or out, from the nearest triangle's normal (or by counting crossings for an open mesh or a point on an edge). */
  private sideInside(it: SolidItem, q: V3, hit: Float64Array, d: number): boolean {
    const o = this.orient[it.geo];
    const bvh = this.bvh(it.geo);
    if (o && d > 1e-6) {
      bvh.normal(hit[3], this.nrm);
      const s = ((q[0] - hit[0]) * this.nrm[0] + (q[1] - hit[1]) * this.nrm[1] + (q[2] - hit[2]) * this.nrm[2]) * o;
      const len = Math.hypot(this.nrm[0], this.nrm[1], this.nrm[2]) * d;
      // clearly on one side of the face: trust it; near an edge or corner the normal can mislead
      if (len > 0 && Math.abs(s) > 0.5 * len) return s < 0;
    }
    return bvh.contains(q[0], q[1], q[2]);
  }

  /** Whether p is inside item i's solid, by counting crossings. */
  inside(p: V3, i: number): boolean {
    const it = this.items[i];
    if (p[0] < it.lo[0] || p[0] > it.hi[0] || p[1] < it.lo[1] || p[1] > it.hi[1] || p[2] < it.lo[2] || p[2] > it.hi[2]) return false;
    const q = transform(it.inv, p[0], p[1], p[2]);
    return this.bvh(it.geo).contains(q[0], q[1], q[2]);
  }

  /** The first item a ray from o along unit d meets before tmax. */
  raycast(o: V3, d: V3, tmax: number, skip?: Skip, tmin = 0): { t: number; item: number } | null {
    const end: V3 = [o[0] + d[0] * tmax, o[1] + d[1] * tmax, o[2] + d[2] * tmax];
    const lo: V3 = [Math.min(o[0], end[0]), Math.min(o[1], end[1]), Math.min(o[2], end[2])];
    const hi: V3 = [Math.max(o[0], end[0]), Math.max(o[1], end[1]), Math.max(o[2], end[2])];
    let best: { t: number; item: number } | null = null;
    for (const i of this.near(lo, hi, 0, skip)) {
      const it = this.items[i];
      const q = transform(it.inv, o[0], o[1], o[2]);
      const v = transformDir(it.inv, d[0], d[1], d[2]);
      const h = this.bvh(it.geo).raycast(q[0], q[1], q[2], v[0], v[1], v[2], tmin, best ? best.t : tmax);
      if (h) best = { t: h.t, item: i };
    }
    return best;
  }

  /** The items whose surface meets an oriented box. A box wholly inside a solid meets no surface, so a sample point inside counts too. */
  boxHits(b: OBox, skip?: Skip): number[] {
    const corners: V3[] = [];
    for (let c = 0; c < 8; c++) {
      const u = c & 1 ? b.hi[0] : b.lo[0];
      const v = c & 2 ? b.hi[1] : b.lo[1];
      const w = c & 4 ? b.hi[2] : b.lo[2];
      corners.push([b.o[0] + b.x[0] * u + b.y[0] * v + b.z[0] * w, b.o[1] + b.x[1] * u + b.y[1] * v + b.z[1] * w, b.o[2] + b.x[2] * u + b.y[2] * v + b.z[2] * w]);
    }
    const wlo: V3 = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))) as V3;
    const whi: V3 = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k]))) as V3;
    const half: V3 = [(b.hi[0] - b.lo[0]) / 2, (b.hi[1] - b.lo[1]) / 2, (b.hi[2] - b.lo[2]) / 2];
    const mid: V3 = [(b.hi[0] + b.lo[0]) / 2, (b.hi[1] + b.lo[1]) / 2, (b.hi[2] + b.lo[2]) / 2];
    const centre: V3 = [b.o[0] + b.x[0] * mid[0] + b.y[0] * mid[1] + b.z[0] * mid[2], b.o[1] + b.x[1] * mid[0] + b.y[1] * mid[1] + b.z[1] * mid[2], b.o[2] + b.x[2] * mid[0] + b.y[2] * mid[1] + b.z[2] * mid[2]];
    const out: number[] = [];
    for (const i of this.near(wlo, whi, 0, skip)) {
      const it = this.items[i];
      const bvh = this.bvh(it.geo);
      // the box in the part's own frame
      const c = transform(it.inv, centre[0], centre[1], centre[2]);
      const ax = [transformDir(it.inv, ...b.x), transformDir(it.inv, ...b.y), transformDir(it.inv, ...b.z)];
      const llo: V3 = [Infinity, Infinity, Infinity];
      const lhi: V3 = [-Infinity, -Infinity, -Infinity];
      for (const p of corners) {
        const q = transform(it.inv, p[0], p[1], p[2]);
        for (let k = 0; k < 3; k++) {
          llo[k] = Math.min(llo[k], q[k]);
          lhi[k] = Math.max(lhi[k], q[k]);
        }
      }
      let hit = false;
      const T = bvh.tris;
      bvh.trianglesNear(llo, lhi, (tri) => {
        const o = tri * 9;
        const v: V3[] = [0, 3, 6].map((k) => {
          const dx = T[o + k] - c[0],
            dy = T[o + k + 1] - c[1],
            dz = T[o + k + 2] - c[2];
          return [dx * ax[0][0] + dy * ax[0][1] + dz * ax[0][2], dx * ax[1][0] + dy * ax[1][1] + dz * ax[1][2], dx * ax[2][0] + dy * ax[2][1] + dz * ax[2][2]] as V3;
        });
        if (triBoxOverlap(half, v[0], v[1], v[2])) {
          hit = true;
          return true;
        }
      });
      if (hit || bvh.contains(c[0], c[1], c[2])) out.push(i);
    }
    return out;
  }
}

/** Separating-axis test of a triangle (in the box's frame, centred) against a box of half sizes h (Akenine-Möller). */
export function triBoxOverlap(h: V3, a: V3, b: V3, c: V3): boolean {
  const e0: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e1: V3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const e2: V3 = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
  // the box's own axes
  for (let k = 0; k < 3; k++) {
    if (Math.min(a[k], b[k], c[k]) > h[k] || Math.max(a[k], b[k], c[k]) < -h[k]) return false;
  }
  // the triangle's plane
  const n: V3 = [e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]];
  const dPlane = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
  const rPlane = h[0] * Math.abs(n[0]) + h[1] * Math.abs(n[1]) + h[2] * Math.abs(n[2]);
  if (Math.abs(dPlane) > rPlane) return false;
  // the nine edge cross products
  for (const e of [e0, e1, e2]) {
    for (let k = 0; k < 3; k++) {
      // axis = unit_k × e
      const axis: V3 = k === 0 ? [0, -e[2], e[1]] : k === 1 ? [e[2], 0, -e[0]] : [-e[1], e[0], 0];
      const pa = axis[0] * a[0] + axis[1] * a[1] + axis[2] * a[2];
      const pb = axis[0] * b[0] + axis[1] * b[1] + axis[2] * b[2];
      const pc = axis[0] * c[0] + axis[1] * c[1] + axis[2] * c[2];
      const r = h[0] * Math.abs(axis[0]) + h[1] * Math.abs(axis[1]) + h[2] * Math.abs(axis[2]);
      if (Math.min(pa, pb, pc) > r || Math.max(pa, pb, pc) < -r) return false;
    }
  }
  return true;
}
