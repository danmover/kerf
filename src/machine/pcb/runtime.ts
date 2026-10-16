// Routes the design's circuit boards in a worker while the design sits still,
// caches each result by the board's copper hash, and adds the routing checks
// to every report. The Build tab's Board view reads the same cache.

import { create } from "zustand";
import { refreshReport } from "../../core/engine";
import type { CheckItem } from "../../core/checks";
import { registerReportPass, type ReportContext } from "../../core/reportPasses";
import { boardSpecs } from "../boards";
import { routeItems, type RouteState } from "../boardChecks";
import { boardHash, checkPlacement } from "./board";
import type { BoardSpec, RoutedBoard } from "./types";
import type { RouteRequest, RouteResponse } from "./route.worker";

interface BoardsState {
  /** routing state by copper hash */
  byHash: Map<string, RouteState>;
}

export const useBoards = create<BoardsState>(() => ({ byHash: new Map() }));
const bGet = useBoards.getState;
const bSet = useBoards.setState;

/** the last finished route of each board by name, shown while a change re-routes */
const lastRouted = new Map<string, RoutedBoard>();
const CACHE = 12;

let worker: Worker | null = null;
let nextId = 1;
let current: { id: number; hash: string; name: string } | null = null;
let queue: { hash: string; spec: BoardSpec }[] = [];

function store(hash: string, st: RouteState) {
  const next = new Map(bGet().byHash).set(hash, st);
  while (next.size > CACHE) next.delete(next.keys().next().value!);
  bSet({ byHash: next });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./route.worker.ts", import.meta.url), { type: "module", name: "kerf-router" });
  w.onmessage = (ev: MessageEvent<RouteResponse>) => {
    const msg = ev.data;
    const job = current;
    if (!job || msg.id !== job.id) return;
    current = null;
    if (msg.ok) {
      lastRouted.set(job.name, msg.board);
      store(job.hash, { status: "done", board: msg.board });
    } else store(job.hash, { status: "error", error: msg.error });
    refreshReport();
    pump();
  };
  w.onerror = (e) => {
    const job = current;
    current = null;
    worker?.terminate();
    worker = null;
    if (job) store(job.hash, { status: "error", error: e.message || "The router stopped." });
    refreshReport();
    pump();
  };
  worker = w;
  return w;
}

function pump() {
  if (current || !queue.length) return;
  const job = queue.shift()!;
  current = { id: nextId++, hash: job.hash, name: job.spec.name };
  const req: RouteRequest = { id: current.id, spec: job.spec };
  ensureWorker().postMessage(req);
}

/** The board's routing: from the cache, else queued (only the newest version of each board waits). */
export function routeFor(spec: BoardSpec): RouteState {
  const hash = boardHash(spec);
  const hit = bGet().byHash.get(hash);
  // the hash leaves out values and silkscreen text: draw them from the current spec
  if (hit) return hit.status === "done" ? { status: "done", board: { ...hit.board, spec } } : hit;
  if (typeof Worker === "undefined") return { status: "error", error: "Routing needs a browser worker." };
  queue = queue.filter((j) => j.spec.name !== spec.name);
  queue.push({ hash, spec });
  const prev = lastRouted.get(spec.name);
  const st: RouteState = { status: "routing", board: prev };
  store(hash, st);
  pump();
  return st;
}

function routePass(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  const m = ctx.model.machine;
  if (!ctx.live || !m?.boards.length) return items;
  const out = [...items];
  for (const { def, spec } of boardSpecs(m)) {
    // a board with placement problems is reported by them; routing it would only add noise
    if (!spec.parts.length || checkPlacement(spec).length) continue;
    out.push(...routeItems(m, def, spec, routeFor(spec)));
  }
  return out;
}

let started = false;

/** Hook board routing to the design engine's reports. */
export function startBoardRuntime() {
  if (started) return;
  started = true;
  registerReportPass("boards", routePass, 15);
  refreshReport();
}
