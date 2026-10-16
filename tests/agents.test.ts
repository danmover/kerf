import { describe, expect, it } from "vitest";
import { composeSections, definedNames, formatFooter, formatHeader, INTEGRATION, LAYOUT, mergeByRegion, newSection, ownerAt, splitSections, withMeta } from "../src/agents/sections";
import { checkPlan, sectionOrder, waves } from "../src/agents/plan";
import { addUsage, costOf, emptyTally, estimateRun, fmtUsd } from "../src/agents/pricing";
import { sectionReport } from "../src/agents/subagent";
import { evaluate } from "../src/lang/evaluator";

const LAYOUT_SRC = `design "Fan"
param d = 120mm
interface mount { screw = M3, spacing = 31 }
`;

const meta = (id: string, after: string[] = []) => ({ id, name: id.replace(/_/g, " "), brief: `Build the ${id} subassembly with care.`, after, uses: [] });

function doc() {
  return composeSections({
    head: LAYOUT_SRC + "\n",
    sections: [newSection(meta("base"), `part base_plate {\n  group: "Base"\n  body box(d, d, 4)\n}\n`), newSection(meta("guard", ["base"]), `part guard_ring {\n  group: "Guard"\n  body cylinder(d: d, h: 3, at: (0, 0, 40))\n}\n`)],
    tail: `\nrequire "Plate is thin": d > 10\n`,
  });
}

describe("subassembly sections", () => {
  it("splits and recomposes a design exactly", () => {
    const src = doc();
    const r = splitSections(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.sections.map((s) => s.id)).toEqual(["base", "guard"]);
    expect(r.doc.sections[1].after).toEqual(["base"]);
    expect(r.doc.sections[0].brief).toBe("Build the base subassembly with care.");
    expect(r.doc.head).toBe(LAYOUT_SRC + "\n");
    expect(r.doc.tail).toContain("require");
    expect(composeSections(r.doc)).toBe(src);
  });

  it("keeps the design valid: the markers are comments", () => {
    const m = evaluate(doc());
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.map((p) => p.name).sort()).toEqual(["base_plate", "guard_ring"]);
  });

  it("treats a design without markers as all layout", () => {
    const r = splitSections(LAYOUT_SRC);
    expect(r.ok && r.doc.sections.length === 0 && r.doc.head === LAYOUT_SRC && r.doc.tail === "").toBe(true);
  });

  it("reports broken markers with a line number", () => {
    const missingEnd = LAYOUT_SRC + formatHeader(meta("base")) + "let a = 1\n";
    const r1 = splitSections(missingEnd);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/no end marker/);
    const crossed = LAYOUT_SRC + formatHeader(meta("a")) + formatFooter("b");
    expect(splitSections(crossed).ok).toBe(false);
    const twice = LAYOUT_SRC + formatHeader(meta("a")) + formatFooter("a") + formatHeader(meta("a")) + formatFooter("a");
    expect(splitSections(twice).ok).toBe(false);
  });

  it("finds which region an offset belongs to", () => {
    const src = doc();
    const r = splitSections(src);
    if (!r.ok) throw new Error(r.error);
    expect(ownerAt(r.doc, src.indexOf("param d"))).toBe(LAYOUT);
    expect(ownerAt(r.doc, src.indexOf("part guard_ring"))).toBe("guard");
    expect(ownerAt(r.doc, src.indexOf("require"))).toBe(INTEGRATION);
  });

  it("rewrites a header only when its metadata changes", () => {
    const r = splitSections(doc().replace("// ┌─ subassembly base · base ", "// ┌─ subassembly base · base   "));
    if (!r.ok) throw new Error(r.error);
    const s = r.doc.sections[0];
    expect(withMeta(s, { id: s.id, name: s.name, brief: s.brief, after: s.after, uses: s.uses })).toBe(s);
    expect(withMeta(s, { id: s.id, name: "Base frame", brief: s.brief, after: [], uses: ["mount"] }).header).toContain("Base frame");
  });

  it("lists the names a section defines", () => {
    expect(definedNames(`let a = 1\npart p { body box(1, 1, 1) }\nrequire "x": a > 0\n`)).toEqual(["a", "p"]);
  });

  it("merges by region: someone's edits win where they changed something", () => {
    const base = splitSections(doc());
    if (!base.ok) throw new Error();
    // the run then changed the guard; meanwhile the user edited the layout and the base
    const ours = { ...base.doc, sections: base.doc.sections.map((s) => (s.id === "guard" ? { ...s, body: s.body.replace("h: 3", "h: 5") } : s)) };
    const theirs = doc().replace("param d = 120mm", "param d = 140mm").replace("box(d, d, 4)", "box(d, d, 6)");
    const m = mergeByRegion(base.doc, ours, theirs);
    expect(m).not.toBeNull();
    const out = composeSections(m!.doc);
    expect(out).toContain("param d = 140mm");
    expect(out).toContain("box(d, d, 6)");
    expect(out).toContain("h: 5");
    expect(m!.kept.sort()).toEqual([LAYOUT, "base"].sort());
  });

  it("gives up on merging when someone broke the markers", () => {
    const base = splitSections(doc());
    if (!base.ok) throw new Error();
    expect(mergeByRegion(base.doc, base.doc, doc().replace(/\/\/ └─ end base.*\n/, ""))).toBeNull();
  });
});

describe("parallel plans", () => {
  it("accepts a sound plan and groups it into waves", () => {
    const subs = [meta("frame"), meta("drive"), meta("housing", ["drive"]), meta("cover", ["housing", "frame"])];
    expect(checkPlan(subs).errors).toEqual([]);
    expect(waves(subs)).toEqual([["frame", "drive"], ["housing"], ["cover"]]);
  });

  it("rejects loops, unknown dependencies and bad ids", () => {
    expect(checkPlan([meta("a", ["b"]), meta("b", ["a"])]).errors.join()).toMatch(/loop/);
    expect(checkPlan([meta("a", ["zzz"])]).errors.join()).toMatch(/not in the plan/);
    expect(checkPlan([{ ...meta("a"), id: "Bad-Id" }]).errors.join()).toMatch(/valid id/);
    expect(checkPlan([meta("a"), meta("a")]).errors.join()).toMatch(/twice/);
  });

  it("allows depending on a section already in the design", () => {
    expect(checkPlan([meta("cover", ["housing"])], ["housing"]).errors).toEqual([]);
    expect(waves([meta("cover", ["housing"])])).toEqual([["cover"]]);
  });

  it("orders sections so dependencies come first, keeping the current order where it works", () => {
    const deps = new Map([
      ["housing", ["drive"]],
      ["drive", []],
      ["frame", []],
    ]);
    expect(sectionOrder(["housing", "frame"], deps)).toEqual(["frame", "drive", "housing"]);
    expect(sectionOrder(["frame", "drive", "housing"], deps)).toEqual(["frame", "drive", "housing"]);
  });
});

describe("costs", () => {
  it("prices usage per model, including cache reads and writes", () => {
    const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    expect(costOf("claude-opus-5-5", u)).toBeCloseTo(4 + 20 + 5 + 0.2);
    expect(costOf("claude-sonnet-5-5", u)).toBeCloseTo(2 + 10 + 2.5 + 0.2);
    expect(costOf("claude-haiku-5-5", { input_tokens: 1000, output_tokens: 1000 })).toBeCloseTo((1000 * 0.1 + 1000 * 0.5) / 1e6);
  });

  it("adds up a tally", () => {
    const t = addUsage(addUsage(emptyTally(), "claude-opus-5-5", { input_tokens: 10, output_tokens: 20 }), "claude-opus-5-5", { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 100 });
    expect(t.requests).toBe(2);
    expect(t.input).toBe(15);
    expect(t.cacheRead).toBe(100);
    expect(t.cost).toBeGreaterThan(0);
  });

  it("estimates a range that grows with agents, effort and model", () => {
    const base = { model: "claude-opus-5-5", effort: "high" as const, systemTokens: 14000, contextTokens: [3000, 3000] };
    const e = estimateRun(base);
    expect(e.low).toBeGreaterThan(0);
    expect(e.high).toBeGreaterThan(e.low);
    expect(estimateRun({ ...base, contextTokens: [3000, 3000, 3000, 3000] }).high).toBeGreaterThan(e.high);
    expect(estimateRun({ ...base, effort: "low" }).high).toBeLessThan(e.high);
    expect(estimateRun({ ...base, model: "claude-haiku-5-5" }).high).toBeLessThan(e.high / 10);
  });

  it("formats dollars", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.004)).toBe("<$0.01");
    expect(fmtUsd(1.234)).toBe("$1.23");
    expect(fmtUsd(12.34)).toBe("$12.3");
  });
});

describe("an agent's view of its checks", () => {
  it("reports only what involves its own section and flags name collisions", () => {
    const src = doc();
    const r = splitSections(src);
    if (!r.ok) throw new Error();
    const guard = r.doc.sections[1];
    const model = evaluate(src);
    const items = [
      { id: "a", category: "requirement" as const, status: "fail" as const, title: "Guard clears blade", detail: "-1 mm", parts: [model.parts.find((p) => p.name === "guard_ring")!.id], basis: "geometry" as const },
      { id: "b", category: "requirement" as const, status: "fail" as const, title: "Base is flat", detail: "x", parts: [model.parts.find((p) => p.name === "base_plate")!.id], basis: "geometry" as const },
    ];
    const out = sectionReport(src, model, items, guard.bodyStart, guard.bodyEnd, new Map([["guard_ring", "subassembly base"]]));
    expect(out.text).toContain("Guard clears blade");
    expect(out.text).toContain("1 problem(s) outside your section");
    expect(out.text).toMatch(/collisions/);
    expect(out.counts.fail).toBe(2);
  });
});
