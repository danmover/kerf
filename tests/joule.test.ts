// Joule heating: current through conducting parts, checked against hand answers. A copper bar's resistance is ρL/A
// and its heat I²R, rising as it warms; a heater driven by a voltage makes V²/R; current crowds round a hole; bars in
// series add up; plastic carries nothing.

import { describe, expect, it } from "vitest";
import { FeaError, runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { thermalMaterial } from "../src/analysis/thermalMaterials";
import { electricMaterial } from "../src/analysis/electricMaterials";
import type { ThermalInput } from "../src/analysis/fe/thermal";
import type { CurrentSpec, StructuralSpec } from "../src/analysis/spec";
import { evaluate } from "../src/lang/evaluator";
import { temperatureText } from "../src/analysis/thermalSummary";

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

/** A flat plate x0..x1 × y0..y1 × 0..t with a round hole through it along Z. */
function plateWithHole(x0: number, x1: number, y0: number, y1: number, t: number, c: [number, number], r: number, n = 96): TriMesh {
  const corners = [
    [x1, y1],
    [x0, y1],
    [x0, y0],
    [x1, y0],
  ].map(([x, y]) => Math.atan2(y - c[1], x - c[0]));
  const angles = [...Array.from({ length: n }, (_, i) => -Math.PI + (2 * Math.PI * i) / n), ...corners].sort((a, b) => a - b);
  const outer = angles.map((a) => {
    const d = [Math.cos(a), Math.sin(a)];
    let s = Infinity;
    if (d[0] > 1e-12) s = Math.min(s, (x1 - c[0]) / d[0]);
    if (d[0] < -1e-12) s = Math.min(s, (x0 - c[0]) / d[0]);
    if (d[1] > 1e-12) s = Math.min(s, (y1 - c[1]) / d[1]);
    if (d[1] < -1e-12) s = Math.min(s, (y0 - c[1]) / d[1]);
    return [c[0] + s * d[0], c[1] + s * d[1]];
  });
  const inner = angles.map((a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  const pos: number[] = [];
  const m = angles.length;
  for (const [x, y] of inner) pos.push(x, y, 0);
  for (const [x, y] of inner) pos.push(x, y, t);
  for (const [x, y] of outer) pos.push(x, y, 0);
  for (const [x, y] of outer) pos.push(x, y, t);
  const IB = 0,
    IT = m,
    OB = 2 * m,
    OT = 3 * m;
  const idx: number[] = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    idx.push(IT + i, OT + i, OT + j, IT + i, OT + j, IT + j);
    idx.push(IB + i, OB + j, OB + i, IB + i, IB + j, OB + j);
    idx.push(OB + i, OB + j, OT + j, OB + i, OT + j, OT + i);
    idx.push(IB + i, IT + j, IB + j, IB + i, IT + i, IT + j);
  }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

const face = (part: string, dir: V3) => ({ t: "face" as const, part, dir });

function heat(currents: CurrentSpec[], over: Partial<ThermalInput> = {}): ThermalInput {
  return { heat: [], currents, fixed: [], cooling: 10, coolingText: "still air", films: [], ambient: 20, ...over };
}

function solve(parts: FeaPart[], materials: string[], thermal: ThermalInput, over: Partial<StructuralInput> = {}) {
  return runStructural({
    label: "joule",
    parts,
    materials: materials.map((m) => mechMaterial(m)),
    thermalMaterials: materials.map((m) => thermalMaterial(m)),
    electricMaterials: materials.map((m) => electricMaterial(m)),
    supports: [],
    loads: [],
    target: 12000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    thermal,
    ...over,
  });
}

const bar = (name: string, lo: V3, hi: V3, material = 0, div: V3 = [40, 4, 2]): FeaPart => ({ id: name, name, mesh: gridBox(lo, hi, div), material });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("Joule heating", { timeout: 60000 }, () => {
  it("gives a copper bar the resistance ρL/A and heats it by I²R, more as it warms", () => {
    // 100 × 10 × 2 mm copper: ρ = 1.72e-8 Ω·m → R = ρL/A = 0.086 mΩ cold; 100 A makes 0.86 W
    const r = solve([bar("bus", [0, 0, 0], [100, 10, 2])], ["Copper"], heat([{ from: face("bus", [-1, 0, 0]), to: face("bus", [1, 0, 0]), amps: 100, label: "busbar" }]));
    const c = r.thermal!.currents![0];
    expect(rel(c.cold.ohms, 1.72e-8 * 0.1 / 20e-6)).toBeLessThan(0.03);
    expect(rel(c.cold.watts, 100 * 100 * c.cold.ohms)).toBeLessThan(1e-6);
    expect(c.amps).toBeCloseTo(100, 6);
    // still air takes ≈ 10 W/m²K over 2440 mm²: it warms some 35 °C, and copper's resistance rises 0.39 %/°C with it
    const mean = r.thermal!.parts[0].mean;
    expect(mean).toBeGreaterThan(40);
    expect(rel(c.ohms, c.cold.ohms * (1 + 0.00393 * (mean - 20)))).toBeLessThan(0.02);
    expect(c.watts).toBeGreaterThan(c.cold.watts);
    // all the heat made is the current's, and it all leaves through the air
    expect(rel(r.thermal!.balance!.made, c.watts)).toBeLessThan(0.01);
    expect(rel(r.thermal!.balance!.film, c.watts)).toBeLessThan(0.02);
    // the current density is I/A = 5 A/mm² along the bar
    const J = r.parts[0].current!;
    let mid = 0,
      k = 0;
    const P = r.parts[0].positions;
    for (let v = 0; v < J.length; v++)
      if (Math.abs(P[3 * v] - 50) < 15) {
        mid += J[v];
        k++;
      }
    expect(rel(mid / k, 5)).toBeLessThan(0.05);
    expect(r.ranges.current![1]).toBeGreaterThan(4.5);
    expect(r.interior!.current).toBeTruthy();
    expect(r.thermal!.sources[0].label).toContain("busbar");
    // in words: what it meets, the drop across it, the heat once warm and cold, and the densest current
    const text = temperatureText(r)!.detail;
    expect(text).toMatch(/busbar: 100 A from bus -X face to bus \+X face through \d+(\.\d)? µΩ drops \d+(\.\d+)? mV and makes 0?\.?\d+ W \(\d+(\.\d)? µΩ and 0\.\d+ W at 20 °C, before it warms\)/);
    expect(text).toMatch(/runs about evenly, at [45](\.\d+)? A\/mm²/);
  });

  it("drives a heater with a voltage: V²/R, less as it warms", () => {
    // stainless strip 80 × 4 × 1 mm: R = 7.2e-7 × 0.08 / 4e-6 = 14.4 mΩ; 0.3 V makes 6.25 W cold
    const r = solve([bar("strip", [0, 0, 0], [80, 4, 1], 0, [40, 4, 1])], ["Stainless 304"], heat([{ from: face("strip", [-1, 0, 0]), to: face("strip", [1, 0, 0]), volts: 0.3, label: "heater" }], { cooling: 25, coolingText: "fan" }));
    const c = r.thermal!.currents![0];
    expect(c.driven).toBe("volts");
    expect(rel(c.cold.ohms, (7.2e-7 * 0.08) / 4e-6)).toBeLessThan(0.05);
    expect(c.volts).toBeCloseTo(0.3, 9);
    expect(rel(c.watts, (0.3 * 0.3) / c.ohms)).toBeLessThan(1e-6);
    // hotter, so a little more resistance and a little less power than cold
    expect(c.ohms).toBeGreaterThan(c.cold.ohms);
    expect(c.watts).toBeLessThan(c.cold.watts);
  });

  it("crowds the current round a hole in a strip", () => {
    // a 40 mm wide copper strip with a 10 mm hole: the current squeezes past it, densest at its sides
    const part: FeaPart = { id: "plate", name: "plate", mesh: plateWithHole(0, 120, 0, 40, 2, [60, 20], 5), material: 0 };
    const r = solve([part], ["Copper"], heat([{ from: face("plate", [-1, 0, 0]), to: face("plate", [1, 0, 0]), amps: 160, label: "strip" }]), { target: 30000 });
    const peak = r.thermal!.currentPeak!;
    // far from the hole it runs at I/A = 160 / 80 = 2 A/mm²; beside the hole at least 1.5 times that
    expect(peak.value).toBeGreaterThan(3);
    expect(rel(peak.typical, 2)).toBeLessThan(0.15);
    expect(temperatureText(r)!.detail).toMatch(/densest in plate near .*: [\d.]+ A\/mm², [\d.]+× its typical [\d.]+ A\/mm², so it crowds there/);
    expect(Math.abs(peak.at[0] - 60)).toBeLessThan(6);
    expect(Math.abs(Math.abs(peak.at[1] - 20) - 5)).toBeLessThan(4);
  });

  it("adds the resistance of two bars in series, and heats the worse conductor more", () => {
    const r = solve(
      [bar("cu", [0, 0, 0], [60, 10, 3], 0, [30, 4, 2]), bar("al", [60, 0, 0], [120, 10, 3], 1, [30, 4, 2])],
      ["Copper", "Aluminum 6061"],
      heat([{ from: face("cu", [-1, 0, 0]), to: face("al", [1, 0, 0]), amps: 80, label: "joint" }]),
    );
    const c = r.thermal!.currents![0];
    const want = (1.72e-8 * 0.06) / 30e-6 + (3.99e-8 * 0.06) / 30e-6;
    expect(rel(c.cold.ohms, want)).toBeLessThan(0.04);
    expect(c.parts.map((p) => p.name)).toEqual(["al", "cu"]);
    expect(c.parts[0].share).toBeGreaterThan(0.65);
  });

  it("says when the ends are on plastic, or nothing joins them", () => {
    expect(() => solve([bar("p", [0, 0, 0], [50, 10, 3])], ["PETG"], heat([{ from: face("p", [-1, 0, 0]), to: face("p", [1, 0, 0]), amps: 5, label: "c" }]))).toThrow(/does not conduct/);
    expect(() =>
      solve([bar("a", [0, 0, 0], [40, 10, 3], 0, [20, 4, 2]), bar("b", [50, 0, 0], [90, 10, 3], 0, [20, 4, 2])], ["Copper"], heat([{ from: face("a", [-1, 0, 0]), to: face("b", [1, 0, 0]), amps: 5, label: "gap" }])),
    ).toThrow(FeaError);
  });

  it("stops a current that runs away", () => {
    // a thin steel wire carrying far too much: its resistance climbs faster than the air can cool it
    expect(() =>
      solve([bar("w", [0, 0, 0], [100, 1, 1], 0, [50, 2, 2])], ["Steel"], heat([{ from: face("w", [-1, 0, 0]), to: face("w", [1, 0, 0]), amps: 25, label: "wire" }]), { target: 20000 }),
    ).toThrow(/runs away/);
  });
});

describe("current() in the design language", () => {
  const src = (heatLine: string) => `design "j"
part bus { material: "Copper"
  body box(100, 10, 2, at: (50, 5, 0)) }
analysis "Bus" {
  ${heatLine}
  cooling: "still air"
}`;
  it("goes in heat: with amps or volts", () => {
    const m = evaluate(src("heat: current(face(bus, -X), face(bus, +X), 60A, name: \"main\")"));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const a = m.analyses[0] as StructuralSpec;
    expect(a.parts).toEqual(["bus"]);
    expect(a.thermal!.currents).toEqual([{ from: { t: "face", part: "bus", dir: [-1, 0, 0] }, to: { t: "face", part: "bus", dir: [1, 0, 0] }, amps: 60, label: "main" }]);
    const v = evaluate(src("heat: [current(face(bus, -X), face(bus, +X), volts: 12V)]"));
    expect((v.analyses[0] as StructuralSpec).thermal!.currents![0]).toMatchObject({ volts: 12 });
  });
  it("asks for one of amps or volts", () => {
    const both = evaluate(src("heat: current(face(bus, -X), face(bus, +X), 60A, volts: 12V)"));
    expect(both.diagnostics.some((d) => d.severity === "error" && /not both/.test(d.message))).toBe(true);
    const none = evaluate(src("heat: current(face(bus, -X), face(bus, +X))"));
    expect(none.diagnostics.some((d) => d.severity === "error" && /how much flows/.test(d.message))).toBe(true);
  });
});
