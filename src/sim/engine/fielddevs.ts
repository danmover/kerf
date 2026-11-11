// Models of the parts a magnetic rig and a small wind tunnel are built from,
// each from its catalog specs and its chip's datasheet: a wound air-core coil
// on an H-bridge (resistance that rises as it warms, inductance, PWM ripple,
// what happens when the bridge lets go), the INA3221 three-channel current
// monitor, the TMAG5273 three-axis field sensor, the SDP8xx differential
// pressure sensor, and a four-wire PWM fan with its tacho. The I2C chips
// answer the registers and commands their real libraries use, convert at the
// rate their settings give, and carry the chip-to-chip offset, gain error and
// noise the datasheets quote, so firmware that works here has dealt with them.

import type { CatalogPart } from "../../machine/types";
import { wheelerInductance, windingResistance } from "../mech/field";
import type { I2CDevice } from "./hal";

const num = (p: CatalogPart, key: string, fallback: number): number => {
  const v = p.specs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

/** about a unit normal sample, from three uniform ones */
const gauss = (rng: () => number) => (rng() + rng() + rng() - 1.5) * 2;
const sym = (rng: () => number) => rng() * 2 - 1;

// ---------- wound coil ----------

/** the two switches in the current's path through a MOSFET bridge whose catalog entry does not give r_on, Ω */
export const BRIDGE_OHMS: Record<string, number> = { tb6612fng: 0.5, drv8833: 0.36 };

/** volts a bridge's two body diodes drop while a coil's current runs back into the supply */
const DIODES = 1.4;

/**
 * An air-core coil on a driver output. It is a resistor and an inductor in series: the current follows the
 * average voltage with the time constant L / R (stepped exactly, so a coil faster than the plant's step is still
 * right), the copper's resistance rises 0.393 % per kelvin as it warms, and a magnet moving nearby adds a small
 * voltage of its own. When the bridge switches off, the current runs on through the bridge's diodes into the
 * supply and is gone in a fraction of the time constant.
 */
export class CoilLoad {
  /** amps through the winding: + in at START and out at END */
  current = 0;
  /** average volts across the winding and what is in series with it this step */
  volts = 0;
  /** peak-to-peak swing the driver's PWM puts on the current, A, and the PWM's rate, Hz */
  ripple = 0;
  pwmHz = 0;
  /** copper temperature, °C */
  temp: number;
  peakCurrent = 0;
  maxTemp: number;
  /** heat made in the winding so far, J */
  energy = 0;
  /** ohms at 20 °C, henries */
  readonly r20: number;
  readonly L: number;
  readonly tempMax: number;
  /** J/K of the copper, and W/K it sheds to still air */
  private cth: number;
  private ha: number;
  assumed: string[] = [];

  constructor(
    public name: string,
    part: CatalogPart,
    ambient: number,
  ) {
    const ri = num(part, "id", 10) / 2000;
    const ro = num(part, "od", 30) / 2000;
    const h = num(part, "h", 15) / 1000;
    const turns = num(part, "turns", 100);
    const wire = num(part, "wire_d", 0.5) / 1000;
    const len = num(part, "wire_m", turns * Math.PI * (ri + ro));
    const given = (k: string) => typeof part.specs[k] === "number";
    this.r20 = num(part, "r_ohm", windingResistance(len, wire));
    this.L = num(part, "l_mh", wheelerInductance(ri, ro, h, turns) * 1000) / 1000;
    if (!given("r_ohm") || !given("l_mh")) this.assumed.push(`${name}: ${!given("r_ohm") ? `resistance ${this.r20.toFixed(2)} Ω from its ${len.toFixed(0)} m of ${(wire * 1000).toFixed(2)} mm copper` : ""}${!given("r_ohm") && !given("l_mh") ? " and " : ""}${!given("l_mh") ? `inductance ${(this.L * 1000).toFixed(1)} mH from Wheeler's formula` : ""}`);
    this.tempMax = num(part, "temp_max", 105);
    // the copper's heat capacity (385 J/kg/K), and what its outside, bore and two faces lose to still air and by
    // radiation, about 11 W/m²/K together
    const copper = num(part, "mass_g", len * Math.PI * (wire / 2) ** 2 * 8.96e6) / 1000;
    this.cth = Math.max(0.5, copper * 385);
    this.ha = 11 * (2 * Math.PI * ro * h + 2 * Math.PI * ri * h * 0.5 + 2 * Math.PI * (ro * ro - ri * ri));
    this.temp = ambient;
    this.maxTemp = ambient;
  }

  /** the winding's resistance at its temperature now, Ω */
  get resistance() {
    return this.r20 * (1 + 0.00393 * (this.temp - 20));
  }

  /**
   * v: the driver's average output across the coil (+ drives START positive), null when its outputs are off;
   * vs: its supply; rPath: the bridge's switches and a current shunt in series, Ω; emf: volts a moving magnet
   * (and the other coils) induce against the current; ilim: the driver's current limit; pwmHz: its PWM rate.
   */
  step(v: number | null, vs: number, rPath: number, emf: number, ilim: number, pwmHz: number, dt: number, ambient: number, cooling: number) {
    stepCoilString([{ c: this, sign: 1 }], v, vs, rPath, emf, ilim, pwmHz, dt, ambient, cooling);
  }

  /** this step's current and ripple (set by the string it is in), and the heat they make in the copper */
  carry(i: number, volts: number, ripple: number, pwmHz: number, dt: number, ambient: number, cooling: number) {
    this.current = i;
    this.volts = volts;
    this.ripple = ripple;
    this.pwmHz = pwmHz;
    if (Math.abs(i) > this.peakCurrent) this.peakCurrent = Math.abs(i);
    // a triangle's rms is its swing over √12
    const p = (i * i + (ripple * ripple) / 12) * this.resistance;
    this.energy += p * dt;
    this.temp += (dt * (p - this.ha * cooling * (this.temp - ambient))) / this.cth;
    if (this.temp > this.maxTemp) this.maxTemp = this.temp;
  }
}

/**
 * One step of a string of coils in series on a driver output (one coil is a string of one): their resistances
 * and inductances add and one current runs through them all, each seeing it in at its START or its END by its
 * sign. v is the driver's average output across the string (+ from its first output), null when its outputs
 * are off; emf is what moving magnets and other coils induce against the string's current. Returns the string's
 * current.
 */
export function stepCoilString(members: readonly { c: CoilLoad; sign: number }[], v: number | null, vs: number, rPath: number, emf: number, ilim: number, pwmHz: number, dt: number, ambient: number, cooling: number): number {
  let R = rPath;
  let L = 0;
  for (const m of members) {
    R += m.c.resistance;
    L += m.c.L;
  }
  const k = Math.exp((-dt * R) / L);
  let i = members[0].c.current * members[0].sign;
  let ripple = 0;
  let across = 0;
  if (v === null) {
    if (Math.abs(i) > 1e-9) {
      const s = Math.sign(i);
      const back = -s * (vs + DIODES);
      const inf = (back - emf) / R;
      const n = inf + (i - inf) * k;
      i = Math.sign(n) === s ? n : 0;
      across = back;
    } else i = 0;
  } else {
    const inf = (v - emf) / R;
    i = inf + (i - inf) * k;
    if (Math.abs(i) > ilim) i = Math.sign(i) * ilim;
    across = v;
    const d = vs > 0 ? Math.min(1, Math.abs(v) / vs) : 0;
    ripple = pwmHz > 0 && d > 0 && d < 1 ? Math.min((vs * d * (1 - d)) / (L * pwmHz), vs / R) : 0;
  }
  // each coil's share of the volts goes with its share of the string's inductance
  for (const m of members) m.c.carry(m.sign * i, m.sign * across * (m.c.L / L), ripple, pwmHz, dt, ambient, cooling);
  return i;
}

// ---------- INA3221 ----------

/** What one shunt channel of a current monitor sees. */
export interface ShuntTap {
  /** amps through the shunt, + from IN+ to IN−; its PWM ripple (peak to peak) and rate */
  amps: number;
  ripple: number;
  pwmHz: number;
  /** volts on IN−, against ground */
  bus: number;
}

const INA_CT = [140e-6, 204e-6, 332e-6, 588e-6, 1.1e-3, 2.116e-3, 4.156e-3, 8.244e-3];
const INA_AVG = [1, 4, 16, 64, 128, 256, 512, 1024];
const INA_CONFIG = 0x7127;

/**
 * TI INA3221: three shunt and bus voltage channels behind sixteen-bit registers, most significant byte first,
 * with no register auto-increment (each read needs its own pointer write). It converts each enabled channel's
 * shunt then bus voltage in turn, for the conversion times and averaging the configuration register asks for,
 * and the result registers only change when a whole cycle ends. Shunt voltage is 40 µV a step in 13 bits
 * (0.8 mA on the 0.05 Ω shunts), bus voltage 8 mV a step. Each channel has its own offset (about ±40 µV) and
 * gain error (the shunt's 1 %), and shorter conversions are noisier and let more PWM ripple through.
 */
export class Ina3221 implements I2CDevice {
  /** frozen (a sim.stuck() fault): the registers stop updating */
  hold = false;
  private regs = new Map<number, number>();
  private ptr = 0;
  private off: number[];
  private gain: number[];
  /** when the conversions under way began, and how many cycles have been taken into the registers */
  private t0 = 0;
  private seen = -1;
  /** single-shot: one cycle was asked for */
  private oneShot = false;
  reads = 0;

  constructor(
    public name: string,
    private fcpu: number,
    private shunt: number,
    /** what each of the three channels measures now (undefined: nothing wired through it) */
    private taps: (() => ShuntTap | undefined)[],
    private rng: () => number,
  ) {
    this.off = [0, 1, 2].map(() => sym(rng) * 40e-6);
    this.gain = [0, 1, 2].map(() => 1 + sym(rng) * 0.01);
    this.reset(0);
  }

  private reset(t: number) {
    this.regs.clear();
    this.regs.set(0x00, INA_CONFIG);
    for (const r of [0x07, 0x09, 0x0b]) this.regs.set(r, 0x7ff8);
    for (const r of [0x08, 0x0a, 0x0c]) this.regs.set(r, 0x7ff8);
    this.regs.set(0x0e, 0x7ffe);
    this.regs.set(0x0f, 0x0002);
    this.regs.set(0x10, 0x2710);
    this.regs.set(0x11, 0x2328);
    this.regs.set(0xfe, 0x5449);
    this.regs.set(0xff, 0x3220);
    this.t0 = t;
    this.seen = -1;
    this.oneShot = false;
  }

  /** seconds one cycle through the enabled channels takes, 0 when it is powered down */
  cycle(): number {
    const c = this.regs.get(0) ?? INA_CONFIG;
    const mode = c & 7;
    if ((mode & 3) === 0) return 0;
    const n = ((c >> 14) & 1) + ((c >> 13) & 1) + ((c >> 12) & 1);
    const per = (mode & 1 ? INA_CT[(c >> 3) & 7] : 0) + (mode & 2 ? INA_CT[(c >> 6) & 7] : 0);
    return n * per * INA_AVG[(c >> 9) & 7];
  }

  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.ptr = bytes[0] & 0xff;
    if (bytes.length < 3) return;
    const v = ((bytes[1] & 0xff) << 8) | (bytes[2] & 0xff);
    const r = this.ptr;
    if (r === 0x00) {
      if (v & 0x8000) return this.reset(t);
      this.update(t);
      this.regs.set(0, v & 0x7fff);
      this.t0 = t;
      this.seen = -1;
      this.oneShot = (v & 4) === 0 && (v & 3) !== 0;
      // a new single-shot conversion clears the ready flag
      if (this.oneShot) this.regs.set(0x0f, (this.regs.get(0x0f) ?? 0) & ~1);
      return;
    }
    // result and ID registers are read-only
    if ((r >= 0x01 && r <= 0x06) || r === 0x0d || r >= 0xfe) return;
    if (r <= 0x11) this.regs.set(r, v);
  }

  read(n: number, t: number): number[] {
    this.update(t);
    this.reads++;
    const v = this.regs.get(this.ptr) ?? 0xffff;
    // reading the mask register clears its conversion-ready flag
    if (this.ptr === 0x0f) this.regs.set(0x0f, v & ~1);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? v >> 8 : v & 0xff);
    return out;
  }

  /** take a finished conversion cycle into the result registers */
  private update(t: number) {
    if (this.hold) return;
    const per = this.cycle();
    if (per <= 0) return;
    const done = Math.floor((t - this.t0) / (per * this.fcpu));
    if (done <= this.seen || done < 1) return;
    if (this.oneShot && this.seen >= 1) return;
    this.seen = done;
    const c = this.regs.get(0) ?? INA_CONFIG;
    const mode = c & 7;
    const avg = INA_AVG[(c >> 9) & 7];
    const ct = INA_CT[(c >> 3) & 7];
    let sum = 0;
    for (let ch = 0; ch < 3; ch++) {
      if (!((c >> (14 - ch)) & 1)) continue;
      const tap = this.taps[ch]?.();
      if (mode & 1) {
        // the delta-sigma converter averages over its conversion time: PWM ripple faster than that mostly cancels
        const through = tap && tap.pwmHz > 0 ? Math.min(1, 0.3 / (tap.pwmHz * ct)) / Math.sqrt(avg) : 0;
        const vsh = (tap ? (tap.amps + 0.5 * tap.ripple * through * sym(this.rng)) * this.shunt * this.gain[ch] : 0) + this.off[ch] + gauss(this.rng) * 28e-6 * Math.sqrt(140e-6 / ct / avg);
        const code = Math.max(-4096, Math.min(4095, Math.round(vsh / 40e-6)));
        this.regs.set(0x01 + ch * 2, (code << 3) & 0xffff);
        sum += code;
      }
      if (mode & 2) {
        const code = Math.max(0, Math.min(4095, Math.round(((tap?.bus ?? 0) + gauss(this.rng) * 2e-3) / 8e-3)));
        this.regs.set(0x02 + ch * 2, (code << 3) & 0xffff);
      }
    }
    this.regs.set(0x0d, (Math.max(-16384, Math.min(16383, sum)) << 1) & 0xffff);
    this.regs.set(0x0f, (this.regs.get(0x0f) ?? 0) | 1);
  }
}

// ---------- TMAG5273 ----------

/**
 * What a field sensor's chip sees: flux density on its own X, Y and Z, tesla, the peak-to-peak swing coil PWM
 * ripple puts on each, and the slowest of those PWM rates, Hz.
 */
export interface FieldReading {
  b: [number, number, number];
  ripple: [number, number, number];
  hz: number;
}

/** channels the MAG_CH_EN setting converts, in order (0 X, 1 Y, 2 Z) */
const TMAG_CH: number[][] = [[], [0], [1], [0, 1], [2], [2, 0], [1, 2], [0, 1, 2], [0, 1, 0], [1, 0, 1], [1, 2, 1], [0, 2, 0]];

/**
 * TI TMAG5273 (the A1: ±40 or ±80 mT): flux density on three axes and its own temperature behind one-byte
 * registers that auto-increment. It powers up in standby and converts only once the firmware puts it in
 * continuous mode; each result takes 25 µs for every channel and average it is set to, plus 25 µs, and the
 * result registers hold a conversion until the next one ends. Results are sixteen bits of the chosen range and
 * clip at it. The chip's zero is off by up to its offset spec on each axis, its scale by its sensitivity
 * error, and each sample carries the datasheet's noise, falling with the square root of the averaging.
 */
export class Tmag5273 implements I2CDevice {
  regs = new Uint8Array(0x1d);
  ptr = 0;
  /** frozen (a sim.stuck() fault): the results stop updating */
  hold = false;
  private off: [number, number, number];
  private gain: [number, number, number];
  private noise: [number, number, number];
  private rangeLo: number;
  private rangeHi: number;
  private t0 = 0;
  private seen = -1;
  private bootAt: number;
  /** conversions taken into the registers, and how many of them clipped */
  samples = 0;
  clipped = 0;
  /** the last field it converted, tesla (before its own errors) */
  last: [number, number, number] = [0, 0, 0];

  constructor(
    public name: string,
    private fcpu: number,
    part: CatalogPart,
    private field: () => FieldReading | undefined,
    private tempC: () => number,
    private rng: () => number,
  ) {
    const off = num(part, "offset_ut", 300) * 1e-6;
    const ge = num(part, "gain_err_pct", 5) / 100;
    const common = sym(rng) * ge;
    this.off = [sym(rng) * off, sym(rng) * off, sym(rng) * off];
    this.gain = [1 + common + sym(rng) * 0.01, 1 + common + sym(rng) * 0.01, 1 + common + sym(rng) * 0.01];
    this.noise = [num(part, "noise_xy_ut", 125) * 1e-6, num(part, "noise_xy_ut", 125) * 1e-6, num(part, "noise_z_ut", 68) * 1e-6];
    this.rangeLo = num(part, "range_mt", 40) * 1e-3;
    this.rangeHi = num(part, "range_hi_mt", 80) * 1e-3;
    this.bootAt = 0.001 * fcpu;
    this.reset();
  }

  private reset() {
    this.regs.fill(0);
    this.regs[0x04] = this.regs[0x05] = this.regs[0x06] = 0;
    this.regs[0x07] = 0;
    // I2C address register, device ID (version 1: the ±40/80 mT part) and TI's manufacturer ID
    this.regs[0x0c] = 0x35 << 1;
    this.regs[0x0d] = 0x01;
    this.regs[0x0e] = 0x49;
    this.regs[0x0f] = 0x54;
    // CONV_STATUS: power-on reset seen
    this.regs[0x18] = 0x10;
    this.seen = -1;
  }

  ready(t: number) {
    return t >= this.bootAt;
  }

  /** seconds one result takes with the channels and averaging set now; 0 when nothing converts */
  period(): number {
    if ((this.regs[0x01] & 3) !== 2) return 0;
    const ch = TMAG_CH[this.regs[0x02] >> 4] ?? [];
    const n = ch.length + (this.regs[0x07] & 1);
    if (!n) return 0;
    const avg = 1 << Math.min(5, (this.regs[0x00] >> 2) & 7);
    return 25e-6 * n * avg + 25e-6;
  }

  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.ptr = bytes[0] & 0x7f;
    for (let i = 1; i < bytes.length; i++) {
      const r = this.ptr;
      const v = bytes[i] & 0xff;
      if (r <= 0x0b) {
        this.convert(t);
        this.regs[r] = v;
        // a change of mode, channels, averaging or range starts the conversions afresh
        if (r <= 0x03 || r === 0x07) {
          this.t0 = t;
          this.seen = -1;
        }
      } else if (r === 0x18) {
        // writing 1 clears the power-on reset flag
        if (v & 0x10) this.regs[0x18] &= ~0x10;
      }
      this.ptr = (this.ptr + 1) & 0x7f;
    }
  }

  read(n: number, t: number): number[] {
    this.convert(t);
    const out: number[] = [];
    let results = false;
    for (let i = 0; i < n; i++) {
      out.push(this.ptr < this.regs.length ? this.regs[this.ptr] : 0);
      if (this.ptr >= 0x10 && this.ptr <= 0x17) results = true;
      this.ptr = (this.ptr + 1) & 0x7f;
    }
    // reading a result clears "new result"
    if (results) this.regs[0x18] &= ~0x01;
    return out;
  }

  private put(reg: number, v: number): boolean {
    const x = Math.round(v);
    const c = Math.max(-32768, Math.min(32767, x));
    this.regs[reg] = (c >> 8) & 0xff;
    this.regs[reg + 1] = c & 0xff;
    return c !== x;
  }

  /** take the latest finished conversion into the result registers */
  private convert(t: number) {
    if (this.hold) return;
    const per = this.period();
    if (per <= 0) return;
    const done = Math.floor((t - this.t0) / (per * this.fcpu));
    if (done <= this.seen || done < 1) return;
    this.seen = done;
    const f = this.field();
    const b = f?.b ?? [0, 0, 0];
    this.last = [b[0], b[1], b[2]];
    const avg = 1 << Math.min(5, (this.regs[0x00] >> 2) & 7);
    const ch = TMAG_CH[this.regs[0x02] >> 4] ?? [];
    const xyHi = (this.regs[0x03] & 2) !== 0;
    const zHi = (this.regs[0x03] & 1) !== 0;
    // each channel is sampled for 25 µs an average: PWM ripple much faster than that window mostly cancels
    const through = f && f.hz > 0 ? Math.min(1, 0.3 / (f.hz * 25e-6 * avg)) : 0;
    let clip = false;
    for (const a of new Set(ch)) {
      const range = (a === 2 ? zHi : xyHi) ? this.rangeHi : this.rangeLo;
      // the wider range is noisier in proportion
      const sd = (this.noise[a] * (range / this.rangeLo)) / Math.sqrt(avg);
      const rip = f ? 0.5 * f.ripple[a] * through * sym(this.rng) : 0;
      const seen = (b[a] + rip) * this.gain[a] + this.off[a] + gauss(this.rng) * sd;
      if (this.put(0x12 + a * 2, (seen / range) * 32768)) clip = true;
    }
    if (this.regs[0x07] & 1) this.put(0x10, 17508 + 60.1 * (this.tempC() - 25) + gauss(this.rng) * 8);
    this.samples++;
    if (clip) this.clipped++;
    // CONV_STATUS: a rolling 3-bit count of results, and "new result"
    this.regs[0x18] = (this.regs[0x18] & 0x10) | ((this.samples & 7) << 5) | 0x01;
  }
}

// ---------- SDP8xx ----------

/** Sensirion's CRC-8: polynomial 0x31, start 0xFF, over each two-byte word */
export function sensirionCrc(a: number, b: number): number {
  let crc = 0xff;
  for (const byte of [a, b]) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const word = (v: number): number[] => {
  const x = Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;
  return [x >> 8, x & 0xff, sensirionCrc(x >> 8, x & 0xff)];
};

/**
 * Sensirion SDP8xx differential pressure sensor: sixteen-bit commands start a continuous measurement (0x3615
 * and 0x361E for pressure with and without averaging between reads, 0x3603 and 0x3608 compensated for mass
 * flow), 0x3FF9 stops it, and each read returns pressure, temperature and the scale factor, every word with its
 * CRC. The first reading comes 8 ms after the start; before that, and when stopped, the chip does not answer a
 * read. It makes a new sample every half millisecond; averaging mode gives the mean of those since the last
 * read. Zero offset and span error are the datasheet's (0.1 Pa and 3 % of reading on the 500 Pa part).
 */
export class Sdp8xx implements I2CDevice {
  /** frozen (a sim.stuck() fault): the reading stops updating */
  hold = false;
  private running = false;
  private averaging = false;
  private startedAt = 0;
  private lastRead = 0;
  private scale: number;
  private range: number;
  private zero: number;
  private span: number;
  private sd: number;
  private held: number[] | null = null;
  private queue: number[] | null = null;
  private idArmed = false;
  reads = 0;
  /** the last pressure it reported, Pa */
  last = 0;

  constructor(
    public name: string,
    private fcpu: number,
    part: CatalogPart,
    private pressure: () => number,
    private tempC: () => number,
    private rng: () => number,
  ) {
    this.scale = num(part, "counts_per_pa", 60);
    this.range = num(part, "range_pa", 500);
    this.zero = sym(rng) * num(part, "zero_pa", 0.1);
    this.span = 1 + (sym(rng) * num(part, "span_err_pct", 3)) / 100;
    this.sd = num(part, "noise_pa", 0.08);
  }

  ready(t: number) {
    // 25 ms from power-up to the first command
    return t >= 0.025 * this.fcpu;
  }

  write(bytes: number[], t: number) {
    if (bytes.length < 2) return;
    const cmd = ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff);
    this.queue = null;
    switch (cmd) {
      case 0x3603:
      case 0x3608:
      case 0x3615:
      case 0x361e:
        // a start while it is already measuring is ignored: it has to be stopped first
        if (this.running) return;
        this.running = true;
        this.averaging = cmd === 0x3603 || cmd === 0x3615;
        this.startedAt = t;
        this.lastRead = t;
        this.held = null;
        return;
      case 0x3ff9:
        this.running = false;
        return;
      case 0x367c:
        this.idArmed = true;
        return;
      case 0xe102:
        if (!this.idArmed) return;
        this.idArmed = false;
        // product number (SDP810-500Pa is 0x03020A01, the 125 Pa part 0x03020B01) and a serial number
        this.queue = [...word(0x0302), ...word(this.range > 300 ? 0x0a01 : 0x0b01), ...word(0x0000), ...word(0x4b45), ...word(0x5246), ...word(0x0001)];
        return;
    }
  }

  read(n: number, t: number): number[] {
    if (this.queue) return this.queue.slice(0, n);
    if (!this.running || t - this.startedAt < 0.008 * this.fcpu) return [];
    this.reads++;
    if (!this.hold || !this.held) {
      // samples every 0.5 ms; averaging mode gives the mean of those since the last read
      const samples = this.averaging ? Math.max(1, Math.min(4000, Math.floor(((t - this.lastRead) / this.fcpu) * 2000))) : 1;
      const p = Math.max(-this.range * 1.1, Math.min(this.range * 1.1, this.pressure() * this.span + this.zero + (gauss(this.rng) * this.sd) / Math.sqrt(samples)));
      this.last = p;
      this.held = [...word(p * this.scale), ...word(this.tempC() * 200), ...word(this.scale)];
      this.lastRead = t;
    }
    return this.held.slice(0, n);
  }
}

// ---------- four-wire PWM fan ----------

/**
 * A four-wire fan: it runs from its supply whenever that is on, and the PWM wire only tells its own controller
 * how fast (a share of full speed, never below its minimum; an open PWM wire means flat out). The rotor takes
 * its spin-up time to follow, and coasts down more slowly than it speeds up. Its current goes with the cube of
 * the speed, more while it is accelerating, and the tacho wire pulls low twice a turn.
 */
export class PwmFan {
  /** rotor speed, rpm; supply current, A */
  rpm = 0;
  current = 0;
  maxRpm = 0;
  peakCurrent = 0;
  /** turns since the start, for the tacho */
  turns = 0;
  readonly rpmMax: number;
  readonly rpmMin: number;
  readonly vRated: number;
  readonly vStart: number;
  readonly iRated: number;
  readonly iMax: number;
  readonly pwmHz: number;
  readonly ppr: number;
  /** stops below this PWM share (0: never stops while powered) */
  readonly stopBelow: number;
  /** free-air flow, m³/s, and shut-off pressure, Pa, at full speed */
  readonly flowMax: number;
  readonly pressureMax: number;
  private tau: number;

  constructor(
    public name: string,
    part: CatalogPart,
  ) {
    this.rpmMax = num(part, "rpm_max", 3000);
    this.rpmMin = num(part, "rpm_min", this.rpmMax * 0.2);
    this.vRated = num(part, "v_rated", 12);
    this.vStart = num(part, "v_start", this.vRated * 0.55);
    this.iRated = num(part, "i_rated", 0.3);
    this.iMax = num(part, "i_max", this.iRated * 1.5);
    this.pwmHz = num(part, "pwm_hz", 25000);
    this.ppr = num(part, "tach_ppr", 2);
    this.stopBelow = num(part, "stop_below_pct", 0) / 100;
    this.flowMax = num(part, "flow_m3h", 100) / 3600;
    this.pressureMax = num(part, "pressure_pa", 50);
    this.tau = num(part, "spin_up_s", 1.5) / 3;
  }

  /** rotor speed as a share of full speed at its rated volts */
  get speed() {
    return this.rpm / this.rpmMax;
  }

  /** duty: what the PWM wire carries, 0..1, or -1 when nothing drives it; volts: its supply */
  step(duty: number, volts: number, dt: number) {
    const d = duty < 0 ? 1 : Math.min(1, duty);
    const top = this.rpmMax * Math.min(1.1, volts / this.vRated);
    let want = volts < this.vStart * 0.6 || (this.rpm < 30 && volts < this.vStart) ? 0 : Math.min(top, Math.max(this.rpmMin, d * top));
    if (this.stopBelow > 0 && d < this.stopBelow) want = 0;
    const up = want > this.rpm;
    const before = this.rpm;
    this.rpm += (want - this.rpm) * (1 - Math.exp(-dt / (up ? this.tau : this.tau * 1.6)));
    if (this.rpm < 1) this.rpm = 0;
    this.turns += ((before + this.rpm) / 2 / 60) * dt;
    if (this.rpm > this.maxRpm) this.maxRpm = this.rpm;
    // electronics, then the blades' load (power with speed cubed), then what it takes to speed the rotor up
    const s = this.rpm / this.rpmMax;
    const run = volts < 3 ? 0 : 0.04 + (this.iRated - 0.04) * s * s * s;
    const push = up ? (this.iMax - run) * Math.min(1, (want - this.rpm) / (0.25 * this.rpmMax)) : 0;
    this.current = volts < 3 ? 0 : Math.min(this.iMax, run + Math.max(0, push));
    if (this.current > this.peakCurrent) this.peakCurrent = this.current;
  }
}
