import { describe, expect, it } from "vitest";
import { applyTextEdits, diffStats, lineDiff, minimalChange, setParamValue, toggleParamLock } from "../src/core/sourceEdit";
import { evaluate } from "../src/lang/evaluator";

const SRC = `design "t"\nparam width = 90mm range 40 .. 200 "Outer width"\nparam n = 4\n`;

describe("source edits", () => {
  it("applies exact unique replacements in order", () => {
    const r = applyTextEdits(SRC, [{ old_text: "param n = 4", new_text: "param n = 6" }]);
    expect(r.errors).toEqual([]);
    expect(r.src).toContain("param n = 6");
  });

  it("rejects an edit whose text is missing or ambiguous, changing nothing", () => {
    expect(applyTextEdits(SRC, [{ old_text: "nope", new_text: "x" }]).errors[0]).toMatch(/not found/);
    expect(applyTextEdits(SRC, [{ old_text: "param", new_text: "x" }]).errors[0]).toMatch(/more than once|times/);
  });

  it("changes a parameter value while keeping its unit and comment", () => {
    const p = evaluate(SRC).params.find((x) => x.name === "width")!;
    const out = setParamValue(SRC, p, 77.5);
    expect(out).toContain("param width = 77.5mm range 40 .. 200");
    expect(evaluate(out).params.find((x) => x.name === "width")!.value).toBeCloseTo(77.5);
  });

  it("locks and unlocks a parameter", () => {
    const p = evaluate(SRC).params.find((x) => x.name === "n")!;
    const locked = toggleParamLock(SRC, p);
    const lp = evaluate(locked).params.find((x) => x.name === "n")!;
    expect(lp.locked).toBe(true);
    expect(evaluate(toggleParamLock(locked, lp)).params.find((x) => x.name === "n")!.locked).toBe(false);
  });

  it("finds the minimal changed range", () => {
    expect(minimalChange("abcdef", "abXdef")).toEqual({ from: 2, to: 3, insert: "X" });
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("diffs by line", () => {
    const a = "one\ntwo\nthree";
    const b = "one\n2\nthree\nfour";
    expect(diffStats(a, b)).toEqual({ added: 2, removed: 1 });
    expect(lineDiff(a, b).some((l) => l.kind === "add" && l.text === "four")).toBe(true);
  });
});
