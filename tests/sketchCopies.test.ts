// Sketch mirror, pattern and offset: copies that stay tied to the original as it changes, solve fully defined,
// and close into profiles.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { EvalSketch } from "../src/sketch/types";

const run = (body: string) => evaluate(`design "t"\n${body}\n`);
const sketchOf = (body: string): EvalSketch => {
  const m = run(body);
  // no errors, and no warnings either (a redundant constraint is a warning)
  expect(m.diagnostics.map((d) => d.message)).toEqual([]);
  return m.sketches[0];
};
const errorsOf = (body: string) =>
  run(body)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message)
    .join("\n");
const at = (sk: EvalSketch, id: string) => {
  const p = sk.points.find((q) => q.id === id || sk.aliases[id] === q.id);
  if (!p) throw new Error(`no point ${id}`);
  return [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000];
};
const radiusOf = (sk: EvalSketch, id: string) => {
  const c = sk.curves.find((q) => q.id === id)!;
  if (c.kind === "circle") return Math.round(c.r! * 1000) / 1000;
  const [a, , cc] = c.pts.map((p) => at(sk, p));
  return Math.round(Math.hypot(a[0] - cc[0], a[1] - cc[1]) * 1000) / 1000;
};

// half a bottle shape, right of the y axis, closed by mirroring it across
const HALF = `sketch s {
  line l1 = (0, 0) -> (20, 0)
  line l2 = l1.end -> (20, 40)
  line l3 = l2.end -> (8, 52)
  line l4 = l3.end -> (8, 60)
  line l5 = l4.end -> (0, 60)
  mirror l1, l2, l3, l4, l5, about: y_axis
  coincident l1.start, origin
  horizontal l1, l5
  vertical l2, l4
  coincident l5.end, y_axis
  length l1 = w / 2
  length l2 = 40
  length l4 = 8
  hdistance l3.end, l2.end = 12
  vdistance l2.end, l3.end = 12
}`;

describe("mirror", () => {
  it("mirrors a half profile into a closed whole that follows the original", () => {
    const sk = sketchOf(`param w = 40\n${HALF}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(at(sk, "l2_m.end")).toEqual([-20, 40]);
    expect(at(sk, "l3_m.end")).toEqual([-8, 52]);
    expect(sk.profile.regions.length).toBe(1);
    expect(sk.profile.area).toBeCloseTo(2 * (20 * 40 + ((20 + 8) / 2) * 12 + 8 * 8), 3);
    const wide = sketchOf(`param w = 50\n${HALF}`);
    expect(at(wide, "l2_m.end")).toEqual([-25, 40]);
    // the copies are linked: one statement, listed with what it made
    const m = sk.constraints.find((c) => c.kind === "mirror")!;
    expect(m.made).toEqual(["l1_m", "l2_m", "l3_m", "l4_m", "l5_m"]);
    expect(sk.curves.find((c) => c.id === "l3_m")!.derived).toBe(m.index);
  });

  it("flips arcs, and later geometry and constraints can use the copies", () => {
    const sk = sketchOf(`sketch s {
  arc a1 = (10, 0) -> (0, 10), center: (0, 0)
  mirror a1, about: y_axis
  line l1 = a1_m.end -> (-10, -5)
  radius a1 = 10
  coincident a1.center, origin
  horizontal a1.center, a1.start
  vertical a1.center, a1.end
  vertical l1
  length l1 = 5
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    // anticlockwise from the mirrored end to the mirrored start
    expect(at(sk, "a1_m.start")).toEqual([0, 10]);
    expect(at(sk, "a1_m.end")).toEqual([-10, 0]);
    expect(at(sk, "l1.end")).toEqual([-10, -5]);
    expect(radiusOf(sk, "a1_m")).toBe(10);
  });

  it("says what is wrong", () => {
    expect(errorsOf(`sketch s {\n  line l1 = (0, 0) -> (5, 5)\n  mirror l1\n}`)).toMatch(/needs about:/);
    expect(errorsOf(`sketch s {\n  line l1 = (0, 0) -> (5, 5)\n  circle c1 = (3, 3), r: 1\n  mirror l1, about: c1\n}`)).toMatch(/about: should be a line/);
    expect(errorsOf(`sketch s {\n  line l1 = (0, 0) -> (5, 5)\n  mirror l1, abut: y_axis\n}`)).toMatch(/did you mean "about:"/);
    expect(errorsOf(`sketch s {\n  line l1 = (0, 0) -> (5, 5)\n  horizontal l1, about: y_axis\n}`)).toMatch(/does not take named options/);
    expect(errorsOf(`sketch s {\n  line l1 = (0, 0) -> (5, 5)\n  mirror l1.end, about: y_axis\n}`)).toMatch(/l1\.end belongs to a curve/);
    expect(errorsOf(`sketch s {\n  line l1 = (0, 0) -> (5, 5)\n  mirror origin, about: l1\n}`)).toMatch(/origin stays where it is/);
  });
});

describe("pattern", () => {
  it("makes a row and a grid of holes that follow the first one", () => {
    const sk = sketchOf(`sketch s {
  circle c1 = (5, 5), d: 4
  pattern c1, count: 4, step: (12, 0), count2: 2, step2: (0, 10)
  coincident c1.center, origin
  diameter c1 = 3
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(sk.curves.filter((c) => c.kind === "circle").length).toBe(8);
    expect(at(sk, "c1_4.center")).toEqual([36, 0]);
    expect(at(sk, "c1_8.center")).toEqual([36, 10]);
    expect(radiusOf(sk, "c1_6")).toBe(1.5);
    expect(sk.profile.regions.length).toBe(8);
  });

  it("spreads copies round a point, over a full turn or part of one", () => {
    const sk = sketchOf(`sketch s {
  circle c0 = (0, 0), d: 40
  circle h1 = (15, 0), d: 4
  pattern h1, count: 6, around: c0
  coincident c0.center, origin
  horizontal c0.center, h1.center
  distance c0.center, h1.center = 15
  diameter h1 = 4
  diameter c0 = 40
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(at(sk, "h1_2.center")).toEqual([7.5, 12.99]);
    expect(at(sk, "h1_4.center")).toEqual([-15, 0]);
    // the bolt circle holes become holes in the disc
    expect(sk.profile.regions.length).toBe(1);
    expect(sk.profile.regions[0].holes.length).toBe(6);
    const fan = sketchOf(`sketch s {
  line l1 = (10, 0) -> (20, 0)
  pattern l1, count: 3, around: origin, angle: 90
}`);
    expect(at(fan, "l1_3.end")).toEqual([0, 20]);
    expect(at(fan, "l1_2.start")).toEqual([7.071, 7.071]);
  });

  it("copies a joined outline with its corners still joined", () => {
    const sk = sketchOf(`sketch s {
  line l1 = (0, 0) -> (6, 0)
  line l2 = l1.end -> (6, 4)
  line l3 = l2.end -> (0, 4)
  line l4 = l3.end -> l1.start
  pattern l1, l2, l3, l4, count: 3, step: (10, 0)
}`);
    expect(sk.profile.regions.length).toBe(3);
    expect(sk.aliases["l2_3.start"]).toBe("l1_3.end");
  });

  it("says what is wrong", () => {
    const c = `sketch s {\n  circle c1 = (0, 0), d: 4\n`;
    expect(errorsOf(`${c}  pattern c1, count: 3\n}`)).toMatch(/needs step:/);
    expect(errorsOf(`${c}  pattern c1, count: 1, step: (5, 0)\n}`)).toMatch(/whole number from 2/);
    expect(errorsOf(`${c}  pattern c1, count: 3, step: (0, 0)\n}`)).toMatch(/can't be \(0, 0\)/);
    expect(errorsOf(`${c}  pattern c1, count: 3, step: (5, 0), around: origin\n}`)).toMatch(/not both/);
    expect(errorsOf(`${c}  pattern c1, count: 3, step: (5, 0), count2: 2\n}`)).toMatch(/go together/);
    expect(errorsOf(`${c}  circle c1_2 = (9, 9), d: 1\n  pattern c1, count: 3, step: (5, 0)\n}`)).toMatch(/already used/);
  });
});

describe("offset", () => {
  it("offsets a rectangle outward and inward, fully defined, and keeps up when it is resized", () => {
    const rect = (by: string, w = 40) => `sketch s {
  line l1 = (0, 0) -> (${w}, 0)
  line l2 = l1.end -> (${w}, 20)
  line l3 = l2.end -> (0, 20)
  line l4 = l3.end -> l1.start
  offset l1, l2, l3, l4, by: ${by}
  coincident l1.start, origin
  horizontal l1, l3
  vertical l2, l4
  length l1 = ${w}
  length l2 = 20
}`;
    const out = sketchOf(rect("2"));
    expect(out.solved).toBe(true);
    expect(out.dof).toBe(0);
    expect(at(out, "l1_o.start")).toEqual([-2, -2]);
    expect(at(out, "l2_o.end")).toEqual([42, 22]);
    // the band between them is one region with a hole
    expect(out.profile.regions.length).toBe(1);
    expect(out.profile.area).toBeCloseTo(44 * 24 - 40 * 20, 3);
    const inside = sketchOf(rect("-3", 50));
    expect(at(inside, "l1_o.start")).toEqual([3, 3]);
    expect(at(inside, "l3_o.start")).toEqual([47, 17]);
    expect(inside.dof).toBe(0);
  });

  it("offsets a slot round its ends, and a circle", () => {
    const sk = sketchOf(`sketch s {
  line l1 = (0, -5) -> (30, -5)
  arc a1 = l1.end -> (30, 5), center: (30, 0)
  line l2 = a1.end -> (0, 5)
  arc a2 = l2.end -> l1.start, center: (0, 0)
  offset l1, a1, l2, a2, by: 2
  circle c1 = (15, 0), d: 4
  offset c1, by: -0.5
  tangent l1, a1
  tangent a1, l2
  tangent l2, a2
  tangent a2, l1
  coincident a2.center, origin
  horizontal a2.center, a1.center
  distance a2.center, a1.center = 30
  radius a1 = 5
  equal a1, a2
  hdistance origin, c1.center = 15
  vdistance origin, c1.center = 0
  diameter c1 = 4
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(sk.redundant).toBe(0);
    expect(radiusOf(sk, "a1_o")).toBe(7);
    expect(radiusOf(sk, "a2_o")).toBe(7);
    expect(at(sk, "l1_o.start")).toEqual([0, -7]);
    expect(at(sk, "a1_o.end")).toEqual([30, 7]);
    expect(radiusOf(sk, "c1_o")).toBe(1.5);
    expect(sk.aliases["c1_o.center"]).toBe("c1.center");
  });

  it("offsets an open chain to the left of the way it runs, ends held opposite the original's", () => {
    const sk = sketchOf(`sketch s {
  construction line l1 = (0, 0) -> (20, 0)
  construction line l2 = l1.end -> (20, 10)
  offset l1, l2, by: 3
  coincident l1.start, origin
  horizontal l1
  vertical l2
  length l1 = 20
  length l2 = 10
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(at(sk, "l1_o.start")).toEqual([0, 3]);
    expect(at(sk, "l1_o.end")).toEqual([17, 3]);
    expect(at(sk, "l2_o.end")).toEqual([17, 10]);
    expect(sk.curves.find((c) => c.id === "l2_o")!.construction).toBe(true);
  });

  it("says what is wrong", () => {
    const sq = `sketch s {\n  line l1 = (0, 0) -> (10, 0)\n  line l2 = l1.end -> (10, 10)\n  line l3 = (30, 0) -> (40, 0)\n  circle c1 = (50, 50), r: 2\n`;
    expect(errorsOf(`${sq}  offset l1, l3, by: 1\n}`)).toMatch(/don't join into one chain/);
    expect(errorsOf(`${sq}  offset c1, by: -3\n}`)).toMatch(/shrink c1/);
    expect(errorsOf(`${sq}  offset l1, l2\n}`)).toMatch(/needs by:/);
    expect(errorsOf(`${sq}  offset l1, c1, by: 1\n}`)).toMatch(/one circle on its own/);
  });
});
