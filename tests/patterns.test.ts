// Patterns along curves, at sketch points, filling areas and with uneven
// spacing: where the points land and how copies turn to follow a curve.

import { describe, expect, it } from "vitest";
import { PATTERN_FNS, pathPolyline, pathSpots, profileDistance } from "../src/lang/patterns";
import { PathV, ProfileV, ShapeV, Vec, type CallCtx, type Value } from "../src/lang/values";
import { evaluate, evaluateConditions } from "../src/lang/evaluator";
import { applyXforms, applyXformsToDir, type ShapeRecipe, type V3, type Xform } from "../src/kernel/recipe";

const ctx = { error: (m: string): never => { throw new Error(m); }, geo: () => 0 } as unknown as CallCtx;
const call = (name: string, pos: Value[], named: Record<string, Value> = {}) => PATTERN_FNS[name].call(pos, named, ctx);
const pts = (v: Value) => (v as Vec[]).map((p) => p.v3());
const near = (a: V3, b: V3, tol = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;

describe("patterns along a path", () => {
  const line = new PathV({ t: "poly", pts: [[0, 0, 0], [100, 0, 0]], r: 0 });
  const bend = new PathV({ t: "poly", pts: [[0, 0, 0], [50, 0, 0], [50, 50, 0]], r: 10 });
  const arc = new PathV({ t: "arc3", a: [50, 0, 0], b: [0, 50, 0], c: [-50, 0, 0] });

  it("spreads points evenly by length, ends included, or every spacing", () => {
    expect(pts(call("path_points", [line, 5]))).toEqual([[0, 0, 0], [25, 0, 0], [50, 0, 0], [75, 0, 0], [100, 0, 0]]);
    expect(pts(call("path_points", [line], { spacing: 30 })).map((p) => p[0])).toEqual([0, 30, 60, 90]);
    expect(pts(call("path_points", [line, 3], { from: 0.5, to: 1 })).map((p) => p[0])).toEqual([50, 75, 100]);
    // on the arc, every point is 50 from its centre
    for (const p of pts(call("path_points", [arc, 7]))) expect(Math.hypot(p[0], p[1])).toBeCloseTo(50, 3);
    // a list of points is a path too
    expect(pts(call("path_points", [[new Vec([0, 0, 0]), new Vec([0, 0, 40])], 3]))[1]).toEqual([0, 0, 20]);
  });

  it("follows a rounded bend the way the kernel sweeps it", () => {
    const poly = pathPolyline(bend.recipe);
    // the corner is cut off: no point of it reaches (50, 0)
    expect(Math.min(...poly.map((p) => Math.hypot(p[0] - 50, p[1])))).toBeGreaterThan(2.5);
    // its length is the two runs less the corner, plus a quarter circle of radius 10
    let L = 0;
    for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    expect(L).toBeCloseTo(100 - 20 + (Math.PI * 10) / 2, 1);
  });

  it("spreads n points round a closed path without doubling the first", () => {
    const ring = new PathV({ t: "poly", pts: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0]], r: 0 });
    const got = pts(call("path_points", [ring, 4]));
    expect(got).toEqual([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]]);
  });

  it("turns each copy to run along the path, carrying its up without twist", () => {
    const shape = new ShapeV({ t: "box", w: 10, d: 2, h: 2, c: [0, 0, 0] } as unknown as ShapeRecipe);
    const u = call("along_path", [shape, arc, 5]) as ShapeV;
    expect(u.recipe.t).toBe("union");
    const copies = (u.recipe as Extract<ShapeRecipe, { t: "union" }>).shapes as Extract<ShapeRecipe, { t: "xform" }>[];
    expect(copies).toHaveLength(5);
    const spots = pathSpots(arc.recipe, { n: 5 });
    if (typeof spots === "string") throw new Error(spots);
    copies.forEach((c, i) => {
      const xf = c.xf as Xform[];
      // the copy's origin lands on the path, its +X along the path's direction and its +Z stays up (a flat arc)
      expect(near(applyXforms([0, 0, 0], xf), spots[i].p, 1e-6)).toBe(true);
      const x = applyXformsToDir([1, 0, 0], xf);
      expect(x[0] * spots[i].t[0] + x[1] * spots[i].t[1] + x[2] * spots[i].t[2]).toBeCloseTo(1, 6);
      expect(applyXformsToDir([0, 0, 1], xf)[2]).toBeCloseTo(1, 6);
    });
    // up a helix the copies' +Z stays square to the path and turns with it smoothly
    const helix = new PathV({ t: "helix", d: 40, pitch: 10, h: 30, at: [0, 0, 0], dir: [0, 0, 1], left: false });
    const hs = pathSpots(helix.recipe, { n: 9 });
    if (typeof hs === "string") throw new Error(hs);
    for (const s of hs) expect(Math.abs(s.t[0] * s.n[0] + s.t[1] * s.n[1] + s.t[2] * s.n[2])).toBeLessThan(1e-6);
    // align: false keeps them square to the world
    const plain = call("along_path", [shape, arc, 3], { align: false }) as ShapeV;
    for (const c of (plain.recipe as Extract<ShapeRecipe, { t: "union" }>).shapes as Extract<ShapeRecipe, { t: "xform" }>[]) expect(c.xf.map((x) => x.op)).toEqual(["translate"]);
  });

  it("explains what it needs", () => {
    expect(() => call("path_points", [line])).toThrow(/give how many copies/);
    expect(() => call("path_points", [line, 3], { spacing: 10 })).toThrow(/one of the two/);
    expect(() => call("path_points", [5, 3])).toThrow(/should be a path/);
  });
});

describe("fill patterns", () => {
  it("fills a rectangle in square or staggered rows, a margin inside its edge", () => {
    const rect = new ProfileV({ t: "rect", w: 60, h: 40, r: 0, c: [0, 0] });
    const sq = pts(call("fill_points", [rect, 10], { margin: 5 }));
    // centred on the area: x −25…25 (6 columns), y −15…15 (4 rows)
    expect(sq).toHaveLength(24);
    for (const p of sq) expect(Math.abs(p[0]) <= 25 + 1e-9 && Math.abs(p[1]) <= 15 + 1e-9).toBe(true);
    const hex = pts(call("fill_points", [rect, 10], { layout: "hex", margin: 5 }));
    const rows = [...new Set(hex.map((p) => p[1].toFixed(6)))].map(Number).sort((a, b) => a - b);
    expect(rows[1] - rows[0]).toBeCloseTo((10 * Math.sqrt(3)) / 2, 6);
    // neighbours in a staggered grid are all a pitch apart
    const d = Math.min(...hex.slice(1).map((p) => Math.hypot(p[0] - hex[0][0], p[1] - hex[0][1])));
    expect(d).toBeCloseTo(10, 6);
  });

  it("keeps out of holes and follows round and turned areas", () => {
    const plate = new ProfileV({ t: "diff2", a: { t: "circle", d: 100, c: [0, 0] }, b: [{ t: "circle", d: 30, c: [0, 0] }] });
    const got = pts(call("fill_points", [plate, 8], { margin: 3, z: 5 }));
    expect(got.length).toBeGreaterThan(50);
    for (const p of got) {
      const r = Math.hypot(p[0], p[1]);
      expect(r).toBeLessThanOrEqual(47 + 1e-9);
      expect(r).toBeGreaterThanOrEqual(18 - 1e-9);
      expect(p[2]).toBe(5);
    }
    expect(profileDistance({ t: "place2", p: { t: "rect", w: 10, h: 2, r: 0, c: [0, 0] }, rot: 90, by: [5, 0] }, 5, 4)).toBeCloseTo(-1, 9);
  });

  it("fills a sketch's region on its own plane, and places copies at its points", () => {
    const design = `design "f"
sketch plate {
  plane: XZ
  line l1 = (0, 0) -> (60, 0)
  line l2 = l1.end -> (60, 40)
  line l3 = l2.end -> (0, 40)
  line l4 = l3.end -> l1.start
}
sketch holes {
  point a = (10, 10)
  point b = (30, 10)
  circle c = (50, 20), d: 6
}
`;
    const r = evaluateConditions(design, [
      'len(fill_points(plate, 10, margin: 5)) == 24',
      "fill_points(plate, 10, margin: 5)[0].y == 0",
      "len(sketch_points(holes)) == 3",
      "sketch_points(holes)[2].x == 50",
      "len(sketch_points(holes, centers: false)) == 2",
    ]);
    for (const x of r.results) expect(x.error ?? x.ok, x.detail).toBe(true);
    // and a part uses them with no errors
    const m = evaluate(design + `part p {\n  body box(70, 50, 4, at: (30, 20, 2))\n  for q in sketch_points(holes) { cut cylinder(d: 3, h: 10, at: q) }\n}\n`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("refuses text and areas too fine to fill", () => {
    expect(() => call("fill_points", [new ProfileV({ t: "text", text: "A", size: 5, font: "sans", align: "center", c: [0, 0] }), 2])).toThrow(/text cannot be filled/);
    expect(() => call("fill_points", [new ProfileV({ t: "rect", w: 500, h: 500, r: 0, c: [0, 0] }), 1])).toThrow(/more than 2000/);
  });
});

describe("uneven spacing", () => {
  it("turns gaps into positions", () => {
    expect(call("cumulative", [[5, 5, 8, 12]])).toEqual([0, 5, 10, 18, 30]);
    expect(call("cumulative", [[1, 2]], { start: 10 })).toEqual([10, 11, 13]);
  });
});
