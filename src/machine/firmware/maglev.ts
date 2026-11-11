// The magnetic levitation behaviour: firmware that floats a magnet under a
// lift coil, holds it sideways with steering coils, and weighs the forces on
// it from the coil currents. Written for a magnetic suspension wind tunnel (a
// model with a magnet core hangs in the airstream on nothing, and its drag is
// read from the current that holds it), it also runs a bare levitator.
//
// Every pin is found from the design's wiring, and every magnetic constant
// from its geometry: where the coils, the magnet and the field sensor sit and
// how the coils are wound give the lift force per amp against height, the
// steering coils' push, each coil's own field at the sensor (taken out of its
// reading) and the table that turns field into height. A 500 Hz loop reads the
// TMAG5273 and the INA3221 current monitors, estimates the model's position,
// runs PD + I position loops and a current loop per coil, and drives the coils
// with 20 kHz PWM. Plain C, so the simulator runs exactly what goes on the
// board.

import { CoilField, MagnetField, magnetMoment, remanenceOf, type Vec3 } from "../../sim/mech/field";
import { catalogPart } from "../catalog";
import { coilChain, shuntFacing, shuntSides } from "../shunts";
import type { CatalogPart, MachineComponent } from "../types";
import { type FwContext, type GenFile, cComment, cNum, componentsOfKind, ctrlPinFor, ident, oneLine, setting } from "./common";

/** A C float literal at the precision given to it: metres and henries need more than four decimal places. */
const cFloat = (n: number): string => {
  if (!Number.isFinite(n)) return "0.0f";
  const t = String(n);
  return /[.e]/.test(t) ? `${t}f` : `${t}.0f`;
};

export const MAGLEV_WORDS = /\b(mag(netic)?[- ]?lev\w*|levitat\w*|magnetic suspension|suspension balance)/i;

export interface MaglevResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
  summary: string;
}

const MM = 1e-3;
const G0 = 9.80665;
const I3: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const spec = (p: CatalogPart, key: string, fallback: number) => {
  const v = p.specs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};

const pinNum = (id: string | undefined) => {
  if (!id) return -1;
  const n = Number(id);
  return Number.isInteger(n) ? n : -1;
};

/** a coil's force on a dipole m at p for 1 A, N: the gradient of m·B by central differences 0.1 mm apart */
function forcePerAmp(f: { at(p: Vec3): Vec3 }, p: Vec3, m: Vec3): Vec3 {
  const H = 1e-4;
  const out: Vec3 = [0, 0, 0];
  const q: Vec3 = [p[0], p[1], p[2]];
  for (let ax = 0; ax < 3; ax++) {
    q[ax] = p[ax] + H;
    const hi = dot(m, f.at(q));
    q[ax] = p[ax] - H;
    const lo = dot(m, f.at(q));
    q[ax] = p[ax];
    out[ax] = (hi - lo) / (2 * H);
  }
  return out;
}

/** one wound coil as the design places it */
interface Wound {
  mc: MachineComponent;
  part: CatalogPart;
  field: CoilField;
  /** ohms at 20 °C and henries of the winding */
  r: number;
  l: number;
  /** J/K of the copper and W/K it sheds, for the firmware's temperature estimate */
  cth: number;
  ha: number;
}

/** one driver output and the coil on it, or the string of coils wired in series on it */
interface Chan {
  name: string;
  drv: MachineComponent;
  dp: CatalogPart;
  ch: string;
  /** each coil and the way the string's current (out of the driver's first output) runs through it */
  members: { w: Wound; sign: number }[];
  /** +1 when the firmware drives the first output positive, -1 the second */
  dir: number;
  r: number;
  l: number;
  rPath: number;
  cth: number;
  ha: number;
  tempMax: number;
  /** PWM pin, a pin held high and one held low while it runs (-1: wired that way), whether the PWM is the off time, and the driver's enable pin */
  pwm: number;
  high: number;
  low: number;
  inverted: boolean;
  en: number;
  /** current monitor address, channel 1 to 3 and sign */
  ina: number;
  ch3: number;
  sign: number;
  /** the string's field at a point for 1 A the way the firmware drives it, T */
  at(p: Vec3): Vec3;
}

/** a list setting like "30, 45, 60", or the default when it is not numbers */
function listSetting(c: FwContext, key: string, def: number[], warnings: string[], n?: number): number[] {
  const raw = c.fw.settings[key];
  if (raw === undefined) return def;
  const xs = String(raw)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (xs.length && xs.every(Number.isFinite) && (n === undefined || xs.length === n)) return xs;
  warnings.push(`${key}: give ${n ?? "a list of"} numbers (like "${def.join(", ")}"); using ${def.join(", ")}.`);
  return def;
}

export function maglevFirmware(c: FwContext): MaglevResult {
  const warnings: string[] = [];
  const pinTable: MaglevResult["pinTable"] = [];
  const board = c.board.name;
  const bp = c.boardPart;
  const none = (why: string): MaglevResult => ({ files: [], warnings: [why, ...warnings], pinTable, summary: why });
  const mcuPin = (comp: string, pin: string) => {
    const r = ctrlPinFor(c, comp, pin);
    return r && r.pin.type === "io" ? r : undefined;
  };
  const note = (signal: string, comp: string, pin: string) => {
    const r = mcuPin(comp, pin);
    if (r) pinTable.push({ signal, pin: r.pin.label ? `${r.pin.label} (GPIO${r.pin.mcu ?? r.pin.id})` : r.pin.id, wire: `${comp}.${pin}` });
    return pinNum(r?.pin.mcu ?? r?.pin.id);
  };
  /** how an input is wired: to a controller pin, to a supply, to ground, or to nothing */
  const tie = (comp: string, pin: string): "mcu" | "high" | "low" | "open" => {
    const net = c.nl.netOf.get(`${comp}[0].${pin}`);
    if (!net) return "open";
    if (net.pins.some((p) => p.comp === board && p.pin.type === "io")) return "mcu";
    if (net.pins.some((p) => p.pin.type === "pwr_out" || p.pin.type === "pwr_rail")) return "high";
    if (net.pins.some((p) => p.pin.type === "gnd")) return "low";
    return "open";
  };

  // ---- the magnet, the field sensor and the coils, where the design puts them
  const magnets = componentsOfKind(c, "magnet");
  const magnet = magnets.find((m) => /model|float|levitat/i.test(m.role ?? "")) ?? magnets[0];
  if (!magnet) return none(`firmware ${c.fw.name}: a levitation loop needs a magnet (lib.magnet) to float. Add the model's magnet where it rests.`);
  const magPart = catalogPart(magnet.catalogId)!;
  const sensor = c.m.components.find((x) => /^TMAG5273/.test(String(catalogPart(x.catalogId)?.specs.chip ?? "")));
  if (!sensor) return none(`firmware ${c.fw.name}: a levitation loop needs a field sensor to see the magnet (lib.sensor("tmag5273_breakout")).`);
  const senPart = catalogPart(sensor.catalogId)!;
  const coilComps = componentsOfKind(c, "coil");
  if (coilComps.length < 2) return none(`firmware ${c.fw.name}: a levitation loop needs a lift coil over the magnet and steering coils beside its axis (lib.coil); the design has ${coilComps.length}.`);

  const up: Vec3 = [0, 0, 1];
  const frame = (mc: MachineComponent) => mc.axes ?? I3;
  const origin = (mc: MachineComponent): Vec3 => scale((mc.at ?? [0, 0, 0]) as Vec3, MM);
  const magH = spec(magPart, "h", 10) * MM;
  const magR = (spec(magPart, "d", 10) / 2) * MM;
  const north = norm(frame(magnet)[2]);
  const moment = spec(magPart, "moment_am2", magnetMoment(spec(magPart, "br_t", remanenceOf(String(magPart.specs.grade ?? "N42"))), Math.PI * magR * magR * magH));
  const rest = add(origin(magnet), north, magH / 2);
  const hoverMm = setting(c.fw, "hover", 15);
  const p0 = add(rest, up, hoverMm * MM);
  // north up or down: the firmware works with the field along the magnet
  const sgn = dot(north, up) >= 0 ? 1 : -1;
  if (Math.abs(dot(north, up)) < 0.95) warnings.push(`${magnet.name}: its poles should be one above the other (axis: Z or -Z); as drawn it leans ${cNum((Math.acos(Math.abs(dot(north, up))) * 180) / Math.PI)}°.`);
  const mUp = scale(up, sgn * moment);
  const sf = frame(sensor);
  const sAt = add(add(add(origin(sensor), sf[0], spec(senPart, "sense_x", 0) * MM), sf[1], spec(senPart, "sense_y", 0) * MM), sf[2], spec(senPart, "sense_z", 0) * MM);
  const d0 = dot(add(p0, sAt, -1), up);
  const side = Math.hypot(...add(add(p0, sAt, -1), up, -d0));
  if (d0 < 0) warnings.push(`${sensor.name} is drawn above the hover point: the firmware expects it below the model, under the floor.`);
  if (Math.abs(d0) < 0.012 || Math.abs(d0) > 0.06) warnings.push(`${sensor.name} is ${cNum(Math.abs(d0) * 1000)} mm from the hover point: between 20 and 40 mm gives it a field it can read well.`);
  if (side > 0.0015) warnings.push(`${sensor.name} is ${cNum(side * 1000)} mm off the line straight under the magnet: put it on that line, or the model floats that far off centre.`);
  // the hover point as the sensor sees it: straight above its sensing spot
  const hov = add(sAt, up, d0);
  const dRest = d0 - hoverMm * MM;
  if (dRest < magH / 2 + 0.002) warnings.push(`${magnet.name} rests ${cNum(dRest * 1000)} mm above ${sensor.name}, closer than the magnet is long: check where they are drawn.`);
  const magField = new MagnetField(magR, magH, moment);

  const wound = new Map<string, Wound>(
    coilComps.map((mc) => {
      const part = catalogPart(mc.catalogId)!;
      const h = spec(part, "h", 15) * MM;
      const ri = (spec(part, "id", 10) / 2) * MM;
      const ro = (spec(part, "od", 30) / 2) * MM;
      const axis = norm(frame(mc)[2]);
      const field = new CoilField({ c: add(origin(mc), axis, h / 2), axis, ri, ro, h, turns: spec(part, "turns", 100) });
      const wire = spec(part, "wire_d", 0.5) * MM;
      const len = spec(part, "wire_m", field.wireLength());
      const copper = spec(part, "mass_g", len * Math.PI * (wire / 2) ** 2 * 8.96e6) / 1000;
      return [
        mc.name,
        {
          mc,
          part,
          field,
          r: spec(part, "r_ohm", (1.72e-8 * len) / (Math.PI * (wire / 2) ** 2)),
          l: spec(part, "l_mh", 5) / 1000,
          cth: Math.max(0.5, copper * 385),
          ha: 11 * (2 * Math.PI * ro * h + Math.PI * ri * h + 2 * Math.PI * (ro * ro - ri * ri)),
        },
      ];
    }),
  );

  // ---- driver outputs: the coil on each, or the string of coils wired in series on it, and the pins that run it
  const chans: Chan[] = [];
  const enPins = new Set<number>();
  const enSeen = new Set<string>();
  const coilNames = coilComps.map((x) => x.name);
  for (const drv of componentsOfKind(c, "motor_driver")) {
    const dp = catalogPart(drv.catalogId)!;
    for (const ch of [...new Set(dp.pins.filter((p) => p.type === "motor_out").map((p) => p.channel ?? "A"))]) {
      const outs = dp.pins.filter((p) => p.type === "motor_out" && (p.channel ?? "A") === ch);
      const chain = outs.length >= 2 ? coilChain(c.nl, `${drv.name}[0].${outs[0].id}`, `${drv.name}[0].${outs[1].id}`, coilNames) : undefined;
      if (!chain) continue;
      const members = chain.map((m) => ({ w: wound.get(m.comp)!, sign: m.sign }));
      const raw = (p: Vec3): Vec3 => members.reduce((b, m) => add(b, m.w.field.at(p), m.sign), [0, 0, 0] as Vec3);
      const k: Chan = {
        name: members.map((m) => m.w.mc.name).join(" + "),
        drv,
        dp,
        ch,
        members,
        dir: 1,
        r: members.reduce((x, m) => x + m.w.r, 0),
        l: members.reduce((x, m) => x + m.w.l, 0),
        rPath: spec(dp, "r_on", dp.id === "tb6612fng" ? 0.5 : dp.id === "drv8833" ? 0.36 : 0.3),
        cth: members.reduce((x, m) => x + m.w.cth, 0),
        ha: members.reduce((x, m) => x + m.w.ha, 0),
        tempMax: Math.min(...members.map((m) => spec(m.w.part, "temp_max", 105))),
        pwm: -1,
        high: -1,
        low: -1,
        inverted: false,
        en: -1,
        ina: 0,
        ch3: 0,
        sign: 1,
        at: (p) => scale(raw(p), k.dir),
      };
      // the way round that pulls the magnet toward the coil: its field at the magnet along the magnet's own
      const prefer = dot(raw(hov), mUp) >= 0 ? 1 : -1;
      const d = drv.name;
      const scheme = String(dp.specs.control ?? "");
      if (scheme === "in1_in2_pwm_both") {
        // held high on one input and PWM on the other: driven for the PWM's low time, braked (slow decay) for its high time
        k.dir = prefer;
        const hold = `${ch}IN${prefer > 0 ? 1 : 2}`;
        const sw = `${ch}IN${prefer > 0 ? 2 : 1}`;
        k.high = note(`${k.name} drive enable (${d} ${hold})`, d, hold);
        k.pwm = note(`${k.name} PWM, low = drive (${d} ${sw})`, d, sw);
        k.inverted = true;
        if (k.high < 0 && tie(d, hold) !== "high") warnings.push(`${d}.${hold} must reach a ${board} pin (the firmware holds it high while ${k.name} runs).`);
        if (k.high < 0 && tie(d, hold) === "high") warnings.push(`${d}.${hold} is wired straight to a supply: at power-up ${k.name} gets the full supply before the firmware runs. Wire it to a ${board} pin instead.`);
        if (k.pwm < 0) warnings.push(`${d}.${sw} must reach a PWM pin on the ${board}: ${k.name} cannot be driven.`);
      } else if (scheme === "in1_in2_pwm") {
        const t1 = tie(d, `${ch}IN1`);
        const t2 = tie(d, `${ch}IN2`);
        // inputs wired to a supply and to ground fix the direction; on controller pins the firmware picks it
        k.dir = t1 === "high" && t2 === "low" ? 1 : t1 === "low" && t2 === "high" ? -1 : prefer;
        const hi = `${ch}IN${k.dir > 0 ? 1 : 2}`;
        const lo = `${ch}IN${k.dir > 0 ? 2 : 1}`;
        k.pwm = note(`${k.name} PWM (${d} PWM${ch})`, d, `PWM${ch}`);
        if (k.pwm < 0) warnings.push(`${d}.PWM${ch} must reach a PWM pin on the ${board}: ${k.name} cannot be driven.`);
        if (tie(d, hi) === "mcu") k.high = note(`${k.name} direction (${d} ${hi}, held high)`, d, hi);
        else if (tie(d, hi) !== "high") warnings.push(`${d}.${hi} must be wired to the logic supply (or a ${board} pin) to give ${k.name} a direction.`);
        if (tie(d, lo) === "mcu") k.low = note(`${k.name} direction (${d} ${lo}, held low)`, d, lo);
        else if (tie(d, lo) !== "low") warnings.push(`${d}.${lo} must be wired to ground (or a ${board} pin) to give ${k.name} a direction.`);
        if (k.dir !== prefer) warnings.push(`${k.name} is wired to push the magnet away (its field at the magnet runs against the magnet's): swap its two leads, or swap ${d}.${ch}IN1 and ${d}.${ch}IN2.`);
        const te = tie(d, "STBY");
        if (te === "mcu") {
          k.en = enSeen.has(d) ? pinNum(mcuPin(d, "STBY")?.pin.mcu ?? mcuPin(d, "STBY")?.pin.id) : note(`${d} standby (high = on)`, d, "STBY");
          enSeen.add(d);
          enPins.add(k.en);
        } else if (te !== "high") warnings.push(`${d}.STBY must be wired high (the logic supply or a ${board} pin), or its outputs stay off.`);
      } else warnings.push(`${k.name} is on ${d}, a driver the levitation firmware does not run (it runs DRV8871 and TB6612FNG boards).`);
      chans.push(k);
    }
  }
  const loose = coilNames.filter((n) => !chans.some((k) => k.members.some((m) => m.w.mc.name === n)));
  if (loose.length) warnings.push(`${loose.join(", ")}: not on a driver output (START and END to one channel's two outputs, with a current monitor channel or another coil in series between), so the firmware cannot run ${loose.length === 1 ? "it" : "them"}.`);
  if (chans.length < 2) return none(`firmware ${c.fw.name}: a levitation loop needs a lift coil and steering coils, each on its own driver output; ${chans.length} of the design's ${coilComps.length} coils are wired to one.`);
  // the lift coil is the one that pulls the magnet up hardest at the hover point; the rest steer
  const liftN = chans.map((k) => dot(forcePerAmp(k, hov, mUp), up));
  const li = liftN.indexOf(Math.max(...liftN));
  const lift = chans[li];
  if (liftN[li] <= 0) return none(`firmware ${c.fw.name}: no coil pulls ${magnet.name} upward. Put the lift coil above the model with its axis along the magnet's north pole (or turn the magnet over).`);
  const steer = chans.filter((_, i) => i !== li).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const order = [lift, ...steer];
  const nSteer = steer.length;
  if (nSteer < 3) warnings.push(`Holding the model sideways takes at least three steering coils around its axis; the design has ${nSteer}, so it can only be pushed along one line.`);

  // ---- current monitors: which channel sits in series with each coil string
  const inas = c.m.components.filter((x) => catalogPart(x.catalogId)?.specs.chip === "INA3221");
  let shuntOhm = 0.05;
  for (const mon of inas) {
    const mp = catalogPart(mon.catalogId)!;
    shuntOhm = spec(mp, "shunt_ohm", 0.05);
    const addr = parseInt(String(mp.specs.i2c_addr ?? "0x40"), 16);
    for (let ch = 1; ch <= 3; ch++) {
      const sides = shuntSides(c.nl, mon.name, ch);
      for (const k of order) {
        if (k.ina) continue;
        for (const m of k.members) {
          const f = shuntFacing(sides, m.w.mc.name);
          if (!f) continue;
          k.ina = addr;
          k.ch3 = ch;
          k.sign = f.sign * m.sign * k.dir;
          k.rPath += shuntOhm;
          // the string's low end is the lead on the output that stays near ground while the other switches
          const lowEnd = k.members[k.dir > 0 ? k.members.length - 1 : 0];
          const atLow = m === lowEnd && f.atMinus === (m.sign * k.dir > 0);
          if (!atLow) warnings.push(`${mon.name} channel ${ch} is not on the lead of ${k.name} that goes back to the driver's low side: put it there, where the voltage stays near ground, for a clean reading.`);
          break;
        }
      }
    }
  }
  const blind = order.filter((k) => !k.ina).map((k) => k.name);
  if (blind.length) warnings.push(`${blind.join(", ")}: no current monitor channel is in series (INA3221: the coil's END lead to VINn+, VINn- on to the driver). The firmware needs each coil's current to take its field out of the sensor's reading and to weigh the forces.`);
  const undriven = order.filter((k) => k.pwm < 0).map((k) => k.name);
  if (order.some((k) => k === lift && (k.pwm < 0 || !k.ina))) return none(`firmware ${c.fw.name}: the lift coil ${lift.name} needs a driver the ${board} controls and a current monitor channel in series before it can float anything.`);
  const inaAddrs = [...new Set(order.filter((k) => k.ina).map((k) => k.ina))].sort((a, b) => a - b);
  for (const mon of [sensor, ...inas]) {
    note(`${mon.name} SDA`, mon.name, "SDA");
    note(`${mon.name} SCL`, mon.name, "SCL");
  }

  // ---- the tunnel's fan and pressure gauge, when the design has them
  const fan = c.m.components.find((x) => catalogPart(x.catalogId)?.specs.iface === "pwm_fan");
  const fanPart = fan ? catalogPart(fan.catalogId)! : undefined;
  const fanPwm = fan ? note("fan PWM", fan.name, "PWM") : -1;
  const fanTach = fan ? note("fan tacho", fan.name, "TACH") : -1;
  if (fan && fanPwm < 0) warnings.push(`${fan.name}: its PWM wire reaches no ${board} pin, so it runs flat out whenever it has power.`);
  const gauge = c.m.components.find((x) => /^SDP8/.test(String(catalogPart(x.catalogId)?.specs.chip ?? "")));
  const gaugePart = gauge ? catalogPart(gauge.catalogId)! : undefined;
  if (gauge) {
    note(`${gauge.name} SDA`, gauge.name, "SDA");
    note(`${gauge.name} SCL`, gauge.name, "SCL");
  }
  const qtPower = Number(bp.specs.qt_power_pin ?? -1);

  // ---- settings
  const flowIn = listSetting(c, "flow", [1, 0, 0], warnings, 3);
  const fl = Math.hypot(flowIn[0], flowIn[1]) || 1;
  const flow: Vec3 = [flowIn[0] / fl, flowIn[1] / fl, 0];
  const section = listSetting(c, "section", [60, 50], warnings, 2);
  const sweep = listSetting(c, "sweep", [30, 45, 60, 80, 100], warnings)
    .map((x) => Math.max(0, Math.min(100, x)))
    .slice(0, 12);
  if (c.fw.settings.model_g === undefined) warnings.push(`model_g: not given, so the firmware starts from 14.5 g for the floating model (it weighs the model itself once it floats).`);
  const S = {
    modelG: setting(c.fw, "model_g", 14.5),
    modelD: setting(c.fw, "model_d", 20),
    modelArea: setting(c.fw, "model_area", 0),
    contraction: Math.max(1.2, setting(c.fw, "contraction", 6)),
    qGain: setting(c.fw, "q_gain", 1),
    supplyV: setting(c.fw, "supply_v", 12),
    pwmHz: setting(c.fw, "pwm_hz", 20000),
    kzP: setting(c.fw, "kz_p", 60),
    kzD: setting(c.fw, "kz_d", 2),
    kzI: setting(c.fw, "kz_i", 120),
    kzHz: setting(c.fw, "kz_d_hz", 60),
    kxP: setting(c.fw, "kx_p", 3),
    kxD: setting(c.fw, "kx_d", 0.25),
    kxI: setting(c.fw, "kx_i", 8),
    kxHz: setting(c.fw, "kx_d_hz", 15),
    bias: setting(c.fw, "steer_bias", 0.25),
    liftMax: setting(c.fw, "lift_i_max", 2),
    steerMax: setting(c.fw, "steer_i_max", 0.9),
    launchS: setting(c.fw, "launch_s", 1.5),
    settleS: setting(c.fw, "sweep_settle_s", 3),
    avgS: setting(c.fw, "sweep_avg_s", 2),
    autoTare: setting(c.fw, "auto_tare", true),
    padScale: setting(c.fw, "pad_scale", true),
    dragCal: setting(c.fw, "drag_cal", 0),
    baud: setting(c.fw, "baud", 500000),
  };
  const area = S.modelArea > 0 ? S.modelArea : (Math.PI / 4) * S.modelD * S.modelD;
  const blockage = 1 + (0.25 * area) / (section[0] * section[1]);
  const weight = (S.modelG / 1000) * G0;
  // the ESP32's PWM timer counts an 80 MHz clock: the resolution that leaves at this rate
  const pwmBits = Math.max(8, Math.min(12, Math.floor(Math.log2(80e6 / S.pwmHz))));

  // ---- magnetic constants, from the geometry
  const N = 33;
  const zLo = -(hoverMm + 3) * MM;
  const zHi = Math.min(hoverMm, 12) * MM;
  const zs = Array.from({ length: N }, (_, i) => zLo + ((zHi - zLo) * i) / (N - 1));
  const at = (z: number, dx = 0): Vec3 => add(add(hov, up, z), [1, 0, 0], dx);
  // the magnet's own field at the sensor against its height: what the height estimate reads
  const bzAt = (z: number) => sgn * dot(magField.at(at(z), scale(up, sgn), sAt), up) * 1000;
  const sOf = (z: number) => bzAt(z) ** (-1 / 3);
  const fine = Array.from({ length: 241 }, (_, i) => zLo + ((zHi - zLo) * i) / 240);
  const fineS = fine.map(sOf);
  const s0 = fineS[0];
  const s1 = fineS[fineS.length - 1];
  const zOfS = Array.from({ length: N }, (_, i) => {
    const s = s0 + ((s1 - s0) * i) / (N - 1);
    let j = 1;
    while (j < fineS.length - 1 && fineS[j] < s) j++;
    const f = (s - fineS[j - 1]) / (fineS[j] - fineS[j - 1] || 1);
    return fine[j - 1] + f * (fine[j] - fine[j - 1]);
  });
  const kl = zs.map((z) => dot(forcePerAmp(lift, at(z), mUp), up));
  const steerF = (z: number) => steer.map((k) => forcePerAmp(k, at(z), mUp));
  const f0 = steerF(0);
  // A floating magnet turns to lie along the field it sits in, and off the lift coil's axis that field leans, so
  // the magnet does too. What holds the model up at each height: the lift current for its weight, and the
  // steering coils on the bias they idle at once it is clear of its rest.
  const restZ = -hoverMm * MM;
  const holdAmps = (z: number) => {
    const depth = Math.max(0, Math.min(1, (z - 0.7 * restZ) / (-0.5 * restZ)));
    const iS = steer.map(() => S.bias * depth);
    const fs = steerF(z);
    const klz = dot(forcePerAmp(lift, at(z), mUp), up);
    const iL = Math.max(0, Math.min(S.liftMax, (weight - fs.reduce((t, f, i) => t + iS[i] * dot(f, up), 0)) / (klz || 1)));
    return { iL, iS };
  };
  const coilsAt = (p: Vec3, iL: number, iS: number[]): Vec3 => steer.reduce((B, k, i) => add(B, k.at(p), iS[i]), scale(lift.at(p), iL));
  const alignedAt = (p: Vec3, iL: number, iS: number[]): Vec3 => {
    const B = coilsAt(p, iL, iS);
    return dot(B, mUp) > 0 ? norm(B) : scale(up, sgn);
  };
  // sideways position per unit of (sideways field / vertical field) at the sensor, for the magnet lying along
  // the field as it floats. On its pad the model stands on its flat, so there the magnet is upright.
  const xr = zs.map((z) => {
    const { iL, iS } = holdAmps(z);
    const p = at(z, 0.0005);
    const upright = magField.at(p, scale(up, sgn), sAt);
    const b = z < restZ + 0.0006 ? upright : magField.at(p, alignedAt(p, iL, iS), sAt);
    const r = b[0] / dot(b, up);
    // (a ratio the lean has turned round or flattened is no use: fall back to the upright magnet's)
    return 0.0005 / (r > 0.3 * (upright[0] / dot(upright, up)) ? r : upright[0] / dot(upright, up));
  });
  // how hard the coils pull the floating model back to the lift coil's axis, N per metre off it: fed forward, so
  // a sideways move does not wait for the integrator
  // off the axis the sensor sees less vertical field from the same height: by this share per (offset / distance)²
  let zSide = 3;
  {
    const { iL, iS } = holdAmps(0);
    const p = at(0, 0.002);
    const b0 = dot(magField.at(at(0), scale(up, sgn), sAt), up);
    const b = dot(magField.at(p, alignedAt(p, iL, iS), sAt), up);
    const k = (1 - b / b0) / ((0.002 * 0.002) / (d0 * d0));
    if (Number.isFinite(k) && k > 0 && k < 12) zSide = k;
  }
  let kSide = 0;
  {
    const { iL, iS } = holdAmps(0);
    const p = at(0, 0.001);
    const m = scale(alignedAt(p, iL, iS), moment);
    const f = steer.reduce((F, k, i) => add(F, forcePerAmp(k, p, m), iS[i]), scale(forcePerAmp(lift, p, m), iL));
    const k = -f[0] / 0.001;
    if (Number.isFinite(k) && k > -20 && k < 60) kSide = k;
  }
  const hSum = (fs: Vec3[]) => fs.reduce((s, f) => s + Math.hypot(f[0], f[1]), 0);
  const vSum = (fs: Vec3[]) => fs.reduce((s, f) => s + f[2], 0);
  const hg = zs.map((z) => (nSteer && hSum(f0) > 0 ? hSum(steerF(z)) / hSum(f0) : 1));
  const vg = zs.map((z) => (nSteer && Math.abs(vSum(f0)) > 1e-9 ? vSum(steerF(z)) / vSum(f0) : 1));
  // currents for a sideways force: the smallest set that gives it (the pseudo-inverse of the coils' pushes)
  const a11 = f0.reduce((s, f) => s + f[0] * f[0], 0);
  const a12 = f0.reduce((s, f) => s + f[0] * f[1], 0);
  const a22 = f0.reduce((s, f) => s + f[1] * f[1], 0);
  const det = a11 * a22 - a12 * a12;
  const flat = det < 1e-12 * Math.max(1e-12, a11 * a22 + a12 * a12 + 1e-12);
  const px = f0.map((f) => (flat ? (a11 + a22 > 0 ? f[0] / (a11 + a22) : 0) : (f[0] * a22 - f[1] * a12) / det));
  const py = f0.map((f) => (flat ? (a11 + a22 > 0 ? f[1] / (a11 + a22) : 0) : (-f[0] * a12 + f[1] * a11) / det));
  // each coil's own field at the sensor per amp, in the rig's axes, mT
  const coilB = order.map((k) => scale(k.at(sAt), 1000));
  // a string with a nulling winding (a small coil round the sensor that cancels the big one's field there): the
  // nulling winding's own field at the sensor and its turns, so the coil check can say when it is the wrong way
  // round or a turn out
  const nulls = order.map((k) => {
    const size = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
    const parts = k.members.map((m) => ({ b: scale(m.w.field.at(sAt), 1000 * k.dir * m.sign), turns: spec(m.w.part, "turns", 0), pull: size(forcePerAmp(m.w.field, hov, mUp)) }));
    if (parts.length < 2) return { b: [0, 0, 0] as Vec3, turns: 0 };
    // the working coil is the one that moves the magnet most
    const main = parts.reduce((a, b) => (b.pull > a.pull ? b : a));
    const net = parts.reduce((t, x) => add(t, x.b), [0, 0, 0] as Vec3);
    if (size(net) > 0.25 * size(main.b)) return { b: [0, 0, 0] as Vec3, turns: 0 };
    const rest = parts.filter((x) => x !== main);
    return { b: rest.reduce((t, x) => add(t, x.b), [0, 0, 0] as Vec3), turns: rest.reduce((t, x) => t + x.turns, 0) };
  });
  // the sensor chip's axes in the rig's: rig j = sum over chip axes i of reading i x (axis i's part along j)
  const senR = [0, 1, 2].map((j) => [0, 1, 2].map((i) => Math.round(sf[i][j] * 1e4) / 1e4));

  // how hard the steering really pushes when the firmware asks for a force. A floating magnet leans to follow
  // the field it sits in, and the loop holds where the sensor sees it, not where it is: both change the push a
  // little. Solve the leaning magnet's balance for a 10 mN command along the flow and compare.
  const liftAt = (z: number) => kl[Math.max(0, Math.min(N - 1, Math.round(((z - zLo) / (zHi - zLo)) * (N - 1))))];
  let eff = 1;
  if (nSteer >= 2 && !flat) {
    const cmd: Vec3 = scale(flow, -0.01);
    const d = f0.map((_, k) => px[k] * cmd[0] + py[k] * cmd[1]);
    const b = Math.max(S.bias, -Math.min(...d));
    const amps = d.map((x) => b + x);
    // where the sensor sees a magnet that leans by th (rad, toward the flow) and sits x downstream: zero when x = cApp * th
    const lean = (th: number): Vec3 => norm(add(scale(up, sgn * Math.cos(th)), flow, Math.sin(th)));
    const seen = (x: number, th: number) => dot(magField.at(add(hov, flow, x), lean(th), sAt), flow);
    const cApp = -((seen(0, 0.01) - seen(0, -0.01)) / 0.02) / ((seen(0.0002, 0) - seen(-0.0002, 0)) / 0.0004);
    let x = 0;
    let th = 0;
    let iL = weight / liftAt(0);
    let fTrue = 0;
    for (let it = 0; it < 60; it++) {
      const p = add(hov, flow, x);
      const B = scale(lift.at(p), iL);
      steer.forEach((k, i) => {
        const bk = k.at(p);
        B[0] += amps[i] * bk[0];
        B[1] += amps[i] * bk[1];
        B[2] += amps[i] * bk[2];
      });
      const want = Math.atan2(dot(B, flow), sgn * dot(B, up));
      th += 0.5 * (want - th);
      x += 0.5 * (cApp * th - x);
      const m = scale(lean(th), moment);
      const fl2 = forcePerAmp(lift, p, m);
      const fs = steer.map((k) => forcePerAmp(k, p, m));
      const down = fs.reduce((s, f, i) => s + amps[i] * f[2], 0);
      iL += 0.5 * ((weight - down) / fl2[2] - iL);
      fTrue = iL * dot(fl2, flow) + fs.reduce((s, f, i) => s + amps[i] * dot(f, flow), 0);
    }
    const r = fTrue / dot(cmd, flow);
    if (Number.isFinite(r) && r > 0.3 && r < 3) eff = r;
    else warnings.push(`The steering coils' real push on the leaning magnet could not be worked out (${cNum(r)}): the drag reading uses their plain force constants until it is calibrated with "cal".`);
  }
  if (S.dragCal > 0) eff = S.dragCal;

  // can it lift off from where it rests?
  const klRest = liftAt(-hoverMm * MM);
  const iRest = weight / klRest;
  const iHover = weight / liftAt(0);
  const iLimit = Math.min(S.liftMax, S.supplyV / (lift.r + lift.rPath));
  if (iRest > iLimit * 0.95) warnings.push(`Lifting the ${cNum(S.modelG)} g model off its rest takes ${cNum(iRest)} A in ${lift.name} and the driver and supply give ${cNum(iLimit)} A: rest it closer to the coil, lighten it, or raise the supply voltage.`);
  const steerPush = nSteer ? 0.5 * S.steerMax * f0.reduce((s, f) => s + Math.abs(f[0] * flow[0] + f[1] * flow[1]), 0) : 0;

  const name = ident(c.fw.name).toLowerCase() || "maglev";
  const dir0 = `firmware/${name}`;
  const arr = (xs: number[], digits = 5) => xs.map((x) => cFloat(Number(x.toPrecision(digits)))).join(", ");
  const ints = (xs: number[]) => xs.join(", ");
  const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
  const nC = order.length;
  const allEn = [...enPins];
  const rangeLo = spec(senPart, "range_mt", 40);
  const rangeHi = spec(senPart, "range_hi_mt", 80);
  const bRest = bzAt(-hoverMm * MM);
  const bHover = bzAt(0);
  if (bRest > rangeHi * 0.93) warnings.push(`At rest ${magnet.name} puts ${cNum(bRest)} mT on ${sensor.name}, past its ${rangeHi} mT range: move the sensor ${cNum(Math.ceil(((bRest / (rangeHi * 0.85)) ** (1 / 3) - 1) * dRest * 1000))} mm further below the floor.`);

  const config = `// ${cComment(c.designName)}: pins, magnetic constants and controller settings for ${cComment(c.fw.name)}.
// Generated by Kerf from the design's wiring and from where its coils, magnet and field sensor sit.
// Scenarios change the #defines.
#pragma once
#include <Arduino.h>

// ---- coils (${cComment(bp.name)} pins, from the wiring). Coil 0 lifts (${cComment(lift.name)}); the rest steer (${cComment(steer.map((k) => k.name).join(", ") || "none")})
#define N_STEER ${nSteer}
#define N_COILS ${nC}
// each coil's PWM pin; a pin held high and a pin held low while it runs (-1: wired that way); 1 when the PWM's
// low time is the drive time (DRV8871: one input held high, the other switched)
static const int COIL_PWM[N_COILS] = {${ints(order.map((k) => k.pwm))}};
static const int COIL_HIGH[N_COILS] = {${ints(order.map((k) => k.high))}};
static const int COIL_LOW[N_COILS] = {${ints(order.map((k) => k.low))}};
static const int COIL_INV[N_COILS] = {${ints(order.map((k) => (k.inverted ? 1 : 0)))}};
// driver standby pins held high while the coils run
#define N_ENABLE ${Math.max(1, allEn.length)}
static const int DRIVER_EN[N_ENABLE] = {${allEn.length ? ints(allEn) : "-1"}};
#define PWM_HZ ${Math.round(S.pwmHz)}
#define PWM_BITS ${pwmBits}
#define SUPPLY_V ${cFloat(S.supplyV)}
// winding ohms at 20 C, the bridge and shunt in series with it, and henries
static const float COIL_R[N_COILS] = {${arr(order.map((k) => k.r), 4)}};
static const float COIL_R_PATH[N_COILS] = {${arr(order.map((k) => k.rPath), 4)}};
static const float COIL_L[N_COILS] = {${arr(order.map((k) => k.l), 4)}};
// for the temperature estimate: J/K of the copper, W/K it sheds to still air
static const float COIL_CTH[N_COILS] = {${arr(order.map((k) => k.cth), 4)}};
static const float COIL_HA[N_COILS] = {${arr(order.map((k) => k.ha), 3)}};
#define COIL_TEMP_MAX ${cFloat(Math.min(...order.map((k) => k.tempMax)) - 15)}
#define LIFT_I_MAX ${cFloat(S.liftMax)}
#define STEER_I_MAX ${cFloat(S.steerMax)}
#define STEER_BIAS ${cFloat(S.bias)}

// ---- current monitors (INA3221): each coil's address, channel 1 to 3 and sign (+1: reads positive for current in at START)
#define N_INA ${Math.max(1, inaAddrs.length)}
static const int INA_ADDR[N_INA] = {${inaAddrs.length ? inaAddrs.map(hex).join(", ") : "0x40"}};
static const int COIL_INA[N_COILS] = {${order.map((k) => hex(k.ina || 0x40)).join(", ")}};
static const int COIL_CH[N_COILS] = {${ints(order.map((k) => k.ch3 || 1))}};
static const int COIL_SIGN[N_COILS] = {${ints(order.map((k) => k.sign))}};
#define SHUNT_OHM ${cFloat(shuntOhm)}

// ---- field sensor (${cComment(senPart.name)})
#define TMAG_ADDR ${hex(parseInt(String(senPart.specs.i2c_addr ?? "0x35"), 16))}
#define TMAG_RANGE_MT ${cFloat(rangeLo)}
#define TMAG_RANGE_HI_MT ${cFloat(rangeHi)}
// the chip's axes to the rig's (X, Y, Z) as the design mounts the board: rig = SENSOR_R x chip
#define SENSOR_R { ${senR.map((r) => `{ ${r.map((v) => cFloat(v)).join(", ")} }`).join(", ")} }
// +1 with the magnet's north pole up, -1 with it down
#define MAG_SIGN ${sgn}
// each coil's own field at the sensor, mT per amp in the rig's axes ("coilcal" measures yours)
static const float COIL_B[N_COILS][3] = {${coilB.map((b) => `{${arr(b, 5)}}`).join(", ")}};
// for a coil with a nulling winding in series: that winding's own field at the sensor, mT per amp, and its turns
static const float COIL_NULL_B[N_COILS][3] = {${nulls.map((n) => `{${arr(n.b, 5)}}`).join(", ")}};
static const float COIL_NULL_TURNS[N_COILS] = {${arr(nulls.map((n) => n.turns), 4)}};

// ---- the model and where it floats (from the design: ${cComment(magnet.name)}, ${cNum(moment)} A m2, resting ${cNum(dRest * 1000)} mm above the sensor)
#define HOVER_MM ${cFloat(hoverMm)}
#define MODEL_G ${cFloat(S.modelG)}
// the magnet's field at the sensor resting and floating, mT
#define FIELD_REST_MT ${cFloat(Number(bRest.toPrecision(4)))}
#define FIELD_HOVER_MT ${cFloat(Number(bHover.toPrecision(4)))}
// height (m, from the hover point) against field^(-1/3) (field in mT), evenly spaced in that
#define TAB_N ${N}
#define S_TAB_0 ${cFloat(Number(s0.toPrecision(7)))}
#define S_TAB_STEP ${cFloat(Number(((s1 - s0) / (N - 1)).toPrecision(7)))}
static const float Z_OF_S[TAB_N] = {${arr(zOfS, 5)}};
// against height, from Z_TAB_0 in steps of Z_TAB_STEP (m): the lift coil's pull (N per amp), metres sideways per
// unit of sideways field over vertical field, and the steering coils' sideways push and vertical pull as shares
// of their values at the hover point
#define Z_TAB_0 ${cFloat(Number(zLo.toPrecision(6)))}
#define Z_TAB_STEP ${cFloat(Number(((zHi - zLo) / (N - 1)).toPrecision(6)))}
static const float TAB_KL[TAB_N] = {${arr(kl, 5)}};
static const float TAB_XR[TAB_N] = {${arr(xr, 5)}};
static const float TAB_HG[TAB_N] = {${arr(hg, 5)}};
static const float TAB_VG[TAB_N] = {${arr(vg, 5)}};
// each steering coil's force on the magnet at the hover point, N per amp (X, Y, Z), and the amps each takes per
// newton of sideways force wanted (X, Y)
static const float STEER_F[${Math.max(1, nSteer)}][3] = {${nSteer ? f0.map((f) => `{${arr(f, 5)}}`).join(", ") : "{0, 0, 0}"}};
static const float STEER_PX[${Math.max(1, nSteer)}] = {${nSteer ? arr(px, 5) : "0"}};
static const float STEER_PY[${Math.max(1, nSteer)}] = {${nSteer ? arr(py, 5) : "0"}};
// the steering's real push on the floating (leaning) magnet over its plain force constants; "cal" measures yours
#define STEER_EFF ${cFloat(Number(eff.toPrecision(4)))}

// ---- position loops: force per metre, per metre a second and per metre-second
#define KZ_P ${cFloat(S.kzP)}
#define KZ_D ${cFloat(S.kzD)}
#define KZ_I ${cFloat(S.kzI)}
#define KZ_D_HZ ${cFloat(S.kzHz)}
#define KX_P ${cFloat(S.kxP)}
#define KX_D ${cFloat(S.kxD)}
#define KX_I ${cFloat(S.kxI)}
#define KX_D_HZ ${cFloat(S.kxHz)}
// off the axis the same height gives less vertical field: the share lost per (offset / distance to the sensor)²,
// and that distance at the hover point, m
#define Z_SIDE ${cFloat(Number(zSide.toPrecision(4)))}
#define SENSOR_D0 ${cFloat(Number(Math.abs(d0).toPrecision(5)))}
// the pull back to the lift coil's axis, N per metre off it (fed forward when the model is sent sideways)
#define K_SIDE ${cFloat(Number(kSide.toPrecision(4)))}
// current loops: volts per amp of error as a share of L / dt, and volts per amp-second
#define CUR_KP 0.4f
#define CUR_KI 400.0f
#define LAUNCH_S ${cFloat(S.launchS)}
#define LOOP_US 2000
// the model is lost when the sensor sees less than this, or it strays this far, for LOST_MS
#define FIELD_MIN_MT ${cFloat(Number((bzAt(zHi) * 0.45).toPrecision(3)))}
#define LOST_XY_MM 9.0f
#define LOST_MS 150
#define SENSOR_TIMEOUT_MS 20

// ---- wind${fan ? ` (${cComment(fanPart!.name)})` : ": no fan in the design"}
#define PIN_FAN_PWM ${fanPwm}
#define PIN_FAN_TACH ${fanTach}
#define FAN_PWM_HZ ${Math.round(spec(fanPart ?? magPart, "pwm_hz", 25000))}
#define FAN_TACH_PPR ${Math.round(spec(fanPart ?? magPart, "tach_ppr", 2))}
#define FAN_SLEW_PCT_S 60.0f
#define HAS_GAUGE ${gauge ? 1 : 0}
#define SDP_ADDR ${hex(parseInt(String(gaugePart?.specs.i2c_addr ?? "0x25"), 16))}
// the gauge reads across the contraction: the test section's dynamic pressure is its reading x Q_GAIN
#define Q_GAIN ${cFloat(Number((S.qGain / (1 - 1 / (S.contraction * S.contraction))).toPrecision(5)))}
#define AIR_PRESSURE_PA 101325.0f
// the model's frontal area, mm2, its size for the Reynolds number, mm, and how much the walls speed the air past it
#define MODEL_AREA_MM2 ${cFloat(Number(area.toPrecision(5)))}
#define MODEL_D_MM ${cFloat(S.modelD)}
#define BLOCKAGE ${cFloat(Number(blockage.toPrecision(5)))}
// the flow's direction in the rig's axes: drag is the force along it
#define FLOW_X ${cFloat(flow[0])}
#define FLOW_Y ${cFloat(flow[1])}
#define N_SWEEP ${sweep.length}
static const float SWEEP_PCT[N_SWEEP] = {${arr(sweep, 4)}};
#define SWEEP_SETTLE_S ${cFloat(S.settleS)}
#define SWEEP_AVG_S ${cFloat(S.avgS)}
#define AUTO_TARE ${S.autoTare ? 1 : 0}
// 1: at each launch, set the field reading's scale from the model resting on its pad (a known distance)
#define PAD_SCALE ${S.padScale ? 1 : 0}

#define PIN_I2C_POWER ${qtPower}
#define PIN_LED ${pinNum(String(Number(bp.specs.led_builtin ?? 13)))}
#define BAUD ${Math.round(S.baud)}
`;

  const ino = sketch(c, { liftName: lift.name, hasFan: !!fan });

  const wiring = pinTable.map((p) => `| ${p.signal} | ${p.pin} | ${p.wire} |`).join("\n");
  const readme = `# ${oneLine(c.designName)}: ${oneLine(c.fw.name)}

Magnetic levitation firmware for the ${oneLine(bp.name)}, generated by Kerf from the design's wiring and geometry. What you calibrate lives in flash (\`save\`); everything else is in \`config.h\`.

## Build

Arduino IDE 2: board **${oneLine(String(bp.specs.fqbn ?? bp.name))}** (arduino-esp32 core 3.x). No libraries beyond the core. USB serial at ${Math.round(S.baud)} baud; type \`help\`.

## Pins

| Signal | Pin | Wire |
|---|---|---|
${wiring}

## What it does

A 500 Hz loop reads the field sensor (X, Y and Z in one burst) and each coil's current, takes the coils' own fields out of the reading, and turns what is left into the model's position: height from the vertical field (it falls with the cube of the distance; a table from the design turns it into millimetres) and sideways position from the ratio of sideways to vertical field. A PD + I loop on height sets the lift coil's current (${cNum(Number(iHover.toFixed(2)))} A floating, ${cNum(Number(iRest.toFixed(2)))} A to leave the floor); PD + I loops on X and Y share a sideways force between the ${nSteer} steering coils, each of which only pulls, around a ${cNum(S.bias)} A bias. Each coil has its own current loop writing ${Math.round(S.pwmHz / 1000)} kHz PWM.

The forces on the model are read from the currents: what the coils must push to hold it still, less what they pushed with the wind off (\`tare\`). Drag is the part along the flow, corrected by the factor in STEER_EFF (${cNum(Number(eff.toFixed(3)))} from the design; \`cal\` measures yours). The steering coils can hold about ${cNum(Number((steerPush * eff * 1000).toFixed(0)))} mN.

Safety: the coils and the fan switch off when the model is lost (the sensor sees no magnet, or it strays ${9} mm sideways), when the sensor or a current monitor stops answering or freezes, or when a coil's estimated temperature passes ${cNum(Math.min(...order.map((k) => k.tempMax)) - 15)} °C. The fan only runs while the model floats, and backs off when the steering coils reach their limit.

## Bench order

1. **Coils and sensor, model out**: \`zero\` stores the sensor's reading with nothing near it (its own offset and the Earth's field). \`coilcal\` then pulses each coil and stores its real field at the sensor; it tells you if a coil is wired backwards. \`save\`.
2. **First float**: rest the model on its pad, marked pole up, and \`launch\`. It rises ${cNum(hoverMm)} mm in ${cNum(S.launchS)} s and prints its weight. \`land\` sets it down. Each launch first sets the sensor's scale from the model resting on its pad, ${cNum(Number((dRest * 1000).toFixed(2)))} mm above the sensor in the design: that takes out the chip's gain error and a magnet a little stronger or weaker than its grade (\`pad_scale: false\` turns it off).
3. **Steps**: \`step z 1\`, \`step x 1\` print the rise time, overshoot and settling of a 1 mm move. \`go 2 0 1\` moves it; \`orbit 2 4\` flies a 2 mm circle every 4 s.
4. **Wind**: \`fan 40\`, or \`sweep\` for the whole run: it tares with the wind off, steps the fan through ${sweep.join(", ")} %, and prints speed, Reynolds number, drag and drag coefficient at each.
5. **Drag calibration**: tilt the tunnel nose-down by a known angle (the model's weight times the sine of the angle pulls it downstream), type \`cal <mN>\`, then \`save\`.

## Data stream

\`log on\` prints a line every 20 ms for the control room app:

\`T,ms,mode,x,y,z,zref (µm),iLift,i1..i${nSteer} (mA),fx,fy,fz (magnetic force, 0.01 mN),drag,side,lift (0.01 mN),dp (0.01 Pa),speed (cm/s),rpm,fan (%),coil temperatures lift and steering (0.1 °C),air (0.1 °C),sway (µm),loop (µs)\`

\`info\` prints the rig's numbers as \`I,key,value\` lines. Sweep points come as \`S,...\` lines.
`;
  if (undriven.length) warnings.push(`${undriven.join(", ")}: no PWM pin, so ${undriven.length === 1 ? "it stays" : "they stay"} off.`);
  return {
    files: [
      { path: `${dir0}/${name}.ino`, content: ino },
      { path: `${dir0}/config.h`, content: config },
      { path: `${dir0}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
    summary: `ESP32 sketch for ${bp.name}: magnetic levitation at 500 Hz (field sensor to position, PD + I loops, a current loop per coil at ${Math.round(S.pwmHz / 1000)} kHz)${fan ? ", wind tunnel fan, speed sweeps and drag from the coil currents" : ""}, with launch, landing and lost-model cut-out`,
  };
}

function sketch(c: FwContext, o: { liftName: string; hasFan: boolean }): string {
  const bp = c.boardPart;
  return `// ${cComment(c.designName)}: magnetic levitation firmware for the ${cComment(bp.name)}, generated by Kerf.
//
// 500 Hz loop: field sensor and coil currents -> the model's position -> PD + I loops -> a current loop per
// coil -> ${o.hasFan ? "PWM. The wind tunnel's fan, air speed and the forces on the model ride on top." : "PWM."}
// Console: USB serial, type "help". Board: ${cComment(String(bp.specs.fqbn ?? bp.name))}.
#include <Arduino.h>
#include <Wire.h>
#include <EEPROM.h>
#include "config.h"

#define G0 9.80665f
#define PWM_MAX ((1 << PWM_BITS) - 1)

// ---- what the rig is doing (the simulator and the control room plot these)
float zMm = -HOVER_MM;      // the model's height from the hover point, mm
float xMm = 0;              // and where it sits sideways, mm
float yMm = 0;
float zRefMm = -HOVER_MM;   // the height asked for
float liftAmps = 0;         // lift coil current
float steerAmps = 0;        // the largest steering coil current
float dragMn = 0;           // air forces on the model, mN: along the flow, across it, and up
float sideMn = 0;
float liftMn = 0;
float airspeed = 0;         // m/s in the test section
float dpPa = 0;             // the gauge's reading
float fanRpm = 0;
float fanPct = 0;
float cdNow = 0;            // drag coefficient
float reynolds = 0;
float fieldMt = 0;          // the magnet's field at the sensor
float modelGrams = 0;       // the model's weight, from the current that holds it
float liftTempC = 25;       // coil temperatures (estimated from their currents)
float steerTempC = 25;
float swayUm = 0;           // how far it wanders from where it is held, rms
float steerMn = 0;          // sideways force the steering coils are making
float loopUs = 0;           // the longest loop pass lately
uint8_t mode = 0;
uint32_t overruns = 0;

enum Mode : uint8_t { M_IDLE, M_LAUNCH, M_FLOAT, M_LAND, M_COILCAL, M_FAULT };
uint8_t shownMode = 255;
char faultText[72];

// ---- coils
float iMeas[N_COILS];
float iZero[N_COILS];
float iDes[N_COILS];
float vInt[N_COILS];
uint32_t stuckSince[N_COILS];
uint32_t openSince[N_COILS];
int frozen[N_COILS];
int16_t seenRaw[N_COILS];
float lastV[N_COILS];
float coilTemp[N_COILS];
int16_t lastInaRaw[N_COILS];
int inaSame = 0;
bool coilsLive = false;
bool steerSat = false;
uint32_t satSince = 0;

// ---- field sensor
const float sensorR[3][3] = SENSOR_R;
float coilB[N_COILS][3];
float bZero[3] = {0, 0, 0};
float bRig[3] = {0, 0, 0};
float bMag[3] = {0, 0, 0};
int16_t lastField[3];
int fieldSame = 0;
int skipField = 0;
bool rangeHi = true;
bool tmagFound = false;
bool inaFound = false;
bool present = false;
bool onPad = false;
// the magnet's field as the sensor reads it against the design's: found from the model resting on its pad
float fieldScale = 1;
float axisField = 0;
float restField = 0;
int restN = 0;
uint32_t lastFieldOk = 0;
uint32_t lastInaOk = 0;

// ---- estimate and control (SI: metres, newtons)
float zEst = -HOVER_MM * 0.001f, xEst = 0, yEst = 0;
float vz = 0, vx = 0, vy = 0;
bool estStarted = false;
float zRef = 0, xRef = 0, yRef = 0;
float xGoal = 0, yGoal = 0, zGoal = 0;
float xTrim = 0, yTrim = 0;
float zInt = 0, xInt = 0, yInt = 0;
float weightN = MODEL_G * 0.001f * G0;
float fMag[3] = {0, 0, 0};
float fFilt[3] = {0, 0, 0};
float fTare[3] = {0, 0, 0};
float qTare = 0;
float steerEff = STEER_EFF;
float zStart = 0, xStart = 0, yStart = 0;
uint32_t modeAt = 0;
uint32_t lostSince = 0;
bool settled = false;
bool tared = false;
float sway2 = 0;
float orbitR = 0, orbitPeriod = 4;

// ---- wind
float fanTarget = 0;
float qPa = 0;
float airTempC = 25;
float airDensity = 1.2f;
bool sdpFound = false;
volatile uint32_t tachCount = 0;
volatile uint32_t tachFirst = 0;
volatile uint32_t tachLast = 0;
uint32_t lastTach = 0;
uint32_t lastSdp = 0;
bool windHeld = false;
// calm air: the fan off and the pressure no longer falling
uint32_t windOffAt = 0;
uint32_t lastCalm = 0;
float qPrev = 0;
bool qSteady = false;
bool airCalm = false;
uint32_t fanDeadAt = 0;
bool fanDead = false;
int sdpMiss = 0;
bool gaugeLost = false;

// ---- tare, sweep, step and calibration
int tareLeft = 0;
float tareSum[3];
float tareQ = 0;
int tareN = 0;
int sweepI = -2;
uint32_t sweepAt = 0;
float sweepAcc[8];
int sweepN = 0;
float sweepCdLo = 0, sweepCdHi = 0;
int stepAxis = -1;
float stepMm = 0, stepY0 = 0, stepPeak = 0, stepT10 = -1, stepT90 = -1, stepSettle = 0;
float stepPos = 0, stepEnd = 0;
int stepEndN = 0;
uint32_t stepAt = 0;
int calCoil = -1;
uint32_t calAt = 0;
float calB0[3], calB[3], calI = 0;
int calN0 = 0, calN = 0;
int zeroLeft = 0;
float zeroSum[3];

uint32_t lastTick = 0;
uint32_t lastLog = 0;
uint32_t loopWorst = 0;
bool logOn = false;
char line[64];
uint8_t lineLen = 0;

// ---------------------------------------------------------------- I2C
bool busWrite8(uint8_t addr, uint8_t reg, uint8_t v) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(v);
  return Wire.endTransmission() == 0;
}

bool busRead(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

// INA3221: sixteen-bit registers, high byte first
bool inaWrite(uint8_t addr, uint8_t reg, uint16_t v) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write((uint8_t)(v >> 8));
  Wire.write((uint8_t)(v & 0xFF));
  return Wire.endTransmission() == 0;
}

bool inaRead(uint8_t addr, uint8_t reg, int16_t *out) {
  uint8_t b[2];
  if (!busRead(addr, reg, b, 2)) return false;
  *out = (int16_t)((b[0] << 8) | b[1]);
  return true;
}

bool inaBegin() {
  for (int i = 0; i < N_INA; i++) {
    int16_t id = 0;
    if (!inaRead(INA_ADDR[i], 0xFE, &id) || id != 0x5449) return false;
    inaWrite(INA_ADDR[i], 0x00, 0x8000);   // reset
    delay(2);
    // all three channels, shunt voltage only, continuous: 140 us conversions, 4 averaged, a set every 1.7 ms
    if (!inaWrite(INA_ADDR[i], 0x00, 0x7305)) return false;
  }
  return true;
}

// every coil's current, A (positive in at START); false when a monitor does not answer
bool readCurrents() {
  bool ok = true;
  bool same = true;
  for (int k = 0; k < N_COILS; k++) {
    int16_t raw = 0;
    if (!inaRead(COIL_INA[k], 2 * COIL_CH[k] - 1, &raw)) {
      ok = false;
      continue;
    }
    if (raw != lastInaRaw[k]) same = false;
    lastInaRaw[k] = raw;
    // 40 uV a step in the top 13 bits
    iMeas[k] = COIL_SIGN[k] * (raw / 8) * (40e-6f / SHUNT_OHM) - iZero[k];
  }
  inaSame = same ? inaSame + 1 : 0;
  return ok;
}

// TMAG5273: averaging 16, X Y Z, low-noise continuous conversion
bool tmagRange(bool hi) {
  rangeHi = hi;
  skipField = 1;
  return busWrite8(TMAG_ADDR, 0x03, hi ? 0x03 : 0x00);
}

bool tmagBegin() {
  uint8_t id[3];
  if (!busRead(TMAG_ADDR, 0x0D, id, 3) || id[1] != 0x49 || id[2] != 0x54) return false;
  bool ok = busWrite8(TMAG_ADDR, 0x00, 0x10);   // 16 samples averaged: a result every 1.2 ms
  ok = ok && busWrite8(TMAG_ADDR, 0x02, 0x70);  // X, Y and Z
  ok = ok && busWrite8(TMAG_ADDR, 0x07, 0x00);  // no temperature channel
  ok = ok && tmagRange(true);
  ok = ok && busWrite8(TMAG_ADDR, 0x01, 0x12);  // low-noise, continuous
  return ok;
}

// the field at the sensor in the rig's axes, mT, less the stored zero; false when it does not answer
bool readField() {
  uint8_t b[7];
  if (!busRead(TMAG_ADDR, 0x12, b, 7)) return false;
  int16_t r[3];
  bool same = true;
  float worst = 0;
  for (int i = 0; i < 3; i++) {
    r[i] = (int16_t)((b[2 * i] << 8) | b[2 * i + 1]);
    if (r[i] != lastField[i]) same = false;
    lastField[i] = r[i];
  }
  fieldSame = same ? fieldSame + 1 : 0;
  if (skipField > 0) {
    // the conversion that was under way when the range changed
    skipField--;
    return true;
  }
  float range = rangeHi ? TMAG_RANGE_HI_MT : TMAG_RANGE_MT;
  float chip[3];
  for (int i = 0; i < 3; i++) {
    chip[i] = r[i] * range / 32768.0f;
    if (fabs(chip[i]) > worst) worst = fabs(chip[i]);
  }
  for (int j = 0; j < 3; j++) bRig[j] = sensorR[j][0] * chip[0] + sensorR[j][1] * chip[1] + sensorR[j][2] * chip[2] - bZero[j];
  // the finer range once the model is up and its field has fallen; the wider one near the floor
  if (!rangeHi && worst > 0.9f * TMAG_RANGE_MT) tmagRange(true);
  else if (rangeHi && worst < 0.75f * TMAG_RANGE_MT) tmagRange(false);
  return true;
}

// SDP8xx: continuous differential pressure, averaged between reads; each word comes with a CRC
uint8_t sdpCrc(uint8_t a, uint8_t b) {
  uint8_t crc = 0xFF;
  uint8_t d[2] = {a, b};
  for (int i = 0; i < 2; i++) {
    crc ^= d[i];
    for (int k = 0; k < 8; k++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
  }
  return crc;
}

bool sdpBegin() {
  Wire.beginTransmission(SDP_ADDR);
  Wire.write(0x3F);
  Wire.write(0xF9);   // stop, in case it was left running
  Wire.endTransmission();
  delay(1);
  Wire.beginTransmission(SDP_ADDR);
  Wire.write(0x36);
  Wire.write(0x15);
  return Wire.endTransmission() == 0;
}

bool sdpRead() {
  if (Wire.requestFrom(SDP_ADDR, 9) != 9) return false;
  uint8_t b[9];
  for (int i = 0; i < 9; i++) b[i] = Wire.read();
  if (sdpCrc(b[0], b[1]) != b[2] || sdpCrc(b[3], b[4]) != b[5] || sdpCrc(b[6], b[7]) != b[8]) return false;
  int16_t dp = (int16_t)((b[0] << 8) | b[1]);
  int16_t tc = (int16_t)((b[3] << 8) | b[4]);
  int16_t sc = (int16_t)((b[6] << 8) | b[7]);
  if (sc <= 0) return false;
  dpPa = (float)dp / sc;
  airTempC = tc / 200.0f;
  return true;
}

// ---------------------------------------------------------------- coil outputs
// average volts across coil k, 0 to the supply
void coilVolts(int k, float v) {
  if (COIL_PWM[k] < 0) return;
  float u = constrain(v / SUPPLY_V, 0.0f, 1.0f);
  uint32_t d = (uint32_t)(u * PWM_MAX + 0.5f);
  ledcWrite(COIL_PWM[k], COIL_INV[k] ? PWM_MAX - d : d);
}

void coilsOn() {
  if (coilsLive) return;
  for (int k = 0; k < N_COILS; k++) {
    vInt[k] = 0;
    iDes[k] = 0;
    stuckSince[k] = 0;
    openSince[k] = 0;
    frozen[k] = 0;
    lastV[k] = 0;
    coilVolts(k, 0);
    if (COIL_LOW[k] >= 0) digitalWrite(COIL_LOW[k], LOW);
    if (COIL_HIGH[k] >= 0) digitalWrite(COIL_HIGH[k], HIGH);
  }
  for (int i = 0; i < N_ENABLE; i++)
    if (DRIVER_EN[i] >= 0) digitalWrite(DRIVER_EN[i], HIGH);
  coilsLive = true;
}

// outputs open: the currents run back into the supply and are gone in a millisecond or two
void coilsOff() {
  for (int i = 0; i < N_ENABLE; i++)
    if (DRIVER_EN[i] >= 0) digitalWrite(DRIVER_EN[i], LOW);
  for (int k = 0; k < N_COILS; k++) {
    if (COIL_HIGH[k] >= 0) digitalWrite(COIL_HIGH[k], LOW);
    if (COIL_PWM[k] >= 0) ledcWrite(COIL_PWM[k], 0);
    iDes[k] = 0;
    vInt[k] = 0;
  }
  coilsLive = false;
}

// one coil's current loop: the volts its resistance takes, plus a push on the error
void currentLoop(int k, float dt) {
  float r = COIL_R[k] * (1 + 0.00393f * (coilTemp[k] - 20)) + COIL_R_PATH[k];
  float e = iDes[k] - iMeas[k];
  float v = r * iDes[k] + CUR_KP * COIL_L[k] / dt * e + vInt[k];
  // the integral waits while the output is at a rail
  if ((v < SUPPLY_V || e < 0) && (v > 0 || e > 0)) vInt[k] = constrain(vInt[k] + CUR_KI * e * dt, -4.0f, 4.0f);
  // a healthy coil needs a volt of it at most (a warm winding, a sagging supply). At its limit the current is not
  // following the voltage: an open wire, a dead driver channel, or a monitor that has stopped
  if (fabs(vInt[k]) < 3.95f) stuckSince[k] = 0;
  else if (stuckSince[k] == 0) stuckSince[k] = millis() | 1;
  // a monitor that has stopped: the voltage keeps moving and the reading does not move at all
  float vc = constrain(v, 0.0f, SUPPLY_V);
  if (lastInaRaw[k] != seenRaw[k]) frozen[k] = 0;
  else if (fabs(vc - lastV[k]) > 0.05f && frozen[k] < 1000) frozen[k]++;
  seenRaw[k] = lastInaRaw[k];
  lastV[k] = vc;
  // asked for current and carrying next to none: an open wire, or no supply
  if (iDes[k] < 0.2f || iMeas[k] > 0.25f * iDes[k]) openSince[k] = 0;
  else if (openSince[k] == 0) openSince[k] = millis() | 1;
  coilVolts(k, v);
}

// the first coil whose reading has stood still through 60 changes of its voltage, or -1
int frozenCoil() {
  for (int k = 0; k < N_COILS; k++)
    if (frozen[k] >= 60) return k;
  return -1;
}

// how many coils have carried nothing for 150 ms though asked to; firstDead is the first of them
int firstDead = -1;
int deadCoils(uint32_t now) {
  int n = 0;
  firstDead = -1;
  for (int k = 0; k < N_COILS; k++)
    if (openSince[k] != 0 && now - openSince[k] > 150) {
      if (firstDead < 0) firstDead = k;
      n++;
    }
  return n;
}

// the first coil that has not followed its voltage for a quarter of a second, or -1
int stuckCoil(uint32_t now) {
  for (int k = 0; k < N_COILS; k++)
    if (stuckSince[k] != 0 && now - stuckSince[k] > 250) return k;
  return -1;
}

void fanWrite(float pct) {
  if (PIN_FAN_PWM < 0) return;
  ledcWrite(PIN_FAN_PWM, (uint32_t)(constrain(pct, 0.0f, 100.0f) * 2.55f + 0.5f));
}

void IRAM_ATTR tachIsr() {
  uint32_t t = micros();
  if (tachCount == 0) tachFirst = t;
  tachLast = t;
  tachCount++;
}

// ---------------------------------------------------------------- tables
float tab(const float *t, float z) {
  float u = (z - Z_TAB_0) / Z_TAB_STEP;
  if (u <= 0) return t[0];
  if (u >= TAB_N - 1) return t[TAB_N - 1];
  int i = (int)u;
  return t[i] + (u - i) * (t[i + 1] - t[i]);
}

float heightOf(float fieldMt_) {
  float u = (pow(fieldMt_, -0.3333333f) - S_TAB_0) / S_TAB_STEP;
  if (u <= 0) return Z_OF_S[0];
  if (u >= TAB_N - 1) return Z_OF_S[TAB_N - 1];
  int i = (int)u;
  return Z_OF_S[i] + (u - i) * (Z_OF_S[i + 1] - Z_OF_S[i]);
}

float smooth(float t) {
  t = constrain(t, 0.0f, 1.0f);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- states
void say(const char *what) {
  Serial.print("state: ");
  Serial.println(what);
}

void allOff() {
  coilsOff();
  fanTarget = 0;
  fanPct = 0;
  fanWrite(0);
  sweepI = -2;
  tareLeft = 0;
  stepAxis = -1;
  orbitR = 0;
}

void fault(const char *why) {
  if (mode != M_FAULT) {
    strncpy(faultText, why, sizeof(faultText) - 1);
    faultText[sizeof(faultText) - 1] = 0;
    Serial.print("FAULT: ");
    Serial.print(why);
    Serial.println(". Coils and fan off. Put the model back on its pad, then: reset");
  }
  mode = M_FAULT;
  allOff();
}

void showMode() {
  if (mode == shownMode) return;
  shownMode = mode;
  if (mode == M_IDLE) say(onPad ? "idle (model on its pad)" : "idle (no model)");
  else if (mode == M_LAUNCH) say("launching");
  else if (mode == M_FLOAT) say("floating");
  else if (mode == M_LAND) say("landing");
  else if (mode == M_COILCAL) say("measuring the coils");
  else {
    Serial.print("state: fault (");
    Serial.print(faultText);
    Serial.println(")");
  }
}

// ---------------------------------------------------------------- where the model is
// The coils' own fields come out of the reading (their currents times their constants); what is left is the
// magnet's. Its vertical part gives the height, the ratio of sideways to vertical gives the sideways position.
void estimate(float dt) {
  for (int j = 0; j < 3; j++) {
    bMag[j] = bRig[j];
    for (int k = 0; k < N_COILS; k++) bMag[j] -= coilB[k][j] * iMeas[k];
    bMag[j] *= fieldScale;
  }
  fieldMt = MAG_SIGN * bMag[2];
  present = fieldMt > FIELD_MIN_MT;
  if (!present) return;
  float z = heightOf(fieldMt);
  float xr = tab(TAB_XR, z);
  float x = xr * bMag[0] / bMag[2];
  float y = xr * bMag[1] / bMag[2];
  // off the axis the vertical field is a little weaker at the same height: put that back before reading the
  // height (on its pad the model stands upright on its flat, and an upright magnet loses 3 x the ratio)
  float dist = SENSOR_D0 + z;
  float side = z < -HOVER_MM * 0.001f + 0.0006f ? 3.0f : Z_SIDE;
  axisField = fieldMt * (1 + side * (x * x + y * y) / (dist * dist));
  z = heightOf(axisField);
  if (!estStarted) {
    estStarted = true;
    vz = vx = vy = 0;
  } else {
    float az = 1 - exp(-2 * PI * KZ_D_HZ * dt);
    float ax = 1 - exp(-2 * PI * KX_D_HZ * dt);
    vz += az * ((z - zEst) / dt - vz);
    vx += ax * ((x - xEst) / dt - vx);
    vy += ax * ((y - yEst) / dt - vy);
  }
  zEst = z;
  xEst = x;
  yEst = y;
  zMm = z * 1000;
  xMm = x * 1000;
  yMm = y * 1000;
}

// ---------------------------------------------------------------- the loops
// A sideways force (N, rig X and Y) shared between the steering coils. Each only pulls, so they all ride on a
// bias that rises when one would otherwise have to push; past their limit the force is scaled back, keeping
// its direction. Returns the force they are left making through fx and fy.
void steerFor(float *fx, float *fy, float z, float bias) {
  steerSat = false;
  if (N_STEER == 0) {
    *fx = 0;
    *fy = 0;
    return;
  }
  float g = tab(TAB_HG, z);
  float d[N_COILS];
  float lo = 1e9f, hi = -1e9f;
  for (int k = 0; k < N_STEER; k++) {
    d[k] = (STEER_PX[k] * *fx + STEER_PY[k] * *fy) / g;
    lo = min(lo, d[k]);
    hi = max(hi, d[k]);
  }
  float s = 1;
  if (hi - lo > STEER_I_MAX) {
    s = STEER_I_MAX / (hi - lo);
    steerSat = true;
  }
  float b = max(bias, -lo * s);
  if (b + hi * s > STEER_I_MAX) b = STEER_I_MAX - hi * s;
  for (int k = 0; k < N_STEER; k++) iDes[1 + k] = b + d[k] * s;
  *fx *= s;
  *fy *= s;
}

void control(float dt, uint32_t now) {
  float t = (now - modeAt) * 0.001f;
  float rest = -HOVER_MM * 0.001f;
  if (mode == M_LAUNCH) {
    float s = smooth(t / LAUNCH_S);
    zRef = zStart + (zGoal - zStart) * s;
    xRef = xStart * (1 - s);
    yRef = yStart * (1 - s);
    if (t > LAUNCH_S + 0.3f) {
      if (zEst < rest + 0.4f * HOVER_MM * 0.001f) {
        Serial.println("if the lift coil carried current and the model stayed down, the coil is pushing it: swap the two leads of the lift coil's string (at the driver)");
        fault("did not lift off");
        return;
      }
      mode = M_FLOAT;
      modeAt = now;
      settled = false;
      tared = false;
    }
  } else if (mode == M_LAND) {
    float s = smooth(t / LAUNCH_S);
    zRef = zStart + (rest - 0.0005f - zStart) * s;
    xRef = xStart * (1 - s);
    yRef = yStart * (1 - s);
    if (t > LAUNCH_S + 0.2f) {
      coilsOff();
      mode = M_IDLE;
      shownMode = 255;
      return;
    }
  } else {
    // floating: glide to where it was last sent, or round the orbit
    float lim = 0.02f * dt;
    float gx = xGoal, gy = yGoal;
    if (orbitR > 0) {
      float a = 2 * PI * t / orbitPeriod;
      gx = orbitR * cos(a);
      gy = orbitR * sin(a);
    }
    xRef += constrain(gx - xRef, -lim, lim);
    yRef += constrain(gy - yRef, -lim, lim);
    zRef += constrain(zGoal - zRef, -lim, lim);
  }
  zRefMm = zRef * 1000;

  // sideways first: its currents pull the model down a little, which the lift coil then makes up
  float ex = xRef + xTrim - xEst;
  float ey = yRef + yTrim - yEst;
  float fx = KX_P * ex - KX_D * vx + xInt + K_SIDE * xRef / steerEff;
  float fy = KX_P * ey - KX_D * vy + yInt + K_SIDE * yRef / steerEff;
  float depth = constrain((zEst - 0.7f * rest) / (-0.5f * rest), 0.0f, 1.0f);
  float fxGot = fx, fyGot = fy;
  steerFor(&fxGot, &fyGot, zEst, STEER_BIAS * depth);
  if (mode == M_FLOAT && !steerSat) {
    xInt = constrain(xInt + KX_I * ex * dt, -0.04f, 0.04f);
    yInt = constrain(yInt + KX_I * ey * dt, -0.04f, 0.04f);
  }
  float down = 0;
  float vgain = tab(TAB_VG, zEst);
  for (int k = 0; k < N_STEER; k++) down += iDes[1 + k] * STEER_F[k][2] * vgain;

  float ez = zRef - zEst;
  float fz = KZ_P * ez - KZ_D * vz + zInt + weightN;
  float kl = tab(TAB_KL, zEst);
  float want = (fz - down) / kl;
  iDes[0] = constrain(want, 0.0f, LIFT_I_MAX);
  if (want == iDes[0] && mode != M_LAND) zInt = constrain(zInt + KZ_I * ez * dt, -0.5f * weightN, 0.5f * weightN);

  for (int k = 0; k < N_COILS; k++) currentLoop(k, dt);

  // settled: close to where it is held for half a second
  float err2 = ex * ex + ey * ey + ez * ez;
  sway2 += (err2 - sway2) * (dt / 0.5f);
  swayUm = sqrt(sway2) * 1e6f;
  if (mode == M_FLOAT && !settled && t > 0.5f && swayUm < 300) {
    settled = true;
    modelGrams = fFilt[2] / G0 * 1000;
    Serial.print("floating ");
    Serial.print(HOVER_MM, 0);
    Serial.print(" mm up; the model weighs ");
    Serial.print(modelGrams, 2);
    Serial.println(" g");
    if (AUTO_TARE && tareLeft == 0) tareLeft = 500;
  }
  // with the wind off, slide the hold point to where the lift coil's own field centres the model, so the
  // steering coils idle: the sensor's small offsets and the Earth's field then cost nothing
  if (mode == M_FLOAT && settled && airCalm && orbitR == 0 && stepAxis < 0 && sweepI < -1) {
    xTrim = constrain(xTrim - 0.12f * xInt * dt, -0.003f, 0.003f);
    yTrim = constrain(yTrim - 0.12f * yInt * dt, -0.003f, 0.003f);
  }
}

// the force the coils put on the magnet now (N, rig axes), from their measured currents
void forces(float dt) {
  float g = tab(TAB_HG, zEst);
  float vgain = tab(TAB_VG, zEst);
  float f[3] = {0, 0, 0};
  float worst = 0;
  for (int k = 0; k < N_STEER; k++) {
    float i = iMeas[1 + k];
    f[0] += i * STEER_F[k][0] * g;
    f[1] += i * STEER_F[k][1] * g;
    f[2] += i * STEER_F[k][2] * vgain;
    if (i > worst) worst = i;
  }
  f[2] += iMeas[0] * tab(TAB_KL, zEst);
  steerAmps = worst;
  liftAmps = iMeas[0];
  float a = dt / 0.08f;
  for (int j = 0; j < 3; j++) {
    fMag[j] = f[j];
    fFilt[j] += a * (f[j] - fFilt[j]);
  }
  steerMn = sqrt(fFilt[0] * fFilt[0] + fFilt[1] * fFilt[1]) * 1000;
  if (mode != M_FLOAT || !tared) {
    // nothing to weigh until it floats and has been tared
    dragMn = sideMn = liftMn = 0;
    cdNow = 0;
    return;
  }
  // the air's force is what the coils no longer have to make: along the flow, across it, and up
  float ax = -(fFilt[0] - fTare[0]) * steerEff;
  float ay = -(fFilt[1] - fTare[1]) * steerEff;
  float raw = (ax * FLOW_X + ay * FLOW_Y) * 1000;
  sideMn = (-ax * FLOW_Y + ay * FLOW_X) * 1000;
  liftMn = -(fFilt[2] - fTare[2]) * 1000;
  // the fan may never quite stop, so the tare was taken in a breath of wind: the drag coefficient comes from the
  // rise in drag over the rise in dynamic pressure, and the drag shown is that coefficient at today's pressure
  float qc = qPa * BLOCKAGE * BLOCKAGE;
  float qt = qTare * BLOCKAGE * BLOCKAGE;
  float area = MODEL_AREA_MM2 * 1e-6f;
  if (qc > 3 * qt + 1.0f) {
    cdNow = raw * 0.001f / ((qc - qt) * area);
    dragMn = cdNow * qc * area * 1000;
  } else {
    dragMn = raw;
    cdNow = 0;
  }
}

// coil temperatures from their currents: copper heats with I2R and sheds to the air around it
void thermal(float dt) {
  float hot = 0;
  for (int k = 0; k < N_COILS; k++) {
    float r = COIL_R[k] * (1 + 0.00393f * (coilTemp[k] - 20));
    coilTemp[k] += dt * (iMeas[k] * iMeas[k] * r - COIL_HA[k] * (coilTemp[k] - airTempC)) / COIL_CTH[k];
    if (k > 0 && coilTemp[k] > hot) hot = coilTemp[k];
  }
  liftTempC = coilTemp[0];
  steerTempC = hot;
}

// ---------------------------------------------------------------- wind
void wind(float dt, uint32_t now) {
  bool flying = mode == M_FLOAT;
  if (!flying && mode != M_IDLE) fanTarget = 0;
  // the steering coils at their limit for a third of a second: the wind backs off until they are not
  if (steerSat) {
    if (satSince == 0) satSince = now;
    if (now - satSince > 300 && fanTarget > 0) {
      fanTarget = max(0.0f, fanTarget - 15 * dt);
      if (!windHeld) Serial.println("wind held back: the steering coils are at their limit");
      windHeld = true;
    }
  } else {
    satSince = 0;
    windHeld = false;
  }
  float step = FAN_SLEW_PCT_S * dt;
  fanPct += constrain(fanTarget - fanPct, -step, step);
  fanWrite(fanPct);
  // the air takes seconds to stop after the fan does: it is calm once the fan has been off a moment and the
  // gauge has stopped falling (or after ten seconds, with no gauge to tell)
  if (fanPct >= 1 || fanTarget >= 1) windOffAt = now;
  if (now - lastCalm >= 500) {
    lastCalm = now;
    qSteady = fabs(qPa - qPrev) < 0.15f + 0.03f * qPa;
    qPrev = qPa;
  }
  uint32_t off = now - windOffAt;
  airCalm = off > 10000 || (off > 1500 && HAS_GAUGE && sdpFound && qSteady);

  if (now - lastTach >= 250) {
    noInterrupts();
    uint32_t n = tachCount;
    uint32_t first = tachFirst;
    uint32_t last = tachLast;
    tachCount = 0;
    interrupts();
    lastTach = now;
    fanRpm = (n > 1 && last != first) ? 60e6f * (n - 1) / (FAN_TACH_PPR * (float)(last - first)) : 0;
  }
  // a fan that is asked to turn and sends no tacho pulses for three seconds
  if (PIN_FAN_TACH >= 0 && fanPct > 25 && fanRpm < 200) {
    if (fanDeadAt == 0) fanDeadAt = now | 1;
    else if (!fanDead && now - fanDeadAt > 3000) {
      fanDead = true;
      Serial.println("the fan is not turning (no tacho pulses): check its 12 V plug and its tacho wire");
      if (sweepI >= -1) {
        sweepI = -2;
        fanTarget = 0;
        Serial.println("sweep stopped");
      }
    }
  } else {
    fanDeadAt = 0;
    fanDead = false;
  }
  if (HAS_GAUGE && sdpFound && now - lastSdp >= 20) {
    lastSdp = now;
    bool got = sdpRead();
    if (got) sdpMiss = 0;
    else if (sdpMiss < 1000) sdpMiss++;
    if (sdpMiss == 25) {
      // half a second without an answer: no air speed is better than a stale one
      gaugeLost = true;
      dpPa = qPa = airspeed = reynolds = 0;
      Serial.println("the pressure gauge has stopped answering: no air speed or drag coefficient until it is back");
    } else if (got && gaugeLost) {
      gaugeLost = false;
      Serial.println("the pressure gauge is answering again");
    }
    if (got) {
      airDensity = AIR_PRESSURE_PA / (287.05f * (airTempC + 273.15f));
      qPa = max(0.0f, dpPa) * Q_GAIN;
      airspeed = sqrt(2 * qPa / airDensity);
      // air's viscosity near room temperature, Pa s
      float mu = 1.81e-5f * (1 + 0.0027f * (airTempC - 20));
      reynolds = airDensity * airspeed * BLOCKAGE * MODEL_D_MM * 0.001f / mu;
    }
  }
}

// ---------------------------------------------------------------- tare and sweep
void tareStep() {
  if (tareLeft <= 0) return;
  if (tareLeft == 500) {
    // not while the air is still moving
    if (!airCalm) return;
    tareSum[0] = tareSum[1] = tareSum[2] = 0;
    tareQ = 0;
    tareN = 0;
  }
  for (int j = 0; j < 3; j++) tareSum[j] += fMag[j];
  tareQ += qPa;
  tareN++;
  tareLeft--;
  if (tareLeft > 0) return;
  for (int j = 0; j < 3; j++) {
    fTare[j] = tareSum[j] / tareN;
    fFilt[j] = fTare[j];
  }
  qTare = tareQ / tareN;
  tared = true;
  modelGrams = fTare[2] / G0 * 1000;
  dragMn = sideMn = liftMn = 0;
  Serial.print("tare: forces zeroed with the wind off; the model weighs ");
  Serial.print(modelGrams, 2);
  Serial.println(" g");
}

void sweepPrint(int i) {
  float n = sweepN > 0 ? sweepN : 1;
  float drag = sweepAcc[0] / n, sidef = sweepAcc[1] / n, liftf = sweepAcc[2] / n;
  float v = sweepAcc[3] / n, rpm = sweepAcc[4] / n, re = sweepAcc[5] / n, sway = sqrt(sweepAcc[6] / n), cd = sweepAcc[7] / n;
  Serial.print("sweep ");
  Serial.print(i + 1);
  Serial.print("/");
  Serial.print(N_SWEEP);
  Serial.print(": fan ");
  Serial.print(SWEEP_PCT[i], 0);
  Serial.print(" %, ");
  Serial.print(rpm, 0);
  Serial.print(" rpm, ");
  Serial.print(v, 2);
  Serial.print(" m/s, Re ");
  Serial.print(re, 0);
  Serial.print(", drag ");
  Serial.print(drag, 2);
  Serial.print(" mN, Cd ");
  Serial.print(cd, 3);
  Serial.print(", side ");
  Serial.print(sidef, 2);
  Serial.print(" mN, lift ");
  Serial.print(liftf, 2);
  Serial.print(" mN, sway ");
  Serial.print(sway, 0);
  Serial.println(" um");
  Serial.print("S,");
  Serial.print(i + 1);
  Serial.print(",");
  Serial.print(SWEEP_PCT[i], 0);
  Serial.print(",");
  Serial.print(rpm, 0);
  Serial.print(",");
  Serial.print(v, 3);
  Serial.print(",");
  Serial.print(re, 0);
  Serial.print(",");
  Serial.print(drag, 3);
  Serial.print(",");
  Serial.print(cd, 4);
  Serial.print(",");
  Serial.print(sidef, 3);
  Serial.print(",");
  Serial.print(liftf, 3);
  Serial.print(",");
  Serial.println(sway, 0);
  if (cd > 0 && (sweepCdLo == 0 || cd < sweepCdLo)) sweepCdLo = cd;
  if (cd > sweepCdHi) sweepCdHi = cd;
}

// wind off and tare, then each fan setting in turn: wait SWEEP_SETTLE_S, average for SWEEP_AVG_S, print
void sweepStep(uint32_t now) {
  if (sweepI < -1) return;
  if (mode != M_FLOAT) {
    sweepI = -2;
    fanTarget = 0;
    return;
  }
  float into = (now - sweepAt) * 0.001f;
  if (sweepI == -1) {
    // the wind has to die down first (the tare waits for calm air)
    if (tareLeft == 0 && !tared) tareLeft = 500;
    if (!tared) return;
    sweepI = 0;
    sweepAt = now;
    fanTarget = SWEEP_PCT[0];
    for (int j = 0; j < 8; j++) sweepAcc[j] = 0;
    sweepN = 0;
    return;
  }
  if (into < SWEEP_SETTLE_S) return;
  sweepAcc[0] += dragMn;
  sweepAcc[1] += sideMn;
  sweepAcc[2] += liftMn;
  sweepAcc[3] += airspeed;
  sweepAcc[4] += fanRpm;
  sweepAcc[5] += reynolds;
  sweepAcc[6] += swayUm * swayUm;
  sweepAcc[7] += cdNow;
  sweepN++;
  if (into < SWEEP_SETTLE_S + SWEEP_AVG_S) return;
  sweepPrint(sweepI);
  sweepI++;
  sweepAt = now;
  for (int j = 0; j < 8; j++) sweepAcc[j] = 0;
  sweepN = 0;
  if (sweepI < N_SWEEP) {
    fanTarget = SWEEP_PCT[sweepI];
    return;
  }
  sweepI = -2;
  fanTarget = 0;
  Serial.print("sweep done: Cd ");
  Serial.print(sweepCdLo, 3);
  Serial.print(" to ");
  Serial.print(sweepCdHi, 3);
  Serial.println("; fan off");
}

// ---------------------------------------------------------------- steps
// "step z 1" while floating: the hold point jumps, and after 1.5 s it prints the 10-90 % rise, the overshoot,
// when it last left the 10 % band and the error left, then goes back.
void stepWatch(uint32_t now) {
  // (smoothed over about 10 ms: the sensor's noise is a fair share of a millimetre step)
  float pos = stepAxis == 0 ? xMm : stepAxis == 1 ? yMm : zMm;
  stepPos += 0.2f * (pos - stepPos);
  float y = (stepPos - stepY0) / stepMm;
  float t = (now - stepAt) * 0.001f;
  if (t > 1.2f) {
    stepEnd += y;
    stepEndN++;
  }
  if (stepT10 < 0 && y >= 0.1f) stepT10 = t;
  if (stepT90 < 0 && y >= 0.9f) stepT90 = t;
  if (y > stepPeak) stepPeak = y;
  if (fabs(y - 1) > 0.1f) stepSettle = t;
  if (t < 1.5f) return;
  Serial.print("step ");
  Serial.print(stepAxis == 0 ? "x " : stepAxis == 1 ? "y " : "z ");
  Serial.print(stepMm, 1);
  Serial.print(" mm: ");
  if (stepT90 < 0) Serial.print("never reached 90 %");
  else {
    Serial.print("rise ");
    Serial.print((stepT90 - stepT10) * 1000, 0);
    Serial.print(" ms");
  }
  Serial.print(", overshoot ");
  Serial.print(stepPeak > 1 ? (stepPeak - 1) * 100 : 0, 0);
  Serial.print(" %, ");
  if (stepSettle >= 1.5f) Serial.print("not settled");
  else {
    Serial.print("within 10 % after ");
    Serial.print(stepSettle * 1000, 0);
    Serial.print(" ms");
  }
  Serial.print(", error ");
  Serial.print((1 - (stepEndN ? stepEnd / stepEndN : y)) * stepMm * 1000, 0);
  Serial.println(" um");
  if (stepAxis == 0) xGoal -= stepMm * 0.001f;
  else if (stepAxis == 1) yGoal -= stepMm * 0.001f;
  else zGoal -= stepMm * 0.001f;
  stepAxis = -1;
}

// ---------------------------------------------------------------- calibration, model out
// "zero": the sensor's reading with nothing near it, kept as its zero
void zeroStep() {
  if (zeroLeft <= 0) return;
  for (int j = 0; j < 3; j++) zeroSum[j] += bRig[j] + bZero[j];
  zeroLeft--;
  if (zeroLeft > 0) return;
  for (int j = 0; j < 3; j++) bZero[j] = zeroSum[j] / 250;
  Serial.print("zero: ");
  Serial.print(bZero[0], 3);
  Serial.print(", ");
  Serial.print(bZero[1], 3);
  Serial.print(", ");
  Serial.print(bZero[2], 3);
  Serial.println(" mT stored as the sensor's zero; save to keep it");
}

// "coilcal": each coil in turn at a steady current, its field at the sensor measured against the reading just
// before. Prints each against the design's value and says when one is wired backwards.
void coilCalStep(uint32_t now, float dt) {
  uint32_t into = now - calAt;
  float amps = calCoil == 0 ? 0.5f : 0.3f;
  for (int k = 0; k < N_COILS; k++) iDes[k] = (k == calCoil && into >= 250) ? amps : 0;
  for (int k = 0; k < N_COILS; k++) currentLoop(k, dt);
  if (into >= 100 && into < 250) {
    for (int j = 0; j < 3; j++) calB0[j] += bRig[j];
    calN0++;
  } else if (into >= 500 && into < 750) {
    for (int j = 0; j < 3; j++) calB[j] += bRig[j];
    calI += iMeas[calCoil];
    calN++;
  }
  if (into < 750) return;
  float i = calN ? calI / calN : 0;
  float b[3];
  float got = 0, want = 0, along = 0;
  for (int j = 0; j < 3; j++) {
    b[j] = (i > 0.05f && calN0 && calN) ? (calB[j] / calN - calB0[j] / calN0) / i : 0;
    got += b[j] * b[j];
    want += COIL_B[calCoil][j] * COIL_B[calCoil][j];
    along += b[j] * COIL_B[calCoil][j];
  }
  Serial.print("coil ");
  Serial.print(calCoil);
  Serial.print(calCoil == 0 ? " (lift): " : " (steering): ");
  if (i <= 0.05f) Serial.println("no current: check its wiring and driver");
  else {
    float nb = 0, alongNull = 0;
    for (int j = 0; j < 3; j++) {
      nb += COIL_NULL_B[calCoil][j] * COIL_NULL_B[calCoil][j];
      alongNull += b[j] * COIL_NULL_B[calCoil][j];
    }
    Serial.print(sqrt(got), 3);
    if (nb > 0) {
      // with a nulling winding in series next to nothing should reach the sensor
      Serial.print(" mT/A at the sensor with its nulling winding (worth ");
      Serial.print(sqrt(nb), 3);
      Serial.print(" mT/A)");
      if (got > nb) Serial.println(": THE NULLING WINDING IS THE WRONG WAY ROUND, swap that winding's two leads");
      else {
        for (int j = 0; j < 3; j++) coilB[calCoil][j] = b[j];
        float turns = alongNull / nb * COIL_NULL_TURNS[calCoil];
        if (fabs(turns) < 0.75f) Serial.println(": stored");
        else {
          Serial.print(": stored; the nulling winding has about ");
          Serial.print(fabs(turns), 0);
          Serial.println(turns > 0 ? " turn(s) too many" : " turn(s) too few");
        }
      }
    } else {
    Serial.print(" mT/A at the sensor, the design says ");
    Serial.print(sqrt(want), 3);
    if (along < 0) Serial.println(": WIRED BACKWARDS, swap its two leads");
    else if (got < 0.49f * want || got > 2.25f * want) Serial.println(": far from the design, check the turns and where it sits (not stored)");
    else {
      for (int j = 0; j < 3; j++) coilB[calCoil][j] = b[j];
      Serial.println(": stored");
    }
    }
  }
  calCoil++;
  calAt = now;
  for (int j = 0; j < 3; j++) calB0[j] = calB[j] = 0;
  calI = 0;
  calN0 = calN = 0;
  if (calCoil < N_COILS) return;
  calCoil = -1;
  coilsOff();
  mode = M_IDLE;
  Serial.println("coils measured; save to keep them");
}

// ---------------------------------------------------------------- flash
void saveSettings() {
  int a = 4;
  EEPROM.write(0, 0x4D);
  EEPROM.write(1, N_COILS);
  for (int j = 0; j < 3; j++) {
    EEPROM.put(a, bZero[j]);
    a += 4;
  }
  EEPROM.put(a, steerEff);
  a += 4;
  for (int k = 0; k < N_COILS; k++)
    for (int j = 0; j < 3; j++) {
      EEPROM.put(a, coilB[k][j]);
      a += 4;
    }
  EEPROM.commit();
  Serial.println("saved");
}

void loadSettings() {
  for (int k = 0; k < N_COILS; k++)
    for (int j = 0; j < 3; j++) coilB[k][j] = COIL_B[k][j];
  EEPROM.begin(256);
  if (EEPROM.read(0) != 0x4D || EEPROM.read(1) != N_COILS) return;
  int a = 4;
  float v = 0;
  for (int j = 0; j < 3; j++) {
    EEPROM.get(a, v);
    bZero[j] = v;
    a += 4;
  }
  EEPROM.get(a, v);
  if (v > 0.3f && v < 3.0f) steerEff = v;
  a += 4;
  for (int k = 0; k < N_COILS; k++)
    for (int j = 0; j < 3; j++) {
      EEPROM.get(a, v);
      coilB[k][j] = v;
      a += 4;
    }
}

// ---------------------------------------------------------------- console
void help() {
  Serial.println("launch         lift the model off its pad and hold it");
  Serial.println("land           set it down; stop: everything off now; reset: clear a fault");
  Serial.println("fan <percent>  wind (only while floating); sweep: tare, then every fan setting in turn");
  Serial.println("tare           zero the forces (wind off); cal <mN>: a known force is pulling it downstream");
  Serial.println("go <x> <y> <z> move the hold point, mm; orbit <mm> <s>: fly a circle; orbit 0 ends it");
  Serial.println("step x|y|z <mm>  a jump in the hold point: prints rise, overshoot, settling");
  Serial.println("zero, coilcal  model out: store the sensor's zero, measure each coil's field");
  Serial.println("log on|off     the 50 Hz data stream; info: the rig's numbers; show; save");
}

void show() {
  Serial.print("x ");
  Serial.print(xMm, 3);
  Serial.print(" y ");
  Serial.print(yMm, 3);
  Serial.print(" z ");
  Serial.print(zMm, 3);
  Serial.print(" mm, field ");
  Serial.print(fieldMt, 2);
  Serial.print(" mT, lift ");
  Serial.print(liftAmps, 3);
  Serial.print(" A, steering");
  for (int k = 0; k < N_STEER; k++) {
    Serial.print(" ");
    Serial.print(iMeas[1 + k], 3);
  }
  Serial.print(" A, coils ");
  Serial.print(liftTempC, 0);
  Serial.print(" / ");
  Serial.print(steerTempC, 0);
  Serial.println(" C");
  Serial.print("wind ");
  Serial.print(airspeed, 2);
  Serial.print(" m/s (");
  Serial.print(dpPa, 1);
  Serial.print(" Pa, ");
  Serial.print(fanRpm, 0);
  Serial.print(" rpm), drag ");
  Serial.print(dragMn, 2);
  Serial.print(" mN, Cd ");
  Serial.print(cdNow, 3);
  Serial.print(", side ");
  Serial.print(sideMn, 2);
  Serial.print(", lift ");
  Serial.print(liftMn, 2);
  Serial.println(" mN");
}

void info() {
  Serial.print("I,hover_mm,");
  Serial.println(HOVER_MM, 1);
  Serial.print("I,model_g,");
  Serial.println(modelGrams > 0 ? modelGrams : MODEL_G, 2);
  Serial.print("I,model_d_mm,");
  Serial.println(MODEL_D_MM, 1);
  Serial.print("I,model_area_mm2,");
  Serial.println(MODEL_AREA_MM2, 1);
  Serial.print("I,steer_coils,");
  Serial.println(N_STEER);
  Serial.print("I,steer_eff,");
  Serial.println(steerEff, 3);
  Serial.print("I,field_scale,");
  Serial.println(fieldScale, 4);
  Serial.print("I,lift_n_per_a,");
  Serial.println(tab(TAB_KL, 0), 4);
  Serial.print("I,blockage,");
  Serial.println(BLOCKAGE, 4);
  Serial.print("I,flow,");
  Serial.print(FLOW_X, 2);
  Serial.print(",");
  Serial.println(FLOW_Y, 2);
  Serial.print("I,sweep_points,");
  Serial.println(N_SWEEP);
}

const char *nextArg(const char *s) {
  while (*s && *s != ' ') s++;
  while (*s == ' ') s++;
  return s;
}

void command(const char *s, uint32_t now) {
  if (!strcmp(s, "help")) help();
  else if (!strcmp(s, "show")) show();
  else if (!strcmp(s, "info")) info();
  else if (!strcmp(s, "log on") || !strcmp(s, "log")) logOn = true;
  else if (!strcmp(s, "log off")) logOn = false;
  else if (!strcmp(s, "save")) saveSettings();
  else if (!strcmp(s, "stop")) {
    allOff();
    if (mode != M_FAULT) mode = M_IDLE;
    shownMode = 255;
  } else if (!strcmp(s, "reset")) {
    if (mode == M_FAULT) {
      mode = M_IDLE;
      for (int k = 0; k < N_COILS; k++) coilTemp[k] = min(coilTemp[k], COIL_TEMP_MAX - 10.0f);
    }
  } else if (!strcmp(s, "launch")) {
    if (mode != M_IDLE) Serial.println(mode == M_FAULT ? "clear the fault first: reset" : "already up");
    else if (!tmagFound || !inaFound) Serial.println("the field sensor or a current monitor is not answering");
    else if (MAG_SIGN * bRig[2] < -0.3f * FIELD_REST_MT) Serial.println("the model is upside down: its marked pole goes up");
    else if (!present || fieldMt < 0.4f * FIELD_REST_MT) Serial.println("no model on the pad");
    else if (fabs(xMm) > 6 || fabs(yMm) > 6) Serial.println("the model is off its pad: centre it");
    else {
      // the monitors' zeros, taken now with the coils off
      for (int k = 0; k < N_COILS; k++) iZero[k] += iMeas[k];
      // the pad is a known distance from the sensor: what the sensor reads there sets its scale, which takes
      // out the chip's gain error and a magnet a little stronger or weaker than its grade
      if (PAD_SCALE && restN >= 100) {
        float sc = FIELD_REST_MT / restField;
        if (sc > 0.87f && sc < 1.15f) {
          fieldScale = sc;
          estStarted = false;
          estimate(0.002f);
        } else {
          fieldScale = 1;
          Serial.print("the field on the pad is ");
          Serial.print(restField, 1);
          Serial.print(" mT and the design expects ");
          Serial.print(FIELD_REST_MT, 1);
          Serial.println(" mT: check the model sits flat on its pad; using the design's scale");
        }
      }
      zStart = zEst;
      xStart = xEst;
      yStart = yEst;
      zRef = zEst;
      xGoal = yGoal = zGoal = 0;
      xTrim = yTrim = 0;
      zInt = xInt = yInt = 0;
      sway2 = 1e-6f;
      vz = vx = vy = 0;
      weightN = MODEL_G * 0.001f * G0;
      coilsOn();
      mode = M_LAUNCH;
      modeAt = now;
      lostSince = 0;
    }
  } else if (!strcmp(s, "land")) {
    if (mode != M_FLOAT && mode != M_LAUNCH) Serial.println("not floating");
    else {
      fanTarget = 0;
      sweepI = -2;
      orbitR = 0;
      stepAxis = -1;
      zStart = zRef;
      xStart = xRef;
      yStart = yRef;
      mode = M_LAND;
      modeAt = now;
    }
  } else if (!strncmp(s, "fan ", 4)) {
    float p = constrain(atof(s + 4), 0.0f, 100.0f);
    if (PIN_FAN_PWM < 0) Serial.println("no fan wired");
    else if (mode != M_FLOAT && p > 0) Serial.println("launch first: the wind only runs while the model floats");
    else {
      sweepI = -2;
      fanTarget = p;
    }
  } else if (!strcmp(s, "sweep")) {
    if (mode != M_FLOAT) Serial.println("launch first");
    else if (PIN_FAN_PWM < 0) Serial.println("no fan wired");
    else {
      fanTarget = 0;
      tared = false;
      sweepI = -1;
      sweepAt = now;
      sweepCdLo = sweepCdHi = 0;
      Serial.println("sweep: wind off and tare first");
    }
  } else if (!strcmp(s, "tare")) {
    if (mode != M_FLOAT) Serial.println("launch first");
    else if (fanTarget >= 1) Serial.println("wind off first: fan 0");
    else tareLeft = 500;
  } else if (!strncmp(s, "cal ", 4)) {
    float known = atof(s + 4);
    float raw = -((fFilt[0] - fTare[0]) * FLOW_X + (fFilt[1] - fTare[1]) * FLOW_Y) * 1000;
    if (mode != M_FLOAT || !tared) Serial.println("launch and tare first");
    else if (known <= 0 || raw < 0.5f) Serial.println("cal <mN>: needs a known force of a millinewton or more pulling the model downstream");
    else {
      steerEff = constrain(known / raw, 0.3f, 3.0f);
      Serial.print("steering factor ");
      Serial.print(steerEff, 3);
      Serial.println("; save to keep it");
    }
  } else if (!strncmp(s, "go ", 3)) {
    const char *a = s + 3;
    const char *b = nextArg(a);
    const char *d = nextArg(b);
    if (mode != M_FLOAT) Serial.println("launch first");
    else {
      orbitR = 0;
      xGoal = constrain(atof(a), -5.0f, 5.0f) * 0.001f;
      yGoal = constrain(atof(b), -5.0f, 5.0f) * 0.001f;
      zGoal = constrain(atof(d), -5.0f, 5.0f) * 0.001f;
    }
  } else if (!strncmp(s, "orbit ", 6)) {
    const char *b = nextArg(s + 6);
    if (mode != M_FLOAT) Serial.println("launch first");
    else {
      orbitR = constrain(atof(s + 6), 0.0f, 5.0f) * 0.001f;
      orbitPeriod = *b ? constrain(atof(b), 1.0f, 60.0f) : 4;
      modeAt = now;
      if (orbitR == 0) xGoal = yGoal = 0;
    }
  } else if (!strncmp(s, "step ", 5)) {
    int ax = s[5] == 'x' ? 0 : s[5] == 'y' ? 1 : s[5] == 'z' ? 2 : -1;
    float d = atof(nextArg(s + 5));
    if (mode != M_FLOAT) Serial.println("launch first");
    else if (stepAxis >= 0) Serial.println("a step is running");
    else if (ax < 0 || d == 0 || fabs(d) > 3) Serial.println("step x|y|z <mm>, up to 3 mm");
    else {
      stepAxis = ax;
      stepMm = d;
      stepAt = now;
      // from where it is held now (the reading itself is noisy)
      stepY0 = (ax == 0 ? xRef + xTrim : ax == 1 ? yRef + yTrim : zRef) * 1000;
      stepPos = stepY0;
      stepEnd = 0;
      stepEndN = 0;
      stepPeak = 0;
      stepT10 = stepT90 = -1;
      stepSettle = 0;
      // the jump itself: straight to the hold point, not glided
      if (ax == 0) { xGoal += d * 0.001f; xRef += d * 0.001f; }
      else if (ax == 1) { yGoal += d * 0.001f; yRef += d * 0.001f; }
      else { zGoal += d * 0.001f; zRef += d * 0.001f; }
    }
  } else if (!strcmp(s, "zero")) {
    if (mode != M_IDLE) Serial.println("coils off first: stop");
    else if (present) Serial.println("take the model out first");
    else {
      zeroLeft = 250;
      zeroSum[0] = zeroSum[1] = zeroSum[2] = 0;
    }
  } else if (!strcmp(s, "coilcal")) {
    if (mode != M_IDLE) Serial.println("coils off first: stop");
    else if (present) Serial.println("take the model out first");
    else {
      for (int k = 0; k < N_COILS; k++) iZero[k] += iMeas[k];
      calCoil = 0;
      calAt = now;
      for (int j = 0; j < 3; j++) calB0[j] = calB[j] = 0;
      calI = 0;
      calN0 = calN = 0;
      coilsOn();
      mode = M_COILCAL;
    }
  } else if (s[0]) Serial.println("? type help");
}

void console(uint32_t now) {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\\r') continue;
    if (ch == '\\n') {
      line[lineLen] = 0;
      command(line, now);
      lineLen = 0;
    } else if (lineLen < sizeof(line) - 1) line[lineLen++] = ch;
  }
}

void logField(long v) {
  Serial.print(",");
  Serial.print(v);
}

void logLine(uint32_t now) {
  Serial.print("T,");
  Serial.print(now);
  logField(mode);
  logField((long)(xMm * 1000));
  logField((long)(yMm * 1000));
  logField((long)(zMm * 1000));
  logField((long)(zRefMm * 1000));
  for (int k = 0; k < N_COILS; k++) logField((long)(iMeas[k] * 1000));
  for (int j = 0; j < 3; j++) logField((long)(fFilt[j] * 1e5f));
  logField((long)(dragMn * 100));
  logField((long)(sideMn * 100));
  logField((long)(liftMn * 100));
  logField((long)(dpPa * 100));
  logField((long)(airspeed * 100));
  logField((long)fanRpm);
  logField((long)fanPct);
  logField((long)(liftTempC * 10));
  logField((long)(steerTempC * 10));
  logField((long)(airTempC * 10));
  logField((long)swayUm);
  logField((long)loopUs);
  Serial.println();
}

// ---------------------------------------------------------------- setup and loop
void setup() {
  // coil pins first, low, so nothing is driven while the rest starts
  for (int k = 0; k < N_COILS; k++) {
    if (COIL_HIGH[k] >= 0) {
      pinMode(COIL_HIGH[k], OUTPUT);
      digitalWrite(COIL_HIGH[k], LOW);
    }
    if (COIL_LOW[k] >= 0) {
      pinMode(COIL_LOW[k], OUTPUT);
      digitalWrite(COIL_LOW[k], LOW);
    }
    if (COIL_PWM[k] >= 0) {
      ledcAttach(COIL_PWM[k], PWM_HZ, PWM_BITS);
      ledcWrite(COIL_PWM[k], 0);
    }
    iMeas[k] = iZero[k] = iDes[k] = vInt[k] = 0;
    coilTemp[k] = 25;
  }
  for (int i = 0; i < N_ENABLE; i++)
    if (DRIVER_EN[i] >= 0) {
      pinMode(DRIVER_EN[i], OUTPUT);
      digitalWrite(DRIVER_EN[i], LOW);
    }
  if (PIN_FAN_PWM >= 0) {
    // low at once: an open PWM wire means flat out
    ledcAttach(PIN_FAN_PWM, FAN_PWM_HZ, 8);
    ledcWrite(PIN_FAN_PWM, 0);
  }
  if (PIN_FAN_TACH >= 0) {
    pinMode(PIN_FAN_TACH, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(PIN_FAN_TACH), tachIsr, FALLING);
  }
  Serial.begin(BAUD);
  if (PIN_I2C_POWER >= 0) {
    // the STEMMA QT socket's power switch
    pinMode(PIN_I2C_POWER, OUTPUT);
    digitalWrite(PIN_I2C_POWER, HIGH);
  }
  pinMode(PIN_LED, OUTPUT);
  loadSettings();
  Wire.begin();
  Wire.setClock(400000);
  delay(30);
  tmagFound = tmagBegin();
  inaFound = inaBegin();
  if (HAS_GAUGE) sdpFound = sdpBegin();
  if (!tmagFound) {
    Serial.println("TMAG5273 field sensor not found: check its cable");
    fault("field sensor not found");
  } else if (!inaFound) {
    Serial.println("INA3221 current monitor not found: check its cable and address jumper");
    fault("current monitor not found");
  } else {
    if (HAS_GAUGE && !sdpFound) Serial.println("pressure gauge not found: no air speed");
    // the monitors' zeros with the coils off
    delay(10);
    float s[N_COILS];
    for (int k = 0; k < N_COILS; k++) s[k] = 0;
    for (int n = 0; n < 20; n++) {
      readCurrents();
      for (int k = 0; k < N_COILS; k++) s[k] += iMeas[k];
      delay(2);
    }
    for (int k = 0; k < N_COILS; k++) iZero[k] = s[k] / 20;
    lastFieldOk = lastInaOk = millis();
  }
  Serial.println("magnetic levitation ready: type help");
  lastTick = micros();
}

void loop() {
  uint32_t now = millis();
  console(now);
  uint32_t us = micros();
  if ((uint32_t)(us - lastTick) < LOOP_US) return;
  float dt = (us - lastTick) * 1e-6f;
  if (dt > 0.006f) {
    dt = 0.006f;
    overruns++;
  }
  lastTick = us;

  if (inaFound && readCurrents()) lastInaOk = now;
  bool fresh = false;
  if (tmagFound && readField()) {
    lastFieldOk = now;
    fresh = skipField == 0;
  }
  if (fresh) estimate(dt);

  // safety, every pass
  bool flying = mode == M_LAUNCH || mode == M_FLOAT || mode == M_LAND;
  if (mode != M_FAULT && tmagFound && inaFound) {
    if (now - lastFieldOk > SENSOR_TIMEOUT_MS) fault("field sensor stopped answering");
    else if (now - lastInaOk > SENSOR_TIMEOUT_MS) fault("current monitor stopped answering");
    else if (coilsLive && fieldSame >= 50) fault("field sensor frozen (the same reading 50 times)");
    else if (coilsLive && (inaSame >= 250 || frozenCoil() >= 0)) {
      if (frozenCoil() >= 0) {
        Serial.print("coil ");
        Serial.print(frozenCoil());
        Serial.println(": its current reading has stopped moving");
      }
      fault("current monitor frozen");
    }
    else if (coilsLive && deadCoils(now) > 1) fault("no current in the coils: check their 12 V supply");
    else if (coilsLive && deadCoils(now) == 1) {
      Serial.print("coil ");
      Serial.print(firstDead);
      Serial.println(firstDead == 0 ? " (lift) carries no current: check the 12 V supply, its wiring and its driver" : " (steering) carries no current: check its wiring and its driver");
      fault("no current in a coil: no supply, an open wire or a dead driver");
    } else if (coilsLive && stuckCoil(now) >= 0) {
      int bad = stuckCoil(now);
      Serial.print("coil ");
      Serial.print(bad);
      Serial.println(bad == 0 ? " (lift): check its wiring, its driver and its current monitor" : " (steering): check its wiring, its driver and its current monitor");
      fault("a coil's current is not following its voltage");
    }
    else if (liftTempC > COIL_TEMP_MAX || steerTempC > COIL_TEMP_MAX) fault("a coil is too hot");
    else if (flying) {
      bool lost = !present || fabs(xMm) > LOST_XY_MM || fabs(yMm) > LOST_XY_MM;
      if (!lost) lostSince = 0;
      else if (lostSince == 0) lostSince = now;
      else if (now - lostSince > LOST_MS) fault("model lost");
    }
  }
  flying = mode == M_LAUNCH || mode == M_FLOAT || mode == M_LAND;

  if (flying) control(dt, now);
  else if (mode == M_COILCAL) coilCalStep(now, dt);
  forces(dt);
  thermal(dt);
  wind(dt, now);
  if (mode == M_FLOAT) {
    tareStep();
    sweepStep(now);
    if (stepAxis >= 0) stepWatch(now);
  } else if (mode == M_IDLE) {
    zeroStep();
    zRefMm = zMm;
    // say so when the model is put on its pad or taken away
    bool there = present && fieldMt > 0.4f * FIELD_REST_MT;
    if (there != onPad) {
      onPad = there;
      shownMode = 255;
      restN = 0;
    }
    // the unscaled field with the model resting, averaged over about a quarter of a second
    if (there && fresh) {
      float raw = axisField / fieldScale;
      if (restN == 0) restField = raw;
      else restField += 0.008f * (raw - restField);
      if (restN < 30000) restN++;
    }
  }
  digitalWrite(PIN_LED, flying ? HIGH : LOW);
  showMode();

  uint32_t took = micros() - us;
  if (took > loopWorst) loopWorst = took;
  if (now - lastLog >= 20) {
    lastLog = now;
    loopUs = loopWorst;
    loopWorst = 0;
    if (logOn) logLine(now);
  }
}
`;
}
