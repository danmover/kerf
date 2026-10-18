// compare_designs: alternatives built, checked, measured and analysed next to
// the current design without changing it, then applied by label. The shelf
// bracket template is built with the real kernel and solved with the real
// finite-element code, in Node; nothing here touches the network.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import type { PartResult } from "../src/kernel/client";
import { assembleReport, buildChecksRequest } from "../src/core/checks";
import { composeReport } from "../src/core/reportPasses";
import type { Model } from "../src/core/model";
import { runStructural } from "../src/analysis/fe/structural";
import { compareDesigns, alternativeSource, type CompareDeps } from "../src/ai/compare";
import { runTool } from "../src/ai/tools";
import { useDesign } from "../src/core/engine";
import { initKernel } from "./helpers/kernel";

const SHELF = readFileSync("src/demos/shelf.kerf", "utf8");

/** The pool worker's job, done in this process. */
async function measure(src: string, inspect: (m: Model) => string[]) {
  const model = evaluate(src);
  const core = new KernelCore();
  const parts = new Map<string, PartResult>();
  const buildErrors = new Map<string, string>();
  for (const p of model.parts) {
    if (parts.has(p.hash) || buildErrors.has(p.hash)) continue;
    try {
      const e = core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "preview");
      parts.set(p.hash, { hash: p.hash, quality: "preview", mesh: core.mesh(p.hash, "preview"), volume: e.volume, bbox: e.bbox, ms: 0 });
    } catch (e) {
      buildErrors.set(p.hash, String(e));
    }
  }
  const kernel = core.checks(buildChecksRequest(model, new Set(parts.keys())));
  const report = composeReport(assembleReport(model, { geoModel: null, kernel, buildErrors }), { model, live: false, rev: 0, buildErrors, process: null });
  return { model, report, worker: 1, built: parts.size, ms: 0, parts, inspections: core.inspect(inspect(model)) };
}

const deps = (source = SHELF, locked: string[] = []): CompareDeps => ({
  current: async () => ({ source, model: evaluate(source), report: null }),
  measure,
  solve: async (input) => runStructural(input),
  locked: () => locked,
});

describe("compare_designs on the shelf bracket", () => {
  beforeAll(() => initKernel(), 60_000);

  it("measures and analyses each alternative next to the current design, and edit_design applies one", async () => {
    const out = await compareDesigns(
      {
        alternatives: [
          { label: "Thinner plate", idea: "Less material in the plate and arm", set: { t: 6 } },
          { label: "Thick gusset", idea: "Stiffer gusset", set: { gusset_t: 9 } },
          { label: "Broken", edits: [{ old_text: "no such text", new_text: "x" }] },
        ],
      },
      deps(),
    );
    const text = String(out.content);
    expect(out.isError).toBeFalsy();
    expect(text).toContain("Measured: bracket.");
    expect(text).toContain("Current design\n  Checks:");
    // mass, size and printability of the changed part, with the change against the current design
    expect(text).toMatch(/"Thinner plate": Less material in the plate and arm\n {2}Checks: .*\n {2}bracket: [\d.]+ g PETG \(−[\d.]+ g, −\d+ %\), [\d.]+ × [\d.]+ × [\d.]+ mm, thinnest wall [\d.]+ mm/);
    expect(text).toMatch(/"Thick gusset".*\n.*\n {2}bracket: [\d.]+ g PETG \(\+[\d.]+ g/);
    // the analysis of each, against the current one
    expect(text).toMatch(/"Shelf load": (pass|warn|fail), safety [\d.]+ \(target 2\.5, current [\d.]+\), peak [\d.]+ MPa, deflection [\d.]+ mm \(current [\d.]+\)/);
    expect(text).toContain('"Broken"\n  Not measured: its edits could not be applied');
    expect(text).toContain('edit_design with alternative: "<label>"');
    expect(out.card.detail).toMatch(/^Thinner plate: [\d.]+ g safety [\d.]+/);

    // the thinner plate is weaker and the thicker gusset no weaker than now
    const sf = (label: string) => Number(new RegExp(`"${label}"[\\s\\S]*?"Shelf load": \\w+, safety ([\\d.]+)`).exec(text)![1]);
    const now = Number(/Current design[\s\S]*?"Shelf load": \w+, safety ([\d.]+)/.exec(text)![1]);
    expect(sf("Thinner plate")).toBeLessThan(now);
    expect(sf("Thick gusset")).toBeGreaterThanOrEqual(now * 0.95);

    // applied by label, as measured
    useDesign.setState({ source: SHELF, model: evaluate(SHELF) });
    const applied = await runTool("edit_design", { summary: "Thinner plate and arm", alternative: "thinner plate" });
    expect(applied.isError).toBeFalsy();
    expect(useDesign.getState().source).toMatch(/param t += 6mm/);
    // the design changed, so the old comparison no longer applies
    expect(alternativeSource("Thick gusset", useDesign.getState().source).error).toMatch(/changed since compare_designs/);
  }, 240_000);
});

describe("compare_designs input", () => {
  it("refuses alternatives that touch what the user locked, or name no parameter", async () => {
    const fake: CompareDeps = {
      ...deps(SHELF, ["arm_len"]),
      measure: async () => {
        throw new Error("nothing should be built");
      },
    };
    const out = await compareDesigns({ alternatives: [{ label: "Longer", set: { arm_len: 200 } }, { label: "Nope", set: { no_param: 1 } }] }, fake);
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain('"Longer"\n  Not measured: it changes what the user locked or stated (arm_len)');
    expect(String(out.content)).toContain('"Nope"\n  Not measured: there is no parameter named no_param');
  });

  it("needs distinct labels, and edits or an alternative for edit_design", async () => {
    const out = await compareDesigns({ alternatives: [{ label: "A", set: { t: 6 } }, { label: "a", set: { t: 7 } }] }, deps());
    expect(out.isError).toBe(true);
    const both = await runTool("edit_design", { summary: "x", alternative: "A", edits: [{ old_text: "a", new_text: "b" }] });
    expect(String(both.content)).toContain("give either edits or alternative");
  });
});
