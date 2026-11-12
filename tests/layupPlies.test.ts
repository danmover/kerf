// A carbon layup's ply schedule on its process, mfg.carbon_layup(plies: [...]): it makes the wall and the weight, the
// ply book in the process checks, and every analysis of the part lays its shells up with it.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { structuralInput } from "../src/analysis/runtime";
import type { StructuralSpec } from "../src/analysis/spec";
import { resolveRules, sanitizeSettings, specToSource } from "../src/mfg/profiles";
import type { Model } from "../src/core/model";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

const tube = (process: string, analysis = "") => `design "t"
part tube {
  material: "Carbon fiber"
  process: ${process}
  body cylinder(d: 40, h: 400)
}
${analysis}`;
const bend = (extra = "") => `analysis "Bend" {
  parts: [tube]
  fix: face(tube, -Z)
  load: force(face(tube, +Z), (100, 0, 0))
${extra}}
`;
const SCHEDULE = 'mfg.carbon_layup(pull: Y, plies: [plies("0", "carbon woven"), plies("[0/±45/90]s"), plies("[0/90]", zone: zone(at: (0, 0, 0), r: 40), name: "root")])';
const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

function prepare(m: Model) {
  const spec = m.analyses.find((a) => a.kind === "structural") as StructuralSpec;
  const parts = m.parts.filter((p) => spec.parts.includes(p.name));
  const core = new KernelCore();
  for (const p of parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  return structuralInput(spec, parts, false, new Map(), (h) => core.mesh(h, "preview"));
}

describe("a carbon layup's ply schedule", { timeout: 120_000 }, () => {
  it("makes the wall, its weight and the ply book", () => {
    const m = evaluate(tube(SCHEDULE));
    expect(errors(m)).toEqual([]);
    const p = m.parts[0];
    const rules = resolveRules(p.process!, p.material);
    const rho = (0.22 * 1.5 + 0.96 * 1.55) / 1.18;
    expect(rules.layup).toMatchObject({ wall: expect.closeTo(1.18, 9), density: expect.closeTo(rho, 9) });
    expect(rules.layup!.plies).toMatchObject({
      count: 9,
      arealMass: expect.closeTo(1818, 6),
      lines: ["1: 0° 3K twill carbon cloth, 0.22 mm", "2–9: [0/±45/90]s T700-class carbon UD, 8 × 0.12 mm"],
      zones: ["2 plies [0/90] of T700-class carbon UD (0.24 mm) over the root"],
    });
    // the process checks list the ply book and weigh the stack over the tube's surface
    const core = new KernelCore();
    core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    const f = core.process([{ id: p.id, hash: p.hash, rules }])[0].findings.find((x) => x.rule === "layup")!;
    const area = Math.PI * 40 * 400 + 2 * Math.PI * 20 * 20;
    expect(f.value).toBeCloseTo((area * 1.818) / 1000, -1);
    expect(f.title).toBe(`Laminate about ${Math.round(f.value!)} g, 9 plies`);
    expect(f.detail).toMatch(/^Ply book, from the outer surface in: 1: 0° 3K twill carbon cloth, 0.22 mm; 2–9: \[0\/±45\/90\]s T700-class carbon UD, 8 × 0.12 mm; then, inside the stack where they lie, 2 plies \[0\/90\] of T700-class carbon UD \(0.24 mm\) over the root\. The 1.18 mm stack weighs 1818 g\/m²/);
  });

  it("writes itself back, and keeps its plies from a stored file", () => {
    const p = evaluate(tube(SCHEDULE)).parts[0];
    const src = specToSource(p.process!);
    expect(src).toBe('mfg.carbon_layup(pull: Y, plies: [plies("[0]", "carbon woven"), plies("[0/±45/90]s", "carbon"), plies("[0/90]", "carbon", zone: zone(at: (0, 0, 0), r: 40), name: "root")])');
    expect(evaluate(tube(src)).parts[0].process!.settings).toEqual(p.process!.settings);
    const stored = sanitizeSettings("carbon_layup", JSON.parse(JSON.stringify(p.process!.settings)));
    expect(stored.plies).toEqual(p.process!.settings.plies);
    expect(sanitizeSettings("carbon_layup", { plies: [{ angles: "0/90" }, { angles: [0], material: "cheese" }] }).plies).toBeUndefined();
  });

  it("lays the part's shells up with it, unless the analysis gives its own plies", () => {
    const own = prepare(evaluate(tube(SCHEDULE, bend())));
    const sh = own!.input!.parts[0].shell!;
    expect(sh).toMatchObject({ kind: "laminate", t: expect.closeTo(1.18, 9) });
    expect(sh.plies!.plies).toHaveLength(9);
    expect(sh.plies!.patches).toMatchObject([{ label: "root", plies: [{ angle: 0 }, { angle: 90 }] }]);
    expect(sh.plies!.label).toBe("[0] of 3K twill carbon cloth, then [0/±45/90]s of T700-class carbon UD");
    const study = prepare(evaluate(tube(SCHEDULE, bend('  layup: plies("[0/90]s")\n'))));
    expect(study!.input!.parts[0].shell!.plies!.plies.map((q) => q.angle)).toEqual([0, 90, 90, 0]);
    // without plies the layup is the even laminate it always was
    const even = prepare(evaluate(tube("mfg.carbon_layup(pull: Y, wall: 1.1)", bend())));
    expect(even!.input!.parts[0].shell).toEqual({ kind: "laminate", t: 1.1 });
  });

  it("says what is wrong", () => {
    const msgs = (process: string) => evaluate(tube(process)).diagnostics.map((d) => d.message).join("\n");
    expect(msgs('mfg.carbon_layup(plies: "[0/90]s")')).toMatch(/plies: is the ply schedule, plies\("\[0\/±45\/90\]s"\) or a list of them laid from the outer surface in/);
    expect(msgs('mfg.carbon_layup(plies: plies("[0/90]", zone: zone(at: (0, 0, 0), r: 10)))')).toMatch(/plies: has only zones' plies/);
    expect(msgs('mfg.carbon_layup(wall: 1.2, plies: plies("[0/90]s"))')).toMatch(/wall: 1.2 is not used: its plies make a 0.48 mm wall. Leave wall: out./);
    expect(msgs('mfg.carbon_layup(wall: 0.48, plies: plies("[0/90]s"))')).toBe("");
  });
});
