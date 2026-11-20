// Ropes and cables (lib.rope): a rope from a winch drum, over sheaves, to
// where it is tied. This file is the rope's geometry and nothing else: the
// path it takes round drums and sheaves in three dimensions (ropePath, used
// as drawn and again at every position of the motion), reading a drum or a
// sheave from a part's own shapes (wheelOf), the layout as drawn with the
// turns stored on a drum (layoutRope), and the rope as a solid (ropeRecipe).
// What the rope carries, whether it stays taut through the motion and what
// holds its drum are worked out in core/ropeChecks.ts from the RopeDef.

import type { PartOp, PartRecipe, Profile, ShapeRecipe, V2, V3, Xform } from "../kernel/recipe";
import { applyXforms, applyXformsToDir, vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from "../kernel/recipe";
import type { CatalogPart, RopeNode, RopeSpan } from "./types";

// ---------------------------------------------------------------- rope data

export interface RopeSpec {
  /** rope diameter, mm */
  d: number;
  /** steel wire rope, or a fibre rope */
  kind: "wire" | "fibre";
  /** how it is made, for messages: "7x19 stainless", "12-strand Dyneema" */
  construction: string;
  /** minimum breaking load, N */
  mbl: number;
  /** kg per metre */
  mass: number;
  /** tensile stiffness, N per unit strain */
  ea: number;
  /** tread diameter of a sheave or drum over rope diameter: the suggested ratio, and the least before the rope wears out quickly */
  bend: number;
  bendMin: number;
  /** design factor: its working load is the breaking load over this */
  factor: number;
}

export function ropeSpec(p: CatalogPart): RopeSpec {
  const s = p.specs;
  const n = (k: string, d: number) => (typeof s[k] === "number" ? (s[k] as number) : d);
  const mbl = n("mbl_n", 1000);
  return {
    d: n("d", 3),
    kind: s.rope === "fibre" ? "fibre" : "wire",
    construction: String(s.construction ?? "rope"),
    mbl,
    mass: n("mass_g_m", 30) / 1000,
    ea: n("ea_n", mbl * STRETCH_EA),
    bend: n("bend_ratio", 20),
    bendMin: n("bend_min", 10),
    factor: n("factor", 5),
  };
}

/**
 * Stiffness from breaking load when a rope's maker gives none: 0.70 % of stretch at 20 % of the breaking load
 * (Samson's figure for 12-strand Dyneema, which its data sheet calls similar to wire rope).
 */
export const STRETCH_EA = 0.2 / 0.007;

/** Turns of rope a drum must keep on it at the far end of its travel, so the anchor never takes the load. */
export const DEAD_WRAPS = 3;
/** Rope allowed for each tied end (an eye round a thimble and its ferrule, or a knot and its tail), in rope diameters. */
export const TIE_TAIL = 30;

export class RopeError extends Error {}

const TAU = Math.PI * 2;
const deg = (r: number) => (r * 180) / Math.PI;

// ---------------------------------------------------------------- the path

/** A node of a rope's path at one moment: a wheel (with its axis and the rope's centre-line radius round it) or a tied point. */
export interface RopePoint {
  c: V3;
  axis?: V3;
  r: number;
  /** the way the rope goes round the axis as it runs from the path's start to its end: 1 counter-clockwise seen against the axis */
  dir: 1 | -1;
}

export interface RopePath {
  /** where the rope meets and leaves each node (both the point itself at a tie) */
  arrive: V3[];
  depart: V3[];
  /** contact angle on each wheel between the ends, radians: under zero when the rope has lifted off it */
  wrap: number[];
  /** straight length from node i to node i + 1 */
  spans: number[];
  /** how far off square the rope meets and leaves each wheel, radians */
  fleetIn: number[];
  fleetOut: number[];
  /** the straight runs plus the arcs round the wheels between the ends, mm */
  free: number;
  /** nodes the rope cannot reach a tangent on: the one before or after is inside its circle */
  inside: number[];
}

/** A contact angle past this is read as the rope having lifted off the wheel, not wrapped nearly right round it. */
const LIFT_OFF = (315 * Math.PI) / 180;

/**
 * The taut path through the nodes: straight between them, tangent to every wheel in that wheel's own plane. Each
 * wheel's two tangent points depend on its neighbours', so they are settled together by going round until nothing
 * moves; with every wheel in one plane this is the common tangent of each pair, and out of plane it is the path a
 * taut rope takes, arriving at a fleet angle.
 */
export function ropePath(nodes: RopePoint[]): RopePath {
  const N = nodes.length;
  const arrive = nodes.map((n) => n.c);
  const depart = nodes.map((n) => n.c);
  const inside = new Set<number>();
  const tangent = (i: number, P: V3, side: 1 | -1): V3 => {
    const nd = nodes[i];
    const a = nd.axis!;
    const v = vsub(P, nd.c);
    const q = vsub(v, vscale(a, vdot(v, a)));
    const L = vlen(q);
    if (L <= nd.r * (1 + 1e-9)) {
      inside.add(i);
      return L < 1e-9 ? nd.c : vadd(nd.c, vscale(q, nd.r / L));
    }
    const e1 = vscale(q, 1 / L);
    const e2 = vcross(a, e1);
    // from a point outside, the rope meets the circle acos(r / L) round from the line to that point: on the side
    // that sends it round the way it turns when arriving, the other when leaving
    const ang = side * nd.dir * Math.acos(nd.r / L);
    return vadd(nd.c, vadd(vscale(e1, nd.r * Math.cos(ang)), vscale(e2, nd.r * Math.sin(ang))));
  };
  for (let it = 0; it < 80; it++) {
    let moved = 0;
    inside.clear();
    for (let i = 0; i < N; i++) {
      const nd = nodes[i];
      if (!nd.axis || nd.r <= 0) continue;
      if (i > 0) {
        const t = tangent(i, depart[i - 1], 1);
        moved += vlen(vsub(t, arrive[i]));
        arrive[i] = t;
      }
      if (i < N - 1) {
        const t = tangent(i, arrive[i + 1], -1);
        moved += vlen(vsub(t, depart[i]));
        depart[i] = t;
      }
      if (i === 0) arrive[i] = depart[i];
      if (i === N - 1) depart[i] = arrive[i];
    }
    if (moved < 1e-10) break;
  }
  const wrap = nodes.map(() => 0);
  const fleetIn = nodes.map(() => 0);
  const fleetOut = nodes.map(() => 0);
  const spans: number[] = [];
  let free = 0;
  for (let i = 0; i < N - 1; i++) {
    const s = vsub(arrive[i + 1], depart[i]);
    const L = vlen(s);
    spans.push(L);
    free += L;
    if (L > 1e-9) {
      const u = vscale(s, 1 / L);
      if (nodes[i].axis) fleetOut[i] = Math.asin(Math.min(1, Math.abs(vdot(u, nodes[i].axis!))));
      if (nodes[i + 1].axis) fleetIn[i + 1] = Math.asin(Math.min(1, Math.abs(vdot(u, nodes[i + 1].axis!))));
    }
  }
  for (let i = 1; i < N - 1; i++) {
    const nd = nodes[i];
    if (!nd.axis || nd.r <= 0) continue;
    let w = nd.dir * angleAbout(nd.axis, vsub(arrive[i], nd.c), vsub(depart[i], nd.c));
    if (w < -1e-9) w += TAU;
    if (w > LIFT_OFF) w -= TAU;
    wrap[i] = w;
    free += nd.r * Math.max(0, w);
  }
  return { arrive, depart, wrap, spans, fleetIn, fleetOut, free, inside: [...inside] };
}

/** The signed angle from `from` to `to` about `axis` (both taken square to it), radians in (-π, π]. */
export function angleAbout(axis: V3, from: V3, to: V3): number {
  return Math.atan2(vdot(vcross(from, to), axis), vdot(from, to) - vdot(from, axis) * vdot(to, axis));
}

/** A direction square to an axis, the same for the same axis every time: the frame a wheel's angles are measured in. */
export function squareTo(axis: V3): V3 {
  const a = vnorm(axis);
  const pick: V3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return vnorm(vsub(pick, vscale(a, vdot(pick, a))));
}

/** A rope's path at one moment, as far as its length goes. */
export interface RopeState {
  path: RopePath;
  /** at a drum: the angle round its axis, from its mark, of the point where the rope leaves or meets it; 0 elsewhere */
  ang: number[];
}

/**
 * The path at one moment. `marks` gives each drum a direction square to its axis that is carried with whatever
 * carries the drum but does not turn with it: the angle of the rope's leaving point is measured from it.
 */
export function ropeState(pts: RopePoint[], marks: (V3 | undefined)[]): RopeState {
  const path = ropePath(pts);
  const N = pts.length;
  const ang = pts.map((nd, i) => {
    if (!nd.axis || (i > 0 && i < N - 1)) return 0;
    const at = i === 0 ? path.depart[0] : path.arrive[i];
    return angleAbout(nd.axis, marks[i] ?? squareTo(nd.axis), vsub(at, nd.c));
  });
  return { path, ang };
}

/**
 * How much more rope the path takes at `to` than at `from`, mm, with every drum held still: the straight runs and
 * the arcs round the sheaves, and at each drum the shift of the point where the rope leaves it (further round the
 * way the rope runs keeps more on a starting drum, and takes more off an end drum).
 */
export function ropeTaken(pts: RopePoint[], from: RopeState, to: RopeState): number {
  const N = pts.length;
  let t = to.path.free - from.path.free;
  pts.forEach((nd, i) => {
    if (!nd.axis || (i > 0 && i < N - 1)) return;
    let da = to.ang[i] - from.ang[i];
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    t += (i === 0 ? 1 : -1) * nd.r * nd.dir * da;
  });
  return t;
}

/**
 * Rope a drum lets out for each radian it turns counter-clockwise about its axis, mm: its radius, signed by which
 * end of the path it is at and which way the rope goes round it.
 */
export function drumPayout(nd: { r: number; dir: 1 | -1 }, first: boolean): number {
  return (first ? 1 : -1) * nd.r * nd.dir;
}

// ---------------------------------------------------------------- wheels from parts

/** A drum or sheave read from a part: where the rope sits on it. */
export interface Wheel {
  axis: V3;
  /** the middle of the seat, on the axis (world) */
  c: V3;
  /** diameter the rope sits on: the barrel of a drum, the bottom of a sheave's groove */
  rootD: number;
  /** width of the seat between the flanges, measured half a rope diameter above its bottom (pass that height in) */
  width: number;
  /** how far the flanges stand above the seat, mm (0 on a plain cylinder) */
  flange: number;
}

interface Ring {
  z0: number;
  z1: number;
  r: number;
  /** a ring cut away: the outside comes down to r over its length */
  cut?: boolean;
}

/**
 * The round shapes of a part that share its first round shape's axis, as rings along that axis: cylinders, tubes,
 * round extrusions and revolved profiles, added or cut. Everything else on the part (brackets, spokes, bores) leaves
 * the place the rope sits alone.
 */
function ringsOf(recipe: PartRecipe): { o: V3; axis: V3; rings: Ring[] } | null {
  let o: V3 | undefined;
  let axis: V3 | undefined;
  const rings: Ring[] = [];
  const on = (at: V3, dir: V3): { z: number; flip: boolean } | null => {
    const d = vnorm(dir);
    if (!axis || !o) {
      axis = d;
      o = at;
      return { z: 0, flip: false };
    }
    const c = vdot(d, axis);
    if (Math.abs(c) < 0.9999) return null;
    const v = vsub(at, o);
    const z = vdot(v, axis);
    if (vlen(vsub(v, vscale(axis, z))) > 0.05) return null;
    return { z, flip: c < 0 };
  };
  const ring = (at: V3, dir: V3, h: number, r: number, cut: boolean) => {
    const p = on(at, dir);
    if (!p || !(h > 0) || !(r > 0)) return;
    rings.push(p.flip ? { z0: p.z - h, z1: p.z, r, cut } : { z0: p.z, z1: p.z + h, r, cut });
  };
  const walk = (sh: ShapeRecipe, xf: Xform[], cut: boolean): void => {
    const pt = (p: V3) => applyXforms(p, xf);
    const dr = (d: V3) => applyXformsToDir(d, xf);
    switch (sh.t) {
      case "xform":
        return walk(sh.shape, [...sh.xf, ...xf], cut);
      case "union":
        for (const s of sh.shapes) walk(s, xf, cut);
        return;
      case "diff":
        walk(sh.a, xf, cut);
        if (!cut) for (const b of sh.b) walk(b, xf, true);
        return;
      case "lod":
        return walk(sh.fast, xf, cut);
      case "cyl":
        // a cylinder cut on the axis is a bore: it never reaches the outside
        if (!cut) ring(pt(sh.at), dr(sh.dir), sh.h, sh.d / 2, false);
        return;
      case "tube":
        // a tube cut away is a groove turned into the outside, down to its bore
        ring(pt(sh.at), dr(sh.dir), sh.h, cut ? sh.id / 2 : sh.od / 2, cut);
        return;
      case "extrude": {
        if (cut || sh.p.t !== "circle" || Math.abs(sh.scale - 1) > 1e-6) return;
        const n = vnorm(sh.f.n);
        const u = vnorm(sh.f.u);
        const v = vcross(n, u);
        const c = vadd(sh.f.o, vadd(vscale(u, sh.p.c[0]), vscale(v, sh.p.c[1])));
        ring(pt(sh.h < 0 ? vadd(c, vscale(n, sh.h)) : c), dr(n), Math.abs(sh.h), sh.p.d / 2, false);
        return;
      }
      case "revolve": {
        if (cut) return;
        // the outline's outside at each height, a quarter millimetre at a time
        const zs = sh.pts.map((q) => q[1]);
        const lo = Math.min(...zs);
        const hi = Math.max(...zs);
        const steps = Math.max(1, Math.min(2000, Math.ceil((hi - lo) / 0.25)));
        const dz = (hi - lo) / steps;
        const d = dr(sh.dir);
        const at = pt(sh.at);
        for (let i = 0; i < steps; i++) {
          const r = outlineReach(sh.pts, lo + (i + 0.5) * dz);
          if (r > 0) ring(vadd(at, vscale(vnorm(d), lo + i * dz)), d, dz, r, false);
        }
        return;
      }
      default:
        return;
    }
  };
  if (!recipe.base) return null;
  walk(recipe.base, [], false);
  if (!axis || !o) return null;
  for (const op of recipe.ops as PartOp[]) {
    if (op.op === "add") walk(op.shape, [], false);
    else if (op.op === "cut") walk(op.shape, [], true);
  }
  return { o, axis, rings };
}

/** How far out a revolved outline (radius, height) reaches at one height. */
function outlineReach(pts: V2[], z: number): number {
  let r = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if ((a[1] - z) * (b[1] - z) > 0 || a[1] === b[1]) continue;
    const t = (z - a[1]) / (b[1] - a[1]);
    r = Math.max(r, a[0] + t * (b[0] - a[0]));
  }
  return r;
}

/**
 * Where a rope sits on a part: the lowest stretch of its outside along its axis (a drum's barrel between its
 * flanges, the bottom of a sheave's groove, or the whole of a plain cylinder). `ropeD` sets the height the seat's
 * width is measured at, so a V groove is as wide as the rope sees it.
 */
export function wheelOf(recipe: PartRecipe, xf: Xform[], ropeD: number): Wheel | null {
  const got = ringsOf(recipe);
  if (!got || !got.rings.some((r) => !r.cut)) return null;
  const { rings } = got;
  const cuts = rings.filter((r) => r.cut);
  const solid = rings.filter((r) => !r.cut);
  const zs = [...new Set(rings.flatMap((r) => [r.z0, r.z1]))].sort((a, b) => a - b);
  // the outside between each pair of heights
  const env: { z0: number; z1: number; r: number }[] = [];
  for (let i = 0; i < zs.length - 1; i++) {
    const m = (zs[i] + zs[i + 1]) / 2;
    let r = 0;
    for (const s of solid) if (s.z0 <= m && m <= s.z1) r = Math.max(r, s.r);
    for (const c of cuts) if (c.z0 <= m && m <= c.z1) r = Math.min(r, c.r);
    if (r > 0) env.push({ z0: zs[i], z1: zs[i + 1], r });
  }
  if (!env.length) return null;
  const root = Math.min(...env.map((e) => e.r));
  const top = Math.max(...env.map((e) => e.r));
  // the longest run at the bottom, widened to everything within half a rope of it
  const near = (e: { r: number }) => e.r <= root + ropeD / 2 + 1e-6;
  let best: [number, number] = [0, -1];
  for (let i = 0; i < env.length; i++) {
    if (Math.abs(env[i].r - root) > 1e-6) continue;
    let a = i;
    let b = i;
    while (a > 0 && near(env[a - 1]) && Math.abs(env[a - 1].z1 - env[a].z0) < 1e-9) a--;
    while (b < env.length - 1 && near(env[b + 1]) && Math.abs(env[b + 1].z0 - env[b].z1) < 1e-9) b++;
    if (best[1] < 0 || env[b].z1 - env[a].z0 > env[best[1]].z1 - env[best[0]].z0) best = [a, b];
    i = b;
  }
  const z0 = env[best[0]].z0;
  const z1 = env[best[1]].z1;
  const flanged = best[0] > 0 && best[1] < env.length - 1;
  const axis = vnorm(applyXformsToDir(got.axis, xf));
  const c = applyXforms(vadd(got.o, vscale(got.axis, (z0 + z1) / 2)), xf);
  return { axis, c, rootD: 2 * root, width: z1 - z0, flange: flanged ? top - root : 0 };
}

// ---------------------------------------------------------------- layout

export interface WheelIn {
  k: "wheel";
  name: string;
  /** what it is, for messages: "drum", "40 mm sheave", "625 bearing" */
  label: string;
  /** the middle of where the rope sits, on the axis (world) */
  c: V3;
  axis: V3;
  rootD: number;
  /** width of the seat, mm, when known */
  width?: number;
  /** how far its flanges stand above the seat, mm, when known */
  flange?: number;
}
export interface TieIn {
  k: "tie";
  p: V3;
}
export type RopeIn = WheelIn | TieIn;

export interface RopeLayout {
  nodes: RopeNode[];
  spans: RopeSpan[];
  /** from end to end as drawn, with the turns stored on its drums, mm */
  length: number;
  /** the rope's centre line, for drawing: every turn on the drums, and without them */
  line: V3[];
  /** turns on a drum drawn as a sleeve in fast builds: the tube's outer and inner diameter, length, start and axis */
  sleeves: { od: number; id: number; h: number; at: V3; dir: V3 }[];
  short: V3[];
}

export interface LayoutOpts {
  /** wheels the rope passes on the other side of */
  flip?: Set<string>;
  /** the side of a drum the rope leaves from: over the top (the higher tangent) or under */
  wind?: "over" | "under";
  /** turns of rope on each drum as drawn */
  wraps: number;
}

/** The rope's centre-line radius round a wheel. */
const lineR = (rootD: number, d: number) => rootD / 2 + d / 2;

/** The side an end drum's rope leaves from: the tangent that is higher (then further along Y, then X), or the other. */
function drumDir(w: WheelIn, toward: V3, d: number, wind: "over" | "under", arriving: boolean): 1 | -1 {
  const r = lineR(w.rootD, d);
  const at = (dir: 1 | -1) => {
    const p = ropePath(arriving ? [{ c: toward, r: 0, dir: 1 }, { c: w.c, axis: w.axis, r, dir }] : [{ c: w.c, axis: w.axis, r, dir }, { c: toward, r: 0, dir: 1 }]);
    return arriving ? p.arrive[1] : p.depart[0];
  };
  const a = at(1);
  const b = at(-1);
  const k = Math.abs(a[2] - b[2]) > 1e-6 ? 2 : Math.abs(a[1] - b[1]) > 1e-6 ? 1 : 0;
  const high: 1 | -1 = a[k] >= b[k] ? 1 : -1;
  return wind === "over" ? high : (-high as 1 | -1);
}

/**
 * Lay the rope out as drawn. A wheel at an end of the path is a drum with turns of rope on it; wheels between are
 * sheaves, each on the inside of the bend the rope makes there (flip: sends it round the far side instead); a point
 * is where the rope is tied.
 */
export function layoutRope(input: RopeIn[], spec: RopeSpec, opts: LayoutOpts): RopeLayout {
  const N = input.length;
  if (N < 2) throw new RopeError("path: a rope needs two ends: a drum or a tie point at each, with any sheaves between, like path: [drum, top_sheave, (0, 0, 400)]");
  if (N > 40) throw new RopeError("path: a rope is limited to 40 drums, sheaves and ties");
  input.forEach((x, i) => {
    if (x.k === "tie" && i > 0 && i < N - 1) throw new RopeError("path: only the ends of a rope can be tie points; everything between is a sheave");
  });
  const d = spec.d;
  const centre = (x: RopeIn) => (x.k === "tie" ? x.p : x.c);
  for (let i = 0; i < N - 1; i++) if (vlen(vsub(centre(input[i + 1]), centre(input[i]))) < 1e-6) throw new RopeError(`path: ${nameOf(input[i], i, N)} and ${nameOf(input[i + 1], i + 1, N)} are in the same place`);
  const dirs: (1 | -1)[] = input.map((x, i) => {
    if (x.k === "tie") return 1;
    const a = vnorm(x.axis);
    if (i === 0) return drumDir(x, centre(input[1]), d, opts.wind ?? "over", false);
    if (i === N - 1) return drumDir(x, centre(input[N - 2]), d, opts.wind ?? "over", true);
    const P = centre(input[i - 1]);
    const Q = centre(input[i + 1]);
    const into = vsub(x.c, P);
    const out = vsub(Q, x.c);
    const turn = vdot(vcross(into, out), a) / (vlen(into) * vlen(out));
    if (Math.abs(turn) < 1e-3) throw new RopeError(`path: the rope runs straight past ${x.name}, so Kerf cannot tell which side of it the rope takes. Move ${x.name} to where the rope bends round it, or leave it out of path:`);
    const dir: 1 | -1 = turn > 0 ? 1 : -1;
    return opts.flip?.has(x.name) ? (-dir as 1 | -1) : dir;
  });
  // where the rope leaves a drum along its axis: its anchor is at one flange and the turns lie side by side from there
  const wraps = Math.max(0, opts.wraps);
  const lead = input.map((x, i) => {
    if (x.k !== "wheel" || (i > 0 && i < N - 1)) return { off: 0, side: 1 as 1 | -1 };
    const a = vnorm(x.axis);
    const toward = vdot(vsub(centre(input[i === 0 ? 1 : N - 2]), x.c), a);
    if (x.width === undefined || x.width <= d) return { off: 0, side: 1 as 1 | -1 };
    const half = (x.width - d) / 2;
    const offs = ([1, -1] as const).map((side) => ({ side, off: Math.max(-half, Math.min(half, -side * half + side * wraps * d)) }));
    return Math.abs(offs[0].off - toward) <= Math.abs(offs[1].off - toward) ? offs[0] : offs[1];
  });
  const pts: RopePoint[] = input.map((x, i) => (x.k === "tie" ? { c: x.p, r: 0, dir: 1 } : { c: vadd(x.c, vscale(vnorm(x.axis), lead[i].off)), axis: vnorm(x.axis), r: lineR(x.rootD, d), dir: dirs[i] }));
  const path = ropePath(pts);
  for (const i of path.inside) {
    const other = i > 0 && vlen(vsub(path.depart[i - 1], pts[i].c)) <= pts[i].r * 1.001 ? i - 1 : i + 1;
    throw new RopeError(`path: ${nameOf(input[other], other, N)} is inside the circle the rope makes round ${nameOf(input[i], i, N)}: move them apart`);
  }
  for (let i = 1; i < N - 1; i++) {
    const x = input[i];
    if (x.k === "wheel" && path.wrap[i] < (0.5 * Math.PI) / 180) throw new RopeError(`path: the rope does not bend round ${x.name}. List the sheaves in the order the rope meets them; flip: [${x.name}] takes it round the other side`);
  }

  const nodes: RopeNode[] = input.map((x, i) => {
    if (x.k === "tie") return { name: i === 0 ? "start" : "end", kind: "tie", c: x.p, r: 0, dir: 1, wrap: 0, label: i === 0 ? "first tie" : "second tie" };
    const end = i === 0 || i === N - 1;
    return {
      name: x.name,
      kind: end ? "drum" : "sheave",
      c: pts[i].c,
      axis: pts[i].axis,
      r: pts[i].r,
      rootD: x.rootD,
      dir: dirs[i],
      wrap: deg(Math.max(0, path.wrap[i])),
      width: x.width,
      flange: x.flange,
      ...(end ? { mid: x.c, wraps, stack: (-lead[i].side) as 1 | -1 } : {}),
      label: x.label,
    };
  });
  const spans: RopeSpan[] = path.spans.map((length, i) => ({ from: nodes[i].name, to: nodes[i + 1].name, a3: path.depart[i], b3: path.arrive[i + 1], length }));

  // the centre line: the turns on a starting drum, each straight run, the arc round each sheave, the turns on an end
  // drum. Round a wheel the line's corners stand just outside the rope's circle, so that with its corners rounded it
  // touches the circle between them and never cuts inside it (a rope drawn through chords would sink into its sheave)
  const line: V3[] = [];
  const short: V3[] = [];
  const sleeves: RopeLayout["sleeves"] = [];
  const both = (...p: V3[]) => {
    line.push(...p);
    short.push(...p);
  };
  const round = (nd: RopePoint, from: V3, sgn: number, T: number, stepMax: number, axial: (tau: number) => number, end: boolean): V3[] => {
    const a = nd.axis!;
    const e1 = vnorm(vsub(from, nd.c));
    const e2 = vcross(a, e1);
    const n = Math.max(1, Math.ceil(T / stepMax));
    const st = T / n;
    const at = (tau: number, R: number): V3 => vadd(nd.c, vadd(vscale(a, axial(tau)), vadd(vscale(e1, R * Math.cos(sgn * tau)), vscale(e2, R * Math.sin(sgn * tau)))));
    const out = Array.from({ length: n }, (_, k) => at((k + 0.5) * st, nd.r / Math.cos(st / 2)));
    if (end) out.push(at(T, nd.r));
    return out;
  };
  const rad = (x: number) => (x * Math.PI) / 180;
  const turns = (i: number, from: V3, sgn: number) => {
    // along the rope from where it leaves (a starting drum) or meets (an end drum) the barrel, round to its anchor
    const nd = pts[i];
    const T = wraps * TAU;
    const stack = -lead[i].side;
    const axial = (tau: number) => (stack * d * tau) / TAU;
    // fast builds: a quarter turn of rope, the rest a sleeve
    if (wraps > 0.5) sleeves.push({ od: 2 * nd.r + 0.96 * d, id: 2 * nd.r - 0.96 * d, h: wraps * d, at: vadd(nd.c, vscale(nd.axis!, stack > 0 ? -d / 2 : -(wraps * d) + d / 2)), dir: nd.axis! });
    return { full: round(nd, from, sgn, T, rad(15), axial, true), part: round(nd, from, sgn, Math.min(T, Math.PI / 2), rad(15), axial, true) };
  };
  for (let i = 0; i < N; i++) {
    const nd = pts[i];
    if (!nd.axis) {
      both(nd.c);
      continue;
    }
    if (i === 0) {
      const t = turns(0, path.depart[0], -nd.dir);
      line.push(...t.full.reverse());
      short.push(...t.part.reverse());
      continue;
    }
    if (i === N - 1) {
      const t = turns(i, path.arrive[i], nd.dir);
      line.push(...t.full);
      short.push(...t.part);
      continue;
    }
    both(...round(nd, path.arrive[i], nd.dir, Math.max(0, path.wrap[i]), rad(12), () => 0, false));
  }
  const stored = nodes.reduce((n, nd) => n + (nd.kind === "drum" ? (nd.wraps ?? 0) * TAU * nd.r : 0), 0);
  return { nodes, spans, length: path.free + stored, line, short, sleeves };
}

const nameOf = (x: RopeIn, i: number, n: number) => (x.k === "wheel" ? x.name : i === 0 ? "the first tie" : i === n - 1 ? "the second tie" : "a tie");

/** The length to buy: the rope as drawn, a tail at each tied end, to the next 50 mm. */
export function ropeCutLength(L: RopeLayout, spec: RopeSpec): number {
  const ties = L.nodes.filter((n) => n.kind === "tie").length;
  return Math.ceil((L.length + ties * TIE_TAIL * spec.d) / 50) * 50;
}

// ---------------------------------------------------------------- the solid

/** The centre line with points too close together dropped (a sweep stumbles on pieces shorter than the rope is thick). */
function spaced(pts: V3[], min: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const last = i === pts.length - 1;
    if (!out.length || vlen(vsub(pts[i], out[out.length - 1])) > min) out.push(pts[i]);
    else if (last) out[out.length - 1] = pts[i];
  }
  return out;
}

function sweepAlong(pts: V3[], d: number): ShapeRecipe | null {
  const p = spaced(pts, Math.max(0.3, d * 0.2));
  if (p.length < 2) return null;
  // straight pieces joined by arcs, as round as the shortest pieces allow
  let r = d * 2;
  for (let i = 1; i < p.length - 1; i++) {
    const lenIn = vlen(vsub(p[i], p[i - 1]));
    const lenOut = vlen(vsub(p[i + 1], p[i]));
    const cos = Math.max(-1, Math.min(1, vdot(vsub(p[i], p[i - 1]), vsub(p[i + 1], p[i])) / (lenIn * lenOut)));
    const turn = Math.acos(cos);
    if (turn > 1e-4) r = Math.min(r, (0.49 * Math.min(lenIn, lenOut)) / Math.tan(turn / 2));
  }
  const profile: Profile = { t: "circle", d: d * 0.96, c: [0, 0] };
  return { t: "sweep", p: profile, path: { t: "poly", pts: p, r }, rot: 0, frenet: false };
}

/** The rope as a solid: its round section swept along its centre line. Fast builds show the turns on a drum as a sleeve. */
export function ropeRecipe(L: RopeLayout, spec: RopeSpec): PartRecipe {
  const detail = sweepAlong(L.line, spec.d);
  const quick = sweepAlong(L.short, spec.d);
  if (!detail || !quick) throw new RopeError("path: the rope has no length");
  // side by side, not fused: joining the rope to the sleeve it runs into is slow and leaves a seam that does not close
  const fast: ShapeRecipe = L.sleeves.length ? { t: "instances", items: [quick, ...L.sleeves.map((s): ShapeRecipe => ({ t: "tube", od: s.od, id: s.id, h: s.h, at: s.at, dir: s.dir }))].map((shape) => ({ shape, xfs: [[]] })) } : quick;
  return { base: L.sleeves.length ? { t: "lod", fast, detail } : detail, ops: [] };
}
