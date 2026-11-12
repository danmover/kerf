// 2.5D milling toolpaths for one setup: the tool comes down -Z into a block or sheet of stock, level by level.
// At each level the part's material from there up (what the tool cannot pass through) is grown by the tool's
// radius; the tool's centre may go anywhere else over the stock. That area is cleared in rings from the inside
// out (each ring a stepover in from the last), leaving a little on the walls, which a last pass at each level
// takes off. Smaller tools then clear only what the larger left (inside corners, narrow slots). A sheet held by
// tabs is cut out along a slot round the part instead of clearing all the stock round it, lifting over the tabs
// near the bottom. Whatever no tool can reach is measured and reported, small round holes as holes to drill.

import { area, bounds, diff, inside, inter, islands, loopArea, offset, pathLength, rect, segmentInside, union, type Loop, type Pt, type Region } from "./clip";
import { cutting, drilling, FRAME_SPEED, type Cutting, type Frame } from "./feeds";

export interface CamTool {
  d: number;
  /** flute or neck length: how deep below the stock top it can cut, mm */
  reach: number;
  flutes?: number;
  /** a twist drill: it only drills round holes of its own size, straight down */
  drill?: boolean;
}

/** tabs: cut through, held by tabs at the bottom; base: leave the stock under the part (a vise holds it); none: cut through */
export type Hold = "tabs" | "base" | "none";

/** The part as the planner sees it, turned so the tool comes down -Z. */
export interface CamPart {
  /** its material just above height z */
  section(z: number): Region;
  /** heights of flat faces facing the tool, highest first */
  floors: number[];
  top: number;
  bottom: number;
  lo: Pt;
  hi: Pt;
}

export interface CamStock {
  lo: Pt;
  hi: Pt;
  top: number;
  bottom: number;
}

export interface CamSettings {
  stock: CamStock;
  tools: CamTool[];
  material: string;
  frame: Frame;
  rpmMax: number;
  hold: Hold;
  /** left on the walls by roughing for a finishing pass, mm (0: no finishing pass) */
  allowance: number;
  /** sideways step as a share of the tool's diameter */
  stepover: number;
  /** deepest pass, mm (the table's for the material and frame when left out) */
  stepdown?: number;
  /** count 0: by the outline's length */
  tabs: { count: number; width: number; height: number };
  /** how far below the part a cut-out goes, mm */
  through: number;
  /** clearance above the stock top for moves between cuts, mm */
  safe: number;
  /** climb milling (the usual on a rigid machine); false: conventional */
  climb: boolean;
}

export const DEFAULT_SETTINGS: Omit<CamSettings, "stock" | "tools" | "material" | "frame" | "rpmMax" | "hold"> = {
  allowance: 0.2,
  stepover: 0.4,
  tabs: { count: 0, width: 6, height: 2 },
  through: 0.3,
  safe: 5,
  climb: true,
};

export type MoveKind = "rapid" | "feed" | "ramp" | "plunge";
export interface CamMove {
  k: MoveKind;
  p: [number, number, number];
}

export type OpKind = "face" | "rough" | "finish" | "rest" | "drill";

export interface CamOp {
  kind: OpKind;
  label: string;
  /** index into the settings' tools */
  tool: number;
  d: number;
  cut: Cutting;
  moves: CamMove[];
  seconds: number;
  /** length of cutting moves, mm */
  length: number;
  /** the width the simulation cuts, when not d: a drill no wider than its hole as the part's facets have it */
  stampD?: number;
}

export interface CamPlan {
  ops: CamOp[];
  seconds: number;
  warnings: string[];
  /** material no tool could take off: the most at any level (mm²), how deep it goes, and small round holes in it */
  left: { area: number; depth: number; holes: { c: Pt; d: number; top: number; bottom: number }[] };
  stock: CamStock;
  safeZ: number;
  /** where the tabs are, on the part's outline */
  tabs: Pt[];
  /** the levels cut, highest first */
  levels: number[];
}

const EPS = 1e-6;

/** Heights from top down to deep, stopping at each stop on the way and never more than step apart. */
export function levelsDown(top: number, stops: number[], deep: number, step: number): number[] {
  const out: number[] = [];
  let prev = top;
  const at = [...new Set([...stops.filter((f) => f < top - EPS && f > deep + EPS), deep])].sort((a, b) => b - a);
  for (const z of at) {
    if (z >= prev - EPS) continue;
    const n = Math.max(1, Math.ceil((prev - z) / step - 1e-9));
    for (let k = 1; k <= n; k++) out.push(+(prev - ((prev - z) * k) / n).toFixed(4));
    prev = z;
  }
  return out;
}

/** Small specks and hairlines taken out of an area (they are offsets' rounding, not material). */
const opened = (r: Region, w = 0.02): Region => offset(offset(r, -w), w);

/** Sample of a loop's points, at most n. */
function sample(l: Loop, n: number): Pt[] {
  if (l.length <= n) return l;
  const step = l.length / n;
  return Array.from({ length: n }, (_, i) => l[Math.floor(i * step)]);
}

/** The loop started at its point nearest p. */
function startNear(l: Loop, p: Pt): Loop {
  let bi = 0,
    bd = Infinity;
  for (let i = 0; i < l.length; i++) {
    const d = (l[i][0] - p[0]) ** 2 + (l[i][1] - p[1]) ** 2;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi ? [...l.slice(bi), ...l.slice(0, bi)] : l;
}

const dist2 = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Loops in the order a tool takes them: each next the nearest to where the last ended. */
function nearestOrder(loops: Loop[], from: Pt): Loop[] {
  const left = loops.slice();
  const out: Loop[] = [];
  let at = from;
  while (left.length) {
    let bi = 0,
      bd = Infinity;
    left.forEach((l, i) => {
      for (const q of sample(l, 24)) {
        const d = dist2(q, at);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
    });
    const l = startNear(left.splice(bi, 1)[0], at);
    out.push(l);
    at = l[0];
  }
  return out;
}

/** Writes moves for one tool: rapids between cuts at a safe height, ramps into material, straight links where they are safe. */
class Mover {
  moves: CamMove[] = [];
  pos: [number, number, number];
  constructor(
    readonly safeZ: number,
    readonly cut: Cutting,
    readonly d: number,
  ) {
    this.pos = [NaN, NaN, safeZ];
  }
  private push(k: MoveKind, p: [number, number, number]) {
    const q = this.pos;
    if (Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6 && Math.abs(q[2] - p[2]) < 1e-6) return;
    this.moves.push({ k, p });
    this.pos = p;
  }
  retract() {
    if (this.pos[2] < this.safeZ - 1e-6) this.push("rapid", [this.pos[0], this.pos[1], this.safeZ]);
  }
  /**
   * Cut a closed loop at height z. link: the area the tool's centre may cross at this height without touching
   * the part, for a straight move from where it is; from: the height already cleared above the loop; air: the
   * start is clear of the stock, so it goes straight down.
   */
  loop(l: Loop, z: number, link: Region | null, from: number, air: (p: Pt) => boolean, cleared = false) {
    const s = l[0];
    const at: Pt = [this.pos[0], this.pos[1]];
    const here = Math.abs(this.pos[2] - z) < 1e-6 && Number.isFinite(at[0]);
    if (here && link && dist2(at, s) <= this.d * 1.01 && segmentInside(at, s, link)) this.push("feed", [s[0], s[1], z]);
    else {
      this.retract();
      this.push("rapid", [s[0], s[1], this.safeZ]);
      const above = Math.min(this.safeZ, from + 1);
      this.push("rapid", [s[0], s[1], above]);
      this.enter(l, z, from, air(s), cleared);
    }
    for (let i = 1; i < l.length; i++) this.push("feed", [l[i][0], l[i][1], z]);
    this.push("feed", [s[0], s[1], z]);
  }
  /**
   * Down from just above `from` to z: straight down in the air, beside a floor already cleared or on a loop too
   * small to ramp round, else ramped along the loop.
   */
  private enter(l: Loop, z: number, from: number, air: boolean, cleared: boolean) {
    const s = l[0];
    const drop = from - z;
    const per = pathLength(l, true);
    if (air) {
      this.push("rapid", [s[0], s[1], z + 0.5]);
      this.push("plunge", [s[0], s[1], z]);
      return;
    }
    if (cleared || drop <= 0.05 || per < 1.5 * this.d) {
      this.push("plunge", [s[0], s[1], z]);
      return;
    }
    // ramp round the loop, as many times round as the angle needs, then on at depth back to the start
    const run = drop / Math.tan((this.cut.rampDeg * Math.PI) / 180);
    this.push("plunge", [s[0], s[1], from + 0.2]);
    let travelled = 0;
    let i = 0;
    let zc = from + 0.2;
    const n = l.length;
    while (zc > z + 1e-9) {
      const a = l[i % n],
        b = l[(i + 1) % n];
      const seg = dist2(a, b);
      travelled += seg;
      zc = Math.max(z, from + 0.2 - ((drop + 0.2) * travelled) / run);
      this.push("ramp", [b[0], b[1], zc]);
      i++;
      if (i > n * 50) break;
    }
    // finish the lap at depth back round to the start
    const k = i % n;
    if (k !== 0) for (let j = k + 1; j <= n; j++) this.push("feed", [l[j % n][0], l[j % n][1], z]);
  }
}

function seconds(moves: CamMove[], cut: Cutting, frame: Frame, from: [number, number, number]): { s: number; length: number } {
  let s = 0,
    length = 0;
  let p = from;
  const rapid = FRAME_SPEED[frame].rapid;
  for (const m of moves) {
    if (Number.isFinite(p[0])) {
      const d = Math.hypot(m.p[0] - p[0], m.p[1] - p[1], m.p[2] - p[2]);
      const rate = m.k === "rapid" ? rapid : m.k === "plunge" ? cut.plunge : m.k === "ramp" ? cut.ramp : cut.feed;
      s += (d / rate) * 60;
      if (m.k !== "rapid") length += d;
    }
    p = m.p;
  }
  return { s, length };
}

/** Tab positions spread along each outline of the part, by length. */
function tabPoints(outer: Loop[], count: number): Pt[] {
  const out: Pt[] = [];
  for (const l of outer) {
    const per = pathLength(l, true);
    const n = count > 0 ? count : Math.max(2, Math.min(8, Math.round(per / 150)));
    for (let k = 0; k < n; k++) {
      let want = ((k + 0.5) * per) / n;
      for (let i = 0; i < l.length; i++) {
        const a = l[i],
          b = l[(i + 1) % l.length];
        const seg = dist2(a, b);
        if (want <= seg) {
          const t = seg ? want / seg : 0;
          out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
          break;
        }
        want -= seg;
      }
    }
  }
  return out;
}

/** Lift cutting moves below zTab over the tabs: inside a tab's reach and outside the part's outline. */
function liftOverTabs(moves: CamMove[], tabs: Pt[], reach: number, zTab: number, outline: Region): CamMove[] {
  if (!tabs.length) return moves;
  const inTab = (x: number, y: number) => tabs.some((t) => Math.hypot(x - t[0], y - t[1]) < reach) && !inside([x, y], outline);
  const out: CamMove[] = [];
  let prev: [number, number, number] | null = null;
  for (const m of moves) {
    if (!prev || m.k === "rapid" || Math.min(prev[2], m.p[2]) >= zTab) {
      out.push(m);
      prev = m.p;
      continue;
    }
    // below the tabs' top: in short steps, held at the top over a tab, straight up and down at its edges
    const a = prev,
      b = m.p;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
    let was = a[2] < zTab && inTab(a[0], a[1]);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = a[0] + (b[0] - a[0]) * t,
        y = a[1] + (b[1] - a[1]) * t,
        z = a[2] + (b[2] - a[2]) * t;
      const now = z < zTab && inTab(x, y);
      const q = out[out.length - 1].p;
      if (now && !was) out.push({ k: "feed", p: [q[0], q[1], zTab] });
      else if (!now && was) out.push({ k: "plunge", p: [q[0], q[1], z] });
      out.push({ k: m.k, p: [x, y, now ? zTab : z] });
      was = now;
    }
    prev = m.p;
  }
  return straighten(out);
}

/** Points in the middle of a straight run of the same kind of move dropped. */
function straighten(moves: CamMove[]): CamMove[] {
  const out: CamMove[] = [];
  for (const m of moves) {
    const n = out.length;
    if (n >= 2 && out[n - 1].k === m.k && out[n - 2].k === m.k) {
      const a = out[n - 2].p,
        b = out[n - 1].p,
        c = m.p;
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        w = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
      const cr = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
      const lu = Math.hypot(u[0], u[1], u[2]),
        lw = Math.hypot(w[0], w[1], w[2]);
      if (lu > 0 && lw > 0 && cr / (lu * lw) < 1e-7 && u[0] * w[0] + u[1] * w[1] + u[2] * w[2] > 0) {
        out[n - 1] = m;
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/** Round pieces of an area that look like holes: about as wide as tall and nearly a disc. */
function roundPieces(r: Region): { c: Pt; d: number; inner: number; a: number }[] {
  const out: { c: Pt; d: number; inner: number; a: number }[] = [];
  for (const isl of islands(r)) {
    if (isl.holes.length) continue;
    const b = bounds([isl.outer]);
    if (!b) continue;
    const w = b.hi[0] - b.lo[0],
      h = b.hi[1] - b.lo[1];
    if (w < 0.2 || Math.abs(w - h) > 0.08 * Math.max(w, h)) continue;
    const a = area([isl.outer]);
    const disc = (Math.PI * w * h) / 4;
    if (Math.abs(a - disc) > 0.1 * disc) continue;
    // the centre as the area's centroid: the bounding box of a faceted circle sits a little off it
    const l0 = isl.outer;
    let cx = 0,
      cy = 0,
      a2 = 0;
    for (let i = 0, j = l0.length - 1; i < l0.length; j = i++) {
      const cr = l0[j][0] * l0[i][1] - l0[i][0] * l0[j][1];
      a2 += cr;
      cx += (l0[j][0] + l0[i][0]) * cr;
      cy += (l0[j][1] + l0[i][1]) * cr;
    }
    const c: Pt = Math.abs(a2) > 1e-12 ? [cx / (3 * a2), cy / (3 * a2)] : [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2];
    // the widest circle inside it (the facets sit inside the true circle)
    let inner = Infinity;
    const l = isl.outer;
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) inner = Math.min(inner, segDist(c, l[j], l[i]));
    out.push({ c, d: +((w + h) / 2).toFixed(1), inner: 2 * inner, a });
  }
  return out;
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function planCam(part: CamPart, s: CamSettings): CamPlan {
  const warnings: string[] = [];
  const st = s.stock;
  const safeZ = st.top + s.safe;
  const empty: CamPlan = { ops: [], seconds: 0, warnings, left: { area: 0, depth: 0, holes: [] }, stock: st, safeZ, tabs: [], levels: [] };
  const tools = s.tools.map((t, i) => ({ ...t, i })).filter((t) => !t.drill && t.d > 0 && t.reach > 0);
  tools.sort((a, b) => b.d - a.d);
  if (!tools.length) {
    warnings.push("No end mills to cut with: give the process a tools list or a tool_d");
    return empty;
  }
  if (part.lo[0] < st.lo[0] - 1e-3 || part.lo[1] < st.lo[1] - 1e-3 || part.hi[0] > st.hi[0] + 1e-3 || part.hi[1] > st.hi[1] + 1e-3 || part.top > st.top + 1e-3) warnings.push("The part does not fit inside the stock: make the stock larger");
  const sheet = s.hold !== "base";
  const deep = sheet ? part.bottom - s.through : part.bottom;
  if (!sheet && part.bottom <= st.bottom + 1e-3) warnings.push("Leaving a base needs stock below the part: make the stock thicker than the part, or hold it with tabs");
  const stockRegion = rect(st.lo[0], st.lo[1], st.hi[0], st.hi[1]);
  // what must come off: all the stock round the part, or for a sheet only what frees the part from it
  const floors = part.floors.filter((f) => f < st.top - EPS && f > deep + EPS);
  const stops = part.top < st.top - EPS ? [part.top, ...floors] : floors;

  // each tool's levels, and the part's material from each level up
  const plans = tools.map((t) => {
    const cut = cutting(t.d, s.material, s.frame, s.rpmMax, { stepover: s.stepover, stepdown: s.stepdown, flutes: t.flutes });
    const lv = levelsDown(st.top, stops, deep, cut.stepdown).filter((z) => z >= st.top - t.reach - EPS);
    return { t, cut, levels: lv };
  });
  const allZ = [...new Set(plans.flatMap((p) => p.levels).concat(stops, [deep]))].sort((a, b) => b - a);
  const keep = new Map<number, Region>();
  {
    let acc: Region = [];
    for (const z of allZ) {
      const sec = part.section(z);
      acc = sec.length ? union(acc, sec) : acc;
      keep.set(z, acc);
    }
  }
  const keepAt = (z: number) => keep.get(z) ?? [];
  const silhouette = keepAt(deep);
  const outline = union(...islands(silhouette).map((i) => [i.outer]));
  const target = sheet ? inter(stockRegion, offset(outline, 0.15)) : stockRegion;
  const tabs = s.hold === "tabs" ? tabPoints(islands(outline).map((i) => i.outer), s.tabs.count) : [];
  const zTab = deep + s.through + s.tabs.height;
  if (s.hold === "tabs" && s.tabs.height >= part.top - part.bottom) warnings.push("The tabs are as tall as the part: make them lower");

  // what each tool has cleared at each of its levels (its centre's area grown by its radius)
  const swept: { levels: number[]; at: Map<number, Region> }[] = [];
  const sweptBefore = (k: number, z: number): Region => {
    const parts: Region[] = [];
    for (let j = 0; j < k; j++) {
      const below = swept[j].levels.filter((x) => x <= z + EPS);
      if (below.length) parts.push(swept[j].at.get(below[0]) ?? []);
    }
    return parts.length > 1 ? union(...parts) : (parts[0] ?? []);
  };

  const ops: CamOp[] = [];
  let pos: [number, number, number] = [NaN, NaN, safeZ];
  plans.forEach(({ t, cut, levels }, k) => {
    const r = t.d / 2;
    const a = s.allowance > 0 ? s.allowance : 0;
    const own = new Map<number, Region>();
    swept.push({ levels, at: own });
    const reachOut = offset(stockRegion, r);
    const bounds = sheet ? inter(reachOut, offset(outline, 2.5 * r + a + 0.05)) : reachOut;
    const air = (p: Pt) => !inside(p, reachOut);
    const rough = new Mover(safeZ, cut, t.d);
    const face = new Mover(safeZ, cut, t.d);
    const fin = new Mover(safeZ, cut, t.d);
    rough.pos = face.pos = fin.pos = pos;
    let prevZ = st.top;
    const finishLevels: { z: number; centre: Region; from: number; only: Region | null }[] = [];
    for (const z of levels) {
      const K = keepAt(z);
      let C = diff(bounds, offset(K, r + a));
      let only: Region | null = null;
      if (k > 0) {
        const rem = opened(diff(diff(target, K), sweptBefore(k, z)));
        if (area(rem) < 0.05) {
          own.set(z, sweptBefore(k, z));
          prevZ = z;
          continue;
        }
        only = offset(rem, r + 0.05);
        C = inter(C, only);
      }
      C = C.filter((l) => Math.abs(area([l])) > 1e-4 || area([l]) < 0);
      // levels at the part's top or above it only take the stock down to it
      const mover = z >= part.top - EPS ? face : rough;
      if (C.length) {
        const rings: Region[] = [];
        for (let n = 0; n < 5000; n++) {
          const ring = n ? offset(C, -n * cut.stepover) : C;
          if (!ring.length) break;
          rings.push(ring);
        }
        let from: Pt = Number.isFinite(mover.pos[0]) ? [mover.pos[0], mover.pos[1]] : [st.lo[0], st.lo[1]];
        for (let n = rings.length - 1; n >= 0; n--) {
          const inner = rings[n + 1] ?? [];
          for (const l of nearestOrder(rings[n], from)) {
            const loop = s.climb ? l : [l[0], ...l.slice(1).reverse()];
            // a ring with a smaller one inside it has its middle cleared already: no need to ramp in
            const cleared = inner.some((q) => loopArea(q) > 0 && inside(q[0], [l]));
            mover.loop(loop, z, C, prevZ, air, cleared);
          }
          from = [mover.pos[0], mover.pos[1]];
        }
      }
      own.set(z, union(offset(C, r), k > 0 ? sweptBefore(k, z) : []));
      if (a > 0 && z < part.top - EPS) finishLevels.push({ z, centre: diff(bounds, offset(K, r)), from: prevZ, only });
      prevZ = z;
    }
    // the last pass on the walls at each level, top down
    for (const f of finishLevels) {
      const K = keepAt(f.z);
      const wall = offset(K, r + 0.05);
      let loops = f.centre.filter((l) => {
        const pts = sample(l, 12);
        return pts.filter((p) => inside(p, wall)).length >= pts.length * 0.6;
      });
      if (f.only) loops = loops.filter((l) => sample(l, 12).some((p) => inside(p, f.only!)));
      let from: Pt = Number.isFinite(fin.pos[0]) ? [fin.pos[0], fin.pos[1]] : [st.lo[0], st.lo[1]];
      for (const l of nearestOrder(loops, from)) {
        const loop = s.climb ? l : [l[0], ...l.slice(1).reverse()];
        fin.loop(loop, f.z, f.centre, f.from, air, true);
        from = [fin.pos[0], fin.pos[1]];
      }
      own.set(f.z, union(own.get(f.z) ?? [], inter(offset(f.centre, r), offset(K, 2 * r + 0.01))));
    }
    const tabReach = Math.hypot(s.tabs.width / 2 + r, 2.5 * r + a + 0.05);
    const named = (kind: OpKind, m: Mover, label: string) => {
      if (!m.moves.length) return;
      m.retract();
      const moves = s.hold === "tabs" ? liftOverTabs(m.moves, tabs, tabReach, zTab, outline) : m.moves;
      const tm = seconds(moves, cut, s.frame, pos);
      ops.push({ kind, label, tool: t.i, d: t.d, cut, moves, seconds: tm.s, length: tm.length });
      pos = moves[moves.length - 1].p;
    };
    const dmm = `Ø${+t.d.toFixed(2)} mm`;
    named("face", face, `Face the stock top with the ${dmm} end mill`);
    named(k ? "rest" : "rough", rough, k ? `Clear what the larger tools left (inside corners, narrow places) with the ${dmm} end mill` : `Rough out with the ${dmm} end mill, ${+cut.stepdown.toFixed(2)} mm passes${a ? `, leaving ${a} mm on the walls` : ""}`);
    named("finish", fin, `Finish the walls with the ${dmm} end mill`);
  });

  // what no tool took off
  let leftArea = 0,
    leftTop = -Infinity,
    leftBottom = Infinity;
  const holes = new Map<string, { c: Pt; d: number; inner: number; top: number; bottom: number }>();
  /** the most material left at a level that is not a hole to drill */
  let otherArea = 0;
  for (const z of allZ) {
    if (z > st.top - EPS) continue;
    const rem = opened(diff(diff(target, keepAt(z)), sweptBefore(swept.length, z)), 0.03);
    const ar = area(rem);
    if (ar < 0.05) continue;
    leftArea = Math.max(leftArea, ar);
    leftTop = Math.max(leftTop, z);
    leftBottom = Math.min(leftBottom, z);
    const round = roundPieces(rem);
    otherArea = Math.max(otherArea, ar - round.reduce((x, h) => x + h.a, 0));
    for (const { c, d, inner } of round) {
      const key = `${Math.round(c[0] * 5)},${Math.round(c[1] * 5)}`;
      const was = holes.get(key);
      if (was) {
        was.top = Math.max(was.top, z);
        was.bottom = Math.min(was.bottom, z);
        was.inner = Math.min(was.inner, inner);
      } else holes.set(key, { c, d, inner, top: z, bottom: z });
    }
  }
  const reachMax = tools.length ? Math.max(...tools.map((t) => t.reach)) : 0;
  if (tools.length && st.top - deep > reachMax + EPS) warnings.push(`The cut goes ${+(st.top - deep).toFixed(2)} mm deep but the longest tool reaches ${reachMax} mm: the deepest ${+(st.top - deep - reachMax).toFixed(2)} mm is left`);
  const holeList = [...holes.values()];

  // drills take the holes their own size, last so the end mills need no second change
  const drills = s.tools
    .map((t, i) => ({ ...t, i }))
    .filter((t) => t.drill && t.d > 0 && t.reach > 0)
    .sort((a, b) => b.d - a.d);
  const drilled = new Set<(typeof holeList)[number]>();
  const R = st.top + 1;
  for (const dr of drills) {
    const fits = (h: (typeof holeList)[number]) => !drilled.has(h) && h.d >= dr.d - 0.06 && h.d - dr.d <= Math.max(0.25, 0.08 * h.d);
    let mine = holeList.filter(fits);
    if (!mine.length) continue;
    const cut = drilling(dr.d, s.material, s.frame, s.rpmMax);
    const moves: CamMove[] = [];
    let at: Pt = Number.isFinite(pos[0]) ? [pos[0], pos[1]] : [st.lo[0], st.lo[1]];
    let short = 0;
    const taken: typeof holeList = [];
    while (mine.length) {
      // the nearest hole next
      let bi = 0;
      for (let i = 1; i < mine.length; i++) if (Math.hypot(mine[i].c[0] - at[0], mine[i].c[1] - at[1]) < Math.hypot(mine[bi].c[0] - at[0], mine[bi].c[1] - at[1])) bi = i;
      const h = mine[bi];
      mine = mine.filter((_, i) => i !== bi);
      drilled.add(h);
      taken.push(h);
      // through holes: the point goes on through; blind ones stop at their floor
      const through = h.bottom <= deep + EPS;
      let end = through ? h.bottom - 0.3 * dr.d : h.bottom;
      if (st.top - end > dr.reach + EPS) {
        end = st.top - dr.reach;
        short++;
      }
      const [x, y] = h.c;
      moves.push({ k: "rapid", p: [x, y, moves.length ? R : safeZ] });
      if (moves.length === 1) moves.push({ k: "rapid", p: [x, y, R] });
      let z = Math.min(st.top, R);
      let first = true;
      while (z > end + EPS) {
        const next = Math.max(end, z - cut.stepdown);
        if (!first) moves.push({ k: "rapid", p: [x, y, z + 0.5] });
        moves.push({ k: "plunge", p: [x, y, next] });
        // out to clear the chips
        moves.push({ k: "rapid", p: [x, y, R] });
        z = next;
        first = false;
      }
      at = h.c;
    }
    moves.push({ k: "rapid", p: [at[0], at[1], safeZ] });
    const tm = seconds(moves, cut, s.frame, pos);
    const stampD = Math.min(dr.d, ...taken.map((h) => h.inner));
    ops.push({ kind: "drill", label: `Drill ${taken.length} hole${taken.length > 1 ? "s" : ""} with the Ø${+dr.d.toFixed(2)} mm drill, ${+cut.stepdown.toFixed(2)} mm pecks`, tool: dr.i, d: dr.d, cut, moves, seconds: tm.s, length: tm.length, stampD });
    pos = moves[moves.length - 1].p;
    if (short) warnings.push(`The Ø${+dr.d.toFixed(2)} mm drill reaches ${dr.reach} mm: ${short} hole${short > 1 ? "s are" : " is"} not drilled to the bottom`);
  }
  const undrilled = holeList.filter((h) => !drilled.has(h));
  if (undrilled.length) {
    const sizes = [...new Set(undrilled.map((h) => h.d))].sort((x, y) => x - y);
    const many = undrilled.length > 1;
    warnings.push(`${undrilled.length} hole${many ? "s" : ""} (Ø${sizes.join(", Ø")} mm) ${many ? "are" : "is"} smaller than the smallest end mill: add ${sizes.length > 1 ? "drills that size" : `a Ø${sizes[0]} mm drill`} to the tools to drill ${many ? "them" : "it"} here, or drill ${many ? "them" : "it"} after`);
  }
  if (otherArea > 0.05) warnings.push(`Some material is left where no tool fits (up to ${+otherArea.toFixed(1)} mm² at a level, inside corners or narrow slots): add a smaller tool, or round those corners`);
  const levels = [...new Set(plans.flatMap((p) => p.levels))].sort((a, b) => b - a);
  return { ops, seconds: ops.reduce((x, o) => x + o.seconds, 0), warnings, left: { area: leftArea, depth: leftTop > -Infinity ? leftTop - leftBottom : 0, holes: undrilled.map(({ c, d, top, bottom }) => ({ c, d, top, bottom })) }, stock: st, safeZ, tabs, levels };
}
