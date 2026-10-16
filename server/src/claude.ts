// The Claude API proxy. A signed-in user's requests go through the server,
// which adds their API key (kept encrypted on the server and never sent back
// to the browser) or, if the operator allows it, a shared key with a daily
// budget. Only the endpoints Kerf uses are forwarded.

import { Hono, type Context } from "hono";
import { z } from "zod";
import { logActivity, requireUser } from "./auth.js";
import { emailAllowed } from "./config.js";
import { pseudonym, seal, unseal } from "./crypto.js";
import { HttpError, type AppEnv, type Deps, type User } from "./types.js";

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
/** Requests one account can run at once: parallel sub-assembly agents use up to 8, plus chat and self-review. */
export const MAX_CONCURRENT = 10;
/** On the shared key one request runs at a time, so a day's spending can pass the budget by one request at most. */
const MAX_CONCURRENT_SHARED = 1;
/** Betas the shared key passes on: Kerf's chat keeps its thinking blocks valid with this one. */
const SHARED_BETAS = new Set(["thinking-binding-controls-2026-08-01"]);
const SHARED_MAX_TOKENS = 64_000;
/**
 * A generous ceiling on how many tokens a model writes per second. A cancelled
 * stream stops generating, so one that ends early is charged no more than this
 * for the time it ran (and never more than its max_tokens).
 */
const MAX_OUTPUT_RATE = 400;
const ANTHROPIC_VERSION = "2023-06-01";

/** Same rules as the browser's check in src/persist/vault.ts. */
export function keyFormatProblem(key: string): string | null {
  if (!key.startsWith("sk-ant-")) return "Claude API keys start with sk-ant-. Create one in the Claude Console under API keys.";
  if (key.length < 24 || key.length > 400) return "That key is the wrong length. Copy the whole key from the Claude Console.";
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return "The key contains characters an API key never has. Check for spaces or line breaks.";
  return null;
}

const scrub = (s: string) => s.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…");
const today = () => new Date().toISOString().slice(0, 10);

/** Listed for the shared key. Using it also needs a confirmed email (see sharedUsable). */
function sharedListed(deps: Deps, user: User) {
  return !!deps.cfg.shared && emailAllowed(user.email, deps.cfg.shared.emails);
}
/** Only an address that has proved itself gets the operator's key, so nobody can sign up as a listed address and spend it. */
const sharedUsable = (deps: Deps, user: User) => sharedListed(deps, user) && !!user.email_verified_at;

/** Budget-weighted tokens used today on the shared key. Cache reads are cheap, so they count a tenth. */
function sharedUsedToday(deps: Deps, userId: string): number {
  const r = deps.db.get<{ t: number }>(
    "SELECT coalesce(sum(input_tokens + output_tokens + cache_write_tokens + cache_read_tokens / 10), 0) AS t FROM usage WHERE user_id = ? AND day = ? AND source = 'shared'",
    userId,
    today(),
  );
  return Math.round(r?.t ?? 0);
}

export function claudeAccess(deps: Deps, user: User) {
  const account = user.claude_key_enc ? { hint: user.claude_key_hint ?? "", savedAt: user.claude_key_saved_at ?? 0 } : null;
  const shared = sharedListed(deps, user) ? { dailyTokens: deps.cfg.shared!.dailyTokens, usedToday: sharedUsedToday(deps, user.id), needsConfirmedEmail: !user.email_verified_at } : null;
  return { account, shared, source: account ? ("account" as const) : sharedUsable(deps, user) ? ("shared" as const) : null };
}

function anthropicError(c: Context, status: 400 | 401 | 403 | 404 | 413 | 429 | 502 | 503, type: string, message: string) {
  return c.json({ type: "error", error: { type, message } }, status);
}

// ---------- usage accounting ----------

interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** the input figures arrived (message_start) */
  started?: boolean;
  /** the final output figure arrived, so nothing is missing */
  final?: boolean;
  /** a rough count of the output streamed so far, from the deltas' text */
  seen?: number;
}

function readUsage(u: Record<string, unknown> | undefined, into: Usage) {
  if (!u) return;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  into.input = Math.max(into.input, n("input_tokens"));
  into.output = Math.max(into.output, n("output_tokens"));
  into.cacheRead = Math.max(into.cacheRead, n("cache_read_input_tokens"));
  into.cacheWrite = Math.max(into.cacheWrite, n("cache_creation_input_tokens"));
}

function recordUsage(deps: Deps, userId: string, source: string, u: Usage) {
  deps.db.run(
    `INSERT INTO usage (user_id, day, source, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (user_id, day, source, model) DO UPDATE SET
       requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
    userId,
    today(),
    source,
    u.model.slice(0, 80) || "unknown",
    u.input,
    u.output,
    u.cacheRead,
    u.cacheWrite,
  );
}

/** Passes an SSE stream through unchanged while reading the usage figures out of it. */
function meteredStream(body: ReadableStream<Uint8Array>, usage: Usage, done: () => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  const scan = (text: string) => {
    buf += text;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5)) as { type?: string; message?: { model?: string; usage?: Record<string, unknown> }; usage?: Record<string, unknown>; delta?: Record<string, unknown> };
        if (ev.type === "content_block_delta" && ev.delta) {
          let chars = 0;
          for (const k of ["text", "thinking", "partial_json"]) if (typeof ev.delta[k] === "string") chars += (ev.delta[k] as string).length;
          // about 3 characters a token, rounded up: a count that errs high
          usage.seen = (usage.seen ?? 0) + Math.ceil(chars / 3);
        } else if (ev.type === "message_start") {
          if (ev.message?.model) usage.model = ev.message.model;
          readUsage(ev.message?.usage, usage);
          usage.started = true;
        } else if (ev.type === "message_delta" && ev.usage) {
          readUsage(ev.usage, usage);
          usage.final = true;
        }
      } catch {
        /* not JSON: ignore */
      }
    }
    if (buf.length > 1_000_000) buf = "";
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { value, done: end } = await reader.read();
        if (end) {
          ctrl.close();
          finish();
          return;
        }
        scan(decoder.decode(value, { stream: true }));
        ctrl.enqueue(value);
      } catch (e) {
        finish();
        ctrl.error(e);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

// ---------- request checks ----------

const ROUTES: { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/v1\/messages$/ },
  { method: "POST", path: /^\/v1\/messages\/count_tokens$/ },
  { method: "GET", path: /^\/v1\/models$/ },
  { method: "GET", path: /^\/v1\/models\/[A-Za-z0-9._-]{1,100}$/ },
];

/** Tools Anthropic runs on its own side; allowed with your own key, not on a shared key. */
const isServerTool = (t: unknown) => {
  const type = (t as { type?: unknown })?.type;
  return typeof type === "string" && type !== "custom";
};

/**
 * A rough estimate of a request's input tokens: about 4 characters a token for
 * text, and a flat allowance for each image or document. Used only when the
 * API's token count isn't available.
 */
export function estimateInputTokens(body: Record<string, unknown>): number {
  let chars = 0;
  let attachments = 0;
  const walk = (v: unknown, key: string) => {
    if (typeof v === "string") {
      if (key === "data" && v.length > 256) attachments++;
      else chars += v.length;
    } else if (Array.isArray(v)) for (const x of v) walk(x, "");
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk({ system: body.system, tools: body.tools, messages: body.messages }, "");
  return Math.ceil(chars / 4) + attachments * 2000;
}

function sanitize(body: Record<string, unknown>, source: "account" | "shared", userTag: string): string | null {
  if (typeof body.model !== "string" || !/^claude-[a-z0-9.-]{1,80}$/.test(body.model)) return "Unknown model.";
  // 0 asks for no output: keep-warm's refresh, which only reads the prompt cache
  const least = body.stream === true ? 1 : 0;
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < least || body.max_tokens > 128_000)) return "max_tokens is out of range.";
  // remote MCP servers and code containers are outside what Kerf does
  delete body.mcp_servers;
  delete body.container;
  if (source === "shared") {
    if (Array.isArray(body.tools) && body.tools.some(isServerTool)) return "Server-side tools are not available on the shared key.";
    // fallback to other models stays off the operator's key
    delete body.fallbacks;
  }
  body.metadata = { user_id: userTag };
  return null;
}

/** Caps a shared-key request's output to what's left of today's allowance once its input is counted. */
function fitShared(body: Record<string, unknown>, room: number): string | null {
  // no output: only the input is charged, and that is already counted in room
  if (body.max_tokens === 0) return room < 0 ? "There isn't enough of today's shared Claude allowance left for this request. It resets at midnight UTC, or add your own API key in Settings → Claude." : null;
  room = Math.min(SHARED_MAX_TOKENS, room);
  if (room < 1024) return "There isn't enough of today's shared Claude allowance left for this request. It resets at midnight UTC, or add your own API key in Settings → Claude.";
  if (body.max_tokens === undefined || (body.max_tokens as number) > room) body.max_tokens = room;
  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking?.type === "enabled" && typeof thinking.budget_tokens === "number" && thinking.budget_tokens >= (body.max_tokens as number)) thinking.budget_tokens = Math.max(1024, (body.max_tokens as number) - 1);
  return null;
}

// ---------- routes ----------

export function claudeRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, cfg } = deps;
  const inflight = new Map<string, number>();
  app.use("*", requireUser);

  /** Checks a key against the Claude API, then keeps it encrypted on the account. */
  app.put("/key", async (c) => {
    const user = c.get("user");
    const { key: raw } = z.object({ key: z.string().max(400) }).parse(await c.req.json());
    const key = raw.trim();
    const problem = keyFormatProblem(key);
    if (problem) throw new HttpError(422, "bad_key", problem);
    const wait = deps.limiter.hit(`key-test:${user.id}`, 10, 60 * 60 * 1000);
    if (wait) throw new HttpError(429, "rate_limited", "Too many key checks. Try again later.", { retryAfter: wait });
    let res: Response;
    try {
      res = await deps.fetch(`${cfg.anthropicBaseUrl}/v1/models?limit=1`, { headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new HttpError(502, "unreachable", "The server could not reach the Claude API. Try again.");
    }
    if (res.status === 401) throw new HttpError(422, "key_rejected", "The Claude API rejected this key. Check it in the Claude Console.");
    if (!res.ok) throw new HttpError(422, "key_error", `The Claude API answered ${res.status} when checking this key.`);
    db.run("UPDATE users SET claude_key_enc = ?, claude_key_hint = ?, claude_key_saved_at = ? WHERE id = ?", seal(cfg.secretKey, key, user.id), key.slice(-4), Date.now(), user.id);
    logActivity(deps, user.id, "claude_key_saved", c.get("ip"), `…${key.slice(-4)}`);
    return c.json({ ok: true, hint: key.slice(-4) });
  });

  app.delete("/key", (c) => {
    const user = c.get("user");
    db.run("UPDATE users SET claude_key_enc = NULL, claude_key_hint = NULL, claude_key_saved_at = NULL WHERE id = ?", user.id);
    logActivity(deps, user.id, "claude_key_removed", c.get("ip"));
    return c.json({ ok: true });
  });

  app.all("/v1/*", async (c) => {
    const user = c.get("user");
    const path = c.req.path.slice(c.req.path.indexOf("/v1/"));
    const method = c.req.method;
    if (!ROUTES.some((r) => r.method === method && r.path.test(path))) return anthropicError(c, 404, "not_found_error", "Kerf's proxy does not forward this endpoint.");

    // whose key
    let key: string | null = null;
    let source: "account" | "shared" = "account";
    if (user.claude_key_enc) {
      key = unseal(cfg.secretKey, user.claude_key_enc, user.id);
      if (!key) return anthropicError(c, 400, "invalid_request_error", "Your saved API key could not be read on the server. Save it again in Settings → Claude.");
    } else if (sharedListed(deps, user) && !user.email_verified_at) {
      return anthropicError(c, 403, "permission_error", "Confirm your email address to use this server's shared Claude key. The link is in your inbox, or resend it from Settings → Account.");
    } else if (sharedUsable(deps, user)) {
      key = cfg.shared!.key;
      source = "shared";
      if (method === "POST" && sharedUsedToday(deps, user.id) >= cfg.shared!.dailyTokens) {
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);
        c.header("retry-after", String(Math.ceil((midnight.getTime() - Date.now()) / 1000)));
        return anthropicError(c, 429, "rate_limit_error", "You've used today's Claude allowance on this server. It resets at midnight UTC, or add your own API key in Settings → Claude.");
      }
    }
    if (!key) return anthropicError(c, 400, "invalid_request_error", "There is no Claude API key on your Kerf account. Add one in Settings → Claude.");

    const wait = deps.limiter.hit(`claude:${user.id}`, 120, 60 * 1000);
    if (wait) {
      c.header("retry-after", String(wait));
      return anthropicError(c, 429, "rate_limit_error", "Too many Claude requests from this account. Wait a moment.");
    }
    if ((inflight.get(user.id) ?? 0) >= (source === "shared" ? MAX_CONCURRENT_SHARED : MAX_CONCURRENT)) {
      c.header("retry-after", "5");
      return anthropicError(c, 429, "rate_limit_error", "Too many Claude requests running at once on this account.");
    }
    // the slot is taken before anything is awaited, so requests that arrive
    // together (or upload slowly) can't all pass the check above
    inflight.set(user.id, (inflight.get(user.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inflight.get(user.id) ?? 1) - 1;
      if (n <= 0) inflight.delete(user.id);
      else inflight.set(user.id, n);
    };
    let streaming = false;
    try {
      const headers: Record<string, string> = { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
      const version = c.req.header("anthropic-version");
      if (version && /^\d{4}-\d{2}-\d{2}$/.test(version)) headers["anthropic-version"] = version;
      const beta = c.req.header("anthropic-beta");
      if (beta && beta.length <= 500 && /^[A-Za-z0-9._,\s-]+$/.test(beta)) {
        // on the shared key, only betas that change how a request is read, not what it costs
        const kept = source === "account" ? beta : beta.split(",").map((b) => b.trim()).filter((b) => SHARED_BETAS.has(b)).join(",");
        if (kept) headers["anthropic-beta"] = kept;
      }

      let body: string | undefined;
      let model = "unknown";
      // what a shared-key request may cost at most: charged in full if it ends without its final usage figures
      const reserved = { input: 0, output: 0 };
      let streamed = false;
      if (method === "POST") {
        const len = Number(c.req.header("content-length") ?? 0);
        if (len > MAX_REQUEST_BYTES) return anthropicError(c, 413, "request_too_large", "This request is too large to send.");
        const text = await c.req.text();
        if (text.length > MAX_REQUEST_BYTES) return anthropicError(c, 413, "request_too_large", "This request is too large to send.");
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return anthropicError(c, 400, "invalid_request_error", "The request body is not JSON.");
        }
        if (!json || typeof json !== "object" || Array.isArray(json)) return anthropicError(c, 400, "invalid_request_error", "The request body must be an object.");
        if (source === "shared" && typeof json.model === "string") {
          // 403, like the API for a model a key can't use, so Kerf stops asking for it this session
          const models = cfg.shared!.models;
          if (models.length && !models.includes(json.model)) return anthropicError(c, 403, "permission_error", `The shared key on this server works with ${models.join(", ")}. Pick one of those in Settings → Claude, or add your own key.`);
        }
        if (path === "/v1/messages") {
          const problem = sanitize(json, source, pseudonym(cfg.secretKey, user.id));
          if (problem) return anthropicError(c, 400, "invalid_request_error", problem);
          if (source === "shared") {
            reserved.input = (await countInput(headers, json, c.req.raw.signal)) ?? estimateInputTokens(json);
            const tooBig = fitShared(json, cfg.shared!.dailyTokens - sharedUsedToday(deps, user.id) - reserved.input);
            if (tooBig) return anthropicError(c, 400, "invalid_request_error", tooBig);
            reserved.output = json.max_tokens as number;
          }
        }
        if (typeof json.model === "string") model = json.model;
        streamed = json.stream === true;
        body = JSON.stringify(json);
        headers["content-type"] = "application/json";
      }
      headers.accept = c.req.header("accept") ?? "application/json";

      const isMessage = method === "POST" && path === "/v1/messages";
      const usage: Usage = { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const record = (charged: Usage) => {
        try {
          recordUsage(deps, user.id, source, charged);
        } catch (e) {
          deps.log(`usage not recorded: ${e instanceof Error ? e.message : e}`);
        }
      };
      let sentAt = 0;
      /**
       * On the shared key, a request that ends before its final usage figures is
       * charged what it may have cost. A stream stops generating when it is
       * cancelled or fails, so it pays for what a fast model could have written
       * in the time it ran; a plain request may run on after the browser leaves,
       * so it pays its whole allowance.
       */
      const charged = (): Usage => {
        if (source !== "shared" || usage.final) return usage;
        const ran = streamed ? Math.ceil(((Date.now() - sentAt) / 1000) * MAX_OUTPUT_RATE) : reserved.output;
        return { ...usage, input: usage.started ? usage.input : reserved.input, output: Math.max(usage.output, Math.min(reserved.output, Math.max(usage.seen ?? 0, ran))) };
      };

      // gone while the request was being read or counted: nothing reached the API
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      const search = new URL(c.req.url).search;
      let upstream: Response;
      sentAt = Date.now();
      try {
        upstream = await deps.fetch(`${cfg.anthropicBaseUrl}${path}${search.length < 300 ? search : ""}`, { method, headers, body, signal: c.req.raw.signal });
      } catch (e) {
        if (c.req.raw.signal.aborted) {
          // the request may have reached the API before the browser went away
          if (isMessage && source === "shared") record(charged());
          return new Response(null, { status: 499 });
        }
        deps.log(`claude proxy: upstream unreachable: ${scrub(e instanceof Error ? e.message : String(e))}`);
        return anthropicError(c, 502, "api_error", "The Kerf server could not reach the Claude API.");
      }

      const out = new Headers();
      for (const h of ["content-type", "request-id", "retry-after", "x-should-retry"]) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
      }
      for (const [k, v] of upstream.headers) if (k.startsWith("anthropic-ratelimit-")) out.set(k, v);
      out.set("cache-control", "no-store");

      const metered = isMessage && upstream.ok;
      // called when the answer ends, fails or the browser goes away; whichever comes first counts
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        release();
        if (metered) record(charged());
      };

      if (upstream.body && (upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
        if (c.req.raw.signal.aborted) {
          // gone before the answer started: nobody will read or cancel the stream
          void upstream.body.cancel().catch(() => undefined);
          settle();
          return new Response(null, { status: 499 });
        }
        streaming = true;
        c.req.raw.signal.addEventListener("abort", settle, { once: true });
        return new Response(meteredStream(upstream.body, usage, settle), { status: upstream.status, headers: out });
      }
      const text = await upstream.text().catch(() => "");
      if (metered) {
        try {
          const j = JSON.parse(text) as { model?: string; usage?: Record<string, unknown> };
          if (j.model) usage.model = j.model;
          if (j.usage) {
            readUsage(j.usage, usage);
            usage.started = usage.final = true;
          }
        } catch {
          /* no usage to read */
        }
      }
      settle();
      return new Response(scrub(text), { status: upstream.status, headers: out });
    } finally {
      // a streamed answer gives its slot back when it ends; everything else, now
      if (!streaming) release();
    }
  });

  /** A shared-key request's exact input tokens, from the API's free counting endpoint, or null if it can't say. */
  async function countInput(headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal): Promise<number | null> {
    const counted: Record<string, unknown> = {};
    for (const k of ["model", "messages", "system", "tools", "tool_choice", "thinking"]) if (body[k] !== undefined) counted[k] = body[k];
    try {
      const res = await deps.fetch(`${cfg.anthropicBaseUrl}/v1/messages/count_tokens`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(counted),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!res.ok) return null;
      const n = ((await res.json()) as { input_tokens?: unknown }).input_tokens;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
    } catch {
      return null;
    }
  }

  return app;
}
