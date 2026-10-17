// Force elements: springs, dampers and gas springs between two points, and
// loads over time on a body (a force at a point, a torque).

import { Body, Row, scale, sub, len, type Constraint, type Solver, type V3 } from "./solver";
import { ramp, type Schedule } from "./couplings";

/**
 * A spring (and damper) between a point on each of two bodies. k against stretch from its free length; push:
 * a constant force pushing the ends apart (a gas spring), + apart. Its force is + when it pushes.
 */
export class PointSpring implements Constraint {
  private row = new Row();
  private lA: V3;
  private lB: V3;
  force = 0;
  peak = 0;
  length: number;
  minLength: number;
  maxLength: number;
  constructor(
    public name: string,
    public A: Body,
    public B: Body,
    pA: V3,
    pB: V3,
    public k: number,
    public c: number,
    public free: number,
    public push: number,
  ) {
    this.lA = A.toLocal(pA);
    this.lB = B.toLocal(pB);
    this.length = this.minLength = this.maxLength = len(sub(pB, pA));
  }
  ends(): [V3, V3] {
    return [this.A.point(this.lA), this.B.point(this.lB)];
  }
  build(_s: Solver, dt: number, emit: (r: Row) => void) {
    const [pA, pB] = this.ends();
    const d = sub(pB, pA);
    const L = len(d);
    if (L < 1e-6) return;
    const n = scale(d, 1 / L);
    emit(this.row.reset().pointTerm(this.A, pA, n, -1).pointTerm(this.B, pB, n, 1).spring(this.k, this.c, L - this.free, dt, this.push));
  }
  after(_s: Solver, dt: number) {
    this.force = this.row.wasActive ? this.row.acc / dt : 0;
    if (Math.abs(this.force) > this.peak) this.peak = Math.abs(this.force);
    const [a, b] = this.ends();
    this.length = len(sub(b, a));
    if (this.length < this.minLength) this.minLength = this.length;
    if (this.length > this.maxLength) this.maxLength = this.length;
  }
}

/** A force over time on a body at a point, along a fixed world direction or one that turns with the body. */
export class BodyLoad implements Constraint {
  private row = new Row();
  private lp: V3;
  private ld: V3;
  constructor(
    public name: string,
    public body: Body,
    at: V3,
    dir: V3,
    /** N over time */
    public value: Schedule,
    public turnsWithBody: boolean,
    /** a torque about dir instead of a force along it (N·m) */
    public torque = false,
  ) {
    this.lp = body.toLocal(at);
    this.ld = turnsWithBody ? body.dirToLocal(dir) : dir;
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const dir = this.turnsWithBody ? this.body.dir(this.ld) : this.ld;
    const r = this.row.reset();
    if (this.torque) r.spinTerm(this.body, dir, 1);
    else r.pointTerm(this.body, this.body.point(this.lp), dir, 1);
    emit(r.push(ramp(this.value, s.t) * dt));
  }
}
