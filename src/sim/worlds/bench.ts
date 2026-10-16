// The bench: the machine standing still on a table with its electronics
// powered. Each motor turns against the steady load its design gives it
// (`load:` on the component) and the sensors see a level, still machine.
// It is the world for any design that has firmware but no environment of its
// own yet: it still runs the real firmware against the real wiring, battery
// and motors, so pin mistakes, current draw, heat and battery life show up.

import type { MachineData } from "../../machine/types";
import { catalogPart } from "../../machine/catalog";
import type { MotorLoad, Orientation, PlantView, SceneSpec, World, WorldEvent } from "./types";
import type { VariantName } from "./common";

export interface BenchSpec {
  /** load on each motor, N·mm (defaults to the component's `load:`) */
  loads: Record<string, number>;
  /** force on each actuator rod, N (+ pushes it in) */
  forces: Record<string, number>;
  /** what range sensors see, mm */
  range: number;
  ambient: number;
}

const K: Record<VariantName, number> = { pessimistic: 1.3, expected: 1, optimistic: 0.7 };

export class Bench implements World {
  kind = "bench";
  events: WorldEvent[] = [];
  limits = [
    "The machine stands still: motors turn against a steady friction load and sensors read a level machine with nothing moving round it.",
    "Loads are the design's own `load:` numbers, ±30 % across the three runs.",
  ];
  assumptions: string[] = [];
  private loads = new Map<string, number>();
  private turns = new Map<string, number>();
  private moved = new Set<string>();

  constructor(
    public machine: MachineData,
    public spec: BenchSpec,
    public variant: VariantName,
  ) {
    for (const mc of machine.components) {
      const part = catalogPart(mc.catalogId);
      if (part?.kind !== "gearmotor") continue;
      const load = spec.loads[mc.name] ?? mc.load ?? 0;
      this.loads.set(mc.name, load * K[variant]);
      if (!(mc.name in spec.loads) && mc.load === undefined) this.assumptions.push(`${mc.name}: no load: given, so it runs free`);
    }
    this.assumptions.push(`${variant} run: motor loads ×${K[variant]}`);
  }

  motorLoad(comp: string): MotorLoad {
    return { coulomb: (this.loads.get(comp) ?? 0) / 1000, viscous: 0, external: 0, inertia: 1e-4 };
  }

  actuatorLoad(comp: string): number {
    return this.spec.forces[comp] ?? 0;
  }

  orientation(): Orientation {
    return { yaw: 0, pitch: 0, roll: 0, rate: [0, 0, 0], accel: [0, 0, 0] };
  }

  range(): number {
    return this.spec.range;
  }

  thermal() {
    return { ambient: this.spec.ambient, cooling: 1 };
  }

  step(_dt: number, t: number, plant: PlantView): void {
    for (const name of this.loads.keys()) {
      const m = plant.motor(name);
      if (!m) continue;
      const turns = m.angle / (2 * Math.PI);
      this.turns.set(name, turns);
      if (Math.abs(turns) > 0.25 && !this.moved.has(name)) {
        this.moved.add(name);
        this.events.push({ t, kind: "info", text: `${name} turned ${turns > 0 ? "forward" : "backward"}` });
      }
    }
  }

  channels(): Record<string, number> {
    return {};
  }

  finished(): boolean {
    return false;
  }

  results(): Record<string, number | boolean | string> {
    const r: Record<string, number | boolean | string> = {};
    for (const [name, turns] of this.turns) r[`${name}.turns`] = turns;
    return r;
  }

  scene(): SceneSpec {
    return {
      kind: "bench",
      floor: 0,
      bodies: [{ id: "base", xmin: -Infinity, xmax: Infinity, origin: [0, 0, 0], spin: [] }],
      notes: ["On the bench: nothing moves but the motors"],
    };
  }
}
