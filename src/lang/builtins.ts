// Builtin functions and constants for the Kerf language.

import { Args } from "./args";
import { Fn, Obj, Pending, ProfileV, Ref, ShapeV, Vec, typeName, type CallCtx, type Value } from "./values";
import { frameAt, vlen, vnorm, vsub, type ShapeRecipe, type ThreadSpec3, type V2, type V3 } from "../kernel/recipe";
import { parseSection, sectionProfile } from "./frames";
import { THREADS } from "../library/standards";
import { centerDistance } from "../library/gears";
import { LIBRARY } from "../library/components";
import { threadTurnsError } from "../kernel/threadMath";

const deg = Math.PI / 180;
const Z: V3 = [0, 0, 1];

type Impl = (a: Args) => Value;

export function def(name: string, params: string[], impl: Impl, doc: string): [string, Fn] {
  return [
    name,
    new Fn(
      name,
      (pos, named, ctx) => impl(new Args(name, pos, named, ctx, params)),
      doc,
    ),
  ];
}

function num(v: Value, ctx: CallCtx, what: string): number {
  if (typeof v === "number") return v;
  return ctx.error(`${what} should be a number, got ${typeName(v)}`);
}

function listOf(v: Value, ctx: CallCtx, what: string): Value[] {
  if (Array.isArray(v)) return v;
  if (v instanceof Vec) return v.v;
  return ctx.error(`${what} should be a list`);
}

/** Thread-aware hole diameter: hole(M3, fit: "clearance" | "close" | "tap" | "insert" | "thread") */
function holeDiameter(a: Args): { d: number; thread?: (typeof THREADS)[string]; tapped?: ThreadSpec3 } {
  const v = a.value("d");
  if (typeof v === "number") {
    if (a.has("fit")) a.ctx.error('hole(): fit: needs a thread size, e.g. hole(M4, fit: "thread", depth: 8)');
    return { d: v };
  }
  const t = a.thread("d");
  const fit = a.str("fit", "clearance");
  if (fit === "thread") return { d: t.d, thread: t, tapped: { d: t.d, pitch: t.pitch, form: "iso", starts: 1, left: false, clearance: 0.1 } };
  if (fit === "insert" && !t.insert_d) a.ctx.error(`hole(): there is no common heat-set insert for ${t.name}; use fit: "thread" (a real threaded hole) or "tap"`);
  const d = fit === "tap" ? t.tap : fit === "close" ? t.close : fit === "insert" ? t.insert_d : fit === "clearance" ? t.clearance : NaN;
  if (Number.isNaN(d)) a.ctx.error(`hole(): fit must be "clearance", "close", "tap", "insert" or "thread" (got "${fit}")`);
  return { d, thread: t };
}

export const SHAPE_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "box",
    ["w", "d", "h", "at", "r", "center"],
    (a) => {
      const w = a.positive("w");
      const d = a.positive("d");
      const h = a.positive("h");
      let at = a.vec3("at", [0, 0, 0]);
      if (a.bool("center")) at = [at[0], at[1], at[2] - h / 2];
      const r = a.num("r", 0);
      if (r < 0 || r * 2 >= Math.min(w, d)) a.ctx.error(`box(): corner radius r=${r} must be between 0 and half the smaller side (${Math.min(w, d) / 2})`);
      return new ShapeV({ t: "box", w, d, h, at, r });
    },
    "box(w, d, h, at: (x, y, z), r: 0, center: false) — w along X, d along Y, h up from at.z. `at` is the centre of the bottom face. r rounds the vertical edges.",
  ),
  def(
    "cylinder",
    ["d", "h", "at", "dir", "r"],
    (a) => {
      const d = a.has("r") ? a.positive("r") * 2 : a.positive("d");
      return new ShapeV({ t: "cyl", d, h: a.positive("h"), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z) });
    },
    "cylinder(d:, h:, at:, dir: Z) — starts at `at` and extends h along dir.",
  ),
  def(
    "tube",
    ["od", "id", "h", "at", "dir"],
    (a) => {
      const od = a.positive("od");
      const id = a.positive("id");
      if (id >= od) a.ctx.error(`tube(): id (${id}) must be smaller than od (${od})`);
      return new ShapeV({ t: "tube", od, id, h: a.positive("h"), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z) });
    },
    "tube(od:, id:, h:, at:, dir: Z) — hollow cylinder.",
  ),
  def(
    "cone",
    ["d1", "d2", "h", "at", "dir"],
    (a) => new ShapeV({ t: "cone", d1: a.num("d1"), d2: a.num("d2"), h: a.positive("h"), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z) }),
    "cone(d1:, d2:, h:, at:, dir: Z) — d1 at `at`, d2 at the far end.",
  ),
  def(
    "flight",
    ["d", "core_d", "pitch", "length", "t", "root_t", "at", "dir", "left"],
    (a) => {
      const d = a.positive("d");
      const core = a.positive("core_d");
      if (core >= d) a.ctx.error(`flight(): core_d (${core}) must be smaller than d (${d})`);
      const pitch = a.positive("pitch");
      const tip = a.positive("t", 2.5);
      const root = a.positive("root_t", Math.max(tip, tip * 1.6));
      if (root >= pitch) a.ctx.error(`flight(): root_t (${root}) must be smaller than the pitch (${pitch})`);
      return new ShapeV({ t: "flight", d, core_d: core, pitch, length: a.positive("length"), tip, root, at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), left: a.bool("left", false) });
    },
    "flight(d:, core_d:, pitch:, length:, t: 2.5, root_t: 1.6 t, at:, dir: Z, left: false) — helical screw flight (auger, screw conveyor) from core_d out to d, starting at `at` and running length along dir. t is the tip thickness, root_t the thickness where it meets the core. left: true for a left-hand helix. Add it to a tube or cylinder of core_d.",
  ),
  def("sphere", ["d", "at"], (a) => new ShapeV({ t: "sphere", d: a.positive("d"), at: a.vec3("at", [0, 0, 0]) }), "sphere(d:, at:)"),
  def(
    "prism",
    ["points", "h", "at", "dir", "rot"],
    (a) => {
      const pts = a.points2("points");
      if (pts.length < 3) a.ctx.error("prism(): needs at least 3 points");
      return new ShapeV({ t: "prism", pts, h: a.positive("h"), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), rot: a.num("rot", 0) });
    },
    "prism(points: [(u, v), ...], h:, at:, dir: Z, rot: 0) — extrudes a polygon. Points are in the plane across dir: for dir Z, u=X and v=Y; for a horizontal dir, v is up (+Z) and u = Z × dir.",
  ),
  def(
    "rrect",
    ["w", "h", "r", "depth", "at", "dir", "center"],
    (a) => {
      const w = a.positive("w");
      const h = a.positive("h");
      const r = a.num("r", 0);
      if (r < 0 || r * 2 > Math.min(w, h) + 1e-9) a.ctx.error(`rrect(): r must be at most half of the smaller side (${Math.min(w, h) / 2})`);
      return new ShapeV({ t: "rrect", w, h, r: Math.min(r, Math.min(w, h) / 2 - 1e-3), depth: a.positive("depth"), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), center: a.bool("center") });
    },
    "rrect(w:, h:, r:, depth:, at:, dir:, center: false) — rounded rectangle extruded along dir; `at` is the centre of the profile. For a horizontal dir, h is vertical. Ideal for wall cutouts.",
  ),
  def(
    "slot",
    ["length", "width", "depth", "at", "dir"],
    (a) => {
      const L = a.positive("length");
      const W = a.positive("width");
      return new ShapeV({ t: "rrect", w: Math.max(L, W), h: W, r: W / 2 - 1e-3, depth: a.positive("depth"), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), center: false });
    },
    "slot(length:, width:, depth:, at:, dir:) — obround slot.",
  ),
  def(
    "revolve",
    ["points", "at", "dir"],
    (a) => {
      const pts = a.points2("points");
      if (pts.length < 3) a.ctx.error("revolve(): needs at least 3 points (r, z)");
      if (pts.some((p) => p[0] < -1e-9)) a.ctx.error("revolve(): radius values must be ≥ 0");
      return new ShapeV({ t: "revolve", pts, at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z) });
    },
    "revolve(points: [(r, z), ...], at:, dir: Z) — closed profile of (radius, axial position) revolved around the axis through `at`. Use for shafts, pulleys and bosses.",
  ),
  def(
    "hole",
    ["d", "depth", "at", "dir", "through", "fit", "cbore", "csink", "lead"],
    (a) => {
      const { d, thread, tapped } = holeDiameter(a);
      const through = a.bool("through");
      if (tapped && through) a.ctx.error('hole(): a threaded hole needs depth: (how deep the thread goes) instead of through: true');
      const depth = through ? 2000 : a.positive("depth");
      let cbore: V2 | undefined;
      const cb = a.value("cbore");
      if (cb === true) {
        if (!thread) return a.ctx.error("hole(): cbore: true needs a thread size, e.g. hole(M3, cbore: true, ...)");
        cbore = [thread.head_d + 1, thread.head_h + 0.4];
      } else if (cb instanceof Vec) cbore = [cb.x, cb.y];
      else if (cb !== undefined && cb !== false) a.ctx.error("hole(): cbore should be true or (diameter, depth)");
      let csink: number | undefined;
      const cs = a.value("csink");
      if (cs === true) {
        if (!thread) return a.ctx.error("hole(): csink: true needs a thread size");
        csink = thread.d * 2;
      } else if (typeof cs === "number") csink = cs;
      const at = a.vec3("at", [0, 0, 0]);
      const dir = a.dir("dir", [0, 0, -1]);
      if (tapped) {
        if (csink) a.ctx.error("hole(): a threaded hole has its own entry chamfer (lead:); leave out csink");
        const turns = threadTurnsError("hole()", depth, tapped.pitch);
        if (turns) a.ctx.error(turns);
        const lead = a.num("lead", 0.5 * tapped.pitch);
        if (lead < 0) a.ctx.error("hole(): lead must be 0 or more");
        return new ShapeV({ t: "hole", d, depth, at, dir, cbore, thread: tapped, lead, threadName: thread?.name, fit: "thread" });
      }
      if (a.has("lead")) a.ctx.error('hole(): lead: is the entry chamfer of a threaded hole (fit: "thread")');
      // the thread size and fit ride along for drawing callouts; they do not change the solid
      return new ShapeV({ t: "hole", d, depth, at, dir, cbore, csink, threadName: thread?.name, fit: thread ? a.str("fit", "clearance") : undefined });
    },
    'hole(d or M3, depth:, at:, dir: -Z, through: false, fit: "clearance"|"close"|"tap"|"insert"|"thread", cbore: true|(d, depth), csink: true|d, lead:) — a cutting tool: use with `cut`. `at` is the entry point on the surface, dir points into the material. fit: "thread" cuts a real ISO thread (detail builds; lead: is its entry chamfer, default half a pitch).',
  ),
  def(
    "gear",
    ["m", "z", "width", "bore", "at", "dir", "phase"],
    (a) =>
      new ShapeV({ t: "gear", m: a.positive("m"), z: Math.round(a.positive("z")), w: a.positive("width"), bore: a.num("bore", 0), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), phase: a.num("phase", 0), pa: 20, backlash: 0.05 }),
    "gear(m:, z:, width:, bore:, at:, dir:, phase:) — raw involute gear solid for custom parts. Prefer lib.spur_gear for gears that mesh.",
  ),
  def(
    "move",
    ["shape", "by"],
    (a) => {
      const by = a.vec3("by");
      const p = a.value("shape");
      if (p instanceof ProfileV) return new ProfileV({ t: "place2", p: p.recipe, rot: 0, by: [by[0], by[1]] });
      return new ShapeV({ t: "xform", shape: a.shape("shape").recipe, xf: [{ op: "translate", v: by }] });
    },
    "move(shape or profile, by: (dx, dy, dz))",
  ),
  def(
    "rotate",
    ["shape", "angle", "axis", "origin"],
    (a) => {
      const p = a.value("shape");
      if (p instanceof ProfileV) {
        if (a.has("axis")) a.ctx.error("rotate(): a profile turns in its own plane; leave out axis");
        const o = a.vec3("origin", [0, 0, 0]);
        const rot = a.num("angle");
        if (!o[0] && !o[1]) return new ProfileV({ t: "place2", p: p.recipe, rot, by: [0, 0] });
        const c = Math.cos((rot * Math.PI) / 180);
        const s = Math.sin((rot * Math.PI) / 180);
        // turn about o: rotate about (0, 0), then move o back to where the rotation put it
        return new ProfileV({ t: "place2", p: p.recipe, rot, by: [o[0] - (o[0] * c - o[1] * s), o[1] - (o[0] * s + o[1] * c)] });
      }
      return new ShapeV({ t: "xform", shape: a.shape("shape").recipe, xf: [{ op: "rotate", angle: a.num("angle"), axis: a.dir("axis", Z), origin: a.vec3("origin", [0, 0, 0]) }] });
    },
    "rotate(shape or profile, angle (deg), axis: Z, origin: (0, 0, 0)) — profiles turn in their own plane about origin (x, y).",
  ),
  def(
    "union",
    ["shapes"],
    (a) => {
      const v = a.value("shapes");
      const list = Array.isArray(v) ? v : [];
      const shapes = list.map((s, i) => (s instanceof ShapeV ? s.recipe : a.ctx.error(`union(): item ${i + 1} is not a shape`)));
      if (!shapes.length) a.ctx.error("union(): needs a list of shapes");
      return new ShapeV({ t: "union", shapes });
    },
    "union([shape, ...])",
  ),
  def(
    "beam",
    ["profile", "from", "to", "rotate"],
    (a) => {
      const text = a.str("profile");
      const series = /^\s*(?:v-?slot\s*)?(\d{4})\b/i.exec(text);
      if (series) a.ctx.error(`beam(): ${series[1]} is bought aluminium extrusion: use lib.extrusion("vslot_${series[1]}", length: ...) or a frame block`);
      const sec = parseSection(text, () => undefined);
      if (typeof sec === "string") return a.ctx.error(`beam(): ${sec}`);
      const from = a.vec3("from");
      const to = a.vec3("to");
      const L = vlen(vsub(to, from));
      if (L < 0.01) a.ctx.error("beam(): from and to are the same point");
      return new ShapeV({ t: "extrude", p: sectionProfile(sec), h: L, f: frameAt(from, vnorm(vsub(to, from)), a.num("rotate", 0)), twist: 0, scale: 1 });
    },
    'beam(profile, from:, to:, rotate: 0) — a straight length of stock section between two points on its centre line, cut square: "box 40x40x3" (width x height x wall), "tube 26.9x2.6" (outside diameter x wall), "angle 30x30x3", "flat 40x5", "bar 20x20" or "rod 12". rotate turns the section about its line. Members that meet belong in a frame block, which trims them to fit and makes a cut list.',
  ),
]);

/** Modifiers usable as statements inside a part: shell(), fillet(), chamfer(), draft() and the direct edits. */
export const MODIFIER_PARAMS: Record<string, string[]> = {
  shell: ["t", "open"],
  fillet: ["r", "edges"],
  chamfer: ["r", "edges"],
  draft: ["angle", "faces", "pull", "neutral"],
  push_pull: ["by", "faces"],
  replace_faces: ["faces", "with"],
  delete_faces: ["faces"],
  move_faces: ["faces", "by", "turn", "axis", "about", "copy"],
};
export const modifierDocs: Record<string, string> = {
  shell: "shell(t, open: Z) — hollow the body to wall thickness t, leaving open the outermost flat face looking along `open` (Z = open top). open also takes a face selection or a list, e.g. open: [Z, facing(-Y)].",
  fillet: 'fillet(r, edges: "all") — round edges of the body as it is at this step. edges: a preset ("all", "top", "bottom", "vertical", "horizontal", "convex", "concave", "sharp"), a named feature (boss.root, boss.tip, boss.edges), a selector (near(), in_plane(), along(), facing(), circles(), inside(), between()), or a list. Combine with + and -.',
  chamfer: 'chamfer(r, edges: "all") — bevel edges, picked the same way as fillet.',
  draft: 'draft(angle, faces: "vertical", pull: Z, neutral: (0, 0, 0)) — tilt faces by angle (degrees) so the part releases from a mould pulled along `pull`; faces stay put on the neutral plane through `neutral`. Draft before filleting.',
  push_pull:
    "push_pull(by, faces: …) — direct edit: move faces along their outward normals by `by` mm, out (adding material) when positive and in when negative. A flat face's neighbours stretch to follow, square, sloping or conical; a round face (a hole's or a boss's side) gets bigger or smaller. Works on the solid as it is at that step, imported bodies too; pick faces with near(), facing(), in_plane(), circles(), inside() or a feature name.",
  replace_faces: "replace_faces(faces: …, with: …) — direct edit: move flat faces into the plane of another flat face (`with`), flush with it or at its slope; the faces around them stretch to meet it.",
  delete_faces:
    "delete_faces(faces: …) — direct edit: take faces away and heal the solid: a hole, pocket, slot or letter is filled in, a boss or rib cut off, a round or chamfer made a sharp edge again (outside edges and inside corners, between flat and round faces). Pick the feature's sides; a floor or top bounded only by them comes too.",
  move_faces:
    "move_faces(faces: …, by: (x, y, z), turn: 0, axis: Z, about: …, copy: false) — direct edit: move a feature (a hole, pocket, slot or boss) by `by` and turn it `turn` degrees about `axis` through its middle (or the point `about`), healing where it was; copy: true leaves the original. A flat side moved along its normal is push_pull.",
};

const pt = (x: number, y: number, z = 0) => new Vec([x, y, z]);

export const MATH_FNS: Record<string, Fn> = Object.fromEntries([
  def("sqrt", ["x"], (a) => Math.sqrt(a.num("x")), "sqrt(x)"),
  def("abs", ["x"], (a) => Math.abs(a.num("x")), "abs(x)"),
  def("floor", ["x"], (a) => Math.floor(a.num("x")), "floor(x)"),
  def("ceil", ["x"], (a) => Math.ceil(a.num("x")), "ceil(x)"),
  def(
    "round",
    ["x", "step"],
    (a) => {
      const s = a.num("step", 1);
      return Math.round(a.num("x") / s) * s;
    },
    "round(x, step: 1)",
  ),
  def("sin", ["deg"], (a) => Math.sin(a.num("deg") * deg), "sin(degrees)"),
  def("cos", ["deg"], (a) => Math.cos(a.num("deg") * deg), "cos(degrees)"),
  def("tan", ["deg"], (a) => Math.tan(a.num("deg") * deg), "tan(degrees)"),
  def("asin", ["x"], (a) => Math.asin(a.num("x")) / deg, "asin(x) → degrees"),
  def("acos", ["x"], (a) => Math.acos(a.num("x")) / deg, "acos(x) → degrees"),
  def("atan", ["x"], (a) => Math.atan(a.num("x")) / deg, "atan(x) → degrees"),
  def("atan2", ["y", "x"], (a) => Math.atan2(a.num("y"), a.num("x")) / deg, "atan2(y, x) → degrees"),
  def("hypot", ["a", "b", "c"], (a) => Math.hypot(a.num("a"), a.num("b"), a.num("c", 0)), "hypot(a, b, c?)"),
  def(
    "clamp",
    ["x", "lo", "hi"],
    (a) => Math.min(a.num("hi"), Math.max(a.num("lo"), a.num("x"))),
    "clamp(x, lo, hi)",
  ),
  def(
    "min",
    ["a", "b", "c", "d"],
    (a) => {
      const first = a.value("a");
      const raw = Array.isArray(first) ? first : ["a", "b", "c", "d"].filter((k) => a.has(k)).map((k) => a.value(k)!);
      // a geometry measurement that is not ready yet makes the result not ready either
      const pending = raw.filter((v): v is Pending => v instanceof Pending);
      if (pending.length) return new Pending(pending.flatMap((v) => v.keys));
      const vals = raw.map((v) => num(v, a.ctx, "min()"));
      if (!vals.length) a.ctx.error("min() needs values");
      return Math.min(...vals);
    },
    "min(a, b, ...) or min(list)",
  ),
  def(
    "max",
    ["a", "b", "c", "d"],
    (a) => {
      const first = a.value("a");
      const raw = Array.isArray(first) ? first : ["a", "b", "c", "d"].filter((k) => a.has(k)).map((k) => a.value(k)!);
      // a geometry measurement that is not ready yet makes the result not ready either
      const pending = raw.filter((v): v is Pending => v instanceof Pending);
      if (pending.length) return new Pending(pending.flatMap((v) => v.keys));
      const vals = raw.map((v) => num(v, a.ctx, "max()"));
      if (!vals.length) a.ctx.error("max() needs values");
      return Math.max(...vals);
    },
    "max(a, b, ...) or max(list)",
  ),
  def(
    "len",
    ["x"],
    (a) => {
      const v = a.value("x");
      if (Array.isArray(v)) return v.length;
      if (v instanceof Vec) return Math.hypot(...v.v);
      if (typeof v === "string") return v.length;
      return a.ctx.error("len() takes a list, vector or text");
    },
    "len(list) → count, len(vector) → length",
  ),
  def(
    "sum",
    ["list"],
    (a) => listOf(a.value("list") ?? null, a.ctx, "sum()").reduce<number>((s, v) => s + num(v, a.ctx, "sum() item"), 0),
    "sum(list)",
  ),
  def(
    "range",
    ["a", "b", "step"],
    (a) => {
      let start = 0;
      let end = a.num("a");
      if (a.has("b")) {
        start = end;
        end = a.num("b");
      }
      const step = a.num("step", 1);
      if (step === 0) a.ctx.error("range(): step cannot be 0");
      const out: number[] = [];
      for (let i = start; step > 0 ? i < end - 1e-9 : i > end + 1e-9; i += step) {
        out.push(Math.round(i * 1e9) / 1e9);
        if (out.length > 2000) a.ctx.error("range() is limited to 2000 items");
      }
      return out;
    },
    "range(n) → 0..n-1, range(a, b, step: 1)",
  ),
  def(
    "linspace",
    ["a", "b", "n"],
    (a) => {
      const n = Math.round(a.num("n"));
      if (n < 1 || n > 2000) a.ctx.error("linspace(): n must be 1..2000");
      const s = a.num("a");
      const e = a.num("b");
      return Array.from({ length: n }, (_, i) => (n === 1 ? s : s + ((e - s) * i) / (n - 1)));
    },
    "linspace(a, b, n) — n evenly spaced values including both ends",
  ),
  def(
    "polar",
    ["n", "r", "start", "center", "z"],
    (a) => {
      const n = Math.round(a.num("n"));
      if (n < 1 || n > 500) a.ctx.error("polar(): n must be 1..500");
      const r = a.num("r");
      const s = a.num("start", 0);
      const c = a.vec3("center", [0, 0, 0]);
      const z = a.num("z", c[2]);
      return Array.from({ length: n }, (_, i) => {
        const ang = (s + (360 * i) / n) * deg;
        return pt(c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang), z);
      });
    },
    "polar(n, r, start: 0, center: (0,0,0)) → n points on a circle in the XY plane",
  ),
  def(
    "grid",
    ["nx", "ny", "px", "py", "center"],
    (a) => {
      const nx = Math.round(a.num("nx"));
      const ny = Math.round(a.num("ny"));
      if (nx * ny > 2000 || nx < 1 || ny < 1) a.ctx.error("grid(): between 1 and 2000 points");
      const px = a.num("px");
      const py = a.num("py", px);
      const c = a.vec3("center", [0, 0, 0]);
      const out: Vec[] = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push(pt(c[0] + (i - (nx - 1) / 2) * px, c[1] + (j - (ny - 1) / 2) * py, c[2]));
      return out;
    },
    "grid(nx, ny, px, py, center:) → points on a centred XY grid",
  ),
  def(
    "corners",
    ["w", "d", "z", "center"],
    (a) => {
      const w = a.num("w") / 2;
      const d = a.num("d") / 2;
      const c = a.vec3("center", [0, 0, 0]);
      const z = a.num("z", c[2]);
      return [pt(c[0] + w, c[1] + d, z), pt(c[0] - w, c[1] + d, z), pt(c[0] - w, c[1] - d, z), pt(c[0] + w, c[1] - d, z)];
    },
    "corners(w, d, z: 0, center:) → the 4 corners of a centred w×d rectangle",
  ),
  ...(["x", "y", "z"] as const).map((axis, k) =>
    def(
      `with_${axis}`,
      ["points", axis],
      (a) => {
        const v = a.value("points");
        const c = a.num(axis);
        const set = (p: Vec) => new Vec(k === 0 ? [c, p.y, p.z] : k === 1 ? [p.x, c, p.z] : [p.x, p.y, c]);
        if (v instanceof Vec) return set(v);
        if (!Array.isArray(v)) return a.ctx.error(`with_${axis}(): expects a point or a list of points`);
        return v.map((p, i) => (p instanceof Vec ? set(p) : a.ctx.error(`with_${axis}(): item ${i + 1} is not a point`)));
      },
      `with_${axis}(points, ${axis}) → the same points with their ${axis} set (works on one point or a list)`,
    ),
  ),
  def(
    "shift",
    ["points", "by"],
    (a) => {
      const v = a.value("points");
      const d = a.vec3("by");
      const mv = (p: Value, i: number) => (p instanceof Vec ? new Vec([p.x + d[0], p.y + d[1], p.z + d[2]]) : a.ctx.error(`shift(): item ${i + 1} is not a point`));
      if (v instanceof Vec) return mv(v, 0);
      if (!Array.isArray(v)) return a.ctx.error("shift(): expects a point or a list of points");
      return v.map(mv);
    },
    "shift(points, by: (dx, dy, dz)) → moved copies of a point or list of points",
  ),
  def("dot", ["a", "b"], (a) => { const p = a.vec3("a"); const q = a.vec3("b"); return p[0] * q[0] + p[1] * q[1] + p[2] * q[2]; }, "dot(a, b)"),
  def("cross", ["a", "b"], (a) => { const p = a.vec3("a"); const q = a.vec3("b"); return new Vec([p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]]); }, "cross(a, b)"),
  def("normalize", ["v"], (a) => new Vec(a.dir("v")), "normalize(v)"),
  def("center_distance", ["m", "z1", "z2"], (a) => centerDistance(a.num("m"), a.num("z1"), a.num("z2")), "center_distance(m, z1, z2) → m·(z1+z2)/2 for meshing spur gears"),
]);

export const GEO_FNS = ["min_distance", "volume", "mass", "bbox_min", "bbox_max", "size"];

export function geoFns(): Record<string, Fn> {
  const refName = (v: Value | undefined, a: Args, what: string): string => {
    if (v instanceof Ref) return v.name;
    if (v instanceof Obj && (v.kind === "component" || v.kind === "part") && typeof v.fields.name === "string") return v.fields.name;
    // one body of an imported file is measured on its own
    if (v instanceof Obj && v.kind === "body" && typeof v.fields.id === "string") return v.fields.id;
    return a.ctx.error(`${a.fname}(): ${what} should be a part or component name`);
  };
  const axisArg = (a: Args): "x" | "y" | "z" => {
    const s = a.str("axis").toLowerCase();
    if (s !== "x" && s !== "y" && s !== "z") a.ctx.error(`${a.fname}(): axis must be "x", "y" or "z"`);
    return s as "x" | "y" | "z";
  };
  return Object.fromEntries([
    def("min_distance", ["a", "b"], (a) => a.ctx.geo({ q: "min_distance", a: refName(a.value("a"), a, "a"), b: refName(a.value("b"), a, "b") }), "min_distance(a, b) → smallest gap between two parts in mm (0 when touching or overlapping). Only in require."),
    def("volume", ["a"], (a) => a.ctx.geo({ q: "volume", a: refName(a.value("a"), a, "a") }), "volume(part) → mm³. Only in require."),
    def("mass", ["a"], (a) => a.ctx.geo({ q: "mass", a: refName(a.value("a"), a, "a") }), "mass(part) → grams from its material. Only in require."),
    def("bbox_min", ["a", "axis"], (a) => a.ctx.geo({ q: "bbox", a: refName(a.value("a"), a, "a"), axis: axisArg(a), side: "min" }), 'bbox_min(part, "x") → lowest coordinate. Only in require.'),
    def("bbox_max", ["a", "axis"], (a) => a.ctx.geo({ q: "bbox", a: refName(a.value("a"), a, "a"), axis: axisArg(a), side: "max" }), 'bbox_max(part, "z") → highest coordinate. Only in require.'),
    def("size", ["a", "axis"], (a) => a.ctx.geo({ q: "bbox", a: refName(a.value("a"), a, "a"), axis: axisArg(a), side: "size" }), 'size(part, "x") → extent along an axis. Only in require.'),
  ]);
}

export function threadConstants(): Record<string, Obj> {
  return Object.fromEntries(
    Object.entries(THREADS).map(([key, t]) => [
      key,
      new Obj({ key, name: t.name, d: t.d, clearance: t.clearance, close: t.close, tap: t.tap, head_d: t.head_d, head_h: t.head_h, key_size: t.key, nut_af: t.nut_af, nut_h: t.nut_h, insert_d: t.insert_d, insert_l: t.insert_l, pitch: t.pitch, cbore_d: t.head_d + 1, cbore_h: t.head_h + 0.4 }, "thread", t.name),
    ]),
  );
}

/** lib.* namespace: each entry is a marker Fn the component statement recognises. */
export class LibFn extends Fn {
  constructor(public libKey: string) {
    super(`lib.${libKey}`, (_p, _n, ctx) => ctx.error(`lib.${libKey}() creates a component. Use it as: component name = lib.${libKey}(...) { at: ... }`), LIBRARY[libKey].doc);
  }
}

export function libNamespace(): Obj {
  return new Obj(Object.fromEntries(Object.keys(LIBRARY).map((k) => [k, new LibFn(k)])), "library", "lib");
}

export const CONSTANTS: Record<string, Value> = {
  PI: Math.PI,
  X: new Vec([1, 0, 0]),
  Y: new Vec([0, 1, 0]),
  Z: new Vec([0, 0, 1]),
  ORIGIN: new Vec([0, 0, 0]),
};

export function isPending(v: Value): v is Pending {
  return v instanceof Pending;
}

/** Recipes for the shapes a library component exposes (opening tools etc.). */
export function shapeValue(r: ShapeRecipe) {
  return new ShapeV(r);
}
