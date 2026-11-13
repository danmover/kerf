// Patterns beyond rows and circles: copies along a curve (each turned to
// follow it, or kept square), at a sketch's points, filling an area (square
// or staggered rows kept a margin inside its edge), and uneven spacing from a
// list of gaps. Each gives points (or one shape of all the copies) that an
// add, a cut or a for loop places, like polar() and grid() do.

import { Args } from "./args";
import { Fn, Obj, PathV, ProfileV, ShapeV, SketchObj, Vec, typeName, type Value } from "./values";
import type { Path3, Profile, ProfileRegion, ShapeRecipe, V2, V3, Xform } from "../kernel/recipe";
import { sampleSeg } from "../sketch/regions";
import { rotAxisAngle } from "../core/mates";

const def = (name: string, params: string[], impl: (a: Args) => Value, doc: string): [string, Fn] => [name, new Fn(name, (pos, named, ctx) => impl(new Args(name, pos, named, ctx, params)), doc)];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => scl(a, 1 / (len(a) || 1));

/** The most points a pattern gives (as polar() and grid() allow). */
const MAX_POINTS = 2000;

// ---------- curves ----------

/** A path as many short straight pieces (world mm): the kernel's curve, close enough to place copies along. */
export function pathPolyline(p: Path3): V3[] {
  switch (p.t) {
    case "poly":
      return roundCorners(p.pts, p.r);
    case "spline":
      return catmullRom(p.pts);
    case "helix": {
      const turns = p.h / p.pitch;
      const n = Math.max(16, Math.ceil(turns * 96));
      const d = unit(p.dir);
      const e = Math.abs(d[2]) < 0.9 ? ([0, 0, 1] as V3) : ([1, 0, 0] as V3);
      const u = unit(cross(e, d));
      const v = cross(d, u);
      const r = p.d / 2;
      return Array.from({ length: n + 1 }, (_, i) => {
        const t = (i / n) * turns * 2 * Math.PI * (p.left ? -1 : 1);
        return add(p.at, add(add(scl(u, r * Math.cos(t)), scl(v, r * Math.sin(t))), scl(d, (p.h * i) / n)));
      });
    }
    case "arc3": {
      // the circle through three points, from a through b to c
      const { a, b, c } = p;
      const ab = sub(b, a),
        ac = sub(c, a);
      const n = cross(ab, ac);
      const nn = dot(n, n);
      const centre = add(a, scl(add(scl(cross(n, ab), dot(ac, ac)), scl(cross(ac, n), dot(ab, ab))), 1 / (2 * nn)));
      const x = unit(sub(a, centre));
      const y = unit(cross(unit(n), x));
      const r = len(sub(a, centre));
      const ang = (q: V3) => {
        const w = sub(q, centre);
        const t = Math.atan2(dot(w, y), dot(w, x));
        return t < 0 ? t + 2 * Math.PI : t;
      };
      const end = ang(c);
      const k = Math.max(8, Math.ceil((end / Math.PI) * 90));
      return Array.from({ length: k + 1 }, (_, i) => add(centre, add(scl(x, r * Math.cos((end * i) / k)), scl(y, r * Math.sin((end * i) / k)))));
    }
  }
}

/** Straight runs through the points with each bend rounded to radius r (tangent arcs, as the kernel builds them). */
function roundCorners(pts: V3[], r: number): V3[] {
  if (!(r > 0) || pts.length < 3) return pts.slice();
  const out: V3[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const a = unit(sub(pts[i - 1], p)),
      b = unit(sub(pts[i + 1], p));
    const cosT = Math.max(-1, Math.min(1, dot(a, b)));
    const half = Math.acos(cosT) / 2;
    if (half < 1e-6 || Math.PI / 2 - half < 1e-6) {
      out.push(p);
      continue;
    }
    // the arc's ends sit r / tan(half) from the corner, no further than half of either run
    const cut = Math.min(r / Math.tan(half), len(sub(pts[i - 1], p)) / 2, len(sub(pts[i + 1], p)) / 2);
    const rr = cut * Math.tan(half);
    const s = add(p, scl(a, cut)),
      e = add(p, scl(b, cut));
    const centre = add(p, scl(unit(add(a, b)), rr / Math.sin(half)));
    const k = 12;
    const u0 = sub(s, centre),
      u1 = sub(e, centre);
    const sweep = Math.acos(Math.max(-1, Math.min(1, dot(unit(u0), unit(u1)))));
    const w = unit(cross(u0, u1));
    for (let j = 0; j <= k; j++) {
      const t = (sweep * j) / k;
      // u0 turned by t about w
      const q = add(add(scl(u0, Math.cos(t)), scl(cross(w, u0), Math.sin(t))), scl(w, dot(w, u0) * (1 - Math.cos(t))));
      out.push(add(centre, q));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** A smooth curve through the points (centripetal Catmull–Rom), close to the kernel's spline through them. */
function catmullRom(pts: V3[]): V3[] {
  if (pts.length < 3) return pts.slice();
  const P = [sub(scl(pts[0], 2), pts[1]), ...pts, sub(scl(pts[pts.length - 1], 2), pts[pts.length - 2])];
  const out: V3[] = [pts[0]];
  const k = 24;
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const t01 = Math.sqrt(len(sub(p1, p0))) || 1e-9,
      t12 = Math.sqrt(len(sub(p2, p1))) || 1e-9,
      t23 = Math.sqrt(len(sub(p3, p2))) || 1e-9;
    const m1 = scl(add(sub(scl(sub(p1, p0), 1 / t01), scl(sub(p2, p0), 1 / (t01 + t12))), scl(sub(p2, p1), 1 / t12)), t12);
    const m2 = scl(add(sub(scl(sub(p2, p1), 1 / t12), scl(sub(p3, p1), 1 / (t12 + t23))), scl(sub(p3, p2), 1 / t23)), t12);
    for (let j = 1; j <= k; j++) {
      const t = j / k,
        t2 = t * t,
        t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1,
        h10 = t3 - 2 * t2 + t,
        h01 = -2 * t3 + 3 * t2,
        h11 = t3 - t2;
      out.push(add(add(scl(p1, h00), scl(m1, h10)), add(scl(p2, h01), scl(m2, h11))));
    }
  }
  return out;
}

export interface PathSpot {
  p: V3;
  /** the way the path runs there */
  t: V3;
  /** square to t, turned along the path as little as it can be (a rotation-minimising frame) */
  n: V3;
}

/**
 * Spots spaced evenly by length along a path, from `from` to `to` (shares of its length): n of them (both ends
 * included, or n spread round a closed path), or one every `every` mm. Each with the way the path runs and a
 * square direction carried along it without twisting (starting as near `up` as it can).
 */
export function pathSpots(path: Path3, opts: { n?: number; every?: number; from?: number; to?: number; up?: V3 }): PathSpot[] | string {
  const pts = pathPolyline(path);
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = L[L.length - 1];
  if (!(total > 1e-9)) return "the path has no length";
  const closed = len(sub(pts[0], pts[pts.length - 1])) < 1e-6 * Math.max(1, total);
  const s0 = (opts.from ?? 0) * total,
    s1 = (opts.to ?? 1) * total;
  let at: number[];
  if (opts.every !== undefined) {
    const k = Math.floor((s1 - s0) / opts.every + 1e-9);
    if (k + 1 > MAX_POINTS) return `that is ${k + 1} copies; a pattern takes up to ${MAX_POINTS}`;
    at = Array.from({ length: k + 1 }, (_, i) => s0 + i * opts.every!);
  } else {
    const n = opts.n ?? 2;
    // round a closed path the last copy would sit on the first
    const whole = closed && (opts.from ?? 0) === 0 && (opts.to ?? 1) === 1;
    at = Array.from({ length: n }, (_, i) => (n === 1 ? s0 : s0 + ((s1 - s0) * i) / (whole ? n : n - 1)));
  }
  // tangents per piece, and the frame carried along the pieces (double reflection, Wang et al. 2008)
  const tans: V3[] = [];
  for (let i = 0; i + 1 < pts.length; i++) tans.push(unit(sub(pts[i + 1], pts[i])));
  const up = unit(opts.up ?? [0, 0, 1]);
  let n0 = sub(up, scl(tans[0], dot(up, tans[0])));
  if (len(n0) < 1e-6) {
    const alt: V3 = Math.abs(tans[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    n0 = sub(alt, scl(tans[0], dot(alt, tans[0])));
  }
  const norms: V3[] = [unit(n0)];
  for (let i = 1; i < tans.length; i++) {
    const v1 = sub(pts[i], pts[i - 1]);
    const c1 = dot(v1, v1) || 1e-18;
    const rL = sub(norms[i - 1], scl(v1, (2 / c1) * dot(v1, norms[i - 1])));
    const tL = sub(tans[i - 1], scl(v1, (2 / c1) * dot(v1, tans[i - 1])));
    const v2 = sub(tans[i], tL);
    const c2 = dot(v2, v2);
    norms.push(unit(c2 > 1e-18 ? sub(rL, scl(v2, (2 / c2) * dot(v2, rL))) : rL));
  }
  let j = 0;
  return at.map((s) => {
    const q = Math.max(0, Math.min(total, s));
    while (j + 1 < L.length - 1 && L[j + 1] < q) j++;
    while (j > 0 && L[j] > q) j--;
    const seg = L[j + 1] - L[j] || 1;
    const f = (q - L[j]) / seg;
    const p = add(pts[j], scl(sub(pts[j + 1], pts[j]), f));
    return { p, t: tans[Math.min(j, tans.length - 1)], n: norms[Math.min(j, norms.length - 1)] };
  });
}

// ---------- areas ----------

/** Signed distance from a profile's edge (negative inside), mm, in the profile's own (x, y). */
export function profileDistance(pr: Profile, x: number, y: number): number {
  switch (pr.t) {
    case "circle":
      return Math.hypot(x - pr.c[0], y - pr.c[1]) - pr.d / 2;
    case "ellipse": {
      // the scaled distance, near enough for keeping copies inside
      const a = pr.w / 2,
        b = pr.h / 2;
      const k = Math.hypot((x - pr.c[0]) / a, (y - pr.c[1]) / b);
      return (k - 1) * Math.min(a, b);
    }
    case "rect": {
      const r = Math.min(pr.r, pr.w / 2, pr.h / 2);
      const qx = Math.abs(x - pr.c[0]) - (pr.w / 2 - r),
        qy = Math.abs(y - pr.c[1]) - (pr.h / 2 - r);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    }
    case "poly":
      return polygonDistance([pr.pts], x, y);
    case "path2":
      return polygonDistance([pathLoop(pr)], x, y);
    case "offset":
      return profileDistance(pr.p, x, y) - pr.d;
    case "fillet2":
      return profileDistance(pr.p, x, y);
    case "union2":
      return Math.min(...pr.ps.map((q) => profileDistance(q, x, y)));
    case "diff2":
      return Math.max(profileDistance(pr.a, x, y), ...pr.b.map((q) => -profileDistance(q, x, y)));
    case "common2":
      return Math.max(profileDistance(pr.a, x, y), profileDistance(pr.b, x, y));
    case "place2": {
      // undo the move, then the turn
      const c = Math.cos((-pr.rot * Math.PI) / 180),
        s = Math.sin((-pr.rot * Math.PI) / 180);
      const px = x - pr.by[0],
        py = y - pr.by[1];
      return profileDistance(pr.p, px * c - py * s, px * s + py * c);
    }
    case "text":
      return NaN;
  }
}

function pathLoop(pr: Extract<Profile, { t: "path2" }>): V2[] {
  const out: V2[] = [pr.start];
  let cur = pr.start;
  for (const s of pr.segs) {
    if (s.s === "line") out.push(s.to);
    else if (s.s === "arc") out.push(...sampleSeg({ k: "a", a: cur, m: s.via, b: s.to }).slice(1), s.to);
    else out.push(...sampleSeg({ k: "b", a: cur, c1: s.c1, c2: s.c2, b: s.to }).slice(1), s.to);
    cur = s.to;
  }
  return out;
}

/** Signed distance to closed loops (even-odd inside), mm. */
function polygonDistance(loops: V2[][], x: number, y: number): number {
  let d = Infinity;
  let inside = false;
  for (const l of loops)
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      const [ax, ay] = l[j],
        [bx, by] = l[i];
      const ex = bx - ax,
        ey = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
      d = Math.min(d, Math.hypot(x - ax - t * ex, y - ay - t * ey));
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    }
  return inside ? -d : d;
}

/** The bounding box of a profile (x0, y0, x1, y1), by sampling where it is cheap to say. */
function profileBox(pr: Profile): [number, number, number, number] | null {
  switch (pr.t) {
    case "circle":
      return [pr.c[0] - pr.d / 2, pr.c[1] - pr.d / 2, pr.c[0] + pr.d / 2, pr.c[1] + pr.d / 2];
    case "ellipse":
    case "rect":
      return [pr.c[0] - pr.w / 2, pr.c[1] - pr.h / 2, pr.c[0] + pr.w / 2, pr.c[1] + pr.h / 2];
    case "poly":
    case "path2": {
      const pts = pr.t === "poly" ? pr.pts : pathLoop(pr);
      return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    }
    case "offset": {
      const b = profileBox(pr.p);
      return b && [b[0] - Math.max(0, pr.d), b[1] - Math.max(0, pr.d), b[2] + Math.max(0, pr.d), b[3] + Math.max(0, pr.d)];
    }
    case "fillet2":
      return profileBox(pr.p);
    case "union2": {
      const bs = pr.ps.map(profileBox);
      if (bs.some((b) => !b)) return null;
      return [Math.min(...bs.map((b) => b![0])), Math.min(...bs.map((b) => b![1])), Math.max(...bs.map((b) => b![2])), Math.max(...bs.map((b) => b![3]))];
    }
    case "diff2":
      return profileBox(pr.a);
    case "common2":
      return profileBox(pr.a);
    case "place2": {
      const b = profileBox(pr.p);
      if (!b) return null;
      const c = Math.cos((pr.rot * Math.PI) / 180),
        s = Math.sin((pr.rot * Math.PI) / 180);
      const cs = [
        [b[0], b[1]],
        [b[2], b[1]],
        [b[0], b[3]],
        [b[2], b[3]],
      ].map(([x, y]) => [x * c - y * s + pr.by[0], x * s + y * c + pr.by[1]]);
      return [Math.min(...cs.map((q) => q[0])), Math.min(...cs.map((q) => q[1])), Math.max(...cs.map((q) => q[0])), Math.max(...cs.map((q) => q[1]))];
    }
    case "text":
      return null;
  }
}

/**
 * Grid points inside an area, at least `margin` in from its edge: square rows or staggered (hex) ones, turned by
 * angle. With no origin given, the grid sits on the area's middle, shifted half a pitch either way where that fits
 * more copies in.
 */
export function fillGrid(inside: (x: number, y: number) => number, box: [number, number, number, number], pitch: number, opts: { hex: boolean; margin: number; angle: number; origin?: V2 }): V2[] | string {
  if (opts.origin) return gridIn(inside, box, pitch, { ...opts, origin: opts.origin });
  const mid: V2 = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const row = opts.hex ? (pitch * Math.sqrt(3)) / 2 : pitch;
  const c = Math.cos((opts.angle * Math.PI) / 180),
    s = Math.sin((opts.angle * Math.PI) / 180);
  let best: V2[] | string = [];
  for (const [dx, dy] of [
    [0, 0],
    [0.5, 0],
    [0, 0.5],
    [0.5, 0.5],
  ]) {
    const gx = dx * pitch,
      gy = dy * row;
    const got = gridIn(inside, box, pitch, { ...opts, origin: [mid[0] + gx * c - gy * s, mid[1] + gx * s + gy * c] });
    if (typeof got === "string") return got;
    if (typeof best === "string" || got.length > best.length) best = got;
  }
  return best;
}

function gridIn(inside: (x: number, y: number) => number, box: [number, number, number, number], pitch: number, opts: { hex: boolean; margin: number; angle: number; origin: V2 }): V2[] | string {
  const [x0, y0, x1, y1] = box;
  const row = opts.hex ? (pitch * Math.sqrt(3)) / 2 : pitch;
  const c = Math.cos((opts.angle * Math.PI) / 180),
    s = Math.sin((opts.angle * Math.PI) / 180);
  // the grid's own axes: the box corners in them bound the rows and columns to try
  const toGrid = (x: number, y: number): V2 => [(x - opts.origin[0]) * c + (y - opts.origin[1]) * s, -(x - opts.origin[0]) * s + (y - opts.origin[1]) * c];
  const corners = [toGrid(x0, y0), toGrid(x1, y0), toGrid(x0, y1), toGrid(x1, y1)];
  const gx0 = Math.min(...corners.map((q) => q[0])),
    gx1 = Math.max(...corners.map((q) => q[0]));
  const gy0 = Math.min(...corners.map((q) => q[1])),
    gy1 = Math.max(...corners.map((q) => q[1]));
  const j0 = Math.floor(gy0 / row) - 1,
    j1 = Math.ceil(gy1 / row) + 1;
  const i0 = Math.floor(gx0 / pitch) - 1,
    i1 = Math.ceil(gx1 / pitch) + 1;
  if ((j1 - j0 + 1) * (i1 - i0 + 1) > 400_000) return `a pitch of ${pitch} mm is far too fine for an area this size`;
  const out: V2[] = [];
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const gx = (i + (opts.hex && j % 2 !== 0 ? 0.5 : 0)) * pitch,
        gy = j * row;
      const x = opts.origin[0] + gx * c - gy * s,
        y = opts.origin[1] + gx * s + gy * c;
      if (inside(x, y) <= -opts.margin + 1e-9) {
        out.push([x, y]);
        if (out.length > MAX_POINTS) return `that is more than ${MAX_POINTS} copies: use a larger pitch`;
      }
    }
  return out;
}

/** A sketch's closed regions as loops (sketch coordinates), the outer one and its holes together. */
function regionLoops(regions: ProfileRegion[]): V2[][] {
  return regions.flatMap((r) => [r.outer, ...r.holes].map((loop) => loop.flatMap((sg) => sampleSeg(sg))));
}

// ---------- functions ----------

const pt = (p: V3) => new Vec([p[0], p[1], p[2]]);

function pathArg(a: Args): Path3 {
  const v = a.value("path");
  if (v instanceof PathV) return v.recipe;
  if (Array.isArray(v) && v.length >= 2 && v.every((x) => x instanceof Vec)) return { t: "poly", pts: v.map((x) => (x as Vec).v3()), r: 0 };
  return a.ctx.error(`${a.fname}(): path should be a path such as path([...], r: 5), spline_path([...]), helix(...) or arc_path(...), or a list of points; got ${v === undefined ? "nothing" : typeName(v)}`);
}

function spotsArg(a: Args): PathSpot[] {
  const path = pathArg(a);
  const share = (name: string, d: number) => {
    const s = a.num(name, d);
    if (s < 0 || s > 1) a.ctx.error(`${a.fname}(): ${name}: is a share of the path's length, 0 to 100%`);
    return s;
  };
  const from = share("from", 0),
    to = share("to", 1);
  if (to <= from) a.ctx.error(`${a.fname}(): to: must be further along than from:`);
  if (a.has("n") === a.has("spacing")) a.ctx.error(`${a.fname}(): give how many copies (n) or the spacing between them (spacing:), one of the two`);
  const n = a.has("n") ? Math.round(a.num("n")) : undefined;
  if (n !== undefined && (n < 1 || n > MAX_POINTS)) a.ctx.error(`${a.fname}(): n must be 1..${MAX_POINTS}`);
  const every = a.has("spacing") ? a.positive("spacing") : undefined;
  const spots = pathSpots(path, { n, every, from, to, up: a.has("up") ? a.dir("up") : undefined });
  if (typeof spots === "string") return a.ctx.error(`${a.fname}(): ${spots}`);
  return spots;
}

/** The turn that takes x to t and z to n (both unit and square), as one rotation about the origin. */
function turnTo(t: V3, n: V3): Xform | null {
  const y = cross(n, t);
  // columns t, y, n: the copy's own x, y and z
  const R = [t[0], y[0], n[0], t[1], y[1], n[1], t[2], y[2], n[2]];
  const { axis, angle } = rotAxisAngle(R);
  return angle > 1e-10 ? { op: "rotate", angle: (angle * 180) / Math.PI, axis, origin: [0, 0, 0] } : null;
}

export const PATTERN_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "path_points",
    ["path", "n", "spacing", "from", "to"],
    (a) => spotsArg(a).map((s) => pt(s.p)),
    "path_points(path, n, spacing:, from: 0%, to: 100%) → points spread evenly by length along a path (path(), spline_path(), helix(), arc_path() or a list of points): n of them, ends included (round a closed path, n spread all the way), or one every spacing: mm; from:/to: take part of it. For holes or bosses along a curve: for p in path_points(rim, 12) { cut cylinder(d: 4, h: 10, at: p) }.",
  ),
  def(
    "path_directions",
    ["path", "n", "spacing", "from", "to"],
    (a) => spotsArg(a).map((s) => pt(s.t)),
    "path_directions(path, n, …) → the way the path runs at each of path_points(path, n, …), as unit directions, for turning copies to follow it in a loop.",
  ),
  def(
    "along_path",
    ["shape", "path", "n", "spacing", "from", "to", "align", "up"],
    (a) => {
      const shape = a.shape("shape").recipe;
      const spots = spotsArg(a);
      const align = a.bool("align", true);
      const copies: ShapeRecipe[] = spots.map((s) => {
        const xf: Xform[] = [];
        const turn = align ? turnTo(s.t, s.n) : null;
        if (turn) xf.push(turn);
        xf.push({ op: "translate", v: s.p });
        return { t: "xform", shape, xf };
      });
      return new ShapeV(copies.length === 1 ? copies[0] : { t: "union", shapes: copies });
    },
    "along_path(shape, path, n, spacing:, from:, to:, align: true, up: Z) → copies of a shape drawn at the origin, placed along a path (a curve-driven pattern): with align, each copy's +X turns to run along the path and its +Z starts as near up: as it can and turns with the path without twisting (teeth round a curved rack, links along a track, rungs up a helix); align: false keeps every copy square to the world. One shape of all the copies, for add or cut.",
  ),
  def(
    "fill_points",
    ["area", "pitch", "layout", "margin", "angle", "at", "z"],
    (a) => {
      const v = a.value("area");
      const pitch = a.positive("pitch");
      const hex = a.oneOf("layout", ["square", "hex"] as const, "square") === "hex";
      const margin = a.num("margin", 0);
      const angle = a.num("angle", 0);
      if (v instanceof SketchObj) {
        const loops = regionLoops(v.geom.regions);
        if (!loops.length) return a.ctx.error(`fill_points(): sketch ${v.label} has no closed region to fill${v.geom.profileError ? ` (${v.geom.profileError})` : ""}`);
        const all = loops.flat();
        const box: [number, number, number, number] = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
        const at = a.has("at") ? a.vec3("at") : undefined;
        const f = v.geom.frame;
        // a grid origin given in the world is put into the sketch's own plane
        const origin: V2 | undefined = at ? [dot(sub(at, f.o), f.u), dot(sub(at, f.o), f.v)] : undefined;
        const got = fillGrid((x, y) => polygonDistance(loops, x, y), box, pitch, { hex, margin, angle, origin });
        if (typeof got === "string") return a.ctx.error(`fill_points(): ${got}`);
        return got.map(([x, y]) => pt(add(f.o, add(scl(f.u, x), scl(f.v, y)))));
      }
      if (v instanceof ProfileV) {
        const box = profileBox(v.recipe);
        if (!box || Number.isNaN(profileDistance(v.recipe, 0, 0))) return a.ctx.error("fill_points(): text cannot be filled; use rect(), circle(), polygon(), a path profile or a sketch");
        const at = a.has("at") ? a.vec3("at") : undefined;
        const origin: V2 | undefined = at ? [at[0], at[1]] : undefined;
        const got = fillGrid((x, y) => profileDistance(v.recipe, x, y), box, pitch, { hex, margin, angle, origin });
        if (typeof got === "string") return a.ctx.error(`fill_points(): ${got}`);
        const z = a.num("z", 0);
        return got.map(([x, y]) => pt([x, y, z]));
      }
      return a.ctx.error(`fill_points(): area should be a profile (rect(), circle(), polygon(), a path profile, or their unions and differences) or a sketch, got ${v === undefined ? "nothing" : typeName(v)}`);
    },
    'fill_points(area, pitch, layout: "square", margin: 0, angle: 0, at:, z: 0) → points filling an area (a fill pattern): a profile in the XY plane at height z:, or a sketch\'s closed regions on its own plane (holes in them stay empty). layout: "hex" staggers the rows (the tightest packing, for vents and speaker grilles); margin: keeps each point that far inside the edge (a hole\'s radius plus the wall you want); angle: turns the rows; at: puts a grid point there (left out, the grid sits on the middle of the area, shifted half a pitch where that fits more in). Then: for p in fill_points(rect(80, 50), 6, layout: "hex", margin: 4) { cut cylinder(d: 4, h: 10, at: p) }.',
  ),
  def(
    "sketch_points",
    ["sketch", "centers", "ends"],
    (a) => {
      const v = a.value("sketch");
      if (!(v instanceof SketchObj)) return a.ctx.error(`sketch_points(): give a sketch, got ${v === undefined ? "nothing" : typeName(v)}`);
      const centers = a.bool("centers", true);
      const ends = a.bool("ends", false);
      const out: V3[] = [];
      const near = (p: V3) => out.some((q) => len(sub(p, q)) < 1e-6);
      const push = (p: V3) => !near(p) && out.push(p);
      const curveEnds: V3[] = [];
      const curveCentres: V3[] = [];
      for (const [k, f] of Object.entries(v.fields)) {
        if (k === "x_axis" || k === "y_axis" || !(f instanceof Obj)) continue;
        for (const key of ["start", "end"]) if (f.fields[key] instanceof Vec) curveEnds.push((f.fields[key] as Vec).v3());
        if (f.fields.center instanceof Vec) curveCentres.push((f.fields.center as Vec).v3());
      }
      const onCurve = (p: V3) => [...curveEnds, ...curveCentres].some((q) => len(sub(p, q)) < 1e-6);
      // points drawn on their own, in the order they are written
      for (const [k, f] of Object.entries(v.fields)) if (f instanceof Vec && k !== "origin" && k !== "normal" && !onCurve(f.v3())) push(f.v3());
      if (centers) for (const [k, f] of Object.entries(v.fields)) if (f instanceof Obj && (f.kind === "sketch circle" || f.kind === "sketch ellipse" || (f.kind === "sketch arc" && ends)) && k !== "x_axis") push((f.fields.center as Vec).v3());
      if (ends) for (const p of curveEnds) push(p);
      if (!out.length) return a.ctx.error(`sketch_points(): sketch ${v.label} has no points${centers ? " or circles" : ""} to place copies at; draw points (or circles) where they go`);
      return out.map(pt);
    },
    "sketch_points(sketch, centers: true, ends: false) → where a sketch says copies go (a sketch-driven pattern): its points drawn on their own and the centres of its circles and ellipses (centers: false leaves those out; ends: true adds the ends of its lines and arcs). Drag the points in the sketch and every copy follows: for p in sketch_points(holes) { cut cylinder(d: 3.2, h: 20, at: p) }.",
  ),
  def(
    "cumulative",
    ["gaps", "start"],
    (a) => {
      const v = a.value("gaps");
      if (!Array.isArray(v) || !v.every((x) => typeof x === "number")) return a.ctx.error("cumulative(): gaps should be a list of numbers, like [5, 5, 8, 12]");
      if (v.length + 1 > MAX_POINTS) a.ctx.error(`cumulative(): up to ${MAX_POINTS - 1} gaps`);
      let s = a.num("start", 0);
      const out = [s];
      for (const g of v as number[]) out.push((s += g));
      return out.map((x) => Math.round(x * 1e9) / 1e9);
    },
    "cumulative(gaps, start: 0) → positions from the gaps between them, for a pattern with uneven spacing: cumulative([5, 5, 8, 12]) is [0, 5, 10, 18, 30]. For copies that change as they go (a variable pattern), compute each one's size from its index in a for loop.",
  ),
]);

export const PATTERN_NAMES = Object.keys(PATTERN_FNS);
