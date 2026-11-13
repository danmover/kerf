// Dragging parts the ways their mates and the mechanism let them move: a lid turns on its hinge, a carriage
// slides on its rail, a crank turns the linkage it drives. A mated part is pulled toward the pointer by solving
// its mates again from where it is (the parts mated to it come along); a part the mechanism moves turns the
// driver to whatever angle brings the grabbed spot nearest the pointer. The pose shows until the design
// changes. Keep here writes a mated pose into the parts' at: and rotate: (axis: or facing: for components
// placed that way), so the design draws them there and their mates hold them.

import { frameFor, xformMatrix, type V3, type Xform } from "../kernel/recipe";
import { fmtNum } from "../lang/values";
import { motionPose } from "./kinematics";
import { moveIdentity, rotAxisAngle, solveMates, type BodyMove } from "./mates";
import { turns, type EvalPart, type Model } from "./model";
import { setBlockProps } from "./sourceEdit";

type Mat = number[];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** A body move as a column-major 4 × 4 (q = R p + c + t − R c). */
export function moveMatrix(m: BodyMove): Mat {
  const R = m.R;
  const Rc: V3 = [R[0] * m.c[0] + R[1] * m.c[1] + R[2] * m.c[2], R[3] * m.c[0] + R[4] * m.c[1] + R[5] * m.c[2], R[6] * m.c[0] + R[7] * m.c[1] + R[8] * m.c[2]];
  const t: V3 = [m.c[0] + m.t[0] - Rc[0], m.c[1] + m.t[1] - Rc[1], m.c[2] + m.t[2] - Rc[2]];
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

export function mulMat(a: Mat, b: Mat): Mat {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** The inverse of a rigid motion (rotation and translation). */
export function invRigid(m: Mat): Mat {
  // R is the upper 3 × 3 (column-major); the inverse is Rᵀ and −Rᵀ t
  const t: V3 = [m[12], m[13], m[14]];
  const o = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  o[12] = -(o[0] * t[0] + o[4] * t[1] + o[8] * t[2]);
  o[13] = -(o[1] * t[0] + o[5] * t[1] + o[9] * t[2]);
  o[14] = -(o[2] * t[0] + o[6] * t[1] + o[10] * t[2]);
  return o;
}

export const matPoint = (m: Mat, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const matDir = (m: Mat, d: V3): V3 => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
const isIdentity = (m: Mat) => m.every((x, i) => Math.abs(x - (i % 5 === 0 ? 1 : 0)) < 1e-9);

/** A point back where the body is drawn, from where a move put it. */
export function unmovePoint(m: BodyMove, q: V3): V3 {
  const R = m.R;
  const d = sub(sub(q, m.c), m.t);
  return [R[0] * d[0] + R[3] * d[1] + R[6] * d[2] + m.c[0], R[1] * d[0] + R[4] * d[1] + R[7] * d[2] + m.c[1], R[2] * d[0] + R[5] * d[1] + R[8] * d[2] + m.c[2]];
}

// ---------- what can be dragged ----------

export type DragHow = { kind: "mates"; body: string; words: string } | { kind: "motion"; part: string };

/** How a part can be dragged: through its mates (when they leave it free), or by the mechanism that moves it. */
export function dragHow(model: Model, part: EvalPart): DragHow | { kind: "none"; why: string } {
  const free = model.mates?.free.find((f) => f.body === part.name);
  if (free && free.dof > 0) return { kind: "mates", body: part.name, words: free.words };
  if (part.motion && turns(part.motion)) return { kind: "motion", part: part.id };
  if (free) return { kind: "none", why: `${part.name} is ${free.words}` };
  return { kind: "none", why: `${part.name} has no mates or motion to drag it through` };
}

// ---------- dragging through mates ----------

export interface MateDrag {
  body: string;
  /** the grabbed point, where the body is drawn */
  point: V3;
  /** where every mated body is now (moves from where they are drawn) */
  moves: Map<string, BodyMove>;
  /** turning joints' turns so far, counted round (so geared joints stay in step past a whole turn) */
  coords: Map<string, number>;
}

/** Start dragging a body by the point under the pointer (as it is shown, after `moves` and `coords`). */
export function startMateDrag(model: Model, body: string, world: V3, moves?: Map<string, BodyMove>, coords?: Map<string, number>): MateDrag {
  const now = moves ?? new Map(model.mates?.moves ?? []);
  const m = now.get(body) ?? moveIdentity(model.mates?.bodies.find((b) => b.name === body)?.c ?? [0, 0, 0]);
  return { body, point: unmovePoint(m, world), moves: now, coords: coords ?? new Map(moves ? [] : (model.mates?.coords ?? [])) };
}

/** Pull the grabbed point toward target, as far as the mates let it go; the parts mated to it come along. */
export function mateDragTo(model: Model, d: MateDrag, target: V3): MateDrag {
  const m = model.mates;
  if (!m) return d;
  const sol = solveMates(m.bodies, m.specs, { start: d.moves, drag: { body: d.body, point: d.point, target }, coords: d.coords });
  return { ...d, moves: sol.moves, coords: sol.coords };
}

/** Each part's motion from where the design shows it, for the moves given (column-major; parts that do not move are left out). */
export function mateDeltas(model: Model, moves: Map<string, BodyMove>): Map<string, Mat> {
  const shown = new Map(model.mates?.moves ?? []);
  const out = new Map<string, Mat>();
  for (const [body, mv] of moves) {
    const s = shown.get(body) ?? moveIdentity(mv.c);
    const D = mulMat(moveMatrix(mv), invRigid(moveMatrix(s)));
    if (isIdentity(D)) continue;
    for (const p of model.parts) if (bodyOf(p) === body || p.name === body) out.set(p.id, D);
  }
  return out;
}

/** The body a part moves with under mates: a piece with its part, and what a placed design brought with the design. */
const bodyOf = (p: EvalPart) => p.insert?.block ?? p.split?.part ?? p.name;

/** How far a body has moved from where the design shows it, in words: a turn (about whatever axis) and a slide along it. */
export function movedWords(model: Model, body: string, moves: Map<string, BodyMove>): string {
  const D = mateDeltas(model, moves).get(model.parts.find((p) => p.name === body || bodyOf(p) === body)?.id ?? "");
  if (!D) return `${body} is where the design puts it`;
  const { axis, angle } = rotAxisAngle([D[0], D[4], D[8], D[1], D[5], D[9], D[2], D[6], D[10]]);
  const t: V3 = [D[12], D[13], D[14]];
  // every point of a turned body slides the same distance along the turn's axis
  if (angle > 1e-4) {
    const slid = Math.abs(dot(t, axis));
    return `${body} turned ${fmtNum((angle * 180) / Math.PI, 1)}°${slid > 0.01 ? ` and slid ${fmtNum(slid, 1)} mm` : ""}`;
  }
  return `${body} moved ${fmtNum(len(t), 1)} mm`;
}

// ---------- dragging the mechanism ----------

export interface MotionDrag {
  part: string;
  /** the grabbed point where the design shows the part (driver at 0) */
  point: V3;
  angle: number;
  /** degrees of driver turn that move the grabbed point about the part's size */
  window: number;
}

/** Start turning the mechanism by a part's point under the pointer, with the driver at `angle` (degrees). */
export function startMotionDrag(part: EvalPart, world: V3, angle: number, size: number): MotionDrag | null {
  const mo = part.motion;
  if (!mo) return null;
  const P = invRigid(motionPose(mo, angle));
  const point = matPoint(P, world);
  // how fast the grabbed point moves with the driver here, to know how far to look
  const at = (a: number) => matPoint(motionPose(mo, a), point);
  const speed = len(sub(at(angle + 0.5), at(angle - 0.5)));
  const window = speed > 1e-9 ? Math.min(3600, Math.max(5, (2 * Math.max(size, 1)) / speed)) : 180;
  return { part: part.id, point, angle, window };
}

/** The driver angle near the last that brings the grabbed point nearest the line under the pointer. */
export function motionDragTo(part: EvalPart, d: MotionDrag, ray: { o: V3; d: V3 }): MotionDrag {
  const mo = part.motion;
  if (!mo) return d;
  const dist = (a: number) => {
    const q = matPoint(motionPose(mo, a), d.point);
    const w = sub(q, ray.o);
    const t = dot(w, ray.d);
    return len(sub(w, [ray.d[0] * t, ray.d[1] * t, ray.d[2] * t]));
  };
  const N = 48;
  let best = d.angle,
    bestD = dist(d.angle);
  for (let i = -N; i <= N; i++) {
    const a = d.angle + (d.window * i) / N;
    const v = dist(a);
    // ties go to the angle nearest the last, so it does not jump to the far side of a turn
    if (v < bestD - 1e-9) {
      best = a;
      bestD = v;
    }
  }
  // narrow it down between its neighbours
  let lo = best - d.window / N,
    hi = best + d.window / N;
  for (let k = 0; k < 30; k++) {
    const m1 = lo + (hi - lo) / 3,
      m2 = hi - (hi - lo) / 3;
    if (dist(m1) < dist(m2)) hi = m2;
    else lo = m1;
  }
  return { ...d, angle: (lo + hi) / 2 };
}

// ---------- keeping a dragged pose ----------

/** Rotations about X, then Y, then Z (degrees) that make the rotation R (column-major 4 × 4's upper 3 × 3). */
export function eulerXYZ(m: Mat): V3 {
  // R = Rz Ry Rx; R[2][0] = −sin(ry)
  const r = (i: number, j: number) => m[j * 4 + i];
  const sy = -r(2, 0);
  const deg = (x: number) => (x * 180) / Math.PI;
  if (Math.abs(sy) < 0.999999) return [deg(Math.atan2(r(2, 1), r(2, 2))), deg(Math.asin(sy)), deg(Math.atan2(r(1, 0), r(0, 0)))];
  // straight up or down: the turn about X and Z are one; put it all on X
  return [deg(Math.atan2(-r(1, 2), r(1, 1))), sy > 0 ? 90 : -90, 0];
}

/** rotate: (rx, ry, rz) about X, then Y, then Z, then at: */
const placeXforms = (r: V3, at: V3): Xform[] => [
  ...([0, 1, 2] as const).filter((k) => r[k]).map((k): Xform => ({ op: "rotate", angle: r[k], origin: [0, 0, 0], axis: [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0] })),
  { op: "translate", v: at },
];
const vec = (v: V3, digits: number) => `(${v.map((x) => fmtNum(Math.abs(x) < 10 ** -digits / 2 ? 0 : x, digits)).join(", ")})`;

/**
 * Write the dragged pose into the design: each moved part's at: and rotate: (a component's axis: or facing: as it
 * is placed) so it is drawn where it was dragged. Parts it cannot write are listed with why.
 */
export function keepPose(src: string, model: Model, moves: Map<string, BodyMove>): { src: string; kept: string[]; skipped: { name: string; why: string }[] } {
  const deltas = mateDeltas(model, moves);
  const kept: string[] = [];
  const skipped: { name: string; why: string }[] = [];
  const done = new Set<string>();
  let out = src;
  for (const p of model.parts) {
    const D = deltas.get(p.id);
    if (!D || done.has(p.insert?.block ?? p.name)) continue;
    done.add(p.insert?.block ?? p.name);
    if (p.insert) {
      // a placed design keeps its pose in its own at: and rotate:
      const ins = model.inserts?.find((i) => i.name === p.insert!.block);
      const W = ins && mulMat(D, xformMatrix(placeXforms(ins.rotate, ins.at)));
      const r = W && eulerXYZ(W);
      const next = W && r ? setBlockProps(out, ins.name, { at: vec([W[12], W[13], W[14]], 3), rotate: r.every((x) => Math.abs(x) < 0.005) ? null : vec(r, 2) }) : out;
      if (next === out) skipped.push({ name: p.insert.block, why: "its block was not found" });
      else {
        out = next;
        kept.push(p.insert.block);
      }
      continue;
    }
    if (p.frame) {
      skipped.push({ name: p.name, why: "it is a member of a frame" });
      continue;
    }
    if (p.id.includes("#")) {
      skipped.push({ name: p.name, why: "it is one of a pattern" });
      continue;
    }
    // where it is drawn now (its own placement, then the mates' move), and where it was dragged
    const W = mulMat(D, xformMatrix(p.xf));
    const at: V3 = [W[12], W[13], W[14]];
    const props: Record<string, string | null> = { at: vec(at, 3) };
    const turned = rotAxisAngle([D[0], D[4], D[8], D[1], D[5], D[9], D[2], D[6], D[10]]).angle > 1e-9;
    if (p.kind === "part" || p.placement === "free") {
      const r = eulerXYZ(W);
      props.rotate = r.every((x) => Math.abs(x) < 0.005) ? null : vec(r, 2);
    } else if (p.placement === "axis") {
      // a component along its axis: the axis, and its turn about it from the frame Kerf puts it in
      const n = matDir(W, [0, 0, 1]);
      const { u, v } = frameFor(n);
      const x = matDir(W, [1, 0, 0]);
      const rot = (Math.atan2(dot(x, v), dot(x, u)) * 180) / Math.PI;
      props.axis = vec(n, 4);
      props.rotate = Math.abs(rot) < 0.005 ? null : fmtNum(rot, 2);
    } else if (p.placement === "facing") {
      const z = matDir(W, [0, 0, 1]);
      if (turned && Math.abs(z[2] - 1) > 1e-6) {
        skipped.push({ name: p.name, why: "it is placed by facing:, which only turns it about Z" });
        continue;
      }
      if (turned) props.facing = vec(matDir(W, [1, 0, 0]), 4);
    } else if (turned) {
      skipped.push({ name: p.name, why: "it is placed by a board" });
      continue;
    }
    const next = setBlockProps(out, p.name, props);
    if (next === out) {
      skipped.push({ name: p.name, why: "its block was not found" });
      continue;
    }
    out = next;
    kept.push(p.name);
  }
  return { src: out, kept, skipped };
}

