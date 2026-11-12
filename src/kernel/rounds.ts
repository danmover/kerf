// Fillets whose radius changes along the edges, uneven chamfers and full rounds: OpenCASCADE's fillet and chamfer
// builders driven directly, for what replicad's fillet() and chamfer() do not take.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import type { FilletLaw, Sel, V3 } from "./recipe";
import { shapeValid } from "./profiles";
import { describeSel, type Topo } from "./topology";

interface OCShape {
  IsSame(o: unknown): boolean;
  delete(): void;
}

interface OCRounds {
  BRepFilletAPI_MakeFillet: new (
    s: unknown,
    kind: unknown,
  ) => {
    Add(e: unknown): void;
    Contour(e: unknown): number;
    NbEdges(ic: number): number;
    Edge(ic: number, j: number): unknown;
    FirstVertex(ic: number): OCShape;
    LastVertex(ic: number): OCShape;
    SetRadius(law: unknown, ic: number, j: number): void;
    Build(p: unknown): void;
    IsDone(): boolean;
    Shape(): unknown;
    delete(): void;
  };
  BRepFilletAPI_MakeChamfer: new (s: unknown) => {
    Add(d1: number, d2: number, e: unknown, f: unknown): void;
    AddDA(d: number, angle: number, e: unknown, f: unknown): void;
    Build(p: unknown): void;
    IsDone(): boolean;
    Shape(): unknown;
    delete(): void;
  };
  ChFi3d_FilletShape: { ChFi3d_Rational: unknown };
  NCollection_Array1_gp_Pnt2d: new (lo: number, hi: number) => { SetValue(i: number, p: unknown): void; delete(): void };
  gp_Pnt2d: new (x: number, y: number) => { delete(): void };
  Message_ProgressRange: new () => { delete(): void };
  BRep_Tool: { Pnt(v: unknown): { X(): number; Y(): number; Z(): number; delete(): void } };
}

const oc = () => R.getOC() as unknown as OCRounds;
const fmt = (n: number) => String(+n.toFixed(2));
const p3 = (p: V3) => `(${p.map(fmt).join(", ")})`;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** a WebAssembly trap (unlike an OpenCASCADE exception) leaves the kernel unusable */
const trapped = (e: unknown) => typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;

function vertexPoint(v: unknown): V3 {
  const p = oc().BRep_Tool.Pnt(v);
  const out: V3 = [p.X(), p.Y(), p.Z()];
  p.delete();
  return out;
}

/** a before b, lowest in x, then y, then z */
function lowerEnd(a: V3, b: V3): boolean {
  for (let k = 0; k < 3; k++) if (Math.abs(a[k] - b[k]) > 1e-6) return a[k] < b[k];
  return false;
}

/** The radius at fraction s along a law of (fraction, radius) points: straight lines between, level past the ends. */
function radiusAt(pts: [number, number][], s: number): number {
  if (s <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [u0, r0] = pts[i - 1];
    const [u1, r1] = pts[i];
    if (s <= u1) return u1 - u0 < 1e-12 ? r1 : r0 + ((r1 - r0) * (s - u0)) / (u1 - u0);
  }
  return pts[pts.length - 1][1];
}

/**
 * A fillet whose radius follows `law` along each run of edges (the run OpenCASCADE builds from an edge: it and the
 * edges tangent to it), from the run's end nearest `law.from`.
 */
export function variableFillet(shape: Shape3D, edges: R.Edge[], law: FilletLaw): Shape3D {
  const o = oc();
  const mk = new o.BRepFilletAPI_MakeFillet(shape.wrapped, o.ChFi3d_FilletShape.ChFi3d_Rational);
  const progress = new o.Message_ProgressRange();
  try {
    for (const e of edges) {
      if (mk.Contour(e.wrapped) > 0) continue;
      mk.Add(e.wrapped);
      const ic = mk.Contour(e.wrapped);
      if (!ic) continue;
      const v0 = mk.FirstVertex(ic);
      const v1 = mk.LastVertex(ic);
      const closed = v0.IsSame(v1);
      const a = vertexPoint(v0);
      const b = vertexPoint(v1);
      v0.delete();
      v1.delete();
      const r = law.r;
      if (closed && Math.abs(r[0] - r[r.length - 1]) > 1e-9) throw new Error(`the edges through ${p3(a)} go all the way round, so the list of radii must end on the radius it starts with, like [${fmt(r[0])}, ${fmt(Math.max(...r))}, ${fmt(r[0])}]`);
      const flip = !closed && (law.from ? dist(b, law.from) < dist(a, law.from) - 1e-6 : lowerEnd(b, a));
      const pts = r.map((ri, i): [number, number] => [flip ? 1 - law.at[i] : law.at[i], ri]).sort((x, y) => x[0] - y[0]);
      // set edge by edge (OpenCASCADE puts a law given for the whole run on its first edge only): each edge gets the
      // radii at its own ends and the points of the list that fall on it
      const n = mk.NbEdges(ic);
      const lens: number[] = [];
      for (let j = 1; j <= n; j++) {
        const ej = new R.Edge(mk.Edge(ic, j) as never);
        lens.push(ej.length);
        ej.delete();
      }
      const total = lens.reduce((s, x) => s + x, 0) || 1;
      let s0 = 0;
      for (let j = 1; j <= n; j++) {
        const s1 = j === n ? 1 : s0 + lens[j - 1] / total;
        const inner = pts.filter(([u]) => u > s0 + 1e-9 && u < s1 - 1e-9).map(([u, ri]): [number, number] => [(u - s0) / (s1 - s0), ri]);
        const local: [number, number][] = [[0, radiusAt(pts, s0)], ...inner, [1, radiusAt(pts, s1)]];
        const arr = new o.NCollection_Array1_gp_Pnt2d(1, local.length);
        local.forEach(([u, ri], k) => {
          const p = new o.gp_Pnt2d(u, ri);
          arr.SetValue(k + 1, p);
          p.delete();
        });
        mk.SetRadius(arr, ic, j);
        arr.delete();
        s0 = s1;
      }
    }
    mk.Build(progress);
    if (!mk.IsDone()) throw new Error("the radius could not be made to change that way along these edges");
    return R.cast(mk.Shape() as never) as Shape3D;
  } finally {
    progress.delete();
    mk.delete();
  }
}

/**
 * A chamfer with two sizes (the first along the face `on` picks at each edge) or a size along that face and an angle
 * from it.
 */
export function unevenChamfer(shape: Shape3D, t: Topo, edges: number[], r: number | [number, number], on: Sel, angle: number | undefined): Shape3D {
  const o = oc();
  const faces = t.selectFaces(on);
  if (!faces.size) throw new Error(`on: ${describeSel(on)} matched no faces`);
  const mk = new o.BRepFilletAPI_MakeChamfer(shape.wrapped);
  const progress = new o.Message_ProgressRange();
  try {
    for (const i of edges) {
      const info = t.edge(i);
      const hit = [...new Set(info.faces)].filter((f) => faces.has(f));
      if (hit.length !== 1) throw new Error(`on: ${describeSel(on)} should pick one of the two faces at each edge, and at the edge through ${p3(info.m)} it picks ${hit.length ? "both" : "neither"}`);
      const face = t.faces[hit[0]].wrapped;
      const [d1, d2] = Array.isArray(r) ? r : [r, r];
      if (angle !== undefined) mk.AddDA(d1, (angle * Math.PI) / 180, t.edges[i].wrapped, face);
      else mk.Add(d1, d2, t.edges[i].wrapped, face);
    }
    mk.Build(progress);
    if (!mk.IsDone()) throw new Error("the chamfer could not be cut with those sizes");
    return R.cast(mk.Shape() as never) as Shape3D;
  } finally {
    progress.delete();
    mk.delete();
  }
}

/**
 * How much of each half-width the two fillets of a full round take: OpenCASCADE cannot make them meet exactly, so a
 * hair of flat stays between them (0.1 % of the width; more only if that fails).
 */
const FULL_ROUND = [0.999, 0.99, 0.98];

/** The two long sides of a face to round right over, and how far apart they are. */
export function roundSides(t: Topo, fi: number, measure: R.DistanceTool): { a: number; b: number; w: number } {
  const [lo, hi] = t.face(fi).box;
  const where = p3([0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as V3);
  const es = t.faceEdges(fi).sort((x, y) => t.edge(y).length - t.edge(x).length);
  if (es.length < 2) throw new Error(`the face near ${where} has no two sides to round between`);
  const [a, b] = es;
  if (es.length > 2 && t.edge(es[2]).length > 0.9 * t.edge(b).length) throw new Error(`the face near ${where} is about as long as it is wide, so it has no two long sides to round between: pick the top of a rib or wall, or a rim`);
  const w = measure.distanceBetween(t.edges[a], t.edges[b]);
  if (!(w > 0.05)) throw new Error(`the two longest sides of the face near ${where} touch, so there is no width to round across`);
  let wMax = 0;
  for (const u of [0, 0.25, 0.5, 0.75, 1]) {
    const v = R.makeVertex(t.edges[b].pointAt(u).toTuple() as V3);
    wMax = Math.max(wMax, measure.distanceBetween(v, t.edges[a]));
    v.delete();
  }
  if (wMax > w * 1.05 + 0.02) throw new Error(`the sides of the face near ${where} are not the same distance apart (${fmt(w)} to ${fmt(wMax)} mm), so it cannot be rounded right over: use fillet() with a radius under ${fmt(w / 2)} mm`);
  return { a, b, w };
}

/** full_round(): each face picked becomes a half-round tangent to its two long sides. */
export function fullRound(shape: Shape3D, t: Topo, faces: number[]): Shape3D {
  const half = new Map<number, number>();
  const measure = new R.DistanceTool();
  try {
    for (const fi of faces) {
      const { a, b, w } = roundSides(t, fi, measure);
      for (const e of [a, b]) {
        if (half.has(e)) throw new Error(`two of the faces picked share the edge through ${p3(t.edge(e).m)}: pick only the face to round over, like in_plane(Z, h) for the top of a rib h high`);
        half.set(e, w / 2);
      }
    }
  } finally {
    measure.delete();
  }
  const byHash = new Map<number, { e: R.Edge; r: number }[]>();
  for (const [i, r] of half) {
    const e = t.edges[i];
    byHash.set(e.hashCode, [...(byHash.get(e.hashCode) ?? []), { e, r }]);
  }
  const rOf = (e: R.Edge) => byHash.get(e.hashCode)?.find((x) => x.e.isSame(e))?.r;
  let last: unknown;
  for (const k of FULL_ROUND) {
    try {
      const out = shape.fillet((e) => {
        const r = rOf(e);
        return r ? r * k : null;
      });
      if (shapeValid(out)) return out;
      last = new Error("it made an invalid solid");
    } catch (e) {
      if (trapped(e)) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("the faces could not be rounded right over");
}
