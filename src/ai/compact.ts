// Keeping a long design conversation inside Claude's context.
//
// Every request sends the whole conversation again, so a long session costs a
// little more with every step and in the end no longer fits at all ("prompt is
// too long: 1054564 tokens > 1000000 maximum"). Past the size set in Settings
// (500K tokens unless the user picks another), the older
// turns are summarised by the API (on-demand compaction, beta) and replaced by
// the signed summary block it returns. The newest turns stay word for word,
// thinking blocks included: the API accepts a summary it wrote in place of the
// turns it covers, as long as the kept turns follow it unchanged and the
// system prompt and tools stay the same. What a summary must not blur is said
// again, word for word, with the next request: every message the user wrote,
// the plan, and the design source (which holds the brief and the recorded
// decisions).

import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { MAIN, type Plan, type PlanStep } from "./plan";
import { roughTokens, type Usage } from "../agents/pricing";

/** The API's opt-in for compaction: on the request that summarises and on every request that carries the summary. */
export const COMPACT_BETA = "compact-2026-09-04";
/**
 * The newest turns kept word for word once a prompt of `compactAt` tokens (Settings → Cost) is summarised: a fifth
 * of it, so a longer window also keeps more of the recent work exactly. The turn in progress is always kept.
 */
export const keepTokens = (compactAt: number) => Math.round(compactAt / 5);
/** Never summarise a prompt shorter than this, whatever a refusal said (Kerf's instructions alone are about 60K). */
export const MIN_COMPACT_AT = 200_000;
/** Below this, summarising the turns before the kept ones frees too little: everything is summarised instead. */
export const MIN_SUMMARISED = 50_000;
/** Turns one summary request sends at most; a longer conversation (one already over the limit) is summarised in parts. */
export const SUMMARY_INPUT_MAX = 600_000;
/** After a summary fails, it is tried again once the conversation has grown this much more. */
export const RETRY_GROWTH = 100_000;

export const COMPACT_INSTRUCTIONS = `Write the summary that will replace the earlier part of this conversation. The conversation is between a user and Claude, the design assistant in Kerf, a mechanical CAD app in which Claude writes and edits the design as .kerf source through tools. Claude carries on from your summary, so it must hold everything Claude needs to continue the work without asking the user again or redoing anything. Do not call any tools: reply only with the summary.

Right after the summary, Kerf restates word for word every message the user wrote, the plan, and the design source as it is now (with its brief, parameters, parts and recorded decisions), or tells Claude to read the source when it is long. So do not copy those out. Refer to parts, parameters, decisions, references and plan steps by their exact names and ids, and spend the summary on what they do not say.

Cover these, under these headings:
1. Goal: what the user is designing, what it is for and where it will be used, in the user's terms.
2. Requirements, decisions and preferences: every dimension, tolerance, load, material, process, standard part, budget, look and behaviour the user asked for or confirmed, every option they chose or turned down and the reason they gave, and how they want Claude to work with them. Keep each one, however small, and say which are not in the design yet.
3. The design now: its structure (subassemblies, the main parts, how they connect, fit and move), the key parameters and why they have their values, and each reference the user attached (photo, drawing, datasheet) by its reference id, with what it showed and any measurements taken from it.
4. What was tried and learnt: approaches that failed or were turned down and why, check results and review findings and how each was resolved, kernel or language errors and their fixes, and the assumptions Claude made or told the user about.
5. Open items: failing checks and warnings, review findings not fixed yet, questions asked and their answers or that are still waiting, and anything Claude promised the user.
6. Where the work stands: what was being done when the conversation was summarised and the next steps, precisely enough to continue in the middle of a task.

Be specific: numbers with their units, names and ids exactly as in the source. State facts, not the story of how they were found. Leave out greetings, tool mechanics and anything a later change replaced.`;

const isCompaction = (b: { type: string }) => b.type === "compaction";

/** Whether the conversation starts from a summary, so every request needs COMPACT_BETA. */
export function hasCompaction(h: readonly BetaMessageParam[]): boolean {
  const first = h[0];
  return !!first && typeof first.content !== "string" && first.content.some(isCompaction);
}

/** Rough tokens of one message: its text as sent, and about 1,600 per picture however long its base64 is. */
export function messageTokens(m: BetaMessageParam): number {
  let images = 0;
  const text = JSON.stringify(m, (k, v) => {
    if (k === "data" && typeof v === "string") {
      images++;
      return "";
    }
    return v;
  });
  return roughTokens(text) + images * 1600;
}

/**
 * Where the kept turns can start: a user message right after a finished reply,
 * so no tool call has its result on the other side, and the summary is
 * followed by a message of the other role. The message after a summary is not
 * a place to cut: there would be nothing new to summarise.
 */
export function cutPoints(h: readonly BetaMessageParam[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < h.length; i++) {
    const prev = h[i - 1];
    if (h[i].role !== "user" || prev.role !== "assistant") continue;
    const blocks = typeof prev.content === "string" ? [] : prev.content;
    if (blocks.some((b) => b.type === "tool_use" || isCompaction(b))) continue;
    // a web search the server paused waits for its turn to be sent back
    if (blocks[blocks.length - 1]?.type === "server_tool_use") continue;
    out.push(i);
  }
  return out;
}

export interface Cut {
  /** messages before this index are summarised; it equals the history's length when everything is */
  at: number;
  /** everything is summarised, the newest message included, and a message to carry on from follows the summary */
  all: boolean;
  /** this summary finishes the job; otherwise the conversation is too long for one, and another follows */
  final: boolean;
}

/**
 * What to summarise: the turns before the newest ones that fit in `keep` tokens.
 * When that leaves too little to be worth it (one long turn in progress),
 * everything is. When the part to summarise is more than one request can send
 * (`limit`), the oldest part that fits goes first. Null when nothing can be.
 * The history must end in a user message.
 */
export function planCut(h: readonly BetaMessageParam[], keep: number, limit = SUMMARY_INPUT_MAX, sizes = h.map(messageTokens)): Cut | null {
  if (h[h.length - 1]?.role !== "user") return null;
  const before: number[] = [0];
  for (const s of sizes) before.push(before[before.length - 1] + s);
  const total = before[h.length];
  const cuts = cutPoints(h);
  let at = cuts.find((c) => total - before[c] <= keep) ?? cuts[cuts.length - 1];
  let all = false;
  if (at === undefined || before[at] < MIN_SUMMARISED) {
    at = h.length;
    all = true;
  }
  if (before[at] <= limit) return { at, all, final: true };
  // too long for one request: the oldest turns that fit first
  const part = cuts.filter((c) => c < at && before[c] <= limit).pop();
  return part === undefined ? null : { at: part, all: false, final: false };
}

/** Where message `i` is once the first `at` messages are one summary; -1 when it was summarised. */
export function afterCut(i: number, cut: Cut): number {
  return cut.all || i < cut.at ? -1 : i - cut.at + 1;
}

/** The token count in a "prompt is too long" refusal (0 when it gives none), or null for any other error. */
export function promptTooLong(message: string): number | null {
  if (!/prompt is too long|too many (input )?tokens|exceeds? the (model's )?context window|context.window.exceeded/i.test(message)) return null;
  const m = /(\d[\d,]*)\s*tokens?\s*>\s*\d/i.exec(message);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
}

/** What a summary request cost: its tokens are reported under usage.iterations, not at the top level. */
export function compactionUsage(u: unknown): Usage {
  const top = (u ?? {}) as Usage & { iterations?: ({ type?: string } & Usage)[] | null };
  const parts = (top.iterations ?? []).filter((i) => i.type === "compaction");
  const list = parts.length ? parts : [top];
  return list.reduce<Usage>(
    (s, i) => ({
      input_tokens: s.input_tokens + (i.input_tokens ?? 0),
      output_tokens: s.output_tokens + (i.output_tokens ?? 0),
      cache_creation_input_tokens: (s.cache_creation_input_tokens ?? 0) + (i.cache_creation_input_tokens ?? 0),
      cache_read_input_tokens: (s.cache_read_input_tokens ?? 0) + (i.cache_read_input_tokens ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  );
}

/** Every message the user wrote, oldest first, numbered; the oldest give way when they pass `max` characters. */
export function userMessagesText(said: readonly string[], max = 40_000): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = said.length - 1; i >= 0; i--) {
    const line = `${i + 1}. ${said[i]}`;
    if (chars + line.length > max && lines.length) {
      lines.unshift(`(Messages 1 to ${i + 1} are in the summary only: they pass what fits here.)`);
      break;
    }
    lines.unshift(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
}

/** The main loop's plan as Claude reported it and the user changed it, with step ids for update_plan. */
export function planOutline(plan: Plan): string {
  const main = plan.steps.filter((s) => s.owner === MAIN && s.kind === "step");
  const branches = plan.steps.filter((s) => s.kind !== "step");
  if (!main.length && !branches.length) return "";
  const ids = new Set(main.map((s) => s.id));
  const line = (s: PlanStep, depth: number) => {
    const notes = s.notes.length ? ` (the user's notes: ${s.notes.map((n) => n.text).join("; ")})` : "";
    const who = s.by === "you" ? " [added by the user]" : "";
    return `${"  ".repeat(depth)}- ${s.id} [${s.status}] ${s.title}${who}${s.detail ? `: ${s.detail}` : ""}${notes}`;
  };
  const out: string[] = plan.goal ? [`Goal: ${plan.goal}`] : [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const s of main) if ((s.parent && ids.has(s.parent) ? s.parent : undefined) === parent && depth < 8) (out.push(line(s, depth)), walk(s.id, depth + 1));
  };
  walk(undefined, 0);
  if (branches.length) out.push(`Sub-agent branches: ${branches.map((b) => `${b.title} [${b.status}]`).join(", ")}`);
  return out.join("\n");
}
