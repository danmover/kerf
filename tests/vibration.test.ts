import { describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import { boxMesh, type V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";

function part(name: string, lo: V3, hi: V3): FeaPart {
  return { id: name, name, mesh: boxMesh(lo, hi), material: 0 };
}

function base(over: Partial<StructuralInput>): StructuralInput {
  return {
    label: "test",
    parts: [part("beam", [0, 0, 0], [100, 10, 10])],
    materials: [mechMaterial("Steel")],
    supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] } }],
    loads: [],
    target: 8000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  };
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("natural frequencies", () => {
  // steel cantilever 100 × 10 × 10 mm: f₁ = (1.875² / 2π) √(EI / ρAL⁴)
  const E = 200000,
    I = 1e4 / 12,
    rho = 7.85e-9,
    A = 100,
    L = 100;
  const f1 = ((1.875 ** 2) / (2 * Math.PI)) * Math.sqrt((E * I) / (rho * A * L ** 4));

  it("matches beam theory for a cantilever's first bending modes", () => {
    const r = runStructural(base({ modes: 3 }));
    const m = r.modal!;
    expect(m.converged).toBe(true);
    // a square section bends the same both ways: the first two modes pair up
    expect(rel(m.modes[0].freq, f1)).toBeLessThan(0.08);
    expect(rel(m.modes[1].freq, f1)).toBeLessThan(0.08);
    // they move sideways (Y and Z), not along the beam
    for (const md of m.modes.slice(0, 2)) expect(md.share[0]).toBeLessThan(0.05);
    expect(m.modes[0].share[1] + m.modes[0].share[2]).toBeGreaterThan(0.5);
    expect(m.modes[2].freq).toBeGreaterThan(m.modes[1].freq * 1.5);
    // shapes reach the CAD surface, scaled so the largest movement is 1
    const shape = r.parts[0].modes![0];
    let mx = 0;
    for (let v = 0; v < shape.length; v += 3) mx = Math.max(mx, Math.hypot(shape[v], shape[v + 1], shape[v + 2]));
    expect(mx).toBeCloseTo(1, 3);
  });

  it("drops with a carried mass at the tip", () => {
    const r = runStructural(base({ modes: 1, masses: [{ region: { t: "face", part: "beam", dir: [1, 0, 0] }, grams: 2000 }] }));
    // a 2 kg tip mass on k = 3EI/L³ with about a quarter of the beam's own mass
    const k = (3 * E * I) / L ** 3;
    const f = Math.sqrt(k / ((2 + 0.236 * 0.0785) * 1e-3)) / (2 * Math.PI);
    expect(rel(r.modal!.modes[0].freq, f)).toBeLessThan(0.06);
    expect(r.mass).toBeCloseTo(2078.5, 0);
  });
});

describe("drops", () => {
  it("scales a 1 g landing to the peak deceleration of the fall", () => {
    const block = part("block", [0, 0, 0], [40, 40, 20]);
    const inp = (height: number, floor: { name: string; E?: number; soft?: number }) =>
      base({
        parts: [block],
        supports: [{ region: { t: "extreme", dir: [0, 0, -1] } }],
        accel: [0, 0, -1],
        drop: { height, dir: [0, 0, -1], floor },
      });
    const hard = runStructural(inp(1000, { name: "concrete", E: 30000 })).drop!;
    const soft = runStructural(inp(1000, { name: "carpet", soft: 0.05 })).drop!;
    // 250 g of steel: weight about 2.5 N
    expect(hard.weight).toBeCloseTo(0.25 * 9.80665, 1);
    expect(hard.speed).toBeCloseTo(Math.sqrt(2 * 9.80665), 2);
    expect(hard.g).toBeGreaterThan(100);
    expect(soft.g).toBeLessThan(hard.g / 5);
    expect(hard.force).toBeCloseTo(hard.g * hard.weight, 3);
    // energy balance: W h = ½ F² (1/k_body + 1/k_floor)
    const lhs = hard.weight * 1000;
    const rhs = 0.5 * hard.force ** 2 * (1 / hard.bodyStiffness + 1 / hard.floorStiffness);
    expect(rel(rhs, lhs)).toBeLessThan(1e-6);
    // twice the height: √2 times the deceleration
    const higher = runStructural(inp(2000, { name: "concrete", E: 30000 })).drop!;
    expect(rel(higher.g, hard.g * Math.SQRT2)).toBeLessThan(1e-6);
  });

  it("works out how far a tall box falls when it tips over", () => {
    const tower = part("tower", [0, 0, 0], [20, 20, 100]);
    const r = runStructural(
      base({ parts: [tower], supports: [{ region: { t: "extreme", dir: [1, 0, 0] } }], accel: [1, 0, 0], drop: { tip: true, dir: [1, 0, 0], floor: { name: "wood", E: 10000 } } }),
    ).drop!;
    // its centre drops from 50 mm up to 10 mm (half its width) once on its side
    expect(r.height).toBeCloseTo(40, 0);
    expect(r.tip).toBe(true);
  });
});
