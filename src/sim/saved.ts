// Finished simulation runs saved with their project, so a run Claude or the
// user made is still there to replay after Kerf is closed and opened again.
// Each is stored under its run key (the scenario, the machine, the design
// name and Kerf's version): a saved run whose key still matches is the
// scenario's result and does not run again; one that no longer matches is
// shown as the last run while the scenario runs afresh.

import * as db from "../persist/db";
import type { RunResult, VariantRun } from "./engine/run";

export interface SavedRun {
  label: string;
  runKey: string;
  savedAt: number;
  result: RunResult;
}

/** runs kept for each scenario (the latest few, so testing a copy of the design does not lose the original's) */
const PER_LABEL = 3;
const PER_PROJECT = 24;
/** a long run's frames are thinned to this before saving */
export const SAVE_BYTES = 24 * 2 ** 20;

/** Roughly how much a result holds: its frames, screens, print moves and logs. */
export function resultBytes(r: RunResult): number {
  let n = 0;
  for (const v of r.variants) {
    n += v.frames.t.byteLength;
    for (const s of Object.values(v.frames.series)) n += s.byteLength;
    for (const d of v.displays ?? []) n += (d.frames.length * (d.w * d.h)) / 8 + 32 * d.frames.length;
    if (v.print) n += v.print.t.byteLength * 5;
    n += v.serial.length * 64 + v.events.length * 96;
  }
  return n;
}

/** Keep every k-th frame (and the last) so a long run fits. */
function thin(v: VariantRun, k: number): VariantRun {
  if (k <= 1) return v;
  const n = v.frames.t.length;
  const keep: number[] = [];
  for (let i = 0; i < n; i += k) keep.push(i);
  if (n && keep[keep.length - 1] !== n - 1) keep.push(n - 1);
  const pick = (a: Float32Array) => Float32Array.from(keep, (i) => a[i]);
  return { ...v, frames: { t: pick(v.frames.t), series: Object.fromEntries(Object.entries(v.frames.series).map(([name, a]) => [name, pick(a)])) } };
}

/** A result small enough to save: its frames thinned evenly when it is over the limit. */
export function forSaving(r: RunResult, limit = SAVE_BYTES): RunResult {
  const bytes = resultBytes(r);
  if (bytes <= limit) return r;
  const frameBytes = r.variants.reduce((a, v) => a + v.frames.t.byteLength * (1 + Object.keys(v.frames.series).length), 0);
  const rest = bytes - frameBytes;
  const k = frameBytes > 0 && limit > rest ? Math.ceil(frameBytes / (limit - rest)) : Infinity;
  if (!Number.isFinite(k)) return r;
  return { ...r, variants: r.variants.map((v) => thin(v, k)) };
}

/** Record keys carry what pruning needs (when, which run, which scenario), so it never reads the runs themselves. */
const recordKey = (projectId: string, savedAt: number, runKey: string, label: string) => [projectId, savedAt, runKey, encodeURIComponent(label)].join("|");

function parseKey(key: string) {
  const [, at, runKey, label] = key.split("|");
  return { key, savedAt: Number(at), runKey, label: decodeURIComponent(label ?? "") };
}

/** Save a finished run with its project, and forget older copies of it and the oldest beyond what is kept. */
export async function saveRun(projectId: string, label: string, runKey: string, result: RunResult): Promise<void> {
  const small = forSaving(result);
  const bytes = resultBytes(small);
  // a run still too big after thinning (screens or print moves) stays in memory only
  if (bytes > 2 * SAVE_BYTES) return;
  try {
    const savedAt = Date.now();
    await db.put<db.SimRunRecord>("sims", { key: recordKey(projectId, savedAt, runKey, label), projectId, label, runKey, savedAt, bytes, result: small });
    const all = (await db.simRunKeysFor(projectId)).map(parseKey).sort((a, b) => b.savedAt - a.savedAt);
    const runs = new Set<string>();
    const perLabel = new Map<string, number>();
    let kept = 0;
    for (const r of all) {
      const again = runs.has(r.runKey);
      runs.add(r.runKey);
      const n = again ? Infinity : (perLabel.get(r.label) ?? 0) + 1;
      if (!again) perLabel.set(r.label, n);
      if (n > PER_LABEL || kept >= PER_PROJECT) await db.remove("sims", r.key);
      else kept++;
    }
  } catch {
    // the disk is full or storage is off: the run is still shown, it just is not kept
  }
}

/** A project's saved runs, newest first. */
export async function savedRuns(projectId: string): Promise<SavedRun[]> {
  try {
    const all = await db.simRunsFor(projectId);
    return all.map((r) => ({ label: r.label, runKey: r.runKey, savedAt: r.savedAt, result: r.result as RunResult })).filter((r) => Array.isArray(r.result?.variants));
  } catch {
    return [];
  }
}
