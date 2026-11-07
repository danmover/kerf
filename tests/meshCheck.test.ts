import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { buildPart, meshShape, solidVolume, type MeshData } from "../src/kernel/build";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

const meshVolume = (m: MeshData) => {
  const P = m.positions;
  const I = m.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return v;
};

// The jet-vane rig's vane: a NACA 0022 blade from splines, a stem, a flare and a hub. At the final mesh's deflection
// the tessellator lays a sliver face's triangles across far more than the face, so the STL lost four fifths of the vane.
const VANE = `
design "Vane"
let vane_c = 28
let vt = 0.22 * vane_c
let r_tip_i = 10.3693569
let r_tip_o = 27.2588968
let ear_in = 27.7588968
let hub_x0 = 35.7588968
let hub_x1 = 40.6588968
let z_h = 161.26
let foil = outline([
  (0.6, -0.75 * vane_c),
  spline_to((0.17105 * vt + 0.2, (0.25 - 0.85) * vane_c)),
  spline_to((0.30533 * vt, (0.25 - 0.70) * vane_c)),
  spline_to((0.41270 * vt, (0.25 - 0.55) * vane_c)),
  spline_to((0.48358 * vt, (0.25 - 0.40) * vane_c)),
  spline_to((0.50014 * vt, (0.25 - 0.30) * vane_c)),
  spline_to((0.47813 * vt, (0.25 - 0.20) * vane_c)),
  spline_to((0.39023 * vt, (0.25 - 0.10) * vane_c)),
  spline_to((0.29622 * vt, (0.25 - 0.05) * vane_c)),
  spline_to((0.15783 * vt, (0.25 - 0.0125) * vane_c)),
  spline_to((0, 0.25 * vane_c)),
  spline_to((-0.15783 * vt, (0.25 - 0.0125) * vane_c)),
  spline_to((-0.29622 * vt, (0.25 - 0.05) * vane_c)),
  spline_to((-0.39023 * vt, (0.25 - 0.10) * vane_c)),
  spline_to((-0.47813 * vt, (0.25 - 0.20) * vane_c)),
  spline_to((-0.50014 * vt, (0.25 - 0.30) * vane_c)),
  spline_to((-0.48358 * vt, (0.25 - 0.40) * vane_c)),
  spline_to((-0.41270 * vt, (0.25 - 0.55) * vane_c)),
  spline_to((-0.30533 * vt, (0.25 - 0.70) * vane_c)),
  spline_to((-0.17105 * vt - 0.2, (0.25 - 0.85) * vane_c)),
  (-0.6, -0.75 * vane_c)
])
part vane {
  material: "PETG"
  body extrude(foil, r_tip_o - r_tip_i, at: (r_tip_i, 0, z_h), dir: X)
  add cylinder(d: 6, h: ear_in - r_tip_o + 1.01, at: (r_tip_o - 1, 0, z_h), dir: X)
  add cone(d1: 6, d2: 20, h: 8, at: (ear_in, 0, z_h), dir: X)
  add cylinder(d: 20, h: hub_x1 - hub_x0 + 0.01, at: (hub_x0 - 0.01, 0, z_h), dir: X)
  cut cylinder(d: 7.6, h: 3.05, at: (hub_x1 - 3, 0, z_h), dir: X)
  cut box(3.05, 5.25, 8.3, at: (hub_x1 - 3 + 1.525, 0, z_h))
}
`;

describe("meshes checked against the solid", () => {
  it("meshes a part finer when the tessellator gets a face wrong, so its STL is the part", () => {
    const m = evaluate(VANE);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const recipe = m.parts[0].recipe;
    const volume = solidVolume(buildPart(recipe));
    // the tessellator's own mesh at the final deflection is not the vane
    expect(meshVolume(meshShape(buildPart(recipe), "final"))).toBeLessThan(0.5 * volume);
    // given the solid's volume, the mesh is checked and made again finer
    const fixed = meshShape(buildPart(recipe), "final", null, volume);
    expect(Math.abs(meshVolume(fixed) - volume)).toBeLessThan(0.005 * volume);
    // the preview was right first time, and stays as it was
    const preview = meshShape(buildPart(recipe), "preview", null, volume);
    expect(preview.indices.length).toBe(meshShape(buildPart(recipe), "preview").indices.length);
  }, 60_000);
});
