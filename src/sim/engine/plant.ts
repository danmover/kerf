// The electrical and mechanical plant around the microcontroller, built from
// the design's own wiring: the netlist says which pin drives which driver
// input, which encoder reaches which interrupt pin, what each analog pin
// measures and which devices sit on the I2C bus. Each 1 ms step it reads
// the firmware's outputs, drives the motors against the world's loads, and
// feeds the sensors back.

import { buildNetlist, type Net, type NetPin, type Netlist } from "../../machine/erc";
import { catalogPart } from "../../machine/catalog";
import type { CatalogPart, MachineComponent, MachineData } from "../../machine/types";
import type { Board } from "../mcu/board";
import { Actuator, Battery, Bno055, DCMotor, Mpu6050, Regulator, Servo, Ssd1306, quadrature, type ImuNoise } from "./devices";
import type { I2CDevice, PlantPort, SimHal } from "./hal";
import { FREE_LOAD, type PlantView, type World, type WorldEvent } from "../worlds/types";

export type Src = { kind: "mcu"; pin: number } | { kind: "high" } | { kind: "low" } | { kind: "none"; def: number };

interface Channel {
  comp: string;
  part: CatalogPart;
  ch: string;
  scheme: string;
  src: Record<string, Src[]>;
  supply?: Net;
  plus?: NetPin;
  minus?: NetPin;
  ilim: number;
  icont: number;
  vdrop: number;
  // state
  vOut: number | null;
  pwmPin: number;
  current: number;
  supplyCurrent: number;
  heat: number;
  shutdown: boolean;
}

interface MotorSlot {
  comp: string;
  mc: MachineComponent;
  m: DCMotor;
  chan?: Channel;
  polarity: number;
  encA: number;
  encB: number;
  encVcc?: Net;
  lastA: number;
  lastB: number;
}

interface ActSlot {
  comp: string;
  a: Actuator;
  chan?: Channel;
  polarity: number;
  fbPin: number;
  fbVcc?: Net;
}

interface ServoSlot {
  comp: string;
  s: Servo;
  pin: number;
  vcc?: Net;
}

interface FuseSlot {
  comp: string;
  rating: number;
  over2: number;
  over35: number;
  blown: boolean;
}

export const SCHEMES: Record<string, Record<string, Record<string, string[]>>> = {
  pwm_dir: { A: { pwm: ["PWM", "PWM1"], dir: ["DIR", "DIR1"], en: ["SLP", "EN"] }, B: { pwm: ["PWM2"], dir: ["DIR2"] } },
  in1_in2_pwm: { A: { in1: ["AIN1"], in2: ["AIN2"], pwm: ["PWMA"], en: ["STBY"] }, B: { in1: ["BIN1"], in2: ["BIN2"], pwm: ["PWMB"], en: ["STBY"] } },
  in1_in2_en: { A: { in1: ["IN1"], in2: ["IN2"], pwm: ["ENA"] }, B: { in1: ["IN3"], in2: ["IN4"], pwm: ["ENB"] } },
  rpwm_lpwm: { A: { fwd: ["RPWM"], rev: ["LPWM"], en: ["R_EN", "L_EN"] } },
  in1_in2_pwm_both: { A: { fwd: ["AIN1"], rev: ["AIN2"] }, B: { fwd: ["BIN1"], rev: ["BIN2"] } },
};

const SUPPLY_PINS = ["VIN", "VM", "V12", "POWER", "B_PLUS", "VMOT"];

export interface PlantOptions {
  /** battery state of charge at the start, 0..1 */
  soc?: number;
  imu?: ImuNoise;
  rng: () => number;
}

export class Plant implements PlantPort, PlantView {
  net: Netlist;
  mcuPinOfNet = new Map<number, number>();
  batteries: { b: Battery; net?: Net }[] = [];
  regs: { r: Regulator; vin?: Net; vout?: Net }[] = [];
  fuses: FuseSlot[] = [];
  chans: Channel[] = [];
  motors: MotorSlot[] = [];
  acts: ActSlot[] = [];
  servos: ServoSlot[] = [];
  i2cDevs = new Map<number, { dev: I2CDevice & { ready?(t: number): boolean }; vcc?: Net; comp: string }>();
  analogSrc = new Map<number, (t: number) => number | undefined>();
  /** OLED panels on the I2C bus, with what they showed over the run */
  displays: Ssd1306[] = [];
  netV = new Map<number, number>();
  /** volts the microcontroller runs from */
  mcuV = 5;
  mcuSupply = "";
  /** amps on the logic rail */
  logicLoad = 0;
  batteryCurrent = 0;
  peakBatteryCurrent = 0;
  events: WorldEvent[] = [];
  notes: string[] = [];
  assumptions: string[] = [];
  unsupported: string[] = [];
  /** seconds of plant time simulated */
  t = 0;
  /** called after every step with the time at its end, seconds */
  afterStep?: (t: number) => void;

  constructor(
    public machine: MachineData,
    public mcu: string,
    public board: Board,
    public hal: SimHal,
    public world: World,
    opts: PlantOptions,
  ) {
    this.net = buildNetlist(machine);
    const ambient = world.thermal().ambient;
    // the microcontroller's pins, by net
    for (const np of this.net.pinsOf.get(mcu) ?? []) {
      const n = this.net.netOf.get(np.key);
      const pin = this.arduinoPin(np.pin.mcu);
      if (n && pin !== undefined) this.mcuPinOfNet.set(n.id, pin);
    }
    // drivers first, so each motor can find the channel that feeds it
    const order = (k: string | undefined) => (k === "motor_driver" ? 0 : 1);
    const comps = [...machine.components].sort((a, b) => order(catalogPart(a.catalogId)?.kind) - order(catalogPart(b.catalogId)?.kind));
    for (const mc of comps) {
      const part = catalogPart(mc.catalogId);
      if (!part || mc.name === mcu) continue;
      if (part.specs.driver === "SSD1306" && part.specs.iface === "i2c") {
        this.display(mc, part);
        continue;
      }
      switch (part.kind) {
        case "battery":
          this.batteries.push({ b: new Battery(mc.name, part, opts.soc ?? 1), net: this.netOf(mc.name, "POS") });
          break;
        case "regulator": {
          const vin = this.netOf(mc.name, "VIN") ?? this.netOf(mc.name, "IN_POS");
          const vout = this.netOf(mc.name, "VOUT") ?? this.netOf(mc.name, "OUT_POS");
          this.regs.push({ r: new Regulator(mc.name, part), vin, vout });
          break;
        }
        case "fuse":
          this.fuses.push({ comp: mc.name, rating: Number(part.specs.rating_a ?? 20), over2: 0, over35: 0, blown: false });
          break;
        case "motor_driver":
          for (const ch of ["A", "B"]) {
            const c = this.channel(mc.name, part, ch);
            if (c) this.chans.push(c);
          }
          break;
        case "gearmotor": {
          const m = new DCMotor(mc.name, part, ambient);
          const { chan, polarity } = this.driverFor(mc.name, "M_PLUS", "M_MINUS");
          this.motors.push({ comp: mc.name, mc, m, chan, polarity, encA: this.mcuPinFor(mc.name, "ENC_A"), encB: this.mcuPinFor(mc.name, "ENC_B"), encVcc: this.netOf(mc.name, "ENC_VCC"), lastA: -1, lastB: -1 });
          break;
        }
        case "actuator": {
          const start = typeof mc.length === "number" ? mc.length : Number(part.specs.stroke ?? 50) / 2;
          const a = new Actuator(mc.name, part, start);
          const { chan, polarity } = this.driverFor(mc.name, "M_PLUS", "M_MINUS");
          const fbPin = this.mcuPinFor(mc.name, "FB");
          this.acts.push({ comp: mc.name, a, chan, polarity, fbPin, fbVcc: this.netOf(mc.name, "FB_VCC") });
          break;
        }
        case "servo": {
          this.servos.push({ comp: mc.name, s: new Servo(mc.name, part), pin: this.mcuPinFor(mc.name, "SIG"), vcc: this.netOf(mc.name, "V_PLUS") });
          break;
        }
        case "sensor":
          this.sensor(mc, part, opts);
          break;
        case "stepper":
        case "stepper_driver":
        case "hotend":
        case "heated_bed":
          this.unsupported.push(`${mc.name} (${part.name})`);
          break;
      }
    }
    // current sense outputs of the drivers
    for (const c of this.chans) {
      const csId = c.ch === "A" ? ["CS", "R_IS", "CS1"] : ["CS2"];
      for (const id of csId) {
        const pin = this.mcuPinFor(c.comp, id);
        if (pin < 0) continue;
        const vpa = Number(c.part.specs.current_sense_v_per_a ?? 0.02);
        const off = Number(c.part.specs.current_sense_offset_v ?? 0);
        // the Pololu G2 senses only while driving: it reads low in the PWM off-time (braking)
        const onlyDriving = c.scheme === "pwm_dir";
        this.analogSrc.set(pin, (t) => {
          if (c.vOut === null || c.shutdown) return 0;
          if (onlyDriving && c.pwmPin >= 0 && hal.pwmLevel(c.pwmPin, t) === 0) return 0;
          return off + vpa * Math.abs(c.current);
        });
      }
    }
    for (const s of this.acts) {
      if (s.fbPin < 0) continue;
      this.analogSrc.set(s.fbPin, () => {
        const vcc = s.fbVcc ? (this.netV.get(s.fbVcc.id) ?? 0) : 0;
        return (s.a.pos / s.a.stroke) * vcc;
      });
    }
    // test signals from the world, onto the analog inputs their nets reach
    for (const d of world.drives?.() ?? []) {
      const dot = d.on.indexOf(".");
      const n = dot > 0 ? this.netOf(d.on.slice(0, dot), d.on.slice(dot + 1)) : this.net.nets.find((x) => x.name === d.on);
      if (!n) {
        this.notes.push(`The signal on ${d.on} goes nowhere: there is no net called ${d.on}${dot > 0 ? " (or that pin is not wired)" : ""}.`);
        continue;
      }
      const pin = this.mcuPinOfNet.get(n.id);
      if (pin === undefined || !this.board.analog.includes(pin)) {
        this.notes.push(`The signal on ${d.on} does not reach an analog input of the ${this.board.name}, so the firmware cannot read it.`);
        continue;
      }
      const fcpu = this.board.fcpu;
      this.analogSrc.set(pin, (t) => d.v(t / fcpu));
    }
    if (this.unsupported.length) this.notes.push(`Not simulated yet (they stay still): ${this.unsupported.join(", ")}.`);
    for (const b of this.batteries) this.assumptions.push(...b.b.assumed);
    for (const m of this.motors) this.assumptions.push(...m.m.assumed);
    hal.plant = this;
    this.updateRails();
  }

  // ---------- netlist helpers ----------

  arduinoPin(mcu: string | undefined): number | undefined {
    if (!mcu) return undefined;
    const m = /^A(\d+)$/.exec(mcu);
    if (m) return this.board.analog[+m[1]];
    const n = Number(mcu);
    return Number.isInteger(n) ? n : undefined;
  }

  netOf(comp: string, pin: string, index = 0): Net | undefined {
    return this.net.netOf.get(`${comp}[${index}].${pin}`);
  }

  /** the MCU pin on the same net as a part's pin, or -1 */
  mcuPinFor(comp: string, pin: string): number {
    const n = this.netOf(comp, pin);
    if (!n) return -1;
    return this.mcuPinOfNet.get(n.id) ?? -1;
  }

  private source(comp: string, part: CatalogPart, id: string): Src {
    const def = part.pins.find((p) => p.id === id);
    const note = def?.note ?? "";
    const dflt = /pulled high|tie(d)? high by default|enabled by default/i.test(note) ? 1 : 0;
    const n = this.netOf(comp, id);
    if (!n) return { kind: "none", def: dflt };
    const pin = this.mcuPinOfNet.get(n.id);
    if (pin !== undefined) return { kind: "mcu", pin };
    if (n.pins.some((p) => p.pin.type === "gnd")) return { kind: "low" };
    if (n.pins.some((p) => p.pin.type === "pwr_out" || p.pin.type === "pwr_rail")) return { kind: "high" };
    return { kind: "none", def: dflt };
  }

  private channel(comp: string, part: CatalogPart, ch: string): Channel | undefined {
    const outs = part.pins.filter((p) => p.type === "motor_out" && (p.channel ?? "A") === ch);
    if (outs.length < 2) return undefined;
    const scheme = String(part.specs.control ?? "pwm_dir");
    const table = SCHEMES[scheme]?.[ch] ?? SCHEMES.pwm_dir.A;
    const src: Record<string, Src[]> = {};
    for (const [role, ids] of Object.entries(table)) {
      const present = ids.filter((id) => part.pins.some((p) => p.id === id));
      src[role] = present.map((id) => this.source(comp, part, id));
    }
    const supplyId = part.pins.find((p) => p.type === "pwr_in" && SUPPLY_PINS.includes(p.id))?.id;
    const pwmPinSrc = src.pwm?.[0];
    return {
      comp,
      part,
      ch,
      scheme,
      src,
      supply: supplyId ? this.netOf(comp, supplyId) : undefined,
      plus: this.net.pinsOf.get(comp)?.find((p) => p.pin.id === outs[0].id),
      minus: this.net.pinsOf.get(comp)?.find((p) => p.pin.id === outs[1].id),
      ilim: Number(part.specs.i_peak ?? 3),
      icont: Number(part.specs.i_cont ?? 1),
      vdrop: Number(part.specs.v_drop ?? 0),
      vOut: null,
      pwmPin: pwmPinSrc?.kind === "mcu" ? pwmPinSrc.pin : -1,
      current: 0,
      supplyCurrent: 0,
      heat: 0,
      shutdown: false,
    };
  }

  /** which driver channel feeds a motor's terminals, and which way round */
  private driverFor(comp: string, plus: string, minus: string): { chan?: Channel; polarity: number } {
    const np = this.netOf(comp, plus);
    const nm = this.netOf(comp, minus);
    for (const c of this.chans) {
      if (!c.plus || !c.minus) continue;
      const a = this.net.netOf.get(c.plus.key);
      const b = this.net.netOf.get(c.minus.key);
      if (a && np && a.id === np.id && b && nm && b.id === nm.id) return { chan: c, polarity: 1 };
      if (a && nm && a.id === nm.id && b && np && b.id === np.id) return { chan: c, polarity: -1 };
    }
    return { polarity: 1 };
  }

  private sensor(mc: MachineComponent, part: CatalogPart, opts: PlantOptions) {
    const iface = String(part.specs.iface ?? "");
    if (iface === "i2c") {
      const sda = this.mcuPinFor(mc.name, "SDA");
      const scl = this.mcuPinFor(mc.name, "SCL");
      if (sda !== this.board.sda || scl !== this.board.scl) {
        if (sda >= 0 || scl >= 0) this.notes.push(`${mc.name}: SDA and SCL must go to ${this.board.name} pins A4 and A5 for Wire; it is not on the bus.`);
        return;
      }
      const addr = parseInt(String(part.specs.i2c_addr ?? "0"), 16);
      const noise = opts.imu ?? { driftPerMin: 0.5, noise: 0.06 };
      const orient = () => this.world.orientation(mc.name);
      const vcc = this.netOf(mc.name, "VIN") ?? this.netOf(mc.name, "VCC");
      if (part.id === "bno055") this.i2cDevs.set(addr, { dev: new Bno055(mc.name, this.board.fcpu, orient, noise, opts.rng), vcc, comp: mc.name });
      else if (part.id === "mpu6050") this.i2cDevs.set(addr, { dev: new Mpu6050(mc.name, orient, noise, opts.rng), vcc, comp: mc.name });
      else this.unsupported.push(`${mc.name} (${part.name})`);
      return;
    }
    if (iface === "analog") {
      const s = this.mcuPinFor(mc.name, "S");
      if (s < 0) return;
      const vin = this.netOf(mc.name, "VCC_IN") ?? this.netOf(mc.name, "PLUS");
      const ratio = Number(part.specs.ratio ?? 5);
      this.analogSrc.set(s, () => (vin ? (this.netV.get(vin.id) ?? 0) / ratio : 0));
      return;
    }
    if (iface === "pulse" && part.id === "hc_sr04") {
      const trig = this.mcuPinFor(mc.name, "TRIG");
      const echo = this.mcuPinFor(mc.name, "ECHO");
      const vcc = this.netOf(mc.name, "VCC");
      if (trig < 0 || echo < 0) return;
      let highAt = -1;
      this.hal.onWrite.set(trig, (level, t) => {
        if (level) {
          highAt = t;
          return;
        }
        if (highAt < 0 || (vcc && (this.netV.get(vcc.id) ?? 0) < 4)) return;
        const us = ((t - highAt) * 1e6) / this.board.fcpu;
        highAt = -1;
        if (us < 9) return;
        const d = this.world.range?.(mc.name) ?? 4000;
        const width = d > 4000 ? 38000 : (2 * d) / 0.343;
        const c = this.board.fcpu / 1e6;
        this.hal.schedulePin(t + 460 * c, echo, 1);
        this.hal.schedulePin(t + (460 + width) * c, echo, 0);
      });
      return;
    }
  }

  private display(mc: MachineComponent, part: CatalogPart) {
    const sda = this.mcuPinFor(mc.name, "SDA");
    const scl = this.mcuPinFor(mc.name, "SCL");
    if (sda !== this.board.sda || scl !== this.board.scl) {
      if (sda >= 0 || scl >= 0) this.notes.push(`${mc.name}: SDA and SCL must go to ${this.board.name} pins A4 and A5 for Wire; it is not on the bus.`);
      return;
    }
    const d = new Ssd1306(mc.name, Number(part.specs.w_px ?? 128), Number(part.specs.h_px ?? 64), this.board.fcpu);
    const said = new Set<string>();
    d.warn = (text) => {
      if (said.has(text)) return;
      said.add(text);
      this.events.push({ t: this.t, kind: "warn", text });
    };
    this.displays.push(d);
    this.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x3C"), 16), { dev: d, vcc: this.netOf(mc.name, "VCC"), comp: mc.name });
  }

  // ---------- PlantPort ----------

  analogVolts(pin: number, t: number): number | undefined {
    if (this.mcuV < 1) return undefined;
    return this.analogSrc.get(pin)?.(t);
  }

  vref(): number {
    return this.mcuV;
  }

  i2c(addr: number): I2CDevice | undefined {
    const d = this.i2cDevs.get(addr);
    if (!d) return undefined;
    if (d.vcc && (this.netV.get(d.vcc.id) ?? 0) < 2.5) return undefined;
    if (d.dev.ready && !d.dev.ready(this.hal.cyc)) return undefined;
    return d.dev;
  }

  // ---------- PlantView ----------

  motor(comp: string) {
    const s = this.motors.find((x) => x.comp === comp);
    return s ? { omega: s.m.omega, angle: s.m.angle, current: s.m.current, torque: s.m.torque } : undefined;
  }

  actuator(comp: string) {
    const s = this.acts.find((x) => x.comp === comp);
    return s ? { pos: s.a.pos, speed: s.a.speed, force: s.a.force } : undefined;
  }

  servo(comp: string) {
    const s = this.servos.find((x) => x.comp === comp);
    return s ? { angle: s.s.angle } : undefined;
  }

  // ---------- stepping ----------

  private level(src: Src): number {
    switch (src.kind) {
      case "mcu": {
        const d = this.hal.drive(src.pin);
        return d < 0 ? 0 : d;
      }
      case "high":
        return 1;
      case "low":
        return 0;
      case "none":
        return src.def;
    }
  }

  private all(list: Src[] | undefined, dflt: number): number {
    if (!list || !list.length) return dflt;
    return list.reduce((m, s) => Math.min(m, this.level(s)), 1);
  }

  /** average output volts of a driver channel (+ drives plus to minus), or null when its outputs are open */
  private command(c: Channel): number | null {
    if (c.shutdown) return null;
    const vs = c.supply ? (this.netV.get(c.supply.id) ?? 0) : 0;
    if (vs < 1) return null;
    const v = Math.max(0, vs - c.vdrop);
    const s = c.src;
    switch (c.scheme) {
      case "pwm_dir": {
        if (this.all(s.en, 1) < 0.5) return null;
        const d = this.all(s.pwm, 0);
        const dir = this.all(s.dir, 0) >= 0.5 ? 1 : -1;
        return dir * d * v;
      }
      case "in1_in2_pwm":
      case "in1_in2_en": {
        if (c.scheme === "in1_in2_pwm" && this.all(s.en, 0) < 0.5) return null;
        const d = this.all(s.pwm, c.scheme === "in1_in2_en" ? 0 : 0);
        const a = this.all(s.in1, 0) >= 0.5;
        const b = this.all(s.in2, 0) >= 0.5;
        if (a && !b) return d * v;
        if (!a && b) return -d * v;
        if (a && b) return 0;
        return c.scheme === "in1_in2_en" && d > 0 ? 0 : null;
      }
      case "rpwm_lpwm":
        if (this.all(s.en, 0) < 0.5) return null;
        return (this.all(s.fwd, 0) - this.all(s.rev, 0)) * v;
      case "in1_in2_pwm_both": {
        const f = this.all(s.fwd, 0);
        const r = this.all(s.rev, 0);
        if (f === 0 && r === 0) return null;
        return (f - r) * v;
      }
    }
    return null;
  }

  private updateRails() {
    this.netV.clear();
    for (const { b, net } of this.batteries) if (net) this.netV.set(net.id, this.fuses.some((f) => f.blown) ? 0 : b.volts());
    // regulators, in order (one may feed another)
    for (let pass = 0; pass < 2; pass++)
      for (const g of this.regs) {
        const vin = g.vin ? (this.netV.get(g.vin.id) ?? 0) : 0;
        if (g.vout) this.netV.set(g.vout.id, g.r.out(vin));
      }
    for (const n of this.net.nets) {
      if (this.netV.has(n.id)) continue;
      if (n.pins.some((p) => p.pin.type === "gnd")) this.netV.set(n.id, 0);
    }
    // the microcontroller: from its 5 V pin, else its VIN through the on-board regulator, else USB
    const v5 = this.netOf(this.mcu, "V5") ?? this.netOf(this.mcu, "5V");
    const vin = this.netOf(this.mcu, "VIN");
    const v5v = v5 ? this.netV.get(v5.id) : undefined;
    const vinv = vin ? this.netV.get(vin.id) : undefined;
    if (v5v !== undefined && v5v > 0.5) {
      this.mcuV = v5v;
      this.mcuSupply = "5 V pin";
    } else if (v5 && this.regs.some((g) => g.vout?.id === v5.id)) {
      // fed by a regulator that has lost its input: the board goes dark with it
      this.mcuV = v5v ?? 0;
      this.mcuSupply = "5 V pin";
    } else if (vinv !== undefined) {
      this.mcuV = vinv >= 7 ? 5 : Math.max(0, vinv - 1.5);
      this.mcuSupply = "VIN";
      if (v5) this.netV.set(v5.id, this.mcuV);
    } else {
      this.mcuV = 5;
      this.mcuSupply = "USB";
      if (v5) this.netV.set(v5.id, 5);
    }
  }

  step(t0: number, t1: number): void {
    const fcpu = this.board.fcpu;
    const dt = (t1 - t0) / fcpu;
    const t = t0 / fcpu;
    this.t = t;
    const { ambient, cooling } = this.world.thermal();
    this.updateRails();
    for (const c of this.chans) {
      c.vOut = this.command(c);
      c.current = 0;
      c.supplyCurrent = 0;
    }
    // motors against the world's loads
    for (const s of this.motors) {
      const v = s.chan ? (s.chan.vOut === null ? null : s.polarity * s.chan.vOut) : null;
      const load = this.world.motorLoad(s.comp) ?? FREE_LOAD;
      const c0 = s.m.counts;
      s.m.step(v, s.chan?.ilim ?? 99, load, dt, ambient, cooling);
      if (s.chan) {
        const i = s.polarity * s.m.current;
        s.chan.current += Math.abs(i);
        const vs = s.chan.supply ? (this.netV.get(s.chan.supply.id) ?? 0) : 0;
        if (s.chan.vOut !== null && vs > 0) s.chan.supplyCurrent += Math.max(0, (s.chan.vOut * i) / vs);
      }
      this.encoder(s, c0, t0, t1);
    }
    for (const s of this.acts) {
      const v = s.chan ? (s.chan.vOut === null ? null : s.polarity * s.chan.vOut) : null;
      s.a.step(v, this.world.actuatorLoad(s.comp), dt);
      if (s.chan) {
        s.chan.current += s.a.current;
        const vs = s.chan.supply ? (this.netV.get(s.chan.supply.id) ?? 0) : 0;
        if (s.chan.vOut !== null && vs > 0) s.chan.supplyCurrent += (Math.abs(s.chan.vOut) / vs) * s.a.current;
      }
    }
    for (const s of this.servos) {
      const powered = s.vcc ? (this.netV.get(s.vcc.id) ?? 0) > 4 : false;
      s.s.step(s.pin >= 0 ? (this.hal.servoUs.get(s.pin) ?? null) : null, this.world.servoLoad?.(s.comp) ?? 0, powered, dt);
    }
    // driver overheating: past its continuous rating for long, it shuts down
    for (const c of this.chans) {
      c.heat += dt * ((c.current / Math.max(0.1, c.icont)) ** 2 - 1) * 0.02;
      if (c.heat < 0) c.heat = 0;
      if (!c.shutdown && c.heat > 1) {
        c.shutdown = true;
        this.events.push({ t, kind: "warn", text: `${c.comp} overheated and shut down (above its ${c.icont} A rating too long)` });
      } else if (c.shutdown && c.heat < 0.5) c.shutdown = false;
    }
    this.world.step(dt, t, this);
    // the battery carries everything
    this.logicLoad = this.logicCurrent();
    for (const g of this.regs) g.r.load = g.vout ? this.railLoad(g.vout) : 0;
    let ib = 0;
    for (const c of this.chans) ib += c.supplyCurrent;
    for (const g of this.regs) ib += g.r.inputCurrent(g.vin ? (this.netV.get(g.vin.id) ?? 0) : 0);
    for (const s of this.servos) if (s.vcc && this.batteries.some((b) => b.net?.id === s.vcc!.id)) ib += s.s.current;
    if (this.fuses.some((f) => f.blown)) ib = 0;
    this.batteryCurrent = ib;
    if (ib > this.peakBatteryCurrent) this.peakBatteryCurrent = ib;
    for (const { b } of this.batteries) b.step(ib / this.batteries.length, dt);
    for (const f of this.fuses) {
      if (f.blown) continue;
      f.over2 = ib > 2 * f.rating ? f.over2 + dt : Math.max(0, f.over2 - dt * 0.2);
      f.over35 = ib > 3.5 * f.rating ? f.over35 + dt : 0;
      if (f.over2 > 2 || f.over35 > 0.2) {
        f.blown = true;
        this.events.push({ t, kind: "warn", text: `Fuse ${f.comp} (${f.rating} A) blew at ${ib.toFixed(1)} A` });
        this.hal.powerFail = `fuse ${f.comp} blew`;
      }
    }
    if (this.mcuV < 4 && this.mcuSupply !== "USB") {
      this.events.push({ t, kind: "warn", text: `The ${this.board.name} browned out: its supply fell to ${this.mcuV.toFixed(1)} V` });
      this.hal.powerFail = "brownout";
    }
    for (const d of this.displays) d.tick(t1);
    this.afterStep?.(t1 / fcpu);
  }

  private encoder(s: MotorSlot, c0: number, t0: number, t1: number) {
    if (s.m.cpr <= 0) return;
    const c1 = s.m.angle * s.m.countsPerRad;
    s.m.counts = c1;
    if (s.encA < 0 && s.encB < 0) return;
    const powered = s.encVcc ? (this.netV.get(s.encVcc.id) ?? 0) > 3 : true;
    if (!powered) {
      if (s.lastA !== -1) {
        if (s.encA >= 0) this.hal.setExternal(s.encA, 1);
        if (s.encB >= 0) this.hal.setExternal(s.encB, 1);
        s.lastA = s.lastB = -1;
      }
      return;
    }
    if (s.lastA < 0) {
      const [a, b] = quadrature(Math.floor(c1));
      if (s.encA >= 0) this.hal.setExternal(s.encA, a);
      if (s.encB >= 0) this.hal.setExternal(s.encB, b);
      s.lastA = a;
      s.lastB = b;
      return;
    }
    const k0 = Math.floor(c0);
    const k1 = Math.floor(c1);
    if (k0 === k1) return;
    const span = c1 - c0;
    const dir = k1 > k0 ? 1 : -1;
    const n = Math.min(64, Math.abs(k1 - k0));
    for (let j = 1; j <= n; j++) {
      // forward: crossing count k; backward: crossing k0 - j + 1 down into k0 - j
      const state = k0 + dir * j;
      const cross = dir > 0 ? state : state + 1;
      const frac = Math.max(0, Math.min(1, (cross - c0) / span));
      const at = Math.round(t0 + frac * (t1 - t0));
      const [a, b] = quadrature(state);
      if (a !== s.lastA && s.encA >= 0) this.hal.schedulePin(at, s.encA, a);
      if (b !== s.lastB && s.encB >= 0) this.hal.schedulePin(at, s.encB, b);
      s.lastA = a;
      s.lastB = b;
    }
  }

  /** current drawn from a rail by everything on it */
  private railLoad(rail: Net): number {
    let i = 0;
    for (const p of rail.pins) {
      if (p.pin.type !== "pwr_in" && !(p.pin.type === "pwr_rail" && p.comp === this.mcu)) continue;
      if (p.comp === this.mcu) i += 0.03;
      else i += p.pin.draw ?? 0.01;
    }
    for (const s of this.servos) if (s.vcc && s.vcc.id === rail.id) i += s.s.current;
    return i;
  }

  private logicCurrent(): number {
    const v5 = this.netOf(this.mcu, "V5") ?? this.netOf(this.mcu, "5V");
    return v5 ? this.railLoad(v5) : 0.03;
  }

  /** numbers for the timeline */
  channels(out: Record<string, number>) {
    for (const s of this.motors) {
      out[`${s.comp}.rpm`] = (s.m.omega * 60) / (2 * Math.PI);
      out[`${s.comp}.amps`] = s.m.current;
      out[`${s.comp}.volts`] = s.m.volts;
      out[`${s.comp}.temp`] = s.m.temp;
      out[`${s.comp}.torque`] = s.m.torque;
      out[`${s.comp}.turns`] = s.m.angle / (2 * Math.PI);
    }
    for (const s of this.acts) {
      out[`${s.comp}.pos`] = s.a.pos;
      out[`${s.comp}.amps`] = s.a.current;
      out[`${s.comp}.force`] = s.a.force;
    }
    for (const s of this.servos) out[`${s.comp}.angle`] = s.s.angle;
    for (const { b } of this.batteries) {
      out[`${b.name}.volts`] = b.volts();
      out[`${b.name}.amps`] = b.current;
      out[`${b.name}.soc`] = b.soc * 100;
    }
    out["logic.volts"] = this.mcuV;
  }
}
