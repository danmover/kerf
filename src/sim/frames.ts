// Reading a run's recorded frames: the value of a series at any time, and
// the series a plot pattern like "*.amps" names.

import type { Frames } from "./engine/run";

/** Index of the last frame at or before t. */
export function frameAt(f: Frames, t: number): number {
  const ts = f.t;
  if (!ts.length || t <= ts[0]) return 0;
  if (t >= ts[ts.length - 1]) return ts.length - 1;
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A series' value at time t, linear between frames (NaN when the run did not record it). */
export function valueAt(f: Frames, name: string, t: number): number {
  const s = f.series[name];
  if (!s || !s.length) return NaN;
  const i = frameAt(f, t);
  const j = Math.min(i + 1, s.length - 1);
  const t0 = f.t[i];
  const t1 = f.t[j];
  if (j === i || t1 <= t0) return s[i];
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return s[i] + (s[j] - s[i]) * u;
}

/** Series names matching a pattern: an exact name, or "*.field" for every thing with that field. */
export function matchSeries(f: Frames, pattern: string): string[] {
  if (!pattern.includes("*")) return f.series[pattern] ? [pattern] : [];
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+")}$`);
  return Object.keys(f.series).filter((n) => re.test(n));
}

/** Smallest and largest finite value of a series. */
export function rangeOf(s: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : [0, 0];
}

export const duration = (f: Frames) => (f.t.length ? f.t[f.t.length - 1] : 0);
