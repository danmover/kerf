// 2D profiles and 3D paths: turns Profile and Path3 recipes into replicad
// drawings and wires. Profiles are drawn in a frame's (u, v) plane and then
// extruded, swept, lofted or revolved by build.ts.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { framePoint, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type FontName, type Frame, type Path3, type Profile, type V2, type V3 } from "./recipe";

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
    case "slot2": {
      const dx = p.b[0] - p.a[0];
      const dy = p.b[1] - p.a[1];
      const len = Math.hypot(dx, dy);
      const d = R.drawRoundedRectangle(len + p.w, p.w, p.w / 2 - 1e-3);
      return d.rotate((Math.atan2(dy, dx) * 180) / Math.PI).translate((p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2);
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
        else pen = pen.smoothSplineTo(s.to);
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

export function extrudeProfile(p: Profile, h: number, f: Frame, twist: number, scale: number): Shape3D {
  const sk = sketchProfile(p, f);
  const opts: { twistAngle?: number; extrusionProfile?: { profile: "linear"; endFactor: number } } = {};
  if (Math.abs(twist) > 1e-9) opts.twistAngle = twist;
  if (Math.abs(scale - 1) > 1e-9) opts.extrusionProfile = { profile: "linear", endFactor: scale };
  return sk.extrude(h, opts) as Shape3D;
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

export function loftProfiles(secs: { p: Profile; f: Frame }[], ruled: boolean): Shape3D {
  const wires = secs.map((s, i) => {
    const regions = profileRegions(s.p, s.f);
    if (regions.length !== 1 || regions[0].inner.length) throw new ProfileError(`loft(): section ${i + 1} must be a single outline without holes`);
    return regions[0].outer;
  });
  return R.loft(wires, { ruled });
}

export { framePoint };
