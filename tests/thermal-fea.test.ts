// Heat, thermal stress and buckling checked against textbook answers: conduction
// through a bar, a cooling fin, a lumped warm-up, radiation, a bar heated
// between rollers, and Euler columns.

import { describe, expect, it } from "vitest";
import { FeaError, runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import { runConverged } from "../src/analysis/fe/convergence";
import { accuracyText, temperatureText, temperatureVerdict } from "../src/analysis/thermalSummary";
import type { ThermalInput } from "../src/analysis/fe/thermal";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { thermalMaterial } from "../src/analysis/thermalMaterials";
import { evaluate } from "../src/lang/evaluator";
import type { StructuralSpec } from "../src/analysis/spec";

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

const bar = (name: string, lo: V3, hi: V3, material = 0): FeaPart => ({ id: name, name, mesh: gridBox(lo, hi, [20, 4, 4]), material });

function heat(over: Partial<ThermalInput>): ThermalInput {
  return { heat: [], fixed: [], cooling: 0, coolingText: "sealed", films: [], ambient: 20, ...over };
}

function input(material: string, over: Partial<StructuralInput>): StructuralInput {
  return {
    label: "test",
    parts: [bar("bar", [0, 0, 0], [100, 10, 10])],
    materials: [mechMaterial(material)],
    thermalMaterials: [thermalMaterial(material)],
    supports: [],
    loads: [],
    target: 8000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  };
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const face = (dir: V3, part = "bar") => ({ t: "face" as const, part, dir });

/** Temperature on the part's surface nearest a point. */
function tempAt(r: ReturnType<typeof runStructural>, p: V3): number {
  const f = r.parts[0];
  let best = 0,
    bd = Infinity;
  for (let v = 0; v < f.positions.length / 3; v++) {
    const d = Math.hypot(f.positions[3 * v] - p[0], f.positions[3 * v + 1] - p[1], f.positions[3 * v + 2] - p[2]);
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return f.temp![best];
}

describe("heat conduction", () => {
  it("carries heat along a bar by Fourier's law", () => {
    // 5 W into one end of an aluminium bar, the other end held at 20 °C, sides insulated: ΔT = Q·L/(k·A)
    const r = runStructural(input("Aluminum 6061", { thermal: heat({ heat: [{ region: face([1, 0, 0]), watts: 5, label: "heater" }], fixed: [{ region: face([-1, 0, 0]), temp: 20 }] }) }));
    const k = 167e-3; // W/(mm·K)
    const dT = (5 * 100) / (k * 100);
    expect(r.heatOnly).toBe(true);
    expect(rel(r.thermal!.maxTemp.value - 20, dT)).toBeLessThan(0.02);
    // linear along the bar
    expect(rel(tempAt(r, [50, 5, 10]) - 20, dT / 2)).toBeLessThan(0.03);
    expect(r.thermal!.balance!.held).toBeCloseTo(5, 3);
    expect(r.ranges.temp![1]).toBeGreaterThan(20 + 0.95 * dT);
  });

  it("matches the fin equation for a bar cooled along its sides", () => {
    // base held at 80 °C in 20 °C air with h = 25 W/m²K on every other face: θ(x)/θb = cosh m(L−x) / cosh mL,
    // with the end face's cooling folded in as the usual corrected length L + A/P
    const r = runStructural(input("Steel", { thermal: heat({ cooling: 25, coolingText: "breeze", fixed: [{ region: face([-1, 0, 0]), temp: 80 }] }) }));
    const k = 50e-3,
      h = 25e-6,
      A = 100,
      P = 40,
      L = 100 + A / P;
    const m = Math.sqrt((h * P) / (k * A));
    const tip = 20 + 60 / Math.cosh(m * L);
    const mid = 20 + (60 * Math.cosh(m * (L - 50))) / Math.cosh(m * L);
    expect(Math.abs(tempAt(r, [100, 5, 5]) - tip)).toBeLessThan(0.03 * 60);
    expect(Math.abs(tempAt(r, [50, 5, 10]) - mid)).toBeLessThan(0.03 * 60);
    // the heat drawn from the base, all of it leaving through the films: Q = √(hPkA)·θb·tanh(m·L)
    const Q = Math.sqrt(h * P * k * A) * 60 * Math.tanh(m * L);
    const b = r.thermal!.balance!;
    expect(rel(b.film, Q)).toBeLessThan(0.03);
    expect(b.made).toBe(0);
  });

  it("warms a small copper block up like a lumped mass", () => {
    // Biot number ≈ 1e-3: T(t) = T∞ + Q/(hA)·(1 − e^(−t/τ)), τ = ρ·c·V/(h·A)
    const cube: FeaPart = { id: "c", name: "block", mesh: gridBox([0, 0, 0], [20, 20, 20], [4, 4, 4]), material: 0 };
    const hA = 50e-6 * 6 * 400;
    const tau = (8.96e-3 * 0.385 * 8000) / hA;
    const r = runStructural(input("Copper", { parts: [cube], thermal: heat({ cooling: 50, coolingText: "fan", heat: [{ part: "block", watts: 3, label: "chip" }], time: tau }) }));
    const want = 20 + (3 / hA) * (1 - Math.exp(-1));
    const tr = r.thermal!.transient!;
    expect(tr.times.at(-1)).toBeCloseTo(tau, 6);
    expect(rel(tr.max.at(-1)! - 20, want - 20)).toBeLessThan(0.03);
    // and settles at Q/(hA) above the air
    expect(rel(tr.settles! - 20, 3 / hA)).toBeLessThan(0.01);
    expect(tr.overLimit).toBeNull();
  });

  it("radiates heat away from a hot surface", () => {
    // a copper block held at nothing, 10 W in, still air convection plus radiation at ε 0.9: Q = hA·θ + εσA(T⁴ − T∞⁴)
    const cube: FeaPart = { id: "c", name: "block", mesh: gridBox([0, 0, 0], [20, 20, 20], [4, 4, 4]), material: 0 };
    const r = runStructural(input("Copper", { parts: [cube], thermal: heat({ cooling: 5, coolingText: "still air", emissivity: 0.9, heat: [{ part: "block", watts: 10, label: "chip" }] }) }));
    const A = 2400,
      T = r.thermal!.maxTemp.value;
    const out = 5e-6 * A * (T - 20) + 0.9 * 5.670374e-14 * A * ((T + 273.15) ** 4 - 293.15 ** 4);
    expect(rel(out, 10)).toBeLessThan(0.02);
    const b = r.thermal!.balance!;
    expect(b.radiation).toBeGreaterThan(0.3 * b.made);
    expect(rel(b.film + b.radiation, 10)).toBeLessThan(0.01);
  });

  it("refuses a steady state when the heat has nowhere to go", () => {
    expect(() => runStructural(input("PLA", { thermal: heat({ heat: [{ part: "bar", watts: 1, label: "chip" }] }) }))).toThrow(FeaError);
    expect(() => runStructural(input("PLA", { thermal: heat({ heat: [{ part: "bar", watts: 1, label: "chip" }] }) }))).toThrow(/nowhere to go/);
    // a warm-up is fine: it just keeps heating
    const r = runStructural(input("PLA", { thermal: heat({ heat: [{ part: "bar", watts: 1, label: "chip" }], time: 600 }) }));
    expect(r.thermal!.transient!.settles).toBeNull();
    // 1 W for 600 s into 12.4 g of PLA at 1.8 J/gK is 26.9 °C
    expect(rel(r.thermal!.transient!.max.at(-1)! - 20, 600 / (12.4 * 1.8))).toBeLessThan(0.02);
    // PLA would only pass its 52 °C limit after (52 − 20)·12.4·1.8 / 1 ≈ 714 s
    expect(r.thermal!.transient!.overLimit).toBeNull();
  });

  it("says when a part passes its limit during a warm-up", () => {
    const r = runStructural(input("PLA", { thermal: heat({ heat: [{ part: "bar", watts: 2, label: "chip" }], time: 900 }) }));
    const over = r.thermal!.transient!.overLimit!;
    expect(over.part).toBe("bar");
    expect(rel(over.time, ((52 - 20) * 12.4 * 1.8) / 2)).toBeLessThan(0.05);
  });
});

describe("thermal stress", () => {
  // three rollers hold the bar without stopping it growing sideways
  const rollers = [
    { region: face([-1, 0, 0]), dir: [1, 0, 0] as V3 },
    { region: face([0, -1, 0]), dir: [0, 1, 0] as V3 },
    { region: face([0, 0, -1]), dir: [0, 0, 1] as V3 },
  ];

  it("lets a free bar grow by α·ΔT·L without stress", () => {
    const r = runStructural(input("Steel", { supports: rollers, uniformTemp: 70 }));
    const grow = 12e-6 * 50;
    expect(rel(r.maxDisp.value, grow * Math.hypot(100, 10, 10))).toBeLessThan(0.01);
    expect(r.maxStress.value).toBeLessThan(1);
    expect(r.thermal!.refTemp).toBe(20);
  });

  it("gives E·α·ΔT in a bar held at both ends", () => {
    const held = [...rollers, { region: face([1, 0, 0]), dir: [1, 0, 0] as V3 }];
    const r = runStructural(input("Steel", { supports: held, uniformTemp: 70 }));
    expect(rel(r.maxStress.value, 200000 * 12e-6 * 50)).toBeLessThan(0.02);
    // the same from a heat solve: both ends held at 70 °C and no cooling, so the whole bar sits at 70 °C
    const h = runStructural(input("Steel", { supports: held, refTemp: 20, thermal: heat({ fixed: [{ region: face([-1, 0, 0]), temp: 70 }, { region: face([1, 0, 0]), temp: 70 }] }) }));
    expect(rel(h.maxStress.value, 120)).toBeLessThan(0.02);
    expect(h.heatOnly).toBeFalsy();
    expect(h.parts[0].temp).toBeDefined();
  });

  it("weakens a hot plastic", () => {
    const load = [{ t: "force" as const, region: face([1, 0, 0]), f: [0, 0, -20] as V3 }];
    const fix = [{ region: face([-1, 0, 0]) }];
    const cold = runStructural(input("PLA", { supports: fix, loads: load }));
    const warm = runStructural(input("PLA", { supports: fix, loads: load, uniformTemp: 45, refTemp: 45 }));
    expect(warm.minSafety.value).toBeLessThan(0.75 * cold.minSafety.value);
    expect(warm.minSafety.tempC).toBeCloseTo(45, 3);
    // and it bends further
    expect(warm.maxDisp.value).toBeGreaterThan(1.3 * cold.maxDisp.value);
  });
});

describe("buckling", () => {
  const column = (h: number): FeaPart => ({ id: "col", name: "col", mesh: gridBox([0, 0, 0], [10, 10, h], [4, 4, 20]), material: 0 });

  it("matches Euler for a column fixed at its foot", () => {
    // P = π²EI / (4L²)
    const L = 200;
    const r = runStructural(
      input("Steel", {
        parts: [column(L)],
        supports: [{ region: face([0, 0, -1], "col") }],
        loads: [{ t: "force", region: face([0, 0, 1], "col"), f: [0, 0, -1000] }],
        buckling: { modes: 2 },
      }),
    );
    const P = (Math.PI ** 2 * 200000 * (10 ** 4 / 12)) / (4 * L * L);
    const b = r.buckling!;
    expect(b.factors.length).toBeGreaterThan(0);
    expect(rel(b.factors[0], P / 1000)).toBeLessThan(0.08);
    // the square section buckles the same way about X and Y
    expect(rel(b.factors[1], b.factors[0])).toBeLessThan(0.05);
    // its top moves most
    expect(b.peaks[0][2]).toBeGreaterThan(0.9 * L);
    expect(r.parts[0].modes?.length).toBe(2);
  });

  it("finds nothing to buckle when the column is pulled", () => {
    const r = runStructural(
      input("Steel", {
        parts: [column(200)],
        supports: [{ region: face([0, 0, -1], "col") }],
        loads: [{ t: "force", region: face([0, 0, 1], "col"), f: [0, 0, 1000] }],
        buckling: { modes: 1 },
      }),
    );
    expect(r.buckling!.factors).toEqual([]);
    expect(r.buckling!.reversed).not.toBeNull();
  });
});

describe("verdicts and the accuracy check", () => {
  it("fails a part that runs past its limit and says how to cool it", () => {
    const r = runStructural(input("PLA", { thermal: heat({ heat: [{ part: "bar", watts: 2, label: "chip" }], time: 900 }) }));
    const v = temperatureVerdict(r)!;
    expect(v.status).toBe("fail");
    expect(v.worst.name).toBe("bar");
    expect(v.margin).toBeLessThan(0);
    const t = temperatureText(r)!;
    expect(t.detail).toMatch(/passes its limit after/);
    expect(t.fix).toBeDefined();
  });

  it("passes a part that stays well inside its limit", () => {
    const r = runStructural(input("Aluminum 6061", { thermal: heat({ heat: [{ region: face([1, 0, 0]), watts: 5, label: "heater" }], fixed: [{ region: face([-1, 0, 0]), temp: 20 }] }) }));
    expect(temperatureVerdict(r)!.status).toBe("pass");
    expect(temperatureText(r)!.fix).toBeUndefined();
  });

  it("solves twice with smaller elements and reports how far the answers moved", () => {
    const r = runConverged(input("Steel", { supports: [{ region: face([-1, 0, 0]) }], loads: [{ t: "force", region: face([1, 0, 0]), f: [0, 0, -100] }], target: 3000 }));
    const c = r.convergence!;
    expect(c.fine.h).toBeLessThan(c.coarse.h / 1.3);
    expect(c.fine.elements).toBeGreaterThan(2 * c.coarse.elements);
    // bending converges quickly with these elements
    expect(c.change.disp).toBeLessThan(0.1);
    expect(accuracyText(r)!.detail).toMatch(/mm elements and again with/);
  });
});

describe("heat, temperature and buckling in analysis blocks", () => {
  const design = `design "h"
part mount { body box(60, 40, 4) }
part motor { body box(30, 30, 30, at: (0, 0, 17)) }
`;
  const evalA = (block: string) => {
    const m = evaluate(design + block);
    return { m, errors: m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), a: m.analyses[0] as StructuralSpec };
  };

  it("reads a heat analysis with sources, cooling, films and a held surface", () => {
    const { errors, a } = evalA(`analysis "Motor heat" {
  parts: [mount, motor]
  heat: [source(motor, 12W), source(face(mount, +Z), 2W, name: "heater")]
  hold: temp(face(mount, -Z), 40C)
  cooling: ["fan", film(face(motor, +Z), 800, air: 15C)]
  ambient: 30C
  time: 10min
  max_temp: 90C
}`);
    expect(errors).toEqual([]);
    expect(a.supports).toEqual([]);
    const t = a.thermal!;
    expect(t.heat[0]).toMatchObject({ part: "motor", watts: 12, label: "motor" });
    expect(t.heat[1]).toMatchObject({ region: { t: "face", part: "mount" }, watts: 2, label: "heater" });
    expect(t.fixed[0]).toMatchObject({ temp: 40 });
    expect(t.cooling).toBe(50);
    expect(t.films[0]).toMatchObject({ h: 800, ambient: 15 });
    expect(t).toMatchObject({ ambient: 30, time: 600, maxTemp: 90, auto: false });
  });

  it("finds the parts from the heat sources, and uses convection alone with emissivity", () => {
    const { errors, a } = evalA(`analysis "Warm" {
  heat: source(motor, 5W)
  cooling: "still air"
  emissivity: 0.9
}`);
    expect(errors).toEqual([]);
    expect(a.parts).toEqual(["motor"]);
    expect(a.thermal!.cooling).toBe(5);
    expect(a.thermal!.emissivity).toBe(0.9);
  });

  it("turns heat with fix: into thermal stress, and reads a set temperature and buckling", () => {
    let r = evalA(`analysis "Hot mount" {
  parts: [mount, motor]
  heat: ["auto", source(motor, 3W)]
  fix: face(mount, -Z)
  assembled_at: 18C
  converge
}`);
    expect(r.errors).toEqual([]);
    expect(r.a.thermal!.auto).toBe(true);
    expect(r.a.refTemp).toBe(18);
    expect(r.a.converge).toBe(true);
    r = evalA(`analysis "Sun" {
  parts: [mount]
  fix: face(mount, -X)
  temperature: 60C
}`);
    expect(r.errors).toEqual([]);
    expect(r.a.uniformTemp).toBe(60);
    r = evalA(`analysis "Column" {
  parts: [motor]
  fix: face(motor, -Z)
  load: force(face(motor, +Z), (0, 0, -500N))
  buckling: 2
  buckling_safety: 4
}`);
    expect(r.errors).toEqual([]);
    expect(r.a.buckling).toEqual({ modes: 2, safety: 4 });
    r = evalA(`analysis "Column" {
  parts: [motor]
  fix: face(motor, -Z)
  load: force(face(motor, +Z), (0, 0, -500N))
  buckling
}`);
    expect(r.a.buckling).toEqual({ modes: 3, safety: 3 });
  });

  it("explains heat set-ups that do not make sense", () => {
    expect(evalA(`analysis "x" { parts: [mount]\n cooling: "fan"\n fix: face(mount, -Z)\n gravity }`).errors[0]).toMatch(/goes with heat:/);
    expect(evalA(`analysis "x" { parts: [mount]\n heat: 5W }`).errors[0]).toMatch(/say where the 5 W is made/);
    expect(evalA(`analysis "x" { heat: source(motor, 5W)\n cooling: "breezy" }`).errors[0]).toMatch(/not one Kerf knows/);
    expect(evalA(`analysis "x" { parts: [mount]\n temperature: 60C }`).errors[0]).toMatch(/add fix:/);
    expect(evalA(`analysis "x" { heat: source(motor, 5W)\n temperature: 60C\n fix: face(motor, -Z) }`).errors[0]).toMatch(/one or the other/);
    expect(evalA(`analysis "x" { parts: [mount]\n fix: face(mount, -Z)\n buckling }`).errors[0]).toMatch(/needs loads/);
  });
});
