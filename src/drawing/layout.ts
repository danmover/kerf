// Sheet layout: principal views on a projection grid that keeps them
// aligned, then the iso view, sections and details packed into the space
// that is left, clear of the title block and tables.

import type { Box } from "./sheet";

export interface LayoutItem {
  /** view-space extents [u0, v0, u1, v1] in model mm */
  ext: [number, number, number, number];
  scale: number;
  margin: { top: number; right: number; bottom: number; left: number };
  /** projection grid cell relative to the front view */
  grid?: [number, number];
  /** explicit sheet position of the view centre */
  at?: [number, number];
  /** preferred sheet point for the item's centre when packing */
  prefer?: [number, number];
}

export interface LayoutResult {
  origins: [number, number][];
  /** sheet boxes including margins */
  boxes: Box[];
  /** box of the principal view group */
  group: Box | null;
}

const outerSize = (it: LayoutItem): [number, number] => [
  (it.ext[2] - it.ext[0]) * it.scale + it.margin.left + it.margin.right,
  (it.ext[3] - it.ext[1]) * it.scale + it.margin.top + it.margin.bottom,
];

/** Origin of an item placed with its outer box's top-left corner at (x, y). */
const originAt = (it: LayoutItem, x: number, y: number): [number, number] => [x + it.margin.left - it.ext[0] * it.scale, y + it.margin.top + it.ext[3] * it.scale];

export function layoutSheet(items: LayoutItem[], area: Box, fixed: Box[], gap: number): LayoutResult | null {
  const origins: [number, number][] = items.map(() => [0, 0]);
  const boxes: Box[] = items.map(() => [0, 0, 0, 0]);
  const occupied: Box[] = [...fixed];

  // ---- principal views on the projection grid
  const grid = items.map((it, i) => ({ it, i })).filter(({ it }) => it.grid && !it.at);
  let group: Box | null = null;
  if (grid.length) {
    const cols = [...new Set(grid.map(({ it }) => it.grid![0]))].sort((a, b) => a - b);
    const rows = [...new Set(grid.map(({ it }) => it.grid![1]))].sort((a, b) => a - b);
    const colL = new Map<number, number>();
    const colR = new Map<number, number>();
    const rowT = new Map<number, number>();
    const rowB = new Map<number, number>();
    for (const { it } of grid) {
      const [c, r] = it.grid!;
      // views need not contain the origin, so reaches can be negative
      colL.set(c, Math.max(colL.get(c) ?? -Infinity, -it.ext[0] * it.scale + it.margin.left));
      colR.set(c, Math.max(colR.get(c) ?? -Infinity, it.ext[2] * it.scale + it.margin.right));
      rowT.set(r, Math.max(rowT.get(r) ?? -Infinity, it.ext[3] * it.scale + it.margin.top));
      rowB.set(r, Math.max(rowB.get(r) ?? -Infinity, -it.ext[1] * it.scale + it.margin.bottom));
    }
    const colX = new Map<number, number>();
    let x = area[0];
    for (const c of cols) {
      colX.set(c, x + colL.get(c)!);
      x += colL.get(c)! + colR.get(c)! + gap;
    }
    const rowY = new Map<number, number>();
    let y = area[1];
    for (const r of rows) {
      rowY.set(r, y + rowT.get(r)!);
      y += rowT.get(r)! + rowB.get(r)! + gap;
    }
    const w = x - gap - area[0];
    const h = y - gap - area[1];
    if (area[0] + w > area[2] + 1e-6 || area[1] + h > area[3] + 1e-6) return null;
    // the group's empty cells may hold the notes or the title block, so only
    // its views have to keep clear of them; slide it until they do
    const sx = area[2] - area[0] - w;
    const sy = area[3] - area[1] - h;
    const tries: [number, number][] = [[0, 0]];
    for (const f of [0.25, 0.5, 0.75, 1]) tries.push([sx * f, 0], [0, sy * f], [sx * f, sy * f]);
    const at = tries.find(([dx, dy]) => grid.every(({ it }) => !fixed.some((f) => overlaps(f, boxOf(it, [colX.get(it.grid![0])! + dx, rowY.get(it.grid![1])! + dy])))));
    if (!at) return null;
    group = [area[0] + at[0], area[1] + at[1], area[0] + at[0] + w, area[1] + at[1] + h];
    for (const { it, i } of grid) {
      origins[i] = [colX.get(it.grid![0])! + at[0], rowY.get(it.grid![1])! + at[1]];
      boxes[i] = boxOf(it, origins[i]);
      occupied.push(boxes[i]);
    }
  }

  // ---- views placed by hand
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.at) continue;
    const cu = (it.ext[0] + it.ext[2]) / 2;
    const cv = (it.ext[1] + it.ext[3]) / 2;
    origins[i] = [it.at[0] - cu * it.scale, it.at[1] + cv * it.scale];
    boxes[i] = boxOf(it, origins[i]);
    occupied.push(boxes[i]);
  }

  // ---- the rest, packed into free rectangles
  let free: Box[] = [area];
  for (const o of occupied) free = subtract(free, pad(o, gap));
  const rest = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.grid && !it.at);
  // big items first
  rest.sort((a, b) => outerSize(b.it)[0] * outerSize(b.it)[1] - outerSize(a.it)[0] * outerSize(a.it)[1]);
  for (const { it, i } of rest) {
    const [w, h] = outerSize(it);
    const prefer = it.prefer ?? [area[2], area[1]];
    let best: { x: number; y: number; score: number } | null = null;
    for (const f of free) {
      if (f[2] - f[0] < w - 1e-6 || f[3] - f[1] < h - 1e-6) continue;
      // try the position in this rectangle closest to the preferred point
      const x = clamp(prefer[0] - w / 2, f[0], f[2] - w);
      const y = clamp(prefer[1] - h / 2, f[1], f[3] - h);
      const score = Math.hypot(x + w / 2 - prefer[0], y + h / 2 - prefer[1]);
      if (!best || score < best.score) best = { x, y, score };
    }
    if (!best) return null;
    origins[i] = originAt(it, best.x, best.y);
    boxes[i] = [best.x, best.y, best.x + w, best.y + h];
    free = subtract(free, pad(boxes[i], gap));
  }
  return { origins, boxes, group };
}

function boxOf(it: LayoutItem, o: [number, number]): Box {
  return [o[0] + it.ext[0] * it.scale - it.margin.left, o[1] - it.ext[3] * it.scale - it.margin.top, o[0] + it.ext[2] * it.scale + it.margin.right, o[1] - it.ext[1] * it.scale + it.margin.bottom];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pad = (b: Box, g: number): Box => [b[0] - g, b[1] - g, b[2] + g, b[3] + g];

function overlaps(a: Box, b: Box) {
  return a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
}

/** MaxRects split: free rectangles minus an occupied one, keeping only maximal pieces. */
function subtract(free: Box[], o: Box): Box[] {
  const out: Box[] = [];
  for (const f of free) {
    if (!overlaps(f, o)) {
      out.push(f);
      continue;
    }
    if (o[0] > f[0]) out.push([f[0], f[1], o[0], f[3]]);
    if (o[2] < f[2]) out.push([o[2], f[1], f[2], f[3]]);
    if (o[1] > f[1]) out.push([f[0], f[1], f[2], o[1]]);
    if (o[3] < f[3]) out.push([f[0], o[3], f[2], f[3]]);
  }
  const keep = out.filter((b) => b[2] - b[0] > 1 && b[3] - b[1] > 1);
  return keep.filter((b, i) => !keep.some((c, j) => j !== i && c[0] <= b[0] && c[1] <= b[1] && c[2] >= b[2] && c[3] >= b[3] && (j < i || !(c[0] === b[0] && c[1] === b[1] && c[2] === b[2] && c[3] === b[3]))));
}

/** Grid cell of a principal view relative to the front view. */
export function gridCell(kind: string, projection: "first" | "third"): [number, number] | undefined {
  const first = projection === "first";
  switch (kind) {
    case "front":
      return [0, 0];
    case "top":
      return [0, first ? 1 : -1];
    case "bottom":
      return [0, first ? -1 : 1];
    case "right":
      return [first ? -1 : 1, 0];
    case "left":
      return [first ? 1 : -1, 0];
    case "back":
      return [2, 0];
    default:
      return undefined;
  }
}
