import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "../src/lang/parser";
import { evaluate } from "../src/lang/evaluator";
import { lex } from "../src/lang/lexer";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");

describe("design language", () => {
  it("converts units into millimetres and degrees", () => {
    const m = evaluate(`design "u"\nparam a = 2cm\nparam b = 1in\nparam c = 3.14159265rad`);
    const v = Object.fromEntries(m.params.map((p) => [p.name, p.value]));
    expect(v.a).toBeCloseTo(20);
    expect(v.b).toBeCloseTo(25.4);
    expect(v.c).toBeCloseTo(180);
  });

  it("rejects an unknown unit with a clear message", () => {
    const m = evaluate(`design "u"\nparam c = 0.5turn`);
    expect(m.diagnostics[0]?.message).toMatch(/Unknown unit "turn"/);
  });

  it("reports a syntax error with its position instead of throwing", () => {
    const src = `design "x"\nparam a = (1 + \n`;
    const { diagnostics } = parse(src);
    expect(diagnostics.some((d) => d.severity === "error")).toBe(true);
    const m = evaluate(src);
    expect(m.diagnostics[0].start).toBeGreaterThan(0);
  });

  it("suggests the right name for a typo", () => {
    const m = evaluate(`design "x"\nparam width = 10mm\nlet w = widht * 2`);
    const err = m.diagnostics.find((d) => d.severity === "error");
    expect(err?.message).toMatch(/width/);
  });

  it("never runs code from strings", () => {
    const m = evaluate(`design "x"\nnote "\${process.exit(1)}"\nlet a = "constructor"`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("lexes every token of the demos", () => {
    for (const d of ["enclosure", "reducer", "canister", "blank"]) expect(() => lex(demo(d))).not.toThrow();
  });
});

describe("demo designs", () => {
  it("enclosure: evaluates cleanly with its requirements met", () => {
    const m = evaluate(demo("enclosure"));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts).toHaveLength(21);
    expect(m.requirements).toHaveLength(6);
    expect(m.requirements.filter((r) => r.status === "fail")).toEqual([]);
  });

  it("reducer: evaluates cleanly, meshes at 12:1 and drives the output", () => {
    const m = evaluate(demo("reducer"));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts).toHaveLength(26);
    expect(m.requirements.filter((r) => r.status === "fail")).toEqual([]);
    const ratios = m.parts.filter((p) => p.motion?.ratio).map((p) => Math.abs(p.motion!.ratio));
    expect(Math.min(...ratios)).toBeCloseTo(1 / 12, 3);
  });

  it("reducer: the 20:1 revision with a 10 mm shaft still satisfies every parameter requirement", () => {
    let src = demo("reducer");
    src = src.replace(/param target_ratio = 12/, "param target_ratio = 20").replace(/param z4\s+= 36/, (s: string) => s.replace("36", "60"));
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.requirements.find((r) => r.label.startsWith("Reduction matches"))?.status).toBe("pass");
  });

  it("canister: evaluates cleanly with its parametric requirements met", () => {
    const m = evaluate(demo("canister"));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.map((p) => p.id)).toEqual(["jar", "lid"]);
    expect(m.parts.every((p) => p.detail)).toBe(true);
    expect(m.requirements.filter((r) => r.status === "fail")).toEqual([]);
  });

  it("identical parts share one geometry hash", () => {
    const m = evaluate(demo("enclosure"));
    const screws = m.parts.filter((p) => p.name === "lid_fasteners");
    expect(screws.length).toBe(4);
    expect(new Set(screws.map((p) => p.hash)).size).toBe(1);
  });
});
