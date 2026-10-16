// The Kerf mark's geometry: an isometric block sawn in two, with the hot
// cut face showing through the kerf. Shared by the animated React mark, the
// favicon and the exported design report, so all three draw the same shape.

type Pt = [number, number];

// isometric axes in a 40 × 40 box: origin at the bottom front corner
const O: Pt = [20, 36];
const X: Pt = [13.5, -7.8];
const Y: Pt = [-13.5, -7.8];
const Z: Pt = [0, -15.6];

const P = (x: number, y: number, z: number): Pt => [O[0] + x * X[0] + y * Y[0] + z * Z[0], O[1] + x * X[1] + y * Y[1] + z * Z[1]];
const poly = (...pts: Pt[]) => pts.map((p) => `${+p[0].toFixed(2)},${+p[1].toFixed(2)}`).join(" ");

// the cut leans: it leaves the top face further back than it leaves the bottom
const XT = 0.63;
const XB = 0.37;

export const MARK = {
  /** the near piece */
  a: {
    left: poly(P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)),
    top: poly(P(0, 0, 1), P(XT, 0, 1), P(XT, 1, 1), P(0, 1, 1)),
    front: poly(P(0, 0, 0), P(XB, 0, 0), P(XT, 0, 1), P(0, 0, 1)),
  },
  /** the far piece, whose sawn face glows through the gap */
  b: {
    cut: poly(P(XB, 0, 0), P(XT, 0, 1), P(XT, 1, 1), P(XB, 1, 0)),
    top: poly(P(XT, 0, 1), P(1, 0, 1), P(1, 1, 1), P(XT, 1, 1)),
    front: poly(P(XB, 0, 0), P(1, 0, 0), P(1, 0, 1), P(XT, 0, 1)),
  },
  /** where the blade went in: across the top, then down the front */
  laser: `M${poly(P(XT, 1, 1))} L${poly(P(XT, 0, 1))} L${poly(P(XB, 0, 0))}`,
  /** light catching the near edges of each piece */
  rimA: `M${poly(P(0, 1, 1))} L${poly(P(0, 0, 1))} L${poly(P(XT, 0, 1))} M${poly(P(0, 0, 1))} L${poly(P(0, 0, 0))}`,
  rimB: `M${poly(P(XT, 0, 1))} L${poly(P(1, 0, 1))}`,
  /** how far each piece moves per unit of split (along the cut's normal, roughly) */
  splitDir: X,
};

export const MARK_COLORS = {
  top: ["#dfe6ff", "#9db0ff"],
  left: ["#7d92ff", "#4a5bd6"],
  front: ["#4b3fb4", "#2a2470"],
  hot: ["#ffe08a", "#ff8a4c", "#ff3d7f"],
};

/** The mark as a standalone SVG string (no animation), for files Kerf writes. */
export function markSvg(size = 40, split = 0.06, id = "km"): string {
  const [dx, dy] = [MARK.splitDir[0] * split, MARK.splitDir[1] * split];
  const C = MARK_COLORS;
  const lg = (name: string, stops: string[], x2 = 0, y2 = 1) =>
    `<linearGradient id="${id}-${name}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map((s, i) => `<stop offset="${i / (stops.length - 1)}" stop-color="${s}"/>`).join("")}</linearGradient>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">` +
    `<defs>${lg("top", C.top)}${lg("left", C.left)}${lg("front", C.front, 1, 1)}${lg("hot", C.hot, 0, 1)}</defs>` +
    `<g transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)})"><polygon points="${MARK.b.cut}" fill="url(#${id}-hot)"/><polygon points="${MARK.b.top}" fill="url(#${id}-top)"/><polygon points="${MARK.b.front}" fill="url(#${id}-front)"/></g>` +
    `<g transform="translate(${(-dx).toFixed(2)} ${(-dy).toFixed(2)})"><polygon points="${MARK.a.left}" fill="url(#${id}-left)"/><polygon points="${MARK.a.top}" fill="url(#${id}-top)"/><polygon points="${MARK.a.front}" fill="url(#${id}-front)"/></g>` +
    `</svg>`
  );
}
