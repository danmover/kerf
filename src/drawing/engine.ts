// Drawings in the app: lists the design's drawings (source blocks plus the
// automatic ones), projects their views in the kernel worker once the parts
// are built, and composes the sheet again as each view arrives. Exports and
// the assistant ask for finished sheets through sheetFor().

import { create } from "zustand";
import { meshes, useDesign } from "../core/engine";
import type { EvalPart, Model } from "../core/model";
import { evaluate } from "../lang/evaluator";
import { kernel, KernelCrashed } from "../kernel/client";
import type { ViewRequest, ViewResult } from "../kernel/drawing";
import { composeSheet } from "./compose";
import type { Sheet } from "./sheet";
import type { DrawingSpec } from "./spec";
import { autoDrawings, planDrawing, type DrawingPlan } from "./views";

export interface DrawingEntry {
  name: string;
  title: string;
  auto: boolean;
}

interface DrawingState {
  /** the drawing sheet is showing in place of the 3D view */
  open: boolean;
  list: DrawingEntry[];
  active: string | null;
  sheet: Sheet | null;
  /** views still being projected for the active sheet */
  pending: number;
  /** the sheet item a popover is open on, by shape key ("d3", "v1", "tb") */
  selected: string | null;
  theme: "blueprint" | "paper";
  /** sheet keys Claude was told about, highlighted until the drawing changes */
  asked: { name: string; key: string; text: string }[];
}

export const useDrawings = create<DrawingState>(() => ({
  open: false,
  list: [],
  active: null,
  sheet: null,
  pending: 0,
  selected: null,
  theme: "blueprint",
  asked: [],
}));

const get = useDrawings.getState;
const set = useDrawings.setState;

// ---------- projections ----------

/** finished projections by view key; a key covers the parts' geometry, so these stay valid */
const results = new Map<string, ViewResult>();
/**
 * Views that failed, or were drawn without parts the kernel had dropped.
 * They are shown but kept only until the design changes, then tried again.
 */
const transient = new Map<string, ViewResult | Error>();
const inflight = new Map<string, { promise: Promise<void>; cancel: () => void }>();
/** view keys a waiting export or the assistant still needs, so switching sheets doesn't cancel them */
const pinned = new Map<string, number>();
/** bumped when the kernel restarts, so answers from the old worker are dropped */
let generation = 0;
const MAX_RESULTS = 96;

function remember(key: string, r: ViewResult) {
  results.delete(key);
  results.set(key, r);
  while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
}

const resultOf = (key: string) => results.get(key) ?? transient.get(key);

/** A cancel or a kernel restart says nothing about the view, so neither is kept. */
const interrupted = (e: unknown) => e instanceof KernelCrashed || (e instanceof Error && e.message === "cancelled");

function project(key: string, req: ViewRequest, parts: EvalPart[]): Promise<void> {
  const running = inflight.get(key);
  if (running) return running.promise;
  const gen = generation;
  let job = kernel.project(req);
  const entry = { promise: Promise.resolve(), cancel: () => job.cancel() };
  entry.promise = (async () => {
    try {
      let r = await job.promise;
      if (r.missing?.length && gen === generation) {
        // the kernel dropped some solids (a cache trim): build them again and project once more
        const hashes = new Set(r.missing.map((i) => req.items[i]?.hash));
        const todo = [...new Map(parts.filter((p) => hashes.has(p.hash)).map((p) => [p.hash, p])).values()];
        await kernel.build(todo.map((p) => ({ hash: p.hash, recipe: p.recipe, label: p.label })), "preview", () => undefined, () => undefined).done;
        if (gen !== generation) return;
        job = kernel.project(req);
        r = await job.promise;
      }
      if (gen !== generation) return;
      if (r.missing?.length) transient.set(key, r);
      else remember(key, r);
    } catch (e) {
      if (gen !== generation || interrupted(e)) return;
      transient.set(key, e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (inflight.get(key) === entry) inflight.delete(key);
      schedule();
    }
  })();
  inflight.set(key, entry);
  return entry.promise;
}

const bboxOf = (p: EvalPart) => meshes.get(p.hash)?.bbox;
const volumeOf = (p: EvalPart) => meshes.get(p.hash)?.volume;

/** Every drawing of a model: its drawing blocks first, then the automatic ones. */
export function drawingSpecs(model: Model | null): DrawingSpec[] {
  if (!model) return [];
  return [...model.drawings, ...autoDrawings(model, bboxOf)];
}

/** The drawing that shows these parts: a part's own drawing, or the assembly's for several. */
export function drawingFor(model: Model, partNames: string[]): DrawingSpec | undefined {
  const specs = drawingSpecs(model);
  if (partNames.length === 1) return specs.find((s) => s.of.length === 1 && s.of[0] === partNames[0]);
  return specs.find((s) => !s.of.length) ?? specs.find((s) => partNames.every((n) => s.of.includes(n)));
}

/** The parts are built (or failed) so their views can be projected. */
function partsSettled(plan: DrawingPlan): boolean {
  const errors = useDesign.getState().buildErrors;
  return plan.parts.every((p) => meshes.has(p.hash) || errors.has(p.hash));
}

function compose(plan: DrawingPlan, model: Model): Sheet {
  const { source } = useDesign.getState();
  const reevaluate = useDesign.getState().model === model ? (overrides: Record<string, number>) => evaluate(source, { overrides }) : undefined;
  return composeSheet({ plan, model, result: resultOf, bboxOf, volumeOf, today: today(), reevaluate });
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Projects what a plan still needs; returns the keys being waited on. */
function request(plan: DrawingPlan): string[] {
  if (!partsSettled(plan)) return plan.views.map((v) => v.key);
  const waiting: string[] = [];
  for (const v of plan.views) {
    if (v.synthetic || resultOf(v.key)) continue;
    waiting.push(v.key);
    void project(v.key, v.req, plan.parts);
  }
  return waiting;
}

// ---------- the active sheet ----------

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule() {
  if (timer || !get().open) return;
  timer = setTimeout(() => {
    timer = null;
    refresh();
  }, 60);
}

function refresh(keepSelection = false) {
  const { model } = useDesign.getState();
  const specs = drawingSpecs(model);
  const list = specs.map((s) => ({ name: s.name, title: s.title, auto: !!s.auto }));
  const active = specs.some((s) => s.name === get().active) ? get().active : (specs[0]?.name ?? null);
  const spec = specs.find((s) => s.name === active);
  if (!model || !spec) {
    set({ list, active, sheet: null, pending: 0 });
    return;
  }
  const plan = planDrawing(spec, model, bboxOf);
  // views of other drawings or older revisions are no longer needed
  const keys = new Set(plan.views.map((v) => v.key));
  for (const [k, job] of inflight) if (!keys.has(k) && !pinned.has(k)) job.cancel();
  const waiting = request(plan);
  const sheet = compose(plan, model);
  const prev = get().sheet;
  const changed = !prev || prev.name !== sheet.name;
  set({ list, active, sheet, pending: waiting.length, selected: changed && !keepSelection ? null : get().selected });
}

let started = false;
function start() {
  if (started) return;
  started = true;
  let last = useDesign.getState();
  useDesign.subscribe((s) => {
    if (s.model !== last.model || s.buildErrors !== last.buildErrors) transient.clear();
    if (s.model !== last.model || s.meshVersion !== last.meshVersion || s.buildErrors !== last.buildErrors) schedule();
    if (s.model !== last.model) set({ asked: [] });
    last = s;
  });
  kernel.onReset(() => {
    generation++;
    results.clear();
    transient.clear();
    inflight.clear();
    schedule();
  });
}

export function openDrawings(name?: string) {
  start();
  set({ open: true, active: name ?? get().active, selected: null });
  refresh();
}

export function closeDrawings() {
  set({ open: false, selected: null });
}

export function showDrawing(name: string, opts: { keepSelection?: boolean } = {}) {
  set({ active: name, selected: opts.keepSelection ? get().selected : null });
  refresh(opts.keepSelection);
}

export function selectSheetItem(key: string | null) {
  set({ selected: key });
}

export function setDrawingTheme(theme: DrawingState["theme"]) {
  set({ theme });
}

export function markAsked(name: string, key: string, text: string) {
  set({ asked: [...get().asked.filter((a) => !(a.name === name && a.key === key)), { name, key, text }] });
}

/**
 * A finished sheet for a drawing (all views projected), for exports and the
 * assistant. Waits for the parts to build first; the signal stops the wait.
 */
export async function sheetFor(name?: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Sheet> {
  start();
  const { timeoutMs = 90_000, signal } = opts;
  const t0 = Date.now();
  const stopped = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }));
  stopped.catch(() => undefined);
  const until = <T,>(p: Promise<T>) => (signal ? Promise.race([p, stopped]) : p);
  const held: string[] = [];
  const hold = (keys: string[]) => {
    for (const k of keys) {
      pinned.set(k, (pinned.get(k) ?? 0) + 1);
      held.push(k);
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("Stopped");
      const { model, stage } = useDesign.getState();
      if (!model) throw new Error("There is no design yet");
      const specs = drawingSpecs(model);
      const spec = name ? specs.find((s) => s.name === name || s.title.toLowerCase() === name.toLowerCase() || s.name === `auto:${name}`) : specs[0];
      if (!spec) throw new Error(`There is no drawing called "${name}". Drawings: ${specs.map((s) => s.name).join(", ") || "none"}`);
      const plan = planDrawing(spec, model, bboxOf);
      if (partsSettled(plan) && stage !== "evaluating") {
        const waiting = request(plan);
        hold(waiting);
        await until(Promise.all(waiting.map((k) => inflight.get(k)?.promise)));
        // a newer revision may have arrived, or a view been interrupted, while waiting
        if (useDesign.getState().model === model && request(plan).length === 0) return compose(planDrawing(spec, model, bboxOf), model);
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("The drawing's parts did not finish building in time");
      await until(new Promise((r) => setTimeout(r, 150)));
    }
  } finally {
    for (const k of held) {
      const n = (pinned.get(k) ?? 1) - 1;
      if (n > 0) pinned.set(k, n);
      else pinned.delete(k);
    }
  }
}

/** Finished sheets for every drawing of the design. */
export async function allSheets(): Promise<Sheet[]> {
  const specs = drawingSpecs(useDesign.getState().model);
  const out: Sheet[] = [];
  for (const s of specs) out.push(await sheetFor(s.name));
  return out;
}

/** A line for the assistant's context note while the user has a drawing open. */
export function drawingContext(): string {
  const { open, sheet } = get();
  if (!open || !sheet) return "";
  return `The user is looking at the drawing "${sheet.title}" (${sheet.name}${sheet.auto ? ", automatic" : ""}). Use view_drawing to see it.`;
}
