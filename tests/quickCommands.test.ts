import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { applyQuick, eulerOf, parseQuick, vocabOf, type QuickCommand, type QuickContext, type Vec3 } from "../src/core/quickCommands";
import { fullCheck } from "./helpers/fullcheck";

const SRC = `design "Quick test"
param wall = 2mm range 1 .. 5 "Wall"
param width = 40mm
param fan = false

part plate {
  color: #4f7cff
  material: "PETG"
  body box(width, 30, 10)
  cut hole(M3, through: true, at: (12, 0, 10))
}

// the cover
part lid {
  label: "Top lid"
  color: #888888
  body box(40, 30, 3, at: (0, 0, 20))
}

component brg = lib.bearing("608") { at: (60, 0, 0) }
`;

const model = evaluate(SRC);
const vocab = vocabOf(model);
const parse = (t: string) => parseQuick(t, vocab);
const BOXES: Record<string, [Vec3, Vec3]> = { plate: [[-20, -15, 0], [20, 15, 10]], lid: [[-20, -15, 20], [20, 15, 23]] };
const ctx = (extra: Partial<QuickContext> = {}): QuickContext => ({ src: SRC, model, box: (b) => BOXES[b], bounds: [[-20, -15, 0], [71, 15, 23]], ...extra });
const run = (text: string, extra: Partial<QuickContext> = {}) => {
  const cmd = parse(text);
  if (!cmd) throw new Error(`not a command: ${text}`);
  const r = applyQuick(cmd, ctx(extra));
  if (!r.ok) throw new Error(r.why);
  const m = evaluate(r.src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return { ...r, model: m };
};

describe("parsing plain commands", () => {
  it.each<[string, Partial<QuickCommand>]>([
    ["fillet 2", { k: "fillet", r: 2 }],
    ["please round the edges 1.5mm", { k: "fillet", r: 1.5 }],
    ["round the corners 5", { k: "fillet", r: 5, edges: "vertical" }],
    ["add 2mm fillets to the top edges of the top lid", { k: "fillet", r: 2, edges: "top", target: "lid" }],
    ["round all the top edges 2", { k: "fillet", r: 2, edges: "top" }],
    ["chamfer r1.5 corners", { k: "chamfer", r: 1.5, edges: "vertical" }],
    ["bevel the outside edges 0.5", { k: "chamfer", r: 0.5, edges: "convex" }],
    ["shell 2 open top", { k: "shell", t: 2, open: "Z" }],
    ["hollow it out 2 mm leaving the bottom open", { k: "shell", t: 2, open: "-Z" }],
    ["shell 1.6 closed", { k: "shell", t: 1.6, open: null }],
    ["hole M3 here", { k: "hole", size: "M3" }],
    ["drill a 5mm hole 8 deep", { k: "hole", d: 5, depth: 8 }],
    ["add an M4 heat-set insert hole", { k: "hole", size: "M4", fit: "insert" }],
    ["countersunk m3 hole through", { k: "hole", size: "M3", through: true, csink: true }],
    ["move 10 up", { k: "move", by: [0, 0, 10] }],
    ["move the lid 5 left and 3 forward", { k: "move", by: [-5, -3, 0], target: "lid" }],
    ["move x -12.5", { k: "move", by: [-12.5, 0, 0] }],
    ["nudge it (1, 2, 3)", { k: "move", by: [1, 2, 3] }],
    ["raise plate 4", { k: "move", by: [0, 0, 4], target: "plate" }],
    ["rotate 90", { k: "rotate", angle: 90, axis: 2 }],
    ["rotate lid 45 deg about x", { k: "rotate", angle: 45, axis: 0, target: "lid" }],
    ["turn it 30 degrees clockwise", { k: "rotate", angle: -30, axis: 2 }],
    ["flip it upside down", { k: "rotate", angle: 180, axis: 0 }],
    ["wall 3", { k: "param", name: "wall", op: "set", value: 3 }],
    ["set wall to 2.5mm", { k: "param", name: "wall", op: "set", value: 2.5 }],
    ["wall +1", { k: "param", name: "wall", op: "add", value: 1 }],
    ["increase width by 5", { k: "param", name: "width", op: "add", value: 5 }],
    ["make width 2cm shorter", { k: "param", name: "width", op: "add", value: -20 }],
    ["double width", { k: "param", name: "width", op: "mul", value: 2 }],
    ["fan on", { k: "param", name: "fan", op: "set", value: true }],
    ["make it red", { k: "color", color: "#d64541" }],
    ["paint the lid dark grey", { k: "color", target: "lid", name: "dark grey" }],
    ["colour #00ff00", { k: "color", color: "#00ff00" }],
    ["petg", { k: "material", material: "PETG" }],
    ["make it aluminium", { k: "material", material: "Aluminum 6061" }],
    ["change material to stainless 316", { k: "material", material: "Stainless 316" }],
    ["make the lid brass", { k: "material", material: "Brass", target: "lid" }],
    ["copy", { k: "copy" }],
    ["duplicate it 30 right", { k: "copy", by: [30, 0, 0] }],
    ["delete this", { k: "delete" }],
    ["remove the lid", { k: "delete", target: "lid" }],
    ["box 40x20x10", { k: "new", shape: "box", size: [40, 20, 10] }],
    ["add a box 40 x 20 x 10", { k: "new", shape: "box", size: [40, 20, 10] }],
    ["cube 15", { k: "new", shape: "box", size: [15, 15, 15] }],
    ["cylinder d 20 h 30", { k: "new", shape: "cylinder", size: [20, 30] }],
    ["new cylinder 8x50", { k: "new", shape: "cylinder", size: [8, 50], join: false }],
    ["undo", { k: "undo" }],
  ])("%s", (text, want) => {
    expect(parse(text)).toMatchObject(want);
  });

  it.each([
    "make the wall thicker",
    "round the corners",
    "add a hole here",
    "shell it",
    "make a block",
    "fillet the edges where the boss meets the plate",
    "can you fillet 2?",
    "copy that",
    "thanks",
    "yes",
    "move 10",
    "turn on the motor",
    "remove the hole",
    "what material is it",
    "add a battery compartment",
    "rotate",
    "move on",
    "red is better",
    "design a phone stand",
  ])("not a plain command: %s", (text) => {
    expect(parse(text)).toBeNull();
  });
});

describe("applying commands to the source", () => {
  it("fillets the edges after the body and before later cuts", () => {
    const r = run("fillet 2", { target: "plate" });
    expect(r.src).toContain(`  body box(width, 30, 10)\n  fillet(2, edges: "all")\n  cut hole(M3`);
    expect(r.title).toBe("Filleted all the edges of plate (2 mm)");
  });

  it("sets a value in its own unit, and adds to it", () => {
    expect(run("wall 3").src).toContain("param wall = 3mm range 1 .. 5");
    expect(run("width +5").src).toContain("param width = 45mm");
    const r = run("wall 9");
    expect(r.detail).toMatch(/outside its usual range/);
  });

  it("moves a part by its at:, and keeps a written position", () => {
    const r = run("move lid 10 up");
    expect(r.src).toContain(`part lid {\n  at: (0, 0, 10)\n  label: "Top lid"`);
    expect(r.title).toBe("Moved Top lid 10 mm up");
    const again = applyQuick(parse("move 5 right")!, { ...ctx(), src: r.src, model: r.model, target: "lid" });
    expect(again.ok && again.src).toContain("at: (5, 0, 10)");
    const comp = run("move brg 5 left");
    expect(comp.src).toContain(`lib.bearing("608") { at: (55, 0, 0) }`);
  });

  it("turns a part where it is", () => {
    const r = run("rotate lid 90 about x");
    expect(r.src).toContain("rotate: (90, 0, 0)");
    // the lid's middle (0, 0, 21.5) stays put: turning it about X alone would swing it to (0, -21.5, 0)
    expect(r.src).toMatch(/at: \(0, 21\.5, 21\.5\)/);
    const back = applyQuick(parse("rotate lid -90 about x")!, { ...ctx(), src: r.src, model: r.model });
    expect(back.ok && back.src).not.toContain("rotate:");
  });

  it("composes turns in Kerf's rotate order", () => {
    // 90 about X, then 90 about Z
    expect(eulerOf([[0, 0, 1], [1, 0, 0], [0, 1, 0]])).toEqual([90, 0, 90]);
  });

  it("copies beside and deletes with the comment above", () => {
    const c = run("copy lid");
    expect(c.src).toContain("part lid2 {");
    expect(c.src).toContain(`part lid2 {\n  at: (50, 0, 0)\n  label: "Top lid"`);
    const d = run("delete lid");
    expect(d.src).not.toContain("part lid");
    expect(d.src).not.toContain("// the cover");
    expect(d.model.parts.map((p) => p.name)).toEqual(["plate", "brg"]);
  });

  it("leaves a referenced part to Claude", () => {
    const src = SRC + `part knob {\n  turns_with: plate\n  body cylinder(d: 10, h: 5)\n}\n`;
    const m = evaluate(src);
    const r = applyQuick({ k: "delete", target: "plate" }, { src, model: m });
    expect(r).toMatchObject({ ok: false, ai: true });
  });

  it("refuses library parts and locked values", () => {
    expect(applyQuick(parse("fillet 1 brg")!, ctx())).toMatchObject({ ok: false, ai: false });
    const src = SRC.replace(`"Wall"`, `"Wall" locked`);
    const r = applyQuick(parse("wall 3")!, { src, model: evaluate(src) });
    expect(r).toMatchObject({ ok: false, ai: false });
  });

  it("needs a part when none is pointed at", () => {
    expect(applyQuick(parse("fillet 2")!, ctx())).toMatchObject({ ok: false, ai: true });
  });

  it("drills where the user points, into the face", () => {
    const r = run("hole M3", { target: "lid", spot: { local: [5.2, -4.8, 23], normal: [0, 0, 1] } });
    expect(r.src).toContain("cut hole(M3, through: true, at: (5, -5, 23), dir: -Z)");
    const blind = run("hole 4 6 deep", { target: "plate", spot: { local: [20, 2, 5], normal: [1, 0, 0] } });
    expect(blind.src).toContain("cut hole(4, depth: 6, at: (20, 2, 5), dir: -X)");
  });

  it("adds a shape to the part pointed at, or as a new part", () => {
    const joined = run("box 10x10x5", { target: "lid", spot: { local: [0, 0, 23], normal: [0, 0, 1] } });
    expect(joined.src).toContain("  body box(40, 30, 3, at: (0, 0, 20))\n  add box(10, 10, 5, at: (0, 0, 23))");
    const side = run("box 10x10x6", { target: "plate", spot: { local: [20, 0, 5], normal: [1, 0, 0] } });
    expect(side.src).toContain("add box(10, 10, 6, at: (25, 0, 2))");
    const fresh = run("cylinder 10x20");
    expect(fresh.src).toMatch(/part cylinder1 \{\n {2}label: "Cylinder"\n {2}color: #[0-9a-f]{6}\n {2}body cylinder\(d: 10, h: 20, at: \(86, 0, 0\)\)\n\}/);
  });

  it("shells, opening the face pointed at", () => {
    const r = run("shell 1.5", { target: "plate", spot: { local: [0, 5, 10], normal: [0, 0, 1] } });
    expect(r.src).toContain("  body box(width, 30, 10)\n  shell(1.5, open: Z)\n  cut hole");
    const again = applyQuick(parse("shell 2 closed")!, { ...ctx(), src: r.src, model: r.model, target: "plate" });
    expect(again.ok && again.src).toContain("  shell(2)\n");
    expect(again.ok && again.src.match(/shell\(/g)?.length).toBe(1);
  });

  it("fillets the edge pointed at, or the edges of the face", () => {
    const edge = run("fillet 1", { target: "plate", spot: { local: [19, 14, 10], normal: [0, 0, 1], edge: { mid: [20, 0, 10], dist: 1 } } });
    expect(edge.src).toContain("fillet(1, edges: near((20, 0, 10), 0.2))");
    const face = run("chamfer 0.5", { target: "plate", spot: { local: [0, 5, 10], normal: [0, 0, 1], edge: { mid: [0, 15, 10], dist: 10 } } });
    expect(face.src).toContain("chamfer(0.5, edges: both(facing(Z), in_plane(Z, 10)))");
  });
});

describe("what quick commands write builds", () => {
  it("builds every kind of geometry edit", async () => {
    let src = SRC;
    const steps: [string, Partial<QuickContext>][] = [
      ["fillet 1 top", { target: "lid" }],
      ["fillet 1", { target: "plate", spot: { local: [19, 14, 10], normal: [0, 0, 1], edge: { mid: [20, 0, 10], dist: 1 } } }],
      ["chamfer 0.5", { target: "plate", spot: { local: [0, 5, 0], normal: [0, 0, -1], edge: { mid: [0, 15, 0], dist: 10 } } }],
      ["shell 1.5", { target: "lid", spot: { local: [0, 0, 20], normal: [0, 0, -1] } }],
      ["hole M3 insert", { target: "plate", spot: { local: [-12, 0, 10], normal: [0, 0, 1] } }],
      ["box 10x10x5", { target: "plate", spot: { local: [0, -15, 5], normal: [0, -1, 0] } }],
      ["rotate lid 30", {}],
      ["copy lid 60 back", {}],
    ];
    for (const [text, extra] of steps) {
      const m = evaluate(src);
      const r = applyQuick(parseQuick(text, vocabOf(m))!, { src, model: m, box: (b) => BOXES[b], ...extra });
      if (!r.ok) throw new Error(`${text}: ${r.why}`);
      src = r.src;
    }
    const { buildErrors, model: built } = await fullCheck(src);
    expect([...buildErrors.values()]).toEqual([]);
    expect(built.parts.map((p) => p.name)).toEqual(["plate", "lid", "lid2", "brg"]);
  }, 60_000);
});
