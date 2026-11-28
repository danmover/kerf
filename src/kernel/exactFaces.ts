// What the kernel knows exactly about each face of a built solid, lined up with the solid's mesh: the plane a flat
// face lies on, the axis and radius of a cylinder or a cone, the centre of a sphere. The geometry core (src/geom)
// uses these to tell two parts that touch from two that overlap, which their meshes alone cannot (a round face is
// drawn with flat triangles).

import * as R from "replicad";
import type { Shape3D } from "replicad";
import type { MeshData } from "./build";
import { circleThrough } from "./faces";
import type { V3 } from "./recipe";

/**
 * Numbers per face: kind, a point, a direction, a radius, a slope, a spare. Kind 0 is a plane (a point on it, its
 * normal), 1 a cylinder (a point on its axis, the axis, its radius), 2 a cone (as a cylinder: the radius at the
 * point, and how much it grows per millimetre along the axis), 3 a sphere (its centre, its radius), 4 a torus (its
 * centre, its axis, the radius of the ring, and in the slope slot the radius of the tube), -1 none of these.
 */
export const FACE_STRIDE = 10;

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A torus face's centre, axis, ring radius and tube radius, from a circle round its axis and one round its tube
 * (the kernel's own torus description cannot be read here). A torus's u runs round the axis and v round the tube.
 */
function torusOf(f: R.Face): { p: V3; d: V3; ring: number; tube: number } | null {
  const at = (u: number, v: number): V3 => {
    const q = f.pointOnSurface(u, v);
    const t: V3 = [q.x, q.y, q.z];
    q.delete();
    return t;
  };
  const a = [0.1, 0.45, 0.8].map((u) => at(u, 0.5));
  const round = circleThrough(a[0], a[1], a[2]);
  const b = [0.1, 0.45, 0.8].map((v) => at(0.45, v));
  const tube = circleThrough(b[0], b[1], b[2]);
  if (!round || !tube) return null;
  // the axis is square to the circle round it
  const e1 = sub3(a[1], a[0]);
  const e2 = sub3(a[2], a[0]);
  const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 1e-12)) return null;
  const d: V3 = [n[0] / l, n[1] / l, n[2] / l];
  // the tube's middle, dropped onto the axis, is the torus's centre
  const w = sub3(tube.c, round.c);
  const z = dot3(w, d);
  const p: V3 = [round.c[0] + d[0] * z, round.c[1] + d[1] * z, round.c[2] + d[2] * z];
  const ring = Math.hypot(w[0] - d[0] * z, w[1] - d[1] * z, w[2] - d[2] * z);
  return { p, d, ring, tube: tube.r };
}

export interface ExactFaces {
  /** each triangle's row in `faces` */
  triFace: Int32Array;
  faces: Float64Array;
}

interface OcPoint {
  X(): number;
  Y(): number;
  Z(): number;
  delete(): void;
}
interface OcAxis {
  Location(): OcPoint;
  Direction(): OcPoint;
  delete(): void;
}
interface OcSurface {
  BRepAdaptor_Surface: new (face: unknown, restrict: boolean) => {
    Plane(): { Axis(): OcAxis; delete(): void };
    Cylinder(): { Radius(): number; Axis(): OcAxis; delete(): void };
    Sphere(): { Radius(): number; Location(): OcPoint; delete(): void };
    delete(): void;
  };
}

/**
 * A cone face's axis, radius and slope, from two circles round it (the kernel's own cone description cannot be read
 * here). A cone's u runs round it and v along it; the circles are taken away from its ends, clear of a pointed tip.
 */
function coneOf(f: R.Face): { p: V3; d: V3; r: number; slope: number } | null {
  const ring = (v: number) => {
    const ps = [0.1, 0.45, 0.8].map((u) => {
      const q = f.pointOnSurface(u, v);
      const t: V3 = [q.x, q.y, q.z];
      q.delete();
      return t;
    });
    return circleThrough(ps[0], ps[1], ps[2]);
  };
  const lo = ring(0.25);
  const hi = ring(0.75);
  if (!lo || !hi) return null;
  const ax: V3 = [hi.c[0] - lo.c[0], hi.c[1] - lo.c[1], hi.c[2] - lo.c[2]];
  const h = Math.hypot(ax[0], ax[1], ax[2]);
  if (!(h > 1e-9)) return null;
  return { p: lo.c, d: [ax[0] / h, ax[1] / h, ax[2] / h], r: lo.r, slope: (hi.r - lo.r) / h };
}

/** The mesh's triangles by face, with each face's exact shape. Null when the mesh does not say which face is which. */
export function exactFaces(shape: Shape3D, mesh: MeshData): ExactFaces | null {
  const groups = mesh.faceGroups;
  if (!groups || !groups.length) return null;
  const nt = mesh.indices.length / 3;
  const triFace = new Int32Array(nt).fill(-1);
  const rows = groups.length / 3;
  const faces = new Float64Array(rows * FACE_STRIDE);
  const oc = R.getOC() as unknown as OcSurface;
  // mesh face groups are keyed by face hash
  const byHash = new Map<number, R.Face>();
  const all = shape.faces;
  for (const f of all) if (!byHash.has(f.hashCode)) byHash.set(f.hashCode, f);
  try {
    for (let g = 0; g < rows; g++) {
      const start = groups[g * 3] / 3;
      const count = groups[g * 3 + 1] / 3;
      if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || start + count > nt) return null;
      triFace.fill(g, start, start + count);
      const row = g * FACE_STRIDE;
      faces[row] = -1;
      const f = byHash.get(groups[g * 3 + 2]);
      if (!f) continue;
      const kind = f.geomType;
      if (kind === "CONE") {
        try {
          const c = coneOf(f);
          if (c) faces.set([2, c.p[0], c.p[1], c.p[2], c.d[0], c.d[1], c.d[2], c.r, c.slope, 0], row);
        } catch {
          faces[row] = -1;
        }
        continue;
      }
      if (kind === "TORUS") {
        try {
          const t = torusOf(f);
          if (t) faces.set([4, t.p[0], t.p[1], t.p[2], t.d[0], t.d[1], t.d[2], t.ring, t.tube, 0], row);
        } catch {
          faces[row] = -1;
        }
        continue;
      }
      if (kind !== "PLANE" && kind !== "CYLINDRE" && kind !== "SPHERE") continue;
      const ad = new oc.BRepAdaptor_Surface(f.wrapped, true);
      try {
        if (kind === "SPHERE") {
          const s = ad.Sphere();
          const c = s.Location();
          faces.set([3, c.X(), c.Y(), c.Z(), 0, 0, 0, Math.abs(s.Radius()), 0, 0], row);
          for (const x of [c, s]) x.delete();
        } else {
          const cyl = kind === "PLANE" ? null : ad.Cylinder();
          const s = cyl ?? ad.Plane();
          const ax = s.Axis();
          const loc = ax.Location();
          const dir = ax.Direction();
          faces.set([cyl ? 1 : 0, loc.X(), loc.Y(), loc.Z(), dir.X(), dir.Y(), dir.Z(), cyl ? Math.abs(cyl.Radius()) : 0, 0, 0], row);
          for (const x of [loc, dir, ax, s]) x.delete();
        }
      } catch {
        faces[row] = -1;
      } finally {
        ad.delete();
      }
    }
  } finally {
    for (const f of all) {
      try {
        f.delete();
      } catch {
        /* already gone */
      }
    }
  }
  return { triFace, faces };
}
