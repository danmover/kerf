// Magnetic forces and tunnel air on a mechanism's bodies. FieldForces takes
// the design's wound coils, permanent magnets and field sensors (each riding
// the body it is mounted on) and, every physics step, puts on each magnet the
// force and torque the coils' currents give it, tells each coil the voltage a
// moving magnet and the other coils induce in it, and says what each field
// sensor reads. TunnelAir is a test section: the air speed where the fan's
// curve meets the circuit's losses, the model's drag (with solid blockage),
// buffeting and vortex shedding, the walls the model can touch, and the
// pressure the tunnel's gauge sees across its contraction.

import type { CoilLoad, PwmFan } from "../engine/fielddevs";
import { ramp } from "./couplings";
import { PointContacts } from "./contact";
import { CoilField, MagnetField, blockageFactor, tunnelSpeed, type Vec3 } from "./field";
import type { MechField, MechTunnel } from "./model";
import { cross, dot, qconj, qrot, sub, type Body, type V3 } from "./solver";
import type { MechFactors, MechSystem } from "./system";

const H = 1e-4;
const G = 9.80665;

interface CoilState {
  comp: string;
  body: Body;
  /** centre and axis in the body's frame, to follow it if it moves */
  lc: V3;
  la: V3;
  field: CoilField;
  amps: number;
  ripple: number;
  hz: number;
  /** A/s over the last step */
  slope: number;
  /** volts induced against its positive current */
  emf: number;
  seen: boolean;
}

interface MagnetState {
  comp: string;
  body: Body;
  lp: V3;
  la: V3;
  moment: number;
  own: MagnetField;
  /** the force the coils put on it now, N */
  force: V3;
  peak: number;
}

interface SensorState {
  comp: string;
  body: Body;
  lp: V3;
  laxes: [V3, V3, V3];
  /** each coil's field here per amp, when neither moves */
  fixed: (Vec3 | null)[];
}

export class FieldForces {
  coils: CoilState[] = [];
  magnets: MagnetState[] = [];
  sensors: SensorState[] = [];
  /** mutual inductance between coils, H */
  private mutual: number[][] = [];
  notes: string[] = [];
  private tmpB: Vec3 = [0, 0, 0];
  private tmpP: Vec3 = [0, 0, 0];
  private tmpQ: Vec3 = [0, 0, 0];

  constructor(
    sys: MechSystem,
    private spec: MechField,
  ) {
    const body = (id: string) => sys.bodies.get(id) ?? sys.frame;
    for (const c of spec.coils) {
      const b = body(c.body);
      this.coils.push({ comp: c.comp, body: b, lc: b.toLocal(c.c), la: b.dirToLocal(c.axis), field: new CoilField({ c: [...c.c], axis: [...c.axis], ri: c.ri, ro: c.ro, h: c.h, turns: c.turns }), amps: 0, ripple: 0, hz: 0, slope: 0, emf: 0, seen: false });
    }
    for (const m of spec.magnets) {
      const b = body(m.body);
      this.magnets.push({ comp: m.comp, body: b, lp: b.toLocal(m.at), la: b.dirToLocal(m.axis), moment: m.moment, own: new MagnetField(m.radius, m.length, m.moment), force: [0, 0, 0], peak: 0 });
    }
    for (const s of spec.sensors) {
      const b = body(s.body);
      this.sensors.push({ comp: s.comp, body: b, lp: b.toLocal(s.at), laxes: [b.dirToLocal(s.axes[0]), b.dirToLocal(s.axes[1]), b.dirToLocal(s.axes[2])], fixed: this.coils.map((c) => (b.fixed && c.body.fixed ? c.field.at(s.at) : null)) });
    }
    // coils link each other's flux: a few per cent of their own inductance for separate air coils
    this.mutual = this.coils.map(() => this.coils.map(() => 0));
    for (let i = 0; i < this.coils.length; i++)
      for (let j = i + 1; j < this.coils.length; j++) {
        const m = this.coils[i].field.linkage(this.coils[j].field);
        this.mutual[i][j] = this.mutual[j][i] = m;
      }
    this.describe(sys);
  }

  /** what each coil does to each floating magnet at the design pose, for the run's notes */
  private describe(sys: MechSystem) {
    const g = sys.solver.gravity;
    const gl = Math.hypot(g[0], g[1], g[2]) || G;
    const up: V3 = [-g[0] / gl, -g[1] / gl, -g[2] / gl];
    for (const m of this.magnets) {
      if (m.body.fixed) continue;
      const p = m.body.point(m.lp);
      const mv = scl(m.body.dir(m.la), m.moment);
      const lines: string[] = [];
      let best = 0;
      let bestName = "";
      for (const c of this.coils) {
        const { f } = this.perAmp(c, p, mv);
        const lift = dot(f, up);
        const side = Math.hypot(f[0] - lift * up[0], f[1] - lift * up[1], f[2] - lift * up[2]);
        if (Math.hypot(f[0], f[1], f[2]) < 1e-5) continue;
        lines.push(`${c.comp} ${(lift * 1000).toFixed(0)} mN up${side > 2e-4 ? ` and ${(side * 1000).toFixed(0)} mN sideways` : ""}`);
        if (lift > best) {
          best = lift;
          bestName = c.comp;
        }
      }
      if (!lines.length) continue;
      const weight = m.body.mass * gl;
      this.notes.push(
        `Force on ${m.comp} (${m.moment.toFixed(2)} A·m²) per amp at the design pose: ${lines.join(", ")}${best > 0 ? `. ${m.body.id} weighs ${(weight * 1000).toFixed(0)} mN, so ${bestName} holds it at about ${(weight / best).toFixed(2)} A` : ""}`,
      );
    }
    const pairs: string[] = [];
    for (let i = 0; i < this.coils.length; i++) for (let j = i + 1; j < this.coils.length; j++) if (Math.abs(this.mutual[i][j]) > 2e-5) pairs.push(`${this.coils[i].comp}/${this.coils[j].comp} ${(this.mutual[i][j] * 1000).toFixed(2)} mH`);
    if (pairs.length) this.notes.push(`Coils link each other's flux (mutual inductance): ${pairs.slice(0, 6).join(", ")}${pairs.length > 6 ? ` and ${pairs.length - 6} more pairs` : ""}`);
  }

  /** a coil's field at p and its force on a dipole there, both for 1 A */
  private perAmp(c: CoilState, p: V3, m: V3): { b: Vec3; f: V3 } {
    const b = c.field.at(p as Vec3, [0, 0, 0]);
    const f: V3 = [0, 0, 0];
    const q = this.tmpP;
    q[0] = p[0];
    q[1] = p[1];
    q[2] = p[2];
    for (let ax = 0; ax < 3; ax++) {
      q[ax] = p[ax] + H;
      const hi = dot(m, c.field.at(q, this.tmpB) as V3);
      q[ax] = p[ax] - H;
      const lo = dot(m, c.field.at(q, this.tmpQ) as V3);
      q[ax] = p[ax];
      f[ax] = (hi - lo) / (2 * H);
    }
    return { b, f };
  }

  /** this step's coil currents, from the plant's coil models */
  currents(io: readonly { comp: string; kind: string; dev: unknown }[], dt: number) {
    for (const c of this.coils) {
      const d = io.find((x) => x.kind === "coil" && x.comp === c.comp);
      if (!d) continue;
      const dev = d.dev as CoilLoad;
      c.slope = c.seen && dt > 0 ? (dev.current - c.amps) / dt : 0;
      c.seen = true;
      c.amps = dev.current;
      c.ripple = dev.ripple;
      c.hz = dev.pwmHz;
    }
  }

  /** before each physics step: the coils' forces and torques on the magnets, and the voltages induced in the coils */
  apply() {
    for (const c of this.coils) {
      if (!c.body.fixed) {
        const p = c.body.point(c.lc);
        const a = c.body.dir(c.la);
        c.field.shape.c = p as Vec3;
        c.field.shape.axis = a as Vec3;
      }
      c.emf = 0;
    }
    for (let i = 0; i < this.coils.length; i++) for (let j = 0; j < this.coils.length; j++) if (i !== j) this.coils[i].emf += this.mutual[i][j] * this.coils[j].slope;
    for (const m of this.magnets) {
      const B = m.body;
      const p = B.point(m.lp);
      const mv = scl(B.dir(m.la), m.moment);
      const v = B.velAt(p);
      const spin = cross(B.w, mv);
      const F: V3 = [0, 0, 0];
      const T: V3 = [0, 0, 0];
      for (const c of this.coils) {
        if (c.body === B) continue;
        const { b, f } = this.perAmp(c, p, mv);
        // the flux this magnet puts through the coil changes as it moves and turns
        c.emf += dot(f, v) + dot(spin, b as V3);
        if (!c.amps) continue;
        F[0] += c.amps * f[0];
        F[1] += c.amps * f[1];
        F[2] += c.amps * f[2];
        const t = cross(mv, b as V3);
        T[0] += c.amps * t[0];
        T[1] += c.amps * t[1];
        T[2] += c.amps * t[2];
        if (!c.body.fixed) c.body.applyForce([-c.amps * f[0], -c.amps * f[1], -c.amps * f[2]], p);
      }
      m.force = F;
      const mag = Math.hypot(F[0], F[1], F[2]);
      if (mag > m.peak) m.peak = mag;
      if (B.fixed) continue;
      B.applyForce(F, p);
      B.t = [B.t[0] + T[0], B.t[1] + T[1], B.t[2] + T[2]];
    }
  }

  emf(comp: string): number | undefined {
    return this.coils.find((c) => c.comp === comp)?.emf;
  }

  /** what a field sensor's chip sees now: the earth's field, every coil's and every magnet's, in the chip's own axes */
  reading(comp: string): { b: [number, number, number]; ripple: [number, number, number]; hz: number } | undefined {
    const s = this.sensors.find((x) => x.comp === comp);
    if (!s) return undefined;
    const p = s.body.point(s.lp) as Vec3;
    const B: V3 = [...this.spec.earth];
    const R: V3 = [0, 0, 0];
    let hz = 0;
    const axes = s.laxes.map((a) => s.body.dir(a));
    this.coils.forEach((c, k) => {
      if (!c.amps && !c.ripple) return;
      const b = s.fixed[k] ?? c.field.at(p, this.tmpB);
      B[0] += c.amps * b[0];
      B[1] += c.amps * b[1];
      B[2] += c.amps * b[2];
      if (c.ripple > 0) {
        for (let i = 0; i < 3; i++) R[i] += c.ripple * Math.abs(dot(b as V3, axes[i]));
        hz = hz ? Math.min(hz, c.hz) : c.hz;
      }
    });
    for (const m of this.magnets) {
      const b = m.own.at(m.body.point(m.lp) as Vec3, m.body.dir(m.la) as Vec3, p, this.tmpB);
      B[0] += b[0];
      B[1] += b[1];
      B[2] += b[2];
    }
    return { b: [dot(B, axes[0]), dot(B, axes[1]), dot(B, axes[2])], ripple: R, hz };
  }

  channels(out: Record<string, number>) {
    for (const m of this.magnets) {
      if (m.body.fixed) continue;
      out[`${m.comp}.fx`] = m.force[0];
      out[`${m.comp}.fy`] = m.force[1];
      out[`${m.comp}.fz`] = m.force[2];
      // how far its north pole leans from where it pointed in the design pose
      const n = m.body.dir(m.la);
      const n0 = qrot(qconj(m.body.turn()), n);
      out[`${m.comp}.tilt`] = (Math.acos(Math.max(-1, Math.min(1, dot(n, n0)))) * 180) / Math.PI;
    }
  }

  results(r: Record<string, number | boolean | string>) {
    for (const m of this.magnets) if (!m.body.fixed) r[`${m.comp}.peak_force`] = m.peak;
  }
}

const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/** a small seeded generator, so a run repeats exactly */
function rngFrom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class TunnelAir {
  /** air speed in the test section, m/s; its dynamic pressure, Pa; the drag on the model along the flow, N */
  speed = 0;
  q = 0;
  drag = 0;
  maxSpeed = 0;
  peakDrag = 0;
  /** seconds the model has spent clear of every wall, and how many times it came down onto one after floating */
  floatTime = 0;
  landings = 0;
  touching = 0;
  private clearFor = 0;
  private fan?: PwmFan;
  private body: Body;
  private walls: PointContacts;
  private across: V3;
  private rng: () => number;
  private gust: V3 = [0, 0, 0];
  private phase = [0, 0];
  private blockage: number;
  notes: string[] = [];

  constructor(
    sys: MechSystem,
    public spec: MechTunnel,
    private factors: MechFactors,
    seed: number,
  ) {
    this.body = sys.bodies.get(spec.body) ?? sys.frame;
    this.rng = rngFrom(seed);
    this.phase = [this.rng() * 6.283, this.rng() * 6.283];
    const { at, flow, up, width, height, length } = spec;
    const a = cross(up, flow);
    this.across = a;
    const plane = (n: V3, d: number) => ({ p: [at[0] - n[0] * d, at[1] - n[1] * d, at[2] - n[2] * d] as V3, n });
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
    const planes = [plane(up, height / 2), plane(neg(up), height / 2), plane(a, width / 2), plane(neg(a), width / 2), plane(flow, length / 2), plane(neg(flow), length / 2)];
    // a launch pad: a block standing on the floor under the section's centre (the box around it when the section is not square to the axes)
    const blocks: { min: V3; max: V3 }[] = [];
    if (spec.pad) {
      const min: V3 = [Infinity, Infinity, Infinity];
      const max: V3 = [-Infinity, -Infinity, -Infinity];
      for (const sf of [-0.5, 0.5])
        for (const sa of [-0.5, 0.5])
          for (const su of [-height / 2, -height / 2 + spec.pad.h])
            for (let i = 0; i < 3; i++) {
              const x = at[i] + spec.pad.w * (sf * flow[i] + sa * a[i]) + su * up[i];
              if (x < min[i]) min[i] = x;
              if (x > max[i]) max[i] = x;
            }
      blocks.push({ min, max });
    }
    this.walls = sys.solver.add(new PointContacts(this.body, spec.points.map((p) => this.body.toLocal(p)), { planes, blocks, mu: spec.mu * factors.grip, roll: 0 }, 0.2));
    this.blockage = blockageFactor(spec.area, width * height);
    const share = spec.area / (width * height);
    this.notes.push(
      `${spec.name}: test section ${(width * 1000).toFixed(0)} × ${(height * 1000).toFixed(0)} mm; the model fills ${(share * 100).toFixed(1)} % of it, which speeds the air past it by ${((this.blockage - 1) * 100).toFixed(1)} %${share > 0.1 ? " (over 10 %: the walls change its drag more than this correction covers)" : ""}; drag area ${(spec.cda * 1e6).toFixed(0)} mm², losses ${spec.loss} dynamic heads, air ${spec.rho.toFixed(2)} kg/m³`,
    );
  }

  attach(io: readonly { comp: string; kind: string; dev: unknown }[]) {
    if (!this.spec.fan) return;
    const x = io.find((i) => i.comp === this.spec.fan && i.kind === "blower");
    if (!x) {
      this.notes.push(`${this.spec.name}: ${this.spec.fan} is not a wired four-wire fan, so no air moves`);
      return;
    }
    this.fan = x.dev as PwmFan;
    const top = tunnelSpeed(this.fan, 1, this.spec.width * this.spec.height, this.spec.loss, this.spec.rho);
    this.notes.push(`${this.spec.name}: ${this.spec.fan} at full speed gives about ${top.toFixed(1)} m/s in the test section (where its ${(this.fan.flowMax * 3600).toFixed(0)} m³/h, ${this.fan.pressureMax.toFixed(0)} Pa curve meets the circuit's losses)`);
  }

  /** before each physics step: the air's forces on the model */
  apply(dt: number, t: number) {
    const s = this.spec;
    const area = s.width * s.height;
    const want = this.fan ? tunnelSpeed(this.fan, this.fan.speed, area, s.loss, s.rho) : s.speed ? Math.max(0, ramp(s.speed, t)) : 0;
    // the air in the duct takes a moment to follow the fan
    this.speed += (want - this.speed) * (1 - Math.exp(-dt / 0.06));
    if (this.speed < 1e-3) this.speed = 0;
    if (this.speed > this.maxSpeed) this.maxSpeed = this.speed;
    const V = this.speed * this.blockage;
    this.q = 0.5 * s.rho * this.speed * this.speed;
    const B = this.body;
    this.touching = this.walls.touching;
    if (this.touching === 0) {
      this.floatTime += dt;
      this.clearFor += dt;
    } else {
      // a landing is coming down after really floating, not a rock on the pad as it lifts off
      if (this.clearFor > 0.25) this.landings++;
      this.clearFor = 0;
    }
    if (B.fixed) return;
    // drag on the air's speed past the model, so the model's own motion is damped by it
    const u: V3 = [V * s.flow[0] - B.v[0], V * s.flow[1] - B.v[1], V * s.flow[2] - B.v[2]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    const k = 0.5 * s.rho * ul * s.cda * this.factors.load;
    const F: V3 = [k * u[0], k * u[1], k * u[2]];
    const qb = 0.5 * s.rho * V * V;
    // steady lift and side force
    for (let i = 0; i < 3; i++) F[i] += qb * (s.cla * s.up[i] + s.cya * this.across[i]);
    if (V > 0.05) {
      // buffeting: the stream's turbulence, as noise up to the rate eddies the model's size pass at
      const fc = V / (6 * Math.max(1e-3, s.d));
      const a = Math.exp(-dt * 2 * Math.PI * fc);
      const sd = 2 * s.turbulence * qb * s.cda * Math.sqrt(1 - a * a);
      for (let i = 0; i < 3; i++) this.gust[i] = a * this.gust[i] + sd * (this.rng() + this.rng() + this.rng() - 1.5) * 2 * (i === 0 ? 1 : 0.7);
      // vortex shedding: an unsteady force across the flow at the Strouhal frequency, its phase wandering
      const w = (2 * Math.PI * s.strouhal * V) / Math.max(1e-3, s.d);
      this.phase[0] += w * dt * (1 + 0.1 * (this.rng() - 0.5));
      this.phase[1] += w * dt * (1 + 0.1 * (this.rng() - 0.5));
      const amp = Math.SQRT2 * s.shed * qb * s.area;
      const sa = amp * Math.sin(this.phase[0]) + this.gust[1];
      const su = amp * 0.7 * Math.sin(this.phase[1]) + this.gust[2];
      for (let i = 0; i < 3; i++) F[i] += this.gust[0] * s.flow[i] + sa * this.across[i] + su * s.up[i];
      // spinning in a stream is damped a little by it
      const c = (s.rho * V * s.area * s.d * s.d) / 16;
      B.t = [B.t[0] - c * B.w[0], B.t[1] - c * B.w[1], B.t[2] - c * B.w[2]];
    }
    this.drag = dot(F, s.flow);
    if (Math.abs(this.drag) > this.peakDrag) this.peakDrag = Math.abs(this.drag);
    B.f = [B.f[0] + F[0], B.f[1] + F[1], B.f[2] + F[2]];
  }

  /** what the gauge across the contraction reads, Pa: the test section's dynamic pressure less the inlet's share */
  pressure(comp: string): number | undefined {
    if (comp !== this.spec.gauge) return undefined;
    const cr = Math.max(1.01, this.spec.contraction);
    return this.q * (1 - 1 / (cr * cr));
  }

  channels(out: Record<string, number>) {
    const n = this.spec.name;
    out[`${n}.speed`] = this.speed;
    out[`${n}.q`] = this.q;
    out[`${n}.drag`] = this.drag;
    out[`${n}.touching`] = this.touching;
    // where the model is in the test section, mm from its centre along the flow, across and up
    const r = sub(this.body.x, this.spec.at);
    out[`${n}.x`] = dot(r, this.spec.flow) * 1000;
    out[`${n}.y`] = dot(r, this.across) * 1000;
    out[`${n}.z`] = dot(r, this.spec.up) * 1000;
  }

  results(r: Record<string, number | boolean | string>) {
    const n = this.spec.name;
    r[`${n}.speed`] = this.speed;
    r[`${n}.max_speed`] = this.maxSpeed;
    r[`${n}.q`] = this.q;
    r[`${n}.drag`] = this.drag;
    r[`${n}.peak_drag`] = this.peakDrag;
    r[`${n}.reynolds`] = (this.speed * this.spec.d) / 1.5e-5;
    r[`${n}.float_time`] = this.floatTime;
    r[`${n}.landings`] = this.landings;
    r[`${n}.floating`] = this.touching === 0;
    const d = sub(this.body.x, this.spec.at);
    r[`${n}.x`] = dot(d, this.spec.flow) * 1000;
    r[`${n}.y`] = dot(d, this.across) * 1000;
    r[`${n}.z`] = dot(d, this.spec.up) * 1000;
  }
}
