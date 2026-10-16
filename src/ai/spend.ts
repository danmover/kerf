// What Claude costs, request by request, and what Kerf saved by choosing a
// cheaper model or keeping the prompt cache warm. Every caller that talks to
// the API (the chat, the reviewer, sub-agents, the router, keep-warm) reports
// its usage here; the chat collects one turn's worth into the line under the
// reply. Savings are measured against running the same work on the design
// model with no keep-warm.

import { costOf, priceFor, type Usage } from "../agents/pricing";

export type SpendKind =
  /** a design-model request in the chat loop */
  | "chat"
  /** a request answered by the quick model */
  | "quick"
  /** the router deciding which model a turn needs */
  | "router"
  /** a quick-model response thrown away because the turn needed the design model */
  | "escalated"
  | "review"
  | "agents"
  /** a max_tokens: 0 request that kept the prompt cache warm */
  | "warm";

export interface SpendLine {
  model: string;
  cost: number;
  requests: number;
}

/** One turn's spend: the line under Claude's reply. */
export interface TurnSpend {
  cost: number;
  /** positive: cheaper than the design model alone would have been; negative: routing or keep-warm cost more */
  saved: number;
  byKind: Partial<Record<SpendKind, SpendLine[]>>;
  /** tokens Claude read back from the cache instead of being sent again in full */
  cacheRead: number;
  output: number;
}

export const emptyTurn = (): TurnSpend => ({ cost: 0, saved: 0, byKind: {}, cacheRead: 0, output: 0 });

export function addToTurn(t: TurnSpend, kind: SpendKind, model: string, cost: number, saved: number, u?: Usage): TurnSpend {
  const lines = (t.byKind[kind] ?? []).slice();
  const at = lines.findIndex((l) => l.model === model);
  if (at >= 0) lines[at] = { model, cost: lines[at].cost + cost, requests: lines[at].requests + 1 };
  else lines.push({ model, cost, requests: 1 });
  return {
    cost: t.cost + cost,
    saved: t.saved + saved,
    byKind: { ...t.byKind, [kind]: lines },
    cacheRead: t.cacheRead + (u?.cache_read_input_tokens ?? 0),
    output: t.output + (u?.output_tokens ?? 0),
  };
}

/** Every token of a request's prompt, cached or not. */
export const promptTokens = (u: Usage) => u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/**
 * At least what one request would have cost on `model` instead: its output at
 * that model's rate, and its whole prompt read from that model's cache. A turn
 * on the design model would at least have read the conversation so far; a
 * cache write it would have made is still made when the design model next
 * answers, so it is not counted as saved. The output is the cheaper model's
 * own, which the design model at its higher effort would usually exceed. So
 * savings worked out from this are a floor.
 */
export function counterfactualCost(model: string, u: Usage): number {
  const cached = (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return costOf(model, { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: cached });
}

/**
 * The saving from a warm cache on one request: the tokens it read back would
 * otherwise have been written again. Keep-warm requests are counted as spend
 * of their own, so the net saving is this minus what they cost.
 */
export function warmSaving(model: string, u: Usage): number {
  const p = priceFor(model, promptTokens(u));
  return ((u.cache_read_input_tokens ?? 0) * (p.cacheWrite - p.cacheRead)) / 1e6;
}

// ---------- the ledger ----------

type Listener = (kind: SpendKind, model: string, cost: number, saved: number, u?: Usage) => void;
const listeners = new Set<Listener>();

/** Report one request. `saved` is relative to running it on the design model without keep-warm. */
export function recordSpend(kind: SpendKind, model: string, u: Usage, saved = 0): number {
  const cost = costOf(model, u);
  for (const l of listeners) l(kind, model, cost, saved, u);
  return cost;
}

/** Hear every request reported from now on; returns the unsubscribe function. */
export function onSpend(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
