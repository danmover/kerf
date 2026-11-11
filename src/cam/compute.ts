// One setup's toolpaths from a part's triangles: the stock sized round the part as it sits for that setup, the plan,
// and the stock as each operation leaves it (for the preview), checked against the part. The worker runs this; so
// can a test.

import { Slicer, setupRotation, type CamMesh } from "./slice";
import { planCam, type CamPlan, type CamSettings, type CamStock } from "./plan";
import { compare, cutMoves, heightMap, partHeights } from "./sim";

type V3 = [number, number, number];

export interface CamRequest {
  mesh: CamMesh;
  /** the way the tool comes from, in the part's own frame */
  setup: V3;
  /** stock round the part: on each side, above its top and below its bottom (mm) */
  margin: number;
  above: number;
  below: number;
  settings: Omit<CamSettings, "stock">;
}

export interface CamMaps {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  /** the stock's heights after each operation */
  after: Float32Array[];
}

export interface CamResult {
  plan: CamPlan;
  /** rows of the rotation from the part's frame to the setup's (the tool comes down its -Z) */
  rot: number[];
  maps: CamMaps;
  /** deepest the simulated cut went into the part, mm (0 when it never does) */
  gouge: number;
  /** the part's size as it sits for the setup */
  size: V3;
  ms: number;
}

export function computeCam(req: CamRequest): CamResult {
  const t0 = performance.now();
  const rot = setupRotation(req.setup);
  const sl = new Slicer(req.mesh, rot);
  const stock: CamStock = {
    lo: [sl.lo[0] - req.margin, sl.lo[1] - req.margin],
    hi: [sl.hi[0] + req.margin, sl.hi[1] + req.margin],
    top: sl.hi[2] + req.above,
    bottom: sl.lo[2] - req.below,
  };
  const plan = planCam({ section: (z) => sl.section(z), floors: sl.floors().map((f) => f.z), top: sl.hi[2], bottom: sl.lo[2], lo: [sl.lo[0], sl.lo[1]], hi: [sl.hi[0], sl.hi[1]] }, { ...req.settings, stock });
  if (sl.open) plan.warnings.push("The part's surface has gaps, so some levels may be cut wrongly: check the preview");
  // the stock after each operation, on a grid fine enough to see the cuts
  const span = Math.max(stock.hi[0] - stock.lo[0], stock.hi[1] - stock.lo[1]);
  const cell = Math.max(0.15, span / 450);
  const hm = heightMap(stock, cell, stock.top);
  const after: Float32Array[] = [];
  let at: V3 | undefined;
  for (const op of plan.ops) {
    cutMoves(hm, op.moves, op.d, at);
    at = op.moves[op.moves.length - 1]?.p;
    after.push(hm.h.slice());
  }
  const check = compare(hm, partHeights(sl, stock, cell), -Infinity);
  // a few cells' worth on a wall is the grid, not the tool; deeper than that, say so
  if (check.gouge > 0.05 && check.gougeAt) plan.warnings.push(`The simulated cut goes ${check.gouge.toFixed(2)} mm into the part near (${check.gougeAt.map((x) => x.toFixed(1)).join(", ")}): check the preview there`);
  return { plan, rot, maps: { x0: hm.x0, y0: hm.y0, cell, nx: hm.nx, ny: hm.ny, after }, gouge: check.gouge, size: [sl.hi[0] - sl.lo[0], sl.hi[1] - sl.lo[1], sl.hi[2] - sl.lo[2]], ms: performance.now() - t0 };
}
