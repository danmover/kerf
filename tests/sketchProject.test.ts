// Projecting a part's face into a sketch: the edges come in as fixed lines, arcs and circles that join up,
// so the sketch still solves, has a closed profile and new geometry can be dimensioned from them.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { OutlineEdge } from "../src/kernel/protocol";
import type { V3 } from "../src/kernel/recipe";
import { addStatements } from "../src/sketch/edits";
import { projectEdges } from "../src/sketch/project";
import type { EvalSketch } from "../src/sketch/types";

const sketchIn = (src: string): EvalSketch => {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return m.sketches[0];
};

// points along a circle in the plane z = h, from angle a0 to a1 (degrees)
const around = (c: [number, number], r: number, a0: number, a1: number, h: number, n = 5): V3[] =>
  Array.from({ length: n }, (_, k) => {
    const t = ((a0 + ((a1 - a0) * k) / (n - 1)) * Math.PI) / 180;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t), h];
  });

// the top face of a 40 long slot, 12 wide, with a 5 mm hole in it, at z = 8, edges in the order OCC might give them
const SLOT: OutlineEdge[] = [
  { kind: "line", pts: [[0, -6, 8], [40, -6, 8]] },
  { kind: "circle", pts: around([40, 0], 6, -90, 90, 8) },
  { kind: "line", pts: [[40, 6, 8], [0, 6, 8]] },
  // this end runs clockwise as OCC walks it
  { kind: "circle", pts: around([0, 0], 6, 270, 90, 8) },
  { kind: "circle", pts: around([20, 0], 2.5, 0, 360, 8) },
];

describe("project a face", () => {
  it("brings a slot with a hole in as fixed lines, arcs and a circle that close into a profile", () => {
    const src = `design "t"\nsketch s {\n  plane: XY\n  offset: 8\n  point p1 = (60, 0)\n}\n`;
    const sk = sketchIn(src);
    const r = projectEdges(sk, SLOT, (p) => p, "the top of slot");
    expect(r.curves).toBe(5);
    expect(r.geometry.join("\n")).toMatch(/arc a1 = l1\.end -> \(40, 6\), center: \(40, 0\)/);
    // the clockwise end still writes an anticlockwise arc, from (0, 6) round to (0, -6), joining both lines
    expect(r.geometry.join("\n")).toMatch(/arc a2 = l2\.end -> l1\.start, center: \(0, 0\)/);
    expect(r.geometry.join("\n")).toMatch(/circle c1 = \(20, 0\), r: 2\.5/);
    const out = addStatements(src, sk, r);
    const after = sketchIn(out);
    expect(after.solved).toBe(true);
    expect(after.redundant).toBe(0);
    for (const c of after.curves.filter((q) => q.id !== "p1")) expect(c.status).toBe("fixed");
    expect(after.profile.error).toBeUndefined();
    expect(after.profile.fills.length).toBe(1);
    expect(after.profile.fills[0].holes.length).toBe(1);
  });

  it("follows the part's placement and the sketch plane, and turns a tilted circle into straight pieces", () => {
    // a sketch on the front plane (x across, z up); the part is moved 100 along y, which the plane looks along
    const src = `design "t"\nsketch s {\n  plane: XZ\n}\n`;
    const sk = sketchIn(src);
    const tilted: OutlineEdge[] = [{ kind: "circle", pts: Array.from({ length: 5 }, (_, k): V3 => {
      const t = (k / 4) * 2 * Math.PI;
      // a circle in a plane at 45° to the sketch: seen square on it is an ellipse
      return [10 * Math.cos(t), 10 * Math.sin(t) * Math.SQRT1_2, 10 * Math.sin(t) * Math.SQRT1_2];
    }) }];
    const square: OutlineEdge[] = [
      { kind: "line", pts: [[0, 0, 0], [10, 0, 0]] },
      { kind: "line", pts: [[10, 0, 0], [10, 0, 5]] },
      { kind: "line", pts: [[10, 0, 5], [0, 0, 5]] },
      { kind: "line", pts: [[0, 0, 5], [0, 0, 0]] },
    ];
    const r = projectEdges(sk, square, (p) => [p[0] + 3, p[1] + 100, p[2]], "a face");
    expect(r.geometry.join("\n")).toContain("line l1 = (3, 0) -> (13, 0)");
    expect(r.geometry.join("\n")).toContain("line l4 = l3.end -> l1.start");
    const e = projectEdges(sk, tilted, (p) => p, "a tilted hole");
    expect(e.geometry.some((g) => g.startsWith("circle"))).toBe(false);
    expect(e.curves).toBe(4);
    const after = sketchIn(addStatements(src, sk, r));
    expect(after.solved).toBe(true);
    expect(after.profile.fills.length).toBe(1);
  });

  it("still solves when the written ends of an arc round off its circle", () => {
    const src = `design "t"\nsketch s {\n  plane: XY\n}\n`;
    const sk = sketchIn(src);
    const c: [number, number] = [10 / 3, 10 / 7];
    const arc = around(c, 7.123456, 10, 100, 0);
    const edges: OutlineEdge[] = [
      { kind: "circle", pts: arc },
      { kind: "line", pts: [arc[4], [c[0], c[1], 0]] },
      { kind: "line", pts: [[c[0], c[1], 0], arc[0]] },
    ];
    const after = sketchIn(addStatements(src, sk, projectEdges(sk, edges, (p) => p, "a wedge")));
    expect(after.solved).toBe(true);
    expect(after.redundant).toBe(0);
    expect(after.profile.fills.length).toBe(1);
  });

  it("projects nothing for an edge pointing straight at the sketch, and an edge-on face or a tube end on only once", () => {
    const src = `design "t"\nsketch s {\n  plane: XY\n}\n`;
    const sk = sketchIn(src);
    const r = projectEdges(sk, [{ kind: "line", pts: [[5, 5, 0], [5, 5, 9]] }], (p) => p, "a side");
    expect(r.curves).toBe(0);
    expect(r.geometry).toEqual([]);
    // the side of a box, square to the sketch: its top and bottom edges land on one line
    const side: OutlineEdge[] = [
      { kind: "line", pts: [[0, 0, 0], [10, 0, 0]] },
      { kind: "line", pts: [[10, 0, 0], [10, 0, 6]] },
      { kind: "line", pts: [[10, 0, 6], [0, 0, 6]] },
      { kind: "line", pts: [[0, 0, 6], [0, 0, 0]] },
    ];
    expect(projectEdges(sk, side, (p) => p, "a side").curves).toBe(1);
    // the wall of a tube seen end on: both rims are the same circle
    const wall: OutlineEdge[] = [
      { kind: "circle", pts: around([0, 0], 4, 0, 360, 0) },
      { kind: "line", pts: [[4, 0, 0], [4, 0, 12]] },
      { kind: "circle", pts: around([0, 0], 4, 0, 360, 12) },
    ];
    const t = projectEdges(sk, wall, (p) => p, "a tube");
    expect(t.curves).toBe(1);
    expect(sketchIn(addStatements(src, sk, t)).solved).toBe(true);
  });
});
