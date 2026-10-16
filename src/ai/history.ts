// Keeping the chat history valid for the Claude API.
//
// Each thinking block Claude returns is signed against the exact conversation
// that produced it: the system prompt, the tool list and every earlier message.
// Sending a block back after any of those changed is rejected with
// "Invalid `signature` in `thinking` block. The block is bound to a different
// conversation." So the history is append-only while a conversation runs, and
// wherever it cannot be (an app update changed the prompt or tools, a saved chat
// lost its images), the thinking blocks that no longer match are removed before
// the next request. Text and tool calls always stay.

import type { BetaMessageParam, BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** The API's opt-in for choosing what happens to a thinking block that no longer matches its conversation. */
export const BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** A stable 53-bit hash (cyrb53), enough to tell two snapshots of a message apart. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ":" + s.length.toString(36);
}

/** cache_control markers can move freely without invalidating anything, so they are left out of comparisons. */
const skipCacheControl = (k: string, v: unknown) => (k === "cache_control" ? undefined : v);

/** What every thinking block in a conversation is bound to besides its messages: the system prompt and the tools. */
export function bindingKey(system: unknown, tools: unknown): string {
  return hash(JSON.stringify([system, tools], skipCacheControl));
}

/** One fingerprint per message, to find the first message that changed between two requests. */
export function messageKeys(h: readonly BetaMessageParam[]): string[] {
  return h.map((m) => hash(JSON.stringify(m, skipCacheControl)));
}

/**
 * The index of the first earlier message that differs, or -1 when `next` only
 * appends to `prev` (or drops messages from its end, which is also safe).
 */
export function firstEdit(prev: readonly string[], next: readonly string[]): number {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) if (prev[i] !== next[i]) return i;
  return -1;
}

const isThinking = (b: { type: string }) => b.type === "thinking" || b.type === "redacted_thinking";

/** Whether any message from `from` on still carries a thinking block. */
export function hasThinking(h: readonly BetaMessageParam[], from = 0): boolean {
  return h.some((m, i) => i >= from && m.role === "assistant" && typeof m.content !== "string" && m.content.some(isThinking));
}

/**
 * Remove thinking blocks from every assistant message at index `from` or later,
 * in place (the array keeps its identity). Blocks before `from` stay valid: their
 * own earlier messages are unchanged, and removing the later ones never breaks
 * an earlier block. Returns how many blocks were removed.
 */
export function stripThinking(h: BetaMessageParam[], from = 0): number {
  let removed = 0;
  for (let i = Math.max(0, from); i < h.length; i++) {
    const m = h[i];
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const kept = m.content.filter((b) => !isThinking(b));
    if (kept.length === m.content.length) continue;
    removed += m.content.length - kept.length;
    // an assistant turn that was only thinking still needs some content
    h[i] = { ...m, content: kept.length ? kept : [{ type: "text", text: "(no reply text)" }] };
  }
  return removed;
}

/** A copy of a message with images and attached documents replaced by a note, or the same object when it has none. */
export function stripImages(m: BetaMessageParam): BetaMessageParam {
  if (typeof m.content === "string") return m;
  let changed = false;
  const content = m.content.map((b) => {
    if (b.type === "image" || b.type === "document") {
      changed = true;
      return { type: "text" as const, text: `[${b.type === "image" ? "image" : "document"} omitted from saved history]` };
    }
    if (b.type === "tool_result" && Array.isArray(b.content) && b.content.some((c) => c.type === "image" || c.type === "document")) {
      changed = true;
      return { ...b, content: b.content.map((c) => (c.type === "image" || c.type === "document" ? { type: "text" as const, text: `[${c.type} omitted from saved history]` } : c)) };
    }
    return b;
  });
  return changed ? { ...m, content: content as BetaContentBlockParam[] } : m;
}

/** What a saved chat records about whether its thinking blocks can be sent again. */
export interface SavedBinding {
  /** bindingKey() of the system prompt and tools the thinking blocks were made with */
  binding?: string;
  /** messages from this index on differ from what Claude saw (for example images were left out when saving) */
  validBefore?: number;
}

/**
 * The history to save, and from which message on it no longer matches what was
 * sent to Claude: the first message whose images were dropped, or an earlier
 * message that was changed since the last request.
 */
export function forSaving(h: readonly BetaMessageParam[], sentKeys: readonly string[] | null): { history: BetaMessageParam[]; validBefore: number } {
  const history = h.map(stripImages);
  let validBefore = history.findIndex((m, i) => m !== h[i]);
  if (validBefore < 0) validBefore = history.length;
  if (sentKeys) {
    const edit = firstEdit(sentKeys, messageKeys(h));
    if (edit >= 0) validBefore = Math.min(validBefore, edit);
  }
  return { history, validBefore };
}

/**
 * Make a saved chat safe to continue: if Kerf's system prompt or tools changed
 * since it was saved (an update), or the chat was saved before Kerf recorded
 * this, every thinking block goes; otherwise only those after the first message
 * that was saved differently from how Claude saw it.
 */
export function prepareSaved(h: BetaMessageParam[], saved: SavedBinding, binding: string): number {
  const from = saved.binding === binding && typeof saved.validBefore === "number" ? saved.validBefore : 0;
  return stripThinking(h, from);
}

/** A 400 about a thinking block's signature: the block no longer belongs to this conversation (or was altered). */
export function isThinkingSignatureError(message: string): boolean {
  return /signature/i.test(message) && /thinking/i.test(message);
}
