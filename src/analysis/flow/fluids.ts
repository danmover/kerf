// What flows in a flow analysis, at a temperature: air at sea level, or water for coolant channels and manifolds.

import { airAt } from "../aeroLang";
import type { FlowFluid } from "./types";

/** Air: density and viscosity at sea level, its conductivity (Sutherland-like) and heat capacity. */
export function airFluid(tempC: number): FlowFluid {
  const a = airAt(tempC);
  const T = tempC + 273.15;
  return { name: "air", rho: a.density, nu: a.nu, cp: 1006, k: 0.0241 * (T / 273.15) ** 0.81, beta: 1 / T };
}

/** Water's density (Thiesen), viscosity (Vogel), conductivity and expansion at a temperature, 0 to 100 °C. */
export function waterFluid(tempC: number): FlowFluid {
  const rho = (t: number) => 1000 * (1 - ((t + 288.9414) / (508929.2 * (t + 68.12963))) * (t - 3.9863) ** 2);
  const r = rho(tempC);
  const mu = 2.414e-5 * 10 ** (247.8 / (tempC + 273.15 - 140));
  return { name: "water", rho: r, nu: mu / r, cp: 4181, k: 0.561 + 0.00193 * tempC - 7.5e-6 * tempC * tempC, beta: Math.max(1e-6, (rho(tempC - 0.5) - rho(tempC + 0.5)) / r) };
}
