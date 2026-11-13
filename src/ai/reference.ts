// The Kerf language reference given to Claude, generated from the same
// builtin tables the evaluator uses so it cannot drift from the code.

import { appReference } from "../apps/reference";
import { SHAPE_FNS, MATH_FNS, modifierDocs, GEO_FNS } from "../lang/builtins";
import { FEATURE_FNS, PATH_FNS, PROFILE_FNS, SELECT_FNS, SOLID_FNS } from "../lang/modelling";
import { AERO_FNS } from "../lang/aero";
import { SHEET_FNS } from "../lang/sheet";
import { MOULD_FNS } from "../lang/mould";
import { SPLIT_FNS } from "../lang/split";
import { SEL_PRESETS } from "../kernel/recipe";
import { UNITS } from "../lang/lexer";
import { LIBRARY } from "../library/components";
import { THREADS, UNIFIED_THREADS, BEARINGS, MATERIALS } from "../library/standards";
import { CALC_FNS, CALC_PARAMS } from "../machine/calcs";
import { CATALOG, CATALOG_KINDS, catalogOfKind } from "../machine/catalog";
import { FLAVOR_NAME, boardFlavors } from "../machine/firmware/printer";
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
  kmh: "speed (mm/s)",
  mph: "speed (mm/s)",
  bar: "pressure and stress (MPa = N/mm²)",
  psi: "pressure and stress (MPa = N/mm²)",
  C: "temperature (°C)",
  Hz: "frequency (Hz)",
  kHz: "frequency (Hz)",
  degC: "temperature (°C)",
  cfm: "volume flow (mm³/s)",
  lpm: "volume flow (mm³/s)",
  lps: "volume flow (mm³/s)",
  cmh: "volume flow (mm³/s)",
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
  const printers = ctrl.filter((p) => boardFlavors(p).length).map((p) => `${p.id} (${boardFlavors(p).map((f) => FLAVOR_NAME[f]).join(" or ")})`);
  return `Arduino sketch (the .ino, pins.h, config.h and a README with the bring-up steps): ${arduino.join(", ")}. 3D printer boards, with the firmwares Kerf writes for each (the first is the default): ${printers.join(", ")}. Klipper gives printer.cfg, Marlin gives Configuration.h and Configuration_adv.h, RepRapFirmware gives sys/config.g with the homing and probe macros; each comes with a README of the build, flashing and calibration steps.`;
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
- held: "text": how a board, module, supply or battery (or any part) is held when the model cannot show it ("double-sided foam tape", "hook-and-loop strap", "M5 screws into T-nuts in the extrusion"). Without it, the mounting check needs screws through two of its holes into something (or one screw and a peg), or parts that close it in on every side, and the held-in-place check needs it fastened, fitted or pivoted to the parts on the floor.
- leads: "soldered": the wires are soldered straight to a board's pads, with no plugs, and leave it upwards. For tight spaces where a plug and its lead have no room (small modules in a tube, header pins that point down into a shelf).
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
wire bat.POS -> xt.POS_A -> xt.POS_B -> fuse.IN { gauge: 14, insulation: "silicone", color: "red" }   // a chain is one wire per hop; insulation: "silicone" rates high-strand RC wire in free air (default "pvc": building-wire ratings)
net GND: ctrl.GND, drv.GND, imu.GND { gauge: 24, color: "black" }             // named net: every listed pin on one conductor
wire skr.XM -> motor_x.PLUG                                                    // port to port: one cable
net V12: reg12.OUT, c_12.PLUS, u1.VPOS { width: 0.8mm }                    // on a circuit board: copper, not a cable
schematic { ctrl: (40, 60)  drv: (160, 60, 90)  leds[2]: (220, 20) }        // where symbols sit on the schematic sheet (mm, y down; a third number turns it 90/180/270)
Properties: gauge (AWG), color, label (wires only). On a lib.circuit_board, nets between on-board pins are routed as copper: width (mm) sets the track width (supply and current-carrying nets are widened automatically); pour: true fills the board's spare copper with that net (Kerf pours the ground net on its own unless one net says pour: true or a net says pour: false). Net names are unique; list all of a net's pins in one net statement. A pin may appear in several wires and nets: they join into one electrical net.
Give every power and motor conductor a gauge sized for its current (calc.wire_gauge); the wiring rules check each wire and each net's gauge against the current through it, motor leads and ground returns included, and use red for supply, black for ground and distinct colours for signals; 22 to 26 AWG suits logic signals.
The schematic (build tab, Wiring, Schematic) draws every part with pins as a symbol: two-pin nets as wires, ground and supply nets as ground and supply symbols, bigger nets as net labels. One schematic block per design changes only the drawing; parts it leaves out are laid out in columns. The person can drag and turn symbols there (which rewrites the block) and click two pins to add a wire line.
Ports are multi-conductor connectors: stepper4, fan2, heater2, therm2, endstop3, probe5, usb. Join a board port (source) to a device port (sink) of the same kind with one wire; never wire a port to a single pin.
Pin types in catalog_lookup: gnd; pwr_in (needs vmin–vmax V, damaged above vabs; "draw" is its own current); pwr_out (supplies v at up to imax A); pwr_rail (a board rail that supplies its voltage unless something else feeds it); io (controller GPIO at its logic voltage, with pwm, adc, irq, input-only and bus roles such as i2c_sda); in (module input: tolerates vmax, reads high above vih; "needs pwm" means drive it from a PWM pin); out (module output; "needs irq" means read it on an interrupt pin); analog_out (needs an adc pin); motor_out (driver output terminal, channel A or B); motor (motor terminal); passive (switch, fuse or connector terminal, joined to its partner when closed); port. "required" pins must be connected.

### Belts
component belt_x = lib.belt("gt2_6mm", path: [(xc - 24, -69, z_xp + x_pulley.pd / 2), x_pulley, x_idler, (xc + 24, -69, z_xp + x_pulley.pd / 2)], tension: x_tension, mass: 600, accel: 3000, friction: 5N) { role: "x" }
component loop = lib.belt("gt2_6mm_loop", path: [motor_pulley, big_pulley], tension: 12N, torque: 0.4Nm)
A belt is placed by its path, so it takes no at: or axis:. An open belt (bought by the metre: gt2_6mm, gt2_9mm, gt2_6mm_steel) starts and ends at its two clamp points; put each point on the pitch line (the pulley's centre plus or minus pd / 2) inside the clamp's slot. A closed loop (gt2_6mm_loop) lists pulleys only and is matched to the nearest stock loop. Pulleys go in the order the belt meets them; a lib.bearing works as a smooth idler, and outside: [idler] runs the belt's back on it. Kerf draws the real GT2 profile on the detailed build, finds the motor on the drive pulley's shaft, and works out the pitch length, cut length, pluck frequency of each span, stretch, stiffness and ringing, slack and tight sides at peak load, teeth in mesh and the pull on the motor's bearings. Make the installation tension a param (8 to 25 N for a 6 mm glass fibre belt) so the user can tune it.
Fields: length, cut_length or stock_length, tension, stretch, hz and span (the longest free span), stiffness, stiffness_min (N/mm), ringing_hz, lag (mm), tight, slack, teeth_in_mesh, hub_load (N); points start and end.

### Engineering calculations
let sand = calc.sand_stress(depth: 9.5m, box_w: 1m)
let screw = calc.screw_burrow(d: 90, core_d: 70, length: 150, pitch: 40, sigma_v: sand.sigma_v, sigma_h: sand.sigma_h, face: true)
let point = calc.motor_point(motor: drive, load: screw.torque)
A let that holds a calculation records its working (inputs, method, assumptions, how far to trust it, what a test should confirm) in the design's calculations, shown to the user. Results are fields in base units (mm, N, N·mm, MPa, V, A, W, s, rpm): feed them into other calculations, load:, firmware settings and require lines. Arguments are named; anything in brackets in the descriptions below is the default. Confidence: standard (textbook method), estimate (sound method, some inputs guessed), rough (little published basis: can be off by 2× and needs a physical test). The engineering_calc tool runs one calculation outside the design.
${calcDocs()}

### Firmware
firmware brain { board: ctrl, behaviour: "Dig forward holding heading; back off on stalls; stop at the far side", run_distance: 1100mm, start_delay: 10s }
Kerf generates the code from the wiring, so every pin number matches the harness: change the wiring, never the generated pin files. ${firmwareBoards()} Settings are numbers, text or true/false; times are in seconds (10s, 500ms) and distances in mm.
Arduino boards: behaviour text that mentions a ride (ride, carousel, roundabout, merry-go-round, Ferris, teacup, pirate ship, fairground, theme park) gives the ride controller; text that mentions tunnel, burrow, sand, drill, dig or bore (with DC motors on drivers) gives the autonomous tunnelling program; anything else gives the bench program (a serial console that drives each motor and reads each sensor). Both include the console. The generator finds:
- DC motors and actuators through the driver channel their M_PLUS/M_MINUS are wired to (control schemes: pwm_dir, rpwm_lpwm, in1_in2_en, in1_in2_pwm, in1_in2_pwm_both); the front and rear motors by name or role (front/nose/head, rear/back/tail); the steering actuator or servo by steer or hinge. Driver current-sense pins wired to analog pins give stall detection.
- encoders (ENC_A on an interrupt pin, ENC_B), actuator position feedback (FB on an analog pin), servos (SIG; on AVR boards the Servo library disables PWM on pins 9 and 10), a BNO055 or MPU-6050 on the I2C pins, battery voltage through voltage_sensor_25v.S, and the battery's cell count.
- settings (default): start_delay (10 s), run_distance (1100 mm), max_run_time (3600 s), power (0.8 of full PWM), pitch (40 mm screw pitch), slip (0.5), stall_current (80 % of the front motor's stall current, A), stall_time (0.6 s), backoff_time (1.5 s), max_retries (8), breakthrough_current (0.5 of the front motor's digging average), give_up_time (0 s = none: back out if there is no breakthrough by then; it also backs out at twice run_distance by the turn count), roll_limit (60 deg: stop if the body rolls past it), motor_hot_rise (60 K: estimated motor rise above its surroundings that is too hot; digging backs out at 3/4 of it without a breakthrough), motor_cooling (0.5: share of free-air cooling the motors get where they run), max_rest_time (1200 s: a rest on the way out that hasn't cooled the motors by then ends the run), rear_free_current (3 × the rear motor's free current, A: backing out stops once the rear motor stays below it for 2 s, because its screw is out of the sand), heading_kp (1.5), heading_ki (0.05), steer_max (8 deg), steer_sign (1 when extending the steering turns the nose clockwise seen from above, the way the IMU heading grows; -1 when anticlockwise), steer_arm (40 mm, hinge pin to where the actuator or cam pushes), steer_slope (1: sideways movement per mm of stroke; the slot slope for a cam), steer_deadband (0.4 mm of actuator position error ignored), steer_mid (half the actuator stroke, mm), roll_kp (0.01), roll_trim_max (0.25), low_cell (3.4 V per cell), log_interval (5 s).
Ride controller: boarding lights until the start button (a switch with role "start" to ground) or the boarding time, a countdown, each DC motor ramped to its ride speed and held there by its encoder, an optional change of direction, then a slow creep until the hall sensor (a sensor with iface hall, e.g. hall_ky003, seeing a lib.magnet on the moving part) sees the station magnet, so the ride always stops at the platform. A voltage_sensor_25v on the motor supply behind an emergency stop switch tells it the stop was pressed: it flashes the lights red and waits for start. Every addressable LED board (lib.led neopixel_*) on the data chain from the board, through DOUT to DIN and through slip ring circuits, plays its own show; an LED's brightness: (0 to 1) caps its current in the checks and the code. Settings (default): <motor>_rpm (half its free speed), ride_time (30 s), ramp (4 s), boarding (8 s), countdown (3 s), reverse (false: 60 % one way, 40 % the other), creep (0.25 of ride speed), station (true when a hall sensor is wired), estop_volts (6), brightness (1), <led>_show (rainbow, chase, comet, sparkle, breathe or twinkle). In a scenario, firmware: <name> with mechanism: sim.mechanism(sim.motor(<motor>)) runs the code on the simulated board against the mechanism; results include fw.stops, hall.passes, <led>.shows and <led>.colours. The Teacups, Ferris Wheel and Pirate Ship templates show it with LEDs on moving parts through a slip ring (lib.connector("slip_ring_12mm_6"), body in the frame, turns_with: the moving part).
Arduino Nano or Uno with app: "tuner": a chromatic guitar tuner instead of the tunnelling or bench program. It reads the analog pin wired to the signal (bias it at 2.5 V) with the free-running ADC, shows the note and cents on an SSD1306 OLED on the I2C pins, and uses a button to ground (pin wired through a switch) to step the reference pitch; settings: ref_hz (440; the button steps 432 to 445). The Practice Amp with Tuner template shows the circuit around it.
3D printer boards (Klipper, Marlin, RepRapFirmware): flavor: "klipper", "marlin" or "reprapfirmware" (also "rrf") picks the firmware; left out, the board's first one. A flavor the board cannot run writes nothing and names the boards that run it. Axes come from the board port each stepper is cabled to (X…, Y…, Z…, E…) or the stepper's role ("x", "y", "z", "extruder"); hotend and bed heaters and thermistors from their heater2 and therm2 cables (a heated_bed part is the bed); fans by role or port label (part/blower, hotend/heatsink, controller/electronics); endstops from XSTOP/YSTOP/ZSTOP or, on boards whose ports do not name an axis (a Duet's IO_5), the switch's role ("x endstop"); a probe5 cable makes the probe the Z endstop. Rotation distances come from GT2 pulleys (role "x"/"y"), the lead screw and the extruder. Marlin takes its pins from the board's pins file, so each device must be on its standard port (XM, YM, ZAM, E0M, HE0, HB, TH0, THB, FAN0 for the part fan, XSTOP, YSTOP, PROBE): Kerf warns when one is not. RepRapFirmware names every port in config.g, so any port of the right kind works (Duet ports: DRIVER_0…, OUT_0 bed, OUT_1 and OUT_2 heaters, OUT_3… fans, TEMP_0…, IO_0… endstops, IO_3 BLTouch).
- settings (default): x_size (220), y_size (220), z_size (250) in mm; kinematics ("cartesian"); max_velocity (300 mm/s); max_accel (3000 mm/s²); x_rotation_distance, y_rotation_distance (from the pulley, else 40), z_rotation_distance (the lead screw's lead, else 8), e_rotation_distance (the extruder's, else 22.68); x_run_current, y_run_current, z_run_current, e_run_current (A RMS, from the motor rating and the driver limit; RepRapFirmware's M906 gets the peak, √2 × this); probe_x, probe_y (probe offset from the nozzle, -40 and -10 mm); pressure_advance (0 = off: Klipper pressure_advance, Marlin ADVANCE_K, RepRapFirmware M572); square_corner_velocity (Klipper, 5 mm/s); junction_deviation (Marlin, 0.013 mm); jerk (mm/s: Marlin switches to classic jerk when it is given; RepRapFirmware's M566 X/Y, 15).
Firmware warnings (for example a motor whose driver pins are not wired) come back with the checks (after every edit, and from run_checks).
Your own code: code: "own" in an Arduino block (firmware lights { board: ctrl, code: "own" }) runs a sketch you write in place of Kerf's, kept with the project beside the design: one .ino and any .h, .c and .cpp files, flat as in a sketch folder. read_firmware shows a block's code (Kerf's or its own) with line numbers, its pin table and whether it compiles for the board. edit_firmware: use_own starts the block's own code from Kerf's, write gives a file its whole text, edit replaces one exact piece of text that occurs once, rename and delete, reset starts again from Kerf's, use_kerf goes back to Kerf's code and keeps the files. Each change comes back with the first compile error and the lines round it, or the RAM it uses. Take pin numbers from the pin table, never guess them. The simulated board runs the code as the chip does, at its clock speed and with its RAM: C and the C++ that sketches use (functions, structs, enums, arrays, pointers and references, function pointers, static locals, switch, casts), not classes or templates of your own, and no String class (use char arrays and snprintf). Libraries: the Arduino core (pins, analogRead, analogWrite and ledc, tone, pulseIn, shiftOut, interrupts, millis and micros, Serial and the other UARTs), Wire, SPI, EEPROM, Servo and ESP32Servo, Adafruit_NeoPixel, FastLED (CRGB, CHSV, palettes, its 8-bit maths, EVERY_N timers, brightness, colour correction, dithering and the power limit, as version 3.6 does them), AccelStepper and MultiStepper, LiquidCrystal and LiquidCrystal_I2C, SD and FS on a microSD card, TimerOne, the ESP32's timers, Preferences and BluetoothSerial, and on AVR boards the timer, port and pin-change interrupt registers with ISR(). Any other header is a compile error. Each board runs as its own chip and core, and a pin it lacks or must not use is a fault: Arduino Uno, Nano and Mega 2560; ESP32-DevKitC, Feather ESP32 V2, XIAO ESP32S3 and XIAO ESP32C3 (ESP32 core 3.x, GPIO numbers; the C3's Serial1 defaults to its USB pins, so give it pins); Raspberry Pi Pico (arduino-pico, GP numbers; setup1() and loop1() do not run); STM32F411 Black Pill (STM32duino, pins by name such as PA5; pins with one number share an interrupt); Trinket 5V (ATtiny85: no Serial, Wire, SPI, Servo or tone(), and Kerf writes no code for it, so use code: "own"). One difference from the chip: millis() and micros() keep time while interrupts are off, where an AVR loses timer ticks during a long noInterrupts() section or FastLED.show().
debug_firmware runs a variant of a scenario again under the debugger, with a logic analyser on the pins and buses. A breakpoint stops at a file and line (cond: a C condition, hit: from its nth hit on); log: makes it a logpoint that records text with {expressions} filled in and carries on; watches are C expressions read at each stop. Each stop gives its time, function and line, locals, the call stack, the watches, the globals and the lines run just before and after. signals gives what chosen pins (D13, A0, GPIO2) did, with edges, rates, pulse widths and time high, and the uart, i2c, spi and adc traffic, over the run or a window of it. Fix with edit_firmware, then run it again.

### Physical tests and purchases
test "Bucket dig": "Dig 30 cm into a bucket of damp sand at full power; motor current must stay under 6 A and the screws must not slip on their shafts"
buy "M3 socket screw assortment" { qty: 1, price: 12, url: "https://…" }
buy "Plywood for the sand box" { qty: 3, price: 28, search: "18 mm plywood sheet 1220 x 2440" }
A test is a procedure, what to measure and the pass criterion, for anything only a real build can confirm. buy lists something to purchase that has no model or pins (hardware kits, wire, tube, sheet material, a tool): qty, price (USD each), and url (a direct product page) or search (text for marketplace searches).

### Units (literal suffixes; values convert to the base unit shown)
${unitsTable()}
Write a space before a name after a number (2 * width, not 2width).

### Machine checks (run on every rebuild, returned with every edit and by run_checks)
- electrical (basis: electrical rules): supplies, shorts, two supplies fighting, board rails fed the wrong voltage, unpowered required pins, voltage against each pin's ratings, logic levels (5 V into 3.3 V pins), PWM-capable and ADC pins where needed, interrupt pins for encoders, I2C/UART pins, input-only pins, strapping and USB-serial pins, two outputs on one net, motors without a driver, driver current against the motor's load and stall current, motor over-voltage, both motor terminals on one driver channel, port kinds and sides, stepper, fan and heater current against the port, a common ground between parts that exchange signals, required pins left unconnected, a fuse and a switch on every battery, the current budget of every supply, wire gauge against the current in every wire, motor lead and ground return, and each fuse against the thinnest wire after it. A design with a controller and no firmware block gets a warning.
- engineering (basis: calculation): motor load (load:) against stall or holding torque; for every belt, alignment with its pulleys, pulley size, teeth in mesh, slack side at peak load, tooth load, tension range, motor shaft load, stiffness and ringing, and stock loop length; and a summary of the calculations (rough ones are flagged). Heat inside the box: every closed space holding electronics (a hollow printed body, a tube with end walls, or panels on every side) gets the heat its parts lose at their working currents, the air temperature from its walls, openings and fans (a lib.fan inside it or on a wall counts), after the longest simulated run or steady, and each part's rating at that air (drivers derate, LiPos under 60 °C, wall material). Fix one with a fan and vent, a heat sink, less current, a bigger box or a part moved out; sealed designs (sand, dust, water) keep sealed. Service life: brushed motors, bearings (from calc.bearing_life), seals, fans, LiPo cycles, nozzles and screw flights in sand get a life in hours and in runs of the first simulation, with a maintenance schedule (Build tab Service, build pack service.md); anything that wears out within 20 runs is warned about.
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
fn name(a, b: 2) = expr   or   fn name(a) { let t = ...  value }   // your own function: a number, vector, shape or profile worked out the same way in many places, callable after it
feature name(at, d: 8) "what it is" { steps }                 // your own feature: adds, cuts, rounds, for, if and let used in any part as one step, name(...) [as label] (see Your own features and functions)
interface name { field = expr, ... }                          // named contract between parts (screw size, boss size); read as name.field
component name = lib.kind(args) { props and flags }           // standard parts from the library, and purchasable catalog parts
component name = design("Project", param: v) { at:, rotate: } // another of the user's designs placed here as one subassembly (see Designs inside designs)
part name { props, body/add/cut/intersect shapes, modifiers, for/if/let }   // custom solid
mate name = against(face(a, -Z), face(b, +Z))                 // how two parts meet: the first moves to meet the second (see Mates); after both parts
frame name { profile: "2020", box: (w, d, h) or path: [...] }   // structural members along lines (2020 extrusion, steel box, tube, angle), trimmed where they meet, with a cut list (see Frames and weldments)
require "Label" [hard|soft] [for use_id, ...]: condition      // checked every rebuild; hard by default; for links it to brief uses
brief { ... }                                                 // the design brief, once, near the top (see below)
decision name "Title" { ask, chose, by, why, option ... }      // a recorded design choice and its alternatives (below)
configs "Sizes" { show: "M", config "M" { width: 60 } ... }    // variants of the design in one file, as the parameter values each changes (see Configurations)
wire a.PIN -> b.PIN { gauge: 22 }  /  net NAME: a.PIN, b.PIN   // wiring between catalog parts (see Machines)
firmware name { board: ctrl, ... }                             // generated firmware for a controller
test "Label": "procedure"                                      // a physical test the build must pass
buy "Label" { qty: 1, price: 10, url: "https://…" }            // a purchase with no model
app "Name" { telemetry, panels, ... }                          // a live control program for the machine: panels and controls on its twin or the real one over USB (see Apps)
analysis "Label" { props }                                     // a strength analysis, drivetrain duty, UCI rules check, airflow (drag) or flow (cooling, ducts), re-run after every change (see Analysis blocks)

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
Part props: color, material, finish, process (how it is made, see Manufacturing processes), group, label, at (translate the finished part), rotate ((rx, ry, rz) degrees), turns_with (moves with a component or part), spin (driver ratio), axis and axis_at (rotation axis for spin), rides (carried round by a moving part, with its own spin: or mesh: relative to it: a teacup on a turning deck), slides (an axis: it slides along it, pushed by a connecting rod: a piston), swings (an axis: it rocks about axis_at:, pushed by a connecting rod: a rocker, a swing ship), links ([driver, follower] on the connecting rod itself: the turning part and the part that slides or swings; declare the rod after both) with pins ([crank pin centre on the driver, pin centre on the follower]; the rod keeps the distance between them), held ("text": how it is held when the model cannot show it, such as glue, tape or undrawn hardware on the parts list), mass (its real mass when the solid is not: a hollow carbon frame modelled solid, a foam-filled shell; mass: 950g. Weight, balance and the UCI check use it), explode ((x, y, z): the way it comes off in exploded views, when Kerf's choice is wrong; false keeps it on what it sits on). Flags: locked, hidden, removable (removable parts such as lids or covers are ignored by the tool-access check, meaning "removed for assembly").
Order matters: each modifier applies to the body as built so far. Shell right after the body (before bosses, ribs and holes). Fillet a joint right after adding the feature it rounds (fillet(r, edges: boss.root)); fillet outer edges before cutting holes that cross them. A part is limited to 600 operations.
Rounds: full_round(faces: in_plane(Z, 16)) rounds a rib's top right over (rims, plate edges and handles too); fillet([1, 4], edges: …, from: (x, y, z)) grows the radius along an edge from the end nearest from:, for a root that takes more load at one end; fillet(r, edges: between(facing(Z), boss)) rounds where two sets of faces meet; chamfer((3, 1), edges: …, on: facing(Z)) or chamfer(2, angle: 30, …, on: …) cuts an uneven bevel, the first size along the on: face (a long lead-in on a hole, a gentle slope on a ramp).

### Shape functions (use after body/add/cut/intersect)
${shapes}

### Modifiers (inside a part)
${mods}
Direct edits (push_pull, delete_faces, move_faces, replace_faces) change the solid by its faces, as it is at that step, the way a direct modeller does. Use them on an imported body (part bracket { body step("bracket") push_pull(2, faces: facing(Z)) delete_faces(faces: circles(6)) }) or for a late change to a shape built in many steps. On Kerf's own features, changing the number in the step that made them is cleaner. Rounds and chamfers on a face's edges stop push_pull: delete_faces them first and round again after.

## Detailed modelling

### 2D profiles (flat outlines; combine with + and -, move(p, by:), rotate(p, angle))
${docs(PROFILE_FNS)}

### 3D paths (for sweep and pipe)
${docs(PATH_FNS)}

### Solids from profiles and sketches, threads, grips, lettering, ribs
${docs({ ...SOLID_FNS, extrude: SKETCH_FNS.extrude, revolve: SKETCH_FNS.revolve })}

### Ready-made features (use with add; each adds and cuts what it needs and rounds its own root)
${docs(FEATURE_FNS)}

### Streamlined tubes (bike frames, forks, seatposts, aero bars, fairing struts)
${docs(AERO_FNS)}
Build a bike frame as one part, like a one-piece carbon monocoque: each tube an aero_path() whose section changes along it (deep and wide where it meets the next tube, slim between), with role: on each, and the tubes overlapping well inside each other so the joints blend. on: "nose" lays a straight leading edge (head and seat tubes), on: "tail" a straight trailing edge (a flat-topped top tube with wind: -Z). A tube that runs with the wind (a top tube, chainstays, a stem) has no side to streamline: give it wind: Z or -Z so its section stands up. Keep carbon tubes solid (wall: makes booleans slow; a strength analysis of the frame on its own solves it as its laminate anyway) and give the part its real weight with mass: (a 56 cm aero frame is about 1000 g, a fork about 400 g). Give it process: mfg.carbon_layup(pull: Y, slides: [...], cores: true, wall: 1.1) (with plies: [...] in place of wall: once its ply schedule is known): the mould splits on the centre plane, cores slide out between the stays and fork legs, mandrels pull out of the head and seat tubes. Make the bearing seats, thru-axle dropouts, hanger, flat mounts and seatpost clamp real features, and put the ply book on the frame's drawing with note(). The UCI analysis reads each tube's section from the aero_tube or aero_path itself.

### Sheet metal and moulds
${docs({ ...SHEET_FNS, ...MOULD_FNS })}
Make every bent metal part (brackets, covers, chassis, trays, enclosure shells) with body sheet(...), never with boxes and quarter tubes: Kerf then knows its bends, unfolds the finished part into a flat pattern (its own drawing with bend lines and a bend table, and Export → Flat patterns, a 1:1 DXF for the laser), and checks it as sheet metal: flanges long enough to bend (4 × t), flanges that would hit each other at a corner, a flat pattern that overlaps itself or is bigger than a sheet, plus thickness, bend radius against the material and holes too close to a bend. Cut holes and cut-outs after the body; those in flanges come along onto the flat. A bracket: body sheet(rect(60, 40), t: 2, flanges: [flange("back", 50), flange("front", 12, angle: -90)]) then cut hole(d: 5.5, through: true, at: (0, 0, 2), dir: -Z) through the base and cut hole(d: 5.5, depth: 5, at: (0, 17, 30), dir: Y) through the back flange.
Finish a flange's free edge with hem: (folded back flat: a safe, stiff edge on a cover or a hand-held part), roll: (curled round: a smooth edge or a hinge knuckle) or lip:, and fold the base's own bare edges with hem() in the flanges list; step a flange past a mating part (a lid over a base, a panel over a frame) with jog: (at, offset). Give vents in a metal enclosure as louvres: [louvre(length, width, height, count: n)] in the base or on: a flange rather than cut slots: they keep fingers and drips out, stand out of the part by default, open downward on a wall, are kept clear of edges and bends, are checked for room round them (3 × t) and depth (5 × t), and leave the flat pattern a plain blank for the louvre tool.
To cast or mould a part, keep the part as it should come out and add its mould as two more parts, one per half, made by printing or machining: part mould_top { material: "PLA"  process: mfg.fdm()  body mould(knob, half: "top", bolts: M4) } and the same with half: "bottom". Put the halves beside the part with at: (opened like a book, all standing on the floor). The mould follows every change to the part. Give the moulded part the casting material and process (vacuum_cast for polyurethane in a silicone mould, injection for a plastic in a two-plate tool, the casting processes for metal) so its draft, walls and undercuts are checked along the same pull.

### Parts made in pieces
${docs(SPLIT_FNS)}
Model a part bigger than its printer (or machine) whole, as it is used, and give it split: X to have Kerf make it in pieces: it is cut across X into the fewest pieces that fit the part's process (its printer's bed, or the one chosen in Settings), at heights worked out from the part as built, and each joint gets two steel dowel pins (lib.dowel, sized to the joint: Ø3 to Ø6 in prints) placed in solid material well apart, in holes 0.2 mm over in a print (reamed to size in a machined part) that go half a pin deep into both pieces. The pieces are parts of their own, name_1, name_2... (labelled "name (piece 1 of 2)"), each on the parts list and in the print files with its own process checks; the pins are a component name_pins on the parts list. Everything that names the part (mates, analyses, shape_of(), fasteners, require) takes the whole of it, so a split can be added to a finished design without changing anything else. Give pieces(X, at: [..]) to choose the cuts (where the part is solid and plain: not through a boss, a hole or a thin web), count: for equal pieces, join: "glue" when there is no room for pins, and a list for a grid of cuts ([X, Y] for a big flat panel). The checks report how it was cut, each piece's size, the pins, and any joint with no room for them (thin walls): move the cut to where the part is solid or thicken it there. A part that moves, a sheet() part and a carbon layup are made whole.

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

### Your own features and functions
When a detail appears more than once (screw bosses, mounting tabs, a rib with its fillets, a vent row), write it once as a feature and use it where it goes:
feature boss(at, d: 8, h: 10, screw: M3) "Screw boss for a self-tapping screw" {
  add cylinder(d: d, h: h, at: at) as post
  cut hole(screw, depth: h - 1, at: at + (0, 0, h), fit: "tap")
  fillet(0.6, edges: post.root)
}
part case {
  body box(80, 60, 2)
  boss((-30, -20, 2))
  boss((30, 20, 2), d: 10) as big
  chamfer(0.4, edges: big.tip)
}
A use is one step on its own line (add boss(...) reads the same). Give its values in place or by name; one with a default (d: 8) can be left out, and a default may use the parameters before it (h: 2 * d). Everything a use makes goes under its name, as label or else boss#1, boss#2 in order, and label.root, label.tip, label.edges and label.faces pick it like any named step, so one use can be rounded or chamfered from the part. Names given with as inside the feature belong to each use (post is that boss's own post, which the part picks as big.post), so two uses never share one. A feature sees its parameters, its lets and the design's params, lets, functions and features, but not the part's lets: pass what it needs, a named step of the part (round_off(of: fin)) or another feature (pegs(3, f: peg)) included. It is steps only (color:, material: and the other properties belong to the part), and it can use other features but not itself.
For a value, write a function: fn wall_for(span, min: 1.6) = max(min, span / 40), or with lets in braces and the value last: fn web(len, h: 8) { let t = wall_for(len)  box(len, t, h) }, used as add web(40). A function can call itself (fn fact(n) = n <= 1 ? 1 : n * fact(n - 1)), up to 100 deep. Kerf's own names (box, hole, rib, max...) can't be used for either. An error inside one is marked where it went wrong and says which use it came from.

### Designs inside designs
Another of the user's designs (a project on the Projects page) can be placed in this one as a subassembly that stays linked to it:
component left_mount = design("Motor mount", width: 70, config: "Small") { at: (60, 0, 8), rotate: (0, 0, 90) }
Give the design's own parameters by name (each is checked against the ones it has, its type and its range) and config: to read it as one of its configurations. It is read with those values every rebuild, so changing that design changes every design that places it. It takes at: (its own origin goes there), rotate: (rx, ry, rz) degrees, group: and label: (its parts show as one group, the design's name by default), held: for how all of it is held, explode:, and the flags locked, hidden and removable; its parts' own sizes, materials and processes are set in that design, not here.
What it makes becomes part of this design, named after the component: its part base is left_mount_base, its screws left_mount_screws, its bought parts, wires, nets, frames and cut lists likewise, and its own requirements are checked here as "Motor mount: <label>" with the values given. Read into it with left_mount.base (a part, for shape_of(), min_distance() and mates), left_mount.params.width, left_mount.<let or param> for its numbers, and left_mount.place((x, y, z)) for where one of its points (in its own coordinates) is here, left_mount.turn(d) for a direction: holes for its screws are cut hole(M3, depth: 6, at: left_mount.place((27, 0, 0)), fit: "tap"). Wire to its bought parts by their names here (wire left_mount_motor.A+ -> driver.OUT1).
It moves as one body: a mate on any of its parts (concentric(axis(left_mount.plate, d: 22), ...)) moves all of it, parts: [left_mount] analyses all its parts and face(left_mount, -Z) is the side of all of them. Like any part, it has to be fastened or say how it is held. Its firmware, bench and simulated tests, analyses and drawings stay in it. A design can't place itself, or one that places it; it can't place a design that uses imported files yet (place the file here with step()). Each placement is its own component (at: takes one point); a design that is not a project yet has to be made one first.

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
Shapes the editor's tools write, the same way by hand: a centred rectangle is four lines with horizontal l1, l3 and vertical l2, l4 plus symmetric l1.start, l2.end, origin; a rectangle at an angle uses perpendicular l1, l2 with parallel l1, l3 and parallel l2, l4; a regular polygon is n lines in a loop with every start on a construction circle (coincident l1.start, c1 …), equal l1, l2, … and the circle's diameter as its size across the corners; a slot is two lines and two arcs, all tangent, with equal arcs.
Splines and ellipses: spline s1 = (60, 0), (70, 12), (80, 6), (90, 18) is a smooth curve through its points in order (s1.start, s1.end, s1.p2 …; closed: true runs it round to the first point); ellipse e1 = (25, 10), rx: 8, ry: 4, angle: 30 has radii along its own axes, turned counter-clockwise in degrees, and its centre is e1.center. A spline bends smoothly through every point (no loops or kinks between them) and joins lines and arcs by sharing points (spline top = l2.end, (40, 32), (20, 24), l4.start), so aerofoils, cams, handles and organic outlines are a few points plus dimensions on those points. An ellipse's rx:, ry: and angle: are written values (params work), not solver unknowns; constrain or dimension its centre like a point (concentric e1, c1; distance e1, p). Neither can be tangent, trimmed, extended or offset yet, and a point can't be put on one: share a spline's own points instead.
Copies: mirror, pattern and offset (above) make geometry that follows its original, with the constraints that hold it, so a fully defined original gives fully defined copies: don't dimension the copies again. Put the statement after the geometry it copies; later lines can start on a copy's points (l1_m.end). Use them for symmetric outlines (draw half, mirror about y_axis), hole rows and bolt circles (pattern c1, count: 6, around: origin) and walls or clearances round an outline (offset l1, l2, l3, l4, by: -2). The editor's Project tool brings a part's face in as lines, arcs and circles under one fix statement: fixed copies that do not follow the part. A DXF drawing the user imports comes in the same way, as a sketch named after the file (or added to the open one), its curves sharing points and held by fix lines under a // from file.dxf comment: extrude it as drawn, or delete its fix lines to dimension and change it.
Use sketches for profiles that are awkward to build from primitives (bent plates, cams, levers, gussets, custom outlines, turned parts) and whenever the user wants to edit a profile by hand. Primitives are still fine for plain boxes, cylinders and holes.

${processReference()}

## Components
component name = lib.kind(args) { at: point, axis: dir, ... }
Props: at (a point, or a LIST of points to make a pattern of identical instances: name#1..n; use name.all[i] or name.count), axis (orientation for axial parts), facing (horizontal direction for connectors), rotate, spin (drives the mechanism: spin: 1), mesh (gears: mesh with another spur_gear; the phase and speed are computed so teeth interleave), turns_with (locks to another component's rotation, e.g. a gear on a motor shaft), rides (carried by a moving part: a planet gear with rides: carrier and mesh: sun turns round the sun as the carrier turns), slides / swings / links / pins (a connecting-rod linkage, as for parts; at: is the pivot for swings), held ("text": glue, tape or undrawn hardware), explode ((x, y, z) or false, as for parts), color, group, material, finish, label. Flags: locked, hidden, removable.
Component fields are world-space after placement (motor.holes is a list of world points). Moving components get .speed (rotation ratio relative to the driver). Pattern components expose fields of the first instance plus .all and .count; shape fields (like usb.opening) become lists so \`cut usb.opening\` works.

${lib}

## Mates
Place a part by how it meets another instead of working out its at: and rotate:. Mates come after the parts they join, and the part can be drawn roughly where it goes:
part lid { at: (0, 0, 60) body box(80, 50, 4) }
mate seat = against(face(lid, -Z), face(box, +Z))        // the lid's bottom face on the box's top face
mate front = flush(face(lid, -Y), face(box, -Y))         // front faces level
mate hinge = pin(axis(lid, d: 3), axis(box, d: 3))       // in line with the box's 3 mm hinge holes, centred along them
mate stop = angle(face(lid, +Z), face(box, +Z), min: 0deg, max: 110deg)   // free to open between these
What a mate holds by: face(part, -Z) (the flat face facing that way, the one farthest out that way; near: (x, y, z) takes the face nearest a point instead), axis(part, d: 5) (the axis of a round face: a hole, shaft, boss or countersink; d: its diameter, near: a point by it and along: its direction tell them apart; axis(part, at: (x, y, z), dir: Z) is a line fixed to the part), point(part, (x, y, z)), plane(part, at: (x, y, z), normal: +Z) (a centre plane or datum the part has no face on). Every point is where the part is drawn. Parts and components can be mated; mate one instance of a pattern on its own.
Kinds: against (two flat faces touching, facing each other; gap: leaves a space), flush (level, facing the same way; offset:), concentric (two axes in line: it can still turn and slide), pin (in line and centred along each other: it can still turn; offset:), parallel, perpendicular, angle (two faces or two axes, an angle or min:/max:), distance (faces, axes or points, mm or min:/max:), tangent (a flat face on a round one, or two round ones), coincident (two points, a point on a face or an axis, two faces in one plane or two axes in line), rigid(a, b) (fastened together: a moves with b). Joints by their usual names: revolute (= pin: only turns), slider (two axes in line and kept from turning: only slides, e.g. slider(axis(carriage, d: 8), axis(rail, d: 8)); give travel with distance(..., min:, max:)), cylindrical (= concentric), planar (two faces in one plane: slides on it and turns about its normal; offset:), ball (two points together: turns every way).
The first part named moves to meet the second, which stays where it is drawn unless its own mates move it; parts are solved from the ones nothing moves, and parts that move each other are solved together. Each part moves as little as it can, so whatever its mates leave free (a hinge's turn, a carriage's slide) stays as drawn: draw a lid open to show it open, and the user can drag it in the 3D view. A mate that cannot hold with the mates before it is left out and reported with how far off it is (fix or remove one of the two); a part held at a min:/max: is noted. Each part's mates, and what it can still do in words, are in the design's mates. Fields of a mated component (motor.holes, a shaft's axis) read by the design stay where it is drawn, so place a component that other parts are cut from with at: and mate those parts to it. Mates place parts for the checks, drawings and exports; spin:, swings: and links: still drive the mechanism.

## Frames and weldments
frame stand {
  profile: "2020"               // "2020" or "2040" V-slot (bought, cut square, joined with corner brackets: call place_fasteners after), or a welded section: "box 40x40x3" (width x height x wall), "tube 26.9x2.6" (outside diameter x wall), "angle 30x30x3", "flat 40x5", "bar 20x20", "rod 12"
  box: (400, 300, 250)          // outside size: 4 full-height posts and rings of rails along X and Y at the bottom and top, centred on x and y, standing on z = 0; box: (w, d) is one flat rectangle
  levels: [120]                 // more rings of rails, at these heights (to the rails' centre lines)
  path: [(x, y, z), ...]        // or members along lines through their middles, one per step; repeat path: for more runs. path: side takes a sketch's lines (not construction lines), path: side.l2 one line
  rotate: 90                    // turns every member's section about its own line (2040 lying flat)
  ends: "miter"                 // sections only: two members meeting at a corner are cut at half the angle (default "butt")
  material: "Steel"             // sections: "Steel" (default), "Aluminum 6061", "Stainless 304"; profiles are aluminium
}
More props: at (moves the whole frame), color, finish, group, label, held (sections default to "welded to the rest of the frame"), explode; flags locked, hidden.
Where lines end together an upright runs through, then the longer member, and the others stop against it. A line that ends on another member (on its centre line or on its face) stops at that member's face. Sections meeting at an angle are cut on the slant to sit flat, and tubes are coped round the tube they meet. Each member becomes a component (2020/2040: lib.extrusion, on the parts list and the cut list as stock cut to length) or a part (sections: bought stock) named stand_1, stand_2... in order (a box frame: the 4 posts, then the rails ring by ring). Edits to a member go to its frame block. Read the frame as stand.members[i] (.start, .end, .from, .to, .mid, .dir, .length, .role: "post", "rail" or "brace"), stand.count, stand.length (total stock, mm) and, for a box frame, stand.w, stand.d, stand.h. The parts list shows each frame's cut list (lengths, end cuts and bars to buy). Members that cross or lie along each other are warned about: end one line on the other instead.
Analysing a frame: name it in an analysis (parts: [stand], fix: face(stand, -Z) holds the feet, load: force(face(stand, +Z), (0, 0, -500N)) loads the top rails), or name single members (face(stand_5, +Z)). A frame on its own is solved as beams through the members' centre lines, joined rigidly where they meet: quick and exact for slender members. The result lists each member's axial force (pushed or pulled), bending and twisting, peak stress and safety, draws the stresses on the real members, and warns when pushed members would buckle under 3× the loads (add buckling for the shapes). Bolted V-slot corners give a little, so a real extrusion frame bends somewhat more. Beams do not show stress inside joints, at holes or welds: elements: "solid" analyses the members as solids (with other parts too, such as a plate bolted on); elements: "beams" insists on beams. Beams do not do modes:, drop:, heat, fatigue, touching:, preload: or large_deflection yet; those analyse the frame as solids.
Analysing thin walls: a carbon_layup part (a bike frame, fork or bar) and a sheet() part are analysed as shells when they are all the analysis names: a layup as its laminate under the outer surface (as thick as the process's wall:), a sheet part as its sheet. Shells follow a thin wall bending, stretching and rippling with a few thousand triangles, and the result lists each wall's peak stress on either face and its safety, and warns when the walls would buckle under 3× the loads (add buckling for the shapes). A layup analysed with other parts (metal dropouts, bolts) is solved as solid carbon, far too stiff and strong: analyse it on its own. elements: "shells" makes any thin-walled part a shell (a moulded case, a printed duct), as thick as it measures; it fails on a part that is not one even wall. elements: "solid" analyses the real shape. Shells do not do modes:, drop:, heat, fatigue, touching:, preload: or large_deflection yet, and treat a laminate as even and quasi-isotropic unless given its plies.
Composite plies: give a carbon layup its plies once, in its process: process: mfg.carbon_layup(pull: Y, plies: [plies("0", "carbon woven"), plies("[0/±45/0]2s"), plies("[0/90]2", zone: zone(at: (0, 0, 0), r: 45), name: "bottom bracket")]). They make its wall and weight (leave wall: out), the process checks list them as its ply book, and every analysis of the part lays it up with them. An analysis's own layup: replaces them there, for a what-if: layup: gives a carbon layup its real plies in place of the even laminate: layup: plies("[0/±45/90]s") for every layup analysed, or a list laid from the outer surface inward, like layup: [plies("0", "carbon woven"), plies("[0/±45/0]2s"), plies("[0/90]2", zone: zone(at: (0, 0, 0), r: 45), name: "bottom bracket")]. A plies() with zone: lays its plies inside the stack over that region only (joints, bearing seats, bolt holes); part: keeps one to a part. Codes: each ply's angle from 0° (counterclockwise seen from outside), outer ply first; "s" mirrors the stack, a count after brackets repeats it, 0₂ is two 0° plies, ±45 a pair. Materials: "carbon" (T700-class UD, 0.12 mm plies), "carbon im" (T800), "carbon hm" (M40J), "carbon woven" (3K twill, 0.22 mm), "glass", "glass woven", "aramid"; t: sets the ply thickness. 0° runs along each tube on a part made of tubes (a frame, bars, a drone arm) and along the part's length on a flatter one; fibre: X lays it along a direction instead, fibre: "tubes" always along the tubes. The plies set the wall's thickness (the process's wall: is not used). Each ply is checked at its top and bottom by Tsai–Wu: the safety is the factor on the loads at which the first ply gives way (first-ply failure, usually the resin cracking across its fibres), with which ply and how, every ply's own factor, and the factor at which fibres break. To lay up a part: 0° plies where it bends, ±45° where it twists, 90° against crushing, more plies in zones where loads go in, and a woven outer ply against knocks; aim for a first-ply safety of 2. Ply strengths are typical values: the prepreg's data sheet signs it off.

${drawingReference()}
${importsReference()}

## Standard data
Threads (use M3 etc. directly as values: M3.clearance, M3.tap, M3.head_d, or pass M3 to hole() and lib.screw()):
${threads}
Inch (Unified) sizes are written as text, not constants: ${Object.keys(UNIFIED_THREADS).map((k) => `"${k}"`).join(", ")}, for hole(), lib.screw("1/4-20", 19.05), lib.nut() and calc.fastener(inch: true).
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

## Configurations
Variants of one design kept in one file (a family: S, M and L; left and right hand; 2 or 4 bays), each a row of the parameter values it changes. Use them when the user wants several versions to make, not one choice (that is a decision).
configs "Sizes" {
  show: "Medium"                                     // the one the design is read as now; leave it out to read the params as written
  config "Small" { width: 40, depth: 30 }
  config "Medium" { width: 60, depth: 45 } "The one most people buy"
  config "Large" { width: 80, depth: 60, wall: 3 } "For the big drill set"
}
One configs block per design, at the top level, after the params. A row's values are written out (numbers with units, text, true/false), never worked out from other names; the geometry follows from the params as usual, so derived sizes go in let, not in the rows. A param a row leaves keeps its own value, shared by every row that leaves it. While a configuration is shown, edits to the values it sets (set_params, the params panel, a decision's option) change its row, not the param line. Switch by changing show:. The checks read every other configuration too and report any that does not build, fails a requirement or goes outside a param's range (config:<label> items); fix those in the row or the design. File → Export → every configuration writes each one's parts and parts list, with the family table.

## Analysis blocks
A structural analysis says how parts are held and what loads them. After every build the app solves a finite-element model of the named parts (bonded where they touch, unless touching: makes them contacts) and adds strength and stiffness checks.
analysis "Shelf load" {
  parts: [bracket, gusset]                  // optional: defaults to the parts that face() names
  fix: face(bracket, -Y)                    // held in every direction (screwed or glued to the wall)
  fix: zone(at: hole_pos, d: M4.clearance + 2, axis: Z, length: 5)   // a bolt hole: the bore surface
  fix: roller(face(bracket, -Z), Z)         // only stops movement along Z (resting on a surface)
  fix: pin(zone(at: pivot, d: 6, axis: Y, length: 8))   // a pin through a bore: holds it across and along the pin, turns freely, bears only where pressed (tight: true holds all round)
  fix: spring(face(foot, -Z), 800)          // an elastic support: rubber feet or a soft mount, 800 N/mm in all (axis: Z for one way; per_area: 1.5 for a pad)
  fix: displace(face(hook, +X), 1.5mm, dir: -Z)   // a set displacement instead of a force: push a snap hook or clip this far; the result gives the force it takes
  touching: touch(bracket, gusset, mu: 0.3) // optional: touching parts as contacts instead of glued (they press, part and slide); "all" for every pair that touches
  preload: bolt(screw_1, torque: 2Nm)       // optional: screws and bolts tightened before the loads go on (bolt(screw_1, 3kN) to a tension; "all" for every one analysed)
  load: force(face(bracket, +Z), (0, 0, -shelf_kg * 9.81N))   // total force spread over the region
  load: bearing(zone(at: axle, d: 22, axis: Y, length: 7), 300N, dir: -Z)   // a shaft or bearing pushing on a bore: cosine-spread over the side it presses (prefer it to force() on bores)
  load: pressure(face(lid, +Z), 0.02MPa)
  load: torque(zone(at: hub_pos, d: 8, axis: Z, length: 6), 0.5Nm, axis: Z)
  gravity                                   // self-weight; or accel: (0, 0, -3) for 3 g
  material: "PETG"                          // optional: overrides the parts' material
  printed                                   // plastic parts are FDM printed (an fdm process or a filament material already is; printed: false for moulded); build: Z sets the layers' direction for every part
  cycles: 1e5                               // repeated loading: over 1000 adds a fatigue check (see Fatigue below)
  safety: 2                                 // required lowest factor of safety (default 2)
  max_deflection: 0.5mm                     // optional stiffness limit
  resolution: "standard"                    // "draft" ~8k elements, "standard" ~30k (default), "fine" ~110k, or a cell size like 0.6mm
}
Touching parts are glued where they touch unless touching: says otherwise. touch(a, b, mu: 0.3) makes a pair a contact: it bears when pressed, comes apart when pulled (lift: false stops that) and slides once friction lets go (mu: 0 slides freely, "rough" never slides). touching: "all" does that for every pair that touches except screws, nuts and inserts (they stay glued); touch(a, b, mu: "glued") keeps one pair glued under it, and touch("all", mu: 0.2) sets the friction for all. The result gives each pair's share pressed, apart and sliding, the force across and along the faces and the peak contact pressure, and fails when the loads pull a part off or slide it away with nothing else holding it. Use it where the joint's behaviour matters (a lid resting on a box, a part clamped between others, a block pushed sideways); it takes several solves, so leave it out where glued is close enough. It does not go with modes:, drop:, buckling, fatigue or topology:.
Screws and bolts are glued in like the rest unless preload: tightens them. bolt(screw_1) tightens one as it usually is (75 % of its proof load into a nut, standoff or metal; the usual hand torque into plastic, wood or an insert), bolt(screw_1, torque: 2Nm) by the torque it is done up to, bolt(screw_1, 3kN) to a tension, and preload: "all" (or bolt("all", torque: 1Nm)) every screw and bolt analysed. Each one's head bears on the part under it, its shank stands free in its hole and its thread holds in the nut, insert or standoff it reaches, or else in the part it goes into; the parts it clamps become contacts (μ 0.3, or what touching: says). The result gives each bolt's tension, before and under the loads, its stress and the share of its proof load it uses, and fails when a bolt is stretched past its proof load or the loads open or slide the joint with nothing else holding it. Use it for a bolted joint that is pulled apart or pushed sideways (a flange, a bracket screwed to a wall, a clamp); a joint only pressed together needs no preload. It takes several solves, and does not go with modes:, drop:, buckling, fatigue or topology:.
fix: and load: may repeat or take lists. Units: N, kN, lbf, kgf (weight of a kilogram: 5kgf = 49 N; kg is a mass in grams, so never kg × 9.81N), Nm, Nmm, MPa, kPa, bar, psi, GPa, and speeds in kmh or mph. Inside an analysis block these functions exist:
${analysisFns}
Look at a result with capture_view results: ("stress", "safety", "disp", "strain", "temp", "current" or "life"); add section: to cut it open, and the cut face shows the field inside the parts (whether stress or heat runs through a section or stays near the surface).
A drivetrain analysis gives a gear train's duty instead; the app checks tooth bending (Lewis), bearing L10 life and shaft torsion for every gear and bearing the driver turns:
analysis "Gearbox duty" {
  drive: motor_gear        // the component that drives the train
  torque: 0.3Nm            // input torque
  speed: 3000rpm           // input speed
  life: 2000h              // required running life (sets fatigue cycles and the bearing life target)
  safety: 1.5
}
A bicycle for road racing gets the UCI's technical rules (2026) instead; every rule becomes a check with the fix that passes it:
analysis "UCI road rules" {
  uci: "road"
  bottom_bracket: crankset          // the crank axle: a part turning about it, or a point
  wheels: [front_tyre, rear_tyre]   // what is measured across the tyres (front and rear in either order)
  saddle: saddle
  bars: handlebar
  hoods: [left_lever, right_lever]  // optional: lever spacing and flare
  rim_depth: 50mm                   // optional: the 65 mm mass-start limit
  // forward: X (the way the bike rides, level; default X), parts: [...] (what is weighed and measured; default everything)
}
It checks weight (6.8 kg or more, by mass: where given), length and width, bottom bracket height and its distance to each axle, saddle setback (nose 50 mm or more behind the crank axle) and length, bar width (400 mm or more), lever gap (280 mm), flare (65 mm), wheel size, rim depth, every aero_tube's and aero_path's section (10 to 80 mm deep for every frame, fork, bar and post element, up to 160 mm for role: "head"; an aero_path's first and last points sit in the free joints between tubes and are not measured) and the top gear against the proposed 54 × 11 limit (on hold). Run it with run_analysis.
Natural frequencies (vibration) use the same block with modes:, excite: or ringing:. Without load: or gravity it only finds frequencies (at "draft" resolution by default):
analysis "Frame shake" {
  parts: [frame, motor_mount]
  fix: face(frame, -Z)
  carries: mass(face(motor_mount, +Z), 450g)   // a mass the parts carry that is not drawn as a solid (also adds weight with gravity and force in drops)
  excite: [spin(1500rpm, name: "drill"), spin(600rpm, to: 3000rpm), band(20Hz, 60Hz, name: "road"), 50Hz]   // what shakes it
  ringing: accel                               // printers and gantries: X/Y move acceleration in mm/s²; checks ringing after each move
  modes: 6                                     // how many frequencies (default 6, up to 12)
  damping: 0.02                                // fraction of critical damping (default 0.02)
}
A mode that moves 5 % or more of the mass fails when a running speed or band covers it (±10 %) and warns within a factor of √2; ringing over 0.02 mm warns. The result names where each mode moves most: stiffen there (a brace, gusset, deeper section) or move the speed.
Shaking (how hard it answers, not just where it resonates) is answered from those modes: shake: is a sine sweep, random: random vibration from a spectrum. Both shake the supports, so they take no load:, gravity or accel: (a sine with no acceleration makes the analysis's loads go up and down instead):
analysis "Shaker table" {
  parts: [bracket, board]
  fix: face(bracket, -Z)
  carries: mass(face(board, +Z), 80g)
  shake: sine(10Hz, 500Hz, 2g, Z)             // the supports shaken at 2 g (peak) along Z at every frequency in turn; sine(20Hz, 200Hz) with load: makes the loads go up and down
  damping: 0.02                                // fraction of critical damping (2 %: bolted and printed parts, 5 %: rubber mounts)
}
analysis "Truck ride" {
  fix: face(case, -Z)
  random: psd("truck", Z)                      // "truck" (ASTM D4169, 0.52 g rms), "navmat" (NAVMAT P-9492, 6.06 g rms) or psd([(20Hz, 0.01), (80Hz, 0.04), (350Hz, 0.04), (2000Hz, 0.007)], Z) in g²/Hz
  duration: 2h                                 // how long it is shaken (default: for good, 10⁷ cycles); finish: and reliability: set its S-N curve
}
modes: defaults to 12 here. A sweep shows the stresses and movement at the worst frequency (each spot at its own peak) with the response across the band; random shows 3σ stresses (RMS in the result) and Steinberg's three-band fatigue life. The safety factor is against the fatigue strength for the cycles shaken (default target 1.5); a life shorter than duration: fails. A warning says when the modes found reach too little of the band, or move under 80 % of the mass and stop below twice the band's top: ask for more modes: (mass left out of modes well above the band sits in stiff parts that follow the table).
Drops, knocks and tip-overs are held only by the floor they land on (no fix:, load:, gravity or excite:):
analysis "Desk drop" {
  parts: [case, lid]
  drop: 0.75m             // fall height
  onto: "wood"            // concrete (default), tile, steel, wood, carpet, grass
  impact: (1, 1, -1)      // the way it moves into the floor: a bottom corner here; default -Z lands flat
}
analysis "Knocked over" { parts: [tower]  tip: +X }   // tips over its bottom edge onto its +X side; the fall height comes from the shape
The result gives the impact speed, how long the impact lasts, the peak g, the g the parts feel (a short impact loads flexible parts less, one about as long as their swing loads them more) and the stresses. A dent right where it lands is not counted as breaking. Safety defaults to 1.5 for drops.
Heat (temperatures by conduction through the parts, cooled by the air and radiation) uses the same block with heat: or hold:. Without fix: it only finds temperatures; with fix: the temperatures then load the structure (thermal stress), and hot plastics are weaker and softer in the strength check:
analysis "Motor mount heat" {
  parts: [mount, motor, driver]
  heat: ["auto", source(heater, 5W)]   // "auto": every electronic part's own loss at its working current (motors, drivers, regulators, batteries, boards); source(part, W) spreads heat through a part, source(face(...), W) over a surface
  hold: temp(face(mount, -Z), 40C)     // optional: a surface held at a temperature (a heated bed, a hot engine block)
  cooling: ["still air", film(face(driver, +Z), "fan")]   // sealed, still air (default), indoors, breeze, fan, wind, oil, water, flowing water, or W/m²K; film() cools part of the surface differently
  ambient: 35C              // the surrounding air; default the brief's hottest temp:, else 25 °C
  emissivity: 0.9           // optional: works radiation out on its own (0.9 paint, plastics, anodising; 0.1 bare metal)
  time: 10min               // optional: a warm-up from start: (default ambient) over this long, instead of the steady state
  max_temp: 80C             // optional: one limit for every part; default each material's long-use limit (85 °C for electronics)
  fix: face(mount, -Z)      // optional: thermal stress, from assembled_at: (default the ambient)
}
A part past its limit fails, within the last tenth of its headroom warns. The result gives each part's hottest point, where the heat comes from, where it goes (air, radiation, held surfaces), and for a warm-up when each part passes its limit and where it would settle.
Current through the parts (Joule heating: busbars, battery straps, heater elements, fuse links, wire and terminals) goes in heat: too. current(from, to, 40A) sends a current in at one region and out at another through the parts that conduct (metals, carbon fibre; plastics carry none); current(from, to, 12V) puts a voltage across them instead. Kerf solves where the current runs, finds the resistance from each metal's resistivity, makes the I²R heat where it flows (most in narrow necks and round holes, where it crowds) and settles the resistance at the temperatures that heat brings (metals resist more as they warm, so a set current heats more and a set voltage drives less). The result gives each current's resistance, voltage drop, heat cold and warm, the parts it heats, the densest current (A/mm²) and where; capture_view results: "current" colours the parts by it.
analysis "Busbar" { parts: [bar, strap]  heat: [current(face(bar, -X), face(strap, +X), 120A, name: "Pack current")]  cooling: "still air" }
analysis "Left in the sun" { parts: [bracket]  fix: [face(bracket, -X), face(bracket, +X)]  temperature: 60C  assembled_at: 20C }   // the whole model at one temperature: expansion against the supports, no heat solve
Buckling: add buckling (3 shapes) or buckling: 1..6 to an analysis with loads; it finds how many times the loads it takes to buckle slender parts (columns, thin walls, tubes, struts) and their buckled shapes. Under 1 it fails, under buckling_safety: (default 3, since dents and print lines make real parts buckle sooner) it warns.
Printed parts: a part with an fdm process, or of a filament material and no process, is analysed as printed: solid walls (walls: lines of about 1.1 nozzle widths) round each layer's outline and solid skins (top: layers) under its tops and over its bottoms, round a sparse infill (infill:, pattern:) with a share of the solid's stiffness and strength (40 % gyroid: about 16 % as stiff and 20 % as strong). Its layers are weaker to pull apart and to slide (the layer check counts both) and a little softer across (fibre-filled filaments much softer). They stack the way the build pack lays the part on the bed (its largest flat face, unless the process gives build:); build: in the analysis overrides that for every part. Kerf assumes 4 walls, 5 top and bottom layers and 40 % gyroid infill unless the part says what it is printed with, like process: mfg.fdm(build: X, walls: 6, top: 6, infill: 60%), and the build pack lists each part's settings. A thin wall is all walls; a thick block or a narrow web between two skins is mostly infill, so give load-bearing printed parts more walls or infill when they bend too much.

Print plates: the make tab's Print plates view (and Export → Print plate) lays every printed part the way the build pack prints it, works out the supports it needs (a column under every downward face past the printer's overhang: limit, down to the bed or to the part below; ceilings no wider than bridge: and held at both ends bridge instead) and its filament and time with its own walls, top and infill, then packs every copy onto as many plates as the printer from Settings → Making takes, turning parts a quarter turn to fit: one plastic a plate on one nozzle, two on a two-nozzle printer like the Bambu Lab H2D or X2D. It writes a .3mf a plate (zipped when there are several). A part bigger than the bed even turned is flagged: split: it. To print with less support, turn a part with build: so its overhangs face up or a flat face lies down, or chamfer a ceiling's edge to 45°.
Fatigue: cycles: over 1000, or history:, adds a fatigue check to a structural analysis. Each point's stress under the loads as written is scaled through the load cycles and judged against its material's S-N curve (Shigley's estimate from the ultimate and fatigue strengths, lowered for the surface finish and the reliability asked for; steels, irons and titanium keep an endurance limit past 10⁷ cycles, aluminium and plastics keep weakening), with a mean-stress correction and the damage added by Miner's rule; printed parts are also checked between layers, where only a pull across them counts. It reports the lowest fatigue safety factor (the factor on the loads at which the part breaks at the end of its life) against safety:, the shortest life and where, which cycles do the damage, and a life map; the strength check then uses yield at the history's peak. Under 1 it fails, between 1 and safety: it warns. Keep fatigue in its own analysis, apart from drops, frequencies and heat.
  cycles: 1e6                // a constant load cycle this many times in the part's life
  loading: "on-off"          // "reversed" (the loads swing both ways, the default), "on-off" (from nothing to the loads: a shelf loaded and unloaded) or a load ratio R = min/max like 0.2
  history: [block(1e5, 1), block(500, 2.5, min: 0)]   // instead of cycles: load blocks, or a trace of load scales like [0, 1, 0.3, 1.4, 0] (rainflow counted)
  repeats: 200               // with history: how many times the history happens in the part's life
  mean_stress: "goodman"     // the default; "gerber", "soderberg", "swt" or "none"
  finish: "machined"         // polished, ground, machined, hot-rolled, forged, cast, printed; default from how each part is made
  reliability: 99%           // the chance it lasts the life; default 50 % (the average part)
The fix is lower stress where the life is shortest: more material along the load path, a bigger fillet, holes and steps moved away, a smoother finish on metal, or a material with a higher fatigue strength.
Large deflection: a part that bends or turns far (a snap arm pushed home, a flexure, a spring strip, a strap held at both ends that stretches as it sags) is solved again with every element turning as it bends, which the plain answer leaves out; Kerf switches it on by itself when the plain answer turns parts over 10° or one large-deflection step moves it more than 3 %, and says so in the result. large_deflection (or large_deflection: true) asks for it, large_deflection: false keeps the plain answer. Strains stay small (elastic metal and plastic parts), so a part pushed past yield is still judged against yield. It takes a few times as long, and does not go with modes:, drop:, buckling, fatigue, topology:, touching:, preload: or temperatures yet (asked for with them it is an error; switched on by itself it warns and keeps the plain answer).
Accuracy check: the converge flag (or the panel's Check accuracy button) solves twice, the second time with 1.5× smaller elements, and reports how far deflection, stress, safety, temperature and buckling moved: under 5 % has converged, over 15 % needs a smaller resolution:. A peak at a support or load that keeps rising is a singularity of the idealised fixing: judge the part by the stress a short way off.
Design study (an optimiser): an analysis block with vary: changes parameters within their ranges, builds and checks each design away from the open one, solves the structural analyses that cover the parts they change, and finds the best design that still meets every analysis target and every check that passes now:
analysis "Lightest bracket" {
  vary: [thickness, bend_r(1mm, 6mm), ribs(0, 4, 1)]   // params by name; the range from the param's range a .. b unless given; a step (whole numbers for a count)
  goal: "min mass"                 // or "max safety", "min deflection", "min stress", "max frequency", "min temperature", "max buckling", each optionally "of <part or analysis>"; "lightest", "stiffest", "strongest", "coolest"
  keep: ["deflection <= 0.4mm"]    // optional extra limits: mass, safety, deflection, stress, frequency, temperature, buckling with <= or >=
  using: ["Shelf load"]            // optional: the analyses to solve (default those the parameters reach)
  runs: 16                         // the most designs to build, the current one included (default 12, at most 40)
}
It never runs on its own: run_analysis label: "<study>" runs it (about as long as building and solving the design once per run) and returns every design, the best, and how much each parameter matters. Apply one with edit_design alternative: "<study> #<n>". Prefer a study to trying sizes by hand; use compare_designs for different concepts.
Topology optimisation (where to cut material away): topology: in a strength analysis finds the stiffest shape for its loads and supports that keeps that share of the parts' material (SIMP with a density filter, a sharpening step and optimality-criteria updates), then checks that shape under the same loads:
analysis "Lighter bracket" {
  fix: face(bracket, -Y)
  load: force(face(bracket, +Z), (0, 0, -400N))
  topology: 35%                 // the share of the material to keep, 5 % to 95 %
  preserve: [zone(at: (20, 0, 8), r: 6), boss]   // optional: kept solid (bosses round holes, mounting faces, whole parts); where it is held and loaded always stays
  min_member: 4mm               // optional: the thinnest member (default about 2.5 elements)
  symmetry: [X]                 // optional: mirror planes through the middle of the parts, by the axis across them
  extrusion: Y                  // optional: the same all the way through along Y, to cut from plate (laser, waterjet, router)
  iterations: 80                // optional: most design steps (most settle in 30 to 60)
}
It takes many solves (about half a minute at the standard resolution, use resolution: "draft" for a first look), so it never runs on its own: run_analysis label: "<label>" runs it and returns the material and mass kept, the stiffness kept against the solid parts, openings, the shape's own stress and safety factor, and with extrusion: the profile as point lists (outsides anticlockwise, holes clockwise) to extrude; capture_view results shows the shape inside the faded parts. The shape is a suggestion: model it as a real part (follow its members, round it off, keep the mounting faces), then check that part in an analysis of its own. Keep it in its own analysis, not with drops, frequencies, heat, buckling or fatigue.
Strength data: ${mech}. Parts in ${printedList} count as FDM-printed by default; write printed: false for a moulded or machined plastic part.

An airflow analysis puts the design in a virtual wind tunnel: a GPU lattice-Boltzmann flow solver with LES turbulence and a wall model, on a rolling road with the wheels spinning, re-run after each change:
analysis "Aero at 45 km/h" {
  airflow: 45kmh          // the air speed past it (kmh, mph or mm/s)
  forward: X              // the way the design travels (or wind: -X, the way the air blows past it); up: defaults to Z
  yaw: [0, 5, 10]         // crosswind angles in degrees, up to 12 from -45 to 45; each is its own run
  parts: [frame, fork]    // what is in the tunnel (default: every part); a part's motion spin about an axle square to forward makes it a rolling wheel, or name them with wheels:
  rider: "drops"          // adds a standard rider: drops, hoods, tops, tt (time-trial bars) or upright; rider_height: 1780mm; saddle:, bars:, bottom_bracket: name the touch points (else found from a bike fit analysis or the part names)
  max_cda: 0.25           // targets: max_cda (m²), max_drag (N), max_watts (W to push the air), max_lift (N, downforce is negative lift)
}
Also: ground: false for free air with no road, temperature: 20C or density: 1.2 for the air, resolution: "draft" (quick look), "standard" (default) or "fine", or a cell size like 4mm, and time: 10min to cap the run. The result gives drag, CdA, side force, lift and the watts at each yaw (mean too), the drag of every part, and the surface patches with the most drag, saying whether each is pressure on a blunt front, suction behind a back where the flow separates, or skin friction. The viewport shows surface pressure or friction, animated streamlines, the wake, eddies, cuts through the flow and a version history. To cut drag: round or point the fronts that stop the air, taper the backs where it separates (a tail about three times as long as it is thick, or a truncated aerofoil), close gaps between parts that let air in behind, and shrink the frontal area; then compare the new CdA with the last version and keep the change only if it helped across the yaws.
Air loads (one-way fluid to structure): air("<airflow label>") in a strength analysis's load: puts that run's surface pressure and skin friction on every analysed part that was in its air, scaled so each part's load adds up to the force the run measured on it. The strength analysis waits for the airflow run and runs again after each new one:
analysis "Sign in a gale" {
  parts: [post, sign]
  fix: face(post, -Z)
  load: air("Gale")                     // optional: yaw: 5 (one of the run's angles), speed: 120kmh (pressures go as the speed squared), scale: 1.5 (a gust factor)
}
It is one-way: the flow is the one round the unbent parts, so it suits stiff parts (signs, wings, fairings, brackets in the wind), not flapping ones. Solid parts only (not frames analysed as beams or walls as shells). The result's loads list the force on each part and the factor that matched it to the run; parts in the air that the strength analysis leaves out are named with the force on them.
A flow analysis (flow:) blows air through and round the design and works out how hot every part gets: electronics cooling with the design's own fans or warm air rising, and duct, manifold and nozzle flow pushed in at a set rate. A steady CFD solve on a grid of cells (LVEL turbulence, wall functions, warm air rising, each fan on its own curve), with the heat solved in the parts and the air together (conduction through the parts, convection, radiation to the surroundings); it re-runs a few seconds after the parts change:
analysis "Cooling" {
  flow: "fans"            // the design's fan components blow along their axes on their curves (datasheet flow and pressure when the catalogue has them, else typical for their size); fans: [fan_top] picks which run
  heat: "auto"            // the default: every electronic part's own loss (regulators, drivers, motors, the board); add source(part, 2W) for more, or "none"
  ambient: 35C            // the air round it (default: the brief's hottest, else 25 °C)
  max_temp: 70C           // a cap for every part; each component already has its own limit (85 °C electronics, 60 °C cells, 100 °C driver cases, a plastic's softening point)
}
analysis "Passive" { flow: "natural"  up: +Z }     // no fan: only warm air rising (needs gravity, the default; up: says which way is up)
analysis "Manifold" {
  flow: 12lpm             // a set flow pushed in at inlet: (units cfm, lpm, lps, cmh for m³/h; a plain number is mm³/s)
  fluid: "water"          // "air" (default) or "water"
  inlet: face(manifold, -X)                      // the end it goes in at, into the part; or a zone(...) or point with toward: +X
  outlets: [face(manifold, +X), face(branch, +Y)] // openings to report the flow and its share through
  max_pressure: 20kPa     // the most the pump or blower may push against
}
Also: parts: [...] (default every part shown), resolution: "draft", "standard" (default) or "fine", or a cell size like 1mm (walls thinner than a cell are drawn a cell thick, so keep at least two cells across a gap that matters), gravity: false, time: 10min. The result gives each part's hottest and mean temperature against its limit, the heat made and where it goes (into the air, radiated), the air through and how much warmer it leaves, each fan's working point on its curve with a warning when it stalls (an axial fan below about 30 % of its free flow) or runs backwards, and for a set flow the pressure it takes, its loss coefficient and the share through each outlet. The viewport shows the parts coloured by temperature with the case see-through, streamlines and a cut through the air (capture_view cooling: "inside", "streamlines", "cut"). To cool parts: put vents in line with the fans so the air goes through the box rather than round it (about twice the fan's area in, the same out), move the hottest parts into the air's path or onto a metal wall, add a heatsink, keep fans blowing the same way. To cut pressure in a duct: widen the fastest passages, round bends and entries, avoid sudden changes of section.
## Checks the app runs automatically
- every require statement (hard fails block "valid"; soft fails warn), with margins
- exact solid interference between every pair of nearby parts (OpenCASCADE booleans); parts of one multi-solid component are not checked against each other; gears are checked by tooth geometry instead
- tool access: a hex-key cylinder from every screw head outward must not hit non-removable parts
- swept envelopes of rotating gears against static parts
- gear meshing: same module, exact centre distance, face overlap, and tooth clearance through a rotation
- build errors (a modelling step the kernel could not perform)
- every analysis block: structural strength (factor of safety) and stiffness, natural frequencies against what shakes it, drops and tip-overs, the drivetrain's tooth, bearing and shaft checks, or airflow drag, CdA, watts and lift against their targets
- real-world fit: every hole with a shaft, pin, bearing, dowel or screw in it, every gear mesh and every screw pattern is simulated as made a few thousand times: printed holes come out small and printed parts shrink as they cool (by material, process settings and orientation), bought parts sit anywhere in their standard tolerance band (ISO 492 bearings, ISO 286 dowels and shafts, 6g screws), sizes a drawing calls with fit: or tol: are held, all at the brief's temperatures. Outcomes: won't fit, cracks (a plastic hub split by a press fit), creeps, slips, loose, binds (gears whose backlash the fits eat up), misaligned (screw patterns). Fix with the size the check names (a 5 mm dowel in PETG wants a hole of about 5.2 mm), gear backlash:, the fdm settings hole_comp: and shrink_comp: when the user's slicer uses them, or a drawing tolerance for machined parts
- springs and clips: every lib.spring (rate, preload, stress, coil bind, buckling, fatigue, surge frequency), every snap_hook (strain with the print's layers, and its spine's too for a C-shaped clip that wraps round an edge (frame:), push-in and pull-out force, whether a pull on a C-shaped clip's head (or its pull tab, grip:) would bend its spine for good before the catch lets go, the press on the hook's tip that frees a clip with a steep catch, whether it stays tight or rattles once latched given real part scatter) and every flexure (stiffness, force or torque, strain over its cycles)
- hot soak: when the brief goes above 45 °C, latches held bent near their plastic's softening point and batteries past their limits; a brief that says car or vehicle but stops short of 60 °C gets a reminder
- manufacturing: every part with a process: is checked against that process's rules on its exact geometry (walls by ray casting, draft and undercuts along the pull, tool reach per setup, inside corner radii, slots, overhangs and orientation, turning, sheet thickness and bends, flat profiles, holes, voids, machine size), plus whether its material suits the process
- for machines: electrical rules, engineering loads and the physical test plan (see Machines below), and every scenario block's expectations from its simulated runs (see Simulations below)
Hard parametric requirements also feed a feasibility solver: when they cannot all hold, it searches the unlocked parameters for the smallest changes that satisfy every hard requirement.
Things geometry cannot prove are reported as "needs analysis" until an analysis block or a machine calculation covers them; heat is checked through the brief's temperatures (materials, fits, latches, batteries) and by the machine calculators.

${machineReference()}

${simulationReference()}

${appReference()}`;
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
Drawings read the design's intent from the parts around each part: a bore that holds a bearing is called out as its seat (H7 when machined), a hole a dowel sits in gets H7, a turned diameter under a bearing gets k6 and under a gear h6, and the distance between two axes that carry meshing gears is dimensioned directly with a tolerance worked out from the gears' backlash. Machined, cast, moulded and sheet parts also get datums (A: the face the part seats on; B and C: the centre planes, the bore on the origin or an edge, whichever the positions are measured from), position frames on hole patterns (from the screw clearance: T = H − F for clearance holes, half that for tapped holes and inserts), and boxed basic positions; printed parts don't unless gdt: true. Leave out views: to let Kerf pick the views a part needs (a plate whose features all run one way gets two views and an iso). A part turned at an angle in the design (rotate: (0, 0, 45)) is drawn square to its own faces. A row of three or more overlapping holes or cylinder cuts along a line or an arc is called out as one SLOT or ARC SLOT. In the parts list, made parts of the same shape share a line whatever they are called. A scale: that does not fit the sheet falls back to the next standard scale that does, with a warning.
Beyond lengths and diameters, part drawings call out the radii of fillets, rounded corners and sketch arcs ("4× R6", each size once, the rest in an UNDIMENSIONED RADII note), chamfers cut across square corners ("2× 1 × 45°") and the angles of sloped edges against the edges they meet. Feature positions go from the datum (baseline); dim_style: "ordinate" or "chain" changes that, and a view with too many positions for rows turns to ordinates by itself. hole_table: true lists the holes of the main view by tag (A1, A2 … B1) with X, Y from a marked origin, size and position frame, instead of callouts and position dimensions. revision() rows fill a revision table at the top right and set the title block's revision. Machined parts get a general surface texture symbol (Ra 3.2) on the title block and Ra symbols on bearing, dowel and journal seats; roughness() adds or changes them, and weld() puts ISO 2553 weld symbols on joints. view_drawing lists the hole table, symbols and revisions.

Views that show part of a part, or more of an assembly: a long plain part (shaft, rail, tube, bar) is drawn as a broken view, its featureless middle taken out with zigzag break lines so it draws bigger; dimensions across the break keep their true length. break_view(X, 40, 260) sets the break yourself, breaks: false keeps views whole. A part drilled at an angle gets an auxiliary view square onto that face (aux_view("B", normal: (1, 0, 1), at: point on the face)), where its holes are called out true size; on a big part it is a partial view of just those features (crop:), drawn bigger. A part whose body runs along a slanted axis is drawn square to that axis. view("front", crop: [(x0, y0, z0), (x1, y1, z1)]) is a crop view of just that box, drawn bigger with freehand edges. broken_out("front", at: (x, y, z), r: 10) cuts a circle of the view away in front of the point and hatches what it cuts, to show a hidden feature without a full section. view("iso", exploded: true) spreads an assembly's parts out for its balloons, the same way as the 3D view's exploded view: screws back out along their axes with their washers, nuts drop off the far end, each part comes off the screw stack, fit or face it sits on (after everything fastened onto it), and the biggest part stays; capture_view with exploded: true shows it and says which way each part went. view_drawing marks views as broken, crop, exploded or broken-out.
PMI (model-based definition): each made part's drawing (its own block, else the automatic one) is also its PMI. The PMI button in the viewport shows those dimensions, fits, datums and feature control frames on the 3D model, and the "STEP with PMI (AP242)" export writes them as semantic PMI tied to the faces (diameters with their fits, distances between faces, datums A/B/C, position, flatness, perpendicularity and the rest), for CAM and inspection. So tol(), gdt() and dim() in a part's drawing block change its PMI too; pmi: false in the block leaves the part out. view_drawing says what a part drawing puts into PMI.
Calls inside a drawing block:
${calls}
Use view_drawing to look at a drawing and get its dimension list before changing it. When the user points at something on a drawing, their message names it (for example a dimension's text and view); change the drawing block, or the design itself when they ask for a different size.`;
}
