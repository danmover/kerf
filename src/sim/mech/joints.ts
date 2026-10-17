// Joints between two bodies (a pivot, a slider, a ball joint, a weld) and
// what can act along a pivot's or slider's own axis: end stops, friction,
// springs and dampers. Each joint keeps its coordinate (the pivot's angle or
// the slider's travel from the design pose) and the force it carried, for
// the run's channels and results.

import { Body, Row, cross, dot, perp, qconj, qmul, qrot, sub, type Constraint, type Solver, type V3 } from "./solver";

const AXES: V3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export type JointKind = "pivot" | "slider" | "ball" | "weld";

export abstract class Joint implements Constraint {
  /** anchor in each body's frame */
  readonly rA: V3;
  readonly rB: V3;
  /** joint axis in each body's frame */
  readonly aA: V3;
  readonly aB: V3;
  /** coordinate from the design pose: rad for a pivot, m for a slider */
  coord = 0;
  /** coordinate speed, rad/s or m/s */
  speed = 0;
  /** force or torque along the axis from the rows acting on it this step (N or N·m) */
  axisLoad = 0;
  /** rows along the axis (drives, stops, friction, springs) add their impulses here */
  axisImpulse = 0;
  protected rows: Row[];

  constructor(
    public name: string,
    public kind: JointKind,
    public A: Body,
    public B: Body,
    anchor: V3,
    axis: V3,
    nRows: number,
  ) {
    this.rA = A.toLocal(anchor);
    this.rB = B.toLocal(anchor);
    this.aA = A.dirToLocal(axis);
    this.aB = B.dirToLocal(axis);
    this.rows = Array.from({ length: nRows }, () => new Row());
  }

  /** the axis in the world, as the parent body carries it */
  axis(): V3 {
    return this.A.dir(this.aA);
  }
  anchorA(): V3 {
    return this.A.point(this.rA);
  }
  anchorB(): V3 {
    return this.B.point(this.rB);
  }

  /** adds s × the joint's coordinate speed to a row */
  abstract axisTerms(r: Row, s: number): Row;

  /** force the joint carries across its anchor (not along its free axis), N */
  reaction(dt: number): number {
    const r = this.rows;
    return Math.hypot(r[0].acc, r[1].acc, r[2]?.acc ?? 0) / dt;
  }

  abstract build(s: Solver, dt: number, emit: (r: Row) => void): void;

  after(_s: Solver, dt: number) {
    this.axisLoad = this.axisImpulse / dt;
    this.axisImpulse = 0;
    this.update();
  }

  /** recompute the coordinate and its speed from the bodies */
  abstract update(): void;
}

/** point-to-point rows: the two anchors stay together */
function anchorRows(j: Joint, rows: Row[], s: Solver, dt: number, emit: (r: Row) => void) {
  const pA = j.anchorA();
  const pB = j.anchorB();
  const C = sub(pB, pA);
  for (let k = 0; k < 3; k++) {
    const r = rows[k].reset();
    r.pointTerm(j.A, pA, AXES[k], -1).pointTerm(j.B, pB, AXES[k], 1).equal(C[k], s.beta, dt, true);
    emit(r);
  }
}

/** rows that hold the bodies' relative orientation at the design pose */
function lockRows(A: Body, B: Body, q0: [number, number, number, number], rows: Row[], from: number, s: Solver, dt: number, emit: (r: Row) => void) {
  const rel = qmul(qconj(A.q), B.q);
  let d = qmul(rel, qconj(q0));
  if (d[0] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const e = qrot(A.q, [2 * d[1], 2 * d[2], 2 * d[3]]);
  for (let k = 0; k < 3; k++) {
    const r = rows[from + k].reset();
    r.spinTerm(A, AXES[k], -1).spinTerm(B, AXES[k], 1).equal(e[k], s.beta, dt, true);
    emit(r);
  }
}

export class Pivot extends Joint {
  private nA: V3;
  private nB: V3;
  private raw = 0;

  constructor(name: string, A: Body, B: Body, anchor: V3, axis: V3) {
    super(name, "pivot", A, B, anchor, axis, 5);
    const [n] = perp(axis);
    this.nA = A.dirToLocal(n);
    this.nB = B.dirToLocal(n);
  }

  axisTerms(r: Row, s: number): Row {
    const a = this.axis();
    return r.spinTerm(this.A, a, -s).spinTerm(this.B, a, s);
  }

  build(s: Solver, dt: number, emit: (r: Row) => void) {
    anchorRows(this, this.rows, s, dt, emit);
    const a = this.axis();
    const b = this.B.dir(this.aB);
    const c = cross(a, b);
    const [u1, u2] = perp(a);
    for (const [k, u] of [u1, u2].entries()) {
      const r = this.rows[3 + k].reset();
      r.spinTerm(this.A, u, -1).spinTerm(this.B, u, 1).equal(dot(c, u), s.beta, dt, true);
      emit(r);
    }
  }

  update() {
    const a = this.axis();
    const na = this.A.dir(this.nA);
    const nb = this.B.dir(this.nB);
    const raw = Math.atan2(dot(cross(na, nb), a), dot(na, nb));
    let d = raw - this.raw;
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d < -Math.PI) d += 2 * Math.PI;
    this.raw = raw;
    this.coord += d;
    this.speed = dot(sub(this.B.w, this.A.w), a);
  }
}

export class Slider extends Joint {
  private q0: [number, number, number, number];

  constructor(name: string, A: Body, B: Body, anchor: V3, axis: V3) {
    super(name, "slider", A, B, anchor, axis, 5);
    this.q0 = qmul(qconj(A.q), B.q);
  }

  axisTerms(r: Row, s: number): Row {
    const a = this.axis();
    const pB = this.anchorB();
    return r.pointTerm(this.A, pB, a, -s).pointTerm(this.B, pB, a, s);
  }

  reaction(dt: number): number {
    return Math.hypot(this.rows[0].acc, this.rows[1].acc) / dt;
  }

  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const a = this.axis();
    const pA = this.anchorA();
    const pB = this.anchorB();
    const d = sub(pB, pA);
    const [u1, u2] = perp(a);
    for (const [k, u] of [u1, u2].entries()) {
      const r = this.rows[k].reset();
      r.pointTerm(this.A, pB, u, -1).pointTerm(this.B, pB, u, 1).equal(dot(d, u), s.beta, dt, true);
      emit(r);
    }
    lockRows(this.A, this.B, this.q0, this.rows, 2, s, dt, emit);
  }

  update() {
    const a = this.axis();
    const pB = this.anchorB();
    this.coord = dot(sub(pB, this.anchorA()), a);
    this.speed = dot(sub(this.B.velAt(pB), this.A.velAt(pB)), a);
  }
}

export class Ball extends Joint {
  constructor(name: string, A: Body, B: Body, anchor: V3) {
    super(name, "ball", A, B, anchor, [0, 0, 1], 3);
  }
  axisTerms(r: Row): Row {
    return r;
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    anchorRows(this, this.rows, s, dt, emit);
  }
  update() {}
}

export class Weld extends Joint {
  private q0: [number, number, number, number];
  constructor(name: string, A: Body, B: Body, anchor: V3) {
    super(name, "weld", A, B, anchor, [0, 0, 1], 6);
    this.q0 = qmul(qconj(A.q), B.q);
  }
  axisTerms(r: Row): Row {
    return r;
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    anchorRows(this, this.rows, s, dt, emit);
    lockRows(this.A, this.B, this.q0, this.rows, 3, s, dt, emit);
  }
  update() {}
}

// ---------- along a joint's axis ----------

/** End stops: the coordinate stays within lo..hi. Records when it reaches one. */
export class Stops implements Constraint {
  private lower = new Row();
  private upper = new Row();
  /** time spent pressed on each stop, and the hardest push, N or N·m */
  hits: { side: "lower" | "upper"; t: number }[] = [];
  pressing: "lower" | "upper" | null = null;
  peak = 0;

  constructor(
    public j: Joint,
    public lo: number,
    public hi: number,
    /** how near a stop it starts watching, in the coordinate's units */
    private margin: number,
    private restitution = 0,
  ) {}

  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const c = this.j.coord;
    if (Number.isFinite(this.lo) && c - this.lo < this.margin) {
      const r = this.j.axisTerms(this.lower.reset(), 1).oneSided(c - this.lo, s.beta, 0, dt, this.restitution);
      emit(r);
    } else this.lower.wasActive = false;
    if (Number.isFinite(this.hi) && this.hi - c < this.margin) {
      const r = this.j.axisTerms(this.upper.reset(), -1).oneSided(this.hi - c, s.beta, 0, dt, this.restitution);
      emit(r);
    } else this.upper.wasActive = false;
  }

  after(_s: Solver, dt: number) {
    const lo = this.lower.wasActive ? this.lower.acc : 0;
    const hi = this.upper.wasActive ? this.upper.acc : 0;
    this.j.axisImpulse += lo - hi;
    const push = Math.max(lo, hi) / dt;
    if (push > this.peak) this.peak = push;
    this.pressing = lo > 1e-9 ? "lower" : hi > 1e-9 ? "upper" : null;
  }
}

/** Friction along the axis: a constant part plus a share of the load across the joint (a bearing's or a bushing's). */
export class AxisFriction implements Constraint {
  private row = new Row();
  constructor(
    public j: Joint,
    /** N·m or N */
    public constant: number,
    /** friction coefficient × radius (pivot, m) or coefficient (slider) times the load across the joint */
    public perLoad: number,
  ) {}
  build(_s: Solver, dt: number, emit: (r: Row) => void) {
    const load = this.perLoad > 0 ? this.j.reaction(dt) : 0;
    const lim = (this.constant + this.perLoad * load) * dt;
    if (lim <= 0) return;
    emit(this.j.axisTerms(this.row.reset(), 1).friction(lim));
  }
  after() {
    if (this.row.wasActive) this.j.axisImpulse += this.row.acc;
  }
}

/** A spring and damper along the axis: torque or force = -k (coord - free) - c speed. */
export class AxisSpring implements Constraint {
  private row = new Row();
  force = 0;
  constructor(
    public j: Joint,
    public k: number,
    public c: number,
    /** coordinate at which the spring is relaxed */
    public free: number,
  ) {}
  build(_s: Solver, dt: number, emit: (r: Row) => void) {
    emit(this.j.axisTerms(this.row.reset(), 1).spring(this.k, this.c, this.j.coord - this.free, dt));
  }
  after(_s: Solver, dt: number) {
    this.force = this.row.acc / dt;
    this.j.axisImpulse += this.row.acc;
  }
}
