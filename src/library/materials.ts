// Engineering materials and surface finishes as the picker and the renderer
// see them: what a material is called, its density, what it is good for,
// which finishes it can have and its typical colours. The records come from
// the material database (library/materialDb), which also holds the strength,
// heat, environment, process and cost data. How each one looks on screen is
// decided by the viewport in src/ui/viewport/render/appearance.ts.

import { MATERIAL_DB, type MaterialCategory } from "./materialDb";

export type { MaterialCategory };

export interface FinishDef {
  id: string;
  label: string;
  note: string;
}

export interface MaterialDef {
  /** the name written in design files: `material: "PETG"` */
  name: string;
  label: string;
  category: MaterialCategory;
  /** g/cm³ */
  density: number;
  /** one line: what it is and when to pick it */
  note: string;
  /** finish ids this material can have; the first is the default */
  finishes: string[];
  /** typical colour, used when switching to this material */
  color: string;
  /** suggested colours (filament, anodizing, paint) */
  palette: string[];
  /** made on an FDM printer by default (print checks, printed mass in the parts list) */
  printed?: boolean;
}

export const FINISHES: Record<string, FinishDef> = {
  printed: { id: "printed", label: "As printed", note: "Visible 0.2 mm layer lines" },
  matte: { id: "matte", label: "Matte", note: "Flat, no shine" },
  satin: { id: "satin", label: "Satin", note: "Soft sheen" },
  gloss: { id: "gloss", label: "Gloss", note: "Smooth and shiny" },
  textured: { id: "textured", label: "Textured", note: "Moulded-in grain" },
  machined: { id: "machined", label: "Machined", note: "Fine tool marks" },
  brushed: { id: "brushed", label: "Brushed", note: "Straight satin grain" },
  "bead-blasted": { id: "bead-blasted", label: "Bead blasted", note: "Even, fine matte grain" },
  polished: { id: "polished", label: "Polished", note: "Mirror-like" },
  anodized: { id: "anodized", label: "Anodized", note: "Coloured, hard satin surface" },
  "black-oxide": { id: "black-oxide", label: "Black oxide", note: "Dark, lightly oiled steel" },
  "zinc-plated": { id: "zinc-plated", label: "Zinc plated", note: "Bright silver with a faint sheen" },
  "powder-coated": { id: "powder-coated", label: "Powder coated", note: "Thick painted coat, slight orange peel" },
  clear: { id: "clear", label: "Clear", note: "Transparent" },
  frosted: { id: "frosted", label: "Frosted", note: "Translucent, diffuses light" },
  "solder-mask": { id: "solder-mask", label: "Solder mask", note: "Glossy circuit-board coating" },
  raw: { id: "raw", label: "Raw", note: "Unfinished, open grain" },
  varnished: { id: "varnished", label: "Varnished", note: "Clear protective coat" },
};

export const MATERIAL_LIST: MaterialDef[] = MATERIAL_DB.map((m) => ({
  name: m.name,
  label: m.label,
  category: m.category,
  density: m.density,
  note: m.note,
  finishes: m.finishes,
  color: m.color,
  palette: m.palette,
  printed: m.printed,
}));

export const MATERIAL_DEFS: Record<string, MaterialDef> = Object.fromEntries(MATERIAL_LIST.map((m) => [m.name, m]));

export const CATEGORY_LABELS: Record<MaterialCategory, string> = { plastic: "Plastics", metal: "Metals", composite: "Composites", other: "Other" };

export function materialDef(name: string): MaterialDef | undefined {
  return MATERIAL_DEFS[name];
}

/** The finish a part actually gets: the one asked for if this material has it, else the material's default. */
export function resolveFinish(material: string, finish?: string): string {
  const def = MATERIAL_DEFS[material];
  if (!def) return finish && FINISHES[finish] ? finish : "matte";
  if (finish && def.finishes.includes(finish)) return finish;
  return def.finishes[0];
}

export const isPrinted = (material: string) => !!MATERIAL_DEFS[material]?.printed;
