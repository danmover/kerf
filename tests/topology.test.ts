// Topology optimisation: the stiffest shape for the loads that keeps a share of the material. A cantilever plate
// keeps the material asked for and becomes a truss with openings, much stiffer than the same material spread evenly;
// mirror planes give a mirrored shape; regions kept solid stay; asking to keep less than the held and loaded regions
// need says so; and the shape found is then analysed like any part.

import { describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import type { StructuralSpec, TopologySpec } from "../src/analysis/spec";
import { evaluate } from "../src/lang/evaluator";
import { outlineDxf, shapeStl } from "../src/analysis/topologyExport";
import { outlineText, topologyText } from "../src/analysis/topologySummary";

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

const face = (part: string, dir: V3) => ({ t: "face" as const, part, dir });
const topo = (keep: number, over: Partial<TopologySpec> = {}): TopologySpec => ({ keep, preserve: [], preserveParts: [], symmetry: [], ...over });

function solve(parts: FeaPart[], over: Partial<StructuralInput>) {
  return runStructural({
    label: "topology",
    parts,
    materials: [mechMaterial("Aluminum 6061")],
    supports: [{ region: face("plate", [-1, 0, 0]) }],
    loads: [],
    target: 6000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  });
}

const plate: FeaPart = { id: "plate", name: "plate", mesh: gridBox([0, 0, 0], [80, 4, 40], [16, 2, 8]), material: 0 };

describe("topology optimisation", { timeout: 120000 }, () => {
  it("turns a cantilever plate into a stiff truss with the material asked for", () => {
    const spec = { safety: 2, topology: topo(0.35, { cut: "Y" }) } as unknown as StructuralSpec;
    const t0 = performance.now();
    // held along its left edge, pulled down at the middle of its right edge, cut from plate (the same through Y)
    const r = solve([plate], {
      loads: [{ t: "force", region: { t: "box", at: [80, 2, 20], size: [2, 6, 6] }, f: [0, 0, -1000] }],
      topology: topo(0.35, { cut: "Y" }),
    });
    const ms = performance.now() - t0;
    const t = r.topology!;
    expect(t).toBeTruthy();
    expect(Math.abs(t.kept - 0.35)).toBeLessThan(0.06);
    expect(t.massAfter).toBeLessThan(0.45 * t.massBefore);
    // a truss keeps far more than 35 % of the solid plate's stiffness (spread evenly it would keep about 4 %)
    expect(t.stiffness).toBeGreaterThan(0.38);
    expect(t.stiffness).toBeLessThan(1);
    expect(t.pieces).toBe(1);
    expect(t.openings).toBeGreaterThanOrEqual(1);
    expect(r.parts[0].positions.length).toBeGreaterThan(300);
    // the shape is analysed: its stresses are real
    expect(r.maxStress.value).toBeGreaterThan(0);
    // cut from plate: one outline round the plate's edges with the openings as holes, and files to make it from
    const o = t.outline!;
    expect(o.axis).toBe("Y");
    expect(o.plane).toEqual(["X", "Z"]);
    expect(o.to - o.from).toBeCloseTo(4, 1);
    const outs = o.loops.filter((l) => l.outer);
    expect(outs.length).toBe(1);
    expect(o.loops.filter((l) => !l.outer).length).toBeGreaterThanOrEqual(1);
    const xs = outs[0].points.map((p) => p[0]),
      zs = outs[0].points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeLessThan(3);
    expect(Math.max(...xs)).toBeGreaterThan(77);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(30);
    const dxf = outlineDxf(r)!;
    expect(dxf).toMatch(/LINE/);
    expect(dxf).toMatch(/4 MM PLATE, XZ PLANE/);
    const stl = shapeStl(r);
    const tris = r.parts.reduce((a, p) => a + p.indices.length / 3, 0);
    expect(stl.byteLength).toBe(84 + 50 * tris);
    expect(topologyText(spec, r).detail).toMatch(/keeps 3\d %/);
    expect(outlineText(t)).toMatch(/outside \(\d+ mm²\): \[\(/);
    // eslint-disable-next-line no-console
    console.log(`cantilever: ${t.iterations} iterations in ${(ms / 1000).toFixed(1)} s, kept ${(t.kept * 100).toFixed(1)} %, stiffness ${(t.stiffness * 100).toFixed(0)} %, ${t.openings} openings, converged ${t.converged}`);
  });

  // a beam on two supports, loaded off centre: asked to be mirrored, the shape is the same both sides of the middle
  it("keeps a shape mirrored when asked, even under a load off to one side", () => {
    const beam: FeaPart = { id: "beam", name: "beam", mesh: gridBox([0, 0, 0], [90, 3, 30], [18, 1, 6]), material: 0 };
    const run = (symmetry: ("X" | "Y" | "Z")[]) =>
      solve([beam], {
        supports: [{ region: { t: "box", at: [2, 1.5, 0], size: [6, 6, 3] } }, { region: { t: "box", at: [88, 1.5, 0], size: [6, 6, 3] }, dir: [0, 0, 1] }],
        loads: [{ t: "force", region: { t: "box", at: [30, 1.5, 30], size: [6, 6, 3] }, f: [0, 0, -800] }],
        target: 3000,
        topology: topo(0.4, { cut: "Y", symmetry }),
      }).topology!;
    const centroid = (t: NonNullable<ReturnType<typeof run>>) => {
      let a = 0,
        cx = 0;
      for (const l of t.outline!.loops) {
        const P = l.points;
        for (let i = 0; i < P.length; i++) {
          const [x0, y0] = P[i],
            [x1, y1] = P[(i + 1) % P.length];
          const c = x0 * y1 - x1 * y0;
          a += c;
          cx += (x0 + x1) * c;
        }
      }
      return cx / (3 * a);
    };
    const mirrored = run(["X"]);
    expect(mirrored.symmetry).toEqual(["X"]);
    expect(Math.abs(centroid(mirrored) - 45)).toBeLessThan(0.9);
    // left to itself, the shape leans toward the load
    expect(centroid(run([]))).toBeLessThan(43);
  });

  it("keeps what preserve: names solid, and says when it asks for more than it keeps", () => {
    const keepBox = { t: "box" as const, at: [36, 2, 20] as V3, size: [8, 6, 8] as V3 };
    const r = solve([plate], {
      loads: [{ t: "force", region: { t: "box", at: [80, 2, 20], size: [2, 6, 6] }, f: [0, 0, -1000] }],
      target: 3000,
      topology: topo(0.35, { cut: "Y", preserve: [keepBox] }),
    });
    const t = r.topology!;
    expect(t.preserved).toBeGreaterThan(0.02);
    // the middle of the kept box is inside the plate's outline and not in one of its openings
    const inside = (P: [number, number][], x: number, y: number) => {
      let c = false;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) if (P[i][1] > y !== P[j][1] > y && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
      return c;
    };
    const loops = t.outline!.loops;
    expect(loops.some((l) => l.outer && inside(l.points, 36, 20))).toBe(true);
    expect(loops.some((l) => !l.outer && inside(l.points, 36, 20))).toBe(false);
    expect(() =>
      solve([plate], {
        loads: [{ t: "force", region: { t: "box", at: [80, 2, 20], size: [2, 6, 6] }, f: [0, 0, -1000] }],
        target: 3000,
        topology: topo(0.1, { preserve: [{ t: "box", at: [40, 2, 20], size: [40, 6, 30] }] }),
      }),
    ).toThrow(/already take \d+ % of the material, more than the 10 %/);
  });
});

describe("topology in the design language", () => {
  const src = (extra: string) => `part plate {
  material: "Aluminum 6061"
  body box(80, 4, 40)
}
part boss {
  material: "Aluminum 6061"
  body cylinder(d: 10, h: 4, at: (0, 0, 20))
}
analysis "Lighter" {
  parts: [plate, boss]
  fix: face(plate, -X)
  load: force(face(plate, +X), (0, 0, -500N))
  ${extra}
}`;
  const err = (extra: string) => evaluate(src(extra)).diagnostics.find((d) => d.severity === "error")?.message ?? "";

  it("reads the share kept and what it must keep", () => {
    const m = evaluate(src(`topology: 35%  preserve: [zone(at: (10, 0, 5), r: 4), boss]  min_member: 3mm  symmetry: [X, -Z]  extrusion: Y  iterations: 60`));
    const a = m.analyses[0];
    expect(a.kind).toBe("structural");
    const t = (a as StructuralSpec).topology!;
    expect(t.keep).toBeCloseTo(0.35);
    expect(t.preserve).toHaveLength(1);
    expect(t.preserve[0].t).toBe("sphere");
    expect(t.preserveParts).toEqual(["boss"]);
    expect(t.minMember).toBe(3);
    expect(t.symmetry).toEqual(["X", "Z"]);
    expect(t.cut).toBe("Y");
    expect(t.iterations).toBe(60);
  });

  it("says what is wrong with a set-up it cannot shape", () => {
    expect(err("topology: 2%")).toMatch(/from 5% to 95%/);
    expect(err("extrusion: Y")).toMatch(/extrusion: goes with topology:/);
    expect(err("topology: 40%  modes: 4")).toMatch(/analysis of its own.*natural frequencies/);
    expect(err("topology: 40%  symmetry: (1, 1, 0)")).toMatch(/symmetry: should name the axes/);
    expect(err("topology: 40%  preserve: [boss, plate]")).toMatch(/nothing left to shape/);
  });
});
