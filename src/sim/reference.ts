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
Entries: like, world (required unless like: gives it), robot (required for a sand pit), faults, firmware, duration, console, config, variants, charge, seed, let, expect "label" [soft|hard]: expression. An expression reads the run's results by name (below) and any design value; shares are fractions (write 30%), times in seconds (write 5min, 10ms), temperatures in °C (80C). It can use + - * / ^ < <= > >= == != && || ! ?: and abs, min, max, sqrt, round, floor, ceil. A result that a run did not record (miss when it never reached the far wall) fails the expectation. A design needs a firmware block for an Arduino controller to be simulated; Klipper printers cannot be simulated yet.
Put robot descriptions that several scenarios share in a let at the top level (let tunneller = sim.screw_tunneller(...)), then write robot: tunneller.

Fault tests: what happens when something goes wrong. like: "Other scenario" takes that scenario's world, machine, firmware, duration, console, config, variants, charge and seed (it must be above), and the scenario changes only what it writes itself; its expectations are its own. faults: lists what goes wrong and when, against the real firmware:
scenario "Front screw jams" {
  like: "Cross the pit"
  faults: [sim.jam(m_front, at: 3min)]                 // also sim.unplug(imu, at: …), sim.loose("m_front.ENC_A", at: …, until: …, flicker: true), sim.stuck(imu, at: …), sim.aged(bat, capacity: 80%, resistance: 1.5)
  variants: "expected"                                 // one run is usually enough for a fault
  expect "Notices the jam": fault_noticed
  expect "Ends stopped": fault_stopped && still_at_end
  expect "No fuse blows" soft: fuse_blown == false
}
Put the fault after the firmware's start delay, while the machine is working. A good fault test asks for a safe outcome (it notices, stops or backs out, nothing overheats or blows), not for the job to finish. When one fails, say what the firmware did wrong in plain words and propose the firmware or wiring change.

Calibration: once the machine is built, the simulation can run on the real parts' numbers. The Arduino firmware Kerf writes has a bench test (console command b, motors free to turn, machine held still) that prints "cal" lines; the Calibrate panel in the Simulate tab fits them and writes measured: sim.measured(...) on each gearmotor and the battery. A component with measured: is simulated with those values in place of the catalog's, while the checks keep the maker's ratings. When a user quotes measured numbers (a stall current, a free speed), set measured: on that component with edit_design and run the scenarios again; for a whole bench test log, point them to the Calibrate panel, which fits it.

Worlds and machines:
${fns}

Results by name:
${resultDocs()}

What simulations leave out: worlds are reduced-order models (a few state variables and calibrated formulas, not particles or finite elements). Soil is uniform and dry; steering grip and drift are estimates the three runs bracket. Motors heat as one lump; electrical models use average voltages without wiring resistance or noise. A loose wire is an open circuit (a flickering one opens and closes at random), not a short. The firmware runs as compiled C++ on a cycle-counted virtual chip, not as AVR machine code. Say so when reporting results, and keep the physical tests: a simulation narrows down what to test, it does not replace the test.
To set up a scenario from a user's words: pick the world that matches (sand_pit for burrowing through sand, bench for power-up, battery runtime, overload and hot-room tests, and bench with signals: [sim.signal(on: "NET", note: "E2")] for firmware that listens to a signal, like a tuner or a level meter), take sizes from the brief's givens, describe the machine from the design's own parameters (not copied numbers), write expectations that match the brief's uses, add it with edit_design, then call run_scenario. If no world matches what the user describes, say which part Kerf cannot simulate yet and set up the closest test instead.
`;
}
