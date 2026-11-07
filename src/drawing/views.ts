// Which parts a drawing shows, which views it has and the projection request
// for each view. Pure: the engine sends the requests to the kernel and the
// composer lays out whatever has come back.

import type { EvalPart, Model } from "../core/model";
import type { ProjItem, ViewRequest } from "../kernel/drawing";
import { applyXforms, applyXformsToDir, recipeHash, vcross, vdot, vnorm, type ShapeRecipe, type V3, type Xform } from "../kernel/recipe";
import type { Frame } from "./sheet";
import type { Span } from "../lang/ast";
import { partFeatures, probeSegments, recipeSpan, shellOpenDir, type Extent, type Feature } from "./features";
import { defaultSpec, type AuxSpec, type BreakSpec, type CutawaySpec, type DetailSpec, type DrawingSpec, type SectionSpec, type ViewKind } from "./spec";
import { generalToleranceFor } from "../mfg/profiles";
import { layFlat } from "./flat";
import { gdtWanted } from "./gdt";
import { processFamily } from "./intent";
import { squareUp } from "./square";
import { copiesOf, sharedName, type MeshOf } from "./copies";

const N = 1 / Math.sqrt(3);

export function viewFrame(kind: ViewKind): Frame {
  const f = (dir: V3, x: V3): Frame => ({ dir, x, y: vcross(dir, x) });
  switch (kind) {
    case "front":
      return f([0, -1, 0], [1, 0, 0]);
    case "back":
      return f([0, 1, 0], [-1, 0, 0]);
    case "top":
      return f([0, 0, 1], [1, 0, 0]);
    case "bottom":
      return f([0, 0, -1], [1, 0, 0]);
    case "right":
      return f([1, 0, 0], [0, 1, 0]);
    case "left":
      return f([-1, 0, 0], [0, -1, 0]);
    case "iso": {
      const dir: V3 = [N, -N, N];
      const x = vnorm(vcross([0, 0, 1], dir));
      return f(dir, x);
    }
  }
}

/** Frame of a section view: it looks against the plane normal at the material behind the plane. */
export function sectionFrame(normal: V3): Frame {
  const n = vnorm(normal);
  const x: V3 = Math.abs(n[2]) > 0.999 ? [1, 0, 0] : vnorm(vcross([0, 0, 1], n));
  return { dir: n, x, y: vcross(n, x) };
}

export const toView = (p: V3, f: Frame): [number, number] => [vdot(p, f.x), vdot(p, f.y)];

/** Parts that are never sectioned: fasteners, pins and shafts (ISO 128-50). */
export function isUncut(p: EvalPart): boolean {
  if (p.libKind && ["screw", "nut", "dowel", "insert", "bearing", "nema17", "usb_c", "connector"].includes(p.libKind)) return true;
  return p.recipe.base?.t === "revolve";
}

export interface PlannedView {
  kind: ViewKind | "section" | "detail" | "aux";
  name: string;
  frame: Frame;
  /** projection request and its cache key; details share their parent's */
  req: ViewRequest;
  key: string;
  scale?: number;
  at?: [number, number];
  label?: string;
  section?: SectionSpec;
  detail?: DetailSpec;
  /** index of the view a detail enlarges or a section's cutting line is drawn on */
  parent?: number;
  span?: Span;
  /** drawn by convention instead of projected (the side view of a gear, ISO 2203) */
  synthetic?: "gear";
  aux?: AuxSpec;
  /** a crop view's model box */
  crop?: [V3, V3];
  /** an exploded view's spread and the world box of its moved parts */
  exploded?: { f: number; box: [V3, V3] };
  /** broken-out sections in this view (the request carries their planes) */
  cutaways?: CutawaySpec[];
}

export interface DrawingPlan {
  spec: DrawingSpec;
  parts: EvalPart[];
  assembly: boolean;
  views: PlannedView[];
  /** world bounding box of the shown parts */
  bbox: [V3, V3];
  errors: string[];
  /** the view whose projection also measures the probe lines, and the feature each line belongs to */
  probes?: { view: number; segs: { i: number }[] };
  /** stretches taken out of long views, written or chosen by Kerf */
  breaks: BreakSpec[];
}

export type BBoxOf = (p: EvalPart) => [V3, V3] | undefined;

/** World-space box of a part from its local box and placement. */
export function worldBox(p: EvalPart, local: [V3, V3]): [V3, V3] {
  const [a, b] = local;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = applyXforms([i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]], p.xf);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], c[k]);
      hi[k] = Math.max(hi[k], c[k]);
    }
  }
  return [lo, hi];
}

/** Parts a drawing shows: named parts and components (all instances), or the whole visible design; a flat-pattern drawing shows its sheet-metal parts laid flat. */
export function drawingParts(spec: DrawingSpec, model: Model): EvalPart[] {
  if (spec.flat) {
    const seen = new Set<string>();
    return layFlat(model.parts.filter((p) => p.sheet && (spec.of.length ? spec.of.includes(p.name) : !p.hidden) && !seen.has(p.name) && seen.add(p.name)));
  }
  if (!spec.of.length) return model.parts.filter((p) => !p.hidden);
  const names = new Set(spec.of);
  const parts = model.parts.filter((p) => names.has(p.name));
  if (spec.of.length !== 1) return parts;
  // a drawing of one part shows a single instance of it, square to its own axes
  const first = parts[0]?.id.split(".")[0];
  const one = parts.filter((p) => p.id.split(".")[0] === first);
  return one.length === 1 ? [squareUp(one[0])] : one;
}

/** Corners of a box projected into a view: [u0, v0, u1, v1]. */
export function boxExtents(box: [V3, V3], f: Frame): [number, number, number, number] {
  const e: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const [a, b] = box;
  for (let i = 0; i < 8; i++) {
    const [u, v] = toView([i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]], f);
    e[0] = Math.min(e[0], u);
    e[1] = Math.min(e[1], v);
    e[2] = Math.max(e[2], u);
    e[3] = Math.max(e[3], v);
  }
  return e;
}

export function planDrawing(spec: DrawingSpec, model: Model, bboxOf: BBoxOf): DrawingPlan {
  const parts = drawingParts(spec, model);
  // a block that names one part and no views gets the views that part needs
  if (spec.viewsAuto && !spec.auto && !spec.flat && spec.of.length === 1 && parts.length && new Set(parts.map((p) => p.id.split(".")[0])).size === 1) spec = { ...spec, views: autoViews(parts[0]).map((kind) => ({ kind })) };
  const errors: string[] = [];
  const instances = new Set(parts.map((p) => p.id.split(".")[0]));
  const assembly = instances.size > 1;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const local = bboxOf(p);
    if (!local) continue;
    const [a, b] = worldBox(p, local);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
  }
  const bbox: [V3, V3] = Number.isFinite(lo[0]) ? [lo, hi] : [[-10, -10, -10], [10, 10, 10]];
  const items: ProjItem[] = parts.map((p) => ({ id: p.id, hash: p.hash, xf: p.xf, cut: !isUncut(p) }));
  const hiddenDefault = spec.hidden ?? !assembly;

  const views: PlannedView[] = [];
  const add = (v: Omit<PlannedView, "key">) => {
    const key = recipeHash({ i: recipeHash(v.req.items), d: v.req.dir, x: v.req.x, s: v.req.section ?? null, h: v.req.hidden, c: v.req.cutaways ?? null });
    views.push({ ...v, key });
  };
  const seen = new Set<string>();
  for (const vs of spec.views) {
    const id = vs.kind + (vs.label ?? "") + (vs.crop ? "crop" : "") + (vs.exploded ? "exploded" : "");
    if (seen.has(id)) continue;
    seen.add(id);
    const frame = viewFrame(vs.kind);
    const hidden = vs.hidden ?? (vs.kind === "iso" || vs.exploded ? false : hiddenDefault);
    const gear = parts.length === 1 && parts[0].gear ? vnorm(parts[0].gear.axis) : null;
    const synthetic = gear && vs.kind !== "iso" && Math.abs(vdot(frame.dir, gear)) < 1e-6 ? ("gear" as const) : undefined;
    const ex = vs.exploded && parts.length > 1 ? explode(parts, bboxOf, vs.exploded) : null;
    add({ kind: vs.kind, name: vs.kind, frame, req: { dir: frame.dir, x: frame.x, items: ex?.items ?? items, hidden }, scale: vs.scale, at: vs.at, label: vs.label, synthetic, crop: vs.crop, exploded: ex ? { f: vs.exploded!, box: ex.box } : undefined });
  }
  for (const s of spec.sections) {
    const frame = sectionFrame(s.normal);
    let parent = s.view ? views.findIndex((v) => v.kind === s.view) : -1;
    // the cutting line goes on a view that sees the plane edge-on
    if (parent < 0) parent = views.findIndex((v) => v.kind !== "iso" && v.kind !== "section" && Math.abs(vdot(v.frame.dir, vnorm(s.normal))) < 1e-6);
    add({
      kind: "section",
      name: s.label,
      frame,
      req: { dir: frame.dir, x: frame.x, items, hidden: false, section: { at: s.at, normal: s.normal } },
      scale: s.scale,
      at: s.at2,
      section: s,
      parent: parent >= 0 ? parent : undefined,
    });
  }
  // auxiliary views: square onto an inclined face, with an arrow on a view that sees the face edge-on
  const aux = [...spec.aux];
  if (spec.viewsAuto && !spec.auto && !assembly && parts.length === 1 && !aux.length) {
    const local = bboxOf(parts[0]);
    aux.push(...autoAux(parts[0], usedLetters(spec), gdtWanted(spec, processFamily(parts[0])) ? "D" : "A", local ? worldBox(parts[0], local) : undefined));
  }
  for (const a of aux) {
    const frame = sectionFrame(a.normal);
    let parent = a.view ? views.findIndex((v) => v.kind === a.view) : -1;
    // a principal view (or a section standing in for one) that sees the face edge-on
    const edgeOn = (v: PlannedView) => Math.abs(vdot(v.frame.dir, vnorm(a.normal))) < 1e-3;
    if (parent < 0) parent = views.findIndex((v) => PRINCIPAL_KINDS.includes(v.kind) && edgeOn(v));
    if (parent < 0) parent = views.findIndex((v) => v.kind === "section" && edgeOn(v));
    if (parent < 0) parent = views.findIndex((v) => PRINCIPAL_KINDS.includes(v.kind));
    add({ kind: "aux", name: a.label, frame, req: { dir: frame.dir, x: frame.x, items, hidden: hiddenDefault }, scale: a.scale, at: a.at2, aux: a, crop: a.crop, parent: parent >= 0 ? parent : undefined });
  }
  for (const d of spec.details) {
    const parent = views.findIndex((v) => v.name === d.view || (v.kind === "section" && v.name === d.view));
    if (parent < 0) {
      errors.push(`Detail ${d.label}: there is no "${d.view}" view to enlarge`);
      continue;
    }
    const pv = views[parent];
    views.push({ kind: "detail", name: d.label, frame: pv.frame, req: pv.req, key: pv.key, scale: d.scale, detail: d, parent });
  }
  // broken-out sections: the view's projection also cuts away what lies in front of each point
  for (const c of spec.cutaways) {
    const k = views.findIndex((v) => v.kind !== "detail" && v.kind !== "iso" && (v.name === c.view || v.kind === c.view));
    if (k < 0) {
      errors.push(`Broken-out section: there is no "${c.view}" view to cut into`);
      continue;
    }
    const v = views[k];
    const cutaways = [...(v.cutaways ?? []), c];
    const req = { ...v.req, cutaways: cutaways.map((x) => ({ at: x.at, normal: v.frame.dir })) };
    const key = recipeHash({ k: v.key, c: req.cutaways });
    views[k] = { ...v, req, key, cutaways };
    views.forEach((d, j) => d.kind === "detail" && d.parent === k && (views[j] = { ...d, req, key }));
  }

  // a single part's cuts are probed for through or blind along with its first projected view
  let probes: DrawingPlan["probes"];
  const pi = views.findIndex((v) => !v.synthetic && v.kind !== "detail");
  if (!assembly && parts.length && pi >= 0) {
    const segs = probeSegments(partFeatures(parts[0], partExtent(parts[0], bboxOf)), partExtent(parts[0], bboxOf));
    if (segs.length) {
      const v = views[pi];
      const req = { ...v.req, probes: segs.map(({ a, b }) => ({ a, b })) };
      const key = recipeHash({ k: v.key, p: req.probes });
      views[pi] = { ...v, req, key };
      // details of that view share its projection
      views.forEach((d, k) => d.kind === "detail" && d.parent === pi && (views[k] = { ...d, req, key }));
      probes = { view: pi, segs };
    }
  }
  // long plain parts lose their featureless middle so they can be drawn bigger
  const breaks = spec.breaks.length ? spec.breaks : spec.autoBreak !== false && !assembly && !spec.flat && parts.length === 1 ? autoBreaks(parts[0], bboxOf) : [];
  return { spec, parts, assembly, views, bbox, errors, probes, breaks };
}

const PRINCIPAL_KINDS: string[] = ["front", "top", "right", "left", "back", "bottom"];

/** Letters the drawing already uses for sections, details and auxiliary views. */
function usedLetters(spec: DrawingSpec): Set<string> {
  return new Set([...spec.sections.map((s) => s.label), ...spec.details.map((d) => d.label), ...spec.aux.map((a) => a.label)].map((l) => l.toUpperCase()));
}

/**
 * Auxiliary views a part needs: one square onto each direction its holes,
 * bores and slots are drilled along when that is not a principal axis but is
 * square to one (so a principal view sees the face edge-on), at most two.
 */
export function autoAux(p: EvalPart, used: Set<string>, first = "A", box?: [V3, V3]): AuxSpec[] {
  if (p.kind !== "part" || p.gear || p.sheet) return [];
  const dirs: { n: V3; at: V3; feats: Feature[] }[] = [];
  for (const f of partFeatures(p)) {
    if (!(f.t === "hole" || f.t === "slot" || (f.t === "cyl" && f.op === "cut"))) continue;
    // a cut points into the material; the face it opens looks the other way
    const n = vnorm([-f.dir[0], -f.dir[1], -f.dir[2]]);
    const big = Math.max(...n.map(Math.abs));
    if (big > 0.999) continue;
    // seen edge-on in a principal view: one component is zero
    if (!n.some((c) => Math.abs(c) < 1e-3)) continue;
    const same = dirs.find((d) => vdot(d.n, n) > 0.9995);
    if (same) same.feats.push(f);
    else dirs.push({ n, at: f.at, feats: [f] });
  }
  const out: AuxSpec[] = [];
  let code = first.charCodeAt(0);
  for (const d of dirs.sort((a, b) => b.feats.length - a.feats.length).slice(0, 2)) {
    while (used.has(String.fromCharCode(code)) || "IOQ".includes(String.fromCharCode(code))) code++;
    const label = String.fromCharCode(code++);
    const normal = d.n.map((c) => Math.round(c * 1e6) / 1e6) as V3;
    out.push({ label, normal, at: d.at, crop: auxCrop(p, normal, d.feats, box) });
  }
  return out;
}

/**
 * A partial auxiliary view's box: the angled features and a margin round
 * them, when the part is much bigger than they are (a clamp bore on a
 * handlebar). A part about their size, or small anyway, is drawn whole.
 */
function auxCrop(p: EvalPart, normal: V3, feats: Feature[], box?: [V3, V3]): [V3, V3] | undefined {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const f of feats) {
    if (!("at" in f) || !("dir" in f)) continue;
    const size = "d" in f ? (f.t === "hole" && f.cbore ? Math.max(f.d, f.cbore[0]) : f.d) : f.t === "slot" ? Math.max(f.w, f.h) : 0;
    const depth = f.t === "cyl" ? f.h : "depth" in f ? f.depth : 0;
    const pad = 0.75 * size + 4;
    for (const t of [0, Math.min(depth, 4 * size)]) for (let k = 0; k < 3; k++) {
      const c = f.at[k] + f.dir[k] * t;
      lo[k] = Math.min(lo[k], c - pad);
      hi[k] = Math.max(hi[k], c + pad);
    }
  }
  if (!Number.isFinite(lo[0])) return undefined;
  const frame = sectionFrame(normal);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i): V3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
  const span = (pts: V3[], axis: V3) => {
    const ds = pts.map((c) => vdot(c, axis));
    return Math.max(...ds) - Math.min(...ds);
  };
  for (const axis of [frame.x, frame.y]) {
    // the recipe's own span where it can tell, else the built part's box
    const r = recipeSpan(p, axis);
    const whole = r ? r[1] - r[0] : box ? span([0, 1, 2, 3, 4, 5, 6, 7].map((i): V3 => [box[i & 1][0], box[(i >> 1) & 1][1], box[(i >> 2) & 1][2]]), axis) : undefined;
    if (!whole) return undefined;
    // worth cropping only when a big part runs well past the features
    if (whole >= 100 && span(corners, axis) < whole / 3) return [lo, hi];
  }
  return undefined;
}

/** Item placements for an exploded view: the parts spread out from the middle of the assembly, each moved by its distance from the middle and a little more, so stacked parts come apart. */
function explode(parts: EvalPart[], bboxOf: BBoxOf, f: number): { items: ProjItem[]; box: [V3, V3] } {
  const boxes = parts.map((p) => {
    const local = bboxOf(p);
    return local ? worldBox(p, local) : null;
  });
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) if (b) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], b[0][k])), (hi[k] = Math.max(hi[k], b[1][k]));
  const bc: V3 = [0, 1, 2].map((k) => (Number.isFinite(lo[k]) ? (lo[k] + hi[k]) / 2 : 0)) as V3;
  const size = Number.isFinite(lo[0]) ? Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 1;
  const out: ProjItem[] = [];
  const blo: V3 = [Infinity, Infinity, Infinity];
  const bhi: V3 = [-Infinity, -Infinity, -Infinity];
  parts.forEach((p, i) => {
    const b = boxes[i];
    const c: V3 = b ? [0, 1, 2].map((k) => (b[0][k] + b[1][k]) / 2) as V3 : bc;
    let d: V3 = [c[0] - bc[0], c[1] - bc[1], c[2] - bc[2]];
    const dist = Math.hypot(...d);
    d = dist < 1e-6 ? [0, 0, 1] : [d[0] / dist, d[1] / dist, d[2] / dist];
    const m = f * (1.5 * dist + 0.15 * size);
    const v: V3 = [d[0] * m, d[1] * m, d[2] * m];
    out.push({ id: p.id, hash: p.hash, xf: [...p.xf, { op: "translate", v }], cut: !isUncut(p) });
    if (b) for (let k = 0; k < 3; k++) (blo[k] = Math.min(blo[k], b[0][k] + v[k])), (bhi[k] = Math.max(bhi[k], b[1][k] + v[k]));
  });
  return { items: out, box: Number.isFinite(blo[0]) ? [blo, bhi] : [lo, hi] };
}

/**
 * Breaks for a long, plain part (a shaft, rail, tube or bar): along its long
 * axis, the stretches with nothing on them are taken out, keeping some plain
 * length beside each feature and end. Only for shapes whose section is known
 * to stay the same between features; none when it is not long enough to gain.
 */
export function autoBreaks(p: EvalPart, bboxOf: BBoxOf): BreakSpec[] {
  if (p.kind !== "part" || p.gear || p.sheet || !p.recipe.base) return [];
  const local = bboxOf(p);
  if (!local) return [];
  const [lo, hi] = worldBox(p, local);
  const ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const axis = ext.indexOf(Math.max(...ext)) as 0 | 1 | 2;
  const L = ext[axis];
  const W = Math.max(...ext.filter((_, k) => k !== axis));
  if (!(W > 0) || L < 4 * W || L < 60) return [];
  const u: V3 = [0, 0, 0];
  u[axis] = 1;
  const busy: [number, number][] = [];
  const along = (d: V3) => Math.abs(vdot(vnorm(d), u)) > 0.999;
  // the body: its section must stay the same along the axis, apart from a turned profile's steps
  const base = (s: ShapeRecipe, xf: Xform[]): boolean => {
    const dir = (d: V3) => vnorm(applyXformsToDir(applyXformsToDir(d, xf), p.xf));
    const pt = (q: V3) => applyXforms(applyXforms(q, xf), p.xf);
    switch (s.t) {
      case "xform":
        return base(s.shape, [...s.xf, ...xf]);
      case "box":
        return true;
      case "cyl":
      case "tube":
      case "prism":
      case "rrect":
        return along(dir(s.dir));
      case "revolve": {
        const a = dir(s.dir);
        if (!along(a)) return false;
        const n = vnorm(s.dir);
        const z = (zz: number) => vdot(pt([s.at[0] + n[0] * zz, s.at[1] + n[1] * zz, s.at[2] + n[2] * zz]), u);
        for (let i = 0; i < s.pts.length; i++) {
          const [r0, z0] = s.pts[i];
          const [r1, z1] = s.pts[(i + 1) % s.pts.length];
          if (r0 < 1e-9 && r1 < 1e-9) continue;
          // a step or taper in the profile is a feature; a plain cylinder is not
          if (Math.abs(r1 - r0) > 1e-6) busy.push([Math.min(z(z0), z(z1)), Math.max(z(z0), z(z1))]);
        }
        return true;
      }
      default:
        return false;
    }
  };
  if (!base(p.recipe.base, [])) return [];
  for (const o of p.recipe.ops) {
    if (o.op === "draft" || o.op === "intersect") return [];
    if (o.op !== "add" && o.op !== "cut") continue;
    const span = recipeSpan({ ...p, recipe: { base: o.shape, ops: [] } } as EvalPart, u);
    if (span) busy.push(span);
    else if (!holeSpans(p, o.shape, u, busy)) return [];
  }
  // plain length kept beside each feature and end
  const pad = Math.max(0.6 * W, 0.05 * L, 3);
  const taken = busy.map(([a, b]): [number, number] => [a - pad, b + pad]);
  taken.push([lo[axis] - 1, lo[axis] + pad], [hi[axis] - pad, hi[axis] + 1]);
  taken.sort((a, b) => a[0] - b[0]);
  const free: [number, number][] = [];
  let at = lo[axis];
  for (const [a, b] of taken) {
    if (a > at) free.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < hi[axis]) free.push([at, hi[axis]]);
  const out = free
    .filter(([a, b]) => b - a >= Math.max(0.2 * L, 2 * W))
    .sort((x, y) => y[1] - y[0] - (x[1] - x[0]))
    .slice(0, 2)
    .sort((x, y) => x[0] - y[0]);
  // not worth it unless the drawing gets noticeably shorter
  if (out.reduce((t, [a, b]) => t + b - a, 0) < 0.3 * L) return [];
  const r = (n: number) => Math.round(n * 100) / 100;
  return out.map(([a, b]) => ({ axis, from: r(a), to: r(b) }));
}

/** The stretch along u a hole (or a union of them) takes up; false for any other shape. */
function holeSpans(p: EvalPart, s: ShapeRecipe, u: V3, out: [number, number][], xf: Xform[] = []): boolean {
  if (s.t === "xform") return holeSpans(p, s.shape, u, out, [...s.xf, ...xf]);
  if (s.t === "union") return s.shapes.every((c) => holeSpans(p, c, u, out, xf));
  if (s.t !== "hole") return false;
  const at = applyXforms(applyXforms(s.at, xf), p.xf);
  const dir = vnorm(applyXformsToDir(applyXformsToDir(s.dir, xf), p.xf));
  const r = Math.max(s.d, s.cbore?.[0] ?? 0, s.csink ?? 0) / 2;
  const c = vdot(at, u);
  const reach = vdot(dir, u) * Math.min(s.depth, 1e4);
  const side = r * Math.sqrt(Math.max(0, 1 - vdot(dir, u) ** 2));
  out.push([Math.min(c, c + reach) - side, Math.max(c, c + reach) + side]);
  return true;
}

/** World-space extent of a part along a direction, from its placed bounding box. */
export function partExtent(p: EvalPart, bboxOf: BBoxOf): Extent {
  const local = bboxOf(p);
  const box = local ? worldBox(p, local) : null;
  return (dir: V3) => {
    if (!box) return [-Infinity, Infinity];
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c: V3 = [i & 1 ? box[1][0] : box[0][0], i & 2 ? box[1][1] : box[0][1], i & 4 ? box[1][2] : box[0][2]];
      const d = vdot(c, dir);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return [lo, hi];
  };
}

// ---------- automatic drawings ----------

/** Library parts that are made rather than bought get their own drawing. */
const MADE_LIB = new Set(["spur_gear"]);

/** Parts and library parts that are made, so they get a drawing; a part marked process: false is bought or on hand. */
const drawable = (p: EvalPart) => (p.kind === "part" ? !p.processNone : !!(p.libKind && MADE_LIB.has(p.libKind)));

/** Single-part drawing blocks' parts. */
function blockParts(model: Model): Set<string> {
  const out = new Set<string>();
  for (const d of model.drawings) if (!d.flat && d.of.length === 1) out.add(d.of[0]);
  return out;
}

/**
 * Made parts that are copies of another (the same solid moved, turned or renamed; see copies.ts), each mapped to the
 * part whose drawing it shares. A drawing block's part comes first, so its copies share the block's sheet.
 */
export function drawnCopies(model: Model, meshOf?: MeshOf): Map<string, string> {
  const blocks = blockParts(model);
  const byName = new Map<string, EvalPart>();
  for (const p of model.parts) if (drawable(p) && !byName.has(p.name)) byName.set(p.name, p);
  const order = [...byName.values()].sort((a, b) => Number(blocks.has(b.name)) - Number(blocks.has(a.name)));
  return copiesOf(order, meshOf);
}

/**
 * Drawings generated when the source has none for a target: the whole design, each made part, and each sheet-metal
 * part's flat pattern. Copies of a made part share one drawing, whose title says how many to make; a part marked
 * process: false is bought or already on hand and gets none.
 */
export function autoDrawings(model: Model, bboxOf?: BBoxOf, meshOf?: MeshOf, opts: { copies?: boolean } = {}): DrawingSpec[] {
  const covered = new Set<string>();
  const flatCovered = new Set<string>();
  for (const d of model.drawings) {
    if (d.flat) {
      for (const p of drawingParts(d, model)) flatCovered.add(p.name);
      continue;
    }
    if (!d.of.length) covered.add("");
    for (const n of d.of) if (d.of.length === 1) covered.add(n);
  }
  const out: DrawingSpec[] = [];
  const instances = new Set(model.parts.filter((p) => !p.hidden).map((p) => p.id.split(".")[0]));
  if (instances.size > 1 && !covered.has("")) {
    const s = defaultSpec("auto:assembly", model.name || "Assembly", []);
    s.partsList = true;
    s.balloons = true;
    out.push(s);
  }
  // copies: false gives every copy its own sheet again (the 3D annotations want one on each solid)
  const copies = opts.copies === false ? new Map<string, string>() : drawnCopies(model, meshOf);
  const firstOf = (name: string) => copies.get(name) ?? name;
  // how many of each part to make, copies and every placement counted, and the names they go by
  const made = new Map<string, { n: number; names: Set<string> }>();
  for (const p of model.parts) {
    if (!drawable(p)) continue;
    const m = made.get(firstOf(p.name)) ?? { n: 0, names: new Set<string>() };
    m.n++;
    m.names.add(humanize(p.label.replace(/ #\d+$/, "")));
    made.set(firstOf(p.name), m);
  }
  const titled = (name: string, title: string, after = "") => {
    const m = made.get(name);
    return m && m.n > 1 ? `${(m.names.size > 1 && sharedName([...m.names])) || title}${after} (make ${m.n})` : title + after;
  };
  const seen = new Set<string>();
  for (const placed of model.parts) {
    if (seen.has(placed.name) || covered.has(placed.name) || !drawable(placed) || copies.has(placed.name)) continue;
    seen.add(placed.name);
    // views and sections follow the part's own axes, as its drawing shows it
    const p = squareUp(placed);
    const s = defaultSpec(`auto:${p.name}`, titled(p.name, humanize(p.label.replace(/ #1$/, ""))), [p.name]);
    s.material = p.material;
    s.tolerance = processTolerance(model, [p.name]) ?? s.tolerance;
    s.views = autoViews(p).map((kind) => ({ kind }));
    const local = bboxOf?.(p);
    if (local && wantsSection(p)) {
      // with datums A to C on the sheet, the section takes the next letter
      const sec = autoSection(p, worldBox(p, local), gdtWanted(s, processFamily(p)) ? "D" : "A");
      s.sections.push(sec);
      // the section takes the place of the view it looks like
      const replaced = sec.normal[1] ? "front" : "right";
      s.views = s.views.filter((v) => v.kind !== replaced);
    }
    // letters after the datums' and the section's
    s.aux = autoAux(p, usedLetters(s), gdtWanted(s, processFamily(p)) ? "D" : "A", local ? worldBox(p, local) : undefined);
    out.push(s);
  }
  // the blank a sheet-metal part is cut from, with its bends
  const flats = new Set<string>();
  for (const p of model.parts) {
    if (!p.sheet || p.hidden || !drawable(p) || flats.has(firstOf(p.name)) || flatCovered.has(firstOf(p.name)) || flatCovered.has(p.name)) continue;
    flats.add(firstOf(p.name));
    const s = defaultSpec(`auto:${p.name}:flat`, titled(firstOf(p.name), humanize(p.label.replace(/ #1$/, "")), " flat pattern"), [p.name]);
    s.flat = true;
    s.material = p.material;
    s.tolerance = processTolerance(model, [p.name]) ?? s.tolerance;
    s.views = [{ kind: "top" }];
    s.hidden = false;
    out.push(s);
  }
  return out;
}

/**
 * The general tolerance the parts' manufacturing process states (ISO 2768 for
 * machined, cut and bent parts, an ISO 8062-3 grade for sand and investment
 * castings, the process's typical ± otherwise), when the
 * named parts are all made one way. Undefined leaves the drawing's default.
 */
export function processTolerance(model: Model, names: string[]): string | undefined {
  const tols = new Set<string>();
  for (const p of model.parts) {
    if (!names.includes(p.name) || p.hidden) continue;
    if (!p.process) return undefined;
    tols.add(generalToleranceFor(p.process));
  }
  return tols.size === 1 ? [...tols][0] : undefined;
}

/** Drawing blocks that don't set `tolerance:` follow their parts' process, like the automatic ones. */
export function withProcessTolerance(model: Model, specs: DrawingSpec[]): DrawingSpec[] {
  return specs.map((d) => {
    if (d.toleranceSet || !d.of.length) return d;
    const t = processTolerance(model, d.of);
    return t && t !== d.tolerance ? { ...d, tolerance: t } : d;
  });
}

/**
 * A section along the part's main feature direction (the open side of a
 * shell, or where most blind cuts point), through as many features as it can.
 */
export function autoSection(p: EvalPart, box: [V3, V3], label = "A"): SectionSpec {
  const feats = partFeatures(p);
  const shell = feats.find((f) => f.t === "shell");
  const votes = [0, 0, 0];
  const axisOf = (d: V3) => d.map(Math.abs).indexOf(Math.max(...d.map(Math.abs)));
  if (shell && shell.t === "shell") votes[axisOf(shell.open)] += 100;
  for (const f of feats) if ((f.t === "hole" && !f.through) || (f.t === "cyl" && f.op === "cut")) votes[axisOf(f.dir)] += 1;
  const axis = votes.indexOf(Math.max(...votes));
  // looking from the front unless the features run front to back, then from the right
  const normal: V3 = axis === 1 ? [1, 0, 0] : [0, -1, 0];
  const k = axis === 1 ? 0 : 1;
  const centre: V3 = [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2, (box[0][2] + box[1][2]) / 2];
  // slide the plane to cut through the most (and biggest) round features
  const round = feats.filter((f): f is Extract<Feature, { t: "hole" | "cyl" }> => (f.t === "hole" || f.t === "cyl") && Math.abs(f.dir[k]) < 1e-3);
  const score = (c: number) => round.reduce((a, f) => a + (Math.abs(f.at[k] - c) < f.d / 2 - 1e-3 ? f.d : 0), 0);
  let best = centre[k];
  let bestScore = score(best);
  for (const f of round) {
    const sc = score(f.at[k]);
    if (sc > bestScore + 1e-6 || (Math.abs(sc - bestScore) < 1e-6 && Math.abs(f.at[k] - centre[k]) < Math.abs(best - centre[k]))) {
      best = f.at[k];
      bestScore = sc;
    }
  }
  const at: V3 = [...centre];
  at[k] = best;
  return { label, at, normal, view: axis === 1 ? "front" : "top" };
}

/** Parts with hollows or blind features are clearer with a section. */
export function wantsSection(p: EvalPart): boolean {
  if (p.kind !== "part" || !p.recipe.base || p.recipe.base.t === "revolve" || p.recipe.base.t === "gear") return false;
  return p.recipe.ops.some((o) => o.op === "shell" || (o.op === "cut" && !(o.shape.t === "hole" && o.shape.depth >= 1000)));
}

/**
 * Views for a single-part drawing: an end view and a side view for turned
 * parts and gears; the profile view and one side view for a part whose
 * features all run one way (a plate, a lid, a bracket cut from bar), where a
 * third view would only repeat the other two; else the standard three. An
 * iso view goes with all of them.
 */
export function autoViews(p: EvalPart): ViewKind[] {
  const axis = turnedAxis(p);
  if (!axis) {
    const axes = p.sheet ? null : extrusionAxes(p);
    if (!axes || axes.size > 1) return ["front", "top", "right", "iso"];
    // the view along the features shows their profile, the other its depths
    return axes.has(0) ? ["front", "right", "iso"] : ["front", "top", "iso"];
  }
  // gears read best as an end view and a conventional side view
  const iso: ViewKind[] = p.gear ? [] : ["iso"];
  if (axis[2]) return ["front", "top", ...iso];
  return ["front", "right", ...iso];
}

/**
 * The world axes (0 X, 1 Y, 2 Z) the part's directional shapes run along:
 * holes, cylinders, slots, prisms, revolved bosses and rounded boxes (along
 * their rounded edges), with square boxes fitting any. Null when the part has shapes that don't read as
 * one direction (a loft, a sketch, an angled feature).
 */
export function extrusionAxes(p: EvalPart): Set<number> | null {
  const out = new Set<number>();
  let unknown = false;
  const axisOf = (d: V3): number => {
    const k = d.map(Math.abs).indexOf(Math.max(...d.map(Math.abs)));
    return Math.abs(d[k]) > 0.999 ? k : -1;
  };
  const along = (d: V3, xf: Xform[]) => {
    const k = axisOf(vnorm(applyXformsToDir(applyXformsToDir(d, xf), p.xf)));
    if (k < 0) unknown = true;
    else out.add(k);
  };
  const walk = (s: ShapeRecipe, op: "base" | "add" | "cut" | "intersect", xf: Xform[]) => {
    switch (s.t) {
      case "xform":
        return walk(s.shape, op, [...s.xf, ...xf]);
      case "union":
        for (const c of s.shapes) walk(c, op, xf);
        return;
      case "box":
        // rounded vertical edges make a box a profile drawn along its Z; a square one fits any view
        if (s.r > 0) along([0, 0, 1], xf);
        return;
      case "sphere":
        return;
      case "hole":
      case "cyl":
      case "tube":
      case "cone":
      case "prism":
      case "rrect":
      case "revolve":
      case "gear":
        return along(s.dir, xf);
      default:
        unknown = true;
    }
  };
  if (p.recipe.base) walk(p.recipe.base, "base", []);
  else unknown = true;
  for (const o of p.recipe.ops) {
    if (o.op === "add" || o.op === "cut") walk(o.shape, o.op, []);
    else if (o.op === "intersect") unknown = true;
    else if (o.op === "shell") {
      const open = shellOpenDir(o.open);
      if (open) along(open, []);
      else unknown = true;
    } else if (o.op === "draft") unknown = true;
  }
  return unknown ? null : out;
}

/** Axis of a turned part (revolve body) or gear in world space, when it lies along X, Y or Z. */
export function turnedAxis(p: EvalPart): V3 | null {
  const b = p.recipe.base;
  let w: V3 | null = null;
  if (p.gear) w = vnorm(p.gear.axis);
  else if (b?.t === "revolve" || b?.t === "gear") w = vnorm(applyXformsToDir(b.dir, p.xf));
  if (!w) return null;
  const major = w.map(Math.abs).indexOf(Math.max(...w.map(Math.abs)));
  if (Math.abs(w[major]) < 0.999) return null;
  const a: V3 = [0, 0, 0];
  a[major] = 1;
  return a;
}

/** "out_shaft" → "Out shaft" */
export function humanize(s: string): string {
  const t = s.replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
