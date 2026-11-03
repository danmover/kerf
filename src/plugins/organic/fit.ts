// Fit an organic model to a reference sheet's outlines: each entry of the
// model's shape list (the head, an ear group, a leg, the tail) is moved and
// scaled until the model's outline from the front, the side and above covers
// the pictures' as closely as it can. The modelled forms stay what they are
// (a round head, thin ears), only their sizes and places follow the drawing,
// so the views match without the melted look of a shape carved from outlines.

import type { Item, OrganicModel, V3 } from "./model";
import { primBox, primDist } from "./sdf";
import { IDENT, movePrim } from "./transform";
import type { Outline } from "./sheet";

/** One entry's move: [entry, dx, dy, dz, scale], scaling about the entry's centre. */
export type FitRow = [number, number, number, number, number];

export interface FitResult {
  rows: FitRow[];
  /** how much of the outlines' area the model matches (intersection over union), per view, before and after */
  before: { front: number; side: number; top: number | null };
  after: { front: number; side: number; top: number | null };
}

/**
 * Each entry's centre, which it scales about. A left-and-right pair (an ear
 * and its mirror copy, nothing on the centre line) moves as a pair: its
 * centre is that of its own side and the copy takes the mirrored move. Any
 * other entry (the head, a body with puffs on both sides) scales about its
 * whole middle and stays centred.
 */
export function fitEntries(items: Item[]): Map<number, { c: V3; paired: boolean; mirrored: boolean }> {
  const all = new Map<number, Item[]>();
  for (const it of items) {
    if (it.g === undefined || it.op !== "add") continue;
    const l = all.get(it.g);
    if (l) l.push(it);
    else all.set(it.g, [it]);
  }
  const out = new Map<number, { c: V3; paired: boolean; mirrored: boolean }>();
  for (const [g, list] of all) {
    const boxes = list.map((it) => ({ side: it.side, box: primBox(it.prim) }));
    const own = boxes.filter((b) => !b.side);
    const mirrored = own.length < boxes.length;
    const paired = mirrored && (own.every((b) => b.box[0][0] > -1e-3) || own.every((b) => b.box[1][0] < 1e-3));
    const use = paired ? own : boxes;
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const { box } of use)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], box[0][k]);
        hi[k] = Math.max(hi[k], box[1][k]);
      }
    out.set(g, { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], paired, mirrored });
  }
  return out;
}

interface Piece {
  g: number;
  c: V3;
  paired: boolean;
  /** points on its surface, xyz, and which of them are on a mirror copy */
  pts: Float32Array;
  mir: Uint8Array;
  /** may it move sideways (only when it is off the centre line or has a mirror copy) */
  sideways: boolean;
  /** how far it may move: small pieces only a little, so a puff cannot wander across the face */
  reach: number;
  d: V3;
  s: number;
}

interface View {
  o: Outline;
  /** which model axes it shows: 0 x, 1 y, 2 z */
  ax: number;
  ay: number;
  weight: number;
  count: Uint16Array;
}

/**
 * Fit `model` to the outlines (both in the model's millimetres: X right,
 * Y back, Z up). Returns each entry's move, for fitItems.
 */
export function fitToOutlines(model: OrganicModel, outlines: { front: Outline; side: Outline; top: Outline | null }, start: FitRow[] = []): FitResult {
  const px = outlines.front.px;
  const step = px * 0.6;
  const entries = fitEntries(model.items);
  const pieces: Piece[] = [];
  for (const [g, { c, paired, mirrored }] of entries) {
    const adds = model.items.filter((it) => it.g === g && it.op === "add");
    const pts: number[] = [];
    const mir: number[] = [];
    for (const it of adds) {
      const d = primDist(it.prim);
      const [lo, hi] = primBox(it.prim);
      for (let z = lo[2]; z <= hi[2]; z += step)
        for (let y = lo[1]; y <= hi[1]; y += step)
          for (let x = lo[0]; x <= hi[0]; x += step) {
            if (Math.abs(d(x, y, z)) > step * 0.75) continue;
            pts.push(x, y, z);
            mir.push(it.side ? 1 : 0);
          }
    }
    if (!pts.length) continue;
    let size = 0;
    for (let k = 0; k < 3; k++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = k; i < pts.length; i += 3)
        if (!mir[(i - k) / 3]) {
          lo = Math.min(lo, pts[i]);
          hi = Math.max(hi, pts[i]);
        }
      if (hi > lo) size = Math.max(size, hi - lo);
    }
    const prior = start.find((r) => r[0] === g);
    pieces.push({
      g,
      c,
      paired,
      pts: Float32Array.from(pts),
      mir: Uint8Array.from(mir),
      // a pair moves apart or together; a piece on its own only when it is off the centre line
      sideways: paired || (!mirrored && Math.abs(c[0]) > px),
      reach: size,
      d: prior ? [prior[1], prior[2], prior[3]] : [0, 0, 0],
      s: prior ? prior[4] : 1,
    });
  }
  const views: View[] = [
    { o: outlines.front, ax: 0, ay: 2, weight: 1, count: new Uint16Array(outlines.front.w * outlines.front.h) },
    { o: outlines.side, ax: 1, ay: 2, weight: 1, count: new Uint16Array(outlines.side.w * outlines.side.h) },
  ];
  if (outlines.top) views.push({ o: outlines.top, ax: 0, ay: 1, weight: 0.6, count: new Uint16Array(outlines.top.w * outlines.top.h) });

  // each piece's pixels in each view, for its current move
  const covered = new Map<Piece, Int32Array[]>();
  const stamp = views.map((v) => new Int32Array(v.o.w * v.o.h));
  let tick = 0;
  const pixelsOf = (p: Piece, d: V3, s: number): Int32Array[] => {
    tick++;
    return views.map((v, vi) => {
      const out: number[] = [];
      const st = stamp[vi];
      const { w, h, lo } = v.o;
      for (let k = 0; k < p.mir.length; k++) {
        const m = p.paired && p.mir[k] === 1;
        // a mirror copy mirrors the move too
        const cx = m ? -p.c[0] : p.c[0];
        const dx = m ? -d[0] : d[0];
        const q = [
          (p.pts[k * 3] - cx) * s + cx + dx,
          (p.pts[k * 3 + 1] - p.c[1]) * s + p.c[1] + d[1],
          (p.pts[k * 3 + 2] - p.c[2]) * s + p.c[2] + d[2],
        ];
        const i = Math.round((q[v.ax] - lo[0]) / px);
        const j = Math.round((q[v.ay] - lo[1]) / px);
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const idx = j * w + i;
        if (st[idx] === tick) continue;
        st[idx] = tick;
        out.push(idx);
      }
      return Int32Array.from(out);
    });
  };
  // mismatched area, weighted by view, kept up to date as pieces move
  let loss = 0;
  for (const v of views) for (let i = 0; i < v.o.m.length; i++) loss += v.o.m[i] * v.weight;
  const add = (px: Int32Array[], sign: 1 | -1) => {
    views.forEach((v, vi) => {
      for (const i of px[vi]) {
        const before = v.count[i] > 0;
        v.count[i] += sign;
        const after = v.count[i] > 0;
        if (before !== after) loss += (after === (v.o.m[i] === 1) ? -1 : 1) * v.weight;
      }
    });
  };
  for (const p of pieces) {
    const c = pixelsOf(p, p.d, p.s);
    covered.set(p, c);
    add(c, 1);
  }
  const iou = () => {
    const r = views.map((v) => {
      let both = 0;
      let either = 0;
      for (let i = 0; i < v.o.m.length; i++) {
        const a = v.count[i] > 0;
        const b = v.o.m[i] === 1;
        if (a && b) both++;
        if (a || b) either++;
      }
      return either ? both / either : 1;
    });
    return { front: r[0], side: r[1], top: views[2] ? r[2] : null };
  };
  const before = iou();

  // coordinate descent: try each move on each piece, keep what helps, then finer steps
  let top = 0;
  outlines.front.m.forEach((on, i) => {
    if (on) top = Math.max(top, Math.floor(i / outlines.front.w));
  });
  const H = (top + 1) * px;
  const minGain = 0.5;
  for (const [dm, ds] of [
    [H * 0.04, 0.08],
    [H * 0.02, 0.04],
    [H * 0.01, 0.02],
    [H * 0.005, 0.01],
  ]) {
    for (let round = 0; round < 6; round++) {
      let moved = false;
      for (const p of pieces) {
        const tries: [V3, number][] = [];
        for (const axis of [0, 1, 2]) {
          if (axis === 0 && !p.sideways) continue;
          for (const sg of [1, -1]) {
            const d: V3 = [...p.d];
            d[axis] += sg * dm;
            if (Math.abs(d[axis]) <= Math.min(H * 0.25, Math.max(p.reach * 0.3, H * 0.05))) tries.push([d, p.s]);
          }
        }
        for (const sg of [1, -1]) if (p.s + sg * ds >= 0.7 && p.s + sg * ds <= 1.4) tries.push([p.d, p.s + sg * ds]);
        for (const [d, s] of tries) {
          const old = covered.get(p)!;
          const was = loss;
          add(old, -1);
          const next = pixelsOf(p, d, s);
          add(next, 1);
          if (loss < was - minGain) {
            covered.set(p, next);
            p.d = d;
            p.s = s;
            moved = true;
          } else {
            add(next, -1);
            add(old, 1);
          }
        }
      }
      if (!moved) break;
    }
  }
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    rows: pieces.filter((p) => p.s !== 1 || p.d.some((v) => v !== 0)).map((p) => [p.g, r(p.d[0]), r(p.d[1]), r(p.d[2]), r(p.s)] as FitRow),
    before,
    after: iou(),
  };
}

/** Apply fitted moves: each entry moves and scales about its centre, the copy of a left-and-right pair the mirrored way. */
export function fitItems(items: Item[], rows: FitRow[]): Item[] {
  if (!rows.length) return items;
  const entries = fitEntries(items);
  const byEntry = new Map(rows.map((r) => [r[0], r]));
  return items.map((it) => {
    const r = it.g === undefined ? undefined : byEntry.get(it.g);
    const e = r && entries.get(it.g!);
    if (!r || !e) return it;
    const [, dx, dy, dz, s] = r;
    const { c } = e;
    // the mirror copy of a left-and-right pair takes the mirrored move
    const flip = e.paired && it.side;
    const cx = flip ? -c[0] : c[0];
    const t: V3 = [cx - s * cx + (flip ? -dx : dx), c[1] - s * c[1] + dy, c[2] - s * c[2] + dz];
    return { ...it, prim: movePrim(it.prim, IDENT, s, t) };
  });
}
