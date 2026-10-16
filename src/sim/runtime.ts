// Runs the design's scenarios and feeds their expectations into the check
// report. Each scenario runs once per variant (pessimistic, expected,
// optimistic) in a pool of workers, only when its inputs changed: the
// scenario itself, the machine (parts, wiring, firmware settings) or the
// design name. Results are cached by those inputs, so undo or switching back
// shows the earlier result at once. A newer change cancels an older run.
//
// Expectations are judged here on the main thread, from the cached results,
// so editing an `expect` line re-checks without running again.

import { create } from "zustand";
import { refreshReport, useDesign } from "../core/engine";
import type { CheckItem } from "../core/checks";
import { useVerdict } from "../core/briefChecks";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { Model } from "../core/model";
import type { MachineData } from "../machine/types";
import type { RunResult, VariantRun } from "./engine/run";
import { judge, type ExpectOutcome } from "./expect";
import type { SimRequest, SimResponse } from "./protocol";
import type { ScenarioDef, ScenarioSpec } from "./scenario";
import { VARIANTS, type VariantName } from "./worlds/common";

export interface SimRun {
  label: string;
  /** identity of the inputs: the same key gives the same result */
  key: string;
  status: "idle" | "waiting" | "running" | "done" | "error";
  /** 0..1 for each variant being run */
  progress: Partial<Record<VariantName, number>>;
  /** the latest result; while a newer run is under way this is the previous one */
  result?: RunResult;
  stale: boolean;
  error?: string;
  startedAt: number;
  /** wall-clock ms the last run took */
  ms?: number;
}

interface SimState {
  runs: Map<string, SimRun>;
  /** scenario open in the Simulation tab */
  selected: string | null;
  /** the variant shown in playback and plots */
  variant: VariantName;
  /** run scenarios on every change (otherwise only when asked) */
  auto: boolean;
  /** playback */
  playing: boolean;
  t: number;
  speed: number;
  /** the viewport shows the simulation instead of the design */
  view: boolean;
}

export const useSim = create<SimState>(() => ({
  runs: new Map(),
  selected: null,
  variant: "expected",
  auto: loadAuto(),
  playing: false,
  t: 0,
  speed: 10,
  view: false,
}));

const sGet = useSim.getState;
const sSet = useSim.setState;

function loadAuto(): boolean {
  try {
    return localStorage.getItem("kerf.sim.auto") !== "0";
  } catch {
    return true;
  }
}

export function setAutoRun(on: boolean) {
  sSet({ auto: on });
  try {
    localStorage.setItem("kerf.sim.auto", on ? "1" : "0");
  } catch {
    // private window: the choice lasts until reload
  }
  if (on) scheduleNow();
}

// ---------- keys and cache ----------

/** cyrb53: a fast 53-bit string hash, enough to tell inputs apart */
function hash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Source positions move when anything above them is edited; they do not change a run. */
const noSpans = (k: string, v: unknown) => (k === "span" || k.endsWith("Span") ? undefined : v);

export function scenarioKey(spec: ScenarioSpec, machine: MachineData | undefined, designName: string): string {
  return hash(JSON.stringify({ spec, machine, designName }, noSpans));
}

const CACHE_MAX = 16;
const cache = new Map<string, RunResult>();

function remember(key: string, r: RunResult) {
  cache.delete(key);
  cache.set(key, r);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

// ---------- workers ----------

interface Job {
  id: number;
  label: string;
  key: string;
  variant: VariantName;
  req: SimRequest;
}

interface Slot {
  w: Worker;
  job: Job | null;
  deadline: ReturnType<typeof setTimeout> | null;
}

/** a variant that takes longer than this is stopped */
export const RUN_TIME_LIMIT_MS = 600_000;
const POOL = Math.max(1, Math.min(3, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2) - 1));
const slots: Slot[] = [];
let queue: Job[] = [];
let nextId = 0;
/** finished variants of the run in progress, by label */
const partial = new Map<string, Map<VariantName, RunResult>>();

function patchRun(label: string, patch: Partial<SimRun>) {
  const r = sGet().runs.get(label);
  if (!r) return;
  sSet({ runs: new Map(sGet().runs).set(label, { ...r, ...patch }) });
}

function newSlot(): Slot {
  const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module", name: "kerf-simulation" });
  const slot: Slot = { w, job: null, deadline: null };
  w.onmessage = (ev: MessageEvent<SimResponse>) => {
    const job = slot.job;
    const msg = ev.data;
    if (!job || msg.id !== job.id) return;
    if (msg.type === "progress") {
      const r = sGet().runs.get(job.label);
      if (r && r.key === job.key) patchRun(job.label, { progress: { ...r.progress, [job.variant]: msg.frac } });
      return;
    }
    release(slot);
    if (msg.type === "error") fail(job, msg.message);
    else finishVariant(job, msg.result);
    pump();
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    const job = slot.job;
    kill(slot);
    if (job) fail(job, "The simulation stopped unexpectedly, most likely out of memory. Try a shorter duration:.");
    pump();
  };
  return slot;
}

function release(slot: Slot) {
  if (slot.deadline) clearTimeout(slot.deadline);
  slot.deadline = null;
  slot.job = null;
}

function kill(slot: Slot) {
  release(slot);
  slot.w.terminate();
  slots.splice(slots.indexOf(slot), 1);
}

function fail(job: Job, message: string) {
  cancel(job.label);
  patchRun(job.label, { status: "error", error: message, stale: false, result: undefined, progress: {} });
  refreshReport();
}

function finishVariant(job: Job, result: RunResult) {
  const run = sGet().runs.get(job.label);
  if (!run || run.key !== job.key) return;
  const got = partial.get(job.label) ?? new Map<VariantName, RunResult>();
  got.set(job.variant, result);
  partial.set(job.label, got);
  const want = job.req.spec.variants;
  if (want.some((v) => !got.has(v))) {
    patchRun(job.label, { progress: { ...run.progress, [job.variant]: 1 } });
    return;
  }
  partial.delete(job.label);
  const parts = want.map((v) => got.get(v)!);
  const merged: RunResult = { firmware: parts[0].firmware, error: parts.find((p) => p.error)?.error, variants: parts.flatMap((p) => p.variants) };
  remember(job.key, merged);
  patchRun(job.label, { status: "done", result: merged, stale: false, error: undefined, progress: {}, ms: performance.now() - run.startedAt });
  refreshReport();
}

function pump() {
  while (queue.length) {
    let slot = slots.find((s) => !s.job);
    if (!slot) {
      if (slots.length >= POOL) return;
      slot = newSlot();
      slots.push(slot);
    }
    const job = queue.shift()!;
    slot.job = job;
    const s = slot;
    s.deadline = setTimeout(() => {
      if (s.job !== job) return;
      kill(s);
      fail(job, `The ${job.variant} run took longer than ${RUN_TIME_LIMIT_MS / 60_000} minutes and was stopped. Try a shorter duration:.`);
      pump();
    }, RUN_TIME_LIMIT_MS);
    const r = sGet().runs.get(job.label);
    if (r && r.status === "waiting") patchRun(job.label, { status: "running" });
    slot.w.postMessage(job.req);
  }
}

function cancel(label: string) {
  queue = queue.filter((j) => j.label !== label);
  partial.delete(label);
  for (const s of [...slots]) if (s.job?.label === label) kill(s);
}

// ---------- scheduling ----------

let scheduledModel: Model | null = null;

function start(def: ScenarioDef, model: Model, key: string, runs: Map<string, SimRun>) {
  const prev = runs.get(def.label);
  cancel(def.label);
  runs.set(def.label, { label: def.label, key, status: "waiting", progress: Object.fromEntries(def.spec.variants.map((v) => [v, 0])), result: prev?.result, stale: !!prev?.result, startedAt: performance.now() });
  for (const variant of def.spec.variants) {
    queue.push({ id: ++nextId, label: def.label, key, variant, req: { id: nextId, spec: def.spec, machine: model.machine!, designName: model.name, variant } });
  }
}

/** Queue runs for the scenarios whose inputs changed. */
function schedule(model: Model, force?: string) {
  scheduledModel = model;
  const defs = model.scenarios ?? [];
  const labels = new Set(defs.map((d) => d.label));
  const runs = new Map(sGet().runs);
  let selected = sGet().selected;
  for (const label of [...runs.keys()]) {
    if (labels.has(label)) continue;
    cancel(label);
    runs.delete(label);
    if (selected === label) selected = null;
  }
  const auto = sGet().auto;
  for (const def of defs) {
    const key = scenarioKey(def.spec, model.machine, model.name);
    const run = runs.get(def.label);
    if (run && run.key === key && force !== def.label && run.status !== "idle") continue;
    const hit = cache.get(key);
    if (hit && force !== def.label) {
      cancel(def.label);
      runs.set(def.label, { label: def.label, key, status: "done", progress: {}, result: hit, stale: false, startedAt: performance.now(), ms: 0 });
      continue;
    }
    if (!auto && force !== def.label && force !== "*") {
      if (run?.key !== key) {
        cancel(def.label);
        runs.set(def.label, { label: def.label, key, status: "idle", progress: {}, result: run?.result, stale: !!run?.result, startedAt: performance.now() });
      }
      continue;
    }
    start(def, model, key, runs);
  }
  if (!selected && defs.length) selected = defs[0].label;
  sSet({ runs, selected });
  pump();
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Schedule after typing settles, so a half-typed number does not start three runs. */
function scheduleSoon(model: Model) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    schedule(model);
    refreshReport();
  }, 700);
}

function scheduleNow() {
  const m = useDesign.getState().model;
  if (m) schedule(m);
  refreshReport();
}

/** Run one scenario now (or every scenario, with "*"), even when automatic runs are off. */
export function runScenarioNow(label: string | "*") {
  const m = useDesign.getState().model;
  if (!m) return;
  schedule(m, label);
  refreshReport();
}

// ---------- outcomes and check items ----------

const judged = new WeakMap<RunResult, Map<string, ExpectOutcome[]>>();

/** The scenario's expectations judged against its latest result (cached per result and expectation text). */
export function outcomesFor(def: ScenarioDef, result: RunResult | undefined): ExpectOutcome[] | null {
  if (!result) return null;
  let byText = judged.get(result);
  if (!byText) judged.set(result, (byText = new Map()));
  const sig = JSON.stringify(def.expects.map((e) => [e.label, e.level, e.text, e.env]));
  const hit = byText.get(sig);
  if (hit) return hit;
  const runs = result.variants.map((v) => ({ variant: v.variant, results: v.results, error: v.error ? `${v.stop}: ${v.error}` : undefined }));
  const out = result.error
    ? def.expects.map((e) => ({ label: e.label, level: e.level, status: "fail" as const, detail: result.error!, variants: [] }))
    : def.expects.map((e) => {
        const o: ExpectOutcome = judge(e, runs, def.spec.world.kind);
        const estimate = estimateOf(e.text, result);
        return estimate ? { ...o, estimate } : o;
      });
  byText.set(sig, out);
  return out;
}

/** Temperatures of motors with no thermal data are a guess: say so wherever an expectation leans on them. */
function estimateOf(text: string, r: RunResult): string | undefined {
  const motors = (pick(r.variants)?.summary.motors ?? []).filter((m) => m.heatGuess && new RegExp(`\\b${m.name}\\.(max_)?temp\\b`).test(text));
  if (!motors.length) return undefined;
  const names = motors.map((m) => m.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  return `Estimated: there is no published thermal data for ${list}, so ${names.length > 1 ? "their" : "its"} heating is a guess from ${names.length > 1 ? "their" : "its"} mass.`;
}

/** The estimate note, pointing at the design's own physical test for it when there is one. */
export function estimateNote(o: ExpectOutcome, tests?: { label: string }[]): string {
  if (!o.estimate) return "";
  const test = tests?.find((t) => /heat|temp|thermal/i.test(t.label));
  return test ? `${o.estimate} The “${test.label}” test confirms it.` : `${o.estimate} Measure it on the bench before relying on it.`;
}

export const SIM_ITEM = /^sim:/;

/** The report pass: the state of every scenario, its expectations as checks, and the brief uses they serve. */
export function simItems(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  let out = items.filter((i) => !SIM_ITEM.test(i.id));
  const defs = ctx.model.scenarios ?? [];
  if (!defs.length) return out;
  // the report can be re-composed for an older model while a newer one is still building: only the design's
  // current model schedules runs, or an older one would drop scenarios added since
  if (ctx.live && scheduledModel !== ctx.model && !timer && ctx.model === useDesign.getState().model) schedule(ctx.model);
  for (const def of defs) {
    const base = { category: "simulation" as const, basis: "virtual test" as const, uses: def.uses.length ? def.uses : undefined };
    const id = (s: string) => `sim:${def.label}:${s}`;
    const each = (status: CheckItem["status"], detail: string): CheckItem[] =>
      def.expects.length
        ? def.expects.map((e) => ({ ...base, id: id(e.label), status, title: `${def.label}: ${e.label}`, detail, span: e.span, level: e.level }))
        : [{ ...base, id: id("run"), status, title: `Simulation: ${def.label}`, detail, span: def.labelSpan }];
    if (!ctx.live) {
      out.push(...each("info", "The simulation runs once this work is merged into the design."));
      continue;
    }
    const run = sGet().runs.get(def.label);
    if (!run || run.status === "waiting" || run.status === "running") {
      const p = run ? Object.values(run.progress) : [];
      const pct = p.length ? Math.round((p.reduce((a, b) => a + (b ?? 0), 0) / p.length) * 100) : 0;
      out.push(...each("pending", `${run?.stale ? "Re-running" : "Running"} the simulation (${def.spec.variants.length} run${def.spec.variants.length > 1 ? "s" : ""})${pct ? `, ${pct} %` : ""}…`));
      continue;
    }
    if (run.status === "idle") {
      out.push(...each("pending", "Changed since the last run. Run it from the Simulation tab, or turn on automatic runs."));
      continue;
    }
    if (run.status === "error" || !run.result) {
      out.push({ ...base, id: id("run"), status: "fail", title: `Simulation runs: ${def.label}`, detail: run.error ?? "The simulation did not finish.", span: def.labelSpan });
      continue;
    }
    const outcomes = outcomesFor(def, run.result) ?? [];
    def.expects.forEach((e, i) => {
      const o = outcomes[i];
      const note = estimateNote(o, ctx.model.machine?.tests);
      out.push({ ...base, id: id(e.label), status: o.status, title: `${def.label}: ${e.label}`, detail: note ? `${o.detail} ${note}` : o.detail, span: e.span, level: e.level, margin: o.margin });
    });
    out.push(...healthItems(def, run.result));
  }
  return foldUses(out);
}

/** Problems the run itself found: firmware that does not compile, crashes or misuses pins. */
function healthItems(def: ScenarioDef, r: RunResult): CheckItem[] {
  const base = { category: "simulation" as const, basis: "virtual test" as const, span: def.labelSpan };
  const id = (s: string) => `sim:${def.label}:${s}`;
  if (r.error) return [{ ...base, id: id("run"), status: "fail", title: `Simulation runs: ${def.label}`, detail: r.error }];
  const out: CheckItem[] = [];
  const broken = r.variants.find((v) => v.error);
  if (broken) out.push({ ...base, id: id("firmware"), status: "fail", title: `Firmware runs in the simulation: ${def.label}`, detail: `${cap(broken.stop)}: ${broken.error}` });
  const main = pick(r.variants);
  if (main && main.faults.length) {
    out.push({ ...base, id: id("faults"), status: "warn", title: `Firmware mistakes in ${def.label}`, detail: main.faults.slice(0, 4).map((f) => `${f.msg}${f.count > 1 ? ` (${f.count} times)` : ""}`).join("; ") });
  }
  return out;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The variant the panel and checks lead with: expected, else the first. */
export function pick(vs: VariantRun[], want: VariantName = "expected"): VariantRun | undefined {
  return vs.find((v) => v.variant === want) ?? vs.find((v) => v.variant === "expected") ?? vs[0];
}

/** Brief uses a scenario serves count its expectations alongside their requirements. */
function foldUses(items: CheckItem[]): CheckItem[] {
  const sims = items.filter((i) => SIM_ITEM.test(i.id) && i.uses?.length);
  if (!sims.length) return items;
  return items.map((i) => {
    if (!i.id.startsWith("use:")) return i;
    const id = i.id.slice(4);
    const mine = sims.filter((s) => s.uses!.includes(id));
    if (!mine.length) return i;
    const linked = items.filter((x) => (x.category === "requirement" || SIM_ITEM.test(x.id)) && x.uses?.includes(id));
    return { ...i, ...useVerdict(id, linked) };
  });
}

// ---------- start-up and waiting ----------

let started = false;

/** Hook the runtime to the design engine: runs follow model changes, and the report pass adds their results. */
export function startSimRuntime() {
  if (started) return;
  started = true;
  if (import.meta.env?.DEV) (globalThis as { __kerfSim?: typeof useSim }).__kerfSim = useSim;
  registerReportPass("simulations", simItems, 30);
  useDesign.subscribe((s, prev) => {
    if (s.model && s.model !== prev.model && s.model !== scheduledModel) scheduleSoon(s.model);
  });
  const m = useDesign.getState().model;
  if (m) schedule(m);
  refreshReport();
}

/** Resolves when every scenario of the current design has a result or an error (or the wait times out). */
export function whenSimulated(timeoutMs = 600_000, labels?: string[]): Promise<void> {
  const done = () => {
    const m = useDesign.getState().model;
    if (!m) return false;
    if (timer || scheduledModel !== m) return false;
    return (m.scenarios ?? []).every((d) => (labels && !labels.includes(d.label)) || ["done", "error", "idle"].includes(sGet().runs.get(d.label)?.status ?? ""));
  };
  return new Promise((resolve) => {
    if (done()) return resolve();
    const finish = () => {
      clearTimeout(t);
      u1();
      u2();
      resolve();
    };
    const check = () => done() && finish();
    const u1 = useSim.subscribe(check);
    const u2 = useDesign.subscribe(check);
    const t = setTimeout(finish, timeoutMs);
  });
}

export { VARIANTS };
