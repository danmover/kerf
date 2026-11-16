// How each material and finish looks: physically based parameters plus a
// procedural surface detail (layer lines, brushing, grain, weave, wood)
// that the part shader draws in the part's own coordinates, so it needs no
// UV maps and stays put when parts move.

import { materialDef, resolveFinish, FINISHES } from "../../../library/materials";

/** Procedural surface detail, drawn by partShader.ts. Values are shader constants. */
export enum Detail {
  None = 0,
  Layers = 1,
  Brushed = 2,
  Grain = 3,
  Peel = 4,
  Weave = 5,
  Wood = 6,
  Machined = 7,
  /** plywood: rotary-cut veneer on the faces, the plies and glue lines on the edges (needs the part's uPly) */
  Plywood = 8,
}

export interface Appearance {
  /** cache key: material|finish|color */
  key: string;
  material: string;
  finish: string;
  label: string;
  /** base colour, sRGB hex */
  color: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  sheenRoughness: number;
  transmission: number;
  thickness: number;
  ior: number;
  iridescence: number;
  specularIntensity: number;
  detail: Detail;
  /** bump height of the detail, mm */
  detailAmp: number;
  /** pattern period, mm */
  detailScale: number;
  /** roughness variation the pattern adds */
  roughVar: number;
  /** how far the pattern pulls the colour toward `tint2` (wood late-wood, carbon tows) */
  tintAmt: number;
  tint2: string;
  /** reflection strength multiplier: metals get more so they read as bright metal, not grey plastic */
  envBoost: number;
}

type Look = Omit<Appearance, "key" | "material" | "finish" | "label" | "color" | "tint2" | "envBoost"> & { tint2?: string };

const BASE: Look = {
  metalness: 0,
  roughness: 0.5,
  clearcoat: 0,
  clearcoatRoughness: 0.1,
  sheen: 0,
  sheenRoughness: 0.5,
  transmission: 0,
  thickness: 0,
  ior: 1.5,
  iridescence: 0,
  specularIntensity: 1,
  detail: Detail.None,
  detailAmp: 0,
  detailScale: 1,
  roughVar: 0,
  tintAmt: 0,
};

const look = (p: Partial<Look>): Look => ({ ...BASE, ...p });

/** Finish looks for each kind of material. */
const PLASTIC: Record<string, Look> = {
  printed: look({ roughness: 0.46, detail: Detail.Layers, detailAmp: 0.022, detailScale: 0.2, roughVar: 0.16, tintAmt: 0.1 }),
  matte: look({ roughness: 0.74, detail: Detail.Grain, detailAmp: 0.0025, detailScale: 0.04, roughVar: 0.08 }),
  satin: look({ roughness: 0.4, detail: Detail.Grain, detailAmp: 0.0015, detailScale: 0.05, roughVar: 0.05 }),
  gloss: look({ roughness: 0.2, clearcoat: 0.5, clearcoatRoughness: 0.05 }),
  textured: look({ roughness: 0.62, detail: Detail.Peel, detailAmp: 0.018, detailScale: 0.35, roughVar: 0.1 }),
  machined: look({ roughness: 0.34, detail: Detail.Machined, detailAmp: 0.002, detailScale: 0.04, roughVar: 0.12 }),
  clear: look({ roughness: 0.03, transmission: 1, thickness: 2.5, ior: 1.49, clearcoat: 0.3, clearcoatRoughness: 0.02 }),
  frosted: look({ roughness: 0.42, transmission: 1, thickness: 2.5, ior: 1.49, detail: Detail.Grain, detailAmp: 0.002, detailScale: 0.05 }),
};

const METAL: Record<string, Look> = {
  machined: look({ metalness: 1, roughness: 0.3, detail: Detail.Machined, detailAmp: 0.0018, detailScale: 0.035, roughVar: 0.16 }),
  brushed: look({ metalness: 1, roughness: 0.3, detail: Detail.Brushed, detailAmp: 0.0025, detailScale: 0.03, roughVar: 0.22 }),
  "bead-blasted": look({ metalness: 1, roughness: 0.5, detail: Detail.Grain, detailAmp: 0.003, detailScale: 0.03, roughVar: 0.08 }),
  polished: look({ metalness: 1, roughness: 0.07 }),
  anodized: look({ metalness: 0.72, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.22, detail: Detail.Grain, detailAmp: 0.0015, detailScale: 0.03, roughVar: 0.06 }),
  "black-oxide": look({ metalness: 0.78, roughness: 0.42, clearcoat: 0.4, clearcoatRoughness: 0.3, detail: Detail.Machined, detailAmp: 0.0015, detailScale: 0.035, roughVar: 0.1 }),
  "zinc-plated": look({ metalness: 1, roughness: 0.24, iridescence: 0.3, detail: Detail.Grain, detailAmp: 0.001, detailScale: 0.03, roughVar: 0.06 }),
  "powder-coated": look({ roughness: 0.52, clearcoat: 0.12, clearcoatRoughness: 0.4, detail: Detail.Peel, detailAmp: 0.008, detailScale: 0.7, roughVar: 0.06 }),
};

const OTHER: Record<string, Look> = {
  "solder-mask": look({ roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.12, detail: Detail.Grain, detailAmp: 0.001, detailScale: 0.05, roughVar: 0.04 }),
  // plywood (the one wood material): the pattern sets how far each spot pulls toward the darker tone itself
  raw: look({ roughness: 0.74, sheen: 0.25, sheenRoughness: 0.8, detail: Detail.Plywood, detailAmp: 0.012, detailScale: 7, roughVar: 0.12, tintAmt: 1 }),
  varnished: look({ roughness: 0.4, clearcoat: 0.65, clearcoatRoughness: 0.12, detail: Detail.Plywood, detailAmp: 0.005, detailScale: 7, roughVar: 0.05, tintAmt: 1 }),
};

/** Per-material adjustments on top of the finish look. */
const TWEAKS: Record<string, (l: Look, finish: string) => Partial<Look>> = {
  PLA: (l, f) => (f === "printed" ? { roughness: 0.4 } : {}),
  PETG: (l, f) => (f === "printed" ? { roughness: 0.3, clearcoat: 0.2, clearcoatRoughness: 0.15 } : {}),
  ABS: (l, f) => (f === "printed" ? { roughness: 0.56 } : {}),
  ASA: (l, f) => (f === "printed" ? { roughness: 0.6 } : {}),
  Nylon: (l, f) => (f === "matte" ? { roughness: 0.86, sheen: 0.45, sheenRoughness: 0.8, detailAmp: 0.006, detailScale: 0.06, roughVar: 0.06 } : {}),
  TPU: () => ({ roughness: 0.64, sheen: 0.3, sheenRoughness: 0.6 }),
  POM: (l) => ({ roughness: l.roughness * 0.9, sheen: 0.2, sheenRoughness: 0.4 }),
  Titanium: (l, f) => (f === "bead-blasted" ? { roughness: 0.46 } : {}),
  // as-cast iron and as-printed metal are duller and grainier than a blasted machined face
  "Cast iron": (l, f) => (f === "bead-blasted" ? { roughness: 0.64, detailAmp: 0.005 } : {}),
  AlSi10Mg: (l, f) => (f === "bead-blasted" ? { roughness: 0.58, detailAmp: 0.004 } : {}),
  "Carbon fiber": (l, f) =>
    f === "gloss"
      ? { roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.04, detail: Detail.Weave, detailAmp: 0.02, detailScale: 2, roughVar: 0.18, tintAmt: 0.45 }
      : { roughness: 0.55, detail: Detail.Weave, detailAmp: 0.012, detailScale: 2, roughVar: 0.12, tintAmt: 0.4 },
  Silicone: () => ({ roughness: 0.82, sheen: 0.5, sheenRoughness: 0.7, detail: Detail.Grain, detailAmp: 0.002, detailScale: 0.06, roughVar: 0.05 }),
  Neoprene: () => ({ roughness: 0.7, sheen: 0.35, sheenRoughness: 0.6, detail: Detail.Grain, detailAmp: 0.0015, detailScale: 0.05, roughVar: 0.06 }),
  FR4: (l, f) => (f === "matte" ? { roughness: 0.72 } : {}),
};

/** Darker or lighter companion colour for two-tone patterns. */
function companion(hex: string, k: number): string {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.max(0, Math.min(255, Math.round(k < 1 ? c * k : c + (255 - c) * (k - 1)))));
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("");
}

const cache = new Map<string, Appearance>();

export function appearanceFor(material: string, finish: string | undefined, color: string): Appearance {
  const f = resolveFinish(material, finish);
  const key = `${material}|${f}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = materialDef(material);
  const cat = def?.category ?? "plastic";
  const table = cat === "metal" ? METAL : cat === "plastic" ? PLASTIC : { ...PLASTIC, ...METAL, ...OTHER };
  let l: Look = table[f] ?? OTHER[f] ?? PLASTIC[f] ?? METAL[f] ?? look({});
  const tweak = TWEAKS[material];
  if (tweak) l = { ...l, ...tweak(l, f) };
  const tint2 = l.tint2 ?? (l.detail === Detail.Plywood ? companion(color, 0.5) : l.detail === Detail.Wood ? companion(color, 0.62) : l.detail === Detail.Weave ? companion(color, 1.3) : companion(color, 0.7));
  const out: Appearance = {
    ...l,
    key,
    material,
    finish: f,
    label: `${def?.label ?? material} · ${FINISHES[f]?.label.toLowerCase() ?? f}`,
    color,
    tint2,
    envBoost: 1 + 0.7 * l.metalness,
  };
  cache.set(key, out);
  return out;
}
