// Manufacturing features read from part recipes, in world coordinates:
// holes (with thread, fit, counterbore and countersink), cut and added
// cylinders, slots and pockets, and turned profiles. Automatic dimensions
// are built from these rather than guessed from the projected lines.

import type { EvalPart } from "../core/model";
import { applyXforms, applyXformsToDir, vadd, vcross, vdot, vnorm, vscale, type ShapeRecipe, type V2, type V3, type Xform } from "../kernel/recipe";

export type Feature =
  | {
      t: "hole";
      part: string;
      d: number;
      depth: number;
      through: boolean;
      at: V3;
      dir: V3;
      cbore?: V2;
      csink?: number;
      thread?: string;
      fit?: string;
    }
  /** a plain cylinder cut into (bore, pocket) or added onto (boss) the part */
  | { t: "cyl"; part: string; op: "add" | "cut"; d: number; h: number; at: V3; dir: V3; through?: boolean }
  /** a rounded-rectangle cut: slots and pockets */
  | { t: "slot"; part: string; w: number; h: number; r: number; depth: number; at: V3; dir: V3; through: boolean }
  /** a turned profile of (radius, axial position) points */
  | { t: "turned"; part: string; pts: V2[]; at: V3; dir: V3 }
  | { t: "box"; part: string; op: "base" | "add" | "cut"; w: number; d: number; h: number; at: V3; r: number }
  | { t: "shell"; part: string; wall: number; open: V3 };

/** World-space extent of a part along a direction, for telling through holes from blind ones. */
export type Extent = (dir: V3) => [number, number];

export function partFeatures(p: EvalPart, extent?: Extent): Feature[] {
  const out: Feature[] = [];
  const shell = p.recipe.ops.find((o): o is Extract<typeof o, { op: "shell" }> => o.op === "shell");
  /** Does a cut from start along dir for depth come out of the material? */
  const goesThrough = (at: V3, dir: V3, depth: number): boolean => {
    if (!extent) return depth >= 1000;
    const [lo, hi] = extent(dir);
    const start = at[0] * dir[0] + at[1] * dir[1] + at[2] * dir[2];
    if (start <= lo + 1e-3 && start + depth >= hi - 1e-3) return true;
    // through a side wall of a shelled part
    if (shell && Math.abs(vnorm(shell.open).reduce((a, v, k) => a + v * dir[k], 0)) < 1e-3) {
      const t = shell.t;
      if (start <= hi - t + 1e-3 && start + depth >= hi - 1e-3 && start >= lo + t - 1e-3) return true;
      if (start <= lo + 1e-3 && start + depth >= lo + t - 1e-3 && start + depth <= hi - t + 1e-3) return true;
    }
    return false;
  };
  const pt = (q: V3, xf: Xform[]) => applyXforms(applyXforms(q, xf), p.xf);
  const dr = (q: V3, xf: Xform[]) => vnorm(applyXformsToDir(applyXformsToDir(q, xf), p.xf));
  const walk = (s: ShapeRecipe, op: "base" | "add" | "cut" | "intersect", xf: Xform[]) => {
    switch (s.t) {
      case "xform":
        walk(s.shape, op, [...s.xf, ...xf]);
        return;
      case "union":
        for (const c of s.shapes) walk(c, op, xf);
        return;
      case "hole": {
        const at = pt(s.at, xf);
        const dir = dr(s.dir, xf);
        const through = s.depth >= 1000 || goesThrough(at, dir, s.depth);
        out.push({ t: "hole", part: p.id, d: s.d, depth: s.depth, through, at, dir, cbore: s.cbore, csink: s.csink, thread: s.thread, fit: s.fit });
        return;
      }
      case "cyl":
        if (op === "add") out.push({ t: "cyl", part: p.id, op, d: s.d, h: s.h, at: pt(s.at, xf), dir: dr(s.dir, xf) });
        if (op === "cut") {
          const at = pt(s.at, xf);
          const dir = dr(s.dir, xf);
          out.push({ t: "cyl", part: p.id, op, d: s.d, h: s.h, at, dir, through: goesThrough(at, dir, s.h) });
        }
        return;
      case "rrect":
        if (op === "cut") {
          const dir = dr(s.dir, xf);
          let at = pt(s.at, xf);
          if (s.center) at = [at[0] - (dir[0] * s.depth) / 2, at[1] - (dir[1] * s.depth) / 2, at[2] - (dir[2] * s.depth) / 2];
          const through = goesThrough(at, dir, s.depth);
          out.push({ t: "slot", part: p.id, w: s.w, h: s.h, r: s.r, depth: s.depth, at, dir, through });
        }
        return;
      case "revolve":
        if (op === "base" || op === "add") out.push({ t: "turned", part: p.id, pts: s.pts, at: pt(s.at, xf), dir: dr(s.dir, xf) });
        return;
      case "box":
        if (op !== "intersect") out.push({ t: "box", part: p.id, op, w: s.w, d: s.d, h: s.h, at: pt(s.at, xf), r: s.r });
        return;
      default:
        return;
    }
  };
  if (p.recipe.base) walk(p.recipe.base, "base", []);
  for (const o of p.recipe.ops) {
    if (o.op === "add" || o.op === "cut") walk(o.shape, o.op, []);
    else if (o.op === "shell") out.push({ t: "shell", part: p.id, wall: o.t, open: o.open });
  }
  return out;
}

/**
 * Extent of a part's material along a direction worked out from its recipe
 * (the base and added shapes), or undefined for shapes it can't size. It
 * follows the recipe, not the kernel, so it can be worked out for a design
 * evaluated with a parameter changed.
 */
export function recipeSpan(p: EvalPart, u: V3): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  let known = true;
  const point = (q: V3) => {
    const s = vdot(q, u);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  };
  /** a circle of radius r around c, square to axis a */
  const disc = (c: V3, a: V3, r: number) => {
    const s = vdot(c, u);
    const k = r * Math.sqrt(Math.max(0, 1 - vdot(a, u) ** 2));
    lo = Math.min(lo, s - k);
    hi = Math.max(hi, s + k);
  };
  const pt = (q: V3, xf: Xform[]) => applyXforms(applyXforms(q, xf), p.xf);
  const dr = (q: V3, xf: Xform[]) => vnorm(applyXformsToDir(applyXformsToDir(q, xf), p.xf));
  const rod = (at: V3, dir: V3, h: number, r0: number, r1: number, xf: Xform[]) => {
    const a = dr(dir, xf);
    disc(pt(at, xf), a, r0);
    disc(pt(vadd(at, vscale(vnorm(dir), h)), xf), a, r1);
  };
  const walk = (s: ShapeRecipe, xf: Xform[]) => {
    switch (s.t) {
      case "xform":
        walk(s.shape, [...s.xf, ...xf]);
        return;
      case "union":
        for (const c of s.shapes) walk(c, xf);
        return;
      case "box":
        for (let i = 0; i < 8; i++) point(pt([s.at[0] + (i & 1 ? s.w : -s.w) / 2, s.at[1] + (i & 2 ? s.d : -s.d) / 2, s.at[2] + (i & 4 ? s.h : 0)], xf));
        return;
      case "cyl":
        rod(s.at, s.dir, s.h, s.d / 2, s.d / 2, xf);
        return;
      case "tube":
        rod(s.at, s.dir, s.h, s.od / 2, s.od / 2, xf);
        return;
      case "cone":
        rod(s.at, s.dir, s.h, s.d1 / 2, s.d2 / 2, xf);
        return;
      case "gear":
        rod(s.at, s.dir, s.w, (s.m * (s.z + 2)) / 2, (s.m * (s.z + 2)) / 2, xf);
        return;
      case "sphere": {
        const c = vdot(pt(s.at, xf), u);
        lo = Math.min(lo, c - s.d / 2);
        hi = Math.max(hi, c + s.d / 2);
        return;
      }
      case "revolve": {
        const a = dr(s.dir, xf);
        const n = vnorm(s.dir);
        for (const [r, z] of s.pts) disc(pt(vadd(s.at, vscale(n, z)), xf), a, r);
        return;
      }
      default:
        known = false;
    }
  };
  if (p.recipe.base) walk(p.recipe.base, []);
  for (const o of p.recipe.ops) if (o.op === "add") walk(o.shape, []);
  return known && lo <= hi ? [lo, hi] : undefined;
}

/**
 * Probe lines for the cut features the recipe alone cannot call through or
 * blind: a line along each cut, just inside its edge, across the whole part.
 * No material on it means the cut comes out somewhere (into a cavity, a
 * pocket, the far side). Returns the feature index with each segment.
 */
export function probeSegments(feats: Feature[], extent: Extent, max = 48): { i: number; a: V3; b: V3 }[] {
  const out: { i: number; a: V3; b: V3 }[] = [];
  feats.forEach((f, i) => {
    if (out.length >= max) return;
    let r: number;
    if (f.t === "hole") r = f.d / 2;
    else if (f.t === "cyl" && f.op === "cut") r = f.d / 2;
    else if (f.t === "slot") r = Math.min(f.w, f.h) / 2;
    else return;
    if (f.through) return;
    const d = vnorm(f.dir);
    const [lo, hi] = extent(d);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const side = vnorm(vcross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    // concentric features share an axis, so the line runs just inside this one's edge
    const off = f.t === "slot" ? r * 0.6 : r * 0.9;
    const s0 = f.at[0] * d[0] + f.at[1] * d[1] + f.at[2] * d[2];
    const p = (t: number): V3 => [0, 1, 2].map((k) => f.at[k] + side[k] * off + d[k] * (t - s0)) as V3;
    out.push({ i, a: p(lo - 1), b: p(hi + 1) });
  });
  return out;
}

/** Marks probed cuts with no material along their line as through. */
export function applyProbes(feats: Feature[], segs: { i: number }[], lengths: number[] | undefined) {
  if (!lengths) return;
  segs.forEach((s, k) => {
    const f = feats[s.i];
    const len = lengths[k];
    if (!Number.isFinite(len) || len > 0.02) return;
    if (f.t === "hole" || f.t === "slot" || (f.t === "cyl" && f.op === "cut")) f.through = true;
  });
}

/** Callout text for a hole, e.g. ["Ø3.4 THRU", "M3 CLEARANCE"]. Count prefix is added by the caller. */
export function holeCallout(h: Extract<Feature, { t: "hole" }>, fmt: (n: number) => string): string[] {
  const depth = h.through ? "THRU" : `× ${fmt(h.depth)} DEEP`;
  const lines: string[] = [];
  if (h.thread && h.fit === "tap") {
    lines.push(`${h.thread} THREAD ${h.through ? "THRU" : `× ${fmt(Math.max(h.depth - 1, 0.5))} DEEP`}`);
    lines.push(`TAP DRILL Ø${fmt(h.d)} ${depth}`);
  } else {
    lines.push(`Ø${fmt(h.d)} ${depth}`);
    if (h.thread && h.fit === "insert") lines.push(`FOR ${h.thread} INSERT`);
    else if (h.thread && h.fit === "close") lines.push(`${h.thread} CLOSE FIT`);
    else if (h.thread) lines.push(`${h.thread} CLEARANCE`);
  }
  if (h.cbore) lines.push(`CBORE Ø${fmt(h.cbore[0])} × ${fmt(h.cbore[1])} DEEP`);
  if (h.csink) lines.push(`CSK Ø${fmt(h.csink)} × 90°`);
  return lines;
}

/** Key that groups identical holes into one "4×" callout. */
export function holeKey(h: Extract<Feature, { t: "hole" }>): string {
  return [h.part, h.d.toFixed(3), h.through ? "T" : h.depth.toFixed(3), h.thread ?? "", h.fit ?? "", h.cbore?.join(",") ?? "", h.csink ?? "", h.dir.map((v) => Math.round(v * 1000)).join(",")].join("|");
}
