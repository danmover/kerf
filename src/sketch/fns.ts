// Language functions that turn sketches into solids: extrude(), revolve() of a
// sketch, and plane() for sketches on arbitrary planes.
//
// extrude() and revolve() take over only when given a sketch; any other
// argument goes to the function of the same name registered before them, so
// other kinds of profile can share the names.

import { Args } from "../lang/args";
import { Fn, ShapeV, SketchLineObj, SketchObj, typeName, type CallCtx, type Value } from "../lang/values";
import { SHAPE_FNS } from "../lang/builtins";
import { MODELLING_FNS } from "../lang/modelling";
import type { V2 } from "../kernel/recipe";
import { makeFrame, planeValue } from "./planes";
import type { SketchGeom } from "./types";

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
      const a = new Args("extrude", pos, named, ctx, ["profile", "h", "start", "symmetric", "reverse", "through"]);
      const g = profileOf(a.value("profile"), ctx, "extrude");
      const through = a.bool("through");
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
      "extrude(sketch, h, start: 0, symmetric: false, reverse: false, through: false) — pushes the sketch's closed profile h along the plane's normal (negative h or reverse: true goes the other way). symmetric centres it on the plane; through: true makes a cutting tool through everything.",
    ),
  );

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
    const a = new Args("plane", pos, named, ctx, ["origin", "normal", "x"]);
    const origin = a.vec3("origin", [0, 0, 0]);
    const normal = a.dir("normal", [0, 0, 1]);
    const x = a.has("x") ? a.vec3("x") : undefined;
    if (![...origin, ...normal, ...(x ?? [])].every(Number.isFinite)) ctx.error("plane(): origin, normal and x must be finite");
    try {
      return planeValue(makeFrame(origin, normal, x), "plane");
    } catch (e) {
      return ctx.error((e as Error).message);
    }
  },
  "plane(origin: (0, 0, 0), normal: Z, x: …) — a sketch plane through origin facing normal. x sets which way the sketch's x axis points; it is chosen for you when left out.",
);

/** The sketch functions, layered over the functions already registered under the same names. */
export function sketchFns(before: (name: string) => Fn | undefined): Record<string, Fn> {
  return { extrude: extrudeOf(before("extrude")), revolve: revolveOf(before("revolve")), plane };
}

/** Over the profile and basic shape functions (as the evaluator layers them), for documentation and completion. */
export const SKETCH_FNS: Record<string, Fn> = sketchFns((name) => MODELLING_FNS[name] ?? SHAPE_FNS[name]);
