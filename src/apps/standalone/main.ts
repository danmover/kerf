// A saved app on its own, outside Kerf: one HTML file that carries the app,
// its machine's simulated twin and copies of the design's meshes. It runs on
// the twin (a demo of the machine) or talks to the real machine over USB, with
// the same panels as in Kerf, recording and CSV export. No network access.

import { SignalStore } from "../store";
import { SerialLink, TwinLink, type Link, type LinkKind, type LinkStatus } from "../links";
import { mountApp } from "../runtime/mount";
import { sandboxHtml, type AppHost } from "../runtime/panels";
import { el, forgetPalette } from "../runtime/draw";
import { modelView3d } from "../runtime/model3d";
import { channelInfo } from "../../sim/channels";
import { unpackMesh, wireParse, type AppBundle } from "../wire";
import { fileStemOf } from "../names";
import type { EvalPart } from "../../core/model";
import type { MeshEntry } from "../../core/engine";

const SPEEDS = [0.25, 0.5, 1, 2, 4];

function start() {
  const data = document.getElementById("kerf-app")?.textContent;
  const root = document.getElementById("root")!;
  if (!data) {
    root.append(el("div", "ka-empty big", "This file has lost its app."));
    return;
  }
  const b = wireParse<AppBundle>(data);
  const app = b.app;
  const workerCode = document.getElementById("kerf-twin")?.textContent ?? "";
  document.title = app.name;

  // ---------- the theme: dark by default, as Kerf ----------
  const THEME_KEY = "kerf-app.theme";
  const readTheme = () => {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  };
  const setTheme = (t: "dark" | "light") => {
    document.documentElement.dataset.theme = t;
    forgetPalette();
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* a nicety */
    }
  };
  setTheme(readTheme() === "light" ? "light" : "dark");

  const store = new SignalStore(app);
  store.twinInfo = (n) => {
    const c = channelInfo(n);
    return { label: c.label, unit: c.unit };
  };

  // ---------- the 3D panel's parts ----------
  const meshes = new Map<string, MeshEntry>();
  for (const m of b.model?.meshes ?? []) meshes.set(m.hash, unpackMesh(m));
  const parts = (b.model?.parts ?? []) as unknown as EvalPart[];

  let link: Link | null = null;
  let kind: LinkKind = b.twin ? "twin" : "usb";
  let mounted: ReturnType<typeof mountApp> | null = null;

  const host: AppHost = {
    send: (t) => {
      if (link && (link.status.state === "live" || link.status.state === "paused")) link.send(t);
    },
    canSend: () => !!link && (link.status.state === "live" || link.status.state === "paused"),
    model: b.model ? (into, panel, s) => modelView3d(into, panel, s, { parts, meshes, scene: () => link?.info?.scene }) : undefined,
    sandboxDoc: sandboxHtml,
    camera: true,
    confirm: async (q) => window.confirm(q),
  };

  // ---------- the bar ----------
  const bar = el("header", "sa-bar");
  const title = el("div", "sa-title");
  title.append(el("b", "", app.name));
  if (app.about) title.append(el("span", "", app.about));
  const links = el("div", "sa-seg");
  const linkBtn = (k: LinkKind, label: string, tip: string, disabled: boolean) => {
    const btn = el("button", "", label) as HTMLButtonElement;
    btn.title = tip;
    btn.disabled = disabled;
    btn.onclick = () => {
      kind = k;
      if (link) void go();
      paint();
    };
    links.append(btn);
    return btn;
  };
  const twinBtn = linkBtn("twin", "Twin", b.twin ? `A simulation of the machine in “${app.twin}”: try the app without the hardware` : (b.twinWhy ?? "This app was saved without a simulated twin"), !b.twin);
  const usbBtn = linkBtn("usb", "USB", "The real machine over a USB cable (Chrome or Edge)", false);
  const goBtn = el("button", "sa-btn primary") as HTMLButtonElement;
  const status = el("span", "sa-status");
  const led = el("i");
  const statusText = el("span", "t");
  status.append(led, statusText);
  const pauseBtn = el("button", "sa-btn", "Pause") as HTMLButtonElement;
  const speedSel = el("select", "sa-select") as HTMLSelectElement;
  for (const s of SPEEDS) {
    const o = el("option", "", `${s}×`) as HTMLOptionElement;
    o.value = String(s);
    if (s === 1) o.selected = true;
    speedSel.append(o);
  }
  speedSel.title = "How fast simulated time runs";
  const grow = el("div", "sa-grow");
  const recBtn = el("button", "sa-btn rec", "Record") as HTMLButtonElement;
  recBtn.title = "Record every value to a CSV file";
  const csvBtn = el("button", "sa-btn", "CSV") as HTMLButtonElement;
  csvBtn.title = "Save the last minute as a CSV file";
  const themeBtn = el("button", "sa-btn", "◐") as HTMLButtonElement;
  themeBtn.title = "Light or dark";
  bar.append(title, links, goBtn, status, pauseBtn, speedSel, grow, recBtn, csvBtn, themeBtn);

  const main = el("main", "sa-main");
  root.append(bar, main);
  const foot = el("footer", "sa-foot", `${b.design.name} · made in Kerf ${b.design.kerf} · saved ${b.design.saved.slice(0, 10)}`);
  root.append(foot);

  const live = () => !!link && ["live", "paused", "connecting"].includes(link.status.state);
  let lastStatus: LinkStatus = { state: "idle", text: "" };

  function paint() {
    twinBtn.classList.toggle("on", kind === "twin");
    usbBtn.classList.toggle("on", kind === "usb");
    goBtn.textContent = live() ? "Stop" : kind === "usb" ? "Connect" : "Start twin";
    goBtn.classList.toggle("primary", !live());
    const s = lastStatus;
    led.className = s.state === "live" ? "live" : s.state === "paused" ? "paused" : s.state === "connecting" ? "busy" : s.state === "error" ? "error" : "";
    const rate = link?.kind === "twin" && s.state === "live" && s.rate !== undefined ? ` · ${s.behind ? "can only run at " : ""}${s.rate.toFixed(2)}×` : "";
    statusText.textContent = (s.text || (kind === "usb" ? "not connected" : "stopped")) + rate;
    status.title = s.text;
    const twinLive = link?.kind === "twin" && live();
    pauseBtn.hidden = !twinLive;
    speedSel.hidden = !twinLive;
    pauseBtn.textContent = link?.paused ? "Carry on" : "Pause";
    recBtn.classList.toggle("on", !!store.recording);
    recBtn.textContent = store.recording ? "Stop recording" : "Record";
  }

  function stop() {
    const l = link;
    link = null;
    if (l) {
      l.onStatus = undefined;
      l.stop();
    }
    lastStatus = { state: "idle", text: "" };
    mounted?.linkChanged();
    paint();
  }

  async function go() {
    stop();
    store.reset();
    let l: Link;
    if (kind === "twin" && b.twin) {
      const code = workerCode;
      l = new TwinLink(store, () => new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })), { name: "app-twin" }), b.twin, app.hello);
      l.setSpeed!(Number(speedSel.value) || 1);
    } else l = new SerialLink(store, app.baud, app.hello);
    link = l;
    l.onStatus = (s) => {
      if (link !== l) return;
      lastStatus = s;
      mounted?.linkChanged();
      paint();
    };
    paint();
    await l.start();
  }

  goBtn.onclick = () => (live() ? stop() : void go());
  pauseBtn.onclick = () => {
    link?.setPaused?.(!link.paused);
    paint();
  };
  speedSel.onchange = () => link?.setSpeed?.(Number(speedSel.value) || 1);
  const stem = fileStemOf(app.name);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const save = (text: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = `${stem}-${stamp()}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  recBtn.onclick = () => {
    if (store.recording) {
      const rec = store.stopRecording();
      if (rec && rec.rows.length) save(store.csv(rec));
    } else store.startRecording();
    paint();
  };
  csvBtn.onclick = () => save(store.csv(null));
  themeBtn.onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

  mounted = mountApp(main, app, store, host);
  paint();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
