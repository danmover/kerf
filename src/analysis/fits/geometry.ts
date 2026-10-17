// Round features of the design in world space: the holes cut into parts and
// the round surfaces that go into holes (pins, shafts, bosses, bearing rings,
// screw shanks and heads). The fit analysis pairs them up. Everything here is
// read from the evaluated recipes, so it works without the kernel.

import type { EvalPart } from "../../core/model";
import type { PartRecipe, ShapeRecipe, V2, V3, Xform } from "../../kernel/recipe";
import { applyXforms, applyXformsToDir, vadd, vdot, vnorm, vscale, vsub } from "../../kernel/recipe";
import { THREADS, type ThreadSpec } from "../../library/standards";

export type CylRole = "plain" | "bearing-od" | "bearing-bore" | "screw" | "head" | "insert" | "gear-bore" | "thread";

export interface Cyl {
  part: EvalPart;
  /** "hole": a bore something goes into; "shaft": a round surface that goes into a hole */
  side: "hole" | "shaft";
  d: number;
  /** start of the cylinder on its axis (world), the unit axis, and its length along it */
  at: V3;
  axis: V3;
  length: number;
  /** the axis in the part's own frame, for the print direction */
  axisLocal: V3;
  role: CylRole;
  /** thread size of a screw, a tapped or threaded hole, an insert or a nut */
  thread?: ThreadSpec;
  /** hole(M3, fit: …) as written */
  holeFit?: string;
}

const EPS = 1e-6;

/** Thread spec for a name such as "M3" or "M2.5". */
export function threadByName(name: string | undefined): ThreadSpec | undefined {
  if (!name) return undefined;
  return THREADS[name] ?? THREADS[name.replace(".", "_")] ?? Object.values(THREADS).find((t) => t.name === name);
}

/** The end point of a cylinder. */
export const cylEnd = (c: Cyl): V3 => vadd(c.at, vscale(c.axis, c.length));
/** The middle of a cylinder. */
export const cylMid = (c: Cyl): V3 => vadd(c.at, vscale(c.axis, c.length / 2));

// ---------- local bounds, to clip through holes to the material ----------

type Box = [V3, V3];
const emptyBox = (): Box => [
  [Infinity, Infinity, Infinity],
  [-Infinity, -Infinity, -Infinity],
];
const grow = (b: Box, p: V3) => {
  for (let i = 0; i < 3; i++) {
    b[0][i] = Math.min(b[0][i], p[i]);
    b[1][i] = Math.max(b[1][i], p[i]);
  }
};
function growCyl(b: Box, at: V3, dir: V3, d: number, h: number) {
  const n = vnorm(dir);
  const r = d / 2;
  for (const t of [0, h]) {
    const c = vadd(at, vscale(n, t));
    for (let i = 0; i < 3; i++) {
      // extent of a disc of radius r with normal n along axis i
      const e = r * Math.sqrt(Math.max(0, 1 - n[i] * n[i]));
      b[0][i] = Math.min(b[0][i], c[i] - e);
      b[1][i] = Math.max(b[1][i], c[i] + e);
    }
  }
}

/** A rough bounding box of the material a shape adds, in the frame it is written in; false when unknown. */
function shapeBox(s: ShapeRecipe, b: Box): boolean {
  switch (s.t) {
    case "box": {
      // box(w, d, h, at:) sits centred on at in x and y, rising from at.z
      grow(b, [s.at[0] - s.w / 2, s.at[1] - s.d / 2, s.at[2]]);
      grow(b, [s.at[0] + s.w / 2, s.at[1] + s.d / 2, s.at[2] + s.h]);
      return true;
    }
    case "cyl":
      growCyl(b, s.at, s.dir, s.d, s.h);
      return true;
    case "tube":
      growCyl(b, s.at, s.dir, s.od, s.h);
      return true;
    case "cone":
      growCyl(b, s.at, s.dir, Math.max(s.d1, s.d2), s.h);
      return true;
    case "sphere":
      grow(b, vsub(s.at, [s.d / 2, s.d / 2, s.d / 2]));
      grow(b, vadd(s.at, [s.d / 2, s.d / 2, s.d / 2]));
      return true;
    case "gear":
      growCyl(b, s.at, s.dir, s.m * (s.z + 2), s.w);
      return true;
    case "flight":
      growCyl(b, s.at, s.dir, s.d, s.length);
      return true;
    case "revolve": {
      const rmax = Math.max(0, ...s.pts.map((p) => p[0]));
      const a0 = Math.min(...s.pts.map((p) => p[1]));
      const a1 = Math.max(...s.pts.map((p) => p[1]));
      growCyl(b, vadd(s.at, vscale(vnorm(s.dir), a0)), s.dir, 2 * rmax, a1 - a0);
      return true;
    }
    case "prism":
    case "rrect": {
      const n = vnorm(s.dir);
      const pts: V2[] = s.t === "prism" ? s.pts : [[-s.w / 2, -s.h / 2], [s.w / 2, s.h / 2]];
      const r = Math.max(...pts.map((p) => Math.hypot(p[0], p[1])));
      const h = s.t === "prism" ? s.h : s.depth;
      const start = s.t === "rrect" && s.center ? vsub(s.at, vscale(n, h / 2)) : s.at;
      growCyl(b, start, n, 2 * r, h);
      return true;
    }
    case "xform": {
      const inner = emptyBox();
      if (!shapeBox(s.shape, inner)) return false;
      for (const x of [inner[0][0], inner[1][0]]) for (const y of [inner[0][1], inner[1][1]]) for (const z of [inner[0][2], inner[1][2]]) grow(b, applyXforms([x, y, z], s.xf));
      return true;
    }
    case "union":
      return s.shapes.every((x) => shapeBox(x, b));
    case "diff":
      return shapeBox(s.a, b);
    default:
      return false;
  }
}

/** Bounds of the material a recipe adds (body and add steps), or null when a shape is not understood. */
export function recipeBounds(r: PartRecipe): Box | null {
  const b = emptyBox();
  if (r.base && !shapeBox(r.base, b)) return null;
  for (const op of r.ops) if (op.op === "add" && !shapeBox(op.shape, b)) return null;
  return Number.isFinite(b[0][0]) ? b : null;
}

/** The part of a ray (from `at` along unit `dir`, up to `len`) inside a box, as [t0, t1]; null when it misses. */
function clipToBox(at: V3, dir: V3, len: number, b: Box): [number, number] | null {
  let t0 = 0,
    t1 = len;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < EPS) {
      if (at[i] < b[0][i] - EPS || at[i] > b[1][i] + EPS) return null;
      continue;
    }
    let a = (b[0][i] - at[i]) / dir[i];
    let c = (b[1][i] - at[i]) / dir[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
  }
  return t1 > t0 + EPS ? [t0, t1] : null;
}

// ---------- extraction ----------

interface LocalCyl {
  side: "hole" | "shaft";
  d: number;
  at: V3;
  axis: V3;
  length: number;
  role: CylRole;
  thread?: ThreadSpec;
  holeFit?: string;
}

/** Turned profiles: runs of constant radius along the axis are cylinders (outside: shaft; inside a hollow: hole). */
function revolveCyls(pts: V2[], at: V3, dir: V3, out: LocalCyl[], cut: boolean) {
  const n = vnorm(dir);
  const inside = (r: number, a: number) => {
    // even-odd test on the (r, a) outline, closed back to the axis
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ri, ai] = pts[i];
      const [rj, aj] = pts[j];
      if (ai > a !== aj > a && r < ((rj - ri) * (a - ai)) / (aj - ai) + ri) c = !c;
    }
    return c;
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    if (Math.abs(p[0] - q[0]) > EPS || p[0] < 0.2 || Math.abs(q[1] - p[1]) < 0.2) continue;
    const r = p[0];
    const am = (p[1] + q[1]) / 2;
    const e = Math.min(0.05, r * 0.05);
    const matIn = inside(r - e, am);
    const matOut = inside(r + e, am);
    if (matIn === matOut) continue;
    // material on the inside of the radius: an outer surface; on the outside: a bore
    const side: "hole" | "shaft" = matIn !== cut ? "shaft" : "hole";
    const a0 = Math.min(p[1], q[1]);
    out.push({ side, d: 2 * r, at: vadd(at, vscale(n, a0)), axis: n, length: Math.abs(q[1] - p[1]), role: "plain" });
  }
}

function shapeCyls(s: ShapeRecipe, cut: boolean, out: LocalCyl[], bounds: Box | null) {
  const side = cut ? "hole" : "shaft";
  switch (s.t) {
    case "cyl":
      out.push({ side, d: s.d, at: s.at, axis: vnorm(s.dir), length: s.h, role: "plain" });
      return;
    case "tube":
      if (cut) out.push({ side: "hole", d: s.od, at: s.at, axis: vnorm(s.dir), length: s.h, role: "plain" });
      else {
        out.push({ side: "shaft", d: s.od, at: s.at, axis: vnorm(s.dir), length: s.h, role: "plain" });
        if (s.id > 0.2) out.push({ side: "hole", d: s.id, at: s.at, axis: vnorm(s.dir), length: s.h, role: "plain" });
      }
      return;
    case "hole": {
      const axis = vnorm(s.dir);
      let at = s.at;
      let length = s.depth;
      if (bounds && length > 50) {
        // through holes are written 2 m deep: keep only the length inside the part
        const span = clipToBox(s.at, axis, length, bounds);
        if (!span) return;
        at = vadd(s.at, vscale(axis, span[0]));
        length = span[1] - span[0];
      }
      const thread = threadByName(s.threadName) ?? (s.thread ? Object.values(THREADS).find((t) => Math.abs(t.d - s.thread!.d) < 1e-6) : undefined);
      const threaded = !!s.thread || s.fit === "thread" || s.fit === "tap" || s.fit === "insert";
      out.push({ side: "hole", d: s.d, at, axis, length, role: threaded ? "thread" : "plain", thread, holeFit: s.fit });
      if (s.cbore) out.push({ side: "hole", d: s.cbore[0], at: s.at, axis, length: s.cbore[1], role: "plain", thread, holeFit: "cbore" });
      return;
    }
    case "thread": {
      const thread = Object.values(THREADS).find((t) => Math.abs(t.d - s.spec.d) < 1e-6 && Math.abs(t.pitch - s.spec.pitch) < 1e-6);
      if (s.internal || cut) out.push({ side: "hole", d: s.spec.d, at: s.at, axis: vnorm(s.dir), length: s.length, role: "thread", thread });
      else out.push({ side: "shaft", d: s.spec.d, at: s.at, axis: vnorm(s.dir), length: s.length, role: "thread", thread });
      return;
    }
    case "revolve":
      revolveCyls(s.pts, s.at, s.dir, out, cut);
      return;
    case "xform": {
      const inner: LocalCyl[] = [];
      shapeCyls(s.shape, cut, inner, null);
      for (const c of inner) out.push({ ...c, at: applyXforms(c.at, s.xf), axis: vnorm(applyXformsToDir(c.axis, s.xf)) });
      return;
    }
    case "union":
      for (const x of s.shapes) shapeCyls(x, cut, out, bounds);
      return;
    default:
      return;
  }
}

function toWorld(p: EvalPart, c: LocalCyl): Cyl {
  const xf: Xform[] = p.xf;
  return { part: p, side: c.side, d: c.d, at: applyXforms(c.at, xf), axis: vnorm(applyXformsToDir(c.axis, xf)), length: c.length, axisLocal: c.axis, role: c.role, thread: c.thread, holeFit: c.holeFit };
}

const threadOfLabel = (p: EvalPart): ThreadSpec | undefined => {
  const m = /M\d+(?:[._]\d+)?/.exec(`${p.bom?.description ?? ""} ${p.label}`);
  return m ? threadByName(m[0].replace("_", ".")) : undefined;
};

/** Round features of one part or component instance, in world space. */
export function partCylinders(p: EvalPart): Cyl[] {
  const out: Cyl[] = [];
  if (p.imported) return out;
  // bearings: the outer ring goes into a seat and a shaft goes through the bore
  if (p.bearing) {
    const b = p.bearing;
    const axis = vnorm(b.axis);
    const at = vsub(b.center, vscale(axis, b.width / 2));
    const local: V3 = [0, 0, 1];
    out.push({ part: p, side: "shaft", d: b.od, at, axis, length: b.width, axisLocal: local, role: "bearing-od" });
    out.push({ part: p, side: "hole", d: b.bore, at, axis, length: b.width, axisLocal: local, role: "bearing-bore" });
    return out;
  }
  // screws: the shank at the thread's major diameter (checks builds model it at the tap size) and the head
  if (p.fastener) {
    const t = threadByName(p.fastener.size);
    const local: LocalCyl[] = [];
    if (p.recipe.base) shapeCyls(p.recipe.base, false, local, null);
    for (const op of p.recipe.ops) if (op.op === "add") shapeCyls(op.shape, false, local, null);
    let shank = 0;
    for (const c of local) {
      const end = c.at[2] + c.axis[2] * c.length;
      if (c.at[2] >= -EPS && c.side === "shaft") shank = Math.max(shank, end);
    }
    if (t && shank > 0) out.push(toWorld(p, { side: "shaft", d: t.d, at: [0, 0, 0], axis: [0, 0, 1], length: shank, role: "screw", thread: t }));
    const head = local.find((c) => c.at[2] < -EPS && c.side === "shaft");
    if (head) out.push(toWorld(p, { ...head, role: "head", thread: t }));
    return out;
  }
  // heat-set inserts are melted in, so their outside is no fit; a screw threads into them
  if (p.libKind === "insert") {
    const local: LocalCyl[] = [];
    if (p.recipe.base) shapeCyls(p.recipe.base, false, local, null);
    const t = threadOfLabel(p);
    for (const c of local) out.push(toWorld(p, c.side === "hole" ? { ...c, role: "thread", thread: t } : { ...c, role: "insert" }));
    return out;
  }
  const bounds = recipeBounds(p.recipe);
  const local: LocalCyl[] = [];
  if (p.recipe.base) shapeCyls(p.recipe.base, false, local, bounds);
  for (const op of p.recipe.ops) {
    if (op.op === "add") shapeCyls(op.shape, false, local, bounds);
    else if (op.op === "cut") shapeCyls(op.shape, true, local, bounds);
  }
  for (const c of local) {
    if (!(c.d > 0.3) || !(c.length > 0.2)) continue;
    const w = toWorld(p, c);
    if (p.gear && c.side === "hole" && Math.abs(c.d - (p.gear.bore ?? -1)) < 1e-6) w.role = "gear-bore";
    out.push(w);
  }
  return out;
}

/** Distance from point p to the line through a along unit axis n. */
export function lineDistance(p: V3, a: V3, n: V3): number {
  const v = vsub(p, a);
  const t = vdot(v, n);
  return Math.hypot(v[0] - t * n[0], v[1] - t * n[1], v[2] - t * n[2]);
}

/** Overlap length of b's span with a's span, measured along a's axis. */
export function axialOverlap(a: Cyl, b: Cyl): number {
  const s0 = vdot(vsub(b.at, a.at), a.axis);
  const s1 = vdot(vsub(cylEnd(b), a.at), a.axis);
  const lo = Math.max(0, Math.min(s0, s1));
  const hi = Math.min(a.length, Math.max(s0, s1));
  return hi - lo;
}
