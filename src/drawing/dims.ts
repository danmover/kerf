// Dimensions: which ones a drawing gets (automatic and from the source),
// how they stack around each view, and how they are inked.

import type { EvalPart, Model } from "../core/model";
import type { ViewResult } from "../kernel/drawing";
import { vdot, vnorm, vsub, type V3 } from "../kernel/recipe";
import { applyProbes, holeCallout, holeKey, partFeatures, recipeSpan, type Feature } from "./features";
import { arcPoints } from "./hatch";
import { fmtDev, fmtNum, Ink, type Box, type Frame, type SheetDim } from "./sheet";
import { fitLimits, generalDeviation, type DrawingSpec, type WeldKind } from "./spec";
import { angleReach, applyRoughness, edgeDims, finishSize, finishText, inkAngle, inkFinish, inkWeld, markDims, symbolDims, weldSizeOnPaper } from "./annotate";
import { textWidth } from "./text";
import { partExtent, toView, type BBoxOf, type DrawingPlan } from "./views";
import { designIntent, type Intent, type Role } from "./intent";
import { squareUp } from "./square";
import { boreTol, datumBox, faceName, fcfHeight, fcfWidth, flatnessTol, gdtWanted, holePosition, inkDatum, inkFcf, runoutTol, squareTol, type DatumInfo, type Fcf } from "./gdt";

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

/** A surface texture requirement drawn as the ISO 21920-1 symbol. */
export interface Finish {
  ra?: number;
  rz?: number;
  process?: string;
  lay?: string;
  removal: "required" | "prohibited" | "any";
}

/** What a weld symbol says (ISO 2553). */
export interface WeldMark {
  kind: WeldKind;
  size?: number;
  length?: string;
  side: "arrow" | "other" | "both";
  allRound: boolean;
  field: boolean;
  note?: string;
}

export interface DimDef {
  view: number;
  /** angle: between two legs from a vertex (a); arc: a length along an arc; ordinate: a position from an origin along one view axis */
  kind: "h" | "v" | "aligned" | "inline" | "callout" | "angle" | "arc" | "ordinate";
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
  /** geometric tolerance frames under a callout's text */
  frames?: Fcf[];
  /** the datum letter this feature (or the feature of size a dimension measures) is */
  datum?: string;
  /** the features a dimension runs between ("o3.4", "2.4x26"), so its id doesn't depend on the order dimensions come in */
  tag?: string;
  /** angle: unit directions of the two legs in view space, and their lengths */
  legs?: [[number, number], [number, number]];
  lens?: [number, number];
  /** arc length: the arc in view space, angles counter-clockwise in radians */
  arc?: { c: [number, number]; r: number; a0: number; a1: number };
  /** ordinate: the view axis the value runs along */
  axis?: 0 | 1;
  /** ordinate: how far its text moves along the axis to clear its neighbours (sheet mm), set when stacking */
  shift?: number;
  /** callout: the view point the leader's arrow touches (an arc, a chamfer, a surface) instead of 45° round the circle */
  touch?: [number, number];
  /** a surface texture symbol under a callout's text, or after a dimension's */
  finish?: Finish;
  /** a weld symbol on the callout's leader in place of text */
  weld?: WeldMark;
  /** callout: each diameter it covers when it stacks several (a bore under a seat), with its own fit */
  sizes?: { d: number; fit?: string; tol?: [number, number] }[];
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

export function principalViews(plan: DrawingPlan): number[] {
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

export const close = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) < tol;

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

const framedCache = new WeakMap<Parts, Parts>();

/** The parts as the drawing shows them: a part drawn squared up is squared up in every design its dimensions are checked against. */
function framed(parts: Parts, plan: DrawingPlan): Parts {
  const p = plan.parts[0];
  if (plan.assembly || !p?.worldXf) return parts;
  let out = framedCache.get(parts);
  if (!out) {
    out = new Map(parts);
    const q = parts.get(p.id);
    if (q) out.set(p.id, squareUp(q));
    framedCache.set(parts, out);
  }
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
/** A datum on a face seen edge-on in a view: the triangle sits on the outline edge from a to b, the letter outside it. */
export interface DatumMark {
  letter: string;
  view: number;
  /** the edge in view space (model mm, y up) */
  a: [number, number];
  b: [number, number];
  /** outward from the part, in view space */
  out: [number, number];
  /** preferred spot along the edge, 0 at a and 1 at b */
  t: number;
  /** a frame beside the letter (the face's flatness) */
  frame?: Fcf;
}

export interface BuiltDims {
  dims: DimDef[];
  warnings: string[];
  /** datum symbols on faces, inked by the composer where they find room */
  marks: DatumMark[];
  datums: DatumInfo[];
  /** notes the features' functions call for */
  notes: string[];
  /** holes listed by tag in a table instead of dimensioned (hole_table: true) */
  holeTable?: HoleTable;
}

export interface HoleTableRow {
  tag: string;
  /** the hole's centre in view space, and its radius, for the tag */
  at: [number, number];
  r: number;
  /** position from the table's origin */
  x: number;
  y: number;
  size: string;
  /** the position tolerance of this tag's holes, on its first row */
  fcf?: Fcf;
}

export interface HoleTable {
  view: number;
  origin: [number, number];
  /** where X and Y are measured from */
  about: string;
  rows: HoleTableRow[];
}

export function buildDims(ctx: DimContext): BuiltDims {
  const dims: DimDef[] = [];
  const warnings: string[] = [];
  const extra: Omit<BuiltDims, "dims" | "warnings"> = { marks: [], datums: [], notes: [] };
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
    const base = probe(framed(partsOf(model), plan));
    if (base === undefined) return undefined;
    const hits = same.filter((p) => {
      const parts = nudged(model, p.name, (p.value as number) + NUDGE, reevaluate);
      const moved = parts ? probe(framed(parts, plan)) : undefined;
      return moved !== undefined && close(moved - base, NUDGE, 1e-3);
    });
    return hits.length === 1 ? hits[0].name : undefined;
  };
  const general = (v: number) => generalDeviation(spec.tolerance, v) ?? undefined;

  const push = (d: Omit<DimDef, "meta"> & { meta: Partial<DimDef["meta"]> & { label: string } }) => {
    const meta: DimDef["meta"] = {
      kind: d.kind === "callout" ? "callout" : d.kind === "inline" ? "diameter" : d.kind === "angle" || d.kind === "arc" || d.kind === "ordinate" ? d.kind : "linear",
      auto: true,
      general: d.text.suffix || d.text.up || d.text.boxed || d.kind === "angle" ? undefined : general(d.value),
      ...d.meta,
    };
    dims.push({ ...d, meta });
  };

  if (spec.autoDims) {
    if (plan.assembly) assemblyDims(ctx, push, paramFor);
    else partDims(ctx, push, paramFor, warnings, dims, extra);
  }
  explicitDims(ctx, push, warnings);
  markDims(ctx, push, warnings);
  symbolDims(ctx, push, warnings);
  const out = dropCoveredOveralls(mergeExplicit(dims), ctx.ext);
  assignIds(out, plan);
  applyTols(out, spec.tols, warnings);
  applyFrames(out, spec.frames ?? [], warnings);
  applyRoughness(out, spec, warnings);
  return { dims: out, warnings, ...extra };
}

/** Ordinates running edge to edge already give the overall size along their axis in that view. */
function dropCoveredOveralls(dims: DimDef[], ext: [number, number, number, number][]): DimDef[] {
  const covered = new Set<string>();
  for (const d of dims) {
    if (d.kind !== "ordinate" || d.axis === undefined || !d.meta.auto) continue;
    const e = ext[d.view];
    if (!e) continue;
    const k = d.axis;
    const at = d.value + (k === 0 ? d.b[0] : d.b[1]);
    if (close(at, e[k], 0.05)) covered.add(`${d.view}|${k}|lo`);
    if (close(at, e[k + 2], 0.05)) covered.add(`${d.view}|${k}|hi`);
  }
  return dims.filter((d) => {
    if (!d.meta.auto || (d.kind !== "h" && d.kind !== "v")) return true;
    const k = d.kind === "h" ? 0 : 1;
    if (!covered.has(`${d.view}|${k}|lo`) || !covered.has(`${d.view}|${k}|hi`)) return true;
    const e = ext[d.view];
    return !(close(Math.min(d.a[k], d.b[k]), e[k], 0.05) && close(Math.max(d.a[k], d.b[k]), e[k + 2], 0.05));
  });
}

/** gdt() calls in the drawing block set or replace the frames on automatic dimensions and callouts. */
function applyFrames(dims: DimDef[], frames: DrawingSpec["frames"], warnings: string[]) {
  for (const g of frames) {
    const d = dims.find((x) => x.meta.id === g.id);
    if (!d) {
      warnings.push(`gdt("${g.id}"): there is no dimension or callout with that id on this drawing`);
      continue;
    }
    const f: Fcf = { kind: g.kind, tol: g.tol, dia: g.kind === "position" || g.kind === "coaxiality" || (g.kind === "perpendicularity" && d.kind === "callout"), mmc: g.mmc, datums: g.datums };
    const list = (d.frames ?? []).filter((x) => x.kind !== g.kind);
    if (d.kind === "callout") d.frames = [...list, f];
    else {
      // a frame on a linear dimension makes it basic, the frame then holds the tolerance
      d.frames = [...list, f];
      d.text = { main: d.text.main, boxed: true };
    }
    d.meta = { ...d.meta, auto: d.meta.auto, span: g.span, general: undefined };
  }
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

/** Puts a tolerance after the diameter it belongs to in a callout's lines, replacing one already there. */
function tolInCallout(d: DimDef, dia: number, text: string) {
  const s = fmtNum(dia);
  const re = new RegExp(`Ø${s.replace(".", "\\.")}(?![\\d.])(?: (?:[A-Za-z]{1,2}\\d{1,2}(?: \\([^)]*\\))?|±[\\d.]+|[+−][\\d.]+/[+−]?[\\d.]+))?`);
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

export type Push = (d: Omit<DimDef, "meta"> & { meta: Partial<DimDef["meta"]> & { label: string } }) => void;

const AXES: { v: V3; name: string; word: string }[] = [
  { v: [1, 0, 0], name: "X", word: "width" },
  { v: [0, 1, 0], name: "Y", word: "depth" },
  { v: [0, 0, 1], name: "Z", word: "height" },
];

function overallDims(ctx: DimContext, push: Push, paramFor: ParamFor, skip: Set<string>, what: string, ids: string[]) {
  // a full section stands in for the view it replaced when no other view shows that size
  const views = [...principalViews(ctx.plan), ...ctx.plan.views.flatMap((v, i) => (v.kind === "section" ? [i] : []))];
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
  // an auxiliary view is where features drilled at an angle show true size
  for (const vi of [...principalViews(ctx.plan), ...ctx.plan.views.flatMap((v, i) => (v.kind === "aux" ? [i] : []))]) if (Math.abs(vdot(ctx.plan.views[vi].frame.dir, dir)) > 0.999) return vi;
  return -1;
}

type Extra = Omit<BuiltDims, "dims" | "warnings">;

function partDims(ctx: DimContext, push: Push, paramFor: ParamFor, warnings: string[], dims: DimDef[], extra: Extra) {
  const part = ctx.plan.parts[0];
  if (!part) return;
  const what = part.label;
  const extent = partExtent(part, ctx.bboxOf);
  const feats = partFeatures(part, extent);
  // the kernel's probe lines settle through or blind where the recipe cannot
  if (ctx.plan.probes) applyProbes(feats, ctx.plan.probes.segs, ctx.results[ctx.plan.probes.view]?.probes);
  const turned = feats.find((f): f is Extract<Feature, { t: "turned" }> => f.t === "turned" && f.part === part.id);
  // what each feature is for, read from the parts around this one
  const intent = designIntent(part, ctx.model, feats);
  const gdt = part.kind === "part" && !part.gear && gdtWanted(ctx.spec, intent.family);
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
  const addGroup = (vi: number, list: Feature[], centers: [number, number][], track?: Anchor["at"][], tagged?: string) => {
    const groups = anchors.get(vi) ?? [];
    const same = (a: Anchor[], b: [number, number][]) => a.length === b.length && a.every(({ c }) => b.some((d) => close(c[0], d[0], 0.01) && close(c[1], d[1], 0.01)));
    const frame = ctx.plan.views[vi].frame;
    const tag = tagged ?? featureTag(list[0]);
    const twin = groups.find((g) => same(g, centers));
    // concentric features share the group, and their sizes together name it
    if (twin) for (const a of twin) a.tag = a.tag.split("-").includes(tag) ? a.tag : `${a.tag}-${tag}`;
    else groups.push(centers.map((c, k) => ({ c, at: track?.[k] ?? trackFeature(part.id, feats.indexOf(list[k]), frame), tag })));
    anchors.set(vi, groups);
  };

  // callouts are collected first so concentric ones can share a leader
  type Callout = { vi: number; centers: [number, number][]; order: number; size: number; lines: string[]; r: number; label: string; param?: string; value: number; feats: Feature[]; role?: Role; fit?: { code: string; tol: [number, number] }; slot?: boolean; leader?: [number, number]; finish?: Finish };
  const callouts: Callout[] = [];
  const roleOf = (f: Feature) => intent.roles.get(feats.indexOf(f));
  /** "H7 (+0.018/0)" after the diameter, the role line and its surface texture symbol, for a feature with a function */
  const withRole = (c: Callout) => {
    const role = c.role;
    if (!role) return;
    if (role.ra) c.finish = { ra: role.ra, removal: "required" };
    c.lines.push(role.text);
    if (!role.fit) return;
    const lim = fitLimits(role.fit, c.value);
    if (!lim) return;
    c.fit = { code: role.fit, tol: [lim.upper, lim.lower] };
    const dia = `Ø${fmtNum(c.value, c.value < 10 ? 2 : 1)}`;
    const fit = `${role.fit} (${fmtDev(lim.upper)}/${fmtDev(lim.lower)})`;
    c.lines = c.lines.map((l, i) => (i === 0 || l.startsWith("TAP") ? l.replace(dia, `${dia} ${fit}`) : l));
  };
  // a blind cut that opens on the side of the part away from the view
  const farSide = (at: V3, dir: V3, h: number, vi: number) => {
    const v = ctx.plan.views[vi].frame.dir;
    const [lo, hi] = extent(v);
    const s0 = vdot(at, v);
    const s1 = s0 + h * vdot(dir, v);
    return Math.max(s0, s1) < hi - 0.02 && Math.min(s0, s1) <= lo + 0.02;
  };

  // rows of overlapping holes or bores cut one after another make one slot, straight or on an arc
  const chained = new Set<number>();
  for (const ch of slotChains(ctx, feats)) {
    for (const i of ch.members) chained.add(i);
    const f0 = feats[ch.members[0]] as RoundCut;
    const frame = ctx.plan.views[ch.vi].frame;
    const depth = cutDepth(f0, extent);
    const deep = f0.through || depth === null ? "THRU" : `× ${fmtNum(depth, 1)} DEEP${farSide(f0.at, f0.dir, depth, ch.vi) ? " FAR SIDE" : ""}`;
    const w = fmtNum(f0.d, f0.d < 10 ? 2 : 1);
    const ends = [ch.members[0], ch.members[ch.members.length - 1]].map((i) => toView((feats[i] as RoundCut).at, frame));
    const lead = ends[0][0] + ends[0][1] >= ends[1][0] + ends[1][1] ? ends[0] : ends[1];
    const track = (i: number) => trackFeature(part.id, i, frame);
    let c: Callout;
    if (ch.kind === "arc") {
      const [i0, im, i1] = [ch.members[0], ch.members[Math.floor(ch.members.length / 2)], ch.members[ch.members.length - 1]].map(track);
      const pivot: Anchor["at"] = (parts) => {
        const [a, b, d] = [i0(parts), im(parts), i1(parts)];
        return a && b && d ? (circumcentre(a, b, d) ?? undefined) : undefined;
      };
      const span = ch.sweep >= 359.5 ? "360°" : `${fmtNum(ch.sweep, 1)}° (${fmtNum(ch.from, 1)}° TO ${fmtNum(ch.from + ch.sweep, 1)}°)`;
      c = { vi: ch.vi, centers: [ch.centre], order: 1, size: f0.d, lines: [`ARC SLOT ${w} WIDE ${deep}`, `R${fmtNum(ch.r)} × ${span}`], r: f0.d / 2, value: f0.d, label: `Arc slot ${w} wide, R${fmtNum(ch.r)} in ${what}`, feats: [f0], slot: true, leader: lead };
      callouts.push(c);
      addGroup(ch.vi, [f0], [ch.centre], [pivot], `arc${fmtNum(ch.r)}`);
    } else {
      const [ia, ib] = [ch.members[0], ch.members[ch.members.length - 1]].map(track);
      const mid: Anchor["at"] = (parts) => {
        const [a, b] = [ia(parts), ib(parts)];
        return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : undefined;
      };
      const len = fmtNum(ch.length + f0.d);
      const tilt = ((ch.angle % 180) + 180) % 180;
      const square = close(tilt, 0, 0.05) || close(tilt, 90, 0.05) || close(tilt, 180, 0.05);
      c = { vi: ch.vi, centers: [ch.centre], order: 1, size: f0.d, lines: [`SLOT ${w} × ${len} ${deep}`, ...(square ? [] : [`AT ${fmtNum(tilt, 1)}°`])], r: f0.d / 2, value: f0.d, label: `Slot ${w} × ${len} in ${what}`, feats: [f0], slot: true, leader: lead };
      callouts.push(c);
      addGroup(ch.vi, [f0], [ch.centre], [mid], `slot${w}`);
    }
  }

  // holes, grouped into "n×" callouts
  const groups = new Map<string, Extract<Feature, { t: "hole" }>[]>();
  feats.forEach((f, i) => f.t === "hole" && !chained.has(i) && groups.set(holeKey(f), [...(groups.get(holeKey(f)) ?? []), f]));
  for (const list of groups.values()) {
    const vi = viewAlong(ctx, list[0].dir);
    if (vi < 0) continue;
    const frame = ctx.plan.views[vi].frame;
    const centers = list.map((h) => toView(h.at, frame));
    const lines = holeCallout(list[0], (n) => fmtNum(n, n < 10 ? 2 : 1));
    if (!list[0].through && farSide(list[0].at, list[0].dir, list[0].depth, vi)) lines[0] += " FAR SIDE";
    const r = list[0].d / 2;
    const c: Callout = { vi, centers, order: 0, size: list[0].d, lines, r, value: list[0].d, label: `${list.length > 1 ? `${list.length} holes` : "Hole"} Ø${fmtNum(list[0].d)} in ${what}`, feats: list, role: roleOf(list[0]) };
    withRole(c);
    callouts.push(c);
    addGroup(vi, list, centers);
  }

  // cut and added cylinders: bores, seats and bosses
  const cyls = new Map<string, Extract<Feature, { t: "cyl" }>[]>();
  for (const [i, f] of feats.entries()) {
    if (f.t !== "cyl" || chained.has(i)) continue;
    const k = [f.op, f.d.toFixed(3), f.op === "cut" ? (f.through ? "T" : f.h.toFixed(2)) : "", f.dir.map((v) => Math.round(Math.abs(v) * 1000)).join(","), roleOf(f)?.text ?? ""].join("|");
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
    const c: Callout = { vi, centers, order: f0.op === "cut" ? 1 : 2, size: f0.d, lines: [main], r: f0.d / 2, value: f0.d, label: `${f0.op === "add" ? "Boss" : "Bore"} Ø${fmtNum(f0.d)} in ${what}`, param: paramFor(f0.d, dia), feats: list, role: roleOf(f0) };
    withRole(c);
    callouts.push(c);
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
    callouts.push({ vi, centers, order: 1, size: Math.min(s.w, s.h), lines: [main], r: Math.min(s.w, s.h) / 2, value: s.w, label: `${isSlot ? "Slot" : "Pocket"} ${size} in ${what}`, feats: list });
    addGroup(vi, list, centers);
  }

  // the datum reference frame: the view that sees most features end-on carries it
  let main = -1;
  let most = 0;
  for (const [vi, gs] of anchors) {
    const n = gs.reduce((a, g) => a + g.length, 0);
    if (n > most) {
      most = n;
      main = vi;
    }
  }
  const sameSet = (a: [number, number][], b: [number, number][]) => a.length === b.length && a.every((c) => b.some((d) => close(c[0], d[0], 0.01) && close(c[1], d[1], 0.01)));
  const frameDatums: string[] = [];
  /** callout sets (by their centres) that are datum features, and their letter */
  const datumSets: { centers: [number, number][]; letter: string }[] = [];
  const modes = main >= 0 ? axisModes(ctx.ext[main], (anchors.get(main) ?? []).map((g) => g.map((a) => a.c))) : null;
  if (gdt && main >= 0 && modes && !turned) {
    datumFrame(ctx, part, feats, main, modes, callouts.filter((c) => !c.slot), dims, extra, frameDatums, datumSets, intent.family, extent);
  }

  // the hole table, when the block asks for one: in the view that sees most features end-on, from the same origin the dimensions would use
  const table =
    ctx.spec.holeTable && main >= 0 && !turned
      ? { view: main, origin: [modes?.[0].value ?? ctx.ext[main][0], modes?.[1].value ?? ctx.ext[main][1]] as [number, number], letters: 0, rows: [] as Omit<HoleTableRow, "x" | "y">[], tabled: [] as [number, number][] }
      : null;

  // one leader per set of concentric features: holes first, then bores by size, then bosses
  const used = new Set<Callout>();
  for (const c of callouts) {
    if (used.has(c)) continue;
    const set = callouts.filter((o) => !used.has(o) && o.vi === c.vi && !!o.slot === !!c.slot && sameSet(o.centers, c.centers)).sort((a, b) => a.order - b.order || a.size - b.size);
    for (const o of set) used.add(o);
    const lines = set.flatMap((o) => o.lines);
    if (c.centers.length > 1) lines[0] = `${c.centers.length}× ${lines[0]}`;
    const rep = repIndex(c.centers);
    const big = set.reduce((a, b) => (b.r > a.r ? b : a));
    // geometric tolerances for the pattern in the datum view
    let frames: Fcf[] | undefined;
    let datum: string | undefined;
    if (gdt && c.vi === main && frameDatums.length) {
      datum = c.slot ? undefined : datumSets.find((d) => sameSet(d.centers, c.centers))?.letter;
      const seat = set.some((o) => o.role?.kind === "bearing" || o.role?.kind === "dowel");
      // the first datum feature after the face is held square to it; a later one is positioned from the datums before it
      const k = datum ? frameDatums.indexOf(datum) : -1;
      if (datum && k <= 1) frames = [{ kind: "perpendicularity", tol: squareTol(intent.family), dia: true, datums: frameDatums.slice(0, 1) }];
      else if (datum) frames = [{ kind: "position", tol: boreTol(intent.family, seat), dia: true, datums: frameDatums.slice(0, k) }];
      else {
        const hole = set.find((o) => o.feats[0].t === "hole" && !o.slot);
        const pos = hole && !seat ? holePosition(hole.feats[0] as Extract<Feature, { t: "hole" }>, intent.family) : { tol: boreTol(intent.family, seat), mmc: false };
        const slot = set.every((o) => o.slot || o.feats[0].t === "slot");
        frames = [{ kind: "position", tol: pos.tol, dia: !slot, mmc: pos.mmc || undefined, datums: frameDatums.filter((d) => c.slot || !datumSets.some((x) => x.letter === d && sameSet(x.centers, c.centers))) }];
      }
    }
    const fit = set.find((o) => o.fit)?.fit;
    const role = set.find((o) => o.role)?.role;
    const finish = set.find((o) => o.finish)?.finish;
    // a hole table lists the holes of the datum view by tag, instead of a callout and position dimensions for each pattern
    const round = set.every((o) => o.feats[0].t === "hole" || (o.feats[0].t === "cyl" && o.feats[0].op === "cut"));
    if (table && c.vi === table.view && !c.slot && !datum && round) {
      const letter = String.fromCharCode(65 + table.letters++);
      const size = set.flatMap((o) => o.lines).join(" ") + (finish ? ` ${finishText(finish)}` : "");
      const order = [...c.centers].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
      order.forEach((p, k) => table.rows.push({ tag: `${letter}${k + 1}`, at: p, r: big.r, size, fcf: k === 0 ? frames?.[0] : undefined }));
      table.tabled.push(...c.centers);
      continue;
    }
    const at = c.leader ?? c.centers[rep];
    push({ view: c.vi, kind: "callout", a: at, b: at, value: set[0].value, text: { main: lines[0] }, lines: lines.slice(1), circle: { c: at, r: big.r }, anchors: c.leader ? [at] : c.centers, frames, datum, finish, sizes: set.length > 1 ? set.map((o) => ({ d: o.value, fit: o.fit?.code, tol: o.fit?.tol })) : undefined, meta: { label: set.map((o) => o.label).join(" + "), part: part.id, param: set.length === 1 ? set[0].param : undefined, fit: fit?.code, tol: fit?.tol, general: fit ? undefined : undefined, role: role?.text, finish: finish ? finishText(finish) : undefined } });
  }
  if (table?.rows.length) {
    // tabled holes are located by the table, from its origin
    const gone = (c: [number, number]) => table.tabled.some((t) => close(t[0], c[0], 0.01) && close(t[1], c[1], 0.01));
    anchors.set(
      table.view,
      (anchors.get(table.view) ?? []).map((g) => g.filter((a) => !gone(a.c))).filter((g) => g.length),
    );
    const [ox, oy] = table.origin;
    const where = (m: AxisMode, k: 0 | 1) => (m.mode === "centre" ? `the ${k ? "middle" : "centre"} of the part` : m.mode === "origin" ? "the design origin" : k ? "the lower edge" : "the left edge");
    extra.holeTable = {
      view: table.view,
      origin: table.origin,
      about: modes ? `X from ${where(modes[0], 0)}, Y from ${where(modes[1], 1)}` : "X and Y from the lower left corner",
      rows: table.rows.map((r) => ({ ...r, x: r.at[0] - ox, y: r.at[1] - oy })),
    };
  }

  // positions of the end-on features: basic where a frame holds their tolerance
  for (const [vi, gs] of anchors) positionDims(ctx, vi, gs, push, paramFor, warnings, what, gdt && vi === main && frameDatums.length > 0);

  // fillets, rounded corners, chamfers and sloped edges the views show
  edgeDims(ctx, part, feats, push, what, extra.notes);

  // the distance between axes that carry meshing gears sets their backlash: dimension it directly
  for (const cp of intent.centres) {
    const vi = viewAlong(ctx, cp.dir);
    if (vi < 0) continue;
    const frame = ctx.plan.views[vi].frame;
    const a = toView(cp.a, frame);
    const b = toView(cp.b, frame);
    const du = Math.abs(b[0] - a[0]);
    const dv = Math.abs(b[1] - a[1]);
    const kind = dv < 1e-4 ? "h" : du < 1e-4 ? "v" : "aligned";
    const basic = gdt && vi === main && frameDatums.length > 0;
    const label = `Gear centre distance (${cp.gears.join("–")}) in ${what}`;
    const text: DimText = basic ? { main: fmtNum(cp.value), boxed: true } : { main: fmtNum(cp.value), suffix: `±${fmtNum(cp.tol)}` };
    const tol: [number, number] | undefined = basic ? undefined : [cp.tol, -cp.tol];
    // the same span may already be a spacing dimension: give that one the function instead
    const twin = kind !== "aligned" && dims.find((d) => d.view === vi && d.kind === kind && close(Math.abs(d.value), cp.value, 0.01) && [d.a, d.b].every((p) => [a, b].some((q) => close(p[kind === "h" ? 0 : 1], q[kind === "h" ? 0 : 1], 0.01))));
    if (twin) {
      twin.text = text;
      twin.meta = { ...twin.meta, label, tol, general: undefined };
    } else push({ view: vi, kind, a, b, value: cp.value, text, side: kind === "h" ? "bottom" : kind === "v" ? "right" : undefined, tag: `${cp.gears.join("-")}`, meta: { label, tol } });
    const general = generalDeviation(ctx.spec.tolerance, cp.value);
    if (!basic && general !== null && general > cp.tol + 1e-9) warnings.push(`The ${cp.gears.join("/")} gear centre distance needs ±${fmtNum(cp.tol)} to keep its ${fmtNum(cp.backlash)} mm backlash; the ${ctx.spec.tolerance} general tolerance is ±${fmtNum(general)}, so check the mesh after making it or add backlash`);
    extra.notes.push(`GEAR CENTRE DISTANCES SET THE BACKLASH: HOLD THEIR TOLERANCE.`);
  }

  // turned profile: length and diameters on the side view
  if (turned) {
    const ti = feats.indexOf(turned);
    turnedDims(
      ctx,
      turned,
      push,
      paramFor,
      what,
      (parts) => {
        const f = featuresOf(parts.get(part.id))[ti];
        return f?.t === "turned" ? f : undefined;
      },
      intent,
      gdt,
      extra,
    );
  }
  if (part.gear && part.recipe.base?.t === "gear") gearDims(ctx, part, push, what);
  extra.notes = [...new Set(extra.notes)];
}

type Modes = [AxisMode, AxisMode];
/** How the features in a view are located along one view axis: from the part's centre, the design origin, or the lower edge. */
type AxisMode = { mode: "centre" | "origin" | "edge"; value: number };

/** The datum each view axis is dimensioned from, the same choice positionDims makes. */
function axisModes(ext: [number, number, number, number], groups: [number, number][][]): Modes {
  const centers = groups.flat();
  return [0, 1].map((axis) => {
    const lo = ext[axis];
    const hi = ext[axis + 2];
    const mid = (lo + hi) / 2;
    const vals = uniq(centers.map((c) => c[axis]));
    if (vals.length && vals.every((v) => vals.some((w) => close(w, 2 * mid - v, 0.02)))) return { mode: "centre", value: mid };
    if (lo < 1e-6 && hi > -1e-6 && vals.some((v) => close(v, 0, 0.01))) return { mode: "origin", value: 0 };
    return { mode: "edge", value: lo };
  }) as Modes;
}

/**
 * Picks datums A, B and C for a prismatic part and attaches their symbols:
 * A is the face the main features run square to (the face a shell is closed
 * on, or the one most holes come out of: the face that seats on the mating
 * part), B and C follow the way the features are dimensioned in the main
 * view (a centre plane, the bore on the origin, or an edge).
 */
function datumFrame(
  ctx: DimContext,
  part: EvalPart,
  feats: Feature[],
  main: number,
  modes: Modes,
  callouts: { vi: number; centers: [number, number][]; size: number; feats: Feature[]; role?: Role }[],
  dims: DimDef[],
  extra: Extra,
  letters: string[],
  datumSets: { centers: [number, number][]; letter: string }[],
  family: Intent["family"],
  extent: (dir: V3) => [number, number],
) {
  const mv = ctx.plan.views[main];
  const n = mv.frame.dir;
  // A: which end of the main axis
  const shell = feats.find((f): f is Extract<Feature, { t: "shell" }> => f.t === "shell");
  let sign = 0;
  if (shell && Math.abs(vdot(vnorm(shell.open), n)) > 0.999) sign = -Math.sign(vdot(shell.open, n));
  else {
    let s = 0;
    for (const f of feats) if ((f.t === "hole" || (f.t === "cyl" && f.op === "cut") || f.t === "slot") && Math.abs(vdot(f.dir, n)) > 0.999) s += Math.sign(vdot(f.dir, n));
    sign = s > 0 ? 1 : -1;
  }
  const nA: V3 = [n[0] * sign, n[1] * sign, n[2] * sign];
  // datum letters skip the ones sections and details use, and I, O and Q
  const used = new Set(ctx.plan.views.filter((v) => v.kind === "section" || v.kind === "detail" || v.kind === "aux").map((v) => v.name.toUpperCase()));
  const free = "ABCDEFGHJKLMNPRSTUVWXYZ".split("").filter((l) => !used.has(l));
  const [LA, LB, LC] = free;
  const [lo, hi] = extent(nA);
  const size = Math.max(...[0, 1].map((k) => ctx.ext[main][k + 2] - ctx.ext[main][k]));
  // a view (or a section) that sees face A edge-on
  let placed = false;
  for (const vi of [...principalViews(ctx.plan), ...ctx.plan.views.flatMap((v, i) => (v.kind === "section" ? [i] : []))]) {
    const f = ctx.plan.views[vi].frame;
    if (vi === main || Math.abs(vdot(f.dir, nA)) > 1e-6) continue;
    const [u0, v0, u1, v1] = ctx.ext[vi];
    const hx = vdot(f.x, nA);
    const hy = vdot(f.y, nA);
    if (Math.abs(hx) < 0.999 && Math.abs(hy) < 0.999) continue;
    // the coordinate of the face in this view: the part's extreme along nA
    const at = hi;
    const mark: DatumMark =
      Math.abs(hx) > 0.999
        ? { letter: LA, view: vi, a: [at * Math.sign(hx), v0], b: [at * Math.sign(hx), v1], out: [Math.sign(hx), 0], t: 0.35 }
        : { letter: LA, view: vi, a: [u0, at * Math.sign(hy)], b: [u1, at * Math.sign(hy)], out: [0, Math.sign(hy)], t: 0.35 };
    mark.frame = { kind: "flatness", tol: flatnessTol(family, size), dia: false, datums: [] };
    extra.marks.push(mark);
    placed = true;
    break;
  }
  if (!placed) return;
  void lo;
  letters.push(LA);
  extra.datums.push({ letter: LA, what: `${faceName(nA)} face, the face the part seats on` });

  const groups = callouts.filter((c) => c.vi === main);
  const at = (c: { centers: [number, number][] }, u: number, v: number) => c.centers.some((p) => close(p[0], u, 0.01) && close(p[1], v, 0.01));
  const biggest = (list: typeof groups) => list.reduce<(typeof groups)[number] | undefined>((a, b) => (!a || b.size > a.size ? b : a), undefined);
  const edge = (axis: 0 | 1, letter: string) => {
    const [u0, v0, u1, v1] = ctx.ext[main];
    extra.marks.push(axis === 0 ? { letter, view: main, a: [u0, v0], b: [u0, v1], out: [-1, 0], t: 0.3 } : { letter, view: main, a: [u0, v0], b: [u1, v0], out: [0, -1], t: 0.7 });
    const world: V3 = axis === 0 ? mv.frame.x : mv.frame.y;
    extra.datums.push({ letter, what: `${faceName([-world[0], -world[1], -world[2]])} face` });
    letters.push(letter);
  };
  const centrePlane = (axis: 0 | 1, letter: string): boolean => {
    const world = axis === 0 ? mv.frame.x : mv.frame.y;
    const name = AXES.find((a) => Math.abs(vdot(a.v, world)) > 0.999)?.name;
    const d = dims.find((x) => x.meta.label.startsWith("Overall") && x.meta.label.includes(`(${name})`));
    if (!d) return false;
    d.datum = letter;
    extra.datums.push({ letter, what: `centre plane of the overall ${AXES.find((a) => a.name === name)!.word}` });
    letters.push(letter);
    return true;
  };
  const feature = (c: (typeof groups)[number], letter: string) => {
    datumSets.push({ centers: c.centers, letter });
    const f = c.feats[0];
    const d = "d" in f ? `Ø${fmtNum(f.d)} ` : "";
    extra.datums.push({ letter, what: `axis of the ${d}${c.role ? c.role.text.toLowerCase() : f.t === "hole" ? "hole" : "bore"}` });
    letters.push(letter);
  };

  // the bore on the origin locates both ways: it is B, and the next bore (or an edge) clocks the part as C
  const onOrigin = modes[0].mode === "origin" && modes[1].mode === "origin" ? biggest(groups.filter((c) => c.centers.length === 1 && at(c, 0, 0) && c.feats[0].t !== "slot")) : undefined;
  if (onOrigin) {
    feature(onOrigin, LB);
    const next = biggest(groups.filter((c) => c !== onOrigin && c.centers.length === 1 && !at(c, 0, 0) && (c.role || (c.feats[0].t === "cyl" && (c.feats[0] as Extract<Feature, { t: "cyl" }>).op === "cut"))));
    if (next) feature(next, LC);
    else edge(1, LC);
    return;
  }
  ([0, 1] as const).forEach((axis, k) => {
    const letter = k === 0 ? LB : LC;
    const m = modes[axis];
    if (m.mode === "centre" && centrePlane(axis, letter)) return;
    // located from the bore on the origin along this axis: that bore is the datum
    if (m.mode === "origin") {
      const c = biggest(groups.filter((g) => g.centers.length === 1 && close(g.centers[0][axis], 0, 0.01) && g.feats[0].t !== "slot" && !datumSets.some((d) => d.centers === g.centers)));
      if (c) return feature(c, letter);
    }
    edge(axis, letter);
  });
}

type RoundCut = Extract<Feature, { t: "hole" }> | Extract<Feature, { t: "cyl" }>;

/** How deep a blind hole or cut cylinder goes into the part; null when it runs through. */
function cutDepth(f: RoundCut, extent: (dir: V3) => [number, number]): number | null {
  if (f.t === "hole") return f.through ? null : f.depth;
  if (f.through) return null;
  const [lo, hi] = extent(f.dir);
  const start = vdot(f.at, f.dir);
  return Math.min(start + f.h, hi) - Math.max(start, lo);
}

/** Centre of the circle through three points, or null when they are in a line. */
export function circumcentre(a: [number, number], b: [number, number], c: [number, number]): [number, number] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

/** A slot cut as a row of overlapping holes or cylinders: its members in order along it, and its shape in the view. */
type ChainShape = { centre: [number, number] } & ({ kind: "straight"; length: number; angle: number } | { kind: "arc"; r: number; from: number; sweep: number });
export type SlotChain = ChainShape & { vi: number; members: number[] };

/**
 * Rows of three or more identical round cuts at the same depth, each
 * overlapping the next, that run along a line or an arc: the way a slot is
 * often modelled (a loop of cylinders). Each becomes one slot instead of a
 * dozen holes with a dimension apiece.
 */
export function slotChains(ctx: DimContext, feats: Feature[]): SlotChain[] {
  const out: SlotChain[] = [];
  const buckets = new Map<string, number[]>();
  feats.forEach((f, i) => {
    let k: string | null = null;
    if (f.t === "hole" && !f.thread) k = `h|${holeKey(f)}`;
    else if (f.t === "cyl" && f.op === "cut") k = ["c", f.part, f.d.toFixed(3), f.through ? "T" : f.h.toFixed(2), f.dir.map((v) => Math.round(v * 1000)).join(",")].join("|");
    if (!k) return;
    const r = f as RoundCut;
    k += `|${vdot(r.at, vnorm(r.dir)).toFixed(2)}`;
    buckets.set(k, [...(buckets.get(k) ?? []), i]);
  });
  for (const idx of buckets.values()) {
    if (idx.length < 3) continue;
    const f0 = feats[idx[0]] as RoundCut;
    const vi = viewAlong(ctx, f0.dir);
    if (vi < 0) continue;
    const frame = ctx.plan.views[vi].frame;
    const pts = idx.map((i) => toView((feats[i] as RoundCut).at, frame));
    const dist = (a: number, b: number) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
    const seen = new Set<number>();
    for (let s0 = 0; s0 < idx.length; s0++) {
      if (seen.has(s0)) continue;
      // the cuts that overlap one another, one after the next
      const comp: number[] = [];
      const stack = [s0];
      seen.add(s0);
      while (stack.length) {
        const x = stack.pop()!;
        comp.push(x);
        for (let y = 0; y < idx.length; y++) if (!seen.has(y) && dist(x, y) < f0.d - 1e-6) (seen.add(y), stack.push(y));
      }
      if (comp.length < 3) continue;
      const ch = chainShape(comp.map((k) => pts[k]), f0.d);
      if (ch) out.push({ ...ch.shape, vi, members: ch.order.map((k) => idx[comp[k]]) });
    }
  }
  return out;
}

/** The line or arc a row of centres runs along, and their order along it; null for any other path. */
function chainShape(pts: [number, number][], d: number): { order: number[]; shape: ChainShape } | null {
  const tol = Math.max(0.01, d * 0.002);
  let fa = 0;
  let fb = 1;
  let far = -1;
  for (let a = 0; a < pts.length; a++)
    for (let b = a + 1; b < pts.length; b++) {
      const l = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
      if (l > far) [fa, fb, far] = [a, b, l];
    }
  const [A, B] = [pts[fa], pts[fb]];
  const u: [number, number] = [(B[0] - A[0]) / far, (B[1] - A[1]) / far];
  const off = (p: [number, number]) => Math.abs((p[0] - A[0]) * u[1] - (p[1] - A[1]) * u[0]);
  const steps = (order: number[]) => order.every((k, i) => i === 0 || Math.hypot(pts[k][0] - pts[order[i - 1]][0], pts[k][1] - pts[order[i - 1]][1]) < d - 1e-6);
  if (pts.every((p) => off(p) < tol)) {
    const order = pts.map((_, k) => k).sort((a, b) => (pts[a][0] - A[0]) * u[0] + (pts[a][1] - A[1]) * u[1] - ((pts[b][0] - A[0]) * u[0] + (pts[b][1] - A[1]) * u[1]));
    if (!steps(order)) return null;
    return { order, shape: { kind: "straight", centre: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], length: far, angle: (Math.atan2(u[1], u[0]) * 180) / Math.PI } };
  }
  // an arc: the circle through the ends and the point furthest from their chord
  let m = 0;
  for (let k = 0; k < pts.length; k++) if (off(pts[k]) > off(pts[m])) m = k;
  const c = circumcentre(A, pts[m], B);
  if (!c) return null;
  const r = Math.hypot(A[0] - c[0], A[1] - c[1]);
  if (!pts.every((p) => Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - r) < tol)) return null;
  const ang = pts.map((p) => Math.atan2(p[1] - c[1], p[0] - c[0]));
  const sorted = ang.map((a, k) => ({ a, k })).sort((x, y) => x.a - y.a);
  // the slot spans everything but the widest gap between neighbours
  let gap = -1;
  let after = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1].a : sorted[0].a + 2 * Math.PI;
    if (next - sorted[i].a > gap) [gap, after] = [next - sorted[i].a, (i + 1) % sorted.length];
  }
  const order = [...sorted.slice(after), ...sorted.slice(0, after)].map((x) => x.k);
  const ring = gap < d / r;
  if (!ring && !steps(order)) return null;
  const deg = (a: number) => (a * 180) / Math.PI;
  let from = deg(ang[order[0]]);
  if (from > 180) from -= 360;
  const sweep = ring ? 360 : 360 - deg(gap);
  return { order, shape: { kind: "arc", centre: c, r, from, sweep } };
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
function positionDims(ctx: DimContext, vi: number, anchorGroups: Anchor[][], push: Push, paramFor: ParamFor, warnings: string[], what: string, basic = false) {
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
    const tagAtVal = (val: number) => all.find((x) => close(x.c[axis], val, 0.01))?.tag;
    /** where a dimension end lands in a changed design: on its feature, the origin, or the moved outline */
    const dir = axis === 0 ? frame.x : frame.y;
    const endIn = (val: number, parts: Parts): number | undefined => {
      const on = all.find((x) => close(x.c[axis], val, 0.01));
      if (on) return on.at(parts)?.[axis];
      if (close(val, 0, 1e-6)) return 0;
      if (!close(val, lo, 0.05) && !close(val, hi, 0.05)) return undefined;
      const s0 = spanOver(framed(partsOf(ctx.model), ctx.plan), ids, dir);
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
    /** where this axis is measured from: the centre plane, the design origin or the lower edge */
    let origin = mid;
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
      origin = datum;
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
    const style = ctx.spec.dimStyle ?? "auto";
    // too many positions for rows of dimensions: ordinates from the same origin instead
    if (style === "ordinate" || (style === "auto" && out.length > 7)) {
      const edges = close(origin, lo, 0.05) ? [hi] : [lo, hi];
      const marks = uniq([origin, ...vals, ...edges]);
      const startOf = (val: number): [number, number] => {
        if (axis === 0) return [val, near(val)];
        // y ordinates run off to the left, from the leftmost feature on the line
        const on = centers.filter((c) => close(c[1], val, 0.05));
        return [on.length ? Math.min(...on.map((c) => c[0])) : u0, val];
      };
      const base: [number, number] = axis === 0 ? [origin, v0] : [u0, origin];
      for (const val of marks) {
        const value = val - origin;
        const edge = edges.some((e) => close(e, val, 0.05)) || close(val, lo, 0.05);
        const boxed = basic && !edge;
        push({ view: vi, kind: "ordinate", a: startOf(val), b: base, axis, value: Math.abs(value) < 1e-9 ? 0 : value, text: boxed ? { main: fmtNum(value), boxed } : { main: fmtNum(value) }, side: axis === 0 ? "bottom" : "left", tag: tagAtVal(val), meta: { label: `${edge ? "Outline" : "Feature"} ordinate (${word}) in ${what}`, basic: boxed || undefined, general: boxed || close(value, 0, 1e-9) ? undefined : (generalDeviation(ctx.spec.tolerance, value) ?? undefined) } });
      }
      continue;
    }
    if (style === "chain") {
      // feature to feature from the origin, each spacing on its own
      out.length = 0;
      made.clear();
      const chain = uniq([origin, ...vals]);
      for (let k = 1; k < chain.length; k++) mk(chain[k - 1], chain[k], chain[k] - chain[k - 1], fmtNum(chain[k] - chain[k - 1]), `Feature spacing (${word}) in ${what}`);
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
      const boxed = basic && !label.startsWith("Outline");
      push({ view: vi, kind: axis === 0 ? "h" : "v", a: pa, b: pb, value, text: boxed ? { main: text, boxed } : { main: text }, side: axis === 0 ? "bottom" : "right", tag, meta: { label, param: paramFor(value, length), basic: boxed || undefined } });
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

function turnedDims(
  ctx: DimContext,
  f: Extract<Feature, { t: "turned" }>,
  push: Push,
  paramFor: ParamFor,
  what: string,
  track: (parts: Parts) => Extract<Feature, { t: "turned" }> | undefined,
  intent?: Intent,
  gdt = false,
  extra?: Extra,
) {
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
  const runs = new Map<string, { r: number; z: number; len: number; i: number; role?: Role }>();
  for (let i = 0; i + 1 < f.pts.length; i++) {
    const [ra, za] = f.pts[i];
    const [rb, zb] = f.pts[i + 1];
    if (ra < 0.05 || !close(ra, rb, 1e-4) || close(za, zb, 1e-4)) continue;
    const k = ra.toFixed(3);
    const run = { r: ra, z: (za + zb) / 2, len: Math.abs(zb - za), i, role: intent?.runRole(f, ra, za, zb) };
    const was = runs.get(k);
    if (!was || was.len < run.len) runs.set(k, { ...run, role: run.role ?? was?.role });
    else if (!was.role && run.role) was.role = run.role;
  }
  // diameters with a job (bearing and gear seats) first, then the longest
  const shown = [...runs.values()].sort((a, b) => (b.role ? 1 : 0) - (a.role ? 1 : 0) || b.len - a.len).slice(0, 4);
  // the datum axis: the first bearing seat, else the longest diameter
  const datumRun = gdt ? (shown.find((r) => r.role?.kind === "journal") ?? [...shown].sort((a, b) => b.len - a.len)[0]) : undefined;
  for (const run of shown) {
    const c = along(run.z);
    const a: [number, number] = horizontal ? [c[0], c[1] - run.r] : [c[0] - run.r, c[1]];
    const b: [number, number] = horizontal ? [c[0], c[1] + run.r] : [c[0] + run.r, c[1]];
    const dia: Probe = (parts) => {
      const q = track(parts)?.pts[run.i];
      return q && 2 * q[0];
    };
    const d = 2 * run.r;
    const text: DimText = { main: `Ø${fmtNum(d)}` };
    let tol: [number, number] | undefined;
    const fit = run.role?.fit;
    if (fit) {
      const lim = fitLimits(fit, d);
      if (lim) {
        text.suffix = fit;
        text.up = `(${fmtDev(lim.upper)}`;
        text.lo = `${fmtDev(lim.lower)})`;
        tol = [lim.upper, lim.lower];
      }
    }
    const isDatum = run === datumRun;
    const frames: Fcf[] | undefined = gdt && datumRun && !isDatum && run.role ? [{ kind: "runout", tol: runoutTol(intent!.family), dia: false, datums: ["A"] }] : undefined;
    push({ view: vi, kind: "inline", a, b, value: d, text, datum: isDatum ? "A" : undefined, frames, meta: { label: run.role ? `${run.role.text[0]}${run.role.text.slice(1).toLowerCase()} Ø${fmtNum(d)} of ${what}` : `Diameter of ${what}`, param: paramFor(d, dia), tol, fit: tol ? fit : undefined, role: run.role?.text } });
    if (run.role && extra) extra.notes.push(`Ø${fmtNum(d)}${fit ? ` ${fit}` : ""}: ${run.role.text}${run.role.ra ? `, Ra ${fmtNum(run.role.ra)}` : ""}.`);
  }
  if (datumRun && extra) extra.datums.push({ letter: "A", what: `axis of the Ø${fmtNum(2 * datumRun.r)} ${datumRun.role ? datumRun.role.text.toLowerCase() : "diameter"}` });
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
      // text that does not fit between the arrows of a short vertical dimension stands above the view
      if (side !== "bottom") margin.top = Math.max(margin.top, v.box[1] - s[0]);
      let r = 0;
      while (rows[r]?.some((o) => o[0] < s[1] && s[0] < o[1])) r++;
      (rows[r] ??= []).push(s);
      d.row = r;
    }
    if (rows.length) margin[side] = st.first + (rows.length - 1) * st.step + st.size * 0.5;
    for (const d of defs) if (d.side === side && d.offset !== undefined) margin[side] = Math.max(margin[side], d.offset + st.size);
    // a datum symbol on a dimension line sticks out past its row
    for (const d of list) if (d.datum) margin[side] = Math.max(margin[side], st.first + (d.row ?? 0) * st.step + datumReach(st));
  }
  // ordinates end in a line of values past the rows on their side, spread apart where they crowd
  for (const axis of [0, 1] as const) {
    const list = defs.filter((d) => d.kind === "ordinate" && (d.axis ?? 0) === axis);
    if (!list.length) continue;
    const side: Side = axis === 0 ? "bottom" : "left";
    const L = margin[side] > 0 ? margin[side] + 2 : 3;
    const pos = (d: DimDef) => sheetPt(d.a, v)[axis];
    list.sort((a, b) => pos(a) - pos(b));
    const gap = st.size * 1.25;
    const t = list.map(pos);
    const spread = () => {
      for (let i = 1; i < t.length; i++) t[i] = Math.max(t[i], t[i - 1] + gap);
    };
    spread();
    const drift = t.reduce((a, x, i) => a + x - pos(list[i]), 0) / t.length;
    for (let i = 0; i < t.length; i++) t[i] -= drift;
    spread();
    let jog = false;
    list.forEach((d, i) => {
      d.shift = Math.abs(t[i] - pos(d)) < 0.05 ? 0 : t[i] - pos(d);
      d.row = L;
      if (d.shift) jog = true;
    });
    const tw = Math.max(...list.map((d) => dimTextWidth(d.text, st.size)));
    margin[side] = L + (jog ? ORD_JOG : 0) + 1.5 + tw + 1;
  }
  // angle and arc-length dimensions reach out from their vertex
  const reach = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const d of defs) {
    if (d.kind !== "angle" && d.kind !== "arc") continue;
    for (const p of angleReach(d, sheetPt(d.a, v), v.scale, st)) {
      reach.left = Math.max(reach.left, v.box[0] - p[0]);
      reach.right = Math.max(reach.right, p[0] - v.box[2]);
      reach.top = Math.max(reach.top, v.box[1] - p[1]);
      reach.bottom = Math.max(reach.bottom, p[1] - v.box[3]);
    }
  }
  // frames and datums on diameters drawn across a turned part hang off one end of the line
  let k = 0;
  for (const d of defs) {
    if (d.kind !== "inline" || (!d.frames?.length && !d.datum)) continue;
    if (d.frames?.length) d.row = k++;
    const vertical = Math.abs(d.b[1] - d.a[1]) > Math.abs(d.b[0] - d.a[0]);
    const reach = markReach(d, st) + 1;
    const tw = dimTextWidth(d.text, st.size);
    const fits = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * v.scale >= tw + 2 * st.arrow + 2;
    if (vertical) margin.top = Math.max(margin.top, reach + (fits ? 0 : tw + 2));
    else margin.left = Math.max(margin.left, reach + (d.frames?.length ? Math.max(...d.frames.map((f) => fcfWidth(f, st.size))) : 0));
  }
  // callouts stack above the view, leaders running up-right or up-left
  const callouts = defs.filter((d) => d.kind === "callout");
  const mid = (v.box[0] + v.box[2]) / 2;
  const height = (d: DimDef) => {
    if (d.weld) return weldSizeOnPaper(d.weld, st.size).h + calloutBelow(d, st) + 1.5;
    if (bare(d)) return (d.finish ? finishSize(d.finish, st.size).h : st.size) + 2.5;
    return (1 + (d.lines?.length ?? 0)) * st.size * 1.5 + 1.5 + framesHeight(d, st) + finishBelow(d, st);
  };
  const widthOf = (d: DimDef) => {
    if (d.weld) return weldSizeOnPaper(d.weld, st.size).w;
    return Math.max(dimTextWidth(d.text, st.size), ...(d.lines ?? []).map((l) => textWidth(l, st.size)), ...(d.frames ?? []).map((f) => fcfWidth(f, st.size)), d.finish ? finishSize(d.finish, st.size).w + 1 : 0);
  };
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
      d.row = d.weld || bare(d) ? h + calloutBelow(d, st) + 0.5 : h + framesHeight(d, st) + finishBelow(d, st) + st.size * 0.4 + ((n - 1) * st.size * 1.5) / 2;
      h += height(d);
      const S = calloutStart(d, v);
      const rise = Math.max(S[1] - (v.box[1] - d.row), 0);
      if (side === "right") right = Math.max(right, S[0] + rise + 4 + widthOf(d) + 1 - v.box[2]);
      else left = Math.max(left, v.box[0] - (S[0] - rise - 4 - widthOf(d) - 1));
    }
    if (list.length) top = Math.max(top, h);
  }
  if (callouts.length) margin.top = Math.max(margin.top, top);
  margin.right = Math.max(margin.right, right);
  margin.left = Math.max(margin.left, left);
  for (const k of ["top", "bottom", "left", "right"] as const) margin[k] = Math.max(margin[k], reach[k]);
  return margin;
}

/** How far an ordinate's line jogs sideways to reach its spread-out text. */
const ORD_JOG = 3;

/** A callout with no text of its own: a surface texture symbol or a weld on a leader. */
const bare = (d: DimDef) => d.kind === "callout" && !d.text.main && !d.lines?.length;

/** Height a callout's surface texture symbol takes under its text. */
function finishBelow(d: DimDef, st: DimStyle): number {
  return d.finish && !bare(d) ? finishSize(d.finish, st.size).h + 1 : 0;
}

/** What hangs below a bare callout's shoulder: the weld's dashed line and other-side text. */
function calloutBelow(d: DimDef, st: DimStyle): number {
  if (d.weld) return 1.2 + st.size * 0.85 + 1;
  return 0;
}

/** Height the frames and datum symbol under a callout's text take. */
function framesHeight(d: DimDef, st: DimStyle): number {
  if (d.kind !== "callout") return 0;
  return (d.frames?.length ?? 0) * (fcfHeight(st.size) + 0.8) + (d.datum ? datumReach(st) : 0);
}

/** How far a datum symbol reaches from the line it stands on. */
const datumReach = (st: DimStyle) => st.size * 0.75 + 1.5 + datumBox(st.size) + 1;

/** How far a turned diameter's datum symbol or frames reach past the end of its line. */
function markReach(d: DimDef, st: DimStyle): number {
  const n = d.frames?.length ?? 0;
  return Math.max(d.datum ? 1.5 + datumReach(st) : 0, n ? inlineLead(st, d.row ?? 0) + n * (fcfHeight(st.size) + 0.8) : 0);
}

/** Length of the leader from a turned diameter's end to the frame it carries. */
const inlineLead = (st: DimStyle, row: number) => st.first * 0.6 + row * (fcfHeight(st.size) + 1.5);

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

/** Where a callout's leader touches its circle, at 45° toward its side (or the point it was given). */
function calloutStart(d: DimDef, v: Placed): [number, number] {
  if (d.touch) return sheetPt(d.touch, v);
  const c = sheetPt(d.circle?.c ?? d.a, v);
  const r = (d.circle?.r ?? 0) * v.scale;
  const sx = d.lead === "left" ? -1 : 1;
  return [c[0] + sx * r * Math.SQRT1_2, c[1] - r * Math.SQRT1_2];
}

// ---------- inking ----------

/** A datum symbol or frames off the end (x, y) of a diameter drawn across a turned part, along (ux, uy) on paper. */
function inlineMarks(ink: Ink, d: DimDef, x: number, y: number, ux: number, uy: number, st: DimStyle) {
  if (d.datum) {
    ink.line(x, y, x + ux * 1.5, y + uy * 1.5);
    inkDatum(ink, x + ux * 1.5, y + uy * 1.5, ux, uy, d.datum, st.size, 1.5);
  }
  if (!d.frames?.length) return;
  const L = inlineLead(st, d.row ?? 0);
  const ex = x + ux * L;
  const ey = y + uy * L;
  ink.line(x, y, ex, ey);
  const h = fcfHeight(st.size);
  d.frames.forEach((f, i) => {
    const w = fcfWidth(f, st.size);
    // above the end for an upward leader, to its left for a leftward one
    if (uy < 0) inkFcf(ink, ex - Math.min(4, w / 2), ey - h - i * (h + 0.8), f, st.size);
    else inkFcf(ink, ex - w, ey - h / 2 + i * (h + 0.8), f, st.size);
  });
}

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
    // the datum this feature of size is: its symbol on the dimension line, pointing away from the view
    if (d.datum) {
      const out: [number, number] = side === "bottom" ? [0, 1] : side === "top" ? [0, -1] : side === "right" ? [1, 0] : [-1, 0];
      const [mx, my] = pt(lo + (hi - lo) * 0.2);
      inkDatum(ink, mx, my, out[0], out[1], d.datum, st.size, 1.5);
    }
    // a surface texture given to a dimension stands on its line after the text (or above the top of a vertical one)
    if (d.finish) {
      const k = 0.577 * st.size;
      if (horiz) {
        const tx = textOutside ? hi + st.arrow + 2 + tw : (lo + hi) / 2 + tw / 2;
        inkFinish(ink, tx + 1.5 + k, line, d.finish, st.size);
      } else inkFinish(ink, line, lo - (textOutside ? tw + st.arrow + 3 : st.arrow + 1.5), d.finish, st.size);
    }
    // a frame given to a linear dimension sits past its far end
    if (d.frames?.length) {
      const [ex, ey] = pt(hi + (horiz ? tail : ext) + 1.5);
      d.frames.forEach((f, i) => inkFcf(ink, horiz ? ex : ex - fcfHeight(st.size) / 2, (horiz ? ey - fcfHeight(st.size) / 2 : ey) + i * (fcfHeight(st.size) + 0.8), f, st.size));
    }
  } else if (d.kind === "ordinate") {
    // a thin line from the feature to its value, jogging aside where values crowd; the origin gets a small circle
    const L = d.row ?? 3;
    const shift = d.shift ?? 0;
    const tw = dimTextWidth(d.text, st.size);
    if ((d.axis ?? 0) === 0) {
      const yb = v.box[3] + L;
      ink.line(A[0], A[1] + gap, A[0], yb);
      const x = A[0] + shift;
      const y = shift ? yb + ORD_JOG : yb;
      if (shift) ink.line(A[0], yb, x, y);
      ink.line(x, y, x, y + 1);
      inkDimText(ink, d.text, x + st.size * 0.36, y + 1.5 + tw, st.size, "start", 90);
    } else {
      const xb = v.box[0] - L;
      ink.line(A[0] - gap, A[1], xb, A[1]);
      const y = A[1] + shift;
      const x = shift ? xb - ORD_JOG : xb;
      if (shift) ink.line(xb, A[1], x, y);
      ink.line(x, y, x - 1, y);
      inkDimText(ink, d.text, x - 1.5 - tw, y + st.size * 0.36, st.size, "start", 0);
    }
    if (close(d.value, 0, 1e-9)) ink.circle(A[0], A[1], 0.9, "thin");
  } else if (d.kind === "angle" || d.kind === "arc") {
    inkAngle(ink, d, A, v.scale, st, (t, x, y, anchor) => inkDimText(ink, t, x, y, st.size, anchor, 0));
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
    // a datum or frame takes the top (or left) end of the line, so the text goes to the other end when it does not fit
    const marked = !!(d.frames?.length || d.datum);
    if (vertical) {
      const top = Math.min(A[1], B[1]);
      const fits = L >= tw + 2 * st.arrow + 2;
      if (fits) inkDimText(ink, d.text, A[0] - 0.8, (A[1] + B[1]) / 2, st.size, "middle", 90);
      // past the datum or frame, reading up in line with the dimension
      else if (marked) inkDimText(ink, d.text, A[0] - 0.8, top - markReach(d, st) - 1.5, st.size, "start", 90);
      else {
        ink.line(A[0], top, A[0], top - tw - st.arrow - 3);
        inkDimText(ink, d.text, A[0] - 0.8, top - st.arrow - 2, st.size, "start", 90);
      }
      if (marked) inlineMarks(ink, d, A[0], top, 0, -1, st);
    } else {
      const left = Math.min(A[0], B[0]);
      const right = Math.max(A[0], B[0]);
      const fits = L >= tw + 2 * st.arrow + 2;
      if (fits) inkDimText(ink, d.text, (A[0] + B[0]) / 2, A[1] - 0.8, st.size, "middle", 0);
      else {
        ink.line(right, A[1], right + tw + st.arrow + 3, A[1]);
        inkDimText(ink, d.text, right + st.arrow + 2, A[1] - 0.8, st.size, "start", 0);
      }
      if (marked) inlineMarks(ink, d, left, A[1], -1, 0, st);
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
    if (d.weld) inkWeld(ink, E, sx, d.weld, st.size);
    else if (bare(d)) {
      // a surface texture symbol standing on the shoulder
      const f = d.finish;
      const fw = f ? finishSize(f, st.size).w : 0;
      ink.line(E[0], E[1], E[0] + sx * (fw + 2.5), E[1]);
      const k = 0.577 * st.size;
      if (f) inkFinish(ink, sx > 0 ? E[0] + 1.5 + k : E[0] - 1.5 - fw + k, E[1], f, st.size);
    } else ink.line(E[0], E[1], E[0] + sx * 3, E[1]);
    const n = 1 + (d.lines?.length ?? 0);
    const firstBase = rowY + st.size * 0.35 - ((n - 1) * st.size * 1.5) / 2;
    const w = Math.max(dimTextWidth(d.text, st.size), ...(d.lines ?? []).map((l) => textWidth(l, st.size)));
    const tx = sx > 0 ? E[0] + 4 : E[0] - 4 - w;
    inkDimText(ink, d.text, tx, firstBase, st.size, "start", 0);
    (d.lines ?? []).forEach((l, i) => ink.text(tx, firstBase + (i + 1) * st.size * 1.5, l, st.size));
    // the surface texture the feature needs, then geometric tolerances under the text, the datum symbol hanging from the last frame
    let fy = firstBase + (n - 1) * st.size * 1.5 + st.size * 0.6;
    if (d.finish && !bare(d)) {
      const h = finishSize(d.finish, st.size).h;
      inkFinish(ink, tx + 0.577 * st.size, fy + h, d.finish, st.size);
      fy += h + 1;
    }
    let last: Box | null = null;
    for (const f of d.frames ?? []) {
      last = inkFcf(ink, tx, fy, f, st.size);
      fy += fcfHeight(st.size) + 0.8;
    }
    if (d.datum) {
      const x = last ? last[0] + Math.min(4, (last[2] - last[0]) / 2) : tx + 2;
      inkDatum(ink, x, last ? last[3] : fy, 0, 1, d.datum, st.size, 1.5);
    }
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

