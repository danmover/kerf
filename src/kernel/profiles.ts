// 2D profiles and 3D paths: turns Profile and Path3 recipes into replicad
// drawings and wires. Profiles are drawn in a frame's (u, v) plane and then
// extruded, swept, lofted or revolved by build.ts.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { MAX_TAPER, framePoint, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type FontName, type Frame, type Path3, type Profile, type V2, type V3 } from "./recipe";


export class ProfileError extends Error {}

// ---------- fonts ----------

const loadedFonts = new Set<FontName>();

/** Register font data (TTF, OTF or WOFF) for text profiles. */
export async function loadFontData(name: FontName, data: ArrayBuffer) {
  if (loadedFonts.has(name)) return;
  await R.loadFont(data, name);
  loadedFonts.add(name);
}

export const fontLoaded = (name: FontName) => loadedFonts.has(name);

// ---------- profiles ----------

export function drawProfile(p: Profile): R.Drawing {
  switch (p.t) {
    case "circle":
      return R.drawCircle(p.d / 2).translate(p.c[0], p.c[1]);
    case "ellipse":
      return p.w >= p.h ? R.drawEllipse(p.w / 2, p.h / 2).translate(p.c[0], p.c[1]) : R.drawEllipse(p.h / 2, p.w / 2).rotate(90).translate(p.c[0], p.c[1]);
    case "rect":
      return (p.r > 1e-6 ? R.drawRoundedRectangle(p.w, p.h, Math.min(p.r, Math.min(p.w, p.h) / 2 - 1e-3)) : R.drawRectangle(p.w, p.h)).translate(p.c[0], p.c[1]);
    case "poly": {
      const d = polyline(p.pts);
      return p.r > 1e-6 ? d.fillet(p.r) : d;
    }
    case "text": {
      if (!loadedFonts.has(p.font)) throw new ProfileError(`The "${p.font}" font is not loaded yet`);
      const d = R.drawText(p.text, { fontSize: p.size, fontFamily: p.font });
      const bb = d.boundingBox;
      const [[x0, y0], [x1, y1]] = bb.bounds;
      if (!Number.isFinite(x0) || x1 - x0 < 1e-6) throw new ProfileError(`text("${p.text}") has no printable glyphs in the ${p.font} font (it covers Latin letters, digits and punctuation)`);
      const ax = p.align === "left" ? x0 : p.align === "right" ? x1 : (x0 + x1) / 2;
      return d.translate(p.c[0] - ax, p.c[1] - (y0 + y1) / 2);
    }
    case "path2": {
      let pen = R.draw(p.start);
      let last = p.start;
      for (const s of p.segs) {
        if (s.s === "line") pen = pen.lineTo(s.to);
        else if (s.s === "arc") pen = pen.threePointsArcTo(s.to, s.via);
        else pen = pen.cubicBezierCurveTo(s.to, s.c1, s.c2);
        last = s.to;
      }
      const closed = Math.hypot(last[0] - p.start[0], last[1] - p.start[1]) < 1e-6;
      return closed ? pen.done() : pen.close();
    }
    case "offset":
      return drawProfile(p.p).offset(p.d);
    case "fillet2":
      return drawProfile(p.p).fillet(p.r);
    case "union2": {
      let d = drawProfile(p.ps[0]);
      for (let i = 1; i < p.ps.length; i++) d = d.fuse(drawProfile(p.ps[i]));
      return d;
    }
    case "diff2": {
      let d = drawProfile(p.a);
      for (const b of p.b) d = d.cut(drawProfile(b));
      return d;
    }
    case "common2":
      return drawProfile(p.a).intersect(drawProfile(p.b));
    case "place2": {
      let d = drawProfile(p.p);
      if (p.rot) d = d.rotate(p.rot, [0, 0]);
      if (p.by[0] || p.by[1]) d = d.translate(p.by[0], p.by[1]);
      return d;
    }
  }
}

function polyline(pts: V2[]) {
  let pen = R.draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  return pen.close();
}

/** replicad plane for a frame: x along u, normal n. */
export function planeOf(f: Frame) {
  return new R.Plane(f.o, f.u, f.n);
}

type AnySketch = R.Sketch | R.CompoundSketch | R.Sketches;

export function sketchProfile(p: Profile, f: Frame): AnySketch {
  return drawProfile(p).sketchOnPlane(planeOf(f)) as AnySketch;
}

/** Outer and inner wires of each region of a placed profile. */
export function profileRegions(p: Profile, f: Frame): { outer: R.Wire; inner: R.Wire[] }[] {
  const sk = sketchProfile(p, f);
  const regions: { outer: R.Wire; inner: R.Wire[] }[] = [];
  const add = (s: R.Sketch | R.CompoundSketch) => {
    if (s instanceof R.CompoundSketch) regions.push({ outer: s.outerSketch.wire, inner: s.innerSketches.map((i) => i.wire) });
    else regions.push({ outer: s.wire, inner: [] });
  };
  if (sk instanceof R.Sketches) sk.sketches.forEach(add);
  else add(sk);
  return regions;
}

export function extrudeProfile(p: Profile, h: number, f: Frame, twist: number, scale: number, taper = 0): Shape3D {
  if (Math.abs(taper) > 1e-9) {
    if (Math.abs(twist) > 1e-9 || Math.abs(scale - 1) > 1e-9) throw new ProfileError("extrude(): taper can't be combined with twist or scale");
    return taperedExtrude(p, h, f, taper);
  }
  const sk = sketchProfile(p, f);
  const opts: { twistAngle?: number; extrusionProfile?: { profile: "linear"; endFactor: number } } = {};
  if (Math.abs(twist) > 1e-9) opts.twistAngle = twist;
  if (Math.abs(scale - 1) > 1e-9) opts.extrusionProfile = { profile: "linear", endFactor: scale };
  return sk.extrude(h, opts) as Shape3D;
}

/** True when OpenCASCADE's checker finds nothing wrong with the shape (a broken one makes later booleans fail). */
export function shapeValid(s: Shape3D): boolean {
  const oc = R.getOC();
  const check = new oc.BRepCheck_Analyzer(s.wrapped, true, false);
  try {
    return check.IsValid();
  } finally {
    check.delete();
  }
}

/**
 * OpenCASCADE's draft: tilts each face by `angle` degrees about its line on the neutral plane (through `origin`,
 * square to `pull`); a positive angle takes material away on the pull side. Faces tangent to one go with it.
 * Only flat, cylindrical and conical faces tilt: null when one of them can't, or the result is broken.
 */
export function draftFaces(shape: Shape3D, faces: R.Face[], angle: number, origin: V3, pull: V3): Shape3D | null {
  const oc = R.getOC();
  const b = new oc.BRepOffsetAPI_DraftAngle(shape.wrapped);
  const at = new oc.gp_Pnt(origin[0], origin[1], origin[2]);
  const n = vnorm(pull);
  const dir = new oc.gp_Dir(n[0], n[1], n[2]);
  const pln = new oc.gp_Pln(at, dir);
  try {
    for (const f of faces) {
      // (the kernel's default: tangent faces are tilted too, which is what lets round sides draft)
      b.Add(f.wrapped, dir, (angle * Math.PI) / 180, pln, true);
      if (!b.AddDone()) return null;
    }
    b.Build();
    if (!b.IsDone()) return null;
    const out = R.cast(b.ModifiedShape(shape.wrapped));
    return R.isShape3D(out) && shapeValid(out) ? out : null;
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) throw e;
    return null;
  } finally {
    b.delete();
    pln.delete();
    dir.delete();
    at.delete();
  }
}

/**
 * A straight extrusion whose sides lean in by `taper` degrees (out for a negative taper), measured from the
 * sketch plane: the draft a moulded or cast part needs to come out of its mould, or a tapered boss. Holes in the
 * profile open up as the outline closes in. Flat, round and conical sides are tilted exactly; others (ellipses,
 * splines) are made by skinning each outline to its offset copy at the far end.
 */
function taperedExtrude(p: Profile, h: number, f: Frame, taper: number): Shape3D {
  if (!(Math.abs(taper) < MAX_TAPER)) throw new ProfileError(`extrude(): taper must be between -${MAX_TAPER} and ${MAX_TAPER} degrees (got ${taper})`);
  const inset = Math.abs(h) * Math.tan((taper * Math.PI) / 180);
  const prism = sketchProfile(p, f).extrude(h) as Shape3D;
  const plane = planeOf(f);
  const sides = new R.FaceFinder().not((q) => q.parallelTo(plane)).find(prism);
  const drafted = draftFaces(prism, sides, taper, f.o, h < 0 ? vscale(f.n, -1) : f.n);
  if (drafted && volumeLeans(prism, drafted, taper)) {
    prism.delete();
    return drafted;
  }
  drafted?.delete();
  prism.delete();
  const shift = vscale(vnorm(f.n), h);
  try {
    const pieces = profileRegions(p, f).map(({ outer, inner }) => {
      let s = skinToOffset(outer, -inset, shift);
      for (const w of inner) s = s.cut(skinToOffset(w, inset, shift));
      return s;
    });
    let out = pieces[0];
    for (let i = 1; i < pieces.length; i++) out = out.fuse(pieces[i]);
    if (!shapeValid(out)) throw new ProfileError("the tapered solid came out broken");
    return out;
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) throw e;
    const mm = Math.round(inset * 100) / 100;
    throw new ProfileError(`extrude(): a ${taper}° taper over ${Math.round(Math.abs(h) * 100) / 100} mm moves every side ${taper > 0 ? "in" : "out"} by ${mm} mm, and the profile ${taper > 0 ? "closes up or turns inside out" : "runs into itself"} before the far end. Use a smaller taper or a shorter extrusion.`);
  }
}

/** A tapered solid lost material for a positive taper and gained it for a negative one (a broken draft does neither). */
function volumeLeans(prism: Shape3D, out: Shape3D, taper: number): boolean {
  const a = R.measureVolume(prism);
  const b = R.measureVolume(out);
  return b > 1e-9 && (taper > 0 ? b < a : b > a);
}

/** A closed outline skinned with straight lines to its copy grown by `out` (shrunk when negative) and moved by `shift`. */
function skinToOffset(w: R.Wire, out: number, shift: V3): Shape3D {
  const top = offsetLoop(w, out).translate(shift);
  return R.loft([w.clone(), top], { ruled: true }) as Shape3D;
}

/** A closed planar outline grown by `out` (shrunk when negative), corners kept sharp. */
function offsetLoop(w: R.Wire, out: number): R.Wire {
  if (Math.abs(out) < 1e-9) return w.clone();
  const size = (x: R.Wire) => {
    const b = x.boundingBox;
    return b.width + b.height + b.depth;
  };
  const before = size(w);
  // the kernel's sign depends on which way the outline runs: keep the copy that went the right way
  let o = w.clone().offset2D(out, "intersection");
  if (size(o) > before !== out > 0) {
    o.delete();
    o = w.clone().offset2D(-out, "intersection");
    if (size(o) > before !== out > 0) throw new ProfileError("the outline could not be offset");
  }
  return o;
}

export function revolveProfile2(p: Profile, f: Frame, angle: number): Shape3D {
  // the profile's u axis is the radius and v the axial direction: sketch in the plane (u, n)
  const radial = f.u;
  const axis = f.n;
  const normal = vcross(radial, axis);
  const sk = drawProfile(p).sketchOnPlane(new R.Plane(f.o, radial, normal)) as AnySketch;
  return sk.revolve(axis, { origin: f.o, angle: angle >= 360 ? undefined : angle } as { origin: V3; angle?: number }) as Shape3D;
}

// ---------- paths ----------

export function pathWire(p: Path3): R.Wire {
  switch (p.t) {
    case "poly":
      return R.assembleWire(roundedPolyline(p.pts, p.r));
    case "spline": {
      const e = R.makeBSplineApproximation(p.pts, { tolerance: 1e-3, degMax: 3, degMin: 3, smoothing: null });
      return R.assembleWire([e]);
    }
    case "helix": {
      const w = R.makeHelix(p.pitch, p.h, p.d / 2, p.at, p.dir, p.left);
      return w;
    }
    case "arc3":
      return R.assembleWire([R.makeThreePointArc(p.a, p.b, p.c)]);
  }
}

/** Unit tangent at the start of a path. */
export function pathStart(p: Path3): { at: V3; tangent: V3 } {
  const w = pathWire(p);
  const at = w.startPoint.toTuple() as V3;
  const t = vnorm(w.tangentAt(0).toTuple() as V3);
  return { at, tangent: t };
}

/** Straight segments joined by tangent arcs of radius r (r = 0 gives sharp corners). */
export function roundedPolyline(pts: V3[], r: number): R.Edge[] {
  const clean: V3[] = [pts[0]];
  for (const q of pts.slice(1)) if (vlen(vsub(q, clean[clean.length - 1])) > 1e-6) clean.push(q);
  if (clean.length < 2) throw new ProfileError("path(): needs at least two distinct points");
  const edges: R.Edge[] = [];
  let prev = clean[0];
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1];
    const b = clean[i];
    const c = clean[i + 1];
    const u = vnorm(vsub(a, b));
    const w = vnorm(vsub(c, b));
    const cos = Math.max(-1, Math.min(1, vdot(u, w)));
    const ang = Math.acos(cos);
    if (r <= 1e-9 || Math.PI - ang < 1e-6) {
      // sharp corner (or a straight continuation)
      if (vlen(vsub(b, prev)) > 1e-6) edges.push(R.makeLine(prev, b));
      prev = b;
      continue;
    }
    if (ang < 1e-3) throw new ProfileError("path(): the path doubles back on itself");
    const tlen = r / Math.tan(ang / 2);
    const lenIn = vlen(vsub(b, a));
    const lenOut = vlen(vsub(c, b));
    if (tlen > lenIn / (i === 1 ? 1 : 2) + 1e-6 || tlen > lenOut / (i === clean.length - 2 ? 1 : 2) + 1e-6) {
      throw new ProfileError(`path(): the bend radius ${round(r)} is too large for the corner at (${b.map(round).join(", ")}); the segments are too short`);
    }
    const p1 = vadd(b, vscale(u, tlen));
    const p2 = vadd(b, vscale(w, tlen));
    const bis = vnorm(vadd(u, w));
    const center = vadd(b, vscale(bis, r / Math.sin(ang / 2)));
    const mid = vadd(center, vscale(vnorm(vsub(b, center)), r));
    if (vlen(vsub(p1, prev)) > 1e-6) edges.push(R.makeLine(prev, p1));
    edges.push(R.makeThreePointArc(p1, mid, p2));
    prev = p2;
  }
  const end = clean[clean.length - 1];
  if (vlen(vsub(end, prev)) > 1e-6) edges.push(R.makeLine(prev, end));
  return edges;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Profile frame perpendicular to a path at its start. */
export function startFrame(path: Path3, rot: number): Frame {
  const { at, tangent } = pathStart(path);
  const n = tangent;
  let u: V3;
  if (Math.abs(n[2]) > 0.999) u = [1, 0, 0];
  else u = vnorm(vcross([0, 0, 1], n));
  if (rot) {
    const v = vcross(n, u);
    const a = (rot * Math.PI) / 180;
    u = vadd(vscale(u, Math.cos(a)), vscale(v, Math.sin(a)));
  }
  return { o: at, u, n };
}

export function sweepProfile(p: Profile, path: Path3, rot: number, frenet: boolean): Shape3D {
  const spine = pathWire(path);
  const f = startFrame(path, rot);
  const regions = profileRegions(p, f);
  // each outline and hole is a sweep and a boolean; the language stops more than this before it gets here
  const loops = regions.reduce((n, r) => n + 1 + r.inner.length, 0);
  if (loops > 8) throw new ProfileError(`sweep(): the profile has ${loops} outlines and holes; Kerf sweeps at most 8`);
  const cfg = { frenet: frenet || path.t === "helix", transitionMode: "round" as const };
  let out: Shape3D | null = null;
  for (const reg of regions) {
    let s = R.genericSweep(reg.outer, spine, cfg) as Shape3D;
    for (const inner of reg.inner) s = s.cut(R.genericSweep(inner, spine, cfg) as Shape3D);
    out = out ? out.fuse(s) : s;
  }
  if (!out) throw new ProfileError("sweep(): the profile is empty");
  return out;
}

export function loftProfiles(secs: { p: Profile; f: Frame }[], ruled: boolean, matched = false): Shape3D {
  let wires = secs.map((s, i) => {
    const regions = profileRegions(s.p, s.f);
    if (regions.length !== 1 || regions[0].inner.length) throw new ProfileError(`loft(): section ${i + 1} must be a single outline without holes`);
    return regions[0].outer;
  });
  if (!ruled && !matched) wires = matchedSections(wires, secs.map((s) => s.f)) ?? wires;
  const solid = matched && !ruled ? skin(wires) : R.loft(wires, { ruled });
  // lofts can come out inside out (negative volume), which breaks shell and booleans
  if (R.measureVolume(solid) < 0) return R.cast(solid.wrapped.Reversed()) as Shape3D;
  return solid;
}

/**
 * Rebuild loft sections as single smooth curves sampled at the same angles
 * around their centres, so the skin is one surface with no twist and no seams
 * between unlike outlines (circle to rounded square). Returns null when an
 * outline is not star-shaped around its centre, and the plain wires are used.
 */
function matchedSections(wires: R.Wire[], frames: Frame[]): R.Wire[] | null {
  const N = 96;
  const M = 360;
  const local = (k: number, q: V3): V2 => {
    const f = frames[k];
    const p = vsub(q, f.o);
    return [vdot(p, f.u), vdot(p, vcross(f.n, f.u))];
  };
  // exact circles stay as they are (things added on a loft's end then meet it exactly);
  // the other sections are sampled starting at the same angle and running the same way
  const circle = wires.map((w) => w.edges.length === 1 && String(w.edges[0].geomType) === "CIRCLE");
  if (circle.every(Boolean)) return null;
  let start = 0;
  let sense = 1;
  const c0 = circle.indexOf(true);
  if (c0 >= 0) {
    const w = wires[c0];
    const ctr = local(c0, w.edges[0].pointAt(0.5).toTuple() as V3);
    const a = local(c0, w.pointAt(0).toTuple() as V3);
    const b = local(c0, w.pointAt(0.25).toTuple() as V3);
    // the centre is halfway between opposite points of the circle
    const cx = (a[0] + ctr[0]) / 2;
    const cy = (a[1] + ctr[1]) / 2;
    start = Math.atan2(a[1] - cy, a[0] - cx);
    const turn = Math.atan2(b[1] - cy, b[0] - cx) - start;
    sense = Math.sin(turn) >= 0 ? 1 : -1;
  }
  const out: R.Wire[] = [];
  for (let k = 0; k < wires.length; k++) {
    const w = wires[k];
    if (circle[k]) {
      out.push(w);
      continue;
    }
    const f = frames[k];
    const v = vcross(f.n, f.u);
    // dense polyline of the outline in the section's (u, v) plane
    const poly: V2[] = [];
    for (let i = 0; i < M; i++) poly.push(local(k, w.pointAt(i / M).toTuple() as V3));
    let cx = 0;
    let cy = 0;
    let area = 0;
    for (let i = 0; i < M; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % M];
      const c = x0 * y1 - x1 * y0;
      area += c;
      cx += (x0 + x1) * c;
      cy += (y0 + y1) * c;
    }
    if (Math.abs(area) < 1e-9) return null;
    cx /= 3 * area;
    cy /= 3 * area;
    const pts: V3[] = [];
    for (let j = 0; j < N; j++) {
      const th = start + (sense * 2 * Math.PI * j) / N;
      const dx = Math.cos(th);
      const dy = Math.sin(th);
      // the ray from the centre must cross the outline exactly once
      const hits: number[] = [];
      for (let i = 0; i < M; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % M];
        const ex = bx - ax;
        const ey = by - ay;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((ax - cx) * ey - (ay - cy) * ex) / den;
        const sgm = ((ax - cx) * dy - (ay - cy) * dx) / den;
        // a ray through a polyline vertex touches both segments there: count it once
        if (t > 1e-9 && sgm >= -1e-9 && sgm <= 1 + 1e-9 && !hits.some((h) => Math.abs(h - t) < 1e-6)) hits.push(t);
      }
      if (hits.length !== 1) return null;
      const r = hits[0];
      pts.push(vadd(f.o, vadd(vscale(f.u, cx + r * dx), vscale(v, cy + r * dy))));
    }
    pts.push(pts[0]);
    out.push(R.assembleWire([R.makeBSplineApproximation(pts, { tolerance: 0.01, degMax: 3, degMin: 3, smoothing: null })]));
  }
  return out;
}

/**
 * Skin sections that already match edge for edge. The surfaces are kept cubic along the
 * skin: the kernel's default (up to degree 8 through many sections) makes later booleans
 * several times slower for no visible gain.
 */
function skin(wires: R.Wire[]): Shape3D {
  const oc = R.getOC();
  const b = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
  try {
    b.SetMaxDegree(3);
    for (const w of wires) b.AddWire(w.wrapped);
    b.Build();
    const shape = R.cast(b.Shape());
    if (!R.isShape3D(shape)) throw new ProfileError("loft(): could not skin the sections");
    return shape;
  } finally {
    b.delete();
  }
}

export { framePoint };
