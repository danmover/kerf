// The numbers a scenario run produces, by name, with their units: what an
// `expect` line can read, how the results table shows them, and the list
// Claude is given. Values are in the design language's base units (mm, s,
// degrees, V, A, mAh, °C), and shares are fractions so `battery_left > 30%`
// reads as it is written.

import { fmtNum } from "../lang/values";

export type ResultUnit = "mm" | "mm/s" | "s" | "deg" | "share" | "V" | "A" | "mAh" | "C" | "bytes" | "N" | "count" | "turns" | "yes/no" | "text" | "W" | "Wh" | "mm3/s" | "g";

export interface ResultInfo {
  unit: ResultUnit;
  doc: string;
}

/** Every run, whatever the world. `<motor>` and `<actuator>` stand for component names. */
export const COMMON_RESULTS: Record<string, ResultInfo> = {
  time: { unit: "s", doc: "simulated time when the run ended" },
  stopped: { unit: "text", doc: 'why the run ended: "the job is done", "everything stopped", "duration" or a firmware stop' },
  state: { unit: "text", doc: 'the firmware\'s last "state: …" line on the serial console' },
  faults: { unit: "count", doc: "firmware mistakes the virtual chip caught (a pin used the wrong way, writing past an array)" },
  ram: { unit: "bytes", doc: "RAM used: globals plus the deepest stack" },
  ram_use: { unit: "share", doc: "RAM used as a share of the chip's RAM" },
  loop_time: { unit: "s", doc: "longest single pass of loop()" },
  battery_left: { unit: "share", doc: "battery charge left at the end" },
  battery_min_volts: { unit: "V", doc: "lowest battery voltage under load" },
  battery_used: { unit: "mAh", doc: "charge drawn from the battery" },
  battery_peak_amps: { unit: "A", doc: "highest battery current" },
  "<motor>.peak_amps": { unit: "A", doc: "highest motor current" },
  "<motor>.max_temp": { unit: "C", doc: "hottest the motor winding got" },
  "<motor>.load": { unit: "share", doc: "highest one-second average torque as a share of the motor's stall torque" },
  "<actuator>.travel": { unit: "mm", doc: "total rod travel of a linear actuator" },
  "<motor>.stall_time": { unit: "s", doc: "time the motor was driven hard with its shaft not turning (held in a stall)" },
  fuse_blown: { unit: "yes/no", doc: "a fuse blew during the run" },
  driver_overheated: { unit: "yes/no", doc: "a motor driver shut down for overheating at some point" },
  still_at_end: { unit: "yes/no", doc: "every motor and actuator was stopped and drawing no current at the end" },
  fault_time: { unit: "s", doc: "when the first fault happened (only in runs with faults:)" },
  fault_stopped: { unit: "yes/no", doc: "everything came to a stop after the fault and stayed stopped (only with faults:)" },
  fault_stop_time: { unit: "s", doc: "how long after the fault everything stopped for good (only when it did)" },
  fault_noticed: { unit: "yes/no", doc: "the firmware said something about it after the fault: a state change or a warning on the console (only with faults:)" },
  fault_reaction: { unit: "s", doc: "how long after the fault the firmware first said so (only when it did)" },
  "fw.<name>": { unit: "count", doc: "a firmware global variable at the end of the run" },
};

export const WORLD_RESULTS: Record<string, Record<string, ResultInfo>> = {
  sand_pit: {
    reached: { unit: "yes/no", doc: "the nose reached the far wall" },
    through: { unit: "yes/no", doc: "it broke through the far wall's opening (needs exit: on the pit)" },
    out: { unit: "yes/no", doc: "the front screw came all the way out of the far side" },
    progress: { unit: "mm", doc: "how far the nose moved towards the far wall" },
    remaining: { unit: "mm", doc: "distance from the nose to the far wall at the end (0 when reached)" },
    offset: { unit: "mm", doc: "how far off the straight line the nose is at the end of the run" },
    miss: { unit: "mm", doc: "how far off the straight line the nose arrived at the far wall (only when it got there)" },
    miss_side: { unit: "mm", doc: "sideways part of miss (+ is left)" },
    miss_height: { unit: "mm", doc: "height part of miss (+ is up)" },
    heading_max: { unit: "deg", doc: "largest heading error on the way" },
    heading_end: { unit: "deg", doc: "heading at the end (+ is turned left)" },
    roll_max: { unit: "deg", doc: "largest roll of the rear body" },
    pitch_max: { unit: "deg", doc: "largest pitch" },
    speed: { unit: "mm/s", doc: "average speed while moving" },
    slip: { unit: "share", doc: "average screw slip in the sand (0 = no slip, like a nut on a thread)" },
    side_wall: { unit: "yes/no", doc: "it ran into a side wall" },
    floor: { unit: "yes/no", doc: "it ran along the floor" },
    stuck_time: { unit: "s", doc: "time spent stuck (the screws turning, nothing moving)" },
    time_to_wall: { unit: "s", doc: "when the nose reached the far wall (only when it did)" },
    time_out: { unit: "s", doc: "when the front screw came out of the far side (only when it did)" },
    push_peak: { unit: "N", doc: "the hardest the helper had to push the tail (only with push: on the pit)" },
    push_distance: { unit: "mm", doc: "how far the helper pushed it in (only with push: on the pit)" },
    "<motor>.thrust": { unit: "N", doc: "screw thrust at the end" },
  },
  bench: {
    "<motor>.turns": { unit: "turns", doc: "output shaft turns over the run" },
  },
  printer: {
    finished: { unit: "yes/no", doc: "the whole G-code ran without the firmware stopping it" },
    firmware: { unit: "text", doc: 'the firmware that ran it: "Klipper", "Marlin" or "RepRapFirmware"' },
    print_time: { unit: "s", doc: "from the first extruding move to the last" },
    heat_time: { unit: "s", doc: "time spent waiting for the hotend and bed to heat" },
    layer_shifts: { unit: "count", doc: "times a motor skipped steps (each one shifts every layer after it)" },
    max_shift: { unit: "mm", doc: "how far off the print ended up in X and Y from skipped steps" },
    under_extrusion: { unit: "share", doc: "share of the plastic asked for that the hotend could not melt or the extruder could not push" },
    flow_peak: { unit: "mm3/s", doc: "the most plastic the hotend melted, mm³/s" },
    speed_avg: { unit: "mm/s", doc: "average speed while extruding" },
    filament: { unit: "mm", doc: "filament used" },
    filament_g: { unit: "g", doc: "plastic used" },
    hotend_error: { unit: "C", doc: "furthest the hotend strayed from its target while printing" },
    hotend_overshoot: { unit: "C", doc: "how far the hotend went past its last target" },
    bed_error: { unit: "C", doc: "furthest the bed strayed from its target while printing" },
    first_layer_error: { unit: "mm", doc: "largest error in the first layer's gap to the bed (bed shape the mesh missed, probe offset)" },
    first_layer_mean: { unit: "mm", doc: "average first-layer gap error (+ too high)" },
    first_layer_squashed: { unit: "share", doc: "share of the first layer laid at under half its height (nozzle scraping)" },
    first_layer_loose: { unit: "share", doc: "share of the first layer laid at over 1.5 times its height (it may not stick)" },
    mesh_range: { unit: "mm", doc: "highest minus lowest point of the probed bed mesh" },
    psu_peak: { unit: "W", doc: "most power drawn from the supply" },
    energy: { unit: "Wh", doc: "energy used for the whole run" },
    firmware_errors: { unit: "count", doc: "errors the firmware reported" },
    unknown_commands: { unit: "count", doc: "different G-code commands the firmware does not know (it skips them)" },
    heater_fault: { unit: "text", doc: "the heater safety check that stopped the printer, if any" },
    pressure_advance: { unit: "count", doc: "pressure advance (or Marlin's K) in force at the end" },
    x_load: { unit: "share", doc: "peak torque the X motor needed as a share of what it had at that speed (over 100 % skips steps)" },
    y_load: { unit: "share", doc: "the same for Y" },
    z_load: { unit: "share", doc: "the same for Z" },
    extruder_load: { unit: "share", doc: "the same for the extruder motor (the melt pushes back near the hotend's flow limit)" },
    ringing: { unit: "mm", doc: "most the X or Y belt let the nozzle ring after a change of speed while printing (ghosting), from lib.belt" },
    ringing_hz: { unit: "count", doc: "lowest frequency the X or Y axis rings at on its belt, Hz (what an input shaper would tune to)" },
    belt_slack: { unit: "N", doc: "slackest the X or Y belt's slack side got at peak pull (below 0 it went slack)" },
  },
};

/** The info for a result name, matching `<motor>` style patterns. */
export function resultInfo(name: string, world?: string): ResultInfo | undefined {
  const tables = [...(world && Object.hasOwn(WORLD_RESULTS, world) ? [WORLD_RESULTS[world]] : []), COMMON_RESULTS];
  for (const t of tables) if (Object.hasOwn(t, name)) return t[name];
  const dot = name.indexOf(".");
  if (dot < 0) return undefined;
  const field = name.slice(dot + 1);
  if (name.startsWith("fw.")) return COMMON_RESULTS["fw.<name>"];
  for (const t of tables) {
    for (const [k, v] of Object.entries(t)) if (k.startsWith("<") && k.endsWith(`.${field}`)) return v;
  }
  return undefined;
}

/** A result value with its unit, for people. */
export function fmtResult(v: number | boolean | string | undefined, unit?: ResultUnit): string {
  if (v === undefined) return "not recorded";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return String(v);
  switch (unit) {
    case "share":
      return `${fmtNum(v * 100, Math.abs(v) < 0.1 ? 1 : 0)} %`;
    case "s":
      return Math.abs(v) < 1 && v !== 0 ? `${fmtNum(v * 1000, 2)} ms` : v >= 120 ? `${fmtNum(v / 60, 1)} min` : `${fmtNum(v, 1)} s`;
    case "deg":
      return `${fmtNum(v, 1)}°`;
    case "C":
      return `${fmtNum(v, 0)} °C`;
    case "V":
      return `${fmtNum(v, 2)} V`;
    case "A":
      return `${fmtNum(v, 2)} A`;
    case "mAh":
      return `${fmtNum(v, 0)} mAh`;
    case "mm":
      // a first layer's gap is hundredths of a millimetre; a tunnel's progress is hundreds
      return `${fmtNum(v, Math.abs(v) < 1 && v !== 0 ? 3 : Math.abs(v) < 10 ? 1 : 0)} mm`;
    case "mm/s":
      return `${fmtNum(v, 2)} mm/s`;
    case "bytes":
      return `${fmtNum(v, 0)} bytes`;
    case "N":
      return `${fmtNum(v, 0)} N`;
    case "turns":
      return `${fmtNum(v, 1)} turns`;
    case "W":
      return `${fmtNum(v, 0)} W`;
    case "Wh":
      return `${fmtNum(v, 1)} Wh`;
    case "mm3/s":
      return `${fmtNum(v, 1)} mm³/s`;
    case "g":
      return `${fmtNum(v, 1)} g`;
    case "yes/no":
      return v ? "yes" : "no";
    default:
      return fmtNum(v, 3);
  }
}

/** The result names a world gives, for Claude and the editor's help. */
export function resultDocs(world?: string): string {
  const line = (k: string, i: ResultInfo) => `  ${k} (${i.unit}): ${i.doc}`;
  const out: string[] = [];
  for (const [w, t] of Object.entries(WORLD_RESULTS)) {
    if (world && w !== world) continue;
    out.push(`${w}:`, ...Object.entries(t).map(([k, i]) => line(k, i)));
  }
  out.push("every run:", ...Object.entries(COMMON_RESULTS).map(([k, i]) => line(k, i)));
  return out.join("\n");
}
