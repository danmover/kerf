// Real screw threads and knurls. A thread's cross-section across its axis is
// the same outline at every height, turned by 360° per lead, so a thread is
// one twisted extrusion of a smooth closed curve: fast to build, and exact
// enough to print. Fast (preview) builds use plain cylinders instead.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { vcross, vdot, vnorm, type ThreadSpec3, type V3 } from "./recipe";
import { formRadius, pitchDiameter } from "./threadMath";

export { formRadius, minorDiameter, pitchDiameter, threadDepth } from "./threadMath";

/** Closed cross-section of a thread at height 0, in the XY plane. */
function threadSection(spec: ThreadSpec3, internal: boolean): R.Wire {
  const n = Math.max(48, 64 * spec.starts);
  const pts: V3[] = [];
  const c = internal ? spec.clearance : -spec.clearance;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * 2 * Math.PI;
    // a point at angle th sits on the helix that starts th/2π leads earlier
    const r = formRadius(spec.form, spec.d, spec.pitch, (i / n) * spec.starts) + c;
    pts.push([r * Math.cos(th), r * Math.sin(th), 0]);
  }
  pts.push(pts[0]);
  const tol = Math.max(0.002, spec.pitch * 0.004);
  return R.assembleWire([R.makeBSplineApproximation(pts, { tolerance: tol, degMax: 3, degMin: 3, smoothing: null })]);
}

function twisted(wire: R.Wire, length: number, z0: number, lead: number): Shape3D {
  const sk = new R.Sketch(wire.translate([0, 0, z0]), { defaultOrigin: [0, 0, z0], defaultDirection: [0, 0, 1] });
  return sk.extrude(length, { twistAngle: (360 * length) / lead }) as Shape3D;
}

/**
 * A thread body along +Z from z0 to z0 + length (external: the threaded rod; internal: the hole it cuts).
 * Long threads are built one lead at a time and sewn together: every lead is the same shape moved up, and a
 * side face per turn keeps booleans local. One face winding through 20 turns makes every fuse or cut that
 * touches it intersect the whole helix, which took seconds.
 */
function localThread(spec: ThreadSpec3, length: number, internal: boolean, z0: number): Shape3D {
  const lead = spec.pitch * spec.starts;
  const wire = threadSection(spec, internal);
  const n = Math.floor(length / lead + 1e-9);
  let s: Shape3D | null = n >= 2 ? sewnThread(wire, length, z0, lead, n) : null;
  if (!s) s = twisted(wire, length, z0, lead);
  wire.delete();
  if (spec.left) s = s.mirror("XZ", [0, 0, 0]);
  return s;
}

function sewnThread(wire: R.Wire, length: number, z0: number, lead: number, n: number): Shape3D | null {
  const oc = R.getOC();
  const seg = twisted(wire.clone(), lead, z0, lead);
  const rem = length - n * lead;
  const last = rem > 1e-4 ? twisted(wire.clone(), rem, z0 + n * lead, lead) : null;
  const cap = (s: Shape3D, z: number) => s.faces.find((f) => f.geomType === "PLANE" && Math.abs(f.center.z - z) < 1e-6);
  const sides = (s: Shape3D) => s.faces.filter((f) => f.geomType !== "PLANE");
  const bottom = cap(seg, z0);
  const top = last ? cap(last, z0 + length) : cap(seg, z0 + lead);
  if (!bottom || !top) return null;
  const sew = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
  const keep: R.AnyShape[] = [];
  const add = (f: R.Face) => {
    keep.push(f);
    sew.Add(f.wrapped);
  };
  add(bottom);
  for (let k = 0; k < n; k++) for (const f of sides(seg)) add(k ? f.clone().translate([0, 0, k * lead]) : f);
  if (last) for (const f of sides(last)) add(f);
  add(top.clone().translate([0, 0, last ? 0 : (n - 1) * lead]));
  sew.Perform();
  const fixer = new oc.ShapeFix_Solid();
  let out: Shape3D | null = null;
  try {
    const solid = R.cast(fixer.SolidFromShell(oc.TopoDS.Shell(sew.SewedShape())));
    if (solid instanceof R.Solid && R.measureVolume(solid) > 0) out = solid;
  } catch {
    out = null;
  }
  sew.delete();
  fixer.delete();
  for (const f of keep) f.delete();
  seg.delete();
  last?.delete();
  return out;
}

/** Move a shape built along +Z at the origin to start at `at` and run along `dir`. */
export function placeAxis(s: Shape3D, at: V3, dir: V3): Shape3D {
  const n = vnorm(dir);
  const c = vdot([0, 0, 1], n);
  let out = s;
  if (c < 1 - 1e-12) {
    let axis = vcross([0, 0, 1], n);
    if (Math.hypot(...axis) < 1e-9) axis = [1, 0, 0];
    out = out.rotate((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI, [0, 0, 0], vnorm(axis));
  }
  if (at[0] || at[1] || at[2]) out = out.translate(at);
  return out;
}

/**
 * External thread: a threaded rod from `at` along `dir`.
 * Internal thread: the cutting tool for a threaded hole, entering at `at` along `dir`.
 * `lead` is an entry chamfer depth for internal threads (0 for none). Fast builds use a plain cylinder of
 * `fastD` (default: the pitch diameter, less or plus the clearance).
 */
export function buildThread(spec: ThreadSpec3, length: number, at: V3, dir: V3, internal: boolean, lead: number, detail: boolean, fastD?: number): Shape3D {
  const d2 = pitchDiameter(spec);
  let local: Shape3D;
  if (internal) {
    const over = 0.05;
    const lz = Math.min(Math.max(lead, 0), length * 0.5);
    if (!detail) local = R.makeCylinder(fastD ? fastD / 2 : d2 / 2 + spec.clearance, length + over, [0, 0, -over], [0, 0, 1]);
    else if (lz <= 0) local = localThread(spec, length + over, true, -over);
    else {
      // the entry: a short plain bore just wider than the crests, so the ragged first half-turn is gone and a screw
      // starts straight. The thread starts on the bore's floor, so the two only meet in a flat face; a conical
      // chamfer would have to be intersected with the thread surface, which costs seconds.
      const r0 = spec.d / 2 + spec.clearance + 0.05;
      local = R.makeCylinder(r0, lz + over, [0, 0, -over], [0, 0, 1]).fuse(localThread(spec, length - lz, true, lz));
    }
  } else {
    local = detail ? localThread(spec, length, false, 0) : R.makeCylinder(fastD ? fastD / 2 : d2 / 2 - spec.clearance, length, [0, 0, 0], [0, 0, 1]);
  }
  return placeAxis(local, at, dir);
}

/**
 * Grip cylinder with `count` ridges `depth` deep around diameter d.
 * straight: V ridges (a straight knurl); fluted: rounded scallops, like a printed knob.
 */
export function buildKnurl(d: number, h: number, at: V3, dir: V3, count: number, depth: number, style: "straight" | "fluted", detail: boolean): Shape3D {
  if (!detail) return placeAxis(R.makeCylinder(d / 2, h, [0, 0, 0], [0, 0, 1]), at, dir);
  let drawing: R.Drawing;
  if (style === "straight") {
    const pts: [number, number][] = [];
    for (let i = 0; i < 2 * count; i++) {
      const th = (i / (2 * count)) * 2 * Math.PI;
      const r = i % 2 === 0 ? d / 2 : d / 2 - depth;
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    let pen = R.draw(pts[0]);
    for (const p of pts.slice(1)) pen = pen.lineTo(p);
    drawing = pen.close();
  } else {
    // scallops: circles centred on the rim, sized so neighbours leave a land between them
    const pitch = (Math.PI * d) / count;
    const rs = Math.min(pitch * 0.35, (depth * depth + (pitch * 0.35) ** 2) / (2 * depth));
    drawing = R.drawCircle(d / 2);
    for (let i = 0; i < count; i++) {
      const th = (i / count) * 2 * Math.PI;
      const rc = d / 2 + rs - depth;
      drawing = drawing.cut(R.drawCircle(rs).translate(rc * Math.cos(th), rc * Math.sin(th)));
    }
  }
  const local = (drawing.sketchOnPlane("XY") as R.Sketch).extrude(h) as Shape3D;
  return placeAxis(local, at, dir);
}
