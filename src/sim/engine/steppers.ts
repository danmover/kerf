// Steppers on StepStick drivers (A4988, DRV8825, TMC2209) run by the firmware, outside a printer simulation.
// Each rising edge on the driver's STEP pin moves the electrical angle it commands one microstep, the way DIR
// says at that moment. The rotor follows that angle through the motor's torque-angle curve against its load
// and inertia, so a step rate or a start the motor cannot keep up with makes it slip whole electrical cycles
// (four full steps each) and fall behind, as a real one does, and the firmware's count no longer says where
// the shaft is. The driver holds the phase current it is set to until the winding's inductance stops it: above
// the corner speed V/(2·L·I) the torque falls as 1/speed (the motor picker's and the printer simulation's
// model). It stops driving below its minimum supply, without its logic supply or with EN high, and shuts down
// when it runs hot past its continuous rating; the windings heat with their copper loss.

import type { Net } from "../../machine/erc";
import { driverCurrent, driverMicrosteps, fullSteps } from "../../machine/stepstick";
import type { CatalogPart, MachineComponent } from "../../machine/types";
import type { MotorLoad, World } from "../worlds/types";
import type { Plant } from "./plant";

const num = (p: CatalogPart, key: string, fallback: number): number => {
  const v = p.specs[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
};

/** the driver's bridge switches in one phase's current path (high side plus low side, typical), Ω */
const R_ON: Record<string, number> = { a4988: 0.75, drv8825: 0.4, tmc2209: 0.34 };
/** rotor inertia by NEMA frame when the catalog gives none, g·cm² */
const ROTOR_J: Record<number, number> = { 8: 2, 11: 9, 14: 20, 17: 54, 23: 300, 34: 1400 };
/** the bench's load spread across its three runs (worlds/bench.ts) */
const SPREAD: Record<string, number> = { pessimistic: 1.3, expected: 1, optimistic: 0.7 };
/** pull-out torque at low speed as a share of the holding torque at that current */
const PULL_OUT = 0.85;
/** detent torque, a share of the holding torque, with four detents an electrical cycle */
const DETENT = 0.04;
/** damping of the rotor's ringing while it is locked to the field (it settles in a few tens of ms after a step) */
const ZETA = 0.1;
/** iron and bearing losses, N·m per rad/s for each N·m of holding torque: about 15 N·mm at 1000 rpm on a 0.4 N·m motor */
const IRON = 4e-4;
/** how long the phase current takes to move to a new step, s: the field the rotor follows moves over that time */
const RISE = 0.002;
/** heat capacity of a stepper's steel and copper, J/(kg·K), and what still air takes off its surface, W/(m²·K) */
const CP = 480;
const H_AIR = 15;
const TWO_PI = 2 * Math.PI;

/** where a driver input takes its level from: a controller pin, or something fixed (a rail, ground, its own pull) */
type Level = { kind: "mcu"; pin: number } | { kind: "fixed"; v: number; why: string };

export class StepperMotor {
  drv?: StepDriver;
  fullSteps: number;
  /** electrical cycles a turn (rotor teeth) */
  nr: number;
  /** holding torque at the rated current, N·m */
  tHold: number;
  iRated: number;
  r25: number;
  /** phase inductance, H */
  lph: number;
  /** rotor inertia, kg·m² */
  jRotor: number;
  rth: number;
  cth: number;
  // state
  theta = 0;
  omega = 0;
  /** the electrical angle the driver commands, rad, and how fast the field it makes turns the shaft, rad/s */
  cmd = 0;
  wField = 0;
  /** phase current, A, and the torque the windings put on the rotor, N·m */
  current = 0;
  torque = 0;
  temp: number;
  maxTemp: number;
  /** full steps lost while driven, and the electrical cycles it has slipped by now */
  lost = 0;
  private slip = 0;
  maxRpm = 0;
  maxCmdRpm = 0;
  cmdRpm = 0;
  peakAmps = 0;
  /** energy into the windings, J */
  energy = 0;
  hot = false;
  stepsSeen = 0;

  constructor(
    public comp: string,
    public mc: MachineComponent,
    public part: CatalogPart,
    ambient: number,
  ) {
    this.fullSteps = fullSteps(part);
    this.nr = this.fullSteps / 4;
    this.tHold = num(part, "t_hold", 400) / 1000;
    this.iRated = num(part, "i_rated", 1.5);
    this.r25 = num(part, "r_phase", 2);
    this.lph = num(part, "l_phase", 3) / 1000;
    const frame = num(part, "frame", 17);
    this.jRotor = num(part, "rotor_inertia_gcm2", ROTOR_J[frame] ?? 0.14 * num(part, "t_hold", 400)) * 1e-7;
    // a box of the frame's face and the body's length, losing heat to still air from its sides and back
    const size = (part.geom.dims.size ?? ({ 8: 20.3, 11: 28.2, 14: 35.2, 17: 42.3, 23: 56.4, 34: 86 } as Record<number, number>)[frame] ?? 42.3) / 1000;
    const len = (part.geom.dims.l ?? 40) / 1000;
    this.rth = 1 / (H_AIR * (4 * size * len + size * size));
    this.cth = (num(part, "mass_g", 280) / 1000) * CP;
    this.temp = this.maxTemp = ambient;
  }

  /** winding resistance at its temperature, Ω */
  resistance() {
    return this.r25 * (1 + 0.0039 * (this.temp - 25));
  }

  /** the pull-out torque at a phase current and supply, at a shaft speed (rad/s), N·m; and the current it holds there */
  pullOut(i: number, v: number, omega: number): { t: number; i: number } {
    if (i <= 0 || v <= 0) return { t: 0, i: 0 };
    const t0 = this.tHold * Math.min(1, i / this.iRated) * PULL_OUT;
    const corner = v / (2 * this.lph * i) / this.fullSteps;
    const rev = Math.abs(omega) / TWO_PI;
    const k = rev <= corner ? 1 : corner / rev;
    return { t: t0 * k, i: i * k };
  }

  /** the electrical cycles between the command and the rotor; a change means it slipped */
  lag() {
    return this.cmd - this.nr * this.theta;
  }

  /** counts slips while driven, and forgets the offset while not */
  trackSlip(driven: boolean): number {
    const k = Math.round(this.lag() / TWO_PI);
    let lostNow = 0;
    if (driven && k !== this.slip) {
      lostNow = Math.abs(k - this.slip) * 4;
      this.lost += lostNow;
    }
    this.slip = k;
    return lostNow;
  }
}

export class StepDriver {
  motor?: StepperMotor;
  vmot?: Net;
  vdd?: Net;
  needsVdd: boolean;
  stepPin = -1;
  dir: Level;
  en: Level;
  /** phase current it is set to, A, and its microstep setting */
  iSet: number;
  micro: number;
  rOn: number;
  icont: number;
  ipeak: number;
  vmin: number;
  // the firmware's step pulses not yet applied: cycle and direction
  private qt: number[] = [];
  private qd: number[] = [];
  private head = 0;
  private last = 0;
  /** pulses from tone() or PWM on STEP carried between steps */
  private train = 0;
  heat = 0;
  shutdown = false;
  shutdowns = 0;
  uvlo = false;
  /** seconds since its last step, for the TMC2209's standstill current */
  still = 0;
  supplyCurrent = 0;
  peakSupply = 0;
  /** pulses it did not act on (disabled, unpowered or shut down) */
  ignored = 0;
  said = new Set<string>();

  constructor(
    public comp: string,
    public mc: MachineComponent,
    public part: CatalogPart,
  ) {
    this.needsVdd = part.pins.some((p) => p.id === "VDD");
    this.rOn = num(part, "r_on", R_ON[part.id] ?? 0.6);
    this.icont = num(part, "i_cont", 1);
    this.ipeak = num(part, "i_peak", this.icont * 1.5);
    this.vmin = num(part, "v_min", 8);
    this.iSet = 0;
    this.micro = 0;
    this.dir = { kind: "fixed", v: 0, why: "" };
    this.en = { kind: "fixed", v: 0, why: "" };
  }

  /** a STEP edge from the firmware at cycle t */
  edge(level: number, t: number, dirNow: number) {
    if (level && !this.last) {
      this.qt.push(t);
      this.qd.push(dirNow);
    }
    this.last = level;
  }

  /** pulses due before cycle `until` (the plant runs one step behind the firmware's writes) */
  take(until: number, lag: number, out: (dir: number) => void): void {
    while (this.head < this.qt.length && this.qt[this.head] + lag < until) out(this.qd[this.head++]);
    if (this.head > 512 && this.head === this.qt.length) {
      this.qt.length = this.qd.length = this.head = 0;
    }
  }

  /** tone() or analogWrite() on STEP: pulses evenly through this step */
  trainPulses(hz: number, dt: number): number {
    if (!(hz > 0)) {
      this.train = 0;
      return 0;
    }
    this.train += hz * dt;
    const n = Math.floor(this.train);
    this.train -= n;
    return n;
  }
}

/** The steppers and their drivers in a plant. */
export class Steppers {
  drivers: StepDriver[] = [];
  motors: StepperMotor[] = [];

  constructor(private plant: Plant) {}

  driver(mc: MachineComponent, part: CatalogPart) {
    this.drivers.push(new StepDriver(mc.name, mc, part));
  }

  motor(mc: MachineComponent, part: CatalogPart, ambient: number) {
    this.motors.push(new StepperMotor(mc.name, mc, part, ambient));
  }

  /** Once every part is in place: which stepper each driver's MOTOR plug reaches, and where its inputs come from. */
  bind() {
    const p = this.plant;
    if (!this.drivers.length && !this.motors.length) return;
    for (const cab of p.net.cables) {
      const ends = [cab.a, cab.b];
      const d = this.drivers.find((x) => ends.some((e) => e.comp === x.comp && e.pin.id === "MOTOR"));
      const m = this.motors.find((x) => ends.some((e) => e.comp === x.comp && e.pin.id === "PLUG"));
      if (d && m && !d.motor && !m.drv) {
        d.motor = m;
        m.drv = d;
      }
    }
    for (const d of this.drivers) {
      d.vmot = p.netOf(d.comp, "VMOT");
      d.vdd = p.netOf(d.comp, "VDD");
      d.dir = this.levelOf(d, "DIR", 0, "left open, it reads low");
      d.en = this.levelOf(d, "EN", 0, "left open, its pull-down keeps the driver on");
      d.stepPin = p.mcuPinFor(d.comp, "STEP");
      const m = d.motor;
      this.settings(d, m);
      if (!m) {
        p.notes.push(`${d.comp} drives no stepper: plug a stepper's cable into its MOTOR port.`);
        continue;
      }
      if (d.stepPin < 0) p.notes.push(`${d.comp}.STEP is not wired to a ${p.board.name} pin, so ${m.comp} never steps.`);
      else {
        const before = p.hal.onWrite.get(d.stepPin);
        p.hal.onWrite.set(d.stepPin, (level, t) => {
          before?.(level, t);
          d.edge(level, t, this.read(d.dir));
        });
      }
      if (d.dir.kind === "fixed" && d.dir.why) p.assumptions.push(`${d.comp}.DIR is ${d.dir.why}: ${m.comp} only turns one way`);
      if (d.en.kind === "fixed" && d.en.v >= 0.5) p.notes.push(`${d.comp}.EN is ${d.en.why}, which keeps the driver off: ${m.comp} never turns.`);
      const v = d.vmot ? this.nominal(d.vmot) : 0;
      const corner = v > 0 ? (v / (2 * m.lph * d.iSet) / m.fullSteps) * 60 : 0;
      p.assumptions.push(
        `${m.comp} on ${d.comp}: ${+d.iSet.toFixed(2)} A a phase at 1/${d.micro} step (${m.fullSteps * d.micro} steps a turn, STEP's rising edge, DIR high forward); pull-out torque ${Math.round(m.pullOut(d.iSet, 1, 0).t * 1000)} N·mm up to ${Math.round(corner)} rpm on ${+v.toFixed(1)} V, falling as 1/speed above it`,
      );
    }
    for (const m of this.motors) if (!m.drv) p.notes.push(`${m.comp} is on no stepper driver: plug its cable into a driver's MOTOR port (A4988, DRV8825 or TMC2209).`);
    if (this.motors.some((m) => m.drv) && p.world.couple) p.assumptions.push("Steppers turn against a steady load: the mechanism simulation does not move them yet");
    if (this.motors.some((m) => m.drv) && p.world.kind === "bench") p.assumptions.push("Steppers on the bench drive a load inertia equal to their rotor's (a pulley or lead screw axis) and their load: torque");
  }

  /** the current and microstep setting: what the design measured (sim.measured(current:, microsteps:)), else typical */
  private settings(d: StepDriver, m: StepperMotor | undefined) {
    const p = this.plant;
    const given = d.mc.measured ?? {};
    d.iSet = driverCurrent(d.part, m?.part);
    if (d.iSet > d.ipeak) {
      p.notes.push(`${d.comp} cannot be set to ${d.iSet} A: its most is ${d.ipeak} A, so it runs at that.`);
      d.iSet = d.ipeak;
    }
    const { micro, asked, modes } = driverMicrosteps(d.part);
    d.micro = micro;
    if (micro !== asked) p.notes.push(`${d.comp} cannot step at 1/${asked}: its mode pins give ${modes.map((s) => `1/${s}`).join(", ")}, so it runs at 1/${micro}.`);
    const unsaid = [!("i_set" in given) ? `${+d.iSet.toFixed(2)} A a phase` : "", !("microsteps_set" in given) ? `1/${d.micro} step` : ""].filter(Boolean);
    if (unsaid.length)
      p.assumptions.push(`${d.comp}: set to ${unsaid.join(" at ")} (its trimpot and mode pins); give the real setting with measured: sim.measured(current: ${+d.iSet.toFixed(2)}A, microsteps: ${d.micro})`);
    if (m && d.iSet > m.iRated * 1.05) p.notes.push(`${d.comp} is set to ${+d.iSet.toFixed(2)} A, above ${m.comp}'s ${m.iRated} A rating: it will run hot.`);
  }

  /** where a driver input's level comes from */
  private levelOf(d: StepDriver, pin: string, open: number, openWhy: string): Level {
    const p = this.plant;
    const n = p.netOf(d.comp, pin);
    if (!n) return { kind: "fixed", v: open, why: openWhy };
    const mcu = p.mcuPinOfNet.get(n.id);
    if (mcu !== undefined) return { kind: "mcu", pin: mcu };
    if (n.pins.some((x) => x.pin.type === "gnd")) return { kind: "fixed", v: 0, why: "tied to ground" };
    if (n.pins.some((x) => x.pin.type === "pwr_out" || x.pin.type === "pwr_rail")) return { kind: "fixed", v: 1, why: "tied high" };
    return { kind: "fixed", v: open, why: openWhy };
  }

  private read(l: Level): number {
    if (l.kind === "fixed") return l.v;
    const v = this.plant.hal.drive(l.pin);
    return v >= 0.5 ? 1 : 0;
  }

  /** the volts on a net at the start, for the assumptions */
  private nominal(n: Net): number {
    return this.plant.netV.get(n.id) ?? 0;
  }

  /** the load on a stepper's shaft: the bench gives its load: torque (×load:) and a matched inertia */
  private load(m: StepperMotor): MotorLoad {
    const w = this.plant.world;
    const base = w.motorLoad(m.comp);
    if (w.kind !== "bench") return base;
    const b = w as World & { spec?: { loads?: Record<string, number>; loadFactor?: number }; variant?: string };
    const nmm = (b.spec?.loads?.[m.comp] ?? m.mc.load ?? 0) * (b.spec?.loadFactor ?? 1) * (SPREAD[b.variant ?? "expected"] ?? 1);
    return { coulomb: Math.max(base.coulomb, nmm / 1000), viscous: base.viscous, external: base.external, inertia: m.jRotor };
  }

  step(t0: number, t1: number, dt: number, t: number, ambient: number, cooling: number) {
    const p = this.plant;
    const lag = t1 - t0;
    for (const d of this.drivers) {
      const m = d.motor;
      d.supplyCurrent = 0;
      if (!m) continue;
      const vm = d.vmot ? (p.netV.get(d.vmot.id) ?? 0) : 0;
      const vdd = d.vdd ? (p.netV.get(d.vdd.id) ?? 0) : 0;
      // under-voltage lock-out on the motor supply, with some hysteresis; the translator goes back to its home
      if (!d.uvlo && vm < 0.85 * d.vmin) {
        d.uvlo = true;
        m.cmd = TWO_PI * Math.round((m.nr * m.theta) / TWO_PI);
        if (m.stepsSeen) this.say(d, "uvlo", t, "warn", `${d.comp} stopped driving: its motor supply fell to ${vm.toFixed(1)} V, below its ${d.vmin} V minimum`);
      } else if (d.uvlo && vm >= d.vmin) d.uvlo = false;
      const logic = !d.needsVdd || vdd >= 2.5;
      const enabled = this.read(d.en) < 0.5;
      const on = enabled && logic && !d.uvlo && !d.shutdown;
      // the current it holds: the TMC2209 drops to half after half a second without a step
      const iHold = on ? d.iSet * (d.part.id === "tmc2209" && d.still > 0.5 ? 0.5 : 1) : 0;
      const inc = Math.PI / 2 / d.micro;
      const load = this.load(m);
      const J = m.jRotor + Math.max(0, load.inertia);
      const t0max = m.pullOut(iHold, vm, 0).t;
      const tDet = DETENT * m.tHold;
      const kStiff = m.nr * (t0max + 4 * tDet);
      const wn = Math.sqrt(kStiff / J);
      const n = Math.max(20, Math.ceil((dt * wn) / 0.1));
      const h = dt / n;
      const iron = IRON * m.tHold;
      const cmd0 = m.cmd;
      let pulses = 0;
      const apply = (dir: number) => {
        pulses++;
        if (on) m.cmd += dir ? inc : -inc;
        else d.ignored++;
      };
      // tone() or analogWrite() on the STEP pin: a pulse train
      const pin = d.stepPin;
      const hz = pin >= 0 ? (p.hal.toneHz.get(pin) ?? (p.hal.duty[pin] > 0 && p.hal.duty[pin] < 1 ? p.hal.pwmHz(pin) : 0)) : 0;
      const train = d.trainPulses(hz, dt);
      let tem = 0;
      let iSum = 0;
      for (let k = 0; k < n; k++) {
        const until = t0 + ((k + 1) * (t1 - t0)) / n;
        const before = m.cmd;
        d.take(until, lag, apply);
        for (let j = Math.floor((k * train) / n); j < Math.floor(((k + 1) * train) / n); j++) apply(this.read(d.dir));
        m.wField += ((m.cmd - before) / m.nr - m.wField * h) / RISE;
        const e = m.nr * m.theta;
        // the current falls off with how fast it has to reverse (the field) and the back-EMF (the rotor)
        const po = m.pullOut(iHold, vm, Math.max(Math.abs(m.omega), Math.abs(m.wField)));
        const phi = m.cmd - e;
        const te = po.t * Math.sin(phi);
        // ringing about the field is damped while the rotor is locked to it (inside the torque well's
        // separatrix); a rotor slipping past the field gets no help from it, so a start too fast does not
        // drag it up to speed
        const slip = m.omega - m.wField;
        const well = (m.nr * po.t) / J;
        const rel = m.nr * slip;
        const locked = 0.5 * rel * rel + well * (1 - Math.cos(phi)) < 2 * well;
        const damp = locked ? 2 * ZETA * Math.sqrt(m.nr * (po.t + 4 * tDet) * J) * slip : 0;
        const drive = te - tDet * Math.sin(4 * e) - damp - (iron + load.viscous) * m.omega + load.external;
        const tc = Math.max(0, load.coulomb);
        if (m.omega === 0 && Math.abs(drive) <= tc) {
          // held by friction
        } else {
          const fr = tc * Math.sign(m.omega !== 0 ? m.omega : drive);
          const w2 = m.omega + ((drive - fr) / J) * h;
          m.omega = m.omega !== 0 && Math.sign(w2) !== Math.sign(m.omega) && Math.abs(drive) <= tc ? 0 : w2;
        }
        m.theta += m.omega * h;
        tem += te;
        iSum += po.i;
      }
      m.stepsSeen += pulses;
      if (pulses) d.still = 0;
      else d.still += dt;
      m.torque = tem / n;
      m.current = iSum / n;
      m.cmdRpm = ((m.cmd - cmd0) / m.nr / dt / TWO_PI) * 60;
      const rpm = (Math.abs(m.omega) * 60) / TWO_PI;
      if (rpm > m.maxRpm) m.maxRpm = rpm;
      if (Math.abs(m.cmdRpm) > m.maxCmdRpm) m.maxCmdRpm = Math.abs(m.cmdRpm);
      if (m.current > m.peakAmps) m.peakAmps = m.current;
      const lostNow = m.trackSlip(on && m.current > 0);
      if (lostNow && !d.said.has("lost")) {
        const avail = m.pullOut(iHold, vm, m.omega).t;
        this.say(
          d,
          "lost",
          t,
          "warn",
          `${m.comp} lost steps at ${Math.round(rpm)} rpm with ${Math.round(Math.abs(m.cmdRpm))} rpm asked for: it has ${Math.round(avail * 1000)} N·mm there against ${Math.round(load.coulomb * 1000)} N·mm of load. Ramp the speed up more gently, run it slower or give it more volts`,
        );
      }
      // the windings: copper loss in both phases (sine and cosine currents), and the work done
      const r = m.resistance();
      const pCu = m.current * m.current * r;
      m.energy += pCu * dt;
      m.temp += (dt * (pCu - ((m.temp - ambient) * Math.max(0.05, cooling)) / m.rth)) / m.cth;
      if (m.temp > m.maxTemp) m.maxTemp = m.temp;
      if (!m.hot && m.temp > 100) {
        m.hot = true;
        this.say(d, "hot", t, "warn", `${m.comp} passed 100 °C: turn ${d.comp}'s current down, or let it rest between moves`);
      }
      if (vm > 1 && m.current > 0) {
        const mech = Math.max(0, m.torque * m.omega);
        d.supplyCurrent = (m.current * m.current * (r + d.rOn) + mech) / vm;
        if (d.supplyCurrent > d.peakSupply) d.peakSupply = d.supplyCurrent;
      }
      // the driver chip: past its continuous rating for long it shuts down, and comes back once cool
      const icont = d.icont * Math.max(0.3, (150 - ambient) / 125);
      d.heat += dt * ((m.current / icont) ** 2 - 1) * 0.02;
      if (d.heat < 0) d.heat = 0;
      if (!d.shutdown && d.heat > 1) {
        d.shutdown = true;
        d.shutdowns++;
        p.events.push({ t, kind: "warn", text: `${d.comp} overheated and shut down: ${+m.current.toFixed(2)} A a phase is past its ${d.icont} A rating without more cooling, so ${m.comp} lost its holding torque` });
      } else if (d.shutdown && d.heat < 0.5) {
        d.shutdown = false;
        p.events.push({ t, kind: "info", text: `${d.comp} cooled and drives again` });
      }
      if (pulses && !on && !d.said.has("off")) {
        const why = d.shutdown ? "it is shut down hot" : d.uvlo ? `its motor supply is at ${vm.toFixed(1)} V` : !logic ? "nothing powers its VDD (logic) pin" : "EN is high";
        this.say(d, "off", t, "warn", `${d.comp} ignores its STEP pulses: ${why}`);
      }
    }
  }

  private say(d: StepDriver, key: string, t: number, kind: "warn" | "info", text: string) {
    if (d.said.has(key)) return;
    d.said.add(key);
    this.plant.events.push({ t, kind, text });
  }

  /** what the motors draw from their supplies this step */
  draw(add: (n: Net | undefined, a: number) => void) {
    for (const d of this.drivers) add(d.vmot, d.supplyCurrent);
  }

  view(comp: string) {
    const m = this.motors.find((x) => x.comp === comp);
    return m ? { omega: m.omega, angle: m.theta, current: m.current, torque: m.torque } : undefined;
  }

  moving() {
    return this.motors.some((m) => Math.abs(m.omega) > 0.05);
  }

  channels(out: Record<string, number>) {
    for (const m of this.motors) {
      if (!m.drv) continue;
      out[`${m.comp}.rpm`] = (m.omega * 60) / TWO_PI;
      out[`${m.comp}.turns`] = m.theta / TWO_PI;
      out[`${m.comp}.asked_rpm`] = m.cmdRpm;
      out[`${m.comp}.amps`] = m.current;
      out[`${m.comp}.torque`] = m.torque;
      out[`${m.comp}.temp`] = m.temp;
      out[`${m.comp}.lost_steps`] = m.lost;
      // how far the rotor trails the command within its electrical cycle, in full steps (past 2 it slips)
      const lag = m.lag();
      out[`${m.comp}.lag`] = (lag - TWO_PI * Math.round(lag / TWO_PI)) / (Math.PI / 2);
    }
    for (const d of this.drivers) if (d.motor) out[`${d.comp}.amps`] = d.supplyCurrent;
  }

  results(): Record<string, number | boolean | string> {
    const r: Record<string, number | boolean | string> = {};
    for (const m of this.motors) {
      if (!m.drv) continue;
      r[`${m.comp}.turns`] = m.theta / TWO_PI;
      r[`${m.comp}.asked_turns`] = m.cmd / m.nr / TWO_PI;
      r[`${m.comp}.lost_steps`] = m.lost;
      r[`${m.comp}.max_rpm`] = m.maxRpm;
      r[`${m.comp}.peak_amps`] = m.peakAmps;
      r[`${m.comp}.max_temp`] = m.maxTemp;
      r[`${m.comp}.steps`] = m.stepsSeen;
    }
    for (const d of this.drivers) {
      if (!d.motor) continue;
      r[`${d.comp}.shutdowns`] = d.shutdowns;
      r[`${d.comp}.peak_amps`] = d.peakSupply;
    }
    return r;
  }
}
