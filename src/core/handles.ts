// Drag handles on a part, as in SolidWorks' Instant3D or Fusion's arrows:
// the sizes of the part's body that can be pulled straight from the model (a
// box's width, depth and height, a cylinder's diameter and length, an
// extrusion's length), each with where its arrow sits, which way it pulls
// and how the source changes when it moves. A size written as a number is
// rewritten in place; one given by a parameter moves the parameter (and so
// everything else that uses it). A size worked out from an expression is
// shown but not dragged. Nothing here touches the view: positions are in the
// part's own coordinates.

import type { EvalParam, EvalPart, Model } from "./model";
import { partSteps, type StepField } from "./features";
import type { Profile, ShapeRecipe, V2, V3 } from "../kernel/recipe";
import { setParamValue } from "./sourceEdit";
import { fmtNum } from "../lang/values";

export interface SizeHandle {
  /** stable within the part: "body:h" */
  key: string;
  /** the argument as written (w, d, h, r, od, depth…) */
  label: string;
  /** in words, for tips and history: "width" */
  name: string;
  value: number;
  /** where the arrow starts (on the face it pulls) and the way it points, in the part's own coordinates */
  at: V3;
  dir: V3;
  /** how much the value changes for each mm the face moves (2 for a size that grows both ways, such as a centred box's width) */
  rate: number;
  /** for a size that grows both ways, the arrow's place on the other side (pointing the other way), for when that side faces the viewer */
  back?: V3;
  min: number;
  max?: number;
  /** the source with a new value written in; null when the size is worked out from an expression */
  write: ((src: string, v: number) => string) | null;
  /** the parameter the size comes from, when it is one */
  via?: string;
  /** why it can't be dragged */
  why?: string;
  /** the argument in the source */
  field: StepField;
}

const NAMES: Record<string, string> = { w: "width", d: "diameter", h: "height", r: "radius", od: "outside diameter", d1: "base diameter", d2: "top diameter", depth: "depth" };

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** a direction across an axis: X for an upright one, else level and square to it */
const across = (dir: V3): V3 => (Math.abs(dir[2]) > 0.99 ? [1, 0, 0] : unit(cross([0, 0, 1], dir)));

/** Roughly the middle of a 2D profile (for where an extrusion's arrow sits). */
export function profileCentre(p: Profile): V2 {
  const mean = (pts: V2[]): V2 => (pts.length ? [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length] : [0, 0]);
  switch (p.t) {
    case "circle":
    case "ellipse":
    case "rect":
    case "text":
      return p.c;
    case "poly":
      return mean(p.pts);
    case "path2":
      return mean([p.start, ...p.segs.map((s) => s.to)]);
    case "offset":
    case "fillet2":
      return profileCentre(p.p);
    case "union2":
      return mean(p.ps.map(profileCentre));
    case "diff2":
      return profileCentre(p.a);
    case "common2":
      return profileCentre(p.a);
    case "place2": {
      const [x, y] = profileCentre(p.p);
      const a = (p.rot * Math.PI) / 180;
      return [x * Math.cos(a) - y * Math.sin(a) + p.by[0], x * Math.sin(a) + y * Math.cos(a) + p.by[1]];
    }
  }
}

const LITERAL = /^(\s*)(\d+(?:\.\d+)?)(\s*mm)?(\s*)$/;

/** How a field's value is written: in place when it is a plain number, through its parameter when it is one. */
function writerFor(field: StepField, model: Model): Pick<SizeHandle, "write" | "via" | "why" | "min" | "max"> {
  const lit = LITERAL.exec(field.text);
  if (lit) {
    const [, lead, , mm = "", tail] = lit;
    return { min: 0.1, write: (src, v) => src.slice(0, field.span.start) + `${lead}${fmtNum(v, 3)}${mm}${tail}` + src.slice(field.span.end) };
  }
  const name = field.text.trim();
  if (/^[A-Za-z_]\w*$/.test(name)) {
    const p: EvalParam | undefined = model.params.find((q) => q.name === name);
    if (p && typeof p.value === "number") {
      if (p.locked) return { min: 0.1, write: null, via: name, why: `${name} is locked` };
      return { min: Math.max(0.1, p.min ?? 0.1), max: p.max, via: name, write: (src, v) => setParamValue(src, p, v) };
    }
  }
  return { min: 0.1, write: null, why: `worked out from ${name}: change it in the design file` };
}

/**
 * The sizes of a part's body that can be dragged from the model, with their
 * arrows. Empty for bought parts, locked parts and bodies that are not one of
 * the plain shapes (a union, a sweep, a loft, an imported body).
 */
export function sizeHandles(src: string, model: Model, part: EvalPart): SizeHandle[] {
  if (part.kind !== "part" || part.locked) return [];
  const base = part.recipe.base;
  const ps = partSteps(src, part.name);
  const body = ps?.steps.find((s) => s.kind === "body" && !s.suppressed);
  if (!base || !body) return [];
  const field = (label: string) => body.fields.find((f) => f.label === label && !f.of);
  const out: SizeHandle[] = [];
  const push = (label: string, value: number, at: V3, dir: V3, rate: number, back?: V3) => {
    const f = field(label);
    if (!f) return;
    out.push({ key: `body:${label}`, label, name: NAMES[label] ?? label, value, at, dir: unit(dir), rate, back, field: f, ...writerFor(f, model) });
  };
  const fn = body.fn;
  const s: ShapeRecipe = base;
  if (fn === "box" && s.t === "box") {
    const centred = field("center")?.text.trim() === "true";
    const mid: V3 = [s.at[0], s.at[1], s.at[2] + s.h / 2];
    push("w", s.w, add(mid, [s.w / 2, 0, 0]), [1, 0, 0], 2, add(mid, [-s.w / 2, 0, 0]));
    push("d", s.d, add(mid, [0, s.d / 2, 0]), [0, 1, 0], 2, add(mid, [0, -s.d / 2, 0]));
    push("h", s.h, add(s.at, [0, 0, s.h]), [0, 0, 1], centred ? 2 : 1, centred ? s.at : undefined);
  } else if (fn === "cylinder" && s.t === "cyl") {
    const side = across(s.dir);
    const mid = add(s.at, s.dir, s.h / 2);
    if (field("r")) push("r", s.d / 2, add(mid, side, s.d / 2), side, 1, add(mid, side, -s.d / 2));
    else push("d", s.d, add(mid, side, s.d / 2), side, 2, add(mid, side, -s.d / 2));
    push("h", s.h, add(s.at, s.dir, s.h), s.dir, 1);
  } else if (fn === "tube" && s.t === "tube") {
    const side = across(s.dir);
    const mid = add(s.at, s.dir, s.h / 2);
    push("od", s.od, add(mid, side, s.od / 2), side, 2, add(mid, side, -s.od / 2));
    push("h", s.h, add(s.at, s.dir, s.h), s.dir, 1);
  } else if (fn === "cone" && s.t === "cone") {
    const side = across(s.dir);
    push("h", s.h, add(s.at, s.dir, s.h), s.dir, 1);
    const top = add(s.at, s.dir, s.h);
    if (s.d1 > 0) push("d1", s.d1, add(s.at, side, s.d1 / 2), side, 2, add(s.at, side, -s.d1 / 2));
    if (s.d2 > 0) push("d2", s.d2, add(top, side, s.d2 / 2), side, 2, add(top, side, -s.d2 / 2));
  } else if (fn === "sphere" && s.t === "sphere") {
    push("d", s.d, add(s.at, [s.d / 2, 0, 0]), [1, 0, 0], 2, add(s.at, [-s.d / 2, 0, 0]));
  } else if (fn === "prism" && s.t === "prism") {
    const c = s.pts.length ? [s.pts.reduce((a, q) => a + q[0], 0) / s.pts.length, s.pts.reduce((a, q) => a + q[1], 0) / s.pts.length] : [0, 0];
    const r = (s.rot * Math.PI) / 180;
    const cu = c[0] * Math.cos(r) - c[1] * Math.sin(r);
    const cv = c[0] * Math.sin(r) + c[1] * Math.cos(r);
    const flat = Math.abs(s.dir[2]) > 0.99;
    const u: V3 = flat ? [1, 0, 0] : unit(cross([0, 0, 1], s.dir));
    const v: V3 = flat ? [0, 1, 0] : [0, 0, 1];
    push("h", s.h, add(add(add(s.at, u, cu), v, cv), s.dir, s.h), s.dir, 1);
  } else if ((fn === "rrect" || fn === "slot") && s.t === "rrect") {
    push("depth", s.depth, add(s.at, s.dir, s.center ? s.depth / 2 : s.depth), s.dir, s.center ? 2 : 1, s.center ? add(s.at, s.dir, -s.depth / 2) : undefined);
  } else if (fn === "extrude" && s.t === "extrude" && !s.until && !s.taper && s.h > 0) {
    const [x, y] = profileCentre(s.p);
    const v = cross(s.f.n, s.f.u);
    push("h", s.h, add(add(add(s.f.o, s.f.u, x), v, y), s.f.n, s.h), s.f.n, 1);
  } else if (fn === "extrude" && s.t === "sk_extrude" && s.h > 0) {
    const pts: V2[] = [];
    for (const r of s.regions)
      for (const g of r.outer) {
        if (g.k === "c" || g.k === "e") pts.push(g.c);
        else pts.push(g.a, g.b);
      }
    const x = pts.length ? pts.reduce((a, q) => a + q[0], 0) / pts.length : 0;
    const y = pts.length ? pts.reduce((a, q) => a + q[1], 0) / pts.length : 0;
    const v = cross(s.n, s.u);
    push("h", s.h, add(add(add(s.o, s.u, x), v, y), s.n, s.start + s.h), s.n, 1);
  }
  return out;
}

/** The value a handle takes when its face has moved `by` mm: snapped to `step`, kept within its limits. */
export function draggedValue(h: SizeHandle, from: number, by: number, step: number): number {
  let v = from + by * h.rate;
  if (step > 0) v = Math.round(v / step) * step;
  v = Math.max(h.min, v);
  if (h.max !== undefined) v = Math.min(h.max, v);
  return Math.round(v * 1e6) / 1e6;
}
