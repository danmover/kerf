/// <reference lib="webworker" />
// Runs airflow analyses off the UI thread: WebGPU compute where there is a
// GPU, plain arithmetic otherwise. No eval, no WebAssembly, no network.

import { AirflowCancelled, runAirflow } from "./aero/solve";
import type { AeroRequest, AeroResponse } from "./protocol";
import type { AirflowResult } from "./aero/types";

const post = (msg: AeroResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
const cancelled = new Set<number>();

/** Every typed array in a result, once each (the yaws share their meshes). */
function buffers(r: AirflowResult): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView | null | undefined) => {
    if (a) out.add(a.buffer as ArrayBuffer);
  };
  for (const y of r.yaws) {
    for (const s of y.surface) [s.positions, s.normals, s.indices, s.cp, s.cf].forEach(add);
    [y.streamlines.points, y.streamlines.speed, y.streamlines.starts].forEach(add);
    for (const m of [y.wake, y.vortices]) if (m) [m.positions, m.normals, m.indices, m.value].forEach(add);
    add(y.volume?.data);
  }
  return [...out];
}

self.onmessage = async (ev: MessageEvent<AeroRequest>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.id);
    return;
  }
  const { id, input } = m;
  let last = 0;
  try {
    const result = await runAirflow(input, {
      aborted: () => cancelled.has(id),
      onProgress: (progress) => {
        const t = performance.now();
        if (t - last < 100 && !progress.slice) return;
        last = t;
        post({ id, type: "progress", progress }, progress.slice ? [progress.slice.data.buffer as ArrayBuffer] : []);
      },
    });
    post({ id, type: "done", result }, buffers(result));
  } catch (e) {
    post({ id, type: "error", message: e instanceof Error ? e.message : String(e), cancelled: e instanceof AirflowCancelled });
  } finally {
    cancelled.delete(id);
  }
};
