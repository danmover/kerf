// Engineering materials and surface finishes. This file holds what a
// material *is* (density, what it is good for, which finishes it can have,
// typical colours). How each one looks on screen is decided by the viewport
// in src/ui/viewport/render/appearance.ts.

export type MaterialCategory = "plastic" | "metal" | "composite" | "other";

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

const FILAMENT = ["#f2f0eb", "#2a2d33", "#8e959f", "#4f7cff", "#e04f3a", "#f2a93b", "#3fae6a", "#7a5cd6"];
const ANODIZE = ["#c4c8ce", "#24272c", "#3a62c9", "#b8323a", "#c9a24b", "#2f8a5a", "#7d4fc2"];

export const MATERIAL_LIST: MaterialDef[] = [
  // plastics
  { name: "PLA", label: "PLA", category: "plastic", density: 1.24, note: "Easy to print and stiff. Softens above about 55 °C.", finishes: ["printed", "matte", "gloss"], color: "#f2f0eb", palette: FILAMENT, printed: true },
  { name: "PETG", label: "PETG", category: "plastic", density: 1.27, note: "Tough, slightly flexible, takes heat to about 75 °C. Good for enclosures.", finishes: ["printed", "matte", "gloss"], color: "#4f7cff", palette: FILAMENT, printed: true },
  { name: "ABS", label: "ABS", category: "plastic", density: 1.04, note: "Tough and heat resistant to about 95 °C. Needs an enclosed printer.", finishes: ["printed", "textured", "matte", "gloss"], color: "#2a2d33", palette: FILAMENT, printed: true },
  { name: "ASA", label: "ASA", category: "plastic", density: 1.07, note: "Like ABS but UV-stable, for parts that live outdoors.", finishes: ["printed", "textured", "matte"], color: "#e9e6df", palette: FILAMENT, printed: true },
  { name: "Nylon", label: "Nylon PA12", category: "plastic", density: 1.14, note: "Strong, slippery and wear resistant. Usually SLS printed.", finishes: ["matte", "printed", "machined"], color: "#d9d6cf", palette: ["#d9d6cf", "#2a2d33", "#8e959f"], printed: true },
  { name: "TPU", label: "TPU 95A", category: "plastic", density: 1.21, note: "Flexible and rubbery. Bumpers, feet, grips and seals.", finishes: ["printed", "matte"], color: "#2a2d33", palette: FILAMENT, printed: true },
  { name: "POM", label: "POM (Delrin)", category: "plastic", density: 1.41, note: "Low friction and stiff. The usual choice for gears and bushings.", finishes: ["machined", "satin"], color: "#ecebe6", palette: ["#ecebe6", "#1f2125"] },
  { name: "PC", label: "Polycarbonate", category: "plastic", density: 1.2, note: "Very tough and heat resistant. Can be clear.", finishes: ["gloss", "matte", "clear", "frosted"], color: "#2a2d33", palette: ["#2a2d33", "#f2f0eb", "#d8e6f2"] },
  { name: "Acrylic", label: "Acrylic (PMMA)", category: "plastic", density: 1.18, note: "Clear, stiff sheet for windows and covers. Laser cut.", finishes: ["clear", "frosted", "gloss"], color: "#eef4f8", palette: ["#eef4f8", "#d93a3a", "#2b5fd9", "#1f2125", "#f2a93b"] },
  { name: "Resin", label: "Photopolymer resin", category: "plastic", density: 1.18, note: "SLA and DLP printing resin: fine detail and smooth surfaces, but brittle.", finishes: ["matte", "gloss", "clear"], color: "#bfc3c9", palette: ["#bfc3c9", "#2a2d33", "#eef4f8"] },
  // metals
  { name: "Aluminum 6061", label: "Aluminum 6061", category: "metal", density: 2.7, note: "General-purpose machined aluminum. Light, and anodizes well.", finishes: ["machined", "bead-blasted", "brushed", "anodized", "polished", "powder-coated"], color: "#c4c8ce", palette: ANODIZE },
  { name: "Aluminum 7075", label: "Aluminum 7075", category: "metal", density: 2.81, note: "High-strength aluminum for highly loaded parts.", finishes: ["machined", "bead-blasted", "anodized"], color: "#c9ccd1", palette: ANODIZE },
  { name: "Aluminum 5052", label: "Aluminum 5052 (sheet)", category: "metal", density: 2.68, note: "Formable sheet aluminum for bent brackets and covers.", finishes: ["brushed", "bead-blasted", "anodized", "powder-coated"], color: "#c4c8ce", palette: ANODIZE },
  { name: "Aluminum A380", label: "Aluminum A380 (die cast)", category: "metal", density: 2.74, note: "The usual die-casting alloy, for housings and brackets made by the thousand.", finishes: ["bead-blasted", "powder-coated", "machined"], color: "#b9bdc3", palette: ["#b9bdc3", "#24272c"] },
  { name: "Zamak 3", label: "Zamak 3 (zinc die cast)", category: "metal", density: 6.6, note: "Zinc die-casting alloy for small, detailed parts with a solid feel.", finishes: ["polished", "zinc-plated", "powder-coated"], color: "#a9adb3", palette: ["#a9adb3"] },
  { name: "Steel", label: "Steel", category: "metal", density: 7.85, note: "Strong and cheap. Needs a coating to stop rust.", finishes: ["machined", "black-oxide", "zinc-plated", "powder-coated", "polished"], color: "#8b929c", palette: ["#8b929c", "#3b4048", "#24272c", "#c9d1dc"] },
  { name: "Stainless 304", label: "Stainless 304", category: "metal", density: 8.0, note: "Corrosion-resistant steel for shafts, pins and hardware.", finishes: ["machined", "brushed", "polished", "bead-blasted"], color: "#c3c8cf", palette: ["#c3c8cf"] },
  { name: "Brass", label: "Brass", category: "metal", density: 8.5, note: "Machines easily. Inserts, bushings and decorative parts.", finishes: ["machined", "polished", "brushed"], color: "#c9a24b", palette: ["#c9a24b", "#b8913e"] },
  { name: "Copper", label: "Copper", category: "metal", density: 8.96, note: "Conducts heat and electricity very well. Soft.", finishes: ["machined", "polished", "brushed"], color: "#d38a5f", palette: ["#d38a5f"] },
  { name: "Titanium", label: "Titanium Ti-6Al-4V", category: "metal", density: 4.43, note: "Light, strong and corrosion-proof. Expensive to machine.", finishes: ["bead-blasted", "machined", "polished", "anodized"], color: "#aaa79f", palette: ["#aaa79f", "#3a62c9", "#b08a3a", "#7d4fc2"] },
  // composites and others
  { name: "Carbon fiber", label: "Carbon fiber (CFRP)", category: "composite", density: 1.55, note: "Very stiff and light plates and tubes.", finishes: ["gloss", "matte"], color: "#2b2e33", palette: ["#2b2e33"] },
  { name: "FR4", label: "FR4 (circuit board)", category: "composite", density: 1.85, note: "Glass-epoxy circuit board.", finishes: ["solder-mask", "matte"], color: "#1d6b4b", palette: ["#1d6b4b", "#1f3f8f", "#1f2125", "#a1262c", "#ece9e2"] },
  { name: "Silicone", label: "Silicone rubber", category: "other", density: 1.15, note: "Soft seals, gaskets and feet.", finishes: ["matte"], color: "#3a3d42", palette: ["#3a3d42", "#d64a3a", "#e9e6df"] },
  { name: "Wood", label: "Birch plywood", category: "other", density: 0.68, note: "Laser-cut or CNC-routed panels.", finishes: ["raw", "varnished"], color: "#d4b48a", palette: ["#d4b48a", "#a8794e"] },
];

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
