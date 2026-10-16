import { describe, expect, it } from "vitest";
import { elementMatrices, CORNERS, principal, vonMises } from "../src/analysis/fe/element";
import { buildHierarchy, coarseningPlan, makeLevel, pcg } from "../src/analysis/fe/solver";
import { boxMesh, meshVolume, voxelizeMesh } from "../src/analysis/fe/voxel";

describe("hex element with incompatible modes", () => {
  const em = elementMatrices(0.3);

  it("is symmetric and has the six rigid-body motions as its null space", () => {
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) expect(em.K[i * 24 + j]).toBeCloseTo(em.K[j * 24 + i], 10);
    const modes: number[][] = [];
    for (let c = 0; c < 3; c++) modes.push(CORNERS.flatMap(() => [0, 1, 2].map((d) => (d === c ? 1 : 0))));
    // rotations about x, y, z through the centre
    modes.push(CORNERS.flatMap(([x, y, z]) => [0, -z, y]));
    modes.push(CORNERS.flatMap(([x, y, z]) => [z, 0, -x]));
    modes.push(CORNERS.flatMap(([x, y]) => [-y, x, 0]));
    for (const m of modes) {
      for (let i = 0; i < 24; i++) {
        let s = 0;
        for (let j = 0; j < 24; j++) s += em.K[i * 24 + j] * m[j];
        expect(Math.abs(s)).toBeLessThan(1e-10);
      }
    }
  });

  it("reproduces a uniform strain exactly at every Gauss point (patch test)", () => {
    // u = 0.001 x, v = -0.0003 y, w = 0.0005 z + 0.0002 x  (unit cube from 0 to 1)
    const u = CORNERS.flatMap(([a, b, c]) => {
      const x = (a + 1) / 2,
        y = (b + 1) / 2,
        z = (c + 1) / 2;
      return [0.001 * x, -0.0003 * y, 0.0005 * z + 0.0002 * x];
    });
    for (const T of em.strainGauss) {
      const e = [0, 1, 2, 3, 4, 5].map((r) => u.reduce((s, v, j) => s + T[r * 24 + j] * v, 0));
      expect(e[0]).toBeCloseTo(0.001, 12);
      expect(e[1]).toBeCloseTo(-0.0003, 12);
      expect(e[2]).toBeCloseTo(0.0005, 12);
      expect(e[3]).toBeCloseTo(0, 12);
      expect(e[4]).toBeCloseTo(0, 12);
      expect(e[5]).toBeCloseTo(0.0002, 12);
    }
  });

  it("computes principal and von Mises stresses", () => {
    const p = principal(100, 0, 0, 0, 0, 0);
    expect(p[0]).toBeCloseTo(100);
    expect(p[2]).toBeCloseTo(0);
    const q = principal(0, 0, 0, 50, 0, 0);
    expect(q[0]).toBeCloseTo(50);
    expect(q[2]).toBeCloseTo(-50);
    expect(vonMises([0, 0, 0, 50, 0, 0])).toBeCloseTo(50 * Math.sqrt(3));
  });
});

describe("voxeliser", () => {
  it("fills a box exactly when it lines up with the grid, and proportionally when it does not", () => {
    const mesh = boxMesh([0.3, 0.3, 0.25], [7.3, 4.3, 3.0]);
    expect(meshVolume(mesh)).toBeCloseTo(7 * 4 * 2.75);
    const fill = voxelizeMesh(mesh, { h: 1, origin: [0, 0, 0], n: [8, 5, 4] }, 4);
    let sum = 0;
    for (const f of fill) sum += f;
    expect(sum).toBeCloseTo(7 * 4 * 2.75, 0);
    // a cell well inside is full
    expect(fill[3 + 8 * (2 + 5 * 1)]).toBeCloseTo(1, 5);
  });
});

/** Cantilever L×b×t, clamped at x = 0, end load P downwards (−z), steel. */
function cantilever(L: number, b: number, t: number, h: number, P: number, E = 200000, nu = 0.3) {
  const n: [number, number, number] = [Math.round(L / h), Math.round(b / h), Math.round(t / h)];
  const plan = coarseningPlan(n);
  const [nx, ny, nz] = plan.padded;
  const dense = new Float64Array(nx * ny * nz);
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) dense[i + nx * (j + ny * k)] = E;
  const NX = nx + 1,
    NY = ny + 1,
    NZ = nz + 1;
  const bc = new Uint8Array(3 * NX * NY * NZ);
  for (let k = 0; k <= n[2]; k++) for (let j = 0; j <= n[1]; j++) bc.fill(1, 3 * (NX * (j + NY * k)), 3 * (NX * (j + NY * k)) + 3);
  const fine = makeLevel(nx, ny, nz, [h, h, h], nu, dense, bc);
  const H = buildHierarchy(fine, plan.shifts, nu);
  const f = new Float64Array(3 * NX * NY * NZ);
  // consistent nodal loads for a uniform traction on the end face
  for (let k = 0; k <= n[2]; k++)
    for (let j = 0; j <= n[1]; j++) {
      const wj = j === 0 || j === n[1] ? 0.5 : 1;
      const wk = k === 0 || k === n[2] ? 0.5 : 1;
      f[3 * (n[0] + NX * (j + NY * k)) + 2] = (-P * wj * wk) / (n[1] * n[2]);
    }
  const { u, stats } = pcg(H, f, { tol: 1e-8, maxIter: 300 });
  let tip = 0;
  let cnt = 0;
  for (let k = 0; k <= n[2]; k++)
    for (let j = 0; j <= n[1]; j++) {
      tip += u[3 * (n[0] + NX * (j + NY * k)) + 2];
      cnt++;
    }
  return { tip: tip / cnt, stats, levels: H.levels.length };
}

describe("multigrid solver", () => {
  it("matches beam theory for a cantilever with only 4 elements through the thickness", () => {
    const L = 100,
      b = 10,
      t = 10,
      P = 100,
      E = 200000,
      nu = 0.3;
    const I = (b * t ** 3) / 12;
    const G = E / (2 * (1 + nu));
    const expected = (P * L ** 3) / (3 * E * I) + (P * L) / ((5 / 6) * G * b * t);
    const r = cantilever(L, b, t, 2.5, P, E, nu);
    expect(r.stats.converged).toBe(true);
    expect(Math.abs(-r.tip - expected) / expected).toBeLessThan(0.04);
  });

  it("converges in a modest number of iterations as the mesh is refined", () => {
    const coarse = cantilever(100, 10, 10, 2.5, 100);
    const fine = cantilever(100, 10, 10, 1.0, 100);
    expect(fine.levels).toBeGreaterThan(1);
    expect(fine.stats.iterations).toBeLessThan(80);
    expect(Math.abs(fine.tip - coarse.tip) / Math.abs(fine.tip)).toBeLessThan(0.03);
  });
});
