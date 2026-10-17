// The G-code interpreter of each printer firmware, run from its config: what
// each command does, which commands it knows, how it homes, probes and levels,
// and what it refuses (moves before homing, cold extrusion, moves past the
// limits). Klipper runs its gcode_macro templates, RepRapFirmware its system
// files (homeall.g and friends). Time passes in the machine the firmware
// drives (run.ts), through the PrinterIO calls.

import { FLAVOR_NAME, type PrinterFlavor } from "../../machine/firmware/printer";
import { AXES3, type Axis3, type AxisE, type PrinterSetup } from "./config";
import { lines, num, nums, parseLine, type GLine } from "./gcode";
import type { HeaterSim } from "./heaters";
import { MacroError, renderMacro, type JVal } from "./macros";
import { KlipperPlanner, limitsOf, makeMove, WindowPlanner, type Limits, type MoveTag, type PlanMove, type Planner } from "./planner";

export interface Mesh {
  min: [number, number];
  max: [number, number];
  count: [number, number];
  /** heights by row (y) then column (x), mm */
  z: number[][];
}

export interface PrinterIO {
  now(): number;
  /** run a planned move */
  run(m: PlanMove): void;
  /** let time pass with the toolhead still until `done()` or `max` seconds; false when it timed out or the printer stopped */
  waitUntil(done: () => boolean, max: number): boolean;
  heater(role: "hotend" | "bed"): HeaterSim | undefined;
  /** part-cooling fan, 0..1 */
  fan(v: number): void;
  /** where the carriage really is, in firmware coordinates as they were last homed (the firmware does not know this) */
  actual(ax: Axis3): number;
  /** the axis reached its switch: firmware and carriage agree from here */
  homed(ax: Axis3, pos: number): void;
  /** how far the nozzle must come down until the probe triggers at nozzle (x, y) */
  probeGap(x: number, y: number): number;
  /** Z homed on the probe at nozzle (x, y): the nozzle is now at firmware Z `z` */
  probeHomed(x: number, y: number, z: number): void;
  /** height the probe measures at nozzle (x, y) relative to where Z was homed, with its noise */
  probe(x: number, y: number): number;
  setMesh(mesh: Mesh | null): void;
  setPressureAdvance(pa: number): void;
  motorsOff(): void;
  /** the printer has stopped by itself (a heater fault): why */
  stopped(): string | null;
  say(text: string, level: "info" | "warn" | "error"): void;
}

/** The firmware stopped the print: a command error (Klipper), a missing file or a heater fault. */
export class PrintStop extends Error {}

const ARC_SEG: Record<PrinterFlavor, number> = { klipper: 1, marlin: 1, reprapfirmware: 0.25 };
/** commands every firmware takes quietly */
const QUIET = new Set(["M105", "M110", "M115", "M114", "M117", "M118", "M73", "M21", "M20", "M23", "M24", "M27", "M31", "M300", "M486", "M501", "M503", "M155", "M75", "M76", "M77", "M78", "M412", "M80", "M81"]);

export class PrinterFirmware {
  readonly flavor: PrinterFlavor;
  /** firmware position: x, y, z, e */
  pos: [number, number, number, number] = [0, 0, 0, 0];
  homedAxes = new Set<Axis3>();
  absolute = true;
  absE = true;
  feed = 1500 / 60;
  speedFactor = 1;
  flowFactor = 1;
  fanOn = 0;
  tool = -1;
  mesh: Mesh | null = null;
  limits: Limits;
  planner: Planner;
  /** lines run, extruding moves, commands it did not know (by name) */
  stats = { lines: 0, moves: 0, unknown: new Map<string, number>(), arcs: 0 };
  private depth = 0;
  private file = "print.gcode";
  private lineNo = 0;
  private layerZ = 0;

  constructor(
    readonly setup: PrinterSetup,
    readonly io: PrinterIO,
  ) {
    this.flavor = setup.flavor;
    this.limits = limitsOf(setup);
    const exec = (m: PlanMove) => io.run(m);
    this.planner = setup.flavor === "klipper" ? new KlipperPlanner(() => this.limits, exec) : new WindowPlanner(setup.buffer, setup.flavor, () => this.limits, exec);
    io.setPressureAdvance(setup.pa);
    // RepRapFirmware runs config.g at start-up; a T0 there selects the tool
    if (this.flavor === "reprapfirmware" && setup.sysFiles.size === 0) this.tool = -1;
  }

  /** Start-up: RepRapFirmware's config.g may select a tool. */
  boot(configG?: string) {
    if (configG && /^\s*T0\b/m.test(configG)) this.tool = 0;
    if (this.flavor !== "reprapfirmware") this.tool = 0;
  }

  /** Run a whole file. Throws PrintStop when the firmware stops the print. */
  runFile(text: string, name: string) {
    this.file = name;
    this.runText(text, name);
    this.planner.flush();
  }

  private runText(text: string, file: string) {
    const prevFile = this.file;
    const prevLine = this.lineNo;
    this.file = file;
    const ls = lines(text);
    for (let i = 0; i < ls.length; i++) {
      this.lineNo = i + 1;
      const l = parseLine(ls[i]);
      if (l.comment && file.endsWith(".gcode") && /^LAYER_CHANGE|^Z:/.test(l.comment)) {
        const z = /^Z:\s*([\d.]+)/.exec(l.comment);
        if (z) this.layerZ = Number(z[1]);
      }
      if (!l.cmd) continue;
      this.stats.lines++;
      const why = this.io.stopped();
      if (why) throw new PrintStop(why);
      this.exec(l);
    }
    this.file = prevFile;
    this.lineNo = prevLine;
  }

  private tag(extrude: boolean): MoveTag {
    return { extrude, line: this.lineNo, file: this.file };
  }

  private say(text: string, level: "info" | "warn" | "error" = "info") {
    this.io.say(text, level);
  }

  /** an error the firmware reports; Klipper stops a print on any command error */
  private error(msg: string): never | void {
    if (this.flavor === "klipper") {
      this.say(`!! ${msg}`, "error");
      throw new PrintStop(msg);
    }
    this.say(this.flavor === "marlin" ? `echo:${msg}` : `Error: ${msg}`, "error");
  }

  private unknown(l: GLine) {
    this.stats.unknown.set(l.cmd, (this.stats.unknown.get(l.cmd) ?? 0) + 1);
    if ((this.stats.unknown.get(l.cmd) ?? 0) > 1) return;
    const msg = this.flavor === "klipper" ? `// Unknown command:"${l.cmd}"` : this.flavor === "marlin" ? `echo:Unknown command: "${l.text}"` : `Warning: ${l.cmd} is not supported`;
    this.say(msg, "warn");
  }

  exec(l: GLine) {
    const f = this.flavor;
    const c = l.cmd;
    // Klipper macros come first: a config can define G29, M600 or START_PRINT
    if (f === "klipper" && this.setup.macros.has(c)) return this.macro(c, l);
    switch (c) {
      case "G0":
      case "G1":
        return this.g1(l);
      case "G2":
      case "G3":
        if (f === "klipper" && !this.setup.macros.has(c)) return this.unknown(l);
        return this.arc(l, c === "G2");
      case "G4": {
        this.planner.flush();
        const s = (num(l, "P") ?? 0) / 1000 + (num(l, "S") ?? 0);
        this.io.waitUntil(() => false, s);
        return;
      }
      case "G10":
        if (f === "reprapfirmware" && l.params.P !== undefined) {
          // tool temperatures: G10 P0 S<active> R<standby>
          const s = num(l, "S");
          if (s !== undefined && this.tool >= 0) this.setTemp("hotend", s, false);
          return;
        }
        return this.unknown(l);
      case "G20":
        return this.error("Kerf only simulates millimetre G-code (G21)");
      case "G21":
        return;
      case "G28":
        return this.g28(l);
      case "G29":
        if (f === "klipper") return this.unknown(l);
        return this.meshCalibrate();
      case "G30":
        return this.g30(l);
      case "G90":
        this.absolute = true;
        if (f !== "reprapfirmware") this.absE = true;
        return;
      case "G91":
        this.absolute = false;
        if (f !== "reprapfirmware") this.absE = false;
        return;
      case "G92":
        return this.g92(l);
      case "M82":
        this.absE = true;
        return;
      case "M83":
        this.absE = false;
        return;
      case "M17":
        return;
      case "M18":
      case "M84":
        if (l.params.S !== undefined && f !== "klipper") return;
        this.planner.flush();
        this.io.motorsOff();
        this.homedAxes.clear();
        return;
      case "M104":
      case "M109": {
        const s = num(l, "S") ?? num(l, "R") ?? 0;
        if (f === "reprapfirmware" && this.tool < 0 && l.params.T === undefined) return this.error(`${c}: no tool selected`);
        this.setTemp("hotend", s, c === "M109", c === "M109" && l.params.R !== undefined);
        return;
      }
      case "M140":
      case "M190": {
        const s = num(l, "S") ?? num(l, "R") ?? 0;
        this.setTemp("bed", s, c === "M190", c === "M190" && l.params.R !== undefined);
        return;
      }
      case "M116":
        if (f !== "reprapfirmware") return this.unknown(l);
        this.planner.flush();
        this.waitHeat("hotend");
        this.waitHeat("bed");
        return;
      case "M106": {
        let s = num(l, "S") ?? 255;
        // RepRapFirmware takes 0..1 (or 0..255)
        if (f === "reprapfirmware") s = s <= 1 ? s * 255 : s;
        if (l.params.P !== undefined && num(l, "P") !== 0) return;
        this.setFan(Math.max(0, Math.min(1, s / 255)));
        return;
      }
      case "M107":
        this.setFan(0);
        return;
      case "M201":
        if (f === "klipper") return this.unknown(l);
        for (const [k, ax] of [["X", "x"], ["Y", "y"], ["Z", "z"], ["E", "e"]] as const) {
          const v = nums(l.params[k])[0];
          if (v !== undefined) this.limits.maxA[ax] = v;
        }
        return;
      case "M203":
        if (f === "klipper") return this.unknown(l);
        for (const [k, ax] of [["X", "x"], ["Y", "y"], ["Z", "z"], ["E", "e"]] as const) {
          const v = nums(l.params[k])[0];
          // Marlin takes mm/s, RepRapFirmware mm/min
          if (v !== undefined) this.limits.maxV[ax] = f === "reprapfirmware" ? v / 60 : v;
        }
        return;
      case "M204":
        return this.m204(l);
      case "M205":
        if (f !== "marlin") return this.unknown(l);
        if (num(l, "J") !== undefined && this.limits.junction.kind === "jd") this.limits.junction = { kind: "jd", mm: num(l, "J")! };
        if (this.limits.junction.kind === "jerk") for (const [k, ax] of [["X", "x"], ["Y", "y"], ["Z", "z"], ["E", "e"]] as const) if (num(l, k) !== undefined) this.limits.junction.v[ax] = num(l, k)!;
        return;
      case "M566":
        if (f !== "reprapfirmware") return this.unknown(l);
        if (this.limits.junction.kind === "jerk") for (const [k, ax] of [["X", "x"], ["Y", "y"], ["Z", "z"], ["E", "e"]] as const) if (num(l, k) !== undefined) this.limits.junction.v[ax] = num(l, k)! / 60;
        return;
      case "M220":
        this.speedFactor = (num(l, "S") ?? 100) / 100;
        return;
      case "M221":
        this.flowFactor = (num(l, "S") ?? 100) / 100;
        return;
      case "M400":
        this.planner.flush();
        return;
      case "M420":
        if (f !== "marlin") return this.unknown(l);
        if (num(l, "S") === 1 && !this.mesh) this.say("echo:Invalid mesh. (no mesh has been probed)", "warn");
        return;
      case "M900":
        if (f !== "marlin" || !this.setup.linAdvance) return this.unknown(l);
        this.io.setPressureAdvance(num(l, "K") ?? 0);
        return;
      case "M572":
        if (f !== "reprapfirmware") return this.unknown(l);
        this.io.setPressureAdvance(nums(l.params.S)[0] ?? 0);
        return;
      case "M98": {
        if (f !== "reprapfirmware") return this.unknown(l);
        const name = (l.params.P ?? "").replace(/^.*\//, "");
        const body = this.setup.sysFiles.get(name);
        if (body === undefined) return this.error(`M98: macro file ${name} not found`);
        return this.sub(body, name);
      }
      case "M401":
      case "M402":
        if (f === "reprapfirmware") {
          const body = this.setup.sysFiles.get(c === "M401" ? "deployprobe.g" : "retractprobe.g");
          if (body !== undefined) this.sub(body, c === "M401" ? "deployprobe.g" : "retractprobe.g");
        }
        return;
      case "T0":
        this.tool = 0;
        return;
      case "M112":
        throw new PrintStop("Emergency stop (M112)");
      // Klipper's own commands
      case "BED_MESH_CALIBRATE":
        if (f !== "klipper") return this.unknown(l);
        if (!this.setup.probe?.mesh) return this.unknown(l);
        return this.meshCalibrate();
      case "BED_MESH_CLEAR":
        this.mesh = null;
        this.io.setMesh(null);
        return;
      case "BED_MESH_PROFILE":
        if (f !== "klipper") return this.unknown(l);
        if (l.params.LOAD !== undefined && !this.mesh) this.say(`// bed_mesh: Unknown profile [${l.params.LOAD}] (this simulated printer has no saved mesh)`, "warn");
        return;
      case "SET_PRESSURE_ADVANCE":
        if (f !== "klipper") return this.unknown(l);
        if (l.params.ADVANCE !== undefined) this.io.setPressureAdvance(Number(l.params.ADVANCE) || 0);
        return;
      case "SET_VELOCITY_LIMIT": {
        if (f !== "klipper") return this.unknown(l);
        const p = l.params;
        const L = this.limits;
        if (p.VELOCITY !== undefined) L.velocity = Number(p.VELOCITY);
        if (p.ACCEL !== undefined) L.accel = Number(p.ACCEL);
        if (p.SQUARE_CORNER_VELOCITY !== undefined) L.junction = { kind: "scv", v: Number(p.SQUARE_CORNER_VELOCITY) };
        if (p.MINIMUM_CRUISE_RATIO !== undefined) L.minCruiseRatio = Number(p.MINIMUM_CRUISE_RATIO);
        if (p.ACCEL_TO_DECEL !== undefined) L.minCruiseRatio = Math.max(0, 1 - Number(p.ACCEL_TO_DECEL) / L.accel);
        return;
      }
      case "SET_HEATER_TEMPERATURE": {
        if (f !== "klipper") return this.unknown(l);
        const h = (l.params.HEATER ?? "").toLowerCase();
        const role = h === "heater_bed" ? "bed" : h === "extruder" ? "hotend" : undefined;
        if (!role) return this.error(`Unknown heater "${l.params.HEATER}"`);
        this.setTemp(role, Number(l.params.TARGET ?? 0), false);
        return;
      }
      case "TEMPERATURE_WAIT": {
        if (f !== "klipper") return this.unknown(l);
        const h = (l.params.SENSOR ?? "").toLowerCase();
        const heater = this.io.heater(h === "heater_bed" ? "bed" : "hotend");
        const lo = l.params.MINIMUM !== undefined ? Number(l.params.MINIMUM) : -Infinity;
        const hi = l.params.MAXIMUM !== undefined ? Number(l.params.MAXIMUM) : Infinity;
        if (!heater) return this.error(`Unknown sensor '${l.params.SENSOR}'`);
        this.planner.flush();
        this.io.waitUntil(() => heater.reading >= lo && heater.reading <= hi, 3600);
        return;
      }
      case "SET_GCODE_OFFSET":
      case "SAVE_GCODE_STATE":
      case "RESTORE_GCODE_STATE":
      case "EXCLUDE_OBJECT_DEFINE":
      case "EXCLUDE_OBJECT_START":
      case "EXCLUDE_OBJECT_END":
      case "RESPOND":
      case "SET_PRINT_STATS_INFO":
        if (f !== "klipper") return this.unknown(l);
        return;
      default:
        if (QUIET.has(c)) return;
        return this.unknown(l);
    }
  }

  // ---------------- moves ----------------

  private target(l: GLine, relativeE = !this.absE): [number, number, number, number] {
    const out: [number, number, number, number] = [...this.pos];
    (["X", "Y", "Z"] as const).forEach((k, i) => {
      const v = num(l, k);
      if (v !== undefined) out[i] = this.absolute ? v : this.pos[i] + v;
    });
    const e = num(l, "E");
    if (e !== undefined) out[3] = relativeE ? this.pos[3] + e * this.flowFactor : this.pos[3] + (e - this.pos[3]) * this.flowFactor;
    return out;
  }

  private g1(l: GLine) {
    const F = num(l, "F");
    if (F !== undefined && F > 0) this.feed = F / 60;
    // RepRapFirmware's homing moves: H1 stops at the switch, H2 moves an axis that may not be homed
    if (this.flavor === "reprapfirmware" && l.params.H !== undefined) return this.rrfHomingMove(l);
    const to = this.target(l);
    this.moveTo(to, this.feed * this.speedFactor);
  }

  /** Every firmware's checks on a move, then plan it. */
  moveTo(to: [number, number, number, number], speed: number, quiet = false) {
    const f = this.flavor;
    const s = this.setup;
    const from = this.pos;
    const moved = AXES3.filter((ax, i) => Math.abs(to[i] - from[i]) > 1e-9);
    // homing
    const unhomed = moved.filter((ax) => !this.homedAxes.has(ax));
    if (unhomed.length && f !== "marlin") {
      if (f === "klipper") return this.error(`Must home axis first: ${to.slice(0, 3).map((v) => v.toFixed(3)).join(" ")} [${to[3].toFixed(3)}]`);
      this.error("G0/G1: insufficient axes homed");
      return;
    }
    // limits
    for (let i = 0; i < 3; i++) {
      const ax = AXES3[i];
      if (!this.homedAxes.has(ax) || !moved.includes(ax)) continue;
      const lo = s.min[ax];
      const hi = s.max[ax];
      if (to[i] < lo - 1e-6 || to[i] > hi + 1e-6) {
        if (f === "klipper") return this.error(`Move out of range: ${to.slice(0, 3).map((v) => v.toFixed(3)).join(" ")} [${to[3].toFixed(3)}]`);
        if (f === "marlin") to[i] = Math.max(lo, Math.min(hi, to[i]));
        else {
          this.error("G0/G1: target position outside machine limits");
          return;
        }
      }
    }
    // extrusion
    const de = to[3] - from[3];
    const xyd = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (Math.abs(de) > 1e-9) {
      if (f === "reprapfirmware" && this.tool < 0) {
        if (!this.stats.unknown.has("no tool")) this.say("Warning: extrusion ignored: no tool is selected (T0)", "warn");
        this.stats.unknown.set("no tool", 1);
        to[3] = from[3];
      } else {
        const hot = this.io.heater("hotend");
        const temp = hot?.reading ?? -Infinity;
        if (temp < s.extruder.minTemp) {
          if (f === "klipper") return this.error("Extrude below minimum temp\nSee the 'min_extrude_temp' config option for details");
          if (!quiet) this.say(f === "marlin" ? "echo: cold extrusion prevented" : `Warning: cold extrusion prevented (${temp.toFixed(0)} °C is below ${s.extruder.minTemp} °C)`, "warn");
          to[3] = from[3];
        } else if (xyd < 1e-9 || de < 0) {
          if (Math.abs(de) > s.extruder.maxOnly) {
            if (f === "klipper") return this.error(`Extrude only move too long (${Math.abs(de).toFixed(3)}mm vs ${s.extruder.maxOnly.toFixed(3)}mm)\nSee the 'max_extrude_only_distance' config option for details`);
            this.say("echo: too long extrusion prevented", "warn");
            to[3] = from[3];
          }
        } else if (f === "klipper") {
          const fa = (Math.PI / 4) * s.extruder.filament ** 2;
          const ratio = de / Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
          if (ratio * fa > s.extruder.maxCross && de > s.extruder.nozzle * (s.extruder.maxCross / fa)) return this.error(`Move exceeds maximum extrusion (${(ratio * fa).toFixed(3)}mm^2 vs ${s.extruder.maxCross.toFixed(3)}mm^2)\nSee the 'max_extrude_cross_section' config option for details`);
        }
      }
    }
    const extrude = to[3] - from[3] > 1e-9 && xyd > 1e-9;
    const m = makeMove({ start: [...from], end: [...to], speed, tag: this.tag(extrude) }, this.limits, f);
    this.pos = [...to];
    if (!m) return;
    if (extrude) this.stats.moves++;
    this.planner.add(m);
  }

  private arc(l: GLine, cw: boolean) {
    const F = num(l, "F");
    if (F !== undefined && F > 0) this.feed = F / 60;
    const end = this.target(l);
    const [x0, y0] = this.pos;
    let cx: number;
    let cy: number;
    const R = num(l, "R");
    if (R !== undefined) {
      // centre from the radius: the shorter arc for R > 0
      const dx = end[0] - x0;
      const dy = end[1] - y0;
      const d = Math.hypot(dx, dy);
      if (d < 1e-9 || d > 2 * Math.abs(R) + 1e-6) return this.error(`${l.cmd}: the radius is too small for the distance`);
      const h = Math.sqrt(Math.max(0, R * R - (d / 2) ** 2)) * ((cw ? 1 : -1) * (R > 0 ? 1 : -1));
      cx = x0 + dx / 2 + (-dy / d) * -h;
      cy = y0 + dy / 2 + (dx / d) * -h;
    } else {
      cx = x0 + (num(l, "I") ?? 0);
      cy = y0 + (num(l, "J") ?? 0);
    }
    const r = Math.hypot(x0 - cx, y0 - cy);
    let a0 = Math.atan2(y0 - cy, x0 - cx);
    const a1 = Math.atan2(end[1] - cy, end[0] - cx);
    let sweep = a1 - a0;
    if (cw && sweep >= -1e-9) sweep -= 2 * Math.PI;
    if (!cw && sweep <= 1e-9) sweep += 2 * Math.PI;
    const len = Math.abs(sweep) * r;
    const n = Math.max(1, Math.ceil(len / ARC_SEG[this.flavor]));
    const start = [...this.pos];
    this.stats.arcs++;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      a0 = Math.atan2(start[1] - cy, start[0] - cx) + sweep * t;
      const p: [number, number, number, number] = i === n ? end : [cx + r * Math.cos(a0), cy + r * Math.sin(a0), start[2] + (end[2] - start[2]) * t, start[3] + (end[3] - start[3]) * t];
      this.moveTo(p, this.feed * this.speedFactor);
    }
  }

  private g92(l: GLine) {
    this.planner.flush();
    const keys = ["X", "Y", "Z", "E"] as const;
    const any = keys.some((k) => l.params[k] !== undefined);
    keys.forEach((k, i) => {
      const v = num(l, k);
      if (v !== undefined || (!any && i === 3)) this.pos[i] = v ?? 0;
    });
    // setting a position on an axis that was not homed counts as homing it in Marlin and RepRapFirmware
    if (this.flavor !== "klipper") for (const [k, ax] of [["X", "x"], ["Y", "y"], ["Z", "z"]] as const) if (l.params[k] !== undefined) this.homedAxes.add(ax);
  }

  private m204(l: GLine) {
    const L = this.limits;
    const S = num(l, "S");
    const P = num(l, "P");
    const T = num(l, "T");
    const R = num(l, "R");
    if (this.flavor === "klipper") {
      let a = S;
      if (a === undefined) {
        if (P === undefined || T === undefined) {
          this.say(`// Invalid M204 command "${l.text}"`, "warn");
          return;
        }
        a = Math.min(P, T);
      }
      L.accel = a;
      return;
    }
    if (S !== undefined) L.printAccel = L.travelAccel = S;
    if (P !== undefined) L.printAccel = P;
    if (T !== undefined) L.travelAccel = T;
    if (R !== undefined && this.flavor === "marlin") L.retractAccel = R;
  }

  // ---------------- heat and fans ----------------

  private setTemp(role: "hotend" | "bed", t: number, wait: boolean, cooling = false) {
    const h = this.io.heater(role);
    if (!h) {
      if (t > 0) this.say(role === "bed" ? `${FLAVOR_NAME[this.flavor]} has no heated bed configured` : "No hotend heater is configured", "warn");
      return;
    }
    const max = h.setup.maxTemp;
    if (t > max) {
      // every firmware refuses a target above the heater's limit
      if (this.flavor === "klipper") return this.error(`Requested temperature (${t.toFixed(1)}) out of range (${h.setup.minTemp.toFixed(1)}:${max.toFixed(1)})`);
      this.say(this.flavor === "marlin" ? `echo:${role} temperature ${t} is above the limit` : `Error: temperature ${t} is above the heater's limit of ${max}`, "error");
      t = Math.min(t, max - 15);
    }
    if (wait) {
      this.planner.flush();
      h.setTarget(t, this.io.now());
      this.waitHeat(role, cooling);
    } else this.planner.after(() => h.setTarget(t, this.io.now()));
  }

  private waitHeat(role: "hotend" | "bed", cooling = false) {
    const h = this.io.heater(role);
    if (!h || h.target <= 0) return;
    const now = () => this.io.now();
    // Marlin's M109 S only waits for heating; R (and Klipper, RRF) wait both ways
    const done = () => (this.flavor === "marlin" && !cooling && h.reading >= h.target ? !h.busy(now()) || h.reading >= h.target : !h.busy(now()));
    const ok = this.io.waitUntil(done, 1800);
    const why = this.io.stopped();
    if (why) throw new PrintStop(why);
    if (!ok) this.say(`${role === "bed" ? "Bed" : "Hotend"} did not reach ${h.target} °C in 30 minutes`, "error");
  }

  private setFan(v: number) {
    this.fanOn = v;
    this.planner.after(() => this.io.fan(v));
  }

  // ---------------- homing, probing, levelling ----------------

  /** A straight move ignoring limits and homing (the firmware's own homing moves). */
  private raw(to: Partial<Record<AxisE, number>>, speed: number) {
    const end: [number, number, number, number] = [to.x ?? this.pos[0], to.y ?? this.pos[1], to.z ?? this.pos[2], to.e ?? this.pos[3]];
    const m = makeMove({ start: [...this.pos], end, speed, tag: this.tag(false) }, this.limits, this.flavor);
    this.pos = end;
    if (!m) return;
    this.planner.add(m);
    this.planner.flush();
  }

  /** Home one axis on its switch: fast to the switch, back off, slow touch. */
  private homeAxis(ax: Axis3) {
    const h = this.setup.homing[ax];
    const i = AXES3.indexOf(ax);
    this.planner.flush();
    // the firmware does not know where the carriage is: it moves until the switch closes
    this.pos[i] = this.io.actual(ax);
    this.raw({ [ax]: h.pos }, h.speed);
    this.raw({ [ax]: h.pos - h.dir * h.retract }, h.speed);
    this.raw({ [ax]: h.pos }, h.second);
    this.io.homed(ax, h.pos);
    this.pos[i] = h.pos;
    this.homedAxes.add(ax);
  }

  /** Home Z on the probe at the current XY. */
  private homeZProbe() {
    const p = this.setup.probe;
    const h = this.setup.homing.z;
    if (!p) return this.error("Z homes on the probe but no probe is configured");
    this.planner.flush();
    const [x, y] = this.pos;
    this.pos[2] = this.io.actual("z");
    const gap = this.io.probeGap(x, y);
    this.raw({ z: this.pos[2] - gap }, h.speed);
    this.raw({ z: this.pos[2] + h.retract }, h.speed);
    this.raw({ z: this.pos[2] - h.retract }, h.second);
    this.io.probeHomed(x, y, p.z);
    this.pos[2] = p.z;
    this.homedAxes.add("z");
  }

  private g28(l: GLine) {
    const f = this.flavor;
    this.planner.flush();
    const asked = AXES3.filter((ax) => l.params[ax.toUpperCase()] !== undefined);
    const want = asked.length ? asked : AXES3;
    if (f === "reprapfirmware") {
      const file = want.length === 3 ? "homeall.g" : want.length === 1 ? `home${want[0]}.g` : "";
      const files = file ? [file] : want.map((a) => `home${a}.g`);
      for (const name of files) {
        const body = this.setup.sysFiles.get(name);
        if (body === undefined) {
          this.error(`G28: homing file ${name} not found`);
          throw new PrintStop(`RepRapFirmware has no ${name} in sys/, so G28 cannot home`);
        }
        this.sub(body, name);
      }
      return;
    }
    const sh = this.setup.safeHome;
    const zHop = sh?.hop ?? (f === "marlin" ? 10 : 0);
    if (zHop > 0) {
      // lift before homing: Klipper's safe_z_home z_hop, Marlin's Z_CLEARANCE_FOR_HOMING
      const zi = 2;
      if (!this.homedAxes.has("z")) {
        this.pos[zi] = this.io.actual("z");
        this.raw({ z: this.pos[zi] + zHop }, this.setup.homing.z.speed);
      } else if (this.pos[zi] < zHop) this.raw({ z: zHop }, this.setup.homing.z.speed);
    }
    if (want.includes("x")) this.homeAxis("x");
    if (want.includes("y")) this.homeAxis("y");
    if (want.includes("z")) {
      if (this.setup.homing.z.probe) {
        if (!this.homedAxes.has("x") || !this.homedAxes.has("y")) return this.error("Must home X and Y axes first");
        const hx = sh?.x ?? (this.setup.min.x + this.setup.max.x) / 2 - (this.setup.probe?.x ?? 0);
        const hy = sh?.y ?? (this.setup.min.y + this.setup.max.y) / 2 - (this.setup.probe?.y ?? 0);
        this.raw({ x: hx, y: hy }, sh?.speed ?? this.setup.homing.x.speed);
        this.homeZProbe();
        if (zHop > 0) this.raw({ z: Math.max(this.pos[2], zHop) }, this.setup.homing.z.speed);
      } else this.homeAxis("z");
    }
  }

  /** G30: probe once here and set Z (RepRapFirmware), or report the height (Marlin). */
  private g30(l: GLine) {
    const f = this.flavor;
    if (f === "klipper") return this.unknown(l);
    if (!this.setup.probe) return this.error("G30: no Z probe is configured");
    if (f === "reprapfirmware" && l.params.P === undefined) {
      if (!this.homedAxes.has("x") || !this.homedAxes.has("y")) return this.error("G30: insufficient axes homed");
      return this.homeZProbe();
    }
    this.planner.flush();
    const [x, y] = this.pos;
    this.say(`Bed X: ${x.toFixed(3)} Y: ${y.toFixed(3)} Z: ${this.io.probe(x, y).toFixed(3)}`);
  }

  /** Klipper BED_MESH_CALIBRATE, Marlin G29, RepRapFirmware G29: probe a grid and level with it. */
  private meshCalibrate() {
    const f = this.flavor;
    const p = this.setup.probe;
    if (!p) return this.error(f === "marlin" ? "G29: no bed probe is configured" : "G29: no Z probe is configured");
    if (f === "reprapfirmware" && this.setup.sysFiles.has("mesh.g")) return this.sub(this.setup.sysFiles.get("mesh.g")!, "mesh.g");
    if (!p.mesh) {
      if (f === "marlin") return this.say("echo:Unknown command: G29 (no AUTO_BED_LEVELING_* in Configuration.h)", "warn");
      return this.error("G29: no mesh grid is defined (M557)");
    }
    if (AXES3.some((ax) => !this.homedAxes.has(ax))) return this.error(f === "klipper" ? "Must home axis first" : "G29: home the printer first");
    this.planner.flush();
    const { min, max, count } = p.mesh;
    const z: number[][] = [];
    const lift = Math.max(p.lift, p.z + 2);
    for (let j = 0; j < count[1]; j++) {
      const row: number[] = [];
      for (let k = 0; k < count[0]; k++) {
        // serpentine, as all three firmwares probe
        const kk = j % 2 ? count[0] - 1 - k : k;
        const px = min[0] + ((max[0] - min[0]) * kk) / Math.max(1, count[0] - 1);
        const py = min[1] + ((max[1] - min[1]) * j) / Math.max(1, count[1] - 1);
        const nx = px - p.x;
        const ny = py - p.y;
        if (this.pos[2] < lift) this.raw({ z: lift }, Math.max(5, p.speed));
        this.raw({ x: nx, y: ny }, p.travel);
        let sum = 0;
        for (let s = 0; s < Math.max(1, p.samples); s++) {
          const h = this.io.probe(nx, ny);
          this.raw({ z: p.z + h }, p.speed);
          sum += h;
          this.raw({ z: lift }, Math.max(5, p.speed));
        }
        row[kk] = sum / Math.max(1, p.samples);
      }
      z.push(row);
    }
    this.mesh = { min, max, count, z };
    this.io.setMesh(this.mesh);
    const range = Math.max(...z.flat()) - Math.min(...z.flat());
    this.say(f === "klipper" ? `// Mesh Bed Leveling Complete (range ${range.toFixed(3)} mm)` : f === "marlin" ? `echo:Bilinear Leveling Grid done (range ${range.toFixed(3)} mm)` : `${count[0] * count[1]} points probed, deviation range ${range.toFixed(3)} mm`);
  }

  /** RepRapFirmware G1 H1 (stop at the switch) and H2 (move without limits). */
  private rrfHomingMove(l: GLine) {
    const H = num(l, "H");
    const rel = !this.absolute;
    this.planner.flush();
    if (H === 2 || H === 0) {
      const to: Partial<Record<AxisE, number>> = {};
      for (const ax of AXES3) {
        const v = num(l, ax.toUpperCase());
        if (v === undefined) continue;
        const i = AXES3.indexOf(ax);
        to[ax] = rel ? this.pos[i] + v : v;
      }
      this.raw(to, this.feed * this.speedFactor);
      return;
    }
    if (H !== 1 && H !== 4) return this.error(`G1 H${H}: Kerf simulates H1 and H2 homing moves`);
    for (const ax of AXES3) {
      const v = num(l, ax.toUpperCase());
      if (v === undefined) continue;
      const i = AXES3.indexOf(ax);
      const h = this.setup.homing[ax];
      if (ax === "z" && h.probe) return this.error("G1 H1 Z: Z homes with the probe: use G30");
      // where the carriage really is, against the switch it moves towards
      const actual = this.homedAxes.has(ax) ? this.pos[i] : this.io.actual(ax);
      const dirOk = Math.sign(v) === h.dir || (!rel && Math.sign(v - actual) === h.dir);
      const travel = rel ? v : v - actual;
      const toSwitch = h.pos - actual;
      this.pos[i] = actual;
      if (dirOk && Math.abs(travel) >= Math.abs(toSwitch) - 1e-6 && Math.sign(toSwitch || h.dir) === h.dir) {
        this.raw({ [ax]: h.pos }, this.feed * this.speedFactor);
        this.io.homed(ax, h.pos);
        this.pos[i] = h.pos;
        this.homedAxes.add(ax);
      } else {
        // it never reached the switch
        this.raw({ [ax]: actual + travel }, this.feed * this.speedFactor);
        this.say(`Warning: G1 H1 ${ax.toUpperCase()}: the move ended before the endstop triggered`, "warn");
      }
    }
  }

  // ---------------- macros and system files ----------------

  private sub(body: string, name: string) {
    if (++this.depth > 20) throw new PrintStop(`${name} calls itself without end`);
    try {
      this.runText(body, name);
    } finally {
      this.depth--;
    }
  }

  private macro(name: string, l: GLine) {
    const body = this.setup.macros.get(name)!;
    const params: Record<string, JVal> = { ...l.params };
    const h = this.io.heater("hotend");
    const b = this.io.heater("bed");
    const s = this.setup;
    const xyz = (v: number[]) => ({ x: v[0], y: v[1], z: v[2], e: v[3] ?? 0 });
    const printer: Record<string, JVal> = {
      toolhead: {
        position: xyz(this.pos),
        axis_maximum: xyz([s.max.x, s.max.y, s.max.z, 0]),
        axis_minimum: xyz([s.min.x, s.min.y, s.min.z, 0]),
        homed_axes: AXES3.filter((a) => this.homedAxes.has(a)).join(""),
        max_velocity: this.limits.velocity,
        max_accel: this.limits.accel,
      },
      extruder: { temperature: h?.reading ?? 0, target: h?.target ?? 0, can_extrude: (h?.reading ?? 0) >= s.extruder.minTemp },
      heater_bed: { temperature: b?.reading ?? 0, target: b?.target ?? 0 },
    };
    let text: string;
    try {
      text = renderMacro(body, { params, rawparams: l.text.slice(name.length).trim(), printer });
    } catch (e) {
      if (e instanceof MacroError) return this.error(`Error evaluating 'gcode_macro ${name}:gcode': ${e.message}`);
      throw e;
    }
    this.sub(text, `macro ${name}`);
  }

  get layerHeight() {
    return this.layerZ;
  }
}
