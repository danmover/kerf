// A mechanism world: the design's moving parts as rigid bodies with their
// real masses, joined by joints and linked by gears, screws, chains, cams and
// clutches, driven by the design's own motors, servos and actuators (so the
// firmware drives them) or by inputs the scenario gives, with gravity, springs,
// friction, the floor and loose objects. It wraps the world around the machine
// (the bench, for sensors and the motors outside the mechanism) and records
// each joint's motion and loads.

import type { Actuator, DCMotor, EscFan, Servo } from "../engine/devices";
import { JetForces } from "../mech/forces";
import { FieldForces, TunnelAir } from "../mech/magnetics";
import { ActuatorDrive, MotorDrive, ServoDrive } from "../mech/drives";
import { FRAME, type MechModel } from "../mech/model";
import { qconj, qrot, sub, type Body, type V3 } from "../mech/solver";
import { MECH_FACTORS, MechSystem } from "../mech/system";
import { D2R, R2D, type VariantName } from "./common";
import { FREE_LOAD, type DriveIO, type DriveMotion, type MotorLoad, type Orientation, type PlantView, type SceneBody, type SceneSpec, type World, type WorldEvent } from "./types";

const RPM = 60 / (2 * Math.PI);
const mm = (v: V3): [number, number, number] => [v[0] * 1000, v[1] * 1000, v[2] * 1000];

interface Attached {
  kind: "motor" | "servo" | "actuator";
  drive: MotorDrive | ServoDrive | ActuatorDrive;
  sign: number;
  /** servo angle (deg) or actuator stroke (mm) at the design pose */
  zero: number;
}

export class MechWorld implements World {
  kind = "mechanism";
  sys: MechSystem;
  events: WorldEvent[] = [];
  assumptions: string[] = [];
  limits = [
    "Parts are rigid: they do not bend or stretch (the stress, vibration and fit analyses cover that).",
    "Parts touch only where the mechanism says: joints, gear teeth, threads, cams, wheels and tracks on the floor, the machine's corners on the floor and blocks, and loose boxes. Other parts pass through each other.",
    "Gears, racks, screws and chains are modelled at their pitch line (ratio, backlash and friction losses), not tooth by tooth.",
    "Friction is one Coulomb coefficient per contact, joint friction ×1.3 / ×0.7 and grip ×0.8 / ×1.15 in the pessimistic and optimistic runs.",
  ];
  /** physics steps per plant step */
  substeps = 1;
  private attached = false;
  private devs = new Map<string, Attached>();
  private prevV = new Map<string, V3>();
  private accel = new Map<string, V3>();
  private stopSeen = new Map<string, string | null>();
  private stopCount = new Map<string, number>();
  private flagged = new Set<string>();
  private start = new Map<string, V3>();
  /** the highest each moving body's centre got, m */
  private topZ = new Map<string, number>();
  private peakPower = new Map<string, number>();
  jets: JetForces[] = [];
  /** the design's coils, magnets and field sensors, and its wind tunnel test sections */
  magnetics?: FieldForces;
  tunnels: TunnelAir[] = [];
  unstable = false;

  constructor(
    public model: MechModel,
    public variant: VariantName,
    /** the world around the machine (the bench), or null on an open floor */
    public inner: World | null,
    private ambient = 20,
    private label = "mechanism",
  ) {
    this.sys = new MechSystem(model, MECH_FACTORS[variant]);
    for (const [id, b] of this.sys.bodies) this.start.set(id, [...b.x]);
    this.assumptions.push(...model.notes);
    if (model.field && (model.field.coils.length || model.field.magnets.length)) {
      this.magnetics = new FieldForces(this.sys, model.field);
      this.assumptions.push(...this.magnetics.notes);
      this.limits.push(
        "Magnets: a point dipole at each magnet's centre for the force and torque a coil's field puts on it (good from about two magnet lengths away), and a stack of current loops for the field it makes at a sensor. Coils are air-core, from the Biot-Savart law. Magnets do not pull on each other or on steel, and nothing is modelled of iron, eddy currents or the coils' own heat reaching the magnet.",
      );
    }
    const seeds: Record<VariantName, number> = { pessimistic: 1109, expected: 2311, optimistic: 3701 };
    for (const tn of model.tunnels ?? []) {
      const air = new TunnelAir(this.sys, tn, MECH_FACTORS[variant], seeds[variant] + this.tunnels.length * 97);
      this.tunnels.push(air);
      this.assumptions.push(...air.notes.splice(0));
    }
    if (this.tunnels.length)
      this.limits.push(
        "Tunnel air: one speed across the test section, where the fan's curve meets the circuit's losses. The model's drag is its drag area times the dynamic pressure, with the solid-blockage correction, plus buffeting and vortex shedding from typical numbers; the air puts no torque on it but a little damping. The airflow analysis shows the flow's shape.",
      );
    const coupled = new Set(model.drives.flatMap((d) => ("comp" in d ? [d.comp] : [])));
    if (inner) {
      // the inner world's word on a motor the mechanism now drives no longer holds
      const own = (inner as { assumptions?: string[] }).assumptions ?? [];
      this.assumptions.push(...own.filter((a) => ![...coupled].some((c) => a.startsWith(`${c}:`))));
      this.limits.push(...inner.limits.filter((l) => !/stands still/.test(l)));
    }
  }

  init(plant: PlantView) {
    this.inner?.init?.(plant);
  }

  // ---------- the devices the mechanism moves ----------

  private attach(io: DriveIO[]) {
    this.attached = true;
    const f = MECH_FACTORS[this.variant];
    for (const d of this.model.drives) {
      if (d.kind !== "motor" && d.kind !== "servo" && d.kind !== "actuator") continue;
      const x = io.find((i) => i.comp === d.comp && i.kind === d.kind);
      const j = this.sys.joints.get(d.joint);
      if (!x || !j) {
        this.assumptions.push(`${d.comp} is not wired as a ${d.kind}, so it does not drive ${d.joint}`);
        continue;
      }
      if (d.kind === "motor") {
        const m = x.dev as DCMotor;
        const md = new MotorDrive(d.comp, j, d.sign, m.kt, m.ke, () => m.resistance, m.tf * f.friction);
        // the rotor and gearbox, seen at the output shaft
        addAxisInertia(j.B, j.aB, m.j);
        this.sys.addMotor(d.comp, md);
        this.devs.set(d.comp, { kind: "motor", drive: md, sign: d.sign, zero: 0 });
      } else if (d.kind === "servo") {
        const s = x.dev as Servo;
        const sd = new ServoDrive(d.comp, j, d.sign, s.tStall, s.speed * D2R);
        this.sys.addServo(d.comp, sd, d.zero);
        this.devs.set(d.comp, { kind: "servo", drive: sd, sign: d.sign, zero: d.zero });
      } else {
        const a = x.dev as Actuator;
        const ad = new ActuatorDrive(d.comp, j, d.sign, a.vr, a.vFree / 1000, a.fStall, a.fBack, a.dead);
        this.sys.addActuator(d.comp, ad, d.start);
        this.devs.set(d.comp, { kind: "actuator", drive: ad, sign: d.sign, zero: d.start });
      }
    }
    for (const jt of this.model.jets ?? []) {
      const x = io.find((i) => i.comp === jt.fan && i.kind === "fan");
      const body = this.sys.bodies.get(jt.body);
      if (!x || !body) {
        this.assumptions.push(`${jt.fan} has no ESC spinning it from the firmware, so ${jt.name} blows nothing`);
        continue;
      }
      const fan = x.dev as EscFan;
      const vanes = jt.vanes.flatMap((v) => {
        const vb = this.sys.bodies.get(v.body);
        if (!vb) return [];
        return [{ name: v.joint, body: vb, lp: vb.toLocal(v.cp), la: vb.dirToLocal(v.axis), lc: vb.dirToLocal([-jt.axis[0], -jt.axis[1], -jt.axis[2]]), area: v.area, cla: v.cla, ar: v.ar, angle: 0, lift: 0, stalled: false }];
      });
      const state = () => ({ thrust: fan.thrust, omega: fan.omega, alpha: fan.alpha, drag: fan.dragTorque, J: fan.J, spin: fan.spin, area: fan.fanArea });
      this.jets.push(this.sys.solver.add(new JetForces(jt.name, body, jt.at, jt.axis, vanes, jt.stall, jt.recovery, state)));
    }
    for (const tn of this.tunnels) {
      tn.attach(io);
      this.assumptions.push(...tn.notes.splice(0));
    }
  }

  couple(io: DriveIO[], dt: number, t: number): Map<string, DriveMotion> {
    if (!this.attached) this.attach(io);
    for (const d of io) {
      const a = this.devs.get(d.comp);
      if (!a) continue;
      if (a.kind === "motor") {
        const md = a.drive as MotorDrive;
        md.v = d.v;
        md.ilim = d.ilim;
      } else if (a.kind === "servo") {
        const sd = a.drive as ServoDrive;
        const want = (d.dev as Servo).wanted(d.us);
        sd.goal = want === null ? null : a.sign * (want - a.zero) * D2R;
        sd.powered = d.powered;
        // a smart servo's torque limit is set over its bus
        const lim = (d.dev as { limit?: () => number }).limit?.();
        if (lim !== undefined) sd.stall = lim;
      } else (a.drive as ActuatorDrive).v = d.v;
    }
    this.magnetics?.currents(io, dt);
    if (!this.unstable) {
      const h = dt / this.substeps;
      for (let i = 0; i < this.substeps; i++) {
        this.magnetics?.apply();
        for (const tn of this.tunnels) tn.apply(h, t + i * h);
        this.sys.step(h);
      }
      this.checkStable(t + dt);
      for (const [id, b] of this.sys.bodies) if (!b.fixed && b.x[2] > (this.topZ.get(id) ?? -Infinity)) this.topZ.set(id, b.x[2]);
    }
    const out = new Map<string, DriveMotion>();
    for (const [comp, a] of this.devs) {
      const j = a.drive.joint;
      const load = a.sign * a.drive.load;
      if (a.kind === "motor") out.set(comp, { speed: a.sign * j.speed, pos: 0, load });
      else if (a.kind === "actuator") out.set(comp, { speed: a.sign * j.speed * 1000, pos: a.zero + a.sign * j.coord * 1000, load });
      else out.set(comp, { speed: a.sign * j.speed * R2D, pos: a.zero + a.sign * j.coord * R2D, load });
    }
    return out;
  }

  /** a run that blows up says so and stops moving, instead of drawing nonsense */
  private checkStable(t: number) {
    for (const b of this.sys.bodies.values()) {
      const v = Math.hypot(...b.v) + Math.hypot(...b.w) * 0.1;
      if (Number.isFinite(v) && v < 500 && Number.isFinite(b.x[0])) continue;
      this.unstable = true;
      this.events.push({ t, kind: "warn", text: `The mechanism simulation went unstable at ${b.id} and was stopped: check the joints for parts fighting each other (two joints on one axis, a gear pair that cannot both turn)` });
      for (const x of this.sys.bodies.values()) {
        x.v = [0, 0, 0];
        x.w = [0, 0, 0];
      }
      return;
    }
  }

  // ---------- the world interface ----------

  motorLoad(comp: string): MotorLoad {
    return this.inner?.motorLoad(comp) ?? FREE_LOAD;
  }

  actuatorLoad(comp: string): number {
    return this.inner?.actuatorLoad(comp) ?? 0;
  }

  servoLoad(comp: string): number {
    return this.inner?.servoLoad?.(comp) ?? 0;
  }

  drives() {
    return this.inner?.drives?.() ?? [];
  }

  supply() {
    return this.inner?.supply?.();
  }

  thermal() {
    return this.inner?.thermal() ?? { ambient: this.ambient, cooling: 1 };
  }

  range(comp: string): number {
    return this.inner?.range?.(comp) ?? 2000;
  }

  /** a magnet riding any body is within a hall sensor's range, both where their bodies have moved them */
  magnet(comp: string): boolean {
    const m = this.model.magnets;
    if (!m) return this.inner?.magnet?.(comp) ?? false;
    for (const s of m.sensors) {
      if (s.comp !== comp) continue;
      const ps = this.placed(comp, s.at);
      for (const g of m.magnets) if (Math.hypot(...sub(this.placed(g.comp, g.at), ps)) <= s.range) return true;
    }
    return false;
  }

  /** what a field sensor's chip sees: the coils' and magnets' fields where the bodies have moved them */
  field(comp: string) {
    return this.magnetics?.reading(comp) ?? this.inner?.field?.(comp);
  }

  /** volts induced in a coil by magnets moving near it and by the other coils */
  coilEmf(comp: string): number {
    return this.magnetics?.emf(comp) ?? this.inner?.coilEmf?.(comp) ?? 0;
  }

  /** the pressure a tunnel's gauge sees across its contraction, Pa */
  pressure(comp: string): number {
    for (const tn of this.tunnels) {
      const p = tn.pressure(comp);
      if (p !== undefined) return p;
    }
    return this.inner?.pressure?.(comp) ?? 0;
  }

  /** the pull on a load cell that is a spring link of the mechanism, N */
  force(comp: string): number {
    const sp = this.sys.springs.find((x) => this.model.springs.find((m) => m.name === x.name)?.cell === comp);
    return sp ? -sp.force : (this.inner?.force?.(comp) ?? 0);
  }

  /** a design-pose point on the body a component rides, where that body is now */
  private placed(comp: string, at: V3): V3 {
    const b = this.sys.bodies.get(this.model.mounts[comp] ?? FRAME) ?? this.sys.frame;
    const x0 = this.start.get(b.id) ?? b.x;
    const r = qrot(b.turn(), sub(at, x0));
    return [b.x[0] + r[0], b.x[1] + r[1], b.x[2] + r[2]];
  }

  step(dt: number, t: number, plant: PlantView): void {
    this.inner?.step(dt, t, plant);
    this.watch(dt, t + dt);
  }

  /** what happened this step that is worth an event, and what the IMUs feel */
  private watch(dt: number, t: number) {
    const s = this.sys;
    for (const [id, b] of s.bodies) {
      if (b.fixed) continue;
      const pv = this.prevV.get(id);
      if (pv) this.accel.set(id, [(b.v[0] - pv[0]) / dt, (b.v[1] - pv[1]) / dt, (b.v[2] - pv[2]) / dt]);
      this.prevV.set(id, [...b.v]);
    }
    for (const [name, st] of s.stops) {
      const was = this.stopSeen.get(name) ?? null;
      if (st.pressing && st.pressing !== was) {
        const n = (this.stopCount.get(name) ?? 0) + 1;
        this.stopCount.set(name, n);
        if (n <= 3) this.events.push({ t, kind: "contact", text: `${name} reached its ${st.pressing} stop${n === 3 ? " (and keeps reaching it)" : ""}` });
      }
      this.stopSeen.set(name, st.pressing);
    }
    for (const c of s.cams)
      if (c.gap > 2e-4) this.once(`cam:${c.name}`, t, "warn", `The follower left ${c.name}: its spring cannot pull it back onto the cam at this speed (follower jump)`);
    for (const c of s.clutches) if (c.slipping) this.once(`clutch:${c.name}`, t, "info", `${c.name} started slipping (${Math.abs(c.torque * 1000).toFixed(0)} N·mm)`);
    for (const w of s.wheels) if (w.slipTime > 0.2) this.once(`wheel:${w.name}`, t, "warn", `${w.name} is spinning on the floor: not enough grip for that torque`);
    if (s.maxTilt > 30 * D2R) this.once("tip", t, "warn", `The machine tipped over (${(s.maxTilt * R2D).toFixed(0)}°)`);
    for (const b of s.loose) {
      const z0 = this.start.get(b.id)![2];
      if (b.x[2] < z0 - 0.1) this.once(`drop:${b.id}`, t, "warn", `${b.id} fell`);
    }
    for (const inp of s.inputs) {
      const p = Math.abs(inp.power);
      if (p > (this.peakPower.get(inp.name) ?? 0)) this.peakPower.set(inp.name, p);
    }
  }

  private once(key: string, t: number, kind: WorldEvent["kind"], text: string) {
    if (this.flagged.has(key)) return;
    this.flagged.add(key);
    this.events.push({ t, kind, text });
  }

  orientation(comp: string): Orientation {
    const id = this.model.mounts[comp] ?? FRAME;
    const b = this.sys.bodies.get(id) ?? this.sys.frame;
    const q = b.turn();
    const [w, x, y, z] = q;
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    const pitch = -Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
    const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    // rates and acceleration in the body's own (design) axes
    const wb = qrot(qconj(q), b.w);
    const a = qrot(qconj(q), this.accel.get(b.id) ?? [0, 0, 0]);
    return { yaw: yaw * R2D, pitch: pitch * R2D, roll: roll * R2D, rate: [wb[0] * R2D, -wb[1] * R2D, wb[2] * R2D], accel: a };
  }

  channels(): Record<string, number> {
    const out: Record<string, number> = {};
    const s = this.sys;
    for (const [id, b] of s.bodies) {
      if (b.fixed) continue;
      const q = b.turn();
      out[`${id}.px`] = b.x[0] * 1000;
      out[`${id}.py`] = b.x[1] * 1000;
      out[`${id}.pz`] = b.x[2] * 1000;
      out[`${id}.qw`] = q[0];
      out[`${id}.qx`] = q[1];
      out[`${id}.qy`] = q[2];
      out[`${id}.qz`] = q[3];
    }
    for (const [name, j] of s.joints) {
      if (j.kind === "pivot") {
        out[`${name}.angle`] = j.coord * R2D;
        out[`${name}.rpm`] = j.speed * RPM;
        out[`${name}.torque`] = j.axisLoad;
      } else if (j.kind === "slider") {
        out[`${name}.pos`] = j.coord * 1000;
        out[`${name}.speed`] = j.speed * 1000;
        out[`${name}.force`] = j.axisLoad;
      }
    }
    for (const m of s.meshes) out[`${m.name}.force`] = m.force;
    for (const th of s.threads) out[`${th.name}.thrust`] = th.thrust;
    for (const r of s.ratios) out[`${r.name}.torque`] = r.load;
    for (const sp of s.springs) {
      out[`${sp.name}.force`] = sp.force;
      out[`${sp.name}.length`] = sp.length * 1000;
    }
    for (const c of s.cams) {
      out[`${c.name}.force`] = c.force;
      out[`${c.name}.gap`] = Math.max(0, c.gap) * 1000;
    }
    for (const c of s.clutches) out[`${c.name}.torque`] = c.torque;
    for (const jt of this.jets) {
      out[`${jt.name}.side_force`] = jt.side;
      out[`${jt.name}.thrust`] = jt.thrust;
      for (const v of jt.vanes) {
        out[`${v.name}.lift`] = v.lift;
        out[`${v.name}.attack`] = v.angle * R2D;
      }
    }
    for (const w of s.wheels) out[`${w.name}.slip_speed`] = w.slipSpeed * 1000;
    this.magnetics?.channels(out);
    for (const tn of this.tunnels) tn.channels(out);
    for (const inp of s.inputs) {
      const lin = inp.joint.kind === "slider";
      out[`${inp.name}.${lin ? "force" : "torque"}`] = inp.load;
      out[`${inp.name}.power`] = inp.power;
    }
    if (!s.frame.fixed) out["frame.tilt"] = s.maxTilt * R2D;
    if (this.inner) Object.assign(out, this.inner.channels());
    return out;
  }

  finished(t: number): boolean {
    return this.inner?.finished(t) ?? false;
  }

  results(): Record<string, number | boolean | string> {
    const r: Record<string, number | boolean | string> = { ...(this.inner?.results() ?? {}) };
    const s = this.sys;
    for (const [name, j] of s.joints) {
      const st = s.stats.get(name)!;
      const stop = s.stops.get(name);
      if (stop) r[`${name}.hit_stop`] = (this.stopCount.get(name) ?? 0) > 0;
      r[`${name}.bearing_load`] = st.peakReaction;
      if (j.kind === "pivot") {
        r[`${name}.angle`] = j.coord * R2D;
        r[`${name}.angle_min`] = st.min * R2D;
        r[`${name}.angle_max`] = st.max * R2D;
        r[`${name}.turns`] = j.coord / (2 * Math.PI);
        r[`${name}.max_rpm`] = st.maxSpeed * RPM;
        r[`${name}.peak_torque`] = st.peakLoad * 1000;
        r[`${name}.hold_torque`] = st.holdLoad * 1000;
      } else if (j.kind === "slider") {
        r[`${name}.pos`] = j.coord * 1000;
        r[`${name}.pos_min`] = st.min * 1000;
        r[`${name}.pos_max`] = st.max * 1000;
        r[`${name}.travel`] = st.travel * 1000;
        r[`${name}.max_speed`] = st.maxSpeed * 1000;
        r[`${name}.peak_force`] = st.peakLoad;
      }
    }
    for (const m of s.meshes) r[`${m.name}.peak_force`] = m.peak;
    for (const th of s.threads) r[`${th.name}.peak_thrust`] = th.peak;
    for (const x of s.ratios) r[`${x.name}.peak_torque`] = x.peak * 1000;
    for (const sp of s.springs) {
      r[`${sp.name}.peak_force`] = sp.peak;
      r[`${sp.name}.min_length`] = sp.minLength * 1000;
      r[`${sp.name}.max_length`] = sp.maxLength * 1000;
    }
    for (const c of s.cams) {
      r[`${c.name}.jump`] = c.maxGap * 1000;
      r[`${c.name}.lifted_time`] = c.liftedFor;
      r[`${c.name}.peak_force`] = c.peak;
    }
    for (const c of s.clutches) r[`${c.name}.slip_time`] = c.slipTime;
    for (const jt of this.jets) {
      r[`${jt.name}.peak_vane_force`] = jt.peakVane;
      r[`${jt.name}.stall_time`] = jt.stallTime;
      r[`${jt.name}.peak_gyro`] = jt.peakGyro * 1000;
    }
    for (const w of s.wheels) r[`${w.name}.slip_time`] = w.slipTime;
    this.magnetics?.results(r);
    for (const tn of this.tunnels) tn.results(r);
    for (const inp of s.inputs) {
      const lin = inp.joint.kind === "slider";
      if (lin) r[`${inp.name}.peak_force`] = inp.peak;
      else r[`${inp.name}.peak_torque`] = inp.peak * 1000;
      r[`${inp.name}.peak_power`] = this.peakPower.get(inp.name) ?? 0;
    }
    for (const [id, b] of s.bodies) {
      if (b.fixed) continue;
      const x0 = this.start.get(id)!;
      r[`${id}.x`] = b.x[0] * 1000;
      r[`${id}.y`] = b.x[1] * 1000;
      r[`${id}.z`] = b.x[2] * 1000;
      r[`${id}.moved`] = Math.hypot(...sub(b.x, x0)) * 1000;
      r[`${id}.z_max`] = Math.max(b.x[2], this.topZ.get(id) ?? b.x[2]) * 1000;
    }
    if (!s.frame.fixed) {
      const x0 = this.start.get(FRAME)!;
      r.tilt_max = s.maxTilt * R2D;
      r.tipped = s.maxTilt > 30 * D2R;
      r.distance = Math.hypot(s.frame.x[0] - x0[0], s.frame.x[1] - x0[1]) * 1000;
      r.climbed = (s.frame.x[2] - x0[2]) * 1000;
    }
    r.unstable = this.unstable;
    return r;
  }

  scene(): SceneSpec {
    const inner = this.inner?.scene();
    const bodies: SceneBody[] = this.model.bodies.map((b) => ({ id: b.id, xmin: -Infinity, xmax: Infinity, origin: mm(b.com), spin: [], parts: b.parts }));
    for (const l of this.model.loose) bodies.push({ id: l.id, xmin: -Infinity, xmax: Infinity, origin: mm(l.at), spin: [], parts: [], box: mm(l.size) });
    const g = this.model.ground;
    const notes = [...(inner?.notes ?? []).filter((n) => !/nothing moves/.test(n))];
    notes.push(`${this.model.bodies.filter((b) => !b.fixed && b.id !== FRAME).length} moving bodies, ${this.model.joints.length} joints${this.model.links.length ? `, ${this.model.links.length} links` : ""}`);
    return {
      kind: this.label,
      floor: inner?.floor,
      ground: g?.floor ? { p: mm(g.floor.p), n: g.floor.n, blocks: g.blocks.map((b) => ({ min: mm(b.min), max: mm(b.max) })), label: g.label, down: g.down } : undefined,
      bodies,
      off: this.model.off,
      follow: this.model.follow,
      notes,
    };
  }
}

/** adds a spinning mass's inertia about an axis (in the body's frame) to a body */
export function addAxisInertia(b: Body, a: V3, J: number) {
  if (b.fixed || !(J > 0)) return;
  const I = [...b.inertia] as typeof b.inertia;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) I[i * 3 + k] += J * a[i] * a[k];
  b.setMass(b.mass, I);
}
