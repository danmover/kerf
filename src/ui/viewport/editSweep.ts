// Which way an edit sweeps through a part in the 3D view, so a change shows its work: a cut goes in from where its
// tool enters, an added feature grows out from what it stands on, a pattern fans out from its first copy, and a
// rounded or chamfered edge rolls along the edges that changed. Worked out from what changed in the part's recipe,
// else from where its edges moved (edgeSweep). Everything here is in the part's own frame.

import { applyXforms, applyXformsToDir, type PartOp, type PartRecipe, type ShapeRecipe, type V3 } from "../../kernel/recipe";

export interface Sweep {
  /** across: a flat front moving along dir; out: a sphere growing from origin */
  mode: "across" | "out";
  /** where it starts */
  origin: V3;
  /** the way it runs, unit */
  dir: V3;
  /** how far it runs, mm */
  range: number;
}

export interface Box {
  min: V3;
  max: V3;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 1];
};
const near = (a: V3, b: V3, tol = 1e-6) => len(sub(a, b)) <= tol;

/** A tool with an axis: where it starts, the way it goes and how far. */
interface Axial {
  at: V3;
  dir: V3;
  len: number;
}

function axialOf(s: ShapeRecipe): Axial | null {
  switch (s.t) {
    case "cyl":
    case "cone":
    case "knurl":
    case "tube":
    case "prism":
      return { at: s.at, dir: unit(s.dir), len: s.h };
    case "gear":
      return { at: s.at, dir: unit(s.dir), len: s.w };
    case "thread":
      return { at: s.at, dir: unit(s.dir), len: s.length };
    case "flight":
      return { at: s.at, dir: unit(s.dir), len: s.length };
    case "hole":
      return { at: s.at, dir: unit(s.dir), len: s.depth };
    case "rrect": {
      const d = unit(s.dir);
      return { at: s.center ? sub(s.at, scale(d, s.depth / 2)) : s.at, dir: d, len: s.depth };
    }
    case "sk_extrude": {
      const n = unit(s.n);
      const from = add(s.o, scale(n, s.start));
      return s.h >= 0 ? { at: from, dir: n, len: s.h } : { at: from, dir: scale(n, -1), len: -s.h };
    }
    case "extrude": {
      const n = unit(s.f.n);
      return s.h >= 0 ? { at: s.f.o, dir: n, len: s.h } : { at: s.f.o, dir: scale(n, -1), len: -s.h };
    }
    case "lod":
      return axialOf(s.fast);
    case "xform": {
      const a = axialOf(s.shape);
      return a ? { at: applyXforms(a.at, s.xf), dir: unit(applyXformsToDir(a.dir, s.xf)), len: a.len } : null;
    }
    default:
      return null;
  }
}

/** The middle of a shape, roughly (null when it can't be told cheaply). */
export function shapeCentre(s: ShapeRecipe): V3 | null {
  switch (s.t) {
    case "box":
      // a box stands on `at`, the middle of its bottom face
      return [s.at[0], s.at[1], s.at[2] + s.h / 2];
    case "sphere":
      return s.at;
    case "union": {
      const cs = s.shapes.map(shapeCentre);
      if (!cs.length || cs.some((c) => !c)) return null;
      return scale((cs as V3[]).reduce((a: V3, c: V3) => add(a, c), [0, 0, 0]), 1 / cs.length);
    }
    case "xform": {
      const c = shapeCentre(s.shape);
      return c ? applyXforms(c, s.xf) : null;
    }
    case "lod":
      return shapeCentre(s.fast);
    default: {
      const a = axialOf(s);
      return a ? add(a.at, scale(a.dir, a.len / 2)) : null;
    }
  }
}

/** How far a shape reaches from its middle, roughly. */
function shapeReach(s: ShapeRecipe): number {
  switch (s.t) {
    case "box":
      return Math.hypot(s.w, s.d, s.h) / 2;
    case "sphere":
      return s.d / 2;
    case "cyl":
    case "knurl":
      return Math.hypot(s.d, s.h) / 2;
    case "tube":
      return Math.hypot(s.od, s.h) / 2;
    case "cone":
      return Math.hypot(Math.max(s.d1, s.d2), s.h) / 2;
    case "hole":
      return Math.hypot(Math.max(s.d, s.cbore?.[0] ?? 0, s.csink ?? 0), s.depth) / 2;
    case "gear":
      return Math.hypot(s.m * (s.z + 2), s.w) / 2;
    case "xform":
      return shapeReach(s.shape);
    case "lod":
      return shapeReach(s.fast);
    default: {
      const a = axialOf(s);
      return a ? a.len / 2 : 1;
    }
  }
}

/** The copies of a patterned tool, first copy first (null when the shape is one tool). */
function copiesOf(s: ShapeRecipe): { centres: V3[]; reach: number } | null {
  if (s.t === "union" && s.shapes.length >= 2) {
    const centres = s.shapes.map(shapeCentre);
    if (centres.some((c) => !c)) return null;
    return { centres: centres as V3[], reach: shapeReach(s.shapes[0]) };
  }
  if (s.t === "instances" && s.items.length) {
    const it = s.items[0];
    const c = shapeCentre(it.shape);
    if (!c) return null;
    const centres = it.xfs.map((xf) => applyXforms(c, xf));
    return centres.length >= 2 ? { centres, reach: shapeReach(it.shape) } : null;
  }
  if (s.t === "xform") {
    const inner = copiesOf(s.shape);
    return inner ? { centres: inner.centres.map((c) => applyXforms(c, s.xf)), reach: inner.reach } : null;
  }
  if (s.t === "union" && s.shapes.length === 1) return copiesOf(s.shapes[0]);
  return null;
}

/** How far a point lies outside a box (0 inside). */
function outside(p: V3, b: Box): number {
  let d = 0;
  for (let k = 0; k < 3; k++) d = Math.max(d, b.min[k] - p[k], p[k] - b.max[k]);
  return d;
}

/** The sweep of a tool added or cut, against the part's box as it was. */
export function toolSweep(s: ShapeRecipe, kind: "add" | "cut", part: Box): Sweep | null {
  // a pattern fans out from its first copy
  const copies = copiesOf(s);
  if (copies) {
    const o = copies.centres[0];
    const far = Math.max(...copies.centres.map((c) => len(sub(c, o))));
    return { mode: "out", origin: o, dir: [0, 0, 1], range: far + copies.reach };
  }
  if (s.t === "union" && s.shapes.length === 1) return toolSweep(s.shapes[0], kind, part);
  if (s.t === "sphere") return { mode: "out", origin: s.at, dir: [0, 0, 1], range: s.d / 2 };
  if (s.t === "box") return boxSweep(s.at, [s.w, s.d, s.h], kind, part);
  if (s.t === "xform") {
    const inner = toolSweep(s.shape, kind, part);
    if (!inner) return null;
    return { ...inner, origin: applyXforms(inner.origin, s.xf), dir: unit(applyXformsToDir(inner.dir, s.xf)) };
  }
  const a = axialOf(s);
  if (!a || a.len <= 0) return null;
  // a hole is drilled from where it starts; an added feature grows from its base
  if (s.t === "hole" || kind === "add") return { mode: "across", origin: a.at, dir: a.dir, range: a.len };
  // a cut goes in from the end that is outside the part (from above, when both are and it stands upright)
  const end = add(a.at, scale(a.dir, a.len));
  const o0 = outside(a.at, part);
  const o1 = outside(end, part);
  const fromEnd = o0 > 0 && o1 > 0 && Math.abs(a.dir[2]) > 0.5 ? end[2] > a.at[2] : o1 > o0;
  return fromEnd ? { mode: "across", origin: end, dir: scale(a.dir, -1), range: a.len } : { mode: "across", origin: a.at, dir: a.dir, range: a.len };
}

/**
 * A box (standing on `at`, the middle of its bottom face) added or cut: along the side it stands out of the part
 * most, growing from the part or cutting in from outside.
 */
function boxSweep(at: V3, size: V3, kind: "add" | "cut", part: Box): Sweep {
  const lows: V3 = [at[0] - size[0] / 2, at[1] - size[1] / 2, at[2]];
  let best = -1;
  let k = 2;
  let up = true;
  for (let i = 0; i < 3; i++) {
    const lo = lows[i];
    const hi = lows[i] + size[i];
    const above = Math.max(0, hi - part.max[i]);
    const below = Math.max(0, part.min[i] - lo);
    const out = Math.max(above, below) / Math.max(size[i], 1e-6);
    // ties go to Z, the way most things are built
    if (out > best + 1e-9 || (Math.abs(out - best) <= 1e-9 && i === 2)) {
      best = out;
      k = i;
      up = above >= below;
    }
  }
  const dir: V3 = [0, 0, 0];
  const origin: V3 = [lows[0] + size[0] / 2, lows[1] + size[1] / 2, lows[2] + size[2] / 2];
  // an add grows away from the part; a cut comes in from the side it stands out of (from the top when inside)
  const sign = best <= 0 ? (kind === "add" ? 1 : -1) : kind === "add" ? (up ? 1 : -1) : up ? -1 : 1;
  dir[k] = sign;
  origin[k] = sign > 0 ? lows[k] : lows[k] + size[k];
  return { mode: "across", origin, dir, range: size[k] };
}

/** The sweep of one step of a recipe, done or undone (null: the step has no tool, so its edges tell instead). */
function stepSweep(op: PartOp, part: Box, undone = false): Sweep | null {
  if (op.op !== "add" && op.op !== "cut") return null;
  const kind = (op.op === "add") !== undone ? "add" : "cut";
  return toolSweep(op.shape, kind, part);
}

/** A step whose tool changed: the bit added to its length, or the way it moved. */
function changedStepSweep(was: PartOp, now: PartOp, part: Box): Sweep | null {
  if ((was.op !== "add" && was.op !== "cut") || now.op !== was.op) return null;
  const a = axialOf(was.shape);
  const b = axialOf(now.shape);
  if (a && b && near(a.dir, b.dir) && near(a.at, b.at) && Math.abs(a.len - b.len) > 1e-6) {
    const from = Math.min(a.len, b.len);
    return { mode: "across", origin: add(b.at, scale(b.dir, from)), dir: b.dir, range: Math.max(0.5, Math.abs(a.len - b.len)) };
  }
  const ca = shapeCentre(was.shape);
  const cb = shapeCentre(now.shape);
  if (ca && cb && !copiesOf(now.shape)) {
    const move = sub(cb, ca);
    const d = len(move);
    // moved: across from where it was to where it is
    if (d > 1e-6) {
      const dir = unit(move);
      const r = shapeReach(now.shape);
      return { mode: "across", origin: sub(ca, scale(dir, r)), dir, range: d + 2 * r };
    }
  }
  return toolSweep(now.shape, now.op === "add" ? "add" : "cut", part);
}

/** The side of the part's box that moved most: across from where it was to where it is (null when none moved). */
export function boundsSweep(was: Box, now: Box): Sweep | null {
  let best = 0;
  let pick: Sweep | null = null;
  const size = Math.max(...[0, 1, 2].map((k) => Math.max(was.max[k] - was.min[k], now.max[k] - now.min[k])), 1e-6);
  for (let k = 0; k < 3; k++) {
    for (const side of [1, -1] as const) {
      const a = side > 0 ? was.max[k] : was.min[k];
      const b = side > 0 ? now.max[k] : now.min[k];
      const d = Math.abs(b - a);
      if (d > best && d > size * 0.01) {
        best = d;
        const dir: V3 = [0, 0, 0];
        dir[k] = Math.sign(b - a);
        const origin: V3 = [(now.min[0] + now.max[0]) / 2, (now.min[1] + now.max[1]) / 2, (now.min[2] + now.max[2]) / 2];
        origin[k] = a;
        pick = { mode: "across", origin, dir, range: d };
      }
    }
  }
  return pick;
}

const stepKey = (x: unknown) => JSON.stringify(x);

/**
 * How an edit from `before` to `after` sweeps through the part, from the steps that changed: one step added, undone
 * or changed, a row of them added (a different base: by the side that moved). Null when the recipe can't tell, as
 * for a fillet; edgeSweep can then.
 */
export function editSweep(before: PartRecipe, after: PartRecipe, was: Box, now: Box): Sweep | null {
  const a = before.ops;
  const b = after.ops;
  if (stepKey(before.base) !== stepKey(after.base)) return boundsSweep(was, now);
  let i = 0;
  while (i < a.length && i < b.length && stepKey(a[i]) === stepKey(b[i])) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && stepKey(a[a.length - 1 - j]) === stepKey(b[b.length - 1 - j])) j++;
  const added = b.slice(i, b.length - j);
  const removed = a.slice(i, a.length - j);
  if (added.length === 1 && !removed.length) return stepSweep(added[0], was);
  if (!added.length && removed.length === 1) return stepSweep(removed[0], was, true);
  if (added.length === 1 && removed.length === 1) return changedStepSweep(removed[0], added[0], was);
  // a row of steps of the same kind (a loop of holes): out from the first
  if (added.length >= 2 && !removed.length) return fanSweep(added);
  return null;
}

/** Steps that each add or cut a tool, as a pattern fanning out from the first one's tool. */
function fanSweep(steps: PartOp[]): Sweep | null {
  const centres: V3[] = [];
  let reach = 0;
  for (const op of steps) {
    if (op.op !== "add" && op.op !== "cut") return null;
    const c = shapeCentre(op.shape);
    if (!c) return null;
    centres.push(c);
    reach = Math.max(reach, shapeReach(op.shape));
  }
  const o = centres[0];
  return { mode: "out", origin: o, dir: [0, 0, 1], range: Math.max(...centres.map((c) => len(sub(c, o)))) + reach };
}

/** The most points edgeSweep samples along the two outlines. */
const EDGE_SAMPLES = 16000;

/**
 * The sweep from where a part's outline changed: points along the new edges that no old edge passes near, and along
 * the old edges no new one does. A long run of them is swept along its length (a fillet rolling along its edge), a
 * bunch of them out from their middle. `edges` are line-segment pairs in the part's frame.
 */
export function edgeSweep(before: ArrayLike<number>, after: ArrayLike<number>): Sweep | null {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  let total = 0;
  for (const E of [before, after]) {
    for (let i = 0; i + 5 < E.length; i += 6) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], E[i + k], E[i + 3 + k]);
        hi[k] = Math.max(hi[k], E[i + k], E[i + 3 + k]);
      }
      total += Math.hypot(E[i + 3] - E[i], E[i + 4] - E[i + 1], E[i + 5] - E[i + 2]);
    }
  }
  if (!Number.isFinite(lo[0]) || total <= 0) return null;
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const cell = Math.max(0.3, diag / 200, total / EDGE_SAMPLES);
  const hash = (ix: number, iy: number, iz: number) => (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
  // points every cell or so along each segment, with the cell they fall in
  const each = (E: ArrayLike<number>, f: (ix: number, iy: number, iz: number, x: number, y: number, z: number) => void) => {
    for (let i = 0; i + 5 < E.length; i += 6) {
      const l = Math.hypot(E[i + 3] - E[i], E[i + 4] - E[i + 1], E[i + 5] - E[i + 2]);
      const n = Math.max(1, Math.ceil(l / cell));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const x = E[i] + (E[i + 3] - E[i]) * t;
        const y = E[i + 1] + (E[i + 4] - E[i + 1]) * t;
        const z = E[i + 2] + (E[i + 5] - E[i + 2]) * t;
        f(Math.floor((x - lo[0]) / cell), Math.floor((y - lo[1]) / cell), Math.floor((z - lo[2]) / cell), x, y, z);
      }
    }
  };
  const cells = (E: ArrayLike<number>) => {
    const s = new Set<number>();
    each(E, (ix, iy, iz) => s.add(hash(ix, iy, iz)));
    return s;
  };
  const oldCells = cells(before);
  const newCells = cells(after);
  const pts: number[] = [];
  const nearAny = (s: Set<number>, ix: number, iy: number, iz: number) => {
    if (s.has(hash(ix, iy, iz))) return true;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (s.has(hash(ix + dx, iy + dy, iz + dz))) return true;
    return false;
  };
  each(after, (ix, iy, iz, x, y, z) => {
    if (!nearAny(oldCells, ix, iy, iz)) pts.push(x, y, z);
  });
  each(before, (ix, iy, iz, x, y, z) => {
    if (!nearAny(newCells, ix, iy, iz)) pts.push(x, y, z);
  });
  const n = pts.length / 3;
  if (n < 3) return null;
  const c: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) c[k] += pts[i + k] / n;
  // the way the changed points spread most (power iteration on their covariance)
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < pts.length; i += 3) {
    const d = [pts[i] - c[0], pts[i + 1] - c[1], pts[i + 2] - c[2]];
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) cov[r * 3 + q] += d[r] * d[q];
  }
  let v: V3 = [0.577, 0.577, 0.578];
  for (let it = 0; it < 32; it++) v = unit([cov[0] * v[0] + cov[1] * v[1] + cov[2] * v[2], cov[3] * v[0] + cov[4] * v[1] + cov[5] * v[2], cov[6] * v[0] + cov[7] * v[1] + cov[8] * v[2]]);
  // one way round each time: top down when it runs up and down, else towards +X, +Y
  const big = [0, 1, 2].reduce((m, k) => (Math.abs(v[k]) > Math.abs(v[m]) ? k : m), 0);
  if ((big === 2 && v[2] > 0) || (big !== 2 && v[big] < 0)) v = scale(v, -1);
  let pMin = Infinity;
  let pMax = -Infinity;
  let across = 0;
  let reach = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const d: V3 = [pts[i] - c[0], pts[i + 1] - c[1], pts[i + 2] - c[2]];
    const p = dot(d, v);
    pMin = Math.min(pMin, p);
    pMax = Math.max(pMax, p);
    across = Math.max(across, len(sub(d, scale(v, p))));
    reach = Math.max(reach, len(d));
  }
  const along = pMax - pMin;
  // a bunch, not a run: out from its middle
  if (along < 4 * cell || across > 0.6 * (along / 2)) return { mode: "out", origin: c, dir: [0, 0, 1], range: reach + cell };
  return { mode: "across", origin: add(c, scale(v, pMin - cell)), dir: v, range: along + 2 * cell };
}
