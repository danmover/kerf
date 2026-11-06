// The bench's own marks, checked against the untouched templates with the real
// kernel: a mark for what was asked must fail before Claude has done anything
// (or the case would pass for free), and a "keep" mark must already hold.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { buildChecksRequest } from "../src/core/checks";
import type { GeoQuery } from "../src/lang/values";
import { BENCH, CORE } from "../src/bench/cases";
import { grade, overall, type BenchView } from "../src/bench/grade";
import { benchMarkdown, benchTotals } from "../src/bench/report";
import { COMPARE, type BenchRun } from "../src/bench/run";
import { templateById } from "../src/demos/templates";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

const built = new Map<string, { core: KernelCore; hashes: Set<string> }>();

/** The kernel's answers for a source, building its parts once. */
function measurer(src: string) {
  return async (queries: GeoQuery[]) => {
    const model = evaluate(src);
    let b = built.get(src);
    if (!b) {
      b = { core: new KernelCore(), hashes: new Set() };
      for (const p of model.parts) {
        if (b.hashes.has(p.hash)) continue;
        b.core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "preview");
        b.hashes.add(p.hash);
      }
      built.set(src, b);
    }
    return b.core.checks({ ...buildChecksRequest(model, b.hashes), queries });
  };
}

const view = (src: string, over: Partial<BenchView> = {}): BenchView => ({
  startSource: src,
  source: src,
  model: evaluate(src),
  startFailing: new Set(),
  failing: [],
  buildErrors: 0,
  reply: "",
  measure: measurer(src),
  ...over,
});

describe("the bench cases", () => {
  it("has 24 asks with unique ids, 12 of them in the core run, on templates that exist", () => {
    expect(BENCH).toHaveLength(24);
    expect(CORE).toHaveLength(12);
    expect(new Set(BENCH.map((c) => c.id)).size).toBe(24);
    for (const c of BENCH) expect(templateById(c.template), c.template).toBeTruthy();
    for (const kind of ["small", "part", "assembly", "question"]) expect(CORE.some((c) => c.kind === kind)).toBe(true);
  });

  for (const c of BENCH.filter((c) => c.template !== "blank")) {
    it(`${c.id}: what was asked fails on the untouched ${c.template}, and what must stay holds`, async () => {
      const src = templateById(c.template)!.source;
      const marks = await grade(c, view(src));
      const own = marks.slice(c.kind === "question" ? 1 : 3);
      expect(own).toHaveLength(c.expect.length);
      c.expect.forEach((e, i) => {
        expect(own[i].detail, e.label).not.toMatch(/could not|unknown|not defined|expected/i);
        expect(own[i].ok, `${e.label}: ${own[i].detail}`).toBe(!!e.keep);
      });
    }, 120_000);
  }
});

describe("marking", () => {
  const src = readFileSync("src/demos/bracket.kerf", "utf8");

  it("passes a change that does what was asked and fails one that breaks a check", async () => {
    const c = BENCH.find((x) => x.id === "plate-8mm")!;
    const after = src.replace(/param thickness = 5mm/, "param thickness = 8mm");
    expect(after).not.toBe(src);
    const good = await grade(c, view(after, { startSource: src }));
    expect(good.every((m) => m.ok), JSON.stringify(good)).toBe(true);

    const broken = await grade(c, view(after, { startSource: src, failing: [{ id: "req:x", title: "Shaft fits" }] }));
    expect(broken.find((m) => m.label === "No checks fail")).toMatchObject({ ok: false, detail: "Shaft fits" });
  }, 120_000);

  it("fails a question that changed the design, and reads the reply", async () => {
    const c = BENCH.find((x) => x.id === "bushing-question")!;
    const ok = await grade(c, view(src, { reply: "It is PETG and weighs about 1.7 g." }));
    expect(ok.map((m) => m.ok)).toEqual([true, true]);
    const changed = await grade(c, view(src.replace("8mm", "9mm"), { startSource: src, reply: "It weighs 2 grams." }));
    expect(changed[0]).toMatchObject({ label: "Leaves the design as it was", ok: false });
  });

  it("measures the whole design's largest extent", () => {
    expect(overall({ a: [[0, 0, 0], [10, 20, 5]], b: [[-5, 0, 0], [0, 4, 40]] })).toBe(40);
    expect(overall({})).toBeNull();
  });

  it("writes a report a person can read, with the run as JSON", () => {
    const run: BenchRun = {
      started: Date.UTC(2026, 10, 4, 23, 30),
      finished: Date.UTC(2026, 10, 4, 23, 50),
      model: "claude-opus-5-5",
      effort: "high",
      speed: "normal",
      cases: [
        { id: "walls-3mm", title: "Enclosure walls to 3 mm", kind: "small", message: "Make the walls 3 mm thick.", passed: true, marks: [{ label: "Walls are 3 mm", ok: true, detail: "3 = 3" }], seconds: 42, cost: 0.31, requests: 4, outputTokens: 3000, models: ["claude-opus-5-5"], asks: { pass: 2, fail: 0, open: 0, error: 0 }, reviews: 0, questions: 0, reply: "Done." },
        { id: "lid-vents", title: "Vent slots in the lid", kind: "small", message: "Add a row of ventilation slots to the lid.", passed: false, marks: [{ label: "The lid has openings", ok: false, detail: "14456 < 14400" }], seconds: 80, cost: 0.6, requests: 7, outputTokens: 9000, models: ["claude-opus-5-5"], asks: { pass: 1, fail: 1, open: 0, error: 0 }, reviews: 1, questions: 0, reply: "Added." },
      ],
    };
    expect(benchTotals(run)).toMatchObject({ cases: 2, passed: 1, marks: 2, marksOk: 1, requests: 11 });
    const md = benchMarkdown(run);
    expect(md).toContain("1 of 2 asks passed every mark");
    expect(md).toContain("| ✗ Vent slots in the lid | small | 80 s | $0.600 | 7 | 1/2 | The lid has openings (14456 < 14400) |");
    expect(JSON.parse(md.split("```json\n")[1].split("\n```")[0]).cases).toHaveLength(2);
  });
  it("compares set-ups side by side: each one's totals, then every ask under each", () => {
    const one = (id: string, setup: string, passed: boolean, seconds: number, cost: number) => ({ id, title: id === "walls-3mm" ? "Enclosure walls to 3 mm" : "Vent slots in the lid", kind: "small" as const, message: "", passed, marks: [{ label: "Measured", ok: passed, detail: passed ? "3 = 3" : "2 != 3" }], seconds, cost, requests: 3, outputTokens: 2000, models: [], asks: { pass: 1, fail: 0, open: 0, error: 0 }, reviews: 0, questions: 0, reply: "", setup });
    const run: BenchRun = {
      started: Date.UTC(2026, 10, 6, 3, 0),
      model: "claude-opus-5-5",
      effort: "high",
      speed: "normal",
      setups: COMPARE,
      cases: [one("walls-3mm", "opus", true, 40, 0.3), one("walls-3mm", "opus-lean", true, 30, 0.25), one("walls-3mm", "sonnet", false, 20, 0.1), one("lid-vents", "opus", true, 60, 0.5)],
    };
    expect(benchTotals(run, "opus")).toMatchObject({ cases: 2, passed: 2 });
    expect(benchTotals(run, "sonnet")).toMatchObject({ cases: 1, passed: 0 });
    const md = benchMarkdown(run);
    expect(md).toContain("3 of 4 runs passed every mark");
    expect(md).toContain("| Opus 5.5, slimmer prompt | 1 of 1 | 1 of 1 | 30 s | $0.250 | 3 |");
    expect(md).toContain("| Ask | Opus 5.5 | Opus 5.5, slimmer prompt | Sonnet 5.5 |");
    expect(md).toContain("| Enclosure walls to 3 mm | ✓ 40 s, $0.300 | ✓ 30 s, $0.250 | ✗ 20 s, $0.100 |");
    expect(md).toContain("| Vent slots in the lid | ✓ 60 s, $0.500 | not run | not run |");
    expect(md).toContain("| ✗ Enclosure walls to 3 mm | Sonnet 5.5 | small | 20 s | $0.100 | 3 | 1/1 | Measured (2 != 3) |");
  });
});
