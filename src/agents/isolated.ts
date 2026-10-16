// Geometry checks for one subassembly in its own kernel worker, so agents can
// build and check their work in parallel without disturbing the main view.
// Each worker keeps its solid cache between checks, so a re-check rebuilds
// only the parts that changed.

import { parse } from "../lang/parser";
import { evaluate } from "../lang/evaluator";
import { KernelClient } from "../kernel/client";
import { assembleReport, buildChecksRequest, type CheckReport } from "../core/checks";
import { composeReport } from "../core/reportPasses";
import type { ChecksResult } from "../kernel/protocol";
import type { EvalPart, Model } from "../core/model";

class KernelPool {
  private all: KernelClient[] = [];
  private idle: KernelClient[] = [];
  private waiters: ((c: KernelClient) => void)[] = [];
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  size = 2;

  async acquire(): Promise<{ client: KernelClient; index: number }> {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    let c = this.idle.pop();
    if (!c && this.all.length < this.size) {
      c = new KernelClient();
      c.start();
      this.all.push(c);
    }
    if (!c) c = await new Promise<KernelClient>((resolve) => this.waiters.push(resolve));
    return { client: c, index: this.all.indexOf(c) + 1 };
  }

  release(c: KernelClient) {
    const w = this.waiters.shift();
    if (w) return w(c);
    this.idle.push(c);
  }

  /** Close the workers once no agent has needed one for a while (each holds a few hundred MB). */
  closeSoon(ms = 60_000) {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.closeNow(), ms);
  }

  closeNow() {
    if (this.waiters.length || this.idle.length !== this.all.length) return;
    for (const c of this.all) c.dispose();
    this.all = [];
    this.idle = [];
  }

  get running() {
    return this.all.length;
  }
}

export const pool = new KernelPool();

/** How many extra geometry workers this device can afford. */
export function defaultWorkers(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const mem = typeof navigator !== "undefined" ? ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) : 8;
  return Math.max(1, Math.min(4, cores - 2, mem <= 4 ? 1 : mem <= 8 ? 2 : 3));
}

export interface IsolatedResult {
  model: Model;
  report: CheckReport | null;
  error?: string;
  worker: number;
  built: number;
  ms: number;
}

/** Evaluate, build and check a design in a pool worker. */
export async function checkIsolated(src: string, onStage?: (s: string) => void, timeoutMs = 150_000): Promise<IsolatedResult> {
  const t0 = performance.now();
  const parsed = parse(src);
  const model = evaluate(src, { parsed });
  const byHash = new Map<string, EvalPart>();
  for (const p of model.parts) if (!byHash.has(p.hash)) byHash.set(p.hash, p);

  onStage?.("Waiting for a geometry worker");
  const { client, index } = await pool.acquire();
  try {
    onStage?.(`Building in geometry worker ${index}`);
    await client.ready();
    const buildErrors = new Map<string, string>();
    const built = new Set<string>();
    const job = client.build(
      [...byHash.values()].map((p) => ({ hash: p.hash, recipe: p.recipe, label: p.label })),
      "preview",
      (r) => built.add(r.hash),
      (hash, message) => buildErrors.set(hash, message),
    );
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
    const r = await Promise.race([job.done, timer]);
    if (r === "timeout") {
      job.cancel();
      return { model, report: null, error: `The build took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. Simplify the heaviest part (fewer fillets or boolean operations).`, worker: index, built: built.size, ms: performance.now() - t0 };
    }
    if (r.cancelled) return { model, report: null, error: "The geometry worker restarted during the build. Check again.", worker: index, built: built.size, ms: performance.now() - t0 };

    onStage?.(`Checking in geometry worker ${index}`);
    let result: ChecksResult | null = null;
    let error: string | undefined;
    try {
      result = await client.checks(buildChecksRequest(model, built));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const geoModel = result && model.geoQueries.length ? evaluate(src, { parsed, geo: result.geo }) : null;
    const base = assembleReport(model, { geoModel, kernel: result, buildErrors });
    const report = composeReport(base, { model, live: false, rev: 0, buildErrors, process: null });
    return { model: geoModel ?? model, report, error, worker: index, built: built.size, ms: performance.now() - t0 };
  } finally {
    pool.release(client);
  }
}
