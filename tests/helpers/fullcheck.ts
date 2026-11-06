// Evaluates a design, builds every part with OpenCASCADE in Node and runs the
// same checks the app runs (requirements, interference, tool access, brief,
// machine, and each part's manufacturing process).

import { evaluate } from "../../src/lang/evaluator";
import { KernelCore } from "../../src/kernel/core";
import { assembleReport, buildChecksRequest, type CheckReport } from "../../src/core/checks";
import { composeReport } from "../../src/core/reportPasses";
import { processProbes } from "../../src/mfg/report";
import type { ProcessResult } from "../../src/mfg/types";
import type { Model } from "../../src/core/model";
import { initKernel } from "./kernel";

export interface FullCheck {
  model: Model;
  report: CheckReport;
  buildErrors: Map<string, string>;
  core: KernelCore;
  /** the kernel's checks result (contacts, clearances, boxes) */
  kernel: ReturnType<KernelCore["checks"]>;
  ms: number;
}

export async function fullCheck(src: string): Promise<FullCheck> {
  const t0 = Date.now();
  await initKernel();
  const model = evaluate(src);
  const core = new KernelCore();
  const buildErrors = new Map<string, string>();
  const built = new Set<string>();
  for (const p of model.parts) {
    if (built.has(p.hash) || buildErrors.has(p.hash)) continue;
    try {
      core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
      built.add(p.hash);
    } catch (e) {
      buildErrors.set(p.hash, e instanceof Error ? e.message : String(e));
    }
  }
  const result = core.checks(buildChecksRequest(model, built));
  const geoModel = model.geoQueries.length ? evaluate(src, { geo: result.geo }) : null;
  const geom = (h: string) => {
    const e = core.get(h);
    return e ? { volume: e.volume, bbox: e.bbox } : undefined;
  };
  const mesh = (h: string) => (core.get(h) ? core.mesh(h, "preview") : undefined);
  const base = assembleReport(model, { geoModel, kernel: result, buildErrors, geom, mesh });
  const probes = processProbes(model, built);
  const results = core.process(probes);
  const process: Record<string, ProcessResult> = {};
  probes.forEach((p, i) => (process[p.id] = results[i]));
  const report = composeReport(base, { model, live: false, rev: 0, buildErrors, process });
  // the model with geometry measurements filled in, when the design asks for any
  return { model: geoModel ?? model, report, buildErrors, core, kernel: result, ms: Date.now() - t0 };
}

/** One line per item that is not a pass, for test output. */
export function problems(r: CheckReport, include: ("fail" | "warn" | "info")[] = ["fail", "warn"]): string[] {
  return r.items.filter((i) => (include as string[]).includes(i.status)).map((i) => `${i.status} [${i.category}] ${i.title}: ${i.detail}`);
}
