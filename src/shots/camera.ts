// Shot camera maths: where the camera stands so the subject fills the frame
// the way the shot asks, with the camera looking straight along the shot
// angle. Composition (fill and the subject's offset in the frame) is solved
// exactly for the outermost points of the subject, so a long lens and a wide
// one frame the same product the same size; only the perspective changes.

import type { V3 } from "../kernel/recipe";
import { aspectRatio, horizontalFov, verticalFov, viewDirection, type ShotSpec } from "./spec";

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (...vs: V3[]): V3 => vs.reduce<V3>((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface CameraBasis {
  /** where the camera looks */
  forward: V3;
  right: V3;
  up: V3;
}

/** The camera's axes for a shot angle and roll (degrees). */
export function shotBasis(angle: [number, number], roll = 0): CameraBasis {
  const height = Math.max(-89.5, Math.min(89.5, angle[1]));
  const forward = scale(viewDirection(angle[0], height), -1);
  let right = norm(cross(forward, [0, 0, 1]));
  let up = cross(right, forward);
  if (roll) {
    const r = (roll * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    // positive roll turns the picture clockwise (the camera counter-clockwise)
    const r2 = add(scale(right, c), scale(up, s));
    const u2 = add(scale(up, c), scale(right, -s));
    right = r2;
    up = u2;
  }
  return { forward, right, up };
}

export interface ShotCamera extends CameraBasis {
  position: V3;
  /** vertical field of view, degrees */
  vfov: number;
  aspect: number;
  /** centre of the subject's bounding box */
  center: V3;
  /** distance from the camera to the subject's centre along the view */
  distance: number;
  /** nearest and farthest subject points along the view */
  depth: [number, number];
  /** the subject's extent on screen in normalised device coordinates (-1..1) */
  extent: { minX: number; maxX: number; minY: number; maxY: number };
}

/** Where a point lands on screen (NDC, -1..1, y up) and how far in front of the camera it is. */
export function project(cam: Pick<ShotCamera, "position" | "forward" | "right" | "up" | "vfov" | "aspect">, p: V3): { x: number; y: number; z: number } {
  const q: V3 = [p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]];
  const z = dot(q, cam.forward);
  const ty = Math.tan((cam.vfov * Math.PI) / 360);
  const tx = ty * cam.aspect;
  return { x: dot(q, cam.right) / (Math.max(z, 1e-6) * tx), y: dot(q, cam.up) / (Math.max(z, 1e-6) * ty), z };
}

type Framing = Pick<ShotSpec, "angle" | "roll" | "lens" | "fill" | "offset"> & { aspect: number | string };

/**
 * Solve the camera for a subject given as points (mesh vertices or box
 * corners, in assembly coordinates). The subject's widest axis on screen fills
 * `fill` of the frame, and the middle of its extent sits at `offset`.
 */
export function solveFraming(points: V3[], f: Framing): ShotCamera {
  const aspect = typeof f.aspect === "number" ? f.aspect : aspectRatio(f.aspect);
  const vfov = verticalFov(f.lens, aspect);
  const hfov = horizontalFov(f.lens, aspect);
  const tx = Math.tan((hfov * Math.PI) / 360);
  const ty = Math.tan((vfov * Math.PI) / 360);
  const basis = shotBasis(f.angle, f.roll);
  const pts = points.length ? points : ([[-10, -10, 0], [10, 10, 20]] as V3[]);
  // the subject in camera axes
  const X = pts.map((p) => dot(p, basis.right));
  const Y = pts.map((p) => dot(p, basis.up));
  const Z = pts.map((p) => dot(p, basis.forward));
  const lo = (a: number[]) => a.reduce((m, v) => Math.min(m, v), Infinity);
  const hi = (a: number[]) => a.reduce((m, v) => Math.max(m, v), -Infinity);
  const box = { min: [Infinity, Infinity, Infinity] as V3, max: [-Infinity, -Infinity, -Infinity] as V3 };
  for (const p of pts)
    for (let k = 0; k < 3; k++) {
      box.min[k] = Math.min(box.min[k], p[k]);
      box.max[k] = Math.max(box.max[k], p[k]);
    }
  const center: V3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const size = Math.max(Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]), 1);
  const fill = Math.max(0.05, Math.min(1.2, f.fill));
  const cx = 2 * f.offset[0];
  const cy = 2 * f.offset[1];

  // tight fit along one screen axis: the camera depth at which the subject spans [c - fill, c + fill]
  const depthFor = (A: number[], t: number, c: number) => {
    const ka = (c - fill) * t;
    const kb = (c + fill) * t;
    let Mb = -Infinity;
    let ma = Infinity;
    for (let i = 0; i < A.length; i++) {
      Mb = Math.max(Mb, A[i] - kb * Z[i]);
      ma = Math.min(ma, A[i] - ka * Z[i]);
    }
    return (ma - Mb) / (kb - ka);
  };
  let cz = Math.min(depthFor(X, tx, cx), depthFor(Y, ty, cy));
  // never inside the subject
  cz = Math.min(cz, lo(Z) - size * 0.05 - 1);

  // with the depth set, slide sideways until the subject's extent is centred on the offset
  const centreAt = (A: number[], t: number, c: number) => {
    const mid = (C: number) => {
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = 0; i < A.length; i++) {
        const v = (A[i] - C) / ((Z[i] - cz) * t);
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
      return (mn + mx) / 2 - c;
    };
    let a = lo(A) - size * 50;
    let b = hi(A) + size * 50;
    for (let i = 0; i < 80; i++) {
      const m = (a + b) / 2;
      if (mid(m) > 0) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  const camX = centreAt(X, tx, cx);
  const camY = centreAt(Y, ty, cy);
  const position = add(scale(basis.right, camX), scale(basis.up, camY), scale(basis.forward, cz));
  const cam = { ...basis, position, vfov, aspect };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let near = Infinity;
  let far = -Infinity;
  for (const p of pts) {
    const s = project(cam, p);
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y);
    maxY = Math.max(maxY, s.y);
    near = Math.min(near, s.z);
    far = Math.max(far, s.z);
  }
  const toCentre: V3 = [center[0] - position[0], center[1] - position[1], center[2] - position[2]];
  return { ...cam, center, distance: dot(toCentre, basis.forward), depth: [near, far], extent: { minX, maxX, minY, maxY } };
}

/** Distance from the camera to a point, along the view. */
export function depthOf(cam: Pick<ShotCamera, "position" | "forward">, p: V3): number {
  return dot([p[0] - cam.position[0], p[1] - cam.position[1], p[2] - cam.position[2]], cam.forward);
}

/**
 * A camera that circles the subject: for each turn (degrees added to the shot's
 * turn) the camera keeps one distance from a pivot, far enough back that the
 * subject fits the frame at every turn, and keeps the shot's composition offset.
 */
export function orbitCameras(points: V3[], f: Framing, turns: number[], heights?: number[]): ShotCamera[] {
  const solved = turns.map((t, i) => solveFraming(points, { ...f, angle: [f.angle[0] + t, heights?.[i] ?? f.angle[1]] }));
  const pivot = solved[0].center;
  // the farthest any turn needs to be, measured from the pivot along the view
  const back = Math.max(...solved.map((c) => -depthOfPivot(c, pivot)));
  return solved.map((c) => {
    const lateral = add(scale(c.right, dot(sub(c.position, pivot), c.right)), scale(c.up, dot(sub(c.position, pivot), c.up)));
    // keep the offset the shot asked for, at the common distance
    const k = back / Math.max(1e-6, -depthOfPivot(c, pivot));
    const position = add(pivot, scale(lateral, k), scale(c.forward, -back));
    return { ...c, position, distance: back };
  });
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Signed position of the camera along its own view, measured from the pivot (negative: behind it). */
const depthOfPivot = (c: ShotCamera, pivot: V3) => dot(sub(c.position, pivot), c.forward);
