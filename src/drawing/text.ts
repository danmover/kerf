// Text metrics for drawing layout. Sheets use Helvetica in PDF and a
// Helvetica-compatible sans in SVG, so one width table lays out all formats.

// Helvetica advance widths (1/1000 em) for ASCII 32..126
const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const EXTRA: Record<string, number> = { "Ø": 778, "±": 584, "°": 400, "×": 584, "·": 278, "–": 556, "—": 1000, "…": 1000, "²": 333, "³": 333, "µ": 556, "’": 222, "“": 333, "”": 333 };

/** Width of a string in mm at the given text height (cap height ≈ 0.72 em, so size is the em size). */
export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? ASCII[c - 32] : (EXTRA[ch] ?? 556);
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

/** Shortens text with an ellipsis so it fits a width. */
export function fitText(s: string, size: number, maxW: number, bold = false): string {
  if (textWidth(s, size, bold) <= maxW) return s;
  // the longest prefix that fits with the ellipsis, found by halving
  let lo = 1;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(s.slice(0, mid) + "…", size, bold) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + "…";
}

/** WinAnsi byte for a character, for PDF base-14 fonts (unknown characters become "?"). */
export function winAnsi(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  const map: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "‰": 0x89, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99, "−": 0x2d };
  return map[ch] ?? 0x3f;
}
