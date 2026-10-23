// Runs the design's airflow analyses and feeds their results into the check
// report. A run starts a few seconds after the parts in the air last
// changed (a newer change stops an older run), in a worker of its own, on
// the GPU where there is one. Each finished run is kept as a version so the
// panel and the assistant can say what a change did to the drag.

import { create } from "zustand";
import { meshes, refreshReport, useDesign } from "../core/engine";
import type { CheckItem } from "../core/checks";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import { turns, type EvalPart, type Model } from "../core/model";
import { xformMatrix } from "../kernel/recipe";
import type { MeshData } from "../kernel/build";
import { fmtNum } from "../lang/values";
import type { AirflowSpec, V3 } from "./spec";
import type { AeroBody, AirflowInput, AirflowProgress, AirflowResult, YawResult } from "./aero/types";
import type { AeroRequest, AeroResponse } from "./protocol";
import { riderMesh } from "./aero/rider";

export interface AirflowRun {
  label: string;
  key: string;
  status: "waiting" | "running" | "done" | "error";
  stage: string;
  frac: number;
  /** the latest progress (drag so far, a live slice of the flow) */
  progress?: AirflowProgress;
  /** the latest result; while a newer run is under way this is the previous one */
  result?: AirflowResult;
  stale: boolean;
  error?: string;
  /** the set-up cannot be run as written (as opposed to a crash) */
  setup?: boolean;
  startedAt: number;
}

/** A finished run kept for comparing versions of the design. */
export interface AirflowVersion {
  key: string;
  at: number;
  rev: number;
  /** what changed, from the parts' names (filled in by comparing with the version before) */
  note: string;
  speed: number;
  yaws: { yaw: number; cda: number; drag: number; side: number; lift: number; watts: number }[];
  parts: { id: string; name: string; cda: number }[];
  /** part hashes, to say which parts changed between versions */
  hashes: Record<string, string>;
}

export type SurfaceShown = "cp" | "cf" | "none";

interface AirflowState {
  runs: Map<string, AirflowRun>;
  versions: Map<string, AirflowVersion[]>;
  /** analysis drawn on the model */
  shown: string | null;
  /** index into the shown result's yaws */
  yaw: number;
  surface: SurfaceShown;
  lines: boolean;
  wake: boolean;
  vortices: boolean;
  /** a plane through the averaged flow: off, or along which axis it is cut, and where (0..1 across the box) */
  slice: "off" | "side" | "top" | "front";
  sliceAt: number;
}

export const useAirflow = create<AirflowState>(() => ({
  runs: new Map(),
  versions: new Map(),
  shown: null,
  yaw: 0,
  surface: "cp",
  lines: true,
  wake: false,
  vortices: false,
  slice: "off",
  sliceAt: 0.5,
}));

const aGet = useAirflow.getState;
const aSet = useAirflow.setState;

/** The quality's time limit, minutes (the analysis can set its own with time:). */
const TIME_LIMIT = { draft: 4, standard: 12, fine: 40 };
/** wait this long after the last change before starting a run */
const SETTLE_MS = 2500;
const MAX_VERSIONS = 12;

function patchRun(label: string, patch: Partial<AirflowRun>) {
  const r = aGet().runs.get(label);
  if (!r) return;
  aSet({ runs: new Map(aGet().runs).set(label, { ...r, ...patch }) });
}

// ---------- worker ----------

interface Job {
  id: number;
  label: string;
  key: string;
  input: AirflowInput;
  rev: number;
  hashes: Record<string, string>;
}
let worker: Worker | null = null;
let current: Job | null = null;
let queue: Job[] = [];
let nextId = 0;
let startTimer: ReturnType<typeof setTimeout> | null = null;

function stopWorker() {
  worker?.terminate();
  worker = null;
  current = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./aero.worker.ts", import.meta.url), { type: "module", name: "kerf-airflow" });
  w.onmessage = (ev: MessageEvent<AeroResponse>) => {
    const msg = ev.data;
    if (!current || msg.id !== current.id) return;
    const job = current;
    if (msg.type === "progress") {
      const prev = aGet().runs.get(job.label)?.progress;
      // keep the last picture of the flow between pictures
      const progress = msg.progress.slice || !prev?.slice ? msg.progress : { ...msg.progress, slice: prev.slice };
      patchRun(job.label, { stage: msg.progress.stage, frac: msg.progress.frac, progress });
      return;
    }
    current = null;
    if (msg.type === "error") {
      patchRun(job.label, { status: "error", error: msg.cancelled ? "Stopped." : msg.message, stale: false });
    } else {
      patchRun(job.label, { status: "done", result: msg.result, stale: false, error: undefined, frac: 1, stage: "Done" });
      keepVersion(job, msg.result);
    }
    refreshReport();
    pump();
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    const job = current;
    stopWorker();
    if (job) patchRun(job.label, { status: "error", error: 'The airflow run stopped unexpectedly, most likely out of memory. Try resolution: "draft".', stale: false });
    refreshReport();
    pump();
  };
  worker = w;
  return w;
}

function pump() {
  if (current || !queue.length) return;
  const job = queue.shift()!;
  current = job;
  patchRun(job.label, { status: "running", startedAt: performance.now(), stage: "Building the tunnel", frac: 0 });
  const transfer = job.input.bodies.flatMap((b) => [b.positions.buffer, b.indices.buffer, ...(b.normals ? [b.normals.buffer] : [])]) as ArrayBuffer[];
  ensureWorker().postMessage({ id: job.id, type: "run", input: job.input } satisfies AeroRequest, transfer);
}

function cancel(label: string) {
  queue = queue.filter((j) => j.label !== label);
  if (current?.label === label) stopWorker();
}

/** Stop a run (the user pressed stop): it keeps its previous result. */
export function stopAirflow(label: string) {
  cancel(label);
  patchRun(label, { status: "error", error: "Stopped.", stale: false });
  refreshReport();
  pump();
}

function keepVersion(job: Job, r: AirflowResult) {
  const list = [...(aGet().versions.get(job.label) ?? [])];
  const prev = list[list.length - 1];
  const yaws = r.yaws.map((y) => ({ yaw: y.yaw, cda: y.cda, drag: y.drag, side: y.side, lift: y.lift, watts: y.watts }));
  const zero = r.yaws.find((y) => y.yaw === 0) ?? r.yaws[0];
  const changed = prev ? Object.keys(job.hashes).filter((id) => prev.hashes[id] !== job.hashes[id]) : [];
  const names = changed.map((id) => zero?.parts.find((p) => p.id === id)?.name ?? id).slice(0, 4);
  const note = !prev ? "first run" : names.length ? `changed ${names.join(", ")}${changed.length > names.length ? ` and ${changed.length - names.length} more` : ""}` : "same parts, new set-up";
  if (prev?.key === job.key) list.pop();
  list.push({ key: job.key, at: Date.now(), rev: job.rev, note, speed: r.speed, yaws, parts: zero ? zero.parts.map((p) => ({ id: p.id, name: p.name, cda: p.cda })) : [], hashes: job.hashes });
  aSet({ versions: new Map(aGet().versions).set(job.label, list.slice(-MAX_VERSIONS)) });
}

// ---------- preparing a run ----------

const shownMesh = (hash: string) => meshes.get(hash)?.preview ?? meshes.get(hash)?.final;

/** The parts an airflow analysis puts in the air: the ones it names, or every part shown. */
export function airflowParts(spec: AirflowSpec, model: Model): EvalPart[] {
  return spec.parts.length ? model.parts.filter((p) => spec.parts.includes(p.name)) : model.parts.filter((p) => !p.hidden);
}

function worldMesh(p: EvalPart, data: MeshData): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const m = xformMatrix(p.xf);
  const P = data.positions;
  const N = data.normals;
  const pos = new Float32Array(P.length);
  const nrm = new Float32Array(N.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i],
      y = P[i + 1],
      z = P[i + 2];
    pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const a = N[i],
      b = N[i + 1],
      c = N[i + 2];
    nrm[i] = m[0] * a + m[4] * b + m[8] * c;
    nrm[i + 1] = m[1] * a + m[5] * b + m[9] * c;
    nrm[i + 2] = m[2] * a + m[6] * b + m[10] * c;
  }
  return { positions: pos, normals: nrm, indices: Uint32Array.from(data.indices) };
}

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function boxOf(P: Float32Array): { lo: V3; hi: V3 } {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], P[i + k]);
      hi[k] = Math.max(hi[k], P[i + k]);
    }
  return { lo, hi };
}

/**
 * Wheels: parts that turn about an axis square to the way the design travels and to up, whose turning group
 * reaches down to the road. Everything turning about the same axle (hub, tyre, disc) spins with it.
 */
function findWheels(spec: AirflowSpec, parts: EvalPart[], bodies: AeroBody[], groundU: number) {
  const F = spec.forward;
  const U = spec.up;
  const groups = new Map<string, { origin: V3; axis: V3; idx: number[]; named: boolean }>();
  for (const [i, p] of parts.entries()) {
    const m = p.motion;
    if (!m || m.kind || m.parent || !turns(m)) continue;
    const l = Math.hypot(...m.axis) || 1;
    const ax: V3 = [m.axis[0] / l, m.axis[1] / l, m.axis[2] / l];
    if (Math.abs(dot3(ax, F)) > 0.2 || Math.abs(dot3(ax, U)) > 0.2) continue;
    const key = m.origin.map((v) => Math.round(v)).join(",");
    const g = groups.get(key) ?? { origin: m.origin, axis: ax, idx: [], named: false };
    g.idx.push(i);
    if (spec.wheels?.includes(p.name)) g.named = true;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const axleH = dot3(g.origin, U) - groundU;
    let reach = 0;
    for (const i of g.idx) {
      const P = bodies[i].positions;
      for (let v = 0; v < P.length; v += 3) {
        const d: V3 = [P[v] - g.origin[0], P[v + 1] - g.origin[1], P[v + 2] - g.origin[2]];
        const a = dot3(d, g.axis);
        reach = Math.max(reach, Math.hypot(d[0] - a * g.axis[0], d[1] - a * g.axis[1], d[2] - a * g.axis[2]));
      }
    }
    const rolls = spec.wheels ? g.named : axleH > 0 && Math.abs(reach - axleH) < 0.15 * axleH;
    if (!rolls) continue;
    for (const i of g.idx) bodies[i].wheel = { axis: g.axis, origin: g.origin, radius: axleH };
  }
}

/** Where a rider sits: the saddle's top, the bars' box and the bottom bracket, from named parts or the UCI check's. */
function riderAnchors(spec: AirflowSpec, model: Model, all: { p: EvalPart; box: { lo: V3; hi: V3 } }[]): { saddle: V3; bars: { lo: V3; hi: V3 }; bb: V3 } | string {
  const uci = model.analyses.find((a) => (a as { kind: string }).kind === "uci") as { saddle?: string; bars?: string; bb?: { part?: string; at?: V3 } } | undefined;
  const find = (name: string | undefined, re: RegExp) => (name ? all.find((x) => x.p.name === name) : all.find((x) => re.test(x.p.name)));
  const saddle = find(spec.rider?.saddle ?? uci?.saddle, /saddle/i);
  const bars = find(spec.rider?.bars ?? uci?.bars, /handle_?bar|^bars?$|cockpit|drop_?bar/i);
  const bbPart = find(spec.rider?.bb ?? uci?.bb?.part, /crank/i);
  const bbAt = uci?.bb?.at ?? (bbPart?.p.motion ? bbPart.p.motion.origin : bbPart ? mid(bbPart.box) : undefined);
  const missing = [!saddle && "saddle:", !bars && "bars:", !bbAt && "bottom_bracket:"].filter(Boolean);
  if (missing.length) return `rider: needs to know where the rider sits: name the parts with ${missing.join(", ")} (e.g. saddle: saddle, bars: handlebar, bottom_bracket: crankset).`;
  const U = spec.up;
  const s = saddle!.box;
  const sTop: V3 = mid(s);
  const top = Math.max(dot3(s.lo, U), dot3(s.hi, U));
  const off = top - dot3(sTop, U);
  return { saddle: [sTop[0] + U[0] * off, sTop[1] + U[1] * off, sTop[2] + U[2] * off], bars: bars!.box, bb: bbAt! };
}

const mid = (b: { lo: V3; hi: V3 }): V3 => [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];

/** World-space bodies and settings for an airflow analysis; null while geometry is still building. */
export function airflowInput(
  spec: AirflowSpec,
  model: Model,
  buildErrors: Map<string, string>,
  meshOf: (hash: string) => MeshData | undefined = shownMesh,
): { input?: AirflowInput; error?: string } | null {
  const parts = airflowParts(spec, model);
  if (!parts.length) return { error: spec.parts.length ? `None of ${spec.parts.join(", ")} has geometry to put in the air.` : "There are no parts to put in the air." };
  const broken = parts.find((p) => buildErrors.has(p.hash));
  if (broken) return { error: `${broken.label} did not build, so the airflow cannot run yet.` };
  const bodies: AeroBody[] = [];
  const boxes: { p: EvalPart; box: { lo: V3; hi: V3 } }[] = [];
  for (const p of parts) {
    const data = meshOf(p.hash);
    if (!data) return null;
    const w = worldMesh(p, data);
    bodies.push({ id: p.id, name: p.label || p.name, ...w });
    boxes.push({ p, box: boxOf(w.positions) });
  }
  let groundU = Infinity;
  for (const b of bodies) for (let i = 0; i < b.positions.length; i += 3) groundU = Math.min(groundU, b.positions[i] * spec.up[0] + b.positions[i + 1] * spec.up[1] + b.positions[i + 2] * spec.up[2]);
  if (spec.ground) findWheels(spec, parts, bodies, groundU);
  if (spec.rider) {
    const all = model.parts.map((p) => {
      const d = meshOf(p.hash);
      return { p, box: d ? boxOf(worldMesh(p, d).positions) : { lo: [0, 0, 0] as V3, hi: [0, 0, 0] as V3 } };
    });
    const at = riderAnchors(spec, model, all);
    if (typeof at === "string") return { error: at };
    const m = riderMesh({ ...at, forward: spec.forward, up: spec.up }, spec.rider.position, spec.rider.height);
    bodies.push({ id: "rider", name: `Rider (${spec.rider.position})`, positions: m.positions, indices: m.indices, extra: true });
  }
  const quality = typeof spec.resolution === "string" ? spec.resolution : "standard";
  return {
    input: {
      label: spec.label,
      bodies,
      speed: spec.speed / 1000,
      density: spec.density,
      nu: spec.nu,
      facing: spec.forward,
      up: spec.up,
      yaws: spec.yaw,
      ground: spec.ground,
      quality,
      cells: 0,
      h: typeof spec.resolution === "string" ? undefined : spec.resolution.h,
      backend: "auto",
      maxMinutes: spec.time ? spec.time / 60 : TIME_LIMIT[quality],
    },
  };
}

function inputKey(spec: AirflowSpec, parts: EvalPart[]): string {
  const { span: _span, ...rest } = spec;
  void _span;
  return JSON.stringify({ rest, parts: parts.map((p) => [p.id, p.hash, p.xf, p.motion?.origin, p.motion?.axis]) });
}

// ---------- scheduling ----------

let scheduledRev = -1;
let pendingStart = false;

function schedule(state: Pick<ReportContext, "model" | "rev" | "buildErrors">) {
  const model = state.model;
  scheduledRev = state.rev;
  const specs = model.analyses.filter((a): a is AirflowSpec => a.kind === "airflow");
  const labels = new Set(specs.map((s) => s.label));
  const runs = new Map(aGet().runs);
  let shown = aGet().shown;
  for (const label of runs.keys()) {
    if (labels.has(label)) continue;
    cancel(label);
    runs.delete(label);
    if (shown === label) shown = null;
  }
  const fresh: Job[] = [];
  for (const spec of specs) {
    const parts = airflowParts(spec, model);
    const key = inputKey(spec, parts);
    const run = runs.get(spec.label);
    if (run && run.key === key) continue;
    const prep = airflowInput(spec, model, state.buildErrors);
    if (!prep) continue;
    cancel(spec.label);
    const base: AirflowRun = { label: spec.label, key, status: "waiting", stage: "Waiting for the design to settle", frac: 0, stale: !!run?.result, result: run?.result, startedAt: performance.now() };
    if (prep.error) runs.set(spec.label, { ...base, status: "error", error: prep.error, setup: true, result: undefined, stale: false });
    else {
      runs.set(spec.label, base);
      fresh.push({ id: ++nextId, label: spec.label, key, input: prep.input!, rev: state.rev, hashes: Object.fromEntries(parts.map((p) => [p.id, p.hash])) });
    }
  }
  aSet({ runs, shown });
  if (!fresh.length) return;
  queue.push(...fresh);
  // start once the design has sat still for a moment, so typing does not start and stop runs
  if (startTimer) clearTimeout(startTimer);
  pendingStart = true;
  startTimer = setTimeout(() => {
    startTimer = null;
    pendingStart = false;
    pump();
  }, SETTLE_MS);
}

// ---------- check items ----------

const fmtW = (w: number) => `${fmtNum(w, 0)} W`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Mean over the yaw angles (each counts the same), for the limits and the headline. */
export function yawMean(r: AirflowResult, f: (y: YawResult) => number): number {
  return mean(r.yaws.map(f));
}

/** The check items an airflow result gives (or its state while running). */
export function airflowItems(spec: AirflowSpec, run: AirflowRun | undefined, model: Model, versions?: AirflowVersion[]): CheckItem[] {
  const parts = airflowParts(spec, model).map((p) => p.id);
  const base = { category: "analysis" as const, basis: "simulation" as const, span: spec.span, parts };
  const id = (s: string) => `aero:${spec.label}:${s}`;
  if (!run || run.status === "waiting" || run.status === "running") {
    const pct = run?.status === "running" ? ` ${Math.round(100 * run.frac)} %` : "";
    return [{ ...base, id: id("drag"), status: "pending", title: `Drag: ${spec.label}`, detail: `${run?.result ? "Re-running the airflow for the latest change" : "Running the airflow"}${pct}${run?.stage ? ` (${run.stage.toLowerCase()})` : ""}…` }];
  }
  if (run.status === "error" || !run.result) return [{ ...base, id: id("setup"), status: "fail", title: `Airflow analysis: ${spec.label}`, detail: run.error ?? "The airflow run did not finish." }];
  const r = run.result;
  const out: CheckItem[] = [];
  const cda = yawMean(r, (y) => y.cda);
  const drag = yawMean(r, (y) => y.drag);
  const watts = yawMean(r, (y) => y.watts);
  const kmh = fmtNum(r.speed * 3.6, 0);
  const perYaw = r.yaws.map((y) => `${fmtNum(y.cda, 3)} m² at ${fmtNum(y.yaw, 1)}°`).join(", ");
  const zero = r.yaws.find((y) => y.yaw === 0) ?? r.yaws[0];
  const total = zero.parts.reduce((a, p) => a + Math.max(0, p.drag), 0) || 1;
  const top = [...zero.parts].sort((a, b) => b.drag - a.drag).slice(0, 4).map((p) => `${p.name} ${fmtNum((100 * Math.max(0, p.drag)) / total, 0)} %`);
  const prev = versions && versions.length > 1 ? versions[versions.length - 2] : undefined;
  const prevCda = prev ? mean(prev.yaws.map((y) => y.cda)) : undefined;
  const vs = prevCda ? ` ${cda < prevCda ? "Down" : "Up"} ${fmtNum((Math.abs(cda - prevCda) / prevCda) * 100, 1)} % on the version before (${prev!.note}).` : "";
  const unsure = r.yaws.some((y) => !y.converged);
  const verdict = (ok: boolean) => (ok ? (unsure ? "warn" : "pass") : "fail") as CheckItem["status"];
  const detail =
    `Drag area (CdA) ${perYaw}${r.yaws.length > 1 ? `; mean ${fmtNum(cda, 3)} m²` : ""}. ` +
    `Drag ${fmtNum(drag, 1)} N at ${kmh} km/h of air, ${fmtW(watts)} to push through it. ` +
    `Most drag at 0°: ${top.join(", ")}.${vs}`;
  const status: CheckItem["status"] = spec.maxCda !== undefined ? verdict(cda <= spec.maxCda) : spec.maxDrag !== undefined ? verdict(drag <= spec.maxDrag) : "info";
  out.push({
    ...base,
    id: id("drag"),
    status,
    ...(spec.maxCda !== undefined ? { margin: spec.maxCda - cda } : spec.maxDrag !== undefined ? { margin: spec.maxDrag - drag } : {}),
    title: `Drag: ${spec.label}`,
    detail: detail + (spec.maxCda !== undefined ? ` Target CdA ${fmtNum(spec.maxCda, 3)} m² or less.` : spec.maxDrag !== undefined ? ` Target ${fmtNum(spec.maxDrag, 1)} N or less.` : ""),
    ...(status === "fail" ? { fix: "Look at the pressure on the surface and the wake in the Analysis tab: high pressure on blunt fronts and a wide wake behind square backs cost the most. Streamline or narrow the parts with the most drag, or ask the assistant to reshape them." } : {}),
  });
  if (spec.maxCda !== undefined && spec.maxDrag !== undefined) out.push({ ...base, id: id("force"), status: verdict(drag <= spec.maxDrag), margin: spec.maxDrag - drag, title: `Drag force: ${spec.label}`, detail: `${fmtNum(drag, 1)} N mean over the yaw angles, target ${fmtNum(spec.maxDrag, 1)} N or less.` });
  if (spec.maxWatts !== undefined) out.push({ ...base, id: id("watts"), status: verdict(watts <= spec.maxWatts), margin: spec.maxWatts - watts, title: `Power against the air: ${spec.label}`, detail: `${fmtW(watts)} mean over the yaw angles at ${kmh} km/h, target ${fmtW(spec.maxWatts)} or less.` });
  if (spec.maxLift !== undefined) {
    const lift = yawMean(r, (y) => y.lift);
    out.push({
      ...base,
      id: id("lift"),
      status: verdict(lift <= spec.maxLift),
      margin: spec.maxLift - lift,
      title: `Lift: ${spec.label}`,
      detail: `${lift < 0 ? `${fmtNum(-lift, 1)} N of downforce` : `${fmtNum(lift, 1)} N of lift`} mean over the yaw angles, limit ${spec.maxLift < 0 ? `${fmtNum(-spec.maxLift, 1)} N of downforce or more` : `${fmtNum(spec.maxLift, 1)} N`}.`,
    });
  }
  const notes = [...r.warnings];
  notes.push(`Cells ${fmtNum(r.h, 1)} mm (${fmtNum(r.cells / 1e6, 1)} million round the design) on the ${r.backend === "gpu" ? `GPU${r.adapter ? ` (${r.adapter})` : ""}` : "CPU"}; Reynolds number ${fmtNum(r.reynolds / 1e6, 2)} million.`);
  out.push({ ...base, id: id("notes"), status: "info", title: `Accuracy notes: ${spec.label}`, detail: notes.join(" ") });
  return out;
}

const AERO_ITEM = /^aero:/;

export function aeroReportItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  const { model } = ctx;
  if (ctx.live && ctx.rev !== scheduledRev) schedule(ctx);
  const out = items.filter((i) => !AERO_ITEM.test(i.id));
  for (const a of model.analyses) {
    if (a.kind !== "airflow") continue;
    if (ctx.live) out.push(...airflowItems(a, aGet().runs.get(a.label), model, aGet().versions.get(a.label)));
    else out.push({ id: `aero:${a.label}:drag`, category: "analysis", basis: "simulation", span: a.span, status: "info", title: `Drag: ${a.label}`, detail: "The airflow analysis runs once this work is merged into the design." });
  }
  return out;
}

// ---------- start-up and waiting ----------

let started = false;

export function startAirflowRuntime() {
  if (started) return;
  started = true;
  registerReportPass("airflow", aeroReportItems, 21);
  refreshReport();
}

/** Resolves when every airflow analysis of the current design has a result or an error (or the time runs out). */
export function whenAirflowDone(timeoutMs = 15 * 60_000): Promise<void> {
  const done = () => {
    const d = useDesign.getState();
    if (!d.model || d.reportRev < d.rev || scheduledRev < d.reportRev || pendingStart) return false;
    return d.model.analyses.every((a) => a.kind !== "airflow" || ["done", "error"].includes(aGet().runs.get(a.label)?.status ?? ""));
  };
  return new Promise((resolve) => {
    if (done()) return resolve();
    const finish = () => {
      clearTimeout(timer);
      clearInterval(poll);
      u1();
      u2();
      resolve();
    };
    const check = () => done() && finish();
    const u1 = useAirflow.subscribe(check);
    const u2 = useDesign.subscribe(check);
    const poll = setInterval(check, 1000);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Run every airflow analysis now, skipping the wait for the design to settle. */
export function startAirflowNow() {
  if (startTimer) clearTimeout(startTimer);
  startTimer = null;
  pendingStart = false;
  pump();
}

export function showAirflow(label: string | null) {
  aSet({ shown: label, yaw: 0 });
}
