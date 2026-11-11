// Language functions that turn sketches into solids: extrude(), revolve() of a
// sketch, and plane() for sketches on arbitrary planes.
//
// extrude() and revolve() take over only when given a sketch; any other
// argument goes to the function of the same name registered before them, so
// other kinds of profile can share the names.

import { Args } from "../lang/args";
import { Fn, Obj, PathV, ShapeV, SketchLineObj, SketchObj, Vec, typeName, type CallCtx, type Value } from "../lang/values";
import { SHAPE_FNS } from "../lang/builtins";
import { MODELLING_FNS, extrudeOptions, extrudeRecipe } from "../lang/modelling";
import { UNTIL_LIMIT, rotateAbout, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type Path3, type Profile, type ProfileRegion, type Seg2, type ShapeRecipe, type V2, type V3 } from "../kernel/recipe";
import { frameOf, isPlane, makeFrame, planeValue } from "./planes";
import type { Frame, SketchGeom } from "./types";

function profileOf(v: Value | undefined, ctx: CallCtx, fname: string): SketchGeom {
  if (!(v instanceof SketchObj)) {
    if (Array.isArray(v)) return ctx.error(`${fname}(): give it a sketch. For a list of points use prism() or revolve(points: ...)`);
    return ctx.error(`${fname}(): the first argument should be a sketch, got ${v === undefined ? "nothing" : typeName(v)}`);
  }
  const g = v.geom;
  if (g.profileError) ctx.error(`${fname}(): sketch ${g.name} has no usable profile: ${g.profileError}`);
  if (!g.regions.length) ctx.error(`${fname}(): sketch ${g.name} has no closed profile yet. Join the outline so every line end meets another, or add a circle.`);
  if (!g.solved) ctx.warn?.(`${fname}(): sketch ${g.name} is not solved, so this uses its outline as drawn. Fix the sketch's constraints first.`);
  return g;
}

const isSketchCall = (pos: Value[], named: Record<string, Value>) => pos[0] instanceof SketchObj || named.profile instanceof SketchObj;
const joinDocs = (before: Fn | undefined, own: string) => (before?.doc ? `${before.doc} Or ${own}` : own);

const extrudeOf = (before: Fn | undefined) =>
  new Fn(
    "extrude",
    (pos, named, ctx) => {
      if (before && !isSketchCall(pos, named)) return before.call(pos, named, ctx);
      const a = new Args("extrude", pos, named, ctx, ["profile", "h", "start", "symmetric", "reverse", "through", "taper", "thin", "thin_side", "until"]);
      const g = profileOf(a.value("profile"), ctx, "extrude");
      const through = a.bool("through");
      if (a.has("taper") || a.has("thin") || a.has("until")) return new ShapeV(extrudeMore(a, g, through));
      let h = through ? 2000 : a.num("h");
      if (!through && Math.abs(h) < 1e-9) ctx.error("extrude(): h must not be 0");
      let start = a.num("start", 0);
      const reverse = a.bool("reverse") !== h < 0;
      h = Math.abs(h);
      if (through || a.bool("symmetric")) start -= h / 2;
      else if (reverse) start -= h;
      const f = g.frame;
      return new ShapeV({ t: "sk_extrude", o: f.o, u: f.u, n: f.n, regions: g.regions, h, start });
    },
    joinDocs(
      before,
      'extrude(sketch, h, start: 0, symmetric: false, reverse: false, through: false, taper: 0, thin: 0, thin_side: "inside", until: "next") — pushes the sketch\'s closed profile h along the plane\'s normal (negative h or reverse: true goes the other way). symmetric centres it on the plane; through: true makes a cutting tool through everything. taper, thin and until work as in extrude() of a profile: draft on the sides, only a wall along the outline, or up to the next face of the part it is added to or cut from.',

    ),
  );

/** One closed sketch loop as a profile. */
function loopProfile(segs: Seg2[]): Profile {
  const first = segs[0];
  if (first.k === "c") return { t: "circle", d: 2 * first.r, c: first.c };
  return { t: "path2", start: first.a, segs: segs.map((s) => (s.k === "a" ? { s: "arc", via: s.m, to: s.b } : { s: "line", to: (s as { b: V2 }).b })) };
}

/** A sketch's closed regions as one profile: each outline less its holes. */
export function regionsProfile(regions: ProfileRegion[]): Profile {
  const each = regions.map((r): Profile => (r.holes.length ? { t: "diff2", a: loopProfile(r.outer), b: r.holes.map(loopProfile) } : loopProfile(r.outer)));
  return each.length === 1 ? each[0] : { t: "union2", ps: each };
}

/** A sketch extrusion with a taper, a thin wall or up to the next face: made as an extrusion of the sketch's profile. */
function extrudeMore(a: Args, g: SketchGeom, through: boolean): ShapeRecipe {
  const o = extrudeOptions(a, regionsProfile(g.regions));
  const start = a.num("start", 0);
  const symmetric = a.bool("symmetric");
  let span: [number, number];
  if (o.until) {
    if (through) a.ctx.error('extrude(): give through: true or until: "next", not both');
    if (symmetric) a.ctx.error('extrude(): until: "next" runs one way from the sketch; leave out symmetric');
    span = a.bool("reverse") ? [start, start - UNTIL_LIMIT] : [start, start + UNTIL_LIMIT];
  } else if (through) {
    if (o.taper) a.ctx.error("extrude(): a taper through everything would close the profile up; give the depth it needs");
    span = [start - UNTIL_LIMIT / 2, start + UNTIL_LIMIT / 2];
  } else {
    const h = a.num("h");
    if (Math.abs(h) < 1e-9) a.ctx.error("extrude(): h must not be 0");
    const d = Math.abs(h);
    const reverse = a.bool("reverse") !== h < 0;
    span = symmetric ? [start - d / 2, start + d / 2] : reverse ? [start - d, start] : [start, start + d];
  }
  return extrudeRecipe(o.p, g.frame, span, { taper: o.taper, until: o.until });
}

const revolveOf = (before: Fn | undefined) =>
  new Fn(
    "revolve",
    (pos, named, ctx) => {
      if (before && !isSketchCall(pos, named)) return before.call(pos, named, ctx);
      const a = new Args("revolve", pos, named, ctx, ["profile", "axis", "angle"]);
      const g = profileOf(a.value("profile"), ctx, "revolve");
      const ax = a.value("axis");
      let line: [V2, V2];
      if (ax === undefined) line = g.lines.y_axis;
      else if (ax instanceof SketchLineObj) {
        if (ax.sketch !== g.name) ctx.error(`revolve(): the axis must be a line of sketch ${g.name} (like ${g.name}.y_axis), not of ${ax.sketch}`);
        line = [ax.a, ax.b];
      } else return ctx.error(`revolve(): axis should be a line of the sketch, like ${g.name}.y_axis, got ${typeName(ax)}`);
      const angle = a.num("angle", 360);
      if (!(angle > 0 && angle <= 360)) ctx.error(`revolve(): angle must be between 0 and 360 degrees (got ${angle})`);
      const [p, q] = line;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 1e-9) ctx.error("revolve(): the axis line has no length");
      const d: V2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      // the profile must stay on one side of the axis, or the solid would pass through itself
      let lo = 0;
      let hi = 0;
      for (const e of g.extent) {
        const s = d[0] * (e[1] - p[1]) - d[1] * (e[0] - p[0]);
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
      if (lo < -1e-6 && hi > 1e-6) ctx.error(`revolve(): the profile of ${g.name} crosses the axis line. Keep it entirely on one side of the axis.`);
      const f = g.frame;
      return new ShapeV({ t: "sk_revolve", o: f.o, u: f.u, n: f.n, regions: g.regions, axis: [p, d], angle });
    },
    joinDocs(before, "revolve(sketch, axis: sketch.line, angle: 360) — spins a sketch's closed profile about one of its lines (default: the sketch's y_axis)."),
  );

const plane = new Fn(
  "plane",
  (pos, named, ctx) => {
    const a = new Args("plane", pos, named, ctx, ["origin", "normal", "x", "offset", "turn", "about", "through", "between", "normal_to", "at"]);
    const base = a.value("origin");
    const ways = [isPlane(base as Value), a.has("through"), a.has("between"), a.has("normal_to")].filter(Boolean).length;
    if (ways > 1) ctx.error("plane(): give one of a plane to start from, through:, between: or normal_to:");
    let f: Frame;
    try {
      if (base !== undefined && isPlane(base)) {
        if (a.has("normal")) ctx.error("plane(): a plane to start from already has its normal; use turn: to tilt it");
        f = frameOf(base);
      } else if (a.has("through")) f = throughPoints(a);
      else if (a.has("between")) f = midway(a);
      else if (a.has("normal_to")) f = squareToPath(a);
      else {
        const origin = a.vec3("origin", [0, 0, 0]);
        const normal = a.dir("normal", [0, 0, 1]);
        const x = a.has("x") ? a.vec3("x") : undefined;
        if (![...origin, ...normal, ...(x ?? [])].every(Number.isFinite)) ctx.error("plane(): origin, normal and x must be finite");
        f = makeFrame(origin, normal, x);
      }
      if (a.has("x") && (isPlane(base as Value) || a.has("between") || a.has("normal_to") || a.has("through"))) f = makeFrame(f.o, f.n, a.vec3("x"));
      const off = a.num("offset", 0);
      if (off) f = { ...f, o: vadd(f.o, vscale(f.n, off)) };
      const turn = a.num("turn", 0);
      if (turn) f = turned(a, f, turn);
      else if (a.has("about")) ctx.error("plane(): about: goes with turn: (the angle to tilt it by)");
    } catch (e) {
      if (e instanceof Error && !(e instanceof RangeError) && e.message.startsWith("plane()")) return ctx.error(e.message);
      throw e;
    }
    return planeValue(f, "plane");
  },
  'plane(origin: (0, 0, 0), normal: Z, x: …) — a sketch plane through origin facing normal; x sets which way the sketch\'s x axis points (chosen for you when left out). Reference planes: plane(XY, offset: 10) moves a plane (any plane value: XZ, a sketch\'s .plane) along its normal; turn: 30 tilts it about its own x axis through its origin (about: "y" for its y axis, or about: a line given as [p1, p2] or a sketch line like side.l1, for a plane through an edge at an angle); through: [a, b, c] is the plane through three points; between: [p1, p2] is the plane midway between two parallel planes (a mid-plane for symmetric features); normal_to: a path, at: 0..1 is square to the path there (the start of a sweep).',
);

const P3 = (v: Value | undefined, what: string, ctx: CallCtx): V3 => {
  if (v instanceof Vec && v.v.length >= 2) return [v.v[0], v.v[1], v.v[2] ?? 0];
  return ctx.error(`plane(): ${what} should be a point (x, y, z), got ${v === undefined ? "nothing" : typeName(v)}`);
};

/** The plane through three points: origin at the first, x towards the second, normal by the right-hand rule. */
function throughPoints(a: Args): Frame {
  const v = a.value("through");
  if (!Array.isArray(v) || v.length !== 3) return a.ctx.error("plane(): through: takes three points, [a, b, c]");
  const [p, q, r] = v.map((x, i) => P3(x, `point ${i + 1} of through:`, a.ctx));
  const n = vcross(vsub(q, p), vsub(r, p));
  if (vlen(n) < 1e-9 * Math.max(1, vlen(vsub(q, p)) * vlen(vsub(r, p)))) a.ctx.error("plane(): the three points of through: are in a line, so they don't fix a plane");
  return makeFrame(p, n, vsub(q, p));
}

/** Midway between two parallel planes, facing the way the first one does. */
function midway(a: Args): Frame {
  const v = a.value("between");
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => isPlane(x))) return a.ctx.error("plane(): between: takes two planes, [p1, p2] (XY, a sketch's .plane or plane(...))");
  const [A, B] = v.map((x) => frameOf(x as Obj));
  if (Math.abs(vdot(A.n, B.n)) < Math.cos((1 * Math.PI) / 180)) a.ctx.error("plane(): the two planes of between: are not parallel; use turn: for a plane at an angle");
  const gap = vdot(vsub(B.o, A.o), A.n);
  return { ...A, o: vadd(A.o, vscale(A.n, gap / 2)) };
}

/** Square to a path at a fraction of the way along it (0 its start, 1 its end). */
function squareToPath(a: Args): Frame {
  const v = a.value("normal_to");
  if (!(v instanceof PathV)) return a.ctx.error(`plane(): normal_to: should be a path such as path([...]) or helix(...), got ${v === undefined ? "nothing" : typeName(v)}`);
  const t = a.num("at", 0);
  if (!(t >= 0 && t <= 1)) a.ctx.error("plane(): at: is how far along the path, from 0 (its start) to 1 (its end)");
  const { at, tangent } = pathPoint(v.recipe, t);
  if (vlen(tangent) < 1e-12) a.ctx.error("plane(): the path has no direction there");
  return makeFrame(at, tangent);
}

/** A point on a path and the way it runs there, a fraction t along it (rounded corners and spline bends followed approximately). */
export function pathPoint(p: Path3, t: number): { at: V3; tangent: V3 } {
  if (p.t === "arc3") {
    // the circle through a, b, c
    const ab = vsub(p.b, p.a);
    const ac = vsub(p.c, p.a);
    const n = vcross(ab, ac);
    const nn = vdot(n, n);
    if (nn < 1e-18) return { at: vadd(p.a, vscale(vsub(p.c, p.a), t)), tangent: vnorm(vsub(p.c, p.a)) };
    const centre = vadd(p.a, vscale(vadd(vscale(vcross(n, ab), vdot(ac, ac)), vscale(vcross(ac, n), vdot(ab, ab))), 1 / (2 * nn)));
    const r0 = vsub(p.a, centre);
    const r2v = vsub(p.c, centre);
    const k = vnorm(n);
    let sweep = Math.atan2(vdot(vcross(r0, r2v), k), vdot(r0, r2v));
    if (sweep <= 0) sweep += 2 * Math.PI;
    const ang = sweep * t;
    const radial = vadd(vscale(r0, Math.cos(ang)), vscale(vcross(k, r0), Math.sin(ang)));
    return { at: vadd(centre, radial), tangent: vnorm(vcross(k, radial)) };
  }
  if (p.t === "helix") {
    const turns = p.h / p.pitch;
    const ang = 2 * Math.PI * turns * t * (p.left ? -1 : 1);
    const n = vnorm(p.dir);
    const u = makeFrame([0, 0, 0], n).u;
    const w = vcross(n, u);
    const r = p.d / 2;
    const at = vadd(p.at, vadd(vadd(vscale(u, r * Math.cos(ang)), vscale(w, r * Math.sin(ang))), vscale(n, p.h * t)));
    const s = p.left ? -1 : 1;
    const tangent = vnorm(vadd(vscale(vadd(vscale(u, -r * Math.sin(ang)), vscale(w, r * Math.cos(ang))), 2 * Math.PI * turns * s), vscale(n, p.h)));
    return { at, tangent };
  }
  // poly and spline: along the straight runs between the points
  const pts = p.pts;
  const lens = pts.slice(1).map((q, i) => vlen(vsub(q, pts[i])));
  const total = lens.reduce((x, y) => x + y, 0);
  let left = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const d = vnorm(vsub(pts[i + 1], pts[i]));
      return { at: vadd(pts[i], vscale(d, Math.min(left, lens[i]))), tangent: d };
    }
    left -= lens[i];
  }
  return { at: pts[0], tangent: [0, 0, 1] };
}

/** A plane tilted by `turn` degrees about its x or y axis through its origin, or about a line. */
function turned(a: Args, f: Frame, turn: number): Frame {
  const ab = a.value("about");
  let o = f.o;
  let axis: V3;
  if (ab === undefined || ab === "x") axis = f.u;
  else if (ab === "y") axis = f.v;
  else if (ab instanceof SketchLineObj || (ab instanceof Obj && ab.fields.start && ab.fields.end)) {
    const p = P3(ab.fields.start, "the line's start", a.ctx);
    const q = P3(ab.fields.end, "the line's end", a.ctx);
    axis = vsub(q, p);
    o = p;
  } else if (Array.isArray(ab) && ab.length === 2) {
    const [p, q] = ab.map((x, i) => P3(x, `point ${i + 1} of about:`, a.ctx));
    axis = vsub(q, p);
    o = p;
  } else return a.ctx.error('plane(): about: is "x" or "y" (the plane\'s own axes), a line [p1, p2] or a sketch line');
  if (vlen(axis) < 1e-9) a.ctx.error("plane(): the line of about: has no length");
  const k = vnorm(axis);
  const rot = (v: V3) => rotateAbout(v, [0, 0, 0], k, turn);
  // the plane turns about a line through `o`: its origin moves round it too (a no-op when the line runs through it)
  const origin = vadd(o, rot(vsub(f.o, o)));
  return { o: origin, u: rot(f.u), v: rot(f.v), n: rot(f.n) };
}

/** The sketch functions, layered over the functions already registered under the same names. */
export function sketchFns(before: (name: string) => Fn | undefined): Record<string, Fn> {
  return { extrude: extrudeOf(before("extrude")), revolve: revolveOf(before("revolve")), plane };
}

/** Over the profile and basic shape functions (as the evaluator layers them), for documentation and completion. */
export const SKETCH_FNS: Record<string, Fn> = sketchFns((name) => MODELLING_FNS[name] ?? SHAPE_FNS[name]);
