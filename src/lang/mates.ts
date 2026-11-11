// The design language's side of mates: `mate against(face(lid, -Z), face(box, +Z))` and the faces, axes, points
// and planes a mate holds by. The evaluator resolves the faces and axes from the kernel's face catalogue of each
// solid (fetched once a solid is built), solves the mates once the whole design is read (src/core/mates.ts) and
// moves the parts they place.

import { Args } from "./args";
import { Fn, Obj, Ref, typeName, type Value } from "./values";
import type { FaceCatalogue, MateKind } from "../core/mates";
import type { V3 } from "../kernel/recipe";

/** A face, axis, point or plane of a part that a mate holds by, as the design names it. */
export type MateRefSpec =
  | { t: "face"; body: string; dir?: V3; near?: V3 }
  | { t: "axis"; body: string; near?: V3; d?: number; along?: V3 }
  | { t: "line"; body: string; at: V3; dir: V3 }
  | { t: "point"; body: string; p: V3 }
  | { t: "plane"; body: string; at: V3; normal: V3 }
  | { t: "body"; body: string };

export class MateRefV extends Obj {
  constructor(
    public ref: MateRefSpec,
    label: string,
  ) {
    super({}, "mate geometry", label);
  }
}

export class MateV extends Obj {
  constructor(
    public kind: MateKind,
    public a: MateRefV,
    public b: MateRefV,
    public value?: number,
    public min?: number,
    public max?: number,
  ) {
    super({}, "mate", kind);
  }
}

// ---------- the face catalogues the kernel has made, by geometry hash ----------

/**
 * A built solid's faces by its geometry hash. The part's name lets a table answer with the faces the part had
 * before an edit while its new solid is built, so mated parts stay in place meanwhile.
 */
export type FaceLookup = (hash: string, name: string) => FaceCatalogue | undefined;

let faceTable: FaceLookup = () => undefined;
/** Where evaluation finds each built solid's flat and round faces (the engine sets it as solids are built). */
export function setEvalFaces(lookup: FaceLookup) {
  faceTable = lookup;
}
export const evalFaces = () => faceTable;

// ---------- functions ----------

const clean = (v: V3): V3 => [v[0] || 0, v[1] || 0, v[2] || 0];
const fmt = (v: V3) => `(${v.map((x) => +x.toFixed(3)).join(", ")})`;
const dirName = (v: V3) => {
  const n = clean(v);
  const axes: [V3, string][] = [
    [[1, 0, 0], "X"],
    [[0, 1, 0], "Y"],
    [[0, 0, 1], "Z"],
  ];
  for (const [a, w] of axes) {
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    const l = Math.hypot(...n);
    if (Math.abs(Math.abs(d) - l) < 1e-9) return `${d < 0 ? "-" : "+"}${w}`;
  }
  return fmt(n);
};

function bodyName(v: Value | undefined, a: Args, what: string): string {
  if (v instanceof Ref) return v.name;
  if (v instanceof Obj && v.kind === "component" && typeof v.fields.name === "string") {
    if (typeof v.fields.count === "number" && v.fields.count > 1 && !a.fname.startsWith("rigid")) a.ctx.error(`${a.fname}(): ${v.fields.name} is a pattern of ${v.fields.count}; mate one of them by naming it on its own, or fasten the pattern with rigid(${v.fields.name}, …)`);
    return v.fields.name;
  }
  return a.ctx.error(`${a.fname}(): ${what} should be a part or component, got ${v === undefined ? "nothing" : typeName(v)}`);
}

function dirArg(a: Args, name: string): V3 | undefined {
  if (!a.has(name)) return undefined;
  const d = a.vec3(name);
  const l = Math.hypot(...d);
  if (!(l > 1e-12)) a.ctx.error(`${a.fname}(): ${name}: should be a direction like +Z or (1, 0, 0)`);
  return clean([d[0] / l, d[1] / l, d[2] / l]);
}

function refOf(v: Value | undefined, a: Args, which: string): MateRefV {
  if (v instanceof MateRefV) return v;
  if (v instanceof Ref || (v instanceof Obj && v.kind === "component")) {
    const b = bodyName(v, a, which);
    return a.ctx.error(`${a.fname}(): say which of ${b}'s faces or holes it holds by, like face(${b}, -Z) or axis(${b}, d: 5)`);
  }
  return a.ctx.error(`${a.fname}(): the ${which} should be a face(), axis(), point() or plane() of a part, got ${v === undefined ? "nothing" : typeName(v)}`);
}

const fn = (name: string, params: string[], doc: string, impl: (a: Args) => Value): [string, Fn] => [name, new Fn(name, (pos, named, ctx) => impl(new Args(name, pos, named, ctx, params)), doc)];

/** A mate kind's function: two references, then what it holds. */
function mateFn(kind: MateKind, params: string[], doc: string, more?: (a: Args) => { value?: number; min?: number; max?: number }): [string, Fn] {
  return fn(kind, ["a", "b", ...params], doc, (a) => {
    const ra = kind === "rigid" ? bodyRef(a.raw("a"), a, "first part") : refOf(a.raw("a"), a, "first argument");
    const rb = kind === "rigid" ? bodyRef(a.raw("b"), a, "second part") : refOf(a.raw("b"), a, "second argument");
    if (ra.ref.body === rb.ref.body) a.ctx.error(`${kind}(): a mate joins two different parts; both are ${ra.ref.body}`);
    const m = more?.(a) ?? {};
    return new MateV(kind, ra, rb, m.value, m.min, m.max);
  });
}

function bodyRef(v: Value | undefined, a: Args, what: string): MateRefV {
  if (v instanceof MateRefV) return new MateRefV({ t: "body", body: v.ref.body }, v.ref.body);
  const b = bodyName(v, a, what);
  return new MateRefV({ t: "body", body: b }, b);
}

/** limits: min:/max: (an angle in degrees becomes radians) */
function ranged(a: Args, value: string, angle: boolean): { value?: number; min?: number; max?: number } {
  const k = angle ? Math.PI / 180 : 1;
  const v = a.has(value) ? a.num(value) * k : undefined;
  const min = a.has("min") ? a.num("min") * k : undefined;
  const max = a.has("max") ? a.num("max") * k : undefined;
  if (v !== undefined && (min !== undefined || max !== undefined)) a.ctx.error(`${a.fname}(): give the ${angle ? "angle" : "distance"} it holds, or min: and max: for a range it is free in, not both`);
  if (v === undefined && min === undefined && max === undefined) a.ctx.error(`${a.fname}(): give the ${angle ? "angle, like angle(a, b, 30deg)" : "distance, like distance(a, b, 5mm)"}, or min: and max: for a range it is free in`);
  if (min !== undefined && max !== undefined && min > max) a.ctx.error(`${a.fname}(): min: is more than max:`);
  if (!angle && v !== undefined && v < 0) a.ctx.error(`${a.fname}(): a distance is 0 or more`);
  return { value: v, min, max };
}

export const MATE_FNS: Record<string, Fn> = Object.fromEntries([
  fn("face", ["part", "dir", "near"], "face(part, -Z) → in a mate, the part's flat face facing that way (the one farthest out that way); near: (x, y, z) takes the face nearest that point (where the part is drawn) instead, facing dir if given.", (a) => {
    const body = bodyName(a.raw("part"), a, "the part");
    const dir = dirArg(a, "dir");
    const near = a.has("near") ? a.vec3("near") : undefined;
    if (!dir && !near) a.ctx.error(`face(): say which face, like face(${body}, -Z), or near: a point on it`);
    return new MateRefV({ t: "face", body, ...(dir ? { dir } : {}), ...(near ? { near } : {}) }, `face(${body}${dir ? `, ${dirName(dir)}` : ""}${near ? `, near: ${fmt(near)}` : ""})`);
  }),
  fn("axis", ["part", "d", "near", "along", "at", "dir"], "axis(part, d: 5) → in a mate, the axis of a round face of the part (a hole, shaft, boss or round edge): d: its diameter, near: a point by it, along: its direction, whichever tell it apart; or axis(part, at: (x, y, z), dir: Z) for a line fixed to the part where it is drawn.", (a) => {
    const body = bodyName(a.raw("part"), a, "the part");
    if (a.has("at") || a.has("dir")) {
      if (!a.has("at") || !a.has("dir")) a.ctx.error("axis(): a line fixed to the part needs both at: (a point on it) and dir: (its direction)");
      const at = a.vec3("at");
      const dir = dirArg(a, "dir")!;
      return new MateRefV({ t: "line", body, at, dir }, `axis(${body}, at: ${fmt(at)}, dir: ${dirName(dir)})`);
    }
    const d = a.has("d") ? a.positive("d") : undefined;
    const near = a.has("near") ? a.vec3("near") : undefined;
    const along = dirArg(a, "along");
    const bits = [d !== undefined ? `d: ${+d.toFixed(3)}` : "", near ? `near: ${fmt(near)}` : "", along ? `along: ${dirName(along)}` : ""].filter(Boolean);
    return new MateRefV({ t: "axis", body, ...(d !== undefined ? { d } : {}), ...(near ? { near } : {}), ...(along ? { along } : {}) }, `axis(${body}${bits.length ? `, ${bits.join(", ")}` : ""})`);
  }),
  fn("point", ["part", "at"], "point(part, (x, y, z)) → in a mate, a point fixed to the part (where it is drawn): a ball joint's centre, a corner, a pin's tip.", (a) => {
    const body = bodyName(a.raw("part"), a, "the part");
    const p = a.vec3("at");
    return new MateRefV({ t: "point", body, p }, `point(${body}, ${fmt(p)})`);
  }),
  fn("plane", ["part", "at", "normal"], "plane(part, at: (x, y, z), normal: +Z) → in a mate, a plane fixed to the part (where it is drawn), for a face the part does not have: a centre plane, a datum.", (a) => {
    const body = bodyName(a.raw("part"), a, "the part");
    const at = a.vec3("at");
    const normal = dirArg(a, "normal");
    if (!normal) a.ctx.error("plane(): needs normal: (the way it faces), like normal: +Z");
    return new MateRefV({ t: "plane", body, at, normal: normal! }, `plane(${body}, at: ${fmt(at)}, normal: ${dirName(normal!)})`);
  }),
  mateFn("against", ["gap"], "against(face(lid, -Z), face(box, +Z), gap: 0) → the first part's face sits on the second's, facing it (gap: leaves a space). The first part moves; the second stays.", (a) => ({ value: a.has("gap") ? a.num("gap") : 0 })),
  mateFn("flush", ["offset"], "flush(face(lid, +X), face(box, +X), offset: 0) → the two faces level with each other, facing the same way (offset: steps it out along the face).", (a) => ({ value: a.has("offset") ? a.num("offset") : 0 })),
  mateFn("concentric", [], "concentric(axis(pin), axis(base, d: 5)) → the two axes in line: a pin in a hole, a shaft in a bearing. It can still turn and slide along it unless other mates hold it."),
  mateFn("pin", ["offset"], "pin(axis(pin), axis(base, d: 5), offset: 0) → in line and centred along each other (the middles of the two round faces level; offset: moves it along): a hinge pin, an axle, a shaft in a bearing. It can still turn."),
  mateFn("parallel", [], "parallel(a, b) → two faces or axes the same way (either facing)."),
  mateFn("perpendicular", [], "perpendicular(a, b) → two faces or axes square to each other (an axis and a face: the axis along the face's normal)."),
  mateFn("angle", ["angle", "min", "max"], "angle(face(lid, +Z), face(box, +Z), 30deg) → the faces (or axes) at this angle; min: 0deg, max: 110deg instead lets it move between them (a lid's hinge stops).", (a) => ranged(a, "angle", true)),
  mateFn("distance", ["d", "min", "max"], "distance(face(slide, -X), face(rail, -X), 40mm) → this far apart (faces kept parallel; points, axes and faces in any mix); min:/max: instead lets it move between them (a slide's travel).", (a) => ranged(a, "d", false)),
  mateFn("tangent", [], "tangent(face(belt, +Z), axis(roller)) → a flat face touching a round one (or two round ones touching), on the side they are drawn."),
  mateFn("coincident", [], "coincident(point(rod, (0, 0, 40)), point(arm, (0, 0, 40))) → points together (a ball joint), a point on a face or an axis, or two faces or axes in one plane or line."),
  mateFn("rigid", [], "rigid(screws, lid) → the first part moves with the second as drawn (its screws, a part glued to it): whatever moves the second moves it too."),
]);

export const MATE_KINDS = ["against", "flush", "concentric", "pin", "parallel", "perpendicular", "angle", "distance", "tangent", "coincident", "rigid"] as const;
