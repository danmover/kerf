// Setting up the person's own Claude Code for Kerf, through Claude Code's own
// command line (`claude mcp …`), so nobody has to copy a command into a
// terminal. Kerf only adds, checks and removes its own `kerf` server entry; it
// never reads or touches Claude Code's sign-in.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Claude Code's command line, as found on this computer. */
export interface ClaudeCli {
  path: string;
  version: string;
  /** the PATH to run it with: a Mac app doesn't get the terminal's PATH, and an npm install needs node on it */
  env: NodeJS.ProcessEnv;
}

/** How Claude Code should start Kerf's stdio bridge (desktop/bridge.ts). */
export interface BridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What `claude mcp get kerf` says. */
export interface KerfEntry {
  found: boolean;
  scope: string;
  status: string;
  type: string;
  command: string;
  args: string;
  url: string;
  issue: string;
}

export interface Ran {
  code: number;
  out: string;
}

const NAME = "kerf";

/** Where Claude Code's installers put `claude`, after the folders on PATH. */
export function claudeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const path = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const out: string[] = [];
  if (platform === "win32") {
    for (const d of path) out.push(join(d, "claude.exe"), join(d, "claude.cmd"));
    const profile = env.USERPROFILE || home;
    out.push(join(profile, ".local", "bin", "claude.exe"));
    if (env.APPDATA) out.push(join(env.APPDATA, "npm", "claude.cmd"));
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "claude.exe"));
  } else {
    for (const d of path) out.push(join(d, "claude"));
    out.push(
      join(home, ".local", "bin", "claude"),
      join(home, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      join(home, ".npm-global", "bin", "claude"),
      join(home, ".bun", "bin", "claude"),
      join(home, ".volta", "bin", "claude"),
      "/home/linuxbrew/.linuxbrew/bin/claude",
    );
  }
  return [...new Set(out)];
}

// Escaping for cmd.exe, as cross-spawn does it (https://qntm.org/cmd): an npm
// install on Windows is a claude.cmd shim, which Node can only start through
// cmd.exe, and the shim hands its arguments on through cmd a second time.
const META = /([()\][%!^"`<>&|;, *?])/g;
export function cmdArg(arg: string, shim: boolean) {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  a = `"${a}"`.replace(META, "^$1");
  return shim ? a.replace(META, "^$1") : a;
}

/** The command line cmd.exe runs for a .cmd file: `cmd /d /s /c "<this>"`. */
export function cmdLine(file: string, args: string[]) {
  return [file.replace(META, "^$1"), ...args.map((a) => cmdArg(a, true))].join(" ");
}

/** Run a program and collect its output; never throws. */
export function run(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<Ran> {
  const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const [cmd, argv] = viaCmd ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmdLine(file, args)}"`]] : [file, args];
  return new Promise((resolve) => {
    execFile(
      cmd,
      argv,
      { cwd: opts.cwd, env: opts.env, timeout: opts.timeout ?? 60_000, windowsHide: true, windowsVerbatimArguments: viaCmd, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === "number" ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        const out = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.replace(/\x1b\[[0-9;]*m/g, "").trim();
        resolve({ code, out: err && !out ? err.message : out });
      },
    );
  });
}

/** The PATH a login shell has, on a Mac or Linux, where apps opened from the Dock or a menu get a short one. */
async function loginShellPath(env: NodeJS.ProcessEnv): Promise<string> {
  const shell = env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const r = await run(shell, ["-ilc", 'printf "__KERF_PATH__%s__KERF_PATH__" "$PATH"'], { env, timeout: 6000 });
  return /__KERF_PATH__(.*?)__KERF_PATH__/s.exec(r.out)?.[1] ?? "";
}

/** The environment Claude Code's command line runs in: Kerf's own, with a full PATH, no colour codes and nothing that makes Electron act as Node. */
async function cliEnv(platform: NodeJS.Platform): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (platform !== "win32") {
    const extra = await loginShellPath(env);
    if (extra) env.PATH = [...new Set([...extra.split(delimiter), ...(env.PATH ?? "").split(delimiter)].filter(Boolean))].join(delimiter);
  }
  return env;
}

/** Find Claude Code: the first `claude` that answers --version like Claude Code. */
export async function findClaude(home: string, platform: NodeJS.Platform = process.platform): Promise<ClaudeCli | null> {
  const env = await cliEnv(platform);
  for (const path of claudeCandidates(platform, env, home)) {
    if (!existsSync(path)) continue;
    const r = await run(path, ["--version"], { cwd: home, env, timeout: 20_000 });
    const version = /(\d+\.\d+\.\d+)/.exec(r.out)?.[1];
    if (r.code === 0 && version) return { path, version, env };
  }
  return null;
}

/** Read `claude mcp get kerf`. */
export function parseEntry(out: string): KerfEntry {
  const field = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, "mi").exec(out)?.[1]?.trim() ?? "";
  const found = new RegExp(`^\\s*${NAME}:\\s*$`, "m").test(out);
  return { found, scope: field("Scope"), status: field("Status"), type: field("Type"), command: field("Command"), args: field("Args"), url: field("URL"), issue: field("Issue") };
}

export const isConnected = (status: string) => /connected/i.test(status) && !/fail|not connected|disconnected/i.test(status);

export async function getEntry(cli: ClaudeCli, cwd: string): Promise<KerfEntry & { raw: string }> {
  const r = await run(cli.path, ["mcp", "get", NAME], { cwd, env: cli.env, timeout: 90_000 });
  return { ...parseEntry(r.out), raw: r.out };
}

/** Claude Code's own settings file: ~/.claude.json, or in CLAUDE_CONFIG_DIR when that is set. */
function claudeJson(home: string, env: NodeJS.ProcessEnv) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
}

/** A `kerf` server entry as Claude Code saved it. */
export interface KerfConfig {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
}

/**
 * The `kerf` entries in Claude Code's settings: the one for every folder
 * ("user" scope), and folders that have their own ("local" scope). A folder's
 * own entry wins over the one for every folder, so a broken one there keeps
 * failing however often Kerf connects. Only `kerf` entries are looked at, and
 * this never starts them: an old mcp-remote entry could open a browser.
 */
export function kerfEntries(home: string, env: NodeJS.ProcessEnv = process.env): { user: KerfConfig | null; folders: string[] } {
  try {
    const cfg = JSON.parse(readFileSync(claudeJson(home, env), "utf8"));
    const user = cfg?.mcpServers?.[NAME] ?? null;
    const projects = (cfg?.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>;
    const folders = Object.entries(projects)
      .filter(([dir, p]) => p?.mcpServers && Object.hasOwn(p.mcpServers, NAME) && existsSync(dir))
      .map(([dir]) => dir);
    return { user: user && typeof user === "object" ? user : null, folders };
  } catch {
    return { user: null, folders: [] };
  }
}

/** Whether an entry is Kerf's own bridge from this Kerf. */
export const isOurs = (c: KerfConfig | null, spec: BridgeSpec) =>
  !!c && (c.type ?? "stdio") === "stdio" && c.command === spec.command && JSON.stringify(c.args ?? []) === JSON.stringify(spec.args);

export interface Step {
  ok: boolean | null;
  t: string;
  d?: string;
}

/** Add Kerf's bridge to Claude Code for every folder, replacing whatever `kerf` it had, and check that Claude Code reaches it. */
export async function register(cli: ClaudeCli, spec: BridgeSpec, home: string): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const { user: old, folders } = kerfEntries(home, cli.env);
  // whatever kerf was there (an old URL, mcp-remote, a homemade bridge) makes way
  if (old) await run(cli.path, ["mcp", "remove", NAME, "-s", "user"], { cwd: home, env: cli.env });
  const cleared: string[] = [];
  for (const dir of folders) {
    const r = await run(cli.path, ["mcp", "remove", NAME, "-s", "local"], { cwd: dir, env: cli.env });
    if (r.code === 0) cleared.push(dir);
  }
  if ((old && !isOurs(old, spec)) || cleared.length)
    steps.push({
      ok: true,
      t: "Removed Claude Code's old Kerf connection",
      d: [old && !isOurs(old, spec) && `It was ${describe(old)}.`, cleared.length && `Also removed ones set up for ${cleared.length === 1 ? "one folder" : `${cleared.length} folders`}: ${cleared.join(", ")}.`].filter(Boolean).join(" "),
    });
  const json = JSON.stringify({ type: "stdio", command: spec.command, args: spec.args, env: spec.env });
  const add = await run(cli.path, ["mcp", "add-json", NAME, json, "-s", "user"], { cwd: home, env: cli.env });
  if (add.code !== 0) {
    steps.push({ ok: false, t: "Claude Code wouldn't add Kerf", d: add.out.slice(0, 400) });
    return { ok: false, steps };
  }
  steps.push({ ok: true, t: "Added Kerf to Claude Code", d: "For every folder you start Claude Code in." });
  const now = await getEntry(cli, home);
  const ok = isConnected(now.status);
  steps.push(
    ok
      ? { ok: true, t: "Claude Code reached Kerf", d: `claude mcp list says: ${now.status}` }
      : { ok: false, t: "Claude Code couldn't reach Kerf", d: now.issue || now.status || now.raw.slice(0, 400) },
  );
  return { ok, steps };
}

/** Take Kerf out of Claude Code (when the person turns Claude Code off in Kerf). */
export async function unregister(cli: ClaudeCli, home: string) {
  return (await run(cli.path, ["mcp", "remove", NAME, "-s", "user"], { cwd: home, env: cli.env })).code === 0;
}

/** A short account of a `kerf` entry: "an HTTP connection to http://127.0.0.1:47615/mcp", "mcp-remote", … */
export function describe(c: KerfConfig) {
  const cmd = `${c.command ?? ""} ${(c.args ?? []).join(" ")}`.trim();
  if (/mcp-remote/i.test(cmd)) return "mcp-remote, a bridge Kerf doesn't need";
  if (/^(http|sse)$/i.test(c.type ?? "")) return `an ${c.type!.toUpperCase()} connection to ${c.url ?? "?"}`;
  if (/mcp-bridge\.cjs/.test(cmd)) return "Kerf's bridge from another copy of Kerf";
  if (cmd) return `a program Kerf didn't set up (${cmd.slice(0, 120)})`;
  return "set up by hand";
}
