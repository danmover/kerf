// Connecting rods: a piston sliding and a rocker swinging as a crank turns,
// solved so the rod keeps its length, the rod following both pins, and the
// checks on linkages that lock, bind or have no rod.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { applyMat, motionPose, solveLink, sweepLink } from "../src/core/kinematics";
import { linkChecks } from "../src/core/linkChecks";
import type { V3 } from "../src/kernel/recipe";
import { initKernel } from "./helpers/kernel";
import { KernelCore } from "../src/kernel/core";
import { resolveMechanism } from "../src/sim/mech/resolve";
import { runSpec } from "../src/sim/build";
import { emptyMachine } from "../src/machine/types";

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const engine = (rod = 80) => `
part crank { body cylinder(d: 50, h: 10, at: (0, -5, 0), dir: Y)  spin: 1  axis: Y }
part piston { body cylinder(d: 30, h: 20, at: (0, 0, ${20 + rod - 10}))  slides: Z }
part rod { body box(8, 6, ${rod}, at: (0, 0, 20))  links: [crank, piston]  pins: [(0, 0, 20), (0, 0, ${20 + rod})] }
`;

describe("a slider-crank", () => {
  it("strokes the piston twice the crank throw and keeps the rod's length", () => {
    const m = evaluate(engine());
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const piston = m.parts.find((p) => p.name === "piston")!;
    const rod = m.parts.find((p) => p.name === "rod")!;
    expect(piston.motion?.kind).toBe("slide");
    expect(piston.motion?.link?.name).toBe("rod");
    const l = rod.motion!.link!;
    expect(l.length).toBeCloseTo(80, 9);
    for (const deg of [0, 37, 90, 180, 250]) {
      const s = solveLink(l, deg);
      expect(s.reach).toBe(true);
      expect(dist(s.P, s.W)).toBeCloseTo(80, 6);
      // the crank pin goes round the crank's axis, the wrist pin stays on the slide's line
      expect(Math.hypot(s.P[0], s.P[2])).toBeCloseTo(20, 6);
      expect(s.W[0]).toBeCloseTo(0, 9);
      // the rod's pins move with it
      const R = motionPose(rod.motion!, deg);
      expect(dist(applyMat(R, l.p0), s.P)).toBeLessThan(1e-6);
      expect(dist(applyMat(R, l.w0), s.W)).toBeLessThan(1e-6);
      expect(dist(applyMat(motionPose(piston.motion!, deg), l.w0), s.W)).toBeLessThan(1e-6);
    }
    // bottom dead centre: down by 2 × 20 mm
    expect(solveLink(l, 180).x).toBeCloseTo(-40, 6);
    const sw = sweepLink(l);
    expect(sw.max - sw.min).toBeCloseTo(40, 3);
    expect(linkChecks(m).map((i) => `${i.status} ${i.id}`)).toEqual(["pass link:ok:rod"]);
  });

  it("fails a rod too short to go round the crank", () => {
    const m = evaluate(engine().replace("pins: [(0, 0, 20), (0, 0, 100)]", "pins: [(0, 0, 20), (0, 0, 35)]"));
    const items = linkChecks(m).map((i) => `${i.status} ${i.id}`);
    expect(items).toContain("fail link:reach:rod");
    // and its second pin is nowhere near the piston
    expect(items).toContain("warn link:pins:rod");
  });

  it("warns when a short rod pushes the piston nearly sideways", () => {
    const m = evaluate(engine(22));
    expect(linkChecks(m).map((i) => `${i.status} ${i.id}`)).toEqual(["warn link:binds:rod"]);
  });

  it("fails a part that slides with no rod to drive it", () => {
    const m = evaluate(`part piston { body cylinder(d: 30, h: 20)  slides: Z }`);
    expect(linkChecks(m).map((i) => `${i.status} ${i.id}`)).toEqual(["fail link:none:piston"]);
  });

  it("will not take spin: on a part a rod drives", () => {
    const m = evaluate(`part piston { body cylinder(d: 30, h: 20)  slides: Z  spin: 1 }`);
    expect(m.diagnostics.some((d) => /takes its motion from the rod alone/.test(d.message))).toBe(true);
  });
});

describe("a crank-rocker", () => {
  // crank 10 at the origin, rocker 35 about (40, 30), rod about 30.4: the crank turns all the way round
  const src = `
part crank { body box(14, 4, 4, at: (5, 0, 0))  spin: 1 }
part rocker { body box(4, 40, 4, at: (40, 12.5, 0))  swings: Z  axis_at: (40, 30, 0) }
part rod { body box(30, 4, 4, at: (25, -2.5, 4))  links: [crank, rocker]  pins: [(10, 0, 0), (40, -5, 0)] }
`;
  it("swings the rocker back and forth as the crank turns", () => {
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const l = m.parts.find((p) => p.name === "rod")!.motion!.link!;
    const C: V3 = [40, 30, 0];
    for (let deg = 0; deg < 360; deg += 30) {
      const s = solveLink(l, deg);
      expect(s.reach).toBe(true);
      expect(dist(s.W, s.P)).toBeCloseTo(l.length, 6);
      expect(dist(s.W, C)).toBeCloseTo(35, 6);
    }
    expect(solveLink(l, 0).x).toBeCloseTo(0, 9);
    const sw = sweepLink(l);
    expect(sw.stuck).toEqual([]);
    expect(sw.max - sw.min).toBeGreaterThan(20);
    expect(sw.max - sw.min).toBeLessThan(60);
    expect(linkChecks(m)[0].status).toBe("pass");
  });
});

describe("a slider-crank in the simulation", () => {
  it("drives the piston through its stroke as the crank turns", async () => {
    await initKernel();
    const model = evaluate(`design "Slider crank"
part base { material: "Aluminum 6061"  body box(120, 60, 10, at: (0, 0, -60)) }
part crank { material: "Steel"  body cylinder(d: 50, h: 10, at: (0, -5, 0), dir: Y)  spin: 1  axis: Y }
part piston { material: "Aluminum 6061"  body cylinder(d: 30, h: 20, at: (0, 0, 90))  slides: Z }
part rod { material: "Steel"  body box(8, 6, 80, at: (0, -12, 20))  links: [crank, piston]  pins: [(0, 0, 20), (0, 0, 100)] }
scenario "Crank it" {
  mechanism: sim.mechanism(sim.turn(crank, speed: 120rpm))
  duration: 2s
}`);
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const core = new KernelCore();
    for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    const geom = (h: string) => {
      const e = core.get(h);
      return e ? { preview: core.mesh(h, "preview"), volume: e.volume, bbox: e.bbox, rev: 0 } : undefined;
    };
    const def = model.scenarios![0];
    const r = resolveMechanism(def.spec, model, geom, true);
    if (!("mech" in r)) throw new Error(JSON.stringify(r));
    expect(r.mech.joints.map((j) => `${j.kind} ${j.name} on ${j.on}`).sort()).toEqual(["ball rod-piston pin on rod", "pivot crank on frame", "pivot rod on crank", "slider piston on frame"]);
    const v = runSpec({ ...def.spec, mech: r.mech, variants: ["expected"] }, emptyMachine(), model.name).variants[0];
    expect(v.error).toBeUndefined();
    // four crank turns in 2 s: the piston runs its full 40 mm stroke from top to bottom dead centre, eight times
    expect(v.results["crank.max_rpm"] as number).toBeGreaterThan(110);
    expect(v.results["piston.pos_max"] as number).toBeCloseTo(0, 0);
    expect(v.results["piston.pos_min"] as number).toBeCloseTo(-40, 0);
    expect(v.results["piston.travel"] as number).toBeCloseTo(320, -1);
  }, 120_000);
});
