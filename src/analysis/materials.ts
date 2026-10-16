// Mechanical properties for structural analysis. Typical datasheet values,
// rounded to the conservative side; FDM plastics use printed-part values
// (lower than moulded), with a separate knock-down for strength between
// layers. These are design estimates, not certified allowables.
//
// Keyed by the same names as `material:` in the design language. When the
// shared material record lands (appearance and engineering in one place),
// this table should read from it.

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

const M = (m: Omit<MechMaterial, "assumed">): MechMaterial => m;

export const MECH: Record<string, MechMaterial> = {
  PLA: M({ name: "PLA", E: 3000, nu: 0.36, density: 1.24, yield: 45, uts: 50, fatigue: 15, elongation: 4, layerFactor: 0.6, printedByDefault: true, note: "Brittle; creeps under constant load, softens above about 55 °C." }),
  PETG: M({ name: "PETG", E: 1900, nu: 0.38, density: 1.27, yield: 40, uts: 48, fatigue: 13, elongation: 20, layerFactor: 0.65, printedByDefault: true, note: "Tough; softens above about 70 °C." }),
  ABS: M({ name: "ABS", E: 2000, nu: 0.35, density: 1.04, yield: 32, uts: 38, fatigue: 11, elongation: 8, layerFactor: 0.55, printedByDefault: true }),
  ASA: M({ name: "ASA", E: 1900, nu: 0.35, density: 1.07, yield: 34, uts: 40, fatigue: 11, elongation: 10, layerFactor: 0.6, printedByDefault: true }),
  Nylon: M({ name: "Nylon PA12", E: 1600, nu: 0.39, density: 1.14, yield: 42, uts: 48, fatigue: 15, elongation: 15, layerFactor: 0.85, printedByDefault: true, note: "Values for SLS-printed PA12; absorbs moisture, which lowers stiffness." }),
  POM: M({ name: "POM (Delrin)", E: 2900, nu: 0.35, density: 1.41, yield: 62, uts: 68, fatigue: 28, elongation: 25, layerFactor: 1, printedByDefault: false, note: "Machined or moulded." }),
  "Aluminum 6061": M({ name: "Aluminum 6061-T6", E: 68900, nu: 0.33, density: 2.7, yield: 276, uts: 310, fatigue: 96, elongation: 12, layerFactor: 1, printedByDefault: false }),
  Steel: M({ name: "Steel (mild, S275)", E: 200000, nu: 0.29, density: 7.85, yield: 275, uts: 430, fatigue: 190, elongation: 20, layerFactor: 1, printedByDefault: false }),
  "Stainless 304": M({ name: "Stainless 304", E: 193000, nu: 0.29, density: 8.0, yield: 215, uts: 505, fatigue: 210, elongation: 40, layerFactor: 1, printedByDefault: false }),
  "Stainless 316": M({ name: "Stainless 316", E: 193000, nu: 0.3, density: 8.0, yield: 205, uts: 515, fatigue: 205, elongation: 40, layerFactor: 1, printedByDefault: false }),
  Brass: M({ name: "Brass C360", E: 97000, nu: 0.31, density: 8.5, yield: 124, uts: 338, fatigue: 97, elongation: 25, layerFactor: 1, printedByDefault: false }),
  FR4: M({ name: "FR4", E: 20000, nu: 0.14, density: 1.85, yield: 250, uts: 300, fatigue: 90, elongation: 2, layerFactor: 1, printedByDefault: false, note: "In-plane values; much weaker through the thickness." }),
};

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
