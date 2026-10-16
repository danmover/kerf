// Check one built part against several processes at once, for the process
// picker and the assistant's compare_processes tool. The kernel shares one
// analysis of the part across all of them.

import { kernel } from "../kernel/client";
import { whenChecked } from "../core/engine";
import type { EvalPart } from "../core/model";
import { PROCESS_IDS } from "./profiles";
import { compareProbes, summarize, type ProcessSummary } from "./report";
import type { ProcessId, ProcessResult } from "./types";

export interface ProcessOption {
  id: ProcessId;
  summary: ProcessSummary | null;
  result: ProcessResult;
}

/**
 * Every process (or the given ones) for this part, best fit first. Waits for
 * the current design to build, then checks the part as it is now.
 */
export async function compareProcesses(part: EvalPart, ids: ProcessId[] = PROCESS_IDS): Promise<ProcessOption[]> {
  const s = await whenChecked();
  if (s.kernelStatus === "error") throw new Error(`The geometry kernel is unavailable: ${s.kernelError}`);
  const now = s.model?.parts.find((p) => p.id === part.id) ?? part;
  const buildError = s.buildErrors.get(now.hash);
  if (buildError) throw new Error(`${now.label} does not build, so it cannot be checked: ${buildError}`);
  const probes = compareProbes(now, ids);
  const results = await kernel.process(probes);
  const out = probes.map((p, i) => ({ id: p.id as ProcessId, result: results[i], summary: summarize(results[i]) }));
  return out.sort((a, b) => score(a.summary) - score(b.summary));
}

/** Fewer failures first, then fewer warnings. Processes that could not run go last. */
const score = (s: ProcessSummary | null) => (s ? s.fail * 100 + s.warn : 1e9);
