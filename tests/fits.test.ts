import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { findFits, findFitsWork } from "../src/analysis/fits/detect";
import { fitsKept, fitWorkLeft, forgetFits, rememberFits, simulateFits, type FitLearned, type FitReport } from "../src/analysis/fits/simulate";
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
  // every test builds its fits itself: nothing is answered from an earlier test's run
  beforeEach(() => forgetFits());

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
    forgetFits();
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

  it("does not let washers set where a pattern of screws goes", () => {
    const src = `
part foot {
  material: "PETG"
  process: mfg.fdm()
  body box(80, 20, 10, at: (0, 0, 5))
  cut hole(M4, depth: 8, at: (-30, 0, 0), dir: Z, fit: "insert")
  cut hole(M4, depth: 8, at: (30, 0, 0), dir: Z, fit: "insert")
}
part board {
  material: "Wood"
  body box(120, 60, 12, at: (0, 0, -6))
  cut cylinder(d: 5.5, h: 14, at: (-30, 0, -13), dir: Z)
  cut cylinder(d: 5.5, h: 14, at: (30, 0, -13), dir: Z)
}
component inserts = lib.insert(M4) { at: [(-30, 0, 0), (30, 0, 0)], axis: Z }
component washers = lib.washer(M4) { at: [(-30, 0, -12), (30, 0, -12)], axis: -Z }
component screws = lib.screw(M4, 20) { at: [(-30, 0, -12.8), (30, 0, -12.8)], axis: Z }
`;
    const { report } = run(src);
    // a washer is loose until its screw is tight: it is not judged as a part the screws have to line up with
    expect(report.outcomes.filter((o) => o.status !== "pass").map((o) => `${o.title}: ${o.detail}`)).toEqual([]);
    expect(report.outcomes.filter((o) => o.kind === "screw-pattern" && /washers/.test(o.title))).toEqual([]);
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

// After an edit only the fits it changed are built again; the rest are answered from the run before. An answer that
// was kept has to be the one a fresh run gives, to the last digit.
describe("fit answers kept from earlier runs", () => {
  beforeEach(() => forgetFits());

  /** the report as text, without how long it took */
  const text = (r: FitReport) => JSON.stringify(r, (k, v) => (k === "ms" ? 0 : v));
  /** a run answered from what `before` left, against the same run made from nothing */
  const afterAndFresh = (before: string, src: string) => {
    forgetFits();
    run(before);
    const after = run(src).report;
    forgetFits();
    return { after: text(after), fresh: text(run(src).report) };
  };
  const left = (src: string) => {
    const model = evaluate(src);
    const work = fitWorkLeft(findFits(model), model);
    for (;;) {
      const step = work.next();
      if (step.done) return step.value;
    }
  };

  it("answers a design it has seen without building anything, with the same report", () => {
    for (const name of ["reducer", "enclosure", "sand-tunneller"]) {
      const src = demo(name);
      expect(left(src), name).toBeGreaterThan(0);
      const first = text(run(src).report);
      expect(left(src), name).toBe(0);
      expect(text(run(src).report), name).toBe(first);
    }
  });

  it("gives what a fresh run gives after each kind of edit", () => {
    const reducer = demo("reducer");
    const edits: [string, string, string][] = [
      ["a hole drawn bigger", pinIn(5.2), pinIn(5.25)],
      ["a slicer setting", pinIn(5.2), pinIn(5.2).replace("mfg.fdm()", "mfg.fdm(hole_comp: 0.05)")],
      ["another plastic", pinIn(5.2), pinIn(5.2).replace('"PETG"', '"ABS"')],
      ["a pin moved along with its hole", pinIn(5.2), pinIn(5.2).replaceAll("(0, 0, ", "(4, 3, ")],
      ["a hole drawn off its pin's line", pinIn(5.2), pinIn(5.2).replace("at: (0, 0, -1)", "at: (0.05, 0, -1)")],
      ["a size called on a drawing", pinIn(5.2), pinIn(5.2, `drawing d {\n  of: block\n  diameter((0, 0, 5), 5.2, view: "top", tol: (0.05, 0.02))\n}\n`)],
      ["a part that does not touch a fit", pinIn(5.2), pinIn(5.2, `part other {\n  material: "PETG"\n  body box(5, 5, 5, at: (40, 0, 0))\n}\n`)],
      ["the brief's temperatures", reducer, reducer.replace("temp: 10C .. 40C assumed", "temp: 0C .. 60C")],
      ["a bearing seat drawn looser", reducer, reducer.replace("let seat_allow = 0.1 ", "let seat_allow = 0.2 ")],
      ["gears with less backlash", reducer, reducer.replace(", backlash: 0.12)", ")")],
    ];
    for (const [what, before, src] of edits) {
      expect(src, what).not.toBe(before);
      const { after, fresh } = afterAndFresh(before, src);
      expect(after, what).toBe(fresh);
    }
  });

  it("builds only what an edit changed", () => {
    const src = demo("enclosure");
    run(src);
    // a new part that touches nothing: every fit is as it was
    expect(left(src + `\npart spare {\n  material: "PETG"\n  body box(5, 5, 5, at: (400, 0, 0))\n}\n`)).toBe(0);
    // one pin's hole: that fit and no other
    forgetFits();
    run(pinIn(5.2, `component pin2 = lib.dowel(d: 4, length: 16) { at: (40, 0, 0), axis: Z }\npart block2 {\n  material: "PETG"\n  process: mfg.fdm()\n  body box(20, 20, 10, at: (40, 0, 5))\n  cut cylinder(d: 4.2, h: 12, at: (40, 0, -1), dir: Z)\n}\n`));
    const one = left(pinIn(5.3, `component pin2 = lib.dowel(d: 4, length: 16) { at: (40, 0, 0), axis: Z }\npart block2 {\n  material: "PETG"\n  process: mfg.fdm()\n  body box(20, 20, 10, at: (40, 0, 5))\n  cut cylinder(d: 4.2, h: 12, at: (40, 0, -1), dir: Z)\n}\n`));
    expect(one).toBe(1);
  });

  it("puts a kept fit where the design now has it", () => {
    run(pinIn(5.2));
    const moved = run(pinIn(5.2).replaceAll("(0, 0, ", "(4, 3, ")).report.outcomes[0];
    expect(moved.at[0].slice(0, 2)).toEqual([4, 3]);
  });

  it("takes in answers worked out elsewhere", () => {
    const src = demo("reducer");
    const model = evaluate(src);
    const learned: FitLearned[] = [];
    const first = simulateFits(findFits(model), model, { learned });
    expect(learned).toHaveLength(first.outcomes.length);
    forgetFits();
    expect(fitsKept()).toBe(0);
    expect(left(src)).toBeGreaterThan(0);
    // as the page does with what the fit worker sends back
    rememberFits(JSON.parse(JSON.stringify(learned)) as FitLearned[]);
    expect(left(src)).toBe(0);
    expect(text(run(src).report)).toBe(text(first));
  });

  it("reads a design's fits once for two callers working at the same time", () => {
    const model = evaluate(demo("printer"));
    const a = findFitsWork(model);
    const b = findFitsWork(model);
    let ra, rb;
    let steps = 0;
    while (!ra || !rb) {
      if (!ra) {
        const s = a.next();
        if (s.done) ra = s.value;
      }
      if (!rb) {
        const s = b.next();
        if (s.done) rb = s.value;
      }
      if (++steps > 1e6) throw new Error("never finished");
    }
    expect(ra).toBe(rb);
    expect(findFits(model)).toBe(ra);
  });
});
