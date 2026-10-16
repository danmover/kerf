import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { chooseOption, decisionName, decisionStatus, partsAffectedBy, recordCurrent, removeDecision, setDecisionValue, upsertDecision, withValues, kerfString } from "../src/core/decisions";

const SRC = `design "box"
param width = 90mm "Outer width"
param wall = 2.0mm
param corner_r = 6mm
part shell_part { body box(width, 40, 20, r: corner_r) }

decision narrower "Narrower enclosure" {
  ask: "The board can't fit. Which do you want?"
  chose: "Narrowest"
  by: "you"
  why: "Keeps the gaps."
  option "Narrowest" { width: 77mm, corner_r: 5mm }
    "Width 90 to 77 mm."
  option "Tighter" { width: 76mm, wall: 1.6mm } "Thinner walls."
  option "Ask the board maker" "Change the board instead."
}
`;

describe("decisions in the design language", () => {
  it("parses a decision with its fields and options", () => {
    const m = evaluate(SRC);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const d = m.decisions[0];
    expect(d).toMatchObject({ name: "narrower", title: "Narrower enclosure", chose: "Narrowest", by: "you", why: "Keeps the gaps." });
    expect(d.options.map((o) => o.label)).toEqual(["Narrowest", "Tighter", "Ask the board maker"]);
    expect(d.options[0].note).toBe("Width 90 to 77 mm.");
    expect(d.options[0].sets.map((s) => [s.param, s.value])).toEqual([
      ["width", 77],
      ["corner_r", 5],
    ]);
    expect(d.options[2].sets).toEqual([]);
  });

  it("does not change the geometry or the dependency graph", () => {
    const without = evaluate(SRC.slice(0, SRC.indexOf("decision")));
    const m = evaluate(SRC);
    expect(m.parts.map((p) => p.hash)).toEqual(without.parts.map((p) => p.hash));
    expect(m.graph.edges).toEqual(without.graph.edges);
  });

  it("warns about an unknown parameter or a choice that is not an option", () => {
    const m = evaluate(`design "x"\nparam a = 1\ndecision d "D" {\n  chose: "Nope"\n  option "One" { b: 2 }\n}`);
    const msgs = m.diagnostics.map((d) => d.message).join("\n");
    expect(msgs).toMatch(/"b", which is not a parameter/);
    expect(msgs).toMatch(/not one of its options/);
  });

  it("reports how a decision stands against the parameters", () => {
    const m = evaluate(SRC);
    const st = decisionStatus(m.decisions[0], m);
    expect(st.chosen?.label).toBe("Narrowest");
    expect(st.drift.map((x) => [x.param, x.recorded, x.current])).toEqual([
      ["width", 77, 90],
      ["corner_r", 5, 6],
    ]);
    const applied = evaluate(withValues(SRC, m, { width: 77, corner_r: 5 }));
    const st2 = decisionStatus(applied.decisions[0], applied);
    expect(st2.drift).toEqual([]);
    expect(st2.matching?.label).toBe("Narrowest");
  });

  it("finds the parts a decision shapes", () => {
    const m = evaluate(SRC);
    expect(partsAffectedBy(m, ["width"])).toEqual(["shell_part"]);
    expect(partsAffectedBy(m, ["wall"])).toEqual([]);
  });
});

describe("editing decisions", () => {
  it("switches to another option, writing its values and keeping units", () => {
    const m = evaluate(SRC);
    const out = chooseOption(SRC, m, "narrower", "Tighter");
    expect(out).toContain("param width = 76mm");
    expect(out).toContain("param wall = 1.6mm");
    expect(out).toContain('chose: "Tighter"');
    expect(out).not.toContain("why:");
    const m2 = evaluate(out);
    expect(m2.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(decisionStatus(m2.decisions[0], m2).drift).toEqual([]);
  });

  it("records values the user adjusted on the chosen option", () => {
    const m = evaluate(SRC);
    const out = chooseOption(SRC, m, "narrower", "Narrowest", { values: { width: 77.5 } });
    const m2 = evaluate(out);
    expect(m2.params.find((p) => p.name === "width")?.value).toBe(77.5);
    expect(m2.decisions[0].options[0].sets[0].value).toBe(77.5);
    expect(out).toContain("why:");
  });

  it("fine-tunes one value of the chosen option", () => {
    const m = evaluate(chooseOption(SRC, evaluate(SRC), "narrower", "Narrowest"));
    const src = chooseOption(SRC, evaluate(SRC), "narrower", "Narrowest");
    const out = setDecisionValue(src, m, "narrower", "corner_r", 4.5);
    const m2 = evaluate(out);
    expect(m2.params.find((p) => p.name === "corner_r")?.value).toBe(4.5);
    expect(decisionStatus(m2.decisions[0], m2).drift).toEqual([]);
  });

  it("records the current values after a manual change", () => {
    const src = chooseOption(SRC, evaluate(SRC), "narrower", "Narrowest");
    const tweaked = withValues(src, evaluate(src), { width: 78 });
    const m = evaluate(tweaked);
    expect(decisionStatus(m.decisions[0], m).drift).toHaveLength(1);
    const out = recordCurrent(tweaked, m, "narrower");
    const m2 = evaluate(out);
    expect(decisionStatus(m2.decisions[0], m2).drift).toEqual([]);
  });

  it("adds a decision under a Decisions section, then after the last one", () => {
    const base = `design "x"\nparam a = 10mm\n`;
    const r1 = upsertDecision(base, evaluate(base), { title: "Lid fastening", chose: "Screws", by: "claude", why: "Re-openable.", options: [{ label: "Screws", note: "Four M3." }, { label: "Snap fit" }] });
    expect(r1.name).toBe("lid_fastening");
    expect(r1.src).toContain("// ── Decisions");
    const r2 = upsertDecision(r1.src, evaluate(r1.src), { title: "Size", chose: "Big", options: [{ label: "Big", set: { a: 20 } }, { label: "Small", set: { a: 5 } }] });
    const m = evaluate(r2.src);
    expect(m.diagnostics).toEqual([]);
    expect(m.decisions.map((d) => d.name)).toEqual(["lid_fastening", "size"]);
    expect(m.decisions[1].options[0].sets[0]).toMatchObject({ param: "a", value: 20 });
    expect(r2.src).toContain("option \"Big\" { a: 20mm }");
    // replacing keeps one block
    const r3 = upsertDecision(r2.src, m, { name: "size", title: "Size", chose: "Small", options: [{ label: "Small", set: { a: 5 } }] });
    expect(evaluate(r3.src).decisions.map((d) => d.chose)).toEqual(["Screws", "Small"]);
  });

  it("makes unique names that are never keywords", () => {
    const m = evaluate(`design "x"\nparam width = 1\n`);
    expect(decisionName("Width", m)).toBe("width_2");
    expect(decisionName("Design", m)).toBe("design_choice");
    expect(decisionName("3 mm walls?", m)).toBe("decision_3_mm_walls");
  });

  it("round-trips quotes and line breaks in text", () => {
    const text = 'He said "fine"\nthen left \\ ok';
    const m = evaluate(`design "x"\ndecision d "D" {\n  why: ${kerfString(text)}\n}`);
    expect(m.decisions[0].why).toBe(text);
  });

  it("removes a decision block", () => {
    const m = evaluate(SRC);
    const out = removeDecision(SRC, m, "narrower");
    expect(evaluate(out).decisions).toEqual([]);
    expect(out).toContain("part shell_part");
  });
});
