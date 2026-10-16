import { describe, expect, it } from "vitest";
import { runStructural, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { structuralSummary, structuralVerdict, strengthVerdict, stiffnessVerdict, analysisLine } from "../src/analysis/summary";
import type { StructuralSpec } from "../src/analysis/spec";

function box(lo: V3, hi: V3): TriMesh {
  const [a, b, c] = lo;
  const [x, y, z] = hi;
  const P = [a, b, c, x, b, c, x, y, c, a, y, c, a, b, z, x, b, z, x, y, z, a, y, z];
  const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
  return { positions: new Float64Array(P), indices: new Uint32Array(I) };
}

const spec: StructuralSpec = {
  kind: "structural",
  label: "Cantilever",
  parts: ["beam"],
  supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] } }],
  loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -100] }],
  safety: 2,
  maxDeflection: 0.1,
  buildDir: [0, 0, 1],
  resolution: "draft",
  span: { start: 0, end: 0 },
};

const input: StructuralInput = {
  label: spec.label,
  parts: [{ id: "beam", name: "beam", mesh: box([0, 0, 0], [100, 10, 10]), material: 0 }],
  materials: [mechMaterial("Steel")],
  supports: spec.supports,
  loads: spec.loads,
  target: 4000,
  printed: false,
  buildDir: [0, 0, 1],
  safety: 2,
  maxDeflection: 0.1,
};

describe("analysis summaries for the assistant", () => {
  const r = runStructural(input);
  const run = { status: "done" as const, result: r, resolution: "draft" };

  it("states the verdict, the numbers and what they are judged against", () => {
    const text = structuralSummary(spec, run);
    // a 100 N tip load on a 10 mm square steel cantilever deflects ~0.2 mm, over the 0.1 mm limit
    expect(structuralVerdict(spec, r)).toBe("fail");
    expect(text).toMatch(/^Analysis "Cantilever" \(structural; parts: beam\): FAIL\./);
    expect(text).toMatch(/judged against the yield strength of Steel/);
    expect(text).toMatch(/limit 0\.1 mm: FAILS/);
    expect(text).toMatch(/Supports: fixed beam -X face/);
    expect(text).toMatch(/Loads: force totalling 100 N on beam \+X face/);
    expect(text).toMatch(/Reactions balance the loads/);
    expect(analysisLine(spec, run, undefined)).toMatch(/"Cantilever" structural \(beam; 1 support\(s\), 1 load\(s\); safety target 2\): fail, safety \d/);
  });

  it("passes when stiffness and strength both hold", () => {
    expect(structuralVerdict({ ...spec, maxDeflection: undefined }, r)).toBe("pass");
  });

  it("reports set-up errors as something to fix", () => {
    const text = structuralSummary(spec, { status: "error", error: "Nothing holds the part along Z.", setup: true, resolution: "draft" });
    expect(text).toMatch(/cannot be solved as written\. Nothing holds the part along Z\. Fix the analysis block/);
  });
});

describe("verdicts that should not pass", () => {
  const r = runStructural({ ...input, maxDeflection: undefined });
  const free = { ...spec, maxDeflection: undefined };

  it("passes a known material that converged", () => {
    expect(strengthVerdict(free, r).status).toBe("pass");
  });

  it("caps an assumed material at a warning", () => {
    const assumed = { ...r, materials: r.materials.map((m) => ({ ...m, assumed: true, name: "Oak" })) };
    const v = strengthVerdict(free, assumed);
    expect(v.status).toBe("warn");
    expect(v.note).toMatch(/no strength data for Oak/);
    expect(structuralVerdict(free, assumed)).toBe("warn");
  });

  it("neither passes nor fails an unconverged solve", () => {
    const loose = { ...r, solve: { ...r.solve, residual: 0.05 } };
    expect(strengthVerdict(free, loose).status).toBe("warn");
    expect(stiffnessVerdict({ ...spec, maxDeflection: 0.001 }, loose)).toBe("warn");
    expect(structuralVerdict({ ...spec, maxDeflection: 0.001 }, loose)).toBe("warn");
  });

  it("only softens a low safety factor at a support when it holds a short way off", () => {
    const low = { ...r.minSafety, value: 0.8 };
    const atWall = { ...r, minSafety: { ...low, nearBoundary: true, away: { ...low, value: 3, at: [20, 5, 5] as [number, number, number] } } };
    expect(strengthVerdict(free, atWall).status).toBe("warn");
    expect(strengthVerdict(free, atWall).note).toMatch(/a short way off the lowest safety factor is 3/);
    const weakOff = { ...atWall, minSafety: { ...atWall.minSafety, away: { ...low, value: 1.2 } } };
    expect(strengthVerdict(free, weakOff).status).toBe("fail");
  });
});
