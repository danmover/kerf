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

describe("parts left off the machine for a run", () => {
  // an arm on a hinge with a lock screw threaded through it into the post, and a guard that sits on the base
  const src = (items: string) => `
part base { body box(120, 60, 6, at: (0, 0, 0)) }
part post { material: "Aluminum 6061"  body box(20, 20, 40, at: (-30, 0, 6))  cut hole(M3, depth: 6, at: (-20, 0, 30), dir: -X) }
part arm {
  material: "Aluminum 6061"
  body box(8, 20, 40, at: (-16, 0, 6))
  cut hole(M3, fit: "tap", depth: 8, at: (-12, 0, 30), dir: -X)
}
part guard { material: "Aluminum 6061"  body box(10, 10, 10, at: (40, 0, 6)) }
component lock = lib.screw(M3, 12) { at: (-12, 0, 30), axis: -X }
scenario "swing" {
  world: sim.bench()
  mechanism: sim.mechanism(sim.pivot(arm, at: (-16, 0, 8), axis: Y, limits: (-45, 45))${items})
  duration: 0.2s
  variants: ["expected"]
}`;
  const resolve = (items: string) => {
    const model = evaluate(src(items));
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const cache = new Map<string, MeshEntry>();
    const geom = (h: string): MeshEntry | undefined => {
      if (!cache.has(h)) {
        const p = model.parts.find((x) => x.hash === h);
        if (!p) return undefined;
        const s = buildPart(p.recipe);
        cache.set(h, { preview: meshShape(s, "preview"), volume: solidVolume(s), bbox: s.boundingBox.bounds as [V3, V3], rev: 0 });
      }
      return cache.get(h);
    };
    return { model, r: resolveMechanism(model.scenarios![0].spec, model, geom, true) };
  };

  it("a lock screw rides with the arm it is threaded into, until the run leaves it off", () => {
    const fitted = resolve("");
    const out = resolve(", sim.without([lock, guard])");
    if (!("mech" in fitted.r) || !("mech" in out.r)) throw new Error(JSON.stringify([fitted.r, out.r]));
    const armOf = (m: typeof fitted.r.mech) => m.bodies.find((b) => b.id === "arm")!;
    const lockId = fitted.model.parts.find((p) => p.name === "lock")!.id;
    expect(armOf(fitted.r.mech).parts).toContain(lockId);
    expect(fitted.r.mech.off).toBeUndefined();
    // left off: on no body at all (not the arm, not the frame), and the arm is lighter by the screw
    expect(out.r.mech.bodies.flatMap((b) => b.parts)).not.toContain(lockId);
    expect(out.r.mech.bodies.flatMap((b) => b.parts)).not.toContain("guard");
    expect([...out.r.mech.off!].sort()).toEqual([lockId, "guard"].sort());
    const dm = (armOf(fitted.r.mech).mass - armOf(out.r.mech).mass) * 1000;
    expect(dm).toBeGreaterThan(0.4);
    expect(dm).toBeLessThan(1.5);
    const frame = (m: typeof fitted.r.mech) => m.bodies.find((b) => b.fixed)!;
    expect((frame(fitted.r.mech).mass - frame(out.r.mech).mass) * 1000).toBeCloseTo(2.7, 1);
    expect(out.r.mech.notes.join(" ")).toMatch(/left off the machine for this run: lock, guard/);
    // the view is told not to draw them
    const res = runSpec({ ...out.model.scenarios![0].spec, mech: out.r.mech }, out.model.machine ?? emptyMachine(), out.model.name);
    expect(res.variants[0].error).toBeUndefined();
    expect([...(res.variants[0].scene.off ?? [])].sort()).toEqual([lockId, "guard"].sort());
  });

  it("refuses a part that is both left off and on a joint, and a name the design does not have", () => {
    const both = resolve(", sim.without(arm)");
    expect("error" in both.r && both.r.error).toMatch(/arm is left off this run \(sim\.without\) and on the joint arm/);
    const none = evaluate(src(", sim.without(nothing_here)"));
    expect(none.diagnostics.filter((d) => d.severity === "error").length).toBeGreaterThan(0);
  });
});
