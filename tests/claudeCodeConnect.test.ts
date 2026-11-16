// Connecting Claude Code to Kerf without a terminal: Kerf's stdio bridge
// (desktop/bridge.ts) over Kerf's local pipe, and the setup through Claude
// Code's own command line (desktop/claudeCli.ts).

import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { CLIENT_HEADER, KERF_HEADER, pipePath, startMcp, type McpBackend, type McpSeen, type RunningMcp } from "../desktop/mcp";
import { post, runBridge, TOOLS_CACHE } from "../desktop/bridge";
import { bundledClaudes, claudeCandidates, cmdArg, describe as describeEntry, isConnected, isOurs, kerfEntries, parseEntry, register, type ClaudeCli } from "../desktop/claudeCli";

const TOKEN = "k".repeat(43);
let dirs: string[] = [];
let servers: RunningMcp[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function dataDir(cc: Record<string, unknown> = { enabled: true, port: 0, token: TOKEN }) {
  const d = mkdtempSync(join(tmpdir(), "kerf-bridge-"));
  dirs.push(d);
  writeFileSync(join(d, "desktop-settings.json"), JSON.stringify({ claudeCode: cc }));
  return d;
}

async function kerf(dir: string, request: McpBackend["request"], onSeen?: (s: McpSeen) => void) {
  const s = await startMcp({ port: 0, token: TOKEN, pipe: pipePath(dir), backend: { request, instructions: "Use kerf_instructions first.", version: "9.9.9" }, onSeen });
  servers.push(s);
  // the bridge reads the port from Kerf's settings, as it would from the real app
  const file = join(dir, "desktop-settings.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ claudeCode: { ...cfg.claudeCode, port: s.port } }));
  return s;
}

/** Claude Code's side of the bridge: write lines in, read replies out. */
function claudeCode(dir: string, launch: () => void = () => {}) {
  const input = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  const waiting = new Map<unknown, (m: Record<string, unknown>) => void>();
  const done = runBridge({
    dataDir: dir,
    input,
    write: (line) => {
      expect(line).not.toContain("\n");
      const m = JSON.parse(line);
      replies.push(m);
      waiting.get(m.id)?.(m);
    },
    version: "9.9.9",
    launch,
    launchWaitMs: 3000,
    pollMs: 50,
  });
  let id = 0;
  return {
    replies,
    done,
    send: (m: unknown) => input.write(JSON.stringify(m) + "\n"),
    raw: (line: string) => input.write(line + "\n"),
    ask: (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, any>>((resolve) => {
        const i = ++id;
        waiting.set(i, resolve);
        input.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
      }),
    end: () => input.end(),
  };
}

const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.325" } };

describe("Kerf's local pipe", () => {
  it("answers on a pipe worked out from Kerf's data folder, and says which Kerf answered", async () => {
    const dir = dataDir();
    const s = await kerf(dir, async () => ({}));
    expect(s.pipe).toBe(pipePath(dir));
    const r = await post({ socketPath: s.pipe! }, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect([r.status, JSON.parse(r.body).result, r.kerf]).toEqual([200, {}, s.instance]);
    const tcp = await post({ host: "127.0.0.1", port: s.port }, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(tcp.kerf).toBe(s.instance);
    // the token is still needed on the pipe
    expect((await post({ socketPath: s.pipe! }, "nope", "{}")).status).toBe(401);
  });

  it("names a Windows named pipe, and keeps a long socket path short enough for macOS", () => {
    expect(pipePath("C:\\Users\\dan\\AppData\\Roaming\\Kerf", "win32")).toMatch(/^\\\\\.\\pipe\\kerf-mcp-[0-9a-f]{16}$/);
    expect(pipePath("/Users/dan/Library/Application Support/Kerf", "darwin")).toBe("/Users/dan/Library/Application Support/Kerf/mcp.sock");
    expect(Buffer.byteLength(pipePath(`/Users/${"x".repeat(120)}/Kerf`, "darwin"))).toBeLessThan(104);
    expect(pipePath("/a/Kerf", "linux")).not.toBe(pipePath("/b/Kerf", "linux"));
    // Windows paths aren't case sensitive
    expect(pipePath("C:\\Users\\Dan\\AppData\\Roaming\\Kerf", "win32")).toBe(pipePath("c:\\users\\dan\\appdata\\roaming\\kerf", "win32"));
  });

  it("clears a socket file left by a Kerf that crashed", async () => {
    if (process.platform === "win32") return;
    const dir = dataDir();
    writeFileSync(pipePath(dir), "");
    const s = await kerf(dir, async () => ({}));
    expect(s.pipe).toBe(pipePath(dir));
    expect(s.pipeError).toBe("");
  });
});

describe("Kerf's stdio bridge for Claude Code", () => {
  it("passes Claude Code's messages to Kerf and Kerf's replies back, one line each", async () => {
    const dir = dataDir();
    const seen: McpSeen[] = [];
    await kerf(
      dir,
      async (method, params) => (method === "tools/list" ? { tools: [{ name: "get_design" }] } : { content: [{ type: "text", text: `ran ${(params as { name: string }).name}` }] }),
      (s) => seen.push(s),
    );
    const cc = claudeCode(dir);
    const init = await cc.ask("initialize", INIT);
    expect(init.result.serverInfo).toMatchObject({ name: "kerf", version: "9.9.9" });
    cc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await cc.ask("tools/list")).result.tools).toEqual([{ name: "get_design" }]);
    expect((await cc.ask("tools/call", { name: "get_design", arguments: {} })).result.content[0].text).toBe("ran get_design");
    expect((await cc.ask("ping")).result).toEqual({});
    // Kerf knows who's there, from initialize and from every call after it
    expect(seen.every((s) => s.kind === "connected" && s.client === "claude-code 2.1.325")).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    cc.end();
    await cc.done;
  });

  it("answers Claude Code while Kerf is closed, with the tools Kerf saved last time", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, TOOLS_CACHE), JSON.stringify({ version: "9.9.9", tools: [{ name: "kerf_instructions" }, { name: "get_design" }] }));
    const cc = claudeCode(dir);
    const init = await cc.ask("initialize", { ...INIT, protocolVersion: "2025-06-18" });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "kerf", version: "9.9.9" } });
    expect(init.result.instructions).toContain("kerf_instructions");
    expect((await cc.ask("tools/list")).result.tools.map((t: { name: string }) => t.name)).toEqual(["kerf_instructions", "get_design"]);
    cc.end();
  });

  it("opens Kerf for a tool call while it's closed, and waits for it", async () => {
    const dir = dataDir();
    let launched = 0;
    const cc = claudeCode(dir, () => {
      launched++;
      // Kerf takes a moment to start listening
      setTimeout(() => void kerf(dir, async () => ({ content: [{ type: "text", text: "the design" }] })), 200);
    });
    await cc.ask("initialize", INIT);
    const [a, b] = await Promise.all([cc.ask("tools/call", { name: "get_design" }), cc.ask("tools/call", { name: "get_design" })]);
    expect([a.result.content[0].text, b.result.content[0].text]).toEqual(["the design", "the design"]);
    expect(launched).toBe(1);
    cc.end();
  });

  it("says so when Kerf's tools for Claude Code are turned off, and doesn't open Kerf", async () => {
    const dir = dataDir({ enabled: false, port: 0, token: TOKEN });
    let launched = 0;
    const cc = claudeCode(dir, () => launched++);
    const r = await cc.ask("tools/call", { name: "get_design" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/turned off/);
    expect(launched).toBe(0);
    cc.end();
  });

  it("says Kerf didn't open when it never answers", async () => {
    const dir = dataDir();
    const cc = claudeCode(dir, () => {});
    const r = await cc.ask("tools/call", { name: "get_design" });
    expect(r.result.content[0].text).toMatch(/didn't open in time/);
    cc.end();
  });

  it("picks up a new token without Claude Code being set up again", async () => {
    const dir = dataDir();
    const s = await kerf(dir, async () => ({ content: [{ type: "text", text: "ok" }] }));
    const cc = claudeCode(dir);
    await s.close();
    servers = [];
    const fresh = "n".repeat(43);
    const file = join(dir, "desktop-settings.json");
    writeFileSync(file, JSON.stringify({ claudeCode: { enabled: true, port: 0, token: fresh } }));
    const s2 = await startMcp({ port: 0, token: fresh, pipe: pipePath(dir), backend: { request: async () => ({ content: [{ type: "text", text: "new token works" }] }), instructions: "", version: "1" } });
    servers.push(s2);
    expect((await cc.ask("tools/call", { name: "get_design" })).result.content[0].text).toBe("new token works");
    cc.end();
  });

  it("stops Kerf's call when Claude Code cancels it, and sends no reply for it", async () => {
    const dir = dataDir();
    let aborted = false;
    await kerf(
      dir,
      (_m, _p, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ content: [], isError: true });
          }),
        ),
    );
    const cc = claudeCode(dir);
    cc.send({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "run_analysis" } });
    await new Promise((r) => setTimeout(r, 100));
    cc.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(aborted).toBe(true);
    expect(cc.replies.find((m) => m.id === 41)).toBeUndefined();
    cc.end();
  });

  it("reports a Kerf that closes mid-call rather than hanging", async () => {
    const dir = dataDir();
    const s = await kerf(dir, () => new Promise(() => {}));
    const cc = claudeCode(dir);
    const call = cc.ask("tools/call", { name: "run_analysis" });
    await new Promise((r) => setTimeout(r, 100));
    await s.close();
    servers = [];
    expect((await call).result.content[0].text).toMatch(/closed or reloaded/);
    cc.end();
  });

  it("answers garbage with a parse error and ignores replies from Claude Code", async () => {
    const dir = dataDir();
    const cc = claudeCode(dir);
    cc.raw("not json");
    cc.send({ jsonrpc: "2.0", id: 9, result: {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(cc.replies).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }]);
    cc.end();
  });
});

describe("Kerf's server", () => {
  it("counts the bridge's calls as a connection, but not its pings", async () => {
    const dir = dataDir();
    const seen: McpSeen[] = [];
    const s = await kerf(dir, async () => ({ tools: [] }), (x) => seen.push(x));
    await post({ socketPath: s.pipe! }, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), undefined, "claude-code 2");
    expect(seen).toEqual([]);
    await post({ socketPath: s.pipe! }, TOKEN, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), undefined, "claude-code 2");
    expect(seen).toEqual([{ kind: "connected", client: "claude-code 2" }]);
    expect(KERF_HEADER).toBe("x-kerf");
    expect(CLIENT_HEADER).toBe("x-kerf-client");
  });
});

describe("Setting up Claude Code from Kerf", () => {
  it("escapes arguments for cmd.exe exactly as cross-spawn does", () => {
    const escape = createRequire(import.meta.url)("cross-spawn/lib/util/escape.js") as { argument(a: string, d: boolean): string };
    const json = JSON.stringify({ type: "stdio", command: "C:\\Users\\Dan Smith\\AppData\\Local\\Programs\\kerf\\Kerf.exe", args: ["C:\\x (y)\\mcp-bridge.cjs", "--kerf-data", "C:\\Users\\Dan & Co\\Kerf\\"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    for (const a of [json, "plain", 'quote " inside', "trailing\\", "100%", "a^b|c<d>e"]) {
      expect(cmdArg(a, true)).toBe(escape.argument(a, true));
      expect(cmdArg(a, false)).toBe(escape.argument(a, false));
    }
  });

  it("looks for claude on PATH, then where Claude Code's installers put it", () => {
    const win = claudeCandidates("win32", { Path: "C:\\tools;C:\\bin", USERPROFILE: "C:\\Users\\dan", APPDATA: "C:\\Users\\dan\\AppData\\Roaming" }, "C:\\Users\\dan");
    expect(win.slice(0, 2)).toEqual([join("C:\\tools", "claude.exe"), join("C:\\tools", "claude.cmd")]);
    expect(win).toContain(join("C:\\Users\\dan", ".local", "bin", "claude.exe"));
    expect(win).toContain(join("C:\\Users\\dan\\AppData\\Roaming", "npm", "claude.cmd"));
    const mac = claudeCandidates("darwin", { PATH: "/usr/bin:/bin" }, "/Users/dan");
    expect(mac[0]).toBe("/usr/bin/claude");
    for (const p of ["/Users/dan/.local/bin/claude", "/opt/homebrew/bin/claude", "/Users/dan/.claude/local/claude"]) expect(mac).toContain(p);
  });

  it("finds the Claude Code that comes with the Claude desktop app, newest first", () => {
    const base = mkdtempSync(join(tmpdir(), "kerf-claude-app-"));
    dirs.push(base);
    for (const v of ["2.1.309", "2.1.317", "2.1.99"]) mkdirSync(join(base, "claude-code", v, "a33aa5518497"), { recursive: true });
    mkdirSync(join(base, "claude-code", "tmp"));
    expect(bundledClaudes(base, "claude.exe")).toEqual(["2.1.317", "2.1.309", "2.1.99"].map((v) => join(base, "claude-code", v, "a33aa5518497", "claude.exe")));
    expect(bundledClaudes(join(base, "nowhere"), "claude.exe")).toEqual([]);
    const appdata = mkdtempSync(join(tmpdir(), "kerf-appdata-"));
    dirs.push(appdata);
    mkdirSync(join(appdata, "Claude", "claude-code", "2.1.317", "x"), { recursive: true });
    expect(claudeCandidates("win32", { Path: "", APPDATA: appdata }, "C:\\Users\\dan").at(-1)).toBe(join(appdata, "Claude", "claude-code", "2.1.317", "x", "claude.exe"));
  });

  it("reads claude mcp get", () => {
    const out = `kerf:
  Scope: User config (available in all your projects)
  Status: ✓ Connected
  Type: stdio
  Command: C:\\Users\\dan\\AppData\\Local\\Programs\\kerf\\Kerf.exe
  Args: C:\\x\\mcp-bridge.cjs --kerf-data C:\\Users\\dan\\AppData\\Roaming\\Kerf
  Environment:
    ELECTRON_RUN_AS_NODE=1

To remove this server, run: claude mcp remove kerf -s user`;
    const e = parseEntry(out);
    expect(e).toMatchObject({ found: true, type: "stdio", status: "✓ Connected", command: "C:\\Users\\dan\\AppData\\Local\\Programs\\kerf\\Kerf.exe" });
    expect(isConnected(e.status)).toBe(true);
    expect(isConnected("√ Connected")).toBe(true);
    const bad = parseEntry("kerf:\n  Scope: User config\n  Status: ✗ Failed to connect\n  Type: http\n  URL: http://127.0.0.1:47615/mcp\n  Issue: InvalidHTTPResponse fetching http://127.0.0.1:47615");
    expect([isConnected(bad.status), bad.url, bad.issue]).toEqual([false, "http://127.0.0.1:47615/mcp", "InvalidHTTPResponse fetching http://127.0.0.1:47615"]);
    expect(parseEntry('No MCP server named "kerf".').found).toBe(false);
  });

  it("names what an old kerf entry was", () => {
    expect(describeEntry({ type: "stdio", command: "npx", args: ["-y", "mcp-remote", "http://127.0.0.1:47615/mcp"] })).toMatch(/mcp-remote/);
    expect(describeEntry({ type: "http", url: "http://127.0.0.1:47615/mcp" })).toBe("an HTTP connection to http://127.0.0.1:47615/mcp");
    expect(describeEntry({ type: "stdio", command: "node", args: ["C:\\kerf-test\\kerf-bridge.mjs"] })).toMatch(/didn't set up.*kerf-bridge\.mjs/);
    const spec = { command: "/k/Kerf", args: ["/k/mcp-bridge.cjs", "--kerf-data", "/d"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    expect(isOurs({ type: "stdio", command: "/k/Kerf", args: ["/k/mcp-bridge.cjs", "--kerf-data", "/d"] }, spec)).toBe(true);
    expect(isOurs({ type: "stdio", command: "/old/Kerf", args: ["/old/mcp-bridge.cjs", "--kerf-data", "/d"] }, spec)).toBe(false);
  });

  it("finds folders with their own old kerf, and only kerf", () => {
    const home = mkdtempSync(join(tmpdir(), "kerf-home-"));
    dirs.push(home);
    const folder = join(home, "kerf-test");
    mkdirSync(folder);
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { kerf: { type: "http", url: "http://127.0.0.1:47615/mcp" }, other: {} },
        projects: { [folder]: { mcpServers: { kerf: { type: "stdio", command: "node" } } }, [join(home, "gone")]: { mcpServers: { kerf: {} } }, [home]: { mcpServers: { other: {} } } },
      }),
    );
    expect(kerfEntries(home, {})).toEqual({ user: { type: "http", url: "http://127.0.0.1:47615/mcp" }, folders: [folder] });
    expect(kerfEntries(join(home, "nowhere"), {})).toEqual({ user: null, folders: [] });
  });

  it("replaces an old kerf with Kerf's bridge through Claude Code's command line", async () => {
    if (process.platform === "win32") return;
    // a stand-in for `claude` that keeps its servers in the same file Claude Code does
    const home = mkdtempSync(join(tmpdir(), "kerf-cli-"));
    dirs.push(home);
    const folder = join(home, "kerf-test");
    mkdirSync(folder);
    const cfg = join(home, ".claude.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { kerf: { type: "stdio", command: "npx", args: ["mcp-remote"] } }, projects: { [folder]: { mcpServers: { kerf: { type: "http", url: "x" } } } } }));
    const log = join(home, "calls.log");
    const fake = join(home, "claude");
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ a, cwd: process.cwd() }) + "\\n");
const c = JSON.parse(fs.readFileSync(${JSON.stringify(cfg)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(cfg)}, JSON.stringify(c));
if (a[1] === "remove" && a[4] === "user") { delete c.mcpServers.kerf; save(); }
else if (a[1] === "remove" && a[4] === "local") { delete c.projects[process.cwd()].mcpServers.kerf; save(); }
else if (a[1] === "add-json") { c.mcpServers.kerf = JSON.parse(a[3]); save(); console.log("Added stdio MCP server kerf to user config"); }
else if (a[1] === "get") { console.log("kerf:\\n  Scope: User config\\n  Status: ✓ Connected\\n  Type: stdio"); }
`,
    );
    chmodSync(fake, 0o755);
    const cli: ClaudeCli = { path: fake, version: "2.1.325", env: { ...process.env, CLAUDE_CONFIG_DIR: home } };
    const spec = { command: "/Apps/Kerf", args: ["/Apps/mcp-bridge.cjs", "--kerf-data", "/data dir/Kerf"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    const r = await register(cli, spec, home);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.t)).toEqual(["Removed Claude Code's old Kerf connection", "Added Kerf to Claude Code", "Claude Code reached Kerf"]);
    expect(r.steps[0].d).toMatch(/mcp-remote.*one folder/);
    const after = JSON.parse(readFileSync(cfg, "utf8"));
    expect(after.mcpServers.kerf).toEqual({ type: "stdio", ...spec });
    expect(after.projects[folder].mcpServers.kerf).toBeUndefined();
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls.find((c) => c.a.includes("local")).cwd).toBe(folder);
    // the old mcp-remote entry was never started to check it
    expect(calls.filter((c) => c.a[1] === "get")).toHaveLength(1);
    expect(calls.at(-1).a.slice(0, 3)).toEqual(["mcp", "get", "kerf"]);
  });
});
