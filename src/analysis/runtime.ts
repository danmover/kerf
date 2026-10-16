// Runs the design's analyses and feeds their results into the check report.
// Drivetrain checks are formulas and run at once; structural analyses run in
// their own worker after each build, only when their inputs (set-up, part
// geometry, placement, material) changed, and a newer change cancels an
// older run. Results join the report as check items through a report pass,
// which the engine re-composes whenever a run finishes.

import { create } from "zustand";
import { meshes, refreshReport, useDesign } from "../core/engine";
import type { CheckItem } from "../core/checks";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { EvalPart, Model } from "../core/model";
import { xformMatrix } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { mechMaterial, type MechMaterial } from "./materials";
import { runDrivetrain, type DrivetrainResult } from "./drivetrain";
import { RESOLUTION_TARGET, type DrivetrainSpec, type StructuralSpec } from "./spec";
import type { FeaPart, StructuralInput, StructuralResult } from "./fe/structural";
import { modeText, stiffnessVerdict, strengthVerdict } from "./summary";
import type { FeaRequest, FeaResponse } from "./protocol";

export type ResultField = "stress" | "safety" | "disp" | "strain";

export interface StructuralRun {
  label: string;
  /** identity of the inputs: a run with the same key gives the same answer */
  key: string;
  fine: boolean;
  status: "waiting" | "running" | "done" | "error";
  stage: string;
  frac: number;
  iter?: number;
  residual?: number;
  /** residual per iteration while solving, for the convergence trace */
  trace: number[];
  /** the latest result; while a newer run is under way this is the previous one */
  result?: StructuralResult;
  stale: boolean;
  error?: string;
  /** the set-up cannot be solved as written (as opposed to a crash) */
  setup?: boolean;
  /** element count target or size used */
  resolution: string;
  startedAt: number;
}

interface AnalysisState {
  /** keyed by analysis label (labels are the user's text, so a Map rather than an object) */
  runs: Map<string, StructuralRun>;
  drivetrain: Map<string, DrivetrainResult>;
  /** analysis whose results are drawn on the model */
  shown: string | null;
  /** analysis open in the analysis tab */
  selected: string | null;
  field: ResultField;
  /** deformation: 0 = undeformed shape, 1 = automatic exaggeration, otherwise a multiple of it */
  deform: number;
  /** show deflection at its real size */
  trueScale: boolean;
  /** oscillate between the unloaded and loaded shape */
  animate: boolean;
}

export const useAnalysis = create<AnalysisState>(() => ({
  runs: new Map(),
  drivetrain: new Map(),
  shown: null,
  selected: null,
  field: "stress",
  deform: 1,
  trueScale: false,
  animate: true,
}));

const aGet = useAnalysis.getState;
const aSet = useAnalysis.setState;

// ---------- worker ----------

interface Job {
  id: number;
  label: string;
  key: string;
  input: StructuralInput;
}
let worker: Worker | null = null;
let current: Job | null = null;
let queue: Job[] = [];
let nextId = 0;
let deadline: ReturnType<typeof setTimeout> | null = null;
/** a run that takes longer than this is stopped, so one runaway analysis cannot hold up the others */
export const RUN_TIME_LIMIT_MS = 180_000;
const fineWanted = new Map<string, string>(); // label -> base key the fine run was asked for

function patchRun(label: string, patch: Partial<StructuralRun>) {
  const r = aGet().runs.get(label);
  if (!r) return;
  aSet({ runs: new Map(aGet().runs).set(label, { ...r, ...patch }) });
}

/** Stop the worker and whatever it is running. */
function stopWorker() {
  if (deadline) clearTimeout(deadline);
  deadline = null;
  worker?.terminate();
  worker = null;
  current = null;
}

/** The current run ended without a result: drop any older result too, since it no longer matches the design. */
function failCurrent(error: string, setup = false) {
  const job = current;
  stopWorker();
  if (job) patchRun(job.label, { status: "error", error, setup, result: undefined, stale: false });
  refreshReport();
  pump();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./fea.worker.ts", import.meta.url), { type: "module", name: "kerf-analysis" });
  w.onmessage = (ev: MessageEvent<FeaResponse>) => {
    const msg = ev.data;
    if (!current || msg.id !== current.id) return;
    const { label } = current;
    if (msg.type === "progress") {
      const r = aGet().runs.get(label);
      if (!r) return;
      const trace = msg.iter !== undefined && msg.residual !== undefined ? [...r.trace.slice(0, msg.iter - 1), msg.residual] : r.trace;
      patchRun(label, { stage: msg.stage, frac: msg.frac, iter: msg.iter, residual: msg.residual, trace });
      return;
    }
    if (msg.type === "error") return failCurrent(msg.message, !!msg.setup);
    if (deadline) clearTimeout(deadline);
    deadline = null;
    current = null;
    patchRun(label, { status: "done", result: msg.result, stale: false, error: undefined, setup: undefined, frac: 1, stage: "Done", trace: msg.result.solve.history });
    refreshReport();
    pump();
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    failCurrent('The analysis stopped unexpectedly, most likely out of memory. Try a coarser resolution: "draft".');
  };
  worker = w;
  return w;
}

function pump() {
  if (current || !queue.length) return;
  const job = queue.shift()!;
  current = job;
  patchRun(job.label, { status: "running", startedAt: performance.now(), stage: "Meshing", frac: 0, trace: [] });
  const transfer = job.input.parts.flatMap((p) => [p.mesh.positions.buffer, p.mesh.indices.buffer, ...(p.normals ? [p.normals.buffer] : [])]) as ArrayBuffer[];
  ensureWorker().postMessage({ id: job.id, input: job.input } satisfies FeaRequest, transfer);
  deadline = setTimeout(() => {
    if (current === job) failCurrent(`The analysis took longer than ${RUN_TIME_LIMIT_MS / 60_000} minutes and was stopped. Try a coarser resolution, such as "draft", or analyse fewer parts at once.`);
  }, RUN_TIME_LIMIT_MS);
}

function cancel(label: string) {
  queue = queue.filter((j) => j.label !== label);
  if (current?.label === label) stopWorker();
}

// ---------- preparing a run ----------

/** World-space meshes and properties of the parts an analysis names; null while geometry is still building. */
function prepare(spec: StructuralSpec, parts: EvalPart[], fine: boolean, buildErrors: Map<string, string>): { input?: StructuralInput; error?: string } | null {
  if (!parts.length) return { error: `None of ${spec.parts.join(", ")} has geometry to analyse.` };
  const broken = parts.find((p) => buildErrors.has(p.hash));
  if (broken) return { error: `${broken.label} did not build, so it cannot be analysed yet.` };
  const fea: FeaPart[] = [];
  const mats: MechMaterial[] = [];
  const matIndex = new Map<string, number>();
  for (const p of parts) {
    const entry = meshes.get(p.hash);
    const data = entry?.preview ?? entry?.final;
    if (!data) return null;
    const name = spec.material ?? p.material;
    let mi = matIndex.get(name);
    if (mi === undefined) {
      mi = mats.length;
      mats.push(mechMaterial(name));
      matIndex.set(name, mi);
    }
    const m = xformMatrix(p.xf);
    const P = data.positions;
    const N = data.normals;
    const pos = new Float32Array(P.length);
    const nrm = new Float32Array(N.length);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i],
        y = P[i + 1],
        z = P[i + 2];
      pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const a = N[i],
        b = N[i + 1],
        c = N[i + 2];
      nrm[i] = m[0] * a + m[4] * b + m[8] * c;
      nrm[i + 1] = m[1] * a + m[5] * b + m[9] * c;
      nrm[i + 2] = m[2] * a + m[6] * b + m[10] * c;
    }
    fea.push({ id: p.id, name: p.name, mesh: { positions: pos, indices: Uint32Array.from(data.indices) }, normals: nrm, material: mi });
  }
  const res = fine ? "fine" : spec.resolution;
  const input: StructuralInput = {
    label: spec.label,
    parts: fea,
    materials: mats,
    supports: spec.supports,
    loads: spec.loads,
    accel: spec.accel,
    target: typeof res === "string" ? RESOLUTION_TARGET[res] : RESOLUTION_TARGET.standard,
    h: typeof res === "string" ? undefined : res.h,
    printed: spec.printed ?? mats.some((m) => m.printedByDefault),
    buildDir: spec.buildDir,
    cycles: spec.cycles,
    safety: spec.safety,
    maxDeflection: spec.maxDeflection,
  };
  return { input };
}

function inputKey(spec: StructuralSpec, parts: EvalPart[], fine: boolean): string {
  const { span: _span, ...rest } = spec;
  void _span;
  return JSON.stringify({ rest, fine, parts: parts.map((p) => [p.id, p.hash, p.xf, p.material]) });
}

const baseKey = (key: string) => key.replace(/"fine":(true|false)/, "");

// ---------- scheduling ----------

let scheduledRev = -1;

/** Queue runs for the analyses whose inputs changed in this revision. */
function schedule(state: Pick<ReportContext, "model" | "rev" | "buildErrors">) {
  const model = state.model;
  scheduledRev = state.rev;
  const specs = model.analyses.filter((a): a is StructuralSpec => a.kind === "structural");
  const labels = new Set(specs.map((s) => s.label));
  const runs = new Map(aGet().runs);
  let shown = aGet().shown;
  for (const label of runs.keys()) {
    if (labels.has(label)) continue;
    cancel(label);
    runs.delete(label);
    if (shown === label) shown = null;
  }
  for (const spec of specs) {
    // compare input keys first: meshes are only copied into world space when something changed
    const parts = model.parts.filter((p) => spec.parts.includes(p.name));
    const plainKey = inputKey(spec, parts, false);
    // a fine run stays fine until the inputs change
    const fine = fineWanted.get(spec.label) === baseKey(plainKey);
    if (!fine) fineWanted.delete(spec.label);
    const key = fine ? inputKey(spec, parts, true) : plainKey;
    const run = runs.get(spec.label);
    if (run && run.key === key) continue;
    const prep = prepare(spec, parts, fine, state.buildErrors);
    if (!prep) continue;
    cancel(spec.label);
    const resolution = fine ? "fine" : typeof spec.resolution === "string" ? spec.resolution : `${fmtNum(spec.resolution.h)} mm`;
    const base: StructuralRun = { label: spec.label, key, fine, status: "waiting", stage: "Waiting", frac: 0, trace: [], stale: !!run?.result, result: run?.result, resolution, startedAt: performance.now() };
    if (prep.error) runs.set(spec.label, { ...base, status: "error", error: prep.error, setup: true, result: undefined, stale: false });
    else {
      runs.set(spec.label, base);
      queue.push({ id: ++nextId, label: spec.label, key, input: prep.input! });
    }
  }
  aSet({ runs, shown });
  pump();
}

/** Re-run one analysis at the fine resolution. */
export function runFine(label: string) {
  const run = aGet().runs.get(label);
  if (!run) return;
  fineWanted.set(label, baseKey(run.key));
  const s = useDesign.getState();
  // force a fresh key comparison
  aSet({ runs: new Map(aGet().runs).set(label, { ...run, key: "" }) });
  if (s.model) schedule({ model: s.model, rev: s.reportRev, buildErrors: s.buildErrors });
  refreshReport();
}

// ---------- check items ----------

const ANALYSIS_ITEM = /^(fea|drive):/;
let drivetrainCache: { model: Model; results: Map<string, DrivetrainResult> } | null = null;

/** Drivetrain checks are formulas: worked out once per model. Only the live design's results go to the panel. */
function drivetrainResults(model: Model, live: boolean): Map<string, DrivetrainResult> {
  if (drivetrainCache?.model === model) return drivetrainCache.results;
  const results = new Map<string, DrivetrainResult>();
  for (const a of model.analyses) if (a.kind === "drivetrain") results.set(a.label, runDrivetrain(model, a as DrivetrainSpec));
  if (!live) return results;
  drivetrainCache = { model, results };
  aSet({ drivetrain: results });
  return results;
}

/**
 * The report pass: schedules runs for a new revision, then adds drivetrain
 * checks and the state of every structural analysis. A sub-agent's isolated
 * build gets the drivetrain checks; its stress analyses run after it merges.
 */
export function analysisItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  const { model } = ctx;
  if (ctx.live && ctx.rev !== scheduledRev) schedule(ctx);
  let out = items.filter((i) => !ANALYSIS_ITEM.test(i.id));
  const dt = drivetrainResults(model, ctx.live);
  if (dt.size) out = out.filter((i) => i.id !== "analysis:loads");
  for (const r of dt.values()) out.push(...r.items);
  for (const a of model.analyses) {
    if (a.kind !== "structural") continue;
    if (ctx.live) out.push(...structuralItems(a, aGet().runs.get(a.label), model));
    else out.push({ id: `fea:${a.label}:strength`, category: "analysis", basis: "simulation", span: a.span, status: "info", title: `Strength: ${a.label}`, detail: "The stress analysis runs once this work is merged into the design." });
  }
  return out;
}

const fmtP = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;

function structuralItems(spec: StructuralSpec, run: StructuralRun | undefined, model: Model): CheckItem[] {
  const parts = model.parts.filter((p) => spec.parts.includes(p.name)).map((p) => p.id);
  const base = { category: "analysis" as const, basis: "simulation" as const, span: spec.span, parts };
  const id = (s: string) => `fea:${spec.label}:${s}`;
  if (!run || run.status === "waiting" || run.status === "running") {
    return [{ ...base, id: id("strength"), status: "pending", title: `Strength: ${spec.label}`, detail: run?.result ? "Re-running the stress analysis for the latest change…" : "Running the stress analysis…" }];
  }
  if (run.status === "error" || !run.result) {
    return [{ ...base, id: id("setup"), status: "fail", title: `Stress analysis: ${spec.label}`, detail: run.error ?? "The analysis did not finish." }];
  }
  const r = run.result;
  const out: CheckItem[] = [];
  const sf = r.minSafety.value;
  const { status, note } = strengthVerdict(spec, r);
  out.push({
    ...base,
    id: id("strength"),
    status,
    margin: sf - spec.safety,
    title: `Strength: ${spec.label}`,
    detail:
      `Peak ${fmtNum(r.maxStress.value, 1)} MPa (von Mises) near ${fmtP(r.maxStress.at)}. Lowest safety factor ${fmtNum(sf, 2)} against the ${modeText(r, spec.cycles)}, target ${fmtNum(spec.safety, 2)}.` +
      ` Largest deflection ${fmtNum(r.maxDisp.value, 3)} mm.` +
      note,
  });
  if (spec.maxDeflection !== undefined) {
    const status = stiffnessVerdict(spec, r)!;
    out.push({
      ...base,
      id: id("stiffness"),
      status,
      margin: spec.maxDeflection - r.maxDisp.value,
      title: `Stiffness: ${spec.label}`,
      detail: `Largest deflection ${fmtNum(r.maxDisp.value, 3)} mm at ${fmtP(r.maxDisp.at)}, limit ${fmtNum(spec.maxDeflection, 3)} mm.${status === "warn" ? " The result is in doubt; the strength check says why." : ""}`,
    });
  }
  if (r.warnings.length) out.push({ ...base, id: id("notes"), status: "info", title: `Accuracy notes: ${spec.label}`, detail: r.warnings.join(" ") });
  return out;
}

// ---------- start-up and waiting ----------

let started = false;

/** Hook the runtime to the design engine: its report pass schedules runs and adds their results to every report. */
export function startAnalysisRuntime() {
  if (started) return;
  started = true;
  registerReportPass("analyses", analysisItems, 20);
  // a report composed before the runtime started has no analysis items yet
  refreshReport();
}

/** Resolves when every structural analysis of the current design has a result or an error. */
export function whenAnalyzed(timeoutMs = 180_000): Promise<void> {
  const done = () => {
    const d = useDesign.getState();
    if (!d.model || d.reportRev < d.rev) return false;
    if (scheduledRev < d.reportRev) return false;
    return d.model.analyses.every((a) => a.kind !== "structural" || ["done", "error"].includes(aGet().runs.get(a.label)?.status ?? ""));
  };
  return new Promise((resolve) => {
    if (done()) return resolve();
    const finish = () => {
      clearTimeout(timer);
      u1();
      u2();
      resolve();
    };
    const check = () => done() && finish();
    const u1 = useAnalysis.subscribe(check);
    const u2 = useDesign.subscribe(check);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Choose which analysis is drawn on the model (null hides results). */
export function showResults(label: string | null) {
  aSet({ shown: label });
}
