// One time plot of recorded series: drawn once per run onto a cached
// canvas, with the playback cursor, event marks and a hover readout on top.
// Click or drag to move the playback.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Frames } from "../../sim/engine/run";
import type { WorldEvent } from "../../sim/worlds/types";
import { channelInfo } from "../../sim/channels";
import { rangeOf, valueAt } from "../../sim/frames";
import { fmtNum } from "../../lang/values";
import { useSim } from "../../sim/runtime";
import { useTheme } from "../../app/theme";
import { Icon } from "../icons";
import { seek } from "./simUi";

const COLORS = ["#6d8bff", "#4fd1c5", "#f5b84b", "#c792ff", "#ff7b8a", "#3ddc97"];
const EVENT_COLOR: Record<string, string> = { goal: "#3ddc97", contact: "#f5b84b", stall: "#ff5d6c", warn: "#ff5d6c", info: "#48526a" };

/** A theme colour from styles/theme.css, for drawing on a canvas. */
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function Plot({ frames, names, events, onRemove }: { frames: Frames; names: string[]; events: WorldEvent[]; onRemove?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // the grid and cursor are drawn in the theme's ink, so a theme change redraws them
  const theme = useTheme();
  const base = useRef<HTMLCanvasElement | null>(null);
  const t = useSim((s) => s.t);
  const [w, setW] = useState(0);
  const end = frames.t.length ? frames.t[frames.t.length - 1] : 1;
  const unit = channelInfo(names[0] ?? "").unit;
  const range = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of names) {
      const s = frames.series[n];
      if (!s) continue;
      const [a, b] = rangeOf(s);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    if (!(lo <= hi)) return [0, 1] as const;
    if (hi - lo < 1e-9) return [lo - 1, hi + 1] as const;
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad] as const;
  }, [frames, names]);

  // the width follows the panel
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // the series, drawn once: one min/max pair per pixel column
  useEffect(() => {
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    const H = 96;
    const c = document.createElement("canvas");
    c.width = Math.round(w * dpr);
    c.height = Math.round(H * dpr);
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const [lo, hi] = range;
    const y = (v: number) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
    const ink = cssVar("--ink-rgb") || "255 255 255";
    // grid: zero line and quarter lines
    g.strokeStyle = `rgb(${ink} / 0.07)`;
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(0, Math.round((H * i) / 4) + 0.5);
      g.lineTo(w, Math.round((H * i) / 4) + 0.5);
      g.stroke();
    }
    if (lo < 0 && hi > 0) {
      g.strokeStyle = `rgb(${ink} / 0.16)`;
      g.beginPath();
      g.moveTo(0, Math.round(y(0)) + 0.5);
      g.lineTo(w, Math.round(y(0)) + 0.5);
      g.stroke();
    }
    for (const e of events) {
      if (e.kind === "info") continue;
      g.strokeStyle = EVENT_COLOR[e.kind] ?? "#48526a";
      g.globalAlpha = 0.45;
      g.setLineDash([2, 3]);
      const x = Math.round((e.t / end) * w) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
    names.forEach((n, k) => {
      const s = frames.series[n];
      if (!s) return;
      g.strokeStyle = COLORS[k % COLORS.length];
      g.lineWidth = 1.5;
      g.beginPath();
      const T = frames.t;
      let started = false;
      let col = -1;
      let mn = 0;
      let mx = 0;
      const flush = () => {
        if (col < 0) return;
        if (!started) {
          g.moveTo(col, y(mn));
          started = true;
        }
        g.lineTo(col, y(mn));
        if (mx !== mn) g.lineTo(col, y(mx));
      };
      for (let i = 0; i < s.length; i++) {
        const v = s[i];
        if (!Number.isFinite(v)) continue;
        const px = Math.round((T[i] / end) * (w - 1));
        if (px !== col) {
          flush();
          col = px;
          mn = v;
          mx = v;
        } else {
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      flush();
      g.stroke();
    });
    base.current = c;
  }, [w, frames, names, range, events, end, theme]);

  // the cursor on top
  useEffect(() => {
    const el = canvas.current;
    if (!el || !base.current || !w) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = base.current.width;
    el.height = base.current.height;
    const g = el.getContext("2d")!;
    g.drawImage(base.current, 0, 0);
    g.scale(dpr, dpr);
    const x = Math.round((t / end) * (w - 1)) + 0.5;
    g.strokeStyle = cssVar("--text") || "#dfe5f2";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 96);
    g.stroke();
  }, [t, w, end, frames, names, range, events, theme]);

  const drag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === "pointermove" && !e.buttons) return;
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * end);
  };

  return (
    <div className="sim-plot">
      <div className="sim-plot-head">
        {names.map((n, k) => {
          const info = channelInfo(n);
          const v = valueAt(frames, n, t);
          return (
            <span key={n} title={n}>
              <span className="sw" style={{ background: COLORS[k % COLORS.length] }} />
              {info.label} <span className="now">{Number.isFinite(v) ? fmtNum(v, Math.abs(v) < 10 ? 2 : 0) : "–"}</span>
              {info.unit ? ` ${info.unit}` : ""}
            </span>
          );
        })}
        <span style={{ color: "var(--text-4)" }}>
          {fmtNum(range[0], 1)} … {fmtNum(range[1], 1)} {unit}
        </span>
        {onRemove && (
          <button onClick={onRemove} aria-label="Remove plot" data-tip="Remove plot">
            <Icon.X size={12} />
          </button>
        )}
      </div>
      <canvas ref={canvas} onPointerDown={drag} onPointerMove={drag} aria-label={`Plot of ${names.join(", ")}`} />
    </div>
  );
}
