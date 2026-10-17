// Cables that move with the machine. Parts that move together with the axes
// are grouped into carriers (the bed, the gantry, the toolhead riding on the
// gantry), and every cable from one carrier to another crosses a flex link
// between them: a drag chain where a carrier runs a long way along one level
// axis, a stiff wrapped service loop otherwise. Each link gets a fixed end on
// its parent and a moving end on its child, placed where the link clears every
// part through full travel, and is checked at poses across that travel for
// snags, bend radius, length and (for chains) how full it is. The cable runs
// on either side of a link are routed as ordinary cables (route.ts), so each
// moving cable becomes a few routed pieces joined by its links. Plain data:
// the planner runs in the cable worker and in Node tests; the 3D view redraws
// the links at each pose with flexPath.

import type { V3 } from "../../kernel/recipe";
import type { MachinePose } from "../pose";
import type { Harness, HarnessWire } from "./harness";

/** A part's box in the assembly at the shown pose. */
export interface PartBox {
  id: string;
  lo: V3;
  hi: V3;
  /** a cover or lid: nothing is tied to it */
  removable?: boolean;
  /** a made part (frame, mount, carriage): cables are tied to these rather than to bought parts */
  made?: boolean;
}

export interface Carrier {
  id: string;
  /** "toolhead", "bed", "gantry" or the axes it moves with */
  label: string;
  parts: string[];
  /** the part its links follow in the view (the biggest) */
  rep: string;
  /** displacement per mm of X, Y and Z */
  mv: [V3, V3, V3];
  axes: number[];
  /** the carrier it rides on; null: the frame */
  parent: string | null;
  lo: V3;
  hi: V3;
}

export interface ChainShape {
  /** the way the moving end goes as its axis increases */
  u: V3;
  /** from the fixed run to the moving run */
  b: V3;
  /** across the chain */
  v: V3;
  /** the bend is on the +u side (1) or the -u side (-1) */
  sigma: 1 | -1;
  /** outer width and height, mm */
  w: number;
  h: number;
  /** inner width and height, mm */
  inner: [number, number];
  pitch: number;
  /** the moving end's travel along u from where the design shows it, mm */
  aMin: number;
  aMax: number;
  /** where the moving end's bracket meets its part, where the design shows the machine */
  bracket: V3;
}

export interface FlexLink {
  /** "X", "Y", "Z", or the axes for a link that moves with more than one */
  id: string;
  kind: "chain" | "loop";
  label: string;
  child: string;
  parent: string | null;
  /** the parts the moving and fixed ends are fastened to */
  movingOn: string;
  fixedOn: string | null;
  /** the child's displacement relative to the parent, per mm of each axis */
  rel: [V3, V3, V3];
  axes: number[];
  /** fixed end, and the moving end where the design shows the machine (assembly coordinates) */
  F: V3;
  G0: V3;
  /** the way the cables leave the link at each end, into the routed runs */
  outF: V3;
  outG: V3;
  /** centre-line length, fixed end to moving end, mm */
  L: number;
  /** bend radius: the chain's, or the loop's tightest through travel */
  R: number;
  /** the tightest bend the wires allow (7.5 × the thickest wire) */
  minR: number;
  wires: string[];
  /** diameter of the bundle of cables, mm */
  bundle: number;
  chain?: ChainShape;
}

/** A routed run of a moving cable: from a plug or a link end to the next one. */
export interface WirePiece {
  /** route id, e.g. "W11.0" */
  id: string;
  wire: string;
  /** the carrier it rides on; null: the frame */
  carrier: string | null;
  a: PieceEnd;
  b: PieceEnd;
}

export type PieceEnd = { plug: 0 | 1 } | { link: string; end: "F" | "G" };

export interface TravelCheck {
  link: string;
  status: "pass" | "warn" | "fail";
  title: string;
  detail: string;
  parts: string[];
}

export interface TravelPlan {
  /** the axes: where the design shows them and their travel */
  axes: { s0: V3; range: MachinePose["range"]; on: MachinePose["axes"] };
  carriers: Carrier[];
  links: FlexLink[];
  /** the pieces of each cable that crosses a link, end 0 to end 1 */
  pieces: Record<string, WirePiece[]>;
  /** where the cables sit in each link's cross-section: offsets along (v, b) for chains, rings for loops, by wire id */
  slots: Record<string, Record<string, [number, number]>>;
  checks: TravelCheck[];
  /** the swept boxes cables on the frame keep out of, by carrier or chain, assembly coordinates */
  sweeps: { key: string; lo: V3; hi: V3 }[];
  ms: number;
}

const AXIS = ["X", "Y", "Z"];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a: V3, b: V3) => len(sub(a, b));
const ZERO = (): V3 => [0, 0, 0];

/** the usual rule for wire that flexes all the time: bend no tighter than 7.5 × its diameter */
export const FLEX_BEND = 7.5;
/** 10 × 10 mm chain, as the printer's parts list buys; the bigger bend when the wires need it */
const CHAIN = {
  w: 15,
  h: 13,
  inner: [10, 10] as [number, number],
  pitch: 15,
  radii: [18, 28],
};
/** most a chain should be filled, by cable cross-section */
const FILL = 0.6;
/** straight chain past each end of the travel, mm */
const CHAIN_SPARE = 5;

function boxDist(p: V3, lo: V3, hi: V3): number {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const d = p[k] < lo[k] ? lo[k] - p[k] : p[k] > hi[k] ? p[k] - hi[k] : 0;
    s += d * d;
  }
  return Math.sqrt(s);
}

const inBox = (p: V3, lo: V3, hi: V3, grow = 0) => p[0] > lo[0] - grow && p[0] < hi[0] + grow && p[1] > lo[1] - grow && p[1] < hi[1] + grow && p[2] > lo[2] - grow && p[2] < hi[2] + grow;

const vol = (b: { lo: V3; hi: V3 }) => (b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) * (b.hi[2] - b.lo[2]);

/** Group the moving parts into carriers and find what each one rides on. */
export function findCarriers(pose: MachinePose, boxes: Map<string, PartBox>): Carrier[] {
  const groups = new Map<string, { ids: string[]; mv: [V3, V3, V3] }>();
  for (const [id, mv] of pose.moves) {
    const key = mv.map((v) => v.map((x) => (Math.round(x * 50) / 50 + 0).toFixed(2)).join(",")).join("|");
    const g = groups.get(key) ?? { ids: [], mv };
    g.ids.push(id);
    groups.set(key, g);
  }
  const out: Carrier[] = [];
  for (const g of groups.values()) {
    const axes = [0, 1, 2].filter((k) => len(g.mv[k]) > 1e-3);
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    let rep = g.ids[0];
    let best = -1;
    for (const id of g.ids) {
      const b = boxes.get(id);
      if (!b) continue;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], b.lo[k]);
        hi[k] = Math.max(hi[k], b.hi[k]);
      }
      if (vol(b) > best) {
        best = vol(b);
        rep = id;
      }
    }
    if (!Number.isFinite(lo[0])) continue;
    const label = pose.hotId && g.ids.includes(pose.hotId) ? "toolhead" : pose.bedId && g.ids.includes(pose.bedId) ? "bed" : axes.map((k) => AXIS[k]).join("") + " carriage";
    out.push({
      id: `c${out.length}`,
      label,
      parts: g.ids,
      rep,
      mv: g.mv,
      axes,
      parent: null,
      lo,
      hi,
    });
  }
  // a carrier rides on the one that moves with a strict subset of its axes, the same way
  for (const c of out) {
    let best: Carrier | null = null;
    for (const p of out) {
      if (p === c || p.axes.length >= c.axes.length || !p.axes.every((k) => c.axes.includes(k))) continue;
      if (!p.axes.every((k) => dist(p.mv[k], c.mv[k]) < 0.02)) continue;
      if (!best || p.axes.length > best.axes.length) best = p;
    }
    c.parent = best?.id ?? null;
  }
  for (const c of out) if (c.label.endsWith("carriage") && out.some((o) => o.parent === c.id) && c.axes.length === 1 && c.axes[0] === 2) c.label = "gantry";
  return out;
}

/** A pose sample: the axis values. */
type Pose = V3;

/** Poses across a link's travel: its own axes in steps, the machine's other axes at both ends. */
function samples(pose: MachinePose, own: number[], steps = 9, others = true): Pose[] {
  const vals = [0, 1, 2].map((k) => {
    const [a, b] = pose.range[k];
    if (!pose.axes[k] || b <= a) return [pose.s0[k]];
    if (own.includes(k)) {
      const n = own.length > 1 ? 5 : steps;
      return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
    }
    return others ? [a, b] : [pose.s0[k]];
  });
  const out: Pose[] = [];
  for (const x of vals[0]) for (const y of vals[1]) for (const z of vals[2]) out.push([x, y, z]);
  return out;
}

const disp = (mv: [V3, V3, V3] | undefined, pose: MachinePose, at: Pose): V3 => {
  if (!mv) return ZERO();
  const d = [at[0] - pose.s0[0], at[1] - pose.s0[1], at[2] - pose.s0[2]];
  return [0, 1, 2].map((k) => mv[0][k] * d[0] + mv[1][k] * d[1] + mv[2][k] * d[2]) as V3;
};

// ---------- flex geometry ----------

/** The chain's centre line at a moving-end offset `a` along u: fixed run, bend, moving run. */
function chainLine(link: FlexLink, a: number, step: number): { pts: V3[]; tan: V3[] } {
  const c = link.chain!;
  const { F } = link;
  const R = link.R;
  const am = Math.min(c.aMax, Math.max(c.aMin, a));
  const sg = c.sigma;
  // L = |ab| + πR + |ab − am|, with the bend beyond both ends of the runs
  const ab = sg < 0 ? (am + Math.PI * R - link.L) / 2 : (link.L - Math.PI * R + am) / 2;
  const pts: V3[] = [];
  const tan: V3[] = [];
  const lower = Math.abs(ab);
  for (let s = 0, n = Math.max(1, Math.ceil(lower / step)), i = 0; i <= n; i++) {
    s = (lower * i) / n;
    pts.push(add(F, c.u, sg * s));
    tan.push(scale(c.u, sg));
  }
  const ctr = add(add(F, c.u, ab), c.b, R);
  const nb = Math.max(6, Math.ceil((Math.PI * R) / step));
  for (let i = 1; i <= nb; i++) {
    const th = (Math.PI * i) / nb;
    pts.push(add(add(ctr, c.b, -R * Math.cos(th)), c.u, sg * R * Math.sin(th)));
    tan.push(norm(add(scale(c.b, Math.sin(th)), c.u, sg * Math.cos(th))));
  }
  const upper = Math.abs(ab - am);
  const top = add(F, c.b, 2 * R);
  for (let n = Math.max(1, Math.ceil(upper / step)), i = 1; i <= n; i++) {
    pts.push(add(top, c.u, ab - (sg * upper * i) / n));
    tan.push(scale(c.u, -sg));
  }
  return { pts, tan };
}

function bezier(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const s = 1 - t;
  const a = s * s * s;
  const b = 3 * s * s * t;
  const c = 3 * s * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2]];
}

function polyLength(pts: V3[]) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** A loop of fixed length L from F to G, leaving F against outF and arriving at G along outG. */
function loopLine(F: V3, outF: V3, G: V3, outG: V3, L: number, n = 24): { pts: V3[]; tight: boolean } {
  const at = (k: number) => {
    const p1 = add(F, outF, -k);
    const p2 = add(G, outG, -k);
    return Array.from({ length: n + 1 }, (_, i) => bezier(F, p1, p2, G, i / n));
  };
  let lo = 0;
  let hi = Math.max(10, L);
  if (polyLength(at(0)) >= L) return { pts: at(0), tight: true };
  for (let it = 0; it < 18; it++) {
    const mid = (lo + hi) / 2;
    if (polyLength(at(mid)) < L) lo = mid;
    else hi = mid;
  }
  return { pts: at((lo + hi) / 2), tight: false };
}

/** The link's centre line, fixed end to moving end, with the moving end at `G` (assembly coordinates, parent where the design shows it). */
export function flexPath(link: FlexLink, G: V3, step = 3): { pts: V3[]; tight: boolean } {
  if (link.chain) {
    const a = dot(sub(G, link.G0), link.chain.u);
    return {
      pts: chainLine(link, a, step).pts,
      tight: a < link.chain.aMin - 0.5 || a > link.chain.aMax + 0.5,
    };
  }
  return loopLine(link.F, link.outF, G, link.outG, link.L, Math.max(12, Math.ceil(link.L / step)));
}

/** Tightest bend along a line, from the circle through each three points. */
function minRadius(pts: V3[], skip = 0): number {
  let r = Infinity;
  for (let i = 1 + skip; i < pts.length - 1 - skip; i++) {
    const a = dist(pts[i - 1], pts[i]);
    const b = dist(pts[i], pts[i + 1]);
    const c = dist(pts[i - 1], pts[i + 1]);
    const area = len(cross(sub(pts[i], pts[i - 1]), sub(pts[i + 1], pts[i - 1]))) / 2;
    if (area < 1e-9) continue;
    r = Math.min(r, (a * b * c) / (4 * area));
  }
  return r;
}

// ---------- planning ----------

interface Ctx {
  pose: MachinePose;
  boxes: PartBox[];
  byId: Map<string, PartBox>;
  carriers: Carrier[];
  carrierOf: Map<string, Carrier>;
}

interface Snag {
  part: string;
  at: Pose;
}

/** Parts the link runs into across its travel (with each part's first pose), its tightest bend, and whether it is ever pulled tight. */
function sweepLink(ctx: Ctx, link: FlexLink, steps = 9, others = true): { snags: Snag[]; minR: number; tight: boolean; poses: number } {
  const parent = link.parent ? ctx.carriers.find((c) => c.id === link.parent) : undefined;
  const child = ctx.carriers.find((c) => c.id === link.child)!;
  const poses = samples(ctx.pose, link.axes, steps, others);
  const snags = new Map<string, Snag>();
  let minR = Infinity;
  let tight = false;
  const c = link.chain;
  // points near the ends sit on the parts they are fastened to
  const ends = c ? 12 : 14;
  const SHRINK = 0.75;
  for (const at of poses) {
    const dp = disp(parent?.mv, ctx.pose, at);
    const dc = disp(child.mv, ctx.pose, at);
    const path = flexPath(link, add(link.G0, sub(dc, dp)), 4);
    if (path.tight) tight = true;
    if (!c) minR = Math.min(minR, minRadius(path.pts, 1));
    const pts = path.pts;
    const n = pts.length;
    // each point's section as a box: a chain's w × h turned with its run, a loop's round bundle
    const box = new Float64Array(n * 6);
    const plo: V3 = [Infinity, Infinity, Infinity];
    const phi: V3 = [-Infinity, -Infinity, -Infinity];
    let s = 0;
    let total = 0;
    for (let i = 1; i < n; i++) total += dist(pts[i - 1], pts[i]);
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (i) s += dist(pts[i - 1], pts[i]);
      if (s < ends || total - s < ends) continue;
      keep[i] = 1;
      let ext: V3;
      if (c) {
        const t = norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
        const nn = cross(t, c.v);
        ext = [0, 1, 2].map((k) => Math.abs(c.v[k]) * (c.w / 2) + Math.abs(nn[k]) * (c.h / 2)) as V3;
      } else ext = [link.bundle / 2, link.bundle / 2, link.bundle / 2];
      for (let k = 0; k < 3; k++) {
        const v = pts[i][k] + dp[k];
        box[i * 6 + k] = v - ext[k] + SHRINK;
        box[i * 6 + 3 + k] = v + ext[k] - SHRINK;
        plo[k] = Math.min(plo[k], box[i * 6 + k]);
        phi[k] = Math.max(phi[k], box[i * 6 + 3 + k]);
      }
    }
    for (const b of ctx.boxes) {
      if (snags.has(b.id)) continue;
      const d = disp(ctx.carrierOf.get(b.id)?.mv, ctx.pose, at);
      const lo0 = b.lo[0] + d[0],
        lo1 = b.lo[1] + d[1],
        lo2 = b.lo[2] + d[2];
      const hi0 = b.hi[0] + d[0],
        hi1 = b.hi[1] + d[1],
        hi2 = b.hi[2] + d[2];
      if (phi[0] <= lo0 || plo[0] >= hi0 || phi[1] <= lo1 || plo[1] >= hi1 || phi[2] <= lo2 || plo[2] >= hi2) continue;
      for (let i = 0; i < n; i++) {
        if (!keep[i]) continue;
        const o = i * 6;
        if (box[o + 3] <= lo0 || box[o] >= hi0 || box[o + 4] <= lo1 || box[o + 1] >= hi1 || box[o + 5] <= lo2 || box[o + 2] >= hi2) continue;
        snags.set(b.id, { part: b.id, at });
        break;
      }
    }
  }
  if (c) minR = link.R;
  return { snags: [...snags.values()], minR, tight, poses: poses.length };
}

function thickestWire(h: Harness, ids: string[]): number {
  let d = 0;
  for (const w of h.wires) if (ids.includes(w.id)) for (const x of w.wires) d = Math.max(d, x.d);
  return d;
}

function bundleOf(h: Harness, ids: string[]): number {
  const area = h.wires.filter((w) => ids.includes(w.id)).reduce((s, w) => s + w.d * w.d, 0);
  return Math.sqrt(area) * 1.12;
}

interface Destinations {
  /** where the cables go on the parent's side of the link */
  parent: V3;
  /** and on the child's side */
  child: V3;
}

/** A face of a box: outward normal and the point on it nearest `to`, kept 4 mm in from its edges. */
function facePoints(b: { lo: V3; hi: V3 }, to: V3, faces: V3[]): { p: V3; n: V3 }[] {
  const out: { p: V3; n: V3 }[] = [];
  for (const n of faces) {
    const k = n.findIndex((x) => x !== 0);
    const p: V3 = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      if (j === k) p[j] = n[k] > 0 ? b.hi[j] : b.lo[j];
      else {
        const inset = Math.min(4, (b.hi[j] - b.lo[j]) / 2);
        p[j] = Math.min(b.hi[j] - inset, Math.max(b.lo[j] + inset, to[j]));
      }
    }
    out.push({ p, n });
  }
  return out;
}

const FACES: V3[] = [
  [0, 0, 1],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, -1],
];

/** The direction along a face (normal n) from p toward `to`, or null when `to` is straight out from the face. */
function along(n: V3, p: V3, to: V3): V3 | null {
  const d = sub(to, p);
  const t = add(d, n, -dot(d, n));
  return len(t) > 0.25 * len(d) && len(t) > 1 ? norm(t) : null;
}

function planChain(ctx: Ctx, base: Omit<FlexLink, "kind" | "label" | "F" | "G0" | "outF" | "outG" | "L" | "R" | "chain">, dest: Destinations): FlexLink | null {
  if (base.axes.length !== 1) return null;
  const k = base.axes[0];
  const relv = base.rel[k];
  const speed = len(relv);
  const u = norm(relv);
  if (Math.abs(u[2]) > 0.3) return null;
  const [r0, r1] = ctx.pose.range[k];
  const aMin = (r0 - ctx.pose.s0[k]) * speed;
  const aMax = (r1 - ctx.pose.s0[k]) * speed;
  const T = aMax - aMin;
  if (T < 60) return null;
  const sm = (aMin + aMax) / 2;
  const b: V3 = [0, 0, 1];
  const v = norm(cross(b, u));
  const R = CHAIN.radii.find((r) => r >= base.minR) ?? CHAIN.radii[CHAIN.radii.length - 1];
  const L = Math.PI * R + T / 2 + 2 * CHAIN_SPARE;
  const child = ctx.carriers.find((c) => c.id === base.child)!;
  const parentBoxes = ctx.boxes.filter((bx) => (ctx.carrierOf.get(bx.id)?.id ?? null) === base.parent && !bx.removable);
  const childBoxes = ctx.boxes.filter((bx) => ctx.carrierOf.get(bx.id) === child);
  const cu = [dot(child.lo, u), dot(child.hi, u)].sort((x, y) => x - y);
  const cvs = [dot(child.lo, v), dot(child.hi, v)].sort((x, y) => x - y);
  const mu = Math.min(cu[1] - 5, Math.max(cu[0] + 5, dot(dest.child, u)));
  const Fu0 = mu + sm;
  const uLo = Fu0 - T / 2 - CHAIN_SPARE - R - 10;
  const uHi = Fu0 + T / 2 + CHAIN_SPARE + R + 10;
  const candidates: { cv: number; floor: number | null; on: string | null }[] = [];
  // along the top of a long part of the parent (a gantry's beam)
  for (const bx of parentBoxes) {
    const bu = [dot(bx.lo, u), dot(bx.hi, u)].sort((x, y) => x - y);
    if (bu[1] - bu[0] < T) continue;
    const bv = [dot(bx.lo, v), dot(bx.hi, v)].sort((x, y) => x - y);
    if (bv[1] - bv[0] < CHAIN.w * 0.6) continue;
    candidates.push({ cv: (bv[0] + bv[1]) / 2, floor: bx.hi[2], on: bx.id });
  }
  // beside the carrier, on whatever is under it
  for (const side of [-1, 1]) {
    const cv = side < 0 ? cvs[0] - 3 - CHAIN.w / 2 : cvs[1] + 3 + CHAIN.w / 2;
    let floor: number | null = null;
    let on: string | null = null;
    for (const bx of parentBoxes) {
      const bv = [dot(bx.lo, v), dot(bx.hi, v)].sort((x, y) => x - y);
      const bu = [dot(bx.lo, u), dot(bx.hi, u)].sort((x, y) => x - y);
      if (bv[1] <= cv - CHAIN.w / 2 || bv[0] >= cv + CHAIN.w / 2 || bu[1] <= uLo || bu[0] >= uHi) continue;
      if (bx.hi[2] > child.lo[2] + 5) continue;
      if (floor === null || bx.hi[2] > floor) {
        floor = bx.hi[2];
        on = bx.id;
      }
    }
    candidates.push({ cv, floor, on });
  }
  let best: { link: FlexLink; score: number } | null = null;
  for (const cand of candidates) {
    for (const sigma of [-1, 1] as const)
      for (const shift of [0, -10, 10, -20, 20, -35, 35]) {
        const Fu = Fu0 + shift;
        const fz = (cand.floor ?? child.lo[2] - 2 * R - CHAIN.h) + CHAIN.h / 2 + 0.5;
        // u and v span the level plane, so a point is u·Fu + v·cv at height fz
        const F: V3 = [u[0] * Fu + v[0] * cand.cv, u[1] * Fu + v[1] * cand.cv, fz];
        // the moving end, where the design shows the machine: at mid travel it is right over the fixed end
        const G0 = add(add(F, b, 2 * R), u, -sm);
        const out = scale(u, -sigma);
        const link: FlexLink = {
          ...base,
          kind: "chain",
          label: `${AXIS[k]} cable chain`,
          F,
          G0,
          outF: out,
          outG: out,
          L,
          R,
          fixedOn: cand.on,
          chain: {
            u,
            b,
            v,
            sigma,
            w: CHAIN.w,
            h: CHAIN.h,
            inner: CHAIN.inner,
            pitch: CHAIN.pitch,
            aMin,
            aMax,
            bracket: G0,
          },
        };
        // the moving end's bracket goes to the nearest part of the carrier
        let near = Infinity;
        for (const bx of childBoxes) {
          const d = boxDist(G0, bx.lo, bx.hi);
          if (d < near) {
            near = d;
            link.movingOn = bx.id;
            link.chain!.bracket = [0, 1, 2].map((k) => Math.min(bx.hi[k], Math.max(bx.lo[k], G0[k]))) as V3;
          }
        }
        const sw = sweepLink(ctx, link, 5);
        const exitF = add(F, out, 10);
        const score = sw.snags.length * 1000 + (cand.floor === null ? 300 : 0) + near + 0.4 * dist(exitF, dest.parent) + 0.4 * dist(add(G0, out, 10), dest.child) + Math.abs(shift) * 0.2;
        if (!best || score < best.score) best = { link, score };
        if (!sw.snags.length) break;
      }
  }
  if (!best || best.score >= 1000) return null;
  return best.link;
}

function planLoop(ctx: Ctx, base: Omit<FlexLink, "kind" | "label" | "F" | "G0" | "outF" | "outG" | "L" | "R" | "chain">, dest: Destinations): FlexLink {
  const child = ctx.carriers.find((c) => c.id === base.child)!;
  const parent = base.parent ? ctx.carriers.find((c) => c.id === base.parent) : undefined;
  const r = base.bundle / 2 + 0.5;
  // cables are tied to made parts when there are any: a frame, a mount, a carriage
  const tie = (list: PartBox[]) => (list.some((bx) => bx.made) ? list.filter((bx) => bx.made) : list);
  const childBoxes = tie(ctx.boxes.filter((bx) => ctx.carrierOf.get(bx.id) === child && vol(bx) > 2000));
  const parentBoxes = tie(ctx.boxes.filter((bx) => (ctx.carrierOf.get(bx.id)?.id ?? null) === base.parent && vol(bx) > 2000 && !bx.removable));
  const inside = (p: V3, list: PartBox[]) => list.some((bx) => inBox(p, bx.lo, bx.hi, r - 0.5));
  // the moving end at mid travel, relative to the parent
  const mid: Pose = [0, 1, 2].map((k) => (ctx.pose.axes[k] ? (ctx.pose.range[k][0] + ctx.pose.range[k][1]) / 2 : ctx.pose.s0[k])) as V3;
  const shift = sub(disp(child.mv, ctx.pose, mid), disp(parent?.mv, ctx.pose, mid));
  type End = { p: V3; out: V3; on: string; n: V3 };
  // a few of the best on each side of things, so the search sees every way round
  const diverse = (list: End[], n: number, per: number) => {
    const used = new Map<string, number>();
    const out: End[] = [];
    for (const e of list) {
      const k = e.n.join();
      if ((used.get(k) ?? 0) >= per) continue;
      used.set(k, (used.get(k) ?? 0) + 1);
      out.push(e);
      if (out.length >= n) break;
    }
    return out;
  };
  const gs: End[] = [];
  for (const bx of childBoxes)
    for (const f of facePoints(bx, dest.parent, FACES.slice(0, 5))) {
      const p = add(f.p, f.n, r);
      const out = along(f.n, p, dest.child);
      if (!out || inside(p, childBoxes)) continue;
      gs.push({ p, out, on: bx.id, n: f.n });
    }
  const gScore = (g: End) => dist(g.p, dest.parent) + 0.3 * dist(g.p, dest.child);
  gs.sort((a, b) => gScore(a) - gScore(b));
  type Cand = { G: End; F: End; score: number };
  const cands: Cand[] = [];
  for (const G of diverse(gs, 12, 3)) {
    const Gm = add(G.p, shift);
    const fs: End[] = [];
    for (const bx of parentBoxes) {
      if (boxDist(Gm, bx.lo, bx.hi) > 220) continue;
      for (const f of facePoints(bx, Gm, FACES)) {
        const p = add(f.p, f.n, r);
        const out = along(f.n, p, dest.parent);
        if (!out || inside(p, parentBoxes)) continue;
        fs.push({ p, out, on: bx.id, n: f.n });
      }
    }
    fs.sort((a, b) => dist(a.p, Gm) - dist(b.p, Gm));
    for (const F of diverse(fs, 10, 2))
      cands.push({
        G,
        F,
        score: dist(F.p, Gm) + 0.7 * dist(F.p, dest.parent) + 0.3 * dist(G.p, dest.child),
      });
  }
  const reach = (G: End, F: End) => {
    let far = 0;
    for (const at of samples(ctx.pose, base.axes, 9, false)) {
      const d = sub(disp(child.mv, ctx.pose, at), disp(parent?.mv, ctx.pose, at));
      far = Math.max(far, dist(add(G.p, d), F.p));
    }
    return far;
  };
  const make = (c: Cand, L: number): FlexLink => ({
    ...base,
    kind: "loop",
    label: `${base.axes.map((k) => AXIS[k]).join("")} cable loop`,
    F: c.F.p,
    G0: c.G.p,
    outF: c.F.out,
    outG: c.G.out,
    L: Math.round(L),
    R: 0,
    fixedOn: c.F.on,
    movingOn: c.G.on,
  });
  const judge = (link: FlexLink, sw: ReturnType<typeof sweepLink>, c: Cand) => sw.snags.length * 1000 + (sw.minR < base.minR ? 400 : 0) + (sw.tight ? 400 : 0) + 0.5 * link.L + c.score;
  // a quick look at each pair along the link's own travel, then the best few in full
  const quick = cands.map((c) => {
    const far = reach(c.G, c.F);
    const link = make(c, far + 60);
    const sw = sweepLink(ctx, link, 5, false);
    return { c, far, score: judge(link, sw, c) };
  });
  quick.sort((a, b) => a.score - b.score);
  let best: { link: FlexLink; score: number } | null = null;
  for (const q of quick.slice(0, 6)) {
    for (const extra of [30, 60, 100, 150, 210]) {
      const link = make(q.c, q.far + extra);
      const sw = sweepLink(ctx, link, 9);
      link.R = sw.minR;
      const score = judge(link, sw, q.c);
      if (!best || score < best.score) best = { link, score };
      if (!sw.snags.length && sw.minR >= base.minR && !sw.tight) break;
    }
  }
  if (best) return best.link;
  // nothing to fasten to: a loop straight between the carriers
  const G0 = [(child.lo[0] + child.hi[0]) / 2, (child.lo[1] + child.hi[1]) / 2, child.hi[2] + r] as V3;
  const F = add(G0, [0, 0, 40]);
  return {
    ...base,
    kind: "loop",
    label: "cable loop",
    F,
    G0,
    outF: [0, 0, 1],
    outG: [0, 0, -1],
    L: 120,
    R: 0,
    fixedOn: null,
    movingOn: child.rep,
  };
}

/**
 * Plan the moving cables of a design: carriers, a flex link for each carrier
 * that cables reach, and the routed pieces of each moving cable. Null when no
 * cable moves.
 */
export function planTravel(pose: MachinePose, boxes: PartBox[], h: Harness): TravelPlan | null {
  const t0 = Date.now();
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const carriers = findCarriers(pose, byId);
  if (!carriers.length) return null;
  const carrierOf = new Map<string, Carrier>();
  for (const c of carriers) for (const id of c.parts) carrierOf.set(id, c);
  const ctx: Ctx = { pose, boxes, byId, carriers, carrierOf };
  const byCarrier = new Map(carriers.map((c) => [c.id, c]));
  const chainUp = (c: Carrier | undefined): (Carrier | undefined)[] => {
    const out: (Carrier | undefined)[] = [c];
    while (c) {
      c = c.parent ? byCarrier.get(c.parent) : undefined;
      out.push(c);
    }
    return out;
  };
  // each moving cable's carriers from end 0 to end 1, through their common ancestor
  const routes = new Map<string, (Carrier | undefined)[]>();
  for (const w of h.wires) {
    const ca = carrierOf.get(w.ends[0].partId);
    const cb = carrierOf.get(w.ends[1].partId);
    if (ca === cb) continue;
    const ua = chainUp(ca);
    const ub = chainUp(cb);
    const common = ua.find((c) => ub.includes(c));
    const path = [...ua.slice(0, ua.indexOf(common) + 1), ...ub.slice(0, ub.indexOf(common)).reverse()];
    routes.set(w.id, path);
  }
  if (!routes.size) return null;
  // the cables through each carrier's link to its parent
  const through = new Map<string, string[]>();
  for (const [id, path] of routes)
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const child = a && (!b || a.parent === b.id) ? a : b!;
      through.set(child.id, [...(through.get(child.id) ?? []), id]);
    }
  const wireById = new Map(h.wires.map((w) => [w.id, w]));
  const depth = (c: Carrier) => chainUp(c).length;
  const order = [...through.keys()].map((id) => byCarrier.get(id)!).sort((a, b) => depth(a) - depth(b));
  const links = new Map<string, FlexLink>();
  const plugAt = (w: HarnessWire, e: 0 | 1) => w.ends[e].frame.o;
  const mean = (ps: V3[]): V3 =>
    ps.length
      ? (scale(
          ps.reduce((s, p) => add(s, p), ZERO()),
          1 / ps.length,
        ) as V3)
      : ZERO();
  for (const child of order) {
    const ids = through.get(child.id)!;
    const parent = child.parent ? byCarrier.get(child.parent) : undefined;
    // where the cables go next on each side
    const parentSide: V3[] = [];
    const childSide: V3[] = [];
    for (const id of ids) {
      const w = wireById.get(id)!;
      const path = routes.get(id)!;
      const i = path.indexOf(child);
      const j = path.indexOf(parent);
      // the parent's side carries on past the parent, away from the child
      const dir = j - i;
      const endP = dir < 0 ? 0 : 1;
      const next = j + dir;
      const up = parent && links.get(parent.id);
      // on through the parent's own link (planned already), else to the plug at that end
      if (next >= 0 && next < path.length && up && path[next] === (parent!.parent ? byCarrier.get(parent!.parent) : undefined)) parentSide.push(up.G0);
      else parentSide.push(plugAt(w, endP));
      childSide.push(plugAt(w, endP === 0 ? 1 : 0));
    }
    const rel = [0, 1, 2].map((k) => sub(child.mv[k], parent?.mv[k] ?? ZERO())) as [V3, V3, V3];
    const axes = [0, 1, 2].filter((k) => len(rel[k]) > 1e-3);
    const base = {
      id: axes.map((k) => AXIS[k]).join(""),
      child: child.id,
      parent: parent?.id ?? null,
      movingOn: child.rep,
      fixedOn: null as string | null,
      rel,
      axes,
      minR: FLEX_BEND * thickestWire(h, ids),
      wires: ids,
      bundle: bundleOf(h, ids),
    };
    const dest = { parent: mean(parentSide), child: mean(childSide) };
    const link = planChain(ctx, base, dest) ?? planLoop(ctx, base, dest);
    links.set(child.id, link);
  }
  const all = [...links.values()];
  // pieces: from end 0, through each link in turn, to end 1
  const pieces: Record<string, WirePiece[]> = {};
  for (const [id, path] of routes) {
    const list: WirePiece[] = [];
    let from: PieceEnd = { plug: 0 };
    let on = path[0]?.id ?? null;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const up = !!a && (!b || a.parent === b.id);
      const link = links.get(up ? a!.id : b!.id)!;
      // going up a link: in at its moving end, out at its fixed end; down: the other way
      list.push({
        id: `${id}.${list.length}`,
        wire: id,
        carrier: on,
        a: from,
        b: { link: link.id, end: up ? "G" : "F" },
      });
      from = { link: link.id, end: up ? "F" : "G" };
      on = b?.id ?? null;
    }
    list.push({
      id: `${id}.${list.length}`,
      wire: id,
      carrier: on,
      a: from,
      b: { plug: 1 },
    });
    pieces[id] = list;
  }
  const slots: TravelPlan["slots"] = {};
  for (const l of all) slots[l.id] = slotsFor(l, h);
  const checks = all.map((l) => checkLink(ctx, l, h));
  const sweeps: TravelPlan["sweeps"] = [];
  const corners = cornerPoses(pose);
  for (const c of carriers) {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const at of corners) {
      const d = disp(c.mv, pose, at);
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], c.lo[k] + d[k] - 2);
        hi[k] = Math.max(hi[k], c.hi[k] + d[k] + 2);
      }
    }
    sweeps.push({ key: c.id, lo, hi });
  }
  for (const l of all) if (l.chain) for (const b of chainBoxes(ctx, l)) sweeps.push({ key: `chain:${l.id}`, ...b });
  return {
    axes: { s0: pose.s0, range: pose.range, on: pose.axes },
    carriers,
    links: all,
    pieces,
    slots,
    checks,
    sweeps,
    ms: Date.now() - t0,
  };
}

function cornerPoses(pose: MachinePose): Pose[] {
  const vals = [0, 1, 2].map((k) => (pose.axes[k] ? pose.range[k] : [pose.s0[k]]));
  const out: Pose[] = [];
  for (const x of vals[0]) for (const y of vals[1]) for (const z of vals[2]) out.push([x, y, z]);
  return out;
}

/** The space a chain sweeps, as boxes in the assembly: its two runs and its bend, wherever its parent goes. */
function chainBoxes(ctx: Ctx, l: FlexLink): { lo: V3; hi: V3 }[] {
  const c = l.chain!;
  const parent = l.parent ? ctx.carriers.find((x) => x.id === l.parent) : undefined;
  const groups: { lo: V3; hi: V3 }[] = [0, 1, 2].map(() => ({
    lo: [Infinity, Infinity, Infinity] as V3,
    hi: [-Infinity, -Infinity, -Infinity] as V3,
  }));
  const ext = [0, 1, 2].map((k) => Math.abs(c.v[k]) * (c.w / 2) + Math.abs(c.b[k]) * (c.h / 2) + 1) as V3;
  for (let i = 0; i <= 8; i++) {
    const a = c.aMin + ((c.aMax - c.aMin) * i) / 8;
    const { pts } = chainLine(l, a, 6);
    for (const p of pts) {
      const h = dot(sub(p, l.F), c.b);
      const g = h < 1 ? 0 : h > 2 * l.R - 1 ? 1 : 2;
      for (let k = 0; k < 3; k++) {
        groups[g].lo[k] = Math.min(groups[g].lo[k], p[k] - ext[k]);
        groups[g].hi[k] = Math.max(groups[g].hi[k], p[k] + ext[k]);
      }
    }
  }
  const out: { lo: V3; hi: V3 }[] = [];
  for (const g of groups) {
    if (!Number.isFinite(g.lo[0])) continue;
    for (const at of parent ? cornerPoses(ctx.pose) : [ctx.pose.s0]) {
      const d = disp(parent?.mv, ctx.pose, at);
      out.push({ lo: add(g.lo, d), hi: add(g.hi, d) });
    }
  }
  return out;
}

/** Where each cable sits across the link: side by side in a chain, in rings in a loop's wrap. */
function slotsFor(l: FlexLink, h: Harness): Record<string, [number, number]> {
  const ws = l.wires.map((id) => h.wires.find((w) => w.id === id)!).sort((a, b) => b.d - a.d);
  const out: Record<string, [number, number]> = {};
  if (l.chain) {
    // rows across the inner width, from the bottom up
    const [iw, ih] = l.chain.inner;
    let x = -iw / 2;
    let y = -ih / 2;
    let row = 0;
    for (const w of ws) {
      if (x + w.d > iw / 2 + 0.01) {
        x = -iw / 2;
        y += row;
        row = 0;
      }
      out[w.id] = [x + w.d / 2, Math.min(ih / 2 - w.d / 2, y + w.d / 2)];
      x += w.d + 0.15;
      row = Math.max(row, w.d + 0.15);
    }
    return out;
  }
  ws.forEach((w, i) => {
    if (i === 0) return (out[w.id] = [0, 0]);
    const ring = Math.ceil((Math.sqrt(1 + (4 * i) / 3) - 1) / 2);
    const inRing = i - (3 * ring * (ring - 1) + 1);
    const a = (inRing / (6 * ring)) * Math.PI * 2;
    const pitch = ws[0].d * 0.55 + w.d * 0.55;
    out[w.id] = [Math.cos(a) * ring * pitch, Math.sin(a) * ring * pitch];
  });
  return out;
}

const fmt = (x: number) => (Math.abs(x) >= 10 ? Math.round(x).toString() : x.toFixed(1));

function poseText(ctx: Ctx, at: Pose, axes: number[]): string {
  return axes.map((k) => `${AXIS[k]} ${fmt(at[k])} mm`).join(", ");
}

function checkLink(ctx: Ctx, l: FlexLink, h: Harness): TravelCheck {
  const sw = sweepLink(ctx, l, 13);
  const child = ctx.carriers.find((c) => c.id === l.child)!;
  const travel = l.axes.map((k) => `${AXIS[k]} ${fmt(ctx.pose.range[k][0])}–${fmt(ctx.pose.range[k][1])} mm`).join(", ");
  const facts: string[] = [];
  const problems: string[] = [];
  const parts = [l.movingOn, ...(l.fixedOn ? [l.fixedOn] : [])];
  const wd = thickestWire(h, l.wires);
  const bendText = `bends at ${fmt(l.chain ? l.R : sw.minR)} mm radius (the ${fmt(wd)} mm wire needs ${fmt(l.minR)} mm)`;
  if ((l.chain ? l.R : sw.minR) + 0.05 < l.minR) problems.push(`it ${bendText}`);
  else facts.push(bendText);
  if (l.chain) {
    const area = h.wires.filter((w) => l.wires.includes(w.id)).reduce((s, w) => s + (Math.PI * w.d * w.d) / 4, 0);
    const fill = area / (l.chain.inner[0] * l.chain.inner[1]);
    const t = `${Math.round(fill * 100)}% full`;
    if (fill > FILL) problems.push(`it is ${t} (keep a chain under ${Math.round(FILL * 100)}%)`);
    else facts.push(t);
  }
  if (sw.tight) problems.push("it is pulled tight at the end of travel");
  for (const s of sw.snags.slice(0, 3)) {
    problems.push(`it hits ${s.part} at ${poseText(ctx, s.at, l.axes.length ? l.axes : [0, 1, 2])}`);
    parts.push(s.part);
  }
  if (!sw.snags.length) facts.push(`clear of every part at ${sw.poses} poses through ${travel}`);
  const what = l.chain ? `a ${l.chain.inner[0]} × ${l.chain.inner[1]} mm cable chain, ${Math.round(l.L)} mm long (${Math.ceil(l.L / l.chain.pitch)} links)` : `a wrapped service loop, ${Math.round(l.L)} mm`;
  const title = `${l.label} (${child.label})`;
  const cables = `${l.wires.join(", ")} ride ${what}`;
  if (problems.length)
    return {
      link: l.id,
      status: sw.snags.length || sw.tight ? "fail" : "warn",
      title: `${title}: ${problems[0].replace(/^it /, "")}`,
      detail: `${cables}: ${[...problems, ...facts].join("; ")}.`,
      parts,
    };
  return {
    link: l.id,
    status: "pass",
    title: `${title} clears every part through full travel`,
    detail: `${cables}: ${facts.join("; ")}.`,
    parts,
  };
}

/** The cross-section at a link end: the way the line runs there (fixed end to moving end) and two axes across it. */
export function endAxes(l: FlexLink, end: "F" | "G"): { t: V3; e1: V3; e2: V3 } {
  const t = end === "F" ? scale(l.outF, -1) : l.outG;
  const e1 = l.chain ? l.chain.v : norm(Math.abs(t[2]) < 0.9 ? cross(t, [0, 0, 1]) : cross(t, [1, 0, 0]));
  return { t, e1, e2: cross(t, e1) };
}

/** Where a cable enters or leaves a link, in its slot, where the design shows the machine. */
export function slotPoint(plan: TravelPlan, l: FlexLink, end: "F" | "G", wire: string): V3 {
  const [x, y] = plan.slots[l.id]?.[wire] ?? [0, 0];
  const { e1, e2 } = endAxes(l, end);
  return add(add(end === "F" ? l.F : l.G0, e1, x), e2, y);
}

/** How far each moving part is from where the design shows it, with the axes at `at`. */
export function travelOffsets(plan: TravelPlan, at: V3): Map<string, V3> {
  const out = new Map<string, V3>();
  const d = [0, 1, 2].map((k) => at[k] - plan.axes.s0[k]);
  for (const c of plan.carriers) {
    const o = [0, 1, 2].map((j) => c.mv[0][j] * d[0] + c.mv[1][j] * d[1] + c.mv[2][j] * d[2]) as V3;
    for (const id of c.parts) out.set(id, o);
  }
  return out;
}

/** Each moving cable's run inside its links, for the cut length: plug to plug is the routed pieces plus these. */
export function flexLengths(plan: TravelPlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of plan.links) for (const id of l.wires) out.set(id, (out.get(id) ?? 0) + l.L);
  return out;
}
