// Detail inspection of built solids, for Claude's self-review. Finds what a
// careful designer looks for on every part: sharp outer edges, unbroken hole
// rims, sharp internal corners, how much support it needs to print in each
// orientation, and its thinnest walls. Runs in the kernel worker and in Node.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import type { MeshData } from "./build";
import type { V3 } from "./recipe";

export type EdgeKind = "outer" | "hole_rim" | "boss_rim" | "internal";

export interface EdgeNote {
  kind: EdgeKind;
  /** midpoint, in the part's own coordinates */
  at: V3;
  length: number;
  /** angle between the two face normals, degrees (90 for a square edge) */
  angle: number;
}

export interface SupportNote {
  /** the direction that faces the print bed, in the part's own coordinates */
  down: "-Z" | "+Z" | "-X" | "+X" | "-Y" | "+Y";
  /** area of faces overhanging more than 45° that would need support, mm² */
  area: number;
}

export interface PartInspection {
  faces: number;
  edges: number;
  /** sharp convex edges, including unbroken hole and boss rims */
  sharp: { count: number; length: number; holeRims: number; bossRims: number; top: EdgeNote[] };
  /** sharp concave edges: internal corners with no fillet */
  internal: { count: number; length: number; top: EdgeNote[] };
  /** smooth (tangent) joins: a sign of fillets and blends already present */
  blended: number;
  /** edges shorter than 0.1 mm, usually modelling slivers */
  tiny: number;
  support: SupportNote[];
  /** thinnest wall found by casting rays through the solid; null when no wall could be measured */
  walls: { min: number; p5: number; at: V3; samples: number } | null;
  /** separate solids the part is made of (a feature that does not touch the body makes a second one), with the smaller ones */
  pieces?: { count: number; others: { volume: number; at: V3 }[] };
  /** true when the part had more edges than were inspected */
  truncated: boolean;
  ms: number;
}

const DEG = 180 / Math.PI;
const SHARP_DEG = 8;
const MAX_EDGES = 4000;
const TOP = 8;

type Vec = { x: number; y: number; z: number; delete?: () => void };
const v3 = (v: Vec): V3 => [v.x, v.y, v.z];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};
const round = (a: V3, d = 2): V3 => a.map((x) => Math.round(x * 10 ** d) / 10 ** d) as V3;
const free = (o: { delete?: () => void } | null | undefined) => {
  try {
    o?.delete?.();
  } catch {
    /* already freed */
  }
};

/** Centre of the circle through three points (for telling holes from bosses). */
function circumcenter(a: V3, b: V3, c: V3): V3 | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const d = 2 * dot(n, n);
  if (d < 1e-12) return null;
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const k1 = dot(ac, ac) / d;
  const k2 = dot(ab, ab) / d;
  return [a[0] + t1[0] * k1 + t2[0] * k2, a[1] + t1[1] * k1 + t2[1] * k2, a[2] + t1[2] * k1 + t2[2] * k2];
}

interface FaceLike {
  edges: EdgeLike[];
  normalAt(p: Vec): Vec;
  geomType: string;
  delete?: () => void;
}
interface EdgeLike {
  hashCode: number;
  isSame(o: EdgeLike): boolean;
  orientation: "forward" | "backward";
  pointAt(t: number): Vec;
  tangentAt(t: number): Vec;
  length: number;
  geomType: string;
  delete?: () => void;
}

/**
 * Classify every edge of a solid. An edge is convex when the material of one
 * face, seen from the edge, lies behind the other face: with t the edge
 * direction as that face uses it and n its outward normal, n × t points into
 * the face, and the edge is convex when that direction points against the
 * other face's normal.
 */
export function scanEdges(shape: Shape3D) {
  const faces = shape.faces as unknown as FaceLike[];
  const byHash = new Map<number, { edge: EdgeLike; uses: { fi: number; rev: boolean }[] }[]>();
  let total = 0;
  let truncated = false;
  faces.forEach((f, fi) => {
    for (const e of f.edges) {
      const h = e.hashCode;
      let list = byHash.get(h);
      if (!list) byHash.set(h, (list = []));
      const rev = e.orientation === "backward";
      let rec = list.find((r) => r.edge.isSame(e));
      if (!rec) {
        list.push((rec = { edge: e, uses: [] }));
        total++;
      } else free(e);
      rec.uses.push({ fi, rev });
    }
  });

  const sharp: EdgeNote[] = [];
  const internal: EdgeNote[] = [];
  let blended = 0;
  let tiny = 0;
  let holeRims = 0;
  let bossRims = 0;
  let done = 0;

  for (const list of byHash.values()) {
    for (const { edge, uses } of list) {
      if (done >= MAX_EDGES) {
        truncated = true;
        free(edge);
        continue;
      }
      done++;
      try {
        const length = edge.length;
        if (length < 0.1) tiny++;
        // seams and free edges have no second face to compare against
        if (uses.length !== 2 || uses[0].fi === uses[1].fi) continue;
        const pv = edge.pointAt(0.5);
        const tv = edge.tangentAt(0.5);
        const p = v3(pv);
        const t = unit(v3(tv));
        free(tv);
        const [a, b] = uses;
        const na = faces[a.fi].normalAt(pv);
        const nb = faces[b.fi].normalAt(pv);
        free(pv);
        const n1 = unit(v3(na));
        const n2 = unit(v3(nb));
        free(na);
        free(nb);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(n1, n2)))) * DEG;
        if (angle < SHARP_DEG) {
          blended++;
          continue;
        }
        const t1 = a.rev ? neg(t) : t;
        const t2 = b.rev ? neg(t) : t;
        const convexA = dot(cross(n1, t1), n2) < 0;
        const convexB = dot(cross(n2, t2), n1) < 0;
        if (convexA !== convexB) continue; // degenerate: cannot tell
        const note: EdgeNote = { kind: convexA ? "outer" : "internal", at: round(p), length: Math.round(length * 100) / 100, angle: Math.round(angle) };
        if (!convexA) {
          internal.push(note);
          continue;
        }
        if (edge.geomType === "CIRCLE") {
          const q0 = edge.pointAt(0);
          const q1 = edge.pointAt(1 / 3);
          const q2 = edge.pointAt(2 / 3);
          const c = circumcenter(v3(q0), v3(q1), v3(q2));
          free(q0);
          free(q1);
          free(q2);
          // full circles only: an arc is usually a rounded outer corner
          const closed = Math.abs(length - 2 * Math.PI * (c ? len(sub(p, c)) : 0)) < 0.02 * length;
          if (c && closed) {
            const curved = faces[a.fi].geomType === "PLANE" ? n2 : n1;
            const toCentre = sub(c, p);
            if (dot(curved, toCentre) > 0) {
              note.kind = "hole_rim";
              holeRims++;
            } else {
              note.kind = "boss_rim";
              bossRims++;
            }
          }
        }
        sharp.push(note);
      } catch {
        /* an edge OpenCASCADE cannot evaluate: skip it */
      }
    }
  }
  for (const list of byHash.values()) for (const r of list) free(r.edge);
  for (const f of faces) free(f);

  const byLength = (x: EdgeNote, y: EdgeNote) => y.length - x.length;
  const sum = (xs: EdgeNote[]) => Math.round(xs.reduce((s, e) => s + e.length, 0));
  return {
    faces: faces.length,
    edges: total,
    sharp: { count: sharp.length, length: sum(sharp), holeRims, bossRims, top: pickVaried(sharp.sort(byLength)) },
    internal: { count: internal.length, length: sum(internal), top: internal.sort(byLength).slice(0, TOP) },
    blended,
    tiny,
    truncated,
  };
}

/** The longest edges, but keep hole and boss rims represented. */
function pickVaried(sorted: EdgeNote[]): EdgeNote[] {
  const out = sorted.filter((e) => e.kind === "outer").slice(0, TOP - 2);
  for (const kind of ["hole_rim", "boss_rim"] as const) {
    const e = sorted.find((x) => x.kind === kind);
    if (e) out.push(e);
  }
  return out.length < TOP ? [...out, ...sorted.filter((e) => !out.includes(e)).slice(0, TOP - out.length)] : out;
}

// ---------- mesh measurements ----------

const DOWNS: { down: SupportNote["down"]; d: V3 }[] = [
  { down: "-Z", d: [0, 0, -1] },
  { down: "+Z", d: [0, 0, 1] },
  { down: "-X", d: [-1, 0, 0] },
  { down: "+X", d: [1, 0, 0] },
  { down: "-Y", d: [0, -1, 0] },
  { down: "+Y", d: [0, 1, 0] },
];

interface Tri {
  a: V3;
  b: V3;
  c: V3;
  n: V3;
  area: number;
}

function triangles(mesh: MeshData): Tri[] {
  const P = mesh.positions;
  const N = mesh.normals;
  const I = mesh.indices;
  const out: Tri[] = [];
  for (let i = 0; i + 2 < I.length; i += 3) {
    const ia = I[i] * 3;
    const ib = I[i + 1] * 3;
    const ic = I[i + 2] * 3;
    const a: V3 = [P[ia], P[ia + 1], P[ia + 2]];
    const b: V3 = [P[ib], P[ib + 1], P[ib + 2]];
    const c: V3 = [P[ic], P[ic + 1], P[ic + 2]];
    const g = cross(sub(b, a), sub(c, a));
    const l = len(g);
    if (l < 1e-9) continue;
    let n: V3 = [g[0] / l, g[1] / l, g[2] / l];
    // trust the surface normals for which side is outside
    const vn: V3 = [N[ia] + N[ib] + N[ic], N[ia + 1] + N[ib + 1] + N[ic + 1], N[ia + 2] + N[ib + 2] + N[ic + 2]];
    if (dot(n, vn) < 0) n = neg(n);
    out.push({ a, b, c, n, area: l / 2 });
  }
  return out;
}

/** Support area needed for each of the six axis-aligned print orientations. */
export function supportAreas(tris: Tri[]): SupportNote[] {
  const cos45 = Math.SQRT1_2;
  return DOWNS.map(({ down, d }) => {
    let bed = Infinity;
    for (const t of tris) bed = Math.min(bed, dot(t.a, d) * -1, dot(t.b, d) * -1, dot(t.c, d) * -1);
    let area = 0;
    for (const t of tris) {
      if (dot(t.n, d) <= cos45) continue;
      const h = Math.max(-dot(t.a, d), -dot(t.b, d), -dot(t.c, d));
      if (h < bed + 0.3) continue; // resting on the bed
      area += t.area;
    }
    return { down, area: Math.round(area) };
  });
}

/** Uniform grid over triangles for ray casting. */
class TriGrid {
  private lo: V3;
  private size: number;
  private dims: [number, number, number];
  private cells = new Map<number, number[]>();
  private stamp: Uint32Array;
  private tick = 0;

  constructor(private tris: Tri[]) {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const t of tris)
      for (const p of [t.a, t.b, t.c])
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], p[k]);
          hi[k] = Math.max(hi[k], p[k]);
        }
    const ext = sub(hi, lo);
    this.size = Math.max(Math.max(ext[0], ext[1], ext[2]) / 48, 0.25);
    this.lo = [lo[0] - 1e-3, lo[1] - 1e-3, lo[2] - 1e-3];
    this.dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((ext[k] + 2e-3) / this.size))) as [number, number, number];
    this.stamp = new Uint32Array(tris.length);
    tris.forEach((t, i) => {
      const a = this.cellOf([Math.min(t.a[0], t.b[0], t.c[0]), Math.min(t.a[1], t.b[1], t.c[1]), Math.min(t.a[2], t.b[2], t.c[2])]);
      const b = this.cellOf([Math.max(t.a[0], t.b[0], t.c[0]), Math.max(t.a[1], t.b[1], t.c[1]), Math.max(t.a[2], t.b[2], t.c[2])]);
      for (let x = a[0]; x <= b[0]; x++)
        for (let y = a[1]; y <= b[1]; y++)
          for (let z = a[2]; z <= b[2]; z++) {
            const key = this.key(x, y, z);
            const list = this.cells.get(key);
            if (list) list.push(i);
            else this.cells.set(key, [i]);
          }
    });
  }

  private cellOf(p: V3): [number, number, number] {
    return [0, 1, 2].map((k) => Math.min(this.dims[k] - 1, Math.max(0, Math.floor((p[k] - this.lo[k]) / this.size)))) as [number, number, number];
  }
  private key(x: number, y: number, z: number) {
    return (x * this.dims[1] + y) * this.dims[2] + z;
  }

  /** Nearest hit along the ray beyond tMin: distance and triangle index. */
  cast(o: V3, d: V3, tMin: number, tMax: number): { t: number; i: number } | null {
    this.tick++;
    let best: { t: number; i: number } | null = null;
    const cell = this.cellOf(o);
    const step = [0, 1, 2].map((k) => (d[k] > 0 ? 1 : d[k] < 0 ? -1 : 0));
    const tNext = [0, 1, 2].map((k) => {
      if (!step[k]) return Infinity;
      const edge = this.lo[k] + (cell[k] + (step[k] > 0 ? 1 : 0)) * this.size;
      return (edge - o[k]) / d[k];
    });
    const tDelta = [0, 1, 2].map((k) => (step[k] ? this.size / Math.abs(d[k]) : Infinity));
    for (let guard = 0; guard < 400; guard++) {
      const list = this.cells.get(this.key(cell[0], cell[1], cell[2]));
      if (list) {
        for (const i of list) {
          if (this.stamp[i] === this.tick) continue;
          this.stamp[i] = this.tick;
          const t = rayTri(o, d, this.tris[i]);
          if (t !== null && t > tMin && t < tMax && (!best || t < best.t)) best = { t, i };
        }
      }
      const k = tNext[0] < tNext[1] ? (tNext[0] < tNext[2] ? 0 : 2) : tNext[1] < tNext[2] ? 1 : 2;
      if (best && best.t <= tNext[k]) return best;
      if (tNext[k] > tMax) return best;
      cell[k] += step[k];
      if (cell[k] < 0 || cell[k] >= this.dims[k]) return best;
      tNext[k] += tDelta[k];
    }
    return best;
  }
}

/** Möller–Trumbore, two-sided. */
function rayTri(o: V3, d: V3, t: Tri): number | null {
  const e1 = sub(t.b, t.a);
  const e2 = sub(t.c, t.a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = sub(o, t.a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return null;
  return dot(e2, q) * inv;
}

/**
 * Wall thickness: from points spread evenly over the surface, cast a ray
 * straight into the material and measure where it comes out the other side.
 */
export function wallThickness(tris: Tri[], samples = 600): PartInspection["walls"] {
  if (!tris.length) return null;
  const grid = new TriGrid(tris);
  const total = tris.reduce((s, t) => s + t.area, 0);
  const every = total / samples;
  const found: { t: number; at: V3 }[] = [];
  let acc = every / 2;
  for (const tri of tris) {
    acc += tri.area;
    if (acc < every) continue;
    acc -= every * Math.floor(acc / every);
    const c: V3 = [(tri.a[0] + tri.b[0] + tri.c[0]) / 3, (tri.a[1] + tri.b[1] + tri.c[1]) / 3, (tri.a[2] + tri.b[2] + tri.c[2]) / 3];
    const d = neg(tri.n);
    const o: V3 = [c[0] + d[0] * 1e-3, c[1] + d[1] * 1e-3, c[2] + d[2] * 1e-3];
    const hit = grid.cast(o, d, 0.02, 1e4);
    if (!hit) continue;
    // the exit face should face roughly along the ray; grazing hits near edges are noise
    if (dot(tris[hit.i].n, d) < 0.3) continue;
    found.push({ t: hit.t, at: c });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.t - b.t);
  const p5 = found[Math.min(found.length - 1, Math.floor(found.length * 0.05))].t;
  return { min: Math.round(found[0].t * 100) / 100, p5: Math.round(p5 * 100) / 100, at: round(found[0].at, 1), samples: found.length };
}

/** The solids a shape is made of: one for a sound part; more when a feature does not touch the body it was added to. */
export function solidPieces(shape: Shape3D): PartInspection["pieces"] {
  const solids = [...R.iterTopo(shape.wrapped, "solid")];
  if (solids.length <= 1) return { count: Math.max(1, solids.length), others: [] };
  const list = solids.map((s) => {
    const c = R.cast(s) as Shape3D;
    try {
      const [lo, hi] = c.boundingBox.bounds;
      return { volume: Math.round(Math.abs(R.measureVolume(c)) * 10) / 10, at: round([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], 1) };
    } finally {
      free(c as unknown as { delete?: () => void });
    }
  });
  list.sort((a, b) => b.volume - a.volume);
  return { count: list.length, others: list.slice(1, 6) };
}

export function inspectPart(shape: Shape3D, mesh: MeshData | undefined): PartInspection {
  const t0 = performance.now();
  const edges = scanEdges(shape);
  const tris = mesh ? triangles(mesh) : [];
  let pieces: PartInspection["pieces"];
  try {
    pieces = solidPieces(shape);
  } catch {
    pieces = undefined;
  }
  return {
    ...edges,
    support: tris.length ? supportAreas(tris) : [],
    walls: tris.length ? wallThickness(tris) : null,
    pieces,
    ms: Math.round(performance.now() - t0),
  };
}

export const __test = { triangles, circumcenter };
