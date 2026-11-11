// A plan as one run of moves in time, for the preview: every move's end point and the time it ends at the
// feeds the plan gives (rapids at the machine's rapid rate), and where the tool is at any moment.

import type { CamPlan, MoveKind } from "./plan";
import { FRAME_SPEED, type Frame } from "./feeds";

type V3 = [number, number, number];

export const KIND_CODE: Record<MoveKind, number> = { rapid: 0, feed: 1, ramp: 2, plunge: 3 };

export interface CamTimeline {
  /** per move, in order through the plan: the operation it belongs to */
  op: Uint16Array;
  /** its kind (KIND_CODE) */
  kind: Uint8Array;
  /** where it ends, x y z */
  p: Float32Array;
  /** the time it ends, s from the start */
  t: Float64Array;
  /** the first move of each operation */
  start: Int32Array;
  total: number;
}

export function timeline(plan: CamPlan, frame: Frame): CamTimeline {
  const n = plan.ops.reduce((a, o) => a + o.moves.length, 0);
  const op = new Uint16Array(n);
  const kind = new Uint8Array(n);
  const p = new Float32Array(3 * n);
  const t = new Float64Array(n);
  const start = new Int32Array(plan.ops.length);
  const rapid = FRAME_SPEED[frame].rapid;
  let time = 0;
  let prev: V3 | null = null;
  let i = 0;
  plan.ops.forEach((o, k) => {
    start[k] = i;
    for (const m of o.moves) {
      if (prev) {
        const d = Math.hypot(m.p[0] - prev[0], m.p[1] - prev[1], m.p[2] - prev[2]);
        const rate = m.k === "rapid" ? rapid : m.k === "plunge" ? o.cut.plunge : m.k === "ramp" ? o.cut.ramp : o.cut.feed;
        time += (d / Math.max(rate, 1e-6)) * 60;
      }
      op[i] = k;
      kind[i] = KIND_CODE[m.k];
      p.set(m.p, 3 * i);
      t[i] = time;
      prev = m.p;
      i++;
    }
  });
  return { op, kind, p, t, start, total: time };
}

/** Where the tool is at time s: the move it is on (the one it is heading to the end of), and its point. */
export function toolAt(tl: CamTimeline, s: number): { i: number; op: number; p: V3 } {
  const n = tl.t.length;
  if (!n) return { i: -1, op: -1, p: [0, 0, 0] };
  // the first move that ends at or after s
  let lo = 0,
    hi = n - 1;
  if (s >= tl.t[n - 1]) lo = n - 1;
  else
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tl.t[mid] < s) lo = mid + 1;
      else hi = mid;
    }
  const i = lo;
  const end: V3 = [tl.p[3 * i], tl.p[3 * i + 1], tl.p[3 * i + 2]];
  if (i === 0 || s >= tl.t[i]) return { i, op: tl.op[i], p: end };
  const t0 = tl.t[i - 1];
  const f = Math.max(0, Math.min(1, (s - t0) / Math.max(1e-9, tl.t[i] - t0)));
  const a = 3 * (i - 1);
  return { i, op: tl.op[i], p: [tl.p[a] + (end[0] - tl.p[a]) * f, tl.p[a + 1] + (end[1] - tl.p[a + 1]) * f, tl.p[a + 2] + (end[2] - tl.p[a + 2]) * f] };
}
