// Sketch splines and ellipses as geometry: a spline passes through its points
// as a chain of cubic Bézier pieces (centripetal Catmull-Rom, so it never
// loops or cusps between points and moving one point only bends the curve
// near it); an ellipse has a centre, two radii and a turn. The profile, the
// kernel and the sketch editor all draw them from these.

import type { V2 } from "../kernel/recipe";

export interface Bez {
  a: V2;
  c1: V2;
  c2: V2;
  b: V2;
}

const sub = (p: V2, q: V2): V2 => [p[0] - q[0], p[1] - q[1]];
const add = (p: V2, q: V2): V2 => [p[0] + q[0], p[1] + q[1]];
const mul = (p: V2, k: number): V2 => [p[0] * k, p[1] * k];
const dist = (p: V2, q: V2) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/**
 * The Bézier pieces of a spline through `pts` (in order). Open: from the
 * first point to the last, with the ends running on naturally; closed: back
 * round to the first point. Points on top of each other are passed once.
 */
export function splineBeziers(pts: V2[], closed: boolean): Bez[] {
  const P: V2[] = [];
  for (const p of pts) if (!P.length || dist(P[P.length - 1], p) > 1e-9) P.push(p);
  if (closed && P.length > 1 && dist(P[0], P[P.length - 1]) <= 1e-9) P.pop();
  const n = P.length;
  if (n < 2) return [];
  if (n === 2 && !closed) {
    const d = sub(P[1], P[0]);
    return [{ a: P[0], c1: add(P[0], mul(d, 1 / 3)), c2: add(P[0], mul(d, 2 / 3)), b: P[1] }];
  }
  const at = (i: number): V2 => {
    if (closed) return P[((i % n) + n) % n];
    // past an open end: the point mirrored through the end, so the curve leaves it heading for its neighbour
    if (i < 0) return sub(mul(P[0], 2), P[1]);
    if (i >= n) return sub(mul(P[n - 1], 2), P[n - 2]);
    return P[i];
  };
  const out: Bez[] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    // centripetal knot spacing (square root of the chord)
    const d0 = Math.max(1e-9, Math.sqrt(dist(p0, p1)));
    const d1 = Math.max(1e-9, Math.sqrt(dist(p1, p2)));
    const d2 = Math.max(1e-9, Math.sqrt(dist(p2, p3)));
    // tangents scaled to this piece (Yuksel et al.)
    const m1 = add(sub(p2, p1), mul(sub(mul(sub(p1, p0), 1 / d0), mul(sub(p2, p0), 1 / (d0 + d1))), d1));
    const m2 = add(sub(p2, p1), mul(sub(mul(sub(p3, p2), 1 / d2), mul(sub(p3, p1), 1 / (d1 + d2))), d1));
    out.push({ a: p1, c1: add(p1, mul(m1, 1 / 3)), c2: sub(p2, mul(m2, 1 / 3)), b: p2 });
  }
  return out;
}

export function bezierAt(z: Bez, t: number): V2 {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  return [k0 * z.a[0] + k1 * z.c1[0] + k2 * z.c2[0] + k3 * z.b[0], k0 * z.a[1] + k1 * z.c1[1] + k2 * z.c2[1] + k3 * z.b[1]];
}

/** How many straight pieces draw a Bézier within about `tol` of the curve. */
export function bezierSteps(z: Bez, tol = 0.02): number {
  // the control polygon's bend bounds how far the curve leaves its chord
  const dd = Math.max(Math.hypot(z.a[0] - 2 * z.c1[0] + z.c2[0], z.a[1] - 2 * z.c1[1] + z.c2[1]), Math.hypot(z.c1[0] - 2 * z.c2[0] + z.b[0], z.c1[1] - 2 * z.c2[1] + z.b[1]));
  return Math.max(4, Math.min(64, Math.ceil(Math.sqrt((0.75 * dd) / Math.max(1e-6, tol)))));
}

/** Points along a Bézier, without its end point. */
export function sampleBezier(z: Bez, tol = 0.02): V2[] {
  const n = bezierSteps(z, tol);
  return Array.from({ length: n }, (_, i) => bezierAt(z, i / n));
}

/** The same piece run the other way. */
export const reverseBezier = (z: Bez): Bez => ({ a: z.b, c1: z.c2, c2: z.c1, b: z.a });

/** Signed area swept from the origin by a Bézier piece (positive counter-clockwise), exactly. */
export function bezierArea(z: Bez): number {
  const [x0, y0] = z.a;
  const [x1, y1] = z.c1;
  const [x2, y2] = z.c2;
  const [x3, y3] = z.b;
  return (x0 * (6 * y1 + 3 * y2 + y3) + x1 * (-6 * y0 + 3 * y2 + 3 * y3) + x2 * (-3 * y0 - 3 * y1 + 6 * y3) + x3 * (-y0 - 3 * y1 - 6 * y2)) / 20;
}

export interface EllipseGeom {
  c: V2;
  rx: number;
  ry: number;
  /** turn of the rx axis from the sketch's x axis, degrees counter-clockwise */
  rot: number;
}

export function ellipseAt(e: EllipseGeom, t: number): V2 {
  const r = (e.rot * Math.PI) / 180;
  const x = e.rx * Math.cos(t);
  const y = e.ry * Math.sin(t);
  return [e.c[0] + x * Math.cos(r) - y * Math.sin(r), e.c[1] + x * Math.sin(r) + y * Math.cos(r)];
}

/** Points round an ellipse, counter-clockwise from the end of its rx axis, without repeating the first. */
export function sampleEllipse(e: EllipseGeom, n = 96): V2[] {
  return Array.from({ length: n }, (_, i) => ellipseAt(e, (2 * Math.PI * i) / n));
}

/** The ellipse's own axes' ends: rx end, ry end, and their opposites. */
export function ellipseAxes(e: EllipseGeom): { major: [V2, V2]; minor: [V2, V2] } {
  return { major: [ellipseAt(e, 0), ellipseAt(e, Math.PI)], minor: [ellipseAt(e, Math.PI / 2), ellipseAt(e, (3 * Math.PI) / 2)] };
}

/** Nearest distance from p to a polyline (closed when `loop`). */
export function polyDistance(p: V2, poly: V2[], loop: boolean): number {
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i + (loop ? 0 : 1) < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/** The whole spline as one polyline (open: ends included). */
export function splinePolyline(pts: V2[], closed: boolean, tol = 0.02): V2[] {
  const zs = splineBeziers(pts, closed);
  const out = zs.flatMap((z) => sampleBezier(z, tol));
  if (!closed && zs.length) out.push(zs[zs.length - 1].b);
  return out;
}
