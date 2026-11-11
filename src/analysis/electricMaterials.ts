// Electrical resistivity for Joule heating: how much a conductor resists current at 20 °C, and how fast that rises
// as it warms. Typical values for the grades the material record names (handbook and maker data); a metal the table
// does not list takes its family's, and anything the record calls an insulator carries no current.

import { MATERIAL_DB } from "../library/materialDb";

export interface ElectricMaterial {
  name: string;
  /** carries current at all */
  conductor: boolean;
  /** resistivity at 20 °C, Ω·m (Infinity for an insulator) */
  rho: number;
  /** temperature coefficient of resistivity, 1/K: ρ(T) = ρ₂₀ (1 + α (T − 20)) */
  alpha: number;
  /** the value is a family's or a guess */
  assumed?: boolean;
  note?: string;
}

/** Resistivity at 20 °C (Ω·m) and its temperature coefficient (1/K), by material name. */
const RHO: Record<string, [number, number]> = {
  Copper: [1.72e-8, 0.00393],
  "Aluminum 6061": [3.99e-8, 0.0037],
  "Aluminum 7075": [5.15e-8, 0.0031],
  "Aluminum 5052": [4.93e-8, 0.0032],
  "Aluminum A380": [6.4e-8, 0.003],
  "Aluminum A356": [4.3e-8, 0.0033],
  AlSi10Mg: [5.5e-8, 0.003],
  "Zamak 3": [6.4e-8, 0.0035],
  Steel: [1.6e-7, 0.0045],
  "Steel 4140": [2.2e-7, 0.003],
  "Cast iron": [8.0e-7, 0.001],
  "Stainless 304": [7.2e-7, 0.001],
  "Stainless 316": [7.4e-7, 0.001],
  Brass: [6.6e-8, 0.0018],
  Bronze: [1.4e-7, 0.001],
  Titanium: [1.78e-6, 0.0004],
  Nichrome: [1.1e-6, 0.0004],
  // quasi-isotropic carbon-fibre plate, in its plane: it conducts, poorly, and a little better as it warms
  "Carbon fiber": [4e-5, -0.0003],
};

/** A conductor the table does not name: by words in its name, else a mid-range metal. */
function family(name: string): [number, number] {
  const n = name.toLowerCase();
  if (/copper|cu\b/.test(n)) return RHO.Copper;
  if (/brass/.test(n)) return RHO.Brass;
  if (/bronze/.test(n)) return RHO.Bronze;
  if (/stainless|inox/.test(n)) return RHO["Stainless 304"];
  if (/alumin/.test(n)) return RHO["Aluminum 6061"];
  if (/titan/.test(n)) return RHO.Titanium;
  if (/nichrome|nicr|kanthal/.test(n)) return RHO.Nichrome;
  if (/zinc|zamak/.test(n)) return RHO["Zamak 3"];
  if (/steel|iron/.test(n)) return RHO.Steel;
  return RHO.Steel;
}

/** Electrical properties for a material name (an unknown name is taken as plastic, which carries no current). */
export function electricMaterial(name: string | undefined): ElectricMaterial {
  const nm = name ?? "PLA";
  const rec = MATERIAL_DB.find((r) => r.name.toLowerCase() === nm.toLowerCase());
  const own = RHO[rec?.name ?? nm] ?? Object.entries(RHO).find(([k]) => k.toLowerCase() === nm.toLowerCase())?.[1];
  if (own) return { name: rec?.name ?? nm, conductor: true, rho: own[0], alpha: own[1] };
  if (rec && rec.electrical === "insulator") return { name: rec.name, conductor: false, rho: Infinity, alpha: 0 };
  if (rec || /copper|brass|bronze|steel|iron|alumin|titan|nichrome|zinc|metal/i.test(nm)) {
    const [rho, alpha] = family(nm);
    return { name: rec?.name ?? nm, conductor: true, rho, alpha, assumed: true, note: `The resistivity of ${rec?.name ?? nm} is taken as a typical ${rho < 1e-7 ? "non-ferrous metal" : "steel"}'s (${(rho * 1e8).toPrecision(3)} µΩ·cm).` };
  }
  return { name: nm, conductor: false, rho: Infinity, alpha: 0, assumed: true };
}

/** Resistivity at a temperature, Ω·m (never below a tenth of the 20 °C value, so a big negative swing stays sane). */
export function rhoAt(m: ElectricMaterial, T: number): number {
  return m.rho * Math.max(0.1, 1 + m.alpha * (T - 20));
}
