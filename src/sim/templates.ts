// Ready-made scenarios for the Simulate tab's gallery. Bench tests are
// written straight from the design (its firmware block, motors and battery);
// worlds that need the machine described in detail, like a sand pit, are set
// up by Claude from the design's own parameters.

import type { Model } from "../core/model";
import { catalogPart } from "../machine/catalog";
import type { ScenarioDef } from "./scenario";

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
  /** fault tests sit in their own row of the gallery */
  group?: "faults";
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
  if (!firmwareOf(m)) return "Kerf can simulate Arduino firmware; this design's firmware is for a board it cannot simulate yet (Klipper).";
  return null;
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

// ---------- fault tests ----------

const partsOf = (m: Model, kind: string) => (m.machine?.components ?? []).filter((c) => catalogPart(c.catalogId)?.kind === kind);
const wired = (m: Model, comp: string, pin: string) =>
  (m.machine?.wires ?? []).some((w) => (w.a.comp === comp && w.a.pin === pin) || (w.b.comp === comp && w.b.pin === pin)) || (m.machine?.nets ?? []).some((n) => n.pins.some((p) => p.comp === comp && p.pin === pin));

/** The scenario a fault test repeats with something going wrong: the design's first one that has no faults of its own. */
function baseScenario(m: Model): ScenarioDef | undefined {
  return (m.scenarios ?? []).find((s) => !s.spec.faults?.length);
}

/** When the fault happens: a minute into the job, once the firmware's start delay is over. */
function faultAt(m: Model, base?: ScenarioDef): number {
  const cfg = base?.spec.config.START_DELAY_S;
  const delay = typeof cfg === "number" ? cfg : startDelay(m);
  const at = delay + 60;
  return base ? Math.min(at, Math.round(base.spec.duration / 2)) : at;
}

/** A fault scenario: like the design's own scenario when it has one, else on the bench. */
function faultScenario(m: Model, label: string, faults: string, expects: string[], opts: { all?: boolean; extra?: string[] } = {}): string {
  const base = baseScenario(m);
  const head = base
    ? [`  like: "${base.label}"`]
    : [`  world: sim.bench()`, `  firmware: ${firmwareOf(m)!.name}`, `  duration: ${fmtS(Math.max(180, Math.ceil((faultAt(m) + 120) / 60) * 60))}`];
  return [`scenario "${freeLabel(m, label)}" {`, ...head, ...(faults ? [`  faults: ${faults}`] : []), ...(opts.extra ?? []).map((x) => `  ${x}`), ...(opts.all ? [] : ['  variants: "expected"']), ...expects.map((e) => `  ${e}`), "}"].join("\n");
}

const at = (s: number) => fmtS(s);
/** the motor a fault test picks: the one doing the main work (named front or first), else the first */
const mainMotor = (m: Model) => {
  const ms = partsOf(m, "gearmotor");
  return ms.find((c) => /front|main|drive/i.test(`${c.name} ${c.role ?? ""}`)) ?? ms[0];
};

const FAULT_TEMPLATES: SimTemplate[] = [
  {
    id: "fault_jam",
    group: "faults",
    title: "A motor jams",
    blurb: "The main motor locks solid a minute into the job. The firmware should notice, stop driving into it and end up stopped, with no fuse blown and nothing cooked.",
    unavailable: (m) => needsFirmware(m) ?? (mainMotor(m) ? null : "The design has no gearmotor to jam."),
    source: (m) => {
      const n = mainMotor(m)!.name;
      return faultScenario(m, `${n} jams`, `sim.jam(${n}, at: ${at(faultAt(m, baseScenario(m)))})`, [
        'expect "Notices the jam": fault_noticed',
        'expect "Ends stopped": fault_stopped && still_at_end',
        `expect "${n} stays below 80 °C" soft: ${n}.max_temp < 80C`,
        'expect "No fuse blows" soft: fuse_blown == false',
      ]);
    },
  },
  {
    id: "fault_wire",
    group: "faults",
    title: "A wire comes loose",
    blurb: "The main motor's encoder wire comes off mid-job (its power wire, with no encoder). The firmware should notice and stop safely rather than drive blind.",
    unavailable: (m) => needsFirmware(m) ?? (mainMotor(m) ? null : "The design has no motor wiring to loosen."),
    source: (m) => {
      const n = mainMotor(m)!.name;
      const pin = wired(m, n, "ENC_A") ? "ENC_A" : "M_PLUS";
      return faultScenario(m, `${n} ${pin === "ENC_A" ? "encoder" : "power"} wire loose`, `sim.loose("${n}.${pin}", at: ${at(faultAt(m, baseScenario(m)))})`, [
        'expect "Notices the loose wire": fault_noticed',
        'expect "Ends stopped" soft: still_at_end',
      ]);
    },
  },
  {
    id: "fault_sensor",
    group: "faults",
    title: "A sensor stops answering",
    blurb: "The IMU (or the first sensor) is unplugged mid-job. See whether the firmware notices and does something sensible without it.",
    unavailable: (m) => needsFirmware(m) ?? (partsOf(m, "sensor").length ? null : "The design has no sensor to lose."),
    source: (m) => {
      const ss = partsOf(m, "sensor");
      const s = ss.find((c) => /imu|bno|mpu/i.test(`${c.name} ${c.catalogId}`)) ?? ss[0];
      return faultScenario(m, `${s.name} stops answering`, `sim.unplug(${s.name}, at: ${at(faultAt(m, baseScenario(m)))})`, [
        `expect "Notices ${s.name} is gone" soft: fault_noticed`,
        'expect "Ends stopped": still_at_end',
        'expect "No fuse blows" soft: fuse_blown == false',
      ]);
    },
  },
  {
    id: "fault_flat",
    group: "faults",
    title: "Battery nearly flat",
    blurb: "Start the job with 15 % charge. The firmware should stop on its low-battery limit before the cells are run flat, and leave the motors off.",
    unavailable: (m) => needsFirmware(m) ?? (hasBattery(m) ? null : "The design has no battery to run down."),
    source: (m) =>
      faultScenario(m, "Battery nearly flat", "", ['expect "Stops before the battery is flat": battery_left > 3%', 'expect "Ends stopped": still_at_end', 'expect "Battery voltage holds up" soft: battery_min_volts > 0.8 * BAT.v_nom'], { extra: ["charge: 15%"] }).replace(
        /BAT\.v_nom/g,
        `${partsOf(m, "battery")[0]?.name ?? "bat"}.v_nom`,
      ),
  },
  {
    id: "fault_old_battery",
    group: "faults",
    title: "Old battery",
    blurb: "The same job at the end of the battery's life: 80 % of its capacity and 1.5 times its internal resistance. Everything the job has to achieve should still hold.",
    unavailable: (m) => needsFirmware(m) ?? (hasBattery(m) ? null : "The design has no battery to age."),
    source: (m) => {
      const bat = partsOf(m, "battery")[0].name;
      const base = baseScenario(m);
      const expects = base?.expects.length
        ? base.expects.map((e) => `expect "${e.label}"${e.level === "soft" ? " soft" : ""}: ${e.text}`)
        : ['expect "Charge to spare at the end": battery_left > 20%', 'expect "No firmware mistakes": faults == 0'];
      return faultScenario(m, "Old battery", `sim.aged(${bat}, capacity: 80%, resistance: 1.5)`, expects, { all: true });
    },
  },
];

export const SIM_TEMPLATES: SimTemplate[] = [
  {
    id: "power_up",
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
    title: "Battery runtime",
    blurb: "A full job at the design load: the battery lasts with charge to spare and its voltage holds up under load.",
    unavailable: (m) => needsFirmware(m) ?? (hasBattery(m) ? null : "The design has no battery to follow."),
    source: (m) =>
      bench(m, "Battery runtime", "sim.bench()", 30 * 60, ['expect "Charge to spare at the end": battery_left > 20%', 'expect "No firmware mistakes": faults == 0', ...motors(m).map((n) => `expect "${n} stays below 80 °C" soft: ${n}.max_temp < 80C`)]),
  },
  {
    id: "hot_room",
    title: "Hot room",
    blurb: "The same job at 40 °C: motors and drivers shed less heat, so check the windings stay cool enough.",
    unavailable: needsFirmware,
    source: (m) => bench(m, "Hot room", "sim.bench(ambient: 40C)", 20 * 60, [...motors(m).map((n) => `expect "${n} stays below 90 °C": ${n}.max_temp < 90C`), 'expect "No firmware mistakes": faults == 0']),
  },
  {
    id: "overload",
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
    id: "sand_pit",
    title: "Sand pit crossing",
    blurb: "Burrow through a box of sand: Janssen stress at depth, screw thrust and slip, steering, walls and an exit opening. Claude describes the machine from the design.",
    unavailable: needsFirmware,
    prompt: (m) => {
      const g = m.brief?.givens ?? [];
      const sizes = g.length ? ` Use the pit sizes from the brief's givens (${g.map((x) => x.name).join(", ")}).` : " Ask me for the pit's size if the brief does not give it.";
      return `Add a sand pit scenario that tests whether this machine gets across the pit, with expectations for reaching the far wall, arriving near the line, motor temperatures and battery left.${sizes} Then run it and tell me what it shows.`;
    },
  },
  ...FAULT_TEMPLATES,
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
