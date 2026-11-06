// Runs the bench in the app, with the user's own key: each case in a project
// of its own, made from its template and deleted afterwards, so the user's
// designs and chats are never touched. Claude works exactly as it does for the
// user (routing, speed, review), and a question it asks is answered with its
// own recommendation. The project that was open is opened again at the end.
// Lessons are left out, so one user's saved rules neither steer the run nor
// grow from it. A comparison runs every case under each set-up in turn (a
// model, the slimmer prompt), so the set-ups meet the same API conditions.

import { create } from "zustand";
import { createProject, deleteProject, openProject, closeProject, useProject } from "../app/project";
import { useSettings, updateSettings, BENCH_RESTORE_KEY, type ModelId, type Settings } from "../app/settings";
import { useDesign, whenChecked, meshes } from "../core/engine";
import { buildChecksRequest } from "../core/checks";
import { kernel } from "../kernel/client";
import { useChat, sendMessage, choose, stop, type ChatItem } from "../ai/chat";
import { asksState, remeasure } from "../ai/asks";
import { kernelGeo } from "../ai/tools";
import type { GeoQuery } from "../lang/values";
import type { TurnSpend } from "../ai/spend";
import { grade, type Mark } from "./grade";
import type { BenchCase } from "./cases";

export interface CaseResult {
  id: string;
  title: string;
  kind: BenchCase["kind"];
  message: string;
  passed: boolean;
  marks: Mark[];
  seconds: number;
  cost: number;
  /** API requests of every kind (designer, router, reviewer, agents) */
  requests: number;
  outputTokens: number;
  models: string[];
  /** Claude's own checklist at the end */
  asks: { pass: number; fail: number; open: number; error: number };
  reviews: number;
  /** questions Claude asked, answered with its own recommendation */
  questions: number;
  reply: string;
  error?: string;
  /** the set-up it ran under, in a comparison */
  setup?: string;
}

/** One way of running Claude that a comparison measures. */
export interface BenchSetup {
  id: string;
  label: string;
  model: ModelId;
  leanPrompt: boolean;
}

/** What a comparison measures: today's prompt against the slimmer one, and Opus against Sonnet. */
export const COMPARE: BenchSetup[] = [
  { id: "opus", label: "Opus 5.5", model: "claude-opus-5-5", leanPrompt: false },
  { id: "opus-lean", label: "Opus 5.5, slimmer prompt", model: "claude-opus-5-5", leanPrompt: true },
  { id: "sonnet", label: "Sonnet 5.5", model: "claude-sonnet-5-5", leanPrompt: false },
];

export interface BenchRun {
  started: number;
  finished?: number;
  model: string;
  effort: string;
  speed: string;
  cases: CaseResult[];
  cancelled?: boolean;
  /** a comparison's set-ups, each case run under every one */
  setups?: BenchSetup[];
}

interface BenchState {
  running: boolean;
  /** the case in hand, by number from 1 */
  at: number;
  total: number;
  current: string;
  run: BenchRun | null;
}

export const useBench = create<BenchState>(() => ({ running: false, at: 0, total: 0, current: "", run: null }));

let cancelled = false;

export function cancelBench() {
  if (!useBench.getState().running) return;
  cancelled = true;
  stop();
}

const MAX_QUESTIONS = 3;

/** Wait until the chat has loaded the given project's (empty) conversation. */
function chatFor(projectId: string, ms = 5000): Promise<void> {
  if (useChat.getState().projectId === projectId) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    const off = useChat.subscribe((s) => s.projectId === projectId && done());
    function done() {
      clearTimeout(t);
      off();
      resolve();
    }
  });
}

/** Geometric quantities and every part's box, for marking. */
async function measureAll(queries: GeoQuery[]) {
  const s = useDesign.getState();
  if (!s.model) return { geo: {}, geoErrors: {} };
  const req = buildChecksRequest(s.model, new Set(s.model.parts.map((p) => p.hash).filter((h) => meshes.has(h))));
  return kernel.checks({ ...req, queries, access: [], envelopes: [] });
}

const failingNow = () => (useDesign.getState().report?.items ?? []).filter((c) => c.status === "fail").map((c) => ({ id: c.id, title: c.title }));

function spendOf(items: ChatItem[]) {
  let cost = 0;
  let requests = 0;
  let output = 0;
  const models = new Set<string>();
  for (const it of items) {
    if (it.kind !== "cost") continue;
    const s: TurnSpend = it.spend;
    cost += s.cost;
    output += s.output;
    for (const lines of Object.values(s.byKind)) for (const l of lines ?? []) {
      requests += l.requests;
      models.add(l.model);
    }
  }
  return { cost, requests, output, models: [...models] };
}

async function runCase(c: BenchCase): Promise<CaseResult> {
  const base: CaseResult = { id: c.id, title: c.title, kind: c.kind, message: c.message, passed: false, marks: [], seconds: 0, cost: 0, requests: 0, outputTokens: 0, models: [], asks: { pass: 0, fail: 0, open: 0, error: 0 }, reviews: 0, questions: 0, reply: "" };
  const p = await createProject(c.template, `Bench: ${c.title}`);
  try {
    await openProject(p.id);
    await chatFor(p.id);
    const ready = await whenChecked(180_000);
    const startSource = ready.source;
    const startFailing = new Set(failingNow().map((f) => f.id));
    const t0 = performance.now();
    await sendMessage(c.message);
    let questions = 0;
    while (!cancelled && questions < MAX_QUESTIONS) {
      const pending = useChat.getState().pendingChoice;
      const card = pending && useChat.getState().items.find((i): i is Extract<ChatItem, { kind: "choice" }> => i.id === pending.itemId && i.kind === "choice");
      if (!card) break;
      const pick = card.options.find((o) => o.recommended) ?? card.options[0];
      questions++;
      await choose(card.id, pick.label);
    }
    const done = await whenChecked(180_000);
    const seconds = (performance.now() - t0) / 1000;
    const items = useChat.getState().items;
    const reply = [...items].reverse().find((i): i is Extract<ChatItem, { kind: "assistant" }> => i.kind === "assistant" && !!i.text.trim())?.text ?? "";
    // Claude's own checklist, measured on the final design
    const a = asksState().asks.length ? await remeasure({ source: done.source, model: done.model }, kernelGeo) : asksState();
    const asks = { pass: 0, fail: 0, open: 0, error: 0 };
    for (const r of a.results) asks[r.status]++;
    const marks = await grade(c, {
      startSource,
      source: done.source,
      model: done.model,
      startFailing,
      failing: failingNow(),
      buildErrors: done.buildErrors.size,
      reply,
      measure: measureAll,
    });
    const spend = spendOf(items);
    return {
      ...base,
      passed: marks.every((m) => m.ok),
      marks,
      seconds,
      cost: spend.cost,
      requests: spend.requests,
      outputTokens: spend.output,
      models: spend.models,
      asks,
      reviews: items.filter((i) => i.kind === "review").length,
      questions,
      reply: reply.slice(0, 600),
      error: items.some((i) => i.kind === "notice" && i.level === "error") ? items.filter((i): i is Extract<ChatItem, { kind: "notice" }> => i.kind === "notice" && i.level === "error").map((n) => n.title).join("; ") : undefined,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await deleteProject(p.id).catch(() => undefined);
  }
}

/** The settings a run changes, as they were before it. */
type Changed = Pick<Settings, "model" | "leanPrompt" | "useLessons">;

/**
 * Run the cases one after another, each under every set-up given (or as set), and return what they scored.
 * Throws when the chat is busy. The settings it changes are put back at the end.
 */
export async function runBench(cases: BenchCase[], setups: BenchSetup[] = []): Promise<BenchRun> {
  if (useBench.getState().running) throw new Error("The bench is already running.");
  if (useChat.getState().busy) throw new Error("Claude is working on something. Wait for it to finish, then run the bench.");
  const was = useProject.getState().current?.id ?? null;
  const s = useSettings.getState();
  const before: Changed = { model: s.model, leanPrompt: s.leanPrompt, useLessons: s.useLessons };
  try {
    localStorage.setItem(BENCH_RESTORE_KEY, JSON.stringify(before));
  } catch {
    /* storage blocked: the settings are still put back at the end of the run */
  }
  const ways: (BenchSetup | null)[] = setups.length ? setups : [null];
  const run: BenchRun = { started: Date.now(), model: s.model, effort: s.effort, speed: s.speed, cases: [], setups: setups.length ? setups : undefined };
  cancelled = false;
  useBench.setState({ running: true, at: 0, total: cases.length * ways.length, current: "", run });
  try {
    let at = 0;
    for (const c of cases) {
      for (const w of ways) {
        if (cancelled) break;
        updateSettings({ useLessons: false, ...(w ? { model: w.model, leanPrompt: w.leanPrompt } : {}) });
        useBench.setState({ at: ++at, current: w ? `${c.title} (${w.label})` : c.title });
        run.cases.push({ ...(await runCase(c)), ...(w ? { setup: w.id } : {}) });
        useBench.setState({ run: { ...run, cases: [...run.cases] } });
      }
      if (cancelled) break;
    }
  } finally {
    updateSettings(before);
    try {
      localStorage.removeItem(BENCH_RESTORE_KEY);
    } catch {
      /* nothing to put back */
    }
    run.finished = Date.now();
    run.cancelled = cancelled || undefined;
    useBench.setState({ running: false, current: "", run: { ...run } });
    if (was && useProject.getState().projects.some((p) => p.id === was)) await openProject(was);
    else await closeProject();
  }
  return run;
}
