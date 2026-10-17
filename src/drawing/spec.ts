// Engineering drawing specifications: what a `drawing` block in the design
// source asks for, plus the standards data the drawing engine uses (sheet
// sizes, preferred scales, ISO 2768 general tolerances and ISO 286 fits).

import type { Span } from "../lang/ast";
import type { V3 } from "../kernel/recipe";

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
  views: ViewSpec[];
  sections: SectionSpec[];
  details: DetailSpec[];
  dims: DimSpec[];
  /** tolerances and fits for automatic dimensions, by the dimension's id */
  tols: TolSpec[];
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
    dims: [],
    tols: [],
    notes: [],
    locked: false,
    auto: true,
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
  "views",
] as const;

/** Calls allowed as statements inside a drawing block, with their argument names in positional order. */
export const DRAWING_CALLS: Record<string, string[]> = {
  view: ["kind", "scale", "label", "hidden", "at"],
  section: ["label", "at", "normal", "view", "scale"],
  detail: ["label", "view", "at", "r", "scale"],
  dim: ["a", "b", "view", "align", "offset", "tol", "fit", "text", "ref", "basic"],
  diameter: ["at", "d", "view", "tol", "fit", "text", "ref"],
  tol: ["id", "tol", "fit"],
  note: ["text"],
};

export const DRAWING_DOCS: Record<string, string> = {
  view: 'view("front", scale: 0.5, label: "VIEW B", hidden: true, at: (x, y)) — adds a view. Kinds: front, back, top, bottom, left, right, iso. at places the view centre on the sheet in mm from the top-left corner.',
  section: 'section("A", at: (x, y, z), normal: X, view: "front") — a cutting plane through at with the given normal. The section view looks against the normal at the material behind the plane; cut faces are hatched and the cutting line is drawn on view.',
  detail: 'detail("B", view: "front", at: (x, y, z), r: 6, scale: 4) — an enlarged circle of radius r (model mm) around a model point on another view.',
  dim: 'dim(a, b, view: "top", align: "h"|"v"|"aligned"|"auto", offset: 10, tol: 0.1 or (0.1, -0.05), fit: "H7", text: "…", ref: true, basic: true) — a linear dimension between two model points, shown on the named view (or the best one).',
  diameter: 'diameter(at, d, view: "top", tol:, fit: "H7", text:) — a diameter callout for a circle of diameter d centred at a model point, on a view that looks along its axis.',
  tol: 'tol("top:overall-width-x", 0.1) or tol("front:4-holes-o3.4", fit: "H7") — a tolerance (± value or (upper, lower)) or ISO 286 fit for an automatic dimension, named by the id view_drawing lists. It follows the dimension when the design changes.',
  note: 'note("Break sharp edges 0.2 mm") — a numbered general note on the sheet.',
};
