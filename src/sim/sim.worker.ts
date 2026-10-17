/// <reference lib="webworker" />
// Runs one variant of a scenario off the UI thread: the design's firmware on
// the virtual chip, the plant and the world. Plain arithmetic: no eval, no
// WebAssembly, no network.

import { runSpec } from "./build";
import type { SimRequest, SimResponse } from "./protocol";

const post = (msg: SimResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<SimRequest>) => {
  const { id, spec, machine, designName, variant } = ev.data;
  let last = 0;
  try {
    const result = runSpec(spec, machine, designName, {
      variants: [variant],
      onProgress: (_v, frac) => {
        const t = performance.now();
        // a few updates a second is enough for a progress bar, and keeps the UI thread free
        if (t - last < 300 && frac < 1) return;
        last = t;
        post({ id, type: "progress", frac });
      },
    });
    const buffers: ArrayBuffer[] = [];
    for (const v of result.variants) {
      buffers.push(v.frames.t.buffer as ArrayBuffer);
      for (const s of Object.values(v.frames.series)) buffers.push(s.buffer as ArrayBuffer);
      if (v.print) for (const a of [v.print.t, v.print.x, v.print.y, v.print.z, v.print.a]) buffers.push(a.buffer as ArrayBuffer);
    }
    post({ id, type: "done", result }, buffers);
  } catch (e) {
    post({ id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
