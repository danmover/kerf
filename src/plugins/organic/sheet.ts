// A creature's reference sheet: the turnaround pictures (front, side, back,
// from above) that a game pet or character is drawn from. Kerf reads the
// views off the sheet, keeps for each pixel which of the sheet's main
// colours it shows, and then (in the kernel) fits the modelled shapes to the
// views' outlines (fit.ts) and colours the surface from the views, so the
// markings land exactly where they are drawn. The model keeps its own forms:
// a round head stays round and thin ears stay thin between the views.

import type { V3 } from "./model";
import type { Field } from "./sdf";

export interface ViewImage {
  width: number;
  height: number;
  /** RGBA bytes, row by row from the top */
  data: Uint8Array | Uint8ClampedArray;
}

export type SheetView = "front" | "side" | "back" | "top";

/** The views cut out of a sheet. */
export interface SheetViews {
  /** looking at the creature's face; it faces the viewer */
  front: ViewImage;
  /** from one side, the head toward the left of the picture */
  side: ViewImage;
  back?: ViewImage;
  /** from above, head toward the bottom of the picture */
  top?: ViewImage;
}

/** A sheet as an organic model carries it: its main colours, and which of them each pixel of each view shows. */
export interface SheetData {
  /** "#rrggbb" */
  palette: string[];
  views: SheetLabels[];
}

export interface SheetLabels {
  view: SheetView;
  w: number;
  h: number;
  /** palette index per pixel, row by row from the top (255: background), run-length coded as "index*count" pairs */
  runs: string;
}

/** One view: which palette colour each pixel shows (255 off the creature), and the creature's box in pixels. */
export interface Cutout {
  w: number;
  h: number;
  lab: Uint8Array;
  /** 1 where the creature is */
  m: Uint8Array;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const BACKGROUND = 255;

// ── reading a sheet ────────────────────────────────────────────────────────

/**
 * Read a turnaround sheet: find its views, find its main colours, and label
 * every pixel with one. Throws a readable error when it is not a sheet.
 */
export function prepareSheet(sheet: ViewImage): SheetData {
  const views = findViews(sheet);
  const list = (["front", "side", "back", "top"] as const).filter((v) => views[v]).map((v) => [v, views[v]!] as const);
  const palette = paletteOf(list.map(([, img]) => img), 9);
  const pf = palette.map((p) => toHsv(p[0], p[1], p[2]));
  return {
    palette: palette.map(hex),
    views: list.map(([view, img]) => {
      const lab = new Uint8Array(img.width * img.height);
      for (let i = 0; i < lab.length; i++) lab[i] = img.data[i * 4 + 3] < 128 ? BACKGROUND : nearest(pf, img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
      return { view, w: img.width, h: img.height, runs: encodeRuns(lab) };
    }),
  };
}

/** The views of a prepared sheet, ready to line up with a model. */
export function readSheet(data: SheetData): Partial<Record<SheetView, Cutout>> {
  const out: Partial<Record<SheetView, Cutout>> = {};
  for (const v of data.views) {
    const lab = decodeRuns(v.runs, v.w * v.h);
    const m = new Uint8Array(lab.length);
    let x0 = v.w;
    let x1 = -1;
    let y0 = v.h;
    let y1 = -1;
    for (let i = 0; i < lab.length; i++) {
      if (lab[i] === BACKGROUND) continue;
      m[i] = 1;
      const x = i % v.w;
      const y = (i - x) / v.w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    if (x1 >= x0) out[v.view] = { w: v.w, h: v.h, lab, m, x0, x1, y0, y1 };
  }
  return out;
}

/**
 * The four views on a turnaround sheet like the island pet sheets: the four
 * biggest separate figures, the top row's three left to right being front,
 * side and back and the one below them the view from above. Each is cut out
 * with a margin; expression decals and specks are smaller and left out.
 */
export function findViews(sheet: ViewImage): SheetViews {
  const { width: w, height: h, data } = sheet;
  const blobs = figures(sheet).slice(0, 4);
  if (blobs.length < 2) throw new Error("Could not find the front and side views on the sheet: it needs a transparent or plain background.");
  const crop = (b: Blob): ViewImage => {
    const m = 4;
    const x0 = Math.max(0, b.x0 - m);
    const y0 = Math.max(0, b.y0 - m);
    const x1 = Math.min(w - 1, b.x1 + m);
    const y1 = Math.min(h - 1, b.y1 + m);
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const out = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        const si = (y0 + y) * w + x0 + x;
        const o = (y * cw + x) * 4;
        // only this figure's pixels: a neighbour's edge in the margin becomes background
        if (b.label[si] !== b.id) continue;
        out[o] = data[si * 4];
        out[o + 1] = data[si * 4 + 1];
        out[o + 2] = data[si * 4 + 2];
        out[o + 3] = 255;
      }
    return { width: cw, height: ch, data: out };
  };
  // the top row holds the standing views; anything clearly lower is the view from above
  const rowTop = Math.min(...blobs.map((b) => b.y0));
  const firstRow = blobs.filter((b) => b.cy < rowTop + (b.y1 - b.y0) * 1.0 && b.y0 < rowTop + (b.y1 - b.y0) * 0.5).sort((a, b) => a.cx - b.cx);
  const below = blobs.filter((b) => !firstRow.includes(b));
  const [front, side, back] = firstRow;
  if (!front || !side) throw new Error("Could not find the front and side views in the sheet's top row.");
  return { front: crop(front), side: crop(side), ...(back ? { back: crop(back) } : {}), ...(below[0] ? { top: crop(below[0]) } : {}) };
}

interface Blob {
  id: number;
  label: Int32Array;
  size: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cx: number;
  cy: number;
}

/** Every separate figure on a transparent or plain background, biggest first. */
function figures(img: ViewImage): Blob[] {
  const { width: w, height: h } = img;
  const m = foreground(img);
  const label = new Int32Array(w * h).fill(-1);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || label[s] >= 0) continue;
    const b: Blob = { id: s, label, size: 0, x0: w, x1: -1, y0: h, y1: -1, cx: 0, cy: 0 };
    label[s] = s;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      b.size++;
      b.cx += x;
      b.cy += y;
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
      if (x > 0 && m[p - 1] && label[p - 1] < 0) (label[p - 1] = s), stack.push(p - 1);
      if (x < w - 1 && m[p + 1] && label[p + 1] < 0) (label[p + 1] = s), stack.push(p + 1);
      if (y > 0 && m[p - w] && label[p - w] < 0) (label[p - w] = s), stack.push(p - w);
      if (y < h - 1 && m[p + w] && label[p + w] < 0) (label[p + w] = s), stack.push(p + w);
    }
    b.cx /= b.size;
    b.cy /= b.size;
    blobs.push(b);
  }
  return blobs.sort((a, b) => b.size - a.size);
}

/**
 * 1 where the picture is not background: opaque pixels, or on a plain
 * background everything not reached from the edges through pixels of the
 * background's colour (so a white highlight inside a figure stays in it).
 */
function foreground(img: ViewImage): Uint8Array {
  const { width: w, height: h, data } = img;
  const m = new Uint8Array(w * h);
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] < 128) transparent++;
  if (transparent > w * h * 0.05) {
    for (let i = 0; i < w * h; i++) m[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    return m;
  }
  const bg = [0, 0, 0];
  for (const [x, y] of [
    [1, 1],
    [w - 2, 1],
    [1, h - 2],
    [w - 2, h - 2],
  ])
    for (let c = 0; c < 3; c++) bg[c] += data[(y * w + x) * 4 + c] / 4;
  const like = (i: number) => Math.abs(data[i * 4] - bg[0]) + Math.abs(data[i * 4 + 1] - bg[1]) + Math.abs(data[i * 4 + 2] - bg[2]) <= 40;
  m.fill(1);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (m[i] && like(i)) {
      m[i] = 0;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
  for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < w * (h - 1)) seed(p + w);
  }
  return m;
}

/** "index*count" pairs joined by commas. */
function encodeRuns(lab: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < lab.length; ) {
    let j = i + 1;
    while (j < lab.length && lab[j] === lab[i]) j++;
    out.push(`${lab[i]}*${j - i}`);
    i = j;
  }
  return out.join(",");
}

function decodeRuns(runs: string, n: number): Uint8Array {
  const lab = new Uint8Array(n).fill(BACKGROUND);
  let at = 0;
  for (const run of runs.split(",")) {
    const k = run.indexOf("*");
    const v = Number(run.slice(0, k));
    const c = Number(run.slice(k + 1));
    if (!(c > 0) || !(v >= 0 && v <= 255)) continue;
    lab.fill(v, at, Math.min(n, at + c));
    at += c;
    if (at >= n) break;
  }
  return lab;
}

/** Pixels from each set pixel to the nearest unset one (a two-pass chamfer). */
function chamfer(m: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = m[i] ? 1e6 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) v = Math.min(v, d[i - w] + 1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 1.414);
      if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + 1.414);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) v = Math.min(v, 1);
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) v = Math.min(v, d[i + w] + 1);
      if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + 1.414);
      if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + 1.414);
      d[i] = v;
    }
  return d;
}

// ── lining the views up with a model ───────────────────────────────────────

/** How one view's pixels map to the creature's millimetres. */
interface Camera {
  cut: Cutout;
  /** pixels to the figure's outline, for how much to trust a colour seen there */
  edge: Float32Array;
  /** point (mm) to pixel (u right, v down) */
  project(x: number, y: number, z: number): [number, number];
  /** direction from the creature toward this camera */
  toward: V3;
}

/** The views lined up in millimetres: where each pixel of each view sits on the creature. */
export interface SheetFrame {
  cams: Camera[];
  /** overall sizes, mm: across (x), front to back (y), tall (z) */
  width: number;
  length: number;
  height: number;
  /** the middle of its footprint: x and y centred, z at the ground */
  origin: V3;
}

/**
 * Line the views up at `height` mm tall, X right, Y back, Z up, facing -Y,
 * with the middle of the footprint at `origin`. Every standing view is the
 * creature's height tall; the view from above spans the side view's length.
 */
export function sheetFrame(cuts: Partial<Record<SheetView, Cutout>>, height: number, origin: V3 = [0, 0, 0]): SheetFrame {
  const { front, side, back, top } = cuts;
  if (!front || !side) throw new Error("The sheet needs a front and a side view.");
  const [ox, oy, oz] = origin;
  const sF = height / (front.y1 - front.y0 + 1);
  const sS = height / (side.y1 - side.y0 + 1);
  const width = (front.x1 - front.x0 + 1) * sF;
  const length = (side.x1 - side.x0 + 1) * sS;
  const cxF = (front.x0 + front.x1 + 1) / 2;
  const cxS = (side.x0 + side.x1 + 1) / 2;
  const cam = (cut: Cutout, toward: V3, project: Camera["project"]): Camera => ({ cut, toward, project, edge: chamfer(cut.m, cut.w, cut.h) });
  const cams: Camera[] = [
    cam(front, [0, -1, 0], (x, _y, z) => [cxF + (x - ox) / sF, front.y1 + 1 - (z - oz) / sF]),
    cam(side, [1, 0, 0], (_x, y, z) => [cxS + (y - oy) / sS, side.y1 + 1 - (z - oz) / sS]),
  ];
  if (back) {
    const sB = height / (back.y1 - back.y0 + 1);
    const cxB = (back.x0 + back.x1 + 1) / 2;
    cams.push(cam(back, [0, 1, 0], (x, _y, z) => [cxB - (x - ox) / sB, back.y1 + 1 - (z - oz) / sB]));
  }
  if (top) {
    const sx = width / (top.x1 - top.x0 + 1);
    const sy = length / (top.y1 - top.y0 + 1);
    const cx = (top.x0 + top.x1 + 1) / 2;
    cams.push(cam(top, [0, 0, 1], (x, y) => [cx + (x - ox) / sx, top.y0 + (length / 2 - (y - oy)) / sy]));
  }
  return { cams, width, length, height, origin };
}

/**
 * A view's outline on a square grid of `px` mm in the creature's
 * millimetres: pixel (i, j) has its centre at (lo[0] + i·px, lo[1] + j·px).
 */
export interface Outline {
  w: number;
  h: number;
  lo: [number, number];
  px: number;
  m: Uint8Array;
}

/** The outlines to fit a model to: the front view over x and z, the side over y and z, the top over x and y. */
export function sheetOutlines(frame: SheetFrame, px: number): { front: Outline; side: Outline; top: Outline | null } {
  const { width, length, height, cams } = frame;
  const [ox, oy, oz] = frame.origin;
  const pad = px * 3;
  const grid = (ax: number, bx: number, ay: number, by: number, inside: (a: number, b: number) => boolean): Outline => {
    const w = Math.ceil((bx - ax) / px) + 1;
    const h = Math.ceil((by - ay) / px) + 1;
    const m = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) m[j * w + i] = inside(ax + i * px, ay + j * px) ? 1 : 0;
    return { w, h, lo: [ax, ay], px, m };
  };
  const hit = (c: Camera, x: number, y: number, z: number) => {
    const [u, v] = c.project(x, y, z);
    const ui = Math.floor(u);
    const vi = Math.floor(v);
    return ui >= 0 && vi >= 0 && ui < c.cut.w && vi < c.cut.h && c.cut.m[vi * c.cut.w + ui] === 1;
  };
  const topCam = cams.find((c) => c.toward[2] > 0.5);
  return {
    front: grid(ox - width / 2 - pad, ox + width / 2 + pad, oz - pad, oz + height + pad, (x, z) => hit(cams[0], x, 0, z)),
    side: grid(oy - length / 2 - pad, oy + length / 2 + pad, oz - pad, oz + height + pad, (y, z) => hit(cams[1], 0, y, z)),
    top: topCam ? grid(ox - width / 2 - pad, ox + width / 2 + pad, oy - length / 2 - pad, oy + length / 2 + pad, (x, y) => hit(topCam, x, y, 0)) : null,
  };
}

// ── colouring a shape from the views ───────────────────────────────────────

type Dist = (x: number, y: number, z: number) => number;

/**
 * Which sheet colour a surface point has: the colour of the view that sees
 * it most squarely (the front view winning ties), skipping views the shape
 * itself blocks, so a cheek hidden behind an ear in one view is coloured
 * from another. Where no view looks at it squarely enough to trust (under
 * the chin, deep in a crease), the model's own colour (`own`, a sheet
 * palette index) is kept when it has one.
 */
export function sheetClassifier(frame: SheetFrame, dist: Dist, cell: number): (p: V3, n: V3, own?: number) => number {
  const { cams, width, length, height } = frame;
  // every view, plus the side view again for the other flank
  const looks = cams.map((c) => ({ c, mirror: false }));
  looks.push({ c: cams[1], mirror: true });
  const reach = Math.max(width, length, height);
  return (p, n, own = -1) => {
    let best: (typeof looks)[number] | null = null;
    let bestScore = -Infinity;
    let bestFacing = 0;
    let fallback = looks[0];
    let fallbackF = -Infinity;
    for (const look of looks) {
      const t: V3 = look.mirror ? [-look.c.toward[0], look.c.toward[1], look.c.toward[2]] : look.c.toward;
      const facing = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
      if (facing > fallbackF) {
        fallbackF = facing;
        fallback = look;
      }
      // the view from above only for surfaces that really face up: elsewhere it shows what overhangs them
      const isTop = look.c.toward[2] > 0.5;
      if (facing <= (isTop ? 0.8 : 0.2)) continue;
      // a colour right at a view's outline (a nose tip seen from the side) is a poor guide for points beside it
      const q: V3 = look.mirror ? [-p[0], p[1], p[2]] : p;
      const [u, v] = look.c.project(q[0], q[1], q[2]);
      const ui = Math.min(look.c.cut.w - 1, Math.max(0, Math.floor(u)));
      const vi = Math.min(look.c.cut.h - 1, Math.max(0, Math.floor(v)));
      const trust = Math.min(1, (look.c.edge[vi * look.c.cut.w + ui] + 0.5) / 8);
      // the front view is the one drawn with the most care: it wins ties
      const score = facing * facing * trust * (look.c.toward[1] < -0.5 ? 1.25 : isTop ? 0.6 : 1);
      if (score <= bestScore) continue;
      // march toward the camera in steps as long as the free space allows
      let seen = true;
      for (let s = cell * 3; s < reach; ) {
        const d = dist(p[0] + t[0] * s, p[1] + t[1] * s, p[2] + t[2] * s);
        if (d < -cell) {
          seen = false;
          break;
        }
        s += Math.max(cell * 1.5, d);
      }
      if (seen) {
        best = look;
        bestScore = score;
        bestFacing = facing;
      }
    }
    if (own >= 0 && bestFacing < 0.6) return own;
    const look = best ?? fallback;
    const q: V3 = look.mirror ? [-p[0], p[1], p[2]] : p;
    const [u, v] = look.c.project(q[0], q[1], q[2]);
    const cut = look.c.cut;
    const ui = Math.min(cut.w - 1, Math.max(0, Math.floor(u)));
    const vi = Math.min(cut.h - 1, Math.max(0, Math.floor(v)));
    // step inward to the nearest pixel of the creature, so edges do not pick up the background
    for (let r = 0; r <= 4; r++)
      for (let dv = -r; dv <= r; dv++)
        for (let du = -r; du <= r; du++) {
          if (Math.max(Math.abs(du), Math.abs(dv)) !== r) continue;
          const uu = ui + du;
          const vv = vi + dv;
          if (uu < 0 || vv < 0 || uu >= cut.w || vv >= cut.h || !cut.m[vv * cut.w + uu]) continue;
          return cut.lab[vv * cut.w + uu];
        }
    return own >= 0 ? own : 0;
  };
}

/**
 * A model's field coloured from the sheet: its distance, and at each surface
 * point the sheet colour (`own` gives the model's own colour there, as a
 * sheet palette index, for where the views cannot tell).
 */
export function sheetField(field: Field, frame: SheetFrame, palette: string[], cell: number, own?: (x: number, y: number, z: number) => number): Field {
  const classify = sheetClassifier(frame, field.dist, cell);
  const dist = field.dist;
  // colours go by a broad normal, so small ledges do not catch another view
  const wide = Math.max(cell, frame.height * 0.025);
  // neighbouring triangles share the answer: one per little cube of space
  const q = cell * 1.5;
  const memo = new Map<string, number>();
  return {
    ...field,
    sample(x, y, z) {
      const d = dist(x, y, z);
      if (d > cell * 2) return { d, color: 0, item: 0 };
      const key = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
      let color = memo.get(key);
      if (color === undefined) {
        const gx = dist(x + wide, y, z) - dist(x - wide, y, z);
        const gy = dist(x, y + wide, z) - dist(x, y - wide, z);
        const gz = dist(x, y, z + wide) - dist(x, y, z - wide);
        const l = Math.hypot(gx, gy, gz) || 1;
        color = classify([x, y, z], [gx / l, gy / l, gz / l], own ? own(x, y, z) : -1);
        memo.set(key, color);
      }
      return { d, color, item: 0 };
    },
    palette,
    detailAmp: 0,
    tidy: (frame.height * 0.045) ** 2,
  };
}

// ── colours ────────────────────────────────────────────────────────────────

const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** The sheet colour nearest to `color` ("#rrggbb"), as an index into `palette`. */
export function nearestColour(palette: string[], color: string): number {
  const rgb = (h: string) => {
    const v = parseInt(h.slice(1, 7), 16) || 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255] as const;
  };
  const [r, g, b] = rgb(color);
  return nearest(
    palette.map((h) => toHsv(...rgb(h))),
    r,
    g,
    b,
  );
}

function nearest(pf: [number, number, number][], r: number, g: number, b: number): number {
  const [h, sat, val] = toHsv(r, g, b);
  let best = 0;
  let bd = Infinity;
  pf.forEach(([ph, ps, pv], i) => {
    const dh = Math.min(Math.abs(h - ph), 360 - Math.abs(h - ph)) / 60;
    // hue counts only as far as both colours have one; brightness on a log scale, so shading matters little
    const d = (dh * Math.min(sat, ps)) ** 2 * 4 + (sat - ps) ** 2 * 3 + Math.log((val + 0.04) / (pv + 0.04)) ** 2 * 0.6;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/**
 * The main colours of the figures (sRGB). Pixels are grouped by hue and
 * saturation, with brightness counting for less, so a colour lit on one side
 * and shaded on the other stays one colour while dark brown and orange stay
 * apart. Each group's colour is its median.
 */
function paletteOf(imgs: ViewImage[], k: number): number[][] {
  const px: number[][] = [];
  const feat: number[][] = [];
  for (const img of imgs) {
    const { width: w, height: h, data } = img;
    const on = (i: number) => data[i * 4 + 3] >= 128;
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 6000)));
    for (let y = 1; y < h - 1; y += step)
      for (let x = 1; x < w - 1; x += step) {
        const i = y * w + x;
        // skip the anti-aliased rim against the background
        if (!on(i) || !on(i - 1) || !on(i + 1) || !on(i - w) || !on(i + w)) continue;
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        px.push([r, g, b]);
        feat.push(colourFeature(r, g, b));
      }
  }
  if (!px.length) return [[200, 200, 200]];
  // farthest-point seeding (deterministic), then k-means
  const centres: number[][] = [feat[0].slice()];
  const dd = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const d2 = feat.map((f) => dd(f, feat[0]));
  while (centres.length < Math.min(k, feat.length)) {
    let far = 0;
    for (let i = 1; i < feat.length; i++) if (d2[i] > d2[far]) far = i;
    if (d2[far] < 18 * 18) break;
    centres.push(feat[far].slice());
    for (let i = 0; i < feat.length; i++) d2[i] = Math.min(d2[i], dd(feat[i], feat[far]));
  }
  const assign = new Int32Array(feat.length);
  for (let it = 0; it < 15; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    feat.forEach((f, i) => {
      let best = 0;
      let bd = Infinity;
      centres.forEach((c, j) => {
        const d = dd(f, c);
        if (d < bd) {
          bd = d;
          best = j;
        }
      });
      assign[i] = best;
      for (let ch = 0; ch < 3; ch++) sum[best][ch] += f[ch];
      sum[best][3]++;
    });
    centres.forEach((c, j) => {
      if (sum[j][3]) for (let ch = 0; ch < 3; ch++) c[ch] = sum[j][ch] / sum[j][3];
    });
  }
  // groups that are one colour lit and shaded (same hue and saturation, brightness within 2.4x) become one
  const group = centres.map((_, j) => j);
  const root = (j: number): number => (group[j] === j ? j : (group[j] = root(group[j])));
  const hsv = centres.map((_, j) => {
    const mine = px.filter((_, i) => assign[i] === j);
    const avg = [0, 1, 2].map((ch) => mine.reduce((a, p) => a + p[ch], 0) / Math.max(1, mine.length));
    return toHsv(avg[0], avg[1], avg[2]);
  });
  for (let a = 0; a < centres.length; a++)
    for (let b = a + 1; b < centres.length; b++) {
      const [ha, sa, va] = hsv[a];
      const [hb, sb, vb] = hsv[b];
      const dh = Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb));
      const grey = sa < 0.12 && sb < 0.12;
      if ((grey || (dh < 12 && Math.abs(sa - sb) < 0.12)) && Math.max(va, vb) / Math.max(0.02, Math.min(va, vb)) < 2.4) group[root(b)] = root(a);
    }
  // each colour: its median, as the picture shows it overall (the renderer adds its own light and shade)
  const out: number[][] = [];
  for (let j = 0; j < centres.length; j++) {
    if (root(j) !== j) continue;
    const mine = px.filter((_, i) => root(assign[i]) === j).sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
    if (mine.length < px.length * 0.002) continue;
    out.push(mine[Math.floor(mine.length * 0.5)]);
  }
  return out.length ? out : [[200, 200, 200]];
}

function toHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx > 0 ? d / mx : 0, mx / 255];
}

/** Hue and saturation (strong) with brightness (weak), for grouping a picture's colours. */
function colourFeature(r: number, g: number, b: number): number[] {
  const l = (r + g + b) / 3 + 8;
  return [((r - g) / l) * 40, ((r + g - 2 * b) / 2 / l) * 40, Math.log(l) * 22];
}
