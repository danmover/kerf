// How the chat feed is laid out: each turn's working steps (tool calls and
// the thinking and notes between them) form a work log with a header that
// sums them up, and the reply after the last step stands on its own. Pure,
// so the layout can be tested without a browser.

import type { ChatItem } from "../ai/chat";

export type StepMark = "done" | "error" | "running" | "thought";

export interface LogSummary {
  /** tool steps (not counting thoughts) */
  steps: number;
  /** thinking and notes between the steps */
  thoughts: number;
  /** changes to the design that went through */
  edits: number;
  errors: number;
  /** the turn is still going */
  running: boolean;
  /** when the turn started (the user's message, else its first step) */
  from?: number;
  /** when its last step ended, as far as the chat knows */
  to?: number;
  /** each step's state in order, for the strip of marks in the header */
  marks: StepMark[];
  /** what is happening now, while running */
  now?: string;
}

export type FeedRow =
  | { kind: "item"; it: ChatItem; turn: string; step: boolean; lastStep?: boolean }
  | { kind: "log"; turn: string; summary: LogSummary };

const EDITS = new Set(["edit_design", "write_design", "set_material", "place_fasteners"]);

/** Items the feed does not show at all. */
export const hiddenItem = (it: ChatItem) => (it.kind === "tool" && it.name === "update_plan") || it.kind === "suggest";

/** A tool call shown as a row in the work log; the parallel build and material advice keep their own cards. */
export function isToolStep(it: ChatItem): it is Extract<ChatItem, { kind: "tool" }> {
  if (it.kind !== "tool" || it.name === "update_plan") return false;
  if (it.name === "build_subassemblies") return false;
  if (it.name === "compare_materials" && it.status === "done") return false;
  return true;
}

/** A user message that starts a turn (one sent while Claude worked joins the run instead). */
const startsTurn = (it: ChatItem) => it.kind === "user" && !it.midRun;

/**
 * The feed as rows. In each turn, the assistant bubbles before its last tool
 * step are steps too (Claude's thinking and notes on the way); the ones after
 * it are the reply. A turn with no tool step has no log.
 */
export function feedRows(items: ChatItem[], busy: boolean): FeedRow[] {
  const turns: { id: string; items: ChatItem[] }[] = [];
  for (const it of items) {
    if (hiddenItem(it)) continue;
    if (startsTurn(it) || !turns.length) turns.push({ id: startsTurn(it) ? it.id : "start", items: [] });
    turns[turns.length - 1].items.push(it);
  }
  const rows: FeedRow[] = [];
  turns.forEach((t, ti) => {
    let firstTool = -1;
    let lastTool = -1;
    t.items.forEach((it, i) => {
      if (!isToolStep(it)) return;
      if (firstTool < 0) firstTool = i;
      lastTool = i;
    });
    // thinking with nothing written yet, after the work began, is a step too: a reply flips out of the log when its words start
    const isStep = (it: ChatItem, i: number) => isToolStep(it) || (it.kind === "assistant" && (i < lastTool || (firstTool >= 0 && i > firstTool && !it.text.trim())));
    let firstStep = -1;
    let lastStepAt = -1;
    t.items.forEach((it, i) => {
      if (!isStep(it, i)) return;
      if (firstStep < 0) firstStep = i;
      lastStepAt = i;
    });
    const running = busy && ti === turns.length - 1;
    t.items.forEach((it, i) => {
      if (i === firstStep) rows.push({ kind: "log", turn: t.id, summary: summarise(t.items, isStep, running) });
      const step = isStep(it, i);
      rows.push({ kind: "item", it, turn: t.id, step, ...(step && i === lastStepAt ? { lastStep: true } : {}) });
    });
  });
  return rows;
}

function summarise(items: ChatItem[], isStep: (it: ChatItem, i: number) => boolean, running: boolean): LogSummary {
  const s: LogSummary = { steps: 0, thoughts: 0, edits: 0, errors: 0, running, marks: [] };
  const user = items[0]?.kind === "user" ? items[0] : null;
  if (user) s.from = user.ts;
  const seen = (t: number | undefined) => {
    if (t === undefined || !Number.isFinite(t)) return;
    s.from ??= t;
    s.to = Math.max(s.to ?? t, t);
  };
  items.forEach((it, i) => {
    if (it.kind === "assistant") seen(it.started !== undefined ? it.started + (it.thoughtMs ?? 0) : undefined);
    if (!isStep(it, i)) return;
    if (it.kind === "tool") {
      s.steps++;
      if (it.status === "error") s.errors++;
      if (it.status === "done" && EDITS.has(it.name)) s.edits++;
      s.marks.push(it.status === "running" ? "running" : it.status === "error" && !it.web ? "error" : "done");
      seen(it.ran);
      if (it.ran !== undefined && it.ms !== undefined) seen(it.ran + it.ms);
      if (it.status === "running") s.now = it.title;
    } else if (it.kind === "assistant") {
      s.thoughts++;
      s.marks.push("thought");
    }
  });
  return s;
}

/** A duration as people say it: 0.4 s, 12 s, 1 m 12 s. */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 50) return "";
  if (ms < 950) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} m ${s % 60} s` : `${m} m`;
}

export interface ThoughtSection {
  title: string;
  body: string;
}

/**
 * Claude's summarised thinking, split at its bold headings ("**Checking the
 * fit**" on a line of its own) into titled sections. Text before the first
 * heading, or thinking with no headings, is one untitled section.
 */
export function thoughtSections(text: string): ThoughtSection[] {
  const out: ThoughtSection[] = [];
  let cur: ThoughtSection | null = null;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/.exec(raw) ?? /^\s*#{1,4}\s+(.+?)\s*$/.exec(raw);
    if (h) {
      if (cur && (cur.title || cur.body.trim())) out.push(cur);
      cur = { title: h[1].trim(), body: "" };
      continue;
    }
    cur ??= { title: "", body: "" };
    cur.body += (cur.body ? "\n" : "") + raw;
  }
  if (cur && (cur.title || cur.body.trim())) out.push(cur);
  return out.map((x) => ({ title: x.title, body: x.body.trim() }));
}
