// A part placed at an angle in the design (a vane turned 45°, a bracket
// tilted to meet a strut) is drawn square to its own axes: its views look
// along its faces and its dimensions read true lengths. Moves, mirrors and
// quarter turns about X, Y and Z are kept, so a part keeps where it sits and
// which way up it stands.

import type { EvalPart } from "../core/model";
import { applyXforms, inverseXforms, vnorm, vsub, type V3, type Xform } from "../kernel/recipe";

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
  const xf = squareXf(p.xf);
  if (xf.length === p.xf.length) return p;
  const { pt, dir } = mapper(p.xf, xf);
  return {
    ...p,
    xf,
    worldXf: p.xf,
    gear: p.gear && { ...p.gear, center: pt(p.gear.center), axis: dir(p.gear.axis) },
    bearing: p.bearing && { ...p.bearing, center: pt(p.bearing.center), axis: dir(p.bearing.axis) },
  };
}

/** Maps world points and directions into the frame a part's drawing uses (identity for parts drawn where they sit). */
export function drawingFrame(p: EvalPart): { pt: (q: V3) => V3; dir: (d: V3) => V3 } {
  if (!p.worldXf) return { pt: (q) => q, dir: (d) => d };
  return mapper(p.worldXf, p.xf);
}

function mapper(from: Xform[], to: Xform[]) {
  const pt = (q: V3): V3 => applyXforms(inverseXforms(q, from), to);
  const o = pt([0, 0, 0]);
  return { pt, dir: (d: V3): V3 => vnorm(vsub(pt(d), o)) };
}
