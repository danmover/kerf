// Plane geometry shared by the placement check, the router, the pours, the
// rule check and the output files: where footprint points land on the board,
// pad and body outlines, and the distances between them.
//
// Every copper or body outline is one of two shapes: a segment with round ends
// (tracks, vias, round and oval pads, round bodies) or a convex polygon (rect
// pads and bodies). Distances between those two are all the checks need.

import type { BoardSpec, PlacedPart } from "./types";

export type Pt = [number, number];

export type Shape =
  /** segment a-b with round ends of radius r; a circle when a == b */
  | { k: "cap"; ax: number; ay: number; bx: number; by: number; r: number }
  /** convex polygon, counter-clockwise, flat [x0, y0, x1, y1, ...] */
  | { k: "poly"; p: number[] };

export const circle = (x: number, y: number, r: number): Shape => ({ k: "cap", ax: x, ay: y, bx: x, by: y, r });
export const capsule = (ax: number, ay: number, bx: number, by: number, r: number): Shape => ({ k: "cap", ax, ay, bx, by, r });

/** Rounds to a micrometre so footprint maths doesn't leave 19.999999999 behind. */
export const um = (v: number) => Math.round(v * 1e6) / 1e6;

export const normDeg = (d: number) => ((d % 360) + 360) % 360;

/** cos and sin of an angle in degrees, exact for multiples of 90. */
export function cosSin(deg: number): [number, number] {
  const d = normDeg(deg);
  if (d === 0) return [1, 0];
  if (d === 90) return [0, 1];
  if (d === 180) return [-1, 0];
  if (d === 270) return [0, -1];
  const a = (d * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
}

/**
 * Footprint coordinates to board coordinates. A bottom-side part is mirrored
 * left-right in its own frame first (it is drawn as seen from its own side),
 * then turned by `rot` counter-clockwise as seen from the top.
 */
export function partXf(part: Pick<PlacedPart, "x" | "y" | "rot" | "side">): (fx: number, fy: number) => Pt {
  const [c, s] = cosSin(part.rot);
  const m = part.side === "bottom" ? -1 : 1;
  return (fx, fy) => [um(part.x + c * m * fx - s * fy), um(part.y + s * m * fx + c * fy)];
}

// ---------------------------------------------------------------- distances

export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Whether two segments cross properly (touching ends show up as distance 0 anyway). */
function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segSegDist(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.sqrt(Math.min(segDist2(ax, ay, cx, cy, dx, dy), segDist2(bx, by, cx, cy, dx, dy), segDist2(cx, cy, ax, ay, bx, by), segDist2(dx, dy, ax, ay, bx, by)));
}

function inConvex(p: number[], x: number, y: number): boolean {
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    if (orient(p[i], p[i + 1], p[j], p[j + 1], x, y) < 0) return false;
  }
  return true;
}

function polyEdgeDist(p: number[], x: number, y: number): number {
  let best = Infinity;
  const n = p.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    best = Math.min(best, segDist2(x, y, p[i], p[i + 1], p[j], p[j + 1]));
  }
  return Math.sqrt(best);
}

/** Signed distance from a point to a shape: negative inside. */
export function shapeDist(s: Shape, x: number, y: number): number {
  if (s.k === "cap") return Math.sqrt(segDist2(x, y, s.ax, s.ay, s.bx, s.by)) - s.r;
  const d = polyEdgeDist(s.p, x, y);
  return inConvex(s.p, x, y) ? -d : d;
}

/** Gap between two shapes: negative when they overlap (-1 when the depth isn't worked out). */
export function shapeGap(a: Shape, b: Shape): number {
  if (a.k === "cap" && b.k === "cap") return segSegDist(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by) - a.r - b.r;
  if (a.k === "poly" && b.k === "cap") return shapeGap(b, a);
  if (a.k === "cap" && b.k === "poly") {
    const p = b.p;
    if (inConvex(p, a.ax, a.ay) || inConvex(p, a.bx, a.by)) return -1;
    let d = Infinity;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      d = Math.min(d, segSegDist(a.ax, a.ay, a.bx, a.by, p[i], p[i + 1], p[j], p[j + 1]));
    }
    return d - a.r;
  }
  const p = (a as { p: number[] }).p;
  const q = (b as { p: number[] }).p;
  for (let i = 0; i < p.length; i += 2) if (inConvex(q, p[i], p[i + 1])) return -1;
  for (let i = 0; i < q.length; i += 2) if (inConvex(p, q[i], q[i + 1])) return -1;
  let d = Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const i2 = (i + 2) % p.length;
    for (let j = 0; j < q.length; j += 2) {
      const j2 = (j + 2) % q.length;
      d = Math.min(d, segSegDist(p[i], p[i + 1], p[i2], p[i2 + 1], q[j], q[j + 1], q[j2], q[j2 + 1]));
    }
  }
  return d === 0 ? -1 : d;
}

export type BBox = [number, number, number, number];

export function shapeBox(s: Shape): BBox {
  if (s.k === "cap") return [Math.min(s.ax, s.bx) - s.r, Math.min(s.ay, s.by) - s.r, Math.max(s.ax, s.bx) + s.r, Math.max(s.ay, s.by) + s.r];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < s.p.length; i += 2) {
    x0 = Math.min(x0, s.p[i]);
    x1 = Math.max(x1, s.p[i]);
    y0 = Math.min(y0, s.p[i + 1]);
    y1 = Math.max(y1, s.p[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/** Polygon from corner points, turned counter-clockwise if they came clockwise (mirrored parts). */
export function convex(pts: Pt[]): Shape {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  const ordered = a < 0 ? [...pts].reverse() : pts;
  return { k: "poly", p: ordered.flat() };
}

// ---------------------------------------------------------------- pads and bodies

export interface PadGeom {
  x: number;
  y: number;
  shape: "circle" | "rect" | "oval";
  w: number;
  h: number;
  rot: number;
}

/** Copper outline of a pad in board coordinates, grown by `grow` on every side. */
export function padShape(p: PadGeom, grow = 0): Shape {
  const [c, s] = cosSin(p.rot);
  if (p.shape === "circle") return circle(p.x, p.y, Math.max(p.w, p.h) / 2 + grow);
  if (p.shape === "oval") {
    const long = Math.max(p.w, p.h);
    const short = Math.min(p.w, p.h);
    const half = (long - short) / 2;
    // the long side runs along the pad's local x when w is the larger
    const [ux, uy] = p.w >= p.h ? [c, s] : [-s, c];
    return capsule(p.x - ux * half, p.y - uy * half, p.x + ux * half, p.y + uy * half, short / 2 + grow);
  }
  const hw = p.w / 2 + grow;
  const hh = p.h / 2 + grow;
  const corner = (lx: number, ly: number): Pt => [p.x + c * lx - s * ly, p.y + s * lx + c * ly];
  return convex([corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)]);
}

/** Half sizes of a pad along its own x and y. */
export const padHalf = (p: PadGeom): [number, number] => (p.shape === "circle" ? [Math.max(p.w, p.h) / 2, Math.max(p.w, p.h) / 2] : [p.w / 2, p.h / 2]);

/** Outline of a part body in board coordinates, shrunk by `shrink` (overlap checks tolerate touching). */
export function bodyShape(part: PlacedPart, shrink = 0): Shape {
  const xf = partXf(part);
  const b = part.fp.body;
  if (b.shape === "circle") {
    const [x, y] = xf(b.cx, b.cy);
    return circle(x, y, Math.max(0, b.r - shrink));
  }
  const x0 = Math.min(b.x0, b.x1) + shrink;
  const x1 = Math.max(b.x0, b.x1) - shrink;
  const y0 = Math.min(b.y0, b.y1) + shrink;
  const y1 = Math.max(b.y0, b.y1) - shrink;
  return convex([xf(x0, y0), xf(x1, y0), xf(x1, y1), xf(x0, y1)]);
}

// ---------------------------------------------------------------- board outline

/** Distance from a point to the board outline, positive inside (rounded corners included). */
export function edgeDist(spec: Pick<BoardSpec, "w" | "h" | "corner">, x: number, y: number): number {
  const rc = Math.max(0, Math.min(spec.corner ?? 0, spec.w / 2, spec.h / 2));
  const dx = Math.abs(x - spec.w / 2) - (spec.w / 2 - rc);
  const dy = Math.abs(y - spec.h / 2) - (spec.h / 2 - rc);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return -(outside + inside - rc);
}

/**
 * Smallest distance from a shape to the outline, positive inside. The inside
 * distance of a convex outline is concave, so its minimum over a segment or a
 * polygon sits at an end or a corner.
 */
export function shapeEdgeDist(spec: Pick<BoardSpec, "w" | "h" | "corner">, s: Shape): number {
  if (s.k === "cap") return Math.min(edgeDist(spec, s.ax, s.ay), edgeDist(spec, s.bx, s.by)) - s.r;
  let d = Infinity;
  for (let i = 0; i < s.p.length; i += 2) d = Math.min(d, edgeDist(spec, s.p[i], s.p[i + 1]));
  return d;
}

/** Signed area of a ring, positive when counter-clockwise. */
export function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

/** Even-odd point in ring test. */
export function inRing(r: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Uniform buckets over the board for "what is near here" queries. */
export class Buckets<T> {
  readonly cells: T[][];
  readonly nx: number;
  readonly ny: number;
  constructor(
    w: number,
    h: number,
    readonly size: number,
  ) {
    this.nx = Math.max(1, Math.ceil(w / size) + 2);
    this.ny = Math.max(1, Math.ceil(h / size) + 2);
    this.cells = Array.from({ length: this.nx * this.ny }, () => []);
  }
  private range(b: BBox): [number, number, number, number] {
    const c = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(v / this.size) + 1));
    return [c(b[0], this.nx), c(b[1], this.ny), c(b[2], this.nx), c(b[3], this.ny)];
  }
  add(b: BBox, item: T) {
    const [i0, j0, i1, j1] = this.range(b);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * this.nx + i].push(item);
  }
  /** Items whose boxes may touch `b` (each at most once). */
  near(b: BBox, seen: Set<T> = new Set()): T[] {
    const [i0, j0, i1, j1] = this.range(b);
    const out: T[] = [];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        for (const it of this.cells[j * this.nx + i]) {
          if (seen.has(it)) continue;
          seen.add(it);
          out.push(it);
        }
    return out;
  }
}

export const grow = (b: BBox, d: number): BBox => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];
export const boxesTouch = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
