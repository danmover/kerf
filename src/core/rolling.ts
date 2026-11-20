// Contact that is meant: a wheel on its track, a roller on a tower, a tyre
// pressed on the disc it turns. A design says so with rolls_on:, and the
// checks then hold the two to what rolling needs (they meet, the soft one is
// pressed in no further than rubber gives) instead of reading the contact as
// a collision. Two surfaces that meet without sliding on each other while
// the parts turn against each other are rolling too, said or not.

import type { MeshData } from "../kernel/build";
import type { Interference } from "../kernel/protocol";
import type { V3 } from "../kernel/recipe";
import { materialRecord } from "../library/materialDb";
import { identity, motionPose, mul, type Mat4 } from "./kinematics";
import { turns, type EvalPart, type Motion } from "./model";
import { depthAlong } from "./preload";

/** Softer than this (Young's modulus, MPa) gives under a wheel's load: rubbers, TPU, silicone, soft polyurethane. */
const SOFT_E = 500;
/** How far a soft tyre can be pressed in: a tenth of its rolling radius, up to this many mm. */
const MAX_SQUEEZE = 4;

/** A part of rubber or another material that gives: it can be drawn pressed into what it runs on. */
export function isSoft(p: EvalPart): boolean {
  const E = materialRecord(p.material)?.mech?.E;
  return E !== undefined && E < SOFT_E;
}

/** Whether the design says these two run on each other (rolls_on: on either). */
export function rollsOnEachOther(a: EvalPart, b: EvalPart): boolean {
  return !!a.rollsOn?.names.includes(b.name) || !!b.rollsOn?.names.includes(a.name);
}

/** The line a part turns about by its own motion (as drawn), when it turns: a wheel's axle, not what carries it. */
export function ownAxis(m: Motion | undefined): { o: V3; u: V3 } | null {
  if (!m || m.link || m.kind === "slide" || m.kind === "swing" || m.kind === "rod") return null;
  if (m.kind !== "roll" && Math.abs(m.ratio) < 1e-12) return null;
  const l = Math.hypot(m.axis[0], m.axis[1], m.axis[2]) || 1;
  return { o: m.origin, u: [m.axis[0] / l, m.axis[1] / l, m.axis[2] / l] };
}

/** How far a tyre of this rolling radius may be pressed into what it runs on (0 when neither part gives). */
export function squeezeAllowed(a: EvalPart, b: EvalPart, radius: number | undefined): number {
  if (!isSoft(a) && !isSoft(b)) return 0;
  return Math.min(MAX_SQUEEZE, 0.1 * (radius && radius > 0 ? radius : 15));
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** From an axis line square out to a point: the direction and the distance (the rolling radius there). */
export function radial(axis: { o: V3; u: V3 }, p: V3): { dir: V3; r: number } {
  const d = sub(p, axis.o);
  const k = d[0] * axis.u[0] + d[1] * axis.u[1] + d[2] * axis.u[2];
  const v: V3 = [d[0] - k * axis.u[0], d[1] - k * axis.u[1], d[2] - k * axis.u[2]];
  const r = len(v);
  return { dir: r > 1e-9 ? [v[0] / r, v[1] / r, v[2] / r] : [0, 0, 0], r };
}

export interface RollSqueeze {
  /** the part that turns, and what it runs on */
  wheel: EvalPart;
  track: EvalPart;
  /** how deep the two are drawn into each other, square to the wheel's axis, mm */
  depth: number;
  /** how deep rubber of this size takes up (0: neither part gives) */
  allowed: number;
  /** the wheel's rolling radius where they meet */
  radius: number;
}

/**
 * An overlap between two parts that run on each other, as drawn: how deep the wheel is pressed in, measured from its
 * axis out through the overlap, and how deep its material allows. Null when the design does not say they roll.
 */
export function rollSqueeze(i: Interference, partOf: (id: string) => EvalPart | undefined): RollSqueeze | null {
  const A = partOf(i.a);
  const B = partOf(i.b);
  if (!A || !B || !rollsOnEachOther(A, B)) return null;
  // the wheel is the one that turns on its own axle; when both do (a tyre on a disc), the soft one, else the one that says rolls_on:
  const cands = [A, B].filter((p) => ownAxis(p.motion));
  const wheel = cands.length === 2 ? (isSoft(B) && !isSoft(A) ? B : A.rollsOn?.names.includes(B.name) || isSoft(A) ? A : B) : (cands[0] ?? (A.rollsOn?.names.includes(B.name) ? A : B));
  const track = wheel === A ? B : A;
  const axis = ownAxis(wheel.motion);
  if (!axis || !i.mesh) return { wheel, track, depth: NaN, allowed: squeezeAllowed(A, B, undefined), radius: NaN };
  const { dir, r } = radial(axis, i.center);
  if (r < 1e-6) return { wheel, track, depth: NaN, allowed: squeezeAllowed(A, B, undefined), radius: NaN };
  return { wheel, track, depth: depthAlong(i.mesh as MeshData, dir), allowed: squeezeAllowed(A, B, r), radius: r };
}

const unpose = (m: Mat4): Mat4 => {
  const t: V3 = [m[12], m[13], m[14]];
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1];
};
const poseOf = (m: Motion | undefined, deg: number): Mat4 => (m && turns(m) ? motionPose(m, deg) : identity());

/** How a part moves just now: it turns by `w` (radians per degree of the drive) and its material at the world origin moves by `v` (mm per degree). */
interface Twist {
  w: V3;
  v: V3;
}

/** A motion's twist at a driver angle, from its poses a hair either side (inside the drive's run, so a turnaround is never straddled). */
function twistOf(m: Motion | undefined, deg: number): Twist {
  if (!m || !turns(m)) return { w: [0, 0, 0], v: [0, 0, 0] };
  const h = 0.01;
  let lo = deg - h;
  let hi = deg + h;
  if (m.range) {
    lo = Math.max(0, lo);
    hi = Math.min(m.range, hi);
  }
  const k = hi - lo;
  if (k < 1e-9) return { w: [0, 0, 0], v: [0, 0, 0] };
  // the small move from one side of the angle to the other, in the world
  const D = mul(poseOf(m, hi), unpose(poseOf(m, lo)));
  return { w: [(D[6] - D[9]) / (2 * k), (D[8] - D[2]) / (2 * k), (D[1] - D[4]) / (2 * k)], v: [D[12] / k, D[13] / k, D[14] / k] };
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface Slip {
  /** how fast the two surfaces slide past each other at the point, mm per degree of the drive */
  slip: number;
  /** how fast the two parts turn against each other, radians per degree of the drive */
  spin: number;
  /**
   * The line the two turn about each other on just now: a point on it, its direction, and how fast they slide
   * along it (mm per degree). Null when they do not turn against each other.
   */
  axis: { at: V3; u: V3; along: number } | null;
}

/**
 * How two moving parts' surfaces pass each other at a point (world, with the parts where they are at that driver
 * angle). Two parts that turn against each other do it, at any instant, about one line: where that line lies in both
 * their surfaces, the surfaces roll on each other there without sliding (see NO_SLIP_GAP).
 */
export function slipAt(a: Motion | undefined, b: Motion | undefined, deg: number, at: V3): Slip {
  const ta = twistOf(a, deg);
  const tb = twistOf(b, deg);
  const w = sub(ta.w, tb.w);
  const v = sub(ta.v, tb.v);
  const slip = len(add(v, cross(w, at)));
  const spin = len(w);
  if (spin < 1e-9) return { slip, spin: 0, axis: null };
  const u: V3 = [w[0] / spin, w[1] / spin, w[2] / spin];
  const c = cross(w, v);
  const o: V3 = [c[0] / (spin * spin), c[1] / (spin * spin), c[2] / (spin * spin)];
  // the point of the line nearest `at`
  const k = dot(sub(at, o), u);
  return { slip, spin, axis: { at: [o[0] + k * u[0], o[1] + k * u[1], o[2] + k * u[2]], u, along: dot(v, u) } };
}

/** The line two parts turn about each other on lies in both surfaces, within this many mm, where they roll: a fiftieth of a 15 mm wheel's radius. */
export const NO_SLIP_GAP = 0.3;
