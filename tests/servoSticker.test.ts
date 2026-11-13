// Bought parts drawn as they look: the 3D view prints a servo's real label on the sticker its solid model carries
// on each side of the middle case (and hides the model's stand-in bars), and a bar load cell is matte, bead-blasted
// aluminium rather than a mirror.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { catalogPart } from "../src/machine/catalog";
import { servoStickerBox } from "../src/machine/geometry";
import { PartDetailDecorator } from "../src/ui/viewport/parts/decorate";
import type { ShapeRecipe } from "../src/kernel/recipe";

const model = (line: string) => {
  const m = evaluate(`design "t"\n${line}\n`);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return m;
};

describe("a servo's sticker", () => {
  for (const id of ["mg90d", "sg90", "mg90s"]) {
    it(`prints ${id}'s label where its sticker is, in place of the bars`, () => {
      const m = model(`component s = lib.servo("${id}") { at: (0, 0, 40) }`);
      const main = m.parts.find((p) => p.id === "s")!;
      const box = servoStickerBox(catalogPart(id)!.geom.dims as Record<string, number>)!;
      expect(box).not.toBeNull();
      // the decorator recognises the case and plans the printed label
      expect(new PartDetailDecorator().key(main)).toBe(`servo:${id}`);
      // the sticker plates sit where the label is printed: the box's height, from its bottom up
      const plate = m.parts.find((p) => p.id === "s.label")!;
      const shapes = (plate.recipe.base as Extract<ShapeRecipe, { t: "union" }>).shapes as Extract<ShapeRecipe, { t: "box" }>[];
      expect(shapes).toHaveLength(2);
      for (const s of shapes) {
        expect(s.h).toBeCloseTo(box.h, 6);
        expect(s.at![2]).toBeCloseTo(box.z0, 6);
        expect(s.at![0]).toBeCloseTo(box.x, 6);
      }
      // the stand-in bars the printed label hides
      expect(m.parts.some((p) => p.id === "s.label_text")).toBe(true);
    });
  }
});

describe("a bar load cell", () => {
  it("is bead-blasted aluminium", () => {
    const m = model(`component c = lib.sensor("beam_cell_1kg") { at: (0, 0, 20) }`);
    const main = m.parts.find((p) => p.id === "c")!;
    expect(main.material).toBe("Aluminum 6061");
    expect(main.finish).toBe("bead-blasted");
  });
});
