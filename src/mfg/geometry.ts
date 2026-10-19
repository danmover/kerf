// The measurements the cost model needs, from what the app already has: a
// part's displayed mesh (surface area and the area it shows along each axis),
// its volume and box from the build, and what the process checks measured
// (walls, sheet thickness, bends, holes, undercuts).

import type { V3 } from "../kernel/recipe";
import type { CostGeometry } from "./cost";
import type { ProcessResult, ProcessStats } from "./types";

/** Surface area, and the area seen along X, Y and Z (half the absolute normal-weighted area of a closed surface). */
export function meshFacts(positions: ArrayLike<number>, indices: ArrayLike<number>): { area: number; projected: V3 } {
  let area = 0;
  const proj: V3 = [0, 0, 0];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    // twice the triangle's area along each axis
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    area += Math.hypot(nx, ny, nz) / 2;
    proj[0] += Math.abs(nx) / 4;
    proj[1] += Math.abs(ny) / 4;
    proj[2] += Math.abs(nz) / 4;
  }
  return { area, projected: proj };
}

/** Rules whose failure means another side action, core or setup. */
const UNDERCUT_RULES = new Set(["undercut", "reach"]);

/** What a process check measured, folded into the cost geometry. */
export function withStats(g: CostGeometry, r: ProcessResult | undefined): CostGeometry {
  if (!r || r.error) return g;
  const s: ProcessStats = r.stats;
  const out: CostGeometry = { ...g };
  if (s.nominalWall && s.nominalWall > 0) out.wall = s.nominalWall;
  if (s.sheetT && s.sheetT > 0) out.sheetT = s.sheetT;
  if (s.bends !== undefined) out.bends = s.bends;
  if (s.holes !== undefined) out.holes = s.holes;
  // the machining plan counts the setups the part really needs
  if (s.setups !== undefined) out.setups = s.setups;
  const undercut = r.findings.some((f) => UNDERCUT_RULES.has(f.rule) && (f.status === "fail" || f.status === "info" || f.status === "warn"));
  if (undercut) out.undercuts = 1;
  return out;
}
