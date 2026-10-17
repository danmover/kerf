// What every 3D printer firmware generator needs to know about the design,
// found once from the wiring and the parts: which stepper drives which axis,
// rotation distances, run currents, heaters, thermistors, fans, endstops and
// the probe. Klipper, Marlin and RepRapFirmware each write these facts in
// their own config format.

import { catalogPart } from "../catalog";
import type { NetPin } from "../erc";
import type { CatalogPart, MachineComponent } from "../types";
import { type FwContext, setting } from "./common";

export interface Link {
  port: NetPin;
  dev: NetPin;
}

export type PrinterAxis = "x" | "y" | "z" | "extruder";
export const PRINTER_AXES: PrinterAxis[] = ["x", "y", "z", "extruder"];

/** The firmwares Kerf writes printer configs for. */
export type PrinterFlavor = "klipper" | "marlin" | "reprapfirmware";
export const PRINTER_FLAVORS: PrinterFlavor[] = ["klipper", "marlin", "reprapfirmware"];
export const FLAVOR_NAME: Record<PrinterFlavor, string> = { klipper: "Klipper", marlin: "Marlin", reprapfirmware: "RepRapFirmware" };

/** A flavor setting as written ("rrf", "Marlin 2") to the flavor it means. */
export function flavorOf(text: string): PrinterFlavor | undefined {
  const t = text.toLowerCase().replace(/[^a-z]/g, "");
  if (t.startsWith("klipper")) return "klipper";
  if (t.startsWith("marlin")) return "marlin";
  if (t === "rrf" || t.startsWith("reprap") || t.startsWith("duet")) return "reprapfirmware";
  return undefined;
}

/** The printer firmwares a board runs, from its catalog specs (`firmware: "klipper, marlin"`). */
export function boardFlavors(p: CatalogPart): PrinterFlavor[] {
  const list = String(p.specs.firmware ?? (p.specs.platform === "klipper" ? "klipper" : ""));
  return list
    .split(/[,;/ ]+/)
    .map((s) => flavorOf(s))
    .filter((f): f is PrinterFlavor => !!f);
}

/** Klipper's kinematics names: a firmware setting must be one of these. */
export const KINEMATICS = ["cartesian", "corexy", "corexz", "hybrid_corexy", "hybrid_corexz", "delta", "deltesian", "rotary_delta", "polar", "winch", "none"];

export const parseMcu = (s: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const kv of (s ?? "").split(",")) {
    const [k, v] = kv.split("=");
    if (k && v !== undefined) out[k.trim()] = v.trim();
    else if (k) out.pin = k.trim();
  }
  return out;
};

export const r2 = (n: number) => Math.round(n * 100) / 100;

export interface RunCurrent {
  /** driver RMS current, A */
  want: number;
  /** several motors share the driver */
  parallel: boolean;
  /** each motor's rated current, A */
  rated: number;
  /** the most the board's driver gives, A */
  portMax: number;
  /** motors on the driver */
  motors: number;
}

export interface FanLink {
  link: Link;
  role: "part" | "hotend" | "controller";
}

export interface PrinterFacts {
  c: FwContext;
  board: string;
  host?: MachineComponent;
  links: Link[];
  /** stepper cables by axis */
  steppers: Map<PrinterAxis, Link[]>;
  size: { x: number; y: number; z: number };
  /** rotation distance (mm per motor turn) and where it came from */
  rot: Record<PrinterAxis, { v: number; why: string; gear?: string }>;
  /** gear ratio as a number (driven/driver), 1 without one */
  gearRatio: number;
  current: Partial<Record<PrinterAxis, RunCurrent>>;
  hotHeater?: Link;
  bedHeater?: Link;
  hotTherm?: Link;
  bedTherm?: Link;
  hotPart?: CatalogPart;
  bedPart?: CatalogPart;
  extruderComp?: MachineComponent;
  extruderPart?: CatalogPart;
  fans: FanLink[];
  endstops: Link[];
  probe?: Link;
  /** probe position relative to the nozzle, mm */
  probeX: number;
  probeY: number;
  nozzle: number;
  filament: number;
  /** hotend and bed temperature limits, °C */
  hotMax: number;
  bedMax: number;
  /** motion limits from the firmware block */
  maxVelocity: number;
  maxAccel: number;
  warnings: string[];
}

export const devName = (l: Link) => `${l.dev.comp}${l.dev.mc.count > 1 ? `[${l.dev.index}]` : ""}`;
const roleText = (mc: MachineComponent) => `${mc.name} ${mc.role ?? ""}`.toLowerCase();
const specNum = (p: CatalogPart | undefined, k: string) => (p && typeof p.specs[k] === "number" ? (p.specs[k] as number) : undefined);

/**
 * The endstop cabled for an axis: by the board port's name (XSTOP, Y-STOP...), or on boards whose
 * ports do not name an axis (a Duet's IO_5), by the switch's role ("x endstop").
 */
export const endstopFor = (f: PrinterFacts, ax: string) =>
  f.endstops.find((l) => l.port.pin.id.toUpperCase().startsWith(ax.toUpperCase())) ??
  f.endstops.find((l) => !/^[XYZ]/i.test(l.port.pin.id) && new RegExp(`\\b${ax}\\b`, "i").test(roleText(l.dev.mc)));

/** The axis a device's name or role says it belongs to ("x", "z", "extruder"), if any. */
export function roleAxis(l: Link): PrinterAxis | undefined {
  const t = roleText(l.dev.mc);
  if (/extru/.test(t)) return "extruder";
  return t.match(/\b([xyz])\b/)?.[1] as PrinterAxis | undefined;
}

export function printerFacts(c: FwContext): PrinterFacts {
  const warnings: string[] = [];
  const board = c.board.name;
  const links: Link[] = [];
  for (const cab of c.nl.cables) {
    if (cab.a.comp === board) links.push({ port: cab.a, dev: cab.b });
    else if (cab.b.comp === board) links.push({ port: cab.b, dev: cab.a });
  }
  const ofPort = (kind: string) => links.filter((l) => l.port.pin.port === kind);
  const compsOf = (kind: string) => c.m.components.filter((x) => catalogPart(x.catalogId)?.kind === kind);

  // ---- axes from stepper ports ----
  const axisOf = (l: Link): PrinterAxis | undefined => {
    const id = l.port.pin.id.toUpperCase();
    if (/^X/.test(id)) return "x";
    if (/^Y/.test(id)) return "y";
    if (/^Z/.test(id)) return "z";
    if (/^E/.test(id)) return "extruder";
    const t = roleText(l.dev.mc);
    if (/extru/.test(t)) return "extruder";
    const m = t.match(/\b([xyz])\b/);
    return m?.[1] as PrinterAxis | undefined;
  };
  const steppers = new Map<PrinterAxis, Link[]>();
  for (const l of ofPort("stepper4")) {
    const ax = axisOf(l);
    if (!ax) {
      warnings.push(`${devName(l)} is on ${board}.${l.port.pin.id} but Kerf cannot tell which axis it drives: give it role: "x", "y", "z" or "extruder".`);
      continue;
    }
    steppers.set(ax, [...(steppers.get(ax) ?? []), l]);
  }
  for (const ax of PRINTER_AXES) if (!steppers.has(ax)) warnings.push(`No ${ax === "extruder" ? "extruder" : ax.toUpperCase()} stepper is cabled to ${board}: that section is left out.`);

  // ---- mechanics ----
  const size = {
    x: setting(c.fw, "x_size", 220),
    y: setting(c.fw, "y_size", 220),
    z: setting(c.fw, "z_size", 250),
  };
  const pulleys = compsOf("pulley").filter((p) => specNum(catalogPart(p.catalogId), "mm_per_rev"));
  const pulleyFor = (ax: string) => pulleys.find((p) => new RegExp(`\\b${ax}\\b`).test(roleText(p))) ?? pulleys[0];
  const screw = compsOf("lead_screw")[0];
  const extruderComp = compsOf("extruder")[0];
  const extruderPart = extruderComp && catalogPart(extruderComp.catalogId);
  const rot = {} as PrinterFacts["rot"];
  for (const ax of ["x", "y"] as const) {
    const p = pulleyFor(ax);
    const v = setting(c.fw, `${ax}_rotation_distance`, p ? specNum(catalogPart(p.catalogId), "mm_per_rev")! : 40);
    rot[ax] = { v, why: p ? `${p.name}: ${catalogPart(p.catalogId)?.specs.teeth} teeth × 2 mm GT2 pitch` : "assumed GT2 20-tooth pulley" };
  }
  const lead = screw ? specNum(catalogPart(screw.catalogId), "lead") : undefined;
  rot.z = { v: setting(c.fw, "z_rotation_distance", lead ?? 8), why: screw ? `${screw.name}: ${lead} mm lead` : "assumed T8×8 lead screw" };
  rot.extruder = {
    v: setting(c.fw, "e_rotation_distance", specNum(extruderPart, "rotation_distance") ?? 22.68),
    gear: extruderPart && typeof extruderPart.specs.gear_ratio === "string" ? extruderPart.specs.gear_ratio : undefined,
    why: extruderPart ? `${extruderComp!.name} (${extruderPart.name}): calibrate by extruding 100 mm` : "assumed BMG-style drive: calibrate by extruding 100 mm",
  };
  const gearRatio = ratioOf(rot.extruder.gear);

  // ---- run currents ----
  const current: PrinterFacts["current"] = {};
  for (const [ax, ls] of steppers) {
    const motor = catalogPart(ls[0].dev.mc.catalogId);
    const rated = specNum(motor, "i_rated") ?? 1;
    const portMax = ls[0].port.pin.imax ?? 1.4;
    const parallel = new Set(ls.map((l) => parseMcu(l.port.pin.mcu).step ?? l.port.pin.id)).size < ls.length;
    const share = ax === "extruder" ? 0.5 : 0.7;
    const want = setting(c.fw, `${ax === "extruder" ? "e" : ax}_run_current`, r2(Math.min(rated * share * (parallel ? ls.length : 1), portMax)));
    current[ax] = { want, parallel, rated, portMax, motors: ls.length };
  }

  // ---- heaters, thermistors, fans, endstops, probe ----
  const heaters = ofPort("heater2");
  const therms = ofPort("therm2");
  const isBed = (l: Link) => catalogPart(l.dev.mc.catalogId)?.kind === "heated_bed";
  const hotHeater = heaters.find((l) => !isBed(l));
  const bedHeater = heaters.find(isBed);
  const hotTherm = therms.find((l) => !isBed(l));
  const bedTherm = therms.find(isBed);
  const hotPart = hotHeater ? catalogPart(hotHeater.dev.mc.catalogId) : undefined;
  const bedPart = bedHeater ? catalogPart(bedHeater.dev.mc.catalogId) : undefined;
  const fanRole = (l: Link): FanLink["role"] => {
    const t = `${roleText(l.dev.mc)} ${l.dev.part.id}`;
    if (/part|blower|print/.test(t)) return "part";
    if (/hotend|heatsink|heat ?break/.test(t)) return "hotend";
    if (/controller|electronics|board|case/.test(t)) return "controller";
    const pl = (l.port.pin.label ?? "").toLowerCase();
    return pl.includes("part") ? "part" : pl.includes("hotend") ? "hotend" : "controller";
  };
  const fans = ofPort("fan2").map((link) => ({ link, role: fanRole(link) }));
  const endstops = ofPort("endstop3");
  const probe = ofPort("probe5")[0];

  return {
    c,
    board,
    host: compsOf("host")[0],
    links,
    steppers,
    size,
    rot,
    gearRatio,
    current,
    hotHeater,
    bedHeater,
    hotTherm,
    bedTherm,
    hotPart,
    bedPart,
    extruderComp,
    extruderPart,
    fans,
    endstops,
    probe,
    probeX: setting(c.fw, "probe_x", -40),
    probeY: setting(c.fw, "probe_y", -10),
    nozzle: specNum(hotPart, "nozzle") ?? 0.4,
    filament: specNum(extruderPart, "filament") ?? specNum(hotPart, "filament") ?? 1.75,
    hotMax: specNum(hotPart, "max_temp_c") ?? 260,
    bedMax: specNum(bedPart, "max_temp_c") ?? 110,
    maxVelocity: setting(c.fw, "max_velocity", 300),
    maxAccel: setting(c.fw, "max_accel", 3000),
    warnings,
  };
}

/** "50:17" → 50/17; a plain number as is; 1 when absent or unreadable. */
export function ratioOf(gear: string | undefined): number {
  if (!gear) return 1;
  let r = 1;
  for (const pair of gear.split(",")) {
    const [a, b] = pair.split(":").map((s) => Number(s.trim()));
    if (a > 0 && b > 0) r *= a / b;
  }
  return r;
}

/** Full steps per motor turn (1.8° motors: 200). */
export function fullSteps(l: Link | undefined): number {
  const deg = specNum(l ? catalogPart(l.dev.mc.catalogId) : undefined, "step_deg") ?? 1.8;
  return Math.round(360 / deg);
}

/** Steps per mm at 16 microsteps, for firmwares that take steps/mm (Marlin, RepRapFirmware). */
export function stepsPerMm(f: PrinterFacts, ax: PrinterAxis, microsteps = 16): number {
  const ls = f.steppers.get(ax);
  const turns = ax === "extruder" ? f.gearRatio : 1;
  return (fullSteps(ls?.[0]) * microsteps * turns) / f.rot[ax].v;
}

/** Starting PID values (typical for an E3D V6-class hotend and a 220 W bed); the README says how to tune them. */
export const PID_START = {
  hotend: { kp: 21.527, ki: 1.063, kd: 108.982 },
  bed: { kp: 54.027, ki: 0.77, kd: 948.182 },
};

/** A thermistor in each firmware's terms: Marlin's TEMP_SENSOR table number and RepRapFirmware's M308 T, B and C. */
export interface ThermistorInfo {
  /** Klipper's sensor_type name, as the catalog gives it */
  name: string;
  marlin: number;
  rrf: { t: number; b: number; c: number };
  /** Kerf knows this thermistor (otherwise the values are the default's) */
  known: boolean;
}

// Marlin numbers are from the thermistor list in Marlin's Configuration.h. The Semitec B and C are
// Duet3D's and E3D's published values (also the RepRapFirmware config tool's default); the EPCOS B and C
// are fitted to the TDK datasheet points Klipper uses for that sensor (25, 150 and 250 °C).
const THERMISTORS: Record<string, Omit<ThermistorInfo, "known" | "name">> = {
  "EPCOS 100K B57560G104F": { marlin: 1, rrf: { t: 100000, b: 4613, c: 8.93e-8 } },
  "ATC Semitec 104GT-2": { marlin: 5, rrf: { t: 100000, b: 4725, c: 7.06e-8 } },
  "ATC Semitec 104NT-4-R025H42G": { marlin: 5, rrf: { t: 100000, b: 4725, c: 7.06e-8 } },
  "Generic 3950": { marlin: 11, rrf: { t: 100000, b: 3950, c: 0 } },
};

/** The thermistor a hotend or bed part has (its catalog klipper_sensor), the EPCOS 100k when it names none. */
export function thermistorFor(p: CatalogPart | undefined): ThermistorInfo {
  const name = typeof p?.specs.klipper_sensor === "string" ? p.specs.klipper_sensor : "EPCOS 100K B57560G104F";
  const t = THERMISTORS[name];
  return t ? { name, known: true, ...t } : { name, known: false, ...THERMISTORS["EPCOS 100K B57560G104F"] };
}

/** The supply voltage on the board's power input, when the wiring connects it to a supply. */
export function boardSupplyV(c: FwContext): number | undefined {
  for (const p of c.nl.pinsOf.get(c.board.name) ?? []) {
    if (p.pin.type !== "pwr_in") continue;
    const src = c.nl.netOf.get(p.key)?.pins.find((q) => q.pin.type === "pwr_out" && q.pin.v !== undefined);
    if (src) return src.pin.v;
  }
  return undefined;
}

/**
 * The checks every printer generator but Klipper's makes the same way (klipper.ts makes them inline
 * while writing its sections): heaters with their thermistors, the hotend fan, endstops and run currents.
 * `axisName` names an axis in that firmware's terms for the messages.
 */
export function printerChecks(f: PrinterFacts, axisName: (ax: PrinterAxis) => string): string[] {
  const out: string[] = [];
  if (!(f.hotHeater && f.hotTherm)) out.push("The hotend heater and thermistor must both be cabled to the board.");
  if (!!f.bedHeater !== !!f.bedTherm) out.push("The bed heater and its thermistor must both be cabled to the board.");
  if (f.hotHeater && !f.fans.some((x) => x.role === "hotend")) out.push("No hotend heatsink fan is cabled: an all-metal hotend jams (heat creep) without one.");
  for (const ax of ["x", "y", "z"] as const) {
    if (!f.steppers.has(ax) || (ax === "z" && f.probe) || endstopFor(f, ax)) continue;
    out.push(`No ${ax.toUpperCase()} endstop is cabled to the board: add one or set up sensorless homing.`);
  }
  for (const ax of PRINTER_AXES) {
    const rc = f.current[ax];
    if (!rc) continue;
    const each = rc.parallel ? r2(rc.want / rc.motors) : rc.want;
    if (rc.want > rc.portMax) out.push(`${axisName(ax)} run current ${cNumShort(rc.want)} A is above what ${f.board}'s driver can give (${cNumShort(rc.portMax)} A).`);
    if (each > rc.rated) out.push(`${axisName(ax)} run current gives each motor ${cNumShort(each)} A, above its ${cNumShort(rc.rated)} A rating: it will overheat.`);
  }
  return out;
}

const cNumShort = (n: number) => String(Math.round(n * 1000) / 1000);
