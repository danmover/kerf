// Simulate → Signals: a logic analyser and scope on the debug run. Each pin the firmware or the world drove, drawn
// as its levels, PWM, servo pulses and tones (the waveform once zoomed in far enough); the serial ports' bytes on the
// wire; I2C and SPI transactions; and every analog reading the firmware took, in volts. Scroll to zoom, drag to pan,
// click to move the replay there. Export writes a VCD for PulseView or GTKWave.

import { useEffect, useMemo, useRef, useState } from "react";
import { useDesign } from "../../core/engine";
import { toast } from "../../app/ui";
import { withOwnCode } from "../../app/firmwareCode";
import { useTheme } from "../../app/theme";
import { generateFirmware } from "../../machine/firmware";
import { debugScenario, scenarioBlock, stopDebugRun, useDebugRun } from "../../sim/debugRuntime";
import { toVcd, type PinSeg, type PinTrace, type SignalTrace } from "../../sim/engine/probes";
import type { ScenarioDef } from "../../sim/scenario";
import { useSim } from "../../sim/runtime";
import { download } from "../../persist/files";
import { Icon } from "../icons";
import { seek } from "./simUi";

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const LABEL_W = 150;
/** room on the right for what each row reads at the mouse */
const READ_W = 120;
const ROW = 26;
const ANALOG_ROW = 64;

type Row =
  | { k: "pin"; p: PinTrace; label: string; sub: string }
  | { k: "uart"; port: number; dir: "tx" | "rx"; label: string }
  | { k: "i2c"; label: string }
  | { k: "spi"; label: string }
  | { k: "adc"; pin: number; label: string; max: number };

const hex = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
const byteText = (b: number) => (b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 ? "\\n" : b === 13 ? "\\r" : hex(b));

function fmtT(t: number, span: number): string {
  if (span < 0.002) return `${(t * 1e6).toFixed(0)} µs`;
  if (span < 2) return `${(t * 1000).toFixed(span < 0.02 ? 2 : 1)} ms`;
  return `${t.toFixed(span < 20 ? 3 : 2)} s`;
}

function segAt(p: PinTrace, t: number): PinSeg | undefined {
  let lo = 0;
  let hi = p.segs.length - 1;
  if (hi < 0 || p.segs[0].t > t) return undefined;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.segs[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return p.segs[lo];
}

function segText(s: PinSeg | undefined): string {
  if (!s) return "–";
  if (s.k === "l") return `${s.v ? "HIGH" : "LOW"}${s.by === "outside" ? " (in)" : s.by === "pull-up" ? " (pull-up)" : ""}`;
  if (s.k === "pwm") return `PWM ${Math.round(s.duty! * 100)}% ${s.hz! >= 1000 ? `${(s.hz! / 1000).toFixed(1)} kHz` : `${Math.round(s.hz!)} Hz`}`;
  if (s.k === "servo") return `servo ${Math.round(s.us!)} µs`;
  if (s.k === "tone") return `tone ${Math.round(s.hz!)} Hz`;
  return "not driven";
}

/** The names a pin map's "ctrl.D2", "GPIO26", "D9 (PB1)" or "A0" can have in a trace (D2, GPIO26, A0). */
function pinKeys(at: string): string[] {
  const paren = /\(([^)]+)\)\s*$/.exec(at)?.[1];
  const label = (paren ? at.slice(0, at.lastIndexOf("(")) : at).trim().split(".").pop() ?? "";
  const keys: string[] = [];
  for (const id of [label, paren ?? ""].map((x) => x.trim()).filter(Boolean)) {
    const n = /^(?:GPIO|IO|D|PIN)?(\d+)$/i.exec(id)?.[1];
    keys.push(...(n !== undefined ? [`D${Number(n)}`, `GPIO${Number(n)}`] : [id.toUpperCase()]));
  }
  return keys;
}

export function SignalsPanel({ def }: { def: ScenarioDef }) {
  const model = useDesign((s) => s.model);
  const variant = useSim((s) => s.variant);
  const run = useDebugRun((s) => s.run);
  const mine = run && run.label === def.label ? run : null;
  const tr = mine?.status === "done" ? mine.signals : undefined;
  const block = useMemo(() => (model ? scenarioBlock(def.label) : null), [model, def.label]);
  // the wiring's names for the pins, from the firmware's pin map
  const names = useMemo(() => {
    const m = new Map<string, string>();
    if (!model?.machine || !block) return m;
    const fw = generateFirmware(withOwnCode(model.machine), model.name).find((f) => f.name === block);
    for (const p of fw?.pinTable ?? []) for (const key of pinKeys(p.pin)) if (!m.has(key)) m.set(key, p.signal);
    return m;
  }, [model, block]);
  const [win, setWin] = useState<{ a: number; b: number } | null>(null);
  useEffect(() => setWin(null), [tr]);
  if (!block)
    return (
      <div className="sim-body kdbg-none">
        <div className="empty-state">This scenario runs no Arduino firmware, so there are no pins to show.</div>
      </div>
    );
  const busy = mine?.status === "running";
  const end = tr?.end ?? 1;
  const view = win ?? { a: 0, b: Math.max(0.001, tr?.truncatedAt ?? end) };
  const record = () => {
    const why = debugScenario(def.label, variant);
    if (why) toast({ kind: "warn", title: "Can't record this run", detail: why });
  };
  const zoom = (f: number) => {
    const c = (view.a + view.b) / 2;
    const half = Math.max(2e-6, ((view.b - view.a) * f) / 2);
    setWin({ a: Math.max(0, c - half), b: Math.min(end, c + half) });
  };
  const exportVcd = () => {
    if (!tr) return;
    const byPin = new Map<number, string>();
    for (const p of tr.pins) {
      const n = names.get(p.name);
      if (n) byPin.set(p.pin, n);
    }
    download(toVcd(tr, view.a, view.b, { names: byPin, design: model?.name }), `${(def.label || "signals").replace(/[^\w.-]+/g, "_")}-${variant}.vcd`, "text/plain");
  };
  return (
    <div className="ksig">
      <div className="mp-toolbar">
        {busy ? (
          <button className="btn sm" onClick={stopDebugRun}>
            <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> Stop · {Math.round((mine.progress ?? 0) * 100)}%
          </button>
        ) : (
          <button className={`btn sm ${tr ? "" : "primary"}`} onClick={record} data-tip="Run this variant again recording every pin and bus (with the debugger's breakpoints too)">
            <Icon.Play size={12} /> {tr ? "Record again" : "Record signals"}
          </button>
        )}
        {tr && (
          <>
            <button className="btn sm ghost" onClick={() => zoom(0.5)} data-tip="Zoom in (or scroll on the traces)">
              <Icon.Plus size={12} />
            </button>
            <button className="btn sm ghost" onClick={() => zoom(2)} data-tip="Zoom out">
              −
            </button>
            <button className="btn sm ghost" onClick={() => setWin(null)} data-tip="The whole run">
              <Icon.Fit size={12} />
            </button>
            <span className="mono dim" style={{ fontSize: 11 }}>
              {fmtT(view.a, view.b - view.a)} – {fmtT(view.b, view.b - view.a)}
            </span>
          </>
        )}
        <div className="grow" />
        {tr?.truncatedAt !== undefined && <span className="chip warn" data-tip="The recording keeps 400 000 changes: zoom on the start, or shorten the scenario">recorded to {tr.truncatedAt.toFixed(2)} s</span>}
        {tr && (
          <button className="btn sm" onClick={exportVcd} data-tip="Value Change Dump of the window on show, for PulseView, GTKWave or sigrok">
            <Icon.Download size={12} /> VCD
          </button>
        )}
      </div>
      {mine?.status === "error" && <div className="kdbg-err" style={{ margin: 12 }}>{mine.error}</div>}
      {tr ? (
        <Traces tr={tr} names={names} view={view} setView={setWin} />
      ) : (
        <div className="empty-state" style={{ margin: 16 }}>
          {busy ? "Recording…" : "Record signals to run this scenario again with a logic analyser on every pin: levels, PWM, servo pulses, tones, the serial ports, I2C and SPI, and the analog readings the firmware took."}
        </div>
      )}
    </div>
  );
}

function rowsOf(tr: SignalTrace, names: Map<string, string>): Row[] {
  const rows: Row[] = tr.pins.map((p) => ({ k: "pin", p, label: names.get(p.name) ?? p.name, sub: names.has(p.name) ? p.name : "" }));
  const ports = [...new Set(tr.uart.map((u) => `${u.port}:${u.dir}`))].sort();
  for (const pd of ports) {
    const [port, dir] = pd.split(":");
    rows.push({ k: "uart", port: Number(port), dir: dir as "tx" | "rx", label: `Serial${port === "0" ? "" : port} ${dir === "tx" ? "TX" : "RX"}` });
  }
  if (tr.i2c.length) rows.push({ k: "i2c", label: "I2C" });
  if (tr.spi.length) rows.push({ k: "spi", label: "SPI" });
  for (const pin of [...new Set(tr.adc.map((a) => a.pin))].sort((a, b) => a - b)) {
    const p = tr.pins.find((x) => x.pin === pin);
    const name = p?.name ?? `pin ${pin}`;
    let max = tr.logicV;
    for (const a of tr.adc) if (a.pin === pin && a.volts > max) max = a.volts;
    rows.push({ k: "adc", pin, label: `${names.get(name) ?? name} volts`, max });
  }
  return rows;
}

function Traces({ tr, names, view, setView }: { tr: SignalTrace; names: Map<string, string>; view: { a: number; b: number }; setView: (v: { a: number; b: number }) => void }) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const t = useSim((s) => s.t);
  const rows = useMemo(() => rowsOf(tr, names), [tr, names]);
  const heights = rows.map((r) => (r.k === "adc" ? ANALOG_ROW : ROW));
  const total = heights.reduce((a, b) => a + b, 0) + 22;
  const plotW = Math.max(50, w - LABEL_W - READ_W);
  const x = (s: number) => LABEL_W + ((s - view.a) / (view.b - view.a)) * plotW;
  const tAt = (px: number) => view.a + ((px - LABEL_W) / plotW) * (view.b - view.a);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(total * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${total}px`;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = cssVar("--text-2") || "#c9d1e1";
    const dim = cssVar("--text-4") || "#5b6478";
    const line = cssVar("--line") || "#2a3142";
    const accent = cssVar("--accent") || "#6d8bff";
    const pass = cssVar("--pass") || "#3ddc97";
    const warn = cssVar("--warn") || "#f5b84b";
    const violet = cssVar("--violet") || "#c792ff";
    const mono = cssVar("--mono") || "monospace";
    g.clearRect(0, 0, w, total);
    g.font = `10.5px ${mono}`;
    const span = view.b - view.a;
    // time axis
    g.fillStyle = dim;
    g.strokeStyle = line;
    g.lineWidth = 1;
    const step = niceStep(span / Math.max(2, plotW / 110));
    for (let s = Math.ceil(view.a / step) * step; s <= view.b; s += step) {
      const px = Math.round(x(s)) + 0.5;
      g.beginPath();
      g.moveTo(px, 16);
      g.lineTo(px, total);
      g.stroke();
      const label = fmtT(s, span);
      if (px + 3 + g.measureText(label).width <= LABEL_W + plotW) g.fillText(label, px + 3, 11);
    }
    let y = 22;
    rows.forEach((r, i) => {
      const h = heights[i];
      g.strokeStyle = line;
      g.beginPath();
      g.moveTo(0, y + h - 0.5);
      g.lineTo(w, y + h - 0.5);
      g.stroke();
      g.fillStyle = ink;
      g.fillText(r.label.length > 19 ? r.label.slice(0, 18) + "…" : r.label, 8, y + 12);
      if (r.k === "pin" && r.sub) {
        g.fillStyle = dim;
        g.fillText(r.sub, 8, y + 23);
      }
      g.save();
      g.beginPath();
      g.rect(LABEL_W, y, plotW, h);
      g.clip();
      if (r.k === "pin") drawPin(g, r.p, view, x, y + 5, y + h - 5, { ink: accent, z: dim, pwm: violet, tone: warn, servo: pass });
      else if (r.k === "uart") drawBoxes(g, tr.uart.filter((u) => u.port === r.port && u.dir === r.dir).map((u) => ({ t0: u.t0, t1: u.t1, text: byteText(u.b) })), view, x, y + 4, y + h - 4, r.dir === "tx" ? accent : pass, ink);
      else if (r.k === "i2c") drawBoxes(g, tr.i2c.map((q) => ({ t0: q.t0, t1: q.t1, text: `${q.op === "w" ? "W" : "R"} ${hex(q.addr)}${q.ack ? "" : " NAK"}${q.bytes.length ? ": " + q.bytes.map(hex).join(" ") : ""}`, bad: !q.ack })), view, x, y + 4, y + h - 4, violet, ink, warn);
      else if (r.k === "spi") drawBoxes(g, tr.spi.map((q) => ({ t0: q.t0, t1: q.t1, text: `${q.out.map(hex).join(" ")}${q.in.some((b) => b) ? " ⇄ " + q.in.map(hex).join(" ") : ""}` })), view, x, y + 4, y + h - 4, warn, ink);
      else drawAdc(g, tr, r.pin, r.max, view, x, y + 6, y + h - 6, accent, dim);
      g.restore();
      y += h;
    });
    // the replay's moment, and the mouse
    const cur = (s: number, col: string) => {
      if (s < view.a || s > view.b) return;
      const px = Math.round(x(s)) + 0.5;
      g.strokeStyle = col;
      g.beginPath();
      g.moveTo(px, 16);
      g.lineTo(px, total);
      g.stroke();
    };
    cur(t, warn);
    if (hover !== null) cur(hover, ink);
  }, [tr, rows, view, w, total, t, hover, theme]);

  // what each row shows at the mouse (or the replay's moment)
  const at = hover ?? t;
  const readout = rows.map((r) => {
    if (r.k === "pin") return segText(segAt(r.p, at));
    if (r.k === "adc") {
      let best: { t: number; volts: number; reading: number } | null = null;
      for (const a of tr.adc) if (a.pin === r.pin && a.t <= at && (!best || a.t > best.t)) best = a;
      return best ? `${Number.isNaN(best.volts) ? "floating" : `${best.volts.toFixed(3)} V`} (${best.reading})` : "–";
    }
    return "";
  });

  const drag = useRef<{ x: number; a: number; b: number; moved: boolean } | null>(null);
  return (
    <div className="ksig-body" ref={host}>
      <canvas
        ref={canvas}
        onWheel={(e) => {
          const r = canvas.current!.getBoundingClientRect();
          const px = e.clientX - r.left;
          if (px < LABEL_W || px > LABEL_W + plotW) return;
          e.preventDefault();
          const c = tAt(px);
          const f = Math.exp(e.deltaY * 0.0015);
          const a = c - (c - view.a) * f;
          const b = c + (view.b - c) * f;
          if (b - a < 2e-6) return;
          setView({ a: Math.max(0, a), b: Math.min(tr.end, b) });
        }}
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, a: view.a, b: view.b, moved: false };
        }}
        onMouseMove={(e) => {
          const r = canvas.current!.getBoundingClientRect();
          const px = e.clientX - r.left;
          setHover(px >= LABEL_W && px <= LABEL_W + plotW ? tAt(px) : null);
          const d = drag.current;
          if (d && e.buttons === 1) {
            const dt = ((e.clientX - d.x) / plotW) * (d.b - d.a);
            if (Math.abs(e.clientX - d.x) > 3) d.moved = true;
            if (d.moved) {
              const a = Math.max(0, Math.min(tr.end - (d.b - d.a), d.a - dt));
              setView({ a, b: a + (d.b - d.a) });
            }
          }
        }}
        onMouseUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const r = canvas.current!.getBoundingClientRect();
            const px = e.clientX - r.left;
            if (px >= LABEL_W && px <= LABEL_W + plotW) seek(tAt(px));
          }
        }}
        onMouseLeave={() => {
          setHover(null);
          drag.current = null;
        }}
      />
      <div className="ksig-readout" style={{ height: total, width: READ_W }}>
        <div className="mono dim t">{fmtT(at, view.b - view.a)}</div>
        {rows.map((r, i) => (
          <div key={i} className="mono v" style={{ height: heights[i] }}>
            {readout[i]}
          </div>
        ))}
      </div>
    </div>
  );
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function drawPin(g: CanvasRenderingContext2D, p: PinTrace, view: { a: number; b: number }, x: (t: number) => number, top: number, bot: number, col: { ink: string; z: string; pwm: string; tone: string; servo: string }) {
  const segs = p.segs;
  // the first segment that reaches into the window
  let i = 0;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].t <= view.a) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  let lastY: number | null = null;
  let lastPx = -1;
  for (; i < segs.length; i++) {
    const s = segs[i];
    if (s.t > view.b) break;
    const a = Math.max(view.a, s.t);
    const b = Math.min(view.b, segs[i + 1]?.t ?? view.b);
    const x0 = x(a);
    const x1 = x(b);
    if (s.k === "l" || s.k === "z") {
      const yy = s.k === "z" ? (top + bot) / 2 : s.v ? top : bot;
      g.strokeStyle = s.k === "z" ? col.z : col.ink;
      g.setLineDash(s.k === "z" ? [3, 3] : []);
      g.beginPath();
      // changes closer than a pixel draw as one busy column
      if (lastY !== null && x0 - lastPx < 1) {
        g.moveTo(x0, top);
        g.lineTo(x0, bot);
      } else if (lastY !== null && lastY !== yy) {
        g.moveTo(x0, lastY);
        g.lineTo(x0, yy);
      }
      g.moveTo(x0, yy);
      g.lineTo(x1, yy);
      g.stroke();
      g.setLineDash([]);
      lastY = yy;
      lastPx = x0;
      continue;
    }
    const hz = s.k === "servo" ? 50 : s.hz!;
    const high = s.k === "pwm" ? s.duty! : s.k === "servo" ? (s.us! / 1e6) * 50 : 0.5;
    const c = s.k === "pwm" ? col.pwm : s.k === "tone" ? col.tone : col.servo;
    const pxPerPeriod = (x(1 / hz) - x(0)) || 0;
    g.strokeStyle = c;
    if (pxPerPeriod >= 4) {
      // zoomed in: the waveform itself
      g.beginPath();
      const period = 1 / hz;
      let first = true;
      for (let k = Math.floor(a / period) * period; k < b; k += period) {
        const up = Math.max(a, k);
        const down = Math.min(b, k + high * period);
        const next = Math.min(b, k + period);
        if (first) {
          g.moveTo(x(up), down > up ? top : bot);
          first = false;
        }
        if (down > up) {
          g.lineTo(x(up), top);
          g.lineTo(x(down), top);
          g.lineTo(x(down), bot);
        }
        g.lineTo(x(next), bot);
      }
      g.stroke();
    } else {
      // zoomed out: a band as high as the share of time the pin is high
      g.globalAlpha = 0.22;
      g.fillStyle = c;
      g.fillRect(x0, top, Math.max(1, x1 - x0), bot - top);
      g.globalAlpha = 0.9;
      g.fillRect(x0, bot - (bot - top) * high, Math.max(1, x1 - x0), 1.5);
      g.globalAlpha = 1;
      const label = segText(s);
      if (x1 - x0 > g.measureText(label).width + 8) {
        g.fillStyle = c;
        g.fillText(label, x0 + 4, top + 10);
      }
    }
    lastY = null;
    lastPx = x0;
  }
}

function drawBoxes(g: CanvasRenderingContext2D, list: { t0: number; t1: number; text: string; bad?: boolean }[], view: { a: number; b: number }, x: (t: number) => number, top: number, bot: number, col: string, ink: string, badCol?: string) {
  let lastEnd = -Infinity;
  for (const it of list) {
    if (it.t1 < view.a || it.t0 > view.b) continue;
    const x0 = x(it.t0);
    const x1 = Math.max(x0 + 1, x(it.t1));
    const c = it.bad && badCol ? badCol : col;
    if (x1 - x0 < 6) {
      // too small for a box: a tick (one a pixel)
      if (x0 - lastEnd < 1) continue;
      g.fillStyle = c;
      g.fillRect(x0, top, 1, bot - top);
      lastEnd = x0;
      continue;
    }
    g.strokeStyle = c;
    g.globalAlpha = 0.18;
    g.fillStyle = c;
    g.fillRect(x0, top, x1 - x0, bot - top);
    g.globalAlpha = 1;
    g.strokeRect(x0 + 0.5, top + 0.5, x1 - x0 - 1, bot - top - 1);
    let text = it.text;
    const room = x1 - x0 - 6;
    if (g.measureText(text).width > room) {
      while (text.length > 1 && g.measureText(text + "…").width > room) text = text.slice(0, -1);
      text += "…";
    }
    if (room > 8) {
      g.fillStyle = ink;
      g.fillText(text, x0 + 3, (top + bot) / 2 + 3.5);
    }
    lastEnd = x1;
  }
}

function drawAdc(g: CanvasRenderingContext2D, tr: SignalTrace, pin: number, max: number, view: { a: number; b: number }, x: (t: number) => number, top: number, bot: number, col: string, dim: string) {
  const yOf = (v: number) => bot - (Math.max(0, v) / (max || 1)) * (bot - top);
  g.fillStyle = dim;
  g.fillText(`${max.toFixed(1)} V`, x(view.a) + 3, top + 8);
  g.strokeStyle = col;
  g.fillStyle = col;
  g.beginPath();
  let started = false;
  let n = 0;
  for (const a of tr.adc) {
    if (a.pin !== pin || Number.isNaN(a.volts)) continue;
    if (a.t < view.a || a.t > view.b) continue;
    const px = x(a.t);
    const py = yOf(a.volts);
    if (!started) {
      g.moveTo(px, py);
      started = true;
    } else g.lineTo(px, py);
    n++;
  }
  g.stroke();
  // few enough to see: each reading as a dot
  if (n && n < 400)
    for (const a of tr.adc) {
      if (a.pin !== pin || Number.isNaN(a.volts) || a.t < view.a || a.t > view.b) continue;
      g.fillRect(x(a.t) - 1.5, yOf(a.volts) - 1.5, 3, 3);
    }
}
