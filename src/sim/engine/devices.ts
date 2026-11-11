// Models of the parts the plant is built from, each from its catalog specs:
// battery (open-circuit curve, internal resistance, polarisation), buck
// regulator, DC gearmotor with encoder and heating, linear actuator with its
// potentiometer, hobby servo, the I2C IMUs, a PCA9685 servo board and an
// NAU7802 load cell ADC. Where a datasheet number is missing the model says
// what it assumed.

import type { CatalogPart } from "../../machine/types";
import type { I2CDevice } from "./hal";
import type { Orientation } from "../worlds/types";

const num = (p: CatalogPart, key: string, fallback: number): number => {
  const v = p.specs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

// ---------- battery ----------

/** LiPo cell open-circuit voltage against state of charge (rested cell, typical). */
const LIPO_OCV: [number, number][] = [
  [0, 3.27],
  [0.05, 3.5],
  [0.1, 3.6],
  [0.2, 3.7],
  [0.3, 3.75],
  [0.4, 3.79],
  [0.5, 3.83],
  [0.6, 3.87],
  [0.7, 3.92],
  [0.8, 3.98],
  [0.9, 4.06],
  [1, 4.2],
];
const LIFE_OCV: [number, number][] = [
  [0, 2.8],
  [0.05, 3.1],
  [0.1, 3.2],
  [0.3, 3.27],
  [0.7, 3.3],
  [0.95, 3.35],
  [1, 3.6],
];

function interp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

export class Battery {
  cells: number;
  capAh: number;
  soc: number;
  /** pack internal resistance, ohms */
  r0: number;
  r1: number;
  tau = 30;
  vpol = 0;
  current = 0;
  ah = 0;
  ocvTable: [number, number][];
  iCont: number;
  assumed: string[] = [];
  minV = Infinity;
  constructor(
    public name: string,
    part: CatalogPart,
    soc = 1,
  ) {
    this.cells = num(part, "cells", 3);
    this.capAh = num(part, "capacity_mah", 2200) / 1000;
    this.soc = soc;
    const chem = String(part.specs.chemistry ?? "LiPo");
    this.ocvTable = /LiFe/i.test(chem) ? LIFE_OCV : LIPO_OCV;
    const c = num(part, "c_rating", 20);
    this.iCont = num(part, "i_cont", c * this.capAh);
    const rCell = typeof part.specs.r_int_mohm === "number" ? (part.specs.r_int_mohm as number) / 1000 : 0.6 / (c * this.capAh);
    if (typeof part.specs.r_int_mohm !== "number") this.assumed.push(`${name}: internal resistance ${(rCell * 1000).toFixed(1)} mΩ a cell, from its ${c}C rating`);
    this.r0 = rCell * this.cells;
    this.r1 = this.r0 * 0.5;
  }
  ocv() {
    return this.cells * interp(this.ocvTable, this.soc);
  }
  /** terminal volts at a current */
  volts(i = this.current) {
    return Math.max(0, this.ocv() - i * this.r0 - this.vpol);
  }
  step(i: number, dt: number) {
    this.current = i;
    this.soc = Math.max(0, this.soc - (i * dt) / (3600 * this.capAh));
    this.ah += (i * dt) / 3600;
    this.vpol += (dt * (i * this.r1 - this.vpol)) / this.tau;
    const v = this.volts();
    if (v < this.minV) this.minV = v;
  }
  /** lowest safe resting voltage for the pack */
  get vEmpty() {
    return this.cells * this.ocvTable[1][1];
  }
}

// ---------- regulator ----------

export class Regulator {
  vout: number;
  eff: number;
  vinMin: number;
  imax: number;
  load = 0;
  constructor(
    public name: string,
    part: CatalogPart,
  ) {
    this.vout = num(part, "v_out", 5);
    this.eff = num(part, "efficiency", 0.85);
    this.vinMin = num(part, "v_in_min", this.vout + 1);
    this.imax = num(part, "i_out", 2);
  }
  /** output volts for an input voltage: drops out below its minimum input */
  out(vin: number) {
    if (vin < this.vinMin - 0.5) return Math.max(0, vin - 1.2);
    return this.vout;
  }
  inputCurrent(vin: number) {
    if (vin <= 0.5) return 0;
    return (this.out(vin) * this.load) / (this.eff * vin);
  }
}

// ---------- mains supply, plug-in adapter, USB or bench supply ----------

/**
 * What a supply does past its rating. "cutout": a switch-mode adapter or
 * enclosed supply (and a USB port's polyfuse) switches off once the current
 * stays over its trip point, then comes back on by itself. "limit": a bench
 * supply holds the current at its limit by letting the voltage fall.
 */
export interface SupplyBehaviour {
  mode: "cutout" | "limit";
  /** trips above this many times the rating */
  trip: number;
  /** after this long over the trip point (longer when only just over), s */
  after: number;
  /** stays off this long before it tries again, s */
  off: number;
}

/** Mean Well and plug-in adapter datasheets: overload protection at 105 to 150 % of the rating, hiccup mode. */
export const ADAPTER: SupplyBehaviour = { mode: "cutout", trip: 1.3, after: 0.05, off: 1 };
/** a USB port behind the board's 500 mA polyfuse: it trips at about twice that and takes seconds to reset */
export const USB_PORT: SupplyBehaviour = { mode: "cutout", trip: 2, after: 0.5, off: 5 };
export const BENCH_SUPPLY: SupplyBehaviour = { mode: "limit", trip: 1, after: 0, off: 0 };

/** A regulated supply: its set voltage, less a little across its output resistance, up to its current rating. */
export class Supply {
  current = 0;
  peak = 0;
  minV = Infinity;
  /** times it cut out */
  trips = 0;
  /** the bench supply is holding its current limit */
  limiting = false;
  private saidLimit = false;
  private offFor = 0;
  private over = 0;
  /** share of the set voltage a current-limited supply holds */
  private fold = 1;
  constructor(
    public name: string,
    /** set voltage */
    public v: number,
    /** rating or current limit, A */
    public imax: number,
    /** output resistance, Ω */
    public r: number,
    public how: SupplyBehaviour,
  ) {}
  get off() {
    return this.offFor > 0;
  }
  volts(i = this.current) {
    if (this.offFor > 0) return 0;
    return Math.max(0, this.fold * this.v - i * this.r);
  }
  /** Draw `i` amps for `dt` seconds. Returns what to tell the user when it cuts out or starts limiting. */
  step(i: number, dt: number): string | undefined {
    let said: string | undefined;
    if (this.offFor > 0) {
      this.current = 0;
      this.offFor -= dt;
      if (this.offFor <= 0) this.offFor = this.over = 0;
    } else {
      this.current = i;
      if (i > this.peak) this.peak = i;
      if (this.how.mode === "limit") {
        if (i > this.imax) {
          // most loads draw less as the voltage falls: close in on the limit without overshooting it
          this.fold = Math.max(0, this.fold * (0.5 + (0.5 * this.imax) / i));
          if (!this.saidLimit) said = `${this.name} hit its ${fmt(this.imax)} A current limit: the voltage falls to hold it`;
          this.limiting = this.saidLimit = true;
        } else if (this.fold < 1) this.fold = Math.min(1, this.fold + dt * 5);
        else this.limiting = false;
      } else {
        const trip = this.imax * this.how.trip;
        this.over = i > trip ? this.over + dt * (i / trip) ** 2 : Math.max(0, this.over - dt);
        if (this.over > this.how.after) {
          this.trips++;
          this.offFor = this.how.off;
          this.current = 0;
          // a supply that keeps cutting out says so a few times, not every second of the run
          if (this.trips <= 3) said = `${this.name} cut out: ${fmt(i)} A is past its ${fmt(this.imax)} A rating (it tries again after ${fmt(this.how.off)} s)`;
          else if (this.trips === 4) said = `${this.name} keeps cutting out: still past its ${fmt(this.imax)} A rating`;
        }
      }
    }
    const v = this.volts();
    if (v < this.minV) this.minV = v;
    return said;
  }
}

const fmt = (x: number) => String(Number(x.toPrecision(3)));

// ---------- DC gearmotor ----------

export class DCMotor {
  vr: number;
  r20: number;
  ke: number;
  kt: number;
  tf: number;
  j: number;
  cpr: number;
  omega = 0;
  angle = 0;
  current = 0;
  torque = 0;
  volts = 0;
  temp: number;
  maxTemp: number;
  cth: number;
  rth: number;
  energy = 0;
  peakCurrent = 0;
  stalledFor = 0;
  /** its heating is a guess from its mass: the catalog has no thermal data for it */
  heatGuess = false;
  /** counts the encoder has crossed (quadrature), as a float */
  counts = 0;
  assumed: string[] = [];
  constructor(
    public name: string,
    public part: CatalogPart,
    ambient: number,
  ) {
    this.vr = num(part, "v_rated", 12);
    const is = num(part, "i_stall", 5);
    const i0 = num(part, "i_free", 0.2);
    const w0 = (num(part, "rpm_free", 100) * 2 * Math.PI) / 60;
    const ts = num(part, "t_stall", 1000) / 1000;
    this.r20 = this.vr / is;
    this.ke = (this.vr - i0 * this.r20) / w0;
    this.kt = ts / Math.max(0.01, is - i0);
    this.tf = this.kt * i0;
    // a 20 ms mechanical time constant, typical of small gearmotors
    this.j = (0.02 * this.ke * this.kt) / this.r20;
    this.cpr = num(part, "encoder_cpr", 0);
    const mass = num(part, "mass_g", 300);
    if (typeof part.specs.rth_k_per_w === "number" && typeof part.specs.tau_th_s === "number") {
      this.rth = part.specs.rth_k_per_w;
      this.cth = part.specs.tau_th_s / this.rth;
    } else {
      // one thermal node for the whole motor, scaled from its mass: the winding runs hotter than this
      this.cth = mass * 0.45;
      this.rth = 12 * Math.sqrt(524 / mass);
      this.heatGuess = true;
      this.assumed.push(`${name}: heating from a mass-based guess (${this.rth.toFixed(0)} K/W to the air, ${((this.cth * this.rth) / 60).toFixed(0)} min time constant); the winding heats faster than the can`);
    }
    this.temp = ambient;
    this.maxTemp = ambient;
  }
  get resistance() {
    return this.r20 * (1 + 0.0039 * (this.temp - 20));
  }
  /**
   * One step with an average terminal voltage (or null when the driver leaves
   * the terminals open), a current limit and the load's torques.
   */
  step(v: number | null, ilim: number, load: { coulomb: number; viscous: number; external: number; inertia: number }, dt: number, ambient: number, cooling: number) {
    const R = this.resistance;
    const J = this.j + load.inertia;
    const fr = this.tf + load.coulomb;
    let drive: number;
    let damp: number;
    if (v === null) {
      drive = load.external;
      damp = load.viscous;
    } else {
      // the driver limits current by chopping: above the limit the motor sees less voltage
      const iNow = (v - this.ke * this.omega) / R;
      const vEff = Math.abs(iNow) > ilim ? this.ke * this.omega + Math.sign(iNow) * ilim * R : v;
      drive = (this.kt * vEff) / R + load.external;
      damp = (this.kt * this.ke) / R + load.viscous;
      v = vEff;
    }
    const w = this.omega;
    let wn: number;
    if (w !== 0) {
      wn = (J * w + dt * (drive - Math.sign(w) * fr)) / (J + dt * damp);
      if (Math.sign(wn) !== Math.sign(w)) wn = 0;
    } else if (Math.abs(drive) <= fr) wn = 0;
    else wn = (dt * (drive - Math.sign(drive) * fr)) / (J + dt * damp);
    this.omega = wn;
    this.angle += wn * dt;
    this.volts = v ?? this.ke * wn;
    this.current = v === null ? 0 : (v - this.ke * wn) / R;
    this.torque = this.kt * this.current - Math.sign(wn) * this.tf;
    const p = this.current * this.current * R;
    this.energy += Math.abs(this.volts * this.current) * dt;
    this.temp += (dt * (p - ((this.temp - ambient) * cooling) / this.rth)) / this.cth;
    if (this.temp > this.maxTemp) this.maxTemp = this.temp;
    const ia = Math.abs(this.current);
    if (ia > this.peakCurrent) this.peakCurrent = ia;
    this.stalledFor = Math.abs(wn) < 0.01 && ia > 0.5 * (this.vr / R) * 0.3 ? this.stalledFor + dt : 0;
  }
  /**
   * Take the output shaft's speed from a mechanism the world simulates (it already turned the shaft against the
   * motor's torque, its own inertia and the loads), and work out the current, heating and wear from it.
   */
  follow(v: number | null, ilim: number, omega: number, dt: number, ambient: number, cooling: number) {
    const R = this.resistance;
    if (v !== null) {
      const iNow = (v - this.ke * omega) / R;
      if (Math.abs(iNow) > ilim) v = this.ke * omega + Math.sign(iNow) * ilim * R;
    }
    this.omega = omega;
    this.angle += omega * dt;
    this.volts = v ?? this.ke * omega;
    this.current = v === null ? 0 : (v - this.ke * omega) / R;
    this.torque = this.kt * this.current - Math.sign(omega) * this.tf;
    const p = this.current * this.current * R;
    this.energy += Math.abs(this.volts * this.current) * dt;
    this.temp += (dt * (p - ((this.temp - ambient) * cooling) / this.rth)) / this.cth;
    if (this.temp > this.maxTemp) this.maxTemp = this.temp;
    const ia = Math.abs(this.current);
    if (ia > this.peakCurrent) this.peakCurrent = ia;
    this.stalledFor = Math.abs(omega) < 0.01 && ia > 0.5 * (this.vr / R) * 0.3 ? this.stalledFor + dt : 0;
  }
  /** encoder counts per output radian */
  get countsPerRad() {
    return this.cpr / (2 * Math.PI);
  }
}

/** Quadrature levels for a count: A leads B going forward. */
export function quadrature(count: number): [number, number] {
  const q = ((count % 4) + 4) % 4;
  return [q === 1 || q === 2 ? 1 : 0, q === 2 || q === 3 ? 1 : 0];
}

// ---------- linear actuator ----------

export class Actuator {
  stroke: number;
  vFree: number;
  fStall: number;
  fBack: number;
  iFree: number;
  iStall: number;
  vr: number;
  pos: number;
  speed = 0;
  current = 0;
  force = 0;
  dead = 0.25;
  stalledFor = 0;
  travel = 0;
  constructor(
    public name: string,
    part: CatalogPart,
    start: number,
  ) {
    this.stroke = num(part, "stroke", 50);
    this.vFree = num(part, "speed_free_mm_s", 5);
    const vLoad = num(part, "speed_mm_s", this.vFree / 2);
    const fMax = num(part, "f_max", 100);
    // the speed falls linearly with load: it still makes speed_mm_s at f_max
    this.fStall = vLoad < this.vFree ? fMax / (1 - vLoad / this.vFree) : 2 * fMax;
    this.fBack = num(part, "f_backdrive", fMax * 1.5);
    this.iFree = num(part, "i_free", 0.05);
    this.iStall = num(part, "i_stall", 1);
    this.vr = num(part, "v_rated", 12);
    this.pos = Math.max(0, Math.min(this.stroke, start));
  }
  /** v: average terminal volts (+ extends), null when unpowered; fExt: N pushing the rod in */
  step(v: number | null, fExt: number, dt: number) {
    this.force = fExt;
    const u = v === null ? 0 : Math.min(1.2, Math.abs(v) / this.vr);
    const s = v === null || v === 0 ? 0 : Math.sign(v);
    let speed = 0;
    if (s !== 0 && u > this.dead) {
      const against = fExt * s;
      const fs = this.fStall * u;
      const frac = (u - this.dead) / (1 - this.dead);
      speed = against >= fs ? 0 : s * this.vFree * frac * Math.min(1.3, 1 - against / fs);
      this.current = this.iFree + (this.iStall * u - this.iFree) * Math.max(0, Math.min(1, against / fs));
      if (speed === 0) this.current = this.iStall * u;
    } else {
      this.current = s !== 0 ? this.iStall * u : 0;
      // a lead screw only creeps back under a large push
      if (Math.abs(fExt) > this.fBack) speed = -Math.sign(fExt) * 0.2;
    }
    let p = this.pos + speed * dt;
    if (p <= 0 || p >= this.stroke) {
      p = Math.max(0, Math.min(this.stroke, p));
      if (s !== 0) this.current = this.iStall * u;
      speed = 0;
    }
    this.travel += Math.abs(p - this.pos);
    this.speed = speed;
    this.pos = p;
    this.stalledFor = s !== 0 && speed === 0 ? this.stalledFor + dt : 0;
  }
  /** take the rod's motion from a mechanism the world simulates: pos mm, speed mm/s, force N pushing the rod in */
  follow(v: number | null, pos: number, speed: number, force: number, dt: number) {
    const u = v === null ? 0 : Math.min(1.2, Math.abs(v) / this.vr);
    const s = v === null || v === 0 ? 0 : Math.sign(v);
    this.force = force;
    if (s !== 0 && u > this.dead) {
      const fs = this.fStall * u;
      const share = Math.max(0, Math.min(1, (force * s) / fs));
      this.current = Math.abs(speed) < 0.01 ? this.iStall * u : this.iFree + (this.iStall * u - this.iFree) * share;
    } else this.current = s !== 0 ? this.iStall * u : 0;
    this.travel += Math.abs(pos - this.pos);
    this.pos = pos;
    this.speed = speed;
    this.stalledFor = s !== 0 && Math.abs(speed) < 0.01 ? this.stalledFor + dt : 0;
  }
}

// ---------- hobby servo ----------

export class Servo {
  angle: number;
  target: number;
  speed: number;
  tStall: number;
  iRun: number;
  iStall: number;
  range: number;
  current = 0;
  constructor(
    public name: string,
    part: CatalogPart,
  ) {
    this.range = num(part, "range_deg", 180);
    this.speed = 60 / num(part, "speed_s_per_60", 0.2);
    this.tStall = num(part, "t_stall", 1000) / 1000;
    this.iRun = num(part, "i_run", 0.3);
    this.iStall = num(part, "i_stall", 1.5);
    this.angle = this.range / 2;
    this.target = this.angle;
  }
  /** us: pulse width, or null for no signal (the servo goes limp) */
  step(us: number | null, load: number, powered: boolean, dt: number) {
    if (us === null || !powered) {
      this.current = powered ? 0.01 : 0;
      return;
    }
    this.target = Math.max(0, Math.min(this.range, ((us - 500) / 2000) * this.range));
    const e = this.target - this.angle;
    if (Math.abs(e) < 0.5) {
      this.current = 0.02 + (Math.abs(load) / this.tStall) * this.iStall;
      return;
    }
    const against = load * Math.sign(e);
    const frac = Math.max(0, 1 - against / this.tStall);
    const step = Math.min(Math.abs(e), this.speed * frac * dt);
    this.angle += Math.sign(e) * step;
    this.current = frac > 0 ? this.iRun + (this.iStall - this.iRun) * (1 - frac) : this.iStall;
  }
  /** the angle (deg) a pulse asks for, or null without one */
  wanted(us: number | null): number | null {
    return us === null ? null : Math.max(0, Math.min(this.range, ((us - 500) / 2000) * this.range));
  }
  /** take the horn's angle from a mechanism the world simulates, with the torque it gave (N·m) */
  follow(us: number | null, angle: number, torque: number, powered: boolean) {
    this.angle = angle;
    const want = this.wanted(us);
    if (want === null || !powered) {
      this.current = powered ? 0.01 : 0;
      return;
    }
    this.target = want;
    const share = Math.min(1, Math.abs(torque) / this.tStall);
    this.current = Math.abs(want - angle) < 0.5 ? 0.02 + share * this.iStall : this.iRun + (this.iStall - this.iRun) * share;
  }
}

// ---------- IMUs ----------

export interface ImuNoise {
  /** heading drift, degrees per minute (gyro bias left after fusion) */
  driftPerMin: number;
  /** reading noise, degrees */
  noise: number;
}

/** Bosch BNO055: the registers a sketch uses, with fusion output from the world's orientation. */
export class Bno055 implements I2CDevice {
  regs = new Uint8Array(128);
  ptr = 0;
  /** frozen (a sim.stuck() fault): the registers stop updating */
  hold = false;
  mode = 0;
  fusionSince = 0;
  bootAt: number;
  driftRate: number;
  private headingOffset = 0;
  constructor(
    public name: string,
    private fcpu: number,
    private orient: () => Orientation,
    private noise: ImuNoise,
    private rng: () => number,
  ) {
    // boots 650 ms after power-up
    this.bootAt = 0.65 * fcpu;
    this.regs[0x00] = 0xa0;
    this.regs[0x01] = 0xfb;
    this.regs[0x02] = 0x32;
    this.regs[0x03] = 0x0f;
    this.regs[0x36] = 0x0f;
    this.regs[0x41] = 0x24;
    this.driftRate = (rng() < 0.5 ? -1 : 1) * noise.driftPerMin * (0.5 + rng());
  }
  ready(t: number) {
    return t >= this.bootAt;
  }
  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.ptr = bytes[0] & 0x7f;
    for (let i = 1; i < bytes.length; i++) {
      const r = this.ptr;
      this.regs[r] = bytes[i];
      if (r === 0x3d) {
        this.mode = bytes[i] & 0x0f;
        if (this.mode !== 0) {
          this.fusionSince = t;
          this.headingOffset = this.orient().yaw;
        }
      }
      if (r === 0x3f && bytes[i] & 0x20) {
        // reset: back in config mode after the boot time
        this.mode = 0;
        this.bootAt = t + 0.65 * this.fcpu;
      }
      this.ptr = (this.ptr + 1) & 0x7f;
    }
  }
  read(n: number, t: number): number[] {
    this.update(t);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.regs[this.ptr]);
      this.ptr = (this.ptr + 1) & 0x7f;
    }
    return out;
  }
  private put16(reg: number, v: number) {
    const x = Math.round(v) & 0xffff;
    this.regs[reg] = x & 0xff;
    this.regs[reg + 1] = x >> 8;
  }
  private update(t: number) {
    if (this.hold) return;
    const o = this.orient();
    const n = () => (this.rng() + this.rng() + this.rng() - 1.5) * this.noise.noise;
    const fusing = this.mode >= 0x08 && t - this.fusionSince > 0.02 * this.fcpu;
    this.regs[0x39] = fusing ? 5 : this.mode ? 3 : 0;
    this.regs[0x35] = fusing ? 0x3c : 0;
    const scale = this.regs[0x3b] & 0x04 ? 900 / (180 / Math.PI) : 16;
    if (!fusing) {
      for (let r = 0x1a; r < 0x20; r++) this.regs[r] = 0;
      return;
    }
    const minutes = (t - this.fusionSince) / this.fcpu / 60;
    // compass heading: clockwise from where fusion started (IMU mode has no north)
    let heading = -(o.yaw - this.headingOffset) + (this.mode === 0x08 ? this.driftRate * minutes : 0) + n();
    heading = ((heading % 360) + 360) % 360;
    this.put16(0x1a, heading * scale);
    const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
    this.put16(0x1c, wrap(o.roll + n()) * scale);
    this.put16(0x1e, wrap(o.pitch + n()) * scale);
    // gyro, degrees per second at 16 LSB
    this.put16(0x14, o.rate[0] * 16);
    this.put16(0x16, o.rate[1] * 16);
    this.put16(0x18, -o.rate[2] * 16);
    this.regs[0x34] = 25;
  }
}

/** InvenSense MPU-6050: raw accelerometer, gyro and temperature registers. */
export class Mpu6050 implements I2CDevice {
  regs = new Uint8Array(128);
  ptr = 0;
  /** frozen (a sim.stuck() fault): the registers stop updating */
  hold = false;
  private bias: [number, number, number];
  constructor(
    public name: string,
    private orient: () => Orientation,
    noise: ImuNoise,
    private rng: () => number,
  ) {
    this.regs[0x75] = 0x68;
    // asleep after power-up until PWR_MGMT_1 is cleared
    this.regs[0x6b] = 0x40;
    const b = () => (rng() - 0.5) * 2 * (noise.driftPerMin / 60) * 4;
    this.bias = [b(), b(), b()];
  }
  write(bytes: number[]) {
    if (!bytes.length) return;
    this.ptr = bytes[0] & 0x7f;
    for (let i = 1; i < bytes.length; i++) {
      this.regs[this.ptr] = bytes[i];
      this.ptr = (this.ptr + 1) & 0x7f;
    }
  }
  read(n: number): number[] {
    this.update();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.regs[this.ptr]);
      this.ptr = (this.ptr + 1) & 0x7f;
    }
    return out;
  }
  private put16be(reg: number, v: number) {
    const x = Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;
    this.regs[reg] = x >> 8;
    this.regs[reg + 1] = x & 0xff;
  }
  private update() {
    if (this.hold) return;
    if (this.regs[0x6b] & 0x40) {
      for (let r = 0x3b; r <= 0x48; r++) this.regs[r] = 0;
      return;
    }
    const o = this.orient();
    const D = Math.PI / 180;
    const aFs = 16384 / (1 << ((this.regs[0x1c] >> 3) & 3));
    const gFs = 131 / (1 << ((this.regs[0x1b] >> 3) & 3));
    const g = 9.80665;
    // gravity in the body frame, plus the body's own acceleration
    const ax = -Math.sin(o.pitch * D) + o.accel[0] / g;
    const ay = Math.sin(o.roll * D) * Math.cos(o.pitch * D) + o.accel[1] / g;
    const az = Math.cos(o.roll * D) * Math.cos(o.pitch * D) + o.accel[2] / g;
    const n = () => (this.rng() - 0.5) * 0.004;
    this.put16be(0x3b, (ax + n()) * aFs);
    this.put16be(0x3d, (ay + n()) * aFs);
    this.put16be(0x3f, (az + n()) * aFs);
    this.put16be(0x41, (25 - 36.53) * 340);
    this.put16be(0x43, (o.rate[0] + this.bias[0]) * gFs);
    this.put16be(0x45, (o.rate[1] + this.bias[1]) * gFs);
    this.put16be(0x47, (o.rate[2] + this.bias[2]) * gFs);
  }
}

/**
 * ST LSM6DSOX: accelerometer and gyro registers, little-endian, with the axes physically right for a chip
 * mounted flat with its X along the design's X (nose up reads +X acceleration, a nose-up turn -Y rate).
 */
export class Lsm6dsox implements I2CDevice {
  regs = new Uint8Array(128);
  ptr = 0;
  /** frozen (a sim.stuck() fault): the registers stop updating */
  hold = false;
  private bias: [number, number, number];
  /** the chip answers 10 ms after power-up */
  private bootAt: number;
  constructor(
    public name: string,
    private fcpu: number,
    private orient: () => Orientation,
    noise: ImuNoise,
    private rng: () => number,
    /** the chip's X, Y and Z axes in the body's (design) axes, when the board is mounted turned */
    private axes?: [number, number, number][],
  ) {
    this.regs[0x0f] = 0x6c;
    // CTRL3_C: register address auto-increment on
    this.regs[0x12] = 0x04;
    this.bootAt = 0.01 * fcpu;
    const b = () => (rng() - 0.5) * 2 * (noise.driftPerMin / 60) * 4;
    this.bias = [b(), b(), b()];
  }
  ready(t: number) {
    return t >= this.bootAt;
  }
  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.ptr = bytes[0] & 0x7f;
    for (let i = 1; i < bytes.length; i++) {
      const r = this.ptr;
      if (r === 0x12 && bytes[i] & 0x01) {
        // software reset: registers back to their defaults, the chip back after its boot time
        this.regs.fill(0, 0x10, 0x20);
        this.regs[0x12] = 0x04;
        this.bootAt = t + 0.01 * this.fcpu;
      } else if (r !== 0x0f) this.regs[r] = bytes[i];
      this.advance();
    }
  }
  read(n: number): number[] {
    this.update();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.regs[this.ptr]);
      this.advance();
    }
    return out;
  }
  private advance() {
    if (this.regs[0x12] & 0x04) this.ptr = (this.ptr + 1) & 0x7f;
  }
  private put16le(reg: number, v: number) {
    const x = Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;
    this.regs[reg] = x & 0xff;
    this.regs[reg + 1] = x >> 8;
  }
  /** a body-axes vector in the chip's own axes */
  private chip(v: number[]): number[] {
    const m = this.axes;
    return m ? m.map((c) => c[0] * v[0] + c[1] * v[1] + c[2] * v[2]) : v;
  }
  private update() {
    // a frozen chip: its output registers keep the last sample
    if (this.hold) return;
    const xlOn = this.regs[0x10] >> 4 !== 0;
    const gOn = this.regs[0x11] >> 4 !== 0;
    this.regs[0x1e] = (xlOn ? 1 : 0) | (gOn ? 2 : 0) | (xlOn || gOn ? 4 : 0);
    const o = this.orient();
    const D = Math.PI / 180;
    const g = 9.80665;
    if (xlOn) {
      // ±2, ±16, ±4, ±8 g
      const fs = [2, 16, 4, 8][(this.regs[0x10] >> 2) & 3];
      const lsb = 32768 / fs;
      const n = () => (this.rng() + this.rng() - 1) * 0.0012;
      const [ax, ay, az] = this.chip([Math.sin(o.pitch * D) + o.accel[0] / g, Math.sin(o.roll * D) * Math.cos(o.pitch * D) + o.accel[1] / g, Math.cos(o.roll * D) * Math.cos(o.pitch * D) + o.accel[2] / g]);
      this.put16le(0x28, (ax + n()) * lsb);
      this.put16le(0x2a, (ay + n()) * lsb);
      this.put16le(0x2c, (az + n()) * lsb);
    }
    if (gOn) {
      const c2 = this.regs[0x11];
      // 125 dps when FS_125 is set, else 250, 500, 1000, 2000 dps
      const fs = c2 & 0x02 ? 125 : [250, 500, 1000, 2000][(c2 >> 2) & 3];
      const lsb = 32768 / (fs * 1.143);
      const n = () => (this.rng() + this.rng() - 1) * 0.07;
      // physical body rates: the orientation's pitch rate is nose-up positive, which is a negative turn about Y
      const w = this.chip([o.rate[0], -o.rate[1], o.rate[2]]);
      this.put16le(0x22, (w[0] + this.bias[0] + n()) * lsb);
      this.put16le(0x24, (w[1] + this.bias[1] + n()) * lsb);
      this.put16le(0x26, (w[2] + this.bias[2] + n()) * lsb);
    }
    this.put16le(0x20, 0);
  }
}

// ---------- PCA9685 servo board ----------

/**
 * NXP PCA9685: sixteen 12-bit PWM outputs set over I2C. It powers up asleep with every output off. One
 * prescaler gives all sixteen the same frame rate from the chip's own oscillator (25 MHz, only good to a few
 * percent, so every pulse comes out that much shorter or longer than asked), and a new pulse width takes over at
 * the end of the frame it arrived in, so no pulse is cut short. With its supply gone it forgets everything.
 * Fed only through the board's I2C pull-ups it can still answer, asleep and with its registers at their
 * power-up values, but it cannot run: waking it there browns it out again.
 */
export class Pca9685 implements I2CDevice {
  regs = new Uint8Array(256);
  /** on its supply; or alive only through the I2C pull-ups */
  powered = false;
  starved = false;
  /** OE held high: every output off */
  oe = false;
  /** times it lost its settings after the firmware had set it up */
  resets = 0;
  readonly osc: number;
  private ptr = 0;
  /** µs of pulse each output gives per frame, as taken at the last frame's end (0: none) */
  private out = new Float64Array(16);
  /** the counts each output rises and falls at in the frame, taken with it; -1: held low, -2: held high */
  private rise = new Int16Array(16).fill(-1);
  private fall = new Int16Array(16);
  private frameAt = 0;
  /** when the frames began after the last wake */
  private firstAt = 0;
  private running = false;
  /** put to sleep with outputs going: they wait for RESTART, or for a new value */
  private parked = false;
  constructor(
    public name: string,
    private fcpu: number,
    part: CatalogPart,
  ) {
    this.osc = num(part, "osc_mhz", 25) * 1e6;
    this.reset();
  }
  private reset() {
    this.regs.fill(0);
    // MODE1: asleep, answering the all-call address; MODE2: totem-pole outputs
    this.regs[0x00] = 0x11;
    this.regs[0x01] = 0x04;
    this.regs.set([0xe2, 0xe4, 0xe8, 0xe0], 0x02);
    // every output full off
    for (let ch = 0; ch < 16; ch++) this.regs[0x09 + 4 * ch] = 0x10;
    // 200 Hz
    this.regs[0xfe] = 0x1e;
    this.out.fill(0);
    this.rise.fill(-1);
    this.running = this.parked = false;
    this.ptr = 0;
  }
  /** its supply this step: volts on VDD, and whether the bus's pull-ups still feed the board with VDD cut */
  power(v: number, backfed: boolean) {
    if (v >= 2.3) {
      this.powered = true;
      this.starved = false;
      return;
    }
    if (this.powered) {
      if (!(this.regs[0] & 0x10)) this.resets++;
      this.reset();
    }
    this.powered = false;
    this.starved = backfed;
  }
  ready() {
    return this.powered || this.starved;
  }
  /** frame rate, Hz */
  hz() {
    return this.osc / (4096 * (this.regs[0xfe] + 1));
  }
  asleep() {
    return (this.regs[0] & 0x10) !== 0;
  }
  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.ptr = bytes[0];
    for (let i = 1; i < bytes.length; i++) {
      this.put(this.ptr, bytes[i], t);
      this.advance();
    }
  }
  read(n: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      // the all-channel registers read as zero
      out.push(this.ptr >= 0xfa && this.ptr <= 0xfd ? 0 : this.regs[this.ptr]);
      this.advance();
    }
    return out;
  }
  private advance() {
    // auto-increment is a MODE1 bit; past the last channel register, and past the prescaler, it wraps to MODE1
    if (!(this.regs[0] & 0x20)) return;
    this.ptr = this.ptr === 0x45 || this.ptr >= 0xfe ? 0 : this.ptr + 1;
  }
  private put(reg: number, v: number, t: number) {
    if (reg === 0x00) {
      const was = this.regs[0];
      const sleep = (v & 0x10) !== 0;
      let restart = (was & 0x80) !== 0;
      if (sleep && !(was & 0x10) && this.running) {
        // put to sleep with outputs going: RESTART reads 1, and they wait for it
        restart = true;
        this.parked = true;
      }
      if (!sleep && v & 0x80 && restart) {
        restart = false;
        this.parked = false;
      }
      this.regs[0] = (v & 0x7f) | (restart ? 0x80 : 0);
      if (sleep) this.running = false;
      else if (was & 0x10) {
        if (this.starved) {
          // the pull-ups cannot run the oscillator: the supply collapses and the chip resets
          this.reset();
          return;
        }
        // the oscillator takes up to 500 µs to start
        this.running = true;
        this.frameAt = this.firstAt = t + 0.0005 * this.fcpu;
      }
      return;
    }
    if (reg === 0xfe) {
      // the prescaler only takes a new value while the chip sleeps
      if (this.regs[0] & 0x10) this.regs[0xfe] = Math.max(3, v);
      return;
    }
    if (reg >= 0xfa && reg <= 0xfd) {
      const k = reg - 0xfa;
      for (let ch = 0; ch < 16; ch++) this.regs[0x06 + 4 * ch + k] = k & 1 ? v & 0x1f : v;
      this.unpark();
      return;
    }
    if (reg >= 0x06 && reg <= 0x45) {
      this.regs[reg] = (reg - 0x06) & 1 ? v & 0x1f : v;
      this.unpark();
      return;
    }
    if (reg <= 0x05) this.regs[reg] = v;
  }
  /** a new value for any output clears RESTART: the outputs go by their registers again */
  private unpark() {
    this.parked = false;
    this.regs[0] &= 0x7f;
  }
  /** every plant step: the outputs take their registers' values at the end of each frame */
  tick(t: number) {
    if (!this.powered || !this.running) {
      this.out.fill(0);
      this.rise.fill(-1);
      return;
    }
    if (t < this.frameAt) return;
    const count = (this.regs[0xfe] + 1) / this.osc;
    const frame = count * 4096 * this.fcpu;
    this.frameAt += frame * (Math.floor((t - this.frameAt) / frame) + 1);
    if (this.parked) {
      this.out.fill(0);
      this.rise.fill(-1);
      return;
    }
    for (let ch = 0; ch < 16; ch++) {
      const b = 0x06 + 4 * ch;
      const on = this.regs[b] | ((this.regs[b + 1] & 0x0f) << 8);
      const off = this.regs[b + 2] | ((this.regs[b + 3] & 0x0f) << 8);
      // full off wins over full on; held high all frame is no pulse to a servo either
      const steady = (this.regs[b + 1] | this.regs[b + 3]) & 0x10;
      this.out[ch] = steady ? 0 : ((off - on + 4096) % 4096) * count * 1e6;
      this.rise[ch] = this.regs[b + 3] & 0x10 || on === off ? -1 : this.regs[b + 1] & 0x10 ? -2 : on;
      this.fall[ch] = off;
    }
  }
  /** the level an output holds while it is not pulsing (0 or 1), or -1 while it pulses */
  held(ch: number): number {
    if (!this.powered || !this.running || this.oe) return 0;
    return this.rise[ch] === -1 ? 0 : this.rise[ch] === -2 ? 1 : -1;
  }
  /**
   * A pulsing output's edges in the cycles from t0 up to t1, as [cycle, level] in order, for a controller pin
   * wired to it: each frame it rises at its on count and falls at its off count.
   */
  edges(ch: number, t0: number, t1: number): [number, number][] {
    const out: [number, number][] = [];
    if (this.held(ch) >= 0) return out;
    const count = ((this.regs[0xfe] + 1) / this.osc) * this.fcpu;
    const frame = count * 4096;
    for (let f = this.frameAt - frame * Math.ceil((this.frameAt - t0) / frame); f < t1; f += frame) {
      if (f < this.firstAt - 1) continue;
      const up = f + this.rise[ch] * count;
      const down = f + this.fall[ch] * count;
      if (up >= t0 && up < t1) out.push([Math.round(up), 1]);
      if (down >= t0 && down < t1) out.push([Math.round(down), 0]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }
  /** the pulse an output gives each frame, µs, or null while it gives none */
  pulseUs(ch: number): number | null {
    if (!this.powered || !this.running || this.oe) return null;
    const us = this.out[ch];
    return us > 0 ? us : null;
  }
}

// ---------- NAU7802 bridge ADC ----------

/** samples a second for each CRS setting of CTRL2 */
const NAU_RATES = [10, 20, 40, 80, 80, 80, 80, 320];

/**
 * Nuvoton NAU7802: a 24-bit ADC for a load cell bridge, on I2C. The firmware powers up its digital and analog
 * halves, turns on the regulator that excites the bridge, picks the gain and the sample rate and starts it
 * converting; a status bit says when each sample is ready. A sample is the bridge's output as a share of its
 * excitation, times the gain, in counts of 2^-24 of full scale, with the bridge's own zero offset and the
 * chip's noise (about 16 counts rms at 10 samples a second and a gain of 128, more at faster rates).
 */
export class Nau7802 implements I2CDevice {
  regs = new Uint8Array(32);
  /** frozen (a sim.stuck() fault): it stops sampling and its registers keep the last reading */
  hold = false;
  samples = 0;
  private ptr = 0;
  private on = false;
  private pudAt = Infinity;
  private nextAt = Infinity;
  private calUntil = -1;
  /** what a system offset calibration took off, counts */
  private zero = 0;
  private last = 0;
  constructor(
    public name: string,
    private fcpu: number,
    /** the bridge's output over its excitation (V/V) right now */
    private bridge: () => number,
    /** the bridge's zero offset, V/V */
    private offset: number,
    private rng: () => number,
  ) {
    this.clear();
  }
  private clear() {
    this.regs.fill(0);
    // the chip's revision
    this.regs[0x1f] = 0x0f;
    this.pudAt = this.nextAt = Infinity;
    this.calUntil = -1;
    this.zero = 0;
  }
  private rate() {
    return NAU_RATES[(this.regs[0x02] >> 4) & 7];
  }
  private gain() {
    return 1 << (this.regs[0x01] & 7);
  }
  /** a change of gain, rate or supply: the next four conversions are not to be trusted, so none comes out */
  private settle(t: number) {
    this.regs[0x00] &= ~0x20;
    this.nextAt = t + (4 * this.fcpu) / this.rate();
  }
  private converting() {
    // digital and analog on, and the cycle started
    return (this.regs[0x00] & 0x16) === 0x16;
  }
  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.ptr = bytes[0] & 0x1f;
    for (let i = 1; i < bytes.length; i++) {
      this.put(this.ptr, bytes[i], t);
      this.ptr = (this.ptr + 1) & 0x1f;
    }
  }
  read(n: number, t: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(this.get(this.ptr, t));
      this.ptr = (this.ptr + 1) & 0x1f;
    }
    return out;
  }
  private put(reg: number, v: number, t: number) {
    if (reg === 0x00) {
      if (v & 0x01) {
        // RR: every register back to its default, held there until RR is written 0
        this.clear();
        this.regs[0] = 0x01;
        return;
      }
      const was = this.regs[0];
      // PUR and CR are the chip's to set
      this.regs[0] = (v & 0xd6) | (was & 0x20);
      if (v & 0x02 && !(was & 0x02)) this.pudAt = t;
      if (!(v & 0x02)) this.pudAt = Infinity;
      if (this.converting()) {
        if ((was & 0x96) !== (v & 0x96)) this.settle(t);
      } else {
        this.regs[0] &= ~0x20;
        this.nextAt = Infinity;
      }
      return;
    }
    if (reg === 0x02) {
      const was = this.regs[2];
      this.regs[2] = v & 0xf7;
      // CALS starts a calibration, which takes a few conversions
      if (v & 0x04 && this.converting()) this.calUntil = t + (6 * this.fcpu) / this.rate();
      else this.regs[2] &= ~0x04;
      if (((was ^ v) & 0xf0) !== 0 && this.converting()) this.settle(t);
      return;
    }
    if (reg === 0x01) {
      const was = this.regs[1];
      this.regs[1] = v;
      if (was !== v && this.converting()) this.settle(t);
      return;
    }
    // the result and the revision are read-only
    if ((reg >= 0x12 && reg <= 0x14) || reg === 0x1f) return;
    this.regs[reg] = v;
  }
  private get(reg: number, t: number): number {
    if (reg === 0x00) return (this.regs[0] & ~0x08) | (this.regs[0] & 0x02 && t >= this.pudAt + 0.0002 * this.fcpu ? 0x08 : 0);
    // reading the result's first byte takes the sample: CR falls until the next one
    if (reg === 0x12) this.regs[0] &= ~0x20;
    return this.regs[reg];
  }
  /** every plant step, with whether the board has its supply */
  tick(t: number, powered: boolean) {
    if (!powered) {
      if (this.on) this.clear();
      this.on = false;
      return;
    }
    this.on = true;
    if (!this.converting()) return;
    if (this.calUntil >= 0 && t >= this.calUntil) {
      // an internal offset calibration takes out the chip's own offset, which this model does not have; a system
      // one zeroes on whatever the bridge gives at that moment
      if ((this.regs[2] & 0x03) === 0x02) this.zero += this.last;
      this.regs[2] &= ~0x04;
      this.calUntil = -1;
      this.settle(t);
    }
    if (t < this.nextAt) return;
    const period = this.fcpu / this.rate();
    this.nextAt += period * (Math.floor((t - this.nextAt) / period) + 1);
    if (this.hold || this.calUntil >= 0) return;
    // the bridge is excited by the chip's regulator: with it off there is nothing to measure
    const excited = (this.regs[0] & 0x80) !== 0;
    const gain = this.gain();
    const noise = (this.rng() + this.rng() - 1) * 2.45 * 16 * Math.sqrt(this.rate() / 10) * Math.max(gain / 128, 0.05);
    const code = Math.round((excited ? this.bridge() + this.offset : 0) * gain * 2 ** 24 + noise) - this.zero;
    this.last = Math.max(-(2 ** 23), Math.min(2 ** 23 - 1, code));
    const u = this.last & 0xffffff;
    this.regs[0x12] = u >> 16;
    this.regs[0x13] = (u >> 8) & 0xff;
    this.regs[0x14] = u & 0xff;
    this.regs[0] |= 0x20;
    this.samples++;
  }
}

// ---------- ESC and ducted fan ----------

/**
 * A hobby brushless ESC with the motor it spins, here an electric ducted fan. The ESC arms after its signal
 * has sat at minimum throttle for its arming time, maps 1000-2000 µs to throttle, holds the last throttle
 * through short gaps and stops the motor (and disarms) when the signal is gone for its timeout. The motor is
 * a Kv model (back EMF, winding resistance worked out from the rated full-throttle current, a current limit)
 * driving a fan whose drag torque and thrust go with speed squared.
 */
export class EscFan {
  /** the ESC is powered and has armed */
  powered = false;
  armed = false;
  armedAt = -1;
  throttle = 0;
  /** rotor speed, rad/s; thrust, N; motor current and battery current, A */
  omega = 0;
  thrust = 0;
  motorCurrent = 0;
  current = 0;
  /** rotor angular acceleration, rad/s²; the drag torque the air puts on the blades, N·m */
  alpha = 0;
  dragTorque = 0;
  /** what the ESC did, for the run's events */
  said: string[] = [];
  peakThrust = 0;
  peakCurrent = 0;
  maxRpm = 0;
  lost = false;
  /** rotor inertia, kg·m², and which way it spins about the thrust axis (+1: counter-clockwise seen from the intake) */
  readonly J: number;
  readonly spin: number;
  readonly fanArea: number;
  assumed: string[] = [];
  private lowFor = 0;
  private lostFor = 0;
  private kvr: number;
  private R: number;
  private cq: number;
  private kT: number;
  private iFree: number;
  private wFull: number;
  private iLim: number;
  private usMin: number;
  private usMax: number;
  private armS: number;
  private lossS: number;
  private vOn: number;
  constructor(
    public name: string,
    esc: CatalogPart,
    fan: CatalogPart | undefined,
  ) {
    this.usMin = num(esc, "pwm_min_us", 1000);
    this.usMax = num(esc, "pwm_max_us", 2000);
    this.armS = num(esc, "arm_ms", 1500) / 1000;
    this.lossS = num(esc, "signal_loss_ms", 250) / 1000;
    this.iLim = num(esc, "i_burst", num(esc, "i_cont", 30) * 1.3);
    this.vOn = Math.max(5, num(esc, "v_min", 9.9) * 0.7);
    const f = fan ?? esc;
    const kv = num(f, "kv", 3000);
    this.kvr = (kv * 2 * Math.PI) / 60;
    const vRated = num(f, "thrust_v", 14.8);
    const iMax = num(f, "i_max", 30);
    this.iFree = num(f, "i_free", 1);
    this.wFull = (num(f, "rpm_full", kv * vRated * 0.82) * 2 * Math.PI) / 60;
    const r = (vRated - this.wFull / this.kvr) / iMax;
    this.R = r > 0.005 ? r : 0.05;
    this.cq = ((iMax - this.iFree) / this.kvr) / (this.wFull * this.wFull);
    this.kT = ((num(f, "thrust_g", 1000) / 1000) * 9.80665) / (this.wFull * this.wFull);
    this.J = num(f, "rotor_j_gcm2", 100) * 1e-7;
    this.spin = String(f.specs.spin ?? "ccw_from_intake").startsWith("cw") ? -1 : 1;
    const d = num(f, "fan_d", 64) / 1000;
    const hub = num(f, "hub_d", d * 450) / 1000;
    this.fanArea = (Math.PI / 4) * (d * d - hub * hub);
    if (fan && !("rotor_j_gcm2" in fan.specs)) this.assumed.push(`${name}: rotor inertia assumed ${num(f, "rotor_j_gcm2", 100)} g·cm²`);
    this.assumed.push(
      `${name}: thrust and drag go with fan speed squared, from ${num(f, "thrust_g", 1000)} g at ${Math.round((this.wFull * 60) / (2 * Math.PI))} rpm on ${vRated} V; winding and ESC resistance ${(this.R * 1000).toFixed(0)} mΩ worked out from the rated ${iMax} A`,
    );
  }

  /** one step: the signal's pulse (µs, or null when there is none) and the battery volts at the ESC */
  step(us: number | null, vbatt: number, dt: number, t: number) {
    if (vbatt < this.vOn) {
      if (this.armed) this.said.push(`${this.name} lost power`);
      this.powered = this.armed = false;
      this.lowFor = 0;
    } else this.powered = true;
    if (us === null) this.lostFor += dt;
    else this.lostFor = 0;
    if (this.powered && !this.armed) {
      this.throttle = 0;
      this.lowFor = us !== null && us < this.usMin + 50 ? this.lowFor + dt : 0;
      if (this.lowFor >= this.armS) {
        this.armed = true;
        this.lost = false;
        if (this.armedAt < 0) this.armedAt = t;
        this.said.push(`${this.name} armed (signal at ${Math.round(us ?? 0)} µs for ${this.armS} s)`);
      }
    } else if (this.armed && this.lostFor > this.lossS) {
      this.armed = false;
      this.lost = true;
      this.lowFor = 0;
      this.throttle = 0;
      this.said.push(`${this.name} lost its signal for over ${Math.round(this.lossS * 1000)} ms: motor stopped, it needs minimum throttle again to re-arm`);
    } else if (this.armed && us !== null) this.throttle = Math.max(0, Math.min(1, (us - this.usMin) / (this.usMax - this.usMin)));
    // the motor: the ESC's average voltage against back EMF, never driving current backwards (brake off)
    const run = this.powered && this.armed && this.throttle > 0.03;
    const veff = run ? this.throttle * vbatt : 0;
    const emf = this.omega / this.kvr;
    this.motorCurrent = run ? Math.max(0, Math.min(this.iLim, (veff - emf) / this.R)) : 0;
    const loss = (this.iFree / this.kvr) * Math.min(1, this.omega / this.wFull + 0.05) * (this.omega > 1 ? 1 : 0);
    this.dragTorque = this.cq * this.omega * this.omega;
    this.alpha = (this.motorCurrent / this.kvr - loss - this.dragTorque) / this.J;
    this.omega = Math.max(0, this.omega + this.alpha * dt);
    this.thrust = this.kT * this.omega * this.omega;
    this.current = this.powered ? (run ? (this.throttle * this.motorCurrent) / 0.95 : 0) + 0.04 : 0;
    if (this.thrust > this.peakThrust) this.peakThrust = this.thrust;
    if (this.current > this.peakCurrent) this.peakCurrent = this.current;
    const rpm = (this.omega * 60) / (2 * Math.PI);
    if (rpm > this.maxRpm) this.maxRpm = rpm;
  }

  /** the jet's speed leaving the fan, m/s (thrust = mass flow × speed) */
  jetSpeed(rho = 1.2) {
    return Math.sqrt(this.thrust / (rho * this.fanArea));
  }
}

/** What a display showed from a moment on: one bit a pixel, rows of w/8 bytes, most significant bit leftmost. */
export interface DisplayFrame {
  t: number;
  px: Uint8Array;
}

/** command bytes that take parameters, and how many */
const SSD1306_ARGS: Record<number, number> = { 0x81: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2 };
/** keep at most this many frames: past it, every other one goes and the gap between frames doubles */
const DISPLAY_FRAMES_MAX = 3000;

/**
 * Solomon SSD1306 OLED controller on I2C: the command set the usual drivers
 * send (Adafruit, U8g2, hand-rolled), its display RAM in all three addressing
 * modes, and what the panel shows, recorded as frames over time.
 */
export class Ssd1306 implements I2CDevice {
  ram: Uint8Array;
  pages: number;
  on = false;
  inverted = false;
  allOn = false;
  contrast = 0x7f;
  chargePump = false;
  segRemap = false;
  comReverse = false;
  startLine = 0;
  frames: DisplayFrame[] = [];
  /** told about set-up mistakes the panel would show as a dark screen */
  warn?: (msg: string) => void;
  private mode = 2;
  private col = 0;
  private page = 0;
  private colStart = 0;
  private colEnd: number;
  private pageStart = 0;
  private pageEnd: number;
  private cmd: number[] = [];
  private dirty = true;
  private lastSnap = -Infinity;
  private gap = 0.05;
  constructor(
    public name: string,
    public w: number,
    public h: number,
    private fcpu: number,
  ) {
    this.pages = h / 8;
    this.ram = new Uint8Array(w * this.pages);
    this.colEnd = w - 1;
    this.pageEnd = this.pages - 1;
  }
  write(bytes: number[]) {
    let i = 0;
    while (i < bytes.length) {
      const control = bytes[i++];
      const data = (control & 0x40) !== 0;
      // Co = 1: one byte, then another control byte; Co = 0: the rest of the message
      const end = control & 0x80 ? Math.min(bytes.length, i + 1) : bytes.length;
      for (; i < end; i++) {
        if (data) this.data(bytes[i]);
        else this.command(bytes[i]);
      }
    }
    this.dirty = true;
  }
  read(n: number): number[] {
    // the status byte: bit 6 set while the display is off
    return new Array(n).fill(this.on ? 0 : 0x40);
  }
  private command(b: number) {
    // a command's parameters arrive as the bytes after it
    if (this.cmd.length) {
      this.cmd.push(b);
      if (this.cmd.length > SSD1306_ARGS[this.cmd[0]]) {
        this.apply(this.cmd);
        this.cmd = [];
      }
      return;
    }
    if (SSD1306_ARGS[b]) this.cmd = [b];
    else this.apply([b]);
  }
  private apply([c, a = 0, b = 0]: number[]) {
    if (c === 0xae) this.on = false;
    else if (c === 0xaf) {
      this.on = true;
      if (!this.chargePump) this.warn?.(`${this.name} was switched on with its charge pump off, so the panel stays dark: send 0x8D, 0x14 before 0xAF`);
    }
    else if (c === 0xa4 || c === 0xa5) this.allOn = c === 0xa5;
    else if (c === 0xa6 || c === 0xa7) this.inverted = c === 0xa7;
    else if (c === 0xa0 || c === 0xa1) this.segRemap = c === 0xa1;
    else if (c === 0xc0 || c === 0xc8) this.comReverse = c === 0xc8;
    else if (c >= 0x40 && c <= 0x7f) this.startLine = c & 0x3f;
    else if (c >= 0xb0 && c <= 0xb7) this.page = (c & 7) % this.pages;
    else if (c <= 0x0f) this.col = (this.col & 0xf0) | c;
    else if (c >= 0x10 && c <= 0x1f) this.col = ((c & 0x0f) << 4) | (this.col & 0x0f);
    else if (c === 0x81) this.contrast = a;
    else if (c === 0x8d) this.chargePump = (a & 0x04) !== 0;
    else if (c === 0x20) this.mode = a & 3;
    else if (c === 0x21) {
      this.colStart = this.col = a & 0x7f;
      this.colEnd = b & 0x7f;
    } else if (c === 0x22) {
      this.pageStart = this.page = (a & 7) % this.pages;
      this.pageEnd = (b & 7) % this.pages;
    }
  }
  private data(b: number) {
    if (this.col < this.w) this.ram[this.page * this.w + this.col] = b;
    if (this.mode === 2) {
      // page addressing: along the page, wrapping to its start
      this.col = this.col >= this.w - 1 ? 0 : this.col + 1;
    } else if (this.mode === 0) {
      if (++this.col > this.colEnd) {
        this.col = this.colStart;
        if (++this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (++this.page > this.pageEnd) {
      this.page = this.pageStart;
      if (++this.col > this.colEnd) this.col = this.colStart;
    }
  }
  /** The panel as seen, upright with the usual A1/C8 set-up: one bit a pixel. */
  image(): Uint8Array {
    const { w, h } = this;
    const out = new Uint8Array((w * h) / 8);
    if (!this.on || !this.chargePump) return out;
    for (let y = 0; y < h; y++) {
      const row = (((this.comReverse ? y : h - 1 - y) + this.startLine) % h) | 0;
      const p = row >> 3;
      const bit = 1 << (row & 7);
      for (let x = 0; x < w; x++) {
        const col = this.segRemap ? x : w - 1 - x;
        let lit = this.allOn || (this.ram[p * w + col] & bit) !== 0;
        if (this.inverted) lit = !lit;
        if (lit) out[y * (w >> 3) + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return out;
  }
  /** Called as time passes: record what changed, at most every `gap` seconds (`final`: at the end of the run). */
  tick(cyc: number, final = false) {
    const t = cyc / this.fcpu;
    if (!this.dirty || (!final && t - this.lastSnap < this.gap)) return;
    this.dirty = false;
    this.lastSnap = t;
    const px = this.image();
    const last = this.frames[this.frames.length - 1];
    if (last && last.px.every((v, i) => v === px[i])) return;
    this.frames.push({ t, px });
    if (this.frames.length > DISPLAY_FRAMES_MAX) {
      this.frames = this.frames.filter((_f, i) => i % 2 === 0);
      this.gap *= 2;
    }
  }
}
