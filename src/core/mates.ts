// Mates: parts placed by how their faces, holes and points meet (a face against another, two holes in line, a
// face a set distance from another). The first part named in a mate moves to meet the second; parts nothing
// moves stay where they are drawn. A part's mates are solved together, moving it as little as possible from
// where it is drawn, so whatever they leave free (a hinge's turn, a carriage's slide) stays as drawn and can
// be dragged. Parts are solved in order from the ones that stay put; parts that move each other are solved
// together. Faces and round faces come from each solid's catalogue (the kernel's list of its flat and round
// faces in its own coordinates); points, planes and axes given in the design need no kernel.

import type { V3, Xform } from "../kernel/recipe";
import { applyXforms, applyXformsToDir, inverseXforms } from "../kernel/recipe";

/** A solid's flat and round faces in its own coordinates (from the kernel). */
export interface FaceCatalogue {
  planes: { p: V3; n: V3; area: number; lo: V3; hi: V3 }[];
  /** cylinders, cones and circular edges: p is the middle of the face along its axis d, len its length there */
  rounds: { p: V3; d: V3; r: number; len: number; area: number }[];
  box: [V3, V3];
}

/** Geometry a mate holds, where the part is drawn (world coordinates). */
/** u: a direction square to an axis, fixed to its part (a slider keeps it from turning about the axis) */
/** len: a segment's length from p along d (a slot's middle line) */
export type MateGeom = { t: "plane"; p: V3; n: V3 } | { t: "axis"; p: V3; d: V3; r?: number; u?: V3; len?: number } | { t: "point"; p: V3 } | { t: "body" };

export interface MateRef {
  body: string;
  geom: MateGeom;
  /** how the design names it, for messages: face(lid, -Z) */
  label: string;
}

export type MateKind =
  | "against"
  | "flush"
  | "concentric"
  | "pin"
  | "parallel"
  | "perpendicular"
  | "angle"
  | "distance"
  | "tangent"
  | "coincident"
  | "rigid"
  // joints, by the names other CAD gives them: revolute is pin, cylindrical concentric, planar two faces in one
  // plane, ball two points together; a slider is in line and does not turn
  | "revolute"
  | "slider"
  | "cylindrical"
  | "planar"
  | "ball"
  // a pin's centre (or axis) kept on a slot's middle line, between its ends
  | "slot"
  // relations between two joints (see MateCoupling): what one turns or slides, the other follows
  | "gear"
  | "belt"
  | "chain"
  | "rack"
  | "screw"
  | "cam";

/** Mates that relate other mates instead of holding faces together. */
export const RELATION_KINDS: readonly MateKind[] = ["gear", "belt", "chain", "rack", "screw", "cam"];
/** Joints whose turn about their axis a relation or a limit can read (radians from where drawn). */
export const TURN_JOINTS: readonly MateKind[] = ["revolute", "pin", "cylindrical", "concentric"];
/** Joints whose slide along their axis (or a distance between faces) a relation can read (mm from where drawn). */
export const SLIDE_JOINTS: readonly MateKind[] = ["slider", "cylindrical", "concentric", "distance"];

/**
 * A relation between two joints, by their mates' names: gears and belts turn the second as the first turns, a
 * rack slides as its pinion turns, a lead screw's nut slides as it turns (or a nut turns and slides on one
 * cylindrical mate), a cam's follower lifts as it turns. Each joint counts from where it is drawn.
 */
export interface MateCoupling {
  /** the mates it relates: the first drives, the second follows (a screw on one cylindrical mate names it twice) */
  p: string;
  q: string;
  /** gear, belt: how many times as far the second turns; rack: the pinion's pitch radius (mm); screw: its lead (mm a turn) */
  ratio: number;
  /** cam: the follower's lift through one turn (evenly spaced from where drawn: mm, or radians for a swinging follower) */
  lift?: number[];
  /** a left-hand screw */
  left?: boolean;
  /** the other way round (an internal gear, a crossed belt, a rack that runs backwards) */
  reverse?: boolean;
}

export interface MateSpec {
  /** the mate's name (given, or "mate 3") */
  name: string;
  kind: MateKind;
  a: MateRef;
  b: MateRef;
  /** distance (mm) or angle (radians) it holds, or the gap against: and flush: leave */
  value?: number;
  /** limits instead of a value (angle and distance): it is free between them; on a revolute or pin its turn
   * (radians) and on a slider its slide (mm) from where drawn, on a slot where along it the pin is */
  min?: number;
  max?: number;
  /** a relation between two joints (gear, belt, rack, screw, cam) */
  couple?: MateCoupling;
}

/** A body's move from where it is drawn: q = R (p − c) + c + t. */
export interface BodyMove {
  R: number[];
  c: V3;
  t: V3;
}

/** A body the solver may move: where it is drawn (its centre and size set how turning and sliding weigh). */
export interface MateBody {
  name: string;
  c: V3;
  size: number;
}

export interface MateOutcome {
  name: string;
  /** "ok": it holds; "conflict": it cannot hold with the mates before it, so it is left out; "limit": a limit it is held at */
  status: "ok" | "conflict" | "limit";
  /** how far off it is when it cannot hold (mm, or degrees for directions) */
  off?: number;
  message?: string;
}

/** What a mated body can still do: its free motions, in words, and as twists (for dragging). */
export interface BodyFreedom {
  body: string;
  /** how many ways it can still move (0: fully placed by its mates) */
  dof: number;
  words: string;
  /** basis twists of those motions: turning (rad) about its centre and sliding (mm) */
  twists: { w: V3; v: V3 }[];
}

export interface MateSolution {
  moves: Map<string, BodyMove>;
  outcomes: MateOutcome[];
  free: BodyFreedom[];
  /** bodies in the order they were solved (a body after the ones it is mated to) */
  order: string[];
  /** each turning joint's turn from where drawn (radians, counted round past a whole turn), by mate name: a drag
   * passes them back so gears that do not divide evenly stay in step */
  coords: Map<string, number>;
}

// ---------- small vector and matrix helpers ----------

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => scl(a, 1 / (len(a) || 1));

export const I3 = (): number[] => [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** row-major 3 × 3 times a vector */
const mv = (R: number[], v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const mm = (A: number[], B: number[]): number[] => {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
  return o;
};
/** the rotation by the vector w (its length in radians, about its direction) */
export function expRot(w: V3): number[] {
  const th = len(w);
  if (th < 1e-14) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = scl(w, 1 / th);
  const c = Math.cos(th),
    s = Math.sin(th),
    k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}
/** a rotation's axis and angle (radians) */
export function rotAxisAngle(R: number[]): { axis: V3; angle: number } {
  const c = Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2));
  const angle = Math.acos(c);
  if (angle < 1e-12) return { axis: [0, 0, 1], angle: 0 };
  let axis: V3 = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
  if (len(axis) < 1e-9) {
    // a half turn: the axis is the column of R + I with the most in it
    const M = [R[0] + 1, R[1], R[2], R[3], R[4] + 1, R[5], R[6], R[7], R[8] + 1];
    const cols: V3[] = [
      [M[0], M[3], M[6]],
      [M[1], M[4], M[7]],
      [M[2], M[5], M[8]],
    ];
    axis = cols.reduce((a, b) => (len(b) > len(a) ? b : a));
  }
  return { axis: unit(axis), angle };
}

export const moveIdentity = (c: V3): BodyMove => ({ R: I3(), c, t: [0, 0, 0] });
export const movePoint = (m: BodyMove, p: V3): V3 => add(add(mv(m.R, sub(p, m.c)), m.c), m.t);
export const moveDir = (m: BodyMove, d: V3): V3 => mv(m.R, d);
/** the move as transforms to add after a part's own (a turn about its centre, then a slide) */
export function moveXforms(m: BodyMove): Xform[] {
  const out: Xform[] = [];
  const { axis, angle } = rotAxisAngle(m.R);
  if (angle > 1e-10) out.push({ op: "rotate", angle: (angle * 180) / Math.PI, origin: m.c, axis });
  if (len(m.t) > 1e-10) out.push({ op: "translate", v: m.t });
  return out;
}
/** whether a move leaves the body where it is */
export const isStill = (m: BodyMove) => rotAxisAngle(m.R).angle < 1e-9 && len(m.t) < 1e-7;

/** Solve the square system A x = b in place (Gaussian elimination with partial pivoting); null when singular. */
function solveSquare(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let k = 0; k < n; k++) {
    let piv = k,
      best = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++)
      if (Math.abs(A[i * n + k]) > best) {
        best = Math.abs(A[i * n + k]);
        piv = i;
      }
    if (best < 1e-300) return null;
    if (piv !== k) {
      for (let j = 0; j < n; j++) [A[k * n + j], A[piv * n + j]] = [A[piv * n + j], A[k * n + j]];
      [b[k], b[piv]] = [b[piv], b[k]];
    }
    for (let i = k + 1; i < n; i++) {
      const f = A[i * n + k] / A[k * n + k];
      if (!f) continue;
      for (let j = k; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      b[i] -= f * b[k];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
    x[i] = s / A[i * n + i];
  }
  return x;
}

/** Eigen-decomposition of a symmetric n × n matrix (cyclic Jacobi): values and vectors (columns of V). */
export function symEigen(S: Float64Array, n: number): { values: Float64Array; V: Float64Array } {
  const A = Float64Array.from(S);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const th = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p],
            akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k],
            aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p],
            vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = A[i * n + i];
  return { values, V };
}

// ---------- picking faces from catalogues ----------

/** A solid of a body where it is drawn: its catalogue (own coordinates) and its placement. */
export interface PlacedCatalogue {
  cat: FaceCatalogue;
  xf: Xform[];
}

const boxCorners = (lo: V3, hi: V3): V3[] => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]] as V3);
function placedBox(lo: V3, hi: V3, xf: Xform[]): [V3, V3] {
  const a: V3 = [Infinity, Infinity, Infinity],
    b: V3 = [-Infinity, -Infinity, -Infinity];
  for (const c of boxCorners(lo, hi)) {
    const w = applyXforms(c, xf);
    for (let k = 0; k < 3; k++) {
      a[k] = Math.min(a[k], w[k]);
      b[k] = Math.max(b[k], w[k]);
    }
  }
  return [a, b];
}
const boxDist = (p: V3, [lo, hi]: [V3, V3]) => Math.hypot(...([0, 1, 2].map((k) => Math.max(lo[k] - p[k], 0, p[k] - hi[k])) as V3));

/** The body's box where it is drawn. */
export function bodyBox(solids: PlacedCatalogue[]): [V3, V3] | null {
  if (!solids.length) return null;
  const a: V3 = [Infinity, Infinity, Infinity],
    b: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of solids) {
    const [lo, hi] = placedBox(s.cat.box[0], s.cat.box[1], s.xf);
    for (let k = 0; k < 3; k++) {
      a[k] = Math.min(a[k], lo[k]);
      b[k] = Math.max(b[k], hi[k]);
    }
  }
  return [a, b];
}

const fmtV = (v: V3) => `(${v.map((x) => +x.toFixed(2)).join(", ")})`;

/**
 * A flat face of a body, where it is drawn: the one facing `dir` farthest out that way, or the one facing `dir`
 * (if given) nearest `near`. Faces in one plane count as one, centred between them.
 */
export function pickPlane(body: string, solids: PlacedCatalogue[], dir?: V3, near?: V3): MateGeom | string {
  // how far a point is from a face: measured in its solid's own coordinates, where its box fits it
  const cands: { p: V3; n: V3; area: number; dist: number }[] = [];
  for (const s of solids) {
    const nl = near ? inverseXforms(near, s.xf) : undefined;
    for (const f of s.cat.planes) cands.push({ p: applyXforms(f.p, s.xf), n: unit(applyXformsToDir(f.n, s.xf)), area: f.area, dist: nl ? boxDist(nl, [f.lo, f.hi]) + Math.abs(dot(sub(nl, f.p), f.n)) : 0 });
  }
  const u = dir ? unit(dir) : undefined;
  // the faces that face that way best (a part drawn a little turned still has its faces), within 25°
  const most = u ? Math.max(-1, ...cands.map((c) => dot(c.n, u))) : 1;
  const facing = u ? cands.filter((c) => dot(c.n, u) > Math.max(0.9, most - 1e-3)) : cands;
  if (!facing.length) return u ? `${body} has no flat face facing ${fmtV(u)}` : `${body} has no flat faces`;
  if (near) {
    const best = facing.reduce((a, b) => (b.dist < a.dist - 1e-6 || (Math.abs(b.dist - a.dist) <= 1e-6 && b.area > a.area) ? b : a));
    return { t: "plane", p: best.p, n: best.n };
  }
  if (!u) return `say which of ${body}'s faces with a direction, like face(${body}, +Z)`;
  const out = Math.max(...facing.map((c) => dot(c.p, u)));
  const same = facing.filter((c) => out - dot(c.p, u) < 1e-4);
  const area = same.reduce((s, c) => s + c.area, 0) || 1;
  const p = same.reduce((s, c) => add(s, scl(c.p, c.area / area)), [0, 0, 0] as V3);
  return { t: "plane", p, n: same[0].n };
}

/** A round face's axis (a hole, a shaft, a boss or a round edge), where it is drawn: by diameter, direction and the point it is nearest. */
export function pickAxis(body: string, solids: PlacedCatalogue[], opts: { near?: V3; d?: number; along?: V3 }): MateGeom | string {
  let cands = solids.flatMap((s) => s.cat.rounds.map((f) => ({ p: applyXforms(f.p, s.xf), d: unit(applyXformsToDir(f.d, s.xf)), r: f.r, len: f.len, area: f.area })));
  if (!cands.length) return `${body} has no round faces (holes, shafts or bosses) to take an axis from`;
  if (opts.d !== undefined) {
    const d = opts.d;
    cands = cands.filter((c) => Math.abs(2 * c.r - d) <= Math.max(0.05, 0.01 * d));
    if (!cands.length) return `${body} has no round face ${+d.toFixed(3)} mm across`;
  }
  if (opts.along) {
    const a = unit(opts.along);
    cands = cands.filter((c) => Math.abs(dot(c.d, a)) > 0.999);
    if (!cands.length) return `${body} has no round face along ${fmtV(a)}`;
  }
  let best = cands[0];
  if (opts.near) {
    const near = opts.near;
    const distTo = (c: (typeof cands)[number]) => {
      const t = Math.max(-c.len / 2, Math.min(c.len / 2, dot(sub(near, c.p), c.d)));
      return len(sub(near, add(c.p, scl(c.d, t))));
    };
    for (const c of cands) {
      const dc = distTo(c),
        db = distTo(best);
      if (dc < db - 1e-6 || (Math.abs(dc - db) <= 1e-6 && c.area > best.area)) best = c;
    }
  } else {
    // with nothing to choose by, they must all be on one axis
    const first = cands[0];
    const apart = cands.some((c) => Math.abs(dot(c.d, first.d)) < 0.999 || len(cross(sub(c.p, first.p), first.d)) > 1e-3);
    if (apart) return `${body} has round faces on ${new Set(cands.map((c) => `${c.p.map((x) => x.toFixed(1))}`)).size > 1 ? "several" : "different"} axes: say which with near: (a point by it) or d: (its diameter)`;
    best = cands.reduce((a, b) => (b.area > a.area ? b : a));
  }
  return { t: "axis", p: best.p, d: best.d, r: best.r };
}

// ---------- the mates' equations ----------

const placed = (g: MateGeom, m: BodyMove): MateGeom =>
  g.t === "plane"
    ? { t: "plane", p: movePoint(m, g.p), n: moveDir(m, g.n) }
    : g.t === "axis"
      ? { ...g, p: movePoint(m, g.p), d: moveDir(m, g.d), ...(g.u ? { u: moveDir(m, g.u) } : {}) }
      : g.t === "point"
        ? { t: "point", p: movePoint(m, g.p) }
        : g;
const dirOf = (g: MateGeom): V3 | null => (g.t === "plane" ? g.n : g.t === "axis" ? g.d : null);

type Axis = Extract<MateGeom, { t: "axis" }>;

/** Where along a slot's middle line (mm from its start) a pin's centre is, or where its axis crosses the line. */
function slotAlong(A: MateGeom, B: Axis): number {
  if (A.t === "body") return 0;
  const w = sub(A.p, B.p);
  if (A.t === "axis") {
    const c = dot(A.d, B.d);
    if (1 - c * c > 1e-9) return (dot(w, B.d) - c * dot(w, A.d)) / (1 - c * c);
  }
  return dot(w, B.d);
}

/** How far a joint's first part has turned about the second's axis from where they are drawn (radians, counted round from ref). */
function turnOf(A: MateGeom, B: MateGeom, ref = 0): number {
  if (A.t !== "axis" || B.t !== "axis" || !A.u || !B.u) return 0;
  const ua = sub(A.u, scl(B.d, dot(A.u, B.d)));
  const raw = Math.atan2(dot(cross(B.u, ua), B.d), dot(B.u, ua));
  return raw + 2 * Math.PI * Math.round((ref - raw) / (2 * Math.PI));
}

/** How far a joint's first part has slid along the second's axis (or face normal) from where they are drawn (mm). */
function slideOf(s: MateSpec, A: MateGeom, B: MateGeom): number {
  const a0 = s.a.geom,
    b0 = s.b.geom;
  const d = dirOf(B),
    d0 = dirOf(b0);
  if (!d || !d0 || A.t === "body" || a0.t === "body" || B.t === "body" || b0.t === "body") return 0;
  return dot(sub(A.p, B.p), d) - dot(sub(a0.p, b0.p), d0);
}

/** What a mate measures (for limits and messages): an angle (radians) or a distance (mm). */
export function mateMeasure(k: MateKind, A: MateGeom, B: MateGeom, side = 1): number {
  if (k === "slot") return B.t === "axis" ? slotAlong(A, B) : 0;
  if (k === "angle") {
    const a = dirOf(A),
      b = dirOf(B);
    return a && b ? Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) : 0;
  }
  if (A.t === "point" && B.t === "point") return len(sub(A.p, B.p));
  if (B.t === "plane" && A.t !== "body") return dot(sub(A.p, B.p), B.n) * side;
  if (A.t === "plane" && B.t !== "body") return dot(sub(B.p, A.p), A.n) * side;
  if (B.t === "axis" && A.t !== "body") return len(cross(sub(A.p, B.p), B.d));
  if (A.t === "axis" && B.t !== "body") return len(cross(sub(B.p, A.p), A.d));
  return 0;
}

/** Can these two kinds of geometry be mated this way? A message when not. */
export function mateFits(k: MateKind, a: MateGeom, b: MateGeom, value?: number): string | null {
  const t = `${a.t}-${b.t}`;
  switch (k) {
    case "against":
    case "flush":
      return t === "plane-plane" ? null : `${k}() takes two flat faces, like ${k}(face(lid, -Z), face(box, +Z))`;
    case "concentric":
    case "pin":
    case "revolute":
    case "slider":
    case "cylindrical":
      return t === "axis-axis" ? null : `${k}() takes two axes (holes, shafts, bosses or rods), like ${k}(axis(pin, d: 5), axis(hinge, d: 5))`;
    case "planar":
      return t === "plane-plane" ? null : "planar() takes two flat faces (or plane()s), like planar(face(puck, -Z), face(table, +Z))";
    case "ball":
      return t === "point-point" ? null : "ball() takes two points, the ball's centre on each part, like ball(point(rod, (0, 0, 40)), point(arm, (0, 0, 40)))";
    case "parallel":
    case "perpendicular":
    case "angle":
      return (a.t === "plane" || a.t === "axis") && (b.t === "plane" || b.t === "axis") ? (k === "angle" && t !== "plane-plane" && t !== "axis-axis" ? "angle() takes two flat faces or two axes" : null) : `${k}() takes flat faces or axes`;
    case "distance":
      if (a.t === "body" || b.t === "body") return "distance() takes faces, axes or points";
      if (t === "axis-axis" || t === "point-axis" || t === "axis-point") return value !== undefined && value <= 0 ? "distance() between axes takes a distance over 0 (concentric() puts them in line)" : null;
      return null;
    case "tangent":
      return t === "plane-axis" || t === "axis-plane" || t === "axis-axis" ? null : "tangent() takes a flat face and a round one, or two round ones, like tangent(face(belt, +Z), axis(roller))";
    case "coincident":
      return a.t !== "body" && b.t !== "body" && !(a.t === "axis" && b.t === "plane") && !(a.t === "plane" && b.t === "axis") ? null : "coincident() takes points, flat faces or axes (a point on a face or an axis, or two of a kind)";
    case "rigid":
      return null;
    case "slot":
      return (a.t === "point" || a.t === "axis") && b.t === "axis" && b.len !== undefined ? null : "slot() takes the pin (a point, or its axis) and the slot's middle line, like slot(axis(pin, d: 5), segment(plate, from: (0, 0, 0), to: (40, 0, 0)))";
    case "gear":
    case "belt":
    case "chain":
    case "rack":
    case "screw":
    case "cam":
      return null;
  }
}

/** The residuals of a mate (mm; directions times the length scale L), or the bound a limit holds. */
function residuals(s: MateSpec, A: MateGeom, B: MateGeom, L: number, side: number, target?: number): number[] {
  const nA = dirOf(A),
    nB = dirOf(B);
  const v = target ?? s.value ?? 0;
  // two directions made the same (either way round, as drawn): a − ±b, which still pulls them together from a
  // quarter turn apart, where a × b does not
  const da = dirOf(s.a.geom),
    db = dirOf(s.b.geom);
  const al = da && db && dot(da, db) < 0 ? -1 : 1;
  const same = (a: V3, b: V3): number[] => [(a[0] - al * b[0]) * L, (a[1] - al * b[1]) * L, (a[2] - al * b[2]) * L];
  switch (s.kind) {
    case "against":
    case "flush": {
      const a = A as Extract<MateGeom, { t: "plane" }>,
        b = B as Extract<MateGeom, { t: "plane" }>;
      const n = s.kind === "against" ? add(a.n, b.n) : sub(a.n, b.n);
      return [n[0] * L, n[1] * L, n[2] * L, dot(sub(a.p, b.p), b.n) - v];
    }
    case "concentric":
    case "cylindrical":
    case "pin":
    case "revolute":
    case "slider": {
      const a = A as Extract<MateGeom, { t: "axis" }>,
        b = B as Extract<MateGeom, { t: "axis" }>;
      const off = cross(sub(a.p, b.p), b.d);
      const r = [...same(a.d, b.d), ...off];
      if (s.kind === "pin" || s.kind === "revolute") r.push(dot(sub(a.p, b.p), b.d) * side - v);
      // not turned about the axis from where it is drawn: the two square directions stay together
      if (s.kind === "slider" && a.u && b.u) r.push(dot(a.u, cross(b.d, b.u)) * L);
      return r;
    }
    case "planar":
      return [...same(nA!, nB!), dot(sub((A as { p: V3 }).p, (B as { p: V3 }).p), nB!) - v];
    case "ball":
      return sub((A as { p: V3 }).p, (B as { p: V3 }).p);
    case "parallel": {
      if (A.t === "axis" && B.t === "plane") return [dot(A.d, B.n) * L];
      if (A.t === "plane" && B.t === "axis") return [dot(A.n, B.d) * L];
      return same(nA!, nB!);
    }
    case "perpendicular": {
      if ((A.t === "axis") !== (B.t === "axis")) return same(nA!, nB!);
      return [dot(nA!, nB!) * L];
    }
    case "angle":
      return [(dot(nA!, nB!) - Math.cos(v)) * L];
    case "distance": {
      if (A.t === "point" && B.t === "point") return [len(sub(A.p, B.p)) - v];
      if (A.t === "plane" && B.t === "plane") return [...same(A.n, B.n), dot(sub(A.p, B.p), B.n) * side - v];
      if (A.t === "axis" && B.t === "axis") return [...same(A.d, B.d), len(cross(sub(A.p, B.p), B.d)) - v];
      if (A.t === "axis" && B.t === "plane") return [dot(A.d, B.n) * L, dot(sub(A.p, B.p), B.n) * side - v];
      if (A.t === "plane" && B.t === "axis") return [dot(B.d, A.n) * L, dot(sub(B.p, A.p), A.n) * side - v];
      if (B.t === "plane") return [dot(sub((A as { p: V3 }).p, B.p), B.n) * side - v];
      if (A.t === "plane") return [dot(sub((B as { p: V3 }).p, A.p), A.n) * side - v];
      if (B.t === "axis") return [len(cross(sub((A as { p: V3 }).p, B.p), B.d)) - v];
      if (A.t === "axis") return [len(cross(sub((B as { p: V3 }).p, A.p), A.d)) - v];
      return [];
    }
    case "tangent": {
      if (A.t === "axis" && B.t === "axis") return [...same(A.d, B.d), len(cross(sub(A.p, B.p), B.d)) - (A.r ?? 0) - (B.r ?? 0)];
      const pl = (A.t === "plane" ? A : B) as Extract<MateGeom, { t: "plane" }>;
      const ax = (A.t === "axis" ? A : B) as Extract<MateGeom, { t: "axis" }>;
      return [dot(ax.d, pl.n) * L, dot(sub(ax.p, pl.p), pl.n) * side - (ax.r ?? 0)];
    }
    case "coincident": {
      if (A.t === "point" && B.t === "point") return sub(A.p, B.p);
      if (A.t === "point" && B.t === "plane") return [dot(sub(A.p, B.p), B.n)];
      if (A.t === "plane" && B.t === "point") return [dot(sub(B.p, A.p), A.n)];
      if (A.t === "point" && B.t === "axis") return cross(sub(A.p, B.p), B.d);
      if (A.t === "axis" && B.t === "point") return cross(sub(B.p, A.p), A.d);
      if (A.t === "plane" && B.t === "plane") return [...same(A.n, B.n), dot(sub(A.p, B.p), B.n)];
      if (A.t === "axis" && B.t === "axis") return [...same(A.d, B.d), ...cross(sub(A.p, B.p), B.d)];
      return [];
    }
    case "slot": {
      // a pin's axis crosses the slot's middle line; a point lies on it (where along it is the limit's to hold)
      const b = B as Axis;
      if (A.t === "axis") {
        const n = cross(A.d, b.d);
        if (len(n) > 1e-6) return [dot(sub(A.p, b.p), unit(n))];
      }
      return cross(sub((A as { p: V3 }).p, b.p), b.d);
    }
    case "rigid":
    case "gear":
    case "belt":
    case "chain":
    case "rack":
    case "screw":
    case "cam":
      return [];
  }
}

/** Which side as drawn a signed distance or tangency is on (+1 or −1), so it keeps to it. */
function sideOf(s: MateSpec): number {
  const A = s.a.geom,
    B = s.b.geom;
  if ((s.kind === "pin" || s.kind === "revolute") && A.t === "axis" && B.t === "axis") return dot(A.d, B.d) < 0 ? -1 : 1;
  if (s.kind !== "distance" && s.kind !== "tangent") return 1;
  let d = 0;
  if (B.t === "plane" && A.t !== "body") d = dot(sub(A.p, B.p), B.n);
  else if (A.t === "plane" && B.t !== "body") d = dot(sub(B.p, A.p), A.n);
  return d < 0 ? -1 : 1;
}

/**
 * A direction square to each axis of a joint, the same way where they are drawn: a slider holds them together (so
 * it does not turn about its axis), and a turning joint's turn is read from them.
 */
function withTurnRefs(s: MateSpec): MateSpec {
  const A = s.a.geom,
    B = s.b.geom;
  if (!(s.kind === "slider" || TURN_JOINTS.includes(s.kind)) || A.t !== "axis" || B.t !== "axis") return s;
  // the world axis farthest from lying along either
  const lean = (e: V3) => Math.max(Math.abs(dot(e, A.d)), Math.abs(dot(e, B.d)));
  const e = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]).reduce((best, x) => (lean(x) < lean(best) - 1e-9 ? x : best));
  const square = (d: V3) => unit(sub(e, scl(d, dot(e, d))));
  return { ...s, a: { ...s.a, geom: { ...A, u: square(A.d) } }, b: { ...s.b, geom: { ...B, u: square(B.d) } } };
}

// ---------- solving ----------

interface Group {
  bodies: string[];
  mates: number[];
}

/** Bodies in groups that move each other, ordered so a group comes after the bodies it is mated to (Tarjan). */
function groups(mates: MateSpec[], moving: Set<string>): Group[] {
  const parents = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (moving.has(a) && a !== b) (parents.get(a) ?? parents.set(a, new Set()).get(a)!).add(b);
  };
  for (const s of mates) {
    link(s.a.body, s.b.body);
    // a relation's two joints move each other: either part can drive the other
    if (s.couple) link(s.b.body, s.a.body);
  }
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    on = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let n = 0;
  const visit = (v: string) => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    on.add(v);
    for (const w of parents.get(v) ?? []) {
      if (!moving.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const g: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        g.push(w);
      } while (w !== v);
      out.push(g);
    }
  };
  for (const b of moving) if (!index.has(b)) visit(b);
  // Tarjan finishes a body's parents before it: that is the order to solve in
  return out.map((bodies) => ({ bodies, mates: mates.flatMap((s, i) => (bodies.includes(s.a.body) ? [i] : [])) }));
}

export interface SolveOptions {
  /** where each body already is (the last solution, when dragging): solving starts there instead of as drawn */
  start?: Map<string, BodyMove>;
  /** a drag: pull this point of this body (where it is drawn) toward target, as far as its mates let it */
  drag?: { body: string; point: V3; target: V3 };
  /** bodies held where they are (start, or as drawn) */
  hold?: Set<string>;
  /** each turning joint's turn so far (the last solution's coords), so turns are counted round from there */
  coords?: Map<string, number>;
}

/** A relation worked out: the two joints, what each gives (a turn or a slide), and how the second follows. */
interface Rel {
  p: number;
  q: number;
  qc: "turn" | "slide";
  /** the second = k × the first (a cam: its lift at k × the first) */
  k: number;
  lift?: number[];
}

/** The design's mates set up for solving: each one's equations, what its limits measure, and the turns counted round. */
interface System {
  mates: MateSpec[];
  moveOf: (b: string) => BodyMove;
  /** a mate's equations with the bodies at M (bound: the limit it is held at) */
  eq: (i: number, M: Map<string, BodyMove>, refs: Map<string, number>, L: number, bound?: number) => number[];
  /** what a mate with limits measures with the bodies at M */
  measure: (i: number, M: Map<string, BodyMove>, refs: Map<string, number>) => number;
  /** a joint's turn with the bodies at M (radians from where drawn), counted round from refs */
  turn: (i: number, M: Map<string, BodyMove>, refs: Map<string, number>) => number;
  /** the joints whose turns are counted round (related or limited), by mate index */
  turning: number[];
  /** the relations, by mate index */
  rels: (Rel | undefined)[];
}

/** A cam's lift at a turn (radians): the list spread evenly round one turn, smooth between its values (Catmull–Rom). */
export function camLift(lift: number[], a: number): number {
  const n = lift.length;
  if (n < 2) return lift[0] ?? 0;
  const t = ((((a / (2 * Math.PI)) % 1) + 1) % 1) * n;
  const i = Math.floor(t);
  const f = t - i;
  const y = (k: number) => lift[(((i + k) % n) + n) % n];
  const p0 = y(-1),
    p1 = y(0),
    p2 = y(1),
    p3 = y(2);
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
}

/** Joints whose limits hold their turn or slide while the joint itself always holds (a slot's ends likewise). */
const LIMITED_JOINTS: readonly MateKind[] = ["revolute", "pin", "slider", "slot"];

function system(mates: MateSpec[], sides: number[], info: Map<string, MateBody>, moveOf: (b: string) => BodyMove, outcomes: MateOutcome[]): System {
  const byName = new Map(mates.map((s, i) => [s.name, i]));
  const poseOf = (b: string, M: Map<string, BodyMove>) => M.get(b) ?? moveOf(b);
  const geoms = (i: number, M: Map<string, BodyMove>): [MateGeom, MateGeom] => {
    const s = mates[i];
    return [placed(s.a.geom, poseOf(s.a.body, M)), placed(s.b.geom, poseOf(s.b.body, M))];
  };
  const turn = (i: number, M: Map<string, BodyMove>, refs: Map<string, number>) => {
    const [A, B] = geoms(i, M);
    return turnOf(A, B, refs.get(mates[i].name) ?? 0);
  };
  const slide = (i: number, M: Map<string, BodyMove>) => {
    const [A, B] = geoms(i, M);
    return slideOf(mates[i], A, B);
  };
  const relate = (s: MateSpec): Rel | string => {
    const c = s.couple!;
    const p = byName.get(c.p),
      q = byName.get(c.q);
    if (p === undefined || q === undefined) return `${s.name} cannot hold: ${p === undefined ? c.p : c.q} is not a mate it can read`;
    const P = mates[p],
      Q = mates[q];
    const qc = s.kind === "gear" || s.kind === "belt" || s.kind === "chain" || (s.kind === "cam" && (Q.kind === "revolute" || Q.kind === "pin")) ? "turn" : "slide";
    const dP = dirOf(P.b.geom),
      dQ = dirOf(Q.b.geom);
    if (!dP || !dQ) return `${s.name} cannot hold: ${dP ? c.q : c.p} has no axis to turn or slide along`;
    // each joint counts its turn about its own axis: axes drawn opposite ways turn the count round
    const along = dot(dP, dQ);
    const sense = Math.abs(along) > 0.5 ? Math.sign(along) : 1;
    let k = 1;
    if (s.kind === "gear") k = -sense * c.ratio;
    else if (s.kind === "belt" || s.kind === "chain") k = sense * c.ratio;
    else if (s.kind === "rack") {
      if (Math.abs(along) > 0.1) return `${s.name} cannot hold: the rack (${c.q}) should slide square to the pinion's axis (${c.p})`;
      // the pinion's edge on the rack's side moves along its axis × the way to the rack
      const rack = Q.a.body === P.b.body ? Q.b.body : Q.a.body;
      const at: V3 = P.b.geom.t === "axis" ? P.b.geom.p : [0, 0, 0];
      const w0 = sub(info.get(rack)?.c ?? at, at);
      const w = sub(sub(w0, scl(dP, dot(w0, dP))), scl(dQ, dot(w0, dQ)));
      k = (len(w) > 1e-9 ? Math.sign(dot(cross(dP, w), dQ)) || 1 : 1) * c.ratio;
    } else if (s.kind === "screw") {
      // a right-hand thread: turning one forward about the axis drives the other back along it
      const hand = c.left ? -1 : 1;
      if (p === q) k = (hand * c.ratio) / (2 * Math.PI);
      else {
        if (Math.abs(along) < 0.99) return `${s.name} cannot hold: the nut (${c.q}) should slide along the screw's axis (${c.p})`;
        k = (-sense * hand * c.ratio) / (2 * Math.PI);
      }
    }
    return { p, q, qc, k: c.reverse ? -k : k, ...(c.lift ? { lift: c.lift } : {}) };
  };
  const rels = mates.map((s, i) => {
    if (!s.couple) return undefined;
    const r = relate(s);
    if (typeof r !== "string") return r;
    outcomes[i] = { name: s.name, status: "conflict", message: r };
    return undefined;
  });
  const turning = [
    ...new Set([
      ...rels.flatMap((r) => (r ? (r.qc === "turn" ? [r.p, r.q] : [r.p]) : [])),
      ...mates.flatMap((s, i) => ((s.kind === "revolute" || s.kind === "pin") && (s.min !== undefined || s.max !== undefined) ? [i] : [])),
    ]),
  ];
  const measure = (i: number, M: Map<string, BodyMove>, refs: Map<string, number>) => {
    const s = mates[i];
    if (s.kind === "revolute" || s.kind === "pin") return turn(i, M, refs);
    if (s.kind === "slider") return slide(i, M);
    const [A, B] = geoms(i, M);
    return mateMeasure(s.kind, A, B, sides[i]);
  };
  const eq = (i: number, M: Map<string, BodyMove>, refs: Map<string, number>, L: number, bound?: number): number[] => {
    const s = mates[i];
    if (s.couple) {
      const r = rels[i];
      if (!r) return [];
      const tp = turn(r.p, M, refs);
      const tq = r.qc === "turn" ? turn(r.q, M, refs) : slide(r.q, M);
      const want = r.lift ? camLift(r.lift, r.k * tp) - r.lift[0] : r.k * tp;
      return [(tq - want) * (r.qc === "turn" ? L : 1)];
    }
    const [A, B] = geoms(i, M);
    if (s.min === undefined && s.max === undefined) return residuals(s, A, B, L, sides[i]);
    // a joint with limits holds as a joint, and at a limit it would pass; other limits hold only there
    if (!LIMITED_JOINTS.includes(s.kind)) return bound === undefined ? [] : residuals(s, A, B, L, sides[i], bound);
    const r = residuals(s, A, B, L, sides[i]);
    if (bound !== undefined) r.push((measure(i, M, refs) - bound) * (s.kind === "revolute" || s.kind === "pin" ? L : 1));
    return r;
  };
  return { mates, moveOf, eq, measure, turn, turning, rels };
}

/** Solve every mate: where each mated body goes, which mates hold, and what each body can still do. */
export function solveMates(bodies: MateBody[], specs: MateSpec[], opts: SolveOptions = {}): MateSolution {
  const mates = specs.map(withTurnRefs);
  const info = new Map(bodies.map((b) => [b.name, b]));
  const moves = new Map<string, BodyMove>();
  const outcomes: MateOutcome[] = mates.map((s) => ({ name: s.name, status: "ok" }));
  const free: BodyFreedom[] = [];
  const order: string[] = [];
  const moving = new Set(mates.filter((s) => s.a.body !== s.b.body && !opts.hold?.has(s.a.body)).map((s) => s.a.body));
  const moveOf = (b: string) => moves.get(b) ?? opts.start?.get(b) ?? moveIdentity(info.get(b)?.c ?? [0, 0, 0]);
  const sides = mates.map(sideOf);
  const sys = system(mates, sides, info, moveOf, outcomes);
  const coords = new Map(opts.coords ?? []);
  for (const g of groups(mates, moving)) {
    order.push(...g.bodies);
    // rigid: a body fastened to another as drawn takes its move (a single body with nothing else to solve)
    const own = g.mates.filter((i) => mates[i].kind !== "rigid");
    const rigid = g.mates.find((i) => mates[i].kind === "rigid");
    if (g.bodies.length === 1 && rigid !== undefined) {
      const b = g.bodies[0];
      const pm = moveOf(mates[rigid].b.body);
      const c = info.get(b)?.c ?? pm.c;
      // the same rigid move about another centre: q = R (p − c) + c + t'
      const t = sub(add(mv(pm.R, sub(c, pm.c)), add(pm.c, pm.t)), c);
      moves.set(b, { R: pm.R.slice(), c, t });
      for (const i of own) outcomes[i] = { name: mates[i].name, status: "conflict", message: `${mates[i].name} cannot hold: ${b} is fastened rigidly to ${mates[rigid].b.body}` };
      free.push({ body: b, dof: 0, words: `moves with ${mates[rigid].b.body}`, twists: [] });
      continue;
    }
    const L = Math.max(1, ...g.bodies.map((b) => info.get(b)?.size ?? 1));
    const start = new Map(g.bodies.map((b) => [b, moveOf(b)]));
    // the mates that hold together: all of them, or else the ones that do not conflict with those before them
    let keep = own.slice();
    const drag = opts.drag && g.bodies.includes(opts.drag.body) ? opts.drag : undefined;
    let res = solveGroup(g.bodies, keep, sys, start, L, coords, drag);
    if (!res.ok) {
      keep = [];
      const out: number[] = [];
      for (const i of own) {
        if (solveGroup(g.bodies, [...keep, i], sys, start, L, coords).ok) keep.push(i);
        else out.push(i);
      }
      res = solveGroup(g.bodies, keep, sys, start, L, coords, drag);
      // how far each left out is from holding, where the others put the parts
      for (const i of out) {
        const s = mates[i];
        const rel = sys.rels[i];
        let r: number[];
        if (rel) r = sys.eq(i, res.moves, res.refs, 1);
        else {
          const at = (b: string) => res.moves.get(b) ?? moveOf(b);
          r = residuals(s, placed(s.a.geom, at(s.a.body)), placed(s.b.geom, at(s.b.body)), 1, sides[i]);
        }
        const turned = s.kind === "angle" || s.kind === "parallel" || s.kind === "perpendicular";
        const off = turned ? (Math.asin(Math.min(1, Math.hypot(...r))) * 180) / Math.PI : rel?.qc === "turn" ? (Math.abs(r[0] ?? 0) * 180) / Math.PI : Math.hypot(...r);
        const deg = turned || rel?.qc === "turn";
        outcomes[i] = { name: s.name, status: "conflict", off, message: `${s.name} cannot hold with the mates before it (off by ${+off.toFixed(off < 1 ? 3 : 1)}${deg ? "°" : " mm"}), so it is left out` };
      }
    }
    for (const i of res.atLimit) outcomes[i] = { name: mates[i].name, status: "limit" };
    for (const [b, m] of res.moves) moves.set(b, m);
    for (const [k, v] of res.refs) coords.set(k, v);
    free.push(...freedom(g.bodies, keep, sys, moves, L, info, res.refs));
  }
  return { moves, outcomes, free, order, coords };
}

const TOL = 1e-7;

/** Gauss–Newton with the least-motion step for one group of bodies; limits held when they would be passed. */
function solveGroup(
  bodies: string[],
  use: number[],
  sys: System,
  start: Map<string, BodyMove>,
  L: number,
  coords: Map<string, number>,
  drag?: SolveOptions["drag"],
): { ok: boolean; moves: Map<string, BodyMove>; atLimit: number[]; refs: Map<string, number> } {
  const { mates, moveOf } = sys;
  const col = new Map(bodies.map((b, i) => [b, i]));
  const n = 6 * bodies.length;
  let cur = new Map([...start].map(([b, m]) => [b, { R: m.R.slice(), c: m.c, t: m.t.slice() as V3 }]));
  const poseOf = (b: string, M: Map<string, BodyMove>) => M.get(b) ?? moveOf(b);
  // turns counted round from where the solve starts, kept up after each step (each turns less than half a turn)
  const refs = new Map(coords);
  const mine = sys.turning.filter((i) => bodies.includes(mates[i].a.body) || bodies.includes(mates[i].b.body));
  const recount = () => {
    for (const i of mine) refs.set(mates[i].name, sys.turn(i, cur, refs));
  };
  recount();
  // limits: a range is free inside it and held at the bound it would pass
  const held = new Map<number, number>();
  const ranged = use.filter((i) => mates[i].min !== undefined || mates[i].max !== undefined);
  const eqs = (M: Map<string, BodyMove>) => {
    const out: number[] = [];
    for (const i of use) out.push(...sys.eq(i, M, refs, L, held.get(i)));
    return out;
  };
  const perturb = (M: Map<string, BodyMove>, k: number, h: number) => {
    const b = bodies[Math.floor(k / 6)];
    const m = M.get(b)!;
    const j = k % 6;
    const next = new Map(M);
    if (j < 3) {
      const w: V3 = [0, 0, 0];
      w[j] = h / L;
      next.set(b, { R: mm(expRot(w), m.R), c: m.c, t: m.t });
    } else {
      const t = m.t.slice() as V3;
      t[j - 3] += h;
      next.set(b, { R: m.R, c: m.c, t });
    }
    return next;
  };
  const step = (M: Map<string, BodyMove>, x: Float64Array) => {
    const next = new Map(M);
    for (const b of bodies) {
      const k = 6 * col.get(b)!;
      const m = M.get(b)!;
      let w: V3 = [x[k] / L, x[k + 1] / L, x[k + 2] / L];
      if (len(w) > 0.6) w = scl(w, 0.6 / len(w));
      let dt: V3 = [x[k + 3], x[k + 4], x[k + 5]];
      if (len(dt) > 2 * L) dt = scl(dt, (2 * L) / len(dt));
      next.set(b, { R: mm(expRot(w), m.R), c: m.c, t: add(m.t, dt) });
    }
    return next;
  };
  const jacobian = (M: Map<string, BodyMove>, f: (M: Map<string, BodyMove>) => number[], m: number) => {
    const J = new Float64Array(m * n);
    const h = 1e-6 * L;
    for (let k = 0; k < n; k++) {
      const rp = f(perturb(M, k, h)),
        rm = f(perturb(M, k, -h));
      for (let i = 0; i < m; i++) J[i * n + k] = (rp[i] - rm[i]) / (2 * h);
    }
    return J;
  };
  /** the least-motion step that zeroes r to first order: −Jᵀ (J Jᵀ)⁻¹ r */
  const minNorm = (J: Float64Array, r: number[], m: number) => {
    const A = new Float64Array(m * m);
    let tr = 0;
    for (let i = 0; i < m; i++)
      for (let j = i; j < m; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += J[i * n + k] * J[j * n + k];
        A[i * m + j] = A[j * m + i] = s;
        if (i === j) tr += s;
      }
    const mu = 1e-10 * (tr / Math.max(m, 1)) + 1e-14;
    for (let i = 0; i < m; i++) A[i * m + i] += mu;
    const y = solveSquare(A, Float64Array.from(r), m);
    const x = new Float64Array(n);
    if (!y) return x;
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = 0; i < m; i++) s += J[i * n + k] * y[i];
      x[k] = -s;
    }
    return x;
  };
  const dragRes = (M: Map<string, BodyMove>) => (drag ? sub(movePoint(poseOf(drag.body, M), drag.point), drag.target) : []);
  let kicks = 0;
  for (let round = 0; round < 6; round++) {
    for (let it = 0; it < 80; it++) {
      const r = eqs(cur);
      const m = r.length;
      const err = Math.hypot(...r);
      if (!drag && (!m || err < TOL * L)) break;
      const J = m ? jacobian(cur, eqs, m) : new Float64Array(0);
      const x = m ? minNorm(J, r, m) : new Float64Array(n);
      if (drag) {
        // within what the mates leave free (P = I − J⁺J), a Gauss–Newton step toward the drag target, from where
        // the mates' own step leaves the point
        const Jd = jacobian(cur, dragRes, 3);
        const rd = dragRes(cur);
        for (let i = 0; i < 3; i++) for (let k = 0; k < n; k++) rd[i] += Jd[i * n + k] * x[k];
        const P = new Float64Array(n * n);
        for (let k = 0; k < n; k++) P[k * n + k] = 1;
        if (m) {
          for (let k = 0; k < n; k++) {
            const col: number[] = [];
            for (let i = 0; i < m; i++) col.push(J[i * n + k]);
            const back = minNorm(J, col, m);
            for (let j = 0; j < n; j++) P[j * n + k] += back[j];
          }
        }
        const A = new Float64Array(3 * n);
        for (let i = 0; i < 3; i++) for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) A[i * n + k] += Jd[i * n + j] * P[j * n + k];
        const y = minNorm(A, rd, 3);
        for (let k = 0; k < n; k++) {
          let s = 0;
          for (let j = 0; j < n; j++) s += P[k * n + j] * y[j];
          x[k] += s;
        }
      }
      const moved = Math.hypot(...Array.from(x));
      // stuck where the equations do not say which way to turn (faces drawn facing the same way for against(), or
      // parallel for perpendicular()): turn the bodies a little and go on
      if (!drag && moved < 1e-7 * L && err >= TOL * L && kicks < 6) {
        kicks++;
        const w: V3 = [0, 0, 0];
        w[kicks % 3] = 0.6;
        cur = new Map([...cur].map(([b, mv]) => [b, { R: mm(expRot(w), mv.R), c: mv.c, t: mv.t }]));
        recount();
        continue;
      }
      cur = step(cur, x);
      recount();
      if (moved < 1e-9 * L && err < TOL * L) break;
    }
    // limits: hold the ones passed at the bound they passed (each solve starts with none held)
    let changed = false;
    for (const i of ranged) {
      const s = mates[i];
      const v = sys.measure(i, cur, refs);
      const lo = s.min ?? -Infinity,
        hi = s.max ?? Infinity;
      if (!held.has(i) && (v < lo - 1e-9 || v > hi + 1e-9)) {
        held.set(i, v < lo ? lo : hi);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const r = eqs(cur);
  const ok = Math.hypot(...r) < 1e-5 * L;
  return { ok, moves: cur, atLimit: [...held.keys()], refs };
}

/** What each body of a group can still do once its mates hold: the null space of their equations. */
function freedom(bodies: string[], use: number[], sys: System, moves: Map<string, BodyMove>, L: number, info: Map<string, MateBody>, refs: Map<string, number>): BodyFreedom[] {
  const n = 6 * bodies.length;
  const moveOf = sys.moveOf;
  // what holds as it moves: every mate but the limits it is inside (a joint with limits still holds as a joint)
  const eqs = (M: Map<string, BodyMove>) => use.flatMap((i) => sys.eq(i, M, refs, L));
  const r0 = eqs(moves);
  const m = r0.length;
  const S = new Float64Array(n * n);
  if (m) {
    const h = 1e-6 * L;
    const J = new Float64Array(m * n);
    for (let k = 0; k < n; k++) {
      const b = bodies[Math.floor(k / 6)];
      const j = k % 6;
      const at = (sgn: number) => {
        const mo = moves.get(b) ?? moveOf(b);
        const next = new Map(moves);
        if (j < 3) {
          const w: V3 = [0, 0, 0];
          w[j] = (sgn * h) / L;
          next.set(b, { R: mm(expRot(w), mo.R), c: mo.c, t: mo.t });
        } else {
          const t = mo.t.slice() as V3;
          t[j - 3] += sgn * h;
          next.set(b, { R: mo.R, c: mo.c, t });
        }
        return eqs(next);
      };
      const rp = at(1),
        rm = at(-1);
      for (let i = 0; i < m; i++) J[i * n + k] = (rp[i] - rm[i]) / (2 * h);
    }
    for (let a = 0; a < n; a++)
      for (let b = a; b < n; b++) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i * n + a] * J[i * n + b];
        S[a * n + b] = S[b * n + a] = s;
      }
  }
  const { values, V } = symEigen(S, n);
  const big = Math.max(1e-30, ...Array.from(values));
  const nullVecs: Float64Array[] = [];
  for (let k = 0; k < n; k++)
    if (values[k] < 1e-8 * big || !m) {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) v[i] = V[i * n + k];
      nullVecs.push(v);
    }
  return bodies.map((b, bi) => {
    // this body's part of each free motion, made independent (Gram–Schmidt)
    const basis: Float64Array[] = [];
    for (const v of nullVecs) {
      const part = v.slice(6 * bi, 6 * bi + 6);
      for (const q of basis) {
        let d = 0;
        for (let i = 0; i < 6; i++) d += part[i] * q[i];
        for (let i = 0; i < 6; i++) part[i] -= d * q[i];
      }
      const l = Math.hypot(...Array.from(part));
      if (l > 1e-6) basis.push(part.map((x) => x / l));
    }
    const twists = basis.map((q) => ({ w: [q[0] / L, q[1] / L, q[2] / L] as V3, v: [q[3], q[4], q[5]] as V3 }));
    const c = movePoint(moves.get(b) ?? moveOf(b), info.get(b)?.c ?? [0, 0, 0]);
    return { body: b, dof: twists.length, words: freedomWords(twists, c, L), twists };
  });
}

const AXIS_NAMES: [V3, string][] = [
  [[1, 0, 0], "X"],
  [[0, 1, 0], "Y"],
  [[0, 0, 1], "Z"],
];
const dirWord = (d: V3) => {
  const u = unit(d);
  for (const [a, w] of AXIS_NAMES) if (Math.abs(dot(u, a)) > 0.9999) return w;
  return fmtV(u);
};

/** Free motions in words: what turns about which axis, what slides which way. */
export function freedomWords(twists: { w: V3; v: V3 }[], c: V3, L: number): string {
  if (!twists.length) return "fully placed by its mates";
  if (twists.length === 6) return "free: nothing places it";
  const { turns, slides } = splitFreedom(twists, L);
  const words: string[] = [];
  if (turns.length === 1) {
    const { w, v } = turns[0];
    // the axis it turns about passes through c + (w × v) / |w|² (anywhere along a plane it also slides in)
    const across = slides.some((s) => Math.abs(dot(unit(s), unit(w))) < 0.999);
    words.push(across ? `turns about ${dirWord(w)}` : `turns about an axis along ${dirWord(w)} through ${fmtV(add(c, scl(cross(w, v), 1 / dot(w, w))))}`);
  } else if (turns.length === 2) words.push("turns two ways");
  else if (turns.length === 3) words.push("turns every way");
  if (slides.length === 1) words.push(`slides along ${dirWord(slides[0])}`);
  else if (slides.length === 2) words.push(`slides in the plane across ${dirWord(cross(slides[0], slides[1]))}`);
  else if (slides.length === 3) words.push("slides every way");
  return words.join(" and ");
}

/**
 * Free motions as pure slides (no turning in them) and turns (each with the slide that comes with it about the
 * body's centre): combinations of the basis with no turning are the slides; the rest, made square to them, turn.
 */
export function splitFreedom(twists: { w: V3; v: V3 }[], L: number): { turns: { w: V3; v: V3 }[]; slides: V3[] } {
  const k = twists.length;
  // G = Wᵀ W over the turning parts: its null vectors mix the basis into motions that do not turn
  const G = new Float64Array(k * k);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) G[i * k + j] = dot(twists[i].w, twists[j].w) * L * L;
  const { values, V } = symEigen(G, k);
  const slides: V3[] = [];
  const turnsRaw: { w: V3; v: V3 }[] = [];
  for (let e = 0; e < k; e++) {
    let w: V3 = [0, 0, 0],
      v: V3 = [0, 0, 0];
    for (let i = 0; i < k; i++) {
      w = add(w, scl(twists[i].w, V[i * k + e]));
      v = add(v, scl(twists[i].v, V[i * k + e]));
    }
    if (values[e] < 1e-10) {
      for (const s of slides) v = sub(v, scl(s, dot(v, s)));
      if (len(v) > 1e-6) slides.push(unit(v));
    } else turnsRaw.push({ w, v });
  }
  // a turn's slide along the free slides is not part of it
  const turns = turnsRaw.map(({ w, v }) => {
    let q = v;
    for (const s of slides) q = sub(q, scl(s, dot(q, s)));
    return { w, v: q };
  });
  return { turns, slides };
}
