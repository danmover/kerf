// Adds the design-for-assembly checks to every report, and keeps the latest
// report where the make panel and Claude's tools can read it, so they show
// the same numbers as the checks. Contact between made parts starts out
// judged from their boxes; the kernel then measures the pairs that matter in
// the background (live design only) and the report is composed again.

import { create } from "zustand";
import { meshes, refreshReport } from "../core/engine";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { CheckItem } from "../core/checks";
import type { EvalPart, Model } from "../core/model";
import { kernel } from "../kernel/client";
import { dfaItems, dfaReport, geometryFromMeshes, type DfaReport } from "./dfa";

/** Smallest gap between two placed solids, by solid and placement; null when the kernel could not measure. */
const gaps = new Map<string, number | null>();
const queue: { key: string; a: EvalPart; b: EvalPart }[] = [];
let measuring = false;
/** Solids closer than this touch (mm). */
const CONTACT = 0.05;
/** Pairs measured per design state, at most. */
const MAX_PAIRS = 80;

const placement = (p: EvalPart) => `${p.hash}@${JSON.stringify(p.xf)}`;
const pairKey = (a: EvalPart, b: EvalPart) => [placement(a), placement(b)].sort().join("|");

export interface DfaState {
  /** the assembly report behind the latest checks (live design) */
  report: DfaReport | null;
  /** engine revision it was built for */
  rev: number;
  /** contacts still being measured: merge candidates may change when they finish */
  measuring: number;
}

export const useDfa = create<DfaState>(() => ({ report: null, rev: 0, measuring: 0 }));

/** The assembly report the checks show now, or null before the first report. */
export function latestDfa(): DfaReport | null {
  return useDfa.getState().report;
}

/**
 * The assembly report for a model from the geometry built so far and the
 * contacts already measured (no new kernel work). For a model that is not
 * the live one, or before the checks have run.
 */
export function dfaFor(model: Model, buildErrors?: Map<string, string>): DfaReport {
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  return dfaReport(model, {
    geometry: geometryFromMeshes(model, (h) => meshes.get(h), (p) => !!buildErrors?.has(p.hash)),
    touching: (a, b) => {
      const pa = byId.get(a);
      const pb = byId.get(b);
      if (!pa || !pb) return undefined;
      const d = gaps.get(pairKey(pa, pb));
      return d === null || d === undefined ? undefined : d < CONTACT;
    },
  });
}

async function drain() {
  if (measuring) return;
  measuring = true;
  try {
    while (queue.length) {
      const { key, a, b } = queue.shift()!;
      if (gaps.has(key)) continue;
      try {
        const r = await kernel.measure([{ hash: a.hash, xf: a.xf }], [{ hash: b.hash, xf: b.xf }]);
        gaps.set(key, r.distance);
      } catch {
        gaps.set(key, null);
      }
    }
  } finally {
    measuring = false;
  }
  refreshReport();
}

function assemblyItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  const report = dfaFor(ctx.model, ctx.buildErrors);
  if (ctx.live) {
    // only the latest design's contacts are worth the kernel's time: drop pairs queued for earlier states
    queue.length = 0;
    const byId = new Map(ctx.model.parts.map((p) => [p.id, p]));
    for (const [x, y] of report.boxContacts) {
      const a = byId.get(x);
      const b = byId.get(y);
      if (!a || !b) continue;
      const key = pairKey(a, b);
      if (!gaps.has(key) && queue.length < MAX_PAIRS) queue.push({ key, a, b });
    }
    if (queue.length) void drain();
    if (gaps.size > 4000) gaps.clear();
    useDfa.setState({ report, rev: ctx.rev, measuring: queue.length });
  }
  return [...items, ...dfaItems(ctx.model, report)];
}

let started = false;

/** Hook the assembly checks into the report (after the material checks). */
export function startAssemblyChecks() {
  if (started) return;
  started = true;
  registerReportPass("assembly", assemblyItems, 40);
  refreshReport();
}
