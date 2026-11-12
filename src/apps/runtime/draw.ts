// Drawing helpers for app panels: the theme's colours read from CSS, canvases
// sized for the screen's pixel density, number formatting and axis ticks.

export interface Palette {
  text: string;
  text2: string;
  text3: string;
  line: string;
  line2: string;
  bg: string;
  panel: string;
  accent: string;
  pass: string;
  warn: string;
  fail: string;
  series: string[];
}

let cached: { key: string; p: Palette } | null = null;

/** The theme's colours, read from CSS custom properties (Kerf's tokens). */
export function palette(el: Element = document.documentElement): Palette {
  const key = document.documentElement.getAttribute("data-theme") ?? "dark";
  if (cached && cached.key === key) return cached.p;
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  const p: Palette = {
    text: v("--text", "#dfe5f2"),
    text2: v("--text-2", "#a3adc2"),
    text3: v("--text-3", "#6c7791"),
    line: v("--line", "#1f2533"),
    line2: v("--line-2", "#2a3245"),
    bg: v("--bg-1", "#0b0e14"),
    panel: v("--bg-2", "#10141c"),
    accent: v("--accent", "#6d8bff"),
    pass: v("--pass", "#3ddc97"),
    warn: v("--warn", "#f5b84b"),
    fail: v("--fail", "#ff5d6c"),
    series: [v("--series-1", "#5b7cf0"), v("--series-2", "#d95926"), v("--series-3", "#199e70"), v("--violet", "#c792ff"), v("--cyan", "#4fd1c5"), v("--warn", "#f5b84b"), v("--info", "#7cc4ff"), v("--fail", "#ff5d6c")],
  };
  cached = { key, p };
  return p;
}

export function forgetPalette() {
  cached = null;
}

/** A colour from a spec: a token name or #hex. */
export function colorOf(c: string | undefined, p: Palette, i: number): string {
  if (!c) return p.series[i % p.series.length];
  switch (c.toLowerCase()) {
    case "accent":
    case "blue":
      return c === "blue" ? p.series[0] : p.accent;
    case "green":
      return p.pass;
    case "amber":
      return p.warn;
    case "red":
      return p.fail;
    case "violet":
      return p.series[3];
    case "teal":
      return p.series[4];
    case "grey":
    case "gray":
      return p.text3;
    default:
      return c;
  }
}

/** A canvas filling its parent at the screen's pixel density; returns false when it has no size yet. */
export function fit(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const r = cv.parentElement!.getBoundingClientRect();
  const w = Math.max(0, Math.floor(r.width));
  const h = Math.max(0, Math.floor(r.height));
  if (w < 4 || h < 4) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
  }
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** A number for a readout: the digits it deserves, or as asked. */
export function fmt(v: number | string | undefined, digits?: number): string {
  if (v === undefined) return "–";
  if (typeof v === "string") return v || "–";
  if (!Number.isFinite(v)) return "–";
  if (digits !== undefined) return v.toFixed(Math.max(0, Math.min(8, digits)));
  const a = Math.abs(v);
  if (a >= 10000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 10) return v.toFixed(2);
  if (a >= 0.01 || a === 0) return v.toFixed(a === 0 ? 0 : 3);
  return v.toPrecision(2);
}

/** Round axis ticks covering lo..hi. */
export function ticks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export function tickLabel(v: number, step: number): string {
  const d = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  return v.toFixed(d);
}

/** A range with a little room, that grows at once and shrinks slowly, so charts do not jump. */
export class EasedRange {
  lo = NaN;
  hi = NaN;
  take(lo: number, hi: number, fixedLo?: number, fixedHi?: number): [number, number] {
    if (!(hi >= lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-9) {
      const pad = Math.abs(hi) * 0.1 || 1;
      lo -= pad;
      hi += pad;
    }
    const pad = (hi - lo) * 0.08;
    let a = fixedLo ?? lo - pad;
    let b = fixedHi ?? hi + pad;
    if (Number.isFinite(this.lo)) {
      if (fixedLo === undefined) a = a < this.lo ? a : this.lo + (a - this.lo) * 0.05;
      if (fixedHi === undefined) b = b > this.hi ? b : this.hi + (b - this.hi) * 0.05;
    }
    this.lo = a;
    this.hi = b;
    return [a, b];
  }
}

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
