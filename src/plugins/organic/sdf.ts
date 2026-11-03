// The signed distance field of an organic model: negative inside, positive
// outside, roughly the distance to the surface. Shapes join with a smooth
// minimum so a head flows into a neck; the colour at a point is the colour of
// whichever shape is outermost there, then any paint over it. Formulas for the
// primitives follow Inigo Quilez's well-known distance functions.

import type { DetailKind, Item, M3, OrganicModel, Prim, V2, V3 } from "./model";
import { noise3, voronoi3 } from "./noise";

type Dist = (x: number, y: number, z: number) => number;

interface Compiled {
  op: Item["op"];
  d: Dist;
  /** box the shape fills, grown by its blend */
  lo: V3;
  hi: V3;
  k: number;
  color: number;
  detail: number;
  noise?: { scale: number; amount: number; seed: number };
}

export interface Sample {
  d: number;
  /** palette index of the surface colour */
  color: number;
  /** index of the item that owns the surface here (-1: none) */
  item: number;
}

export interface Field {
  /** signed distance, with surface detail when the style has it */
  dist: Dist;
  /** distance plus which colour and shape the surface has there */
  sample(x: number, y: number, z: number): Sample;
  /** box round every added shape, grown by blends and detail */
  lo: V3;
  hi: V3;
  /** colours by palette index, "#rrggbb" */
  palette: string[];
  /** how far the detail moves the surface, mm */
  detailAmp: number;
  /** colour patches smaller than this (mm²) are stray and take their surroundings' colour */
  tidy?: number;
}

// ── primitives ─────────────────────────────────────────────────────────────

const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

function rotate(m: M3 | undefined, x: number, y: number, z: number): V3 {
  if (!m) return [x, y, z];
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

function ellipsoid(c: V3, r: V3, m?: M3): Dist {
  const [rx, ry, rz] = r;
  return (x, y, z) => {
    let px = x - c[0];
    let py = y - c[1];
    let pz = z - c[2];
    if (m) [px, py, pz] = rotate(m, px, py, pz);
    const k0 = len3(px / rx, py / ry, pz / rz);
    const k1 = len3(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
    if (k1 < 1e-12) return -Math.min(rx, ry, rz);
    return (k0 * (k0 - 1)) / k1;
  };
}

function limb(a: V3, b: V3, r1: number, r2: number): Dist {
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  // one end swallows the other: just the bigger ball
  if (l2 < 1e-9 || rr * rr >= l2) {
    const [c, r] = r1 >= r2 ? [a, r1] : [b, r2];
    return (x, y, z) => len3(x - c[0], y - c[1], z - c[2]) - r;
  }
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - a[0];
    const pay = y - a[1];
    const paz = z - a[2];
    const yy = pax * bax + pay * bay + paz * baz;
    const zz = yy - l2;
    const qx = pax * l2 - bax * yy;
    const qy = pay * l2 - bay * yy;
    const qz = paz * l2 - baz * yy;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yy * yy * l2;
    const z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}

function roundBox(c: V3, h: V3, r: number, m?: M3): Dist {
  const rr = Math.min(r, h[0], h[1], h[2]);
  return (x, y, z) => {
    let px = x - c[0];
    let py = y - c[1];
    let pz = z - c[2];
    if (m) [px, py, pz] = rotate(m, px, py, pz);
    const qx = Math.abs(px) - h[0] + rr;
    const qy = Math.abs(py) - h[1] + rr;
    const qz = Math.abs(pz) - h[2] + rr;
    return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - rr;
  };
}

/** Distance to a closed polygon in 2D, negative inside. */
export function polygon2(pts: V2[], px: number, py: number): number {
  const n = pts.length;
  let d = (px - pts[0][0]) ** 2 + (py - pts[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const vi = pts[i];
    const vj = pts[j];
    const ex = vj[0] - vi[0];
    const ey = vj[1] - vi[1];
    const wx = px - vi[0];
    const wy = py - vi[1];
    const ee = ex * ex + ey * ey;
    const t = ee > 0 ? Math.min(1, Math.max(0, (wx * ex + wy * ey) / ee)) : 0;
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= vi[1];
    const c2 = py < vj[1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

function slab(pts: V2[], t: number, r: number, o: V3, u: V3, n: V3): Dist {
  const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const rr = Math.min(r, t * 0.95);
  return (x, y, z) => {
    const px = x - o[0];
    const py = y - o[1];
    const pz = z - o[2];
    const lx = px * u[0] + py * u[1] + pz * u[2];
    const ly = px * v[0] + py * v[1] + pz * v[2];
    const lz = px * n[0] + py * n[1] + pz * n[2];
    const d2 = polygon2(pts, lx, ly) + rr;
    const wz = Math.abs(lz) - (t - rr);
    return Math.min(Math.max(d2, wz), 0) + Math.hypot(Math.max(d2, 0), Math.max(wz, 0)) - rr;
  };
}

function torus(c: V3, R: number, r: number, n: V3): Dist {
  return (x, y, z) => {
    const qx = x - c[0];
    const qy = y - c[1];
    const qz = z - c[2];
    const h = qx * n[0] + qy * n[1] + qz * n[2];
    const rad = len3(qx - n[0] * h, qy - n[1] * h, qz - n[2] * h) - R;
    return Math.hypot(rad, h) - r;
  };
}

function gem(a: V3, b: V3, r: number, sides: number, tip: number): Dist {
  const ax: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = len3(ax[0], ax[1], ax[2]) || 1;
  const w: V3 = [ax[0] / L, ax[1] / L, ax[2] / L];
  // any axis square to w
  const ref: V3 = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let u: V3 = [ref[1] * w[2] - ref[2] * w[1], ref[2] * w[0] - ref[0] * w[2], ref[0] * w[1] - ref[1] * w[0]];
  const ul = len3(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: V3 = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const n = Math.max(3, Math.round(sides));
  const apo = r * Math.cos(Math.PI / n);
  const dirs: V2[] = [];
  for (let i = 0; i < n; i++) dirs.push([Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)]);
  const tl = Math.max(tip, 1e-6);
  const tn = Math.hypot(tl, apo);
  return (x, y, z) => {
    const px = x - a[0];
    const py = y - a[1];
    const pz = z - a[2];
    const lu = px * u[0] + py * u[1] + pz * u[2];
    const lv = px * v[0] + py * v[1] + pz * v[2];
    const lw = px * w[0] + py * w[1] + pz * w[2];
    let d = -lw;
    for (const [cx, cy] of dirs) {
      const s = lu * cx + lv * cy;
      d = Math.max(d, s - apo, ((s - apo) * tl + (lw - L) * apo) / tn);
    }
    return d;
  };
}

export function primDist(p: Prim): Dist {
  switch (p.k) {
    case "ball":
      return (x, y, z) => len3(x - p.c[0], y - p.c[1], z - p.c[2]) - p.r;
    case "ellipsoid":
      return ellipsoid(p.c, p.r, p.m);
    case "limb":
      return limb(p.a, p.b, p.ra, p.rb);
    case "box":
      return roundBox(p.c, p.h, p.r, p.m);
    case "slab":
      return slab(p.pts, p.t, p.r, p.o, p.u, p.n);
    case "torus":
      return torus(p.c, p.R, p.r, p.n);
    case "gem":
      return gem(p.a, p.b, p.r, p.sides, p.tip);
    case "cones":
      return cones(p.s);
  }
}

/** The union of tapered segments, skipping those whose box is further than the nearest so far. */
function cones(s: number[]): Dist {
  const n = Math.floor(s.length / 8);
  const ds: Dist[] = [];
  const box = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    const a: V3 = [s[o], s[o + 1], s[o + 2]];
    const b: V3 = [s[o + 3], s[o + 4], s[o + 5]];
    const ra = s[o + 6];
    const rb = s[o + 7];
    ds.push(limb(a, b, ra, rb));
    for (let k = 0; k < 3; k++) {
      box[i * 6 + k] = Math.min(a[k] - ra, b[k] - rb);
      box[i * 6 + 3 + k] = Math.max(a[k] + ra, b[k] + rb);
    }
  }
  return (x, y, z) => {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      if (d !== Infinity) {
        const dx = Math.max(box[o] - x, 0, x - box[o + 3]);
        const dy = Math.max(box[o + 1] - y, 0, y - box[o + 4]);
        const dz = Math.max(box[o + 2] - z, 0, z - box[o + 5]);
        const b2 = dx * dx + dy * dy + dz * dz;
        // the segment is at least as far as its box
        if (b2 > 0 && (d <= 0 || b2 >= d * d)) continue;
      }
      d = Math.min(d, ds[i](x, y, z));
    }
    return d;
  };
}

/** A box sure to hold the primitive. */
export function primBox(p: Prim): [V3, V3] {
  const around = (c: V3, r: number): [V3, V3] => [
    [c[0] - r, c[1] - r, c[2] - r],
    [c[0] + r, c[1] + r, c[2] + r],
  ];
  const join = (a: [V3, V3], b: [V3, V3]): [V3, V3] => [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1]), Math.min(a[0][2], b[0][2])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1]), Math.max(a[1][2], b[1][2])],
  ];
  switch (p.k) {
    case "ball":
      return around(p.c, p.r);
    case "ellipsoid":
      return around(p.c, Math.max(...p.r));
    case "limb":
      return join(around(p.a, p.ra), around(p.b, p.rb));
    case "box":
      return around(p.c, len3(p.h[0], p.h[1], p.h[2]));
    case "slab": {
      let r = 0;
      for (const q of p.pts) r = Math.max(r, Math.hypot(q[0], q[1]));
      return around(p.o, Math.hypot(r, p.t));
    }
    case "torus":
      return around(p.c, p.R + p.r);
    case "gem": {
      const L = len3(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]) || 1;
      const tipEnd: V3 = [p.b[0] + ((p.b[0] - p.a[0]) / L) * p.tip, p.b[1] + ((p.b[1] - p.a[1]) / L) * p.tip, p.b[2] + ((p.b[2] - p.a[2]) / L) * p.tip];
      return join(around(p.a, p.r), around(tipEnd, p.r));
    }
    case "cones": {
      let b: [V3, V3] = around([p.s[0], p.s[1], p.s[2]], p.s[6]);
      for (let o = 0; o + 7 < p.s.length; o += 8) b = join(join(b, around([p.s[o], p.s[o + 1], p.s[o + 2]], p.s[o + 6])), around([p.s[o + 3], p.s[o + 4], p.s[o + 5]], p.s[o + 7]));
      return b;
    }
  }
}

function boxDist(lo: V3, hi: V3, x: number, y: number, z: number) {
  const dx = Math.max(lo[0] - x, 0, x - hi[0]);
  const dy = Math.max(lo[1] - y, 0, y - hi[1]);
  const dz = Math.max(lo[2] - z, 0, z - hi[2]);
  return len3(dx, dy, dz);
}

// ── surface detail ─────────────────────────────────────────────────────────

/** A pattern in about [-1, 1] that moves the surface outward where positive. */
function detailPattern(kind: DetailKind, scale: number): Dist {
  const f = 1 / Math.max(scale, 0.05);
  switch (kind) {
    case "fur":
      // soft clumps with fine tufts on them
      return (x, y, z) => {
        const c = noise3(x * f * 0.35, y * f * 0.35, z * f * 0.35);
        const t = 1 - 2 * Math.abs(noise3(x * f * 1.7 + 11, y * f * 1.7, z * f * 3.4));
        return 0.55 * c + 0.45 * t;
      };
    case "scales": {
      // a dome on every cell
      return (x, y, z) => {
        const [f1, f2] = voronoi3(x * f, y * f, z * f);
        return Math.min(1, (f2 - f1) * 2.2) * 2 - 1;
      };
    }
    case "feathers":
      return (x, y, z) => {
        const [f1, f2] = voronoi3(x * f, y * f, z * f * 0.5);
        return Math.min(1, (f2 - f1) * 1.6) * 1.6 - 0.8 + 0.2 * noise3(x * f * 4, y * f * 4, z * f * 4);
      };
    case "skin":
      return (x, y, z) => 0.7 * noise3(x * f, y * f, z * f) + 0.3 * noise3(x * f * 3.1 + 5, y * f * 3.1, z * f * 3.1);
  }
}

// ── the whole model ────────────────────────────────────────────────────────

export function hexColor(s: string | undefined, fallback: string): string {
  const t = (s ?? fallback).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return "#" + t[1] + t[1] + t[2] + t[2] + t[3] + t[3];
  return fallback;
}

export function makeField(model: OrganicModel): Field {
  const palette: string[] = [];
  const colorIndex = (c: string) => {
    let i = palette.indexOf(c);
    if (i < 0) {
      i = palette.length;
      palette.push(c);
    }
    return i;
  };
  const base = colorIndex(hexColor(model.color, "#c8c8c8"));
  const items: Compiled[] = model.items.map((it) => {
    const [lo0, hi0] = primBox(it.prim);
    const k = Math.max(0, it.blend);
    const g = it.op === "paint" ? (it.noise ? it.noise.scale * it.noise.amount : 0) : k;
    return {
      op: it.op,
      d: primDist(it.prim),
      lo: [lo0[0] - g, lo0[1] - g, lo0[2] - g],
      hi: [hi0[0] + g, hi0[1] + g, hi0[2] + g],
      k,
      color: it.color ? colorIndex(hexColor(it.color, "#c8c8c8")) : -1,
      detail: it.detail ?? (it.op === "add" ? 1 : 0),
      noise: it.noise,
    };
  });
  const adds = items.filter((i) => i.op === "add");
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const a of adds)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], a.lo[i]);
      hi[i] = Math.max(hi[i], a.hi[i]);
    }
  if (!adds.length) {
    lo.fill(-1);
    hi.fill(1);
  }

  const detailed = model.style === "detailed" && !!model.detail && model.detail.amp > 0;
  const amp = detailed ? model.detail!.amp : 0;
  const pattern = detailed ? detailPattern(model.detail!.kind, model.detail!.scale) : null;
  for (let i = 0; i < 3; i++) {
    lo[i] -= amp;
    hi[i] += amp;
  }

  // the shape alone: distance, owning item and detail weight
  let owner = -1;
  let weight = 0;
  const shape = (x: number, y: number, z: number): number => {
    let d = Infinity;
    owner = -1;
    weight = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.op === "paint") continue;
      if (it.op === "add") {
        if (d !== Infinity && boxDist(it.lo, it.hi, x, y, z) > d + it.k) continue;
        const a = it.d(x, y, z);
        if (d === Infinity) {
          d = a;
          owner = i;
          weight = it.detail;
          continue;
        }
        if (it.k <= 0) {
          if (a < d) {
            d = a;
            owner = i;
            weight = it.detail;
          }
          continue;
        }
        const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - a)) / it.k));
        d = d + (a - d) * h - it.k * h * (1 - h);
        weight = weight + (it.detail - weight) * h;
        if (h > 0.5) owner = i;
      } else {
        // carve
        if (d === Infinity) continue;
        // a carve only changes points where it reaches within its blend of the surface
        if (boxDist(it.lo, it.hi, x, y, z) >= it.k - d) continue;
        const c = it.d(x, y, z);
        if (it.k <= 0) {
          if (-c > d) {
            d = -c;
            if (it.color >= 0) owner = i;
            weight = 0;
          }
          continue;
        }
        const h = Math.min(1, Math.max(0, 0.5 - (0.5 * (d + c)) / it.k));
        d = d + (-c - d) * h + it.k * h * (1 - h);
        weight = weight * (1 - h);
        if (h > 0.5 && it.color >= 0) owner = i;
      }
    }
    return d;
  };

  const dist: Dist = pattern
    ? (x, y, z) => {
        const d = shape(x, y, z);
        if (weight <= 0 || d > amp * 2 || d < -amp * 2) return d;
        return d - amp * weight * pattern(x, y, z);
      }
    : shape;

  const sample = (x: number, y: number, z: number): Sample => {
    const d = dist(x, y, z);
    let color = owner >= 0 && items[owner].color >= 0 ? items[owner].color : base;
    const item = owner;
    for (const it of items) {
      if (it.op !== "paint" || it.color < 0) continue;
      if (boxDist(it.lo, it.hi, x, y, z) > 0) continue;
      let p = it.d(x, y, z);
      if (it.noise) {
        const s = 1 / Math.max(it.noise.scale, 0.01);
        const o = it.noise.seed * 17.31;
        p += it.noise.scale * it.noise.amount * (noise3(x * s + o, y * s - o, z * s) + 0.5 * noise3(x * s * 2.3 - o, y * s * 2.3, z * s * 2.3 + o));
      }
      if (p <= 0) color = it.color;
    }
    return { d, color, item };
  };

  return { dist, sample, lo, hi, palette, detailAmp: amp };
}
