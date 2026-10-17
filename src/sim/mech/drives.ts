// What drives a joint: the design's own catalog motors, hobby servos and
// linear actuators (their electrical state comes from the plant each step,
// so the firmware drives them), and inputs a scenario gives directly: a hand
// turning a crank at a speed, a solenoid, an air cylinder on a valve, a force
// or torque over time. Each acts along its joint's axis and records the
// torque or force it gave, for the run's results.

import { Row, type Constraint, type Solver } from "./solver";
import type { Joint } from "./joints";
import { ramp, scheduled, type Schedule } from "./couplings";

/** an axis drive's common bookkeeping: the load it gave and the work it did */
abstract class AxisDrive implements Constraint {
  protected row = new Row();
  protected fr = new Row();
  /** torque (N·m) or force (N) it applied this step, + along the joint's axis */
  load = 0;
  peak = 0;
  /** mechanical work done, J */
  work = 0;
  power = 0;
  constructor(
    public name: string,
    public joint: Joint,
  ) {}
  abstract build(s: Solver, dt: number, emit: (r: Row) => void): void;
  after(_s: Solver, dt: number) {
    let imp = this.row.wasActive ? this.row.acc : 0;
    if (this.fr.wasActive) imp += this.fr.acc;
    this.joint.axisImpulse += imp;
    this.load = imp / dt;
    if (Math.abs(this.load) > this.peak) this.peak = Math.abs(this.load);
    this.power = this.load * this.joint.speed;
    this.work += this.power * dt;
  }
}

/** An ideal speed (a hand on a crank, a test rig) with a limit on the torque or force it can give. */
export class SpeedSource extends AxisDrive {
  constructor(
    name: string,
    joint: Joint,
    /** rad/s or m/s over time */
    public speed: Schedule,
    public limit: number,
  ) {
    super(name, joint);
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const r = this.joint.axisTerms(this.row.reset(), 1);
    r.target = ramp(this.speed, s.t);
    r.lo = -this.limit * dt;
    r.hi = this.limit * dt;
    emit(r);
  }
}

/** A torque or force along the axis over time (a person pushing, a weight on a cord). */
export class AxisForce extends AxisDrive {
  constructor(
    name: string,
    joint: Joint,
    public value: Schedule,
  ) {
    super(name, joint);
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    emit(this.joint.axisTerms(this.row.reset(), 1).push(ramp(this.value, s.t) * dt));
  }
}

/**
 * A DC gearmotor (catalog part) turning a pivot: torque = kt (v - ke ω) / R, held within the driver's current
 * limit, against its gearbox friction. Its voltage comes from the plant each step, so firmware drives it.
 */
export class MotorDrive extends AxisDrive {
  /** terminal volts (null: the driver leaves it open), set each step */
  v: number | null = null;
  ilim = 99;
  constructor(
    name: string,
    joint: Joint,
    /** +1 when the motor's own forward turns the joint forward */
    public sign: number,
    public kt: number,
    public ke: number,
    public resistance: () => number,
    /** gearbox friction torque, N·m */
    public tf: number,
  ) {
    super(name, joint);
  }
  build(_s: Solver, dt: number, emit: (r: Row) => void) {
    if (this.v !== null) {
      const R = this.resistance();
      const b = (this.kt * this.ke) / R;
      const r = this.joint.axisTerms(this.row.reset(), this.sign).soft(0, b, 0, dt);
      r.target = this.v / this.ke;
      r.lo = -this.kt * this.ilim * dt;
      r.hi = this.kt * this.ilim * dt;
      emit(r);
    }
    if (this.tf > 0) emit(this.joint.axisTerms(this.fr.reset(), 1).friction(this.tf * dt));
  }
  after(_s: Solver, dt: number) {
    // the drive row works in the motor's sense
    const drive = this.row.wasActive ? this.sign * this.row.acc : 0;
    const fric = this.fr.wasActive ? this.fr.acc : 0;
    this.joint.axisImpulse += drive + fric;
    this.load = drive / dt;
    if (Math.abs(this.load) > this.peak) this.peak = Math.abs(this.load);
    this.power = this.load * this.joint.speed;
    this.work += this.power * dt;
  }
  /** the motor's output speed and angle in its own sense */
  get omega() {
    return this.sign * this.joint.speed;
  }
  get angle() {
    return this.sign * this.joint.coord;
  }
}

/**
 * A hobby servo turning a pivot: it drives towards the angle its pulse asks for, at up to its rated speed,
 * with its torque falling off with speed from the stall torque. Unpowered or without a pulse it goes limp
 * against the friction of its gear train.
 */
export class ServoDrive extends AxisDrive {
  /** wanted joint angle, rad (null: no pulse) */
  goal: number | null = null;
  powered = false;
  constructor(
    name: string,
    joint: Joint,
    public sign: number,
    /** N·m */
    public stall: number,
    /** rad/s */
    public maxSpeed: number,
  ) {
    super(name, joint);
  }
  build(_s: Solver, dt: number, emit: (r: Row) => void) {
    if (this.goal !== null && this.powered) {
      // proportional band of about 3°, then full speed
      const err = this.goal - this.joint.coord;
      const want = Math.max(-this.maxSpeed, Math.min(this.maxSpeed, (err * this.maxSpeed) / 0.05));
      const r = this.joint.axisTerms(this.row.reset(), 1).soft(0, this.stall / this.maxSpeed, 0, dt);
      r.target = want;
      r.lo = -this.stall * dt;
      r.hi = this.stall * dt;
      emit(r);
    } else emit(this.joint.axisTerms(this.fr.reset(), 1).friction(0.08 * this.stall * dt));
  }
}

/**
 * A linear actuator (catalog part) on a slider: its speed falls with load to nothing at its stall force; its
 * lead screw holds the load when unpowered until the back-drive force.
 */
export class ActuatorDrive extends AxisDrive {
  v: number | null = null;
  constructor(
    name: string,
    joint: Joint,
    public sign: number,
    public vRated: number,
    /** m/s */
    public vFree: number,
    /** N */
    public fStall: number,
    public fBack: number,
    public dead = 0.25,
  ) {
    super(name, joint);
  }
  build(_s: Solver, dt: number, emit: (r: Row) => void) {
    const u = this.v === null ? 0 : Math.min(1.2, Math.abs(this.v) / this.vRated);
    if (this.v !== null && this.v !== 0 && u > this.dead) {
      const s = Math.sign(this.v);
      const frac = (u - this.dead) / (1 - this.dead);
      const fs = this.fStall * u;
      const vmax = this.vFree * frac;
      const r = this.joint.axisTerms(this.row.reset(), this.sign).soft(0, fs / vmax, 0, dt);
      r.target = s * vmax;
      r.lo = -fs * dt;
      r.hi = fs * dt;
      emit(r);
    } else emit(this.joint.axisTerms(this.fr.reset(), 1).friction(this.fBack * dt));
  }
  after(_s: Solver, dt: number) {
    const drive = this.row.wasActive ? this.sign * this.row.acc : 0;
    const hold = this.fr.wasActive ? this.fr.acc : 0;
    this.joint.axisImpulse += drive + hold;
    this.load = (drive + hold) / dt;
    if (Math.abs(this.load) > this.peak) this.peak = Math.abs(this.load);
    this.power = (drive / dt) * this.joint.speed;
    this.work += this.power * dt;
  }
}

/**
 * A pull or push solenoid on a slider: when energised its force grows as the gap closes (about as 1/gap²),
 * from its rated force at full stroke. The return spring is a separate spring.
 */
export class Solenoid extends AxisDrive {
  constructor(
    name: string,
    joint: Joint,
    /** +1 pushes the slider forward, -1 pulls it back */
    public dir: number,
    /** N at full stroke */
    public force: number,
    /** m */
    public stroke: number,
    public on: Schedule,
  ) {
    super(name, joint);
  }
  /** the gap left to close, m */
  gap(): number {
    return Math.max(0, Math.min(this.stroke, this.stroke - this.dir * this.joint.coord));
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    if (scheduled(this.on, s.t, 0) < 0.5) return;
    const g0 = 0.25 * this.stroke;
    const f = this.force * ((this.stroke + g0) / (this.gap() + g0)) ** 2;
    emit(this.joint.axisTerms(this.row.reset(), 1).push(this.dir * f * dt));
  }
}

/**
 * A pneumatic cylinder on a slider worked by a valve: pressure × piston area pushes it out (the annulus pulls it
 * back), the exhaust flow limits its speed, and its seals drag.
 */
export class AirCylinder extends AxisDrive {
  constructor(
    name: string,
    joint: Joint,
    public sign: number,
    /** N extending and retracting at full pressure */
    public fOut: number,
    public fIn: number,
    /** m/s the flow allows */
    public vmax: number,
    /** seal friction, N */
    public seal: number,
    /** valve: 1 extend, 0 retract (or -1 exhaust both, the rod free) */
    public valve: Schedule,
  ) {
    super(name, joint);
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const v = scheduled(this.valve, s.t, 0);
    if (v >= 0) {
      const out = v > 0.5;
      const f = out ? this.fOut : this.fIn;
      const r = this.joint.axisTerms(this.row.reset(), this.sign).soft(0, f / this.vmax, 0, dt);
      r.target = out ? this.vmax : -this.vmax;
      // air only pushes the way the valve feeds it
      r.lo = out ? 0 : -f * dt;
      r.hi = out ? f * dt : 0;
      emit(r);
    }
    if (this.seal > 0) emit(this.joint.axisTerms(this.fr.reset(), 1).friction(this.seal * dt));
  }
  after(_s: Solver, dt: number) {
    const drive = this.row.wasActive ? this.sign * this.row.acc : 0;
    const fr = this.fr.wasActive ? this.fr.acc : 0;
    this.joint.axisImpulse += drive + fr;
    this.load = drive / dt;
    if (Math.abs(this.load) > this.peak) this.peak = Math.abs(this.load);
    this.power = this.load * this.joint.speed;
    this.work += this.power * dt;
  }
}
