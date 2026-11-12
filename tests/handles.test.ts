// Drag handles: which sizes of a part's body can be pulled from the model,
// where their arrows sit, and what the source becomes when one is dragged or
// typed: a number rewritten in place, a parameter moved, an expression left
// alone.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { draggedValue, profileCentre, sizeHandles } from "../src/core/handles";

const SRC = `design "Handles"
param wall = 3mm range 1 .. 6 "Wall"
param len = 50mm "Length"

part block {
  body box(40, 30mm, 20, at: (5, 0, 0))
  at: (100, 0, 0)
}

part peg {
  body cylinder(d: 8, h: len)
}

part rod {
  body cylinder(r: 4, h: wall * 4, dir: X)
}

part plate {
  body box(60, 40, wall, center: true)
}

part bought {
  body box(10, 10, 10)
  locked
}
`;

const model = evaluate(SRC);
const part = (name: string) => model.parts.find((p) => p.name === name)!;
const of = (name: string) => Object.fromEntries(sizeHandles(SRC, model, part(name)).map((h) => [h.label, h]));
const errors = (src: string) =>
  evaluate(src)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message);

describe("drag handles", () => {
  it("puts arrows on a box's sides and top, in the part's own coordinates", () => {
    expect(errors(SRC)).toEqual([]);
    const h = of("block");
    expect(Object.keys(h)).toEqual(["w", "d", "h"]);
    expect(h.w).toMatchObject({ value: 40, at: [25, 0, 10], dir: [1, 0, 0], rate: 2, back: [-15, 0, 10] });
    expect(h.d).toMatchObject({ value: 30, at: [5, 15, 10], dir: [0, 1, 0], rate: 2 });
    // the bottom stays put: the top moves by what the height grows
    expect(h.h).toMatchObject({ value: 20, at: [5, 0, 20], dir: [0, 0, 1], rate: 1 });
    expect(h.h.back).toBeUndefined();
  });

  it("rewrites a number in place, keeping its unit", () => {
    const h = of("block");
    const wider = h.w.write!(SRC, 46);
    expect(wider).toContain("body box(46, 30mm, 20, at: (5, 0, 0))");
    const deeper = h.d.write!(SRC, 32.5);
    expect(deeper).toContain("body box(40, 32.5mm, 20");
    expect(errors(deeper)).toEqual([]);
    const after = evaluate(deeper).parts.find((p) => p.name === "block")!.recipe.base;
    expect(after).toMatchObject({ t: "box", d: 32.5 });
  });

  it("moves the parameter a size comes from, within its limits", () => {
    const h = of("peg");
    expect(h.h).toMatchObject({ value: 50, via: "len", rate: 1, at: [0, 0, 50] });
    const longer = h.h.write!(SRC, 65);
    expect(longer).toContain('param len = 65mm "Length"');
    expect(longer).toContain("body cylinder(d: 8, h: len)");
    expect(h.d).toMatchObject({ value: 8, rate: 2, at: [4, 0, 25], back: [-4, 0, 25] });
    // a plate as thick as the wall parameter: limited to what the parameter allows, and centred so it grows both ways
    const p = of("plate");
    expect(p.h).toMatchObject({ value: 3, via: "wall", min: 1, max: 6, rate: 2, at: [0, 0, 1.5], back: [0, 0, -1.5] });
    expect(draggedValue(p.h, 3, 10, 0.5)).toBe(6);
    expect(draggedValue(p.h, 3, -10, 0.5)).toBe(1);
  });

  it("shows a size worked out from an expression without letting it be dragged", () => {
    const h = of("rod");
    // r: is dragged as a radius; the length along X comes from wall * 4
    expect(h.r).toMatchObject({ value: 4, rate: 1 });
    expect(h.r.write).not.toBeNull();
    expect(h.h).toMatchObject({ value: 12, write: null, dir: [1, 0, 0], at: [12, 0, 0] });
    expect(h.h.why).toMatch(/wall \* 4/);
    expect(h.r.write!(SRC, 5)).toContain("body cylinder(r: 5, h: wall * 4, dir: X)");
  });

  it("offers nothing on a locked part", () => {
    expect(sizeHandles(SRC, model, part("bought"))).toEqual([]);
  });

  it("snaps a dragged value to the step and keeps it positive", () => {
    const h = of("block").w;
    // the face moved 3.3 mm: a centred width grows by twice that
    expect(draggedValue(h, 40, 3.3, 1)).toBe(47);
    expect(draggedValue(h, 40, 3.3, 0.5)).toBe(46.5);
    expect(draggedValue(h, 40, -30, 1)).toBe(0.1);
  });

  it("finds the middle of a profile for an extrusion's arrow", () => {
    expect(profileCentre({ t: "rect", w: 10, h: 4, r: 0, c: [3, 2] })).toEqual([3, 2]);
    expect(profileCentre({ t: "poly", pts: [[0, 0], [4, 0], [4, 2], [0, 2]], r: 0 })).toEqual([2, 1]);
    expect(profileCentre({ t: "place2", p: { t: "circle", d: 4, c: [1, 0] }, rot: 90, by: [10, 0] })[1]).toBeCloseTo(1);
  });

  it("puts an arrow on an extrusion's far face", () => {
    const src = `design "E"
part bar {
  body extrude(rect(20, 10), 15)
}
`;
    const m = evaluate(src);
    expect(errors(src)).toEqual([]);
    const h = sizeHandles(src, m, m.parts[0]);
    expect(h.map((x) => x.label)).toEqual(["h"]);
    expect(h[0]).toMatchObject({ value: 15, rate: 1, dir: [0, 0, 1] });
    expect(h[0].at[2]).toBeCloseTo(15);
    expect(h[0].write!(src, 18)).toContain("extrude(rect(20, 10), 18)");
  });
});
