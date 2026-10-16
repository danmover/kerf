// UI-side handle on the geometry kernel worker: job ids, promises, and
// recovery when the worker dies (for example after OpenCASCADE runs out of memory).

import type { MeshData } from "./build";
import type { BuildItem, ChecksRequest, ChecksResult, FromWorker, ToWorker } from "./protocol";
import type { V3, Xform } from "./recipe";
import type { MeasureResult, PickRef, ViewRequest, ViewResult } from "./drawing";

export type KernelStatus = "loading" | "ready" | "error";

export interface PartResult {
  hash: string;
  quality: "preview" | "final";
  mesh: MeshData;
  volume: number;
  bbox: [V3, V3];
  ms: number;
}

interface BuildJob {
  kind: "build";
  onPart: (p: PartResult) => void;
  onError: (hash: string, message: string) => void;
  resolve: (r: { ms: number; built: number; cached: number; cancelled: boolean }) => void;
  cancelled: boolean;
}
interface ValueJob<T> {
  kind: "value";
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

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
  status: KernelStatus = "loading";
  initMs = 0;
  error = "";
  restarts = 0;

  start() {
    if (this.worker) return;
    this.status = "loading";
    this.error = "";
    this.emit();
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "kerf-kernel" });
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
    this.worker?.terminate();
    this.worker = null;
    this.failAll(new KernelCrashed());
    this.start();
    for (const l of this.resetListeners) l();
  }

  private crash(message: string) {
    this.restarts++;
    if (this.restarts > 3) {
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

  private post(m: ToWorker) {
    this.worker?.postMessage(m);
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case "ready":
        this.status = "ready";
        this.initMs = m.ms;
        for (const w of this.readyWaiters.splice(0)) w.resolve();
        this.emit();
        return;
      case "init-error":
        this.status = "error";
        this.error = `OpenCASCADE did not load (${m.message.trim().replace(/[.\s]+$/, "")}). Kerf needs a current browser with WebAssembly and about 300 MB of free memory.`;
        for (const w of this.readyWaiters.splice(0)) w.reject(new Error(this.error));
        this.emit();
        return;
      case "part": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "build" && !job.cancelled) job.onPart({ hash: m.hash, quality: m.quality, mesh: m.mesh, volume: m.volume, bbox: m.bbox, ms: m.ms });
        return;
      }
      case "part-error": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "build" && !job.cancelled) job.onError(m.hash, m.message);
        return;
      }
      case "built": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "build") job.resolve({ ms: m.ms, built: m.built, cached: m.cached, cancelled: job.cancelled });
        this.jobs.delete(m.jobId);
        return;
      }
      case "checks":
      case "exported":
      case "projected":
      case "measured": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "value") job.resolve(m.type === "exported" ? m.data : m.result);
        this.jobs.delete(m.jobId);
        return;
      }
      case "checks-error":
      case "export-error":
      case "job-error": {
        const job = this.jobs.get(m.jobId);
        if (job?.kind === "value") job.reject(new Error(m.message));
        this.jobs.delete(m.jobId);
        return;
      }
    }
  }

  build(items: BuildItem[], quality: "preview" | "final", onPart: BuildJob["onPart"], onError: BuildJob["onError"]) {
    const jobId = this.nextId++;
    let job!: BuildJob;
    const done = new Promise<{ ms: number; built: number; cached: number; cancelled: boolean }>((resolve) => {
      job = { kind: "build", onPart, onError, resolve, cancelled: false };
    });
    this.jobs.set(jobId, job);
    this.post({ type: "build", jobId, items, quality });
    return {
      jobId,
      done,
      cancel: () => {
        job.cancelled = true;
        this.post({ type: "cancel", jobId });
      },
    };
  }

  private value<T>(make: (jobId: number) => ToWorker): Promise<T> {
    const jobId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(jobId, { kind: "value", resolve: resolve as (v: unknown) => void, reject });
      this.post(make(jobId));
    });
  }

  checks(req: ChecksRequest) {
    return this.value<ChecksResult>((jobId) => ({ type: "checks", jobId, req }));
  }

  exportStep(items: { hash: string; xf: Xform[]; name: string; color: string }[]) {
    return this.value<ArrayBuffer>((jobId) => ({ type: "export-step", jobId, items }));
  }

  /** Hidden-line projection of placed solids for a drawing view. Runs after any builds and checks. */
  project(req: ViewRequest) {
    let id = 0;
    const promise = this.value<ViewResult>((jobId) => {
      id = jobId;
      return { type: "project", jobId, req };
    });
    return { promise, cancel: () => this.post({ type: "cancel", jobId: id }) };
  }

  /** Exact properties of a picked face, edge or point, or the measurement between two of them. */
  measure(a: PickRef, b?: PickRef) {
    return this.value<MeasureResult>((jobId) => ({ type: "measure", jobId, req: { a, b } }));
  }

  evict(keep: string[]) {
    this.post({ type: "evict", keep });
  }
}

export const kernel = new KernelClient();
