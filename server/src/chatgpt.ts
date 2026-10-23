// Authenticated Streamable HTTP MCP for ChatGPT. OAuth grants select an account;
// an explicitly connected tab in that account supplies the live CAD engine.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { loadSession } from "./auth.js";
import { apiHeaders, tooMany } from "./security.js";
import { HttpError, type AppEnv, type Deps, type User } from "./types.js";
import { McpRelay, READ_TOOLS } from "./mcpRelay.js";

const token = () => randomBytes(32).toString("base64url");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const challenge = (s: string) => createHash("sha256").update(s).digest("base64url");
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const SCOPES = ["kerf:read", "kerf:write", "offline_access"];
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
interface Grant { id: string; user_id: string; client_id: string; resource: string; scope: string; access_expires: number; refresh_expires: number }
interface Code { user_id: string; client_id: string; redirect_uri: string; challenge: string; resource: string; scope: string; expires_at: number }
interface Consent { user: string; session: string; redirect: string; state: string; challenge: string; resource: string; scope: string; expires: number }
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const bridgeSchema = z.object({ tools: z.array(z.object({ name: z.string().min(1).max(80), description: z.string().max(20_000).optional(), inputSchema: z.record(z.string(), z.unknown()) })).min(1).max(200) });
const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(200), z.number()]).optional(), method: z.string().max(200), params: z.record(z.string(), z.unknown()).optional() });
const resultSchema = z.object({ content: z.array(z.record(z.string(), z.unknown())).max(100), isError: z.boolean().optional() });

export function mountChatGPT(app: Hono<AppEnv>, deps: Deps) {
  const { cfg, db } = deps; const relay = new McpRelay(); const consents = new Map<string, Consent>();
  const cancels = new Map<string, AbortController>();
  const callKey = (grant: string, id: unknown) => `${grant}:${typeof id}:${String(id)}`;
  const resource = `${cfg.origin}/mcp`;
  const user = (c: Context<AppEnv>) => { const u = c.get("user"); if (!u) throw new HttpError(401, "sign_in", "Sign in to Kerf first."); return u; };
  const enabled = (c: Context<AppEnv>) => cfg.chatgpt ? null : c.json({ error: "not_configured", message: "The server operator has not configured ChatGPT yet." }, 503);
  const rate = (c: Context<AppEnv>, kind: string, max = 60) => { const wait = deps.limiter.hit(`mcp:${kind}:${c.get("ip")}`, max, 60_000); return wait ? tooMany(c, wait) : null; };
  const ownBridge = (c: Context<AppEnv>, id: string) => { const u = user(c); if (!relay.owns(u.id, c.get("sessionHash"), id)) throw new HttpError(403, "not_connected", "This tab does not own the Kerf connection."); return u; };

  // These routes inherit the existing account session and same-origin/CSRF checks.
  app.use("/api/mcp/*", bodyLimit({ maxSize: 24 * 1024 * 1024 }));
  app.get("/api/mcp/status", c => { const u = user(c); return c.json({ configured: !!cfg.chatgpt, endpoint: resource, connected: relay.status(u.id), grants: db.all<{ id: string; scope: string; created_at: number }>("SELECT id, scope, created_at FROM mcp_grants WHERE user_id = ?", u.id) }); });
  app.post("/api/mcp/connect", async c => {
    const unavailable = enabled(c); if (unavailable) return unavailable;
    const u = user(c); const { tools } = bridgeSchema.parse(await c.req.json());
    try { return c.json({ id: relay.connect(u.id, c.get("sessionHash"), tools), endpoint: resource }); }
    catch (e) { throw new HttpError(409, "already_connected", (e as Error).message); }
  });
  app.post("/api/mcp/poll", async c => {
    const { id } = z.object({ id: z.string().max(100) }).parse(await c.req.json()); const u = ownBridge(c, id);
    return c.json({ jobs: await relay.poll(u.id, id, c.req.raw.signal) });
  });
  app.post("/api/mcp/reply", async c => {
    const data = z.object({ id: z.string().max(100), request: z.string().max(100), result: resultSchema }).parse(await c.req.json()); const u = ownBridge(c, data.id);
    return c.json({ accepted: relay.reply(u.id, data.id, data.request, data.result) });
  });
  app.post("/api/mcp/disconnect", async c => {
    const { id } = z.object({ id: z.string().max(100) }).parse(await c.req.json()); const u = ownBridge(c, id); relay.disconnect(u.id, id); return c.json({ ok: true });
  });
  app.delete("/api/mcp/grants/:id", c => { const u = user(c); db.run("DELETE FROM mcp_grants WHERE id = ? AND user_id = ?", c.req.param("id"), u.id); relay.disconnect(u.id); return c.json({ ok: true }); });

  const metadata = (c: Context<AppEnv>) => {
    const unavailable = enabled(c); if (unavailable) return unavailable;
    c.header("Cache-Control", "no-store");
    return c.json({ resource, authorization_servers: [cfg.origin], scopes_supported: SCOPES, bearer_methods_supported: ["header"], resource_name: "Kerf" });
  };
  app.get("/.well-known/oauth-protected-resource", metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", metadata);
  app.get("/.well-known/oauth-authorization-server", c => {
    const unavailable = enabled(c); if (unavailable) return unavailable;
    return c.json({ issuer: cfg.origin, authorization_endpoint: `${cfg.origin}/oauth/authorize`, token_endpoint: `${cfg.origin}/oauth/token`, revocation_endpoint: `${cfg.origin}/oauth/revoke`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: SCOPES, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"], authorization_response_iss_parameter_supported: true });
  });
  app.use("/oauth/*", apiHeaders(cfg), bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/oauth/authorize", loadSession(deps));
  app.get("/oauth/authorize", c => {
    const unavailable = enabled(c); if (unavailable) return unavailable;
    const limited = rate(c, "authorize"); if (limited) return limited;
    const q = c.req.query(); const config = cfg.chatgpt!;
    if (q.client_id !== config.clientId || !config.redirectUris.includes(q.redirect_uri) || q.response_type !== "code" || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "") || (q.state?.length ?? 0) > 2000 || q.resource !== resource) return c.json({ error: "invalid_request", message: "Check the client, exact redirect URL, resource, and PKCE parameters." }, 400);
    const scopes = [...new Set((q.scope || "kerf:read kerf:write").split(" ").filter(Boolean))];
    if (!scopes.some(s => s === "kerf:read" || s === "kerf:write") || scopes.some(s => !SCOPES.includes(s))) return c.json({ error: "invalid_scope" }, 400);
    c.header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const u = c.get("user");
    if (!u) return c.html(html`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Kerf</title><h1>Sign in to Kerf</h1><p><a href="/" target="_blank" rel="noopener noreferrer">Open Kerf and sign in</a>, then reload this page to connect ChatGPT.</p></html>`);
    for (const [k, v] of consents) if (v.expires <= Date.now()) consents.delete(k);
    if (consents.size >= 1000) return c.json({ error: "temporarily_unavailable" }, 503);
    const nonce = token(); consents.set(nonce, { user: u.id, session: c.get("sessionHash"), redirect: q.redirect_uri, state: q.state ?? "", challenge: q.code_challenge, resource, scope: scopes.join(" "), expires: Date.now() + 5 * 60_000 });
    return c.html(html`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect ChatGPT to Kerf</title><h1>Connect ChatGPT to Kerf</h1><p>Signed in as ${u.email}.</p><p>Allow ChatGPT to ${scopes.includes("kerf:write") ? "read and change" : "read"} the design in the Kerf tab you explicitly connect. Keep that tab open while working. You can disconnect or revoke access in Settings → AI.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent" value="${nonce}"><button name="decision" value="allow">Allow access</button><button name="decision" value="deny">Cancel</button></form></html>`);
  });
  app.post("/oauth/authorize", async c => {
    if (c.req.header("origin") !== cfg.origin) return c.json({ error: "cross_origin" }, 403);
    const u = user(c); const form = await c.req.parseBody(); const nonce = String(form.consent ?? ""); const consent = consents.get(nonce);
    if (!consent || consent.expires <= Date.now() || consent.user !== u.id || consent.session !== c.get("sessionHash")) return c.json({ error: "invalid_consent" }, 400);
    consents.delete(nonce); const redirect = new URL(consent.redirect); redirect.searchParams.set("state", consent.state); redirect.searchParams.set("iss", cfg.origin);
    if (form.decision !== "allow") redirect.searchParams.set("error", "access_denied");
    else {
      const code = token(); db.run("DELETE FROM mcp_codes WHERE expires_at <= ?", Date.now());
      db.run("INSERT INTO mcp_codes (hash,user_id,client_id,redirect_uri,challenge,resource,scope,expires_at) VALUES (?,?,?,?,?,?,?,?)", hash(code), u.id, cfg.chatgpt!.clientId, consent.redirect, consent.challenge, consent.resource, consent.scope, Date.now() + 60_000);
      redirect.searchParams.set("code", code);
    }
    return c.redirect(redirect.href, 303);
  });
  async function credentials(c: Context<AppEnv>) {
    const form = await c.req.parseBody(); let id = String(form.client_id ?? ""), secret = String(form.client_secret ?? "");
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Basic ")) { const decoded = Buffer.from(auth.slice(6), "base64").toString(); const at = decoded.indexOf(":"); if (at >= 0) { id = decodeURIComponent(decoded.slice(0, at)); secret = decodeURIComponent(decoded.slice(at + 1)); } }
    return { form, valid: !!cfg.chatgpt && id === cfg.chatgpt.clientId && equal(secret, cfg.chatgpt.clientSecret) };
  }
  function issue(g: Grant) {
    const access = token(); const refresh = g.scope.split(" ").includes("offline_access") ? token() : null;
    const now = Date.now();
    db.run("UPDATE mcp_grants SET access_hash = ?, access_expires = ?, refresh_hash = ? WHERE id = ?", hash(access), now + 60 * 60_000, refresh ? hash(refresh) : null, g.id);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, scope: g.scope, ...(refresh ? { refresh_token: refresh } : {}) };
  }
  app.post("/oauth/token", async c => {
    const limited = rate(c, "token"); if (limited) return limited;
    const { form, valid } = await credentials(c); if (!valid) return c.json({ error: "invalid_client" }, 401);
    if (form.resource !== resource) return c.json({ error: "invalid_target" }, 400);
    if (form.grant_type === "authorization_code") {
      const key = hash(String(form.code ?? "")); const code = db.get<Code>("SELECT * FROM mcp_codes WHERE hash = ?", key);
      const verifier = String(form.code_verifier ?? "");
      if (!code || code.expires_at <= Date.now() || code.client_id !== cfg.chatgpt!.clientId || code.redirect_uri !== form.redirect_uri || code.resource !== resource || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(challenge(verifier), code.challenge)) return c.json({ error: "invalid_grant" }, 400);
      const owner = db.get<User>("SELECT * FROM users WHERE id = ? AND disabled = 0", code.user_id); if (!owner) return c.json({ error: "invalid_grant" }, 400);
      const grant: Grant = { id: token(), user_id: code.user_id, client_id: code.client_id, resource, scope: code.scope, access_expires: 0, refresh_expires: Date.now() + 30 * 24 * 60 * 60_000 };
      const result = db.tx(() => { db.run("DELETE FROM mcp_codes WHERE hash = ?", key); db.run("DELETE FROM mcp_grants WHERE refresh_expires <= ?", Date.now()); db.run("INSERT INTO mcp_grants (id,user_id,client_id,resource,scope,access_hash,access_expires,refresh_expires,created_at) VALUES (?,?,?,?,?,?,?,?,?)", grant.id, grant.user_id, grant.client_id, resource, grant.scope, token(), 0, grant.refresh_expires, Date.now()); return issue(grant); });
      return c.json(result);
    }
    if (form.grant_type === "refresh_token") {
      const g = db.get<Grant>("SELECT g.* FROM mcp_grants g JOIN users u ON u.id=g.user_id WHERE refresh_hash = ? AND u.disabled=0", hash(String(form.refresh_token ?? "")));
      if (!g || g.refresh_expires <= Date.now() || g.resource !== resource || g.client_id !== cfg.chatgpt!.clientId || (form.scope && form.scope !== g.scope)) return c.json({ error: "invalid_grant" }, 400);
      return c.json(issue(g));
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });
  app.post("/oauth/revoke", async c => {
    const limited = rate(c, "revoke"); if (limited) return limited;
    const { form, valid } = await credentials(c); if (!valid) return c.json({ error: "invalid_client" }, 401);
    const key = hash(String(form.token ?? "")); db.run("DELETE FROM mcp_grants WHERE client_id = ? AND (access_hash = ? OR refresh_hash = ?)", cfg.chatgpt!.clientId, key, key); return c.body(null, 200);
  });

  app.use("/mcp", apiHeaders(cfg), bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.all("/mcp", async c => {
    const unavailable = enabled(c); if (unavailable) return unavailable;
    if (c.req.header("origin") && c.req.header("origin") !== cfg.origin) return c.json(rpcError(null, -32001, "Origin refused"), 403);
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(c.req.header("authorization") ?? "");
    const g = bearer ? db.get<Grant>("SELECT g.* FROM mcp_grants g JOIN users u ON u.id=g.user_id WHERE access_hash = ? AND u.disabled=0", hash(bearer[1])) : undefined;
    if (!g || g.access_expires <= Date.now() || g.resource !== resource || g.client_id !== cfg.chatgpt!.clientId) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${cfg.origin}/.well-known/oauth-protected-resource/mcp"`); return c.json(rpcError(null, -32001, "Connect your Kerf account."), 401);
    }
    if (c.req.method !== "POST") { c.header("Allow", "POST"); return c.body(null, 405); }
    const wait = deps.limiter.hit(`mcp:rpc:${g.user_id}`, 120, 60_000); if (wait) return tooMany(c, wait);
    const version = c.req.header("mcp-protocol-version"); if (version && !VERSIONS.includes(version)) return c.json(rpcError(null, -32600, "Unsupported MCP protocol version"), 400);
    let value: unknown; try { value = await c.req.json(); } catch { return c.json(rpcError(null, -32700, "Parse error"), 400); }
    const parsed = rpcSchema.safeParse(value); if (!parsed.success) return c.json(rpcError(null, -32600, "Invalid request"), 400);
    const msg = parsed.data;
    if (msg.id === undefined) {
      if (msg.method === "notifications/cancelled") cancels.get(callKey(g.id, msg.params?.requestId))?.abort();
      return c.body(null, 202);
    }
    const ok = (result: unknown) => c.json({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return ok({ protocolVersion: VERSIONS.includes(String(msg.params?.protocolVersion)) ? msg.params!.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "kerf", title: "Kerf CAD", version: cfg.version }, instructions: "These tools work on the design in your explicitly connected Kerf tab. Call kerf_instructions once before designing, then get_design at the start of every task. Edits appear live and can be undone in Kerf." });
    if (msg.method === "ping") return ok({});
    const scopes = new Set(g.scope.split(" "));
    try {
      const tools = relay.tools(g.user_id).map(t => {
        const read = READ_TOOLS.has(t.name); const scope = read ? "kerf:read" : "kerf:write";
        return { ...t, annotations: { readOnlyHint: read, destructiveHint: !read, openWorldHint: false }, _meta: { securitySchemes: [{ type: "oauth2", scopes: [scope] }] } };
      }).filter(t => scopes.has(READ_TOOLS.has(t.name) ? "kerf:read" : "kerf:write"));
      if (msg.method === "tools/list") return ok({ tools });
      if (msg.method !== "tools/call") return c.json(rpcError(msg.id, -32601, "Method not found"));
      const params = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(msg.params);
      if (!params.success || !tools.some(t => t.name === params.data.name)) return c.json(rpcError(msg.id, -32602, "Unknown or unauthorized tool"));
      const key = callKey(g.id, msg.id); if (cancels.has(key)) return c.json(rpcError(msg.id, -32600, "A request with this ID is already running"));
      const ac = new AbortController(); cancels.set(key, ac); const stop = () => ac.abort();
      c.req.raw.signal.addEventListener("abort", stop, { once: true });
      if (c.req.raw.signal.aborted) stop();
      try { return ok(await relay.call(g.user_id, params.data.name, params.data.arguments ?? {}, ac.signal)); }
      finally { cancels.delete(key); c.req.raw.signal.removeEventListener("abort", stop); }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Kerf could not run this tool.";
      return msg.method === "tools/list" ? c.json(rpcError(msg.id, -32002, message)) : ok({ isError: true, content: [{ type: "text", text: message }] });
    }
  });
  return relay;
}
