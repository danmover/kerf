import { describe, expect, it } from "vitest";
import { FeaError, runStructural, type FeaPart, type StructuralInput, type StructuralResult } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial, allowableStress } from "../src/analysis/materials";

/** Closed box surface with its faces split into a grid, so results can be read at points along it. */
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

function part(name: string, lo: V3, hi: V3, material = 0): FeaPart {
  return { id: name, name, mesh: gridBox(lo, hi, [20, 4, 4]), material };
}

function base(over: Partial<StructuralInput>): StructuralInput {
  return {
    label: "test",
    parts: [part("beam", [0, 0, 0], [100, 10, 10])],
    materials: [mechMaterial("Steel")],
    supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] } }],
    loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -100] }],
    target: 8000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  };
}

/** A result field read at the mesh vertex nearest to p. */
function at(r: StructuralResult, field: "stress" | "strain" | "safety", p: V3, partIndex = 0): number {
  const f = r.parts[partIndex];
  let best = -1,
    bd = Infinity;
  for (let v = 0; v < f.positions.length / 3; v++) {
    const d = Math.hypot(f.positions[3 * v] - p[0], f.positions[3 * v + 1] - p[1], f.positions[3 * v + 2] - p[2]);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return f[field][best];
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("structural analysis", () => {
  it("matches beam theory for an end-loaded steel cantilever", () => {
    const r = runStructural(base({}));
    const E = 200000,
      nu = 0.29,
      I = (10 * 10 ** 3) / 12,
      G = E / (2 * (1 + nu));
    const tip = (100 * 100 ** 3) / (3 * E * I) + (100 * 100) / ((5 / 6) * G * 100);
    expect(r.solve.converged).toBe(true);
    expect(rel(r.maxDisp.value, tip)).toBeLessThan(0.04);
    // bending stress M·c/I: 30 MPa at mid-span, 60 MPa at the root
    expect(rel(at(r, "stress", [50, 5, 10]), 30)).toBeLessThan(0.06);
    expect(rel(at(r, "strain", [50, 5, 10]), 30 / E)).toBeLessThan(0.08);
    expect(r.maxStress.away).not.toBeNull();
    expect(r.maxStress.away!.value).toBeGreaterThan(50);
    expect(r.maxStress.away!.value).toBeLessThan(72);
    // reactions balance the load
    expect(r.equilibrium).toBeLessThan(1e-3);
    expect(r.reaction[2]).toBeCloseTo(100, 1);
    expect(r.supports[0].reaction[2]).toBeCloseTo(100, 1);
    // factor of safety against yield (275 MPa) at the peak
    expect(r.minSafety.mode).toBe("yield");
    expect(r.minSafety.value).toBeCloseTo(275 / r.maxStress.value, 1);
    expect(r.mass).toBeCloseTo(78.5, 0);
  });

  it("gives a uniform F/A stress in a bar pulled along its axis on a roller support", () => {
    const r = runStructural(
      base({
        materials: [mechMaterial("Aluminum 6061")],
        supports: [
          // the end is held only along X, so the bar can thin without a stress spike; one corner is pinned
          // and a second corner held along Y stops it spinning about its axis (a 3-2-1 support)
          { region: { t: "face", part: "beam", dir: [-1, 0, 0] }, dir: [1, 0, 0] },
          { region: { t: "sphere", at: [0, 0, 0], r: 0.1 } },
          { region: { t: "sphere", at: [0, 0, 10], r: 0.1 }, dir: [0, 1, 0] },
        ],
        loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [1000, 0, 0] }],
      }),
    );
    expect(rel(at(r, "stress", [50, 5, 10]), 10)).toBeLessThan(0.02);
    expect(rel(at(r, "stress", [25, 0, 0]), 10)).toBeLessThan(0.03);
    const stretch = (1000 * 100) / (68900 * 100);
    expect(rel(r.maxDisp.value, stretch)).toBeLessThan(0.03);
    expect(r.equilibrium).toBeLessThan(1e-3);
  });

  it("bonds touching parts into one body", () => {
    const one = runStructural(base({}));
    const two = runStructural(
      base({
        parts: [part("root", [0, 0, 0], [50, 10, 10]), part("tip", [50, 0, 0], [100, 10, 10])],
        supports: [{ region: { t: "face", part: "root", dir: [-1, 0, 0] } }],
        loads: [{ t: "force", region: { t: "face", part: "tip", dir: [1, 0, 0] }, f: [0, 0, -100] }],
      }),
    );
    expect(rel(two.maxDisp.value, one.maxDisp.value)).toBeLessThan(0.02);
    expect(two.parts).toHaveLength(2);
  });

  it("spreads a pressure over a face and adds self-weight", () => {
    const r = runStructural(base({ loads: [{ t: "pressure", region: { t: "face", part: "beam", dir: [0, 0, 1] }, p: 0.01 }], accel: [0, 0, -1] }));
    const weight = 0.0785 * 9.80665; // 78.5 g of steel
    expect(r.loads[0].vector[2]).toBeCloseTo(-10, 2);
    expect(r.loads[0].area).toBeCloseTo(1000, 0);
    expect(r.gravity!.vector[2]).toBeCloseTo(-weight, 2);
    expect(r.applied[2]).toBeCloseTo(-10 - weight, 2);
    // uniformly loaded cantilever: w·L⁴ / (8·E·I)
    const w = (10 + weight) / 100;
    const tip = (w * 100 ** 4) / (8 * 200000 * (10 * 10 ** 3) / 12);
    expect(rel(r.maxDisp.value, tip)).toBeLessThan(0.06);
  });

  it("twists a square shaft by the torsion formula", () => {
    const r = runStructural(
      base({
        parts: [part("shaft", [-5, -5, 0], [5, 5, 100])],
        supports: [{ region: { t: "face", part: "shaft", dir: [0, 0, -1] } }],
        loads: [{ t: "torque", region: { t: "face", part: "shaft", dir: [0, 0, 1] }, torque: 1000, axis: [0, 0, 1], at: [0, 0, 100] }],
      }),
    );
    // net force of a pure torque is zero
    expect(Math.hypot(...r.loads[0].vector)).toBeLessThan(1e-6);
    const G = 200000 / (2 * 1.29);
    const J = 0.1406 * 10 ** 4; // square section torsion constant
    const theta = (1000 * 100) / (G * J);
    expect(rel(r.maxDisp.value, theta * Math.SQRT2 * 5)).toBeLessThan(0.08);
  });

  it("checks printed parts for strength between layers", () => {
    const pla = mechMaterial("PLA");
    const along = runStructural(base({ materials: [pla], printed: true, buildDir: [1, 0, 0], loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -20] }] }));
    expect(along.minSafety.mode).toBe("layers");
    expect(along.minSafety.allowable).toBeCloseTo(pla.yield * pla.layerFactor);
    const flat = runStructural(base({ materials: [pla], printed: true, buildDir: [0, 0, 1], loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -20] }] }));
    expect(flat.minSafety.mode).toBe("yield");
    expect(flat.minSafety.value).toBeGreaterThan(along.minSafety.value * 1.4);
  });

  it("uses the fatigue strength for repeated loading", () => {
    const steel = mechMaterial("Steel");
    expect(allowableStress(steel, 1e7)).toEqual({ value: steel.fatigue, basis: "fatigue" });
    const r = runStructural(base({ cycles: 1e7 }));
    expect(r.minSafety.mode).toBe("fatigue");
    expect(r.minSafety.allowable).toBe(steel.fatigue);
  });

  it("explains set-ups that cannot be solved", () => {
    expect(() => runStructural(base({ supports: [] }))).toThrow(/no supports/);
    expect(() => runStructural(base({ loads: [] }))).toThrow(/no loads/);
    // a roller alone lets the part slide sideways
    expect(() => runStructural(base({ supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] }, dir: [1, 0, 0] }] }))).toThrow(FeaError);
    expect(() => runStructural(base({ supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] }, dir: [1, 0, 0] }] }))).toThrow(/do not hold the part still/);
    // a zone in mid-air
    expect(() => runStructural(base({ supports: [{ region: { t: "sphere", at: [50, 50, 50], r: 2 } }] }))).toThrow(/does not touch/);
    // a second part that nothing holds
    expect(() =>
      runStructural(
        base({
          parts: [part("beam", [0, 0, 0], [100, 10, 10]), part("loose", [0, 30, 0], [100, 40, 10])],
        }),
      ),
    ).toThrow(/not connected to any support/);
    expect(() => runStructural(base({ supports: [{ region: { t: "face", part: "nope", dir: [-1, 0, 0] } }] }))).toThrow(/not one of the analysed parts/);
  });

  it("handles a thin plate with stretched elements", () => {
    // 200 × 50 × 2 mm aluminium strip, cantilevered, 5 N at the tip
    const r = runStructural(
      base({
        parts: [{ id: "s", name: "strip", mesh: gridBox([0, 0, 0], [200, 50, 2], [40, 10, 1]), material: 0 }],
        materials: [mechMaterial("Aluminum 6061")],
        supports: [{ region: { t: "face", part: "strip", dir: [-1, 0, 0] } }],
        loads: [{ t: "force", region: { t: "face", part: "strip", dir: [1, 0, 0] }, f: [0, 0, -5] }],
      }),
    );
    const I = (50 * 2 ** 3) / 12;
    const tip = (5 * 200 ** 3) / (3 * 68900 * I);
    expect(r.solve.converged).toBe(true);
    expect(r.solve.iterations).toBeLessThan(120);
    expect(rel(r.maxDisp.value, tip)).toBeLessThan(0.05);
    // σ = M·c/I = 5·100·1/I at mid-span
    expect(rel(at(r, "stress", [100, 25, 2]), (5 * 100 * 1) / I)).toBeLessThan(0.08);
  });
});
