// A printed (FDM) part is not solid: walls run round every layer's outline, solid layers close its tops and bottoms,
// and a sparse infill fills the rest. This holds the slicer settings the strength analysis reads, how stiff and strong
// each infill is, and how much stiffer a printed plastic is along its layers than across them.

import type { ProcessSpec } from "./types";

export const INFILL_PATTERNS = ["gyroid", "grid", "cubic", "honeycomb", "lines", "lightning"] as const;
export type InfillPattern = (typeof INFILL_PATTERNS)[number];

export const PATTERN_WORDS: Record<InfillPattern, string> = {
  gyroid: "gyroid",
  grid: "grid",
  cubic: "cubic",
  honeycomb: "honeycomb",
  lines: "lines",
  lightning: "lightning",
};

/**
 * The homogenised stiffness and strength of a sparse infill, as shares of the solid's, from its density ρ:
 * c·ρⁿ, the scaling of cellular solids (Gibson and Ashby), blended to 1 as it nears solid. A gyroid bends between its
 * walls (about ρ^1.8 stiff, ρ^1.5 strong) and is about as strong every way; grids, lines and cubic stretch along their
 * walls (nearer ρ^1.2) but are weaker across them, so they are averaged here; lightning only holds up top surfaces and
 * carries next to nothing.
 */
const LAWS: Record<InfillPattern, { cE: number; nE: number; cS: number; nS: number }> = {
  gyroid: { cE: 0.8, nE: 1.8, cS: 0.8, nS: 1.5 },
  grid: { cE: 0.35, nE: 1.2, cS: 0.45, nS: 1.3 },
  cubic: { cE: 0.35, nE: 1.25, cS: 0.45, nS: 1.35 },
  honeycomb: { cE: 0.4, nE: 1.4, cS: 0.5, nS: 1.4 },
  lines: { cE: 0.25, nE: 1.2, cS: 0.35, nS: 1.3 },
  lightning: { cE: 0.02, nE: 1, cS: 0.02, nS: 1 },
};

const law = (c: number, n: number, rho: number) => (rho >= 0.999 ? 1 : rho <= 0 ? 0 : c * Math.pow(rho, n) + (1 - c) * Math.pow(rho, 6));

/** Stiffness of an infill as a share of the solid plastic's. */
export function infillStiffness(rho: number, pattern: InfillPattern): number {
  const l = LAWS[pattern] ?? LAWS.gyroid;
  return law(l.cE, l.nE, rho);
}

/** Strength of an infill as a share of the solid plastic's. */
export function infillStrength(rho: number, pattern: InfillPattern): number {
  const l = LAWS[pattern] ?? LAWS.gyroid;
  return law(l.cS, l.nS, rho);
}

/** How one printed part is printed, as the analysis reads it. */
export interface FdmPrint {
  /** walls (perimeters) and the solid layers on tops and bottoms */
  walls: number;
  top: number;
  /** sparse infill share 0..1 (1: solid) */
  infill: number;
  pattern: InfillPattern;
  /** layer height and line width, mm */
  layer: number;
  line: number;
}

/** Kerf's own print advice for parts that carry load (the build pack says the same). */
export const FDM_DEFAULTS = { walls: 4, top: 5, infill: 0.4, pattern: "gyroid" as InfillPattern, layer: 0.2, nozzle: 0.4 };

/** An infill setting as a share: 40% and 0.4 both mean 0.4; 40 is read as percent. */
export const infillShare = (v: number) => Math.min(1, Math.max(0, v > 1 ? v / 100 : v));

/** The print settings of an FDM part, with Kerf's defaults where the part gives none. */
export function fdmPrint(spec?: ProcessSpec): FdmPrint {
  const s = spec && spec.id === "fdm" ? spec.settings : {};
  const num = (k: string, d: number) => (typeof s[k] === "number" && Number.isFinite(s[k] as number) ? (s[k] as number) : d);
  const nozzle = num("nozzle", FDM_DEFAULTS.nozzle);
  const pattern = typeof s.pattern === "string" && (INFILL_PATTERNS as readonly string[]).includes(s.pattern) ? (s.pattern as InfillPattern) : FDM_DEFAULTS.pattern;
  return {
    walls: Math.max(0, Math.round(num("walls", FDM_DEFAULTS.walls))),
    top: Math.max(0, Math.round(num("top", FDM_DEFAULTS.top))),
    infill: infillShare(num("infill", FDM_DEFAULTS.infill)),
    pattern,
    layer: num("layer", FDM_DEFAULTS.layer),
    // slicers lay walls about 1.1 nozzles wide
    line: 1.1 * nozzle,
  };
}

/** In words: "4 walls, 5 top and bottom layers, 40 % gyroid infill". */
export function printWords(p: FdmPrint): string {
  if (p.infill >= 0.999) return "solid (100 % infill)";
  return `${p.walls} wall${p.walls === 1 ? "" : "s"}, ${p.top} top and bottom layer${p.top === 1 ? "" : "s"}, ${Math.round(p.infill * 100)} % ${PATTERN_WORDS[p.pattern]} infill`;
}

/**
 * How much stiffer a printed plastic is along its layers than across them: Young's and shear modulus across the layers
 * as shares of the in-plane values. Layers fuse imperfectly, so a plain plastic keeps about 80 % across them (less the
 * weaker its layer bond); fibre-filled filaments lay their fibres along the lines and keep under half.
 */
export function layerStiffness(m: { name: string; layerFactor: number }): { rE: number; rG: number } {
  if (m.layerFactor >= 0.999) return { rE: 1, rG: 1 };
  const fibre = /carbon|cf\b|-cf|glass|gf\b|-gf|fibre|fiber/i.test(m.name);
  if (fibre) return { rE: 0.45, rG: 0.6 };
  const rE = Math.min(1, 0.55 + 0.45 * m.layerFactor);
  return { rE, rG: Math.min(1, rE + 0.05) };
}
