// Builds the solver for a resolved mechanism and keeps what a run reports
// about it: each joint's travel, speed and the torque or force it carried,
// tooth forces, screw thrust, contact with the floor, wheel slip, cam
// follower jump, clutch slip and how far the machine tipped.

import { Body, Solver, dot, qrot, sub, type M3, type V3 } from "./solver";
import { AxisFriction, AxisSpring, Ball, Pivot, Slider, Stops, Weld, type Joint } from "./joints";
import { Cam, Clutch, Profile, RatioLink, Thread, ToothMesh, gearPitch, type Loss } from "./couplings";
import { ActuatorDrive, AirCylinder, AxisForce, MotorDrive, ServoDrive, Solenoid, SpeedSource } from "./drives";
import { BodyLoad, PointSpring } from "./forces";
import { BodyContacts, PointContacts, TrackContact, WheelContact, boxQuery, type BoxShape, type Ground } from "./contact";
import { FRAME, type MechModel } from "./model";

/** what changes between the pessimistic, expected and optimistic runs */
export interface MechFactors {
  /** friction in joints, gear meshes, screws and seals */
  friction: number;
  /** grip of wheels, tracks and the floor */
  grip: number;
  /** loads and forces the scenario applies */
  load: number;
}

export const MECH_FACTORS: Record<"pessimistic" | "expected" | "optimistic", MechFactors> = {
  pessimistic: { friction: 1.3, grip: 0.8, load: 1.1 },
  expected: { friction: 1, grip: 1, load: 1 },
  optimistic: { friction: 0.7, grip: 1.15, load: 0.9 },
};

export interface JointStats {
  min: number;
  max: number;
  maxSpeed: number;
  peakLoad: number;
  travel: number;
  /** most force across the joint (what its bearing carries), N */
  peakReaction: number;
}

export class MechSystem {
  solver = new Solver();
  bodies = new Map<string, Body>();
  joints = new Map<string, Joint>();
  stats = new Map<string, JointStats>();
  stops = new Map<string, Stops>();
  motors = new Map<string, MotorDrive>();
  servos = new Map<string, { d: ServoDrive; zero: number }>();
  actuators = new Map<string, { d: ActuatorDrive; start: number }>();
  inputs: (SpeedSource | AxisForce | Solenoid | AirCylinder)[] = [];
  meshes: ToothMesh[] = [];
  threads: Thread[] = [];
  ratios: RatioLink[] = [];
  cams: Cam[] = [];
  clutches: Clutch[] = [];
  springs: PointSpring[] = [];
  contacts: PointContacts[] = [];
  wheels: WheelContact[] = [];
  tracks: TrackContact[] = [];
  loose: Body[] = [];
  frame: Body;
  ground: Ground | null;
  /** largest tilt of the frame from its start, rad */
  maxTilt = 0;

  constructor(
    public model: MechModel,
    public factors: MechFactors = MECH_FACTORS.expected,
  ) {
    const s = this.solver;
    s.gravity = model.gravity;
    const f = factors;
    for (const b of model.bodies) {
      const fixed = b.fixed || (b.id === FRAME && model.base === "fixed");
      this.bodies.set(b.id, s.addBody(new Body(b.id, b.mass, b.inertia, b.com, [1, 0, 0, 0], fixed)));
    }
    if (!this.bodies.has(FRAME)) this.bodies.set(FRAME, s.addBody(new Body(FRAME, 0, [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0], [1, 0, 0, 0], true)));
    this.frame = this.bodies.get(FRAME)!;
    const body = (id: string) => {
      const b = this.bodies.get(id);
      if (!b) throw new Error(`mechanism: no body "${id}"`);
      return b;
    };
    const joint = (name: string) => {
      const j = this.joints.get(name);
      if (!j) throw new Error(`mechanism: no joint "${name}"`);
      return j;
    };

    const g = model.ground;
    this.ground = g ? { planes: g.floor ? [g.floor] : [], blocks: g.blocks, mu: g.mu * f.grip, roll: g.roll } : null;

    for (const jd of model.joints) {
      const A = body(jd.on);
      const B = body(jd.body);
      const j = jd.kind === "pivot" ? new Pivot(jd.name, A, B, jd.at, jd.axis) : jd.kind === "slider" ? new Slider(jd.name, A, B, jd.at, jd.axis) : jd.kind === "ball" ? new Ball(jd.name, A, B, jd.at) : new Weld(jd.name, A, B, jd.at);
      s.add(j);
      this.joints.set(jd.name, j);
      this.stats.set(jd.name, { min: 0, max: 0, maxSpeed: 0, peakLoad: 0, travel: 0, peakReaction: 0 });
      if (jd.limits) this.stops.set(jd.name, s.add(new Stops(j, jd.limits[0], jd.limits[1], jd.kind === "pivot" ? 0.2 : 0.005)));
      if ((jd.friction ?? 0) > 0 || (jd.frictionPerLoad ?? 0) > 0) s.add(new AxisFriction(j, (jd.friction ?? 0) * f.friction, (jd.frictionPerLoad ?? 0) * f.friction));
      if ((jd.spring ?? 0) > 0 || (jd.damping ?? 0) > 0) s.add(new AxisSpring(j, jd.spring ?? 0, jd.damping ?? 0, jd.free ?? 0));
    }

    for (const d of model.drives) {
      const j = joint(d.joint);
      switch (d.kind) {
        case "motor":
          // filled in with the motor's constants when the plant is attached
          break;
        case "servo":
          break;
        case "actuator":
          break;
        case "turn":
          this.inputs.push(s.add(new SpeedSource(d.name, j, d.speed, d.limit)));
          break;
        case "force":
          this.inputs.push(s.add(new AxisForce(d.name, j, d.value.map(([t, v]) => [t, v * f.load]))));
          break;
        case "solenoid":
          this.inputs.push(s.add(new Solenoid(d.name, j, d.dir, d.force, d.stroke, d.on)));
          break;
        case "cylinder":
          this.inputs.push(s.add(new AirCylinder(d.name, j, d.sign, d.fOut, d.fIn, d.vmax, d.seal * f.friction, d.valve)));
          break;
      }
    }

    // a body that is nearly a point mass far from its joint makes the joint's rows badly conditioned: give it
    // at least the inertia of a lump 3 % of that distance across (well below what any real part has)
    const reach = new Map<Body, number>();
    const far = (b: Body, p: V3) => reach.set(b, Math.max(reach.get(b) ?? 0, Math.hypot(...sub(p, b.x))));
    for (const j of this.joints.values()) {
      far(j.A, j.anchorA());
      far(j.B, j.anchorB());
    }
    for (const [b, d] of reach) {
      if (b.fixed || b.mass <= 0) continue;
      const min = b.mass * (0.03 * d) ** 2;
      if (b.inertia[0] >= min && b.inertia[4] >= min && b.inertia[8] >= min) continue;
      const I = [...b.inertia] as M3;
      for (const i of [0, 4, 8]) I[i] = Math.max(I[i], min);
      b.setMass(b.mass, I);
    }

    const loss = (j: Joint, perImpulse: number): Loss | null => (perImpulse > 0 ? { joint: j, perImpulse } : null);
    for (const l of model.links) {
      switch (l.kind) {
        case "gears": {
          const ja = joint(l.a);
          // b is the frame for a gear fixed to it (a planet rolling round a still sun)
          const jb = l.b === FRAME ? null : joint(l.b);
          const B2 = jb ? jb.B : this.frame;
          const where = gearPitch(ja.B, l.ca, B2, l.cb, () => ja.axis(), l.ra);
          // the driven gear's pivot loses (1 - η) of the tooth force's moment
          const rb = Math.hypot(...sub(l.cb, l.ca)) - l.ra;
          this.meshes.push(s.add(new ToothMesh(l.name, ja.B, B2, where, l.backlash, jb ? loss(jb, (1 - l.efficiency) * f.friction * Math.max(rb, 0)) : loss(ja, (1 - l.efficiency) * f.friction * l.ra))));
          break;
        }
        case "rack": {
          const jp = joint(l.pinion);
          const jr = joint(l.rack);
          const lp = jp.A.toLocal(l.p);
          const ld = jr.A.dirToLocal(l.dir);
          const where = () => ({ p: jp.A.point(lp), t: jr.A.dir(ld) });
          this.meshes.push(s.add(new ToothMesh(l.name, jp.B, jr.B, where, l.backlash, loss(jr, (1 - l.efficiency) * f.friction))));
          break;
        }
        case "thread": {
          const js = joint(l.screw);
          const fb = body(l.follower);
          const lp = fb.toLocal(l.point);
          this.threads.push(s.add(new Thread(l.name, js, fb, () => fb.point(lp), l.k, l.backlash, l.frictionArm * f.friction)));
          break;
        }
        case "ratio":
          this.ratios.push(s.add(new RatioLink(l.name, joint(l.a), joint(l.b), l.ratio, l.slack, 1 - (1 - l.efficiency) * f.friction, l.stiffness)));
          break;
        case "cam":
          this.cams.push(s.add(new Cam(l.name, joint(l.cam), joint(l.follower), new Profile(Float64Array.from(l.lift)), l.phase, l.grooved)));
          break;
        case "clutch":
          this.clutches.push(s.add(new Clutch(l.name, l.a ? joint(l.a) : null, joint(l.b), l.torque, l.oneWay, l.engaged)));
          break;
      }
    }

    for (const sp of model.springs) this.springs.push(s.add(new PointSpring(sp.name, body(sp.a), body(sp.b), sp.pa, sp.pb, sp.k, sp.c, sp.free, sp.push)));
    for (const ld of model.loads) s.add(new BodyLoad(ld.name, body(ld.body), ld.at, ld.dir, ld.value.map(([t, v]) => [t, v * f.load]), ld.turns, ld.torque));

    // loose boxes: their own bodies, touching the floor, the blocks and the machine
    const looseBoxes: BoxShape[] = [];
    for (const lb of model.loose) {
      const [a, b, c] = lb.size;
      const m = lb.mass;
      const I: [number, number, number, number, number, number, number, number, number] = [(m * (b * b + c * c)) / 12, 0, 0, 0, (m * (a * a + c * c)) / 12, 0, 0, 0, (m * (a * a + b * b)) / 12];
      const B = s.addBody(new Body(lb.id, m, I, lb.at));
      this.bodies.set(lb.id, B);
      this.loose.push(B);
      looseBoxes.push({ body: B, c: [0, 0, 0], q: [1, 0, 0, 0], h: [a / 2, b / 2, c / 2] });
      if (this.ground) this.contacts.push(s.add(new PointContacts(B, boxPoints([0, 0, 0], [a / 2, b / 2, c / 2]), { ...this.ground, mu: this.ground.mu * (lb.grip / 0.5) }, 0.1)));
    }

    // the machine's bodies on the floor and blocks, and against loose boxes
    for (const bd of model.bodies) {
      const B = this.bodies.get(bd.id)!;
      if (B.fixed) {
        // loose boxes also rest on and slide against the frame's own parts (a base board, a tray, a stop),
        // not only the floor: each part's box, leaving out any a loose box starts inside (it is not a surface it meets)
        if (looseBoxes.length && bd.boxes.length) {
          const mu = 0.5 * f.grip;
          for (const lb of looseBoxes) {
            const p0 = lb.body.x;
            const mine: BoxShape[] = bd.boxes.filter((bx) => boxQuery(p0, bx.c, bx.h, bx.q).C > 0).map((bx) => ({ body: B, c: B.toLocal(bx.c), q: bx.q, h: bx.h }));
            if (mine.length) s.add(new BodyContacts(lb.body, boxPoints([0, 0, 0], lb.h), mine, mu));
          }
        }
        continue;
      }
      const pts = bd.points.map((p) => B.toLocal(p));
      if (this.ground && pts.length) this.contacts.push(s.add(new PointContacts(B, pts, this.ground)));
      if (looseBoxes.length && pts.length) {
        const mu = 0.5 * f.grip;
        s.add(new BodyContacts(B, pts, looseBoxes, mu));
        // the loose boxes' corners against this body's own part boxes
        const mine: BoxShape[] = bd.boxes.map((bx) => ({ body: B, c: B.toLocal(bx.c), q: bx.q, h: bx.h }));
        for (const lb of looseBoxes) s.add(new BodyContacts(lb.body, boxPoints([0, 0, 0], lb.h), mine, mu));
      }
    }
    if (looseBoxes.length > 1)
      for (let i = 0; i < looseBoxes.length; i++)
        for (let k = 0; k < looseBoxes.length; k++) if (i !== k) s.add(new BodyContacts(looseBoxes[i].body, boxPoints([0, 0, 0], looseBoxes[i].h), [looseBoxes[k]], 0.5 * f.grip));

    if (this.ground) {
      for (const w of model.wheels) this.wheels.push(s.add(new WheelContact(w.name, joint(w.joint).B, joint(w.joint), w.centre, w.axis, w.radius, this.ground, w.grip * f.grip)));
      for (const t of model.tracks) this.tracks.push(s.add(new TrackContact(t.name, body(t.frame), joint(t.joint), t.points, t.radius, this.ground, t.grip * f.grip)));
    }
  }

  addMotor(comp: string, d: MotorDrive) {
    this.motors.set(comp, this.solver.add(d));
  }
  addServo(comp: string, d: ServoDrive, zero: number) {
    this.servos.set(comp, { d: this.solver.add(d), zero });
  }
  addActuator(comp: string, d: ActuatorDrive, start: number) {
    this.actuators.set(comp, { d: this.solver.add(d), start });
  }

  step(dt: number) {
    this.solver.step(dt);
    for (const [name, j] of this.joints) {
      const st = this.stats.get(name)!;
      if (j.coord < st.min) st.min = j.coord;
      if (j.coord > st.max) st.max = j.coord;
      if (Math.abs(j.speed) > st.maxSpeed) st.maxSpeed = Math.abs(j.speed);
      if (Math.abs(j.axisLoad) > st.peakLoad) st.peakLoad = Math.abs(j.axisLoad);
      st.travel += Math.abs(j.speed) * dt;
      const rf = j.kind === "pivot" || j.kind === "slider" || j.kind === "ball" ? j.reaction(dt) : 0;
      if (rf > st.peakReaction) st.peakReaction = rf;
    }
    if (!this.frame.fixed) {
      const up = qrot(this.frame.turn(), [0, 0, 1]);
      const tilt = Math.acos(Math.max(-1, Math.min(1, dot(up, [0, 0, 1]))));
      if (tilt > this.maxTilt) this.maxTilt = tilt;
    }
  }

  /** where a design point on a body is now */
  where(body: string, p: V3): V3 {
    const b = this.bodies.get(body);
    return b ? b.carry(p) : p;
  }
}

/** a box's eight corners and twelve edge middles, for contact */
export function boxPoints(c: V3, h: V3): V3[] {
  const out: V3[] = [];
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1])
      for (const z of [-1, 0, 1]) {
        const zeros = (x === 0 ? 1 : 0) + (y === 0 ? 1 : 0) + (z === 0 ? 1 : 0);
        if (zeros <= 1) out.push([c[0] + x * h[0], c[1] + y * h[1], c[2] + z * h[2]]);
      }
  return out;
}
