import { describe, expect, it } from "vitest";
import { estimateInputTokens } from "../src/claude.js";
import { client, setup, signedIn, sse, type FetchFn } from "./helpers.js";

const KEY = "sk-ant-api03-" + "a".repeat(40) + "WXYZ";
const SHARED = "sk-ant-api03-" + "s".repeat(40) + "SHRD";

const message = (model = "claude-sonnet-5-5") => ({ model, max_tokens: 1000, stream: true, messages: [{ role: "user", content: "hi" }] });

/** A stand-in for api.anthropic.com. */
const anthropic: FetchFn = async (url, init) => {
  const key = (init.headers as Record<string, string>)["x-api-key"];
  if (key !== KEY && key !== SHARED) return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } });
  if (url.includes("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }), { status: 200, headers: { "content-type": "application/json" } });
  const body = JSON.parse(String(init.body)) as { model: string };
  return sse([
    { type: "message_start", message: { id: "msg_1", model: body.model, usage: { input_tokens: 1200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ]);
};

describe("Claude key on the account", () => {
  it("checks the key, stores it encrypted, and never returns it", async () => {
    const { app, deps, calls } = setup({}, anthropic);
    const c = await signedIn(app);
    expect((await c.put("/api/claude/key", { key: "sk-ant-api03-" + "b".repeat(40) })).status).toBe(422);
    expect((await c.put("/api/claude/key", { key: "not a key" })).status).toBe(422);
    const ok = await c.put("/api/claude/key", { key: ` ${KEY}\n` });
    expect(ok.status).toBe(200);
    expect(await c.json(ok)).toEqual({ ok: true, hint: "WXYZ" });
    expect(calls.at(-1)!.url).toBe("https://api.anthropic.com/v1/models?limit=1");

    const row = deps.db.get<{ claude_key_enc: string }>("SELECT claude_key_enc FROM users")!;
    expect(row.claude_key_enc).toMatch(/^v1\./);
    expect(row.claude_key_enc).not.toContain("aaaa");
    const dump = JSON.stringify(deps.db.all("SELECT * FROM users")) + JSON.stringify(deps.db.all("SELECT * FROM activity"));
    expect(dump).not.toContain(KEY);

    const session = await c.get("/api/session");
    const text = await session.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).claude).toMatchObject({ source: "account", account: { hint: "WXYZ" }, shared: null });

    expect((await c.del("/api/claude/key")).status).toBe(200);
    expect((await c.json<{ claude: { source: unknown } }>(await c.get("/api/session"))).claude.source).toBeNull();
  });

  it("does not decrypt for another account", async () => {
    const { app, deps } = setup({}, anthropic);
    const dan = await signedIn(app, "dan@example.com");
    const eve = await signedIn(app, "eve@example.com");
    await dan.put("/api/claude/key", { key: KEY });
    // copy dan's sealed key onto eve's row: it must not work there
    deps.db.run("UPDATE users SET claude_key_enc = (SELECT claude_key_enc FROM users WHERE email = 'dan@example.com') WHERE email = 'eve@example.com'");
    const res = await eve.post("/api/claude/v1/messages", message());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/could not be read/);
  });
});

describe("Claude proxy", () => {
  it("forwards a streamed message with the account's key and records usage", async () => {
    const { app, calls, deps } = setup({}, anthropic);
    const c = await signedIn(app);
    await c.put("/api/claude/key", { key: KEY });
    const res = await c.post("/api/claude/v1/messages", { ...message(), mcp_servers: [{ url: "https://x" }], metadata: { user_id: "spoof" } }, { "x-api-key": "sk-ant-from-browser", "anthropic-beta": "server-side-fallback-2026-07-01", "anthropic-dangerous-direct-browser-access": "true", authorization: "Bearer nope" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("Hello");

    const sent = calls.at(-1)!;
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    const h = sent.init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe(KEY);
    expect(h["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(h.authorization).toBeUndefined();
    expect(h["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    const body = JSON.parse(String(sent.init.body));
    expect(body.mcp_servers).toBeUndefined();
    expect(body.metadata.user_id).toMatch(/^[0-9a-f]{32}$/);

    // usage is written when the stream finishes
    await new Promise((r) => setTimeout(r, 10));
    const usage = deps.db.get<Record<string, number | string>>("SELECT * FROM usage");
    expect(usage).toMatchObject({ source: "account", model: "claude-sonnet-5-5", requests: 1, input_tokens: 1200, output_tokens: 42, cache_read_tokens: 5000, cache_write_tokens: 300 });
    const u = await c.json<{ usage: unknown[] }>(await c.get("/api/account/usage"));
    expect(u.usage).toHaveLength(1);
  });

  it("passes the Claude API's own errors through", async () => {
    const { app, deps } = setup({}, anthropic);
    const c = await signedIn(app);
    await c.put("/api/claude/key", { key: KEY });
    // the key was revoked in the Console after it was saved
    deps.db.run("UPDATE users SET claude_key_enc = ?", (await import("../src/crypto.js")).seal(deps.cfg.secretKey, "sk-ant-api03-" + "z".repeat(40), deps.db.get<{ id: string }>("SELECT id FROM users")!.id));
    const res = await c.post("/api/claude/v1/messages", message());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("authentication_error");
  });

  it("forwards only the endpoints Kerf uses", async () => {
    const { app } = setup({}, anthropic);
    const c = await signedIn(app);
    await c.put("/api/claude/key", { key: KEY });
    expect((await c.get("/api/claude/v1/models?limit=1")).status).toBe(200);
    for (const [m, p] of [
      ["POST", "/api/claude/v1/messages/batches"],
      ["GET", "/api/claude/v1/files"],
      ["POST", "/api/claude/v1/complete"],
      ["DELETE", "/api/claude/v1/models"],
      ["GET", "/api/claude/v1/models/../../admin"],
    ]) {
      const res = m === "GET" ? await c.get(p) : m === "POST" ? await c.post(p, {}) : await c.del(p);
      expect(res.status, `${m} ${p}`).toBe(404);
    }
    expect((await c.post("/api/claude/v1/messages", { ...message(), model: "gpt-5" })).status).toBe(400);
    expect((await c.post("/api/claude/v1/messages", { ...message(), max_tokens: 10_000_000 })).status).toBe(400);
  });

  it("needs a session and a key", async () => {
    const { app } = setup({}, anthropic);
    expect((await client(app).post("/api/claude/v1/messages", message())).status).toBe(401);
    const c = await signedIn(app);
    const res = await c.post("/api/claude/v1/messages", message());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/no Claude API key/);
  });

  it("limits how many requests run at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: FetchFn = async (url, init) => {
      if (url.includes("/v1/messages")) await gate;
      return anthropic(url, init);
    };
    const { app } = setup({}, slow);
    const c = await signedIn(app);
    await c.put("/api/claude/key", { key: KEY });
    const running = Array.from({ length: 4 }, () => c.post("/api/claude/v1/messages", message()));
    await new Promise((r) => setTimeout(r, 20));
    const fifth = await c.post("/api/claude/v1/messages", message());
    expect(fifth.status).toBe(429);
    release();
    for (const r of await Promise.all(running)) {
      expect(r.status).toBe(200);
      await r.text();
    }
    await new Promise((r) => setTimeout(r, 10));
    const again = await c.post("/api/claude/v1/messages", message());
    expect(again.status).toBe(200);
    await again.text();
  });

  it("lets listed accounts use a shared key once their email is confirmed", async () => {
    const { app, calls, mailer } = setup({ KERF_SHARED_ANTHROPIC_KEY: SHARED, KERF_SHARED_CLAUDE_EMAILS: "*@team.example", KERF_SHARED_DAILY_TOKENS: "1000000" }, anthropic);
    const outsider = await signedIn(app, "eve@example.com");
    expect((await outsider.json<{ claude: { source: unknown } }>(await outsider.get("/api/session"))).claude.source).toBeNull();
    expect((await outsider.post("/api/claude/v1/messages", message())).status).toBe(400);

    // signing up with a listed address isn't enough: it has to be confirmed
    const ann = await signedIn(app, "ann@team.example");
    expect((await ann.json<{ claude: unknown }>(await ann.get("/api/session"))).claude).toMatchObject({ source: null, shared: { needsConfirmedEmail: true } });
    expect((await ann.post("/api/claude/v1/messages", message())).status).toBe(403);
    expect(calls).toHaveLength(0);
    const token = /#verify=([A-Za-z0-9_-]+)/.exec(mailer.sent.find((m) => m.to === "ann@team.example")!.text)![1];
    await ann.post("/api/auth/verify", { token });
    expect((await ann.json<{ claude: unknown }>(await ann.get("/api/session"))).claude).toMatchObject({ source: "shared", shared: { dailyTokens: 1_000_000, usedToday: 0, needsConfirmedEmail: false } });

    // server-side tools are refused on the shared key
    expect((await ann.post("/api/claude/v1/messages", { ...message(), tools: [{ type: "web_search_20250305", name: "web_search" }] })).status).toBe(400);
    // betas and fallback to other models stay off it
    const res = await ann.post("/api/claude/v1/messages", { ...message(), max_tokens: 100_000, fallbacks: "default" }, { "anthropic-beta": "server-side-fallback-2026-07-01" });
    expect(res.status).toBe(200);
    await res.text();
    const sent = calls.at(-1)!;
    expect((sent.init.headers as Record<string, string>)["x-api-key"]).toBe(SHARED);
    expect((sent.init.headers as Record<string, string>)["anthropic-beta"]).toBeUndefined();
    const body = JSON.parse(String(sent.init.body));
    expect(body.max_tokens).toBe(64_000);
    expect(body.fallbacks).toBeUndefined();

    // their own key takes over from the shared one, betas included
    await ann.put("/api/claude/key", { key: KEY });
    const own = await ann.post("/api/claude/v1/messages", message(), { "anthropic-beta": "server-side-fallback-2026-07-01" });
    expect(own.status).toBe(200);
    await own.text();
    expect((calls.at(-1)!.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect((calls.at(-1)!.init.headers as Record<string, string>)["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
  });

  it("keeps the shared key inside each account's daily allowance", async () => {
    const { app, calls, deps, mailer } = setup({ KERF_SHARED_ANTHROPIC_KEY: SHARED, KERF_SHARED_CLAUDE_EMAILS: "ann@team.example", KERF_SHARED_DAILY_TOKENS: "10000" }, anthropic);
    const ann = await signedIn(app, "ann@team.example");
    await ann.post("/api/auth/verify", { token: /#verify=([A-Za-z0-9_-]+)/.exec(mailer.sent[0].text)![1] });

    // output is capped to what's left of the allowance
    const big = { ...message(), max_tokens: 50_000 };
    const res = await ann.post("/api/claude/v1/messages", big);
    expect(res.status).toBe(200);
    await res.text();
    expect(JSON.parse(String(calls.at(-1)!.init.body)).max_tokens).toBe(10_000 - estimateInputTokens(big));
    await new Promise((r) => setTimeout(r, 10));
    // 1200 in + 42 out + 300 cache writes + 5000/10 cache reads = 2042 used
    expect(deps.db.get<{ source: string; requests: number }>("SELECT source, requests FROM usage")).toMatchObject({ source: "shared", requests: 1 });

    // too little left for a request is refused before it starts
    deps.db.run("UPDATE usage SET output_tokens = output_tokens + 7500");
    const short = await ann.post("/api/claude/v1/messages", message());
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: { message: string } }).error.message).toMatch(/isn't enough/);
    // and nothing at all once it's used up
    deps.db.run("UPDATE usage SET output_tokens = output_tokens + 1000");
    const over = await ann.post("/api/claude/v1/messages", message());
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
  });

  it("runs one shared-key request at a time, and only allowed models", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: FetchFn = async (url, init) => {
      if (url.includes("/v1/messages")) await gate;
      return anthropic(url, init);
    };
    const { app, mailer } = setup({ KERF_SHARED_ANTHROPIC_KEY: SHARED, KERF_SHARED_CLAUDE_EMAILS: "ann@team.example", KERF_SHARED_MODELS: "claude-sonnet-5-5, claude-haiku-5-5" }, slow);
    const ann = await signedIn(app, "ann@team.example");
    await ann.post("/api/auth/verify", { token: /#verify=([A-Za-z0-9_-]+)/.exec(mailer.sent[0].text)![1] });
    const opus = await ann.post("/api/claude/v1/messages", message("claude-opus-5-5"));
    expect(opus.status).toBe(400);
    expect(((await opus.json()) as { error: { message: string } }).error.message).toMatch(/claude-sonnet-5-5, claude-haiku-5-5/);

    const first = ann.post("/api/claude/v1/messages", message());
    await new Promise((r) => setTimeout(r, 20));
    expect((await ann.post("/api/claude/v1/messages", message())).status).toBe(429);
    release();
    const done = await first;
    expect(done.status).toBe(200);
    await done.text();
  });

  it("records a request's usage once when the browser goes away mid-answer", async () => {
    const { app, deps } = setup({}, anthropic);
    const c = await signedIn(app);
    await c.put("/api/claude/key", { key: KEY });
    const stop = new AbortController();
    const res = await c.post("/api/claude/v1/messages", message(), {}, stop.signal);
    const reader = res.body!.getReader();
    await reader.read();
    stop.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.db.all("SELECT requests FROM usage")).toEqual([{ requests: 1 }]);
  });

  it("reports an unreachable API without leaking details", async () => {
    const { app, logs } = setup({}, async (url, init) => {
      if (url.includes("/v1/models")) return anthropic(url, init);
      throw new Error(`connect ECONNREFUSED while sending ${KEY}`);
    });
    const c = await signedIn(app);
    await c.put("/api/claude/key", { key: KEY });
    const res = await c.post("/api/claude/v1/messages", message());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("sk-ant-api03");
    expect(logs.join("\n")).not.toContain(KEY);
  });
});
