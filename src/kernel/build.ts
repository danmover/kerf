// Turns geometry recipes into exact B-rep solids with OpenCASCADE (via
// replicad). Runs inside the kernel worker, and in Node for tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { frameFor, rotateAbout, vadd, vcross, vscale, type OpenSpec, type PartOp, type PartRecipe, type ShapeRecipe, type V2, type V3, type Xform } from "./recipe";
import { gearOutline } from "../library/gears";
import { extrudeProfile, loftProfiles, revolveProfile2, sweepProfile } from "./profiles";
import { buildKnurl, buildThread } from "./threads";
import { describeSel, Topo, type FeatureTools } from "./topology";

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

/**
 * Build one solid. `detail` is false for fast builds: threads and knurls are
 * then plain cylinders, which is what checks and previews use.
 */
export function buildShape(r: ShapeRecipe, detail = false): Shape3D {
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
      if (r.thread) {
        let tool = buildThread(r.thread, r.depth, r.at, r.dir, true, r.lead ?? 0, detail);
        if (r.cbore) tool = tool.fuse(R.makeCylinder(r.cbore[0] / 2, r.cbore[1] + 0.05, vadd(r.at, vscale(r.dir, -0.05)), r.dir));
        return tool;
      }
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
    case "xform":
      return applyXf(buildShape(r.shape, detail), r.xf);
    case "union": {
      const shapes = r.shapes.map((x) => buildShape(x, detail));
      let out = shapes[0];
      for (let i = 1; i < shapes.length; i++) out = out.fuse(shapes[i]);
      return out;
    }
    case "extrude":
      return extrudeProfile(r.p, r.h, r.f, r.twist, r.scale);
    case "sweep":
      return sweepProfile(r.p, r.path, r.rot, r.frenet);
    case "loft":
      return loftProfiles(r.secs, r.ruled);
    case "revolve2":
      return revolveProfile2(r.p, r.f, r.angle);
    case "thread":
      return buildThread(r.spec, r.length, r.at, r.dir, r.internal, r.lead, detail);
    case "knurl":
      return buildKnurl(r.d, r.h, r.at, r.dir, r.count, r.depth, r.style, detail);
  }
}

export function applyXf(s: Shape3D, xf: Xform[]): Shape3D {
  let out = s;
  for (const x of xf) {
    if (x.op === "translate") {
      if (x.v[0] || x.v[1] || x.v[2]) out = out.translate(x.v);
    } else if (x.op === "rotate") {
      if (Math.abs(x.angle) > 1e-9) out = out.rotate(x.angle, x.origin, x.axis);
    } else out = out.mirror(new R.Plane(x.origin, frameFor(x.normal).u, x.normal), x.origin);
  }
  return out;
}

export interface PartBuild {
  shape: Shape3D;
  /** cosmetic steps that failed and were left out */
  warnings: string[];
  features: Map<string, FeatureTools>;
}

export function buildPart(p: PartRecipe, opts: { detail?: boolean } = {}): Shape3D {
  return buildPartFull(p, opts).shape;
}

/** Build a part step by step, keeping named feature tools for edge and face selection. */
export function buildPartFull(p: PartRecipe, opts: { detail?: boolean } = {}): PartBuild {
  const detail = !!opts.detail;
  if (!p.base) throw new BuildError("Part has no body");
  const features = new Map<string, FeatureTools>();
  const warnings: string[] = [];
  let shape = buildShape(p.base, detail);
  if (p.baseName) features.set(p.baseName, { name: p.baseName, kind: "body", tools: [shape] });
  let topo: Topo | null = null;
  const topoNow = () => (topo && topo.shape === shape ? topo : (topo?.dispose(), (topo = new Topo(shape, features))));
  p.ops.forEach((op, i) => {
    if (op.cosmetic && !detail) return;
    const step = `step ${i + 2}`;
    try {
      shape = applyOp(shape, op, detail, features, topoNow);
    } catch (e) {
      const what = opLabel(op);
      if (op.cosmetic) {
        warnings.push(`${what} (${step}) was left out: ${errMsg(e)}`);
        return;
      }
      const hint =
        op.op === "fillet" || op.op === "chamfer"
          ? " Try a smaller radius, pick fewer edges, or round the edges before cutting features that cross them."
          : op.op === "shell"
            ? " Shell needs a simple body; apply it before adding bosses or cutting holes."
            : op.op === "draft"
              ? " Draft planar or cylindrical faces before rounding their edges, and keep the angle small."
              : "";
      throw new BuildError(`The kernel could not apply ${what} (${step}): ${errMsg(e)}.${hint}`);
    }
  });
  (topo as Topo | null)?.dispose();
  return { shape, warnings, features };
}

function opLabel(op: PartOp): string {
  switch (op.op) {
    case "shell":
      return `shell(${op.t})`;
    case "fillet":
    case "chamfer":
      return `${op.op}(${Array.isArray(op.r) ? `(${op.r.join(", ")})` : op.r}, edges: ${describeSel(op.edges)})`;
    case "draft":
      return `draft(${op.angle}, faces: ${describeSel(op.faces)})`;
    default:
      return `${op.op} ${op.shape.t}${op.name ? ` as ${op.name}` : ""}`;
  }
}

function applyOp(shape: Shape3D, op: PartOp, detail: boolean, features: Map<string, FeatureTools>, topo: () => Topo): Shape3D {
  switch (op.op) {
    case "add":
    case "cut":
    case "intersect": {
      const tool = buildShape(op.shape, detail);
      if (op.name) {
        const f = features.get(op.name);
        if (f) f.tools.push(tool);
        else features.set(op.name, { name: op.name, kind: op.op, tools: [tool] });
      }
      if (op.op === "add") return shape.fuse(tool);
      if (op.op === "cut") return shape.cut(tool);
      return shape.intersect(tool) as Shape3D;
    }
    case "shell": {
      const t = topo();
      const specs: OpenSpec[] = Array.isArray(op.open) && typeof op.open[0] === "number" ? [{ dir: op.open as V3 }] : (op.open as OpenSpec[]);
      const picked = new Set<number>();
      for (const sp of specs) {
        if ("dir" in sp) {
          const f = t.outermostFace(sp.dir);
          if (f === undefined) throw new BuildError(`no flat face points along (${sp.dir.map((x) => Math.round(x * 100) / 100).join(", ")}) to leave open`);
          picked.add(f);
        } else {
          const fs = t.selectFaces(sp.sel);
          if (!fs.size) throw new BuildError(`the open faces ${describeSel(sp.sel)} matched nothing`);
          fs.forEach((f) => picked.add(f));
        }
      }
      const faces = [...picked].map((i) => t.faces[i]);
      return shape.shell(op.t, (f) => f.inList(faces));
    }
    case "fillet":
    case "chamfer": {
      const t = topo();
      const idx = t.selectEdges(op.edges);
      if (!idx.size) throw new BuildError(`edges: ${describeSel(op.edges)} matched no edges`);
      const chosen = [...idx].map((i) => t.edges[i]);
      const byHash = new Map<number, R.Edge[]>();
      for (const e of chosen) byHash.set(e.hashCode, [...(byHash.get(e.hashCode) ?? []), e]);
      const has = (e: R.Edge) => !!byHash.get(e.hashCode)?.some((x) => x.isSame(e));
      if (op.op === "fillet") {
        const r = op.r;
        return shape.fillet((e) => (has(e) ? r : null));
      }
      const r = Array.isArray(op.r) ? op.r[0] : op.r;
      return shape.chamfer((e) => (has(e) ? r : null));
    }
    case "draft": {
      const t = topo();
      const idx = t.selectFaces(op.faces);
      if (!idx.size) throw new BuildError(`faces: ${describeSel(op.faces)} matched no faces`);
      const faces = [...idx].map((i) => t.faces[i]);
      const plane = new R.Plane(op.neutral, frameFor(op.pull).u, op.pull);
      return shape.draft(op.angle, (f) => f.inList(faces), plane);
    }
  }
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
}

export function meshShape(shape: Shape3D, quality: "preview" | "final"): MeshData {
  const opts = quality === "preview" ? { tolerance: 0.25, angularTolerance: 25 } : { tolerance: 0.03, angularTolerance: 10 };
  const m = shape.mesh(opts);
  const e = shape.meshEdges(opts);
  return {
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    edges: new Float32Array(e.lines),
  };
}

export function bboxOf(shape: Shape3D): [V3, V3] {
  const [a, b] = shape.boundingBox.bounds;
  return [
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
  ];
}

export { rotateAbout };
