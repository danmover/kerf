import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setup, signedIn, ORIGIN } from "./helpers.js";
import { McpRelay, BRIDGE_TTL } from "../src/mcpRelay.js";

const CLIENT = "kerf-test"; const SECRET = "a".repeat(40); const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const env = { KERF_CHATGPT_CLIENT_ID: CLIENT, KERF_CHATGPT_CLIENT_SECRET: SECRET, KERF_CHATGPT_REDIRECT_URIS: REDIRECT };
const verifier = "p".repeat(64); const pkce = createHash("sha256").update(verifier).digest("base64url");
const resource = ORIGIN + "/mcp";
const readTool = { name: "get_design", description: "Read", inputSchema: { type: "object", properties: {} } };
const writeTool = { name: "write_design", description: "Edit", inputSchema: { type: "object", properties: {} } };
async function authorized(scope = "kerf:read kerf:write offline_access") {
  const s = setup(env); const browser = await signedIn(s.app);
  const query = new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: "code", state: "keep-state", code_challenge_method: "S256", code_challenge: pkce, resource, scope });
  const page = await browser.get("/oauth/authorize?" + query);
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
  const nonce = /name="consent" value="([^"]+)"/.exec(await page.text())?.[1]; expect(nonce).toBeTruthy();
  const consent = await s.app.request(ORIGIN + "/oauth/authorize", { method: "POST", headers: { origin: ORIGIN, cookie: browser.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ consent: nonce!, decision: "allow" }) });
  expect(consent.status).toBe(303); const redirect = new URL(consent.headers.get("location")!); expect(redirect.searchParams.get("iss")).toBe(ORIGIN); expect(redirect.searchParams.get("state")).toBe("keep-state");
  const code = redirect.searchParams.get("code")!;
  const exchange = async (extra: Record<string, string> = {}) => s.app.request(ORIGIN + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, resource, ...extra }) });
  return { ...s, browser, exchange };
}
describe("ChatGPT OAuth and MCP", () => {
  it("advertises discovery and challenges unauthenticated MCP requests", async () => {
    const s = setup(env); const meta = await s.app.request(ORIGIN + "/.well-known/oauth-authorization-server");
    expect(await meta.json()).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true });
    const r = await s.app.request(resource, { method: "POST", body: "{}" }); expect(r.status).toBe(401); expect(r.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    s.deps.db.close();
  });
  it("requires PKCE, exact redirect and audience; codes are one-use and refresh tokens rotate", async () => {
    const s = await authorized();
    expect((await s.exchange({ code_verifier: "q".repeat(64) })).status).toBe(400);
    expect((await s.exchange({ resource: ORIGIN + "/wrong" })).status).toBe(400);
    expect((await s.exchange({ redirect_uri: "https://attacker.test/" })).status).toBe(400);
    const r = await s.exchange(); expect(r.status).toBe(200); const keys = await r.json() as { access_token: string; refresh_token: string };
    expect((await s.exchange()).status).toBe(400);
    const refresh = (value: string) => s.app.request(ORIGIN + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: value, client_id: CLIENT, client_secret: SECRET, resource }) });
    const next = await refresh(keys.refresh_token); expect(next.status).toBe(200); expect((await refresh(keys.refresh_token)).status).toBe(400);
    expect((await s.app.request(resource, { method: "POST", headers: { authorization: `Bearer ${keys.access_token}` }, body: '{}' })).status).toBe(401);
    s.deps.db.close();
  });
  it("relays only this account's tools, enforces read scopes and revokes access", async () => {
    const s = await authorized("kerf:read"); const keys = await (await s.exchange()).json() as { access_token: string };
    const connected = await s.browser.post("/api/mcp/connect", { tools: [readTool, writeTool] }); const { id } = await connected.json() as { id: string };
    const rpc = async (method: string, params: unknown = {}) => s.app.request(resource, { method: "POST", headers: { authorization: `Bearer ${keys.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const tools = await (await rpc("tools/list")).json() as { result: { tools: { name: string }[] } }; expect(tools.result.tools.map(t => t.name)).toEqual(["get_design"]);
    const denied = await (await rpc("tools/call", { name: "write_design", arguments: {} })).json() as { error: unknown }; expect(denied.error).toBeTruthy();
    const call = rpc("tools/call", { name: "get_design", arguments: {} });
    const poll = await s.browser.post("/api/mcp/poll", { id }); const jobs = await poll.json() as { jobs: { id: string }[] };
    expect(jobs.jobs).toHaveLength(1);
    const other = await signedIn(s.app, "other@example.com"); expect((await other.post("/api/mcp/reply", { id, request: jobs.jobs[0].id, result: { content: [] } })).status).toBe(403);
    await s.browser.post("/api/mcp/reply", { id, request: jobs.jobs[0].id, result: { content: [{ type: "text", text: "current design" }] } });
    expect(await (await call).json()).toMatchObject({ result: { content: [{ text: "current design" }] } });
    const status = await (await s.browser.get("/api/mcp/status")).json() as { grants: { id: string }[] }; await s.browser.del("/api/mcp/grants/" + status.grants[0].id);
    expect((await rpc("ping")).status).toBe(401); s.deps.db.close();
  });
  it("refuses cross-site consent and does not expose tools when unconfigured", async () => {
    const s = setup(); const r = await s.app.request(resource, { method: "POST", body: "{}" }); expect(r.status).toBe(503); s.deps.db.close();
    const on = setup(env); const rejected = await on.app.request(ORIGIN + "/oauth/authorize", { method: "POST", headers: { origin: "https://attacker.test" }, body: "consent=x" }); expect(rejected.status).toBe(403); on.deps.db.close();
  });
});
describe("live relay isolation", () => {
  it("rejects duplicate owners, cancels on disconnect, and expires a closed tab", async () => {
    const r = new McpRelay(); const id = r.connect("alice", "session-a", [readTool]);
    expect(r.owns("alice", "session-b", id)).toBe(false); expect(() => r.tools("bob")).toThrow(); expect(() => r.connect("alice", "session-b", [readTool])).toThrow();
    const pending = r.call("alice", "get_design", {}, new AbortController().signal); const rejected = expect(pending).rejects.toThrow(/disconnected/); r.disconnect("alice", id); await rejected;
    const oldNow = Date.now; const started = Date.now(); r.connect("alice", "session-a", [readTool]); Date.now = () => started + BRIDGE_TTL + 1;
    try { expect(r.status("alice")).toBe(false); } finally { Date.now = oldNow; }
  });
});
