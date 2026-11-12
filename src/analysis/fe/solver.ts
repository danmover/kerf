// Linear-elastic solve on a voxel grid: matrix-free element-by-element
// products (every voxel on a level shares one element matrix),
// preconditioned conjugate gradients, and a geometric multigrid V-cycle as
// the preconditioner. The coarsest grid is solved exactly with a banded
// Cholesky factorisation. Multigrid keeps the iteration count roughly
// independent of the element count, which is what makes a 100k-element
// model practical in a browser worker.

import { elementMatrices, type ElementMatrices } from "./element";
import { ebeProduct } from "./ebe.gen";

/** Elements of a level that use another element matrix (a printed plastic, stiffer along its layers than across). */
export interface ElemClass {
  K: Float64Array;
  Kdiag: Float64Array;
  act: Int32Array;
  stiff: Float64Array;
}

/**
 * Springs from nodes to the ground: an elastic support, or the stiff springs that hold a pin's bore across and along
 * the pin while it turns. A symmetric 3×3 stiffness per node, as (xx, yy, zz, xy, yz, zx), N/mm.
 */
export interface NodeSprings {
  node: Int32Array;
  /** 6 per node */
  k: Float64Array;
}

export interface Level {
  /** element counts */
  nx: number;
  ny: number;
  nz: number;
  /** node counts (n + 1) */
  NX: number;
  NY: number;
  NZ: number;
  /** element side lengths */
  dims: [number, number, number];
  /** 24×24 element stiffness for E = 1 at these side lengths, and its diagonal */
  K: Float64Array;
  Kdiag: Float64Array;
  /** E·fill for every cell, 0 where empty */
  dense: Float64Array;
  /** node index of the (0,0,0) corner of each active element */
  act: Int32Array;
  /** E·fill of each active element */
  stiff: Float64Array;
  /** elements with their own element matrices (fine level only); act and stiff above hold the rest */
  extra: ElemClass[];
  /** per dof: 1 when held by a support (kept apart from activity so it can be carried to coarser grids) */
  bc: Uint8Array;
  /** springs to the ground, or null */
  springs: NodeSprings | null;
  /** nodes smoothed as a 3×3 block (where springs couple a node's directions), and the inverse of each block, 9 each */
  blockNode: Int32Array;
  blockInv: Float64Array;
  /** per dof: 1 when the dof is solved for (active node, not held) */
  free: Uint8Array;
  fixedList: Int32Array;
  invDiag: Float64Array;
  omega: number;
  /** how this level was made from the finer one: 1 = cells merged in pairs along that axis */
  shift: [number, number, number];
  // scratch
  r: Float64Array;
  x: Float64Array;
  t: Float64Array;
  s: Float64Array;
}

export interface Hierarchy {
  levels: Level[];
  coarse: BandCholesky;
  smooth: number;
}

/** Corner offsets in node index for corner a = dx + 2dy + 4dz. */
function offsets(L: { NX: number; NY: number }): Int32Array {
  const NX = L.NX,
    NXY = L.NX * L.NY;
  return Int32Array.from([0, 1, NX, NX + 1, NXY, NXY + 1, NXY + NX, NXY + NX + 1]);
}

/**
 * A grid level. classes: elements whose class c (cls[e] ≥ 1) uses mats[c − 1] instead of the isotropic element, for
 * materials that are stiffer one way than another; coarser levels re-discretise them as isotropic (they only
 * precondition).
 */
export function makeLevel(
  nx: number,
  ny: number,
  nz: number,
  dims: [number, number, number],
  nu: number,
  dense: Float64Array,
  bc: Uint8Array,
  shift: [number, number, number] = [0, 0, 0],
  classes?: { cls: Uint8Array; mats: ElementMatrices[] },
  springs?: NodeSprings | null,
): Level {
  const NX = nx + 1,
    NY = ny + 1,
    NZ = nz + 1;
  const nn = NX * NY * NZ;
  const nc = classes ? classes.mats.length + 1 : 1;
  const counts = new Int32Array(nc);
  for (let e = 0; e < dense.length; e++) if (dense[e] > 0) counts[classes ? classes.cls[e] : 0]++;
  const acts = Array.from(counts, (c) => new Int32Array(c));
  const stiffs = Array.from(counts, (c) => new Float64Array(c));
  const qs = new Int32Array(nc);
  const nodeOn = new Uint8Array(nn);
  const off = offsets({ NX, NY });
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const e = i + nx * (j + ny * k);
        if (!(dense[e] > 0)) continue;
        const n0 = i + NX * (j + NY * k);
        const c = classes ? classes.cls[e] : 0;
        acts[c][qs[c]] = n0;
        stiffs[c][qs[c]++] = dense[e];
        for (let a = 0; a < 8; a++) nodeOn[n0 + off[a]] = 1;
      }
  const act = acts[0];
  const stiff = stiffs[0];
  const extra: ElemClass[] = classes ? classes.mats.map((m, c) => ({ K: m.K, Kdiag: m.diag, act: acts[c + 1], stiff: stiffs[c + 1] })).filter((x) => x.act.length) : [];
  const free = new Uint8Array(3 * nn);
  const fixed: number[] = [];
  for (let n = 0; n < nn; n++) {
    if (!nodeOn[n]) continue;
    for (let c = 0; c < 3; c++) {
      if (bc[3 * n + c]) fixed.push(3 * n + c);
      else free[3 * n + c] = 1;
    }
  }
  const em = elementMatrices(nu, dims[0], dims[1], dims[2]);
  const nd = 3 * nn;
  return {
    nx,
    ny,
    nz,
    NX,
    NY,
    NZ,
    dims,
    K: em.K,
    Kdiag: em.diag,
    dense,
    act,
    stiff,
    extra,
    bc,
    springs: springs && springs.node.length ? springs : null,
    blockNode: new Int32Array(0),
    blockInv: new Float64Array(0),
    free,
    fixedList: Int32Array.from(fixed),
    invDiag: new Float64Array(nd),
    omega: 0.6,
    shift,
    r: new Float64Array(nd),
    x: new Float64Array(nd),
    t: new Float64Array(nd),
    s: new Float64Array(nd),
  };
}

/** y = K x (zeroed on held dofs unless masked is false). x must be zero on held dofs. */
export function applyK(L: Level, x: Float64Array, y: Float64Array, masked = true) {
  y.fill(0);
  ebeProduct(L.K, L.act, L.stiff, L.NX, L.NX * L.NY, x, y);
  for (const c of L.extra) ebeProduct(c.K, c.act, c.stiff, L.NX, L.NX * L.NY, x, y);
  const S = L.springs;
  if (S) {
    const nd = S.node,
      k = S.k;
    for (let q = 0; q < nd.length; q++) {
      const d = 3 * nd[q],
        o = 6 * q;
      const a = x[d],
        b = x[d + 1],
        c = x[d + 2];
      y[d] += k[o] * a + k[o + 3] * b + k[o + 5] * c;
      y[d + 1] += k[o + 3] * a + k[o + 1] * b + k[o + 4] * c;
      y[d + 2] += k[o + 5] * a + k[o + 4] * b + k[o + 2] * c;
    }
  }
  if (masked) {
    const fl = L.fixedList;
    for (let i = 0; i < fl.length; i++) y[fl[i]] = 0;
  }
}

/** Every group of elements on a level that shares an element matrix. */
const groups = (L: Level): ElemClass[] => [{ K: L.K, Kdiag: L.Kdiag, act: L.act, stiff: L.stiff }, ...L.extra];

function computeDiag(L: Level) {
  const off = offsets(L);
  const dg = L.invDiag;
  dg.fill(0);
  for (const g of groups(L)) {
    const Kd = g.Kdiag;
    for (let e = 0; e < g.act.length; e++) {
      const n0 = g.act[e];
      const s = g.stiff[e];
      for (let a = 0; a < 8; a++) {
        const d = (n0 + off[a]) * 3;
        dg[d] += s * Kd[3 * a];
        dg[d + 1] += s * Kd[3 * a + 1];
        dg[d + 2] += s * Kd[3 * a + 2];
      }
    }
  }
  const S = L.springs;
  if (S)
    for (let q = 0; q < S.node.length; q++) {
      const d = 3 * S.node[q];
      dg[d] += S.k[6 * q];
      dg[d + 1] += S.k[6 * q + 1];
      dg[d + 2] += S.k[6 * q + 2];
    }
  for (let i = 0; i < dg.length; i++) dg[i] = L.free[i] && dg[i] > 0 ? 1 / dg[i] : 0;
  blockSmoother(L);
}

/**
 * Where springs couple a node's three directions (a pin's springs lie across the bore, not along X, Y or Z), plain
 * Jacobi barely moves the node along the free direction: those nodes are smoothed as 3×3 blocks instead.
 */
function blockSmoother(L: Level) {
  L.blockNode = new Int32Array(0);
  L.blockInv = new Float64Array(0);
  const S = L.springs;
  if (!S) return;
  const nn = L.NX * L.NY * L.NZ;
  const which: number[] = [];
  for (let q = 0; q < S.node.length; q++) {
    const o = 6 * q;
    const off = Math.abs(S.k[o + 3]) + Math.abs(S.k[o + 4]) + Math.abs(S.k[o + 5]);
    if (off > 1e-9 * (S.k[o] + S.k[o + 1] + S.k[o + 2])) which.push(q);
  }
  if (!which.length) return;
  const idx = new Int32Array(nn).fill(-1);
  which.forEach((q, b) => (idx[S.node[q]] = b));
  const B = new Float64Array(9 * which.length);
  const off = offsets(L);
  // the elastic part of each block: every element's 3×3 block at that corner
  for (const g of groups(L)) {
    const K = g.K;
    for (let e = 0; e < g.act.length; e++) {
      const n0 = g.act[e];
      const s = g.stiff[e];
      for (let a = 0; a < 8; a++) {
        const b = idx[n0 + off[a]];
        if (b < 0) continue;
        for (let ca = 0; ca < 3; ca++) for (let cb = 0; cb < 3; cb++) B[9 * b + 3 * ca + cb] += s * K[(3 * a + ca) * 24 + 3 * a + cb];
      }
    }
  }
  const nodes = new Int32Array(which.length);
  const inv = new Float64Array(9 * which.length);
  const M = new Float64Array(9);
  let kept = 0;
  which.forEach((q, b) => {
    const o = 6 * q;
    const k = S.k;
    const n = S.node[q];
    for (let i = 0; i < 9; i++) M[i] = B[9 * b + i];
    M[0] += k[o];
    M[4] += k[o + 1];
    M[8] += k[o + 2];
    M[1] += k[o + 3];
    M[3] += k[o + 3];
    M[5] += k[o + 4];
    M[7] += k[o + 4];
    M[2] += k[o + 5];
    M[6] += k[o + 5];
    // a held direction drops out of the block
    for (let c = 0; c < 3; c++)
      if (!L.free[3 * n + c]) {
        for (let j = 0; j < 3; j++) M[3 * c + j] = M[3 * j + c] = 0;
        M[4 * c] = 1;
      }
    const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
    if (!(Math.abs(det) > 1e-30) || !Number.isFinite(det)) return;
    const o9 = 9 * kept;
    inv[o9] = (M[4] * M[8] - M[5] * M[7]) / det;
    inv[o9 + 1] = (M[2] * M[7] - M[1] * M[8]) / det;
    inv[o9 + 2] = (M[1] * M[5] - M[2] * M[4]) / det;
    inv[o9 + 3] = (M[5] * M[6] - M[3] * M[8]) / det;
    inv[o9 + 4] = (M[0] * M[8] - M[2] * M[6]) / det;
    inv[o9 + 5] = (M[2] * M[3] - M[0] * M[5]) / det;
    inv[o9 + 6] = (M[3] * M[7] - M[4] * M[6]) / det;
    inv[o9 + 7] = (M[1] * M[6] - M[0] * M[7]) / det;
    inv[o9 + 8] = (M[0] * M[4] - M[1] * M[3]) / det;
    for (let c = 0; c < 3; c++)
      if (!L.free[3 * n + c]) for (let j = 0; j < 3; j++) inv[o9 + 3 * c + j] = inv[o9 + 3 * j + c] = 0;
    nodes[kept++] = n;
    // the block replaces plain Jacobi at this node
    L.invDiag[3 * n] = L.invDiag[3 * n + 1] = L.invDiag[3 * n + 2] = 0;
  });
  L.blockNode = nodes.slice(0, kept);
  L.blockInv = inv.slice(0, 9 * kept);
}

/** out = ω·D⁻¹·(r − t), or with t null out = ω·D⁻¹·r: one damped Jacobi step, by blocks where springs couple a node. */
function jacobi(L: Level, r: Float64Array, t: Float64Array | null, out: Float64Array, add: boolean, w = L.omega) {
  const inv = L.invDiag,
    n = out.length;
  if (t) {
    if (add) for (let i = 0; i < n; i++) out[i] += w * inv[i] * (r[i] - t[i]);
    else for (let i = 0; i < n; i++) out[i] = w * inv[i] * (r[i] - t[i]);
  } else if (add) for (let i = 0; i < n; i++) out[i] += w * inv[i] * r[i];
  else for (let i = 0; i < n; i++) out[i] = w * inv[i] * r[i];
  const bn = L.blockNode;
  if (!bn.length) return;
  const B = L.blockInv;
  for (let q = 0; q < bn.length; q++) {
    const d = 3 * bn[q],
      o = 9 * q;
    const a = t ? r[d] - t[d] : r[d],
      b = t ? r[d + 1] - t[d + 1] : r[d + 1],
      c = t ? r[d + 2] - t[d + 2] : r[d + 2];
    out[d] += w * (B[o] * a + B[o + 1] * b + B[o + 2] * c);
    out[d + 1] += w * (B[o + 3] * a + B[o + 4] * b + B[o + 5] * c);
    out[d + 2] += w * (B[o + 6] * a + B[o + 7] * b + B[o + 8] * c);
  }
}

/** Largest eigenvalue of D⁻¹K by power iteration, for the Jacobi damping factor. */
function estimateLambda(L: Level): number {
  const x = L.r,
    y = L.t;
  let seed = 12345;
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = L.free[i] ? seed / 0x7fffffff - 0.5 : 0;
  }
  let lam = 1;
  const z = L.s;
  for (let it = 0; it < 10; it++) {
    applyK(L, x, z);
    jacobi(L, z, null, y, false, 1);
    let nx = 0,
      ny = 0;
    for (let i = 0; i < x.length; i++) {
      nx += x[i] * x[i];
      ny += y[i] * y[i];
    }
    if (ny === 0 || nx === 0) return 1;
    lam = Math.sqrt(ny / nx);
    const inv = 1 / Math.sqrt(ny);
    for (let i = 0; i < x.length; i++) x[i] = y[i] * inv;
  }
  return lam;
}

/**
 * Which axes to merge at each multigrid level, and how far to pad the fine
 * grid so every merge is exact. Axes are merged only while the resulting
 * cells stay within 4:1 of the shortest side, and until the coarsest grid
 * is cheap enough to factor directly. The limit is on the cost of the banded
 * factorisation rather than the node count, so long or flat parts keep a
 * larger coarse grid, which is what keeps their iteration count down.
 */
export function coarseningPlan(n: [number, number, number], dims: [number, number, number] = [1, 1, 1], maxFlops = 2e8, maxLevels = 8): { shifts: [number, number, number][]; padded: [number, number, number] } {
  const shifts: [number, number, number][] = [];
  const cur = [...n];
  const size = [...dims];
  const tooBig = () => {
    const N = [cur[0] + 1, cur[1] + 1, cur[2] + 1].sort((a, b) => a - b);
    const dofs = 3 * N[0] * N[1] * N[2];
    const bw = 3 * (N[0] * N[1] + N[0] + 1) + 2;
    return (dofs * bw * bw) / 2 > maxFlops || dofs * (bw + 1) > 8e6;
  };
  while (tooBig() && shifts.length < maxLevels) {
    // merge cells along the axes that are not already much longer than the shortest one still divisible,
    // so coarse cells stay within about 4:1 (an axis with a single cell left, like a thin plate's thickness, sets no limit)
    const open = [0, 1, 2].filter((d) => cur[d] >= 2);
    if (!open.length) break;
    const minSize = Math.min(...open.map((d) => size[d]));
    const s: [number, number, number] = [0, 0, 0];
    for (const d of open) if (size[d] * 2 <= 4 * minSize) s[d] = 1;
    if (!s.some(Boolean)) break;
    shifts.push(s);
    for (let d = 0; d < 3; d++)
      if (s[d]) {
        cur[d] = Math.ceil(cur[d] / 2);
        size[d] *= 2;
      }
  }
  const padded: [number, number, number] = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const f = 2 ** shifts.reduce((a, s) => a + s[d], 0);
    padded[d] = Math.ceil(n[d] / f) * f;
  }
  return { shifts, padded };
}

/** The next coarser grid: cells merged along the axes in `shift`, supports carried over, stiffness re-discretised. */
export function coarsen(F: Level, shift: [number, number, number], nu: number): Level {
  const [sx, sy, sz] = shift;
  const nx = F.nx >> sx,
    ny = F.ny >> sy,
    nz = F.nz >> sz;
  const children = (1 << sx) * (1 << sy) * (1 << sz);
  const dense = new Float64Array(nx * ny * nz);
  for (let k = 0; k < F.nz; k++)
    for (let j = 0; j < F.ny; j++)
      for (let i = 0; i < F.nx; i++) {
        const v = F.dense[i + F.nx * (j + F.ny * k)];
        if (v > 0) dense[(i >> sx) + nx * ((j >> sy) + ny * (k >> sz))] += v / children;
      }
  const NX = nx + 1,
    NY = ny + 1,
    NZ = nz + 1;
  const bc = new Uint8Array(3 * NX * NY * NZ);
  for (let k = 0; k < F.NZ; k++)
    for (let j = 0; j < F.NY; j++)
      for (let i = 0; i < F.NX; i++) {
        const fn = 3 * (i + F.NX * (j + F.NY * k));
        if (!(F.bc[fn] | F.bc[fn + 1] | F.bc[fn + 2])) continue;
        // a coarse node is held if a held fine node lies within its interpolation support
        for (let K = k >> sz; K <= (k + sz) >> sz; K++)
          for (let J = j >> sy; J <= (j + sy) >> sy; J++)
            for (let I = i >> sx; I <= (i + sx) >> sx; I++) {
              const cn = 3 * (I + NX * (J + NY * K));
              bc[cn] |= F.bc[fn];
              bc[cn + 1] |= F.bc[fn + 1];
              bc[cn + 2] |= F.bc[fn + 2];
            }
      }
  const dims: [number, number, number] = [F.dims[0] * (1 << sx), F.dims[1] * (1 << sy), F.dims[2] * (1 << sz)];
  return makeLevel(nx, ny, nz, dims, nu, dense, bc, shift, undefined, F.springs ? coarseSprings(F, F.springs, shift, NX, NY) : null);
}

/**
 * Springs on the next coarser grid: each fine spring shared out to the coarse nodes it interpolates from, by the
 * interpolation weights. That is the coarse (Galerkin) spring with its rows lumped, so the total stiffness is kept.
 */
function coarseSprings(F: Level, S: NodeSprings, shift: [number, number, number], NX: number, NY: number): NodeSprings {
  const [sx, sy, sz] = shift;
  const acc = new Map<number, Float64Array>();
  const ix = [0, 0],
    iw = [0, 0],
    jx = [0, 0],
    jw = [0, 0],
    kx = [0, 0],
    kw = [0, 0];
  for (let q = 0; q < S.node.length; q++) {
    const n = S.node[q];
    const i = n % F.NX,
      j = Math.floor(n / F.NX) % F.NY,
      k = Math.floor(n / (F.NX * F.NY));
    const ni = split(i, sx, ix, iw),
      nj = split(j, sy, jx, jw),
      nk = split(k, sz, kx, kw);
    for (let p = 0; p < nk; p++)
      for (let a = 0; a < nj; a++)
        for (let b = 0; b < ni; b++) {
          const w = kw[p] * jw[a] * iw[b];
          const cn = ix[b] + NX * (jx[a] + NY * kx[p]);
          let v = acc.get(cn);
          if (!v) acc.set(cn, (v = new Float64Array(6)));
          for (let c = 0; c < 6; c++) v[c] += w * S.k[6 * q + c];
        }
  }
  const node = new Int32Array(acc.size);
  const kk = new Float64Array(6 * acc.size);
  let q = 0;
  for (const [n, v] of [...acc].sort((a, b) => a[0] - b[0])) {
    node[q] = n;
    kk.set(v, 6 * q++);
  }
  return { node, k: kk };
}

/** Interpolation weights from coarse nodes to fine node index i along one axis. */
function split(i: number, s: number, idx: number[], w: number[]): number {
  if (s === 0) {
    idx[0] = i;
    w[0] = 1;
    return 1;
  }
  if ((i & 1) === 0) {
    idx[0] = i >> 1;
    w[0] = 1;
    return 1;
  }
  idx[0] = (i - 1) >> 1;
  idx[1] = (i + 1) >> 1;
  w[0] = 0.5;
  w[1] = 0.5;
  return 2;
}

/** Restriction (transpose of trilinear prolongation) from fine F to coarse C. */
function restrict(F: Level, C: Level, rf: Float64Array, rc: Float64Array) {
  rc.fill(0);
  const [sx, sy, sz] = C.shift;
  const ix = [0, 0],
    iw = [0, 0],
    jx = [0, 0],
    jw = [0, 0],
    kx = [0, 0],
    kw = [0, 0];
  for (let k = 0; k < F.NZ; k++) {
    const nk = split(k, sz, kx, kw);
    for (let j = 0; j < F.NY; j++) {
      const nj = split(j, sy, jx, jw);
      for (let i = 0; i < F.NX; i++) {
        const f = 3 * (i + F.NX * (j + F.NY * k));
        const a = rf[f],
          b = rf[f + 1],
          c = rf[f + 2];
        if (a === 0 && b === 0 && c === 0) continue;
        const ni = split(i, sx, ix, iw);
        for (let p = 0; p < nk; p++)
          for (let q = 0; q < nj; q++)
            for (let r = 0; r < ni; r++) {
              const w = kw[p] * jw[q] * iw[r];
              const cn = 3 * (ix[r] + C.NX * (jx[q] + C.NY * kx[p]));
              rc[cn] += w * a;
              rc[cn + 1] += w * b;
              rc[cn + 2] += w * c;
            }
      }
    }
  }
  for (let i = 0; i < rc.length; i++) if (!C.free[i]) rc[i] = 0;
}

/** Trilinear prolongation from coarse C to fine F, added into ef. */
function prolongAdd(F: Level, C: Level, ec: Float64Array, ef: Float64Array) {
  const [sx, sy, sz] = C.shift;
  const ix = [0, 0],
    iw = [0, 0],
    jx = [0, 0],
    jw = [0, 0],
    kx = [0, 0],
    kw = [0, 0];
  for (let k = 0; k < F.NZ; k++) {
    const nk = split(k, sz, kx, kw);
    for (let j = 0; j < F.NY; j++) {
      const nj = split(j, sy, jx, jw);
      for (let i = 0; i < F.NX; i++) {
        const f = 3 * (i + F.NX * (j + F.NY * k));
        if (!(F.free[f] | F.free[f + 1] | F.free[f + 2])) continue;
        const ni = split(i, sx, ix, iw);
        let a = 0,
          b = 0,
          c = 0;
        for (let p = 0; p < nk; p++)
          for (let q = 0; q < nj; q++)
            for (let r = 0; r < ni; r++) {
              const w = kw[p] * jw[q] * iw[r];
              const cn = 3 * (ix[r] + C.NX * (jx[q] + C.NY * kx[p]));
              a += w * ec[cn];
              b += w * ec[cn + 1];
              c += w * ec[cn + 2];
            }
        if (F.free[f]) ef[f] += a;
        if (F.free[f + 1]) ef[f + 1] += b;
        if (F.free[f + 2]) ef[f + 2] += c;
      }
    }
  }
}

// ---------- coarsest grid: banded Cholesky ----------

export class BandCholesky {
  n: number;
  bw: number;
  band: Float64Array;
  /** natural dof index -> band order */
  perm: Int32Array;
  y: Float64Array;

  constructor(L: Level) {
    const dims = [L.NX, L.NY, L.NZ];
    // order axes so the longest one varies slowest: keeps the band narrow
    const axes = [0, 1, 2].sort((a, b) => dims[a] - dims[b]);
    const N0 = dims[axes[0]],
      N1 = dims[axes[1]];
    const nn = L.NX * L.NY * L.NZ;
    this.n = 3 * nn;
    this.perm = new Int32Array(this.n);
    const c = [0, 0, 0];
    for (let k = 0; k < L.NZ; k++)
      for (let j = 0; j < L.NY; j++)
        for (let i = 0; i < L.NX; i++) {
          c[0] = i;
          c[1] = j;
          c[2] = k;
          const ord = c[axes[0]] + N0 * (c[axes[1]] + N1 * c[axes[2]]);
          const n = i + L.NX * (j + L.NY * k);
          for (let d = 0; d < 3; d++) this.perm[3 * n + d] = 3 * ord + d;
        }
    this.bw = Math.min(this.n - 1, 3 * (N0 * N1 + N0 + 1) + 2);
    const W = this.bw + 1;
    const band = new Float64Array(this.n * W);
    this.band = band;
    const off = offsets(L);
    for (const g of groups(L)) {
      const K = g.K;
      for (let e = 0; e < g.act.length; e++) {
        const n0 = g.act[e];
        const s = g.stiff[e];
        for (let a = 0; a < 8; a++)
          for (let ca = 0; ca < 3; ca++) {
            const na = 3 * (n0 + off[a]) + ca;
            if (!L.free[na]) continue;
            const gi = this.perm[na];
            for (let b = 0; b < 8; b++)
              for (let cb = 0; cb < 3; cb++) {
                const nb = 3 * (n0 + off[b]) + cb;
                if (!L.free[nb]) continue;
                const gj = this.perm[nb];
                if (gj > gi) continue;
                band[gi * W + (gi - gj)] += s * K[(3 * a + ca) * 24 + 3 * b + cb];
              }
          }
      }
    }
    const S = L.springs;
    if (S)
      for (let q = 0; q < S.node.length; q++) {
        const n = S.node[q];
        const o = 6 * q;
        // (xx, yy, zz, xy, yz, zx) as a 3×3
        const kab = [S.k[o], S.k[o + 3], S.k[o + 5], S.k[o + 3], S.k[o + 1], S.k[o + 4], S.k[o + 5], S.k[o + 4], S.k[o + 2]];
        for (let ca = 0; ca < 3; ca++)
          for (let cb = 0; cb < 3; cb++) {
            const na = 3 * n + ca,
              nb = 3 * n + cb;
            if (!L.free[na] || !L.free[nb]) continue;
            const gi = this.perm[na],
              gj = this.perm[nb];
            if (gj > gi) continue;
            band[gi * W + (gi - gj)] += kab[3 * ca + cb];
          }
      }
    let maxDiag = 0;
    for (let i = 0; i < this.n; i++) maxDiag = Math.max(maxDiag, band[i * W]);
    for (let n = 0; n < this.n; n++) if (!L.free[n]) band[this.perm[n] * W] = 1;
    this.factor(maxDiag || 1);
    this.y = new Float64Array(this.n);
  }

  private factor(maxDiag: number) {
    const n = this.n,
      bw = this.bw,
      W = bw + 1,
      A = this.band;
    // a tiny floor keeps the factor usable if a coarse grid is close to singular; it is only a preconditioner
    const floor = 1e-12 * maxDiag;
    for (let j = 0; j < n; j++) {
      let d = A[j * W];
      for (let k = Math.max(0, j - bw); k < j; k++) {
        const l = A[j * W + (j - k)];
        d -= l * l;
      }
      const ljj = Math.sqrt(d > floor ? d : floor);
      A[j * W] = ljj;
      const iMax = Math.min(n - 1, j + bw);
      for (let i = j + 1; i <= iMax; i++) {
        let v = A[i * W + (i - j)];
        for (let k = Math.max(0, i - bw); k < j; k++) v -= A[i * W + (i - k)] * A[j * W + (j - k)];
        A[i * W + (i - j)] = v / ljj;
      }
    }
  }

  /** Solve on a natural-order vector b; entries that are not free come back as 0. */
  solve(L: Level, b: Float64Array, out: Float64Array) {
    const n = this.n,
      bw = this.bw,
      W = bw + 1,
      A = this.band,
      y = this.y;
    y.fill(0);
    for (let i = 0; i < n; i++) if (L.free[i]) y[this.perm[i]] = b[i];
    for (let i = 0; i < n; i++) {
      let v = y[i];
      for (let k = Math.max(0, i - bw); k < i; k++) v -= A[i * W + (i - k)] * y[k];
      y[i] = v / A[i * W];
    }
    for (let i = n - 1; i >= 0; i--) {
      const v = y[i] / A[i * W];
      y[i] = v;
      for (let k = Math.max(0, i - bw); k < i; k++) y[k] -= A[i * W + (i - k)] * v;
    }
    for (let i = 0; i < n; i++) out[i] = L.free[i] ? y[this.perm[i]] : 0;
  }
}

// ---------- hierarchy and PCG ----------

export function buildHierarchy(fine: Level, shifts: [number, number, number][], nu: number, smooth = 2): Hierarchy {
  const out: Level[] = [fine];
  for (const s of shifts) out.push(coarsen(out[out.length - 1], s, nu));
  for (let l = 0; l < out.length - 1; l++) {
    computeDiag(out[l]);
    const lam = estimateLambda(out[l]) * 1.1;
    out[l].omega = 4 / (3 * Math.max(lam, 1e-12));
  }
  const coarse = new BandCholesky(out[out.length - 1]);
  return { levels: out, coarse, smooth };
}

/**
 * The hierarchy with a new fine level over the same cells, supports and springs, whose elements differ only in their
 * element matrices (contacts that slide or part): the coarser grids, re-discretised from the same stiffness, are
 * kept, and only the fine level's smoother is redone. With no coarser grid the direct solve is redone too.
 */
export function withFine(H: Hierarchy, fine: Level, nu: number): Hierarchy {
  if (H.levels.length === 1) return buildHierarchy(fine, [], nu, H.smooth);
  computeDiag(fine);
  fine.omega = 4 / (3 * Math.max(estimateLambda(fine) * 1.1, 1e-12));
  return { levels: [fine, ...H.levels.slice(1)], coarse: H.coarse, smooth: H.smooth };
}

/** Each active element's stiffness from its cell in L.dense (after L.dense has changed; the same cells active). */
function restiff(L: Level) {
  const NX = L.NX,
    NXY = L.NX * L.NY;
  for (const g of groups(L))
    for (let q = 0; q < g.act.length; q++) {
      const n0 = g.act[q];
      const k = (n0 / NXY) | 0;
      const r = n0 - k * NXY;
      const j = (r / NX) | 0;
      g.stiff[q] = L.dense[r - j * NX + L.nx * (j + L.ny * k)];
    }
}

/**
 * New element stiffnesses on the same grids, for a solve repeated while the material changes a little each time (the
 * topology optimiser): every level takes the new stiffness and its smoother follows it, which is cheap. The same
 * cells must stay in use (dense > 0 in the same cells). The coarsest grid's factorisation and the smoothing factors
 * are only redone when refresh is set: they only precondition, so a slightly old one costs a few iterations, not
 * accuracy, and the factorisation is most of the cost of building the hierarchy.
 */
export function restiffen(H: Hierarchy, dense: Float64Array, refresh = false) {
  let F = H.levels[0];
  if (dense !== F.dense) F.dense.set(dense);
  restiff(F);
  for (let l = 1; l < H.levels.length; l++) {
    const C = H.levels[l];
    const [sx, sy, sz] = C.shift;
    const children = (1 << sx) * (1 << sy) * (1 << sz);
    const d = C.dense;
    d.fill(0);
    for (let k = 0; k < F.nz; k++)
      for (let j = 0; j < F.ny; j++)
        for (let i = 0; i < F.nx; i++) {
          const v = F.dense[i + F.nx * (j + F.ny * k)];
          if (v > 0) d[(i >> sx) + C.nx * ((j >> sy) + C.ny * (k >> sz))] += v / children;
        }
    restiff(C);
    F = C;
  }
  for (let l = 0; l < H.levels.length - 1; l++) {
    const L = H.levels[l];
    computeDiag(L);
    if (refresh) L.omega = 4 / (3 * Math.max(estimateLambda(L) * 1.1, 1e-12));
  }
  if (refresh) H.coarse = new BandCholesky(H.levels[H.levels.length - 1]);
}

/** One symmetric V-cycle: out ≈ K⁻¹ r on level l. */
function vcycle(H: Hierarchy, l: number, r: Float64Array, out: Float64Array) {
  const L = H.levels[l];
  if (l === H.levels.length - 1) {
    H.coarse.solve(L, r, out);
    return;
  }
  const t = L.t,
    n = out.length;
  jacobi(L, r, null, out, false);
  for (let s = 1; s < H.smooth; s++) {
    applyK(L, out, t);
    jacobi(L, r, t, out, true);
  }
  applyK(L, out, t);
  const res = L.s;
  for (let i = 0; i < n; i++) res[i] = r[i] - t[i];
  const C = H.levels[l + 1];
  restrict(L, C, res, C.r);
  vcycle(H, l + 1, C.r, C.x);
  prolongAdd(L, C, C.x, out);
  for (let s = 0; s < H.smooth; s++) {
    applyK(L, out, t);
    jacobi(L, r, t, out, true);
  }
}

/** out ≈ K⁻¹ r by one V-cycle on the fine level: the preconditioner, for other iterative solvers (the modal one). */
export function precondition(H: Hierarchy, r: Float64Array, out: Float64Array) {
  vcycle(H, 0, r, out);
}

export interface SolveStats {
  iterations: number;
  residual: number;
  converged: boolean;
  history: number[];
}

/** Preconditioned conjugate gradients on the fine level. f must be zero on dofs that are not free. */
export function pcg(
  H: Hierarchy,
  f: Float64Array,
  opts: { tol?: number; maxIter?: number; onIter?: (it: number, rel: number) => void; x0?: Float64Array } = {},
): { u: Float64Array; stats: SolveStats } {
  const L = H.levels[0];
  const n = f.length;
  const tol = opts.tol ?? 1e-6;
  const maxIter = opts.maxIter ?? 400;
  const u = new Float64Array(n);
  const r = Float64Array.from(f);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  let fn = 0;
  for (let i = 0; i < n; i++) fn += f[i] * f[i];
  fn = Math.sqrt(fn);
  const history: number[] = [];
  if (fn === 0) return { u, stats: { iterations: 0, residual: 0, converged: true, history } };
  // a warm start (the last solve of a problem that has changed a little): carry on from it
  if (opts.x0) {
    for (let i = 0; i < n; i++) u[i] = L.free[i] ? opts.x0[i] : 0;
    applyK(L, u, q);
    let rr = 0;
    for (let i = 0; i < n; i++) {
      r[i] -= q[i];
      rr += r[i] * r[i];
    }
    if (Math.sqrt(rr) / fn < tol) return { u, stats: { iterations: 0, residual: Math.sqrt(rr) / fn, converged: true, history } };
  }
  vcycle(H, 0, r, z);
  p.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  let rel = 1;
  let it = 0;
  while (it < maxIter) {
    applyK(L, p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    let rr = 0;
    for (let i = 0; i < n; i++) {
      u[i] += alpha * p[i];
      r[i] -= alpha * q[i];
      rr += r[i] * r[i];
    }
    it++;
    rel = Math.sqrt(rr) / fn;
    history.push(rel);
    opts.onIter?.(it, rel);
    if (rel < tol) break;
    vcycle(H, 0, r, z);
    let rzNew = 0;
    for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { u, stats: { iterations: it, residual: rel, converged: rel < tol * 10, history } };
}
