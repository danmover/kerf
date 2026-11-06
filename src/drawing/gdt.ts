// Geometrical tolerancing (ISO 1101 / ASME Y14.5): feature control frames,
// datum feature symbols, the tolerance values Kerf chooses for each
// process and feature role, and how they are inked. Symbols are drawn as
// lines, not font glyphs, so they come out the same in SVG, PDF and DXF.

import type { EvalPart } from "../core/model";
import type { Feature } from "./features";
import type { Family } from "./intent";
import { fmtNum, Ink, type Box } from "./sheet";
import type { DrawingSpec } from "./spec";
import { textWidth } from "./text";

export const GDT_KINDS = ["position", "flatness", "perpendicularity", "parallelism", "runout", "coaxiality", "profile"] as const;
export type GdtKind = (typeof GDT_KINDS)[number];

/** A feature control frame. */
export interface Fcf {
  kind: GdtKind;
  tol: number;
  /** a cylindrical tolerance zone (Ø before the value) */
  dia: boolean;
  /** at maximum material condition (Ⓜ) */
  mmc?: boolean;
  datums: string[];
}

/** One datum of a drawing's reference frame. */
export interface DatumInfo {
  letter: string;
  /** what the datum is, e.g. "front face (mounting face)" */
  what: string;
}

/** Plain text of a frame for lists and the assistant: "position Ø0.4 (M) | A | B | C". */
export function fcfText(f: Fcf): string {
  return [`${f.kind} ${f.dia ? "Ø" : ""}${fmtNum(f.tol, 3)}${f.mmc ? " (M)" : ""}`, ...f.datums].join(" | ");
}

/**
 * Whether a drawing gets geometric tolerances: `gdt:` in the block decides;
 * otherwise parts that are machined, cast, moulded or bent get them and
 * printed parts (where they mostly add noise) do not.
 */
export function gdtWanted(spec: DrawingSpec, family: Family): boolean {
  if (spec.gdt !== undefined) return spec.gdt;
  return family === "subtractive" || family === "formative" || family === "sheet";
}

/** Medium clearance hole for a metric screw (ISO 273). */
const CLEARANCE: Record<string, number> = { M1_6: 1.8, M2: 2.4, M2_5: 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M14: 15.5, M16: 17.5, M20: 22 };

/** Nominal diameter of a thread name such as "M3" or "M2.5". */
export function threadNominal(name: string | undefined): number | null {
  const m = /^M(\d+(?:\.\d+)?)/i.exec(name ?? "");
  return m ? Number(m[1]) : null;
}

function clearanceFor(thread: string): number | null {
  const n = threadNominal(thread);
  if (n === null) return null;
  return CLEARANCE[`M${String(n).replace(".", "_")}`] ?? n * 1.1;
}

const round = (n: number, step: number) => Math.max(step, Math.floor(n / step + 1e-9) * step);

/**
 * Position tolerance for a hole pattern from the fastener it takes: a
 * clearance hole with a screw through it floats (T = H − F, ASME Y14.5
 * floating fastener), a tapped hole or insert holds its screw fixed and
 * gets half the clearance in the mating part ((H − F) / 2). Plain holes and
 * bores get what the process holds.
 */
export function holePosition(h: Extract<Feature, { t: "hole" }>, family: Family): { tol: number; mmc: boolean } {
  const F = threadNominal(h.thread);
  if (F !== null) {
    const fixed = h.fit === "tap" || h.fit === "insert" || h.fit === "thread";
    if (fixed) {
      const H = clearanceFor(h.thread!) ?? F * 1.1;
      return { tol: round((H - F) / 2, 0.05), mmc: true };
    }
    return { tol: round(h.d - F, 0.05), mmc: true };
  }
  return { tol: boreTol(family, false), mmc: false };
}

/** Position of a bore or pocket: tight for a bearing seat, the process's usual otherwise. */
export function boreTol(family: Family, seat: boolean): number {
  if (family === "subtractive") return seat ? 0.03 : 0.1;
  if (family === "sheet") return 0.2;
  return seat ? 0.1 : 0.3;
}

/** Flatness of the primary datum face. */
export function flatnessTol(family: Family, size: number): number {
  if (family === "subtractive") return size > 150 ? 0.1 : 0.05;
  if (family === "sheet") return 0.3;
  return size > 150 ? 0.3 : 0.2;
}

/** Perpendicularity of a bearing seat or bore to the primary datum. */
export function squareTol(family: Family): number {
  return family === "subtractive" ? 0.02 : 0.1;
}

/** Circular runout of a turned seat about the datum axis. */
export function runoutTol(family: Family): number {
  return family === "subtractive" ? 0.02 : 0.1;
}

/** The face a direction points out of, in words. */
export function faceName(n: [number, number, number]): string {
  const k = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
  const s = Math.sign(n[k]);
  return [s > 0 ? "right" : "left", s > 0 ? "back" : "front", s > 0 ? "top" : "bottom"][k];
}

/** Does this part read as a revolved (turned) part rather than a prismatic one? */
export function isTurned(p: EvalPart): boolean {
  return p.recipe.base?.t === "revolve";
}

// ---------- inking ----------

/** Height of a frame row for a text size. */
export const fcfHeight = (size: number) => size * 1.75;

/** Width of a frame for a text size. */
export function fcfWidth(f: Fcf, size: number): number {
  const h = fcfHeight(size);
  let w = h;
  w += textWidth(`${f.dia ? "Ø" : ""}${fmtNum(f.tol, 3)}`, size) + 2 + (f.mmc ? size * 1.1 + 0.6 : 0);
  for (const d of f.datums) w += Math.max(h, textWidth(d, size) + 2);
  return w;
}

/** Draws a frame with its top-left corner at (x, y); returns its box. */
export function inkFcf(ink: Ink, x: number, y: number, f: Fcf, size: number): Box {
  const h = fcfHeight(size);
  const w = fcfWidth(f, size);
  ink.rect(x, y, w, h, "thin");
  // symbol compartment
  symbol(ink, f.kind, x + h / 2, y + h / 2, h * 0.32);
  let cx = x + h;
  ink.line(cx, y, cx, y + h, "thin");
  const tol = `${f.dia ? "Ø" : ""}${fmtNum(f.tol, 3)}`;
  const base = y + h / 2 + size * 0.36;
  ink.text(cx + 1, base, tol, size);
  cx += 1 + textWidth(tol, size);
  if (f.mmc) {
    const r = size * 0.55;
    ink.circle(cx + 0.6 + r, y + h / 2, r, "thin");
    ink.text(cx + 0.6 + r, y + h / 2 + size * 0.26, "M", size * 0.7, "middle");
    cx += 0.6 + 2 * r;
  }
  cx += 1;
  for (const d of f.datums) {
    ink.line(cx, y, cx, y + h, "thin");
    const cw = Math.max(h, textWidth(d, size) + 2);
    ink.text(cx + cw / 2, base, d, size, "middle");
    cx += cw;
  }
  return [x, y, x + w, y + h];
}

/** The tolerance symbol centred at (cx, cy) with half-size s. */
function symbol(ink: Ink, kind: GdtKind, cx: number, cy: number, s: number) {
  switch (kind) {
    case "position":
      ink.circle(cx, cy, s * 0.72, "thin");
      ink.line(cx - s, cy, cx + s, cy);
      ink.line(cx, cy - s, cx, cy + s);
      return;
    case "flatness":
      ink.poly([cx - s * 0.75, cy + s * 0.45, cx + s, cy + s * 0.45, cx + s * 0.75, cy - s * 0.45, cx - s, cy - s * 0.45], "thin", true);
      return;
    case "perpendicularity":
      ink.line(cx - s, cy + s * 0.8, cx + s, cy + s * 0.8);
      ink.line(cx, cy + s * 0.8, cx, cy - s);
      return;
    case "parallelism":
      ink.line(cx - s * 0.7, cy + s * 0.8, cx - s * 0.1, cy - s * 0.9);
      ink.line(cx + s * 0.1, cy + s * 0.8, cx + s * 0.7, cy - s * 0.9);
      return;
    case "runout": {
      // a slanted arrow
      const x0 = cx - s * 0.7;
      const y0 = cy + s * 0.8;
      const x1 = cx + s * 0.6;
      const y1 = cy - s * 0.8;
      ink.line(x0, y0, x1, y1);
      ink.arrow(x1, y1, x1 - x0, y1 - y0, s * 0.8);
      return;
    }
    case "coaxiality":
      ink.circle(cx, cy, s * 0.85, "thin");
      ink.circle(cx, cy, s * 0.45, "thin");
      return;
    case "profile":
      ink.arc(cx, cy + s * 0.5, s * 0.9, 0, Math.PI, "thin");
      ink.line(cx - s * 0.9, cy + s * 0.5, cx + s * 0.9, cy + s * 0.5);
      return;
  }
}

/** Size of a datum letter box. */
export const datumBox = (size: number) => size * 1.75;

/**
 * A datum feature symbol: a filled triangle with its base on the feature at
 * (x, y), a stem along (ux, uy) and the boxed letter at its end. Returns the
 * box around it.
 */
export function inkDatum(ink: Ink, x: number, y: number, ux: number, uy: number, letter: string, size: number, stem = 3): Box {
  const L = Math.hypot(ux, uy) || 1;
  ux /= L;
  uy /= L;
  const t = size * 0.75;
  // triangle: base on the feature, apex toward the box
  const px = -uy;
  const py = ux;
  ink.fill([x + px * t * 0.6, y + py * t * 0.6, x - px * t * 0.6, y - py * t * 0.6, x + ux * t, y + uy * t]);
  const sx = x + ux * (t + stem);
  const sy = y + uy * (t + stem);
  ink.line(x + ux * t, y + uy * t, sx, sy, "thin");
  const b = datumBox(size);
  // box centred on the stem, its near edge at the stem end
  const cx = sx + ux * (b / 2);
  const cy = sy + uy * (b / 2);
  ink.rect(cx - b / 2, cy - b / 2, b, b, "thin");
  ink.text(cx, cy + size * 0.36, letter, size, "middle", { bold: true });
  return [Math.min(x, cx - b / 2), Math.min(y, cy - b / 2), Math.max(x, cx + b / 2), Math.max(y, cy + b / 2)];
}

/** Box a datum symbol would take, for finding room before inking it. */
export function datumExtent(x: number, y: number, ux: number, uy: number, size: number, stem = 3): Box {
  const L = Math.hypot(ux, uy) || 1;
  const t = size * 0.75;
  const b = datumBox(size);
  const cx = x + (ux / L) * (t + stem + b / 2);
  const cy = y + (uy / L) * (t + stem + b / 2);
  return [Math.min(x, cx - b / 2), Math.min(y, cy - b / 2), Math.max(x, cx + b / 2), Math.max(y, cy + b / 2)];
}
