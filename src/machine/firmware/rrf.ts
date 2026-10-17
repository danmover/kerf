// RepRapFirmware 3.5 config generator for Duet 3 boards (the Duet 3 Mini 5+).
// RepRapFirmware names every pin in config.g (M584 driver numbers, M950 ports,
// M574 / M558 inputs), so the files map whatever port each device is cabled to:
// unlike Marlin there is no standard port to keep to. Command forms and the
// order of config.g follow Duet3D's RepRapFirmware Configuration Tool (RRF 3.5)
// and the G-code dictionary; the BLTouch lines follow Duet3D's BLTouch guide.

import { type FwContext, type GenFile, cNum, setting } from "./common";
import { type Link, type PrinterAxis, devName, endstopFor, parseMcu, printerChecks, printerFacts, r2, stepsPerMm, thermistorFor } from "./printer";

export interface RrfResult {
  files: GenFile[];
  warnings: string[];
  pinTable: { signal: string; pin: string; wire: string }[];
}

const RRF_RELEASE = "3.5";
const LETTER: Record<PrinterAxis, string> = { x: "X", y: "Y", z: "Z", extruder: "E" };

/** A design name as an RRF machine name (M550: also the network host name), letters, digits and hyphens only. */
const hostName = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "kerf-printer";

/** Text for a `;` comment: a comment runs to the end of its line, so only line breaks matter (oneLine already removed them). */
const gComment = (s: string) => s;

export function rrfConfig(c: FwContext): RrfResult {
  const f = printerFacts(c);
  const { board, steppers, size, hotHeater, hotTherm, bedHeater, bedTherm, hotPart, bedPart, probe, probeX, probeY } = f;
  const warnings = f.warnings;
  const pinTable: RrfResult["pinTable"] = [];
  const record = (signal: string, l: Link, pin: string) => pinTable.push({ signal, pin: `${board}.${l.port.pin.id} (${pin})`, wire: `${devName(l)}.${l.dev.pin.id}` });
  const mcu = (l: Link | undefined) => (l ? parseMcu(l.port.pin.mcu) : {});
  /** The RRF port name of a single-pin port (out0, temp1, io5.in), or undefined when the catalog gives none. */
  const portName = (l: Link) => {
    const p = mcu(l).pin;
    if (!p || !/^[!^]*(out|temp|io)\d/.test(p)) {
      warnings.push(`${board}.${l.port.pin.id} has no RepRapFirmware port name in Kerf's catalog, so ${devName(l)} is left out of config.g.`);
      return undefined;
    }
    return p;
  };

  // ---- motors: one RRF driver number per board port ----
  const drivers: Partial<Record<PrinterAxis, string[]>> = {};
  for (const [ax, ls] of steppers) {
    const ids: string[] = [];
    for (const l of ls) {
      const d = mcu(l).driver;
      if (d === undefined || !/^\d+$/.test(d)) {
        warnings.push(`${board}.${l.port.pin.id} has no RepRapFirmware driver number in Kerf's catalog, so ${devName(l)} is left out of config.g.`);
        continue;
      }
      const id = `0.${d}`;
      if (!ids.includes(id)) ids.push(id);
      record(`${LETTER[ax]} motor`, l, `driver ${id}`);
    }
    if (ids.length) drivers[ax] = ids;
  }
  const axes = (["x", "y", "z", "extruder"] as const).filter((ax) => drivers[ax]);
  const kin = setting(c.fw, "kinematics", "cartesian");
  if (kin !== "cartesian" && kin !== "corexy") warnings.push(`kinematics "${kin}": Kerf writes RepRapFirmware configs for cartesian and corexy printers only, so config.g is cartesian. Set M669 by hand.`);
  warnings.push(...printerChecks(f, (ax) => `${LETTER[ax]} motor`));
  const hotT = thermistorFor(hotPart);
  const bedT = thermistorFor(bedPart);
  for (const t of [hotT, ...(bedHeater ? [bedT] : [])]) if (!t.known) warnings.push(`Kerf has no RepRapFirmware values for the "${t.name}" thermistor: M308 uses the EPCOS 100k's (B4613). Check them against the thermistor's datasheet.`);

  // ---- the numbers ----
  const per = (fn: (ax: PrinterAxis) => string) => axes.map((ax) => `${LETTER[ax]}${fn(ax)}`).join(" ");
  const maxV = setting(c.fw, "max_velocity", 300);
  const maxA = setting(c.fw, "max_accel", 3000);
  const jerk = setting(c.fw, "jerk", 15);
  const k = setting(c.fw, "pressure_advance", 0);
  const jerkOf: Record<PrinterAxis, number> = { x: jerk, y: jerk, z: 0.2, extruder: 2 };
  const speedOf: Record<PrinterAxis, number> = { x: maxV, y: maxV, z: 5, extruder: 60 };
  const accelOf: Record<PrinterAxis, number> = { x: maxA, y: maxA, z: 100, extruder: 5000 };
  // RRF sets the peak current (M906), the other generators the RMS current: peak = RMS × √2
  const peak = (ax: PrinterAxis) => Math.round(((f.current[ax]?.want ?? 0.8) * Math.SQRT2 * 1000) / 10) * 10;
  const hotMax = Math.min(f.hotMax - 10, 275);
  const bedMax = f.bedMax + 5;
  // Z homes on the probe: the nozzle position that puts the probe over the middle of the bed (as Klipper's safe_z_home)
  const homeAt = (max: number, off: number) => r2(Math.min(max, Math.max(0, max / 2 - off)));
  const lo = (off: number) => Math.max(0, off) + 10;
  const hi = (max: number, off: number) => Math.min(max, max + off) - 10;

  // ---- config.g ----
  const G: string[] = [];
  const cmd = (code: string, note = "") => G.push(note ? `${code.padEnd(36)} ; ${note}` : code);
  G.push(`; config.g for "${gComment(c.designName)}", generated by Kerf from the design's wiring.`);
  G.push(`; Board: ${gComment(board)} (${c.boardPart.name}). For RepRapFirmware ${RRF_RELEASE}.`);
  G.push("; RepRapFirmware runs this file at start-up. Values marked CALIBRATE are starting points: the README lists the commands that measure them.");
  G.push("", "; General");
  cmd("G90", "absolute coordinates");
  cmd("M83", "relative extruder moves");
  cmd(`M550 P"${hostName(c.designName)}"`, "machine name, also the network host name");
  G.push('; M911 S21 R23 P"M913 X0 Y0 G91 M83 G1 Z3 E-5 F1000" ; on a 24 V supply: save the print if the power fails');

  G.push("", "; Network");
  cmd("M552 S1", "Wi-Fi on (store the network first with M587); Ethernet boards: M552 P0.0.0.0 S1");
  cmd("M586 P0 S1", "web interface (Duet Web Control) over HTTP");

  if (kin === "corexy") G.push("", "; Kinematics", "M669 K1                              ; CoreXY");
  G.push("", "; Drivers");
  for (const ax of axes) {
    // RRF's own default is spreadCycle (D2); stealthChop (D3) is quieter on X, Y and Z, as the Klipper config
    for (const d of drivers[ax]!) cmd(`M569 P${d} S1 D${ax === "extruder" ? 2 : 3}`, `${LETTER[ax]}: S1 forwards (S0 reverses it), D${ax === "extruder" ? "2 spreadCycle" : "3 stealthChop"}`);
  }
  cmd(`M584 ${per((ax) => drivers[ax]!.join(":"))}`, "axis to driver mapping");
  if ((drivers.z?.length ?? 0) > 1) G.push("; Each Z motor has its own driver: M671 with the lead screw positions and G32 can level the gantry.");
  cmd(`M350 ${per(() => "16")} I1`, "16 microsteps, interpolated to 256");
  cmd(`M92 ${per((ax) => cNum(r2(stepsPerMm(f, ax))))}`, "steps/mm; E CALIBRATE: extrude 100 mm");
  G.push(`; steps/mm: X ${f.rot.x.why}; Y ${f.rot.y.why}; Z ${f.rot.z.why}; E ${cNum(f.rot.extruder.v)} mm per turn of the drive gear${f.rot.extruder.gear ? `, ${f.rot.extruder.gear} gearing` : ""}.`);
  cmd(`M566 ${per((ax) => cNum(r2(jerkOf[ax] * 60)))}`, `jerk (mm/min): ${cNum(jerk)} mm/s on X and Y; Z and E as the Duet config tool's defaults (0.2 and 2 mm/s)`);
  cmd(`M203 ${per((ax) => cNum(r2(speedOf[ax] * 60)))}`, "maximum speeds (mm/min)");
  cmd(`M201 ${per((ax) => cNum(accelOf[ax]))}`, "maximum accelerations (mm/s²)");
  cmd(`M204 P${cNum(maxA)} T${cNum(maxA)}`, "print and travel acceleration (mm/s²)");
  cmd(`M906 ${per((ax) => String(peak(ax)))} I30`, "peak motor currents (mA), 30 % when idle");
  G.push(`; RMS currents: ${axes.map((ax) => `${LETTER[ax]} ${cNum(f.current[ax]!.want)} A`).join(", ")}${f.current.z?.parallel ? " (the Z motors share one driver)" : ""}.`);
  cmd("M84 S30", "idle current after 30 s");

  G.push("", "; Axis limits and endstops");
  cmd(`M208 X0:${cNum(size.x)} Y0:${cNum(size.y)} Z0:${cNum(size.z)}`, "travel (mm)");
  const stops: Partial<Record<"x" | "y" | "z", string>> = {};
  for (const ax of ["x", "y", "z"] as const) {
    const es = endstopFor(f, ax);
    if (ax === "z" && probe && !es) {
      cmd("M574 Z1 S2", "Z homes on the probe");
      continue;
    }
    if (!es) continue;
    const p = portName(es);
    if (!p) continue;
    stops[ax] = p;
    record(`${ax.toUpperCase()} endstop`, es, p);
    cmd(`M574 ${ax.toUpperCase()}1 S1 P"${p}"`, `${ax.toUpperCase()} switch at the low end, active high`);
  }

  if (probe) {
    const pp = mcu(probe);
    const sensor = pp.sensor ?? "";
    const control = pp.control ?? "";
    if (!/^io\d\.in$/.test(sensor) || !/^io\d\.out$/.test(control)) warnings.push(`${board}.${probe.port.pin.id} has no RepRapFirmware pin names in Kerf's catalog: set the BLTouch's M950 and M558 pins by hand.`);
    record("probe", probe, `${sensor}, servo ${control}`);
    G.push("", "; Z probe (BLTouch)");
    cmd(`M950 S0 C"${control}"`, "servo 0 drives the BLTouch pin");
    cmd(`M558 P9 C"${sensor}" H5 F120 T6000`, "BLTouch: dive height 5 mm, probe at 2 mm/s, travel 100 mm/s");
    cmd(`G31 P25 X${cNum(probeX)} Y${cNum(probeY)} Z0`, "probe from the nozzle, from the design's mount; Z CALIBRATE (README)");
    cmd(`M557 X${cNum(lo(probeX))}:${cNum(hi(size.x, probeX))} Y${cNum(lo(probeY))}:${cNum(hi(size.y, probeY))} P5`, "5 × 5 mesh where the probe reaches");
  }

  G.push("", "; Heaters");
  const heaterLines = (h: number, heater: Link, therm: Link, t: ReturnType<typeof thermistorFor>, what: string, max: number, rated: number, part: string) => {
    const tp = portName(therm);
    const hp = portName(heater);
    if (!tp || !hp) return;
    record(`${what} thermistor`, therm, tp);
    record(`${what} heater`, heater, hp);
    cmd(`M308 S${h} P"${tp}" Y"thermistor" A"${what === "bed" ? "Bed" : "Hotend"}" T${t.rrf.t} B${t.rrf.b} C${t.rrf.c}`, `${t.name}`);
    cmd(`M950 H${h} C"${hp}" T${h}`, `heater ${h} on ${hp}, read by sensor ${h}`);
    if (what === "bed") cmd(`M140 H${h}`, "heater 0 is the bed");
    cmd(`M143 H${h} S${cNum(max)}`, `shut down above ${cNum(max)} °C: ${part} is rated ${cNum(rated)} °C`);
    cmd(`M570 H${h} P5 T15`, "heater fault after 5 s more than 15 °C off target");
  };
  if (bedHeater && bedTherm) heaterLines(0, bedHeater, bedTherm, bedT, "bed", bedMax, f.bedMax, bedPart?.name ?? "the bed");
  if (hotHeater && hotTherm) heaterLines(1, hotHeater, hotTherm, hotT, "hotend", hotMax, f.hotMax, hotPart?.name ?? "the hotend");
  G.push("; No M307 heater models yet: M303 tunes each heater and M500 saves its model in config-override.g (README).");
  cmd("M302 S170 R170", "no extruding or retracting below 170 °C");

  G.push("", "; Fans");
  const fanNums: { role: string; n: number; link: Link }[] = [];
  for (const role of ["part", "hotend", "controller"] as const) for (const x of f.fans.filter((x) => x.role === role)) fanNums.push({ role, n: fanNums.length, link: x.link });
  for (const { role, n, link } of fanNums) {
    const p = portName(link);
    if (!p) continue;
    record(`${role === "controller" ? "controller" : role === "hotend" ? "hotend" : "part"} fan`, link, p);
    cmd(`M950 F${n} C"${p}" Q500`, `${devName(link)}, PWM at 500 Hz`);
    if (role === "part") cmd(`M106 P${n} C"Part" S0 H-1`, "part cooling: the slicer sets it");
    else if (role === "hotend") cmd(`M106 P${n} C"Hotend" S1 H${hotHeater ? 1 : -1} T45`, "on while the hotend is above 45 °C");
    else cmd(`M106 P${n} C"Board" S1 H-1`, "on all the time: cools the stepper drivers");
  }
  if (fanNums.length) G.push("; The fan outputs' voltage jumpers: VIN for fans of the supply voltage, 12 V only for 12 V fans (800 mA in all).");

  G.push("", "; Tool");
  const partFan = fanNums.find((x) => x.role === "part");
  cmd(`M563 P0 S"Hotend" D0 H1${partFan ? ` F${partFan.n}` : ""}`, "tool 0: extruder 0, heater 1");
  cmd("M568 P0 R0 S0", "tool 0 standby and active temperatures (G10 P0 R0 S0 before RRF 3.5)");
  cmd(`M572 D0 S${cNum(k)}`, "pressure advance (s) CALIBRATE: Duet's pressure advance test; 0 is off");

  G.push("", "; Saved values and start-up");
  cmd("M501", "load config-override.g (what M500 saves: heater models, probe height)");
  cmd("T0", "select tool 0");
  G.push("");

  // ---- homing files ----
  const sys = (n: string) => `firmware/${fwName(c)}/sys/${n}`;
  const head = (file: string, what: string) => [`; ${file}`, `; ${what}, generated by Kerf for "${gComment(c.designName)}".`, ""];
  /** A G-code line with its comment lined up, as in config.g. */
  const gl = (code: string, note: string) => `${code.padEnd(36)} ; ${note}`;
  const homeAxis = (ax: "x" | "y"): string[] => {
    const A = ax.toUpperCase();
    const far = cNum(size[ax] + 5);
    if (!stops[ax]) return [gl(`G92 ${A}0`, `no ${A} endstop is cabled: ${A} is set to 0 where it is`)];
    return [gl(`G1 H1 ${A}-${far} F3000`, `move to the ${A} endstop and stop there`), gl(`G1 ${A}5 F6000`, "back off 5 mm"), gl(`G1 H1 ${A}-${far} F360`, "home again slowly")];
  };
  const homeZ = (guard: boolean): string[] => {
    if (probe)
      return [
        ...(guard ? ["if !move.axes[0].homed || !move.axes[1].homed", '  abort "Home X and Y before Z"'] : []),
        gl(`G1 X${cNum(homeAt(size.x, probeX))} Y${cNum(homeAt(size.y, probeY))} F6000`, "put the probe over the middle of the bed"),
        gl("G30", "probe the bed: sets Z to the probe's trigger height"),
      ];
    if (stops.z) return [gl("G91", "relative moves"), gl(`G1 H1 Z-${cNum(size.z + 5)} F360`, "move to the Z endstop and stop there"), gl("G90", "absolute moves")];
    return [gl("G92 Z0", "no Z endstop or probe is cabled: Z is set to 0 where it is")];
  };
  const lift = [gl("G91", "relative moves"), gl("G1 H2 Z5 F6000", "lift Z so the nozzle clears the bed")];
  const drop = [gl("G1 H2 Z-5 F6000", "lower Z again"), gl("G90", "absolute moves")];
  const homex = [...head("homex.g", "Homes X"), ...lift, ...homeAxis("x"), ...drop, ""];
  const homey = [...head("homey.g", "Homes Y"), ...lift, ...homeAxis("y"), ...drop, ""];
  const homez = [...head("homez.g", "Homes Z"), ...lift, gl("G90", "absolute moves"), ...homeZ(true), ""];
  const both = stops.x && stops.y;
  const homeall = [
    ...head("homeall.g", "Homes X, Y then Z"),
    ...lift,
    ...(both
      ? [
          gl(`G1 H1 X-${cNum(size.x + 5)} Y-${cNum(size.y + 5)} F3000`, "move to both endstops and stop each axis there"),
          gl("G1 X5 Y5 F6000", "back off 5 mm"),
          gl(`G1 H1 X-${cNum(size.x + 5)} Y-${cNum(size.y + 5)} F360`, "home again slowly"),
        ]
      : [...homeAxis("x"), ...homeAxis("y")]),
    gl("G90", "absolute moves"),
    ...homeZ(false),
    "",
  ];
  const files: GenFile[] = [
    { path: sys("config.g"), content: G.join("\n") },
    { path: sys("homex.g"), content: homex.join("\n") },
    { path: sys("homey.g"), content: homey.join("\n") },
    { path: sys("homez.g"), content: homez.join("\n") },
    { path: sys("homeall.g"), content: homeall.join("\n") },
  ];
  if (probe) {
    files.push({ path: sys("deployprobe.g"), content: [...head("deployprobe.g", "Lowers the BLTouch pin (RepRapFirmware runs it before probing)"), gl("M280 P0 S10", "deploy the BLTouch"), ""].join("\n") });
    files.push({ path: sys("retractprobe.g"), content: [...head("retractprobe.g", "Raises the BLTouch pin (RepRapFirmware runs it after probing)"), gl("M280 P0 S90", "retract the BLTouch"), ""].join("\n") });
  }
  files.push({ path: `firmware/${fwName(c)}/README.md`, content: rrfReadme(c, warnings, pinTable, !!probe, !!bedHeater) });
  return { files, warnings, pinTable };
}

const fwName = (c: FwContext) => c.fw.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "reprapfirmware";

function rrfReadme(c: FwContext, warnings: string[], pinTable: RrfResult["pinTable"], probe: boolean, bed: boolean): string {
  const L: string[] = [];
  L.push(`# ${c.fw.name}: RepRapFirmware for ${c.designName}`, "");
  L.push(`RepRapFirmware ${RRF_RELEASE} runs on the ${c.boardPart.name} by itself: no host computer is needed. The \`sys\` folder holds \`config.g\` and the homing and probe macros, generated from the design's wiring.`, "");
  if (warnings.length) {
    L.push("## Fix before printing", "");
    for (const w of warnings) L.push(`- ${w}`);
    L.push("");
  }
  L.push("## 1. Firmware and network", "");
  L.push("1. Connect the board by USB and open a serial terminal (YAT, or the Duet's web installer). `M115` shows the firmware version: update to RepRapFirmware 3.5 from the Duet3D/RepRapFirmware releases on GitHub if it is older.");
  L.push('2. Wi-Fi boards: send `M552 S0`, then `M587 S"your network" P"your password"`, then `M552 S1`. The reply gives the board\'s IP address: open it in a browser for Duet Web Control.');
  L.push("3. In Duet Web Control, upload every file in `sys` here to the `sys` folder (System → Upload), replacing the ones there, and restart the board.", "");
  L.push("## 2. First checks, in order", "");
  const steps = [
    "`M122` reports the board's state: no driver or voltage errors.",
    "`M119` with each switch released and then pressed: it should change from not stopped to at min stop.",
    "With the nozzle well above the bed, move each axis 10 mm with `G91` then `G1 H2 X10 F600` (and Y, Z). If one moves the wrong way, change `S1` to `S0` on its driver's M569 line in config.g and restart.",
    ...(probe ? ["`M401` lowers the BLTouch pin and `M402` raises it. Then `G28` with a hand on the power switch."] : ["`G28` with a hand on the power switch."]),
    `\`M303 H1 S210\` tunes the hotend, then \`M500\`.${bed ? " `M303 H0 S60` tunes the bed, then `M500`." : ""}`,
    ...(probe
      ? [
          "Probe trigger height: `G28`, move the nozzle to the bed centre, lower it with `G1 Z-0.1` steps (after `M564 S0` if Z stops at 0) until it just grips a sheet of paper and send `G92 Z0`. Lift 5 mm, send `G30 S-1`: the reply's Z is the trigger height. Put it as `Z` on the G31 line in config.g (or `G31 Z<height>` then `M500`).",
          "`G29` probes the mesh and saves it to heightmap.csv; `G29 S1` loads it. Add `G29 S1` after `G28` in the slicer's start G-code.",
        ]
      : []),
    "Extruder: heat to 210 °C, mark the filament 120 mm above the extruder, extrude 100 mm (`M83`, `G1 E100 F60`). new steps = old × 100 ÷ measured: put it as `E` on the M92 line in config.g.",
    "Pressure advance: print Duet's pressure advance test (docs.duet3d.com, Pressure advance), then set `S` on the M572 line.",
    "Print a 20 mm calibration cube and measure it: X and Y should be within 0.1 mm.",
  ];
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push("");
  L.push("## Pins", "", "| Signal | Board port | Device |", "|---|---|---|");
  for (const p of pinTable) L.push(`| ${p.signal} | ${p.pin} | ${p.wire} |`);
  L.push("");
  L.push("## What is checked and what is not", "");
  L.push("- Every driver number, heater, sensor, fan, endstop and probe port in config.g is the board port the device is cabled to in the design.");
  L.push("- Command forms follow RepRapFirmware 3.5's G-code dictionary and Duet3D's configuration tool; Kerf has not run these files on a board. If the console reports an error at start-up, it names the line of config.g: compare it with the G-code dictionary (docs.duet3d.com).");
  L.push("- Motor currents are peak values (RepRapFirmware's M906), √2 × the RMS current the design asks for.");
  L.push("- Heater models, the probe trigger height, extruder steps and pressure advance are measured with the steps above.");
  return L.join("\n") + "\n";
}
