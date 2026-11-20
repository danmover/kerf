// Where moving parts are at a given driver angle: turning parts by their
// rate (carried round by what they ride on), and linkages solved from their
// connecting rods: a piston slides until the rod's length fits between the
// crank pin and the wrist pin, a rocker swings until it does, and the rod
// follows both pins. A part with travel of its own (a lift, a carriage)
// slides at its rate until the travel ends, where the whole drive turns
// back as its motor would; a wheel or roller turns by whatever keeps its
// surface from slipping on what it runs on. Shared by the motion preview,
// the checks and the simulation, so all three agree. Matrices are
// column-major 4 × 4.

import type { Link, Motion } from "./model";
import type { V3 } from "../kernel/recipe";

export type Mat4 = number[];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => scl(a, 1 / (len(a) || 1));

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

export const applyMat = (m: Mat4, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

const translation = (v: V3): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v[0], v[1], v[2], 1];

/** A turn of `rad` about the line through `o` along `axis`. */
export function rotation(o: V3, axis: V3, rad: number): Mat4 {
  const [x, y, z] = unit(axis);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  const R: Mat4 = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
  // about o: move o to the origin, turn, move back
  const ro = applyMat(R, o);
  R[12] = o[0] - ro[0];
  R[13] = o[1] - ro[1];
  R[14] = o[2] - ro[2];
  return R;
}

/** Where a linkage is at a driver angle (degrees): the crank pin, the follower's pin, and how far the follower has slid (mm) or swung (rad). */
export interface LinkState {
  P: V3;
  W: V3;
  x: number;
  /** false when the rod cannot span the pins here: the linkage locks before this angle */
  reach: boolean;
}

export function solveLink(l: Link, deg: number): LinkState {
  const P = applyMat(motionPose(l.driver, deg), l.p0);
  const a = unit(l.follower.axis);
  const L = l.length;
  if (l.follower.kind === "slide") {
    // the wrist pin moves along the axis until it is a rod's length from the crank pin
    const d0 = sub(l.w0, l.p0);
    const branch = dot(d0, a) < 0 ? -1 : 1;
    const d = sub(l.w0, P);
    const da = dot(d, a);
    const disc = da * da - dot(d, d) + L * L;
    const x = -da + branch * Math.sqrt(Math.max(0, disc));
    return { P, W: add(l.w0, scl(a, x)), x, reach: disc >= -1e-6 * L * L };
  }
  // a rocker: the pin swings on a circle round the pivot; the rod's length (in that plane) fixes where on it
  const C = l.follower.at;
  const inPlane = (q: V3): V3 => {
    const v = sub(q, C);
    return sub(v, scl(a, dot(v, a)));
  };
  const w0p = inPlane(l.w0);
  const r = len(w0p);
  const Pp = inPlane(P);
  const dz = dot(sub(P, C), a) - dot(sub(l.w0, C), a);
  const L2 = L * L - dz * dz;
  const D = len(Pp);
  if (r < 1e-9 || D < 1e-9) return { P, W: l.w0, x: 0, reach: false };
  const e1 = scl(Pp, 1 / D);
  const e2 = cross(a, e1);
  const along = (D * D + r * r - L2) / (2 * D);
  const h2 = r * r - along * along;
  // stay on the side of the pivot-to-crank-pin line the rocker is drawn on
  const side = dot(cross(inPlane(l.p0), w0p), a) < 0 ? -1 : 1;
  const Wp = add(scl(e1, along), scl(e2, side * Math.sqrt(Math.max(0, h2))));
  const x = Math.atan2(dot(cross(w0p, Wp), a), dot(w0p, Wp));
  return { P, W: applyMat(rotation(C, a, x), l.w0), x, reach: h2 >= -1e-6 * r * r && L2 >= 0 };
}

/** The rod's placement: from its drawn pins to where they are now. */
function rodPose(l: Link, s: LinkState): Mat4 {
  const u0 = unit(sub(l.w0, l.p0));
  const u = unit(sub(s.W, s.P));
  const c = cross(u0, u);
  const sn = len(c);
  const R = sn < 1e-12 ? identity() : rotation([0, 0, 0], c, Math.atan2(sn, dot(u0, u)));
  // move p0 to the origin, turn the rod onto the new direction, then put the pin on the crank pin
  return mul(translation(s.P), mul(R, translation(scl(l.p0, -1))));
}

/**
 * The drive's own angle at a driver angle that only ever counts up: a design whose travel ends runs `range`
 * degrees out and the same back, over and over.
 */
export function driveAngle(deg: number, range: number | undefined): number {
  if (!range) return deg;
  const period = 2 * range;
  let x = deg % period;
  if (x < 0) x += period;
  return x <= range ? x : period - x;
}

/** The inverse of a pose: it turns and moves, so the inverse turn is the transpose. */
function unpose(m: Mat4): Mat4 {
  const t: V3 = [m[12], m[13], m[14]];
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1];
}

/**
 * How fast a rolling part turns about its own axis (radians per degree of the drive) for its surface not to slide on
 * what it runs on. The touch point is held by whatever carries the wheel's axle; there, the wheel's rim and the
 * other part's surface must move together. The carrier's and the other part's velocities come from their poses a
 * hair either side, kept inside the drive's run so that a turnaround is never straddled.
 */
export function rollRate(m: Motion, deg: number): number {
  const roll = m.roll;
  if (!roll || roll.r < 1e-9) return 0;
  const h = 1e-3;
  let a = deg - h;
  let b = deg + h;
  if (m.range) {
    a = Math.max(0, a);
    b = Math.min(m.range, b);
  }
  if (b - a < 1e-9) return 0;
  const carried = (x: number) => (m.parent ? motionPose(m.parent, x) : null);
  const under = (x: number) => (roll.on ? motionPose(roll.on, x) : null);
  const put = (M: Mat4 | null, q: V3) => (M ? applyMat(M, q) : q);
  const W = carried(deg);
  const c = put(W, roll.at);
  const vW = sub(put(carried(b), roll.at), put(carried(a), roll.at));
  const O = under(deg);
  // the other part's own point under the touch point, and how that point moves
  const q = O ? applyMat(unpose(O), c) : c;
  const vO = sub(put(under(b), q), put(under(a), q));
  // the way the rim moves at the touch point as the wheel turns forward about its axis
  const ax = unit(m.axis);
  const arm = sub(roll.at, add(m.origin, scl(ax, dot(sub(roll.at, m.origin), ax))));
  const t0 = unit(cross(ax, arm));
  const t = sub(put(W, add(roll.at, t0)), c);
  return -dot(sub(vW, vO), t) / (roll.r * (b - a));
}

/** Degrees of the drive each kept running total covers. */
const ROLL_CELL = 2;
const rollTables = new WeakMap<Motion, { steady: number | null; fwd: number[]; back: number[] }>();

/**
 * How far a rolling part has turned (radians) at a drive angle. Most roll at a steady rate (a wheel on a straight or
 * round track, a disc on a tyre): rate × angle. The rest (a roller on a rocker, a wheel on a piston) add the rate
 * up, Simpson's rule over fixed cells whose running totals are kept, so the same angle always gives the same turn.
 */
function rollAngle(m: Motion, d: number): number {
  let t = rollTables.get(m);
  if (!t) {
    const span = m.range ?? 360;
    const r0 = rollRate(m, 0.5 * span);
    const steady = [0.07, 0.29, 0.61, 0.93].every((f) => Math.abs(rollRate(m, f * span) - r0) <= 1e-7 * Math.max(1e-6, Math.abs(r0)));
    t = { steady: steady ? r0 : null, fwd: [0], back: [0] };
    rollTables.set(m, t);
  }
  if (t.steady !== null) return t.steady * d;
  const cell = (a: number, b: number) => ((b - a) / 6) * (rollRate(m, a) + 4 * rollRate(m, (a + b) / 2) + rollRate(m, b));
  const sg = d < 0 ? -1 : 1;
  const k = Math.floor(Math.abs(d) / ROLL_CELL);
  const sums = sg > 0 ? t.fwd : t.back;
  for (let i = sums.length; i <= k; i++) sums.push(sums[i - 1] + cell(sg * (i - 1) * ROLL_CELL, sg * i * ROLL_CELL));
  return sums[k] + cell(sg * k * ROLL_CELL, d);
}

/** A motion's own move at a drive angle already folded into its run, before what carries it. */
function ownPose(m: Motion, d: number): Mat4 {
  if (m.link && m.kind) {
    const s = solveLink(m.link, d);
    return m.kind === "rod" ? rodPose(m.link, s) : m.kind === "slide" ? translation(scl(unit(m.axis), s.x)) : rotation(m.origin, m.axis, s.x);
  }
  if (m.kind === "slide") return translation(scl(unit(m.axis), (m.rate ?? 0) * d));
  if (m.kind === "roll") return rotation(m.origin, m.axis, rollAngle(m, d));
  return rotation(m.origin, m.axis, (d * m.ratio * Math.PI) / 180);
}

/** Where a moving part is at a driver angle (degrees), as a matrix from where it is drawn. */
export function motionPose(m: Motion, deg: number): Mat4 {
  const d = driveAngle(deg, m.range);
  const own = ownPose(m, d);
  return m.parent ? mul(motionPose(m.parent, d), own) : own;
}

/**
 * Where a part is with the motions in `live` at one drive angle and every other motion at another: what one
 * drive does on its own while the rest of the design stays where it has got to. (The single drive angle only
 * plays a design's drives together; each still carries its own load.)
 */
export function motionPoseSplit(m: Motion, deg: number, rest: number, live: ReadonlySet<Motion>): Mat4 {
  const own = ownPose(m, driveAngle(live.has(m) ? deg : rest, m.range));
  return m.parent ? mul(motionPoseSplit(m.parent, deg, rest, live), own) : own;
}

/**
 * Settle the drive once every part is known. A part with travel of its own makes the drive run out and back: by
 * how many degrees is the shortest run any of them gives (travel ÷ its per_turn), or one turn when none says. A
 * slide with no per_turn takes the whole run for its whole travel. Every motion in the design then carries the run.
 */
export function finishDrive(parts: { motion?: Motion }[]): number | undefined {
  const all = new Set<Motion>();
  const walk = (m: Motion | undefined) => {
    if (!m || all.has(m)) return;
    all.add(m);
    walk(m.parent);
    walk(m.link?.driver);
    walk(m.roll?.on);
  };
  for (const p of parts) walk(p.motion);
  const lifts = [...all].filter((m) => m.kind === "slide" && !m.link && !!m.travel);
  if (!lifts.length) return undefined;
  const runs = lifts.filter((m) => m.perTurn).map((m) => (Math.abs(m.travel!) / m.perTurn!) * 360);
  const range = runs.length ? Math.min(...runs) : 360;
  for (const m of lifts) m.rate = m.perTurn ? (Math.sign(m.travel!) * m.perTurn) / 360 : m.travel! / range;
  for (const m of all) m.range = range;
  return range;
}

/** A linkage through one turn of its driver: where the rod cannot reach, the follower's travel, and the worst transmission angle. */
export interface LinkSweep {
  /** driver angles (degrees) where the rod cannot span the pins */
  stuck: number[];
  /** slide (mm) or swing (degrees) range */
  min: number;
  max: number;
  /** the smallest transmission angle (degrees): 90° when the rod pushes along the follower's travel; under about 30° it pushes sideways and binds */
  worst: number;
  worstAt: number;
  /** degrees of driver turn for one full cycle (360 / its rate) */
  cycle: number;
}

export function sweepLink(l: Link, steps = 72): LinkSweep {
  const rate = Math.abs(l.driver.ratio) || 1;
  const cycle = 360 / rate;
  const stuck: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  let worst = 90;
  let worstAt = 0;
  const a = unit(l.follower.axis);
  for (let i = 0; i < steps; i++) {
    const deg = (cycle * i) / steps;
    const s = solveLink(l, deg);
    if (!s.reach) {
      stuck.push(deg);
      continue;
    }
    const x = l.follower.kind === "slide" ? s.x : (s.x * 180) / Math.PI;
    min = Math.min(min, x);
    max = Math.max(max, x);
    // the direction the follower's pin moves: along the slide, or round the pivot
    const travel = l.follower.kind === "slide" ? a : unit(cross(a, sub(s.W, l.follower.at)));
    const rod = unit(sub(s.W, s.P));
    // transmission angle: 90° when the rod pushes straight along the travel, 0° when it pushes square across it
    const mu = 90 - (Math.acos(Math.min(1, Math.abs(dot(rod, travel)))) * 180) / Math.PI;
    if (mu < worst) {
      worst = mu;
      worstAt = deg;
    }
  }
  return { stuck, min, max, worst, worstAt, cycle };
}
