// Copper pours (ground planes). Each layer is drawn on a 0.1 mm raster: the
// board inside the edge keep-out, minus every other net's copper grown by
// the clearance, minus a ring round the net's own pads that four spokes
// cross (thermal reliefs: a pad soldered straight into a plane soaks up the
// heat of a small iron). Slivers too thin to etch are opened away, islands
// that touch none of the net's copper are dropped, and what is left is traced
// into polygons (marching squares, then simplified).
//
// The raster costs some accuracy, so everything is cleared by RASTER_MARGIN
// more than the rule asks: a traced edge lies within half a pixel diagonal of
// the pixel centres it separates, and simplifying moves it SIMPLIFY more.

import { placedHoles, placedPads } from "./board";
import { capsule, circle, convex, cosSin, edgeDist, inRing, padHalf, padShape, ringArea, shapeBox, shapeDist, type Pt, type Shape } from "./geom";
import type { BoardRules, BoardSpec, Layer, Pour, Track, Via } from "./types";

const RES = 0.1;
const SIMPLIFY = 0.025;
const RASTER_MARGIN = 0.1;
export const SPOKE_W = 0.5;

export interface CopperInput {
  spec: BoardSpec;
  rules: BoardRules;
  tracks: Track[];
  vias: Via[];
}

/** Pours for the board's pour net (the first, if several are marked) on both layers. */
export function makePours(b: CopperInput): Pour[] {
  const net = b.spec.nets.find((n) => n.pour);
  if (!net || !net.pins.length) return [];
  const out: Pour[] = [];
  for (const layer of ["F", "B"] as Layer[]) {
    const polys = pourLayer(b, net.name, layer);
    if (polys.length) out.push({ net: net.name, layer, polys });
  }
  return out;
}

class Raster {
  readonly nx: number;
  readonly ny: number;
  readonly m: Uint8Array;
  constructor(w: number, h: number) {
    // one empty pixel all round so every contour closes
    this.nx = Math.ceil(w / RES) + 2;
    this.ny = Math.ceil(h / RES) + 2;
    this.m = new Uint8Array(this.nx * this.ny);
  }
  x(i: number) {
    return (i - 0.5) * RES;
  }
  y(j: number) {
    return (j - 0.5) * RES;
  }
  /** Sets every pixel whose centre is nearer than `need` to the shape (and passes `ok`). */
  paint(s: Shape, need: number, v: number, ok?: (x: number, y: number) => boolean) {
    const b = shapeBox(s);
    const i0 = Math.max(0, Math.floor((b[0] - need) / RES));
    const i1 = Math.min(this.nx - 1, Math.ceil((b[2] + need) / RES) + 1);
    const j0 = Math.max(0, Math.floor((b[1] - need) / RES));
    const j1 = Math.min(this.ny - 1, Math.ceil((b[3] + need) / RES) + 1);
    for (let j = j0; j <= j1; j++) {
      const y = this.y(j);
      for (let i = i0; i <= i1; i++) {
        const x = this.x(i);
        if (shapeDist(s, x, y) < need && (!ok || ok(x, y))) this.m[j * this.nx + i] = v;
      }
    }
  }
}

function pourLayer(b: CopperInput, net: string, layer: Layer): Pt[][] {
  const { spec, rules } = b;
  const R = new Raster(spec.w, spec.h);
  const { nx, ny, m } = R;
  const clr = rules.clearance + RASTER_MARGIN;
  const edge = rules.edge + RASTER_MARGIN;
  const onBoard = (x: number, y: number) => edgeDist(spec, x, y) >= edge;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) m[j * nx + i] = onBoard(R.x(i), R.y(j)) ? 1 : 0;

  const pads = placedPads(spec);
  const own = pads.filter((p) => p.net === net);
  const anchors: Shape[] = [];
  // thermal reliefs: clear a ring the width of the clearance round each pad, then four spokes across it
  for (const p of own) R.paint(padShape(p), clr, 0);
  for (const p of own) {
    const [c, s] = cosSin(p.rot);
    const [hx, hy] = padHalf(p);
    for (const [ux, uy, half] of [
      [c, s, hx],
      [-c, -s, hx],
      [-s, c, hy],
      [s, -c, hy],
    ]) {
      const a = Math.max(0, half - 0.4);
      const e = half + clr + 0.5;
      const vx = -uy * (SPOKE_W / 2);
      const vy = ux * (SPOKE_W / 2);
      const spoke = convex([
        [p.x + ux * a - vx, p.y + uy * a - vy],
        [p.x + ux * e - vx, p.y + uy * e - vy],
        [p.x + ux * e + vx, p.y + uy * e + vy],
        [p.x + ux * a + vx, p.y + uy * a + vy],
      ]);
      R.paint(spoke, 0, 1, onBoard);
    }
    anchors.push(padShape(p));
  }
  for (const h of placedHoles(spec)) R.paint(circle(h.x, h.y, h.d / 2), edge, 0);
  for (const p of pads) if (p.net !== net) R.paint(padShape(p), clr, 0);
  for (const t of b.tracks) {
    if (t.layer !== layer) continue;
    for (let k = 1; k < t.pts.length; k++) {
      const sh = capsule(t.pts[k - 1][0], t.pts[k - 1][1], t.pts[k][0], t.pts[k][1], t.w / 2);
      if (t.net === net) anchors.push(sh);
      else R.paint(sh, clr, 0);
    }
  }
  for (const v of b.vias) {
    const sh = circle(v.x, v.y, v.pad / 2);
    if (v.net === net) anchors.push(sh);
    else R.paint(sh, clr, 0);
  }

  open3(m, nx, ny);

  // keep only the islands that touch the net's own copper
  const anchor = new Uint8Array(nx * ny);
  const A = new Raster(spec.w, spec.h);
  for (const s of anchors) A.paint(s, 0, 1);
  for (let k = 0; k < anchor.length; k++) anchor[k] = A.m[k] & m[k];
  const label = new Int32Array(nx * ny);
  const stack = new Int32Array(nx * ny);
  let next = 0;
  for (let k = 0; k < m.length; k++) {
    if (!m[k] || label[k]) continue;
    next++;
    let sp = 0;
    let keep = false;
    const members: number[] = [];
    stack[sp++] = k;
    label[k] = next;
    while (sp) {
      const q = stack[--sp];
      members.push(q);
      if (anchor[q]) keep = true;
      const i = q % nx;
      for (const r of [q - 1, q + 1, q - nx, q + nx]) {
        if (r < 0 || r >= m.length || !m[r] || label[r]) continue;
        if ((r === q - 1 && i === 0) || (r === q + 1 && i === nx - 1)) continue;
        label[r] = next;
        stack[sp++] = r;
      }
    }
    if (!keep) for (const q of members) m[q] = 0;
  }

  return groupRings(trace(m, nx, ny).map((r) => simplifyRing(r, SIMPLIFY)).filter((r) => r.length >= 3));
}

/** Morphological opening with a 3×3 square: removes copper narrower than about three pixels. */
function open3(m: Uint8Array, nx: number, ny: number) {
  const t = new Uint8Array(m.length);
  const pass = (src: Uint8Array, dst: Uint8Array, step: number, isMin: boolean) => {
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const okPrev = step === 1 ? i > 0 : j > 0;
        const okNext = step === 1 ? i < nx - 1 : j < ny - 1;
        const a = okPrev ? src[k - step] : 0;
        const c = okNext ? src[k + step] : 0;
        dst[k] = isMin ? src[k] & a & c : src[k] | a | c;
      }
  };
  const u = new Uint8Array(m.length);
  pass(m, t, 1, true);
  pass(t, u, nx, true);
  pass(u, t, 1, false);
  pass(t, m, nx, false);
}

/**
 * Marching squares over pixel centres. Each cell between four pixels emits
 * edges from one edge midpoint to another with the copper on the left, so
 * outlines come out counter-clockwise and holes clockwise. Diagonal pairs
 * (saddles) stay apart, matching the four-neighbour islands above.
 */
function trace(m: Uint8Array, nx: number, ny: number): Pt[][] {
  const HN = nx * ny;
  const nxt = new Int32Array(2 * HN).fill(-1);
  const H = (i: number, j: number) => j * nx + i;
  const V = (i: number, j: number) => HN + j * nx + i;
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const code = m[j * nx + i] | (m[j * nx + i + 1] << 1) | (m[(j + 1) * nx + i + 1] << 2) | (m[(j + 1) * nx + i] << 3);
      if (code === 0 || code === 15) continue;
      const B = H(i, j);
      const T = H(i, j + 1);
      const L = V(i, j);
      const R = V(i + 1, j);
      switch (code) {
        case 1: nxt[B] = L; break;
        case 2: nxt[R] = B; break;
        case 3: nxt[R] = L; break;
        case 4: nxt[T] = R; break;
        case 5: nxt[B] = L; nxt[T] = R; break;
        case 6: nxt[T] = B; break;
        case 7: nxt[T] = L; break;
        case 8: nxt[L] = T; break;
        case 9: nxt[B] = T; break;
        case 10: nxt[R] = B; nxt[L] = T; break;
        case 11: nxt[R] = T; break;
        case 12: nxt[L] = R; break;
        case 13: nxt[B] = R; break;
        case 14: nxt[L] = B; break;
      }
    }
  const at = (e: number): Pt => {
    if (e < HN) {
      const i = e % nx;
      const j = (e - i) / nx;
      return [i * RES, (j - 0.5) * RES];
    }
    const f = e - HN;
    const i = f % nx;
    const j = (f - i) / nx;
    return [(i - 0.5) * RES, j * RES];
  };
  const seen = new Uint8Array(2 * HN);
  const rings: Pt[][] = [];
  for (let e = 0; e < 2 * HN; e++) {
    if (nxt[e] < 0 || seen[e]) continue;
    const ring: Pt[] = [];
    for (let k = e; k >= 0 && !seen[k]; k = nxt[k]) {
      seen[k] = 1;
      ring.push(at(k));
    }
    rings.push(ring);
  }
  return rings;
}

/** Douglas-Peucker on a closed ring. */
export function simplifyRing(r: Pt[], tol: number): Pt[] {
  const n = r.length;
  if (n < 4) return r;
  let far = 0;
  let fd = -1;
  for (let k = 1; k < n; k++) {
    const d = (r[k][0] - r[0][0]) ** 2 + (r[k][1] - r[0][1]) ** 2;
    if (d > fd) {
      fd = d;
      far = k;
    }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const pt = (k: number) => r[k % n];
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = pt(a);
    const [bx, by] = pt(b);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bd = tol;
    for (let k = a + 1; k < b; k++) {
      const [px, py] = pt(k);
      const d = len > 1e-12 ? Math.abs(dx * (py - ay) - dy * (px - ax)) / len : Math.hypot(px - ax, py - ay);
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push([Math.round(r[k][0] * 1e4) / 1e4, Math.round(r[k][1] * 1e4) / 1e4]);
  return out;
}

/** Orders rings as outline, its holes, next outline, its holes... Holes go with the smallest outline round them. */
export function groupRings(rings: Pt[][]): Pt[][] {
  const outers = rings.filter((r) => ringArea(r) > 0).map((r) => ({ r, a: ringArea(r), box: ringBox(r), holes: [] as Pt[][] }));
  for (const h of rings) {
    if (ringArea(h) >= 0) continue;
    const [x, y] = h[0];
    let best: (typeof outers)[number] | undefined;
    for (const o of outers) {
      if (x < o.box[0] || x > o.box[2] || y < o.box[1] || y > o.box[3]) continue;
      if ((!best || o.a < best.a) && inRing(o.r, x, y)) best = o;
    }
    best?.holes.push(h);
  }
  return outers.flatMap((o) => [o.r, ...o.holes]);
}

export const ringBox = (r: Pt[]): [number, number, number, number] => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of r) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

/** Splits Pour.polys back into groups of [outline, ...holes]. */
export function pourGroups(polys: Pt[][]): Pt[][][] {
  const out: Pt[][][] = [];
  for (const r of polys) {
    if (ringArea(r) > 0 || !out.length) out.push([r]);
    else out[out.length - 1].push(r);
  }
  return out;
}
