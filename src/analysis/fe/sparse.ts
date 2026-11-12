// Sparse symmetric positive definite systems in small dense blocks, one block per mesh node, solved by a
// left-looking block Cholesky in nested-dissection order. Made for shell models: a surface mesh of a few
// thousand nodes with six freedoms each factors in about a second, where a banded solver needs minutes and
// gigabytes, and an iterative one crawls on the stiff-in-plane, soft-in-bending equations of a thin wall.
//
// The order splits the nodes in halves by planes across their longest extent and numbers each half before
// the nodes that separate them, so eliminating one half never fills in the other. The symbolic pass finds
// every block the factor will hold (the elimination tree's column structures); the numeric pass then works
// column by column, subtracting the earlier columns that reach it, each update a dense block product.

const LEAF = 48;

/** Nested-dissection order of a mesh's nodes from their positions and links: order[k] is the node numbered k. */
export function dissect(pos: ArrayLike<number>, n: number, ptr: Int32Array, idx: Int32Array): Int32Array {
  const out: number[] = [];
  const mark = new Int32Array(n).fill(-1);
  let stamp = 0;
  const rec = (nodes: number[]) => {
    if (nodes.length <= LEAF) {
      for (const v of nodes) out.push(v);
      return;
    }
    let lo0 = Infinity,
      lo1 = Infinity,
      lo2 = Infinity,
      hi0 = -Infinity,
      hi1 = -Infinity,
      hi2 = -Infinity;
    for (const v of nodes) {
      const x = pos[3 * v],
        y = pos[3 * v + 1],
        z = pos[3 * v + 2];
      if (x < lo0) lo0 = x;
      if (x > hi0) hi0 = x;
      if (y < lo1) lo1 = y;
      if (y > hi1) hi1 = y;
      if (z < lo2) lo2 = z;
      if (z > hi2) hi2 = z;
    }
    const ext = [hi0 - lo0, hi1 - lo1, hi2 - lo2];
    const ax = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const sorted = nodes.slice().sort((a, b) => pos[3 * a + ax] - pos[3 * b + ax]);
    const half = sorted.length >> 1;
    const left = stamp++,
      right = stamp++;
    for (let i = 0; i < sorted.length; i++) mark[sorted[i]] = i < half ? left : right;
    // the nodes of one half that touch the other separate them: take the side with fewer such nodes
    const sepL: number[] = [],
      sepR: number[] = [];
    for (const v of sorted) {
      const own = mark[v],
        other = own === left ? right : left;
      for (let p = ptr[v]; p < ptr[v + 1]; p++)
        if (mark[idx[p]] === other) {
          (own === left ? sepL : sepR).push(v);
          break;
        }
    }
    const sepIsLeft = sepL.length <= sepR.length;
    const sep = sepIsLeft ? sepL : sepR;
    const sepMark = stamp++;
    for (const v of sep) mark[v] = sepMark;
    const a: number[] = [],
      b: number[] = [];
    for (const v of sorted) {
      if (mark[v] === left) a.push(v);
      else if (mark[v] === right) b.push(v);
    }
    // a split that separates nothing (every node touches the other half): stop dividing here
    if (!a.length || !b.length) {
      for (const v of nodes) out.push(v);
      return;
    }
    rec(a);
    rec(b);
    for (const v of sep) out.push(v);
  };
  const all: number[] = [];
  for (let v = 0; v < n; v++) all.push(v);
  rec(all);
  return Int32Array.from(out);
}

/** The links of a mesh's nodes in compressed rows (each node's neighbours, without itself). */
export function nodeLinks(n: number, elements: ArrayLike<number>[], extra: [number, number][] = []): { ptr: Int32Array; idx: Int32Array } {
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (const e of elements)
    for (let a = 0; a < e.length; a++)
      for (let b = 0; b < e.length; b++) if (a !== b && e[a] !== e[b]) sets[e[a]].add(e[b]);
  for (const [a, b] of extra)
    if (a !== b) {
      sets[a].add(b);
      sets[b].add(a);
    }
  const ptr = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) ptr[v + 1] = ptr[v] + sets[v].size;
  const idx = new Int32Array(ptr[n]);
  for (let v = 0; v < n; v++) {
    let p = ptr[v];
    for (const w of [...sets[v]].sort((x, y) => x - y)) idx[p++] = w;
  }
  return { ptr, idx };
}

/**
 * The structure of a node-blocked SPD system: its fill-reducing order, the blocks of its lower triangle, and the
 * blocks its Cholesky factor fills. Matrices made from it share the structure; factor() solves them.
 */
export class BlockSystem {
  readonly BB: number;
  /** order[k]: the node numbered k; inv[node]: its number */
  readonly order: Int32Array;
  readonly inv: Int32Array;
  /** the matrix's own lower blocks per column (in the new numbering), diagonal first */
  readonly aPtr: Int32Array;
  readonly aRow: Int32Array;
  /** the factor's lower blocks per column, diagonal first */
  readonly lPtr: Int32Array;
  readonly lRow: Int32Array;

  constructor(
    readonly n: number,
    readonly B: number,
    pos: ArrayLike<number>,
    ptr: Int32Array,
    idx: Int32Array,
  ) {
    this.BB = B * B;
    this.order = dissect(pos, n, ptr, idx);
    this.inv = new Int32Array(n);
    for (let k = 0; k < n; k++) this.inv[this.order[k]] = k;
    const inv = this.inv,
      order = this.order;
    // lower structure of the matrix, renumbered
    const aCols: Int32Array[] = [];
    for (let j = 0; j < n; j++) {
      const v = order[j];
      const rows = [j];
      for (let p = ptr[v]; p < ptr[v + 1]; p++) {
        const i = inv[idx[p]];
        if (i > j) rows.push(i);
      }
      rows.sort((x, y) => x - y);
      aCols.push(Int32Array.from(rows));
    }
    this.aPtr = new Int32Array(n + 1);
    for (let j = 0; j < n; j++) this.aPtr[j + 1] = this.aPtr[j] + aCols[j].length;
    this.aRow = new Int32Array(this.aPtr[n]);
    for (let j = 0; j < n; j++) this.aRow.set(aCols[j], this.aPtr[j]);
    // elimination tree (Liu), from each row's links to earlier columns
    const parent = new Int32Array(n).fill(-1);
    const ancestor = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) {
      const v = order[k];
      for (let p = ptr[v]; p < ptr[v + 1]; p++) {
        let i = inv[idx[p]];
        while (i !== -1 && i < k) {
          const next = ancestor[i];
          ancestor[i] = k;
          if (next === -1) parent[i] = k;
          i = next;
        }
      }
    }
    // each factor column: the matrix's column and its children's columns below their own row
    const childHead = new Int32Array(n).fill(-1);
    const childNext = new Int32Array(n).fill(-1);
    for (let j = n - 1; j >= 0; j--)
      if (parent[j] >= 0) {
        childNext[j] = childHead[parent[j]];
        childHead[parent[j]] = j;
      }
    const lCols: Int32Array[] = new Array(n);
    const seen = new Int32Array(n).fill(-1);
    let total = 0;
    for (let j = 0; j < n; j++) {
      const rows: number[] = [];
      seen[j] = j;
      rows.push(j);
      const a = aCols[j];
      for (let q = 1; q < a.length; q++) {
        seen[a[q]] = j;
        rows.push(a[q]);
      }
      for (let c = childHead[j]; c !== -1; c = childNext[c]) {
        const lc = lCols[c];
        for (let q = 1; q < lc.length; q++) {
          const r = lc[q];
          if (seen[r] !== j) {
            seen[r] = j;
            rows.push(r);
          }
        }
      }
      rows.sort((x, y) => x - y);
      lCols[j] = Int32Array.from(rows);
      total += rows.length;
    }
    this.lPtr = new Int32Array(n + 1);
    this.lRow = new Int32Array(total);
    for (let j = 0; j < n; j++) {
      this.lPtr[j + 1] = this.lPtr[j] + lCols[j].length;
      this.lRow.set(lCols[j], this.lPtr[j]);
    }
  }

  /** blocks the factor holds */
  get fill(): number {
    return this.lRow.length;
  }

  matrix(): BlockMatrix {
    return new BlockMatrix(this);
  }
}

const findIn = (rows: Int32Array, lo: number, hi: number, i: number): number => {
  let a = lo,
    b = hi - 1;
  while (a <= b) {
    const m = (a + b) >> 1;
    const r = rows[m];
    if (r === i) return m;
    if (r < i) a = m + 1;
    else b = m - 1;
  }
  return -1;
};

/** A symmetric matrix on a BlockSystem's structure, addressed by the mesh's own node numbers. */
export class BlockMatrix {
  readonly val: Float64Array;
  constructor(readonly sys: BlockSystem) {
    this.val = new Float64Array(sys.BB * sys.aRow.length);
  }

  /** where block (row node a, column node b) of the lower triangle lives, and whether it is stored transposed */
  private slot(a: number, b: number): { p: number; t: boolean } {
    const s = this.sys;
    let i = s.inv[a],
      j = s.inv[b];
    let t = false;
    if (i < j) {
      const x = i;
      i = j;
      j = x;
      t = true;
    }
    const p = findIn(s.aRow, s.aPtr[j], s.aPtr[j + 1], i);
    if (p < 0) throw new Error(`BlockMatrix: nodes ${a} and ${b} are not linked`);
    return { p, t };
  }

  /** Adds an element's matrix: nodes.length × B square, row-major, in the nodes' order. */
  addElement(nodes: ArrayLike<number>, ke: ArrayLike<number>) {
    const s = this.sys,
      B = s.B,
      BB = s.BB;
    const m = nodes.length,
      N = m * B;
    for (let a = 0; a < m; a++)
      for (let b = 0; b < m; b++) {
        const i = s.inv[nodes[a]],
          j = s.inv[nodes[b]];
        if (i < j || (i === j && a > b && nodes[a] === nodes[b])) continue;
        const p = findIn(s.aRow, s.aPtr[j], s.aPtr[j + 1], i);
        if (p < 0) throw new Error(`BlockMatrix: nodes ${nodes[a]} and ${nodes[b]} are not linked`);
        const o = p * BB;
        for (let r = 0; r < B; r++) {
          const row = (a * B + r) * N + b * B;
          for (let c = 0; c < B; c++) this.val[o + r * B + c] += ke[row + c];
        }
      }
  }

  /** Adds k to entry (row dof r of node a, column dof c of node b) and its mirror. */
  addEntry(a: number, r: number, b: number, c: number, k: number) {
    const B = this.sys.B;
    const { p, t } = this.slot(a, b);
    const o = p * this.sys.BB;
    if (a === b) {
      this.val[o + r * B + c] += k;
      if (r !== c) this.val[o + c * B + r] += k;
    } else if (t) this.val[o + c * B + r] += k;
    else this.val[o + r * B + c] += k;
  }

  /** y = A x, both by mesh node (x[B·node + dof]) */
  mul(x: ArrayLike<number>, y: Float64Array) {
    const s = this.sys,
      B = s.B,
      BB = s.BB;
    y.fill(0);
    for (let j = 0; j < s.n; j++) {
      const nj = s.order[j];
      for (let p = s.aPtr[j]; p < s.aPtr[j + 1]; p++) {
        const ni = s.order[s.aRow[p]];
        const o = p * BB;
        for (let r = 0; r < B; r++)
          for (let c = 0; c < B; c++) {
            const v = this.val[o + r * B + c];
            if (v === 0) continue;
            y[ni * B + r] += v * x[nj * B + c];
            if (ni !== nj) y[nj * B + c] += v * x[ni * B + r];
          }
      }
    }
  }

  /** the diagonal, by mesh node */
  diagonal(): Float64Array {
    const s = this.sys,
      B = s.B,
      BB = s.BB;
    const d = new Float64Array(s.n * B);
    for (let j = 0; j < s.n; j++) {
      const o = s.aPtr[j] * BB;
      for (let r = 0; r < B; r++) d[s.order[j] * B + r] = this.val[o + r * B + r];
    }
    return d;
  }
}

/** The Cholesky factor of a BlockMatrix, or the first freedom that has no stiffness (by mesh node: B·node + dof). */
export function factorBlocks(A: BlockMatrix): { ok: true; solve: (x: Float64Array) => void; fill: number } | { ok: false; dof: number } {
  const s = A.sys,
    B = s.B,
    BB = s.BB,
    n = s.n;
  const L = new Float64Array(BB * s.lRow.length);
  const lPtr = s.lPtr,
    lRow = s.lRow;
  // the matrix's blocks into the factor's places
  const diag0 = new Float64Array(n * B);
  for (let j = 0; j < n; j++) {
    let q = lPtr[j];
    for (let p = s.aPtr[j]; p < s.aPtr[j + 1]; p++) {
      const i = s.aRow[p];
      while (lRow[q] !== i) q++;
      L.set(A.val.subarray(p * BB, p * BB + BB), q * BB);
    }
    const o = lPtr[j] * BB;
    for (let r = 0; r < B; r++) diag0[j * B + r] = Math.abs(L[o + r * B + r]);
  }
  const link = new Int32Array(n).fill(-1);
  const nextIn = new Int32Array(n).fill(-1);
  const first = new Int32Array(n);
  const pos = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    const p0 = lPtr[j],
      p1 = lPtr[j + 1];
    for (let p = p0; p < p1; p++) pos[lRow[p]] = p;
    // subtract every earlier column that reaches row j: L(i,j) -= L(i,k) L(j,k)ᵀ
    let k = link[j];
    while (k !== -1) {
      const kn = nextIn[k];
      const pk = first[k];
      const end = lPtr[k + 1];
      const jo = pk * BB;
      for (let q = pk; q < end; q++) {
        const io = q * BB;
        const to = pos[lRow[q]] * BB;
        for (let r = 0; r < B; r++) {
          const ir = io + r * B;
          for (let c = 0; c < B; c++) {
            const jc = jo + c * B;
            let sum = 0;
            for (let m = 0; m < B; m++) sum += L[ir + m] * L[jc + m];
            L[to + r * B + c] -= sum;
          }
        }
      }
      if (pk + 1 < end) {
        first[k] = pk + 1;
        const r = lRow[pk + 1];
        nextIn[k] = link[r];
        link[r] = k;
      }
      k = kn;
    }
    // the diagonal block: dense Cholesky
    const d = p0 * BB;
    for (let c = 0; c < B; c++) {
      let v = L[d + c * B + c];
      for (let m = 0; m < c; m++) v -= L[d + c * B + m] * L[d + c * B + m];
      if (!(v > 1e-11 * diag0[j * B + c]) || !(v > 0)) {
        for (let p = p0; p < p1; p++) pos[lRow[p]] = -1;
        return { ok: false, dof: s.order[j] * B + c };
      }
      const lc = Math.sqrt(v);
      L[d + c * B + c] = lc;
      for (let r = c + 1; r < B; r++) {
        let w = L[d + r * B + c];
        for (let m = 0; m < c; m++) w -= L[d + r * B + m] * L[d + c * B + m];
        L[d + r * B + c] = w / lc;
      }
      for (let r = 0; r < c; r++) L[d + r * B + c] = 0;
    }
    // the blocks below: L(i,j) = W(i,j) L(j,j)⁻ᵀ
    for (let p = p0 + 1; p < p1; p++) {
      const o = p * BB;
      for (let r = 0; r < B; r++) {
        const or = o + r * B;
        for (let c = 0; c < B; c++) {
          let w = L[or + c];
          for (let m = 0; m < c; m++) w -= L[or + m] * L[d + c * B + m];
          L[or + c] = w / L[d + c * B + c];
        }
      }
    }
    if (p0 + 1 < p1) {
      first[j] = p0 + 1;
      const r = lRow[p0 + 1];
      nextIn[j] = link[r];
      link[r] = j;
    }
    for (let p = p0; p < p1; p++) pos[lRow[p]] = -1;
  }
  const order = s.order;
  const y = new Float64Array(n * B);
  const solve = (x: Float64Array) => {
    for (let k = 0; k < n; k++) for (let r = 0; r < B; r++) y[k * B + r] = x[order[k] * B + r];
    // L y = b
    for (let j = 0; j < n; j++) {
      const d = lPtr[j] * BB;
      const yo = j * B;
      for (let r = 0; r < B; r++) {
        let v = y[yo + r];
        for (let m = 0; m < r; m++) v -= L[d + r * B + m] * y[yo + m];
        y[yo + r] = v / L[d + r * B + r];
      }
      for (let p = lPtr[j] + 1; p < lPtr[j + 1]; p++) {
        const o = p * BB;
        const io = lRow[p] * B;
        for (let r = 0; r < B; r++) {
          let v = 0;
          for (let c = 0; c < B; c++) v += L[o + r * B + c] * y[yo + c];
          y[io + r] -= v;
        }
      }
    }
    // Lᵀ x = y
    for (let j = n - 1; j >= 0; j--) {
      const yo = j * B;
      for (let p = lPtr[j] + 1; p < lPtr[j + 1]; p++) {
        const o = p * BB;
        const io = lRow[p] * B;
        for (let c = 0; c < B; c++) {
          let v = 0;
          for (let r = 0; r < B; r++) v += L[o + r * B + c] * y[io + r];
          y[yo + c] -= v;
        }
      }
      const d = lPtr[j] * BB;
      for (let r = B - 1; r >= 0; r--) {
        let v = y[yo + r];
        for (let m = r + 1; m < B; m++) v -= L[d + m * B + r] * y[yo + m];
        y[yo + r] = v / L[d + r * B + r];
      }
    }
    for (let k = 0; k < n; k++) for (let r = 0; r < B; r++) x[order[k] * B + r] = y[k * B + r];
  };
  return { ok: true, solve, fill: s.lRow.length };
}
