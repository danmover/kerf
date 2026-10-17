// Small dense linear algebra for the solvers: symmetric eigenproblems of a
// few dozen unknowns (rigid-body checks, Rayleigh-Ritz steps).

/** Eigenvalues and eigenvectors (as rows) of a symmetric n×n matrix by cyclic Jacobi rotations. */
export function jacobiEigen(Ain: Float64Array, n: number): { values: number[]; vectors: Float64Array } {
  const A = Float64Array.from(Ain);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1),
          sn = t * cs;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p],
            akq = A[k * n + q];
          A[k * n + p] = cs * akp - sn * akq;
          A[k * n + q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k],
            aqk = A[q * n + k];
          A[p * n + k] = cs * apk - sn * aqk;
          A[q * n + k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p],
            vkq = V[k * n + q];
          V[k * n + p] = cs * vkp - sn * vkq;
          V[k * n + q] = sn * vkp + cs * vkq;
        }
      }
  }
  const values = Array.from({ length: n }, (_, i) => A[i * n + i]);
  // eigenvector i is column i of V; return them as rows
  const vectors = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) vectors[i * n + k] = V[k * n + i];
  return { values, vectors };
}

