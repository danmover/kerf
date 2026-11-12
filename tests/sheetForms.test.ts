// Sheet metal forms: hems and rolls on flanges and on the base's own edges, jogs part way up a flange, and louvres
// pressed into the base or a flange; each built bent and laid flat, and checked.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { shapeValid } from "../src/kernel/profiles";
import { sheetChecks } from "../src/core/sheetChecks";
import { processProbes } from "../src/mfg/report";
import type { Model } from "../src/core/model";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

const part = (body: string, extra = "") => `design "T"\npart p {\n  material: "Aluminum 5052"\n  body ${body}\n${extra}}\n`;
const sheetOf = (m: Model) => m.parts[0].sheet!;
const errors = (src: string) => evaluate(src).diagnostics.map((d) => d.message);
const size = (b: [number[], number[]]) => [0, 1, 2].map((k) => b[1][k] - b[0][k]);
const flatW = (m: Model) => sheetOf(m).flatBox[1][0] - sheetOf(m).flatBox[0][0];
const flatD = (m: Model) => sheetOf(m).flatBox[1][1] - sheetOf(m).flatBox[0][1];
/** the bend allowance of a bend through deg degrees at inside radius r, K-factor 0.44 */
const ba = (deg: number, r: number, t: number) => ((Math.abs(deg) * Math.PI) / 180) * (r + 0.44 * t);

function built(src: string) {
  const model = evaluate(src);
  expect(model.diagnostics.map((d) => d.message)).toEqual([]);
  const core = new KernelCore();
  const p = model.parts[0];
  const bent = core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  const flat = core.build({ hash: p.sheet!.flatHash, recipe: p.sheet!.flat, label: `${p.label} flat` });
  expect(shapeValid(bent.shape)).toBe(true);
  expect(shapeValid(flat.shape)).toBe(true);
  return { model, bent, flat };
}

describe("hems and rolls on a flange's far edge", () => {
  it("folds a closed hem inward, its fold at the flange's height, and lays it out flat", () => {
    const { model, bent, flat } = built(part('sheet(rect(100, 60), t: 1, r: 1, flanges: [flange("front", 30, hem: 8)])'));
    const s = sheetOf(model);
    expect(s.bends.map((b) => [b.name, b.angle])).toEqual([
      ["front", 90],
      ["front hem", 180],
    ]);
    // a closed hem keeps a hair (a tenth of the sheet) between its layers
    const ri = 0.05;
    expect(s.bends[1].r).toBeCloseTo(ri, 9);
    expect(s.flanges[0].hem).toEqual({ length: 8, gap: 0, flat: expect.closeTo(8 - ri - 1, 9) });
    expect(s.flanges[0].flat).toBeCloseTo(30 - ri - 1 - 2, 9);
    expect(size(bent.bbox)).toEqual([100, 60, 30].map((x) => expect.closeTo(x, 2)));
    // base short of the bend | quarter bend | wall | half-round fold | the folded-back part
    expect(flatD(model)).toBeCloseTo(58 + ba(90, 1, 1) + (30 - ri - 1 - 2) + ba(180, ri, 1) + (8 - ri - 1), 6);
    expect(size(flat.bbox)[1]).toBeCloseTo(flatD(model), 2);
    expect(size(flat.bbox)[2]).toBeCloseTo(1, 3);
    expect(Math.abs(flat.volume - bent.volume) / bent.volume).toBeLessThan(0.02);
  });

  it("opens a hem with hem_gap, folds it outward when negative, and curls a roll", () => {
    const open = built(part('sheet(rect(100, 60), t: 1.5, flanges: [flange("back", 25, hem: -9, hem_gap: 1)])'));
    // outward: the fold sticks out behind the back face by the gap and the sheet
    expect(size(open.bent.bbox)[1]).toBeCloseTo(60 + 1 + 1.5, 2);
    expect(sheetOf(open.model).bends[1]).toMatchObject({ name: "back hem", angle: -180, r: 0.5 });
    const roll = built(part('sheet(rect(100, 60), t: 1, flanges: [flange("front", 30, roll: 3)])'));
    const s = sheetOf(roll.model);
    expect(s.bends[1]).toMatchObject({ name: "front roll", angle: 270, r: 3 });
    expect(s.flanges[0].roll).toEqual({ r: 3, angle: 270 });
    expect(size(roll.bent.bbox)[2]).toBeCloseTo(30, 2);
    expect(Math.abs(roll.flat.volume - roll.bent.volume) / roll.bent.volume).toBeLessThan(0.02);
  });

  it("stops hems short of each other at a box's corners", () => {
    const { model, bent } = built(part('sheet(rect(120, 80), t: 1, flanges: [flange("all", 30, hem: 6)])'));
    const r = sheetChecks(model);
    expect(r.map((i) => [i.id, i.status])).toEqual([
      ["sheet:flange:p", "pass"],
      ["sheet:collide:p", "pass"],
      ["sheet:flat:p", "pass"],
    ]);
    expect(size(bent.bbox)).toEqual([120, 80, 30].map((x) => expect.closeTo(x, 2)));
  });

  it("says what is wrong", () => {
    const bad = (f: string) => errors(part(`sheet(rect(100, 60), t: 1, flanges: [${f}])`)).join("\n");
    expect(bad('flange("front", 30, hem: 8, lip: 5)')).toMatch(/one of lip:, hem: or roll:, not two/);
    expect(bad('flange("front", 30, hem_gap: 1)')).toMatch(/hem_gap goes with hem:/);
    expect(bad('flange("front", 30, hem: 1)')).toMatch(/hem 1 is too short to fold back: make it more than 1.05 mm/);
    expect(bad('flange("front", 30, hem: 29)')).toMatch(/hem 29 is longer than the straight part of the flange it folds onto: make it 28 mm or less/);
    expect(bad('flange("front", 30, roll: 3, roll_angle: 360)')).toMatch(/roll_angle 360° is out of range/);
  });
});

describe("hems of the base's own edges", () => {
  it("folds the edge back over the top, its fold on the edge", () => {
    const { model, bent, flat } = built(part('sheet(rect(100, 60), t: 1, flanges: [hem("front", 8)])'));
    const s = sheetOf(model);
    expect(s.flanges[0]).toMatchObject({ name: "front", kind: "hem", angle: 180, h: 8 });
    expect(s.bends.map((b) => [b.name, b.angle])).toEqual([["front hem", 180]]);
    expect(size(bent.bbox)).toEqual([100, 60, 2 * (0.05 + 1)].map((x) => expect.closeTo(x, 2)));
    expect(flatD(model)).toBeCloseTo(60 - 1.05 + ba(180, 0.05, 1) + (8 - 1.05), 6);
    expect(size(flat.bbox)[1]).toBeCloseTo(flatD(model), 2);
    expect(Math.abs(flat.volume - bent.volume) / bent.volume).toBeLessThan(0.02);
  });

  it("hems every edge, under the base too, and rolls an edge", () => {
    const all = built(part('sheet(rect(160, 100), t: 1, flanges: [hem("all", 10)])'));
    expect(sheetChecks(all.model).every((i) => i.status === "pass")).toBe(true);
    expect(flatW(all.model)).toBeCloseTo(160 - 2 * 1.05 + 2 * (ba(180, 0.05, 1) + 10 - 1.05), 6);
    const under = built(part('sheet(rect(100, 60), t: 1.2, flanges: [hem("left", 8, down: true, gap: 0.6), flange("right", 20)])'));
    expect(under.bent.bbox[0][2]).toBeCloseTo(-(0.6 + 1.2), 2);
    const rolled = built(part('sheet(rect(100, 60), t: 1, flanges: [hem("back", roll: 2.5)])'));
    expect(sheetOf(rolled.model).flanges[0]).toMatchObject({ kind: "roll", roll: { r: 2.5, angle: 270 } });
    expect(size(rolled.bent.bbox)[2]).toBeCloseTo(2 * (2.5 + 1), 2);
  });

  it("leaves no room for crossing hems, and says so", () => {
    expect(errors(part('sheet(rect(30, 20), t: 1, flanges: [hem("all", 12)])')).join("\n")).toMatch(/no room is left for its folded-back part between the corners/);
    expect(errors(part('sheet(rect(100, 60), t: 1, flanges: [hem("front", 1)])')).join("\n")).toMatch(/length 1 is too short to fold back/);
  });
});

describe("jogs", () => {
  it("steps a flange out part way up, with two bends", () => {
    const { model, bent, flat } = built(part('sheet(rect(100, 60), t: 1, r: 1, flanges: [flange("front", 40, jog: (15, 6))])'));
    const s = sheetOf(model);
    expect(s.bends.map((b) => [b.name, b.angle])).toEqual([
      ["front", 90],
      ["front jog", -90],
      ["front jog", 90],
    ]);
    expect(s.flanges[0].jog).toEqual({ at: 15, offset: 6, angle: 90, flat: expect.closeTo(6 - 1 - 2, 9) });
    // the shorter of the two straight parts: 12 below the jog, 23 above it
    expect(s.flanges[0].flat).toBeCloseTo(12, 9);
    expect(size(bent.bbox)).toEqual([100, 66, 40].map((x) => expect.closeTo(x, 2)));
    expect(flatD(model)).toBeCloseTo(58 + ba(90, 1, 1) + 12 + ba(90, 1, 1) + 3 + ba(90, 1, 1) + 23, 6);
    expect(Math.abs(flat.volume - bent.volume) / bent.volume).toBeLessThan(0.02);
  });

  it("jogs in, takes a gentler angle for a small offset, and keeps a lip", () => {
    const inward = built(part('sheet(rect(100, 60), t: 1, flanges: [flange("front", 30, jog: (12, -4)), flange("back", 30, jog: (10, 1.5), jog_angle: 30, lip: 8)])'));
    expect(size(inward.bent.bbox)[1]).toBeCloseTo(60 + 1.5, 2);
    expect(sheetOf(inward.model).bends.filter((b) => b.name.startsWith("back")).map((b) => b.name)).toEqual(["back", "back jog", "back jog", "back lip"]);
    const bad = (f: string) => errors(part(`sheet(rect(100, 60), t: 1, flanges: [${f}])`)).join("\n");
    expect(bad('flange("front", 30, jog: (12, 2))')).toMatch(/the jog's offset 2 is too small for two bends of r 1 at 90°: make it more than 3, or give a smaller jog_angle/);
    expect(bad('flange("front", 30, jog: (2, 5))')).toMatch(/the jog at 2 is too close to the bend below it/);
    expect(bad('flange("front", 30, jog: (12, 0))')).toMatch(/offset \(the second number\) can't be 0/);
    expect(bad('flange("front", 30, jog: 12)')).toMatch(/jog is \(where, offset\)/);
    expect(bad('flange("front", 30, jog: (12, 5), jog_angle: 100)')).toMatch(/jog_angle 100° is out of range/);
  });
});

describe("louvres", () => {
  const tray = (louvres: string, t = 1) => part(`sheet(rect(200, 120), t: ${t}, flanges: [flange("all", 40)], louvres: [${louvres}])`);

  it("presses a row into a tray's floor, out of the part, and keeps the blank plain", () => {
    const { model, bent, flat } = built(tray("louvre(60, 6, 3, count: 5)"));
    const s = sheetOf(model);
    expect(s.forms!.map((f) => [f.name, f.c[1]])).toEqual([
      ["base louvre 1", 20],
      ["base louvre 2", 10],
      ["base louvre 3", 0],
      ["base louvre 4", -10],
      ["base louvre 5", -20],
    ]);
    // the flanges stand up, so the louvres stand out under the floor
    expect(bent.bbox[0][2]).toBeCloseTo(-3, 2);
    expect(size(bent.bbox)).toEqual([200, 120, 43].map((x) => expect.closeTo(x, 2)));
    // 3.5 mm between neighbours (pitch width + 4t, less the hood's own width); 36.5 to the back edge less its 2 mm bend start
    expect(s.forms![0]).toMatchObject({ margin: expect.closeTo(34.5, 6), near: "the back bend", web: expect.closeTo(3.5, 6) });
    const plain = built(part('sheet(rect(200, 120), t: 1, flanges: [flange("all", 40)])'));
    expect(s.flatBox).toEqual(sheetOf(plain.model).flatBox);
    expect(flat.volume).toBeCloseTo(plain.flat.volume, 1);
    expect(sheetChecks(model).find((i) => i.id === "sheet:louvre:p")).toMatchObject({ status: "pass", title: "p's 5 louvres have room to form" });
  });

  it("presses louvres into a wall, opening downward, and in with flip", () => {
    const out = built(tray('louvre(40, 5, 2.5, on: "back", count: 3)'));
    const s = sheetOf(out.model);
    // the wall is straight from 2 (its bend) to 40: the row sits in the middle, one pitch (5 + 4) apart
    expect(s.forms!.map((f) => [f.name, f.c[1], f.c[2]])).toEqual([
      ["back louvre 1", 60, 30],
      ["back louvre 2", 60, 21],
      ["back louvre 3", 60, 12],
    ]);
    expect(size(out.bent.bbox)[1]).toBeCloseTo(122.5, 2);
    expect(s.forms![0]).toMatchObject({ margin: expect.closeTo(7, 6), near: "the top of the back flange" });
    const inward = built(tray('louvre(40, 5, 2.5, on: "back", at: (-30, 25), flip: true)'));
    expect(size(inward.bent.bbox)[1]).toBeCloseTo(120, 2);
    expect(sheetOf(inward.model).forms![0].c).toEqual([-30, 59, 25].map((x) => expect.closeTo(x, 9)));
    // a flat panel's louvre stands up out of its top; angle turns it
    const panel = built(part("sheet(rect(100, 60), t: 1.5, louvres: [louvre(40, 8, 4, angle: 90)])"));
    expect(size(panel.bent.bbox)).toEqual([100, 60, 5.5].map((x) => expect.closeTo(x, 2)));
    expect(sheetOf(panel.model).forms![0]).toMatchObject({ margin: expect.closeTo(8.5, 6), near: "the front edge" });
  });

  it("checks the room round each louvre and how deep it is", () => {
    const status = (src: string) => sheetChecks(evaluate(src)).find((i) => i.id === "sheet:louvre:p");
    expect(status(tray("louvre(60, 6, 3, at: (0, 53))"))).toMatchObject({ status: "warn", detail: expect.stringMatching(/base louvre 1 is 1.5 mm from the back bend/) });
    expect(status(tray("louvre(60, 6, 3, at: (0, 54.5))"))).toMatchObject({ status: "fail" });
    expect(status(tray("louvre(60, 6, 6)"))).toMatchObject({ status: "warn", title: "p has deep louvres" });
    expect(status(tray("louvre(60, 6, 3, count: 2, pitch: 7)"))).toMatchObject({ status: "fail", detail: expect.stringMatching(/0.5 mm from the next louvre/) });
  });

  it("says what is wrong", () => {
    const bad = (src: string) => errors(src).join("\n");
    expect(bad(tray("louvre(40, 6, 1.1)"))).toMatch(/louvre 1: height 1.1 is too low to open in a 1 mm sheet: make it at least 1.2 mm/);
    expect(bad(part("sheet(rect(200, 120), t: 1, louvres: [louvre(40, 6, 3, at: (90, 0))])"))).toMatch(/louvre 1: at \(90, 0\) it runs off the base/);
    expect(bad(tray("louvre(60, 6, 3, at: (0, 55))"))).toMatch(/louvre 1: at \(0, 55\) it runs into the back bend: move it 3.5 mm away/);
    expect(bad(tray("louvre(60, 6, 3, count: 3, pitch: 6.2)"))).toMatch(/base louvre 1 and base louvre 2 overlap/);
    expect(bad(part('sheet(rect(100, 60), t: 1, louvres: [louvre(30, 5, 2, on: "front")])'))).toMatch(/there is no flange on the front edge to press it into/);
    expect(bad(part('sheet(rect(100, 60), t: 1, flanges: [hem("front", 8)], louvres: [louvre(30, 5, 2, on: "front")])'))).toMatch(/the front edge has a hem\(\), not a flange/);
    expect(bad(part('sheet(rect(100, 60), t: 1, flanges: [flange("front", 40, jog: (15, 6))], louvres: [louvre(30, 4, 2, on: "front", at: (0, 16))])'))).toMatch(/at height 16 it is not on a straight part of the front flange, which is straight from 2 to 14 and \d+(\.\d+)? to 40/);
    expect(bad(part("sheet(rect(100, 60), t: 1, louvres: [louvre(30, 5, 2, count: 2.5)])"))).toMatch(/count is how many side by side/);
  });
});

describe("hems in the sheet checks", () => {
  it("counts a hem's folded-back part as a strip to bend, and leaves a roll out", () => {
    const r = sheetChecks(evaluate(part('sheet(rect(100, 60), t: 1, flanges: [hem("front", 3), hem("back", roll: 2)])')));
    expect(r.find((i) => i.id === "sheet:flange:p")).toMatchObject({ status: "warn", detail: expect.stringMatching(/^the front hem is 3 mm:/) });
  });
});

describe("the process checks on a sheet's forms", () => {
  const box = (material: string) => `design "T"\npart p {\n  material: "${material}"\n  body sheet(rect(200, 120), t: 1.2, r: 1.2, flanges: [flange("front", 40, hem: 8), flange("back", 40, roll: 3), flange("left", 40), flange("right", 40)], louvres: [louvre(60, 6, 3, count: 3), louvre(40, 5, 2.5, on: "back", count: 2)])\n}\n`;
  const findings = (src: string) => {
    const model = evaluate(src);
    expect(model.diagnostics.map((d) => d.message)).toEqual([]);
    const p = model.parts[0];
    const core = new KernelCore();
    core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    return core.process(processProbes(model, new Set([p.hash])))[0].findings;
  };

  it("judges hems and louvres as the forms they are, not as tight bends and odd walls", () => {
    const f = findings(box("Aluminum 5052"));
    expect(f.filter((x) => x.status === "fail").map((x) => x.title)).toEqual([]);
    expect(f.find((x) => x.rule === "sheet-uniform")).toMatchObject({ status: "pass", title: "One 1.2 mm sheet" });
    expect(f.find((x) => x.rule === "bend-radius")).toMatchObject({ status: "pass" });
    expect(f.find((x) => x.rule === "hem")).toMatchObject({ status: "pass", title: "1 hem", detail: expect.stringMatching(/^1 hem folded back flat: Aluminum 5052 takes a closed hem/) });
    expect(f.find((x) => x.rule === "louvre")).toMatchObject({ status: "pass", title: "5 louvres" });
  });

  it("warns of a closed hem in an alloy that cracks along it", () => {
    const hem = findings(box("Aluminum 6061")).find((x) => x.rule === "hem")!;
    expect(hem).toMatchObject({ status: "warn", title: "A closed hem in Aluminum 6061" });
    expect(hem.fix).toMatch(/hem_gap: \(at least 1.2 mm\)/);
  });
});
