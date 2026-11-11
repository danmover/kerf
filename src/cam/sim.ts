// Cutting simulated on a height map: the stock as a grid of columns, each cut down to the lowest the flat end of
// the tool reached over it. Set beside the part's own height map (its highest material over each spot), it shows
// a gouge (the tool went into the part) and what was left (stock still above the part).

import type { Slicer } from "./slice";
import type { CamMove, CamPlan, CamStock } from "./plan";

export interface HeightMap {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  h: Float32Array;
}

export function heightMap(stock: CamStock, cell: number, fill: number): HeightMap {
  const nx = Math.max(1, Math.ceil((stock.hi[0] - stock.lo[0]) / cell));
  const ny = Math.max(1, Math.ceil((stock.hi[1] - stock.lo[1]) / cell));
  return { x0: stock.lo[0], y0: stock.lo[1], cell, nx, ny, h: new Float32Array(nx * ny).fill(fill) };
}

/** The part's highest material over each cell's centre (or -Infinity where there is none), by rasterising its triangles. */
export function partHeights(sl: Slicer, stock: CamStock, cell: number): HeightMap {
  const m = heightMap(stock, cell, -Infinity);
  const { v, t } = sl;
  for (let f = 0; f < t.length; f += 3) {
    const a = 3 * t[f],
      b = 3 * t[f + 1],
      c = 3 * t[f + 2];
    const ax = v[a],
      ay = v[a + 1],
      az = v[a + 2];
    const bx = v[b],
      by = v[b + 1],
      bz = v[b + 2];
    const cx = v[c],
      cy = v[c + 1],
      cz = v[c + 2];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - m.x0) / cell - 0.5)),
      i1 = Math.min(m.nx - 1, Math.ceil((Math.max(ax, bx, cx) - m.x0) / cell - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - m.y0) / cell - 0.5)),
      j1 = Math.min(m.ny - 1, Math.ceil((Math.max(ay, by, cy) - m.y0) / cell - 0.5));
    for (let j = j0; j <= j1; j++) {
      const y = m.y0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const x = m.x0 + (i + 0.5) * cell;
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        const k = j * m.nx + i;
        if (z > m.h[k]) m.h[k] = z;
      }
    }
  }
  return m;
}

/** Cut a height map with a flat end mill of diameter d along moves (rapids are taken as clear of the stock). */
export function cutMoves(m: HeightMap, moves: CamMove[], d: number, start?: [number, number, number]) {
  const r = d / 2;
  let p = start ?? null;
  for (const mv of moves) {
    const q = mv.p;
    if (p && mv.k !== "rapid") stamp(m, p, q, r);
    p = q;
  }
}

function stamp(m: HeightMap, a: [number, number, number], b: [number, number, number], r: number) {
  const { cell, nx, ny, x0, y0, h } = m;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - r - x0) / cell)),
    i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + r - x0) / cell));
  const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - r - y0) / cell)),
    j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + r - y0) / cell));
  // a tool just touching a wall does not take a spot on it (the paths are good to a micrometre or so)
  const r2 = (r - 2e-3) ** 2;
  for (let j = j0; j <= j1; j++) {
    const y = y0 + (j + 0.5) * cell;
    for (let i = i0; i <= i1; i++) {
      const x = x0 + (i + 0.5) * cell;
      // the lowest the tool's flat bottom came over this spot along the move
      let zMin: number;
      if (L2 < 1e-12) {
        if ((x - a[0]) ** 2 + (y - a[1]) ** 2 > r2) continue;
        zMin = Math.min(a[2], b[2]);
      } else {
        // the stretch of the move whose disc covers the spot: |a + t (b - a) - p| <= r
        const fx = a[0] - x,
          fy = a[1] - y;
        const B = 2 * (fx * dx + fy * dy);
        const Cc = fx * fx + fy * fy - r2;
        const disc = B * B - 4 * L2 * Cc;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        const t0 = Math.max(0, (-B - sq) / (2 * L2)),
          t1 = Math.min(1, (-B + sq) / (2 * L2));
        if (t0 > t1) continue;
        zMin = Math.min(a[2] + (b[2] - a[2]) * t0, a[2] + (b[2] - a[2]) * t1);
      }
      const k = j * nx + i;
      if (zMin < h[k]) h[k] = zMin;
    }
  }
}

/** The stock cut by a whole plan. */
export function simulate(plan: CamPlan, cell: number): HeightMap {
  const m = heightMap(plan.stock, cell, plan.stock.top);
  let at: [number, number, number] | undefined;
  for (const op of plan.ops) {
    cutMoves(m, op.moves, op.stampD ?? op.d, at);
    at = op.moves[op.moves.length - 1]?.p;
  }
  return m;
}

/** Where the cut stock and the part differ: the deepest gouge into the part and the most stock left on it, mm. */
export function compare(cut: HeightMap, part: HeightMap, floor: number): { gouge: number; gougeAt: [number, number] | null; left: number } {
  let gouge = 0,
    left = 0;
  let gougeAt: [number, number] | null = null;
  for (let k = 0; k < cut.h.length; k++) {
    const p = part.h[k];
    const c = cut.h[k];
    const want = p === -Infinity ? floor : p;
    if (c < want - gouge) {
      gouge = want - c;
      gougeAt = [cut.x0 + ((k % cut.nx) + 0.5) * cut.cell, cut.y0 + (Math.floor(k / cut.nx) + 0.5) * cut.cell];
    }
    if (c - want > left) left = c - want;
  }
  return { gouge, gougeAt, left };
}
