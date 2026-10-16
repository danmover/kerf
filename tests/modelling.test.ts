import { describe, expect, it } from "vitest";
import { evaluate, evaluateSelector } from "../src/lang/evaluator";
import { profileBounds } from "../src/lang/modelling";
import type { PartRecipe, ShapeRecipe } from "../src/kernel/recipe";

const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const part = (body: string) => `design "t"\npart p {\n${body}\n}\n`;
const recipeOf = (src: string): PartRecipe => {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return m.parts[0].recipe;
};

describe("profiles", () => {
  it("draws outlines with arcs and splines, and combines profiles with + and -", () => {
    const r = recipeOf(part(`body extrude(outline([(0, 0), (20, 0), arc_to((20, 10), via: (23, 5)), spline_to((10, 14)), spline_to((0, 10))]) - circle(4, at: (10, 5)), h: 5)`));
    const base = r.base as Extract<ShapeRecipe, { t: "extrude" }>;
    expect(base.t).toBe("extrude");
    expect(base.p.t).toBe("diff2");
    const outer = (base.p as { a: { t: string; segs: { s: string }[] } }).a;
    expect(outer.t).toBe("path2");
    expect(outer.segs.map((s) => s.s)).toContain("arc");
    expect(outer.segs.filter((s) => s.s === "bezier").length).toBeGreaterThan(0);
  });

  it("revolves a profile whose x is the radius and rejects one that crosses the axis", () => {
    expect(recipeOf(part(`body revolve(rect(4, 10, at: (8, 5)))`)).base?.t).toBe("revolve2");
    expect(errors(part(`body revolve(rect(4, 10, at: (0, 5)))`)).join()).toMatch(/revolve\(\): the profile reaches x = -2/);
  });

  it("explains a profile used where a solid is needed", () => {
    expect(errors(part(`body circle(10)`)).join()).toMatch(/profile/i);
  });
});

describe("solids and threads", () => {
  it("builds hollow lofts and threaded tubes", () => {
    const r = recipeOf(part(`body loft([circle(40), rounded(rect(44, 44), 8), circle(30)], heights: [0, 40, 70], wall: 1.6)
add thread(d: 26, pitch: 3, form: "trapezoid", length: 10, at: (0, 0, 70), clearance: 0.15, bore: 20)`));
    expect(r.base?.t).toBe("diff");
    const t = r.ops[0];
    expect(t.op === "add" && t.shape.t === "thread" && t.shape.bore).toBe(20);
  });

  it("rejects a thread bore that leaves no wall under the root", () => {
    expect(errors(part(`body thread(d: 26, pitch: 3, form: "trapezoid", length: 10, bore: 22.5)`)).join()).toMatch(/leaves under 0.4 mm of wall/);
  });

  it("cuts real threaded holes and refuses ones that cannot exist", () => {
    const r = recipeOf(part(`body box(20, 20, 10)\ncut hole(M5, fit: "thread", depth: 8, at: (0, 0, 10))`));
    const h = r.ops[0];
    expect(h.op === "cut" && h.shape.t === "hole" && h.shape.thread?.pitch).toBe(0.8);
    expect(errors(part(`body box(20, 20, 10)\ncut hole(M8, fit: "insert", depth: 8, at: (0, 0, 10))`)).join()).toMatch(/no common heat-set insert for M8/);
    expect(errors(part(`body box(20, 20, 10)\ncut hole(M5, fit: "thread", through: true, at: (0, 0, 10))`)).length).toBeGreaterThan(0);
  });

  it("keeps knurls sensible", () => {
    expect(errors(part(`body knurl(d: 10, h: 5, depth: 3)`)).join()).toMatch(/at most a quarter of d/);
  });
});

describe("named features and selections", () => {
  const src = part(`body box(40, 30, 5) as plate
add screw_boss(at: (0, 0, 5), size: M3, h: 8) as boss
fillet(1, edges: boss.root)
cosmetic {
  chamfer(0.3, edges: plate.tip)
}`);

  it("records named features, their kind and which steps are cosmetic", () => {
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const p = m.parts[0];
    expect(p.features?.map((f) => f.name)).toEqual(expect.arrayContaining(["plate", "boss"]));
    expect(p.detail).toBe(true);
    const cosmetic = p.recipe.ops.filter((o) => o.cosmetic);
    expect(cosmetic.some((o) => o.op === "chamfer")).toBe(true);
    const fillet = p.recipe.ops.find((o) => o.op === "fillet" && !o.cosmetic);
    expect(fillet && fillet.op === "fillet" && fillet.edges).toEqual({ s: "feat", f: "boss", part: "root" });
  });

  it("combines selections with +, - and both()", () => {
    expect(evaluateSelector(`boss.root + "top"`, ["boss"]).sel).toEqual({ s: "or", a: [{ s: "feat", f: "boss", part: "root" }, "top"] });
    expect(evaluateSelector(`both(plate.edges, "vertical")`, ["plate"]).sel).toEqual({ s: "and", a: [{ s: "feat", f: "plate", part: "edges" }, "vertical"] });
    expect(evaluateSelector(`"convex" - boss.edges`, ["boss"]).sel).toEqual({ s: "minus", a: "convex", b: { s: "feat", f: "boss", part: "edges" } });
  });

  it("names the features that exist when a selection refers to a missing one", () => {
    expect(evaluateSelector(`bos.root`, ["boss"]).error).toMatch(/bos/);
    expect(errors(part(`body box(10, 10, 10) as base\nfillet(1, edges: lid.tip)`)).length).toBeGreaterThan(0);
  });
});

describe("snap fits", () => {
  it("warns when a snap hook bends more than its material takes", () => {
    const m = evaluate(`design "t"
part clip {
  material: "PLA"
  body box(30, 20, 3) as base
  add snap_hook(at: (0, 0, 3), length: 6, t: 2, w: 5, catch: 1.2)
}`);
    const w = m.diagnostics.find((d) => d.rule === "clip snap hook strain");
    expect(w?.severity).toBe("warning");
    expect(w?.message).toMatch(/PLA/);
  });

  it("accepts a long, thin hook", () => {
    const m = evaluate(`design "t"
part clip {
  material: "PETG"
  body box(30, 20, 3)
  add snap_hook(at: (0, 0, 3), length: 16, t: 1.4, w: 5, catch: 0.8)
}`);
    expect(m.diagnostics.filter((d) => d.rule?.includes("snap hook"))).toEqual([]);
  });
});

describe("limits that keep builds fast", () => {
  const err = (body: string) => errors(part(body)).join(" ");

  it("caps helix turns, twist and loft sections", () => {
    expect(err(`body sweep(circle(1), helix(d: 20, pitch: 1, h: 250))`)).toMatch(/250 turns is more than the 200/);
    expect(err(`body extrude(rect(10, 10), h: 10, twist: 7200)`)).toMatch(/twist 7200° is more than 10 full turns/);
    const many = Array.from({ length: 60 }, () => "circle(10)").join(", ");
    const hs = Array.from({ length: 60 }, (_, i) => i).join(", ");
    expect(err(`body loft([${many}], heights: [${hs}])`)).toMatch(/60 sections is more than the 50/);
  });

  it("keeps swept profiles small and refuses text", () => {
    expect(err(`body sweep(text("ABCDE", size: 3), path([(0, 0, 0), (0, 0, 20), (20, 0, 20)], r: 10))`)).toMatch(/text cannot be swept/);
    const dots = Array.from({ length: 9 }, (_, i) => `circle(1, at: (${i * 3}, 0))`).join(" + ");
    expect(err(`body sweep(${dots}, path([(0, 0, 0), (0, 0, 20)]))`)).toMatch(/9 outlines and holes/);
    expect(err(`body sweep(circle(6) - circle(4), path([(0, 0, 0), (0, 0, 20)]))`)).toBe("");
  });

  it("caps thread turns in threads, threaded holes and threaded bosses", () => {
    expect(err(`body thread(d: 10, pitch: 1, length: 250)`)).toMatch(/thread\(\): 250 turns of thread is more than the 200/);
    expect(err(`body box(20, 20, 300)\ncut hole(M3, fit: "thread", depth: 290, at: (0, 0, 300))`)).toMatch(/hole\(\): 580 turns/);
    expect(err(`body box(40, 40, 4)\nadd screw_boss(at: (0, 0, 4), size: M2, h: 250, fit: "thread")`)).toMatch(/screw_boss\(\): 625 turns/);
    expect(err(`body box(20, 20, 30)\ncut hole(M3, fit: "thread", depth: 20, at: (0, 0, 30))`)).toBe("");
  });

  it("measures very large outlines without overflowing the stack", () => {
    const pts = Array.from({ length: 200_000 }, (_, i): [number, number] => [Math.cos(i) * 10, Math.sin(i) * 5]);
    const b = profileBounds({ t: "poly", pts, r: 0 })!;
    expect(b[0][0]).toBeCloseTo(-10, 3);
    expect(b[1][1]).toBeCloseTo(5, 3);
  });
});

describe("selectors written for inspect_part", () => {
  it("see the design's params and lets", () => {
    const design = `design "t"\nparam wall = 2.4\nlet lip = wall * 2\npart p {\n  body box(10, 10, 10)\n}\n`;
    expect(evaluateSelector(`near((0, 0, wall), 1)`, []).error).toMatch(/wall/);
    expect(evaluateSelector(`near((0, 0, wall), lip)`, [], design).sel).toEqual({ s: "near", p: [0, 0, 2.4], r: 4.8 });
  });
});
