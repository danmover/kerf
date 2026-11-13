// Keeps the 3D wiring up to date: builds the harness from the current model,
// and routes its cables in a worker around the parts' meshes whenever the
// wiring or the geometry it runs past changes. The newest request wins. The
// worker then checks the routed cables and their plugs against the parts,
// and how each electronics module is held, and those checks join every live
// report. For a machine whose parts move with its axes, the worker also plans
// the moving cables' drag chains and loops (travel.ts), and their checks
// through full travel join the report too.

import { create } from "zustand";
import { meshes, refreshReport, useDesign } from "../../core/engine";
import type { CheckItem } from "../../core/checks";
import type { EvalPart, Model } from "../../core/model";
import { registerReportPass, type ReportContext } from "../../core/reportPasses";
import { xformMatrix, type V3 } from "../../kernel/recipe";
import { posable } from "../pose";
import { buildHarness, leadLength, routeRequests, type Harness } from "./harness";
import type { RoutedWire } from "./route";
import { flexLengths, type PartBox, type TravelPlan } from "./travel";
import type { HarnessRouteRequest, HarnessRouteResponse, TravelInput } from "./cables.worker";
import { spliceKey, type SplicePlace, type WiringFindings } from "./clash";
import type { MountResult } from "./mounts";
import { mountParts, mountSpecs, screwSpecs, solidsInput } from "./inputs";
import { flowZones } from "./flow";
import { pivotJoints } from "./pivots";
import { wiringItems } from "./checks";

interface HarnessState {
  harness: Harness | null;
  /** routed cables by wire id (and by piece id for moving cables), for the harness above (null while the first route runs) */
  routes: Map<string, RoutedWire> | null;
  /** the moving cables' links and pieces the routes were made with */
  plan: TravelPlan | null;
  status: "idle" | "routing" | "done" | "error";
  error: string;
  /** the inputs the routes were made for */
  key: string;
  /** the checks of the routed harness, and of how each module is held, for `checked` */
  findings: WiringFindings | null;
  mounts: MountResult[] | null;
  /** where each splice went, by splice key */
  splices: SplicePlace[];
  /** the inputs the checks were made for (equal to key once they arrive) */
  checked: string;
}

export const useHarness = create<HarnessState>(() => ({ harness: null, routes: null, plan: null, status: "idle", error: "", key: "", findings: null, mounts: null, splices: [], checked: "" }));

let worker: Worker | null = null;
let nextId = 1;
let pendingId = 0;
let lastModel: Model | null = null;
/** the moving-cable plan for the report, by its inputs */
const plans = new Map<string, TravelPlan | null>();
let planWanted: { id: number; key: string } | null = null;

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
    if (planWanted && msg.id === planWanted.id) {
      keepPlan(planWanted.key, msg.ok ? msg.plan : null);
      planWanted = null;
      refreshReport();
      return;
    }
    if (msg.id !== pendingId) return;
    if (msg.ok) {
      const splices = msg.splices ?? [];
      const st = useHarness.getState();
      if (st.harness) placeSplices(st.harness, splices);
      useHarness.setState({ routes: new Map((msg.result?.wires ?? []).map((r) => [r.id, r])), plan: msg.plan, status: "done", error: "", findings: msg.findings ?? null, mounts: msg.mounts ?? null, splices, checked: st.key });
    } else useHarness.setState({ status: "error", error: msg.error });
    refreshReport();
  };
  w.onerror = (e) => {
    worker?.terminate();
    worker = null;
    if (planWanted) {
      keepPlan(planWanted.key, null);
      planWanted = null;
    }
    useHarness.setState({ status: "error", error: e.message || "The cable router stopped." });
    refreshReport();
  };
  worker = w;
  return w;
}

/** Move the harness's splices to where the worker put them. */
function placeSplices(h: Harness, at: SplicePlace[]) {
  if (!at.length) return;
  const by = new Map(at.map((p) => [p.key, p]));
  for (const w of h.wires)
    for (const e of w.ends) {
      const p = e.splice && by.get(spliceKey(e.splice));
      if (p) Object.assign(e.splice!, { from: p.from, to: p.to, dir: p.dir, across: p.across });
    }
}

function keepPlan(key: string, plan: TravelPlan | null) {
  plans.set(key, plan);
  while (plans.size > 6) plans.delete(plans.keys().next().value!);
}

const visible = (model: Model) => model.parts.filter((p) => !p.hidden && (meshes.get(p.hash)?.preview ?? meshes.get(p.hash)?.final));

/** Every built part's box in the assembly, for the moving-cable planner. */
function partBoxes(parts: EvalPart[]): PartBox[] {
  const out: PartBox[] = [];
  for (const p of parts) {
    const e = meshes.get(p.hash);
    if (!e) continue;
    const m = xformMatrix(p.xf);
    const [lo, hi] = e.bbox;
    const a: V3 = [Infinity, Infinity, Infinity];
    const b: V3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? hi[0] : lo[0];
      const y = c & 2 ? hi[1] : lo[1];
      const z = c & 4 ? hi[2] : lo[2];
      for (let k = 0; k < 3; k++) {
        const v = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
        a[k] = Math.min(a[k], v);
        b[k] = Math.max(b[k], v);
      }
    }
    out.push({ id: p.id, lo: a, hi: b, removable: !!p.removable, made: p.kind !== "component" });
  }
  return out;
}

/** The planner's inputs for a design that poses itself from show_x, show_y and show_z, with a key for them. */
function travelInput(model: Model, harness: Harness, parts: EvalPart[]): { input: TravelInput; key: string } | null {
  const d = useDesign.getState();
  if (d.model !== model || !posable(model) || !harness.wires.length) return null;
  const boxes = partBoxes(parts);
  const key = hash(d.source + JSON.stringify(boxes) + JSON.stringify(harness.wires.map((w) => [w.id, w.ends.map((e) => e.partId)])));
  return { input: { source: d.source, boxes, harness }, key };
}

/**
 * Bring the harness up to date with a model whose meshes are built. Cheap
 * when nothing changed: the route request is keyed by the wire ends, by
 * every solid's geometry and placement, by how the machine moves, and by
 * the modules whose holding is checked and the screws that might hold them.
 */
export function updateHarness(model: Model) {
  if (model === lastModel && useHarness.getState().harness) return;
  lastModel = model;
  const harness = buildHarness(model);
  const mounts = mountParts(model);
  if (!harness.wires.length && !mounts.size) {
    useHarness.setState({ harness, routes: new Map(), plan: null, status: "done", key: "", findings: null, mounts: [], splices: [], checked: "" });
    return;
  }
  const parts = visible(model);
  const wires = routeRequests(harness);
  const travel = travelInput(model, harness, parts);
  const mesh = (hash: string) => {
    const e = meshes.get(hash);
    const m = e && (e.preview ?? e.final);
    return e && m ? { positions: m.positions, indices: m.indices, bbox: e.bbox } : undefined;
  };
  const specs = mountSpecs(model, (h) => meshes.get(h)?.bbox, mounts);
  const screws = screwSpecs(model);
  // cables keep out of fans' airflow and cross the design's pivots beside their bearings
  const pivots = pivotJoints(model);
  const flow = flowZones(model);
  const key = hash(
    JSON.stringify(wires.map((w) => [w.id, w.a.p, w.b.p])) +
      parts.map((p) => `${p.id}:${p.hash}:${JSON.stringify(p.xf)}`).join("|") +
      (travel?.key ?? "") +
      JSON.stringify(specs.map((s) => [s.comp, s.held])) +
      JSON.stringify(screws.map((s) => [s.id, s.seat, s.axis, s.length])) +
      JSON.stringify(pivots.map((j) => [j.name, j.at, j.axis, j.limits, j.parent, j.parts.length, j.cables])) +
      JSON.stringify(flow.map((z) => [z.partId, z.kind, z.o, z.dir])),
  );
  const st = useHarness.getState();
  if (key === st.key) {
    // same routes: keep them, with the harness of this model (labels or colours may differ)
    placeSplices(harness, st.splices);
    useHarness.setState({ harness });
    return;
  }
  // keep showing the old routes for cables that still exist until the new ones arrive
  useHarness.setState({ harness, key, status: "routing" });
  if (typeof Worker === "undefined") return;
  const { geos, placed } = solidsInput({ ...model, parts }, mesh, mounts);
  pendingId = nextId++;
  const req: HarnessRouteRequest = {
    id: pendingId,
    // the worker takes the mesh buffers, so it gets its own copies
    input: { geos: geos.map((g) => ({ positions: g.positions.slice(), indices: g.indices.slice() })), placed, wires },
    travel: travel?.input,
    wiring: { harness, mounts: specs, screws, pivots, flow },
  };
  ensureWorker().postMessage(
    req,
    req.input.geos.flatMap((g) => [g.positions.buffer, g.indices.buffer]),
  );
}

/** The wiring and mounting checks for a model, once they are in: resolves when they are (or after `ms`). */
export function whenWiringChecked(model: Model | null | undefined, ms = 15_000): Promise<void> {
  if (!model || typeof Worker === "undefined") return Promise.resolve();
  if (model !== lastModel) updateHarness(model);
  const done = () => {
    const st = useHarness.getState();
    return lastModel !== model || st.status === "error" || (st.status === "done" && st.checked === st.key);
  };
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve();
    }, ms);
    const off = useHarness.subscribe(() => {
      if (!done()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** The wiring and mounting checks, for a live report of a model whose meshes are built. */
function wiringPass(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  if (!ctx.live || typeof Worker === "undefined") return items;
  const model = ctx.model;
  if (!model.machine?.wires.length && !mountParts(model).size) return items;
  // every part built (or failed to build) first
  if (model.parts.some((p) => !p.hidden && !ctx.buildErrors.has(p.hash) && !(meshes.get(p.hash)?.preview ?? meshes.get(p.hash)?.final))) return items;
  // routing runs in the worker; ask for it after this report is composed
  if (model !== lastModel) queueMicrotask(() => updateHarness(model));
  const st = useHarness.getState();
  if (model === lastModel && st.status === "done" && st.checked === st.key && st.harness) return [...items, ...wiringItems(st.harness, st.findings, st.mounts ?? [], model)];
  if (model === lastModel && st.status === "error")
    return [...items, { id: "wiring:error", category: "electrical", status: "warn", title: "The wiring could not be checked", detail: st.error, basis: "geometry" }];
  return [
    ...items,
    { id: "wiring:pending", category: "electrical", status: "pending", title: "Wiring and mounting: checking", detail: "Routing the cables round the parts, then checking them, their plugs and how each board and module is held.", basis: "geometry" },
  ];
}

/** The moving-cable plan for a model, for the report: from the cache, else asked of the worker. */
function planFor(model: Model): { status: "pending" | "done"; plan: TravelPlan | null } | null {
  if (!posable(model) || typeof Worker === "undefined") return null;
  const harness = buildHarness(model);
  if (!harness.wires.length) return null;
  const parts = visible(model);
  // every part's box is needed: the plan waits for the build
  if (parts.length < model.parts.filter((p) => !p.hidden).length) return { status: "pending", plan: null };
  const t = travelInput(model, harness, parts);
  if (!t) return null;
  if (plans.has(t.key)) return { status: "done", plan: plans.get(t.key)! };
  // the wiring view's routes may already carry it
  const st = useHarness.getState();
  if (st.status === "done" && st.plan && lastModel === model) {
    keepPlan(t.key, st.plan);
    return { status: "done", plan: st.plan };
  }
  if (planWanted?.key !== t.key) {
    planWanted = { id: nextId++, key: t.key };
    const req: HarnessRouteRequest = { id: planWanted.id, plan: t.input };
    ensureWorker().postMessage(req);
  }
  return { status: "pending", plan: null };
}

function travelPass(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  if (!ctx.live || !ctx.model.machine) return items;
  const st = planFor(ctx.model);
  if (!st) return items;
  if (st.status === "pending")
    return [...items, { id: "cables:travel", category: "motion", status: "pending", title: "Moving cables: checking them through full travel", detail: "Working out where the cables to the moving parts need drag chains or loops, and checking them at every end of travel.", basis: "geometry" }];
  if (!st.plan) return items;
  return [
    ...items,
    ...st.plan.checks.map(
      (c): CheckItem => ({
        id: `cables:${c.link}`,
        category: "motion",
        status: c.status,
        title: c.title,
        detail: c.detail,
        parts: c.parts,
        basis: "geometry",
        fix: c.status === "pass" ? undefined : "Ask Claude to move the cable's tie points, give it a longer loop or a bigger chain, or route it another way.",
      }),
    ),
  ];
}

let started = false;

/** Add the moving cables' checks to the design engine's reports. */
export function startCableRuntime() {
  if (started) return;
  started = true;
  registerReportPass("cables", travelPass, 16);
  registerReportPass("wiring", wiringPass, 16.2);
  refreshReport();
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
    const run = wireRun(w.id);
    if (run !== undefined) out.set(w.id, run);
  }
  return out;
}

/**
 * One cable's run plug to plug, from the routes there are now: its routed
 * pieces with a lead at each end of each, and for a moving cable its run
 * inside its chains and loops. Undefined while it has no route.
 */
export function wireRun(id: string): number | undefined {
  const st = useHarness.getState();
  const w = st.harness?.wires.find((x) => x.id === id);
  if (!w || !st.routes) return undefined;
  const pieces = st.plan?.pieces[id];
  const runs = (pieces ?? [{ id }]).map((p) => st.routes!.get(p.id));
  if (runs.some((r) => !r || r.straight)) return undefined;
  const flex = st.plan ? (flexLengths(st.plan).get(id) ?? 0) : 0;
  return runs.reduce((s, r) => s + r!.length + 2 * leadLength(w), 0) + flex;
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
