// Drawing and measuring geometry, run in the kernel worker: exact hidden-line
// projection of placed solids (OpenCASCADE HLR), section cuts with their cut
// faces, and exact measurements between picked faces, edges and points.

import * as R from "replicad";
import type { AnyShape, Edge, Face, Shape3D } from "replicad";
import { applyXf } from "./build";
import { vcross, vdot, vnorm, type V3, type Xform } from "./recipe";

// ---------- projection ----------

export interface ProjItem {
  id: string;
  hash: string;
  xf: Xform[];
  /** false for parts that are never sectioned (screws, pins, nuts) */
  cut?: boolean;
}

export interface ViewRequest {
  /** camera direction: from the model toward the viewer */
  dir: V3;
  /** view x axis (right on the sheet); y is dir × x */
  x: V3;
  items: ProjItem[];
  /** keep the material on the -normal side of this plane and hatch the cut faces */
  section?: { at: V3; normal: V3 };
  hidden: boolean;
  /** world segments to measure the first item's material along (through-hole checks) */
  probes?: { a: V3; b: V3 }[];
}

/** 2D geometry in view coordinates (model millimetres, y up). */
export type Prim2 =
  | { t: "L"; p: [number, number, number, number] }
  /** arc counter-clockwise from a0 to a1 (radians, a1 > a0); a full circle when a1 - a0 ≥ 2π */
  | { t: "A"; c: [number, number]; r: number; a0: number; a1: number }
  | { t: "P"; p: number[] };

export interface Edge2 {
  /** index into the request's items */
  part: number;
  vis: boolean;
  g: Prim2;
}

export interface ViewResult {
  edges: Edge2[];
  /** cut faces of a section, as closed loops (flat x, y lists) per part */
  hatch: { part: number; loops: number[][] }[];
  /** material length along each probe segment */
  probes?: number[];
  ms: number;
}

type Placed = (p: { hash: string; xf: Xform[] }) => { shape: Shape3D };

function oc() {
  return R.getOC() as unknown as Record<string, new (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown>>;
}

function free(o: unknown) {
  try {
    (o as { delete?: () => void })?.delete?.();
  } catch {
    /* already freed */
  }
}

export function projectView(req: ViewRequest, placed: Placed): ViewResult {
  const t0 = performance.now();
  const dir = vnorm(req.dir);
  const xAxis = vnorm(req.x);
  const yAxis = vcross(dir, xAxis);
  const shapes: { part: number; shape: AnyShape; temp: boolean }[] = [];
  const hatch: ViewResult["hatch"] = [];
  let probes: number[] | undefined;

  req.items.forEach((it, part) => {
    let w: Shape3D;
    try {
      w = placed(it).shape;
    } catch {
      return;
    }
    if (part === 0 && req.probes?.length) probes = req.probes.map((s) => materialAlong(w, s.a, s.b));
    if (!req.section) {
      shapes.push({ part, shape: w, temp: false });
      return;
    }
    const n = vnorm(req.section.normal);
    const offset = vdot(req.section.at, n);
    if (it.cut === false) {
      // whole standard parts stay unsectioned when their centre lies behind the plane
      const [lo, hi] = w.boundingBox.bounds;
      const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      if (vdot(c, n) <= offset) shapes.push({ part, shape: w, temp: false });
      return;
    }
    const plane = new R.Plane(req.section.at, null, [-n[0], -n[1], -n[2]]);
    let kept: Shape3D | null = null;
    try {
      kept = w.clone().cutPlane(plane) as Shape3D | null;
    } catch {
      kept = null;
    }
    if (!kept) return;
    shapes.push({ part, shape: kept, temp: true });
    try {
      const faces = new R.FaceFinder().inPlane(plane).find(kept);
      const loops: number[][] = [];
      for (const f of faces) loops.push(...faceLoops(f as Face, xAxis, yAxis));
      if (loops.length) hatch.push({ part, loops });
    } catch {
      /* no cut faces: the plane missed the part */
    }
  });

  const edges: Edge2[] = [];
  if (shapes.length) {
    const O = oc();
    const camera = new R.ProjectionCamera([0, 0, 0], dir, xAxis);
    const algo = new O.HLRBRep_Algo();
    for (const s of shapes) algo.Add(s.shape.wrapped, 0);
    const projector = new O.HLRAlgo_Projector(camera.wrapped);
    algo.Projector(projector);
    algo.Update();
    algo.Hide();
    const hlr = new O.HLRBRep_HLRToShape(algo);
    for (const s of shapes) {
      const sets: [string, boolean][] = [
        ["VCompound", true],
        ["OutLineVCompound", true],
      ];
      if (req.hidden) sets.push(["HCompound", false], ["OutLineHCompound", false]);
      for (const [fn, vis] of sets) {
        let compound: unknown;
        try {
          compound = hlr[fn](s.shape.wrapped);
        } catch {
          continue;
        }
        const c = compound as { IsNull(): boolean };
        if (!c || c.IsNull()) continue;
        const comp = new R.Compound(compound as never);
        for (const e of comp.edges) {
          const g = edgePrim(e);
          if (g) edges.push({ part: s.part, vis, g });
          free(e);
        }
        free(comp);
      }
    }
    free(hlr);
    free(projector);
    free(algo);
    free(camera);
  }
  for (const s of shapes) if (s.temp) free(s.shape);
  return { edges, hatch, probes, ms: performance.now() - t0 };
}

/** Length of solid material along a segment: the common of the solid and a line edge. */
function materialAlong(w: Shape3D, a: V3, b: V3): number {
  const O = oc();
  let edge: Edge | null = null;
  let common: Record<string, (...a: unknown[]) => unknown> | null = null;
  let comp: R.Compound | null = null;
  try {
    edge = R.makeLine(a, b);
    common = new O.BRepAlgoAPI_Common(w.wrapped, edge.wrapped);
    common.Build();
    comp = new R.Compound(common.Shape() as never);
    let len = 0;
    for (const e of comp.edges) {
      len += e.length;
      free(e);
    }
    return len;
  } catch {
    return NaN;
  } finally {
    free(comp);
    free(common);
    free(edge);
  }
}

const TAU = Math.PI * 2;

/** Converts a projected edge (lying in z = 0 of the projector frame) to a 2D primitive. */
function edgePrim(e: Edge): Prim2 | null {
  const O = oc();
  const ad = new O.BRepAdaptor_Curve(e.wrapped);
  try {
    const f = ad.FirstParameter() as number;
    const l = ad.LastParameter() as number;
    const at = (t: number): [number, number] => {
      const p = ad.Value(t) as { X(): number; Y(): number; delete(): void };
      const out: [number, number] = [p.X(), p.Y()];
      p.delete();
      return out;
    };
    const type = e.geomType;
    if (type === "LINE") {
      const a = at(f);
      const b = at(l);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return null;
      return { t: "L", p: [a[0], a[1], b[0], b[1]] };
    }
    if (type === "CIRCLE") {
      const circ = ad.Circle() as { Location(): { X(): number; Y(): number; delete(): void }; Radius(): number; delete(): void };
      const loc = circ.Location();
      const c: [number, number] = [loc.X(), loc.Y()];
      const r = circ.Radius();
      loc.delete();
      circ.delete();
      if (l - f >= TAU - 1e-7) return { t: "A", c, r, a0: 0, a1: TAU };
      const ang = (p: [number, number]) => Math.atan2(p[1] - c[1], p[0] - c[0]);
      let a0 = ang(at(f));
      let a1 = ang(at(l));
      const am = ang(at((f + l) / 2));
      // orient counter-clockwise so the sweep from a0 passes through the midpoint
      const ccw = (from: number, to: number, x: number) => norm(x - from) <= norm(to - from);
      if (!ccw(a0, a1, am)) [a0, a1] = [a1, a0];
      a1 = a0 + norm(a1 - a0);
      return { t: "A", c, r, a0, a1 };
    }
    // everything else: an adaptive polyline, collapsed to a line when straight
    const coarse: [number, number][] = [];
    for (let i = 0; i <= 8; i++) coarse.push(at(f + ((l - f) * i) / 8));
    let len = 0;
    for (let i = 1; i < coarse.length; i++) len += Math.hypot(coarse[i][0] - coarse[i - 1][0], coarse[i][1] - coarse[i - 1][1]);
    if (len < 1e-6) return null;
    const n = Math.max(8, Math.min(256, Math.ceil(len / 0.35)));
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) pts.push(at(f + ((l - f) * i) / n));
    const s = simplify(pts, 0.004);
    if (s.length === 2) return { t: "L", p: [s[0][0], s[0][1], s[1][0], s[1][1]] };
    return { t: "P", p: s.flat() };
  } catch {
    return null;
  } finally {
    ad.delete();
  }
}

function norm(a: number) {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

/** Douglas–Peucker polyline simplification. */
export function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy) || 1e-12;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Boundary loops of a planar face, projected onto the view plane. */
function faceLoops(face: Face, x: V3, y: V3): number[][] {
  const segs: [number, number][][] = [];
  for (const e of face.edges) {
    const pts: [number, number][] = [];
    const type = e.geomType;
    const n = type === "LINE" ? 1 : Math.max(8, Math.min(128, Math.ceil(e.length / 0.4)));
    for (let i = 0; i <= n; i++) {
      const p = e.pointAt(i / n);
      const v: V3 = [p.x, p.y, p.z];
      p.delete();
      pts.push([vdot(v, x), vdot(v, y)]);
    }
    free(e);
    segs.push(pts);
  }
  return chainLoops(segs);
}

/** Joins polyline pieces end to end into closed loops. */
export function chainLoops(segs: [number, number][][], tol = 1e-3): number[][] {
  const left = segs.filter((s) => s.length >= 2);
  const loops: number[][] = [];
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  while (left.length) {
    const loop = left.shift()!.slice();
    let grew = true;
    while (grew && !same(loop[0], loop[loop.length - 1])) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const s = left[i];
        const end = loop[loop.length - 1];
        if (same(s[0], end)) loop.push(...s.slice(1));
        else if (same(s[s.length - 1], end)) loop.push(...s.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (loop.length >= 3) loops.push(loop.flat());
  }
  return loops;
}

// ---------- measuring ----------

export interface PickRef {
  hash: string;
  xf: Xform[];
  kind: "face" | "edge" | "vertex";
  /** face or edge id from the mesh groups (the OpenCASCADE hash code) */
  id?: number;
  /** picked point in world coordinates */
  point: V3;
}

export interface EntityInfo {
  kind: "face" | "edge" | "vertex";
  /** plane, cylinder, cone, sphere, torus, surface, line, circle, ellipse, curve, point */
  type: string;
  point: V3;
  area?: number;
  length?: number;
  normal?: V3;
  radius?: number;
  center?: V3;
  axis?: V3;
  /** line edges: direction */
  dir?: V3;
}

export interface PickMeasure {
  a: EntityInfo;
  b?: EntityInfo;
  distance?: number;
  p1?: V3;
  p2?: V3;
  /** angle between planes or lines, degrees */
  angle?: number;
  /** distance between circle centres or parallel axes */
  centerDistance?: number;
}

type GetShape = (hash: string) => Shape3D | undefined;

export function measure(req: { a: PickRef; b?: PickRef }, get: GetShape): PickMeasure {
  const A = entity(req.a, get);
  try {
    if (!req.b) return { a: A.info };
    const B = entity(req.b, get);
    try {
      const out: PickMeasure = { a: A.info, b: B.info };
      const O = oc();
      const ds = new O.BRepExtrema_DistShapeShape();
      ds.LoadS1(A.shape.wrapped);
      ds.LoadS2(B.shape.wrapped);
      ds.Perform();
      if (ds.IsDone() && (ds.NbSolution() as number) > 0) {
        out.distance = ds.Value() as number;
        const p1 = ds.PointOnShape1(1) as { X(): number; Y(): number; Z(): number; delete(): void };
        const p2 = ds.PointOnShape2(1) as { X(): number; Y(): number; Z(): number; delete(): void };
        out.p1 = [p1.X(), p1.Y(), p1.Z()];
        out.p2 = [p2.X(), p2.Y(), p2.Z()];
        p1.delete();
        p2.delete();
      }
      ds.delete();
      const da = A.info.normal ?? A.info.dir ?? A.info.axis;
      const db = B.info.normal ?? B.info.dir ?? B.info.axis;
      if (da && db) {
        const c = Math.min(1, Math.abs(vdot(vnorm(da), vnorm(db))));
        out.angle = (Math.acos(c) * 180) / Math.PI;
      }
      if (A.info.center && B.info.center) {
        const ca = A.info.center;
        const cb = B.info.center;
        const d: V3 = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]];
        const axA = A.info.axis;
        if (axA && B.info.axis && Math.abs(vdot(vnorm(axA), vnorm(B.info.axis))) > 0.9999 && A.info.kind === "face" && B.info.kind === "face") {
          // parallel axes: perpendicular distance between them
          const a = vnorm(axA);
          const along = vdot(d, a);
          out.centerDistance = Math.hypot(d[0] - a[0] * along, d[1] - a[1] * along, d[2] - a[2] * along);
        } else out.centerDistance = Math.hypot(...d);
      }
      return out;
    } finally {
      free(B.shape);
    }
  } finally {
    free(A.shape);
  }
}

function invertXf(p: V3, xf: Xform[]): V3 {
  let q = p;
  for (let i = xf.length - 1; i >= 0; i--) {
    const x = xf[i];
    if (x.op === "translate") q = [q[0] - x.v[0], q[1] - x.v[1], q[2] - x.v[2]];
    else q = rotate(q, x.origin, x.axis, -x.angle);
  }
  return q;
}

function rotate(p: V3, o: V3, axis: V3, deg: number): V3 {
  const k = vnorm(axis);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const v: V3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const kv = vcross(k, v);
  const kd = vdot(k, v);
  return [o[0] + v[0] * c + kv[0] * s + k[0] * kd * (1 - c), o[1] + v[1] * c + kv[1] * s + k[1] * kd * (1 - c), o[2] + v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}

/** Finds the picked sub-shape in the cached solid and places it in world coordinates. */
function entity(ref: PickRef, get: GetShape): { shape: AnyShape; info: EntityInfo } {
  if (ref.kind === "vertex") {
    const v = R.makeVertex(ref.point);
    return { shape: v, info: { kind: "vertex", type: "point", point: ref.point } };
  }
  const solid = get(ref.hash);
  if (!solid) throw new Error("That part is still building. Try again in a moment.");
  const local = invertXf(ref.point, ref.xf);
  const list: (Face | Edge)[] = ref.kind === "face" ? solid.faces : solid.edges;
  let hit = ref.id !== undefined ? list.find((s) => s.hashCode === ref.id) : undefined;
  if (!hit) {
    // ids change if the solid was rebuilt: fall back to the sub-shape nearest the picked point
    const v = R.makeVertex(local);
    let best = Infinity;
    for (const s of list) {
      const d = R.measureDistanceBetween(v, s);
      if (d < best) {
        best = d;
        hit = s;
      }
    }
    free(v);
  }
  if (!hit) throw new Error("Nothing was found under the cursor.");
  const placedShape = applyXf(hit.clone() as unknown as Shape3D, ref.xf) as unknown as Face | Edge;
  for (const s of list) if (s !== hit) free(s);
  free(hit);
  const info = ref.kind === "face" ? faceInfo(placedShape as Face, ref.point) : edgeInfo(placedShape as Edge, ref.point);
  return { shape: placedShape, info };
}

const pt = (p: { X(): number; Y(): number; Z(): number; delete?: () => void }): V3 => {
  const out: V3 = [p.X(), p.Y(), p.Z()];
  p.delete?.();
  return out;
};

function faceInfo(f: Face, point: V3): EntityInfo {
  const info: EntityInfo = { kind: "face", type: "surface", point };
  try {
    info.area = R.measureArea(f);
  } catch {
    /* optional */
  }
  const O = oc();
  const ad = new O.BRepAdaptor_Surface(f.wrapped, false);
  try {
    switch (f.geomType) {
      case "PLANE": {
        info.type = "plane";
        const n = f.normalAt(point);
        info.normal = [n.x, n.y, n.z];
        n.delete();
        break;
      }
      case "CYLINDRE": {
        info.type = "cylinder";
        const c = ad.Cylinder() as { Radius(): number; Axis(): { Location(): never; Direction(): never; delete(): void }; delete(): void };
        info.radius = c.Radius();
        const ax = c.Axis();
        info.center = pt(ax.Location());
        info.axis = pt(ax.Direction());
        ax.delete();
        c.delete();
        break;
      }
      case "CONE": {
        info.type = "cone";
        const c = ad.Cone() as { RefRadius(): number; SemiAngle(): number; Axis(): { Location(): never; Direction(): never; delete(): void }; delete(): void };
        info.radius = c.RefRadius();
        const ax = c.Axis();
        info.center = pt(ax.Location());
        info.axis = pt(ax.Direction());
        ax.delete();
        c.delete();
        break;
      }
      case "SPHERE": {
        info.type = "sphere";
        const s = ad.Sphere() as { Radius(): number; Location(): never; delete(): void };
        info.radius = s.Radius();
        info.center = pt(s.Location());
        s.delete();
        break;
      }
      case "TORUS":
        info.type = "torus";
        break;
    }
  } catch {
    /* keep what we have */
  } finally {
    ad.delete();
  }
  return info;
}

function edgeInfo(e: Edge, point: V3): EntityInfo {
  const info: EntityInfo = { kind: "edge", type: "curve", point };
  try {
    info.length = R.measureLength(e);
  } catch {
    /* optional */
  }
  const O = oc();
  const ad = new O.BRepAdaptor_Curve(e.wrapped);
  try {
    switch (e.geomType) {
      case "LINE": {
        info.type = "line";
        const a = e.startPoint;
        const b = e.endPoint;
        info.dir = vnorm([b.x - a.x, b.y - a.y, b.z - a.z]);
        a.delete();
        b.delete();
        break;
      }
      case "CIRCLE": {
        info.type = "circle";
        const c = ad.Circle() as { Radius(): number; Location(): never; Axis(): { Direction(): never; delete(): void }; delete(): void };
        info.radius = c.Radius();
        info.center = pt(c.Location());
        const ax = c.Axis();
        info.axis = pt(ax.Direction());
        ax.delete();
        c.delete();
        break;
      }
      case "ELLIPSE":
        info.type = "ellipse";
        break;
    }
  } catch {
    /* keep what we have */
  } finally {
    ad.delete();
  }
  return info;
}
