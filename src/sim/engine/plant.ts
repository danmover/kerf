// The electrical and mechanical plant around the microcontroller, built from
// the design's own wiring: the netlist says which pin drives which driver
// input, which encoder reaches which interrupt pin, what each analog pin
// measures and which devices sit on the I2C bus. Each 1 ms step it reads
// the firmware's outputs, drives the motors against the world's loads, and
// feeds the sensors back.

import { buildNetlist, type Net, type NetPin, type Netlist } from "../../machine/erc";
import { catalogPart } from "../../machine/catalog";
import { measuredPart } from "../../machine/measured";
import { coilChain, shuntFacing, shuntSides } from "../../machine/shunts";
import type { CatalogPart, MachineComponent, MachineData } from "../../machine/types";
import type { Board } from "../mcu/board";
import { ADAPTER, Actuator, BENCH_SUPPLY, Battery, Bno055, DCMotor, EscFan, Lsm6dsox, Mpu6050, Nau7802, Pca9685, Regulator, Servo, Ssd1306, Supply, USB_PORT, quadrature, type ImuNoise } from "./devices";
import { BRIDGE_OHMS, CoilLoad, Ina3221, PwmFan, Sdp8xx, Tmag5273, stepCoilString, type ShuntTap } from "./fielddevs";
import { BusServo, ServoBus } from "./busServo";
import { servoBuses } from "../../machine/busServos";
import { Steppers } from "./steppers";
import { Sensing } from "./sensors";
import type { I2CDevice, PlantPort, SimHal } from "./hal";
import { FREE_LOAD, type DriveIO, type PlantView, type World, type WorldEvent } from "../worlds/types";

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

/**
 * Pulses that come from a servo board's output instead of a controller pin are numbered from here: sixteen to a
 * board, in the order the boards come in the design.
 */
export const HUB_PIN = 1000;

interface ServoSlot {
  comp: string;
  s: Servo;
  /** the controller pin its pulse comes from, a servo board's output (HUB_PIN and up), or -1 */
  pin: number;
  /** the signal's net, which a pressed normally-closed switch in it can break */
  sig?: Net;
  vcc?: Net;
}

/** A brushless ESC: where its signal comes from (a controller pin or a servo board's output), its battery feed and the fan it spins. */
export interface EscSlot {
  comp: string;
  part: CatalogPart;
  pin: number;
  sig?: Net;
  vin?: Net;
  fan?: { name: string; part: CatalogPart };
  dev: EscFan;
}

/** An HX711 load cell amplifier on two controller pins, and the bridge on its inputs. */
export interface HxSlot {
  comp: string;
  dout: number;
  sck: number;
  vcc?: Net;
  /** the load cell on channel A, its polarity, rated load (N) and output (mV/V) */
  cell?: string;
  sign: number;
  ratedN: number;
  mvPerV: number;
  /** the bridge's zero offset, counts */
  offset: number;
  period: number;
  nextAt: number;
  ready: boolean;
  pulses: number;
  value: number;
  gain: number;
  highAt: number;
  force: number;
  peak: number;
  samples: number;
  on: boolean;
}

/** The load cell bridge on an amplifier's or ADC's channel A. */
interface BridgeOn {
  /** the load cell, its polarity, rated load (N) and output (mV/V) */
  cell?: string;
  sign: number;
  ratedN: number;
  mvPerV: number;
}

/** A load cell ADC on the I2C bus (an NAU7802) and the bridge on its inputs. */
export interface AdcSlot extends BridgeOn {
  comp: string;
  dev: Nau7802;
  vcc?: Net;
  force: number;
  peak: number;
  on: boolean;
}

/** A PCA9685 servo board: its chip, its logic supply and its output-enable pin. */
export interface HubSlot {
  comp: string;
  dev: Pca9685;
  vcc?: Net;
  oe: Src;
  /** on the controller's I2C bus, whose pull-ups (the board's own go to its logic supply) feed it a little when that supply is cut */
  onBus: boolean;
  /** the other powered devices on the bus: their boards' pull-ups are what feeds it then */
  others?: { vcc?: Net; comp: string }[];
  /** outputs wired back to a controller pin, which then sees their pulses */
  sense: { ch: number; pin: number }[];
}

/** An addressable LED board (or a chain of them) and what it is showing. */
export interface LedSlot {
  comp: string;
  n: number;
  vcc?: Net;
  /** the controller pin whose data reaches it (-1: none) and how many LEDs come before it on that pin */
  pin: number;
  offset: number;
  /** the colour order its chips read the bytes in, like "GRB" */
  order: string;
  /** mA per LED at full white, and dark */
  maPer: number;
  idleMa: number;
  /** 0xRRGGBB shown by each LED */
  colours: number[];
  current: number;
  peak: number;
  seq: number;
  shows: number;
  litTime: number;
  seen: Set<number>;
  orderWarned: boolean;
}

/** A wound coil on a driver channel. */
export interface CoilSlot {
  comp: string;
  part: CatalogPart;
  c: CoilLoad;
  chan?: Channel;
  polarity: number;
  /** the bridge's switches and a current shunt in series with the winding, Ω */
  rPath: number;
  hot: boolean;
  /**
   * Coils wired lead to lead on one driver channel carry one current. `lead` is the first of the string (itself
   * for a coil on its own), which holds the string in `string`; `polarity` is then the way the string's current
   * (from the channel's first output to its second) runs through this coil.
   */
  lead: CoilSlot;
  string?: CoilSlot[];
}

/** A four-wire fan: its supply, and the controller pins its PWM and tacho wires reach (-1: none). */
export interface BlowerSlot {
  comp: string;
  part: CatalogPart;
  f: PwmFan;
  vin?: Net;
  pwm: number;
  tach: number;
  /** tacho edges sent so far, and whether its PWM rate has been remarked on */
  edges: number;
  said: boolean;
}

interface RegSlot {
  r: Regulator;
  /** the part the regulator is, or is in */
  comp: string;
  vin?: Net;
  vout?: Net;
}

interface FuseSlot {
  comp: string;
  net?: Net;
  /**
   * What sits after this fuse, when other fuses share its net (one fuse for each branch off the same supply):
   * the pins and parts it feeds, so each fuse carries its own branch and not the whole supply.
   */
  side?: { keys: Set<string>; comps: Set<string> };
  rating: number;
  /** the most it carried, A */
  peak: number;
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
  /** mains supplies, plug-in adapters and a bench supply, with the nets they feed */
  supplies: { s: Supply; nets: Net[] }[] = [];
  /** the controller's USB port, which powers it when nothing in the wiring does */
  usb = new Supply("USB", 5, 0.5, 0.3, USB_PORT);
  regs: RegSlot[] = [];
  /** regulators fed by another regulator first, so the one feeding them carries their load */
  private regOrder: RegSlot[] = [];
  fuses: FuseSlot[] = [];
  chans: Channel[] = [];
  motors: MotorSlot[] = [];
  acts: ActSlot[] = [];
  servos: ServoSlot[] = [];
  /** smart-servo buses, one for each adapter */
  buses: ServoBus[] = [];
  /** parts whose model reports all they draw, standby included: their supply pin's catalog draw is not added again */
  private selfDrawn = new Set<string>();
  leds: LedSlot[] = [];
  escs: EscSlot[] = [];
  hxs: HxSlot[] = [];
  coils: CoilSlot[] = [];
  blowers: BlowerSlot[] = [];
  /** steppers on StepStick drivers, and distance and temperature sensors */
  steppers = new Steppers(this);
  sensing = new Sensing(this);
  /** current monitors, field sensors and pressure sensors on the I2C bus, for the run's results */
  shuntMonitors: { comp: string; dev: Ina3221; part: CatalogPart }[] = [];
  fieldSensors: { comp: string; dev: Tmag5273 }[] = [];
  gauges: { comp: string; dev: Sdp8xx }[] = [];
  adcs: AdcSlot[] = [];
  hubs: HubSlot[] = [];
  /** signal nets broken by a pressed normally-closed switch, or by a switch unplugged */
  cut = new Set<number>();
  /** switches whose normally-closed contacts are open */
  private opened = new Set<string>();
  /** parts cut off from every supply on a net by an open contact, as "net|part" */
  private dead = new Set<string>();
  /** hall switches: the pin each pulls low while the world puts a magnet near it */
  halls: { comp: string; pin: number; vcc?: Net; level: number; hits: number }[] = [];
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
  private rng: () => number;
  private mcuPart?: CatalogPart;

  constructor(
    public machine: MachineData,
    public mcu: string,
    public board: Board,
    public hal: SimHal,
    public world: World,
    opts: PlantOptions,
  ) {
    this.net = buildNetlist(machine);
    this.rng = opts.rng;
    const mcuComp = machine.components.find((c) => c.name === mcu);
    this.mcuPart = mcuComp ? measuredPart(mcuComp) : undefined;
    const ambient = world.thermal().ambient;
    // a bench supply stands in for the design's own batteries and supplies, where they connect
    const bench = world.supply?.();
    const benchNets: (Net | undefined)[] = [];
    const replaced: string[] = [];
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
      const part = measuredPart(mc);
      if (!part || mc.name === mcu) continue;
      if (part.specs.driver === "SSD1306" && part.specs.iface === "i2c") {
        this.display(mc, part);
        continue;
      }
      switch (part.kind) {
        case "battery":
          if (bench) {
            benchNets.push(this.netOf(mc.name, "POS"));
            replaced.push(mc.name);
            break;
          }
          this.batteries.push({ b: new Battery(mc.name, part, opts.soc ?? 1), net: this.netOf(mc.name, "POS") });
          break;
        case "psu": {
          // a mains supply or plug-in adapter: its positive outputs are live for the whole run
          const model = part.sim?.k === "supply" ? part.sim : undefined;
          const outs = part.pins.filter((p) => p.type === "pwr_out" || p.id === model?.pos);
          const nets = [...new Set(outs.map((p) => this.netOf(mc.name, p.id)).filter((n): n is Net => !!n))];
          if (bench) {
            benchNets.push(...nets);
            replaced.push(mc.name);
            break;
          }
          const v = Number(part.specs.v_out ?? model?.v ?? outs[0]?.v ?? 12);
          const i = Number(part.specs.i_out ?? outs[0]?.imax ?? 2);
          this.supplies.push({ s: new Supply(mc.name, v, i, model?.r ?? 0.02, ADAPTER), nets });
          this.assumptions.push(`${mc.name}: plugged in and switched on for the whole run, ${v} V up to ${i} A; past about ${Math.round(ADAPTER.trip * 100)} % of that it cuts out and tries again a second later`);
          break;
        }
        case "regulator": {
          const vin = this.netOf(mc.name, "VIN") ?? this.netOf(mc.name, "IN_POS");
          const vout = this.netOf(mc.name, "VOUT") ?? this.netOf(mc.name, "OUT_POS");
          this.regs.push({ r: new Regulator(mc.name, part), comp: mc.name, vin, vout });
          break;
        }
        case "fuse":
          // the fuse fitted (rating:), else the one the holder comes with
          this.fuses.push({ comp: mc.name, net: this.netOf(mc.name, "IN") ?? this.netOf(mc.name, "OUT"), rating: Number(mc.rating ?? part.specs.rating_a ?? 20), peak: 0, over2: 0, over35: 0, blown: false });
          break;
        case "motor_driver":
          if (part.specs.driver === "PCA9685") {
            this.hub(mc, part);
            break;
          }
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
          // a smart servo takes packets on its bus, not a pulse on a pin
          const smart = part.specs.bus === "feetech_sts";
          if (smart) this.selfDrawn.add(mc.name);
          this.servos.push({ comp: mc.name, s: smart ? new BusServo(mc.name, part) : new Servo(mc.name, part), pin: smart ? -1 : this.signalPin(mc.name, "SIG"), sig: this.netOf(mc.name, "SIG"), vcc: this.netOf(mc.name, "V_PLUS") });
          break;
        }
        case "esc":
          this.esc(mc, part);
          break;
        case "coil": {
          // which driver channel it is on (alone or in a string) is found once every part is in place (bindCoils)
          const slot = { comp: mc.name, part, c: new CoilLoad(mc.name, part, ambient), polarity: 1, rPath: 0, hot: false } as CoilSlot;
          slot.lead = slot;
          this.coils.push(slot);
          break;
        }
        case "fan":
          if (part.specs.iface === "pwm_fan") {
            const pwm = this.mcuPinFor(mc.name, "PWM");
            this.blowers.push({ comp: mc.name, part, f: new PwmFan(mc.name, part), vin: this.netOf(mc.name, "V12") ?? this.netOf(mc.name, "VIN"), pwm, tach: this.mcuPinFor(mc.name, "TACH"), edges: 0, said: false });
            if (pwm < 0) this.assumptions.push(`${mc.name}: its PWM wire reaches no ${this.board.name} pin, so it runs flat out whenever it has power`);
          }
          break;
        case "sensor":
          this.sensor(mc, part, opts);
          break;
        case "led": {
          const n = Number(part.specs.leds ?? 1);
          this.leds.push({ comp: mc.name, n, vcc: this.netOf(mc.name, "V5"), pin: -1, offset: 0, order: String(part.specs.order ?? "GRB"), maPer: Number(part.specs.ma_per_led ?? 60), idleMa: Number(part.specs.idle_ma ?? 1), colours: new Array<number>(n).fill(0), current: 0, peak: 0, seq: 0, shows: 0, litTime: 0, seen: new Set(), orderWarned: false });
          break;
        }
        case "bldc":
          // spun by its ESC (the ESC's slot finds it through the phase wires)
          break;
        case "stepper_driver":
          this.steppers.driver(mc, part);
          break;
        case "stepper":
          this.steppers.motor(mc, part, ambient);
          break;
        case "hotend":
        case "heated_bed":
          this.unsupported.push(`${mc.name} (${part.name})`);
          break;
      }
    }
    // smart servos: each adapter's chain is a bus on the controller's UART pins, numbered in the order it is wired
    for (const b of servoBuses(machine)) {
      const bus = new ServoBus(b.adapter);
      for (const m of b.servos) {
        const dev = this.servos.find((x) => x.comp === m.comp)?.s;
        if (!(dev instanceof BusServo)) continue;
        dev.id = m.id;
        dev.mem[5] = m.id;
        bus.servos.push(dev);
      }
      const tx = this.mcuPinFor(b.adapter, "TX");
      const rx = this.mcuPinFor(b.adapter, "RX");
      if (tx >= 0) hal.attachUart(tx, rx, bus);
      else this.notes.push(`${b.adapter} hears nothing: wire its TX pin to a transmit pin of the ${this.board.name}.`);
      if (rx < 0) this.notes.push(`${b.adapter} cannot answer: wire its RX pin to a receive pin of the ${this.board.name}.`);
      this.buses.push(bus);
    }
    this.fuseBranches();
    // the data line to each LED board: straight from a controller pin, or on from the board before it in a chain
    for (let pass = 0; pass < this.leds.length; pass++)
      for (const l of this.leds) {
        if (l.pin >= 0) continue;
        const din = this.netOf(l.comp, "DIN");
        if (!din) continue;
        const pin = this.mcuPinOfNet.get(din.id);
        if (pin !== undefined) {
          l.pin = pin;
          continue;
        }
        const up = this.leds.find((u) => u !== l && u.pin >= 0 && this.netOf(u.comp, "DOUT")?.id === din.id);
        if (up) {
          l.pin = up.pin;
          l.offset = up.offset + up.n;
        }
      }
    this.bindCoils();
    this.bindShunts();
    for (const c of this.coils) this.assumptions.push(...c.c.assumed);
    for (const l of this.leds) if (l.pin < 0) this.notes.push(`${l.comp} gets no data: wire its DIN to a ${this.board.name} pin, or to the DOUT of the board before it in the chain.`);
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
        return (s.a.pos / s.a.stroke) * this.volts(s.fbVcc, s.comp);
      });
    }
    // test signals from the world, onto the analog inputs their nets reach
    for (const d of world.drives?.() ?? []) {
      const n = this.netByName(d.on);
      if (!n) {
        this.notes.push(`The signal on ${d.on} goes nowhere: there is no net called ${d.on}${d.on.includes(".") ? " (or that pin is not wired)" : ""}.`);
        continue;
      }
      const pin = this.mcuPinOfNet.get(n.id);
      if (pin === undefined || !(this.board.adcPins ?? this.board.analog).includes(pin)) {
        this.notes.push(`The signal on ${d.on} does not reach an analog input of the ${this.board.name}, so the firmware cannot read it.`);
        continue;
      }
      const fcpu = this.board.fcpu;
      this.analogSrc.set(pin, (t) => d.v(t / fcpu));
    }
    if (bench) {
      const on = bench.on ? this.netByName(bench.on) : undefined;
      const nets = [...new Set(bench.on ? (on ? [on] : []) : benchNets.filter((n): n is Net => !!n))];
      if (!nets.length)
        this.notes.push(
          bench.on
            ? `The bench supply goes nowhere: there is no net called ${bench.on}${bench.on.includes(".") ? " (or that pin is not wired)" : ""}.`
            : "The bench supply has nowhere to clip on: the design has no wired battery or power supply. Say where with sim.supply(on: \"NET\").",
        );
      else {
        this.supplies.push({ s: new Supply("bench_supply", bench.volts, bench.amps, 0.01, BENCH_SUPPLY), nets });
        const where = bench.on ?? (replaced.length ? `where ${listOf(replaced)} connect${replaced.length > 1 ? "" : "s"}` : "");
        this.assumptions.push(`Powered from a bench supply at ${bench.volts} V with its current limit at ${bench.amps} A, clipped on ${where}${bench.on && replaced.length ? `, with ${listOf(replaced)} left out` : ""}`);
      }
    }
    // a regulator's depth down a chain of regulators
    const depth = (g: RegSlot, n = 0): number => {
      const up = n < this.regs.length ? this.regs.find((u) => u !== g && u.vout && g.vin && u.vout.id === g.vin.id) : undefined;
      return up ? 1 + depth(up, n + 1) : 0;
    };
    this.regOrder = [...this.regs].sort((a, b) => depth(b) - depth(a));
    for (const mc of machine.components)
      if (catalogPart(mc.catalogId)?.kind === "bldc" && !this.escs.some((e) => e.fan?.name === mc.name)) this.unsupported.push(`${mc.name} (no ESC drives all three of its phase wires)`);
    if (this.unsupported.length) this.notes.push(`Not simulated yet (they stay still): ${this.unsupported.join(", ")}.`);
    for (const b of this.batteries) this.assumptions.push(...b.b.assumed);
    for (const m of this.motors) this.assumptions.push(...m.m.assumed);
    for (const e of this.escs) if (e.fan) this.assumptions.push(...e.dev.assumed);
    for (const mc of machine.components) if (mc.measured) this.assumptions.push(`${mc.name}: measured on the real part (${Object.entries(mc.measured).map(([k, v]) => `${k} ${Number(v.toPrecision(3))}`).join(", ")}), in place of the catalog's numbers`);
    // the board's own battery divider (the Feather's BATT_MONITOR): the LiPo on BAT, else the charger's output,
    // which sits near its 4.2 V float voltage while USB or the 5 V pin feeds it with no cell plugged in
    const bm = this.board.battMonitor;
    if (bm && !this.analogSrc.has(bm.pin)) {
      const bat = this.netOf(this.mcu, "BAT");
      this.analogSrc.set(bm.pin, () => {
        const v = bat ? this.netV.get(bat.id) : undefined;
        if (v !== undefined && v > 0.5) return v / bm.ratio;
        return this.mcuSupply === "BAT" ? 0 : 4.2 / bm.ratio;
      });
    }
    hal.plant = this;
    this.updateRails();
    this.steppers.bind();
    this.powerHubs(0);
    if (this.mcuSupply === "USB") this.assumptions.push(`Nothing in the wiring powers ${mcu}, so it runs from its USB port: 5 V, with its 500 mA polyfuse`);
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

  /** a net by its name, or by "component.PIN" on it */
  netByName(on: string): Net | undefined {
    const dot = on.indexOf(".");
    return dot > 0 ? this.netOf(on.slice(0, dot), on.slice(dot + 1)) : this.net.nets.find((x) => x.name === on);
  }

  /** the MCU pin on the same net as a part's pin, or -1 */
  mcuPinFor(comp: string, pin: string): number {
    const n = this.netOf(comp, pin);
    if (!n) return -1;
    return this.mcuPinOfNet.get(n.id) ?? -1;
  }

  /**
   * Where a servo's or an ESC's pulse comes from: the controller pin on its signal's net, else a servo board's
   * output on it (HUB_PIN and up), else -1.
   */
  private signalPin(comp: string, pin: string): number {
    const direct = this.mcuPinFor(comp, pin);
    if (direct >= 0) return direct;
    const n = this.netOf(comp, pin);
    if (!n) return -1;
    for (let h = 0; h < this.hubs.length; h++) {
      const out = n.pins.find((p) => p.comp === this.hubs[h].comp && /^P\d+$/.test(p.pin.id));
      if (out) return HUB_PIN + 16 * h + Number(out.pin.id.slice(1));
    }
    return -1;
  }

  /** volts a part sees on a net: nothing when an open contact has cut it off from the net's supplies */
  volts(net: Net | undefined, comp: string): number {
    if (!net) return 0;
    if (this.dead.size && this.dead.has(`${net.id}|${comp}`)) return 0;
    return this.netV.get(net.id) ?? 0;
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
    if (this.sensing.attach(mc, part, opts.rng)) return;
    const iface = String(part.specs.iface ?? "");
    if (iface === "i2c") {
      const sda = this.mcuPinFor(mc.name, "SDA");
      const scl = this.mcuPinFor(mc.name, "SCL");
      if (sda !== this.board.sda || scl !== this.board.scl) {
        if (sda >= 0 || scl >= 0) this.notes.push(`${mc.name}: SDA and SCL must go to ${this.board.name} pins ${this.i2cPins()} for Wire; it is not on the bus.`);
        return;
      }
      const addr = parseInt(String(part.specs.i2c_addr ?? "0"), 16);
      const noise = opts.imu ?? { driftPerMin: 0.5, noise: 0.06 };
      const orient = () => this.world.orientation(mc.name);
      const vcc = this.netOf(mc.name, "VIN") ?? this.netOf(mc.name, "VCC");
      if (part.id === "bno055") this.i2cDevs.set(addr, { dev: new Bno055(mc.name, this.board.fcpu, orient, noise, opts.rng), vcc, comp: mc.name });
      else if (part.id === "mpu6050") this.i2cDevs.set(addr, { dev: new Mpu6050(mc.name, orient, noise, opts.rng), vcc, comp: mc.name });
      else if (part.id === "lsm6dsox_breakout") this.i2cDevs.set(addr, { dev: new Lsm6dsox(mc.name, this.board.fcpu, orient, { driftPerMin: 0.3, noise: 0.05 }, opts.rng, mc.axes), vcc, comp: mc.name });
      else if (part.specs.chip === "INA3221") {
        // what each channel measures is found once every part is in place (bindShunts)
        const taps: (() => ShuntTap | undefined)[] = [() => undefined, () => undefined, () => undefined];
        const dev = new Ina3221(mc.name, this.board.fcpu, Number(part.specs.shunt_ohm ?? 0.1), [0, 1, 2].map((k) => () => taps[k]()), opts.rng);
        this.shuntTaps.set(mc.name, taps);
        this.shuntMonitors.push({ comp: mc.name, dev, part });
        this.i2cDevs.set(addr, { dev, vcc, comp: mc.name });
      } else if (/^TMAG5273/.test(String(part.specs.chip ?? ""))) {
        const dev = new Tmag5273(mc.name, this.board.fcpu, part, () => this.world.field?.(mc.name), () => this.world.thermal().ambient + 2, opts.rng);
        this.fieldSensors.push({ comp: mc.name, dev });
        this.i2cDevs.set(addr, { dev, vcc, comp: mc.name });
      } else if (/^SDP8/.test(String(part.specs.chip ?? ""))) {
        const dev = new Sdp8xx(mc.name, this.board.fcpu, part, () => this.world.pressure?.(mc.name) ?? 0, () => this.world.thermal().ambient, opts.rng);
        this.gauges.push({ comp: mc.name, dev });
        this.i2cDevs.set(addr, { dev, vcc: vcc ?? this.netOf(mc.name, "VDD"), comp: mc.name });
      } else if (part.specs.chip === "NAU7802") {
        const slot: AdcSlot = { comp: mc.name, dev: undefined as unknown as Nau7802, vcc, ...this.bridgeOn(mc.name), force: 0, peak: 0, on: true };
        if (!slot.cell) this.notes.push(`${mc.name} has no load cell on A+ and A-: it reads only its own offset and noise.`);
        const ratio = () => {
          const f = slot.cell ? (this.world.force?.(slot.cell) ?? 0) : 0;
          slot.force = f;
          if (Math.abs(f) > slot.peak) slot.peak = Math.abs(f);
          return slot.cell ? (slot.sign * slot.mvPerV * 1e-3 * f) / slot.ratedN : 0;
        };
        slot.dev = new Nau7802(mc.name, this.board.fcpu, ratio, (opts.rng() - 0.5) * 2 * 0.05e-3, opts.rng);
        this.adcs.push(slot);
        this.i2cDevs.set(addr, { dev: slot.dev, vcc, comp: mc.name });
      } else this.unsupported.push(`${mc.name} (${part.name})`);
      return;
    }
    if (iface === "hx711") {
      this.hx711(mc, part, opts);
      return;
    }
    if (iface === "analog") {
      const s = this.mcuPinFor(mc.name, "S");
      if (s < 0) return;
      const vin = this.netOf(mc.name, "VCC_IN") ?? this.netOf(mc.name, "PLUS");
      const ratio = Number(part.specs.ratio ?? 5);
      this.analogSrc.set(s, () => this.volts(vin, mc.name) / ratio);
      return;
    }
    if (iface === "joystick") {
      // a thumb stick at rest: both wipers at half its supply (a scenario's sim.signal moves them)
      const vcc = this.netOf(mc.name, "VCC");
      for (const axis of ["VRX", "VRY"]) {
        const pin = this.mcuPinFor(mc.name, axis);
        if (pin >= 0) this.analogSrc.set(pin, () => this.volts(vcc, mc.name) / 2);
      }
      return;
    }
    if (iface === "hall") {
      const pin = this.mcuPinFor(mc.name, "S");
      if (pin >= 0) this.halls.push({ comp: mc.name, pin, vcc: this.netOf(mc.name, "VCC"), level: -1, hits: 0 });
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
        if (highAt < 0 || (vcc && this.volts(vcc, mc.name) < 4)) return;
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

  private shuntTaps = new Map<string, (() => ShuntTap | undefined)[]>();

  /**
   * Which driver channel each coil is on. A channel's two outputs may have one coil between them or several
   * wired lead to lead, which then share one current.
   */
  private bindCoils() {
    if (!this.coils.length) return;
    const names = this.coils.map((c) => c.comp);
    for (const chan of this.chans) {
      if (!chan.plus || !chan.minus) continue;
      const chain = coilChain(this.net, chan.plus.key, chan.minus.key, names);
      if (!chain) continue;
      const slots = chain.map((m) => {
        const slot = this.coils.find((c) => c.comp === m.comp)!;
        slot.chan = chan;
        slot.polarity = m.sign;
        return slot;
      });
      const lead = slots[0];
      for (const slot of slots) slot.lead = lead;
      lead.string = slots;
      lead.rPath = Number(chan.part.specs.r_on ?? BRIDGE_OHMS[chan.part.id] ?? 0);
      if (slots.length > 1) this.notes.push(`${slots.map((x) => x.comp).join(", ")} are wired in series on one driver output and carry one current.`);
    }
    for (const c of this.coils) if (!c.chan) this.notes.push(`${c.comp} is on no driver output: wire its START and END to one driver channel's two outputs (a current shunt, or another coil in series, may sit between).`);
  }

  /**
   * Which coil or motor each current monitor channel sits in series with, and which way round. A shunt joins
   * the two nets it is wired between into one, so the wires themselves say which terminal faces the load: a
   * reading is positive when the load's current (in at its + terminal, out at its −) runs from the channel's +
   * to its −.
   */
  private bindShunts() {
    for (const { comp, part } of this.shuntMonitors) {
      const taps = this.shuntTaps.get(comp)!;
      const shunt = Number(part.specs.shunt_ohm ?? 0.1);
      for (let ch = 0; ch < 3; ch++) {
        const net = this.netOf(comp, `CH${ch + 1}P`);
        const other = this.netOf(comp, `CH${ch + 1}N`);
        if (!net || !other) continue;
        const sides = shuntSides(this.net, comp, ch + 1);
        const facing = (load: string) => shuntFacing(sides, load);
        // the node's own voltage: the bridge output it joins is switched high for the share of the time it drives
        const node = (v: number | null, atMinus: boolean) => (v === null ? 0 : Math.max(0, atMinus ? -v : v));
        let bound = false;
        for (const s of this.coils) {
          const f = facing(s.comp);
          if (!f) continue;
          s.lead.rPath += shunt;
          taps[ch] = () => ({ amps: f.sign * s.c.current, ripple: s.c.ripple, pwmHz: s.c.pwmHz, bus: node(s.chan && s.chan.vOut !== null ? s.polarity * s.chan.vOut : null, f.atMinus) });
          bound = true;
          break;
        }
        if (bound) continue;
        for (const s of this.motors) {
          const f = facing(s.comp);
          if (!f) continue;
          taps[ch] = () => ({ amps: f.sign * s.m.current, ripple: 0, pwmHz: 0, bus: node(s.chan && s.chan.vOut !== null ? s.polarity * s.chan.vOut : null, f.atMinus) });
          bound = true;
          break;
        }
        if (!bound) this.notes.push(`${comp} channel ${ch + 1} is in series with nothing the simulation models as a load (a coil or a DC motor), so it reads zero.`);
      }
    }
  }

  /** the PWM rate a driver channel is being switched at now, Hz (0: held steadily on or off) */
  private chanPwmHz(c: Channel): number {
    for (const list of Object.values(c.src))
      for (const src of list) if (src.kind === "mcu" && this.hal.duty[src.pin] >= 0) return this.hal.pwmHz(src.pin);
    return 0;
  }

  /** the board's Wire pins, as its pinout names them */
  private i2cPins() {
    return this.board.arch === "esp32" ? `GPIO${this.board.sda} (SDA) and GPIO${this.board.scl} (SCL)` : "A4 and A5";
  }

  /** a brushless ESC, its BEC as a regulator, and the motor on its three phase wires */
  private esc(mc: MachineComponent, part: CatalogPart) {
    const phases = part.pins.filter((p) => p.type === "motor_out").map((p) => this.netOf(mc.name, p.id));
    let fan: EscSlot["fan"];
    for (const other of this.machine.components) {
      const op = measuredPart(other);
      if (!op || op.kind !== "bldc") continue;
      const mine = op.pins.filter((p) => p.type === "motor").map((p) => this.netOf(other.name, p.id)?.id);
      if (mine.length >= 3 && mine.every((id) => id !== undefined && phases.some((n) => n?.id === id))) fan = { name: other.name, part: op };
    }
    const sig = this.netOf(mc.name, "SIG");
    const slot: EscSlot = { comp: mc.name, part, pin: this.signalPin(mc.name, "SIG"), sig, vin: this.netOf(mc.name, "B_PLUS"), fan, dev: new EscFan(fan?.name ?? mc.name, part, fan?.part) };
    this.escs.push(slot);
    if (!fan) this.notes.push(`${mc.name} spins nothing: wire its three phase leads to a brushless motor's.`);
    if (slot.pin < 0) this.notes.push(`${mc.name}'s signal comes from no ${this.board.name} pin${this.hubs.length ? " or servo board output" : ""}, so it never arms.`);
    const bec = this.netOf(mc.name, "BEC_5V");
    if (bec) this.regs.push({ r: new Regulator(`${mc.name} BEC`, part), comp: mc.name, vin: slot.vin, vout: bec });
  }

  /** a PCA9685 servo board: on the bus when its SDA and SCL reach the controller's */
  private hub(mc: MachineComponent, part: CatalogPart) {
    const sda = this.mcuPinFor(mc.name, "SDA");
    const scl = this.mcuPinFor(mc.name, "SCL");
    const onBus = sda === this.board.sda && scl === this.board.scl;
    const sense: HubSlot["sense"] = [];
    for (let ch = 0; ch < 16; ch++) {
      const pin = this.mcuPinFor(mc.name, `P${ch}`);
      if (pin >= 0) sense.push({ ch, pin });
    }
    const slot: HubSlot = { comp: mc.name, dev: new Pca9685(mc.name, this.board.fcpu, part), vcc: this.netOf(mc.name, "VCC"), oe: this.source(mc.name, part, "OE"), onBus, sense };
    this.hubs.push(slot);
    if (!onBus) {
      this.notes.push(`${mc.name}: SDA and SCL must go to ${this.board.name} pins ${this.i2cPins()} for Wire; it is not on the bus, so its outputs never start.`);
      return;
    }
    // no supply net here: the chip says itself whether it can answer (it does, asleep, on the pull-ups alone)
    this.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x40"), 16), { dev: slot.dev, comp: mc.name });
    this.assumptions.push(
      `${mc.name}: with its logic supply cut while another board on the I2C bus still has power, it is taken to stay alive on the bus's pull-ups, asleep with every output off and its settings gone, still answering; a real board may go silent instead, so the firmware should handle both`,
    );
  }

  /** each servo board's supply and output enable, and its outputs' frame clock, for the step from cycle t to t1 */
  private powerHubs(t: number, t1 = t) {
    for (const h of this.hubs) {
      // With its own supply cut the chip can only live on what the bus's pull-ups pass, and those belong to the
      // other boards on the bus (or, with none, to the controller): all of them unpowered and it is dead.
      h.others ??= [...this.i2cDevs.values()].filter((d) => d.vcc && d.comp !== h.comp);
      const fed = h.others.length ? h.others.some((d) => this.volts(d.vcc, d.comp) >= 2.5) : this.mcuV > 2.5;
      h.dev.power(this.volts(h.vcc, h.comp), h.onBus && fed);
      h.dev.oe = this.level(h.oe) >= 0.5;
      h.dev.tick(t);
      // an output wired back to a controller pin: the pin sees each edge at its own moment
      for (const l of h.sense) {
        const held = h.dev.held(l.ch);
        if (held >= 0) this.hal.setExternal(l.pin, held);
        else for (const [at, level] of h.dev.edges(l.ch, t, t1)) this.hal.schedulePin(at, l.pin, level);
      }
    }
  }

  /** the load cell bridge wired to an amplifier's channel A (A+, A- and the excitation E+) */
  private bridgeOn(comp: string): BridgeOn {
    const ap = this.netOf(comp, "A_PLUS");
    const am = this.netOf(comp, "A_MINUS");
    const ep = this.netOf(comp, "E_PLUS");
    const out: BridgeOn = { sign: 1, ratedN: 4.9, mvPerV: 1 };
    for (const other of this.machine.components) {
      const cp = measuredPart(other);
      if (!cp || cp.specs.iface !== "bridge") continue;
      const sp = this.netOf(other.name, "SIG_P");
      const sn = this.netOf(other.name, "SIG_N");
      const ex = this.netOf(other.name, "EXC_P");
      if (!sp || !sn || !ap || !am) continue;
      const straight = sp.id === ap.id && sn.id === am.id;
      const crossed = sp.id === am.id && sn.id === ap.id;
      if (!straight && !crossed) continue;
      if (!ex || !ep || ex.id !== ep.id) {
        this.notes.push(`${other.name}'s excitation (red, E+) is not on ${comp}'s E+: the bridge gives no signal.`);
        continue;
      }
      out.cell = other.name;
      out.sign = straight ? 1 : -1;
      out.ratedN = (Number(cp.specs.capacity_g ?? 500) / 1000) * 9.80665;
      out.mvPerV = Number(cp.specs.rated_mv_per_v ?? 1);
    }
    return out;
  }

  /** an HX711 on DOUT and SCK, reading the load cell bridge on its channel A */
  private hx711(mc: MachineComponent, part: CatalogPart, opts: PlantOptions) {
    const dout = this.mcuPinFor(mc.name, "DOUT");
    const sck = this.mcuPinFor(mc.name, "SCK");
    if (dout < 0 || sck < 0) {
      this.notes.push(`${mc.name}: wire DOUT and SCK to ${this.board.name} pins to read it.`);
      return;
    }
    const { cell, sign, ratedN, mvPerV } = this.bridgeOn(mc.name);
    if (!cell) this.notes.push(`${mc.name} has no load cell on A+ and A-: it reads only its own offset and noise.`);
    const rate = Number(part.specs.rate_sps ?? 10);
    const fcpu = this.board.fcpu;
    const h: HxSlot = {
      comp: mc.name,
      dout,
      sck,
      vcc: this.netOf(mc.name, "VCC"),
      cell,
      sign,
      ratedN,
      mvPerV,
      offset: (opts.rng() - 0.5) * 2 * 0.05e-3 * 128 * 2 ** 24,
      period: fcpu / rate,
      // the first sample after power-up settles for four sample times
      nextAt: (4 * fcpu) / rate,
      ready: false,
      pulses: 0,
      value: 0,
      gain: 128,
      highAt: -1,
      force: 0,
      peak: 0,
      samples: 0,
      on: true,
    };
    this.hxs.push(h);
    this.hal.setExternal(dout, 1);
    this.hal.onWrite.set(sck, (level, t) => {
      if (!h.on) return;
      if (level) {
        h.highAt = t;
        // each rising edge shifts out the next bit, most significant first; from the 25th DOUT goes high
        if (!h.ready && h.pulses < 25) return;
        h.pulses++;
        this.hal.setExternal(dout, h.pulses <= 24 ? (h.value >> (24 - h.pulses)) & 1 : 1);
        return;
      }
      // held high over 60 µs: the chip powered down, and settles again once SCK comes low
      if (h.highAt >= 0 && t - h.highAt > 60e-6 * fcpu) {
        h.ready = false;
        h.pulses = 0;
        h.nextAt = t + 4 * h.period;
        this.hal.setExternal(dout, 1);
        return;
      }
      if (h.pulses >= 25) {
        // 25, 26 or 27 pulses choose channel A at 128, B at 32 or A at 64 for the next sample
        h.gain = h.pulses === 26 ? 32 : h.pulses === 27 ? 64 : 128;
        h.ready = false;
      }
    });
  }

  /** what an HX711 puts out for a sample now, 24-bit two's complement */
  private hxSample(h: HxSlot, rng: () => number) {
    const f = h.cell ? (this.world.force?.(h.cell) ?? 0) : 0;
    h.force = f;
    if (Math.abs(f) > h.peak) h.peak = Math.abs(f);
    const bridge = h.cell && h.gain !== 32 ? (h.sign * h.mvPerV * 1e-3 * f) / h.ratedN : 0;
    const code = (bridge * h.gain * 2 ** 24) + h.offset * (h.gain / 128) + (rng() + rng() - 1) * 40;
    h.value = Math.max(-(2 ** 23), Math.min(2 ** 23 - 1, Math.round(code))) & 0xffffff;
  }

  private stepHx(t1: number, rng: () => number) {
    for (const h of this.hxs) {
      const powered = h.on && this.volts(h.vcc, h.comp) > 2.6;
      if (!powered) {
        // an unpowered chip holds DOUT low: a sketch waiting for a sample reads zeros
        h.ready = false;
        h.pulses = 0;
        this.hal.setExternal(h.dout, 0);
        h.nextAt = Math.max(h.nextAt, t1 + 4 * h.period);
        continue;
      }
      if (t1 < h.nextAt) continue;
      h.nextAt += h.period * Math.max(1, Math.floor((t1 - h.nextAt) / h.period) + 1);
      // a sample being clocked out is not overwritten
      if (h.ready && h.pulses > 0 && h.pulses < 25) continue;
      h.pulses = 0;
      this.hxSample(h, rng);
      h.samples++;
      h.ready = true;
      this.hal.setExternal(h.dout, 0);
    }
  }

  /**
   * A switch held pressed: its normally-closed contacts break the net through them, and its normally-open ones
   * pull the controller pin on one side to whatever is on the other (ground or a supply). Undefined when it
   * does neither here.
   */
  press(comp: string): (() => void) | undefined {
    const mc = this.machine.components.find((c) => c.name === comp);
    const part = mc ? measuredPart(mc) : undefined;
    if (part?.specs.iface === "joystick") {
      // pressing a thumb stick down closes its SW contact to its GND
      const pin = this.mcuPinFor(comp, "SW");
      if (pin < 0) return undefined;
      const was = this.hal.ext[pin];
      this.hal.setExternal(pin, 0);
      return () => this.hal.setExternal(pin, was);
    }
    if (!part || part.kind !== "switch") return undefined;
    const undos: (() => void)[] = [];
    const opened = this.openContacts(comp, part.pins.filter((p) => p.through).map((p) => p.id));
    if (opened) undos.push(opened);
    const open = part.pins.filter((p) => p.type === "passive" && !p.through).map((p) => this.netOf(comp, p.id));
    if (open.length >= 2)
      open.forEach((a, i) => {
        const pin = a ? this.mcuPinOfNet.get(a.id) : undefined;
        if (pin === undefined) return;
        const others = open.filter((_, j) => j !== i);
        const level = others.some((o) => o?.pins.some((x) => x.pin.type === "gnd")) ? 0 : others.some((o) => o && (this.netV.get(o.id) ?? 0) > 2) ? 1 : -1;
        if (level < 0) return;
        const was = this.hal.ext[pin];
        this.hal.setExternal(pin, level);
        undos.push(() => this.hal.setExternal(pin, was));
      });
    if (!undos.length) return undefined;
    return () => undos.reverse().forEach((u) => u());
  }

  /**
   * Open a switch's normally-closed contacts, at the pins given (all of them when pressed, one when a lead comes
   * off). On a net with a supply, the parts the wiring reaches only through those contacts lose it and the rest
   * keep it; a net with none (a signal) is broken whole. Returns how to close them again, or undefined when
   * nothing ran through them.
   */
  openContacts(comp: string, pins: string[]): (() => void) | undefined {
    const undos: (() => void)[] = [];
    let supplied = false;
    for (const id of pins) {
      const n = this.netOf(comp, id);
      if (!n) continue;
      if (n.pins.some(feeds)) supplied = true;
      else if (!this.cut.has(n.id)) {
        this.cut.add(n.id);
        undos.push(() => this.cut.delete(n.id));
      }
    }
    if (supplied && !this.opened.has(comp)) {
      this.opened.add(comp);
      this.findDead();
      undos.push(() => {
        this.opened.delete(comp);
        this.findDead();
      });
    }
    if (!undos.length) return undefined;
    return () => undos.reverse().forEach((u) => u());
  }

  /** which parts each open contact has cut off: those the wiring no longer reaches from any supply on their net */
  private findDead() {
    this.dead.clear();
    for (const n of this.net.nets) {
      if (!n.pins.some((p) => p.pin.through && this.opened.has(p.comp))) continue;
      const reached = new Set<string>(n.pins.filter(feeds).map((p) => p.key));
      if (!reached.size) continue;
      const next = new Map<string, string[]>();
      const link = (a: string, b: string) => {
        next.set(a, [...(next.get(a) ?? []), b]);
        next.set(b, [...(next.get(b) ?? []), a]);
      };
      for (const sg of n.segs) link(sg.a.key, sg.b.key);
      // every other fuse, switch and connector on the net still conducts
      for (const p of n.pins) if (p.pin.type === "passive" && p.pin.through && !this.opened.has(p.comp)) link(p.key, `${p.comp}[${p.index}].${p.pin.through}`);
      const todo = [...reached];
      for (let k = todo.pop(); k !== undefined; k = todo.pop())
        for (const o of next.get(k) ?? [])
          if (!reached.has(o)) {
            reached.add(o);
            todo.push(o);
          }
      const fed = new Set(n.pins.filter((p) => reached.has(p.key)).map((p) => p.comp));
      for (const p of n.pins) if (!fed.has(p.comp)) this.dead.add(`${n.id}|${p.comp}`);
    }
  }

  /** a signal pulse that reaches a device: none when its wire is broken */
  private pulse(pin: number, sig: Net | undefined): number | null {
    if (pin < 0 || (sig && this.cut.has(sig.id))) return null;
    if (pin >= HUB_PIN) return this.hubs[(pin - HUB_PIN) >> 4]?.dev.pulseUs((pin - HUB_PIN) & 15) ?? null;
    return this.hal.servoUs.get(pin) ?? null;
  }

  private display(mc: MachineComponent, part: CatalogPart) {
    const sda = this.mcuPinFor(mc.name, "SDA");
    const scl = this.mcuPinFor(mc.name, "SCL");
    if (sda !== this.board.sda || scl !== this.board.scl) {
      if (sda >= 0 || scl >= 0) this.notes.push(`${mc.name}: SDA and SCL must go to ${this.board.name} pins ${this.i2cPins()} for Wire; it is not on the bus.`);
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
    if (d.vcc && this.volts(d.vcc, d.comp) < 2.5) return undefined;
    if (d.dev.ready && !d.dev.ready(this.hal.cyc)) return undefined;
    return d.dev;
  }

  // ---------- PlantView ----------

  motor(comp: string) {
    const s = this.motors.find((x) => x.comp === comp);
    return s ? { omega: s.m.omega, angle: s.m.angle, current: s.m.current, torque: s.m.torque } : this.steppers.view(comp);
  }

  actuator(comp: string) {
    const s = this.acts.find((x) => x.comp === comp);
    return s ? { pos: s.a.pos, speed: s.a.speed, force: s.a.force } : undefined;
  }

  servo(comp: string) {
    const s = this.servos.find((x) => x.comp === comp);
    return s ? { angle: s.s.angle } : undefined;
  }

  /** what each driver puts on its motor, actuator or servo this step, for a world that moves them itself */
  driveIO(): DriveIO[] {
    const out: DriveIO[] = [];
    for (const s of this.motors) out.push({ comp: s.comp, kind: "motor", v: s.chan ? (s.chan.vOut === null ? null : s.polarity * s.chan.vOut) : null, ilim: s.chan?.ilim ?? 99, us: null, powered: true, dev: s.m });
    for (const s of this.acts) out.push({ comp: s.comp, kind: "actuator", v: s.chan ? (s.chan.vOut === null ? null : s.polarity * s.chan.vOut) : null, ilim: s.chan?.ilim ?? 99, us: null, powered: true, dev: s.a });
    for (const s of this.servos) {
      const powered = this.volts(s.vcc, s.comp) > 4;
      out.push({ comp: s.comp, kind: "servo", v: null, ilim: 0, us: this.pulse(s.pin, s.sig), powered, dev: s.s });
    }
    for (const e of this.escs) if (e.fan) out.push({ comp: e.fan.name, kind: "fan", v: null, ilim: 0, us: null, powered: e.dev.armed, dev: e.dev });
    for (const s of this.coils) out.push({ comp: s.comp, kind: "coil", v: s.c.volts, ilim: s.chan?.ilim ?? 99, us: null, powered: true, dev: s.c });
    for (const b of this.blowers) out.push({ comp: b.comp, kind: "blower", v: null, ilim: 0, us: null, powered: b.f.rpm > 0, dev: b.f });
    return out;
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
    const vs = this.volts(c.supply, c.comp);
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
    // a blown fuse cuts the net it sits on
    const blown = new Set(this.fuses.filter((f) => f.blown && f.net).map((f) => f.net!.id));
    const live = (n: Net) => !blown.has(n.id) && !this.cut.has(n.id);
    for (const { b, net } of this.batteries) if (net && live(net)) this.netV.set(net.id, b.volts());
    for (const { s, nets } of this.supplies) for (const n of nets) if (live(n)) this.netV.set(n.id, Math.max(this.netV.get(n.id) ?? 0, s.volts()));
    // regulators, in order (one may feed another)
    for (let pass = 0; pass < 2; pass++)
      for (const g of this.regs) {
        const vin = this.volts(g.vin, g.comp);
        if (g.vout && live(g.vout)) this.netV.set(g.vout.id, g.r.out(vin));
      }
    for (const n of this.net.nets) {
      if (this.netV.has(n.id)) continue;
      if (n.pins.some((p) => p.pin.type === "gnd")) this.netV.set(n.id, 0);
    }
    // the microcontroller: from its 5 V pin, else its VIN through the on-board regulator, else USB
    const v5 = this.netOf(this.mcu, "V5") ?? this.netOf(this.mcu, "5V");
    const vin = this.netOf(this.mcu, "VIN");
    // (a rail an open contact has cut the controller off from is as good as not there)
    const at = (n: Net | undefined) => (n && this.netV.has(n.id) ? this.volts(n, this.mcu) : undefined);
    const v5v = at(v5);
    const vinv = at(vin);
    const bat = this.netOf(this.mcu, "BAT");
    const batv = at(bat);
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
    } else if (batv !== undefined && batv > 0.5) {
      // a LiPo on the battery pin, through the board's regulator
      this.mcuV = batv;
      this.mcuSupply = "BAT";
    } else {
      this.mcuV = this.usb.volts();
      this.mcuSupply = "USB";
      if (v5) this.netV.set(v5.id, this.mcuV);
    }
    // the board's own regulated outputs (3.3 V) while it has power; a switched one (the STEMMA QT socket) follows
    // its enable pin, which the core turns on at start-up
    const gate = Number(this.mcuPart?.specs.qt_power_pin ?? NaN);
    for (const np of this.net.pinsOf.get(this.mcu) ?? []) {
      if (np.pin.type !== "pwr_out") continue;
      const n = this.net.netOf.get(np.key);
      if (!n || (this.netV.get(n.id) ?? 0) > 0.5 || !live(n)) continue;
      const v = np.pin.v ?? 3.3;
      const off = /^QT/.test(np.pin.id) && Number.isInteger(gate) && this.hal.drive(gate) === 0;
      this.netV.set(n.id, off ? 0 : this.mcuV >= v + 0.25 ? v : Math.max(0, this.mcuV - 0.25));
    }
  }

  step(t0: number, t1: number): void {
    const fcpu = this.board.fcpu;
    const dt = (t1 - t0) / fcpu;
    const t = t0 / fcpu;
    this.t = t;
    const { ambient, cooling } = this.world.thermal();
    this.updateRails();
    this.powerHubs(t0, t1);
    for (const c of this.chans) {
      c.vOut = this.command(c);
      c.current = 0;
      c.supplyCurrent = 0;
    }
    // ESCs and their fans, ahead of the mechanism so it pushes with this step's thrust
    for (const e of this.escs) {
      e.dev.step(e.fan ? this.pulse(e.pin, e.sig) : null, this.volts(e.vin, e.comp), dt, t);
      for (const text of e.dev.said.splice(0)) this.events.push({ t, kind: /lost|stopped/.test(text) ? "warn" : "info", text });
    }
    // coils and PWM fans too: the world works out this step's magnetic forces and air speed from them
    for (const s of this.coils) {
      if (s.lead === s) {
        // one current through the whole string, + from the channel's first output to its second
        const c = s.chan;
        const string = s.string ?? [s];
        const vs = c?.supply ? (this.netV.get(c.supply.id) ?? 0) : 0;
        const v = c ? c.vOut : null;
        let emf = 0;
        for (const m of string) emf += m.polarity * (this.world.coilEmf?.(m.comp) ?? 0);
        const i = stepCoilString(string.map((m) => ({ c: m.c, sign: m.polarity })), v, vs, s.rPath, emf, c?.ilim ?? 99, c ? this.chanPwmHz(c) : 0, dt, ambient, cooling);
        if (c) {
          c.current += Math.abs(i);
          if (v !== null && vs > 0) c.supplyCurrent += Math.max(0, (v * i) / vs);
        }
      }
      if (!s.hot && s.c.temp > s.c.tempMax) {
        s.hot = true;
        this.events.push({ t, kind: "warn", text: `${s.comp} passed ${s.c.tempMax} °C: its enamel and a printed bobbin will not last at that. It is carrying ${Math.abs(s.c.current).toFixed(2)} A` });
      }
    }
    for (const b of this.blowers) this.stepBlower(b, t0, t1, dt, t);
    // a world that simulates the machine's mechanism moves its motors itself
    const moved = this.world.couple?.(this.driveIO(), dt, t);
    // motors against the world's loads
    for (const s of this.motors) {
      const v = s.chan ? (s.chan.vOut === null ? null : s.polarity * s.chan.vOut) : null;
      const c0 = s.m.counts;
      const mv = moved?.get(s.comp);
      if (mv) s.m.follow(v, s.chan?.ilim ?? 99, mv.speed, dt, ambient, cooling);
      else s.m.step(v, s.chan?.ilim ?? 99, this.world.motorLoad(s.comp) ?? FREE_LOAD, dt, ambient, cooling);
      if (s.chan) {
        const i = s.polarity * s.m.current;
        s.chan.current += Math.abs(i);
        const vs = this.volts(s.chan.supply, s.chan.comp);
        if (s.chan.vOut !== null && vs > 0) s.chan.supplyCurrent += Math.max(0, (s.chan.vOut * i) / vs);
      }
      this.encoder(s, c0, t0, t1);
    }
    for (const s of this.acts) {
      const v = s.chan ? (s.chan.vOut === null ? null : s.polarity * s.chan.vOut) : null;
      const mv = moved?.get(s.comp);
      if (mv) s.a.follow(v, mv.pos, mv.speed, mv.load, dt);
      else s.a.step(v, this.world.actuatorLoad(s.comp), dt);
      if (s.chan) {
        s.chan.current += s.a.current;
        const vs = this.volts(s.chan.supply, s.chan.comp);
        if (s.chan.vOut !== null && vs > 0) s.chan.supplyCurrent += (Math.abs(s.chan.vOut) / vs) * s.a.current;
      }
    }
    for (const s of this.servos) {
      const powered = this.volts(s.vcc, s.comp) > 4;
      const us = this.pulse(s.pin, s.sig);
      const mv = moved?.get(s.comp);
      if (s.s instanceof BusServo) s.s.tick(dt, powered, s.vcc ? (this.netV.get(s.vcc.id) ?? 0) : 0);
      if (mv) s.s.follow(us, mv.pos, mv.load, powered);
      else s.s.step(us, this.world.servoLoad?.(s.comp) ?? 0, powered, dt);
    }
    this.steppers.step(t0, t1, dt, t, ambient, cooling);
    this.stepLeds(t, dt);
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
    this.stepHx(t1, this.rng);
    for (const a of this.adcs) a.dev.tick(t1, a.on && this.volts(a.vcc, a.comp) > 2.6);
    for (const h of this.halls) {
      const powered = this.volts(h.vcc, h.comp) > 4;
      // open collector with the module's pull-up: low while a magnet is near, and low unpowered
      const level = powered && !this.world.magnet?.(h.comp) ? 1 : 0;
      if (level === h.level) continue;
      if (level === 0 && h.level === 1) h.hits++;
      h.level = level;
      this.hal.setExternal(h.pin, level);
    }
    // the batteries and supplies carry everything on the nets they feed
    this.logicLoad = this.logicCurrent();
    const draw = this.netDraws();
    // sources on the same net share its load
    const sources = new Map<number, number>();
    for (const n of [...this.batteries.map((b) => b.net), ...this.supplies.flatMap((s) => s.nets)]) if (n) sources.set(n.id, (sources.get(n.id) ?? 0) + 1);
    const onNet = (n: Net) => ((this.netV.get(n.id) ?? 0) > 0.5 ? this.staticDraw(n) + (draw.get(n.id) ?? 0) : 0);
    const carried = (n: Net) => onNet(n) / (sources.get(n.id) ?? 1);
    let ib = 0;
    for (const { b, net } of this.batteries) {
      const i = net ? carried(net) : 0;
      b.step(i, dt);
      ib += i;
    }
    this.batteryCurrent = ib;
    if (ib > this.peakBatteryCurrent) this.peakBatteryCurrent = ib;
    for (const { s, nets } of this.supplies) {
      const said = s.step(nets.reduce((a, n) => a + carried(n), 0), dt);
      if (said) this.events.push({ t, kind: "warn", text: said });
    }
    if (this.mcuSupply === "USB") {
      const said = this.usb.step(this.logicLoad, dt);
      if (said) this.events.push({ t, kind: "warn", text: `The ${this.board.name}'s ${said}` });
    }
    for (const f of this.fuses) {
      if (f.blown) continue;
      const i = f.side && f.net ? this.branchDraw(f.net, f.side) : f.net ? onNet(f.net) : ib;
      if (i > f.peak) f.peak = i;
      f.over2 = i > 2 * f.rating ? f.over2 + dt : Math.max(0, f.over2 - dt * 0.2);
      f.over35 = i > 3.5 * f.rating ? f.over35 + dt : 0;
      if (f.over2 > 2 || f.over35 > 0.2) {
        f.blown = true;
        this.events.push({ t, kind: "warn", text: `Fuse ${f.comp} (${f.rating} A) blew at ${i.toFixed(1)} A` });
        this.hal.powerFail = `fuse ${f.comp} blew`;
      }
    }
    if (this.mcuV < (this.board.logicV < 4 ? 3.4 : 4)) {
      this.events.push({ t, kind: "warn", text: `The ${this.board.name} browned out: its supply fell to ${this.mcuV.toFixed(1)} V` });
      this.hal.powerFail = "brownout";
    }
    for (const d of this.displays) d.tick(t1);
    this.afterStep?.(t1 / fcpu);
  }

  /** a four-wire fan follows its PWM wire and sends its tacho pulses, each edge at its own moment */
  private stepBlower(b: BlowerSlot, t0: number, t1: number, dt: number, t: number) {
    const volts = b.vin ? (this.netV.get(b.vin.id) ?? 0) : 0;
    const duty = b.pwm >= 0 ? this.hal.drive(b.pwm) : -1;
    if (!b.said && b.pwm >= 0 && this.hal.duty[b.pwm] >= 0) {
      const hz = this.hal.pwmHz(b.pwm);
      if (hz < b.f.pwmHz * 0.6 || hz > b.f.pwmHz * 1.4) {
        b.said = true;
        this.events.push({ t, kind: "warn", text: `${b.comp}'s PWM wire is switched at ${hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`}; a four-wire fan expects about ${(b.f.pwmHz / 1000).toFixed(0)} kHz and may run unevenly or whine. On an ESP32 set it with ledcAttach(pin, ${b.f.pwmHz}, 8)` });
      }
    }
    const turns0 = b.f.turns;
    b.f.step(duty, volts, dt);
    if (b.tach < 0 || b.f.ppr <= 0) return;
    // open collector: low for half of each pulse, released (the input's pull-up takes it high) for the other half
    const e0 = turns0 * b.f.ppr * 2;
    const e1 = b.f.turns * b.f.ppr * 2;
    const k1 = Math.floor(e1);
    const n = Math.min(64, k1 - Math.floor(e0));
    for (let j = 1; j <= n; j++) {
      const edge = Math.floor(e0) + j;
      const frac = Math.max(0, Math.min(1, (edge - e0) / (e1 - e0)));
      this.hal.schedulePin(Math.round(t0 + frac * (t1 - t0)), b.tach, edge % 2 === 1 ? 0 : -1);
      b.edges++;
    }
  }

  private encoder(s: MotorSlot, c0: number, t0: number, t1: number) {
    if (s.m.cpr <= 0) return;
    const c1 = s.m.angle * s.m.countsPerRad;
    s.m.counts = c1;
    if (s.encA < 0 && s.encB < 0) return;
    const powered = s.encVcc ? this.volts(s.encVcc, s.comp) > 3 : true;
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

  /**
   * LED boards take the latest frame on their data pin (their share of it, after the boards before them in the
   * chain), read in their own colour order, and draw current for what they show. Unpowered, they go dark.
   */
  private stepLeds(t: number, dt: number) {
    for (const l of this.leds) {
      const powered = this.volts(l.vcc, l.comp) > 3.5;
      if (!powered) l.colours.fill(0);
      const f = l.pin >= 0 ? this.hal.pixelFrames.get(l.pin) : undefined;
      if (f && f.seq !== l.seq) {
        l.seq = f.seq;
        if (powered) {
          l.shows++;
          // the bytes go out in the firmware's NEO_* order and the chips read them in their own
          const off = [(f.type >> 4) & 3, (f.type >> 2) & 3, f.type & 3];
          const phys = l.order.toUpperCase();
          const swapped = ["R", "G", "B"].some((ch, k) => phys.indexOf(ch) !== off[k]);
          if (swapped && !l.orderWarned) {
            l.orderWarned = true;
            const sent = ["R", "G", "B"].sort((a, b) => off["RGB".indexOf(a)] - off["RGB".indexOf(b)]).join("");
            this.events.push({ t, kind: "warn", text: `${l.comp}'s chips read colours as ${phys} but the firmware sends NEO_${sent}: its colours come out swapped` });
          }
          for (let i = 0; i < l.n; i++) {
            const c = f.colours[l.offset + i];
            if (c === undefined) continue;
            const logical = [(c >>> 16) & 255, (c >>> 8) & 255, c & 255];
            const bytes = [0, 0, 0];
            for (let k = 0; k < 3; k++) bytes[off[k]] = logical[k];
            const rgb = [bytes[phys.indexOf("R")] ?? 0, bytes[phys.indexOf("G")] ?? 0, bytes[phys.indexOf("B")] ?? 0];
            l.colours[i] = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
          }
        }
      }
      let sum = 0;
      let lit = false;
      for (const c of l.colours) {
        sum += ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
        if (c) lit = true;
      }
      if (lit) l.litTime += dt;
      if (lit && l.seen.size < 64) for (const c of l.colours) if (c) l.seen.add(c);
      l.current = powered ? (l.n * l.idleMa + (sum / 255) * (l.maPer / 3)) / 1000 : 0;
      if (l.current > l.peak) l.peak = l.current;
    }
  }

  /**
   * Fuses that share a net each protect a branch of it (an arm each, say). Work out what each one feeds: the
   * pins reached from its far side without going back through it, the far side being the one no supply is on.
   */
  private fuseBranches() {
    const byNet = new Map<number, FuseSlot[]>();
    for (const f of this.fuses) if (f.net) byNet.set(f.net.id, [...(byNet.get(f.net.id) ?? []), f]);
    for (const fs of byNet.values()) {
      if (fs.length < 2) continue;
      const n = fs[0].net!;
      // pin to pin: the wire runs, and across each closed switch, fuse or connector
      const next = new Map<string, string[]>();
      const link = (a: string, b: string) => {
        next.set(a, [...(next.get(a) ?? []), b]);
        next.set(b, [...(next.get(b) ?? []), a]);
      };
      for (const sg of n.segs) link(sg.a.key, sg.b.key);
      const byKey = new Map(n.pins.map((p) => [p.key, p]));
      for (const p of n.pins) {
        if (p.pin.type !== "passive" || !p.pin.through) continue;
        const o = n.pins.find((q) => q.comp === p.comp && q.index === p.index && q.pin.id === p.pin.through);
        if (o && p.key < o.key) link(p.key, o.key);
      }
      const source = (p: NetPin) => (p.part.kind === "battery" || p.part.kind === "psu" || p.part.kind === "regulator") && p.pin.type !== "gnd" && p.pin.type !== "pwr_in";
      for (const f of fs) {
        const own = n.pins.filter((p) => p.comp === f.comp && p.pin.type === "passive");
        if (own.length !== 2) continue;
        const reach = (from: NetPin) => {
          const seen = new Set([from.key]);
          const todo = [from.key];
          while (todo.length) {
            const k = todo.pop()!;
            for (const q of next.get(k) ?? []) {
              // not back through this fuse
              if (seen.has(q) || (byKey.get(k)?.comp === f.comp && byKey.get(q)?.comp === f.comp)) continue;
              seen.add(q);
              todo.push(q);
            }
          }
          return seen;
        };
        const sides = own.map(reach);
        const fed = sides.map((s) => [...s].some((k) => source(byKey.get(k)!)));
        // a branch has the supply on one side only; a fuse in a loop, or with no supply in sight, carries the whole net
        if (fed[0] === fed[1] || sides[0].has(own[1].key)) continue;
        const keys = sides[fed[0] ? 1 : 0];
        f.side = { keys, comps: new Set([...keys].map((k) => byKey.get(k)!.comp)) };
      }
    }
  }

  /** current through a fuse that feeds one branch of its net: what the parts after it draw, A */
  private branchDraw(n: Net, side: { keys: Set<string>; comps: Set<string> }): number {
    const v = this.netV.get(n.id) ?? 0;
    if (v <= 0.5) return 0;
    const on = (net: Net | undefined, comp: string) => net?.id === n.id && side.comps.has(comp);
    let i = this.staticDraw(n, side.keys);
    for (const c of this.chans) if (on(c.supply, c.comp)) i += c.supplyCurrent;
    for (const e of this.escs) if (on(e.vin, e.comp)) i += e.dev.current;
    for (const s of this.servos) if (on(s.vcc, s.comp)) i += s.s.current;
    for (const l of this.leds) if (on(l.vcc, l.comp)) i += l.current;
    if (this.mcuSupply === "VIN" && on(this.netOf(this.mcu, "VIN"), this.mcu)) i += this.logicLoad;
    for (const g of this.regs) if (on(g.vin, g.r.name)) i += g.r.inputCurrent(v);
    return i;
  }

  /** what the parts on a net draw just by being powered, A (`only`: just these pins of it) */
  private staticDraw(rail: Net, only?: Set<string>): number {
    let i = 0;
    for (const p of rail.pins) {
      if (only && !only.has(p.key)) continue;
      if (this.selfDrawn.has(p.comp)) continue;
      if (p.comp === this.mcu) {
        // the controller counts once, on the pin it runs from: VIN's share is in logicLoad
        if (p.pin.id !== "VIN" && (p.pin.type === "pwr_rail" || p.pin.type === "pwr_in")) i += 0.03;
      } else if (p.pin.type === "pwr_in" && p.part.kind !== "led" && p.part.specs.iface !== "pwm_fan" && !(this.dead.size && this.dead.has(`${rail.id}|${p.comp}`))) i += p.pin.draw ?? 0.01;
    }
    return i;
  }

  /** current drawn from a rail by everything on it */
  private railLoad(rail: Net): number {
    let i = this.staticDraw(rail);
    for (const s of this.servos) if (s.vcc && s.vcc.id === rail.id) i += s.s.current;
    for (const l of this.leds) if (l.vcc && l.vcc.id === rail.id) i += l.current;
    return i;
  }

  /**
   * Current drawn out of each net this step beyond what its parts draw by being powered: motor drivers,
   * servos, the controller through its own regulator, and regulators down the chain.
   */
  private netDraws(): Map<number, number> {
    const d = new Map<number, number>();
    const add = (n: Net | undefined, a: number) => {
      if (n && a > 0) d.set(n.id, (d.get(n.id) ?? 0) + a);
    };
    for (const c of this.chans) add(c.supply, c.supplyCurrent);
    for (const e of this.escs) add(e.vin, e.dev.current);
    for (const s of this.servos) add(s.vcc, s.s.current);
    for (const l of this.leds) add(l.vcc, l.current);
    for (const b of this.blowers) add(b.vin, b.f.current);
    this.steppers.draw(add);
    if (this.mcuSupply === "VIN") add(this.netOf(this.mcu, "VIN"), this.logicLoad);
    for (const g of this.regOrder) {
      g.r.load = g.vout ? this.staticDraw(g.vout) + (d.get(g.vout.id) ?? 0) : 0;
      add(g.vin, g.r.inputCurrent(this.volts(g.vin, g.comp)));
    }
    return d;
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
    for (const s of this.servos) {
      out[`${s.comp}.angle`] = s.s.angle;
      if (s.s instanceof BusServo) {
        out[`${s.comp}.amps`] = s.s.current;
        out[`${s.comp}.load`] = s.s.load;
        out[`${s.comp}.temp`] = s.s.temp;
      }
    }
    for (const e of this.escs) {
      out[`${e.comp}.amps`] = e.dev.current;
      out[`${e.comp}.throttle`] = e.dev.throttle * 100;
      out[`${e.comp}.armed`] = e.dev.armed ? 1 : 0;
      if (!e.fan) continue;
      out[`${e.fan.name}.rpm`] = (e.dev.omega * 60) / (2 * Math.PI);
      out[`${e.fan.name}.thrust`] = e.dev.thrust;
      out[`${e.fan.name}.amps`] = e.dev.motorCurrent;
    }
    for (const h of [...this.hxs, ...this.adcs]) if (h.cell) out[`${h.cell}.force`] = h.force;
    for (const s of this.coils) {
      out[`${s.comp}.amps`] = s.c.current;
      out[`${s.comp}.volts`] = s.c.volts;
      out[`${s.comp}.temp`] = s.c.temp;
      out[`${s.comp}.ripple`] = s.c.ripple;
    }
    for (const b of this.blowers) {
      out[`${b.comp}.rpm`] = b.f.rpm;
      out[`${b.comp}.amps`] = b.f.current;
    }
    for (const g of this.gauges) out[`${g.comp}.pressure`] = this.world.pressure?.(g.comp) ?? 0;
    for (const f of this.fieldSensors) {
      const b = this.world.field?.(f.comp)?.b;
      if (!b) continue;
      out[`${f.comp}.bx`] = b[0] * 1000;
      out[`${f.comp}.by`] = b[1] * 1000;
      out[`${f.comp}.bz`] = b[2] * 1000;
    }
    // each LED's colour as 0xRRGGBB, for the playback to light it
    for (const l of this.leds) {
      out[`${l.comp}.amps`] = l.current;
      l.colours.forEach((c, i) => (out[`${l.comp}.led${i}`] = c));
    }
    for (const { b } of this.batteries) {
      out[`${b.name}.volts`] = b.volts();
      out[`${b.name}.amps`] = b.current;
      out[`${b.name}.soc`] = b.soc * 100;
    }
    for (const { s } of this.supplies) {
      out[`${s.name}.volts`] = s.volts();
      out[`${s.name}.amps`] = s.current;
    }
    if (this.mcuSupply === "USB") out["usb.amps"] = this.usb.current;
    out["logic.volts"] = this.mcuV;
    this.steppers.channels(out);
    this.sensing.channels(out);
  }
}

/** What the coils, fans and field, current and pressure sensors did over a run, for the scenario's expectations. */
export function fieldResults(plant: Plant): Record<string, number | boolean | string> {
  const r: Record<string, number | boolean | string> = {};
  for (const s of plant.coils) {
    r[`${s.comp}.amps`] = s.c.current;
    r[`${s.comp}.peak_amps`] = s.c.peakCurrent;
    r[`${s.comp}.max_temp`] = s.c.maxTemp;
    r[`${s.comp}.heat`] = s.c.energy;
  }
  for (const b of plant.blowers) {
    r[`${b.comp}.rpm`] = b.f.rpm;
    r[`${b.comp}.max_rpm`] = b.f.maxRpm;
    r[`${b.comp}.peak_amps`] = b.f.peakCurrent;
    r[`${b.comp}.tach_edges`] = b.edges;
  }
  for (const f of plant.fieldSensors) {
    r[`${f.comp}.samples`] = f.dev.samples;
    r[`${f.comp}.clipped`] = f.dev.clipped;
  }
  for (const m of plant.shuntMonitors) r[`${m.comp}.reads`] = m.dev.reads;
  for (const g of plant.gauges) {
    r[`${g.comp}.reads`] = g.dev.reads;
    r[`${g.comp}.pressure`] = g.dev.last;
  }
  Object.assign(r, plant.steppers.results(), plant.sensing.results());
  return r;
}

/** a pin that puts power on its net */
const feeds = (p: NetPin) => p.pin.type === "pwr_out" || p.pin.type === "pwr_rail";

const listOf = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "");
