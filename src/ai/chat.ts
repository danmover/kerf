// The design assistant: a streaming tool-use loop against the Claude API,
// run from the browser with the user's own API key (see client.ts for where requests go).

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaContentBlockParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { create } from "zustand";
import { sessionEnded } from "../cloud/account";
import * as db from "../persist/db";
import { updateSettings, useSettings, type Settings } from "../app/settings";
import { useDesign, evaluateOnly, whenChecked } from "../core/engine";
import { whenWiringChecked } from "../machine/harness/runtime";
import { useView } from "../app/view";
import { drawingContext } from "../drawing/engine";
import { commitSource, useProject, endPreview } from "../app/project";
import { systemPrompt } from "./prompt";
import { TOOL_DEFS, TOOL_TITLES, runTool, kernelGeo, modelSummary, reportSummary, briefSummary, type AskOption, type ToolOutcome } from "./tools";
import { paramEdits, upsertDecision, applySpanEdits, type SetMap } from "../core/decisions";
import { fmtNum } from "../lang/values";
import { shotOf, changeShots, type ChangeShots } from "../app/changeShots";
import { spotText, type SpotRef } from "../app/spot";
import { runQuick } from "../app/quickRun";
import { usePlan, loadPlan, resetPlan, planSnapshot, takeMainSteering, takePauseHit, mainActivityStart, mainActivityEnd, settleActivity, noteDesignEdit, pendingSteering, describeSteering, anyBranchOpen, userMessage, userWithdrawMessage, messageState } from "./plan";
import { appDeps, currentBrief as reviewBrief, designerReport, registerBriefProvider, ReviewError, ReviewInput, ReviewSession, runReview, type Finding, type ReviewProgress, type ReviewResult } from "./review";
import { shrinkImage } from "./review/renders";
import { isSubstantial } from "./review/gate";
import { assetBlock } from "../persist/assets";
import { briefChanges, briefData, briefHasErrors, emptyBrief, writeBrief, type BriefData } from "../core/brief";
import { isBuilding, relayToAgents } from "../agents/orchestrator";
import { toast } from "../app/ui";
import { claudeClient, claudeRoute } from "./client";
import { isOpenAIModel } from "./openai";
import { BINDING_BETA, MAX_CUT_RECOVERIES, MAX_OUTPUT_TOKENS, bindingKey, cutOffNote, trimCutOff, firstEdit, forSaving, hasThinking, isThinkingSignatureError, messageKeys, prepareSaved, stripThinking } from "./history";
import { MODELS, type Effort } from "../app/settings";
import { QUICK_EFFORT, QUICK_MAX_STEPS, QUICK_MODEL, QUICK_TOOLS, QUICK_WARM_MS, askRouter, quickCanSave, ruleReason, smallChange, type Route, type TurnFacts } from "./routing";
import { addToTurn, carryOver, counterfactualCost, emptyTurn, onSpend, promptTokens, recordSpend, type TurnSpend } from "./spend";
import { configureWarm, requestFailed, requestFinished, requestStarted, stopWarm } from "./keepWarm";
import { pause, retryWait } from "./retry";
import { COMPACT_BETA, COMPACT_INSTRUCTIONS, MIN_COMPACT_AT, RETRY_GROWTH, SUMMARY_INPUT_MAX, afterCut, compactionUsage, cutPoints, hasCompaction, keepTokens, messageTokens, planCut, planOutline, promptTooLong, userMessagesText, type Cut } from "./compact";
import { costOf, roughTokens, type Usage } from "../agents/pricing";
import { STEP_EFFORT_BETA, hasEffortMarks, indexAfter, markEffort, messageBefore, stepEffort, thoroughEffort, withoutEffortMarks } from "./stepEffort";
import { asksState, beginAsks, clearAsks, remeasure, type AskResult } from "./asks";
import { lessonsPrompt } from "./lessons";
import { REFERENCE_TOOL } from "./leanReference";
import { webTools, webActivity, describeWebCall, citedSources, isWebTool, isPausedTurn, flattenServerTools, echoContent, isWebToolError, isServerBlockError, type WebActivity } from "./web";

/** A file the user attached to a message; it is also kept as a reference in the brief. */
export interface ChatFile {
  asset: string;
  kind: "image" | "pdf";
  name: string;
  /** reference id in the brief */
  ref?: string;
}

export type ChatItem =
  /** midRun: sent while Claude worked; it joined that run at its next step instead of starting a turn */
  /** optionsFirst: the user asked Claude to lay out options before building */
  | { kind: "user"; id: string; text: string; ts: number; files?: ChatFile[]; spot?: SpotRef; image?: string; midRun?: boolean; optionsFirst?: boolean }
  /** started: when the step began, for the live "Thinking" line; thoughtMs: how long Claude thought before it wrote or acted */
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean; model?: string; note?: string; sources?: { url: string; title: string }[]; started?: number; thoughtMs?: number }
  /** ran: when Kerf started running the tool; ms: how long it took */
  | { kind: "tool"; id: string; toolUseId: string; name: string; status: "running" | "done" | "error"; title: string; detail?: string; diff?: { before: string; after: string }; image?: string; inputChars?: number; link?: { url: string; label: string }; web?: boolean; ran?: number; ms?: number }
  | {
      kind: "choice";
      id: string;
      toolUseId: string;
      title?: string;
      question: string;
      options: AskOption[];
      chosen?: string;
      /** the option's values as applied, after any the user adjusted */
      values?: SetMap;
      /** what the user added for Claude when choosing */
      note?: string;
      /** the decision block that records the answer */
      decision?: string;
    }
  | { kind: "notice"; id: string; level: "error" | "warn" | "info"; title: string; detail?: string; action?: "settings" | "retry" | "continue" }
  | { kind: "turn"; id: string; before: string; after: string; edits: number; reverted?: boolean; shots?: ChangeShots }
  /**
   * A plain command done at once without Claude ("fillet 2", "hole M3 here"):
   * what it did, the source either side for undo, and why the part failed to
   * build when it did. plain: undo and redo themselves, which have no undo.
   */
  | { kind: "quick"; id: string; text: string; title: string; detail?: string; before: string; after: string; spot?: SpotRef; undone?: boolean; failed?: string; plain?: boolean }
  | {
      kind: "review";
      id: string;
      /** run by Kerf after a substantial change, rather than asked for by Claude */
      auto: boolean;
      round: number;
      status: "running" | "done" | "error";
      progress?: { stage: ReviewProgress["stage"]; detail?: string; views: string[] };
      result?: ReviewResult;
      /** small contact sheet kept in saved history when the full renders are dropped */
      thumb?: string;
      error?: string;
    }
  /** follow-ups Claude offers as one-click chips */
  | { kind: "suggest"; id: string; options: { label: string; prompt: string }[] }
  /** what the user asked for in a message, as Kerf last measured it (see asks.ts) */
  | { kind: "asks"; id: string; asks: AskResult[]; unasked: string[] }
  /** what a turn cost, which model answered it and why, and what Kerf saved */
  | {
      kind: "cost";
      id: string;
      spend: TurnSpend;
      route: TurnRoute;
      /** the conversation's length before Claude's first response this turn, so the turn can be asked again */
      historyStart: number;
    };

/** How a turn was routed, as shown under the reply. */
export interface TurnRoute {
  /** the model the turn started on */
  model: string;
  quick: boolean;
  why: string;
  by: Route["by"];
  /** the quick model handed the turn to the design model, and why */
  escalated?: { to: string; why: string };
}

interface ChatState {
  projectId: string | null;
  items: ChatItem[];
  busy: boolean;
  /** a choice card waiting for the user, with the results of tools that ran beside it */
  pendingChoice: { toolUseId: string; itemId: string; results: BetaToolResultBlockParam[] } | null;
  lastUserText: string;
  /** the brief as Claude last saw it (JSON), so the next turn can say what the user changed */
  briefSeen: string | null;
  /** deciding which model answers the message just sent */
  routing: boolean;
}

export const useChat = create<ChatState>(() => ({ projectId: null, items: [], busy: false, pendingChoice: null, lastUserText: "", briefSeen: null, routing: false }));

const get = useChat.getState;
const set = useChat.setState;

let history: BetaMessageParam[] = [];
/**
 * What the last request sent: the system prompt and tools, and a fingerprint
 * of each message. The next request must only append to it, or the thinking
 * blocks after the first changed message are rejected (see ./history).
 */
let sent: { binding: string; keys: string[] } | null = null;
/** The API said a request without the web tools can't carry earlier web results: send them as notes (the history keeps them). */
let flatServer = false;
let abort: AbortController | null = null;
/** bumped whenever the chat leaves its project or is cleared, so a loop still finishing leaves the new state alone */
let gen = 0;
let lastEditedSource: string | null = null;
/** the source as Claude last read or wrote it (get_design, its own edits, or the context note); null when it has not */
let sourceSeen: string | null = null;
/** changes the user made with plain commands since Claude's last turn, for the next context note */
let quickLog: string[] = [];
/** a design up to this long goes with the user's message when Claude has not seen it, which saves a get_design step */
const INLINE_SOURCE_MAX = 16_000;
let idn = 0;
const nid = () => `c${Date.now().toString(36)}${(++idn).toString(36)}`;
type Feature = "effort" | "thinking" | "fallbacks" | "binding" | "stepEffort";
/** request features each model rejected this session */
const rejected = new Map<string, Set<Feature>>();
const unsupported = (model: string) => {
  let s = rejected.get(model);
  if (!s) rejected.set(model, (s = new Set()));
  return s;
};
/** Whether requests to a model can carry effort marks (see stepEffort): they need effort and thinking on. */
const marksOn = (off: ReadonlySet<Feature>) => !off.has("stepEffort") && !off.has("effort") && !off.has("thinking");
/** this key can't use web search: no request offers it for the rest of the session (it is the same for every model) */
let webUnavailable = false;
/** a paused server-tool turn is resumed this many times in a row before Claude stops and says so */
const MAX_PAUSE_RESUMES = 5;


const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function patch(id: string, fn: (it: ChatItem) => ChatItem) {
  flushDeltas();
  set((s) => ({ items: s.items.map((it) => (it.id === id ? fn(it) : it)) }));
}
function push(it: ChatItem) {
  flushDeltas();
  set((s) => ({ items: [...s.items, it] }));
}

// ---------- streaming deltas ----------
// Claude streams a few characters at a time. Each change to the chat copies
// the item list and redraws the panel, so deltas wait for the next frame and
// land together: one update per frame rather than one per token keeps a long
// chat smooth while Claude writes. Anything else that changes the chat (and
// the end of every response) applies the waiting deltas first.

const pendingDeltas = new Map<string, { text: string; thinking: string; inputChars: number }>();
let flushTimer: { raf?: number; timeout?: ReturnType<typeof setTimeout> } | null = null;

function queueDelta(id: string, d: { text?: string; thinking?: string; inputChars?: number }) {
  let p = pendingDeltas.get(id);
  if (!p) pendingDeltas.set(id, (p = { text: "", thinking: "", inputChars: 0 }));
  p.text += d.text ?? "";
  p.thinking += d.thinking ?? "";
  p.inputChars += d.inputChars ?? 0;
  if (flushTimer) return;
  // a hidden tab draws no frames: a timer still lets the text land
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  if (typeof requestAnimationFrame === "function" && visible) flushTimer = { raf: requestAnimationFrame(() => flushDeltas()) };
  else flushTimer = { timeout: setTimeout(() => flushDeltas(), visible ? 32 : 250) };
}

/** Apply every streamed delta still waiting for a frame. */
export function flushDeltas() {
  if (flushTimer) {
    if (flushTimer.raf !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(flushTimer.raf);
    if (flushTimer.timeout !== undefined) clearTimeout(flushTimer.timeout);
    flushTimer = null;
  }
  if (!pendingDeltas.size) return;
  const batch = new Map(pendingDeltas);
  pendingDeltas.clear();
  const now = Date.now();
  set((s) => ({
    items: s.items.map((it) => {
      const d = batch.get(it.id);
      if (!d) return it;
      if (it.kind === "assistant") {
        // the first words of the answer end the thinking
        const thoughtMs = it.thoughtMs ?? (d.text && (it.thinking || d.thinking) && it.started ? now - it.started : undefined);
        return { ...it, text: it.text + d.text, thinking: it.thinking + d.thinking, ...(thoughtMs !== undefined ? { thoughtMs } : {}) };
      }
      if (it.kind === "tool") return { ...it, inputChars: (it.inputChars ?? 0) + d.inputChars };
      return it;
    }),
  }));
}

// ---------- spend ----------

/** what the turn in progress has cost so far; null between turns */
let turnBox: { spend: TurnSpend } | null = null;

onSpend((kind, model, cost, saved, u) => {
  if (turnBox) {
    turnBox.spend = addToTurn(turnBox.spend, kind, model, cost, saved, u);
    return;
  }
  // between turns (keeping the cache warm, an agent revised from its card): it belongs to the latest reply
  const last = [...get().items].reverse().find((i) => i.kind === "cost");
  if (!last) return;
  patch(last.id, (it) => (it.kind === "cost" ? { ...it, spend: addToTurn(it.spend, kind, model, cost, saved, u) } : it));
  persist();
});

configureWarm({
  // the shared key runs one request at a time: a refresh would hold the slot a chat message needs
  client: () => (claudeRoute() === "shared" || isOpenAIModel(useSettings.getState().model) ? null : client()),
  minutes: () => useSettings.getState().keepWarm,
  // a refresh is spend the design model alone would not have had; what it saves shows on the next request
  record: (model, u) => void recordSpend("warm", model, u, -costOf(model, u)),
  // after a change of model, effort or thinking display in Settings, the next request is not the one kept warm
  stale: (p) => {
    const s = useSettings.getState();
    const effort = (p.output_config as { effort?: string } | undefined)?.effort;
    const display = (p.thinking as { display?: string } | undefined)?.display;
    return p.model !== s.model || (effort !== undefined && effort !== s.effort) || (display !== undefined && display !== (s.showThinking ? "summarized" : "omitted"));
  },
});

// ---------- persistence ----------

export async function loadChat(projectId: string) {
  stopLoop();
  flushPersist();
  const g = gen;
  const rec = await db.getOne<db.ChatRecord>("chats", projectId).catch(() => undefined);
  if (g !== gen) return; // another project was opened, or the chat cleared, meanwhile
  history = (rec?.history as BetaMessageParam[]) ?? [];
  // thinking blocks saved under an older Kerf, or after messages Claude saw differently, can't be sent again
  const binding = currentBinding();
  const removed = prepareSaved(history, rec ?? {}, binding);
  if (removed) console.info(`[kerf] Reopened chat: left out ${removed} earlier thinking block(s) that no longer match this conversation.`);
  sent = { binding, keys: messageKeys(history) };
  flatServer = false;
  const savedPending = (rec as { pending?: ChatState["pendingChoice"] } | undefined)?.pending ?? null;
  const briefSeen = (rec as { briefSeen?: string | null } | undefined)?.briefSeen ?? null;
  const items = ((rec?.items as ChatItem[]) ?? []).map((it) =>
    it.kind === "assistant" ? { ...it, streaming: false } : (it.kind === "tool" || it.kind === "review") && it.status === "running" ? { ...it, status: "error" as const, detail: "Interrupted", error: "Interrupted" } : it,
  );
  lastEditedSource = sourceSeen = null;
  quickLog = [];
  clearAsks();
  asksCard = "";
  readChatSetup();
  // a choice card left open in a previous session is still answerable
  const open = savedPending && items.some((i) => i.id === savedPending.itemId && i.kind === "choice" && !i.chosen) ? savedPending : null;
  set({ projectId, items, busy: false, pendingChoice: open, briefSeen });
  quietly(() => loadPlan((rec as { plan?: unknown } | undefined)?.plan));
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: (() => void) | null = null;
function persist() {
  // what is saved is taken now, so a save that lands after the chat moves to another project still writes this one
  const { projectId, items, pendingChoice, briefSeen } = get();
  if (!projectId) return;
  const saved = history.slice();
  const sentNow = sent;
  const plan = planSnapshot();
  pendingSave = () => {
    // keep stored history small: images are dropped, the text around them stays,
    // and the record notes from where thinking blocks no longer match what Claude saw
    const { history: slimHistory, validBefore } = forSaving(saved, sentNow?.keys ?? null, stripImages);
    const turns = items.filter((it) => it.kind === "turn" && it.shots);
    const keepShots = new Set(turns.slice(-12).map((it) => it.id));
    const marked = items.filter((it) => it.kind === "user" && it.image);
    const keepMarks = new Set(marked.slice(-6).map((it) => it.id));
    const slimItems = items
      .slice(-400)
      .map((it) =>
        it.kind === "tool" && it.image ? { ...it, image: undefined } : it.kind === "review" ? slimReview(it) : it.kind === "turn" && it.shots && !keepShots.has(it.id) ? { ...it, shots: undefined } : it.kind === "user" && it.image && !keepMarks.has(it.id) ? { ...it, image: undefined } : it,
      );
    void db.put<db.ChatRecord & { pending: ChatState["pendingChoice"]; plan: unknown; briefSeen: string | null }>("chats", { projectId, items: slimItems, history: slimHistory, binding: sentNow?.binding, validBefore, pending: pendingChoice, plan, briefSeen, updatedAt: Date.now() }).catch(() => undefined);
  };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPersist, 400);
}

function flushPersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const save = pendingSave;
  pendingSave = null;
  save?.();
}

function dropPendingSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  pendingSave = null;
}

/** Stop the running loop for good; whatever it was doing no longer reaches this chat. */
function stopLoop() {
  stopWarm();
  lastPrompt = refusedAt = compactFailedAt = 0;
  quickTouched = 0;
  lastBreak.clear();
  if (get().busy) persist();
  gen++;
  redirect = false;
  abort?.abort();
  abort = null;
  if (get().busy) set({ busy: false });
}

// leaving a project stops Claude's work on it
useProject.subscribe((s, prev) => {
  const left = prev.current?.id;
  if (!left || s.current?.id === left || get().projectId !== left) return;
  stopLoop();
  flushPersist();
});

// the plan is saved with the conversation it belongs to
let planQuiet = false;
function quietly(fn: () => void) {
  planQuiet = true;
  try {
    fn();
  } finally {
    planQuiet = false;
  }
}
usePlan.subscribe(() => {
  if (!planQuiet) persist();
});

// a change the user makes to the design while Claude works reaches Claude like a plan change
useProject.subscribe((s, prev) => {
  const v = s.versions[s.versions.length - 1];
  if (!v || v === prev.versions[prev.versions.length - 1] || s.current?.id !== prev.current?.id) return;
  if (v.author === "you" && get().busy) noteDesignEdit(v.message);
});

/** The user's plan changes and messages since the last tool boundary, as a text block for the next request. */
function steering(): { type: "text"; text: string }[] {
  const text = takeMainSteering();
  return text ? [{ type: "text", text }] : [];
}
/** The steering includes a message the user typed (not only plan changes). */
const hasMessage = (blocks: { text: string }[]) => blocks.some((b) => b.text.startsWith("<user-messages>"));

export async function clearChat() {
  stopLoop();
  dropPendingSave();
  history = [];
  sent = null;
  flatServer = false;
  lastEditedSource = sourceSeen = null;
  quickLog = [];
  clearAsks();
  asksCard = "";
  readChatSetup();
  set({ items: [], busy: false, pendingChoice: null, briefSeen: null });
  quietly(resetPlan);
  const { projectId } = get();
  if (projectId) await db.remove("chats", projectId).catch(() => undefined);
}

/** Drop the open chat entirely (closing all data, or deleting its project). */
export function resetChat() {
  stopLoop();
  dropPendingSave();
  history = [];
  sent = null;
  flatServer = false;
  lastEditedSource = sourceSeen = null;
  quickLog = [];
  clearAsks();
  asksCard = "";
  readChatSetup();
  set({ projectId: null, items: [], busy: false, pendingChoice: null, briefSeen: null });
  quietly(resetPlan);
}

const OMITTED = { type: "text" as const, text: "[image omitted from saved history]" };
const heavy = (c: { type: string }) => c.type === "image" || c.type === "document";
const FILE_NOTE = "[image or file not kept in saved history; an attached reference can be seen again with view_reference]";

/** A copy of a message with pictures and files replaced by a note, or the same object when it has none. */
function stripImages(m: BetaMessageParam): BetaMessageParam {
  if (typeof m.content === "string") return m;
  const has = (b: BetaContentBlockParam) => heavy(b) || (b.type === "tool_result" && Array.isArray(b.content) && b.content.some(heavy));
  if (!m.content.some(has)) return m;
  return {
    ...m,
    content: m.content.map((b) => {
      if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map((c) => (heavy(c) ? OMITTED : c)) };
      if (heavy(b)) return { type: "text" as const, text: FILE_NOTE };
      return b;
    }),
  };
}

// History is append-only (see below), but a long session would otherwise send
// every render and attachment with each request, and a request has a size and
// image limit. Past HEAVY_MAX pictures and files, the oldest give way to a note
// until HEAVY_KEEP remain; buildRequest then leaves out the thinking this
// invalidates. Trimming in batches keeps the cached prefix stable in between.
const HEAVY_MAX = 30;
const HEAVY_KEEP = 20;
const HEAVY_BYTES = 18_000_000;
const DROPPED = "[older image or file dropped to keep the conversation small; an attached reference can be seen again with view_reference]";
const heavySize = (c: unknown) => (c as { source?: { data?: string } }).source?.data?.length ?? 0;

function capHeavy() {
  const found: { m: number; b: number; c: number; size: number }[] = [];
  history.forEach((msg, m) => {
    if (typeof msg.content === "string") return;
    msg.content.forEach((b, bi) => {
      if (b.type === "tool_result" && Array.isArray(b.content)) b.content.forEach((c, ci) => heavy(c) && found.push({ m, b: bi, c: ci, size: heavySize(c) }));
      else if (heavy(b)) found.push({ m, b: bi, c: -1, size: heavySize(b) });
    });
  });
  if (found.length <= HEAVY_MAX && found.reduce((n, f) => n + f.size, 0) <= HEAVY_BYTES) return;
  // the newest turn keeps everything it carries; older ones keep their newest pictures while they fit
  const newest = history.length - 1;
  const drop = new Map<number, Set<string>>();
  let kept = 0;
  let bytes = 0;
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i];
    if (f.m === newest || (kept < HEAVY_KEEP && bytes + f.size <= HEAVY_BYTES / 2)) {
      kept++;
      bytes += f.size;
      continue;
    }
    if (!drop.has(f.m)) drop.set(f.m, new Set());
    drop.get(f.m)!.add(`${f.b}:${f.c}`);
  }
  for (const [m, keys] of drop) {
    const msg = history[m];
    if (typeof msg.content === "string") continue;
    history[m] = {
      ...msg,
      content: msg.content.map((b, bi) => {
        if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map((c, ci) => (keys.has(`${bi}:${ci}`) ? { type: "text" as const, text: DROPPED } : c)) };
        return keys.has(`${bi}:-1`) ? { type: "text" as const, text: DROPPED } : b;
      }),
    };
  }
}

/** Saved reviews keep their findings and a small contact sheet, not every full-size render. */
function slimReview(it: Extract<ChatItem, { kind: "review" }>): ChatItem {
  if (!it.result) return { ...it, progress: undefined };
  return { ...it, progress: undefined, result: { ...it.result, views: it.result.views.map((v) => ({ ...v, image: "" })), sheet: "", source: "" } };
}

// Earlier turns are not edited once sent (images included), apart from capHeavy
// and repairs: Claude's thinking blocks are bound to the exact conversation
// that produced them, and an edited history invalidates them (see ./history).
// Images stay in context; they are cached.

// ---------- self-review ----------

/** The brief a review judges against: the project brief when there is one, plus the user's own messages in this conversation. */
function conversationBrief() {
  const said = get()
    .items.filter((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user")
    .map((i) => i.text.trim())
    .filter(Boolean);
  const model = useDesign.getState().model;
  const notes = model?.notes.length ? `\nDesign notes: ${model.notes.join(" ")}` : "";
  const conversation = (said.length ? said.map((t, n) => `${n + 1}. ${t}`).join("\n") : "") + (model?.name ? `\nDesign name: ${model.name}` : "") + notes;
  const project = briefSummary();
  if (!project) return { text: conversation, from: "conversation" as const };
  return { text: `${project}${conversation ? `\n\nWhat the user said in this conversation:\n${conversation}` : ""}`, from: "project" as const };
}
registerBriefProvider(conversationBrief);

/** Keep every review card of this reply in step with the latest status of each finding. */
function syncFindings(session: ReviewSession, itemIds: string[]) {
  const latest = new Map(session.findings.map((f) => [f.id, f]));
  const upd = (fs: Finding[]) => fs.map((f) => latest.get(f.id) ?? f);
  for (const id of itemIds) patch(id, (it) => (it.kind === "review" && it.result ? { ...it, result: { ...it.result, findings: upd(it.result.findings), earlier: upd(it.result.earlier) } } : it));
}

/** Run one review round into the chat item itemId. Returns the result, or null when it could not run. */
async function reviewInto(itemId: string, session: ReviewSession, itemIds: string[], auto: boolean, since: string, focus?: string): Promise<ReviewResult | { error: string }> {
  const round = session.round + 1;
  set((s) => ({ items: s.items.map((it) => (it.id === itemId ? { kind: "review", id: itemId, auto, round, status: "running", progress: { stage: "waiting", views: [] } } : it)) }));
  itemIds.push(itemId);
  try {
    const result = await runReview(
      {
        brief: reviewBrief(),
        round,
        earlier: session.carried(),
        nextId: session.nextId,
        since,
        focus,
        signal: abort?.signal,
        onProgress: (p) => patch(itemId, (it) => (it.kind === "review" ? { ...it, progress: { stage: p.stage, detail: p.detail, views: (p.views ?? []).map((v) => v.image) } } : it)),
      },
      appDeps(client),
    );
    session.add(result);
    const thumb = result.sheet ? await shrinkImage(result.sheet, 480).catch(() => undefined) : undefined;
    patch(itemId, (it) => (it.kind === "review" ? { ...it, status: "done", progress: undefined, result, thumb } : it));
    syncFindings(session, itemIds);
    persist();
    return result;
  } catch (e) {
    const stopped = abort?.signal.aborted || (e instanceof Error && (e.name === "AbortError" || e instanceof Anthropic.APIUserAbortError));
    const msg = stopped ? "Stopped" : e instanceof ReviewError ? e.message : e instanceof Anthropic.APIError ? cleanApiMessage(e.message) : e instanceof Error ? e.message : String(e);
    patch(itemId, (it) => (it.kind === "review" ? { ...it, status: "error", progress: undefined, error: msg } : it));
    if (stopped) throw e;
    return { error: msg };
  }
}

function reviewContent(result: ReviewResult, text: string): ToolOutcome["content"] {
  const data = result.sheet.split(",")[1];
  return data ? [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data } }] : text;
}

// ---------- context ----------

const currentBrief = (): BriefData | null => briefData(useDesign.getState().model?.brief);
export const briefKey = (d: BriefData | null) => (d ? JSON.stringify(d) : "");

function contextNote(): string {
  const { model, report, source } = useDesign.getState();
  const { selected } = useView.getState();
  const seen = get().briefSeen;
  const now = currentBrief();
  let changed = "";
  if (seen !== null && seen !== briefKey(now)) {
    const list = briefChanges(seen ? (JSON.parse(seen) as BriefData) : null, now);
    if (list.length) changed = `The user edited the brief since your last turn: ${list.join("; ")}. Check the design still serves the brief and update it where it no longer does.`;
  }
  const lines = [
    `<context>`,
    modelSummary(model),
    briefSummary(),
    changed,
    takeQuickNote(),
    reportSummary(report, 12),
    selected.length ? `The user has selected: ${selected.slice(0, 20).join(", ")}` : "",
    drawingContext(),
    sourceNote(source),
    `</context>`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** The source itself when Claude has not seen it as it is and it is short; otherwise a word on whether to read it. */
function sourceNote(source: string): string {
  if (sourceSeen === source) return "";
  const edited = lastEditedSource !== null || sourceSeen !== null;
  if (source.length > INLINE_SOURCE_MAX) return edited ? "The source changed since you last saw it (the user edited it). Call get_design before editing." : "";
  sourceSeen = source;
  return sourceBlock(source, `The design as it is now${edited ? "; it changed since you last saw it" : ""}. Line numbers are not part of the text. Edit it from here without calling get_design.`);
}

function sourceBlock(source: string, note: string) {
  const lines = source.split("\n");
  const w = String(lines.length).length;
  return [`<source note="${note}">`, ...lines.map((l, i) => `${String(i + 1).padStart(w, " ")}| ${l}`), `</source>`].join("\n");
}

/** Add attached files to the brief as references (one version), returning each file's reference id. */
function addReferences(files: ChatFile[]): ChatFile[] {
  const { source, model } = useDesign.getState();
  if (!files.length || briefHasErrors(source, model)) return files;
  const d = currentBrief() ?? emptyBrief();
  const out: ChatFile[] = [];
  let added = 0;
  for (const f of files) {
    const existing = d.refs.find((r) => r.file === f.asset);
    if (existing) {
      out.push({ ...f, ref: existing.id });
      continue;
    }
    const base = f.kind === "pdf" ? "doc" : /^sketch/i.test(f.name) ? "sketch" : "photo";
    let n = 1;
    while (d.refs.some((r) => r.id === `${base}${n}`)) n++;
    const id = `${base}${n}`;
    const title = f.name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim() || (f.kind === "pdf" ? "PDF" : "Image");
    d.refs.push({ id, title, file: f.asset });
    out.push({ ...f, ref: id });
    added++;
  }
  if (added) commitSource(writeBrief(source, model, d), "you", `Added ${added} reference${added > 1 ? "s" : ""} from chat`);
  return out;
}

/** base64 characters of attachments one message may carry; a request over about 32 MB fails */
const MESSAGE_FILE_CHARS = 20_000_000;

async function fileBlocks(files: ChatFile[]): Promise<BetaContentBlockParam[]> {
  const projectId = useProject.getState().current?.id;
  const out: BetaContentBlockParam[] = [];
  if (!projectId) return out;
  let chars = 0;
  for (const f of files) {
    const block = await assetBlock(projectId, f.asset, f.name);
    if (!block) continue;
    chars += block.source.data.length;
    if (chars > MESSAGE_FILE_CHARS) {
      out.push({ type: "text", text: `(“${f.name}” is attached but not shown here: this message's files pass the size one request can carry.${f.ref ? ` It is saved as reference ${f.ref}; view_reference shows it.` : ""})` });
      continue;
    }
    out.push({ type: "text", text: `Attached ${f.kind === "pdf" ? "PDF" : "image"}${f.ref ? `, saved as reference ${f.ref} in the brief` : ""} (“${f.name}”):` });
    out.push(block as BetaContentBlockParam);
  }
  return out;
}


// ---------- summarising a long conversation (see ./compact) ----------

/** How long the next request's prompt is: as the API last counted it, or a rough guess for a chat no request has measured yet. */
function promptSize() {
  return Math.max(lastPrompt || estimatePrompt(), refusedAt);
}

/**
 * Summarise the older turns once the prompt passes the size set in Settings, or when the API
 * refused it as too long. Runs on the design model with the same system prompt,
 * tools and thinking settings as the conversation, so the thinking in the kept
 * turns stays valid. Returns where a message index moves to, or null when
 * nothing was summarised (too short, or it failed: the conversation then goes
 * as it is).
 */
async function compactIfLong(anthropic: Anthropic, signal: AbortSignal, stale: () => boolean): Promise<((i: number) => number) | null> {
  const size = promptSize();
  const compactAt = Math.max(MIN_COMPACT_AT, useSettings.getState().compactAt);
  if (size < (refusedAt ? MIN_COMPACT_AT : compactAt) || (compactFailedAt && !refusedAt && size < compactFailedAt + RETRY_GROWTH)) return null;
  const keep = keepTokens(compactAt);
  // per-message sizes are guesses from their length: scaled up to what the API last counted, when it counted more
  const known = refusedAt || lastPrompt;
  const scale = known ? Math.max(1, known / estimatePrompt()) : 1;
  const sizes = () => history.map((m) => messageTokens(m) * scale);
  if (history[history.length - 1]?.role !== "user" || !planCut(history, keep, SUMMARY_INPUT_MAX, sizes())) return null;
  const route = designRoute("summarising the conversation", "rule");
  const system = systemBlocks();
  const tools = requestTools(useSettings.getState());
  const note = nid();
  const k = (n: number) => `${Math.round(n / 1000)}K`;
  push({ kind: "notice", id: note, level: "info", title: "Summarising the earlier conversation", detail: `It has grown to about ${k(size)} tokens. The older turns become a summary so Claude stays within its context and each step costs less.` });
  const done: Cut[] = [];
  let summarised = 0;
  let limit = SUMMARY_INPUT_MAX;
  // the summary replaces the start of the conversation and the API accepts that, so only edits made before it count
  const marks = marksOn(unsupported(route.model));
  const swapped = () => void (sent = { binding: bindingKey(system, tools), keys: messageKeys(sendable(history, tools, true)) });
  settleEdits(system, tools);
  try {
    while (done.length < 6) {
      const cut = planCut(history, keep, limit, sizes());
      if (!cut) break;
      const older = sendable(history.slice(0, cut.at), tools, marks);
      // only the first summary's turns can still be in the prompt cache
      const r = await summarise(anthropic, route, system, tools, !done.length && cut.final ? withCacheBreakpoint(older) : older, signal);
      if (stale()) return null;
      if (r === "too long") {
        if ((limit = Math.floor(limit / 2)) < 20_000) throw new Error("The conversation is too long to summarise.");
        continue;
      }
      summarised += cut.at - (hasCompaction(history) ? 1 : 0);
      history = [{ role: "assistant", content: [r] }, ...history.slice(cut.at)];
      if (cut.all) history.push({ role: "user", content: [] });
      swapped();
      done.push(cut);
      if (cut.final) break;
    }
    if (!done.length || !done[done.length - 1].final) throw new Error("The conversation could not be split where no step is left half done.");
  } catch (e) {
    if (isAbort(e) || stale()) {
      set((s) => ({ items: s.items.filter((i) => i.id !== note) }));
      throw e;
    }
    compactFailedAt = size;
    const why = e instanceof Anthropic.APIError ? cleanApiMessage(e.message) : e instanceof Error ? e.message : String(e);
    console.warn(`[kerf] Could not summarise the conversation: ${why}`);
    patch(note, (it) => (it.kind === "notice" ? { ...it, level: "warn", title: "Could not summarise the earlier conversation", detail: `${why} Claude carries on with the whole conversation${done.length ? ", part of it summarised" : ""}.` } : it));
    if (!done.length) return null;
  }
  const last = done[done.length - 1];
  // what a summary could blur goes with the next request, word for word
  const end = history[history.length - 1];
  const content = typeof end.content === "string" ? [{ type: "text" as const, text: end.content }] : end.content;
  const carryOn = last.all ? [{ type: "text" as const, text: "Carry on from where the summary leaves off." }] : [];
  history[history.length - 1] = { ...end, content: [...content, { type: "text", text: restateAfterSummary() }, ...carryOn] };
  swapped();
  lastBreak.clear();
  lastPrompt = refusedAt = 0;
  // earlier turns can no longer be taken back off the end by their position
  set((s) => ({ items: s.items.map((it) => (it.kind === "cost" ? { ...it, historyStart: -1 } : it)) }));
  if (last.final) {
    compactFailedAt = 0;
    const kept = last.all ? 0 : cutPoints(history).length + 1;
    const stays = kept ? `the last ${kept === 1 ? "turn stays" : `${kept} turns stay`} word for word` : "everything up to now is in it";
    patch(note, (it) =>
      it.kind === "notice"
        ? { ...it, title: "Summarised the earlier conversation", detail: `It had grown to about ${k(size)} tokens. ${summarised} older messages are now a summary that Claude reads first; ${stays}, and the design, its brief, the plan and every message you wrote go to Claude again in full.` }
        : it,
    );
  }
  persist();
  return (i) => done.reduce((j, c) => (j < 0 ? -1 : afterCut(j, c)), i);
}

/** One summary request: the compaction block to put first, or "too long" when even the part sent does not fit. */
async function summarise(anthropic: Anthropic, route: Route, system: ReturnType<typeof systemBlocks>, tools: unknown[], messages: BetaMessageParam[], signal: AbortSignal): Promise<BetaContentBlockParam | "too long"> {
  let busy = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const off = unsupported(route.model);
    const betas = [COMPACT_BETA];
    const sending = marksOn(off) ? messages : withoutEffortMarks(messages);
    if (hasEffortMarks(sending)) betas.push(STEP_EFFORT_BETA);
    const params: Record<string, unknown> = { model: route.model, max_tokens: MAX_OUTPUT_TOKENS, system, tools, messages: sending, compaction: { type: "summarize", instructions: COMPACT_INSTRUCTIONS } };
    if (!off.has("thinking")) {
      const thinking: Record<string, unknown> = { type: "adaptive", display: useSettings.getState().showThinking ? "summarized" : "omitted" };
      if (!off.has("binding")) {
        thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
        betas.push(BINDING_BETA);
      }
      params.thinking = thinking;
    }
    if (!off.has("effort")) params.output_config = { effort: route.effort };
    params.betas = betas;
    try {
      const final = await anthropic.beta.messages.stream(params as never, { signal }).finalMessage();
      recordSpend("compact", final.model, compactionUsage(final.usage));
      const block = (final.content as { type: string; content?: string | null }[]).find((b) => b.type === "compaction");
      if (final.stop_reason === "compaction" && block?.content) return block as unknown as BetaContentBlockParam;
      if ((final.stop_reason as string) === "model_context_window_exceeded") return "too long";
      throw new Error(final.stop_reason === "compaction" ? "The summary came back empty." : `The summary stopped early (${final.stop_reason}).`);
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        if (promptTooLong(e.message) !== null) return "too long";
        // a model that rejects an optional feature: drop it and ask again (never the summary itself)
        const feature = /compact/i.test(e.message) ? null : rejectedFeature(e.message.toLowerCase(), off);
        if (feature && !off.has(feature)) {
          off.add(feature);
          continue;
        }
      }
      const wait = retryWait(e, busy);
      if (wait !== null && !signal.aborted) {
        busy++;
        await pause(wait * 1000, signal);
        continue;
      }
      throw e;
    }
  }
  throw new Error("The summary request could not be completed.");
}

/** What Claude needs word for word after the earlier turns were summarised: every message the user wrote, the plan, and the design as it is now. */
function restateAfterSummary(): string {
  const { model, source } = useDesign.getState();
  const said = get()
    .items.filter((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user")
    .map((i) => `${i.text.trim() || "(no text)"}${i.files?.length ? ` [attached: ${i.files.map((f) => `“${f.name}”${f.ref ? ` (reference ${f.ref})` : ""}`).join(", ")}]` : ""}${i.spot ? ` [about: ${spotText(i.spot)}]` : ""}`);
  const plan = planOutline(usePlan.getState());
  lastEditedSource = null;
  sourceSeen = source.length <= INLINE_SOURCE_MAX ? source : null;
  return [
    `<after-summary note="The earlier part of this conversation was summarised to keep it within your context; the summary comes first. Restated here word for word, as they are now, is what the summary could blur.">`,
    said.length ? `<user-messages note="Every message the user wrote in this chat, oldest first. What they asked for and decided still stands unless a later message changed it.">\n${userMessagesText(said)}\n</user-messages>` : "",
    plan ? `<plan note="The plan as the user sees it. Keep its step ids when you call update_plan.">\n${plan}\n</plan>` : "",
    modelSummary(model),
    briefSummary(),
    sourceSeen !== null ? sourceBlock(source, "The design as it is now, with its brief and recorded decisions. Line numbers are not part of the text. Edit it from here without calling get_design.") : "The design source is too long to repeat here: call get_design before you edit it.",
    `</after-summary>`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- the loop ----------

export function stop() {
  // a stop wins over a pending "apply plan changes now"
  redirect = false;
  abort?.abort();
}

/**
 * Send the user's message. Files attached to it are kept as references in the
 * brief. With a spot, the message is about that place on the model (see
 * app/spot); `id` names the chat item so the caller can follow the replies.
 */
/** Added to a message sent with "Options first": Claude lays out the approaches and the user picks before anything is built. */
export const OPTIONS_FIRST_NOTE =
  "<options-first>The user asked to see options before you build. Before changing the design, work out two to four genuinely different ways to do what they asked (a different layout, mechanism, process or size, not small variations), then put them to the user with ask_user: each with its consequence, the parameter values in set where it comes down to values, and your recommendation marked. Build only the option they pick. If there is truly only one sensible way, say why in one sentence and go ahead.</options-first>";

export async function sendMessage(text: string, opts: { files?: ChatFile[]; spot?: SpotRef; id?: string; image?: { url: string; note: string }; design?: boolean; optionsFirst?: boolean } = {}) {
  const t = text.trim();
  const attached = opts.files ?? [];
  if (!t && !attached.length) return;
  // while Claude (or a parallel build) works, a message joins that run at its next step instead of waiting for it to end
  if (get().busy || isBuilding()) {
    addMidRun(t, opts);
    return;
  }
  // a plain command ("fillet 2", "hole M3 here", "wall 3") is done at once, without Claude; an open question from Claude takes the message instead
  if (!attached.length && !opts.image && !opts.design && !opts.optionsFirst && !get().pendingChoice && useSettings.getState().quickCommands && quickly(t, opts.spot, opts.id)) return;
  endPreview();
  const pending = get().pendingChoice;
  const lastReply = [...get().items].reverse().find((i): i is Extract<ChatItem, { kind: "assistant" }> => i.kind === "assistant" && !!i.text.trim())?.text ?? "";
  const files = addReferences(attached);
  push({ kind: "user", id: opts.id ?? nid(), text: t, ts: Date.now(), files: files.length ? files : undefined, spot: opts.spot, image: opts.image?.url, optionsFirst: opts.optionsFirst || undefined });
  set({ lastUserText: t, busy: true });
  settlePausedTail();
  let blocks: BetaContentBlockParam[] = [];
  try {
    blocks = await fileBlocks(files);
  } finally {
    set({ busy: false });
  }
  const typed = t || "(See the attached reference.)";
  const said = (opts.spot ? `<spot>${spotText(opts.spot)}</spot>\n${typed}` : opts.image ? `<markup>${opts.image.note}</markup>\n${typed}` : typed) + (opts.optionsFirst ? `\n${OPTIONS_FIRST_NOTE}` : "");
  const pic: BetaContentBlockParam[] = opts.image ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: opts.image.url.split(",")[1] ?? "" } }] : [];
  const steer = steering();
  if (pending) {
    // the user typed instead of picking: that answers the open question
    patch(pending.itemId, (it) => (it.kind === "choice" ? { ...it, chosen: "(answered in chat)" } : it));
    set({ pendingChoice: null });
    addUser([...pending.results, { type: "tool_result", tool_use_id: pending.toolUseId, content: `The user did not pick an option and wrote instead: ${said}` }, ...blocks, { type: "text", text: contextNote() }, ...pic, ...steer]);
  } else {
    addUser([{ type: "text", text: contextNote() }, ...steer, ...blocks, ...pic, { type: "text", text: said }]);
  }
  persist();
  await runLoop({
    // a change asked for from one of Kerf's panels, not typed: always design work
    route: opts.optionsFirst ? designRoute("you asked for options first", "you") : opts.design ? designRoute("a change asked for from a panel", "rule") : undefined,
    facts: {
      text: t,
      lastReply,
      hasFiles: files.length > 0,
      pointsAtModel: !!opts.spot || !!opts.image,
      answersChoice: !!pending,
      steering: steer.length > 0,
      parts: useDesign.getState().model?.parts.length ?? 0,
    },
  });
}

/**
 * A message sent while Claude works. It shows in the chat at once and queues
 * with the plan's steering: the running loop reads it after its current
 * action, and sub-agents of a parallel build read their copy at their next
 * step (the one building the part a spot is on, or all of them). Nothing is
 * stopped or redone, so the change costs only the steps it needs. Files and
 * marked-up views wait for the run to end: they are too heavy to queue.
 * Returns whether it queued.
 */
export function addMidRun(text: string, opts: { files?: ChatFile[]; spot?: SpotRef; id?: string; image?: unknown } = {}): boolean {
  const t = text.trim();
  if (!t || opts.files?.length || opts.image) {
    if (opts.files?.length || opts.image) toast({ kind: "info", title: "Send pictures and files once Claude finishes", detail: "A message without them can go now: Claude reads it at its next step." });
    return false;
  }
  const id = opts.id ?? nid();
  const to = isBuilding() ? relayToAgents(t, opts.spot?.partId) : [];
  push({ kind: "user", id, text: t, ts: Date.now(), spot: opts.spot, midRun: true });
  userMessage({ msg: id, text: t, about: opts.spot ? spotText(opts.spot) : undefined, to });
  persist();
  return true;
}

/** Take back a message sent mid-run before Claude reads it. */
function takeQuickNote(): string {
  if (!quickLog.length) return "";
  const note = `Since your last turn the user made these changes themselves with quick commands (already in the source): ${quickLog.slice(-12).join("; ")}.`;
  quickLog = [];
  return note;
}

/**
 * Do a message as a plain command when it is one. Returns whether the message
 * is dealt with: done, or refused with a reason the user can act on. One that
 * Claude could do instead (no part chosen, a mechanism part) goes to Claude
 * when there is a key.
 */
function quickly(text: string, spot: SpotRef | undefined, id: string | undefined): boolean {
  const q = runQuick(text, spot);
  if (!q) return false;
  if (!q.ok && q.ai && client()) return false;
  push({ kind: "user", id: id ?? nid(), text, ts: Date.now(), spot });
  if (!q.ok) {
    push({ kind: "notice", id: nid(), level: "info", title: q.why });
    persist();
    return true;
  }
  const itemId = nid();
  push({ kind: "quick", id: itemId, text, title: q.title, detail: q.detail, before: q.before, after: q.after, spot, plain: q.kind === "undo" || q.kind === "redo" });
  quickLog.push(`“${text}” (${q.title})`);
  persist();
  const g = gen;
  void q.built.then((err) => {
    if (err && g === gen) {
      patch(itemId, (it) => (it.kind === "quick" ? { ...it, failed: err } : it));
      persist();
    }
  });
  return true;
}

/** Undo a quick command, when the design has not moved on since. */
export function undoQuick(itemId: string): boolean {
  const it = get().items.find((i) => i.id === itemId);
  if (!it || it.kind !== "quick" || it.undone || it.plain) return false;
  if (useDesign.getState().source !== it.after) {
    toast({ kind: "info", title: "The design has changed since", detail: "Use Undo (Ctrl+Z) or the version history to go back further." });
    return false;
  }
  commitSource(it.before, "you", `Undid: ${it.title}`);
  patch(itemId, (x) => (x.kind === "quick" ? { ...x, undone: true } : x));
  quickLog.push(`undid “${it.text}”`);
  persist();
  return true;
}

/** Hand a quick command to Claude: undo it when it can be, then ask Claude, pointing where the command pointed. */
export function askClaudeInstead(itemId: string, fix?: boolean) {
  const it = get().items.find((i) => i.id === itemId);
  if (!it || it.kind !== "quick") return;
  if (fix) {
    void sendMessage(`I ran the command “${it.text}” (${it.title}), but the part no longer builds: ${it.failed}. Fix it, keeping what I asked for as far as it can work.`, { spot: it.spot, design: true });
    return;
  }
  if (!it.undone && useDesign.getState().source === it.after) undoQuick(itemId);
  void sendMessage(it.text, { spot: it.spot, design: true });
}

export function withdrawMidRun(itemId: string) {
  if (!userWithdrawMessage(itemId)) return;
  set((s) => ({ items: s.items.filter((i) => i.id !== itemId) }));
  persist();
}

/**
 * Messages sent mid-run that are still waiting (the run was stopped, or the
 * page reloaded): while Claude works, stop its current response and go on with
 * them; otherwise send them now as a turn of their own.
 */
export async function sendQueuedNow() {
  if (get().busy) return applyPlanChangesNow();
  if (get().pendingChoice || isBuilding()) return;
  const blocks = steering();
  if (!blocks.length) return;
  endPreview();
  settlePausedTail();
  addUser([{ type: "text", text: contextNote() }, ...blocks]);
  persist();
  await runLoop({ route: designRoute("your message from while Claude worked", "rule") });
}

/** Where a message sent mid-run stands, for its bubble. */
export const midRunState = (itemId: string) => messageState(usePlan.getState(), itemId);

/** Add user content to the history, joining results a finished turn left waiting for it. */
function addUser(content: BetaContentBlockParam[]) {
  const last = history[history.length - 1];
  if (last?.role === "user" && typeof last.content !== "string" && last.content.every((b) => b.type === "tool_result")) history[history.length - 1] = { role: "user", content: [...last.content, ...content] };
  else history.push({ role: "user", content });
}

/**
 * Answer an open choice card. Values the user adjusted and a note for Claude
 * can come with it. The option's parameter values are applied at once and the
 * answer is recorded as a decision block, so Claude continues from there.
 */
export async function choose(itemId: string, label: string, opts: { values?: SetMap; note?: string } = {}) {
  const pending = get().pendingChoice;
  if (!pending || pending.itemId !== itemId || get().busy) return;
  const item = get().items.find((i) => i.id === itemId);
  const option = item?.kind === "choice" ? item.options.find((o) => o.label === label) : undefined;
  if (!item || item.kind !== "choice" || !option) return;
  endPreview();
  const note = opts.note?.trim() || undefined;
  let recorded: ReturnType<typeof recordChoice> | null = null;
  try {
    recorded = recordChoice(item, option, opts.values);
  } catch {
    /* the answer still goes to Claude; it can record the decision itself */
  }
  patch(itemId, (it) => (it.kind === "choice" ? { ...it, chosen: label, values: recorded?.values, note, decision: recorded?.name } : it));
  set({ pendingChoice: null });
  const tweaks = recorded?.adjusted.length ? ` (${recorded.adjusted.map((a) => `${a.param} ${fmtValue(a.to)}`).join(", ")})` : "";
  push({ kind: "user", id: nid(), text: `${label}${tweaks}${note ? `\n${note}` : ""}`, ts: Date.now() });
  addUser([...pending.results, { type: "tool_result", tool_use_id: pending.toolUseId, content: answerText(label, option, recorded, note) }, { type: "text", text: contextNote() }, ...steering()]);
  persist();
  await runLoop();
}

const fmtValue = (v: number | string | boolean) => (typeof v === "number" ? fmtNum(v, 3) : String(v));

/** Apply the chosen option's values and write (or update) its decision block, as one version. */
function recordChoice(item: Extract<ChatItem, { kind: "choice" }>, option: AskOption, adjustedValues?: SetMap) {
  const set0 = option.set ?? {};
  const values: SetMap = {};
  for (const k of Object.keys(set0)) values[k] = adjustedValues?.[k] ?? set0[k];
  const adjusted = Object.keys(set0)
    .filter((k) => adjustedValues?.[k] !== undefined && adjustedValues[k] !== set0[k])
    .map((k) => ({ param: k, from: set0[k], to: values[k] }));
  const { source, model } = useDesign.getState();
  if (!model) throw new Error("No design");
  const pe = paramEdits(model, values);
  const withVals = applySpanEdits(source, pe.edits);
  const m2 = evaluateOnly(withVals);
  const title = item.title?.trim() || shortTitle(item.question);
  const same = m2.decisions.find((d) => d.title.toLowerCase() === title.toLowerCase());
  const { src, name } = upsertDecision(withVals, m2, {
    name: same?.name,
    title,
    ask: item.question,
    chose: option.label,
    by: "you",
    options: item.options.map((o) => ({ label: o.label, note: o.consequence, set: o.label === option.label ? values : o.set })),
  });
  commitSource(src, "you", `Decided: ${option.label}${adjusted.length ? ` (${adjusted.map((a) => `${a.param} ${fmtValue(a.to)}`).join(", ")})` : ""}`);
  return { name, values: Object.keys(values).length ? values : undefined, adjusted, applied: pe.changed, missing: pe.missing };
}

function shortTitle(question: string) {
  const words = question.replace(/[?.!]+$/, "").split(/\s+/);
  return words.length > 6 ? words.slice(0, 6).join(" ") + "…" : words.join(" ");
}

function answerText(label: string, option: AskOption, r: ReturnType<typeof recordChoice> | null, note?: string) {
  const lines = [`The user chose: ${label}`];
  if (r?.adjusted.length) lines.push(`They adjusted its values before choosing: ${r.adjusted.map((a) => `${a.param} ${fmtValue(a.from)} → ${fmtValue(a.to)}`).join(", ")}.`);
  if (note) lines.push(`They added: ${note}`);
  if (r) {
    const applied = r.applied.length ? `Kerf has already applied the option's values (${r.applied.map((c) => `${c.param} = ${fmtValue(c.to)}`).join(", ")}) and recorded` : "Kerf recorded";
    lines.push(`${applied} the answer as \`decision ${r.name}\` in the source. The source changed: the context note below holds it when the design is short; otherwise call get_design before your next edit.`);
    if (r.missing.length) lines.push(`These option values were not applied because the parameters no longer exist: ${r.missing.join(", ")}.`);
    lines.push(option.set && Object.keys(option.set).length ? "Make any other changes this option needs and report the checks (each edit returns them; call run_checks if you change nothing else)." : "Carry out this choice and report the checks that come with your edits.");
  } else lines.push("Carry out this choice and report the checks that come with your edits.");
  return lines.join("\n");
}

export async function retryLast() {
  if (get().busy) return;
  endPreview();
  // resend a user turn that never got an answer, or resume a paused web search
  const last = history[history.length - 1];
  if (last?.role === "user" || isPausedTurn(last)) {
    await runLoop();
    return;
  }
  const t = get().lastUserText;
  if (t) await sendMessage(t);
}

/**
 * Answer the latest quick turn again on the design model. The quick answer is
 * removed from the end of the conversation (removing whole turns from the end
 * leaves every earlier thinking block valid) and its cost is carried into the
 * new turn.
 */
export async function askDesignModel(costId: string) {
  if (get().busy) return;
  const items = get().items;
  const at = items.findIndex((i) => i.id === costId);
  const it = items[at];
  // a turn whose start was summarised can't be taken back off the end
  if (!it || it.kind !== "cost" || !it.route.quick || it.route.escalated || it.historyStart < 0 || it.historyStart > history.length) return;
  // only the latest turn: nothing the user said since
  if (items.slice(at + 1).some((i) => i.kind === "user" || i.kind === "cost" || i.kind === "choice")) return;
  let userAt = at - 1;
  while (userAt >= 0 && items[userAt].kind !== "user") userAt--;
  if (userAt < 0) return;
  endPreview();
  history.length = it.historyStart;
  set((s) => ({ items: [...s.items.slice(0, userAt + 1), ...s.items.slice(at + 1)] }));
  persist();
  await runLoop({ route: designRoute(`you asked for ${modelLabel(useSettings.getState().model)}`, "you"), replaces: { spend: it.spend, route: it.route } });
}

export function revertTurn(itemId: string) {
  const it = get().items.find((i) => i.id === itemId);
  if (!it || it.kind !== "turn" || it.reverted) return;
  commitSource(it.before, "you", "Reverted Claude's change");
  patch(itemId, (x) => (x.kind === "turn" ? { ...x, reverted: true } : x));
  persist();
}

/**
 * A paused turn ends with a web search that has no result yet. When the user
 * writes instead of resuming it, the unanswered call is dropped (what Claude
 * already found stays) so the new message follows a complete turn.
 */
function settlePausedTail() {
  const last = history[history.length - 1];
  if (!isPausedTurn(last) || typeof last.content === "string") return;
  const answered = new Set(last.content.filter((b) => b.type.endsWith("_tool_result")).map((b) => (b as { tool_use_id?: string }).tool_use_id));
  const kept = last.content.filter((b) => b.type !== "server_tool_use" || answered.has(b.id));
  if (kept.some((b) => b.type !== "thinking" && b.type !== "redacted_thinking")) history[history.length - 1] = { ...last, content: kept };
  else history.pop();
}

type ClientFactory = () => Anthropic | null;
let clientFactory: ClientFactory | null = null;
/** For tests: replace the API client with a fake (tests never reach the network). Pass null to restore. */
export function setClientFactory(f: ClientFactory | null) {
  clientFactory = f;
}
/** For tests: the conversation exactly as the next request would send it. */
export function chatHistory(): readonly BetaMessageParam[] {
  return history;
}

// a declaration, so configureWarm above can take it before this line runs
function client() {
  if (clientFactory) return clientFactory();
  return claudeClient();
}

function systemBlocks() {
  return [{ type: "text" as const, text: systemPrompt({ lean: chatLean }) + lessonsPrompt(chatLessons), cache_control: { type: "ephemeral" as const } }];
}

/**
 * The lessons and prompt this chat runs with, read when the chat is opened: a lesson saved while it runs is
 * already in the conversation, and leaving the system prompt and tools alone keeps the whole conversation's cache
 * and its thinking.
 */
let chatLessons: string[] = [];
let chatLean = false;
function readChatSetup() {
  const s = useSettings.getState();
  chatLessons = s.useLessons ? [...s.lessons] : [];
  chatLean = s.leanPrompt;
}

/** The system prompt and tools this build of Kerf sends; thinking blocks made under different ones can't be sent back. */
export function currentBinding() {
  return bindingKey(systemBlocks(), requestTools(useSettings.getState()));
}

/** The model and effort for design work, as set in Settings. */
function designRoute(why = "design work", by: Route["by"] = "settings"): Route {
  const s = useSettings.getState();
  return { model: s.model, effort: s.effort as Effort, quick: false, why, by };
}

/** A model's short name, such as "Opus 5.5". */
export const modelLabel = (id: string) => MODELS.find((m) => id === m.id || id.startsWith(m.id + "-"))?.label.replace(/^Claude /, "") ?? id.replace(/^claude-/, "");

/** the quick model is not available to this key: every turn goes to the design model this session */
let quickUnavailable = false;
/** prompt tokens of the latest chat request, on any model (0 before the first one of this chat, and after a summary) */
let lastPrompt = 0;
/** prompt tokens the API counted when it refused the conversation as too long */
let refusedAt = 0;
/** how long the prompt was when summarising it last failed; it is tried again once the conversation grows well past that */
let compactFailedAt = 0;
/** when the latest quick request started */
let quickTouched = 0;

/** Rough prompt size of the conversation before any request has reported one (a reopened chat). */
function estimatePrompt(): number {
  let images = 0;
  const text = JSON.stringify([systemPrompt({ lean: chatLean }), requestTools(useSettings.getState()), history], (k, v) => {
    if (k === "data" && typeof v === "string") {
      images++;
      return "";
    }
    return v;
  });
  // a picture costs about 1,600 tokens however long its base64 is
  return roughTokens(text) + images * 1600;
}

/** Which model a turn needs, and how hard it works: the speed chosen beside Send, then the routing rules. */
async function chooseRoute(anthropic: Anthropic, facts: TurnFacts | undefined, signal: AbortSignal): Promise<Route> {
  // Thorough: the design model for everything, quick questions included
  if (useSettings.getState().speed === "thorough") return withSpeed(designRoute());
  return withSpeed(await routeFor(anthropic, facts, signal));
}

/** A route as the speed chosen beside Send changes it. A quick answer from Haiku stays as it is. */
function withSpeed(r: Route): Route {
  const speed = useSettings.getState().speed;
  if (r.quick || speed === "normal") return r;
  return { ...r, small: speed === "quick", speed, why: speed === "quick" ? "you chose Quick" : "you chose Thorough", by: "you" };
}

/** Which model a turn needs: the design model, unless the turn only reads the design. */
async function routeFor(anthropic: Anthropic, facts: TurnFacts | undefined, signal: AbortSignal): Promise<Route> {
  const s = useSettings.getState();
  if (isOpenAIModel(s.model)) return designRoute("using the selected OpenAI model");
  if (!facts) return designRoute();
  // a short, plain change: the design model, thinking briefly, and no self-review
  if (s.fastChanges && smallChange(facts)) return { ...designRoute("a small change", "rule"), small: true };
  if (!s.routeQuick) return designRoute("cheaper models are off in Settings");
  if (s.model.startsWith(QUICK_MODEL) || quickUnavailable) return designRoute();
  const rule = ruleReason(facts);
  if (rule) return designRoute(rule, "rule");
  if (!quickCanSave(s.model, lastPrompt || estimatePrompt(), Date.now() - quickTouched < QUICK_WARM_MS)) return designRoute(`a conversation this long costs less on ${modelLabel(s.model)}`, "rule");
  const r = await askRouter(anthropic, facts, signal);
  if (r.unavailable) quickUnavailable = true;
  // the router is spend that running everything on the design model would not have had
  if (r.usage) recordSpend("router", r.model, r.usage, -costOf(r.model, r.usage));
  return r.quick ? { model: QUICK_MODEL, effort: QUICK_EFFORT, quick: true, why: r.why, by: "router" } : designRoute(r.why, "router");
}

/** Steps a small change gets at low effort without review before it is treated as ordinary design work. */
const SMALL_STEPS = 4;

/** A quick turn reached for something only the design model does. */
class NeedsDesignModel extends Error {
  constructor(
    readonly why: string,
    readonly usage: Usage,
  ) {
    super(why);
  }
}

/** Tools that change the design: each one counts as an edit for the turn card, the "before" picture, revert and the self-review. */
const EDIT_TOOLS = new Set(["edit_design", "write_design", "build_subassemblies", "set_material", "place_fasteners", "group_parts"]);
/** Tools whose result can carry the build and checks of their change (see runTool's check). */
const CHECKED_TOOLS = new Set(["edit_design", "write_design", "update_brief", "set_material", "place_fasteners"]);

/** Why a quick turn that called this tool goes to the design model. */
function handoverWhy(tool: string) {
  if (EDIT_TOOLS.has(tool)) return "it needs a design change";
  if (tool === "update_brief") return "it changes the brief";
  if (tool === "update_plan") return "it needs a plan";
  if (tool === "ask_user" || tool === "explore_fixes" || tool === "compare_designs") return "it needs a design decision";
  if (tool === "review_design") return "it needs a design review";
  return "it needs a tool only the design model uses";
}

interface LoopOptions {
  /** decided already: a retry, an answered choice, or the user asking for the design model */
  route?: Route;
  /** what the router decides from, for a new message */
  facts?: TurnFacts;
  /** a quick answer this turn replaces: its spend is carried in, as spend that bought nothing */
  replaces?: { spend: TurnSpend; route: TurnRoute };
}


/**
 * The tools for one request: Kerf's own, plus Anthropic's web search and fetch
 * when the user allows them. The same for every model. A Kerf server's shared
 * key takes no server-side tools (its proxy refuses them), so they stay off there.
 */
export function requestTools(settings: Pick<Settings, "webSearch">, lean = chatLean): unknown[] {
  const own = lean ? [...TOOL_DEFS, REFERENCE_TOOL] : [...TOOL_DEFS];
  return settings.webSearch && !webUnavailable && claudeRoute() !== "shared" ? [...own, ...webTools()] : own;
}

/** What one response looks like in the chat while it streams. */
interface Live {
  /** assistant bubbles for this response; text after a web search starts a new one so it reads in order */
  bubbles: string[];
  /** Kerf tool rows by content index */
  toolRows: Map<number, string>;
  /** web search and page rows by server tool id; shared across resumed turns */
  webRows: Map<string, string>;
  /** web search error codes already explained in a notice this run, with the notice's id */
  noticed: Map<string, string>;
  /** rows and bubbles created by the current attempt, removed if it is retried */
  created: string[];
}

function newBubble(live: Live) {
  const id = nid();
  push({ kind: "assistant", id, text: "", thinking: "", streaming: true, started: Date.now() });
  live.bubbles.push(id);
  live.created.push(id);
  return id;
}
const bubbleOf = (live: Live) => live.bubbles[live.bubbles.length - 1];

function upsertWebRow(live: Live, a: WebActivity) {
  const row = { status: a.status, title: a.title, detail: a.detail, link: a.link };
  // a row from an earlier run of this turn (resumed with Try again) is updated in place
  const id = live.webRows.get(a.toolUseId) ?? get().items.find((i) => i.kind === "tool" && i.web && i.toolUseId === a.toolUseId)?.id;
  const prev = id ? get().items.find((i) => i.id === id) : undefined;
  const seen = prev?.kind === "tool" && prev.status === "error" && prev.detail === a.detail;
  if (id) {
    live.webRows.set(a.toolUseId, id);
    patch(id, (it) => (it.kind === "tool" ? { ...it, ...row } : it));
  } else {
    const rid = nid();
    live.webRows.set(a.toolUseId, rid);
    live.created.push(rid);
    push({ kind: "tool", id: rid, toolUseId: a.toolUseId, name: a.name, web: true, ...row });
  }
  // when search itself failed, a quiet note right below the row; Claude carries on with what it has
  if (a.name === "web_search" && a.error && !seen && !live.noticed.has(a.error.code)) {
    const nidv = nid();
    live.noticed.set(a.error.code, nidv);
    live.created.push(nidv);
    push({ kind: "notice", id: nidv, level: "info", title: WEB_NOTICE[a.error.code] ?? "A web search did not work", detail: `${a.error.text} Claude carries on with what it has.` });
  }
}

function syncWeb(live: Live, content: readonly unknown[], finished: false | true | "paused" = false): WebActivity[] {
  let acts: WebActivity[];
  try {
    acts = webActivity(content as never, finished);
  } catch {
    return [];
  }
  for (const a of acts) upsertWebRow(live, a);
  return acts;
}

/** Undo what a failed attempt showed, before it is retried. */
function resetLive(live: Live) {
  flushDeltas();
  const drop = new Set(live.created.filter((id) => id !== live.bubbles[0]));
  set((s) => ({ items: s.items.filter((i) => !drop.has(i.id)).map((it) => (it.id === live.bubbles[0] && it.kind === "assistant" ? { ...it, text: "", thinking: "" } : it)) }));
  live.bubbles = live.bubbles.slice(0, 1);
  for (const [k, id] of live.toolRows) if (drop.has(id)) live.toolRows.delete(k);
  for (const [k, id] of live.webRows) if (drop.has(id)) live.webRows.delete(k);
  for (const [k, id] of live.noticed) if (drop.has(id)) live.noticed.delete(k);
  live.created = [];
}

const WEB_NOTICE: Record<string, string> = {
  max_uses_exceeded: "Web search limit reached for this step",
  too_many_requests: "Web search is busy",
  unavailable: "Web search is unavailable right now",
};

async function runLoop(opts: LoopOptions = {}) {
  const anthropic = client();
  if (!anthropic) {
    push({ kind: "notice", id: nid(), level: "warn", title: "Add your selected provider's API key to chat", detail: "Add an OpenAI or Claude key in Settings → AI and select a matching model. Everything else works without a key.", action: "settings" });
    persist();
    return;
  }
  const ac = new AbortController();
  abort = ac;
  const g = gen;
  const stale = () => g !== gen;
  set({ busy: true });
  const startSource = useDesign.getState().source;
  // a picture of the design as it was, for the change card (none if the design moves on first)
  const before = shotOf(startSource);
  let edits = 0;
  // the finish gate: once per run, Claude is sent back when it stops with the design incomplete
  const openAtStart = openChecks();
  let gated = false;
  const settings = useSettings.getState();
  if (settings.webNotice && !isOpenAIModel(settings.model)) {
    if (settings.webSearch)
      push({ kind: "notice", id: nid(), level: "info", title: "Claude can now search the web for parts", detail: "When the parts catalog has nothing suitable, Claude may search the web and read product pages. Each search costs about $0.01 on your API key, plus the tokens the pages use. Turn it off in Settings → AI → Search the web for parts.", action: "settings" });
    updateSettings({ webNotice: false });
  }
  const session = new ReviewSession(settings.reviewRounds);
  const reviewItems: string[] = [];
  // a new message is measured against the design as it is now; an answer to Claude's question or "continue" carries on
  const fresh = !!opts.facts && !opts.facts.answersChoice && !/^(?:ok[, ]+)?(?:continue|go on|keep going|carry on)\b/i.test(opts.facts.text.trim());
  beginAsks(useDesign.getState().model, !fresh);
  if (fresh) asksCard = "";
  const system = systemBlocks();
  let historyStart = history.length;
  // what this turn costs, from every request made while it runs (the router, reviews and agents included)
  const box = { spend: emptyTurn() };
  if (opts.replaces) box.spend = carryOver(box.spend, opts.replaces.spend);
  turnBox = box;
  let route: Route = opts.route ?? designRoute();
  let routeNote: TurnRoute | null = opts.replaces ? { ...opts.replaces.route, escalated: { to: route.model, why: "you asked for it" } } : null;
  const webRows = new Map<string, string>();
  const noticed = new Map<string, string>();
  // content of the paused responses this one continues, so their searches get their results
  let carried: unknown[] = [];
  if (isPausedTurn(history[history.length - 1])) {
    for (let i = history.length - 1; i >= 0 && history[i].role === "assistant"; i--) {
      const c = history[i].content;
      if (typeof c !== "string") carried = [...c, ...carried];
    }
  }
  let resumes = 0;
  let cuts = 0;
  /** the API refused this run's conversation as too long once already */
  let refused = false;
  /** chat items of this turn's paused responses: a hand-over takes them away with the rest of the quick answer */
  let pausedItems: string[] = [];

  try {
    if (!opts.route) {
      set({ routing: true });
      try {
        route = await chooseRoute(anthropic, opts.facts, ac.signal);
      } finally {
        set({ routing: false });
      }
    }
    if (stale()) return;
    // a retry or an answered question keeps the speed chosen beside Send
    if (opts.route) route = withSpeed(route);
    if (route.speed === "thorough") session.maxRounds = 3;
    routeNote ??= { model: route.model, quick: route.quick, why: route.why, by: route.by };
    // models that have answered in this run: their later steps are follow-ups (see stepEffort)
    const answered = new Set<string>();
    // a message the user adds while a quick answer runs may ask for anything: the design model takes it from there
    const tookMessage = (blocks: { text: string }[]) => {
      if (!hasMessage(blocks)) return;
      // a message added while Claude works is thought through like the start of a reply
      answered.clear();
      if (route.small && route.speed !== "quick") route = { ...route, small: false };
      if (!route.quick) return;
      const why = "you added a message while it worked";
      route = designRoute(why, "rule");
      routeNote = { ...routeNote!, escalated: { to: route.model, why } };
    };
    for (let step = 0; step < settings.maxSteps; step++) {
      if (stale()) return;
      // a small change that is still going after a few steps was not small: back to the usual effort and review
      if (route.small && route.speed !== "quick" && step >= SMALL_STEPS) route = { ...route, small: false };
      // what the user sent since the last request was built (while the model was chosen, or a review ran) goes with this one
      const lastMsg = history[history.length - 1];
      if (lastMsg?.role === "user" && typeof lastMsg.content !== "string") {
        const late = steering();
        if (late.length) {
          history[history.length - 1] = { ...lastMsg, content: [...lastMsg.content, ...late] };
          tookMessage(late);
        }
      }
      repairHistory();
      capHeavy();
      // a long conversation is summarised before it outgrows Claude's context, and so each step costs less
      const moved = await compactIfLong(anthropic, ac.signal, stale);
      if (stale()) return;
      if (moved) historyStart = moved(historyStart);
      const live: Live = { bubbles: [], toolRows: new Map(), webRows, noticed, created: [] };
      newBubble(live);
      const r = route;

      // the quick model hands the turn over: what it streamed goes, and the design model answers from here
      const handOver = (why: string, wasted?: Usage) => {
        if (wasted) recordSpend("escalated", r.model, wasted, -costOf(r.model, wasted));
        const partial = new Set([...live.created, ...pausedItems]);
        set((s) => ({ items: s.items.filter((it) => !partial.has(it.id)) }));
        for (const [k, id] of webRows) if (partial.has(id)) webRows.delete(k);
        for (const [k, id] of noticed) if (partial.has(id)) noticed.delete(k);
        // a web search it paused in goes too: the design model starts the answer afresh
        if (carried.length) {
          while (history.length > historyStart && history[history.length - 1].role === "assistant") history.pop();
          carried = [];
          resumes = 0;
        }
        pausedItems = [];
        route = designRoute(why, r.by);
        routeNote = { ...routeNote!, escalated: { to: route.model, why } };
        push({ kind: "notice", id: nid(), level: "info", title: `Passed to ${modelLabel(route.model)}`, detail: `${modelLabel(r.model)} started on this, but ${why}.` });
      };

      // the first step of a reply thinks at the effort set in Settings, later ones at medium: set by a mark inside
      // the conversation, so the cache stays valid; a mark before this turn's own message moves where the turn starts
      const first = !answered.has(r.model);
      const stepAt = r.small ? "low" : r.speed === "thorough" ? thoroughEffort(r.effort, first) : stepEffort(r.effort, first, useSettings.getState().fasterFollowUps);
      if (marksOn(unsupported(r.model)) && markEffort(history, stepAt, r.effort) && historyStart > history.length - 2) historyStart++;

      let sentReq: { final: Awaited<ReturnType<typeof streamOnce>>["final"]; params: Record<string, unknown> };
      if (r.quick) quickTouched = Date.now();
      try {
        sentReq = await streamOnce(anthropic, () => buildRequest(system, r, settings), live, carried, ac.signal, { design: !r.quick, stopOnTool: r.quick ? (name) => !QUICK_TOOLS.has(name) : undefined });
      } catch (e) {
        // too long for Claude's context (a chat that grew past it, or a guess that fell short): summarise, then send it again
        const over = !refused && !stale() && e instanceof Anthropic.BadRequestError ? promptTooLong(e.message) : null;
        if (over !== null) {
          refused = true;
          refusedAt = Math.max(over, MIN_COMPACT_AT);
          const shown = new Set(live.created);
          set((s) => ({ items: s.items.filter((i) => !shown.has(i.id)) }));
          const moved = await compactIfLong(anthropic, ac.signal, stale);
          if (stale()) return;
          if (moved) {
            historyStart = moved(historyStart);
            step--;
            continue;
          }
        }
        if (r.quick && !stale() && !isAbort(e)) {
          if (e instanceof NeedsDesignModel) {
            handOver(e.why, e.usage);
            step--;
            continue;
          }
          if (e instanceof Anthropic.APIError && !(e instanceof Anthropic.AuthenticationError)) {
            if (e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.NotFoundError) quickUnavailable = true;
            handOver(`${modelLabel(r.model)} could not answer just now`);
            step--;
            continue;
          }
        }
        throw e;
      }
      const { final, params } = sentReq;
      if (stale()) return;
      answered.add(r.model);
      const raw = final.content as BetaContentBlock[];
      // after a mid-answer fallback, only what the API accepts back goes into the history
      let content = echoContent(raw);
      const usage = final.usage as unknown as Usage;
      lastPrompt = promptTokens(usage);
      if (r.quick) {
        // web searches are server tools, not tool_use blocks: a quick turn may search, and a paused search is resumed, not handed over
        const uses = content.filter((b) => b.type === "tool_use") as { name: string }[];
        const why =
          final.stop_reason === "refusal"
            ? `${modelLabel(r.model)} declined it`
            : final.stop_reason === "max_tokens"
              ? "the answer ran long"
              : uses.some((u) => !QUICK_TOOLS.has(u.name))
                ? handoverWhy(uses.find((u) => !QUICK_TOOLS.has(u.name))!.name)
                : uses.length && step >= QUICK_MAX_STEPS - 1
                  ? "it needs more steps than a quick answer"
                  : null;
        if (why) {
          handOver(why, usage);
          step--;
          continue;
        }
        recordSpend("quick", final.model, usage, counterfactualCost(useSettings.getState().model, usage) - costOf(final.model, usage));
      } else recordSpend("chat", final.model, usage, requestFinished(params, usage));
      // a response cut off at the length limit: Claude carries on by itself, in smaller steps
      let cutNote: string | null = null;
      if (final.stop_reason === "max_tokens" && ++cuts <= MAX_CUT_RECOVERIES) {
        const t = trimCutOff(content);
        content = t.content;
        cutNote = cutOffNote(t.cutTool);
        push({ kind: "notice", id: nid(), level: "info", title: "The response ran past its length limit", detail: t.cutTool ? "Claude is carrying on by itself in smaller steps." : "Claude is carrying on by itself." });
      }
      history.push({ role: "assistant", content: content as unknown as BetaContentBlockParam[] });
      reportDroppedThinking(final.input_transformations);

      // web searches and pages: the final state of every row
      syncWeb(live, [...carried, ...raw], final.stop_reason === "pause_turn" ? "paused" : true);
      const sources = citedSources(raw);
      const fb = raw.find((b) => (b as { type: string }).type === "fallback") as { to?: { model?: string } } | undefined;
      const lastBubble = bubbleOf(live);
      set((s) => ({
        items: s.items.map((it) =>
          it.kind === "assistant" && live.bubbles.includes(it.id)
            ? { ...it, streaming: false, ...(it.id === lastBubble ? { model: final.model, note: fb?.to?.model ? `Answered by ${fb.to.model} (server-side fallback)` : undefined, sources: sources.length ? sources : undefined } : {}) }
            : it,
        ),
      }));
      // drop empty bubbles (tool-only responses)
      set((s) => ({ items: s.items.filter((i) => !(i.kind === "assistant" && live.bubbles.includes(i.id) && !i.text.trim() && !i.thinking.trim() && !i.sources?.length)) }));

      if (final.stop_reason === "pause_turn") {
        // the server paused a long web search: send the turn back unchanged to resume it (not a new step)
        carried = [...carried, ...raw];
        pausedItems = [...pausedItems, ...live.created];
        persist();
        if (++resumes > MAX_PAUSE_RESUMES) {
          push({ kind: "notice", id: nid(), level: "info", title: "Claude paused during a long web search", detail: "Press Try again to let it carry on, or write a message to move on.", action: "retry" });
          break;
        }
        step--;
        continue;
      }
      carried = [];
      resumes = 0;
      pausedItems = [];

      if (final.stop_reason === "refusal") {
        push({ kind: "notice", id: nid(), level: "warn", title: "Claude declined this request", detail: "Try rephrasing what you need. Kerf is for designing mechanical parts and assemblies." });
        break;
      }
      if (final.stop_reason === "max_tokens" && !cutNote) {
        const cut = content.some((b) => b.type === "tool_use");
        push({ kind: "notice", id: nid(), level: "warn", title: "The response hit its length limit", detail: cut ? "The last step was cut off before it could run. Ask Claude to continue in smaller steps." : "Ask Claude to continue." });
        if (cut) history.pop();
        break;
      }
      if (final.stop_reason === "end_turn" && step < settings.maxSteps - 1) {
        // a message sent while this response was written still gets an answer in this run (any review waits for the end)
        const late = steering();
        if (late.length) {
          history.push({ role: "user", content: late });
          tookMessage(late);
          persist();
          continue;
        }
      }
      if (final.stop_reason === "end_turn" && edits && !route.small && !gated && step < settings.maxSteps - 2) {
        gated = true;
        const gate = await finishGate(openAtStart);
        if (stale()) break;
        if (gate) {
          push({ kind: "notice", id: nid(), level: "info", title: gate.title, detail: gate.detail });
          history.push({ role: "user", content: [{ type: "text", text: gate.text }] });
          persist();
          continue;
        }
      }
      if (final.stop_reason === "end_turn" && edits && !route.small && step < settings.maxSteps - 2 && (await autoReview(session, reviewItems, startSource, stale, reviewMode(route)))) continue;
      const uses = content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      // rows for calls a fallback discarded never run
      const dropped = new Set([...live.toolRows.values()].filter((id) => !uses.some((u) => (get().items.find((i) => i.id === id) as { toolUseId?: string } | undefined)?.toolUseId === u.id)));
      if (dropped.size) set((s) => ({ items: s.items.filter((i) => !dropped.has(i.id)) }));
      if (cutNote && !uses.length) {
        history.push({ role: "user", content: [{ type: "text", text: cutNote }] });
        persist();
        continue;
      }
      if (final.stop_reason !== "tool_use" && !cutNote) break;

      const results: BetaToolResultBlockParam[] = [];
      let ask: { toolUseId: string; outcome: ToolOutcome } | null = null;
      let pausedAfter: string | null = null;
      let offered: string | null = null;
      // the last change in a response comes back with the build and checks, unless Claude asks for run_checks after it
      let lastChange = uses.length - 1;
      while (lastChange >= 0 && !CHECKED_TOOLS.has(uses[lastChange].name)) lastChange--;
      const checkAt = uses.slice(lastChange + 1).some((u) => u.name === "run_checks") ? -1 : lastChange;
      // a review asked for in the same response as a change waits for it, and is held when the change broke something
      const reviewAfterChange = uses.some((u, i) => u.name === "review_design" && uses.slice(0, i).some((e) => EDIT_TOOLS.has(e.name) || e.name === "update_brief"));
      const failingBefore = reviewAfterChange ? failingChecks() : null;
      let changed = false;
      let changeFailed = false;
      for (const [i, u] of uses.entries()) {
        if (ac.signal.aborted) break;
        if (pausedAfter) {
          // the user asked to review once that step was done: nothing after it runs
          set((s) => ({ items: s.items.filter((i) => !(i.kind === "tool" && i.toolUseId === u.id)) }));
          results.push({ type: "tool_result", tool_use_id: u.id, content: `Not run: the user asked to pause for review after “${pausedAfter}”. Wait for them.`, is_error: true });
          continue;
        }
        const itemId = [...live.toolRows.values()].find((id) => (get().items.find((i) => i.id === id) as { toolUseId?: string } | undefined)?.toolUseId === u.id) ?? nid();
        const ran = Date.now();
        if (!get().items.some((i) => i.id === itemId)) push({ kind: "tool", id: itemId, toolUseId: u.id, name: u.name, status: "running", title: TOOL_TITLES[u.name] ?? u.name, ran });
        else patch(itemId, (it) => (it.kind === "tool" ? { ...it, status: "running", title: TOOL_TITLES[u.name] ?? u.name, ran } : it));
        const mirrored = u.name !== "update_plan" && u.name !== "suggest_next_steps";
        if (mirrored) mainActivityStart(itemId, TOOL_TITLES[u.name] ?? u.name);
        // the change card's "before" picture is taken before the first edit lands
        if (!edits && EDIT_TOOLS.has(u.name)) await Promise.race([before, new Promise((r) => setTimeout(r, 4000))]);
        if (stale()) return;
        // Claude reads and edits the real design, never one the user is previewing
        endPreview();
        let outcome: ToolOutcome;
        try {
          const held = u.name === "review_design" && failingBefore && (changed || changeFailed) ? await reviewHold(failingBefore, changeFailed) : null;
          outcome = held ?? (u.name === "review_design" ? await reviewTool(u.input, itemId, session, reviewItems, startSource) : await runTool(u.name, u.input, { signal: ac.signal, toolUseId: u.id, check: CHECKED_TOOLS.has(u.name) ? i === checkAt : undefined }));
        } catch (e) {
          outcome = { isError: true, content: `Tool failed: ${e instanceof Error ? e.message : String(e)}`, card: { title: "Tool failed", detail: e instanceof Error ? e.message : String(e), status: "error" } };
        }
        if (stale()) return;
        if (mirrored) mainActivityEnd(itemId, outcome.isError ? "error" : "done", outcome.ask ? "Asked you" : outcome.card.title);
        else if (u.name === "update_plan") pausedAfter = takePauseHit();
        if (outcome.ask) {
          set((s) => ({ items: s.items.filter((i) => i.id !== itemId) }));
          ask = { toolUseId: u.id, outcome };
          continue;
        }
        // the checklist card stands for record_asks; it is updated after every change
        if (u.name === "record_asks" && !outcome.isError) set((s) => ({ items: s.items.filter((i) => i.id !== itemId) }));
        syncAsks();
        if (outcome.suggest) {
          set((s) => ({ items: s.items.filter((i) => i.id !== itemId) }));
          offered = nid();
          push({ kind: "suggest", id: offered, options: outcome.suggest });
          results.push({ type: "tool_result", tool_use_id: u.id, content: outcome.content as BetaToolResultBlockParam["content"] });
          continue;
        }
        if (EDIT_TOOLS.has(u.name) || u.name === "update_brief") {
          if (outcome.isError) changeFailed = true;
          else {
            changed = true;
            edits++;
            lastEditedSource = sourceSeen = useDesign.getState().source;
          }
        } else if (u.name === "get_design") sourceSeen = useDesign.getState().source;
        patch(itemId, (it) =>
          it.kind === "tool"
            ? { ...it, status: outcome.card.status ?? (outcome.isError ? "error" : "done"), title: outcome.card.title, detail: outcome.card.detail, diff: outcome.card.diff, image: outcome.card.image, ms: Date.now() - ran }
            : it,
        );
        results.push({ type: "tool_result", tool_use_id: u.id, content: outcome.content as BetaToolResultBlockParam["content"], is_error: outcome.isError || undefined });
      }
      if (ac.signal.aborted) {
        // every tool_use needs a result before the next request
        const why = redirect ? "Not run: the user interrupted to change the plan; their changes follow." : "Stopped by the user before this ran.";
        for (const u of uses) if (!results.some((r) => r.tool_use_id === u.id) && u.id !== ask?.toolUseId) results.push({ type: "tool_result", tool_use_id: u.id, content: why, is_error: true });
        if (ask) results.push({ type: "tool_result", tool_use_id: ask.toolUseId, content: redirect ? why : "Stopped by the user.", is_error: true });
        history.push({ role: "user", content: results });
        break;
      }
      if (ask) {
        // the answer to ask_user arrives with the user's next action, together with these results
        const cid = nid();
        push({ kind: "choice", id: cid, toolUseId: ask.toolUseId, title: ask.outcome.ask!.title, question: ask.outcome.ask!.question, options: ask.outcome.ask!.options });
        set({ pendingChoice: { toolUseId: ask.toolUseId, itemId: cid, results } });
        break;
      }
      pausedAfter ??= takePauseHit();
      const atLimit = step === settings.maxSteps - 1;
      // on a pause or at the step limit the user's changes and messages wait, so they go with the next message Claude acts on
      const steer = pausedAfter || atLimit ? [] : steering();
      history.push({ role: "user", content: [...results, ...(cutNote ? [{ type: "text" as const, text: cutNote }] : []), ...steer] });
      tookMessage(steer);
      persist();
      if (pausedAfter) {
        push({ kind: "notice", id: nid(), level: "info", title: `Paused after “${pausedAfter}”`, detail: "You asked to review here. Look it over, change the plan if you like, then continue.", action: "continue" });
        history.push({ role: "assistant", content: [{ type: "text", text: `(Paused for the user's review after “${pausedAfter}”, as they asked.)` }] });
        break;
      }
      // offering next steps closes the turn; the results wait for the user's next message
      if (offered && uses.every((u) => u.name === "suggest_next_steps")) {
        // this is where the turn ends, so Claude's changes are reviewed here; the chips go if Claude has more to do,
        // as they do when the user changed the plan or sent a message meanwhile (any review waits for the end)
        const more = steer.length > 0 || (edits && !route.small && step < settings.maxSteps - 2 && (await autoReview(session, reviewItems, startSource, stale, reviewMode(route))));
        if (!more) break;
        const chips = offered;
        set((st) => ({ items: st.items.filter((i) => i.id !== chips) }));
        continue;
      }
      if (atLimit) {
        push({ kind: "notice", id: nid(), level: "info", title: `Paused after ${settings.maxSteps} steps`, detail: "Say “continue” to let Claude keep going. You can raise the limit in Settings." });
        history.push({ role: "assistant", content: [{ type: "text", text: "(Paused at the step limit.)" }] });
      }
    }
  } catch (e) {
    if (stale()) return;
    if (!(redirect && isAbort(e))) handleError(e);
    // leave history ending with the user turn so retry can resend it
    if (history.length && history[history.length - 1].role === "assistant") {
      const last = history[history.length - 1];
      const hasTool = typeof last.content !== "string" && last.content.some((b) => b.type === "tool_use");
      if (hasTool) history.pop();
    }
  } finally {
    if (turnBox === box) turnBox = null;
    if (!stale()) finishLoop();
  }
  if (stale()) return;
  if (redirect) {
    redirect = false;
    await resumeWithSteering();
  }

  function finishLoop() {
    set((s) => ({ busy: false, items: s.items.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it.kind === "tool" && it.status === "running" ? { ...it, status: "error" as const, detail: "Stopped" } : it)) }));
    const after = useDesign.getState().source;
    if (edits && after !== startSource) {
      const tid = nid();
      push({ kind: "turn", id: tid, before: startSource, after, edits });
      void changeShots(before, after).then((shots) => {
        if (!shots || !get().items.some((i) => i.id === tid)) return;
        patch(tid, (it) => (it.kind === "turn" ? { ...it, shots } : it));
        persist();
      });
    }
    void settleAsks(stale);
    // what the turn cost and which model answered, under the reply
    if (box.spend.cost > 0 && routeNote) push({ kind: "cost", id: nid(), spend: box.spend, route: routeNote, historyStart });
    // Claude has now seen the brief as it stands
    set({ briefSeen: briefKey(currentBrief()) });
    if (abort === ac) abort = null;
    settleActivity();
    persist();
  }
}

let redirect = false;
const isAbort = (e: unknown) => e instanceof Anthropic.APIUserAbortError || (e instanceof Error && e.name === "AbortError");

/**
 * Apply the user's plan changes now instead of at the next tool boundary:
 * stop the response in progress and continue with the changes. When Claude
 * is idle, the changes go as a message of their own.
 */
export async function applyPlanChangesNow() {
  if (!pendingSteering(usePlan.getState()).length) return;
  if (!get().busy) {
    // messages are already in the chat: with nothing else waiting, they go as they are
    const said = describeSteering(usePlan.getState());
    await (said ? sendMessage(said, { design: true }) : sendQueuedNow());
    return;
  }
  // sub-agents run inside the main loop's current action; they take their own changes at their next step
  if (!abort || redirect || anyBranchOpen()) return;
  redirect = true;
  abort.abort();
}

async function resumeWithSteering() {
  const blocks = steering();
  if (!blocks.length) return;
  const onlyMessages = hasMessage(blocks) && !blocks[0].text.includes("<plan-changes>");
  push({ kind: "notice", id: nid(), level: "info", title: onlyMessages ? "Interrupted to take your message now" : "Interrupted to apply your plan changes" });
  const last = history[history.length - 1];
  if (last?.role === "user" && typeof last.content !== "string") history[history.length - 1] = { ...last, content: [...last.content, ...blocks] };
  else history.push({ role: "user", content: [{ type: "text", text: contextNote() }, ...blocks] });
  persist();
  await runLoop();
}

/** Review Claude's own changes when it is about to finish without having had them reviewed. Returns true when Claude should continue. */
async function autoReview(session: ReviewSession, reviewItems: string[], startSource: string, stale: () => boolean, mode = useSettings.getState().selfReview): Promise<boolean> {
  if (mode === "off" || !session.canReview || !claudeRoute()) return false;
  const now = useDesign.getState().source;
  const base = session.lastSource ?? startSource;
  if (now === base) return false;
  // on "Big changes", small edits are reviewed only when they answer open findings
  const answering = session.findings.some((f) => (f.status === "fixed" || f.status === "open" || f.status === "still_open") && f.severity !== "minor");
  if (mode === "auto" && !answering && !isSubstantial(base, now)) return false;
  const itemId = nid();
  push({ kind: "review", id: itemId, auto: true, round: session.round + 1, status: "running", progress: { stage: "waiting", views: [] } });
  const r = await reviewInto(itemId, session, reviewItems, true, base);
  if (stale() || "error" in r) return false;
  const text = designerReport(r, session.roundsLeft, true);
  // after a suggest_next_steps turn the history ends with its results, so the review joins that user turn
  const content = reviewContent(r, text) as BetaContentBlockParam[];
  const last = history[history.length - 1];
  if (last?.role === "user" && typeof last.content !== "string") history[history.length - 1] = { ...last, content: [...last.content, ...content] };
  else history.push({ role: "user", content });
  persist();
  // nothing to act on: the reply stands, and Claude knows about the review next turn
  return r.verdict !== "pass";
}

/** Thorough reviews every change; otherwise the Settings choice. */
const reviewMode = (r: Route) => (r.speed === "thorough" ? "always" : useSettings.getState().selfReview);

/** The id of the checklist card for the message in hand, so new measurements update it in place. */
let asksCard = "";
let asksShown = -1;

/** Show the newest measurement of the user's asks: the card is added when Claude records them and updated after each change. */
function syncAsks() {
  const a = asksState();
  if (a.version === asksShown) return;
  asksShown = a.version;
  if (!a.asks.length) return;
  const card = { asks: a.results.map((r) => ({ ...r })), unasked: [...a.unasked] };
  if (asksCard && get().items.some((i) => i.id === asksCard)) patch(asksCard, (it) => (it.kind === "asks" ? { ...it, ...card } : it));
  else {
    asksCard = nid();
    push({ kind: "asks", id: asksCard, ...card });
  }
}

/** After a run, measure the asks once more if the design changed since (an agents' build, a change with no checks). */
async function settleAsks(isStale: () => boolean) {
  const a = asksState();
  if (!a.asks.length || a.measuredOn === useDesign.getState().source) return;
  const s = await whenChecked(30_000).catch(() => null);
  if (!s || isStale() || s.kernelStatus === "error") return;
  await remeasure({ source: s.source, model: s.model }, kernelGeo);
  if (isStale()) return;
  syncAsks();
  persist();
}

/**
 * Before Claude finishes a run that changed the design: the checks its changes left failing, every completeness
 * check that fails (an unjoined frame joint, hardware named in held: but not drawn, a stand-in box with a catalogue
 * part for it, an unwired board), and the completeness warnings the run left that were not there when it started
 * (an empty screw hole, a stand-in with no catalogue part, a machine that cannot be run). Warnings already there at
 * the start were sent back for, or explained, in an earlier run, so they do not cost a turn every time. Null when
 * there is nothing to send it back for.
 */
async function finishGate(before: Set<string>): Promise<{ text: string; title: string; detail: string } | null> {
  const s = await whenChecked(60_000).catch(() => null);
  if (!s?.model || s.kernelStatus === "error") return null;
  await whenWiringChecked(s.model, 20_000).catch(() => undefined);
  const items = useDesign.getState().report?.items ?? [];
  const fails = items.filter((c) => isOpen(c) && ((c.status === "fail" && c.id.startsWith("complete:")) || !before.has(c.id)));
  if (!fails.length) return null;
  const list = fails.slice(0, 10).map((c) => `- ${c.title}${c.fix ? ` (fix: ${c.fix})` : ""}`);
  if (fails.length > 10) list.push(`- and ${fails.length - 10} more (run_checks lists them)`);
  return {
    title: `Sent back to finish: ${fails.length} problem${fails.length > 1 ? "s" : ""} left`,
    detail: fails
      .slice(0, 6)
      .map((c) => c.title)
      .join("\n"),
    text: `Kerf: before you finish, the design still has ${fails.length} problem${fails.length > 1 ? "s" : ""} that make${fails.length > 1 ? "" : "s"} it incomplete or that your changes left failing:\n${list.join("\n")}\nFix them (place_fasteners fills empty screw holes and joins profiles; catalogue parts replace stand-in boxes; wire and mount every board). If one cannot be fixed without the user, say which and why in your reply.`,
  };
}

/** A check the finish gate can send Claude back for: a failure, or a completeness warning (an empty screw hole and the like). */
const isOpen = (c: { id: string; status: string }) => c.status === "fail" || (c.status === "warn" && c.id.startsWith("complete:"));

/** The open checks of the current report (failures and completeness warnings), by id. */
function openChecks(): Set<string> {
  return new Set((useDesign.getState().report?.items ?? []).filter(isOpen).map((c) => c.id));
}

/** The failing checks of the current report, by id. */
function failingChecks(): Set<string> {
  return new Set((useDesign.getState().report?.items ?? []).filter((c) => c.status === "fail").map((c) => c.id));
}

/**
 * A review asked for in the same response as a change, held when the change failed or left a check failing that did
 * not fail before (a source or build error among them): the designer fixes those first (the change's result lists
 * them), and no review round is used. Null when the review can run.
 */
async function reviewHold(before: Set<string>, changeFailed: boolean): Promise<ToolOutcome | null> {
  if (changeFailed) {
    return {
      content: "Not reviewed: a change above was not applied, so the design is not what you meant to have reviewed. Fix that change, then call review_design again in the same response as the fix. No review round was used.",
      card: { title: "Review held", detail: "A change in this step was not applied" },
    };
  }
  await whenChecked(60_000);
  const fails = (useDesign.getState().report?.items ?? []).filter((c) => c.status === "fail" && !before.has(c.id));
  if (!fails.length) return null;
  const titles = fails.slice(0, 6).map((c) => c.title).join("; ") + (fails.length > 6 ? `; and ${fails.length - 6} more` : "");
  return {
    content: `Not reviewed yet: the changes above left ${fails.length} check${fails.length > 1 ? "s" : ""} failing that did not fail before (${titles}); the change's result above has the details. Fix them, then call review_design again in the same response as the fix. If one has to stay, call review_design on its own and say why in focus. No review round was used.`,
    card: { title: "Review held", detail: `${fails.length} new failing check${fails.length > 1 ? "s" : ""} to fix first` },
  };
}

/** Claude's review_design tool: record its answers to earlier findings, then run the next round. */
async function reviewTool(input: unknown, itemId: string, session: ReviewSession, reviewItems: string[], startSource: string): Promise<ToolOutcome> {
  const p = ReviewInput.safeParse(input ?? {});
  if (!p.success) return { isError: true, content: `Invalid tool input: ${p.error.issues.map((i) => i.message).join("; ")}`, card: { title: "Invalid review request", status: "error" } };
  const unknown = session.respond(p.data.responses ?? []);
  syncFindings(session, reviewItems);
  if (!session.canReview) {
    return {
      content: `No review rounds left for this reply (${session.maxRounds} used). Tell the user which findings are still open and why.${unknown.length ? ` Unknown finding ids: ${unknown.join(", ")}.` : ""}`,
      card: { title: "Review limit reached", detail: `${session.maxRounds} rounds per reply. You can change this in Settings.` },
    };
  }
  const r = await reviewInto(itemId, session, reviewItems, false, session.lastSource ?? startSource, p.data.focus);
  if ("error" in r) return { isError: true, content: `The review could not run: ${r.error}`, card: { title: "Review could not run", detail: r.error, status: "error" } };
  const text = designerReport(r, session.roundsLeft, false) + (unknown.length ? `\nNote: these finding ids were not recognised: ${unknown.join(", ")}.` : "");
  return { content: reviewContent(r, text), card: { title: "Reviewed the design" } };
}

/** The next request, after leaving out thinking that edits to the history invalidated (see settleEdits). */
function buildRequest(system: ReturnType<typeof systemBlocks>, route: Route, settings: Pick<Settings, "webSearch">): Record<string, unknown> {
  // web search can switch off mid-run (a key that cannot use it), which changes the tools
  const tools = requestTools(settings);
  const off = unsupported(route.model);
  const marks = marksOn(off);
  settleEdits(system, tools);

  // Every model gets the same system prompt, tools and messages, thinking blocks
  // included: a model that cannot read another model's blocks leaves them out
  // of that request (unbilled), and they count again when the turn returns to
  // the model that wrote them.
  const msgs = sendable(history, tools, marks);
  const params: Record<string, unknown> = {
    model: route.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    tools,
    messages: withCacheBreakpoint(msgs, lastBreak.get(route.model)),
  };
  lastBreak.set(route.model, newestUser(msgs));
  const betas: string[] = [];
  if (!off.has("thinking")) {
    const thinking: Record<string, unknown> = { type: "adaptive", display: useSettings.getState().showThinking ? "summarized" : "omitted" };
    // a block that still doesn't match is dropped by the API instead of failing the request
    if (!off.has("binding")) {
      thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
      betas.push(BINDING_BETA);
    }
    params.thinking = thinking;
  }
  if (!off.has("effort")) params.output_config = { effort: route.effort };
  // Haiku models have no server-side fallback to send a refusal to
  if (!off.has("fallbacks") && !route.model.startsWith("claude-haiku")) {
    params.fallbacks = "default";
    betas.push(FALLBACK_BETA);
  }
  // a conversation that starts from a summary needs the summary's opt-in on every request
  if (hasCompaction(history)) betas.push(COMPACT_BETA);
  if (hasEffortMarks(msgs)) betas.push(STEP_EFFORT_BETA);
  if (betas.length) params.betas = betas;
  return params;
}

/** The history as this request can send it: earlier web results become plain notes when it can't carry them (a copy, so the history itself only grows). */
function sendable(h: BetaMessageParam[], tools: unknown[], marks: boolean): BetaMessageParam[] {
  const hasWeb = (tools as { type?: string }[]).some((t) => typeof t.type === "string" && /^web_(search|fetch)_/.test(t.type));
  const out = flatServer && !hasWeb ? flattenServerTools(h).history : h;
  // a model that refused effort marks gets the conversation without them
  return marks ? out : withoutEffortMarks(out);
}

/**
 * The history must only have grown since the last request: where an earlier
 * message, the system prompt or the tools changed, the thinking blocks from
 * that point on are removed, because Claude rejects them. Records what is sent now.
 */
function settleEdits(system: ReturnType<typeof systemBlocks>, tools: unknown[]) {
  const binding = bindingKey(system, tools);
  // effort marks count as sent even to a model that refuses them: leaving them out of one request is not an edit worth losing thinking over (drop_block covers it)
  let keys = messageKeys(sendable(history, tools, true));
  if (sent) {
    const at = sent.binding !== binding ? 0 : firstEdit(sent.keys, keys);
    if (at >= 0 && hasThinking(history, at)) {
      const n = stripThinking(history, at);
      keys = messageKeys(sendable(history, tools, true));
      console.warn(`[kerf] ${at === 0 && sent.binding !== binding ? "The system prompt or tools changed" : `Chat message ${at} changed`} since the last request; left out ${n} thinking block(s) from there on.`);
    }
  }
  sent = { binding, keys };
}

/** Thinking blocks the API dropped mean the history changed in a way buildRequest missed: worth knowing about. */
function reportDroppedThinking(list: readonly { type: string; path?: string; reason?: string }[] | null | undefined) {
  const dropped = (list ?? []).filter((t) => t.type === "thinking_dropped");
  if (!dropped.length) return;
  const changed = dropped.filter((t) => t.reason === "prefix_binding_mismatch");
  // model_binding_mismatch is expected after switching models in Settings
  if (changed.length) console.warn(`[kerf] Claude dropped ${changed.length} thinking block(s) whose conversation changed, first at ${changed[0].path}.`);
  else console.info(`[kerf] Claude left out ${dropped.length} thinking block(s) from another model.`);
}

/** Which optional request feature a 400 is about, if the model rejected one. */
function rejectedFeature(msg: string, off: ReadonlySet<Feature>): Feature | null {
  if (msg.includes("block_binding") || msg.includes("thinking-binding")) return "binding";
  // an effort level set inside the conversation (see stepEffort), before the request's own
  if (msg.includes("per-turn effort") || msg.includes("mid-conversation-output-config") || (/\broles?\b/.test(msg) && /system|user.{0,3} or .{0,3}assistant/.test(msg))) return "stepEffort";
  if (msg.includes("effort") || msg.includes("output_config")) return "effort";
  if (msg.includes("fallback")) return "fallbacks";
  if (msg.includes("thinking")) return "thinking";
  if (msg.includes("beta")) return !off.has("binding") ? "binding" : "fallbacks";
  return null;
}

interface StreamOptions {
  /** a design-model request: the one kept warm in the cache */
  design: boolean;
  /** stop as soon as the response starts calling a tool this rejects (a quick turn reaching for an edit) */
  stopOnTool?: (name: string) => boolean;
}

async function streamOnce(anthropic: Anthropic, build: () => Record<string, unknown>, live: Live, carried: unknown[], signal: AbortSignal, opts: StreamOptions = { design: true }) {
  let strippedOnce = false;
  let busy = 0;
  for (let attempt = 0; attempt < 7; attempt++) {
    const params = build();
    const at = Date.now();
    let started = false;
    let stoppedFor: string | null = null;
    let streamedChars = 0;
    const stream = anthropic.beta.messages.stream(params as never, { signal });
    try {
      stream.on("streamEvent", (ev, snapshot) => {
        if (!started) {
          started = true;
          requestStarted(String(params.model), params, at, opts.design);
        }
        if (stoppedFor) return;
        if (ev.type === "content_block_start") {
          const b = ev.content_block as { type: string; id?: string; name?: string };
          if (b.type === "tool_use" && b.name && opts.stopOnTool?.(b.name)) {
            stoppedFor = b.name;
            stream.abort();
            return;
          }
          if (b.type === "tool_use" && b.id && b.name) {
            const id = nid();
            live.toolRows.set(ev.index, id);
            live.created.push(id);
            push({ kind: "tool", id, toolUseId: b.id, name: b.name, status: "running", title: TOOL_TITLES[b.name] ?? b.name, inputChars: 0 });
          } else if (b.type === "server_tool_use" && b.id && b.name && isWebTool(b.name)) {
            upsertWebRow(live, describeWebCall(b.name, b.id, {}));
          } else if (b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") {
            syncWeb(live, [...carried, ...snapshot.content]);
          } else if (b.type === "text" || b.type === "thinking") {
            // text after a search row starts a new bubble below it
            const items = get().items;
            if (items[items.length - 1]?.id !== bubbleOf(live)) newBubble(live);
          }
        } else if (ev.type === "content_block_stop") {
          const type = (snapshot.content[ev.index] as { type?: string } | undefined)?.type;
          // the search query or page address is complete: show it
          if (type === "server_tool_use") syncWeb(live, [...carried, ...snapshot.content]);
          // how long Claude thought, for the "Thought for 8 s" line
          else if (type === "thinking") {
            const now = Date.now();
            patch(bubbleOf(live), (it) => (it.kind === "assistant" && it.started ? { ...it, thoughtMs: now - it.started } : it));
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
          streamedChars += (d.text ?? d.thinking ?? d.partial_json ?? "").length;
          const bubble = bubbleOf(live);
          if (d.type === "text_delta" && d.text) queueDelta(bubble, { text: d.text });
          else if (d.type === "thinking_delta" && d.thinking) queueDelta(bubble, { thinking: d.thinking });
          else if (d.type === "input_json_delta" && d.partial_json) {
            const id = live.toolRows.get(ev.index);
            if (id) queueDelta(id, { inputChars: d.partial_json.length });
          }
        }
      });
      const final = await stream.finalMessage();
      flushDeltas();
      return { final, params };
    } catch (e) {
      flushDeltas();
      if (stoppedFor) {
        // billed for what it read and wrote before stopping
        const u = stream.currentMessage?.usage;
        throw new NeedsDesignModel(handoverWhy(stoppedFor), {
          input_tokens: u?.input_tokens ?? 0,
          cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
          output_tokens: Math.max(u?.output_tokens ?? 0, Math.ceil(streamedChars / 3.6)),
        });
      }
      if (opts.design) requestFailed(params);
      if (e instanceof Anthropic.BadRequestError) {
        const msg = e.message || "";
        const hasWeb = ((params.tools as { type?: string }[] | undefined) ?? []).some((t) => typeof t.type === "string" && /^web_(search|fetch)_/.test(t.type));
        let retry = false;
        if (isThinkingSignatureError(msg)) {
          // a thinking block that no longer belongs to this conversation: send the
          // history without thinking once (text and tool calls stay), then carry on
          if (!strippedOnce && hasThinking(history)) {
            strippedOnce = true;
            const n = stripThinking(history);
            console.warn(`[kerf] Claude rejected an earlier thinking block; resent the chat without ${n} thinking block(s).`);
            retry = true;
          }
        } else if (hasWeb && isWebToolError(msg)) {
          // this key or model cannot use web search: carry on without it
          webUnavailable = true;
          push({ kind: "notice", id: nid(), level: "info", title: "Web search is not available with this key or model", detail: "Claude carries on with the parts catalog. An organisation admin can allow web search in the Claude Console." });
          retry = true;
        } else if (!hasWeb && !flatServer && isServerBlockError(msg)) {
          // earlier web results the request can no longer carry: send them as plain notes from now on
          if (flattenServerTools(history).changed) {
            flatServer = true;
            retry = true;
          }
        } else {
          // a model that rejects an optional feature: drop it and retry
          const off = unsupported(String(params.model));
          const feature = rejectedFeature(msg.toLowerCase(), off);
          if (feature && !off.has(feature)) {
            off.add(feature);
            retry = true;
          }
        }
        if (retry) {
          // clear whatever streamed before the error, including tool cards
          resetLive(live);
          continue;
        }
      }
      // busy, overloaded or cut off, even part-way through: wait and send it again rather than end the run
      // (a quick answer is handed to the design model instead)
      const wait = opts.design ? retryWait(e, busy) : null;
      if (wait !== null && !signal.aborted) {
        busy++;
        resetLive(live);
        const note = nid();
        push({ kind: "notice", id: note, level: "info", title: "Claude is busy", detail: `Trying again in ${wait} s.` });
        await pause(wait * 1000, signal);
        set((s) => ({ items: s.items.filter((i) => i.id !== note) }));
        continue;
      }
      throw e;
    }
  }
  throw new Error("The request could not be completed.");
}

/** Every tool_use needs a matching tool_result in the next user turn; patch any gap left by a crash or reload. */
function repairHistory() {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    // a tool result needs its tool_use in the turn just before; one without it (from a turn that was cut off) fails every request
    if (m.role === "user" && typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result")) {
      const prev = messageBefore(history, i);
      const ids = new Set(prev?.role === "assistant" && typeof prev.content !== "string" ? prev.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id) : []);
      const content = m.content.filter((b) => b.type !== "tool_result" || ids.has((b as BetaToolResultBlockParam).tool_use_id));
      if (content.length !== m.content.length) history[i] = { ...m, content: content.length ? content : [{ type: "text", text: "(An interrupted step was dropped here.)" }] };
    }
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const uses = m.content.filter((b) => b.type === "tool_use") as { id: string }[];
    if (!uses.length) continue;
    const at = indexAfter(history, i);
    const next = history[at];
    const have = new Set(next && next.role === "user" && typeof next.content !== "string" ? next.content.filter((b) => b.type === "tool_result").map((b) => (b as BetaToolResultBlockParam).tool_use_id) : []);
    const missing: BetaToolResultBlockParam[] = uses.filter((u) => !have.has(u.id)).map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "This step was interrupted and did not run.", is_error: true }));
    if (!missing.length) continue;
    if (next && next.role === "user") {
      const content = typeof next.content === "string" ? [{ type: "text" as const, text: next.content }] : next.content;
      history[at] = { ...next, content: [...missing, ...content] };
    } else history.splice(at, 0, { role: "user", content: missing });
  }
}

/** per model, the message the last request's rolling cache breakpoint was on */
const lastBreak = new Map<string, number>();

/**
 * A rolling cache breakpoint on the newest user content, and another where
 * the previous request to the same model put it. The API looks back at most
 * 20 blocks from a breakpoint for a cached prefix, so a turn that added more
 * since (a quick turn with many reads in between, many parallel tool calls)
 * would otherwise miss the whole conversation.
 */
/** The newest user message: a resumed web search turn may follow it. */
function newestUser(h: readonly BetaMessageParam[]): number {
  let i = h.length - 1;
  while (i > 0 && h[i].role !== "user") i--;
  return i;
}

export function withCacheBreakpoint(h: BetaMessageParam[], prev?: number): BetaMessageParam[] {
  if (!h.length) return h;
  const out = h.slice();
  const i = newestUser(out);
  markCache(out, i);
  if (prev !== undefined && prev < i) markCache(out, prev);
  return out;
}

function markCache(out: BetaMessageParam[], i: number) {
  const m = out[i];
  if (m.role !== "user" || typeof m.content === "string" || !m.content.length) return;
  const blocks = m.content.slice();
  const lb = blocks[blocks.length - 1];
  // a review's report ends in its contact sheet, an answer to a question can end in a marked-up picture
  if (lb.type !== "text" && lb.type !== "tool_result" && lb.type !== "image" && lb.type !== "document") return;
  blocks[blocks.length - 1] = { ...lb, cache_control: { type: "ephemeral" } } as BetaContentBlockParam;
  out[i] = { ...m, content: blocks };
}

function handleError(e: unknown) {
  if (isAbort(e)) {
    push({ kind: "notice", id: nid(), level: "info", title: "Stopped" });
    return;
  }
  if (e instanceof Anthropic.AuthenticationError && (e.error as { error?: unknown } | undefined)?.error === "signed_out") {
    sessionEnded();
    push({ kind: "notice", id: nid(), level: "error", title: "You were signed out of Kerf", detail: "Sign in again to keep using the Claude key on your account.", action: "settings" });
    return;
  }
  if (e instanceof Anthropic.AuthenticationError) {
    push({ kind: "notice", id: nid(), level: "error", title: "Your API key was not accepted", detail: "Check that the key is active in the Claude Console, then update it in Settings.", action: "settings" });
    return;
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    push({ kind: "notice", id: nid(), level: "error", title: "This key cannot use the selected model", detail: "Pick another model in Settings, or check your organisation's access in the Claude Console.", action: "settings" });
    return;
  }
  if (e instanceof Anthropic.RateLimitError) {
    const after = e.headers?.get?.("retry-after");
    push({ kind: "notice", id: nid(), level: "warn", title: "Rate limit reached", detail: after ? `Try again in about ${after} seconds.` : "Wait a moment and try again.", action: "retry" });
    return;
  }
  if (e instanceof Anthropic.APIConnectionError) {
    push({ kind: "notice", id: nid(), level: "error", title: "Could not reach the Claude API", detail: navigator.onLine ? "Check your connection or any network filter that blocks api.anthropic.com." : "You appear to be offline.", action: "retry" });
    return;
  }
  if (e instanceof Anthropic.BadRequestError && promptTooLong(e.message) !== null) {
    push({ kind: "notice", id: nid(), level: "error", title: "This conversation is too long for Claude", detail: "Kerf could not summarise the earlier turns to make room. Press Try again to have another go, or clear the chat to start afresh: the design and its versions stay as they are.", action: "retry" });
    return;
  }
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
    // a file the API cannot take (too large, damaged, a protected PDF) would fail every retry: drop it from the turn
    if ((status === 400 || status === 413) && /image|document|pdf|too large|request_too_large|media/i.test(e.message) && dropLastFiles()) {
      push({ kind: "notice", id: nid(), level: "warn", title: "Claude could not read an attached file", detail: `${cleanApiMessage(e.message)} The file was taken out of this message; Retry sends the rest.`, action: "retry" });
      return;
    }
    const overloaded = status === 529 || /overloaded/i.test(e.message);
    push({
      kind: "notice",
      id: nid(),
      level: "error",
      title: overloaded ? "Claude is busy right now" : `The Claude API returned an error${status ? ` (${status})` : ""}`,
      detail: overloaded ? "Try again in a little while, or switch to another model in Settings." : cleanApiMessage(e.message),
      action: "retry",
    });
    return;
  }
  push({ kind: "notice", id: nid(), level: "error", title: "Something went wrong", detail: e instanceof Error ? e.message : String(e), action: "retry" });
}

/** Replace pictures and files in the newest user turn with a note. Returns false when it had none. */
function dropLastFiles() {
  const i = history.length - 1;
  const last = history[i];
  if (!last || last.role !== "user" || typeof last.content === "string" || !last.content.some((b) => heavy(b) || (b.type === "tool_result" && Array.isArray(b.content) && b.content.some(heavy)))) return false;
  history[i] = { ...last, content: last.content.map((b) => (heavy(b) ? { type: "text" as const, text: FILE_NOTE } : b.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: b.content.map((c) => (heavy(c) ? OMITTED : c)) } : b)) };
  return true;
}

function cleanApiMessage(m: string) {
  // never echo anything that looks like a key back into the UI
  return m.replace(/sk-[A-Za-z0-9_-]+/g, "sk-ant-…").slice(0, 800);
}

export async function testKey(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const c = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 20000 });
    await c.models.list({ limit: 1 });
    return { ok: true, message: "Key works." };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, message: "The key was rejected. Check it in the Claude Console." };
    if (e instanceof Anthropic.APIConnectionError) return { ok: false, message: "Could not reach api.anthropic.com. Check your connection." };
    if (e instanceof Anthropic.APIError) return { ok: false, message: cleanApiMessage(e.message) };
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
