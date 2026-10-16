// Silkscreen: part outlines, pin-1, plus and band marks, each part's
// reference and value ("R4 10k"), the board name and a small Kerf credit.
// Labels go beside their part where there is room, inside the outline when
// there isn't, and never on a pad (the board house would cut them off there).
// Bottom-side parts get theirs on the bottom silkscreen, written mirrored so
// they read right from below. The Gerber writer and the preview both draw
// from this.

import { placedHoles, placedPads } from "./board";
import { textBox, textStrokes } from "./font";
import { Buckets, bodyShape, boxesTouch, circle, convex, edgeDist, grow, padShape, partXf, shapeBox, shapeDist, shapeGap, type BBox, type Pt, type Shape } from "./geom";
import type { BoardSpec, Layer, PlacedPart } from "./types";

export const SILK_LINE = 0.15;
export const SILK_TEXT = 1.0;
const NAME_TEXT = 2.0;
const NAME_LINE = 0.25;
const BAND_LINE = 0.5;
/** silk stays this far from pad copper (mask opening plus the board house's silk-to-pad rule) */
const PAD_KEEP = 0.2;
const EDGE_KEEP = 0.2;

export interface SilkLine {
  pts: Pt[];
  w: number;
}

export interface SilkLabel {
  ref: string;
  lines: string[];
  x: number;
  y: number;
  size: number;
  rot: number;
  box: BBox;
}

export interface SilkLayer {
  lines: SilkLine[];
  dots: { x: number; y: number; d: number }[];
  labels: SilkLabel[];
}

export type Silk = Record<Layer, SilkLayer>;

const sideOf = (p: PlacedPart): Layer => (p.side === "bottom" ? "B" : "F");

export function boardSilk(spec: BoardSpec): Silk {
  const silk: Silk = { F: { lines: [], dots: [], labels: [] }, B: { lines: [], dots: [], labels: [] } };
  const pads = placedPads(spec);
  const holes = placedHoles(spec);
  const keep: Shape[] = [...pads.map((p) => padShape(p, PAD_KEEP)), ...holes.map((h) => circle(h.x, h.y, h.d / 2 + PAD_KEEP))];
  const keepIdx = new Buckets<Shape>(spec.w, spec.h, 3);
  for (const k of keep) keepIdx.add(shapeBox(k), k);
  const blocked = (x: number, y: number, r: number) => {
    if (edgeDist(spec, x, y) < EDGE_KEEP + r) return true;
    for (const k of keepIdx.near([x - r, y - r, x + r, y + r])) if (shapeDist(k, x, y) < r) return true;
    return false;
  };

  // outlines
  for (const part of spec.parts) {
    const L = silk[sideOf(part)];
    const body = bodyShape(part);
    if (body.k === "cap") {
      const pts: Pt[] = [];
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * 2 * Math.PI;
        pts.push([body.ax + body.r * Math.cos(a), body.ay + body.r * Math.sin(a)]);
      }
      L.lines.push({ pts, w: SILK_LINE });
    } else {
      const p = body.p;
      L.lines.push({ pts: [[p[0], p[1]], [p[2], p[3]], [p[4], p[5]], [p[6], p[7]], [p[0], p[1]]], w: SILK_LINE });
    }
    const mark = part.fp.mark;
    if (!mark) continue;
    const xf = partXf(part);
    const [mx, my] = xf(mark.x, mark.y);
    if (mark.kind === "pin1") {
      const [x, y] = clearSpot(mx, my, 0.3, blocked, pads.filter((p) => p.ref === part.ref));
      L.dots.push({ x, y, d: 0.5 });
    } else if (mark.kind === "plus") {
      const [x, y] = clearSpot(mx, my, 0.7, blocked, pads.filter((p) => p.ref === part.ref));
      L.lines.push(...textStrokes("+", x, y, { size: 1.4, mirror: part.side === "bottom" }).map((pts) => ({ pts, w: SILK_LINE })));
    } else {
      // a band across the body at the mark, square to the body's long side
      const b = part.fp.body;
      if (b.shape === "rect") {
        const alongX = Math.abs(b.x1 - b.x0) >= Math.abs(b.y1 - b.y0);
        const inset = BAND_LINE / 2 + 0.05;
        const a = alongX ? xf(mark.x, Math.min(b.y0, b.y1) + inset) : xf(Math.min(b.x0, b.x1) + inset, mark.y);
        const c = alongX ? xf(mark.x, Math.max(b.y0, b.y1) - inset) : xf(Math.max(b.x0, b.x1) - inset, mark.y);
        L.lines.push({ pts: [a, c], w: BAND_LINE });
      } else L.dots.push({ x: mx, y: my, d: 0.6 });
    }
  }

  // labels
  const bodies = spec.parts.map((p) => ({ part: p, shape: bodyShape(p, 0.1), box: shapeBox(bodyShape(p)) }));
  const placed: Record<Layer, BBox[]> = { F: [], B: [] };
  const fits = (box: BBox, side: Layer, ownRef?: string): number => {
    // -1: not allowed; otherwise a penalty for sitting on bodies
    const [x0, y0, x1, y1] = box;
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ])
      if (edgeDist(spec, x, y) < EDGE_KEEP + 0.1) return -1;
    const rect = convex([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]);
    for (const k of keepIdx.near(box)) if (shapeGap(rect, k) < 0.05) return -1;
    for (const b of placed[side]) if (boxesTouch(grow(b, 0.25), box)) return -1;
    let pen = 0;
    for (const b of bodies) {
      if (sideOf(b.part) !== side || !boxesTouch(b.box, box)) continue;
      if (shapeGap(b.shape, rect) < 0) pen += b.part.ref === ownRef ? 1 : 6;
    }
    return pen;
  };
  const order = [...spec.parts].sort((a, b) => area(shapeBox(bodyShape(b))) - area(shapeBox(bodyShape(a))));
  for (const part of order) {
    const side = sideOf(part);
    const mirror = side === "B";
    const own = pads.filter((p) => p.ref === part.ref).map((p) => shapeBox(padShape(p)));
    const bb = shapeBox(bodyShape(part));
    const ext = own.reduce<BBox>((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], bb);
    const tall = bb[3] - bb[1] > (bb[2] - bb[0]) * 1.2;
    const variants: { lines: string[]; size: number }[] = [
      { lines: [`${part.ref} ${part.value}`.trim()], size: SILK_TEXT },
      { lines: [part.ref, part.value].filter(Boolean), size: SILK_TEXT },
      { lines: [`${part.ref} ${part.value}`.trim()], size: 0.8 },
      { lines: [part.ref, part.value].filter(Boolean), size: 0.8 },
    ];
    let best: { score: number; label: SilkLabel } | undefined;
    variants.forEach((v, vi) => {
      for (const rot of tall ? [90, 0] : [0, 90]) {
        const box0 = labelBox(v.lines, v.size, rot, mirror);
        const w = box0[2] - box0[0];
        const h = box0[3] - box0[1];
        const cx = (ext[0] + ext[2]) / 2;
        const cy = (ext[1] + ext[3]) / 2;
        const gap = 0.35;
        const spots: [number, number][] = [
          [cx, ext[3] + gap + h / 2],
          [cx, ext[1] - gap - h / 2],
          [ext[2] + gap + w / 2, cy],
          [ext[0] - gap - w / 2, cy],
          [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2],
          [ext[0] + w / 2, ext[3] + gap + h / 2],
          [ext[2] - w / 2, ext[3] + gap + h / 2],
          [ext[0] + w / 2, ext[1] - gap - h / 2],
          [ext[2] - w / 2, ext[1] - gap - h / 2],
          [ext[2] + gap + w / 2, ext[3] - h / 2],
          [ext[2] + gap + w / 2, ext[1] + h / 2],
          [ext[0] - gap - w / 2, ext[3] - h / 2],
          [ext[0] - gap - w / 2, ext[1] + h / 2],
        ];
        spots.forEach(([x, y], si) => {
          const box: BBox = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
          const pen = fits(box, side, part.ref);
          if (pen < 0) return;
          const score = pen + vi * 2 + si * 0.05 + (rot === (tall ? 90 : 0) ? 0 : 0.5);
          if (!best || score < best.score) {
            // the label box was built round (0, 0); shift its anchor along with it
            const ax = x - (box0[0] + box0[2]) / 2;
            const ay = y - (box0[1] + box0[3]) / 2;
            best = { score, label: { ref: part.ref, lines: v.lines, x: ax, y: ay, size: v.size, rot, box } };
          }
        });
      }
    });
    if (!best) {
      // nowhere clean: on the body, whatever it overlaps (clipping still keeps it off the pads)
      const v = variants[3];
      const box0 = labelBox(v.lines, v.size, tall ? 90 : 0, mirror);
      const x = (bb[0] + bb[2]) / 2;
      const y = (bb[1] + bb[3]) / 2;
      best = { score: 99, label: { ref: part.ref, lines: v.lines, x, y, size: v.size, rot: tall ? 90 : 0, box: [box0[0] + x, box0[1] + y, box0[2] + x, box0[3] + y] } };
    }
    const lab = best.label;
    placed[side].push(lab.box);
    silk[side].labels.push(lab);
    silk[side].lines.push(...labelStrokes(lab, mirror).map((pts) => ({ pts, w: SILK_LINE })));
  }

  // board name and credit, top side, somewhere clear (near the top left first)
  const name = spec.name.trim();
  const credit = "Kerf";
  let named = false;
  for (const size of [NAME_TEXT, 1.6, 1.2, 1.0]) {
    const nb = textBox(name, size);
    const cb = textBox(credit, SILK_TEXT);
    const w = nb.w + 1.2 + cb.w;
    const h = nb.up + nb.down;
    const spots: [number, number][] = [];
    for (let y = spec.h - 1.5 - h / 2; y > h / 2 + 1; y -= 0.5) for (let x = 1.5 + w / 2; x < spec.w - w / 2 - 1.5; x += 0.5) spots.push([x, y]);
    spots.sort((a, b) => a[0] + (spec.h - a[1]) * 0.6 - (b[0] + (spec.h - b[1]) * 0.6));
    for (const [x, y] of spots) {
      const box: BBox = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
      if (fits(box, "F") !== 0) continue;
      const left = box[0];
      const base = y - h / 2 + nb.down;
      silk.F.lines.push(...textStrokes(name, left, base, { size, anchor: "left" }).map((pts) => ({ pts, w: size >= 1.6 ? NAME_LINE : SILK_LINE })));
      silk.F.lines.push(...textStrokes(credit, left + nb.w + 1.2, base, { size: SILK_TEXT, anchor: "left" }).map((pts) => ({ pts, w: SILK_LINE })));
      placed.F.push(box);
      named = true;
      break;
    }
    if (named) break;
  }

  for (const t of spec.texts ?? []) silk[t.side].lines.push(...textStrokes(t.text, t.x, t.y, { size: t.size, mirror: t.side === "B" }).map((pts) => ({ pts, w: Math.max(SILK_LINE, t.size * 0.15) })));

  // keep every stroke off pads, holes and the edge
  for (const side of ["F", "B"] as Layer[]) {
    silk[side].lines = silk[side].lines.flatMap((l) => clipLine(l, blocked));
    silk[side].dots = silk[side].dots.filter((d) => !blocked(d.x, d.y, d.d / 2));
  }
  return silk;
}

const area = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);

/** The box of a (possibly two-line) label drawn round (0, 0). */
function labelBox(lines: string[], size: number, rot: number, mirror: boolean): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pts of labelStrokes({ ref: "", lines, x: 0, y: 0, size, rot, box: [0, 0, 0, 0] }, mirror).flat()) {
    x0 = Math.min(x0, pts[0]);
    x1 = Math.max(x1, pts[0]);
    y0 = Math.min(y0, pts[1]);
    y1 = Math.max(y1, pts[1]);
  }
  const s = SILK_LINE / 2;
  return [x0 - s, y0 - s, x1 + s, y1 + s];
}

export function labelStrokes(l: SilkLabel, mirror: boolean): Pt[][] {
  const pitch = l.size * 1.5;
  const a = (l.rot * Math.PI) / 180;
  const out: Pt[][] = [];
  l.lines.forEach((t, i) => {
    // stack lines downwards in the text's own frame
    const off = ((l.lines.length - 1) / 2 - i) * pitch;
    const dx = -Math.sin(a) * off * (mirror ? -1 : 1);
    const dy = Math.cos(a) * off;
    out.push(...textStrokes(t, l.x + dx, l.y + dy, { size: l.size, rot: l.rot, mirror }));
  });
  return out;
}

/** Moves a mark out from under its part's pads (and other copper) if it landed on one. */
function clearSpot(x: number, y: number, r: number, blocked: (x: number, y: number, r: number) => boolean, own: { x: number; y: number }[]): Pt {
  if (!blocked(x, y, r)) return [x, y];
  let near = own[0];
  for (const p of own) if (Math.hypot(p.x - x, p.y - y) < Math.hypot(near.x - x, near.y - y)) near = p;
  if (!near) return [x, y];
  let ux = x - near.x;
  let uy = y - near.y;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  for (let d = 0.1; d <= 3; d += 0.1) if (!blocked(x + ux * d, y + uy * d, r)) return [x + ux * d, y + uy * d];
  return [x, y];
}

/** Cuts a polyline where it would run over a keep-out. */
function clipLine(l: SilkLine, blocked: (x: number, y: number, r: number) => boolean): SilkLine[] {
  const r = l.w / 2;
  const out: SilkLine[] = [];
  let cur: Pt[] = [];
  const flush = () => {
    if (cur.length > 1) out.push({ pts: cur, w: l.w });
    cur = [];
  };
  const step = 0.05;
  for (let k = 1; k < l.pts.length; k++) {
    const [ax, ay] = l.pts[k - 1];
    const [bx, by] = l.pts[k];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / step));
    const at = (t: number): Pt => [ax + (bx - ax) * t, ay + (by - ay) * t];
    const bad = (t: number) => blocked(ax + (bx - ax) * t, ay + (by - ay) * t, r);
    let prevT = 0;
    let prevBad = bad(0);
    if (!prevBad && !cur.length) cur.push(at(0));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const b = bad(t);
      if (b !== prevBad) {
        // find the edge of the keep-out between the two samples
        let lo = prevT;
        let hi = t;
        for (let it = 0; it < 8; it++) {
          const mid = (lo + hi) / 2;
          if (bad(mid) === prevBad) lo = mid;
          else hi = mid;
        }
        if (prevBad) cur.push(at(hi));
        else {
          cur.push(at(lo));
          flush();
        }
      }
      prevBad = b;
      prevT = t;
    }
    if (!prevBad) cur.push(at(1));
  }
  flush();
  return out.map((s) => ({ ...s, pts: dedupe(s.pts) })).filter((s) => s.pts.length > 1);
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6) continue;
    out.push([Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4]);
  }
  return out;
}
