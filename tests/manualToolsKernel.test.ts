// shape_of() in the kernel: a pocket cut by another part lands where that
// part really is, and a mirror image has the same volume as its source.

import { beforeAll, describe, expect, it } from "vitest";
import { loadOC } from "./occt";
import { buildPart, solidVolume } from "../src/kernel/build";
import { evaluate } from "../src/lang/evaluator";

beforeAll(loadOC, 60000);

const SRC = `design "shape_of"
part pin {
  body cylinder(d: 6, h: 30, at: (0, 0, -5))
  at: (25, 0, 0)
}
part block {
  body box(20, 20, 20)
  at: (20, 0, 0)
  cut shape_of(pin)
}
part pin_mirror {
  body mirror(shape_of(pin), normal: X)
}
`;

describe("shape_of in the kernel", () => {
  it("cuts where the other part sits, and mirrors it whole", () => {
    const m = evaluate(SRC);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const part = (n: string) => m.parts.find((p) => p.name === n)!;
    const block = buildPart(part("block").recipe);
    // the pin passes right through the block 5 mm off its centre: a full ⌀6 bore 20 mm long
    expect(solidVolume(block)).toBeCloseTo(20 * 20 * 20 - Math.PI * 9 * 20, 0);
    const bb = block.boundingBox.bounds;
    expect(bb[0][0]).toBeCloseTo(-10, 3);
    const mirror = buildPart(part("pin_mirror").recipe);
    expect(solidVolume(mirror)).toBeCloseTo(Math.PI * 9 * 30, 0);
    expect(mirror.boundingBox.center[0]).toBeCloseTo(-25, 3);
  });
});
