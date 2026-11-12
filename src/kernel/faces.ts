// A built solid's flat and round faces, in its own coordinates, for mates: each flat face's middle, outward normal,
// area and box, and each cylinder's and cone's axis, radius and length along the axis. Mates pick faces from this
// list where the part is drawn, so a design is solved again without asking the kernel while its geometry stays the
// same. A hole or shaft the kernel split into pieces (a seam, a cut across it) is listed once.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import type { FaceCatalogue } from "../core/mates";
import type { V3 } from "./recipe";

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pt = (p: { X(): number; Y(): number; Z(): number }): V3 => [p.X(), p.Y(), p.Z()];

interface OcAxis {
  Location(): { X(): number; Y(): number; Z(): number; delete(): void };
  Direction(): { X(): number; Y(): number; Z(): number; delete(): void };
  delete(): void;
}

/** The axis, radius and axial span of a cylinder face. */
function cylinderOf(f: R.Face): { o: V3; d: V3; r: number; a0: number; a1: number } | null {
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Surface(f.wrapped, false);
  try {
    // a cylinder's surface point at v is v along its axis
    const { vMin, vMax } = f.UVBounds;
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) return null;
    const c = ad.Cylinder() as unknown as { Radius(): number; Axis(): OcAxis; delete(): void };
    const r = c.Radius();
    const ax = c.Axis();
    const loc = ax.Location();
    const dir = ax.Direction();
    const o = pt(loc);
    const d = unit(pt(dir));
    for (const x of [loc, dir, ax, c]) x.delete();
    return { o, d, r: Math.abs(r), a0: vMin, a1: vMax };
  } catch {
    return null;
  } finally {
    ad.delete();
  }
}

/** The centre and radius of the circle through three points. */
function circleThrough(a: V3, b: V3, c: V3): { c: V3; r: number } | null {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const nn = dot(n, n);
  if (!(nn > 1e-18)) return null;
  // centre = a + (|ac|² (n × ab) + |ab|² (ac × n)) / (2 |n|²), n = ab × ac
  const nxab: V3 = [n[1] * ab[2] - n[2] * ab[1], n[2] * ab[0] - n[0] * ab[2], n[0] * ab[1] - n[1] * ab[0]];
  const acxn: V3 = [ac[1] * n[2] - ac[2] * n[1], ac[2] * n[0] - ac[0] * n[2], ac[0] * n[1] - ac[1] * n[0]];
  const kab = dot(ab, ab),
    kac = dot(ac, ac);
  const off: V3 = [0, 1, 2].map((k) => (kac * nxab[k] + kab * acxn[k]) / (2 * nn)) as V3;
  return { c: [a[0] + off[0], a[1] + off[1], a[2] + off[2]], r: Math.hypot(off[0], off[1], off[2]) };
}

/**
 * The axis, middle radius and axial span of a cone face, from the circles at either end of it (the kernel's own
 * cone description cannot be read here). A cone's u runs round it and v along it.
 */
function coneOf(f: R.Face): { o: V3; d: V3; r: number; a0: number; a1: number } | null {
  const ring = (v: number) => {
    const ps = [0, 1 / 3, 2 / 3].map((u) => {
      const q = f.pointOnSurface(u, v);
      const t: V3 = [q.x, q.y, q.z];
      q.delete();
      return t;
    });
    return circleThrough(ps[0], ps[1], ps[2]);
  };
  const lo = ring(0),
    hi = ring(1);
  if (!lo || !hi) return null;
  const axis: V3 = [hi.c[0] - lo.c[0], hi.c[1] - lo.c[1], hi.c[2] - lo.c[2]];
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(l > 1e-9)) return null;
  return { o: lo.c, d: unit(axis), r: (lo.r + hi.r) / 2, a0: 0, a1: l };
}

export function faceCatalogue(shape: Shape3D): FaceCatalogue {
  const planes: FaceCatalogue["planes"] = [];
  const pieces: { o: V3; d: V3; r: number; a0: number; a1: number; area: number }[] = [];
  for (const f of shape.faces) {
    try {
      const kind = String(f.geomType);
      if (kind !== "PLANE" && kind !== "CYLINDRE" && kind !== "CONE") continue;
      const props = R.measureShapeSurfaceProperties(f);
      const area = props.area;
      const c = props.centerOfMass;
      props.delete();
      if (!(area > 1e-9)) continue;
      if (kind === "PLANE") {
        // the normal the face's own side gives: out of the solid
        const nv = f.normalAt();
        const n = unit([nv.x, nv.y, nv.z]);
        nv.delete();
        const bb = f.boundingBox;
        const [lo, hi] = bb.bounds;
        bb.delete();
        planes.push({ p: [c[0], c[1], c[2]], n, area, lo: [lo[0], lo[1], lo[2]], hi: [hi[0], hi[1], hi[2]] });
      } else {
        const rd = kind === "CYLINDRE" ? cylinderOf(f) : coneOf(f);
        if (rd && rd.r > 1e-6) pieces.push({ ...rd, a0: Math.min(rd.a0, rd.a1), a1: Math.max(rd.a0, rd.a1), area });
      }
    } catch {
      // a face the kernel cannot describe is left out
    } finally {
      f.delete();
    }
  }
  const bb = shape.boundingBox;
  const [lo, hi] = bb.bounds;
  bb.delete();
  return { planes, rounds: mergeRounds(pieces), box: [[lo[0], lo[1], lo[2]], [hi[0], hi[1], hi[2]]] };
}

/** Pieces of one round face (same axis line and radius, touching along it) listed as one. */
function mergeRounds(pieces: { o: V3; d: V3; r: number; a0: number; a1: number; area: number }[]): FaceCatalogue["rounds"] {
  const groups: { o: V3; d: V3; r: number; a0: number; a1: number; area: number }[] = [];
  const tol = 1e-4;
  for (const p of pieces) {
    const g = groups.find((g) => {
      const s = dot(p.d, g.d);
      if (Math.abs(Math.abs(s) - 1) > 1e-6 || Math.abs(p.r - g.r) > tol) return false;
      // p's axis point, measured along and off g's axis
      const w: V3 = [p.o[0] - g.o[0], p.o[1] - g.o[1], p.o[2] - g.o[2]];
      const t = dot(w, g.d);
      const off = Math.hypot(w[0] - t * g.d[0], w[1] - t * g.d[1], w[2] - t * g.d[2]);
      if (off > tol) return false;
      const a0 = t + (s > 0 ? p.a0 : -p.a1),
        a1 = t + (s > 0 ? p.a1 : -p.a0);
      if (a0 > g.a1 + tol || a1 < g.a0 - tol) return false;
      g.a0 = Math.min(g.a0, a0);
      g.a1 = Math.max(g.a1, a1);
      g.area += p.area;
      return true;
    });
    if (!g) groups.push({ ...p });
  }
  return groups.map((g) => {
    const m = (g.a0 + g.a1) / 2;
    return { p: [g.o[0] + m * g.d[0], g.o[1] + m * g.d[1], g.o[2] + m * g.d[2]] as V3, d: g.d, r: g.r, len: g.a1 - g.a0, area: g.area };
  });
}
