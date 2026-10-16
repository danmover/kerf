// Renders audio through a circuit off the main thread.

import { transient } from "./solver";
import type { Circuit, DcResult, Probe } from "./types";

export interface RenderRequest {
  id: number;
  circuit: Circuit;
  op?: DcResult;
  fs: number;
  oversample: number;
  inputs: Record<string, Float32Array>;
  probes: Probe[];
}
export type RenderResponse = { id: number; type: "progress"; frac: number } | { id: number; type: "done"; ok: boolean; out: Float32Array[]; message?: string };

self.onmessage = (ev: MessageEvent<RenderRequest>) => {
  const { id, circuit, op, fs, oversample, inputs, probes } = ev.data;
  const samples = Math.max(0, ...Object.values(inputs).map((w) => w.length));
  const post = (m: RenderResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    const r = transient(circuit, { fs, samples, inputs, probes, op, oversample, onProgress: (frac) => post({ id, type: "progress", frac }) });
    post({ id, type: "done", ok: r.ok, out: r.out, message: r.message }, r.out.map((a) => a.buffer));
  } catch (e) {
    post({ id, type: "done", ok: false, out: [], message: e instanceof Error ? e.message : String(e) });
  }
};
