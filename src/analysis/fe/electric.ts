// Current through conducting parts, on the heat analysis's grid: the electric potential between two terminals
// (Laplace's equation with each cell's conductance, solved the way heat conduction is), the resistance it gives,
// and where the current makes its heat (each cell's share of I²R, J·E) and how dense it runs.

import { conductionMatrix, cornerOffsets, solveSteady, type HeatGrid } from "./thermal";

export interface CurrentGrid {
  /** cells per axis (the nodes are one more each way) and the cell size, mm */
  n: [number, number, number];
  h: [number, number, number];
  /** the conducting cells */
  cells: Int32Array;
  /** per cell: conductance σ·fill, S/mm, and the material's own σ, S/mm (for the current density in it) */
  sigma: Float64Array;
  bulk: Float64Array;
}

export interface CurrentSolve {
  /** potential per node with 1 V across the terminals (1 where it goes in, 0 where it comes out) */
  phi: Float64Array;
  /** conductance between the terminals, S: the resistance is its inverse */
  conductance: number;
  iterations: number;
  converged: boolean;
  /** the residual scale of this solve, to judge a warm-started one by */
  ref: number;
}

/** The potential with 1 V across two terminals; every result scales with the voltage (power with its square). */
export function solveCurrent(g: CurrentGrid, from: ArrayLike<number>, to: ArrayLike<number>, warm?: { phi: Float64Array; ref: number }): CurrentSolve {
  const [nx, ny, nz] = g.n;
  const nn = (nx + 1) * (ny + 1) * (nz + 1);
  const fixedT = new Float64Array(nn).fill(NaN);
  for (let i = 0; i < to.length; i++) fixedT[to[i]] = 0;
  for (let i = 0; i < from.length; i++) fixedT[from[i]] = 1;
  const zeros = new Float64Array(nn);
  const grid: HeatGrid = { n: g.n, h: g.h, cells: g.cells, kc: g.sigma, cap: new Float64Array(g.cells.length), hA: zeros, hAT: zeros, ambient: 0.5, q: zeros, fixedT };
  // a warm start from the last pass is judged against the first solve's residual, not its own (already small) one
  const s = solveSteady(grid, { tol: 1e-7, maxIter: 20000, ...(warm ? { start: warm.phi, ref: warm.ref } : {}) });
  return { phi: s.T, conductance: joulePower(g, s.T).total, iterations: s.iterations, converged: s.converged, ref: warm?.ref ?? s.scale ?? 0 };
}

/**
 * The heat a potential drives through each cell, W (σ·fill·φᵀKφ: its share of I²R), the current density at each cell's
 * centre, A/mm², and their total.
 */
export function joulePower(g: CurrentGrid, phi: Float64Array): { power: Float64Array; density: Float64Array; total: number } {
  const [nx, ny] = g.n;
  const NX = nx + 1,
    NY = ny + 1;
  const Ke = conductionMatrix(...g.h);
  const off = cornerOffsets(nx, ny);
  const [hx, hy, hz] = g.h;
  const power = new Float64Array(g.cells.length);
  const density = new Float64Array(g.cells.length);
  const pe = new Float64Array(8);
  let total = 0;
  for (let c = 0; c < g.cells.length; c++) {
    const e = g.cells[c];
    const i = e % nx,
      j = Math.floor(e / nx) % ny,
      k = Math.floor(e / (nx * ny));
    const n0 = i + NX * (j + NY * k);
    for (let a = 0; a < 8; a++) pe[a] = phi[n0 + off[a]];
    let w = 0;
    for (let a = 0; a < 8; a++) {
      let r = 0;
      for (let b = 0; b < 8; b++) r += Ke[a * 8 + b] * pe[b];
      w += pe[a] * r;
    }
    power[c] = g.sigma[c] * w;
    total += power[c];
    // the gradient at the cell's centre: the mean difference across it along each axis (corner a = dx + 2·dy + 4·dz)
    const gx = (pe[1] - pe[0] + pe[3] - pe[2] + pe[5] - pe[4] + pe[7] - pe[6]) / (4 * hx);
    const gy = (pe[2] - pe[0] + pe[3] - pe[1] + pe[6] - pe[4] + pe[7] - pe[5]) / (4 * hy);
    const gz = (pe[4] - pe[0] + pe[5] - pe[1] + pe[6] - pe[2] + pe[7] - pe[3]) / (4 * hz);
    density[c] = g.bulk[c] * Math.hypot(gx, gy, gz);
  }
  return { power, density, total };
}
