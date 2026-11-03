// Moving, turning, scaling and mirroring organic shapes: used by the .kerf
// functions (groups, mirror: true) and by fitting a model to a sheet.

import type { M3, Prim, V2, V3 } from "./model";

export type Mat = number[]; // 3x3 row-major

const mul = (a: Mat, b: Mat): Mat => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
const apply = (m: Mat, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
export const transpose = (m: Mat): Mat => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
export const IDENT: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const MIRROR_X: Mat = [-1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rotation by rx about X, then ry about Y, then rz about Z (degrees), like a part's rotate:. */
export function rotation(r: V3): Mat {
  const [ax, ay, az] = r.map((d) => (d * Math.PI) / 180);
  const rx: Mat = [1, 0, 0, 0, Math.cos(ax), -Math.sin(ax), 0, Math.sin(ax), Math.cos(ax)];
  const ry: Mat = [Math.cos(ay), 0, Math.sin(ay), 0, 1, 0, -Math.sin(ay), 0, Math.cos(ay)];
  const rz: Mat = [Math.cos(az), -Math.sin(az), 0, Math.sin(az), Math.cos(az), 0, 0, 0, 1];
  return mul(rz, mul(ry, rx));
}

/** Move a primitive: p → s·R·p + t, or its mirror image across x = 0 when `mirror`. */
export function movePrim(p: Prim, R: Mat, s: number, t: V3, mirror = false): Prim {
  const L = mirror ? MIRROR_X : R;
  const pt = (v: V3): V3 => {
    const r = apply(L, v);
    return [r[0] * s + t[0], r[1] * s + t[1], r[2] * s + t[2]];
  };
  const dir = (v: V3): V3 => apply(L, v);
  // world→local maps compose with the inverse of the move's linear part
  const local = (m: M3 | undefined): M3 => mul(m ?? IDENT, mirror ? MIRROR_X : transpose(R)) as M3;
  switch (p.k) {
    case "ball":
      return { ...p, c: pt(p.c), r: p.r * s };
    case "ellipsoid":
      return { ...p, c: pt(p.c), r: [p.r[0] * s, p.r[1] * s, p.r[2] * s], m: local(p.m) };
    case "limb":
      return { ...p, a: pt(p.a), b: pt(p.b), ra: p.ra * s, rb: p.rb * s };
    case "box":
      return { ...p, c: pt(p.c), h: [p.h[0] * s, p.h[1] * s, p.h[2] * s], r: p.r * s, m: local(p.m) };
    case "slab":
      return {
        ...p,
        o: pt(p.o),
        u: dir(p.u),
        n: dir(p.n),
        // a mirrored frame turns the outline over in its own plane
        pts: p.pts.map(([x, y]) => [x * s, (mirror ? -y : y) * s] as V2),
        t: p.t * s,
        r: p.r * s,
      };
    case "torus":
      return { ...p, c: pt(p.c), n: dir(p.n), R: p.R * s, r: p.r * s };
    case "gem":
      return { ...p, a: pt(p.a), b: pt(p.b), r: p.r * s, tip: p.tip * s };
    case "cones": {
      const out = p.s.slice();
      for (let o = 0; o + 7 < out.length; o += 8) {
        [out[o], out[o + 1], out[o + 2]] = pt([out[o], out[o + 1], out[o + 2]]);
        [out[o + 3], out[o + 4], out[o + 5]] = pt([out[o + 3], out[o + 4], out[o + 5]]);
        out[o + 6] *= s;
        out[o + 7] *= s;
      }
      return { k: "cones", s: out };
    }
  }
}
