// Keep the design conversation in Claude's prompt cache while the user looks.
//
// Each request re-sends the whole conversation; the cache bills what it has
// seen before at a small fraction of the price, but forgets it 5 minutes after
// the last request that wrote or read it. Users often inspect a design for
// longer than that, and the next message then pays to write the whole
// conversation again. So while the chat is idle, a few seconds before the
// entry would expire, Kerf re-sends the last design-model request with
// max_tokens: 0. That only reads the cache (no output, nothing appended to the
// conversation) and restarts the 5-minute timer. It stops after the minutes
// set in Settings without a new message, when a refresh finds the entry gone,
// or when the chat moves on.
//
// A turn answered by the quick model would have refreshed the entry had the
// design model answered it, so after a quick turn the entry is refreshed
// whatever Settings say: a cheap answer never leaves the next design turn
// paying to write the conversation again.

import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "../agents/pricing";
import { promptTokens, warmSaving } from "./spend";

export const CACHE_TTL_MS = 5 * 60_000;
/** Refresh well inside the 5 minutes: timers in background tabs can fire a minute late. */
export const REFRESH_AFTER_MS = 225_000;
/** Below this the cache saves too little to be worth refreshing. */
export const MIN_PROMPT_TOKENS = 4096;

interface Target {
  model: string;
  params: Record<string, unknown>;
  /** when the real request started */
  at: number;
  /** when the entry was last written or read (the cache times from the start of a request) */
  touched: number;
  /** prompt tokens of the request, known once it finishes */
  prompt: number;
  refreshes: number;
  /** tokens of an earlier design request this one found in the cache only thanks to refreshes */
  keptWarm: number;
  /** tokens it had to write again that running every turn on the design model would have found in the cache */
  lost: number;
}

export interface WarmDeps {
  client: () => Anthropic | null;
  /** keep warm this long after the last chat request starts (0 = off) */
  minutes: () => number;
  /** a refresh request finished */
  record: (model: string, u: Usage) => void;
  now?: () => number;
}

let deps: WarmDeps | null = null;
let target: Target | null = null;
let lastActivity = 0;
/** when the last quick-model request started */
let lastQuick = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: AbortController | null = null;
/** the API rejected a refresh this session (an unsupported request shape) */
let rejected = false;

const now = () => deps?.now?.() ?? Date.now();

export function configureWarm(d: WarmDeps) {
  deps = d;
}

/**
 * A chat request started streaming. Any model counts as activity; a request
 * on the design model becomes what is kept warm.
 */
export function requestStarted(model: string, params: Record<string, unknown>, at: number, design: boolean) {
  // running every turn on the design model, any chat request would have touched its entry
  const baselineTouched = lastActivity;
  lastActivity = Math.max(lastActivity, at);
  if (!design) {
    lastQuick = at;
    if (target && !timer) schedule();
    return;
  }
  const prev = target;
  const warm = !!prev && at - prev.touched < CACHE_TTL_MS;
  const baselineWarm = at - baselineTouched < CACHE_TTL_MS;
  target = { model, params, at, touched: at, prompt: 0, refreshes: 0, keptWarm: warm && !baselineWarm ? prev!.prompt : 0, lost: !warm && baselineWarm ? (prev?.prompt ?? 0) : 0 };
  schedule();
}

/**
 * A design-model request finished. Returns what keep-warm saved on it,
 * compared with running every turn on the design model: the tokens it read
 * from the cache that would otherwise have been written again (or, when a
 * refresh after a quick turn could not be made, minus what it wrote that the
 * design model alone would have read).
 */
export function requestFinished(params: Record<string, unknown>, u: Usage): number {
  if (!target || target.params !== params) return 0;
  target.prompt = promptTokens(u);
  if (target.keptWarm) return warmSaving(target.model, { ...u, cache_read_input_tokens: Math.min(u.cache_read_input_tokens ?? 0, target.keptWarm) });
  if (target.lost) return -warmSaving(target.model, { ...u, cache_read_input_tokens: Math.min(u.cache_creation_input_tokens ?? 0, target.lost) });
  return 0;
}

/** A design-model request failed: its cache entry may not exist. */
export function requestFailed(params: Record<string, unknown>) {
  if (target?.params === params) clearTarget();
}

/** Forget the conversation (another project, a cleared chat). */
export function stopWarm() {
  clearTarget();
  lastActivity = 0;
  lastQuick = 0;
}

function clearTarget() {
  target = null;
  if (timer) clearTimeout(timer);
  timer = null;
  inflight?.abort();
  inflight = null;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!target || rejected) return;
  timer = setTimeout(() => void refresh(), Math.max(1000, target.touched + REFRESH_AFTER_MS - now()));
}

async function refresh() {
  timer = null;
  const t = target;
  if (!t || !deps || rejected) return;
  const at = now();
  const minutes = deps.minutes();
  // a quick turn since the entry was last touched: the design model answering it would have touched it
  const quickSince = lastQuick > t.touched;
  if (!quickSince && (minutes <= 0 || at - lastActivity > minutes * 60_000)) return;
  if (at - t.touched >= CACHE_TTL_MS) return; // already gone: a refresh would only pay to write it again
  // not finished yet (a long generation) or too small to matter: look again later
  if (t.prompt && t.prompt < MIN_PROMPT_TOKENS) return;
  const client = deps.client();
  if (!client) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const ctl = new AbortController();
  inflight = ctl;
  try {
    const res = await client.beta.messages.create(refreshBody(t.params) as never, { signal: ctl.signal, maxRetries: 0, timeout: 60_000 });
    const u = (res as unknown as { usage: Usage }).usage;
    deps.record(t.model, u);
    if (target !== t) return;
    // the entry had gone: stop rather than keep paying to write one nobody may read
    if (!u.cache_read_input_tokens) return clearTarget();
    t.touched = at;
    t.refreshes++;
    if (!t.prompt) t.prompt = promptTokens(u);
    schedule();
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError) {
      rejected = true;
      console.info(`[kerf] Keep-warm turned off for this session: ${e.message}`);
    }
  } finally {
    if (inflight === ctl) inflight = null;
  }
}

/** The request to refresh with: the same prompt, settings and model, with no output and no stream. */
export function refreshBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...params, max_tokens: 0 };
  // a fallback answers refusals; with no output there is nothing to refuse
  delete body.fallbacks;
  delete body.stream;
  if (Array.isArray(body.betas)) {
    const betas = (body.betas as string[]).filter((b) => !b.startsWith("server-side-fallback"));
    if (betas.length) body.betas = betas;
    else delete body.betas;
  }
  return body;
}

/** For tests: forget everything, including a rejection. */
export function resetWarmForTests() {
  stopWarm();
  rejected = false;
  deps = null;
}
