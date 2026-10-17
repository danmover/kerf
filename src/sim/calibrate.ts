// Calibrating the simulation from the real machine. The generated firmware's
// bench test (console command b) runs each motor with the machine held still
// and prints "cal" lines: the current in the first milliseconds at full power,
// before the rotor turns, gives the winding resistance; the free speed and
// current at full power give the speed constant and the friction; the battery
// sag under that first surge gives the pack's resistance. Those are fitted to
// the same linear motor and battery models the simulation runs, and written
// back as `measured: sim.measured(...)` on each component.

import { setBlockProps } from "../core/sourceEdit";
import type { Model } from "../core/model";
import { fmtNum } from "../lang/values";
import { catalogPart } from "../machine/catalog";
import { buildNetlist } from "../machine/erc";
import { measuredPart } from "../machine/measured";
import type { MachineComponent } from "../machine/types";
import { firmwareOf } from "./templates";

const gearmotors = (model: Model) => (model.machine?.components ?? []).filter((c) => catalogPart(c.catalogId)?.kind === "gearmotor");

/** Why this design cannot be calibrated from a bench test, or null when it can. */
export function calibrateUnavailable(model: Model): string | null {
  if (!gearmotors(model).length) return "The bench test measures DC gearmotors and the battery, and this design has no gearmotors.";
  if (!firmwareOf(model)) return "The bench test is part of the Arduino firmware Kerf writes. Add a firmware block for an Arduino controller first.";
  return null;
}

export const BENCH_LABEL = "Kerf bench test";

/** A scenario that runs the bench test on the simulation, to show what the real one prints. */
export function benchScenario(model: Model): string {
  // 2 s at rest, then about 4 s a motor (surge, spin-up, a second free, spin-down)
  const secs = Math.ceil(4 + 4.5 * gearmotors(model).length);
  return `scenario "${BENCH_LABEL}" { world: sim.bench(load: 0) firmware: ${firmwareOf(model)!.name} duration: ${secs}s console: [sim.type("b", at: 1s)] }`;
}

export interface BenchMotor {
  /** the firmware's motor name: the component name, with [i] for one of several */
  name: string;
  peakAmps?: number;
  peakVbat?: number;
  freeAmps?: number;
  freeRpm?: number;
  freeVbat?: number;
}

export interface BenchLog {
  restVbat?: number;
  motors: BenchMotor[];
  /** "cal start" and "cal end" were both seen */
  complete: boolean;
}

const val = (v: string | undefined) => {
  const n = v === undefined ? NaN : Number(v);
  // the firmware prints -1 for a reading it does not have
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Read the "cal" lines out of a serial log (anything else in it is ignored). */
export function parseBench(text: string): BenchLog {
  const log: BenchLog = { motors: [], complete: false };
  let started = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(\d+(\.\d+)?\s*(s|ms)?\s*[:>-]?\s*)?/, "").trim();
    if (!line.startsWith("cal ")) continue;
    if (/^cal start\b/.test(line)) {
      // a second test in the same log replaces the first
      started = true;
      log.motors = [];
      log.restVbat = undefined;
      log.complete = false;
      continue;
    }
    if (/^cal end\b/.test(line)) {
      log.complete = started;
      continue;
    }
    const [, name, rest] = /^cal (\S+)\s*(.*)$/.exec(line) ?? [];
    if (!name) continue;
    const kv = Object.fromEntries([...rest.matchAll(/(\w+)=(-?[\d.]+)/g)].map((m) => [m[1], m[2]]));
    if (name === "rest") {
      log.restVbat = val(kv.vbat);
      continue;
    }
    const m: BenchMotor = { name, peakAmps: val(kv.peak_amps), peakVbat: val(kv.peak_vbat), freeAmps: val(kv.free_amps), freeRpm: val(kv.free_rpm), freeVbat: val(kv.free_vbat) };
    const at = log.motors.findIndex((x) => x.name === name);
    if (at >= 0) log.motors[at] = m;
    else log.motors.push(m);
  }
  return log;
}

export interface CalField {
  /** the sim.measured() name */
  key: string;
  label: string;
  unit: string;
  /** what the simulation used before (catalog or an earlier measurement) */
  before: number;
  measured: number;
  /** source text for sim.measured() */
  text: string;
  /** worked out, not measured directly */
  derived?: boolean;
}

export interface CalFit {
  comp: string;
  kind: "gearmotor" | "battery";
  fields: CalField[];
  notes: string[];
  /** `sim.measured(...)` for the component */
  source: string;
}

export interface CalResult {
  fits: CalFit[];
  /** what could not be fitted, and why */
  problems: string[];
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const round = (x: number, sig = 3) => Number(x.toPrecision(sig));

/** Volts a motor's driver loses (bipolar bridges like the L298N), from the netlist. */
function driverDrop(model: Model, comp: string): number {
  const m = model.machine!;
  if (!m.wires.length && !m.nets.length) return 0;
  for (const n of buildNetlist(m).nets) {
    if (!n.pins.some((p) => p.comp === comp && p.pin.type === "motor")) continue;
    const d = n.pins.find((p) => p.pin.type === "motor_out");
    const v = d?.part.specs.v_drop;
    if (typeof v === "number") return v;
  }
  return 0;
}

function fitMotor(model: Model, mc: MachineComponent, b: BenchMotor, problems: string[]): CalFit | undefined {
  const cat = catalogPart(mc.catalogId)!;
  const was = measuredPart(mc)!.specs;
  const vr = num(cat.specs.v_rated, 12);
  const is0 = num(was.i_stall, 5);
  const i00 = num(was.i_free, 0.2);
  const n00 = num(was.rpm_free, 100);
  const ts0 = num(was.t_stall, 1000);
  const drop = driverDrop(model, mc.name);
  const fields: CalField[] = [];
  const notes: string[] = [];
  if (b.peakAmps === undefined || b.peakVbat === undefined || b.freeAmps === undefined) {
    problems.push(`${mc.name}: no current readings, so its winding cannot be measured. Wire the driver's current-sense pin to an analog input.`);
    return undefined;
  }
  if (b.peakAmps < 2 * b.freeAmps) {
    problems.push(`${mc.name}: the first current reading (${fmtNum(b.peakAmps, 2)} A) is barely above its free current: it was already turning, or the current sensor is slow. Hold the machine still and run the test again.`);
    return undefined;
  }
  // before the rotor moves: R = V / I
  const R = Math.max(1e-3, b.peakVbat - drop) / b.peakAmps;
  const i0 = b.freeAmps;
  const isNew = vr / R;
  fields.push({ key: "i_stall", label: "Stall current", unit: "A", before: is0, measured: round(isNew), text: `${round(isNew)}A` });
  fields.push({ key: "i_free", label: "Free current", unit: "A", before: i00, measured: round(i0), text: `${round(i0)}A` });
  notes.push(`winding resistance ${fmtNum(R, 2)} Ω from ${fmtNum(b.peakAmps, 2)} A at ${fmtNum(b.peakVbat - drop, 2)} V before it turned`);
  if (b.freeRpm !== undefined && b.freeRpm > 0 && b.freeVbat !== undefined) {
    // back-EMF at free speed scales to the rated voltage: n = (V − I0·R) / ke
    const vf = b.freeVbat - drop;
    const ke = (vf - i0 * R) / ((b.freeRpm * 2 * Math.PI) / 60);
    const nNew = ((vr - i0 * R) / ke) * (60 / (2 * Math.PI));
    fields.push({ key: "rpm_free", label: "Free speed", unit: "rpm", before: n00, measured: round(nNew), text: `${round(nNew)}rpm` });
    notes.push(`${fmtNum(b.freeRpm, 1)} rpm free at ${fmtNum(vf, 2)} V, scaled to its rated ${fmtNum(vr)} V`);
    // torque: the same gearbox efficiency as before, on the measured torque constant
    const ke0 = (vr - i00 * (vr / is0)) / ((n00 * 2 * Math.PI) / 60);
    const kt0 = ts0 / 1000 / Math.max(0.01, is0 - i00);
    const tsNew = kt0 * (ke / ke0) * (isNew - i0) * 1000;
    fields.push({ key: "t_stall", label: "Stall torque", unit: "N·mm", before: ts0, measured: round(tsNew), text: `${round(tsNew / 1000)}Nm`, derived: true });
    notes.push("stall torque worked out from the measured constants with the catalog's gearbox efficiency (a torque test would measure it)");
  } else problems.push(`${mc.name}: no encoder speed, so only its currents were measured.`);
  return { comp: mc.name, kind: "gearmotor", fields, notes, source: sourceOf(fields) };
}

function fitBattery(model: Model, log: BenchLog, problems: string[]): CalFit | undefined {
  const bat = model.machine!.components.find((c) => c.kind === "battery");
  if (!bat) return undefined;
  if (log.restVbat === undefined) {
    problems.push(`${bat.name}: no battery voltage readings. Wire a voltage sensor from the battery to an analog input.`);
    return undefined;
  }
  // the biggest surge sags the pack the most clearly
  const surge = [...log.motors].filter((m) => m.peakAmps !== undefined && m.peakVbat !== undefined).sort((a, b) => b.peakAmps! - a.peakAmps!)[0];
  if (!surge || surge.peakAmps! < 1) return undefined;
  const r = (log.restVbat - surge.peakVbat!) / surge.peakAmps!;
  if (!(r > 0)) {
    problems.push(`${bat.name}: the voltage did not sag under ${fmtNum(surge.peakAmps!, 1)} A, so its resistance is too small to read this way.`);
    return undefined;
  }
  const cat = catalogPart(bat.catalogId)!;
  const was = measuredPart(bat)!.specs;
  const cells = num(cat.specs.cells, 3);
  const c = num(cat.specs.c_rating, 20);
  const capAh = num(was.capacity_mah, 2200) / 1000;
  const before = (typeof was.r_int_mohm === "number" ? was.r_int_mohm / 1000 : 0.6 / (c * capAh)) * cells;
  const fields: CalField[] = [{ key: "r_int", label: "Internal resistance (pack and leads)", unit: "mΩ", before: round(before * 1000), measured: round(r * 1000), text: `${round(r * 1000)}mOhm` }];
  return { comp: bat.name, kind: "battery", fields, notes: [`${fmtNum((log.restVbat - surge.peakVbat!) * 1000, 0)} mV sag at ${fmtNum(surge.peakAmps!, 1)} A as ${surge.name} started`], source: sourceOf(fields) };
}

const sourceOf = (fields: CalField[]) => `sim.measured(${fields.map((f) => `${f.key}: ${f.text}`).join(", ")})`;

/** Fit the bench test to each motor and the battery. */
export function fitBench(model: Model, log: BenchLog): CalResult {
  const problems: string[] = [];
  const fits: CalFit[] = [];
  const m = model.machine;
  if (!m) return { fits, problems: ["This design has no machine parts to calibrate."] };
  if (!log.motors.length) problems.push('No bench test in this log. Upload the firmware, open the serial monitor at 115200 baud, type b and press Enter, then copy everything from "cal start" to "cal end".');
  else if (!log.complete) problems.push('The log stops before "cal end": the numbers so far are used.');
  for (const b of log.motors) {
    const name = b.name.replace(/\[\d+\]$/, "");
    const mc = m.components.find((c) => c.name === name);
    if (!mc) {
      problems.push(`${b.name}: no component of that name in this design (was the firmware made from another version?).`);
      continue;
    }
    if (mc.kind !== "gearmotor") continue;
    // several of one motor: the first one measured stands for them all
    if (fits.some((f) => f.comp === mc.name)) continue;
    const f = fitMotor(model, mc, b, problems);
    if (f) fits.push(f);
  }
  const bat = log.motors.length ? fitBattery(model, log, problems) : undefined;
  if (bat) fits.push(bat);
  return { fits, problems };
}

/** The source with each fitted component's `measured:` set. */
export function applyFits(src: string, fits: CalFit[]): string {
  let out = src;
  for (const f of fits) out = setBlockProps(out, f.comp, { measured: f.source });
  return out;
}
