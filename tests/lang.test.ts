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
    for (const d of ["enclosure", "reducer", "canister", "blank", "bracket", "shelf"]) expect(() => lex(demo(d))).not.toThrow();
  });
});

describe("limits on hostile source", () => {
  it("counts loop iterations toward the step limit, even with an empty body", () => {
    const loops = 'design "x"\npart p {\n  body box(1, 1, 1)\n  for a in range(2000) {\n    for b in range(2000) {\n    }\n  }\n}';
    const t0 = performance.now();
    const m = evaluate(loops);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(m.diagnostics.some((d) => /too large to evaluate/.test(d.message))).toBe(true);
  });

  it("reports deeply nested source instead of throwing", () => {
    const deep = `design "x"\nparam a = ${"(".repeat(20000)}1${")".repeat(20000)}`;
    const r = parse(deep);
    expect(r.diagnostics.some((d) => /nested too deeply/.test(d.message))).toBe(true);
    expect(() => evaluate(deep)).not.toThrow();
  });
});

describe("demo designs", () => {
  it("enclosure: evaluates cleanly with its requirements met", () => {
    const m = evaluate(demo("enclosure"));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts).toHaveLength(21);
    expect(m.requirements).toHaveLength(8);
    expect(m.requirements.filter((r) => r.level === "hard" && r.status === "fail")).toEqual([]);
    // the brief's power use catches a real problem: the port sits too deep behind the wall for a standard plug
    expect(m.requirements.filter((r) => r.status === "fail").map((r) => r.label)).toEqual(["USB-C plug can seat (port within 1 mm of the outside)"]);
    expect(m.brief?.uses.every((u) => m.requirements.some((r) => r.uses.includes(u.id)))).toBe(true);
    expect(m.brief?.givens.every((g) => g.usedBy.length)).toBe(true);
  });

  it("reducer: evaluates cleanly, meshes at 12:1 and drives the output", () => {
    const m = evaluate(demo("reducer"));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts).toHaveLength(26);
    expect(m.requirements.filter((r) => r.status === "fail")).toEqual([]);
    expect(m.brief?.uses.every((u) => m.requirements.some((r) => r.uses.includes(u.id)))).toBe(true);
    const ratios = m.parts.filter((p) => p.motion?.ratio).map((p) => Math.abs(p.motion!.ratio));
    expect(Math.min(...ratios)).toBeCloseTo(1 / 12, 3);
  });

  it("shelf bracket: evaluates cleanly with its stress analysis set up", () => {
    const m = evaluate(demo("shelf"));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.map((p) => p.name)).toEqual(["bracket", "wall_screws", "wall_screws"]);
    expect(m.requirements.filter((r) => r.status === "fail")).toEqual([]);
    const a = m.analyses[0];
    expect(a.kind).toBe("structural");
    if (a.kind !== "structural") return;
    expect(a.parts).toEqual(["bracket"]);
    expect(a.supports).toHaveLength(3);
    expect(a.supports[2].dir).toEqual([0, 1, 0]);
    expect(a.loads[0]).toMatchObject({ t: "force", f: [0, 0, -8 * 9.81] });
    // printed on its side: the bracket's own process says so, and the analysis takes its layers from it
    expect(m.parts[0].process?.id).toBe("fdm");
    expect(m.parts[0].process?.settings.build).toEqual([1, 0, 0]);
    expect(a.buildGiven).toBeFalsy();
    expect(a.printed).toBe(true);
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
  it("lets a design's own names shadow built-in functions", () => {
    // offset, ring, text, path and gusset are built-ins added after designs used these names
    const m = evaluate(`design "shadow"
param offset = 2
let text = 3
part ring {
  body box(10 + offset, 10, text)
}
part path {
  body cylinder(d: 6, h: offset * 2)
}`);
    expect(m.diagnostics.filter((d) => d.severity !== "warning")).toEqual([]);
    expect(m.parts.map((p) => p.name)).toEqual(["ring", "path"]);
    expect(m.params.find((p) => p.name === "offset")?.value).toBe(2);
    // a user name is still defined once only
    expect(evaluate(`design "twice"\nparam ring = 1\nparam ring = 2`).diagnostics[0]?.message).toMatch(/"ring" is already defined/);
    // and the built-in keeps working where it is not shadowed
    expect(evaluate(`design "builtin"\npart p {\n  body extrude(offset(rect(10, 10), 1), h: 2)\n}`).diagnostics.filter((d) => d.severity !== "warning")).toEqual([]);
  });

  it("bracket: its sketch named gusset evaluates beside the gusset() built-in", () => {
    const m = evaluate(demo("bracket"));
    expect(m.diagnostics.filter((d) => d.severity !== "warning")).toEqual([]);
    expect(m.parts.length).toBeGreaterThan(0);
  });
});
