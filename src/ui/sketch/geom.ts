// Geometry for the sketch overlay: projecting sketch coordinates to the
// screen and back, sampling curves, snapping and inference.

import type { V2, V3 } from "../../kernel/recipe";
import { sampleEllipse, splinePolyline } from "../../sketch/curves";
import { toLocal, toWorld } from "../../sketch/planes";
import type { EvalSketch, Frame, SkCurve } from "../../sketch/types";

export interface Px {
  x: number;
  y: number;
}

export interface ScreenApi {
  toScreen(p: V3): { x: number; y: number; front: boolean };
  rayAt(x: number, y: number): { o: V3; d: V3 };
}

export class Projector {
  constructor(
    public api: ScreenApi,
    public f: Frame,
  ) {}
  S = (p: V2): Px => {
    const s = this.api.toScreen(toWorld(this.f, p[0], p[1]));
    return { x: s.x, y: s.y };
  };
  /** the point of the sketch plane under a pixel */
  toSketch(x: number, y: number): V2 | null {
    const { o, d } = this.api.rayAt(x, y);
    const n = this.f.n;
    const den = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((this.f.o[0] - o[0]) * n[0] + (this.f.o[1] - o[1]) * n[1] + (this.f.o[2] - o[2]) * n[2]) / den;
    if (t < 0) return null;
    return toLocal(this.f, [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
  }
  /** pixels per millimetre around a sketch point */
  scale(at: V2 = [0, 0]): number {
    const a = this.S(at);
    const b = this.S([at[0] + 1, at[1]]);
    const c = this.S([at[0], at[1] + 1]);
    return Math.max(1e-6, (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - a.x, c.y - a.y)) / 2);
  }
}

export const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
export const len = (a: V2) => Math.hypot(a[0], a[1]);
export const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const pxDist = (a: Px, b: Px) => Math.hypot(a.x - b.x, a.y - b.y);

/** Counter-clockwise arc from a to b around c. */
export function arcPoints(c: V2, a: V2, b: V2, stepDeg = 4): V2[] {
  const r = dist(a, c);
  const t0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let t1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  while (t1 <= t0 + 1e-9) t1 += 2 * Math.PI;
  const n = Math.max(6, Math.ceil(((t1 - t0) * 180) / Math.PI / stepDeg));
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / n;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as V2;
  });
}

export function circlePoints(c: V2, r: number, n = 72): V2[] {
  return Array.from({ length: n + 1 }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as V2);
}

/** Centre of the circle through three points (null when they are in line). */
export function circleThrough(a: V2, b: V2, m: V2): V2 | null {
  const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const m2 = m[0] ** 2 + m[1] ** 2;
  return [(a2 * (b[1] - m[1]) + b2 * (m[1] - a[1]) + m2 * (a[1] - b[1])) / d, (a2 * (m[0] - b[0]) + b2 * (a[0] - m[0]) + m2 * (b[0] - a[0])) / d];
}

/** True when going counter-clockwise from a to b around c passes through m. */
export function ccwThrough(c: V2, a: V2, b: V2, m: V2): boolean {
  const ang = (p: V2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return norm(ang(m) - ang(a)) < norm(ang(b) - ang(a));
}

export function closestOnSeg(p: V2, a: V2, b: V2): { q: V2; t: number } {
  const d = sub(b, a);
  const l2 = d[0] * d[0] + d[1] * d[1];
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2)) : 0;
  return { q: [a[0] + d[0] * t, a[1] + d[1] * t], t };
}

/** A nice rounding step for free coordinates: about four pixels, as 1, 2 or 5 × 10ⁿ. */
export function niceStep(pxPerMm: number): number {
  const raw = 4 / pxPerMm;
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}
export const roundTo = (v: number, step: number) => Math.round(v / step) * step;

// ---------------- positions ----------------

export type Positions = Record<string, V2>;

export function positionsOf(sk: EvalSketch): Positions {
  return Object.fromEntries(sk.points.map((p) => [p.id, [p.x, p.y] as V2]));
}

export function radiusOf(sk: EvalSketch, c: SkCurve, P: Positions, radii?: Record<string, number>): number {
  if (c.kind === "circle") return radii?.[c.id] ?? c.r ?? 0;
  return dist(P[c.pts[0]], P[c.pts[2]]);
}

/** Polyline for a curve in sketch coordinates. */
export function curvePoints(sk: EvalSketch, c: SkCurve, P: Positions, radii?: Record<string, number>): V2[] {
  if (c.kind === "line") return [P[c.pts[0]], P[c.pts[1]]];
  if (c.kind === "circle") return circlePoints(P[c.pts[0]], radiusOf(sk, c, P, radii));
  if (c.kind === "spline") {
    const pts = splinePolyline(c.pts.map((id) => P[id]), !!c.closed, 0.01);
    return c.closed && pts.length ? [...pts, pts[0]] : pts;
  }
  if (c.kind === "ellipse") {
    const pts = sampleEllipse({ c: P[c.pts[0]], rx: c.rx ?? 0, ry: c.ry ?? 0, rot: c.angle ?? 0 }, 120);
    return [...pts, pts[0]];
  }
  return arcPoints(P[c.pts[2]], P[c.pts[0]], P[c.pts[1]]);
}

/** Splines and ellipses: drawn and picked by their outline, but not cut, extended, offset or snapped onto. */
export const smoothKind = (c: SkCurve) => c.kind === "spline" || c.kind === "ellipse";

// ---------------- snapping ----------------

export interface Snap {
  /** sketch coordinates */
  p: V2;
  /** an existing point to reference by name */
  ref?: string;
  /** a curve the new point lies on (adds coincident) */
  on?: string;
  /** a line whose midpoint this is (adds midpoint) */
  mid?: string;
  /** alignment guides to draw, in sketch coordinates */
  guides: [V2, V2][];
  /** label next to the cursor: "end", "midpoint", "on l2"... */
  label?: string;
}

const REF_HIDDEN = new Set(["x_axis.end", "y_axis.end"]);

/**
 * What the cursor snaps to: existing points first, then line midpoints, then
 * curves and the axes, then alignment with other points, then a rounded
 * grid position.
 */
export function snapAt(sk: EvalSketch, P: Positions, proj: Projector, cursor: Px, raw: V2, opts: { exclude?: Set<string>; from?: V2; tol?: number } = {}): Snap {
  const tol = opts.tol ?? 10;
  const S = proj.S;
  const ex = opts.exclude ?? new Set<string>();
  // points
  let best: { d: number; snap: Snap } | null = null;
  for (const p of sk.points) {
    if (REF_HIDDEN.has(p.id) || ex.has(p.id)) continue;
    const q = P[p.id];
    const d = pxDist(S(q), cursor);
    if (d < tol && (!best || d < best.d)) best = { d, snap: { p: q, ref: p.id, guides: [], label: p.id === "origin" ? "origin" : p.implicit ? p.id.split(".").pop() : p.id } };
  }
  if (best) return best.snap;
  // midpoints
  for (const c of sk.curves) {
    if (c.kind !== "line" || c.pts.some((id) => ex.has(id))) continue;
    const m: V2 = mul(add(P[c.pts[0]], P[c.pts[1]]), 0.5);
    const d = pxDist(S(m), cursor);
    if (d < tol * 0.8 && (!best || d < best.d)) best = { d, snap: { p: m, mid: c.id, guides: [], label: `midpoint of ${c.id}` } };
  }
  if (best) return best.snap;
  // on curves (and the axes)
  const axes: [string, V2, V2][] = [
    ["x_axis", [-1e5, 0], [1e5, 0]],
    ["y_axis", [0, -1e5], [0, 1e5]],
  ];
  const onCandidates: { id: string; q: V2 }[] = [];
  for (const c of sk.curves) {
    if (c.pts.some((id) => ex.has(id)) || smoothKind(c)) continue;
    if (c.kind === "line") onCandidates.push({ id: c.id, q: closestOnSeg(raw, P[c.pts[0]], P[c.pts[1]]).q });
    else {
      const ctr = P[c.kind === "circle" ? c.pts[0] : c.pts[2]];
      const r = radiusOf(sk, c, P);
      const v = sub(raw, ctr);
      const l = len(v) || 1;
      const q: V2 = add(ctr, mul(v, r / l));
      if (c.kind === "arc" && !ccwThrough(ctr, P[c.pts[0]], P[c.pts[1]], q)) continue;
      onCandidates.push({ id: c.id, q });
    }
  }
  for (const [id, a, b] of axes) onCandidates.push({ id, q: closestOnSeg(raw, a, b).q });
  for (const o of onCandidates) {
    const d = pxDist(S(o.q), cursor);
    if (d < tol * 0.7 && (!best || d < best.d)) best = { d, snap: { p: o.q, on: o.id, guides: [], label: `on ${o.id}` } };
  }
  if (best) return best.snap;
  // free position: rounded, then aligned with other points (and with where the line started)
  const step = niceStep(proj.scale(raw));
  const p: V2 = [roundTo(raw[0], step), roundTo(raw[1], step)];
  const guides: [V2, V2][] = [];
  const cand = sk.points.filter((q) => !REF_HIDDEN.has(q.id) && !ex.has(q.id)).map((q) => P[q.id]);
  if (opts.from) cand.push(opts.from);
  let ax: { d: number; v: number; from: V2 } | null = null;
  let ay: { d: number; v: number; from: V2 } | null = null;
  for (const q of cand) {
    const sq = S(q);
    const dx = Math.abs(S([q[0], raw[1]]).x - cursor.x);
    const dy = Math.abs(S([raw[0], q[1]]).y - cursor.y);
    if (dx < 6 && (!ax || dx < ax.d) && pxDist(sq, cursor) > 12) ax = { d: dx, v: q[0], from: q };
    if (dy < 6 && (!ay || dy < ay.d) && pxDist(sq, cursor) > 12) ay = { d: dy, v: q[1], from: q };
  }
  if (ax) p[0] = ax.v;
  if (ay) p[1] = ay.v;
  if (ax) guides.push([ax.from, [p[0], p[1]]]);
  if (ay) guides.push([ay.from, [p[0], p[1]]]);
  return { p, guides };
}
