import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { buildPart, meshShape } from "../src/kernel/build";
import { inspectPart } from "../src/kernel/inspect";
import type { PartRecipe, ShapeRecipe } from "../src/kernel/recipe";

beforeAll(async () => {
  const wasm = new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url).pathname;
  const OC = await (opencascade as unknown as (o: { locateFile: () => string }) => Promise<unknown>)({ locateFile: () => wasm });
  R.setOC(OC as never);
}, 60_000);

const box = (w: number, d: number, h: number, at: [number, number, number] = [0, 0, 0], r = 0): ShapeRecipe => ({ t: "box", w, d, h, at, r });
const inspect = (p: PartRecipe) => {
  const shape = buildPart(p);
  return inspectPart(shape, meshShape(shape, "preview"));
};

describe("detail inspection", () => {
  it("finds every sharp edge of a plate and tells hole rims apart", () => {
    const r = inspect({ base: box(40, 20, 10), ops: [{ op: "cut", shape: { t: "hole", d: 6, depth: 10.2, at: [0, 0, 10.1], dir: [0, 0, -1] } }] });
    expect(r.sharp.count).toBe(14);
    expect(r.sharp.holeRims).toBe(2);
    expect(r.sharp.bossRims).toBe(0);
    expect(r.internal.count).toBe(0);
  });

  it("finds the internal corner of an L bracket", () => {
    const r = inspect({ base: box(40, 20, 5), ops: [{ op: "add", shape: box(5, 20, 30, [-17.5, 0, 0]) }] });
    expect(r.internal.count).toBe(1);
    expect(r.internal.top[0].length).toBeCloseTo(20, 1);
    expect(r.internal.top[0].at[2]).toBeCloseTo(5, 1);
  });

  it("counts fillets as blended, not sharp", () => {
    const plain = inspect({ base: box(40, 20, 10), ops: [] });
    const rounded = inspect({ base: box(40, 20, 10), ops: [{ op: "fillet", r: 2, edges: "vertical" }] });
    expect(plain.blended).toBe(0);
    expect(rounded.blended).toBeGreaterThanOrEqual(8);
    expect(rounded.sharp.length).toBeLessThan(plain.sharp.length);
  });

  it("calls a boss rim a boss, not a hole", () => {
    const r = inspect({ base: box(40, 40, 4), ops: [{ op: "add", shape: { t: "cyl", d: 8, h: 10, at: [0, 0, 4], dir: [0, 0, 1] } }] });
    expect(r.sharp.bossRims).toBe(1);
    expect(r.internal.count).toBe(1); // where the boss meets the plate
  });

  it("measures the walls of a shelled box", () => {
    const r = inspect({ base: box(40, 30, 20), ops: [{ op: "shell", t: 2, open: [0, 0, 1] }] });
    expect(r.walls).not.toBeNull();
    expect(r.walls!.min).toBeGreaterThan(1.8);
    expect(r.walls!.p5).toBeLessThan(2.2);
  });

  it("says which way up a mushroom prints without support", () => {
    const r = inspect({ base: box(10, 10, 20), ops: [{ op: "add", shape: box(30, 30, 4, [0, 0, 20]) }] });
    const asModelled = r.support.find((s) => s.down === "-Z")!;
    const flipped = r.support.find((s) => s.down === "+Z")!;
    expect(asModelled.area).toBeGreaterThan(700); // underside of the cap, minus the stem
    expect(flipped.area).toBe(0);
  });
});
