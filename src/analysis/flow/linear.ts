// Linear systems on a box of cells, as the flow and heat solvers make them: every cell couples to its six face
// neighbours (a 7-point stencil), aP·x_P = Σ a_nb·x_nb + b with every coefficient ≥ 0. Solved with additive
// correction multigrid (Hutchinson and Raithby 1986: cells grouped together share one correction, so the coarse
// equations are sums of the fine ones), used as the preconditioner of conjugate gradients for the symmetric pressure
// correction and of BiCGSTAB for the heat equation, whose flow terms make it unsymmetric.
//
// The groups are the cells of a 2×2×2 block (then blocks of those, and so on) that are joined to each other strongly:
// a wall through a block, or copper next to air, splits it, so a correction never jumps a wall or smears across
// materials whose conductivities are thousands of times apart. Plain blocks would tie the air either side of a thin
// fin together and leave conjugate gradients to find those modes one at a time.
//
// Cells that are not unknowns (a solid in the pressure equation, the still air round the outside) are inactive:
// their x stays at zero and nothing couples to them; a fixed value next to an unknown is folded into its b.

export interface Stencil {
  nx: number;
  ny: number;
  nz: number;
  aP: Float64Array;
  aW: Float64Array;
  aE: Float64Array;
  aS: Float64Array;
  aN: Float64Array;
  aB: Float64Array;
  aT: Float64Array;
  /** 1 where the cell is an unknown */
  active: Uint8Array;
}

export function newStencil(nx: number, ny: number, nz: number): Stencil {
  const n = nx * ny * nz;
  return { nx, ny, nz, aP: new Float64Array(n), aW: new Float64Array(n), aE: new Float64Array(n), aS: new Float64Array(n), aN: new Float64Array(n), aB: new Float64Array(n), aT: new Float64Array(n), active: new Uint8Array(n) };
}

/** y = A·x (inactive rows give 0). */
export function apply(A: Stencil, x: Float64Array, y: Float64Array) {
  const { nx, ny, nz, aP, aW, aE, aS, aN, aB, aT, active } = A;
  const sxy = nx * ny;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      let c = nx * (j + ny * k);
      for (let i = 0; i < nx; i++, c++) {
        if (!active[c]) {
          y[c] = 0;
          continue;
        }
        let s = aP[c] * x[c];
        if (i > 0) s -= aW[c] * x[c - 1];
        if (i < nx - 1) s -= aE[c] * x[c + 1];
        if (j > 0) s -= aS[c] * x[c - nx];
        if (j < ny - 1) s -= aN[c] * x[c + nx];
        if (k > 0) s -= aB[c] * x[c - sxy];
        if (k < nz - 1) s -= aT[c] * x[c + sxy];
        y[c] = s;
      }
    }
}

/** One Gauss–Seidel sweep, forwards or backwards. */
function sweep(A: Stencil, b: Float64Array, x: Float64Array, backwards: boolean) {
  const { nx, ny, nz, aP, aW, aE, aS, aN, aB, aT, active } = A;
  const sxy = nx * ny;
  const step = backwards ? -1 : 1;
  const k0 = backwards ? nz - 1 : 0;
  const j0 = backwards ? ny - 1 : 0;
  const i0 = backwards ? nx - 1 : 0;
  for (let k = k0; k >= 0 && k < nz; k += step) {
    const hasB = k > 0;
    const hasT = k < nz - 1;
    for (let j = j0; j >= 0 && j < ny; j += step) {
      const hasS = j > 0;
      const hasN = j < ny - 1;
      const row = nx * (j + ny * k);
      for (let i = i0; i >= 0 && i < nx; i += step) {
        const c = row + i;
        if (!active[c]) continue;
        let s = b[c];
        if (i > 0) s += aW[c] * x[c - 1];
        if (i < nx - 1) s += aE[c] * x[c + 1];
        if (hasS) s += aS[c] * x[c - nx];
        if (hasN) s += aN[c] * x[c + nx];
        if (hasB) s += aB[c] * x[c - sxy];
        if (hasT) s += aT[c] * x[c + sxy];
        x[c] = s / aP[c];
      }
    }
  }
}

/** tuning: how strong a coupling must be (against the strongest in its row) to group across it, the coarse
 * correction's over-relaxation (piecewise-constant corrections come out too small for smooth errors), and the sweeps */
export const MG_TUNING = { theta: 0.08, overcorrect: 1.8, pre: 2, post: 2 };

/** the coarse levels' matrices: aP·x = Σ val·x_col + b, row by row */
interface Csr {
  n: number;
  diag: Float64Array;
  /** 1/diag, 0 where diag is not positive */
  inv: Float64Array;
  ptr: Int32Array;
  col: Int32Array;
  val: Float64Array;
}

interface Level {
  n: number;
  /** the finest level's stencil, or a coarse level's rows */
  A: Stencil | null;
  C: Csr | null;
  b: Float64Array;
  x: Float64Array;
  r: Float64Array;
  /** each unknown's group on the next level down (−1 for a cell that is not an unknown) */
  map: Int32Array | null;
  /** where each coupling of this level goes on the next one: an entry there, −1 inside a group, −2 none */
  slot: Int32Array | null;
  /** each unknown's block coordinates (its cells' i, j, k halved once per level) */
  bi: Int32Array;
  bj: Int32Array;
  bk: Int32Array;
}

/** the coarsest level is solved exactly (dense LU) when it is this small; past it, by many sweeps */
const DENSE_MAX = 200;

/** A multigrid hierarchy for one matrix, built from its coefficients as they are (call rebuild() when they change a lot). */
export class Multigrid {
  levels: Level[] = [];
  private lu: DenseLU | null = null;
  private readonly A: Stencil;

  constructor(A: Stencil) {
    this.A = A;
    this.rebuild();
  }

  /** Group the cells again from the coefficients now. */
  rebuild() {
    const A = this.A;
    const { nx, ny, nz } = A;
    const n = nx * ny * nz;
    const bi = new Int32Array(n);
    const bj = new Int32Array(n);
    const bk = new Int32Array(n);
    for (let k = 0, c = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++, c++) {
          bi[c] = i;
          bj[c] = j;
          bk[c] = k;
        }
    this.levels = [{ n, A, C: null, b: new Float64Array(n), x: new Float64Array(n), r: new Float64Array(n), map: null, slot: null, bi, bj, bk }];
    this.lu = null;
    for (;;) {
      const L = this.levels[this.levels.length - 1];
      const unknowns = L.A ? countActive(L.A) : L.n;
      if (unknowns <= 128) break;
      const g = L.A ? groupStencil(L.A, L.bi, L.bj, L.bk) : groupCsr(L.C!, L.bi, L.bj, L.bk);
      // groups that no longer shrink (everything left is cut apart): stop here
      if (g.count > 0.8 * unknowns) break;
      const { C, slot } = L.A ? galerkinStencil(L.A, g.map, g.count) : galerkinCsr(L.C!, g.map, g.count);
      L.map = g.map;
      L.slot = slot;
      // the coefficients now, so the next level's groups can be chosen from them
      if (L.A) fillFromStencil(L.A, g.map, slot, C);
      else fillFromCsr(L.C!, g.map, slot, C);
      this.levels.push({ n: g.count, A: null, C, b: new Float64Array(g.count), x: new Float64Array(g.count), r: new Float64Array(g.count), map: null, slot: null, bi: g.bi, bj: g.bj, bk: g.bk });
    }
    this.update();
  }

  /** Redo the coarse equations after the fine matrix's coefficients changed (the same cells active, the same groups). */
  update() {
    const L = this.levels;
    for (let l = 1; l < L.length; l++) {
      const f = L[l - 1];
      if (f.A) fillFromStencil(f.A, f.map!, f.slot!, L[l].C!);
      else fillFromCsr(f.C!, f.map!, f.slot!, L[l].C!);
    }
    const last = L[L.length - 1];
    if (last.C && last.n <= DENSE_MAX) {
      if (!this.lu) this.lu = new DenseLU(last.n);
      this.lu.factor(last.C);
    }
  }

  /** z ≈ A⁻¹·r: one V-cycle from zero (forward sweeps going down, backward coming up, so it is symmetric for a symmetric A). */
  precondition(r: Float64Array, z: Float64Array) {
    const L = this.levels;
    L[0].b.set(r);
    L[0].x.fill(0);
    this.vcycle(0);
    z.set(L[0].x);
  }

  private vcycle(l: number) {
    const L = this.levels[l];
    const last = l === this.levels.length - 1;
    if (last) {
      if (L.C && this.lu) this.lu.solve(L.b, L.x);
      else
        for (let s = 0; s < 20; s++) {
          smooth(L, false);
          smooth(L, true);
        }
      return;
    }
    for (let s = 0; s < MG_TUNING.pre; s++) smooth(L, false);
    if (L.A) {
      apply(L.A, L.x, L.r);
      for (let c = 0; c < L.n; c++) L.r[c] = L.b[c] - L.r[c];
    } else csrResidual(L.C!, L.b, L.x, L.r);
    const C = this.levels[l + 1];
    const map = L.map!;
    C.b.fill(0);
    for (let c = 0; c < L.n; c++) if (map[c] >= 0) C.b[map[c]] += L.r[c];
    C.x.fill(0);
    this.vcycle(l + 1);
    const w = MG_TUNING.overcorrect;
    for (let c = 0; c < L.n; c++) if (map[c] >= 0) L.x[c] += w * C.x[map[c]];
    for (let s = 0; s < MG_TUNING.post; s++) smooth(L, true);
  }
}

function smooth(L: Level, backwards: boolean) {
  if (L.A) sweep(L.A, L.b, L.x, backwards);
  else csrSweep(L.C!, L.b, L.x, backwards);
}

function countActive(A: Stencil): number {
  let n = 0;
  for (let c = 0; c < A.active.length; c++) n += A.active[c];
  return n;
}

function csrSweep(C: Csr, b: Float64Array, x: Float64Array, backwards: boolean) {
  const { n, inv, ptr, col, val } = C;
  if (!backwards)
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let e = ptr[i]; e < ptr[i + 1]; e++) s += val[e] * x[col[e]];
      x[i] = s * inv[i];
    }
  else
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let e = ptr[i]; e < ptr[i + 1]; e++) s += val[e] * x[col[e]];
      x[i] = s * inv[i];
    }
}

function csrResidual(C: Csr, b: Float64Array, x: Float64Array, r: Float64Array) {
  const { n, diag, ptr, col, val } = C;
  for (let i = 0; i < n; i++) {
    let s = b[i] - diag[i] * x[i];
    for (let e = ptr[i]; e < ptr[i + 1]; e++) s += val[e] * x[col[e]];
    r[i] = s;
  }
}

/** union–find with path halving */
function find(parent: Int32Array, a: number): number {
  while (parent[a] !== a) {
    parent[a] = parent[parent[a]];
    a = parent[a];
  }
  return a;
}

function union(parent: Int32Array, a: number, b: number) {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
}

/** Number the groups by their first member (so they keep the cells' order), with their block coordinates halved. */
function numberGroups(parent: Int32Array, isUnknown: (c: number) => boolean, bi: Int32Array, bj: Int32Array, bk: Int32Array) {
  const n = parent.length;
  const map = new Int32Array(n).fill(-1);
  const id = new Int32Array(n).fill(-1);
  let count = 0;
  for (let c = 0; c < n; c++) {
    if (!isUnknown(c)) continue;
    const r = find(parent, c);
    if (id[r] < 0) id[r] = count++;
    map[c] = id[r];
  }
  const gi = new Int32Array(count);
  const gj = new Int32Array(count);
  const gk = new Int32Array(count);
  for (let c = 0; c < n; c++)
    if (map[c] >= 0) {
      gi[map[c]] = bi[c] >> 1;
      gj[map[c]] = bj[c] >> 1;
      gk[map[c]] = bk[c] >> 1;
    }
  return { map, count, bi: gi, bj: gj, bk: gk };
}

/** The finest level's groups: active cells in the same 2×2×2 block joined by a strong coupling. */
function groupStencil(A: Stencil, bi: Int32Array, bj: Int32Array, bk: Int32Array) {
  const { nx, ny, nz, aW, aE, aS, aN, aB, aT, active } = A;
  const n = nx * ny * nz;
  const sxy = nx * ny;
  const th = MG_TUNING.theta;
  const parent = new Int32Array(n);
  for (let c = 0; c < n; c++) parent[c] = c;
  const strongest = new Float64Array(n);
  for (let k = 0, c = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, c++) {
        if (!active[c]) continue;
        let m = 0;
        if (i > 0 && active[c - 1]) m = Math.max(m, aW[c]);
        if (i < nx - 1 && active[c + 1]) m = Math.max(m, aE[c]);
        if (j > 0 && active[c - nx]) m = Math.max(m, aS[c]);
        if (j < ny - 1 && active[c + nx]) m = Math.max(m, aN[c]);
        if (k > 0 && active[c - sxy]) m = Math.max(m, aB[c]);
        if (k < nz - 1 && active[c + sxy]) m = Math.max(m, aT[c]);
        strongest[c] = m;
      }
  const strong = (c: number, a: number, d: number, back: number) => (a > 0 && a >= th * strongest[c]) || (back > 0 && back >= th * strongest[d]);
  for (let k = 0, c = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, c++) {
        if (!active[c]) continue;
        // only the +x, +y, +z neighbours inside the same block
        if (!(i & 1) && i < nx - 1 && active[c + 1] && strong(c, aE[c], c + 1, aW[c + 1])) union(parent, c, c + 1);
        if (!(j & 1) && j < ny - 1 && active[c + nx] && strong(c, aN[c], c + nx, aS[c + nx])) union(parent, c, c + nx);
        if (!(k & 1) && k < nz - 1 && active[c + sxy] && strong(c, aT[c], c + sxy, aB[c + sxy])) union(parent, c, c + sxy);
      }
  return numberGroups(parent, (c) => active[c] === 1, bi, bj, bk);
}

/** A coarse level's groups: unknowns in the same block of the next size up, joined by a strong coupling. */
function groupCsr(C: Csr, bi: Int32Array, bj: Int32Array, bk: Int32Array) {
  const { n, ptr, col, val } = C;
  const th = MG_TUNING.theta;
  const parent = new Int32Array(n);
  for (let c = 0; c < n; c++) parent[c] = c;
  for (let r = 0; r < n; r++) {
    let m = 0;
    for (let e = ptr[r]; e < ptr[r + 1]; e++) m = Math.max(m, val[e]);
    for (let e = ptr[r]; e < ptr[r + 1]; e++) {
      const q = col[e];
      if (q <= r && find(parent, q) === find(parent, r)) continue;
      if (val[e] > 0 && val[e] >= th * m && bi[q] >> 1 === bi[r] >> 1 && bj[q] >> 1 === bj[r] >> 1 && bk[q] >> 1 === bk[r] >> 1) union(parent, r, q);
    }
  }
  return numberGroups(parent, () => true, bi, bj, bk);
}

/** Rows of the coarse matrix for groups of the stencil's cells, and where each fine coupling lands in them. */
function galerkinStencil(A: Stencil, map: Int32Array, count: number): { C: Csr; slot: Int32Array } {
  const { nx, ny, nz, active } = A;
  const n = nx * ny * nz;
  const sxy = nx * ny;
  const slot = new Int32Array(6 * n).fill(-2);
  // each group's cells, in order
  const start = new Int32Array(count + 1);
  for (let c = 0; c < n; c++) if (map[c] >= 0) start[map[c] + 1]++;
  for (let g = 0; g < count; g++) start[g + 1] += start[g];
  const cells = new Int32Array(start[count]);
  const fill = start.slice(0, count);
  for (let c = 0; c < n; c++) if (map[c] >= 0) cells[fill[map[c]]++] = c;
  const ptr = new Int32Array(count + 1);
  const cols: number[] = [];
  const pos = new Int32Array(count).fill(-1);
  for (let g = 0; g < count; g++) {
    const rowStart = cols.length;
    for (let q = start[g]; q < start[g + 1]; q++) {
      const c = cells[q];
      const i = c % nx;
      const j = ((c - i) / nx) % ny;
      const k = (c - i - nx * j) / sxy;
      for (let d = 0; d < 6; d++) {
        // W, E, S, N, B, T
        const m =
          d === 0 ? (i > 0 ? c - 1 : -1) : d === 1 ? (i < nx - 1 ? c + 1 : -1) : d === 2 ? (j > 0 ? c - nx : -1) : d === 3 ? (j < ny - 1 ? c + nx : -1) : d === 4 ? (k > 0 ? c - sxy : -1) : k < nz - 1 ? c + sxy : -1;
        if (m < 0 || !active[m]) continue;
        const h = map[m];
        if (h === g) {
          slot[6 * c + d] = -1;
          continue;
        }
        if (pos[h] < 0) {
          pos[h] = cols.length;
          cols.push(h);
        }
        slot[6 * c + d] = pos[h];
      }
    }
    for (let e = rowStart; e < cols.length; e++) pos[cols[e]] = -1;
    ptr[g + 1] = cols.length;
  }
  const nnz = cols.length;
  return { C: { n: count, diag: new Float64Array(count), inv: new Float64Array(count), ptr, col: Int32Array.from(cols), val: new Float64Array(nnz) }, slot };
}

/** The same for a coarse level's rows grouped again. */
function galerkinCsr(F: Csr, map: Int32Array, count: number): { C: Csr; slot: Int32Array } {
  const { n, ptr: fptr, col: fcol } = F;
  const slot = new Int32Array(fptr[n]).fill(-2);
  const start = new Int32Array(count + 1);
  for (let c = 0; c < n; c++) start[map[c] + 1]++;
  for (let g = 0; g < count; g++) start[g + 1] += start[g];
  const rows = new Int32Array(n);
  const fill = start.slice(0, count);
  for (let c = 0; c < n; c++) rows[fill[map[c]]++] = c;
  const ptr = new Int32Array(count + 1);
  const cols: number[] = [];
  const pos = new Int32Array(count).fill(-1);
  for (let g = 0; g < count; g++) {
    const rowStart = cols.length;
    for (let q = start[g]; q < start[g + 1]; q++) {
      const r = rows[q];
      for (let e = fptr[r]; e < fptr[r + 1]; e++) {
        const h = map[fcol[e]];
        if (h === g) {
          slot[e] = -1;
          continue;
        }
        if (pos[h] < 0) {
          pos[h] = cols.length;
          cols.push(h);
        }
        slot[e] = pos[h];
      }
    }
    for (let e = rowStart; e < cols.length; e++) pos[cols[e]] = -1;
    ptr[g + 1] = cols.length;
  }
  return { C: { n: count, diag: new Float64Array(count), inv: new Float64Array(count), ptr, col: Int32Array.from(cols), val: new Float64Array(cols.length) }, slot };
}

function finish(C: Csr) {
  for (let g = 0; g < C.n; g++) C.inv[g] = C.diag[g] > 0 ? 1 / C.diag[g] : 0;
}

/** The coarse coefficients from the stencil's, through the slots: a coupling inside a group cancels from its diagonal. */
function fillFromStencil(A: Stencil, map: Int32Array, slot: Int32Array, C: Csr) {
  const { aP, active } = A;
  const arr = [A.aW, A.aE, A.aS, A.aN, A.aB, A.aT];
  const { diag, val } = C;
  diag.fill(0);
  val.fill(0);
  const n = active.length;
  for (let c = 0; c < n; c++) {
    if (!active[c]) continue;
    const g = map[c];
    diag[g] += aP[c];
    for (let d = 0; d < 6; d++) {
      const s = slot[6 * c + d];
      if (s === -2) continue;
      const a = arr[d][c];
      if (s === -1) diag[g] -= a;
      else val[s] += a;
    }
  }
  finish(C);
}

function fillFromCsr(F: Csr, map: Int32Array, slot: Int32Array, C: Csr) {
  const { diag, val } = C;
  diag.fill(0);
  val.fill(0);
  for (let r = 0; r < F.n; r++) {
    const g = map[r];
    diag[g] += F.diag[r];
    for (let e = F.ptr[r]; e < F.ptr[r + 1]; e++) {
      const s = slot[e];
      if (s === -1) diag[g] -= F.val[e];
      else if (s >= 0) val[s] += F.val[e];
    }
  }
  finish(C);
}

/** The coarsest rows as a dense matrix, factored with partial pivoting. */
class DenseLU {
  private n: number;
  private m: Float64Array;
  private piv: Int32Array;
  private y: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.m = new Float64Array(n * n);
    this.piv = new Int32Array(n);
    this.y = new Float64Array(n);
  }

  factor(C: Csr) {
    const { n, m, piv } = this;
    m.fill(0);
    for (let r = 0; r < n; r++) {
      m[r * n + r] = C.diag[r] > 0 ? C.diag[r] : 1;
      for (let e = C.ptr[r]; e < C.ptr[r + 1]; e++) m[r * n + C.col[e]] -= C.val[e];
    }
    for (let c = 0; c < n; c++) {
      let p = c;
      let best = Math.abs(m[c * n + c]);
      for (let r = c + 1; r < n; r++) {
        const v = Math.abs(m[r * n + c]);
        if (v > best) {
          best = v;
          p = r;
        }
      }
      piv[c] = p;
      if (p !== c)
        for (let q = 0; q < n; q++) {
          const t = m[c * n + q];
          m[c * n + q] = m[p * n + q];
          m[p * n + q] = t;
        }
      const d = m[c * n + c];
      if (d === 0) continue;
      for (let r = c + 1; r < n; r++) {
        const f = m[r * n + c] / d;
        if (f === 0) continue;
        m[r * n + c] = f;
        for (let q = c + 1; q < n; q++) m[r * n + q] -= f * m[c * n + q];
      }
    }
  }

  solve(b: Float64Array, x: Float64Array) {
    const { n, m, piv, y } = this;
    y.set(b);
    for (let c = 0; c < n; c++) {
      const p = piv[c];
      if (p !== c) {
        const t = y[c];
        y[c] = y[p];
        y[p] = t;
      }
      for (let r = c + 1; r < n; r++) y[r] -= m[r * n + c] * y[c];
    }
    for (let c = n - 1; c >= 0; c--) {
      let s = y[c];
      for (let q = c + 1; q < n; q++) s -= m[c * n + q] * x[q];
      const d = m[c * n + c];
      x[c] = d !== 0 ? s / d : 0;
    }
  }
}

const dotA = (a: Float64Array, b: Float64Array, active: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) if (active[i]) s += a[i] * b[i];
  return s;
};

export interface SolveStats {
  iterations: number;
  /** final residual over the first one */
  reduction: number;
}

/** Conjugate gradients with the multigrid preconditioner, for a symmetric A, from the x given. */
export function pcg(A: Stencil, b: Float64Array, x: Float64Array, opts: { tol: number; maxIter: number; mg?: Multigrid }): SolveStats {
  const n = b.length;
  const mg = opts.mg ?? new Multigrid(A);
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  apply(A, x, r);
  for (let c = 0; c < n; c++) r[c] = A.active[c] ? b[c] - r[c] : 0;
  const r0 = Math.sqrt(dotA(r, r, A.active));
  if (r0 === 0) return { iterations: 0, reduction: 0 };
  mg.precondition(r, z);
  p.set(z);
  let rz = dotA(r, z, A.active);
  let it = 0;
  let rn = r0;
  for (; it < opts.maxIter; it++) {
    apply(A, p, q);
    const pq = dotA(p, q, A.active);
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    for (let c = 0; c < n; c++) {
      x[c] += alpha * p[c];
      r[c] -= alpha * q[c];
    }
    rn = Math.sqrt(dotA(r, r, A.active));
    if (rn <= opts.tol * r0) {
      it++;
      break;
    }
    mg.precondition(r, z);
    const rz1 = dotA(r, z, A.active);
    const beta = rz1 / rz;
    rz = rz1;
    for (let c = 0; c < n; c++) p[c] = z[c] + beta * p[c];
  }
  return { iterations: it, reduction: rn / r0 };
}

/** BiCGSTAB with the multigrid preconditioner (right-preconditioned), for an unsymmetric A, from the x given. */
export function bicgstab(A: Stencil, b: Float64Array, x: Float64Array, opts: { tol: number; maxIter: number; mg?: Multigrid }): SolveStats {
  const n = b.length;
  const mg = opts.mg ?? new Multigrid(A);
  const act = A.active;
  const r = new Float64Array(n);
  const rh = new Float64Array(n);
  const p = new Float64Array(n);
  const v = new Float64Array(n);
  const s = new Float64Array(n);
  const t = new Float64Array(n);
  const ph = new Float64Array(n);
  const sh = new Float64Array(n);
  apply(A, x, r);
  for (let c = 0; c < n; c++) r[c] = act[c] ? b[c] - r[c] : 0;
  const r0 = Math.sqrt(dotA(r, r, act));
  if (r0 === 0) return { iterations: 0, reduction: 0 };
  rh.set(r);
  let rho = 1;
  let alpha = 1;
  let omega = 1;
  let rn = r0;
  let it = 0;
  for (; it < opts.maxIter; it++) {
    const rho1 = dotA(rh, r, act);
    if (rho1 === 0) break;
    const beta = (rho1 / rho) * (alpha / omega);
    rho = rho1;
    for (let c = 0; c < n; c++) p[c] = r[c] + beta * (p[c] - omega * v[c]);
    mg.precondition(p, ph);
    apply(A, ph, v);
    const rv = dotA(rh, v, act);
    if (rv === 0) break;
    alpha = rho / rv;
    for (let c = 0; c < n; c++) s[c] = r[c] - alpha * v[c];
    const sn = Math.sqrt(dotA(s, s, act));
    if (sn <= opts.tol * r0) {
      for (let c = 0; c < n; c++) x[c] += alpha * ph[c];
      rn = sn;
      it++;
      break;
    }
    mg.precondition(s, sh);
    apply(A, sh, t);
    const tt = dotA(t, t, act);
    omega = tt > 0 ? dotA(t, s, act) / tt : 0;
    for (let c = 0; c < n; c++) {
      x[c] += alpha * ph[c] + omega * sh[c];
      r[c] = s[c] - omega * t[c];
    }
    rn = Math.sqrt(dotA(r, r, act));
    if (rn <= opts.tol * r0 || omega === 0) {
      it++;
      break;
    }
  }
  return { iterations: it, reduction: rn / r0 };
}
