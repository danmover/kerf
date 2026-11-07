// Design studies: the vary: block, the surrogate the optimiser steers by, and
// the optimiser on a cantilever plate whose lightest passing size is known.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { StructuralSpec, StudySpec } from "../src/analysis/spec";
import { fitSurrogate, runStudy, spreadPoints, studyAnalyses, type StudyDeps } from "../src/analysis/study";
import { parseGoal, parseLimit } from "../src/analysis/studyLang";
import type { StructuralResult } from "../src/analysis/fe/structural";
import type { MeasuredResult } from "../src/agents/isolated";
import type { Model } from "../src/core/model";

const design = (study: string, extra = "") => `design "plate"
param t = 5mm range 2 .. 12 "Plate thickness"
param w = 40mm range 20 .. 60 "Plate width"
param holes = 2 range 0 .. 6
param tag = "A"
${extra}
part plate { body box(80, w, t) }
analysis "Tip load" {
  parts: [plate]
  fix: face(plate, -X)
  load: force(face(plate, +X), (0, 0, -50N))
  safety: 2
}
analysis "Lightest" {
${study}
}
`;

function studyOf(src: string): StudySpec {
  const m = evaluate(src);
  const errs = m.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return m.analyses.find((a): a is StudySpec => a.kind === "study")!;
}

function studyError(src: string): string {
  const m = evaluate(src);
  return m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ");
}

describe("design study blocks", () => {
  it("reads parameters by name with their ranges, a goal, limits and a run budget", () => {
    const s = studyOf(design(`vary: [t, w(25mm, 50mm), holes]\n  goal: "min mass"\n  keep: ["deflection <= 0.4mm", "mass <= 120g"]\n  runs: 16`));
    expect(s.vary).toEqual([
      { name: "t", min: 2, max: 12 },
      { name: "w", min: 25, max: 50 },
      { name: "holes", min: 0, max: 6, step: 1 },
    ]);
    expect(s.goal).toMatchObject({ sense: "min", what: "mass" });
    expect(s.limits).toEqual([
      { what: "deflection", op: "<=", value: 0.4, text: "deflection <= 0.4mm" },
      { what: "mass", op: "<=", value: 120, text: "mass <= 120g" },
    ]);
    expect(s.runs).toBe(16);
  });

  it("defaults to the lightest design within a dozen runs", () => {
    const s = studyOf(design("vary: [t]"));
    expect(s.goal.text).toBe("min mass");
    expect(s.runs).toBe(12);
  });

  it("reads goals and limits in words", () => {
    expect(parseGoal("max safety of Tip load")).toMatchObject({ sense: "max", what: "safety", of: "Tip load" });
    expect(parseGoal("stiffest")).toMatchObject({ sense: "min", what: "deflection" });
    expect(parseGoal("minimise temperature")).toMatchObject({ sense: "min", what: "temperature" });
    expect(typeof parseGoal("fastest")).toBe("string");
    expect(parseLimit("frequency >= 80Hz")).toMatchObject({ what: "frequency", op: ">=", value: 80 });
    expect(parseLimit("mass ≤ 0.2kg")).toMatchObject({ what: "mass", op: "<=", value: 200 });
    expect(parseLimit("safety of Tip load >= 2.5")).toMatchObject({ what: "safety", of: "Tip load", value: 2.5 });
    expect(typeof parseLimit("mass <= 3 bananas")).toBe("string");
  });

  it("explains set-ups it cannot run", () => {
    expect(studyError(design("vary: [length]"))).toMatch(/not a parameter/);
    expect(studyError(design("vary: [tag]"))).toMatch(/varies numbers/);
    expect(studyError(design("vary: [t2]", "param t2 = 3mm"))).toMatch(/no range/);
    expect(studyError(design("vary: [t]\n  fix: face(plate, -X)"))).toMatch(/does not belong in a design study/);
    expect(studyError(design("vary: [t, t]"))).toMatch(/twice/);
    expect(studyError(design('vary: [t]\n  goal: "fastest"'))).toMatch(/not a goal/);
  });

  it("solves the analyses the parameters reach", () => {
    const m = evaluate(design("vary: [t]"));
    const s = m.analyses.find((a): a is StudySpec => a.kind === "study")!;
    expect(studyAnalyses(s, m).map((a) => a.label)).toEqual(["Tip load"]);
  });
});

describe("the surrogate", () => {
  it("passes through the designs it was fitted to and follows a smooth trend between them", () => {
    const f = (x: number[]) => (x[0] - 0.3) ** 2 + 0.5 * x[1];
    const X = spreadPoints(2, 9, () => 0.5);
    const fit = fitSurrogate(X, X.map(f))!;
    for (const x of X) expect(fit(x)).toBeCloseTo(f(x), 6);
    expect(Math.abs(fit([0.3, 0.25]) - f([0.3, 0.25]))).toBeLessThan(0.05);
  });
});

/** A plate cantilevered 80 mm, 50 N at its tip: safety ∝ w·t² (bending), mass ∝ w·t; a bolt check needs w ≥ 30. */
function fakeDeps(calls: { measure: number; analyse: number; full: number }): StudyDeps {
  const params = (m: Model) => Object.fromEntries(m.params.map((p) => [p.name, p.value as number]));
  return {
    parallel: 2,
    measure: async (src) => {
      calls.measure++;
      const model = evaluate(src);
      const v = params(model);
      const plate = model.parts.find((p) => p.name === "plate")!;
      return {
        model,
        report: { items: [{ id: "bolt", title: "Bolt fits across the plate", status: v.w >= 30 ? "pass" : "fail", detail: "" }], counts: {}, ms: 0 },
        worker: 1,
        built: 1,
        ms: 0,
        parts: new Map([[plate.hash, { hash: plate.hash, quality: "preview", mesh: null, volume: 80 * v.w * v.t, bbox: [[0, 0, 0], [80, v.w, v.t]], ms: 0 }]]),
        inspections: {},
      } as unknown as MeasuredResult;
    },
    analyse: async (spec: StructuralSpec, model: Model, _built, draft) => {
      calls.analyse++;
      if (!draft) calls.full++;
      const v = params(model);
      const safety = 0.003 * v.w * v.t * v.t;
      return {
        minSafety: { value: safety, at: [0, 0, 0], mode: "yield", allowable: 0, material: "PLA", nearBoundary: false, away: null },
        maxStress: { value: 60 / safety, at: [0, 0, 0], nearBoundary: false, away: null },
        maxDisp: { value: 2 / (v.w * v.t ** 3), at: [80, 0, 0] },
        materials: [],
        solve: { residual: 0, converged: true, iterations: 1 },
        supports: [],
        warnings: [],
      } as unknown as StructuralResult;
    },
  };
}

describe("the optimiser", () => {
  it("finds the lightest plate that is strong enough and keeps the checks passing", async () => {
    const src = design("vary: [t, w]\n  runs: 16");
    const model = evaluate(src);
    const spec = model.analyses.find((a): a is StudySpec => a.kind === "study")!;
    const calls = { measure: 0, analyse: 0, full: 0 };
    const r = await runStudy(spec, src, model, fakeDeps(calls));
    expect(r.runs.length).toBeLessThanOrEqual(16);
    expect(r.runs[0].current).toBe(true);
    expect(r.runs[0].feasible).toBe(true);
    const best = r.runs[r.best!];
    // the lightest passing plate: w·t² ≥ 2/0.003 with w ≥ 30, so t = √(666.7/30) = 4.71 mm and w·t = 141 (the design now is 200)
    expect(best.values.w).toBeGreaterThanOrEqual(30);
    expect(0.003 * best.values.w * best.values.t ** 2).toBeGreaterThanOrEqual(2);
    // within 6 % of the lightest possible, 141.4 / 200 of the mass now
    expect(best.mass! / r.runs[0].mass!).toBeLessThan((141.4 / 200) * 1.06);
    expect(best.goal).toBe(best.mass);
    // too narrow for the bolt, or too weak: never picked
    for (const x of r.runs.filter((x) => x.values.w < 30)) expect(x.feasible).toBe(false);
    for (const x of r.runs.filter((x) => 0.003 * x.values.w * x.values.t ** 2 < 2)) expect(x.feasible).toBe(false);
    // what matters: both, the thickness more for its range
    expect(r.sensitivity.map((s) => s.name).sort()).toEqual(["t", "w"]);
    // the best is solved again at full resolution
    expect(r.confirmed?.feasible).toBe(true);
    expect(calls.full).toBe(1);
    expect(calls.measure).toBe(r.runs.length);
  });

  it("snaps a count to whole numbers and stops when asked", async () => {
    const src = design("vary: [holes]\n  runs: 6");
    const model = evaluate(src);
    const spec = model.analyses.find((a): a is StudySpec => a.kind === "study")!;
    const r = await runStudy(spec, src, model, fakeDeps({ measure: 0, analyse: 0, full: 0 }));
    for (const x of r.runs) expect(Number.isInteger(x.values.holes)).toBe(true);
    const stop = new AbortController();
    stop.abort();
    const s = await runStudy(spec, src, model, fakeDeps({ measure: 0, analyse: 0, full: 0 }), stop.signal);
    expect(s.runs.length).toBe(1);
    expect(s.stopped).toBe(true);
  });
});
