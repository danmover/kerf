import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { addFeature, addSketch, addStatements, deleteSelection, renameSketch, setConstraintValue, suggestionsFor, toggleConstruction, writePositions, consId } from "../src/sketch/edits";

const base = `design "t"
param w = 40

sketch s {
  line l1 = (0, 0) -> (40, 0)
  line l2 = l1.end -> (40, 20)
  line l3 = l2.end -> (0, 20)
  line l4 = l3.end -> l1.start
  horizontal l1, l3
  vertical l2, l4
  length l1 = w
}

part p {
  body extrude(s, 5)
}
`;
const sk = (src: string, name = "s") => {
  const m = evaluate(src);
  const out = m.sketches.find((x) => x.name === name);
  if (!out) throw new Error(JSON.stringify(m.diagnostics));
  return { sk: out, m };
};

describe("sketch edits", () => {
  it("adds a new sketch before the first part", () => {
    const { m } = sk(base);
    const r = addSketch(base, m, { plane: "XZ", offset: 4 });
    expect(r.name).toBe("sketch1");
    expect(r.src.indexOf("sketch sketch1")).toBeLessThan(r.src.indexOf("part p"));
    const m2 = evaluate(r.src);
    expect(m2.diagnostics).toEqual([]);
    expect(m2.sketches.map((x) => x.name)).toEqual(["s", "sketch1"]);
    expect(m2.sketches[1].frame.o).toEqual([0, -4, 0]);
  });

  it("adds geometry and constraints in the right places", () => {
    const { sk: s } = sk(base);
    const src = addStatements(base, s, { geometry: ["circle c1 = (20, 10), d: 6"], constraints: ["diameter c1 = 6"] });
    const lines = src.split("\n");
    expect(lines.indexOf("  circle c1 = (20, 10), d: 6")).toBe(lines.indexOf("  line l4 = l3.end -> l1.start") + 1);
    expect(lines.indexOf("  diameter c1 = 6")).toBe(lines.indexOf("  length l1 = w") + 1);
    const { sk: s2, m } = sk(src);
    expect(m.diagnostics).toEqual([]);
    expect(s2.profile.regions[0].holes.length).toBe(1);
  });

  it("adds statements to an empty sketch", () => {
    const src = `sketch e {\n  plane: XY\n}\n`;
    const { sk: s } = sk(src, "e");
    const out = addStatements(src, s, { geometry: ["circle c1 = (0, 0), r: 5"], constraints: ["radius c1 = 5"] });
    expect(out).toBe(`sketch e {\n  plane: XY\n  circle c1 = (0, 0), r: 5\n  radius c1 = 5\n}\n`);
  });

  it("writes solved positions into plain coordinates and leaves formulas alone", () => {
    const rough = base.replace("(40, 20)", "(41, 19)").replace("(0, 20)", "(1, 21)");
    const { sk: s } = sk(rough);
    const out = writePositions(rough, s);
    // the rectangle is squared up with as little movement as possible, and the text now says so
    expect(out).toContain("line l2 = l1.end -> (40.5, 20)");
    expect(out).toContain("line l3 = l2.end -> (0.5, 20)");
    const { sk: s2 } = sk(out);
    for (const p of s2.points) if (p.written) expect([p.x, p.y]).toEqual(p.written);
    expect(writePositions(out, s2)).toBe(out);
    const formula = writePositions(base.replace("(40, 20)", "(w + 1, 20)"), sk(base.replace("(40, 20)", "(w + 1, 20)")).sk);
    expect(formula).toContain("(w + 1, 20)");
  });

  it("deletes a line, keeps its neighbours in place and tidies constraints", () => {
    const { sk: s } = sk(base);
    const out = deleteSelection(base, s, ["l1"]);
    expect(out).not.toContain("line l1");
    // l2 started at l1.end; it now starts at that position
    expect(out).toContain("line l2 = (40, 0) -> (40, 20)");
    expect(out).toContain("line l4 = l3.end -> (0, 0)");
    expect(out).toContain("  horizontal l3\n");
    expect(out).not.toContain("length l1");
    expect(evaluate(out).diagnostics.filter((d) => d.severity === "error" && !/profile/.test(d.message))).toEqual([]);
  });

  it("deletes a constraint by its index", () => {
    const { sk: s } = sk(base);
    const len = s.constraints.find((c) => c.kind === "length")!;
    const out = deleteSelection(base, s, [consId(len)]);
    expect(out).not.toContain("length l1");
    expect(out).toContain("vertical l2, l4\n}");
  });

  it("toggles construction geometry", () => {
    const { sk: s } = sk(base);
    const on = toggleConstruction(base, s, ["l1", "l2"]);
    expect(on).toContain("construction line l1");
    expect(on).toContain("construction line l2");
    const off = toggleConstruction(on, sk(on).sk, ["l1"]);
    expect(off).toContain("  line l1");
  });

  it("changes a dimension to a number or a formula", () => {
    const { sk: s } = sk(base);
    const len = s.constraints.find((c) => c.kind === "length")!;
    expect(setConstraintValue(base, len, 55)).toContain("length l1 = 55");
    expect(setConstraintValue(base, len, "w * 2")).toContain("length l1 = w * 2");
  });

  it("suggests relations and dimensions for a selection", () => {
    const { sk: s } = sk(base);
    const one = suggestionsFor(s, ["l2"]).map((x) => x.stmt);
    expect(one[0]).toBe("vertical l2");
    expect(one).toContain("length l2 = 20");
    const corner = suggestionsFor(s, ["l1", "l2"]).map((x) => x.kind);
    expect(corner).toEqual(expect.arrayContaining(["parallel", "perpendicular", "equal", "fillet", "chamfer"]));
    const pts = suggestionsFor(s, ["l1.start", "l2.end"]).map((x) => x.stmt);
    expect(pts).toContain("distance l1.start, l2.end = 44.721");
    expect(pts).toContain("hdistance l1.start, l2.end = 40");
  });

  it("renames a sketch and its uses but not matching field names", () => {
    const src = base + `let s2 = s.area\nlet other = p\n`;
    const out = renameSketch(src, sk(src).sk, "plate");
    expect(out).toContain("sketch plate {");
    expect(out).toContain("extrude(plate, 5)");
    expect(out).toContain("let s2 = plate.area");
    expect(evaluate(out).diagnostics).toEqual([]);
  });

  it("extrudes a sketch into a new part with its depth as a parameter", () => {
    const src = base.replace("part p {\n  body extrude(s, 5)\n}\n", "");
    const r = addFeature(src, sk(src).sk, { kind: "extrude", op: "new", depth: 12, param: true });
    expect(r.part).toBe("s_part");
    expect(r.param).toBe("s_depth");
    expect(r.src).toMatch(/param s_depth = 12 range .* "Depth of s"/);
    expect(r.src).toContain("body extrude(s, s_depth)");
    const m = evaluate(r.src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.map((x) => x.name)).toEqual(["s_part"]);
    expect(m.sketches[0].usedBy).toEqual(["s_part"]);
  });

  it("cuts a later sketch through an existing part, moving the sketch above it", () => {
    const src = base + `\nsketch vent {\n  plane: XY\n  circle c = (20, 10), d: 6\n}\n`;
    const r = addFeature(src, sk(src, "vent").sk, { kind: "extrude", op: "cut", part: "p", through: true });
    expect(r.src.indexOf("sketch vent")).toBeLessThan(r.src.indexOf("part p"));
    expect(r.src).toMatch(/body extrude\(s, 5\)\n  cut extrude\(vent, through: true\)\n\}/);
    const m = evaluate(r.src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.sketches.find((x) => x.name === "vent")?.usedBy).toEqual(["p"]);
  });

  it("revolves about a sketch line and writes a partial angle", () => {
    const src = `design "t"\nsketch r {\n  plane: XZ\n  construction line ax = (0, -5) -> (0, 30)\n  line a = (5, 0) -> (12, 0)\n  line b = a.end -> (12, 20)\n  line c = b.end -> (5, 20)\n  line d = c.end -> a.start\n}\n`;
    const r = addFeature(src, sk(src, "r").sk, { kind: "revolve", op: "new", axis: "ax", angle: 180 });
    expect(r.src).toContain("body revolve(r, axis: r.ax, angle: 180)");
    const m = evaluate(r.src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts.length).toBe(1);
  });
});
