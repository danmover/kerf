// Benchmark briefs: typed requests a user would send to get a complete,
// buildable machine, each with what a finished answer has to contain. The
// scorer reads a design (and its check results, when the geometry has been
// built) and says which parts of a complete answer are there. Use it to
// compare designs Claude produces for the same brief across prompt or model
// changes; the demos are the reference answers.

import type { Model } from "../core/model";
import type { CheckItem } from "../core/checks";
import type { CatalogKind } from "./types";

export interface Brief {
  id: string;
  /** what the user types */
  text: string;
  /** reference design that answers it, when one ships */
  reference?: string;
  /** catalog kinds the answer must buy (at least one of each) */
  kinds: CatalogKind[];
  /** calculators the sizing must use */
  calcs: string[];
  firmware?: "arduino" | "klipper";
  /** at least this many requirements tied to the brief's purpose */
  minRequirements: number;
  /** the answer must write the job into a brief { } block: these givens, and a requirement for every use */
  givens?: string[];
}

export const BRIEFS: Brief[] = [
  {
    id: "sand-drill",
    text: "I want to make a drill powered by some sort of Arduino that can drive forwards and turn. It needs to pass through a metre of sand in a 10 m tall box of sand and get to the other side.",
    reference: "sand-tunneller",
    kinds: ["controller", "gearmotor", "motor_driver", "battery", "sensor"],
    calcs: ["sand_stress", "screw_burrow", "motor_point", "battery_runtime"],
    firmware: "arduino",
    minRequirements: 5,
  },
  {
    id: "sand-pit",
    text: "Make sure the drill can go through a 2 m long pit of sand at ground level when the sand is 5 m deep, like a box where you have to drill through the bottom.",
    reference: "sand-tunneller",
    kinds: ["controller", "gearmotor", "motor_driver", "battery", "sensor"],
    calcs: ["sand_stress", "screw_burrow", "motor_point", "battery_runtime"],
    firmware: "arduino",
    minRequirements: 5,
    givens: ["pit_l", "pit_depth"],
  },
  {
    id: "printer",
    text: "Same thing for a 3D printer: a complete printer I can order the parts for and build.",
    reference: "printer",
    kinds: ["controller", "stepper", "hotend", "heated_bed", "psu"],
    calcs: ["stepper_axis", "lead_screw", "heater_warmup", "print_speed"],
    firmware: "klipper",
    minRequirements: 4,
  },
  {
    id: "line-follower",
    text: "A small two-wheel robot that follows a black line on the floor, runs for an hour on a battery and fits in a 150 mm cube.",
    kinds: ["controller", "gearmotor", "motor_driver", "battery", "sensor"],
    calcs: ["motor_point", "battery_runtime"],
    firmware: "arduino",
    minRequirements: 3,
  },
  {
    id: "camera-slider",
    text: "A 600 mm motorised camera slider for a 2 kg camera that moves smoothly at 1 to 50 mm/s, powered from a 12 V adapter.",
    kinds: ["controller", "stepper", "stepper_driver", "rail", "psu"],
    calcs: ["wire_gauge"],
    firmware: "arduino",
    minRequirements: 3,
  },
  {
    id: "pan-tilt",
    text: "A pan and tilt head for a 500 g sensor with ±90° pan and ±45° tilt, controlled over USB.",
    kinds: ["controller", "servo"],
    calcs: [],
    firmware: "arduino",
    minRequirements: 3,
  },
  {
    id: "conveyor",
    text: "A 1 m benchtop belt conveyor that carries 5 kg parcels at 0.2 m/s and stops when a sensor sees a parcel at the end.",
    kinds: ["controller", "gearmotor", "motor_driver", "psu", "sensor"],
    calcs: ["motor_point", "wire_gauge"],
    firmware: "arduino",
    minRequirements: 3,
  },
];

export interface ScoreLine {
  label: string;
  ok: boolean;
  detail: string;
}

export interface BriefScore {
  brief: string;
  score: number;
  of: number;
  lines: ScoreLine[];
}

/**
 * Scores a design against a brief. Pass the check items when the geometry has
 * been built (the app's report, or tests/helpers/fullcheck), so interference,
 * tool access and wiring count too.
 */
export function scoreBrief(brief: Brief, model: Model, items?: CheckItem[]): BriefScore {
  const m = model.machine;
  const lines: ScoreLine[] = [];
  const add = (label: string, ok: boolean, detail: string) => lines.push({ label, ok, detail });

  const errors = model.diagnostics.filter((d) => d.severity === "error").length;
  add("Design evaluates", errors === 0, errors ? `${errors} source errors` : "no errors");

  const kinds = new Set(m?.components.map((c) => c.kind) ?? []);
  const missingKinds = brief.kinds.filter((k) => !kinds.has(k));
  add("Buys the parts the brief needs", missingKinds.length === 0, missingKinds.length ? `missing ${missingKinds.join(", ")}` : brief.kinds.join(", "));

  const made = model.parts.filter((p) => p.kind === "part").length;
  add("Has parts to make", made > 0, `${made} made parts`);

  const used = new Set(m?.calcs.map((c) => c.fn) ?? []);
  const missingCalcs = brief.calcs.filter((c) => !used.has(c));
  add("Sizes the machine with calculations", missingCalcs.length === 0 && (brief.calcs.length === 0 || used.size > 0), missingCalcs.length ? `missing ${missingCalcs.join(", ")}` : `${used.size} calculators used`);

  const wires = (m?.wires.length ?? 0) + (m?.nets.length ?? 0);
  add("Wires the electronics", wires > 0, `${m?.wires.length ?? 0} wires, ${m?.nets.length ?? 0} nets`);

  if (brief.firmware) {
    const hasFw = (m?.firmware.length ?? 0) > 0;
    add(`Writes ${brief.firmware === "klipper" ? "the Klipper config" : "the firmware"}`, hasFw, hasFw ? m!.firmware.map((f) => f.name).join(", ") : "no firmware block");
  }

  const reqs = model.requirements;
  const passing = reqs.filter((r) => r.status === "pass").length;
  add("States and meets requirements", reqs.length >= brief.minRequirements && passing === reqs.length, `${passing} of ${reqs.length} pass (needs at least ${brief.minRequirements})`);

  if (brief.givens) {
    const b = model.brief;
    const names = new Set(b?.givens.map((g) => g.name) ?? []);
    const missing = brief.givens.filter((g) => !names.has(g));
    const uncovered = b?.uses.filter((u) => !reqs.some((r) => r.uses.includes(u.id))) ?? [];
    const ok = !!b && missing.length === 0 && b.uses.length > 0 && uncovered.length === 0;
    const detail = !b
      ? "no brief block"
      : missing.length
        ? `missing givens ${missing.join(", ")}`
        : !b.uses.length
          ? "no uses"
          : uncovered.length
            ? `no requirement for ${uncovered.map((u) => u.id).join(", ")}`
            : `${b.givens.length} givens, ${b.uses.length} uses, each with requirements`;
    add("Writes the job into the brief", ok, detail);
  }

  const tests = m?.tests.length ?? 0;
  add("Plans physical tests", tests > 0, `${tests} tests`);

  if (items) {
    const fails = items.filter((i) => i.status === "fail");
    add("Passes every check", fails.length === 0, fails.length ? fails.map((f) => f.title).slice(0, 4).join("; ") : `${items.length} checks`);
  }

  return { brief: brief.id, score: lines.filter((l) => l.ok).length, of: lines.length, lines };
}
