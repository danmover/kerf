// Elastic bands: O-rings and rubber bands stretched round a tube or post and
// hooked onto a part, the way a bike-computer mount or a light is held on a
// bar. Rubber is not a spring: its pull follows Gent's hyperelastic law (soft
// at first, stiffening as the chains run out of slack), the cord thins as it
// stretches, it relaxes over the months it is held stretched, and friction
// round the tube holds the part. This file has the rubber data, the law, how
// the band lies round its hooks and the tube's cross-section (read from the
// wrapped part's own recipe), and the band as a solid. The checks are in
// analysis/bands.ts; the fitting animation reads the same layout.

import type { PartRecipe, Profile, ShapeRecipe, V2, V3, Xform } from "../kernel/recipe";
import { applyXforms, applyXformsToDir, vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from "../kernel/recipe";

// ---------------------------------------------------------------- rubber

export interface Rubber {
  /** the name written in designs and the material record the band part uses */
  name: string;
  label: string;
  material: string;
  /** Shore A when none is given */
  shore: number;
  /** Gent's limit: the rubber locks up as λ² + 2/λ − 3 approaches Jm (sets how sharply it stiffens before it breaks) */
  Jm: number;
  /** elongation at break, as a fraction (2.5 = 250 %) */
  breakStrain: number;
  /** loss of pull per tenfold of time held stretched (stress relaxation), fraction */
  relax: number;
  /** loss factor: how much of each stretch it turns into heat (damping) */
  tanD: number;
  /** friction against smooth paint, lacquer or anodising: dry and wet */
  mu: [number, number];
  /** service temperature, °C */
  temp: [number, number];
  /** what sunlight and ozone do to it held stretched outdoors */
  weather: "good" | "poor";
  /** g/cm³ */
  density: number;
  /** cuts easily on a sharp edge (silicone) */
  tears?: boolean;
  note: string;
}

/**
 * Typical moulded O-ring and band compounds (Parker O-Ring Handbook ORD 5700
 * for temperatures and weathering; elongation and relaxation are typical
 * datasheet values for 70 Shore A compounds, natural rubber for a pure-gum band).
 */
export const RUBBERS: Record<string, Rubber> = {
  epdm: {
    name: "EPDM",
    label: "EPDM",
    material: "EPDM",
    shore: 70,
    Jm: 13,
    breakStrain: 2.5,
    relax: 0.04,
    tanD: 0.15,
    mu: [0.8, 0.5],
    temp: [-45, 130],
    weather: "good",
    density: 1.15,
    note: "the outdoor O-ring rubber: shrugs off sun, rain and ozone",
  },
  nbr: {
    name: "NBR",
    label: "nitrile (NBR)",
    material: "Nitrile",
    shore: 70,
    Jm: 16,
    breakStrain: 3,
    relax: 0.05,
    tanD: 0.2,
    mu: [0.8, 0.5],
    temp: [-30, 100],
    weather: "poor",
    density: 1.25,
    note: "the common black O-ring; ozone cracks it across the stretch outdoors",
  },
  silicone: {
    name: "silicone",
    label: "silicone",
    material: "Silicone",
    shore: 60,
    Jm: 18,
    breakStrain: 3.5,
    relax: 0.025,
    tanD: 0.08,
    mu: [0.9, 0.6],
    temp: [-55, 200],
    weather: "good",
    density: 1.2,
    tears: true,
    note: "weatherproof and grippy, but it tears from any nick or sharp edge",
  },
  natural: {
    name: "natural rubber",
    label: "natural rubber",
    material: "Natural rubber",
    shore: 40,
    Jm: 60,
    breakStrain: 6.5,
    relax: 0.04,
    tanD: 0.05,
    mu: [0.8, 0.5],
    temp: [-50, 70],
    weather: "poor",
    density: 0.95,
    note: "an ordinary rubber band: very stretchy, perishes in sunlight within weeks",
  },
};

export function rubberOf(name: string): Rubber | undefined {
  const k = name.trim().toLowerCase();
  if (/epdm/.test(k)) return RUBBERS.epdm;
  if (/nbr|nitrile|buna/.test(k)) return RUBBERS.nbr;
  if (/silicone|vmq/.test(k)) return RUBBERS.silicone;
  if (/natural|rubber band|latex|^nr$/.test(k)) return RUBBERS.natural;
  return undefined;
}

/** Young's modulus of rubber from its Shore A hardness, MPa (Gent 1958, BS 903). */
export function shoreToE(shore: number): number {
  const s = Math.min(95, Math.max(20, shore));
  return (0.0981 * (56 + 7.62336 * s)) / (0.137505 * (254 - 2.54 * s));
}

/**
 * Nominal (engineering) stress in a rubber cord stretched λ times, MPa, by
 * Gent's model: s = G (λ − 1/λ²) · Jm / (Jm − (λ² + 2/λ − 3)). Near the
 * limit it climbs steeply; past it the rubber has broken.
 */
export function gentStress(lambda: number, G: number, Jm: number): number {
  if (lambda <= 1) return 0;
  const I = lambda * lambda + 2 / lambda - 3;
  if (I >= Jm * 0.999) return Infinity;
  return (G * (lambda - 1 / (lambda * lambda)) * Jm) / (Jm - I);
}

export interface BandCord {
  rubber: Rubber;
  shore: number;
  /** cord diameter unstretched, mm */
  cs: number;
  /** inside diameter of the loop unstretched (O-ring size), mm */
  id: number;
}

/** Shear modulus of the cord, MPa. */
export const shearOf = (c: BandCord) => shoreToE(c.shore) / 3;

/** Mean circumference of the unstretched loop: what stretches, mm. */
export const freeLength = (c: BandCord) => Math.PI * (c.id + c.cs);

/** Pull in one strand of the cord stretched λ times, N. */
export function strandTension(c: BandCord, lambda: number): number {
  return gentStress(lambda, shearOf(c), c.rubber.Jm) * ((Math.PI * c.cs * c.cs) / 4);
}

/** Rubber keeps its volume: a cord stretched λ times is 1/√λ as thick. */
export const stretchedCord = (cs: number, lambda: number) => cs / Math.sqrt(Math.max(1, lambda));

/** The share of its pull a band keeps after being held stretched for `minutes` (from one minute after fitting). */
export function relaxedShare(r: Rubber, minutes: number): number {
  return Math.max(0.3, 1 - r.relax * Math.log10(Math.max(1, minutes)));
}

/** Stretch at which the cord breaks. */
export const breakStretch = (r: Rubber) => 1 + r.breakStrain;
/** Most it should be held stretched for a long life: half its elongation at break. */
export const holdLimit = (r: Rubber) => 1 + 0.5 * r.breakStrain;
/** Most it should be stretched while fitting, now and then: three quarters of its elongation at break. */
export const fitLimit = (r: Rubber) => 1 + 0.75 * r.breakStrain;

// ---------------------------------------------------------------- cross-sections

export class BandError extends Error {}

/** Points round a 2D profile, sampled finely enough for a band lying on it. */
export function profilePoints(p: Profile): V2[] {
  const circle = (c: V2, rx: number, ry: number, n = 64): V2[] => Array.from({ length: n }, (_, i) => [c[0] + rx * Math.cos((2 * Math.PI * i) / n), c[1] + ry * Math.sin((2 * Math.PI * i) / n)] as V2);
  switch (p.t) {
    case "circle":
      return circle(p.c, p.d / 2, p.d / 2);
    case "ellipse":
      return circle(p.c, p.w / 2, p.h / 2);
    case "rect": {
      const r = Math.min(p.r, p.w / 2, p.h / 2);
      const out: V2[] = [];
      const corners: [number, number, number][] = [
        [p.w / 2 - r, p.h / 2 - r, 0],
        [-p.w / 2 + r, p.h / 2 - r, 90],
        [-p.w / 2 + r, -p.h / 2 + r, 180],
        [p.w / 2 - r, -p.h / 2 + r, 270],
      ];
      for (const [x, y, a0] of corners)
        for (let i = 0; i <= 8; i++) {
          const a = ((a0 + (90 * i) / 8) * Math.PI) / 180;
          out.push([p.c[0] + x + r * Math.cos(a), p.c[1] + y + r * Math.sin(a)]);
        }
      return out;
    }
    case "poly":
      return p.pts.map((q) => [q[0], q[1]] as V2);
    case "path2": {
      const out: V2[] = [p.start];
      let at = p.start;
      for (const s of p.segs) {
        if (s.s === "line") out.push(s.to);
        else if (s.s === "arc") out.push(...arcThrough(at, s.via, s.to, 24));
        else for (let i = 1; i <= 16; i++) out.push(bezier(at, s.c1, s.c2, s.to, i / 16));
        at = s.to;
      }
      return out;
    }
    case "offset": {
      const base = profilePoints(p.p);
      if (p.d >= 0) return base.flatMap((q) => circle(q, p.d, p.d, 12));
      // shrinking: pull the hull in toward its middle
      const c = centroid2(base);
      return base.map((q) => {
        const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
        const k = d > 1e-9 ? Math.max(0, d + p.d) / d : 0;
        return [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k] as V2;
      });
    }
    case "fillet2":
      return profilePoints(p.p);
    case "union2":
      return p.ps.flatMap(profilePoints);
    case "diff2":
      return profilePoints(p.a);
    case "common2":
      return profilePoints(p.a);
    case "place2": {
      const a = (p.rot * Math.PI) / 180;
      return profilePoints(p.p).map((q) => [q[0] * Math.cos(a) - q[1] * Math.sin(a) + p.by[0], q[0] * Math.sin(a) + q[1] * Math.cos(a) + p.by[1]] as V2);
    }
    case "text":
      return [
        [p.c[0] - (p.size * p.text.length) / 2, p.c[1] - p.size / 2],
        [p.c[0] + (p.size * p.text.length) / 2, p.c[1] + p.size / 2],
      ];
  }
}

function arcThrough(a: V2, m: V2, b: V2, n: number): V2[] {
  // circle through three points
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return [m, b];
  const sq = (q: V2) => q[0] * q[0] + q[1] * q[1];
  const c: V2 = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d];
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const ang = (q: V2) => Math.atan2(q[1] - c[1], q[0] - c[0]);
  const a0 = ang(a);
  let am = ang(m) - a0;
  let a1 = ang(b) - a0;
  const wrap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  am = wrap(am);
  a1 = wrap(a1);
  // go the way that passes through m
  const sweep = am <= a1 ? a1 : a1 - 2 * Math.PI;
  return Array.from({ length: n }, (_, i) => {
    const t = a0 + (sweep * (i + 1)) / n;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as V2;
  });
}

function bezier(p0: V2, p1: V2, p2: V2, p3: V2, t: number): V2 {
  const s = 1 - t;
  return [s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0], s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1]];
}

const centroid2 = (pts: V2[]): V2 => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
};

/** Counter-clockwise convex hull (Andrew's monotone chain). */
export function hull2(points: V2[]): V2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The outline a band meets on a part, in world space: the part must be an
 * extrusion (a profile pushed along a direction), a cylinder or a tube, so
 * the band's plane is square to that direction. Returns sampled points of the
 * outline, the direction and where along it the part starts and ends.
 */
export interface Section {
  pts: V3[];
  axis: V3;
  /** a point on the axis at the start of the extrusion, and its length */
  start: V3;
  length: number;
}

export function sectionOf(recipe: PartRecipe, partXf: Xform[]): Section {
  if (!recipe.base) throw new BandError("it has no body to wrap");
  const s = shapeSection(recipe.base, []);
  if (!s) throw new BandError("its body is not an extrusion, cylinder or tube, so its cross-section cannot be read. Build it with extrude(profile, h, dir: ...), cylinder() or tube()");
  return {
    pts: s.pts.map((p) => applyXforms(p, partXf)),
    axis: vnorm(applyXformsToDir(s.axis, partXf)),
    start: applyXforms(s.start, partXf),
    length: s.length,
  };
}

function shapeSection(sh: ShapeRecipe, xf: Xform[]): Section | null {
  const done = (pts: V3[], axis: V3, start: V3, length: number): Section => ({ pts: pts.map((p) => applyXforms(p, xf)), axis: vnorm(applyXformsToDir(axis, xf)), start: applyXforms(start, xf), length });
  switch (sh.t) {
    case "xform":
      // the inner shape's transforms run first, then the outer ones
      return shapeSection(sh.shape, [...sh.xf, ...xf]);
    case "union":
      return sh.shapes.length ? shapeSection(sh.shapes[0], xf) : null;
    case "diff":
      return shapeSection(sh.a, xf);
    case "lod":
      return shapeSection(sh.fast, xf);
    case "cyl":
    case "tube": {
      const n = vnorm(sh.dir);
      const u = vnorm(Math.abs(n[2]) > 0.9 ? vcross([0, 1, 0], n) : vcross([0, 0, 1], n));
      const v = vcross(n, u);
      const r = (sh.t === "cyl" ? sh.d : sh.od) / 2;
      const pts = Array.from({ length: 72 }, (_, i) => {
        const a = (2 * Math.PI * i) / 72;
        return vadd(sh.at, vadd(vscale(u, r * Math.cos(a)), vscale(v, r * Math.sin(a))));
      });
      return done(pts, n, sh.at, sh.h);
    }
    case "extrude": {
      if (Math.abs(sh.scale - 1) > 1e-6 || Math.abs(sh.twist) > 1e-6) return null;
      const n = vnorm(sh.f.n);
      const u = vnorm(sh.f.u);
      const v = vcross(n, u);
      const pts = profilePoints(sh.p).map((q) => vadd(sh.f.o, vadd(vscale(u, q[0]), vscale(v, q[1]))));
      return done(pts, n, sh.f.o, Math.abs(sh.h));
    }
    case "box": {
      // box(w, d, h, at:) stands on `at` (the centre of its bottom) and rises along Z
      const { w, d, h } = sh;
      const pts: V3[] = [
        [sh.at[0] - w / 2, sh.at[1] - d / 2, sh.at[2]],
        [sh.at[0] + w / 2, sh.at[1] - d / 2, sh.at[2]],
        [sh.at[0] + w / 2, sh.at[1] + d / 2, sh.at[2]],
        [sh.at[0] - w / 2, sh.at[1] + d / 2, sh.at[2]],
      ];
      return done(pts, [0, 0, 1], sh.at, h);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- layout

export interface HookIn {
  /** where the loop end sits: the centre of the pin it wraps */
  at: V3;
  /** pin diameter */
  pin: number;
  /** how far past its seat the loop has to be stretched to get over the hook's head or lip, mm */
  lip: number;
  /** the way the loop would come off the hook (along the pin, toward its free end) */
  open: V3;
}

export interface BandInput {
  cord: BandCord;
  /** hooked at both ends: one end on `from`, wrapped round, stretched over `to` */
  from?: HookIn;
  to?: HookIn;
  /** the parts it wraps, with their outlines */
  around: { name: string; section: Section }[];
  /** the band's plane normal; by default the wrapped part's own direction */
  axis?: V3;
  /**
   * both hooks are double hooks: two prongs this far apart along the tube,
   * centred on from and to. The two strands then run round at the prongs'
   * heights instead of side by side, and each end turns round its pair of
   * prongs, the way a rear light's band holds. 0: single pins.
   */
  spread?: number;
}

export interface BandLayout {
  doubled: boolean;
  /** band plane: origin, normal and in-plane axes (u points from the hooks toward what it wraps) */
  o: V3;
  n: V3;
  u: V3;
  v: V3;
  /** centre line of one strand from the `from` hook round to the `to` hook (or the whole loop when it only goes round), world */
  route: V3[];
  /** the closed centre line of the cord as drawn, world */
  loop: V3[];
  /** stretched loop length, mm */
  length: number;
  /** length while the free end is held over the second hook's lip, mm */
  fitLength: number;
  free: number;
  stretch: number;
  fitStretch: number;
  /** pull in each strand when seated and while fitting, N */
  tension: number;
  fitTension: number;
  /** the force on each hook (both strands), world, N */
  hooks: { at: V3; force: V3; pin: number; lip: number; open: V3; toward: V3 }[];
  /** how far round the wrapped parts the band turns (degrees) and the length it lies on them */
  wrapDeg: number;
  contact: number;
  /** total force the band presses onto what it wraps (sum of T dθ over both strands), N */
  squeeze: number;
  /** cord diameter when seated */
  cord: number;
  /** a closed loop round a part that carries on beyond the band on both sides (a seatpost, bar or tube): it cannot be put on */
  captive?: string;
  /** a hook beyond the end of what the band wraps: the band slips off that end */
  pastEnd?: string;
  /** a hook whose pull drags the loop toward its open end */
  offHook?: number;
  /** the hooks are not in one plane square to the axis: how far apart along it they are, mm */
  skew?: number;
  /** then it runs round at a slant, rising evenly from one hook to the other: its angle to the plane square to the axis, degrees */
  slant: number;
  /** a double hook's two prongs apart along the axis, mm (0 for single pins) */
  spread: number;
}

const to2 = (p: V3, o: V3, u: V3, v: V3): V2 => [vdot(vsub(p, o), u), vdot(vsub(p, o), v)];
const to3 = (q: V2, o: V3, u: V3, v: V3, h = 0, n: V3 = [0, 0, 0]): V3 => vadd(o, vadd(vadd(vscale(u, q[0]), vscale(v, q[1])), vscale(n, h)));
const len2 = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Polyline length. */
function polyLen(pts: V2[], closed = false): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += len2(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) s += len2(pts[pts.length - 1], pts[0]);
  return s;
}

/** The wrapped outline grown by the cord's radius: the line the cord's centre runs along. */
function grown(pts: V2[], r: number): V2[] {
  const h = hull2(pts);
  if (r <= 0) return h;
  return hull2(h.flatMap((q) => Array.from({ length: 16 }, (_, i) => [q[0] + r * Math.cos((Math.PI * i) / 8), q[1] + r * Math.sin((Math.PI * i) / 8)] as V2)));
}

/** Total turning of a path at its inner points, radians. */
function turning(pts: V2[]): number {
  let t = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a: V2 = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    const b: V2 = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]];
    const la = Math.hypot(...a);
    const lb = Math.hypot(...b);
    if (la < 1e-9 || lb < 1e-9) continue;
    t += Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb))));
  }
  return t;
}

/** The longer of the two ways round a closed polygon from index i to j that passes the far side (`far`: the direction toward what is wrapped). */
function wayRound(q: V2[], i: number, j: number, far: V2): V2[] {
  const n = q.length;
  const fwd: V2[] = [];
  for (let k = i; ; k = (k + 1) % n) {
    fwd.push(q[k]);
    if (k === j) break;
  }
  const back: V2[] = [];
  for (let k = i; ; k = (k - 1 + n) % n) {
    back.push(q[k]);
    if (k === j) break;
  }
  const reach = (path: V2[]) => (path.length <= 2 ? -Infinity : Math.max(...path.slice(1, -1).map((p) => p[0] * far[0] + p[1] * far[1])));
  return reach(fwd) >= reach(back) ? fwd : back;
}

/** Where a band lies and how hard it pulls, for a band hooked at both ends or a closed loop round its parts. */
export function layoutBand(inp: BandInput): BandLayout {
  const c = inp.cord;
  if (!inp.around.length) throw new BandError("around: name the part (or parts) the band wraps round, like around: post");
  const doubled = !!(inp.from && inp.to);
  if (!!inp.from !== !!inp.to) throw new BandError("give both from: and to: (the two hooks the band's ends go over), or neither for a loop that goes right round");
  const spread = doubled ? Math.max(0, inp.spread ?? 0) : 0;
  if (spread > 0 && spread < Math.max(inp.from!.pin, inp.to!.pin) + c.cs)
    throw new BandError(`spread: a double hook's prongs must be at least a prong and a cord apart (${fmt(Math.max(inp.from!.pin, inp.to!.pin) + c.cs)} mm), or the band's end has nothing to run down between them`);
  const axisIn = inp.axis ?? inp.around[0].section.axis;
  const n = vnorm(axisIn);
  // the band's plane passes through the first hook, or the middle of what it wraps (half way along it)
  const allPts = inp.around.flatMap((a) => a.section.pts);
  const mid3 = vscale(
    inp.around.reduce((s, a) => vadd(s, vadd(vscale(a.section.pts.reduce((q, p) => vadd(q, p), [0, 0, 0] as V3), 1 / a.section.pts.length), vscale(a.section.axis, a.section.length / 2))), [0, 0, 0] as V3),
    1 / inp.around.length,
  );
  const o = doubled ? inp.from!.at : mid3;
  const hookMid = doubled ? vscale(vadd(inp.from!.at, inp.to!.at), 0.5) : o;
  let u = vsub(mid3, hookMid);
  u = vsub(u, vscale(n, vdot(u, n)));
  if (vlen(u) < 1e-6) u = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : vcross([0, 0, 1], n);
  u = vnorm(u);
  const v = vcross(n, u);
  const sec2 = allPts.map((p) => to2(p, o, u, v));

  const free = freeLength(c);
  // the stretched cord is thinner, which moves its centre line in: two passes settle it
  let cord = c.cs;
  // the second hook's height above the first along the axis: the band rises evenly between them, the way a
  // stretched cord lies on a prism (straight once the surface is unrolled), so it reaches both hooks
  const rise = doubled ? vdot(vsub(inp.to!.at, inp.from!.at), n) : 0;
  let out: Omit<BandLayout, "tension" | "fitTension" | "hooks" | "squeeze" | "stretch" | "fitStretch" | "fitLength" | "slant" | "spread"> & { hookDirs: V2[]; climb: number } = null!;
  for (let pass = 0; pass < 3; pass++) {
    const P = grown(sec2, cord / 2 + 0.05);
    if (!doubled) {
      const loop2 = P;
      const length = polyLen(loop2, true);
      out = {
        doubled,
        o,
        n,
        u,
        v,
        route: [...loop2, loop2[0]].map((q) => to3(q, o, u, v)),
        loop: [...loop2, loop2[0]].map((q) => to3(q, o, u, v)),
        length,
        free,
        wrapDeg: 360,
        contact: length,
        cord,
        hookDirs: [],
        climb: 0,
      };
    } else {
      const A = to2(inp.from!.at, o, u, v);
      const B = to2(inp.to!.at, o, u, v);
      const inside = (q: V2) => {
        const h = P;
        for (let i = 0; i < h.length; i++) {
          const a = h[i];
          const b = h[(i + 1) % h.length];
          if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) < 0) return false;
        }
        return true;
      };
      if (inside(A)) throw new BandError("from: the hook sits inside the part the band wraps; put it on the part the band holds, beside or behind the tube");
      if (inside(B)) throw new BandError("to: the hook sits inside the part the band wraps; put it on the part the band holds, beside or behind the tube");
      const Q = hull2([...P, A, B]);
      const ia = Q.findIndex((q) => len2(q, A) < 1e-9);
      const ib = Q.findIndex((q) => len2(q, B) < 1e-9);
      if (ia < 0 || ib < 0) throw new BandError(`${ia < 0 ? "from" : "to"}: the band cannot run straight from this hook to the tube; the other hook or the tube is in the way. Put the hooks either side of the tube, behind it`);
      const route2 = wayRound(Q, ia, ib, [1, 0]);
      const wrap = turning(route2);
      // two strands from hook to hook, and the loop end turned round each pin
      const rA = inp.from!.pin / 2 + cord / 2 + 0.05;
      const rB = inp.to!.pin / 2 + cord / 2 + 0.05;
      const D = polyLen(route2);
      // each strand climbs `rise` over its run round: its height at each point of the route
      const along = route2.map((_, i) => polyLen(route2.slice(0, i + 1)));
      const heights = along.map((a) => (D > 1e-9 ? (rise * a) / D : 0));
      const strand = Math.hypot(D, rise);
      // each end turns half way round its pin, or a quarter round each prong of a double hook with the run between them
      const length = 2 * strand + 2 * spread + Math.PI * (rA + rB);
      // the length lying on the wrapped parts: between the first and last points that came from it
      let contact = 0;
      for (let i = 2; i < route2.length - 1; i++) contact += len2(route2[i - 1], route2[i]);
      contact *= D > 1e-9 ? strand / D : 1;
      const dA = norm2([route2[1][0] - A[0], route2[1][1] - A[1]]);
      const dB = norm2([route2[route2.length - 2][0] - B[0], route2[route2.length - 2][1] - B[1]]);
      const h = cord / 2 + 0.02;
      out = {
        doubled,
        o,
        n,
        u,
        v,
        route: route2.map((q, i) => to3(q, o, u, v, heights[i], n)),
        loop: (spread > 0 ? spreadLoop(route2, heights, A, B, dA, dB, rA, rB, spread) : doubledLoop(route2, heights, A, B, dA, dB, rA, rB, h)).map(([q, z]) => to3(q, o, u, v, z, n)),
        length,
        free,
        wrapDeg: (wrap * 180) / Math.PI,
        contact,
        cord,
        hookDirs: [dA, dB],
        climb: D > 1e-9 ? rise / D : 0,
      };
    }
    cord = stretchedCord(c.cs, out.length / free);
  }
  const stretch = out.length / free;
  const tension = strandTension(c, stretch);
  const hooks: BandLayout["hooks"] = [];
  let fitLength = out.length;
  let offHook: number | undefined;
  if (doubled) {
    // getting the second end over its hook's lip stretches both strands that much further
    fitLength = out.length + 2 * inp.to!.lip;
    [inp.from!, inp.to!].forEach((hk, i) => {
      const d2 = out.hookDirs[i];
      // along the strand as it leaves the hook: up toward the second hook from the first, down from the second
      const toward = vnorm(vadd(vadd(vscale(u, d2[0]), vscale(v, d2[1])), vscale(n, i ? -out.climb : out.climb)));
      hooks.push({ at: hk.at, force: vscale(toward, 2 * tension), pin: hk.pin, lip: hk.lip, open: vnorm(hk.open), toward });
      // the band pulls toward the tube; a hook that opens that way lets it slide off
      if (vdot(toward, vnorm(hk.open)) > 0.34 && offHook === undefined) offHook = i;
    });
  }
  const fitStretch = fitLength / free;
  // skew: the second hook out of the first hook's plane square to the axis
  const skew = Math.abs(rise);
  const slant = (Math.atan(Math.abs(out.climb)) * 180) / Math.PI;
  // a closed loop round something that carries on both sides cannot be put on
  let captive: string | undefined;
  if (!doubled)
    for (const a of inp.around) {
      const along = vdot(vsub(o, a.section.start), a.section.axis);
      const size = Math.max(...a.section.pts.map((p) => vlen(vsub(vsub(p, a.section.start), vscale(a.section.axis, vdot(vsub(p, a.section.start), a.section.axis))))));
      const beyond = Math.max(25, 1.5 * size);
      if (along > beyond && a.section.length - along > beyond) {
        captive = a.name;
        break;
      }
    }
  // hooks beyond either end of what the band wraps leave it nothing to lie on there (a double hook's strands run outside its prongs)
  let pastEnd: string | undefined;
  const reach = spread > 0 ? spread / 2 + Math.max(inp.from!.pin, inp.to!.pin) / 2 + out.cord / 2 : 0;
  if (doubled)
    for (const a of inp.around) {
      const at = [inp.from!.at, inp.to!.at].map((p) => vdot(vsub(p, a.section.start), a.section.axis));
      if (Math.min(...at) - reach < -out.cord / 2 || Math.max(...at) + reach > a.section.length + out.cord / 2) {
        pastEnd = a.name;
        break;
      }
    }
  const { hookDirs: _hd, climb, ...rest } = out;
  void _hd;
  return {
    ...rest,
    stretch,
    fitStretch,
    fitLength,
    tension,
    fitTension: strandTension(c, fitStretch),
    hooks,
    // a cord at a slant presses on what it wraps with cos(slant) of its pull per radian
    squeeze: ((doubled ? 2 : 1) * tension * ((out.wrapDeg * Math.PI) / 180)) / Math.hypot(1, climb),
    captive,
    pastEnd,
    offHook,
    skew: skew > Math.max(1.5, c.cs) ? skew : undefined,
    slant,
    spread,
  };
}

const norm2 = (a: V2): V2 => {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};

/**
 * The cord's centre line for a band hooked at both ends: out along the route
 * on one level, round the back of the second pin, and back on the level
 * beside it, round the back of the first pin. Each point carries its height
 * off the band plane: the route's own height there (heights, one per route
 * point, rising from the first hook to the second) with the two strands h
 * either side of it.
 */
function doubledLoop(route: V2[], heights: number[], A: V2, B: V2, dA: V2, dB: V2, rA: number, rB: number, h: number): [V2, number][] {
  const left = (d: V2): V2 => [-d[1], d[0]];
  const nA = left(dA);
  const nB = left(dB);
  const half = (c: V2, d: V2, nn: V2, r: number, from: number, to: number, flip: boolean): [V2, number][] => {
    // from the strand's side of the pin, round its back (away from the tube) to the other side
    const pts: [V2, number][] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (Math.PI * i) / 12;
      const s = flip ? -1 : 1;
      const dir: V2 = [s * nn[0] * Math.cos(a) - d[0] * Math.sin(a), s * nn[1] * Math.cos(a) - d[1] * Math.sin(a)];
      pts.push([[c[0] + r * dir[0], c[1] + r * dir[1]], from + ((to - from) * i) / 12]);
    }
    return pts;
  };
  const inner = route.slice(1, -1).map((q, i): [V2, number] => [q, heights[i + 1]]);
  const zA = heights[0];
  const zB = heights[heights.length - 1];
  const out: [V2, number][] = [];
  // strand one, from beside the first pin to beside the second, on the upper level
  for (const [q, z] of inner) out.push([q, z + h]);
  // round the back of the second pin: it arrives on the pin's right as seen travelling from A
  out.push(...half(B, dB, nB, rB, zB + h, zB - h, false));
  for (const [q, z] of [...inner].reverse()) out.push([q, z - h]);
  out.push(...half(A, dA, nA, rA, zA - h, zA + h, false));
  void A;
  return out;
}

/**
 * The cord's centre line for a band whose ends go round double hooks: the
 * upper strand along the route over the top prongs, down the far side of the
 * second hook's prongs (away from the tube), back along the route under the
 * lower prongs and up the far side of the first hook's. heights are the
 * route's own (rising from the first hook to the second); the strands run s/2
 * plus the bend radius above and below them.
 */
function spreadLoop(route: V2[], heights: number[], A: V2, B: V2, dA: V2, dB: V2, rA: number, rB: number, s: number): [V2, number][] {
  const along = route.map((_, i) => polyLen(route.slice(0, i + 1)));
  const D = along[along.length - 1] || 1;
  const off = (i: number) => s / 2 + rA + ((rB - rA) * along[i]) / D;
  const inner = route.slice(1, -1).map((q, i) => ({ q, z: heights[i + 1], off: off(i + 1) }));
  // a quarter turn round one prong, on the hook's far side from the tube: a from 0 (on top) to π (underneath)
  const turn = (c: V2, d: V2, r: number, zc: number, a0: number, a1: number): [V2, number][] =>
    Array.from({ length: 7 }, (_, i) => {
      const a = a0 + ((a1 - a0) * i) / 6;
      return [[c[0] - d[0] * r * Math.sin(a), c[1] - d[1] * r * Math.sin(a)], zc + r * Math.cos(a)];
    });
  const zA = heights[0];
  const zB = heights[heights.length - 1];
  const out: [V2, number][] = [];
  out.push(...turn(A, dA, rA, zA + s / 2, Math.PI / 2, 0));
  for (const p of inner) out.push([p.q, p.z + p.off]);
  out.push(...turn(B, dB, rB, zB + s / 2, 0, Math.PI / 2));
  out.push(...turn(B, dB, rB, zB - s / 2, Math.PI / 2, Math.PI));
  for (const p of [...inner].reverse()) out.push([p.q, p.z - p.off]);
  out.push(...turn(A, dA, rA, zA - s / 2, Math.PI, Math.PI / 2));
  return out;
}

// ---------------------------------------------------------------- putting it on

export type FitPhase = "hook" | "wrap" | "over" | "seated";

export interface FitPose {
  phase: FitPhase;
  /** the cord's closed centre line, world */
  loop: V3[];
  /** where the hand holds the free end, world */
  hand: V3;
  stretch: number;
  /** pull in each strand, N */
  tension: number;
  cord: number;
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * The band part way through being put on, k from 0 to 1: hooked over its
 * first pin and held taut behind it (hook), pulled round the far side of what
 * it wraps and stretched just past the second pin's head, lifted over it
 * (wrap), let down onto the pin (over), and seated as layoutBand lays it. The
 * stretch at the top of the wrap is the fitting stretch the checks give.
 */
export function fittingPose(layout: BandLayout, around: Section[], c: BandCord, k: number): FitPose {
  const seated = (): FitPose => ({ phase: "seated", loop: layout.loop, hand: layout.hooks[1]?.at ?? layout.o, stretch: layout.stretch, tension: layout.tension, cord: layout.cord });
  if (!layout.doubled || layout.hooks.length < 2 || k >= 0.92) return seated();
  const { o, u, v, n } = layout;
  const [hA, hB] = layout.hooks;
  const A = to2(hA.at, o, u, v);
  const B = to2(hB.at, o, u, v);
  const P = grown(around.flatMap((a) => a.pts).map((p) => to2(p, o, u, v)), layout.cord / 2 + 0.05);
  const c2 = centroid2(P);
  const rA = hA.pin / 2 + layout.cord / 2 + 0.05;
  const rE = hB.pin / 2 + layout.cord / 2 + 0.05;
  const s = layout.spread;
  // the second hook's height above the first: the hand carries the free end up (or down) to it on the way round
  const rise = vdot(vsub(hB.at, hA.at), n);
  // over a pin's head the end is lifted along the tube; onto a double hook it comes in from the prongs' free ends
  const side: V2 | null = s > 0 ? norm2([vdot(hB.open, u), vdot(hB.open, v)]) : null;
  // the free end held taut straight back from the first pin
  const away = norm2([A[0] - c2[0], A[1] - c2[1]]);
  const reach = Math.max(4, (layout.free - Math.PI * (rA + rE)) / 2);
  const E0: V2 = [A[0] + away[0] * reach, A[1] + away[1] * reach];
  // stretched just past the second pin's head, along the way it arrives
  const route2 = layout.route.map((p) => to2(p, o, u, v));
  const last = route2[route2.length - 2] ?? A;
  const dB = norm2([B[0] - last[0], B[1] - last[1]]);
  const E1: V2 = [B[0] + dB[0] * hB.lip, B[1] + dB[1] * hB.lip];
  const lift = 1.5 * layout.cord + 2.5 * hB.lip + 1;
  // swing round the far side, never closer to the outline than a finger's width
  const ang = (q: V2) => Math.atan2(q[1] - c2[1], q[0] - c2[0]);
  const mid = route2[Math.floor(route2.length / 2)] ?? [c2[0] + 1, c2[1]];
  const a0 = ang(E0);
  const a1 = ang(E1);
  const am = ang(mid);
  const wrapTo = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // the sense that passes the route's middle on the way
  const sweep = wrapTo(a1 - a0);
  const sense = wrapTo(am - a0) <= sweep ? 1 : -1;
  const span = sense > 0 ? sweep : 2 * Math.PI - sweep;
  const support = (a: number) => Math.max(...P.map((q) => (q[0] - c2[0]) * Math.cos(a) + (q[1] - c2[1]) * Math.sin(a)));
  // the strands from the first pin to the hand: straight until the hand has
  // taken them round the outline, then along it the way the hand went (the
  // hull runs counter-clockwise, the positive sense)
  const strands = (E: V2): V2[] => {
    const Q = hull2([...P, A, E]);
    const ia = Q.findIndex((q) => len2(q, A) < 1e-9);
    const ie = Q.findIndex((q) => len2(q, E) < 1e-9);
    const route: V2[] = [A];
    if (ia >= 0 && ie >= 0) for (let i = (ia + sense + Q.length) % Q.length; i !== ie; i = (i + sense + Q.length) % Q.length) route.push(Q[i]);
    route.push(E);
    return route;
  };
  const loopLength = (E: V2, h: number) => 2 * Math.hypot(polyLen(strands(E)), h) + 2 * s + Math.PI * (rA + rE);
  let E: V2;
  let h = 0;
  // the hand's height above the first pin, before any lift over the head
  let hE = 0;
  let phase: FitPhase;
  if (k < 0.12) {
    phase = "hook";
    E = E0;
  } else if (k < 0.72) {
    phase = "wrap";
    // the hand goes round at whatever distance stretches the band steadily
    // from slack to its stretch just past the second head
    const f = ease((k - 0.12) / 0.6);
    const a = a0 + sense * span * f;
    h = lift * ease((f - 0.6) / 0.4);
    hE = rise * f;
    const want = layout.free + (loopLength(E1, lift + rise) - layout.free) * f;
    const at = (R: number): V2 => [c2[0] + R * Math.cos(a), c2[1] + R * Math.sin(a)];
    let lo = support(a) + rE + 0.5;
    let hi = Math.max(lo + 1, len2(E0, c2) * 2, 4 * len2(E1, c2));
    if (loopLength(at(lo), h + hE) >= want) hi = lo;
    else for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (loopLength(at(m), h + hE) < want) lo = m;
      else hi = m;
    }
    E = at(hi);
  } else {
    phase = "over";
    const f = ease((k - 0.72) / 0.2);
    E = [E1[0] + (B[0] - E1[0]) * f, E1[1] + (B[1] - E1[1]) * f];
    // it slides down the head's steep underside once past the rim
    h = lift * (1 - f * f);
    hE = rise;
  }
  const route = strands(E);
  const D = polyLen(route);
  const length = 2 * Math.hypot(D, h + hE) + 2 * s + Math.PI * (rA + rE);
  const stretch = Math.max(1, length / layout.free);
  const cord = stretchedCord(c.cs, stretch);
  const dA = norm2([route[1][0] - A[0], route[1][1] - A[1]]);
  const dE = norm2([route[route.length - 2][0] - E[0], route[route.length - 2][1] - E[1]]);
  const zh = cord / 2 + 0.02;
  // the strands climb evenly to the hand's height; the end in the hand rises over the head with it, the end on the first pin stays down
  const heights = route.map((_, i) => (D > 1e-9 ? (hE * polyLen(route.slice(0, i + 1))) / D : 0));
  const drawn = s > 0 ? spreadLoop(route, heights, A, E, dA, dE, rA, rE, s) : doubledLoop(route, heights, A, E, dA, dE, rA, rE, zh);
  const loop = drawn.map(([q, z]) => {
    const a = len2(q, A);
    const w = a / (a + len2(q, E) || 1);
    const k = h * w * w;
    return side ? to3([q[0] + side[0] * k, q[1] + side[1] * k], o, u, v, z, n) : to3(q, o, u, v, z + k, n);
  });
  const hand = side ? to3([E[0] + side[0] * h, E[1] + side[1] * h], o, u, v, hE, n) : to3(E, o, u, v, h + hE, n);
  return { phase, loop, hand, stretch, tension: strandTension(c, stretch), cord };
}

// ---------------------------------------------------------------- solid

/** The band as drawn: its cord swept round the loop, closed on itself. */
export function bandRecipe(layout: BandLayout): PartRecipe {
  const pts = dedupe(layout.loop);
  // a closed run of short straight pieces with rounded joints: a closed spline sweeps into a broken solid in OpenCASCADE.
  // The seam sits in the middle of a strand.
  const path = { t: "poly" as const, pts: [...pts, pts[0]], r: 0 };
  const swept: ShapeRecipe = { t: "sweep", p: { t: "circle", d: layout.cord * 0.96, c: [0, 0] }, path, rot: 0, frenet: false };
  return { base: swept, ops: [] };
}

function dedupe(pts: V3[]): V3[] {
  const out: V3[] = [];
  // about a millimetre apart: finer only slows the sweep down
  for (const p of pts) if (!out.length || vlen(vsub(p, out[out.length - 1])) > 1.2) out.push(p);
  if (out.length > 2 && vlen(vsub(out[0], out[out.length - 1])) < 1.2) out.pop();
  // start half way along the first strand so the seam is on a straight run
  const k = Math.floor(out.length / 8);
  return [...out.slice(k), ...out.slice(0, k)];
}

/** One line per thing the band does, for its BOM entry and the reference. */
export function bandLabel(c: BandCord): string {
  return `O-ring ${fmt(c.id)} × ${fmt(c.cs)} mm, ${c.rubber.label} ${fmt(c.shore)}A`;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
