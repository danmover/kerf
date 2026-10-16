// The design assistant: a streaming tool-use loop against the Claude API,
// run directly from the browser with the user's own API key.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaContentBlockParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { create } from "zustand";
import { getApiKey } from "../persist/vault";
import * as db from "../persist/db";
import { useSettings } from "../app/settings";
import { useDesign } from "../core/engine";
import { useView } from "../app/view";
import { commitSource } from "../app/project";
import { systemPrompt } from "./prompt";
import { TOOL_DEFS, TOOL_TITLES, runTool, modelSummary, reportSummary, type ToolOutcome } from "./tools";
import { BINDING_BETA, bindingKey, firstEdit, forSaving, hasThinking, isThinkingSignatureError, messageKeys, prepareSaved, stripThinking } from "./history";

export type ChatItem =
  | { kind: "user"; id: string; text: string; ts: number }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean; model?: string; note?: string }
  | { kind: "tool"; id: string; toolUseId: string; name: string; status: "running" | "done" | "error"; title: string; detail?: string; diff?: { before: string; after: string }; image?: string; inputChars?: number }
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
/**
 * What the last request sent: the system prompt and tools, and a fingerprint
 * of each message. The next request must only append to it, or the thinking
 * blocks after the first changed message are rejected (see ./history).
 */
let sent: { binding: string; keys: string[] } | null = null;
/** Bumped whenever the open conversation is replaced, so a run still in flight stops touching it. */
let conv = 0;
let abort: AbortController | null = null;
let lastEditedSource: string | null = null;
let idn = 0;
const nid = () => `c${Date.now().toString(36)}${(++idn).toString(36)}`;
/** request features the selected model rejected this session */
const unsupported = new Set<"effort" | "thinking" | "fallbacks" | "binding">();

function patch(id: string, fn: (it: ChatItem) => ChatItem) {
  set((s) => ({ items: s.items.map((it) => (it.id === id ? fn(it) : it)) }));
}
function push(it: ChatItem) {
  set((s) => ({ items: [...s.items, it] }));
}

// ---------- persistence ----------

export async function loadChat(projectId: string) {
  abort?.abort();
  const token = ++conv;
  const rec = await db.getOne<db.ChatRecord>("chats", projectId).catch(() => undefined);
  if (token !== conv) return; // another project was opened meanwhile
  history = (rec?.history as BetaMessageParam[]) ?? [];
  // thinking blocks saved under an older Kerf, or after messages Claude saw differently, can't be sent again
  const binding = currentBinding();
  const removed = prepareSaved(history, rec ?? {}, binding);
  if (removed) console.info(`[kerf] Reopened chat: left out ${removed} earlier thinking block(s) that no longer match this conversation.`);
  sent = { binding, keys: messageKeys(history) };
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
    // keep stored history small: images are dropped, the text around them stays,
    // and the record notes from where thinking blocks no longer match what Claude saw
    const { history: slimHistory, validBefore } = forSaving(history, sent?.keys ?? null);
    const slimItems = items.slice(-400).map((it) => (it.kind === "tool" && it.image ? { ...it, image: undefined } : it));
    void db.put<db.ChatRecord & { pending: ChatState["pendingChoice"] }>("chats", { projectId, items: slimItems, history: slimHistory, binding: sent?.binding, validBefore, pending: pendingChoice, updatedAt: Date.now() }).catch(() => undefined);
  }, 400);
}

export async function clearChat() {
  abort?.abort();
  conv++;
  history = [];
  sent = null;
  set({ items: [], busy: false, pendingChoice: null });
  const { projectId } = get();
  if (projectId) await db.remove("chats", projectId).catch(() => undefined);
}

/** Drop the open chat entirely (closing all data, or deleting its project). */
export function resetChat() {
  abort?.abort();
  conv++;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  history = [];
  sent = null;
  set({ projectId: null, items: [], busy: false, pendingChoice: null });
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
  // drop a dangling user turn that never got an answer, then resend it
  const last = history[history.length - 1];
  if (last?.role === "user") {
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

function client() {
  const key = getApiKey();
  if (!key) return null;
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 10 * 60 * 1000 });
}

function systemBlocks() {
  return [{ type: "text" as const, text: systemPrompt(), cache_control: { type: "ephemeral" as const } }];
}

/** The system prompt and tools this build of Kerf sends; thinking blocks made under different ones can't be sent back. */
function currentBinding() {
  return bindingKey(systemBlocks(), TOOL_DEFS);
}

async function runLoop() {
  const anthropic = client();
  if (!anthropic) {
    push({ kind: "notice", id: nid(), level: "warn", title: "Add your Claude API key to chat", detail: "Kerf talks to Claude directly from your browser with your own key. Everything else works without one.", action: "settings" });
    persist();
    return;
  }
  // this run belongs to the conversation open now; if the user opens another
  // project or clears the chat, it stops without touching the new one
  const h = history;
  const myConv = conv;
  const gone = () => conv !== myConv || history !== h;
  const ac = new AbortController();
  abort = ac;
  set({ busy: true });
  const startSource = useDesign.getState().source;
  let edits = 0;
  const settings = useSettings.getState();
  const system = systemBlocks();
  const binding = bindingKey(system, TOOL_DEFS);

  try {
    for (let step = 0; step < settings.maxSteps; step++) {
      repairHistory(h);
      const assistantId = nid();
      push({ kind: "assistant", id: assistantId, text: "", thinking: "", streaming: true });
      const toolItems = new Map<number, string>();

      const final = await streamOnce(anthropic, () => buildRequest(h, system, binding, settings), h, ac.signal, assistantId, toolItems);
      if (gone()) return;
      const content = final.content as BetaContentBlock[];
      h.push({ role: "assistant", content: content as unknown as BetaContentBlockParam[] });
      reportDroppedThinking(final.input_transformations);

      const fb = content.find((b) => (b as { type: string }).type === "fallback") as { to?: { model?: string } } | undefined;
      patch(assistantId, (it) => (it.kind === "assistant" ? { ...it, streaming: false, model: final.model, note: fb?.to?.model ? `Answered by ${fb.to.model} (server-side fallback)` : undefined } : it));
      // drop an empty assistant bubble (tool-only responses)
      const bubble = get().items.find((i) => i.id === assistantId);
      if (bubble?.kind === "assistant" && !bubble.text.trim() && !bubble.thinking.trim()) set((s) => ({ items: s.items.filter((i) => i.id !== assistantId) }));

      if (final.stop_reason === "refusal") {
        push({ kind: "notice", id: nid(), level: "warn", title: "Claude declined this request", detail: "Try rephrasing what you need. Kerf is for designing mechanical parts and assemblies." });
        break;
      }
      if (final.stop_reason === "max_tokens") {
        const cut = content.some((b) => b.type === "tool_use");
        push({ kind: "notice", id: nid(), level: "warn", title: "The response hit its length limit", detail: cut ? "The last step was cut off before it could run. Ask Claude to continue in smaller steps." : "Ask Claude to continue." });
        if (cut) h.pop();
        break;
      }
      if (final.stop_reason !== "tool_use") break;

      const uses = content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      const results: BetaToolResultBlockParam[] = [];
      let ask: { toolUseId: string; outcome: ToolOutcome } | null = null;
      for (const u of uses) {
        if (ac.signal.aborted) break;
        const itemId = [...toolItems.entries()].find(([, id]) => (get().items.find((i) => i.id === id) as { toolUseId?: string } | undefined)?.toolUseId === u.id)?.[1] ?? nid();
        if (!get().items.some((i) => i.id === itemId)) push({ kind: "tool", id: itemId, toolUseId: u.id, name: u.name, status: "running", title: TOOL_TITLES[u.name] ?? u.name });
        else patch(itemId, (it) => (it.kind === "tool" ? { ...it, status: "running", title: TOOL_TITLES[u.name] ?? u.name } : it));
        let outcome: ToolOutcome;
        try {
          outcome = await runTool(u.name, u.input);
        } catch (e) {
          outcome = { isError: true, content: `Tool failed: ${e instanceof Error ? e.message : String(e)}`, card: { title: "Tool failed", detail: e instanceof Error ? e.message : String(e), status: "error" } };
        }
        if (gone()) return;
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
      if (ac.signal.aborted) {
        // every tool_use needs a result before the next request
        for (const u of uses) if (!results.some((r) => r.tool_use_id === u.id) && u.id !== ask?.toolUseId) results.push({ type: "tool_result", tool_use_id: u.id, content: "Stopped by the user before this ran.", is_error: true });
        if (ask) results.push({ type: "tool_result", tool_use_id: ask.toolUseId, content: "Stopped by the user.", is_error: true });
        h.push({ role: "user", content: results });
        break;
      }
      if (ask) {
        // the answer to ask_user arrives with the user's next action, together with these results
        const cid = nid();
        push({ kind: "choice", id: cid, toolUseId: ask.toolUseId, question: ask.outcome.ask!.question, options: ask.outcome.ask!.options });
        set({ pendingChoice: { toolUseId: ask.toolUseId, itemId: cid, results } });
        break;
      }
      h.push({ role: "user", content: results });
      persist();
      if (step === settings.maxSteps - 1) {
        push({ kind: "notice", id: nid(), level: "info", title: `Paused after ${settings.maxSteps} steps`, detail: "Say “continue” to let Claude keep going. You can raise the limit in Settings." });
        h.push({ role: "assistant", content: [{ type: "text", text: "(Paused at the step limit.)" }] });
      }
    }
  } catch (e) {
    if (gone()) return;
    handleError(e);
    // leave history ending with the user turn so retry can resend it
    if (h.length && h[h.length - 1].role === "assistant") {
      const last = h[h.length - 1];
      const hasTool = typeof last.content !== "string" && last.content.some((b) => b.type === "tool_use");
      if (hasTool) h.pop();
    }
  } finally {
    if (!gone()) {
      set((s) => ({ busy: false, items: s.items.map((it) => (it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it.kind === "tool" && it.status === "running" ? { ...it, status: "error" as const, detail: "Stopped" } : it)) }));
      const after = useDesign.getState().source;
      if (edits && after !== startSource) push({ kind: "turn", id: nid(), before: startSource, after, edits });
      persist();
    }
    if (abort === ac) abort = null;
  }
}

/**
 * The next request. The history must only have grown since the last request:
 * if an earlier message, the system prompt or the tools changed, the thinking
 * blocks from that point on are removed first, because Claude rejects them.
 */
function buildRequest(h: BetaMessageParam[], system: ReturnType<typeof systemBlocks>, binding: string, settings: ReturnType<typeof useSettings.getState>): Record<string, unknown> {
  let keys = messageKeys(h);
  if (sent) {
    const at = sent.binding !== binding ? 0 : firstEdit(sent.keys, keys);
    if (at >= 0 && hasThinking(h, at)) {
      const n = stripThinking(h, at);
      keys = messageKeys(h);
      console.warn(`[kerf] ${at === 0 && sent.binding !== binding ? "The system prompt or tools changed" : `Chat message ${at} changed`} since the last request; left out ${n} thinking block(s) from there on.`);
    }
  }
  sent = { binding, keys };

  const params: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 32000,
    system,
    tools: TOOL_DEFS,
    // rolling cache breakpoint on the newest user content
    messages: withCacheBreakpoint(h),
  };
  const betas: string[] = [];
  if (!unsupported.has("thinking")) {
    const thinking: Record<string, unknown> = { type: "adaptive", display: settings.showThinking ? "summarized" : "omitted" };
    // a block that still doesn't match is dropped by the API instead of failing the request
    if (!unsupported.has("binding")) {
      thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
      betas.push(BINDING_BETA);
    }
    params.thinking = thinking;
  }
  if (!unsupported.has("effort")) params.output_config = { effort: settings.effort };
  if (!unsupported.has("fallbacks")) {
    params.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (betas.length) params.betas = betas;
  return params;
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

/** Which optional request feature a 400 is about, if the selected model rejected one. */
function rejectedFeature(msg: string): "effort" | "thinking" | "fallbacks" | "binding" | null {
  if (msg.includes("block_binding") || msg.includes("thinking-binding")) return "binding";
  if (msg.includes("effort") || msg.includes("output_config")) return "effort";
  if (msg.includes("fallback")) return "fallbacks";
  if (msg.includes("thinking")) return "thinking";
  if (msg.includes("beta")) return !unsupported.has("binding") ? "binding" : "fallbacks";
  return null;
}

async function streamOnce(anthropic: Anthropic, build: () => Record<string, unknown>, h: BetaMessageParam[], signal: AbortSignal, assistantId: string, toolItems: Map<number, string>) {
  let strippedOnce = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const stream = anthropic.beta.messages.stream(build() as never, { signal });
      stream.on("streamEvent", (ev) => {
        if (ev.type === "content_block_start") {
          const b = ev.content_block as { type: string; id?: string; name?: string };
          if (b.type === "tool_use" && b.id && b.name) {
            const id = nid();
            toolItems.set(ev.index, id);
            push({ kind: "tool", id, toolUseId: b.id, name: b.name, status: "running", title: TOOL_TITLES[b.name] ?? b.name, inputChars: 0 });
          }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
          if (d.type === "text_delta" && d.text) patch(assistantId, (it) => (it.kind === "assistant" ? { ...it, text: it.text + d.text } : it));
          else if (d.type === "thinking_delta" && d.thinking) patch(assistantId, (it) => (it.kind === "assistant" ? { ...it, thinking: it.thinking + d.thinking } : it));
          else if (d.type === "input_json_delta" && d.partial_json) {
            const id = toolItems.get(ev.index);
            if (id) patch(id, (it) => (it.kind === "tool" ? { ...it, inputChars: (it.inputChars ?? 0) + d.partial_json!.length } : it));
          }
        }
      });
      return await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        const msg = e.message || "";
        let retry = false;
        if (isThinkingSignatureError(msg)) {
          // a thinking block that no longer belongs to this conversation: send the
          // history without thinking once (text and tool calls stay), then carry on
          if (!strippedOnce && hasThinking(h)) {
            strippedOnce = true;
            const n = stripThinking(h);
            console.warn(`[kerf] Claude rejected an earlier thinking block; resent the chat without ${n} thinking block(s).`);
            retry = true;
          }
        } else {
          // a model that rejects an optional feature: drop it and retry
          const feature = rejectedFeature(msg.toLowerCase());
          if (feature && !unsupported.has(feature)) {
            unsupported.add(feature);
            retry = true;
          }
        }
        if (retry) {
          // clear whatever streamed before the error, including tool cards
          const partial = new Set(toolItems.values());
          toolItems.clear();
          set((s) => ({ items: s.items.filter((it) => !partial.has(it.id)).map((it) => (it.id === assistantId && it.kind === "assistant" ? { ...it, text: "", thinking: "" } : it)) }));
          continue;
        }
      }
      throw e;
    }
  }
  throw new Error("The request could not be completed.");
}

/** Every tool_use needs a matching tool_result in the next user turn; patch any gap left by a crash or reload. */
function repairHistory(h: BetaMessageParam[]) {
  for (let i = 0; i < h.length; i++) {
    const m = h[i];
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const uses = m.content.filter((b) => b.type === "tool_use") as { id: string }[];
    if (!uses.length) continue;
    const next = h[i + 1];
    const have = new Set(next && next.role === "user" && typeof next.content !== "string" ? next.content.filter((b) => b.type === "tool_result").map((b) => (b as BetaToolResultBlockParam).tool_use_id) : []);
    const missing: BetaToolResultBlockParam[] = uses.filter((u) => !have.has(u.id)).map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "This step was interrupted and did not run.", is_error: true }));
    if (!missing.length) continue;
    if (next && next.role === "user") {
      const content = typeof next.content === "string" ? [{ type: "text" as const, text: next.content }] : next.content;
      h[i + 1] = { ...next, content: [...missing, ...content] };
    } else h.splice(i + 1, 0, { role: "user", content: missing });
  }
}

function withCacheBreakpoint(h: BetaMessageParam[]): BetaMessageParam[] {
  if (!h.length) return h;
  const out = h.slice();
  const last = out[out.length - 1];
  if (last.role === "user" && typeof last.content !== "string" && last.content.length) {
    const blocks = last.content.slice();
    const lb = blocks[blocks.length - 1];
    if (lb.type === "text" || lb.type === "tool_result") blocks[blocks.length - 1] = { ...lb, cache_control: { type: "ephemeral" } } as BetaContentBlockParam;
    out[out.length - 1] = { ...last, content: blocks };
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
  return m.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…").slice(0, 800);
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
