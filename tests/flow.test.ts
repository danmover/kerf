import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { FlowSpec } from "../src/analysis/spec";
import { ANALYSIS_KINDS } from "../src/ui/analysisKinds";
import { fanCurve } from "../src/analysis/flow/fans";
import { Multigrid, newStencil, pcg } from "../src/analysis/flow/linear";
import { buildGrid } from "../src/analysis/flow/grid";
import { HeatSolver } from "../src/analysis/flow/energy";
import { solveFlow } from "../src/analysis/flow/solve";
import { waterFluid } from "../src/analysis/flow/fluids";
import type { FlowBody, FlowInput } from "../src/analysis/flow/types";
import { flowInput } from "../src/analysis/flowRuntime";
import type { MeshData } from "../src/kernel/build";

// The flow and cooling analysis: the analysis block's flow form, fan curves, the solver's linear algebra, and the
// solver against answers from the textbooks (a heated fin, a laminar duct, the heat a duct's air carries off).

const CFM = 0.000471947443;

const flowOf = (src: string): FlowSpec => {
  const a = evaluate(src).analyses.find((x) => x.kind === "flow");
  if (!a || a.kind !== "flow") throw new Error("no flow analysis");
  return a;
};
const errorOf = (src: string): string => {
  const m = evaluate(src);
  return m.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => d.message)
    .join("\n");
};

/** a box's surface as a mesh, for a part's shape without the kernel */
function boxMesh(lo: [number, number, number], hi: [number, number, number]): MeshData {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) for (let a = 0; a < 3; a++) positions[i * 3 + a] = i & (1 << a) ? hi[a] : lo[a];
  // two triangles a side, wound outwards
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const indices = new Uint32Array(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  return { positions, normals: new Float32Array(24), indices, edges: new Float32Array(0) };
}

const DUCT = `part duct { box(60, 12, 12) }
part branch { box(8, 30, 8) }
`;

describe("flow analysis block", () => {
  it("reads a cooling analysis with the design's fans", () => {
    const a = flowOf(`part board { box(50, 40, 2) }
analysis "Cooling" { flow: "fans"  ambient: 35C  max_temp: 70C }`);
    expect(a.drive).toBe("fans");
    expect(a.fluid).toBe("air");
    expect(a.auto).toBe(true);
    expect(a.heat).toEqual([]);
    expect(a.ambient).toBe(35);
    expect(a.maxTemp).toBe(70);
    expect(a.up).toEqual([0, 0, 1]);
    expect(a.gravity).toBe(true);
    expect(a.resolution).toBe("standard");
  });

  it("reads a set flow with its units, inlet, outlets and pressure limit", () => {
    const a = flowOf(`${DUCT}analysis "Manifold" {
  flow: 12lpm
  fluid: "water"
  inlet: face(duct, -X)
  outlets: [face(duct, +X), face(branch, +Y)]
  max_pressure: 20kPa
}`);
    expect(a.drive).toBe("set");
    expect(a.fluid).toBe("water");
    expect(a.flow).toBeCloseTo(12e6 / 60, 3);
    expect(a.inlet?.region.t).toBe("face");
    expect(a.inlet?.label).toBe("duct -X");
    expect(a.outlets.map((o) => o.label)).toEqual(["duct +X", "branch +Y"]);
    expect(a.maxPressure).toBeCloseTo(0.02, 9);
    expect(flowOf(`${DUCT}analysis "A" { flow: 20cfm  inlet: face(duct, -X) }`).flow).toBeCloseTo(20 * CFM * 1e9, 0);
    expect(flowOf(`${DUCT}analysis "A" { flow: 5cmh  inlet: face(duct, -X) }`).flow).toBeCloseTo((5 / 3600) * 1e9, 0);
  });

  it("takes heat made in parts, or none", () => {
    const a = flowOf(`part board { box(50, 40, 2) }
analysis "Warm" { flow: "natural"  heat: [source(board, 2W)] }`);
    expect(a.auto).toBe(false);
    expect(a.heat.map((h) => [h.part, h.watts])).toEqual([["board", 2]]);
    expect(flowOf(`part board { box(50, 40, 2) }\nanalysis "A" { flow: "natural"  heat: ["auto", source(board, 1W)] }`).auto).toBe(true);
    expect(flowOf(`part board { box(50, 40, 2) }\nanalysis "A" { flow: "fans"  heat: "none" }`).auto).toBe(false);
  });

  it("says what is wrong with a set-up it cannot run", () => {
    expect(errorOf(`${DUCT}analysis "A" { flow: 20  inlet: face(duct, -X) }`)).toMatch(/with its unit/);
    expect(errorOf(`${DUCT}analysis "A" { flow: 20cfm }`)).toMatch(/add inlet:/);
    expect(errorOf(`${DUCT}analysis "A" { flow: 20cfm  inlet: (0, 0, 0) }`)).toMatch(/which way does the air go in/);
    expect(errorOf(`${DUCT}analysis "A" { flow: "fans"  inlet: face(duct, -X) }`)).toMatch(/goes with a set flow/);
    expect(errorOf(`${DUCT}analysis "A" { flow: "natural"  gravity: false }`)).toMatch(/needs gravity/);
    expect(errorOf(`${DUCT}analysis "A" { flow: "fans"  max_pressure: 200Pa }`)).toMatch(/goes with flow: 20cfm/);
    expect(errorOf(`${DUCT}analysis "A" { flow: "fans"  fluid: "oil" }`)).toMatch(/"air" \(the default\) or "water"/);
    expect(errorOf(`${DUCT}analysis "A" { flow: "fans"  speed: 3 }`)).toMatch(/is not part of a flow analysis/);
  });

  it("is a cooling or a duct flow analysis in the Add menu", () => {
    const m = evaluate(`${DUCT}part board { box(50, 40, 2) }
analysis "Box" { flow: "fans" }
analysis "Still" { flow: "natural" }
analysis "Pipe" { flow: 12lpm  inlet: face(duct, -X) }`);
    const kinds = m.analyses.map((a) => ANALYSIS_KINDS.filter((k) => k.is(a)).map((k) => k.id));
    expect(kinds).toEqual([["cooling"], ["cooling"], ["ducts"]]);
  });

  it("makes a component's heat once, spread over its bodies by volume", () => {
    const m = evaluate(`component pcb = lib.pcb(w: 70, d: 50, t: 1.6) { at: (0, 0, 5) }
analysis "Cooling" { flow: "natural"  heat: source(pcb, 2.5W) }`);
    const spec = m.analyses.find((a): a is FlowSpec => a.kind === "flow")!;
    // the board 70 × 50 × 1.6 (5600 mm³) and the parts on it, here one 20 × 20 × 5 block (2000 mm³)
    const shapes = new Map(m.parts.map((p) => [p.hash, p.id === "pcb" ? boxMesh([0, 0, 0], [70, 50, 1.6]) : boxMesh([10, 10, 1.6], [30, 30, 6.6])]));
    const prep = flowInput(spec, m, new Map(), (h) => shapes.get(h));
    const watts = Object.fromEntries((prep?.input?.bodies ?? []).map((b) => [b.id, b.watts]));
    expect(Object.keys(watts).sort()).toEqual(["pcb", "pcb.parts"]);
    expect(watts.pcb + watts["pcb.parts"]).toBeCloseTo(2.5, 6);
    expect(watts.pcb).toBeCloseTo((2.5 * 5600) / 7600, 3);
  });
});

describe("fan curves", () => {
  it("uses the datasheet's free flow and shut-off pressure when given", () => {
    const c = fanCurve({ size: 40, flow: 10 * CFM, pressure: 50 });
    expect(c.estimated).toBe(false);
    expect(c.curve[0]).toEqual([0, 50]);
    expect(c.curve[c.curve.length - 1][0]).toBeCloseTo(10 * CFM, 12);
    expect(c.curve[c.curve.length - 1][1]).toBe(0);
    // the pressure falls all the way from shut-off to free flow
    for (let i = 1; i < c.curve.length; i++) expect(c.curve[i][1]).toBeLessThan(c.curve[i - 1][1]);
  });

  it("takes a fan known only by its size from real fans that size", () => {
    const c40 = fanCurve({ size: 40 });
    expect(c40.estimated).toBe(true);
    expect(c40.curve[c40.curve.length - 1][0] / CFM).toBeCloseTo(4.95, 2);
    expect(c40.curve[0][1]).toBeCloseTo(2.78 * 9.80665, 2);
    // between the sizes with datasheets, and bigger fans move more air
    const c92 = fanCurve({ size: 92 });
    const free = (c: { curve: [number, number][] }) => c.curve[c.curve.length - 1][0];
    expect(free(c92)).toBeGreaterThan(free(fanCurve({ size: 80 })));
    expect(free(c92)).toBeLessThan(free(fanCurve({ size: 120 })));
    expect(fanCurve({ size: 50, blower: true }).why).toMatch(/blower/);
  });
});

describe("flow solver", () => {
  it("solves a pressure-like system across a wall with a hole in a few multigrid-preconditioned steps", () => {
    const n = 24;
    const A = newStencil(n, n, n);
    const idx = (i: number, j: number, k: number) => i + n * (j + n * k);
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const c = idx(i, j, k);
          // a wall across the middle with a hole in it
          if (i === 12 && !(j > 9 && j < 14 && k > 9 && k < 14)) continue;
          A.active[c] = 1;
        }
    const on = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < n && j < n && k < n && A.active[idx(i, j, k)] === 1;
    const b = new Float64Array(n * n * n);
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const c = idx(i, j, k);
          if (!A.active[c]) continue;
          if (on(i - 1, j, k)) A.aW[c] = 1;
          if (on(i + 1, j, k)) A.aE[c] = 1;
          if (on(i, j - 1, k)) A.aS[c] = 1;
          if (on(i, j + 1, k)) A.aN[c] = 1;
          if (on(i, j, k - 1)) A.aB[c] = 1;
          if (on(i, j, k + 1)) A.aT[c] = 1;
          A.aP[c] = A.aW[c] + A.aE[c] + A.aS[c] + A.aN[c] + A.aB[c] + A.aT[c] + (i === n - 1 ? 2 : 0);
          b[c] = i < 4 ? 1 : 0;
        }
    const x = new Float64Array(n * n * n);
    const st = pcg(A, b, x, { tol: 1e-8, maxIter: 200, mg: new Multigrid(A) });
    expect(st.reduction).toBeLessThanOrEqual(1e-8);
    expect(st.iterations).toBeLessThan(40);
    // the source side has to push through the hole, so it sits higher than the far side
    expect(x[idx(2, 2, 2)]).toBeGreaterThan(x[idx(20, 2, 2)]);
  });

  it("matches the fin equation for a heated bar cooled from its surface", () => {
    const k = 20;
    const bar: FlowBody = { id: "bar", name: "bar", ...box([-50, -0.5, -0.5], [50, 0.5, 0.5]), k, watts: 0.1, emissivity: 0, material: "steel", component: false };
    const g = buildGrid([bar], [], 1, 0);
    const hs = new HeatSolver(g, { name: "air", rho: 1.2, nu: 1.5e-5, cp: 1005, k: 0.026, beta: 1 / 300 }, 20);
    hs.placeHeat([null]);
    hs.solve(null, { tol: 1e-12, maxIter: 500, radiation: false });
    // uniform heat q in a bar of area A and perimeter P, 10 W/m²K on every face, both ends too
    const hf = 10;
    const A = 1e-6;
    const P = 4e-3;
    const L = 0.1;
    const m = Math.sqrt((hf * P) / (k * A));
    const thp = (0.1 / L) / (hf * P);
    const C = (-hf * thp) / (k * m * Math.sinh((m * L) / 2) + hf * Math.cosh((m * L) / 2));
    const exact = (x: number) => thp + C * Math.cosh(m * x);
    let worst = 0;
    for (let i = 1; i < g.nx - 1; i++) {
      const c = i + g.nx * (1 + g.ny * 1);
      const x = (g.origin[0] + (i + 0.5) * g.hmm) / 1000;
      worst = Math.max(worst, Math.abs(hs.T[c] - 20 - exact(x)));
    }
    expect(worst / exact(0)).toBeLessThan(0.01);
    const bal = hs.balance(null);
    expect(bal.made).toBeCloseTo(0.1, 6);
  });

  it("gives a laminar duct its friction and the air the heat it carries off", { timeout: 60_000 }, () => {
    const W = 8;
    const t = 2;
    const L = 90;
    const walls = [
      box([0, -W / 2 - t, -W / 2 - t], [L, W / 2 + t, -W / 2]),
      box([0, -W / 2 - t, W / 2], [L, W / 2 + t, W / 2 + t]),
      box([0, -W / 2 - t, -W / 2], [L, -W / 2, W / 2]),
      box([0, W / 2, -W / 2], [L, W / 2 + t, W / 2]),
    ];
    // walls that hardly conduct, so the heat stays in the air rather than leaking out through them
    const bodies: FlowBody[] = walls.map((mesh, i) => ({ id: `w${i}`, name: `wall ${i}`, ...mesh, k: 0.001, watts: 0, emissivity: 0, material: "foam", component: false }));
    bodies.push({ id: "heater", name: "heater", ...box([62, -1, -1], [68, 1, 1]), k: 200, watts: 0.05, emissivity: 0, material: "aluminium", component: true });
    const U = 0.1;
    const Q = U * (W / 1000) ** 2;
    const fluid = { name: "air", rho: 1.2, nu: 1.5e-5, cp: 1005, k: 0.026, beta: 1 / 300 };
    const input: FlowInput = {
      label: "duct",
      bodies,
      fans: [],
      drives: [{ label: "inlet", at: [3, 0, 0], dir: [1, 0, 0], flow: Q }],
      sections: [{ label: "out", at: [72, 0, 0], dir: [1, 0, 0] }],
      fluid,
      ambient: 20,
      gravity: null,
      h: 1,
      margin: 4,
      heat: true,
      maxMinutes: 2,
      maxIterations: 400,
    };
    const r = solveFlow(input);
    expect(r.drives[0].flow / Q).toBeCloseTo(1, 2);
    expect(r.sections[0].flow / Q).toBeCloseTo(1, 1);
    // fully developed between x = 25 and 50 mm: f·Re = 56.91 for a square duct
    const f = r.field!;
    const [nx, ny, nz] = f.dims;
    const meanP = (x: number) => {
      const i = Math.floor((x - f.origin[0]) / f.h);
      let s = 0;
      let n = 0;
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++) {
          const c = i + nx * (j + ny * k);
          const y = f.origin[1] + (j + 0.5) * f.h;
          const z = f.origin[2] + (k + 0.5) * f.h;
          if (f.kind[c] === 0 && Math.abs(y) < W / 2 && Math.abs(z) < W / 2) {
            s += f.data[5 * c + 4];
            n++;
          }
        }
      return s / n;
    };
    const dpdx = (meanP(25) - meanP(50)) / 0.025;
    const D = W / 1000;
    const Re = (U * D) / fluid.nu;
    const fRe = ((dpdx * D) / (0.5 * fluid.rho * U * U)) * Re;
    expect(Math.abs(fRe - 56.91) / 56.91).toBeLessThan(0.12);
    // the air leaving is warmer by P/(ρ·cp·Q), and the heat made all goes somewhere
    const rise = 0.05 / (fluid.rho * fluid.cp * Q);
    expect(Math.abs(r.sections[0].temp - 20 - rise) / rise).toBeLessThan(0.03);
    expect(Math.abs(r.balance)).toBeLessThan(0.03);
    const heater = r.parts.find((p) => p.id === "heater")!;
    expect(heater.max).toBeGreaterThan(20 + rise);
  });

  it("lets warm air rise off a heated block in still air", { timeout: 60_000 }, () => {
    const block: FlowBody = { id: "b", name: "block", ...box([-5, -5, -5], [5, 5, 5]), k: 200, watts: 0.05, emissivity: 0, material: "aluminium", component: false };
    const input: FlowInput = {
      label: "natural",
      bodies: [block],
      fans: [],
      drives: [],
      sections: [],
      fluid: { name: "air", rho: 1.16, nu: 1.6e-5, cp: 1006, k: 0.026, beta: 1 / 303 },
      ambient: 30,
      gravity: [0, 0, -9.81],
      h: 1.5,
      margin: 15,
      heat: true,
      maxMinutes: 2,
      maxIterations: 300,
    };
    const r = solveFlow(input);
    expect(Math.abs(r.balance)).toBeLessThan(0.03);
    const f = r.field!;
    const [nx, ny] = f.dims;
    const at = (x: number, y: number, z: number) => {
      const c = Math.floor((x - f.origin[0]) / f.h) + nx * (Math.floor((y - f.origin[1]) / f.h) + ny * Math.floor((z - f.origin[2]) / f.h));
      return { T: f.data[5 * c + 3], w: f.data[5 * c + 2] };
    };
    // a plume: warmer and rising above the block, cooler below it
    expect(at(0, 0, 9).T).toBeGreaterThan(at(0, 0, -9).T + 1);
    expect(at(0, 0, 9).w).toBeGreaterThan(0);
    // a film coefficient like a small cube's in still air (about 10 W/m²K)
    const hEff = 0.05 / (6e-4 * (r.parts[0].mean - 30));
    expect(hEff).toBeGreaterThan(5);
    expect(hEff).toBeLessThan(16);
  });

  it("knows water's properties", () => {
    const w = waterFluid(20);
    expect(w.rho).toBeCloseTo(998.2, 0);
    expect(w.nu).toBeCloseTo(1.004e-6, 8);
    expect(w.k).toBeCloseTo(0.598, 2);
    expect(w.beta).toBeCloseTo(2.07e-4, 5);
    expect((w.rho * w.cp * w.nu) / w.k).toBeGreaterThan(6.5);
  });
});

function box(lo: number[], hi: number[]): { positions: Float32Array; indices: Uint32Array } {
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  const P = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const I = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: new Float32Array(P), indices: new Uint32Array(I) };
}
