// Sheet furniture: the ISO 5457 frame with zones and centring marks, an
// ISO 7200 style title block, the general tolerance strip, the parts list,
// notes and data tables.

import { fmtNum, Ink, type BomLine, type Box } from "./sheet";
import { generalClass, generalTable } from "./spec";
import { fitText, textWidth } from "./text";

export const FRAME = { left: 20, top: 10, right: 10, bottom: 10 };
export const TB_W = 180;

export interface TitleFields {
  title: string;
  subtitle: string;
  material: string;
  finish: string;
  tolerance: string;
  mass: string;
  drawn: string;
  checked: string;
  date: string;
  number: string;
  revision: string;
  scale: string;
  size: string;
  sheet: string;
  projection: "first" | "third";
}

/** Inner drawing frame of a sheet. */
export function frameBox(w: number, h: number): Box {
  return [FRAME.left, FRAME.top, w - FRAME.right, h - FRAME.bottom];
}

export function inkFrame(ink: Ink, w: number, h: number) {
  ink.with("border", () => {
    const [x0, y0, x1, y1] = frameBox(w, h);
    ink.rect(x0, y0, x1 - x0, y1 - y0, "border");
    // zones: numbers across, letters down, about 50 mm each
    const nx = Math.max(2, Math.round((x1 - x0) / 50 / 2) * 2);
    const ny = Math.max(2, Math.round((y1 - y0) / 50 / 2) * 2);
    const zx = (x1 - x0) / nx;
    const zy = (y1 - y0) / ny;
    const size = 2.5;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * zx;
      if (i > 0) {
        ink.line(x, y0, x, y0 - 5, "frame");
        ink.line(x, y1, x, y1 + 5, "frame");
      }
      ink.text(x + zx / 2, y0 - (FRAME.top - size) / 2 - 0.3, String(i + 1), size, "middle");
      ink.text(x + zx / 2, y1 + (FRAME.bottom + size) / 2 - 0.3, String(i + 1), size, "middle");
    }
    for (let j = 0; j < ny; j++) {
      const y = y0 + j * zy;
      if (j > 0) {
        ink.line(x0, y, x0 - 5, y, "frame");
        ink.line(x1, y, x1 + 5, y, "frame");
      }
      const letter = String.fromCharCode(65 + (j % 26));
      ink.text(x0 - FRAME.left / 2 + 2.5, y + zy / 2 + size / 2, letter, size, "middle");
      ink.text(x1 + FRAME.right / 2, y + zy / 2 + size / 2, letter, size, "middle");
    }
    // centring marks
    ink.line(w / 2, 0, w / 2, y0 + 5, "border");
    ink.line(w / 2, h, w / 2, y1, "border");
    ink.line(0, h / 2, x0 + 5, h / 2, "border");
    ink.line(w, h / 2, x1, h / 2, "border");
  });
}

const LABEL = 1.8;

function cell(ink: Ink, x: number, y: number, w: number, h: number, label: string, value: string, size = 3, bold = false) {
  ink.rect(x, y, w, h, "frame");
  ink.text(x + 1.2, y + LABEL + 0.9, label, LABEL);
  if (value) ink.text(x + 1.2, y + h - 1.6, fitText(value, size, w - 2.4, bold), size, "start", { bold });
}

/** Title block anchored at the bottom-right corner of the frame. Returns its box. */
export function inkTitleBlock(ink: Ink, w: number, h: number, f: TitleFields): Box {
  const [, , x1, y1] = frameBox(w, h);
  const x0 = x1 - TB_W;
  const rows = [10, 17, 10];
  const y0 = y1 - rows.reduce((a, b) => a + b, 0);
  ink.with("tb", () => {
    let y = y0;
    // row 1: material, finish, general tolerance, mass
    const r1 = [
      ["MATERIAL", f.material, 45],
      ["FINISH", f.finish, 35],
      ["GENERAL TOLERANCES", f.tolerance, 55],
      ["MASS", f.mass, 45],
    ] as const;
    let x = x0;
    for (const [l, v, cw] of r1) {
      cell(ink, x, y, cw, rows[0], l, v, 2.8);
      x += cw;
    }
    y += rows[0];
    // row 2: brand and title
    ink.rect(x0, y, 45, rows[1], "frame");
    ink.text(x0 + 3, y + 9, "KERF", 6, "start", { bold: true });
    ink.text(x0 + 3, y + 14, "AI-DIRECTED CAD", 2);
    // the brand mark: a saw kerf through a bar
    ink.poly([x0 + 33, y + 4, x0 + 41, y + 4, x0 + 41, y + 9, x0 + 33, y + 9], "frame", true);
    ink.fill([x0 + 36.4, y + 3.4, x0 + 37.6, y + 3.4, x0 + 37.6, y + 9.6, x0 + 36.4, y + 9.6]);
    ink.rect(x0 + 45, y, TB_W - 45, rows[1], "frame");
    ink.text(x0 + 46.2, y + LABEL + 0.9, "TITLE", LABEL);
    ink.text(x0 + 47, y + 10.2, fitText(f.title, 5, TB_W - 49, true), 5, "start", { bold: true });
    if (f.subtitle) ink.text(x0 + 47, y + 15, fitText(f.subtitle, 2.5, TB_W - 49), 2.5);
    y += rows[1];
    // row 3: people, numbers, scale, projection
    const r3 = [
      ["DRAWN", f.drawn, 25],
      ["CHECKED", f.checked, 22],
      ["DATE", f.date, 24],
      ["DRAWING NO.", f.number, 42],
      ["REV", f.revision, 11],
      ["SCALE", f.scale, 15],
      ["SIZE", f.size, 12],
      ["SHEET", f.sheet, 13],
    ] as const;
    x = x0;
    for (const [l, v, cw] of r3) {
      cell(ink, x, y, cw, rows[2], l, v, l === "DRAWING NO." ? 2.6 : 2.6);
      x += cw;
    }
    ink.rect(x, y, x1 - x, rows[2], "frame");
    projectionSymbol(ink, x + (x1 - x) / 2, y + rows[2] / 2 + 0.6, f.projection);
    ink.rect(x0, y0, TB_W, y1 - y0, "border");
  });
  return [x0, y0, x1, y1];
}

/** ISO 5456-2 projection symbol: a truncated cone and its end view. */
export function projectionSymbol(ink: Ink, cx: number, cy: number, projection: "first" | "third") {
  const h = 2.4;
  const cone = (x: number) => ink.poly([x - 1.6, cy - h * 0.5, x + 1.6, cy - h, x + 1.6, cy + h, x - 1.6, cy + h * 0.5], "frame", true);
  const circles = (x: number) => {
    ink.circle(x, cy, h, "frame");
    ink.circle(x, cy, h * 0.5, "frame");
  };
  const left = cx - 2.8;
  const right = cx + 2.8;
  if (projection === "first") {
    cone(left);
    circles(right);
  } else {
    circles(left);
    cone(right);
  }
  ink.line(cx - 5.6, cy, cx + 5.6, cy, "center");
}

/** ISO 2768-1 linear tolerance strip directly above a box. Returns its box. */
export function inkToleranceStrip(ink: Ink, above: Box, tolerance: string): Box | null {
  const cls = generalClass(tolerance);
  if (!cls) return null;
  const rows = generalTable(cls);
  const h = 9;
  const x0 = above[0];
  const y0 = above[1] - h;
  ink.with("tb", () => {
    const lw = 36;
    ink.rect(x0, y0, TB_W, h, "frame");
    ink.text(x0 + 1.2, y0 + 3.6, "LINEAR SIZES (mm)", 1.8);
    ink.text(x0 + 1.2, y0 + 7.6, `ISO 2768-${cls}`, 2.5, "start", { bold: true });
    const cw = (TB_W - lw) / rows.length;
    rows.forEach((r, i) => {
      const x = x0 + lw + i * cw;
      ink.line(x, y0, x, y0 + h, "frame");
      ink.text(x + cw / 2, y0 + 3.6, r.range, 1.8, "middle");
      ink.text(x + cw / 2, y0 + 7.6, `±${fmtNum(r.tol)}`, 2.2, "middle");
    });
    ink.line(x0 + lw, y0 + 4.6, x0 + TB_W, y0 + 4.6, "frame");
  });
  return [x0, y0, x0 + TB_W, above[1]];
}

/** Parts list directly above a box, header at the bottom as ISO 7573 lays it out. */
export function inkPartsList(ink: Ink, above: Box, lines: BomLine[]): Box {
  const rh = 5.5;
  const cols: [string, number][] = [
    ["ITEM", 11],
    ["QTY", 10],
    ["PART", 42],
    ["DESCRIPTION", 80],
    ["MATERIAL", 37],
  ];
  const x0 = above[0];
  const n = lines.length;
  const y1 = above[1];
  const y0 = y1 - (n + 1) * rh;
  ink.with("bom", () => {
    ink.rect(x0, y0, TB_W, y1 - y0, "frame");
    // header row
    const hy = y1 - rh;
    let x = x0;
    for (const [label, cw] of cols) {
      ink.rect(x, hy, cw, rh, "frame");
      ink.text(x + 1.2, hy + rh - 1.7, label, 2, "start", { bold: true });
      x += cw;
    }
    // rows above the header, item 1 nearest it
    lines.forEach((l, i) => {
      const y = hy - (i + 1) * rh;
      let cx = x0;
      const values = [String(l.item), String(l.qty), l.name, l.description, l.material];
      cols.forEach(([, cw], k) => {
        ink.line(cx, y, cx, y + rh, "frame");
        const v = fitText(values[k], 2.5, cw - 2.4);
        if (k < 2) ink.text(cx + cw / 2, y + rh - 1.6, v, 2.5, "middle");
        else ink.text(cx + 1.2, y + rh - 1.6, v, 2.5);
        cx += cw;
      });
      ink.line(x0, y, x0 + TB_W, y, "frame");
    });
  });
  return [x0, y0, x0 + TB_W, y1];
}

/** Word-wraps text to a width. */
export function wrap(s: string, size: number, maxW: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (textWidth(next, size) <= maxW || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Numbered general notes, bottom-aligned at a corner. Returns the box used. */
export function inkNotes(ink: Ink, x0: number, bottom: number, maxW: number, notes: string[], size: number): Box | null {
  if (!notes.length) return null;
  const lh = size * 1.55;
  const body: { num: string; s: string }[] = [];
  notes.forEach((n, i) => wrap(n, size, maxW - 6).forEach((s, k) => body.push({ num: k === 0 ? `${i + 1}.` : "", s })));
  const h = (body.length + 1) * lh + 1;
  const y0 = bottom - h;
  ink.with("n", () => {
    ink.text(x0, y0 + size, "NOTES", size, "start", { bold: true });
    body.forEach((b, i) => {
      const y = y0 + size + (i + 1) * lh;
      if (b.num) ink.text(x0, y, b.num, size);
      ink.text(x0 + 6, y, b.s, size);
    });
  });
  const w = Math.max(20, ...body.map((b) => textWidth(b.s, size) + 6));
  return [x0, y0, x0 + w, bottom];
}

/** A two-column data table (gear data and the like), bottom-aligned. */
export function inkDataTable(ink: Ink, x0: number, bottom: number, title: string, rows: [string, string][], key: string): Box {
  const rh = 5;
  const w1 = Math.max(...rows.map((r) => textWidth(r[0], 2.5))) + 4;
  const w2 = Math.max(...rows.map((r) => textWidth(r[1], 2.5)), textWidth(title, 2.5, true) - w1 + 4) + 4;
  const h = (rows.length + 1) * rh;
  const y0 = bottom - h;
  ink.with(key, () => {
    ink.rect(x0, y0, w1 + w2, h, "frame");
    ink.text(x0 + 1.5, y0 + rh - 1.5, title, 2.5, "start", { bold: true });
    rows.forEach(([a, b], i) => {
      const y = y0 + (i + 1) * rh;
      ink.line(x0, y, x0 + w1 + w2, y, "frame");
      ink.text(x0 + 1.5, y + rh - 1.5, a, 2.5);
      ink.text(x0 + w1 + 1.5, y + rh - 1.5, b, 2.5);
    });
    ink.line(x0 + w1, y0 + rh, x0 + w1, y0 + h, "frame");
  });
  return [x0, y0, x0 + w1 + w2, bottom];
}
