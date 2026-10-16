// The one Claude client factory: which key a request uses and where it goes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const key = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../src/persist/vault", () => ({ getApiKey: () => key.value }));
vi.mock("../src/cloud/account", async () => {
  const { create } = await import("zustand");
  return { useAccount: create(() => ({ status: "none" as string, info: null as unknown })) };
});

import { useAccount } from "../src/cloud/account";
import { claudeClient, claudeParallel, claudeRoute } from "../src/ai/client";

const BROWSER_KEY = "sk-ant-api03-browserbrowserbrowserbrowser0000";
const signedIn = (source: "account" | "shared" | null) => useAccount.setState({ status: "signed-in", info: { user: { id: "u1" }, claude: { source } } } as never);

/** Where the client sends a request, and with which headers. */
async function sendOne() {
  const seen: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  const client = claudeClient();
  await client!.models.list({ limit: 1 });
  return seen[0];
}

beforeEach(() => {
  key.value = null;
  useAccount.setState({ status: "none", info: null } as never);
  vi.stubGlobal("location", { origin: "https://kerf.example" });
});
afterEach(() => vi.unstubAllGlobals());

describe("claude client", () => {
  it("has no route and no client without a key", () => {
    expect(claudeRoute()).toBe(null);
    expect(claudeClient()).toBe(null);
    signedIn(null);
    expect(claudeRoute()).toBe(null);
    expect(claudeClient()).toBe(null);
  });

  it("goes straight to the API with this browser's key", async () => {
    key.value = BROWSER_KEY;
    expect(claudeRoute()).toBe("browser");
    const sent = await sendOne();
    expect(sent.url.startsWith("https://api.anthropic.com/v1/models")).toBe(true);
    expect(sent.headers.get("x-api-key")).toBe(BROWSER_KEY);
  });

  it("goes through the Kerf server when the key is on the account, even with a key in this browser", async () => {
    key.value = BROWSER_KEY;
    signedIn("account");
    expect(claudeRoute()).toBe("account");
    const sent = await sendOne();
    expect(sent.url.startsWith("https://kerf.example/api/claude/v1/models")).toBe(true);
    expect(sent.headers.get("x-kerf")).toBe("1");
    // the browser's key never goes to the server
    expect(sent.headers.get("x-api-key")).toBe("kerf-account");
  });

  it("prefers a key in this browser to the server's shared key", async () => {
    signedIn("shared");
    expect(claudeRoute()).toBe("shared");
    expect((await sendOne()).url.startsWith("https://kerf.example/api/claude/")).toBe(true);
    key.value = BROWSER_KEY;
    expect(claudeRoute()).toBe("browser");
    expect((await sendOne()).url.startsWith("https://api.anthropic.com/")).toBe(true);
  });

  it("runs one request at a time on the shared key", () => {
    key.value = BROWSER_KEY;
    expect(claudeParallel(8)).toBe(8);
    key.value = null;
    signedIn("shared");
    expect(claudeParallel(8)).toBe(1);
    signedIn("account");
    expect(claudeParallel(8)).toBe(8);
  });

  it("passes the retry count on", () => {
    key.value = BROWSER_KEY;
    expect(claudeClient({ maxRetries: 3 })!.maxRetries).toBe(3);
    expect(claudeClient()!.maxRetries).toBe(2);
  });
});
