// What the sketch editor's centre rectangle, 3-point rectangle and polygon tools write: the shapes stay what they
// are when their sizes change, and solve fully once dimensioned.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { EvalSketch } from "../src/sketch/types";

const sketchOf = (body: string): EvalSketch => {
  const m = evaluate(`design "t"\n${body}\n`);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return m.sketches[0];
};
const at = (sk: EvalSketch, id: string) => {
  const p = sk.points.find((q) => q.id === id || sk.aliases[id] === q.id)!;
  return [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000];
};

describe("sketch tools", () => {
  it("keeps a centre rectangle centred on the origin", () => {
    const sk = sketchOf(`sketch s {
  line l1 = (-20, -10) -> (20, -10)
  line l2 = l1.end -> (20, 10)
  line l3 = l2.end -> (-20, 10)
  line l4 = l3.end -> l1.start
  horizontal l1, l3
  vertical l2, l4
  symmetric l1.start, l2.end, origin
  length l1 = 50
  length l2 = 30
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(at(sk, "l1.start")).toEqual([-25, -15]);
    expect(at(sk, "l2.end")).toEqual([25, 15]);
  });

  it("keeps a 3-point rectangle square at any angle", () => {
    const sk = sketchOf(`sketch s {
  line l1 = (0, 0) -> (30, 17.32)
  line l2 = l1.end -> (25, 26)
  line l3 = l2.end -> (-5, 8.66)
  line l4 = l3.end -> l1.start
  perpendicular l1, l2
  parallel l1, l3
  parallel l2, l4
  coincident l1.start, origin
  length l1 = 40
  length l2 = 10
  angle x_axis, l1 = 30
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    const [x, y] = at(sk, "l2.end");
    expect(x).toBeCloseTo(40 * Math.cos(Math.PI / 6) - 10 * Math.sin(Math.PI / 6), 2);
    expect(y).toBeCloseTo(40 * Math.sin(Math.PI / 6) + 10 * Math.cos(Math.PI / 6), 2);
    expect(sk.profile.regions).toHaveLength(1);
  });

  it("keeps a polygon regular: one size across the corners sets every side", () => {
    const sk = sketchOf(`sketch s {
  construction circle c1 = origin, d: 20
  line l1 = (10, 0) -> (5, 8.66)
  line l2 = l1.end -> (-5, 8.66)
  line l3 = l2.end -> (-10, 0)
  line l4 = l3.end -> (-5, -8.66)
  line l5 = l4.end -> (5, -8.66)
  line l6 = l5.end -> l1.start
  coincident l1.start, c1
  coincident l2.start, c1
  coincident l3.start, c1
  coincident l4.start, c1
  coincident l5.start, c1
  coincident l6.start, c1
  equal l1, l2, l3, l4, l5, l6
  horizontal c1.center, l1.start
  diameter c1 = 30
}`);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    for (const l of ["l1", "l2", "l3", "l4", "l5", "l6"]) {
      const c = sk.curves.find((q) => q.id === l)!;
      const [a, b] = c.pts.map((id) => at(sk, id));
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(15, 3);
    }
    expect(sk.profile.regions).toHaveLength(1);
  });
});
