/// <reference lib="webworker" />
// Runs structural analyses off the UI thread. Plain arithmetic only: no eval,
// no WebAssembly, no network.

import { FeaError, runStructural } from "./fe/structural";
import { runConverged } from "./fe/convergence";
import type { FeaRequest, FeaResponse } from "./protocol";

const post = (msg: FeaResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<FeaRequest>) => {
  const { id, input } = ev.data;
  let last = 0;
  try {
    const result = (input.converge ? runConverged : runStructural)(input, (stage, frac, info) => {
      const t = performance.now();
      if (t - last < 50 && frac < 1) return;
      last = t;
      post({ id, type: "progress", stage, frac, ...info });
    });
    const buffers = new Set<ArrayBuffer>();
    for (const p of result.parts) for (const a of [p.positions, p.normals, p.indices, p.disp, p.stress, p.strain, p.safety, p.temp, p.life, p.current]) if (a) buffers.add(a.buffer as ArrayBuffer);
    for (const s of result.supports) buffers.add(s.markers.buffer as ArrayBuffer);
    const v = result.interior;
    if (v) for (const a of [v.disp, v.stress, v.strain, v.util, v.temp, v.life, v.current]) if (a) buffers.add(a.buffer as ArrayBuffer);
    post({ id, type: "done", result }, [...buffers]);
  } catch (e) {
    post({ id, type: "error", message: e instanceof Error ? e.message : String(e), setup: e instanceof FeaError });
  }
};
