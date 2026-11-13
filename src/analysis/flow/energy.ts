// The temperatures: steady heat through the parts and the air together (conjugate heat transfer). Solids conduct;
// the air conducts (more where it is turbulent) and carries heat with it (upwind); where air meets a wall the
// thermal wall function gives the film coefficient, in series with half a cell of the solid. Heat is made inside the
// parts that make it; outer surfaces radiate to the surroundings by what share of them they see. The surroundings and
// the air drawn in from them are at the ambient temperature.

import * as grid from "./grid";
import type { Grid } from "./grid";
import { bicgstab, Multigrid, newStencil, type SolveStats, type Stencil } from "./linear";
import type { FlowSolver } from "./flow";
import * as walls from "./walls";
import type { FlowFluid } from "./types";

// module-level copies of the imported constants and functions: the hot loops read them millions of times, and an
// imported binding costs a call each where the modules are compiled to CommonJS (the tests)
const { AMBIENT, FLUID, SOLID } = grid;
const { PR_T, wallFilm } = walls;

const SIGMA = 5.670374e-8;
/** outside a part that touches the edge of the grid: still air and radiation */
const OUTSIDE_FILM = 10;

export interface HeatBalance {
  /** made inside the parts, carried off by the air (through the surroundings' layer), radiated, W */
  made: number;
  air: number;
  radiated: number;
}

export class HeatSolver {
  readonly g: Grid;
  readonly T: Float64Array;
  readonly q: Float64Array;
  readonly kCell: Float64Array;
  readonly emis: Float64Array;
  /** per solid cell and side (6 per cell): the share of the surroundings it sees, 0..1 (radiation) */
  readonly view: Float32Array;
  private A: Stencil;
  private b: Float64Array;
  private mg: Multigrid | null = null;
  /** the flow iteration the multigrid's groups were made for (the air's flow decides which cells are tied strongly) */
  private mgFor = -1;
  readonly fluid: FlowFluid;
  readonly ambient: number;
  readonly pr: number;

  constructor(g: Grid, fluid: FlowFluid, ambient: number) {
    this.g = g;
    this.fluid = fluid;
    this.ambient = ambient;
    this.pr = (fluid.rho * fluid.cp * fluid.nu) / fluid.k;
    const N = g.nx * g.ny * g.nz;
    this.T = new Float64Array(N).fill(ambient);
    this.q = new Float64Array(N);
    this.kCell = new Float64Array(N);
    this.emis = new Float64Array(N);
    for (let c = 0; c < N; c++) {
      const b = g.body[c];
      if (b >= 0) {
        this.kCell[c] = g.bodies[b].k;
        this.emis[c] = g.bodies[b].emissivity;
      }
    }
    this.view = new Float32Array(N * 6);
    this.A = newStencil(g.nx, g.ny, g.nz);
    for (let c = 0; c < N; c++) this.A.active[c] = g.kind[c] === AMBIENT ? 0 : 1;
    this.b = new Float64Array(N);
  }

  /** Spread each body's heat through its cells; a body too small for the grid puts its heat in the cell it sits in. */
  placeHeat(centres: (number | null)[]): string[] {
    const { g } = this;
    const warn: string[] = [];
    this.q.fill(0);
    const N = g.nx * g.ny * g.nz;
    g.bodies.forEach((b, bi) => {
      if (!(b.watts > 0)) return;
      const n = g.bodyCells[bi];
      if (n > 0) {
        const each = b.watts / n;
        for (let c = 0; c < N; c++) if (g.body[c] === bi) this.q[c] += each;
      } else {
        const c = centres[bi];
        if (c !== null && c >= 0 && g.kind[c] !== AMBIENT) {
          this.q[c] += b.watts;
          warn.push(`${b.name} is smaller than a cell, so its ${b.watts.toFixed(2)} W goes into the cell it sits in.`);
        } else warn.push(`${b.name} is outside the grid; its ${b.watts.toFixed(2)} W is left out.`);
      }
    });
    return warn;
  }

  /**
   * How much of the surroundings each exposed solid face sees: cosine-weighted rays from the face's middle, each one
   * that leaves the grid without meeting a solid counts. Inside a closed box it is about nothing; on an open outside face about all.
   */
  computeViews(rays = 12) {
    const { g } = this;
    const { nx, ny, nz } = g;
    const N = nx * ny * nz;
    const sxy = nx * ny;
    // cosine-weighted directions on the +z hemisphere (a Fibonacci spiral over the disc)
    const dirs: [number, number, number][] = [];
    for (let i = 0; i < rays; i++) {
      const r = Math.sqrt((i + 0.5) / rays);
      const t = i * Math.PI * (3 - Math.sqrt(5));
      dirs.push([r * Math.cos(t), r * Math.sin(t), Math.sqrt(Math.max(0, 1 - r * r))]);
    }
    const maxSteps = 2 * (nx + ny + nz);
    for (let c = 0; c < N; c++) {
      if (g.kind[c] !== SOLID || !(this.emis[c] > 0)) continue;
      const i0 = c % nx;
      const j0 = ((c - i0) / nx) % ny;
      const k0 = (c - i0 - nx * j0) / sxy;
      for (let side = 0; side < 6; side++) {
        const a = side >> 1;
        const sg = side & 1 ? 1 : -1;
        const nb = c + sg * (a === 0 ? 1 : a === 1 ? nx : sxy);
        if (g.kind[nb] === SOLID) continue;
        let seen = 0;
        for (const d of dirs) {
          // the hemisphere's z goes along the face normal
          const v = [0, 0, 0];
          const b1 = (a + 1) % 3;
          const b2 = (a + 2) % 3;
          v[a] = sg * d[2];
          v[b1] = d[0];
          v[b2] = d[1];
          let x = i0 + 0.5 + (a === 0 ? sg * 0.5 : 0);
          let y = j0 + 0.5 + (a === 1 ? sg * 0.5 : 0);
          let z = k0 + 0.5 + (a === 2 ? sg * 0.5 : 0);
          let escaped = false;
          for (let s = 0; s < maxSteps; s++) {
            x += 0.5 * v[0];
            y += 0.5 * v[1];
            z += 0.5 * v[2];
            const ii = Math.floor(x);
            const jj = Math.floor(y);
            const kk = Math.floor(z);
            if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) {
              escaped = true;
              break;
            }
            const cc = ii + nx * (jj + ny * kk);
            if (cc === c) continue;
            const kd = g.kind[cc];
            if (kd === SOLID) break;
            if (kd === AMBIENT) {
              escaped = true;
              break;
            }
          }
          if (escaped) seen++;
        }
        this.view[6 * c + side] = seen / dirs.length;
      }
    }
  }

  /** the air's conductivity in a cell, with the turbulent part (W/(m·K)) */
  private kAir(flow: FlowSolver | null, c: number): number {
    const f = this.fluid;
    if (!flow) return f.k;
    const nut = Math.max(0, flow.nuEff[c] - f.nu);
    return f.k + (f.rho * f.cp * nut) / PR_T;
  }

  /** Assemble the heat equations for the flow as it is and solve them from the temperatures there now. */
  solve(flow: FlowSolver | null, opts: { tol: number; maxIter: number; radiation: boolean }): SolveStats {
    const { g, A, b, T } = this;
    const { nx, ny, nz } = g;
    const N = nx * ny * nz;
    const h = g.h;
    const area = h * h;
    const fl = this.fluid;
    const cp = fl.cp;
    const rho = fl.rho;
    const Ta = this.ambient;
    const TaK = Ta + 273.15;
    const kind = g.kind;
    const low = [A.aW, A.aS, A.aB];
    const high = [A.aE, A.aN, A.aT];
    A.aW.fill(0);
    A.aE.fill(0);
    A.aS.fill(0);
    A.aN.fill(0);
    A.aB.fill(0);
    A.aT.fill(0);
    const speed = (c: number) => (flow ? flow.cellSpeed(c) : 0);
    for (let c = 0; c < N; c++) {
      if (kind[c] === AMBIENT) {
        A.aP[c] = 1;
        b[c] = 0;
        continue;
      }
      let diag = 0;
      let rhs = this.q[c];
      const solid = kind[c] === SOLID;
      for (let a = 0; a < 3; a++) {
        const cs = a === 0 ? 1 : a === 1 ? nx : nx * ny;
        for (let side = 0; side < 2; side++) {
          const n = side ? c + cs : c - cs;
          const nk = kind[n];
          // mass flow out of this cell through the face, kg/s
          let m = 0;
          if (flow && !solid && nk !== SOLID) {
            const f0 = flow.faceBelow(a, c);
            m = side ? rho * area * flow.U[a][f0 + flow.faceStride(a, a)] : -rho * area * flow.U[a][f0];
          }
          let G: number;
          if (solid) {
            const ks = this.kCell[c];
            if (nk === SOLID) G = area / (h / (2 * ks) + h / (2 * this.kCell[n]));
            else {
              const hf = nk === AMBIENT ? OUTSIDE_FILM : wallFilm(speed(n), h / 2, { nu: fl.nu, rho, cp, pr: this.pr });
              G = area / (h / (2 * ks) + 1 / hf);
              if (opts.radiation && this.emis[c] > 0) {
                const F = this.view[6 * c + 2 * a + side];
                if (F > 0) {
                  const Tk = T[c] + 273.15;
                  const gr = this.emis[c] * SIGMA * F * area * (Tk * Tk + TaK * TaK) * (Tk + TaK);
                  diag += gr;
                  rhs += gr * Ta;
                }
              }
            }
          } else if (nk === SOLID) {
            const hf = wallFilm(speed(c), h / 2, { nu: fl.nu, rho, cp, pr: this.pr });
            G = area / (h / (2 * this.kCell[n]) + 1 / hf);
          } else if (nk === AMBIENT) G = (this.kAir(flow, c) * area) / h;
          else G = (0.5 * (this.kAir(flow, c) + this.kAir(flow, n)) * area) / h;
          const aN = G + Math.max(-m * cp, 0);
          diag += G + Math.max(m * cp, 0);
          if (nk === AMBIENT) rhs += aN * Ta;
          else (side ? high : low)[a][c] = aN;
        }
      }
      A.aP[c] = diag > 0 ? diag : 1;
      b[c] = rhs;
    }
    const at = flow ? flow.iterations : 0;
    if (!this.mg) this.mg = new Multigrid(A);
    else if (at !== this.mgFor) this.mg.rebuild();
    else this.mg.update();
    this.mgFor = at;
    return bicgstab(A, b, T, { tol: opts.tol, maxIter: opts.maxIter, mg: this.mg });
  }

  /** Where the heat goes: carried off through the surroundings' layer and radiated. */
  balance(flow: FlowSolver | null): HeatBalance {
    const { g, T } = this;
    const { nx, ny, nz } = g;
    const N = nx * ny * nz;
    const h = g.h;
    const area = h * h;
    const fl = this.fluid;
    const Ta = this.ambient;
    const TaK = Ta + 273.15;
    let made = 0;
    let air = 0;
    let radiated = 0;
    for (let c = 0; c < N; c++) {
      made += this.q[c];
      if (g.kind[c] === AMBIENT) continue;
      for (let a = 0; a < 3; a++) {
        const cs = a === 0 ? 1 : a === 1 ? nx : nx * ny;
        for (let side = 0; side < 2; side++) {
          const n = side ? c + cs : c - cs;
          const solid = g.kind[c] === SOLID;
          if (solid && this.emis[c] > 0 && g.kind[n] !== SOLID) {
            const F = this.view[6 * c + 2 * a + side];
            if (F > 0) {
              const Tk = T[c] + 273.15;
              radiated += this.emis[c] * SIGMA * F * area * (Tk ** 4 - TaK ** 4);
            }
          }
          if (g.kind[n] !== AMBIENT) continue;
          let m = 0;
          if (flow && !solid) {
            const f0 = flow.faceBelow(a, c);
            m = side ? fl.rho * area * flow.U[a][f0 + flow.faceStride(a, a)] : -fl.rho * area * flow.U[a][f0];
          }
          const G = solid ? area / (h / (2 * this.kCell[c]) + 1 / OUTSIDE_FILM) : (this.kAir(flow, c) * area) / h;
          // what leaves carries this cell's temperature; what comes in is at the ambient
          air += G * (T[c] - Ta) + Math.max(m, 0) * fl.cp * (T[c] - Ta);
        }
      }
    }
    return { made, air, radiated };
  }
}

/** Cells of each kind, for messages. */
export function cellKinds(g: Grid): { air: number; solid: number } {
  let air = 0;
  let solid = 0;
  for (let c = 0; c < g.kind.length; c++) {
    if (g.kind[c] === FLUID) air++;
    else if (g.kind[c] === SOLID) solid++;
  }
  return { air, solid };
}
