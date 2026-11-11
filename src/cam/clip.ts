// Flat regions for toolpaths: unions, differences and offsets of loops in millimetres, worked in whole
// tenths of a micrometre by Clipper (the polygon library most CAM tools use), so offsets of offsets stay clean.

import * as ClipperNS from "clipper-lib";

const CL: typeof ClipperNS = (ClipperNS as unknown as { default?: typeof ClipperNS }).default ?? ClipperNS;

export type Pt = [number, number];
/** A closed loop (last point not repeated). */
export type Loop = Pt[];
/** An area: outer loops counter-clockwise, holes clockwise (as unions leave them). */
export type Region = Loop[];

/** tenths of a micrometre: offsets of offsets stay within a micrometre of where they should be */
const S = 10000;

const toPath = (l: Loop): ClipperNS.Path => l.map(([x, y]) => ({ X: Math.round(x * S), Y: Math.round(y * S) }));
const fromPath = (p: ClipperNS.Path): Loop => p.map((q) => [q.X / S, q.Y / S]);
const toPaths = (r: Region): ClipperNS.Paths => r.filter((l) => l.length >= 3).map(toPath);
const fromPaths = (p: ClipperNS.Paths): Region => p.filter((x) => x.length >= 3).map(fromPath);

function exec(type: ClipperNS.ClipType, a: ClipperNS.Paths, b: ClipperNS.Paths, fillA = CL.PolyFillType.pftNonZero, fillB = CL.PolyFillType.pftNonZero): ClipperNS.Paths {
  const c = new CL.Clipper();
  c.AddPaths(a, CL.PolyType.ptSubject, true);
  if (b.length) c.AddPaths(b, CL.PolyType.ptClip, true);
  const out: ClipperNS.Paths = [];
  c.Execute(type, out, fillA, fillB);
  return out;
}

/** Loops as an area, a point inside an odd number of them being inside (a section's outlines and holes). */
export const fromLoops = (loops: Loop[]): Region => fromPaths(exec(CL.ClipType.ctUnion, toPaths(loops), [], CL.PolyFillType.pftEvenOdd, CL.PolyFillType.pftEvenOdd));

export const union = (...rs: Region[]): Region => fromPaths(exec(CL.ClipType.ctUnion, toPaths(rs.flat()), []));
export const diff = (a: Region, b: Region): Region => (b.length ? fromPaths(exec(CL.ClipType.ctDifference, toPaths(a), toPaths(b))) : a);
export const inter = (a: Region, b: Region): Region => (a.length && b.length ? fromPaths(exec(CL.ClipType.ctIntersection, toPaths(a), toPaths(b))) : []);

/** The area grown (d > 0) or shrunk (d < 0) by d, with round corners as a tool's edge leaves them. */
export function offset(r: Region, d: number, arcTol = 0.002): Region {
  if (!r.length) return [];
  if (Math.abs(d) < 1e-9) return r;
  const co = new CL.ClipperOffset(2, arcTol * S);
  co.AddPaths(toPaths(r), CL.JoinType.jtRound, CL.EndType.etClosedPolygon);
  const out: ClipperNS.Paths = [];
  co.Execute(out, d * S);
  return fromPaths(out);
}

/** Signed area of a loop (counter-clockwise positive), mm². */
export function loopArea(l: Loop): number {
  let a = 0;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) a += (l[j][0] + l[i][0]) * (l[j][1] - l[i][1]);
  return -a / 2;
}

/** Area of a region (holes taken off), mm². */
export const area = (r: Region): number => r.reduce((s, l) => s + loopArea(l), 0);

/** Each outer loop with the holes inside it. */
export function islands(r: Region): { outer: Loop; holes: Loop[] }[] {
  const c = new CL.Clipper();
  c.AddPaths(toPaths(r), CL.PolyType.ptSubject, true);
  const tree = new CL.PolyTree();
  c.Execute(CL.ClipType.ctUnion, tree, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
  const out: { outer: Loop; holes: Loop[] }[] = [];
  const walk = (node: ClipperNS.PolyNode) => {
    for (const ch of node.Childs()) {
      if (ch.IsHole()) {
        for (const g of ch.Childs()) walk1(g);
      } else walk1(ch);
    }
  };
  const walk1 = (n: ClipperNS.PolyNode) => {
    out.push({ outer: fromPath(n.Contour()), holes: n.Childs().map((h) => fromPath(h.Contour())) });
    for (const h of n.Childs()) for (const g of h.Childs()) walk1(g);
  };
  walk(tree);
  return out;
}

/** Is the point inside the area (on its edge counts as inside)? */
export function inside(p: Pt, r: Region): boolean {
  const q = { X: Math.round(p[0] * S), Y: Math.round(p[1] * S) };
  let wn = 0;
  for (const l of r) {
    const res = CL.Clipper.PointInPolygon(q, toPath(l));
    if (res === -1) return true;
    if (res === 1) wn += loopArea(l) > 0 ? 1 : -1;
  }
  return wn > 0;
}

/** Open polylines cut to the parts inside the area (or outside it). */
export function clipLines(lines: Pt[][], r: Region, keepInside = true): Pt[][] {
  if (!lines.length) return [];
  if (!r.length) return keepInside ? [] : lines;
  const c = new CL.Clipper();
  for (const l of lines) if (l.length >= 2) c.AddPath(toPath(l), CL.PolyType.ptSubject, false);
  c.AddPaths(toPaths(r), CL.PolyType.ptClip, true);
  const tree = new CL.PolyTree();
  c.Execute(keepInside ? CL.ClipType.ctIntersection : CL.ClipType.ctDifference, tree, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
  return CL.Clipper.OpenPathsFromPolyTree(tree).map(fromPath);
}

/** Does the straight line from a to b stay inside the area? */
export function segmentInside(a: Pt, b: Pt, r: Region): boolean {
  if (!inside(a, r) || !inside(b, r)) return false;
  const outsidePart = clipLines([[a, b]], r, false);
  return outsidePart.every((l) => l.length < 2 || Math.hypot(l[l.length - 1][0] - l[0][0], l[l.length - 1][1] - l[0][1]) < 0.002);
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Region => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
];

/** Points closer than tol along a loop merged, so offsets do not carry tiny wiggles into G-code. */
export function cleanRegion(r: Region, tol = 0.002): Region {
  const paths = toPaths(r);
  return fromPaths(CL.Clipper.CleanPolygons(paths, tol * S));
}

/** Bounding box of an area. */
export function bounds(r: Region): { lo: Pt; hi: Pt } | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const l of r)
    for (const [x, y] of l) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  return x0 <= x1 ? { lo: [x0, y0], hi: [x1, y1] } : null;
}

/** Length of an open polyline, or of a loop when closed. */
export function pathLength(p: Pt[], closed: boolean): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  if (closed && p.length > 1) s += Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]);
  return s;
}
