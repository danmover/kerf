// The Kerf language reference given to Claude, generated from the same
// builtin tables the evaluator uses so it cannot drift from the code.

import { SHAPE_FNS, MATH_FNS, modifierDocs, GEO_FNS } from "../lang/builtins";
import { FEATURE_FNS, PATH_FNS, PROFILE_FNS, SELECT_FNS, SOLID_FNS } from "../lang/modelling";
import { SEL_PRESETS } from "../kernel/recipe";
import { UNITS } from "../lang/lexer";
import { LIBRARY } from "../library/components";
import { THREADS, BEARINGS, MATERIALS } from "../library/standards";
import { CALC_FNS, CALC_PARAMS } from "../machine/calcs";
import { CATALOG, CATALOG_KINDS, catalogOfKind } from "../machine/catalog";
import { processReference } from "../mfg/guide";
import { DRAWING_DOCS, DRAWING_PROPS } from "../drawing/spec";
import { FINISHES, MATERIAL_LIST } from "../library/materials";
import { importsReference } from "./importTools";
import { CONSTRAINTS } from "../sketch/evaluate";
import { SKETCH_FNS } from "../sketch/fns";
import { ANALYSIS_FNS } from "../analysis/lang";
import { MECH } from "../analysis/materials";
import { materialRecord } from "../library/materialDb";
import { simulationReference } from "../sim/reference";

const geoDocs: Record<string, string> = {
  min_distance: "min_distance(a, b) — smallest gap in mm between the built solids of two parts or components (0 when touching). Resolved by the kernel after the build.",
  volume: "volume(a) — solid volume in mm³.",
  mass: "mass(a) — mass in grams from volume and material density.",
  bbox_min: 'bbox_min(a, "x"|"y"|"z") — lowest world coordinate of the built solid.',
  bbox_max: 'bbox_max(a, "x"|"y"|"z") — highest world coordinate.',
  size: 'size(a, "x"|"y"|"z") — overall extent along an axis.',
};

/** Argument names of a calculator, in positional order. */
export function calcParams(name: string): string[] {
  return CALC_PARAMS[name] ?? [];
}

/** First sentence, without splitting decimals like 3.3 V. */
function sentences(s: string, n: number): string {
  const parts = s.split(/(?<=\.)\s+/);
  return parts.slice(0, n).join(" ");
}

/** One line per catalog part, grouped by kind. Generated from the catalog so it never drifts. */
export function partsTable(): string {
  const lines: string[] = [];
  for (const kind of CATALOG_KINDS) {
    lines.push(`${kind}:`);
    for (const p of catalogOfKind(kind)) {
      const tags = [p.cut_to_length ? "cut to length" : "", p.generic ? "generic" : "", p.price_usd ? `~$${p.price_usd}` : ""].filter(Boolean).join(", ");
      lines.push(`  ${p.id} | ${p.name} | ${sentences(p.summary, 2)}${tags ? ` | ${tags}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** Where `at` sits and which fields each catalog kind exposes (from the library entries). */
function kindDocs(): string {
  return CATALOG_KINDS.map((k) => {
    const doc = (LIBRARY[k]?.doc ?? "")
      .replace(/^Purchasable [^.]*\.\s*/, "")
      .replace(/\s*Ids: [\s\S]*$/, "")
      .trim();
    return `- ${k}: ${doc || "`at` is the part's reference point."}`;
  }).join("\n");
}

function calcDocs(): string {
  return Object.entries(CALC_FNS)
    .map(([name, fn]) => `- calc.${name}(${calcParams(name).join(", ")}): ${fn.doc ?? ""}`)
    .join("\n");
}

const UNIT_BASE: Record<string, string> = {
  mm: "length (mm)",
  cm: "length (mm)",
  m: "length (mm)",
  in: "length (mm)",
  deg: "angle (deg)",
  rad: "angle (deg)",
  "%": "fraction",
  g: "mass (g)",
  kg: "mass (g)",
  rpm: "speed (rpm)",
  N: "force (N)",
  kN: "force (N)",
  Nm: "torque (N·mm)",
  Ncm: "torque (N·mm)",
  Nmm: "torque (N·mm)",
  kgcm: "torque (N·mm)",
  V: "voltage (V)",
  mV: "voltage (V)",
  A: "current (A)",
  mA: "current (A)",
  W: "power (W)",
  kW: "power (W)",
  Wh: "energy (Wh)",
  Ah: "charge (mAh)",
  mAh: "charge (mAh)",
  Ohm: "resistance (Ohm)",
  kOhm: "resistance (Ohm)",
  mH: "inductance (mH)",
  MPa: "pressure and stress (MPa = N/mm²)",
  kPa: "pressure and stress (MPa = N/mm²)",
  Pa: "pressure and stress (MPa = N/mm²)",
  GPa: "pressure and stress (MPa = N/mm²)",
  s: "time (s)",
  ms: "time (s)",
  min: "time (s)",
  h: "time (s)",
  hr: "time (s)",
  lbf: "force (N)",
  kgf: "force (N)",
  bar: "pressure and stress (MPa = N/mm²)",
  psi: "pressure and stress (MPa = N/mm²)",
  C: "temperature (°C)",
  Hz: "frequency (Hz)",
  kHz: "frequency (Hz)",
  degC: "temperature (°C)",
};

/** Every unit suffix the lexer accepts, grouped by what it measures, with its factor into the base unit. */
export function unitsTable(): string {
  const groups = new Map<string, string[]>();
  for (const [u, f] of Object.entries(UNITS)) {
    const g = UNIT_BASE[u] ?? "other";
    const factor = f === 1 ? "" : ` ×${Number(f.toPrecision(5))}`;
    groups.set(g, [...(groups.get(g) ?? []), `${u}${factor}`]);
  }
  return [...groups].map(([g, us]) => `- ${g}: ${us.join(", ")}`).join("\n");
}

/** Controllers grouped by what Kerf generates for them. */
function firmwareBoards(): string {
  const ctrl = CATALOG.filter((p) => p.kind === "controller");
  const arduino = ctrl.filter((p) => String(p.specs.platform ?? "").startsWith("arduino")).map((p) => p.id);
  const klipper = ctrl.filter((p) => p.specs.platform === "klipper").map((p) => p.id);
  return `Arduino sketch (the .ino, pins.h, config.h and a README with the bring-up steps): ${arduino.join(", ")}. Klipper printer.cfg (plus a README with the calibration commands): ${klipper.join(", ")}.`;
}

function machineReference(): string {
  return `## Machines: purchasable parts, wiring, calculations, firmware and tests

A machine is the same .kerf file with purchasable catalog parts (motors, boards, drivers, batteries, rails...), the wiring between their pins, engineering calculations, a firmware block, physical tests and extra purchases. Everything is checked on every rebuild and feeds the parts list, wiring list, firmware and build pack.

### Catalog components
component drive = lib.gearmotor("gobilda_5203_188") { at: (0, 0, 40), axis: X, role: "front screw", load: 10.8Nm }
component ctrl = lib.part("arduino_nano") { at: (0, 0, 0) }            // lib.part takes any catalog id
component rail_x = lib.rail("mgn12h", length: 300, travel: 120) { at: (0, 0, 0), axis: X }
Arguments: the catalog id (first, in quotes); length (mm, required for cut-to-length stock: extrusions, rails, rods, lead screws); travel (mm: carriage, nut or actuator position along its stroke).
Every normal component property works (at, axis, rotate, color, group, label, at: [list] for patterns). Catalog parts also take:
- role: "text": what the part does here ("front screw", "steering hinge", "x", "extruder", "part cooling"). The firmware generators read it to tell motors, axes and fans apart.
- load: torque on the output shaft (N·mm, write 10.8Nm). The engineering check compares it with the stall or holding torque (fail at 100 %, warning above 50 %; a DC motor's stall torque and current scale with its driver's supply voltage, as in calc.motor_point), and the wiring rules use the current it implies to size drivers, wires and supplies.
- rating: (fuses only) the fuse you fit, in A (write 15A); without it the catalog's fuse is assumed. The wiring rules fail a fuse larger than the thinnest wire after it can carry, and warn when the load after it is over 90 % of its rating.
- buy: "https://…": a direct product page for this exact item; replaces the catalog link in the parts list.
- price: USD each; replaces the catalog price.
- ref: "R12": (parts on a lib.circuit_board) the reference designator printed on the board and used in its parts list; left out, Kerf numbers each kind in order (R1, C1, D1, U1, RV1...).
Fields: every catalog spec (drive.t_stall, drive.rpm_free, drive.i_stall, bat.capacity_mah, bat.v_max; true/false specs read 1/0), the placement fields below, plus catalog_id and price. Spec units are mm, N·mm, A, V, W, g, rpm and mAh unless the name says otherwise.
Pins: comp.PIN by pin id or by the label printed on the board (ctrl.D9, bat.POS, drv.OUTA); one instance of a pattern: comp[1].PIN. Only catalog parts have pins. Call catalog_lookup for a part's pins, ratings and notes before wiring it.

Placement and fields by kind:
${kindDocs()}

### Parts catalog
id | name | summary | tags (~typical price in USD)
${partsTable()}

### Wiring
wire ctrl.D9 -> drv.PWM { gauge: 24, color: "orange", label: "front PWM" }
wire bat.POS -> xt.POS_A -> xt.POS_B -> fuse.IN { gauge: 14, color: "red" }   // a chain is one wire per hop
net GND: ctrl.GND, drv.GND, imu.GND { gauge: 24, color: "black" }             // named net: every listed pin on one conductor
wire skr.XM -> motor_x.PLUG                                                    // port to port: one cable
net V12: reg12.OUT, c_12.PLUS, u1.VPOS { width: 0.8mm }                    // on a circuit board: copper, not a cable
Properties: gauge (AWG), color, label (wires only). On a lib.circuit_board, nets between on-board pins are routed as copper: width (mm) sets the track width (supply and current-carrying nets are widened automatically); pour: true fills the board's spare copper with that net (Kerf pours the ground net on its own unless one net says pour: true or a net says pour: false). Net names are unique; list all of a net's pins in one net statement. A pin may appear in several wires and nets: they join into one electrical net.
Give every power and motor conductor a gauge sized for its current (calc.wire_gauge); the wiring rules check each wire and each net's gauge against the current through it, motor leads and ground returns included, and use red for supply, black for ground and distinct colours for signals; 22 to 26 AWG suits logic signals.
Ports are multi-conductor connectors: stepper4, fan2, heater2, therm2, endstop3, probe5, usb. Join a board port (source) to a device port (sink) of the same kind with one wire; never wire a port to a single pin.
Pin types in catalog_lookup: gnd; pwr_in (needs vmin–vmax V, damaged above vabs; "draw" is its own current); pwr_out (supplies v at up to imax A); pwr_rail (a board rail that supplies its voltage unless something else feeds it); io (controller GPIO at its logic voltage, with pwm, adc, irq, input-only and bus roles such as i2c_sda); in (module input: tolerates vmax, reads high above vih; "needs pwm" means drive it from a PWM pin); out (module output; "needs irq" means read it on an interrupt pin); analog_out (needs an adc pin); motor_out (driver output terminal, channel A or B); motor (motor terminal); passive (switch, fuse or connector terminal, joined to its partner when closed); port. "required" pins must be connected.

### Engineering calculations
let sand = calc.sand_stress(depth: 9.5m, box_w: 1m)
let screw = calc.screw_burrow(d: 90, core_d: 70, length: 150, pitch: 40, sigma_v: sand.sigma_v, sigma_h: sand.sigma_h, face: true)
let point = calc.motor_point(motor: drive, load: screw.torque)
A let that holds a calculation records its working (inputs, method, assumptions, how far to trust it, what a test should confirm) in the design's calculations, shown to the user. Results are fields in base units (mm, N, N·mm, MPa, V, A, W, s, rpm): feed them into other calculations, load:, firmware settings and require lines. Arguments are named; anything in brackets in the descriptions below is the default. Confidence: standard (textbook method), estimate (sound method, some inputs guessed), rough (little published basis: can be off by 2× and needs a physical test). The engineering_calc tool runs one calculation outside the design.
${calcDocs()}

### Firmware
firmware brain { board: ctrl, behaviour: "Dig forward holding heading; back off on stalls; stop at the far side", run_distance: 1100mm, start_delay: 10s }
Kerf generates the code from the wiring, so every pin number matches the harness: change the wiring, never the generated pin files. ${firmwareBoards()} Settings are numbers, text or true/false; times are in seconds (10s, 500ms) and distances in mm.
Arduino boards: behaviour text that mentions tunnel, burrow, sand, drill, dig or bore (with DC motors on drivers) gives the autonomous tunnelling program; anything else gives the bench program (a serial console that drives each motor and reads each sensor). Both include the console. The generator finds:
- DC motors and actuators through the driver channel their M_PLUS/M_MINUS are wired to (control schemes: pwm_dir, rpwm_lpwm, in1_in2_en, in1_in2_pwm, in1_in2_pwm_both); the front and rear motors by name or role (front/nose/head, rear/back/tail); the steering actuator or servo by steer or hinge. Driver current-sense pins wired to analog pins give stall detection.
- encoders (ENC_A on an interrupt pin, ENC_B), actuator position feedback (FB on an analog pin), servos (SIG; on AVR boards the Servo library disables PWM on pins 9 and 10), a BNO055 or MPU-6050 on the I2C pins, battery voltage through voltage_sensor_25v.S, and the battery's cell count.
- settings (default): start_delay (10 s), run_distance (1100 mm), max_run_time (3600 s), power (0.8 of full PWM), pitch (40 mm screw pitch), slip (0.5), stall_current (80 % of the front motor's stall current, A), stall_time (0.6 s), backoff_time (1.5 s), max_retries (8), breakthrough_current (0.5 of the front motor's digging average), give_up_time (0 s = none: back out if there is no breakthrough by then; it also backs out at twice run_distance by the turn count), roll_limit (60 deg: stop if the body rolls past it), motor_hot_rise (60 K: estimated motor rise above its surroundings that is too hot; digging backs out at 3/4 of it without a breakthrough), motor_cooling (0.5: share of free-air cooling the motors get where they run), max_rest_time (1200 s: a rest on the way out that hasn't cooled the motors by then ends the run), rear_free_current (3 × the rear motor's free current, A: backing out stops once the rear motor stays below it for 2 s, because its screw is out of the sand), heading_kp (1.5), heading_ki (0.05), steer_max (8 deg), steer_sign (1 when extending the steering turns the nose clockwise seen from above, the way the IMU heading grows; -1 when anticlockwise), steer_arm (40 mm, hinge pin to where the actuator or cam pushes), steer_slope (1: sideways movement per mm of stroke; the slot slope for a cam), steer_deadband (0.4 mm of actuator position error ignored), steer_mid (half the actuator stroke, mm), roll_kp (0.01), roll_trim_max (0.25), low_cell (3.4 V per cell), log_interval (5 s).
Arduino Nano or Uno with app: "tuner": a chromatic guitar tuner instead of the tunnelling or bench program. It reads the analog pin wired to the signal (bias it at 2.5 V) with the free-running ADC, shows the note and cents on an SSD1306 OLED on the I2C pins, and uses a button to ground (pin wired through a switch) to step the reference pitch; settings: ref_hz (440; the button steps 432 to 445). The Practice Amp with Tuner template shows the circuit around it.
Klipper boards: axes come from the board port each stepper is cabled to (X…, Y…, Z…, E…) or the stepper's role ("x", "y", "z", "extruder"); hotend and bed heaters and thermistors from their heater2 and therm2 cables (a heated_bed part is the bed); fans by role or port label (part/blower, hotend/heatsink, controller/electronics); endstops from XSTOP/YSTOP/ZSTOP; a probe5 cable makes the probe the Z endstop. Rotation distances come from GT2 pulleys (role "x"/"y"), the lead screw and the extruder.
- settings (default): x_size (220), y_size (220), z_size (250) in mm; kinematics ("cartesian"); max_velocity (300 mm/s); max_accel (3000 mm/s²); x_rotation_distance, y_rotation_distance (from the pulley, else 40), z_rotation_distance (the lead screw's lead, else 8), e_rotation_distance (the extruder's, else 22.68); x_run_current, y_run_current, z_run_current, e_run_current (A, from the motor rating and the driver limit); probe_x, probe_y (probe offset from the nozzle, -40 and -10 mm).
Firmware warnings (for example a motor whose driver pins are not wired) come back from run_checks.

### Physical tests and purchases
test "Bucket dig": "Dig 30 cm into a bucket of damp sand at full power; motor current must stay under 6 A and the screws must not slip on their shafts"
buy "M3 socket screw assortment" { qty: 1, price: 12, url: "https://…" }
buy "Plywood for the sand box" { qty: 3, price: 28, search: "18 mm plywood sheet 1220 x 2440" }
A test is a procedure, what to measure and the pass criterion, for anything only a real build can confirm. buy lists something to purchase that has no model or pins (hardware kits, wire, tube, sheet material, a tool): qty, price (USD each), and url (a direct product page) or search (text for marketplace searches).

### Units (literal suffixes; values convert to the base unit shown)
${unitsTable()}
Write a space before a name after a number (2 * width, not 2width).

### Machine checks (run on every rebuild, returned by run_checks)
- electrical (basis: electrical rules): supplies, shorts, two supplies fighting, board rails fed the wrong voltage, unpowered required pins, voltage against each pin's ratings, logic levels (5 V into 3.3 V pins), PWM-capable and ADC pins where needed, interrupt pins for encoders, I2C/UART pins, input-only pins, strapping and USB-serial pins, two outputs on one net, motors without a driver, driver current against the motor's load and stall current, motor over-voltage, both motor terminals on one driver channel, port kinds and sides, stepper, fan and heater current against the port, a common ground between parts that exchange signals, required pins left unconnected, a fuse and a switch on every battery, the current budget of every supply, wire gauge against the current in every wire, motor lead and ground return, and each fuse against the thinnest wire after it. A design with a controller and no firmware block gets a warning.
- engineering (basis: calculation): motor load (load:) against stall or holding torque, and a summary of the calculations (rough ones are flagged). Heat inside the box: every closed space holding electronics (a hollow printed body, a tube with end walls, or panels on every side) gets the heat its parts lose at their working currents, the air temperature from its walls, openings and fans (a lib.fan inside it or on a wall counts), after the longest simulated run or steady, and each part's rating at that air (drivers derate, LiPos under 60 °C, wall material). Fix one with a fan and vent, a heat sink, less current, a bigger box or a part moved out; sealed designs (sand, dust, water) keep sealed. Service life: brushed motors, bearings (from calc.bearing_life), seals, fans, LiPo cycles, nozzles and screw flights in sand get a life in hours and in runs of the first simulation, with a maintenance schedule (Build tab Service, build pack service.md); anything that wears out within 20 runs is warned about.
- testing (basis: physical test): the test plan: every test line, every rough calculation's verify step and the tests the catalog lists for the chosen parts.
`;
}

export function languageReference(): string {
  const docs = (fns: Record<string, { doc?: string; name: string }>, skip: string[] = []) =>
    Object.entries(fns)
      .filter(([k]) => !skip.includes(k))
      .map(([, f]) => `- ${f.doc ?? f.name}`)
      .join("\n");
  // revolve() is listed once, with both forms, among the profile solids
  const shapes = docs(SHAPE_FNS, ["revolve"]);
  const math = Object.values(MATH_FNS)
    .map((f) => `- ${f.doc ?? f.name}`)
    .join("\n");
  const mods = Object.values(modifierDocs)
    .map((d) => `- ${d}`)
    .join("\n");
  const geo = GEO_FNS.map((g) => `- ${geoDocs[g] ?? g}`).join("\n");
  // catalog kinds are documented once, in the machines section
  const lib = Object.entries(LIBRARY)
    .filter(([, e]) => !e.machine)
    .map(([k, e]) => `### lib.${k}\n${e.signature}\n${e.doc}`)
    .join("\n\n");
  const threads = Object.entries(THREADS)
    .map(([k, t]) => `${k}: d ${t.d}, clearance ${t.clearance}, close ${t.close}, tap ${t.tap}, head_d ${t.head_d}, head_h ${t.head_h}, key_size ${t.key}, nut_af ${t.nut_af}, nut_h ${t.nut_h}, insert_d ${t.insert_d}, insert_l ${t.insert_l}`)
    .join("\n");
  const bearings = Object.entries(BEARINGS)
    .map(([k, b]) => `${k} (${b.bore}×${b.od}×${b.width})`)
    .join(", ");
  const materials = Object.keys(MATERIALS).map((m) => `"${m}"`).join(", ");
  const materialTable = MATERIAL_LIST.map((m) => {
    const r = materialRecord(m.name)!;
    return `"${m.name}" (${m.density} g/cm³, to ${r.maxC} °C, E ${r.mech.E / 1000} GPa, yield ${r.mech.yield} MPa; made by ${r.processes.join(", ")}): ${m.note} Finishes: ${m.finishes.map((f) => `"${f}"`).join(", ")} (default "${m.finishes[0]}").`;
  }).join("\n");
  const finishTable = Object.values(FINISHES)
    .map((f) => `"${f.id}": ${f.note}`)
    .join("; ");
  const constraints = Object.values(CONSTRAINTS)
    .map((c) => `- ${c.doc}`)
    .join("\n");
  const analysisFns = Object.values(ANALYSIS_FNS)
    .map((f) => `- ${f.doc ?? f.name}`)
    .join("\n");
  const printedList = MATERIAL_LIST.filter((m) => m.printed).map((m) => m.name).join(", ").replace(/, ([^,]*)$/, " or $1");
  const mech = Object.entries(MECH)
    .map(([k, m]) => `${k}: E ${m.E / 1000} GPa, yield ${m.yield} MPa, fatigue ${m.fatigue} MPa${m.layerFactor < 1 ? `, layers ${Math.round(m.layerFactor * 100)} %` : ""}`)
    .join("; ");

  return `# Kerf design language (.kerf)

A design is one text file. It is the single source of truth: the app evaluates it, builds exact B-rep solids with OpenCASCADE, runs checks and renders the result. Every manual edit and every AI edit is an edit to this text.

Units: millimetres and degrees. Literals may carry units (2cm, 0.5in, 1.5rad) which convert to mm/deg; 10N, 2kg, 50g and 40C are also read (forces in N, masses in g, temperatures in °C), and machine units such as 10.8Nm, 12V and 2200mAh (the full list is under Machines). World axes: X right, Y back, Z up. Constants X, Y, Z are unit vectors; ORIGIN is (0, 0, 0). Points are (x, y) or (x, y, z) with fields .x .y .z. Lists use [a, b, c] and index with [i] (0-based). Comments: // and /* */. Colors: #4f7cff.

## Statements (top level, evaluated in order; a name must be defined before it is used)
design "Name"
note "Free text shown to the user"
param name = expr [range lo .. hi] ["description"] [locked]   // tunable inputs; locked means the user froze it. The description is the label the user reads in the params panel; a "// ── Title ──" comment above a run of params becomes its heading there
sketch name { plane, geometry, constraints }                  // constrained 2D profile (see Sketches)
let name = expr                                              // derived values: layout skeleton, positions, lists of points; let x = calc.<fn>(...) records a calculation
interface name { field = expr, ... }                          // named contract between parts (screw size, boss size); read as name.field
component name = lib.kind(args) { props and flags }           // standard parts from the library, and purchasable catalog parts
part name { props, body/add/cut/intersect shapes, modifiers, for/if/let }   // custom solid
require "Label" [hard|soft] [for use_id, ...]: condition      // checked every rebuild; hard by default; for links it to brief uses
brief { ... }                                                 // the design brief, once, near the top (see below)
decision name "Title" { ask, chose, by, why, option ... }      // a recorded design choice and its alternatives (below)
wire a.PIN -> b.PIN { gauge: 22 }  /  net NAME: a.PIN, b.PIN   // wiring between catalog parts (see Machines)
firmware name { board: ctrl, ... }                             // generated firmware for a controller
test "Label": "procedure"                                      // a physical test the build must pass
buy "Label" { qty: 1, price: 10, url: "https://…" }            // a purchase with no model
analysis "Label" { props }                                     // a strength analysis or drivetrain duty, re-run after every change (see Analysis blocks)

Operators: + - * / ^, comparisons == != < <= > >=, && || !, cond ? a : b. Vectors add, subtract and scale. Lists and ranges work with for.

## The brief
brief {
  purpose: "Hold a 25 mm handlebar light on a bike"
  setting: "Clamped to the handlebar, removed weekly"
  priorities: ["strength", "print time"]
  look: "Matte black, rounded edges" assumed

  temp: -10C .. 45C                      // service temperature in °C, lowest first
  outdoor: true
  exposure: ["sunlight", "rain", "vibration"]

  process: "FDM print"                   // the default process of every part; text, or a value like mfg.fdm(layer: 0.2)
  material: "PETG"
  quantity: 2
  build_volume: (220, 220, 250)          // printer bed, mm; the bed of every printed part

  max_size: (80, 60, 50)                 // the whole design must fit in this box, mm
  max_mass: 60g

  use hold_light "Holds a 150 g light over rough roads" { load: 15N, dir: -Z, on: mount, cycles: 100000 }
  use swap "Comes off without tools" assumed

  given bar_d = 25.4mm "Handlebar diameter, measured"
  given light_w = 32mm "Light body width, read from photo1" assumed

  reference photo1 "Light from the side" { file: "ast_ab12cd", notes: "Mount rail 32 mm wide" }
  reference datasheet "Light manual" { url: "https://example.com/light.pdf" }

  assume "Rider weight is not carried by this part"
  assume "Printed with 4 walls" confirmed
}
A trailing assumed marks what Claude estimated; the user confirms it. Fields: purpose, setting, look (text), priorities, exposure (lists of text), temp (range with C), outdoor (true/false), process (text or an mfg.* process), material (text), quantity (integer), build_volume, max_size (three sizes in mm), max_mass (mass). use id "text" { load (force in N, or a mass in kg or g read as its weight), dir (direction: X, -Z or a vector), on (part or component name), cycles, note }. given name = value ["description"] defines a fixed name the design reads like a locked param (bar_d above). reference id "title" { file (an attached file id), url, notes }. Unknown fields are kept and warned about.
The brief's process is the default for every custom part with no process of its own, unless the part's own material cannot be made that way (a steel shaft in a printed design); parts naming no material take the brief's material. Put process: on a part only where it differs.
Requirements link to uses with for: require "Clamp grips the bar" for hold_light: clamp_gap < bar_d.
Brief checks the app adds: uses no requirement covers, loads that need strength analysis, the material against the temperature range, sunlight, wet and impact exposure, food contact on printed parts, the whole design against max_size and max_mass, and givens nothing uses.

## Part blocks
part bracket {
  color: #4f7cff
  material: "PETG"            // one of ${materials}
  finish: "printed"           // optional surface finish for that material (see Materials and finishes)
  group: "Housing"            // groups parts in the parts panel
  body box(40, 20, 5, r: 2) as plate      // first solid, named so its edges can be picked
  add cylinder(d: 10, h: 12, at: (0, 0, 5)) as boss
  fillet(1.5, edges: boss.root)           // round where the boss meets the plate
  cut hole(M4, through: true, at: (12, 0, 5))
  for x in [-12, 12] { cut hole(M3, depth: 6, at: (x, 0, 5)) }
  if wall > 2 { add box(4, 4, 4) } else { add box(3, 3, 3) }
  cosmetic { chamfer(0.4, edges: boss.tip) }   // full-quality detail only
}
Part props: color, material, finish, process (how it is made, see Manufacturing processes), group, label, at (translate the finished part), rotate ((rx, ry, rz) degrees), turns_with (moves with a component or part), spin (driver ratio), axis and axis_at (rotation axis for spin). Flags: locked, hidden, removable (removable parts such as lids or covers are ignored by the tool-access check, meaning "removed for assembly").
Order matters: each modifier applies to the body as built so far. Shell right after the body (before bosses, ribs and holes). Fillet a joint right after adding the feature it rounds (fillet(r, edges: boss.root)); fillet outer edges before cutting holes that cross them. A part is limited to 600 operations.

### Shape functions (use after body/add/cut/intersect)
${shapes}

### Modifiers (inside a part)
${mods}

## Detailed modelling

### 2D profiles (flat outlines; combine with + and -, move(p, by:), rotate(p, angle))
${docs(PROFILE_FNS)}

### 3D paths (for sweep and pipe)
${docs(PATH_FNS)}

### Solids from profiles and sketches, threads, grips, lettering, ribs
${docs({ ...SOLID_FNS, extrude: SKETCH_FNS.extrude, revolve: SKETCH_FNS.revolve })}

### Ready-made features (use with add; each adds and cuts what it needs and rounds its own root)
${docs(FEATURE_FNS)}

### Naming features and picking edges
Name any step with \`as\`: \`body box(80, 50, 30) as shell\`, \`add cylinder(d: 8, h: 10, at: p) as boss\`, \`cut hole(M3, through: true) as bore\`. Using the same name again (for example inside a for loop) adds to the same feature. A name then picks geometry by meaning, however the part changes later:
- boss.root: edges where the feature meets the rest of the part (fillet these for strength)
- boss.tip: sharp edges between two faces of the feature itself (the top rim of a boss)
- boss.edges / boss.faces: all of its edges or faces; boss.convex / boss.concave: only outside or inside corners
Presets: ${SEL_PRESETS.map((p) => `"${p}"`).join(", ")} ("convex" = sharp outside edges, "concave" = sharp inside corners, "sharp" = both; top/bottom = at the part's highest/lowest z).
Selector functions (coordinates are the part's own, before its at:/rotate:):
${docs(SELECT_FNS)}
Combine: a list or + takes everything in either, - removes, both(a, b) keeps the overlap. Example: fillet(0.6, edges: shell.convex - shell.root).
Use inspect_part to see a part's features and to test a selector before you rely on it.

### Cosmetic detail
cosmetic { ... } holds steps that only build in the full-quality pass (final meshes, renders, STEP export): small chamfers, edge breaks, lettering, decorative grooves. Fast builds (previews, interference and clearance checks, measurements) skip them, and if one fails it is left out with a warning instead of breaking the part. Threads and knurls are always detailed in the full-quality pass and plain cylinders in fast builds. A step outside cosmetic must not refer to a feature named inside it.

### Math and helpers
${math}

### Geometric quantities (only inside require; resolved after the build)
${geo}

## Sketches
A sketch is a constrained 2D outline on a plane; extrude() or revolve() turns its closed profile into a solid. Users draw and edit sketches by hand in the sketch editor, and those edits change the same text, so write sketches the way a careful CAD user would: fully defined, dimensioned from parameters.
sketch side {
  plane: XZ                    // XY (top, x→X y→Y), XZ (front, x→X y→Z), YZ (right, x→Y y→Z); -XY etc. flips; or ${SKETCH_FNS.plane.doc}
  offset: 5                    // moves the plane along its normal
  line l1 = (0, 0) -> (50, 0)
  arc a1 = l1.end -> (50, 20), center: (50, 10)   // counter-clockwise from start to end; l1.end shares the point, so the outline is connected
  line l2 = a1.end -> (0, 20)
  line l3 = l2.end -> l1.start  // back to the start: a closed loop
  circle c1 = a1.center, d: 8  // or r:; the size is a starting guess until a dimension holds it
  point p = (0, 10)
  construction line centre = p -> a1.center   // guides only, not part of the profile
  coincident l1.start, origin
  horizontal l1, l2
  vertical l3
  tangent l1, a1
  tangent a1, l2
  length l1 = base_len         // dimensions take any expression; params make them sliders
  length l3 = 20
  diameter c1 = 8
  midpoint p, l3
  fillet l3, l1 = 2            // rounds the corner in the profile; dimensions still measure to the sharp corner
}
Every sketch has origin, x_axis and y_axis (fixed). Coordinates are starting guesses: the solver moves points as little as possible to satisfy the constraints, so write them close to the intended shape. Refer to points as l1.start, l1.end, a1.center, c1.center or named points. Geometry of an earlier sketch can be referenced (side.l3.end, side.l3); it is projected onto this sketch's plane as a fixed reference, so this sketch follows it.
Constraints and dimensions (refs are names, the value after = is any expression):
${constraints}
A good sketch is fully defined (0 degrees of freedom): every point is fixed by constraints, usually by dimensions driven from params plus horizontal/vertical/coincident relations and one point tied to the origin. Redundant constraints are warned about; conflicting ones fail and name the culprit. A closed profile is one or more non-crossing loops; inner loops become holes. Sketch values expose .area, .plane, .normal and each named entity in world coordinates (side.l1.mid, side.c1.center), so other statements can position things from a sketch.
Use sketches for profiles that are awkward to build from primitives (bent plates, cams, levers, gussets, custom outlines, turned parts) and whenever the user wants to edit a profile by hand. Primitives are still fine for plain boxes, cylinders and holes.

${processReference()}

## Components
component name = lib.kind(args) { at: point, axis: dir, ... }
Props: at (a point, or a LIST of points to make a pattern of identical instances: name#1..n; use name.all[i] or name.count), axis (orientation for axial parts), facing (horizontal direction for connectors), rotate, spin (drives the mechanism: spin: 1), mesh (gears: mesh with another spur_gear; the phase and speed are computed so teeth interleave), turns_with (locks to another component's rotation, e.g. a gear on a motor shaft), color, group, material, finish, label. Flags: locked, hidden, removable.
Component fields are world-space after placement (motor.holes is a list of world points). Moving components get .speed (rotation ratio relative to the driver). Pattern components expose fields of the first instance plus .all and .count; shape fields (like usb.opening) become lists so \`cut usb.opening\` works.

${lib}

${drawingReference()}
${importsReference()}

## Standard data
Threads (use M3 etc. directly as values: M3.clearance, M3.tap, M3.head_d, or pass M3 to hole() and lib.screw()):
${threads}
Bearings for lib.bearing(code): ${bearings}

## Materials and finishes
material: sets density (mass, the parts list) and how the part renders. finish: sets the surface; leave it out to get the material's default. color: is the base colour (filament, anodizing or paint colour; for bare metals keep a realistic metal grey or the brass/copper tone). Library hardware already has realistic finishes (black-oxide screws, zinc-plated nuts, machined brass inserts).
${materialTable}
Finish meanings: ${finishTable}.

## Decisions
A decision block records a design choice: what was asked, the alternatives, which was chosen, by whom and why. It does not change geometry; the parameters do. The app lists decisions in a Decisions panel where the user can preview another option live, switch to it in one click, or fine-tune the chosen values.
decision lid_fastening "Lid fastening" {
  ask: "How should the lid attach?"            // optional: the question as it was put
  chose: "M3 screws into inserts"              // the label of the chosen option
  by: "claude"                                 // "you" (the user) or "claude"
  why: "Re-openable many times without wearing the plastic."
  option "M3 screws into inserts" "Strong and re-openable; adds four inserts and screws."
  option "Snap fit" "No hardware, but the clips wear after a few dozen openings."
}
decision wall_thickness "Wall thickness" {
  chose: "2.0 mm"
  by: "claude"
  why: "Five perimeters at 0.4 mm: stiff enough for a hand-held box."
  option "1.6 mm" { wall: 1.6mm } "Lighter and faster to print; flexes more."
  option "2.0 mm" { wall: 2mm } "Balanced."
  option "2.4 mm" { wall: 2.4mm } "Stiffer and heavier."
}
An option's { param: value } list names parameters only; switching to that option writes those values into the params. Options without values are structural (switching them needs a design change). The chosen option's values should match the params; the panel shows any difference as "adjusted".

## Analysis blocks
A structural analysis says how parts are held and what loads them. After every build the app solves a finite-element model of the named parts (bonded where they touch) and adds strength and stiffness checks.
analysis "Shelf load" {
  parts: [bracket, gusset]                  // optional: defaults to the parts that face() names
  fix: face(bracket, -Y)                    // held in every direction (screwed or glued to the wall)
  fix: zone(at: hole_pos, d: M4.clearance + 2, axis: Z, length: 5)   // a bolt hole: the bore surface
  fix: roller(face(bracket, -Z), Z)         // only stops movement along Z (resting on a surface)
  load: force(face(bracket, +Z), (0, 0, -shelf_kg * 9.81N))   // total force spread over the region
  load: pressure(face(lid, +Z), 0.02MPa)
  load: torque(zone(at: hub_pos, d: 8, axis: Z, length: 6), 0.5Nm, axis: Z)
  gravity                                   // self-weight; or accel: (0, 0, -3) for 3 g
  material: "PETG"                          // optional: overrides the parts' material
  printed                                   // FDM part: layer bonds are weaker; build: Z gives the stacking direction (default Z)
  cycles: 1e5                               // repeated loading: judged against fatigue strength
  safety: 2                                 // required lowest factor of safety (default 2)
  max_deflection: 0.5mm                     // optional stiffness limit
  resolution: "standard"                    // "draft" ~8k elements, "standard" ~30k (default), "fine" ~110k, or a cell size like 0.6mm
}
fix: and load: may repeat or take lists. Units: N, kN, lbf, kgf (weight of a kilogram: 5kgf = 49 N; kg is a mass in grams, so never kg × 9.81N), Nm, Nmm, MPa, kPa, bar, psi, GPa. Inside an analysis block these functions exist:
${analysisFns}
A drivetrain analysis gives a gear train's duty instead; the app checks tooth bending (Lewis), bearing L10 life and shaft torsion for every gear and bearing the driver turns:
analysis "Gearbox duty" {
  drive: motor_gear        // the component that drives the train
  torque: 0.3Nm            // input torque
  speed: 3000rpm           // input speed
  life: 2000h              // required running life (sets fatigue cycles and the bearing life target)
  safety: 1.5
}
Strength data: ${mech}. Parts in ${printedList} count as FDM-printed by default; write printed: false for a moulded or machined plastic part.

## Checks the app runs automatically
- every require statement (hard fails block "valid"; soft fails warn), with margins
- exact solid interference between every pair of nearby parts (OpenCASCADE booleans); parts of one multi-solid component are not checked against each other; gears are checked by tooth geometry instead
- tool access: a hex-key cylinder from every screw head outward must not hit non-removable parts
- swept envelopes of rotating gears against static parts
- gear meshing: same module, exact centre distance, face overlap, and tooth clearance through a rotation
- build errors (a modelling step the kernel could not perform)
- every analysis block: structural strength (factor of safety) and stiffness, or the drivetrain's tooth, bearing and shaft checks
- manufacturing: every part with a process: is checked against that process's rules on its exact geometry (walls by ray casting, draft and undercuts along the pull, tool reach per setup, inside corner radii, slots, overhangs and orientation, turning, sheet thickness and bends, flat profiles, holes, voids, machine size), plus whether its material suits the process
- for machines: electrical rules, engineering loads and the physical test plan (see Machines below), and every scenario block's expectations from its simulated runs (see Simulations below)
Hard parametric requirements also feed a feasibility solver: when they cannot all hold, it searches the unlocked parameters for the smallest changes that satisfy every hard requirement.
Things geometry cannot prove are reported as "needs analysis" until an analysis block or a machine calculation covers them; real printer tolerances are not analysed, and heat only by the machine calculators.

${machineReference()}

${simulationReference()}`;
}

function drawingReference(): string {
  const calls = Object.values(DRAWING_DOCS)
    .map((d) => `- ${d}`)
    .join("\n");
  return `## Drawings
Every design gets automatic engineering drawings: one for the whole design (views, overall sizes, parts list and balloons) and one per custom part (views, a section when it has hidden features, dimensions, hole callouts, title block). A drawing block in the source replaces the automatic drawing of the same target and is how drawings are changed:
drawing housing_drawing {
  title: "Housing"
  of: housing
  sheet: "A3"
  scale: "1:2"
  views: ["front", "top", "right", "iso"]
  section("A", at: (0, 12, 0), normal: X, view: "front")
  detail("B", view: "front", at: (30, 0, 30), r: 8, scale: 4)
  dim((-20, 0, 0), (20, 0, 0), view: "top", tol: 0.05)
  diameter((30, 0, 30), 16, view: "front", fit: "H7")
  note("Print in PETG, 0.2 mm layers")
}
Properties: ${DRAWING_PROPS.join(", ")}. of names parts or components defined above (omit it for the whole design). Leave out sheet and scale to have them chosen. Dimensions, hole callouts and position dimensions are generated (auto_dims: false turns them off); a dim() or diameter() that repeats a generated one replaces it, which is how to add a tolerance or a fit. Positions are model coordinates in mm; views are first-angle (ISO) unless projection: "third".
Calls inside a drawing block:
${calls}
Use view_drawing to look at a drawing and get its dimension list before changing it. When the user points at something on a drawing, their message names it (for example a dimension's text and view); change the drawing block, or the design itself when they ask for a different size.`;
}
