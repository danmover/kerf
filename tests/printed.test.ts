import { describe, expect, it } from "vitest";
import { constitutive, layeredConstitutive } from "../src/analysis/fe/element";
import { runStructural, type FeaPart, type PartPrint, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { partPrint } from "../src/analysis/runtime";
import type { StructuralSpec } from "../src/analysis/spec";
import { evaluate } from "../src/lang/evaluator";
import { fdmPrint, infillStiffness, infillStrength, layerStiffness, printWords } from "../src/mfg/infill";
import { printUp } from "../src/mfg/printOrientation";

/** Closed box surface with its faces split into a grid. */
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

const pla = mechMaterial("PLA");
const print = (over: Partial<PartPrint>): PartPrint => ({ build: [0, 0, 1], wall: 4 * 0.44, skin: 5 * 0.2, infill: 1, pattern: "gyroid", words: "", from: "bed", ...over });

function cantilever(p: Partial<PartPrint> | null, size: V3 = [100, 10, 10], over: Partial<StructuralInput> = {}) {
  const part: FeaPart = { id: "beam", name: "beam", mesh: gridBox([0, 0, 0], size, [20, 4, 4]), material: 0, ...(p ? { print: print(p) } : {}) };
  return runStructural({
    label: "printed",
    parts: [part],
    materials: [pla],
    supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] } }],
    loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -20] }],
    target: 8000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  });
}

describe("printed infill and layers", () => {
  it("scales an infill's stiffness and strength with its density", () => {
    expect(infillStiffness(1, "gyroid")).toBe(1);
    expect(infillStrength(1, "grid")).toBe(1);
    expect(infillStiffness(0, "gyroid")).toBe(0);
    expect(infillStiffness(0.4, "gyroid")).toBeCloseTo(0.155, 2);
    for (const p of ["gyroid", "grid", "cubic", "honeycomb", "lines", "lightning"] as const) {
      let last = 0;
      for (const rho of [0.1, 0.2, 0.4, 0.6, 0.8, 0.95, 1]) {
        const k = infillStiffness(rho, p);
        expect(k).toBeGreaterThan(last);
        expect(k).toBeLessThanOrEqual(1);
        last = k;
      }
    }
    expect(infillStiffness(0.15, "lightning")).toBeLessThan(0.01);
    // fibre-filled filaments are much softer across their layers than plain ones
    expect(layerStiffness(pla).rE).toBeGreaterThan(0.75);
    expect(layerStiffness(mechMaterial("PA-CF")).rE).toBeLessThan(0.5);
    expect(layerStiffness(mechMaterial("Steel"))).toEqual({ rE: 1, rG: 1 });
  });

  it("reads walls, skins and infill from an fdm process, with Kerf's defaults", () => {
    const d = fdmPrint();
    expect(d).toMatchObject({ walls: 4, top: 5, infill: 0.4, pattern: "gyroid", layer: 0.2 });
    expect(d.line).toBeCloseTo(0.44, 6);
    expect(printWords(d)).toBe("4 walls, 5 top and bottom layers, 40 % gyroid infill");
    const p = fdmPrint({ id: "fdm", settings: { walls: 2, top: 3, infill: 15, pattern: "grid", layer: 0.28, nozzle: 0.6 } });
    expect(p).toMatchObject({ walls: 2, top: 3, infill: 0.15, pattern: "grid", layer: 0.28 });
    expect(printWords(fdmPrint({ id: "fdm", settings: { infill: 1 } }))).toBe("solid (100 % infill)");
  });

  it("builds a layered constitutive matrix that turns with the build direction", () => {
    const iso = constitutive(0.35);
    const same = layeredConstitutive(0.35, 1, 1, [0, 0, 1]);
    for (let i = 0; i < 36; i++) expect(same[i]).toBeCloseTo(iso[i], 9);
    const z = layeredConstitutive(0.35, 0.6, 0.7, [0, 0, 1]);
    const x = layeredConstitutive(0.35, 0.6, 0.7, [1, 0, 0]);
    // softer across the layers: zz along Z, xx along X
    expect(z[14]).toBeLessThan(z[0]);
    expect(x[0]).toBeCloseTo(z[14], 9);
    expect(x[14]).toBeCloseTo(z[0], 9);
    // symmetric, and the turned one is the same material at 45° too
    const t = layeredConstitutive(0.35, 0.6, 0.7, [Math.SQRT1_2, 0, Math.SQRT1_2]);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) expect(t[i * 6 + j]).toBeCloseTo(t[j * 6 + i], 12);
    expect(t[0]).toBeCloseTo(t[14], 9);
  });

  it("bends more when the layers stack along the beam than across it", () => {
    const along = cantilever({ build: [0, 0, 1] });
    const across = cantilever({ build: [1, 0, 0] });
    const solid = cantilever(null);
    expect(along.solve.converged && across.solve.converged).toBe(true);
    // layers in the bending plane: the stress runs along them, about as stiff as the solid
    expect(along.maxDisp.value / solid.maxDisp.value).toBeLessThan(1.06);
    // stacked along the beam: the bending stress pulls straight across them, the softer way
    const ratio = across.maxDisp.value / solid.maxDisp.value;
    expect(ratio).toBeGreaterThan(1 / layerStiffness(pla).rE - 0.08);
    expect(ratio).toBeLessThan(1 / layerStiffness(pla).rE + 0.08);
    expect(across.minSafety.mode).toBe("layers");
    expect(along.minSafety.mode).not.toBe("layers");
    expect(across.printing?.[0]).toMatchObject({ part: "beam", solid: 1, across: layerStiffness(pla).rE });
  });

  it("models walls and skins round a sparse infill: lighter and softer, weaker inside", () => {
    const size: V3 = [100, 20, 20];
    const solid = cantilever({ infill: 1 }, size, { loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -100] }] });
    const sparse = cantilever({ infill: 0.4 }, size, { loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -100] }] });
    const share = sparse.printing![0].solid;
    // walls 1.76 mm round each 100 × 20 layer outline, 1 mm skins on top and bottom: about 28 % of it is solid
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.45);
    expect(sparse.mass / solid.mass).toBeCloseTo(share + (1 - share) * 0.4, 1);
    expect(sparse.maxDisp.value).toBeGreaterThan(solid.maxDisp.value * 1.05);
    // the walls still carry the bending: the lowest safety factor stays in them, not in the infill
    expect(sparse.minSafety.infill).toBeUndefined();
    // a thick block pressed in the middle crushes its infill first
    const block: FeaPart = { id: "blk", name: "blk", mesh: gridBox([0, 0, 0], [40, 40, 40], [8, 8, 8]), material: 0, print: print({ infill: 0.15, pattern: "gyroid", wall: 0.88, skin: 0.6 }) };
    const pressed = runStructural({
      label: "crush",
      parts: [block],
      materials: [pla],
      supports: [{ region: { t: "face", part: "blk", dir: [0, 0, -1] } }],
      loads: [{ t: "pressure", region: { t: "box", at: [20, 20, 40], size: [40, 40, 2] }, p: 0.5 }],
      target: 8000,
      printed: false,
      buildDir: [0, 0, 1],
      safety: 2,
    });
    expect(pressed.printing![0].solid).toBeLessThan(0.25);
    expect(pressed.mass).toBeLessThan((40 ** 3 / 1000) * pla.density * 0.45);
  });

  it("slides a twisted upright print's layers: shear between layers sets the safety factor", () => {
    const rod: FeaPart = { id: "rod", name: "rod", mesh: gridBox([-5, -5, 0], [5, 5, 60], [4, 4, 24]), material: 0, print: print({ build: [0, 0, 1] }) };
    const r = runStructural({
      label: "twist",
      parts: [rod],
      materials: [pla],
      supports: [{ region: { t: "face", part: "rod", dir: [0, 0, -1] } }],
      loads: [{ t: "torque", region: { t: "face", part: "rod", dir: [0, 0, 1] }, torque: 2000, axis: [0, 0, 1], at: [0, 0, 60] }],
      target: 8000,
      printed: false,
      buildDir: [0, 0, 1],
      safety: 2,
    });
    expect(r.minSafety.mode).toBe("layers");
  });
});

describe("how the analysis reads a part's print", () => {
  const src = `design "p"
part bracket {
  material: "PETG"
  process: mfg.fdm(walls: 3, infill: 20%, pattern: "grid", build: X)
  body box(40, 4, 30)
}
part plate {
  material: "PLA"
  body box(40, 4, 30)
}
part arm {
  material: "Steel"
  body box(40, 4, 30)
}
part lid {
  material: "PETG"
  process: mfg.injection()
  body box(40, 4, 30)
}
`;
  const m = evaluate(src);
  const part = (name: string) => m.parts.find((p) => p.name === name)!;
  const mesh = (() => {
    const g = gridBox([-20, -2, -15], [20, 2, 15], [4, 2, 3]);
    return { positions: Float32Array.from(g.positions), indices: g.indices, normals: new Float32Array(g.positions.length), edges: new Float32Array(0) };
  })();
  const id = (v: V3): V3 => v;
  const spec = { printed: undefined, buildDir: [0, 0, 1] } as unknown as StructuralSpec;

  it("takes walls, infill and build: from an fdm process", () => {
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const p = partPrint(spec, part("bracket"), mechMaterial("PETG"), mesh, id)!;
    expect(p).toMatchObject({ infill: 0.2, pattern: "grid", from: "process", build: [1, 0, 0] });
    expect(p.wall).toBeCloseTo(3 * 0.44, 6);
    expect(p.skin).toBeCloseTo(5 * 0.2, 6);
    // a part turned in the design turns its layers with it
    const turned = partPrint(spec, part("bracket"), mechMaterial("PETG"), mesh, (v) => [-v[1], v[0], v[2]])!;
    expect(turned.build[1]).toBeCloseTo(1, 9);
  });

  it("lays a filament part without a process on its largest flat face, as the build pack does", () => {
    const p = partPrint(spec, part("plate"), mechMaterial("PLA"), mesh, id)!;
    expect(p.from).toBe("bed");
    expect(Math.abs(p.build[1])).toBeCloseTo(1, 9);
    expect(p.infill).toBe(0.4);
    expect(printUp(mesh.positions, mesh.indices, [0, 0, 1])).toEqual([0, 0, 1]);
  });

  it("leaves metal, moulded and printed: false parts solid, and lets build: in the analysis override", () => {
    expect(partPrint(spec, part("arm"), mechMaterial("Steel"), mesh, id)).toBeUndefined();
    expect(partPrint(spec, part("lid"), mechMaterial("PETG"), mesh, id)).toBeUndefined();
    expect(partPrint({ ...spec, printed: false }, part("plate"), mechMaterial("PLA"), mesh, id)).toBeUndefined();
    const over = partPrint({ ...spec, buildDir: [0, 1, 0], buildGiven: true }, part("bracket"), mechMaterial("PETG"), mesh, id)!;
    expect(over).toMatchObject({ from: "analysis", build: [0, 1, 0] });
  });
});
