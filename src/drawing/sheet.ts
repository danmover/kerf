// The drawing sheet document: paper-space geometry (millimetres, origin at
// the top-left corner, y down) with line styles and interaction keys, plus
// what each view, dimension and part on the sheet means. One sheet renders
// to the on-screen viewer, SVG, PDF and DXF.

import type { Span } from "../lang/ast";
import type { V3 } from "../kernel/recipe";
import type { DrawingSpec, SheetSize, ViewKind } from "./spec";
import { textWidth } from "./text";

/** ISO 128 line types. */
export type Pen = "visible" | "hidden" | "center" | "thin" | "hatch" | "border" | "frame" | "phantom" | "fill" | "cutting";

export const PENS: Record<Pen, { w: number; dash?: number[]; layer: string; color: number }> = {
  visible: { w: 0.5, layer: "VISIBLE", color: 7 },
  hidden: { w: 0.25, dash: [3, 1.5], layer: "HIDDEN", color: 8 },
  center: { w: 0.18, dash: [8, 1.5, 1.2, 1.5], layer: "CENTER", color: 1 },
  thin: { w: 0.25, layer: "DIM", color: 3 },
  hatch: { w: 0.18, layer: "HATCH", color: 8 },
  border: { w: 0.7, layer: "BORDER", color: 7 },
  frame: { w: 0.35, layer: "BORDER", color: 7 },
  phantom: { w: 0.25, dash: [6, 1.5, 1.2, 1.5, 1.2, 1.5], layer: "PHANTOM", color: 6 },
  cutting: { w: 0.25, dash: [8, 1.5, 1.2, 1.5], layer: "CUTTING", color: 1 },
  fill: { w: 0, layer: "DIM", color: 3 },
};

export type Geom =
  | { t: "line"; p: [number, number, number, number] }
  /** angles in radians, counter-clockwise as seen on paper; a full circle when a1 - a0 ≥ 2π */
  | { t: "arc"; c: [number, number]; r: number; a0: number; a1: number }
  | { t: "poly"; p: number[]; closed?: boolean }
  /** a filled polygon (arrowheads, markers) */
  | { t: "fill"; p: number[] }
  /** text on its baseline; rot in degrees counter-clockwise on paper */
  | { t: "text"; at: [number, number]; s: string; size: number; anchor: "start" | "middle" | "end"; rot?: number; bold?: boolean };

/**
 * key says what the shape belongs to, for hover and click: "v2:p5" (part 5
 * in view 2), "v2" (view 2 decoration), "d7" (dimension 7), "n" (notes),
 * "tb" (title block), "bom" (parts list), "b5" (balloon for part 5), "border".
 */
export type Shape = Geom & { pen: Pen; key: string };

export type Box = [number, number, number, number];

export interface Frame {
  /** camera direction, from the model toward the viewer */
  dir: V3;
  /** right on the sheet */
  x: V3;
  /** up on the sheet */
  y: V3;
}

export interface SheetView {
  kind: ViewKind | "section" | "detail";
  /** "front", "A" for SECTION A-A, "B" for DETAIL B */
  name: string;
  /** label printed under the view (empty for unlabeled principal views) */
  label: string;
  scale: number;
  frame: Frame;
  /** sheet position of the view-space origin */
  origin: [number, number];
  /** sheet box of the view geometry */
  box: Box;
  state: "ready" | "pending" | "error";
  error?: string;
  /** source span of the statement that asked for this view */
  span?: Span;
  /** what the user can ask to change about this view */
  hint: string;
}

export interface SheetDim {
  view: number;
  /** "linear" dimensions, "diameter" and "radius" callouts, hole "callout" leaders */
  kind: "linear" | "diameter" | "radius" | "callout";
  value: number;
  text: string;
  tol?: [number, number];
  fit?: string;
  /** ± from the general tolerance class when no tolerance is given */
  general?: number;
  /** a parameter whose value this dimension shows */
  param?: string;
  auto: boolean;
  span?: Span;
  /** plain description, e.g. "Overall width of base" */
  label: string;
  part?: string;
  box: Box;
  /** model points the dimension measures between, when known */
  a?: V3;
  b?: V3;
}

export interface SheetPart {
  id: string;
  name: string;
  label: string;
  /** item number in the parts list */
  item?: number;
}

export interface BomLine {
  item: number;
  qty: number;
  name: string;
  description: string;
  material: string;
  ids: string[];
}

export interface Sheet {
  name: string;
  title: string;
  auto: boolean;
  size: SheetSize;
  orientation: "landscape" | "portrait";
  w: number;
  h: number;
  scale: number;
  shapes: Shape[];
  views: SheetView[];
  dims: SheetDim[];
  parts: SheetPart[];
  bom: BomLine[];
  notes: string[];
  warnings: string[];
  /** views still waiting for their projection */
  pending: number;
  spec: DrawingSpec;
  /** box of the title block, for the viewer */
  titleBox: Box;
}

// ---------- building shapes ----------

export class Ink {
  shapes: Shape[] = [];
  constructor(public key = "") {}

  with<T>(key: string, fn: () => T): T {
    const prev = this.key;
    this.key = key;
    try {
      return fn();
    } finally {
      this.key = prev;
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, pen: Pen = "thin") {
    if (Math.hypot(x2 - x1, y2 - y1) < 1e-6) return;
    this.shapes.push({ t: "line", p: [x1, y1, x2, y2], pen, key: this.key });
  }

  rect(x: number, y: number, w: number, h: number, pen: Pen = "frame") {
    this.shapes.push({ t: "poly", p: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true, pen, key: this.key });
  }

  poly(p: number[], pen: Pen, closed = false) {
    if (p.length >= 4) this.shapes.push({ t: "poly", p, closed, pen, key: this.key });
  }

  arc(cx: number, cy: number, r: number, a0: number, a1: number, pen: Pen) {
    if (r > 1e-6) this.shapes.push({ t: "arc", c: [cx, cy], r, a0, a1, pen, key: this.key });
  }

  circle(cx: number, cy: number, r: number, pen: Pen) {
    this.arc(cx, cy, r, 0, Math.PI * 2, pen);
  }

  fill(p: number[]) {
    this.shapes.push({ t: "fill", p, pen: "fill", key: this.key });
  }

  text(x: number, y: number, s: string, size: number, anchor: "start" | "middle" | "end" = "start", opts: { rot?: number; bold?: boolean } = {}) {
    if (!s) return;
    this.shapes.push({ t: "text", at: [x, y], s, size, anchor, rot: opts.rot, bold: opts.bold, pen: "thin", key: this.key });
  }

  /** Filled arrowhead with its tip at (x, y), pointing along (dx, dy). ISO: 3 mm long, 15° flank. */
  arrow(x: number, y: number, dx: number, dy: number, len = 3) {
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const w = len * 0.18;
    const bx = x - ux * len;
    const by = y - uy * len;
    this.fill([x, y, bx - uy * w, by + ux * w, bx + uy * w, by - ux * w]);
  }

  dot(x: number, y: number, r = 0.5) {
    const n = 10;
    const p: number[] = [];
    for (let i = 0; i < n; i++) p.push(x + r * Math.cos((i / n) * Math.PI * 2), y + r * Math.sin((i / n) * Math.PI * 2));
    this.fill(p);
  }
}

// ---------- geometry helpers ----------

export function emptyBox(): Box {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

export function growBox(b: Box, x: number, y: number) {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

export function boxOk(b: Box) {
  return Number.isFinite(b[0]) && b[2] >= b[0] && b[3] >= b[1];
}

export function boxesOverlap(a: Box, b: Box, pad = 0) {
  return a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;
}

/** Sheet-space bounding box of a shape (text included, rotated text approximated). */
export function shapeBox(s: Shape): Box {
  const b = emptyBox();
  switch (s.t) {
    case "line":
      growBox(b, s.p[0], s.p[1]);
      growBox(b, s.p[2], s.p[3]);
      break;
    case "arc":
      if (s.a1 - s.a0 >= Math.PI * 2 - 1e-9) {
        growBox(b, s.c[0] - s.r, s.c[1] - s.r);
        growBox(b, s.c[0] + s.r, s.c[1] + s.r);
      } else {
        for (const a of arcSamples(s.a0, s.a1)) growBox(b, s.c[0] + s.r * Math.cos(a), s.c[1] - s.r * Math.sin(a));
      }
      break;
    case "poly":
    case "fill":
      for (let i = 0; i < s.p.length; i += 2) growBox(b, s.p[i], s.p[i + 1]);
      break;
    case "text": {
      const w = textWidth(s.s, s.size, s.bold);
      const x0 = s.anchor === "start" ? 0 : s.anchor === "middle" ? -w / 2 : -w;
      const corners: [number, number][] = [
        [x0, 0.25 * s.size],
        [x0 + w, 0.25 * s.size],
        [x0, -0.8 * s.size],
        [x0 + w, -0.8 * s.size],
      ];
      const a = ((s.rot ?? 0) * Math.PI) / 180;
      for (const [x, y] of corners) growBox(b, s.at[0] + x * Math.cos(a) + y * Math.sin(a), s.at[1] - x * Math.sin(a) + y * Math.cos(a));
      break;
    }
  }
  return b;
}

/** Angles at the arc ends and at every axis crossing inside the sweep. */
export function arcSamples(a0: number, a1: number): number[] {
  const out = [a0, a1];
  const start = Math.ceil(a0 / (Math.PI / 2));
  for (let k = start; k * (Math.PI / 2) < a1; k++) out.push(k * (Math.PI / 2));
  return out;
}

/** Number formatting for dimensions: up to two decimals, no trailing zeros. */
export function fmtNum(v: number, digits = 2): string {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  const s = r.toFixed(digits).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** Deviation text: +0.015, -0.1, 0 */
export function fmtDev(v: number): string {
  if (Math.abs(v) < 1e-9) return "0";
  const s = Math.abs(v)
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return (v > 0 ? "+" : "−") + s;
}
