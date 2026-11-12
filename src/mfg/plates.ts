// Print plates: every printed copy packed onto as few beds as it takes. Each part keeps the way it prints (lying on
// its face, or along its process's build direction) and may turn a quarter turn about the vertical to fit. A
// single-nozzle printer prints one material a plate; a two-nozzle one two. Rectangles packed by MaxRects, best
// short side fit, biggest parts first.

export interface PlateItem {
  /** what it is, for the plate's list */
  name: string;
  /** footprint on the bed as it prints, mm (before any quarter turn) */
  w: number;
  d: number;
  material: string;
}

export interface PlatePlace {
  /** index into the items */
  item: number;
  /** the footprint's corner nearest the bed's origin, mm on the bed, and whether it is turned a quarter turn */
  x: number;
  y: number;
  turned: boolean;
}

export interface Plate {
  places: PlatePlace[];
  materials: string[];
  /** share of the bed the footprints cover */
  fill: number;
}

export interface PlateOptions {
  /** gap between parts, mm (6) */
  gap?: number;
  /** clear border round the bed's edge, mm (5) */
  margin?: number;
  /** nozzles: how many materials one plate can print (1) */
  nozzles?: number;
}

type Rect = { x: number; y: number; w: number; h: number };

/** One bed's free space, as the largest empty rectangles. */
class Bin {
  free: Rect[];
  constructor(
    readonly W: number,
    readonly H: number,
  ) {
    this.free = [{ x: 0, y: 0, w: W, h: H }];
  }

  /** where a w × h box goes best (shortest leftover side), or null */
  fit(w: number, h: number): { x: number; y: number; score: number; short: number } | null {
    let best: { x: number; y: number; score: number; short: number } | null = null;
    for (const f of this.free) {
      if (w > f.w + 1e-9 || h > f.h + 1e-9) continue;
      const short = Math.min(f.w - w, f.h - h);
      const long = Math.max(f.w - w, f.h - h);
      if (!best || short < best.short - 1e-9 || (Math.abs(short - best.short) <= 1e-9 && long < best.score)) best = { x: f.x, y: f.y, score: long, short };
    }
    return best;
  }

  place(r: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      // what is left of f round r, as up to four overlapping rectangles
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // drop rectangles inside others
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)));
  }
}

/**
 * The plates for these items on a bed of this size. Items too big for the bed either way get a plate of their own
 * and are listed in `tooBig`.
 */
export function packPlates(items: PlateItem[], bed: [number, number], opts: PlateOptions = {}): { plates: Plate[]; tooBig: number[] } {
  const gap = opts.gap ?? 6;
  const margin = opts.margin ?? 5;
  const nozzles = Math.max(1, opts.nozzles ?? 1);
  // each footprint grown by the gap, on a bed grown by it too (so the last part needs no gap past the border)
  const W = bed[0] - 2 * margin + gap;
  const H = bed[1] - 2 * margin + gap;
  const plates: (Plate & { bin: Bin })[] = [];
  const tooBig: number[] = [];
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => Math.max(b.it.w, b.it.d) - Math.max(a.it.w, a.it.d) || b.it.w * b.it.d - a.it.w * a.it.d);
  for (const { it, i } of order) {
    const w = it.w + gap;
    const h = it.d + gap;
    const fits = (w <= W + 1e-9 && h <= H + 1e-9) || (h <= W + 1e-9 && w <= H + 1e-9);
    if (!fits) {
      tooBig.push(i);
      plates.push({ places: [{ item: i, x: margin, y: margin, turned: false }], materials: [it.material], fill: Math.min(1, (it.w * it.d) / (bed[0] * bed[1])), bin: new Bin(W, H) });
      continue;
    }
    let done = false;
    for (const p of plates) {
      if (!p.materials.includes(it.material) && p.materials.length >= nozzles) continue;
      if (tooBig.some((k) => p.places.some((q) => q.item === k))) continue;
      const a = p.bin.fit(w, h);
      const b = w !== h ? p.bin.fit(h, w) : null;
      const pick = a && (!b || a.short <= b.short) ? { ...a, turned: false } : b ? { ...b, turned: true } : null;
      if (!pick) continue;
      p.bin.place({ x: pick.x, y: pick.y, w: pick.turned ? h : w, h: pick.turned ? w : h });
      p.places.push({ item: i, x: margin + pick.x, y: margin + pick.y, turned: pick.turned });
      if (!p.materials.includes(it.material)) p.materials.push(it.material);
      p.fill += (it.w * it.d) / (bed[0] * bed[1]);
      done = true;
      break;
    }
    if (done) continue;
    const bin = new Bin(W, H);
    const turned = !(w <= W + 1e-9 && h <= H + 1e-9);
    bin.place({ x: 0, y: 0, w: turned ? h : w, h: turned ? w : h });
    plates.push({ places: [{ item: i, x: margin, y: margin, turned }], materials: [it.material], fill: (it.w * it.d) / (bed[0] * bed[1]), bin });
  }
  // each plate's parts centred on the bed
  for (const p of plates) {
    if (p.places.some((q) => tooBig.includes(q.item))) continue;
    let x1 = 0;
    let y1 = 0;
    for (const q of p.places) {
      const it = items[q.item];
      x1 = Math.max(x1, q.x + (q.turned ? it.d : it.w));
      y1 = Math.max(y1, q.y + (q.turned ? it.w : it.d));
    }
    const dx = Math.max(0, (bed[0] - margin - x1) / 2);
    const dy = Math.max(0, (bed[1] - margin - y1) / 2);
    for (const q of p.places) (q.x += dx), (q.y += dy);
  }
  return { plates: plates.map(({ bin: _bin, ...p }) => p), tooBig };
}
