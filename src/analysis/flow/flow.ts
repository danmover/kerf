// Steady incompressible flow on the grid: SIMPLEC (Van Doormaal and Raithby 1984) on a staggered grid, velocities on
// the cell faces and pressure at the centres, hybrid differencing for the momentum carried with the flow, LVEL for
// turbulence and wall functions on the walls. Fans push the air in their annulus with the pressure rise their curve
// gives at the flow through them; a set flow is a push across an opening adjusted until that flow goes through;
// warm air rises (Boussinesq) when gravity is on. The surroundings sit at zero pressure: air is drawn in from rest
// and leaves freely.

import * as grid from "./grid";
import type { Grid } from "./grid";
import { Multigrid, newStencil, pcg, type SolveStats, type Stencil } from "./linear";
import * as walls from "./walls";
import type { V3 } from "./types";

// module-level copies of the imported constants and functions: the hot loops read them millions of times, and an
// imported binding costs a call each where the modules are compiled to CommonJS (the tests)
const { AMBIENT, FLUID, SOLID } = grid;
const { lvelNut, wallShearCoeff } = walls;

/** something that pushes the air: a fan on its curve, or a set flow */
export interface Push {
  kind: "fan" | "drive";
  index: number;
  label: string;
  /** the faces it pushes on: axis, face index, and its share of the cell volume times the direction's component on that axis */
  axes: Uint8Array;
  faces: Int32Array;
  weights: Float64Array;
  /** thickness along the push, m, and the cross-section, m² */
  depth: number;
  area: number;
  /** the pressure rise it gives now, Pa, and the flow through it, m³/s */
  rise: number;
  flow: number;
  /** a fan's curve, rise (Pa) against flow (m³/s) */
  curve?: [number, number][];
  /** a set flow, m³/s */
  target?: number;
  cells: Int32Array;
}

/** a fan curve's rise at a flow; flat before shut-off, straight on past free delivery */
export function curveRise(curve: [number, number][], q: number): number {
  if (q <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++)
    if (q <= curve[i][0]) {
      const [q0, p0] = curve[i - 1];
      const [q1, p1] = curve[i];
      return p0 + ((q - q0) / (q1 - q0 || 1)) * (p1 - p0);
    }
  const [q0, p0] = curve[curve.length - 2];
  const [q1, p1] = curve[curve.length - 1];
  return p1 + ((q - q1) / (q1 - q0 || 1)) * (p1 - p0);
}

/** the effective viscosity on an edge between four cells, over the ones that are not solid */
function nuEdge(kind: Uint8Array, nuE: Float64Array, nuMol: number, c0: number, c1: number, n0: number, n1: number): number {
  let s = 0;
  let n = 0;
  if (kind[c0] !== SOLID) {
    s += nuE[c0];
    n++;
  }
  if (kind[c1] !== SOLID) {
    s += nuE[c1];
    n++;
  }
  if (kind[n0] !== SOLID) {
    s += nuE[n0];
    n++;
  }
  if (kind[n1] !== SOLID) {
    s += nuE[n1];
    n++;
  }
  return n ? s / n : nuMol;
}

/** how many of the two cells beside a held neighbour face are solid (a wall on that share of the side) */
const solidsBeside = (kind: Uint8Array, a: number, b: number) => (kind[a] === SOLID ? 1 : 0) + (kind[b] === SOLID ? 1 : 0);

export interface FlowOptions {
  rho: number;
  nu: number;
  /** gravity, m/s², or null */
  gravity: V3 | null;
  beta: number;
  ambient: number;
}

export class FlowSolver {
  readonly g: Grid;
  readonly D: V3;
  readonly U: [Float64Array, Float64Array, Float64Array];
  readonly fixed: [Uint8Array, Uint8Array, Uint8Array];
  readonly dcoef: [Float64Array, Float64Array, Float64Array];
  /** the face dimensions per axis */
  readonly FD: [V3, V3, V3];
  readonly p: Float64Array;
  readonly nuEff: Float64Array;
  /** cell temperatures, °C (buoyancy reads them; the heat solve writes them) */
  readonly T: Float64Array;
  readonly pushes: Push[] = [];
  readonly opt: FlowOptions;
  /** the z-face stride (nx·ny) */
  private readonly sz: number;
  /** the cells below and above each face, per axis */
  readonly lo: [Int32Array, Int32Array, Int32Array];
  readonly up: [Int32Array, Int32Array, Int32Array];
  /** the last mass imbalance, kg/s, summed over the cells */
  imbalance = 0;
  /** the last pressure-correction solve, and the iterations it has taken in all */
  pressureStats: SolveStats = { iterations: 0, reduction: 0 };
  pressureIterations = 0;
  /** each cell's face below it on the x and y axes (on z it is the cell's own index) */
  private fb0: Int32Array;
  private fb1: Int32Array;
  relaxU = 0.7;
  relaxP = 0.9;
  relaxPush = 0.25;
  private M: { aP: Float64Array; aW: Float64Array; aE: Float64Array; aS: Float64Array; aN: Float64Array; aB: Float64Array; aT: Float64Array; b: Float64Array };
  private pc: Stencil;
  private pcx: Float64Array;
  private pcb: Float64Array;
  private mg: Multigrid | null = null;
  /** outer iterations so far */
  iterations = 0;

  constructor(g: Grid, opt: FlowOptions) {
    this.g = g;
    this.opt = opt;
    const { nx, ny, nz } = g;
    this.sz = nx * ny;
    this.D = [nx, ny, nz];
    this.FD = [
      [nx + 1, ny, nz],
      [nx, ny + 1, nz],
      [nx, ny, nz + 1],
    ];
    const count = (a: number) => this.FD[a][0] * this.FD[a][1] * this.FD[a][2];
    this.U = [new Float64Array(count(0)), new Float64Array(count(1)), new Float64Array(count(2))];
    this.fixed = [new Uint8Array(count(0)), new Uint8Array(count(1)), new Uint8Array(count(2))];
    this.dcoef = [new Float64Array(count(0)), new Float64Array(count(1)), new Float64Array(count(2))];
    const N = nx * ny * nz;
    this.fb0 = new Int32Array(N);
    this.fb1 = new Int32Array(N);
    for (let c = 0; c < N; c++) {
      this.fb0[c] = c + Math.floor(c / nx);
      this.fb1[c] = c + nx * Math.floor(c / (nx * ny));
    }
    this.p = new Float64Array(N);
    this.nuEff = new Float64Array(N).fill(opt.nu);
    this.T = new Float64Array(N).fill(opt.ambient);
    const m = Math.max(count(0), count(1), count(2));
    this.M = { aP: new Float64Array(m), aW: new Float64Array(m), aE: new Float64Array(m), aS: new Float64Array(m), aN: new Float64Array(m), aB: new Float64Array(m), aT: new Float64Array(m), b: new Float64Array(m) };
    const links = [this.linkFaces(0), this.linkFaces(1), this.linkFaces(2)];
    this.lo = [links[0][0], links[1][0], links[2][0]];
    this.up = [links[0][1], links[1][1], links[2][1]];
    for (let a = 0; a < 3; a++) this.markFixed(a);
    this.pc = newStencil(nx, ny, nz);
    for (let c = 0; c < N; c++) this.pc.active[c] = g.kind[c] === FLUID ? 1 : 0;
    this.pcx = new Float64Array(N);
    this.pcb = new Float64Array(N);
  }

  /** face index on axis a of the face below cell c (the face above is one face stride further) */
  faceBelow(a: number, c: number): number {
    return a === 0 ? this.fb0[c] : a === 1 ? this.fb1[c] : c;
  }

  faceStride(a: number, along: number): number {
    const F = this.FD[a];
    return along === 0 ? 1 : along === 1 ? F[0] : F[0] * F[1];
  }

  cellStride(along: number): number {
    return along === 0 ? 1 : along === 1 ? this.g.nx : this.g.nx * this.g.ny;
  }

  /** the cells either side of face f on axis a (−1 past the edge) */
  faceCells(a: number, f: number): [number, number] {
    return [this.lo[a][f], this.up[a][f]];
  }

  private linkFaces(a: number): [Int32Array, Int32Array] {
    const F = this.FD[a];
    const D = this.D;
    const n = F[0] * F[1] * F[2];
    const lo = new Int32Array(n);
    const up = new Int32Array(n);
    const cs = this.cellStride(a);
    for (let k = 0; k < F[2]; k++)
      for (let j = 0; j < F[1]; j++)
        for (let i = 0; i < F[0]; i++) {
          const f = i + F[0] * (j + F[1] * k);
          const q = a === 0 ? i : a === 1 ? j : k;
          const ii = Math.min(i, D[0] - 1);
          const jj = Math.min(j, D[1] - 1);
          const kk = Math.min(k, D[2] - 1);
          const c = ii + D[0] * (jj + D[1] * kk);
          up[f] = q < D[a] ? c : -1;
          lo[f] = q > 0 ? (q < D[a] ? c - cs : c) : -1;
        }
    return [lo, up];
  }

  private markFixed(a: number) {
    const fx = this.fixed[a];
    const kind = this.g.kind;
    for (let f = 0; f < fx.length; f++) {
      const [lo, up] = this.faceCells(a, f);
      fx[f] = lo < 0 || up < 0 || kind[lo] === SOLID || kind[up] === SOLID || (kind[lo] === AMBIENT && kind[up] === AMBIENT) ? 1 : 0;
    }
  }

  /** a fan or set flow over the air cells given, pushing along dir */
  addPush(kind: Push["kind"], index: number, label: string, cells: number[], dir: V3, depth: number, area: number, init: { rise: number; curve?: [number, number][]; target?: number }) {
    const w = new Map<number, number>();
    for (const c of cells)
      for (let a = 0; a < 3; a++) {
        if (Math.abs(dir[a]) < 1e-9) continue;
        const f0 = this.faceBelow(a, c);
        const key0 = a * 1e9 + f0;
        const key1 = a * 1e9 + f0 + this.faceStride(a, a);
        w.set(key0, (w.get(key0) ?? 0) + 0.5 * dir[a]);
        w.set(key1, (w.get(key1) ?? 0) + 0.5 * dir[a]);
      }
    const keys = [...w.keys()].filter((key) => !this.fixed[Math.floor(key / 1e9)][key % 1e9]);
    const axes = new Uint8Array(keys.length);
    const faces = new Int32Array(keys.length);
    const weights = new Float64Array(keys.length);
    keys.forEach((key, i) => {
      axes[i] = Math.floor(key / 1e9);
      faces[i] = key % 1e9;
      weights[i] = w.get(key)!;
    });
    this.pushes.push({ kind, index, label, axes, faces, weights, depth, area, rise: init.rise, flow: 0, curve: init.curve, target: init.target, cells: Int32Array.from(cells) });
  }

  /** the flow through a push now, m³/s */
  pushFlow(ps: Push): number {
    const h3 = this.g.h ** 3;
    let s = 0;
    for (let i = 0; i < ps.faces.length; i++) s += this.U[ps.axes[i]][ps.faces[i]] * ps.weights[i];
    return (s * h3) / ps.depth;
  }

  /** LVEL: each air cell's effective viscosity from its speed and its distance from the nearest wall */
  updateTurbulence() {
    const { g } = this;
    const nu = this.opt.nu;
    const N = g.nx * g.ny * g.nz;
    for (let c = 0; c < N; c++) {
      if (g.kind[c] !== FLUID) {
        this.nuEff[c] = nu;
        continue;
      }
      const s = this.cellSpeed(c);
      this.nuEff[c] = nu * (1 + lvelNut((s * g.wall[c]) / nu));
    }
  }

  cellVelocity(c: number): V3 {
    const f0 = this.fb0[c];
    const f1 = this.fb1[c];
    const { nx } = this.g;
    const U = this.U;
    return [0.5 * (U[0][f0] + U[0][f0 + 1]), 0.5 * (U[1][f1] + U[1][f1 + nx]), 0.5 * (U[2][c] + U[2][c + this.sz])];
  }

  /** the speed at a cell's centre, m/s */
  cellSpeed(c: number): number {
    const f0 = this.fb0[c];
    const f1 = this.fb1[c];
    const U = this.U;
    const u = U[0][f0] + U[0][f0 + 1];
    const v = U[1][f1] + U[1][f1 + this.g.nx];
    const w = U[2][c] + U[2][c + this.sz];
    return 0.5 * Math.sqrt(u * u + v * v + w * w);
  }

  /** Assemble and relax axis a's momentum equations, then sweep them. */
  momentum(a: number, sweeps: number) {
    const { g, M, opt } = this;
    const U = this.U;
    const Ua = U[a];
    const fixedA = this.fixed[a];
    const dA = this.dcoef[a];
    const loA = this.lo[a];
    const upA = this.up[a];
    const kind = g.kind;
    const h = g.h;
    const A = h * h;
    const rho = opt.rho;
    const b1 = (a + 1) % 3;
    const b2 = (a + 2) % 3;
    const sa = this.faceStride(a, a);
    const s1 = this.faceStride(a, b1);
    const s2 = this.faceStride(a, b2);
    const c1 = this.cellStride(b1);
    const c2 = this.cellStride(b2);
    const t1 = this.faceStride(b1, b1);
    const t2 = this.faceStride(b2, b2);
    const U1 = U[b1];
    const U2 = U[b2];
    const fbOf = (b: number) => (b === 0 ? this.fb0 : b === 1 ? this.fb1 : null);
    const fbB1 = fbOf(b1);
    const fbB2 = fbOf(b2);
    const nuE = this.nuEff;
    const p = this.p;
    const T = this.T;
    const grav = opt.gravity ? -opt.gravity[a] * rho * opt.beta * h * h * h : 0;
    const Tamb = opt.ambient;
    const relax = this.relaxU;
    const nF = Ua.length;
    const { aP: MP, aE: ME, aW: MW, aN: MN, aS: MS, aT: MT, aB: MB, b: Mb } = M;
    Mb.fill(0, 0, nF);
    for (const ps of this.pushes) {
      const k = (ps.rise / ps.depth) * h * h * h;
      for (let i = 0; i < ps.faces.length; i++) if (ps.axes[i] === a) Mb[ps.faces[i]] += k * ps.weights[i];
    }
    const nuMol = opt.nu;
    for (let f = 0; f < nF; f++) {
      if (fixedA[f]) {
        MP[f] = 1;
        MW[f] = ME[f] = MS[f] = MN[f] = MB[f] = MT[f] = 0;
        Mb[f] = 0;
        dA[f] = 0;
        continue;
      }
      const lo = loA[f];
      const up = upA[f];
      const u = Ua[f];
      // the transverse faces round this face's control volume
      const lo1 = fbB1 ? fbB1[lo] : lo;
      const up1 = fbB1 ? fbB1[up] : up;
      const lo2 = fbB2 ? fbB2[lo] : lo;
      const up2 = fbB2 ? fbB2[up] : up;
      // mass flows through the six sides of the control volume, kg/s, positive along the axes
      const Fe = 0.5 * rho * A * (u + Ua[f + sa]);
      const Fw = 0.5 * rho * A * (Ua[f - sa] + u);
      const Fn = 0.5 * rho * A * (U1[lo1 + t1] + U1[up1 + t1]);
      const Fs = 0.5 * rho * A * (U1[lo1] + U1[up1]);
      const Ft = 0.5 * rho * A * (U2[lo2 + t2] + U2[up2 + t2]);
      const Fb = 0.5 * rho * A * (U2[lo2] + U2[up2]);
      // diffusion conductances, kg/s
      const De = (rho * (kind[up] === SOLID ? nuMol : nuE[up]) * A) / h;
      const Dw = (rho * (kind[lo] === SOLID ? nuMol : nuE[lo]) * A) / h;
      const Dn = (rho * nuEdge(kind, nuE, nuMol, lo, up, lo + c1, up + c1) * A) / h;
      const Ds = (rho * nuEdge(kind, nuE, nuMol, lo, up, lo - c1, up - c1) * A) / h;
      const Dt = (rho * nuEdge(kind, nuE, nuMol, lo, up, lo + c2, up + c2) * A) / h;
      const Db = (rho * nuEdge(kind, nuE, nuMol, lo, up, lo - c2, up - c2) * A) / h;
      let aE = Math.max(-Fe, De - Fe / 2, 0);
      let aW = Math.max(Fw, Dw + Fw / 2, 0);
      let aN = Math.max(-Fn, Dn - Fn / 2, 0);
      let aS = Math.max(Fs, Ds + Fs / 2, 0);
      let aT = Math.max(-Ft, Dt - Ft / 2, 0);
      let aB = Math.max(Fb, Db + Fb / 2, 0);
      // the diagonal: every neighbour's coefficient (one held at zero still pulls this one towards zero) and any net outflow
      let aP = aE + aW + aN + aS + aT + aB + Math.max(0, Fe - Fw + Fn - Fs + Ft - Fb);
      // across the flow, a neighbour held at zero by solids is a wall half a cell away: wall-function shear on that share
      if (fixedA[f + sa]) aE = 0;
      if (fixedA[f - sa]) aW = 0;
      let walls = 0;
      let wallCoef = 0;
      if (fixedA[f + s1]) {
        const n = solidsBeside(kind, lo + c1, up + c1);
        walls += n;
        wallCoef += n * aN;
        aN = 0;
      }
      if (fixedA[f - s1]) {
        const n = solidsBeside(kind, lo - c1, up - c1);
        walls += n;
        wallCoef += n * aS;
        aS = 0;
      }
      if (fixedA[f + s2]) {
        const n = solidsBeside(kind, lo + c2, up + c2);
        walls += n;
        wallCoef += n * aT;
        aT = 0;
      }
      if (fixedA[f - s2]) {
        const n = solidsBeside(kind, lo - c2, up - c2);
        walls += n;
        wallCoef += n * aB;
        aB = 0;
      }
      if (walls) aP += 0.5 * (walls * A * wallShearCoeff(u, h / 2, nuMol, rho) - wallCoef);
      const active = aE + aW + aN + aS + aT + aB;
      if (!(aP > 0)) aP = (rho * nuMol * A) / h;
      let src = Mb[f] + (p[lo] - p[up]) * A;
      if (grav) {
        const tl = kind[lo] === FLUID ? T[lo] : Tamb;
        const tu = kind[up] === FLUID ? T[up] : Tamb;
        src += grav * (0.5 * (tl + tu) - Tamb);
      }
      const aPr = aP / relax;
      src += (aPr - aP) * u;
      MP[f] = aPr;
      ME[f] = aE;
      MW[f] = aW;
      MN[f] = aN;
      MS[f] = aS;
      MT[f] = aT;
      MB[f] = aB;
      Mb[f] = src;
      dA[f] = A / Math.max(aPr - active, 1e-30);
    }
    for (let s = 0; s < sweeps; s++) {
      const back = s % 2 === 1;
      for (let q = 0; q < nF; q++) {
        const f = back ? nF - 1 - q : q;
        if (fixedA[f]) continue;
        Ua[f] = (Mb[f] + ME[f] * Ua[f + sa] + MW[f] * Ua[f - sa] + MN[f] * Ua[f + s1] + MS[f] * Ua[f - s1] + MT[f] * Ua[f + s2] + MB[f] * Ua[f - s2]) / MP[f];
      }
    }
  }

  /** Solve the pressure correction and correct the velocities and pressure. Returns the mass imbalance before, kg/s. */
  correct(opts: { tol: number; maxIter: number }): number {
    const { g, pc } = this;
    const { nx, ny, nz } = g;
    const N = nx * ny * nz;
    const rho = this.opt.rho;
    const A = g.h * g.h;
    const kind = g.kind;
    pc.aP.fill(0);
    pc.aW.fill(0);
    pc.aE.fill(0);
    pc.aS.fill(0);
    pc.aN.fill(0);
    pc.aB.fill(0);
    pc.aT.fill(0);
    const b = this.pcb;
    let imb = 0;
    const sz = this.sz;
    const [U0, U1, U2] = this.U;
    const [F0, F1, F2] = this.fixed;
    const [d0, d1, d2] = this.dcoef;
    const { fb0, fb1 } = this;
    const rA = rho * A;
    for (let c = 0; c < N; c++) {
      if (kind[c] !== FLUID) {
        pc.aP[c] = 1;
        b[c] = 0;
        continue;
      }
      let diag = 0;
      // x faces
      let f0 = fb0[c];
      let f1 = f0 + 1;
      let s = U0[f0] - U0[f1];
      if (!F0[f0]) {
        const k = rA * d0[f0];
        diag += k;
        if (kind[c - 1] === FLUID) pc.aW[c] = k;
      }
      if (!F0[f1]) {
        const k = rA * d0[f1];
        diag += k;
        if (kind[c + 1] === FLUID) pc.aE[c] = k;
      }
      // y faces
      f0 = fb1[c];
      f1 = f0 + nx;
      s += U1[f0] - U1[f1];
      if (!F1[f0]) {
        const k = rA * d1[f0];
        diag += k;
        if (kind[c - nx] === FLUID) pc.aS[c] = k;
      }
      if (!F1[f1]) {
        const k = rA * d1[f1];
        diag += k;
        if (kind[c + nx] === FLUID) pc.aN[c] = k;
      }
      // z faces
      f0 = c;
      f1 = c + sz;
      s += U2[f0] - U2[f1];
      if (!F2[f0]) {
        const k = rA * d2[f0];
        diag += k;
        if (kind[c - sz] === FLUID) pc.aB[c] = k;
      }
      if (!F2[f1]) {
        const k = rA * d2[f1];
        diag += k;
        if (kind[c + sz] === FLUID) pc.aT[c] = k;
      }
      pc.aP[c] = diag > 0 ? diag : 1;
      b[c] = rA * s;
      imb += Math.abs(b[c]);
    }
    // a sealed pocket of air has no level to its pressure: make its corrections add up, and pin one cell lightly
    if (g.pockets.length) {
      const sum = new Float64Array(g.pockets.length);
      const n = new Float64Array(g.pockets.length);
      for (let c = 0; c < N; c++)
        if (kind[c] === FLUID && g.pocket[c] >= 0) {
          sum[g.pocket[c]] += b[c];
          n[g.pocket[c]]++;
        }
      for (let c = 0; c < N; c++) if (kind[c] === FLUID && g.pocket[c] >= 0) b[c] -= sum[g.pocket[c]] / n[g.pocket[c]];
      for (const c of g.pockets) pc.aP[c] *= 1 + 1e-3;
    }
    this.imbalance = imb;
    this.pcx.fill(0);
    // the groups for the multigrid come from the first coefficients (the walls decide them, and those stay put)
    if (!this.mg) this.mg = new Multigrid(pc);
    else this.mg.update();
    this.pressureStats = pcg(pc, b, this.pcx, { tol: opts.tol, maxIter: opts.maxIter, mg: this.mg });
    this.pressureIterations += this.pressureStats.iterations;
    const x = this.pcx;
    for (let a = 0; a < 3; a++) {
      const Ua = this.U[a];
      const fx = this.fixed[a];
      const d = this.dcoef[a];
      const loA = this.lo[a];
      const upA = this.up[a];
      for (let f = 0; f < Ua.length; f++) {
        if (fx[f]) continue;
        const lo = loA[f];
        const up = upA[f];
        Ua[f] += d[f] * ((kind[lo] === FLUID ? x[lo] : 0) - (kind[up] === FLUID ? x[up] : 0));
      }
    }
    for (let c = 0; c < N; c++) if (kind[c] === FLUID) this.p[c] += this.relaxP * x[c];
    return imb;
  }

  /** Move each push towards its curve (a fan) or its set flow (a drive). */
  updatePushes() {
    for (const ps of this.pushes) {
      const q = this.pushFlow(ps);
      ps.flow = q;
      if (ps.curve) ps.rise += this.relaxPush * (curveRise(ps.curve, q) - ps.rise);
      else if (ps.target !== undefined) {
        const t = ps.target;
        if (q <= 1e-12) ps.rise = Math.max(ps.rise * 1.3, 1e-3);
        else {
          const ratio = Math.min(2, Math.max(0.5, (t / q) ** 1.6));
          ps.rise += this.relaxPush * (ps.rise * ratio - ps.rise);
        }
      }
    }
  }

  /** One outer iteration. Returns the mass imbalance, kg/s. */
  iterate(opts: { sweeps?: number; pTol?: number; pIter?: number } = {}): number {
    this.iterations++;
    for (let a = 0; a < 3; a++) this.momentum(a, opts.sweeps ?? 2);
    const imb = this.correct({ tol: opts.pTol ?? 0.05, maxIter: opts.pIter ?? 40 });
    this.updatePushes();
    return imb;
  }

  /** The largest speed in the air, m/s. */
  maxSpeed(): number {
    let m = 0;
    const N = this.g.nx * this.g.ny * this.g.nz;
    for (let c = 0; c < N; c++) if (this.g.kind[c] === FLUID) m = Math.max(m, this.cellSpeed(c));
    return m;
  }
}
