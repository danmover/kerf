// The design assistant: a streaming tool-use loop against the Claude API,
// run directly from the browser with the user's own API key.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaContentBlockParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { create } from "zustand";
import { getApiKey } from "../persist/vault";
import * as db from "../persist/db";
import { useSettings, type Settings } from "../app/settings";
import { useDesign } from "../core/engine";
import { useView } from "../app/view";
import { commitSource } from "../app/project";
import { systemPrompt } from "./prompt";
import { TOOL_DEFS, TOOL_TITLES, runTool, modelSummary, reportSummary, type ToolOutcome } from "./tools";
import { webTools, webActivity, describeWebCall, citedSources, isWebTool, isPausedTurn, stripThinking, flattenServerTools, echoContent, isThinkingBindingError, isWebToolError, isServerBlockError, type WebActivity } from "./web";

export type ChatItem =
  | { kind: "user"; id: string; text: string; ts: number }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean; model?: string; note?: string; sources?: { url: string; title: string }[] }
  | { kind: "tool"; id: string; toolUseId: string; name: string; status: "running" | "done" | "error"; title: string; detail?: string; diff?: { before: string; after: string }; image?: string; inputChars?: number; link?: { url: string; label: string }; web?: boolean }
  | { kind: "choice"; id: string; toolUseId: string; question: string; options: { label: string; consequence: string; recommended?: boolean }[]; chosen?: string }
  | { kind: "notice"; id: string; level: "error" | "warn" | "info"; title: string; detail?: string; action?: "settings" | "retry" }
  | { kind: "turn"; id: string; before: string; after: string; edits: number; reverted?: boolean };

interface ChatState {
  projectId: string | null;
  items: ChatItem[];
  busy: boolean;
  /** a choice card waiting for the user, with the results of tools that ran beside it */
  pendingChoice: { toolUseId: string; itemId: string; results: BetaToolResultBlockParam[] } | null;
  lastUserText: string;
}

export const useChat = create<ChatState>(() => ({ projectId: null, items: [], busy: false, pendingChoice: null, lastUserText: "" }));

const get = useChat.getState;
const set = useChat.setState;

let history: BetaMessageParam[] = [];
let abort: AbortController | null = null;
let lastEditedSource: string | null = null;
let idn = 0;
const nid = () => `c${Date.now().toString(36)}${(++idn).toString(36)}`;
/** request features the selected model rejected this session */
const unsupported = new Set<"effort" | "thinking" | "fallbacks" | "web">();
/** a paused server-tool turn is resumed this many times in a row before Claude stops and says so */
const MAX_PAUSE_RESUMES = 5;

function patch(id: string, fn: (it: ChatItem) => ChatItem) {
  set((s) => ({ items: s.items.map((it) => (it.id === id ? fn(it) : it)) }));
}
function push(it: ChatItem) {
  set((s) => ({ items: [...s.items, it] }));
}

// ---------- persistence ----------

export async function loadChat(projectId: string) {
  abort?.abort();
  const rec = await db.getOne<db.ChatRecord>("chats", projectId).catch(() => undefined);
  history = (rec?.history as BetaMessageParam[]) ?? [];
  const savedPending = (rec as { pending?: ChatState["pendingChoice"] } | undefined)?.pending ?? null;
  const items = ((rec?.items as ChatItem[]) ?? []).map((it) => (it.kind === "assistant" ? { ...it, streaming: false } : it.kind === "tool" && it.status === "running" ? { ...it, status: "error" as const, detail: "Interrupted" } : it));
  lastEditedSource = null;
  // a choice card left open in a previous session is still answerable
  const open = savedPending && items.some((i) => i.id === savedPending.itemId && i.kind === "choice" && !i.chosen) ? savedPending : null;
  set({ projectId, items, busy: false, pendingChoice: open });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  const { projectId } = get();
  if (!projectId) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { items, pendingChoice } = get();
    // keep stored history small: images are dropped, the text around them stays
    const slimHistory = history.map(stripImages);
    const slimItems = items.slice(-400).map((it) => (it.kind === "tool" && it.image ? { ...it, image: undefined } : it));
    void db.put<db.ChatRecord & { pending: ChatState["pendingChoice"] }>("chats", { projectId, items: slimItems, history: slimHistory, pending: pendingChoice, updatedAt: Date.now() }).catch(() => undefined);
  }, 400);
}

export async function clearChat() {
  abort?.abort();
  history = [];
  set({ items: [], busy: false, pendingChoice: null });
  const { projectId } = get();
  if (projectId) await db.remove("chats", projectId).catch(() => undefined);
}

/** Drop the open chat entirely (closing all data, or deleting its project). */
export function resetChat() {
  abort?.abort();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  history = [];
  set({ projectId: null, items: [], busy: false, pendingChoice: null });
}

function stripImages(m: BetaMessageParam): BetaMessageParam {
  if (typeof m.content === "string") return m;
  return {
    ...m,
    content: m.content.map((b) => {
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        return { ...b, content: b.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[image omitted from saved history]" } : c)) };
      }
      return b;
    }),
  };
}

/** Keep the two most recent images in context; older ones become a short note. */
function trimImages() {
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        if (b.content.some((c) => c.type === "image")) {
          seen++;
          if (seen > 2) b.content = b.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[earlier image removed to save context]" } : c));
        }
      }
    }
  }
}

// ---------- context ----------

function contextNote(): string {
  const { model, report, source } = useDesign.getState();
  const { selected } = useView.getState();
  const lines = [
    `<context>`,
    modelSummary(model),
    reportSummary(report, 12),
    selected.length ? `The user has selected: ${selected.slice(0, 20).join(", ")}` : "",
    lastEditedSource !== null && lastEditedSource !== source ? "The source changed since your last edit (the user edited it). Call get_design before editing." : "",
    `</context>`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------- the loop ----------

export function stop() {
  abort?.abort();
}

export async function sendMessage(text: string) {
  const t = text.trim();
  if (!t || get().busy) return;
  const pending = get().pendingChoice;
  push({ kind: "user", id: nid(), text: t, ts: Date.now() });
  set({ lastUserText: t });
  settlePausedTail();
  if (pending) {
    // the user typed instead of picking: that answers the open question
    patch(pending.itemId, (it) => (it.kind === "choice" ? { ...it, chosen: "(answered in chat)" } : it));
    set({ pendingChoice: null });
    history.push({ role: "user", content: [...pending.results, { type: "tool_result", tool_use_id: pending.toolUseId, content: `The user did not pick an option and wrote instead: ${t}` }, { type: "text", text: contextNote() }] });
  } else {
    history.push({ role: "user", content: [{ type: "text", text: contextNote() }, { type: "text", text: t }] });
  }
  persist();
  await runLoop();
}

export async function choose(itemId: string, label: string) {
  const pending = get().pendingChoice;
  if (!pending || pending.itemId !== itemId || get().busy) return;
  patch(itemId, (it) => (it.kind === "choice" ? { ...it, chosen: label } : it));
  set({ pendingChoice: null });
  push({ kind: "user", id: nid(), text: label, ts: Date.now() });
  history.push({ role: "user", content: [...pending.results, { type: "tool_result", tool_use_id: pending.toolUseId, content: `The user chose: ${label}` }, { type: "text", text: contextNote() }] });
  persist();
  await runLoop();
}

export async function retryLast() {
  if (get().busy) return;
  // resend a user turn that never got an answer, or resume a paused web search
  const last = history[history.length - 1];
  if (last?.role === "user" || isPausedTurn(last)) {
    await runLoop();
    return;
  }
  const t = get().lastUserText;
  if (t) await sendMessage(t);
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

function client() {
  if (clientFactory) return clientFactory();
  const key = getApiKey();
  if (!key) return null;
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 10 * 60 * 1000 });
}

/** The tools for one request: Kerf's own, plus Anthropic's web search and fetch when the user allows them. */
export function requestTools(settings: Pick<Settings, "model" | "webSearch">): unknown[] {
  return settings.webSearch && !unsupported.has("web") ? [...TOOL_DEFS, ...webTools(settings.model)] : [...TOOL_DEFS];
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
  push({ kind: "assistant", id, text: "", thinking: "", streaming: true });
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

async function runLoop() {
  const anthropic = client();
  if (!anthropic) {
    push({ kind: "notice", id: nid(), level: "warn", title: "Add your Claude API key to chat", detail: "Kerf talks to Claude directly from your browser with your own key. Everything else works without one.", action: "settings" });
    persist();
    return;
  }
  abort = new AbortController();
  set({ busy: true });
  const startSource = useDesign.getState().source;
  let edits = 0;
  const settings = useSettings.getState();
  const system = [{ type: "text" as const, text: systemPrompt(), cache_control: { type: "ephemeral" as const } }];
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

  try {
    let step = 0;
    while (step < settings.maxSteps) {
      repairHistory();
      trimImages();
      // rolling cache breakpoint on the newest user content
      const msgs = withCacheBreakpoint(history);
      const live: Live = { bubbles: [], toolRows: new Map(), webRows, noticed, created: [] };
      newBubble(live);

      const params: Record<string, unknown> = {
        model: settings.model,
        max_tokens: 32000,
        system,
        tools: requestTools(settings),
        messages: msgs,
      };
      if (!unsupported.has("thinking")) params.thinking = { type: "adaptive", display: settings.showThinking ? "summarized" : "omitted" };
      if (!unsupported.has("effort")) params.output_config = { effort: settings.effort };
      if (!unsupported.has("fallbacks")) {
        params.fallbacks = "default";
        params.betas = ["server-side-fallback-2026-07-01"];
      }

      const final = await streamOnce(anthropic, params, live, carried);
      const raw = final.content as BetaContentBlock[];
      // after a mid-answer fallback, only what the API accepts back goes into the history
      const content = echoContent(raw);
      history.push({ role: "assistant", content: content as unknown as BetaContentBlockParam[] });

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
        persist();
        if (++resumes > MAX_PAUSE_RESUMES) {
          push({ kind: "notice", id: nid(), level: "info", title: "Claude paused during a long web search", detail: "Press Try again to let it carry on, or write a message to move on.", action: "retry" });
          break;
        }
        continue;
      }
      carried = [];
      resumes = 0;

      if (final.stop_reason === "refusal") {
        push({ kind: "notice", id: nid(), level: "warn", title: "Claude declined this request", detail: "Try rephrasing what you need. Kerf is for designing mechanical parts and assemblies." });
        break;
      }
      if (final.stop_reason === "max_tokens") {
        const cut = content.some((b) => b.type === "tool_use");
        push({ kind: "notice", id: nid(), level: "warn", title: "The response hit its length limit", detail: cut ? "The last step was cut off before it could run. Ask Claude to continue in smaller steps." : "Ask Claude to continue." });
        if (cut) history.pop();
        break;
      }
      const uses = content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      // rows for calls a fallback discarded never run
      const dropped = new Set([...live.toolRows.values()].filter((id) => !uses.some((u) => (get().items.find((i) => i.id === id) as { toolUseId?: string } | undefined)?.toolUseId === u.id)));
      if (dropped.size) set((s) => ({ items: s.items.filter((i) => !dropped.has(i.id)) }));
      if (final.stop_reason !== "tool_use") break;

      const results: BetaToolResultBlockParam[] = [];
      let ask: { toolUseId: string; outcome: ToolOutcome } | null = null;
      for (const u of uses) {
        if (abort.signal.aborted) break;
        const itemId = [...live.toolRows.values()].find((id) => (get().items.find((i) => i.id === id) as { toolUseId?: string } | undefined)?.toolUseId === u.id) ?? nid();
        if (!get().items.some((i) => i.id === itemId)) push({ kind: "tool", id: itemId, toolUseId: u.id, name: u.name, status: "running", title: TOOL_TITLES[u.name] ?? u.name });
        else patch(itemId, (it) => (it.kind === "tool" ? { ...it, status: "running", title: TOOL_TITLES[u.name] ?? u.name } : it));
        let outcome: ToolOutcome;
        try {
          outcome = await runTool(u.name, u.input);
        } catch (e) {
          outcome = { isError: true, content: `Tool failed: ${e instanceof Error ? e.message : String(e)}`, card: { title: "Tool failed", detail: e instanceof Error ? e.message : String(e), status: "error" } };
        }
        if (outcome.ask) {
          set((s) => ({ items: s.items.filter((i) => i.id !== itemId) }));
          ask = { toolUseId: u.id, outcome };
          continue;
        }
        if (u.name === "edit_design" || u.name === "write_design") {
          if (!outcome.isError) {
            edits++;
            lastEditedSource = useDesign.getState().source;
          }
        }
        patch(itemId, (it) =>
          it.kind === "tool"
            ? { ...it, status: outcome.card.status ?? (outcome.isError ? "error" : "done"), title: outcome.card.title, detail: outcome.card.detail, diff: outcome.card.diff, image: outcome.card.image }
            : it,
        );
        results.push({ type: "tool_result", tool_use_id: u.id, content: outcome.content as BetaToolResultBlockParam["content"], is_error: outcome.isError || undefined });
      }
      if (abort.signal.aborted) {
        // every tool_use needs a result before the next request
        for (const u of uses) if (!results.some((r) => r.tool_use_id === u.id) && u.id !== ask?.toolUseId) results.push({ type: "tool_result", tool_use_id: u.id, content: "Stopped by the user before this ran.", is_error: true });
        if (ask) results.push({ type: "tool_result", tool_use_id: ask.toolUseId, content: "Stopped by the user.", is_error: true });
        history.push({ role: "user", content: results });
        break;
      }
      if (ask) {
        // the answer to ask_user arrives with the user's next action, together with these results
        const cid = nid();
        push({ kind: "choice", id: cid, toolUseId: ask.toolUseId, question: ask.outcome.ask!.question, options: ask.outcome.ask!.options });
        set({ pendingChoice: { toolUseId: ask.toolUseId, itemId: cid, results } });
        break;
      }
      history.push({ role: "user", content: results });
      persist();
      step++;
      if (step === settings.maxSteps) {
        push({ kind: "notice", id: nid(), level: "info", title: `Paused after ${settings.maxSteps} steps`, detail: "Say “continue” to let Claude keep going. You can raise the limit in Settings." });
        history.push({ role: "assistant", content: [{ type: "text", text: "(Paused at the step limit.)" }] });
      }
    }
  } catch (e) {
    handleError(e);
    // leave history ending with the user turn so retry can resend it
    if (history.length && history[history.length - 1].role === "assistant") {
      const last = history[history.length - 1];
      const hasTool = typeof last.content !== "string" && last.content.some((b) => b.type === "tool_use");
      if (hasTool) history.pop();
    }
  } finally {
    set((s) => ({ busy: false, items: s.items.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it.kind === "tool" && it.status === "running" ? { ...it, status: "error" as const, detail: "Stopped" } : it)) }));
    const after = useDesign.getState().source;
    if (edits && after !== startSource) push({ kind: "turn", id: nid(), before: startSource, after, edits });
    abort = null;
    persist();
  }
}

async function streamOnce(anthropic: Anthropic, params: Record<string, unknown>, live: Live, carried: unknown[]) {
  let strippedThinking = false;
  let flattened = false;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const stream = anthropic.beta.messages.stream(params as never, { signal: abort!.signal });
      stream.on("streamEvent", (ev, snapshot) => {
        if (ev.type === "content_block_start") {
          const b = ev.content_block as { type: string; id?: string; name?: string };
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
          // the search query or page address is complete: show it
          if ((snapshot.content[ev.index] as { type?: string } | undefined)?.type === "server_tool_use") syncWeb(live, [...carried, ...snapshot.content]);
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
          const bubble = bubbleOf(live);
          if (d.type === "text_delta" && d.text) patch(bubble, (it) => (it.kind === "assistant" ? { ...it, text: it.text + d.text } : it));
          else if (d.type === "thinking_delta" && d.thinking) patch(bubble, (it) => (it.kind === "assistant" ? { ...it, thinking: it.thinking + d.thinking } : it));
          else if (d.type === "input_json_delta" && d.partial_json) {
            const id = live.toolRows.get(ev.index);
            if (id) patch(id, (it) => (it.kind === "tool" ? { ...it, inputChars: (it.inputChars ?? 0) + d.partial_json!.length } : it));
          }
        }
      });
      return await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        const msg = e.message || "";
        const lower = msg.toLowerCase();
        const hasWeb = (params.tools as { type?: string }[]).some((t) => typeof t.type === "string" && /^web_(search|fetch)_/.test(t.type));
        // the history changed under earlier thinking (an image trimmed, web search switched): drop the thinking and resend
        if (!strippedThinking && isThinkingBindingError(msg)) {
          strippedThinking = true;
          history = stripThinking(history).history;
          params.messages = withCacheBreakpoint(history);
          resetLive(live);
          continue;
        }
        // this key or model cannot use web search: carry on without it
        if (hasWeb && isWebToolError(msg)) {
          unsupported.add("web");
          params.tools = requestTools(useSettings.getState());
          push({ kind: "notice", id: nid(), level: "info", title: "Web search is not available with this key or model", detail: "Claude carries on with the parts catalog. An organisation admin can allow web search in the Claude Console." });
          resetLive(live);
          continue;
        }
        // earlier web results the request can no longer carry: keep them as plain notes
        if (!hasWeb && !flattened && isServerBlockError(msg)) {
          const f = flattenServerTools(history);
          if (f.changed) {
            flattened = true;
            history = f.history;
            params.messages = withCacheBreakpoint(history);
            resetLive(live);
            continue;
          }
        }
        // a model that rejects an optional feature: drop it and retry once
        const feature = lower.includes("effort") || lower.includes("output_config") ? "effort" : lower.includes("thinking") ? "thinking" : lower.includes("fallback") || lower.includes("beta") ? "fallbacks" : null;
        if (feature && !unsupported.has(feature)) {
          unsupported.add(feature);
          if (feature === "effort") delete params.output_config;
          if (feature === "thinking") delete params.thinking;
          if (feature === "fallbacks") {
            delete params.fallbacks;
            delete params.betas;
          }
          resetLive(live);
          continue;
        }
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
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const uses = m.content.filter((b) => b.type === "tool_use") as { id: string }[];
    if (!uses.length) continue;
    const next = history[i + 1];
    const have = new Set(next && next.role === "user" && typeof next.content !== "string" ? next.content.filter((b) => b.type === "tool_result").map((b) => (b as BetaToolResultBlockParam).tool_use_id) : []);
    const missing: BetaToolResultBlockParam[] = uses.filter((u) => !have.has(u.id)).map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "This step was interrupted and did not run.", is_error: true }));
    if (!missing.length) continue;
    if (next && next.role === "user") {
      const content = typeof next.content === "string" ? [{ type: "text" as const, text: next.content }] : next.content;
      history[i + 1] = { ...next, content: [...missing, ...content] };
    } else history.splice(i + 1, 0, { role: "user", content: missing });
  }
}

function withCacheBreakpoint(h: BetaMessageParam[]): BetaMessageParam[] {
  if (!h.length) return h;
  const out = h.slice();
  // the newest user message (a resumed web search turn may follow it)
  let i = out.length - 1;
  while (i > 0 && out[i].role !== "user") i--;
  const last = out[i];
  if (last.role === "user" && typeof last.content !== "string" && last.content.length) {
    const blocks = last.content.slice();
    const lb = blocks[blocks.length - 1];
    if (lb.type === "text" || lb.type === "tool_result") blocks[blocks.length - 1] = { ...lb, cache_control: { type: "ephemeral" } } as BetaContentBlockParam;
    out[i] = { ...last, content: blocks };
  }
  return out;
}

function handleError(e: unknown) {
  if (e instanceof Anthropic.APIUserAbortError || (e instanceof Error && e.name === "AbortError")) {
    push({ kind: "notice", id: nid(), level: "info", title: "Stopped" });
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
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
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

function cleanApiMessage(m: string) {
  // never echo anything that looks like a key back into the UI
  return m.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").slice(0, 400);
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
