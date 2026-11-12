// The app open in Kerf: which one is on screen, whether it is being built,
// and its live session (the signal store and the link feeding it: the
// simulated twin, the real machine over USB, or a replayed run). One app runs
// at a time; its session survives edits to the design, so changing a panel
// does not restart the twin.

import { create } from "zustand";
import { meshes, useDesign } from "../core/engine";
import type { Model } from "../core/model";
import { download } from "../persist/files";
import { channelInfo } from "../sim/channels";
import { resolveMechanism } from "../sim/mech/resolve";
import { pick, useSim } from "../sim/runtime";
import type { ScenarioSpec } from "../sim/scenario";
import { closeDrawings } from "../drawing/engine";
import { ReplayLink, SerialLink, TwinLink, type Link, type LinkKind, type LinkStatus } from "./links";
import type { AppSpec } from "./spec";
import { fileStemOf } from "./names";
import { SignalStore } from "./store";
import { twinFirmware } from "./twinFirmware";
import type { TwinOptions } from "./twin";

interface AppsState {
  /** the app shown in the centre of the workspace */
  open: string | null;
  /** building it: panels can be picked, moved and resized */
  edit: boolean;
  selected: number | null;
  link: LinkKind | null;
  status: LinkStatus;
  speed: number;
  paused: boolean;
  recording: boolean;
  /** the scenario a replay plays */
  replay: string | null;
}

export const useApps = create<AppsState>(() => ({
  open: null,
  edit: false,
  selected: null,
  link: null,
  status: { state: "idle", text: "" },
  speed: 1,
  paused: false,
  recording: false,
  replay: null,
}));

const set = useApps.setState;
const get = useApps.getState;

let session: { name: string; store: SignalStore; link: Link | null } | null = null;
const linkListeners = new Set<() => void>();
/** the link went live or stopped (the mounted app enables its controls) */
export const onLinkChange = (fn: () => void) => {
  linkListeners.add(fn);
  return () => linkListeners.delete(fn);
};

export const appsOf = (m: Model | null | undefined): AppSpec[] => m?.apps ?? [];
export const appNamed = (m: Model | null | undefined, name: string | null) => (name ? appsOf(m).find((a) => a.name === name) : undefined);

/** The store for an app: the running session's (taking the app as it now is), or a new one. */
export function storeFor(app: AppSpec): SignalStore {
  if (session && session.name === app.name) {
    if (session.store.app !== app) session.store.reconfigure(app);
    return session.store;
  }
  stopLink();
  const store = new SignalStore(app);
  store.twinInfo = (n) => {
    const c = channelInfo(n);
    return { label: c.label, unit: c.unit };
  };
  session = { name: app.name, store, link: null };
  return store;
}

export function currentLink(): Link | null {
  return session?.link ?? null;
}

export function openApp(name: string, opts: { edit?: boolean } = {}) {
  closeDrawings();
  if (session && session.name !== name) stopLink();
  set({ open: name, edit: opts.edit ?? get().edit, selected: null });
}

export function closeApp() {
  // the twin (or the port) stops with the app, so nothing runs unseen
  stopLink();
  set({ open: null, edit: false, selected: null });
}

export function setEditing(on: boolean) {
  set({ edit: on, selected: on ? get().selected : null });
}

export function selectPanel(i: number | null) {
  set({ selected: i });
}

function setStatus(s: LinkStatus) {
  set({ status: s });
  for (const l of linkListeners) l();
}

// ---------- links ----------

/** Why the twin cannot run for this app, or the options it runs with. */
export function twinOptions(app: AppSpec, model: Model): TwinOptions | { error: string } {
  if (!app.twin) return { error: model.scenarios?.length ? "This app has twin: none" : "The design has no simulation scenario for a twin to run in: add one (Simulate → Add a simulation)" };
  const def = model.scenarios?.find((s) => s.label === app.twin);
  if (!def) return { error: `There is no scenario “${app.twin}”` };
  if (def.spec.world.kind === "printer") return { error: "The twin cannot run a printer scenario yet: use a replay of its run" };
  if (def.spec.physicsOnly) return { error: `“${def.label}” runs the mechanism without firmware, so there is nothing for the app to talk to` };
  if (!model.machine) return { error: "The design has no electronics or firmware for a twin to run" };
  let spec: ScenarioSpec = def.spec;
  if (def.spec.mechanism) {
    const st = useDesign.getState();
    const r = resolveMechanism(def.spec, model, (h) => meshes.get(h), st.stage === "done" || st.stage === "refining");
    if ("waiting" in r) return { error: "The parts are still being built: the twin starts once they are" };
    if ("error" in r) return { error: r.error };
    spec = { ...def.spec, mech: r.mech };
  }
  const fw = twinFirmware({ machine: model.machine, designName: model.name, firmware: app.firmware ?? def.spec.firmware, spec });
  if ("error" in fw) return fw;
  return { spec, machine: model.machine, designName: model.name, firmware: fw.name, files: fw.files, board: { mcu: fw.mcu, partId: fw.partId } };
}

/** Scenarios with a finished run that a replay can play. */
export function replayable(model: Model | null | undefined): string[] {
  const runs = useSim.getState().runs;
  return (model?.scenarios ?? []).filter((s) => runs.get(s.label)?.result?.variants.length).map((s) => s.label);
}

export async function connect(kind: LinkKind, opts: { replay?: string } = {}) {
  const model = useDesign.getState().model;
  const app = appNamed(model, get().open);
  if (!model || !app) return;
  const store = storeFor(app);
  stopLink();
  store.reset();
  let link: Link;
  if (kind === "twin") {
    const o = twinOptions(app, model);
    if ("error" in o) {
      setStatus({ state: "error", text: o.error });
      set({ link: null });
      return;
    }
    link = new TwinLink(store, () => new Worker(new URL("./twin.worker.ts", import.meta.url), { type: "module", name: "kerf-app-twin" }), o, app.hello);
    link.setSpeed!(get().speed);
  } else if (kind === "usb") {
    link = new SerialLink(store, app.baud, app.hello);
  } else {
    const label = opts.replay ?? get().replay ?? replayable(model)[0];
    const res = label ? useSim.getState().runs.get(label)?.result : undefined;
    const v = res ? pick(res.variants, "expected") : undefined;
    if (!label || !v) {
      setStatus({ state: "error", text: "No finished simulation run to play back yet: run a scenario first" });
      return;
    }
    link = new ReplayLink(store, { t: v.frames.t, series: v.frames.series, serial: v.serial, label });
    link.setSpeed!(get().speed);
    set({ replay: label });
  }
  session!.link = link;
  link.onStatus = (s) => {
    if (session?.link !== link) return;
    setStatus(s);
  };
  set({ link: kind, paused: false });
  await link.start();
}

export function stopLink() {
  const l = session?.link;
  if (!l) return;
  session!.link = null;
  l.onStatus = undefined;
  l.stop();
  set({ link: null, paused: false });
  setStatus({ state: "idle", text: "" });
}

export function sendCommand(text: string) {
  const l = session?.link;
  if (!l || (l.status.state !== "live" && l.status.state !== "paused")) return;
  l.send(text);
}

export const canSend = () => {
  const l = session?.link;
  return !!l && l.kind !== "replay" && (l.status.state === "live" || l.status.state === "paused");
};

export function setSpeed(x: number) {
  set({ speed: x });
  session?.link?.setSpeed?.(x);
}

export function setPaused(p: boolean) {
  set({ paused: p });
  session?.link?.setPaused?.(p);
}

export function toggleRecording() {
  const s = session?.store;
  if (!s) return;
  if (s.recording) {
    const rec = s.stopRecording();
    set({ recording: false });
    if (rec && rec.rows.length) download(s.csv(rec), `${fileStem(s.app.name)}-${stamp()}.csv`, "text/csv");
  } else {
    s.startRecording();
    set({ recording: true });
  }
}

/** The last minute of what the app keeps, as a CSV file. */
export function saveCsv() {
  const s = session?.store;
  if (!s) return;
  download(s.csv(null), `${fileStem(s.app.name)}-${stamp()}.csv`, "text/csv");
}

export const fileStem = fileStemOf;
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

/** Forget the session (the project closed). */
export function resetApps() {
  stopLink();
  session = null;
  set({ open: null, edit: false, selected: null, replay: null });
}
