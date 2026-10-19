// Parts an analysed part carries move with it in the results: a number
// clicked into a bracket swings with the jaw it sits in, and the print on the
// number goes with the number. Each carried part follows the bit of its host
// it sits on as a rigid body, fitted to how that bit moves under the loads
// (and in each mode shape), so the viewport can turn and shift it with the
// deformed host instead of leaving it hanging where it was.

import type { EvalPart, Model } from "../core/model";
import type { V3 } from "../kernel/recipe";
import type { PartField, StructuralResult } from "./fe/structural";
import { carriedBy, placedBox } from "./fitting";

/** A small rigid motion: a point x moves by t + w × (x − c) for each unit of the result's scale. */
export interface RigidMotion {
  c: V3;
  t: V3;
  w: V3;
}

export interface Follower {
  id: string;
  /** the analysed part it moves with, through any parts between */
  host: string;
  /** under the loads */
  disp: RigidMotion;
  /** in each mode shape of its host */
  modes: RigidMotion[];
}

/**
 * The parts that ride on the analysed ones, each with how it moves. bbox
 * gives a part's own bounding box (before its placement).
 */
export function followers(model: Model, result: StructuralResult, bbox: (p: EvalPart) => [V3, V3] | undefined): Follower[] {
  const kids = carriedBy(model, bbox);
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const seen = new Set(result.parts.map((p) => p.id));
  const out: Follower[] = [];
  // what a carried part carries in turn goes the same way
  const carry = (id: string, f: Follower) => {
    for (const k of kids.get(id) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...f, id: k });
      carry(k, f);
    }
  };
  for (const field of result.parts)
    for (const k of kids.get(field.id) ?? []) {
      const part = byId.get(k);
      const box = part && bbox(part);
      if (seen.has(k) || !part || !box) continue;
      const near = vertsNear(field, placedBox(part, box));
      if (!near) continue;
      seen.add(k);
      const f: Follower = { id: k, host: field.id, disp: fitRigid(field.positions, field.disp, near), modes: (field.modes ?? []).map((m) => fitRigid(field.positions, m, near)) };
      out.push(f);
      carry(k, f);
    }
  return out;
}

/** The host's vertices on or next to a box: within 1 mm, reaching further (up to 16 mm) until there are enough to fit a motion to. */
function vertsNear(field: PartField, [lo, hi]: [V3, V3]): number[] | null {
  const P = field.positions;
  let found: number[] = [];
  for (let m = 1; m <= 16; m *= 2) {
    found = [];
    for (let v = 0; v < P.length / 3; v++) {
      const x = P[3 * v],
        y = P[3 * v + 1],
        z = P[3 * v + 2];
      if (x >= lo[0] - m && x <= hi[0] + m && y >= lo[1] - m && y <= hi[1] + m && z >= lo[2] - m && z <= hi[2] + m) found.push(v);
    }
    if (found.length >= 6) return found;
  }
  return found.length >= 3 ? found : null;
}

/**
 * The rigid motion closest to a set of vertex displacements (least squares):
 * t is their mean about the vertices' centre c, and w solves
 * Σ(|r|²I − r rᵀ) w = Σ r × (u − t). A turn the points cannot show (about the
 * line they lie on) is left out.
 */
export function fitRigid(P: ArrayLike<number>, U: ArrayLike<number>, idx: number[]): RigidMotion {
  const n = Math.max(idx.length, 1);
  const c: V3 = [0, 0, 0];
  const t: V3 = [0, 0, 0];
  for (const v of idx)
    for (let d = 0; d < 3; d++) {
      c[d] += P[3 * v + d] / n;
      t[d] += U[3 * v + d] / n;
    }
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b: V3 = [0, 0, 0];
  for (const v of idx) {
    const r = [P[3 * v] - c[0], P[3 * v + 1] - c[1], P[3 * v + 2] - c[2]];
    const e = [U[3 * v] - t[0], U[3 * v + 1] - t[1], U[3 * v + 2] - t[2]];
    const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[3 * i + j] += (i === j ? rr : 0) - r[i] * r[j];
    b[0] += r[1] * e[2] - r[2] * e[1];
    b[1] += r[2] * e[0] - r[0] * e[2];
    b[2] += r[0] * e[1] - r[1] * e[0];
  }
  const eps = 1e-5 * (M[0] + M[4] + M[8]) + 1e-12;
  for (let i = 0; i < 3; i++) M[4 * i] += eps;
  return { c, t, w: solve3(M, b) };
}

function solve3(M: number[], b: V3): V3 {
  const [a, bb, c, d, e, f, g, h, i] = M;
  const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
  if (!(Math.abs(det) > 1e-30)) return [0, 0, 0];
  return [
    (b[0] * (e * i - f * h) - bb * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det,
    (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det,
    (a * (e * b[2] - b[1] * h) - bb * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det,
  ];
}
