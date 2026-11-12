// Cutting flat parts out of sheet on a laser, plasma table or waterjet: each part's profile from its solid (cut
// through the middle of the plate), the parts nested on sheets, and the cut paths: offset half the kerf into the
// scrap, holes before the outline that frees the part, each pierced off the line in the scrap and led in. Out come
// DXF and SVG for laser software (which applies its own kerf) and G-code for GRBL lasers and plasma or waterjet
// tables.
//
// Nesting is true-shape on a raster: each part (grown by half the gap) is drawn into cells, and goes in the lowest,
// then leftmost, place where none of its cells meet another part's, trying each quarter turn. Small parts can land
// in a large part's holes.

import { Slicer, setupRotation, type CamMesh } from "./slice";
import { area, bounds, inside, islands, loopArea, offset, pathLength, type Loop, type Pt, type Region } from "./clip";

type V3 = [number, number, number];

export type Cutter = "diode" | "co2" | "fiber" | "plasma" | "waterjet";

export const CUTTERS: { id: Cutter; label: string }[] = [
  { id: "diode", label: "Diode laser" },
  { id: "co2", label: "CO2 laser" },
  { id: "fiber", label: "Fibre laser" },
  { id: "plasma", label: "Plasma" },
  { id: "waterjet", label: "Waterjet" },
];

export const isLaser = (c: Cutter) => c === "diode" || c === "co2" || c === "fiber";

/** A flat part's outline with its holes, in the plate's own plane, and how thick the plate is. */
export interface FlatProfile {
  region: Region;
  thickness: number;
  /** the plate is not the same all the way through (pockets, chamfers, counterbores): only the outline is cut */
  stepped: boolean;
}

/** The profile of a plate: its thinnest way through unless a normal is given (in the part's own frame). */
export function flatProfile(mesh: CamMesh, normal?: V3): FlatProfile | null {
  let n = normal;
  if (!n) {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < lo[k]) lo[k] = p[i + k];
        if (p[i + k] > hi[k]) hi[k] = p[i + k];
      }
    const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const k = size.indexOf(Math.min(...size));
    n = [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
  }
  const sl = new Slicer(mesh, setupRotation(n));
  const t = sl.hi[2] - sl.lo[2];
  if (!(t > 1e-6)) return null;
  const mid = sl.section(sl.lo[2] + t / 2);
  const a = area(mid);
  if (!(a > 1e-6)) return null;
  // the same through the plate, near each face?
  const near = [sl.section(sl.lo[2] + 0.1 * t), sl.section(sl.hi[2] - 0.1 * t)].map(area);
  const stepped = near.some((x) => Math.abs(x - a) > Math.max(0.005 * a, 0.5));
  return { region: mid, thickness: t, stepped };
}

export interface ProfileItem {
  key: string;
  mesh: CamMesh;
  normal: V3 | null;
}

/** Profiles of several parts; one that cannot be cut through the middle comes back null. */
export function profilesOf(items: ProfileItem[]): { key: string; profile: FlatProfile | null }[] {
  return items.map((it) => {
    try {
      return { key: it.key, profile: flatProfile(it.mesh, it.normal ?? undefined) };
    } catch {
      return { key: it.key, profile: null };
    }
  });
}

// ---------- nesting ----------

export interface NestItem {
  key: string;
  label: string;
  region: Region;
  qty: number;
}

export interface NestOptions {
  /** the sheet, x by y, mm */
  sheet: [number, number];
  /** least space between parts, mm */
  gap: number;
  /** least space from the sheet's edges, mm */
  margin: number;
  /** turn parts a quarter at a time to fit (off for wood grain or brushed sheet) */
  rotate: boolean;
  maxSheets?: number;
}

export interface Placed {
  key: string;
  label: string;
  /** which copy of the part */
  copy: number;
  /** quarter turns */
  turn: number;
  /** the part where it sits on the sheet */
  region: Region;
}

export interface Nest {
  sheets: Placed[][];
  unplaced: { key: string; label: string; count: number }[];
  /** the share of the sheets' area the parts take */
  used: number;
  sheet: [number, number];
}

const turnPt = ([x, y]: Pt, q: number): Pt => (q === 1 ? [-y, x] : q === 2 ? [-x, -y] : q === 3 ? [y, -x] : [x, y]);
const turnRegion = (r: Region, q: number): Region => r.map((l) => l.map((p) => turnPt(p, q)));
const moveRegion = (r: Region, dx: number, dy: number): Region => r.map((l) => l.map(([x, y]) => [x + dx, y + dy] as Pt));

interface Shape {
  turn: number;
  /** the turned part, with its raster origin at (0, 0) */
  region: Region;
  w: number;
  h: number;
  /** filled cells, row by row: [row, first, end) */
  runs: Int32Array;
}

/** Cells whose centres the area covers, grown by most of a cell so a cell any part of it touches counts. */
function rasterise(r: Region, res: number): { runs: Int32Array; w: number; h: number; lo: Pt } | null {
  const b = bounds(r);
  if (!b) return null;
  const lo: Pt = [b.lo[0], b.lo[1]];
  const w = Math.max(1, Math.ceil((b.hi[0] - lo[0]) / res));
  const h = Math.max(1, Math.ceil((b.hi[1] - lo[1]) / res));
  const runs: number[] = [];
  const xs: number[] = [];
  for (let j = 0; j < h; j++) {
    const y = lo[1] + (j + 0.5) * res;
    xs.length = 0;
    for (const l of r)
      for (let i = 0, k = l.length - 1; i < l.length; k = i++) {
        const [ax, ay] = l[k],
          [bx, by] = l[i];
        if (ay <= y !== by <= y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - lo[0]) / res - 0.5));
      const i1 = Math.min(w, Math.floor((xs[k + 1] - lo[0]) / res - 0.5) + 1);
      if (i1 > i0) runs.push(j, i0, i1);
    }
  }
  return { runs: Int32Array.from(runs), w, h, lo };
}

class SheetGrid {
  occ: Uint8Array;
  pre: Int32Array;
  constructor(
    readonly nx: number,
    readonly ny: number,
    edge: number,
  ) {
    this.occ = new Uint8Array(nx * ny);
    this.pre = new Int32Array((nx + 1) * ny);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) if (i < edge || j < edge || i >= nx - edge || j >= ny - edge) this.occ[j * nx + i] = 1;
    for (let j = 0; j < ny; j++) this.row(j);
  }
  private row(j: number) {
    const { nx, occ, pre } = this;
    const o = j * (nx + 1);
    pre[o] = 0;
    for (let i = 0; i < nx; i++) pre[o + i + 1] = pre[o + i] + occ[j * nx + i];
  }
  /** The first place (lowest row, then leftmost) the shape fits with its top at or below `top`, or null. */
  find(s: Shape, top: number): [number, number] | null {
    const { nx, ny, pre, occ } = this;
    const runs = s.runs;
    const yMax = Math.min(ny - s.h, top - s.h);
    for (let y = 0; y <= yMax; y++) {
      let x = 0;
      while (x <= nx - s.w) {
        let ok = true;
        for (let k = 0; k < runs.length; k += 3) {
          const row = y + runs[k];
          const o = row * (nx + 1);
          const a = x + runs[k + 1],
            b = x + runs[k + 2];
          if (pre[o + b] - pre[o + a] !== 0) {
            // jump past the last filled cell under this run
            let c = b - 1;
            while (c >= a && !occ[row * nx + c]) c--;
            x = c - runs[k + 1] + 1;
            ok = false;
            break;
          }
        }
        if (ok) return [x, y];
      }
    }
    return null;
  }
  put(s: Shape, x: number, y: number) {
    const runs = s.runs;
    const rows = new Set<number>();
    for (let k = 0; k < runs.length; k += 3) {
      const row = y + runs[k];
      for (let i = x + runs[k + 1]; i < x + runs[k + 2]; i++) this.occ[row * this.nx + i] = 1;
      rows.add(row);
    }
    for (const r of rows) this.row(r);
  }
}

/** The orders the nester tries parts in: by their own area, by the box they take (a frame with a big window takes
 *  more room than its area says), and longest first. */
const ORDERS: ((it: NestItem) => number)[] = [
  (it) => area(it.region),
  (it) => {
    const b = bounds(it.region);
    return b ? (b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) : 0;
  },
  (it) => {
    const b = bounds(it.region);
    return b ? Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1]) : 0;
  },
];

/** Nest the parts on as few sheets as it takes: each order of trying them, keeping the one with fewest sheets (then
 *  the emptiest last sheet, as the others are fuller). */
export function nest(items: NestItem[], o: NestOptions): Nest {
  const [W, H] = o.sheet;
  const res = Math.max(0.25, Math.max(W, H) / 700);
  const grow = o.gap / 2 + 0.75 * res;
  const shapes = new Map<string, Shape[]>();
  for (const it of items) {
    const list: Shape[] = [];
    for (const q of o.rotate ? [0, 1, 2, 3] : [0]) {
      const turned = turnRegion(it.region, q);
      const ras = rasterise(offset(turned, grow), res);
      if (!ras) continue;
      list.push({ turn: q, region: moveRegion(turned, -ras.lo[0], -ras.lo[1]), w: ras.w, h: ras.h, runs: ras.runs });
    }
    shapes.set(it.key, list);
  }
  const unplacedCount = (n: Nest) => n.unplaced.reduce((a, u) => a + u.count, 0);
  const lastFill = (n: Nest) => (n.sheets.length ? n.sheets[n.sheets.length - 1].reduce((a, p) => a + area(p.region), 0) : 0);
  let best: Nest | null = null;
  const seen = new Set<string>();
  for (const size of ORDERS) {
    const sorted = items.filter((it) => it.qty > 0 && shapes.get(it.key)?.length).sort((a, b) => size(b) - size(a) || area(b.region) - area(a.region));
    const sig = sorted.map((it) => it.key).join("|");
    if (seen.has(sig)) continue;
    seen.add(sig);
    const n = nestInOrder(sorted, items, shapes, o, res);
    if (!best || unplacedCount(n) < unplacedCount(best) || (unplacedCount(n) === unplacedCount(best) && (n.sheets.length < best.sheets.length || (n.sheets.length === best.sheets.length && lastFill(n) < lastFill(best) - 1e-6)))) best = n;
  }
  return best ?? { sheets: [], unplaced: [], used: 0, sheet: [W, H] };
}

function nestInOrder(sorted: NestItem[], items: NestItem[], shapes: Map<string, Shape[]>, o: NestOptions, res: number): Nest {
  const [W, H] = o.sheet;
  const nx = Math.max(1, Math.floor(W / res)),
    ny = Math.max(1, Math.floor(H / res));
  const edge = Math.max(0, Math.ceil((o.margin - o.gap / 2) / res));
  const queue = sorted.flatMap((it) => Array.from({ length: it.qty }, (_, c) => ({ it, copy: c + 1 })));
  const grids: SheetGrid[] = [];
  const sheets: Placed[][] = [];
  const missed = new Map<string, { key: string; label: string; count: number }>();
  // parts with no shape at all (no area) never fit
  for (const it of items) if (it.qty > 0 && !shapes.get(it.key)?.length) missed.set(it.key, { key: it.key, label: it.label, count: it.qty });
  const maxSheets = o.maxSheets ?? 50;
  for (const { it, copy } of queue) {
    let done = false;
    for (let g = 0; g <= grids.length && !done; g++) {
      if (g === grids.length) {
        if (grids.length >= maxSheets) break;
        // a fresh sheet only if the part would fit on one
        const empty = new SheetGrid(nx, ny, edge);
        if (!shapes.get(it.key)!.some((s) => empty.find(s, ny) !== null)) break;
        grids.push(empty);
        sheets.push([]);
      }
      const grid = grids[g];
      let best: { s: Shape; x: number; y: number } | null = null;
      for (const s of shapes.get(it.key)!) {
        const at = grid.find(s, best ? best.y + best.s.h : ny);
        if (at && (!best || at[1] + s.h < best.y + best.s.h || (at[1] + s.h === best.y + best.s.h && at[0] < best.x))) best = { s, x: at[0], y: at[1] };
      }
      if (!best) continue;
      grid.put(best.s, best.x, best.y);
      sheets[g].push({ key: it.key, label: it.label, copy, turn: best.s.turn, region: moveRegion(best.s.region, best.x * res, best.y * res) });
      done = true;
    }
    if (!done) {
      const m = missed.get(it.key) ?? { key: it.key, label: it.label, count: 0 };
      m.count++;
      missed.set(it.key, m);
    }
  }
  const partArea = sheets.flat().reduce((a, p) => a + area(p.region), 0);
  return { sheets, unplaced: [...missed.values()], used: sheets.length ? partArea / (sheets.length * W * H) : 0, sheet: [W, H] };
}

// ---------- cut paths ----------

export interface CutSettings {
  kerf: number;
  /** lead-in length, mm (0: pierce on the line) */
  lead: number;
  /** cut on past the start to close the loop cleanly, mm */
  overcut: number;
}

export interface CutPath {
  /** index into the sheet's parts */
  part: number;
  hole: boolean;
  /** where the cutter pierces, in the scrap */
  pierce: Pt;
  /** the cut, closed, from its start round to just before it again (the material on the right) */
  loop: Loop;
  /** past the start again */
  overcut: Pt[];
}

/** Left of the way along a loop at its vertex i, averaged over the edges either side. */
function leftAt(l: Loop, i: number): Pt {
  const a = l[(i - 1 + l.length) % l.length],
    p = l[i],
    b = l[(i + 1) % l.length];
  const n1 = norm([-(p[1] - a[1]), p[0] - a[0]]);
  const n2 = norm([-(b[1] - p[1]), b[0] - p[0]]);
  return norm([n1[0] + n2[0], n1[1] + n2[1]]);
}

function norm([x, y]: Pt): Pt {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

function centroid(l: Loop): Pt {
  let cx = 0,
    cy = 0,
    a2 = 0;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const cr = l[j][0] * l[i][1] - l[i][0] * l[j][1];
    a2 += cr;
    cx += (l[j][0] + l[i][0]) * cr;
    cy += (l[j][1] + l[i][1]) * cr;
  }
  return Math.abs(a2) > 1e-12 ? [cx / (3 * a2), cy / (3 * a2)] : l[0];
}

/** The points along a loop from its start for a length d. */
function along(l: Loop, d: number): Pt[] {
  const out: Pt[] = [];
  let left = d;
  for (let i = 1; i <= l.length && left > 1e-9; i++) {
    const a = l[i - 1],
      b = l[i % l.length];
    const s = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s >= left) {
      out.push([a[0] + ((b[0] - a[0]) * left) / s, a[1] + ((b[1] - a[1]) * left) / s]);
      break;
    }
    out.push(b);
    left -= s;
  }
  return out;
}

/** The cuts for one sheet: a part sitting in another's hole before that hole (or it drops out with the slug), each
 *  part's holes before its outline, and the nearest part next, from the sheet's corner. */
export function cutPaths(parts: Placed[], s: CutSettings): CutPath[] {
  const grown = parts.map((p) => offset(p.region, s.kerf / 2));
  const comp = grown.map((r) => islands(r));
  const ccw = (l: Loop) => (loopArea(l) < 0 ? l.slice().reverse() : l);
  const inHoles = comp.map((c, i) => {
    const holes = c.flatMap((isl) => isl.holes.map(ccw));
    return holes.length ? parts.flatMap((q, j) => (j !== i && q.region[0]?.length && holes.some((h) => inside(q.region[0][0], [h])) ? [j] : [])) : [];
  });
  const out: CutPath[] = [];
  let head: Pt = [0, 0];
  const left = new Set(parts.map((_, i) => i));
  const nearest = (free: boolean) => {
    let bi = -1,
      bd = Infinity;
    for (const i of left) {
      if (free && inHoles[i].some((j) => left.has(j))) continue;
      for (const isl of comp[i])
        for (const l of [isl.outer, ...isl.holes]) {
          const c = centroid(l);
          const d = Math.hypot(c[0] - head[0], c[1] - head[1]);
          if (d < bd) {
            bd = d;
            bi = i;
          }
        }
    }
    return bi;
  };
  while (left.size) {
    let bi = nearest(true);
    if (bi < 0) bi = nearest(false);
    if (bi < 0) break;
    left.delete(bi);
    const others = grown.filter((_, j) => j !== bi);
    const holes = comp[bi].flatMap((isl) => isl.holes);
    const outers = comp[bi].map((isl) => isl.outer);
    for (const [loops, hole] of [
      [holes, true],
      [outers, false],
    ] as [Loop[], boolean][]) {
      const todo = loops.slice();
      while (todo.length) {
        let k = 0;
        for (let i = 1; i < todo.length; i++) if (Math.hypot(centroid(todo[i])[0] - head[0], centroid(todo[i])[1] - head[1]) < Math.hypot(centroid(todo[k])[0] - head[0], centroid(todo[k])[1] - head[1])) k = i;
        const raw = todo.splice(k, 1)[0];
        // the material on the right: outlines clockwise, holes counter-clockwise
        const l = raw.slice().reverse();
        let si = 0;
        for (let i = 1; i < l.length; i++) if (Math.hypot(l[i][0] - head[0], l[i][1] - head[1]) < Math.hypot(l[si][0] - head[0], l[si][1] - head[1])) si = i;
        const loop = [...l.slice(si), ...l.slice(0, si)];
        const start = loop[0];
        let pierce: Pt = start;
        if (s.lead > 0) {
          const n = leftAt(loop, 0);
          // in the scrap: inside the hole (l runs counter-clockwise round it) but not on a part nested there, or
          // outside every part
          const free = (p: Pt) => !others.some((r) => inside(p, r));
          const scrap = (p: Pt) => (hole ? inside(p, [l]) && free(p) : free(p) && !inside(p, grown[bi]));
          let found = false;
          for (const f of [1, 0.5, 0.25]) {
            const p: Pt = [start[0] + n[0] * s.lead * f, start[1] + n[1] * s.lead * f];
            if (scrap(p)) {
              pierce = p;
              found = true;
              break;
            }
          }
          // a small hole: in from its middle
          if (!found && hole) {
            const c = centroid(l);
            if (scrap(c)) pierce = c;
          }
        }
        out.push({ part: bi, hole, pierce, loop, overcut: s.overcut > 0 ? along(loop, s.overcut) : [] });
        head = start;
      }
    }
  }
  return out;
}

/** Cutting length, travel and pierces of a sheet's cuts. */
export function cutStats(paths: CutPath[]): { cut: number; travel: number; pierces: number } {
  let cut = 0,
    travel = 0;
  let head: Pt = [0, 0];
  for (const p of paths) {
    travel += Math.hypot(p.pierce[0] - head[0], p.pierce[1] - head[1]);
    cut += Math.hypot(p.loop[0][0] - p.pierce[0], p.loop[0][1] - p.pierce[1]) + pathLength(p.loop, true) + pathLength([p.loop[0], ...p.overcut], false);
    head = p.overcut.length ? p.overcut[p.overcut.length - 1] : p.loop[0];
  }
  return { cut, travel, pierces: paths.length };
}

// ---------- the cutter ----------

export interface CutterSettings {
  cutter: Cutter;
  /** cutting speed, mm/min */
  speed: number;
  /** laser power, % */
  power: number;
  /** passes round each cut (a diode laser takes thick wood in several) */
  passes: number;
  /** plasma and waterjet: seconds to wait at the pierce */
  pierceDelay: number;
  kerf: number;
  lead: number;
  gap: number;
  /** travel speed between cuts, mm/min */
  rapid: number;
}

/** Starting points for a cutter in a material class and thickness: test on scrap and adjust. */
export function cutterDefaults(cutter: Cutter, metal: boolean, wood: boolean, t: number): CutterSettings {
  const k = Math.pow(3 / Math.max(0.5, t), 1.2);
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
  switch (cutter) {
    case "diode":
      return { cutter, speed: clamp(300 * Math.min(3, k), 60, 1500), power: 100, passes: Math.max(1, Math.ceil(t / 1.5)), pierceDelay: 0, kerf: 0.15, lead: 0, gap: 2, rapid: 3000 };
    case "co2":
      return { cutter, speed: clamp((wood ? 1200 : 900) * k, 100, 6000), power: t > 4 ? 90 : 70, passes: 1, pierceDelay: 0, kerf: 0.2, lead: 1, gap: 3, rapid: 6000 };
    case "fiber":
      return { cutter, speed: clamp((metal ? 3000 : 1500) * k, 200, 20000), power: 100, passes: 1, pierceDelay: 0.2, kerf: 0.15, lead: 2, gap: 4, rapid: 15000 };
    case "plasma":
      return { cutter, speed: clamp(2500 * k, 300, 8000), power: 100, passes: 1, pierceDelay: t > 6 ? 0.8 : 0.4, kerf: 1.5, lead: 4, gap: 10, rapid: 8000 };
    case "waterjet":
      return { cutter, speed: clamp((metal ? 300 : 1200) * k, 30, 4000), power: 100, passes: 1, pierceDelay: 1, kerf: 1, lead: 3, gap: 5, rapid: 5000 };
  }
}

/** How long a sheet takes: cutting at the cutter's speed (each pass), travel between cuts and the waits at pierces. */
export const cutSeconds = (paths: CutPath[], c: CutterSettings): number => cutTimeline(paths, c).total;

// ---------- the cutting step by step, for the preview ----------

export interface CutStep {
  /** which cut path */
  path: number;
  /** travel to the pierce (off), the wait while it pierces, or cutting (lead-in, the loop and the overcut) */
  kind: "travel" | "pierce" | "cut";
  t0: number;
  t1: number;
  pts: Pt[];
  /** distance along pts at each point */
  at: number[];
}

export interface CutTimeline {
  steps: CutStep[];
  total: number;
}

/** The sheet's cutting in order, each step timed as the machine runs it. */
export function cutTimeline(paths: CutPath[], c: CutterSettings): CutTimeline {
  const steps: CutStep[] = [];
  let t = 0;
  let head: Pt = [0, 0];
  const add = (path: number, kind: CutStep["kind"], pts: Pt[], speed: number, wait = 0) => {
    const at = [0];
    for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const dt = (at[at.length - 1] * 60) / Math.max(1, speed) + wait;
    steps.push({ path, kind, t0: t, t1: t + dt, pts, at });
    t += dt;
  };
  paths.forEach((p, i) => {
    const cut: Pt[] = [p.pierce, ...p.loop, p.loop[0], ...p.overcut];
    for (let pass = 0; pass < Math.max(1, c.passes); pass++) {
      add(i, "travel", [head, p.pierce], c.rapid);
      if (c.pierceDelay > 0) add(i, "pierce", [p.pierce], 1, c.pierceDelay);
      add(i, "cut", cut, c.speed);
      head = cut[cut.length - 1];
    }
  });
  return { steps, total: t };
}

/** The step under way at time s, and the points of it done so far (the head is the last). */
export function cutAt(tl: CutTimeline, s: number): { step: number; done: Pt[] } {
  const st = tl.steps;
  if (!st.length) return { step: -1, done: [] };
  let lo = 0,
    hi = st.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (st[mid].t1 < s) lo = mid + 1;
    else hi = mid;
  }
  const k = lo;
  const step = st[k];
  const span = step.t1 - step.t0;
  const f = span > 0 ? Math.max(0, Math.min(1, (s - step.t0) / span)) : 1;
  if (step.kind === "pierce" || step.pts.length < 2) return { step: k, done: [step.pts[0]] };
  const total = step.at[step.at.length - 1];
  const d = f * total;
  const done: Pt[] = [step.pts[0]];
  for (let i = 1; i < step.pts.length; i++) {
    if (step.at[i] <= d) done.push(step.pts[i]);
    else {
      const a = step.pts[i - 1],
        b = step.pts[i],
        seg = step.at[i] - step.at[i - 1];
      const g = seg > 0 ? (d - step.at[i - 1]) / seg : 0;
      done.push([a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g]);
      break;
    }
  }
  return { step: k, done };
}

// ---------- a whole job, as the worker runs it ----------

export interface SheetRequest {
  items: NestItem[];
  nest: NestOptions;
  cut: CutSettings;
}

export interface SheetResult {
  nest: Nest;
  /** each sheet's cuts, in order */
  paths: CutPath[][];
}

export function computeSheets(req: SheetRequest): SheetResult {
  const n = nest(req.items, req.nest);
  return { nest: n, paths: n.sheets.map((s) => cutPaths(s, req.cut)) };
}

// ---------- files ----------

const f3 = (x: number) => {
  const v = Math.abs(x) < 0.0005 ? 0 : x;
  return v.toFixed(3).replace(/\.?0+$/, "") || "0";
};

/** A sheet's parts at 1:1 as closed polylines on layer CUT, in millimetres (the laser software adds the kerf). */
export function sheetDxf(parts: Placed[]): string {
  const out: string[] = [];
  const w = (code: number, v: string | number) => out.push(String(code), typeof v === "number" ? f3(v) : v);
  w(0, "SECTION");
  w(2, "HEADER");
  w(9, "$ACADVER");
  w(1, "AC1009");
  w(9, "$INSUNITS");
  w(70, 4);
  w(0, "ENDSEC");
  w(0, "SECTION");
  w(2, "TABLES");
  w(0, "TABLE");
  w(2, "LAYER");
  w(70, 1);
  w(0, "LAYER");
  w(2, "CUT");
  w(70, 0);
  w(62, 1);
  w(6, "CONTINUOUS");
  w(0, "ENDTAB");
  w(0, "ENDSEC");
  w(0, "SECTION");
  w(2, "ENTITIES");
  for (const p of parts)
    for (const l of p.region) {
      w(0, "POLYLINE");
      w(8, "CUT");
      w(66, 1);
      w(10, 0);
      w(20, 0);
      w(30, 0);
      w(70, 1);
      for (const [x, y] of l) {
        w(0, "VERTEX");
        w(8, "CUT");
        w(10, x);
        w(20, y);
        w(30, 0);
      }
      w(0, "SEQEND");
      w(8, "CUT");
    }
  w(0, "ENDSEC");
  w(0, "EOF");
  return out.join("\n") + "\n";
}

/** A sheet's parts at 1:1 as an SVG in millimetres, y up as on the machine (cut lines red, hairline). */
export function sheetSvg(parts: Placed[], sheet: [number, number]): string {
  const [W, H] = sheet;
  const d = parts
    .flatMap((p) => p.region)
    .map((l) => `M${l.map(([x, y]) => `${f3(x)} ${f3(H - y)}`).join(" L")} Z`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f3(W)}mm" height="${f3(H)}mm" viewBox="0 0 ${f3(W)} ${f3(H)}">\n  <path d="${d}" fill="none" stroke="#ff0000" stroke-width="0.1"/>\n</svg>\n`;
}

/** G-code for the cuts: GRBL laser mode (M4 with power) for lasers, torch or jet on and off with pierce waits for plasma and waterjet. */
export function sheetGcode(paths: CutPath[], c: CutterSettings, title: string, sheetNote: string): string {
  const L: string[] = [];
  const say = (s: string) => L.push(`(${s.replace(/[()]/g, "").replace(/;/g, ",")})`);
  const laser = isLaser(c.cutter);
  say(`Kerf: ${title}, ${sheetNote}`);
  say(`Zero: X0 Y0 at the sheet's front left corner${laser ? ", the laser focused on its top" : ", Z0 on its top"}`);
  say(`${CUTTERS.find((x) => x.id === c.cutter)?.label}: ${c.speed} mm/min${laser ? `, ${c.power}% power` : ""}${c.passes > 1 ? `, ${c.passes} passes` : ""}, kerf ${f3(c.kerf)} mm already allowed for`);
  if (!laser) say("No torch height control or probing here: set the cut height below, or let the controller's THC run it");
  L.push("G21 G90 G17 G94");
  L.push("M5");
  const S = Math.round(Math.max(0, Math.min(100, c.power)) * 10);
  const safe = 10,
    pierceZ = c.cutter === "plasma" ? 3.8 : 2,
    cutZ = c.cutter === "plasma" ? 1.5 : 2;
  if (!laser) L.push(`G0 Z${f3(safe)}`);
  const xy = (p: Pt) => `X${f3(p[0])} Y${f3(p[1])}`;
  for (const p of paths) {
    for (let pass = 0; pass < c.passes; pass++) {
      L.push(`G0 ${xy(p.pierce)}`);
      if (laser) {
        L.push(`M4 S${S}`);
      } else {
        L.push(`G0 Z${f3(pierceZ)}`);
        L.push("M3");
        if (c.pierceDelay > 0) L.push(`G4 P${f3(c.pierceDelay)}`);
        L.push(`G1 Z${f3(cutZ)} F${Math.round(c.speed)}`);
      }
      L.push(`G1 ${xy(p.loop[0])} F${Math.round(c.speed)}`);
      for (const q of p.loop.slice(1)) L.push(`G1 ${xy(q)}`);
      L.push(`G1 ${xy(p.loop[0])}`);
      for (const q of p.overcut) L.push(`G1 ${xy(q)}`);
      L.push("M5");
      if (!laser) L.push(`G0 Z${f3(safe)}`);
    }
  }
  L.push("G0 X0 Y0");
  L.push("M2");
  return L.join("\n") + "\n";
}

