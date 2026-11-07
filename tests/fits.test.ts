import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { findFits } from "../src/analysis/fits/detect";
import { simulateFits } from "../src/analysis/fits/simulate";
import { fitItems } from "../src/analysis/fits/report";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");

const run = (src: string) => {
  const model = evaluate(src);
  expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return { model, report: simulateFits(findFits(model), model) };
};

/** A printed block with a hole, and a bought dowel in it. */
const pinIn = (hole: number, extra = "") => `
part block {
  material: "PETG"
  process: mfg.fdm()
  body box(20, 20, 10)
  cut cylinder(d: ${hole}, h: 12, at: (0, 0, -1), dir: Z)
}
component pin = lib.dowel(d: 5, length: 16) { at: (0, 0, 0), axis: Z }
${extra}`;

describe("real-world fit", () => {
  it("finds the bearing seats, shafts, gear bores and meshes in the reducer", () => {
    const found = findFits(evaluate(demo("reducer")));
    const kinds = found.fits.map((f) => f.kind);
    expect(kinds.filter((k) => k === "bearing-seat")).toHaveLength(4);
    expect(kinds.filter((k) => k === "bearing-shaft").length).toBeGreaterThanOrEqual(4);
    expect(kinds).toContain("gear-bore");
    expect(kinds).toContain("locating");
    expect(found.gears.map((g) => g.title)).toEqual(["g1 → g2", "g3 → g4"]);
  });

  it("passes every fit in the templates", () => {
    for (const name of ["reducer", "printer", "sand-tunneller", "practice-amp", "enclosure", "shelf"]) {
      const { report } = run(demo(name));
      expect(report.outcomes.filter((o) => o.status !== "pass").map((o) => `${name}: ${o.title}: ${o.detail}`)).toEqual([]);
    }
  });

  it("cracks a printed hole drawn at the pin's size and passes one drawn to allow for the plastic", () => {
    const tight = run(pinIn(5)).report.outcomes[0];
    expect(tight.kind).toBe("pin");
    expect(tight.status).toBe("fail");
    expect(tight.modes[0].mode).toBe("cracks");
    // the fix names a bigger hole, and drawing it there works
    const d = Number(/at Ø([\d.]+) mm/.exec(tight.fix ?? "")?.[1]);
    expect(d).toBeGreaterThan(5.1);
    expect(run(pinIn(d)).report.outcomes[0].status).toBe("pass");
  });

  it("is repeatable", () => {
    const a = run(demo("reducer")).report;
    const b = run(demo("reducer")).report;
    expect(a.outcomes.map((o) => o.made)).toEqual(b.outcomes.map((o) => o.made));
  });

  it("jams gears whose backlash the fits eat up", () => {
    const src = demo("reducer").replace(", backlash: 0.12)", ")").replace(", backlash: 0.12)", ")");
    const mesh = run(src).report.outcomes.find((o) => o.kind === "gear-mesh" && o.title.includes("g1"))!;
    expect(mesh.status).not.toBe("pass");
    expect(mesh.modes[0].mode).toBe("binds");
    expect(mesh.fix).toMatch(/backlash/);
  });

  it("judges fits at the brief's temperatures", () => {
    // a printed seat expands away from its steel bearing when hot
    const src = demo("reducer").replace("let seat_allow = 0.1 ", "let seat_allow = 0.2 ");
    const hot = run(src.replace("temp: 10C .. 40C assumed", "temp: 0C .. 60C")).report;
    const seat = hot.outcomes.find((o) => o.kind === "bearing-seat")!;
    expect(hot.temps).toEqual([0, 60]);
    expect(seat.modes.some((m) => m.mode === "loose" && m.temp === 60)).toBe(true);
  });

  it("holds a size the drawing calls instead of the process's usual spread", () => {
    const base = `
part shaft {
  material: "Steel"
  process: mfg.cnc_lathe(axis: Z)
  body cylinder(d: 8, h: 20, at: (0, 0, -5), dir: Z)
}
part hub {
  material: "Aluminum 6061"
  process: mfg.cnc_mill()
  body box(30, 30, 8)
  cut cylinder(d: 8, h: 10, at: (0, 0, -1), dir: Z)
}`;
    const plain = run(base).report.outcomes[0];
    const called = run(base + `\ndrawing shaft_dwg {\n  of: shaft\n  diameter((0, 0, 5), 8, view: "front", fit: "p6")\n}\n`).report.outcomes[0];
    // p6 on 8 mm is +0.015 to +0.024: a press fit
    expect(called.made.p50).toBeLessThan(plain.made.p50 - 0.01);
    expect(called.shaft!.mean).toBeCloseTo(8.0195, 3);
  });

  it("holds a copy made with shape_of() to its original's drawing", () => {
    const src = `
part shaft {
  material: "Steel"
  process: mfg.cnc_lathe(axis: Z)
  body cylinder(d: 8, h: 20, at: (10, 0, -5), dir: Z)
}
part shaft_2 {
  material: "Steel"
  process: mfg.cnc_lathe(axis: Z)
  body rotate(shape_of(shaft), 180)
}
part hub {
  material: "Aluminum 6061"
  process: mfg.cnc_mill()
  body box(40, 20, 8)
  cut cylinder(d: 8, h: 10, at: (10, 0, -1), dir: Z)
  cut cylinder(d: 8, h: 10, at: (-10, 0, -1), dir: Z)
}
drawing shaft_dwg {
  of: shaft
  diameter((10, 0, 5), 8, view: "front", fit: "p6")
}
`;
    const shafts = run(src).report.outcomes.filter((o) => o.shaft);
    expect(shafts).toHaveLength(2);
    // p6 on 8 mm is +0.015 to +0.024, for the copy too
    for (const o of shafts) expect(o.shaft!.mean).toBeCloseTo(8.0195, 3);
  });

  it("leaves rubber seals and boots out", () => {
    const found = findFits(evaluate(demo("sand-tunneller")));
    expect(found.fits.some((f) => f.instances.some((i) => i.hole.part.name.startsWith("seal") || i.shaft.part.name.startsWith("seal") || i.hole.part.name === "boot"))).toBe(false);
  });

  it("adds a summary and the gear meshes to the report", () => {
    const model = evaluate(demo("reducer"));
    const items = fitItems([], { model });
    expect(items.map((i) => i.id)).toContain("fit:summary");
    expect(items.filter((i) => i.title.startsWith("Gear mesh"))).toHaveLength(2);
    expect(items.every((i) => i.category === "fit")).toBe(true);
    expect(items.find((i) => i.id === "fit:summary")!.status).toBe("pass");
  });
});
