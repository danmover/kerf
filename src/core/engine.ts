// The design engine: source text in, evaluated model, meshes and check
// report out. Revisions rebuild only parts whose geometry hash changed,
// show fast preview meshes first, then run checks and refine the meshes.

import { create } from "zustand";
import { parse } from "../lang/parser";
import { evaluate } from "../lang/evaluator";
import { detailKernel, kernel, type KernelStatus, type PartResult } from "../kernel/client";
import type { MeshData } from "../kernel/build";
import type { Interference, ChecksResult } from "../kernel/protocol";
import { hasDetail, type V3 } from "../kernel/recipe";
import { assembleReport, buildChecksRequest, type CheckReport } from "./checks";
import type { Conflict } from "./feasibility";
import type { EvalPart, Model } from "./model";
import type { SolveRequest, SolveResponse } from "./solver.worker";

export interface MeshEntry {
  preview?: MeshData;
  final?: MeshData;
  volume: number;
  bbox: [V3, V3];
  /** revision that first produced this geometry, used for the build-in animation */
  rev: number;
}

export type Stage = "idle" | "evaluating" | "building" | "checking" | "refining" | "done";

export interface DesignState {
  rev: number;
  source: string;
  model: Model | null;
  stage: Stage;
  progress: { done: number; total: number };
  timings: { evalMs: number; buildMs: number; checksMs: number; built: number; reused: number };
  meshVersion: number;
  buildErrors: Map<string, string>;
  /** problems in the detailed (full-quality) build, by geometry hash */
  detailIssues: Map<string, string>;
  report: CheckReport | null;
  reportRev: number;
  checksError: string;
  interferences: Interference[];
  conflict: Conflict | null;
  conflictState: "idle" | "solving" | "done" | "error";
  hold: string[];
  kernelStatus: KernelStatus;
  kernelError: string;
  kernelInitMs: number;
}

/** Mesh cache by geometry hash. Mutable, outside React state; meshVersion signals changes. */
export const meshes = new Map<string, MeshEntry>();

export const useDesign = create<DesignState>(() => ({
  rev: 0,
  source: "",
  model: null,
  stage: "idle",
  progress: { done: 0, total: 0 },
  timings: { evalMs: 0, buildMs: 0, checksMs: 0, built: 0, reused: 0 },
  meshVersion: 0,
  buildErrors: new Map(),
  detailIssues: new Map(),
  report: null,
  reportRev: 0,
  checksError: "",
  interferences: [],
  conflict: null,
  conflictState: "idle",
  hold: [],
  kernelStatus: "loading",
  kernelError: "",
  kernelInitMs: 0,
}));

const get = useDesign.getState;
const set = useDesign.setState;

let parsedCache: { src: string; parsed: ReturnType<typeof parse> } | null = null;
let activeJobs: { cancel: () => void }[] = [];
/** geometry hashes whose detailed build failed: not retried until the design is reloaded */
const detailFailed = new Set<string>();
let bumpScheduled = false;

function bumpMeshes() {
  if (bumpScheduled) return;
  bumpScheduled = true;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16);
  raf(() => {
    bumpScheduled = false;
    set((s) => ({ meshVersion: s.meshVersion + 1 }));
  });
}

let started = false;
export function startEngine() {
  if (started) return;
  started = true;
  kernel.subscribe(() => set({ kernelStatus: kernel.status, kernelError: kernel.error, kernelInitMs: kernel.initMs }));
  kernel.onReset(() => {
    // the worker's solid cache is gone: rebuild everything for the current source
    meshes.clear();
    set({ buildErrors: new Map() });
    bumpMeshes();
    const { source } = get();
    if (source) setSource(source, { force: true });
  });
  kernel.start();
  // the detail worker starts on first use; if it is restarted, request the detailed geometry again
  detailKernel.onReset(() => {
    const { source } = get();
    if (source) setSource(source, { force: true });
  });
}

function parseCached(src: string) {
  if (parsedCache?.src === src) return parsedCache.parsed;
  const parsed = parse(src);
  parsedCache = { src, parsed };
  return parsed;
}

/** Load a different design: drop cached geometry from the previous one. */
export function loadSource(src: string) {
  for (const j of activeJobs) j.cancel();
  activeJobs = [];
  meshes.clear();
  detailFailed.clear();
  kernel.evict([]);
  detailKernel.evict([]);
  set({ buildErrors: new Map(), report: null, interferences: [], conflict: null, conflictState: "idle", hold: [], checksError: "" });
  bumpMeshes();
  setSource(src, { force: true });
}

/** Evaluate new source and start the rebuild pipeline. Returns the evaluated model. */
export function setSource(src: string, opts: { force?: boolean } = {}): Model {
  const s = get();
  if (!opts.force && src === s.source && s.model) return s.model;
  const rev = s.rev + 1;
  const t0 = performance.now();
  const parsed = parseCached(src);
  const model = evaluate(src, { parsed });
  const evalMs = performance.now() - t0;
  set({ rev, source: src, model, stage: "building", timings: { ...s.timings, evalMs } });
  void runPipeline(rev, src, model, parsed);
  solveIfNeeded(rev, src, model);
  return model;
}

/** Evaluate without committing (used by the AI to preview an edit). */
export function evaluateOnly(src: string): Model {
  return evaluate(src, { parsed: parse(src) });
}

function uniqueParts(model: Model): Map<string, EvalPart> {
  const byHash = new Map<string, EvalPart>();
  for (const p of model.parts) if (!byHash.has(p.hash)) byHash.set(p.hash, p);
  return byHash;
}

async function runPipeline(rev: number, src: string, model: Model, parsed: ReturnType<typeof parse>) {
  for (const j of activeJobs) j.cancel();
  activeJobs = [];
  try {
    await kernel.ready();
  } catch {
    if (get().rev === rev) set({ stage: "done" });
    return;
  }
  if (get().rev !== rev) return;

  const byHash = uniqueParts(model);
  const errors = get().buildErrors;
  const todo = [...byHash.values()].filter((p) => !meshes.get(p.hash)?.preview && !errors.has(p.hash));
  const total = byHash.size;
  let done = total - todo.length;
  const reused = done;
  set({ stage: todo.length ? "building" : "checking", progress: { done, total } });

  const tBuild = performance.now();
  if (todo.length) {
    const job = kernel.build(
      todo.map((p) => ({ hash: p.hash, recipe: p.recipe, label: p.label })),
      "preview",
      (r: PartResult) => {
        const prev = meshes.get(r.hash);
        meshes.set(r.hash, { ...prev, preview: r.mesh, volume: r.volume, bbox: r.bbox, rev: prev?.rev ?? rev });
        done++;
        if (get().rev === rev) set({ progress: { done, total } });
        bumpMeshes();
      },
      (hash, message) => {
        const next = new Map(get().buildErrors);
        next.set(hash, message);
        done++;
        set({ buildErrors: next, progress: { done, total } });
      },
    );
    activeJobs.push(job);
    const r = await job.done;
    if (r.cancelled || get().rev !== rev) return;
  }
  const buildMs = performance.now() - tBuild;

  // checks need every solid in the worker's cache
  set({ stage: "checking", timings: { ...get().timings, buildMs, built: todo.length, reused } });
  const builtHashes = new Set([...byHash.keys()].filter((h) => meshes.has(h)));
  const tChecks = performance.now();
  let result: ChecksResult | null = null;
  let checksError = "";
  try {
    result = await kernel.checks(buildChecksRequest(model, builtHashes));
  } catch (e) {
    checksError = e instanceof Error ? e.message : String(e);
  }
  if (get().rev !== rev) return;
  const geoModel = result && model.geoQueries.length ? evaluate(src, { parsed, geo: result.geo }) : null;
  // detail problems found earlier still apply to parts whose geometry has not changed
  const report = withDetailIssues(assembleReport(model, geoModel, result, get().buildErrors, new Map(model.parts.map((p) => [p.id, p]))), model, get().detailIssues);
  set({
    report,
    reportRev: rev,
    checksError,
    interferences: result?.interferences ?? [],
    stage: "refining",
    timings: { ...get().timings, checksMs: performance.now() - tChecks },
  });

  // refine: exact-tolerance meshes here; the detailed geometry (threads, knurls, cosmetic steps) in a worker of its
  // own, so a slow detail build never holds up the next edit's preview and checks
  const refine = [...byHash.values()].filter((p) => meshes.get(p.hash)?.preview && !meshes.get(p.hash)?.final && !detailFailed.has(p.hash));
  if (refine.length) {
    const issues = new Map(get().detailIssues);
    const onPart = (r: PartResult) => {
      const prev = meshes.get(r.hash);
      if (prev) {
        prev.final = r.mesh;
        bumpMeshes();
      }
      if (r.warnings?.length) issues.set(r.hash, r.warnings.join(" "));
      else issues.delete(r.hash);
    };
    const onError = (hash: string, message: string) => {
      // the simple shape stays on screen; say what the detail pass could not do
      detailFailed.add(hash);
      issues.set(hash, `The detailed build failed, so the simple shape is shown: ${message}`);
      // keep it even if this run is cut short: a detail worker that stalls is replaced, which cancels the run
      set({ detailIssues: new Map(get().detailIssues).set(hash, issues.get(hash)!) });
    };
    const item = (p: EvalPart) => ({ hash: p.hash, recipe: p.recipe, label: p.label });
    const detailed = refine.filter((p) => hasDetail(p.recipe));
    const plain = refine.filter((p) => !hasDetail(p.recipe));
    const jobs: ReturnType<typeof kernel.build>[] = [];
    if (plain.length) jobs.push(kernel.build(plain.map(item), "final", onPart, onError));
    if (detailed.length && detailKernel.status === "error") {
      for (const p of detailed) issues.set(p.hash, `The detailed build is unavailable, so the simple shape is shown: ${detailKernel.error}`);
    } else if (detailed.length) {
      detailKernel.start();
      jobs.push(detailKernel.build(detailed.map(item), "final", onPart, onError));
    }
    activeJobs.push(...jobs);
    const results = await Promise.all(jobs.map((j) => j.done));
    if (results.some((r) => r.cancelled) || get().rev !== rev) return;
    const live = new Set(byHash.keys());
    for (const h of [...issues.keys()]) if (!live.has(h)) issues.delete(h);
    const report = get().report;
    set({ detailIssues: issues, report: report && withDetailIssues(report, model, issues) });
  }
  set({ stage: "done" });
}

/** Add the detail pass's problems to a report as warnings. */
export function withDetailIssues(report: CheckReport, model: Model, issues: Map<string, string>): CheckReport {
  const items = report.items.filter((i) => !i.id.startsWith("detail:"));
  const seen = new Set<string>();
  for (const p of model.parts) {
    const msg = issues.get(p.hash);
    if (!msg || seen.has(p.hash)) continue;
    seen.add(p.hash);
    const same = model.parts.filter((q) => q.hash === p.hash).map((q) => q.id);
    items.push({ id: `detail:${p.id}`, category: "build", status: "warn", title: `${p.label} detail`, detail: msg, parts: same, span: p.span, basis: "geometry" });
  }
  const counts = { pass: 0, fail: 0, warn: 0, pending: 0, info: 0 };
  for (const i of items) counts[i.status]++;
  return { ...report, items, counts };
}

/** Resolves once checks have run for the current revision (or a later one). */
export function whenChecked(timeoutMs = 120_000): Promise<DesignState> {
  const target = get().rev;
  return new Promise((resolve) => {
    const finish = () => {
      unsub();
      clearTimeout(timer);
      resolve(get());
    };
    const ok = (s: DesignState) => s.reportRev >= target || (s.kernelStatus === "error" && s.rev >= target);
    if (ok(get())) return resolve(get());
    const unsub = useDesign.subscribe((s) => {
      if (ok(s)) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Resolves once final meshes exist for every part of the current revision. */
export function whenRefined(timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve) => {
    const ok = (s: DesignState) => s.stage === "done" || s.kernelStatus === "error";
    if (ok(get())) return resolve();
    const unsub = useDesign.subscribe((s) => {
      if (ok(s)) {
        unsub();
        clearTimeout(timer);
        resolve();
      }
    });
    const timer = setTimeout(() => {
      unsub();
      resolve();
    }, timeoutMs);
  });
}

// ---------- feasibility solving in its own worker ----------

/** A solver worker that only cares about its latest request: a new one replaces a running one. */
class SolverChannel {
  private w: Worker | null = null;
  private busy = false;
  private id = 0;
  private waiter: ((c: Conflict | null, error?: string) => void) | null = null;

  solve(src: string, hold: string[]): Promise<{ conflict: Conflict | null; error?: string }> {
    if (this.w && this.busy) {
      this.w.terminate();
      this.w = null;
      this.waiter?.(null, "superseded");
    }
    if (!this.w) {
      this.w = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module", name: "kerf-solver" });
      this.w.onmessage = (ev: MessageEvent<SolveResponse>) => {
        if (ev.data.id !== this.id) return;
        this.busy = false;
        const w = this.waiter;
        this.waiter = null;
        w?.(ev.data.conflict, ev.data.error);
      };
      this.w.onerror = (ev) => {
        ev.preventDefault();
        this.busy = false;
        this.w?.terminate();
        this.w = null;
        const w = this.waiter;
        this.waiter = null;
        w?.(null, "The solver stopped unexpectedly");
      };
    }
    const id = ++this.id;
    this.busy = true;
    return new Promise((resolve) => {
      this.waiter = (conflict, error) => resolve({ conflict, error });
      this.w!.postMessage({ id, src, hold } satisfies SolveRequest);
    });
  }
}

const uiSolver = new SolverChannel();
const aiSolver = new SolverChannel();

function hasHardParamFailure(model: Model) {
  return model.requirements.some((r) => r.level === "hard" && r.status === "fail" && r.geo.length === 0);
}

function solveIfNeeded(rev: number, src: string, model: Model) {
  if (!hasHardParamFailure(model)) {
    if (get().conflict || get().conflictState !== "idle") set({ conflict: null, conflictState: "idle" });
    return;
  }
  set({ conflictState: "solving" });
  void uiSolver.solve(src, get().hold).then(({ conflict, error }) => {
    if (error === "superseded" || get().rev !== rev) return;
    set({ conflict, conflictState: error ? "error" : "done" });
  });
}

export function setHold(hold: string[]) {
  set({ hold });
  const { rev, source, model } = get();
  if (model) solveIfNeeded(rev, source, model);
}

/** One-off solve with a specific hold list (used by the AI's explore_fixes tool). */
export async function solveWith(src: string, hold: string[]): Promise<Conflict | null> {
  const { conflict, error } = await aiSolver.solve(src, hold);
  if (error && error !== "superseded") throw new Error(error);
  return conflict;
}
