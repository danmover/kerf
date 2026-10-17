// Turns a scenario's spec into the world each run uses, and runs it. Kept
// free of the browser so the worker and the tests share it.

import type { MachineData } from "../machine/types";
import { runScenario, type RunResult } from "./engine/run";
import { runPrinter } from "./printer/run";
import type { ScenarioSpec } from "./scenario";
import { Bench } from "./worlds/bench";
import { SandPit, type TunnellerSpec } from "./worlds/sandPit";
import type { VariantName } from "./worlds/common";
import type { World } from "./worlds/types";
import { MechWorld } from "./worlds/mechanism";
import { mechFrameHz, runMechanism } from "./mech/runMech";

/** How far in from the near wall the robot's hinge starts, and what that means. */
export function pitStart(start: ScenarioSpec["world"] & { kind: "sand_pit" }): { x: number; note: string } {
  const { pit, robot } = start;
  const h = robot.hinge?.x ?? 0;
  if (typeof pit.start === "number") return { x: pit.start, note: `Starts with its ${robot.hinge ? "hinge" : "design origin"} ${Math.round(pit.start)} mm in from the near wall` };
  if (pit.start === "buried") return { x: h - robot.tail + 5, note: "Starts buried, lying straight on the floor with its tail against the near wall" };
  // "wall": the front section's flights start at the wall face, the rest sits in a keyed launch hole
  const front = frontScrews(robot);
  const x = robot.hinge ? 0 : h - Math.min(...(front.length ? front : robot.screws).map((s) => s.from));
  return { x, note: "Starts in a keyed launch hole in the near wall: the rear section is held straight in the hole and the front section is against the sand" };
}

const frontScrews = (r: TunnellerSpec) => r.screws.filter((s) => (s.from + s.to) / 2 >= (r.hinge?.x ?? 0));

/** The world for one variant of a scenario. */
export function worldFor(spec: ScenarioSpec, machine: MachineData): (variant: VariantName, seed: number) => World & { assumptions?: string[] } {
  const w = spec.world;
  if (w.kind === "sand_pit") {
    const st = pitStart(w);
    return (variant, seed) => {
      const world = new SandPit({ ...w.pit, start: st.x }, w.robot, variant, seed);
      world.assumptions.unshift(st.note);
      return world;
    };
  }
  if (w.kind === "printer") throw new Error("a printer scenario runs through runPrinter");
  const mech = spec.mech;
  if (w.kind === "floor") {
    if (!mech) throw new Error("A floor needs the mechanism resolved first");
    return (variant) => new MechWorld(mech, variant, null, w.floor.ambient, "floor");
  }
  if (mech) return (variant) => new MechWorld(mech, variant, new Bench(machine, w.bench, variant), w.bench.ambient, "bench");
  return (variant) => new Bench(machine, w.bench, variant);
}

/** Run a scenario's variants (all of them, or the ones given) in this thread. */
export function runSpec(spec: ScenarioSpec, machine: MachineData, designName: string, opts: { variants?: VariantName[]; onProgress?: (variant: VariantName, done: number) => void } = {}): RunResult {
  if (spec.world.kind === "printer")
    return runPrinter({ machine, designName, firmware: spec.firmware, world: spec.world.printer, duration: spec.duration, config: spec.config, variants: opts.variants ?? spec.variants, seed: spec.seed, onProgress: opts.onProgress });
  if (spec.mechanism && !spec.mech) throw new Error("The mechanism has not been resolved against the built parts yet");
  if (spec.physicsOnly) {
    const world = worldFor(spec, machine) as (variant: VariantName, seed: number) => MechWorld;
    return runMechanism({ machine, world, duration: spec.duration, variants: opts.variants ?? spec.variants, seed: spec.seed, onProgress: opts.onProgress });
  }
  return runScenario({
    machine,
    designName,
    firmware: spec.firmware,
    world: worldFor(spec, machine),
    duration: spec.duration,
    console: spec.console,
    config: spec.config,
    soc: spec.charge,
    variants: opts.variants ?? spec.variants,
    seed: spec.seed,
    frameHz: spec.mech ? mechFrameHz(spec.duration) : undefined,
    onProgress: opts.onProgress,
  });
}
