// Views that show less than the whole part: broken views (a long part's
// plain middle taken out and the ends closed up), crop views (only what lies
// inside a rectangle) and the freehand and zigzag lines that mark where a
// view stops. View space is model millimetres with y up; the inking side is
// sheet millimetres with y down.

import type { Edge2, ViewResult } from "../kernel/drawing";
import type { BreakSpec } from "./spec";
import type { Bend, Frame, Ink } from "./sheet";

type P2 = [number, number];
export type Rect = [number, number, number, number];

// ---------- broken views ----------

/** The bands a view loses to breaks, along one of its axes (view space, sorted), and the gap each leaves. */
export interface Bands {
  axis: 0 | 1;
  list: { lo: number; hi: number; gap: number }[];
}

/** The breaks that lie along a view's x or y axis, as bands in view space; null when none does. */
export function viewBands(breaks: BreakSpec[], frame: Frame, ext: Rect): Bands | null {
  let axis: 0 | 1 | null = null;
  const list: Bands["list"] = [];
  for (const b of breaks) {
    for (const k of [0, 1] as const) {
      const c = (k ? frame.y : frame.x)[b.axis];
      if (Math.abs(c) < 0.999 || (axis !== null && axis !== k)) continue;
      axis = k;
      const lo = Math.max(Math.min(c * b.from, c * b.to), ext[k]);
      const hi = Math.min(Math.max(c * b.from, c * b.to), ext[k + 2]);
      if (hi - lo > 1e-6) list.push({ lo, hi, gap: 0 });
    }
  }
  if (axis === null || !list.length) return null;
  list.sort((a, b) => a.lo - b.lo);
  // overlapping breaks are one
  const merged: Bands["list"] = [];
  for (const b of list) {
    const last = merged[merged.length - 1];
    if (last && b.lo <= last.hi) last.hi = Math.max(last.hi, b.hi);
    else merged.push({ ...b });
  }
  // the gap left between the break lines grows with what is left of the view
  const removed = merged.reduce((t, b) => t + b.hi - b.lo, 0);
  const kept = Math.max(ext[axis + 2] - ext[axis] - removed, 1);
  for (const b of merged) b.gap = Math.min(Math.max(0.07 * kept, 1.5), b.hi - b.lo);
  return { axis, list: merged };
}

/** A view point moved as its view closes up: past a band it moves back, inside one it is squeezed into the gap. */
export function warpPoint(b: Bands, p: P2): P2 {
  const x = p[b.axis];
  let shift = 0;
  for (const s of b.list) {
    if (x >= s.hi) shift += s.hi - s.lo - s.gap;
    else if (x > s.lo) {
      shift += (x - s.lo) * (1 - s.gap / (s.hi - s.lo));
      break;
    } else break;
  }
  const out: P2 = [p[0], p[1]];
  out[b.axis] = x - shift;
  return out;
}

/** Is a view point inside a band (the part of the view that is taken out)? */
export function inBand(b: Bands, p: P2): boolean {
  return b.list.some((s) => p[b.axis] > s.lo + 1e-6 && p[b.axis] < s.hi - 1e-6);
}

export function warpExtents(b: Bands, e: Rect): Rect {
  const out: Rect = [...e];
  out[b.axis + 2] = warpPoint(b, [e[2], e[3]])[b.axis];
  return out;
}

/** The sheet-space bend for a view placed at origin with scale. */
export function sheetBend(b: Bands, origin: P2, scale: number): Bend {
  // sheet x grows with view u; sheet y shrinks as view v grows
  const sign = b.axis ? -1 : 1;
  const base = b.axis ? -origin[1] : origin[0];
  return { axis: b.axis, sign, bands: b.list.map((s) => [base + s.lo * scale, base + s.hi * scale, s.gap * scale]) };
}

/** How far the visible outline reaches across a view at a value along the axis: [min, max] of the other coordinate. */
export function reachAcross(edges: Edge2[], axis: 0 | 1, at: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const hit = (v: number) => {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  };
  const o = axis ? 0 : 1;
  const seg = (a: P2, b: P2) => {
    if ((a[axis] - at) * (b[axis] - at) > 0 || a[axis] === b[axis]) return;
    hit(a[o] + ((at - a[axis]) / (b[axis] - a[axis])) * (b[o] - a[o]));
  };
  for (const e of edges) {
    if (!e.vis) continue;
    const g = e.g;
    if (g.t === "L") seg([g.p[0], g.p[1]], [g.p[2], g.p[3]]);
    else if (g.t === "P") for (let k = 0; k + 3 < g.p.length; k += 2) seg([g.p[k], g.p[k + 1]], [g.p[k + 2], g.p[k + 3]]);
    else {
      const d = (at - g.c[axis]) / g.r;
      if (Math.abs(d) > 1) continue;
      const base = axis ? Math.asin(d) : Math.acos(d);
      for (const a of axis ? [base, Math.PI - base] : [base, -base]) {
        let t = a;
        while (t < g.a0) t += Math.PI * 2;
        while (t > g.a0 + Math.PI * 2) t -= Math.PI * 2;
        if (t <= g.a1 + 1e-9) hit(g.c[o] + g.r * (axis ? Math.cos(t) : Math.sin(t)));
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** A thin break line with one zigzag in its middle (ISO 128-2), from a to b on the sheet. */
export function zigzag(ink: Ink, a: P2, b: P2) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-6) return;
  const t: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const n: P2 = [-t[1], t[0]];
  const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const z = Math.min(1.6, L / 6);
  const at = (k: number, h: number): number[] => [m[0] + t[0] * k + n[0] * h, m[1] + t[1] * k + n[1] * h];
  ink.poly([...a, ...at(-z, 0), ...at(-z / 3, z), ...at(z / 3, -z), ...at(z, 0), ...b], "thin");
}

/** A continuous narrow freehand line (ISO 128-2 type 01.1) from a to b on the sheet: a gentle wave. */
export function freehand(ink: Ink, a: P2, b: P2) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-6) return;
  const t: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const n: P2 = [-t[1], t[0]];
  const steps = Math.max(8, Math.ceil(L / 0.8));
  const p: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = (i / steps) * L;
    const h = 0.45 * Math.sin((k / 7) * Math.PI * 2) + 0.2 * Math.sin((k / 3.1) * Math.PI * 2 + 1);
    p.push(a[0] + t[0] * k + n[0] * h, a[1] + t[1] * k + n[1] * h);
  }
  ink.poly(p, "thin");
}

/** A freehand boundary round a circle on the sheet (a broken-out section's edge), kept inside the view's outline box. */
export function freehandCircle(ink: Ink, cx: number, cy: number, r: number, within?: Rect) {
  const n = Math.max(48, Math.ceil((2 * Math.PI * r) / 0.8));
  const p: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = r + Math.min(0.35, r * 0.03) * (Math.sin(5 * a) + 0.6 * Math.sin(11 * a + 1));
    p.push(cx + k * Math.cos(a), cy - k * Math.sin(a));
  }
  for (const q of within ? clipPolylineToRect(p, within) : [p]) ink.poly(q, "thin");
}

/** The pieces of a polyline (flat list) inside a rectangle. */
export function clipPolylineToRect(p: number[], rect: Rect): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 3 < p.length; i += 2) {
    const a: P2 = [p[i], p[i + 1]];
    const b: P2 = [p[i + 2], p[i + 3]];
    const t = clipSeg(a, b, rect);
    if (!t) {
      flush();
      continue;
    }
    if (t[0] > 1e-9) flush();
    if (!cur.length) cur.push(a[0] + (b[0] - a[0]) * t[0], a[1] + (b[1] - a[1]) * t[0]);
    cur.push(a[0] + (b[0] - a[0]) * t[1], a[1] + (b[1] - a[1]) * t[1]);
    if (t[1] < 1 - 1e-9) flush();
  }
  flush();
  return out;
}

// ---------- crop views ----------

/** The part of segment ab inside rect, as parameters, or null (Liang–Barsky). */
export function clipSeg(a: P2, b: P2, r: Rect): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const d: P2 = [b[0] - a[0], b[1] - a[1]];
  const edges: [number, number][] = [
    [-d[0], a[0] - r[0]],
    [d[0], r[2] - a[0]],
    [-d[1], a[1] - r[1]],
    [d[1], r[3] - a[1]],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-15) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return t1 - t0 > 1e-12 ? [t0, t1] : null;
}

/** Where geometry runs out of the crop on each side (0 left, 1 bottom, 2 right, 3 top): the range along that side, in view space. */
export type CropCuts = ([number, number] | null)[];

function arcPts(c: P2, r: number, a0: number, a1: number): number[] {
  const n = Math.max(12, Math.min(720, Math.ceil(((a1 - a0) * r) / Math.max(r * 0.02, 0.05))));
  const p: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    p.push(c[0] + r * Math.cos(a), c[1] + r * Math.sin(a));
  }
  return p;
}

/** Clips a view's edges and cut faces to a rectangle, noting where the outline was cut. */
export function cropResult(res: ViewResult, rect: Rect): { result: ViewResult; cuts: CropCuts } {
  const cuts: CropCuts = [null, null, null, null];
  const note = (p: P2) => {
    const eps = 1e-6 * Math.max(1, rect[2] - rect[0], rect[3] - rect[1]);
    const sides: [number, number, number][] = [
      [0, p[0] - rect[0], p[1]],
      [1, p[1] - rect[1], p[0]],
      [2, rect[2] - p[0], p[1]],
      [3, rect[3] - p[1], p[0]],
    ];
    for (const [k, d, along] of sides) {
      if (Math.abs(d) > eps) continue;
      const c = cuts[k];
      cuts[k] = c ? [Math.min(c[0], along), Math.max(c[1], along)] : [along, along];
    }
  };
  const poly = (p: number[], vis: boolean): number[][] => {
    const out: number[][] = [];
    let cur: number[] = [];
    const flush = () => {
      if (cur.length >= 4) out.push(cur);
      cur = [];
    };
    for (let i = 0; i + 3 < p.length; i += 2) {
      const a: P2 = [p[i], p[i + 1]];
      const b: P2 = [p[i + 2], p[i + 3]];
      const t = clipSeg(a, b, rect);
      if (!t) {
        flush();
        continue;
      }
      const s: P2 = [a[0] + (b[0] - a[0]) * t[0], a[1] + (b[1] - a[1]) * t[0]];
      const e: P2 = [a[0] + (b[0] - a[0]) * t[1], a[1] + (b[1] - a[1]) * t[1]];
      if (t[0] > 1e-9) {
        flush();
        if (vis) note(s);
      }
      if (!cur.length) cur.push(...s);
      cur.push(...e);
      if (t[1] < 1 - 1e-9) {
        if (vis) note(e);
        flush();
      }
    }
    flush();
    return out;
  };
  const clipEdges = (edges: Edge2[]): Edge2[] => {
    const out: Edge2[] = [];
    for (const e of edges) {
      const g = e.g;
      if (g.t === "A") {
        // whole arcs inside stay arcs
        if (g.c[0] - g.r >= rect[0] && g.c[0] + g.r <= rect[2] && g.c[1] - g.r >= rect[1] && g.c[1] + g.r <= rect[3]) {
          out.push(e);
          continue;
        }
        for (const p of poly(arcPts(g.c, g.r, g.a0, g.a1), e.vis)) out.push({ part: e.part, vis: e.vis, g: { t: "P", p } });
        continue;
      }
      const pts = g.t === "L" ? [...g.p] : g.p;
      for (const p of poly(pts, e.vis)) out.push({ part: e.part, vis: e.vis, g: p.length === 4 ? { t: "L", p: [p[0], p[1], p[2], p[3]] } : { t: "P", p } });
    }
    return out;
  };
  const clipLoops = (h: ViewResult["hatch"]) => h.map((x) => ({ part: x.part, loops: x.loops.map((l) => clipLoop(l, rect)).filter((l) => l.length >= 6) })).filter((x) => x.loops.length);
  const result: ViewResult = {
    ...res,
    edges: clipEdges(res.edges),
    hatch: clipLoops(res.hatch),
    cutaways: res.cutaways?.map((c) => ({ edges: clipEdges(c.edges), hatch: clipLoops(c.hatch) })),
  };
  return { result, cuts };
}

/** A closed loop (flat list) clipped to a rectangle (Sutherland–Hodgman). */
function clipLoop(l: number[], r: Rect): number[] {
  let pts: P2[] = [];
  for (let i = 0; i + 1 < l.length; i += 2) pts.push([l[i], l[i + 1]]);
  const planes: [(p: P2) => number, number][] = [
    [(p) => p[0], r[0]],
    [(p) => -p[0], -r[2]],
    [(p) => p[1], r[1]],
    [(p) => -p[1], -r[3]],
  ];
  for (const [f, c] of planes) {
    const out: P2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ia = f(a) >= c;
      const ib = f(b) >= c;
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (c - f(a)) / (f(b) - f(a));
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    pts = out;
    if (!pts.length) break;
  }
  return pts.flat();
}

/** A crop box's rectangle in a view. */
export function cropRect(box: [[number, number, number], [number, number, number]], frame: Frame): Rect {
  const e: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  const [a, b] = box;
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
    const u = p[0] * frame.x[0] + p[1] * frame.x[1] + p[2] * frame.x[2];
    const v = p[0] * frame.y[0] + p[1] * frame.y[1] + p[2] * frame.y[2];
    e[0] = Math.min(e[0], u);
    e[1] = Math.min(e[1], v);
    e[2] = Math.max(e[2], u);
    e[3] = Math.max(e[3], v);
  }
  return e;
}
