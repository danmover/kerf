// Modelling vocabulary for detailed parts: 2D profiles, 3D paths, extrude,
// sweep, loft and revolve of profiles, real threads, knurls, raised and cut
// text, ribs and gussets, ready-made features (screw bosses, snap hooks,
// O-ring grooves) and the edge and face selectors that fillets use.

import { Args, toV3 } from "./args";
import { def, SHAPE_FNS } from "./builtins";
import { SHEET_FNS } from "./sheet";
import { MOULD_FNS } from "./mould";
import { AERO_FNS } from "./aero";
import { BLOCK_FNS } from "./blocks";
import { FeatRef, FeatureV, Fn, Obj, PathV, ProfileV, Ref, SelV, ShapeV, Vec, typeName, type CallCtx, type FeatStep, type Value } from "./values";
import { MAX_TAPER, SEL_PRESETS, UNTIL_LIMIT, frameAt, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type Frame, type Profile, type ProfileSeg, type Sel, type SelPreset, type ShapeRecipe, type ThreadForm, type ThreadSpec3, type V2, type V3 } from "../kernel/recipe";
import { threadDepth, threadTurnsError } from "../kernel/threadMath";
import { THREADS, parseThreadName } from "../library/standards";
import { materialRecord } from "../library/materialDb";
import { snapFrame } from "../library/springs";

const Z: V3 = [0, 0, 1];
const prof = (p: Profile) => new ProfileV(p);
const r2 = (n: number) => Math.round(n * 100) / 100;

// Limits that keep one source value from tying up the geometry kernel for minutes.
const MAX_HELIX_TURNS = 200;
const MAX_TWIST = 3600;
const MAX_LOFT_SECTIONS = 50;
/** outlines and holes in a swept profile: each one is a sweep and a boolean */
const MAX_SWEEP_LOOPS = 8;

/** Outlines plus holes a profile draws (Infinity for text, whose glyphs are not counted). */
function profileLoops(p: Profile): number {
  switch (p.t) {
    case "text":
      return Infinity;
    case "offset":
    case "fillet2":
    case "place2":
      return profileLoops(p.p);
    case "union2":
      return p.ps.reduce((n, q) => n + profileLoops(q), 0);
    case "diff2":
      return p.b.reduce((n, q) => n + profileLoops(q), profileLoops(p.a));
    case "common2":
      return Math.max(profileLoops(p.a), profileLoops(p.b));
    default:
      return 1;
  }
}

function sweepable(a: Args, p: Profile): Profile {
  const n = profileLoops(p);
  if (n === Infinity) a.ctx.error("sweep(): text cannot be swept along a path; put lettering on with emboss() or engrave()");
  else if (n > MAX_SWEEP_LOOPS) a.ctx.error(`sweep(): the profile has ${n} outlines and holes; Kerf sweeps at most ${MAX_SWEEP_LOOPS}. Sweep the outline and cut or add the rest as separate steps`);
  return p;
}

function at2(a: Args, name = "at"): V2 {
  const v = a.vec3(name, [0, 0, 0]);
  return [v[0], v[1]];
}

function pt2(v: Value, ctx: CallCtx, what: string): V2 {
  if (v instanceof Vec && v.v.length >= 2) return [v.x, v.y];
  return ctx.error(`${what} should be a point like (x, y), got ${typeName(v)}`);
}

// ---------- 2D profiles ----------

/** Rough 2D bounds of a profile; null when unknown (text). */
export function profileBounds(p: Profile): [V2, V2] | null {
  // a loop, not Math.min(...pts): spreading a very large polygon overflows the stack
  const fromPts = (pts: V2[]): [V2, V2] => {
    const lo: V2 = [Infinity, Infinity];
    const hi: V2 = [-Infinity, -Infinity];
    for (const q of pts) {
      if (q[0] < lo[0]) lo[0] = q[0];
      if (q[1] < lo[1]) lo[1] = q[1];
      if (q[0] > hi[0]) hi[0] = q[0];
      if (q[1] > hi[1]) hi[1] = q[1];
    }
    return [lo, hi];
  };
  switch (p.t) {
    case "circle":
      return fromPts([
        [p.c[0] - p.d / 2, p.c[1] - p.d / 2],
        [p.c[0] + p.d / 2, p.c[1] + p.d / 2],
      ]);
    case "ellipse":
    case "rect":
      return fromPts([
        [p.c[0] - p.w / 2, p.c[1] - p.h / 2],
        [p.c[0] + p.w / 2, p.c[1] + p.h / 2],
      ]);
    case "poly":
      return fromPts(p.pts);
    case "text":
      return null;
    case "path2":
      return fromPts([p.start, ...p.segs.flatMap((s) => (s.s === "arc" ? [s.via, s.to] : s.s === "bezier" ? [s.c1, s.c2, s.to] : [s.to]))]);
    case "offset": {
      const b = profileBounds(p.p);
      const d = Math.max(0, p.d);
      return b && fromPts([
        [b[0][0] - d, b[0][1] - d],
        [b[1][0] + d, b[1][1] + d],
      ]);
    }
    case "fillet2":
      return profileBounds(p.p);
    case "union2": {
      const bs = p.ps.map(profileBounds);
      if (bs.some((b) => !b)) return null;
      return fromPts(bs.flatMap((b) => b!));
    }
    case "diff2":
    case "common2":
      return profileBounds(p.a);
    case "place2": {
      const b = profileBounds(p.p);
      if (!b) return null;
      const c = Math.cos((p.rot * Math.PI) / 180);
      const s = Math.sin((p.rot * Math.PI) / 180);
      const corners: V2[] = [b[0], [b[1][0], b[0][1]], b[1], [b[0][0], b[1][1]]];
      return fromPts(corners.map(([x, y]) => [x * c - y * s + p.by[0], x * s + y * c + p.by[1]]));
    }
  }
}

/** Cubic Bézier segments of a Catmull-Rom curve through pts (closed: back to the first point). */
function catmullRom(pts: V2[], closed: boolean, before?: V2, after?: V2): ProfileSeg[] {
  const n = pts.length;
  const at = (i: number): V2 => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return before ?? pts[0];
    if (i >= n) return after ?? pts[n - 1];
    return pts[i];
  };
  const segs: ProfileSeg[] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    segs.push({
      s: "bezier",
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      to: p2,
    });
  }
  return segs;
}

export const PROFILE_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "circle",
    ["d", "at", "r"],
    (a) => prof({ t: "circle", d: a.has("r") ? a.positive("r") * 2 : a.positive("d"), c: at2(a) }),
    "circle(d, at: (0, 0)) — 2D circle profile (or r:). Profiles are flat outlines for extrude, revolve, sweep, loft, emboss and engrave.",
  ),
  def("ellipse", ["w", "h", "at"], (a) => prof({ t: "ellipse", w: a.positive("w"), h: a.positive("h"), c: at2(a) }), "ellipse(w, h, at: (0, 0)) — 2D ellipse profile."),
  def(
    "rect",
    ["w", "h", "r", "at"],
    (a) => {
      const w = a.positive("w");
      const h = a.positive("h");
      const r = a.num("r", 0);
      if (r < 0 || r > Math.min(w, h) / 2 + 1e-9) a.ctx.error(`rect(): corner radius r=${r} must be between 0 and half the smaller side (${Math.min(w, h) / 2})`);
      return prof({ t: "rect", w, h, r, c: at2(a) });
    },
    "rect(w, h, r: 0, at: (0, 0)) — rectangle profile centred on `at`; r rounds the corners (r = h/2 makes an obround slot).",
  ),
  def(
    "polygon",
    ["points", "r"],
    (a) => {
      const pts = a.points2("points");
      if (pts.length < 3) a.ctx.error("polygon(): needs at least 3 points");
      const r = a.num("r", 0);
      if (r < 0) a.ctx.error("polygon(): r must be 0 or more");
      return prof({ t: "poly", pts, r });
    },
    "polygon(points: [(x, y), ...], r: 0) — closed outline through the points; r rounds every corner.",
  ),
  def(
    "ngon",
    ["n", "d", "af", "at", "rot"],
    (a) => {
      const n = Math.round(a.num("n"));
      if (n < 3 || n > 64) a.ctx.error("ngon(): n must be 3..64");
      const d = a.has("af") ? a.positive("af") / Math.cos(Math.PI / n) : a.positive("d");
      const c = at2(a);
      const rot = a.num("rot", 0);
      const pts: V2[] = Array.from({ length: n }, (_, i) => {
        const t = ((rot + (360 * i) / n) * Math.PI) / 180;
        return [c[0] + (d / 2) * Math.cos(t), c[1] + (d / 2) * Math.sin(t)];
      });
      return prof({ t: "poly", pts, r: 0 });
    },
    "ngon(n, d, af:, at: (0, 0), rot: 0) — regular polygon with corner diameter d, or across-flats af (a hex nut pocket is ngon(6, af: 5.5 + 0.3)).",
  ),
  def(
    "ring",
    ["od", "id", "at"],
    (a) => {
      const od = a.positive("od");
      const id = a.positive("id");
      if (id >= od) a.ctx.error(`ring(): id (${id}) must be smaller than od (${od})`);
      const c = at2(a);
      return prof({ t: "diff2", a: { t: "circle", d: od, c }, b: [{ t: "circle", d: id, c }] });
    },
    "ring(od, id, at: (0, 0)) — annulus profile.",
  ),
  def(
    "outline",
    ["items"],
    (a) => {
      const items = a.value("items");
      if (!Array.isArray(items) || items.length < 3) return a.ctx.error("outline(): needs a list of at least 3 items: a start point, then points (straight lines), arc_to(...) and spline_to(...)");
      const first = items[0];
      if (!(first instanceof Vec)) return a.ctx.error("outline(): the first item must be the start point (x, y)");
      const start = pt2(first, a.ctx, "outline() start");
      type Step = { k: "line" | "spline"; to: V2 } | { k: "arc"; to: V2; via: V2 };
      const steps: Step[] = items.slice(1).map((it, i) => {
        if (it instanceof Vec) return { k: "line", to: pt2(it, a.ctx, `outline() item ${i + 2}`) };
        if (it instanceof Obj && it.kind === "arc_to") return { k: "arc", to: pt2(it.fields.to, a.ctx, "arc_to()"), via: pt2(it.fields.via, a.ctx, "arc_to() via") };
        if (it instanceof Obj && it.kind === "spline_to") return { k: "spline", to: pt2(it.fields.to, a.ctx, "spline_to()") };
        return a.ctx.error(`outline(): item ${i + 2} is ${typeName(it)}; use a point (x, y), arc_to((x, y), via: (x, y)) or spline_to((x, y))`);
      });
      const segs: ProfileSeg[] = [];
      let prev = start;
      let beforePrev: V2 | undefined;
      for (let i = 0; i < steps.length; ) {
        const s = steps[i];
        if (s.k === "line") {
          segs.push({ s: "line", to: s.to });
        } else if (s.k === "arc") {
          segs.push({ s: "arc", via: s.via, to: s.to });
        } else {
          // a run of spline_to points becomes one smooth curve
          const run: V2[] = [prev];
          while (i < steps.length && steps[i].k === "spline") run.push(steps[i++].to);
          const after = i < steps.length ? steps[i].to : start;
          segs.push(...catmullRom(run, false, beforePrev, after));
          beforePrev = run[run.length - 2];
          prev = run[run.length - 1];
          continue;
        }
        beforePrev = prev;
        prev = s.to;
        i++;
      }
      return prof({ t: "path2", start, segs });
    },
    "outline([start, (x, y), arc_to((x, y), via: (x, y)), spline_to((x, y)), ...]) — closed outline: plain points are straight lines, arc_to bends through `via`, consecutive spline_to points make one smooth curve. It closes back to the start with a straight line.",
  ),
  def("arc_to", ["to", "via"], (a) => new Obj({ to: new Vec(a.vec3("to")), via: new Vec(a.vec3("via")) }, "arc_to", "arc_to"), "arc_to((x, y), via: (x, y)) — an arc through `via` inside outline()."),
  def("spline_to", ["to"], (a) => new Obj({ to: new Vec(a.vec3("to")) }, "spline_to", "spline_to"), "spline_to((x, y)) — a smooth curve point inside outline()."),
  def(
    "curve",
    ["points"],
    (a) => {
      const pts = a.points2("points");
      if (pts.length < 3) a.ctx.error("curve(): needs at least 3 points");
      return prof({ t: "path2", start: pts[0], segs: catmullRom(pts, true) });
    },
    "curve(points: [(x, y), ...]) — smooth closed curve through every point (organic shapes, handles, cams).",
  ),
  def(
    "text",
    ["text", "size", "font", "align", "at"],
    (a) => {
      const text = a.str("text");
      if (!text.trim()) a.ctx.error("text(): the text is empty");
      if (text.length > 200) a.ctx.error("text(): at most 200 characters");
      return prof({ t: "text", text, size: a.positive("size", 5), font: a.oneOf("font", ["sans", "mono"] as const, "sans"), align: a.oneOf("align", ["left", "center", "right"] as const, "center"), c: at2(a) });
    },
    'text("LABEL", size: 5, font: "sans"|"mono", align: "center"|"left"|"right", at: (0, 0)) — letters as a profile; size is the cap height of the em box in mm. Use with emboss() or engrave().',
  ),
  def(
    "offset",
    ["profile", "d"],
    (a) => {
      const d = a.num("d");
      if (Math.abs(d) < 1e-6) a.ctx.error("offset(): d must not be 0");
      return prof({ t: "offset", p: a.profile("profile"), d });
    },
    "offset(profile, d) — grows the outline by d (shrinks when negative), rounding outside corners. Good for walls: offset(p, 2) - p.",
  ),
  def("rounded", ["profile", "r"], (a) => prof({ t: "fillet2", p: a.profile("profile"), r: a.positive("r") }), "rounded(profile, r) — rounds every corner of a profile."),
  def("overlap", ["a", "b"], (a) => prof({ t: "common2", a: a.profile("a"), b: a.profile("b") }), "overlap(a, b) — the area two profiles share. Combine profiles with + (union) and - (cut)."),
]);

// ---------- 3D paths ----------

export const PATH_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "path",
    ["points", "r"],
    (a) => {
      const pts = a.points3("points");
      if (pts.length < 2) a.ctx.error("path(): needs at least 2 points");
      const r = a.num("r", 0);
      if (r < 0) a.ctx.error("path(): r must be 0 or more");
      return new PathV({ t: "poly", pts, r });
    },
    "path(points: [(x, y, z), ...], r: 0) — straight runs through 3D points, with every bend rounded to radius r (tubes, wires, handles).",
  ),
  def(
    "spline_path",
    ["points"],
    (a) => {
      const pts = a.points3("points");
      if (pts.length < 2) a.ctx.error("spline_path(): needs at least 2 points");
      return new PathV({ t: "spline", pts });
    },
    "spline_path(points: [(x, y, z), ...]) — a smooth 3D curve through the points.",
  ),
  def(
    "helix",
    ["d", "pitch", "h", "at", "dir", "left"],
    (a) => {
      const pitch = a.positive("pitch");
      const h = a.positive("h");
      if (h / pitch > MAX_HELIX_TURNS) a.ctx.error(`helix(): ${Math.round(h / pitch)} turns is more than the ${MAX_HELIX_TURNS} Kerf sweeps; use a coarser pitch or a shorter helix`);
      return new PathV({ t: "helix", d: a.positive("d"), pitch, h, at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), left: a.bool("left") });
    },
    "helix(d, pitch, h, at:, dir: Z, left: false) — a helix of diameter d (springs, coils, spiral ramps).",
  ),
  def(
    "arc_path",
    ["a", "via", "b"],
    (a) => {
      const p = a.vec3("a");
      const m = a.vec3("via");
      const q = a.vec3("b");
      if (vlen(vcross(vsub(m, p), vsub(q, p))) < 1e-6) a.ctx.error("arc_path(): the three points are in a line");
      return new PathV({ t: "arc3", a: p, b: m, c: q });
    },
    "arc_path(a, via, b) — a circular arc from a through via to b.",
  ),
]);

// ---------- threads ----------

const FORMS = ["iso", "trapezoid", "square", "buttress"] as const;

function threadSpec(a: Args): { spec: ThreadSpec3; name: string } {
  const v = a.value("size");
  let d: number | undefined;
  let pitch: number | undefined;
  let name = "";
  if (v instanceof Obj && v.kind === "thread") {
    d = Number(v.fields.d);
    pitch = Number(v.fields.pitch);
    name = String(v.fields.name);
  } else if (typeof v === "string") {
    const t = parseThreadName(v);
    if (!t) return a.ctx.error(`${a.fname}(): "${v}" is not a thread size I know. Use M8, M8x1, 1/4-20, #10-24, or d: with pitch:`);
    d = t.d;
    pitch = t.pitch;
    name = t.name;
  } else if (typeof v === "number") d = v;
  else if (v === undefined && a.has("d")) d = a.positive("d");
  else if (v !== undefined) return a.ctx.error(`${a.fname}(): size should be a thread like M8 or "M8x1", or a diameter, got ${typeName(v)}`);
  if (d === undefined) return a.ctx.error(`${a.fname}(): give a size like M8, or d: with pitch:`);
  if (!(d > 0)) return a.ctx.error(`${a.fname}(): the diameter must be greater than 0`);
  if (a.has("pitch")) pitch = a.positive("pitch");
  if (!pitch) return a.ctx.error(`${a.fname}(): give pitch: for a ${r2(d)} mm thread`);
  const form = a.oneOf("form", FORMS, "iso") as ThreadForm;
  const starts = Math.round(a.num("starts", 1));
  if (starts < 1 || starts > 8) a.ctx.error(`${a.fname}(): starts must be 1..8`);
  const clearance = a.num("clearance", 0.1);
  if (clearance < 0 || clearance > pitch * 0.25) a.ctx.error(`${a.fname}(): clearance must be between 0 and ${r2(pitch * 0.25)} mm (a quarter of the pitch)`);
  if (2 * threadDepth(form, pitch) > d * 0.8) a.ctx.error(`${a.fname}(): a ${pitch} mm pitch is too coarse for a ${r2(d)} mm diameter`);
  return { spec: { d, pitch, form, starts, left: a.bool("left"), clearance }, name: name || `${r2(d)} × ${pitch}` };
}

/** Internal thread spec for hole(M4, fit: "thread"). */
export function holeThread(t: { d: number; pitch: number }, clearance = 0.1): ThreadSpec3 {
  return { d: t.d, pitch: t.pitch, form: "iso", starts: 1, left: false, clearance };
}

// ---------- shapes from profiles and paths ----------

/** Frame for a profile drawn on a face at `at` that faces `facing` (text reads correctly from outside). */
function faceFrame(at: V3, facing: V3, rot: number): Frame {
  return frameAt(at, facing, rot);
}

function shiftFrame(f: Frame, d: number): Frame {
  return { ...f, o: vadd(f.o, vscale(f.n, d)) };
}

export const THIN_SIDES = ["inside", "outside", "center"] as const;
export type ThinSide = (typeof THIN_SIDES)[number];

/** Only the wall of a profile, t thick along its outline (and its holes): inside it (the outer size stays), outside it, or centred on it. */
export function thinProfile(p: Profile, t: number, side: ThinSide): Profile {
  if (side === "inside") return { t: "diff2", a: p, b: [{ t: "offset", p, d: -t }] };
  if (side === "outside") return { t: "diff2", a: { t: "offset", p, d: t }, b: [p] };
  return { t: "diff2", a: { t: "offset", p, d: t / 2 }, b: [{ t: "offset", p, d: -t / 2 }] };
}

/** taper, thin and until, shared by extrude() of a profile and of a sketch. */
export function extrudeOptions(a: Args, p: Profile): { p: Profile; taper: number; until?: "next" } {
  const fname = a.fname;
  const until = a.has("until") ? a.oneOf("until", ["next"] as const, "next") : undefined;
  if (until && a.has("h")) a.ctx.error(`${fname}(): give a depth or until: "next", not both`);
  const taper = a.num("taper", 0);
  if (!(Math.abs(taper) < MAX_TAPER)) a.ctx.error(`${fname}(): taper must be between -${MAX_TAPER} and ${MAX_TAPER} degrees (got ${taper})`);
  let out = p;
  if (a.has("thin")) out = thinProfile(p, a.positive("thin"), a.oneOf("thin_side", THIN_SIDES, "inside"));
  else if (a.has("thin_side")) a.ctx.error(`${fname}(): thin_side goes with thin: (the wall thickness)`);
  return { p: out, taper, ...(until ? { until } : {}) };
}

/**
 * The recipe for a profile pushed from `span[0]` to `span[1]` along the frame's normal (either may be negative).
 * A taper leans the sides in from where the extrusion starts, the end nearer the frame's plane; a span across the
 * plane tapers both ways from it, as two halves.
 */
export function extrudeRecipe(p: Profile, f: Frame, span: [number, number], o: { twist?: number; scale?: number; taper?: number; until?: "next" } = {}): ShapeRecipe {
  const twist = o.twist ?? 0;
  const scale = o.scale ?? 1;
  const extra = { ...(o.taper ? { taper: o.taper } : {}), ...(o.until ? { until: o.until } : {}) };
  const [a, b] = span;
  if (!o.taper || o.until) return { t: "extrude", p, h: b - a, f: a ? shiftFrame(f, a) : f, twist, scale, ...extra };
  if (a < 0 && b > 0) return { t: "union", shapes: [extrudeRecipe(p, f, [0, b], o), extrudeRecipe(p, f, [0, a], o)] };
  // a taper measured from the frame's plane: start there, or from the end nearer it when the span is off the plane
  const near = Math.abs(a) <= Math.abs(b) ? a : b;
  const far = near === a ? b : a;
  return { t: "extrude", p, h: far - near, f: near ? shiftFrame(f, near) : f, twist, scale, ...extra };
}

const pointRevolve = SHAPE_FNS.revolve;

export const SOLID_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "extrude",
    ["profile", "h", "at", "dir", "rot", "twist", "scale", "symmetric", "taper", "thin", "thin_side", "until"],
    (a) => {
      const o = extrudeOptions(a, a.profile("profile"));
      const symmetric = a.bool("symmetric");
      if (o.until && symmetric) a.ctx.error('extrude(): until: "next" runs one way from where it starts; leave out symmetric');
      const h = o.until ? UNTIL_LIMIT : a.positive("h");
      const dir = a.dir("dir", Z);
      const f = frameAt(a.vec3("at", [0, 0, 0]), dir, a.num("rot", 0));
      const scale = a.num("scale", 1);
      if (!(scale > 0)) a.ctx.error("extrude(): scale must be greater than 0");
      const twist = a.num("twist", 0);
      if (Math.abs(twist) > MAX_TWIST) a.ctx.error(`extrude(): twist ${twist}° is more than ${MAX_TWIST / 360} full turns; for a coil, sweep() a profile along a helix()`);
      if (o.taper && (twist || scale !== 1)) a.ctx.error("extrude(): taper can't be combined with twist or scale");
      return new ShapeV(extrudeRecipe(o.p, f, symmetric ? [-h / 2, h / 2] : [0, h], { twist, scale, taper: o.taper, until: o.until }));
    },
    'extrude(profile, h, at: (0, 0, 0), dir: Z, rot: 0, twist: 0, scale: 1, symmetric: false, taper: 0, thin: 0, thin_side: "inside", until: "next") — pushes a profile h along dir. The profile\'s (x, y) map to X, Y for dir Z; for a horizontal dir, y is up. twist turns it (degrees over h); scale shrinks the far end (nozzles). taper leans the sides in by that many degrees from the start (out when negative; holes open up): mould and casting draft, tapered bosses and pins; with symmetric it tapers both ways from the middle. thin: t makes only a wall t thick along the outline (an open box or tube from a rectangle or circle), inside it ("inside", the outer size stays), "outside" or "center". until: "next" (in place of h) runs it until it meets the part it is added to (a boss up to a curved wall) or, cut, through the first wall it meets.',
  ),
  [
    "revolve",
    new Fn(
      "revolve",
      (pos, named, ctx) => {
        const first = pos[0] ?? named.profile;
        if (!(first instanceof ProfileV)) return pointRevolve.call(pos, named, ctx);
        const a = new Args("revolve", pos, named, ctx, ["profile", "at", "axis", "angle", "rot", "dir"]);
        const p = a.profile("profile");
        const axis = a.has("dir") ? a.dir("dir") : a.dir("axis", Z);
        const b = profileBounds(p);
        if (b && b[0][0] < -1e-6) ctx.error(`revolve(): the profile reaches x = ${r2(b[0][0])}. x is the distance from the axis, so keep every x at 0 or more.`);
        const angle = a.num("angle", 360);
        if (!(angle > 0 && angle <= 360)) ctx.error(`revolve(): angle must be between 0 and 360 degrees (got ${angle})`);
        return new ShapeV({ t: "revolve2", p, f: frameAt(a.vec3("at", [0, 0, 0]), axis, a.num("rot", 0)), angle });
      },
      `${pointRevolve.doc ?? ""} Or revolve(profile, at:, axis: Z, angle: 360, rot: 0) — spins a 2D profile whose x is the radius and y the height along the axis (bottles, knobs, pulleys).`,
    ),
  ],
  def(
    "sweep",
    ["profile", "path", "rot"],
    (a) => new ShapeV({ t: "sweep", p: sweepable(a, a.profile("profile")), path: a.path("path"), rot: a.num("rot", 0), frenet: false }),
    "sweep(profile, path, rot: 0) — moves a profile along a 3D path, kept square to it. The profile's (0, 0) rides on the path. Handles, hoses, cable guides, springs (with helix).",
  ),
  def(
    "pipe",
    ["path", "d", "id"],
    (a) => {
      const d = a.positive("d");
      const id = a.num("id", 0);
      if (id < 0 || id >= d) a.ctx.error(`pipe(): id must be between 0 and d (${d})`);
      const p: Profile = id > 0 ? { t: "diff2", a: { t: "circle", d, c: [0, 0] }, b: [{ t: "circle", d: id, c: [0, 0] }] } : { t: "circle", d, c: [0, 0] };
      return new ShapeV({ t: "sweep", p, path: a.path("path"), rot: 0, frenet: false });
    },
    "pipe(path, d, id: 0) — round bar or tube along a path (id > 0 makes it hollow).",
  ),
  def(
    "section",
    ["profile", "at", "dir", "rot"],
    (a) => new Obj({ profile: new ProfileV(a.profile("profile")), at: new Vec(a.vec3("at", [0, 0, 0])), dir: new Vec(a.dir("dir", Z)), rot: a.num("rot", 0) }, "section", "section"),
    "section(profile, at:, dir: Z, rot: 0) — a placed profile for loft().",
  ),
  def(
    "loft",
    ["sections", "heights", "at", "dir", "ruled", "wall", "open"],
    (a) => {
      const list = a.value("sections");
      if (!Array.isArray(list) || list.length < 2) return a.ctx.error("loft(): needs a list of at least 2 profiles or section(...)s");
      if (list.length > MAX_LOFT_SECTIONS) a.ctx.error(`loft(): ${list.length} sections is more than the ${MAX_LOFT_SECTIONS} Kerf lofts through; a few well-placed sections give the same smooth skin`);
      const dir = a.dir("dir", Z);
      const base = a.vec3("at", [0, 0, 0]);
      const hsV = a.value("heights");
      const hs: number[] | null = Array.isArray(hsV) ? hsV.map((h, i) => (typeof h === "number" ? h : a.ctx.error(`loft(): heights[${i}] should be a number`))) : null;
      const secs = list.map((s, i) => {
        if (s instanceof Obj && s.kind === "section") {
          const p = (s.fields.profile as ProfileV).recipe;
          return { p, f: frameAt(toV3(s.fields.at, a.ctx, "section at"), vnorm(toV3(s.fields.dir, a.ctx, "section dir")), Number(s.fields.rot) || 0) };
        }
        if (s instanceof ProfileV) {
          if (!hs || hs.length !== list.length) return a.ctx.error("loft(): plain profiles need heights: [h1, h2, ...], one per profile, measured along dir from at");
          return { p: s.recipe, f: frameAt(vadd(base, vscale(dir, hs[i])), dir) };
        }
        return a.ctx.error(`loft(): item ${i + 1} is ${typeName(s)}; use a profile (with heights:) or section(profile, at:, dir:)`);
      });
      for (let i = 1; i < secs.length; i++) {
        if (vlen(vsub(secs[i].f.o, secs[i - 1].f.o)) < 1e-6) a.ctx.error(`loft(): sections ${i} and ${i + 1} are at the same place`);
      }
      const ruled = a.bool("ruled");
      const outer: ShapeRecipe = { t: "loft", secs, ruled };
      if (!a.has("wall")) {
        if (a.has("open")) a.ctx.error("loft(): open: goes with wall:");
        return new ShapeV(outer);
      }
      // a hollow loft: the same sections shrunk by the wall, cut out of the solid one
      const wall = a.positive("wall");
      if (!hs || list.some((s) => !(s instanceof ProfileV))) return a.ctx.error("loft(): wall: needs plain profiles with heights:");
      for (let i = 1; i < hs.length; i++) if (hs[i] <= hs[i - 1]) a.ctx.error("loft(): with wall:, heights must increase");
      const open = a.oneOf("open", ["end", "start", "both", "none"] as const, "end");
      const openStart = open === "start" || open === "both";
      const openEnd = open === "end" || open === "both";
      const ih = [...hs];
      if (!openStart) ih[0] += wall;
      if (!openEnd) ih[ih.length - 1] -= wall;
      if (ih[ih.length - 1] - ih[0] < wall) a.ctx.error("loft(): the loft is too short for this wall");
      const innerP = secs.map((s): Profile => ({ t: "offset", p: s.p, d: -wall }));
      const at = (h: number) => frameAt(vadd(base, vscale(dir, h)), dir);
      const innerSecs = innerP.map((p, i) => ({ p, f: at(Math.min(Math.max(ih[i], ih[0]), ih[ih.length - 1])) }));
      // open ends: the inner skin ends flush with the outer one, so the cut opens that end
      const cuts: ShapeRecipe[] = [{ t: "loft", secs: innerSecs, ruled }];
      return new ShapeV({ t: "diff", a: outer, b: cuts });
    },
    'loft([p1, p2, p3], heights: [0, 30, 60], at:, dir: Z, ruled: false, wall:, open: "end"|"start"|"both"|"none") — a smooth skin through profiles stacked along dir (bottles, nozzles, ducts, square-to-round transitions). wall: t makes it hollow with that wall (measured across each section), open at the far end by default; prefer it to shell() for lofts. For tilted sections pass section(profile, at:, dir:) items instead.',
  ),
  def(
    "thread",
    ["size", "length", "at", "dir", "pitch", "form", "starts", "left", "clearance", "internal", "lead", "d", "bore"],
    (a) => {
      const { spec } = threadSpec(a);
      const length = a.positive("length");
      const turns = threadTurnsError("thread()", length, spec.pitch);
      if (turns) a.ctx.error(turns);
      const internal = a.bool("internal");
      const lead = internal ? a.num("lead", 0.5 * spec.pitch) : 0;
      if (lead < 0) a.ctx.error("thread(): lead must be 0 or more");
      const r: ShapeRecipe = { t: "thread", spec, length, at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), internal, lead };
      if (a.has("bore")) {
        if (internal) a.ctx.error("thread(): bore: hollows an external thread; an internal thread is already a hole");
        const bore = a.positive("bore");
        const root = spec.d - 2 * threadDepth(spec.form, spec.pitch) - 2 * spec.clearance;
        if (bore > root - 0.8) a.ctx.error(`thread(): bore ${bore} leaves under 0.4 mm of wall under a ${r2(root)} mm thread root`);
        r.bore = bore;
      }
      return new ShapeV(r);
    },
    'thread(M8, length, at:, dir: Z, pitch:, form: "iso"|"trapezoid"|"square"|"buttress", starts: 1, left: false, clearance: 0.1, internal: false, bore:) — a real helical thread. External: a threaded rod from at along dir (add it); bore: d makes it a threaded tube (bottle necks). internal: true makes the tool for a threaded hole (cut it). Sizes: M8, "M8x1", "1/4-20", or d: 40, pitch: 4 for jar lids. clearance is the radial play per side (0 for machined parts). Detail builds show the real form; fast builds a plain cylinder.',
  ),
  def(
    "knurl",
    ["d", "h", "at", "dir", "count", "depth", "style"],
    (a) => {
      const d = a.positive("d");
      const depth = a.positive("depth", 0.5);
      if (depth > d / 4) a.ctx.error(`knurl(): depth must be at most a quarter of d (${r2(d / 4)})`);
      const count = Math.round(a.num("count", Math.max(8, Math.round((Math.PI * d) / 1.6))));
      if (count < 3 || count > 360) a.ctx.error("knurl(): count must be 3..360");
      return new ShapeV({ t: "knurl", d, h: a.positive("h"), at: a.vec3("at", [0, 0, 0]), dir: a.dir("dir", Z), count, depth, style: a.oneOf("style", ["straight", "fluted"] as const, "straight") });
    },
    'knurl(d, h, at:, dir: Z, count:, depth: 0.5, style: "straight"|"fluted") — a ridged grip cylinder (caps, knobs, thumb wheels). straight: sharp V ridges; fluted: rounded scallops. Add it in place of a plain cylinder.',
  ),
  def(
    "emboss",
    ["profile", "at", "facing", "h", "rot"],
    (a) => {
      const h = a.positive("h", 0.6);
      const f = shiftFrame(faceFrame(a.vec3("at", [0, 0, 0]), a.dir("facing", Z), a.num("rot", 0)), -0.05);
      return new ShapeV({ t: "extrude", p: a.profile("profile"), h: h + 0.05, f, twist: 0, scale: 1 });
    },
    "emboss(profile, at:, facing: Z, h: 0.6, rot: 0) — raised lettering or a logo standing h out of a flat face. `at` is the centre on the face and `facing` the way the face looks; it reads correctly from outside. Use with add.",
  ),
  def(
    "engrave",
    ["profile", "at", "facing", "depth", "rot"],
    (a) => {
      const depth = a.positive("depth", 0.6);
      const f = shiftFrame(faceFrame(a.vec3("at", [0, 0, 0]), a.dir("facing", Z), a.num("rot", 0)), -depth);
      return new ShapeV({ t: "extrude", p: a.profile("profile"), h: depth + 0.05, f, twist: 0, scale: 1 });
    },
    "engrave(profile, at:, facing: Z, depth: 0.6, rot: 0) — the tool for lettering cut depth into a flat face (same placement as emboss). Use with cut.",
  ),
  def(
    "mirror",
    ["shape", "normal", "at"],
    (a) => new ShapeV({ t: "xform", shape: a.shape("shape").recipe, xf: [{ op: "mirror", origin: a.vec3("at", [0, 0, 0]), normal: a.dir("normal", [1, 0, 0]) }] }),
    "mirror(shape, normal: X, at: (0, 0, 0)) — mirrored copy across the plane through `at` square to normal. Add both for symmetric features: add [s, mirror(s, X)].",
  ),
  def(
    "shape_of",
    ["part"],
    (a) => {
      const v = a.value("part");
      // a part is a reference by name; a component is its value, labelled with its name (an instance as name[i])
      const name = v instanceof Ref ? v.name : v instanceof Obj && v.kind === "component" && v.label ? v.label.replace(/\[\d+\]$/, "") : null;
      if (!name) return a.ctx.error(`shape_of(): give the name of a part or component defined above, got ${v === undefined ? "nothing" : typeName(v)}`);
      const solids = a.ctx.partShapes?.(name);
      if (!solids?.length) return a.ctx.error(`shape_of(): "${name}" must be a part or component defined above this one`);
      const shapes: ShapeRecipe[] = solids.map((p) => ({ t: "part", part: p.recipe, xf: p.xf }));
      return new ShapeV(shapes.length === 1 ? shapes[0] : { t: "union", shapes });
    },
    "shape_of(part) — the solid of a part or component defined above, exactly where it sits in the assembly (inside a part, that part's own at: and rotate: are taken off, so it lands where the other part really is). Linked: it follows every change to that part. cut shape_of(magnet) pockets a part round another; body mirror(shape_of(left_arm), normal: X) makes the other hand of a part. A part whose body is shape_of() stays where its source is; move the source instead.",
  ),
  def(
    "rib",
    ["from", "to", "t", "h", "up"],
    (a) => {
      const p = a.vec3("from");
      const q = a.vec3("to");
      const L = vlen(vsub(q, p));
      if (L < 1e-6) a.ctx.error("rib(): from and to are the same point");
      const u = vnorm(vsub(q, p));
      const upIn = a.dir("up", Z);
      const vRaw = vsub(upIn, vscale(u, vdot(upIn, u)));
      if (vlen(vRaw) < 1e-6) a.ctx.error("rib(): up must not run along the rib");
      const n = vnorm(vcross(u, vnorm(vRaw)));
      const t = a.positive("t");
      const h = a.positive("h");
      const f: Frame = { o: vsub(p, vscale(n, t / 2)), u, n };
      return new ShapeV({
        t: "extrude",
        p: {
          t: "poly",
          pts: [
            [0, 0],
            [L, 0],
            [L, h],
            [0, h],
          ],
          r: 0,
        },
        h: t,
        f,
        twist: 0,
        scale: 1,
      });
    },
    "rib(from, to, t, h, up: Z) — a stiffening wall t thick standing h tall on the line from → to (put from/to on the floor). Ribs are usually 0.5–0.7 × the wall thickness.",
  ),
  def(
    "gusset",
    ["at", "along", "up", "size", "t"],
    (a) => {
      const at = a.vec3("at");
      const u = a.dir("along", [1, 0, 0]);
      const upIn = a.dir("up", Z);
      const vRaw = vsub(upIn, vscale(u, vdot(upIn, u)));
      if (vlen(vRaw) < 1e-6) a.ctx.error("gusset(): up must not be parallel to along");
      const n = vnorm(vcross(u, vnorm(vRaw)));
      const sz = a.value("size");
      const [w, h] = typeof sz === "number" ? [sz, sz] : sz instanceof Vec ? [sz.x, sz.y] : a.ctx.error("gusset(): size should be a number or (along, up)");
      if (!(w > 0 && h > 0)) a.ctx.error("gusset(): size must be greater than 0");
      const t = a.positive("t");
      return new ShapeV({
        t: "extrude",
        p: {
          t: "poly",
          pts: [
            [0, 0],
            [w, 0],
            [0, h],
          ],
          r: 0,
        },
        h: t,
        f: { o: vsub(at, vscale(n, t / 2)), u, n },
        twist: 0,
        scale: 1,
      });
    },
    "gusset(at, along: X, up: Z, size: 8 or (along, up), t:) — a triangular brace in the inside corner at `at` between a face running along `along` and one rising along `up`.",
  ),
  def(
    "oring_groove",
    ["d", "cs", "at", "dir", "type", "squeeze"],
    (a) => {
      const d = a.positive("d");
      const cs = a.positive("cs", 2);
      const type = a.oneOf("type", ["face", "rod", "bore"] as const, "face");
      const squeeze = a.num("squeeze", type === "face" ? 0.25 : 0.2);
      if (squeeze < 0.05 || squeeze > 0.4) a.ctx.error("oring_groove(): squeeze must be 0.05..0.4 (0.25 is typical)");
      const depth = cs * (1 - squeeze);
      const width = 1.4 * cs;
      const at = a.vec3("at", [0, 0, 0]);
      const dir = a.dir("dir", type === "face" ? [0, 0, -1] : Z);
      if (type === "face") {
        if (d - width < 0.5) a.ctx.error("oring_groove(): d is too small for this cross-section");
        return new ShapeV({ t: "tube", od: d + width, id: d - width, h: depth + 0.05, at: vadd(at, vscale(dir, -0.05)), dir });
      }
      const start = vadd(at, vscale(dir, -width / 2));
      if (type === "rod") {
        if (d - 2 * depth < 0.5) a.ctx.error("oring_groove(): the rod is too thin for this cross-section");
        return new ShapeV({ t: "tube", od: d + 2, id: d - 2 * depth, h: width, at: start, dir });
      }
      return new ShapeV({ t: "tube", od: d + 2 * depth, id: Math.max(0.2, d - 2), h: width, at: start, dir });
    },
    'oring_groove(d, cs: 2, at:, dir:, type: "face"|"rod"|"bore", squeeze:) — the cutting tool for an O-ring gland sized from the cord cross-section cs (depth cs × (1 − squeeze), width 1.4 cs). face: d is the groove centre diameter on a flat face, dir points into the material; rod: a groove around a shaft of diameter d, centred at at along the axis dir; bore: a groove inside a hole of diameter d. Use with cut.',
  ),
]);

// ---------- ready-made features ----------

/** Allowable bending strain for a snap fit used a few times, from the material database. */
export const allowableStrain = (material: string) => materialRecord(material)?.snapStrain ?? 0.02;

const OWN_FEATURE_FNS: Record<string, Fn> = Object.fromEntries([
  def(
    "screw_boss",
    ["at", "size", "h", "d", "fit", "depth", "dir", "root_r", "gussets", "t"],
    (a) => {
      const sizeV = a.value("size");
      if (!(sizeV instanceof Obj && sizeV.kind === "thread")) a.ctx.error(`screw_boss(): size should be a thread like M3 (available: ${Object.keys(THREADS).join(", ")})`);
      const t = THREADS[String((sizeV as Obj).fields.key)];
      const fit = a.oneOf("fit", ["insert", "tap", "clearance", "thread"] as const, t.insert_d > 0 ? "insert" : "tap");
      if (fit === "insert" && !t.insert_d) a.ctx.error(`screw_boss(): there is no common heat-set insert for ${t.name}; use fit: "tap" or "thread"`);
      const holeD = fit === "insert" ? t.insert_d : fit === "tap" ? t.tap : fit === "clearance" ? t.clearance : t.d;
      const h = a.positive("h");
      const d = a.positive("d", r2(Math.max(holeD * 2, holeD + 3.2)));
      if (d < holeD + 1.6) a.ctx.error(`screw_boss(): d=${d} leaves a wall under 0.8 mm around the ${r2(holeD)} mm hole`);
      const depth = Math.min(h, a.positive("depth", fit === "insert" ? t.insert_l + 1 : h));
      const at = a.vec3("at");
      const dir = a.dir("dir", Z);
      const top = vadd(at, vscale(dir, h));
      const steps: FeatStep[] = [{ op: "add", shape: { t: "cyl", d, h, at, dir } }];
      const ng = Math.round(a.num("gussets", 0));
      if (ng < 0 || ng > 8) a.ctx.error("screw_boss(): gussets must be 0..8");
      if (ng > 0) {
        const gt = a.positive("t", r2(Math.max(1, (d - holeD) / 2)));
        const fr = frameAt(at, dir);
        const v = vcross(fr.n, fr.u);
        for (let i = 0; i < ng; i++) {
          const ang = (2 * Math.PI * i) / ng;
          const out = vadd(vscale(fr.u, Math.cos(ang)), vscale(v, Math.sin(ang)));
          const n = vcross(out, dir);
          const reach = d * 0.6;
          steps.push({
            op: "add",
            shape: {
              t: "extrude",
              p: {
                t: "poly",
                pts: [
                  [d / 2 - 0.2, 0],
                  [d / 2 + reach, 0],
                  [d / 2 - 0.2, h * 0.7],
                ],
                r: 0,
              },
              h: gt,
              f: { o: vsub(at, vscale(n, gt / 2)), u: out, n },
              twist: 0,
              scale: 1,
            },
          });
        }
      }
      const turns = fit === "thread" ? threadTurnsError("screw_boss()", depth, t.pitch) : null;
      if (turns) a.ctx.error(turns);
      if (fit === "thread") steps.push({ op: "cut", shape: { t: "hole", d: t.d, depth, at: top, dir: vscale(dir, -1), thread: holeThread(t), lead: 0.5 * t.pitch } });
      else steps.push({ op: "cut", shape: { t: "hole", d: holeD, depth, at: top, dir: vscale(dir, -1), csink: holeD + 0.8 } });
      const rr = a.num("root_r", 0.5);
      if (rr > 0) steps.push({ op: "fillet", r: rr, part: "root" });
      return new FeatureV("screw_boss", steps, { hole_d: holeD, d, h, depth, top: new Vec(top) });
    },
    'screw_boss(at, size, h, d:, fit: "insert"|"tap"|"clearance"|"thread", depth:, dir: Z, root_r: 0.5, gussets: 0, t:) — a screw post standing h tall on the floor point `at` for a screw of size (a thread such as M3): the boss, a hole sized for a heat-set insert (default when one exists) or a self-tapping screw, an entry chamfer, a filleted root and optional gussets. Use with add (it adds and cuts).',
  ),
  def(
    "snap_hook",
    ["at", "length", "t", "w", "catch", "dir", "facing", "angle", "root_r", "retain", "preload", "cycles", "peg", "frame", "frame_t", "grip"],
    (a) => {
      const at = a.vec3("at");
      const L = a.positive("length");
      const t = a.positive("t");
      const w = a.positive("w");
      const y = a.positive("catch", 1);
      const dir = a.dir("dir", Z);
      const fIn = a.dir("facing", [1, 0, 0]);
      const uRaw = vsub(fIn, vscale(dir, vdot(fIn, dir)));
      if (vlen(uRaw) < 1e-6) a.ctx.error("snap_hook(): facing must be across the hook, not along dir");
      const u = vnorm(uRaw);
      const n = vcross(u, dir);
      const ang = a.num("angle", 30);
      if (ang < 10 || ang > 60) a.ctx.error("snap_hook(): angle (the lead-in slope from the hook's axis) must be 10..60 degrees");
      const retain = a.num("retain", 90);
      if (retain < 20 || retain > 90) a.ctx.error("snap_hook(): retain (the slope of the catch face from the hook's axis) must be 20..90 degrees; 90 is a square catch that does not let go");
      const preload = a.num("preload", 0);
      if (preload < 0 || preload >= y) a.ctx.error("snap_hook(): preload (how far the hook stays bent once latched) must be 0 or more and less than the catch");
      const cycles = Math.max(1, Math.round(a.num("cycles", 10)));
      // frame: the hook is one leg of a C-shaped clip whose spine, drawn with the rest of the part, bends with it
      const spine = a.has("frame") ? a.positive("frame") : 0;
      if (!spine && a.has("frame_t")) a.ctx.error("snap_hook(): frame_t is the thickness of the clip's spine: give its length with frame:");
      const spineT = spine ? a.positive("frame_t", t) : 0;
      // grip: the clip is pulled by a tab drawn beyond the hook, this far from its axis, not by its head
      if (!spine && a.has("grip")) a.ctx.error("snap_hook(): grip is where a C-shaped clip's pull tab is held: give the clip's spine with frame:");
      const grip = spine && a.has("grip") ? a.positive("grip") : 0;
      const land = Math.max(0.2, 0.25 * y);
      const tipX = Math.min(0.4 * t, t);
      // a catch face sloped back from square lets the hook be pulled out again
      const back = retain >= 89.9 ? 0 : y / Math.tan((retain * Math.PI) / 180);
      const slope = (t / 2 + y - (-t / 2 + tipX)) / Math.tan((ang * Math.PI) / 180);
      const pts: V2[] = [
        [-t / 2, 0],
        [t / 2, 0],
        [t / 2, L],
        [t / 2 + y, L + back],
        [t / 2 + y, L + back + land],
        [-t / 2 + tipX, L + back + land + slope],
        [-t / 2, L + back + land + slope],
      ];
      // peg: a round catch that drops into a hole (a race number, a strap, a sheet): the catch face is the peg's
      // root side and its tip side is sloped off so the sheet's edge rides up over it
      const peg = a.has("peg") ? a.positive("peg") : 0;
      if (peg && peg > w) a.ctx.error("snap_hook(): peg (the round catch's diameter) must be no wider than the hook (w)");
      if (peg && back > 0) a.ctx.error("snap_hook(): a peg catch is square (retain: 90); slope a strap's hole edge instead");
      const ramp = peg ? y / Math.tan((ang * Math.PI) / 180) : 0;
      if (peg && ramp > peg / 2 + 1e-6) a.ctx.error(`snap_hook(): with peg: ${r2(peg)} the lead-in must finish inside the peg: make angle at least ${Math.ceil((Math.atan((2 * y) / peg) * 180) / Math.PI)} degrees or the catch shallower`);
      const armL = peg ? L + peg + Math.max(0.5, t / 2) : 0;
      const frame = { o: vsub(at, vscale(n, w / 2)), u, n };
      const steps: FeatStep[] = [
        { op: "add", shape: { t: "extrude", p: { t: "poly", pts: peg ? [[-t / 2, 0], [t / 2, 0], [t / 2, armL], [-t / 2, armL]] : pts, r: 0 }, h: w, f: frame, twist: 0, scale: 1 } },
      ];
      const rr = a.num("root_r", r2(t / 2));
      if (rr > 0) steps.push({ op: "fillet", r: rr, part: "root" });
      if (peg) {
        // the peg rises from the arm's face; everything above the lead-in slope on its tip side is cut away
        const c = vadd(at, vadd(vscale(u, t / 2 - 0.2), vscale(dir, L + peg / 2)));
        const cutF = { o: vsub(at, vscale(n, peg)), u, n };
        const cutter: V2[] = [
          [t / 2 + y, L + peg / 2],
          [t / 2 + y + 2, L + peg / 2],
          [t / 2 + y + 2, L + peg + 2],
          [t / 2, L + peg + 2],
          [t / 2, L + peg / 2 + ramp],
        ];
        steps.push({ op: "add", shape: { t: "diff", a: { t: "cyl", d: peg, h: y + 0.2, at: c, dir: u }, b: [{ t: "extrude", p: { t: "poly", pts: cutter, r: 0 }, h: 2 * peg, f: cutF, twist: 0, scale: 1 }] } });
      }
      // Bayer cantilever: strain = 1.5 y t / L² for a beam of constant section; a clip's spine shares the bending
      const strain = spine ? snapFrame({ length: L, t, w, frame: spine, frameT: spineT }, 1).strainPerMm * y : (1.5 * y * t) / (L * L);
      const tip = vadd(at, vscale(dir, peg ? armL : L + back + land + slope));
      return new FeatureV("snap_hook", steps, { strain, deflection: y, length: L, tip: new Vec(tip) }, strain, {
        kind: "snap",
        at,
        dir,
        facing: u,
        length: L,
        t,
        w,
        deflection: y,
        leadIn: ang,
        retain,
        preload,
        cycles,
        ...(peg ? { peg } : {}),
        ...(spine ? { frame: spine, frameT: spineT } : {}),
        ...(grip ? { grip } : {}),
      });
    },
    "snap_hook(at, length, t, w, catch: 1, dir: Z, facing: X, angle: 30, root_r: t/2, retain: 90, preload: 0, cycles: 10, peg:, frame:, frame_t: t, grip:) — a cantilever snap-fit hook rising from `at` (the centre of its root) along dir, t thick (toward facing), w wide, with a catch lip `catch` mm deep on the facing side and a lead-in slope. retain is the catch face's slope (90: square, permanent; 30-45: it can be pulled apart again); preload is how far it stays bent once latched (0 rattles if the parts come out a little off); cycles is how often it is snapped. peg: d makes the catch a round peg of that diameter at the arm's tip that clicks into a hole (a race number, a strap or a sheet slid along the arm), square on its root side and sloped on its tip side (angle 40-50). frame: b makes it one leg of a C-shaped clip that wraps round an edge: it rises from the inside face of a spine b mm long and frame_t thick (as wide as the hook, drawn with the rest of the part) that joins it to a rigid part such as a pin through a hole or a head, and the spine bends with it, so the clip springs much further for its strain than a hook alone; a lone framed hook pointing the way the clip goes on is shown pushed on in the fitting steps. A steep catch (retain 70 or more) holds until the hook's tip is pressed down; grip: e says the clip is then pulled out by a tab drawn e mm beyond the hook's axis, on the side away from the head, so the checks try a hard pull there rather than on the head. The springs and clips checks give its push-in and pull-out forces, its strain against the material (and the print's layers) and whether it latches tight or goes slack. .strain gives the bending strain. Use with add.",
  ),
  def(
    "flexure",
    ["at", "length", "t", "w", "dir", "facing", "travel", "angle", "cycles", "root_r", "pin", "reach", "pin_at", "teardrop", "preload", "against"],
    (a) => {
      const at = a.vec3("at");
      const L = a.positive("length");
      const t = a.positive("t");
      const w = a.positive("w");
      const dir = a.dir("dir", Z);
      const fIn = a.dir("facing", [1, 0, 0]);
      const uRaw = vsub(fIn, vscale(dir, vdot(fIn, dir)));
      if (vlen(uRaw) < 1e-6) a.ctx.error("flexure(): facing must be across the blade, not along dir");
      const u = vnorm(uRaw);
      const n = vcross(u, dir);
      const hasAngle = a.has("angle");
      const travel = a.has("travel") ? a.positive("travel") : 0;
      const angle = hasAngle ? a.positive("angle") : undefined;
      if (!hasAngle && !travel) a.ctx.error("flexure(): give travel (how far the free end moves, mm) for a blade, or angle (degrees) for a living hinge");
      if (hasAngle && travel) a.ctx.error("flexure(): give travel or angle, not both");
      if (angle !== undefined && angle > 180) a.ctx.error("flexure(): angle is at most 180 degrees");
      const cycles = Math.max(1, Math.round(a.num("cycles", 1000)));
      // preload: the blade is drawn unbent, pressing that far into the part it bears on (against:), which is drawn where it
      // sits; the overlap checks take that much of an overlap along facing as the spring's squeeze, not a clash
      const preload = a.has("preload") ? a.positive("preload") : 0;
      const againstV = a.raw("against");
      const against = againstV === undefined ? undefined : typeof againstV === "string" ? againstV : againstV instanceof Obj && (againstV.kind === "part" || againstV.kind === "component") ? String(againstV.fields.name) : a.ctx.error(`flexure(): against is the part the blade presses on, by name (like against: "dial"), not ${typeName(againstV)}`);
      if (preload && !against) a.ctx.error('flexure(): preload needs against: the part the blade presses on (like against: "dial")');
      if (against && !preload) a.ctx.error("flexure(): against names the part the blade presses on: give how far it stays bent there with preload:");
      if (preload && angle !== undefined) a.ctx.error("flexure(): preload goes on a spring blade (travel:), not a living hinge");
      if (preload && travel && preload > travel + 1e-6) a.ctx.error("flexure(): preload is part of the blade's travel: make travel at least the preload");
      const steps: FeatStep[] = [{ op: "add", shape: { t: "extrude", p: { t: "rect", w: t, h: L, r: 0, c: [0, L / 2] }, h: w, f: { o: vsub(at, vscale(n, w / 2)), u, n }, twist: 0, scale: 1 } }];
      const rr = a.num("root_r", r2(Math.min(t, 1)));
      if (rr > 0) steps.push({ op: "fillet", r: rr, part: "root" });
      // pin: a locking pin standing out of the blade's face toward facing, which drops through a hole in what it holds
      // (and on into a hole beyond it); pull the blade back by its travel to let go
      const pin = a.has("pin") ? a.positive("pin") : 0;
      const reach = pin ? a.positive("reach") : 0;
      // pin_at: how far along the blade, or a point the pin lines up with (the hole it goes through), which may also sit
      // off the blade's middle across its width
      const pinPoint = pin && a.has("pin_at") && typeof a.raw("pin_at") !== "number" ? vsub(a.vec3("pin_at"), at) : undefined;
      const pinAt = !pin ? 0 : pinPoint ? r2(vdot(pinPoint, dir)) : a.num("pin_at", r2(L - pin / 2 - 0.5));
      const pinOff = pinPoint ? r2(vdot(pinPoint, n)) : 0;
      if (!pin && (a.has("reach") || a.has("pin_at") || a.has("teardrop"))) a.ctx.error("flexure(): reach, pin_at and teardrop describe a locking pin: give its diameter with pin:");
      if (pin && angle !== undefined) a.ctx.error("flexure(): a locking pin goes on a spring blade (travel:), not a living hinge");
      if (pin && (pinAt < pin / 2 || pinAt > L - pin / 2 + 1e-6)) a.ctx.error(`flexure(): pin_at must keep the pin on the blade: ${r2(pin / 2)} to ${r2(L - pin / 2)} mm from its root`);
      if (pin && pin > w + 1e-6) a.ctx.error("flexure(): the pin must be no wider than the blade (w)");
      if (pin && Math.abs(pinOff) + pin / 2 > w / 2 + 1e-6) a.ctx.error(`flexure(): pin_at must keep the pin on the blade: at most ${r2(w / 2 - pin / 2)} mm off its middle, across it`);
      if (pin) {
        const o = vadd(vadd(at, vscale(dir, pinAt)), vscale(n, pinOff));
        steps.push({ op: "add", shape: { t: "cyl", d: pin, h: t / 2 + reach, at: o, dir: u } });
        if (a.has("teardrop")) {
          // printed with its axis level, the underside of a round pin hangs out; a 45° point that way prints on its own
          const down = a.dir("teardrop");
          const dRaw = vsub(down, vscale(u, vdot(down, u)));
          if (vlen(dRaw) < 1e-6) a.ctx.error("flexure(): teardrop is the way the pin's point faces, across the pin, not along it");
          const d = vnorm(dRaw);
          const r = pin / 2;
          const k = r * Math.SQRT1_2;
          steps.push({ op: "add", shape: { t: "extrude", p: { t: "poly", pts: [[k, k], [0, r * Math.SQRT2], [-k, k]], r: 0 }, h: t / 2 + reach, f: { o, u: vcross(d, u), n: u }, twist: 0, scale: 1 } });
        }
      }
      // a living hinge bent through θ over its length strains t·θ / (2 L); a cantilever blade moved δ at its tip 1.5 t δ / L²
      const strain = angle !== undefined ? (t * ((angle * Math.PI) / 180)) / (2 * L) : (1.5 * t * travel) / (L * L);
      return new FeatureV("flexure", steps, { strain, length: L, tip: new Vec(vadd(at, vscale(dir, L))) }, undefined, {
        kind: "flexure",
        at,
        dir,
        facing: u,
        length: L,
        t,
        w,
        deflection: travel,
        angle,
        cycles,
        ...(pin ? { peg: pin, reach, pinAt, ...(pinOff ? { pinOff } : {}) } : {}),
        ...(preload ? { preload, against } : {}),
      });
    },
    "flexure(at, length, t, w, dir: Z, facing: X, travel: | angle:, cycles: 1000, root_r:, pin:, reach:, pin_at:, teardrop:, preload:, against:) — a thin blade that bends instead of a joint, rising from `at` along dir, t thick (toward facing), w wide. Give travel (mm the free end moves sideways) for a spring blade or a parallel-blade stage, or angle (degrees) for a living hinge (make it short and thin: 0.3-0.6 mm in PP). pin: d puts a locking pin of that diameter on the blade's face toward facing, pin_at mm from the root (default near the tip) or at a point it lines up with, such as the hole it goes through (it may then sit off the blade's middle), standing reach mm out of the face: it goes through a hole in what it holds and on into a hole beyond, so nothing can slip past it, and pulling the blade back by its travel lets go (travel must clear the pin out of what it holds). teardrop: -Z gives the pin a 45° point that way so it prints level without support. preload: mm with against: \"part\" makes it a sprung click or clamp: draw the blade unbent and the part it presses on where it sits, overlapping it by the preload along facing; the overlap checks take that as the spring's squeeze (anything deeper is still a clash) and the springs checks give the force it holds with and whether ASA or PLA creeps under it. The springs and clips checks give its stiffness, the force or torque at full travel, and its strain against the material over that many cycles. Use with add.",
  ),
]);

/** Every ready-made feature: the ones above and the building blocks (hinges, lips, vents, clips, clamps, joints, mounts). */
export const FEATURE_FNS: Record<string, Fn> = { ...OWN_FEATURE_FNS, ...BLOCK_FNS };

// ---------- edge and face selectors ----------

export function isSelPreset(s: string): s is SelPreset {
  return (SEL_PRESETS as string[]).includes(s);
}

/** Turn a language value into an edge/face selector. */
export function toSel(v: Value | undefined, ctx: CallCtx, what: string): Sel {
  if (v instanceof SelV) return v.sel;
  if (v instanceof FeatRef) return { s: "feat", f: v.name, part: "edges" };
  if (typeof v === "string") {
    if (isSelPreset(v)) return v;
    return ctx.error(`${what}: "${v}" is not a selection. Use ${SEL_PRESETS.map((p) => `"${p}"`).join(", ")}, a named feature (boss.root, boss.edges), or near(), in_plane(), along(), facing(), circles(), inside(), between()`);
  }
  if (Array.isArray(v)) {
    if (!v.length) return ctx.error(`${what}: the list is empty`);
    return v.length === 1 ? toSel(v[0], ctx, what) : { s: "or", a: v.map((x) => toSel(x, ctx, what)) };
  }
  return ctx.error(`${what} should be a selection such as "top", boss.root or near((x, y, z)), got ${v === undefined ? "nothing" : typeName(v)}`);
}

/** True for values that take part in selector arithmetic (+ and -). */
export function isSelValue(v: Value): boolean {
  return v instanceof SelV || v instanceof FeatRef;
}

/** Feature names a selector refers to. */
export function selFeatures(sel: Sel): string[] {
  if (typeof sel === "string") return [];
  switch (sel.s) {
    case "feat":
      return [sel.f];
    case "between":
      return [sel.a, sel.b];
    case "or":
    case "and":
      return sel.a.flatMap(selFeatures);
    case "minus":
      return [...selFeatures(sel.a), ...selFeatures(sel.b)];
    default:
      return [];
  }
}

function featName(v: Value | undefined, ctx: CallCtx, what: string): string {
  if (v instanceof FeatRef) return v.name;
  return ctx.error(`${what} should be a named feature (from add ... as name), got ${v === undefined ? "nothing" : typeName(v)}`);
}

const sel = (s: Sel) => new SelV(s);

export const SELECT_FNS: Record<string, Fn> = Object.fromEntries([
  def("near", ["point", "r"], (a) => sel({ s: "near", p: a.vec3("point"), r: a.positive("r", 1) }), "near((x, y, z), r: 1) — edges (or faces) within r of a point in the part's own coordinates."),
  def("in_plane", ["normal", "offset"], (a) => sel({ s: "plane", n: a.dir("normal"), d: a.num("offset", 0) }), "in_plane(Z, 10) — edges or faces lying in the plane normal·p = offset (here z = 10)."),
  def("along", ["dir"], (a) => sel({ s: "along", d: a.dir("dir") }), "along(X) — straight edges running along a direction (faces: those parallel to it)."),
  def("facing", ["dir"], (a) => sel({ s: "facing", d: a.dir("dir") }), "facing(-Y) — flat faces looking that way (for edges: the edges around them)."),
  def("circles", ["d"], (a) => sel({ s: "circle", d: a.num("d", 0) }), "circles(d: 0) — circular edges (hole and boss rims) of diameter d, or all of them."),
  def(
    "inside",
    ["lo", "hi"],
    (a) => {
      const p = a.vec3("lo");
      const q = a.vec3("hi");
      return sel({ s: "box", lo: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], hi: [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])] });
    },
    "inside((x0, y0, z0), (x1, y1, z1)) — edges or faces entirely inside a box.",
  ),
  def("between", ["a", "b"], (a) => sel({ s: "between", a: featName(a.value("a"), a.ctx, "between() a"), b: featName(a.value("b"), a.ctx, "between() b") }), "between(a, b) — the edges where two named features meet."),
  def(
    "both",
    ["a", "b", "c"],
    (a) => sel({ s: "and", a: ["a", "b", "c"].filter((k) => a.has(k)).map((k) => toSel(a.value(k), a.ctx, `both() ${k}`)) }),
    "both(a, b) — only what both selections pick, e.g. both(lid.edges, \"top\").",
  ),
]);

/** Members of a named feature: boss.root, boss.tip, boss.edges, boss.faces. */
export function featMember(f: FeatRef, name: string): Value | undefined {
  if (name === "root" || name === "tip" || name === "edges" || name === "faces") return new SelV({ s: "feat", f: f.name, part: name });
  if (name === "convex" || name === "concave") return new SelV({ s: "and", a: [{ s: "feat", f: f.name, part: "edges" }, name] });
  return undefined;
}

export function selMember(s: SelV, name: string): Value | undefined {
  if (name === "convex" || name === "concave") return new SelV({ s: "and", a: [s.sel, name] });
  return undefined;
}

export const MODELLING_FNS: Record<string, Fn> = { ...PROFILE_FNS, ...PATH_FNS, ...SOLID_FNS, ...FEATURE_FNS, ...SELECT_FNS, ...SHEET_FNS, ...MOULD_FNS, ...AERO_FNS };
