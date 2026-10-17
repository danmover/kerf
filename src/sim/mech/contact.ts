// Contact with the world and between loose objects: points of a body (the
// corners of its shape) against the floor and fixed blocks, wheels rolling on
// the floor, tracks driven by their sprockets, and boxes the machine can push,
// carry or grip. Each contact is a one-sided row along the normal with two
// friction rows (Coulomb, a pyramid) whose limit follows the normal force.

import { Body, Row, cross, dot, norm, perp, scale, sub, add, qrot, qconj, type Constraint, type Quat, type Solver, type V3 } from "./solver";
import type { Joint } from "./joints";

export interface Plane {
  p: V3;
  n: V3;
}

/** a fixed block, axis-aligned in the world */
export interface Block {
  min: V3;
  max: V3;
}

export interface Ground {
  planes: Plane[];
  blocks: Block[];
  /** friction coefficient of the floor and blocks */
  mu: number;
  /** rolling resistance coefficient of the floor */
  roll: number;
}

/** how far off a surface a contact starts to be watched, m */
const MARGIN = 0.004;

class Slot {
  n = new Row();
  t1 = new Row();
  t2 = new Row();
  used = 0;
}

/** distance from p to a box (centre c, half sizes h, rotation q from its frame), and the normal out of it */
export function boxQuery(p: V3, c: V3, h: V3, q: Quat | null): { C: number; n: V3 } {
  const l = q ? qrot(qconj(q), sub(p, c)) : sub(p, c);
  const cl: V3 = [Math.max(-h[0], Math.min(h[0], l[0])), Math.max(-h[1], Math.min(h[1], l[1])), Math.max(-h[2], Math.min(h[2], l[2]))];
  const d = sub(l, cl);
  const dist = Math.hypot(d[0], d[1], d[2]);
  let nl: V3;
  let C: number;
  if (dist > 1e-12) {
    nl = scale(d, 1 / dist);
    C = dist;
  } else {
    // inside: out through the nearest face
    let k = 0;
    let pen = Infinity;
    for (let i = 0; i < 3; i++) {
      const pi = h[i] - Math.abs(l[i]);
      if (pi < pen) {
        pen = pi;
        k = i;
      }
    }
    nl = [0, 0, 0];
    nl[k] = l[k] < 0 ? -1 : 1;
    C = -pen;
  }
  return { C, n: q ? qrot(q, nl) : nl };
}

function contactRows(slot: Slot, A: Body, B: Body | null, p: V3, n: V3, C: number, mu: number, restitution: number, s: Solver, dt: number, emit: (r: Row) => void) {
  const r = slot.n.reset().pointTerm(A, p, n, 1);
  if (B) r.pointTerm(B, p, n, -1);
  r.oneSided(C, s.beta, s.slop, dt, restitution);
  emit(r);
  const [t1, t2] = perp(n);
  for (const [row, t] of [
    [slot.t1, t1],
    [slot.t2, t2],
  ] as const) {
    row.reset().pointTerm(A, p, t, 1);
    if (B) row.pointTerm(B, p, t, -1);
    emit(row.friction(0, r, mu));
  }
  slot.used = s.t;
}

/** A body's points against the floor and the fixed blocks. */
export class PointContacts implements Constraint {
  private slots = new Map<number, Slot>();
  /** total normal force this step, N, and how many points touch */
  normal = 0;
  touching = 0;
  constructor(
    public body: Body,
    /** points in the body's frame */
    public points: V3[],
    public ground: Ground,
    public restitution = 0,
  ) {}
  private slot(k: number): Slot {
    let s = this.slots.get(k);
    if (!s) this.slots.set(k, (s = new Slot()));
    return s;
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const g = this.ground;
    const nShapes = g.planes.length + g.blocks.length;
    this.points.forEach((lp, i) => {
      const p = this.body.point(lp);
      g.planes.forEach((pl, j) => {
        const C = dot(sub(p, pl.p), pl.n);
        if (C < MARGIN) contactRows(this.slot(i * nShapes + j), this.body, null, p, pl.n, C, g.mu, this.restitution, s, dt, emit);
      });
      g.blocks.forEach((b, j) => {
        const c = scale(add(b.min, b.max), 0.5);
        const h = scale(sub(b.max, b.min), 0.5);
        const q = boxQuery(p, c, h, null);
        if (q.C < MARGIN) contactRows(this.slot(i * nShapes + g.planes.length + j), this.body, null, p, q.n, q.C, g.mu, this.restitution, s, dt, emit);
      });
    });
  }
  after(_s: Solver, dt: number) {
    let n = 0;
    let k = 0;
    for (const sl of this.slots.values())
      if (sl.n.wasActive && sl.n.acc > 0) {
        n += sl.n.acc;
        k++;
      }
    this.normal = n / dt;
    this.touching = k;
  }
}

/** A box-shaped body (centre, half sizes, rotation in its frame) that other bodies' points can press on. */
export interface BoxShape {
  body: Body;
  /** centre and rotation in the body's frame */
  c: V3;
  q: Quat;
  h: V3;
}

/** One body's points against another body's boxes (a gripper's fingers on a loose box, a box on a tray). */
export class BodyContacts implements Constraint {
  private slots = new Map<number, Slot>();
  normal = 0;
  constructor(
    public body: Body,
    public points: V3[],
    public boxes: BoxShape[],
    public mu: number,
  ) {}
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    this.points.forEach((lp, i) => {
      const p = this.body.point(lp);
      this.boxes.forEach((b, j) => {
        const c = b.body.point(b.c);
        const q = boxQuery(p, c, b.h, qmulq(b.body.q, b.q));
        if (q.C >= MARGIN) return;
        const k = i * this.boxes.length + j;
        let sl = this.slots.get(k);
        if (!sl) this.slots.set(k, (sl = new Slot()));
        contactRows(sl, this.body, b.body, p, q.n, q.C, this.mu, 0, s, dt, emit);
      });
    });
  }
  after(_s: Solver, dt: number) {
    let n = 0;
    for (const sl of this.slots.values()) if (sl.n.wasActive) n += Math.max(0, sl.n.acc);
    this.normal = n / dt;
  }
}

function qmulq(a: Quat, b: Quat): Quat {
  return [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2], a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
}

/**
 * A wheel on a pivot rolling on the floor: one contact at the bottom of its rim, grip along and across its
 * tread, and rolling resistance against its turning.
 */
export class WheelContact implements Constraint {
  private slots: Slot[];
  private rr: Row[];
  private lc: V3;
  private la: V3;
  normal = 0;
  /** speed of the tread over the floor at the contact, m/s, and the wheel's speed over the floor */
  slipSpeed = 0;
  speed = 0;
  slipTime = 0;
  constructor(
    public name: string,
    public wheel: Body,
    public joint: Joint,
    centre: V3,
    axis: V3,
    public radius: number,
    public ground: Ground,
    public grip: number,
  ) {
    this.lc = wheel.toLocal(centre);
    this.la = wheel.dirToLocal(axis);
    this.slots = ground.planes.map(() => new Slot());
    this.rr = ground.planes.map(() => new Row());
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const c = this.wheel.point(this.lc);
    const a = this.wheel.dir(this.la);
    this.ground.planes.forEach((pl, j) => {
      const d0 = sub(pl.n, scale(a, dot(pl.n, a)));
      if (Math.hypot(...d0) < 1e-6) return;
      const d = norm(d0);
      const P = sub(c, scale(d, this.radius));
      const C = dot(sub(P, pl.p), pl.n);
      if (C >= MARGIN) return;
      const sl = this.slots[j];
      const n = pl.n;
      const r = sl.n.reset().pointTerm(this.wheel, P, n, 1).oneSided(C, s.beta, s.slop, dt);
      emit(r);
      const t1 = norm(cross(a, n));
      const t2 = cross(n, t1);
      emit(sl.t1.reset().pointTerm(this.wheel, P, t1, 1).friction(0, r, this.grip));
      emit(sl.t2.reset().pointTerm(this.wheel, P, t2, 1).friction(0, r, this.grip));
      if (this.ground.roll > 0) emit(this.joint.axisTerms(this.rr[j].reset(), 1).friction(0, r, this.ground.roll * this.radius));
    });
  }
  after(_s: Solver, dt: number) {
    let n = 0;
    for (const sl of this.slots) if (sl.n.wasActive) n += Math.max(0, sl.n.acc);
    this.normal = n / dt;
    const c = this.wheel.point(this.lc);
    const pl = this.ground.planes[0];
    if (!pl) return;
    const a = this.wheel.dir(this.la);
    const d = norm(sub(pl.n, scale(a, dot(pl.n, a))));
    const P = sub(c, scale(d, this.radius));
    const vc = this.wheel.v;
    const vp = this.wheel.velAt(P);
    this.speed = Math.hypot(...sub(vc, scale(pl.n, dot(vc, pl.n))));
    this.slipSpeed = Math.hypot(...sub(vp, scale(pl.n, dot(vp, pl.n))));
    if (this.normal > 0 && this.slipSpeed > 0.01 + 0.1 * this.speed) this.slipTime += dt;
  }
}

/**
 * A track: its bottom run touches the floor at points along the frame it runs on and moves backwards at the
 * sprocket's pitch speed, so the sprocket's turning pushes the machine along.
 */
export class TrackContact implements Constraint {
  private slots: Slot[] = [];
  private lp: V3[];
  normal = 0;
  constructor(
    public name: string,
    public frame: Body,
    public sprocket: Joint,
    /** points along the bottom run, world, at the start */
    points: V3[],
    public radius: number,
    public ground: Ground,
    public grip: number,
  ) {
    this.lp = points.map((p) => frame.toLocal(p));
    this.slots = points.flatMap(() => ground.planes.map(() => new Slot()));
  }
  build(s: Solver, dt: number, emit: (r: Row) => void) {
    const a = this.sprocket.axis();
    this.lp.forEach((lp, i) => {
      const p = this.frame.point(lp);
      this.ground.planes.forEach((pl, j) => {
        const C = dot(sub(p, pl.p), pl.n);
        if (C >= MARGIN) return;
        const sl = this.slots[i * this.ground.planes.length + j];
        const r = sl.n.reset().pointTerm(this.frame, p, pl.n, 1).oneSided(C, s.beta, s.slop, dt);
        emit(r);
        const t1 = norm(cross(a, pl.n));
        // the run under the sprocket moves at -radius × its speed along t1
        const along = sl.t1.reset().pointTerm(this.frame, p, t1, 1);
        this.sprocket.axisTerms(along, -this.radius);
        emit(along.friction(0, r, this.grip));
        emit(sl.t2.reset().pointTerm(this.frame, p, a, 1).friction(0, r, this.grip));
      });
    });
  }
  after(_s: Solver, dt: number) {
    let n = 0;
    for (const sl of this.slots) if (sl.n.wasActive) n += Math.max(0, sl.n.acc);
    this.normal = n / dt;
  }
}
