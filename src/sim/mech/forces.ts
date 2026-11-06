// Force elements: springs, dampers and gas springs between two points, and
// loads over time on a body (a force at a point, a torque).

import { Body, Row, add, cross, dot, len, scale, sub, type Constraint, type Solver, type V3 } from "./solver";
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

/** What a fan's ESC and rotor are doing this step. */
export interface FanState {
  /** N, rad/s, rad/s², N·m of air drag on the blades */
  thrust: number;
  omega: number;
  alpha: number;
  drag: number;
  /** rotor inertia, kg·m², spin direction about the thrust axis (+1 counter-clockwise seen from the intake), swept area, m² */
  J: number;
  spin: number;
  area: number;
}

export interface JetVane {
  name: string;
  body: Body;
  /** centre of pressure and pivot axis in the vane body's frame, and the jet direction it is aligned with at zero */
  lp: V3;
  la: V3;
  lc: V3;
  area: number;
  cla: number;
  ar: number;
  /** this step: angle to the jet (rad), lift (N) and whether it is stalled */
  angle: number;
  lift: number;
  stalled: boolean;
}

/**
 * A ducted fan's jet on the bodies it touches: the thrust on the fan's body along its axis; each vane's lift
 * (from the jet's dynamic pressure, thrust / (2 × swept area), its angle to the jet and a low-aspect-ratio lift
 * slope that stops growing past stall) and drag; and on the fan's body the rotor's gyroscopic torque when the
 * body turns, the reaction to it speeding up, and the swirl torque the stators do not take back.
 */
export class JetForces implements Constraint {
  private rows: Row[] = [];
  /** this step: net thrust along the axis (after vane drag), side force from the vanes, gyroscopic torque, N and N·m */
  thrust = 0;
  side = 0;
  gyro = 0;
  peakVane = 0;
  peakGyro = 0;
  stallTime = 0;
  private lp: V3;
  private lax: V3;
  constructor(
    public name: string,
    public fanBody: Body,
    at: V3,
    axis: V3,
    public vanes: JetVane[],
    public stall: number,
    public recovery: number,
    public state: () => FanState,
  ) {
    this.lp = fanBody.toLocal(at);
    this.lax = fanBody.dirToLocal(axis);
  }

  build(_s: Solver, dt: number, emit: (r: Row) => void) {
    const st = this.state();
    const acc = new Map<Body, { f: V3; t: V3 }>();
    const put = (b: Body, f: V3, at: V3 | null, t: V3 = [0, 0, 0]) => {
      if (b.fixed) return;
      const e = acc.get(b) ?? { f: [0, 0, 0], t: [0, 0, 0] };
      e.f = add(e.f, f);
      e.t = add(e.t, add(t, at ? cross(sub(at, b.x), f) : [0, 0, 0]));
      acc.set(b, e);
    };
    const ax = this.fanBody.dir(this.lax);
    const d = scale(ax, -1);
    put(this.fanBody, scale(ax, st.thrust), this.fanBody.point(this.lp));
    const q = st.area > 0 ? st.thrust / (2 * st.area) : 0;
    let drag = 0;
    const side: V3 = [0, 0, 0];
    let stalled = false;
    for (const v of this.vanes) {
      const c = v.body.dir(v.lc);
      const a = v.body.dir(v.la);
      const ang = Math.atan2(dot(cross(d, c), a), dot(d, c));
      const lim = this.stall;
      // flat-plate lift: linear to stall, then it holds about 70 % of its peak
      const cl = Math.abs(ang) <= lim ? v.cla * ang : Math.sign(ang) * v.cla * lim * 0.7;
      const cd = 0.03 + (cl * cl) / (Math.PI * v.ar);
      v.angle = ang;
      v.lift = q * v.area * cl;
      v.stalled = Math.abs(ang) > lim && q > 1;
      if (v.stalled) stalled = true;
      const n = cross(a, d);
      const nl = len(n) || 1;
      // the jet turned toward the vane's chord pushes the vane the other way
      const f = add(scale(n, -v.lift / nl), scale(d, q * v.area * cd));
      drag += q * v.area * cd;
      for (let i = 0; i < 3; i++) side[i] += f[i] - dot(f, d) * d[i];
      put(v.body, f, v.body.point(v.lp));
      if (Math.abs(v.lift) > this.peakVane) this.peakVane = Math.abs(v.lift);
    }
    if (stalled) this.stallTime += dt;
    // the rotor's angular momentum: turning the body turns it, and speeding it up twists the body back
    const H = scale(ax, st.J * st.omega * st.spin);
    const gyro = scale(cross(this.fanBody.w, H), -1);
    const react = scale(ax, -st.spin * (st.J * st.alpha + (1 - this.recovery) * st.drag));
    put(this.fanBody, [0, 0, 0], null, add(gyro, react));
    this.thrust = st.thrust - drag;
    this.side = len(side);
    this.gyro = len(gyro);
    if (this.gyro > this.peakGyro) this.peakGyro = this.gyro;
    let k = 0;
    const row = () => (this.rows[k] ??= new Row(), this.rows[k++].reset());
    const E: V3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (const [b, e] of acc)
      for (let i = 0; i < 3; i++) {
        if (e.f[i]) emit(row().pointTerm(b, b.x, E[i], 1).push(e.f[i] * dt));
        if (e.t[i]) emit(row().spinTerm(b, E[i], 1).push(e.t[i] * dt));
      }
  }
}
