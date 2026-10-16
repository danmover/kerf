import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { Db } from "../src/db.js";
import { memoryMailer } from "../src/mail.js";
import { RateLimiter } from "../src/security.js";
import type { Deps } from "../src/types.js";

export const ORIGIN = "https://kerf.test";
export const TERMS = "2026-10-draft-2";
export const PASSWORD = "correct horse battery staple";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export function setup(env: Record<string, string> = {}, upstream?: FetchFn) {
  const dataDir = mkdtempSync(join(tmpdir(), "kerf-test-"));
  const cfg: Config = loadConfig({ KERF_ORIGIN: ORIGIN, KERF_DATA_DIR: dataDir, KERF_STATIC_DIR: "", KERF_SIGNUP: "open", ...env }, "test");
  const mailer = memoryMailer();
  const logs: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (!upstream) throw new Error("no upstream in this test");
    return upstream(url, init);
  };
  const deps: Deps = { cfg, db: new Db(":memory:"), mailer, limiter: new RateLimiter(), fetch: fetchFn as typeof fetch, log: (m) => logs.push(m) };
  const app = createApp(deps);
  return { app, deps, mailer, logs, calls, cfg };
}

/** A browser-like client: keeps the session cookie and sends Kerf's same-origin headers. */
export function client(app: ReturnType<typeof createApp>) {
  let cookie = "";
  const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { origin: ORIGIN, "x-kerf": "1", ...headers };
    if (cookie) h.cookie = cookie;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      h["content-type"] = "application/json";
    }
    const res = await app.request(`${ORIGIN}${path}`, { method, headers: h, body: payload });
    const set = res.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      cookie = /=$/.test(pair) || /max-age=0/i.test(set) ? "" : pair;
    }
    return res;
  };
  return {
    get cookie() {
      return cookie;
    },
    set cookie(v: string) {
      cookie = v;
    },
    get: (p: string, headers?: Record<string, string>) => req("GET", p, undefined, headers),
    post: (p: string, b?: unknown, headers?: Record<string, string>) => req("POST", p, b ?? {}, headers),
    put: (p: string, b?: unknown, headers?: Record<string, string>) => req("PUT", p, b ?? {}, headers),
    patch: (p: string, b?: unknown) => req("PATCH", p, b ?? {}),
    del: (p: string) => req("DELETE", p),
    json: async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T,
  };
}

export async function signedIn(app: ReturnType<typeof createApp>, email = "dan@example.com") {
  const c = client(app);
  const res = await c.post("/api/auth/signup", { email, password: PASSWORD, termsVersion: TERMS });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return c;
}

export function sse(events: unknown[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
}
