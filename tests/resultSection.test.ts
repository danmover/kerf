// The result inside the parts, for a section through it. A cantilever's bending stress is nothing on its neutral
// axis and largest at the top and bottom, which only the inside shows; a bar heated at one end carries the same
// temperatures inside as on its skin; and the samples keep their places when a big model is averaged in blocks.

import { describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import { sampleInterior, sampleVolume, type ResultVolume } from "../src/analysis/fe/volume";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { thermalMaterial } from "../src/analysis/thermalMaterials";

function gridBox(lo: V3, hi: V3, div: V3): TriMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let a = 0; a < 3; a++)
    for (const side of [0, 1]) {
      const u = (a + 1) % 3,
        v = (a + 2) % 3;
      const nu = div[u],
        nv = div[v];
      const base = pos.length / 3;
      for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++) {
          const p = [0, 0, 0];
          p[a] = side ? hi[a] : lo[a];
          p[u] = lo[u] + ((hi[u] - lo[u]) * i) / nu;
          p[v] = lo[v] + ((hi[v] - lo[v]) * j) / nv;
          pos.push(...p);
        }
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const q = base + i + (nu + 1) * j;
          if (side) idx.push(q, q + 1, q + nu + 2, q, q + nu + 2, q + nu + 1);
          else idx.push(q, q + nu + 2, q + 1, q, q + nu + 1, q + nu + 2);
        }
    }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

const face = (dir: V3) => ({ t: "face" as const, part: "bar", dir });

function bar(material: string, over: Partial<StructuralInput>) {
  const part: FeaPart = { id: "bar", name: "bar", mesh: gridBox([0, 0, 0], [100, 10, 10], [20, 4, 4]), material: 0 };
  return runStructural({
    label: "section",
    parts: [part],
    materials: [mechMaterial(material)],
    thermalMaterials: [thermalMaterial(material)],
    supports: [],
    loads: [],
    target: 8000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  });
}

const at = (v: ResultVolume, arr: Float32Array | undefined, p: V3) => sampleVolume(v, (q) => arr![q], p);

describe("the result inside the parts", { timeout: 60000 }, () => {
  it("shows a cantilever's bending stress: nothing on the neutral axis, most at the top and bottom", () => {
    const r = bar("Steel", { supports: [{ region: face([-1, 0, 0]) }], loads: [{ t: "force", region: face([1, 0, 0]), f: [0, 0, -1000] }] });
    const v = r.interior!;
    expect(v).toBeTruthy();
    expect(v.stress!.length).toBe(v.n[0] * v.n[1] * v.n[2]);
    expect(v.disp!.length).toBe(3 * v.stress!.length);
    // halfway along: M = 1000 N × 50 mm, I = 10 × 10³ / 12; 4 mm above the axis σ = M y / I = 240 MPa
    const top = at(v, v.stress, [50, 5, 9]);
    const bottom = at(v, v.stress, [50, 5, 1]);
    const middle = at(v, v.stress, [50, 5, 5]);
    expect(top).toBeGreaterThan(0.75 * 240);
    expect(top).toBeLessThan(1.2 * 240);
    expect(bottom / top).toBeGreaterThan(0.8);
    expect(bottom / top).toBeLessThan(1.25);
    // only the shear is left on the axis: 1.5 V / A = 15 MPa, √3 × that as von Mises
    expect(middle).toBeLessThan(0.25 * top);
    // the strain changes sign through the depth: stretched on top, squashed below
    expect(at(v, v.strain, [50, 5, 9])).toBeGreaterThan(0);
    // safety inside is the material's strength over the stress there
    expect(1 / at(v, v.util, [50, 5, 9])).toBeLessThan(1 / at(v, v.util, [50, 5, 5]));
    // the tip moves down as far inside as the result says it does
    const tip = at(v, new Float32Array(v.disp!.filter((_, i) => i % 3 === 2)), [99, 5, 5]);
    expect(-tip / r.maxDisp.value).toBeGreaterThan(0.9);
    expect(-tip / r.maxDisp.value).toBeLessThan(1.05);
  });

  it("carries a heat result's temperatures, the same inside as on the skin along a heated bar", () => {
    const r = bar("Aluminum 6061", {
      thermal: { heat: [{ region: face([1, 0, 0]), watts: 5, label: "heater" }], fixed: [{ region: face([-1, 0, 0]), temp: 20 }], cooling: 0, coolingText: "sealed", films: [], ambient: 20 },
    });
    expect(r.heatOnly).toBe(true);
    const v = r.interior!;
    expect(v.temp).toBeTruthy();
    expect(v.disp).toBeUndefined();
    expect(v.stress).toBeUndefined();
    // heat runs along the bar: the middle of it is as warm as its skin at the same place
    const f = r.parts[0];
    let skin = 0,
      bd = Infinity;
    for (let q = 0; q < f.positions.length / 3; q++) {
      const d = Math.hypot(f.positions[3 * q] - 50, f.positions[3 * q + 1], f.positions[3 * q + 2] - 5);
      if (d < bd) [bd, skin] = [d, f.temp![q]];
    }
    const inside = at(v, v.temp, [50, 5, 5]);
    expect(Math.abs(inside - skin)).toBeLessThan(0.5);
    // and warmer towards the heater (ΔT = Q L / k A ≈ 30 °C end to end)
    expect(at(v, v.temp, [90, 5, 5]) - at(v, v.temp, [10, 5, 5])).toBeGreaterThan(20);
  });
});

describe("sampling the inside", () => {
  it("averages a big grid in blocks without moving the samples", () => {
    const n: [number, number, number] = [100, 100, 30];
    const origin: V3 = [-5, 2, 0];
    const h: V3 = [0.5, 0.5, 1];
    const xOf = (i: number) => origin[0] + (i % n[0]) * h[0];
    const v = sampleInterior({ n, origin, h }, () => true, [xOf]);
    // 300k nodes → blocks of 2 × 2 × 2
    expect(v.n).toEqual([50, 50, 15]);
    expect(v.step).toEqual([1, 1, 2]);
    const vol: ResultVolume = { origin: v.origin, step: v.step, n: v.n, stress: v.scalars[0] };
    // a linear field comes back exactly wherever it is sampled
    for (const x of [-4.1, 0, 7.3, 18.6]) expect(sampleVolume(vol, (q) => vol.stress![q], [x, 20, 10])).toBeCloseTo(x, 5);
  });

  it("fills two samples past the surface from inside, and leaves the rest empty", () => {
    const n: [number, number, number] = [10, 3, 3];
    const v = sampleInterior({ n, origin: [0, 0, 0], h: [1, 1, 1] }, (q) => q % 10 < 5, [(q) => 1 + (q % 10)]);
    const row = Array.from({ length: 10 }, (_, i) => v.scalars[0][i + 10]);
    expect(row.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(row[5]).toBeCloseTo(5, 5);
    expect(row[6]).toBeCloseTo(5, 5);
    expect(row[7]).toBe(0);
  });
});
