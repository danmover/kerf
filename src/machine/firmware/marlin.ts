// Marlin 2.1.2.x Configuration.h and Configuration_adv.h generator. Marlin takes
// its pins from the pins file for the MOTHERBOARD define, so these files only
// choose features and numbers: every device must be cabled to the board's
// standard port for it, and Kerf warns when one is not. Define names, units and
// defaults follow Marlin 2.1.2.9's own Configuration.h / Configuration_adv.h and
// BIGTREETECH's example config for the SKR Mini E3 V3.0
// (MarlinFirmware/Configurations, config/examples/Creality/Ender-3/BigTreeTech SKR Mini E3 3.0).

import type { PinDef } from "../types";
import { type FwContext, type GenFile, cComment, cNum, cString, setting } from "./common";
import { type Link, type PrinterAxis, PID_START, boardSupplyV, devName, endstopFor, parseMcu, printerChecks, printerFacts, r2, roleAxis, stepsPerMm, thermistorFor } from "./printer";

export interface MarlinResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
}

/** The configuration file version Marlin 2.1.2.6 to 2.1.2.9 expect (2.1.2.6 renamed DEFAULT_Kp to DEFAULT_KP). */
const CONFIG_VERSION = "02010206";
const MARLIN_RELEASE = "2.1.2.9";

const AXIS_NAME: Record<PrinterAxis, string> = { x: "X", y: "Y", z: "Z", extruder: "E0" };

/**
 * What Marlin's pins file drives from a board port, read from the port's name on BTT-style boards
 * (XM, ZAM, E0M, HE0, HB, TH0, THB, FAN1, XSTOP, PROBE). Undefined: Marlin has no standard use for it.
 */
export function marlinRole(pin: PinDef): string | undefined {
  const id = pin.id.toUpperCase();
  switch (pin.port) {
    case "stepper4":
      return /^[XYZ]/.test(id) ? id[0] : /^E(\d?)/.test(id) ? `E${/^E(\d)/.exec(id)?.[1] ?? "0"}` : undefined;
    case "heater2":
      return /^HE(\d)/.test(id) ? `HEATER_${/^HE(\d)/.exec(id)![1]}` : /^H(B|BED)/.test(id) ? "HEATER_BED" : undefined;
    case "therm2":
      return /^TH(\d)/.test(id) ? `TEMP_${/^TH(\d)/.exec(id)![1]}` : /^(THB|TB)/.test(id) ? "TEMP_BED" : undefined;
    case "fan2":
      return /^FAN(\d)/.test(id) ? `FAN${/^FAN(\d)/.exec(id)![1]}` : undefined;
    case "endstop3":
      return /^[XYZ]/.test(id) ? `${id[0]}_STOP` : undefined;
    case "probe5":
      return "PROBE";
  }
  return undefined;
}

/** A pin name without Klipper's pull-up (^) and invert (!) marks. */
const bare = (p: string | undefined) => (p ?? "").replace(/[\^!~]/g, "");

/** Marlin's "//====" banner and @section tag, as its own config files group their settings. */
function banner(L: string[], title: string, section: string) {
  const inner = ` ${title} `;
  const left = Math.floor((75 - inner.length) / 2);
  L.push("", `//${"=".repeat(75)}`, `//${"=".repeat(left)}${inner}${"=".repeat(75 - left - inner.length)}`, `//${"=".repeat(75)}`, `// @section ${section}`, "");
}

export function marlinConfig(c: FwContext): MarlinResult {
  const f = printerFacts(c);
  const { board, steppers, size, hotHeater, hotTherm, bedHeater, bedTherm, hotPart, bedPart, probe, probeX, probeY } = f;
  const warnings = f.warnings;
  const pinTable: MarlinResult["pinTable"] = [];
  const record = (signal: string, l: Link, pin: string) => pinTable.push({ signal, pin: `${board}.${l.port.pin.id} (${pin})`, wire: `${devName(l)}.${l.dev.pin.id}` });
  const specs = c.boardPart.specs;
  const motherboard = typeof specs.marlin_board === "string" ? specs.marlin_board : "";
  if (!motherboard) warnings.push(`${c.boardPart.name} has no Marlin MOTHERBOARD name in Kerf's catalog: set MOTHERBOARD in Configuration.h by hand.`);
  const driver = typeof specs.driver === "string" ? specs.driver : "TMC2209";
  const tmc = /^TMC/i.test(driver);

  // ---- every device on the port Marlin's pins file expects ----
  /** The board port Marlin uses for a role, for messages ("HE0"). */
  const portFor = (kind: string, role: string) => c.boardPart.pins.find((p) => p.port === kind && marlinRole(p) === role)?.id ?? role;
  const expect = (l: Link | undefined, role: string, what: string) => {
    if (!l || marlinRole(l.port.pin) === role) return;
    warnings.push(`${devName(l)} (${what}) is on ${board}.${l.port.pin.id}, but Marlin drives the ${what} from ${board}.${portFor(l.port.pin.port ?? "", role)}: move it there, or Marlin will not use it.`);
  };
  for (const [ax, ls] of steppers) {
    for (const l of ls) {
      const role = marlinRole(l.port.pin);
      const said = roleAxis(l);
      if (!role) warnings.push(`${devName(l)} is on ${board}.${l.port.pin.id}, which Marlin's pins file for this board does not use as a motor port.`);
      else if (said && said !== ax) warnings.push(`${devName(l)} (role ${said === "extruder" ? "extruder" : said.toUpperCase()}) is on ${board}.${l.port.pin.id}, which Marlin drives as the ${role} motor: move it to ${board}.${portFor("stepper4", AXIS_NAME[said])}.`);
    }
  }
  expect(hotHeater, "HEATER_0", "hotend heater");
  expect(hotTherm, "TEMP_0", "hotend thermistor");
  expect(bedHeater, "HEATER_BED", "bed heater");
  expect(bedTherm, "TEMP_BED", "bed thermistor");
  const fanOf = (role: string) => f.fans.find((x) => x.role === role)?.link;
  expect(fanOf("part"), "FAN0", "part cooling fan");
  for (const x of f.fans) {
    if (x.role !== "part" && marlinRole(x.link.port.pin) === "FAN0") warnings.push(`${devName(x.link)} (${x.role === "hotend" ? "hotend" : "controller"} fan) is on ${board}.${x.link.port.pin.id}, which Marlin keeps for the part cooling fan (M106): move it to another fan port.`);
  }
  for (const ax of ["x", "y", "z"] as const) {
    const es = endstopFor(f, ax);
    const said = es && roleAxis(es);
    if (es && said && said !== ax) warnings.push(`${devName(es)} (role ${said.toUpperCase()} endstop) is on ${board}.${es.port.pin.id}, which Marlin reads as the ${ax.toUpperCase()} endstop.`);
    else if (es && marlinRole(es.port.pin) !== `${ax.toUpperCase()}_STOP`) expect(es, `${ax.toUpperCase()}_STOP`, `${ax.toUpperCase()} endstop`);
  }
  warnings.push(...printerChecks(f, (ax) => `${AXIS_NAME[ax]}_CURRENT`));
  const hotT = thermistorFor(hotPart);
  const bedT = thermistorFor(bedPart);
  for (const t of [hotT, ...(bedHeater ? [bedT] : [])]) if (!t.known) warnings.push(`Kerf has no Marlin sensor number for the "${t.name}" thermistor: it is set to 1 (EPCOS 100k). Check it against the list in Marlin's Configuration.h.`);

  // ---- the numbers ----
  const steps = (ax: PrinterAxis) => cNum(r2(stepsPerMm(f, ax)));
  const maxV = setting(c.fw, "max_velocity", 300);
  const maxA = setting(c.fw, "max_accel", 3000);
  const classic = c.fw.settings.jerk !== undefined;
  const jerk = setting(c.fw, "jerk", 10);
  const jd = setting(c.fw, "junction_deviation", 0.013);
  const k = setting(c.fw, "pressure_advance", 0);
  const hotMax = Math.min(f.hotMax - 10, 275);
  const bedMax = f.bedMax + 5;
  const pinOf = (l: Link | undefined) => (l ? parseMcu(l.port.pin.mcu) : {});
  const inverted = (l: Link | undefined) => (pinOf(l).pin ?? "").includes("!");
  const dirInverted = (ax: PrinterAxis) => (pinOf(steppers.get(ax)?.[0]).dir ?? "").startsWith("!");
  // Z homes on the probe: put the probe (Marlin moves the nozzle by the offset) over the middle of the bed
  const homeAt = (max: number, off: number) => r2(Math.min(max, Math.max(0, max / 2 - off)) + off);
  const zSwitch = endstopFor(f, "z");
  const kin = setting(c.fw, "kinematics", "cartesian");
  if (kin !== "cartesian" && kin !== "corexy") warnings.push(`kinematics "${kin}": Kerf writes Marlin configs for cartesian and corexy printers only, so Configuration.h is cartesian. Enable the right one (COREXZ, DELTA...) by hand.`);

  // ---- Configuration.h ----
  const H: string[] = [];
  const def = (name: string, value: string | number | boolean = "", note = "") => H.push(`${`#define ${name}${value === "" ? "" : ` ${value}`}`.padEnd(note ? 44 : 0)}${note ? ` // ${note}` : ""}`.trimEnd());
  H.push(`// Configuration.h for "${cComment(c.designName)}", generated by Kerf from the design's wiring.`);
  H.push(`// Board: ${cComment(board)} (${c.boardPart.name}). For Marlin ${MARLIN_RELEASE} (any 2.1.2.x from 2.1.2.6 on).`);
  H.push("// Only the settings this printer needs are here; Marlin uses its own defaults for the rest.");
  H.push("// Pins come from Marlin's pins file for the MOTHERBOARD below, so each device must be on its standard port.");
  H.push("// Values marked CALIBRATE are starting points: the README lists the commands that measure them.");
  H.push("#pragma once", "");
  def("CONFIGURATION_H_VERSION", CONFIG_VERSION);

  banner(H, "Info", "info");
  def("STRING_CONFIG_H_AUTHOR", '"(Kerf)"', "Who made the changes");
  def("SHOW_BOOTSCREEN");
  H.push("#ifndef MOTHERBOARD");
  H.push(`  #define MOTHERBOARD ${motherboard || "BOARD_REPLACE_ME"}`);
  H.push("#endif");
  def("SERIAL_PORT", 2, "the UART header, as BTT's example config");
  def("BAUDRATE", 115200);
  def("SERIAL_PORT_2", -1, "USB: a host (OctoPrint, Pronterface) connects here");
  def("CUSTOM_MACHINE_NAME", `"${cString(c.designName)}"`);

  if (kin === "corexy") {
    banner(H, "Machine", "machine");
    def("COREXY", "", "the firmware block's kinematics");
  }

  banner(H, "Stepper drivers", "stepper drivers");
  for (const ax of ["x", "y", "z", "extruder"] as const) def(`${AXIS_NAME[ax]}_DRIVER_TYPE`, driver);

  banner(H, "Extruder", "extruder");
  def("EXTRUDERS", 1);
  def("DEFAULT_NOMINAL_FILAMENT_DIA", cNum(f.filament));

  banner(H, "Thermal Settings", "temperature");
  def("TEMP_SENSOR_0", hotT.marlin, `${hotT.name} (hotend)`);
  def("TEMP_SENSOR_BED", bedHeater ? bedT.marlin : 0, bedHeater ? `${bedT.name} (bed)` : "no heated bed");
  def("TEMP_RESIDENCY_TIME", 10, "(s) wait for the hotend to settle in M109");
  def("TEMP_WINDOW", 1, "(°C)");
  def("TEMP_HYSTERESIS", 3, "(°C)");
  def("TEMP_BED_RESIDENCY_TIME", 10, "(s) wait for the bed to settle in M190");
  def("TEMP_BED_WINDOW", 1, "(°C)");
  def("TEMP_BED_HYSTERESIS", 3, "(°C)");
  def("HEATER_0_MINTEMP", 5, "(°C) below this the thermistor is broken or unplugged");
  def("BED_MINTEMP", 5);
  def("HEATER_0_MAXTEMP", cNum(hotMax), `(°C) shut down above this; ${hotPart?.name ?? "the hotend"} is rated ${cNum(f.hotMax)} °C`);
  def("BED_MAXTEMP", cNum(bedMax), `(°C) ${bedPart?.name ?? "the bed"} is rated ${cNum(f.bedMax)} °C`);
  def("HOTEND_OVERSHOOT", 15, "(°C) targets stop this far below MAXTEMP");
  def("BED_OVERSHOOT", 10);
  H.push("");
  def("PIDTEMP");
  def("PID_MAX", 255);
  def("PID_K1", 0.95);
  def("DEFAULT_KP", PID_START.hotend.kp, "CALIBRATE: M303 E0 S210 C8, then M500");
  def("DEFAULT_KI", PID_START.hotend.ki);
  def("DEFAULT_KD", PID_START.hotend.kd);
  if (bedHeater) {
    def("PIDTEMPBED");
    def("MAX_BED_POWER", 255);
    def("DEFAULT_BED_KP", PID_START.bed.kp, "CALIBRATE: M303 E-1 S60 C8, then M500");
    def("DEFAULT_BED_KI", PID_START.bed.ki);
    def("DEFAULT_BED_KD", PID_START.bed.kd);
  }
  def("PID_FUNCTIONAL_RANGE", 10, "(°C) full power until this close to the target");
  H.push("");
  def("PREVENT_COLD_EXTRUSION");
  def("EXTRUDE_MINTEMP", 170);
  def("PREVENT_LENGTHY_EXTRUDE");
  def("EXTRUDE_MAXLENGTH", 200);
  def("THERMAL_PROTECTION_HOTENDS", "", "stop if the hotend cannot hold its temperature (Configuration_adv.h)");
  if (bedHeater) def("THERMAL_PROTECTION_BED");

  banner(H, "Endstop Settings", "endstops");
  const xs = endstopFor(f, "x");
  const ys = endstopFor(f, "y");
  def("USE_XMIN_PLUG", "", xs ? `${devName(xs)} on ${board}.${xs.port.pin.id}` : "nothing is cabled here in the design");
  def("USE_YMIN_PLUG", "", ys ? `${devName(ys)} on ${board}.${ys.port.pin.id}` : "nothing is cabled here in the design");
  if (zSwitch || !probe) def("USE_ZMIN_PLUG", "", zSwitch ? `${devName(zSwitch)} on ${board}.${zSwitch.port.pin.id}` : "nothing is cabled here in the design");
  else H.push("// No Z switch: Z homes on the probe (USE_PROBE_FOR_Z_HOMING below).");
  def("ENDSTOPPULLUPS", "", "the switches and the BLTouch need the pull-ups");
  def("X_MIN_ENDSTOP_INVERTING", inverted(xs), "false: a switch reads high when pressed");
  def("Y_MIN_ENDSTOP_INVERTING", inverted(ys));
  def("Z_MIN_ENDSTOP_INVERTING", inverted(zSwitch));
  def("X_MAX_ENDSTOP_INVERTING", false);
  def("Y_MAX_ENDSTOP_INVERTING", false);
  def("Z_MAX_ENDSTOP_INVERTING", false);
  def("Z_MIN_PROBE_ENDSTOP_INVERTING", false, "a BLTouch needs false");
  def("ENDSTOP_INTERRUPTS_FEATURE");

  banner(H, "Movement Settings", "motion");
  def("DEFAULT_AXIS_STEPS_PER_UNIT", `{ ${(["x", "y", "z", "extruder"] as const).map(steps).join(", ")} }`, "16 microsteps; E CALIBRATE: extrude 100 mm");
  H.push(`// steps/mm: X ${f.rot.x.why}; Y ${f.rot.y.why}; Z ${f.rot.z.why}.`.replace(/[^\x20-\x7e°×·]/g, " "));
  H.push(`// E: ${f.rot.extruder.v} mm per turn of the drive gear${f.rot.extruder.gear ? `, ${f.rot.extruder.gear} gearing` : ""}.`);
  def("DEFAULT_MAX_FEEDRATE", `{ ${cNum(maxV)}, ${cNum(maxV)}, 5, 60 }`, "(mm/s) X, Y from the firmware block");
  def("DEFAULT_MAX_ACCELERATION", `{ ${cNum(maxA)}, ${cNum(maxA)}, 100, 5000 }`, "(mm/s²)");
  def("DEFAULT_ACCELERATION", cNum(maxA), "(mm/s²) printing moves");
  def("DEFAULT_RETRACT_ACCELERATION", cNum(maxA), "(mm/s²) retracts");
  def("DEFAULT_TRAVEL_ACCELERATION", cNum(maxA), "(mm/s²) travel moves");
  if (classic) {
    def("CLASSIC_JERK", "", "the firmware block sets jerk");
    def("DEFAULT_XJERK", cNum(jerk), "(mm/s)");
    def("DEFAULT_YJERK", cNum(jerk));
    def("DEFAULT_ZJERK", 0.3);
  }
  def("DEFAULT_EJERK", "5.0", "(mm/s) also used by linear advance");
  if (!classic) {
    def("JUNCTION_DEVIATION_MM", cNum(jd), "(mm) how far corners may round off: Marlin's default is 0.013");
    def("JD_HANDLE_SMALL_SEGMENTS");
  }
  H.push("// S_CURVE_ACCELERATION stays off (Marlin's default): linear advance works best without it.");

  if (probe) {
    banner(H, "Z Probe Options", "probes");
    def("BLTOUCH", "", `${devName(probe)} on ${board}.${probe.port.pin.id}: Z_MIN_PROBE_PIN and SERVO0_PIN`);
    def("USE_PROBE_FOR_Z_HOMING", "", "the probe has its own pin, so say it homes Z");
    def("NOZZLE_TO_PROBE_OFFSET", `{ ${cNum(probeX)}, ${cNum(probeY)}, 0 }`, "probe from the nozzle, from the design's mount; Z CALIBRATE: M851");
    def("PROBING_MARGIN", 10, "(mm) keep probe points this far inside the bed");
    def("XY_PROBE_FEEDRATE", "(133*60)");
    def("Z_PROBE_FEEDRATE_FAST", "(4*60)");
    def("Z_PROBE_FEEDRATE_SLOW", "(Z_PROBE_FEEDRATE_FAST / 2)");
    def("Z_CLEARANCE_DEPLOY_PROBE", 10, "(mm)");
    def("Z_CLEARANCE_BETWEEN_PROBES", 5, "(mm)");
    def("Z_CLEARANCE_MULTI_PROBE", 5, "(mm)");
    def("Z_PROBE_LOW_POINT", -2, "(mm) give up this far below the expected trigger point");
    def("Z_PROBE_OFFSET_RANGE_MIN", -20);
    def("Z_PROBE_OFFSET_RANGE_MAX", 20);
    def("Z_MIN_PROBE_REPEATABILITY_TEST", "", "M48 measures how repeatable the probe is");
  }

  banner(H, "Stepper enables and directions", "motion");
  for (const ax of ["X", "Y", "Z", "E"]) def(`${ax}_ENABLE_ON`, 0);
  for (const ax of ["x", "y", "z", "extruder"] as const) def(`INVERT_${AXIS_NAME[ax]}_DIR`, dirInverted(ax), ax === "x" ? "as the board's dir pins; flip one if that axis moves the wrong way" : "");

  banner(H, "Homing and travel limits", "homing");
  for (const ax of ["X", "Y", "Z"]) def(`${ax}_HOME_DIR`, -1, ax === "X" ? "every axis homes to its minimum" : "");
  def("X_BED_SIZE", cNum(size.x), "(mm) printable area");
  def("Y_BED_SIZE", cNum(size.y));
  def("X_MIN_POS", 0);
  def("Y_MIN_POS", 0);
  def("Z_MIN_POS", 0);
  def("X_MAX_POS", "X_BED_SIZE");
  def("Y_MAX_POS", "Y_BED_SIZE");
  def("Z_MAX_POS", cNum(size.z));
  def("MIN_SOFTWARE_ENDSTOPS");
  for (const ax of ["X", "Y", "Z"]) def(`MIN_SOFTWARE_ENDSTOP_${ax}`);
  def("MAX_SOFTWARE_ENDSTOPS");
  for (const ax of ["X", "Y", "Z"]) def(`MAX_SOFTWARE_ENDSTOP_${ax}`);

  if (probe) {
    banner(H, "Bed Leveling", "calibrate");
    const lo = (off: number) => Math.max(10, off);
    const hi = (max: number, off: number) => Math.min(max - 10, max + off);
    def("AUTO_BED_LEVELING_BILINEAR", "", "G29 probes a grid; M500 saves it");
    H.push(`// Marlin keeps the grid where the probe reaches: X ${cNum(lo(probeX))} to ${cNum(hi(size.x, probeX))}, Y ${cNum(lo(probeY))} to ${cNum(hi(size.y, probeY))} mm here.`);
    def("RESTORE_LEVELING_AFTER_G28", "", "G28 keeps the saved mesh on");
    def("ENABLE_LEVELING_FADE_HEIGHT");
    def("DEFAULT_LEVELING_FADE_HEIGHT", "10.0", "(mm) the correction fades out by this height");
    def("SEGMENT_LEVELED_MOVES");
    def("LEVELED_SEGMENT_LENGTH", "5.0", "(mm)");
    def("GRID_MAX_POINTS_X", 5, "a 5 × 5 grid");
    def("GRID_MAX_POINTS_Y", "GRID_MAX_POINTS_X");
    def("EXTRAPOLATE_BEYOND_GRID");
    H.push("");
    def("Z_SAFE_HOMING", "", "home Z with the probe over the middle of the bed");
    def("Z_SAFE_HOMING_X_POINT", cNum(homeAt(size.x, probeX)), `(mm) where the probe goes; the nozzle goes to ${cNum(r2(homeAt(size.x, probeX) - probeX))}`);
    def("Z_SAFE_HOMING_Y_POINT", cNum(homeAt(size.y, probeY)), `(mm) the nozzle goes to ${cNum(r2(homeAt(size.y, probeY) - probeY))}`);
  }
  def("HOMING_FEEDRATE_MM_M", "{ (50*60), (50*60), (4*60) }", "(mm/min)");
  def("VALIDATE_HOMING_ENDSTOPS");

  banner(H, "Additional Features", "eeprom");
  def("EEPROM_SETTINGS", "", "M500 saves tuned values, M501 loads them, M502 resets to this file");
  def("EEPROM_CHITCHAT");
  def("EEPROM_BOOT_SILENT");
  def("EEPROM_AUTO_INIT", "", "start from this file's values if the EEPROM is blank or old");
  def("HOST_KEEPALIVE_FEATURE");
  def("DEFAULT_KEEPALIVE_INTERVAL", 2, "(s)");
  def("BUSY_WHILE_HEATING");
  def("PRINTJOB_TIMER_AUTOSTART");
  def("SDSUPPORT", "", "the board's micro SD card slot");
  def("SOFT_PWM_SCALE", 0);
  H.push("");

  // ---- Configuration_adv.h ----
  const A: string[] = [];
  const adef = (name: string, value: string | number | boolean = "", note = "") => A.push(`${`#define ${name}${value === "" ? "" : ` ${value}`}`.padEnd(note ? 44 : 0)}${note ? ` // ${note}` : ""}`.trimEnd());
  A.push(`// Configuration_adv.h for "${cComment(c.designName)}", generated by Kerf from the design's wiring.`);
  A.push(`// For Marlin ${MARLIN_RELEASE} with the Configuration.h next to it.`);
  A.push("#pragma once", "");
  adef("CONFIGURATION_ADV_H_VERSION", CONFIG_VERSION);

  banner(A, "Thermal Settings", "temperature");
  adef("THERMAL_PROTECTION_PERIOD", 40, "(s) Marlin's defaults: halt if the hotend stays");
  adef("THERMAL_PROTECTION_HYSTERESIS", 4, "(°C) this far below target this long");
  adef("WATCH_TEMP_PERIOD", 40, "(s) heating must raise the temperature by");
  adef("WATCH_TEMP_INCREASE", 2, "(°C) this much in this time");
  if (bedHeater) {
    adef("THERMAL_PROTECTION_BED_PERIOD", 20, "(s)");
    adef("THERMAL_PROTECTION_BED_HYSTERESIS", 2, "(°C)");
    adef("WATCH_BED_TEMP_PERIOD", 60, "(s)");
    adef("WATCH_BED_TEMP_INCREASE", 2, "(°C)");
  }

  banner(A, "Fans", "fans");
  const hotFan = fanOf("hotend");
  const ctrlFan = fanOf("controller");
  const fanPin = (l: Link) => `${marlinRole(l.port.pin) ?? "FAN0"}_PIN`;
  const partFan = fanOf("part");
  if (partFan) {
    record("part fan", partFan, `FAN0_PIN ${bare(pinOf(partFan).pin)}`);
    A.push(`// Part cooling: ${cComment(devName(partFan))} on ${cComment(board)}.${partFan.port.pin.id} is Marlin's fan 0 (M106 / M107).`);
  }
  if (ctrlFan) {
    record("controller fan", ctrlFan, `${fanPin(ctrlFan)} ${bare(pinOf(ctrlFan).pin)}`);
    adef("USE_CONTROLLER_FAN", "", `${devName(ctrlFan)}: cools the stepper drivers`);
    adef("CONTROLLER_FAN_PIN", fanPin(ctrlFan), `${board}.${ctrlFan.port.pin.id}`);
    adef("CONTROLLERFAN_SPEED_MIN", 0);
    adef("CONTROLLERFAN_SPEED_ACTIVE", 255, "on while any motor is powered");
    adef("CONTROLLERFAN_SPEED_IDLE", 0);
    adef("CONTROLLERFAN_IDLE_TIME", 60, "(s) then off");
  }
  if (hotFan) {
    record("hotend fan", hotFan, `${fanPin(hotFan)} ${bare(pinOf(hotFan).pin)}`);
    adef("E0_AUTO_FAN_PIN", fanPin(hotFan), `${devName(hotFan)} on ${board}.${hotFan.port.pin.id}: on whenever the hotend is warm`);
    adef("EXTRUDER_AUTO_FAN_TEMPERATURE", 50, "(°C)");
    adef("EXTRUDER_AUTO_FAN_SPEED", 255);
  }

  banner(A, "Homing and motion", "homing");
  adef("HOMING_BUMP_MM", "{ 5, 5, 2 }", "(mm) back off and home again slowly");
  adef("HOMING_BUMP_DIVISOR", "{ 2, 2, 4 }");
  adef("AXIS_RELATIVE_MODES", "{ false, false, false, false }");
  for (const ax of ["X", "Y", "Z", "E"]) adef(`INVERT_${ax}_STEP_PIN`, false);
  adef("DEFAULT_STEPPER_TIMEOUT_SEC", 120, "(s) switch idle motors off");
  adef("DISABLE_IDLE_X");
  adef("DISABLE_IDLE_Y");
  adef("DISABLE_IDLE_E");
  A.push("// Z stays powered when idle: the gantry can slide down its lead screws when the Z motors switch off.");
  adef("DEFAULT_MINIMUMFEEDRATE", "0.0", "(mm/s)");
  adef("DEFAULT_MINTRAVELFEEDRATE", "0.0", "(mm/s)");
  adef("DEFAULT_MINSEGMENTTIME", 20000, "(µs)");
  adef("SLOWDOWN");
  adef("SLOWDOWN_DIVISOR", 2);
  adef("MINIMUM_PLANNER_SPEED", 0.05, "(mm/s)");
  adef("MIN_STEPS_PER_SEGMENT", 6);
  adef("USE_WATCHDOG");

  banner(A, "Linear advance", "extruder");
  adef("LIN_ADVANCE", "", "pressure control: M900 K sets it");
  adef("ADVANCE_K", cNum(k), "(mm per mm/s) CALIBRATE with Marlin's K-factor test; 0 is off");
  if (classic) adef("ALLOW_LOW_EJERK", "", "direct drive: keep DEFAULT_EJERK at 5 with classic jerk");

  banner(A, "G-code", "gcode");
  adef("ARC_SUPPORT", "", "G2/G3 arcs");
  adef("MIN_ARC_SEGMENT_MM", 0.1, "(mm)");
  adef("MAX_ARC_SEGMENT_MM", "1.0", "(mm)");
  adef("MIN_CIRCLE_SEGMENTS", 72);
  adef("N_ARC_CORRECTION", 25);
  adef("BLOCK_BUFFER_SIZE", 16, "moves the planner looks ahead (a power of 2)");
  adef("MAX_CMD_SIZE", 96);
  adef("BUFSIZE", 4, "commands buffered from the host");
  adef("TX_BUFFER_SIZE", 0);
  adef("SERIAL_OVERRUN_PROTECTION");
  adef("EMERGENCY_PARSER", "", "M112, M108 and M410 act at once, even while heating");
  adef("AUTO_REPORT_TEMPERATURES");
  adef("EXTENDED_CAPABILITIES_REPORT");
  adef("FASTER_GCODE_PARSER");

  banner(A, "SD card", "media");
  adef("SDCARD_CONNECTION", "ONBOARD");
  adef("SD_PROCEDURE_DEPTH", 1);
  adef("SD_FINISHED_STEPPERRELEASE", true);
  adef("SD_FINISHED_RELEASECOMMAND", '"M84XYE"', "keep Z powered after a print");
  adef("SDCARD_RATHERRECENTFIRST");
  adef("EVENT_GCODE_SD_ABORT", '"G28XY"');

  if (tmc) {
    banner(A, "TMC stepper drivers", "tmc/config");
    const rsense = typeof specs.driver_rsense === "number" ? specs.driver_rsense : 0.11;
    adef("HOLD_MULTIPLIER", 0.5, "hold current as a share of run current");
    adef("INTERPOLATE", true, "256 microstep interpolation");
    for (const ax of ["x", "y", "z", "extruder"] as const) {
      const n = AXIS_NAME[ax];
      const rc = f.current[ax];
      const ls = steppers.get(ax) ?? [];
      const mA = Math.round((rc?.want ?? 0.8) * 1000);
      const each = rc?.parallel ? r2(rc.want / ls.length) : rc?.want;
      A.push(
        rc
          ? `// ${n}: ${ls.map((l) => `${devName(l)} on ${board}.${l.port.pin.id}`).join(", ")}${rc.parallel ? `: ${ls.length} motors in parallel share this driver, about ${cNum(Math.round((each ?? 0) * 1000))} mA each` : ""} (${cNum(rc.rated)} A motor${ls.length > 1 ? "s" : ""}).`
          : `// ${n}: nothing is cabled to this driver in the design.`,
      );
      adef(`${n}_CURRENT`, mA, "(mA) RMS run current");
      if (ax !== "extruder") adef(`${n}_CURRENT_HOME`, `${n}_CURRENT`);
      adef(`${n}_MICROSTEPS`, 16);
      adef(`${n}_RSENSE`, rsense, "(ohm) the board's sense resistors");
      adef(`${n}_CHAIN_POS`, -1);
      adef(`${n}_HYBRID_THRESHOLD`, ax === "z" ? 3 : ax === "extruder" ? 30 : 100, "(mm/s) unused unless HYBRID_THRESHOLD is on");
    }
    adef("STEALTHCHOP_XY", "", "quiet stealthChop on X, Y and Z, as Klipper's config");
    adef("STEALTHCHOP_Z");
    A.push("// The extruder stays in spreadCycle: stealthChop can lose steps under linear advance.");
    const v = boardSupplyV(c) ?? 24;
    const chop = v > 30 ? 36 : v > 21 ? 24 : v > 15 ? 19 : 12;
    adef("CHOPPER_TIMING", `CHOPPER_DEFAULT_${chop}V`, `${cNum(v)} V supply`);
    adef("TMC_ADV()", "{ }");
  }
  A.push("");

  // the rest of the pin table: motors, heaters, thermistors, endstops, probe; then motors first, fans after the heaters
  for (const ax of ["x", "y", "z", "extruder"] as const) {
    const n = AXIS_NAME[ax];
    for (const l of steppers.get(ax) ?? []) {
      const p = pinOf(l);
      record(`${n} motor`, l, `${n}_STEP_PIN ${bare(p.step) || "?"}${p.addr !== undefined ? `, UART address ${p.addr}` : ""}`);
    }
  }
  if (hotHeater) record("hotend heater", hotHeater, `HEATER_0_PIN ${bare(pinOf(hotHeater).pin)}`);
  if (hotTherm) record("hotend thermistor", hotTherm, `TEMP_0_PIN ${bare(pinOf(hotTherm).pin)}`);
  if (bedHeater) record("bed heater", bedHeater, `HEATER_BED_PIN ${bare(pinOf(bedHeater).pin)}`);
  if (bedTherm) record("bed thermistor", bedTherm, `TEMP_BED_PIN ${bare(pinOf(bedTherm).pin)}`);
  for (const [ax, es] of [["X", xs], ["Y", ys], ["Z", zSwitch]] as const) if (es) record(`${ax} endstop`, es, `${ax}_STOP_PIN ${bare(pinOf(es).pin)}`);
  if (probe) {
    const pp = parseMcu(probe.port.pin.mcu);
    record("probe", probe, `Z_MIN_PROBE_PIN ${bare(pp.sensor)}, SERVO0_PIN ${bare(pp.control)}`);
  }

  const rank = (s: string) => (/motor$/.test(s) ? 0 : /heater|thermistor/.test(s) ? 1 : /fan$/.test(s) ? 2 : 3);
  pinTable.sort((a, b) => rank(a.signal) - rank(b.signal));
  const readme = marlinReadme(c, warnings, pinTable, !!probe);
  const name = c.fw.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "marlin";
  return {
    files: [
      { path: `firmware/${name}/Configuration.h`, content: H.join("\n") },
      { path: `firmware/${name}/Configuration_adv.h`, content: A.join("\n") },
      { path: `firmware/${name}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
  };
}

function marlinReadme(c: FwContext, warnings: string[], pinTable: MarlinResult["pinTable"], probe: boolean): string {
  const env = typeof c.boardPart.specs.marlin_env === "string" ? c.boardPart.specs.marlin_env : "";
  const L: string[] = [];
  L.push(`# ${c.fw.name}: Marlin for ${c.designName}`, "");
  L.push(`Marlin runs on the ${c.boardPart.name} by itself: no host computer is needed. \`Configuration.h\` and \`Configuration_adv.h\` are generated from the design's wiring.`, "");
  if (warnings.length) {
    L.push("## Fix before printing", "");
    for (const w of warnings) L.push(`- ${w}`);
    L.push("");
  }
  L.push("## 1. Get Marlin", "");
  L.push(`1. Download Marlin ${MARLIN_RELEASE} (or a later 2.1.2.x) from marlinfw.org (Download) or the MarlinFirmware/Marlin releases on GitHub, and unzip it.`);
  L.push("2. Replace `Marlin/Configuration.h` and `Marlin/Configuration_adv.h` with the two files from this folder.", "");
  L.push("## 2. Build it", "");
  L.push("1. Install VS Code, then the PlatformIO IDE and Auto Build Marlin extensions.");
  L.push(`2. Open the Marlin folder in VS Code. In the Auto Build Marlin panel, build the \`${env || "environment for your board"}\` environment.`);
  L.push(`3. The build writes \`.pio/build/${env || "<environment>"}/firmware.bin\`.`, "");
  L.push("## 3. Flash it", "");
  L.push("1. Copy `firmware.bin` to a FAT32 micro SD card, put the card in the board and power it up. The file is renamed `FIRMWARE.CUR` when flashing worked.");
  L.push("2. Connect the board by USB to a computer running Pronterface, OctoPrint or Repetier-Host. Send `M502` then `M500`, so the EEPROM holds this file's values and not old ones.", "");
  L.push("## 4. First checks, in order", "");
  const steps = [
    "`M115`: the reply names Marlin and its version.",
    "`M119` with each switch released and then pressed: it should change from open to TRIGGERED.",
    "Move each axis 10 mm with `G91` then `G1 X10 F600` (and Y, Z). If one moves the wrong way, flip its `INVERT_..._DIR` in Configuration.h and flash again.",
    ...(probe ? ["`M280 P0 S10` lowers the BLTouch pin and `M280 P0 S90` raises it. Then `G28` with a hand ready on the power switch."] : ["`G28` with a hand ready on the power switch."]),
    "`M303 E0 S210 C8` tunes the hotend, then `M500`. `M303 E-1 S60 C8` tunes the bed, then `M500`.",
    ...(probe
      ? [
          "Probe Z offset: `G28`, then `M211 S0` (allow moves below Z 0) and `G1 X110 Y110 F3000`. Lower the nozzle with `G1 Z-0.1` steps until it just grips a sheet of paper. `M114` shows Z: send `M851 Z<that Z>`, then `M211 S1` and `M500`.",
          "`M48` checks the probe repeats (standard deviation under 0.01 mm is good). Then `G29` probes the mesh and `M500` saves it. Add `M420 S1` after `G28` in the slicer's start G-code.",
        ]
      : []),
    "Extruder: heat to 210 °C, mark the filament 120 mm above the extruder, extrude 100 mm (`G91`, `G1 E100 F60`). new steps = old × 100 ÷ measured: `M92 E<new>` then `M500`.",
    "Linear advance: print Marlin's K-factor test pattern (marlinfw.org → Linear Advance), then `M900 K<best>` and `M500`.",
    "Print a 20 mm calibration cube and measure it: X and Y should be within 0.1 mm.",
  ];
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push("");
  L.push("## Pins", "", "| Signal | Board pin | Device |", "|---|---|---|");
  for (const p of pinTable) L.push(`| ${p.signal} | ${p.pin} | ${p.wire} |`);
  L.push("");
  L.push("## What is checked and what is not", "");
  L.push("- Marlin takes every pin from its pins file for the MOTHERBOARD in Configuration.h. Kerf checked that each device is cabled to the port that file uses for it, and lists any that are not above.");
  L.push(`- The define names, units and the file version follow Marlin ${MARLIN_RELEASE}'s own Configuration.h and Configuration_adv.h and BIGTREETECH's example config for this board.`);
  L.push("- Kerf has not compiled these files. If the build stops with an `#error` that names a missing setting, copy that `#define` from Marlin's own Configuration.h or Configuration_adv.h (same release) into the matching file here, and build again.");
  L.push("- PID values, the probe Z offset, extruder steps and linear advance K are starting values: the steps above measure them on your machine.");
  return L.join("\n") + "\n";
}

