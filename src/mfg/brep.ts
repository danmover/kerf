// Reads an exact OpenCASCADE solid into the form the process analysis works
// on: a triangle mesh tagged with its B-rep faces, and per-face geometry
// (plane normals, cylinder axes and radii, concavity). Kernel-side only.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import type { V3 } from "../kernel/recipe";

export interface FaceInfo {
  type: string;
  area: number;
  /** triangle range in the mesh */
  start: number;
  count: number;
  /** planes: outward normal */
  normal?: V3;
  /** cylinders and spheres: the axis line (spheres: centre, any direction) */
  axis?: { p: V3; d: V3 };
  radius?: number;
  /** cylinders: material outside the cylinder (a hole or an inside fillet) */
  concave?: boolean;
  /** cylinders: spans the full 360° */
  fullTurn?: boolean;
  /** extent along the axis */
  length?: number;
}

export interface AnalysisMesh {
  pos: Float32Array;
  idx: Uint32Array;
  /** per triangle: index into faces */
  faceOf: Int32Array;
  faces: FaceInfo[];
  /** solids with more than one shell enclose voids */
  voids: number;
}

const v3 = (p: { X(): number; Y(): number; Z(): number }): V3 => [p.X(), p.Y(), p.Z()];

export function analysisMesh(shape: Shape3D, mesh: { vertices: ArrayLike<number>; triangles: ArrayLike<number>; faceGroups?: { start: number; count: number; faceId: number }[] }): AnalysisMesh {
  const pos = Float32Array.from(mesh.vertices);
  const idx = Uint32Array.from(mesh.triangles);
  const nTri = idx.length / 3;
  const faceOf = new Int32Array(nTri).fill(-1);
  const faceList = shape.faces;
  const faces: FaceInfo[] = [];
  const groups = mesh.faceGroups ?? [{ start: 0, count: idx.length, faceId: 0 }];
  // mesh face groups name faces by hash code; fall back to iteration order
  const byHash = new Map<number, R.Face>();
  for (const f of faceList) byHash.set(f.hashCode, f);
  groups.forEach((g, gi) => {
    const start = g.start / 3;
    const count = g.count / 3;
    for (let t = start; t < start + count; t++) faceOf[t] = faces.length;
    const face = byHash.get(g.faceId) ?? faceList[gi];
    const info: FaceInfo = { type: face ? face.geomType : "OTHER_SURFACE", area: 0, start, count };
    // area and mean outward normal from the triangles
    const mean: V3 = [0, 0, 0];
    for (let t = start; t < start + count; t++) {
      const n = triNormal(pos, idx, t);
      info.area += n[3];
      mean[0] += n[0] * n[3];
      mean[1] += n[1] * n[3];
      mean[2] += n[2] * n[3];
    }
    if (face) {
      try {
        describe(face, info, pos, idx, mean);
      } catch {
        /* keep what the mesh gives */
      }
    }
    faces.push(info);
  });
  for (const f of faceList) safeDelete(f);
  return { pos, idx, faceOf, faces, voids: countVoids(shape) };
}

function describe(face: R.Face, info: FaceInfo, pos: Float32Array, idx: Uint32Array, mean: V3) {
  const type = info.type;
  if (type === "PLANE") {
    const l = Math.hypot(...mean);
    if (l > 1e-12) info.normal = [mean[0] / l, mean[1] / l, mean[2] / l];
    return;
  }
  if (type === "CYLINDRE" || type === "SPHERE") {
    // the WASM build binds exact cylinders and spheres
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ad: any = (face as any)._geomAdaptor();
    try {
      if (type === "CYLINDRE") {
        const c = ad.Cylinder();
        info.radius = c.Radius();
        const ax = c.Axis();
        const dRaw = v3(ax.Direction());
        const l = Math.hypot(...dRaw) || 1;
        info.axis = { p: v3(ax.Location()), d: [dRaw[0] / l, dRaw[1] / l, dRaw[2] / l] };
      } else {
        const sp = ad.Sphere();
        info.axis = { p: v3(sp.Location()), d: [0, 0, 1] };
        info.radius = sp.Radius();
      }
    } finally {
      safeDelete(ad);
    }
  }
  // cones, tori and revolved surfaces are not bound in the WASM build; checks
  // that need their axis test the mesh normals against a known axis instead
  if (info.axis && type === "CYLINDRE") {
    const { p, d } = info.axis;
    let lo = Infinity;
    let hi = -Infinity;
    let inward = 0;
    for (let t = info.start; t < info.start + info.count; t++) {
      const n = triNormal(pos, idx, t);
      const c = triCentroid(pos, idx, t);
      const rel: V3 = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
      const s = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
      const radial: V3 = [rel[0] - d[0] * s, rel[1] - d[1] * s, rel[2] - d[2] * s];
      inward += (radial[0] * n[0] + radial[1] * n[1] + radial[2] * n[2]) * n[3];
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3;
        const a = (pos[v] - p[0]) * d[0] + (pos[v + 1] - p[1]) * d[1] + (pos[v + 2] - p[2]) * d[2];
        if (a < lo) lo = a;
        if (a > hi) hi = a;
      }
    }
    info.concave = inward < 0;
    info.length = hi > lo ? hi - lo : 0;
    const b = face.UVBounds;
    info.fullTurn = b.uMax - b.uMin > 2 * Math.PI - 1e-3;
  }
}

/** unit normal (x, y, z) and area of triangle t */
export function triNormal(pos: ArrayLike<number>, idx: ArrayLike<number>, t: number): [number, number, number, number] {
  const a = idx[t * 3] * 3;
  const b = idx[t * 3 + 1] * 3;
  const c = idx[t * 3 + 2] * 3;
  const e1x = pos[b] - pos[a],
    e1y = pos[b + 1] - pos[a + 1],
    e1z = pos[b + 2] - pos[a + 2];
  const e2x = pos[c] - pos[a],
    e2y = pos[c + 1] - pos[a + 1],
    e2z = pos[c + 2] - pos[a + 2];
  const nx = e1y * e2z - e1z * e2y,
    ny = e1z * e2x - e1x * e2z,
    nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-18) return [0, 0, 0, 0];
  return [nx / l, ny / l, nz / l, l / 2];
}

export function triCentroid(pos: ArrayLike<number>, idx: ArrayLike<number>, t: number): V3 {
  const a = idx[t * 3] * 3;
  const b = idx[t * 3 + 1] * 3;
  const c = idx[t * 3 + 2] * 3;
  return [(pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3];
}

function countVoids(shape: Shape3D): number {
  let voids = 0;
  try {
    for (const solid of R.iterTopo(shape.wrapped, "solid")) {
      let shells = 0;
      for (const sh of R.iterTopo(solid as never, "shell")) {
        shells++;
        safeDelete(sh as never);
      }
      if (shells > 1) voids += shells - 1;
      safeDelete(solid as never);
    }
  } catch {
    /* not countable: assume none */
  }
  return voids;
}

function safeDelete(s: { delete?: () => void } | undefined) {
  try {
    s?.delete?.();
  } catch {
    /* already freed */
  }
}

