// Where a part's threads are, so the 3D view can draw them on the plain cylinders that stand in for them.
//
// A real helical thread is tens of thousands of triangles and seconds of OpenCASCADE time per screw, and at any
// normal zoom it is a few pixels of ridges, most of it inside a hole. Fast builds (and the view's display builds)
// keep a plain cylinder where each thread is; this file finds those cylinders' faces in a built shape and gives
// each of their vertices what the part shader needs to draw the thread on it: which thread (its form, starts and
// hand, and how many turns long it is), how far along it the vertex is in pitches, and its angle round the axis.
// Real threads are still built for STEP and STL export, drawings, photoreal, films and close-ups.

import { hasDetail, mul, vlen, vnorm, vscale, vsub, xformMatrix, type PartRecipe, type ShapeRecipe, type ThreadForm, type ThreadSpec3, type V3 } from "./recipe";
import { pitchDiameter } from "./threadMath";

/** One thread's stand-in cylinder, in the part's own frame. */
export interface ThreadMark {
  /** the start of the cylinder on its axis */
  o: V3;
  /** unit axis, towards the end */
  a: V3;
  /** length along the axis (mm) */
  len: number;
  /** the stand-in cylinder's radius */
  r: number;
  pitch: number;
  /** starts, negative for a left-hand thread (a mirrored part's thread turns the other way) */
  k: number;
  form: ThreadForm;
}

/** Thread forms by the number the shader knows them by. */
export const THREAD_FORMS: ThreadForm[] = ["iso", "trapezoid", "square", "buttress"];

/** Values per vertex in MeshData.thread */
export const THREAD_STRIDE = 4;

/**
 * The first of a vertex's four thread values: 0 off a thread, else sign = hand and
 * |x| = form × 65536 + starts × 4096 + turns. It is the same at every vertex of a face, so it reaches the shader
 * exactly however the face's triangles interpolate it.
 */
export function threadCode(m: Pick<ThreadMark, "k" | "form" | "len" | "pitch">): number {
  const form = Math.max(0, THREAD_FORMS.indexOf(m.form));
  const starts = Math.min(15, Math.max(1, Math.abs(Math.round(m.k))));
  const turns = Math.min(4095, Math.max(0, m.len / m.pitch));
  return Math.sign(m.k || 1) * (form * 65536 + starts * 4096 + turns);
}

/** threadCode read back (what the shader does) */
export function readThreadCode(x: number): { hand: number; form: ThreadForm; starts: number; turns: number } | null {
  if (Math.abs(x) < 0.5) return null;
  const ax = Math.abs(x);
  const form = Math.floor(ax / 65536);
  const starts = Math.floor((ax - form * 65536) / 4096);
  return { hand: Math.sign(x), form: THREAD_FORMS[form] ?? "iso", starts, turns: ax - form * 65536 - starts * 4096 };
}

type M = number[];
const IDENTITY: M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const point = (m: M, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const direction = (m: M, d: V3): V3 => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
const det3 = (m: M) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/**
 * Every thread stand-in a build of this part makes, where it ends up in the part's frame. `detail`: the build takes
 * the detailed side of level-of-detail shapes and keeps cosmetic steps (a display build); threads are stand-ins either
 * way. A step this does not follow (a pattern of the body, say) leaves its threads unmarked: they draw as plain
 * cylinders, never as a thread somewhere wrong.
 */
export function threadMarks(p: PartRecipe, detail = false): ThreadMark[] {
  const out: ThreadMark[] = [];
  const mark = (spec: ThreadSpec3, length: number, at: V3, dir: V3, internal: boolean, fastD: number | undefined, m: M) => {
    if (!(spec.pitch > 0) || !(length > 0)) return;
    const d2 = pitchDiameter(spec);
    // as buildThread makes its stand-in: an internal one starts a little before `at`
    const over = internal ? 0.05 : 0;
    const r = fastD ? fastD / 2 : d2 / 2 + (internal ? spec.clearance : -spec.clearance);
    const n = vnorm(dir);
    const a0 = vsub(at, vscale(n, over));
    const ax = direction(m, n);
    const s = vlen(ax);
    if (!(s > 1e-9)) return;
    const hand = (spec.left ? -1 : 1) * (det3(m) < 0 ? -1 : 1);
    out.push({ o: point(m, a0), a: vscale(ax, 1 / s), len: (length + over) * s, r: r * s, pitch: spec.pitch * s, k: hand * Math.max(1, spec.starts || 1), form: spec.form });
  };
  const walk = (r: ShapeRecipe, m: M) => {
    switch (r.t) {
      case "thread":
        return mark(r.spec, r.length, r.at, r.dir, r.internal, r.fastD, m);
      case "hole":
        if (r.thread) mark(r.thread, r.depth, r.at, r.dir, true, undefined, m);
        return;
      case "xform":
        return walk(r.shape, mul(m, xformMatrix(r.xf)));
      case "union":
        for (const s of r.shapes) walk(s, m);
        return;
      case "diff":
        walk(r.a, m);
        for (const s of r.b) walk(s, m);
        return;
      case "instances":
        for (const it of r.items) for (const xf of it.xfs) walk(it.shape, mul(m, xformMatrix(xf)));
        return;
      case "lod":
        return walk(detail ? r.detail : r.fast, m);
      case "part":
        return part(r.part, mul(m, xformMatrix([...r.xf, ...(r.into ?? [])])));
    }
  };
  const part = (q: PartRecipe, m: M) => {
    if (q.base) walk(q.base, m);
    for (const op of q.ops) {
      if (op.cosmetic && !detail) continue;
      if ((op.op === "add" || op.op === "cut" || op.op === "intersect") && "shape" in op && op.shape) walk(op.shape as ShapeRecipe, m);
    }
  };
  part(p, IDENTITY);
  return out;
}

/** Whether a part has threads (and so a display build lighter than its detailed one). */
export function hasThreads(p: PartRecipe): boolean {
  return threadMarks(p, true).length > 0;
}

/**
 * Whether a part's display mesh needs a build of its own: it has threads (drawn, not built, on screen) and detail
 * besides them (knurls, belt teeth, cosmetic steps). A part whose only detail is threads shows its fast build.
 */
export function displayBuilt(recipe: PartRecipe): boolean {
  return hasDetail(recipe) && hasThreads(recipe) && hasOtherDetail(recipe);
}

/** Detail other than threads: what a display build keeps that the fast build leaves out. */
function hasOtherDetail(recipe: PartRecipe): boolean {
  const shape = (r: ShapeRecipe): boolean => {
    switch (r.t) {
      case "knurl":
      case "lod":
        return true;
      case "xform":
        return shape(r.shape);
      case "union":
        return r.shapes.some(shape);
      case "diff":
        return shape(r.a) || r.b.some(shape);
      case "instances":
        return r.items.some((it) => shape(it.shape));
      case "part":
        return hasOtherDetail(r.part);
      default:
        return false;
    }
  };
  if (recipe.base && shape(recipe.base)) return true;
  return recipe.ops.some((o) => o.cosmetic || ("shape" in o && !!o.shape && shape(o.shape as ShapeRecipe)));
}
