// Two-part moulds: a block round a part, split across the pull, with
// registration keys, clamping bolt holes, a pour hole (sprue) and air vents.
// Runs in the kernel worker; mould() in the language describes one half.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { vcross, vdot, vlen, vnorm, type ShapeRecipe, type V3 } from "./recipe";

type Mould = Extract<ShapeRecipe, { t: "mould" }>;

export class MouldError extends Error {}

/** Area of the convex hull of 2D points (monotone chain). */
export function hullArea(pts: [number, number][]): number {
  if (pts.length < 3) return 0;
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let a = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % hull.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

interface Tri {
  v: number[];
  t: number[];
}

/** Points where the mesh crosses the plane z = h. */
function sectionAt(m: Tri, h: number): [number, number][] {
  const out: [number, number][] = [];
  const P = (i: number): V3 => [m.v[i * 3], m.v[i * 3 + 1], m.v[i * 3 + 2]];
  for (let k = 0; k < m.t.length; k += 3) {
    const tri = [P(m.t[k]), P(m.t[k + 1]), P(m.t[k + 2])];
    for (let e = 0; e < 3; e++) {
      const a = tri[e];
      const b = tri[(e + 1) % 3];
      if ((a[2] - h) * (b[2] - h) > 0 || a[2] === b[2]) continue;
      const s = (h - a[2]) / (b[2] - a[2]);
      out.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
    }
  }
  return out;
}

/**
 * Where to split a mould along z: the lowest height at which the part's outline seen along the
 * pull is widest. A lid opening downward splits at its rim, a ball at its equator, a cup or a
 * block at its base (the whole part in the top half over a flat bottom plate).
 */
export function autoSplit(m: Tri, z0: number, z1: number): number {
  const N = 48;
  const areas: number[] = [];
  for (let j = 0; j < N; j++) areas.push(hullArea(sectionAt(m, z0 + ((z1 - z0) * (j + 0.5)) / N)));
  const top = Math.max(...areas);
  const best = areas.findIndex((a) => a >= top * 0.995);
  if (best <= 0) return z0;
  if (best >= N - 1) return z1;
  return z0 + ((z1 - z0) * (best + 0.5)) / N;
}

const ALIGN = (pull: V3): { axis: V3; angle: number } | null => {
  const n = vnorm(pull);
  const c = vdot(n, [0, 0, 1]);
  if (c > 1 - 1e-9) return null;
  if (c < -1 + 1e-9) return { axis: [1, 0, 0], angle: 180 };
  const axis = vnorm(vcross(n, [0, 0, 1]));
  return { axis, angle: (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI };
};

/**
 * One half of the mould. The part comes in built in its own frame; place puts it where the
 * design has it. The mould is worked out with the pull along +z and turned back at the end.
 */
export function buildMould(r: Mould, partLocal: Shape3D, place: (s: Shape3D) => Shape3D): Shape3D {
  const align = ALIGN(r.pull);
  const turn = (s: Shape3D, sign: 1 | -1) => (align ? s.rotate(sign * align.angle, [0, 0, 0], align.axis) : s);
  let part = turn(place(partLocal), 1);
  let [lo, hi] = part.boundingBox.bounds;
  if (r.shrink > 0) {
    const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    part = part.scale(1 + r.shrink, c);
    [lo, hi] = part.boundingBox.bounds;
  }
  const mesh = part.mesh({ tolerance: 0.2, angularTolerance: 20 });
  const tri: Tri = { v: mesh.vertices, t: mesh.triangles };
  if (!tri.t.length) throw new MouldError("the part has no surface to mould");
  const w = r.wall;
  const h = r.split ?? autoSplit(tri, lo[2], hi[2]);
  if (h < lo[2] - 1e-6 || h > hi[2] + 1e-6) throw new MouldError(`split ${Math.round(h * 100) / 100} is outside the part, which runs from ${Math.round(lo[2] * 100) / 100} to ${Math.round(hi[2] * 100) / 100} along the pull`);
  const b0: V3 = [lo[0] - w, lo[1] - w, lo[2] - w];
  const b1: V3 = [hi[0] + w, hi[1] + w, hi[2] + w];
  const block = R.makeBox(b0, b1).cut(part);
  const above = block.intersect(R.makeBox([b0[0] - 1, b0[1] - 1, h], [b1[0] + 1, b1[1] + 1, b1[2] + 1])) as Shape3D;
  const below = block.intersect(R.makeBox([b0[0] - 1, b0[1] - 1, b0[2] - 1], [b1[0] + 1, b1[1] + 1, h])) as Shape3D;
  // a core standing in a hollow belongs to the half it pulls out with: islands of one half that reach
  // neither of its outer faces join the other half across the split
  const tol = 1e-3;
  const halves: Record<"top" | "bottom", Shape3D[]> = { top: [], bottom: [] };
  for (const s of solidsOf(above)) {
    const [a, b] = s.boundingBox.bounds;
    if (b[2] >= b1[2] - tol) halves.top.push(s);
    else if (a[2] <= h + tol) halves.bottom.push(s);
  }
  for (const s of solidsOf(below)) {
    const [a, b] = s.boundingBox.bounds;
    if (a[2] <= b0[2] + tol) halves.bottom.push(s);
    else if (b[2] >= h - tol) halves.top.push(s);
  }
  const mine = halves[r.half];
  if (!mine.length) throw new MouldError(`the ${r.half} half is empty: the split leaves the whole part in the other half`);
  let half = mine.reduce((a, b) => a.fuse(b));

  // registration keys at the corners: bumps on the bottom half, sockets in the top
  const kd = Math.max(2, Math.min(10, w * 0.6));
  const kh = kd * 0.5;
  const corners: [number, number][] = [
    [b0[0] + w / 2, b0[1] + w / 2],
    [b1[0] - w / 2, b1[1] - w / 2],
    [b1[0] - w / 2, b0[1] + w / 2],
    [b0[0] + w / 2, b1[1] - w / 2],
  ];
  const keys = r.keys >= 4 ? corners : r.keys >= 2 ? corners.slice(0, 2) : [];
  for (const [x, y] of keys) {
    if (r.half === "bottom") half = half.fuse(cone(kd, kd * 0.6, kh, [x, y, h - 0.01]));
    else half = half.cut(cone(kd + 0.4, kd * 0.6 + 0.4, kh + 0.2, [x, y, h - 0.01]));
  }
  // clamping bolts through both halves, midway along each side
  if (r.bolt > 0) {
    const cx = (b0[0] + b1[0]) / 2;
    const cy = (b0[1] + b1[1]) / 2;
    const spots: [number, number][] = [
      [cx, b0[1] + w / 2],
      [cx, b1[1] - w / 2],
      [b0[0] + w / 2, cy],
      [b1[0] - w / 2, cy],
    ];
    for (const [x, y] of spots) half = half.cut(R.makeCylinder(r.bolt / 2, b1[2] - b0[2] + 2, [x, y, b0[2] - 1], [0, 0, 1]));
  }
  // the pour hole into the part's highest point, and vents from its other high points
  if (r.half === "top" && (r.sprue > 0 || r.vents > 0)) {
    const P = (i: number): V3 => [tri.v[i * 3], tri.v[i * 3 + 1], tri.v[i * 3 + 2]];
    const n = tri.v.length / 3;
    const cx = (lo[0] + hi[0]) / 2;
    const cy = (lo[1] + hi[1]) / 2;
    const top = topSurface(tri);
    /** a hole of radius rad at (x, y) opens wholly onto the part's top surface, none of it over a lower edge */
    const opens = (x: number, y: number, z: number, rad: number) => {
      for (let k = 0; k < 12; k++) {
        const a = (k * Math.PI) / 6;
        if (top(x + rad * Math.cos(a), y + rad * Math.sin(a)) < z - 0.25) return false;
      }
      return true;
    };
    // the sprue: the highest place the pour hole fits on, nearest the middle (a grid over the part, its middle first)
    let peak: V3 | null = null;
    const N = 20;
    const spots: [number, number][] = [[cx, cy]];
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) spots.push([lo[0] + ((hi[0] - lo[0]) * i) / N, lo[1] + ((hi[1] - lo[1]) * j) / N]);
    const mid = (p: [number, number] | V3) => Math.hypot(p[0] - cx, p[1] - cy);
    for (const [x, y] of spots) {
      const z = top(x, y);
      if (z === -Infinity || (peak && (z < peak[2] - 1e-6 || (z <= peak[2] + 1e-6 && mid([x, y]) >= mid(peak))))) continue;
      if (r.sprue > 0 && !opens(x, y, z, r.sprue / 2 + 0.4)) continue;
      peak = [x, y, z];
    }
    // nowhere it fits whole: the highest point of the part
    if (!peak) {
      peak = P(0);
      for (let i = 1; i < n; i++) {
        const p = P(i);
        if (p[2] > peak[2] + 1e-6 || (Math.abs(p[2] - peak[2]) <= 1e-6 && mid(p) < mid(peak))) peak = p;
      }
    }
    const sprueAt = peak;
    if (r.sprue > 0) half = half.cut(cone(r.sprue, r.sprue * 1.8, b1[2] - sprueAt[2] + 0.4, [sprueAt[0], sprueAt[1], sprueAt[2] - 0.3]));
    if (r.vents > 0) {
      // air collects under the cavity's ceilings: the part's upward-facing surfaces. Each quarter round the
      // part vents from its highest ceiling point away from the sprue
      const vd = 2;
      const ceiling = new Uint8Array(n);
      for (let k = 0; k < tri.t.length; k += 3) {
        const [a, b, c] = [P(tri.t[k]), P(tri.t[k + 1]), P(tri.t[k + 2])];
        const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const len = vlen(vcross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
        if (len > 1e-12 && nz / len > 0.5) for (const i of [tri.t[k], tri.t[k + 1], tri.t[k + 2]]) ceiling[i] = 1;
      }
      const far = (p: V3, q: V3, d: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= d;
      const clear = r.sprue + 2 * vd;
      const quads = new Map<number, V3>();
      for (let i = 0; i < n; i++) {
        const p = P(i);
        if (!ceiling[i] || p[2] < h || (r.sprue > 0 && !far(p, sprueAt, clear))) continue;
        const q = (p[0] >= cx ? 1 : 0) + (p[1] >= cy ? 2 : 0);
        const best = quads.get(q);
        const away = (x: V3) => Math.hypot(x[0] - sprueAt[0], x[1] - sprueAt[1]);
        if (!best || p[2] > best[2] + 1e-6 || (Math.abs(p[2] - best[2]) <= 1e-6 && away(p) > away(best))) quads.set(q, p);
      }
      const picked: V3[] = [];
      for (const p0 of [...quads.values()].sort((a, b) => b[2] - a[2])) {
        if (picked.length >= r.vents) break;
        // a vent hanging over an edge of its ceiling would leave a knife-edge of mould between it and the
        // cavity: move it in toward the middle until all of it opens from the ceiling
        const dx = cx - p0[0];
        const dy = cy - p0[1];
        const len = Math.hypot(dx, dy);
        let p: V3 | null = null;
        for (let step = 0; step <= 8 && !p; step++) {
          const k = len > 1e-9 ? Math.min(len, step * 0.5) / len : 0;
          const q: V3 = [p0[0] + dx * k, p0[1] + dy * k, p0[2]];
          if (opens(q[0], q[1], q[2], vd / 2 + 0.3)) p = q;
        }
        if (!p || picked.some((q) => !far(p, q, 3 * vd)) || (r.sprue > 0 && !far(p, sprueAt, clear))) continue;
        picked.push(p);
      }
      for (const p of picked) half = half.cut(R.makeCylinder(vd / 2, b1[2] - p[2] + 1.3, [p[0], p[1], p[2] - 0.3], [0, 0, 1]));
    }
  }
  return turn(half, -1);
}

/** The height of the part's top surface over a point (seen from above), or -Infinity off the part. */
function topSurface(m: Tri): (x: number, y: number) => number {
  const nt = m.t.length / 3;
  const box = new Float64Array(nt * 4);
  for (let k = 0; k < nt; k++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let j = 0; j < 3; j++) {
      const i = m.t[k * 3 + j] * 3;
      x0 = Math.min(x0, m.v[i]);
      x1 = Math.max(x1, m.v[i]);
      y0 = Math.min(y0, m.v[i + 1]);
      y1 = Math.max(y1, m.v[i + 1]);
    }
    box.set([x0, y0, x1, y1], k * 4);
  }
  return (x, y) => {
    let best = -Infinity;
    for (let k = 0; k < nt; k++) {
      if (x < box[k * 4] - 1e-9 || x > box[k * 4 + 2] + 1e-9 || y < box[k * 4 + 1] - 1e-9 || y > box[k * 4 + 3] + 1e-9) continue;
      const a = m.t[k * 3] * 3;
      const b = m.t[k * 3 + 1] * 3;
      const c = m.t[k * 3 + 2] * 3;
      const d = (m.v[b + 1] - m.v[c + 1]) * (m.v[a] - m.v[c]) + (m.v[c] - m.v[b]) * (m.v[a + 1] - m.v[c + 1]);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((m.v[b + 1] - m.v[c + 1]) * (x - m.v[c]) + (m.v[c] - m.v[b]) * (y - m.v[c + 1])) / d;
      const l2 = ((m.v[c + 1] - m.v[a + 1]) * (x - m.v[c]) + (m.v[a] - m.v[c]) * (y - m.v[c + 1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      best = Math.max(best, l1 * m.v[a + 2] + l2 * m.v[b + 2] + l3 * m.v[c + 2]);
    }
    return best;
  };
}

function cone(d1: number, d2: number, hgt: number, at: V3): Shape3D {
  // the half-outline on a plane through the axis (x across, y up), spun about z
  const plane = new R.Plane(at, [1, 0, 0], [0, -1, 0]);
  const outline = R.draw([0, 0])
    .lineTo([d1 / 2, 0])
    .lineTo([d2 / 2, hgt])
    .lineTo([0, hgt])
    .close()
    .sketchOnPlane(plane);
  return outline.revolve([0, 0, 1], { origin: at }) as Shape3D;
}

function solidsOf(s: Shape3D): Shape3D[] {
  const list = s.solids as unknown as Shape3D[];
  return list.length ? list : [s];
}
