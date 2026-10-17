// Timing belts (lib.belt): the path round the pulleys, what tension does, the
// checks, and the belts on the 3D printer template.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { beltChecks, insertTension, spanHz, tensionForHz } from "../src/machine/belts";
import { machineChecks } from "../src/machine/checks";
import { cutList, testPlan } from "../src/machine/pack";
import { buildPart, solidVolume } from "../src/kernel/build";
import type { BeltDef } from "../src/machine/types";
import { loadOC } from "./occt";

const PD = 12.732; // GT2 20-tooth pitch diameter (40 mm / π)

// a motor pulley and a toothed idler on axes along Y, with their belt grooves on the plane y = 11.5
const RIG = `
component m = lib.stepper("nema17_17hs4401") { at: (0, -6, 0), axis: Y, role: "x" }
component p = lib.pulley("gt2_pulley_20t_5mm") { at: (0, 0, 0), axis: Y }
`;
const idler = (name: string, x: number, z = 0) => `component ${name} = lib.pulley("gt2_idler_20t_5mm") { at: (${x}, 6.5, ${z}), axis: Y }\n`;

const run = (src: string) => {
  const model = evaluate(RIG + src);
  const errs = model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  return { model, errs, belts: model.machine?.belts ?? [] };
};
const belt = (src: string): BeltDef => {
  const r = run(src);
  expect(r.errs).toEqual([]);
  return r.belts[0];
};

describe("belt path", () => {
  it("runs a loop round two equal pulleys: twice the centre distance plus one pitch circumference", () => {
    const b = belt(idler("i", 150) + `component loop = lib.belt("gt2_6mm_loop", path: [p, i], tension: 15N, torque: 0.3Nm)`);
    expect(b.open).toBe(false);
    expect(b.length).toBeCloseTo(300 + Math.PI * PD, 1);
    for (const nd of b.nodes) expect(nd.wrap).toBeCloseTo(180, 3);
    expect(b.nodes[0].teethInMesh).toBeCloseTo(10, 3);
    expect(b.spans.map((s) => s.length)).toEqual([expect.closeTo(150, 3), expect.closeTo(150, 3)]);
    // 340 mm of path: the nearest stock loop is 350 mm (175 teeth), too long to tension
    expect(b.stockLength).toBe(350);
    expect(b.teeth).toBe(175);
    expect(beltChecks(b).find((c) => c.id.startsWith("belt:stock"))?.status).toBe("fail");
    expect(b.drive).toBe("p");
    expect(b.motor?.name).toBe("m");
  });

  it("clamps an open belt at both ends and works out the cut length", () => {
    const b = belt(idler("i", 400) + `component x_belt = lib.belt("gt2_6mm", path: [(180, 11.5, ${PD / 2}), p, i, (230, 11.5, ${PD / 2})], tension: 15N, mass: 600, accel: 3000, friction: 5N) { role: "x" }`);
    expect(b.open).toBe(true);
    // 180 mm to p, half round p, 400 mm along the bottom, half round i, 170 mm back to the second clamp
    expect(b.length).toBeCloseTo(180 + 400 + 170 + Math.PI * PD, 1);
    // stretch taken off and 20 mm per clamp added, rounded up to 10 mm
    expect(b.cutLength).toBe(Math.ceil((b.length / (1 + 15 / 15000) + 40) / 10) * 10);
    expect(b.figures.lenA).toBeCloseTo(180, 1);
    // carriage stiffness: both sides of the belt from the clamps to the drive pulley in parallel
    const ea = 15000;
    expect(b.figures.kShown).toBeCloseTo(ea / b.figures.lenA! + ea / b.figures.lenB!, 3);
    expect(b.figures.kMin).toBeCloseTo((4 * ea) / (b.figures.lenA! + b.figures.lenB!), 3);
    // worst case at the end of travel: the short side takes all the pull
    const pull = 0.6 * 3 + 5;
    expect(b.figures.tight).toBeCloseTo(15 + pull, 3);
    expect(b.figures.slack).toBeCloseTo(15 - pull, 3);
    for (const c of beltChecks(b)) expect(c.status, `${c.title}: ${c.detail}`).not.toBe("fail");
  });

  it("runs the belt's back round an outside idler, turning the other way", () => {
    const b = belt(idler("i", 200) + idler("t", 100, -10) + `component loop = lib.belt("gt2_6mm_loop", path: [p, t, i], outside: [t], tension: 15N)`);
    const t = b.nodes.find((n) => n.name === "t")!;
    const p = b.nodes.find((n) => n.name === "p")!;
    expect(t.outside).toBe(true);
    expect(t.dir).toBe(-p.dir);
    expect(t.wrap).toBeGreaterThan(2);
    // pushed into the loop, the belt is longer than the straight loop
    expect(b.length).toBeGreaterThan(400 + Math.PI * PD);
  });

  it("explains a belt that cannot be laid out", () => {
    expect(run(idler("i", 150) + `component b = lib.belt("gt2_6mm", path: [p, i])`).errs.join(" ")).toMatch(/endless|loop|clamp/i);
    expect(run(idler("i", 150) + `component b = lib.belt("gt2_6mm_loop", path: [(0, 11.5, 10), p, i, (50, 11.5, 10)])`).errs.join(" ")).toMatch(/loop|metre/i);
    expect(run(idler("i", 8) + `component b = lib.belt("gt2_6mm_loop", path: [p, i])`).errs.join(" ")).toMatch(/overlap/i);
    expect(run(idler("i", 150) + `component b = lib.belt("gt2_6mm_loop", path: [p, i], tension: 900N)`).errs.join(" ")).toMatch(/tension/i);
    expect(run(idler("i", 150) + `component b = lib.belt("gt2_6mm_loop", path: [p, i]) { at: (0, 0, 0) }`).errs.join(" ")).toMatch(/path/i);
  });
});

describe("belt tension", () => {
  it("gives the pluck note of a free span, and back", () => {
    // f = (1 / 2L) √(T / μ): 15 N on 400 mm of 8.4 g/m belt
    expect(spanHz(15, 400, 0.0084)).toBeCloseTo((1 / 0.8) * Math.sqrt(15 / 0.0084), 6);
    expect(tensionForHz(spanHz(15, 400, 0.0084), 400, 0.0084)).toBeCloseTo(15, 6);
  });

  it("warns about a loose or over-tight belt, a slack side and motor bearing load", () => {
    const at = (t: number, accel = 3000) => belt(idler("i", 400) + `component x_belt = lib.belt("gt2_6mm", path: [(180, 11.5, ${PD / 2}), p, i, (230, 11.5, ${PD / 2})], tension: ${t}N, mass: 600, accel: ${accel}, friction: 5N)`);
    const st = (b: BeltDef, id: string) => beltChecks(b).find((c) => c.id.startsWith(id))?.status;
    expect(st(at(15), "belt:tension")).toBe("pass");
    expect(st(at(5), "belt:tension")).toBe("warn");
    expect(st(at(30), "belt:tension")).toBe("warn");
    expect(st(at(30), "belt:hub")).toBe("warn");
    expect(st(at(40), "belt:hub")).toBe("fail");
    expect(st(at(8, 20000), "belt:slack")).toBe("fail");
  });

  it("adds tension: to a belt that has none", () => {
    const src = RIG + idler("i", 150) + `component loop = lib.belt("gt2_6mm_loop", path: [p, i])\n`;
    const b = evaluate(src).machine!.belts[0];
    expect(b.tensionAssumed).toBe(true);
    const next = insertTension(src, b, 12)!;
    expect(next).toContain(`lib.belt("gt2_6mm_loop", path: [p, i], tension: 12N)`);
    expect(evaluate(next).machine!.belts[0].tension).toBe(12);
  });
});

describe("belt solid", () => {
  beforeAll(loadOC, 60_000);

  it("builds a plain band for previews and the GT2 tooth profile for the detailed build", () => {
    const model = run(idler("i", 150) + `component loop = lib.belt("gt2_6mm_loop", path: [p, i], tension: 15N)`).model;
    const part = model.parts.find((q) => q.name === "loop")!;
    const fast = solidVolume(buildPart(part.recipe));
    const detail = solidVolume(buildPart(part.recipe, { detail: true }));
    // land to back (0.63 mm) × 6 mm × ~340 mm, then the teeth on the free spans add to it
    expect(fast).toBeGreaterThan(0.6 * 6 * 330);
    expect(fast).toBeLessThan(0.7 * 6 * 345);
    expect(detail).toBeGreaterThan(fast * 1.2);
  }, 60_000);
});

describe("printer belts", () => {
  const PRINTER = readFileSync(join(__dirname, "../src/demos/printer.kerf"), "utf8");
  const model = evaluate(PRINTER);
  const m = model.machine!;

  it("has real X and Y belts driven by their motors, and every belt check passes", () => {
    expect(m.belts.map((b) => [b.name, b.role, b.drive, b.motor?.name])).toEqual([
      ["belt_y", "y", "y_pulley", "y_motor"],
      ["belt_x", "x", "x_pulley", "x_motor"],
    ]);
    const belt = machineChecks(m).filter((c) => c.id.startsWith("belt:"));
    expect(belt.length).toBeGreaterThan(10);
    for (const c of belt) expect(c.status, `${c.title}: ${c.detail}`).toBe("pass");
    // a bed slinger's Y axis rings far lower than its light X axis
    const [y, x] = m.belts;
    expect(y.figures.ringMin!).toBeLessThan(x.figures.ringMin!);
    expect(x.figures.ringMin!).toBeGreaterThan(40);
  });

  it("puts a tension test for each belt in the test plan, and the belt in the cut list", () => {
    const plan = testPlan(m);
    for (const t of ["X belt tension", "Y belt tension"]) {
      const item = plan.find((p) => p.title === t)!;
      expect(item.required).toBe(true);
      expect(item.pass).toMatch(/\d+ Hz for 15 N/);
    }
    const cut = cutList(model).find((g) => g.part.kind === "belt")!;
    expect(cut.cuts.map((c) => c.comps[0]).sort()).toEqual(["belt_x", "belt_y"]);
    expect(cut.note).toMatch(/2 m/);
  });

  it("follows the tension parameter", () => {
    const tight = evaluate(PRINTER.replace(/param x_tension = 15N/, "param x_tension = 22N")).machine!.belts.find((b) => b.name === "belt_x")!;
    const x = m.belts.find((b) => b.name === "belt_x")!;
    expect(x.tensionParam).toBe("x_tension");
    expect(tight.tension).toBe(22);
    expect(tight.spans[1].hz / x.spans[1].hz).toBeCloseTo(Math.sqrt(22 / 15), 3);
  });
});
