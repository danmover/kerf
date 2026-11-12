// A flat three-node shell triangle with six freedoms per node, for thin walls: Allman's membrane, whose midside
// movements come from the corners' in-plane turns (so it bends in its own plane as well as a six-node triangle),
// and the discrete Kirchhoff plate (DKT), whose slopes follow the Kirchhoff condition along each edge. Both are
// built here from their definitions (quadratic fields constrained at the midsides) rather than from closed
// forms, and joined through the material's offset from the reference surface: a laminate laid inside an outer
// skin, or a sheet modelled on one of its faces, stretches when it bends.
//
// Local axes: x along the first edge, z the triangle's normal (right-handed from its corner order), y = z × x.
// Freedoms per node, in those axes: u v w (moves) and θx θy θz (turns; θz is the in-plane "drilling" turn).
// A turn θx lifts the surface toward +y (∂w/∂y = θx), a turn θy lowers it toward +x (∂w/∂x = −θy).

export type V3 = [number, number, number];

/**
 * A layer of isotropic material lying between z0 and z1 along the triangle's normal, from its reference surface; or,
 * with abd, a composite wall there whose plies give its own stiffness.
 */
export interface ShellSection {
  E: number;
  nu: number;
  z0: number;
  z1: number;
  /** a laminate's stretching, coupling and bending stiffness about the reference surface (3 × 3 each, rows ε_x ε_y γ_xy, in the triangle's axes) */
  abd?: { A: Float64Array; B: Float64Array; D: Float64Array };
}

/** the triangle in its own plane, and its axes in the world */
export interface ShellFrame {
  /** local corners x1 y1 x2 y2 x3 y3 (x1 = y1 = y2 = 0) */
  xy: Float64Array;
  /** rows: local x, y, z axes in world coordinates */
  R: Float64Array;
  area: number;
}

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function shellFrame(p1: ArrayLike<number>, p2: ArrayLike<number>, p3: ArrayLike<number>): ShellFrame {
  const e1 = norm(sub(p2, p1));
  const nrm = cross(sub(p2, p1), sub(p3, p1));
  const area = 0.5 * Math.hypot(nrm[0], nrm[1], nrm[2]);
  const e3 = norm(nrm);
  const e2 = cross(e3, e1);
  const d2 = sub(p2, p1),
    d3 = sub(p3, p1);
  const xy = new Float64Array([0, 0, dot(d2, e1), 0, dot(d3, e1), dot(d3, e2)]);
  return { xy, R: new Float64Array([...e1, ...e2, ...e3]), area };
}

/** plane-stress stiffness of an isotropic layer, rows ε_x ε_y γ_xy */
export function planeQ(E: number, nu: number): Float64Array {
  const f = E / (1 - nu * nu);
  return new Float64Array([f, f * nu, 0, f * nu, f, 0, 0, 0, (f * (1 - nu)) / 2]);
}

// ---------- the triangle's quadratic fields ----------

interface Tri {
  /** ∂L_i/∂x, ∂L_i/∂y */
  bx: [number, number, number];
  by: [number, number, number];
  A: number;
  /** per edge k = 0 (1→2), 1 (2→3), 2 (3→1): length, unit tangent and outward normal */
  l: [number, number, number];
  t: [number, number][];
  n: [number, number][];
}

function tri(xy: ArrayLike<number>): Tri {
  const [x1, y1, x2, y2, x3, y3] = [xy[0], xy[1], xy[2], xy[3], xy[4], xy[5]];
  const A2 = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
  const bx: [number, number, number] = [(y2 - y3) / A2, (y3 - y1) / A2, (y1 - y2) / A2];
  const by: [number, number, number] = [(x3 - x2) / A2, (x1 - x3) / A2, (x2 - x1) / A2];
  const P = [
    [x1, y1],
    [x2, y2],
    [x3, y3],
  ];
  const l: [number, number, number] = [0, 0, 0];
  const t: [number, number][] = [];
  const n: [number, number][] = [];
  for (let k = 0; k < 3; k++) {
    const a = P[k],
      b = P[(k + 1) % 3];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    l[k] = len;
    t.push([dx / len, dy / len]);
    // outward: the interior of a counter-clockwise triangle lies to the left of each edge
    n.push([dy / len, -dx / len]);
  }
  return { bx, by, A: A2 / 2, l, t, n };
}

/** derivatives of the six quadratic shape functions (corners 1–3, midsides of 1-2, 2-3, 3-1) at area coordinates L */
function dN6(T: Tri, L: [number, number, number], dx: Float64Array, dy: Float64Array) {
  const [L1, L2, L3] = L;
  // dN/dL_i, rows: N1..N6, columns L1..L3
  const g = [
    [4 * L1 - 1, 0, 0],
    [0, 4 * L2 - 1, 0],
    [0, 0, 4 * L3 - 1],
    [4 * L2, 4 * L1, 0],
    [0, 4 * L3, 4 * L2],
    [4 * L3, 0, 4 * L1],
  ];
  for (let a = 0; a < 6; a++) {
    dx[a] = g[a][0] * T.bx[0] + g[a][1] * T.bx[1] + g[a][2] * T.bx[2];
    dy[a] = g[a][0] * T.by[0] + g[a][1] * T.by[1] + g[a][2] * T.by[2];
  }
}

function N6(L: [number, number, number], out: Float64Array) {
  const [L1, L2, L3] = L;
  out[0] = L1 * (2 * L1 - 1);
  out[1] = L2 * (2 * L2 - 1);
  out[2] = L3 * (2 * L3 - 1);
  out[3] = 4 * L1 * L2;
  out[4] = 4 * L2 * L3;
  out[5] = 4 * L3 * L1;
}

/**
 * Allman: the six-node field's (u, v) at corners and midsides from the corners' (u, v, ω). Each midside moves as the
 * average of its corners plus (l/8)(ω_j − ω_i) along the edge's outward normal. 12 × 9, row-major.
 */
function allmanT(T: Tri): Float64Array {
  const M = new Float64Array(12 * 9);
  for (let a = 0; a < 3; a++) {
    M[(2 * a) * 9 + 3 * a] = 1;
    M[(2 * a + 1) * 9 + 3 * a + 1] = 1;
  }
  for (let k = 0; k < 3; k++) {
    const i = k,
      j = (k + 1) % 3;
    const ru = (6 + 2 * k) * 9,
      rv = (7 + 2 * k) * 9;
    const f = T.l[k] / 8;
    M[ru + 3 * i] += 0.5;
    M[ru + 3 * j] += 0.5;
    M[rv + 3 * i + 1] += 0.5;
    M[rv + 3 * j + 1] += 0.5;
    M[ru + 3 * j + 2] += f * T.n[k][0];
    M[ru + 3 * i + 2] -= f * T.n[k][0];
    M[rv + 3 * j + 2] += f * T.n[k][1];
    M[rv + 3 * i + 2] -= f * T.n[k][1];
  }
  return M;
}

/**
 * DKT: the six-node slope field (∂w/∂x, ∂w/∂y) at corners and midsides from the corners' (w, θx, θy). Corner slopes
 * are the corners' turns; along each edge w is the cubic its ends give, so the midside's slope along the edge is
 * 3/2 (w_j − w_i)/l − (s_i + s_j)·t/4, and across the edge it is the average of the corners'. 12 × 9, row-major.
 */
function dktS(T: Tri): Float64Array {
  const M = new Float64Array(12 * 9);
  // corner slope (sx, sy) = (−θy, θx)
  const cs = (row: number, a: number, cx: number, cy: number, k: number) => {
    // adds k · (cx·sx_a + cy·sy_a) to row
    M[row * 9 + 3 * a + 2] += -k * cx;
    M[row * 9 + 3 * a + 1] += k * cy;
  };
  for (let a = 0; a < 3; a++) {
    cs(2 * a, a, 1, 0, 1);
    cs(2 * a + 1, a, 0, 1, 1);
  }
  for (let k = 0; k < 3; k++) {
    const i = k,
      j = (k + 1) % 3;
    const [tx, ty] = T.t[k],
      [nx, ny] = T.n[k];
    const l = T.l[k];
    for (let comp = 0; comp < 2; comp++) {
      const row = 6 + 2 * k + comp;
      const tc = comp === 0 ? tx : ty,
        nc = comp === 0 ? nx : ny;
      // s_mid = (s_t) t + (s_n) n; s_t = 1.5 (w_j − w_i)/l − 0.25 (s_i + s_j)·t; s_n = 0.5 (s_i + s_j)·n
      M[row * 9 + 3 * j] += (1.5 / l) * tc;
      M[row * 9 + 3 * i] -= (1.5 / l) * tc;
      for (const a of [i, j]) {
        cs(row, a, tx, ty, -0.25 * tc);
        cs(row, a, nx, ny, 0.5 * nc);
      }
    }
  }
  return M;
}

/** the six-node field's strain-like derivatives: rows ∂f_x/∂x, ∂f_y/∂y, ∂f_x/∂y + ∂f_y/∂x, from (f_x, f_y) at 6 nodes */
function b6(dx: Float64Array, dy: Float64Array): Float64Array {
  const B = new Float64Array(3 * 12);
  for (let a = 0; a < 6; a++) {
    B[2 * a] = dx[a];
    B[12 + 2 * a + 1] = dy[a];
    B[24 + 2 * a] = dy[a];
    B[24 + 2 * a + 1] = dx[a];
  }
  return B;
}

function mulAB(A: Float64Array, B: Float64Array, n: number, m: number, p: number): Float64Array {
  const C = new Float64Array(n * p);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < m; k++) {
      const a = A[i * m + k];
      if (a === 0) continue;
      for (let j = 0; j < p; j++) C[i * p + j] += a * B[k * p + j];
    }
  return C;
}

/** local indices of the membrane (u, v, ω) and bending (w, θx, θy) freedoms of each corner */
const MEM = [0, 1, 5, 6, 7, 11, 12, 13, 17];
const BEND = [2, 3, 4, 8, 9, 10, 14, 15, 16];

/** generalised strains [ε_x ε_y γ_xy κ_x κ_y κ_xy] at area coordinates L, from the 18 local freedoms: 6 × 18 */
function strainOp(T: Tri, Tm: Float64Array, Sb: Float64Array, L: [number, number, number]): Float64Array {
  const dx = new Float64Array(6),
    dy = new Float64Array(6);
  dN6(T, L, dx, dy);
  const B = b6(dx, dy);
  const Bm = mulAB(B, Tm, 3, 12, 9);
  const Bb = mulAB(B, Sb, 3, 12, 9);
  const G = new Float64Array(6 * 18);
  for (let r = 0; r < 3; r++)
    for (let q = 0; q < 9; q++) {
      G[r * 18 + MEM[q]] = Bm[r * 9 + q];
      // κ = −(∂s_x/∂x, ∂s_y/∂y, ∂s_x/∂y + ∂s_y/∂x): the strain at z is ε + z κ
      G[(3 + r) * 18 + BEND[q]] = -Bb[r * 9 + q];
    }
  return G;
}

/** membrane, coupling and bending stiffness of the section: A, B, D (3 × 3 each) */
export function abd(sec: ShellSection): { A: Float64Array; B: Float64Array; D: Float64Array } {
  if (sec.abd) return { A: sec.abd.A, B: sec.abd.B, D: sec.abd.D };
  const Q = planeQ(sec.E, sec.nu);
  const { z0, z1 } = sec;
  const a = z1 - z0,
    b = (z1 * z1 - z0 * z0) / 2,
    d = (z1 ** 3 - z0 ** 3) / 3;
  return { A: Q.map((q) => q * a), B: Q.map((q) => q * b), D: Q.map((q) => q * d) };
}

const GAUSS3: [number, number, number][] = [
  [0.5, 0.5, 0],
  [0, 0.5, 0.5],
  [0.5, 0, 0.5],
];

/** share of the shear modulus that ties Allman's corner turns to the membrane's own rotation at the centre */
const DRILL = 0.05;

export interface ShellLocal {
  K: Float64Array;
  /** for stresses: the operators and the section */
  T: Tri;
  Tm: Float64Array;
  Sb: Float64Array;
}

/** The 18 × 18 local stiffness of a flat shell triangle (freedoms per corner: u v w θx θy θz). */
export function shellLocalK(xy: ArrayLike<number>, sec: ShellSection): ShellLocal {
  const T = tri(xy);
  const Tm = allmanT(T);
  const Sb = dktS(T);
  const { A, B, D } = abd(sec);
  const C = new Float64Array(36);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      C[r * 6 + c] = A[r * 3 + c];
      C[r * 6 + 3 + c] = B[r * 3 + c];
      C[(3 + r) * 6 + c] = B[r * 3 + c];
      C[(3 + r) * 6 + 3 + c] = D[r * 3 + c];
    }
  const K = new Float64Array(18 * 18);
  const CG = new Float64Array(6 * 18);
  for (const L of GAUSS3) {
    const G = strainOp(T, Tm, Sb, L);
    const w = T.A / 3;
    CG.fill(0);
    for (let r = 0; r < 6; r++)
      for (let k = 0; k < 6; k++) {
        const c = C[r * 6 + k];
        if (c === 0) continue;
        for (let j = 0; j < 18; j++) CG[r * 18 + j] += c * G[k * 18 + j];
      }
    for (let r = 0; r < 6; r++)
      for (let i = 0; i < 18; i++) {
        const g = G[r * 18 + i];
        if (g === 0) continue;
        for (let j = 0; j < 18; j++) K[i * 18 + j] += w * g * CG[r * 18 + j];
      }
  }
  // the corners' mean turn held to the membrane's rotation at the centre: removes the one free mode of Allman's field
  {
    const dx = new Float64Array(6),
      dy = new Float64Array(6);
    dN6(T, [1 / 3, 1 / 3, 1 / 3], dx, dy);
    // ω0 = ½(∂v/∂x − ∂u/∂y) of the six-node field
    const r6 = new Float64Array(12);
    for (let a = 0; a < 6; a++) {
      r6[2 * a] = -0.5 * dy[a];
      r6[2 * a + 1] = 0.5 * dx[a];
    }
    const w0 = mulAB(r6, Tm, 1, 12, 9);
    const g = new Float64Array(18);
    for (let q = 0; q < 9; q++) g[MEM[q]] -= w0[q];
    for (let a = 0; a < 3; a++) g[6 * a + 5] += 1 / 3;
    // the wall's in-plane shear stiffness per width: G·t, or a laminate's A66
    const Gt = sec.abd ? sec.abd.A[8] : (sec.E / (2 * (1 + sec.nu))) * (sec.z1 - sec.z0);
    const k = DRILL * Gt * T.A;
    for (let i = 0; i < 18; i++) for (let j = 0; j < 18; j++) K[i * 18 + j] += k * g[i] * g[j];
  }
  return { K, T, Tm, Sb };
}

/** K in world axes: Rᵀ K R per corner block (R's rows are the local axes). */
export function toWorld18(Kl: Float64Array, R: Float64Array): Float64Array {
  // KR = K · blockdiag(R), then Rᵀ · KR
  const KR = new Float64Array(18 * 18);
  for (let i = 0; i < 18; i++)
    for (let b = 0; b < 6; b++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let m = 0; m < 3; m++) s += Kl[i * 18 + 3 * b + m] * R[m * 3 + c];
        KR[i * 18 + 3 * b + c] = s;
      }
  const Kw = new Float64Array(18 * 18);
  for (let b = 0; b < 6; b++)
    for (let r = 0; r < 3; r++)
      for (let j = 0; j < 18; j++) {
        let s = 0;
        for (let m = 0; m < 3; m++) s += R[m * 3 + r] * KR[(3 * b + m) * 18 + j];
        Kw[(3 * b + r) * 18 + j] = s;
      }
  return Kw;
}

/** world freedoms of the three corners → local (u = R u_world per move and per turn) */
export function toLocal18(dw: ArrayLike<number>, R: Float64Array, out: Float64Array) {
  for (let b = 0; b < 6; b++)
    for (let r = 0; r < 3; r++) out[3 * b + r] = R[r * 3] * dw[3 * b] + R[r * 3 + 1] * dw[3 * b + 1] + R[r * 3 + 2] * dw[3 * b + 2];
}

/** membrane strains and curvatures [ε_x ε_y γ_xy κ_x κ_y κ_xy] at area coordinates L, from local freedoms */
export function shellStrains(el: ShellLocal, L: [number, number, number], ql: ArrayLike<number>, out: Float64Array) {
  const G = strainOp(el.T, el.Tm, el.Sb, L);
  for (let r = 0; r < 6; r++) {
    let s = 0;
    for (let j = 0; j < 18; j++) s += G[r * 18 + j] * ql[j];
    out[r] = s;
  }
}

// Dunavant's degree-4 rule: exact for the quartic integrand of the slopes' geometric stiffness
const GAUSS6: [number, number, number, number][] = [
  [0.108103018168070, 0.445948490915965, 0.445948490915965, 0.223381589678011],
  [0.445948490915965, 0.108103018168070, 0.445948490915965, 0.223381589678011],
  [0.445948490915965, 0.445948490915965, 0.108103018168070, 0.223381589678011],
  [0.816847572980459, 0.091576213509771, 0.091576213509771, 0.109951743655322],
  [0.091576213509771, 0.816847572980459, 0.091576213509771, 0.109951743655322],
  [0.091576213509771, 0.091576213509771, 0.816847572980459, 0.109951743655322],
];

/**
 * The 18 × 18 local geometric stiffness of a triangle carrying in-plane forces N = (N_x, N_y, N_xy) per width:
 * ∫ ∇wᵀ N ∇w with the DKT's own slopes, plus the in-plane moves' share from their linear field.
 */
export function shellLocalKg(el: ShellLocal, N: ArrayLike<number>): Float64Array {
  const Kg = new Float64Array(18 * 18);
  const [nx, ny, nxy] = [N[0], N[1], N[2]];
  const n6 = new Float64Array(6);
  for (const [L1, L2, L3, w] of GAUSS6) {
    N6([L1, L2, L3], n6);
    // slopes at the point: s = Σ N_a S_a q_b (2 × 9)
    const S = new Float64Array(2 * 9);
    for (let a = 0; a < 6; a++)
      for (let c = 0; c < 2; c++) for (let q = 0; q < 9; q++) S[c * 9 + q] += n6[a] * el.Sb[(2 * a + c) * 9 + q];
    const wA = w * el.T.A;
    for (let i = 0; i < 9; i++)
      for (let j = 0; j < 9; j++) {
        const v = S[i] * (nx * S[j] + nxy * S[9 + j]) + S[9 + i] * (nxy * S[j] + ny * S[9 + j]);
        Kg[BEND[i] * 18 + BEND[j]] += wA * v;
      }
  }
  // in-plane moves, linear over the triangle
  const { bx, by, A } = el.T;
  for (const comp of [0, 1])
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++) {
        const v = A * (bx[a] * (nx * bx[b] + nxy * by[b]) + by[a] * (nxy * bx[b] + ny * by[b]));
        Kg[(6 * a + comp) * 18 + 6 * b + comp] += v;
      }
  return Kg;
}
