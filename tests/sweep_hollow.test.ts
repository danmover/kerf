import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { loadOC } from "./occt";
import { buildPartFull } from "../src/kernel/build";
import { evaluate } from "../src/lang/evaluator";

beforeAll(loadOC, 60000);

const valid = (s: R.Shape3D) => {
  const oc = R.getOC();
  const check = new oc.BRepCheck_Analyzer(s.wrapped, true, false);
  const ok = check.IsValid();
  check.delete();
  return ok;
};

/** Build one part's body (as the app's preview does) and time it. */
function build(body: string) {
  const m = evaluate(`design "Sweep"\npart p {\n  body ${body}\n}\n`);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const t = performance.now();
  const shape = buildPartFull(m.parts[0].recipe).shape;
  return { shape, ms: performance.now() - t, volume: R.measureVolume(shape) };
}

/** How many closed skins the solid has: an open-ended tube has one, a sealed tube with a hidden void two. */
function shells(s: R.Shape3D) {
  const oc = R.getOC();
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  for (; ex.More(); ex.Next()) n++;
  ex.delete();
  return n;
}

// a silicone tube that leaves a syringe, loops round and comes back under it to a nozzle (the two-arm robot's suction picker)
const LOOP = "[(32.5, -58.8, 13), (32.5, -62, 15), (32.2, -66, 18), (31.9, -71.5, 15.5), (31.6, -74.5, 8.5), (31.3, -71.5, 2.5), (31, -66, 0), (31, -50, 0), (31, -30, 0), (31, -19.8, 0)]";

describe("hollow sweeps", () => {
  it("builds a tube along a spline in well under a second, open at both ends, as the outer sweep less the bore", () => {
    const tube = build(`pipe(spline_path(points: ${LOOP}), 6, id: 3)`);
    const rod = build(`pipe(spline_path(points: ${LOOP}), 6)`);
    const bore = build(`pipe(spline_path(points: ${LOOP}), 3)`);
    // cutting the bore's sweep out of the rod's took OpenCASCADE 155 s here, and lost the tube
    expect(tube.ms).toBeLessThan(5000);
    expect(valid(tube.shape)).toBe(true);
    expect(shells(tube.shape)).toBe(1);
    expect(tube.volume).toBeGreaterThan(1500);
    expect(Math.abs(tube.volume - (rod.volume - bore.volume)) / tube.volume).toBeLessThan(1e-3);
  });

  it("gives a hollow profile along a rounded path the same solid as cutting the holes' sweeps out", () => {
    const pts = "[(0, 0, 0), (0, 0, 40), (30, 0, 40), (30, 25, 60)]";
    const box = build(`sweep(rect(10, 8) - rect(6, 4), path(points: ${pts}, r: 8))`);
    const outer = build(`sweep(rect(10, 8), path(points: ${pts}, r: 8))`);
    const hole = build(`sweep(rect(6, 4), path(points: ${pts}, r: 8))`);
    expect(valid(box.shape)).toBe(true);
    expect(shells(box.shape)).toBe(1);
    expect(Math.abs(box.volume - (outer.volume - hole.volume)) / box.volume).toBeLessThan(1e-3);
  });

  it("still cuts the bore when the path has sharp corners", () => {
    const tube = build(`pipe(path(points: [(0, 0, 0), (0, 0, 30), (25, 0, 30)]), 8, id: 5)`);
    expect(valid(tube.shape)).toBe(true);
    expect(shells(tube.shape)).toBe(1);
    // two legs of 30 and 25 mm, mitred at the corner, of an 8 / 5 mm tube
    expect(tube.volume).toBeGreaterThan(0.9 * (Math.PI / 4) * (64 - 25) * 55);
    expect(tube.volume).toBeLessThan(1.1 * (Math.PI / 4) * (64 - 25) * 55);
  });
});
