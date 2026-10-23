// Sheet-metal parts: a flat base with flanges bent up or down along its
// edges, each with a real inside radius, optional lips, automatic corner gaps
// and bend reliefs. Besides the solid, sheet() records where every bend is
// and how each flat region unfolds, so the kernel makes the flat pattern from
// the finished part (holes and cut-outs included) and the checks read flange
// lengths and bend data without measuring.
//
// Each flange is worked out in its edge's cross-section: s runs outward from
// the base edge, z up from the base's bottom face. The "R face" is the face
// on the right as you travel from the base out along the flange (the base's
// bottom face); bends that turn left (up) have it on the outside.

import { def } from "./builtins";
import { Obj, ShapeV, Vec, typeName, type Value } from "./values";
import type { Profile, ProfileSeg, ShapeRecipe, V2, V3, Xform } from "../kernel/recipe";

type P = [number, number];

const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const rot = (v: P, a: number): P => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const left = (d: P): P => [-d[1], d[0]];
const right = (d: P): P => [d[1], -d[0]];
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const DEG = Math.PI / 180;

/** Where lines p + a·d and q + b·e cross. */
function meet(p: P, d: P, q: P, e: P): P {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-12) return p;
  const a = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return add(p, mul(d, a));
}

/** Thickness slack of the unfold regions, so they never share a face with the sheet's skins. */
const EPS = 0.02;

export interface SheetBend {
  /** which bend: "front", "edge 3", "front lip" */
  name: string;
  /** degrees: + bends up (toward the flat pattern's top face), − down */
  angle: number;
  /** inside radius, mm */
  r: number;
  /** flat length the bend takes (bend allowance), mm */
  allowance: number;
  /** length of the bend line, mm */
  length: number;
  /** the bend's centre line on the flat pattern, in the part's own (x, y) */
  line: [V2, V2];
}

export interface SheetFlange {
  /** "front", "edge 2" */
  name: string;
  h: number;
  angle: number;
  /** flat length between the flange's bends (or out to its edge), mm */
  flat: number;
  lip?: { length: number; angle: number; flat: number };
}

/** A flat region of the bent part as an oriented box (centre, unit axes, half sizes), for collision checks. */
export interface SheetBox {
  name: string;
  c: V3;
  axes: [V3, V3, V3];
  half: V3;
}

export interface SheetInfo {
  t: number;
  /** inside bend radius the flanges default to */
  r: number;
  k: number;
  gap: number;
  /** height of the base's bottom face */
  z: number;
  flanges: SheetFlange[];
  bends: SheetBend[];
  boxes: SheetBox[];
  /** each flange's regions on the flat pattern (x, y outlines), for the overlap check */
  flatRegions: { flange: string; pts: V2[] }[];
  /** outline of the flat pattern's extent, (x, y) min and max */
  flatBox: [V2, V2];
  /** pieces of the finished part to lift onto the flat and where they go, plus the bends laid flat */
  unfold: { pieces: { region: ShapeRecipe; xf: Xform[] }[]; bends: ShapeRecipe[] };
}

/** A sheet() body: its solid plus what the flat pattern and the checks need. */
export class SheetV extends ShapeV {
  constructor(
    recipe: ShapeRecipe,
    public info: SheetInfo,
  ) {
    super(recipe);
  }
}

// ---------- one flange in its cross-section ----------

interface Bend {
  tin: P;
  tout: P;
  centre: P;
  /** radius on the R face */
  rho: number;
  theta: number;
  din: P;
  dout: P;
  /** inside radius */
  r: number;
}

interface Chain {
  /** s where the base stops and the first bend starts (negative: inside the base edge) */
  sb: number;
  b1: Bend;
  /** wall: R-face start and end, direction */
  w0: P;
  w1: P;
  d1: P;
  b2?: Bend;
  l0?: P;
  l1?: P;
  d2?: P;
}

function bendAt(c: P, din: P, theta: number, r: number, t: number): Bend {
  const rho = theta > 0 ? r + t : r;
  const b = rho * Math.tan(Math.abs(theta) / 2);
  const dout = rot(din, theta);
  const tin = sub(c, mul(din, b));
  const tout = add(c, mul(dout, b));
  const centre = add(tin, mul(theta > 0 ? left(din) : right(din), rho));
  return { tin, tout, centre, rho, theta, din, dout, r };
}

/**
 * The R-face outline of a flange from its outside dimensions: h runs from the
 * outer face of the base at the edge to the far face of the flange (or of its
 * lip), along the flange; a lip's length runs from the flange's outer face.
 */
function chainOf(t: number, r1: number, theta1: number, h: number, lip: { length: number; theta: number; r: number } | null, err: (m: string) => never): Chain {
  const d0: P = [1, 0];
  const d1 = rot(d0, theta1);
  const v1: P = theta1 > 0 ? [0, 0] : [0, t];
  const fr = theta1 > 0 ? v1 : add(v1, mul(right(d1), t));
  const c1 = meet([0, 0], d0, fr, d1);
  const q = add(v1, mul(d1, h));
  const b1 = bendAt(c1, d0, theta1, r1, t);
  if (b1.tin[0] > -1e-9) err("the bend would start outside the base");
  if (!lip) {
    const end = theta1 > 0 ? q : add(q, mul(right(d1), t));
    const flat = dot(sub(end, b1.tout), d1);
    if (flat <= 1e-6) err(`h ${r3(h)} is too short for its bend: with r ${r3(r1)} and t ${r3(t)} it needs more than ${r3(h - flat)} mm`);
    return { sb: b1.tin[0], b1, w0: b1.tout, w1: end, d1 };
  }
  const d2 = rot(d1, lip.theta);
  const lr = lip.theta > 0 ? q : add(q, mul(right(d2), t));
  const c2 = meet(fr, d1, lr, d2);
  const b2 = bendAt(c2, d1, lip.theta, lip.r, t);
  const tip = add(q, mul(d2, lip.length));
  const end = lip.theta > 0 ? tip : add(tip, mul(right(d2), t));
  const flat = dot(sub(b2.tin, b1.tout), d1);
  if (flat <= 1e-6) err(`h ${r3(h)} is too short for two bends: with r ${r3(r1)} and t ${r3(t)} it needs more than ${r3(h - flat)} mm`);
  const lipFlat = dot(sub(end, b2.tout), d2);
  if (lipFlat <= 1e-6) err(`lip ${r3(lip.length)} is too short for its bend: it needs more than ${r3(lip.length - lipFlat)} mm`);
  return { sb: b1.tin[0], b1, w0: b1.tout, w1: b2.tin, d1, b2, l0: b2.tout, l1: end, d2 };
}

/** The bend zone as a closed profile: the R-face arc out, across the thickness, the L-face arc back. */
function bendProfile(b: Bend, t: number): Profile {
  const tinL = add(b.tin, mul(left(b.din), t));
  const toutL = add(b.tout, mul(left(b.dout), t));
  const midR = add(b.centre, rot(sub(b.tin, b.centre), b.theta / 2));
  const midL = add(b.centre, rot(sub(tinL, b.centre), b.theta / 2));
  const segs: ProfileSeg[] = [
    { s: "arc", via: midR, to: b.tout },
    { s: "line", to: toutL },
    { s: "arc", via: midL, to: tinL },
    { s: "line", to: b.tin },
  ];
  return { t: "path2", start: b.tin, segs };
}

/** A flat strip from a to b (R face) with direction d, thickness t, as a quad; grow pads the outer faces. */
function quad(a: P, b: P, d: P, t: number, grow = 0, past = 0): P[] {
  const a0 = add(a, mul(right(d), grow));
  const b0 = add(add(b, mul(d, past)), mul(right(d), grow));
  const up = mul(left(d), t + grow);
  return [a0, b0, add(add(b, mul(d, past)), up), add(a, up)];
}

// ---------- the base outline and its edges ----------

interface Edge {
  p0: V2;
  e: V2;
  n: V2;
  len: number;
}

const RECT_EDGES = ["front", "right", "back", "left"];

/** The base outline as counter-clockwise points, and the user's edge index for each of its edges. */
function baseOutline(p: Profile, err: (m: string) => never): { pts: V2[]; names: string[]; userIndex: number[] } {
  if (p.t === "rect") {
    if (p.r > 1e-9) err("sheet(): give the base sharp corners (rect(w, h) without r); round them afterwards with fillet(r, edges: \"vertical\")");
    const [cx, cy] = p.c;
    const pts: V2[] = [
      [cx - p.w / 2, cy - p.h / 2],
      [cx + p.w / 2, cy - p.h / 2],
      [cx + p.w / 2, cy + p.h / 2],
      [cx - p.w / 2, cy + p.h / 2],
    ];
    return { pts, names: RECT_EDGES, userIndex: [0, 1, 2, 3] };
  }
  if (p.t === "poly") {
    if (p.r > 1e-9) err("sheet(): give the base sharp corners (polygon(points) without r); round them afterwards with fillet(r, edges: \"vertical\")");
    let pts = p.pts.slice();
    if (pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts = pts.slice(0, -1);
    if (pts.length < 3) err("sheet(): the base polygon needs at least 3 corners");
    const n = pts.length;
    let area = 0;
    for (let i = 0; i < n; i++) area += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
    if (Math.abs(area) < 1e-9) err("sheet(): the base polygon has no area");
    // the user's edge i runs from points[i] to points[i + 1]
    let userIndex = pts.map((_, i) => i);
    if (area < 0) {
      pts = pts.reverse();
      userIndex = pts.map((_, j) => (((n - 2 - j) % n) + n) % n);
    }
    const names = pts.map((_, j) => `edge ${userIndex[j]}`);
    return { pts, names, userIndex };
  }
  return err(`sheet(): the base must be a rect() or polygon() outline, got a ${p.t} profile`);
}

const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function edgesOf(pts: V2[]): Edge[] {
  return pts.map((p0, i) => {
    const p1 = pts[(i + 1) % pts.length];
    const len = dist(p0, p1);
    const e: V2 = [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len];
    return { p0, e, n: [e[1], -e[0]], len };
  });
}

/** Which of the outline's edges a flange's edge: names. */
function resolveEdge(v: Value, edges: Edge[], names: string[], userIndex: number[], err: (m: string) => never): number[] {
  if (typeof v === "number") {
    const j = userIndex.indexOf(Math.round(v));
    if (!Number.isInteger(v) || j < 0) err(`flange(): edge ${v} does not exist; the base has edges 0 to ${edges.length - 1}`);
    return [j];
  }
  if (typeof v !== "string") return err(`flange(): edge should be a name like "front" or an edge number, got ${typeName(v)}`);
  const name = v.trim().toLowerCase();
  if (name === "all") return edges.map((_, i) => i);
  const byName = names.indexOf(name);
  if (byName >= 0) return [byName];
  const axis: Record<string, V2> = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] };
  const want = axis[name];
  if (!want) return err(`flange(): unknown edge "${v}". Use front, back, left, right, all, or an edge number (edge i runs from point i to point i + 1)`);
  const hits = edges.map((e, i) => (e.n[0] * want[0] + e.n[1] * want[1] > Math.cos(DEG) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) err(`flange(): ${hits.length ? "more than one" : "no"} edge of this outline faces ${name}; give the edge number instead (edge i runs from point i to point i + 1)`);
  return hits;
}

// ---------- the language functions ----------

interface FlangeArgs {
  edge: Value;
  h: number;
  angle: number;
  r: number | null;
  inset: [number, number];
  lip: number;
  lipAngle: number;
}

function flangeArgs(v: Value, i: number, err: (m: string) => never): FlangeArgs {
  if (!(v instanceof Obj) || v.kind !== "flange") return err(`sheet(): flanges[${i}] should be a flange(edge, h, ...), got ${typeName(v)}`);
  const f = v.fields;
  const n = (x: Value | undefined, d: number) => (typeof x === "number" ? x : d);
  const inset = Array.isArray(f.inset) ? f.inset : [0, 0];
  return { edge: f.edge, h: n(f.h, 0), angle: n(f.angle, 90), r: typeof f.r === "number" ? f.r : null, inset: [n(inset[0], 0), n(inset[1], 0)], lip: n(f.lip, 0), lipAngle: n(f.lip_angle, 90) };
}

export const SHEET_FNS = Object.fromEntries([
  def(
    "flange",
    ["edge", "h", "angle", "r", "inset", "lip", "lip_angle"],
    (a) => {
      const edge = a.value("edge");
      if (edge === undefined) a.ctx.error('flange() needs the edge it stands on: "front", "back", "left", "right", "all" or an edge number');
      const h = a.positive("h");
      const angle = a.num("angle", 90);
      if (Math.abs(angle) < 1 || Math.abs(angle) > 150) a.ctx.error(`flange(): angle ${angle}° is out of range; bend between 1° and 150° up (positive) or down (negative)`);
      const r = a.has("r") ? a.positive("r") : null;
      const insetV = a.value("inset");
      let inset: [number, number] = [0, 0];
      if (typeof insetV === "number") inset = [insetV, insetV];
      else if (Array.isArray(insetV) && insetV.length === 2 && insetV.every((x) => typeof x === "number")) inset = [insetV[0] as number, insetV[1] as number];
      else if (insetV instanceof Vec) inset = [insetV.x, insetV.y];
      else if (insetV !== undefined) a.ctx.error("flange(): inset should be a number, or [from start, from end] in mm");
      if (inset[0] < 0 || inset[1] < 0) a.ctx.error("flange(): inset cannot be negative");
      const lip = a.num("lip", 0);
      const lipAngle = a.num("lip_angle", 90);
      if (lip && (lipAngle < 1 || lipAngle > 150)) a.ctx.error(`flange(): lip_angle ${lipAngle}° is out of range (1° to 150°)`);
      return new Obj({ edge: edge!, h, angle, ...(r !== null ? { r } : {}), inset: [inset[0], inset[1]], lip, lip_angle: lipAngle }, "flange", "flange");
    },
    "flange(edge, h, angle: 90, r: (the sheet's), inset: 0, lip: 0, lip_angle: 90) — one flange for sheet(): edge is \"front\", \"back\", \"left\", \"right\" (the sides of a rect base), \"all\", or an edge number (edge i runs from point i to point i + 1 of a polygon base). h is its outside height: from the base's outer face to the far face of the flange (or of its lip). angle bends it up (positive) or down (negative). inset shortens it from both ends (or [from start, from end]), with bend reliefs cut automatically. lip adds a return flange at its far edge, that long from the flange's outer face: positive curls inward over the base, negative turns outward.",
  ),
  def(
    "sheet",
    ["base", "t", "r", "k", "flanges", "gap", "at"],
    (a) => {
      const err = (m: string): never => a.ctx.error(m);
      const t = a.positive("t");
      const r = a.has("r") ? a.positive("r") : t;
      const k = a.num("k", 0.44);
      if (k < 0 || k > 0.5) err(`sheet(): k (the K-factor, where the neutral layer sits across the thickness) should be between 0 and 0.5, got ${k}`);
      const gap = a.num("gap", 0.5);
      if (gap < 0.1) err("sheet(): gap (between flanges at a corner) should be at least 0.1 mm");
      const at = a.vec3("at", [0, 0, 0]);
      const listV = a.value("flanges") ?? [];
      const list = Array.isArray(listV) ? listV : [listV];
      return buildSheet(a.profile("base"), { t, r, k, gap, at }, list.map((v, i) => flangeArgs(v, i, err)), err);
    },
    'sheet(base, t, r: t, k: 0.44, flanges: [flange(...), ...], gap: 0.5, at: (0, 0, 0)) — a sheet-metal part: a flat base of thickness t (base is a rect() or polygon() in x, y; the bottom face sits at at.z) with flanges bent up or down along its edges. r is the inside bend radius, k the K-factor for the flat pattern. Corners between flanges get a gap and relief automatically; give the base sharp corners and round them later with fillet(r, edges: "vertical"). Use it as the body, then cut holes and cut-outs as usual: Kerf unfolds the finished part into a flat pattern (its own drawing, with bend lines and a bend table, and a DXF for the laser), checks it as sheet metal, and the part is made by sheet_metal unless it says otherwise. Example: body sheet(rect(120, 80), t: 1.5, flanges: [flange("all", 30)]) is an open tray 120 × 80 × 30 outside.',
  ),
]);

interface SheetOpts {
  t: number;
  r: number;
  k: number;
  gap: number;
  at: V3;
}

interface Placed {
  edge: number;
  name: string;
  f: FlangeArgs;
  chain: Chain;
  /** bend span, wall span and lip span along the edge (distance from the edge's start) */
  bend: [number, number];
  wall: [number, number];
  lip: [number, number];
  relief: [boolean, boolean];
}

function buildSheet(baseProfile: Profile, o: SheetOpts, flanges: FlangeArgs[], err: (m: string) => never): SheetV {
  const { t, k, gap } = o;
  const z0 = o.at[2];
  const base = baseOutline(baseProfile, err);
  const pts: V2[] = base.pts.map((p) => [p[0] + o.at[0], p[1] + o.at[1]]);
  const edges = edgesOf(pts);
  const n = edges.length;

  // which flange stands on each edge
  const onEdge: (FlangeArgs | null)[] = edges.map(() => null);
  for (const f of flanges) {
    for (const i of resolveEdge(f.edge, edges, base.names, base.userIndex, err)) {
      if (onEdge[i]) err(`sheet(): two flanges on the ${base.names[i]} edge`);
      onEdge[i] = f;
    }
  }
  const chains = onEdge.map((f, i) => {
    if (!f) return null;
    const where = (m: string): never => err(`flange on the ${base.names[i]} edge: ${m}`);
    const lip = f.lip ? { length: Math.abs(f.lip), theta: Math.sign(f.lip) * Math.sign(f.angle) * f.lipAngle * DEG, r: f.r ?? o.r } : null;
    return chainOf(t, f.r ?? o.r, f.angle * DEG, f.h, lip, where);
  });
  const setback = (i: number) => (chains[i] ? -chains[i]!.sb : 0);

  // where the moved edge lines meet: the base's corners once every bend start is cut back
  const along = (i: number, p: V2) => (p[0] - edges[i].p0[0]) * edges[i].e[0] + (p[1] - edges[i].p0[1]) * edges[i].e[1];
  const moved = (i: number): [P, P] => [add(edges[i].p0 as P, mul(edges[i].n as P, -setback(i))), edges[i].e as P];
  const corner = (i: number, j: number): V2 => {
    const [p, d] = moved(i);
    const [q, e] = moved(j);
    return meet(p, d, q, e);
  };
  const square = (i: number, j: number) => Math.abs(edges[i].e[0] * edges[j].e[0] + edges[i].e[1] * edges[j].e[1]) < 0.02;

  const placed: Placed[] = [];
  for (let i = 0; i < n; i++) {
    const f = onEdge[i];
    const chain = chains[i];
    if (!f || !chain) continue;
    const prev = (i + n - 1) % n;
    const next = (i + 1) % n;
    const L = edges[i].len;
    let a = Math.max(0, along(i, corner(prev, i)));
    let b = Math.min(L, along(i, corner(i, next)));
    const reliefA = f.inset[0] > a + 1e-6;
    const reliefB = L - f.inset[1] < b - 1e-6;
    a = Math.max(a, f.inset[0]);
    b = Math.min(b, L - f.inset[1]);
    if (b - a < Math.max(1, t)) err(`flange on the ${base.names[i]} edge: only ${r3(Math.max(0, b - a))} mm of the edge is left for it; reduce inset or the neighbouring flanges' bends`);
    // walls reach into a corner shared with another square wall, stopping a gap short of its inside face
    const meets = (j: number) => {
      const g = onEdge[j];
      return !!g && Math.abs(Math.abs(f.angle) - 90) < 1e-6 && Math.abs(Math.abs(g.angle) - 90) < 1e-6 && Math.sign(g.angle) === Math.sign(f.angle) && square(i, j);
    };
    const wa = !reliefA && meets(prev) ? Math.min(a, t + gap) : a;
    const wb = !reliefB && meets(next) ? Math.max(b, L - t - gap) : b;
    // lips curling over the same corner would cross: each stops short of the other's
    const inward = (g: FlangeArgs | null) => !!g && g.lip > 0;
    const la = inward(f) && meets(prev) && inward(onEdge[prev]) ? Math.max(wa, Math.abs(onEdge[prev]!.lip) + gap) : wa;
    const lb = inward(f) && meets(next) && inward(onEdge[next]) ? Math.min(wb, L - Math.abs(onEdge[next]!.lip) - gap) : wb;
    if (f.lip && lb - la < Math.max(1, t)) err(`flange on the ${base.names[i]} edge: its lip has no room left between the corners`);
    placed.push({ edge: i, name: base.names[i], f, chain, bend: [a, b], wall: [wa, wb], lip: [la, lb], relief: [reliefA, reliefB] });
  }

  // cross-section (s, z) at a distance along an edge, to the part's coordinates
  const to3 = (i: number, s: number, z: number, al: number): V3 => {
    const E = edges[i];
    return [E.p0[0] + E.e[0] * al + E.n[0] * s, E.p0[1] + E.e[1] * al + E.n[1] * s, z0 + z];
  };
  const toXY = (i: number, s: number, al: number): V2 => {
    const E = edges[i];
    return [E.p0[0] + E.e[0] * al + E.n[0] * s, E.p0[1] + E.e[1] * al + E.n[1] * s];
  };
  /** a cross-section profile pushed along edge i from al0 to al1 */
  const sweep = (i: number, p: Profile, al0: number, al1: number): ShapeRecipe => {
    const E = edges[i];
    const o3 = to3(i, 0, 0, al1);
    return { t: "extrude", p, h: al1 - al0, f: { o: o3, u: [E.n[0], E.n[1], 0], n: [-E.e[0], -E.e[1], 0] }, twist: 0, scale: 1 };
  };
  const poly = (ps: P[]): Profile => ({ t: "poly", pts: ps.map((q) => [q[0], q[1]] as V2), r: 0 });
  const rectXY = (i: number, a0: number, a1: number, s0: number, s1: number): V2[] => [toXY(i, s0, a0), toXY(i, s0, a1), toXY(i, s1, a1), toXY(i, s1, a0)];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  const rw = Math.max(t, 1);
  /** how far past an outline's edge or corner the cutting regions reach */
  const M = 1;

  // the base: the outline less each bend's zone, the corners between bends, and reliefs
  const zones: Profile[] = [];
  const exact: Profile[] = [];
  for (const p of placed) {
    const i = p.edge;
    const sb = p.chain.sb;
    // through a corner shared with another bend, so the corner between them is open
    const a0 = !p.relief[0] && onEdge[(i + n - 1) % n] ? Math.min(p.bend[0], 0) - M : p.bend[0];
    const a1 = !p.relief[1] && onEdge[(i + 1) % n] ? Math.max(p.bend[1], edges[i].len) + M : p.bend[1];
    zones.push({ t: "poly", pts: rectXY(i, a0, a1, sb, M), r: 0 });
    if (p.relief[0]) zones.push({ t: "poly", pts: rectXY(i, p.bend[0] - rw, p.bend[0], sb - t, M), r: 0 });
    if (p.relief[1]) zones.push({ t: "poly", pts: rectXY(i, p.bend[1], p.bend[1] + rw, sb - t, M), r: 0 });
    // the unfold's base region stops at the bend start, and keeps clear of a shallow flange still in the base's slab
    exact.push({ t: "poly", pts: rectXY(i, p.bend[0], p.bend[1], sb, p.f.h + Math.abs(p.f.lip) + M), r: 0 });
  }
  const outline: Profile = { t: "poly", pts, r: 0 };
  const baseP: Profile = zones.length ? { t: "diff2", a: outline, b: zones } : outline;
  const plate: ShapeRecipe = { t: "extrude", p: baseP, h: t, f: { o: [0, 0, z0], u: [1, 0, 0], n: [0, 0, 1] }, twist: 0, scale: 1 };

  const solids: ShapeRecipe[] = [plate];
  const pieces: SheetInfo["unfold"]["pieces"] = [];
  const flatBends: ShapeRecipe[] = [];
  const bends: SheetBend[] = [];
  const info: SheetFlange[] = [];
  const boxes: SheetBox[] = [];
  const flatRegions: SheetInfo["flatRegions"] = [];
  const bboxPad: V2[] = [
    [minX - M, minY - M],
    [maxX + M, minY - M],
    [maxX + M, maxY + M],
    [minX - M, maxY + M],
  ];
  // the base region of the unfold: everything in the base's slab short of the bend starts
  const baseRegion: Profile = exact.length ? { t: "diff2", a: { t: "poly", pts: bboxPad, r: 0 }, b: exact } : { t: "poly", pts: bboxPad, r: 0 };
  pieces.push({ region: { t: "extrude", p: baseRegion, h: t + 2 * EPS, f: { o: [0, 0, z0 - EPS], u: [1, 0, 0], n: [0, 0, 1] }, twist: 0, scale: 1 }, xf: [] });

  const allowance = (b: Bend) => Math.abs(b.theta) * (b.r + k * t);
  const halfGap = gap / 2;
  /** the 3D move that lays a flat region (R face starting at `from`, running along d) flat at s = target */
  const layFlat = (i: number, from: P, d: P, target: number): Xform[] => {
    const E = edges[i];
    const phi = -Math.atan2(d[1], d[0]);
    const origin = to3(i, from[0], from[1], 0);
    const shift: P = sub([target, 0], from);
    return [
      { op: "rotate", angle: phi / DEG, origin, axis: [E.n[1], -E.n[0], 0] },
      { op: "translate", v: [E.n[0] * shift[0], E.n[1] * shift[0], shift[1]] },
    ];
  };
  const boxOf = (i: number, name: string, a: P, b: P, d: P, span: [number, number]): SheetBox => {
    const E = edges[i];
    const mid = add(mul(add(a, b), 0.5), mul(left(d), t / 2));
    const al = (span[0] + span[1]) / 2;
    const ax3 = (v: P): V3 => [E.n[0] * v[0], E.n[1] * v[0], v[1]];
    return { name, c: to3(i, mid[0], mid[1], al), axes: [ax3(d), ax3(left(d)), [E.e[0], E.e[1], 0]], half: [Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, t / 2, (span[1] - span[0]) / 2] };
  };

  for (const p of placed) {
    const i = p.edge;
    const c = p.chain;
    const nm = p.name;
    // the solid
    solids.push(sweep(i, bendProfile(c.b1, t), p.bend[0], p.bend[1]));
    solids.push(sweep(i, poly(quad(c.w0, c.w1, c.d1, t)), p.wall[0], p.wall[1]));
    if (c.b2 && c.l0 && c.l1 && c.d2) {
      solids.push(sweep(i, bendProfile(c.b2, t), p.lip[0], p.lip[1]));
      solids.push(sweep(i, poly(quad(c.l0, c.l1, c.d2, t)), p.lip[0], p.lip[1]));
    }
    // the flat pattern: base | bend | wall | bend | lip, outward from the bend start
    const ba1 = allowance(c.b1);
    const wallFlat = dot(sub(c.w1, c.w0), c.d1);
    const sWall = c.sb + ba1;
    flatBends.push(sweep(i, poly([[c.sb, 0], [sWall, 0], [sWall, t], [c.sb, t]]), p.bend[0], p.bend[1]));
    pieces.push({ region: sweep(i, poly(quad(c.w0, c.w1, c.d1, t, EPS, c.b2 ? 0 : M)), p.wall[0] - halfGap, p.wall[1] + halfGap), xf: layFlat(i, c.w0, c.d1, sWall) });
    bends.push({ name: nm, angle: p.f.angle, r: c.b1.r, allowance: ba1, length: p.bend[1] - p.bend[0], line: [toXY(i, c.sb + ba1 / 2, p.bend[0]), toXY(i, c.sb + ba1 / 2, p.bend[1])] });
    flatRegions.push({ flange: nm, pts: rectXY(i, p.bend[0], p.bend[1], c.sb, sWall) });
    flatRegions.push({ flange: nm, pts: rectXY(i, p.wall[0], p.wall[1], sWall, sWall + wallFlat) });
    boxes.push(boxOf(i, nm, c.w0, c.w1, c.d1, p.wall));
    const fl: SheetFlange = { name: nm, h: p.f.h, angle: p.f.angle, flat: wallFlat };
    if (c.b2 && c.l0 && c.l1 && c.d2) {
      const ba2 = allowance(c.b2);
      const s2 = sWall + wallFlat;
      const sLip = s2 + ba2;
      const lipFlat = dot(sub(c.l1, c.l0), c.d2);
      flatBends.push(sweep(i, poly([[s2, 0], [sLip, 0], [sLip, t], [s2, t]]), p.lip[0], p.lip[1]));
      pieces.push({ region: sweep(i, poly(quad(c.l0, c.l1, c.d2, t, EPS, M)), p.lip[0] - halfGap, p.lip[1] + halfGap), xf: layFlat(i, c.l0, c.d2, sLip) });
      // on the flat, a bend that turns left as you travel outward bends up
      bends.push({ name: `${nm} lip`, angle: c.b2.theta / DEG, r: c.b2.r, allowance: ba2, length: p.lip[1] - p.lip[0], line: [toXY(i, s2 + ba2 / 2, p.lip[0]), toXY(i, s2 + ba2 / 2, p.lip[1])] });
      flatRegions.push({ flange: nm, pts: rectXY(i, p.lip[0], p.lip[1], s2, sLip + lipFlat) });
      boxes.push(boxOf(i, `${nm} lip`, c.l0, c.l1, c.d2, p.lip));
      fl.lip = { length: Math.abs(p.f.lip), angle: p.f.lipAngle * Math.sign(p.f.lip), flat: lipFlat };
    }
    info.push(fl);
  }

  let fx0 = minX;
  let fy0 = minY;
  let fx1 = maxX;
  let fy1 = maxY;
  for (const r of flatRegions)
    for (const q of r.pts) {
      fx0 = Math.min(fx0, q[0]);
      fy0 = Math.min(fy0, q[1]);
      fx1 = Math.max(fx1, q[0]);
      fy1 = Math.max(fy1, q[1]);
    }

  const recipe: ShapeRecipe = solids.length === 1 ? plate : { t: "union", shapes: solids };
  return new SheetV(recipe, {
    t,
    r: o.r,
    k,
    gap,
    z: z0,
    flanges: info,
    bends,
    boxes,
    flatRegions,
    flatBox: [
      [fx0, fy0],
      [fx1, fy1],
    ],
    unfold: { pieces, bends: flatBends },
  });
}
