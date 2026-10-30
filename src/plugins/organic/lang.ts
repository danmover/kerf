// The `organic` namespace in .kerf: blended shapes for creatures, people and
// other soft forms. Each function returns a list of model items; organic.model()
// gathers them into one shape for a part's body.
//
//   part fox {
//     body organic.model([
//       organic.egg(size: (32, 48, 30), at: (0, 8, 28)),
//       organic.ball(d: 48, at: (0, -16, 52), blend: 8),
//       organic.limb(from: (9, -4, 24), to: (9, -4, 4), d: 12, mirror: true),
//       organic.paint(organic.egg(size: (18, 20, 14), at: (0, -36, 46)), color: #ffffff),
//     ], tris: 12000, color: #7cc3f0)
//   }

import { Args } from "../../lang/args";
import { Fn, Obj, ShapeV, Vec, typeName, type CallCtx, type Value } from "../../lang/values";
import { hexColor } from "./sdf";
import { MAX_ITEMS, MAX_TRIS, type DetailKind, type Item, type M3, type OrganicModel, type OrganicStyle, type Prim, type V2, type V3 } from "./model";

/** A list of organic items, as the namespace's functions pass them round. */
export class OrganicV extends Obj {
  constructor(public items: Item[]) {
    super({ count: items.length }, "organic shape", "organic");
  }
}

const STYLES: readonly OrganicStyle[] = ["lowpoly", "smooth", "detailed"];
const DETAILS: readonly DetailKind[] = ["fur", "scales", "skin", "feathers"];

// ── transforms ─────────────────────────────────────────────────────────────

type Mat = number[]; // 3x3 row-major

const mul = (a: Mat, b: Mat): Mat => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
const apply = (m: Mat, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const transpose = (m: Mat): Mat => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const IDENT: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const MIRROR_X: Mat = [-1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rotation by rx about X, then ry about Y, then rz about Z (degrees), like a part's rotate:. */
export function rotation(r: V3): Mat {
  const [ax, ay, az] = r.map((d) => (d * Math.PI) / 180);
  const rx: Mat = [1, 0, 0, 0, Math.cos(ax), -Math.sin(ax), 0, Math.sin(ax), Math.cos(ax)];
  const ry: Mat = [Math.cos(ay), 0, Math.sin(ay), 0, 1, 0, -Math.sin(ay), 0, Math.cos(ay)];
  const rz: Mat = [Math.cos(az), -Math.sin(az), 0, Math.sin(az), Math.cos(az), 0, 0, 0, 1];
  return mul(rz, mul(ry, rx));
}

/** Move a primitive: p → s·R·p + t, or its mirror image across x = 0 when `mirror`. */
function movePrim(p: Prim, R: Mat, s: number, t: V3, mirror = false): Prim {
  const L = mirror ? MIRROR_X : R;
  const pt = (v: V3): V3 => {
    const r = apply(L, v);
    return [r[0] * s + t[0], r[1] * s + t[1], r[2] * s + t[2]];
  };
  const dir = (v: V3): V3 => apply(L, v);
  // world→local maps compose with the inverse of the move's linear part
  const local = (m: M3 | undefined): M3 => mul(m ?? IDENT, mirror ? MIRROR_X : transpose(R)) as M3;
  switch (p.k) {
    case "ball":
      return { ...p, c: pt(p.c), r: p.r * s };
    case "ellipsoid":
      return { ...p, c: pt(p.c), r: [p.r[0] * s, p.r[1] * s, p.r[2] * s], m: local(p.m) };
    case "limb":
      return { ...p, a: pt(p.a), b: pt(p.b), ra: p.ra * s, rb: p.rb * s };
    case "box":
      return { ...p, c: pt(p.c), h: [p.h[0] * s, p.h[1] * s, p.h[2] * s], r: p.r * s, m: local(p.m) };
    case "slab":
      return {
        ...p,
        o: pt(p.o),
        u: dir(p.u),
        n: dir(p.n),
        // a mirrored frame turns the outline over in its own plane
        pts: p.pts.map(([x, y]) => [x * s, (mirror ? -y : y) * s] as V2),
        t: p.t * s,
        r: p.r * s,
      };
    case "torus":
      return { ...p, c: pt(p.c), n: dir(p.n), R: p.R * s, r: p.r * s };
    case "gem":
      return { ...p, a: pt(p.a), b: pt(p.b), r: p.r * s, tip: p.tip * s };
    case "cones": {
      const out = p.s.slice();
      for (let o = 0; o + 7 < out.length; o += 8) {
        [out[o], out[o + 1], out[o + 2]] = pt([out[o], out[o + 1], out[o + 2]]);
        [out[o + 3], out[o + 4], out[o + 5]] = pt([out[o + 3], out[o + 4], out[o + 5]]);
        out[o + 6] *= s;
        out[o + 7] *= s;
      }
      return { k: "cones", s: out };
    }
  }
}

function mirrored(items: Item[]): Item[] {
  return items.map((it) => ({ ...it, prim: movePrim(it.prim, IDENT, 1, [0, 0, 0], true), name: it.name ? it.name + "_mirror" : undefined }));
}

// ── arguments ──────────────────────────────────────────────────────────────

const COMMON = ["color", "blend", "mirror", "detail", "name"];

function common(a: Args, prim: Prim): OrganicV {
  const it: Item = { op: "add", prim, blend: -1 };
  if (a.has("color")) it.color = colorArg(a, "color");
  if (a.has("blend")) {
    const b = a.num("blend");
    if (b < 0) a.ctx.error(`${a.fname}(): blend is a smoothing radius in mm, 0 or more (got ${b})`);
    it.blend = b;
  }
  if (a.has("detail")) {
    const d = a.num("detail");
    if (d < 0 || d > 1) a.ctx.error(`${a.fname}(): detail is how much surface detail this shape gets, from 0 to 1 (got ${d})`);
    it.detail = d;
  }
  if (a.has("name")) it.name = a.str("name");
  const items = [it];
  return new OrganicV(a.bool("mirror") ? [...items, ...mirrored(items)] : items);
}

function colorArg(a: Args, name: string): string {
  const v = a.raw(name);
  if (typeof v !== "string" || hexColor(v, "") === "") a.ctx.error(`${a.fname}(): ${name} should be a colour like #7cc3f0, got ${v === undefined ? "nothing" : typeName(v)}`);
  return hexColor(v as string, "#c8c8c8");
}

function size(a: Args, name: string): V3 {
  const v = a.raw(name);
  if (typeof v === "number") {
    if (!(v > 0)) a.ctx.error(`${a.fname}(): ${name} must be greater than 0`);
    return [v, v, v];
  }
  const s = a.vec3(name);
  if (!(s[0] > 0 && s[1] > 0 && s[2] > 0)) a.ctx.error(`${a.fname}(): every part of ${name} must be greater than 0 (got (${s.join(", ")}))`);
  return s;
}

/** Shapes from a value: one organic shape or a (nested) list of them. */
export function organicItems(v: Value | undefined, ctx: CallCtx, what: string): Item[] {
  const out: Item[] = [];
  const walk = (x: Value | undefined) => {
    if (x instanceof OrganicV) out.push(...x.items);
    else if (Array.isArray(x)) for (const y of x) walk(y);
    else if (x === null || x === undefined) return;
    else ctx.error(`${what} takes organic shapes (organic.ball(), organic.limb() …) or lists of them, got ${typeName(x)}`);
  };
  walk(v);
  if (out.length > MAX_ITEMS) ctx.error(`${what}: ${out.length} shapes is more than the ${MAX_ITEMS} one model can hold; join small details or make a second part`);
  ctx.tick?.(out.length);
  return out;
}

function frame(a: Args): { u: V3; n: V3 } {
  const n = a.dir("facing", [0, -1, 0]);
  const upDef: V3 = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  let up = a.dir("up", upDef);
  // up square to the facing direction
  const k = up[0] * n[0] + up[1] * n[1] + up[2] * n[2];
  up = [up[0] - n[0] * k, up[1] - n[1] * k, up[2] - n[2] * k];
  const l = Math.hypot(...up);
  if (l < 1e-6) a.ctx.error(`${a.fname}(): up must not point the same way as facing`);
  up = [up[0] / l, up[1] / l, up[2] / l];
  // u = up × n, so the outline's y runs along up
  const u: V3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  return { u, n };
}

function starPoints(points: number, d: number, inner: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = (i % 2 ? inner : 1) * (d / 2);
    const a = Math.PI / 2 + (Math.PI * i) / points;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out;
}

// ── curves ─────────────────────────────────────────────────────────────────

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Most segments one tube, curl or tuft may have. */
const MAX_SEGMENTS = 160;

/** Segments along a smooth (Catmull-Rom) curve through the points, radius eased from point to point. */
export function tubeSegments(pts: V3[], radii: number[]): number[] {
  const n = pts.length;
  const tangent = (i: number): V3 => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const k = i === 0 || i === n - 1 ? 1 : 0.5;
    return [(b[0] - a[0]) * k, (b[1] - a[1]) * k, (b[2] - a[2]) * k];
  };
  const out: number[] = [];
  const budget = Math.max(1, Math.floor(MAX_SEGMENTS / (n - 1)));
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const m0 = tangent(i);
    const m1 = tangent(i + 1);
    const len = Math.hypot(...sub(p1, p0));
    const rMin = Math.max(0.05, Math.min(radii[i], radii[i + 1]));
    const steps = Math.max(1, Math.min(budget, Math.ceil(len / (rMin * 0.9)), 16));
    let prev = p0;
    let prevR = radii[i];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const q: V3 = [0, 1, 2].map((c) => h00 * p0[c] + h10 * m0[c] + h01 * p1[c] + h11 * m1[c]) as V3;
      const r = radii[i] + (radii[i + 1] - radii[i]) * t;
      out.push(prev[0], prev[1], prev[2], q[0], q[1], q[2], prevR, r);
      prev = q;
      prevR = r;
    }
  }
  return out;
}

/** Turn v about the unit axis k by angle a (radians). */
function turn(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}

/** Diameters at each of n points: one number, a start and end, or one per point. */
function diameters(a: Args, name: string, n: number, def?: number): number[] {
  const v = a.raw(name);
  const list = typeof v === "number" ? [v] : Array.isArray(v) ? v : v instanceof Vec ? v.v : v === undefined && def !== undefined ? [def] : null;
  if (!list || !list.every((x) => typeof x === "number" && x > 0)) return a.ctx.error(`${a.fname}(): ${name} is a diameter in mm, or a list of them, each greater than 0`);
  const ds = list as number[];
  if (ds.length === 1) return new Array(n).fill(ds[0]);
  if (ds.length === n) return ds;
  if (ds.length === 2) return Array.from({ length: n }, (_, i) => ds[0] + ((ds[1] - ds[0]) * i) / Math.max(1, n - 1));
  return a.ctx.error(`${a.fname}(): ${name} needs one diameter, a start and end pair, or one per point (${n})`);
}

// ── the namespace ──────────────────────────────────────────────────────────

function fn(name: string, params: string[], impl: (a: Args) => Value, doc: string): [string, Fn] {
  return [name, new Fn(`organic.${name}`, (pos, named, ctx) => impl(new Args(`organic.${name}`, pos, named, ctx, params)), doc)];
}

export function organicNamespace(): Obj {
  const fns = Object.fromEntries([
    fn(
      "model",
      ["shapes", "style", "tris", "color", "blend", "detail", "detail_size", "detail_depth"],
      (a) => {
        const items = organicItems(a.raw("shapes"), a.ctx, "organic.model()");
        if (!items.some((i) => i.op === "add")) a.ctx.error("organic.model() needs at least one shape that adds material (not only paint or carve)");
        const blend = a.num("blend", 3);
        if (blend < 0) a.ctx.error("organic.model(): blend must be 0 or more");
        const style = a.oneOf("style", STYLES, "smooth");
        const tris = Math.round(a.num("tris", 0));
        if (tris < 0 || tris > MAX_TRIS) a.ctx.error(`organic.model(): tris is the triangle budget, from 100 to ${MAX_TRIS} (0 picks one for the style)`);
        if (tris > 0 && tris < 100) a.ctx.error("organic.model(): tris below 100 cannot hold a recognisable shape");
        const model: OrganicModel = {
          v: 1,
          items: items.map((i) => (i.blend >= 0 ? i : { ...i, blend: i.op === "paint" ? 0 : blend })),
          color: a.has("color") ? colorArg(a, "color") : "#c8c8c8",
          style,
          tris,
        };
        if (a.has("detail")) {
          const kind = a.oneOf("detail", DETAILS, "fur");
          if (style !== "detailed") a.ctx.warn?.(`organic.model(): detail: "${kind}" only shows with style: "detailed"`);
          model.detail = { kind, scale: a.positive("detail_size", kind === "skin" ? 3 : 2), amp: a.positive("detail_depth", kind === "skin" ? 0.25 : 0.5) };
        } else if (style === "detailed") model.detail = { kind: "skin", scale: 3, amp: 0.25 };
        return new ShapeV({ t: "meshgen", gen: "organic", data: model });
      },
      'organic.model(shapes, style: "smooth", tris: 0, color: #c8c8c8, blend: 3, detail:, detail_size:, detail_depth:) — one soft body from organic shapes, for a part\'s body. Shapes join in order, each smoothed into the ones before by its blend (mm). style: "smooth" (soft stylised forms with baked soft shading, 8000–20000 tris; the default), "lowpoly" (faceted, flat colours, 1500–5000 tris) or "detailed" (fine surface detail: detail: "fur", "scales", "skin" or "feathers", detail_size: pattern size mm, detail_depth: bump height mm). tris: triangle budget (0: 16000 smooth, 4000 lowpoly, 160000 detailed). color: where no shape or paint sets one.',
    ),
    fn(
      "ball",
      ["d", "at", ...COMMON],
      (a) => common(a, { k: "ball", c: a.vec3("at", [0, 0, 0]), r: a.positive("d") / 2 }),
      "organic.ball(d, at: (0, 0, 0), color:, blend:, mirror: false) — a ball of diameter d. mirror: true also adds its copy across x = 0.",
    ),
    fn(
      "egg",
      ["size", "at", "rotate", ...COMMON],
      (a) => {
        const s = size(a, "size");
        const m = a.has("rotate") ? (transpose(rotation(a.vec3("rotate"))) as M3) : undefined;
        return common(a, { k: "ellipsoid", c: a.vec3("at", [0, 0, 0]), r: [s[0] / 2, s[1] / 2, s[2] / 2], ...(m ? { m } : {}) });
      },
      "organic.egg(size: (x, y, z), at:, rotate: (rx, ry, rz), color:, blend:, mirror:) — an egg/bean shape (ellipsoid) with these overall sizes. Bodies, heads, cheeks, bellies, paws.",
    ),
    fn(
      "limb",
      ["from", "to", "d", "d2", ...COMMON],
      (a) => {
        const d = a.positive("d");
        const d2 = a.positive("d2", d);
        return common(a, { k: "limb", a: a.vec3("from"), b: a.vec3("to"), ra: d / 2, rb: d2 / 2 });
      },
      "organic.limb(from:, to:, d:, d2:, color:, blend:, mirror:) — a rounded tube from one point to another, diameter d at from and d2 at to (default d). Legs, arms, necks, tails, horns (d2 small), ears, whiskers, fingers.",
    ),
    fn(
      "block",
      ["size", "at", "r", "rotate", ...COMMON],
      (a) => {
        const s = size(a, "size");
        const r = a.num("r", Math.min(...s) / 4);
        const m = a.has("rotate") ? (transpose(rotation(a.vec3("rotate"))) as M3) : undefined;
        return common(a, { k: "box", c: a.vec3("at", [0, 0, 0]), h: [s[0] / 2, s[1] / 2, s[2] / 2], r: Math.max(0, r), ...(m ? { m } : {}) });
      },
      "organic.block(size: (x, y, z), at:, r:, rotate:, color:, blend:, mirror:) — a box with rounded edges of radius r (default a quarter of its smallest size). Chunky boxy forms, chests, baskets, hats.",
    ),
    fn(
      "slab",
      ["points", "t", "at", "facing", "up", "r", ...COMMON],
      (a) => {
        const pts = a.points2("points");
        if (pts.length < 3) a.ctx.error("organic.slab(): points needs at least 3 corners");
        const t = a.positive("t");
        const { u, n } = frame(a);
        return common(a, { k: "slab", pts, t: t / 2, r: a.num("r", t / 2), o: a.vec3("at", [0, 0, 0]), u, n });
      },
      "organic.slab(points: [(x, y) …], t:, at:, facing: -Y, up: Z, r:) — a flat outline given thickness t (fins, feathers, leaves, wings, flat tails, lightning bolts). The outline's x runs sideways and y along up:, in the plane square to facing:. r rounds its edges (default t/2).",
    ),
    fn(
      "star",
      ["d", "t", "at", "facing", "up", "points", "inner", "r", ...COMMON],
      (a) => {
        const n = Math.round(a.num("points", 5));
        if (n < 3 || n > 24) a.ctx.error("organic.star(): points must be from 3 to 24");
        const inner = a.num("inner", 0.45);
        if (!(inner > 0 && inner < 1)) a.ctx.error("organic.star(): inner is the inner radius as a fraction of the outer, between 0 and 1");
        const d = a.positive("d");
        const t = a.positive("t", d / 5);
        const { u, n: nn } = frame(a);
        return common(a, { k: "slab", pts: starPoints(n, d, inner), t: t / 2, r: a.num("r", Math.min(t / 2, d / 12)), o: a.vec3("at", [0, 0, 0]), u, n: nn });
      },
      "organic.star(d, t:, at:, facing: -Y, up: Z, points: 5, inner: 0.45) — a chunky star of diameter d and thickness t (default d/5), one point toward up:.",
    ),
    fn(
      "ring",
      ["d", "tube", "at", "axis", ...COMMON],
      (a) => common(a, { k: "torus", c: a.vec3("at", [0, 0, 0]), R: a.positive("d") / 2, r: a.positive("tube") / 2, n: a.dir("axis", [0, 0, 1]) }),
      "organic.ring(d, tube:, at:, axis: Z) — a ring (torus) of diameter d made of a tube of diameter tube. Collars, cuffs, halos, rims.",
    ),
    fn(
      "gem",
      ["from", "to", "d", "sides", "tip", ...COMMON],
      (a) => {
        const d = a.positive("d");
        const sides = Math.round(a.num("sides", 6));
        if (sides < 3 || sides > 16) a.ctx.error("organic.gem(): sides must be from 3 to 16");
        return common(a, { k: "gem", a: a.vec3("from"), b: a.vec3("to"), r: d / 2, sides, tip: a.num("tip", d * 0.6) });
      },
      "organic.gem(from:, to:, d:, sides: 6, tip:) — a faceted crystal: a prism with flat sides from from to to, then a point of length tip (default 0.6 d). Crystals, gems, sharp spikes.",
    ),
    fn(
      "tube",
      ["points", "d", ...COMMON],
      (a) => {
        const pts = a.points3("points");
        if (pts.length < 2) a.ctx.error("organic.tube(): points needs at least 2 points");
        const ds = diameters(a, "d", pts.length);
        return common(a, { k: "cones", s: tubeSegments(pts, ds.map((d) => d / 2)) });
      },
      "organic.tube(points: [(x, y, z) …], d:, color:, blend:, mirror:) — a smooth curved tube through the points, tapering through the diameters d: (one number, a [start, end] pair, or one per point). Tails that sweep and curl, necks, curved bodies, trunks, tentacles, curved horns, eyebrows and mouths (inside carve).",
    ),
    fn(
      "curl",
      ["at", "axis", "start", "r", "r2", "turns", "d", "d2", "rise", ...COMMON],
      (a) => {
        const c = a.vec3("at", [0, 0, 0]);
        const n = a.dir("axis", [1, 0, 0]);
        let s0 = a.dir("start", Math.abs(n[2]) > 0.9 ? [0, -1, 0] : [0, 0, 1]);
        const k = s0[0] * n[0] + s0[1] * n[1] + s0[2] * n[2];
        s0 = unit([s0[0] - n[0] * k, s0[1] - n[1] * k, s0[2] - n[2] * k]);
        const r = a.positive("r");
        const r2 = a.num("r2", r * 0.3);
        const turns = a.num("turns", 1);
        if (Math.abs(turns) < 0.05 || Math.abs(turns) > 4) a.ctx.error("organic.curl(): turns must be from 0.05 to 4 (negative winds the other way)");
        const d = a.positive("d");
        const d2 = a.positive("d2", d * 0.4);
        const rise = a.num("rise", 0);
        const m = Math.max(4, Math.ceil(Math.abs(turns) * 20));
        const pts: V3[] = [];
        const rs: number[] = [];
        for (let i = 0; i <= m; i++) {
          const t = i / m;
          const rho = r + (Math.max(0, r2) - r) * t;
          const dir = turn(s0, n, 2 * Math.PI * turns * t);
          pts.push([c[0] + dir[0] * rho + n[0] * rise * t, c[1] + dir[1] * rho + n[1] * rise * t, c[2] + dir[2] * rho + n[2] * rise * t]);
          rs.push((d + (d2 - d) * t) / 2);
        }
        return common(a, { k: "cones", s: tubeSegments(pts, rs) });
      },
      "organic.curl(at:, axis: X, start: Z, r:, r2:, turns: 1, d:, d2:, rise: 0) — a tapering tube wound in a spiral round at: about axis:, starting toward start: at radius r and closing to r2 (default 0.3 r), diameter d to d2 (default 0.4 d). rise: drift along the axis over the curl. Ram horns, curly tails, snail shells, fern tips, curled antennae; mirror: true winds the other side's copy the mirrored way.",
    ),
    fn(
      "tuft",
      ["at", "toward", "length", "d", "count", "spread", "fan", "around", "tip", ...COMMON],
      (a) => {
        const base = a.vec3("at");
        const dir = a.dir("toward");
        const len = a.positive("length");
        const d = a.positive("d");
        const count = Math.round(a.num("count", 3));
        if (count < 1 || count > 24) a.ctx.error("organic.tuft(): count must be from 1 to 24");
        const spread = (a.num("spread", 50) * Math.PI) / 180;
        const tip = a.num("tip", d * 0.12) / 2;
        const out: number[] = [];
        const push = (v: V3) => out.push(base[0], base[1], base[2], base[0] + v[0] * len, base[1] + v[1] * len, base[2] + v[2] * len, d / 2, Math.max(0.05, tip));
        if (a.bool("around")) {
          // a ring of spikes round the direction, opening by spread
          const side = unit(Math.abs(dir[2]) < 0.9 ? cross(dir, [0, 0, 1]) : cross(dir, [1, 0, 0]));
          for (let i = 0; i < count; i++) push(turn(turn(dir, side, spread / 2), dir, (2 * Math.PI * i) / count));
          if (count > 2) push(dir);
        } else {
          let fan = a.has("fan") ? a.dir("fan") : cross(dir, [0, 0, 1]);
          if (Math.hypot(...fan) < 1e-6) fan = [0, 1, 0];
          fan = unit(fan);
          for (let i = 0; i < count; i++) push(turn(dir, fan, count === 1 ? 0 : -spread / 2 + (spread * i) / (count - 1)));
        }
        return common(a, { k: "cones", s: out });
      },
      "organic.tuft(at:, toward:, length:, d:, count: 3, spread: 50, fan:, around: false, tip:) — a clump of pointed spikes from at: fanned over spread degrees round the direction toward: (in the plane of toward and Z unless fan: gives the turning axis; around: true puts them in a ring like a tail tip). d: base diameter, tip: point diameter. Jagged fur: cheek ruffs, chest ruffs, manes, tail tips, crests, spiky hair, feather crowns; also paint(tuft) for jagged colour edges.",
    ),
    fn(
      "eye",
      ["at", "d", "facing", "color", "shine", "blend", "mirror", "name"],
      (a) => {
        const c = a.vec3("at");
        const d = a.positive("d");
        const f = a.dir("facing", [0, -1, 0]);
        const up0: V3 = Math.abs(f[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
        const k = up0[0] * f[0] + up0[1] * f[1] + up0[2] * f[2];
        const up = unit([up0[0] - f[0] * k, up0[1] - f[1] * k, up0[2] - f[2] * k]);
        const side = cross(up, f);
        const shine = a.has("shine") ? colorArg(a, "shine") : "#ffffff";
        const color = a.has("color") ? colorArg(a, "color") : "#1b1820";
        const blend = a.has("blend") ? Math.max(0, a.num("blend")) : 0.5;
        const name = a.has("name") ? a.str("name") : undefined;
        // the highlights sit on the same side of both eyes, as if lit from one window
        const eye = (c: V3, f: V3): Item[] => {
          const at = (w: [number, number, number], s: number): V3 => {
            const u = unit([f[0] + up[0] * w[1] + side[0] * w[0], f[1] + up[1] * w[1] + side[1] * w[0], f[2] + up[2] * w[1] + side[2] * w[0]]);
            return [c[0] + u[0] * s, c[1] + u[1] * s, c[2] + u[2] * s];
          };
          return [
            { op: "add", prim: { k: "ball", c, r: d / 2 }, color, blend, detail: 0, ...(name ? { name } : {}) },
            { op: "paint", prim: { k: "ball", c: at([-0.4, 0.55, 0], d / 2), r: d * 0.17 }, color: shine, blend: 0 },
            { op: "paint", prim: { k: "ball", c: at([0.35, -0.45, 0], d / 2), r: d * 0.08 }, color: shine, blend: 0 },
          ];
        };
        const items = eye(c, f);
        if (a.bool("mirror")) items.push(...eye([-c[0], c[1], c[2]], [-f[0], f[1], f[2]]).map((it) => (it.name ? { ...it, name: it.name + "_mirror" } : it)));
        return new OrganicV(items);
      },
      "organic.eye(at:, d:, facing: -Y, color: #1b1820, shine: #ffffff, mirror:) — a glossy cartoon eye: a dark ball (set at: so about a third of it stands out of the head) with two painted highlights. Leave eyes out when the face is for expression decals.",
    ),
    fn(
      "paint",
      ["shapes", "color", "wobble", "wobble_size", "seed"],
      (a) => {
        const items = organicItems(a.raw("shapes"), a.ctx, "organic.paint()");
        const color = colorArg(a, "color");
        const wobble = a.num("wobble", 0);
        const noise = wobble > 0 ? { amount: wobble, scale: a.positive("wobble_size", 8), seed: a.num("seed", 1) } : undefined;
        return new OrganicV(items.map((it) => ({ ...it, op: "paint", color, blend: 0, ...(noise ? { noise } : {}) })));
      },
      "organic.paint(shapes, color:, wobble: 0, wobble_size: 8, seed: 1) — colour the surface wherever it passes inside these shapes, without changing the form: muzzles, bellies, socks, spots, stripes, markings. Later paint covers earlier paint. wobble (0–1) makes the edge wander (patches, galaxy swirls).",
    ),
    fn(
      "carve",
      ["shapes", "color", "blend"],
      (a) => {
        const items = organicItems(a.raw("shapes"), a.ctx, "organic.carve()");
        const color = a.has("color") ? colorArg(a, "color") : undefined;
        const blend = a.has("blend") ? a.num("blend") : undefined;
        return new OrganicV(items.map((it) => ({ ...it, op: "carve", ...(color ? { color } : {}), ...(blend !== undefined ? { blend } : {}) })));
      },
      "organic.carve(shapes, color:, blend:) — cut these shapes out of what came before: mouths, nostrils, ear hollows, the inside of a basket. color: colours the cut surface.",
    ),
    fn(
      "group",
      ["shapes", "at", "rotate", "scale", "mirror"],
      (a) => {
        const items = organicItems(a.raw("shapes"), a.ctx, "organic.group()");
        const R = rotation(a.vec3("rotate", [0, 0, 0]));
        const s = a.positive("scale", 1);
        const t = a.vec3("at", [0, 0, 0]);
        const moved = items.map((it) => ({ ...it, prim: movePrim(it.prim, R, s, t) }));
        return new OrganicV(a.bool("mirror") ? [...moved, ...mirrored(moved)] : moved);
      },
      "organic.group(shapes, at:, rotate: (rx, ry, rz), scale: 1, mirror: false) — turn, scale, then move a set of shapes drawn round the origin: build an ear, a wing or a whole head once and place it. mirror: true adds the copy across x = 0.",
    ),
    fn(
      "mirror",
      ["shapes"],
      (a) => {
        const items = organicItems(a.raw("shapes"), a.ctx, "organic.mirror()");
        return new OrganicV([...items, ...mirrored(items)]);
      },
      "organic.mirror(shapes) — these shapes plus their copies across x = 0 (left and right).",
    ),
  ]);
  return new Obj(fns, "organic shapes", "organic");
}

