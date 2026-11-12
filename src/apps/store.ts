// An app's live signals: the latest value of each, the recent history of the
// ones a chart, scope or windowed expression needs, the console log, events,
// running statistics and an optional recording for a CSV file. Links (the
// simulated twin, USB serial, a replayed run) feed it; panels read it.
//
// Plain TypeScript with no browser or Kerf imports, so it runs in Kerf, in a
// saved app page and in the tests alike.

import { compiled, ExprError, type Compiled, type ExprEnv, type ExprValue } from "./expr";
import { lineReader, telemetryColumns, TEXT_SIGNALS, type LineValues } from "./lines";
import { panelExprs, type AppSpec } from "./spec";

export interface LogLine {
  t: number;
  dir: "out" | "in" | "note";
  text: string;
  /** a telemetry line that gave numbers (consoles can hide these) */
  data?: boolean;
}

export interface AppEvent {
  t: number;
  kind: "state" | "fault" | "sent" | "note";
  text: string;
}

export interface SignalInfo {
  label: string;
  unit: string;
  /** where it comes from */
  from: "telemetry" | "derived" | "twin" | "text" | "line";
}

/** A ring of (time, value) samples. */
class Ring {
  t: Float64Array;
  v: Float32Array;
  head = 0;
  n = 0;
  constructor(public cap: number) {
    this.t = new Float64Array(cap);
    this.v = new Float32Array(cap);
  }
  push(t: number, v: number) {
    // a sample at the same time replaces the last one (a line that gives a column twice)
    if (this.n && this.t[(this.head - 1 + this.cap) % this.cap] === t) {
      this.v[(this.head - 1 + this.cap) % this.cap] = v;
      return;
    }
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  /** index k of the n held, oldest first */
  at(k: number) {
    return (this.head - this.n + k + this.cap * 2) % this.cap;
  }
}

interface Stat {
  min: number;
  max: number;
  sum: number;
  n: number;
}

const LOG_MAX = 4000;
const EVENT_MAX = 400;

export class SignalStore implements ExprEnv {
  readonly app!: AppSpec;
  /** latest values */
  private now = new Map<string, ExprValue>();
  private rings = new Map<string, Ring>();
  private stats = new Map<string, Stat>();
  private ringCap: number;
  /** names whose history is kept */
  private keep = new Set<string>();
  private derive: { name: string; c: Compiled | ExprError }[];
  private read: (line: string) => LineValues | null;
  private infoOf = new Map<string, SignalInfo>();
  /** time of the latest sample, s */
  time = 0;
  /** rises on every change; panels redraw when it differs from what they drew */
  version = 0;
  log: LogLine[] = [];
  /** lines ever added to the log: log[i] is line number logTotal - log.length + i */
  logTotal = 0;
  events: AppEvent[] = [];
  /** lines received and parsed since the start */
  lines = 0;
  /** names of numeric signals seen, in order of arrival */
  seen: string[] = [];
  private seenSet = new Set<string>();
  recording: { t0: number; cols: string[]; rows: (number | string)[][] } | null = null;
  private listeners = new Set<() => void>();
  /** a label and unit for twin channels (Kerf's channel names); set by whoever runs the twin */
  twinInfo?: (name: string) => { label: string; unit: string } | undefined;

  constructor(app: AppSpec, opts: { rate?: number } = {}) {
    this.app = app;
    this.rate = opts.rate ?? 60;
    this.read = lineReader(app.telemetry);
    this.derive = [];
    this.ringCap = 2048;
    this.configure(app);
  }

  private rate: number;

  /** Take a changed app (its design was edited) and keep what has arrived. */
  reconfigure(app: AppSpec) {
    (this as { app: AppSpec }).app = app;
    this.configure(app);
    this.changed();
  }

  private configure(app: AppSpec) {
    this.read = lineReader(app.telemetry);
    this.derive = app.derive.map((d) => ({ name: d.name, c: compiled(d.expr) }));
    this.keep = new Set();
    // history: the longest chart window, scope trail or windowed expression, and a minute at least
    let need = Math.max(60, app.window);
    const keepExpr = (src: string) => {
      const c = compiled(src);
      if (c instanceof ExprError) return;
      for (const n of c.names) this.keep.add(n);
      for (const [n, s] of Object.entries(c.windows)) {
        this.keep.add(n);
        need = Math.max(need, s);
      }
    };
    for (const p of app.panels) {
      if (p.kind === "chart") {
        need = Math.max(need, p.window || app.window);
        for (const s of p.signals) this.keepWhole(s.expr);
      }
      if (p.kind === "scope") {
        need = Math.max(need, p.trail);
        this.keepWhole(p.x.expr);
        this.keepWhole(p.y.expr);
      }
      if (p.kind === "custom") for (const u of p.uses) this.keepWhole(u);
      for (const e of panelExprs(p)) keepExpr(e);
    }
    for (const d of app.derive) keepExpr(d.expr);
    const cap = Math.min(1 << 16, Math.max(2048, Math.ceil(need * this.rate)));
    if (cap !== this.ringCap) {
      this.ringCap = cap;
      this.rings.clear();
    }
    for (const c of telemetryColumns(app.telemetry)) this.infoOf.set(c.name, { label: c.name, unit: c.unit ?? "", from: "telemetry" });
    for (const d of app.derive) this.infoOf.set(d.name, { label: d.label ?? d.name, unit: d.unit ?? "", from: "derived" });
    for (const t of TEXT_SIGNALS) this.infoOf.set(t, { label: t, unit: "", from: "text" });
  }

  /** an expression shown over time keeps its own history, under its own text */
  private keepWhole(expr: string) {
    this.keep.add(expr);
    const c = compiled(expr);
    if (!(c instanceof ExprError)) for (const n of c.names) this.keep.add(n);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  reset() {
    this.now.clear();
    this.rings.clear();
    this.stats.clear();
    this.log = [];
    this.logTotal = 0;
    this.events = [];
    this.lines = 0;
    this.time = 0;
    this.seen = [];
    this.seenSet.clear();
    if (this.recording) this.recording = { t0: 0, cols: this.recording.cols, rows: [] };
    this.changed();
  }

  // ---------- feeding it ----------

  /** A line the firmware printed. */
  lineOut(t: number, text: string) {
    const vals = this.read(text);
    const data = !!vals && Object.values(vals).some((v) => typeof v === "number");
    this.pushLog({ t, dir: "out", text, data: data || undefined });
    if (vals) {
      if (typeof vals.state === "string" && vals.state !== this.now.get("state")) this.pushEvent({ t, kind: "state", text: vals.state });
      if (typeof vals.fault === "string") this.pushEvent({ t, kind: "fault", text: vals.fault });
      const n = Object.keys(vals).length;
      if (n > 1) this.lines++;
      this.apply(t, vals, "line");
    }
  }

  /** Something that happened, for the state panel and the console. */
  event(t: number, kind: AppEvent["kind"], text: string) {
    this.pushEvent({ t, kind, text });
    this.pushLog({ t, dir: "note", text });
    this.changed();
  }

  /** A command sent to the machine. */
  lineIn(t: number, text: string) {
    this.pushLog({ t, dir: "in", text });
    this.pushEvent({ t, kind: "sent", text });
    this.changed();
  }

  /** A note in the console from the app itself (connected, disconnected). */
  note(t: number, text: string) {
    this.pushLog({ t, dir: "note", text });
    this.changed();
  }

  /** Named numbers at one time: a simulated twin's channels, a replayed frame. */
  values(t: number, rec: Record<string, number>) {
    this.apply(t, rec, "twin");
  }

  private apply(t: number, rec: Record<string, ExprValue>, from: "line" | "twin") {
    if (t >= this.time) this.time = t;
    for (const [k, v] of Object.entries(rec)) {
      this.now.set(k, v);
      if (typeof v === "number") {
        this.noteSeen(k, from === "twin" ? "twin" : "telemetry");
        this.sample(k, t, v);
      }
    }
    for (const d of this.derive) {
      if (d.c instanceof ExprError) continue;
      const v = d.c.run(this);
      this.now.set(d.name, v);
      if (typeof v === "number" && Number.isFinite(v)) {
        this.noteSeen(d.name, "derived");
        this.sample(d.name, t, v);
      }
    }
    // expressions a chart shows over time
    for (const k of this.keep) {
      if (this.now.has(k) || !/[^\w.µ]/.test(k)) continue;
      const c = compiled(k);
      if (c instanceof ExprError) continue;
      const v = c.run(this);
      if (typeof v === "number" && Number.isFinite(v)) this.sample(k, t, v);
    }
    if (this.recording) this.recordRow(t);
    this.changed();
  }

  private noteSeen(k: string, from: SignalInfo["from"]) {
    if (this.seenSet.has(k)) return;
    this.seenSet.add(k);
    this.seen.push(k);
    if (!this.infoOf.has(k)) {
      const ti = from === "twin" ? this.twinInfo?.(k) : undefined;
      this.infoOf.set(k, { label: ti?.label ?? k, unit: ti?.unit ?? "", from });
    }
  }

  private sample(k: string, t: number, v: number) {
    let st = this.stats.get(k);
    if (!st) this.stats.set(k, (st = { min: v, max: v, sum: 0, n: 0 }));
    if (v < st.min) st.min = v;
    if (v > st.max) st.max = v;
    st.sum += v;
    st.n++;
    if (!this.keep.has(k)) return;
    let r = this.rings.get(k);
    if (!r) this.rings.set(k, (r = new Ring(this.ringCap)));
    r.push(t, v);
  }

  private pushLog(l: LogLine) {
    this.logTotal++;
    this.log.push(l);
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }
  private pushEvent(e: AppEvent) {
    this.events.push(e);
    if (this.events.length > EVENT_MAX) this.events.splice(0, this.events.length - EVENT_MAX);
  }

  // ---------- reading it ----------

  get(name: string): ExprValue | undefined {
    return this.now.get(name);
  }

  has(name: string) {
    return this.now.has(name);
  }

  /** The value of an expression now (NaN while what it reads has not arrived). */
  eval(src: string): ExprValue {
    const c = compiled(src);
    return c instanceof ExprError ? NaN : c.run(this);
  }

  private scratchT = new Float64Array(0);
  private scratchV = new Float32Array(0);

  window(name: string, seconds: number) {
    const r = this.rings.get(name);
    if (!r || !r.n) return { t: this.scratchT.subarray(0, 0), v: this.scratchV.subarray(0, 0), n: 0 };
    const from = this.time - seconds;
    // the first sample inside the window
    let lo = 0;
    let hi = r.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.t[r.at(mid)] < from) lo = mid + 1;
      else hi = mid;
    }
    const n = r.n - lo;
    if (this.scratchT.length < n) {
      this.scratchT = new Float64Array(Math.max(n, 1024));
      this.scratchV = new Float32Array(Math.max(n, 1024));
    }
    for (let k = 0; k < n; k++) {
      const i = r.at(lo + k);
      this.scratchT[k] = r.t[i];
      this.scratchV[k] = r.v[i];
    }
    return { t: this.scratchT.subarray(0, n), v: this.scratchV.subarray(0, n), n };
  }

  /** History for a chart: its own copy, so two charts can read at once. */
  history(name: string, seconds: number): { t: Float64Array; v: Float32Array } {
    const w = this.window(name, seconds);
    return { t: Float64Array.from(w.t), v: Float32Array.from(w.v) };
  }

  stat(name: string): { min: number; max: number; mean: number; n: number } | undefined {
    const s = this.stats.get(name);
    return s ? { min: s.min, max: s.max, mean: s.n ? s.sum / s.n : NaN, n: s.n } : undefined;
  }

  info(name: string): SignalInfo {
    return this.infoOf.get(name) ?? { label: name, unit: "", from: "line" };
  }

  /** Every signal the app knows by now: telemetry columns, derived values, the twin's channels. */
  names(): string[] {
    const out = new Set<string>([...telemetryColumns(this.app.telemetry).map((c) => c.name), ...this.app.derive.map((d) => d.name), ...this.seen]);
    return [...out];
  }

  // ---------- recording ----------

  startRecording() {
    this.recording = { t0: this.time, cols: [], rows: [] };
    this.changed();
  }

  stopRecording() {
    const r = this.recording;
    this.recording = null;
    this.changed();
    return r;
  }

  private recordRow(t: number) {
    const r = this.recording!;
    if (r.rows.length > 2_000_000) return;
    // columns grow as signals arrive: telemetry, derived and anything a panel reads
    for (const k of this.recordable()) if (!r.cols.includes(k)) r.cols.push(k);
    r.rows.push([Number((t - r.t0).toFixed(4)), ...r.cols.map((c) => this.now.get(c) ?? "")]);
  }

  private recordable(): string[] {
    const tele = telemetryColumns(this.app.telemetry).map((c) => c.name);
    const der = this.app.derive.map((d) => d.name);
    const read = [...this.keep].filter((k) => !/[^\w.µ]/.test(k));
    return [...new Set([...tele, ...der, ...read, "state"])].filter((k) => this.now.has(k));
  }

  /** The recording (or, without one, the last minute of what is kept) as CSV text. */
  csv(rec = this.recording): string {
    const esc = (v: number | string) => (typeof v === "number" ? (Number.isFinite(v) ? String(Number(v.toPrecision(7))) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    if (rec && rec.rows.length) {
      const head = ["t", ...rec.cols.map((c) => (this.info(c).unit ? `${c} (${this.info(c).unit})` : c))];
      return [head.join(","), ...rec.rows.map((r) => r.map(esc).join(","))].join("\n") + "\n";
    }
    // no recording: the kept history, on the times of the busiest signal
    const cols = [...this.rings.keys()].filter((k) => !/[^\w.µ]/.test(k));
    if (!cols.length) return "t\n";
    const base = cols.reduce((a, b) => ((this.rings.get(a)!.n >= this.rings.get(b)!.n ? a : b)));
    const bt = this.history(base, 60).t;
    const hs = cols.map((c) => this.history(c, 60));
    const rows: string[] = [];
    const idx = cols.map(() => 0);
    for (const t of bt) {
      const row: (number | string)[] = [Number((t - bt[0]).toFixed(4))];
      cols.forEach((_, j) => {
        const h = hs[j];
        while (idx[j] + 1 < h.t.length && h.t[idx[j] + 1] <= t) idx[j]++;
        row.push(h.t.length && h.t[idx[j]] <= t ? h.v[idx[j]] : "");
      });
      rows.push(row.map(esc).join(","));
    }
    return [["t", ...cols.map((c) => (this.info(c).unit ? `${c} (${this.info(c).unit})` : c))].join(","), ...rows].join("\n") + "\n";
  }
}
