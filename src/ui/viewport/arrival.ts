// How a new part arrives in the 3D view. A part that is made draws its outline first, then fills in the way it is
// made: a print's layers stack up from the bed, a mill cuts down from the top, a lathe works along the bar. A bought
// part drops into place and settles, and a screw spins down its thread into its hole. Plain functions, so the scene
// (scene.ts) only drives them; reduce-motion skips all of it there.

import type { EvalPart } from "../../core/model";
import { printUp } from "../../mfg/printOrientation";

type V3 = [number, number, number];

export type ArrivalKind = "make" | "drop" | "screw";

/** How a part arrives: screws spin in, bought parts drop in, the rest are made in place. */
export function arrivalKind(p: EvalPart): ArrivalKind {
  if (p.fastener && p.libKind === "screw") return "screw";
  if (p.kind === "component" || p.processNone) return "drop";
  return "make";
}

/** Layer heights the band of a printed part's fill shows, by process, mm (its own layer: setting first). */
const LAYER: Partial<Record<string, number>> = { fdm: 0.2, sla: 0.05, sls: 0.1, metal_print: 0.04 };

/** Above this many triangles the print direction is not worked out from the mesh (the part's Z is used instead). */
const PRINT_UP_MAX_TRIS = 40000;

export interface Fill {
  /** the way the solid fills in, unit */
  axis: V3;
  /** in the part's own frame, or the world's (a part with no process fills up from the ground) */
  frame: "part" | "world";
  /** a printed part's layer height, mm (0 for none) */
  layer: number;
}

/**
 * The way a made part fills in: printed parts along the way their layers stack (the process's build: or the face they
 * rest on), milled ones from the top down, turned and laser-cut ones along their length, laid-up ones through their
 * plies, and the rest up from the ground.
 */
export function fillAxis(p: EvalPart, mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> } | null, box: { min: V3; max: V3 }): Fill {
  const proc = p.process?.id;
  const size: V3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const axisOf = (k: number): V3 => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
  const longest = size.indexOf(Math.max(...size));
  const thinnest = size.indexOf(Math.min(...size));
  if (proc && LAYER[proc] !== undefined) {
    const s = p.process!.settings;
    const layer = typeof s.layer === "number" && s.layer > 0 ? s.layer : LAYER[proc]!;
    const given = s.build;
    if (Array.isArray(given) && typeof given[0] === "number") {
      const g = given as V3;
      const l = Math.hypot(g[0], g[1], g[2]);
      if (l > 1e-9) return { axis: [g[0] / l, g[1] / l, g[2] / l], frame: "part", layer };
    }
    if (mesh && mesh.indices.length / 3 <= PRINT_UP_MAX_TRIS) return { axis: printUp(mesh.positions, mesh.indices), frame: "part", layer };
    return { axis: [0, 0, 1], frame: "part", layer };
  }
  if (proc === "cnc_mill") return { axis: [0, 0, -1], frame: "part", layer: 0 };
  if (proc === "cnc_lathe" || proc === "laser_cut" || proc === "sheet_metal") return { axis: axisOf(longest), frame: "part", layer: 0 };
  if (proc === "carbon_layup") return { axis: axisOf(thinnest), frame: "part", layer: 0 };
  return { axis: [0, 0, 1], frame: "world", layer: 0 };
}

/**
 * How far along each edge a point of a part's outline is, for the outline that draws itself in: 0 where a B-rep edge
 * starts, 1 where it ends, by length along it. `edges` are line-segment pairs (THREE.LineSegments), `groups` the mesh's
 * (first point, point count, edge id) per B-rep edge; without them, runs of joined segments count as one edge.
 */
export function traceOrder(edges: ArrayLike<number>, groups?: ArrayLike<number> | null): Float32Array {
  const n = Math.floor(edges.length / 3);
  const out = new Float32Array(n);
  const seg = (k: number) => Math.hypot(edges[(k + 1) * 3] - edges[k * 3], edges[(k + 1) * 3 + 1] - edges[k * 3 + 1], edges[(k + 1) * 3 + 2] - edges[k * 3 + 2]);
  const run = (start: number, end: number) => {
    let total = 0;
    for (let k = start; k + 1 < end; k += 2) total += seg(k);
    let at = 0;
    for (let k = start; k + 1 < end; k += 2) {
      const l = seg(k);
      out[k] = total > 0 ? at / total : 0;
      at += l;
      out[k + 1] = total > 0 ? at / total : 1;
    }
  };
  if (groups && groups.length >= 3) {
    for (let g = 0; g + 2 < groups.length; g += 3) run(Math.max(0, groups[g]), Math.min(n, groups[g] + groups[g + 1]));
    return out;
  }
  // segments that carry on from the one before belong to the same edge
  let start = 0;
  for (let k = 2; k + 1 < n; k += 2) {
    const joined = edges[k * 3] === edges[(k - 1) * 3] && edges[k * 3 + 1] === edges[(k - 1) * 3 + 1] && edges[k * 3 + 2] === edges[(k - 1) * 3 + 2];
    if (!joined) {
      run(start, k);
      start = k;
    }
  }
  run(start, n - (n % 2));
  return out;
}

/** How long each arrival takes, ms. */
export const ARRIVE_MS = { make: 1050, drop: 680, screw: 820 } as const;

/** The share of a made part's arrival the outline takes to draw, and when the fill starts and how long it runs. */
export const TRACE_SHARE = 0.45;
export const FILL_FROM = 0.22;

/** How far the outline has drawn (0 to 1) at k (0 to 1) of a made part's arrival. */
export function traceAt(k: number): number {
  const t = Math.min(1, Math.max(0, k / TRACE_SHARE));
  return 1 - Math.pow(1 - t, 2);
}

/** How far the fill has reached (0 to 1) at k of a made part's arrival: steady through the middle, like a print. */
export function fillAt(k: number): number {
  const t = Math.min(1, Math.max(0, (k - FILL_FROM) / (1 - FILL_FROM)));
  return t * t * (3 - 2 * t);
}

/** When a dropped part lands, as a share of its arrival. */
export const DROP_LAND = 0.6;

/**
 * How high a dropped part still is, as a share of the height it drops from, at k (0 to 1): it falls as a thing falls
 * (speeding up), lands at DROP_LAND, and bounces once a little before it settles.
 */
export function dropHeight(k: number): number {
  if (k <= 0) return 1;
  if (k >= 1) return 0;
  if (k < DROP_LAND) return 1 - (k / DROP_LAND) ** 2;
  // the bounce: a tenth of the speed it landed with, back up and down again
  const t = (k - DROP_LAND) / 0.3;
  return t < 1 ? 0.085 * 4 * t * (1 - t) : 0;
}

/** How much of its way a screw still has to go, 1 at the start and 0 seated, at k (0 to 1): quick, then it snugs down. */
export function screwLeft(k: number): number {
  if (k <= 0) return 1;
  if (k >= 1) return 0;
  return Math.pow(1 - k, 2.4);
}

/** How far a screw spins down (mm) and how many turns it takes, from its length and head. */
export function screwTravel(length: number | undefined, headD: number): { travel: number; turns: number } {
  const travel = Math.min(60, Math.max(3, (length ?? headD * 2) * 0.8));
  return { travel, turns: 2 + Math.min(4, travel / Math.max(2, headD)) };
}
