// Mechanical properties for structural analysis. Typical datasheet values,
// rounded to the conservative side; FDM plastics use printed-part values
// (lower than moulded), with a separate knock-down for strength between
// layers. These are design estimates, not certified allowables.
//
// Keyed by the same names as `material:` in the design language, and read
// from the shared material record (library/materialDb), so the analysis,
// the look, the process checks and the advisor never disagree.

import { MATERIAL_DB } from "../library/materialDb";

export interface MechMaterial {
  name: string;
  /** Young's modulus, MPa */
  E: number;
  nu: number;
  /** g/cm³ */
  density: number;
  /** yield (or 0.2 % proof) strength, MPa; for brittle materials the tensile strength */
  yield: number;
  /** ultimate tensile strength, MPa */
  uts: number;
  /** fatigue strength for about 10⁷ fully reversed cycles, MPa */
  fatigue: number;
  /** elongation at break, % */
  elongation: number;
  /** strength between FDM layers as a fraction of in-plane strength */
  layerFactor: number;
  /** usually made by FDM printing */
  printedByDefault: boolean;
  /** properties are estimates for an unknown name */
  assumed?: boolean;
  note?: string;
}

export const MECH: Record<string, MechMaterial> = Object.fromEntries(
  MATERIAL_DB.map((m) => [m.name, { name: m.grade, E: m.mech.E, nu: m.mech.nu, density: m.density, yield: m.mech.yield, uts: m.mech.uts, fatigue: m.mech.fatigue, elongation: m.mech.elongation, layerFactor: m.mech.layerFactor, printedByDefault: !!m.printed, ...(m.mech.note ? { note: m.mech.note } : {}) }]),
);

const ALIASES: Record<string, string> = {
  pla: "PLA",
  "pla+": "PLA",
  petg: "PETG",
  pet: "PETG",
  abs: "ABS",
  asa: "ASA",
  nylon: "Nylon",
  pa12: "Nylon",
  "nylon pa12": "Nylon",
  pa: "Nylon",
  pom: "POM",
  delrin: "POM",
  acetal: "POM",
  "pom (delrin)": "POM",
  aluminum: "Aluminum 6061",
  aluminium: "Aluminum 6061",
  "aluminum 6061": "Aluminum 6061",
  "aluminium 6061": "Aluminum 6061",
  "6061": "Aluminum 6061",
  "6061-t6": "Aluminum 6061",
  "al 6061": "Aluminum 6061",
  "aluminum 7075": "Aluminum 7075",
  "aluminium 7075": "Aluminum 7075",
  "7075": "Aluminum 7075",
  "7075-t6": "Aluminum 7075",
  "aluminum 5052": "Aluminum 5052",
  "aluminium 5052": "Aluminum 5052",
  "5052": "Aluminum 5052",
  "5052-h32": "Aluminum 5052",
  "aluminum a380": "Aluminum A380",
  "aluminium a380": "Aluminum A380",
  a380: "Aluminum A380",
  "cast aluminum": "Aluminum A380",
  "cast aluminium": "Aluminum A380",
  steel: "Steel",
  "mild steel": "Steel",
  "carbon steel": "Steel",
  stainless: "Stainless 304",
  "stainless steel": "Stainless 304",
  "stainless 304": "Stainless 304",
  "304": "Stainless 304",
  "stainless 316": "Stainless 316",
  "stainless steel 316": "Stainless 316",
  "316": "Stainless 316",
  "316l": "Stainless 316",
  brass: "Brass",
  fr4: "FR4",
  "fr-4": "FR4",
  "nylon cf": "Nylon CF",
  "pa-cf": "Nylon CF",
  "pa cf": "Nylon CF",
  pacf: "Nylon CF",
  "carbon fiber nylon": "Nylon CF",
  "carbon fibre nylon": "Nylon CF",
  tpu: "TPU",
  "tpu 95a": "TPU",
  tpe: "TPU",
  pc: "PC",
  polycarbonate: "PC",
  pp: "PP",
  polypropylene: "PP",
  acrylic: "Acrylic",
  pmma: "Acrylic",
  plexiglass: "Acrylic",
  resin: "Resin",
  "sla resin": "Resin",
  zamak: "Zamak 3",
  "zamak 3": "Zamak 3",
  "zinc die cast": "Zamak 3",
  "4140": "Steel 4140",
  "steel 4140": "Steel 4140",
  "alloy steel": "Steel 4140",
  "chromoly": "Steel 4140",
  copper: "Copper",
  titanium: "Titanium",
  "ti-6al-4v": "Titanium",
  ti64: "Titanium",
  "carbon fiber": "Carbon fiber",
  "carbon fibre": "Carbon fiber",
  cfrp: "Carbon fiber",
  silicone: "Silicone",
  "silicone rubber": "Silicone",
  plywood: "Wood",
  "birch plywood": "Wood",
  wood: "Wood",
};

// longest first, so on a tie in strength the most specific name wins
const LOOSE = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Properties for a material name; unknown names fall back to PLA and are marked assumed. */
export function mechMaterial(name: string | undefined): MechMaterial {
  const raw = (name ?? "").trim();
  if (Object.hasOwn(MECH, raw)) return MECH[raw];
  const key = raw.toLowerCase();
  if (Object.hasOwn(ALIASES, key)) return MECH[ALIASES[key]];
  // loose match: "Brushed aluminium", "Black ABS", "316 stainless"... Short aliases (abs, pla, 304)
  // only count as whole words, so "pa" does not match inside "paper". When several names match
  // ("Stainless steel 316" holds steel, stainless and 316) the weakest wins, so the check errs safe.
  let best: MechMaterial | null = null;
  for (const k of LOOSE) {
    const hit = k.length > 3 ? key.includes(k) : new RegExp(`(^|[^a-z0-9])${escape(k)}($|[^a-z0-9])`).test(key);
    if (hit && (!best || MECH[ALIASES[k]].yield < best.yield)) best = MECH[ALIASES[k]];
  }
  if (best) return best;
  return { ...MECH.PLA, name: raw || "unknown", assumed: true, note: `No strength data for "${raw || "this material"}"; PLA values assumed, so treat the result as a rough guide.` };
}

/**
 * Allowable stress for a given number of load cycles: static yield up to
 * 1000 cycles, then a straight line on log-log axes from 0.9·UTS at 10³ to
 * the fatigue strength at 10⁷ (Shigley's estimate), never above yield.
 */
export function allowableStress(m: MechMaterial, cycles?: number): { value: number; basis: "yield" | "fatigue" } {
  if (!cycles || cycles <= 1000) return { value: m.yield, basis: "yield" };
  const n = Math.min(cycles, 1e7);
  const s1 = 0.9 * m.uts;
  const s2 = m.fatigue;
  const b = Math.log10(s2 / s1) / 4;
  const s = s1 * Math.pow(n / 1e3, b);
  return { value: Math.min(s, m.yield), basis: "fatigue" };
}
