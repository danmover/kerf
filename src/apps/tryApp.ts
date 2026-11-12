// Trying an app without a screen: run its simulated twin for a few seconds as
// fast as it goes, type the app's hello lines and any commands at their
// times, and report what the firmware printed, what the app read from it and
// what each panel would show. The assistant uses it to build apps that work
// (see ai/appTools), and tests use it to check apps against real firmware.

import { LiveTwin, type TwinOptions } from "./twin";
import { SignalStore } from "./store";
import { lineReader } from "./lines";
import { panelExprs, type AppSpec } from "./spec";
import type { ExprValue } from "./expr";
import { channelInfo } from "../sim/channels";

export interface TryReport {
  /** simulated seconds run */
  ran: number;
  firmware: string;
  board: string;
  stopped?: string;
  error?: string;
  /** the run used up its wall-clock budget before the time asked for */
  cut: boolean;
  /** every line, sent ("> ") and printed */
  lines: { t: number; text: string }[];
  /** what the app's telemetry formats read from the printed lines, last value of each */
  parsed: Record<string, ExprValue>;
  /** the twin's own channels (motors, supplies, sensors, world, fw.*), last value of each */
  channels: Record<string, number>;
  panels: { title: string; kind: string; values: { expr: string; value: ExprValue; shows: boolean }[] }[];
}

/** An app with no panels, to try a firmware before an app is written for it. */
export function bareApp(twin: string | null): AppSpec {
  return { name: "Try", twin, twinGiven: true, baud: 115200, telemetry: [], derive: [], hello: [], commands: [], columns: 6, window: 20, panels: [], span: { start: 0, end: 0 }, labelSpan: { start: 0, end: 0 } };
}

export function tryApp(app: AppSpec, o: TwinOptions, opts: { seconds: number; send?: { at: number; text: string }[]; budgetMs?: number }): TryReport {
  const twin = new LiveTwin(o);
  const store = new SignalStore(app);
  store.twinInfo = (n) => {
    const c = channelInfo(n);
    return { label: c.label, unit: c.unit };
  };
  const read = lineReader(app.telemetry);
  const parsed: Record<string, ExprValue> = {};
  const lines: TryReport["lines"] = [];
  const sends = [...app.hello.map((text) => ({ at: 0, text })), ...(opts.send ?? [])].sort((a, b) => a.at - b.at);
  const budget = opts.budgetMs ?? 8000;
  const wall0 = performance.now();
  let cut = false;
  let ch: Record<string, number> = {};
  const take = () => {
    for (const l of twin.takeLines()) {
      lines.push(l);
      store.lineOut(l.t, l.text);
      const v = read(l.text);
      if (v) for (const [k, x] of Object.entries(v)) if (k !== "line") parsed[k] = x;
    }
    for (const e of twin.takeEvents()) store.event(e.t, e.kind === "warn" ? "fault" : "note", e.text);
    ch = twin.channels();
    store.values(twin.time, ch);
  };
  const STEP = 0.05;
  while (twin.time < opts.seconds - 1e-9 && !twin.stopped) {
    while (sends.length && sends[0].at <= twin.time + 1e-9) {
      const s = sends.shift()!;
      twin.type(s.text);
      lines.push({ t: twin.time, text: `> ${s.text}` });
      store.lineIn(twin.time, s.text);
    }
    const next = Math.min(opts.seconds, twin.time + STEP, sends.length ? Math.max(twin.time + 1e-3, sends[0].at) : Infinity);
    twin.runTo(next, 200);
    take();
    if (performance.now() - wall0 > budget) {
      cut = true;
      break;
    }
  }
  take();
  const panels = app.panels.map((p) => ({
    title: p.title,
    kind: p.kind,
    values: [...new Set(panelExprs(p))].map((expr) => {
      const value = store.eval(expr);
      const shows = typeof value === "number" ? Number.isFinite(value) : typeof value === "string" ? value !== "" : value !== null && value !== undefined;
      return { expr, value, shows };
    }),
  }));
  return { ran: twin.time, firmware: twin.info.firmware, board: twin.info.boardName, stopped: twin.stopped ?? undefined, error: twin.error ?? undefined, cut, lines, parsed, channels: ch, panels };
}
