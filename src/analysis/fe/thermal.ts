// Heat conduction through the parts on the stress analysis's voxel grid:
// steady state and warm-up over time, with heat made inside parts or on
// surfaces, film cooling and radiation from the exposed faces, and surfaces
// held at a temperature. One temperature per grid node, trilinear bricks of
// the cells' own conductivity, lumped heat capacity, and a Jacobi-
// preconditioned conjugate-gradient solve (the conduction matrix is
// symmetric and, with any cooling or fixed temperature, positive definite).
// Units: mm, W, °C (kelvin for radiation), J.

import type { FilmSpec, FixedTempSpec, HeatLoadSpec } from "../spec";

/** What a heat analysis asks for, as the solver input carries it (heat loads already resolved to part names and instances). */
export interface ThermalInput {
  heat: HeatLoadSpec[];
  fixed: FixedTempSpec[];
  /** film coefficient on every surface no film covers, W/(m²·K) */
  cooling: number;
  coolingText: string;
  films: FilmSpec[];
  /** °C */
  ambient: number;
  /** what set the ambient (the brief, the block, or room temperature) */
  ambientWhy?: string;
  emissivity?: number;
  /** warm-up time, s */
  time?: number;
  /** °C */
  start?: number;
  /** °C limit for every part */
  maxTemp?: number;
}

/** The heat problem on the grid: everything the solver needs, already mapped onto cells and nodes. */
export interface HeatGrid {
  /** cells per axis (the nodes are one more each way) */
  n: [number, number, number];
  /** cell size, mm */
  h: [number, number, number];
  /** active cells */
  cells: Int32Array;
  /** per active cell (same order): conductance k·fill, W/(mm·K) */
  kc: Float64Array;
  /** per active cell: heat capacity ρ·cp·V·fill, J/K */
  cap: Float64Array;
  /** per node: film conductance Σh·A to the surroundings, W/K, and Σh·A·T_ambient, W */
  hA: Float64Array;
  hAT: Float64Array;
  /** per node: emissive area ε·A for radiation, mm² (optional) */
  epsA?: Float64Array;
  /** surroundings for radiation, °C */
  ambient: number;
  /** per node: heat made there, W */
  q: Float64Array;
  /** per node: a held temperature (°C), NaN where free */
  fixedT: Float64Array;
}

export interface HeatSolve {
  /** per node, °C (only meaningful on nodes of active cells) */
  T: Float64Array;
  iterations: number;
  residual: number;
  converged: boolean;
}

/** Stefan–Boltzmann constant per mm²: 5.670e-8 W/(m²·K⁴) */
export const SIGMA_MM = 5.670374e-14;
const K0 = 273.15;

/** 8×8 conduction matrix of a box with unit conductivity: ∫∇Nₐ·∇N_b dV. Corner a = dx + 2·dy + 4·dz. */
export function conductionMatrix(hx: number, hy: number, hz: number): Float64Array {
  const s = (h: number, i: number, j: number) => (i === j ? 1 : -1) / h;
  const m = (h: number, i: number, j: number) => (h / 6) * (i === j ? 2 : 1);
  const K = new Float64Array(64);
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++) {
      const ax = a & 1,
        ay = (a >> 1) & 1,
        az = (a >> 2) & 1;
      const bx = b & 1,
        by = (b >> 1) & 1,
        bz = (b >> 2) & 1;
      K[a * 8 + b] = s(hx, ax, bx) * m(hy, ay, by) * m(hz, az, bz) + m(hx, ax, bx) * s(hy, ay, by) * m(hz, az, bz) + m(hx, ax, bx) * m(hy, ay, by) * s(hz, az, bz);
    }
  return K;
}

/** Node offsets of a cell's eight corners, for nodes numbered i + NX·(j + NY·k). */
export function cornerOffsets(nx: number, ny: number): Int32Array {
  const NX = nx + 1,
    NY = ny + 1;
  return Int32Array.from([0, 1, NX, NX + 1, NX * NY, NX * NY + 1, NX * NY + NX, NX * NY + NX + 1]);
}

/** y = (K + diag)·x over the grid (conduction through the active cells plus a per-node diagonal). */
function applyHeat(g: HeatGrid, Ke: Float64Array, off: Int32Array, diag: Float64Array, x: Float64Array, y: Float64Array) {
  const [nx, ny] = g.n;
  const NX = nx + 1,
    NY = ny + 1;
  for (let n = 0; n < y.length; n++) y[n] = diag[n] * x[n];
  const xe = new Float64Array(8);
  const cells = g.cells;
  for (let c = 0; c < cells.length; c++) {
    const e = cells[c];
    const i = e % nx,
      j = Math.floor(e / nx) % ny,
      k = Math.floor(e / (nx * ny));
    const n0 = i + NX * (j + NY * k);
    for (let a = 0; a < 8; a++) xe[a] = x[n0 + off[a]];
    const kc = g.kc[c];
    for (let a = 0; a < 8; a++) {
      let s = 0;
      const row = a * 8;
      for (let b = 0; b < 8; b++) s += Ke[row + b] * xe[b];
      y[n0 + off[a]] += kc * s;
    }
  }
}

/** Nodes that belong to at least one active cell. */
export function activeNodes(g: HeatGrid): Uint8Array {
  const [nx, ny, nz] = g.n;
  const NX = nx + 1,
    NY = ny + 1;
  const on = new Uint8Array(NX * NY * (nz + 1));
  const off = cornerOffsets(nx, ny);
  for (const e of g.cells) {
    const i = e % nx,
      j = Math.floor(e / nx) % ny,
      k = Math.floor(e / (nx * ny));
    const n0 = i + NX * (j + NY * k);
    for (let a = 0; a < 8; a++) on[n0 + off[a]] = 1;
  }
  return on;
}

/**
 * Solve (K + diag)·T = b on the free active nodes by Jacobi-preconditioned CG, starting from T (fixed nodes keep
 * their values in T). Returns the iteration count and the relative residual reached.
 */
function pcgHeat(g: HeatGrid, Ke: Float64Array, off: Int32Array, diag: Float64Array, b: Float64Array, T: Float64Array, free: Uint8Array, tol: number, maxIter: number) {
  const nn = T.length;
  // the diagonal of K for the preconditioner
  const dK = Float64Array.from(diag);
  {
    const [nx, ny] = g.n;
    const NX = nx + 1,
      NY = ny + 1;
    for (let c = 0; c < g.cells.length; c++) {
      const e = g.cells[c];
      const i = e % nx,
        j = Math.floor(e / nx) % ny,
        k = Math.floor(e / (nx * ny));
      const n0 = i + NX * (j + NY * k);
      for (let a = 0; a < 8; a++) dK[n0 + off[a]] += g.kc[c] * Ke[a * 9];
    }
  }
  const r = new Float64Array(nn);
  const z = new Float64Array(nn);
  const p = new Float64Array(nn);
  const q = new Float64Array(nn);
  applyHeat(g, Ke, off, diag, T, q);
  let bn = 0;
  for (let n = 0; n < nn; n++) {
    if (!free[n]) continue;
    r[n] = b[n] - q[n];
    bn += b[n] * b[n];
  }
  bn = Math.sqrt(bn);
  let rn = 0;
  for (let n = 0; n < nn; n++) rn += r[n] * r[n];
  const scale = Math.max(bn, Math.sqrt(rn), 1e-30);
  let rz = 0;
  for (let n = 0; n < nn; n++) {
    if (!free[n]) continue;
    z[n] = r[n] / dK[n];
    rz += r[n] * z[n];
  }
  p.set(z);
  let rel = Math.sqrt(rn) / scale;
  let it = 0;
  while (it < maxIter && rel > tol) {
    applyHeat(g, Ke, off, diag, p, q);
    let pq = 0;
    for (let n = 0; n < nn; n++) if (free[n]) pq += p[n] * q[n];
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    let rr = 0;
    for (let n = 0; n < nn; n++) {
      if (!free[n]) continue;
      T[n] += alpha * p[n];
      r[n] -= alpha * q[n];
      rr += r[n] * r[n];
    }
    it++;
    rel = Math.sqrt(rr) / scale;
    if (rel <= tol) break;
    let rzNew = 0;
    for (let n = 0; n < nn; n++) {
      if (!free[n]) continue;
      z[n] = r[n] / dK[n];
      rzNew += r[n] * z[n];
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let n = 0; n < nn; n++) p[n] = free[n] ? z[n] + beta * p[n] : 0;
  }
  return { iterations: it, residual: rel };
}

/**
 * Radiation linearised about the current temperatures (Newton): the heat radiated εσA(T⁴ − Ta⁴), in kelvin, is
 * taken as c + d·(T − T₀) with d = 4εσA·T₀³, so it adds d to the diagonal and d·T₀ − c to the right-hand side.
 * Newton settles in a few passes where a secant film coefficient would swing back and forth.
 */
function radiationTerms(g: HeatGrid, T: Float64Array, d: Float64Array, rhs: Float64Array) {
  if (!g.epsA) return;
  const ta = g.ambient + K0;
  const ta4 = ta ** 4;
  for (let n = 0; n < d.length; n++) {
    const ea = g.epsA[n];
    if (!ea) {
      d[n] = 0;
      rhs[n] = 0;
      continue;
    }
    const t0 = Number.isFinite(T[n]) ? T[n] : g.ambient;
    const t = Math.max(t0 + K0, 1);
    const t3 = t * t * t;
    d[n] = 4 * SIGMA_MM * ea * t3;
    rhs[n] = d[n] * t0 - SIGMA_MM * ea * (t3 * t - ta4);
  }
}

function freeMask(g: HeatGrid, on: Uint8Array): Uint8Array {
  const free = new Uint8Array(on.length);
  for (let n = 0; n < on.length; n++) free[n] = on[n] && !Number.isFinite(g.fixedT[n]) ? 1 : 0;
  return free;
}

/** Whether heat can leave in a steady state: some film, radiation or held temperature. */
export function hasHeatPath(g: HeatGrid): boolean {
  for (let n = 0; n < g.hA.length; n++) if (g.hA[n] > 0 || (g.epsA && g.epsA[n] > 0) || Number.isFinite(g.fixedT[n])) return true;
  return false;
}

/** The steady state: conduction balances the heat made against the films, radiation and held temperatures. */
export function solveSteady(g: HeatGrid, opts: { tol?: number; maxIter?: number; start?: Float64Array } = {}): HeatSolve {
  const nn = g.q.length;
  const Ke = conductionMatrix(...g.h);
  const off = cornerOffsets(g.n[0], g.n[1]);
  const on = activeNodes(g);
  const free = freeMask(g, on);
  const T = opts.start ? Float64Array.from(opts.start) : new Float64Array(nn).fill(g.ambient);
  for (let n = 0; n < nn; n++) if (Number.isFinite(g.fixedT[n])) T[n] = g.fixedT[n];
  const tol = opts.tol ?? 1e-7;
  const maxIter = opts.maxIter ?? 6000;
  const rd = new Float64Array(nn);
  const rb = new Float64Array(nn);
  const diag = new Float64Array(nn);
  const b = new Float64Array(nn);
  let iterations = 0;
  let residual = 0;
  // radiation is nonlinear: re-linearise about the latest temperatures until they stop moving
  const passes = g.epsA ? 14 : 1;
  for (let pass = 0; pass < passes; pass++) {
    radiationTerms(g, T, rd, rb);
    for (let n = 0; n < nn; n++) {
      diag[n] = g.hA[n] + rd[n];
      b[n] = g.q[n] + g.hAT[n] + rb[n];
    }
    const before = pass ? Float64Array.from(T) : null;
    const s = pcgHeat(g, Ke, off, diag, b, T, free, tol, maxIter);
    iterations += s.iterations;
    residual = s.residual;
    if (before) {
      let moved = 0;
      for (let n = 0; n < nn; n++) if (on[n]) moved = Math.max(moved, Math.abs(T[n] - before[n]));
      if (moved < 0.01) break;
    }
  }
  return { T, iterations, residual, converged: residual <= tol * 10 };
}

/** Time steps for a warm-up: short ones first (heat spreads fast near sources), growing by a fixed ratio to the end. */
export function warmupSteps(time: number, count = 40, ratio = 1.12): number[] {
  const dt0 = (time * (ratio - 1)) / (Math.pow(ratio, count) - 1);
  const out: number[] = [];
  let dt = dt0;
  for (let i = 0; i < count; i++) {
    out.push(dt);
    dt *= ratio;
  }
  return out;
}

/**
 * Warm-up from a uniform start temperature over `time` seconds by backward Euler (unconditionally stable),
 * calling onStep after each step with the time reached and the temperatures.
 */
export function solveTransient(g: HeatGrid, time: number, start: number, onStep: (t: number, T: Float64Array) => void, opts: { tol?: number; steps?: number } = {}): HeatSolve {
  const nn = g.q.length;
  const Ke = conductionMatrix(...g.h);
  const off = cornerOffsets(g.n[0], g.n[1]);
  const on = activeNodes(g);
  const free = freeMask(g, on);
  const C = new Float64Array(nn);
  {
    const [nx, ny] = g.n;
    const NX = nx + 1,
      NY = ny + 1;
    for (let c = 0; c < g.cells.length; c++) {
      const e = g.cells[c];
      const i = e % nx,
        j = Math.floor(e / nx) % ny,
        k = Math.floor(e / (nx * ny));
      const n0 = i + NX * (j + NY * k);
      for (let a = 0; a < 8; a++) C[n0 + off[a]] += g.cap[c] / 8;
    }
  }
  const T = new Float64Array(nn).fill(start);
  for (let n = 0; n < nn; n++) if (Number.isFinite(g.fixedT[n])) T[n] = g.fixedT[n];
  const tol = opts.tol ?? 1e-7;
  const rd = new Float64Array(nn);
  const rb = new Float64Array(nn);
  const diag = new Float64Array(nn);
  const b = new Float64Array(nn);
  let iterations = 0;
  let residual = 0;
  let t = 0;
  onStep(0, T);
  for (const dt of warmupSteps(time, opts.steps ?? 40)) {
    // radiation linearised about the last step's temperatures
    radiationTerms(g, T, rd, rb);
    for (let n = 0; n < nn; n++) {
      const c = C[n] / dt;
      diag[n] = g.hA[n] + rd[n] + c;
      b[n] = g.q[n] + g.hAT[n] + rb[n] + c * T[n];
    }
    const s = pcgHeat(g, Ke, off, diag, b, T, free, tol, 4000);
    iterations += s.iterations;
    residual = Math.max(residual, s.residual);
    t += dt;
    onStep(t, T);
  }
  return { T, iterations, residual, converged: residual <= tol * 10 };
}

/** Where the heat goes in a steady state: into films, out by radiation, into held surfaces (W). */
export function heatBalance(g: HeatGrid, T: Float64Array): { made: number; film: number; radiation: number; held: number } {
  let made = 0,
    film = 0,
    radiation = 0;
  const ta = g.ambient + K0;
  const on = activeNodes(g);
  for (let n = 0; n < T.length; n++) {
    made += g.q[n];
    if (!on[n]) continue;
    film += g.hA[n] * T[n] - g.hAT[n];
    if (g.epsA?.[n]) radiation += SIGMA_MM * g.epsA[n] * ((T[n] + K0) ** 4 - ta ** 4);
  }
  // what the held surfaces take is the rest of the heat made (in a steady state)
  return { made, film, radiation, held: made - film - radiation };
}
