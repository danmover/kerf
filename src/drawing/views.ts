// Which parts a drawing shows, which views it has and the projection request
// for each view. Pure: the engine sends the requests to the kernel and the
// composer lays out whatever has come back.

import type { EvalPart, Model } from "../core/model";
import type { ProjItem, ViewRequest } from "../kernel/drawing";
import { applyXforms, applyXformsToDir, recipeHash, vcross, vdot, vnorm, type V3 } from "../kernel/recipe";
import type { Frame } from "./sheet";
import type { Span } from "../lang/ast";
import { partFeatures, probeSegments, type Extent, type Feature } from "./features";
import { defaultSpec, type DetailSpec, type DrawingSpec, type SectionSpec, type ViewKind } from "./spec";
import { generalToleranceFor } from "../mfg/profiles";

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
  kind: ViewKind | "section" | "detail";
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

/** Parts a drawing shows: named parts and components (all instances), or the whole visible design. */
export function drawingParts(spec: DrawingSpec, model: Model): EvalPart[] {
  if (!spec.of.length) return model.parts.filter((p) => !p.hidden);
  const names = new Set(spec.of);
  const parts = model.parts.filter((p) => names.has(p.name));
  if (spec.of.length !== 1) return parts;
  // a drawing of one part shows a single instance of it
  const first = parts[0]?.id.split(".")[0];
  return parts.filter((p) => p.id.split(".")[0] === first);
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
  const itemsKey = recipeHash(items);
  const hiddenDefault = spec.hidden ?? !assembly;

  const views: PlannedView[] = [];
  const add = (v: Omit<PlannedView, "key">) => {
    const key = recipeHash({ i: itemsKey, d: v.req.dir, x: v.req.x, s: v.req.section ?? null, h: v.req.hidden });
    views.push({ ...v, key });
  };
  const seen = new Set<string>();
  for (const vs of spec.views) {
    const id = vs.kind + (vs.label ?? "");
    if (seen.has(id)) continue;
    seen.add(id);
    const frame = viewFrame(vs.kind);
    const hidden = vs.hidden ?? (vs.kind === "iso" ? false : hiddenDefault);
    const gear = parts.length === 1 && parts[0].gear ? vnorm(parts[0].gear.axis) : null;
    const synthetic = gear && vs.kind !== "iso" && Math.abs(vdot(frame.dir, gear)) < 1e-6 ? ("gear" as const) : undefined;
    add({ kind: vs.kind, name: vs.kind, frame, req: { dir: frame.dir, x: frame.x, items, hidden }, scale: vs.scale, at: vs.at, label: vs.label, synthetic });
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
  for (const d of spec.details) {
    const parent = views.findIndex((v) => v.name === d.view || (v.kind === "section" && v.name === d.view));
    if (parent < 0) {
      errors.push(`Detail ${d.label}: there is no "${d.view}" view to enlarge`);
      continue;
    }
    const pv = views[parent];
    views.push({ kind: "detail", name: d.label, frame: pv.frame, req: pv.req, key: pv.key, scale: d.scale, detail: d, parent });
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
  return { spec, parts, assembly, views, bbox, errors, probes };
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

/** Drawings generated when the source has none for a target: the whole design and each made part. */
export function autoDrawings(model: Model, bboxOf?: BBoxOf): DrawingSpec[] {
  const covered = new Set<string>();
  for (const d of model.drawings) {
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
  const seen = new Set<string>();
  for (const p of model.parts) {
    if (seen.has(p.name) || covered.has(p.name)) continue;
    if (p.kind === "component" && !(p.libKind && MADE_LIB.has(p.libKind))) continue;
    seen.add(p.name);
    const s = defaultSpec(`auto:${p.name}`, humanize(p.label.replace(/ #1$/, "")), [p.name]);
    s.material = p.material;
    s.tolerance = processTolerance(model, [p.name]) ?? s.tolerance;
    s.views = autoViews(p).map((kind) => ({ kind }));
    const local = bboxOf?.(p);
    if (local && wantsSection(p)) {
      const sec = autoSection(p, worldBox(p, local));
      s.sections.push(sec);
      // the section takes the place of the view it looks like
      const replaced = sec.normal[1] ? "front" : "right";
      s.views = s.views.filter((v) => v.kind !== replaced);
    }
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
export function autoSection(p: EvalPart, box: [V3, V3]): SectionSpec {
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
  return { label: "A", at, normal, view: axis === 1 ? "front" : "top" };
}

/** Parts with hollows or blind features are clearer with a section. */
export function wantsSection(p: EvalPart): boolean {
  if (p.kind !== "part" || !p.recipe.base || p.recipe.base.t === "revolve" || p.recipe.base.t === "gear") return false;
  return p.recipe.ops.some((o) => o.op === "shell" || (o.op === "cut" && !(o.shape.t === "hole" && o.shape.depth >= 1000)));
}

/** Views for a single-part drawing: an end view and a side view for turned parts and gears, else the standard three plus iso. */
export function autoViews(p: EvalPart): ViewKind[] {
  const axis = turnedAxis(p);
  if (!axis) return ["front", "top", "right", "iso"];
  // gears read best as an end view and a conventional side view
  const iso: ViewKind[] = p.gear ? [] : ["iso"];
  if (axis[2]) return ["front", "top", ...iso];
  return ["front", "right", ...iso];
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
