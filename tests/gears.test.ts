import { describe, expect, it } from "vitest";
import { centerDistance, densify, gearOutline, maxPenetration, meshPhase, pitchDiameter, pointInPolygon, tipDiameter } from "../src/library/gears";

describe("involute gears", () => {
  it("uses standard metric gear sizes", () => {
    expect(pitchDiameter(1, 20)).toBe(20);
    expect(tipDiameter(1, 20)).toBe(22);
    expect(centerDistance(1.25, 12, 36)).toBe(30);
  });

  it("produces a closed outline inside the tip circle", () => {
    const pts = gearOutline({ m: 1, z: 12 });
    const rMax = Math.max(...pts.map(([x, y]) => Math.hypot(x, y)));
    expect(rMax).toBeLessThanOrEqual(tipDiameter(1, 12) / 2 + 1e-6);
    expect(pointInPolygon([0, 0], pts)).toBe(true);
  });

  it("meshes a correctly phased pair without interference", () => {
    const m = 1, z1 = 12, z2 = 48;
    const a = densify(gearOutline({ m, z: z1 }), 0.2);
    const ph = meshPhase(0, 0, z1, z2);
    const b0 = gearOutline({ m, z: z2, phase: ph });
    const cd = centerDistance(m, z1, z2);
    const b = densify(b0.map(([x, y]) => [x + cd, y] as [number, number]), 0.2);
    expect(maxPenetration(a, b)).toBeLessThan(0.02);
  });

  it("detects interference when the centres are too close", () => {
    const a = densify(gearOutline({ m: 1, z: 12 }), 0.2);
    const b = densify(gearOutline({ m: 1, z: 12, phase: meshPhase(0, 0, 12, 12) }).map(([x, y]) => [x + 10.5, y] as [number, number]), 0.2);
    expect(maxPenetration(a, b)).toBeGreaterThan(0.2);
  });
});
