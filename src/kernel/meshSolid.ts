// A closed triangle mesh as an OpenCASCADE solid: one flat face per
// triangle, sewn into a shell. Plugin shapes (organic creatures) use a coarse
// one of these so the checks, measurements and STEP export can treat them
// like any other part.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { BuildError } from "./build";

/** Most triangles worth sewing: beyond this the sewing takes seconds. */
export const MAX_SEWN_TRIANGLES = 4000;

export function solidFromTriangles(positions: Float32Array, indices: Uint32Array): Shape3D {
  const nf = indices.length / 3;
  if (nf < 4) throw new BuildError("The shape has too few triangles to make a solid.");
  if (nf > MAX_SEWN_TRIANGLES) throw new BuildError(`The stand-in for this shape has ${nf} triangles, more than the ${MAX_SEWN_TRIANGLES} the kernel sews.`);
  const oc = R.getOC();
  const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
  const faces: R.Face[] = [];
  const fixer = new oc.ShapeFix_Solid();
  try {
    const pt = (i: number): [number, number, number] => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    for (let f = 0; f < nf; f++) {
      const a = pt(indices[f * 3]);
      const b = pt(indices[f * 3 + 1]);
      const c = pt(indices[f * 3 + 2]);
      // skip slivers the kernel cannot make a face from
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const uz = b[2] - a[2];
      const vx = c[0] - a[0];
      const vy = c[1] - a[1];
      const vz = c[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-8) continue;
      const face = R.makePolygon([a, b, c]);
      faces.push(face);
      sew.Add(face.wrapped);
    }
    sew.Perform();
    const sewed = sew.SewedShape();
    if (sewed.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) throw new BuildError("The shape's surface did not close into one shell.");
    const solid = R.cast(fixer.SolidFromShell(oc.TopoDS.Shell(sewed)));
    if (!(solid instanceof R.Solid)) throw new BuildError("The shape's surface did not make a solid.");
    return solid;
  } finally {
    for (const f of faces) f.delete();
    sew.delete();
    fixer.delete();
  }
}
