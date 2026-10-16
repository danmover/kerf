// The one finite element every voxel shares: an 8-node hexahedron with
// incompatible bending modes (Wilson–Taylor, as in Abaqus C3D8I). Plain
// trilinear bricks lock in bending and come out far too stiff unless a wall
// is many elements thick; the extra modes let one element bend, so a 3 mm
// wall meshed with three elements still deflects within a few percent of
// beam theory.
//
// Matrices are built for a box of given side lengths with E = 1, so a
// voxel of stiffness E·fill uses K × E·fill. The fine grid uses cubes;
// coarser multigrid levels may merge cells along some axes only and get
// boxes with up to 4:1 sides.

/** Voigt order used throughout: xx, yy, zz, xy, yz, zx (engineering shear). */
export interface ElementMatrices {
  nu: number;
  /** side lengths */
  dims: [number, number, number];
  /** 24×24 condensed stiffness, row-major. Dof order: node a (0..7), component x/y/z. */
  K: Float64Array;
  /** diagonal of K */
  diag: Float64Array;
  /** 6×6 constitutive matrix for E = 1 */
  D: Float64Array;
  /** strain at each 2×2×2 Gauss point: 8 matrices of 6×24 (incompatible modes condensed in) */
  strainGauss: Float64Array[];
  /** strain at the element centre, 6×24 */
  strainCenter: Float64Array;
  /** 8×8: value at corner a = Σ_g extrap[a·8 + g] × value at Gauss point g */
  extrap: Float64Array;
}

const G = 1 / Math.sqrt(3);
/** corner a = dx + 2·dy + 4·dz, natural coordinates ±1 */
export const CORNERS: [number, number, number][] = Array.from({ length: 8 }, (_, a) => [(a & 1 ? 1 : -1), (a & 2 ? 1 : -1), (a & 4 ? 1 : -1)]);

export function constitutive(nu: number): Float64Array {
  const lam = nu / ((1 + nu) * (1 - 2 * nu));
  const mu = 1 / (2 * (1 + nu));
  const D = new Float64Array(36);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) D[i * 6 + j] = lam;
    D[i * 6 + i] = lam + 2 * mu;
    D[(i + 3) * 6 + i + 3] = mu;
  }
  return D;
}

/** Fill a 6×(3n) strain-displacement block from n gradient vectors. */
function bBlock(grads: [number, number, number][]): Float64Array {
  const n = grads.length;
  const B = new Float64Array(6 * 3 * n);
  const cols = 3 * n;
  grads.forEach(([gx, gy, gz], a) => {
    const c = 3 * a;
    B[0 * cols + c] = gx;
    B[1 * cols + c + 1] = gy;
    B[2 * cols + c + 2] = gz;
    B[3 * cols + c] = gy;
    B[3 * cols + c + 1] = gx;
    B[4 * cols + c + 1] = gz;
    B[4 * cols + c + 2] = gy;
    B[5 * cols + c] = gz;
    B[5 * cols + c + 2] = gx;
  });
  return B;
}

/** Physical gradients of the 8 shape functions at (ξ, η, ζ) for a box with sides (sx, sy, sz): d/dx = (2/sx) d/dξ. */
function shapeGrads(xi: number, eta: number, zeta: number, sx: number, sy: number, sz: number): [number, number, number][] {
  return CORNERS.map(([a, b, c]) => [
    (2 / sx) * 0.125 * a * (1 + eta * b) * (1 + zeta * c),
    (2 / sy) * 0.125 * b * (1 + xi * a) * (1 + zeta * c),
    (2 / sz) * 0.125 * c * (1 + xi * a) * (1 + eta * b),
  ]);
}

/** Gradients of the incompatible modes 1-ξ², 1-η², 1-ζ² (one per axis). */
function bubbleGrads(xi: number, eta: number, zeta: number, sx: number, sy: number, sz: number): [number, number, number][] {
  return [
    [(-4 * xi) / sx, 0, 0],
    [0, (-4 * eta) / sy, 0],
    [0, 0, (-4 * zeta) / sz],
  ];
}

/** C (r×c) += s · Aᵀ (k×r) · M (k×k) · B (k×c), all row-major. */
function addAtMB(C: Float64Array, A: Float64Array, M: Float64Array, B: Float64Array, k: number, r: number, c: number, s: number) {
  const MB = new Float64Array(k * c);
  for (let i = 0; i < k; i++)
    for (let j = 0; j < c; j++) {
      let t = 0;
      for (let l = 0; l < k; l++) t += M[i * k + l] * B[l * c + j];
      MB[i * c + j] = t;
    }
  for (let i = 0; i < r; i++)
    for (let j = 0; j < c; j++) {
      let t = 0;
      for (let l = 0; l < k; l++) t += A[l * r + i] * MB[l * c + j];
      C[i * c + j] += s * t;
    }
}

/** Inverse of a small dense SPD matrix by Gauss–Jordan elimination. */
export function invert(M: Float64Array, n: number): Float64Array {
  const a = Float64Array.from(M);
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r * n + col]) > Math.abs(a[piv * n + col])) piv = r;
    if (piv !== col)
      for (let j = 0; j < n; j++) {
        [a[col * n + j], a[piv * n + j]] = [a[piv * n + j], a[col * n + j]];
        [inv[col * n + j], inv[piv * n + j]] = [inv[piv * n + j], inv[col * n + j]];
      }
    const d = a[col * n + col];
    for (let j = 0; j < n; j++) {
      a[col * n + j] /= d;
      inv[col * n + j] /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r * n + col];
      if (!f) continue;
      for (let j = 0; j < n; j++) {
        a[r * n + j] -= f * a[col * n + j];
        inv[r * n + j] -= f * inv[col * n + j];
      }
    }
  }
  return inv;
}

const cache = new Map<string, ElementMatrices>();

export function elementMatrices(nuIn: number, sx = 1, sy = sx, sz = sx): ElementMatrices {
  const nu = Math.round(Math.min(0.49, Math.max(0, nuIn)) * 1000) / 1000;
  const key = `${nu}|${sx}|${sy}|${sz}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const detJ = (sx * sy * sz) / 8;
  const D = constitutive(nu);
  const Kuu = new Float64Array(24 * 24);
  const Kua = new Float64Array(24 * 9);
  const Kaa = new Float64Array(9 * 9);
  const gauss: { Bu: Float64Array; Ba: Float64Array }[] = [];
  for (const [a, b, c] of CORNERS) {
    const xi = a * G;
    const eta = b * G;
    const zeta = c * G;
    const Bu = bBlock(shapeGrads(xi, eta, zeta, sx, sy, sz));
    const Ba = bBlock(bubbleGrads(xi, eta, zeta, sx, sy, sz));
    gauss.push({ Bu, Ba });
    // Gauss weights are 1
    addAtMB(Kuu, Bu, D, Bu, 6, 24, 24, detJ);
    addAtMB(Kua, Bu, D, Ba, 6, 24, 9, detJ);
    addAtMB(Kaa, Ba, D, Ba, 6, 9, 9, detJ);
  }
  const KaaInv = invert(Kaa, 9);
  // A = -Kaa⁻¹ Kau  (9×24): incompatible-mode amplitudes from nodal displacements
  const A = new Float64Array(9 * 24);
  for (let i = 0; i < 9; i++)
    for (let j = 0; j < 24; j++) {
      let t = 0;
      for (let l = 0; l < 9; l++) t += KaaInv[i * 9 + l] * Kua[j * 9 + l];
      A[i * 24 + j] = -t;
    }
  // K = Kuu + Kua A
  const K = Float64Array.from(Kuu);
  for (let i = 0; i < 24; i++)
    for (let j = 0; j < 24; j++) {
      let t = 0;
      for (let l = 0; l < 9; l++) t += Kua[i * 9 + l] * A[l * 24 + j];
      K[i * 24 + j] += t;
    }
  // symmetrise round-off
  for (let i = 0; i < 24; i++)
    for (let j = i + 1; j < 24; j++) {
      const m = 0.5 * (K[i * 24 + j] + K[j * 24 + i]);
      K[i * 24 + j] = m;
      K[j * 24 + i] = m;
    }
  const diag = new Float64Array(24);
  for (let i = 0; i < 24; i++) diag[i] = K[i * 24 + i];

  const strainGauss = gauss.map(({ Bu, Ba }) => {
    const T = Float64Array.from(Bu);
    for (let r = 0; r < 6; r++)
      for (let j = 0; j < 24; j++) {
        let t = 0;
        for (let l = 0; l < 9; l++) t += Ba[r * 9 + l] * A[l * 24 + j];
        T[r * 24 + j] += t;
      }
    return T;
  });
  // the incompatible modes have zero gradient at the centre
  const strainCenter = bBlock(shapeGrads(0, 0, 0, sx, sy, sz));

  // Gauss point g sits at natural ±1/√3; a corner is at ±√3 in Gauss-point coordinates
  const extrap = new Float64Array(64);
  const s3 = Math.sqrt(3);
  CORNERS.forEach(([a, b, c], ai) => {
    CORNERS.forEach(([ga, gb, gc], gi) => {
      extrap[ai * 8 + gi] = 0.125 * (1 + s3 * a * ga) * (1 + s3 * b * gb) * (1 + s3 * c * gc);
    });
  });

  const m: ElementMatrices = { nu, dims: [sx, sy, sz], K, diag, D, strainGauss, strainCenter, extrap };
  cache.set(key, m);
  return m;
}

/** Von Mises equivalent stress of a Voigt stress vector. */
export function vonMises(s: ArrayLike<number>, o = 0): number {
  const sx = s[o],
    sy = s[o + 1],
    sz = s[o + 2],
    txy = s[o + 3],
    tyz = s[o + 4],
    tzx = s[o + 5];
  return Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (txy * txy + tyz * tyz + tzx * tzx));
}

/** Principal values of a symmetric 3×3 tensor given in Voigt form (shear as tensor components). Sorted descending. */
export function principal(xx: number, yy: number, zz: number, xy: number, yz: number, zx: number): [number, number, number] {
  const p1 = xy * xy + yz * yz + zx * zx;
  const q = (xx + yy + zz) / 3;
  if (p1 < 1e-30) return [xx, yy, zz].sort((a, b) => b - a) as [number, number, number];
  const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b11 = (xx - q) / p,
    b22 = (yy - q) / p,
    b33 = (zz - q) / p,
    b12 = xy / p,
    b23 = yz / p,
    b13 = zx / p;
  const detB = b11 * (b22 * b33 - b23 * b23) - b12 * (b12 * b33 - b23 * b13) + b13 * (b12 * b23 - b22 * b13);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [e1, e2, e3];
}
