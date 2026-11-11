// The film's graphics, drawn over each frame with the 2D canvas: captions
// with an accent bar, chapter labels, the badge, callouts with leader lines,
// number cards that count up, the parts list, scrolling firmware, and the
// title and end cards. Sizes are in a unit of 1/1080 of the frame's short
// side, so every resolution and aspect looks the same.

import { project, smooth, clamp01, type FilmCamera, type FrameLayer, type FrameState, type Graphic, type Tile } from "./timeline";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FilmStyle {
  accent: string;
  /** pale backdrop: dark text */
  light: boolean;
  width: number;
  height: number;
}

const SANS = "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, Consolas, monospace";

/** The fonts the graphics use, loaded before the first frame is drawn. */
export const FILM_FONTS = [`700 64px ${SANS}`, `600 64px ${SANS}`, `400 64px ${SANS}`, `500 32px ${MONO}`, `400 32px ${MONO}`, `600 32px ${MONO}`];

interface Palette {
  text: string;
  dim: string;
  faint: string;
  panel: string;
  edge: string;
  shadow: string;
  band: [string, string];
}

function palette(s: FilmStyle): Palette {
  return s.light
    ? { text: "#111318", dim: "rgba(17,19,24,0.68)", faint: "rgba(17,19,24,0.4)", panel: "rgba(255,255,255,0.72)", edge: "rgba(17,19,24,0.12)", shadow: "rgba(0,0,0,0.12)", band: ["rgba(246,247,249,0)", "rgba(246,247,249,0.78)"] }
    : { text: "#ffffff", dim: "rgba(255,255,255,0.74)", faint: "rgba(255,255,255,0.42)", panel: "rgba(12,14,18,0.62)", edge: "rgba(255,255,255,0.14)", shadow: "rgba(0,0,0,0.45)", band: ["rgba(4,5,7,0)", "rgba(4,5,7,0.62)"] };
}

const unit = (s: FilmStyle) => Math.min(s.width, s.height) / 1080;
const portrait = (s: FilmStyle) => s.width / s.height < 0.9;

function spacing(ctx: Ctx, px: number) {
  // letterSpacing arrived in Chrome 99; without it the labels are just tighter
  if ("letterSpacing" in ctx) (ctx as { letterSpacing: string }).letterSpacing = `${px}px`;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Split text into lines no wider than max; the last line takes the rest, cut to fit. */
function wrap(ctx: Ctx, text: string, max: number, lines = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (!cur || ctx.measureText(next).width <= max) cur = next;
    else {
      out.push(cur);
      cur = words[i];
      if (out.length === lines - 1) {
        i++;
        break;
      }
    }
  }
  const rest = [cur, ...words.slice(i)].filter(Boolean).join(" ");
  if (rest) out.push(fit(ctx, rest, max));
  return out;
}

function fit(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function panel(ctx: Ctx, p: Palette, x: number, y: number, w: number, h: number, r: number) {
  ctx.save();
  ctx.shadowColor = p.shadow;
  ctx.shadowBlur = r * 2;
  ctx.shadowOffsetY = r * 0.4;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = p.panel;
  ctx.fill();
  ctx.restore();
  roundRect(ctx, x, y, w, h, r);
  ctx.strokeStyle = p.edge;
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.stroke();
}

// ---------- pieces ----------

function caption(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "caption" }>, alpha: number) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003) return;
  const m = (portrait(s) ? 60 : 72) * u;
  const max = portrait(s) ? s.width - 2 * m - 24 * u : s.width * 0.6;
  // the band behind the caption keeps it readable on any picture
  const band = ctx.createLinearGradient(0, s.height * 0.6, 0, s.height);
  band.addColorStop(0, p.band[0]);
  band.addColorStop(1, p.band[1]);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = band;
  ctx.fillRect(0, s.height * 0.6, s.width, s.height * 0.4);
  const rise = (1 - smooth(g.a)) * 26 * u;
  ctx.font = `600 ${54 * u}px ${SANS}`;
  const titleLines = g.title ? wrap(ctx, g.title, max, 2) : [];
  ctx.font = `400 ${31 * u}px ${SANS}`;
  const textLines = g.text ? wrap(ctx, g.text, max, 2) : [];
  const th = 62 * u;
  const xh = 42 * u;
  const h = titleLines.length * th + textLines.length * xh + (titleLines.length && textLines.length ? 8 * u : 0);
  const bottom = s.height - (portrait(s) ? 150 : 92) * u;
  let y = bottom - h + rise;
  const x = m + 26 * u;
  ctx.fillStyle = s.accent;
  roundRect(ctx, m, y + 6 * u, 6 * u, h - 6 * u, 3 * u);
  ctx.fill();
  ctx.textBaseline = "top";
  ctx.fillStyle = p.text;
  ctx.font = `600 ${54 * u}px ${SANS}`;
  for (const l of titleLines) {
    ctx.fillText(l, x, y);
    y += th;
  }
  if (titleLines.length && textLines.length) y += 8 * u;
  ctx.fillStyle = p.dim;
  ctx.font = `400 ${31 * u}px ${SANS}`;
  for (const l of textLines) {
    ctx.fillText(l, x, y + 4 * u);
    y += xh;
  }
  ctx.restore();
}

function chapter(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "chapter" }>, alpha: number) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003) return;
  const m = (portrait(s) ? 60 : 72) * u;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textBaseline = "middle";
  const y = m + 14 * u;
  const slide = (1 - smooth(g.a)) * -18 * u;
  ctx.font = `600 ${22 * u}px ${MONO}`;
  spacing(ctx, 3 * u);
  const num = String(g.n).padStart(2, "0");
  ctx.fillStyle = s.accent;
  ctx.fillText(num, m + slide, y);
  const nw = ctx.measureText(num).width;
  ctx.strokeStyle = p.faint;
  ctx.lineWidth = 1.5 * u;
  ctx.beginPath();
  ctx.moveTo(m + nw + 16 * u + slide, y);
  ctx.lineTo(m + nw + 52 * u + slide, y);
  ctx.stroke();
  ctx.font = `500 ${22 * u}px ${MONO}`;
  ctx.fillStyle = p.text;
  ctx.fillText(g.label.toUpperCase(), m + nw + 68 * u + slide, y);
  ctx.restore();
}

function badge(ctx: Ctx, s: FilmStyle, p: Palette, text: string, a: number) {
  if (!text || a <= 0.003) return;
  const u = unit(s);
  const m = (portrait(s) ? 60 : 72) * u;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `500 ${17 * u}px ${MONO}`;
  spacing(ctx, 3 * u);
  const label = text.toUpperCase();
  const w = ctx.measureText(label).width + 58 * u;
  const h = 40 * u;
  const x = s.width - m - w;
  const y = m - 6 * u;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = s.light ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.28)";
  ctx.fill();
  ctx.strokeStyle = p.faint;
  ctx.lineWidth = 1.4 * u;
  ctx.stroke();
  ctx.fillStyle = s.accent;
  ctx.beginPath();
  ctx.arc(x + 22 * u, y + h / 2, 5 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.text;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + 38 * u, y + h / 2 + 1 * u);
  ctx.restore();
}

function titleCard(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "titleCard" }>, alpha: number, badgeText: string) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003) return;
  const cx = s.width / 2;
  const cy = s.height * (portrait(s) ? 0.44 : 0.47);
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  // the title, scaled down to fit and revealed a letter at a time
  let size = (portrait(s) ? 96 : 118) * u;
  ctx.font = `700 ${size}px ${SANS}`;
  spacing(ctx, -1 * u);
  const maxW = s.width * 0.86;
  const full = ctx.measureText(g.title).width;
  if (full > maxW) {
    size *= maxW / full;
    ctx.font = `700 ${size}px ${SANS}`;
  }
  const w = ctx.measureText(g.title).width;
  const x0 = cx - w / 2;
  const chars = [...g.title];
  let x = x0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prefix = chars.slice(0, i).join("");
    x = x0 + ctx.measureText(prefix).width;
    const k = smooth((g.a * 1.25 - i * (0.5 / Math.max(8, chars.length))) / 0.5);
    ctx.globalAlpha = a * k;
    ctx.fillStyle = p.text;
    ctx.fillText(ch, x, cy + (1 - k) * 34 * u);
  }
  // an accent line drawn out under it
  const lw = Math.min(w, 170 * u) * smooth((g.a - 0.3) / 0.6);
  ctx.globalAlpha = a;
  ctx.fillStyle = s.accent;
  roundRect(ctx, cx - lw / 2, cy + 34 * u, Math.max(0.1, lw), 6 * u, 3 * u);
  ctx.fill();
  if (badgeText) {
    ctx.font = `500 ${20 * u}px ${MONO}`;
    spacing(ctx, 6 * u);
    const bt = badgeText.toUpperCase();
    ctx.globalAlpha = a * smooth((g.a - 0.15) / 0.5) * 0.8;
    ctx.fillStyle = p.text;
    ctx.fillText(bt, cx - ctx.measureText(bt).width / 2, cy - size * 0.95);
  }
  if (g.tagline) {
    ctx.font = `400 ${(portrait(s) ? 34 : 38) * u}px ${SANS}`;
    spacing(ctx, 0);
    const lines = wrap(ctx, g.tagline, s.width * 0.78, 2);
    ctx.globalAlpha = a * smooth((g.a - 0.45) / 0.5);
    ctx.fillStyle = p.dim;
    lines.forEach((l, i) => ctx.fillText(l, cx - ctx.measureText(l).width / 2, cy + 104 * u + i * 50 * u + (1 - smooth(g.a)) * 14 * u));
  }
  ctx.restore();
}

function endCard(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "endCard" }>, alpha: number) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003) return;
  const cx = s.width / 2;
  const cy = s.height * 0.46;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  let size = (portrait(s) ? 80 : 92) * u;
  ctx.font = `700 ${size}px ${SANS}`;
  spacing(ctx, -1 * u);
  const maxW = s.width * 0.84;
  const tw = ctx.measureText(g.title).width;
  if (tw > maxW) {
    size *= maxW / tw;
    ctx.font = `700 ${size}px ${SANS}`;
  }
  ctx.globalAlpha = a;
  ctx.fillStyle = p.text;
  ctx.fillText(g.title, cx - ctx.measureText(g.title).width / 2, cy + (1 - smooth(g.a)) * 20 * u);
  const lw = 150 * u * smooth((g.a - 0.2) / 0.6);
  ctx.fillStyle = s.accent;
  roundRect(ctx, cx - lw / 2, cy + 30 * u, Math.max(0.1, lw), 6 * u, 3 * u);
  ctx.fill();
  if (g.line) {
    ctx.font = `400 ${36 * u}px ${SANS}`;
    spacing(ctx, 0);
    const lines = wrap(ctx, g.line, s.width * 0.8, 2);
    ctx.globalAlpha = a * smooth((g.a - 0.35) / 0.5);
    ctx.fillStyle = p.dim;
    lines.forEach((l, i) => ctx.fillText(l, cx - ctx.measureText(l).width / 2, cy + 98 * u + i * 48 * u));
  }
  if (g.badge) {
    ctx.font = `500 ${18 * u}px ${MONO}`;
    spacing(ctx, 5 * u);
    const b = g.badge.toUpperCase();
    ctx.globalAlpha = a * smooth((g.a - 0.5) / 0.5) * 0.7;
    ctx.fillStyle = p.text;
    ctx.fillText(b, cx - ctx.measureText(b).width / 2, s.height - 96 * u);
  }
  ctx.restore();
}

interface Placed {
  ax: number;
  ay: number;
  side: 1 | -1;
  ly: number;
  title: string;
  text: string;
}

function callouts(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "callouts" }>, alpha: number, aspect: number) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003) return;
  const placed: Placed[] = [];
  for (const it of g.items) {
    const q = project(g.camera as FilmCamera, aspect, it.at);
    if (!q.front || q.x < 0.04 || q.x > 0.96 || q.y < 0.08 || q.y > 0.9) continue;
    const ax = q.x * s.width;
    const ay = q.y * s.height;
    placed.push({ ax, ay, side: q.x < 0.5 ? -1 : 1, ly: ay - 70 * u, title: it.title, text: it.text });
  }
  // labels on one side keep apart vertically
  for (const side of [-1, 1] as const) {
    const col = placed.filter((c) => c.side === side).sort((x, y) => x.ly - y.ly);
    for (let i = 1; i < col.length; i++) col[i].ly = Math.max(col[i].ly, col[i - 1].ly + 96 * u);
    const top = 120 * u;
    if (col.length && col[0].ly < top) {
      const d = top - col[0].ly;
      for (const c of col) c.ly += d;
    }
  }
  ctx.save();
  for (const c of placed) {
    const k = smooth(g.k / 0.6);
    const kt = smooth((g.k - 0.45) / 0.5);
    const elbowX = c.ax + c.side * 46 * u;
    const endX = elbowX + c.side * 110 * u;
    ctx.globalAlpha = a;
    // the spot: a dot with a soft ring
    ctx.fillStyle = s.accent;
    ctx.beginPath();
    ctx.arc(c.ax, c.ay, 5.5 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = s.accent;
    ctx.globalAlpha = a * 0.5;
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.arc(c.ax, c.ay, 13 * u * (0.6 + 0.4 * k), 0, Math.PI * 2);
    ctx.stroke();
    // the leader, drawn out from the spot
    ctx.globalAlpha = a;
    ctx.strokeStyle = p.text;
    ctx.lineWidth = 2 * u;
    const seg1 = Math.hypot(elbowX - c.ax, c.ly - c.ay);
    const seg2 = Math.abs(endX - elbowX);
    const drawn = k * (seg1 + seg2);
    ctx.beginPath();
    ctx.moveTo(c.ax, c.ay);
    if (drawn <= seg1) ctx.lineTo(c.ax + ((elbowX - c.ax) * drawn) / seg1, c.ay + ((c.ly - c.ay) * drawn) / seg1);
    else {
      ctx.lineTo(elbowX, c.ly);
      ctx.lineTo(elbowX + c.side * (drawn - seg1), c.ly);
    }
    ctx.stroke();
    // the label above the leader's end
    ctx.globalAlpha = a * kt;
    ctx.textBaseline = "alphabetic";
    ctx.font = `600 ${28 * u}px ${SANS}`;
    const maxW = Math.max(160 * u, c.side > 0 ? s.width - endX - 24 * u : endX - 24 * u);
    const title = fit(ctx, c.title, Math.min(maxW, 460 * u));
    const tw = ctx.measureText(title).width;
    const tx = c.side > 0 ? elbowX : elbowX - tw;
    const tx2 = Math.min(Math.max(tx, 24 * u), s.width - 24 * u - tw);
    ctx.fillStyle = p.text;
    ctx.shadowColor = p.shadow;
    ctx.shadowBlur = 10 * u;
    ctx.fillText(title, tx2, c.ly - 12 * u + (1 - kt) * 8 * u);
    if (c.text) {
      ctx.font = `400 ${19 * u}px ${MONO}`;
      const t = fit(ctx, c.text, Math.min(maxW, 460 * u));
      const w2 = ctx.measureText(t).width;
      const x2 = c.side > 0 ? elbowX : elbowX - w2;
      ctx.fillStyle = p.dim;
      ctx.fillText(t, Math.min(Math.max(x2, 24 * u), s.width - 24 * u - w2), c.ly + 30 * u);
    }
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

function tileValue(t: Tile, k: number): string {
  if (typeof t.value === "string") return t.value;
  const v = t.value * (1 - Math.pow(1 - clamp01(k), 3));
  const d = t.decimals ?? 0;
  const n = v.toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
  return t.unit === "$" ? `$${n}` : n;
}

function tiles(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "tiles" }>, alpha: number) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003 || !g.items.length) return;
  const cols = portrait(s) ? 2 : Math.min(3, g.items.length);
  const rows = Math.ceil(g.items.length / cols);
  const gap = 26 * u;
  const tw = portrait(s) ? (s.width - 2 * 60 * u - gap) / 2 : Math.min(360 * u, (s.width * 0.8 - gap * (cols - 1)) / cols);
  const th = 186 * u;
  const W = cols * tw + (cols - 1) * gap;
  const H = rows * th + (rows - 1) * gap;
  const x0 = (s.width - W) / 2;
  const y0 = (s.height - H) / 2 - (portrait(s) ? 0 : 30 * u);
  ctx.save();
  g.items.forEach((t, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const k = smooth((g.k * 1.5 - i * 0.12) / 0.45);
    const x = x0 + c * (tw + gap);
    const y = y0 + r * (th + gap) + (1 - k) * 30 * u;
    ctx.globalAlpha = a * k;
    panel(ctx, p, x, y, tw, th, 20 * u);
    ctx.textBaseline = "top";
    ctx.font = `500 ${17 * u}px ${MONO}`;
    spacing(ctx, 3 * u);
    ctx.fillStyle = p.dim;
    ctx.fillText(t.label.toUpperCase(), x + 28 * u, y + 26 * u);
    spacing(ctx, 0);
    const value = tileValue(t, (g.k * 1.5 - i * 0.12) / 0.9);
    const long = typeof t.value === "string" && value.length > 12;
    ctx.font = long ? `600 ${36 * u}px ${SANS}` : `600 ${62 * u}px ${SANS}`;
    ctx.fillStyle = p.text;
    const vy = y + (long ? 78 : 62) * u;
    const vt = fit(ctx, value, tw - 56 * u);
    ctx.fillText(vt, x + 28 * u, vy);
    if (t.unit && t.unit !== "$") {
      const vw = ctx.measureText(vt).width;
      ctx.font = `400 ${24 * u}px ${SANS}`;
      ctx.fillStyle = p.dim;
      const short = t.unit.length <= 3;
      if (short && !long) ctx.fillText(t.unit, x + 28 * u + vw + 10 * u, vy + 30 * u);
      else ctx.fillText(fit(ctx, t.unit, tw - 56 * u), x + 28 * u, y + th - 50 * u);
    }
    // a thin accent line along the card's foot
    ctx.fillStyle = s.accent;
    ctx.globalAlpha = a * k * 0.9;
    ctx.fillRect(x + 28 * u, y + th - 12 * u, (tw - 56 * u) * smooth((g.k * 1.5 - i * 0.12 - 0.2) / 0.6), 3 * u);
  });
  ctx.restore();
}

function table(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "table" }>, alpha: number) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003) return;
  const port = portrait(s);
  const rowH = 50 * u;
  const pad = 30 * u;
  const w = port ? s.width - 2 * 60 * u : Math.min(s.width * 0.44, 820 * u);
  const h = pad * 2 + 46 * u + g.rows.length * rowH + (g.more ? 40 * u : 0) + 70 * u;
  const x = port ? 60 * u : 72 * u;
  const y = port ? s.height - h - 140 * u : (s.height - h) / 2 - 10 * u;
  const slide = (1 - smooth(g.a)) * (port ? 0 : -40 * u);
  ctx.save();
  ctx.globalAlpha = a;
  panel(ctx, p, x + slide, y, w, h, 22 * u);
  const left = x + slide + pad;
  const right = x + slide + w - pad;
  ctx.textBaseline = "middle";
  ctx.font = `500 ${16 * u}px ${MONO}`;
  spacing(ctx, 3 * u);
  ctx.fillStyle = p.dim;
  let cy = y + pad + 14 * u;
  ctx.fillText("QTY", left, cy);
  ctx.fillText("PART", left + 76 * u, cy);
  const ph = "PRICE";
  ctx.fillText(ph, right - ctx.measureText(ph).width, cy);
  spacing(ctx, 0);
  cy += 34 * u;
  ctx.strokeStyle = p.edge;
  ctx.lineWidth = 1.2 * u;
  g.rows.forEach((r, i) => {
    const k = smooth((g.k * 1.6 - i * 0.1) / 0.35);
    ctx.globalAlpha = a * k;
    const ry = cy + i * rowH + rowH / 2 + (1 - k) * 12 * u;
    ctx.beginPath();
    ctx.moveTo(left, cy + i * rowH);
    ctx.lineTo(right, cy + i * rowH);
    ctx.stroke();
    ctx.font = `600 ${22 * u}px ${MONO}`;
    ctx.fillStyle = s.accent;
    ctx.fillText(`${r.qty}×`, left, ry);
    ctx.font = `400 ${24 * u}px ${SANS}`;
    ctx.fillStyle = p.text;
    ctx.font = `400 ${21 * u}px ${MONO}`;
    const pw = ctx.measureText(r.price).width;
    ctx.fillStyle = r.kind === "Make" ? p.faint : p.text;
    ctx.fillText(r.price, right - pw, ry);
    ctx.font = `400 ${24 * u}px ${SANS}`;
    ctx.fillStyle = p.text;
    ctx.fillText(fit(ctx, r.item, right - pw - 24 * u - (left + 76 * u)), left + 76 * u, ry);
  });
  let fy = cy + g.rows.length * rowH;
  const kf = smooth((g.k * 1.6 - g.rows.length * 0.1) / 0.35);
  ctx.globalAlpha = a * kf;
  if (g.more) {
    ctx.font = `400 ${20 * u}px ${SANS}`;
    ctx.fillStyle = p.dim;
    ctx.fillText(`and ${g.more} more`, left + 76 * u, fy + 22 * u);
    fy += 40 * u;
  }
  ctx.fillStyle = s.accent;
  ctx.fillRect(left, fy + 14 * u, right - left, 2.5 * u);
  ctx.font = `600 ${27 * u}px ${SANS}`;
  ctx.fillStyle = p.text;
  ctx.fillText(fit(ctx, g.total, right - left), left, fy + 48 * u);
  ctx.restore();
}

const KEYWORDS = /\b(void|int|float|double|long|bool|char|const|static|unsigned|uint8_t|uint16_t|uint32_t|int16_t|int32_t|if|else|for|while|return|switch|case|break|struct|class|true|false|def|import|from|while|elif|None|True|False|G0|G1|G28|M104|M109|M140)\b/g;

function codeLine(ctx: Ctx, s: FilmStyle, p: Palette, line: string, x: number, y: number, max: number) {
  const comment = line.search(/\/\/|#(?!include|define)|;\s/);
  const code = comment >= 0 ? line.slice(0, comment) : line;
  const rest = comment >= 0 ? line.slice(comment) : "";
  // tokens: keywords, numbers, strings and the rest, drawn one after another
  const re = /("[^"]*"|'[^']*'|\b\d+(\.\d+)?\b|#include|#define|\b[A-Za-z_]\w*\b|\s+|.)/g;
  let cx = x;
  const right = x + max;
  for (const m of code.matchAll(re)) {
    const tok = m[0];
    if (cx > right) break;
    KEYWORDS.lastIndex = 0;
    ctx.fillStyle = /^["']/.test(tok) ? "#8fd18f" : /^\d/.test(tok) ? "#f2b36b" : /^#/.test(tok) || KEYWORDS.test(tok) ? s.accent : p.text;
    ctx.fillText(tok, cx, y);
    cx += ctx.measureText(tok).width;
  }
  if (rest && cx < right) {
    ctx.fillStyle = p.faint;
    ctx.fillText(fit(ctx, rest, right - cx), cx, y);
  }
}

function code(ctx: Ctx, s: FilmStyle, p: Palette, g: Extract<Graphic, { g: "code" }>, alpha: number) {
  const u = unit(s);
  const a = g.a * alpha;
  if (a <= 0.003 || !g.lines.length) return;
  const port = portrait(s);
  const w = port ? s.width - 2 * 60 * u : Math.min(s.width * 0.48, 900 * u);
  const h = port ? s.height * 0.36 : s.height * 0.64;
  const x = port ? 60 * u : 72 * u;
  const y = port ? s.height - h - 190 * u : (s.height - h) / 2 - 20 * u;
  const slide = (1 - smooth(g.a)) * (port ? 30 * u : -40 * u);
  const dark: Palette = { ...p, panel: "rgba(10,12,16,0.86)", text: "#e8ebf0", dim: "rgba(232,235,240,0.7)", faint: "rgba(232,235,240,0.42)", edge: "rgba(255,255,255,0.12)" };
  ctx.save();
  ctx.globalAlpha = a;
  panel(ctx, dark, x + (port ? 0 : slide), y + (port ? slide : 0), w, h, 18 * u);
  const ox = x + (port ? 0 : slide);
  const oy = y + (port ? slide : 0);
  // the window's title bar
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(ox + 28 * u + i * 22 * u, oy + 28 * u, 6.5 * u, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.font = `500 ${17 * u}px ${MONO}`;
  ctx.fillStyle = dark.dim;
  ctx.textBaseline = "middle";
  ctx.fillText(fit(ctx, g.title, w - 140 * u), ox + 110 * u, oy + 29 * u);
  ctx.fillStyle = dark.edge;
  ctx.fillRect(ox, oy + 56 * u, w, 1.2 * u);
  const lh = 29 * u;
  const top = oy + 76 * u;
  const visible = Math.max(4, Math.floor((h - 96 * u) / lh));
  // typed a line at a time, scrolling once the window is full
  const shown = Math.min(g.lines.length, Math.max(visible, Math.round(visible * 2.4)));
  const typed = g.k * shown;
  const done = Math.floor(typed);
  const first = Math.max(0, done - visible + 1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy + 58 * u, w, h - 60 * u);
  ctx.clip();
  ctx.font = `400 ${19 * u}px ${MONO}`;
  ctx.textBaseline = "top";
  for (let i = first; i <= Math.min(done, g.lines.length - 1); i++) {
    const ly = top + (i - first) * lh;
    let line = g.lines[i].replace(/\t/g, "  ");
    if (i === done) line = line.slice(0, Math.floor((typed - done) * line.length));
    ctx.fillStyle = dark.faint;
    const n = String(i + 1).padStart(3, " ");
    ctx.fillText(n, ox + 20 * u, ly);
    codeLine(ctx, s, dark, line, ox + 76 * u, ly, w - 100 * u);
    if (i === done) {
      // the cursor
      ctx.fillStyle = s.accent;
      const cw = ctx.measureText(line).width;
      ctx.fillRect(Math.min(ox + 76 * u + cw + 2 * u, ox + w - 20 * u), ly + 2 * u, 10 * u, 22 * u);
    }
  }
  ctx.restore();
  ctx.restore();
}

// ---------- frames ----------

/** One layer's graphics (a shot's captions and cards), at the layer's crossfade weight. */
export function drawLayerGraphics(ctx: Ctx, s: FilmStyle, layer: FrameLayer, badgeText: string) {
  const p = palette(s);
  const aspect = s.width / s.height;
  for (const g of layer.graphics) {
    switch (g.g) {
      case "caption":
        caption(ctx, s, p, g, layer.weight);
        break;
      case "chapter":
        chapter(ctx, s, p, g, layer.weight);
        break;
      case "titleCard":
        titleCard(ctx, s, p, g, layer.weight, badgeText);
        break;
      case "endCard":
        endCard(ctx, s, p, g, layer.weight);
        break;
      case "callouts":
        callouts(ctx, s, p, g, layer.weight, aspect);
        break;
      case "tiles":
        tiles(ctx, s, p, g, layer.weight);
        break;
      case "table":
        table(ctx, s, p, g, layer.weight);
        break;
      case "code":
        code(ctx, s, p, g, layer.weight);
        break;
    }
  }
}

/** What sits over every layer: the badge, the thin progress line along the foot, and the fade from and to black. */
export function drawChrome(ctx: Ctx, s: FilmStyle, f: FrameState, badgeText: string, progressLine: boolean) {
  const p = palette(s);
  badge(ctx, s, p, badgeText, f.badge);
  const u = unit(s);
  if (progressLine && f.badge > 0.003) {
    ctx.save();
    ctx.globalAlpha = f.badge;
    ctx.fillStyle = s.light ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.12)";
    ctx.fillRect(0, s.height - 5 * u, s.width, 5 * u);
    ctx.fillStyle = s.accent;
    ctx.fillRect(0, s.height - 5 * u, s.width * f.progress, 5 * u);
    ctx.restore();
  }
  if (f.fade > 0.002) {
    ctx.save();
    ctx.globalAlpha = f.fade;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, s.width, s.height);
    ctx.restore();
  }
}

/**
 * The picture under a layer's graphics: blurred and darkened (or, on a pale
 * backdrop, lightened) behind cards.
 */
export function drawPicture(ctx: Ctx, s: FilmStyle, image: CanvasImageSource, layer: Pick<FrameLayer, "dim" | "blur">) {
  const u = unit(s);
  ctx.save();
  if (layer.blur > 0.2) ctx.filter = `blur(${(layer.blur * u).toFixed(1)}px)`;
  ctx.drawImage(image, 0, 0, s.width, s.height);
  ctx.restore();
  if (layer.dim > 0.003) {
    ctx.save();
    ctx.globalAlpha = layer.dim;
    ctx.fillStyle = s.light ? "#f4f5f7" : "#050608";
    ctx.fillRect(0, 0, s.width, s.height);
    ctx.restore();
  }
}
