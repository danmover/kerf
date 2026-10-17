// How a machine's parts move with its axes, from the design itself: the design
// is re-evaluated with each pose parameter (show_x, show_y, show_z) nudged and
// whatever moves is recorded per mm of that axis. Parts placed by `at:` move
// their origin; made parts that bake the pose into their geometry (a carriage
// drawn at the nozzle's X) keep their origin but their shape moves, which is
// read from their bounds. Plain data (no three.js): the printer playback, the
// cable planner and its worker all use it.

import type { EvalPart, Model } from "../core/model";
import { evaluate } from "../lang/evaluator";
import { xformMatrix, type V3 } from "../kernel/recipe";
import { recipeBounds } from "../analysis/fits/geometry";

export const POSE_PARAMS = ["show_x", "show_y", "show_z"] as const;

export interface MachinePose {
  /** the axis values the design is shown at */
  s0: V3;
  /** each axis's travel, from its parameter's range (shown value only when it has none) */
  range: [[number, number], [number, number], [number, number]];
  /** which axes the design poses itself from */
  axes: [boolean, boolean, boolean];
  /** per part id: its displacement per mm of X, Y and Z */
  moves: Map<string, [V3, V3, V3]>;
  /** the nozzle tip at the shown pose, and the hotend and bed parts */
  nozzle?: V3;
  hotId?: string;
  bedId?: string;
}

const origin = (p: EvalPart): V3 => {
  const m = xformMatrix(p.xf);
  return [m[12], m[13], m[14]];
};

/** a made part's bounds in the assembly, when its recipe is simple enough to bound */
function placedBounds(p: EvalPart): [V3, V3] | null {
  const b = recipeBounds(p.recipe);
  if (!b) return null;
  const m = xformMatrix(p.xf);
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? b[1][0] : b[0][0];
    const y = c & 2 ? b[1][1] : b[0][1];
    const z = c & 4 ? b[1][2] : b[0][2];
    for (let k = 0; k < 3; k++) {
      const v = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
      lo[k] = Math.min(lo[k], v);
      hi[k] = Math.max(hi[k], v);
    }
  }
  return [lo, hi];
}

/** How far a part moved between two evaluations, or null when it changed shape rather than moved. */
function displacement(a: EvalPart, b: EvalPart): V3 | null {
  const oa = origin(a);
  const ob = origin(b);
  const d: V3 = [ob[0] - oa[0], ob[1] - oa[1], ob[2] - oa[2]];
  if (Math.hypot(...d) > 1e-6 || a.hash === b.hash) return d;
  // same origin, new geometry: moved if its bounds kept their size
  const ba = placedBounds(a);
  const bb = placedBounds(b);
  if (!ba || !bb) return frameShift(a.recipe, b.recipe);
  for (let k = 0; k < 3; k++) if (Math.abs(ba[1][k] - ba[0][k] - (bb[1][k] - bb[0][k])) > 1e-3) return null;
  return [0, 1, 2].map((k) => (bb[0][k] + bb[1][k] - ba[0][k] - ba[1][k]) / 2) as V3;
}

/** The same recipe with every sketch frame shifted by one amount (a belt drawn along its pulleys): that shift, else null. */
function frameShift(a: unknown, b: unknown): V3 | null {
  let d: V3 | null = null;
  const same = (x: unknown, y: unknown): boolean => {
    if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) < 1e-9;
    if (Array.isArray(x)) return Array.isArray(y) && x.length === y.length && x.every((v, i) => same(v, y[i]));
    if (!x || typeof x !== "object") return x === y;
    if (!y || typeof y !== "object") return false;
    const ox = x as Record<string, unknown>;
    const oy = y as Record<string, unknown>;
    const keys = Object.keys(ox);
    if (keys.length !== Object.keys(oy).length) return false;
    const frame = "u" in ox && "n" in ox && Array.isArray(ox.o) && Array.isArray(oy.o);
    return keys.every((k) => {
      if (!frame || k !== "o") return same(ox[k], oy[k]);
      const [p, q] = [ox.o as number[], oy.o as number[]];
      const s: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      if (!d) d = s;
      return s.every((v, i) => Math.abs(v - d![i]) < 1e-6);
    });
  };
  return same(a, b) ? d : null;
}

/** Re-evaluate the design with each pose parameter nudged and see what moves. */
export function machinePose(source: string, model: Model): MachinePose {
  const param = (n: string) => model.params.find((x) => x.name === n);
  const val = (n: string) => {
    const v = param(n)?.value;
    return typeof v === "number" ? v : undefined;
  };
  const s0 = POSE_PARAMS.map((n) => val(n) ?? 0) as V3;
  const axes = POSE_PARAMS.map((n) => val(n) !== undefined) as [boolean, boolean, boolean];
  const range = POSE_PARAMS.map((n, k) => {
    const p = param(n);
    return [p?.min ?? s0[k], p?.max ?? s0[k]] as [number, number];
  }) as MachinePose["range"];
  const base = new Map(model.parts.map((p) => [p.id, p]));
  const moves = new Map<string, [V3, V3, V3]>();
  POSE_PARAMS.forEach((name, ax) => {
    if (!axes[ax]) return;
    // nudge inwards at the top of the range so the design stays valid
    const d = s0[ax] + 1 > range[ax][1] && range[ax][1] > range[ax][0] ? -1 : 1;
    let m2: Model;
    try {
      m2 = evaluate(source, { overrides: { [name]: s0[ax] + d } });
    } catch {
      return;
    }
    for (const p of m2.parts) {
      const b = base.get(p.id);
      const delta = b && displacement(b, p);
      if (!delta) continue;
      const per: V3 = [delta[0] / d, delta[1] / d, delta[2] / d];
      if (Math.hypot(...per) < 1e-4) continue;
      const mv = moves.get(p.id) ?? [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      mv[ax] = per;
      moves.set(p.id, mv);
    }
  });
  const hot = model.parts.find((p) => p.libKind === "hotend");
  const bed = model.parts.find((p) => p.libKind === "heated_bed");
  return { s0, range, axes, moves, nozzle: hot ? origin(hot) : undefined, hotId: hot?.id, bedId: bed?.id };
}

/** Whether a design poses itself from any of the pose parameters. */
export const posable = (model: Model) => model.params.some((p) => (POSE_PARAMS as readonly string[]).includes(p.name) && typeof p.value === "number");

/** How far each moving part is from where the design shows it, at axis values `at`. */
export function poseOffsets(pose: MachinePose, at: V3): Map<string, V3> {
  const out = new Map<string, V3>();
  const d = [at[0] - pose.s0[0], at[1] - pose.s0[1], at[2] - pose.s0[2]];
  for (const [id, mv] of pose.moves) out.set(id, [0, 1, 2].map((k) => mv[0][k] * d[0] + mv[1][k] * d[1] + mv[2][k] * d[2]) as V3);
  return out;
}
