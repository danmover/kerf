// Routes circuit boards off the main thread.

import { routeBoard } from "./route";
import type { BoardSpec, RoutedBoard } from "./types";

export type RouteRequest = { id: number; spec: BoardSpec; maxMs?: number };
export type RouteResponse = { id: number; ok: true; board: RoutedBoard } | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<RouteRequest>) => {
  const { id, spec, maxMs } = ev.data;
  let msg: RouteResponse;
  try {
    msg = { id, ok: true, board: routeBoard(spec, { maxMs }) };
  } catch (e) {
    msg = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(msg);
};
