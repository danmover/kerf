// Klipper printer.cfg generator. Pins come from the board's port definitions
// (Klipper pin names in the catalog) and which device each port is cabled to
// in the design. Mechanics (rotation distances, travel) come from the parts.

import { catalogPart } from "../catalog";
import type { NetPin } from "../erc";
import type { CatalogPart, MachineComponent } from "../types";
import { type FwContext, type GenFile, cNum, setting } from "./common";

export interface KlipperResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
}

interface Link {
  port: NetPin;
  dev: NetPin;
}

const parseMcu = (s: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const kv of (s ?? "").split(",")) {
    const [k, v] = kv.split("=");
    if (k && v !== undefined) out[k.trim()] = v.trim();
    else if (k) out.pin = k.trim();
  }
  return out;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Klipper's kinematics names: a firmware setting must be one of these. */
const KINEMATICS = ["cartesian", "corexy", "corexz", "hybrid_corexy", "hybrid_corexz", "delta", "deltesian", "rotary_delta", "polar", "winch", "none"];

export function klipperConfig(c: FwContext): KlipperResult {
  const warnings: string[] = [];
  const board = c.board.name;
  const links: Link[] = [];
  for (const cab of c.nl.cables) {
    if (cab.a.comp === board) links.push({ port: cab.a, dev: cab.b });
    else if (cab.b.comp === board) links.push({ port: cab.b, dev: cab.a });
  }
  const pinTable: KlipperResult["pinTable"] = [];
  const devName = (l: Link) => `${l.dev.comp}${l.dev.mc.count > 1 ? `[${l.dev.index}]` : ""}`;
  const record = (signal: string, l: Link, pin: string) => pinTable.push({ signal, pin: `${board}.${l.port.pin.id} (${pin})`, wire: `${devName(l)}.${l.dev.pin.id}` });
  const ofPort = (kind: string) => links.filter((l) => l.port.pin.port === kind);
  const roleText = (mc: MachineComponent) => `${mc.name} ${mc.role ?? ""}`.toLowerCase();
  const compsOf = (kind: string) => c.m.components.filter((x) => catalogPart(x.catalogId)?.kind === kind);
  const specNum = (p: CatalogPart | undefined, k: string) => (p && typeof p.specs[k] === "number" ? (p.specs[k] as number) : undefined);

  // ---- axes from stepper ports ----
  const axisOf = (l: Link): string | undefined => {
    const id = l.port.pin.id.toUpperCase();
    if (/^X/.test(id)) return "x";
    if (/^Y/.test(id)) return "y";
    if (/^Z/.test(id)) return "z";
    if (/^E/.test(id)) return "extruder";
    const t = roleText(l.dev.mc);
    if (/extru/.test(t)) return "extruder";
    const m = t.match(/\b([xyz])\b/);
    return m?.[1];
  };
  const steppers = new Map<string, Link[]>();
  for (const l of ofPort("stepper4")) {
    const ax = axisOf(l);
    if (!ax) {
      warnings.push(`${devName(l)} is on ${board}.${l.port.pin.id} but Kerf cannot tell which axis it drives: give it role: "x", "y", "z" or "extruder".`);
      continue;
    }
    steppers.set(ax, [...(steppers.get(ax) ?? []), l]);
  }
  for (const ax of ["x", "y", "z", "extruder"]) if (!steppers.has(ax)) warnings.push(`No ${ax === "extruder" ? "extruder" : ax.toUpperCase()} stepper is cabled to ${board}: that section is left out.`);

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
  const rot: Record<string, { v: number; why: string; gear?: string }> = {};
  for (const ax of ["x", "y"]) {
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

  // ---- run currents ----
  const runCurrent = (ax: string, ls: Link[]) => {
    const motor = catalogPart(ls[0].dev.mc.catalogId);
    const rated = specNum(motor, "i_rated") ?? 1;
    const portMax = ls[0].port.pin.imax ?? 1.4;
    const parallel = new Set(ls.map((l) => parseMcu(l.port.pin.mcu).step)).size < ls.length;
    const share = ax === "extruder" ? 0.5 : 0.7;
    const want = setting(c.fw, `${ax === "extruder" ? "e" : ax}_run_current`, r2(Math.min(rated * share * (parallel ? ls.length : 1), portMax)));
    return { want, parallel, rated, portMax };
  };

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
  const fans = ofPort("fan2");
  const fanRole = (l: Link): "part" | "hotend" | "controller" => {
    const t = `${roleText(l.dev.mc)} ${l.dev.part.id}`;
    if (/part|blower|print/.test(t)) return "part";
    if (/hotend|heatsink|heat ?break/.test(t)) return "hotend";
    if (/controller|electronics|board|case/.test(t)) return "controller";
    const pl = (l.port.pin.label ?? "").toLowerCase();
    return pl.includes("part") ? "part" : pl.includes("hotend") ? "hotend" : "controller";
  };
  const endstops = ofPort("endstop3");
  const probe = ofPort("probe5")[0];
  const endstopFor = (ax: string) => endstops.find((l) => l.port.pin.id.toUpperCase().startsWith(ax.toUpperCase()));
  const probeX = setting(c.fw, "probe_x", -40);
  const probeY = setting(c.fw, "probe_y", -10);

  const L: string[] = [];
  const host = compsOf("host")[0];
  L.push(`# printer.cfg for "${c.designName}", generated by Kerf from the design's wiring.`);
  L.push(`# Board: ${board} (${c.boardPart.name})${host ? `, host: ${host.name} (${catalogPart(host.catalogId)?.name})` : ""}.`);
  L.push("# Pins come from the board's Klipper reference config; each section names the device it is cabled to.");
  L.push("# Values marked CALIBRATE are starting points: the README lists the commands that measure them.");
  L.push("");
  L.push("# If you use MainsailOS or KIAUH with Mainsail, keep this include:");
  L.push("[include mainsail.cfg]");
  L.push("");
  L.push("[mcu]");
  L.push("# Find yours with: ls /dev/serial/by-id/*");
  L.push("serial: /dev/serial/by-id/usb-Klipper_stm32g0b1xx_REPLACE_ME-if00");
  L.push("restart_method: command");
  L.push("");
  L.push("[printer]");
  // a text setting goes into the config as is, so only Klipper's own kinematics names are taken
  const kin = setting(c.fw, "kinematics", "cartesian");
  if (!KINEMATICS.includes(kin)) warnings.push(`kinematics "${kin}" is not one Klipper knows (${KINEMATICS.join(", ")}): using cartesian.`);
  L.push(`kinematics: ${KINEMATICS.includes(kin) ? kin : "cartesian"}`);
  L.push(`max_velocity: ${cNum(setting(c.fw, "max_velocity", 300))}`);
  L.push(`max_accel: ${cNum(setting(c.fw, "max_accel", 3000))}`);
  L.push("max_z_velocity: 5");
  L.push("max_z_accel: 100");
  L.push("square_corner_velocity: 5.0");
  L.push("");

  const tmc: string[] = [];
  for (const ax of ["x", "y", "z", "extruder"]) {
    const ls = steppers.get(ax);
    if (!ls?.length) continue;
    const pins = parseMcu(ls[0].port.pin.mcu);
    if (!pins.step) {
      warnings.push(`${board}.${ls[0].port.pin.id} has no Klipper pin names in the catalog.`);
      continue;
    }
    const sec = ax === "extruder" ? "extruder" : `stepper_${ax}`;
    L.push(`[${sec}]`);
    L.push(`# ${ls.map((l) => `${devName(l)} (${l.dev.part.name}) on ${board}.${l.port.pin.id}`).join("; ")}`);
    L.push(`step_pin: ${pins.step}`, `dir_pin: ${pins.dir}`, `enable_pin: ${pins.enable}`, "microsteps: 16");
    const r = rot[ax];
    L.push(`rotation_distance: ${cNum(r.v)}   # ${r.why}${ax === "extruder" ? " (CALIBRATE)" : ""}`);
    if (r.gear) L.push(`gear_ratio: ${r.gear}`);
    ls.forEach((l) => record(`${sec} motor`, l, `step ${pins.step}`));
    if (ax === "extruder") {
      L.push("nozzle_diameter: " + cNum(specNum(hotPart, "nozzle") ?? 0.4));
      L.push("filament_diameter: " + cNum(specNum(extruderPart, "filament") ?? specNum(hotPart, "filament") ?? 1.75));
      L.push("max_extrude_only_distance: 100.0");
      if (hotHeater && hotTherm) {
        const hp = parseMcu(hotHeater.port.pin.mcu).pin;
        const tp = parseMcu(hotTherm.port.pin.mcu).pin;
        record("extruder heater", hotHeater, hp);
        record("extruder thermistor", hotTherm, tp);
        L.push(`heater_pin: ${hp}   # ${devName(hotHeater)} heater`);
        L.push(`sensor_type: ${(hotPart?.specs.klipper_sensor as string) ?? "EPCOS 100K B57560G104F"}   # check the thermistor your hotend shipped with`);
        L.push(`sensor_pin: ${tp}`);
        L.push("control: pid   # CALIBRATE: PID_CALIBRATE HEATER=extruder TARGET=210");
        L.push("pid_Kp: 21.527", "pid_Ki: 1.063", "pid_Kd: 108.982");
        const tmax = specNum(hotPart, "max_temp_c") ?? 260;
        L.push("min_temp: 0", `max_temp: ${cNum(Math.min(tmax - 10, 275))}`, "min_extrude_temp: 170");
        L.push("pressure_advance: 0.0   # CALIBRATE: Klipper's pressure advance tuning tower");
      } else warnings.push("The hotend heater and thermistor must both be cabled to the board for the [extruder] section.");
    } else {
      const max = size[ax as "x" | "y" | "z"];
      const es = endstopFor(ax);
      if (ax === "z" && probe) {
        L.push("endstop_pin: probe:z_virtual_endstop", "position_min: -2");
      } else if (es) {
        const p = parseMcu(es.port.pin.mcu).pin;
        record(`${sec} endstop`, es, p);
        L.push(`endstop_pin: ${p}   # ${devName(es)}`);
        L.push(`position_endstop: 0`);
      } else {
        warnings.push(`No ${ax.toUpperCase()} endstop is cabled to the board: add one or set up sensorless homing.`);
        L.push(`endstop_pin: ${ax === "z" ? "^PC2" : ax === "x" ? "^PC0" : "^PC1"}   # nothing is cabled here in the design`, "position_endstop: 0");
      }
      L.push(`position_max: ${cNum(max)}`);
      L.push(`homing_speed: ${ax === "z" ? 5 : 50}`);
      if (ax === "z") L.push("second_homing_speed: 3");
    }
    L.push("");
    if (pins.uart) {
      const rc = runCurrent(ax, ls);
      tmc.push(`[tmc2209 ${sec}]`);
      tmc.push(`uart_pin: ${pins.uart}`, `tx_pin: ${pins.tx}`, `uart_address: ${pins.addr}`);
      const each = rc.parallel ? r2(rc.want / ls.length) : rc.want;
      const pct = Math.round((each / rc.rated) * 100);
      tmc.push(`run_current: ${cNum(rc.want)}   # ${rc.parallel ? `${ls.length} motors in parallel share this driver, so each gets about ${cNum(each)} A (${pct} %) of their ${cNum(rc.rated)} A rating` : `${cNum(rc.rated)} A motor at ${pct} % of its rating${pct <= 85 ? ", which keeps it cool" : ""}`}`);
      if (rc.want > rc.portMax) warnings.push(`${sec} run_current ${rc.want} A is above what ${board}'s driver can give (${rc.portMax} A).`);
      if (each > rc.rated) warnings.push(`${sec} run_current gives each motor ${cNum(each)} A, above its ${cNum(rc.rated)} A rating: it will overheat.`);
      tmc.push(`stealthchop_threshold: ${ax === "extruder" ? 0 : 999999}`, "");
    }
  }
  L.push(...tmc);

  if (bedHeater && bedTherm) {
    const hp = parseMcu(bedHeater.port.pin.mcu).pin;
    const tp = parseMcu(bedTherm.port.pin.mcu).pin;
    record("bed heater", bedHeater, hp);
    record("bed thermistor", bedTherm, tp);
    L.push("[heater_bed]", `# ${devName(bedHeater)} (${bedPart?.name})`);
    L.push(`heater_pin: ${hp}`, `sensor_type: ${(bedPart?.specs.klipper_sensor as string) ?? "EPCOS 100K B57560G104F"}`, `sensor_pin: ${tp}`);
    L.push("control: pid   # CALIBRATE: PID_CALIBRATE HEATER=heater_bed TARGET=60", "pid_Kp: 54.027", "pid_Ki: 0.770", "pid_Kd: 948.182");
    L.push("min_temp: 0", `max_temp: ${cNum((specNum(bedPart, "max_temp_c") ?? 110) + 5)}`, "");
  } else if (bedHeater || bedTherm) warnings.push("The bed heater and its thermistor must both be cabled to the board.");

  for (const f of fans) {
    const p = parseMcu(f.port.pin.mcu).pin;
    const role = fanRole(f);
    record(`${role} fan`, f, p);
    if (role === "part") L.push("[fan]", `# ${devName(f)} (${f.dev.part.name}): part cooling`, `pin: ${p}`, "");
    else if (role === "hotend") L.push("[heater_fan hotend_fan]", `# ${devName(f)} (${f.dev.part.name}): must run whenever the hotend is warm`, `pin: ${p}`, "heater: extruder", "heater_temp: 50.0", "");
    else L.push("[controller_fan controller_fan]", `# ${devName(f)} (${f.dev.part.name}): cools the stepper drivers`, `pin: ${p}`, "");
  }
  if (!fans.some((f) => fanRole(f) === "hotend") && hotHeater) warnings.push("No hotend heatsink fan is cabled: an all-metal hotend jams (heat creep) without one.");

  if (probe) {
    const pp = parseMcu(probe.port.pin.mcu);
    record("probe", probe, `sensor ${pp.sensor}, control ${pp.control}`);
    L.push("[bltouch]", `# ${devName(probe)} (${probe.dev.part.name})`, `sensor_pin: ${pp.sensor}`, `control_pin: ${pp.control}`);
    L.push(`x_offset: ${cNum(probeX)}   # probe position relative to the nozzle, from the design's mount`, `y_offset: ${cNum(probeY)}`, "z_offset: 0   # CALIBRATE: PROBE_CALIBRATE, then SAVE_CONFIG", "");
    // Z homes on the probe, so put the probe (not the nozzle) over the middle of the bed
    const homeAt = (max: number, off: number) => r2(Math.min(max, Math.max(0, max / 2 - off)));
    L.push("[safe_z_home]", `home_xy_position: ${cNum(homeAt(size.x, probeX))}, ${cNum(homeAt(size.y, probeY))}   # nozzle position that puts the probe over the bed centre`, "speed: 80", "z_hop: 10", "z_hop_speed: 5", "");
    const lo = (off: number) => Math.max(0, off) + 10;
    const hi = (max: number, off: number) => Math.min(max, max + off) - 10;
    L.push("[bed_mesh]", "speed: 120", "horizontal_move_z: 5", `mesh_min: ${cNum(lo(probeX))}, ${cNum(lo(probeY))}`, `mesh_max: ${cNum(hi(size.x, probeX))}, ${cNum(hi(size.y, probeY))}`, "probe_count: 5, 5", "");
    if (c.m.components.some((x) => catalogPart(x.catalogId)?.kind === "lead_screw") && (steppers.get("z")?.length ?? 0) > 1) {
      L.push("# Two Z motors on one driver cannot level the gantry themselves: check it is square before each print, or give each Z motor its own driver and use [z_tilt].", "");
    }
  }

  L.push("[virtual_sdcard]", "path: ~/printer_data/gcodes", "", "[display_status]", "", "[pause_resume]", "", "[exclude_object]", "");
  L.push("[temperature_sensor mcu]", "sensor_type: temperature_mcu", "");
  if (host) L.push("[temperature_sensor host]", "sensor_type: temperature_host", "");
  L.push("# [input_shaper]  # CALIBRATE with an accelerometer or the ringing tower, then fill in:", "# shaper_freq_x: 0", "# shaper_freq_y: 0", "");
  L.push(`[gcode_macro START_PRINT]
# Slicer start G-code: START_PRINT BED_TEMP=[first_layer_bed_temperature] EXTRUDER_TEMP=[first_layer_temperature]
gcode:
    {% set bed = params.BED_TEMP|default(60)|float %}
    {% set hotend = params.EXTRUDER_TEMP|default(210)|float %}
    M140 S{bed}
    M104 S150
    G28
    M190 S{bed}
${probe ? "    BED_MESH_CALIBRATE\n" : ""}    M109 S{hotend}
    G92 E0
    G1 Z2 F600
    G1 X5 Y20 F6000
    G1 Z0.3 F600
    G1 Y180 E15 F1200   ; prime line
    G92 E0

[gcode_macro END_PRINT]
gcode:
    {% set z_park = [printer.toolhead.position.z + 10, printer.toolhead.axis_maximum.z]|min %}
    M400
    G92 E0
    G1 E-2 F1800
    G90
    G1 Z{z_park} F600
    G1 X0 Y${cNum(size.y)} F6000
    M104 S0
    M140 S0
    M106 S0
    M84
`);

  const readme = klipperReadme(c, warnings, pinTable, !!probe, host);
  const name = c.fw.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "klipper";
  return {
    files: [
      { path: `firmware/${name}/printer.cfg`, content: L.join("\n") },
      { path: `firmware/${name}/README.md`, content: readme },
    ],
    warnings,
    pinTable,
  };
}

function klipperReadme(c: FwContext, warnings: string[], pinTable: KlipperResult["pinTable"], probe: boolean, host?: MachineComponent): string {
  const L: string[] = [];
  L.push(`# ${c.fw.name}: Klipper for ${c.designName}`, "");
  L.push(`Klipper runs the motion planning on ${host ? `the ${catalogPart(host.catalogId)?.name}` : "a Raspberry Pi (or any Linux computer)"} and sends step timing to ${c.boardPart.name}. \`printer.cfg\` is generated from the design's wiring.`, "");
  if (warnings.length) {
    L.push("## Fix before printing", "");
    for (const w of warnings) L.push(`- ${w}`);
    L.push("");
  }
  L.push("## 1. Set up the host", "");
  L.push("1. Flash MainsailOS onto a 16 GB or larger micro SD card with Raspberry Pi Imager (Other specific-purpose OS → 3D printing → MainsailOS). Set the Wi-Fi and a password in the Imager settings.");
  L.push("2. Boot the Pi and open `http://mainsailos.local` (or its IP address) in a browser.", "");
  L.push("## 2. Build and flash the board firmware", "");
  if (c.boardPart.id.startsWith("skr_mini_e3")) {
    L.push("SSH into the Pi, then:", "", "```sh", "cd ~/klipper", "make menuconfig", "```", "");
    L.push("Choose: Enable extra low-level configuration options; Micro-controller: STMicroelectronics STM32; Processor model: STM32G0B1; Bootloader offset: 8KiB bootloader; Clock reference: 8 MHz crystal; Communication interface: USB (on PA11/PA12). Then:", "");
    L.push("```sh", "make clean && make", "```", "");
    L.push("Copy `~/klipper/out/klipper.bin` to a FAT32 micro SD card, rename it `firmware.bin`, put the card in the board and power it up. The file is renamed `FIRMWARE.CUR` when flashing worked.", "");
    L.push("BTT sells the board with an STM32G0B1 (most) or an older STM32G0B0: check the chip and pick G0B0 in menuconfig if that is what you have. With a G0B0, use serial on PA9/PA10 instead of USB.", "");
  } else {
    L.push("Follow Klipper's installation guide for this board (klipper3d.org → Installation).", "");
  }
  L.push("## 3. Install the config", "");
  L.push("1. Plug the board into the Pi by USB and run `ls /dev/serial/by-id/*`. Paste that path into `serial:` under `[mcu]`.");
  L.push("2. Upload `printer.cfg` in Mainsail (Machine → Config files) and restart.", "");
  L.push("## 4. First checks, in order", "");
  const steps = [
    "`STEPPER_BUZZ STEPPER=stepper_x` (and y, z, extruder): each motor should move back and forth 1 mm. If an axis moves the wrong way when homing, add or remove `!` on its dir_pin.",
    "`QUERY_ENDSTOPS` with each switch released and then pressed: it should change from open to TRIGGERED.",
    ...(probe ? ["`BLTOUCH_DEBUG COMMAND=pin_down` then `pin_up`; then `G28` with a hand ready on the power switch."] : ["`G28` with a hand ready on the power switch."]),
    "`PID_CALIBRATE HEATER=extruder TARGET=210`, then `PID_CALIBRATE HEATER=heater_bed TARGET=60`, then `SAVE_CONFIG`.",
    ...(probe ? ["`PROBE_CALIBRATE` with a sheet of paper under the nozzle, `ACCEPT`, `SAVE_CONFIG`. Then `BED_MESH_CALIBRATE`."] : []),
    "Extruder: heat to 210 °C, mark the filament 120 mm above the extruder, extrude 100 mm (`G91`, `G1 E100 F60`). new rotation_distance = old × (measured ÷ 100).",
    "Set the slicer's start G-code to `START_PRINT BED_TEMP=[first_layer_bed_temperature] EXTRUDER_TEMP=[first_layer_temperature]` and end G-code to `END_PRINT`.",
    "Print a 20 mm calibration cube and measure it: X and Y should be within 0.1 mm.",
  ];
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push("");
  L.push("## Pins", "", "| Signal | Board pin | Device |", "|---|---|---|");
  for (const p of pinTable) L.push(`| ${p.signal} | ${p.pin} | ${p.wire} |`);
  L.push("");
  L.push("## What is checked and what is not", "");
  L.push("- The pin names match BIGTREETECH's and Klipper's reference config for this board, and every port in the config is cabled in the design.");
  L.push("- PID values, probe Z offset, extruder rotation distance and input shaping are starting values: the steps above measure them on your machine.");
  return L.join("\n") + "\n";
}
