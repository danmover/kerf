// The standard CAD tools that work without Claude: the feature tree (edit,
// suppress, reorder, delete, roll back, pattern and mirror a step), part
// patterns, mirror images and cutting one part out of another, and the
// shape_of() function they are built on.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { applyQuick, type QuickCommand, type QuickContext, type Vec3 } from "../src/core/quickCommands";
import { deleteStep, designSteps, mirrorStep, moveStep, partSteps, patternStep, rollbackTo, setField, toggleSuppress, type StepEdit } from "../src/core/features";
import type { ShapeRecipe } from "../src/kernel/recipe";

const SRC = `design "Manual tools"
param wall = 2mm "Wall"

part plate {
  color: #4f7cff
  material: "PETG"
  body box(40, 30, 10, r: 3)
  shell(wall, open: Z)
  add cylinder(d: 8, h: 6, at: (10, 0, 2)) as boss
  fillet(1, edges: boss.root)
  cut hole(M3, through: true, at: (-12, 0, 10), dir: -Z)
}

part pin {
  color: #e0a84e
  body cylinder(d: 6, h: 20, at: (0, 0, 0))
  at: (25, 0, 0)
}
`;

const errors = (src: string) =>
  evaluate(src)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message);
const done = (r: StepEdit) => {
  if (!r.ok) throw new Error(r.why);
  expect(errors(r.src)).toEqual([]);
  return r.src;
};
const stepAt = (src: string, title: RegExp) => {
  const s = partSteps(src, "plate")!.steps.find((x) => title.test(x.title));
  if (!s)
    throw new Error(
      `no step like ${title}: ${partSteps(src, "plate")!
        .steps.map((x) => x.title)
        .join(" | ")}`,
    );
  return s;
};

describe("feature tree", () => {
  it("reads a part's steps in build order, with their values", () => {
    const steps = partSteps(SRC, "plate")!.steps;
    expect(steps.map((s) => s.title)).toEqual(["Box 40 × 30 × 10", "Shell wall · open Z", "Add cylinder ⌀8 × 6 (boss)", "Fillet 1 · boss.root", "Cut hole M3 through"]);
    expect(steps[0].editable).toBe(false);
    expect(steps[2].repeatable).toBe(true);
    const hole = steps[4];
    expect(hole.fields.map((f) => `${f.label}=${f.text}`)).toEqual(["d=M3", "through=true", "at=(-12, 0, 10)", "dir=-Z"]);
    const pin = partSteps(SRC, "pin")!.steps;
    expect(pin.map((s) => s.kind)).toEqual(["body", "place"]);
    expect(designSteps(SRC, evaluate(SRC)).map((p) => p.block)).toEqual(["plate", "pin"]);
  });

  it("changes a value by typing over it, and refuses text it can't read", () => {
    const hole = stepAt(SRC, /hole/);
    const src = done(setField(SRC, hole.fields[0], "M4"));
    expect(src).toContain("cut hole(M4, through: true");
    expect(setField(SRC, hole.fields[2], "(1, 2")).toMatchObject({ ok: false });
  });

  it("suppresses a step and brings it back exactly as it was", () => {
    const fillet = stepAt(SRC, /Fillet/);
    const off = done(toggleSuppress(SRC, "plate", fillet.index));
    expect(off).toContain("if false { fillet(1, edges: boss.root) }");
    expect(stepAt(off, /Fillet/).suppressed).toBe(true);
    const plate = evaluate(off).parts.find((p) => p.name === "plate")!;
    expect(plate.recipe.ops.some((o) => o.op === "fillet")).toBe(false);
    expect(done(toggleSuppress(off, "plate", fillet.index))).toBe(SRC);
    expect(toggleSuppress(SRC, "plate", stepAt(SRC, /Box/).index)).toMatchObject({ ok: false });
  });

  it("moves steps up and down, never above the body", () => {
    const hole = stepAt(SRC, /hole/);
    const up = done(moveStep(SRC, "plate", hole.index, -1));
    expect(partSteps(up, "plate")!.steps.map((s) => s.kind)).toEqual(["body", "modifier", "add", "cut", "modifier"]);
    const shell = stepAt(SRC, /Shell/);
    expect(moveStep(SRC, "plate", shell.index, -1)).toMatchObject({
      ok: false,
    });
    expect(moveStep(SRC, "plate", hole.index, 1)).toMatchObject({ ok: false });
  });

  it("deletes a step, but not one later steps use by name", () => {
    expect(deleteStep(SRC, "plate", stepAt(SRC, /boss\)/).index)).toMatchObject({ ok: false });
    const src = done(deleteStep(SRC, "plate", stepAt(SRC, /hole/).index));
    expect(src).not.toContain("hole(");
    expect(src).toContain("fillet(1, edges: boss.root)\n}");
  });

  it("rolls a part back to a step by suppressing everything after it", () => {
    const src = rollbackTo(SRC, "plate", stepAt(SRC, /Shell/).index)!;
    expect(errors(src)).toEqual([]);
    const plate = evaluate(src).parts.find((p) => p.name === "plate")!;
    expect(plate.recipe.ops.map((o) => o.op)).toEqual(["shell"]);
  });

  it("patterns a step in a row and round an axis, and the pattern stays editable", () => {
    const hole = stepAt(SRC, /hole/);
    const row = done(
      patternStep(SRC, "plate", hole.index, {
        kind: "line",
        count: 3,
        step: [0, 8, 0],
      }),
    );
    expect(row).toContain("for i in range(3) { cut move(hole(M3, through: true, at: (-12, 0, 10), dir: -Z), by: (0, i * 8, 0)) }");
    const cuts = evaluate(row)
      .parts.find((p) => p.name === "plate")!
      .recipe.ops.filter((o) => o.op === "cut");
    expect(cuts).toHaveLength(3);
    const step = stepAt(row, /× 3 in a row/);
    expect(step.kind).toBe("repeat");
    expect(step.fields[0]).toMatchObject({ label: "count", text: "3" });
    expect(step.fields.some((f) => f.label === "at")).toBe(true);
    expect(done(setField(row, step.fields[0], "5"))).toContain("range(5)");

    const round = done(
      patternStep(SRC, "plate", hole.index, {
        kind: "round",
        count: 4,
        angle: 360,
        axis: "Z",
        center: [0, 0, 0],
      }),
    );
    expect(round).toContain("rotate(hole(M3, through: true, at: (-12, 0, 10), dir: -Z), i * 90, axis: Z, origin: (0, 0, 0))");
    expect(stepAt(round, /× 4 round/)).toBeTruthy();
    expect(
      patternStep(SRC, "plate", stepAt(SRC, /Fillet/).index, {
        kind: "line",
        count: 3,
        step: [1, 0, 0],
      }),
    ).toMatchObject({ ok: false });
  });

  it("mirrors a step across a plane, linked to the original", () => {
    const src = done(mirrorStep(SRC, "plate", stepAt(SRC, /hole/).index, "X"));
    expect(src).toMatch(/let hole_1 = hole\(M3, through: true, at: \(-12, 0, 10\), dir: -Z\)\n {2}cut \[hole_1, mirror\(hole_1, normal: X, at: \(0, 0, 0\)\)\]/);
    const cut = evaluate(src)
      .parts.find((p) => p.name === "plate")!
      .recipe.ops.filter((o) => o.op === "cut");
    expect(cut).toHaveLength(2);
  });
});

describe("shape_of", () => {
  it("is another part where it sits, brought into the using part's frame", () => {
    // the pin has to come first
    const src = SRC.replace("  cut hole(M3", "  cut shape_of(pin)\n  cut hole(M3");
    expect(errors(src)[0]).toMatch(/pin/);
    const ok = `${SRC}
part block {
  body box(20, 20, 20)
  at: (20, 0, 0)
  cut shape_of(pin)
}
`;
    expect(errors(ok)).toEqual([]);
    const block = evaluate(ok).parts.find((p) => p.name === "block")!;
    const cut = block.recipe.ops.find((o) => o.op === "cut") as {
      shape: Extract<ShapeRecipe, { t: "part" }>;
    };
    expect(cut.shape.t).toBe("part");
    expect(cut.shape.xf).toEqual([{ op: "translate", v: [25, 0, 0] }]);
    expect(cut.shape.into).toEqual([{ op: "translate", v: [-20, -0, -0] }]);
  });

  it("follows its source: a change to the source changes the copy's recipe", () => {
    const a = `${SRC}\npart other { body mirror(shape_of(pin), normal: X) }\n`;
    const b = a.replace("cylinder(d: 6, h: 20", "cylinder(d: 7, h: 20");
    const hash = (s: string) => evaluate(s).parts.find((p) => p.name === "other")!.hash;
    expect(hash(a)).not.toBe(hash(b));
  });
});

describe("part tools", () => {
  const model = evaluate(SRC);
  const BOXES: Record<string, [Vec3, Vec3]> = {
    plate: [
      [-20, -15, 0],
      [20, 15, 10],
    ],
    pin: [
      [-3, -3, 0],
      [3, 3, 20],
    ],
  };
  const ctx = (src = SRC): QuickContext => ({
    src,
    model: evaluate(src),
    box: (b) => BOXES[b],
    bounds: [
      [-20, -15, 0],
      [28, 15, 20],
    ],
  });
  const run = (cmd: QuickCommand, src = SRC) => {
    const r = applyQuick(cmd, ctx(src));
    if (!r.ok) throw new Error(r.why);
    expect(errors(r.src)).toEqual([]);
    return { ...r, model: evaluate(r.src) };
  };

  it("patterns a part in a row", () => {
    const r = run({ k: "pattern", count: 3, step: [0, 10, 0], target: "pin" });
    const pins = r.model.parts.filter((p) => /^pin/.test(p.name));
    expect(pins.map((p) => p.xf.at(-1))).toEqual([
      { op: "translate", v: [25, 0, 0] },
      { op: "translate", v: [25, 10, 0] },
      { op: "translate", v: [25, 20, 0] },
    ]);
    expect(model.parts).toHaveLength(2);
  });

  it("patterns a part round an axis, turning each copy", () => {
    const r = run({
      k: "pattern",
      count: 4,
      angle: 360,
      axis: 2,
      center: [0, 0, 0],
      target: "pin",
    });
    expect(r.src).toContain("part pin2 {");
    const p2 = r.model.parts.find((p) => p.name === "pin2")!;
    expect(p2.xf).toEqual([
      { op: "rotate", angle: 90, origin: [0, 0, 0], axis: [0, 0, 1] },
      { op: "translate", v: [0, 25, 0] },
    ]);
    const p3 = r.model.parts.find((p) => p.name === "pin3")!;
    expect(p3.xf.at(-1)).toEqual({ op: "translate", v: [-25, 0, 0] });
  });

  it("mirrors a part as a new part that follows it and stays put", () => {
    const r = run({ k: "mirror", axis: 0, target: "pin" });
    expect(r.src).toContain("body mirror(shape_of(pin), normal: X, at: (0, 0, 0))");
    const m = r.model.parts.find((p) => p.name === "pin_mirror1")!;
    expect(m.label).toBe("pin (mirrored)");
    expect(m.color).toBe("#e0a84e");
    const moved = applyQuick({ k: "move", by: [5, 0, 0], target: "pin_mirror1" }, ctx(r.src));
    expect(moved).toMatchObject({ ok: false });
    expect(applyQuick({ k: "mirror", axis: 0, target: "pin_mirror1" }, ctx(r.src))).toMatchObject({ ok: false });
  });

  it("cuts one part out of another, moving the cut part after its tool", () => {
    const r = run({ k: "subtract", tool: "pin", target: "plate" });
    expect(r.src.indexOf("part pin")).toBeLessThan(r.src.indexOf("part plate"));
    expect(r.src).toContain("  cut shape_of(pin)\n}");
    expect(applyQuick({ k: "subtract", tool: "plate", target: "plate" }, ctx())).toMatchObject({ ok: false });
  });
});
