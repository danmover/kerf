// A single-stroke font for silkscreen text. Glyphs sit on a grid 4 units
// wide with capitals 6 units tall, lowercase 4, descenders to -2; curves are
// cut to octagons, which reads fine at 1 mm with 0.15 mm strokes and keeps
// the Gerber small. Each glyph is polylines of "x y" pairs split by "|".

import type { Pt } from "./geom";

const O = "1 0 3 0 4 1 4 5 3 6 1 6 0 5 0 1 1 0";
const o = "1 0 3 0 4 1 4 3 3 4 1 4 0 3 0 1 1 0";
const bowlR = "4 3 3 4 1 4 0 3 0 1 1 0 3 0 4 1";

const GLYPHS: Record<string, string> = {
  A: "0 0 2 6 4 0|0.7 2 3.3 2",
  B: "0 0 0 6 3 6 4 5 4 4 3 3 0 3|3 3 4 2 4 1 3 0 0 0",
  C: "4 5 3 6 1 6 0 5 0 1 1 0 3 0 4 1",
  D: "0 0 0 6 2.5 6 4 4.5 4 1.5 2.5 0 0 0",
  E: "4 6 0 6 0 0 4 0|0 3 3 3",
  F: "4 6 0 6 0 0|0 3 3 3",
  G: "4 5 3 6 1 6 0 5 0 1 1 0 3 0 4 1 4 3 2 3",
  H: "0 0 0 6|4 0 4 6|0 3 4 3",
  I: "1 0 3 0|2 0 2 6|1 6 3 6",
  J: "4 6 4 1 3 0 1 0 0 1 0 2",
  K: "0 0 0 6|4 6 0 2|1.3 3.3 4 0",
  L: "0 6 0 0 4 0",
  M: "0 0 0 6 2 3 4 6 4 0",
  N: "0 0 0 6 4 0 4 6",
  O,
  P: "0 0 0 6 3 6 4 5 4 4 3 3 0 3",
  Q: `${O}|2.5 1.5 4 0`,
  R: "0 0 0 6 3 6 4 5 4 4 3 3 0 3|2 3 4 0",
  S: "4 5 3 6 1 6 0 5 0 4 1 3 3 3 4 2 4 1 3 0 1 0 0 1",
  T: "0 6 4 6|2 6 2 0",
  U: "0 6 0 1 1 0 3 0 4 1 4 6",
  V: "0 6 2 0 4 6",
  W: "0 6 1 0 2 3 3 0 4 6",
  X: "0 0 4 6|0 6 4 0",
  Y: "0 6 2 3 4 6|2 3 2 0",
  Z: "0 6 4 6 0 0 4 0",
  a: `4 4 4 0|${bowlR}`,
  b: "0 6 0 0|0 3 1 4 3 4 4 3 4 1 3 0 1 0 0 1",
  c: "4 3 3 4 1 4 0 3 0 1 1 0 3 0 4 1",
  d: `4 6 4 0|${bowlR}`,
  e: "0 2 4 2 4 3 3 4 1 4 0 3 0 1 1 0 3.5 0",
  f: "3.5 6 2.5 6 1.5 5 1.5 0|0 4 3 4",
  g: `4 4 4 -1 3 -2 1 -2 0 -1.2|${bowlR}`,
  h: "0 6 0 0|0 3 1 4 3 4 4 3 4 0",
  i: "0.5 0 0.5 4|0.5 5.3 0.5 5.8",
  j: "2 4 2 -1 1 -2 0 -2|2 5.3 2 5.8",
  k: "0 6 0 0|3.5 4 0 1.5|1.2 2.4 3.5 0",
  l: "0.5 6 0.5 0.6 1.1 0",
  m: "0 0 0 4|0 3 1 4 1.6 4 2.5 3 2.5 0|2.5 3 3.4 4 4 4 5 3 5 0",
  n: "0 0 0 4|0 3 1 4 3 4 4 3 4 0",
  o,
  p: "0 4 0 -2|0 3 1 4 3 4 4 3 4 1 3 0 1 0 0 1",
  q: `4 4 4 -2|${bowlR}`,
  r: "0 0 0 4|0 2.5 1.5 4 3.5 4",
  s: "4 3.5 3.5 4 0.5 4 0 3.5 0 2.5 0.5 2 3.5 2 4 1.5 4 0.5 3.5 0 0.5 0 0 0.5",
  t: "1.5 6 1.5 1 2.5 0 3.5 0|0 4 3 4",
  u: "0 4 0 1 1 0 3 0 4 1|4 4 4 0",
  v: "0 4 2 0 4 4",
  w: "0 4 1 0 2 2.5 3 0 4 4",
  x: "0 0 4 4|0 4 4 0",
  y: "0 4 2 0|4 4 1.2 -1.6 0.5 -2 0 -2",
  z: "0 4 4 4 0 0 4 0",
  "0": `${O}|0.8 1.2 3.2 4.8`,
  "1": "1 5 2 6 2 0|1 0 3 0",
  "2": "0 5 1 6 3 6 4 5 4 4 0 0 4 0",
  "3": "0 5 1 6 3 6 4 5 4 4 3 3 1.5 3|3 3 4 2 4 1 3 0 1 0 0 1",
  "4": "3 0 3 6 0 1.8 4 1.8",
  "5": "4 6 0 6 0 3.5 3 3.5 4 2.5 4 1 3 0 1 0 0 1",
  "6": "4 5 3 6 1 6 0 5 0 1 1 0 3 0 4 1 4 2.5 3 3.5 1 3.5 0 2.5",
  "7": "0 6 4 6 1.5 0",
  "8": "1 3 0 4 0 5 1 6 3 6 4 5 4 4 3 3 1 3 0 2 0 1 1 0 3 0 4 1 4 2 3 3",
  "9": "0 1 1 0 3 0 4 1 4 5 3 6 1 6 0 5 0 3.5 1 2.5 3 2.5 4 3.5",
  "+": "2 1 2 5|0 3 4 3",
  "-": "0.5 3 3.5 3",
  "−": "0.5 3 3.5 3",
  ".": "0.5 0 0.5 0.4",
  ",": "0.8 0.5 0.3 -1",
  "/": "0 0 4 6",
  "(": "2 6 1 5 0.6 3 1 1 2 0",
  ")": "0 6 1 5 1.4 3 1 1 0 0",
  "µ": "0 4 0 -2|0 1 1 0 3 0 4 1|4 4 4 0",
  "μ": "0 4 0 -2|0 1 1 0 3 0 4 1|4 4 4 0",
  "Ω": "0 0 1.3 0 1.3 1.2 0.3 2.2 0 3.5 0.5 5.2 1.5 6 2.5 6 3.5 5.2 4 3.5 3.7 2.2 2.7 1.2 2.7 0 4 0",
  "#": "1.2 0.5 1.6 5.5|2.8 0.5 3.2 5.5|0 2 4 2|0 4 4 4",
  ":": "0.5 0.4 0.5 0.8|0.5 3 0.5 3.4",
  "=": "0 2 4 2|0 4 4 4",
  _: "0 -1 4 -1",
  "%": "0 0 4 6|0.5 5.5 0.5 4.5|3.5 1.5 3.5 0.5",
  "'": "0.5 6 0.5 4.5",
  '"': "0.5 6 0.5 4.5|2 6 2 4.5",
  "!": "0.5 6 0.5 2|0.5 0.4 0.5 0",
  "?": "0 5 1 6 3 6 4 5 4 4 2 3 2 1.8|2 0.4 2 0",
  "*": "2 1.5 2 4.5|0.7 2.2 3.3 3.8|0.7 3.8 3.3 2.2",
  "&": "4 0 1 4.5 1 5.5 1.5 6 2.5 6 3 5.5 3 4.5 0 2 0 1 1 0 2.5 0 4 2",
  "<": "4 5 0 3 4 1",
  ">": "0 5 4 3 0 1",
  "[": "2 6 0.5 6 0.5 0 2 0",
  "]": "0 6 1.5 6 1.5 0 0 0",
  "~": "0 2.6 1 3.4 3 2.6 4 3.4",
  "°": "0.5 5.5 1 6 1.5 5.5 1 5 0.5 5.5",
};

/** Unknown characters print as a small box so a typo is visible on the board. */
const UNKNOWN = "0.5 0 3.5 0 3.5 6 0.5 6 0.5 0";

interface Glyph {
  lines: Pt[][];
  /** right edge of the ink, in units */
  width: number;
}

const cache = new Map<string, Glyph>();

function glyph(ch: string): Glyph {
  let g = cache.get(ch);
  if (g) return g;
  const src = ch === " " ? "" : (GLYPHS[ch] ?? UNKNOWN);
  const lines = src
    ? src.split("|").map((l) => {
        const n = l.trim().split(/\s+/).map(Number);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
        return pts;
      })
    : [];
  const width = ch === " " ? 2.5 : Math.max(0, ...lines.flat().map((p) => p[0]));
  g = { lines, width };
  cache.set(ch, g);
  return g;
}

/** Space between letters, in units. */
const GAP = 2;

/** Width of a line of text in units of cap height / 6. */
function unitsWide(text: string): number {
  let w = 0;
  const chars = [...text];
  chars.forEach((ch, i) => {
    w += glyph(ch).width + (i < chars.length - 1 ? GAP : 0);
  });
  return w;
}

/** Size of a text with capitals `size` mm tall: width, and how far ink reaches above and below the baseline. */
export function textBox(text: string, size: number): { w: number; up: number; down: number } {
  const k = size / 6;
  const desc = /[gjpqy,_µμ]/.test(text) ? 2 : 0;
  return { w: unitsWide(text) * k, up: size, down: desc * k };
}

export interface TextOpts {
  size: number;
  /** degrees counter-clockwise; 0 reads left to right, 90 bottom to top */
  rot?: number;
  /** where (x, y) sits on the text: its centre (default) or the left end of the baseline */
  anchor?: "centre" | "left";
  /** mirror left-right about (x, y): bottom-side text, read from below */
  mirror?: boolean;
}

/** Polylines (in mm, board coordinates) that write `text` at (x, y). */
export function textStrokes(text: string, x: number, y: number, opts: TextOpts): Pt[][] {
  const k = opts.size / 6;
  const total = unitsWide(text);
  // centre on the capitals' middle so mixed-case text looks centred
  const ox = opts.anchor === "left" ? 0 : -total / 2;
  const oy = opts.anchor === "left" ? 0 : -3;
  const a = ((opts.rot ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = opts.mirror ? -1 : 1;
  const out: Pt[][] = [];
  let cx = 0;
  for (const ch of text) {
    const g = glyph(ch);
    for (const line of g.lines)
      out.push(
        line.map(([gx, gy]) => {
          const lx = (ox + cx + gx) * k;
          const ly = (oy + gy) * k;
          const rx = c * lx - s * ly;
          const ry = s * lx + c * ly;
          return [Math.round((x + m * rx) * 1e4) / 1e4, Math.round((y + ry) * 1e4) / 1e4];
        }),
      );
    cx += g.width + GAP;
  }
  return out;
}

/** Every character the font draws (for tests and the editor). */
export const FONT_CHARS = Object.keys(GLYPHS).join("");
