// Sparse LU for the solver's nodal matrices. A circuit's matrix keeps the same
// pattern for every Newton iteration, time step and frequency, so the pivot
// order and the fill-in are worked out once and each factorisation replays a
// flat list of slot operations: no searching, no allocation.
//
// Slots: the circuit compiler numbers every structurally non-zero entry of the
// matrix (its "original" slots, plus one trash slot that stamps to ground
// write into). A plan maps those onto the slots of the factors.

export interface Plan {
  n: number;
  /** original row and column used as pivot k */
  pr: Int32Array;
  pc: Int32Array;
  /** original slot → factor slot; the original trash slot maps to the factor trash slot `size` */
  map: Int32Array;
  /** factor slots, not counting the trash slot */
  size: number;
  /** factor slot of pivot k */
  piv: Int32Array;
  /** column k of L below the pivot: slots and (pivot-order) rows */
  lptr: Int32Array;
  lslot: Int32Array;
  lrow: Int32Array;
  /** row k of U right of the pivot: slots and (pivot-order) columns */
  uptr: Int32Array;
  uslot: Int32Array;
  ucol: Int32Array;
  /** update targets, in the order the factorisation visits the (L, U) pairs */
  tgt: Int32Array;
}

/**
 * Pair every column with a row whose entry there is structurally safe to pivot
 * on (a node's own diagonal, or the ±1 that ties a voltage source to one of
 * its nodes). Branch rows of voltage sources have no diagonal, so they swap
 * with one of their nodes' rows. Returns the row placed at each column.
 */
export function matchRows(n: number, cands: number[][]): Int32Array {
  const rowOfCol = new Int32Array(n).fill(-1);
  const colOfRow = new Int32Array(n).fill(-1);
  // diagonals first: most rows keep their own column
  for (let c = 0; c < n; c++) {
    if (cands[c].includes(c)) {
      rowOfCol[c] = c;
      colOfRow[c] = c;
    }
  }
  const seen = new Uint8Array(n);
  const augment = (c: number): boolean => {
    for (const r of cands[c]) {
      if (seen[r]) continue;
      seen[r] = 1;
      if (colOfRow[r] < 0 || augment(colOfRow[r])) {
        colOfRow[r] = c;
        rowOfCol[c] = r;
        return true;
      }
    }
    return false;
  };
  for (let c = 0; c < n; c++) {
    if (rowOfCol[c] >= 0) continue;
    seen.fill(0);
    augment(c);
  }
  // whatever is left over is structurally singular (a loop of sources); pair it anyway
  const free: number[] = [];
  for (let r = 0; r < n; r++) if (colOfRow[r] < 0) free.push(r);
  for (let c = 0; c < n; c++) if (rowOfCol[c] < 0) rowOfCol[c] = free.pop()!;
  return rowOfCol;
}

/**
 * Pivot order from the pattern alone: rows placed by `rowFor`, then minimum
 * degree on the symmetrised pattern to keep the fill small.
 */
export function structuralOrder(n: number, rows: Int32Array, cols: Int32Array, rowFor: Int32Array): { pr: Int32Array; pc: Int32Array } {
  const posOfRow = new Int32Array(n);
  for (let c = 0; c < n; c++) posOfRow[rowFor[c]] = c;
  const adj: Set<number>[] = [];
  for (let i = 0; i < n; i++) adj.push(new Set());
  for (let s = 0; s < rows.length; s++) {
    const i = posOfRow[rows[s]];
    const j = cols[s];
    if (i !== j) {
      adj[i].add(j);
      adj[j].add(i);
    }
  }
  const alive = new Uint8Array(n).fill(1);
  const pr = new Int32Array(n);
  const pc = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestDeg = Infinity;
    for (let v = 0; v < n; v++) {
      if (alive[v] && adj[v].size < bestDeg) {
        best = v;
        bestDeg = adj[v].size;
      }
    }
    alive[best] = 0;
    pc[k] = best;
    pr[k] = rowFor[best];
    const nb = [...adj[best]];
    for (const a of nb) adj[a].delete(best);
    for (let x = 0; x < nb.length; x++) {
      for (let y = x + 1; y < nb.length; y++) {
        adj[nb[x]].add(nb[y]);
        adj[nb[y]].add(nb[x]);
      }
    }
  }
  return { pr, pc };
}

/**
 * Pivot order from the values: Markowitz with threshold partial pivoting on a
 * dense copy. Used when the structural order meets a zero pivot, which only
 * happens with unusual circuits, so its cubic cost is fine.
 */
export function numericOrder(n: number, rows: Int32Array, cols: Int32Array, re: Float64Array, im?: Float64Array): { pr: Int32Array; pc: Int32Array } {
  const A = new Float64Array(n * n);
  const B = new Float64Array(n * n);
  const nz = new Uint8Array(n * n);
  for (let s = 0; s < rows.length; s++) {
    const q = rows[s] * n + cols[s];
    A[q] += re[s];
    if (im) B[q] += im[s];
    nz[q] = 1;
  }
  const rowDone = new Uint8Array(n);
  const colDone = new Uint8Array(n);
  const rc = new Int32Array(n);
  const cc = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (nz[r * n + c]) {
        rc[r]++;
        cc[c]++;
      }
    }
  }
  const colMax = new Float64Array(n);
  const pr = new Int32Array(n);
  const pc = new Int32Array(n);
  const mag = (q: number) => Math.hypot(A[q], B[q]);
  for (let k = 0; k < n; k++) {
    colMax.fill(0);
    for (let r = 0; r < n; r++) {
      if (rowDone[r]) continue;
      for (let c = 0; c < n; c++) if (!colDone[c] && nz[r * n + c]) colMax[c] = Math.max(colMax[c], mag(r * n + c));
    }
    let br = -1;
    let bc = -1;
    let bestCost = Infinity;
    let bestRel = 0;
    for (let r = 0; r < n; r++) {
      if (rowDone[r]) continue;
      for (let c = 0; c < n; c++) {
        const q = r * n + c;
        if (colDone[c] || !nz[q]) continue;
        const m = mag(q);
        if (!(m > 0) || m < 0.1 * colMax[c]) continue;
        const cost = (rc[r] - 1) * (cc[c] - 1);
        const rel = m / colMax[c];
        if (cost < bestCost || (cost === bestCost && rel > bestRel)) {
          br = r;
          bc = c;
          bestCost = cost;
          bestRel = rel;
        }
      }
    }
    if (br < 0) {
      // singular: take any remaining pair so the order is complete
      for (let r = 0; r < n && br < 0; r++) if (!rowDone[r]) br = r;
      for (let c = 0; c < n && bc < 0; c++) if (!colDone[c]) bc = c;
    }
    pr[k] = br;
    pc[k] = bc;
    rowDone[br] = 1;
    colDone[bc] = 1;
    for (let c = 0; c < n; c++) if (nz[br * n + c]) cc[c]--;
    for (let r = 0; r < n; r++) if (nz[r * n + bc]) rc[r]--;
    const pq = br * n + bc;
    const pre = A[pq];
    const pim = B[pq];
    const d = pre * pre + pim * pim;
    if (!(d > 0)) continue;
    for (let r = 0; r < n; r++) {
      if (rowDone[r] || !nz[r * n + bc]) continue;
      const q = r * n + bc;
      // l = a[r][bc] / pivot
      const lre = (A[q] * pre + B[q] * pim) / d;
      const lim = (B[q] * pre - A[q] * pim) / d;
      for (let c = 0; c < n; c++) {
        if (colDone[c] || !nz[br * n + c]) continue;
        const t = r * n + c;
        const u = br * n + c;
        A[t] -= lre * A[u] - lim * B[u];
        B[t] -= lre * B[u] + lim * A[u];
        if (!nz[t]) {
          nz[t] = 1;
          rc[r]++;
          cc[c]++;
        }
      }
    }
  }
  return { pr, pc };
}

/** Symbolic factorisation for a given pivot order: fill pattern and the operation lists. */
export function makePlan(n: number, rows: Int32Array, cols: Int32Array, pr: Int32Array, pc: Int32Array): Plan {
  const rpos = new Int32Array(n);
  const cpos = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    rpos[pr[k]] = k;
    cpos[pc[k]] = k;
  }
  const W = (n + 31) >>> 5;
  const bits = new Uint32Array(n * W);
  const set = (i: number, j: number) => {
    bits[i * W + (j >>> 5)] |= 1 << (j & 31);
  };
  const has = (i: number, j: number) => (bits[i * W + (j >>> 5)] >>> (j & 31)) & 1;
  for (let k = 0; k < n; k++) set(k, k);
  const nnz = rows.length;
  for (let s = 0; s < nnz; s++) set(rpos[rows[s]], cpos[cols[s]]);
  // eliminate on the bit pattern: row i picks up row k's columns right of k
  for (let k = 0; k < n; k++) {
    const kw = k >>> 5;
    const mask = (k & 31) === 31 ? 0 : (0xffffffff << ((k & 31) + 1)) >>> 0;
    const rk = k * W;
    for (let i = k + 1; i < n; i++) {
      if (!has(i, k)) continue;
      const ri = i * W;
      bits[ri + kw] |= bits[rk + kw] & mask;
      for (let w = kw + 1; w < W; w++) bits[ri + w] |= bits[rk + w];
    }
  }
  const slotOf = new Int32Array(n * n).fill(-1);
  let size = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (has(i, j)) slotOf[i * n + j] = size++;
  const lptr = new Int32Array(n + 1);
  const uptr = new Int32Array(n + 1);
  const lrowL: number[] = [];
  const ucolL: number[] = [];
  let nt = 0;
  for (let k = 0; k < n; k++) {
    lptr[k] = lrowL.length;
    uptr[k] = ucolL.length;
    let nl = 0;
    let nu = 0;
    for (let i = k + 1; i < n; i++) {
      if (has(i, k)) {
        lrowL.push(i);
        nl++;
      }
    }
    for (let j = k + 1; j < n; j++) {
      if (has(k, j)) {
        ucolL.push(j);
        nu++;
      }
    }
    nt += nl * nu;
  }
  lptr[n] = lrowL.length;
  uptr[n] = ucolL.length;
  const lrow = Int32Array.from(lrowL);
  const ucol = Int32Array.from(ucolL);
  const lslot = new Int32Array(lrow.length);
  const uslot = new Int32Array(ucol.length);
  const tgt = new Int32Array(nt);
  const piv = new Int32Array(n);
  let t = 0;
  for (let k = 0; k < n; k++) {
    piv[k] = slotOf[k * n + k];
    for (let q = uptr[k]; q < uptr[k + 1]; q++) uslot[q] = slotOf[k * n + ucol[q]];
    for (let q = lptr[k]; q < lptr[k + 1]; q++) {
      const i = lrow[q];
      lslot[q] = slotOf[i * n + k];
      for (let u = uptr[k]; u < uptr[k + 1]; u++) tgt[t++] = slotOf[i * n + ucol[u]];
    }
  }
  const map = new Int32Array(nnz + 1);
  for (let s = 0; s < nnz; s++) map[s] = slotOf[rpos[rows[s]] * n + cpos[cols[s]]];
  map[nnz] = size;
  return { n, pr, pc, map, size, piv, lptr, lslot, lrow, uptr, uslot, ucol, tgt };
}

/** Pivots smaller than this are treated as zero (the order is then rebuilt from the values). */
const TINY = 1e-300;

export class RealLU {
  /** factor values, loaded by the caller (trash slot last) */
  readonly a: Float64Array;
  private readonly inv: Float64Array;
  private readonly y: Float64Array;
  constructor(readonly plan: Plan) {
    this.a = new Float64Array(plan.size + 1);
    this.inv = new Float64Array(plan.n);
    this.y = new Float64Array(plan.n);
  }

  /** Scatter original-slot values `m` (length nnz + 1) into the factor array. */
  load(m: Float64Array) {
    const { a } = this;
    const { map } = this.plan;
    a.fill(0);
    const nnz = map.length - 1;
    for (let s = 0; s < nnz; s++) a[map[s]] = m[s];
  }

  /** Factor `a` in place; false on a zero or non-finite pivot. */
  factor(): boolean {
    const { a, inv } = this;
    const { n, piv, lptr, lslot, uptr, uslot, tgt } = this.plan;
    let t = 0;
    for (let k = 0; k < n; k++) {
      const p = a[piv[k]];
      if (!(Math.abs(p) > TINY) || p === Infinity || p === -Infinity) return false;
      const ip = 1 / p;
      inv[k] = ip;
      const u0 = uptr[k];
      const u1 = uptr[k + 1];
      const l1 = lptr[k + 1];
      for (let q = lptr[k]; q < l1; q++) {
        const ls = lslot[q];
        const l = a[ls] * ip;
        a[ls] = l;
        if (l === 0) {
          t += u1 - u0;
          continue;
        }
        for (let u = u0; u < u1; u++) a[tgt[t++]] -= l * a[uslot[u]];
      }
    }
    return true;
  }

  /** Solve with the last factorisation: `b` by original row, `x` by original column (both at least n long). */
  solve(b: Float64Array, x: Float64Array) {
    const { a, inv, y } = this;
    const { n, pr, pc, lptr, lslot, lrow, uptr, uslot, ucol } = this.plan;
    for (let k = 0; k < n; k++) y[k] = b[pr[k]];
    for (let k = 0; k < n; k++) {
      const yk = y[k];
      if (yk === 0) continue;
      const l1 = lptr[k + 1];
      for (let q = lptr[k]; q < l1; q++) y[lrow[q]] -= a[lslot[q]] * yk;
    }
    for (let k = n - 1; k >= 0; k--) {
      let s = y[k];
      const u1 = uptr[k + 1];
      for (let q = uptr[k]; q < u1; q++) s -= a[uslot[q]] * y[ucol[q]];
      y[k] = s * inv[k];
    }
    for (let k = 0; k < n; k++) x[pc[k]] = y[k];
  }
}

export class ComplexLU {
  readonly ar: Float64Array;
  readonly ai: Float64Array;
  private readonly invr: Float64Array;
  private readonly invi: Float64Array;
  private readonly yr: Float64Array;
  private readonly yi: Float64Array;
  constructor(readonly plan: Plan) {
    this.ar = new Float64Array(plan.size + 1);
    this.ai = new Float64Array(plan.size + 1);
    this.invr = new Float64Array(plan.n);
    this.invi = new Float64Array(plan.n);
    this.yr = new Float64Array(plan.n);
    this.yi = new Float64Array(plan.n);
  }

  /** Load re + j·w·im from original-slot arrays. */
  load(re: Float64Array, im: Float64Array, w: number) {
    const { ar, ai } = this;
    const { map } = this.plan;
    ar.fill(0);
    ai.fill(0);
    const nnz = map.length - 1;
    for (let s = 0; s < nnz; s++) {
      ar[map[s]] = re[s];
      ai[map[s]] = w * im[s];
    }
  }

  factor(): boolean {
    const { ar, ai, invr, invi } = this;
    const { n, piv, lptr, lslot, uptr, uslot, tgt } = this.plan;
    let t = 0;
    for (let k = 0; k < n; k++) {
      const pre = ar[piv[k]];
      const pim = ai[piv[k]];
      const d = pre * pre + pim * pim;
      if (!(d > TINY) || d === Infinity) return false;
      const ir = pre / d;
      const ii = -pim / d;
      invr[k] = ir;
      invi[k] = ii;
      const u0 = uptr[k];
      const u1 = uptr[k + 1];
      for (let q = lptr[k]; q < lptr[k + 1]; q++) {
        const ls = lslot[q];
        const lr = ar[ls] * ir - ai[ls] * ii;
        const li = ar[ls] * ii + ai[ls] * ir;
        ar[ls] = lr;
        ai[ls] = li;
        for (let u = u0; u < u1; u++) {
          const us = uslot[u];
          const ts = tgt[t++];
          ar[ts] -= lr * ar[us] - li * ai[us];
          ai[ts] -= lr * ai[us] + li * ar[us];
        }
      }
    }
    return true;
  }

  solve(br: Float64Array, bi: Float64Array, xr: Float64Array, xi: Float64Array) {
    const { ar, ai, invr, invi, yr, yi } = this;
    const { n, pr, pc, lptr, lslot, lrow, uptr, uslot, ucol } = this.plan;
    for (let k = 0; k < n; k++) {
      yr[k] = br[pr[k]];
      yi[k] = bi[pr[k]];
    }
    for (let k = 0; k < n; k++) {
      const vr = yr[k];
      const vi = yi[k];
      if (vr === 0 && vi === 0) continue;
      for (let q = lptr[k]; q < lptr[k + 1]; q++) {
        const s = lslot[q];
        const r = lrow[q];
        yr[r] -= ar[s] * vr - ai[s] * vi;
        yi[r] -= ar[s] * vi + ai[s] * vr;
      }
    }
    for (let k = n - 1; k >= 0; k--) {
      let sr = yr[k];
      let si = yi[k];
      for (let q = uptr[k]; q < uptr[k + 1]; q++) {
        const s = uslot[q];
        const j = ucol[q];
        sr -= ar[s] * yr[j] - ai[s] * yi[j];
        si -= ar[s] * yi[j] + ai[s] * yr[j];
      }
      yr[k] = sr * invr[k] - si * invi[k];
      yi[k] = sr * invi[k] + si * invr[k];
    }
    for (let k = 0; k < n; k++) {
      xr[pc[k]] = yr[k];
      xi[pc[k]] = yi[k];
    }
  }
}
