// Splines and ellipses in sketches: the language, the curve maths, the
// profile they make, the solids built from them and the editor's edits.

import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { parse } from "../src/lang/parser";
import { evaluate } from "../src/lang/evaluator";
import { buildPart } from "../src/kernel/build";
import { bezierArea, bezierAt, ellipseAt, polyDistance, sampleEllipse, splineBeziers, splinePolyline } from "../src/sketch/curves";
import { setCurveOption, suggestionsFor } from "../src/sketch/edits";
import { offsetFor, trimAt } from "../src/sketch/modify";
import type { EvalSketch } from "../src/sketch/types";
import type { V2 } from "../src/kernel/recipe";
import { initKernel } from "./helpers/kernel";

const design = (body: string) => `design "t"\n${body}\n`;
const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const sketchOf = (src: string, name?: string): EvalSketch => {
  const m = evaluate(src);
  const sk = name ? m.sketches.find((s) => s.name === name) : m.sketches[0];
  if (!sk) throw new Error("no sketch: " + JSON.stringify(m.diagnostics));
  return sk;
};
/** shoelace area of a closed polygon */
const polyArea = (pts: V2[]) => pts.reduce((s, p, i) => s + (p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1]) / 2, 0);

describe("spline and ellipse syntax", () => {
  it("parses points, then named options", () => {
    const { diagnostics, program } = parse(`sketch s {
  spline s1 = (0, 0), (10, 8), (20, 0), (30, 6)
  spline s2 = (0, 20), (10, 30), (20, 20), closed: true
  ellipse e1 = (50, 0), rx: 20, ry: 10, angle: 30
  construction ellipse e2 = s1.end, rx: 4, ry: 2
}`);
    expect(diagnostics).toEqual([]);
    const s = program.stmts[0];
    if (s.k !== "sketch") throw new Error();
    const s2 = s.items.find((i) => i.k === "entity" && i.name === "s2");
    expect(s2 && s2.k === "entity" && s2.args.length).toBe(3);
    expect(s2 && s2.k === "entity" && s2.opts?.map((o) => o.name)).toEqual(["closed"]);
    const e2 = s.items.find((i) => i.k === "entity" && i.name === "e2");
    expect(e2 && e2.k === "entity" && e2.construction).toBe(true);
  });

  it("says what is wrong in plain words", () => {
    expect(errors(design(`sketch s {\n  spline s1 = (0, 0), (10, 8)\n}`))[0]).toMatch(/at least 3 points.*; for 2, use a line/);
    expect(errors(design(`sketch s {\n  ellipse e1 = (0, 0), rx: 10\n}`))[0]).toMatch(/needs ry:/);
    expect(errors(design(`sketch s {\n  ellipse e1 = (0, 0), rx: 10, ry: 0\n}`))[0]).toMatch(/ry must be greater than 0/);
    expect(errors(design(`sketch s {\n  ellipse e1 = (0, 0), rx: 10, ry: 5, angel: 3\n}`))[0]).toMatch(/did you mean "angle:"/);
    expect(errors(design(`sketch s {\n  point p = (0, 0)\n  spline s1 = p, (10, 8), (20, 0), p, closed: true\n}`))[0]).toMatch(/leave the last point off/);
    expect(errors(design(`sketch s {\n  spline s1 = (0, 0), (10, 8), (20, 0)\n  tangent s1, s1\n}`))[0]).toMatch(/runs smoothly/);
    expect(errors(design(`sketch s {\n  spline s1 = (0, 0), (10, 8), (20, 0)\n  point p = (5, 5)\n  coincident p, s1\n}`))[0]).toMatch(/s1\.start, s1\.end or s1\.p2/);
  });
});

describe("curve maths", () => {
  it("passes a spline through every point, smoothly", () => {
    const pts: V2[] = [[0, 0], [10, 8], [20, 0], [30, 6], [45, 2]];
    const zs = splineBeziers(pts, false);
    expect(zs.length).toBe(4);
    zs.forEach((z, i) => {
      expect(z.a).toEqual(pts[i]);
      expect(z.b).toEqual(pts[i + 1]);
    });
    // the tangent carries on through each point (same direction either side)
    for (let i = 0; i + 1 < zs.length; i++) {
      const out: V2 = [zs[i].b[0] - zs[i].c2[0], zs[i].b[1] - zs[i].c2[1]];
      const on: V2 = [zs[i + 1].c1[0] - zs[i + 1].a[0], zs[i + 1].c1[1] - zs[i + 1].a[1]];
      const cross = out[0] * on[1] - out[1] * on[0];
      expect(Math.abs(cross) / (Math.hypot(...out) * Math.hypot(...on))).toBeLessThan(1e-9);
      expect(out[0] * on[0] + out[1] * on[1]).toBeGreaterThan(0);
    }
    // closed: one more piece, back to the start
    const zc = splineBeziers(pts, true);
    expect(zc.length).toBe(5);
    expect(zc[4].b).toEqual(pts[0]);
  });

  it("gives the exact area under Bézier pieces and the ellipse's points", () => {
    const pts: V2[] = [[0, 0], [30, 5], [25, 25], [5, 20]];
    const zs = splineBeziers(pts, true);
    const exact = zs.reduce((s, z) => s + bezierArea(z), 0);
    const fine = zs.flatMap((z) => Array.from({ length: 400 }, (_, i) => bezierAt(z, i / 400)));
    // the polyline cuts a sliver off each bend, so it comes in a whisker under
    expect(exact).toBeCloseTo(polyArea(fine), 2);
    expect(exact).toBeGreaterThan(polyArea(fine));
    const e = { c: [5, -3] as V2, rx: 20, ry: 8, rot: 30 };
    expect(ellipseAt(e, 0)[0]).toBeCloseTo(5 + 20 * Math.cos(Math.PI / 6), 9);
    expect(polyArea(sampleEllipse(e, 2000))).toBeCloseTo(Math.PI * 20 * 8, 1);
    // a point on the outline is on it, the centre is a minor radius away
    expect(polyDistance(ellipseAt(e, 1.1), sampleEllipse(e, 720), true)).toBeLessThan(0.01);
    expect(polyDistance(e.c, sampleEllipse(e, 720), true)).toBeCloseTo(8, 2);
    // an open spline's polyline keeps both ends
    const line = splinePolyline([[0, 0], [10, 5], [20, 0]], false);
    expect(line[0]).toEqual([0, 0]);
    expect(line[line.length - 1]).toEqual([20, 0]);
  });
});

describe("profiles with splines and ellipses", () => {
  it("fills an ellipse on its own, and a closed spline", () => {
    const sk = sketchOf(design(`sketch s {
  ellipse e1 = (0, 0), rx: 20, ry: 10, angle: 25
}`));
    expect(sk.profile.error).toBeUndefined();
    expect(sk.profile.loops).toBe(1);
    expect(sk.profile.area).toBeCloseTo(Math.PI * 200, 6);
    const c = sketchOf(design(`sketch s {
  spline s1 = (0, 0), (30, 5), (25, 25), (5, 20), closed: true
}`));
    const zs = splineBeziers([[0, 0], [30, 5], [25, 25], [5, 20]], true);
    expect(c.profile.area).toBeCloseTo(Math.abs(zs.reduce((s, z) => s + bezierArea(z), 0)), 6);
  });

  it("joins an open spline to lines through shared points, with an ellipse hole", () => {
    const sk = sketchOf(design(`sketch s {
  line l1 = (0, 0) -> (60, 0)
  line l2 = l1.end -> (60, 20)
  spline top = l2.end, (40, 32), (20, 24), (0, 20)
  line l3 = top.end -> l1.start
  ellipse hole = (30, 12), rx: 8, ry: 4
}`));
    expect(sk.profile.error).toBeUndefined();
    expect(sk.profile.loops).toBe(2);
    const zs = splineBeziers([[60, 20], [40, 32], [20, 24], [0, 20]], false);
    // shoelace round the loop: the floor and the left side add nothing, the right side 600, then the spline back over the top
    const loop = (60 * 20) / 2 + zs.reduce((s, z) => s + bezierArea(z), 0);
    expect(sk.profile.area).toBeCloseTo(loop - Math.PI * 32, 6);
    expect(sk.points.find((p) => p.id === "top.p2")).toBeTruthy();
    expect(sk.aliases["top.start"]).toBe("l2.end");
  });

  it("asks for closed: when a spline runs back to where it started", () => {
    const sk = sketchOf(design(`sketch s {
  point p = (0, 0)
  spline s1 = p, (20, 0), (10, 15), p
}`));
    expect(sk.profile.error?.message).toMatch(/closed: true/);
  });

  it("moves the spline when its points are constrained", () => {
    const sk = sketchOf(design(`sketch s {
  spline s1 = (0, 0), (10, 8), (20, 0)
  coincident s1.start, origin
  horizontal s1.start, s1.end
  distance s1.start, s1.end = 50
  vdistance s1.start, s1.p2 = 12
  hdistance s1.start, s1.p2 = 25
}`));
    expect(sk.solved).toBe(true);
    const at = (id: string) => sk.points.find((p) => p.id === id)!;
    expect(at("s1.p3").x).toBeCloseTo(50, 6);
    expect(at("s1.p3").y).toBeCloseTo(0, 6);
    expect(at("s1.p2").x).toBeCloseTo(25, 6);
    expect(at("s1.p2").y).toBeCloseTo(12, 6);
    expect(sk.curves.find((c) => c.id === "s1")?.status).toBe("defined");
  });

  it("mirrors and patterns ellipses with their turn", () => {
    const sk = sketchOf(design(`sketch s {
  ellipse e1 = (20, 10), rx: 6, ry: 3, angle: 30
  mirror e1, about: y_axis
  pattern e1, count: 4, around: origin
}`));
    const es = sk.curves.filter((c) => c.kind === "ellipse");
    expect(es.length).toBe(5);
    const angles = es.map((c) => Math.round(((((c.angle ?? 0) % 180) + 180) % 180)));
    // mirrored across y: 180 - 30; ringed: 30 + 90k
    expect(angles.sort((a, b) => a - b)).toEqual([30, 120, 120, 150, 210 % 180].sort((a, b) => a - b));
  });
});

describe("spline and ellipse solids (OpenCASCADE)", () => {
  beforeAll(() => initKernel(), 60_000);

  const volumes = (src: string) => {
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return Object.fromEntries(m.parts.map((p) => [p.name, R.measureShapeVolumeProperties(buildPart(p.recipe)).volume]));
  };

  it("extrudes ellipses and splines to the area the sketch reports", () => {
    const src = design(`sketch oval {
  ellipse e1 = (0, 0), rx: 20, ry: 10, angle: 40
}
sketch blob {
  spline s1 = (0, 0), (30, 5), (25, 25), (5, 20), closed: true
}
sketch wing {
  line l1 = (0, 0) -> (60, 0)
  line l2 = l1.end -> (60, 20)
  spline top = l2.end, (40, 32), (20, 24), (0, 20)
  line l3 = top.end -> l1.start
  ellipse hole = (30, 12), rx: 8, ry: 4
}
part oval_p { body extrude(oval, 5) }
part blob_p { body extrude(blob, 4) }
part wing_p { body extrude(wing, 3) }
part plate {
  body box(80, 60, 6)
  cut extrude(oval, 1, through: true)
}`);
    const m = evaluate(src);
    const area = (n: string) => m.sketches.find((s) => s.name === n)!.profile.area;
    const v = volumes(src);
    expect(v.oval_p).toBeCloseTo(Math.PI * 200 * 5, 2);
    expect(v.blob_p / 4).toBeCloseTo(area("blob"), 2);
    expect(v.wing_p / 3).toBeCloseTo(area("wing"), 2);
    expect(v.plate).toBeCloseTo(80 * 60 * 6 - Math.PI * 200 * 6, 1);
  });
});

describe("editing splines and ellipses", () => {
  const src = design(`sketch s {
  spline s1 = (0, 0), (10, 8), (20, 0)
  ellipse e1 = (40, 0), rx: 10, ry: 5
  line l1 = (0, -10) -> (40, -10)
}`);

  it("writes an ellipse's sizes and a spline's closed: into the statement", () => {
    const sk = sketchOf(src);
    const e1 = sk.curves.find((c) => c.id === "e1")!;
    let next = setCurveOption(src, e1, "ry", "7.5");
    next = setCurveOption(next, sketchOf(next).curves.find((c) => c.id === "e1")!, "angle", "15");
    expect(next).toContain("ellipse e1 = (40, 0), rx: 10, ry: 7.5, angle: 15");
    const s1 = sketchOf(next).curves.find((c) => c.id === "s1")!;
    next = setCurveOption(next, s1, "closed", "true");
    expect(next).toContain("spline s1 = (0, 0), (10, 8), (20, 0), closed: true");
    next = setCurveOption(next, sketchOf(next).curves.find((c) => c.id === "s1")!, "closed", "false");
    expect(next).toContain("(20, 0), closed: false");
    expect(errors(next)).toEqual([]);
  });

  it("offers what applies to them, and says why trim and offset don't", () => {
    const sk = sketchOf(src);
    expect(suggestionsFor(sk, ["e1"]).map((s) => s.stmt)).toContain("fix e1");
    expect(suggestionsFor(sk, ["s1"]).map((s) => s.stmt)).toContain("fix s1");
    const trim = trimAt(src, sk, "s1", [10, 8]);
    expect("error" in trim && trim.error).toBeTruthy();
    expect(offsetFor(sk, ["e1"], [55, 0], { step: 1 })).toBeNull();
    // trimming a line that crosses nothing smooth deletes it, as before; the ellipse does not cut it
    const t2 = trimAt(src, sk, "l1", [20, -10]);
    expect("error" in t2 ? t2.error : t2.message).toBeTruthy();
  });
});
