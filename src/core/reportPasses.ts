// Checks that other modules add to the report after the core checks: the
// manufacturing process findings, and analysis results that arrive while the
// design sits still. The engine keeps the core report and composes every
// pass over it here, in one place, so a pass never rewrites another's output
// and late results re-compose the report instead of chasing it with setState.

import { finishReport, type CheckItem, type CheckReport } from "./checks";
import type { Model } from "./model";
import { processItems } from "../mfg/report";
import type { MachineContext } from "../mfg/machines";
import { fitItems } from "../analysis/fits/report";
import { springItems } from "../analysis/springs/report";
import { bandItems } from "../analysis/bands";
import { hotSoakItems } from "../analysis/hotSoak";
import type { ProcessResult } from "../mfg/types";

export interface ReportContext {
  /** the model the core report was built from */
  model: Model;
  /** the design engine's own report; false for a sub-agent's isolated build */
  live: boolean;
  /** engine revision of the report (0 when not live) */
  rev: number;
  buildErrors: Map<string, string>;
  /** manufacturing-process results by part id; null when they were not worked out (isolated builds) */
  process: Record<string, ProcessResult> | null;
  /** the user's machines the process checks ran against */
  machines?: MachineContext;
}

/** Takes the items so far and returns them with this pass's items added (or some removed). */
export type ReportPass = (items: CheckItem[], ctx: ReportContext) => CheckItem[];

const passes: { id: string; order: number; run: ReportPass }[] = [
  // stateless passes live here; modules with state of their own (the analysis runtime) register theirs
  { id: "process", order: 10, run: (items, ctx) => [...items, ...processItems(ctx.model, ctx.process, ctx.buildErrors, ctx.machines)] },
  { id: "fits", order: 12, run: fitItems },
  { id: "springs", order: 13, run: springItems },
  { id: "bands", order: 13.5, run: bandItems },
  { id: "hot-soak", order: 14, run: hotSoakItems },
];

/** Add (or replace) a pass. Lower `order` runs first. Returns the way to remove it. */
export function registerReportPass(id: string, run: ReportPass, order = 0): () => void {
  const at = passes.findIndex((p) => p.id === id);
  if (at >= 0) passes.splice(at, 1);
  passes.push({ id, order, run });
  passes.sort((a, b) => a.order - b.order);
  return () => {
    const i = passes.findIndex((p) => p.run === run);
    if (i >= 0) passes.splice(i, 1);
  };
}

/** The core report with every pass applied. Fields other than the items and counts are kept. */
export function composeReport(base: CheckReport, ctx: ReportContext): CheckReport {
  let items = [...base.items];
  for (const p of passes) items = p.run(items, ctx);
  return { ...base, ...finishReport(items, base.ms) };
}
