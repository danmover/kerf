// Kerf as a desktop app: one window showing the production build of the web
// app from Kerf's own kerf://app origin, with the security headers it has on
// the web. What the desktop adds is control a browser tab doesn't give:
// Kerf always gets the fast graphics card, its work doesn't slow down behind
// other windows, and the graphics backend can be switched in Settings.

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, session, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST, ORIGIN, SCHEME, staticHandler } from "./serve.js";
import { backendsFor, loadSettings, loadWindowState, saveSettings, saveWindowState, type GraphicsBackend } from "./settings.js";
import { runSmokeTest } from "./smoke.js";

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
// CI machines have no graphics card: draw in software there rather than fail
if (SMOKE) app.commandLine.appendSwitch("enable-unsafe-swiftshader");

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
  w.on("closed", () => (win = null));
  shortcuts(w.webContents);
  w.webContents.on("render-process-gone", (_e, d) => {
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
    // the microphone, for voice input; never the camera
    if (permission === "media") return done(isOurs(wc.getURL()) && !(details as { mediaTypes?: string[] }).mediaTypes?.includes("video"));
    done(allowed.has(permission) && isOurs(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => !!wc && isOurs(wc.getURL()) && (allowed.has(permission) || permission === "media" || permission === "serial"));
  // a USB serial port for the Calibrate panel's bench test: the one the person picks
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
    };
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
}

// ---------- start ----------

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("app.kerf.desktop");
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  protocol.handle(SCHEME, staticHandler(join(app.getAppPath(), "web")));
  lockDown();
  bridge();
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
