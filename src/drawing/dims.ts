// Dimensions: which ones a drawing gets (automatic and from the source),
// how they stack around each view, and how they are inked.

import type { EvalPart, Model } from "../core/model";
import type { ViewResult } from "../kernel/drawing";
import { vdot, vnorm, vsub, type V3 } from "../kernel/recipe";
import { applyProbes, holeCallout, holeKey, partFeatures, recipeSpan, type Feature } from "./features";
import { arcPoints } from "./hatch";
import { fmtDev, fmtNum, Ink, type Box, type Frame, type SheetDim } from "./sheet";
import { fitLimits, generalDeviation, type DrawingSpec } from "./spec";
import { textWidth } from "./text";
import { partExtent, toView, type BBoxOf, type DrawingPlan } from "./views";

export type Side = "bottom" | "top" | "left" | "right";

export interface DimText {
  main: string;
  /** symmetric tolerance or fit text after the value: "±0.1", "H7" */
  suffix?: string;
  /** stacked deviations */
  up?: string;
  lo?: string;
  boxed?: boolean;
}

export interface DimDef {
  view: number;
  kind: "h" | "v" | "aligned" | "inline" | "callout";
  /** view-space points (model mm, y up) */
  a: [number, number];
  b: [number, number];
  value: number;
  text: DimText;
  /** further callout lines under the first */
  lines?: string[];
  side?: Side;
  row?: number;
  /** distance of the dimension line from the view in sheet mm (explicit dims) */
  offset?: number;
  /** callout anchor circle in view space */
  circle?: { c: [number, number]; r: number };
  /** every centre the callout covers; the leader goes to the best one for its side */
  anchors?: [number, number][];
  /** which way a callout's leader runs */
  lead?: "left" | "right";
  /** the features a dimension runs between ("o3.4", "2.4x26"), so its id doesn't depend on the order dimensions come in */
  tag?: string;
  meta: Omit<SheetDim, "view" | "box" | "value" | "text">;
}

/** Text height and stacking distances for a sheet size. */
export interface DimStyle {
  size: number;
  first: number;
  step: number;
  arrow: number;
}

export function dimStyle(sheetW: number): DimStyle {
  // em sizes: caps come out at about 2.3, 2.5 and 3.2 mm (ISO 3098)
  const size = sheetW <= 300 ? 3.2 : sheetW <= 430 ? 3.5 : 4.5;
  return { size, first: 3 * size + 1, step: 2.4 * size + 0.5, arrow: 1.1 * size };
}

const PRINCIPAL = ["front", "top", "right", "left", "back", "bottom"];

function principalViews(plan: DrawingPlan): number[] {
  return plan.views
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => PRINCIPAL.includes(v.kind))
    .sort((a, b) => PRINCIPAL.indexOf(a.v.kind) - PRINCIPAL.indexOf(b.v.kind))
    .map(({ i }) => i);
}

/** Exact view-space extents from projected edges, if any. */
export function edgeExtents(r: ViewResult | undefined): [number, number, number, number] | null {
  if (!r || !r.edges.length) return null;
  const e: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => {
    if (x < e[0]) e[0] = x;
    if (y < e[1]) e[1] = y;
    if (x > e[2]) e[2] = x;
    if (y > e[3]) e[3] = y;
  };
  for (const ed of r.edges) {
    const g = ed.g;
    if (g.t === "L") add(g.p[0], g.p[1]), add(g.p[2], g.p[3]);
    else if (g.t === "P") for (let i = 0; i < g.p.length; i += 2) add(g.p[i], g.p[i + 1]);
    else {
      const full = g.a1 - g.a0 >= Math.PI * 2 - 1e-9;
      if (full) add(g.c[0] - g.r, g.c[1] - g.r), add(g.c[0] + g.r, g.c[1] + g.r);
      else {
        const pts = arcPoints(g.c[0], -g.c[1], g.r, g.a0, g.a1, 0.2);
        for (let i = 0; i < pts.length; i += 2) add(pts[i], -pts[i + 1]);
      }
    }
  }
  return e;
}

/** Parameters each part reads, directly or through lets and other components. */
function paramsByPart(model: Model): Map<string, Set<string>> {
  const into = new Map<string, string[]>();
  for (const e of model.graph.edges) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  const params = new Set(model.params.map((p) => p.name));
  const out = new Map<string, Set<string>>();
  for (const p of model.parts) {
    if (out.has(p.name)) continue;
    const seen = new Set<string>();
    const stack = [p.name, ...p.deps];
    const found = new Set<string>();
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      if (params.has(n)) found.add(n);
      for (const f of into.get(n) ?? []) stack.push(f);
    }
    out.set(p.name, found);
  }
  return out;
}

const close = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) < tol;

export interface DimContext {
  plan: DrawingPlan;
  model: Model;
  spec: DrawingSpec;
  /** exact view-space extents per view (or the box estimate) */
  ext: [number, number, number, number][];
  results: (ViewResult | undefined)[];
  bboxOf: BBoxOf;
  /**
   * The design evaluated again with some parameters changed. Dimensions use
   * it to find the parameter that drives them; without it none are linked.
   */
  reevaluate?: (overrides: Record<string, number>) => Model;
}

// ---------- parameter links ----------

type Parts = Map<string, EvalPart>;
/** Works a dimension's value out again from the parts' recipes, so it can be checked on a changed design. */
type Probe = (parts: Parts) => number | undefined;
type ParamFor = (value: number, probe?: Probe) => string | undefined;

/** how far a candidate parameter is moved to see whether a dimension follows it */
const NUDGE = 0.37;
const partsCache = new WeakMap<Model, Parts>();
const nudgedCache = new WeakMap<Model, Map<string, Parts | null>>();
const featCache = new WeakMap<EvalPart, Feature[]>();

function partsOf(model: Model): Parts {
  let out = partsCache.get(model);
  if (!out) partsCache.set(model, (out = new Map(model.parts.map((p) => [p.id, p]))));
  return out;
}

function featuresOf(p: EvalPart | undefined): Feature[] {
  if (!p) return [];
  let out = featCache.get(p);
  if (!out) featCache.set(p, (out = partFeatures(p)));
  return out;
}

/** The parts of the design with one parameter moved, or null if it doesn't evaluate. */
function nudged(model: Model, name: string, value: number, reevaluate: NonNullable<DimContext["reevaluate"]>): Parts | null {
  let byParam = nudgedCache.get(model);
  if (!byParam) nudgedCache.set(model, (byParam = new Map()));
  if (byParam.has(name)) return byParam.get(name)!;
  let out: Parts | null = null;
  try {
    out = new Map(reevaluate({ [name]: value }).parts.map((p) => [p.id, p]));
  } catch {
    out = null;
  }
  byParam.set(name, out);
  return out;
}

/** Material extent of some parts along a direction, from their recipes. */
function spanOver(parts: Parts, ids: string[], dir: V3): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of ids) {
    const p = parts.get(id);
    const s = p && recipeSpan(p, dir);
    if (!s) return undefined;
    lo = Math.min(lo, s[0]);
    hi = Math.max(hi, s[1]);
  }
  return ids.length ? [lo, hi] : undefined;
}

/** A feature's position in a view, followed through a re-evaluated design by its place in the recipe. */
function trackFeature(partId: string, index: number, frame: Frame): (parts: Parts) => [number, number] | undefined {
  return (parts) => {
    const f = featuresOf(parts.get(partId))[index];
    return f && "at" in f ? toView(f.at, frame) : undefined;
  };
}

/** A centre seen end-on in a view, with how to find it again in a changed design. */
interface Anchor {
  c: [number, number];
  at: (parts: Parts) => [number, number] | undefined;
  /** the feature's size, for dimension ids */
  tag: string;
}

/** A short name for a feature's size, used in dimension ids. */
function featureTag(f: Feature): string {
  if (f.t === "hole" || f.t === "cyl") return `o${fmtNum(f.d)}`;
  if (f.t === "slot") return `${fmtNum(f.w)}x${fmtNum(f.h)}`;
  return f.t;
}

/** All dimensions and callouts for a drawing, in view space. */
export function buildDims(ctx: DimContext): { dims: DimDef[]; warnings: string[] } {
  const dims: DimDef[] = [];
  const warnings: string[] = [];
  const { plan, model, spec } = ctx;
  const linkParams = paramsByPart(model);
  const partNames = [...new Set(plan.parts.map((p) => p.name))];
  // A dimension links to a parameter only when the parameter drives it one for
  // one: equal in value, and moving the parameter moves the dimension by the
  // same amount in a re-evaluated design. Sharing a value is not enough.
  const paramFor: ParamFor = (value, probe) => {
    const reevaluate = ctx.reevaluate;
    if (!probe || !reevaluate) return undefined;
    const candidates = new Set<string>();
    for (const n of partNames) for (const p of linkParams.get(n) ?? []) candidates.add(p);
    const same = model.params.filter((p) => candidates.has(p.name) && typeof p.value === "number" && close(p.value, value) && !p.locked);
    if (!same.length) return undefined;
    const base = probe(partsOf(model));
    if (base === undefined) return undefined;
    const hits = same.filter((p) => {
      const parts = nudged(model, p.name, (p.value as number) + NUDGE, reevaluate);
      const moved = parts ? probe(parts) : undefined;
      return moved !== undefined && close(moved - base, NUDGE, 1e-3);
    });
    return hits.length === 1 ? hits[0].name : undefined;
  };
  const general = (v: number) => generalDeviation(spec.tolerance, v) ?? undefined;

  const push = (d: Omit<DimDef, "meta"> & { meta: Partial<DimDef["meta"]> & { label: string } }) => {
    const meta: DimDef["meta"] = {
      kind: d.kind === "callout" ? "callout" : d.kind === "inline" ? "diameter" : "linear",
      auto: true,
      general: d.text.suffix || d.text.up ? undefined : general(d.value),
      ...d.meta,
    };
    dims.push({ ...d, meta });
  };

  if (spec.autoDims) {
    if (plan.assembly) assemblyDims(ctx, push, paramFor);
    else partDims(ctx, push, paramFor, warnings);
  }
  explicitDims(ctx, push, warnings);
  const out = mergeExplicit(dims);
  assignIds(out, plan);
  applyTols(out, spec.tols, warnings);
  return { dims: out, warnings };
}

/** Readable ids for automatic dimensions, such as "top:overall-width-x", stable while the design changes. */
function assignIds(dims: DimDef[], plan: DrawingPlan) {
  const seen = new Map<string, number>();
  for (const d of dims) {
    if (!d.meta.auto) continue;
    const label = d.meta.label.replace(/ (?:in|of) [^+]*?(?=\s*\+|$)/g, "");
    const slug = label
      .toLowerCase()
      .replace(/ø/g, "o")
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const base = `${plan.views[d.view]?.name ?? "view"}:${slug}${d.tag ? `-${d.tag}` : ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    d.meta.id = n > 1 ? `${base}-${n}` : base;
  }
}

/** A tolerance or fit as dimension text: "±0.1", "+0.1/−0.05", "H7 (+0.015/0)". */
function tolString(tol: [number, number] | undefined, fit: string | undefined): string {
  if (fit) return `${fit}${tol ? ` (${fmtDev(tol[0])}/${fmtDev(tol[1])})` : ""}`;
  if (!tol) return "";
  return close(tol[0], -tol[1], 1e-9) ? `±${fmtDev(tol[0]).replace(/^[+−]/, "")}` : `${fmtDev(tol[0])}/${fmtDev(tol[1])}`;
}

/** Puts a tolerance after the diameter it belongs to in a callout's lines. */
function tolInCallout(d: DimDef, dia: number, text: string) {
  const s = fmtNum(dia);
  const re = new RegExp(`Ø${s.replace(".", "\\.")}(?![\\d.])`);
  if (re.test(d.text.main)) d.text = { ...d.text, main: d.text.main.replace(re, `Ø${s} ${text}`) };
  else if (d.lines?.some((l) => re.test(l))) d.lines = d.lines.map((l) => l.replace(re, `Ø${s} ${text}`));
  else d.text = { ...d.text, main: `${d.text.main} ${text}` };
}

/** tol() calls in the drawing block give automatic dimensions a tolerance or fit. */
function applyTols(dims: DimDef[], tols: DrawingSpec["tols"], warnings: string[]) {
  for (const t of tols) {
    const d = dims.find((x) => x.meta.id === t.id);
    if (!d) {
      warnings.push(`tol("${t.id}"): there is no dimension with that id on this drawing`);
      continue;
    }
    let tol = t.tol;
    if (t.fit) {
      const lim = fitLimits(t.fit, d.value);
      if (lim) tol = [lim.upper, lim.lower];
      else warnings.push(`Fit ${t.fit} is not in the ISO 286 table for ${fmtNum(d.value)} mm`);
    }
    if (d.kind === "callout") tolInCallout(d, d.value, tolString(tol, t.fit));
    else if (t.fit) d.text = { ...d.text, suffix: t.fit, up: tol ? `(${fmtDev(tol[0])}` : undefined, lo: tol ? `${fmtDev(tol[1])})` : undefined };
    else if (tol && close(tol[0], -tol[1], 1e-9)) d.text = { ...d.text, suffix: tolString(tol, undefined) };
    else if (tol) d.text = { ...d.text, up: fmtDev(tol[0]), lo: fmtDev(tol[1]) };
    d.meta = { ...d.meta, tol, fit: t.fit, general: undefined, span: t.span };
  }
}

/**
 * Dimensions written in the drawing block take over the automatic ones they
 * repeat (keeping any parameter link), and a diameter on a called-out hole
 * puts its fit or tolerance into that callout.
 */
function mergeExplicit(dims: DimDef[]): DimDef[] {
  const drop = new Set<DimDef>();
  for (const e of dims) {
    if (e.meta.auto) continue;
    if (e.kind === "callout" && e.meta.kind === "diameter") {
      const dia = fmtNum(e.value);
      const hit = dims.find((o) => o.meta.auto && o.kind === "callout" && o.view === e.view && (o.anchors ?? [o.circle?.c ?? o.a]).some((c) => close(c[0], e.a[0], 0.01) && close(c[1], e.a[1], 0.01)) && [o.text.main, ...(o.lines ?? [])].some((l) => l.includes(`Ø${dia}`)));
      if (!hit) continue;
      tolInCallout(hit, e.value, tolString(e.meta.tol, e.meta.fit));
      hit.meta = { ...hit.meta, auto: false, span: e.meta.span, tol: e.meta.tol, fit: e.meta.fit, a: e.meta.a, general: undefined };
      drop.add(e);
      continue;
    }
    if (e.kind !== "h" && e.kind !== "v") continue;
    const k = e.kind === "h" ? 0 : 1;
    const lo = Math.min(e.a[k], e.b[k]);
    const hi = Math.max(e.a[k], e.b[k]);
    for (const o of dims) {
      if (!o.meta.auto || o.view !== e.view || o.kind !== e.kind || drop.has(o)) continue;
      if (close(Math.min(o.a[k], o.b[k]), lo, 0.01) && close(Math.max(o.a[k], o.b[k]), hi, 0.01)) {
        drop.add(o);
        e.meta = { ...e.meta, param: e.meta.param ?? o.meta.param, label: o.meta.label };
        if (e.side === undefined || e.offset === undefined) e.side = o.side;
      }
    }
  }
  return dims.filter((d) => !drop.has(d));
}

type Push = (d: Omit<DimDef, "meta"> & { meta: Partial<DimDef["meta"]> & { label: string } }) => void;

const AXES: { v: V3; name: string; word: string }[] = [
  { v: [1, 0, 0], name: "X", word: "width" },
  { v: [0, 1, 0], name: "Y", word: "depth" },
  { v: [0, 0, 1], name: "Z", word: "height" },
];

function overallDims(ctx: DimContext, push: Push, paramFor: ParamFor, skip: Set<string>, what: string, ids: string[]) {
  const views = principalViews(ctx.plan);
  for (const axis of AXES) {
    if (skip.has(axis.name)) continue;
    const size: Probe = (parts) => {
      const s = spanOver(parts, ids, axis.v);
      return s && s[1] - s[0];
    };
    for (const vi of views) {
      const f = ctx.plan.views[vi].frame;
      const [u0, v0, u1, v1] = ctx.ext[vi];
      const value = (lo: number, hi: number) => Math.round((hi - lo) * 1e4) / 1e4;
      if (Math.abs(vdot(f.x, axis.v)) > 0.999) {
        const val = value(u0, u1);
        push({ view: vi, kind: "h", a: [u0, v0], b: [u1, v0], value: val, text: { main: fmtNum(val) }, side: "bottom", meta: { label: `Overall ${axis.word} (${axis.name}) of ${what}`, param: paramFor(val, size) } });
        break;
      }
      if (Math.abs(vdot(f.y, axis.v)) > 0.999) {
        const val = value(v0, v1);
        push({ view: vi, kind: "v", a: [u1, v0], b: [u1, v1], value: val, text: { main: fmtNum(val) }, side: "right", meta: { label: `Overall ${axis.word} (${axis.name}) of ${what}`, param: paramFor(val, size) } });
        break;
      }
    }
  }
}

function assemblyDims(ctx: DimContext, push: Push, paramFor: ParamFor) {
  overallDims(ctx, push, paramFor, new Set(), "the assembly", ctx.plan.parts.map((p) => p.id));
}

/** The first principal view that looks along a direction. */
function viewAlong(ctx: DimContext, dir: V3): number {
  for (const vi of principalViews(ctx.plan)) if (Math.abs(vdot(ctx.plan.views[vi].frame.dir, dir)) > 0.999) return vi;
  return -1;
}

function partDims(ctx: DimContext, push: Push, paramFor: ParamFor, warnings: string[]) {
  const part = ctx.plan.parts[0];
  if (!part) return;
  const what = part.label;
  const extent = partExtent(part, ctx.bboxOf);
  const feats = partFeatures(part, extent);
  // the kernel's probe lines settle through or blind where the recipe cannot
  if (ctx.plan.probes) applyProbes(feats, ctx.plan.probes.segs, ctx.results[ctx.plan.probes.view]?.probes);
  const turned = feats.find((f): f is Extract<Feature, { t: "turned" }> => f.t === "turned" && f.part === part.id);
  const skip = new Set<string>();
  if (part.gear || turned) {
    // turned parts and gears get diameters instead of overall sizes across the axis
    const axisDir = part.gear?.axis ?? turned!.dir;
    // the profile gives a turned part's length; a gear keeps its face width
    for (const a of AXES) if (turned || Math.abs(vdot(a.v, vnorm(axisDir))) < 0.999) skip.add(a.name);
  }
  overallDims(ctx, push, paramFor, skip, what, [part.id]);

  // per view: the groups of features seen end-on, for position dimensions; concentric groups merge
  const anchors = new Map<number, Anchor[][]>();
  const addGroup = (vi: number, list: Feature[], centers: [number, number][]) => {
    const groups = anchors.get(vi) ?? [];
    const same = (a: Anchor[], b: [number, number][]) => a.length === b.length && a.every(({ c }) => b.some((d) => close(c[0], d[0], 0.01) && close(c[1], d[1], 0.01)));
    const frame = ctx.plan.views[vi].frame;
    const tag = featureTag(list[0]);
    const twin = groups.find((g) => same(g, centers));
    // concentric features share the group, and their sizes together name it
    if (twin) for (const a of twin) a.tag = a.tag.split("-").includes(tag) ? a.tag : `${a.tag}-${tag}`;
    else groups.push(list.map((f, k) => ({ c: centers[k], at: trackFeature(part.id, feats.indexOf(f), frame), tag })));
    anchors.set(vi, groups);
  };

  // callouts are collected first so concentric ones can share a leader
  type Callout = { vi: number; centers: [number, number][]; order: number; size: number; lines: string[]; r: number; label: string; param?: string; value: number };
  const callouts: Callout[] = [];
  // a blind cut that opens on the side of the part away from the view
  const farSide = (at: V3, dir: V3, h: number, vi: number) => {
    const v = ctx.plan.views[vi].frame.dir;
    const [lo, hi] = extent(v);
    const s0 = vdot(at, v);
    const s1 = s0 + h * vdot(dir, v);
    return Math.max(s0, s1) < hi - 0.02 && Math.min(s0, s1) <= lo + 0.02;
  };

  // holes, grouped into "n×" callouts
  const groups = new Map<string, Extract<Feature, { t: "hole" }>[]>();
  for (const f of feats) if (f.t === "hole") groups.set(holeKey(f), [...(groups.get(holeKey(f)) ?? []), f]);
  for (const list of groups.values()) {
    const vi = viewAlong(ctx, list[0].dir);
    if (vi < 0) continue;
    const frame = ctx.plan.views[vi].frame;
    const centers = list.map((h) => toView(h.at, frame));
    const lines = holeCallout(list[0], (n) => fmtNum(n, n < 10 ? 2 : 1));
    if (!list[0].through && farSide(list[0].at, list[0].dir, list[0].depth, vi)) lines[0] += " FAR SIDE";
    const r = list[0].d / 2;
    callouts.push({ vi, centers, order: 0, size: list[0].d, lines, r, value: list[0].d, label: `${list.length > 1 ? `${list.length} holes` : "Hole"} Ø${fmtNum(list[0].d)} in ${what}` });
    addGroup(vi, list, centers);
  }

  // cut and added cylinders: bores, seats and bosses
  const cyls = new Map<string, Extract<Feature, { t: "cyl" }>[]>();
  for (const f of feats) {
    if (f.t !== "cyl") continue;
    const k = [f.op, f.d.toFixed(3), f.op === "cut" ? (f.through ? "T" : f.h.toFixed(2)) : "", f.dir.map((v) => Math.round(Math.abs(v) * 1000)).join(",")].join("|");
    cyls.set(k, [...(cyls.get(k) ?? []), f]);
  }
  for (const list of cyls.values()) {
    const f0 = list[0];
    const vi = viewAlong(ctx, f0.dir);
    if (vi < 0) continue;
    const frame = ctx.plan.views[vi].frame;
    const centers = list.map((f) => toView(f.at, frame));
    // a turned part's own cylinders are dimensioned along its profile
    if (turned) continue;
    let main = `Ø${fmtNum(f0.d)}`;
    if (f0.op === "cut") {
      const [lo, hi] = extent(f0.dir);
      const start = vdot(f0.at, f0.dir);
      const depth = Math.min(start + f0.h, hi) - Math.max(start, lo);
      main += f0.through ? " THRU" : ` × ${fmtNum(depth, 1)} DEEP${farSide(f0.at, f0.dir, f0.h, vi) ? " FAR SIDE" : ""}`;
    } else main += " BOSS";
    const i0 = feats.indexOf(f0);
    const dia: Probe = (parts) => {
      const f = featuresOf(parts.get(part.id))[i0];
      return f?.t === "cyl" ? f.d : undefined;
    };
    callouts.push({ vi, centers, order: f0.op === "cut" ? 1 : 2, size: f0.d, lines: [main], r: f0.d / 2, value: f0.d, label: `${f0.op === "add" ? "Boss" : "Bore"} Ø${fmtNum(f0.d)} in ${what}`, param: paramFor(f0.d, dia) });
    addGroup(vi, list, centers);
  }

  // slots and pockets
  const slots = new Map<string, Extract<Feature, { t: "slot" }>[]>();
  for (const f of feats) if (f.t === "slot") {
    const k = [f.w, f.h, f.r, f.through ? "T" : f.depth, f.dir.map((v) => Math.round(v * 1000)).join(",")].join("|");
    slots.set(k, [...(slots.get(k) ?? []), f]);
  }
  for (const list of slots.values()) {
    const s = list[0];
    const vi = viewAlong(ctx, s.dir);
    if (vi < 0) continue;
    const frame = ctx.plan.views[vi].frame;
    const centers = list.map((f) => toView(f.at, frame));
    const isSlot = close(s.r, Math.min(s.w, s.h) / 2, 0.05);
    const size = `${fmtNum(s.w)} × ${fmtNum(s.h)}`;
    let main = isSlot ? `SLOT ${size}` : `${size} R${fmtNum(s.r)}`;
    main += s.through ? " THRU" : ` × ${fmtNum(s.depth, 1)} DEEP${farSide(s.at, s.dir, s.depth, vi) ? " FAR SIDE" : ""}`;
    callouts.push({ vi, centers, order: 1, size: Math.min(s.w, s.h), lines: [main], r: Math.min(s.w, s.h) / 2, value: s.w, label: `${isSlot ? "Slot" : "Pocket"} ${size} in ${what}` });
    addGroup(vi, list, centers);
  }

  // one leader per set of concentric features: holes first, then bores by size, then bosses
  const sameSet = (a: [number, number][], b: [number, number][]) => a.length === b.length && a.every((c) => b.some((d) => close(c[0], d[0], 0.01) && close(c[1], d[1], 0.01)));
  const used = new Set<Callout>();
  for (const c of callouts) {
    if (used.has(c)) continue;
    const set = callouts.filter((o) => !used.has(o) && o.vi === c.vi && sameSet(o.centers, c.centers)).sort((a, b) => a.order - b.order || a.size - b.size);
    for (const o of set) used.add(o);
    const lines = set.flatMap((o) => o.lines);
    if (c.centers.length > 1) lines[0] = `${c.centers.length}× ${lines[0]}`;
    const rep = repIndex(c.centers);
    const big = set.reduce((a, b) => (b.r > a.r ? b : a));
    push({ view: c.vi, kind: "callout", a: c.centers[rep], b: c.centers[rep], value: set[0].value, text: { main: lines[0] }, lines: lines.slice(1), circle: { c: c.centers[rep], r: big.r }, anchors: c.centers, meta: { label: set.map((o) => o.label).join(" + "), part: part.id, param: set.length === 1 ? set[0].param : undefined } });
  }

  // positions of the end-on features
  for (const [vi, groups] of anchors) positionDims(ctx, vi, groups, push, paramFor, warnings, what);

  // turned profile: length and diameters on the side view
  if (turned) {
    const ti = feats.indexOf(turned);
    turnedDims(ctx, turned, push, paramFor, what, (parts) => {
      const f = featuresOf(parts.get(part.id))[ti];
      return f?.t === "turned" ? f : undefined;
    });
  }
  if (part.gear && part.recipe.base?.t === "gear") gearDims(ctx, part, push, what);
}

/** The feature to hang a callout on: the top-right one. */
function repIndex(centers: [number, number][]): number {
  let best = 0;
  for (let i = 1; i < centers.length; i++) if (centers[i][0] + centers[i][1] > centers[best][0] + centers[best][1] + 1e-6) best = i;
  return best;
}

/**
 * Position dimensions for the features seen end-on in one view. Each axis
 * picks a datum: the part's centre when the features are symmetric about it,
 * the design origin when a feature sits on it (a motor axis, a bore), else
 * the lower edge. Each feature group then gets its spacing or pattern pitch
 * and one dimension tying it to the datum.
 */
function positionDims(ctx: DimContext, vi: number, anchorGroups: Anchor[][], push: Push, paramFor: ParamFor, warnings: string[], what: string) {
  const [u0, v0, u1, v1] = ctx.ext[vi];
  const all = anchorGroups.flat();
  const centers = all.map((a) => a.c);
  const groups = anchorGroups.map((g) => g.map((a) => a.c));
  const frame = ctx.plan.views[vi].frame;
  const ids = ctx.plan.parts.slice(0, 1).map((p) => p.id);
  for (const axis of [0, 1] as const) {
    const lo = axis === 0 ? u0 : v0;
    const hi = axis === 0 ? u1 : v1;
    const mid = (lo + hi) / 2;
    const vals = uniq(centers.map((c) => c[axis]));
    if (!vals.length) continue;
    const word = axis === 0 ? "horizontal" : "vertical";
    // the dimension line sits below (horizontal) or right of (vertical) the view; extension lines start at the nearest feature
    const near = (val: number) => {
      let on = centers.filter((c) => close(c[axis], val, 0.05));
      if (!on.length) {
        // a datum edge rather than a feature: start from the view outline
        if (close(val, lo, 0.05) || close(val, hi, 0.05)) return axis === 0 ? v0 : u1;
        const d = Math.min(...centers.map((c) => Math.abs(c[axis] - val)));
        on = centers.filter((c) => Math.abs(c[axis] - val) <= d + 1e-9);
      }
      return axis === 0 ? Math.min(...on.map((c) => c[1])) : Math.max(...on.map((c) => c[0]));
    };
    const made = new Set<string>();
    const out: [number, number, number, string, string][] = [];
    /** where a dimension end lands in a changed design: on its feature, the origin, or the moved outline */
    const dir = axis === 0 ? frame.x : frame.y;
    const endIn = (val: number, parts: Parts): number | undefined => {
      const on = all.find((x) => close(x.c[axis], val, 0.01));
      if (on) return on.at(parts)?.[axis];
      if (close(val, 0, 1e-6)) return 0;
      if (!close(val, lo, 0.05) && !close(val, hi, 0.05)) return undefined;
      const s0 = spanOver(partsOf(ctx.model), ids, dir);
      const s1 = spanOver(parts, ids, dir);
      if (!s0 || !s1) return undefined;
      return close(val, lo, 0.05) ? val + s1[0] - s0[0] : val + s1[1] - s0[1];
    };
    const mk = (a: number, b: number, value: number, text: string, label: string) => {
      const k = `${Math.min(a, b).toFixed(2)}|${Math.max(a, b).toFixed(2)}`;
      if (made.has(k) || value < 0.01) return;
      made.add(k);
      out.push([a, b, value, text, label]);
    };
    const symmetricAbout = (list: number[], c: number) => list.every((v) => list.some((w) => close(w, 2 * c - v, 0.02)));
    if (symmetricAbout(vals, mid)) {
      // centred features: a pitch for each even pattern, spacings for the rest
      const rest: number[] = [];
      for (const g of groups) {
        const gv = uniq(g.map((c) => c[axis]));
        if (gv.length >= 3 && evenlySpaced(gv) && symmetricAbout(gv, mid)) {
          const total = gv[gv.length - 1] - gv[0];
          mk(gv[0], gv[gv.length - 1], total, `${gv.length - 1}× ${fmtNum(gv[1] - gv[0])} = ${fmtNum(total)}`, `Pattern pitch (${word}) in ${what}`);
        } else rest.push(...gv);
      }
      for (const d of uniq(rest.map((v) => Math.abs(v - mid))).filter((d) => d > 0.01)) mk(mid - d, mid + d, 2 * d, fmtNum(2 * d), `Feature spacing (${word}) in ${what}`);
    } else {
      const fromOrigin = lo < 1e-6 && hi > -1e-6 && vals.some((v) => close(v, 0, 0.01));
      const datum = fromOrigin ? 0 : lo;
      const placed: number[] = [datum];
      const isPlaced = (v: number) => placed.some((w) => close(w, v, 0.01));
      const locate = (v: number) => {
        if (!isPlaced(v)) mk(Math.min(datum, v), Math.max(datum, v), Math.abs(v - datum), fmtNum(Math.abs(v - datum)), `Feature position (${word}) in ${what}`);
        placed.push(v);
      };
      for (const g of [...groups].sort((a, b) => b.length - a.length)) {
        const gv = uniq(g.map((c) => c[axis]));
        if (gv.length >= 2 && fromOrigin && symmetricAbout(gv, datum)) {
          for (const d of uniq(gv.map((v) => Math.abs(v - datum))).filter((d) => d > 0.01)) mk(datum - d, datum + d, 2 * d, fmtNum(2 * d), `Feature spacing (${word}) in ${what}`);
          placed.push(...gv);
          continue;
        }
        if (gv.length >= 3 && evenlySpaced(gv) && !gv.every(isPlaced)) {
          const pitch = gv[1] - gv[0];
          const total = gv[gv.length - 1] - gv[0];
          mk(gv[0], gv[gv.length - 1], total, `${gv.length - 1}× ${fmtNum(pitch)} = ${fmtNum(total)}`, `Pattern pitch (${word}) in ${what}`);
          locate(Math.abs(gv[0] - datum) <= Math.abs(gv[gv.length - 1] - datum) ? gv[0] : gv[gv.length - 1]);
          placed.push(...gv);
          continue;
        }
        if (gv.length === 2 && !gv.some(isPlaced)) {
          mk(gv[0], gv[1], gv[1] - gv[0], fmtNum(gv[1] - gv[0]), `Feature spacing (${word}) in ${what}`);
          locate(Math.abs(gv[0] - datum) <= Math.abs(gv[1] - datum) ? gv[0] : gv[1]);
          placed.push(...gv);
          continue;
        }
        for (const v of gv) locate(v);
      }
      // tie the outline to a datum inside the part
      if (fromOrigin) mk(lo, datum, datum - lo, fmtNum(datum - lo), `Outline position (${word}) in ${what}`);
    }
    if (out.length > 7) {
      warnings.push(`Some ${word} feature positions in the ${ctx.plan.views[vi].name} view are not dimensioned`);
      out.length = 7;
    }
    const tagAt = (val: number) => all.find((x) => close(x.c[axis], val, 0.01))?.tag;
    for (const [a, b, value, text, label] of out) {
      const tag = [...new Set([tagAt(a), tagAt(b)].filter(Boolean))].join("-") || undefined;
      const pa: [number, number] = axis === 0 ? [a, near(a)] : [near(a), a];
      const pb: [number, number] = axis === 0 ? [b, near(b)] : [near(b), b];
      const length: Probe = (parts) => {
        const ea = endIn(a, parts);
        const eb = endIn(b, parts);
        return ea === undefined || eb === undefined ? undefined : Math.abs(eb - ea);
      };
      push({ view: vi, kind: axis === 0 ? "h" : "v", a: pa, b: pb, value, text: { main: text }, side: axis === 0 ? "bottom" : "right", tag, meta: { label, param: paramFor(value, length) } });
    }
  }
}

function uniq(vals: number[]): number[] {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || !close(out[out.length - 1], v, 0.01)) out.push(v);
  return out;
}

function evenlySpaced(vals: number[]): boolean {
  const d = vals[1] - vals[0];
  for (let i = 2; i < vals.length; i++) if (!close(vals[i] - vals[i - 1], d, 0.01)) return false;
  return d > 0.01;
}

function turnedDims(ctx: DimContext, f: Extract<Feature, { t: "turned" }>, push: Push, paramFor: ParamFor, what: string, track: (parts: Parts) => Extract<Feature, { t: "turned" }> | undefined) {
  const axis = vnorm(f.dir);
  const vi = principalViews(ctx.plan).find((i) => Math.abs(vdot(ctx.plan.views[i].frame.x, axis)) > 0.999 || Math.abs(vdot(ctx.plan.views[i].frame.y, axis)) > 0.999);
  if (vi === undefined) return;
  const frame = ctx.plan.views[vi].frame;
  const horizontal = Math.abs(vdot(frame.x, axis)) > 0.999;
  const along = (z: number): [number, number] => toView([f.at[0] + axis[0] * z, f.at[1] + axis[1] * z, f.at[2] + axis[2] * z], frame);
  const zs = f.pts.map((p) => p[1]);
  const zmin = Math.min(...zs);
  const zmax = Math.max(...zs);
  const rmax = Math.max(...f.pts.map((p) => p[0]));
  const a0 = along(zmin);
  const a1 = along(zmax);
  const len = zmax - zmin;
  const length: Probe = (parts) => {
    const zs2 = track(parts)?.pts.map((p) => p[1]);
    return zs2?.length ? Math.max(...zs2) - Math.min(...zs2) : undefined;
  };
  const perp: [number, number] = horizontal ? [0, -rmax] : [rmax, 0];
  if (horizontal) push({ view: vi, kind: "h", a: [Math.min(a0[0], a1[0]), a0[1] + perp[1]], b: [Math.max(a0[0], a1[0]), a0[1] + perp[1]], value: len, text: { main: fmtNum(len) }, side: "bottom", meta: { label: `Overall length of ${what}`, param: paramFor(len, length) } });
  else push({ view: vi, kind: "v", a: [a0[0] + perp[0], Math.min(a0[1], a1[1])], b: [a0[0] + perp[0], Math.max(a0[1], a1[1])], value: len, text: { main: fmtNum(len) }, side: "right", meta: { label: `Overall length of ${what}`, param: paramFor(len, length) } });
  // cylindrical runs: one diameter each, at the middle of the longest run
  const runs = new Map<string, { r: number; z: number; len: number; i: number }>();
  for (let i = 0; i + 1 < f.pts.length; i++) {
    const [ra, za] = f.pts[i];
    const [rb, zb] = f.pts[i + 1];
    if (ra < 0.05 || !close(ra, rb, 1e-4) || close(za, zb, 1e-4)) continue;
    const k = ra.toFixed(3);
    const run = { r: ra, z: (za + zb) / 2, len: Math.abs(zb - za), i };
    if (!runs.has(k) || runs.get(k)!.len < run.len) runs.set(k, run);
  }
  for (const run of [...runs.values()].sort((a, b) => b.len - a.len).slice(0, 4)) {
    const c = along(run.z);
    const a: [number, number] = horizontal ? [c[0], c[1] - run.r] : [c[0] - run.r, c[1]];
    const b: [number, number] = horizontal ? [c[0], c[1] + run.r] : [c[0] + run.r, c[1]];
    const dia: Probe = (parts) => {
      const q = track(parts)?.pts[run.i];
      return q && 2 * q[0];
    };
    push({ view: vi, kind: "inline", a, b, value: 2 * run.r, text: { main: `Ø${fmtNum(2 * run.r)}` }, meta: { label: `Diameter of ${what}`, param: paramFor(2 * run.r, dia) } });
  }
}

function gearDims(ctx: DimContext, part: EvalPart, push: Push, what: string) {
  const base = part.recipe.base;
  if (!base || base.t !== "gear" || !part.gear) return;
  const vi = viewAlong(ctx, vnorm(part.gear.axis));
  if (vi < 0) return;
  const tip = base.m * (base.z + 2);
  const cc = toView(part.gear.center, ctx.plan.views[vi].frame);
  push({ view: vi, kind: "callout", a: cc, b: cc, value: tip, text: { main: `Ø${fmtNum(tip)} TIP` }, circle: { c: cc, r: tip / 2 }, meta: { label: `Tip diameter of ${what}` } });
}

// ---------- dimensions written in the source ----------

function explicitDims(ctx: DimContext, push: Push, warnings: string[]) {
  const { plan, spec } = ctx;
  const findView = (name: string | undefined): number => {
    if (!name) return -1;
    return plan.views.findIndex((v) => v.name === name || v.kind === name);
  };
  for (const d of spec.dims) {
    const text = (value: number, prefix = ""): { text: DimText; tol?: [number, number]; fit?: string } => {
      let main = d.text ?? `${prefix}${fmtNum(value)}`;
      if (d.ref) main = `(${main})`;
      const t: DimText = { main, boxed: d.basic };
      let tol = d.tol;
      if (d.fit) {
        const lim = fitLimits(d.fit, value);
        t.suffix = d.fit;
        if (lim) {
          t.up = `(${fmtDev(lim.upper)}`;
          t.lo = `${fmtDev(lim.lower)})`;
          tol = [lim.upper, lim.lower];
        } else warnings.push(`Fit ${d.fit} is not in the ISO 286 table for ${fmtNum(value)} mm`);
      } else if (tol) {
        if (close(tol[0], -tol[1], 1e-9)) t.suffix = `±${fmtDev(tol[0]).replace(/^[+−]/, "")}`;
        else {
          t.up = fmtDev(tol[0]);
          t.lo = fmtDev(tol[1]);
        }
      }
      return { text: t, tol, fit: d.fit };
    };
    const where = d.kind === "diameter" ? `diameter Ø${fmtNum(d.d ?? 0)}` : "dim()";
    if (d.kind === "diameter") {
      const dia = d.d ?? 0;
      let vi = findView(d.view);
      if (vi < 0) vi = bestCircleView(ctx, d.a, dia);
      if (vi < 0) {
        warnings.push(`No view for the ${where}`);
        continue;
      }
      const c = toView(d.a, plan.views[vi].frame);
      const t = text(dia, "Ø");
      push({
        view: vi,
        kind: "callout",
        a: c,
        b: c,
        value: dia,
        text: t.text,
        circle: { c, r: dia / 2 },
        meta: { label: `Diameter Ø${fmtNum(dia)}`, auto: false, span: d.span, tol: t.tol, fit: t.fit, a: d.a, kind: "diameter" },
      });
      continue;
    }
    if (!d.b) continue;
    let vi = findView(d.view);
    const delta = vsub(d.b, d.a);
    if (vi < 0) {
      // the view that sees the measured direction most nearly flat
      let best = -1;
      let bestLen = -1;
      for (const i of principalViews(plan)) {
        const f = plan.views[i].frame;
        const l = Math.hypot(vdot(delta, f.x), vdot(delta, f.y));
        if (l > bestLen + 1e-6) {
          best = i;
          bestLen = l;
        }
      }
      vi = best;
    }
    if (vi < 0) {
      warnings.push(`No view for the ${where}`);
      continue;
    }
    const f = plan.views[vi].frame;
    const a = toView(d.a, f);
    const b = toView(d.b, f);
    const du = Math.abs(b[0] - a[0]);
    const dv = Math.abs(b[1] - a[1]);
    let align = d.align;
    if (align === "auto") align = dv < 1e-6 ? "h" : du < 1e-6 ? "v" : du >= dv * 4 ? "h" : dv >= du * 4 ? "v" : "aligned";
    const value = align === "h" ? du : align === "v" ? dv : Math.hypot(du, dv);
    if (value < 1e-6) {
      warnings.push(`The ${where} measures nothing in the ${plan.views[vi].name} view`);
      continue;
    }
    const t = text(value);
    const [u0, , u1] = ctx.ext[vi];
    const side: Side = align === "h" ? "bottom" : (a[0] + b[0]) / 2 < (u0 + u1) / 2 - (u1 - u0) * 0.2 ? "left" : "right";
    push({
      view: vi,
      kind: align === "aligned" ? "aligned" : align,
      a,
      b,
      value,
      text: t.text,
      side: align === "aligned" ? undefined : side,
      offset: d.offset,
      meta: {
        label: `Dimension ${fmtNum(value)}`,
        auto: false,
        span: d.span,
        tol: t.tol,
        fit: t.fit,
        a: d.a,
        b: d.b,
        general: t.tol ? undefined : (generalDeviation(spec.tolerance, value) ?? undefined),
      },
    });
  }
}

/** The view whose projection has a circle of this diameter centred on the point. */
function bestCircleView(ctx: DimContext, at: V3, d: number): number {
  const views = principalViews(ctx.plan);
  for (const vi of views) {
    const r = ctx.results[vi];
    if (!r) continue;
    const c = toView(at, ctx.plan.views[vi].frame);
    if (r.edges.some((e) => e.g.t === "A" && close(e.g.r, d / 2, 1e-3) && close(e.g.c[0], c[0], 1e-3) && close(e.g.c[1], c[1], 1e-3))) return vi;
  }
  return views[0] ?? -1;
}

// ---------- stacking ----------

export interface Placed {
  origin: [number, number];
  scale: number;
  /** sheet box of the view geometry used for stacking */
  box: Box;
}

const sheetPt = (p: [number, number], v: Placed): [number, number] => [v.origin[0] + p[0] * v.scale, v.origin[1] - p[1] * v.scale];

/** Total length of a dimension's text along its line. */
export function dimTextWidth(t: DimText, size: number): number {
  let w = textWidth(t.main, size);
  if (t.suffix) w += textWidth(" " + t.suffix, size);
  if (t.up || t.lo) w += 0.6 + Math.max(textWidth(t.up ?? "", size * 0.7), textWidth(t.lo ?? "", size * 0.7));
  if (t.boxed) w += 1.6;
  return w;
}

/**
 * Assigns stacking rows to the dimensions of one view at a scale and returns
 * the margins they need on each side (sheet mm).
 */
export function stackDims(defs: DimDef[], v: Placed, st: DimStyle): Record<Side, number> {
  const margin: Record<Side, number> = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const side of ["bottom", "left", "right"] as const) {
    const list = defs.filter((d) => d.side === side && d.offset === undefined && (d.kind === "h" || d.kind === "v"));
    const rows: [number, number][][] = [];
    const span = (d: DimDef): [number, number] => {
      const pa = sheetPt(d.a, v);
      const pb = sheetPt(d.b, v);
      const k = side === "bottom" ? 0 : 1;
      let lo = Math.min(pa[k], pb[k]);
      let hi = Math.max(pa[k], pb[k]);
      const tw = dimTextWidth(d.text, st.size);
      if (tw + 2 > hi - lo) {
        if (side === "bottom") hi += tw + st.arrow + 4;
        else lo -= tw + st.arrow + 4;
      } else if (2 * st.arrow + 1.5 > hi - lo) {
        lo -= st.arrow + 2;
        hi += st.arrow + 2;
      }
      lo -= 1;
      hi += 1;
      return [lo, hi];
    };
    list.sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]));
    for (const d of list) {
      const s = span(d);
      let r = 0;
      while (rows[r]?.some((o) => o[0] < s[1] && s[0] < o[1])) r++;
      (rows[r] ??= []).push(s);
      d.row = r;
    }
    if (rows.length) margin[side] = st.first + (rows.length - 1) * st.step + st.size * 0.5;
    for (const d of defs) if (d.side === side && d.offset !== undefined) margin[side] = Math.max(margin[side], d.offset + st.size);
  }
  // callouts stack above the view, leaders running up-right or up-left
  const callouts = defs.filter((d) => d.kind === "callout");
  const mid = (v.box[0] + v.box[2]) / 2;
  const height = (d: DimDef) => (1 + (d.lines?.length ?? 0)) * st.size * 1.5 + 1.5;
  const widthOf = (d: DimDef) => Math.max(dimTextWidth(d.text, st.size), ...(d.lines ?? []).map((l) => textWidth(l, st.size)));
  const tally = { left: 0, right: 0 };
  const fixed: DimDef[] = [];
  const flexible: DimDef[] = [];
  for (const d of callouts) {
    const xs = (d.anchors ?? [d.circle?.c ?? d.a]).map((c) => sheetPt(c, v)[0]);
    const both = xs.some((x) => x < mid - 1e-6) && xs.some((x) => x > mid + 1e-6);
    if (d.lead && !d.anchors) fixed.push(d);
    else if (both) flexible.push(d);
    else {
      d.lead = xs[0] < mid - 1e-6 ? "left" : "right";
      fixed.push(d);
    }
  }
  // concentric callouts go to opposite sides so their leaders do not overlap
  const centreOf = (d: DimDef) => sheetPt(d.circle?.c ?? d.a, v);
  const placed: DimDef[] = [];
  for (const d of fixed) {
    const c = centreOf(d);
    const clash = placed.find((o) => o.lead === d.lead && Math.hypot(centreOf(o)[0] - c[0], centreOf(o)[1] - c[1]) < 0.5);
    if (clash && !d.anchors?.length) d.lead = d.lead === "left" ? "right" : "left";
    else if (clash && d.anchors && d.anchors.length === 1) d.lead = d.lead === "left" ? "right" : "left";
    placed.push(d);
    tally[d.lead ?? "right"] += height(d);
  }
  flexible.sort((a, b) => widthOf(b) - widthOf(a));
  for (const d of flexible) {
    d.lead = tally.left < tally.right ? "left" : "right";
    tally[d.lead] += height(d);
  }
  // leaders on nearly the same diagonal run into each other's text: move a flexible one across
  const clashes = (d: DimDef) => {
    pickAnchor(d, v);
    const k = key(d, v);
    return callouts.some((o) => o !== d && o.lead === d.lead && (pickAnchor(o, v), Math.abs(key(o, v) - k) < st.size * 1.5));
  };
  for (const d of flexible) {
    if (!clashes(d)) continue;
    const was = d.lead;
    d.lead = was === "left" ? "right" : "left";
    if (clashes(d)) {
      d.lead = was;
      pickAnchor(d, v);
    }
  }
  let left = 0;
  let right = 0;
  let top = 0;
  for (const side of ["left", "right"] as const) {
    const list = callouts.filter((d) => (d.lead ?? "right") === side);
    for (const d of list) pickAnchor(d, v);
    // rows nearest the view go to leaders that would otherwise cross the text above them
    list.sort((a, b) => (side === "right" ? key(b, v) - key(a, v) : key(a, v) - key(b, v)));
    let h = st.first - st.size;
    for (const d of list) {
      const n = 1 + (d.lines?.length ?? 0);
      d.row = h + st.size * 0.4 + ((n - 1) * st.size * 1.5) / 2;
      h += height(d);
      const S = calloutStart(d, v);
      const rise = Math.max(S[1] - (v.box[1] - d.row), 0);
      if (side === "right") right = Math.max(right, S[0] + rise + 4 + widthOf(d) + 1 - v.box[2]);
      else left = Math.max(left, v.box[0] - (S[0] - rise - 4 - widthOf(d) - 1));
    }
    if (list.length) top = Math.max(top, h);
  }
  if (callouts.length) margin.top = top;
  margin.right = Math.max(margin.right, right);
  margin.left = Math.max(margin.left, left);
  return margin;
}

/** Leader direction along which x ± y stays constant. */
const key = (d: DimDef, v: Placed) => {
  const p = calloutStart(d, v);
  return d.lead === "left" ? p[0] - p[1] : p[0] + p[1];
};

/** The callout's centre to hang the leader on: the outermost one on its side, highest first. */
function pickAnchor(d: DimDef, v: Placed) {
  if (!d.anchors?.length || !d.circle) return;
  let best = d.anchors[0];
  const score = (c: [number, number]) => {
    const p = sheetPt(c, v);
    return d.lead === "left" ? -p[0] - p[1] : p[0] - p[1];
  };
  for (const c of d.anchors) if (score(c) > score(best) + 1e-6) best = c;
  d.circle = { c: best, r: d.circle.r };
  d.a = d.b = best;
}

/** Where a callout's leader touches its circle, at 45° toward its side. */
function calloutStart(d: DimDef, v: Placed): [number, number] {
  const c = sheetPt(d.circle?.c ?? d.a, v);
  const r = (d.circle?.r ?? 0) * v.scale;
  const sx = d.lead === "left" ? -1 : 1;
  return [c[0] + sx * r * Math.SQRT1_2, c[1] - r * Math.SQRT1_2];
}

// ---------- inking ----------

/** Draws dimension text along a direction; returns its box. */
export function inkDimText(ink: Ink, t: DimText, x: number, y: number, size: number, anchor: "middle" | "start", rot: number) {
  const w = dimTextWidth(t, size);
  const a = (rot * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const at = (lx: number, ly: number): [number, number] => [x + lx * ca - ly * sa, y - lx * sa - ly * ca];
  let lx = anchor === "middle" ? -w / 2 : 0;
  if (t.boxed) lx += 0.8;
  const mw = textWidth(t.main, size);
  const p = at(lx, 0);
  ink.text(p[0], p[1], t.main, size, "start", { rot });
  if (t.boxed) {
    const c = [at(lx - 0.8, -0.35 * size), at(lx + mw + 0.8, -0.35 * size), at(lx + mw + 0.8, size * 1.05), at(lx - 0.8, size * 1.05)];
    ink.poly(c.flat(), "thin", true);
  }
  lx += mw;
  if (t.suffix) {
    const q = at(lx, 0);
    ink.text(q[0], q[1], " " + t.suffix, size, "start", { rot });
    lx += textWidth(" " + t.suffix, size);
  }
  if (t.up || t.lo) {
    const s2 = size * 0.7;
    const u = at(lx + 0.6, size * 0.45);
    const l = at(lx + 0.6, -size * 0.3);
    if (t.up) ink.text(u[0], u[1], t.up, s2, "start", { rot });
    if (t.lo) ink.text(l[0], l[1], t.lo, s2, "start", { rot });
  }
}

/** Inks one dimension and returns its sheet box. */
export function inkDim(ink: Ink, d: DimDef, v: Placed, st: DimStyle): Box {
  const start = ink.shapes.length;
  const gap = 1;
  const over = 1.5;
  const A = sheetPt(d.a, v);
  const B = sheetPt(d.b, v);
  if (d.kind === "h" || d.kind === "v") {
    const horiz = d.kind === "h";
    const side = d.side ?? (horiz ? "bottom" : "right");
    const dist = d.offset ?? st.first + (d.row ?? 0) * st.step;
    // position of the dimension line across its direction
    const line = side === "bottom" ? v.box[3] + dist : side === "top" ? v.box[1] - dist : side === "right" ? v.box[2] + dist : v.box[0] - dist;
    const k = horiz ? 0 : 1;
    const lo = Math.min(A[k], B[k]);
    const hi = Math.max(A[k], B[k]);
    // extension lines
    for (const P of [A, B]) {
      const from = horiz ? P[1] : P[0];
      const dir = Math.sign(line - from) || 1;
      if (horiz) ink.line(P[0], from + dir * gap, P[0], line + dir * over);
      else ink.line(from + dir * gap, P[1], line + dir * over, P[1]);
    }
    const tw = dimTextWidth(d.text, st.size);
    const inside = hi - lo >= 2 * st.arrow + 1.5 && hi - lo >= tw + 2;
    const pt = (s: number): [number, number] => (horiz ? [s, line] : [line, s]);
    const ext = inside ? 0 : st.arrow + 2;
    const textOutside = hi - lo < tw + 2;
    const tail = textOutside ? Math.max(ext, tw + st.arrow + 3) : ext;
    const [x1, y1] = pt(lo - (horiz ? ext : tail));
    const [x2, y2] = pt(hi + (horiz ? tail : ext));
    ink.line(x1, y1, x2, y2);
    const [ax, ay] = pt(lo);
    const [bx, by] = pt(hi);
    if (inside) {
      ink.arrow(ax, ay, horiz ? -1 : 0, horiz ? 0 : -1, st.arrow);
      ink.arrow(bx, by, horiz ? 1 : 0, horiz ? 0 : 1, st.arrow);
    } else {
      ink.arrow(ax, ay, horiz ? 1 : 0, horiz ? 0 : 1, st.arrow);
      ink.arrow(bx, by, horiz ? -1 : 0, horiz ? 0 : -1, st.arrow);
    }
    // text above the line (horizontal) or to its left reading upward (vertical)
    if (horiz) {
      const tx = textOutside ? hi + st.arrow + 2 : (lo + hi) / 2;
      inkDimText(ink, d.text, tx, line - 0.8, st.size, textOutside ? "start" : "middle", 0);
    } else {
      // sheet y grows downward: "hi" is the lower end on paper
      const ty = textOutside ? lo - st.arrow - 2 : (lo + hi) / 2;
      inkDimText(ink, d.text, line - 0.8, ty, st.size, textOutside ? "start" : "middle", 90);
    }
  } else if (d.kind === "aligned") {
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    // offset away from the view centre
    let nx = -uy;
    let ny = ux;
    const cx = (v.box[0] + v.box[2]) / 2;
    const cy = (v.box[1] + v.box[3]) / 2;
    if ((A[0] + B[0]) / 2 - cx > 0 !== nx > 0 && Math.abs(nx) > Math.abs(ny)) (nx = -nx), (ny = -ny);
    else if ((A[1] + B[1]) / 2 - cy > 0 !== ny > 0 && Math.abs(ny) >= Math.abs(nx)) (nx = -nx), (ny = -ny);
    const off = d.offset ?? st.first;
    const a2: [number, number] = [A[0] + nx * off, A[1] + ny * off];
    const b2: [number, number] = [B[0] + nx * off, B[1] + ny * off];
    ink.line(A[0] + nx * gap, A[1] + ny * gap, a2[0] + nx * over, a2[1] + ny * over);
    ink.line(B[0] + nx * gap, B[1] + ny * gap, b2[0] + nx * over, b2[1] + ny * over);
    ink.line(a2[0], a2[1], b2[0], b2[1]);
    ink.arrow(a2[0], a2[1], -ux, -uy, st.arrow);
    ink.arrow(b2[0], b2[1], ux, uy, st.arrow);
    let rot = (Math.atan2(-uy, ux) * 180) / Math.PI;
    if (rot > 90.01) rot -= 180;
    if (rot <= -90) rot += 180;
    const r = (rot * Math.PI) / 180;
    const mx = (a2[0] + b2[0]) / 2 - Math.sin(r) * 0.8;
    const my = (a2[1] + b2[1]) / 2 - Math.cos(r) * 0.8;
    inkDimText(ink, d.text, mx, my, st.size, "middle", rot);
  } else if (d.kind === "inline") {
    // a diameter drawn across the feature itself
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L;
    const uy = dy / L;
    const tw = dimTextWidth(d.text, st.size);
    ink.line(A[0], A[1], B[0], B[1]);
    const vertical = Math.abs(uy) > Math.abs(ux);
    if (L >= 2 * st.arrow + 1) {
      ink.arrow(A[0], A[1], -ux, -uy, st.arrow);
      ink.arrow(B[0], B[1], ux, uy, st.arrow);
    } else {
      ink.arrow(A[0], A[1], ux, uy, st.arrow);
      ink.arrow(B[0], B[1], -ux, -uy, st.arrow);
      ink.line(A[0], A[1], A[0] - ux * (st.arrow + 2), A[1] - uy * (st.arrow + 2));
    }
    if (vertical) {
      const top = Math.min(A[1], B[1]);
      const fits = L >= tw + 2 * st.arrow + 2;
      if (fits) inkDimText(ink, d.text, A[0] - 0.8, (A[1] + B[1]) / 2, st.size, "middle", 90);
      else {
        ink.line(A[0], top, A[0], top - tw - st.arrow - 3);
        inkDimText(ink, d.text, A[0] - 0.8, top - st.arrow - 2, st.size, "start", 90);
      }
    } else {
      const right = Math.max(A[0], B[0]);
      const fits = L >= tw + 2 * st.arrow + 2;
      if (fits) inkDimText(ink, d.text, (A[0] + B[0]) / 2, A[1] - 0.8, st.size, "middle", 0);
      else {
        ink.line(right, A[1], right + tw + st.arrow + 3, A[1]);
        inkDimText(ink, d.text, right + st.arrow + 2, A[1] - 0.8, st.size, "start", 0);
      }
    }
  } else {
    // callout: leader from the circle at 45° to a shoulder above the view
    const sx = d.lead === "left" ? -1 : 1;
    const S = calloutStart(d, v);
    const rowY = v.box[1] - (d.row ?? st.first);
    const rise = Math.max(S[1] - rowY, 0);
    const E: [number, number] = [S[0] + sx * rise, rowY];
    const C = sheetPt(d.circle?.c ?? d.a, v);
    if (rise > 0.5) {
      ink.line(S[0], S[1], E[0], E[1]);
      ink.arrow(S[0], S[1], C[0] - S[0] || -sx, C[1] - S[1] || 1, st.arrow);
    }
    ink.line(E[0], E[1], E[0] + sx * 3, E[1]);
    const n = 1 + (d.lines?.length ?? 0);
    const firstBase = rowY + st.size * 0.35 - ((n - 1) * st.size * 1.5) / 2;
    const w = Math.max(dimTextWidth(d.text, st.size), ...(d.lines ?? []).map((l) => textWidth(l, st.size)));
    const tx = sx > 0 ? E[0] + 4 : E[0] - 4 - w;
    inkDimText(ink, d.text, tx, firstBase, st.size, "start", 0);
    (d.lines ?? []).forEach((l, i) => ink.text(tx, firstBase + (i + 1) * st.size * 1.5, l, st.size));
  }
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = start; i < ink.shapes.length; i++) {
    const s = ink.shapes[i];
    const pts: number[] = s.t === "line" ? s.p : s.t === "poly" || s.t === "fill" ? s.p : s.t === "text" ? [s.at[0], s.at[1]] : [s.c[0], s.c[1]];
    for (let j = 0; j < pts.length; j += 2) {
      box[0] = Math.min(box[0], pts[j]);
      box[1] = Math.min(box[1], pts[j + 1]);
      box[2] = Math.max(box[2], pts[j]);
      box[3] = Math.max(box[3], pts[j + 1]);
    }
    if (s.t === "text") {
      const w = textWidth(s.s, s.size);
      const vert = Math.abs((s.rot ?? 0) - 90) < 1;
      if (vert) (box[0] = Math.min(box[0], s.at[0] - s.size)), (box[1] = Math.min(box[1], s.at[1] - w));
      else (box[1] = Math.min(box[1], s.at[1] - s.size)), (box[2] = Math.max(box[2], s.at[0] + w));
    }
  }
  return box;
}

