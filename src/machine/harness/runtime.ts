// Keeps the 3D wiring up to date: builds the harness from the current model,
// and routes its cables in a worker around the parts' meshes whenever the
// wiring or the geometry it runs past changes. The newest request wins.

import { create } from "zustand";
import { meshes } from "../../core/engine";
import type { Model } from "../../core/model";
import { xformMatrix } from "../../kernel/recipe";
import { buildHarness, leadLength, routeRequests, type Harness } from "./harness";
import type { RouteGeometry, RoutePlaced, RoutedWire } from "./route";
import type { HarnessRouteRequest, HarnessRouteResponse } from "./cables.worker";

interface HarnessState {
  harness: Harness | null;
  /** routed cables by wire id, for the harness above (null while the first route runs) */
  routes: Map<string, RoutedWire> | null;
  status: "idle" | "routing" | "done" | "error";
  error: string;
  /** the inputs the routes were made for */
  key: string;
}

export const useHarness = create<HarnessState>(() => ({ harness: null, routes: null, status: "idle", error: "", key: "" }));

let worker: Worker | null = null;
let nextId = 1;
let pendingId = 0;
let lastModel: Model | null = null;

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./cables.worker.ts", import.meta.url), { type: "module", name: "kerf-cables" });
  w.onmessage = (ev: MessageEvent<HarnessRouteResponse>) => {
    const msg = ev.data;
    if (msg.id !== pendingId) return;
    if (msg.ok) useHarness.setState({ routes: new Map(msg.result.wires.map((r) => [r.id, r])), status: "done", error: "" });
    else useHarness.setState({ status: "error", error: msg.error });
  };
  w.onerror = (e) => {
    worker?.terminate();
    worker = null;
    useHarness.setState({ status: "error", error: e.message || "The cable router stopped." });
  };
  worker = w;
  return w;
}

/**
 * Bring the harness up to date with a model whose meshes are built. Cheap
 * when nothing changed: the route request is keyed by the wire ends and by
 * every solid's geometry and placement.
 */
export function updateHarness(model: Model) {
  if (model === lastModel && useHarness.getState().harness) return;
  lastModel = model;
  const harness = buildHarness(model);
  if (!harness.wires.length) {
    useHarness.setState({ harness, routes: new Map(), status: "done", key: "" });
    return;
  }
  const solids = model.parts.filter((p) => !p.hidden && (meshes.get(p.hash)?.preview ?? meshes.get(p.hash)?.final));
  const wires = routeRequests(harness);
  const key = hash(JSON.stringify(wires.map((w) => [w.id, w.a.p, w.b.p])) + solids.map((p) => `${p.id}:${p.hash}:${JSON.stringify(p.xf)}`).join("|"));
  const st = useHarness.getState();
  if (key === st.key) {
    // same routes: keep them, with the harness of this model (labels or colours may differ)
    useHarness.setState({ harness });
    return;
  }
  // keep showing the old routes for cables that still exist until the new ones arrive
  useHarness.setState({ harness, key, status: "routing" });
  if (typeof Worker === "undefined") return;
  const geoIndex = new Map<string, number>();
  const geos: RouteGeometry[] = [];
  const placed: RoutePlaced[] = [];
  for (const p of solids) {
    let g = geoIndex.get(p.hash);
    if (g === undefined) {
      const e = meshes.get(p.hash)!;
      const m = (e.preview ?? e.final)!;
      g = geos.length;
      geos.push({ positions: m.positions.slice(), indices: m.indices.slice() });
      geoIndex.set(p.hash, g);
    }
    placed.push({ geo: g, m: xformMatrix(p.xf), box: p.kind === "component" ? meshes.get(p.hash)!.bbox : undefined });
  }
  pendingId = nextId++;
  const req: HarnessRouteRequest = { id: pendingId, input: { geos, placed, wires } };
  ensureWorker().postMessage(
    req,
    geos.flatMap((g) => [g.positions.buffer, g.indices.buffer]),
  );
}

/**
 * Each wire's run along its routed cable, plug to plug, by wire id: for the wire
 * list's cut lengths. Only when the routes are finished and were made for this model.
 */
export function routedRuns(model: Model | null | undefined): Map<string, number> | undefined {
  const st = useHarness.getState();
  if (!model || model !== lastModel || st.status !== "done" || !st.harness || !st.routes?.size) return undefined;
  const out = new Map<string, number>();
  for (const w of st.harness.wires) {
    const r = st.routes.get(w.id);
    if (r && !r.straight) out.set(w.id, r.length + 2 * leadLength(w));
  }
  return out;
}

/** Route the model's cables now and wait for them (for an export), giving up after `ms`. */
export function routeNow(model: Model, ms = 8000): Promise<Map<string, number> | undefined> {
  updateHarness(model);
  return new Promise((resolve) => {
    const done = () => {
      const st = useHarness.getState();
      return st.status === "done" || st.status === "error";
    };
    if (done()) return resolve(routedRuns(model));
    const timer = setTimeout(() => {
      off();
      resolve(routedRuns(model));
    }, ms);
    const off = useHarness.subscribe(() => {
      if (!done()) return;
      clearTimeout(timer);
      off();
      resolve(routedRuns(model));
    });
  });
}
