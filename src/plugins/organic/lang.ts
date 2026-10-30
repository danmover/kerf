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
//     ], style: "lowpoly", tris: 2000, color: #7cc3f0)
//   }

import { Args } from "../../lang/args";
import { Fn, Obj, ShapeV, typeName, type CallCtx, type Value } from "../../lang/values";
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
        const style = a.oneOf("style", STYLES, "lowpoly");
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
      'organic.model(shapes, style: "lowpoly", tris: 0, color: #c8c8c8, blend: 3, detail:, detail_size:, detail_depth:) — one soft body from organic shapes, for a part\'s body. Shapes join in order, each smoothed into the ones before by its blend (mm). style: "lowpoly" (faceted game asset, ~2000–5000 tris), "smooth" (soft toy) or "detailed" (fine surface detail: detail: "fur", "scales", "skin" or "feathers", detail_size: pattern size mm, detail_depth: bump height mm). tris: triangle budget. color: where no shape or paint sets one.',
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

