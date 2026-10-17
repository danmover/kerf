// Runs a print: the design's generated printer config (Klipper, Marlin or
// RepRapFirmware) read back into its firmware's planner, heater control and
// G-code interpreter, driving the physical printer from the design. Each
// variant (pessimistic, expected, optimistic) is a run of its own with its
// own motors, heaters, room and bed. A run records a timeline of
// temperatures, power, flow and motor load, the firmware's messages, and a
// trace of every move as it really happened (layer shifts and
// under-extrusion included) for the 3D playback.

import { catalogPart } from "../../machine/catalog";
import { generateFirmware } from "../../machine/firmware";
import { FLAVOR_NAME, flavorOf, type PrinterFlavor } from "../../machine/firmware/printer";
import type { MachineData } from "../../machine/types";
import type { Frames, RunResult, RunSummary, VariantRun } from "../engine/run";
import type { SerialLine } from "../engine/hal";
import { rngFrom, gauss, VARIANTS, type VariantName } from "../worlds/common";
import type { WorldEvent } from "../worlds/types";
import { readSetup, type Axis3, type AxisE, type PrinterSetup } from "./config";
import { PrinterFirmware, PrintStop, type Mesh, type PrinterIO } from "./firmware";
import { HeaterSim } from "./heaters";
import { motorTorque, printerPhys, type AxisPhys, type PrinterPhys } from "./machine";
import { phases, type PlanMove } from "./planner";
import { testPrintGcode, testPrintDefaults, type PrintMaterial, type TestPrintSpec } from "./testPrint";

/** What sim.printer(...) describes. */
export interface PrinterWorldSpec {
  /** a ready-made test print, or G-code text */
  test?: Partial<TestPrintSpec> & { shape: TestPrintSpec["shape"] };
  gcode?: string;
  gcodeName?: string;
  /** run a different firmware than the block's own (the board must run it) */
  flavor?: PrinterFlavor;
  material: PrintMaterial;
  /** room temperature, °C */
  ambient: number;
}

export interface PrinterRunOptions {
  machine: MachineData;
  designName: string;
  firmware?: string;
  world: PrinterWorldSpec;
  /** longest simulated time, s */
  duration: number;
  /** firmware block settings to change for this run (max_accel, square_corner_velocity, ...) */
  config?: Record<string, number | string>;
  variants?: VariantName[];
  seed?: number;
  onProgress?: (variant: VariantName, done: number) => void;
}

/** Every move as it really happened, for the 3D playback. */
export interface PrintTrace {
  /** time each move ends, s, and where the nozzle really is over the bed then, mm */
  t: Float32Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** plastic laid per mm of the move, mm² (0 for travel) */
  a: Float32Array;
  nozzle: number;
  /** the printable area and the layer height the print was sliced for */
  size: [number, number, number];
  layer: number;
}

/** How each variant's printer differs from the design's numbers. */
const VF: Record<VariantName, { torque: number; friction: number; mass: number; heat: number; loss: number; ambient: number; melt: number; bow: number; tilt: number; noise: number; cal: number }> = {
  pessimistic: { torque: 0.85, friction: 1.4, mass: 1.1, heat: 0.9, loss: 1.25, ambient: -5, melt: 0.8, bow: 0.25, tilt: 0.15, noise: 0.008, cal: 0.04 },
  expected: { torque: 1, friction: 1, mass: 1, heat: 1, loss: 1, ambient: 0, melt: 1, bow: 0.1, tilt: 0.05, noise: 0.004, cal: 0.015 },
  optimistic: { torque: 1.1, friction: 0.8, mass: 0.95, heat: 1.05, loss: 0.9, ambient: 3, melt: 1.1, bow: 0.04, tilt: 0.02, noise: 0.002, cal: 0 },
};

/** Melt properties: g/cm³, J/(g·K), the lowest temperature it flows at all and the temperature the hotend's rated flow is for. */
const MELT: Record<PrintMaterial, { density: number; cp: number; flowMin: number; nominal: number }> = {
  PLA: { density: 1.24, cp: 1.8, flowMin: 175, nominal: 215 },
  PETG: { density: 1.27, cp: 1.5, flowMin: 210, nominal: 245 },
  ABS: { density: 1.04, cp: 1.6, flowMin: 215, nominal: 250 },
};

const PRINTER_TARGETS = new Set(["klipper", "marlin", "reprapfirmware"]);

export function runPrinter(opts: PrinterRunOptions): RunResult {
  const empty: RunResult = { firmware: { name: opts.firmware ?? "", board: "", boardName: "", files: [], config: [] }, variants: [] };
  const m = opts.machine;
  const blocks = generateFirmware(m, opts.designName);
  const block = opts.firmware ? m.firmware.find((f) => f.name === opts.firmware) : m.firmware.find((_f, i) => PRINTER_TARGETS.has(blocks[i]?.target));
  if (!block) return { ...empty, error: opts.firmware ? `There is no firmware block called ${opts.firmware}` : "The design has no printer firmware block (Klipper, Marlin or RepRapFirmware) to run" };
  // this run's settings: the scenario's config and the flavor it asks for
  // sim.config(MAX_ACCEL: 6000) changes the block's max_accel setting
  const overrides: Record<string, number | string> = Object.fromEntries(Object.entries(opts.config ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (opts.world.flavor) overrides.flavor = opts.world.flavor;
  const changed = Object.entries(overrides).map(([name, to]) => ({ name, from: block.settings[name] === undefined ? "(default)" : String(block.settings[name]), to: String(to) }));
  const machine: MachineData = Object.keys(overrides).length ? { ...m, firmware: m.firmware.map((f) => (f === block ? { ...f, settings: { ...f.settings, ...overrides } } : f)) } : m;
  const out = (Object.keys(overrides).length ? generateFirmware(machine, opts.designName) : blocks)[m.firmware.indexOf(block)];
  const fwDef = machine.firmware[m.firmware.indexOf(block)];
  const boardComp = m.components.find((c) => c.name === block.board);
  const boardName = catalogPart(boardComp?.catalogId ?? "")?.name ?? block.board ?? "";
  const info = { name: block.name, board: block.board ?? "", boardName, files: out?.files.map((f) => f.path) ?? [], config: changed };
  const flavor = out && flavorOf(out.target);
  // a setting the generator does not use changes nothing: say so rather than run the same config
  const before = blocks[m.firmware.indexOf(block)];
  for (const k of Object.keys(opts.config ?? {})) {
    const solo = { ...m, firmware: m.firmware.map((f) => (f === block ? { ...f, settings: { ...block.settings, [k.toLowerCase()]: opts.config![k] } } : f)) };
    const after = generateFirmware(solo, opts.designName)[m.firmware.indexOf(block)];
    if (after && before && after.files.map((f) => f.content).join() === before.files.map((f) => f.content).join() && String(block.settings[k.toLowerCase()] ?? "") !== String(opts.config![k]))
      return { ...empty, firmware: info, error: `config: ${k} changes nothing in ${block.name}'s generated config. Printer settings include MAX_VELOCITY, MAX_ACCEL, SQUARE_CORNER_VELOCITY, PRESSURE_ADVANCE, X_RUN_CURRENT, Y_RUN_CURRENT, Z_RUN_CURRENT and E_RUN_CURRENT.` };
  }
  if (!out || !flavor) return { ...empty, firmware: info, error: out?.target === "arduino" ? `${block.name} is an Arduino sketch: use sim.bench() for it` : (out?.summary ?? `Kerf cannot generate printer firmware for ${block.name}`) };
  if (opts.world.flavor && flavor !== opts.world.flavor) return { ...empty, firmware: info, error: `${boardName} cannot run ${FLAVOR_NAME[opts.world.flavor]}: ${out.warnings[0] ?? out.summary}` };
  const setup = readSetup(flavor, out.files);
  if (setup.errors.length) return { ...empty, firmware: info, error: `${FLAVOR_NAME[flavor]} would not start with this config: ${setup.errors.join(" ")}` };
  const phys = printerPhys(machine, fwDef, opts.designName);
  if (typeof phys === "string") return { ...empty, firmware: info, error: phys };
  for (const ax of ["x", "y", "z"] as Axis3[]) if (!phys.axes[ax]) return { ...empty, firmware: info, error: `No ${ax.toUpperCase()} motor is cabled to ${phys.board.comp}: the printer cannot move` };

  // the G-code: a test print sliced for this firmware, or the scenario's own
  let gcode: string;
  let gname: string;
  let layer = 0.2;
  let material = opts.world.material;
  if (opts.world.test) {
    const spec: TestPrintSpec = { ...testPrintDefaults(opts.world.test.shape, opts.world.test.material ?? material), ...opts.world.test } as TestPrintSpec;
    material = spec.material;
    try {
      const tp = testPrintGcode(spec, {
        flavor,
        startMacro: setup.macros.has("START_PRINT") && setup.macros.has("END_PRINT"),
        probe: !!setup.probe?.mesh,
        size: { x: setup.max.x - Math.max(0, setup.min.x), y: setup.max.y - Math.max(0, setup.min.y), z: setup.max.z },
        nozzle: setup.extruder.nozzle,
        filament: setup.extruder.filament,
      });
      gcode = tp.gcode;
      gname = `${spec.shape}.gcode`;
      layer = spec.layer;
    } catch (e) {
      return { ...empty, firmware: info, error: `sim.test_print(): ${e instanceof Error ? e.message : String(e)}` };
    }
  } else if (opts.world.gcode !== undefined) {
    gcode = opts.world.gcode;
    gname = opts.world.gcodeName ?? "print.gcode";
    const lh = /;\s*layer_height\s*=\s*([\d.]+)/.exec(gcode);
    if (lh) layer = Number(lh[1]);
  } else return { ...empty, firmware: info, error: "sim.printer() needs something to print: print: sim.test_print(\"cube\") or gcode: \"...\"" };

  const variants = opts.variants ?? VARIANTS;
  const runs = variants.map((v) => runVariant(opts, v, (opts.seed ?? 1) + VARIANTS.indexOf(v) * 7919, setup, phys, gcode, gname, material, layer, out.files));
  return { firmware: info, variants: runs };
}

class TimeUp extends Error {}

function runVariant(opts: PrinterRunOptions, variant: VariantName, seed: number, setup: PrinterSetup, phys: PrinterPhys, gcode: string, gname: string, material: PrintMaterial, layerH: number, files: { path: string; content: string }[]): VariantRun {
  const wall0 = Date.now();
  const vf = VF[variant];
  const rng = rngFrom(seed * 31 + 7);
  const ambient = opts.world.ambient + vf.ambient;
  const melt = MELT[material];
  const events: WorldEvent[] = [];
  const serial: SerialLine[] = [];
  const notes: string[] = [...setup.notes];
  const assumptions: string[] = [...phys.assumptions];
  let t = 0;
  const frameDt = Math.min(2, Math.max(0.25, opts.duration / 20000));
  let nextFrame = 0;
  const cols: Record<string, number[]> = {};
  const times: number[] = [];

  // ---- the printer as built ----
  const fa = (Math.PI / 4) * setup.extruder.filament ** 2;
  const heaterEnv = { ambient, power: vf.heat, loss: vf.loss };
  const hot = phys.hotend && setup.hotend ? new HeaterSim(phys.hotend, setup.hotend, setup.safety.hotend, setup.flavor, heaterEnv, setup.wait) : undefined;
  const bed = phys.bed && setup.bed ? new HeaterSim(phys.bed, setup.bed, setup.safety.bed, setup.flavor, heaterEnv, setup.wait) : undefined;
  if (phys.hotend && !setup.hotend) notes.push("The config sets up no hotend heater, so it never heats.");
  if (phys.bed && !setup.bed) notes.push("The config sets up no heated bed, so it never heats.");
  // the bed's real surface: a dome and a tilt, mm, relative to its centre
  const [bw, bd] = phys.bed_size;
  const cx = (setup.min.x + setup.max.x) / 2;
  const cy = (setup.min.y + setup.max.y) / 2;
  const tiltA = (rng() * 2 - 1) * Math.PI;
  const surface = (x: number, y: number) => {
    const u = (x - cx) / (bw / 2);
    const v = (y - cy) / (bd / 2);
    return vf.bow * (1 - Math.min(2, u * u + v * v) / 2) - vf.bow / 2 + vf.tilt * 0.5 * (u * Math.cos(tiltA) + v * Math.sin(tiltA));
  };
  const probeOff = setup.probe ?? { x: 0, y: 0, z: 0 };
  // the probe's real trigger height is what was calibrated, give or take
  const zTrue = probeOff.z - vf.cal;
  let homeRef = 0;
  let mesh: Mesh | null = null;
  const meshAt = (x: number, y: number): number => {
    if (!mesh) return 0;
    const { min, max, count, z } = mesh;
    const fx = Math.max(0, Math.min(count[0] - 1, ((x + probeOff.x - min[0]) / Math.max(1e-9, max[0] - min[0])) * (count[0] - 1)));
    const fy = Math.max(0, Math.min(count[1] - 1, ((y + probeOff.y - min[1]) / Math.max(1e-9, max[1] - min[1])) * (count[1] - 1)));
    const i = Math.min(count[0] - 2, Math.floor(fx));
    const j = Math.min(count[1] - 2, Math.floor(fy));
    if (count[0] < 2 || count[1] < 2) return z[0][0];
    const u = fx - i;
    const w = fy - j;
    return (z[j][i] * (1 - u) + z[j][i + 1] * u) * (1 - w) + (z[j + 1][i] * (1 - u) + z[j + 1][i + 1] * u) * w;
  };
  /** how far the real gap under the nozzle is from what the firmware believes, mm (+ is too high) */
  const gapError = (x: number, y: number) => homeRef + meshAt(x, y) - surface(x, y) - (zHomedProbe ? probeOff.z - zTrue : 0);
  let zHomedProbe = false;

  // motor currents per motor
  const ampsOf = (ax: AxisE): number => {
    const pa = ax === "e" ? "extruder" : ax;
    const cur = setup.currents[ax] ?? phys.facts.current[pa]?.want ?? 0.8;
    const fc = phys.facts.current[pa];
    return fc?.parallel ? cur / Math.max(1, fc.motors) : cur;
  };
  const axes = (["x", "y", "z", "e"] as AxisE[]).map((ax) => phys.axes[ax]).filter((a): a is AxisPhys => !!a);
  const loadPeak: Partial<Record<AxisE, number>> = {};
  const loadFrame: Partial<Record<AxisE, number>> = {};
  let motorsOn = false;

  // ---- state the run keeps ----
  const phy: Record<Axis3, number> = { x: (setup.min.x + setup.max.x) / 2, y: (setup.min.y + setup.max.y) / 2, z: 30 };
  // carriage minus firmware position on each axis: lost steps and an unhomed start
  const shift: Record<Axis3, number> = { x: phy.x, y: phy.y, z: phy.z };
  let fan = 0;
  let pa = setup.pa;
  let stoppedWhy: string | null = null;
  let finished = false;
  let printing = false;
  let firstExtrude = -1;
  let lastExtrude = 0;
  let heatWait = 0;
  let shifts = 0;
  let maxShift = 0;
  // the X and Y belts: the most the carriage rings after a change of speed while printing, mm, and the slackest the belt's slack side gets, N
  let ringPeak = 0;
  let beltSlack = Infinity;
  let slackWarned = false;
  let ringWarned = false;
  let askedVol = 0;
  let laidVol = 0;
  let flowPeak = 0;
  let flowNow = 0;
  let underNow = 0;
  let speedNow = 0;
  let psuPeak = 0;
  let energy = 0;
  let firstLayerZ = Infinity;
  const first = { max: 0, sum: 0, len: 0, low: 0, high: 0 };
  let hotErr = 0;
  let bedErr = 0;
  let underWarned = -1;
  let clickWarned = false;
  let errors = 0;
  let extrudeLen = 0;
  let extrudeTime = 0;
  const trace = { t: [0] as number[], x: [phy.x] as number[], y: [phy.y] as number[], z: [phy.z] as number[], a: [0] as number[] };
  const MAX_TRACE = 400_000;

  const event = (kind: WorldEvent["kind"], text: string) => events.push({ t, kind, text });

  const record = (x: number, y: number, z: number) => {
    const row: Record<string, number> = {
      "nozzle.x": x,
      "nozzle.y": y,
      "nozzle.z": z,
      "print.speed": speedNow,
      "print.flow": flowNow,
      "print.under": underNow,
      "hotend.temp": hot?.reading ?? NaN,
      "hotend.target": hot?.target ?? NaN,
      "hotend.power": hot ? hot.duty * 100 : NaN,
      "bed.temp": bed?.reading ?? NaN,
      "bed.target": bed?.target ?? NaN,
      "bed.power": bed ? bed.duty * 100 : NaN,
      "fan.part": fan * 100,
      "psu.watts": watts(),
    };
    for (const a of axes) row[`${a.axis === "e" ? "extruder" : a.axis}.load`] = (loadFrame[a.axis] ?? 0) * 100;
    for (const k of Object.keys(loadFrame)) loadFrame[k as AxisE] = 0;
    if (!times.length) for (const k of Object.keys(row)) cols[k] = [];
    times.push(t);
    for (const [k, v] of Object.entries(row)) cols[k].push(v);
  };

  const watts = () => {
    let w = phys.idleWatts;
    if (hot) w += hot.duty * phys.hotend!.power * vf.heat;
    if (bed) w += bed.duty * phys.bed!.power * vf.heat;
    if (motorsOn) for (const a of axes) w += a.motors * 2 * ampsOf(a.axis) ** 2 * a.rPhase * 0.7;
    return w;
  };

  /** let `dt` seconds pass; the nozzle at `pos(f)` for f from 0 to 1 */
  const pass = (dt: number, flowW: number, pos?: (f: number) => [number, number, number]) => {
    const t0 = t;
    const end = t + dt;
    while (t < end - 1e-12) {
      const h = Math.min(0.05, end - t);
      hot?.step(h, t, fan, flowW);
      bed?.step(h, t, 0, 0);
      const w = watts();
      energy += w * h;
      if (w > psuPeak) psuPeak = w;
      t += h;
      if (t >= nextFrame) {
        const f = dt > 0 ? (t - t0) / dt : 1;
        const p = pos ? pos(f) : [phy.x, phy.y, phy.z];
        record(p[0], p[1], p[2]);
        nextFrame += frameDt;
        opts.onProgress?.(variant, Math.min(0.999, fw ? fw.stats.lines / totalLines : 0));
      }
      if (printing && hot && hot.target > 0 && hot.reading > hot.target - 10) hotErr = Math.max(hotErr, Math.abs(hot.reading - hot.target));
      if (printing && bed && bed.target > 0 && bed.reading > bed.target - 5) bedErr = Math.max(bedErr, Math.abs(bed.reading - bed.target));
      const fault = hot?.fault ?? bed?.fault;
      if (fault && !stoppedWhy) {
        stoppedWhy = fault.msg;
        serial.push({ t, dir: "out", text: fault.msg });
        event("warn", `${FLAVOR_NAME[setup.flavor]} stopped: ${fault.msg}`);
      }
      if (t > opts.duration) throw new TimeUp();
    }
  };

  const io: PrinterIO = {
    now: () => t,
    run: (m) => runMove(m),
    waitUntil: (done, max) => {
      const t0 = t;
      const waitingHeat = !!(hot?.target || bed?.target);
      while (!done()) {
        if (stoppedWhy) return false;
        if (t - t0 >= max) return false;
        pass(Math.min(0.25, max - (t - t0)), 0);
      }
      if (waitingHeat) heatWait += t - t0;
      return true;
    },
    heater: (role) => (role === "hotend" ? hot : bed),
    fan: (v) => {
      fan = v;
    },
    actual: (ax) => phy[ax],
    homed: (ax, pos) => {
      phy[ax] = pos;
      shift[ax] = 0;
      if (ax === "z") {
        // a Z switch: set with a sheet of paper at the middle of the bed, give or take
        homeRef = surface(cx, cy) + vf.cal;
        zHomedProbe = false;
      }
    },
    probeGap: (x, y) => phy.z - (surface(x + probeOff.x, y + probeOff.y) + zTrue),
    probeHomed: (x, y, z) => {
      // the nozzle stands zTrue above the surface under the probe, and the firmware calls that z
      homeRef = surface(x + probeOff.x, y + probeOff.y);
      phy.z = z;
      shift.z = 0;
      zHomedProbe = true;
    },
    probe: (x, y) => surface(x + probeOff.x, y + probeOff.y) - homeRef + gauss(rng) * vf.noise,
    setMesh: (msh) => {
      mesh = msh;
    },
    setPressureAdvance: (v) => {
      pa = v;
    },
    motorsOff: () => {
      motorsOn = false;
    },
    stopped: () => stoppedWhy,
    say: (text, level) => {
      serial.push({ t, dir: "out", text });
      if (level === "error") errors++;
      if (level !== "info" || /Mesh|Leveling|probed/.test(text)) event(level === "info" ? "info" : "warn", `${FLAVOR_NAME[setup.flavor]}: ${text.replace(/^(\/\/ |!! |echo:)/, "")}`);
    },
  };

  /** Run one planned move on the real hardware: motors, melt and heat, as it happens. */
  function runMove(m: PlanMove) {
    motorsOn = true;
    const ph = phases(m);
    const T = ph.accelT + ph.cruiseT + ph.decelT;
    // ---- motors: torque needed against torque available, through each part of the move ----
    for (const a of axes) {
      const i = ["x", "y", "z", "e"].indexOf(a.axis);
      const r = Math.abs(m.r[i]);
      if (r < 1e-9) continue;
      const tpr = a.mmPerRev;
      const amps = ampsOf(a.axis);
      const mass = a.mass * vf.mass;
      let fr = a.friction * vf.friction;
      if (a.axis === "e") {
        // the melt pushes back harder as the flow nears what the hotend can melt
        const q = (Math.abs(m.d[3]) * fa) / Math.max(T, 1e-6);
        const qmax = meltRate();
        fr += m.d[3] > 0 && m.kin ? 40 * Math.min(4, (q / Math.max(qmax, 0.1)) ** 2) : 0;
      }
      const up = a.vertical && m.d[i] > 0;
      const torqueNeed = (acc: number, brake: boolean) => {
        const ma = (mass * acc) / 1000;
        const F = brake ? Math.max(fr, ma - fr) : ma + fr + (a.vertical && up ? mass * 9.81 : 0);
        const alpha = (acc / tpr) * 2 * Math.PI;
        return (F * tpr) / (2 * Math.PI * a.efficiency) + a.inertia * a.motors * alpha * 1000;
      };
      const avail = (v: number) => a.motors * motorTorque(a, amps, v / tpr, phys.supply) * vf.torque;
      const vax = m.cruiseV * r;
      const aax = m.accel * r;
      const parts: [number, number][] = [];
      if (ph.accelT > 0) parts.push([torqueNeed(aax, false) / avail(vax), 0]);
      if (ph.cruiseT > 0) parts.push([torqueNeed(0, false) / avail(vax), 1]);
      if (ph.decelT > 0) parts.push([torqueNeed(aax, true) / avail(vax), 2]);
      let worst = 0;
      for (const [load, part] of parts) {
        worst = Math.max(worst, load);
        if (load > 1 && a.axis !== "e") {
          // the rotor falls behind and slips whole electrical cycles (4 full steps) until the move slows
          const q = (4 * tpr) / a.fullSteps;
          const along = (part === 0 ? m.dist : part === 1 ? ph.cruiseD + ph.decelD : ph.decelD) * r;
          const lost = Math.max(q, Math.round((along * Math.min(1, load - 1 + 0.5)) / q) * q);
          const ax = a.axis as Axis3;
          shift[ax] -= Math.sign(m.d[i]) * lost;
          shifts++;
          maxShift = Math.max(maxShift, Math.hypot(shift.x, shift.y));
          if (shifts <= 20) event("stall", `${a.label} skipped ${lost.toFixed(2)} mm (${a.comp} needed ${(load * 100).toFixed(0)} % of its torque at ${vax.toFixed(0)} mm/s): ${ax === "z" ? "the layers below are now the wrong height" : "a layer shift"} at ${m.tag.file}:${m.tag.line}`);
          break;
        }
        if (load > 1 && a.axis === "e" && !clickWarned) {
          clickWarned = true;
          event("stall", `The extruder skips (clicks): the melt pushes back harder than ${a.comp} can push at ${m.tag.file}:${m.tag.line}`);
        }
      }
      loadPeak[a.axis] = Math.max(loadPeak[a.axis] ?? 0, worst);
      loadFrame[a.axis] = Math.max(loadFrame[a.axis] ?? 0, worst);
      // ---- the belt: it stretches under the pull, rings, and can go slack or jump a tooth ----
      const b = a.belt;
      if (b && aax > 0 && ph.accelT + ph.decelT > 0) {
        const ax = a.axis as Axis3;
        const pull = (mass * aax) / 1000 + fr;
        const slack = b.tension - b.share * pull;
        beltSlack = Math.min(beltSlack, slack);
        // the mass on the belt's spring rings at ω = √(k/m) after each step in acceleration, by a/ω²
        const w2 = (b.k * 1000) / Math.max(mass, 1e-3);
        const ring = aax / w2;
        if (m.d[3] > 0 && m.kin) {
          ringPeak = Math.max(ringPeak, ring);
          if (ring > 0.05 && !ringWarned) {
            ringWarned = true;
            const hz = Math.sqrt(w2) / (2 * Math.PI);
            event("warn", `Ringing: the ${b.title} lets ${ax === "y" ? "the bed" : "the carriage"} ring at ${hz.toFixed(0)} Hz, about ${(ring * 1000).toFixed(0)} µm of ghosting after each corner (first at ${m.tag.file}:${m.tag.line}); an input shaper tuned to ${hz.toFixed(0)} Hz or less acceleration would cut it`);
          }
        }
        if (slack < 0 && !slackWarned) {
          slackWarned = true;
          event("warn", `The ${b.title} goes slack: a ${pull.toFixed(0)} N pull beats its ${b.tension.toFixed(0)} N tension, so ${a.label} has backlash while it speeds up and slows down (first at ${m.tag.file}:${m.tag.line})`);
        }
        if (pull > b.teAllowed) {
          // the teeth in mesh ride over the pulley: the axis is a pitch out from here on
          shift[ax] -= Math.sign(m.d[i]) * b.pitch;
          shifts++;
          maxShift = Math.max(maxShift, Math.hypot(shift.x, shift.y));
          if (shifts <= 20) event("stall", `The ${b.title} jumped a tooth (${pull.toFixed(0)} N pull, ${b.teAllowed.toFixed(0)} N on the teeth in mesh): a ${b.pitch} mm layer shift at ${m.tag.file}:${m.tag.line}`);
        }
      }
    }
    // ---- extrusion: what the hotend can melt at its temperature ----
    const de = m.d[3];
    let laid = 0;
    let flowW = 0;
    const xyd = Math.hypot(m.d[0], m.d[1]);
    if (de > 0 && m.kin && xyd > 1e-9) {
      const vol = de * fa;
      const qCruise = (vol / m.dist) * m.cruiseV;
      const qmax = meltRate();
      const frac = qCruise > qmax ? Math.max(0, qmax / qCruise) : 1;
      const clicking = (loadPeak.e ?? 0) > 1 && qCruise > qmax;
      laid = vol * frac * (clicking ? 0.85 : 1);
      askedVol += vol;
      laidVol += laid;
      flowNow = laid / Math.max(T, 1e-6);
      flowPeak = Math.max(flowPeak, Math.min(qCruise, qmax));
      underNow = (1 - laid / vol) * 100;
      flowW = flowNow * (melt.density / 1000) * melt.cp * Math.max(0, (hot?.T ?? 200) - ambient);
      if (frac < 0.95 && underWarned !== Math.round(m.start[2] * 100)) {
        if (underWarned < 0) event("warn", `Under-extrusion: the print asks for ${qCruise.toFixed(1)} mm³/s but the hotend melts only ${qmax.toFixed(1)} mm³/s at ${hot?.reading.toFixed(0) ?? "?"} °C (${m.tag.file}:${m.tag.line})`);
        underWarned = Math.round(m.start[2] * 100);
      }
      if (!printing) {
        printing = true;
        firstExtrude = t;
      }
      lastExtrude = t + T;
      extrudeLen += m.dist;
      extrudeTime += T;
      firstLayerZ = Math.min(firstLayerZ, m.end[2]);
    } else {
      flowNow = 0;
      underNow = 0;
    }
    speedNow = m.cruiseV;
    // ---- where the nozzle really goes ----
    const s0: [number, number, number] = [m.start[0] + shift.x, m.start[1] + shift.y, m.start[2] + shift.z];
    const e0: [number, number, number] = [m.end[0] + shift.x, m.end[1] + shift.y, m.end[2] + shift.z];
    pass(T, flowW, (f) => [s0[0] + (e0[0] - s0[0]) * f, s0[1] + (e0[1] - s0[1]) * f, s0[2] + (e0[2] - s0[2]) * f]);
    phy.x = e0[0];
    phy.y = e0[1];
    phy.z = e0[2];
    // the first layer's real gap to the bed
    const mx = (m.start[0] + m.end[0]) / 2;
    const my = (m.start[1] + m.end[1]) / 2;
    const err = gapError(mx + shift.x, my + shift.y);
    if (laid > 0 && m.end[2] <= firstLayerZ + 0.02 && m.end[2] < 0.6) {
      first.max = Math.max(first.max, Math.abs(err));
      first.sum += err * xyd;
      first.len += xyd;
      if (m.end[2] + err < m.end[2] * 0.5) first.low += xyd;
      if (m.end[2] + err > m.end[2] * 1.5) first.high += xyd;
    }
    if (trace.t.length < MAX_TRACE) {
      trace.t.push(t);
      trace.x.push(e0[0]);
      trace.y.push(e0[1]);
      trace.z.push(fw.homedAxes.has("z") ? m.end[2] + err : e0[2]);
      trace.a.push(laid > 0 ? laid / xyd : 0);
    }
  }

  const meltRate = () => {
    const temp = hot?.T ?? ambient;
    const k = (temp - melt.flowMin) / (melt.nominal - melt.flowMin);
    return phys.maxFlow * vf.melt * Math.max(0, Math.min(1.25, k));
  };

  // ---- run ----
  const totalLines = Math.max(1, gcode.split("\n").length);
  let stop = "the print is done";
  let error: string | undefined;
  const fw: PrinterFirmware = new PrinterFirmware(setup, io);
  fw.boot(files.find((f) => f.path.endsWith("config.g"))?.content);
  record(phy.x, phy.y, phy.z);
  nextFrame = frameDt;
  try {
    fw.runFile(gcode, gname);
    finished = !stoppedWhy;
    if (stoppedWhy) stop = `${FLAVOR_NAME[setup.flavor]} stopped: ${stoppedWhy}`;
    else event("goal", "The print is done");
  } catch (e) {
    if (e instanceof TimeUp) stop = "duration";
    else if (e instanceof PrintStop) {
      stop = `${FLAVOR_NAME[setup.flavor]} stopped the print: ${e.message.split("\n")[0]}`;
      if (!events.some((x) => x.text.includes(e.message.split("\n")[0]))) event("warn", stop);
    } else {
      error = e instanceof Error ? e.message : String(e);
      stop = "the simulation failed";
    }
  }
  record(phy.x, phy.y, phy.z);
  opts.onProgress?.(variant, 1);

  const frames: Frames = { t: Float32Array.from(times), series: {} };
  for (const [n, v] of Object.entries(cols)) frames.series[n] = Float32Array.from(v);

  const results: Record<string, number | boolean | string> = {
    time: t,
    stopped: stop,
    finished,
    print_time: printing ? lastExtrude - firstExtrude : 0,
    heat_time: heatWait,
    layer_shifts: shifts,
    max_shift: maxShift,
    under_extrusion: askedVol > 0 ? Math.max(0, 1 - laidVol / askedVol) : 0,
    flow_peak: flowPeak,
    speed_avg: extrudeTime > 0 ? extrudeLen / extrudeTime : 0,
    filament: laidVol / fa,
    filament_g: (laidVol / 1000) * melt.density,
    hotend_error: hotErr,
    hotend_overshoot: Math.max(0, hot?.overshoot ?? 0),
    bed_error: bedErr,
    first_layer_error: first.max,
    first_layer_mean: first.len ? first.sum / first.len : 0,
    first_layer_squashed: first.len ? first.low / first.len : 0,
    first_layer_loose: first.len ? first.high / first.len : 0,
    mesh_range: mesh ? Math.max(...(mesh as Mesh).z.flat()) - Math.min(...(mesh as Mesh).z.flat()) : 0,
    psu_peak: psuPeak,
    energy: energy / 3600,
    firmware_errors: errors,
    unknown_commands: [...fw.stats.unknown.keys()].filter((k) => k !== "no tool").length,
    heater_fault: stoppedWhy ?? "",
    firmware: FLAVOR_NAME[setup.flavor],
    pressure_advance: pa,
  };
  for (const a of axes) results[`${a.axis === "e" ? "extruder" : a.axis}_load`] = loadPeak[a.axis] ?? 0;
  const belted = axes.filter((a) => a.belt);
  if (belted.length) {
    results.ringing = ringPeak;
    results.ringing_hz = Math.min(...belted.map((a) => Math.sqrt((a.belt!.k * 1000) / Math.max(a.mass * vf.mass, 1e-3)) / (2 * Math.PI)));
    results.belt_slack = Number.isFinite(beltSlack) ? beltSlack : Math.min(...belted.map((a) => a.belt!.tension));
  }
  if (phys.psu && psuPeak > phys.psu.watts) event("warn", `The power supply is overloaded: ${psuPeak.toFixed(0)} W from a ${phys.psu.watts} W supply`);
  if (!mesh && setup.probe && first.max > 0.1) notes.push("The print did not probe a bed mesh, so the first layer follows the bed's real shape uncorrected.");
  events.sort((a, b) => a.t - b.t);

  const summary: RunSummary = {
    time: t,
    wallMs: Date.now() - wall0,
    ram: { used: 0, total: 0, static: 0, stack: 0 },
    loopMax: 0,
    isrLoad: 0,
    motors: axes.map((a) => ({ name: a.comp, peakAmps: ampsOf(a.axis), maxTemp: NaN, wh: 0, loadPeak: loadPeak[a.axis] ?? 0, heatGuess: true })),
    eepromWrites: 0,
    state: finished ? "done" : stop,
  };
  const limits = [
    `${FLAVOR_NAME[setup.flavor]} is modelled from its generated config (its planner, heater control, safety checks and G-code commands), not run as compiled firmware: timing is close, not exact.`,
    "Moves are planned as plain trapezoids: no input shaping, S-curves or step timing, and no frame resonance.",
    "Skipped steps use the torque-speed model of calc.stepper_axis: real motors also lose steps to resonance.",
    "The melt rate follows the hotend's rated flow and its temperature; pressure advance is read but corner bulges are not modelled.",
    belted.length
      ? `${belted.map((a) => a.belt!.title).join(" and ")}: each rings from its softest stiffness (belt and motor) and the moving mass, undamped and with no input shaping, so ringing is the worst case; slack uses the share of the pull the belt's checks use.`
      : "Belts are rigid in this model: the design has no lib.belt for X or Y.",
  ];
  assumptions.push(
    `Room at ${ambient.toFixed(0)} °C; ${material} filament.`,
    `The bed is ${vf.bow.toFixed(2)} mm out of flat (a dome) with a ${vf.tilt.toFixed(2)} mm tilt.`,
    setup.probe ? `The probe's Z offset was calibrated (PROBE_CALIBRATE or equivalent) to within ${(vf.cal * 1000).toFixed(0)} µm.` : "Z homes on a switch adjusted with a sheet of paper.",
    `Heater power ${(vf.heat * 100).toFixed(0)} % of rated, heat loss ${(vf.loss * 100).toFixed(0)} % of the design's figure; motor torque ${(vf.torque * 100).toFixed(0)} %, friction ${(vf.friction * 100).toFixed(0)} %.`,
  );
  if (trace.t.length >= MAX_TRACE) notes.push(`The 3D playback keeps the first ${MAX_TRACE} moves.`);
  return {
    variant,
    stop,
    error,
    frames,
    events,
    serial: serial.slice(0, 4000),
    faults: [],
    results,
    summary,
    scene: { kind: "printer", bodies: [], notes: [], floor: 0 },
    assumptions,
    notes,
    limits,
    displays: [],
    print: {
      t: Float32Array.from(trace.t),
      x: Float32Array.from(trace.x),
      y: Float32Array.from(trace.y),
      z: Float32Array.from(trace.z),
      a: Float32Array.from(trace.a),
      nozzle: setup.extruder.nozzle,
      size: [setup.max.x, setup.max.y, setup.max.z],
      layer: layerH,
    },
  };
}
