// Ready-made scenarios for the Simulate tab's gallery. Bench tests are
// written straight from the design (its firmware block, motors and battery);
// worlds that need the machine described in detail, like a sand pit, are set
// up by Claude from the design's own parameters.

import type { Model } from "../core/model";
import { catalogPart } from "../machine/catalog";
import { boardFlavors, flavorOf, FLAVOR_NAME, type PrinterFlavor } from "../machine/firmware/printer";

export interface SimTemplate {
  id: string;
  title: string;
  blurb: string;
  /** the scenario's source, written from the design; null when this design cannot use it */
  source?: (m: Model) => string | null;
  /** what to ask Claude for, when Claude sets it up */
  prompt?: (m: Model) => string;
  /** why it does not apply to this design, if it does not */
  unavailable?: (m: Model) => string | null;
  /** left out of the gallery for this design (printer tests on a robot, robot tests on a printer) */
  hidden?: (m: Model) => boolean;
}

const fmtS = (s: number) => (s % 60 === 0 ? `${s / 60}min` : `${Math.round(s)}s`);

function firmwareOf(m: Model) {
  const fw = m.machine?.firmware ?? [];
  return fw.find((f) => {
    const board = m.machine?.components.find((c) => c.name === f.board);
    return String(catalogPart(board?.catalogId ?? "")?.specs.platform ?? "").startsWith("arduino");
  });
}

function needsFirmware(m: Model): string | null {
  if (!m.machine) return "Simulations run a machine's firmware: add a controller, its wiring and a firmware block first.";
  if (!m.machine.firmware.length) return "Add a firmware block for the controller first.";
  if (!firmwareOf(m)) return "Kerf can simulate Arduino firmware and 3D printer firmware (Klipper, Marlin, RepRapFirmware); this design's controller is neither.";
  return null;
}

/** The firmware block of a 3D printer board, and the firmwares that board runs. */
function printerOf(m: Model): { name: string; flavor: PrinterFlavor; flavors: PrinterFlavor[] } | undefined {
  for (const f of m.machine?.firmware ?? []) {
    const board = m.machine?.components.find((c) => c.name === f.board);
    const part = catalogPart(board?.catalogId ?? "");
    const flavors = part ? boardFlavors(part) : [];
    if (!flavors.length) continue;
    const want = flavorOf(String(f.settings.flavor ?? ""));
    return { name: f.name, flavor: want && flavors.includes(want) ? want : flavors[0], flavors };
  }
  return undefined;
}

const isPrinter = (m: Model) => !!printerOf(m);
const needsPrinter = (m: Model) => (printerOf(m) ? null : "This test is for 3D printers: add a printer controller board (SKR, Duet) and its firmware block.");

function printer(m: Model, label: string, world: string, expects: string[]): string {
  const p = printerOf(m)!;
  return [`scenario "${freeLabel(m, label)}" {`, `  world: ${world}`, `  firmware: ${p.name}`, ...expects.map((e) => `  ${e}`), "}"].join("\n");
}

const motors = (m: Model) => (m.machine?.components ?? []).filter((c) => catalogPart(c.catalogId)?.kind === "gearmotor").map((c) => c.name);
const hasBattery = (m: Model) => (m.machine?.components ?? []).some((c) => catalogPart(c.catalogId)?.kind === "battery");
const startDelay = (m: Model) => {
  const v = firmwareOf(m)?.settings.start_delay;
  return typeof v === "number" ? v : 10;
};

/** A label not already taken by a scenario in the design. */
function freeLabel(m: Model, base: string): string {
  const taken = new Set((m.scenarios ?? []).map((s) => s.label));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

function bench(m: Model, label: string, world: string, duration: number, expects: string[]): string {
  const fw = firmwareOf(m)!;
  return [`scenario "${freeLabel(m, label)}" {`, `  world: ${world}`, `  firmware: ${fw.name}`, `  duration: ${fmtS(duration)}`, ...expects.map((e) => `  ${e}`), "}"].join("\n");
}

export const SIM_TEMPLATES: SimTemplate[] = [
  {
    id: "power_up",
    hidden: isPrinter,
    title: "Power-up on the bench",
    blurb: "Power it with the motors free: the firmware starts, every motor turns, nothing is mis-wired, RAM and loop time have room.",
    unavailable: needsFirmware,
    source: (m) =>
      bench(m, "Power-up on the bench", "sim.bench(load: 0)", Math.max(60, Math.ceil((startDelay(m) + 60) / 60) * 60), [
        'expect "No firmware mistakes": faults == 0',
        ...motors(m).map((n) => `expect "${n} turns" soft: abs(${n}.turns) > 1`),
        'expect "RAM to spare" soft: ram_use < 75%',
        'expect "loop() keeps up" soft: loop_time < 20ms',
      ]),
  },
  {
    id: "runtime",
    hidden: isPrinter,
    title: "Battery runtime",
    blurb: "A full job at the design load: the battery lasts with charge to spare and its voltage holds up under load.",
    unavailable: (m) => needsFirmware(m) ?? (hasBattery(m) ? null : "The design has no battery to follow."),
    source: (m) =>
      bench(m, "Battery runtime", "sim.bench()", 30 * 60, ['expect "Charge to spare at the end": battery_left > 20%', 'expect "No firmware mistakes": faults == 0', ...motors(m).map((n) => `expect "${n} stays below 80 °C" soft: ${n}.max_temp < 80C`)]),
  },
  {
    id: "hot_room",
    hidden: isPrinter,
    title: "Hot room",
    blurb: "The same job at 40 °C: motors and drivers shed less heat, so check the windings stay cool enough.",
    unavailable: needsFirmware,
    source: (m) => bench(m, "Hot room", "sim.bench(ambient: 40C)", 20 * 60, [...motors(m).map((n) => `expect "${n} stays below 90 °C": ${n}.max_temp < 90C`), 'expect "No firmware mistakes": faults == 0']),
  },
  {
    id: "overload",
    hidden: isPrinter,
    title: "50 % overload",
    blurb: "Half as much load again on every motor: it keeps working, the battery copes with the current, nothing overheats.",
    unavailable: needsFirmware,
    source: (m) =>
      bench(m, "50 % overload", "sim.bench(load: 1.5)", 10 * 60, [
        ...motors(m).map((n) => `expect "${n} keeps turning": abs(${n}.turns) > 1`),
        ...motors(m).map((n) => `expect "${n} stays below 80 °C" soft: ${n}.max_temp < 80C`),
        ...(hasBattery(m) ? ['expect "Battery voltage holds" soft: battery_min_volts > 0.8 * bat.v_nom'] : []),
      ]).replace(/bat\.v_nom/g, (m.machine?.components.find((c) => catalogPart(c.catalogId)?.kind === "battery")?.name ?? "bat") + ".v_nom"),
  },
  {
    id: "print_cube",
    title: "Calibration cube print",
    blurb: "Slice a 20 mm cube for this printer and print it through its own firmware: homing, heating, bed mesh, every move and the heaters, with layer shifts, under-extrusion and the first layer checked.",
    hidden: (m) => !isPrinter(m),
    unavailable: needsPrinter,
    source: (m) =>
      printer(m, "Calibration cube print", 'sim.printer(print: sim.test_print("cube"))', [
        'expect "The print finishes": finished',
        'expect "No layer shifts": layer_shifts == 0',
        'expect "No under-extrusion": under_extrusion < 2%',
        'expect "Hotend holds its temperature" soft: hotend_error < 5C',
        'expect "First layer within 0.1 mm" soft: first_layer_error < 0.1mm',
      ]),
  },
  {
    id: "print_fast",
    title: "Fast cylinder print",
    blurb: "A cylinder of short segments at 150 mm/s: works the firmware's cornering and lookahead, the motors' torque at speed and the hotend's melt rate.",
    hidden: (m) => !isPrinter(m),
    unavailable: needsPrinter,
    source: (m) =>
      printer(m, "Fast cylinder print", 'sim.printer(print: sim.test_print("cylinder", speed: 150, travel: 250))', [
        'expect "The print finishes": finished',
        'expect "No layer shifts": layer_shifts == 0',
        'expect "The hotend keeps up" soft: under_extrusion < 5%',
        'expect "Motors have torque to spare" soft: x_load < 70% && y_load < 70%',
      ]),
  },
  {
    id: "print_first_layer",
    title: "First layer",
    blurb: "One layer over a 50 mm square: the bed's real shape against the probed mesh and the probe offset, so you see where the nozzle scrapes or the plastic will not stick.",
    hidden: (m) => !isPrinter(m),
    unavailable: needsPrinter,
    source: (m) =>
      printer(m, "First layer", 'sim.printer(print: sim.test_print("first_layer", size: 100))', [
        'expect "Even first layer": first_layer_error < 0.1mm',
        'expect "The nozzle does not scrape": first_layer_squashed < 5%',
        'expect "The first layer sticks" soft: first_layer_loose < 5%',
      ]),
  },
  {
    id: "print_firmwares",
    title: "Same print on each firmware",
    blurb: "The cube on every firmware this board runs, each from its own generated config: compare print time, cornering, heater control and safety checks.",
    hidden: (m) => !isPrinter(m),
    unavailable: (m) => needsPrinter(m) ?? (printerOf(m)!.flavors.length > 1 ? null : `${FLAVOR_NAME[printerOf(m)!.flavor]} is the only firmware this board runs: pick a board that also runs others to compare.`),
    source: (m) =>
      printerOf(m)!
        .flavors.map((fl) =>
          printer(m, `Cube on ${FLAVOR_NAME[fl]}`, `sim.printer(print: sim.test_print("cube"), flavor: "${fl}")`, ['expect "The print finishes": finished', 'expect "No layer shifts": layer_shifts == 0', 'expect "Hotend holds its temperature" soft: hotend_error < 5C']),
        )
        .join("\n\n"),
  },
  {
    id: "sand_pit",
    hidden: isPrinter,
    title: "Sand pit crossing",
    blurb: "Burrow through a box of sand: Janssen stress at depth, screw thrust and slip, steering, walls and an exit opening. Claude describes the machine from the design.",
    unavailable: needsFirmware,
    prompt: (m) => {
      const g = m.brief?.givens ?? [];
      const sizes = g.length ? ` Use the pit sizes from the brief's givens (${g.map((x) => x.name).join(", ")}).` : " Ask me for the pit's size if the brief does not give it.";
      return `Add a sand pit scenario that tests whether this machine gets across the pit, with expectations for reaching the far wall, arriving near the line, motor temperatures and battery left.${sizes} Then run it and tell me what it shows.`;
    },
  },
];

/** The scenario source a template writes for this design, or why it cannot. */
export function templateSource(t: SimTemplate, m: Model): { source?: string; prompt?: string; reason?: string } {
  const why = t.unavailable?.(m);
  if (why) return { reason: why };
  if (t.source) {
    const s = t.source(m);
    return s ? { source: s } : { reason: "This design has nothing for this test to check." };
  }
  return { prompt: t.prompt?.(m) };
}

/** A description in plain words, as a request to Claude. */
export function describePrompt(text: string): string {
  return `Set up a simulation scenario for this: ${text.trim()}\nUse the world that fits, sizes from the brief, the machine described from the design's own parameters, and expectations that match what I asked. If Kerf cannot simulate part of it yet, say which part and set up the closest test. Then run it and tell me what it shows.`;
}
