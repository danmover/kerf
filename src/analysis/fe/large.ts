// Large deflection: the static answer when parts bend or turn far enough that
// the small-deflection answer is off (snap fits pushed home, flexures, springs,
// long thin arms, membranes that stretch as they sag).
//
// Each element turns with its own rotation, found from how its middle is
// deformed (the polar decomposition of the deformation gradient there), and
// strains only by what is left over. Its own element matrix (incompatible
// modes and all) works in that turned frame, so an element bends as well as it
// does in the linear answer however far it has turned: a co-rotational
// formulation. Strains stay small, which is what plastics and metals in snap
// fits and flexures do; the turning is what is large.
//
// Newton's method finds the balance, with the loads (and any set
// displacements) put on in steps that shrink when a step will not settle and
// grow when it settles quickly. Each step's linear solve is conjugate
// gradients on the tangent (the turned element matrices plus the stiffening, or
// softening, of the stress each element carries, as in the buckling solve),
// preconditioned by the linear multigrid.

import { precondition, type Hierarchy, type Level } from "./solver";

/** Where an element's corners are and how its middle's deformation is read from them, on one grid. */
export interface ElementFrame {
  /** dof offset of corner a from corner 0 */
  off: Int32Array;
  /** corner positions from corner 0, 3 per corner */
  X: Float64Array;
  /** gradient of each corner's shape function at the middle, 3 per corner */
  g: Float64Array;
}

export function elementFrame(dims: [number, number, number], NX: number, NY: number): ElementFrame {
  const off = new Int32Array(8);
  const X = new Float64Array(24);
  const g = new Float64Array(24);
  for (let a = 0; a < 8; a++) {
    const dx = a & 1,
      dy = (a >> 1) & 1,
      dz = (a >> 2) & 1;
    off[a] = 3 * (dx + NX * (dy + NY * dz));
    X[3 * a] = dx * dims[0];
    X[3 * a + 1] = dy * dims[1];
    X[3 * a + 2] = dz * dims[2];
    g[3 * a] = (2 * dx - 1) / (4 * dims[0]);
    g[3 * a + 1] = (2 * dy - 1) / (4 * dims[1]);
    g[3 * a + 2] = (2 * dz - 1) / (4 * dims[2]);
  }
  return { off, X, g };
}

/**
 * The rotation in F (row-major 3×3) by its polar decomposition, into R at o: scaled Newton iteration on
 * X ← (γX + X⁻ᵀ/γ)/2. False when F is folded over (det ≤ 0), with R left as it was.
 */
export function polar(F: ArrayLike<number>, R: Float64Array, o = 0): boolean {
  let a0 = F[0],
    a1 = F[1],
    a2 = F[2],
    a3 = F[3],
    a4 = F[4],
    a5 = F[5],
    a6 = F[6],
    a7 = F[7],
    a8 = F[8];
  for (let k = 0; k < 30; k++) {
    const c0 = a4 * a8 - a5 * a7,
      c1 = a5 * a6 - a3 * a8,
      c2 = a3 * a7 - a4 * a6,
      c3 = a2 * a7 - a1 * a8,
      c4 = a0 * a8 - a2 * a6,
      c5 = a1 * a6 - a0 * a7,
      c6 = a1 * a5 - a2 * a4,
      c7 = a2 * a3 - a0 * a5,
      c8 = a0 * a4 - a1 * a3;
    const det = a0 * c0 + a1 * c1 + a2 * c2;
    if (!(det > 1e-12)) return false;
    const gam = 1 / Math.cbrt(det);
    const s = 0.5 * gam,
      t = 0.5 / (gam * det);
    const b0 = s * a0 + t * c0,
      b1 = s * a1 + t * c1,
      b2 = s * a2 + t * c2,
      b3 = s * a3 + t * c3,
      b4 = s * a4 + t * c4,
      b5 = s * a5 + t * c5,
      b6 = s * a6 + t * c6,
      b7 = s * a7 + t * c7,
      b8 = s * a8 + t * c8;
    const ch = (b0 - a0) ** 2 + (b1 - a1) ** 2 + (b2 - a2) ** 2 + (b3 - a3) ** 2 + (b4 - a4) ** 2 + (b5 - a5) ** 2 + (b6 - a6) ** 2 + (b7 - a7) ** 2 + (b8 - a8) ** 2;
    a0 = b0;
    a1 = b1;
    a2 = b2;
    a3 = b3;
    a4 = b4;
    a5 = b5;
    a6 = b6;
    a7 = b7;
    a8 = b8;
    if (ch < 1e-26) break;
  }
  R[o] = a0;
  R[o + 1] = a1;
  R[o + 2] = a2;
  R[o + 3] = a3;
  R[o + 4] = a4;
  R[o + 5] = a5;
  R[o + 6] = a6;
  R[o + 7] = a7;
  R[o + 8] = a8;
  return true;
}

const F9 = new Float64Array(9);

/**
 * An element's corner displacements (24, global) turned into its own deformation: d = Rᵀ(X + u) − X, with R the
 * rotation of its middle, written into R (9, row-major). The element's matrix times d is its force in its turned
 * frame. False (ue left as it is, R the identity) when the element is folded over.
 */
export function corotate(fr: ElementFrame, ue: Float64Array, R: Float64Array, o = 0): boolean {
  F9.fill(0);
  F9[0] = F9[4] = F9[8] = 1;
  const g = fr.g;
  for (let a = 0; a < 8; a++) {
    const ux = ue[3 * a],
      uy = ue[3 * a + 1],
      uz = ue[3 * a + 2];
    const gx = g[3 * a],
      gy = g[3 * a + 1],
      gz = g[3 * a + 2];
    F9[0] += ux * gx;
    F9[1] += ux * gy;
    F9[2] += ux * gz;
    F9[3] += uy * gx;
    F9[4] += uy * gy;
    F9[5] += uy * gz;
    F9[6] += uz * gx;
    F9[7] += uz * gy;
    F9[8] += uz * gz;
  }
  if (!polar(F9, R, o)) {
    R.fill(0, o, o + 9);
    R[o] = R[o + 4] = R[o + 8] = 1;
    return false;
  }
  const X = fr.X;
  for (let a = 0; a < 8; a++) {
    const px = X[3 * a] + ue[3 * a],
      py = X[3 * a + 1] + ue[3 * a + 1],
      pz = X[3 * a + 2] + ue[3 * a + 2];
    ue[3 * a] = R[o] * px + R[o + 3] * py + R[o + 6] * pz - X[3 * a];
    ue[3 * a + 1] = R[o + 1] * px + R[o + 4] * py + R[o + 7] * pz - X[3 * a + 1];
    ue[3 * a + 2] = R[o + 2] * px + R[o + 5] * py + R[o + 8] * pz - X[3 * a + 2];
  }
  return true;
}

/**
 * How an element's turn follows its corners: with F = RU, a change δF turns it by ω = (tr U·I − U)⁻¹·Σ g × (Rᵀδu) in
 * its own frame. Writes that inverse (symmetric 3×3) at C[co], from F and R.
 */
function spinMap(F: ArrayLike<number>, R: ArrayLike<number>, ro: number, C: Float64Array, co: number) {
  // U = RᵀF
  const u = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) u[i * 3 + j] = R[ro + i] * F[j] + R[ro + 3 + i] * F[3 + j] + R[ro + 6 + i] * F[6 + j];
  const tr = u[0] + u[4] + u[8];
  // M = tr·I − sym(U)
  const m0 = tr - u[0],
    m4 = tr - u[4],
    m8 = tr - u[8],
    m1 = -(u[1] + u[3]) / 2,
    m2 = -(u[2] + u[6]) / 2,
    m5 = -(u[5] + u[7]) / 2;
  const c0 = m4 * m8 - m5 * m5,
    c1 = m2 * m5 - m1 * m8,
    c2 = m1 * m5 - m2 * m4,
    c4 = m0 * m8 - m2 * m2,
    c5 = m1 * m2 - m0 * m5,
    c8 = m0 * m4 - m1 * m1;
  const det = m0 * c0 + m1 * c1 + m2 * c2;
  if (!(Math.abs(det) > 1e-12)) {
    C.fill(0, co, co + 9);
    C[co] = C[co + 4] = C[co + 8] = 0.5;
    return;
  }
  C[co] = c0 / det;
  C[co + 1] = C[co + 3] = c1 / det;
  C[co + 2] = C[co + 6] = c2 / det;
  C[co + 4] = c4 / det;
  C[co + 5] = C[co + 7] = c5 / det;
  C[co + 8] = c8 / det;
}

/**
 * A symmetric tensor in Voigt order (xx, yy, zz, xy, yz, zx) at T[o], turned by R: T ← R T Rᵀ. shear is 2 for
 * engineering strain (the Voigt entries are twice the tensor's), 1 for stress.
 */
export function turnVoigt(T: Float64Array, o: number, R: ArrayLike<number>, shear: 1 | 2, ro = 0) {
  const k = 1 / shear;
  const m = [T[o], T[o + 3] * k, T[o + 5] * k, T[o + 3] * k, T[o + 1], T[o + 4] * k, T[o + 5] * k, T[o + 4] * k, T[o + 2]];
  // RM, then (RM)Rᵀ
  const t = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) t[i * 3 + j] = R[ro + i * 3] * m[j] + R[ro + i * 3 + 1] * m[3 + j] + R[ro + i * 3 + 2] * m[6 + j];
  const at = (i: number, j: number) => t[i * 3] * R[ro + j * 3] + t[i * 3 + 1] * R[ro + j * 3 + 1] + t[i * 3 + 2] * R[ro + j * 3 + 2];
  T[o] = at(0, 0);
  T[o + 1] = at(1, 1);
  T[o + 2] = at(2, 2);
  T[o + 3] = at(0, 1) * shear;
  T[o + 4] = at(1, 2) * shear;
  T[o + 5] = at(2, 0) * shear;
}

/** How far a rotation turns, radians. */
export function turnAngle(R: ArrayLike<number>, o = 0): number {
  return Math.acos(Math.max(-1, Math.min(1, (R[o] + R[o + 4] + R[o + 8] - 1) / 2)));
}

interface Group {
  K: Float64Array;
  act: Int32Array;
  stiff: Float64Array;
  /** each element's rotation (9), at the last internal-force pass */
  R: Float64Array;
  /** its own corner forces K·d before its stiffness (24), and (tr U·I − U)⁻¹ of its stretch U (9): how its turn follows the corners */
  Q: Float64Array;
  C: Float64Array;
}

function groupsOf(L: Level): Group[] {
  return [{ K: L.K, act: L.act, stiff: L.stiff }, ...L.extra].map((g) => ({
    K: g.K,
    act: g.act,
    stiff: g.stiff,
    R: new Float64Array(9 * g.act.length),
    Q: new Float64Array(24 * g.act.length),
    C: new Float64Array(9 * g.act.length),
  }));
}

function springForce(L: Level, x: Float64Array, y: Float64Array) {
  const S = L.springs;
  if (!S) return;
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

/**
 * The force the parts push back with at displacement u (every dof, held ones too, springs included): each element's
 * matrix times its own deformation, turned back. Keeps each element's rotation and middle stress in the groups.
 */
function internal(L: Level, groups: Group[], fr: ElementFrame, u: Float64Array, out: Float64Array) {
  out.fill(0);
  const ue = new Float64Array(24);
  const q = new Float64Array(24);
  const off = fr.off;
  for (const G of groups) {
    const { K, act, stiff, R, Q, C } = G;
    for (let e = 0; e < act.length; e++) {
      const d0 = 3 * act[e];
      for (let a = 0; a < 8; a++) {
        const o = d0 + off[a];
        ue[3 * a] = u[o];
        ue[3 * a + 1] = u[o + 1];
        ue[3 * a + 2] = u[o + 2];
      }
      const ro = 9 * e;
      corotate(fr, ue, R, ro);
      spinMap(F9, R, ro, C, ro);
      for (let i = 0; i < 24; i++) {
        let s = 0;
        const r = i * 24;
        for (let j = 0; j < 24; j++) s += K[r + j] * ue[j];
        q[i] = s;
        Q[24 * e + i] = s;
      }
      const s = stiff[e];
      for (let a = 0; a < 8; a++) {
        const o = d0 + off[a];
        const qx = q[3 * a],
          qy = q[3 * a + 1],
          qz = q[3 * a + 2];
        out[o] += s * (R[ro] * qx + R[ro + 1] * qy + R[ro + 2] * qz);
        out[o + 1] += s * (R[ro + 3] * qx + R[ro + 4] * qy + R[ro + 5] * qz);
        out[o + 2] += s * (R[ro + 6] * qx + R[ro + 7] * qy + R[ro + 8] * qz);
      }
    }
  }
  springForce(L, u, out);
}

/** The tangent times x: the turned element matrices, the stress stiffening when geo, and the springs; zero on held dofs. */
function tangent(L: Level, groups: Group[], fr: ElementFrame, x: Float64Array, y: Float64Array, spin: boolean) {
  y.fill(0);
  const w = new Float64Array(24);
  const z = new Float64Array(24);
  const off = fr.off;
  const g = fr.g;
  for (const G of groups) {
    const { K, act, stiff, R, Q, C } = G;
    for (let e = 0; e < act.length; e++) {
      const d0 = 3 * act[e];
      const ro = 9 * e;
      for (let a = 0; a < 8; a++) {
        const o = d0 + off[a];
        const px = x[o],
          py = x[o + 1],
          pz = x[o + 2];
        w[3 * a] = R[ro] * px + R[ro + 3] * py + R[ro + 6] * pz;
        w[3 * a + 1] = R[ro + 1] * px + R[ro + 4] * py + R[ro + 7] * pz;
        w[3 * a + 2] = R[ro + 2] * px + R[ro + 5] * py + R[ro + 8] * pz;
      }
      for (let i = 0; i < 24; i++) {
        let s = 0;
        const r = i * 24;
        for (let j = 0; j < 24; j++) s += K[r + j] * w[j];
        z[i] = s;
      }
      const s = stiff[e];
      if (spin) {
        // the element's own forces turn with it: δf_a = R(ω × q_a), ω = C·Σ g_b × w_b; symmetrised with its
        // transpose, −R(g_a × μ), μ = C·Σ q_b × w_b, so conjugate gradients still applies
        const qo = 24 * e,
          co = 9 * e;
        let ox = 0,
          oy = 0,
          oz = 0,
          mx = 0,
          my = 0,
          mz = 0;
        for (let b = 0; b < 8; b++) {
          const wx = w[3 * b],
            wy = w[3 * b + 1],
            wz = w[3 * b + 2];
          const gx = g[3 * b],
            gy = g[3 * b + 1],
            gz = g[3 * b + 2];
          ox += gy * wz - gz * wy;
          oy += gz * wx - gx * wz;
          oz += gx * wy - gy * wx;
          const qx = Q[qo + 3 * b],
            qy = Q[qo + 3 * b + 1],
            qz = Q[qo + 3 * b + 2];
          mx += qy * wz - qz * wy;
          my += qz * wx - qx * wz;
          mz += qx * wy - qy * wx;
        }
        const Wx = C[co] * ox + C[co + 1] * oy + C[co + 2] * oz,
          Wy = C[co + 3] * ox + C[co + 4] * oy + C[co + 5] * oz,
          Wz = C[co + 6] * ox + C[co + 7] * oy + C[co + 8] * oz;
        const Mx = C[co] * mx + C[co + 1] * my + C[co + 2] * mz,
          My = C[co + 3] * mx + C[co + 4] * my + C[co + 5] * mz,
          Mz = C[co + 6] * mx + C[co + 7] * my + C[co + 8] * mz;
        for (let a = 0; a < 8; a++) {
          const qx = Q[qo + 3 * a],
            qy = Q[qo + 3 * a + 1],
            qz = Q[qo + 3 * a + 2];
          const gx = g[3 * a],
            gy = g[3 * a + 1],
            gz = g[3 * a + 2];
          z[3 * a] += 0.5 * (Wy * qz - Wz * qy - (gy * Mz - gz * My));
          z[3 * a + 1] += 0.5 * (Wz * qx - Wx * qz - (gz * Mx - gx * Mz));
          z[3 * a + 2] += 0.5 * (Wx * qy - Wy * qx - (gx * My - gy * Mx));
        }
      }
      for (let a = 0; a < 8; a++) {
        const o = d0 + off[a];
        const zx = z[3 * a],
          zy = z[3 * a + 1],
          zz = z[3 * a + 2];
        y[o] += s * (R[ro] * zx + R[ro + 1] * zy + R[ro + 2] * zz);
        y[o + 1] += s * (R[ro + 3] * zx + R[ro + 4] * zy + R[ro + 5] * zz);
        y[o + 2] += s * (R[ro + 6] * zx + R[ro + 7] * zy + R[ro + 8] * zz);
      }
    }
  }
  springForce(L, x, y);
  const fl = L.fixedList;
  for (let i = 0; i < fl.length; i++) y[fl[i]] = 0;
}

/** Conjugate gradients on the tangent from zero, preconditioned by the linear multigrid. breakdown: it is not positive definite there. */
function cgTangent(H: Hierarchy, op: (x: Float64Array, y: Float64Array) => void, turn: Float64Array | null, b: Float64Array, x: Float64Array, tol: number, maxIter: number): { iterations: number; rel: number; breakdown: boolean } {
  const L = H.levels[0];
  const n = b.length;
  const free = L.free;
  const r = Float64Array.from(b);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  x.fill(0);
  let bn = 0;
  for (let i = 0; i < n; i++) bn += b[i] * b[i];
  bn = Math.sqrt(bn);
  if (bn === 0) return { iterations: 0, rel: 0, breakdown: false };
  // the linear multigrid knows the parts unturned: turn the residual back into each node's unturned frame, apply it,
  // and turn the answer round again (Tᵀ, K₀⁻¹, T), so a strip bent through 45° is preconditioned along its own length
  const t = turn ? new Float64Array(n) : null;
  const pre = () => {
    if (!turn || !t) precondition(H, r, z);
    else {
      for (let k = 0; k < n / 3; k++) {
        const o = 9 * k,
          d = 3 * k;
        const a = r[d],
          b2 = r[d + 1],
          c = r[d + 2];
        t[d] = free[d] ? turn[o] * a + turn[o + 3] * b2 + turn[o + 6] * c : 0;
        t[d + 1] = free[d + 1] ? turn[o + 1] * a + turn[o + 4] * b2 + turn[o + 7] * c : 0;
        t[d + 2] = free[d + 2] ? turn[o + 2] * a + turn[o + 5] * b2 + turn[o + 8] * c : 0;
      }
      precondition(H, t, z);
      for (let k = 0; k < n / 3; k++) {
        const o = 9 * k,
          d = 3 * k;
        const a = z[d],
          b2 = z[d + 1],
          c = z[d + 2];
        z[d] = turn[o] * a + turn[o + 1] * b2 + turn[o + 2] * c;
        z[d + 1] = turn[o + 3] * a + turn[o + 4] * b2 + turn[o + 5] * c;
        z[d + 2] = turn[o + 6] * a + turn[o + 7] * b2 + turn[o + 8] * c;
      }
    }
    for (let i = 0; i < n; i++) if (!free[i]) z[i] = 0;
  };
  pre();
  p.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  let rel = 1;
  let it = 0;
  while (it < maxIter) {
    op(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(pq > 0)) return { iterations: it, rel, breakdown: true };
    const alpha = rz / pq;
    let rr = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * q[i];
      rr += r[i] * r[i];
    }
    it++;
    rel = Math.sqrt(rr) / bn;
    if (rel < tol) break;
    pre();
    let rzNew = 0;
    for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { iterations: it, rel, breakdown: false };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Each node's rotation: the rotations of the elements round it, averaged and made a rotation again. */
function nodeTurns(L: Level, groups: Group[], fr: ElementFrame, out: Float64Array) {
  out.fill(0);
  for (const G of groups)
    for (let e = 0; e < G.act.length; e++) {
      const n0 = G.act[e];
      const ro = 9 * e;
      for (let a = 0; a < 8; a++) {
        const o = 9 * (n0 + fr.off[a] / 3);
        for (let k = 0; k < 9; k++) out[o + k] += G.R[ro + k];
      }
    }
  const M = new Float64Array(9);
  for (let o = 0; o < out.length; o += 9) {
    if (out[o] === 0 && out[o + 4] === 0 && out[o + 8] === 0 && out[o + 1] === 0) {
      out[o] = out[o + 4] = out[o + 8] = 1;
      continue;
    }
    for (let k = 0; k < 9; k++) M[k] = out[o + k];
    if (!polar(M, out, o)) {
      out.fill(0, o, o + 9);
      out[o] = out[o + 4] = out[o + 8] = 1;
    }
  }
}

export interface LargeInput {
  /** the linear multigrid; its fine level is the model, its held dofs the supports */
  H: Hierarchy;
  /** the loads, zero on held dofs */
  f: Float64Array;
  /** the set displacement of held dofs (regions moved a set distance), zero elsewhere; null for none */
  set?: Float64Array | null;
  /** the small-deflection answer, the first step's starting guess */
  guess?: Float64Array;
  /** how many load steps to start with (they shrink and grow as the solve goes) */
  steps?: number;
  /** relative force residual to settle each step to */
  tol?: number;
  /** stop by this time (performance.now()) */
  deadline?: number;
  onProgress?: (reached: number, iteration: number, residual: number) => void;
}

export interface LargeSolve {
  /** the balanced displacements (the held dofs at their set values) */
  u: Float64Array;
  converged: boolean;
  /** the share of the loads balanced, 1 when it got all the way */
  reached: number;
  steps: number;
  newton: number;
  iterations: number;
  residual: number;
  /** the most any element turned, radians */
  turn: number;
  /** why it stopped short */
  why?: string;
}

const MAX_NEWTON = 14;
const MIN_STEP = 1 / 256;

/** The force the parts push back with at u (all dofs, springs included), for reactions. */
export function internalForce(H: Hierarchy, u: Float64Array): Float64Array {
  const L = H.levels[0];
  const out = new Float64Array(u.length);
  internal(L, groupsOf(L), elementFrame(L.dims, L.NX, L.NY), u, out);
  return out;
}

/**
 * How far off the small-deflection answer u is: one Newton step from it on the large-deflection model, and the share
 * by which that changes the work the loads do (or, with only set displacements, the force they take). A part that
 * stiffens as it stretches (a strap or plate held at its edges) shows here even when it hardly turns.
 */
export function largeEffect(H: Hierarchy, f: Float64Array, set: Float64Array | null, u: Float64Array): number {
  const L = H.levels[0];
  const n = u.length;
  const groups = groupsOf(L);
  const fr = elementFrame(L.dims, L.NX, L.NY);
  const fint = new Float64Array(n);
  internal(L, groups, fr, u, fint);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = L.free[i] ? f[i] - fint[i] : 0;
  const turns = new Float64Array(3 * n);
  nodeTurns(L, groups, fr, turns);
  const du = new Float64Array(n);
  const s = cgTangent(H, (x, y) => tangent(L, groups, fr, x, y, true), turns, r, du, 1e-2, 150);
  if (s.breakdown) return Infinity;
  let W = 0,
    dW = 0;
  for (let i = 0; i < n; i++) {
    W += f[i] * u[i];
    dW += f[i] * du[i];
  }
  if (Math.abs(W) > 0) return Math.abs(dW / W);
  if (!set) return 0;
  // only set displacements: the force they take, before and after the step
  const held = L.fixedList;
  let P0 = 0;
  for (let k = 0; k < held.length; k++) P0 += set[held[k]] * fint[held[k]];
  for (let i = 0; i < n; i++) u[i] += du[i];
  internal(L, groups, fr, u, fint);
  for (let i = 0; i < n; i++) u[i] -= du[i];
  let P1 = 0;
  for (let k = 0; k < held.length; k++) P1 += set[held[k]] * fint[held[k]];
  return Math.abs(P0) > 0 ? Math.abs((P1 - P0) / P0) : 0;
}

/** The most any element of the fine level turns at displacement u, radians. */
export function maxTurn(L: Level, u: Float64Array): number {
  const fr = elementFrame(L.dims, L.NX, L.NY);
  const ue = new Float64Array(24);
  const R = new Float64Array(9);
  let most = 0;
  for (const G of [{ act: L.act }, ...L.extra]) {
    for (let e = 0; e < G.act.length; e++) {
      const d0 = 3 * G.act[e];
      for (let a = 0; a < 8; a++) {
        const o = d0 + fr.off[a];
        ue[3 * a] = u[o];
        ue[3 * a + 1] = u[o + 1];
        ue[3 * a + 2] = u[o + 2];
      }
      if (corotate(fr, ue, R)) most = Math.max(most, turnAngle(R));
    }
  }
  return most;
}

export function solveLarge(inp: LargeInput): LargeSolve {
  const H = inp.H;
  const L = H.levels[0];
  const n = inp.f.length;
  const free = L.free;
  const held = L.fixedList;
  const groups = groupsOf(L);
  const fr = elementFrame(L.dims, L.NX, L.NY);
  const tol = inp.tol ?? 1e-5;
  const deadline = inp.deadline ?? Infinity;
  const f = inp.f;
  const set = inp.set ?? null;
  const u = new Float64Array(n);
  const fint = new Float64Array(n);
  const r = new Float64Array(n);
  const du = new Float64Array(n);
  const uConv = new Float64Array(n);
  const uPrev = new Float64Array(n);
  const turns = new Float64Array(3 * n);
  let newton = 0;
  let iterations = 0;
  let late = false;
  const residual = (lam: number): number => {
    internal(L, groups, fr, u, fint);
    let rr = 0,
      ff = 0,
      hh = 0;
    for (let i = 0; i < n; i++) {
      if (free[i]) {
        const load = lam * f[i];
        const v = load - fint[i];
        r[i] = v;
        rr += v * v;
        ff += load * load;
      } else r[i] = 0;
    }
    for (let k = 0; k < held.length; k++) hh += fint[held[k]] ** 2;
    const ref = Math.sqrt(Math.max(ff, hh));
    if (!(ref > 0)) return rr > 0 ? Infinity : 0;
    return Math.sqrt(rr) / ref;
  };
  const op = (spin: boolean) => (x: Float64Array, y: Float64Array) => tangent(L, groups, fr, x, y, spin);
  /** settle the balance at a share of the loads, from the guess in u; how many iterations and whether it settled */
  const settle = (lam: number): { ok: boolean; its: number; rel: number } => {
    if (set) for (let k = 0; k < held.length; k++) u[held[k]] = lam * set[held[k]];
    let rel = residual(lam);
    for (let it = 0; it < MAX_NEWTON; it++) {
      inp.onProgress?.(lam, it, rel);
      if (rel < tol) return { ok: true, its: it, rel };
      if (!Number.isFinite(rel)) return { ok: false, its: it, rel };
      if (now() > deadline) {
        late = true;
        return { ok: false, its: it, rel };
      }
      // solved closely: a loose inner solve leaves the soft (bending) part of the step wrong, and Newton then crawls
      const eta = Math.min(1e-3, Math.max(1e-6, 0.01 * rel));
      nodeTurns(L, groups, fr, turns);
      let s = cgTangent(H, op(true), turns, r, du, eta, 300);
      // compression past where it would buckle makes the stress term indefinite: step on the elastic tangent alone
      if (s.breakdown) s = cgTangent(H, op(false), turns, r, du, eta, 300);
      iterations += s.iterations;
      newton++;
      for (let i = 0; i < n; i++) u[i] += du[i];
      let next = residual(lam);
      // a step that makes it worse is cut back, half at a time
      let alpha = 1;
      for (let back = 0; !(next < rel) && back < 4; back++) {
        alpha /= 2;
        for (let i = 0; i < n; i++) u[i] -= alpha * du[i];
        next = residual(lam);
      }
      if (!(next < rel)) return { ok: false, its: it + 1, rel };
      rel = next;
    }
    inp.onProgress?.(lam, MAX_NEWTON, rel);
    return { ok: rel < tol, its: MAX_NEWTON, rel };
  };

  let lam = 0;
  let dlam = 1 / Math.max(1, Math.round(inp.steps ?? 4));
  let lastDl = 0;
  let steps = 0;
  let rel = 0;
  let why: string | undefined;
  while (lam < 1 - 1e-12) {
    const target = Math.min(1, lam + dlam);
    // the guess: carry on along the last step, or the small-deflection answer for the first
    if (lastDl > 0) {
      const k = (target - lam) / lastDl;
      for (let i = 0; i < n; i++) u[i] = uConv[i] + k * (uConv[i] - uPrev[i]);
    } else if (inp.guess) {
      for (let i = 0; i < n; i++) u[i] = free[i] ? target * inp.guess[i] : 0;
    } else u.fill(0);
    const res = settle(target);
    rel = res.rel;
    if (res.ok) {
      uPrev.set(uConv);
      uConv.set(u);
      lastDl = target - lam;
      lam = target;
      steps++;
      if (res.its <= 4) dlam = Math.min(1, dlam * 1.5);
      continue;
    }
    if (late) {
      why = "it ran out of time";
      break;
    }
    dlam /= 2;
    if (dlam < MIN_STEP) {
      why = "the steps would not settle even when small (the parts may snap through, buckle or come loose there)";
      break;
    }
  }
  u.set(uConv);
  if (set) for (let k = 0; k < held.length; k++) u[held[k]] = lam * set[held[k]];
  let turn = 0;
  internal(L, groups, fr, u, fint);
  for (const G of groups) for (let e = 0; e < G.act.length; e++) turn = Math.max(turn, turnAngle(G.R, 9 * e));
  return { u, converged: lam >= 1 - 1e-12, reached: lam, steps, newton, iterations, residual: rel, turn, ...(why ? { why } : {}) };
}

