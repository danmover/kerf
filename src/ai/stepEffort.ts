// How hard Claude thinks at each step of a reply.
//
// The first step of a reply, where Claude reads the request and plans the
// change, runs at the effort set in Settings. The steps after it (reading the
// checks an edit returned, small fixes, the reply itself) run at medium, which
// is Opus 5.5's own default, unless the user picked a lower level. Changing
// the request's effort between steps would restart the prompt cache, so the
// level is set inside the conversation instead: an effort-only system message
// before the user turn it applies to (beta). It stays in the history like any
// other message, so the conversation only ever grows.

import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Effort } from "../app/settings";

/** The API's opt-in for an effort level set inside the conversation: on every request that carries one. */
export const STEP_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";
/** What the steps after the first in a reply run at, at most. */
export const FOLLOW_UP_EFFORT: Effort = "medium";

const LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

type Mark = { role: "system"; content: []; output_config: { effort: Effort } };

/** An effort-only system message: Claude works at `effort` from the next user turn on. */
export function effortMark(effort: Effort): BetaMessageParam {
  const m: Mark = { role: "system", content: [], output_config: { effort } };
  return m as unknown as BetaMessageParam;
}

export const isEffortMark = (m: BetaMessageParam | undefined): boolean => (m?.role as string) === "system";

/** The level the next response runs at: the newest mark's, or the request's own when the conversation has none. */
export function currentEffort(h: readonly BetaMessageParam[], base: Effort): Effort {
  for (let i = h.length - 1; i >= 0; i--) if (isEffortMark(h[i])) return (h[i] as unknown as Mark).output_config.effort;
  return base;
}

/** The level for a step: the chosen one for the first step of a reply, at most FOLLOW_UP_EFFORT after it when `faster`. */
export function stepEffort(chosen: Effort, first: boolean, faster: boolean): Effort {
  if (first || !faster) return chosen;
  return LEVELS.indexOf(chosen) > LEVELS.indexOf(FOLLOW_UP_EFFORT) ? FOLLOW_UP_EFFORT : chosen;
}

/** The level for a step in Thorough mode: the most thought on the first step, at least high after it. */
export function thoroughEffort(chosen: Effort, first: boolean): Effort {
  if (first) return "max";
  return LEVELS.indexOf(chosen) < LEVELS.indexOf("high") ? "high" : chosen;
}

/**
 * Put a mark before the newest user message, which has not been sent yet, when
 * the next response should run at another level than the conversation is at.
 * Returns whether one was added.
 */
export function markEffort(h: BetaMessageParam[], effort: Effort, base: Effort): boolean {
  if (h[h.length - 1]?.role !== "user" || currentEffort(h, base) === effort) return false;
  h.splice(h.length - 1, 0, effortMark(effort));
  return true;
}

export const hasEffortMarks = (h: readonly BetaMessageParam[]) => h.some(isEffortMark);
export const withoutEffortMarks = (h: readonly BetaMessageParam[]) => h.filter((m) => !isEffortMark(m));

/** The nearest message before `i` that is not a mark (undefined at the start). */
export function messageBefore(h: readonly BetaMessageParam[], i: number): BetaMessageParam | undefined {
  for (let j = i - 1; j >= 0; j--) if (!isEffortMark(h[j])) return h[j];
  return undefined;
}

/** The index of the nearest message after `i` that is not a mark (h.length when there is none). */
export function indexAfter(h: readonly BetaMessageParam[], i: number): number {
  let j = i + 1;
  while (j < h.length && isEffortMark(h[j])) j++;
  return j;
}
