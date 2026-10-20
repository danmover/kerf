// Things going wrong during a run: a motor or actuator jams, a part comes
// unplugged, one wire comes loose (for good, or flickering), a sensor freezes,
// or the battery is an old one. Each fault changes the plant or the world from
// its time until it clears, and can be undone, so a wire pushed back on or a
// jam that frees carries on from where the run is. The world is wrapped only
// when a fault needs it (a jam's load, a frozen sensor's view), so runs
// without faults are untouched.
//
// After the run the results say how the machine coped: whether it stopped,
// how long after the fault, whether the firmware noticed, how long each motor
// was driven while stalled, and whether a fuse or driver gave out.

import type { FaultSpec } from "../scenario";
import { FAULT_WORDS } from "../scenario";
import { catalogPart } from "../../machine/catalog";
import type { SerialLine } from "./hal";
import { SCHEMES, type Plant, type Src } from "./plant";
import type { MotorLoad, Orientation, World, WorldEvent } from "../worlds/types";

/** a jammed shaft: no torque the motor can make turns it */
const JAMMED: MotorLoad = { coulomb: 1e4, viscous: 0, external: 0, inertia: 0 };

type Undo = () => void;

/** A motor or actuator is quiet below this current, and still below this speed. */
const QUIET_A = 0.1;
const STILL_RPM = 1;

/** What the firmware says when it has noticed something is wrong. */
const NOTICED = /stall|jam|fault|lost|not found|no response|error|stuck|low|disconnect|check|overheat|hot|fail|missing|cannot|can't/i;

export class FaultInjector {
  events: WorldEvent[] = [];
  notes: string[] = [];
  /** when each fault is in force, with how to undo it */
  private live = new Map<number, Undo>();
  /** flickering wires: the next time each one changes */
  private nextFlick = new Map<number, number>();
  private jammed = new Set<string>();
  private frozen = new Map<string, Orientation>();
  private frozenRange = new Map<string, number>();
  private plant: Plant | null = null;
  private world: World | null = null;
  /** a driver channel shut down for overheating at some point */
  driverOverheated = false;

  constructor(
    public faults: FaultSpec[],
    private rng: () => number,
  ) {}

  /** when the first fault happens, seconds after power-up (old batteries are there from the start, not an event) */
  get firstAt(): number | undefined {
    const ts = this.faults.filter((f) => f.kind !== "aged").map((f) => f.at);
    return ts.length ? Math.min(...ts) : undefined;
  }

  /** The world as the plant sees it: jammed motors and frozen sensors in place of the real thing. */
  wrap(world: World): World {
    this.world = world;
    if (!this.faults.some((f) => f.kind === "jam" || f.kind === "stuck")) return world;
    const jammed = this.jammed;
    const frozen = this.frozen;
    const frozenRange = this.frozenRange;
    return new Proxy(world, {
      get(target, prop) {
        if (prop === "motorLoad") return (comp: string) => (jammed.has(comp) ? JAMMED : target.motorLoad(comp));
        if (prop === "orientation") return (comp: string) => frozen.get(comp) ?? target.orientation(comp);
        if (prop === "range" && target.range) return (comp: string) => frozenRange.get(comp) ?? target.range!(comp);
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  /** Called once the plant is built: old batteries are old from the start. */
  attach(plant: Plant) {
    this.plant = plant;
    this.faults.forEach((f, i) => {
      if (f.kind !== "aged") return;
      const b = plant.batteries.find((x) => x.b.name === f.target)?.b;
      if (!b) return;
      b.capAh *= f.capacity ?? 0.8;
      b.r0 *= f.resistance ?? 1.5;
      b.r1 *= f.resistance ?? 1.5;
      this.live.set(i, () => {});
      plant.assumptions.push(`${f.target} is an old battery: ${Math.round((f.capacity ?? 0.8) * 100)} % of its capacity left and ${f.resistance ?? 1.5} times its new internal resistance`);
    });
  }

  /** After every plant step: start, clear and flicker faults by the clock. */
  step(t: number) {
    const plant = this.plant;
    if (!plant) return;
    for (const c of plant.chans) if (c.shutdown) this.driverOverheated = true;
    this.faults.forEach((f, i) => {
      if (f.kind === "aged") return;
      const on = this.live.has(i);
      const due = t >= f.at && (f.until === undefined || t < f.until);
      if (!on && due && !(f.flicker && this.nextFlick.has(i))) {
        this.start(i, f, t);
        if (f.flicker) this.nextFlick.set(i, t + this.flickGap());
      } else if (on && !due) this.clear(i, f, t, true);
      else if (f.flicker && due && t >= (this.nextFlick.get(i) ?? Infinity)) {
        // a loose wire touching and letting go: quietly, or the events would fill with it
        if (on) this.clear(i, f, t, false);
        else this.start(i, f, t, false);
        this.nextFlick.set(i, t + this.flickGap());
      }
    });
  }

  private flickGap() {
    return 0.05 + this.rng() * 0.95;
  }

  private start(i: number, f: FaultSpec, t: number, say = true) {
    const undo = this.apply(f, t);
    this.live.set(i, undo);
    if (say) this.events.push({ t, kind: "warn", text: `Fault: ${f.target} ${FAULT_WORDS[f.kind]}${f.flicker ? " (making and losing contact)" : ""}` });
  }

  private clear(i: number, f: FaultSpec, t: number, say: boolean) {
    this.live.get(i)?.();
    this.live.delete(i);
    if (say) this.events.push({ t, kind: "info", text: `Fault cleared: ${f.target} ${f.kind === "jam" ? "frees" : f.kind === "stuck" ? "recovers" : "is connected again"}` });
  }

  private apply(f: FaultSpec, t: number): Undo {
    const plant = this.plant!;
    switch (f.kind) {
      case "jam":
        return this.jam(f.target);
      case "stuck":
        return this.stick(f.target, t);
      case "unplug":
        return this.unplug(f.target);
      case "loose": {
        const [comp, pin] = f.target.split(".");
        if (comp === plant.mcu) return this.looseAtController(pin);
        return this.cutPin(comp, pin) ?? this.unsupported(f);
      }
      default:
        return () => {};
    }
  }

  private unsupported(f: FaultSpec): Undo {
    const msg = `Kerf cannot simulate ${f.target} coming loose yet, so that fault changed nothing.`;
    if (!this.notes.includes(msg)) this.notes.push(msg);
    return () => {};
  }

  // ---------- jams ----------

  private jam(comp: string): Undo {
    const plant = this.plant!;
    const act = plant.acts.find((a) => a.comp === comp);
    if (act) {
      // locked both ways: whichever way it is driven, the push against it is more than it can make
      const a = act.a;
      const own = Object.prototype.hasOwnProperty.call(a, "step");
      const step = a.step;
      a.step = (v: number | null, _f: number, dt: number) => step.call(a, v, v ? Math.sign(v) * 1e7 : 0, dt);
      return () => {
        if (own) a.step = step;
        else delete (a as { step?: unknown }).step;
      };
    }
    this.jammed.add(comp);
    return () => this.jammed.delete(comp);
  }

  // ---------- frozen sensors ----------

  private stick(comp: string, t: number): Undo {
    const plant = this.plant!;
    const world = this.world!;
    const undos: Undo[] = [];
    const part = catalogPart(plant.machine.components.find((c) => c.name === comp)?.catalogId ?? "");
    if (part?.kind === "gearmotor") {
      // the encoder stops counting: its lines stay where they are
      const m = plant.motors.find((s) => s.comp === comp);
      if (m) undos.push(this.swap(m, "encA", -1), this.swap(m, "encB", -1), () => ((m.lastA = -1), (m.lastB = -1)));
    } else {
      const o = world.orientation(comp);
      this.frozen.set(comp, { ...o, rate: [...o.rate], accel: [...o.accel] });
      undos.push(() => this.frozen.delete(comp));
      if (world.range) {
        this.frozenRange.set(comp, world.range(comp));
        undos.push(() => this.frozenRange.delete(comp));
      }
      // analog readings (a voltage sensor, an actuator's position) hold their last value
      for (const pin of this.analogPinsOf(comp)) {
        const src = plant.analogSrc.get(pin);
        if (!src) continue;
        const held = src(Math.round(t * plant.board.fcpu));
        plant.analogSrc.set(pin, () => held);
        undos.push(() => plant.analogSrc.set(pin, src));
      }
    }
    return () => undos.reverse().forEach((u) => u());
  }

  // ---------- unplugged parts and loose wires ----------

  private unplug(comp: string): Undo {
    const part = catalogPart(this.plant!.machine.components.find((c) => c.name === comp)?.catalogId ?? "");
    const pins = part?.pins.map((p) => p.id) ?? [];
    const undos = pins.map((p) => this.cutPin(comp, p, true)).filter((u): u is Undo => !!u);
    if (!undos.length) return this.unsupported({ kind: "unplug", target: comp, at: 0 });
    return () => undos.reverse().forEach((u) => u());
  }

  /** A wire off a controller pin: whatever is at the other end loses it. */
  private looseAtController(pin: string): Undo {
    const plant = this.plant!;
    const net = plant.netOf(plant.mcu, pin);
    const others = net?.pins.filter((p) => p.comp !== plant.mcu) ?? [];
    const undos = others.map((p) => this.cutPin(p.comp, p.pin.id)).filter((u): u is Undo => !!u);
    if (!undos.length) return this.unsupported({ kind: "loose", target: `${plant.mcu}.${pin}`, at: 0 });
    return () => undos.reverse().forEach((u) => u());
  }

  /** Cut one pin of a part, or undefined when Kerf does not model what that pin does. */
  private cutPin(comp: string, pin: string, wholePart = false): Undo | undefined {
    const plant = this.plant!;
    const mc = plant.machine.components.find((c) => c.name === comp);
    const part = catalogPart(mc?.catalogId ?? "");
    if (!part) return undefined;
    const def = part.pins.find((p) => p.id === pin);
    const undos: Undo[] = [];
    const mcuPin = plant.mcuPinFor(comp, pin);
    const dropAnalog = (p: number) => {
      const src = plant.analogSrc.get(p);
      if (!src) return;
      plant.analogSrc.delete(p);
      undos.push(() => plant.analogSrc.set(p, src));
    };
    const offBus = () => {
      for (const [addr, d] of plant.i2cDevs) {
        if (d.comp !== comp) continue;
        plant.i2cDevs.delete(addr);
        undos.push(() => plant.i2cDevs.set(addr, d));
      }
    };
    switch (part.kind) {
      case "gearmotor": {
        const m = plant.motors.find((s) => s.comp === comp);
        if (!m) break;
        if (def?.type === "motor") undos.push(this.swap(m, "chan", undefined));
        else if (pin === "ENC_A") undos.push(this.swap(m, "encA", -1), () => (m.lastA = -1));
        else if (pin === "ENC_B") undos.push(this.swap(m, "encB", -1), () => (m.lastB = -1));
        else if (pin === "ENC_VCC" || pin === "ENC_GND") undos.push(this.swap(m, "encVcc", DEAD_NET));
        break;
      }
      case "actuator": {
        const a = plant.acts.find((s) => s.comp === comp);
        if (!a) break;
        if (def?.type === "motor") undos.push(this.swap(a, "chan", undefined));
        else if (/^FB/.test(pin) && a.fbPin >= 0) dropAnalog(a.fbPin);
        break;
      }
      case "servo": {
        const s = plant.servos.find((x) => x.comp === comp);
        if (!s) break;
        if (pin === "SIG") undos.push(this.swap(s, "pin", -1));
        else undos.push(this.swap(s, "vcc", undefined));
        break;
      }
      case "motor_driver": {
        for (const c of plant.chans.filter((x) => x.comp === comp)) {
          if (def?.type === "motor_out" && (def.channel ?? "A") === c.ch) {
            // the motor or actuator on this output loses its feed
            for (const m of plant.motors) if (m.chan === c) undos.push(this.swap(m, "chan", undefined));
            for (const a of plant.acts) if (a.chan === c) undos.push(this.swap(a, "chan", undefined));
            continue;
          }
          if (def?.type === "pwr_in" || def?.type === "gnd") {
            // no supply or no ground: the bridge has nothing to drive with
            undos.push(this.swap(c, "supply", undefined));
            continue;
          }
          // a control input left floating reads as its default (pulled up or down on the board)
          const table = SCHEMES[c.scheme]?.[c.ch] ?? SCHEMES.pwm_dir.A;
          for (const [role, ids] of Object.entries(table)) {
            const present = ids.filter((id) => part.pins.some((p) => p.id === id));
            const k = present.indexOf(pin);
            const list = c.src[role];
            if (k < 0 || !list?.[k]) continue;
            const note = part.pins.find((p) => p.id === pin)?.note ?? "";
            const dflt = /pulled high|tie(d)? high by default|enabled by default/i.test(note) ? 1 : 0;
            const was: Src = list[k];
            list[k] = { kind: "none", def: dflt };
            undos.push(() => (list[k] = was));
          }
        }
        if (mcuPin >= 0 && def?.type === "analog_out") dropAnalog(mcuPin);
        break;
      }
      case "sensor":
      case "display": {
        offBus();
        if (mcuPin >= 0) dropAnalog(mcuPin);
        // a distance sensor stops echoing
        const trig = plant.mcuPinFor(comp, "TRIG");
        const echo = trig >= 0 ? plant.hal.onWrite.get(trig) : undefined;
        if (echo && (wholePart || ["TRIG", "ECHO", "VCC", "GND"].includes(pin))) {
          plant.hal.onWrite.delete(trig);
          undos.push(() => plant.hal.onWrite.set(trig, echo));
        }
        // an analog sensor that loses its supply reads nothing
        if (/VCC|PLUS|GND/.test(pin)) {
          const s = plant.mcuPinFor(comp, "S");
          if (s >= 0) dropAnalog(s);
        }
        break;
      }
      case "battery": {
        // the supply is gone: everything it feeds goes dark
        const b = plant.batteries.find((x) => x.b.name === comp)?.b;
        if (!b || Object.prototype.hasOwnProperty.call(b, "volts")) break;
        b.volts = () => 0;
        undos.push(() => delete (b as { volts?: unknown }).volts);
        break;
      }
      case "psu": {
        // a supply unplugged from the wall, or its plug pulled out of the machine
        const s = plant.supplies.find((x) => x.s.name === comp)?.s;
        if (!s || Object.prototype.hasOwnProperty.call(s, "volts")) break;
        s.volts = () => 0;
        undos.push(() => delete (s as { volts?: unknown }).volts);
        break;
      }
      case "regulator": {
        const g = plant.regs.find((x) => x.r.name === comp);
        if (g) undos.push(this.swap(g, "vout", undefined));
        break;
      }
      case "fuse": {
        const fz = plant.fuses.find((x) => x.comp === comp);
        if (fz && !fz.blown) {
          fz.blown = true;
          undos.push(() => (fz.blown = false));
        }
        break;
      }
    }
    if (!undos.length) return undefined;
    return () => undos.reverse().forEach((u) => u());
  }

  private analogPinsOf(comp: string): number[] {
    const plant = this.plant!;
    const part = catalogPart(plant.machine.components.find((c) => c.name === comp)?.catalogId ?? "");
    const out: number[] = [];
    for (const p of part?.pins ?? []) {
      const pin = plant.mcuPinFor(comp, p.id);
      if (pin >= 0 && plant.analogSrc.has(pin)) out.push(pin);
    }
    const act = plant.acts.find((a) => a.comp === comp);
    if (act && act.fbPin >= 0) out.push(act.fbPin);
    return [...new Set(out)];
  }

  /** Set a field and return how to put it back. */
  private swap<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): Undo {
    const was = obj[key];
    obj[key] = value;
    return () => {
      obj[key] = was;
    };
  }
}

/** A net with no voltage on it: an encoder's supply wire pulled off. */
const DEAD_NET = { id: -1, name: "(loose)", pins: [] } as unknown as NonNullable<Plant["motors"][number]["encVcc"]>;

interface FrameData {
  t: Float32Array;
  series: Record<string, Float32Array>;
}

/**
 * How the machine coped, from the recorded frames and the serial log. Every
 * run gets each motor's stall time, whether a fuse or driver gave out and
 * whether everything was still at the end; a run with faults also gets when
 * the first one happened, whether and how soon everything stopped after it,
 * and whether the firmware noticed.
 */
export function copingResults(frames: FrameData, serial: SerialLine[], plant: Plant, inj?: FaultInjector): Record<string, number | boolean | string> {
  const r: Record<string, number | boolean | string> = {};
  const n = frames.t.length;
  const dt = n > 1 ? (frames.t[n - 1] - frames.t[0]) / (n - 1) : 0;
  const quiet = (i: number) => {
    for (const m of plant.motors) {
      if (Math.abs(frames.series[`${m.comp}.amps`]?.[i] ?? 0) > QUIET_A) return false;
      if (Math.abs(frames.series[`${m.comp}.rpm`]?.[i] ?? 0) > STILL_RPM) return false;
    }
    for (const a of plant.acts) if (Math.abs(frames.series[`${a.comp}.amps`]?.[i] ?? 0) > QUIET_A / 2) return false;
    return true;
  };
  for (const m of plant.motors) {
    // driven hard with the shaft not turning: a stall the firmware is holding
    const amps = frames.series[`${m.comp}.amps`];
    const rpm = frames.series[`${m.comp}.rpm`];
    if (!amps || !rpm) continue;
    const iFree = Number(catalogPart(m.mc.catalogId)?.specs.i_free ?? 0.2);
    const hard = Math.max(0.5, 2 * iFree);
    let k = 0;
    for (let i = 0; i < n; i++) if (Math.abs(amps[i]) > hard && Math.abs(rpm[i]) < STILL_RPM) k++;
    r[`${m.comp}.stall_time`] = k * dt;
  }
  r.fuse_blown = plant.fuses.some((f) => f.blown);
  r.driver_overheated = !!inj?.driverOverheated || plant.chans.some((c) => c.shutdown) || plant.events.some((e) => /overheated and shut down/.test(e.text));
  r.still_at_end = n > 0 && quiet(n - 1);
  const ft = inj?.firstAt;
  if (ft === undefined) return r;
  r.fault_time = ft;
  // quiet from some time to the end: the last time anything moved or drew current
  let from = n;
  while (from > 0 && quiet(from - 1)) from--;
  if (from < n) {
    r.fault_stopped = true;
    r.fault_stop_time = Math.max(0, frames.t[from] - ft);
  } else r.fault_stopped = false;
  const said = serial.find((l) => l.dir === "out" && l.t >= ft && NOTICED.test(l.text));
  r.fault_noticed = !!said;
  if (said) r.fault_reaction = said.t - ft;
  return r;
}
