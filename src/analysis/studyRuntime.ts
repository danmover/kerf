// Design studies in the app. A study runs only on demand (it builds and checks
// many designs in the agents' geometry workers and solves their analyses in
// workers of its own), keeps its latest result, and applies any design it
// tried with one undoable edit of the parameter values. The assistant runs one
// through run_analysis and can then apply a design through edit_design's
// alternative:, as it does after compare_designs.

import { create } from "zustand";
import { measureIsolated, pool } from "../agents/isolated";
import { evaluateOnly, useDesign } from "../core/engine";
import { commitSource, realSource } from "../app/project";
import { withValues } from "../core/decisions";
import { fmtNum } from "../lang/values";
import { offerAlternatives } from "../ai/compare";
import { resolveThermal, solveOnce, structuralInput } from "./runtime";
import { runStudy, StudyError, type StudyDeps, type StudyProgress, type StudyResult, type StudyRun } from "./study";
import { MEASURE_UNIT } from "./studyLang";
import type { StudySpec } from "./spec";

export interface StudyState {
  status: "running" | "done" | "error";
  progress?: StudyProgress;
  result?: StudyResult;
  error?: string;
  startedAt: number;
}

export const useStudies = create<{ runs: Map<string, StudyState> }>(() => ({ runs: new Map() }));

const running = new Map<string, { abort: AbortController; done: Promise<StudyState> }>();

function put(label: string, s: StudyState) {
  useStudies.setState({ runs: new Map(useStudies.getState().runs).set(label, s) });
}

const deps = (onProgress: (p: StudyProgress) => void): StudyDeps => ({
  measure: (src, onStage) => measureIsolated(src, () => [], onStage),
  analyse: async (spec, model, built, draft, signal) => {
    const parts = model.parts.filter((q) => spec.parts.includes(q.name));
    const prep = structuralInput(resolveThermal(draft ? { ...spec, resolution: "draft" } : spec, model), parts, false, new Map(), (h) => built.parts.get(h)?.mesh);
    if (!prep) throw new Error("its parts did not build");
    if (prep.error) throw new Error(prep.error);
    return solveOnce(prep.input!, undefined, signal);
  },
  parallel: Math.max(1, pool.size),
  progress: onProgress,
});

/** The label of every design a study tried that passes, as edit_design alternatives: "<study> #3". */
export const runLabel = (study: string, run: StudyRun) => `${study} #${run.index}`;

/** Run a design study (or join the run already under way). */
export function startStudy(label: string): Promise<StudyState> {
  const on = running.get(label);
  if (on) return on.done;
  const s = useDesign.getState();
  const spec = s.model?.analyses.find((a): a is StudySpec => a.kind === "study" && a.label === label);
  const fail = (error: string): Promise<StudyState> => {
    const st: StudyState = { status: "error", error, startedAt: performance.now(), result: useStudies.getState().runs.get(label)?.result };
    put(label, st);
    return Promise.resolve(st);
  };
  if (!s.model || !spec) return fail(`There is no design study called "${label}".`);
  if (s.model.diagnostics.some((d) => d.severity === "error")) return fail("The design has source errors; fix them before running a study.");
  const source = s.source;
  const model = s.model;
  const abort = new AbortController();
  const startedAt = performance.now();
  put(label, { status: "running", startedAt, result: useStudies.getState().runs.get(label)?.result });
  const done = (async (): Promise<StudyState> => {
    try {
      const result = await runStudy(spec, source, model, deps((progress) => put(label, { status: "running", progress, startedAt, result: useStudies.getState().runs.get(label)?.result })), abort.signal);
      offerAlternatives(
        source,
        result.runs.filter((r) => r.feasible && !r.current).map((r) => [runLabel(label, r), withValues(source, model, r.values)]),
      );
      const st: StudyState = { status: "done", result, startedAt };
      put(label, st);
      return st;
    } catch (e) {
      const st: StudyState = { status: "error", error: e instanceof StudyError || e instanceof Error ? e.message : String(e), startedAt };
      put(label, st);
      return st;
    } finally {
      running.delete(label);
    }
  })();
  running.set(label, { abort, done });
  return done;
}

export function stopStudy(label: string) {
  running.get(label)?.abort.abort();
}

export const studyRunning = (label: string) => running.has(label);

/** Write one of a study's designs into the design: its parameter values, as one undoable change. */
export function applyStudyRun(label: string, index: number) {
  const run = useStudies.getState().runs.get(label)?.result?.runs[index];
  if (!run) return;
  const src = realSource();
  const next = withValues(src, evaluateOnly(src), run.values);
  commitSource(next, "you", `Use design ${index} of "${label}": ${Object.entries(run.values).map(([k, v]) => `${k} ${fmtNum(v, 3)}`).join(", ")}`);
}

// ---------- in words ----------

const unitText = (spec: StudySpec, v: number | null) => (v === null ? "not measured" : `${fmtNum(v, Math.abs(v) < 10 ? 3 : 1)}${MEASURE_UNIT[spec.goal.what] ? ` ${MEASURE_UNIT[spec.goal.what]}` : ""}`);
const valuesText = (r: StudyRun) =>
  Object.entries(r.values)
    .map(([k, v]) => `${k} ${fmtNum(v, 3)}`)
    .join(", ");

/** One line per design, best first. */
export function runLine(spec: StudySpec, r: StudyRun): string {
  if (r.status === "error") return `#${r.index} (${valuesText(r)}): could not be measured: ${r.error}`;
  const bad = r.checks.filter((c) => c.margin < 0).map((c) => `${c.text} (${Number.isFinite(c.value) ? fmtNum(c.value, 3) : "?"}${c.unit && c.unit !== "×" ? ` ${c.unit}` : c.unit})`);
  const why = [...bad, ...r.newFails.map((t) => `newly fails "${t}"`), ...r.analyses.filter((a) => a.error).map((a) => `"${a.label}" did not solve: ${a.error}`)];
  return `#${r.index}${r.current ? " (current)" : ""} ${valuesText(r)}: ${spec.goal.what} ${unitText(spec, r.goal)}${r.mass !== null && spec.goal.what !== "mass" ? `, mass ${fmtNum(r.mass, 1)} g` : ""} ${r.feasible ? "passes" : `does not pass: ${why.join("; ") || "a check fails"}`}`;
}

/** The study's result for the assistant: the best design, what it changes, every run, and how to apply one. */
export function studySummary(spec: StudySpec, st: StudyState | undefined): string {
  const head = `"${spec.label}" design study: ${spec.goal.text}, varying ${spec.vary.map((v) => `${v.name} ${fmtNum(v.min, 3)}–${fmtNum(v.max, 3)}${v.step ? ` step ${fmtNum(v.step, 3)}` : ""}`).join(", ")}${spec.limits.length ? `; keep ${spec.limits.map((l) => l.text).join(", ")}` : ""}.`;
  if (!st) return `${head} Not run yet.`;
  if (st.status === "running") return `${head} Running: ${st.progress?.stage ?? "starting"} (${st.progress?.done ?? 0} of ${spec.runs} designs).`;
  if (st.status === "error") return `${head} Could not run: ${st.error}`;
  const r = st.result!;
  const lines = [head, `Solved ${r.using.length ? r.using.map((l) => `"${l}"`).join(", ") : "no analyses (mass only)"} for each of ${r.runs.length} designs at draft resolution, in ${fmtNum(r.ms / 1000, 0)} s.`];
  const cur = r.runs.find((x) => x.current);
  const best = r.best !== null ? r.runs[r.best] : null;
  if (best) {
    const change = cur && cur.goal !== null && best.goal !== null && cur.goal !== 0 ? ` (${best.goal < cur.goal ? "−" : "+"}${fmtNum(Math.abs(((best.goal - cur.goal) / cur.goal) * 100), 0)} % against the current ${unitText(spec, cur.goal)})` : "";
    lines.push(`Best that passes: #${best.index}, ${valuesText(best)}: ${spec.goal.what} ${unitText(spec, best.goal)}${change}.`);
    if (r.confirmed) lines.push(`Confirmed at the analyses' own resolution: ${r.confirmed.feasible ? "still passes" : "no longer passes every target"}${r.confirmed.checks.length ? ` (${r.confirmed.checks.map((c) => `${c.text}: ${fmtNum(c.value, 3)}`).join("; ")})` : ""}.`);
  } else lines.push("No design passes everything.");
  if (r.sensitivity.length) lines.push(`What matters most, across each range at the best design: ${r.sensitivity.map((s) => `${s.name} ${s.effect >= 0 ? "+" : "−"}${fmtNum(Math.abs(s.effect), 3)}${MEASURE_UNIT[spec.goal.what] ? ` ${MEASURE_UNIT[spec.goal.what]}` : ""}`).join(", ")}.`);
  for (const n of r.notes) lines.push(n);
  const order = [...r.runs].sort((a, b) => Number(b.feasible) - Number(a.feasible) || (a.goal ?? Infinity) * (spec.goal.sense === "min" ? 1 : -1) - (b.goal ?? Infinity) * (spec.goal.sense === "min" ? 1 : -1));
  lines.push("", "Designs, passing ones first:", ...order.slice(0, 12).map((x) => `  ${runLine(spec, x)}`));
  if (r.runs.length > 12) lines.push(`  and ${r.runs.length - 12} more`);
  const offer = r.runs.filter((x) => x.feasible && !x.current);
  if (offer.length) lines.push("", `To apply one, call edit_design with alternative: "${runLabel(spec.label, best ?? offer[0])}" (or any "${spec.label} #<n>" that passes) and a summary; the user can also press Use on its row in the analysis tab.`);
  return lines.join("\n");
}

/** A study's state in a few words, for the design overview. */
export function studyStatus(spec: StudySpec): string | undefined {
  const st = useStudies.getState().runs.get(spec.label);
  if (!st) return undefined;
  if (st.status === "running") return `running, ${st.progress?.done ?? 0} of ${spec.runs} designs`;
  if (st.status === "error") return `could not run: ${st.error}`;
  const r = st.result!;
  const best = r.best !== null ? r.runs[r.best] : null;
  const cur = r.runs.find((x) => x.current);
  if (!best) return `no design of ${r.runs.length} passes everything`;
  const change = cur && cur.goal && best.goal !== null ? `, ${best.goal < cur.goal ? "−" : "+"}${fmtNum(Math.abs(((best.goal - cur.goal) / cur.goal) * 100), 0)} % against the current design` : "";
  return `best #${best.index} (${valuesText(best)}): ${spec.goal.what} ${unitText(spec, best.goal)}${change}; ${r.runs.length} designs tried`;
}
