// What Claude API calls cost, from the usage the API reports, and a rough
// estimate before a parallel build starts. Prices are US dollars per million
// tokens at Anthropic's standard API rates (October 2026).

import type { Effort } from "../app/settings";
import { webSearchFee } from "../ai/web";

export interface Price {
  input: number;
  output: number;
  /** 5-minute cache write (1.25× input) */
  cacheWrite: number;
  cacheRead: number;
}

export const PRICES: Record<string, Price> = {
  "gpt-6.1-sol": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "gpt-6-astra": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  // models a server-side fallback can answer with
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

/** Claude Haiku 5.5 bills prompts over 100K tokens at a higher rate. */
const HAIKU_LONG: Price = { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** web searches are billed per search on top of the tokens */
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export interface Tally {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  requests: number;
  cost: number;
}

export const emptyTally = (): Tally => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0, cost: 0 });

const unpriced = new Set<string>();

export function priceFor(model: string, promptTokens = 0): Price {
  const id = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + "-")) ?? "";
  if (id === "claude-haiku-5-5" && promptTokens > 100_000) return HAIKU_LONG;
  if (!PRICES[id] && model && !unpriced.has(model)) {
    unpriced.add(model);
    console.warn(`[kerf] No price for ${model}; costs for it are counted at Opus 5.5 rates.`);
  }
  return PRICES[id] ?? PRICES["claude-opus-5-5"];
}

export function costOf(model: string, u: Usage): number {
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const p = priceFor(model, u.input_tokens + write + read);
  return (u.input_tokens * p.input + u.output_tokens * p.output + write * p.cacheWrite + read * p.cacheRead) / 1e6 + webSearchFee(u);
}

export function addUsage(t: Tally, model: string, u: Usage): Tally {
  return {
    input: t.input + u.input_tokens,
    output: t.output + u.output_tokens,
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens ?? 0),
    requests: t.requests + 1,
    cost: t.cost + costOf(model, u),
  };
}

/** Rough token count for planning (about 3.6 characters per token for code and English). */
export const roughTokens = (text: string) => Math.ceil(text.length / 3.6);

const OUTPUT_PER_STEP: Record<Effort, number> = { low: 1200, medium: 2000, high: 3000, xhigh: 4500, max: 6500 };

export interface EstimateInput {
  model: string;
  effort: Effort;
  /** tokens of the shared system prompt and tool definitions */
  systemTokens: number;
  /** tokens of each agent's first message (layout, brief, dependencies) */
  contextTokens: number[];
}

/**
 * A low and high cost for a run. Each agent makes a handful of requests; the
 * system prompt is written to the cache once and read by every later request,
 * and each request re-reads the conversation so far from the cache.
 */
export function estimateRun(e: EstimateInput): { low: number; high: number } {
  const range = (steps: number, outScale: number) => {
    let total = 0;
    e.contextTokens.forEach((ctx, agent) => {
      let history = 0;
      for (let s = 0; s < steps; s++) {
        const out = OUTPUT_PER_STEP[e.effort] * outScale;
        const toolResult = 900;
        const firstEver = agent === 0 && s === 0;
        const usage: Usage = {
          input_tokens: 50,
          output_tokens: out,
          cache_creation_input_tokens: (firstEver ? e.systemTokens : 0) + (s === 0 ? ctx : out + toolResult),
          cache_read_input_tokens: (firstEver ? 0 : e.systemTokens) + (s === 0 ? 0 : ctx + history),
        };
        total += costOf(e.model, usage);
        history += out + toolResult;
      }
    });
    return total;
  };
  return { low: range(4, 0.6), high: range(10, 1.5) };
}

export function fmtUsd(n: number): string {
  if (n < 0.01) return n > 0 ? "<$0.01" : "$0.00";
  if (n < 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(n < 100 ? 1 : 0)}`;
}
