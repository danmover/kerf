// Models of the parts the plant is built from, each from its catalog specs:
// battery (open-circuit curve, internal resistance, polarisation), buck
// regulator, DC gearmotor with encoder and heating, linear actuator with its
// potentiometer, hobby servo, and the I2C IMUs. Where a datasheet number is
// missing the model says what it assumed.

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
  /** counts the encoder has crossed (quadrature), as a float */
  counts = 0;
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
    this.cth = mass * 0.45;
    this.rth = 12 * Math.sqrt(524 / mass);
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
    this.put16(0x1c, (o.roll + n()) * scale);
    this.put16(0x1e, (o.pitch + n()) * scale);
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
