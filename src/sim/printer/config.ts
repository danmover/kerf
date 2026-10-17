// Reads a printer firmware's generated configuration into one description
// the simulated firmware runs from: motion limits, how it takes corners and
// how far it looks ahead, homing, the probe and bed mesh, heater control and
// its safety checks, extrusion limits and fans. Each firmware is read from
// its own files: Klipper's printer.cfg (sections and macros), Marlin's
// Configuration.h and Configuration_adv.h (#defines), RepRapFirmware's
// config.g (G-code run at start-up) and its homing files. Values a file
// leaves out take that firmware's own defaults.

import type { PrinterFlavor } from "../../machine/firmware/printer";
import { lines, nums, num, parseLine, type GLine } from "./gcode";

export type Axis3 = "x" | "y" | "z";
export type AxisE = Axis3 | "e";
export const AXES3: Axis3[] = ["x", "y", "z"];
export const AXES4: AxisE[] = ["x", "y", "z", "e"];

/** How a firmware limits speed through a corner. */
export type Junction =
  /** Klipper: square_corner_velocity (mm/s), turned into a junction deviation with the acceleration */
  | { kind: "scv"; v: number }
  /** Marlin: junction deviation in mm */
  | { kind: "jd"; mm: number }
  /** Marlin classic jerk and RepRapFirmware: the largest instant speed change per axis, mm/s */
  | { kind: "jerk"; v: Record<AxisE, number> };

export interface HeaterSetup {
  /** the firmware's own name for it: extruder, heater_bed, E0, BED, heater 1 */
  name: string;
  role: "hotend" | "bed";
  control: "pid" | "bangbang" | "model";
  /** PID gains in the firmware's own units (Klipper and Marlin: per 255 of output) */
  kp: number;
  ki: number;
  kd: number;
  /** 0..1 */
  maxPower: number;
  minTemp: number;
  maxTemp: number;
  /** RepRapFirmware's heater model (M307): heating rate °C/s at full power, cooling rate per °C, dead time s */
  model?: { r: number; k: number; kFan: number; d: number };
  /** Klipper: temperature smoothing, s */
  smooth: number;
}

/** Each firmware's own heater safety checks, with its defaults. */
export type HeaterSafety =
  /** Klipper [verify_heater] */
  | { kind: "klipper"; maxError: number; checkGainTime: number; hysteresis: number; heatingGain: number }
  /** Marlin THERMAL_PROTECTION and WATCH_TEMP */
  | { kind: "marlin"; on: boolean; period: number; hysteresis: number; watchPeriod: number; watchIncrease: number }
  /** RepRapFirmware M570: an excursion beyond `excursion` °C for `time` s is a fault */
  | { kind: "rrf"; time: number; excursion: number };

export interface ProbeSetup {
  /** probe position relative to the nozzle, mm */
  x: number;
  y: number;
  /** nozzle height when the probe triggers, as configured (a CALIBRATE value) */
  z: number;
  /** probing speed and travel speed, mm/s */
  speed: number;
  travel: number;
  /** height to lift to between points, mm */
  lift: number;
  samples: number;
  mesh?: { min: [number, number]; max: [number, number]; count: [number, number] };
}

export interface HomingSetup {
  /** -1 homes towards the minimum, +1 towards the maximum */
  dir: -1 | 1;
  /** position at the switch */
  pos: number;
  /** first approach and slow second touch, mm/s */
  speed: number;
  second: number;
  /** back-off before the second touch, mm */
  retract: number;
  /** Z homes with the probe */
  probe: boolean;
}

export interface PrinterSetup {
  flavor: PrinterFlavor;
  kinematics: string;
  min: Record<Axis3, number>;
  max: Record<Axis3, number>;
  /** per-axis speed (mm/s) and acceleration (mm/s²) limits; Infinity where the firmware has none */
  maxV: Record<AxisE, number>;
  maxA: Record<AxisE, number>;
  /** overall limits: Klipper max_velocity and max_accel; Marlin and RRF have none (Infinity) */
  velocity: number;
  accel: number;
  /** accelerations by kind of move (Marlin M204 P/R/T, RepRapFirmware M204 P/T), mm/s² */
  printAccel: number;
  travelAccel: number;
  retractAccel: number;
  junction: Junction;
  /** Klipper: share of a short move kept at cruise speed (minimum_cruise_ratio) */
  minCruiseRatio: number;
  /** moves the planner looks ahead */
  buffer: number;
  /** pressure advance, s */
  pa: number;
  /** Marlin: LIN_ADVANCE is built in, so M900 works */
  linAdvance: boolean;
  /** driver RMS current, A */
  currents: Partial<Record<AxisE, number>>;
  /** motor turns per mm of axis (or filament) movement are derived from these */
  stepsPerMm: Record<AxisE, number>;
  homing: Record<Axis3, HomingSetup>;
  /** where Z homes on the probe (nozzle position), mm; and the hop before homing */
  safeHome?: { x: number; y: number; hop: number; speed: number };
  probe?: ProbeSetup;
  hotend?: HeaterSetup;
  bed?: HeaterSetup;
  safety: { hotend: HeaterSafety; bed: HeaterSafety };
  /** how a heating wait ends: within `window` °C for `residency` s */
  wait: { window: number; residency: number };
  extruder: {
    nozzle: number;
    filament: number;
    /** refuses to extrude below this temperature, °C */
    minTemp: number;
    /** Klipper: largest extrusion cross-section a move may ask for, mm² */
    maxCross: number;
    /** longest extrude-only move, mm */
    maxOnly: number;
    /** Klipper's instantaneous_corner_velocity for the extruder, mm/s */
    cornerV: number;
  };
  fans: { hotendAt?: number; part: boolean; controller: boolean };
  /** Klipper gcode_macro bodies by upper-case name */
  macros: Map<string, string>;
  /** RepRapFirmware system files by name (homeall.g, deployprobe.g) */
  sysFiles: Map<string, string>;
  /** what Kerf assumed while reading the files */
  notes: string[];
  /** problems the firmware would refuse to start with */
  errors: string[];
}

const ALL = <T>(v: T): Record<AxisE, T> => ({ x: v, y: v, z: v, e: v });

function base(flavor: PrinterFlavor): PrinterSetup {
  return {
    flavor,
    kinematics: "cartesian",
    min: { x: 0, y: 0, z: 0 },
    max: { x: 220, y: 220, z: 250 },
    maxV: ALL(Infinity),
    maxA: ALL(Infinity),
    velocity: Infinity,
    accel: Infinity,
    printAccel: Infinity,
    travelAccel: Infinity,
    retractAccel: Infinity,
    junction: { kind: "jd", mm: 0.013 },
    minCruiseRatio: 0,
    buffer: 16,
    pa: 0,
    linAdvance: false,
    currents: {},
    stepsPerMm: { x: 80, y: 80, z: 400, e: 415 },
    homing: {
      x: { dir: -1, pos: 0, speed: 50, second: 25, retract: 5, probe: false },
      y: { dir: -1, pos: 0, speed: 50, second: 25, retract: 5, probe: false },
      z: { dir: -1, pos: 0, speed: 5, second: 2.5, retract: 2, probe: false },
    },
    safety: { hotend: { kind: "klipper", maxError: 120, checkGainTime: 20, hysteresis: 5, heatingGain: 2 }, bed: { kind: "klipper", maxError: 120, checkGainTime: 60, hysteresis: 5, heatingGain: 2 } },
    wait: { window: 1, residency: 0 },
    extruder: { nozzle: 0.4, filament: 1.75, minTemp: 170, maxCross: Infinity, maxOnly: Infinity, cornerV: Infinity },
    fans: { part: false, controller: false },
    macros: new Map(),
    sysFiles: new Map(),
    notes: [],
    errors: [],
  };
}

/** Read the files a firmware generator wrote (paths as generated) into a setup. */
export function readSetup(flavor: PrinterFlavor, files: { path: string; content: string }[]): PrinterSetup {
  const byName = new Map(files.map((f) => [f.path.split("/").pop()!, f.content]));
  if (flavor === "klipper") return readKlipper(byName.get("printer.cfg") ?? "");
  if (flavor === "marlin") return readMarlin(`${byName.get("Configuration.h") ?? ""}\n${byName.get("Configuration_adv.h") ?? ""}`);
  return readRrf(byName);
}

// ---------------- Klipper ----------------

interface Section {
  name: string;
  values: Map<string, string>;
}

/** printer.cfg as sections; multi-line values (gcode:) keep their indented lines. */
export function klipperSections(cfg: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  let key = "";
  for (const raw of lines(cfg)) {
    if (/^\s*[#;]/.test(raw) && !/^\s/.test(raw)) continue;
    const head = /^\[([^\]]+)\]/.exec(raw);
    if (head) {
      cur = { name: head[1].trim(), values: new Map() };
      out.push(cur);
      key = "";
      continue;
    }
    if (!cur) continue;
    const kv = /^([A-Za-z0-9_]+)\s*[:=]\s?(.*)$/.exec(raw);
    if (kv) {
      key = kv[1].toLowerCase();
      cur.values.set(key, stripComment(kv[2]));
      continue;
    }
    // an indented continuation line (a macro's G-code)
    if (key && /^\s+\S/.test(raw)) cur.values.set(key, `${cur.values.get(key) ?? ""}\n${raw.replace(/^\s{4}|^\t/, "")}`);
  }
  return out;
}

const stripComment = (v: string) => v.replace(/\s+[#;].*$/, "").trim();

function readKlipper(cfg: string): PrinterSetup {
  const s = base("klipper");
  s.buffer = Infinity;
  const secs = klipperSections(cfg);
  const sec = (n: string) => secs.find((x) => x.name === n)?.values;
  const f = (m: Map<string, string> | undefined, k: string, d: number) => {
    const v = m?.get(k);
    const n = v === undefined ? NaN : Number(v.split("\n")[0]);
    return Number.isFinite(n) ? n : d;
  };
  const printer = sec("printer");
  if (!printer) s.errors.push("printer.cfg has no [printer] section: Klipper will not start.");
  s.kinematics = (printer?.get("kinematics") ?? "cartesian").trim();
  s.velocity = f(printer, "max_velocity", NaN);
  s.accel = f(printer, "max_accel", NaN);
  if (!Number.isFinite(s.velocity) || !Number.isFinite(s.accel)) {
    s.errors.push("[printer] needs max_velocity and max_accel: Klipper will not start.");
    s.velocity = Number.isFinite(s.velocity) ? s.velocity : 300;
    s.accel = Number.isFinite(s.accel) ? s.accel : 3000;
  }
  s.printAccel = s.travelAccel = s.retractAccel = s.accel;
  s.maxV.z = f(printer, "max_z_velocity", s.velocity);
  s.maxA.z = f(printer, "max_z_accel", s.accel);
  s.junction = { kind: "scv", v: f(printer, "square_corner_velocity", 5) };
  // minimum_cruise_ratio (newer Klipper) or max_accel_to_decel (older)
  const atd = printer?.get("max_accel_to_decel");
  s.minCruiseRatio = atd !== undefined ? Math.max(0, 1 - Number(atd) / s.accel) : f(printer, "minimum_cruise_ratio", 0.5);
  for (const ax of ["x", "y", "z"] as const) {
    const st = sec(`stepper_${ax}`);
    if (!st) {
      s.errors.push(`printer.cfg has no [stepper_${ax}] section: Klipper will not start.`);
      continue;
    }
    const rd = f(st, "rotation_distance", NaN);
    const micro = f(st, "microsteps", 16);
    const full = f(st, "full_steps_per_rotation", 200);
    if (!(rd > 0)) s.errors.push(`[stepper_${ax}] needs a rotation_distance.`);
    else s.stepsPerMm[ax] = (full * micro) / rd;
    s.min[ax] = f(st, "position_min", 0);
    s.max[ax] = f(st, "position_max", NaN);
    if (!Number.isFinite(s.max[ax])) s.errors.push(`[stepper_${ax}] needs position_max.`);
    const endstop = (st.get("endstop_pin") ?? "").replace(/\s/g, "");
    const probe = /^probe:z_virtual_endstop$/i.test(endstop);
    const pe = f(st, "position_endstop", probe ? s.min[ax] : NaN);
    if (!probe && !Number.isFinite(pe)) s.errors.push(`[stepper_${ax}] needs position_endstop.`);
    const pos = Number.isFinite(pe) ? pe : 0;
    const speed = f(st, "homing_speed", 5);
    s.homing[ax] = {
      // Klipper homes towards whichever end position_endstop is nearer
      dir: f(st, "homing_positive_dir", NaN) === 1 || st.get("homing_positive_dir") === "true" || (!probe && pos > (s.min[ax] + s.max[ax]) / 2) ? 1 : -1,
      pos,
      speed,
      second: f(st, "second_homing_speed", speed / 2),
      retract: f(st, "homing_retract_dist", 5),
      probe,
    };
    const tmc = sec(`tmc2209 stepper_${ax}`) ?? sec(`tmc2208 stepper_${ax}`) ?? sec(`tmc5160 stepper_${ax}`) ?? sec(`tmc2130 stepper_${ax}`);
    if (tmc) s.currents[ax] = f(tmc, "run_current", NaN);
  }
  const ex = sec("extruder");
  if (!ex) s.errors.push("printer.cfg has no [extruder] section: the printer cannot extrude.");
  else {
    const rd = f(ex, "rotation_distance", 22.68);
    const gear = (ex.get("gear_ratio") ?? "").split(",").reduce((acc, p) => {
      const [a, b] = p.split(":").map((x) => Number(x.trim()));
      return a > 0 && b > 0 ? acc * (a / b) : acc;
    }, 1);
    s.stepsPerMm.e = (f(ex, "full_steps_per_rotation", 200) * f(ex, "microsteps", 16) * gear) / rd;
    s.extruder.nozzle = f(ex, "nozzle_diameter", 0.4);
    s.extruder.filament = f(ex, "filament_diameter", 1.75);
    s.extruder.minTemp = f(ex, "min_extrude_temp", 170);
    s.extruder.maxCross = f(ex, "max_extrude_cross_section", 4 * s.extruder.nozzle * s.extruder.nozzle);
    s.extruder.maxOnly = f(ex, "max_extrude_only_distance", 50);
    s.extruder.cornerV = f(ex, "instantaneous_corner_velocity", 1);
    // Klipper's extrude-only limits default to the toolhead's, scaled by the largest extrusion ratio
    const ratio = (4 * s.extruder.nozzle * s.extruder.nozzle) / ((Math.PI / 4) * s.extruder.filament ** 2);
    s.maxV.e = f(ex, "max_extrude_only_velocity", s.velocity * ratio);
    s.maxA.e = f(ex, "max_extrude_only_accel", s.accel * ratio);
    s.pa = f(ex, "pressure_advance", 0);
    s.hotend = klipperHeater("extruder", "hotend", ex, f);
    const tmc = sec("tmc2209 extruder") ?? sec("tmc2208 extruder");
    if (tmc) s.currents.e = f(tmc, "run_current", NaN);
  }
  const bed = sec("heater_bed");
  if (bed) s.bed = klipperHeater("heater_bed", "bed", bed, f);
  const vh = (n: string, gain: number) => {
    const v = sec(`verify_heater ${n}`);
    return { kind: "klipper" as const, maxError: f(v, "max_error", 120), checkGainTime: f(v, "check_gain_time", gain), hysteresis: f(v, "hysteresis", 5), heatingGain: f(v, "heating_gain", 2) };
  };
  s.safety = { hotend: vh("extruder", 20), bed: vh("heater_bed", 60) };
  s.wait = { window: 1, residency: 0 };
  const bl = sec("bltouch") ?? sec("probe");
  if (bl) {
    s.probe = {
      x: f(bl, "x_offset", 0),
      y: f(bl, "y_offset", 0),
      z: f(bl, "z_offset", 0),
      speed: f(bl, "speed", 5),
      lift: f(bl, "sample_retract_dist", 2),
      travel: f(bl, "lift_speed", 5),
      samples: f(bl, "samples", 1),
    };
    const mesh = sec("bed_mesh");
    if (mesh) {
      const pair = (k: string, d: [number, number]): [number, number] => {
        const v = (mesh.get(k) ?? "").split(",").map((x) => Number(x.trim()));
        return v.length >= 2 && v.every(Number.isFinite) ? [v[0], v[1]] : v.length === 1 && Number.isFinite(v[0]) ? [v[0], v[0]] : d;
      };
      s.probe.mesh = { min: pair("mesh_min", [10, 10]), max: pair("mesh_max", [s.max.x - 10, s.max.y - 10]), count: pair("probe_count", [3, 3]) };
      s.probe.travel = f(mesh, "speed", 50);
      s.probe.lift = f(mesh, "horizontal_move_z", 5);
    }
  }
  if (s.homing.z.probe && !s.probe) s.errors.push("[stepper_z] homes on probe:z_virtual_endstop but there is no [bltouch] or [probe] section: Klipper will not start.");
  const sz = sec("safe_z_home");
  if (sz) {
    const xy = (sz.get("home_xy_position") ?? "").split(",").map((x) => Number(x.trim()));
    s.safeHome = { x: xy[0] ?? s.max.x / 2, y: xy[1] ?? s.max.y / 2, hop: f(sz, "z_hop", 0), speed: f(sz, "speed", 50) };
  }
  for (const x of secs) {
    if (x.name === "fan") s.fans.part = true;
    if (x.name.startsWith("heater_fan")) s.fans.hotendAt = f(x.values, "heater_temp", 50);
    if (x.name.startsWith("controller_fan")) s.fans.controller = true;
    const mac = /^gcode_macro\s+(\S+)$/i.exec(x.name);
    if (mac) s.macros.set(mac[1].toUpperCase(), (x.values.get("gcode") ?? "").replace(/^\n/, ""));
  }
  if (!["cartesian", "corexy"].includes(s.kinematics)) s.notes.push(`Kerf simulates ${s.kinematics} kinematics as cartesian.`);
  return s;
}

function klipperHeater(name: string, role: "hotend" | "bed", m: Map<string, string>, f: (m: Map<string, string> | undefined, k: string, d: number) => number): HeaterSetup {
  const control = (m.get("control") ?? "pid").trim() === "watermark" ? "bangbang" : "pid";
  return {
    name,
    role,
    control,
    kp: f(m, "pid_kp", 20),
    ki: f(m, "pid_ki", 1),
    kd: f(m, "pid_kd", 100),
    maxPower: f(m, "max_power", 1),
    minTemp: f(m, "min_temp", 0),
    maxTemp: f(m, "max_temp", role === "hotend" ? 250 : 110),
    smooth: f(m, "smooth_time", 1),
  };
}

// ---------------- Marlin ----------------

/** #define NAME value lines, with values written in terms of other defines worked out. */
export function marlinDefines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let skip = 0;
  for (const raw of lines(text.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    // a block left out with #if 0 … #endif
    if (/^#if\s+0\b/.test(line)) skip++;
    else if (skip && /^#if/.test(line)) skip++;
    else if (skip && /^#endif/.test(line)) skip--;
    if (skip) continue;
    const m = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/.exec(line);
    if (m) out.set(m[1], (m[2] ?? "").trim());
    const u = /^#undef\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (u) out.delete(u[1]);
  }
  return out;
}

/** A number from a define's value: arithmetic and other defines allowed ((50*60), X_BED_SIZE). */
function marlinNum(defs: Map<string, string>, expr: string, depth = 0): number {
  const src = expr.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (name) => {
    if (depth > 8) return "NaN";
    const v = defs.get(name);
    if (v === undefined) return "NaN";
    return `(${marlinNum(defs, v, depth + 1)})`;
  });
  return arith(src.replace(/(\d)f\b/g, "$1"));
}

/** + - * / and brackets over numbers; NaN for anything else. */
function arith(s: string): number {
  let i = 0;
  const t = s.replace(/\s+/g, "");
  const peek = () => t[i];
  const parseNum = (): number => {
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") return NaN;
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -parseNum();
    }
    if (peek() === "+") {
      i++;
      return parseNum();
    }
    const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|^NaN/.exec(t.slice(i));
    if (!m) return NaN;
    i += m[0].length;
    return Number(m[0]);
  };
  const term = (): number => {
    let v = parseNum();
    while (peek() === "*" || peek() === "/") {
      const op = t[i++];
      const r = parseNum();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = t[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = expr();
  return i === t.length ? v : NaN;
}

/** { 80, 80, 400, 415 } → numbers. */
function marlinList(defs: Map<string, string>, name: string): number[] | undefined {
  const v = defs.get(name);
  if (v === undefined) return undefined;
  const inner = /^\{(.*)\}$/.exec(v.trim());
  if (!inner) return undefined;
  return inner[1].split(",").map((x) => marlinNum(defs, x.trim()));
}

function readMarlin(text: string): PrinterSetup {
  const s = base("marlin");
  const d = marlinDefines(text);
  const has = (n: string) => d.has(n);
  const n = (k: string, def: number) => {
    const v = d.get(k);
    if (v === undefined) return def;
    const x = marlinNum(d, v);
    return Number.isFinite(x) ? x : def;
  };
  if (!has("MOTHERBOARD")) s.errors.push("Configuration.h has no MOTHERBOARD: Marlin will not build.");
  const list4 = (k: string, def: number[]) => {
    const v = marlinList(d, k);
    if (!v) {
      s.errors.push(`Configuration.h has no ${k}: Marlin will not build.`);
      return def;
    }
    // the last value is used for any extruders not given
    return [0, 1, 2, 3].map((i) => (Number.isFinite(v[i]) ? v[i] : v[v.length - 1]));
  };
  const steps = list4("DEFAULT_AXIS_STEPS_PER_UNIT", [80, 80, 400, 93]);
  const feed = list4("DEFAULT_MAX_FEEDRATE", [300, 300, 5, 25]);
  const acc = list4("DEFAULT_MAX_ACCELERATION", [3000, 3000, 100, 10000]);
  AXES4.forEach((ax, i) => {
    s.stepsPerMm[ax] = steps[i];
    s.maxV[ax] = feed[i];
    s.maxA[ax] = acc[i];
  });
  s.printAccel = n("DEFAULT_ACCELERATION", 3000);
  s.retractAccel = n("DEFAULT_RETRACT_ACCELERATION", 3000);
  s.travelAccel = n("DEFAULT_TRAVEL_ACCELERATION", s.printAccel);
  if (has("CLASSIC_JERK")) s.junction = { kind: "jerk", v: { x: n("DEFAULT_XJERK", 10), y: n("DEFAULT_YJERK", 10), z: n("DEFAULT_ZJERK", 0.3), e: n("DEFAULT_EJERK", 5) } };
  else s.junction = { kind: "jd", mm: n("JUNCTION_DEVIATION_MM", 0.013) };
  s.buffer = n("BLOCK_BUFFER_SIZE", 16);
  s.linAdvance = has("LIN_ADVANCE");
  s.pa = s.linAdvance ? n("ADVANCE_K", 0) : 0;
  s.min = { x: n("X_MIN_POS", 0), y: n("Y_MIN_POS", 0), z: n("Z_MIN_POS", 0) };
  s.max = { x: n("X_MAX_POS", n("X_BED_SIZE", 220)), y: n("Y_MAX_POS", n("Y_BED_SIZE", 220)), z: n("Z_MAX_POS", 250) };
  const homeFeed = marlinList(d, "HOMING_FEEDRATE_MM_M") ?? [50 * 60, 50 * 60, 4 * 60];
  const bump = marlinList(d, "HOMING_BUMP_MM") ?? [5, 5, 2];
  const div = marlinList(d, "HOMING_BUMP_DIVISOR") ?? [2, 2, 4];
  const probeHome = has("USE_PROBE_FOR_Z_HOMING") || (has("BLTOUCH") && (has("Z_MIN_PROBE_USES_Z_MIN_ENDSTOP_PIN") || has("Z_SAFE_HOMING")));
  AXES3.forEach((ax, i) => {
    const dir = n(`${ax.toUpperCase()}_HOME_DIR`, -1) > 0 ? 1 : -1;
    const speed = homeFeed[i] / 60;
    s.homing[ax] = { dir, pos: dir > 0 ? s.max[ax] : s.min[ax], speed, second: speed / (div[i] || 2), retract: bump[i], probe: ax === "z" && probeHome };
  });
  for (const ax of ["X", "Y", "Z", "E0"]) {
    const ma = n(`${ax}_CURRENT`, NaN);
    if (Number.isFinite(ma)) s.currents[(ax === "E0" ? "e" : ax.toLowerCase()) as AxisE] = ma / 1000;
  }
  if (has("BLTOUCH") || has("FIX_MOUNTED_PROBE") || has("Z_PROBE_SERVO_NR")) {
    const off = marlinList(d, "NOZZLE_TO_PROBE_OFFSET") ?? [0, 0, 0];
    const fast = n("Z_PROBE_FEEDRATE_FAST", 4 * 60) / 60;
    s.probe = {
      x: off[0] ?? 0,
      y: off[1] ?? 0,
      // Marlin's offset is the probe's trigger point below the nozzle (negative); Kerf keeps the nozzle height at the trigger
      z: -(off[2] ?? 0),
      speed: n("Z_PROBE_FEEDRATE_SLOW", fast * 60 / 2) / 60,
      travel: n("XY_PROBE_FEEDRATE", 133 * 60) / 60,
      lift: n("Z_CLEARANCE_BETWEEN_PROBES", 5),
      samples: n("MULTIPLE_PROBING", 1),
    };
    if (has("AUTO_BED_LEVELING_BILINEAR") || has("AUTO_BED_LEVELING_UBL") || has("AUTO_BED_LEVELING_LINEAR")) {
      const margin = n("PROBING_MARGIN", 10);
      const lo = (ax: "x" | "y", off: number) => Math.max(s.min[ax] + margin, s.min[ax] + margin + off);
      const hi = (ax: "x" | "y", off: number) => Math.min(s.max[ax] - margin, s.max[ax] - margin + off);
      s.probe.mesh = { min: [lo("x", s.probe.x), lo("y", s.probe.y)], max: [hi("x", s.probe.x), hi("y", s.probe.y)], count: [n("GRID_MAX_POINTS_X", 3), n("GRID_MAX_POINTS_Y", n("GRID_MAX_POINTS_X", 3))] };
    }
  }
  if (has("Z_SAFE_HOMING")) {
    // Marlin puts the probe (not the nozzle) on the safe homing point when Z homes with the probe
    const px = probeHome && s.probe ? s.probe.x : 0;
    const py = probeHome && s.probe ? s.probe.y : 0;
    s.safeHome = { x: n("Z_SAFE_HOMING_X_POINT", (s.min.x + s.max.x) / 2) - px, y: n("Z_SAFE_HOMING_Y_POINT", (s.min.y + s.max.y) / 2) - py, hop: n("Z_CLEARANCE_FOR_HOMING", n("Z_HOMING_HEIGHT", 4)), speed: s.homing.x.speed };
  }
  const pid = (role: "hotend" | "bed"): HeaterSetup | undefined => {
    const hot = role === "hotend";
    const sensor = n(hot ? "TEMP_SENSOR_0" : "TEMP_SENSOR_BED", hot ? 1 : 0);
    if (!sensor) return undefined;
    const usesPid = has(hot ? "PIDTEMP" : "PIDTEMPBED");
    // Marlin 2.1.2.6 renamed DEFAULT_Kp and DEFAULT_bedKp to DEFAULT_KP and DEFAULT_BED_KP; read either
    const gain = (k: "P" | "I" | "D") => [hot ? `DEFAULT_K${k}` : `DEFAULT_BED_K${k}`, hot ? `DEFAULT_K${k.toLowerCase()}` : `DEFAULT_bedK${k.toLowerCase()}`].find(has);
    const missing = (["P", "I", "D"] as const).filter((k) => !gain(k)).map((k) => (hot ? `DEFAULT_K${k}` : `DEFAULT_BED_K${k}`));
    if (usesPid && missing.length) s.errors.push(`${hot ? "PIDTEMP" : "PIDTEMPBED"} is on but Configuration.h has no ${missing.join(", ")}: Marlin will not build.`);
    return {
      name: hot ? "E0" : "BED",
      role,
      control: usesPid ? "pid" : "bangbang",
      kp: n(gain("P") ?? "", hot ? 22.2 : 10),
      ki: n(gain("I") ?? "", hot ? 1.08 : 0.023),
      kd: n(gain("D") ?? "", hot ? 114 : 305),
      maxPower: (hot ? n("PID_MAX", 255) : n("MAX_BED_POWER", 255)) / 255,
      minTemp: n(hot ? "HEATER_0_MINTEMP" : "BED_MINTEMP", 5),
      maxTemp: n(hot ? "HEATER_0_MAXTEMP" : "BED_MAXTEMP", hot ? 275 : 150),
      smooth: 0,
    };
  };
  s.hotend = pid("hotend");
  s.bed = pid("bed");
  if (!s.hotend) s.errors.push("TEMP_SENSOR_0 is 0: Marlin has no hotend temperature and will not heat it.");
  s.safety = {
    hotend: { kind: "marlin", on: has("THERMAL_PROTECTION_HOTENDS"), period: n("THERMAL_PROTECTION_PERIOD", 40), hysteresis: n("THERMAL_PROTECTION_HYSTERESIS", 4), watchPeriod: n("WATCH_TEMP_PERIOD", 40), watchIncrease: n("WATCH_TEMP_INCREASE", 2) },
    bed: { kind: "marlin", on: has("THERMAL_PROTECTION_BED"), period: n("THERMAL_PROTECTION_BED_PERIOD", 20), hysteresis: n("THERMAL_PROTECTION_BED_HYSTERESIS", 2), watchPeriod: n("WATCH_BED_TEMP_PERIOD", 60), watchIncrease: n("WATCH_BED_TEMP_INCREASE", 2) },
  };
  if (!has("THERMAL_PROTECTION_HOTENDS")) s.notes.push("THERMAL_PROTECTION_HOTENDS is off: Marlin will not stop a hotend that heats out of control.");
  s.wait = { window: n("TEMP_WINDOW", 1), residency: n("TEMP_RESIDENCY_TIME", 10) };
  s.extruder.nozzle = n("NOZZLE_DIAMETER", 0.4);
  s.extruder.filament = n("DEFAULT_NOMINAL_FILAMENT_DIA", 1.75);
  s.extruder.minTemp = has("PREVENT_COLD_EXTRUSION") ? n("EXTRUDE_MINTEMP", 170) : -Infinity;
  s.extruder.maxOnly = has("PREVENT_LENGTHY_EXTRUDE") ? n("EXTRUDE_MAXLENGTH", 200) : Infinity;
  s.fans.hotendAt = d.has("E0_AUTO_FAN_PIN") && d.get("E0_AUTO_FAN_PIN") !== "-1" ? n("EXTRUDER_AUTO_FAN_TEMPERATURE", 50) : undefined;
  s.fans.part = true;
  s.fans.controller = has("USE_CONTROLLER_FAN");
  if (has("S_CURVE_ACCELERATION")) s.notes.push("S_CURVE_ACCELERATION is on: Kerf plans its moves with plain trapezoids, which takes a little less time.");
  return s;
}

// ---------------- RepRapFirmware ----------------

function readRrf(files: Map<string, string>): PrinterSetup {
  const s = base("reprapfirmware");
  s.buffer = 40;
  s.junction = { kind: "jerk", v: { x: 15, y: 15, z: 0.25, e: 2 } };
  s.wait = { window: 1, residency: 0 };
  // RRF's defaults when config.g says nothing: 250 mm/s², 100 mm/s
  s.maxA = { x: 250, y: 250, z: 100, e: 250 };
  s.maxV = { x: 100, y: 100, z: 3, e: 50 };
  s.printAccel = s.travelAccel = s.retractAccel = 10000;
  s.extruder.minTemp = 160;
  s.extruder.maxOnly = Infinity;
  s.safety = { hotend: { kind: "rrf", time: 5, excursion: 15 }, bed: { kind: "rrf", time: 5, excursion: 15 } };
  s.homing.z = { ...s.homing.z, probe: false };
  for (const [name, text] of files) if (name !== "config.g") s.sysFiles.set(name, text);
  const cfg = files.get("config.g");
  if (cfg === undefined) {
    s.errors.push("There is no sys/config.g: RepRapFirmware starts with nothing configured.");
    return s;
  }
  const sensors = new Map<number, string>();
  const heaters = new Map<number, { sensor: number; pin: string }>();
  let bedHeater = -1;
  let toolHeater = -1;
  let probeType = 0;
  const models = new Map<number, HeaterSetup["model"]>();
  const maxT = new Map<number, number>();
  const axisVal = (l: GLine, f: (ax: AxisE, v: number[]) => void) => {
    for (const [k, ax] of [["X", "x"], ["Y", "y"], ["Z", "z"], ["E", "e"]] as const) {
      const v = nums(l.params[k]);
      if (v.length) f(ax, v);
    }
  };
  for (const raw of lines(cfg)) {
    const l = parseLine(raw);
    switch (l.cmd) {
      case "M92":
        axisVal(l, (ax, v) => (s.stepsPerMm[ax] = v[0]));
        break;
      case "M566":
        if (s.junction.kind === "jerk") axisVal(l, (ax, v) => ((s.junction as { v: Record<AxisE, number> }).v[ax] = v[0] / 60));
        break;
      case "M203":
        axisVal(l, (ax, v) => (s.maxV[ax] = v[0] / 60));
        break;
      case "M201":
        axisVal(l, (ax, v) => (s.maxA[ax] = v[0]));
        break;
      case "M204": {
        const p = num(l, "P");
        const t = num(l, "T");
        if (p !== undefined) s.printAccel = s.retractAccel = p;
        if (t !== undefined) s.travelAccel = t;
        break;
      }
      case "M906":
        axisVal(l, (ax, v) => (s.currents[ax] = v[0] / 1000));
        break;
      case "M208": {
        const lowSide = num(l, "S") === 1;
        for (const ax of AXES3) {
          const v = nums(l.params[ax.toUpperCase()]);
          if (v.length === 2) {
            s.min[ax] = v[0];
            s.max[ax] = v[1];
          } else if (v.length === 1) {
            if (lowSide) s.min[ax] = v[0];
            else s.max[ax] = v[0];
          }
        }
        break;
      }
      case "M574":
        for (const ax of AXES3) {
          const v = num(l, ax.toUpperCase());
          if (v === undefined) continue;
          if (v === 1 || v === 2) s.homing[ax] = { ...s.homing[ax], dir: v === 1 ? -1 : 1 };
          // S2 is the Z probe used as an endstop
          if (ax === "z" && num(l, "S") === 2) s.homing.z.probe = true;
        }
        break;
      case "M558": {
        probeType = num(l, "P") ?? 0;
        if (probeType) {
          s.probe = {
            ...(s.probe ?? { x: 0, y: 0, z: 0, samples: 1 }),
            lift: num(l, "H") ?? 5,
            speed: (nums(l.params.F)[0] ?? 120) / 60,
            travel: (num(l, "T") ?? 6000) / 60,
            samples: num(l, "A") ?? 1,
          };
        }
        break;
      }
      case "G31":
        if (s.probe) {
          s.probe.x = num(l, "X") ?? s.probe.x;
          s.probe.y = num(l, "Y") ?? s.probe.y;
          s.probe.z = num(l, "Z") ?? s.probe.z;
        } else s.probe = { x: num(l, "X") ?? 0, y: num(l, "Y") ?? 0, z: num(l, "Z") ?? 0, speed: 2, travel: 100, lift: 5, samples: 1 };
        break;
      case "M557": {
        const xs = nums(l.params.X);
        const ys = nums(l.params.Y);
        const p = nums(l.params.P);
        const sp = nums(l.params.S);
        if (xs.length === 2 && ys.length === 2 && s.probe) {
          const cnt = (i: number, lo: number, hi: number) => (p.length ? p[Math.min(i, p.length - 1)] : sp.length ? Math.floor((hi - lo) / sp[Math.min(i, sp.length - 1)]) + 1 : 5);
          s.probe.mesh = { min: [xs[0], ys[0]], max: [xs[1], ys[1]], count: [cnt(0, xs[0], xs[1]), cnt(1, ys[0], ys[1])] };
        }
        break;
      }
      case "M308": {
        const sn = num(l, "S");
        if (sn !== undefined) sensors.set(sn, l.params.Y ?? "thermistor");
        break;
      }
      case "M950": {
        const h = num(l, "H");
        if (h !== undefined) heaters.set(h, { sensor: num(l, "T") ?? h, pin: l.params.C ?? "" });
        break;
      }
      case "M140":
        bedHeater = num(l, "H") ?? bedHeater;
        break;
      case "M563":
        toolHeater = nums(l.params.H)[0] ?? toolHeater;
        break;
      case "M307": {
        const h = num(l, "H");
        const r = num(l, "R");
        const k = nums(l.params.K);
        const dd = num(l, "D");
        if (h !== undefined && r !== undefined && k.length && dd !== undefined) models.set(h, { r, k: k[0], kFan: k[1] ?? 0, d: dd });
        break;
      }
      case "M143": {
        const h = num(l, "H") ?? 1;
        const t = num(l, "S");
        if (t !== undefined) maxT.set(h, t);
        break;
      }
      case "M570": {
        const t = num(l, "P");
        const ex = num(l, "T");
        const h = num(l, "H");
        const apply = (k: "hotend" | "bed") => {
          const cur = s.safety[k] as Extract<HeaterSafety, { kind: "rrf" }>;
          s.safety[k] = { kind: "rrf", time: t ?? cur.time, excursion: ex ?? cur.excursion };
        };
        if (h === undefined || h === toolHeater) apply("hotend");
        if (h === undefined || h === bedHeater) apply("bed");
        break;
      }
      case "M572":
        s.pa = nums(l.params.S)[0] ?? s.pa;
        break;
      case "M302":
        s.extruder.minTemp = num(l, "S") ?? s.extruder.minTemp;
        break;
      case "M106":
        if ((num(l, "H") ?? -1) >= 0) s.fans.hotendAt = num(l, "T") ?? 45;
        else s.fans.part = true;
        break;
      case "M404":
        s.extruder.nozzle = num(l, "D") ?? s.extruder.nozzle;
        break;
      case "M200":
        s.extruder.filament = num(l, "D") ?? s.extruder.filament;
        break;
      case "M669":
        s.kinematics = num(l, "K") === 1 ? "corexy" : "cartesian";
        break;
      default:
    }
  }
  if (toolHeater < 0) s.errors.push("config.g defines no tool with a heater (M563 ... H1): RepRapFirmware cannot heat the hotend or extrude.");
  const heaterOf = (h: number, role: "hotend" | "bed"): HeaterSetup | undefined => {
    if (h < 0 || !heaters.has(h)) return undefined;
    const model = models.get(h);
    return {
      name: `heater ${h}`,
      role,
      control: "model",
      kp: 0,
      ki: 0,
      kd: 0,
      maxPower: 1,
      minTemp: -10,
      maxTemp: maxT.get(h) ?? (role === "hotend" ? 290 : 120),
      model,
      smooth: 0,
    };
  };
  s.hotend = heaterOf(toolHeater, "hotend");
  s.bed = heaterOf(bedHeater, "bed");
  if (toolHeater >= 0 && !heaters.has(toolHeater)) s.errors.push(`The tool uses heater ${toolHeater}, but config.g creates no such heater (M950 H${toolHeater}).`);
  if (s.homing.z.probe && !probeType) s.errors.push("Z homes on the probe (M574 Z1 S2) but config.g sets up no probe (M558).");
  if (s.probe && probeType) s.homing.z.probe = s.homing.z.probe || /G30/.test(files.get("homez.g") ?? files.get("homeall.g") ?? "");
  for (const ax of AXES3) s.homing[ax].pos = s.homing[ax].dir > 0 ? s.max[ax] : s.min[ax];
  return s;
}
