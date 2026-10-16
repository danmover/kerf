// Audio through the design's circuit: one render at a time in a worker (a
// newer request replaces a running one), or inline where there are no
// workers (tests).

import { transient } from "./solver";
import type { Circuit, DcResult, Probe } from "./types";
import type { RenderRequest, RenderResponse } from "./render.worker";

export interface RenderJob {
  circuit: Circuit;
  op?: DcResult;
  fs: number;
  oversample: number;
  inputs: Record<string, Float32Array>;
  probes: Probe[];
  onProgress?: (frac: number) => void;
}

export interface RenderOut {
  ok: boolean;
  out: Float32Array[];
  message?: string;
  cancelled?: boolean;
}

let worker: Worker | null = null;
let nextId = 1;
let pending: { id: number; resolve: (r: RenderOut) => void; onProgress?: (f: number) => void } | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module", name: "kerf-sound" });
  w.onmessage = (ev: MessageEvent<RenderResponse>) => {
    const m = ev.data;
    if (!pending || m.id !== pending.id) return;
    if (m.type === "progress") return pending.onProgress?.(m.frac);
    const p = pending;
    pending = null;
    p.resolve({ ok: m.ok, out: m.out, message: m.message });
  };
  w.onerror = (e) => {
    const p = pending;
    pending = null;
    worker?.terminate();
    worker = null;
    p?.resolve({ ok: false, out: [], message: e.message || "The simulation stopped." });
  };
  worker = w;
  return w;
}

/** Stop whatever is rendering; its promise resolves as cancelled. */
export function cancelRender() {
  if (!pending) return;
  const p = pending;
  pending = null;
  worker?.terminate();
  worker = null;
  p.resolve({ ok: false, out: [], cancelled: true });
}

export function renderCircuit(job: RenderJob): Promise<RenderOut> {
  if (typeof Worker === "undefined") {
    const samples = Math.max(0, ...Object.values(job.inputs).map((w) => w.length));
    const r = transient(job.circuit, { fs: job.fs, samples, inputs: job.inputs, probes: job.probes, op: job.op, oversample: job.oversample, onProgress: job.onProgress });
    return Promise.resolve({ ok: r.ok, out: r.out, message: r.message });
  }
  cancelRender();
  return new Promise((resolve) => {
    const id = nextId++;
    pending = { id, resolve, onProgress: job.onProgress };
    const req: RenderRequest = { id, circuit: job.circuit, op: job.op, fs: job.fs, oversample: job.oversample, inputs: job.inputs, probes: job.probes };
    ensureWorker().postMessage(req);
  });
}
