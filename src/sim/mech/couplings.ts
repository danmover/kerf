// What links one joint's motion to another's: gear teeth (spur gears and a
// rack and pinion, through the pitch point), a screw thread (lead screws,
// ball screws and worm gears), a fixed ratio (chains and sprockets, or any
// drive Kerf has no closer model for), a cam and its follower, and clutches
// and brakes. Each keeps the lost motion its teeth or chain allow (backlash,
// slack) and loses what its friction loses: a gear mesh its efficiency, a
// screw the thread friction that also decides whether it can be back-driven.

import { Body, Row, cross, dot, norm, scale, sub, type Constraint, type Solver, type V3 } from "./solver";
import type { Joint } from "./joints";

/** Keeps a lost-motion coordinate inside ±gap/2 (or at 0 when there is no gap) through one row. */
class Play {
  /** relative travel along the row since the start, row units (m or rad) */
  s = 0;
  side: -1 | 0 | 1 = 0;
  constructor(public gap: number) {}

  /** sets the row's target and bounds; the row's J measures ds/dt */
  limit(r: Row, s: Solver, dt: number) {
    const half = this.gap / 2;
    if (half <= 0) {
      r.equal(this.s, s.beta, dt);
      this.side = 0;
      return;
    }
    // the side the play is nearer to carries the load
    const side = this.s <= 0 ? -1 : 1;
    if (side !== this.side) r.acc = 0;
    this.side = side;
    if (side < 0) r.oneSided(this.s + half, s.beta, 0, dt);
    else {
      // flip the row so it pushes the other way: J·v ≤ (half - s)/dt
      for (let i = 0; i < r.n * 6; i++) r.J[i] = -r.J[i];
      r.oneSided(half - this.s, s.beta, 0, dt);
    }
  }

  /** the row's impulse in its unflipped sense */
  impulse(r: Row): number {
    return this.side > 0 ? -r.acc : r.acc;
  }

  advance(r: Row, dt: number) {
    // r.jv() includes the flip when on the upper side
    const v = r.jv() + r.drift;
    this.s += dt * (this.side > 0 ? -v : v);
  }
}

export interface Loss {
  joint: Joint;
  /** bound on the friction impulse per unit of the link's impulse */
  perImpulse: number;
}

/** Tooth contact at the pitch point: spur gears on two pivots, or a pinion and a rack on a slider. */
export class ToothMesh implements Constraint {
  private row = new Row();
  private loss = new Row();
  play: Play;
  /** tooth force this step and the most it carried, N */
  force = 0;
  peak = 0;
  /** pitch point and tooth direction each step */
  where: () => { p: V3; t: V3 };

  constructor(
    public name: string,
    public g1: Body,
    public g2: Body,
    where: () => { p: V3; t: V3 },
    backlash: number,
    /** friction acting against the driven joint, per newton of tooth force */
    public friction: Loss | null,
  ) {
    this.where = where;
    this.play = new Play(backlash);
  }

  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const { p, t } = this.where();
    const r = this.row.reset().pointTerm(this.g1, p, t, -1).pointTerm(this.g2, p, t, 1);
    r.track = true;
    this.play.limit(r, s, dt);
    emit(r);
    if (this.friction) emit(this.friction.joint.axisTerms(this.loss.reset(), 1).friction(0, r, this.friction.perImpulse));
  }

  after(_s: Solver, dt: number) {
    this.play.advance(this.row, dt);
    this.force = Math.abs(this.row.acc) / dt;
    if (this.force > this.peak) this.peak = this.force;
    if (this.friction && this.loss.wasActive) this.friction.joint.axisImpulse += this.loss.acc;
  }
}

/**
 * A screw thread: a point on the follower (a nut, or a worm wheel's pitch point) moves along the screw's axis by
 * lead × turns of the screw. Thread friction acts against the screw's turning in proportion to the thrust, so a
 * screw whose friction angle exceeds its lead angle holds its load without power (self-locking).
 */
export class Thread implements Constraint {
  private row = new Row();
  private loss = new Row();
  play: Play;
  thrust = 0;
  peak = 0;

  constructor(
    public name: string,
    public screw: Joint,
    public follower: Body,
    /** the follower's point on the thread, each step */
    public point: () => V3,
    /** m the follower moves along the axis per rad of screw rotation (- for a right-hand thread: turning the
     * screw forward about its axis drives the nut back along it) */
    public k: number,
    backlash: number,
    /** friction torque on the screw per newton of thrust, m (μ' × mean thread radius) */
    public frictionArm: number,
  ) {
    this.play = new Play(backlash);
  }

  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const a = this.screw.axis();
    const p = this.point();
    // follower along the axis, relative to the screw's own material there, against lead × screw speed
    const r = this.row.reset().pointTerm(this.follower, p, a, 1).pointTerm(this.screw.B, p, a, -1);
    this.screw.axisTerms(r, this.k);
    r.track = true;
    this.play.limit(r, s, dt);
    emit(r);
    if (this.frictionArm > 0) emit(this.screw.axisTerms(this.loss.reset(), 1).friction(0, r, this.frictionArm));
  }

  after(_s: Solver, dt: number) {
    this.play.advance(this.row, dt);
    this.thrust = this.play.impulse(this.row) / dt;
    if (Math.abs(this.thrust) > this.peak) this.peak = Math.abs(this.thrust);
    if (this.loss.wasActive) this.screw.axisImpulse += this.loss.acc;
  }
}

/** A fixed ratio between two joints' speeds (b = ratio × a): chains and sprockets, or any drive given as a ratio. */
export class RatioLink implements Constraint {
  private row = new Row();
  private loss = new Row();
  play: Play;
  /** torque (or force) carried at b */
  load = 0;
  peak = 0;
  constructor(
    public name: string,
    public a: Joint,
    public b: Joint,
    public ratio: number,
    /** lost motion at b, in b's units */
    slack: number,
    public efficiency: number,
    /** stretch in the link (a belt), N·m/rad or N/m at b; rigid when left out */
    public stiffness = 0,
  ) {
    this.play = new Play(slack);
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const r = this.b.axisTerms(this.row.reset(), 1);
    this.a.axisTerms(r, -this.ratio);
    r.track = true;
    if (this.stiffness > 0) {
      // lightly damped (5 % of critical for what the link moves), stretched by how far b has slipped behind
      const K = r.inverseMass();
      r.spring(this.stiffness, K > 0 ? 0.1 * Math.sqrt(this.stiffness / K) : 0, this.play.s, dt);
    } else this.play.limit(r, s, dt);
    emit(r);
    if (this.efficiency < 1) emit(this.b.axisTerms(this.loss.reset(), 1).friction(0, r, 1 - this.efficiency));
  }
  after(_s: Solver, dt: number) {
    this.play.advance(this.row, dt);
    this.load = this.play.impulse(this.row) / dt;
    if (Math.abs(this.load) > this.peak) this.peak = Math.abs(this.load);
    if (this.loss.wasActive) this.b.axisImpulse += this.loss.acc;
  }
}

/** A cam's lift against its angle, from a table sampled evenly over one turn (m). */
export class Profile {
  constructor(public lift: Float64Array) {}
  private at(i: number) {
    const n = this.lift.length;
    return this.lift[((i % n) + n) % n];
  }
  /** lift and its slope (m/rad) at an angle, by cubic interpolation */
  eval(theta: number): [number, number] {
    const n = this.lift.length;
    const x = (theta / (2 * Math.PI)) * n;
    const i = Math.floor(x);
    const u = x - i;
    const p0 = this.at(i - 1);
    const p1 = this.at(i);
    const p2 = this.at(i + 1);
    const p3 = this.at(i + 2);
    // Catmull-Rom
    const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const c = -0.5 * p0 + 0.5 * p2;
    const y = ((a * u + b) * u + c) * u + p1;
    const dy = ((3 * a * u + 2 * b) * u + c) * (n / (2 * Math.PI));
    return [y, dy];
  }
}

/**
 * A cam on a pivot pushing a follower on a slider. A spring-loaded follower can leave the cam when the spring
 * cannot pull it back fast enough (follower jump); a grooved cam drives it both ways.
 */
export class Cam implements Constraint {
  private row = new Row();
  force = 0;
  peak = 0;
  /** how far the follower is off the cam, m */
  gap = 0;
  maxGap = 0;
  liftedFor = 0;
  private y0: number;
  constructor(
    public name: string,
    public cam: Joint,
    public follower: Joint,
    public profile: Profile,
    /** profile angle facing the follower at the design pose, rad */
    public phase: number,
    public grooved: boolean,
  ) {
    this.y0 = profile.eval(phase)[0];
  }
  /** the cam's lift under the follower at the cam's current angle */
  lift(): [number, number] {
    const [y, dy] = this.profile.eval(this.phase - this.cam.coord);
    return [y - this.y0, -dy];
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const [y, dy] = this.lift();
    const C = this.follower.coord - y;
    const r = this.follower.axisTerms(this.row.reset(), 1);
    this.cam.axisTerms(r, -dy);
    if (this.grooved) r.equal(C, s.beta, dt);
    else r.oneSided(C, s.beta, 0, dt);
    emit(r);
  }
  after(_s: Solver, dt: number) {
    this.force = this.row.acc / dt;
    if (Math.abs(this.force) > this.peak) this.peak = Math.abs(this.force);
    this.gap = this.follower.coord - this.lift()[0];
    if (!this.grooved && this.gap > 1e-4) {
      this.liftedFor += dt;
      if (this.gap > this.maxGap) this.maxGap = this.gap;
    }
  }
}

/** On/off over time: a list of (time s, 0 or 1), holding each value until the next. */
export type Schedule = [number, number][];

export function scheduled(s: Schedule | undefined, t: number, dflt = 1): number {
  if (!s || !s.length) return dflt;
  let v = s[0][0] <= t ? s[0][1] : dflt;
  for (const [ti, vi] of s) {
    if (ti > t) break;
    v = vi;
  }
  return v;
}

/** A value over time, straight between points (a speed profile, a force that ramps up). */
export function ramp(s: Schedule, t: number): number {
  if (!s.length) return 0;
  if (t <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    const [t1, v1] = s[i];
    if (t <= t1) {
      const [t0, v0] = s[i - 1];
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
    }
  }
  return s[s.length - 1][1];
}

/**
 * A friction clutch between two coaxial pivots (b driven by a): it slips above its torque. One-way, it drives b
 * forward and lets b overrun (a freewheel or ratchet). A brake is the same against the frame.
 */
export class Clutch implements Constraint {
  private row = new Row();
  slipping = false;
  slipTime = 0;
  torque = 0;
  constructor(
    public name: string,
    public a: Joint | null,
    public b: Joint,
    /** slip torque, N·m (Infinity for a one-way clutch that never slips) */
    public limit: number,
    public oneWay: boolean,
    public engaged: Schedule | undefined,
  ) {}
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const on = scheduled(this.engaged, s.t, 1) > 0.5;
    if (!on) return;
    const r = this.b.axisTerms(this.row.reset(), 1);
    if (this.a) this.a.axisTerms(r, -1);
    if (this.oneWay) {
      r.lo = 0;
      r.hi = Number.isFinite(this.limit) ? this.limit * dt : Infinity;
    } else r.friction(this.limit * dt);
    emit(r);
  }
  after(_s: Solver, dt: number) {
    const active = this.row.wasActive;
    this.torque = active ? this.row.acc / dt : 0;
    const rel = this.b.speed - (this.a?.speed ?? 0);
    this.slipping = active && !this.oneWay && Math.abs(rel) > 1e-3;
    if (this.slipping) this.slipTime += dt;
    if (active) this.b.axisImpulse += this.row.acc;
  }
}

/** the pitch point and tooth direction of two spur gears on parallel axes */
export function gearPitch(g1: Body, c1: V3, g2: Body, c2: V3, axis: () => V3, r1: number): () => { p: V3; t: V3 } {
  const l1 = g1.toLocal(c1);
  const l2 = g2.toLocal(c2);
  return () => {
    const a = axis();
    const p1 = g1.point(l1);
    const d = sub(g2.point(l2), p1);
    const e = norm(sub(d, scale(a, dot(d, a))));
    return { p: [p1[0] + e[0] * r1, p1[1] + e[1] * r1, p1[2] + e[2] * r1], t: cross(a, e) };
  };
}
