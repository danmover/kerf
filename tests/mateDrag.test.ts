// Dragging parts through their mates and the mechanism, and keeping a dragged pose in the design.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { dragHow, eulerXYZ, keepPose, mateDeltas, mateDragTo, matPoint, motionDragTo, movedWords, startMateDrag, startMotionDrag } from "../src/core/mateDrag";
import { applyXforms, xformMatrix, type V3 } from "../src/kernel/recipe";
import type { Model } from "../src/core/model";

const part = (m: Model, name: string) => m.parts.find((p) => p.name === name)!;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// a lid on a box, hinged along its back top edge (y = 20, z = 10) and kept from sliding along the hinge
const HINGE = `design "hinge"
part base { body box(60, 40, 10) }
part lid { at: (0, 0, 10) body box(60, 40, 4) }
mate hinge = concentric(axis(lid, at: (0, 20, 10), dir: X), axis(base, at: (0, 20, 10), dir: X))
mate side = flush(plane(lid, at: (30, 0, 12), normal: +X), plane(base, at: (30, 0, 5), normal: +X))
`;

describe("dragging through mates", () => {
  it("says what can be dragged and how", () => {
    const m = evaluate(HINGE);
    expect(dragHow(m, part(m, "lid"))).toMatchObject({ kind: "mates", body: "lid" });
    expect(dragHow(m, part(m, "base"))).toMatchObject({ kind: "none" });
  });

  it("turns the lid on its hinge toward the pointer, and nothing else", () => {
    const m = evaluate(HINGE);
    const grab: V3 = [0, -20, 14];
    let d = startMateDrag(m, "lid", grab);
    // pull the front edge up and back, a step at a time as a pointer would
    for (const target of [[0, -18, 25], [0, -10, 38], [0, 0, 45]] as V3[]) d = mateDragTo(m, d, target);
    const D = mateDeltas(m, d.moves);
    expect([...D.keys()]).toEqual(["lid"]);
    const moved = matPoint(D.get("lid")!, grab);
    // it stays as far from the hinge as it was, and has swung up
    const hingeDist = (p: V3) => Math.hypot(p[1] - 20, p[2] - 10);
    expect(hingeDist(moved)).toBeCloseTo(hingeDist(grab), 4);
    expect(moved[0]).toBeCloseTo(0, 4);
    expect(moved[2]).toBeGreaterThan(40);
    expect(movedWords(m, "lid", d.moves)).toMatch(/lid turned (\d+(\.\d)?)°/);
  });

  it("keeps a dragged pose by writing it into the part's at: and rotate:", () => {
    const m = evaluate(HINGE);
    let d = startMateDrag(m, "lid", [0, -20, 14]);
    d = mateDragTo(m, d, [0, -10, 38]);
    const D = mateDeltas(m, d.moves).get("lid")!;
    const kept = keepPose(HINGE, m, d.moves);
    expect(kept.kept).toEqual(["lid"]);
    expect(kept.src).toMatch(/part lid \{ rotate: \(-?\d+(\.\d+)?, 0, 0\), at: \([^)]*\) body box/);
    const m2 = evaluate(kept.src);
    expect(m2.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    // drawn where it was dragged, and the mates still hold it there
    const lid = part(m2, "lid");
    for (const local of [[0, -20, 4], [30, 20, 0], [-30, 0, 2]] as V3[]) {
      const before = matPoint(D, applyXforms(local, part(m, "lid").xf));
      expect(dist(applyXforms(local, lid.xf), before)).toBeLessThan(0.02);
    }
    expect(m2.mates?.list.every((x) => x.status === "ok")).toBe(true);
  });

  it("reads rotations back as turns about X, then Y, then Z", () => {
    for (const r of [[10, 20, 30], [-45, 5, 170], [0, 90, 0], [30, -90, 0]] as V3[]) {
      const xf = [
        { op: "rotate" as const, angle: r[0], origin: [0, 0, 0] as V3, axis: [1, 0, 0] as V3 },
        { op: "rotate" as const, angle: r[1], origin: [0, 0, 0] as V3, axis: [0, 1, 0] as V3 },
        { op: "rotate" as const, angle: r[2], origin: [0, 0, 0] as V3, axis: [0, 0, 1] as V3 },
      ];
      const back = eulerXYZ(xformMatrix(xf));
      const xf2 = back.map((a, i) => ({ op: "rotate" as const, angle: a, origin: [0, 0, 0] as V3, axis: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0] as V3 }));
      for (const p of [[1, 2, 3], [-4, 0, 1]] as V3[]) expect(dist(applyXforms(p, xf), applyXforms(p, xf2))).toBeLessThan(1e-9);
    }
  });

  it("writes a component's axis when a drag turns it", () => {
    const src = `design "motor"
part plate { body box(80, 80, 5) }
component shaft_pin = lib.dowel(d: 5, length: 20) { at: (50, 0, 30), axis: X }
mate in_hole = concentric(axis(shaft_pin, at: (50, 0, 30), dir: X), axis(plate, at: (0, 0, 5), dir: Z))
`;
    const m = evaluate(src);
    expect(m.diagnostics.filter((x) => x.severity === "error").map((x) => x.message)).toEqual([]);
    const pin = part(m, "shaft_pin");
    expect(pin.placement).toBe("axis");
    const d = startMateDrag(m, "shaft_pin", applyXforms([0, 0, 0], pin.xf));
    const kept = keepPose(src, m, mateDragTo(m, d, [5, 5, 20]).moves);
    expect(kept.src).toMatch(/axis: \(0, 0, (-)?1\)/);
  });
});

describe("dragging the mechanism", () => {
  it("turns the driver to the angle that brings the grabbed spot under the pointer", () => {
    const m = evaluate(`design "crank"
part crank { spin: 1 axis: Z axis_at: (0, 0, 0) body box(30, 6, 4, at: (12, 0, 0)) }
`);
    const crank = part(m, "crank");
    expect(dragHow(m, crank)).toMatchObject({ kind: "motion" });
    let d = startMotionDrag(crank, [20, 0, 4], 0, 30)!;
    expect(d).toBeTruthy();
    // looking straight down at (0, 20): a quarter turn
    d = motionDragTo(crank, d, { o: [0, 20, 100], d: [0, 0, -1] });
    expect(d.angle).toBeCloseTo(90, 1);
    // then on round to the far side, without jumping back
    d = motionDragTo(crank, d, { o: [-20, 2, 100], d: [0, 0, -1] });
    expect(d.angle).toBeGreaterThan(170);
    expect(d.angle).toBeLessThan(180);
  });
});
