// The law of the wall, for flow on grids too coarse to resolve the thin layer next to a surface (the usual case in
// electronics cooling and ducts): Spalding's single formula for the velocity from the wall to the log layer, the
// LVEL turbulence model built on it (Agonafer, Gan-Li and Spalding 1996: the eddy viscosity from the wall distance
// and the local speed, as FloTHERM uses), and Kader's (1981) temperature profile for the heat a wall gives the air.

/** von Kármán's constant and the log law's E, as LVEL takes them */
export const KAPPA = 0.417;
export const E_WALL = 8.6;
/** turbulent Prandtl number */
export const PR_T = 0.9;

const LOG_MIN = -2;
const LOG_MAX = 9;
const STEPS = 5500;
const DLOG = (LOG_MAX - LOG_MIN) / STEPS;
const RE_MIN = 10 ** LOG_MIN;

/** Spalding: y+ for a u+ */
export function spaldingYPlus(up: number): number {
  const ku = KAPPA * up;
  return up + (Math.exp(ku) - 1 - ku - (ku * ku) / 2 - (ku * ku * ku) / 6) / E_WALL;
}

/** the eddy viscosity over the molecular one where the profile has this u+: dy+/du+ − 1 */
export function spaldingNut(up: number): number {
  const ku = KAPPA * up;
  return (KAPPA / E_WALL) * (Math.exp(ku) - 1 - ku - (ku * ku) / 2);
}

// u+ and νt/ν against log10 of the local Reynolds number Re = u·y/ν (= u+·y+)
const UP = new Float64Array(STEPS + 1);
const NUT = new Float64Array(STEPS + 1);
{
  let up = 0.1;
  for (let i = 0; i <= STEPS; i++) {
    const re = 10 ** (LOG_MIN + i * DLOG);
    // Newton on u+·y+(u+) = Re, from the last answer (Re only grows)
    for (let it = 0; it < 50; it++) {
      const yp = spaldingYPlus(up);
      const f = up * yp - re;
      const df = yp + up * (1 + spaldingNut(up));
      const next = Math.max(1e-6, up - f / df);
      if (Math.abs(next - up) < 1e-12 * Math.max(1, up)) {
        up = next;
        break;
      }
      up = next;
    }
    UP[i] = up;
    NUT[i] = spaldingNut(up);
  }
}

function lookup(table: Float64Array, re: number): number {
  const x = (Math.log10(re) - LOG_MIN) / DLOG;
  if (x >= STEPS) return table[STEPS];
  const i = Math.floor(x);
  const f = x - i;
  return table[i] * (1 - f) + table[i + 1] * f;
}

/** u+ where the speed u is found a distance y from the wall: Re = u·y/ν */
export function uPlus(re: number): number {
  if (!(re > RE_MIN)) return Math.sqrt(Math.max(0, re));
  return lookup(UP, re);
}

/** LVEL's eddy viscosity over the air's own at a cell a distance d from the nearest wall with local speed u: Re = u·d/ν */
export function lvelNut(re: number): number {
  if (!(re > RE_MIN)) return 0;
  return lookup(NUT, re);
}

/**
 * Shear on a wall per unit speed, τw/u (Pa·s/m), for the speed u parallel to it found y from it: ρ·u/u+².
 * Laminar it is μ/y, the straight-line profile; in the log layer it grows with the speed.
 */
export function wallShearCoeff(u: number, y: number, nu: number, rho: number): number {
  const re = (Math.abs(u) * y) / nu;
  if (re < 1e-6) return (rho * nu) / y;
  const up = uPlus(re);
  return (rho * Math.abs(u)) / (up * up);
}

/** Kader's β for a Prandtl number */
const kaderBeta = (pr: number) => (3.85 * Math.cbrt(pr) - 1.3) ** 2 + 2.12 * Math.log(pr);

/** Kader's T+ at a y+ (molecular Prandtl number pr) */
export function tPlus(yp: number, pr: number): number {
  const g = (0.01 * (pr * yp) ** 4) / (1 + 5 * pr ** 3 * yp);
  return pr * yp * Math.exp(-g) + (2.12 * Math.log(1 + yp) + kaderBeta(pr)) * (g > 0 ? Math.exp(-1 / g) : 0);
}

/**
 * Film coefficient (W/(m²·K)) between a wall and the air in the cell next to it, with speed u (m/s) parallel to the
 * wall at distance y (m): ρ·cp·uτ/T+. With no flow it is the air's conduction across y, k/y.
 */
export function wallFilm(u: number, y: number, fluid: { nu: number; rho: number; cp: number; pr: number }): number {
  const k = (fluid.rho * fluid.cp * fluid.nu) / fluid.pr;
  const re = (Math.abs(u) * y) / fluid.nu;
  if (re < 1e-6) return k / y;
  const up = uPlus(re);
  const utau = Math.abs(u) / up;
  const yp = (y * utau) / fluid.nu;
  const tp = tPlus(yp, fluid.pr);
  return Math.min((fluid.rho * fluid.cp * utau) / Math.max(tp, 1e-9), 1e9);
}
