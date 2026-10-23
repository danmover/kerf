// The airflow solver on the CPU: the reference the GPU kernels are checked
// against, and the fallback where WebGPU is missing. One step is a fused pull
// stream and collide from lattice A into lattice B:
//
// - populations arrive from the neighbour they left; a link that starts in a
//   solid cell is a wall link and is filled by interpolated bounce-back
//   (Bouzidi), carrying the wall's own motion (spinning wheels, the road);
// - next to walls, an explicit log-law wall model slips the wall so the
//   bounce-back passes on the shear stress of a turbulent boundary layer the
//   cells are too coarse to resolve;
// - collision is regularised BGK with a Smagorinsky eddy viscosity worked
//   out from the non-equilibrium stress (LES), with a sponge before the
//   outlet so eddies leave without reflecting;
// - geometry thinner than a cell drags the air through a quadratic law;
// - the force each wall link passes to the body is summed per boundary
//   record by momentum exchange (Galilean invariant form, for moving walls).
//
// Populations are stored shifted by their weights (f − w), which keeps the
// small differences that carry the flow when the GPU stores them as 16-bit
// floats. The CPU stores 32-bit floats, a cell's 19 together (the GPU keeps
// each direction together instead: populations() gives them in that order).

import { CX, CY, CZ, FARFIELD, INDEX_SHIFT, KAPPA, OPP, Q, SGS_FLOOR, SGS_STRAIN, SLIP_GAIN, SLIP_RATE, SOLID, SUBGRID_CD, TYPE_MASK, VAN_DRIEST, W, WW_A, WW_B, WW_YPLUS } from "./lattice";
import { cellCount, coarseDims, FIELD_AVG, REC_AVG, startAt, type LbmCase } from "./case";

// typed copies of the lattice for the hot loops
const cX = Int32Array.from(CX);
const cY = Int32Array.from(CY);
const cZ = Int32Array.from(CZ);
const wQ = Float64Array.from(W);

export class CpuLbm {
  readonly N: number;
  A: Float32Array;
  B: Float32Array;
  /** instantaneous force per record from the last step, lattice units */
  readonly recForce: Float32Array;
  /** sums over the averaged steps, REC_AVG per record */
  readonly recAvg: Float32Array;
  /** the wall model's slip velocity at each record, followed from step to step */
  readonly recSlip: Float32Array;
  /** sums over the averaged field samples, FIELD_AVG per coarse cell */
  readonly field: Float32Array;
  avgSteps = 0;
  fieldSamples = 0;
  steps = 0;
  /** free-stream velocity held at the far field (it may be changed between steps) */
  u: [number, number, number];

  /** shared: lattices and record arrays from another instance (a thread working on the same case); it starts nothing */
  constructor(
    readonly c: LbmCase,
    shared?: { A: Float32Array; B: Float32Array; recForce: Float32Array; recAvg: Float32Array; recSlip: Float32Array; field: Float32Array },
  ) {
    this.N = cellCount(c);
    const [cx, cy, cz] = coarseDims(c);
    this.u = [...c.u];
    if (shared) {
      this.A = shared.A;
      this.B = shared.B;
      this.recForce = shared.recForce;
      this.recAvg = shared.recAvg;
      this.recSlip = shared.recSlip;
      this.field = shared.field;
      return;
    }
    this.A = new Float32Array(Q * this.N);
    this.B = new Float32Array(Q * this.N);
    this.recForce = new Float32Array(c.rec.count * 3);
    this.recAvg = new Float32Array(c.rec.count * REC_AVG);
    this.recSlip = new Float32Array(c.rec.count * 3);
    this.field = new Float32Array(cx * cy * cz * FIELD_AVG);
    this.init();
  }

  /** Every cell that is not solid starts at the equilibrium of the free stream, or of the start field when there is one. */
  init() {
    const { N, A } = this;
    const { nx, ny, start } = this.c;
    const fe = new Float64Array(Q);
    const s = new Float64Array(4);
    equilibrium(0, this.u[0], this.u[1], this.u[2], fe);
    for (let n = 0; n < N; n++) {
      const solid = (this.c.flags[n] & TYPE_MASK) === SOLID;
      if (start && !solid) {
        startAt(start, n % nx, Math.floor(n / nx) % ny, Math.floor(n / (nx * ny)), s);
        equilibrium(s[3], s[0], s[1], s[2], fe);
      }
      for (let i = 0; i < Q; i++) A[n * Q + i] = solid ? 0 : fe[i];
    }
    this.B.set(A);
  }

  resetAverages() {
    this.recAvg.fill(0);
    this.field.fill(0);
    this.avgSteps = 0;
    this.fieldSamples = 0;
  }

  /**
   * Advance one step. average: add this step's wall forces and near-wall flow to the record sums. A range of z planes
   * updates only those (threads that share the lattices each take a slab, then all swap).
   */
  step(average = false, z0 = 0, z1 = this.c.nz) {
    const c = this.c;
    const { nx, ny, nz, flags, rec, parts } = c;
    const N = this.N;
    const A = this.A;
    const B = this.B;
    const [px, py, pz] = c.periodic;
    const f = new Float64Array(Q);
    const fe = new Float64Array(Q);
    const fneq = new Float64Array(Q);
    const ge = new Float64Array(Q);
    const wall = new Uint8Array(Q);
    const wq = new Float64Array(Q);
    const wsolid = new Int32Array(Q);
    const uwx = new Float64Array(Q),
      uwy = new Float64Array(Q),
      uwz = new Float64Array(Q);
    const ffar = new Float64Array(Q);
    equilibrium(0, this.u[0], this.u[1], this.u[2], ffar);
    const wrapY = (y: number) => (py ? (y + ny) % ny : y < 0 ? 0 : y >= ny ? ny - 1 : y);
    const wrapZ = (z: number) => (pz ? (z + nz) % nz : z < 0 ? 0 : z >= nz ? nz - 1 : z);
    const clampX = (x: number) => (px ? (x + nx) % nx : x < 0 ? 0 : x >= nx ? nx - 1 : x);
    const tau0 = c.tau0;
    const cs2x18 = 18 * c.cs * c.cs;
    const spongeLen = Math.max(1, nx - 1 - c.spongeX);
    const nu0 = (tau0 - 0.5) / 3;
    const off = new Int32Array(Q);
    for (let i = 0; i < Q; i++) off[i] = cX[i] + nx * (cY[i] + ny * cZ[i]);

    for (let z = z0; z < z1; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const n = x + nx * (y + ny * z);
          const fl = flags[n];
          const type = fl & TYPE_MASK;
          if (type === SOLID) continue;
          if (type === FARFIELD) {
            const e = fl >>> INDEX_SHIFT;
            if (e && c.far) {
              const o = 4 * (e - 1);
              equilibrium(c.far[o + 3], c.far[o], c.far[o + 1], c.far[o + 2], ge);
              for (let i = 0; i < Q; i++) B[n * Q + i] = ge[i];
            } else for (let i = 0; i < Q; i++) B[n * Q + i] = ffar[i];
            continue;
          }
          const r = (fl >>> INDEX_SHIFT) - 1;
          // ---- stream: pull from the neighbours ----
          let nWall = 0;
          const inside = x > 0 && x < nx - 1 && y > 0 && y < ny - 1 && z > 0 && z < nz - 1;
          for (let i = 0; i < Q; i++) {
            const s = inside ? n - off[i] : clampX(x - cX[i]) + nx * (wrapY(y - cY[i]) + ny * wrapZ(z - cZ[i]));
            const sf = flags[s];
            if ((sf & TYPE_MASK) === SOLID) {
              wall[i] = 1;
              wsolid[i] = sf >>> INDEX_SHIFT;
              nWall++;
            } else {
              wall[i] = 0;
              f[i] = A[s * Q + i];
            }
          }
          // ---- walls: interpolated bounce-back, moving with the body ----
          if (nWall) {
            for (let i = 1; i < Q; i++) {
              if (!wall[i]) continue;
              let q = r >= 0 ? rec.q[r * 18 + i - 1] : 0.5;
              if (!(q > 0)) q = 0.5;
              wq[i] = q;
              const m = parts[wsolid[i]];
              // the wall point, where the link crosses the surface
              let ux = 0,
                uy = 0,
                uz = 0;
              if (m) {
                const rx = x - q * CX[i] - m.c[0],
                  ry = y - q * CY[i] - m.c[1],
                  rz = z - q * CZ[i] - m.c[2];
                ux = m.v[0] + m.w[1] * rz - m.w[2] * ry;
                uy = m.v[1] + m.w[2] * rx - m.w[0] * rz;
                uz = m.v[2] + m.w[0] * ry - m.w[1] * rx;
              }
              uwx[i] = ux;
              uwy[i] = uy;
              uwz[i] = uz;
              f[i] = bounce(A, N, n, i, q, x, y, z, ux, uy, uz, flags, nx, ny, clampX, wrapY, wrapZ);
            }
          }
          // ---- moments ----
          let drho = 0,
            jx = 0,
            jy = 0,
            jz = 0;
          for (let i = 0; i < Q; i++) {
            const v = f[i];
            drho += v;
            jx += cX[i] * v;
            jy += cY[i] * v;
            jz += cZ[i] * v;
          }
          let rho = 1 + drho;
          let ux = jx / rho,
            uy = jy / rho,
            uz = jz / rho;
          let t0 = tau0;
          if (!px && x > c.spongeX) {
            const s = (x - c.spongeX) / spongeLen;
            t0 = tau0 + (c.spongeTau - tau0) * s * s;
          }
          let tau = relaxation(f, fe, fneq, drho, rho, ux, uy, uz, t0, cs2x18, nWall === 0);
          // ---- wall model: slip the wall so it passes on the log-law shear stress ----
          if (nWall && c.wallModel && r >= 0 && rec.dist[r] > 0) {
            const d = rec.dist[r];
            const nxw = rec.nrm[3 * r],
              nyw = rec.nrm[3 * r + 1],
              nzw = rec.nrm[3 * r + 2];
            const m = parts[rec.part[r]];
            let bx = 0,
              by = 0,
              bz = 0;
            if (m) {
              const rx = x - d * nxw - m.c[0],
                ry = y - d * nyw - m.c[1],
                rz = z - d * nzw - m.c[2];
              bx = m.v[0] + m.w[1] * rz - m.w[2] * ry;
              by = m.v[1] + m.w[2] * rx - m.w[0] * rz;
              bz = m.v[2] + m.w[0] * ry - m.w[1] * rx;
            }
            const vx = ux - bx,
              vy = uy - by,
              vz = uz - bz;
            const vn = vx * nxw + vy * nyw + vz * nzw;
            const tx = vx - vn * nxw,
              ty = vy - vn * nyw,
              tz = vz - vn * nzw;
            const ut = Math.hypot(tx, ty, tz);
            if (ut > 1e-9) {
              // friction velocity from the wall law, and the eddy viscosity a mixing length gives next to the wall
              const utau = frictionVelocity(ut, d, nu0);
              const dv = 1 - Math.exp(-(d * utau) / nu0 / VAN_DRIEST);
              const tw = 0.5 + 3 * (nu0 + KAPPA * utau * d * dv * dv);
              if (tw > t0) t0 = tw;
              const nue = (Math.max(tau, t0) - 0.5) / 3;
              const slip = Math.max(0, ut - (utau * utau * d) / nue) / ut;
              // the wall's slip follows its target over a few steps: applied at once, it feeds back into the
              // velocity it is worked out from and grows without bound next to cells with many wall links
              const ws = this.recSlip;
              const sx = (ws[3 * r] += SLIP_RATE * (tx * slip - ws[3 * r])),
                sy = (ws[3 * r + 1] += SLIP_RATE * (ty * slip - ws[3 * r + 1])),
                sz = (ws[3 * r + 2] += SLIP_RATE * (tz * slip - ws[3 * r + 2]));
              const s2 = sx * sx + sy * sy + sz * sz;
              let gain = 0;
              for (let i = 1; i < Q; i++) {
                if (!wall[i]) continue;
                const cs = CX[i] * sx + CY[i] * sy + CZ[i] * sz;
                gain += (6 * W[i] * cs * cs) / (wq[i] < 0.5 ? 1 : 2 * wq[i]);
              }
              const back = s2 > 0 && gain > SLIP_GAIN * s2 ? (SLIP_GAIN * s2) / gain : 1;
              for (let i = 1; i < Q; i++) {
                if (!wall[i]) continue;
                const k = (wq[i] < 0.5 ? 1 : 1 / (2 * wq[i])) * back;
                f[i] += 6 * W[i] * (CX[i] * sx + CY[i] * sy + CZ[i] * sz) * k;
              }
              drho = 0;
              jx = jy = jz = 0;
              for (let i = 0; i < Q; i++) {
                drho += f[i];
                jx += CX[i] * f[i];
                jy += CY[i] * f[i];
                jz += CZ[i] * f[i];
              }
              rho = 1 + drho;
              ux = jx / rho;
              uy = jy / rho;
              uz = jz / rho;
              tau = relaxation(f, fe, fneq, drho, rho, ux, uy, uz, t0, cs2x18, false);
            }
          }
          // ---- force on the body: momentum exchange over the wall links ----
          let Fx = 0,
            Fy = 0,
            Fz = 0;
          if (nWall) {
            for (let i = 1; i < Q; i++) {
              if (!wall[i]) continue;
              const a = A[n * Q + OPP[i]];
              const s = a + f[i];
              const dd = a - f[i];
              Fx -= CX[i] * s + uwx[i] * dd;
              Fy -= CY[i] * s + uwy[i] * dd;
              Fz -= CZ[i] * s + uwz[i] * dd;
            }
          }
          // ---- collide: regularised BGK; fe holds the equilibrium and fneq the regularised non-equilibrium part ----
          const keep = 1 - 1 / tau;
          // ---- geometry thinner than a cell: quadratic drag, solved implicitly so it cannot overshoot ----
          let gx = ux,
            gy = uy,
            gz = uz;
          if (r >= 0 && !nWall && rec.phi[r] > 0) {
            const m = parts[rec.part[r]];
            let bx = 0,
              by = 0,
              bz = 0;
            if (m) {
              const rx = x - m.c[0],
                ry = y - m.c[1],
                rz = z - m.c[2];
              bx = m.v[0] + m.w[1] * rz - m.w[2] * ry;
              by = m.v[1] + m.w[2] * rx - m.w[0] * rz;
              bz = m.v[2] + m.w[0] * ry - m.w[1] * rx;
            }
            const K = SUBGRID_CD * Math.sqrt(rec.phi[r] / Math.PI);
            const vx = ux - bx,
              vy = uy - by,
              vz = uz - bz;
            const k = 1 / (1 + K * Math.hypot(vx, vy, vz));
            gx = bx + vx * k;
            gy = by + vy * k;
            gz = bz + vz * k;
            Fx += rho * (ux - gx);
            Fy += rho * (uy - gy);
            Fz += rho * (uz - gz);
          }
          if (gx !== ux || gy !== uy || gz !== uz) {
            // the drag changes the velocity the populations relax to (exact difference method)
            equilibrium(drho, gx, gy, gz, ge, rho);
            for (let i = 0; i < Q; i++) B[n * Q + i] = ge[i] + keep * fneq[i];
          } else for (let i = 0; i < Q; i++) B[n * Q + i] = fe[i] + keep * fneq[i];
          if (r >= 0) {
            this.recForce[3 * r] = Fx;
            this.recForce[3 * r + 1] = Fy;
            this.recForce[3 * r + 2] = Fz;
            if (average) {
              const o = r * REC_AVG;
              const ra = this.recAvg;
              ra[o] += Fx;
              ra[o + 1] += Fy;
              ra[o + 2] += Fz;
              ra[o + 3] += drho;
              ra[o + 4] += ux;
              ra[o + 5] += uy;
              ra[o + 6] += uz;
            }
          }
        }
    if (average) this.avgSteps++;
    this.A = B;
    this.B = A;
    this.steps++;
  }

  /** Add the current flow to the averaged field (every few steps while averaging); threads each take a range of block planes. */
  sampleField(Z0 = 0, Z1 = Infinity) {
    const c = this.c;
    const { nx, ny, nz, flags } = c;
    const k = c.coarse;
    const [cx, cy] = coarseDims(c);
    const A = this.A;
    const F = this.field;
    for (let Z = Z0; Z * k < nz && Z < Z1; Z++)
      for (let Y = 0; Y * k < ny; Y++)
        for (let X = 0; X * k < nx; X++) {
          let cnt = 0,
            su = 0,
            sv = 0,
            sw = 0,
            sr = 0,
            sq = 0;
          for (let dz = 0; dz < k; dz++)
            for (let dy = 0; dy < k; dy++)
              for (let dx = 0; dx < k; dx++) {
                const x = X * k + dx,
                  y = Y * k + dy,
                  z = Z * k + dz;
                if (x >= nx || y >= ny || z >= nz) continue;
                const n = x + nx * (y + ny * z);
                if ((flags[n] & TYPE_MASK) === SOLID) continue;
                let d = 0,
                  jx = 0,
                  jy = 0,
                  jz = 0;
                for (let i = 0; i < Q; i++) {
                  const v = A[n * Q + i];
                  d += v;
                  jx += CX[i] * v;
                  jy += CY[i] * v;
                  jz += CZ[i] * v;
                }
                const rho = 1 + d;
                const u = jx / rho,
                  v = jy / rho,
                  w = jz / rho;
                cnt++;
                su += u;
                sv += v;
                sw += w;
                sr += d;
                sq += u * u + v * v + w * w;
              }
          if (!cnt) continue;
          const o = (X + cx * (Y + cy * Z)) * FIELD_AVG;
          F[o] += su / cnt;
          F[o + 1] += sv / cnt;
          F[o + 2] += sw / cnt;
          F[o + 3] += sr / cnt;
          F[o + 4] += sq / cnt;
          F[o + 5] += 1;
        }
    this.fieldSamples++;
  }

  /** The instantaneous flow on the coarse grid (FIELD_AVG per block, one sample), leaving the averages as they were. */
  snapshot(): Float32Array {
    const keep = this.field.slice();
    const n = this.fieldSamples;
    this.field.fill(0);
    this.sampleField();
    const out = this.field.slice();
    this.field.set(keep);
    this.fieldSamples = n;
    return out;
  }

  /** Instantaneous force on each part, lattice units (3 per part). */
  partForces(): Float64Array {
    const { rec, parts } = this.c;
    const out = new Float64Array(parts.length * 3);
    for (let r = 0; r < rec.count; r++) {
      const p = rec.part[r];
      out[3 * p] += this.recForce[3 * r];
      out[3 * p + 1] += this.recForce[3 * r + 1];
      out[3 * p + 2] += this.recForce[3 * r + 2];
    }
    return out;
  }

  /** Populations direction by direction (Q × N), the order the GPU solver keeps them in. */
  populations(): Float32Array {
    const out = new Float32Array(Q * this.N);
    for (let n = 0; n < this.N; n++) for (let i = 0; i < Q; i++) out[i * this.N + n] = this.A[n * Q + i];
    return out;
  }

  /** Velocity and density change of one cell (for tests and probes). */
  cell(x: number, y: number, z: number): { drho: number; u: [number, number, number] } {
    const { nx, ny } = this.c;
    const n = x + nx * (y + ny * z);
    let d = 0,
      jx = 0,
      jy = 0,
      jz = 0;
    for (let i = 0; i < Q; i++) {
      const v = this.A[n * Q + i];
      d += v;
      jx += CX[i] * v;
      jy += CY[i] * v;
      jz += CZ[i] * v;
    }
    const rho = 1 + d;
    return { drho: d, u: [jx / rho, jy / rho, jz / rho] };
  }
}

/** Shifted equilibrium f_eq − w for a density change and a velocity (rho = 1 + drho unless given). */
export function equilibrium(drho: number, ux: number, uy: number, uz: number, out: Float64Array, rho = 1 + drho) {
  const u2 = 1.5 * (ux * ux + uy * uy + uz * uz);
  for (let i = 0; i < Q; i++) {
    const cu = cX[i] * ux + cY[i] * uy + cZ[i] * uz;
    out[i] = wQ[i] * (drho + rho * (3 * cu + 4.5 * cu * cu - u2));
  }
}

/**
 * Equilibrium into fe, regularised non-equilibrium (the part of f − feq its stress tensor carries) into fneq, and the
 * relaxation time with the Smagorinsky eddy viscosity that stress implies. Written out for D3Q19's opposite pairs,
 * the same way the GPU kernel does it.
 */
function relaxation(f: Float64Array, fe: Float64Array, fneq: Float64Array, drho: number, rho: number, ux: number, uy: number, uz: number, t0: number, cs2x18: number, sensed: boolean): number {
  const w0 = 1 / 3,
    w1 = 1 / 18,
    w2 = 1 / 36;
  const u2 = 1.5 * (ux * ux + uy * uy + uz * uz);
  const base = drho - rho * u2;
  const r45 = 4.5 * rho;
  const r3 = 3 * rho;
  fe[0] = w0 * base;
  const sx = pair(f, fe, 1, w1, ux, base, r45, r3),
    sy = pair(f, fe, 3, w1, uy, base, r45, r3),
    sz = pair(f, fe, 5, w1, uz, base, r45, r3),
    sxy = pair(f, fe, 7, w2, ux + uy, base, r45, r3),
    sxz = pair(f, fe, 9, w2, ux + uz, base, r45, r3),
    syz = pair(f, fe, 11, w2, uy + uz, base, r45, r3),
    sxmy = pair(f, fe, 13, w2, ux - uy, base, r45, r3),
    sxmz = pair(f, fe, 15, w2, ux - uz, base, r45, r3),
    symz = pair(f, fe, 17, w2, uy - uz, base, r45, r3);
  const pxx = sx + sxy + sxz + sxmy + sxmz;
  const pyy = sy + sxy + syz + sxmy + symz;
  const pzz = sz + sxz + syz + sxmz + symz;
  const pxy = sxy - sxmy;
  const pxz = sxz - sxmz;
  const pyz = syz - symz;
  const tr = (pxx + pyy + pzz) / 3;
  const a1 = 4.5 * w1,
    a2 = 4.5 * w2;
  fneq[0] = -4.5 * w0 * tr;
  fneq[1] = fneq[2] = a1 * (pxx - tr);
  fneq[3] = fneq[4] = a1 * (pyy - tr);
  fneq[5] = fneq[6] = a1 * (pzz - tr);
  fneq[7] = fneq[8] = a2 * (pxx + pyy + 2 * pxy - tr);
  fneq[9] = fneq[10] = a2 * (pxx + pzz + 2 * pxz - tr);
  fneq[11] = fneq[12] = a2 * (pyy + pzz + 2 * pyz - tr);
  fneq[13] = fneq[14] = a2 * (pxx + pyy - 2 * pxy - tr);
  fneq[15] = fneq[16] = a2 * (pxx + pzz - 2 * pxz - tr);
  fneq[17] = fneq[18] = a2 * (pyy + pzz - 2 * pyz - tr);
  const P = Math.sqrt(2 * (pxx * pxx + pyy * pyy + pzz * pzz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz)));
  // away from walls: how three-dimensional the strain is (the stress tensor's shape is the strain's), none in a
  // laminar shear
  let sgs = cs2x18;
  if (sensed) {
    const dx = pxx - tr,
      dy = pyy - tr,
      dz = pzz - tr;
    const q = 0.5 * (dx * dx + dy * dy + dz * dz + 2 * (pxy * pxy + pxz * pxz + pyz * pyz));
    if (q > 1e-30) {
      const det = dx * (dy * dz - pyz * pyz) - pxy * (pxy * dz - pyz * pxz) + pxz * (pxy * pyz - dy * pxz);
      sgs *= Math.min(1, Math.max(SGS_FLOOR, det / (q * Math.sqrt(q)) / SGS_STRAIN));
    }
  }
  return 0.5 * (t0 + Math.sqrt(t0 * t0 + (sgs * P) / rho));
}

/** Equilibrium of one opposite pair (c·u = ±a) into fe, and the pair's summed non-equilibrium part. */
function pair(f: Float64Array, fe: Float64Array, k: number, w: number, a: number, base: number, r45: number, r3: number): number {
  const sym = w * (base + r45 * a * a);
  const asym = w * r3 * a;
  fe[k] = sym + asym;
  fe[k + 1] = sym - asym;
  return f[k] - fe[k] + f[k + 1] - fe[k + 1];
}

/**
 * Friction velocity uτ of a boundary layer whose tangential velocity is ut at distance d from the wall: the linear
 * sublayer, or the power-law fit of the log law above it (Werner and Wengle). The wall model then slips the wall by
 * ut − uτ²·d/ν so the bounce-back passes on the wall stress ρuτ².
 */
export function frictionVelocity(ut: number, d: number, nu: number): number {
  const lin = Math.sqrt((nu * ut) / d);
  if ((d * lin) / nu <= WW_YPLUS) return lin;
  return Math.pow(ut / (WW_A * Math.pow(d / nu, WW_B)), 1 / (1 + WW_B));
}

/** Interpolated bounce-back (Bouzidi, linear) of population i at cell n, with the wall moving at (ux, uy, uz). */
function bounce(
  A: Float32Array,
  N: number,
  n: number,
  i: number,
  q: number,
  x: number,
  y: number,
  z: number,
  ux: number,
  uy: number,
  uz: number,
  flags: Uint32Array,
  nx: number,
  ny: number,
  clampX: (x: number) => number,
  wrapY: (y: number) => number,
  wrapZ: (z: number) => number,
): number {
  const io = OPP[i];
  const a = A[n * Q + io];
  const du = 6 * W[i] * (CX[i] * ux + CY[i] * uy + CZ[i] * uz);
  if (q < 0.5) {
    const s = clampX(x + CX[i]) + nx * (wrapY(y + CY[i]) + ny * wrapZ(z + CZ[i]));
    if ((flags[s] & TYPE_MASK) === SOLID) return a + du;
    return 2 * q * a + (1 - 2 * q) * A[s * Q + io] + du;
  }
  return (a + (2 * q - 1) * A[n * Q + i] + du) / (2 * q);
}
