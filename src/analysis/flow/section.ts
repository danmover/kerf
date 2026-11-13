// A cross-section of the air: the cells in the plane through a point, square to the nearest grid axis, that are
// joined to that point's cell without crossing a solid (the inside of a duct at that point, or a vent's opening).

import * as grid from "./grid";
import type { Grid } from "./grid";
import type { V3 } from "./types";

// module-level copies of the imported constants and functions: the hot loops read them millions of times, and an
// imported binding costs a call each where the modules are compiled to CommonJS (the tests)
const { AMBIENT, FLUID, cellAt } = grid;

export interface Section {
  /** the grid axis it is square to, and +1 or −1 for the way along it */
  axis: number;
  sign: number;
  cells: number[];
  /** m² */
  area: number;
}

/** The nearest grid axis to a direction, and which way along it. */
export function nearestAxis(dir: V3): { axis: number; sign: number } {
  const a = [0, 1, 2].reduce((best, i) => (Math.abs(dir[i]) > Math.abs(dir[best]) ? i : best), 0);
  return { axis: a, sign: dir[a] >= 0 ? 1 : -1 };
}

/** The cross-section through at (mm) square to dir, kept inside bounds when given. A string says why there is none. */
export function crossSection(g: Grid, at: V3, dir: V3, bounds?: { lo: V3; hi: V3 }): Section | string {
  const { axis, sign } = nearestAxis(dir);
  const { nx, ny, nz } = g;
  const D = [nx, ny, nz];
  const stride = [1, nx, nx * ny];
  let start = cellAt(g, at);
  if (start < 0) return "it is outside the parts' box";
  // the point may sit on a wall: take the nearest air cell in the plane, within a few cells
  if (g.kind[start] !== FLUID) {
    const ij = [start % nx, Math.floor(start / nx) % ny, Math.floor(start / (nx * ny))];
    const b1 = (axis + 1) % 3;
    const b2 = (axis + 2) % 3;
    let best = -1;
    let bd = Infinity;
    for (let d1 = -4; d1 <= 4; d1++)
      for (let d2 = -4; d2 <= 4; d2++) {
        const q = [...ij];
        q[b1] += d1;
        q[b2] += d2;
        if (q[b1] < 0 || q[b2] < 0 || q[b1] >= D[b1] || q[b2] >= D[b2]) continue;
        const c = q[0] + nx * (q[1] + ny * q[2]);
        if (g.kind[c] === FLUID && d1 * d1 + d2 * d2 < bd) {
          bd = d1 * d1 + d2 * d2;
          best = c;
        }
      }
    if (best < 0) return "there is no air there (it is inside a part)";
    start = best;
  }
  const inside = (c: number) => {
    if (!bounds) return true;
    const i = c % nx;
    const j = Math.floor(c / nx) % ny;
    const k = Math.floor(c / (nx * ny));
    const p = [g.origin[0] + (i + 0.5) * g.hmm, g.origin[1] + (j + 0.5) * g.hmm, g.origin[2] + (k + 0.5) * g.hmm];
    for (let a = 0; a < 3; a++) if (a !== axis && (p[a] < bounds.lo[a] - g.hmm || p[a] > bounds.hi[a] + g.hmm)) return false;
    return true;
  };
  const seen = new Set<number>([start]);
  const cells: number[] = [];
  const queue = [start];
  let open = false;
  while (queue.length) {
    const c = queue.pop()!;
    cells.push(c);
    const q = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    for (let a = 0; a < 3; a++) {
      if (a === axis) continue;
      for (const s of [-1, 1]) {
        if (q[a] + s < 0 || q[a] + s >= D[a]) continue;
        const n = c + s * stride[a];
        if (seen.has(n)) continue;
        seen.add(n);
        if (g.kind[n] === AMBIENT) {
          open = true;
          continue;
        }
        if (g.kind[n] !== FLUID || !inside(n)) continue;
        queue.push(n);
      }
    }
    if (cells.length > 200000) break;
  }
  if (open && !bounds) return "the air there is not closed in by walls, so there is no opening to push through (name a duct end or give a zone round the opening)";
  return { axis, sign, cells, area: cells.length * g.h * g.h };
}
