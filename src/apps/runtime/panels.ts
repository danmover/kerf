// The panels of an app, drawn with the DOM and canvases and no framework, so
// the same code runs inside Kerf and in a saved app. Each panel reads the
// signal store once a frame and redraws only when something it shows moved.

import { compiled, ExprError, isTrue } from "../expr";
import type { SignalStore } from "../store";
import { fillSend, type ControlSpec, type PanelSpec, type SignalItem } from "../spec";
import { colorOf, EasedRange, el, fit, fmt, palette, tickLabel, ticks, type Palette } from "./draw";

export interface ModelView {
  update(): void;
  resize(): void;
  destroy(): void;
  /** the view was built for another scene than the link now has (the twin started or stopped) */
  stale?(): boolean;
}

export interface AppHost {
  send(text: string): void;
  /** commands can be sent now (a link is live) */
  canSend(): boolean;
  /** a 3D view of the design for a model panel; without one the panel says where to see it */
  model?: (into: HTMLElement, panel: Extract<PanelSpec, { kind: "model" }>, store: SignalStore) => ModelView;
  /** the page custom panels run in (a sandbox on Kerf's origin); a saved app builds its own */
  sandboxUrl?: string;
  /** builds the sandbox page's HTML, for a saved app with no page to load */
  sandboxDoc?: () => string;
  /** the camera may be used here */
  camera?: boolean;
  /** asks before sending a command that needs a check */
  confirm?: (question: string) => Promise<boolean>;
}

export interface PanelCtx {
  store: SignalStore;
  host: AppHost;
  /** the app's default chart window, s */
  window: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The label and unit a signal shows with. */
export function describe(s: SignalItem, store: SignalStore): { label: string; unit: string } {
  const plain = /^[\w.µ]+$/.test(s.expr);
  const info = plain ? store.info(s.expr) : undefined;
  return { label: s.label ?? info?.label ?? s.expr, unit: s.unit ?? info?.unit ?? "" };
}

export abstract class PanelView {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  protected head: HTMLElement;
  protected drawn = -1;
  constructor(
    public spec: PanelSpec,
    protected ctx: PanelCtx,
  ) {
    this.el = el("section", `ka-panel ka-${spec.kind}`);
    this.head = el("header", "ka-head");
    const h = el("h3", "ka-title", spec.title);
    this.head.append(h);
    this.body = el("div", "ka-body");
    this.el.append(this.head, this.body);
  }
  /** called every frame */
  update(force = false) {
    const v = this.ctx.store.version;
    if (!force && v === this.drawn) return;
    this.drawn = v;
    this.draw();
  }
  protected abstract draw(): void;
  resize() {
    this.drawn = -1;
  }
  destroy() {}
  /** a live link changed: controls enable or disable */
  linkChanged() {}
  /** a key was pressed while the app had focus; true when a control took it */
  key(_k: string): boolean {
    return false;
  }
}

// ---------- numbers ----------

class ReadoutView extends PanelView {
  private cells: { s: SignalItem; v: HTMLElement; u: HTMLElement; bar?: HTMLElement; box: HTMLElement; l: HTMLElement }[] = [];
  constructor(spec: Extract<PanelSpec, { kind: "readout" }>, ctx: PanelCtx) {
    super(spec, ctx);
    const grid = el("div", `ka-nums${spec.big ? " big" : ""}`);
    for (const s of spec.signals) {
      const box = el("div", "ka-num");
      const l = el("div", "ka-num-l");
      const row = el("div", "ka-num-v");
      const v = el("span", "", "–");
      const u = el("small", "");
      row.append(v, u);
      box.append(l, row);
      let bar: HTMLElement | undefined;
      if (s.max !== undefined) {
        const track = el("div", "ka-num-bar");
        bar = el("i");
        track.append(bar);
        box.append(track);
      }
      grid.append(box);
      this.cells.push({ s, v, u, bar, box, l });
    }
    this.body.append(grid);
  }
  protected draw() {
    const st = this.ctx.store;
    for (const c of this.cells) {
      const d = describe(c.s, st);
      c.l.textContent = d.label;
      c.u.textContent = d.unit;
      const v = st.eval(c.s.expr);
      c.v.textContent = fmt(v, c.s.digits);
      const alarm = c.s.alarm ? isTrue(st.eval(c.s.alarm)) : false;
      const warn = !alarm && c.s.warn ? isTrue(st.eval(c.s.warn)) : false;
      c.box.classList.toggle("warn", warn);
      c.box.classList.toggle("alarm", alarm);
      if (c.bar && finite(v)) {
        const lo = c.s.min ?? 0;
        const f = Math.max(0, Math.min(1, (v - lo) / ((c.s.max ?? 1) - lo || 1)));
        c.bar.style.width = `${(f * 100).toFixed(1)}%`;
      }
    }
  }
}

class TableView extends PanelView {
  private rows: { s: SignalItem; tds: HTMLElement[] }[] = [];
  constructor(spec: Extract<PanelSpec, { kind: "table" }>, ctx: PanelCtx) {
    super(spec, ctx);
    const wrap = el("div", "ka-scroll");
    const t = el("table", "ka-table");
    const head = el("tr");
    for (const h of ["", "now", "lowest", "highest", "average", ""]) head.append(el("th", "", h));
    const thead = el("thead");
    thead.append(head);
    const tb = el("tbody");
    for (const s of spec.signals) {
      const tr = el("tr");
      const tds = [0, 1, 2, 3, 4, 5].map((i) => el("td", i === 0 ? "l" : i === 5 ? "u" : "n"));
      tr.append(...tds);
      tb.append(tr);
      this.rows.push({ s, tds });
    }
    t.append(thead, tb);
    wrap.append(t);
    this.body.append(wrap);
  }
  protected draw() {
    const st = this.ctx.store;
    for (const r of this.rows) {
      const d = describe(r.s, st);
      const plain = /^[\w.µ]+$/.test(r.s.expr);
      const stat = plain ? st.stat(r.s.expr) : undefined;
      const vals = [d.label, fmt(st.eval(r.s.expr), r.s.digits), fmt(stat?.min, r.s.digits), fmt(stat?.max, r.s.digits), fmt(stat?.mean, r.s.digits), d.unit];
      vals.forEach((v, i) => {
        if (r.tds[i].textContent !== v) r.tds[i].textContent = v;
      });
    }
  }
}

// ---------- a dial ----------

class GaugeView extends PanelView {
  private cv = el("canvas");
  private val = el("div", "ka-gauge-v");
  constructor(
    public g: Extract<PanelSpec, { kind: "gauge" }>,
    ctx: PanelCtx,
  ) {
    super(g, ctx);
    const wrap = el("div", "ka-cv");
    wrap.append(this.cv);
    this.body.append(wrap, this.val);
  }
  protected draw() {
    const f = fit(this.cv);
    if (!f) return;
    const { ctx, w, h } = f;
    const p = palette();
    const st = this.ctx.store;
    const v = st.eval(this.g.signal.expr);
    const d = describe(this.g.signal, st);
    this.val.innerHTML = "";
    this.val.append(el("b", "", fmt(v, this.g.signal.digits)), el("small", "", ` ${d.unit}`));
    ctx.clearRect(0, 0, w, h);
    const r = Math.max(10, Math.min(w / 2 - 6, h * 0.62));
    const cx = w / 2;
    const cy = Math.min(h - 8, r + 10 + r * 0.05) ;
    const a0 = Math.PI * 0.8;
    const a1 = Math.PI * 2.2;
    const { min, max } = this.g;
    const ang = (x: number) => a0 + (a1 - a0) * Math.max(0, Math.min(1, (x - min) / (max - min)));
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(5, r * 0.13);
    ctx.strokeStyle = p.line2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    for (const z of this.g.zones) {
      ctx.strokeStyle = colorOf(z.color, p, 0);
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(cx, cy, r, ang(z.from), ang(z.to));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (finite(v)) {
      const inZone = this.g.zones.find((z) => v >= z.from && v <= z.to);
      ctx.strokeStyle = inZone ? colorOf(inZone.color, p, 0) : colorOf(this.g.signal.color, p, 0);
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, ang(v));
      ctx.stroke();
      const a = ang(v);
      ctx.lineWidth = 2;
      ctx.strokeStyle = p.text;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.35, cy + Math.sin(a) * r * 0.35);
      ctx.lineTo(cx + Math.cos(a) * (r + ctx.lineWidth * 3), cy + Math.sin(a) * (r + ctx.lineWidth * 3));
      ctx.stroke();
    }
    ctx.fillStyle = p.text3;
    ctx.font = "10px var(--mono, monospace)";
    ctx.textAlign = "center";
    ctx.fillText(fmt(min), cx + Math.cos(a0) * r, cy + Math.sin(a0) * r + 16);
    ctx.fillText(fmt(max), cx + Math.cos(a1) * r, cy + Math.sin(a1) * r + 16);
  }
}

// ---------- over time ----------

class ChartView extends PanelView {
  private cv = el("canvas");
  private legend = el("div", "ka-legend");
  private range = new EasedRange();
  private keys: { s: SignalItem; key: HTMLElement; val: HTMLElement }[] = [];
  constructor(
    public c: Extract<PanelSpec, { kind: "chart" }>,
    ctx: PanelCtx,
  ) {
    super(c, ctx);
    const wrap = el("div", "ka-cv");
    wrap.append(this.cv);
    for (const s of c.signals) {
      const k = el("span", "ka-key");
      const sw = el("i");
      const lab = el("span");
      const val = el("b");
      k.append(sw, lab, val);
      this.legend.append(k);
      this.keys.push({ s, key: k, val });
    }
    this.head.append(this.legend);
    this.body.append(wrap);
  }
  protected draw() {
    const f = fit(this.cv);
    if (!f) return;
    const { ctx, w, h } = f;
    const p = palette();
    const st = this.ctx.store;
    const win = this.c.window || this.ctx.window;
    const now = st.time;
    const series = this.c.signals.map((s) => st.history(s.expr, win));
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series)
      for (let i = 0; i < s.v.length; i++) {
        const v = s.v[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    const [y0, y1] = this.range.take(lo, hi, this.c.min, this.c.max);
    const padL = 40;
    const padB = 16;
    const pw = w - padL - 6;
    const ph = h - padB - 6;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "10px var(--mono, monospace)";
    const tk = ticks(y0, y1, Math.max(2, Math.round(ph / 34)));
    const step = tk.length > 1 ? tk[1] - tk[0] : 1;
    ctx.strokeStyle = p.line;
    ctx.fillStyle = p.text3;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of tk) {
      const y = 6 + ph - ((t - y0) / (y1 - y0)) * ph;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(w - 6, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(tickLabel(t, step), padL - 5, y);
    }
    // seconds ago along the bottom
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const tt = ticks(0, win, Math.max(2, Math.round(pw / 90)));
    for (const s of tt) {
      const x = padL + pw - (s / win) * pw;
      ctx.fillText(s === 0 ? "now" : `-${tickLabel(s, tt[1] - tt[0] || 1)}s`, x, h - 3);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, 4, pw + 2, ph + 4);
    ctx.clip();
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    series.forEach((s, i) => {
      ctx.strokeStyle = colorOf(this.c.signals[i].color, p, i);
      ctx.beginPath();
      let pen = false;
      let lastT = -Infinity;
      for (let k = 0; k < s.t.length; k++) {
        const x = padL + pw - ((now - s.t[k]) / win) * pw;
        const y = 6 + ph - ((s.v[k] - y0) / (y1 - y0)) * ph;
        // a gap in the data (the link dropped) breaks the line
        if (pen && s.t[k] - lastT > Math.max(1.5, win / 20)) pen = false;
        if (!pen) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        pen = true;
        lastT = s.t[k];
      }
      ctx.stroke();
    });
    ctx.restore();
    this.keys.forEach((k, i) => {
      const d = describe(k.s, st);
      (k.key.firstChild as HTMLElement).style.background = colorOf(k.s.color, p, i);
      (k.key.children[1] as HTMLElement).textContent = d.label;
      const unit = d.unit || this.c.unit || "";
      k.val.textContent = `${fmt(st.eval(k.s.expr), k.s.digits)}${unit ? ` ${unit}` : ""}`;
    });
  }
}

class ScopeView extends PanelView {
  private cv = el("canvas");
  private readout = el("div", "ka-scope-v");
  private range = new EasedRange();
  constructor(
    public s: Extract<PanelSpec, { kind: "scope" }>,
    ctx: PanelCtx,
  ) {
    super(s, ctx);
    const wrap = el("div", "ka-cv");
    wrap.append(this.cv);
    this.body.append(wrap, this.readout);
  }
  protected draw() {
    const f = fit(this.cv);
    if (!f) return;
    const { ctx, w, h } = f;
    const p = palette();
    const st = this.ctx.store;
    const trail = Math.max(0.1, this.s.trail);
    const hx = st.history(this.s.x.expr, trail);
    const hy = st.history(this.s.y.expr, trail);
    const n = Math.min(hx.v.length, hy.v.length);
    // pair the samples from the newest end (they arrive on the same lines)
    const ox = hx.v.length - n;
    const oy = hy.v.length - n;
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(hx.v[ox + i]), Math.abs(hy.v[oy + i]));
    const [, R] = this.s.range ? [0, this.s.range] : this.range.take(0, Math.max(m, 1e-6));
    const size = Math.min(w, h) - 12;
    const cx = w / 2;
    const cy = h / 2;
    const sc = size / 2 / R;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = p.line;
    ctx.lineWidth = 1;
    for (const f2 of [0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, (size / 2) * f2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - size / 2, cy);
    ctx.lineTo(cx + size / 2, cy);
    ctx.moveTo(cx, cy - size / 2);
    ctx.lineTo(cx, cy + size / 2);
    ctx.stroke();
    ctx.fillStyle = p.text3;
    ctx.font = "10px var(--mono, monospace)";
    ctx.textAlign = "left";
    ctx.fillText(`${fmt(R)}${this.s.unit ? ` ${this.s.unit}` : ""}`, cx + size / 2 - 40, cy - 4);
    const dx = describe(this.s.x, st);
    const dy = describe(this.s.y, st);
    ctx.fillText(dx.label, cx + size / 2 - 40, cy + 12);
    ctx.fillText(dy.label, cx + 4, cy - size / 2 + 10);
    const col = colorOf(this.s.x.color, p, 0);
    ctx.lineWidth = 1.6;
    for (let i = 1; i < n; i++) {
      ctx.globalAlpha = 0.08 + (0.85 * i) / n;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(cx + hx.v[ox + i - 1] * sc, cy - hy.v[oy + i - 1] * sc);
      ctx.lineTo(cx + hx.v[ox + i] * sc, cy - hy.v[oy + i] * sc);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const x = st.eval(this.s.x.expr);
    const y = st.eval(this.s.y.expr);
    if (finite(x) && finite(y)) {
      const px = cx + Math.max(-1.1, Math.min(1.1, x / R)) * (size / 2);
      const py = cy - Math.max(-1.1, Math.min(1.1, y / R)) * (size / 2);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.text;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const u = this.s.unit ? ` ${this.s.unit}` : "";
    this.readout.textContent = `${dx.label} ${fmt(x, this.s.x.digits)}${u} · ${dy.label} ${fmt(y, this.s.y.digits)}${u}`;
  }
}

// ---------- bars ----------

class BarsView extends PanelView {
  private rows: { s: SignalItem; l: HTMLElement; fill: HTMLElement; v: HTMLElement }[] = [];
  private range = new EasedRange();
  constructor(
    public b: Extract<PanelSpec, { kind: "bars" }>,
    ctx: PanelCtx,
  ) {
    super(b, ctx);
    const list = el("div", "ka-bars");
    for (const s of b.signals) {
      const row = el("div", "ka-bar");
      const l = el("span", "ka-bar-l");
      const track = el("div", "ka-bar-t");
      const fill = el("i");
      track.append(fill);
      const v = el("span", "ka-bar-v");
      row.append(l, track, v);
      list.append(row);
      this.rows.push({ s, l, fill, v });
    }
    this.body.append(list);
  }
  protected draw() {
    const st = this.ctx.store;
    const p = palette();
    const vals = this.rows.map((r) => st.eval(r.s.expr));
    const nums = vals.filter(finite);
    const auto = this.range.take(Math.min(0, ...nums), Math.max(0, ...nums));
    const lo = this.b.min ?? (auto[0] < 0 ? -Math.max(-auto[0], auto[1]) : 0);
    const hi = this.b.max ?? (auto[0] < 0 ? Math.max(-auto[0], auto[1]) : auto[1]);
    const zero = Math.max(0, Math.min(1, (0 - lo) / (hi - lo || 1)));
    this.rows.forEach((r, i) => {
      const d = describe(r.s, st);
      r.l.textContent = d.label;
      const v = vals[i];
      const unit = d.unit || this.b.unit || "";
      r.v.textContent = `${fmt(v, r.s.digits)}${unit ? ` ${unit}` : ""}`;
      if (!finite(v)) {
        r.fill.style.width = "0";
        return;
      }
      const f = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
      const a = Math.min(f, zero);
      const b = Math.max(f, zero);
      r.fill.style.left = `${(a * 100).toFixed(2)}%`;
      r.fill.style.width = `${((b - a) * 100).toFixed(2)}%`;
      r.fill.style.background = colorOf(r.s.color, p, i);
      const alarm = r.s.alarm ? isTrue(st.eval(r.s.alarm)) : false;
      const warn = !alarm && r.s.warn ? isTrue(st.eval(r.s.warn)) : false;
      r.v.classList.toggle("warn", warn);
      r.v.classList.toggle("alarm", alarm);
    });
  }
}

// ---------- state ----------

class LampsView extends PanelView {
  private items: { dot: HTMLElement; text: HTMLElement; box: HTMLElement }[] = [];
  constructor(
    public l: Extract<PanelSpec, { kind: "lamps" }>,
    ctx: PanelCtx,
  ) {
    super(l, ctx);
    const row = el("div", "ka-lamps");
    for (const _ of l.lamps) {
      const box = el("div", "ka-lamp");
      const dot = el("i");
      const text = el("span");
      box.append(dot, text);
      row.append(box);
      this.items.push({ dot, text, box });
    }
    this.body.append(row);
  }
  protected draw() {
    const st = this.ctx.store;
    const p = palette();
    this.l.lamps.forEach((lamp, i) => {
      const on = isTrue(st.eval(lamp.when));
      const it = this.items[i];
      it.box.classList.toggle("on", on);
      it.text.textContent = on ? lamp.label : (lamp.off ?? lamp.label);
      it.dot.style.background = on ? colorOf(lamp.color ?? "green", p, 0) : "";
      it.dot.style.boxShadow = on ? `0 0 10px ${colorOf(lamp.color ?? "green", p, 0)}` : "";
    });
  }
}

class StateView extends PanelView {
  private state = el("div", "ka-state-v", "–");
  private fault = el("div", "ka-state-f");
  private list = el("ol", "ka-events");
  private shown = -1;
  constructor(spec: PanelSpec, ctx: PanelCtx) {
    super(spec, ctx);
    this.body.append(this.state, this.fault, this.list);
  }
  protected draw() {
    const st = this.ctx.store;
    const s = st.get("state");
    this.state.textContent = typeof s === "string" && s ? s : "no state reported yet";
    this.state.classList.toggle("none", !(typeof s === "string" && s));
    const ev = st.events;
    const lastFault = [...ev].reverse().find((e) => e.kind === "fault");
    this.fault.textContent = lastFault ? lastFault.text : "";
    this.fault.hidden = !lastFault || st.time - lastFault.t > 30;
    if (this.shown === ev.length) return;
    this.shown = ev.length;
    this.list.innerHTML = "";
    for (const e of ev.slice(-6).reverse()) {
      const li = el("li", e.kind);
      li.append(el("span", "t", `${e.t.toFixed(1)} s`), el("span", "", e.kind === "sent" ? `› ${e.text}` : e.text));
      this.list.append(li);
    }
  }
}

// ---------- controls ----------

class ControlsView extends PanelView {
  private inputs: { c: ControlSpec; els: HTMLElement[]; update?: () => void; fire?: () => void }[] = [];
  constructor(
    public cs: Extract<PanelSpec, { kind: "controls" }>,
    ctx: PanelCtx,
  ) {
    super(cs, ctx);
    const box = el("div", "ka-controls");
    for (const c of cs.controls) box.append(this.control(c));
    this.body.append(box);
    this.linkChanged();
  }
  private async send(text: string, confirm?: string) {
    if (!this.ctx.host.canSend()) return;
    if (confirm && this.ctx.host.confirm && !(await this.ctx.host.confirm(confirm))) return;
    this.ctx.host.send(text);
  }
  private control(c: ControlSpec): HTMLElement {
    const keyHint = (k?: string) => (k ? el("kbd", "", k === " " ? "space" : k.toUpperCase()) : null);
    switch (c.kind) {
      case "button": {
        const b = el("button", `ka-btn ${c.tone}`);
        b.append(el("span", "", c.label));
        const kh = keyHint(c.key);
        if (kh) b.append(kh);
        b.title = `Sends: ${c.send}`;
        const fire = () => void this.send(c.send, c.confirm);
        b.onclick = fire;
        this.inputs.push({ c, els: [b], fire });
        return b;
      }
      case "slider": {
        const row = el("label", "ka-slider");
        const l = el("span", "ka-c-l", c.label);
        const r = el("input") as HTMLInputElement;
        r.type = "range";
        r.min = String(c.min);
        r.max = String(c.max);
        r.step = String(c.step);
        r.value = String(c.value);
        const v = el("span", "ka-c-v", `${fmt(c.value)}${c.unit ? ` ${c.unit}` : ""}`);
        let last = 0;
        r.oninput = () => {
          v.textContent = `${fmt(Number(r.value))}${c.unit ? ` ${c.unit}` : ""}`;
          const now = performance.now();
          if (c.live && now - last > 120) {
            last = now;
            void this.send(fillSend(c.send, Number(r.value)));
          }
        };
        let held = false;
        r.onpointerdown = () => (held = true);
        r.onpointerup = r.onblur = () => (held = false);
        r.onchange = () => {
          held = false;
          void this.send(fillSend(c.send, Number(r.value)));
        };
        row.append(l, r, v);
        this.inputs.push({
          c,
          els: [r],
          // follows what the machine reports, except while it is being moved
          update: c.state
            ? () => {
                const x = this.ctx.store.eval(c.state!);
                if (held || typeof x !== "number" || !Number.isFinite(x) || Number(r.value) === x) return;
                r.value = String(x);
                v.textContent = `${fmt(Number(r.value))}${c.unit ? ` ${c.unit}` : ""}`;
              }
            : undefined,
        });
        return row;
      }
      case "toggle": {
        const b = el("button", "ka-toggle");
        b.setAttribute("role", "switch");
        b.append(el("i"), el("span", "", c.label));
        const kh = keyHint(c.key);
        if (kh) b.append(kh);
        let on = false;
        const show = () => b.setAttribute("aria-checked", String(on));
        const fire = () => {
          on = !on;
          show();
          void this.send(on ? c.on : c.off);
        };
        b.onclick = fire;
        show();
        this.inputs.push({
          c,
          els: [b],
          fire,
          update: c.state
            ? () => {
                const s = isTrue(this.ctx.store.eval(c.state!));
                if (s !== on) {
                  on = s;
                  show();
                }
              }
            : undefined,
        });
        return b;
      }
      case "field": {
        const row = el("form", "ka-field");
        const l = el("span", "ka-c-l", c.label);
        const i = el("input") as HTMLInputElement;
        i.placeholder = c.placeholder ?? "";
        i.spellcheck = false;
        const b = el("button", "ka-btn plain", "Send");
        row.onsubmit = (e) => {
          e.preventDefault();
          if (!i.value.trim()) return;
          void this.send(fillSend(c.send, i.value.trim()));
        };
        row.append(l, i, b);
        this.inputs.push({ c, els: [i, b] });
        return row;
      }
      case "choice": {
        const row = el("div", "ka-choice");
        row.append(el("span", "ka-c-l", c.label));
        const seg = el("div", "ka-seg");
        const btns = c.options.map((o) => {
          const b = el("button", "", o);
          b.onclick = () => {
            for (const x of btns) x.setAttribute("aria-pressed", String(x === b));
            void this.send(fillSend(c.send, o));
          };
          seg.append(b);
          return b;
        });
        row.append(seg);
        this.inputs.push({ c, els: btns });
        return row;
      }
    }
  }
  linkChanged() {
    const live = this.ctx.host.canSend();
    for (const i of this.inputs) for (const e of i.els) (e as HTMLButtonElement).disabled = !live;
  }
  key(k: string) {
    const i = this.inputs.find((x) => x.c.key && x.c.key.toLowerCase() === k.toLowerCase() && x.fire);
    if (!i || !this.ctx.host.canSend()) return false;
    i.fire!();
    return true;
  }
  protected draw() {
    for (const i of this.inputs) i.update?.();
  }
}

// ---------- text ----------

class ConsoleView extends PanelView {
  private out = el("div", "ka-log");
  private input = el("input") as HTMLInputElement;
  private hideData: HTMLInputElement;
  private seen = 0;
  private history: string[] = [];
  private hi = -1;
  private stick = true;
  constructor(
    public c: Extract<PanelSpec, { kind: "console" }>,
    ctx: PanelCtx,
  ) {
    super(c, ctx);
    const opt = el("label", "ka-opt");
    this.hideData = el("input") as HTMLInputElement;
    this.hideData.type = "checkbox";
    this.hideData.checked = true;
    this.hideData.onchange = () => this.rebuild();
    opt.append(this.hideData, document.createTextNode(" hide data lines"));
    this.head.append(opt);
    this.out.onscroll = () => {
      this.stick = this.out.scrollTop + this.out.clientHeight >= this.out.scrollHeight - 8;
    };
    const form = el("form", "ka-cmd");
    const prompt = el("span", "ka-prompt", "›");
    this.input.placeholder = "type a command, Enter sends";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    const cmds = [...new Set([...c.commands, ...ctx.store.app.commands])];
    if (cmds.length) {
      const dl = el("datalist");
      dl.id = `ka-cmds-${Math.random().toString(36).slice(2, 8)}`;
      for (const k of cmds) {
        const o = el("option") as HTMLOptionElement;
        o.value = k;
        dl.append(o);
      }
      this.input.setAttribute("list", dl.id);
      form.append(dl);
      this.input.placeholder = `type a command (${cmds.slice(0, 3).join(", ")}${cmds.length > 3 ? "…" : ""})`;
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = this.input.value.trim();
      if (!v || !ctx.host.canSend()) return;
      ctx.host.send(v);
      this.history.push(v);
      this.hi = -1;
      this.input.value = "";
      this.stick = true;
    };
    this.input.onkeydown = (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (!this.history.length) return;
      this.hi = e.key === "ArrowUp" ? (this.hi < 0 ? this.history.length - 1 : Math.max(0, this.hi - 1)) : this.hi < 0 ? -1 : this.hi + 1;
      if (this.hi >= this.history.length) this.hi = -1;
      this.input.value = this.hi < 0 ? "" : this.history[this.hi];
    };
    form.append(prompt, this.input);
    this.body.append(this.out, form);
    this.linkChanged();
  }
  private rebuild() {
    this.out.innerHTML = "";
    this.seen = 0;
    this.drawn = -1;
    this.update(true);
  }
  linkChanged() {
    this.input.disabled = !this.ctx.host.canSend();
  }
  protected draw() {
    const st = this.ctx.store;
    const log = st.log;
    if (st.logTotal < this.seen) return this.rebuild();
    const from = Math.max(0, log.length - (st.logTotal - this.seen));
    const hide = this.hideData.checked;
    const frag = document.createDocumentFragment();
    for (let i = from; i < log.length; i++) {
      const l = log[i];
      if (hide && l.data) continue;
      const row = el("div", `ka-line ${l.dir}`);
      row.textContent = l.dir === "in" ? `› ${l.text}` : l.text;
      frag.append(row);
    }
    this.seen = st.logTotal;
    this.out.append(frag);
    while (this.out.childElementCount > 600) this.out.firstElementChild!.remove();
    if (this.stick) this.out.scrollTop = this.out.scrollHeight;
  }
}

class LogView extends PanelView {
  private out = el("div", "ka-log");
  private seen = 0;
  private re: RegExp | null;
  constructor(
    public l: Extract<PanelSpec, { kind: "log" }>,
    ctx: PanelCtx,
  ) {
    super(l, ctx);
    this.re = l.match ? new RegExp(l.match, "i") : null;
    this.body.append(this.out);
  }
  protected draw() {
    const st = this.ctx.store;
    const log = st.log;
    if (st.logTotal < this.seen) {
      this.out.innerHTML = "";
      this.seen = 0;
    }
    const frag = document.createDocumentFragment();
    for (let i = Math.max(0, log.length - (st.logTotal - this.seen)); i < log.length; i++) {
      const x = log[i];
      if (x.dir !== "out" || (this.re ? !this.re.test(x.text) : x.data)) continue;
      const row = el("div", "ka-line out");
      row.append(el("span", "t", `${x.t.toFixed(1)}`), document.createTextNode(` ${x.text}`));
      frag.append(row);
    }
    this.seen = st.logTotal;
    this.out.append(frag);
    while (this.out.childElementCount > 300) this.out.firstElementChild!.remove();
    this.out.scrollTop = this.out.scrollHeight;
  }
}

class NoteView extends PanelView {
  constructor(spec: Extract<PanelSpec, { kind: "note" }>, ctx: PanelCtx) {
    super(spec, ctx);
    const box = el("div", "ka-note");
    for (const para of spec.text.split(/\n{2,}|\\n/)) box.append(el("p", "", para));
    this.body.append(box);
  }
  protected draw() {}
}

// ---------- your own drawing ----------

/** The page a custom panel's code runs in: no network, no access to Kerf, only what the app sends it. */
export function sandboxHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%}#err{position:absolute;inset:auto 6px 6px 6px;font:11px/1.4 ui-monospace,monospace;color:#ff8a95;white-space:pre-wrap}</style></head>
<body><canvas id="c"></canvas><div id="err"></div><script>${SANDBOX_JS}</script></body></html>`;
}

/** Runs inside the sandbox: keeps a little history of what it is sent and calls the panel's draw(g). */
const SANDBOX_JS = String.raw`(function(){
var cv=document.getElementById('c'),err=document.getElementById('err'),ctx=cv.getContext('2d');
var draw=null,setup=null,vals={},hist={},theme={},t=0,started=false,state={},sent=0,sentAt=0;
function put(n,tt,v){var h=hist[n];if(!h){h=hist[n]={t:[],v:[]};}h.t.push(tt);h.v.push(v);var cut=0;while(cut<h.t.length&&h.t[cut]<tt-120)cut++;if(cut>0){h.t.splice(0,cut);h.v.splice(0,cut);}}
var g={ctx:ctx,w:0,h:0,t:0,dt:0,state:state,theme:theme,
v:function(n){var x=vals[n];return x===undefined?NaN:x;},
history:function(n,s){var h=hist[n];if(!h)return{t:[],v:[]};s=s||10;var i=0;while(i<h.t.length&&h.t[i]<t-s)i++;return{t:h.t.slice(i),v:h.v.slice(i)};},
send:function(c){var now=Date.now();if(now-sentAt>1000){sentAt=now;sent=0;}if(++sent>20)return;parent.postMessage({kind:'send',text:String(c)},'*');}};
function size(){var d=Math.min(3,window.devicePixelRatio||1),w=innerWidth,h=innerHeight;if(cv.width!==Math.round(w*d)||cv.height!==Math.round(h*d)){cv.width=Math.round(w*d);cv.height=Math.round(h*d);}ctx.setTransform(d,0,0,d,0,0);g.w=w;g.h=h;}
function fail(e){err.textContent=String(e&&e.message||e);}
var last=0;
function frame(now){requestAnimationFrame(frame);if(!draw)return;size();g.dt=last?Math.min(0.1,(now-last)/1000):0;last=now;g.t=t;try{draw(g);err.textContent='';}catch(e){fail(e);}}
addEventListener('message',function(ev){var m=ev.data;if(!m||typeof m!=='object')return;
if(m.kind==='init'){for(var k in m.theme)theme[k]=m.theme[k];try{var f=new Function('g','"use strict";'+m.code+'\n;return {draw:typeof draw==="function"?draw:null,setup:typeof setup==="function"?setup:null};');var r=f(g);draw=r.draw;setup=r.setup;if(setup)setup(g);}catch(e){fail(e);}if(!started){started=true;requestAnimationFrame(frame);}}
else if(m.kind==='data'){t=m.t;for(var n in m.v){vals[n]=m.v[n];if(typeof m.v[n]==='number')put(n,m.t,m.v[n]);}}
else if(m.kind==='theme'){for(var k2 in m.theme)theme[k2]=m.theme[k2];}});
parent.postMessage({kind:'ready'},'*');})();`;

class CustomView extends PanelView {
  private frame = el("iframe") as HTMLIFrameElement;
  private ready = false;
  private onMsg: (e: MessageEvent) => void;
  private lastT = -1;
  constructor(
    public c: Extract<PanelSpec, { kind: "custom" }>,
    ctx: PanelCtx,
  ) {
    super(c, ctx);
    const f = this.frame;
    // scripts only: no same-origin, so it cannot read Kerf's storage, and the page itself allows no network
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.className = "ka-frame";
    f.title = c.title;
    if (ctx.host.sandboxUrl) f.src = ctx.host.sandboxUrl;
    else f.srcdoc = ctx.host.sandboxDoc?.() ?? sandboxHtml();
    this.onMsg = (e: MessageEvent) => {
      if (e.source !== f.contentWindow) return;
      const m = e.data as { kind?: string; text?: string };
      if (m?.kind === "ready") {
        this.ready = true;
        const p = palette();
        f.contentWindow!.postMessage({ kind: "init", code: c.code, theme: { ...p } }, "*");
        this.drawn = -1;
      } else if (m?.kind === "send" && typeof m.text === "string" && ctx.host.canSend()) ctx.host.send(m.text.slice(0, 200));
    };
    window.addEventListener("message", this.onMsg);
    this.body.append(f);
  }
  protected draw() {
    if (!this.ready || !this.frame.contentWindow) return;
    const st = this.ctx.store;
    if (st.time === this.lastT) return;
    this.lastT = st.time;
    const names = this.c.uses.length ? this.c.uses : st.names();
    const v: Record<string, number | string> = {};
    for (const n of names) {
      const x = /^[\w.µ]+$/.test(n) ? st.get(n) : st.eval(n);
      if (x !== undefined) v[n] = x;
    }
    for (const n of ["state", "fault"]) {
      const x = st.get(n);
      if (x !== undefined) v[n] = x;
    }
    this.frame.contentWindow.postMessage({ kind: "data", t: st.time, v }, "*");
  }
  destroy() {
    window.removeEventListener("message", this.onMsg);
  }
}

// ---------- the design in 3D ----------

class ModelPanelView extends PanelView {
  private view: ModelView | null = null;
  private box = el("div", "ka-model");
  constructor(
    public m: Extract<PanelSpec, { kind: "model" }>,
    ctx: PanelCtx,
  ) {
    super(m, ctx);
    this.body.append(this.box);
    if (ctx.host.model) this.view = ctx.host.model(this.box, m, ctx.store);
    else this.box.append(el("div", "ka-empty", "The 3D view of the design shows here when the app runs in Kerf."));
  }
  linkChanged() {
    // the twin brings its scene (where the physics puts each body): build the view again for it
    if (!this.view?.stale?.() || !this.ctx.host.model) return;
    this.view.destroy();
    this.box.replaceChildren();
    this.view = this.ctx.host.model(this.box, this.m, this.ctx.store);
  }
  update(force = false) {
    // the 3D view moves with time, not only with new data
    this.view?.update();
    super.update(force);
  }
  protected draw() {}
  resize() {
    super.resize();
    this.view?.resize();
  }
  destroy() {
    this.view?.destroy();
  }
}

// ---------- a camera ----------

class CameraView extends PanelView {
  private video = el("video") as HTMLVideoElement;
  private over = el("div", "ka-cam-over");
  private cells: { s: SignalItem; v: HTMLElement; l: HTMLElement }[] = [];
  private stream: MediaStream | null = null;
  private msg = el("div", "ka-empty");
  constructor(
    public c: Extract<PanelSpec, { kind: "camera" }>,
    ctx: PanelCtx,
  ) {
    super(c, ctx);
    const box = el("div", "ka-cam");
    this.video.muted = true;
    this.video.playsInline = true;
    for (const s of c.overlay) {
      const cell = el("div", "ka-cam-n");
      const l = el("span");
      const v = el("b");
      cell.append(l, v);
      this.over.append(cell);
      this.cells.push({ s, v, l });
    }
    const start = el("button", "ka-btn plain", "Use a camera");
    const open = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.msg.textContent = "This browser cannot open a camera here.";
        return;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } }, audio: false });
        this.video.srcObject = this.stream;
        await this.video.play();
        start.hidden = true;
        this.msg.hidden = true;
      } catch (e) {
        this.msg.textContent = `The camera did not open: ${(e as Error).message}`;
      }
    };
    start.onclick = () => void open();
    if (ctx.host.camera === false) {
      start.disabled = true;
      this.msg.textContent = "Cameras are turned off here.";
    } else this.msg.textContent = "Plug in a USB camera, then";
    this.msg.append(" ", start);
    box.append(this.video, this.over, this.msg);
    this.body.append(box);
  }
  protected draw() {
    const st = this.ctx.store;
    for (const c of this.cells) {
      const d = describe(c.s, st);
      c.l.textContent = d.label;
      c.v.textContent = `${fmt(st.eval(c.s.expr), c.s.digits)}${d.unit ? ` ${d.unit}` : ""}`;
    }
  }
  destroy() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
  }
}

export function makePanel(p: PanelSpec, ctx: PanelCtx): PanelView {
  switch (p.kind) {
    case "readout":
      return new ReadoutView(p, ctx);
    case "gauge":
      return new GaugeView(p, ctx);
    case "chart":
      return new ChartView(p, ctx);
    case "scope":
      return new ScopeView(p, ctx);
    case "bars":
      return new BarsView(p, ctx);
    case "lamps":
      return new LampsView(p, ctx);
    case "state":
      return new StateView(p, ctx);
    case "controls":
      return new ControlsView(p, ctx);
    case "console":
      return new ConsoleView(p, ctx);
    case "log":
      return new LogView(p, ctx);
    case "table":
      return new TableView(p, ctx);
    case "note":
      return new NoteView(p, ctx);
    case "custom":
      return new CustomView(p, ctx);
    case "model":
      return new ModelPanelView(p, ctx);
    case "camera":
      return new CameraView(p, ctx);
  }
}

/** Expressions a panel uses that do not compile (the language checks them, but a saved app may be edited by hand). */
export function badExprs(p: PanelSpec, exprs: string[]): string[] {
  return exprs.filter((e) => compiled(e) instanceof ExprError).map((e) => `${p.title}: "${e}"`);
}

export type { Palette };
