// The design assistant: a streaming tool-use loop against the Claude API,
// run from the browser with the user's own API key (see client.ts for where requests go).

import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaContentBlockParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { create } from "zustand";
import { sessionEnded } from "../cloud/account";
import * as db from "../persist/db";
import { useSettings } from "../app/settings";
import { useDesign, evaluateOnly } from "../core/engine";
import { useView } from "../app/view";
import { commitSource, useProject, endPreview } from "../app/project";
import { systemPrompt } from "./prompt";
import { TOOL_DEFS, TOOL_TITLES, runTool, modelSummary, reportSummary, briefSummary, type AskOption, type ToolOutcome } from "./tools";
import { paramEdits, upsertDecision, applySpanEdits, type SetMap } from "../core/decisions";
import { fmtNum } from "../lang/values";
import { shotOf, changeShots, type ChangeShots } from "../app/changeShots";
import { spotText, type SpotRef } from "../app/spot";
import { usePlan, loadPlan, resetPlan, planSnapshot, takeMainSteering, takePauseHit, mainActivityStart, mainActivityEnd, settleActivity, noteDesignEdit, pendingSteering, describeSteering, anyBranchOpen } from "./plan";
import { appDeps, currentBrief as reviewBrief, designerReport, registerBriefProvider, ReviewError, ReviewInput, ReviewSession, runReview, type Finding, type ReviewProgress, type ReviewResult } from "./review";
import { shrinkImage } from "./review/renders";
import { isSubstantial } from "./review/gate";
import { assetBlock } from "../persist/assets";
import { briefChanges, briefData, briefHasErrors, emptyBrief, writeBrief, type BriefData } from "../core/brief";
import { isBuilding } from "../agents/orchestrator";
import { toast } from "../app/ui";
import { claudeClient, claudeRoute } from "./client";
import { BINDING_BETA, bindingKey, firstEdit, forSaving, hasThinking, isThinkingSignatureError, messageKeys, prepareSaved, stripThinking } from "./history";

/** A file the user attached to a message; it is also kept as a reference in the brief. */
export interface ChatFile {
  asset: string;
  kind: "image" | "pdf";
  name: string;
  /** reference id in the brief */
  ref?: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; ts: number; files?: ChatFile[]; spot?: SpotRef; image?: string }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean; model?: string; note?: string }
  | { kind: "tool"; id: string; toolUseId: string; name: string; status: "running" | "done" | "error"; title: string; detail?: string; diff?: { before: string; after: string }; image?: string; inputChars?: number }
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
  | { kind: "suggest"; id: string; options: { label: string; prompt: string }[] };

interface ChatState {
  projectId: string | null;
  items: ChatItem[];
  busy: boolean;
  /** a choice card waiting for the user, with the results of tools that ran beside it */
  pendingChoice: { toolUseId: string; itemId: string; results: BetaToolResultBlockParam[] } | null;
  lastUserText: string;
  /** the brief as Claude last saw it (JSON), so the next turn can say what the user changed */
  briefSeen: string | null;
}

export const useChat = create<ChatState>(() => ({ projectId: null, items: [], busy: false, pendingChoice: null, lastUserText: "", briefSeen: null }));

const get = useChat.getState;
const set = useChat.setState;

let history: BetaMessageParam[] = [];
/**
 * What the last request sent: the system prompt and tools, and a fingerprint
 * of each message. The next request must only append to it, or the thinking
 * blocks after the first changed message are rejected (see ./history).
 */
let sent: { binding: string; keys: string[] } | null = null;
let abort: AbortController | null = null;
/** bumped whenever the chat leaves its project or is cleared, so a loop still finishing leaves the new state alone */
let gen = 0;
let lastEditedSource: string | null = null;
let idn = 0;
const nid = () => `c${Date.now().toString(36)}${(++idn).toString(36)}`;
/** request features the selected model rejected this session */
const unsupported = new Set<"effort" | "thinking" | "fallbacks" | "binding">();

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function patch(id: string, fn: (it: ChatItem) => ChatItem) {
  set((s) => ({ items: s.items.map((it) => (it.id === id ? fn(it) : it)) }));
}
function push(it: ChatItem) {
  set((s) => ({ items: [...s.items, it] }));
}

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
  const savedPending = (rec as { pending?: ChatState["pendingChoice"] } | undefined)?.pending ?? null;
  const briefSeen = (rec as { briefSeen?: string | null } | undefined)?.briefSeen ?? null;
  const items = ((rec?.items as ChatItem[]) ?? []).map((it) =>
    it.kind === "assistant" ? { ...it, streaming: false } : (it.kind === "tool" || it.kind === "review") && it.status === "running" ? { ...it, status: "error" as const, detail: "Interrupted", error: "Interrupted" } : it,
  );
  lastEditedSource = null;
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

/** The user's plan changes since the last tool boundary, as a text block for the next request. */
function steering(): { type: "text"; text: string }[] {
  const text = takeMainSteering();
  return text ? [{ type: "text", text }] : [];
}

export async function clearChat() {
  stopLoop();
  dropPendingSave();
  history = [];
  sent = null;
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
async function reviewInto(itemId: string, session: ReviewSession, itemIds: string[], auto: boolean, focus?: string): Promise<ReviewResult | { error: string }> {
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
    reportSummary(report, 12),
    selected.length ? `The user has selected: ${selected.slice(0, 20).join(", ")}` : "",
    lastEditedSource !== null && lastEditedSource !== source ? "The source changed since your last edit (the user edited it). Call get_design before editing." : "",
    `</context>`,
  ];
  return lines.filter(Boolean).join("\n");
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
export async function sendMessage(text: string, opts: { files?: ChatFile[]; spot?: SpotRef; id?: string; image?: { url: string; note: string } } = {}) {
  const t = text.trim();
  const attached = opts.files ?? [];
  if ((!t && !attached.length) || get().busy) return;
  // a revision started from a build card is still writing the design; an edit from chat now would be merged away
  if (isBuilding()) {
    toast({ kind: "info", title: "The parallel build is still running", detail: "Send this once it finishes, or stop the build from its card." });
    return;
  }
  endPreview();
  const pending = get().pendingChoice;
  const files = addReferences(attached);
  push({ kind: "user", id: opts.id ?? nid(), text: t, ts: Date.now(), files: files.length ? files : undefined, spot: opts.spot, image: opts.image?.url });
  set({ lastUserText: t, busy: true });
  let blocks: BetaContentBlockParam[] = [];
  try {
    blocks = await fileBlocks(files);
  } finally {
    set({ busy: false });
  }
  const typed = t || "(See the attached reference.)";
  const said = opts.spot ? `<spot>${spotText(opts.spot)}</spot>\n${typed}` : opts.image ? `<markup>${opts.image.note}</markup>\n${typed}` : typed;
  const pic: BetaContentBlockParam[] = opts.image ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: opts.image.url.split(",")[1] ?? "" } }] : [];
  if (pending) {
    // the user typed instead of picking: that answers the open question
    patch(pending.itemId, (it) => (it.kind === "choice" ? { ...it, chosen: "(answered in chat)" } : it));
    set({ pendingChoice: null });
    addUser([...pending.results, { type: "tool_result", tool_use_id: pending.toolUseId, content: `The user did not pick an option and wrote instead: ${said}` }, ...blocks, { type: "text", text: contextNote() }, ...pic, ...steering()]);
  } else {
    addUser([{ type: "text", text: contextNote() }, ...steering(), ...blocks, ...pic, { type: "text", text: said }]);
  }
  persist();
  await runLoop();
}

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
    lines.push(`${applied} the answer as \`decision ${r.name}\` in the source. The source changed, so call get_design before your next edit.`);
    if (r.missing.length) lines.push(`These option values were not applied because the parameters no longer exist: ${r.missing.join(", ")}.`);
    lines.push(option.set && Object.keys(option.set).length ? "Make any other changes this option needs, then run_checks and report." : "Carry out this choice, then run_checks and report.");
  } else lines.push("Carry out this choice, then run_checks and report.");
  return lines.join("\n");
}

export async function retryLast() {
  if (get().busy) return;
  endPreview();
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

const client = () => claudeClient();

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
  const ac = new AbortController();
  abort = ac;
  const g = gen;
  const stale = () => g !== gen;
  set({ busy: true });
  const startSource = useDesign.getState().source;
  // a picture of the design as it was, for the change card (none if the design moves on first)
  const before = shotOf(startSource);
  let edits = 0;
  const settings = useSettings.getState();
  const session = new ReviewSession(settings.reviewRounds);
  const reviewItems: string[] = [];
  const system = systemBlocks();
  const binding = bindingKey(system, TOOL_DEFS);

  try {
    for (let step = 0; step < settings.maxSteps; step++) {
      if (stale()) return;
      repairHistory();
      capHeavy();
      const assistantId = nid();
      push({ kind: "assistant", id: assistantId, text: "", thinking: "", streaming: true });
      const toolItems = new Map<number, string>();

      const final = await streamOnce(anthropic, () => buildRequest(system, binding, settings), assistantId, toolItems, ac.signal);
      if (stale()) return;
      const content = final.content as BetaContentBlock[];
      history.push({ role: "assistant", content: content as unknown as BetaContentBlockParam[] });
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
        if (cut) history.pop();
        break;
      }
      if (final.stop_reason === "end_turn" && edits && step < settings.maxSteps - 2 && (await autoReview(session, reviewItems, startSource, stale))) continue;
      if (final.stop_reason !== "tool_use") break;

      const uses = content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      const results: BetaToolResultBlockParam[] = [];
      let ask: { toolUseId: string; outcome: ToolOutcome } | null = null;
      let pausedAfter: string | null = null;
      let offered: string | null = null;
      for (const u of uses) {
        if (ac.signal.aborted) break;
        if (pausedAfter) {
          // the user asked to review once that step was done: nothing after it runs
          set((s) => ({ items: s.items.filter((i) => !(i.kind === "tool" && i.toolUseId === u.id)) }));
          results.push({ type: "tool_result", tool_use_id: u.id, content: `Not run: the user asked to pause for review after “${pausedAfter}”. Wait for them.`, is_error: true });
          continue;
        }
        const itemId = [...toolItems.entries()].find(([, id]) => (get().items.find((i) => i.id === id) as { toolUseId?: string } | undefined)?.toolUseId === u.id)?.[1] ?? nid();
        if (!get().items.some((i) => i.id === itemId)) push({ kind: "tool", id: itemId, toolUseId: u.id, name: u.name, status: "running", title: TOOL_TITLES[u.name] ?? u.name });
        else patch(itemId, (it) => (it.kind === "tool" ? { ...it, status: "running", title: TOOL_TITLES[u.name] ?? u.name } : it));
        const mirrored = u.name !== "update_plan" && u.name !== "suggest_next_steps";
        if (mirrored) mainActivityStart(itemId, TOOL_TITLES[u.name] ?? u.name);
        // the change card's "before" picture is taken before the first edit lands
        if (!edits && (u.name === "edit_design" || u.name === "write_design" || u.name === "build_subassemblies")) await Promise.race([before, new Promise((r) => setTimeout(r, 4000))]);
        if (stale()) return;
        // Claude reads and edits the real design, never one the user is previewing
        endPreview();
        let outcome: ToolOutcome;
        try {
          outcome = u.name === "review_design" ? await reviewTool(u.input, itemId, session, reviewItems) : await runTool(u.name, u.input, { signal: ac.signal, toolUseId: u.id });
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
        if (outcome.suggest) {
          set((s) => ({ items: s.items.filter((i) => i.id !== itemId) }));
          offered = nid();
          push({ kind: "suggest", id: offered, options: outcome.suggest });
          results.push({ type: "tool_result", tool_use_id: u.id, content: outcome.content as BetaToolResultBlockParam["content"] });
          continue;
        }
        if (u.name === "edit_design" || u.name === "write_design" || u.name === "build_subassemblies" || u.name === "update_brief") {
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
      history.push({ role: "user", content: [...results, ...steering()] });
      persist();
      pausedAfter ??= takePauseHit();
      if (pausedAfter) {
        push({ kind: "notice", id: nid(), level: "info", title: `Paused after “${pausedAfter}”`, detail: "You asked to review here. Look it over, change the plan if you like, then continue.", action: "continue" });
        history.push({ role: "assistant", content: [{ type: "text", text: `(Paused for the user's review after “${pausedAfter}”, as they asked.)` }] });
        break;
      }
      // offering next steps closes the turn; the results wait for the user's next message
      if (offered && uses.every((u) => u.name === "suggest_next_steps")) {
        // this is where the turn ends, so Claude's changes are reviewed here; the chips go if Claude has more to do
        const more = edits && step < settings.maxSteps - 2 && (await autoReview(session, reviewItems, startSource, stale));
        if (!more) break;
        const chips = offered;
        set((st) => ({ items: st.items.filter((i) => i.id !== chips) }));
        continue;
      }
      if (step === settings.maxSteps - 1) {
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
    await sendMessage(describeSteering(usePlan.getState()));
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
  push({ kind: "notice", id: nid(), level: "info", title: "Interrupted to apply your plan changes" });
  const last = history[history.length - 1];
  if (last?.role === "user" && typeof last.content !== "string") history[history.length - 1] = { ...last, content: [...last.content, ...blocks] };
  else history.push({ role: "user", content: [{ type: "text", text: contextNote() }, ...blocks] });
  persist();
  await runLoop();
}

/** Review Claude's own changes when it is about to finish without having had them reviewed. Returns true when Claude should continue. */
async function autoReview(session: ReviewSession, reviewItems: string[], startSource: string, stale: () => boolean): Promise<boolean> {
  const mode = useSettings.getState().selfReview;
  if (mode === "off" || !session.canReview || !claudeRoute()) return false;
  const now = useDesign.getState().source;
  const base = session.lastSource ?? startSource;
  if (now === base) return false;
  // on "Big changes", small edits are reviewed only when they answer open findings
  const answering = session.findings.some((f) => (f.status === "fixed" || f.status === "open" || f.status === "still_open") && f.severity !== "minor");
  if (mode === "auto" && !answering && !isSubstantial(base, now)) return false;
  const itemId = nid();
  push({ kind: "review", id: itemId, auto: true, round: session.round + 1, status: "running", progress: { stage: "waiting", views: [] } });
  const r = await reviewInto(itemId, session, reviewItems, true);
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

/** Claude's review_design tool: record its answers to earlier findings, then run the next round. */
async function reviewTool(input: unknown, itemId: string, session: ReviewSession, reviewItems: string[]): Promise<ToolOutcome> {
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
  const r = await reviewInto(itemId, session, reviewItems, false, p.data.focus);
  if ("error" in r) return { isError: true, content: `The review could not run: ${r.error}`, card: { title: "Review could not run", detail: r.error, status: "error" } };
  const text = designerReport(r, session.roundsLeft, false) + (unknown.length ? `\nNote: these finding ids were not recognised: ${unknown.join(", ")}.` : "");
  return { content: reviewContent(r, text), card: { title: "Reviewed the design" } };
}

/**
 * The next request. The history must only have grown since the last request:
 * if an earlier message, the system prompt or the tools changed, the thinking
 * blocks from that point on are removed first, because Claude rejects them.
 */
function buildRequest(system: ReturnType<typeof systemBlocks>, binding: string, settings: ReturnType<typeof useSettings.getState>): Record<string, unknown> {
  let keys = messageKeys(history);
  if (sent) {
    const at = sent.binding !== binding ? 0 : firstEdit(sent.keys, keys);
    if (at >= 0 && hasThinking(history, at)) {
      const n = stripThinking(history, at);
      keys = messageKeys(history);
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
    messages: withCacheBreakpoint(history),
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
    betas.push(FALLBACK_BETA);
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

async function streamOnce(anthropic: Anthropic, build: () => Record<string, unknown>, assistantId: string, toolItems: Map<number, string>, signal: AbortSignal) {
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
          if (!strippedOnce && hasThinking(history)) {
            strippedOnce = true;
            const n = stripThinking(history);
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
function repairHistory() {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    // a tool result needs its tool_use in the turn just before; one without it (from a turn that was cut off) fails every request
    if (m.role === "user" && typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result")) {
      const prev = history[i - 1];
      const ids = new Set(prev?.role === "assistant" && typeof prev.content !== "string" ? prev.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id) : []);
      const content = m.content.filter((b) => b.type !== "tool_result" || ids.has((b as BetaToolResultBlockParam).tool_use_id));
      if (content.length !== m.content.length) history[i] = { ...m, content: content.length ? content : [{ type: "text", text: "(An interrupted step was dropped here.)" }] };
    }
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
