// Engineering drawing specifications: what a `drawing` block in the design
// source asks for, plus the standards data the drawing engine uses (sheet
// sizes, preferred scales, ISO 2768 general tolerances and ISO 286 fits).

import type { Span } from "../lang/ast";
import type { V3 } from "../kernel/recipe";
import type { GdtKind } from "./gdt";

export const VIEW_KINDS = ["front", "back", "top", "bottom", "left", "right", "iso"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export const SHEETS = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  Letter: [279.4, 215.9],
  Tabloid: [431.8, 279.4],
} as const;
export type SheetSize = keyof typeof SHEETS;
export const SHEET_NAMES = Object.keys(SHEETS) as SheetSize[];

/** ISO 5455 preferred scales, largest first. */
export const STANDARD_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100];

export interface ViewSpec {
  kind: ViewKind;
  label?: string;
  /** overrides the drawing scale for this view */
  scale?: number;
  hidden?: boolean;
  /** sheet position of the view centre in mm from the top-left corner */
  at?: [number, number];
  /** a crop view: only what lies inside this model box (two opposite corners) */
  crop?: [V3, V3];
  /** an exploded view: the parts spread out from the middle of the assembly, 1 the usual spread */
  exploded?: number;
  span?: Span;
}

/** An auxiliary view, looking square onto an inclined face. */
export interface AuxSpec {
  label: string;
  /** the face's outward normal: the view looks against it */
  normal: V3;
  /** a point on the face, where the viewing arrow on the parent view points */
  at?: V3;
  /** view the arrow is drawn on (defaults to the first view that sees the face edge-on) */
  view?: ViewKind;
  scale?: number;
  at2?: [number, number];
  /** a partial auxiliary view: just this model box, with freehand edges */
  crop?: [V3, V3];
}

/** A broken view: the stretch from..to along a model axis (0 X, 1 Y, 2 Z) is taken out of every view that shows that axis. */
export interface BreakSpec {
  axis: 0 | 1 | 2;
  from: number;
  to: number;
}

/** A broken-out section: inside a circle on one view, the material in front of the plane through at (square to the view) is cut away. */
export interface CutawaySpec {
  view: string;
  at: V3;
  /** radius of the cut-away region in model mm */
  r: number;
}

export interface SectionSpec {
  label: string;
  /** a point on the cutting plane */
  at: V3;
  /** plane normal; the view looks against it at the material behind the plane */
  normal: V3;
  /** view the cutting-plane line is drawn on (defaults to the first view that sees the plane edge-on) */
  view?: ViewKind;
  scale?: number;
  at2?: [number, number];
}

export interface DetailSpec {
  label: string;
  view: ViewKind | string;
  at: V3;
  /** radius of the detail circle in model mm */
  r: number;
  scale: number;
}

export interface DimSpec {
  kind: "linear" | "diameter";
  a: V3;
  /** second point (linear) */
  b?: V3;
  /** diameter value (diameter) */
  d?: number;
  view?: ViewKind | string;
  align: "auto" | "h" | "v" | "aligned";
  /** distance from the view outline in sheet mm */
  offset?: number;
  /** upper and lower deviation in mm */
  tol?: [number, number];
  fit?: string;
  text?: string;
  ref?: boolean;
  basic?: boolean;
  span: Span;
}

export interface TolSpec {
  /** an automatic dimension's id, such as "top:overall-width-x" */
  id: string;
  tol?: [number, number];
  fit?: string;
  span: Span;
}

/** A geometric tolerance written in the drawing block for an automatic dimension or callout. */
export interface GdtSpec {
  id: string;
  kind: GdtKind;
  tol: number;
  datums: string[];
  mmc?: boolean;
  span: Span;
}

/** An angle, radius, chamfer, arc length or ordinate written in the drawing block (model points in the drawing's frame). */
export type MarkSpec =
  | { t: "angle"; vertex: V3; a: V3; b: V3; view?: string; tol?: number; text?: string; span: Span }
  | { t: "radius"; at: V3; r: number; toward?: V3; view?: string; tol?: [number, number]; text?: string; span: Span }
  | { t: "chamfer"; at: V3; size: number; angle: number; view?: string; text?: string; span: Span }
  | { t: "arc"; center: V3; a: V3; b: V3; view?: string; text?: string; span: Span }
  | { t: "ordinate"; pts: V3[]; origin: V3; axis: "x" | "y" | "both"; view?: string; span: Span };

/** A change recorded in the revision table. */
export interface RevisionSpec {
  rev: string;
  text: string;
  date?: string;
  by?: string;
  span: Span;
}

export const WELD_KINDS = ["fillet", "square", "v", "bevel", "u", "j", "plug", "spot", "seam", "edge"] as const;
export type WeldKind = (typeof WELD_KINDS)[number];

/** A surface texture requirement (ISO 21920-1 / ISO 1302): on a feature by id, at a surface point, or for the whole part. */
export interface RoughnessSpec {
  /** an automatic dimension's or callout's id */
  id?: string;
  at?: V3;
  ra?: number;
  rz?: number;
  process?: string;
  lay?: string;
  removal: "required" | "prohibited" | "any";
  view?: string;
  span: Span;
}

/** A weld symbol (ISO 2553, arrow side on the continuous reference line). */
export interface WeldSpec {
  at: V3;
  kind: WeldKind;
  /** throat thickness of a fillet weld, depth of a butt weld, diameter of a plug or spot */
  size?: number;
  /** weld length, or "n × l (pitch)" for intermittent welds */
  length?: string;
  side: "arrow" | "other" | "both";
  allRound: boolean;
  field: boolean;
  /** process or other information in the tail, e.g. "135" or "GMAW" */
  note?: string;
  view?: string;
  span: Span;
}

export const DIM_STYLES = ["auto", "baseline", "chain", "ordinate"] as const;
export type DimStyleName = (typeof DIM_STYLES)[number];

export interface DrawingSpec {
  /** block name in the source, or "auto:<target>" for generated drawings */
  name: string;
  title: string;
  /** part or component names the drawing shows; empty means the whole design */
  of: string[];
  sheet?: SheetSize;
  orientation: "landscape" | "portrait";
  scale?: number;
  projection: "first" | "third";
  number?: string;
  revision?: string;
  author?: string;
  checked?: string;
  date?: string;
  tolerance: string;
  /** the block sets `tolerance:` itself; otherwise it follows the parts' process */
  toleranceSet?: boolean;
  material?: string;
  finish?: string;
  hidden?: boolean;
  autoDims: boolean;
  partsList?: boolean;
  balloons?: boolean;
  /** shows sheet-metal parts laid flat, with bend lines and a bend table */
  flat?: boolean;
  /** datums and geometric tolerances; undefined chooses by process (machined, cast, moulded and sheet parts get them) */
  gdt?: boolean;
  /** a table of hole positions instead of position dimensions in the view that sees most holes */
  holeTable?: boolean;
  /** how automatic feature positions are dimensioned; auto uses baseline and turns to ordinate where a view has too many */
  dimStyle?: DimStyleName;
  /** the views were chosen by Kerf (no views: or view() in the block), so it may pick the ones the part needs */
  viewsAuto?: boolean;
  views: ViewSpec[];
  sections: SectionSpec[];
  details: DetailSpec[];
  aux: AuxSpec[];
  /** stretches taken out of long views; automatic ones are added for long, plain parts unless autoBreak is false */
  breaks: BreakSpec[];
  autoBreak?: boolean;
  cutaways: CutawaySpec[];
  dims: DimSpec[];
  /** tolerances and fits for automatic dimensions, by the dimension's id */
  tols: TolSpec[];
  /** geometric tolerances for automatic dimensions and callouts, by id */
  frames: GdtSpec[];
  /** angles, radii, chamfers, arc lengths and ordinates from the block */
  marks: MarkSpec[];
  revisions: RevisionSpec[];
  roughness: RoughnessSpec[];
  welds: WeldSpec[];
  notes: string[];
  locked: boolean;
  span?: Span;
  auto?: boolean;
}

export const DEFAULT_VIEWS: ViewKind[] = ["front", "top", "right", "iso"];

export function defaultSpec(name: string, title: string, of: string[]): DrawingSpec {
  return {
    name,
    title,
    of,
    orientation: "landscape",
    projection: "first",
    tolerance: "ISO 2768-m",
    autoDims: true,
    views: DEFAULT_VIEWS.map((kind) => ({ kind })),
    sections: [],
    details: [],
    aux: [],
    breaks: [],
    cutaways: [],
    dims: [],
    tols: [],
    frames: [],
    marks: [],
    revisions: [],
    roughness: [],
    welds: [],
    notes: [],
    locked: false,
    auto: true,
    viewsAuto: true,
  };
}

/** Human scale text: 0.5 → "1:2", 2 → "2:1". */
export function scaleText(s: number): string {
  if (s >= 1) return `${fmt(s)}:1`;
  return `1:${fmt(1 / s)}`;
}

function fmt(n: number) {
  const r = Math.round(n * 100) / 100;
  return String(r);
}

/** Parses "1:2", "2:1", "0.5" or a number. */
export function parseScale(v: string | number): number | null {
  if (typeof v === "number") return v > 0 && Number.isFinite(v) ? v : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 0 && b > 0 ? a / b : null;
  }
  const n = Number(v);
  return n > 0 && Number.isFinite(n) ? n : null;
}

// ---------- ISO 2768-1 general tolerances for linear sizes ----------

const LINEAR_RANGES = [3, 6, 30, 120, 400, 1000, 2000, 4000];
const ISO2768: Record<"f" | "m" | "c" | "v", (number | null)[]> = {
  f: [0.05, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, null],
  m: [0.1, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2],
  c: [0.2, 0.3, 0.5, 0.8, 1.2, 2, 3, 4],
  v: [null, 0.5, 1, 1.5, 2.5, 4, 6, 8],
};

/** The ISO 2768-1 class letter in a tolerance note such as "ISO 2768-mK", or null. */
export function generalClass(tolerance: string): "f" | "m" | "c" | "v" | null {
  const m = /2768\s*-?\s*([fmcv])/i.exec(tolerance);
  return m ? (m[1].toLowerCase() as "f" | "m" | "c" | "v") : null;
}

/** Permissible deviation (±) for a nominal size under an ISO 2768-1 class. */
export function generalTolerance(size: number, cls: "f" | "m" | "c" | "v"): number | null {
  const s = Math.abs(size);
  if (s < 0.5 || s > 4000) return null;
  const i = LINEAR_RANGES.findIndex((hi) => s <= hi);
  return ISO2768[cls][i] ?? null;
}

// ---------- ISO 8062-3 casting tolerances (DCTG) ----------

const CASTING_RANGES = [10, 16, 25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000];
/** total casting tolerance in mm for each size range (rows) and grade DCTG 1 to 16 (columns); null where the standard gives none */
const DCT: (number | null)[][] = [
  [0.09, 0.13, 0.18, 0.26, 0.36, 0.52, 0.74, 1, 1.5, 2, 2.8, 4.2, null, null, null, null],
  [0.1, 0.14, 0.2, 0.28, 0.38, 0.54, 0.78, 1.1, 1.6, 2.2, 3, 4.4, null, null, null, null],
  [0.11, 0.15, 0.22, 0.3, 0.42, 0.58, 0.82, 1.2, 1.7, 2.4, 3.2, 4.6, 6, 8, 10, 12],
  [0.12, 0.17, 0.24, 0.32, 0.46, 0.64, 0.9, 1.3, 1.8, 2.6, 3.6, 5, 7, 9, 11, 14],
  [0.13, 0.18, 0.26, 0.36, 0.5, 0.7, 1, 1.4, 2, 2.8, 4, 5.6, 8, 10, 12, 16],
  [0.14, 0.2, 0.28, 0.4, 0.56, 0.78, 1.1, 1.6, 2.2, 3.2, 4.4, 6, 9, 11, 14, 18],
  [0.15, 0.22, 0.3, 0.44, 0.62, 0.88, 1.2, 1.8, 2.5, 3.6, 5, 7, 10, 12, 16, 20],
  [null, 0.24, 0.34, 0.5, 0.7, 1, 1.4, 2, 2.8, 4, 5.6, 8, 11, 14, 18, 22],
  [null, null, 0.4, 0.56, 0.78, 1.1, 1.6, 2.2, 3.2, 4.4, 6.2, 9, 12, 16, 20, 25],
  [null, null, null, 0.64, 0.9, 1.2, 1.8, 2.6, 3.6, 5, 7, 10, 14, 18, 22, 28],
  [null, null, null, 0.72, 1, 1.4, 2, 2.8, 4, 6, 8, 11, 16, 20, 25, 32],
  [null, null, null, 0.8, 1.1, 1.6, 2.2, 3.2, 4.6, 7, 9, 13, 18, 23, 29, 37],
  [null, null, null, null, null, null, 2.6, 3.8, 5.4, 8, 10, 15, 21, 26, 33, 42],
  [null, null, null, null, null, null, null, 4.4, 6.2, 9, 12, 17, 24, 30, 38, 49],
];

/** The casting tolerance grade in a note such as "ISO 8062-3 DCTG 10", or null. */
export function castingGrade(tolerance: string): number | null {
  const m = /DCTG\s*(\d{1,2})\b/i.exec(tolerance);
  const g = m ? Number(m[1]) : NaN;
  return g >= 1 && g <= 16 ? g : null;
}

/** Permissible deviation (±, half the total casting tolerance) for a raw casting size under an ISO 8062-3 grade. */
export function castingTolerance(size: number, grade: number): number | null {
  const s = Math.abs(size);
  if (!(s > 0) || s > 4000) return null;
  const total = DCT[CASTING_RANGES.findIndex((hi) => s <= hi)]?.[grade - 1];
  return total == null ? null : total / 2;
}

/**
 * The general ± for a size under a drawing's tolerance note: the ISO 2768-1
 * class, an ISO 8062-3 casting grade (DCTG), or a flat "±0.3 UNLESS STATED"
 * (what printing and moulding processes state). Null when the note gives
 * none of them.
 */
export function generalDeviation(tolerance: string, size: number): number | null {
  const cls = generalClass(tolerance);
  if (cls) return generalTolerance(size, cls);
  const grade = castingGrade(tolerance);
  if (grade) return castingTolerance(size, grade);
  const m = /±\s*(\d+(?:\.\d+)?)/.exec(tolerance);
  return m ? Number(m[1]) : null;
}

/** ISO 2768-1 general tolerance (± degrees) for an angle whose shorter leg is this long, under a drawing's tolerance note. */
export function generalAngle(tolerance: string, shorterLeg: number): number | null {
  const cls = generalClass(tolerance);
  if (!cls) return null;
  const table: Record<"f" | "m" | "c" | "v", number[]> = { f: [1, 0.5, 1 / 3, 1 / 6, 1 / 12], m: [1, 0.5, 1 / 3, 1 / 6, 1 / 12], c: [1.5, 1, 0.5, 0.25, 1 / 6], v: [3, 2, 1, 0.5, 1 / 3] };
  const i = [10, 50, 120, 400].findIndex((hi) => shorterLeg <= hi);
  return Math.round(table[cls][i < 0 ? 4 : i] * 1e4) / 1e4;
}

/** Rows of the general tolerance table, for the title block. */
export function generalTable(cls: "f" | "m" | "c" | "v"): { range: string; tol: number }[] {
  const lows = [0.5, 3, 6, 30, 120, 400, 1000, 2000];
  return LINEAR_RANGES.map((hi, i) => ({ range: `${lows[i]}–${hi}`, tol: ISO2768[cls][i] })).filter((r): r is { range: string; tol: number } => r.tol !== null);
}

// ---------- ISO 286 limits and fits (sizes up to 500 mm) ----------

const FIT_RANGES = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];
/** standard tolerance grades in micrometres */
const IT: Record<number, number[]> = {
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
};
/** fundamental deviations of shafts in micrometres: es for e, f, g, h; ei for k (IT4 to IT7), m, n, p */
const SHAFT_DEV: Record<string, number[]> = {
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: Array(13).fill(0),
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5],
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};
const UPPER_DEV = new Set(["e", "f", "g", "h"]);

export interface FitLimits {
  /** upper and lower deviation in mm */
  upper: number;
  lower: number;
  code: string;
}

/**
 * Limits for an ISO 286 tolerance class such as "H7", "g6" or "js6" at a
 * nominal size. Holes E, F, G, H and JS and shafts e, f, g, h, js, k, m, n
 * and p are supported (k only for grades 4 to 7). Returns null otherwise.
 */
export function fitLimits(code: string, size: number): FitLimits | null {
  const m = /^\s*([A-Za-z]{1,2})\s*(\d{1,2})\s*$/.exec(code);
  if (!m || !(size > 0) || size > 500) return null;
  const letter = m[1];
  const grade = Number(m[2]);
  const it = IT[grade];
  if (!it) return null;
  const i = FIT_RANGES.findIndex((hi) => size <= hi);
  const t = it[i] / 1000;
  const hole = letter === letter.toUpperCase();
  const l = letter.toLowerCase();
  if (l === "js") return { upper: t / 2, lower: -t / 2, code: `${letter}${grade}` };
  const dev = SHAFT_DEV[l];
  if (!dev) return null;
  if (l === "k" && (grade < 4 || grade > 7)) return null;
  if (hole && !UPPER_DEV.has(l)) return null;
  const d = dev[i] / 1000;
  let upper: number;
  let lower: number;
  if (UPPER_DEV.has(l)) {
    upper = d;
    lower = d - t;
  } else {
    lower = d;
    upper = d + t;
  }
  // holes mirror the shaft deviations: EI = -es
  if (hole) [upper, lower] = [-lower, -upper];
  return { upper: round6(upper), lower: round6(lower), code: `${letter}${grade}` };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------- language surface (shared by the evaluator, editor and AI reference) ----------

export const DRAWING_PROPS = [
  "title",
  "of",
  "sheet",
  "orientation",
  "scale",
  "projection",
  "number",
  "revision",
  "author",
  "checked",
  "date",
  "tolerance",
  "material",
  "finish",
  "hidden_lines",
  "auto_dims",
  "parts_list",
  "balloons",
  "flat_pattern",
  "gdt",
  "hole_table",
  "dim_style",
  "breaks",
  "views",
] as const;

/** Calls allowed as statements inside a drawing block, with their argument names in positional order. */
export const DRAWING_CALLS: Record<string, string[]> = {
  view: ["kind", "scale", "label", "hidden", "at", "crop", "exploded"],
  section: ["label", "at", "normal", "view", "scale"],
  detail: ["label", "view", "at", "r", "scale"],
  aux_view: ["label", "normal", "at", "view", "scale", "crop"],
  break_view: ["axis", "from", "to"],
  broken_out: ["view", "at", "r"],
  dim: ["a", "b", "view", "align", "offset", "tol", "fit", "text", "ref", "basic"],
  diameter: ["at", "d", "view", "tol", "fit", "text", "ref"],
  tol: ["id", "tol", "fit"],
  gdt: ["id", "kind", "tol", "datums", "mmc"],
  angle: ["vertex", "a", "b", "view", "tol", "text"],
  radius: ["at", "r", "view", "toward", "tol", "text"],
  chamfer: ["at", "size", "angle", "view", "text"],
  arc_length: ["center", "a", "b", "view", "text"],
  ordinate: ["at", "view", "origin", "axis"],
  revision: ["rev", "text", "date", "by"],
  roughness: ["at", "ra", "view", "process", "lay", "removal", "rz"],
  weld: ["at", "kind", "size", "length", "view", "side", "all_round", "field", "note"],
  note: ["text"],
};

export const DRAWING_DOCS: Record<string, string> = {
  view: 'view("front", scale: 0.5, label: "VIEW B", hidden: true, at: (x, y), crop: [(x0, y0, z0), (x1, y1, z1)], exploded: true) — adds a view. Kinds: front, back, top, bottom, left, right, iso. at places the view centre on the sheet in mm from the top-left corner. crop shows only what lies inside a model box (a crop view, drawn with freehand edges where it cuts the part); exploded spreads the parts of an assembly out from its middle (true or 1 is the usual spread, 2 twice as far; balloons go on it).',
  aux_view: 'aux_view("B", normal: (1, 0, 1), at: (x, y, z), view: "front", scale: 1, crop: [(x0, y0, z0), (x1, y1, z1)]) — an auxiliary view looking square onto an inclined face with that outward normal, so its holes and outline show true size; an arrow marked B on the view that sees the face edge-on points at at. crop makes it a partial view of just that box. Kerf adds one for holes drilled at an angle, partial when the part is much bigger than the angled features.',
  break_view: 'break_view(X, 40, 260) — a broken view: the stretch from 40 to 260 mm along X is taken out of every view that shows X, with break lines; dimensions across it keep their true length. Kerf breaks long plain parts (shafts, rails, tubes) by itself; breaks: false turns that off.',
  broken_out: 'broken_out("front", at: (x, y, z), r: 10) — a broken-out section: inside a circle of radius r on the view, the material in front of the point is cut away and hatched to show what is inside, bounded by a freehand line.',
  section: 'section("A", at: (x, y, z), normal: X, view: "front") — a cutting plane through at with the given normal. The section view looks against the normal at the material behind the plane; cut faces are hatched and the cutting line is drawn on view.',
  detail: 'detail("B", view: "front", at: (x, y, z), r: 6, scale: 4) — an enlarged circle of radius r (model mm) around a model point on another view.',
  dim: 'dim(a, b, view: "top", align: "h"|"v"|"aligned"|"auto", offset: 10, tol: 0.1 or (0.1, -0.05), fit: "H7", text: "…", ref: true, basic: true) — a linear dimension between two model points, shown on the named view (or the best one).',
  diameter: 'diameter(at, d, view: "top", tol:, fit: "H7", text:) — a diameter callout for a circle of diameter d centred at a model point, on a view that looks along its axis.',
  tol: 'tol("top:overall-width-x", 0.1) or tol("front:4-holes-o3.4", fit: "H7") — a tolerance (± value or (upper, lower)) or ISO 286 fit for an automatic dimension, named by the id view_drawing lists. It follows the dimension when the design changes.',
  gdt: 'gdt("front:4-holes-o3.4", "position", 0.3, "A B C", mmc: true) — a geometric tolerance (position, flatness, perpendicularity, parallelism, runout, coaxiality or profile) for an automatic dimension or callout, named by the id view_drawing lists; it replaces the frame of that kind Kerf chose. gdt: false in the block turns datums and frames off, gdt: true turns them on for printed parts.',
  angle: 'angle(vertex, a, b, view: "front", tol: 0.5, text: "…") — an angle at a model point between the lines to two other points, on the named view (or the one that sees the angle flat). Kerf already dimensions sloped edges against the edges they meet.',
  radius: 'radius(at, r, view: "top", toward: (x, y, z), tol:, text:) — an R callout for an arc of radius r centred at a model point; toward is a point the leader aims through. Kerf already calls out fillets, rounded corners and sketch arcs it sees in the views ("4× R5").',
  chamfer: 'chamfer(at, 1, angle: 45, view: "front") — a chamfer callout "1 × 45°" with its leader on a model point on the chamfer. Kerf already finds chamfers cut across square corners.',
  arc_length: 'arc_length(center, a, b, view: "top") — the length along an arc around center from point a to point b (counter-clockwise as seen in the view), drawn with the arc symbol.',
  ordinate: 'ordinate([(x, y, z), …], view: "top", origin: (0, 0, 0), axis: "x"|"y"|"both") — ordinate dimensions of points from an origin. dim_style: "ordinate" draws every automatic feature position this way; "baseline" (positions from a datum) and "chain" (feature to feature) are the others, and "auto" (the default) turns to ordinate where a view has too many positions for rows.',
  revision: 'revision("B", "Holes moved for M4 screws", date: "2026-11-07", by: "DM") — a row of the revision table at the top right; the last one sets the revision in the title block unless revision: is given.',
  roughness: 'roughness("front:bore-o22", 0.8) on a dimension or callout by id, roughness((x, y, z), 1.6, view: "front", process: "ground", lay: "=", removal: "required"|"prohibited"|"any", rz: 6.3) on a surface point, or roughness(ra: 3.2) for the whole part (shown by the title block) — an ISO 21920-1 surface texture symbol. Machined parts already get Ra on their seats and a general Ra 3.2.',
  weld: 'weld((x, y, z), "fillet", size: 4, length: "3 × 50 (100)", side: "arrow"|"other"|"both", all_round: true, field: true, note: "135", view: "front") — an ISO 2553 weld symbol with its arrow on a model point at the joint. Kinds: fillet (size is the throat a), square, v, bevel, u, j (butt welds, size is the depth s), plug, spot, seam (size is the diameter or width), edge.',
  note: 'note("Break sharp edges 0.2 mm") — a numbered general note on the sheet.',
};
