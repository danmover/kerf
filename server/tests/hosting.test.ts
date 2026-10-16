import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { memoryMailer } from "../src/mail.js";
import { parseHeadersFile, RateLimiter } from "../src/security.js";

function fakeBuild() {
  const dir = mkdtempSync(join(tmpdir(), "kerf-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Kerf</title>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "worker-abc123.js"), "self.onmessage=()=>{}");
  for (const w of ["render", "route"]) writeFileSync(join(dir, "assets", `${w}.worker-abc123.js`), "self.onmessage=()=>{}");
  writeFileSync(join(dir, "assets", "kernel-abc123.wasm"), Buffer.from([0, 97, 115, 109]));
  copyFileSync("public/_headers", join(dir, "_headers"));
  return dir;
}

function hosted(env: Record<string, string> = {}) {
  const dir = fakeBuild();
  const cfg = loadConfig({ KERF_ORIGIN: "https://kerf.test", KERF_DATA_DIR: mkdtempSync(join(tmpdir(), "kerf-data-")), KERF_STATIC_DIR: dir, KERF_SIGNUP: "open", ...env }, "test");
  return createApp({ cfg, db: new Db(":memory:"), mailer: memoryMailer(), limiter: new RateLimiter(), fetch, log: () => undefined });
}

const pageCsp = () =>
  parseHeadersFile(readFileSync("public/_headers", "utf8"))
    .filter((r) => r.pattern.test("/"))
    .flatMap((r) => r.headers)
    .find(([k]) => k === "Content-Security-Policy")![1];

describe("hosting the app", () => {
  it("serves the page with the same security headers as a static host", async () => {
    const app = hosted();
    const res = await app.request("https://kerf.test/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Kerf</title>");
    expect(res.headers.get("content-security-policy")).toBe(pageCsp());
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("gives the kernel worker its own policy and caches hashed assets", async () => {
    const app = hosted();
    const worker = await app.request("https://kerf.test/assets/worker-abc123.js");
    expect(worker.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
    expect(worker.headers.get("cache-control")).toContain("immutable");
    const wasm = await app.request("https://kerf.test/assets/kernel-abc123.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    const js = await app.request("https://kerf.test/assets/index-abc123.js");
    expect(js.headers.get("content-security-policy")).toBeNull();
  });

  it("locks the amp's circuit and board routing workers down to their own code", async () => {
    const app = hosted();
    for (const w of ["render", "route"]) {
      const res = await app.request(`https://kerf.test/assets/${w}.worker-abc123.js`);
      expect(res.headers.get("content-security-policy"), w).toBe("default-src 'none'; script-src 'self'");
    }
  });

  it("does not serve the headers file or anything outside the build", async () => {
    const app = hosted();
    expect((await app.request("https://kerf.test/_headers")).status).toBe(404);
    expect((await app.request("https://kerf.test/../package.json")).status).toBe(404);
    expect((await app.request("https://kerf.test/%2e%2e/package.json")).status).toBe(404);
    expect((await app.request("https://kerf.test/nope")).status).toBe(404);
  });

  it("answers API calls with strict headers", async () => {
    const app = hosted();
    const res = await app.request("https://kerf.test/api/health");
    expect(await res.json()).toEqual({ ok: true, version: "test" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect((await app.request("https://kerf.test/api/nothing")).status).toBe(404);
  });
});

describe("configuration", () => {
  const base = { NODE_ENV: "production", KERF_DATA_DIR: mkdtempSync(join(tmpdir(), "kerf-cfg-")) };
  const secret = Buffer.alloc(32, 7).toString("base64");

  it("refuses unsafe production settings", () => {
    expect(() => loadConfig({ ...base, KERF_SECRET_KEY: secret })).toThrow(/KERF_ORIGIN/);
    expect(() => loadConfig({ ...base, KERF_SECRET_KEY: secret, KERF_ORIGIN: "http://kerf.example" })).toThrow(/https/);
    expect(() => loadConfig({ ...base, KERF_ORIGIN: "https://kerf.example" })).toThrow(/KERF_SECRET_KEY/);
    expect(() => loadConfig({ ...base, KERF_ORIGIN: "https://kerf.example", KERF_SECRET_KEY: "short" })).toThrow(/32 random bytes/);
    expect(() => loadConfig({ ...base, KERF_ORIGIN: "https://kerf.example/app", KERF_SECRET_KEY: secret })).toThrow(/origin only/);
  });

  it("closes sign-ups in production unless they are opened or listed", () => {
    const ok = { ...base, KERF_ORIGIN: "https://kerf.example", KERF_SECRET_KEY: secret };
    expect(loadConfig(ok).signup).toBe("allowlist");
    expect(loadConfig(ok).allowedEmails).toEqual([]);
    expect(loadConfig({ ...ok, KERF_ALLOWED_EMAILS: "Dan@Example.com" }).allowedEmails).toEqual(["dan@example.com"]);
    expect(loadConfig({ ...ok, KERF_SIGNUP: "open" }).signup).toBe("open");
  });

  it("needs both a shared key and who may use it", () => {
    const ok = { ...base, KERF_ORIGIN: "https://kerf.example", KERF_SECRET_KEY: secret };
    expect(loadConfig({ ...ok, KERF_SHARED_ANTHROPIC_KEY: "sk-ant-x" }).shared).toBeNull();
    expect(loadConfig({ ...ok, KERF_SHARED_ANTHROPIC_KEY: "sk-ant-x", KERF_SHARED_CLAUDE_EMAILS: "*@team.example" }).shared).toMatchObject({ emails: ["*@team.example"], dailyTokens: 1_000_000 });
  });
});
