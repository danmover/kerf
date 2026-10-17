// The simulation section of Claude's language reference: scenario blocks,
// the sim.* worlds and machines, and the result names expectations read.

import { resultDocs } from "./results";
import { SIM_DOCS } from "./scenario";

export function simulationReference(): string {
  const fns = Object.entries(SIM_DOCS)
    .map(([k, d]) => `- sim.${k}(): ${d}`)
    .join("\n");
  return `## Simulations (scenario blocks)

A scenario is a virtual test of the whole machine: the design's generated firmware runs on a virtual copy of its controller (compiled C++ with the chip's timing, pins, interrupts, ADC, PWM, I2C and serial; the ADC also from its registers, free running into ISR(ADC_vect), the I2C clock from TWBR and SREG; other registers and timer interrupts are not modelled yet, and inline assembly runs only as an empty barrier or nops), wired exactly as the wire and net statements say to simulated drivers, motors (current, torque, heating), linear actuators, encoders, IMUs, SSD1306 OLED displays (what they show plays back with the run) and the battery, inside a world that loads the motors and moves the machine. Every scenario runs three times: pessimistic, expected and optimistic soil, load and grip values. An expectation passes when it holds in the expected run, warns when only the pessimistic or optimistic run fails, and fails when the expected run fails (soft expectations warn instead). Results become checks (category simulation, basis virtual test) and count towards the brief uses the scenario names with for. Runs start by themselves after each change (about 10 s of computer time per run); run_scenario waits for them and reports.

scenario "Cross the pit" for cross, steer {
  world: sim.sand_pit(length: pit_l, width: pit_w, depth: pit_depth, axis: 100mm, start: "wall", exit: 290mm)
  robot: sim.screw_tunneller(
    screws: [sim.screw(motor: m_front, d: flight_d, core: shell_d, pitch: pitch, from: f_fl0, length: 176, face: true),
             sim.screw(motor: m_rear, d: flight_d, core: shell_d, pitch: pitch, from: r_fl0, length: 176, dir: -X)],
    body: body_od, between: (r_shell0, f0), nose: nose_tip, tail: tail_x,
    hinge: sim.cam_hinge(actuator: steer, arm: pin_x, slope: cam_slope, mid: act_mid, stop: 5.7, extend: "left"))
  firmware: brain                      // the firmware block to run (the first one when left out)
  duration: 20min                      // longest simulated time (it also stops 10 s after everything stops once the firmware says done or fault)
  console: [sim.type("g", at: 2s)]     // text typed into the serial console
  config: sim.config(STEER_SIGN: -1)   // try a firmware #define change for this run only
  charge: 100%                         // battery charge at the start
  variants: ["expected"]               // run fewer variants while iterating (default all three)
  let target = 100mm                   // scenario-local names
  expect "Reaches the far wall": reached
  expect "Arrives near the line": miss < target
  expect "Motors stay cool" soft: m_front.max_temp < 80C && m_rear.max_temp < 80C
}
Entries: world (required), robot (required for a sand pit), firmware, duration, console, config, variants, charge, seed, let, expect "label" [soft|hard]: expression. An expression reads the run's results by name (below) and any design value; shares are fractions (write 30%), times in seconds (write 5min, 10ms), temperatures in °C (80C). It can use + - * / ^ < <= > >= == != && || ! ?: and abs, min, max, sqrt, round, floor, ceil. A result that a run did not record (miss when it never reached the far wall) fails the expectation. A design needs a firmware block for an Arduino controller, or for a 3D printer board (Klipper, Marlin or RepRapFirmware), to be simulated.
3D printers: world: sim.printer(print: sim.test_print("cube")) prints through the firmware block's generated config. Kerf reads the config back (printer.cfg and its macros, Configuration.h, or config.g and the homing files) and runs that firmware's own motion planner (Klipper's square-corner velocity and smoothed lookahead, Marlin's junction deviation or jerk over its block buffer, RepRapFirmware's M566 jerk), heater control (PID per firmware, RepRapFirmware's M307 model) and safety checks (verify_heater, THERMAL_PROTECTION, M570), homing, probing and bed mesh, against the design's motors (torque at speed, skipped steps become layer shifts), heaters, hotend melt rate and power supply. flavor: "marlin" runs another firmware the board supports; config: sim.config(MAX_ACCEL: 6000) changes a firmware block setting for one run. A print takes seconds to simulate, so use the default 4 h duration.
scenario "Fast cube" for print {
  world: sim.printer(print: sim.test_print("cube", speed: 120, material: "PETG"))
  firmware: printer
  config: sim.config(MAX_ACCEL: 5000)
  expect "No layer shifts": layer_shifts == 0
  expect "Hotend keeps up" soft: under_extrusion < 3%
  expect "Under 25 minutes": print_time < 25min
}
Put robot descriptions that several scenarios share in a let at the top level (let tunneller = sim.screw_tunneller(...)), then write robot: tunneller.

Worlds and machines:
${fns}

Results by name:
${resultDocs()}

What simulations leave out: worlds are reduced-order models (a few state variables and calibrated formulas, not particles or finite elements). Soil is uniform and dry; steering grip and drift are estimates the three runs bracket. Motors heat as one lump; electrical models use average voltages without wiring resistance or noise. The firmware runs as compiled C++ on a cycle-counted virtual chip, not as AVR machine code. Say so when reporting results, and keep the physical tests: a simulation narrows down what to test, it does not replace the test.
To set up a scenario from a user's words: pick the world that matches (printer for a 3D printer printing, sand_pit for burrowing through sand, bench for power-up, battery runtime, overload and hot-room tests, and bench with signals: [sim.signal(on: "NET", note: "E2")] for firmware that listens to a signal, like a tuner or a level meter), take sizes from the brief's givens, describe the machine from the design's own parameters (not copied numbers), write expectations that match the brief's uses, add it with edit_design, then call run_scenario. If no world matches what the user describes, say which part Kerf cannot simulate yet and set up the closest test instead.
`;
}
