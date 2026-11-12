// UI-side handle on the geometry kernel worker: job ids, promises, and
// recovery when the worker dies (for example after OpenCASCADE runs out of memory).

import type { MeshData } from "./build";
import type { BuildItem, ChecksRequest, ChecksResult, ExportItem, FromWorker, InspectRequest, InspectResult, ToWorker } from "./protocol";
import type { PartInspection } from "./inspect";
import type { FaceCatalogue } from "../core/mates";
import type { V3, Xform } from "./recipe";
import type { ProcessProbe, ProcessResult } from "../mfg/types";
import type { PickMeasure, PickRef, ViewRequest, ViewResult } from "./drawing";
import type { ImportMeta } from "./imports";
import type { MeasureResult } from "./core";

export type KernelStatus = "loading" | "ready" | "error";

export interface PartResult {
  hash: string;
  quality: "preview" | "final";
  mesh: MeshData;
  volume: number;
  bbox: [V3, V3];
  ms: number;
  /** cosmetic detail that could not be built */
  warnings?: string[];
}

/**
 * How long the worker may go without finishing anything before it is replaced: one part's build, or one check run,
 * inspection, projection, measurement, import or export. OpenCASCADE cannot be interrupted, and the worker runs one
 * job at a time, so a build that takes minutes would otherwise hold up every preview and check after it.
 */
export const STALL_MS = {
  preview: 60_000,
  final: 180_000,
  checks: 120_000,
  inspect: 60_000,
  /** detail review of every part at once */
  review: 120_000,
  export: 180_000,
  process: 120_000,
  project: 120_000,
  measure: 60_000,
  import: 180_000,
} as const;

type ValueKind = Exclude<keyof typeof STALL_MS, "preview" | "final">;

interface BuildJob {
  kind: "build";
  quality: "preview" | "final";
  /** parts the worker has not reported yet, in the order it builds them */
  pending: string[];
  limit: number;
  onPart: (p: PartResult) => void;
  onError: (hash: string, message: string) => void;
  resolve: (r: { ms: number; built: number; cached: number; cancelled: boolean }) => void;
  cancelled: boolean;
}
interface ValueJob<T> {
  kind: "value";
  /** identifies the request, so one that stalled the worker is refused when it comes again */
  key: string;
  limit: number;
  /** the error when it runs too long */
  tooLong: (secs: number) => string;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

/** A short fingerprint of a request (FNV-1a). */
function fingerprint(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

const buildKey = (quality: "preview" | "final", hash: string) => `${quality}:${hash}`;

export class KernelCrashed extends Error {
  constructor() {
    super("The geometry kernel stopped unexpectedly and was restarted.");
  }
}

export class KernelClient {
  private worker: Worker | null = null;
  private jobs = new Map<number, BuildJob | ValueJob<unknown>>();
  private nextId = 1;
  private listeners = new Set<() => void>();
  private resetListeners = new Set<() => void>();
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timedJob = 0;
  /** the job the worker said it started; jobs can run out of order (drawing projections wait behind urgent work) */
  private running = 0;
  /** builds and requests that stalled or crashed the worker: refused at once instead of tying it up again */
  private poisoned = new Map<string, string>();
  /** ones that crashed it once (perhaps memory ran out): a second crash poisons them */
  private trapped = new Set<string>();
  private trapStreak = 0;
  status: KernelStatus = "loading";
  initMs = 0;
  error = "";
  restarts = 0;

  /** spawn: a stand-in worker for tests */
  constructor(
    private readonly name = "kerf-kernel",
    private readonly spawn?: () => Worker,
  ) {}

  start() {
    if (this.worker) return;
    this.status = "loading";
    this.error = "";
    this.emit();
    const w = this.spawn ? this.spawn() : new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: this.name });
    w.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    w.onerror = (ev) => {
      ev.preventDefault();
      this.crash(ev.message || "worker error");
    };
    this.worker = w;
    this.post({ type: "init" });
  }

  /** Terminate and start a fresh worker. Everything cached in the old one is gone. */
  restart() {
    this.disarm();
    this.worker?.terminate();
    this.worker = null;
    this.running = 0;
    this.failAll(new KernelCrashed());
    this.start();
    for (const l of this.resetListeners) l();
  }

  /** Terminate the worker for good (extra workers that are no longer needed). */
  dispose() {
    this.disarm();
    this.worker?.terminate();
    this.worker = null;
    this.status = "error";
    this.error = "The geometry worker was closed.";
    this.failAll(new Error(this.error));
    this.listeners.clear();
    this.resetListeners.clear();
  }

  private crash(message: string) {
    this.restarts++;
    if (this.restarts > 3) {
      this.disarm();
      this.worker?.terminate();
      this.worker = null;
      this.status = "error";
      this.error = `The geometry kernel keeps failing (${message}). Reload the page to try again.`;
      this.failAll(new Error(this.error));
      this.emit();
      return;
    }
    this.restart();
  }

  private failAll(e: Error) {
    for (const [, job] of this.jobs) {
      if (job.kind === "build") job.resolve({ ms: 0, built: 0, cached: 0, cancelled: true });
      else job.reject(e);
    }
    this.jobs.clear();
    if (this.status === "error") for (const w of this.readyWaiters.splice(0)) w.reject(e);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onReset(fn: () => void) {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  ready(): Promise<void> {
    if (this.status === "ready") return Promise.resolve();
    if (this.status === "error") return Promise.reject(new Error(this.error));
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(m, transfer);
  }

  /** Whether a part's build stalled or crashed the worker (it is refused from now on). */
  isPoisoned(hash: string, quality: "preview" | "final") {
    return this.poisoned.has(buildKey(quality, hash));
  }

  /** The job the worker is running now: the one it said it started, else the oldest. */
  private head(): [number, BuildJob | ValueJob<unknown>] | undefined {
    const now = this.running ? this.jobs.get(this.running) : undefined;
    if (now) return [this.running, now];
    const it = this.jobs.entries().next();
    return it.done ? undefined : it.value;
  }

  /** Time the running job; progress (a part done) or a new head job restarts the clock. */
  private arm(progress = false) {
    const head = this.head();
    if (!head || this.status !== "ready") return this.disarm();
    if (!progress && this.timer && this.timedJob === head[0]) return;
    this.disarm();
    this.timedJob = head[0];
    this.timer = setTimeout(() => this.stalled(), head[1].limit);
  }

  private disarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The running job made no progress in time: report it, refuse it from now on, and replace the worker. */
  private stalled() {
    this.timer = null;
    const head = this.head();
    if (!head) return;
    const [id, job] = head;
    const secs = Math.round(job.limit / 1000);
    if (job.kind === "build") {
      const hash = job.pending[0];
      if (hash) {
        const msg = `The kernel stopped building it after ${secs} s. Simplify the slow step (a very long thread or helix, fillets on hundreds of edges, a sweep of a detailed profile) and it will build again.`;
        this.poisoned.set(buildKey(job.quality, hash), msg);
        if (!job.cancelled) job.onError(hash, msg);
      }
    } else {
      const msg = job.tooLong(secs);
      this.poisoned.set(job.key, msg);
      this.jobs.delete(id);
      job.reject(new Error(msg));
    }
    // not a crash: the worker is healthy, it was just busy for too long
    this.restart();
  }

  /** OpenCASCADE trapped (out of memory, an abort): its state is unknown, so replace the worker. */
  private onTrap(m: Extract<FromWorker, { type: "fatal" }>) {
    const job = this.jobs.get(m.jobId);
    const msg = `OpenCASCADE crashed (${m.message}).`;
    if (job) {
      const key = job.kind === "build" ? (m.hash ? buildKey(job.quality, m.hash) : "") : job.key;
      // memory can run out after many builds: try once more in a fresh worker before giving up on it
      if (key && this.trapped.has(key)) {
        this.poisoned.set(key, msg);
        if (job.kind === "build" && m.hash && !job.cancelled) job.onError(m.hash, msg);
      } else if (key) this.trapped.add(key);
      if (job.kind === "value") {
        this.jobs.delete(m.jobId);
        job.reject(new Error(msg));
      }
    }
    if (++this.trapStreak > 4) return this.crash(m.message);
    this.restart();
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case "ready":
        this.status = "ready";
        this.initMs = m.ms;
        for (const w of this.readyWaiters.splice(0)) w.resolve();
        this.emit();
        this.arm();
        return;
      case "started":
        this.running = m.jobId;
        this.arm();
        return;
      case "fatal":
        return this.onTrap(m);
      case "init-error":
        this.status = "error";
        this.error = `OpenCASCADE did not load (${m.message.trim().replace(/[.\s]+$/, "")}). Kerf needs a current browser with WebAssembly and about 300 MB of free memory.`;
        for (const w of this.readyWaiters.splice(0)) w.reject(new Error(this.error));
        this.emit();
        return;
      case "part": {
        const job = this.jobs.get(m.jobId);
        this.trapStreak = 0;
        if (job?.kind === "build") this.progressed(job, m.hash);
        if (job?.kind === "build" && !job.cancelled) job.onPart({ hash: m.hash, quality: m.quality, mesh: m.mesh, volume: m.volume, bbox: m.bbox, ms: m.ms, warnings: m.warnings });
        return;
      }
      case "part-error": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "build") this.progressed(job, m.hash);
        if (job?.kind === "build" && !job.cancelled) job.onError(m.hash, m.message);
        return;
      }
      case "built": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "build") job.resolve({ ms: m.ms, built: m.built, cached: m.cached, cancelled: job.cancelled });
        this.jobs.delete(m.jobId);
        this.arm(true);
        return;
      }
      case "checks":
      case "exported":
      case "process":
      case "projected":
      case "pick-measured":
      case "inspected":
      case "faces":
      case "part-inspected":
      case "imported":
      case "measured": {
        const job = this.jobs.get(m.jobId);
        this.trapStreak = 0;
        if (job?.kind === "value") job.resolve(m.type === "exported" ? m.data : m.type === "imported" ? m.meta : m.type === "process" ? m.results : m.result);
        this.jobs.delete(m.jobId);
        this.arm(true);
        return;
      }
      case "checks-error":
      case "export-error":
      case "process-error":
      case "job-error":
      case "inspect-part-error":
      case "import-error":
      case "measure-error": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "value") job.reject(new Error(m.message));
        this.jobs.delete(m.jobId);
        this.arm(true);
        return;
      }
    }
  }

  private progressed(job: BuildJob, hash: string) {
    const i = job.pending.indexOf(hash);
    if (i >= 0) job.pending.splice(i, 1);
    this.arm(true);
  }

  build(items: BuildItem[], quality: "preview" | "final", onPart: BuildJob["onPart"], onError: BuildJob["onError"]) {
    const jobId = this.nextId++;
    let job!: BuildJob;
    const done = new Promise<{ ms: number; built: number; cached: number; cancelled: boolean }>((resolve) => {
      job = { kind: "build", quality, pending: [], limit: STALL_MS[quality], onPart, onError, resolve, cancelled: false };
    });
    // parts that stalled or crashed the worker before fail at once (after this returns, like a worker reply)
    const refused = items.filter((it) => this.poisoned.has(buildKey(quality, it.hash)));
    const rest = refused.length ? items.filter((it) => !this.poisoned.has(buildKey(quality, it.hash))) : items;
    if (refused.length && this.status !== "error")
      queueMicrotask(() => {
        for (const it of refused) if (!job.cancelled) onError(it.hash, this.poisoned.get(buildKey(quality, it.hash))!);
      });
    if (this.status === "error") job.resolve({ ms: 0, built: 0, cached: 0, cancelled: true });
    else if (!rest.length) queueMicrotask(() => job.resolve({ ms: 0, built: 0, cached: 0, cancelled: job.cancelled }));
    else {
      job.pending = [...new Set(rest.map((it) => it.hash))];
      this.jobs.set(jobId, job);
      this.post({ type: "build", jobId, items: rest, quality });
      this.arm();
    }
    return {
      jobId,
      done,
      cancel: () => {
        job.cancelled = true;
        this.post({ type: "cancel", jobId });
      },
    };
  }

  /**
   * A request with one answer. `request` identifies it (what is fingerprinted when it stalls the worker), `make`
   * builds the message; `transfer` hands buffers to the worker.
   */
  private value<T>(kind: ValueKind, tooLong: ValueJob<T>["tooLong"], request: unknown, make: (jobId: number) => ToWorker, transfer: Transferable[] = [], onId?: (jobId: number) => void): Promise<T> {
    if (this.status === "error") return Promise.reject(new Error(this.error));
    const key = `${kind}:${fingerprint(JSON.stringify(request) ?? "")}`;
    const refused = this.poisoned.get(key);
    if (refused) return Promise.reject(new Error(refused));
    const jobId = this.nextId++;
    onId?.(jobId);
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(jobId, { kind: "value", key, limit: STALL_MS[kind], tooLong, resolve: resolve as (v: unknown) => void, reject });
      this.post(make(jobId), transfer);
      this.arm();
    });
  }

  checks(req: ChecksRequest) {
    return this.value<ChecksResult>("checks", (s) => `they ran for more than ${s} s, so Kerf stopped them`, req, (jobId) => ({ type: "checks", jobId, req }));
  }

  /** Check built parts against manufacturing processes. */
  process(probes: ProcessProbe[]) {
    return this.value<ProcessResult[]>("process", (s) => `The manufacturing checks ran for more than ${s} s, so Kerf stopped them.`, probes, (jobId) => ({ type: "process", jobId, probes }));
  }

  /** STEP of placed parts; parts given with a recipe are built (in detail) if this worker does not have them yet. */
  exportStep(items: ExportItem[]) {
    // a part whose detailed build stalled the worker goes in with its simple shape
    const safe = items.map((it) => (it.recipe && this.isPoisoned(it.hash, "final") ? { ...it, fast: true } : it));
    const request = safe.map((it) => [it.hash, it.xf, !!it.fast]);
    return this.value<ArrayBuffer>("export", (s) => `It ran for more than ${s} s, so Kerf stopped it.`, request, (jobId) => ({ type: "export-step", jobId, items: safe }));
  }

  /** Hidden-line projection of placed solids for a drawing view. Runs after any builds and checks. */
  project(req: ViewRequest) {
    let id = 0;
    const promise = this.value<ViewResult>(
      "project",
      (s) => `Projecting the view ran for more than ${s} s, so Kerf stopped it.`,
      req,
      (jobId) => ({ type: "project", jobId, req }),
      [],
      (jobId) => (id = jobId),
    );
    return {
      promise,
      cancel: () => {
        if (id) this.post({ type: "cancel", jobId: id });
      },
    };
  }

  /** Exact properties of a picked face, edge or point, or the measurement between two of them. */
  measurePick(a: PickRef, b?: PickRef) {
    return this.value<PickMeasure>("measure", (s) => `Measuring ran for more than ${s} s, so Kerf stopped it.`, { a, b }, (jobId) => ({ type: "pick-measure", jobId, req: { a, b } }));
  }

  /** Detail inspection of built parts (sharp edges, support, walls), by geometry hash, for the design review. */
  inspect(hashes: string[]) {
    return this.value<Record<string, PartInspection | { error: string }>>("review", (s) => `Inspecting the parts ran for more than ${s} s, so Kerf stopped it.`, hashes, (jobId) => ({ type: "inspect", jobId, hashes }));
  }

  /** Built parts' flat and round faces in their own coordinates, by geometry hash, for mates. */
  faceCatalogues(hashes: string[]) {
    return this.value<Record<string, FaceCatalogue | { error: string }>>("inspect", (s) => `Listing the parts' faces ran for more than ${s} s, so Kerf stopped it.`, hashes, (jobId) => ({ type: "faces", jobId, hashes }));
  }

  /** Named features, sharp edges and selection matches of one part (in its own coordinates), for inspect_part. */
  inspectPart(req: InspectRequest) {
    return this.value<InspectResult>("inspect", (s) => `Inspecting the part ran for more than ${s} s, so Kerf stopped it.`, { ...req, recipe: undefined }, (jobId) => ({ type: "inspect-part", jobId, req }));
  }

  evict(keep: string[]) {
    this.post({ type: "evict", keep });
  }

  /** Load a STEP file into the kernel. The bytes are copied, so the caller keeps its own. */
  importStep(hash: string, file: string, bytes: Uint8Array, analyse: boolean) {
    const data = bytes.slice().buffer;
    return this.value<ImportMeta>("import", (s) => `Reading the STEP file ran for more than ${s} s, so Kerf stopped it.`, { hash, file, analyse }, (jobId) => ({ type: "import-step", jobId, hash, file, data, analyse }), [data]);
  }

  dropImport(hash: string) {
    this.post({ type: "drop-import", hash });
  }

  /** Smallest gap between two groups of placed solids (the gap readout for two selected parts). */
  measure(a: { hash: string; xf: Xform[] }[], b: { hash: string; xf: Xform[] }[]) {
    return this.value<MeasureResult>("measure", (s) => `Measuring the gap ran for more than ${s} s, so Kerf stopped it.`, { a, b }, (jobId) => ({ type: "measure", jobId, a, b }));
  }
}

/** Fast builds, checks, measurements, drawing projections and previews. */
export const kernel = new KernelClient();
/** Detailed builds (real threads, knurls, cosmetic steps) and STEP export, so they never queue ahead of a preview. */
export const detailKernel = new KernelClient("kerf-detail");
