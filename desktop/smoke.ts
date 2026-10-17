// `Kerf --smoke-test` opens a template, waits for its geometry and checks,
// prints what happened (and writes it to $KERF_SMOKE_OUT) and exits: 0 when
// everything worked. CI runs it on the
// packaged Windows app, which proves the protocol, security headers, workers,
// OpenCASCADE and WebGL all work there, not just in a browser.

import { app, type BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";

const TEMPLATE = "Screw-Top Canister";
const DONE = /checks? (pass|failing)|check failing|all checks pass/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kerf's current terms version, put in by scripts/build-desktop.mjs, so the first-run screens can be skipped. */
declare const __KERF_TERMS__: string;

export function runSmokeTest(win: BrowserWindow) {
  const wc = win.webContents;
  const errors: string[] = [];
  wc.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message.slice(0, 300));
  });
  const js = <T>(code: string) => wc.executeJavaScript(code, true) as Promise<T>;
  async function until(what: string, test: () => Promise<boolean>, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test().catch(() => false)) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  const run = async () => {
    // skip first-run setup, as someone who has been through it
    await js(`localStorage.setItem("kerf.settings.v1", JSON.stringify({ onboarded: true, termsAccepted: ${JSON.stringify(__KERF_TERMS__)} }))`);
    const loaded = new Promise<void>((r) => wc.once("did-finish-load", () => r()));
    wc.reload();
    await loaded;
    const t0 = Date.now();
    await until("the home screen", () => js<boolean>(`document.body.innerText.includes(${JSON.stringify(TEMPLATE)})`), 60_000);
    const home = Date.now() - t0;
    // the template card holds the name in its own element; click the innermost one
    const clicked = await js<boolean>(`(() => {
      const all = [...document.querySelectorAll("body *")].filter((el) => el.textContent.trim() === ${JSON.stringify(TEMPLATE)});
      const el = all.find((a) => !all.some((b) => b !== a && a.contains(b)));
      el?.click();
      return !!el;
    })()`);
    if (!clicked) throw new Error("the template is not on the home screen");
    const t1 = Date.now();
    await until("the checks", () => js<boolean>(`${DONE}.test(document.querySelector(".topbar")?.textContent ?? "")`), 240_000);
    const checks = Date.now() - t1;
    const topbar = await js<string>(`document.querySelector(".topbar")?.textContent ?? ""`);
    const gl = await js<string>(`(() => {
      const g = document.createElement("canvas").getContext("webgl2");
      const d = g && g.getExtension("WEBGL_debug_renderer_info");
      return g ? (d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : "no WebGL2";
    })()`);
    // let the viewport draw its first frames before the picture
    await sleep(5000);
    const shot = process.env.KERF_SMOKE_SHOT;
    if (shot) writeFileSync(shot, (await wc.capturePage()).toPNG());
    return { ok: !/fail/i.test(topbar) && !errors.length, homeMs: home, checksMs: checks, topbar: topbar.slice(-80), gl, errors };
  };
  const report = (r: { ok: boolean; [k: string]: unknown }) => {
    const line = JSON.stringify(r);
    console.log("KERF_SMOKE " + line);
    if (process.env.KERF_SMOKE_OUT) writeFileSync(process.env.KERF_SMOKE_OUT, line + "\n");
    app.exit(r.ok ? 0 : 1);
  };
  wc.once("did-finish-load", () => {
    run().then(report, (e: unknown) => report({ ok: false, error: e instanceof Error ? e.message : String(e), errors }));
  });
}
