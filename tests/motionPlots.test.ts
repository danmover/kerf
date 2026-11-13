// Motion plots and loads from a mechanism run: a followed point's path, speed and acceleration against the
// textbook circle, the power and work a gearmotor puts in, and what a bearing carries.

import { describe, expect, it } from "vitest";
import { FRAME, type MechBody, type MechModel } from "../src/sim/mech/model";
import { MechWorld } from "../src/sim/worlds/mechanism";
import { runMechanism } from "../src/sim/mech/runMech";
import { evaluate } from "../src/lang/evaluator";
import { channelInfo } from "../src/sim/channels";
import type { M3, V3 } from "../src/sim/mech/solver";
import type { MachineData } from "../src/machine/types";

const G = 9.80665;
const diag = (a: number, b = a, c = a): M3 => [a, 0, 0, 0, b, 0, 0, 0, c];
const body = (id: string, mass: number, com: V3, I: M3 = diag(1e-6)): MechBody => ({ id, label: id, parts: [], mass, com, inertia: I, points: [], boxes: [] });
const mech = (m: Partial<MechModel>): MechModel => ({ bodies: [], joints: [], drives: [], links: [], springs: [], loads: [], wheels: [], tracks: [], loose: [], ground: null, base: "fixed", gravity: [0, 0, -G], mounts: {}, power: {}, notes: [], ...m });
const none = { components: [], wires: [], nets: [], calcs: [], firmware: [], tests: [], items: [], boards: [], belts: [] } as unknown as MachineData;
const last = (xs: ArrayLike<number>) => xs[xs.length - 1];

describe("following a point", () => {
  it("draws a crank pin's circle at ω r, with ω² r toward the middle", () => {
    // a crank turned at 60 rpm about Z (level, so its weight does nothing), its pin 100 mm out
    const m = mech({
      bodies: [body("crank", 0.2, [0.05, 0, 0], diag(1e-4))],
      joints: [{ kind: "pivot", name: "crank", body: "crank", on: FRAME, at: [0, 0, 0], axis: [0, 0, 1] }],
      drives: [{ kind: "turn", name: "hand", joint: "crank", speed: [[0, 2 * Math.PI]], limit: 1e6 }],
      traces: [{ name: "pin", body: "crank", at: [0.1, 0, 0] }],
    });
    const r = runMechanism({ machine: none, world: (v) => new MechWorld(m, v, null, 20), duration: 2, variants: ["expected"] });
    const v = r.variants[0];
    expect(v.error).toBeUndefined();
    const s = v.frames.series;
    // a circle of radius 100 about the pivot, at 2π × 100 mm/s, pulled in at (2π)² × 0.1 m/s²
    const tail = (n: string) => Array.from(s[n]).slice(5);
    for (const [x, y] of tail("pin.x").map((x, i) => [x, tail("pin.y")[i]])) expect(Math.hypot(x, y)).toBeCloseTo(100, 1);
    for (const sp of tail("pin.speed")) expect(sp).toBeCloseTo(200 * Math.PI, 0);
    for (const a of tail("pin.accel")) expect(Math.abs(a - 4 * Math.PI * Math.PI * 0.1)).toBeLessThan(0.05);
    // (the hand starts it with a jolt: a little over at the first step)
    expect(Math.abs((v.results["pin.max_speed"] as number) / (200 * Math.PI) - 1)).toBeLessThan(0.01);
    // twice round in 2 s: 4π × 100 mm of path, never more than the diameter from where it started
    expect(v.results["pin.path"] as number).toBeGreaterThan(0.97 * 400 * Math.PI);
    expect(v.results["pin.path"] as number).toBeLessThan(1.01 * 400 * Math.PI);
    expect(v.results["pin.reach"] as number).toBeCloseTo(200, 0);
    expect(v.results["pin.x_min"] as number).toBeCloseTo(-100, 0);
    expect(v.results["pin.y_max"] as number).toBeCloseTo(100, 0);
    expect(channelInfo("pin.accel")).toEqual({ label: "pin acceleration", unit: "m/s²", group: "pin" });
  });

  it("reads sim.trace in a scenario", () => {
    const model = evaluate(`design "t"
part base { body box(100, 60, 10) }
part arm { body box(200, 20, 10, at: (100, 0, 245)) }
scenario "Swing" {
  mechanism: sim.mechanism(sim.pivot(arm, at: (0, 0, 250), axis: -Y), sim.trace(on: arm, at: (200, 0, 250), name: "tip"))
  duration: 2s
}
`);
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    expect(model.scenarios![0].spec.mechanism!.items.find((i) => i.k === "trace")).toEqual({ k: "trace", name: "tip", on: "arm", at: [200, 0, 250] });
    expect(() => evaluate(`design "t"\npart arm { body box(20, 20, 10) }\nscenario "s" { mechanism: sim.mechanism(sim.pivot(arm, at: (0, 0, 0), axis: Y), sim.trace(on: arm)) }\n`).diagnostics.forEach((d) => {
      if (d.severity === "error") throw new Error(d.message);
    })).toThrow(/needs at:/);
  });
});

describe("drive power and bearing loads", () => {
  const machine = { ...none, components: [{ name: "m1", catalogId: "gobilda_5203_19_2", kind: "gearmotor" }] } as unknown as MachineData;

  it("gives a gearmotor's torque, power and work lifting an arm, and the load on its bearing", () => {
    // 0.5 kg 0.3 m out, lifted from level onto a stop 86° up
    const m = mech({
      bodies: [body("arm", 0.5, [0.3, 0, 0], diag(1e-4, 1e-3, 1e-3))],
      joints: [{ kind: "pivot", name: "arm", body: "arm", on: FRAME, at: [0, 0, 0], axis: [0, -1, 0], limits: [-0.1, 1.5], frictionPerLoad: 0 }],
      drives: [{ kind: "motor", joint: "arm", comp: "m1", sign: 1 }],
    });
    const v = runMechanism({ machine, world: (x) => new MechWorld(m, x, null, 20), duration: 1.5, variants: ["expected"] }).variants[0];
    expect(v.error).toBeUndefined();
    // it holds its weight's 1.47 N·m at least, and does the lift's work (m g h) and more (the stop takes the rest)
    expect(v.results["m1.peak_torque"] as number).toBeGreaterThan(1470);
    expect(v.results["m1.work"] as number).toBeGreaterThan(0.5 * G * 0.3 * Math.sin(1.5));
    expect(v.results["m1.work"] as number).toBeLessThan(4);
    expect(v.results["m1.peak_power"] as number).toBeGreaterThan(5);
    expect(Math.max(...Array.from(v.frames.series["m1.power"]))).toBeCloseTo(v.results["m1.peak_power"] as number, -1);
    // held still on its stop, the bearing carries the arm's weight
    expect(last(v.frames.series["arm.reaction"])).toBeCloseTo(0.5 * G, 0);
    expect(v.results["arm.bearing_load"] as number).toBeGreaterThanOrEqual(last(v.frames.series["arm.reaction"]));
    expect(channelInfo("arm.reaction").unit).toBe("N");
  });
});
