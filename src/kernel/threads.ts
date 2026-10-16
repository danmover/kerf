// Real screw threads and knurls. A thread's cross-section across its axis is
// the same outline at every height, turned by 360° per lead, so a thread is
// one twisted extrusion of a smooth closed curve: fast to build, and exact
// enough to print. Fast (preview) builds use plain cylinders instead.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { vcross, vdot, vnorm, type ThreadForm, type ThreadSpec3, type V3 } from "./recipe";

/** Radial depth of the basic thread form. */
export function threadDepth(form: ThreadForm, pitch: number) {
  switch (form) {
    case "iso":
      return 0.541266 * pitch; // 5/8 H, H = 0.866 p
    case "trapezoid":
    case "square":
      return 0.5 * pitch;
    case "buttress":
      return 0.6 * pitch;
  }
}

/** Pitch diameter: where the flanks are as wide as the gaps. */
export function pitchDiameter(spec: Pick<ThreadSpec3, "d" | "pitch" | "form">) {
  return spec.form === "iso" ? spec.d - 0.649519 * spec.pitch : spec.d - threadDepth(spec.form, spec.pitch);
}

export function minorDiameter(spec: Pick<ThreadSpec3, "d" | "pitch" | "form">) {
  return spec.d - 2 * threadDepth(spec.form, spec.pitch);
}

/**
 * Basic radius at axial phase s (0..1 along one pitch), crest centred at s = 0.5.
 * Flanks are straight lines between the root and crest flats.
 */
export function formRadius(form: ThreadForm, d: number, pitch: number, s: number): number {
  const rMaj = d / 2;
  const rMin = rMaj - threadDepth(form, pitch);
  const u = ((s % 1) + 1) % 1;
  // [root flat half, crest flat half] as fractions of the pitch, for symmetric forms
  let crest: number;
  let root: number;
  switch (form) {
    case "iso":
      crest = 1 / 16;
      root = 1 / 8;
      break;
    case "trapezoid":
      crest = 0.183;
      root = 0.183;
      break;
    case "square":
      crest = 0.24;
      root = 0.24;
      break;
    case "buttress": {
      // asymmetric: a 45° clearance flank rising to the crest, then a steep (7°) load flank
      const rise = 0.6; // axial width of the 45° flank, in pitches (depth 0.6 p)
      const fall = 0.074; // 0.6 p × tan 7°
      const top = 0.16;
      const a = (1 - rise - fall - top) / 2;
      if (u < a) return rMin;
      if (u < a + rise) return rMin + ((u - a) / rise) * (rMaj - rMin);
      if (u < a + rise + top) return rMaj;
      if (u < a + rise + top + fall) return rMaj - ((u - a - rise - top) / fall) * (rMaj - rMin);
      return rMin;
    }
  }
  const x = Math.abs(u - 0.5); // distance from the crest centre, in pitches
  if (x <= crest) return rMaj;
  if (x >= 0.5 - root) return rMin;
  const t = (x - crest) / (0.5 - root - crest);
  return rMaj - t * (rMaj - rMin);
}

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

/** A thread body along +Z from z0 to z0 + length (external: the threaded rod; internal: the hole it cuts). */
function localThread(spec: ThreadSpec3, length: number, internal: boolean, z0: number): Shape3D {
  const lead = spec.pitch * spec.starts;
  const wire = threadSection(spec, internal);
  const sk = new R.Sketch(wire.translate([0, 0, z0]), { defaultOrigin: [0, 0, z0], defaultDirection: [0, 0, 1] });
  let s = sk.extrude(length, { twistAngle: (360 * length) / lead }) as Shape3D;
  if (spec.left) s = s.mirror("XZ", [0, 0, 0]);
  return s;
}

/** A cone along +Z from z0: radius r1 at z0, r2 at z0 + h. */
function cone(r1: number, r2: number, h: number, z0: number): Shape3D {
  const prof = R.draw([0, z0]).lineTo([r1, z0]).lineTo([r2, z0 + h]).lineTo([0, z0 + h]).close();
  return (prof.sketchOnPlane("XZ") as R.Sketch).revolve([0, 0, 1]) as Shape3D;
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
 * `lead` is an entry chamfer depth for internal threads (0 for none).
 */
export function buildThread(spec: ThreadSpec3, length: number, at: V3, dir: V3, internal: boolean, lead: number, detail: boolean): Shape3D {
  const d2 = pitchDiameter(spec);
  let local: Shape3D;
  if (internal) {
    const over = 0.05;
    local = detail ? localThread(spec, length + over, true, -over) : R.makeCylinder(d2 / 2 + spec.clearance, length + over, [0, 0, -over], [0, 0, 1]);
    if (lead > 0) {
      const r0 = Math.min(spec.d / 2 + spec.clearance + lead, spec.d);
      const rIn = minorDiameter(spec) / 2;
      local = local.fuse(cone(r0, rIn, r0 - rIn + over, -over));
    }
  } else {
    local = detail ? localThread(spec, length, false, 0) : R.makeCylinder(d2 / 2 - spec.clearance, length, [0, 0, 0], [0, 0, 1]);
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
