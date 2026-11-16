// Finding a thread's stand-in faces in a built solid and giving their vertices the values the part shader draws the
// thread from (see threadMarks.ts for the marks and the code).

import * as R from "replicad";
import { vcross, vdot, vlen, vnorm, vscale, vsub, type V3 } from "./recipe";
import { THREAD_STRIDE, threadCode, type ThreadMark } from "./threadMarks";

interface OCSurface {
  BRepAdaptor_Surface: new (f: unknown, restriction: boolean) => {
    GetType(): unknown;
    Cylinder(): { Radius(): number; Axis(): { Location(): OCXYZ; Direction(): OCXYZ; delete(): void }; delete(): void };
    delete(): void;
  };
  GeomAbs_SurfaceType: { GeomAbs_Cylinder: unknown };
}
type OCXYZ = { X(): number; Y(): number; Z(): number; delete(): void };

type RawMesh = { vertices: number[]; triangles: number[]; faceGroups: { start: number; count: number; faceId: number }[] };

/**
 * The per-vertex thread values (THREAD_STRIDE each) for a mesh of `shape`, or null when no face of it is a thread's
 * stand-in. A face is one when it is a cylinder of the mark's radius on the mark's axis; a plain shank of the same
 * diameter on the same axis is told apart in the shader, which draws only between the thread's ends.
 */
export function threadValues(shape: R.Shape3D, mesh: RawMesh, marks: ThreadMark[]): Float32Array | null {
  if (!marks.length || !mesh.faceGroups.length) return null;
  const oc = R.getOC() as unknown as OCSurface;
  const byHash = new Map<number, R.Face>();
  const faces = shape.faces;
  for (const f of faces) if (!byHash.has(f.hashCode)) byHash.set(f.hashCode, f);
  let out: Float32Array | null = null;
  const P = mesh.vertices;
  try {
    for (const g of mesh.faceGroups) {
      const f = byHash.get(g.faceId);
      if (!f || f.geomType !== "CYLINDRE") continue;
      const ad = new oc.BRepAdaptor_Surface(f.wrapped, true);
      let r = 0;
      let o: V3 = [0, 0, 0];
      let a: V3 = [0, 0, 1];
      try {
        const cyl = ad.Cylinder();
        const ax = cyl.Axis();
        const loc = ax.Location();
        const dir = ax.Direction();
        r = cyl.Radius();
        o = [loc.X(), loc.Y(), loc.Z()];
        a = vnorm([dir.X(), dir.Y(), dir.Z()]);
        for (const x of [loc, dir, ax, cyl]) x.delete();
      } catch {
        continue;
      } finally {
        ad.delete();
      }
      const mk = marks.find((m) => Math.abs(m.r - r) < 1e-6 * Math.max(1, r) && Math.abs(vdot(m.a, a)) > 1 - 1e-7 && lineGap(m.o, m.a, o) < 1e-4 * Math.max(1, m.len));
      if (!mk) continue;
      out ??= new Float32Array((P.length / 3) * THREAD_STRIDE);
      const code = threadCode(mk);
      // a frame round the axis for the angle
      const b1 = vnorm(Math.abs(mk.a[0]) < 0.9 ? vcross(mk.a, [1, 0, 0]) : vcross(mk.a, [0, 1, 0]));
      const b2 = vcross(mk.a, b1);
      for (let t = g.start; t < g.start + g.count; t++) {
        const v = mesh.triangles[t];
        const p: V3 = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
        const rel = vsub(p, mk.o);
        const along = vdot(rel, mk.a);
        const rad = vsub(rel, vscale(mk.a, along));
        const rl = vlen(rad) || 1;
        const j = v * THREAD_STRIDE;
        out[j] = code;
        out[j + 1] = along / mk.pitch;
        // the angle's cosine and sine, times the pitch: the shader reads the pitch back as their length
        out[j + 2] = (vdot(rad, b1) / rl) * mk.pitch;
        out[j + 3] = (vdot(rad, b2) / rl) * mk.pitch;
      }
    }
  } finally {
    for (const f of faces) f.delete();
  }
  return out;
}

/** Distance from point q to the line through o along unit a. */
function lineGap(o: V3, a: V3, q: V3): number {
  const d = vsub(q, o);
  return vlen(vsub(d, vscale(a, vdot(d, a))));
}
