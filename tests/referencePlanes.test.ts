// Reference planes: plane() moved along its normal, tilted about its own axes or an edge, through three points,
// midway between two planes and square to a path; sketches drawn on them.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";

function planeOf(expr: string, extra = "") {
  const m = evaluate(`design "t"\n${extra}\nsketch s {\n  plane: ${expr}\n  circle c = (0, 0), d: 4\n}\n`);
  const errors = m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  const sk = m.sketches.find((x) => x.name === "s");
  const r = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4 || 0);
  return { errors, o: r(sk?.frame.o ?? []), n: r(sk?.frame.n ?? []), u: r(sk?.frame.u ?? []) };
}

describe("reference planes", () => {
  it("moves and tilts a plane", () => {
    expect(planeOf("plane(XY, offset: 10)")).toMatchObject({ errors: [], o: [0, 0, 10], n: [0, 0, 1] });
    const t = planeOf("plane(XY, turn: 90)");
    expect(t.n).toEqual([0, -1, 0]);
    expect(t.u).toEqual([1, 0, 0]);
    const s = Math.SQRT1_2;
    expect(planeOf('plane(XY, turn: 45, about: "y")').n.map((x) => Math.round(x * 1e3) / 1e3)).toEqual([Math.round(s * 1e3) / 1e3, 0, Math.round(s * 1e3) / 1e3]);
  });

  it("tilts about an edge, keeping the edge in the plane", () => {
    const p = planeOf("plane(XY, turn: 90, about: [(0, 10, 0), (1, 10, 0)])");
    expect(p.n).toEqual([0, -1, 0]);
    // the origin swings round the edge: it lands on the edge's line through y = 10
    expect(p.o[1]).toBeCloseTo(10, 4);
    const q = planeOf("plane(XY, turn: 30, about: side.l1)", "sketch side {\n  line l1 = (0, 5) -> (10, 5)\n}");
    expect(q.errors).toEqual([]);
    expect(q.n[1]).toBeCloseTo(-0.5, 4);
  });

  it("goes through three points, midway between two planes, and square to a path", () => {
    expect(planeOf("plane(through: [(0, 0, 5), (10, 0, 5), (0, 10, 5)])")).toMatchObject({ errors: [], o: [0, 0, 5], n: [0, 0, 1], u: [1, 0, 0] });
    expect(planeOf("plane(between: [XY, plane(XY, offset: 30)])")).toMatchObject({ errors: [], o: [0, 0, 15], n: [0, 0, 1] });
    expect(planeOf("plane(normal_to: path([(0, 0, 0), (0, 0, 40), (30, 0, 40)]), at: 1)")).toMatchObject({ errors: [], o: [30, 0, 40], n: [1, 0, 0] });
    const h = planeOf("plane(normal_to: helix(pitch: 10, h: 20, d: 20), at: 0)");
    expect(h.errors).toEqual([]);
    expect(Math.hypot(...h.o.slice(0, 2))).toBeCloseTo(10, 3);
  });

  it("says what is wrong", () => {
    expect(planeOf("plane(through: [(0, 0, 0), (1, 0, 0), (2, 0, 0)])").errors.join()).toMatch(/in a line/);
    expect(planeOf("plane(between: [XY, XZ])").errors.join()).toMatch(/not parallel/);
    expect(planeOf('plane(XY, about: "x")').errors.join()).toMatch(/goes with turn/);
    expect(planeOf("plane(XY, through: [(0, 0, 0), (1, 0, 0), (0, 1, 0)])").errors.join()).toMatch(/give one of/);
  });
});
