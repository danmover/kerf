// Runs one scenario: the design's generated firmware on the virtual
// microcontroller, wired to the plant built from the design's netlist, inside
// a world. Each variant (pessimistic, expected, optimistic) is a full run of
// its own. A run records a timeline (10 frames a second of every motor,
// battery, sensor, world and firmware number), the events, the serial
// console, and the results the scenario's expectations read.

import type { MachineData } from "../../machine/types";
import { catalogPart } from "../../machine/catalog";
import { generateFirmware } from "../../machine/firmware";
import { boardForPart, CError, Halt, loadFirmware } from "../mcu";
import { Plant } from "./plant";
import { SimHal, type SerialLine, type SimFault } from "./hal";
import type { DisplayFrame } from "./devices";

export type { DisplayFrame };
import type { SceneSpec, World, WorldEvent } from "../worlds/types";
import { rngFrom, VARIANTS, type VariantName } from "../worlds/common";

export interface RunOptions {
  machine: MachineData;
  designName: string;
  /** firmware block to run; the first one when left out */
  firmware?: string;
  /** builds the world for one variant */
  world: (variant: VariantName, seed: number) => World & { assumptions?: string[] };
  /** longest simulated time, seconds */
  duration: number;
  /** text typed into the serial console, at seconds since power-up */
  console?: { t: number; text: string }[];
  /** #define values to change in the firmware for this run */
  config?: Record<string, number | string>;
  /** battery state of charge at the start, 0..1 */
  soc?: number;
  variants?: VariantName[];
  seed?: number;
  /** stop once every motor has been still this long after moving, seconds */
  idleStop?: number;
  /** how long everything may stay still while the firmware says it is still at work (resting to cool,
   * waiting to retry), seconds */
  restStop?: number;
  frameHz?: number;
  /** progress, 0..1, for each variant as it runs */
  onProgress?: (variant: VariantName, done: number) => void;
}

export interface Frames {
  t: Float32Array;
  series: Record<string, Float32Array>;
}

export interface MotorSummary {
  name: string;
  peakAmps: number;
  maxTemp: number;
  /** energy into the motor, Wh */
  wh: number;
  /** highest share of its stall torque it ran at, averaged over a second */
  loadPeak: number;
  /** its temperatures are a guess: no thermal data for the motor */
  heatGuess?: boolean;
}

export interface RunSummary {
  /** simulated seconds */
  time: number;
  /** wall-clock milliseconds the run took */
  wallMs: number;
  ram: { used: number; total: number; static: number; stack: number };
  /** longest single pass of loop(), ms */
  loopMax: number;
  /** share of the chip's time spent in interrupt handlers */
  isrLoad: number;
  battery?: { start: number; end: number; minVolts: number; usedMah: number; peakAmps: number };
  motors: MotorSummary[];
  eepromWrites: number;
  /** the firmware's last reported state line, if it prints one */
  state?: string;
}

export interface VariantRun {
  variant: VariantName;
  /** why the run ended */
  stop: string;
  /** the run could not start or crashed (firmware compile error, engine error) */
  error?: string;
  frames: Frames;
  events: WorldEvent[];
  serial: SerialLine[];
  faults: SimFault[];
  results: Record<string, number | boolean | string>;
  summary: RunSummary;
  scene: SceneSpec;
  assumptions: string[];
  notes: string[];
  limits: string[];
  /** what each display showed over the run */
  displays: DisplayRun[];
}

export interface DisplayRun {
  name: string;
  w: number;
  h: number;
  frames: DisplayFrame[];
}

export interface RunResult {
  firmware: { name: string; board: string; boardName: string; files: string[]; config: { name: string; from: string; to: string }[] };
  variants: VariantRun[];
  error?: string;
}

const SCALAR = new Set(["int", "float", "bool", "enum"]);

/** Firmware globals worth plotting: plain numbers, not buffers or tables. */
function watchList(globals: Map<string, { t: { k: string } }>): string[] {
  const out: string[] = [];
  for (const [name, g] of globals) {
    if (!SCALAR.has(g.t.k)) continue;
    // constants (ALL_CAPS by convention) and scratch variables are not worth a plot
    if (name.startsWith("_") || /^[A-Z][A-Z0-9_]*$/.test(name) || /^(i|j|k|n|tmp|line|lineLen)$/.test(name)) continue;
    out.push(name);
    if (out.length >= 24) break;
  }
  return out;
}

export function runScenario(opts: RunOptions): RunResult {
  const fwOut = generateFirmware(opts.machine, opts.designName);
  const fw = (opts.firmware ? fwOut.find((f) => f.name === opts.firmware) : fwOut.find((f) => f.target === "arduino")) ?? fwOut[0];
  const empty: RunResult = { firmware: { name: opts.firmware ?? "", board: "", boardName: "", files: [], config: [] }, variants: [] };
  if (!fw) return { ...empty, error: "The design has no firmware block to run" };
  if (fw.target !== "arduino") return { ...empty, error: fw.target === "klipper" ? `${fw.name} is a Klipper printer configuration: Kerf cannot simulate Klipper yet` : fw.summary };
  const mcu = opts.machine.components.find((c) => c.name === fw.board);
  const board = boardForPart(mcu?.catalogId);
  const files: Record<string, string> = Object.fromEntries(fw.files.filter((f) => /\.(ino|h|hpp|c|cpp)$/.test(f.path)).map((f) => [f.path.split("/").pop()!, f.content]));
  const changed = applyConfig(files, opts.config ?? {});
  if (typeof changed === "string") return { ...empty, firmware: { ...empty.firmware, name: fw.name }, error: changed };
  const info = { name: fw.name, board: fw.board, boardName: board.name, files: Object.keys(files), config: changed };
  const variants = opts.variants ?? VARIANTS;
  const out: VariantRun[] = [];
  // each variant has its own seed, so one variant run alone matches the same variant in a full run
  for (const v of variants) out.push(runVariant(opts, v, (opts.seed ?? 1) + VARIANTS.indexOf(v) * 7919, files, fw.board, board));
  return { firmware: info, variants: out };
}

/** the line firmware prints when it changes what it is doing */
const STATE_LINE = /^state:\s*(.+)$/;
/** states in which firmware with every motor still has nothing more to do */
const SETTLED = /^(done|fault|finished|stopped|stop|idle|error|bench|waiting|ready|off)\b/i;

function runVariant(opts: RunOptions, variant: VariantName, seed: number, files: Record<string, string>, mcuName: string, board: ReturnType<typeof boardForPart>): VariantRun {
  const wall0 = Date.now();
  const hal = new SimHal(board, { seed });
  const world = opts.world(variant, seed);
  const rng = rngFrom(seed * 31 + 7);
  const plant = new Plant(opts.machine, mcuName, board, hal, world, { soc: opts.soc ?? 1, rng });
  const frameDt = 1 / (opts.frameHz ?? 10);
  const cols: Record<string, number[]> = {};
  const times: number[] = [];
  let names: string[] | null = null;
  let nextFrame = 0;
  let watch: string[] = [];
  let stop = "duration";
  let error: string | undefined;
  const idleStop = opts.idleStop ?? 10;
  const restStop = Math.max(idleStop, opts.restStop ?? 600);
  // nothing ends the run before the last text typed into the console
  const lastTyped = Math.max(0, ...(opts.console ?? []).map((c) => c.t));
  // the firmware's own word for what it is doing, from its latest "state: ..." line
  let fwState = "";
  hal.onLine = (text) => {
    const m = STATE_LINE.exec(text);
    if (m) fwState = m[1];
  };
  let moved = false;
  let stillSince = 0;
  let finishedAt = -1;
  const motorSpecs = new Map(plant.motors.map((m) => [m.comp, Number(catalogPart(m.mc.catalogId)?.specs.t_stall ?? 1000) / 1000]));
  const soc0 = plant.batteries[0]?.b.soc ?? 0;

  let fwRef: ReturnType<typeof loadFirmware> | null = null;
  const record = (t: number) => {
    const row: Record<string, number> = {};
    plant.channels(row);
    Object.assign(row, world.channels());
    if (fwRef) for (const g of watch) {
      const v = fwRef.fw.read(g);
      if (typeof v === "number") row[`fw.${g}`] = v;
    }
    if (!names) {
      names = Object.keys(row);
      for (const n of names) cols[n] = [];
    }
    times.push(t);
    for (const n of names) cols[n].push(row[n] ?? NaN);
  };

  plant.afterStep = (t) => {
    if (t >= nextFrame) {
      record(t);
      nextFrame += frameDt;
      opts.onProgress?.(variant, Math.min(1, t / opts.duration));
    }
    const anyMoving = plant.motors.some((m) => Math.abs(m.m.omega) > 0.05) || plant.acts.some((a) => Math.abs(a.a.speed) > 0.05);
    if (anyMoving) {
      moved = true;
      stillSince = t;
    } else if (moved && t - stillSince > idleStop && t > lastTyped) {
      // firmware that says it is still at work is resting (cooling, about to retry), not finished
      const working = fwState !== "" && !SETTLED.test(fwState);
      if (!working || t - stillSince > restStop) {
        stop = working ? `everything stopped (for ${Math.round(restStop / 60)} min, with the firmware still ${fwState.replace(/\s*\(.*$/, "")})` : "everything stopped";
        hal.endCyc = 0;
      }
    }
    if (finishedAt < 0 && world.finished(t)) finishedAt = t;
    if (finishedAt >= 0 && t - finishedAt > 2) {
      stop = "the job is done";
      hal.endCyc = 0;
    }
  };

  hal.endCyc = Math.round(opts.duration * board.fcpu);
  for (const c of opts.console ?? []) hal.typeAt(c.t, c.text.endsWith("\n") ? c.text : c.text + "\n");
  let loopMax = 0;
  try {
    fwRef = loadFirmware(files, board, hal);
    hal.bindVectors(fwRef.fw);
    watch = watchList(fwRef.fw.globals as Map<string, { t: { k: string } }>);
    fwRef.fw.reset();
    fwRef.fw.call("setup");
    for (;;) {
      const c0 = hal.cyc;
      fwRef.fw.call("loop");
      const used = hal.cyc - c0;
      if (used > loopMax) loopMax = used;
      // the chip would go straight round again; one pass a millisecond is enough for the world
      if (used < hal.stepCycles) hal.spend(hal.stepCycles - used);
      else if (hal.cyc >= hal.nextEvt) hal.service();
    }
  } catch (e) {
    if (e instanceof Halt) {
      if (e.reason !== "end") stop = e.reason;
    } else if (e instanceof CError) {
      error = `${e.file}:${e.line}: ${e.message}`;
      stop = "the firmware does not compile";
    } else {
      error = e instanceof Error ? e.message : String(e);
      stop = "the simulation failed";
    }
  }
  hal.finishSerial();
  record(hal.time);

  // events from the world, the plant, the firmware's own state messages and its faults
  const events: WorldEvent[] = [...world.events, ...plant.events];
  let state: string | undefined;
  for (const l of hal.serial) {
    if (l.dir !== "out") continue;
    const m = STATE_LINE.exec(l.text);
    if (m) {
      state = m[1];
      events.push({ t: l.t, kind: /fault|stuck|low|error/i.test(m[1]) ? "warn" : "info", text: `Firmware: ${m[1]}` });
    }
  }
  for (const f of hal.faults) events.push({ t: f.t, kind: "warn", text: `Firmware mistake: ${f.msg}${f.count > 1 ? ` (${f.count} times)` : ""}` });
  events.sort((a, b) => a.t - b.t);

  const frames: Frames = { t: Float32Array.from(times), series: {} };
  for (const [n, v] of Object.entries(cols)) frames.series[n] = Float32Array.from(v);

  const bat = plant.batteries[0]?.b;
  const total = Math.max(1, hal.cyc);
  const summary: RunSummary = {
    time: hal.time,
    wallMs: Date.now() - wall0,
    ram: { used: (fwRef?.staticRam ?? 0) + hal.stackPeak, total: board.ramBytes, static: fwRef?.staticRam ?? 0, stack: hal.stackPeak },
    loopMax: (loopMax / board.fcpu) * 1000,
    isrLoad: hal.isrCycles / total,
    battery: bat ? { start: soc0 * 100, end: bat.soc * 100, minVolts: bat.minV, usedMah: bat.ah * 1000, peakAmps: plant.peakBatteryCurrent } : undefined,
    motors: plant.motors.map((m) => ({ name: m.comp, peakAmps: m.m.peakCurrent, maxTemp: m.m.maxTemp, wh: m.m.energy / 3600, loadPeak: peakOf(frames, `${m.comp}.torque`) / (motorSpecs.get(m.comp) ?? 1), heatGuess: m.m.heatGuess || undefined })),
    eepromWrites: hal.eepromWrites,
    state,
  };
  const results: Record<string, number | boolean | string> = { ...world.results() };
  results.time = summary.time;
  results.stopped = stop;
  if (state) results.state = state;
  results.faults = hal.faults.length;
  // shares are fractions and times seconds, so `battery_left > 30%` and `loop_time < 5ms` read as written
  results.ram = summary.ram.used;
  results.ram_use = summary.ram.used / summary.ram.total;
  results.loop_time = summary.loopMax / 1000;
  if (summary.battery) {
    results.battery_left = summary.battery.end / 100;
    results.battery_min_volts = summary.battery.minVolts;
    results.battery_used = summary.battery.usedMah;
    results.battery_peak_amps = summary.battery.peakAmps;
  }
  for (const m of summary.motors) {
    results[`${m.name}.peak_amps`] = m.peakAmps;
    results[`${m.name}.max_temp`] = m.maxTemp;
    results[`${m.name}.load`] = m.loadPeak;
  }
  for (const a of plant.acts) results[`${a.comp}.travel`] = a.a.travel;
  if (fwRef) for (const g of watch) {
    const v = fwRef.fw.read(g);
    if (typeof v === "number") results[`fw.${g}`] = v;
  }
  const notes = [...plant.notes];
  if (hal.serial.length > 4000) notes.push(`The serial log kept the first 4000 of ${hal.serial.length} lines.`);
  return {
    variant,
    stop,
    error,
    frames,
    events,
    serial: hal.serial.slice(0, 4000),
    faults: hal.faults,
    results,
    summary,
    scene: world.scene(),
    displays: plant.displays.map((d) => (d.tick(hal.cyc, true), { name: d.name, w: d.w, h: d.h, frames: d.frames })),
    assumptions: [...plant.assumptions, ...(world.assumptions ?? [])],
    notes,
    limits: [...world.limits, "The firmware runs as compiled C++ on a cycle-counted virtual chip, not as the real AVR machine code: timing is close but not exact.", "Electrical: average-voltage motor models, no wiring resistance or electrical noise."],
  };
}

function peakOf(f: Frames, name: string): number {
  const s = f.series[name];
  if (!s) return 0;
  // the highest one-second average
  let best = 0;
  let sum = 0;
  const w = 10;
  for (let i = 0; i < s.length; i++) {
    sum += Math.abs(s[i]);
    if (i >= w) sum -= Math.abs(s[i - w]);
    if (i >= w - 1) best = Math.max(best, sum / w);
  }
  return best;
}

/**
 * Changes `#define NAME value` lines in the firmware files for this run.
 * Returns what changed, or why it could not (a name the firmware does not define).
 */
export function applyConfig(files: Record<string, string>, config: Record<string, number | string>): { name: string; from: string; to: string }[] | string {
  const out: { name: string; from: string; to: string }[] = [];
  for (const [name, value] of Object.entries(config)) {
    const re = new RegExp(`^([ \\t]*#define[ \\t]+${name}[ \\t]+)([^\\r\\n]*?)([ \\t]*(//[^\\r\\n]*)?)$`, "m");
    let found = false;
    for (const [f, text] of Object.entries(files)) {
      const m = re.exec(text);
      if (!m) continue;
      const to = typeof value === "number" ? String(value) : JSON.stringify(value);
      files[f] = text.replace(re, (_all, head: string, _v: string, tail: string) => `${head}${to}${tail}`);
      out.push({ name, from: m[2].trim(), to });
      found = true;
      break;
    }
    if (!found) {
      const names = new Set<string>();
      for (const text of Object.values(files)) for (const m of text.matchAll(/^[ \t]*#define[ \t]+([A-Z_][A-Z0-9_]*)[ \t]+\S/gm)) names.add(m[1]);
      return `config: the firmware has no setting ${name}${names.size ? `. Its settings: ${[...names].slice(0, 30).join(", ")}` : ""}`;
    }
  }
  return out;
}
