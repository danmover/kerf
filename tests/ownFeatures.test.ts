// The design's own functions and features: fn name(...) = value for numbers, shapes and profiles worked out the same
// way in many places, and feature name(...) { steps } for a set of adds, cuts and rounds used in parts as one step.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { parse } from "../src/lang/parser";
import { KernelCore } from "../src/kernel/core";
import { shapeValid } from "../src/kernel/profiles";
import { partSteps } from "../src/core/features";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
function built(src: string) {
  const model = evaluate(src);
  expect(model.diagnostics.map((d) => d.message)).toEqual([]);
  const core = new KernelCore();
  return model.parts.map((p) => {
    const e = core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    expect(shapeValid(e.shape)).toBe(true);
    return { part: p, entry: e };
  });
}

const CASE = `design "Case"
param wall = 2
feature boss(at, d: 8, h: 10, hole: 3) "A screw boss" {
  add cylinder(d: d, h: h, at: at) as post
  cut hole(d: hole, depth: h, at: at + (0, 0, h))
  fillet(0.5, edges: post.root)
}
part case {
  body box(80, 60, wall)
  boss((-30, -20, wall))
  boss((30, 20, wall), d: 10) as big
  fillet(0.4, edges: big.tip)
}
`;

const CASE_BY_HAND = `design "Case"
param wall = 2
part case {
  body box(80, 60, wall)
  add cylinder(d: 8, h: 10, at: (-30, -20, wall)) as post1
  cut hole(d: 3, depth: 10, at: (-30, -20, wall + 10))
  fillet(0.5, edges: post1.root)
  add cylinder(d: 10, h: 10, at: (30, 20, wall)) as post2
  cut hole(d: 3, depth: 10, at: (30, 20, wall + 10)) as bore2
  fillet(0.5, edges: post2.root)
  fillet(0.4, edges: post2.tip + bore2.tip + between(post2, bore2))
}
`;

describe("functions", () => {
  it("works out values with defaults, named values, lets in braces and calls of its own", () => {
    const src = `design "F"
fn wall_for(span, min: 1.6) = max(min, span / 40)
fn stiffener(len, h: 8) "A stiffening rib" {
  let t = wall_for(len)
  return box(len, t, h)
}
fn fact(n) = n <= 1 ? 1 : n * fact(n - 1)
param n = 4
let a = wall_for(40)
let b = wall_for(200)
let c = wall_for(40, min: 3)
let f = fact(n)
part p { body stiffener(120) }
require "a": a == 1.6
require "b": b == 5
require "c": c == 3
require "f": f == 24
`;
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    expect(m.requirements.map((r) => [r.label, r.status])).toEqual([
      ["a", "pass"],
      ["b", "pass"],
      ["c", "pass"],
      ["f", "pass"],
    ]);
    expect(m.parts[0].recipe.base).toMatchObject({ t: "box", w: 120, d: 3, h: 8 });
    expect(m.blocks.find((b) => b.name === "stiffener")).toMatchObject({ kind: "fn", sig: "len, h: 8", doc: "A stiffening rib" });
    expect(errors(`design "F"\nfn rib(l) = l`)).toEqual([`"rib" is one of Kerf's own names: give your function another name`]);
  });

  it("explains a call that does not fit, a name Kerf already has, and a function that never stops", () => {
    const head = `design "F"\nfn area(w, h: 2) = w * h\n`;
    expect(errors(head + "let a = area()")).toEqual(["area() needs w: area(w, h: 2)"]);
    expect(errors(head + "let a = area(1, 2, 3)")).toEqual(["area() takes 2 values (w, h), not 3"]);
    expect(errors(head + "let a = area(1, hh: 3)")).toEqual(['area() has no parameter "hh". Did you mean "h"?']);
    expect(errors(head + "let a = area(1, w: 3)")).toEqual(["area(): w is given twice, in its place and as w:"]);
    expect(errors(`design "F"\nfn max(a, b) = a`)).toEqual([`"max" is one of Kerf's own names: give your function another name`]);
    expect(errors(`design "F"\nfn loop(n) = loop(n + 1)\nlet x = loop(0)`)[0]).toMatch(/^In loop\(\), used on line 2: loop\(\) calls itself more than 100 deep/);
    expect(errors(`design "F"\nfn half(x) = x / 2\nlet y = half("a")`)).toEqual(['In half(), used on line 3: Cannot apply "/" to string and number']);
  });
});

describe("features", () => {
  it("builds the same solid as the steps written out by hand", () => {
    const [own] = built(CASE);
    const [hand] = built(CASE_BY_HAND);
    expect(own.entry.volume).toBeGreaterThan(0);
    expect(own.entry.volume).toBeCloseTo(hand.entry.volume, 3);
    expect(own.entry.bbox).toEqual(hand.entry.bbox);
  });

  it("names each use's steps for the use, so two uses never share a name", () => {
    const m = evaluate(CASE);
    const ops = m.parts[0].recipe.ops;
    expect(ops.map((o) => ("name" in o ? o.name : undefined))).toEqual(["boss#1.post", "boss#1", undefined, "big.post", "big", undefined, undefined]);
    // the fillet inside the feature picks that use's own post
    expect(ops[2]).toMatchObject({ op: "fillet", edges: { s: "feat", f: "boss#1.post", part: "root" } });
    expect(ops[5]).toMatchObject({ op: "fillet", edges: { s: "feat", f: "big.post", part: "root" } });
    expect(ops[6]).toMatchObject({ op: "fillet", edges: { s: "feat", f: "big", part: "tip" } });
    // the part picks a step named inside one use
    const sub = evaluate(CASE.replace("fillet(0.4, edges: big.tip)", "fillet(0.4, edges: big.post.tip)"));
    expect(sub.diagnostics).toEqual([]);
    expect(sub.parts[0].recipe.ops.at(-1)).toMatchObject({ op: "fillet", edges: { s: "feat", f: "big.post", part: "tip" } });
    expect(errors(CASE.replace("fillet(0.4, edges: big.tip)", "fillet(0.4, edges: big.pst.tip)"))).toEqual(['In part "case": Feature "big" has root, tip, edges, faces, convex and concave, and the steps named inside it: post, not "pst"']);
    expect(sub.parts[0].features?.map((f) => f.name)).toEqual(["boss#1", "boss#1.post", "big", "big.post"]);
  });

  it("takes add boss(...) as boss(...), and uses inside loops, ifs and other features", () => {
    const src = `design "Plate"
feature peg(at, d: 6) { add cylinder(d: d, h: 6, at: at) }
feature pegs(n, pitch: 15, f: peg) {
  for i in range(n) { f((i * pitch - (n - 1) * pitch / 2, 0, 4)) }
}
part plate {
  body box(80, 30, 4)
  add peg((0, 10, 4)) as front
  pegs(3)
  if true { peg((30, -10, 4)) }
}
`;
    const [p] = built(src);
    const ops = p.part.recipe.ops;
    expect(ops.map((o) => ("name" in o ? o.name : undefined))).toEqual(["front", "pegs#1.peg#1", "pegs#1.peg#2", "pegs#1.peg#3", "peg#1"]);
    const plate = 80 * 30 * 4;
    const peg = Math.PI * 9 * 6;
    expect(p.entry.volume).toBeCloseTo(plate + 5 * peg, 0);
  });

  it("explains a feature used as a value, a property inside one, and one made of itself", () => {
    const head = `design "F"\nfeature peg(at) { add cylinder(d: 4, h: 4, at: at) }\n`;
    expect(errors(head + "let x = peg((0, 0, 0))")[0]).toMatch(/^peg\(\) is a feature: use it on its own line in a part/);
    expect(errors(head + "part p { body box(10, 10, 2)\n  cut peg((0, 0, 2)) }")).toEqual(['In part "p": peg() is a feature: it adds and cuts on its own, so write peg(...) on its own line']);
    expect(errors(`design "F"\nfeature tab(at) {\n  color: #ff0000\n  add box(4, 4, 4, at: at)\n}`)).toEqual(["A feature is steps (add, cut, fillet, for, if, let), and color: belongs to the part it is used in. Give it as a parameter if the feature needs it."]);
    expect(errors(`design "F"\nfeature a(n) { a(n) }\npart p { body box(10, 10, 2)\n  a(1) }`)).toEqual(['In part "p": In a(), used on line 4: a() is used inside itself (a → a): a feature can\'t be made of itself']);
    expect(errors(`design "F"\npart p { body box(10, 10, 2)\n  fillet(1) as f }`)).toEqual(['In part "p": Only a use of one of the design\'s own features can be named here: fillet() makes no feature of its own']);
    expect(errors(`design "F"\nfn web(l) = box(l, 2, 4)\npart p { body box(10, 10, 2)\n  web(5) }`)[0]).toMatch(/web\(\) is a function: it gives a value, so put body, add, cut or intersect in front/);
  });

  it("tells an error inside a feature with the line it was used on", () => {
    const src = `design "F"
feature peg(at, d: 4) { add cylinder(d: d, h: 4, at: at) }
part p {
  body box(10, 10, 2)
  peg((0, 0, 2), d: -1)
}
`;
    const e = evaluate(src).diagnostics.find((d) => d.severity === "error")!;
    expect(e.message).toMatch(/^In part "p": In peg\(\), used on line 5: /);
    // marked where it went wrong, inside the feature
    expect(src.slice(e.start, e.end)).toContain("cylinder");
  });

  it("puts features and functions in the dependency graph by what they read", () => {
    const m = evaluate(CASE.replace('feature boss(at, d: 8, h: 10, hole: 3) "A screw boss" {', 'param post_h = 10\nfeature boss(at, d: 8, h: post_h, hole: 3) "A screw boss" {'));
    const edges = m.graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toContain("post_h->boss");
    expect(edges).toContain("boss->case");
    expect(m.graph.nodes.find((n) => n.id === "boss")?.kind).toBe("feature");
  });

  it("shows a use in the feature tree as one step, its values named by the feature's parameters", () => {
    const steps = partSteps(CASE, "case")!.steps;
    const uses = steps.filter((s) => s.fn === "boss");
    expect(uses.map((s) => [s.title, s.name, s.fields.map((f) => `${f.label}=${f.text}`)])).toEqual([
      ["Boss", undefined, ["at=(-30, -20, wall)"]],
      ["Boss", "big", ["at=(30, 20, wall)", "d=10"]],
    ]);
  });

  it("builds the language reference's own example, and takes a part's named step as a value", () => {
    const src = `design "Ref"
fn wall_for(span, min: 1.6) = max(min, span / 40)
fn web(len, h: 8) { let t = wall_for(len)  box(len, t, h) }
feature boss(at, d: 8, h: 10, screw: M3) "Screw boss for a self-tapping screw" {
  add cylinder(d: d, h: h, at: at) as post
  cut hole(screw, depth: h - 1, at: at + (0, 0, h), fit: "tap")
  fillet(0.6, edges: post.root)
}
feature round_off(of, r: 1) { fillet(r, edges: of.tip) }
part case {
  body box(80, 60, 2)
  boss((-30, -20, 2))
  boss((30, 20, 2), d: 10) as big
  chamfer(0.4, edges: big.tip)
  add web(40) as fin
  round_off(of: fin, r: 0.5)
}
`;
    const [p] = built(src);
    expect(p.entry.volume).toBeGreaterThan(80 * 60 * 2);
    expect(p.part.recipe.ops.at(-1)).toMatchObject({ op: "fillet", r: 0.5, edges: { s: "feat", f: "fin", part: "tip" } });
  });

  it("reads function as fn, and leaves fn, function and feature free as names elsewhere", () => {
    const m = evaluate(`design "F"\nfunction twice(v) = v * 2\nlet fn = twice(2)\nlet feature = fn + 1\nparam function_count = 3\nrequire "twice": feature == 5`);
    expect(m.diagnostics).toEqual([]);
    expect(m.requirements[0].status).toBe("pass");
  });

  it("keeps reading the rest of the file after a mistake above a definition", () => {
    const { program, diagnostics } = parse(`design "F"\nlet x = (\nfn twice(v) = v * 2\nfeature dot(at) { add sphere(1, at: at) }\n`);
    expect(diagnostics.length).toBe(1);
    expect(program.stmts.map((s) => s.k)).toEqual(["design", "fn", "feature"]);
  });
});
