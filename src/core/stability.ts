// Whether the design stands up on its own: the centre of mass of every part,
// over the footprint of the parts standing on the floor, at every position
// of its motion. A centre of mass outside the footprint falls over as drawn
// (or as it moves); one that tips at less than 10° of tilt, the tilt test
// IEC 62368-1 sets for equipment that stands on its own, falls over when it
// is nudged. Machines and moving designs are checked; a design bolted down
// says so with held: on a part standing on the floor.

import { turns, type EvalPart, type Model } from "./model";
import type { CheckItem } from "./checks";
import type { ChecksResult } from "../kernel/protocol";
import type { MeshData } from "../kernel/build";
import { xformMatrix, type V3 } from "../kernel/recipe";
import { applyMat, identity, motionPose, type Mat4 } from "./kinematics";
import { materialDensity } from "../library/standards";
import { catalogPart } from "../machine/catalog";
import { fmtNum } from "../lang/values";
import { isFastener, motionOfPart, type Holds, type MeshLookup } from "./holds";
import { sweepAngles } from "./sweepChecks";

/** Freestanding equipment must not tip over when tilted this far (IEC 62368-1, 10°). */
export const TILT_DEG = 10;

type P2 = [number, number];

/** A brief whose setting says the design is fixed in place or not standing on a floor. */
const FIXED = /\b(bolted|screwed|clamped|mounted|fixed|strapped|attached|buried|hung|hangs|hanging|wall|ceiling|underwater)\b/i;

const centroidCache = new WeakMap<MeshData, V3 | null>();

/** The centroid of a closed mesh's volume, in the part's own frame (null when it has no volume). */
function centroid(m: MeshData): V3 | null {
  if (centroidCache.has(m)) return centroidCache.get(m)!;
  const P = m.positions;
  const I = m.indices;
  let v = 0;
  const c: V3 = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3,
      b = I[t + 1] * 3,
      d = I[t + 2] * 3;
    // signed volume of the tetrahedron from the origin
    const vol = (P[a] * (P[b + 1] * P[d + 2] - P[b + 2] * P[d + 1]) - P[a + 1] * (P[b] * P[d + 2] - P[b + 2] * P[d]) + P[a + 2] * (P[b] * P[d + 1] - P[b + 1] * P[d])) / 6;
    v += vol;
    for (let k = 0; k < 3; k++) c[k] += (vol * (P[a + k] + P[b + k] + P[d + k])) / 4;
  }
  const out: V3 | null = Math.abs(v) > 1e-9 ? [c[0] / v, c[1] / v, c[2] / v] : null;
  centroidCache.set(m, out);
  return out;
}

/** Convex hull of 2D points, counter-clockwise (Andrew's monotone chain). */
function hull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper: P2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** How far a point is inside a counter-clockwise convex polygon (negative outside), and the outward normal of the nearest edge. */
function inset(poly: P2[], q: P2): { d: number; n: P2 } {
  let best = Infinity;
  let n: P2 = [1, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0],
      ey = b[1] - a[1];
    const l = Math.hypot(ex, ey) || 1;
    // inward normal of a counter-clockwise edge is to its left
    const d = (-(q[0] - a[0]) * ey + (q[1] - a[1]) * ex) / l;
    if (d < best) {
      best = d;
      n = [ey / l, -ex / l];
    }
  }
  return { d: best, n };
}

const compass = (n: P2) => {
  const k = Math.abs(n[0]) >= Math.abs(n[1]) ? 0 : 1;
  const main = `${n[k] > 0 ? "+" : "-"}${"XY"[k]}`;
  return Math.abs(n[1 - k]) < 0.38 * Math.abs(n[k]) ? main : `${main}${n[1 - k] > 0 ? "+" : "-"}${"XY"[1 - k]}`;
};
const mass = (g: number) => (g >= 1000 ? `${fmtNum(g / 1000, 2)} kg` : `${fmtNum(g, 0)} g`);

export function stabilityChecks(model: Model, holds: Holds, kernel: ChecksResult, mesh: MeshLookup, volume: (p: EvalPart) => number | undefined): CheckItem[] {
  const boxes = kernel.boxes;
  if (!boxes) return [];
  const moving = model.parts.some((p) => turns(motionOfPart(p, holds)));
  if (!moving && !model.machine?.components.length) return [];
  const parts = model.parts.filter((p) => !p.hidden && !(p.imported && p.imported.kind !== "solid") && boxes[p.id] && !p.removable);
  const solid = parts.filter((p) => !isFastener(p));
  if (solid.length < 2) return [];
  const zmin = Math.min(...solid.map((p) => boxes[p.id][0][2]));
  const ground = solid.filter((p) => boxes[p.id][0][2] <= zmin + 0.5);
  // bolted, clamped or strapped down, or not standing on a floor at all (buried, hung on a wall): it cannot tip
  const held = (p: EvalPart) => !!p.held || !!(model.machine?.components ?? []).find((c) => c.name === p.name && c.held);
  if (ground.some(held) || FIXED.test(model.brief?.setting ?? "")) return [];

  // the footprint: where the parts on the floor touch it
  const foot: P2[] = [];
  for (const p of ground) {
    const m = mesh(p.hash);
    if (!m) continue;
    const X = xformMatrix(p.xf) as Mat4;
    for (let i = 0; i < m.positions.length; i += 3) {
      const w = applyMat(X, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
      if (w[2] <= zmin + 0.5) foot.push([w[0], w[1]]);
    }
  }
  const poly = hull(foot);
  if (poly.length < 3) return [];

  // each part's mass and centre, as drawn
  const instance = (p: EvalPart) => p.id.split(".")[0];
  const instVol = new Map<string, number>();
  for (const p of parts) instVol.set(instance(p), (instVol.get(instance(p)) ?? 0) + (volume(p) ?? 0));
  const bodies: { p: EvalPart; g: number; c: V3 }[] = [];
  for (const p of parts) {
    const v = volume(p);
    if (!v) continue;
    const spec = p.bom?.catalogId ? catalogPart(p.bom.catalogId)?.specs.mass_g : undefined;
    const g = typeof spec === "number" && instVol.get(instance(p)) ? (spec * v) / instVol.get(instance(p))! : (materialDensity(p.material) * v) / 1000;
    const m = mesh(p.hash);
    const local = m && centroid(m);
    const b = boxes[p.id];
    const c = local ? applyMat(xformMatrix(p.xf) as Mat4, local) : ([0, 1, 2].map((k) => (b[0][k] + b[1][k]) / 2) as V3);
    bodies.push({ p, g, c });
  }
  const total = bodies.reduce((a, b) => a + b.g, 0);
  if (total <= 0) return [];

  // the centre of mass through the motion: the worst position decides
  const motions = bodies.map((b) => motionOfPart(b.p, holds));
  const angles = moving ? sweepAngles(motions) : [0];
  let worst: { tilt: number; d: number; h: number; n: P2; deg: number; com: V3 } | null = null;
  for (const deg of angles) {
    const com: V3 = [0, 0, 0];
    bodies.forEach((b, i) => {
      const m = motions[i];
      const c = m && turns(m) ? applyMat(motionPose(m, deg), b.c) : applyMat(identity(), b.c);
      for (let k = 0; k < 3; k++) com[k] += (b.g * c[k]) / total;
    });
    const { d, n } = inset(poly, [com[0], com[1]]);
    const h = Math.max(1e-6, com[2] - zmin);
    const tilt = (Math.atan2(d, h) * 180) / Math.PI;
    if (!worst || tilt < worst.tilt) worst = { tilt, d, h, n, deg, com };
  }
  if (!worst) return [];

  const when = moving && worst.deg !== 0 ? ` with the motion at ${fmtNum(worst.deg % 360, 0)}° of the drive` : "";
  const dir = compass(worst.n);
  const ids = ground.map((p) => p.id);
  const base = { category: "engineering" as const, parts: ids, span: ground[0].span, basis: "calculation" as const };
  const high = [...bodies]
    .filter((b) => b.c[2] - zmin > worst!.h && b.g >= 0.05 * total)
    .sort((a, b) => b.g * (b.c[2] - zmin) - a.g * (a.c[2] - zmin))
    .slice(0, 2)
    .map((b) => `${b.p.name} (${mass(b.g)}, ${fmtNum(b.c[2] - zmin, 0)} mm up)`);
  const need = worst.h * Math.tan((TILT_DEG * Math.PI) / 180) - worst.d;
  const fix = `Widen the footprint toward ${dir} by at least ${fmtNum(Math.max(need, 1), 0)} mm (feet or a wider base), move heavy parts${high.length ? ` such as ${high.join(" and ")}` : ""} lower or nearer the middle, or add ballast low down. If it is bolted or clamped down, say so with held: "bolted to the bench" on ${ground[0].name}.`;
  const com = `The centre of mass (${mass(total)} in all) is ${fmtNum(worst.h, 0)} mm up`;
  if (worst.d < 0) {
    return [{ ...base, id: "tip:falls", status: "fail", title: "It falls over", detail: `${com} and ${fmtNum(-worst.d, 0)} mm outside the footprint of the parts on the floor${when}, so it falls toward ${dir}.`, fix, margin: worst.d }];
  }
  if (worst.tilt < TILT_DEG) {
    return [{ ...base, id: "tip:tilt", status: "warn", title: `It tips over at ${fmtNum(worst.tilt, 0)}° of tilt`, detail: `${com} and ${fmtNum(worst.d, 0)} mm in from the edge of its footprint${when}, so tilting it ${fmtNum(worst.tilt, 0)}° toward ${dir}, or a push, tips it over. Equipment that stands on its own should take a ${TILT_DEG}° tilt.`, fix, margin: worst.tilt / TILT_DEG }];
  }
  return [{ ...base, id: "tip:ok", status: "pass", title: "It stands steady", detail: `${com}, and it only tips past ${fmtNum(worst.tilt, 0)}° of tilt (toward ${dir}${when}).`, margin: worst.tilt / TILT_DEG }];
}
