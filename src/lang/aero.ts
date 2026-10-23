// Aerodynamic tube shapes for frames, forks, bars and seatposts: airfoil()
// is a NACA 4-digit symmetric section, cut square at the back to a Kammtail
// when tail: is below 1 (the shape aero bike tubes use: nearly the drag of
// the full teardrop at a fraction of its length, and inside the UCI's 3:1
// limit). aero_tube() runs that section between two points with its nose
// turned into the wind, tapering if the far end is given its own size.

import { def } from "./builtins";
import type { Args } from "./args";
import { ProfileV, ShapeV } from "./values";
import { vadd, vdot, vlen, vnorm, vscale, vsub, type Frame, type Profile, type ProfileSeg, type ShapeRecipe, type V2, type V3 } from "../kernel/recipe";

/** What an aero_tube is for, which sets its UCI section limits: main frame tubes, the head tube, stays and fork blades, bars and stems, seatposts. */
export type TubeRole = "main" | "head" | "stay" | "bar" | "post";
export const TUBE_ROLES: TubeRole[] = ["main", "head", "stay", "bar", "post"];

/** An aero_tube as written, in the part's own coordinates, so checks can read its section without measuring. */
export interface AeroTube {
  from: V3;
  to: V3;
  chord: number;
  thickness: number;
  chord2: number;
  thickness2: number;
  tail: number;
  role: TubeRole;
}

/** A shape from aero_tube(): the solid, plus the section it was made with. */
export class TubeV extends ShapeV {
  constructor(
    recipe: ShapeRecipe,
    public tube: AeroTube,
  ) {
    super(recipe);
  }
}

/** NACA 4-digit half thickness at x (0 nose to 1 tail) for thickness ratio tau, as a fraction of the chord. */
export const nacaHalf = (x: number, tau: number) => 5 * tau * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);

/** Bézier handle lengths for the tail curve, fitted to the NACA shape for where it is cut (as a fraction of the full chord). */
const TAIL_FIT: [number, number, number][] = [
  [0.4, 0.16, 0.56],
  [0.6, 0.24, 0.44],
  [0.72, 0.3, 0.34],
  [0.85, 0.38, 0.14],
  [1, 0.32, 0.24],
];

function tailFit(x: number): [number, number] {
  for (let i = 1; i < TAIL_FIT.length; i++) {
    const [x0, d0, e0] = TAIL_FIT[i - 1];
    const [x1, d1, e1] = TAIL_FIT[i];
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return [d0 + (d1 - d0) * t, e0 + (e1 - e0) * t];
    }
  }
  return [0.32, 0.24];
}

/**
 * The section as a closed profile: nose forward (+x), widest point at x = 0,
 * the cut tail (or the sharp trailing edge) at the back. Each side is two
 * Bézier curves fitted to the NACA shape (within 0.2 % of the thickness):
 * few faces, so tubes join quickly in the kernel.
 */
export function airfoilProfile(chord: number, thickness: number, tail: number): Profile {
  const full = chord / tail;
  const tau = thickness / full;
  const h = nacaHalf(0.3, tau) * full;
  const xm = 0.3 * full;
  // in section coordinates: x' = 0.3 c - x
  const X = (x: number) => xm - x;
  const yt = nacaHalf(tail, tau) * full;
  const slope = ((nacaHalf(Math.min(1, tail + 1e-5), tau) - nacaHalf(tail - 1e-5, tau)) / (Math.min(1, tail + 1e-5) - (tail - 1e-5))) * 1;
  const L = tail * full - xm;
  const [d, e] = tailFit(tail);
  const side = (k: 1 | -1) => ({
    // from the widest point back to the tail
    tail: { c1: [X(xm + d * L), k * h] as V2, c2: [X(tail * full - e * L), k * (yt - e * L * slope)] as V2, to: [X(tail * full), k * yt] as V2 },
    // from the nose to the widest point
    nose: { c1: [X(0), k * 0.54 * h] as V2, c2: [X(xm - 0.66 * xm), k * h] as V2, to: [0, k * h] as V2 },
  });
  const up = side(1);
  const lo = side(-1);
  const sharp = yt < 1e-3;
  const start: V2 = [X(tail * full), yt];
  const segs: ProfileSeg[] = [
    // tail top to the widest point, over the nose, back along the bottom to the tail
    { s: "bezier", c1: up.tail.c2, c2: up.tail.c1, to: [0, h] },
    { s: "bezier", c1: up.nose.c2, c2: up.nose.c1, to: [X(0), 0] },
    { s: "bezier", c1: lo.nose.c1, c2: lo.nose.c2, to: lo.nose.to },
    { s: "bezier", c1: lo.tail.c1, c2: lo.tail.c2, to: lo.tail.to },
  ];
  if (!sharp) segs.push({ s: "line", to: start });
  return { t: "path2", start, segs };
}

/** The section frame at a point on a tube: normal along the tube, profile x turned into the wind. */
export function aeroFrame(o: V3, along: V3, wind: V3): Frame | null {
  const t = vnorm(along);
  const c = vsub(wind, vscale(t, vdot(wind, t)));
  if (vlen(c) < 0.2) return null;
  return { o, u: vnorm(c), n: t };
}

/** A number or a list of numbers, one per station (a single number is used at every station). */
function perStation(a: Args, name: string, n: number, def?: number): number[] {
  const v = a.value(name);
  if (v === undefined) {
    if (def === undefined) a.ctx.error(`aero_path(): needs ${name}: (a number, or a list with one value per point)`);
    return Array(n).fill(def);
  }
  if (typeof v === "number") return Array(n).fill(v);
  if (Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number")) return v as number[];
  return a.ctx.error(`aero_path(): ${name}: should be a number or a list of ${n} numbers, one per point`);
}

export const AERO_FNS = Object.fromEntries([
  def(
    "airfoil",
    ["chord", "thickness", "tail"],
    (a) => {
      const chord = a.positive("chord");
      const thickness = a.positive("thickness");
      const tail = a.num("tail", 1);
      if (!(tail >= 0.4 && tail <= 1)) a.ctx.error("airfoil(): tail: is how much of the full teardrop is kept before the square cut, 0.4 to 1 (1 = a sharp trailing edge, 0.7 a typical Kammtail)");
      if (thickness >= chord) a.ctx.error(`airfoil(): thickness ${thickness} should be less than the chord ${chord}; an airfoil is longer than it is wide`);
      return new ProfileV(airfoilProfile(chord, thickness, tail));
    },
    "airfoil(chord, thickness, tail: 1) — a streamlined tube section (NACA 4-digit, symmetric), nose toward +x, widest point at (0, 0). tail: below 1 cuts it square at the back (a Kammtail: 0.65 to 0.8 keeps most of the low drag in a shorter, lighter, UCI-legal tube); chord is the length after the cut. Use with extrude, loft or aero_tube.",
  ),
  def(
    "aero_tube",
    ["from", "to", "chord", "thickness", "tail", "chord2", "thickness2", "wind", "wall", "role"],
    (a) => {
      const from = a.vec3("from");
      const to = a.vec3("to");
      const len = vlen(vsub(to, from));
      if (len < 1) a.ctx.error("aero_tube(): from and to are in the same place");
      const chord = a.positive("chord");
      const thickness = a.positive("thickness");
      const chord2 = a.has("chord2") ? a.positive("chord2") : chord;
      const thickness2 = a.has("thickness2") ? a.positive("thickness2") : thickness;
      const tail = a.num("tail", 0.72);
      if (!(tail >= 0.4 && tail <= 1)) a.ctx.error("aero_tube(): tail: should be 0.4 to 1 (1 = a sharp trailing edge, 0.72 a typical Kammtail)");
      for (const [c, t] of [
        [chord, thickness],
        [chord2, thickness2],
      ])
        if (t >= c) a.ctx.error(`aero_tube(): thickness ${t} should be less than the chord ${c}`);
      const wind = vnorm(a.dir("wind", [1, 0, 0]));
      const axis = vsub(to, from);
      const f0 = aeroFrame(from, axis, wind);
      if (!f0) a.ctx.error("aero_tube(): the tube points along the wind, so it has no side to streamline; aim it across the wind (wind: is the way the design travels, X by default)");
      const f1: Frame = { ...f0!, o: to };
      const wall = a.num("wall", 0);
      const role = a.oneOf("role", TUBE_ROLES, "main");
      const tube: AeroTube = { from, to, chord, thickness, chord2, thickness2, tail, role };
      const p0 = airfoilProfile(chord, thickness, tail);
      const p1 = airfoilProfile(chord2, thickness2, tail);
      const solid = (q0: Profile, q1: Profile, g0: Frame, g1: Frame, h: number): ShapeRecipe =>
        chord === chord2 && thickness === thickness2 ? { t: "extrude", p: q0, h, f: g0, twist: 0, scale: 1 } : { t: "loft", secs: [{ p: q0, f: g0 }, { p: q1, f: g1 }], ruled: false, matched: true };
      const outer = solid(p0, p1, f0!, f1, len);
      if (!wall) return new TubeV(outer, tube);
      if (wall < 0 || 2 * wall >= Math.min(thickness, thickness2)) a.ctx.error(`aero_tube(): wall ${wall} leaves no hollow in a ${Math.min(thickness, thickness2)} mm wide tube`);
      // hollow, open at both ends, so tubes that meet open into each other
      const t = vnorm(axis);
      const g0: Frame = { ...f0!, o: vsub(from, vscale(t, 0.5)) };
      const g1: Frame = { ...f0!, o: vsub(to, vscale(t, -0.5)) };
      // the same section, smaller by the wall all round (an exact offset of the curve makes booleans far slower)
      const inner = solid(airfoilProfile(chord - 2 * wall, thickness - 2 * wall, tail), airfoilProfile(chord2 - 2 * wall, thickness2 - 2 * wall, tail), g0, g1, len + 1);
      return new TubeV({ t: "diff", a: outer, b: [inner] }, tube);
    },
    `aero_tube(from, to, chord, thickness, tail: 0.72, chord2:, thickness2:, wind: X, wall: 0) — a streamlined (airfoil) tube from one point to another with its nose turned into the wind: bike frame tubes, fork blades, seatposts, aero bars, fairing struts. chord and thickness size the section (chord along the wind, after the Kammtail cut), chord2 and thickness2 taper it to the far end. wind: the way the design moves through the air. wall: makes it hollow (carbon tubes run about 1 to 1.5 mm), open at the ends so joined tubes open into each other. role: "main" (top, down and seat tubes), "head" (the head tube and fork crown), "stay" (seat stays, chainstays, fork blades), "bar" (handlebars, stems) or "post" (seatposts): the UCI check holds every element to 10 to 80 mm deep, and the head tube to 160 mm.`,
  ),
  def(
    "aero_path",
    ["points", "chord", "thickness", "tail", "wind", "role", "on"],
    (a) => {
      const pts = a.points3("points");
      const n = pts.length;
      if (n < 2) a.ctx.error("aero_path(): needs at least 2 points");
      if (n > 24) a.ctx.error("aero_path(): 24 points at most; a few well-placed stations give the same smooth skin");
      for (let i = 1; i < n; i++) if (vlen(vsub(pts[i], pts[i - 1])) < 1) a.ctx.error(`aero_path(): points ${i} and ${i + 1} are in the same place`);
      const chords = perStation(a, "chord", n);
      const thick = perStation(a, "thickness", n);
      const tails = perStation(a, "tail", n, 0.72);
      for (let i = 0; i < n; i++) {
        if (!(chords[i] > 0 && thick[i] > 0)) a.ctx.error(`aero_path(): station ${i + 1} needs a positive chord and thickness`);
        if (thick[i] >= chords[i]) a.ctx.error(`aero_path(): at point ${i + 1} the thickness ${thick[i]} should be less than the chord ${chords[i]}`);
        if (!(tails[i] >= 0.4 && tails[i] < 1)) a.ctx.error("aero_path(): tail: should be 0.4 to just under 1 at every point (the square-cut Kammtail; lofted tubes keep the cut so their sections match)");
      }
      const wind = vnorm(a.dir("wind", [1, 0, 0]));
      const role = a.oneOf("role", TUBE_ROLES, "main");
      // the points trace the widest part of the section, its leading edge or its trailing edge
      const on = a.oneOf("on", ["middle", "nose", "tail"] as const, "middle");
      // each station square to the path there (the direction between its neighbours), nose into the wind
      const secs = pts.map((o, i) => {
        const t = vsub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]);
        const f = aeroFrame(o, t, wind);
        if (!f) return a.ctx.error(`aero_path(): at point ${i + 1} the tube points along the wind, so it has no side to streamline; give it wind: Z (its section then stands up) or aim it across the wind`);
        const nose = (0.3 * chords[i]) / tails[i];
        const back = on === "nose" ? -nose : on === "tail" ? chords[i] - nose : 0;
        return { p: airfoilProfile(chords[i], thick[i], tails[i]), f: back ? { ...f, o: vadd(o, vscale(f.u, back)) } : f };
      });
      // the end points sit in the joints with other tubes, which the UCI leaves free: the tube is measured between them
      const mid = (v: number[]) => (n > 2 ? v.slice(1, -1) : v);
      const c = Math.max(...mid(chords));
      const th = Math.min(...mid(thick));
      const tube: AeroTube = { from: pts[0], to: pts[n - 1], chord: c, thickness: th, chord2: c, thickness2: th, tail: Math.min(...tails), role };
      return new TubeV({ t: "loft", secs, ruled: false, matched: true }, tube);
    },
    `aero_path(points: [p1, p2, ...], chord:, thickness:, tail: 0.72, wind: X, role: "main", on: "middle") — a streamlined tube along a smooth curve through the points, its section changing continuously from one point to the next: chord, thickness and tail take one number for the whole tube or a list with one value per point (a down tube 80 deep at the head tube easing to 55 at the bottom bracket: chord: [80, 70, 55]). Every section is square to the curve with its nose into the wind. on: "nose" makes the points trace the leading edge instead of the middle (a straight leading edge while the chord changes behind it: a seat tube whose tail is cut back to follow the tyre), "tail" the trailing edge. The way to build a moulded frame: run each tube through 3 to 5 points, start and end each one inside the tube or node it joins, and flare its end sections (bigger chord and thickness) so the joints blend; the first and last points sit in the joints, which the UCI leaves free, so the UCI check measures the stations between them. Keep end sections clearly inside or clearly across the surface they meet: nearly matching surfaces are slow to join.`,
  ),
]);
