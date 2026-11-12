// Distance and temperature sensors the firmware reads: a Sharp GP2Y0A21YK0F infrared ranger and the TMP36 and
// an NTC thermistor module on analog pins, and a Benewake TF-Luna LiDAR and a Microchip MCP9808 on the I2C bus,
// each with its own update rate, curve, register map and unit-to-unit spread. The distance comes from the
// world's range for the part and the temperature from the air round it (the world's ambient, or its own
// temperature at the part when it has one), followed with each package's thermal lag.

import type { CatalogPart, MachineComponent } from "../../machine/types";
import type { World } from "../worlds/types";
import type { I2CDevice } from "./hal";
import type { Plant } from "./plant";

const num = (p: CatalogPart, key: string, fallback: number): number => {
  const v = p.specs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};
/** about a unit normal sample, from three uniform ones */
const gauss = (rng: () => number) => (rng() + rng() + rng() - 1.5) * 2;
const sym = (rng: () => number) => rng() * 2 - 1;

// ---------- the Sharp curve ----------

/**
 * GP2Y0A21YK0F output for a white target at a distance, volts at 5 V: the datasheet's curve as d = 27.86·V^-1.15
 * (cm) from its 7.4 cm peak of 3.15 V out to its 80 cm end (0.4 V), flattening to about 0.28 V with nothing in
 * range, and falling again nearer than the peak, so a close object reads as a farther one.
 */
export function sharpVolts(mm: number): number {
  const cm = Math.max(0, mm / 10);
  const peakCm = 7.4;
  if (cm < peakCm) return 3.15 * Math.pow(cm / peakCm, 0.6);
  return Math.max(0.28, Math.min(3.15, Math.pow(27.86 / cm, 1 / 1.15)));
}

// ---------- thermistor ----------

/** Steinhart-Hart coefficients of the 10 kΩ NTC on the Duinotech module (Jaycar's own example code uses them) */
const SH = { a: 1.129148e-3, b: 2.34125e-4, c: 8.76741e-8 };

/** NTC resistance at a temperature (°C) from the Steinhart-Hart equation, solved for ln R by Newton's method */
export function ntcOhms(tempC: number): number {
  const inv = 1 / (tempC + 273.15);
  let x = Math.log(10000) + (1 / (tempC + 273.15) - 1 / 298.15) * 3950;
  for (let i = 0; i < 6; i++) {
    const f = SH.a + SH.b * x + SH.c * x * x * x - inv;
    x -= f / (SH.b + 3 * SH.c * x * x);
  }
  return Math.exp(x);
}

/** a first-order thermal lag, followed lazily from the time it is asked */
class Lag {
  private at = -1;
  private v = NaN;
  constructor(private tau: number) {}
  value(target: number, t: number): number {
    if (this.at < 0 || !Number.isFinite(this.v)) this.v = target;
    else if (t > this.at) this.v += (target - this.v) * (1 - Math.exp(-(t - this.at) / this.tau));
    this.at = Math.max(this.at, t);
    return this.v;
  }
}

// ---------- TF-Luna ----------

/**
 * Benewake TF-Luna in I2C mode (address 0x10, chosen by tying its CFG pin to ground before power-up). Byte
 * registers that auto-increment: distance in cm at 0x00/0x01, signal strength (amp) at 0x02/0x03, chip
 * temperature in 0.01 °C at 0x04/0x05 and a millisecond tick at 0x06/0x07 (each low byte first); the firmware
 * version at 0x0A to 0x0C and a 14-character serial number from 0x10. Writable: 0x23 mode (0 continuous,
 * 1 triggered), 0x24 trigger one frame, 0x25 enable (1 on, 0 laser off), 0x26/0x27 frame rate (100 Hz, at
 * most 100 on I2C), 0x29 factory defaults, 0x2A/0x2B amp threshold (100) and 0x2C/0x2D the distance it gives
 * below that (0). It measures 0.2 to 8 m on a white target to ±6 cm (±2 % past 3 m); nearer than 0.2 m it
 * reads about 20 cm whatever is there, and the amp falls with distance until the reading drops out. An address
 * change (0x22) is kept but it goes on answering at its old address.
 */
export class TfLuna implements I2CDevice {
  hold = false;
  reads = 0;
  frames = 0;
  /** the last distance it gave, cm */
  last = 0;
  private reg = new Uint8Array(0x40);
  private ptr = 0;
  private next = 0;
  private bias: number;

  constructor(
    public name: string,
    private fcpu: number,
    private range: () => number,
    private tempC: () => number,
    private rng: () => number,
    private powered: () => boolean = () => true,
  ) {
    this.bias = sym(rng) * 3;
    this.defaults();
    this.reg[0x0a] = 0;
    this.reg[0x0b] = 3;
    this.reg[0x0c] = 3;
    const sn = "TFLUNA20230001";
    for (let i = 0; i < sn.length; i++) this.reg[0x10 + i] = sn.charCodeAt(i);
    this.next = 0.1 * fcpu;
  }

  private defaults() {
    const r = this.reg;
    r[0x22] = 0x10;
    r[0x23] = 0;
    r[0x25] = 1;
    r[0x26] = 100;
    r[0x27] = 0;
    r[0x28] = 0;
    r[0x2a] = 100;
    r[0x2b] = 0;
    r[0x2c] = 0;
    r[0x2d] = 0;
    r[0x30] = 0x20;
    r[0x31] = 0x03;
  }

  ready(t: number) {
    // it takes a moment from power-up before it answers, and needs 3.7 V
    return t >= 0.1 * this.fcpu && this.powered();
  }

  private word(at: number) {
    return this.reg[at] | (this.reg[at + 1] << 8);
  }

  private put(at: number, v: number) {
    const x = Math.max(0, Math.min(0xffff, Math.round(v)));
    this.reg[at] = x & 0xff;
    this.reg[at + 1] = x >> 8;
  }

  private period() {
    const fps = Math.max(1, Math.min(100, this.word(0x26) || 100));
    return this.fcpu / fps;
  }

  private frame(t: number) {
    this.frames++;
    if (this.hold) return;
    const mm = Math.max(0, this.range());
    // the signal falls off with distance: 100 (the threshold) at 8 m on a white target
    const amp = Math.min(65534, 100 * Math.pow(8000 / Math.max(mm, 50), 1.5) * (1 + 0.1 * gauss(this.rng)));
    let cm: number;
    if (mm < 200) cm = 20 + 2 * gauss(this.rng);
    else {
      const sd = mm < 3000 ? 1.2 : mm * 0.004 / 10;
      cm = mm / 10 + (mm < 3000 ? this.bias : (this.bias / 3) * (mm / 1000)) + sd * gauss(this.rng);
    }
    const shown = amp < this.word(0x2a) ? this.word(0x2c) : Math.max(0, Math.round(cm));
    this.last = shown;
    this.put(0x00, shown);
    this.put(0x02, amp);
    this.put(0x04, (this.tempC() + 15) * 100);
    this.put(0x06, ((t / this.fcpu) * 1000) % 65536);
  }

  private catchUp(t: number) {
    if (this.reg[0x23] === 1 || !this.reg[0x25]) {
      this.next = Math.max(this.next, t);
      return;
    }
    const p = this.period();
    if (t - this.next > 20 * p) this.next = t - p;
    while (t >= this.next) {
      this.frame(this.next);
      this.next += p;
    }
  }

  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.catchUp(t);
    this.ptr = bytes[0] & 0xff;
    for (let i = 1; i < bytes.length; i++, this.ptr++) {
      const at = this.ptr;
      const v = bytes[i] & 0xff;
      if (at >= 0x40) continue;
      if (at === 0x24) {
        if (v === 1 && this.reg[0x23] === 1 && this.reg[0x25]) this.frame(t);
        continue;
      }
      if (at === 0x29) {
        if (v === 1) this.defaults();
        continue;
      }
      if (at === 0x20 || at === 0x21) continue;
      // writable settings only: the readings and the version stay what the chip made them
      if (at >= 0x22 && at <= 0x31) this.reg[at] = v;
      if (at === 0x23 && v === 0) this.next = t;
    }
  }

  read(n: number, t: number): number[] {
    this.catchUp(t);
    this.reads++;
    const out: number[] = [];
    for (let i = 0; i < n; i++, this.ptr++) out.push(this.ptr < 0x40 ? this.reg[this.ptr] : 0);
    return out;
  }
}

// ---------- MCP9808 ----------

/** conversion time at each resolution setting (0.5, 0.25, 0.125 and 0.0625 °C), seconds */
const MCP_CONV = [0.03, 0.065, 0.13, 0.25];

/**
 * Microchip MCP9808 on the I2C bus (0x18, plus A0 to A2 tied high): 16-bit registers, high byte first, behind a
 * pointer the firmware writes. T_A (0x05) holds the temperature in 1/16 °C with its sign in bit 12 and three
 * flags above it (bit 15 at or above T_CRIT, 14 above T_UPPER, 13 below T_LOWER, all 0 °C until set), so
 * firmware that does not mask them reads nonsense. Manufacturer ID 0x0054 (0x06), device ID 0x0400 (0x07),
 * resolution (0x08, one byte, 0.0625 °C by default, a new reading every 250 ms; 30 ms at 0.5 °C) and CONFIG
 * (0x01, bit 8 shuts it down). It reads 0 °C until its first conversion is done, and is within ±0.25 °C.
 */
export class Mcp9808 implements I2CDevice {
  hold = false;
  reads = 0;
  samples = 0;
  /** the last temperature it converted, °C */
  last = NaN;
  private ptr = 0;
  private config = 0;
  private upper = 0;
  private lower = 0;
  private crit = 0;
  private res = 3;
  private ta = 0;
  private next: number;
  private offset: number;

  constructor(
    public name: string,
    private fcpu: number,
    private tempC: (t: number) => number,
    private rng: () => number,
  ) {
    this.offset = sym(rng) * 0.25;
    this.next = MCP_CONV[3] * fcpu;
  }

  private catchUp(t: number) {
    const conv = MCP_CONV[this.res] * this.fcpu;
    if (this.config & 0x100) {
      this.next = t + conv;
      return;
    }
    if (t - this.next > 4 * conv) this.next = t - conv;
    while (t >= this.next) {
      if (!this.hold) {
        const c = this.tempC(this.next / this.fcpu) + this.offset + 0.015 * gauss(this.rng);
        let raw = Math.max(-4095, Math.min(4095, Math.round(c * 16)));
        // coarser resolutions leave the low bits clear
        raw &= ~((1 << (3 - this.res)) - 1);
        this.ta = raw & 0x1fff;
        this.last = raw / 16;
        this.samples++;
      }
      this.next += conv;
    }
  }

  /** a 13-bit two's complement temperature register (sign in bit 12) as °C */
  private static celsius(v: number) {
    const x = v & 0x1fff;
    return (x & 0x1000 ? x - 0x2000 : x) / 16;
  }

  private value(reg: number): number {
    switch (reg) {
      case 1:
        return this.config;
      case 2:
        return this.upper;
      case 3:
        return this.lower;
      case 4:
        return this.crit;
      case 5: {
        const ta = Mcp9808.celsius(this.ta);
        const flags = (ta >= Mcp9808.celsius(this.crit) ? 0x8000 : 0) | (ta > Mcp9808.celsius(this.upper) ? 0x4000 : 0) | (ta < Mcp9808.celsius(this.lower) ? 0x2000 : 0);
        return flags | this.ta;
      }
      case 6:
        return 0x0054;
      case 7:
        return 0x0400;
      default:
        return 0;
    }
  }

  write(bytes: number[], t: number) {
    if (!bytes.length) return;
    this.catchUp(t);
    this.ptr = bytes[0] & 0x0f;
    if (this.ptr === 8) {
      if (bytes.length >= 2) {
        this.res = bytes[1] & 0x03;
        this.next = t + MCP_CONV[this.res] * this.fcpu;
      }
      return;
    }
    if (bytes.length < 3) return;
    const v = ((bytes[1] & 0xff) << 8) | (bytes[2] & 0xff);
    if (this.ptr === 1) {
      const wasOff = this.config & 0x100;
      this.config = v & 0x07ff;
      if (wasOff && !(this.config & 0x100)) this.next = t + MCP_CONV[this.res] * this.fcpu;
    } else if (this.ptr >= 2 && this.ptr <= 4) {
      const lim = v & 0x1ffc;
      if (this.ptr === 2) this.upper = lim;
      else if (this.ptr === 3) this.lower = lim;
      else this.crit = lim;
    }
  }

  read(n: number, t: number): number[] {
    this.catchUp(t);
    this.reads++;
    if (this.ptr === 8) return Array.from({ length: n }, () => this.res);
    const v = this.value(this.ptr);
    return Array.from({ length: n }, (_, i) => (i % 2 === 0 ? v >> 8 : v & 0xff));
  }
}

// ---------- in the plant ----------

interface Watched {
  comp: string;
  kind: "range" | "temp";
  /** what the part reads at this moment: mm, or °C */
  truth: () => number;
  /** what it puts out, volts (analog parts) */
  volts?: () => number;
  dev?: TfLuna | Mcp9808;
}

/** The distance and temperature sensors in a plant. */
export class Sensing {
  watched: Watched[] = [];

  constructor(private plant: Plant) {}

  /** the air temperature at a part, °C: the world's own where it has one, else its ambient */
  private airAt(comp: string): number {
    const w = this.plant.world as World & { temperature?(comp: string): number | undefined };
    return w.temperature?.(comp) ?? w.thermal().ambient;
  }

  private volts(comp: string, pin: string): number {
    const n = this.plant.netOf(comp, pin);
    return n ? (this.plant.netV.get(n.id) ?? 0) : 0;
  }

  private onBus(mc: MachineComponent): boolean {
    const p = this.plant;
    const sda = p.mcuPinFor(mc.name, "SDA");
    const scl = p.mcuPinFor(mc.name, "SCL");
    if (sda === p.board.sda && scl === p.board.scl) return true;
    if (sda >= 0 || scl >= 0) p.notes.push(`${mc.name}: SDA and SCL must go to the ${p.board.name}'s I2C pins for Wire; it is not on the bus.`);
    return false;
  }

  /** Builds the model for a part it knows; false for any other. */
  attach(mc: MachineComponent, part: CatalogPart, rng: () => number): boolean {
    const p = this.plant;
    const fcpu = p.board.fcpu;
    const chip = String(part.specs.chip ?? "");
    const said = new Set<string>();
    const once = (key: string, text: string) => {
      if (said.has(key)) return;
      said.add(key);
      p.events.push({ t: p.t, kind: "warn", text });
    };
    switch (chip) {
      case "GP2Y0A21YK0F": {
        const pin = p.mcuPinFor(mc.name, "VO");
        const truth = () => p.world.range?.(mc.name) ?? 1000;
        const gain = 1 + 0.08 * sym(rng);
        const period = (0.0383 + 0.005 * sym(rng)) * fcpu;
        let next = period;
        let held = 0;
        const powered = () => this.volts(mc.name, "VCC") >= 4.5;
        const out = (t: number) => {
          if (!powered()) {
            const vcc = this.volts(mc.name, "VCC");
            if (vcc > 0.5) once("vcc", `${mc.name} has ${vcc.toFixed(1)} V on VCC: it needs 4.5 to 5.5 V, and below that its output means nothing`);
            return 0;
          }
          // it measures once a period and holds the result in between
          if (t - next > 10 * period) next = t - period;
          while (t >= next) {
            held = sharpVolts(truth()) * gain + 0.012 * gauss(rng);
            next += period;
          }
          return held;
        };
        if (pin >= 0) p.analogSrc.set(pin, out);
        this.watched.push({ comp: mc.name, kind: "range", truth, volts: () => (powered() ? sharpVolts(truth()) * gain : 0) });
        return true;
      }
      case "XC4494": {
        // the thermistor from VCC to OUT and a 10 kΩ resistor from OUT to GND: OUT rises as it warms
        const pin = p.mcuPinFor(mc.name, "OUT");
        const lag = new Lag(num(part, "tau_s", 8));
        const r25 = 1 + 0.03 * sym(rng);
        const rFix = 10000 * (1 + 0.01 * sym(rng));
        const truth = () => this.airAt(mc.name);
        const out = (t: number) => {
          const vcc = this.volts(mc.name, "VCC");
          const c = lag.value(truth(), t / fcpu);
          const rt = ntcOhms(c) * r25;
          return (vcc * rFix) / (rFix + rt);
        };
        if (pin >= 0) p.analogSrc.set(pin, out);
        this.watched.push({ comp: mc.name, kind: "temp", truth, volts: () => out(p.hal.cyc) });
        return true;
      }
      case "TMP36": {
        const pin = p.mcuPinFor(mc.name, "VOUT");
        const lag = new Lag(num(part, "tau_s", 60));
        const offset = sym(rng);
        const truth = () => this.airAt(mc.name);
        const clean = (t: number) => {
          const vs = this.volts(mc.name, "VS");
          if (vs < 2.7) return { vs, v: 0 };
          const c = lag.value(truth(), t / fcpu) + offset;
          return { vs, v: Math.max(0.1, Math.min(vs - 0.6, 0.5 + 0.01 * c)) };
        };
        const out = (t: number) => {
          const { vs, v } = clean(t);
          if (vs < 2.7) {
            if (vs > 0.5) once("vs", `${mc.name} has ${vs.toFixed(1)} V on +Vs: it needs 2.7 to 5.5 V`);
            return 0;
          }
          return v + 0.0003 * gauss(rng);
        };
        if (pin >= 0) p.analogSrc.set(pin, out);
        this.watched.push({ comp: mc.name, kind: "temp", truth, volts: () => clean(p.hal.cyc).v });
        return true;
      }
      case "TF-Luna": {
        const truth = () => p.world.range?.(mc.name) ?? 1000;
        const vcc = () => this.volts(mc.name, "VCC");
        const dev = new TfLuna(mc.name, fcpu, truth, () => this.airAt(mc.name), rng, () => {
          const v = vcc();
          if (v >= 3.7) return true;
          if (v > 0.5) once("vcc", `${mc.name} has ${v.toFixed(1)} V on +5V: it needs 3.7 to 5.2 V and does not start below that`);
          return false;
        });
        this.watched.push({ comp: mc.name, kind: "range", truth, dev });
        if (!this.onBus(mc)) return true;
        const cfg = p.netOf(mc.name, "CFG");
        if (!cfg?.pins.some((x) => x.pin.type === "gnd")) {
          p.notes.push(`${mc.name}.CFG is not tied to ground, so it starts in UART mode and does not answer on I2C. Tie CFG to GND (Kerf does not simulate its UART output).`);
          return true;
        }
        p.i2cDevs.set(0x10, { dev, vcc: p.netOf(mc.name, "VCC"), comp: mc.name });
        p.assumptions.push(`${mc.name}: a white target at the world's range; dark or shiny ones give it less signal and shorter reach`);
        return true;
      }
      case "MCP9808": {
        // A0 to A2 are pulled low on the board: each one tied high adds its bit to 0x18
        const high = (pin: string) => !!p.netOf(mc.name, pin)?.pins.some((x) => x.pin.type === "pwr_out" || x.pin.type === "pwr_rail");
        const addr = 0x18 + (high("A0") ? 1 : 0) + (high("A1") ? 2 : 0) + (high("A2") ? 4 : 0);
        const lag = new Lag(num(part, "tau_s", 30));
        const truth = () => this.airAt(mc.name);
        const dev = new Mcp9808(mc.name, fcpu, (s) => lag.value(truth(), s), rng);
        this.watched.push({ comp: mc.name, kind: "temp", truth, dev });
        if (this.onBus(mc)) p.i2cDevs.set(addr, { dev, vcc: p.netOf(mc.name, "VIN"), comp: mc.name });
        return true;
      }
    }
    return false;
  }

  /** numbers for the timeline: what each sensor sees, and what an analog one puts out */
  channels(out: Record<string, number>) {
    for (const w of this.watched) {
      out[`${w.comp}.${w.kind === "range" ? "range" : "temp"}`] = w.truth();
      if (w.volts) out[`${w.comp}.volts`] = w.volts();
    }
  }

  /** what the firmware took from each one over the run */
  results(): Record<string, number | boolean | string> {
    const r: Record<string, number | boolean | string> = {};
    for (const w of this.watched) {
      if (w.dev instanceof TfLuna) {
        r[`${w.comp}.reads`] = w.dev.reads;
        r[`${w.comp}.distance`] = w.dev.last * 10;
      } else if (w.dev instanceof Mcp9808) {
        r[`${w.comp}.reads`] = w.dev.reads;
        r[`${w.comp}.temp`] = Number.isFinite(w.dev.last) ? w.dev.last : 0;
      }
    }
    return r;
  }
}
