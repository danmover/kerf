import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { AirflowSpec } from "../src/analysis/spec";
import { airAt } from "../src/analysis/aeroLang";
import { equilibrium } from "../src/analysis/aero/cpu";
import { CX, CY, CZ, Q, SOLID, TYPE_MASK } from "../src/analysis/aero/lattice";
import { buildGrid, sphereMesh, type V3 } from "../src/analysis/aero/geometry";
import { boxMesh } from "../src/analysis/fe/voxel";
import { cellBudget, dot, planRun, windAxes } from "../src/analysis/aero/setup";
import { frontalArea, surfaceNets } from "../src/analysis/aero/post";
import { batchStderr, CpuSolver, runAirflow } from "../src/analysis/aero/solve";
import type { AirflowInput, SurfaceField, YawResult } from "../src/analysis/aero/types";
import { dragHotSpots } from "../src/analysis/aeroSummary";
import type { LbmCase } from "../src/analysis/aero/case";

const bike = `design "b"
part frame { body box(1000, 40, 500, at: (0, 0, 600)) }
part wheel { body box(680, 25, 680, at: (400, 0, 340)) }
`;
const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

const sphereInput = (over: Partial<AirflowInput> = {}): AirflowInput => {
  const m = sphereMesh([0, 0, 0], 50, 24);
  return {
    label: "sphere",
    bodies: [{ id: "s", name: "Sphere", positions: Float32Array.from(m.positions), indices: m.indices }],
    speed: 10,
    density: 1.2,
    nu: 1.5e-5,
    facing: [1, 0, 0],
    up: [0, 0, 1],
    yaws: [0],
    ground: false,
    quality: "draft",
    cells: 2e5,
    backend: "cpu",
    maxMinutes: 1,
    ...over,
  };
};

describe("airflow analysis blocks", () => {
  it("reads speed, direction, yaws, rider and targets", () => {
    const m = evaluate(
      bike +
        `analysis "Aero" {
  airflow: 45kmh
  forward: -X
  yaw: [0, 5, 10]
  parts: [frame, wheel]
  rider: "drops"
  rider_height: 1800mm
  temperature: 20C
  max_cda: 0.25
  max_watts: 300W
}`,
    );
    expect(m.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    const a = m.analyses[0] as AirflowSpec;
    expect(a.kind).toBe("airflow");
    expect(a.speed).toBeCloseTo(12500, 3);
    expect(a.forward).toEqual([-1, 0, 0]);
    expect(a.up).toEqual([0, 0, 1]);
    expect(a.yaw).toEqual([0, 5, 10]);
    expect(a.parts).toEqual(["frame", "wheel"]);
    expect(a.rider).toMatchObject({ position: "drops", height: 1800 });
    expect(a.ground).toBe(true);
    expect(a.density).toBeCloseTo(1.204, 2);
    expect(a.maxCda).toBe(0.25);
    expect(a.maxWatts).toBe(300);
    expect(m.graph.edges).toContainEqual({ from: "wheel", to: "analysis:Aero" });
  });

  it("takes wind: as the way the air blows, the opposite of forward", () => {
    const a = evaluate(bike + `analysis "A" { airflow: 30mph  wind: -X  ground: false }`).analyses[0] as AirflowSpec;
    expect(a.forward).toEqual([1, 0, 0]);
    expect(a.ground).toBe(false);
    expect(a.speed).toBeCloseTo(13411.2, 1);
  });

  it("rejects set-ups the tunnel cannot run", () => {
    expect(errors(bike + `analysis "A" { airflow: 45kmh  forward: X  wind: -X }`).join()).toMatch(/not both/);
    expect(errors(bike + `analysis "A" { airflow: 45kmh  yaw: [0, 60] }`).join()).toMatch(/-45 to 45/);
    expect(errors(bike + `analysis "A" { airflow: 12 }`).join()).toMatch(/unit/);
    expect(errors(bike + `analysis "A" { airflow: 45kmh  fix: face(frame, -Z) }`).join()).toMatch(/not part of an airflow analysis/);
    expect(errors(bike + `analysis "A" { airflow: 45kmh  rider_height: 1800mm }`).join()).toMatch(/goes with rider/);
  });

  it("gives sea-level air its density and viscosity", () => {
    const air = airAt(15);
    expect(air.density).toBeCloseTo(1.225, 3);
    expect(air.nu).toBeCloseTo(1.46e-5, 6);
  });
});

describe("airflow solver pieces", () => {
  it("keeps mass and momentum in the equilibrium", () => {
    const f = new Float64Array(Q);
    equilibrium(0.01, 0.05, -0.02, 0.03, f);
    let m = 0,
      px = 0,
      py = 0,
      pz = 0;
    for (let i = 0; i < Q; i++) {
      m += f[i];
      px += CX[i] * f[i];
      py += CY[i] * f[i];
      pz += CZ[i] * f[i];
    }
    expect(m).toBeCloseTo(0.01, 12);
    expect(px).toBeCloseTo(1.01 * 0.05, 12);
    expect(py).toBeCloseTo(1.01 * -0.02, 12);
    expect(pz).toBeCloseTo(1.01 * 0.03, 12);
  });

  it("turns the tunnel with the yaw and keeps its axes square", () => {
    const zero = windAxes({ facing: [1, 0, 0], up: [0, 0, 1] }, 0);
    expect(zero.ex.map((x) => x + 0)).toEqual([-1, 0, 0]);
    const ten = windAxes({ facing: [1, 0, 0], up: [0, 0, 1] }, 10);
    expect(dot(ten.ex, [-1, 0, 0])).toBeCloseTo(Math.cos((10 * Math.PI) / 180), 9);
    expect(dot(ten.ex, ten.ey)).toBeCloseTo(0, 12);
    expect(dot(ten.ey, ten.ez)).toBeCloseTo(0, 12);
  });

  it("nests a close-up box in a bigger tunnel when there are cells for it", () => {
    const plan = planRun(sphereInput({ cells: 0 }), 0, cellBudget("standard", true));
    expect(plan.levels.length).toBe(2);
    const [outer, inner] = plan.levels;
    expect(outer.frame.h).toBeGreaterThan(1.6 * inner.frame.h);
    expect(inner.dims[0] * inner.dims[1] * inner.dims[2]).toBeLessThanOrEqual(10e6 * 1.05);
  });

  it("measures frontal area", () => {
    const b = sphereInput().bodies;
    const ax = windAxes({ facing: [1, 0, 0], up: [0, 0, 1] }, 0);
    // the 24-sided mesh is a little smaller than the sphere
    expect(frontalArea(b, ax.ex, ax.ey, ax.ez) / (Math.PI * 0.05 ** 2)).toBeCloseTo(0.985, 1);
  });

  it("closes an iso-surface with its faces outward", () => {
    const n = 20;
    const val = new Float32Array(n * n * n);
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) val[x + n * (y + n * z)] = Math.hypot(x - 9.5, y - 9.5, z - 9.5) - 6;
    const s = surfaceNets(val, [n, n, n], 0, null);
    expect(s.indices.length).toBeGreaterThan(300);
    // the divergence theorem gives the enclosed volume, positive when the faces point outward
    let vol = 0;
    const P = s.positions;
    for (let t = 0; t < s.indices.length; t += 3) {
      const [a, b, c] = [s.indices[t], s.indices[t + 1], s.indices[t + 2]].map((i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
      vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    expect(vol).toBeGreaterThan(0.9 * ((4 / 3) * Math.PI * 6 ** 3));
    expect(vol).toBeLessThan(1.1 * ((4 / 3) * Math.PI * 6 ** 3));
  });

  it("fills a pocket walled in on five sides, but not a slot between two plates", () => {
    const box = (lo: V3, hi: V3) => {
      const m = boxMesh(lo, hi);
      return { positions: Float64Array.from(m.positions), indices: Uint32Array.from(m.indices), part: 0 };
    };
    const solid = (g: { flags: Uint32Array }, x: number, y: number, z: number) => (g.flags[x + 20 * (y + 20 * z)] & TYPE_MASK) === SOLID;
    // a one-cell well at (10, 10): floor and four walls, open at the top
    const well = buildGrid({ nx: 20, ny: 20, nz: 20, bodies: [box([8.5, 8.5, 8.5], [11.5, 11.5, 9.5]), box([8.5, 8.5, 8.5], [9.5, 11.5, 11.5]), box([10.5, 8.5, 8.5], [11.5, 11.5, 11.5]), box([8.5, 8.5, 8.5], [11.5, 9.5, 11.5]), box([8.5, 10.5, 8.5], [11.5, 11.5, 11.5])] }, 1);
    expect(solid(well, 10, 10, 10)).toBe(true);
    expect(solid(well, 10, 10, 11)).toBe(true);
    expect(solid(well, 10, 10, 12)).toBe(false);
    // a one-cell gap between two plates is a slot the air can run along
    const slot = buildGrid({ nx: 20, ny: 20, nz: 20, bodies: [box([4.5, 4.5, 8.5], [15.5, 15.5, 9.5]), box([4.5, 4.5, 10.5], [15.5, 15.5, 11.5])] }, 1);
    expect(solid(slot, 10, 10, 10)).toBe(false);
  });

  it("lists the design's own drag patches even where the rider's are bigger", () => {
    // a square facing into the wind, s mm across, at x
    const face = (name: string, s: number, x: number, extra?: boolean): SurfaceField => ({
      id: name,
      name,
      positions: Float32Array.from([x, 0, 0, x, s, 0, x, 0, s]),
      normals: null,
      indices: Uint32Array.from([0, 1, 2]),
      cp: Float32Array.from([1, 1, 1]),
      cf: new Float32Array(9),
      extra,
    });
    const y = { surface: [face("Rider", 400, 0, true), face("frame", 50, 1000)], parts: [] } as unknown as YawResult;
    expect(dragHotSpots(y, [1, 0, 0], 100, 60, 1).map((h) => h.part)).toEqual(["frame"]);
    expect(dragHotSpots(y, [1, 0, 0], 100, 60, 1, true).map((h) => h.part)).toEqual(["Rider"]);
  });

  it("estimates the error of a noisy mean", () => {
    expect(batchStderr([1, 2, 3])).toBe(Infinity);
    expect(batchStderr(Array(200).fill(4))).toBe(0);
    let s = 7;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
    const xs = Array.from({ length: 4000 }, () => 10 + rand());
    // uniform noise on ±0.5 has σ = 0.29, so the mean of 4000 is good to about 0.0046
    expect(batchStderr(xs)).toBeGreaterThan(0.002);
    expect(batchStderr(xs)).toBeLessThan(0.01);
  });

  it("runs a sphere end to end on the CPU", async () => {
    const r = await runAirflow(sphereInput({ cells: 8000, nu: (10 * 0.1) / 100, maxMinutes: 0.25 }));
    const y = r.yaws[0];
    expect(r.backend).toBe("cpu");
    expect(y.drag).toBeGreaterThan(0);
    // a sphere at Re 100 has Cd about 1.1; this grid is tiny, so only the size of it is checked
    const cd = y.drag / (0.5 * 1.2 * 100 * Math.PI * 0.05 ** 2);
    expect(cd).toBeGreaterThan(0.6);
    expect(cd).toBeLessThan(2.5);
    expect(Math.abs(y.side)).toBeLessThan(0.1 * y.drag);
    expect(y.surface[0].cp.some((c) => c > 0.5)).toBe(true);
    expect(y.streamlines.starts.length).toBeGreaterThan(10);
  }, 120_000);

  it("runs an angle again without the wall model when the flow blows up, and says so", async () => {
    const blowUp = (c: LbmCase, always: boolean) => {
      const s = new CpuSolver(c);
      if (always || c.wallModel) s.forces = async () => new Float64Array(3 * c.parts.length).fill(NaN);
      return s;
    };
    const input = sphereInput({ cells: 8000, nu: (10 * 0.1) / 100, maxMinutes: 0.25 });
    const r = await runAirflow(input, { solver: async (c) => blowUp(c, false), solverBackend: "cpu" });
    expect(r.yaws).toHaveLength(1);
    expect(Number.isFinite(r.yaws[0].drag)).toBe(true);
    expect(r.warnings.some((w) => w.includes("without the wall model"))).toBe(true);
    await expect(runAirflow(input, { solver: async (c) => blowUp(c, true), solverBackend: "cpu" })).rejects.toThrow("blew up");
  }, 120_000);
});
