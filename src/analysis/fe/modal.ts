// Natural frequencies and mode shapes: the smallest eigenpairs of
// K φ = ω² M φ on the voxel model, by LOBPCG (Knyazev 2001) with the static
// solver's multigrid V-cycle as the preconditioner, so a few modes cost a
// few dozen V-cycles each. M is lumped (each element's mass shared equally
// by its corners). Units: K in N/mm and M in tonnes give ω² in 1/s².

import { applyK, precondition, type Hierarchy } from "./solver";
import { jacobiEigen } from "./dense";

export interface ModalSolve {
  /** ω² per mode, ascending */
  lambda: number[];
  /** M-normalised mode shapes (φᵀ M φ = 1), zero on held dofs */
  shapes: Float64Array[];
  iterations: number;
  /** largest relative residual of the wanted modes */
  residual: number;
  converged: boolean;
}

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

const dotv = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * Smallest `k` eigenpairs of K φ = λ M φ. `mass` is the lumped mass per dof (0 where not free).
 * Guard vectors (a few more than asked for) speed up convergence of the last wanted mode.
 */
export function lowestModes(H: Hierarchy, mass: Float64Array, k: number, opts: { tol?: number; maxIter?: number; onIter?: (it: number, res: number) => void } = {}): ModalSolve {
  const L = H.levels[0];
  const n = mass.length;
  const free = L.free;
  const tol = opts.tol ?? 1e-4;
  const maxIter = opts.maxIter ?? 120;
  const m = k + Math.min(4, Math.max(2, Math.ceil(k / 2)));
  const A = (x: Float64Array, y: Float64Array) => applyK(L, x, y);
  const M = (x: Float64Array, y: Float64Array) => {
    for (let i = 0; i < n; i++) y[i] = mass[i] * x[i];
  };
  const T = (r: Float64Array, z: Float64Array) => {
    precondition(H, r, z);
    for (let i = 0; i < n; i++) if (!free[i]) z[i] = 0;
  };

  // start from random vectors; the preconditioner smooths them toward low modes at once
  const r0 = rng(12345);
  let X: Float64Array[] = [];
  for (let j = 0; j < m; j++) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) if (free[i]) v[i] = r0();
    const z = new Float64Array(n);
    T(v, z);
    X.push(z);
  }
  let AX = X.map(() => new Float64Array(n));
  let MX = X.map(() => new Float64Array(n));
  let P: Float64Array[] = [];
  let AP: Float64Array[] = [];
  let MP: Float64Array[] = [];
  let theta: number[] = [];
  let it = 0;
  let worst = Infinity;

  /** Rayleigh-Ritz on the span of S (with A·S and M·S known): the m lowest Ritz pairs as coefficient vectors. */
  const ritz = (S: Float64Array[], AS: Float64Array[], MS: Float64Array[]): { values: number[]; C: Float64Array[] } | null => {
    const q = S.length;
    // scale every column to unit M-norm so the Gram matrices are well conditioned
    const sc = S.map((_, i) => 1 / Math.sqrt(Math.max(dotv(S[i], MS[i]), 1e-300)));
    const GA = new Float64Array(q * q);
    const GM = new Float64Array(q * q);
    for (let i = 0; i < q; i++)
      for (let j = i; j < q; j++) {
        const a = dotv(S[i], AS[j]) * sc[i] * sc[j];
        const b = dotv(S[i], MS[j]) * sc[i] * sc[j];
        GA[i * q + j] = GA[j * q + i] = a;
        GM[i * q + j] = GM[j * q + i] = b;
      }
    // Cholesky of GM; a column that is (nearly) a combination of the others is dropped
    const keep: number[] = [];
    const Lc = new Float64Array(q * q);
    for (let i = 0; i < q; i++) {
      // tentative row i against the kept columns
      const row = new Float64Array(q);
      let ok = true;
      for (let jj = 0; jj < keep.length; jj++) {
        const j = keep[jj];
        let s = GM[i * q + j];
        for (let kk = 0; kk < jj; kk++) s -= row[keep[kk]] * Lc[j * q + keep[kk]];
        row[j] = s / Lc[j * q + j];
      }
      let d = GM[i * q + i];
      for (const j of keep) d -= row[j] * row[j];
      if (!(d > 1e-10)) ok = false;
      if (!ok) continue;
      row[i] = Math.sqrt(d);
      for (let j = 0; j < q; j++) Lc[i * q + j] = row[j];
      keep.push(i);
    }
    const r = keep.length;
    if (r < Math.min(m, q)) return null;
    // B = L⁻¹ GA L⁻ᵀ restricted to the kept columns
    const Lk = new Float64Array(r * r);
    for (let a = 0; a < r; a++) for (let b = 0; b <= a; b++) Lk[a * r + b] = Lc[keep[a] * q + keep[b]];
    const Ak = new Float64Array(r * r);
    for (let a = 0; a < r; a++) for (let b = 0; b < r; b++) Ak[a * r + b] = GA[keep[a] * q + keep[b]];
    // Y = L⁻¹ Ak (forward substitution on columns), then B = Y L⁻ᵀ
    const Y = new Float64Array(r * r);
    for (let c = 0; c < r; c++)
      for (let a = 0; a < r; a++) {
        let s = Ak[a * r + c];
        for (let b = 0; b < a; b++) s -= Lk[a * r + b] * Y[b * r + c];
        Y[a * r + c] = s / Lk[a * r + a];
      }
    const B = new Float64Array(r * r);
    for (let a = 0; a < r; a++)
      for (let c = 0; c < r; c++) {
        let s = Y[a * r + c];
        for (let b = 0; b < c; b++) s -= B[a * r + b] * Lk[c * r + b];
        B[a * r + c] = s / Lk[c * r + c];
      }
    for (let a = 0; a < r; a++)
      for (let c = a + 1; c < r; c++) {
        const v = (B[a * r + c] + B[c * r + a]) / 2;
        B[a * r + c] = B[c * r + a] = v;
      }
    const { values, vectors } = jacobiEigen(B, r);
    const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]).slice(0, m);
    // coefficients in S: c = scale · L⁻ᵀ y
    const C = order.map(([, idx]) => {
      const y = vectors.slice(idx * r, idx * r + r);
      const z = new Float64Array(r);
      for (let a = r - 1; a >= 0; a--) {
        let s = y[a];
        for (let b = a + 1; b < r; b++) s -= Lk[b * r + a] * z[b];
        z[a] = s / Lk[a * r + a];
      }
      const c = new Float64Array(q);
      keep.forEach((col, a) => (c[col] = z[a] * sc[col]));
      return c;
    });
    return { values: order.map(([v]) => v), C };
  };
  const combine = (S: Float64Array[], c: Float64Array, from = 0, to = S.length) => {
    const out = new Float64Array(n);
    for (let j = from; j < to; j++) {
      const w = c[j];
      if (w === 0) continue;
      const v = S[j];
      for (let i = 0; i < n; i++) out[i] += w * v[i];
    }
    return out;
  };

  for (let j = 0; j < m; j++) {
    A(X[j], AX[j]);
    M(X[j], MX[j]);
  }
  {
    const rr = ritz(X, AX, MX);
    if (!rr) throw new Error("The modal solver could not start: the model may have no mass.");
    theta = rr.values;
    X = rr.C.map((c) => combine(X, c));
    AX = rr.C.map((c) => combine(AX, c));
    MX = rr.C.map((c) => combine(MX, c));
  }
  const R = X.map(() => new Float64Array(n));
  for (it = 1; it <= maxIter; it++) {
    // residuals
    const res: number[] = [];
    for (let j = 0; j < m; j++) {
      const r = R[j];
      for (let i = 0; i < n; i++) r[i] = AX[j][i] - theta[j] * MX[j][i];
      res.push(Math.sqrt(dotv(r, r)) / Math.max(Math.abs(theta[j]) * Math.sqrt(dotv(MX[j], MX[j])), 1e-300));
    }
    worst = Math.max(...res.slice(0, k));
    opts.onIter?.(it, worst);
    if (worst < tol) break;
    const active = res.map((v, j) => (v >= tol * 0.1 ? j : -1)).filter((j) => j >= 0);
    const W = active.map((j) => {
      const z = new Float64Array(n);
      T(R[j], z);
      return z;
    });
    const AW = W.map((w) => {
      const y = new Float64Array(n);
      A(w, y);
      return y;
    });
    const MW = W.map((w) => {
      const y = new Float64Array(n);
      M(w, y);
      return y;
    });
    let S = [...X, ...W, ...P];
    let AS = [...AX, ...AW, ...AP];
    let MS = [...MX, ...MW, ...MP];
    let rr = ritz(S, AS, MS);
    if (!rr && P.length) {
      // the search directions went dependent: restart without them
      P = [];
      AP = [];
      MP = [];
      S = [...X, ...W];
      AS = [...AX, ...AW];
      MS = [...MX, ...MW];
      rr = ritz(S, AS, MS);
    }
    if (!rr) break;
    const nx = X.length;
    theta = rr.values;
    const newP = rr.C.map((c) => combine(S, c, nx));
    const newAP = rr.C.map((c) => combine(AS, c, nx));
    const newMP = rr.C.map((c) => combine(MS, c, nx));
    X = rr.C.map((c, j) => {
      const v = combine(S, c, 0, nx);
      for (let i = 0; i < n; i++) v[i] += newP[j][i];
      return v;
    });
    AX = rr.C.map((c, j) => {
      const v = combine(AS, c, 0, nx);
      for (let i = 0; i < n; i++) v[i] += newAP[j][i];
      return v;
    });
    MX = rr.C.map((c, j) => {
      const v = combine(MS, c, 0, nx);
      for (let i = 0; i < n; i++) v[i] += newMP[j][i];
      return v;
    });
    P = newP;
    AP = newAP;
    MP = newMP;
  }
  // M-normalise the wanted modes
  const shapes = X.slice(0, k).map((x, j) => {
    const s = 1 / Math.sqrt(Math.max(dotv(x, MX[j]), 1e-300));
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = x[i] * s;
    return v;
  });
  return { lambda: theta.slice(0, k), shapes, iterations: Math.min(it, maxIter), residual: worst, converged: worst < tol * 10 };
}
