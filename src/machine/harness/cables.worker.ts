// Routes the wiring harness off the main thread.

import { routeCables, type RouteInput, type RouteResult } from "./route";

export type HarnessRouteRequest = { id: number; input: RouteInput };
export type HarnessRouteResponse = { id: number; ok: true; result: RouteResult } | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<HarnessRouteRequest>) => {
  const { id, input } = ev.data;
  let msg: HarnessRouteResponse;
  try {
    msg = { id, ok: true, result: routeCables(input) };
  } catch (e) {
    msg = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(msg);
};
