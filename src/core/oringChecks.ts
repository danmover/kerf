// Checks on O-rings that seal (lib.oring). An O-ring seals by being squeezed
// between the bottom of a groove and the surface facing it, so everything
// here starts from the gland as it is drawn: Kerf measures the room round the
// ring on the parts' own surfaces, then works out the squeeze, the stretch
// and how full the groove is.
//
// The figures the checks hold to are Apple Rubber's (Seal Design Guide):
// squeeze of 10 to 40 % for a seal that stays still and 10 to 30 % for one
// that moves; no more than 5 % stretch on the inside diameter, with 2 % the
// aim on a piston; a ring that is never bigger than its gland; no stretch
// over a turning shaft; and a face seal seated against the low-pressure side
// of its groove. Where Kerf adds a rule of its own, the message says so.

import type { CheckItem } from "./checks";
import type { EvalPart, Model, Motion, OringInfo } from "./model";
import { bvhOf, motionOfPart, type Holds, type MeshLookup } from "./holds";
import type { TriBVH } from "../mfg/bvh";
import type { Interference } from "../kernel/protocol";
import { frameFor, xformMatrix, type V3 } from "../kernel/recipe";
import { fmtNum } from "../lang/values";

/** Apple Rubber: how much of the cord's thickness is squeezed away. */
const SQUEEZE = { static: [0.1, 0.4], moving: [0.1, 0.3] } as const;
/** What Kerf aims a fix at, inside those ranges. */
const AIM = { static: 0.25, moving: 0.2 } as const;
/** Apple Rubber: stretch on the inside diameter as fitted, and what to aim for on a piston. */
const STRETCH_MAX = 0.05;
const STRETCH_AIM = 0.02;
/** Kerf's own margin under Apple Rubber's "never bigger than its gland": rubber grows with heat and swells in oil. */
const FILL_WARN = 0.9;
/** Kerf's own rule: a ring this much too long for where it sits has to bunch up to go in. */
const BUNCH_WARN = 0.05;
/** How close to a wall counts as seated against it, as a share of the cord. */
const SEATED = 0.05;

const ANGLES = 8;
/** angles that keep clear of the axes and diagonals, where mesh vertices line up */
const ANGLE0 = 0.37;
/** Corners of one flat or round face agree this closely, mm. */
const SNAP = 2e-3;

const N = (x: number, d = 2) => fmtNum(x, d);
const pct = (x: number, d = 0) => `${fmtNum(x * 100, d)} %`;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const mode = <T>(xs: T[]): T | undefined => {
  let best: T | undefined;
  let n = 0;
  for (const x of xs) {
    const k = xs.filter((y) => y === x).length;
    if (k > n) [best, n] = [x, k];
  }
  return best;
};

/** One surface a ray crosses: how far along, whether it goes into the part there, and the corners of the triangle it met. */
interface Cross {
  t: number;
  enter: boolean;
  part: EvalPart;
  /** the triangle's corners in the ring's own terms: distance from its axis, and height along it from its middle */
  rs: number[];
  zs: number[];
}

interface Probe {
  part: EvalPart;
  bvh: TriBVH;
  M: number[];
  /** the ring's middle and axis in the part's own coordinates */
  cl: V3;
  nl: V3;
}

/**
 * Meshes stand off round surfaces by their chords, but their corners are on the true surface. A triangle whose three
 * corners are the same distance from the ring's axis is on a round face about that axis, and that distance is exact;
 * one whose corners are at the same height is on a flat face square to the axis.
 */
const exactR = (c: Cross | undefined, fallback: number) => (c && Math.max(...c.rs) - Math.min(...c.rs) < SNAP ? (c.rs[0] + c.rs[1] + c.rs[2]) / 3 : fallback);
const exactZ = (c: Cross | undefined, fallback: number) => (c && Math.max(...c.zs) - Math.min(...c.zs) < SNAP ? (c.zs[0] + c.zs[1] + c.zs[2]) / 3 : fallback);
/** The corner of a wall's triangle nearest to where rays stop finding the wall: the wall's true edge. */
const edgeNear = (xs: number[] | undefined, x: number, tol: number) => {
  let best = x;
  let d = tol;
  for (const v of xs ?? []) if (Math.abs(v - x) < d) [best, d] = [v, Math.abs(v - x)];
  return best;
};

/** The parts near a ring, ready to have rays cast at them. */
class Room {
  private probes: Probe[] = [];
  readonly u: V3;
  readonly v: V3;
  constructor(
    readonly o: OringInfo,
    ring: EvalPart,
    model: Model,
    mesh: MeshLookup,
  ) {
    const f = frameFor(o.axis);
    this.u = f.u;
    this.v = f.v;
    const reach = o.id / 2 + 8 * o.cs;
    for (const p of model.parts) {
      if (p === ring || p.oring || p.hidden === true) continue;
      const m = mesh(p.hash);
      if (!m || !m.indices.length) continue;
      const M = xformMatrix(p.xf);
      const cl = this.inv(M, o.center);
      // nowhere near: the part's box, in its own coordinates, against a ball round the ring
      let lo: V3 = [Infinity, Infinity, Infinity];
      let hi: V3 = [-Infinity, -Infinity, -Infinity];
      const cached = boxes.get(m);
      if (cached) [lo, hi] = cached;
      else {
        for (let i = 0; i < m.positions.length; i += 3)
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], m.positions[i + k]);
            hi[k] = Math.max(hi[k], m.positions[i + k]);
          }
        boxes.set(m, [lo, hi]);
      }
      if ([0, 1, 2].some((k) => cl[k] < lo[k] - reach || cl[k] > hi[k] + reach)) continue;
      this.probes.push({ part: p, bvh: bvhOf(m), M, cl, nl: this.invDir(M, o.axis) });
    }
  }

  // world to a part's own frame: placements are rotations, mirrors and moves, so the inverse is the transpose
  private inv(M: number[], q: V3): V3 {
    const x = q[0] - M[12],
      y = q[1] - M[13],
      z = q[2] - M[14];
    return [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z];
  }
  private invDir(M: number[], d: V3): V3 {
    return [M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[4] * d[0] + M[5] * d[1] + M[6] * d[2], M[8] * d[0] + M[9] * d[1] + M[10] * d[2]];
  }

  /** A point given the ring's way: `rho` from its axis in the direction `e`, `z` along the axis from its middle. */
  at(e: V3, rho: number, z: number): V3 {
    return add(add(this.o.center, mul(e, rho)), mul(this.o.axis, z));
  }

  /** Every surface a ray crosses, nearest first. */
  cast(origin: V3, dir: V3, tmax: number): Cross[] {
    const out: Cross[] = [];
    for (const pr of this.probes) {
      const o = this.inv(pr.M, origin);
      const d = this.invDir(pr.M, dir);
      const T = pr.bvh.tris;
      let t = 0;
      let skip = -1;
      let last = -Infinity;
      let lastEnter: boolean | null = null;
      for (let n = 0; n < 64; n++) {
        const h = pr.bvh.raycast(o[0], o[1], o[2], d[0], d[1], d[2], t, tmax, skip);
        if (!h) break;
        t = h.t + 1e-7;
        skip = h.tri;
        const k = h.tri * 9;
        const e1: V3 = [T[k + 3] - T[k], T[k + 4] - T[k + 1], T[k + 5] - T[k + 2]];
        const e2: V3 = [T[k + 6] - T[k], T[k + 7] - T[k + 1], T[k + 8] - T[k + 2]];
        const s = (e1[1] * e2[2] - e1[2] * e2[1]) * d[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * d[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * d[2];
        if (Math.abs(s) < 1e-12) continue;
        const enter = s < 0;
        // the same crossing again through a shared edge
        if (h.t - last < 1e-5 && lastEnter === enter) continue;
        last = h.t;
        lastEnter = enter;
        const rs: number[] = [];
        const zs: number[] = [];
        for (let c = 0; c < 3; c++) {
          const w: V3 = [T[k + c * 3] - pr.cl[0], T[k + c * 3 + 1] - pr.cl[1], T[k + c * 3 + 2] - pr.cl[2]];
          const z = w[0] * pr.nl[0] + w[1] * pr.nl[1] + w[2] * pr.nl[2];
          zs.push(z);
          rs.push(Math.hypot(w[0] - z * pr.nl[0], w[1] - z * pr.nl[1], w[2] - z * pr.nl[2]));
        }
        out.push({ t: h.t, enter, part: pr.part, rs, zs });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** The empty stretches along a ray, with the surface at each end (none: the ray starts or ends in the open). */
  gaps(origin: V3, dir: V3, tmax: number): { a: number; b: number; ca?: Cross; cb?: Cross }[] {
    const by = new Map<EvalPart, Cross[]>();
    for (const c of this.cast(origin, dir, tmax)) (by.get(c.part) ?? by.set(c.part, []).get(c.part)!).push(c);
    const solid: { a: number; b: number; ca?: Cross; cb?: Cross }[] = [];
    for (const cs of by.values()) {
      let open: Cross | null = null;
      let first = true;
      for (const c of cs) {
        if (c.enter) open ??= c;
        else if (open) {
          solid.push({ a: open.t, b: c.t, ca: open, cb: c });
          open = null;
        } else if (first) solid.push({ a: 0, b: c.t, cb: c });
        first = false;
      }
      if (open) solid.push({ a: open.t, b: tmax, ca: open });
    }
    solid.sort((p, q) => p.a - q.a);
    const out: { a: number; b: number; ca?: Cross; cb?: Cross }[] = [];
    let at = 0;
    let from: Cross | undefined;
    for (const s of solid) {
      if (s.a > at + 1e-6) out.push({ a: at, b: s.a, ca: from, cb: s.ca });
      if (s.b > at) {
        at = s.b;
        from = s.cb;
      }
    }
    if (at < tmax - 1e-6) out.push({ a: at, b: tmax, ca: from });
    return out;
  }

  /** How far a ray from a point in the open goes before it meets something (0 when the point is inside a part). */
  first(origin: V3, dir: V3, tmax: number): { t: number; c?: Cross } | null {
    const g = this.gaps(origin, dir, tmax)[0];
    if (!g) return { t: 0 };
    if (g.a > 1e-6) return { t: 0, c: g.ca };
    return g.cb ? { t: g.b, c: g.cb } : null;
  }
}

const boxes = new WeakMap<object, [V3, V3]>();

/** The room an O-ring is drawn in, measured on the parts round it. */
export interface Gland {
  /** squeezed across its cord between an inner and an outer surface ("radial"), or along its axis between two faces ("face") */
  kind: "radial" | "face" | "loose" | "none";
  /** the room across the ring, as distances from its axis: the seat and the bore of a radial seal, the walls of a face seal's groove (0 and Infinity when open) */
  a: number;
  b: number;
  /** the room along the axis, as heights from the ring's middle: a radial seal's groove walls, a face seal's two faces (±Infinity when open) */
  lo: number;
  hi: number;
  /** which side the groove is cut in: both when the ring is shut in all the way down the squeezed side */
  groove: "inner" | "outer" | "lower" | "upper" | "both" | "none";
  /** how deep the groove is, mm */
  depth: number;
  inner?: EvalPart;
  outer?: EvalPart;
  lower?: EvalPart;
  upper?: EvalPart;
}

function measure(room: Room, e: V3): Gland {
  const o = room.o;
  const n = o.axis;
  const down = mul(n, -1);
  const back = mul(e, -1);
  const R = (o.id + o.cs) / 2;
  const reach = 4 * o.cs;
  const far = R + 6 * o.cs;
  const none: Gland = { kind: "none", a: 0, b: Infinity, lo: -Infinity, hi: Infinity, groove: "none", depth: 0 };

  // the room the middle of the cord is in, or the nearest to it
  const rooms = room
    .gaps(o.center, e, far)
    .filter((g) => g.b - g.a > 0.02)
    .map((g) => ({ g, off: R < g.a ? g.a - R : R > g.b ? R - g.b : 0 }))
    .sort((p, q) => p.off - q.off);
  if (!rooms.length || rooms[0].off > 2 * o.cs) return none;
  const g = rooms[0].g;
  const a = g.ca ? exactR(g.ca, g.a) : 0;
  const b = g.cb ? exactR(g.cb, g.b) : Infinity;
  const inner = g.ca?.part;
  const outer = g.cb?.part;
  const H = b - a;
  const thick = Number.isFinite(H) && a > 0 ? o.cs / Math.sqrt(Math.max(0.5, (a + b) / (o.id + o.cs))) : o.cs;

  // the room along the axis at one distance from it, and across the ring at one height. `ok`: closed in both ways.
  // A point the meshes put inside a part (they cut the corners of a bore) tells nothing, so it never counts as closed.
  const axial = (rho: number, z0: number) => {
    const up = room.first(room.at(e, rho, z0), n, reach);
    const dn = room.first(room.at(e, rho, z0), down, reach);
    const inside = (!!up && up.t === 0) || (!!dn && dn.t === 0);
    return { hi: up ? exactZ(up.c, z0 + up.t) : Infinity, lo: dn ? exactZ(dn.c, z0 - dn.t) : -Infinity, c1: dn?.c, c2: up?.c, ok: !!up && !!dn && !inside };
  };
  const across = (rho: number, z: number) => {
    const out = room.first(room.at(e, rho, z), e, reach);
    const inn = room.first(room.at(e, rho, z), back, Math.min(reach, rho));
    const inside = (!!out && out.t === 0) || (!!inn && inn.t === 0);
    return { hi: out ? exactR(out.c, rho + out.t) : Infinity, lo: inn ? exactR(inn.c, rho - inn.t) : 0, c1: inn?.c, c2: out?.c, ok: !!out && !!inn && !inside };
  };

  const mid = Number.isFinite(H) ? (a + Math.min(b, a + 4 * o.cs)) / 2 : Math.max(R, a + o.cs / 2);
  const ax = axial(mid, 0);
  const A = ax.hi - ax.lo;
  const radial = a > 0 && Number.isFinite(H) && H < thick;
  const face = Number.isFinite(A) && A < o.cs;
  if (!radial && !face) return { kind: "loose", a, b, lo: ax.lo, hi: ax.hi, groove: "none", depth: 0, inner, outer, lower: ax.c1?.part, upper: ax.c2?.part };

  // The cord is squeezed between two surfaces, s0 below s1 (a seat and a bore, or a floor and a cover), `gap` apart.
  // Walls beside it close it in the other way: step across the gap and see where there are walls, whose they are and
  // how far they come up from the side that owns them.
  const isRadial = radial && (!face || H <= A);
  const [s0, s1] = isRadial ? [a, b] : [ax.lo, ax.hi];
  const [p0, p1] = isRadial ? [inner, outer] : [ax.c1?.part, ax.c2?.part];
  const gap = s1 - s0;
  const probe = isRadial ? (x: number) => axial(x, 0) : (x: number) => across(mid, x);
  const corners = (c: Cross | undefined) => (isRadial ? c?.rs : c?.zs) ?? [];
  const STEPS = 16;
  const x = (j: number) => s0 + ((j + 0.5) / STEPS) * gap;
  const got = Array.from({ length: STEPS }, (_, j) => probe(x(j)));
  const shut = got.filter((q) => q.ok);
  // between a place with walls and one without, where the walls stop: their true edge is a corner of the last triangle met
  const edge = (j0: number, j1: number): number => {
    let w = x(j0);
    let f = x(j1);
    let at = got[j0];
    for (let k = 0; k < 14; k++) {
      const m = (w + f) / 2;
      const q = probe(m);
      if (q.ok) [w, at] = [m, q];
      else f = m;
    }
    return edgeNear([...corners(at.c1), ...corners(at.c2)], w, 0.3);
  };
  let groove: "first" | "second" | "both" | "none" = "none";
  let depth = 0;
  if (shut.length) {
    const owners = [mode(shut.map((q) => q.c1?.part)), mode(shut.map((q) => q.c2?.part))];
    const first = got.findIndex((q) => q.ok);
    const last = got.length - 1 - [...got].reverse().findIndex((q) => q.ok);
    const mine0 = !!p0 && owners.includes(p0);
    const mine1 = !!p1 && owners.includes(p1);
    // walls met at the very end of the gap: the meshes cut the corners of a bore, so take how far they really come
    // from the corners of the triangles met (as far as the other surface when they run on past it)
    const reachOf = (q: (typeof got)[number], up: boolean) => {
      const ends = [corners(q.c1), corners(q.c2)].filter((c) => c.length).map((c) => (up ? Math.max(...c) : Math.min(...c)));
      if (!ends.length) return up ? s1 : s0;
      return up ? Math.min(s1, ...ends) : Math.max(s0, ...ends);
    };
    if (mine0 && !mine1) [groove, depth] = ["first", (last === STEPS - 1 ? reachOf(got[last], true) : edge(last, last + 1)) - s0];
    else if (mine1 && !mine0) [groove, depth] = ["second", s1 - (first === 0 ? reachOf(got[0], false) : edge(first, first - 1))];
    else [groove, depth] = ["both", gap];
  }
  const w0 = shut.length ? median(shut.map((q) => q.lo)) : isRadial ? -Infinity : 0;
  const w1 = shut.length ? median(shut.map((q) => q.hi)) : Infinity;
  const wallParts = { c1: mode(shut.map((q) => q.c1?.part)), c2: mode(shut.map((q) => q.c2?.part)) };
  if (isRadial) return { kind: "radial", a, b, lo: w0, hi: w1, groove: groove === "first" ? "inner" : groove === "second" ? "outer" : groove, depth, inner, outer, lower: wallParts.c1, upper: wallParts.c2 };
  return { kind: "face", a: w0, b: w1, lo: ax.lo, hi: ax.hi, groove: groove === "first" ? "lower" : groove === "second" ? "upper" : groove, depth, inner: wallParts.c1, outer: wallParts.c2, lower: p0, upper: p1 };
}

const cache = new WeakMap<Model, { mesh: MeshLookup; glands: Map<string, Gland> }>();

/** The gland of every O-ring of the design, by the ring's part id: what most directions round the ring agree on. */
export function oringGlands(model: Model, mesh: MeshLookup): Map<string, Gland> {
  const hit = cache.get(model);
  if (hit && hit.mesh === mesh) return hit.glands;
  const glands = new Map<string, Gland>();
  for (const p of model.parts) {
    if (!p.oring) continue;
    const room = new Room(p.oring, p, model, mesh);
    const all = Array.from({ length: ANGLES }, (_, k) => {
      const t = ANGLE0 + (2 * Math.PI * k) / ANGLES;
      return measure(room, add(mul(room.u, Math.cos(t)), mul(room.v, Math.sin(t))));
    });
    const kind = mode(all.map((g) => g.kind))!;
    const same = all.filter((g) => g.kind === kind);
    const groove = mode(same.map((g) => g.groove))!;
    const like = same.filter((g) => g.groove === groove);
    glands.set(p.id, {
      kind,
      groove,
      a: median(like.map((g) => g.a)),
      b: median(like.map((g) => g.b)),
      lo: median(like.map((g) => g.lo)),
      hi: median(like.map((g) => g.hi)),
      depth: median(like.map((g) => g.depth)),
      inner: mode(like.map((g) => g.inner)),
      outer: mode(like.map((g) => g.outer)),
      lower: mode(like.map((g) => g.lower)),
      upper: mode(like.map((g) => g.upper)),
    });
  }
  cache.set(model, { mesh, glands });
  return glands;
}

/** What a gland does to its ring. */
export interface OringFit {
  /** the cord's diameter once the ring is stretched or pressed to where it sits, mm */
  thick: number;
  /** the room it is squeezed in, and the room beside it, mm */
  gap: number;
  width: number;
  squeeze: number;
  /** stretch on the inside diameter (negative: the ring is bigger than what it sits round) */
  stretch: number;
  /** how much shorter the middle of the cord has to get to go in (0 when it stretches) */
  bunch: number;
  /** the cord's section over the room for it */
  fill: number;
  /** left between the two parts beside the groove, mm */
  open: number;
  /** the two parts that squeeze it */
  sides: [EvalPart | undefined, EvalPart | undefined];
}

export function oringFit(o: OringInfo, g: Gland): OringFit | null {
  if (g.kind !== "radial" && g.kind !== "face") return null;
  const od = o.id + 2 * o.cs;
  let line: number;
  let stretch: number;
  if (g.kind === "radial") {
    line = (g.a + g.b) / (o.id + o.cs) - 1;
    stretch = (2 * g.a) / o.id - 1;
  } else {
    // a face seal lies where it likes between its groove's walls, unless one of them is in its way
    stretch = g.a > 0 ? Math.max(0, (2 * g.a) / o.id - 1) : 0;
    const press = Number.isFinite(g.b) ? Math.max(0, 1 - (2 * g.b) / od) : 0;
    line = stretch > 0 ? (2 * g.a + o.cs) / (o.id + o.cs) - 1 : press > 0 ? (2 * g.b - o.cs) / (o.id + o.cs) - 1 : 0;
    if (!(stretch > 0) && g.a > 0) stretch = (2 * g.a) / o.id - 1;
  }
  const thick = o.cs / Math.sqrt(Math.max(0.5, 1 + line));
  const gap = g.kind === "radial" ? g.b - g.a : g.hi - g.lo;
  const width = g.kind === "radial" ? g.hi - g.lo : g.b - g.a;
  const area = (Math.PI / 4) * thick * thick;
  return {
    thick,
    gap,
    width,
    squeeze: 1 - gap / thick,
    stretch,
    bunch: Math.max(0, -line),
    fill: Number.isFinite(width) && width > 0 ? area / (width * gap) : NaN,
    open: Math.max(0, gap - g.depth),
    sides: g.kind === "radial" ? [g.inner, g.outer] : [g.lower, g.upper],
  };
}

/** An O-ring drawn into the parts that squeeze it: its squeeze, not a clash. */
export function oringSqueeze(i: Interference, model: Model, mesh: MeshLookup): { ring: EvalPart; on: EvalPart } | null {
  const A = model.parts.find((p) => p.id === i.a);
  const B = model.parts.find((p) => p.id === i.b);
  if (!A || !B || !!A.oring === !!B.oring) return null;
  const [ring, on] = A.oring ? [A, B] : [B, A];
  const g = oringGlands(model, mesh).get(ring.id);
  if (!g || (g.kind !== "radial" && g.kind !== "face")) return null;
  return [g.inner, g.outer, g.lower, g.upper].includes(on) ? { ring, on } : null;
}

/** How one part moves against another: not at all, along the ring's axis, round it, or some other way. */
function against(a: EvalPart | undefined, b: EvalPart | undefined, axis: V3, holds: Holds): "still" | "slides" | "turns" | "moves" {
  if (!a || !b) return "still";
  const ma = motionOfPart(a, holds);
  const mb = motionOfPart(b, holds);
  if (ma === mb) return "still";
  // one of them still and the other on one plain motion says how; anything else just moves
  const kinds = ma && mb ? [] : [ma, mb].filter((m): m is Motion => !!m);
  const along = (m: Motion) => Math.abs(m.axis[0] * axis[0] + m.axis[1] * axis[1] + m.axis[2] * axis[2]) > 0.999;
  if (kinds.length === 1 && along(kinds[0])) return kinds[0].kind === "slide" ? "slides" : !kinds[0].kind || kinds[0].kind === "roll" ? "turns" : "moves";
  return "moves";
}

export function oringChecks(model: Model, holds: Holds, mesh: MeshLookup): CheckItem[] {
  const out: CheckItem[] = [];
  const glands = oringGlands(model, mesh);
  for (const p of model.parts) {
    const o = p.oring;
    const g = glands.get(p.id);
    if (!o || !g) continue;
    const fit = oringFit(o, g);
    const near = [g.inner, g.outer, g.lower, g.upper].filter((x): x is EvalPart => !!x);
    const base = { category: "engineering" as const, parts: [...new Set([p.id, ...near.map((x) => x.id)])], span: p.span, basis: "geometry" as const };
    const name = p.name;
    const od = o.id + 2 * o.cs;

    // ---- is it in a gland at all
    if (!fit) {
      const aim = AIM.static;
      const want = `Draw a groove for it: for a ${N(o.cs)} mm cord, about ${N(((Math.PI / 4) * o.cs) / (0.75 * (1 - aim)), 1)} mm wide, leaving ${N(o.cs * (1 - aim))} mm between its bottom and the surface it seals against (${pct(aim)} squeeze).`;
      if (g.kind === "none") out.push({ ...base, id: `oring:gland:${p.id}`, status: "fail", title: `${name} is not in a gland`, detail: `Kerf looked round ${name} where it is drawn (the middle of its cord is ${N((o.id + o.cs) / 2)} mm from its axis) and found no room for it there: it is drawn inside solid material, or with nothing near it. An O-ring seals by being squeezed between the bottom of a groove and the surface facing it.`, fix: `Put at: at the middle of the groove ${name} sits in, with axis: along the groove's own axis. ${want}` });
      else {
        const across = Number.isFinite(g.b) && g.a > 0 ? `${N(g.b - g.a)} mm across the ring${g.inner && g.outer ? ` (between ${g.inner.name} and ${g.outer.name})` : ""}` : "nothing to close it in across the ring";
        const along = Number.isFinite(g.hi - g.lo) ? `${N(g.hi - g.lo)} mm along its axis` : "nothing to close it in along its axis";
        out.push({ ...base, id: `oring:gland:${p.id}`, status: "fail", title: `Nothing squeezes ${name}`, detail: `Where ${name} is drawn there is ${across} and ${along}, and its cord is ${N(o.cs)} mm: it is not squeezed either way, so it does not seal. An O-ring seals by being squeezed between the bottom of a groove and the surface facing it.`, fix: want });
      }
      continue;
    }

    const [s1, s2] = fit.sides;
    const rel = against(s1, s2, o.axis, holds);
    const duty = o.duty ?? (rel === "still" ? "static" : "moving");
    const why = o.duty ? `the design says this one ${o.duty === "moving" ? "moves" : "stays still"}` : rel === "still" ? `${s1?.name ?? "one side"} and ${s2?.name ?? "the other"} do not move against each other, so this one stays still` : `${s1?.name} ${rel === "moves" ? "moves" : rel} against ${s2?.name}, so this one moves`;
    const E = fit.open;
    const holder = g.groove === "inner" ? g.inner : g.groove === "outer" ? g.outer : g.groove === "lower" ? g.lower : g.groove === "upper" ? g.upper : undefined;
    const other = g.groove === "inner" ? g.outer : g.groove === "outer" ? g.inner : g.groove === "lower" ? g.upper : g.groove === "upper" ? g.lower : undefined;
    const room = `from its bottom to ${other?.name ?? "the surface facing it"} is ${N(fit.gap)} mm, for a cord of ${N(o.cs)} mm`;
    const beside = E > 0.005 ? ` ${N(E)} mm is left between ${s1?.name} and ${s2?.name} beside the groove; Kerf does not check that gap against a pressure.` : "";

    if (g.groove === "none") out.push({ ...base, id: `oring:gland:${p.id}`, status: "warn", title: `Nothing keeps ${name} in place`, detail: `${name} is squeezed between ${s1?.name} and ${s2?.name} (${N(fit.gap)} mm for its ${N(o.cs)} mm cord), but there is no groove round it: ${g.kind === "radial" ? "the first push along the axis rolls it away" : "pressure pushes it out sideways"}.`, fix: `Cut a groove for it in ${s1?.name ?? "one part"} or ${s2?.name ?? "the other"}, about ${N(((Math.PI / 4) * fit.thick * fit.thick) / (0.75 * fit.gap), 1)} mm wide.` });
    else if (g.groove === "both") out.push({ ...base, id: `oring:gland:${p.id}`, status: "pass", title: `${name} is shut in between ${s1?.name} and ${s2?.name}`, detail: `Its gland is ${N(fit.width)} mm wide and ${N(fit.gap)} mm high for a cord of ${N(o.cs)} mm, closed all the way round the cord. Measured on the parts as they are drawn.` });
    else out.push({ ...base, id: `oring:gland:${p.id}`, status: "pass", title: `${name} sits in a groove in ${holder?.name} and seals against ${other?.name}`, detail: `The groove is ${N(fit.width)} mm wide and ${N(g.depth)} mm deep; ${room}.${beside} Measured on the parts as they are drawn.` });

    // ---- squeeze
    const [lo, hi] = SQUEEZE[duty];
    const aim = AIM[duty];
    const wantGap = fit.thick * (1 - aim);
    const how =
      g.kind === "radial"
        ? g.groove === "outer"
          ? `Make the bottom of the groove Ø${N(2 * (g.a + wantGap))} (now Ø${N(2 * g.b)})`
          : g.groove === "inner"
            ? `Make the bottom of the groove Ø${N(2 * (g.b - wantGap))} (now Ø${N(2 * g.a)})`
            : `Leave ${N(wantGap)} mm between ${s1?.name} and ${s2?.name} where ${name} sits (now ${N(fit.gap)})`
        : g.groove === "lower" || g.groove === "upper"
          ? `Make the groove ${N(Math.max(0.1, wantGap - E))} mm deep (now ${N(g.depth)})`
          : `Leave ${N(wantGap)} mm between ${s1?.name} and ${s2?.name} where ${name} sits (now ${N(fit.gap)})`;
    const thin = Math.abs(fit.thick - o.cs) >= 0.005 ? `Its cord is ${N(fit.thick)} mm where it sits (${N(o.cs)} mm as bought, ${fit.thick < o.cs ? "thinner once the ring is stretched" : "thicker once the ring is pressed in"}) and has ${N(fit.gap)} mm.` : `Its cord is ${N(o.cs)} mm and has ${N(fit.gap)} mm.`;
    const rule = `Apple Rubber's Seal Design Guide gives 10 to 40 % for a seal that stays still and 10 to 30 % for one that moves; ${why}.`;
    const sq = { ...base, id: `oring:squeeze:${p.id}`, margin: Math.min(fit.squeeze - lo, hi - fit.squeeze) };
    if (fit.squeeze < lo) out.push({ ...sq, status: "fail", title: `${name} is squeezed only ${pct(fit.squeeze)}`, detail: `${thin} ${rule} Squeezed this little it leaks at low pressure and stops sealing once the rubber takes a set.`, fix: `${how}, which squeezes it ${pct(aim)}.` });
    else if (fit.squeeze > hi) out.push({ ...sq, status: "fail", title: `${name} is squeezed ${pct(fit.squeeze)}, more than a seal that ${duty === "moving" ? "moves" : "stays still"} takes`, detail: `${thin} ${rule} ${duty === "moving" ? "Squeezed this hard it drags, heats and wears." : "Squeezed this hard it is cut going in and takes a set."}`, fix: `${how}, which squeezes it ${pct(aim)}.` });
    else out.push({ ...sq, status: "pass", title: `${name} is squeezed ${pct(fit.squeeze)}`, detail: `${thin} ${rule}` });

    // ---- stretch
    const st = { ...base, id: `oring:stretch:${p.id}` };
    const seat = g.kind === "radial" || g.a > 0 ? 2 * g.a : 0;
    const guide = "Apple Rubber's guide: more than 5 % stretch on the inside diameter is not recommended, because the cord thins and loses its squeeze; 2 % is the aim on a piston.";
    if (fit.stretch > STRETCH_MAX) out.push({ ...st, status: "fail", margin: STRETCH_MAX - fit.stretch, title: `${name} is stretched ${pct(fit.stretch, 1)} to go on`, detail: `Its inside diameter is ${N(o.id)} mm and what it sits round is Ø${N(seat)}. ${guide}`, fix: `Use a ring of about ${N(seat / (1 + STRETCH_AIM), 1)} mm inside diameter (${pct(STRETCH_AIM)} stretch).` });
    else if (rel === "turns" && fit.stretch > 0.005) out.push({ ...st, status: "warn", title: `${name} is stretched over a turning shaft`, detail: `${s1?.name} turns against ${s2?.name}, and ${name} is stretched ${pct(fit.stretch, 1)} onto Ø${N(seat)}. Apple Rubber's guide: a seal on a turning shaft should be designed with no stretch over the shaft.`, fix: `Use a ring of ${N(seat, 1)} mm inside diameter or a little more, held by its outside in a groove in the part round the shaft.` });
    else if (fit.bunch > BUNCH_WARN) out.push({ ...st, status: "warn", title: `${name} is too big for where it sits`, detail: `The middle of its cord is ${N(Math.PI * (o.id + o.cs), 1)} mm round and has ${pct(fit.bunch, 1)} less than that to lie in (its inside diameter is ${N(o.id)} mm${seat > 0 ? ` and what it sits round Ø${N(seat)}` : ""}). Kerf's own rule: past ${pct(BUNCH_WARN)} a ring has to bunch up to go in, and does not lie evenly.`, fix: g.kind === "radial" ? `Use a ring of about ${N(2 * g.a, 1)} mm inside diameter.` : `Use a ring of about ${N(2 * g.b - 2 * o.cs, 1)} mm inside diameter.` });
    else if (fit.stretch > 0.0005) out.push({ ...st, status: "pass", margin: STRETCH_MAX - fit.stretch, title: `${name} is stretched ${pct(fit.stretch, 1)} to go on`, detail: `Its inside diameter goes from ${N(o.id)} mm to Ø${N(seat)}. ${guide}` });
    else out.push({ ...st, status: "pass", title: `${name} goes in without stretching`, detail: `Its inside diameter is ${N(o.id)} mm${seat > 0 ? ` and what it sits round Ø${N(seat)}` : ""}${Number.isFinite(g.b) ? `; its outside, ${N(od)} mm, goes into Ø${N(2 * g.b)}` : ""}. ${guide}` });

    // ---- how full the gland is
    if (Number.isFinite(fit.fill)) {
      const area = (Math.PI / 4) * fit.thick * fit.thick;
      const fl = { ...base, id: `oring:fill:${p.id}`, margin: 1 - fit.fill };
      const sums = `Its cord is ${N(area)} mm² in section and the room for it ${N(fit.width)} × ${N(fit.gap)} = ${N(fit.width * fit.gap)} mm² (the gland taken as square-cornered).`;
      const wider = g.kind === "radial" ? `Make the groove ${N(area / (0.75 * fit.gap), 1)} mm wide (now ${N(fit.width)}), which leaves it 75 % full.` : `Make the groove ${N(area / (0.75 * fit.gap), 1)} mm across (now ${N(fit.width)}), which leaves it 75 % full.`;
      if (fit.fill > 1) out.push({ ...fl, status: "fail", title: `${name} does not fit its gland`, detail: `${sums} That is ${pct(fit.fill)} of the room. Apple Rubber's guide: the ring must never be bigger than its gland, or it is crushed and pushed out into the gap.`, fix: wider });
      else if (fit.fill > FILL_WARN) out.push({ ...fl, status: "warn", title: `${name} nearly fills its gland (${pct(fit.fill)})`, detail: `${sums} Apple Rubber's guide: the ring must never be bigger than its gland. Kerf's own margin is 90 %, because rubber grows with heat far more than metal does and swells in oil.`, fix: wider });
      else out.push({ ...fl, status: "pass", title: `${name} fills ${pct(fit.fill)} of its gland`, detail: `${sums} Apple Rubber's guide: the ring must never be bigger than its gland; Kerf's own margin is 90 %, for rubber growing with heat and swelling in oil.` });
    }

    // ---- a face seal sits against the low-pressure wall
    if (g.kind === "face" && o.pressure && g.a > 0 && Number.isFinite(g.b)) {
      const inside = o.pressure === "inside";
      const off = inside ? g.b - od / 2 : o.id / 2 - g.a;
      const se = { ...base, id: `oring:seat:${p.id}` };
      const rule2 = "Apple Rubber's guide: a face seal should always be seated against the low-pressure side of its groove.";
      if (off > SEATED * o.cs + 1e-6) out.push({ ...se, status: "warn", title: `${name} is not seated against the low-pressure side of its groove`, detail: `The pressure is on the ${o.pressure}, so it pushes ${name} ${inside ? "outward" : "inward"}; the ring lies ${N(off)} mm short of the groove's ${inside ? "outer" : "inner"} wall, and has to be pushed across before it seals. ${rule2}`, fix: `Use a ring of about ${N(inside ? 2 * g.b - 2 * o.cs : 2 * g.a, 1)} mm inside diameter, or move that wall of the groove to meet it.` });
      else out.push({ ...se, status: "pass", title: `${name} is seated against the low-pressure side of its groove`, detail: `The pressure is on the ${o.pressure}, and ${name} lies against the groove's ${inside ? "outer" : "inner"} wall. ${rule2}` });
    }

    // ---- a ring in a part that moves goes with it
    if (holder) {
      const mh = motionOfPart(holder, holds);
      const mp = motionOfPart(p, holds);
      if (mh && mp !== mh && mp?.parent !== mh) out.push({ ...base, id: `oring:rides:${p.id}`, category: "motion", status: "warn", title: `${name} stays behind when ${holder.name} moves`, detail: `${name} sits in a groove in ${holder.name}, which moves, and nothing says ${name} goes with it.`, fix: `Add rides: ${holder.name} to ${name}.` });
    }
  }
  return out;
}
