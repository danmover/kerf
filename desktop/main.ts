// Kerf as a desktop app: one window showing the production build of the web
// app from Kerf's own kerf://app origin, with the security headers it has on
// the web. What the desktop adds is control a browser tab doesn't give:
// Kerf always gets the fast graphics card, its work doesn't slow down behind
// other windows, and the graphics backend can be switched in Settings. It can
// also offer Kerf's design tools to the person's own Claude Code (desktop/mcp.ts).

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HOST, ORIGIN, SCHEME, staticHandler } from "./serve.js";
import { backendsFor, loadSettings, loadWindowState, saveSettings, saveWindowState, type GraphicsBackend } from "./settings.js";
import { runSmokeTest } from "./smoke.js";
import { DEFAULT_PORT, MCP_INSTRUCTIONS, newToken, pipePath, startMcp, type RunningMcp } from "./mcp.js";
import { Down, TOOLS_CACHE, post } from "./bridge.js";
import { describe, findClaude, getEntry, isConnected, isOurs as isOurEntry, kerfEntries, register, unregister, type BridgeSpec, type ClaudeCli, type Step } from "./claudeCli.js";

const SMOKE = process.argv.includes("--smoke-test");
// the smoke test starts from an empty profile and never touches real projects
if (SMOKE) app.setPath("userData", mkdtempSync(join(tmpdir(), "kerf-smoke-")));
const userData = app.getPath("userData");
const settings = loadSettings(userData, process.platform);

// ---------- before Chromium starts ----------

protocol.registerSchemesAsPrivileged([
  // standard + secure: a real origin with storage, workers and crypto.subtle; codeCache: compiled scripts are kept between launches
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);
// on a laptop with two graphics chips, use the fast one
app.commandLine.appendSwitch("force_high_performance_gpu");
// after a graphics card reset (a long photoreal trace can trip Windows' GPU
// timeout) Chromium would block WebGL for the page until Kerf restarts; let the
// 3D view get its context back instead
app.disableDomainBlockingFor3DAPIs();
if (settings.graphics !== "auto") app.commandLine.appendSwitch("use-angle", settings.graphics);
// When Chromium can't use the graphics card (a backend that fails on this card,
// a driver it distrusts, Remote Desktop, a PC or CI machine with no card) it
// falls back to drawing WebGL in software, which recent Chromium only allows
// with this switch. Kerf only ever shows its own pages, so allowing it is safe,
// and a slow 3D view beats none. The page then says it is drawing in software.
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
// the backend Kerf switched away from because it couldn't start 3D (see kerf:graphics-failed)
const resetFrom = process.argv.find((a) => a.startsWith("--kerf-graphics-reset="))?.split("=")[1] ?? "";

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// ---------- the window ----------

function createWindow() {
  const saved = SMOKE ? null : loadWindowState(userData);
  const onScreen = saved && saved.x !== undefined && saved.y !== undefined && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x! < a.x + a.width - 100 && saved.x! + saved.width > a.x + 100 && saved.y! >= a.y - 20 && saved.y! < a.y + a.height - 100;
  });
  win = new BrowserWindow({
    width: saved?.width ?? 1600,
    height: saved?.height ?? 1000,
    ...(onScreen ? { x: saved!.x, y: saved!.y } : {}),
    minWidth: 760,
    minHeight: 520,
    title: "Kerf",
    // Kerf's dark backdrop, so the window never flashes white while it loads
    backgroundColor: "#0b0e14",
    show: false,
    autoHideMenuBar: true,
    icon: process.platform === "linux" ? join(app.getAppPath(), "icon.png") : undefined,
    webPreferences: {
      preload: join(app.getAppPath(), "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // geometry builds, Claude turns and renders keep their pace while another window is in front
      backgroundThrottling: false,
    },
  });
  if (process.platform !== "darwin") win.setMenu(null);
  const w = win;
  w.once("ready-to-show", () => {
    if (SMOKE) return w.showInactive();
    if (saved?.maximized ?? true) w.maximize();
    w.show();
  });
  w.on("close", () => {
    if (SMOKE) return;
    const b = w.getNormalBounds();
    saveWindowState(userData, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized() });
  });
  w.on("closed", () => {
    win = null;
    pageGone();
  });
  w.webContents.on("did-start-loading", pageGone);
  shortcuts(w.webContents);
  w.webContents.on("render-process-gone", (_e, d) => {
    pageGone();
    if (d.reason === "clean-exit" || SMOKE) return;
    const choice = dialog.showMessageBoxSync(w, {
      type: "error",
      title: "Kerf stopped",
      message: "Kerf stopped unexpectedly.",
      detail: `Your projects are saved as you work, so reloading picks up where you were. (${d.reason}, code ${d.exitCode})`,
      buttons: ["Reload", "Quit"],
      defaultId: 0,
    });
    if (choice === 0) w.reload();
    else app.quit();
  });
  void w.loadURL(`${ORIGIN}/`);
  if (SMOKE) runSmokeTest(w);
}

/** With no menu bar on Windows and Linux, the browser shortcuts people expect are handled here. */
function shortcuts(wc: WebContents) {
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    if (key === "f11") {
      const w = BrowserWindow.fromWebContents(wc);
      w?.setFullScreen(!w.isFullScreen());
    } else if (key === "f12" || (mod && input.shift && key === "i")) wc.toggleDevTools();
    else if (key === "f5" || (mod && key === "r")) wc.reload();
    else if (mod && (key === "=" || key === "+")) wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4));
    else if (mod && key === "-") wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -4));
    else if (mod && key === "0") wc.setZoomLevel(0);
    else return;
    e.preventDefault();
  });
}

// ---------- what pages may do ----------

const isOurs = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && u.host === HOST;
  } catch {
    return false;
  }
};

app.on("web-contents-created", (_e, wc) => {
  // Kerf never navigates away from itself; links to the web open in the default browser
  wc.on("will-navigate", (e, url) => {
    if (!isOurs(url)) e.preventDefault();
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    // a reference picture or an exported image opened in its own window
    if (url.startsWith(`blob:${ORIGIN}/`))
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#0b0e14", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    return { action: "deny" };
  });
});

function lockDown() {
  const allowed = new Set(["media", "clipboard-sanitized-write", "fullscreen", "pointerLock"]);
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    // the microphone for voice input, and the camera for an app's camera panel: Kerf's own page only
    if (permission === "media") return done(isOurs(wc.getURL()));
    done(allowed.has(permission) && isOurs(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => !!wc && isOurs(wc.getURL()) && (allowed.has(permission) || permission === "media" || permission === "serial"));
  // a USB serial port for the Calibrate panel's bench test and the apps' USB link: the one the person picks
  session.defaultSession.on("select-serial-port", (e, ports, wc, pick) => {
    e.preventDefault();
    if (!isOurs(wc.getURL()) || !ports.length) return pick("");
    if (ports.length === 1) return pick(ports[0].portId);
    const names = ports.map((p) => p.displayName || p.portName || p.portId);
    const win = BrowserWindow.fromWebContents(wc);
    const opts = { type: "question" as const, title: "Kerf", message: "Which port is the machine's controller on?", buttons: [...names, "Cancel"], cancelId: names.length, noLink: true };
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(({ response }) => pick(ports[response]?.portId ?? ""));
  });
}

// ---------- the bridge to Settings → Desktop ----------

function fromKerf(e: IpcMainInvokeEvent) {
  if (!e.senderFrame || !isOurs(e.senderFrame.url)) throw new Error("not Kerf");
}

function bridge() {
  ipcMain.handle("kerf:desktop-info", (e) => {
    fromKerf(e);
    return {
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      graphics: settings.graphics,
      // what this launch is actually using, which differs from `graphics` until a restart
      running: app.commandLine.getSwitchValue("use-angle") || "auto",
      backends: backendsFor(process.platform),
      resetFrom,
    };
  });
  // The page couldn't get hardware WebGL 2 (none at all, or only software). If
  // that's with a backend chosen in Settings, go back to Auto and restart; the
  // next launch is on Auto, so this happens at most once.
  ipcMain.handle("kerf:graphics-failed", (e) => {
    fromKerf(e);
    const running = app.commandLine.getSwitchValue("use-angle") || "auto";
    if (SMOKE || running === "auto") return { relaunching: false };
    settings.graphics = "auto";
    saveSettings(userData, settings);
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => !a.startsWith("--kerf-graphics-reset=")), `--kerf-graphics-reset=${running}`] });
    app.quit();
    return { relaunching: true };
  });
  ipcMain.handle("kerf:set-graphics", (e, backend: GraphicsBackend) => {
    fromKerf(e);
    if (!backendsFor(process.platform).includes(backend)) throw new Error("unknown graphics backend");
    settings.graphics = backend;
    saveSettings(userData, settings);
  });
  ipcMain.handle("kerf:relaunch", (e) => {
    fromKerf(e);
    app.relaunch();
    app.quit();
  });
  ipcMain.handle("kerf:claude-code-info", (e) => {
    fromKerf(e);
    return claudeCodeInfo();
  });
  ipcMain.handle("kerf:set-claude-code", async (e, enabled: boolean) => {
    fromKerf(e);
    settings.claudeCode.enabled = enabled === true;
    await stopClaudeCode();
    if (settings.claudeCode.enabled) await startClaudeCode();
    else {
      // take Kerf back out of Claude Code, so its sessions don't list tools that only say "turned off"
      if (settings.claudeCode.registered) {
        const cli = await findClaude(homedir());
        if (cli && (await unregister(cli, homedir()))) settings.claudeCode.registered = null;
      }
      saveSettings(userData, settings);
    }
    return claudeCodeInfo();
  });
  ipcMain.handle("kerf:claude-code-connect", async (e) => {
    fromKerf(e);
    return connectClaudeCode();
  });
  ipcMain.handle("kerf:claude-code-check", async (e) => {
    fromKerf(e);
    return checkClaudeCode();
  });
  ipcMain.handle("kerf:claude-code-new-token", async (e) => {
    fromKerf(e);
    settings.claudeCode.token = newToken();
    // what connected before used the old token
    lastConnect = lastRefused = null;
    await stopClaudeCode();
    if (settings.claudeCode.enabled) await startClaudeCode();
    else saveSettings(userData, settings);
    return claudeCodeInfo();
  });
  ipcMain.handle("kerf:mcp-ready", (e) => {
    fromKerf(e);
    pageReady = true;
    for (const w of readyWaiters) w();
    readyWaiters = [];
  });
  ipcMain.handle("kerf:mcp-response", (e, r: { id: number; result?: unknown; error?: string }) => {
    fromKerf(e);
    const c = calls.get(r?.id);
    if (!c) return;
    if (r.error !== undefined) c.reject(new Error(String(r.error)));
    else c.resolve(r.result);
  });
}

// ---------- Kerf's tools for the person's own Claude Code ----------

let mcp: RunningMcp | null = null;
/** the port Kerf wanted when it last started the server, to say so when another program had it */
let portWanted = DEFAULT_PORT;
let mcpError = "";
/** the last time a program connected, and the last time one was turned away, for the status in Settings */
let lastConnect: { at: number; client: string } | null = null;
let lastRefused: { at: number; why: "no-token" | "wrong-token" } | null = null;
let pageReady = false;
let readyWaiters: (() => void)[] = [];
let nextCall = 1;
const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Wait for the page to start answering: Claude Code may call the moment Kerf opens, or while it reloads. */
function pageAnswering(signal: AbortSignal, ms = 90_000) {
  if (pageReady) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(t);
      signal.removeEventListener("abort", stop);
      readyWaiters = readyWaiters.filter((w) => w !== ready);
      resolve(v);
    };
    const ready = () => done(true);
    const stop = () => done(false);
    const t = setTimeout(stop, ms);
    signal.addEventListener("abort", stop, { once: true });
    readyWaiters.push(ready);
  });
}

/** Run a tools/list or tools/call in the page, where the design and its tools live. */
async function askPage(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
  if (!(await pageAnswering(signal))) throw new Error(signal.aborted ? "Cancelled." : "Kerf is still starting. Try again in a few seconds.");
  const wc = win?.webContents;
  if (!wc || wc.isDestroyed()) throw new Error("Kerf's window is closed. Ask the person to open Kerf.");
  const id = nextCall++;
  const onAbort = () => wc.isDestroyed() || wc.send("kerf:mcp-cancel", id);
  signal.addEventListener("abort", onAbort, { once: true });
  return new Promise<unknown>((resolve, reject) => {
    calls.set(id, { resolve, reject });
    wc.send("kerf:mcp-request", { id, method, params });
  }).finally(() => {
    calls.delete(id);
    signal.removeEventListener("abort", onAbort);
  });
}

/** A reload or crash drops whatever the page was running. */
function pageGone() {
  pageReady = false;
  for (const c of calls.values()) c.reject(new Error("Kerf reloaded while running this. Call it again."));
  calls.clear();
}

/** The page's answer, with the tool list kept for the bridge to offer while Kerf is closed. */
async function fromPage(method: "tools/list" | "tools/call", params: unknown, signal: AbortSignal) {
  const r = await askPage(method, params, signal);
  if (method === "tools/list") {
    try {
      writeFileSync(join(userData, TOOLS_CACHE), JSON.stringify({ version: app.getVersion(), tools: (r as { tools?: unknown })?.tools ?? [] }));
    } catch {
      /* the bridge waits for Kerf instead */
    }
  }
  return r;
}

async function startClaudeCode() {
  const cc = settings.claudeCode;
  if (!cc.token) cc.token = newToken();
  mcpError = "";
  portWanted = cc.port;
  try {
    mcp = await startMcp({
      port: cc.port,
      token: cc.token,
      pipe: pipePath(userData),
      backend: { request: fromPage, instructions: MCP_INSTRUCTIONS, version: app.getVersion() },
      onSeen: (s) => {
        if (s.kind === "connected") lastConnect = { at: Date.now(), client: s.client };
        else lastRefused = { at: Date.now(), why: s.why };
      },
    });
    // keep the port it found, so the command Claude Code saved keeps working
    cc.port = mcp.port;
  } catch (e) {
    mcp = null;
    mcpError = (e as Error).message;
  }
  saveSettings(userData, settings);
}

async function stopClaudeCode() {
  await mcp?.close();
  mcp = null;
}

/** How Claude Code starts Kerf's bridge: this Kerf's own executable, as Node, on the bridge script beside the app. */
function bridgeSpec(): BridgeSpec {
  // the bridge is unpacked from app.asar (electron-builder.yml), so a plain Node can load it
  const dir = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
  const args = [join(dir, "mcp-bridge.cjs"), "--kerf-data", userData];
  // unpackaged (`electron .desktop/app`), Electron needs the app folder to open Kerf
  if (!app.isPackaged) args.push("--kerf-app", app.getAppPath());
  return { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The command that does what Connect does, for a terminal. Its quoting works in Command Prompt, PowerShell and macOS's shells. */
function bridgeCommand(spec: BridgeSpec) {
  const q = (a: string) => (/^[\w./:\\-]+$/.test(a) ? a : `"${a}"`);
  return `claude mcp add --scope user kerf -e ELECTRON_RUN_AS_NODE=1 -- ${[spec.command, ...spec.args].map(q).join(" ")}`;
}

function claudeCodeInfo() {
  const cc = settings.claudeCode;
  const spec = bridgeSpec();
  return {
    enabled: cc.enabled,
    running: !!mcp,
    url: mcp?.url ?? `http://127.0.0.1:${cc.port}/mcp`,
    token: cc.token,
    error: mcpError,
    lastConnect,
    lastRefused,
    pipe: mcp?.pipe ?? "",
    registered: !!cc.registered,
    bridgeCommand: bridgeCommand(spec),
  };
}

const NO_CLAUDE: Step = {
  ok: false,
  t: "Claude Code isn't installed on this computer",
  d: "Install it from code.claude.com, run claude once in a terminal to sign in, then press Connect again. If it is installed somewhere unusual, use the command under Set up by hand.",
};

/** Where this Kerf is running from, when Claude Code couldn't start it from there later. */
function placeWarning(): Step | null {
  if (process.platform === "darwin" && process.execPath.startsWith("/Volumes/"))
    return { ok: null, t: "Kerf is running from its disk image", d: "Drag Kerf into Applications and connect again from there, or Claude Code can't start Kerf after the disk image is ejected." };
  if (process.env.APPIMAGE) return { ok: null, t: "Kerf is an AppImage", d: "Its files move each time it starts, so connect again after restarting Kerf if Claude Code loses it." };
  return null;
}

/** Connect: turn Kerf's tools on, add Kerf's bridge to Claude Code in place of any old kerf, and check that Claude Code reaches it. */
async function connectClaudeCode() {
  const steps: Step[] = [];
  const cc = settings.claudeCode;
  if (!cc.enabled || !mcp) {
    cc.enabled = true;
    await stopClaudeCode();
    await startClaudeCode();
  }
  if (!mcp) {
    steps.push({ ok: false, t: "Kerf couldn't start its tools", d: mcpError });
    return { ok: false, steps, info: claudeCodeInfo() };
  }
  if (!mcp.pipe) steps.push({ ok: null, t: "Kerf's pipe didn't open", d: `The bridge uses ${mcp.url} instead. (${mcp.pipeError})` });
  const home = homedir();
  const cli = await findClaude(home);
  if (!cli) {
    steps.push(NO_CLAUDE);
    return { ok: false, steps, info: claudeCodeInfo() };
  }
  steps.push({ ok: true, t: `Found Claude Code ${cli.version}`, d: cli.path });
  const spec = bridgeSpec();
  const r = await register(cli, spec, home);
  steps.push(...r.steps);
  const where = placeWarning();
  if (where) steps.push(where);
  // what the add saved stays saved even when the check after it failed
  if (r.steps.some((s) => s.t === "Added Kerf to Claude Code")) cc.registered = { command: spec.command, args: spec.args };
  saveSettings(userData, settings);
  return { ok: r.ok, steps, info: claudeCodeInfo() };
}

/** Ask Kerf's own server, over the pipe or the port, and make sure it is this Kerf that answers. */
async function selfTest(target: { socketPath: string } | { host: string; port: number }): Promise<string> {
  try {
    const r = await post(target, settings.claudeCode.token, JSON.stringify({ jsonrpc: "2.0", id: "kerf-self-check", method: "ping" }), AbortSignal.timeout(5000));
    if (r.kerf !== mcp?.instance) return "another program answered";
    if (r.status !== 200 || JSON.parse(r.body)?.result === undefined) return `Kerf answered ${r.status}`;
    return "";
  } catch (e) {
    return e instanceof Down ? "nothing is listening" : (e as Error).message;
  }
}

/** Check: every link between Claude Code and Kerf, with what to do about the first one that's broken. */
async function checkClaudeCode() {
  const steps: Step[] = [];
  const cc = settings.claudeCode;
  const done = () => ({ ok: steps.every((s) => s.ok !== false), steps, info: claudeCodeInfo() });
  if (!cc.enabled || !mcp) {
    steps.push({ ok: false, t: cc.enabled ? "Kerf's tools for Claude Code aren't running" : "Claude Code is turned off in Kerf", d: mcpError || "Press Connect Claude Code." });
    return done();
  }
  const viaPipe = mcp.pipe ? await selfTest({ socketPath: mcp.pipe }) : mcp.pipeError;
  steps.push(viaPipe ? { ok: false, t: "Kerf's pipe doesn't answer", d: viaPipe } : { ok: true, t: "Kerf's pipe answers", d: mcp.pipe ?? "" });
  const viaPort = await selfTest({ host: "127.0.0.1", port: mcp.port });
  const moved = mcp.port !== portWanted ? ` Another program had port ${portWanted}, so Kerf moved to ${mcp.port}.` : "";
  steps.push(viaPort ? { ok: null, t: `Port ${mcp.port} doesn't answer as Kerf`, d: `${viaPort}. Only connections set up by hand use it.${moved}` } : { ok: true, t: `Kerf answers on ${mcp.url}`, d: moved.trim() || undefined });
  const home = homedir();
  const cli = await findClaude(home);
  if (!cli) {
    steps.push(NO_CLAUDE);
    return done();
  }
  steps.push({ ok: true, t: `Found Claude Code ${cli.version}`, d: cli.path });
  const { user, folders } = kerfEntries(home, cli.env);
  const spec = bridgeSpec();
  if (!user) steps.push({ ok: false, t: "Claude Code doesn't have Kerf yet", d: "Press Connect Claude Code." });
  else if (isOurEntry(user, spec) || /^(http|sse)$/i.test(user.type ?? "")) {
    // only Kerf's own entries are started for the check; an old mcp-remote one could open a browser
    const e = await getEntry(cli, home);
    const ok = isConnected(e.status);
    const http = !isOurEntry(user, spec);
    const wrongPort = http && user.url && !user.url.includes(`:${mcp.port}/`) ? ` It points at ${user.url}, but Kerf is on ${mcp.url}.` : "";
    const mangled = /InvalidHTTPResponse|chunked|unreadable/i.test(e.issue) ? " Something on this computer (a proxy, VPN or antivirus web filter) is changing Kerf's replies on their way to Claude Code." : "";
    steps.push(
      ok && !wrongPort
        ? { ok: true, t: `Claude Code reaches Kerf${http ? " over HTTP" : ""}`, d: e.status }
        : { ok: false, t: http ? "Claude Code's HTTP connection to Kerf fails" : "Claude Code can't start Kerf's bridge", d: `${e.issue || e.status || e.raw.slice(0, 300)}.${wrongPort}${mangled} Press Connect Claude Code${http ? " to switch to Kerf's bridge, which doesn't use HTTP" : ""}.` },
    );
    if (http && ok) steps.push({ ok: null, t: "Claude Code uses the HTTP connection set up by hand", d: "It breaks when Kerf's port or token changes. Connect Claude Code switches to Kerf's bridge, which keeps up by itself." });
    const proxy = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].filter((k) => process.env[k] || process.env[k.toLowerCase()]);
    const noProxy = `${process.env.NO_PROXY ?? ""},${process.env.no_proxy ?? ""}`;
    if (http && proxy.length && !/127\.0\.0\.1|localhost|\*/.test(noProxy))
      steps.push({ ok: null, t: `A proxy is set (${proxy.join(", ")})`, d: "Claude Code sends even 127.0.0.1 through it unless NO_PROXY lists 127.0.0.1. Kerf's bridge isn't affected." });
  } else steps.push({ ok: false, t: "Claude Code's kerf isn't Kerf's own connection", d: `It is ${describe(user)}. Press Connect Claude Code to replace it.` });
  if (folders.length)
    steps.push({ ok: false, t: folders.length === 1 ? "A folder has an old Kerf connection of its own" : `${folders.length} folders have old Kerf connections of their own`, d: `${folders.length === 1 ? "It wins" : "They win"} over Kerf's connection when Claude Code starts in ${folders.join(", ")}. Connect Claude Code removes ${folders.length === 1 ? "it" : "them"}.` });
  const where = placeWarning();
  if (where) steps.push(where);
  if (lastConnect) steps.push({ ok: true, t: `Last connection: ${lastConnect.client}`, d: new Date(lastConnect.at).toLocaleTimeString() });
  return done();
}

/** A Kerf that moved (a new install folder, a Mac app dragged elsewhere) puts its Claude Code connection right by itself. */
async function keepRegistrationCurrent() {
  const cc = settings.claudeCode;
  const spec = bridgeSpec();
  if (!cc.enabled || !cc.registered || (cc.registered.command === spec.command && JSON.stringify(cc.registered.args) === JSON.stringify(spec.args))) return;
  const cli: ClaudeCli | null = await findClaude(homedir());
  if (!cli) return;
  const r = await register(cli, spec, homedir());
  if (r.steps.some((s) => s.t === "Added Kerf to Claude Code")) {
    cc.registered = { command: spec.command, args: spec.args };
    saveSettings(userData, settings);
  }
}

// ---------- start ----------

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("app.kerf.desktop");
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  protocol.handle(SCHEME, staticHandler(join(app.getAppPath(), "web")));
  lockDown();
  bridge();
  createWindow();
  if (settings.claudeCode.enabled && !SMOKE) void startClaudeCode().then(keepRegistrationCurrent);
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on("will-quit", () => void stopClaudeCode());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
