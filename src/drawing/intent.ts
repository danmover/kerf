// Design intent for a part drawing, read from the assembly around the part:
// which bores hold bearings or dowels, which shaft diameters carry bearings,
// which axes carry meshing gears (so their centre distance is a functional
// dimension), and how the part is made. Dimensions, fits and geometric
// tolerances are then chosen for what each feature does, not only for its
// shape.

import type { EvalPart, Model } from "../core/model";
import { applyXforms, applyXformsToDir, vcross, vdot, vnorm, vsub, type V3 } from "../kernel/recipe";
import { PROCESSES } from "../mfg/profiles";
import type { Feature } from "./features";
import { fmtNum } from "./sheet";

export type Family = "additive" | "subtractive" | "formative" | "sheet" | "none";

/** How a part is made, by process family; "none" when it has no process. */
export function processFamily(p: EvalPart | undefined): Family {
  const id = p?.process?.id;
  return id && PROCESSES[id] ? PROCESSES[id].family : "none";
}

/** What a feature is for. */
export interface Role {
  kind: "bearing" | "journal" | "dowel" | "gear";
  /** callout line, e.g. "SEAT FOR 625 BEARING" */
  text: string;
  /** ISO 286 class the feature takes when the process can hold it */
  fit?: string;
  /** surface roughness Ra in µm for the functional surface */
  ra?: number;
  /** the part it mates with */
  mate: string;
}

/** Two axes in the part that carry meshing gears: their distance sets the backlash. */
export interface CentrePair {
  /** feature indexes on each axis */
  fa: number;
  fb: number;
  /** points on each axis and the axis direction */
  a: V3;
  b: V3;
  dir: V3;
  /** the distance between the axes */
  value: number;
  /** ± that keeps the mesh from binding or rattling, from the gears' backlash */
  tol: number;
  gears: [string, string];
  backlash: number;
}

export interface Intent {
  family: Family;
  /** roles by feature index in partFeatures(part) */
  roles: Map<number, Role>;
  /** role of a turned diameter: radius and axial span along the profile */
  runRole: (f: Extract<Feature, { t: "turned" }>, r: number, z0: number, z1: number) => Role | undefined;
  centres: CentrePair[];
}

interface Axis {
  at: V3;
  dir: V3;
}

const POS_TOL = 0.05;

/** Is the point c on the line through at along dir, and are the directions parallel? */
export function coaxial(a: Axis, b: Axis): boolean {
  const da = vnorm(a.dir);
  const db = vnorm(b.dir);
  const cr = vcross(da, db);
  if (Math.hypot(cr[0], cr[1], cr[2]) > 1e-3) return false;
  const w = vsub(b.at, a.at);
  const along = vdot(w, da);
  const off = [w[0] - da[0] * along, w[1] - da[1] * along, w[2] - da[2] * along];
  return Math.hypot(off[0], off[1], off[2]) < POS_TOL;
}

/** Axial range a feature covers along its own axis, as [from, to] of dot(point, dir). */
function axialRange(f: Feature): [number, number] | null {
  if (f.t === "hole") {
    const s = vdot(f.at, vnorm(f.dir));
    return [s, s + Math.min(f.depth, 10_000)];
  }
  if (f.t === "cyl") {
    const s = vdot(f.at, vnorm(f.dir));
    return [s, s + f.h];
  }
  return null;
}

/** Does the span [lo, hi] along the axis overlap a body centred at c with half-width w? */
const overlaps = (r: [number, number], c: number, w: number) => Math.min(r[0], r[1]) < c + w - 1e-6 && Math.max(r[0], r[1]) > c - w + 1e-6;

/** The axis of a bought component (bearing, dowel, gear), in world space. */
function componentAxis(p: EvalPart): Axis | null {
  if (p.bearing) return { at: p.bearing.center, dir: p.bearing.axis };
  if (p.gear) return { at: p.gear.center, dir: p.gear.axis };
  const b = p.recipe.base;
  if (b?.t === "cyl") return { at: applyXforms(b.at, p.xf), dir: vnorm(applyXformsToDir(b.dir, p.xf)) };
  return null;
}

/** The first instance of each component. */
function firstInstances(model: Model, keep: (p: EvalPart) => boolean): EvalPart[] {
  const seen = new Set<string>();
  const out: EvalPart[] = [];
  for (const p of model.parts) {
    if (!keep(p) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export function designIntent(part: EvalPart, model: Model, feats: Feature[]): Intent {
  const family = processFamily(part);
  const machined = family === "subtractive";
  const roles = new Map<number, Role>();
  const bearings = firstInstances(model, (p) => !!p.bearing && p.name !== part.name);
  const dowels = firstInstances(model, (p) => p.libKind === "dowel" && p.name !== part.name);
  const gears = firstInstances(model, (p) => !!p.gear && p.name !== part.name);

  // bores that hold a bearing's outer ring, holes that hold dowels
  feats.forEach((f, i) => {
    const bore = (f.t === "cyl" && f.op === "cut") || (f.t === "hole" && !f.thread);
    if (!bore) return;
    const axis = { at: f.at, dir: f.dir };
    const range = axialRange(f)!;
    for (const b of bearings) {
      const info = b.bearing!;
      if (Math.abs(f.d - info.od) > Math.max(0.3, info.od * 0.02) || !coaxial(axis, { at: info.center, dir: info.axis })) continue;
      if (!overlaps(range, vdot(info.center, vnorm(f.dir)), info.width / 2)) continue;
      roles.set(i, { kind: "bearing", text: `SEAT FOR ${info.code} BEARING`, fit: machined ? "H7" : undefined, ra: machined ? 1.6 : undefined, mate: b.name });
      return;
    }
    for (const d of dowels) {
      const ax = componentAxis(d);
      const dia = d.recipe.base?.t === "cyl" ? d.recipe.base.d : 0;
      if (!ax || Math.abs(f.d - dia) > 0.06 || !coaxial(axis, ax)) continue;
      roles.set(i, { kind: "dowel", text: `FOR Ø${fmtNum(dia)} DOWEL`, fit: family === "additive" ? undefined : "H7", ra: machined ? 1.6 : undefined, mate: d.name });
      return;
    }
  });

  // a turned diameter that carries a bearing's inner ring or a gear's bore
  const runRole: Intent["runRole"] = (f, r, z0, z1) => {
    const dir = vnorm(f.dir);
    const s0 = vdot(f.at, dir);
    const range: [number, number] = [s0 + Math.min(z0, z1), s0 + Math.max(z0, z1)];
    const axis = { at: f.at, dir };
    for (const b of bearings) {
      const info = b.bearing!;
      if (Math.abs(2 * r - info.bore) > 0.06 || !coaxial(axis, { at: info.center, dir: info.axis })) continue;
      if (!overlaps(range, vdot(info.center, dir), info.width / 2)) continue;
      return { kind: "journal", text: `${info.code} BEARING SEAT`, fit: machined ? "k6" : undefined, ra: machined ? 0.8 : undefined, mate: b.name };
    }
    for (const g of gears) {
      const info = g.gear!;
      if (!info.bore || Math.abs(2 * r - info.bore) > 0.06 || !coaxial(axis, { at: info.center, dir: info.axis })) continue;
      const c = vdot(info.center, dir) + (vdot(vnorm(info.axis), dir) > 0 ? 1 : -1) * (info.width / 2);
      if (!overlaps(range, c, info.width / 2)) continue;
      return { kind: "gear", text: `GEAR SEAT (${g.name.toUpperCase()})`, fit: machined ? "h6" : undefined, ra: machined ? 1.6 : undefined, mate: g.name };
    }
    return undefined;
  };

  // axes in this part that carry meshing gears
  const centres: CentrePair[] = [];
  const onAxis = (ax: Axis): number => {
    // prefer a bearing seat, then the biggest bore on the axis
    let best = -1;
    let score = -1;
    feats.forEach((f, i) => {
      const cut = (f.t === "cyl" && f.op === "cut") || f.t === "hole";
      if (!cut || !coaxial({ at: f.at, dir: f.dir }, ax)) return;
      const s = (roles.get(i)?.kind === "bearing" ? 1000 : 0) + f.d;
      if (s > score) {
        score = s;
        best = i;
      }
    });
    return best;
  };
  const byName = new Map(gears.map((g) => [g.name, g]));
  const done = new Set<string>();
  for (const g of gears) {
    const mate = g.gear!.meshWith ? byName.get(g.gear!.meshWith) : undefined;
    if (!mate) continue;
    const key = [g.name, mate.name].sort().join("|");
    if (done.has(key)) continue;
    done.add(key);
    const A = componentAxis(g)!;
    const B = componentAxis(mate)!;
    const fa = onAxis(A);
    const fb = onAxis(B);
    if (fa < 0 || fb < 0 || fa === fb) continue;
    const dir = vnorm(A.dir);
    const w = vsub(B.at, A.at);
    const along = vdot(w, dir);
    const value = Math.hypot(w[0] - dir[0] * along, w[1] - dir[1] * along, w[2] - dir[2] * along);
    const backlash = Math.max(g.gear!.backlash, mate.gear!.backlash);
    const pa = ((g.gear!.pa || 20) * Math.PI) / 180;
    // the centres may come closer by backlash / (2 tan α) before the teeth bind: keep a third of it in hand
    const room = backlash > 0 ? backlash / (2 * Math.tan(pa)) : 0;
    const tol = Math.min(0.2, Math.max(0.01, Math.floor((room / 1.5) * 100) / 100));
    const fA = feats[fa] as Extract<Feature, { at: V3 }>;
    const fB = feats[fb] as Extract<Feature, { at: V3 }>;
    centres.push({ fa, fb, a: fA.at, b: fB.at, dir, value, tol, gears: [g.name, mate.name], backlash });
  }
  return { family, roles, runRole, centres };
}
