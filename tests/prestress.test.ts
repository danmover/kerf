// Natural frequencies under load (pre-stressed modal): the loads' stress adds
// its geometric stiffness, so tension lifts a column's bending frequencies and
// compression lowers them, toward zero at the buckling load. For a column,
// ω² ≈ ω₀² (1 − P / P_cr) (exact for pinned ends, close for a cantilever).

import { describe, expect, it } from "vitest";
import { FeaError, runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import { boxMesh, type V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { vibrationText, vibrationVerdict } from "../src/analysis/dynamics";
import type { StructuralSpec } from "../src/analysis/spec";
import { evaluate } from "../src/lang/evaluator";

const L = 200;
const column: FeaPart = { id: "col", name: "col", mesh: boxMesh([0, 0, 0], [10, 10, L]), material: 0 };
const foot = { region: { t: "face" as const, part: "col", dir: [0, 0, -1] as V3 } };
const top = (fz: number) => ({ t: "force" as const, region: { t: "face" as const, part: "col", dir: [0, 0, 1] as V3 }, f: [0, 0, fz] as V3 });

function input(over: Partial<StructuralInput>): StructuralInput {
  return { label: "test", parts: [column], materials: [mechMaterial("Steel")], supports: [foot], loads: [], target: 8000, printed: false, buildDir: [0, 0, 1], safety: 2, ...over };
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("natural frequencies under load", () => {
  it("lifts them in tension and lowers them in compression, as the buckling load says", { timeout: 60_000 }, () => {
    const free = runStructural(input({ modes: 2 }));
    const f0 = free.modal!.modes[0].freq;
    // the column's own buckling load, from the same model
    const buck = runStructural(input({ loads: [top(-1000)], buckling: { modes: 1 } }));
    const Pcr = buck.buckling!.factors[0] * 1000;
    const P = 0.5 * Pcr;

    const pulled = runStructural(input({ modes: 2, prestress: true, loads: [top(P)] }));
    const pushed = runStructural(input({ modes: 2, prestress: true, loads: [top(-P)] }));
    const fp = pulled.modal!.modes[0].freq;
    const fc = pushed.modal!.modes[0].freq;
    expect(rel(fp / f0, Math.sqrt(1.5))).toBeLessThan(0.06);
    expect(rel(fc / f0, Math.sqrt(0.5))).toBeLessThan(0.06);
    // each mode keeps its unloaded frequency for comparison, which is the free run's
    expect(rel(pulled.modal!.unloaded![0], f0)).toBeLessThan(1e-3);
    expect(pushed.modal!.buckles).toBe(false);
    // the stress result is still the static one under the loads
    expect(pushed.maxStress.value).toBeGreaterThan(0.5 * (P / 100));
  });

  it("says when the loads would buckle it", { timeout: 60_000 }, () => {
    const buck = runStructural(input({ loads: [top(-1000)], buckling: { modes: 1 } }));
    const Pcr = buck.buckling!.factors[0] * 1000;
    const r = runStructural(input({ modes: 1, prestress: true, loads: [top(-1.4 * Pcr)] }));
    expect(r.modal!.buckles).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/would buckle/);
    const spec = { label: "test", modal: { modes: 1, prestressed: true, excite: [], damping: 0.02 } } as unknown as StructuralSpec;
    expect(vibrationVerdict(spec, r)).toBe("fail");
    expect(vibrationText(spec, r).detail).toMatch(/would buckle/);
  });

  it("needs loads, and is not mixed with shaking", () => {
    expect(() => runStructural(input({ modes: 2, prestress: true }))).toThrow(FeaError);
    expect(() => runStructural(input({ prestress: true, loads: [top(100)] }))).toThrow(/goes with modes/);
  });
});

describe("prestressed in an analysis block", () => {
  const design = `design "p"
part col { body box(10, 10, 200, at: (0, 0, 100)) }
`;
  const evalA = (block: string) => {
    const m = evaluate(design + block);
    return { errors: m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), a: m.analyses[0] as StructuralSpec };
  };

  it("turns the modes on under the loads", () => {
    const r = evalA(`analysis "Tight" {
  parts: [col]
  fix: face(col, -Z)
  load: force(face(col, +Z), (0, 0, 2kN))
  prestressed
}`);
    expect(r.errors).toEqual([]);
    expect(r.a.modal).toMatchObject({ modes: 6, prestressed: true });
    const q = evalA(`analysis "Tight" {
  parts: [col]
  fix: face(col, -Z)
  gravity
  modes: 3
  prestressed: true
}`);
    expect(q.errors).toEqual([]);
    expect(q.a.modal).toMatchObject({ modes: 3, prestressed: true });
  });

  it("explains what it needs", () => {
    expect(evalA(`analysis "x" { parts: [col]\n fix: face(col, -Z)\n modes: 3\n prestressed }`).errors[0]).toMatch(/needs loads/);
    expect(evalA(`analysis "x" { parts: [col]\n fix: face(col, -Z)\n shake: sine(10Hz, 200Hz, 1g, Z)\n prestressed }`).errors[0]).toMatch(/unloaded/);
  });
});
