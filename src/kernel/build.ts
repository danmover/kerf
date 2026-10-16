// Turns geometry recipes into exact B-rep solids with OpenCASCADE (via
// replicad). Runs inside the kernel worker, and in Node for tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { frameFor, rotateAbout, vadd, vcross, vscale, type EdgeSel, type PartRecipe, type ProfileRegion, type Seg2, type ShapeRecipe, type V2, type V3, type Xform } from "./recipe";
import { gearOutline } from "../library/gears";

export class BuildError extends Error {}

function polygon(pts: V2[]) {
  let pen = R.draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  return pen.close();
}

function planeFor(at: V3, u: V3, n: V3) {
  return new R.Plane(at, u, n);
}

/** in-plane x direction for a profile across dir, optionally spun by rot degrees */
function profileFrame(dir: V3, rot = 0) {
  const { u, v, n } = frameFor(dir);
  if (!rot) return { u, n };
  const a = (rot * Math.PI) / 180;
  const u2: V3 = vadd(vscale(u, Math.cos(a)), vscale(v, Math.sin(a)));
  return { u: u2, n };
}

function revolveProfile(pts: V2[], at: V3, dir: V3): Shape3D {
  const { u, n } = frameFor(dir);
  // sketch plane spanned by u (radius) and n (axial): normal = u × n
  const normal = vcross(u, n);
  const sketch = polygon(pts).sketchOnPlane(planeFor(at, u, normal));
  return sketch.revolve(n, { origin: at }) as Shape3D;
}

export function buildShape(r: ShapeRecipe): Shape3D {
  switch (r.t) {
    case "box": {
      const d = r.r > 1e-6 ? R.drawRoundedRectangle(r.w, r.d, r.r) : R.drawRectangle(r.w, r.d);
      return d.sketchOnPlane("XY", r.at).extrude(r.h) as Shape3D;
    }
    case "cyl":
      return R.makeCylinder(r.d / 2, r.h, r.at, r.dir);
    case "tube": {
      const outer = R.makeCylinder(r.od / 2, r.h, r.at, r.dir);
      const start = vadd(r.at, vscale(r.dir, -0.05));
      const inner = R.makeCylinder(r.id / 2, r.h + 0.1, start, r.dir);
      return outer.cut(inner);
    }
    case "cone":
      return revolveProfile(
        [
          [0, 0],
          [Math.max(r.d1 / 2, 1e-3), 0],
          [Math.max(r.d2 / 2, 1e-3), r.h],
          [0, r.h],
        ],
        r.at,
        r.dir,
      );
    case "sphere":
      return R.makeSphere(r.d / 2).translate(r.at);
    case "prism": {
      const { u, n } = profileFrame(r.dir, r.rot);
      return polygon(r.pts).sketchOnPlane(planeFor(r.at, u, n)).extrude(r.h) as Shape3D;
    }
    case "rrect": {
      const { u, n } = profileFrame(r.dir);
      const start = r.center ? vadd(r.at, vscale(n, -r.depth / 2)) : r.at;
      const d = r.r > 1e-6 ? R.drawRoundedRectangle(r.w, r.h, r.r) : R.drawRectangle(r.w, r.h);
      return d.sketchOnPlane(planeFor(start, u, n)).extrude(r.depth) as Shape3D;
    }
    case "revolve":
      return revolveProfile(r.pts, r.at, r.dir);
    case "gear": {
      const { u, n } = frameFor(r.dir);
      const pts = gearOutline({ m: r.m, z: r.z, pa: r.pa, backlash: r.backlash, phase: r.phase }, r.z > 60 ? 4 : 5);
      let g = polygon(pts).sketchOnPlane(planeFor(r.at, u, n)).extrude(r.w) as Shape3D;
      if (r.bore > 0) g = g.cut(R.makeCylinder(r.bore / 2, r.w + 2, vadd(r.at, vscale(n, -1)), n));
      return g;
    }
    case "hole": {
      const start = vadd(r.at, vscale(r.dir, -0.05));
      let tool: Shape3D = R.makeCylinder(r.d / 2, r.depth + 0.05, start, r.dir);
      if (r.cbore) tool = tool.fuse(R.makeCylinder(r.cbore[0] / 2, r.cbore[1] + 0.05, start, r.dir));
      if (r.csink && r.csink > r.d) {
        const depth = (r.csink - r.d) / 2;
        const cone = revolveProfile(
          [
            [0, -0.05],
            [r.csink / 2 + 0.05, -0.05],
            [r.d / 2, depth],
            [0, depth],
          ],
          r.at,
          r.dir,
        );
        tool = tool.fuse(cone);
      }
      return tool;
    }
    case "flight": {
      // helical screw flight: a radial trapezoid (root to tip) swept along a helix on the core
      const rIn = Math.max(0.5, r.core_d / 2 - 0.6);
      const rOut = r.d / 2;
      const helix = R.makeHelix(r.pitch, r.length, rIn, [0, 0, 0], [0, 0, 1], r.left);
      const profile = R.draw([rIn, -r.root / 2])
        .lineTo([rOut, -r.tip / 2])
        .lineTo([rOut, r.tip / 2])
        .lineTo([rIn, r.root / 2])
        .close()
        .sketchOnPlane(new R.Plane([0, 0, 0], [1, 0, 0], [0, -1, 0]));
      let s = R.genericSweep((profile as unknown as { wire: R.Wire }).wire, helix, { frenet: true }, false) as Shape3D;
      const z: V3 = [0, 0, 1];
      const c = vcross(z, r.dir);
      const sin = Math.hypot(c[0], c[1], c[2]);
      const cos = r.dir[2];
      if (sin > 1e-9) s = s.rotate((Math.atan2(sin, cos) * 180) / Math.PI, [0, 0, 0], c);
      else if (cos < 0) s = s.rotate(180, [0, 0, 0], [1, 0, 0]);
      return s.translate(r.at);
    }
    case "xform":
      return applyXf(buildShape(r.shape), r.xf);
    case "union": {
      const shapes = r.shapes.map(buildShape);
      let out = shapes[0];
      for (let i = 1; i < shapes.length; i++) out = out.fuse(shapes[i]);
      return out;
    }
    case "sk_extrude": {
      const plane = planeFor(vadd(r.o, vscale(r.n, r.start)), r.u, r.n);
      return fuseAll(r.regions.map((reg) => regionSketch(plane, reg).extrude(r.h) as Shape3D));
    }
    case "sk_revolve": {
      const plane = planeFor(r.o, r.u, r.n);
      const v = vcross(r.n, r.u);
      const [p, d] = r.axis;
      const origin = vadd(r.o, vadd(vscale(r.u, p[0]), vscale(v, p[1])));
      const dir = vadd(vscale(r.u, d[0]), vscale(v, d[1]));
      return fuseAll(r.regions.map((reg) => regionSketch(plane, reg).revolve(dir, { origin, angle: r.angle }) as Shape3D));
    }
    case "import": {
      const file = imported.get(r.asset);
      if (!file) throw new BuildError("The imported STEP file is not loaded yet.");
      if (r.body < 0) {
        file.whole ??= R.makeCompound(file.bodies) as unknown as Shape3D;
        return file.whole.clone();
      }
      const body = file.bodies[r.body];
      if (!body) throw new BuildError(`The imported file has no body ${r.body + 1} (it has ${file.bodies.length}).`);
      // a new handle on the same geometry: the cache may free it without touching the registry
      return body.clone();
    }
  }
}

// ---------- imported STEP files ----------

interface LoadedImport {
  bodies: Shape3D[];
  faceColors: (string[] | null)[];
  whole?: Shape3D;
}

/** Bodies of imported files by content hash, loaded once per kernel. */
const imported = new Map<string, LoadedImport>();

export function registerImport(hash: string, bodies: Shape3D[], faceColors: (string[] | null)[]) {
  dropImport(hash);
  imported.set(hash, { bodies, faceColors });
}

export function dropImport(hash: string) {
  const f = imported.get(hash);
  if (!f) return;
  for (const b of f.bodies) freeShape(b);
  freeShape(f.whole);
  imported.delete(hash);
}

export const hasImport = (hash: string) => imported.has(hash);

/** Per-face colours for a part that is exactly one imported body (moved, not modified). */
export function importFaceColors(p: PartRecipe): string[] | null {
  if (p.ops.length || !p.base) return null;
  let r: ShapeRecipe = p.base;
  while (r.t === "xform") r = r.shape;
  if (r.t !== "import" || r.body < 0) return null;
  return imported.get(r.asset)?.faceColors[r.body] ?? null;
}

function freeShape(s: { delete?: () => void } | undefined) {
  try {
    s?.delete?.();
  } catch {
    /* already freed */
  }
}

function fuseAll(shapes: Shape3D[]): Shape3D {
  if (!shapes.length) throw new BuildError("The sketch has no closed profile");
  let out = shapes[0];
  for (let i = 1; i < shapes.length; i++) out = out.fuse(shapes[i]);
  return out;
}

/** A closed sketch loop as a wire on the plane. */
function loopSketch(plane: R.Plane, segs: Seg2[]): R.Sketch {
  if (segs.length === 1 && segs[0].k === "c") {
    const { c, r } = segs[0];
    return new R.Sketcher(plane.clone())
      .movePointerTo([c[0] + r, c[1]])
      .threePointsArcTo([c[0] - r, c[1]], [c[0], c[1] + r])
      .threePointsArcTo([c[0] + r, c[1]], [c[0], c[1] - r])
      .close();
  }
  const first = segs[0];
  if (first.k === "c") throw new BuildError("A circle must be a loop on its own");
  let pen = new R.Sketcher(plane.clone()).movePointerTo(first.a);
  for (const s of segs) {
    if (s.k === "l") pen = pen.lineTo(s.b);
    else if (s.k === "a") pen = pen.threePointsArcTo(s.b, s.m);
  }
  return pen.close();
}

function regionSketch(plane: R.Plane, reg: ProfileRegion) {
  const outer = loopSketch(plane, reg.outer);
  if (!reg.holes.length) return outer;
  return new R.CompoundSketch([outer, ...reg.holes.map((h) => loopSketch(plane, h))]);
}

export function applyXf(s: Shape3D, xf: Xform[]): Shape3D {
  let out = s;
  for (const x of xf) {
    if (x.op === "translate") {
      if (x.v[0] || x.v[1] || x.v[2]) out = out.translate(x.v);
    } else if (Math.abs(x.angle) > 1e-9) out = out.rotate(x.angle, x.origin, x.axis);
  }
  return out;
}

function planeOf(open: V3): { plane: "XY" | "YZ" | "XZ"; axis: 0 | 1 | 2 } {
  const ax = [Math.abs(open[0]), Math.abs(open[1]), Math.abs(open[2])];
  if (ax[2] >= ax[0] && ax[2] >= ax[1]) return { plane: "XY", axis: 2 };
  if (ax[0] >= ax[1]) return { plane: "YZ", axis: 0 };
  return { plane: "XZ", axis: 1 };
}

function edgeFilter(shape: Shape3D, sel: EdgeSel) {
  const [min, max] = shape.boundingBox.bounds;
  switch (sel) {
    case "vertical":
      return (e: R.EdgeFinder) => e.inDirection("Z");
    case "top":
      return (e: R.EdgeFinder) => e.inPlane("XY", [0, 0, max[2]]);
    case "bottom":
      return (e: R.EdgeFinder) => e.inPlane("XY", [0, 0, min[2]]);
    case "all":
      return undefined;
  }
}

export function buildPart(p: PartRecipe): Shape3D {
  if (!p.base) throw new BuildError("Part has no body");
  let shape = buildShape(p.base);
  p.ops.forEach((op, i) => {
    const step = `step ${i + 2}`;
    try {
      switch (op.op) {
        case "add":
          shape = shape.fuse(buildShape(op.shape));
          break;
        case "cut":
          shape = shape.cut(buildShape(op.shape));
          break;
        case "intersect":
          shape = shape.intersect(buildShape(op.shape)) as Shape3D;
          break;
        case "shell": {
          const { plane, axis } = planeOf(op.open);
          const [min, max] = shape.boundingBox.bounds;
          const origin: V3 = [0, 0, 0];
          origin[axis] = op.open[axis] >= 0 ? max[axis] : min[axis];
          // pass a point: a numeric offset runs along each named plane's own normal (XZ points to -Y)
          shape = shape.shell(op.t, (f) => f.inPlane(plane, origin));
          break;
        }
        case "fillet":
        case "chamfer": {
          const filter = edgeFilter(shape, op.edges);
          shape = op.op === "fillet" ? shape.fillet(op.r, filter) : shape.chamfer(op.r, filter);
          break;
        }
      }
    } catch (e) {
      const what = op.op === "shell" ? `shell(${op.t})` : op.op === "fillet" || op.op === "chamfer" ? `${op.op}(${op.r}, edges: "${op.edges}")` : `${op.op} ${(op as { shape: ShapeRecipe }).shape.t}`;
      const hint =
        op.op === "fillet" || op.op === "chamfer"
          ? " Try a smaller radius, or apply it right after the body before cutting features."
          : op.op === "shell"
            ? " Shell needs a simple body; apply it before adding bosses or cutting holes."
            : "";
      throw new BuildError(`The kernel could not apply ${what} (${step}): ${errMsg(e)}.${hint}`);
    }
  });
  return shape;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "number") return `OpenCASCADE error ${e}`;
  return String(e);
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
  /** per-vertex RGB, only for imported bodies whose faces have their own colours */
  colors?: Uint8Array;
}

export function meshShape(shape: Shape3D, quality: "preview" | "final", faceColors?: string[] | null): MeshData {
  const opts = quality === "preview" ? { tolerance: 0.25, angularTolerance: 25 } : { tolerance: 0.03, angularTolerance: 10 };
  const m = shape.mesh(opts);
  const e = shape.meshEdges(opts);
  const out: MeshData = {
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    edges: new Float32Array(e.lines),
  };
  if (faceColors?.length) out.colors = vertexColors(shape, m, faceColors);
  return out;
}

/** Colour each face's vertices. Mesh face groups are keyed by face hash; faces are matched to the explorer order the colours use. */
function vertexColors(shape: Shape3D, m: { triangles: number[]; vertices: number[]; faceGroups: { start: number; count: number; faceId: number }[] }, faceColors: string[]): Uint8Array {
  const oc = R.getOC() as unknown as OCFaces;
  const index = new Map<number, number>();
  const ex = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (let i = 0; ex.More(); ex.Next(), i++) {
    const h = oc.ReplicadShapeHasher.HashCode(ex.Current(), R.HASH_CODE_MAX);
    if (!index.has(h)) index.set(h, i);
  }
  ex.delete();
  const rgb = faceColors.map(hexRgb);
  const fallback = rgb[0] ?? [154, 163, 173];
  const colors = new Uint8Array(m.vertices.length);
  m.faceGroups.forEach((g, gi) => {
    const c = rgb[index.get(g.faceId) ?? gi] ?? fallback;
    for (let t = g.start; t < g.start + g.count; t++) {
      const v = m.triangles[t] * 3;
      colors[v] = c[0];
      colors[v + 1] = c[1];
      colors[v + 2] = c[2];
    }
  });
  return colors;
}

interface OCFaces {
  TopExp_Explorer: new (s: unknown, a: unknown, b: unknown) => { More(): boolean; Next(): void; Current(): unknown; delete(): void };
  TopAbs_ShapeEnum: { TopAbs_FACE: unknown; TopAbs_SHAPE: unknown };
  ReplicadShapeHasher: { HashCode(s: unknown, max: number): number };
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [154, 163, 173];
}

export function bboxOf(shape: Shape3D): [V3, V3] {
  const [a, b] = shape.boundingBox.bounds;
  return [
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
  ];
}

export { rotateAbout };
