// Linear (eigenvalue) buckling on the stress analysis's voxel grid. The static
// solve gives each cell's stress under the loads; that stress makes the
// geometric stiffness Kg (compression softens the structure, tension stiffens
// it), and the loads buckle the parts when K + λ·Kg turns singular. The
// smallest positive λ is the buckling factor: how many times the loads it
// takes. Found by subspace iteration on K⁻¹·Kg, with the multigrid-
// preconditioned solver for K, then Rayleigh–Ritz on the subspace.

import { pcg, type Hierarchy } from "./solver";
import { jacobiEigen } from "./dense";

/**
 * The six 8×8 matrices that make a box's geometric stiffness from its stress: Kg = Σ σ_pq·A_pq for
 * xx, yy, zz, then xy, yz, zx (each shear one already summed with its transpose), with
 * A_pq[a][b] = ∫ ∂Nₐ/∂x_p · ∂N_b/∂x_q dV over the box. Corner a = dx + 2·dy + 4·dz.
 */
export function geometricMatrices(hx: number, hy: number, hz: number): Float64Array[] {
  const h = [hx, hy, hz];
  const s = (d: number, i: number, j: number) => (i === j ? 1 : -1) / h[d];
  const m = (d: number, i: number, j: number) => (h[d] / 6) * (i === j ? 2 : 1);
  // ∫ N_i' N_j along one axis: the derivative of N_i (∓1/h) times ∫N_j (h/2)
  const g = (i: number) => (i === 0 ? -0.5 : 0.5);
  const bit = (a: number, d: number) => (a >> d) & 1;
  /** ∫ ∂Nₐ/∂x_p ∂N_b/∂x_q */
  const A = (p: number, q: number, a: number, b: number) => {
    let v = 1;
    for (let d = 0; d < 3; d++) {
      const ad = bit(a, d),
        bd = bit(b, d);
      if (p === d && q === d) v *= s(d, ad, bd);
      else if (p === d) v *= g(ad);
      else if (q === d) v *= g(bd);
      else v *= m(d, ad, bd);
    }
    return v;
  };
  const pairs: [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [0, 1],
    [1, 2],
    [2, 0],
  ];
  return pairs.map(([p, q]) => {
    const M = new Float64Array(64);
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) M[a * 8 + b] = p === q ? A(p, p, a, b) : A(p, q, a, b) + A(q, p, a, b);
    return M;
  });
}

export interface BucklingInput {
  H: Hierarchy;
  /** active cells and each one's stress under the loads (6 per cell, Voigt xx yy zz xy yz zx, times its fill), in the same order */
  cells: Int32Array;
  stress: Float64Array;
  /** grid cells per axis and cell size */
  n: [number, number, number];
  h: [number, number, number];
  /** buckling shapes wanted */
  modes: number;
  onIter?: (it: number, change: number) => void;
}

export interface BucklingSolve {
  /** load factors, the positive ones (buckling under the loads as given) from smallest up */
  factors: number[];
  /** shapes for each factor, 3 per node, scaled so the largest movement is 1 */
  shapes: Float64Array[];
  /** the smallest factor with the loads reversed (a negative eigenvalue), if one was found */
  reversed: number | null;
  iterations: number;
  converged: boolean;
}

/** The stress a static solve left in each cell, which is all the geometric stiffness needs. */
type CellStress = Pick<BucklingInput, "cells" | "stress" | "n" | "h">;

/** y = Kg·x on free dofs. */
function applyKg(inp: CellStress, A: Float64Array[], free: Uint8Array, x: Float64Array, y: Float64Array) {
  const [nx, ny] = inp.n;
  const NX = nx + 1,
    NY = ny + 1;
  const off = [0, 1, NX, NX + 1, NX * NY, NX * NY + 1, NX * NY + NX, NX * NY + NX + 1];
  y.fill(0);
  const Ke = new Float64Array(64);
  const xe = new Float64Array(24);
  for (let c = 0; c < inp.cells.length; c++) {
    const so = 6 * c;
    const sx = inp.stress[so],
      sy = inp.stress[so + 1],
      sz = inp.stress[so + 2],
      sxy = inp.stress[so + 3],
      syz = inp.stress[so + 4],
      szx = inp.stress[so + 5];
    if (sx === 0 && sy === 0 && sz === 0 && sxy === 0 && syz === 0 && szx === 0) continue;
    for (let q = 0; q < 64; q++) Ke[q] = sx * A[0][q] + sy * A[1][q] + sz * A[2][q] + sxy * A[3][q] + syz * A[4][q] + szx * A[5][q];
    const e = inp.cells[c];
    const i = e % nx,
      j = Math.floor(e / nx) % ny,
      k = Math.floor(e / (nx * ny));
    const n0 = i + NX * (j + NY * k);
    for (let a = 0; a < 8; a++) {
      const d = 3 * (n0 + off[a]);
      xe[3 * a] = x[d];
      xe[3 * a + 1] = x[d + 1];
      xe[3 * a + 2] = x[d + 2];
    }
    for (let a = 0; a < 8; a++) {
      let s0 = 0,
        s1 = 0,
        s2 = 0;
      for (let b = 0; b < 8; b++) {
        const kab = Ke[a * 8 + b];
        s0 += kab * xe[3 * b];
        s1 += kab * xe[3 * b + 1];
        s2 += kab * xe[3 * b + 2];
      }
      const d = 3 * (n0 + off[a]);
      y[d] += s0;
      y[d + 1] += s1;
      y[d + 2] += s2;
    }
  }
  for (let i = 0; i < y.length; i++) if (!free[i]) y[i] = 0;
}

/**
 * The loads' geometric stiffness as an operator, y = Kg·x (full dofs, zero on held ones): added to K it gives the
 * stiffness of the parts as loaded, for natural frequencies under load (tension stiffens, compression softens).
 */
export function geometricStiffness(inp: CellStress, free: Uint8Array): (x: Float64Array, y: Float64Array) => void {
  const A = geometricMatrices(...inp.h);
  return (x, y) => applyKg(inp, A, free, x, y);
}

const dotF = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Lower-triangular Cholesky of a small SPD matrix (row-major), or null when it is not positive definite. */
function cholesky(M: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = M[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  return L;
}

/** Solve L·x = b (forward) for each column of B (n×m row-major), in place. */
function forward(L: Float64Array, n: number, B: Float64Array, m: number) {
  for (let c = 0; c < m; c++)
    for (let i = 0; i < n; i++) {
      let s = B[i * m + c];
      for (let k = 0; k < i; k++) s -= L[i * n + k] * B[k * m + c];
      B[i * m + c] = s / L[i * n + i];
    }
}

/** Solve Lᵀ·x = b (backward) for each column of B (n×m row-major), in place. */
function backward(L: Float64Array, n: number, B: Float64Array, m: number) {
  for (let c = 0; c < m; c++)
    for (let i = n - 1; i >= 0; i--) {
      let s = B[i * m + c];
      for (let k = i + 1; k < n; k++) s -= L[k * n + i] * B[k * m + c];
      B[i * m + c] = s / L[i * n + i];
    }
}

export function bucklingModes(inp: BucklingInput): BucklingSolve {
  const L0 = inp.H.levels[0];
  const free = L0.free;
  const N = free.length;
  const k = Math.max(1, Math.min(6, Math.round(inp.modes)));
  const p = Math.min(k + 4, 2 * k + 2);
  const A = geometricMatrices(...inp.h);
  // a deterministic start: smooth random fields, so every run of the same model gives the same answer
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  let X: Float64Array[] = [];
  for (let j = 0; j < p; j++) {
    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) v[i] = free[i] ? rnd() : 0;
    X.push(v);
  }
  // Y = Kg·X for the current X
  let Y: Float64Array[] = X.map((x) => {
    const y = new Float64Array(N);
    applyKg(inp, A, free, x, y);
    return y;
  });
  let mus: number[] = [];
  let it = 0;
  let converged = false;
  const maxIt = 40;
  const prev: number[] = [];
  while (it < maxIt) {
    it++;
    // Z = K⁻¹·Kg·X
    const Z = Y.map((y) => pcg(inp.H, y, { tol: 1e-6, maxIter: 400 }).u);
    // Rayleigh–Ritz: Kr = Zᵀ K Z = Zᵀ Y (K Z = Y), Gr = Zᵀ Kg Z
    const W = Z.map((z) => {
      const w = new Float64Array(N);
      applyKg(inp, A, free, z, w);
      return w;
    });
    const Kr = new Float64Array(p * p);
    const Gr = new Float64Array(p * p);
    for (let a = 0; a < p; a++)
      for (let b = a; b < p; b++) {
        const kr = 0.5 * (dotF(Z[a], Y[b]) + dotF(Z[b], Y[a]));
        const gr = 0.5 * (dotF(Z[a], W[b]) + dotF(Z[b], W[a]));
        Kr[a * p + b] = Kr[b * p + a] = kr;
        Gr[a * p + b] = Gr[b * p + a] = gr;
      }
    const Lc = cholesky(Kr, p);
    if (!Lc) break;
    // C = L⁻¹ Gr L⁻ᵀ
    const C = Float64Array.from(Gr);
    forward(Lc, p, C, p);
    // C ← (L⁻¹ (L⁻¹ Gr)ᵀ)ᵀ: transpose, forward again, and it stays symmetric
    const Ct = new Float64Array(p * p);
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) Ct[a * p + b] = C[b * p + a];
    forward(Lc, p, Ct, p);
    for (let a = 0; a < p; a++) for (let b = a + 1; b < p; b++) Ct[a * p + b] = Ct[b * p + a] = 0.5 * (Ct[a * p + b] + Ct[b * p + a]);
    const { values, vectors } = jacobiEigen(Ct, p);
    // order by |μ| (largest first: those are the smallest |λ|)
    const order = values.map((_, i) => i).sort((a, b) => Math.abs(values[b]) - Math.abs(values[a]));
    // coefficients c = L⁻ᵀ v, as columns
    const V = new Float64Array(p * p);
    order.forEach((src, col) => {
      for (let r = 0; r < p; r++) V[r * p + col] = vectors[src * p + r];
    });
    backward(Lc, p, V, p);
    const Xn: Float64Array[] = [];
    const Yn: Float64Array[] = [];
    for (let col = 0; col < p; col++) {
      const x = new Float64Array(N);
      const y = new Float64Array(N);
      for (let r = 0; r < p; r++) {
        const c = V[r * p + col];
        if (c === 0) continue;
        const zr = Z[r],
          wr = W[r];
        for (let i = 0; i < N; i++) {
          x[i] += c * zr[i];
          y[i] += c * wr[i];
        }
      }
      Xn.push(x);
      Yn.push(y);
    }
    X = Xn;
    Y = Yn;
    mus = order.map((i) => values[i]);
    // converged when the wanted values stop moving
    let change = 0;
    for (let j = 0; j < k; j++) {
      const m = mus[j];
      if (prev[j] !== undefined) change = Math.max(change, Math.abs(m - prev[j]) / Math.max(Math.abs(m), 1e-30));
      else change = Infinity;
      prev[j] = m;
    }
    inp.onIter?.(it, change);
    if (it > 2 && change < 1e-4) {
      converged = true;
      break;
    }
  }
  // λ = −1/μ: positive λ buckle under the loads as given
  const pairs = mus.map((mu, j) => ({ lambda: mu !== 0 ? -1 / mu : Infinity, j }));
  const pos = pairs.filter((q) => q.lambda > 0 && Number.isFinite(q.lambda)).sort((a, b) => a.lambda - b.lambda);
  const neg = pairs.filter((q) => q.lambda < 0 && Number.isFinite(q.lambda)).sort((a, b) => b.lambda - a.lambda);
  const keep = pos.slice(0, k);
  const shapes = keep.map((q) => {
    const v = Float64Array.from(X[q.j]);
    let mx = 0;
    for (let i = 0; i < v.length; i += 3) mx = Math.max(mx, Math.hypot(v[i], v[i + 1], v[i + 2]));
    if (mx > 0) for (let i = 0; i < v.length; i++) v[i] /= mx;
    return v;
  });
  return { factors: keep.map((q) => q.lambda), shapes, reversed: neg.length ? -neg[0].lambda : null, iterations: it, converged };
}
