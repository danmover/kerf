// Flow and cooling results in words, for the assistant and the design overview. Kept apart from the runtime (no
// engine or worker here), so the summaries can be read anywhere; the runtime tells it where its runs are.

import { fmtNum } from "../lang/values";
import type { CheckItem } from "../core/checks";
import type { FlowSpec } from "./spec";
import type { FlowProgress, FlowResult } from "./flow/types";

export interface FlowRun {
  label: string;
  key: string;
  status: "waiting" | "running" | "done" | "error";
  stage: string;
  frac: number;
  progress?: FlowProgress;
  /** the latest result; while a newer run is under way this is the previous one */
  result?: FlowResult;
  stale: boolean;
  error?: string;
  /** the set-up cannot be run as written (as opposed to a crash) */
  setup?: boolean;
  startedAt: number;
}

export const CFM = 0.000471947443;
export const cfm = (q: number) => `${fmtNum(q / CFM, q / CFM < 10 ? 2 : 1)} CFM`;
export const degC = (t: number) => `${fmtNum(t, 1)} °C`;

let runOf: (label: string) => FlowRun | undefined = () => undefined;
/** The runtime says where its runs are when it starts. */
export function setFlowRuns(f: (label: string) => FlowRun | undefined) {
  runOf = f;
}
export const flowRun = (label: string) => runOf(label);

/** The parts sorted by how close they come to their limits (the nearest first). */
export function flowHottest(r: FlowResult) {
  return [...r.parts].filter((p) => Number.isFinite(p.max)).sort((a, b) => (b.limit !== undefined ? b.max - b.limit : b.max - 1e3) - (a.limit !== undefined ? a.max - a.limit : a.max - 1e3));
}

/** What a flow analysis found, for the assistant. */
export function flowSummary(spec: FlowSpec, run: FlowRun | undefined, items: CheckItem[]): string {
  const head = `"${spec.label}" flow and cooling (${spec.drive === "set" ? `${cfm((spec.flow ?? 0) / 1e9)}${spec.fluid === "water" ? ` (${fmtNum(((spec.flow ?? 0) / 1e6) * 60, 2)} L/min) of water` : ""} in at ${spec.inlet?.label}` : spec.drive === "fans" ? "the design's fans" : "warm air rising"})`;
  if (!run || run.status === "waiting" || run.status === "running") return `${head}: still running (${run ? `${Math.round(run.frac * 100)} %, ${run.stage.toLowerCase()}` : "not started"}).`;
  if (run.status === "error" || !run.result) return `${head}: ${run.error ?? "did not finish"}`;
  const r = run.result;
  const lines = [`${head}: ${r.converged ? "settled" : "NOT fully settled"}, ${fmtNum(r.h, 2)} mm cells (${fmtNum(r.cells / 1e6, 2)} million), ambient ${degC(r.ambient)}.`];
  for (const i of items) lines.push(`  - [${i.status}] ${i.title}: ${i.detail}${i.fix ? ` Fix: ${i.fix}` : ""}`);
  const table = flowHottest(r)
    .slice(0, 12)
    .map((p) => `    ${p.name}: max ${degC(p.max)}, mean ${degC(p.mean)}${p.limit !== undefined ? `, limit ${degC(p.limit)}` : ""}${p.watts > 0 ? `, makes ${fmtNum(p.watts, 2)} W` : ""}${p.cells === 0 ? " (smaller than a cell)" : ""}`);
  if (table.length) lines.push("  Parts, nearest their limits first:", ...table);
  return lines.join("\n");
}

/** One line for the design overview. */
export function flowLine(spec: FlowSpec, run: FlowRun | undefined): string {
  const what = spec.drive === "set" ? `${cfm((spec.flow ?? 0) / 1e9)} pushed in` : spec.drive === "fans" ? "fan cooling" : "natural cooling";
  if (!run || run.status === "waiting" || run.status === "running") return `"${spec.label}" flow (${what}): running`;
  if (run.status === "error" || !run.result) return `"${spec.label}" flow (${what}): error: ${run.error ?? "did not finish"}`;
  const r = run.result;
  const hot = flowHottest(r)[0];
  const over = r.parts.filter((p) => p.limit !== undefined && p.max > p.limit).length;
  return `"${spec.label}" flow (${what}): ${over ? `${over} part${over === 1 ? "" : "s"} over their limits` : "within limits"}${hot ? `, hottest ${hot.name} ${degC(hot.max)}` : ""}${r.fans.length ? `, fans ${r.fans.map((f) => cfm(f.flow)).join(", ")}` : ""}${r.drives.length ? `, ${fmtNum(r.drives[0].rise, 1)} Pa to push` : ""}`;
}

