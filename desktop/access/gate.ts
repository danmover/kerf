// The sign-in window Kerf shows before its own, and the main process's half
// of the account tools in Settings → Account. The page in desktop/access/gate/
// only collects what's typed: every decision is made here, in the controller.

import { app, BrowserWindow, clipboard, ipcMain, net, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { AccessClient, loadOwnerKey } from "./client.js";
import { accessConfig } from "./config.js";
import { thisComputer } from "./computer.js";
import { AccessController, type SignedIn } from "./controller.js";
import { AccessStore } from "./store.js";

/** How often a running Kerf checks that its account is still allowed here. */
const RECHECK_MS = 4 * 3_600_000;

export class Gate {
  readonly controller: AccessController;
  private win: BrowserWindow | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** `enter` opens Kerf's window for the account and resolves once it is showing; `leave` closes it. */
  constructor(
    userData: string,
    private enter: (s: SignedIn) => Promise<void>,
    private leave: () => void,
  ) {
    const cfg = accessConfig();
    const store = new AccessStore(userData);
    const fetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => net.fetch(url, { ...init, cache: "no-store" });
    const client = new AccessClient(cfg.server, fetchFn, loadOwnerKey(store.dir, cfg.publicKey));
    this.controller = new AccessController(store, client, thisComputer(store.dir).code, cfg.publicKey, `Kerf ${app.getVersion()} ${process.platform}`);
    this.handlers();
  }

  /** At launch: straight into Kerf for an account that stays signed in here, else the sign-in window. */
  async start() {
    const s = await this.controller.resume().catch(() => null);
    if (s) return this.go(s);
    this.show();
  }

  get open() {
    return !!this.win;
  }

  focus() {
    if (this.win?.isMinimized()) this.win.restore();
    this.win?.focus();
  }

  show() {
    if (this.win) return this.focus();
    const w = (this.win = new BrowserWindow({
      width: 460,
      height: 660,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Kerf",
      backgroundColor: "#0b0e14",
      show: false,
      autoHideMenuBar: true,
      icon: process.platform === "linux" ? join(app.getAppPath(), "icon.png") : undefined,
      webPreferences: {
        preload: join(app.getAppPath(), "gate-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    }));
    if (process.platform !== "darwin") w.setMenu(null);
    w.once("ready-to-show", () => w.show());
    w.on("closed", () => {
      if (this.win === w) this.win = null;
    });
    void w.loadFile(join(app.getAppPath(), "gate", "index.html"));
  }

  private async go(s: SignedIn) {
    await this.enter(s);
    const w = this.win;
    this.win = null;
    w?.close();
    this.watch();
  }

  /** Check now and then that the account hasn't been switched off or moved; sign out if it has. */
  private watch() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(async () => {
      const s = this.controller.session;
      if (!s) return;
      const next = await this.controller.check(s.account).catch(() => s);
      if (!next) this.signOut(false);
    }, RECHECK_MS);
  }

  /** Back to the sign-in window. */
  signOut(byPerson = true) {
    if (byPerson) this.controller.signOut();
    else this.controller.session = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.show();
    this.leave();
  }

  private fromGate(e: IpcMainInvokeEvent) {
    if (!this.win || e.sender !== this.win.webContents) throw new Error("not the sign-in window");
  }

  private handlers() {
    const c = this.controller;
    const done = async (r: Awaited<ReturnType<AccessController["signIn"]>>) => {
      if (!r.ok) return { ok: false, message: r.message, field: r.field };
      await this.go(r.session);
      return { ok: true };
    };
    ipcMain.handle("kerf-gate:screen", async (e) => {
      this.fromGate(e);
      return { ...(await c.screen()), version: app.getVersion() };
    });
    ipcMain.handle("kerf-gate:sign-in", async (e, a: { user: string; password: string; stay: boolean }) => {
      this.fromGate(e);
      return done(await c.signIn(String(a?.user ?? ""), String(a?.password ?? ""), !!a?.stay));
    });
    ipcMain.handle("kerf-gate:owner-setup", async (e, a: { user: string; password: string; stay: boolean }) => {
      this.fromGate(e);
      return done(await c.setUpOwner(String(a?.user ?? ""), String(a?.password ?? ""), !!a?.stay));
    });
    ipcMain.handle("kerf-gate:copy-code", (e) => {
      this.fromGate(e);
      clipboard.writeText(c.computer.match(/.{4}/g)!.join("-"));
    });
    ipcMain.handle("kerf-gate:quit", (e) => {
      this.fromGate(e);
      app.quit();
    });
  }
}
