import { describe, expect, it } from "vitest";
import { FeaError, MAX_ELEMENTS, runStructural, shareTorque, sizeGrid, type FeaPart, type StructuralInput, type StructuralResult } from "../src/analysis/fe/structural";
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

  it("shares a torque over a lopsided zone as a pure couple", () => {
    // a quarter disc and a bit of wall: not symmetric about the axis or its own centre
    const ps: V3[] = [];
    const w: number[] = [];
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) if (i * i + j * j <= 121) {
        ps.push([i, j, 10]);
        w.push(1 + (i % 3));
      }
    for (let k = 0; k < 5; k++) {
      ps.push([0, 4, 10 - k]);
      w.push(2);
    }
    const T: V3 = [1000, 0, 0];
    const fs = shareTorque(ps, w, T)!;
    const net: V3 = [0, 0, 0];
    const mom: V3 = [0, 0, 0];
    fs.forEach((f, s) => {
      const p = ps[s];
      for (let d = 0; d < 3; d++) net[d] += f[d];
      mom[0] += p[1] * f[2] - p[2] * f[1];
      mom[1] += p[2] * f[0] - p[0] * f[2];
      mom[2] += p[0] * f[1] - p[1] * f[0];
    });
    expect(Math.hypot(...net)).toBeLessThan(1e-9);
    expect(mom[0]).toBeCloseTo(1000, 6);
    expect(Math.abs(mom[1]) + Math.abs(mom[2])).toBeLessThan(1e-6);
    // a line cannot be twisted about itself
    expect(shareTorque([[0, 0, 0], [0, 0, 5]], [1, 1], [0, 0, 10])).toBeNull();
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

  it("finds the lowest safety factor away from supports and loads, wherever it is", () => {
    // PLA root fixed at the wall, steel outboard: the overall lowest sits on the wall, and the
    // lowest a short way off is still in the PLA, at the material's own yield strength
    const r = runStructural(
      base({
        parts: [part("root", [0, 0, 0], [40, 10, 10], 0), part("tip", [40, 0, 0], [100, 10, 10], 1)],
        materials: [mechMaterial("PLA"), mechMaterial("Steel")],
        supports: [{ region: { t: "face", part: "root", dir: [-1, 0, 0] } }],
        loads: [{ t: "force", region: { t: "face", part: "tip", dir: [1, 0, 0] }, f: [0, 0, -20] }],
      }),
    );
    const m = r.minSafety;
    expect(m.nearBoundary).toBe(true);
    expect(m.away).not.toBeNull();
    const away = m.away!;
    expect(away.material).toBe("PLA");
    expect(away.mode).toBe("yield");
    expect(away.value).toBeGreaterThanOrEqual(m.value);
    // beam theory where it was found: σ = 6·F·(L − x) / (b·h²)
    const sigma = (6 * 20 * (100 - away.at[0])) / (10 * 100);
    expect(rel(away.value, 45 / sigma)).toBeLessThan(0.2);
    // nothing well clear of the wall and the loaded end is lower
    for (let pi = 0; pi < r.parts.length; pi++) {
      const f = r.parts[pi];
      for (let v = 0; v < f.positions.length / 3; v++) {
        const x = f.positions[3 * v];
        if (x > 10 && x < 90) expect(f.safety[v]).toBeGreaterThan(away.value * 0.97);
      }
    }
  });
});

describe("analysis size limits", () => {
  it("rejects element sizes below the minimum before meshing", () => {
    expect(() => runStructural(base({ h: 1e-323 }))).toThrow(FeaError);
    expect(() => runStructural(base({ h: 0.05 }))).toThrow(/at least 0\.1 mm/);
    expect(() => runStructural(base({ h: NaN }))).toThrow(/at least 0\.1 mm/);
  });

  it("enlarges a tiny explicit element size to stay within the element limit", () => {
    // 0.3 mm cells in a solid 100 mm block would be 37 million elements
    const { cells, raised } = sizeGrid([100, 100, 100], 1e6, 30_000, 0.3);
    const n = cells![0] * cells![1] * cells![2];
    expect(raised).toBe(true);
    expect(n).toBeLessThanOrEqual(MAX_ELEMENTS);
    expect(n).toBeGreaterThan(0.6 * MAX_ELEMENTS);
  });

  it("stretches cells on a large thin plate rather than go over the limit", () => {
    const { cells } = sizeGrid([1000, 1000, 0.5], 5e5, 30_000, 0.2);
    expect(cells![0] * cells![1] * cells![2]).toBeLessThanOrEqual(MAX_ELEMENTS);
  });

  it("keeps an explicit element size that fits", () => {
    expect(sizeGrid([100, 10, 10], 1e4, 30_000, 1)).toEqual({ cells: [100, 10, 10], raised: false });
  });
});

describe("seats that are only pressed on", () => {
  const block = (loads: StructuralInput["loads"]) =>
    runStructural(
      base({
        parts: [{ id: "block", name: "block", mesh: gridBox([-20, -20, 0], [20, 20, 10], [8, 8, 2]), material: 0 }],
        materials: [mechMaterial("PETG")],
        supports: [{ region: { t: "face", part: "block", dir: [0, 0, -1] }, contact: { mu: 0.5 } }],
        loads,
        target: 4000,
      }),
    ).supports[0].contact!;
  const top = { t: "face" as const, part: "block", dir: [0, 0, 1] as V3 };

  it("is pressed on evenly by a push down its middle", () => {
    const c = block([{ t: "force", region: top, f: [0, 0, -100] }]);
    expect(c.pressing).toBeCloseTo(100, 0);
    expect(c.lift).toBeLessThan(1 / 3);
    expect(c.use).toBeLessThan(0.01);
  });

  it("uses its friction to hold a sideways push", () => {
    const c = block([{ t: "force", region: top, f: [20, 0, -100] }]);
    expect(c.slide).toBeCloseTo(20, 0);
    expect(c.slideCap).toBeCloseTo(50, 0);
    expect(c.use).toBeCloseTo(0.4, 1);
  });

  it("tips over its edge when the push acts beyond it, and comes off when pulled", () => {
    // 100 N down with 3000 N·mm about Y: the push acts 30 mm off the middle of a seat 20 mm half-wide
    const tipped = block([
      { t: "force", region: top, f: [0, 0, -100] },
      { t: "torque", region: top, torque: 3000, axis: [0, 1, 0] },
    ]);
    expect(tipped.lift).toBeGreaterThan(1);
    expect(tipped.liftAt).toBeDefined();
    const pulled = block([{ t: "force", region: top, f: [0, 0, 100] }]);
    expect(pulled.pressing).toBeLessThan(0);
  });
});
