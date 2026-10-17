// A small rigid multibody solver for mechanisms: bodies with the mass and
// inertia of their parts, and constraint rows for joints, couplings, drives
// and contacts. Each step solves the rows on velocities by projected
// Gauss-Seidel (sequential impulses, warm started from the last step), then
// removes drift with a separate pass on pseudo velocities (split impulses),
// so correcting positions never adds energy to the mechanism.
//
// Rows are soft or rigid. A rigid row holds J·v at its target; a soft row
// acts as an implicit spring and damper (or a motor's torque-speed line), so
// stiff springs and strong motors stay stable at the 1 ms step. Units are SI
// throughout: m, kg, s, N, rad.

export type V3 = [number, number, number];
/** w, x, y, z */
export type Quat = [number, number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const addScaled = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Two unit vectors at right angles to a unit vector and to each other. */
export function perp(a: V3): [V3, V3] {
  const t: V3 = Math.abs(a[0]) < 0.6 ? [1, 0, 0] : Math.abs(a[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  const u = norm(cross(a, t));
  return [u, cross(a, u)];
}

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export const qconj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];
export function qrot(q: Quat, v: V3): V3 {
  // v + 2w(u×v) + 2u×(u×v)
  const u: V3 = [q[1], q[2], q[3]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[0])), cross(u, t));
}
export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qaxis(axis: V3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}
/** The rotation (as a quaternion) whose columns are the given orthonormal axes. */
export function qfromBasis(x: V3, y: V3, z: V3): Quat {
  const tr = x[0] + y[1] + z[2];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s];
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    q = [(y[2] - z[1]) / s, 0.25 * s, (y[0] + x[1]) / s, (z[0] + x[2]) / s];
  } else if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    q = [(z[0] - x[2]) / s, (y[0] + x[1]) / s, 0.25 * s, (z[1] + y[2]) / s];
  } else {
    const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
    q = [(x[1] - y[0]) / s, (z[0] + x[2]) / s, (z[1] + y[2]) / s, 0.25 * s];
  }
  return qnorm(q);
}

export type M3 = [number, number, number, number, number, number, number, number, number];

export function inv3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-30) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function mulM3(m: M3 | Float64Array, v: V3): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export class Body {
  index = -1;
  v: V3 = [0, 0, 0];
  w: V3 = [0, 0, 0];
  /** force and torque applied this step (world frame), cleared after it */
  f: V3 = [0, 0, 0];
  t: V3 = [0, 0, 0];
  invMass = 0;
  /** inverse inertia in the body's own frame */
  invI: M3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  /** world inverse inertia, row-major 3×3 */
  iw = new Float64Array(9);
  /** pose at the start, for the design-relative transform */
  readonly x0: V3;
  readonly q0: Quat;

  constructor(
    public id: string,
    public mass: number,
    /** inertia tensor about the centre of mass in the body's frame (the design's axes at the start), kg·m² */
    public inertia: M3,
    /** centre of mass, world */
    public x: V3,
    public q: Quat = [1, 0, 0, 0],
    public fixed = false,
  ) {
    this.x0 = [...x];
    this.q0 = [...q];
    this.setMass(mass, inertia);
  }

  setMass(mass: number, inertia: M3) {
    this.mass = mass;
    this.inertia = inertia;
    this.invMass = this.fixed || mass <= 0 ? 0 : 1 / mass;
    this.invI = this.fixed ? [0, 0, 0, 0, 0, 0, 0, 0, 0] : inv3(inertia);
    this.updateInertia();
  }

  updateInertia() {
    // R I⁻¹ Rᵀ
    const c0 = qrot(this.q, [1, 0, 0]);
    const c1 = qrot(this.q, [0, 1, 0]);
    const c2 = qrot(this.q, [0, 0, 1]);
    const R = [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
    const I = this.invI;
    const T = new Array<number>(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[i * 3 + j] = R[i * 3] * I[j] + R[i * 3 + 1] * I[3 + j] + R[i * 3 + 2] * I[6 + j];
    const m = this.iw;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = T[i * 3] * R[j * 3] + T[i * 3 + 1] * R[j * 3 + 1] + T[i * 3 + 2] * R[j * 3 + 2];
  }

  /** world inverse inertia times a vector */
  invInertia(v: V3): V3 {
    const m = this.iw;
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }

  /** a point given in the body's frame, in the world */
  point(local: V3): V3 {
    return add(this.x, qrot(this.q, local));
  }
  toLocal(world: V3): V3 {
    return qrot(qconj(this.q), sub(world, this.x));
  }
  dir(local: V3): V3 {
    return qrot(this.q, local);
  }
  dirToLocal(world: V3): V3 {
    return qrot(qconj(this.q), world);
  }
  velAt(p: V3): V3 {
    return add(this.v, cross(this.w, sub(p, this.x)));
  }
  /** maps a design-pose point to where it is now */
  carry(p: V3): V3 {
    return this.point(qrot(qconj(this.q0), sub(p, this.x0)));
  }
  /** rotation from the design pose to now */
  turn(): Quat {
    return qmul(this.q, qconj(this.q0));
  }
  applyForce(f: V3, at: V3) {
    this.f = add(this.f, f);
    this.t = add(this.t, cross(sub(at, this.x), f));
  }
}

/** One scalar constraint on up to four bodies: J·v held at a target, within impulse bounds. */
export class Row {
  n = 0;
  b: Body[] = [];
  J = new Float64Array(24);
  MJ = new Float64Array(24);
  /** effective mass with softness, and without (for the position pass) */
  m = 0;
  m0 = 0;
  /** J·v the velocity pass aims for */
  target = 0;
  /** softness: 0 rigid, 1/(dt(c + dt k)) for a spring and damper */
  gamma = 0;
  lo = -Infinity;
  hi = Infinity;
  /** friction: bounds ±(fric + mu·|ref impulse|) */
  isFriction = false;
  fric = 0;
  ref: Row | null = null;
  mu = 0;
  /** position pass: 0 none, 1 equality, 2 one-sided (impulse ≥ 0); bias is its target pseudo velocity */
  pos = 0;
  bias = 0;
  /** accumulated impulse, kept between steps for warm starting */
  acc = 0;
  pacc = 0;
  wasActive = false;
  /** position error, and (for geometric rows) the error predicted at the end of the step */
  C = 0;
  geo = false;
  cPred = 0;
  stamp = 0;
  /** rows whose position is tracked by integration get J·(pseudo velocity) after each step */
  track = false;
  drift = 0;

  /** start rebuilding this row for the step */
  reset(): this {
    this.n = 0;
    this.target = 0;
    this.gamma = 0;
    this.lo = -Infinity;
    this.hi = Infinity;
    this.isFriction = false;
    this.fric = 0;
    this.ref = null;
    this.mu = 0;
    this.pos = 0;
    this.bias = 0;
    this.C = 0;
    this.geo = false;
    this.track = false;
    this.drift = 0;
    return this;
  }

  term(body: Body, lin: V3 | null, ang: V3 | null): this {
    if (body.fixed) return this;
    // the same body twice adds into one term
    let i = this.b.indexOf(body);
    if (i < 0 || i >= this.n) {
      i = this.n++;
      if (i >= 4) throw new Error("a constraint row can join at most four bodies");
      this.b[i] = body;
      this.J.fill(0, i * 6, i * 6 + 6);
    }
    const o = i * 6;
    if (lin) {
      this.J[o] += lin[0];
      this.J[o + 1] += lin[1];
      this.J[o + 2] += lin[2];
    }
    if (ang) {
      this.J[o + 3] += ang[0];
      this.J[o + 4] += ang[1];
      this.J[o + 5] += ang[2];
    }
    return this;
  }

  /** s × the velocity of a body's material point p along dir */
  pointTerm(body: Body, p: V3, dir: V3, s = 1): this {
    return this.term(body, scale(dir, s), scale(cross(sub(p, body.x), dir), s));
  }

  /** s × a body's angular velocity about an axis */
  spinTerm(body: Body, axis: V3, s = 1): this {
    return this.term(body, null, scale(axis, s));
  }

  /** J·v for the bodies' current velocities */
  jv(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const b = this.b[i];
      const o = i * 6;
      s += this.J[o] * b.v[0] + this.J[o + 1] * b.v[1] + this.J[o + 2] * b.v[2] + this.J[o + 3] * b.w[0] + this.J[o + 4] * b.w[1] + this.J[o + 5] * b.w[2];
    }
    return s;
  }

  /** soft spring and damper: stiffness k and damping c against an error C */
  soft(k: number, c: number, C: number, dt: number): this {
    const d = dt * (c + dt * k);
    if (d <= 0) return this;
    this.gamma = 1 / d;
    this.target = (-k * C) / (c + dt * k);
    return this;
  }

  /** this row's J M⁻¹ Jᵀ at the bodies' current inertia */
  inverseMass(): number {
    let K = 0;
    for (let i = 0; i < this.n; i++) {
      const b = this.b[i];
      const o = i * 6;
      const J = this.J;
      K += b.invMass * (J[o] * J[o] + J[o + 1] * J[o + 1] + J[o + 2] * J[o + 2]);
      const a = b.invInertia([J[o + 3], J[o + 4], J[o + 5]]);
      K += J[o + 3] * a[0] + J[o + 4] * a[1] + J[o + 5] * a[2];
    }
    return K;
  }

  /** a fixed impulse this step (an applied force × dt) */
  push(impulse: number): this {
    this.lo = this.hi = impulse;
    return this;
  }

  /**
   * A spring (k against the error C), a damper (c) and a constant push along the row. Soft enough springs act
   * as forces at the start of the step, which keeps vibrations from dying away numerically; stiff ones
   * (relative to the masses they move in one step) are solved implicitly so they can never blow up.
   */
  spring(k: number, c: number, C: number, dt: number, push = 0): this {
    const K = this.inverseMass();
    if (k * K * dt * dt < 0.1 && c * K * dt < 0.2) return this.push((-k * C - c * this.jv() + push) * dt);
    if (k > 0) return this.soft(k, c, C - push / k, dt);
    // damping with a constant push: the push rides on as a target offset of the damper
    if (c > 0) {
      this.soft(0, c, 0, dt);
      this.target += push / c;
      return this;
    }
    return this.push(push * dt);
  }

  /**
   * A rigid equality with position error C (drift removed in the position pass). geo: C is a function of the
   * bodies' poses alone, so the solver can follow the joint's curvature over the step.
   */
  equal(C: number, beta: number, dt: number, geo = false): this {
    this.pos = 1;
    this.bias = (-beta * C) / dt;
    this.C = C;
    this.geo = geo;
    return this;
  }

  /**
   * A one-sided limit: the gap C ≥ 0 (J pointing to open it). While open it may close within the step but no
   * further; once closed the position pass pushes it back out.
   */
  oneSided(C: number, beta: number, slop: number, dt: number, restitution = 0): this {
    this.lo = 0;
    this.pos = 2;
    this.target = C > 0 ? -C / dt : 0;
    if (restitution > 0) {
      const vn = this.jv();
      if (vn < -0.2) this.target = Math.max(this.target, -restitution * vn);
    }
    this.bias = C < -slop ? (-beta * (C + slop)) / dt : 0;
    return this;
  }

  friction(fric: number, ref: Row | null = null, mu = 0): this {
    this.isFriction = true;
    this.fric = fric;
    this.ref = ref;
    this.mu = mu;
    return this;
  }
}

export interface Constraint {
  /** add this step's rows (built from the bodies' current poses) */
  build(s: Solver, dt: number, emit: (r: Row) => void): void;
  /** read back impulses and update state once the bodies have moved */
  after?(s: Solver, dt: number): void;
}

export class Solver {
  bodies: Body[] = [];
  constraints: Constraint[] = [];
  gravity: V3 = [0, 0, -9.80665];
  /** simulated time, s */
  t = 0;
  iterations = 30;
  posIterations = 10;
  /** share of a position error removed each step */
  beta = 0.2;
  /** penetration allowed before the position pass acts, m */
  slop = 2e-5;
  rows: Row[] = [];
  private prev: Row[] = [];
  private stamp = 0;
  private pv: Float64Array = new Float64Array(0);

  addBody(b: Body): Body {
    b.index = this.bodies.length;
    this.bodies.push(b);
    return b;
  }

  add<T extends Constraint>(c: T): T {
    this.constraints.push(c);
    return c;
  }

  step(dt: number) {
    const bodies = this.bodies;
    const g = this.gravity;
    for (const b of bodies) {
      if (b.fixed) continue;
      b.updateInertia();
      b.v = [b.v[0] + dt * (b.f[0] * b.invMass + g[0]), b.v[1] + dt * (b.f[1] * b.invMass + g[1]), b.v[2] + dt * (b.f[2] * b.invMass + g[2])];
      b.w = addScaled(b.w, b.invInertia(b.t), dt);
      b.f = [0, 0, 0];
      b.t = [0, 0, 0];
    }

    // Joints on curved paths (a pendulum, a crank): projecting the velocity onto the joint's tangent each step
    // would bleed energy away as the tangent turns. So each geometric row first measures where its error would
    // be at the end of the step at the current velocities, and aims for the velocity that lands it exactly on the
    // joint (the chord, as SHAKE/RATTLE do), keeping the swing of a free mechanism.
    const stamp = ++this.stamp;
    const saved = bodies.map((b) => [b.x, b.q] as const);
    for (const b of bodies) if (!b.fixed) advance(b, dt, b.v, b.w);
    for (const c of this.constraints)
      c.build(this, dt, (r) => {
        if (r.geo) {
          r.cPred = r.C;
          r.stamp = stamp;
        }
      });
    bodies.forEach((b, i) => {
      b.x = saved[i][0];
      b.q = saved[i][1];
    });
    const rows = this.rows;
    rows.length = 0;
    const emit = (r: Row) => {
      if (r.n > 0) rows.push(r);
    };
    for (const c of this.constraints) c.build(this, dt, emit);
    for (const r of rows) if (r.geo && r.stamp === stamp) r.target -= (r.cPred - r.C - dt * r.jv()) / dt;

    for (const r of rows) {
      let K = 0;
      for (let i = 0; i < r.n; i++) {
        const b = r.b[i];
        const o = i * 6;
        const J = r.J;
        const M = r.MJ;
        M[o] = J[o] * b.invMass;
        M[o + 1] = J[o + 1] * b.invMass;
        M[o + 2] = J[o + 2] * b.invMass;
        const a = b.invInertia([J[o + 3], J[o + 4], J[o + 5]]);
        M[o + 3] = a[0];
        M[o + 4] = a[1];
        M[o + 5] = a[2];
        for (let k = 0; k < 6; k++) K += J[o + k] * M[o + k];
      }
      r.m = K + r.gamma > 1e-18 ? 1 / (K + r.gamma) : 0;
      r.m0 = K > 1e-18 ? 1 / K : 0;
      if (!r.wasActive) r.acc = 0;
      r.pacc = 0;
    }
    // warm start with last step's impulses (within this step's bounds)
    for (const r of rows) {
      if (r.acc === 0) continue;
      if (!r.isFriction) r.acc = Math.min(r.hi, Math.max(r.lo, r.acc));
      applyImpulse(r, r.acc, false);
    }

    for (let it = 0; it < this.iterations; it++) for (const r of rows) solveRow(r);

    // drift: pseudo velocities, used for this step's positions only
    const pv = this.pv.length === bodies.length * 6 ? this.pv : (this.pv = new Float64Array(bodies.length * 6));
    pv.fill(0);
    let anyPos = false;
    for (const r of rows) if (r.pos && r.bias !== 0) anyPos = true;
    if (anyPos) for (let it = 0; it < this.posIterations; it++) for (const r of rows) if (r.pos) solvePos(r, pv);

    for (const r of rows) {
      if (!r.track) continue;
      let d = 0;
      for (let i = 0; i < r.n; i++) {
        const o = r.b[i].index * 6;
        for (let j = 0; j < 6; j++) d += r.J[i * 6 + j] * pv[o + j];
      }
      r.drift = d;
    }

    for (const b of bodies) {
      if (b.fixed) continue;
      const o = b.index * 6;
      advance(b, dt, [b.v[0] + pv[o], b.v[1] + pv[o + 1], b.v[2] + pv[o + 2]], [b.w[0] + pv[o + 3], b.w[1] + pv[o + 4], b.w[2] + pv[o + 5]]);
    }

    for (const r of this.prev) r.wasActive = false;
    for (const r of rows) r.wasActive = true;
    this.prev = rows.slice();
    this.t += dt;
    for (const c of this.constraints) c.after?.(this, dt);
  }

  /** kinetic plus potential energy (for tests and checks), J */
  energy(): number {
    let e = 0;
    for (const b of this.bodies) {
      if (b.fixed) continue;
      e += 0.5 * b.mass * dot(b.v, b.v) - b.mass * dot(this.gravity, b.x);
      const wl = b.dirToLocal(b.w);
      e += 0.5 * dot(wl, mulM3(b.inertia, wl));
    }
    return e;
  }
}

/** moves a body along a velocity and spin for a time (the spin as an exact rotation) */
function advance(b: Body, dt: number, v: V3, w: V3) {
  b.x = [b.x[0] + dt * v[0], b.x[1] + dt * v[1], b.x[2] + dt * v[2]];
  const a = len(w) * dt;
  if (a > 1e-14) b.q = qnorm(qmul(qaxis(scale(w, 1 / len(w)), a), b.q));
}

function applyImpulse(r: Row, lam: number, _pseudo: boolean) {
  for (let i = 0; i < r.n; i++) {
    const b = r.b[i];
    const o = i * 6;
    const M = r.MJ;
    b.v = [b.v[0] + M[o] * lam, b.v[1] + M[o + 1] * lam, b.v[2] + M[o + 2] * lam];
    b.w = [b.w[0] + M[o + 3] * lam, b.w[1] + M[o + 4] * lam, b.w[2] + M[o + 5] * lam];
  }
}

function solveRow(r: Row) {
  if (r.m === 0) return;
  const d = (r.target - r.jv() - r.gamma * r.acc) * r.m;
  let a = r.acc + d;
  if (r.isFriction) {
    const lim = r.fric + (r.ref ? r.mu * Math.abs(r.ref.acc) : 0);
    a = a > lim ? lim : a < -lim ? -lim : a;
  } else a = a > r.hi ? r.hi : a < r.lo ? r.lo : a;
  const lam = a - r.acc;
  if (lam === 0) return;
  r.acc = a;
  applyImpulse(r, lam, false);
}

function solvePos(r: Row, pv: Float64Array) {
  if (r.m0 === 0) return;
  let jv = 0;
  for (let i = 0; i < r.n; i++) {
    const o = r.b[i].index * 6;
    const k = i * 6;
    for (let j = 0; j < 6; j++) jv += r.J[k + j] * pv[o + j];
  }
  const d = (r.bias - jv) * r.m0;
  let a = r.pacc + d;
  if (r.pos === 2 && a < 0) a = 0;
  const lam = a - r.pacc;
  if (lam === 0) return;
  r.pacc = a;
  for (let i = 0; i < r.n; i++) {
    const o = r.b[i].index * 6;
    const k = i * 6;
    for (let j = 0; j < 6; j++) pv[o + j] += r.MJ[k + j] * lam;
  }
}
