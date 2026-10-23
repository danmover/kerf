// Flat patterns of sheet-metal parts: the flat blank a drawing shows in
// place of the bent part, its bend table, and the 1:1 DXF a laser, punch or
// waterjet cuts from.

import type { EvalPart } from "../core/model";
import type { Prim2 } from "../kernel/drawing";
import { fmtNum } from "./sheet";

/** Space between flat patterns drawn or exported side by side, mm. */
export const FLAT_GAP = 10;

/** The part laid flat: its flat pattern built in the part's own frame, lying on x, y, moved dx along x. */
export function flatPart(p: EvalPart, dx = 0): EvalPart {
  if (!p.sheet) return p;
  return { ...p, recipe: p.sheet.flat, hash: p.sheet.flatHash, xf: dx ? [{ op: "translate", v: [dx, 0, 0] }] : [], gear: undefined };
}

/** Sheet-metal parts laid flat side by side along x, left to right, FLAT_GAP apart. */
export function layFlat(parts: EvalPart[]): EvalPart[] {
  let x = 0;
  return parts.map((p, i) => {
    const [lo, hi] = p.sheet!.flatBox;
    const dx = i ? x - lo[0] : 0;
    x = (i ? x : lo[0]) + (hi[0] - lo[0]) + FLAT_GAP;
    return flatPart(p, dx);
  });
}

/** How far a flat part was moved along x to sit beside the others. */
export const flatShift = (p: EvalPart): number => {
  const t = p.xf[0];
  return t?.op === "translate" ? t.v[0] : 0;
};

/** "B1", "B2", … in the order sheet() recorded the bends. */
export const bendLabel = (i: number) => `B${i + 1}`;

/** Which way a bend goes, seen from the top of the flat (the side the base's flanges stand up from). */
export const bendWay = (angle: number) => (angle >= 0 ? "UP" : "DOWN");

/** Rows of the bend table: each bend's direction, angle and inside radius, then the sheet and K-factor (per part when there are several). */
export function bendRows(parts: EvalPart[]): [string, string][] | null {
  const sheets = parts.filter((p) => p.sheet?.bends.length);
  if (!sheets.length) return null;
  return sheets.flatMap((p) => {
    const s = p.sheet!;
    const tag = sheets.length > 1 ? `${p.label.toUpperCase()} ` : "";
    return [
      ...s.bends.map((b, i): [string, string] => [`${tag}${bendLabel(i)}  ${b.name.toUpperCase()}`, `${bendWay(b.angle)} ${fmtNum(Math.abs(b.angle))}°  R${fmtNum(b.r)}`]),
      [`${tag}THICKNESS`, fmtNum(s.t)],
      [`${tag}K-FACTOR`, fmtNum(s.k, 2)],
    ];
  });
}

// ---------- DXF ----------

/** A 1:1 DXF of flat patterns laid side by side (layFlat): outlines and holes on CUT, bend centre lines on BEND with their direction and angle. */
export function flatsToDxf(flats: { edges: Prim2[]; part: EvalPart }[]): string {
  const out: string[] = [];
  const w = (code: number, v: string | number) => out.push(String(code), typeof v === "number" ? fmt(v) : v);
  w(0, "SECTION");
  w(2, "HEADER");
  w(9, "$ACADVER");
  w(1, "AC1009");
  w(9, "$INSUNITS");
  w(70, 4);
  w(0, "ENDSEC");
  w(0, "SECTION");
  w(2, "TABLES");
  w(0, "TABLE");
  w(2, "LTYPE");
  w(70, 2);
  w(0, "LTYPE");
  w(2, "CONTINUOUS");
  w(70, 0);
  w(3, "Solid line");
  w(72, 65);
  w(73, 0);
  w(40, 0);
  w(0, "LTYPE");
  w(2, "DASHDOT");
  w(70, 0);
  w(3, "Dash dot");
  w(72, 65);
  w(73, 4);
  w(40, 9);
  for (const d of [6, -1.5, 0, -1.5]) w(49, d);
  w(0, "ENDTAB");
  w(0, "TABLE");
  w(2, "LAYER");
  w(70, 3);
  for (const [name, color, lt] of [
    ["CUT", 7, "CONTINUOUS"],
    ["BEND", 1, "DASHDOT"],
    ["NOTES", 3, "CONTINUOUS"],
  ] as const) {
    w(0, "LAYER");
    w(2, name);
    w(70, 0);
    w(62, color);
    w(6, lt);
  }
  w(0, "ENDTAB");
  w(0, "ENDSEC");
  w(0, "SECTION");
  w(2, "ENTITIES");
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => {
    w(0, "LINE");
    w(8, layer);
    w(10, x1);
    w(20, y1);
    w(11, x2);
    w(21, y2);
  };
  const text = (x: number, y: number, h: number, s: string) => {
    w(0, "TEXT");
    w(8, "NOTES");
    w(10, x);
    w(20, y);
    w(40, h);
    w(1, s);
  };
  for (const f of flats) {
    for (const g of f.edges) {
      if (g.t === "L") line("CUT", g.p[0], g.p[1], g.p[2], g.p[3]);
      else if (g.t === "A") {
        const full = g.a1 - g.a0 >= 2 * Math.PI - 1e-9;
        w(0, full ? "CIRCLE" : "ARC");
        w(8, "CUT");
        w(10, g.c[0]);
        w(20, g.c[1]);
        w(40, g.r);
        if (!full) {
          w(50, deg(g.a0));
          w(51, deg(g.a1));
        }
      } else for (let k = 0; k + 3 < g.p.length; k += 2) line("CUT", g.p[k], g.p[k + 1], g.p[k + 2], g.p[k + 3]);
    }
    const s = f.part.sheet!;
    const dx = flatShift(f.part);
    const dy = 0;
    s.bends.forEach((b, i) => {
      const [[x1, y1], [x2, y2]] = b.line;
      line("BEND", x1 + dx, y1 + dy, x2 + dx, y2 + dy);
      text((x1 + x2) / 2 + dx, (y1 + y2) / 2 + dy + 1, 2.5, `${bendLabel(i)} ${bendWay(b.angle)} ${fmtNum(Math.abs(b.angle))} R${fmtNum(b.r)}`);
    });
    text(s.flatBox[0][0] + dx, s.flatBox[0][1] + dy - 6, 3.5, `${f.part.label.replace(/ #1$/, "")}  ${fmtNum(s.t)} MM ${f.part.material.toUpperCase()}  K ${fmtNum(s.k, 2)}`);
  }
  w(0, "ENDSEC");
  w(0, "EOF");
  return out.join("\n") + "\n";
}

const deg = (a: number) => ((((a * 180) / Math.PI) % 360) + 360) % 360;
const fmt = (n: number) => String(Math.round(n * 1e4) / 1e4 || 0);
