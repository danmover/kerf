// Copper pours (ground planes). Each layer is drawn on a 0.1 mm raster: the
// board inside the edge keep-out, minus every other net's copper grown by
// the clearance, minus a ring round the net's own pads that four spokes
// cross (thermal reliefs: a pad soldered straight into a plane soaks up the
// heat of a small iron). Slivers too thin to etch are opened away, islands
// that touch none of the net's copper are dropped, and what is left is traced
// into polygons (marching squares, then simplified).
//
// An island cut off on one layer is kept when a via can join it to the pour
// on the other layer (stitching): the via goes where the island and the other
// layer's pour both have room for it, so it is clear of everything else.
//
// The raster costs some accuracy, so everything is cleared by RASTER_MARGIN
// more than the rule asks: a traced edge lies within half a pixel diagonal of
// the pixel centres it separates, and simplifying moves it SIMPLIFY more.

import { placedHoles, placedPads } from "./board";
import { RingIndex, capsule, circle, convex, cosSin, edgeDist, padHalf, padShape, ringArea, shapeBox, shapeDist, type Pt, type Shape } from "./geom";
import type { BoardRules, BoardSpec, Layer, Pour, Track, Via } from "./types";

const RES = 0.1;
const SIMPLIFY = 0.025;
const RASTER_MARGIN = 0.1;
export const SPOKE_W = 0.5;
/** islands smaller than this (mm²) aren't worth a stitching via */
const MIN_STITCH_AREA = 3;

export interface CopperInput {
  spec: BoardSpec;
  rules: BoardRules;
  tracks: Track[];
  vias: Via[];
}

/** Pours for the board's pour net (the first, if several are marked) on both layers, and the stitching vias they need. */
export function makePours(b: CopperInput): { pours: Pour[]; vias: Via[] } {
  const net = b.spec.nets.find((n) => n.pour);
  if (!net || !net.pins.length) return { pours: [], vias: [] };
  const layers = (["F", "B"] as Layer[]).map((layer) => rasterLayer(b, net.name, layer));
  const vias = stitch(b, net.name, layers);
  const pours: Pour[] = [];
  for (const L of layers) {
    const polys = groupRings(trace(L.m, L.R.nx, L.R.ny).map((r) => simplifyRing(r, SIMPLIFY)).filter((r) => r.length >= 3));
    if (polys.length) pours.push({ net: net.name, layer: L.layer, polys });
  }
  return { pours, vias };
}

interface LayerRaster {
  layer: Layer;
  R: Raster;
  /** the pour as kept */
  m: Uint8Array;
  /** islands dropped for touching none of the net's copper, as pixel lists */
  islands: Int32Array[];
}

/** Joins dropped islands to the other layer's pour with a via where both have room for one, and keeps them. */
function stitch(b: CopperInput, net: string, layers: LayerRaster[]): Via[] {
  const { pad, drill } = b.rules.via;
  const rad = pad / 2 + 0.12;
  const rp = Math.ceil(rad / RES);
  const offs: [number, number][] = [];
  for (let dj = -rp; dj <= rp; dj++) for (let di = -rp; di <= rp; di++) if ((di * di + dj * dj) * RES * RES <= rad * rad) offs.push([di, dj]);
  const out: Via[] = [];
  // two rounds: an island kept on one layer can make room for one on the other
  for (let round = 0; round < 2; round++)
    layers.forEach((L, li) => {
      const O = layers[1 - li];
      const nx = L.R.nx;
      const mark = new Uint8Array(L.m.length);
      L.islands = L.islands.filter((isl) => {
        if (isl.length * RES * RES < MIN_STITCH_AREA) return true;
        for (const q of isl) mark[q] = 1;
        let cx = 0;
        let cy = 0;
        for (const q of isl) {
          cx += q % nx;
          cy += Math.floor(q / nx);
        }
        cx /= isl.length;
        cy /= isl.length;
        // try spots on a coarse lattice, nearest the middle of the island first
        const cands = isl.filter((q) => (q % nx) % 3 === 0 && Math.floor(q / nx) % 3 === 0);
        cands.sort((a, c) => Math.hypot((a % nx) - cx, Math.floor(a / nx) - cy) - Math.hypot((c % nx) - cx, Math.floor(c / nx) - cy));
        let spot = -1;
        for (const q of cands) {
          const i = q % nx;
          const j = Math.floor(q / nx);
          let ok = true;
          for (const [di, dj] of offs) {
            const k = (j + dj) * nx + i + di;
            if (!mark[k] || !O.m[k]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            spot = q;
            break;
          }
        }
        for (const q of isl) mark[q] = 0;
        if (spot < 0) return true;
        for (const q of isl) L.m[q] = 1;
        out.push({ net, x: Math.round(L.R.x(spot % nx) * 1e4) / 1e4, y: Math.round(L.R.y(Math.floor(spot / nx)) * 1e4) / 1e4, pad, drill });
        return false;
      });
    });
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

function rasterLayer(b: CopperInput, net: string, layer: Layer): LayerRaster {
  const { spec, rules } = b;
  const R = new Raster(spec.w, spec.h);
  const { nx, ny, m } = R;
  const clr = rules.clearance + RASTER_MARGIN;
  const edge = rules.edge + RASTER_MARGIN;
  const onBoard = (x: number, y: number) => edgeDist(spec, x, y) >= edge;
  // the board is convex, so each row is one run: find its ends and fill between
  for (let j = 0; j < ny; j++) {
    const y = R.y(j);
    let a = 0;
    while (a < nx && !onBoard(R.x(a), y)) a++;
    let b = nx - 1;
    while (b > a && !onBoard(R.x(b), y)) b--;
    if (a <= b && onBoard(R.x(a), y)) m.fill(1, j * nx + a, j * nx + b + 1);
  }

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
  // flood fill with four neighbours; the border pixels are always empty, so no bounds checks
  const seen = new Uint8Array(nx * ny);
  const seq = new Int32Array(nx * ny);
  const islands: Int32Array[] = [];
  let end = 0;
  for (let k = 0; k < m.length; k++) {
    if (!m[k] || seen[k]) continue;
    const start = end;
    let head = start;
    let keep = false;
    seq[end++] = k;
    seen[k] = 1;
    while (head < end) {
      const q = seq[head++];
      if (anchor[q]) keep = true;
      if (m[q - 1] && !seen[q - 1]) (seen[q - 1] = 1), (seq[end++] = q - 1);
      if (m[q + 1] && !seen[q + 1]) (seen[q + 1] = 1), (seq[end++] = q + 1);
      if (m[q - nx] && !seen[q - nx]) (seen[q - nx] = 1), (seq[end++] = q - nx);
      if (m[q + nx] && !seen[q + nx]) (seen[q + nx] = 1), (seq[end++] = q + nx);
    }
    if (!keep) {
      const members = seq.slice(start, end);
      for (const q of members) m[q] = 0;
      islands.push(members);
    }
  }
  return { layer, R, m, islands };
}

/** Morphological opening with a 3×3 square: removes copper narrower than about three pixels. */
function open3(m: Uint8Array, nx: number, ny: number) {
  const t = new Uint8Array(m.length);
  // the outermost pixels are off the board and stay empty
  const pass = (src: Uint8Array, dst: Uint8Array, step: number, isMin: boolean) => {
    for (let j = 1; j < ny - 1; j++) {
      const row = j * nx;
      if (isMin) for (let k = row + 1; k < row + nx - 1; k++) dst[k] = src[k - step] & src[k] & src[k + step];
      else for (let k = row + 1; k < row + nx - 1; k++) dst[k] = src[k - step] | src[k] | src[k + step];
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
  const outers = rings.filter((r) => ringArea(r) > 0).map((r) => ({ r, a: ringArea(r), box: ringBox(r), idx: new RingIndex(r), holes: [] as Pt[][] }));
  for (const h of rings) {
    if (ringArea(h) >= 0) continue;
    const [x, y] = h[0];
    let best: (typeof outers)[number] | undefined;
    for (const o of outers) {
      if (x < o.box[0] || x > o.box[2] || y < o.box[1] || y > o.box[3]) continue;
      if ((!best || o.a < best.a) && o.idx.contains(x, y)) best = o;
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
