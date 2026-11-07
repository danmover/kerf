// A part placed at an angle in the design (a vane turned 45°, a bracket
// tilted to meet a strut) is drawn square to its own axes: its views look
// along its faces and its dimensions read true lengths. Moves, mirrors and
// quarter turns about X, Y and Z are kept, so a part keeps where it sits and
// which way up it stands.

import type { EvalPart } from "../core/model";
import { applyXforms, applyXformsToDir, frameAt, inverseXforms, vcross, vdot, vnorm, vsub, type V3, type Xform } from "../kernel/recipe";

const principal = (d: V3): boolean => {
  const n = vnorm(d);
  return Math.max(...n.map(Math.abs)) > 1 - 1e-9;
};

/** Does a placement step keep the part square to the world axes? */
export function keepsSquare(x: Xform): boolean {
  if (x.op === "translate") return true;
  if (x.op === "mirror") return principal(x.normal);
  const turns = x.angle / 90;
  const quarter = Math.abs(turns - Math.round(turns)) < 1e-9;
  return quarter && (principal(x.axis) || Math.round(turns) % 4 === 0);
}

/** The placement a drawing uses: the part's own, less the turns that set it at an angle. */
export function squareXf(xf: Xform[]): Xform[] {
  return xf.filter(keepsSquare);
}

/**
 * The part as its drawing shows it. Parts already square come back as they
 * are; others get the squared placement, with their gear and bearing axes
 * moved along, and `worldXf` keeping where they really sit.
 */
export function squareUp(p: EvalPart): EvalPart {
  if (p.worldXf) return p;
  const kept = squareXf(p.xf);
  const xf = [...kept, ...bodyTurns(p, kept)];
  if (xf.length === p.xf.length && xf.every((x, i) => x === p.xf[i])) return p;
  const { pt, dir } = mapper(p.xf, xf);
  return {
    ...p,
    xf,
    worldXf: p.xf,
    gear: p.gear && { ...p.gear, center: pt(p.gear.center), axis: dir(p.gear.axis) },
    bearing: p.bearing && { ...p.bearing, center: pt(p.bearing.center), axis: dir(p.bearing.axis) },
  };
}

/** The axis nearest a direction, with its sign. */
function nearestAxis(d: V3, skip?: number): V3 {
  let k = -1;
  for (let i = 0; i < 3; i++) if (i !== skip && (k < 0 || Math.abs(d[i]) > Math.abs(d[k]))) k = i;
  const out: V3 = [0, 0, 0];
  out[k] = d[k] < 0 ? -1 : 1;
  return out;
}

/** The turn about `origin` that takes direction a onto b (both unit), or none when they already agree. */
function turnOnto(a: V3, b: V3, origin: V3): Xform | undefined {
  const c = Math.max(-1, Math.min(1, vdot(a, b)));
  if (c > 1 - 1e-9) return undefined;
  let axis = vcross(a, b);
  if (Math.hypot(...axis) < 1e-9) axis = Math.abs(a[0]) < 0.9 ? vcross(a, [1, 0, 0]) : vcross(a, [0, 1, 0]);
  return { op: "rotate", angle: (Math.acos(c) * 180) / Math.PI, origin, axis: vnorm(axis) };
}

/**
 * A part whose body is laid along a slanted axis (a cylinder with `dir:` off
 * the world axes, a block extruded at an angle) is turned so that axis, and
 * the profile's own across direction, run along the world axes. The turns
 * pivot on the body's anchor, so the part stays where it sits.
 */
function bodyTurns(p: EvalPart, xf: Xform[]): Xform[] {
  const b = p.recipe.base;
  if (!b || !("dir" in b) || !("at" in b)) return [];
  const rot = "rot" in b && typeof b.rot === "number" ? b.rot : 0;
  const f = frameAt(b.at, b.dir, rot);
  const origin = applyXforms(b.at, xf);
  const n = vnorm(applyXformsToDir(f.n, xf));
  // a round body along an axis is square already; a profile may still be turned in its own plane
  if (principal(n) && b.t !== "prism" && b.t !== "rrect") return [];
  const out: Xform[] = [];
  const first = turnOnto(n, nearestAxis(n), origin);
  if (first) out.push(first);
  if (b.t === "prism" || b.t === "rrect") {
    // and the profile's own across direction square within that plane
    const axisIdx = nearestAxis(n).findIndex((c) => c !== 0);
    const u = vnorm(applyXformsToDir(f.u, [...xf, ...out]));
    const second = turnOnto(u, nearestAxis(u, axisIdx), origin);
    if (second) out.push(second);
  }
  return out;
}

/** Maps world points and directions into the frame a part's drawing uses (identity for parts drawn where they sit). */
export function drawingFrame(p: EvalPart): { pt: (q: V3) => V3; dir: (d: V3) => V3 } {
  if (!p.worldXf) return { pt: (q) => q, dir: (d) => d };
  return mapper(p.worldXf, p.xf);
}

/** Maps points and directions of a part's drawing frame back to where the part sits in the world (identity for parts drawn where they sit). */
export function worldFrame(p: EvalPart): { pt: (q: V3) => V3; dir: (d: V3) => V3 } {
  if (!p.worldXf) return { pt: (q) => q, dir: (d) => d };
  return mapper(p.xf, p.worldXf);
}

function mapper(from: Xform[], to: Xform[]) {
  const pt = (q: V3): V3 => applyXforms(inverseXforms(q, from), to);
  const o = pt([0, 0, 0]);
  return { pt, dir: (d: V3): V3 => vnorm(vsub(pt(d), o)) };
}
