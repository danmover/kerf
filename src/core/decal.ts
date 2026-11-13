// Laying a decal on a part's mesh: the triangles that face the decal inside
// its box (width × height across, depth each way along its facing), clipped
// to the box, with texture coordinates across it. Part coordinates, mm.

import type { DecalSpec } from "./model";
import type { V3 } from "../kernel/recipe";

/** The decal's box: its middle, its across (u, left to right), up (v) and facing (n) axes, and its half sizes. */
export interface DecalBox {
  o: V3;
  u: V3;
  v: V3;
  n: V3;
  hw: number;
  hh: number;
  hd: number;
}

export interface DecalMesh {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
}

export interface MeshArrays {
  position: ArrayLike<number>;
  normal?: ArrayLike<number> | null;
  index?: ArrayLike<number> | null;
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The box of a decal `height` tall (its own height:, or an image's from its shape). */
export function decalBox(s: DecalSpec, height: number): DecalBox {
  // reading it face on, with up up, across runs to the right: u = v × n
  return { o: s.at, u: cross(s.up, s.dir), v: s.up, n: s.dir, hw: s.width / 2, hh: height / 2, hd: s.depth };
}

/** a corner of a clipped triangle: where it is in the box (x, y, z), on the part (p) and its normal */
interface Corner {
  x: number;
  y: number;
  z: number;
  p: V3;
  nn: V3;
}

const lerp = (a: Corner, b: Corner, t: number): Corner => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
  p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t],
  nn: [a.nn[0] + (b.nn[0] - a.nn[0]) * t, a.nn[1] + (b.nn[1] - a.nn[1]) * t, a.nn[2] + (b.nn[2] - a.nn[2]) * t],
});

/** Keep the part of a polygon where c's `axis` coordinate times `sign` is at most `lim` (Sutherland–Hodgman). */
function clip(poly: Corner[], axis: "x" | "y" | "z", sign: 1 | -1, lim: number): Corner[] {
  const out: Corner[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = sign * a[axis] - lim;
    const db = sign * b[axis] - lim;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(lerp(a, b, da / (da - db)));
  }
  return out;
}

/**
 * The decal's own mesh: the triangles of `mesh` facing the decal's way (their
 * normal at least `facing` along it) inside its box, clipped to it, each
 * corner lifted `lift` off the surface. uv runs 0..1 across and up the box.
 */
export function projectDecal(mesh: MeshArrays, box: DecalBox, lift = 0.05, facing = 0.12): DecalMesh {
  const P = mesh.position;
  const N = mesh.normal ?? null;
  const I = mesh.index ?? null;
  const count = I ? I.length : P.length / 3;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const { o, u, v, n, hw, hh, hd } = box;
  const corner = (k: number): Corner => {
    const i = I ? I[k] : k;
    const p: V3 = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    const r: V3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const nn: V3 = N ? [N[3 * i], N[3 * i + 1], N[3 * i + 2]] : [0, 0, 0];
    return { x: r[0] * u[0] + r[1] * u[1] + r[2] * u[2], y: r[0] * v[0] + r[1] * v[1] + r[2] * v[2], z: r[0] * n[0] + r[1] * n[1] + r[2] * n[2], p, nn };
  };
  for (let t = 0; t + 2 < count; t += 3) {
    const a = corner(t);
    const b = corner(t + 1);
    const c = corner(t + 2);
    // wholly outside one side of the box
    if ((a.x > hw && b.x > hw && c.x > hw) || (a.x < -hw && b.x < -hw && c.x < -hw)) continue;
    if ((a.y > hh && b.y > hh && c.y > hh) || (a.y < -hh && b.y < -hh && c.y < -hh)) continue;
    if ((a.z > hd && b.z > hd && c.z > hd) || (a.z < -hd && b.z < -hd && c.z < -hd)) continue;
    // facing the decal's way: by the surface normals the mesh carries, else by the triangle's winding
    const e1: V3 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
    const e2: V3 = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
    const w = cross(e1, e2);
    const wl = Math.hypot(w[0], w[1], w[2]);
    if (!(wl > 1e-12)) continue;
    let fn: V3 = N ? [a.nn[0] + b.nn[0] + c.nn[0], a.nn[1] + b.nn[1] + c.nn[1], a.nn[2] + b.nn[2] + c.nn[2]] : w;
    let fl = Math.hypot(fn[0], fn[1], fn[2]);
    if (!(fl > 1e-9)) {
      fn = w;
      fl = wl;
    }
    if ((fn[0] * n[0] + fn[1] * n[1] + fn[2] * n[2]) / fl < facing) continue;
    if (!N) for (const k of [a, b, c]) k.nn = [fn[0] / fl, fn[1] / fl, fn[2] / fl];
    // wound so its front is the outside, like the face it lies on (a mesh wound against its normals is turned)
    let poly = w[0] * fn[0] + w[1] * fn[1] + w[2] * fn[2] < 0 ? [a, c, b] : [a, b, c];
    poly = clip(poly, "x", 1, hw);
    if (poly.length >= 3) poly = clip(poly, "x", -1, hw);
    if (poly.length >= 3) poly = clip(poly, "y", 1, hh);
    if (poly.length >= 3) poly = clip(poly, "y", -1, hh);
    if (poly.length >= 3) poly = clip(poly, "z", 1, hd);
    if (poly.length >= 3) poly = clip(poly, "z", -1, hd);
    if (poly.length < 3) continue;
    const put = (k: Corner) => {
      const l = Math.hypot(k.nn[0], k.nn[1], k.nn[2]);
      const m: V3 = l > 1e-9 ? [k.nn[0] / l, k.nn[1] / l, k.nn[2] / l] : [fn[0] / fl, fn[1] / fl, fn[2] / fl];
      pos.push(k.p[0] + m[0] * lift, k.p[1] + m[1] * lift, k.p[2] + m[2] * lift);
      nrm.push(m[0], m[1], m[2]);
      uvs.push(0.5 + k.x / (2 * hw), 0.5 + k.y / (2 * hh));
    };
    for (let i = 1; i + 1 < poly.length; i++) {
      put(poly[0]);
      put(poly[i]);
      put(poly[i + 1]);
    }
  }
  return { position: new Float32Array(pos), normal: new Float32Array(nrm), uv: new Float32Array(uvs) };
}
