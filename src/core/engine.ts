// The design engine: source text in, evaluated model, meshes and check
// report out. Revisions rebuild only parts whose geometry hash changed,
// show fast preview meshes first, then run checks and refine the meshes.

import { create } from "zustand";
import { parse } from "../lang/parser";
import { evaluate } from "../lang/evaluator";
import { detailKernel, kernel, type KernelStatus, type PartResult } from "../kernel/client";
import type { MeshData, MeshQuality } from "../kernel/build";
import { keepMesh, keptKey, keptMeshes, type KeptMesh, type KeptQuality } from "../persist/geometryCache";
import type { Interference, ChecksResult } from "../kernel/protocol";
import { hasDetail, stableStringify, type V3 } from "../kernel/recipe";
import { displayBuilt, hasThreads } from "../kernel/threadMarks";
import { assembleReport, buildChecksRequest, type CheckItem, type CheckReport } from "./checks";
import { composeReport, registerReportPass, type ReportContext } from "./reportPasses";
import { during } from "../app/stalls";
import { prepareFits } from "../analysis/fits/report";
import { prepareHolds } from "./holds";
import { pacer } from "./slices";
import type { Conflict } from "./feasibility";
import type { EvalPart, Model } from "./model";
import type { SolveRequest, SolveResponse } from "./solver.worker";
import { processProbes } from "../mfg/report";
import { userMachines } from "../mfg/userMachines";
import { useSettings } from "../app/settings";
import type { ProcessProbe, ProcessResult } from "../mfg/types";
import type { MachineContext } from "../mfg/machines";
import { detailImportsLoaded, importsLoaded, modelUsesImports, onImportsChanged, recipeUsesImport, reloadImports } from "./imports";
import { evalImports } from "../lang/imports";
import { designsUsed, evalDesigns } from "../lang/designs";
import { setEvalFaces } from "../lang/mates";
import type { FaceCatalogue } from "./mates";
import { setEvalSplits } from "../lang/split";
import { splitTable } from "./splitGeom";

export interface MeshEntry {
  preview?: MeshData;
  /**
   * What the 3D view shows for a part with threads: exact tolerance, with plain cylinders where the threads are and
   * the threads drawn on them by the part shader. `final` has the real threads, for export, photoreal and close-ups.
   */
  display?: MeshData;
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
  /**
   * `checkSteps`: what the checks' time went on, each from the end of the one before, ms: the kernel's answer, the
   * making checks still to come, the fit study, how the design holds together, and putting the report together.
   * They wait one after another while the work behind them runs side by side, so a step that reads 0 was done by
   * the time the one before it was.
   */
  timings: { evalMs: number; buildMs: number; checksMs: number; built: number; reused: number; checkSteps?: { kernel: number; process: number; fits: number; holds: number; report: number } };
  meshVersion: number;
  buildErrors: Map<string, string>;
  /** problems in the detailed (full-quality) build, by geometry hash */
  detailIssues: Map<string, string>;
  report: CheckReport | null;
  reportRev: number;
  checksError: string;
  interferences: Interference[];
  /** manufacturing-process check results by part id */
  process: Record<string, ProcessResult>;
  conflict: Conflict | null;
  conflictState: "idle" | "solving" | "done" | "error";
  hold: string[];
  kernelStatus: KernelStatus;
  kernelError: string;
  kernelInitMs: number;
  /** the kernel has been ready before: "loading" now is a restart, with the model still on screen */
  kernelStarted: boolean;
}

/** Mesh cache by geometry hash. Mutable, outside React state; meshVersion signals changes. */
export const meshes = new Map<string, MeshEntry>();
/**
 * Geometry the kernel worker lost when it was restarted (it stalled or crashed). The meshes stay on screen, since
 * the same hash is the same shape, and the pipeline builds these again so the new worker has the solids for checks.
 */
const lost = new Set<string>();
/**
 * The kernel's lists of built solids' flat and round faces, by geometry hash, which mates pick from; and the last
 * list each part had, so a mated part stays in place while an edit to it is built.
 */
const faceCats = new Map<string, FaceCatalogue>();
const faceCatsByName = new Map<string, FaceCatalogue>();
setEvalFaces((hash, name) => faceCats.get(hash) ?? faceCatsByName.get(name));
/** Split parts' cuts and pins, worked out from each part's mesh as built, for the printer chosen in Settings. */
const splits = splitTable(userMachines);
setEvalSplits(splits.lookup);
/** A part's fast mesh (or its fine one), for measuring the design: what each screw clamps. */
export const meshOf = (hash: string): MeshData | undefined => {
  const e = meshes.get(hash);
  return e?.preview ?? e?.final;
};

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
  process: {},
  conflict: null,
  conflictState: "idle",
  hold: [],
  kernelStatus: "loading",
  kernelError: "",
  kernelInitMs: 0,
  kernelStarted: false,
}));

const get = useDesign.getState;
const set = useDesign.setState;

let parsedCache: { src: string; parsed: ReturnType<typeof parse> } | null = null;
/** the core report of the latest checks, before the passes in reportPasses add their items */
let reportBase: { report: CheckReport; ctx: ReportContext } | null = null;
// the last full kernel check run (contacts, interferences): the fastener planner reads its contacts
let lastKernel: ChecksResult | null = null;
export const kernelResult = (): ChecksResult | null => lastKernel;
let activeJobs: { cancel: () => void }[] = [];
/**
 * meshes the main kernel did not make (the detail worker's, or kept from an earlier session): their face and edge ids
 * are another kernel's and mean nothing to the main one
 */
const foreignIds = new WeakSet<MeshData>();
/** Whether a pick on this mesh must go to the main kernel as a point, its face and edge ids being another kernel's. */
export const pickByPoint = (m: MeshData): boolean => foreignIds.has(m);
/** refined meshes kept from earlier sessions, read for this design's parts, waiting for their fast build */
const kept = new Map<string, { display?: KeptMesh; final?: KeptMesh }>();
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
  kernel.subscribe(() => set({ kernelStatus: kernel.status, kernelError: kernel.error, kernelInitMs: kernel.initMs, kernelStarted: kernel.started }));
  kernel.onReset(() => {
    // the worker's solid cache is gone: build everything again for the current source. The meshes stay on screen
    // meanwhile (clearing them made the whole model vanish from the 3D view and come back part by part)
    for (const h of meshes.keys()) lost.add(h);
    set({ buildErrors: new Map() });
    reloadImports();
    const { source } = get();
    if (source) setSource(source, { force: true });
  });
  // an imported file finished loading or was analysed: designs that place it evaluate and build again
  onImportsChanged((_list, reason) => {
    const { source, model, buildErrors } = get();
    if (!source || !(/\bstep\s*\(/.test(source) || (model && modelUsesImports(model)))) return;
    // a plain load is already awaited by the pipeline; only a failed build needs another go
    if (reason === "loaded" && !buildErrors.size) return;
    set({ buildErrors: new Map() });
    setSource(source, { force: true });
  });
  // a different machine in Settings → Making changes what the process checks allow
  useSettings.subscribe((now, before) => {
    if (now.machines === before.machines && now.machineFor === before.machineFor) return;
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
  lost.clear();
  faceCats.clear();
  faceCatsByName.clear();
  detailFailed.clear();
  kept.clear();
  keptWarnings.clear();
  kernel.evict([]);
  reportBase = null;
  ahead?.stop();
  ahead = null;
  processKept.clear();
  detailKernel.evict([]);
  set({ buildErrors: new Map(), detailIssues: new Map(), report: null, interferences: [], process: {}, conflict: null, conflictState: "idle", hold: [], checksError: "" });
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

/** The kernel's lists of built solids' faces, by geometry hash (the mate tool asks before any mate needs them). */
export async function facesFor(hashes: string[]): Promise<Map<string, FaceCatalogue>> {
  const need = [...new Set(hashes)].filter((h) => !faceCats.has(h) && meshes.has(h));
  if (need.length) {
    const cats = await kernel.faceCatalogues(need);
    for (const [h, c] of Object.entries(cats)) if (!("error" in c)) faceCats.set(h, c);
  }
  const out = new Map<string, FaceCatalogue>();
  for (const h of hashes) {
    const c = faceCats.get(h);
    if (c) out.set(h, c);
  }
  return out;
}

/** The design read again with the faces its mates need, once the kernel has listed them; null when nothing changed. */
async function withFaces(rev: number, src: string, model: Model, parsed: ReturnType<typeof parse>): Promise<Model | null> {
  const need = [...new Set(model.mateQueries ?? [])].filter((h) => !faceCats.has(h) && meshes.has(h));
  if (!need.length) return null;
  try {
    const cats = await kernel.faceCatalogues(need);
    for (const [h, c] of Object.entries(cats)) if (!("error" in c)) faceCats.set(h, c);
  } catch {
    // the mates wait for the faces, as drawn
    return null;
  }
  if (get().rev !== rev) return null;
  for (const p of model.parts) {
    const c = faceCats.get(p.hash);
    if (c) faceCatsByName.set(p.name, c);
  }
  // keep the lists of what this design is made of, once there are many
  if (faceCats.size > 600) {
    const keep = new Set(model.parts.map((p) => p.hash));
    for (const h of faceCats.keys()) if (!keep.has(h)) faceCats.delete(h);
  }
  const next = evaluate(src, { parsed });
  set({ model: next });
  return next;
}

function uniqueParts(model: Model): Map<string, EvalPart> {
  const byHash = new Map<string, EvalPart>();
  for (const p of model.parts) if (!byHash.has(p.hash)) byHash.set(p.hash, p);
  return byHash;
}

/**
 * Read the refined meshes kept from earlier sessions for parts that have none yet. A part takes them once its fast
 * build is in (see adopt): the main kernel still needs its solid for the checks, but not the refine.
 */
async function restoreKept(byHash: Map<string, EvalPart>): Promise<void> {
  for (const h of [...kept.keys()]) if (!byHash.has(h)) kept.delete(h);
  const wanted: { hash: string; quality: KeptQuality }[] = [];
  for (const p of byHash.values()) {
    if (kept.has(p.hash) || detailFailed.has(p.hash)) continue;
    const e = meshes.get(p.hash);
    if (!e?.final) wanted.push({ hash: p.hash, quality: "final" });
    if (!e?.display && hasDetail(p.recipe) && hasThreads(p.recipe)) wanted.push({ hash: p.hash, quality: "display" });
  }
  const found = await keptMeshes(wanted);
  for (const w of wanted) {
    const k = found.get(keptKey(w.hash, w.quality));
    if (!k) continue;
    foreignIds.add(k.mesh);
    kept.set(w.hash, { ...kept.get(w.hash), [w.quality]: k });
    if (meshes.get(w.hash)?.preview) adopt(w.hash);
  }
}

/** kept detailed builds' warnings, for the report, until the next refine pass takes them */
const keptWarnings = new Map<string, string[]>();

/** A part whose fast build is in takes the refined meshes kept for it. */
function adopt(hash: string) {
  const k = kept.get(hash);
  const e = meshes.get(hash);
  if (!k || !e?.preview) return;
  kept.delete(hash);
  if (k.display && !e.display) e.display = k.display.mesh;
  if (k.final && !e.final) {
    e.final = k.final.mesh;
    keptWarnings.set(hash, k.final.warnings ?? []);
  }
  bumpMeshes();
}

/** How a refine pass went: `after` finishes it once the checks are done; `issues` are the detail pass's warnings. */
interface Refined {
  cancelled: boolean;
  after: () => Promise<boolean>;
  issues: (live: Map<string, EvalPart>) => Map<string, string>;
}

/**
 * The finished look of each part and its detailed geometry: exact-tolerance meshes, display meshes for parts with
 * threads (the threads drawn on plain cylinders, which the 3D view shows) and the detailed builds (real threads,
 * knurls, cosmetic steps) for close-ups, photoreal and export. All of it goes to the detail worker as soon as the fast
 * build is done, so it runs alongside the checks in the main worker and a slow detail build never holds up the next
 * edit's preview and checks. If the detail worker is unavailable, the main worker makes the meshes after the checks.
 * Null when every part is refined already.
 */
async function refine(rev: number, byHash: Map<string, EvalPart>, restoring: Promise<void>): Promise<Refined | null> {
  // meshes kept from an earlier session go first: what they cover is not built again
  await restoring;
  if (get().rev !== rev) return null;
  for (const h of byHash.keys()) adopt(h);
  const issues = new Map(get().detailIssues);
  const result = (cancelled: boolean, after: () => Promise<boolean>): Refined => ({
    cancelled,
    after,
    issues: (live) => {
      for (const h of [...issues.keys()]) if (!live.has(h)) issues.delete(h);
      return issues;
    },
  });
  let restored = false;
  for (const h of byHash.keys()) {
    const w = keptWarnings.get(h);
    if (!w) continue;
    keptWarnings.delete(h);
    if (w.length) issues.set(h, w.join(" "));
    else issues.delete(h);
    restored = true;
  }
  const shown = [...byHash.values()].filter((p) => meshes.get(p.hash)?.preview);
  const todo = shown.filter((p) => !meshes.get(p.hash)?.final && !detailFailed.has(p.hash));
  const needDisplay = shown.filter((p) => !meshes.get(p.hash)?.display && hasDetail(p.recipe) && hasThreads(p.recipe));
  if (!todo.length && !needDisplay.length) return restored ? result(false, async () => true) : null;
  const onPart = (r: PartResult) => {
    const prev = meshes.get(r.hash);
    if (prev) {
      if (r.quality === "display") prev.display = r.mesh;
      else prev.final = r.mesh;
      bumpMeshes();
    }
    if (r.quality === "display" || r.quality === "final") keepMesh(r.hash, r.quality, { mesh: r.mesh, volume: r.volume, bbox: r.bbox, warnings: r.warnings });
    if (r.quality === "display") return;
    if (r.warnings?.length) issues.set(r.hash, r.warnings.join(" "));
    else issues.delete(r.hash);
  };
  const onError = (hash: string, message: string) => {
    // the simple shape stays on screen; say what the detail pass could not do
    detailFailed.add(hash);
    issues.set(hash, `The detailed build failed, so the simple shape is shown: ${message}`);
    // keep it even if this run is cut short: a detail worker that stalls is replaced, which cancels the run
    set({ detailIssues: new Map(get().detailIssues).set(hash, issues.get(hash)!) });
    refreshReport();
  };
  // a display mesh that can't be made leaves the part as it is: its detailed build comes next and says why
  const onDisplayError = () => undefined;
  const item = (p: EvalPart) => ({ hash: p.hash, recipe: p.recipe, label: p.label });
  const detailed = todo.filter((p) => hasDetail(p.recipe));
  const plain = todo.filter((p) => !hasDetail(p.recipe));
  const run = (job: ReturnType<typeof kernel.build>) => {
    activeJobs.push(job);
    return job.done;
  };
  // the main worker, after the checks: the meshes only, as the detailed builds need the detail worker
  const inMain = async () => {
    const missing = (q: "display" | "final") => (p: EvalPart) => !meshes.get(p.hash)?.[q];
    for (const p of detailed.filter(missing("final"))) issues.set(p.hash, `The detailed build is unavailable, so the simple shape is shown: ${detailKernel.error}`);
    const fast = needDisplay.filter((p) => !displayBuilt(p.recipe)).filter(missing("display"));
    const rest = plain.filter(missing("final"));
    const jobs: Promise<{ cancelled: boolean }>[] = [];
    if (fast.length) jobs.push(run(kernel.build(fast.map(item), "display", onPart, onDisplayError)));
    if (rest.length) jobs.push(run(kernel.build(rest.map(item), "final", onPart, onError)));
    const results = await Promise.all(jobs);
    return !results.some((r) => r.cancelled) && get().rev === rev;
  };
  if (detailKernel.status === "error") return result(false, inMain);
  detailKernel.start();
  // the detail worker needs the imported STEP files the parts build on
  if ([...todo, ...needDisplay].some((p) => recipeUsesImport(p.recipe))) {
    await detailImportsLoaded();
    if (get().rev !== rev) return result(true, async () => false);
  }
  // what the view shows first (drawn threads, exact-tolerance plain parts), then the real threads
  const steps: [EvalPart[], MeshQuality, (hash: string, message: string) => void][] = [
    [needDisplay, "display", onDisplayError],
    [plain, "final", onError],
    [detailed, "final", onError],
  ];
  const fromDetail = (r: PartResult) => {
    foreignIds.add(r.mesh);
    onPart(r);
  };
  for (const [parts, quality, err] of steps) {
    if (!parts.length) continue;
    const r = await run(detailKernel.build(parts.map(item), quality, fromDetail, err));
    if (get().rev !== rev) return result(true, async () => false);
    // the detail worker failed to start or gave up: the main worker makes the meshes after the checks
    if (r.cancelled) return (detailKernel.status as KernelStatus) === "error" ? result(false, inMain) : result(true, async () => false);
  }
  return result(false, async () => true);
}

// ---------- manufacturing-process checks, alongside the build ----------

/** Process results by geometry and rules: a part is checked once however often the design is read. */
const processKept = new Map<string, ProcessResult>();
const PROCESS_KEPT = 4000;
const probeKey = (p: ProcessProbe) => `${p.hash}|${stableStringify(p.rules)}`;

function keepProcess(key: string, r: ProcessResult) {
  // (a failure is asked about again next time)
  if (r.error) return;
  processKept.delete(key);
  processKept.set(key, r);
  if (processKept.size > PROCESS_KEPT) processKept.delete(processKept.keys().next().value as string);
}

/** the process checks asked ahead for the design being built */
let ahead: { stop: () => void; done: Promise<void>; over: boolean } | null = null;
/** Up to this many process checks still to come are asked of the kernel along with its checks (see runPipeline). */
const EARLY_PROBES = 6;

/**
 * Start a design's manufacturing-process checks in the detail worker, which has nothing to do until the parts are
 * built: it builds each part they are of and checks it while the kernel builds and checks the design, instead of
 * in line after the kernel's checks (where they were half the wait on a large assembly). What it gets through is
 * kept by geometry and rules; the pipeline asks the kernel for whatever is still missing when it gets there.
 */
function processAhead(model: Model, byHash: Map<string, EvalPart>, machines: MachineContext) {
  ahead?.stop();
  ahead = null;
  if (detailKernel.status === "error") return;
  const errors = get().buildErrors;
  // (an imported body's file may not be in the detail worker yet: those are left to the kernel)
  const hashes = new Set([...byHash.values()].filter((p) => !errors.has(p.hash) && !recipeUsesImport(p.recipe)).map((p) => p.hash));
  const groups = new Map<string, Map<string, ProcessProbe>>();
  for (const probe of processProbes(model, hashes, machines)) {
    const key = probeKey(probe);
    if (processKept.has(key)) continue;
    const g = groups.get(probe.hash);
    if (g) g.set(key, probe);
    else groups.set(probe.hash, new Map([[key, probe]]));
  }
  if (!groups.size) return;
  detailKernel.start();
  // one request a part, all asked now: the worker takes them in turn, ahead of the detailed builds asked for later
  const asked = [...groups].map(([hash, byKey]) => {
    const part = byHash.get(hash)!;
    const keys = [...byKey.keys()];
    const job = detailKernel.processParts([...byKey.values()], [{ hash, recipe: part.recipe, label: part.label }]);
    return {
      cancel: job.cancel,
      done: job.promise.then(
        (results) => results.forEach((r, i) => keepProcess(keys[i], r)),
        () => undefined,
      ),
    };
  });
  const mine = {
    stop: () => {
      for (const a of asked) a.cancel();
    },
    over: false,
    done: Promise.all(asked.map((a) => a.done)).then(() => {
      mine.over = true;
    }),
  };
  ahead = mine;
}

async function runPipeline(rev: number, src: string, model: Model, parsed: ReturnType<typeof parse>) {
  for (const j of activeJobs) j.cancel();
  activeJobs = [];
  // refined meshes kept from earlier sessions are read while the kernel starts and the fast builds run
  const restoring = restoreKept(uniqueParts(model)).catch(() => undefined);
  try {
    await kernel.ready();
  } catch {
    if (get().rev === rev) set({ stage: "done" });
    return;
  }
  if (get().rev !== rev) return;
  // imported bodies need their file in the kernel before anything that uses them is built
  if (modelUsesImports(model)) {
    await importsLoaded();
    if (get().rev !== rev) return;
  }

  const byHash = uniqueParts(model);
  const errors = get().buildErrors;
  const todo = [...byHash.values()].filter((p) => (lost.has(p.hash) || !meshes.get(p.hash)?.preview) && !errors.has(p.hash));
  const total = byHash.size;
  let done = total - todo.length;
  const reused = done;
  set({ stage: todo.length ? "building" : "checking", progress: { done, total } });
  // the manufacturing-process checks start now, in the detail worker
  const machines = userMachines();
  processAhead(model, byHash, machines);

  const tBuild = performance.now();
  if (todo.length) {
    const job = kernel.build(
      todo.map((p) => ({ hash: p.hash, recipe: p.recipe, label: p.label })),
      "preview",
      (r: PartResult) => {
        const prev = meshes.get(r.hash);
        const rebuilt = lost.delete(r.hash) && !!prev;
        // a part built again after a kernel restart is the shape already shown: keep its mesh objects, so the
        // 3D view and anything holding them sees no change
        if (!rebuilt) {
          meshes.set(r.hash, { ...prev, preview: r.mesh, volume: r.volume, bbox: r.bbox, rev: prev?.rev ?? rev });
          // the finished look kept from an earlier session, if there is one
          adopt(r.hash);
        }
        done++;
        if (get().rev === rev) set({ progress: { done, total } });
        if (!rebuilt) bumpMeshes();
      },
      (hash, message) => {
        // a part the new worker can't build again is not on screen as if it were fine
        if (lost.delete(hash) && meshes.delete(hash)) bumpMeshes();
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

  // a split part is built whole first: its cuts and pins come from that solid, then the design is read again and the
  // pieces are built
  if (splits.resolve(model, meshOf)) {
    const next = evaluate(src, { parsed });
    if (get().rev !== rev) return;
    set({ model: next });
    return runPipeline(rev, src, next, parsed);
  }

  // the meshes the view shows when it settles, and the detailed geometry, start now in the detail worker: they run
  // alongside the checks rather than after them
  const refining = refine(rev, byHash, restoring).catch(() => null);

  // mates pick from the built solids' faces: have the kernel list any not listed yet, then read the design again
  const mated = await withFaces(rev, src, model, parsed);
  if (get().rev !== rev) return;
  if (mated) model = mated;

  // the fit check builds the design thousands of times in simulation: it works on that between frames from here on,
  // while the kernel checks the geometry
  const fitted = prepareFits(model, () => get().rev === rev);
  // and how the design holds together (hundreds of screws to measure on a large assembly), which the report reads
  const held = prepareHolds(model, meshOf, () => get().rev === rev);

  // checks need every solid in the worker's cache
  set({ stage: "checking", timings: { ...get().timings, buildMs, built: todo.length, reused } });
  const builtHashes = new Set([...byHash.keys()].filter((h) => meshes.has(h)));
  const tChecks = performance.now();
  let result: ChecksResult | null = null;
  let checksError = "";
  const checking = kernel.checks(buildChecksRequest(model, builtHashes));
  // manufacturing-process checks: asked ahead of the build in the detail worker (processAhead), and kept by
  // geometry and rules from earlier reads of the design
  const process: Record<string, ProcessResult> = {};
  const probes = processProbes(model, builtHashes, machines);
  const keys = probes.map(probeKey);
  const missing = () => {
    const out = new Map<string, ProcessProbe>();
    probes.forEach((p, i) => {
      if (!processKept.has(keys[i])) out.set(keys[i], p);
    });
    return out;
  };
  // what the kernel answers, failures too
  const direct = new Map<string, ProcessResult>();
  const askKernel = (need: Map<string, ProcessProbe>) => {
    const order = [...need.keys()];
    return kernel.process([...need.values()]).then(
      (results) =>
        results.forEach((r, i) => {
          direct.set(order[i], r);
          keepProcess(order[i], r);
        }),
      (e) => {
        const error = e instanceof Error ? e.message : String(e);
        for (const k of order) direct.set(k, { key: "", findings: [], stats: { triangles: 0, samples: 0 }, ms: 0, error });
      },
    );
  };
  // a few parts' worth still to come (a small design, a small edit): the kernel, which has every part built, is
  // asked for them now, behind the checks, so its answer comes back with theirs instead of a trip later
  const early = missing();
  let fromKernel = early.size && early.size <= EARLY_PROBES ? askKernel(early) : null;
  try {
    result = await checking;
  } catch (e) {
    checksError = e instanceof Error ? e.message : String(e);
  }
  if (get().rev !== rev) return;
  const tKernel = performance.now();
  lastKernel = result;
  if (probes.length) {
    if (missing().size) {
      // not all in yet (or there is no detail worker): the kernel takes what is left as well, and whichever answers
      // first is used
      fromKernel ??= askKernel(missing());
      const racing = ahead && !ahead.over ? ahead : null;
      if (racing) await Promise.race([fromKernel, racing.done]);
      if (!racing || missing().size) await fromKernel;
      racing?.stop();
    }
    probes.forEach((p, i) => (process[p.id] = processKept.get(keys[i]) ?? direct.get(keys[i]) ?? { key: "", findings: [], stats: { triangles: 0, samples: 0 }, ms: 0, error: "The part has not been built" }));
    if (get().rev !== rev) return;
  }
  const tProcess = performance.now();
  await fitted;
  const tFits = performance.now();
  await held;
  const tHolds = performance.now();
  if (get().rev !== rev) return;
  // The report is put together in three steps (its core, the passes over it, showing it). On a large assembly each
  // takes a few tens of milliseconds, and in one go they were the stop felt when the checks came in: the page gets
  // to draw and answer between them. On a small design they take no time, and follow each other with no pause.
  const pace = pacer();
  const geoModel = pace.step(() => (result && model.geoQueries.length ? evaluate(src, { parsed, geo: result.geo }) : null));
  const base = pace.step(() => during("checks: the core report", () => assembleReport(model, { geoModel, kernel: result, buildErrors: get().buildErrors, geom: (h) => meshes.get(h), mesh: meshOf, sweepLater: true })));
  await pace.pause();
  if (get().rev !== rev) return;
  const ctx: ReportContext = { model, live: true, rev, buildErrors: get().buildErrors, process, machines, src, refresh: () => setTimeout(refreshReport, 0) };
  reportBase = { report: base, ctx };
  const report = pace.step(() => composeReport(base, ctx));
  await pace.pause();
  if (get().rev !== rev) return;
  set({
    report,
    reportRev: rev,
    checksError,
    // a sprung blade pressing on its mate by its preload is drawn into it on purpose: not shown as a clash
    interferences: (result?.interferences ?? []).filter((i) => base.items.find((x) => x.id === `int:${i.a}|${i.b}`)?.status !== "pass"),
    process,
    stage: "refining",
    timings: {
      ...get().timings,
      checksMs: performance.now() - tChecks,
      checkSteps: { kernel: tKernel - tChecks, process: tProcess - tKernel, fits: tFits - tProcess, holds: tHolds - tFits, report: performance.now() - tHolds },
    },
  });

  // refine: whatever the detail worker could not do (it is unavailable), here after the checks, then the detail
  // pass's warnings into the report
  const refined = await refining;
  if (get().rev !== rev) return;
  if (refined) {
    const ok = refined.cancelled ? false : await refined.after();
    if (!ok || get().rev !== rev) return;
    set({ detailIssues: refined.issues(byHash) });
    refreshReport();
  }
  set({ stage: "done" });
}

/**
 * Problems of the detailed (full-quality) build as warnings, for parts whose
 * geometry has not changed since. A report pass, so it survives re-composing.
 */
export function detailItems(items: CheckItem[], model: Model, issues: Map<string, string>): CheckItem[] {
  const out = items.filter((i) => !i.id.startsWith("detail:"));
  const seen = new Set<string>();
  for (const p of model.parts) {
    const msg = issues.get(p.hash);
    if (!msg || seen.has(p.hash)) continue;
    seen.add(p.hash);
    const same = model.parts.filter((q) => q.hash === p.hash).map((q) => q.id);
    out.push({ id: `detail:${p.id}`, category: "build", status: "warn", title: `${p.label} detail`, detail: msg, parts: same, span: p.span, basis: "geometry" });
  }
  return out;
}
// isolated builds (sub-agents) have no detail pass of their own
registerReportPass("detail", (items, ctx) => (ctx.live ? detailItems(items, ctx.model, get().detailIssues) : items), 30);

/** Compose the latest report again, after a pass's inputs changed (an analysis finished, for example). */
export function refreshReport() {
  if (!reportBase || reportBase.ctx.rev !== get().reportRev) return;
  const next = composeReport(reportBase.report, reportBase.ctx);
  const now = get().report;
  // many things ask for this and most of the time nothing has changed: the report that says the same is kept as
  // it is, so nothing that shows it has to be drawn again
  set({ report: now && sameData(now, next) ? now : next });
}

/** True when two pieces of plain data (a report: numbers, text, lists and records of them) say the same. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const y = b as unknown[];
    if (a.length !== y.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let n = 0;
  for (const k in x) {
    if (x[k] === undefined) continue;
    if (!sameData(x[k], y[k])) return false;
    n++;
  }
  for (const k in y) if (y[k] !== undefined) n--;
  return n === 0;
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
      const { table, open } = evalDesigns();
      this.w!.postMessage({ id, src, hold, imports: evalImports(), designs: designsUsed(table, src), open } satisfies SolveRequest);
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
