/// <reference lib="webworker" />
// Runs flow and cooling analyses off the UI thread: plain arithmetic on a grid of cells. No eval, no WebAssembly,
// no network.

import { FlowSetupError, solveFlow } from "./flow/solve";
import type { FlowRequest, FlowResponse } from "./flow/protocol";
import type { FlowResult } from "./flow/types";

const post = (msg: FlowResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

/** Every typed array in a result, once each. */
function buffers(r: FlowResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView | null | undefined) => {
    if (a) out.add(a.buffer as ArrayBuffer);
  };
  for (const s of r.surfaces) [s.positions, s.indices, s.temp].forEach(add);
  [r.lines.points, r.lines.speed, r.lines.temp, r.lines.starts].forEach(add);
  if (r.field) [r.field.data, r.field.kind].forEach(add);
  return [...out];
}

self.onmessage = (ev: MessageEvent<FlowRequest>) => {
  const { id, input } = ev.data;
  let last = 0;
  try {
    const result = solveFlow(input, (progress) => {
      const t = performance.now();
      if (t - last < 150) return;
      last = t;
      post({ id, type: "progress", progress });
    });
    post({ id, type: "done", result }, buffers(result));
  } catch (e) {
    post({ id, type: "error", message: e instanceof Error ? e.message : String(e), setup: e instanceof FlowSetupError });
  }
};
