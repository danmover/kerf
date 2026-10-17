// Mechanism physics on a demo's real geometry: masses and axes from the kernel's own meshes.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { buildPart, meshShape, solidVolume } from "../src/kernel/build";
import { resolveMechanism } from "../src/sim/mech/resolve";
import { runSpec } from "../src/sim/build";
import { outcomesFor } from "../src/sim/runtime";
import { emptyMachine } from "../src/machine/types";
import type { MeshEntry } from "../src/core/engine";
import type { V3 } from "../src/kernel/recipe";
import { loadOC } from "./occt";

beforeAll(loadOC, 60_000);

describe("the reducer demo as a mechanism", () => {
  it("turns its output once for every 12 motor turns, through gears found from spin: and mesh:", () => {
    // (the demo's own "Spins up to speed" scenario does the same in the app)
    const src = readFileSync(join(__dirname, "../src/demos/reducer.kerf"), "utf8");
    const model = evaluate(`${src}
scenario "Turns 12:1" {
  mechanism: sim.mechanism(sim.turn(motor, speed: 600rpm))
  duration: 2s
  variants: ["expected"]
  expect "12:1": abs(motor.turns / g4.turns - 12) < 0.05
}
`);
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const def = model.scenarios!.find((s) => s.label === "Turns 12:1")!;
    const cache = new Map<string, MeshEntry>();
    const geom = (h: string): MeshEntry | undefined => {
      if (!cache.has(h)) {
        const p = model.parts.find((x) => x.hash === h);
        if (!p) return undefined;
        const s = buildPart(p.recipe);
        const bb = s.boundingBox.bounds as [V3, V3];
        cache.set(h, { preview: meshShape(s, "preview"), volume: solidVolume(s), bbox: bb, rev: 0 });
      }
      return cache.get(h);
    };
    const r = resolveMechanism(def.spec, model, geom, true);
    if (!("mech" in r)) throw new Error(JSON.stringify(r));
    // the motor's shaft and pinion turn; its body stays bolted to the housing
    const frame = r.mech.bodies.find((b) => b.fixed)!;
    const motor = r.mech.bodies.find((b) => b.id === "motor")!;
    expect(frame.mass).toBeGreaterThan(0.3);
    expect(motor.mass).toBeLessThan(0.01);
    expect(r.mech.joints.map((j) => j.name).sort()).toEqual(["g2", "g4", "motor"]);
    expect(r.mech.links.filter((l) => l.kind === "gears")).toHaveLength(2);
    expect(r.mech.notes.join(" ")).toMatch(/motor's own bearings/);
    expect(r.mech.notes.join(" ")).toMatch(/out_front \(688\)/);
    const res = runSpec({ ...def.spec, mech: r.mech }, model.machine ?? emptyMachine(), model.name);
    const v = res.variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results.unstable).toBe(false);
    expect(v.results["motor.turns"] as number).toBeCloseTo(20, 1);
    expect(v.results["g4.turns"] as number).toBeCloseTo(20 / 12, 2);
    // the middle shaft turns the other way
    expect(Math.sign(v.results["g2.turns"] as number)).toBe(-Math.sign(v.results["motor.turns"] as number));
    // the demo's own scenario passes
    const demo = model.scenarios!.find((s) => s.label === "Spins up to speed")!;
    const dr = resolveMechanism(demo.spec, model, geom, true);
    if (!("mech" in dr)) throw new Error(JSON.stringify(dr));
    const dres = runSpec({ ...demo.spec, mech: dr.mech }, model.machine ?? emptyMachine(), model.name);
    expect(outcomesFor(demo, dres)!.map((o) => `${o.label}: ${o.status}`)).toEqual(["Output turns 12:1: pass", "Output reaches 25 rpm: pass"]);
  }, 120_000);
});
