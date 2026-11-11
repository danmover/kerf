// Plans CNC toolpaths off the main thread: slicing, offsets and the cutting simulation take a second or more on a
// detailed part.

import { computeCam, type CamRequest, type CamResult } from "./compute";

export type CamWorkerRequest = { id: number; req: CamRequest };
export type CamWorkerResponse = { id: number; ok: true; result: CamResult } | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<CamWorkerRequest>) => {
  const { id, req } = ev.data;
  let msg: CamWorkerResponse;
  try {
    msg = { id, ok: true, result: computeCam(req) };
  } catch (e) {
    msg = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(msg, msg.ok ? msg.result.maps.after.map((a) => a.buffer as ArrayBuffer) : []);
};
