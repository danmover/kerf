// Turns geometry recipes into exact B-rep solids with OpenCASCADE (via
// replicad). Runs inside the kernel worker, and in Node for tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { frameFor, rotateAbout, vadd, vcross, vdot, vnorm, vscale, vsub, type OpenSpec, type PartOp, type PartRecipe, type ProfileRegion, type Seg2, type ShapeRecipe, type V2, type V3, type Xform } from "./recipe";
import { gearOutline } from "../library/gears";
import { draftFaces, extrudeProfile, loftProfiles, planeOf, revolveProfile2, shapeValid, sweepProfile } from "./profiles";
import { buildKnurl, buildThread } from "./threads";
import { describeSel, Topo, type FeatureTools } from "./topology";
import { buildMould } from "./mould";
import { smoothFaceted } from "./meshSmooth";
import { deleteFaces, moveFaces, pushPull, replaceFaces, targetPlane } from "./direct";

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
      return applyXf(buildShape(r.shape, detail), r.xf);
    case "union": {
      const shapes = r.shapes.map((x) => buildShape(x, detail));
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
      if (!file) throw new BuildError("The imported file is not loaded yet.");
      if (r.body < 0) {
        file.whole ??= R.makeCompound(file.bodies) as unknown as Shape3D;
        return file.whole.clone();
      }
      const body = file.bodies[r.body];
      if (!body) throw new BuildError(`The imported file has no body ${r.body + 1} (it has ${file.bodies.length}).`);
      // a new handle on the same geometry: the cache may free it without touching the registry
      return body.clone();
    }
    case "diff": {
      let out = buildShape(r.a, detail);
      for (const b of r.b) out = out.cut(buildShape(b, detail));
      return out;
    }
    case "extrude":
      if (r.until) throw new BuildError(`until: "${r.until}" works only on an extrusion added or cut straight onto a part (add extrude(..., until: "${r.until}")), not inside another shape`);
      return extrudeProfile(r.p, r.h, r.f, r.twist, r.scale, r.taper ?? 0);
    case "sweep":
      return sweepProfile(r.p, r.path, r.rot, r.frenet);
    case "loft":
      return loftProfiles(r.secs, r.ruled, r.matched);
    case "revolve2":
      return revolveProfile2(r.p, r.f, r.angle);
    case "thread": {
      const t = buildThread(r.spec, r.length, r.at, r.dir, r.internal, r.lead, detail, r.fastD);
      if (!r.bore) return t;
      return t.cut(R.makeCylinder(r.bore / 2, r.length + 0.2, vadd(r.at, vscale(r.dir, -0.1)), r.dir));
    }
    case "knurl":
      return buildKnurl(r.d, r.h, r.at, r.dir, r.count, r.depth, r.style, detail);
    case "lod":
      return buildShape(detail ? r.detail : r.fast, detail);
    case "instances": {
      const all: Shape3D[] = [];
      for (const it of r.items) {
        const s = buildShape(it.shape, detail);
        for (const xf of it.xfs) all.push(applyXf(s.clone() as Shape3D, xf));
        s.delete();
      }
      return R.makeCompound(all) as unknown as Shape3D;
    }
    case "unfold":
      return buildUnfold(r);
    case "mould":
      return buildMould(r, buildPart(r.part), (s) => applyXf(s, r.xf));
    case "part":
      return applyXf(applyXf(buildPart(r.part, { detail }), r.xf), r.into ?? []);
  }
}

/** The flat pattern of a sheet-metal part, from the part as built: every hole and cut-out on its flat regions comes along. */
function buildUnfold(r: Extract<ShapeRecipe, { t: "unfold" }>): Shape3D {
  const solid = buildPart(r.part);
  const flat: Shape3D[] = [];
  for (const p of r.pieces) {
    const piece = solid.intersect(buildShape(p.region)) as Shape3D;
    if (solidVolume(piece) > 1e-6) flat.push(applyXf(piece, p.xf));
  }
  for (const b of r.bends) flat.push(buildShape(b));
  if (!flat.length) throw new BuildError("the flat pattern came out empty");
  const out = fuseAll(flat);
  try {
    return out.simplify();
  } catch {
    return out;
  }
}

// ---------- imported STEP files ----------

interface LoadedImport {
  bodies: Shape3D[];
  faceColors: (string[] | null)[];
  whole?: Shape3D;
  /** bodies made of a mesh's flat facets: shown smooth where the facets meet gently */
  faceted?: boolean;
}

/** Bodies of imported files by content hash, loaded once per kernel. */
const imported = new Map<string, LoadedImport>();

export function registerImport(hash: string, bodies: Shape3D[], faceColors: (string[] | null)[], faceted = false) {
  dropImport(hash);
  imported.set(hash, { bodies, faceColors, faceted });
}

export function dropImport(hash: string) {
  const f = imported.get(hash);
  if (!f) return;
  for (const b of f.bodies) freeShape(b);
  freeShape(f.whole);
  imported.delete(hash);
}

export const hasImport = (hash: string) => imported.has(hash);

/** Whether a part is one body of an imported mesh (moved, or changed with direct edits), whose facets are shown smooth. */
export function importFaceted(p: PartRecipe): boolean {
  if (!p.base || p.ops.some((o) => !DIRECT_OPS.has(o.op))) return false;
  let r: ShapeRecipe = p.base;
  while (r.t === "xform") r = r.shape;
  return r.t === "import" && r.body >= 0 && !!imported.get(r.asset)?.faceted;
}

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
  if (segs.length === 1 && segs[0].k === "e") {
    // two halves from one end of the long axis to the other and back
    const { c, rx, ry, rot } = segs[0];
    const long = rx >= ry;
    const t = ((rot + (long ? 0 : 90)) * Math.PI) / 180;
    const R0 = long ? rx : ry;
    const r1 = long ? ry : rx;
    const p0: [number, number] = [c[0] + R0 * Math.cos(t), c[1] + R0 * Math.sin(t)];
    const p1: [number, number] = [c[0] - R0 * Math.cos(t), c[1] - R0 * Math.sin(t)];
    return new R.Sketcher(plane.clone()).movePointerTo(p0).halfEllipseTo(p1, r1, false).halfEllipseTo(p0, r1, false).close();
  }
  const first = segs[0];
  if (first.k === "c" || first.k === "e") throw new BuildError(`${first.k === "c" ? "A circle" : "An ellipse"} must be a loop on its own`);
  let pen = new R.Sketcher(plane.clone()).movePointerTo(first.a);
  for (const s of segs) {
    if (s.k === "l") pen = pen.lineTo(s.b);
    else if (s.k === "a") pen = pen.threePointsArcTo(s.b, s.m);
    else if (s.k === "b") pen = pen.cubicBezierCurveTo(s.b, s.c1, s.c2);
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
  let shape: Shape3D;
  try {
    shape = buildShape(p.base, detail);
  } catch (e) {
    if (isTrap(e) || e instanceof BuildError) throw e;
    throw new BuildError(`The kernel could not build the body ${p.base.t}${p.baseName ? ` as ${p.baseName}` : ""} (step 1): ${errMsg(e)}.`);
  }
  if (p.baseName) features.set(p.baseName, { name: p.baseName, kind: "body", tools: [shape] });
  let topo: Topo | null = null;
  const topoNow = () => (topo && topo.shape === shape ? topo : (topo?.dispose(), (topo = new Topo(shape, features))));
  const batchable = (op: PartOp | undefined, kind: string): op is BoolOp => !!op && op.op === kind && "shape" in op && !op.cosmetic && !runsUntil(op.shape) && (kind === "add" || !(detail && threadEnvelope(op.shape)));
  let skip = 0;
  p.ops.forEach((op, i) => {
    if (skip) return void skip--;
    if (op.cosmetic && !detail) return;
    // a run of adds (or cuts) goes through the kernel in one boolean: much faster than one at a time on curved parts
    if (op.op === "add" || op.op === "cut") {
      let n = 1;
      while (batchable(op, op.op) && batchable(p.ops[i + n], op.op)) n++;
      if (n > 1) {
        shape = applyBatch(shape, p.ops.slice(i, i + n) as BoolOp[], i, detail, features);
        skip = n - 1;
        return;
      }
    }
    const step = `step ${i + 2}`;
    try {
      shape = applyOp(shape, op, detail, features, topoNow);
    } catch (e) {
      // a WebAssembly trap leaves OpenCASCADE in an unknown state: let the worker restart
      if (isTrap(e)) throw e;
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
              : DIRECT_OPS.has(op.op)
                ? " A direct edit works on the solid as it is at that step: check the faces: selection picks the faces meant (near() points in the part's own coordinates)."
                : "";
      throw new BuildError(`The kernel could not apply ${what} (${step}): ${errMsg(e)}.${hint}`);
    }
  });
  (topo as Topo | null)?.dispose();
  return { shape, warnings, features };
}

type BoolOp = PartOp & { op: "add" | "cut"; shape: ShapeRecipe; name?: string };

/** Several adds or several cuts in one go. If the kernel balks, they are applied one at a time so the error names the step. */
function applyBatch(shape: Shape3D, ops: BoolOp[], first: number, detail: boolean, features: Map<string, FeatureTools>): Shape3D {
  const tools = ops.map((op, k) => {
    try {
      return buildShape(op.shape, detail);
    } catch (e) {
      if (isTrap(e) || e instanceof BuildError) throw e;
      throw new BuildError(`The kernel could not apply ${opLabel(op)} (step ${first + k + 2}): ${errMsg(e)}.`);
    }
  });
  ops.forEach((op, k) => {
    if (!op.name) return;
    const f = features.get(op.name);
    if (f) f.tools.push(tools[k]);
    else features.set(op.name, { name: op.name, kind: op.op, tools: [tools[k]] });
  });
  const oc = R.getOC();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const list = new oc.NCollection_List_TopoDS_Shape();
  const b = ops[0].op === "add" ? new oc.BRepAlgoAPI_Fuse() : new oc.BRepAlgoAPI_Cut();
  try {
    args.Append(shape.wrapped);
    for (const t of tools) list.Append(t.wrapped);
    b.SetArguments(args);
    b.SetTools(list);
    b.Build();
    if (!b.HasErrors() && b.IsDone()) {
      b.SimplifyResult(true, true, 0.001);
      return R.cast(b.Shape()) as Shape3D;
    }
  } catch (e) {
    if (isTrap(e)) throw e;
  } finally {
    args.delete();
    list.delete();
    b.delete();
  }
  ops.forEach((op, k) => {
    try {
      shape = op.op === "add" ? shape.fuse(tools[k]) : shape.cut(tools[k]);
    } catch (e) {
      if (isTrap(e)) throw e;
      throw new BuildError(`The kernel could not apply ${opLabel(op)} (step ${first + k + 2}): ${errMsg(e)}.`);
    }
  });
  return shape;
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
    case "push_pull":
      return `push_pull(${op.d}, faces: ${describeSel(op.faces)})`;
    case "replace_faces":
      return `replace_faces(faces: ${describeSel(op.faces)}, with: ${describeSel(op.with)})`;
    case "delete_faces":
      return `delete_faces(faces: ${describeSel(op.faces)})`;
    case "move_faces":
      return `move_faces(faces: ${describeSel(op.faces)}${op.by.some((x) => x) ? `, by: (${op.by.join(", ")})` : ""}${op.turn ? `, turn: ${op.turn}` : ""}${op.copy ? ", copy: true" : ""})`;
    default:
      return `${op.op} ${op.shape.t}${op.name ? ` as ${op.name}` : ""}`;
  }
}

function applyOp(shape: Shape3D, op: PartOp, detail: boolean, features: Map<string, FeatureTools>, topo: () => Topo): Shape3D {
  switch (op.op) {
    case "add":
    case "cut":
    case "intersect": {
      const tool = runsUntil(op.shape) ? upToNext(shape, op.shape, op.op) : buildShape(op.shape, detail);
      if (op.name) {
        const f = features.get(op.name);
        if (f) f.tools.push(tool);
        else features.set(op.name, { name: op.name, kind: op.op, tools: [tool] });
      }
      if (op.op === "add") return shape.fuse(tool);
      if (op.op === "cut") {
        const env = detail ? threadEnvelope(op.shape) : null;
        return env ? cutWithin(shape, tool, env) : shape.cut(tool);
      }
      return shape.intersect(tool) as Shape3D;
    }
    case "shell": {
      const t = topo();
      const specs: OpenSpec[] = Array.isArray(op.open) && typeof op.open[0] === "number" ? [{ dir: op.open as V3 }] : (op.open as OpenSpec[]);
      const picked = new Set<number>();
      for (const sp of specs) {
        if ("dir" in sp) {
          const fs = t.outermostFaces(sp.dir);
          if (!fs.length) throw new BuildError(`no flat face points along (${sp.dir.map((x) => Math.round(x * 100) / 100).join(", ")}) to leave open`);
          fs.forEach((f) => picked.add(f));
        } else {
          const fs = t.selectFaces(sp.sel);
          if (!fs.size) throw new BuildError(`the open faces ${describeSel(sp.sel)} matched nothing`);
          fs.forEach((f) => picked.add(f));
        }
      }
      const faces = [...picked].map((i) => t.faces[i]);
      return checked(shape.shell(op.t, (f) => f.inList(faces)));
    }
    case "fillet":
    case "chamfer": {
      const t = topo();
      const idx = t.selectEdges(op.edges);
      if (!idx.size) throw new BuildError(`edges: ${describeSel(op.edges)} matched no edges`);
      if (idx.size > MAX_ROUNDED_EDGES) throw new BuildError(`edges: ${describeSel(op.edges)} picks ${idx.size} edges, more than the ${MAX_ROUNDED_EDGES} Kerf rounds in one step`);
      const chosen = [...idx].map((i) => t.edges[i]);
      const byHash = new Map<number, R.Edge[]>();
      for (const e of chosen) byHash.set(e.hashCode, [...(byHash.get(e.hashCode) ?? []), e]);
      const has = (e: R.Edge) => !!byHash.get(e.hashCode)?.some((x) => x.isSame(e));
      if (op.op === "fillet") {
        const r = op.r;
        return checked(shape.fillet((e) => (has(e) ? r : null)));
      }
      const r = Array.isArray(op.r) ? op.r[0] : op.r;
      return checked(shape.chamfer((e) => (has(e) ? r : null)));
    }
    case "draft": {
      const t = topo();
      const idx = t.selectFaces(op.faces);
      if (!idx.size) throw new BuildError(`faces: ${describeSel(op.faces)} matched no faces`);
      const faces = [...idx].map((i) => t.faces[i]);
      const out = draftFaces(shape, faces, op.angle, op.neutral, op.pull);
      if (!out) throw new BuildError(faces.some((f) => !["PLANE", "CYLINDRE", "CONE"].includes(f.geomType)) ? "only flat, cylindrical and conical faces can be drafted, and the selection has others" : "the faces could not be tilted that far");
      return out;
    }
    case "push_pull":
    case "replace_faces":
    case "delete_faces":
    case "move_faces": {
      const t = topo();
      const idx = t.selectFaces(op.faces);
      if (!idx.size) throw new BuildError(`faces: ${describeSel(op.faces)} matched no faces`);
      if (idx.size > MAX_DIRECT_FACES) throw new BuildError(`faces: ${describeSel(op.faces)} picks ${idx.size} faces, more than the ${MAX_DIRECT_FACES} Kerf edits in one step`);
      const faces = [...idx].map((i) => t.faces[i]);
      if (op.op === "push_pull") return pushPull(shape, faces, op.d);
      if (op.op === "delete_faces") return deleteFaces(shape, faces);
      if (op.op === "move_faces") return moveFaces(shape, faces, { by: op.by, turn: op.turn, axis: op.axis, about: op.about, copy: op.copy });
      const onto = [...t.selectFaces(op.with)].filter((i) => !idx.has(i));
      if (!onto.length) throw new BuildError(`with: ${describeSel(op.with)} matched no face other than the ones being replaced`);
      return replaceFaces(shape, faces, targetPlane(onto.map((i) => t.faces[i])));
    }
  }
}

/** The direct edits: they change faces of the solid as it is, whatever made it. */
const DIRECT_OPS = new Set(["push_pull", "replace_faces", "delete_faces", "move_faces"]);
/** Most faces one direct edit takes (each is its own boolean or two). */
export const MAX_DIRECT_FACES = 60;

interface Envelope {
  at: V3;
  dir: V3;
  rad: number;
  len: number;
}

/** A cylinder that holds a thread-cutting tool, or null for other tools. */
function threadEnvelope(r: ShapeRecipe): Envelope | null {
  const t = r.t === "thread" && r.internal ? { spec: r.spec, length: r.length, extra: 0 } : r.t === "hole" && r.thread ? { spec: r.thread, length: r.depth, extra: r.cbore ? r.cbore[0] / 2 : 0 } : null;
  if (!t || (r.t !== "thread" && r.t !== "hole")) return null;
  const n = vnorm(r.dir);
  return { at: vadd(r.at, vscale(n, -0.2)), dir: n, rad: Math.max(t.spec.d / 2 + t.spec.clearance + 0.35, t.extra + 0.3), len: t.length + 0.4 };
}

/**
 * Cut a thread tool out of a shape. A helical face's bounding box covers the whole hole, so cutting one from a
 * part with many faces around the hole (a knurled cap) intersects every one of them: half a minute. Instead the
 * part is split along a cylinder that holds the tool, only the small inside piece is threaded, and the two pieces
 * are sewn back together without the faces they share. Falls back to the plain cut if that does not give a
 * valid solid of the right volume.
 */
function cutWithin(shape: Shape3D, tool: Shape3D, env: Envelope): Shape3D {
  const cyl = R.makeCylinder(env.rad, env.len, env.at, env.dir);
  try {
    const inside = shape.intersect(cyl) as Shape3D;
    if (solidVolume(inside) < 1e-9) return shape;
    const outside = shape.cut(cyl);
    const threaded = inside.cut(tool);
    const vOut = solidVolume(outside);
    if (vOut < 1e-9) return threaded;
    const want = vOut + solidVolume(threaded);
    const sewn = sewPieces([outside, threaded], (f) => onEnvelope(f, env));
    if (sewn && Math.abs(solidVolume(sewn) - want) <= 1e-4 * want) return sewn;
  } catch {
    // fall through to the plain cut
  }
  return shape.cut(tool);
}

/** Is this face part of the envelope cylinder's side or end discs? */
function onEnvelope(f: R.Face, env: Envelope): boolean {
  const local = (p: { x: number; y: number; z: number }) => {
    const v: V3 = [p.x - env.at[0], p.y - env.at[1], p.z - env.at[2]];
    const ax = v[0] * env.dir[0] + v[1] * env.dir[1] + v[2] * env.dir[2];
    return { ax, rad: Math.hypot(v[0] - ax * env.dir[0], v[1] - ax * env.dir[1], v[2] - ax * env.dir[2]) };
  };
  const pts = f.edges.flatMap((e) => [e.startPoint, e.pointAt(0.5)].map(local));
  if (!pts.length) return false;
  const tol = 1e-5;
  if (f.geomType === "CYLINDRE") {
    const mid = local(f.pointOnSurface(0.5, 0.5));
    return Math.abs(mid.rad - env.rad) < tol && pts.every((p) => Math.abs(p.rad - env.rad) < tol);
  }
  if (f.geomType !== "PLANE") return false;
  const end = Math.abs(pts[0].ax) < tol ? 0 : Math.abs(pts[0].ax - env.len) < tol ? env.len : null;
  return end !== null && pts.every((p) => Math.abs(p.ax - end) < tol && p.rad < env.rad + tol);
}

/** One solid from pieces that touch along shared faces: their other faces sewn into a closed shell. */
function sewPieces(pieces: Shape3D[], shared: (f: R.Face) => boolean): Shape3D | null {
  const oc = R.getOC();
  const sew = new oc.BRepBuilderAPI_Sewing(1e-5, true, true, true, false);
  const fixer = new oc.ShapeFix_Solid();
  const faces: R.Face[] = [];
  try {
    for (const piece of pieces)
      for (const f of piece.faces) {
        if (shared(f)) f.delete();
        else faces.push(f);
      }
    for (const f of faces) sew.Add(f.wrapped);
    sew.Perform();
    const sewed = sew.SewedShape();
    if (sewed.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) return null;
    const solid = R.cast(fixer.SolidFromShell(oc.TopoDS.Shell(sewed)));
    if (!(solid instanceof R.Solid)) return null;
    const check = new oc.BRepCheck_Analyzer(solid.wrapped, true, false);
    const ok = check.IsValid();
    check.delete();
    return ok ? solid.simplify() : null;
  } finally {
    for (const f of faces) f.delete();
    sew.delete();
    fixer.delete();
  }
}

/**
 * Volume of a solid. OpenCASCADE's default integration is off by several percent on helical thread faces;
 * the adaptive (Gauss-Kronrod) one is accurate and about as fast.
 */
export function solidVolume(s: Shape3D): number {
  const oc = R.getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumePropertiesGK(s.wrapped, props, 1e-5, false, true, false, false, false);
    return props.Mass();
  } catch {
    return R.measureVolume(s);
  } finally {
    props.delete();
  }
}

/** Most edges one fillet or chamfer takes: a knurl's 720 ridge edges take over a minute. */
const MAX_ROUNDED_EDGES = 200;

/** Fillet, chamfer, draft and shell can return a solid that looks right but is broken (later booleans fail). */
function checked(s: Shape3D): Shape3D {
  if (!shapeValid(s)) throw new BuildError("it made an invalid solid");
  return s;
}

type ExtrudeRecipe = Extract<ShapeRecipe, { t: "extrude" }>;

/** An extrusion whose end the part's shape decides (until: "next"). */
function runsUntil(r: ShapeRecipe): r is ExtrudeRecipe {
  return r.t === "extrude" && !!r.until;
}

/**
 * The tool for an extrusion that runs up to the next face. Added: it grows from its plane until it meets the part
 * (the pieces of a long extrusion outside the part that start on the plane). Cut: it cuts from its plane through
 * the first wall it meets and stops where it comes out (the pieces of the extrusion inside the part that start on
 * the plane, or the nearest ones when the plane is off the part).
 */
function upToNext(body: Shape3D, r: ExtrudeRecipe, op: "add" | "cut" | "intersect"): Shape3D {
  if (op === "intersect") throw new BuildError('until: "next" works with add and cut, not intersect');
  // the way it runs: along the plane's normal, or against it for a negative h (the profile is never mirrored)
  const sign = r.h < 0 ? -1 : 1;
  const n = vscale(vnorm(r.f.n), sign);
  const [lo, hi] = body.boundingBox.bounds as [V3, V3];
  let ahead = -Infinity;
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) ahead = Math.max(ahead, vdot(vsub([x, y, z], r.f.o), n));
  if (!(ahead > 1e-6)) throw new BuildError('until: "next" found nothing ahead of the sketch plane: the part lies behind it. Turn the extrusion round (reverse: true) or give a depth.');
  const len = ahead + 1;
  const long = extrudeProfile(r.p, sign * len, r.f, r.twist, r.scale, r.taper ?? 0);
  const pieces = (op === "add" ? long.cut(body) : (long.intersect(body) as Shape3D)).solids;
  long.delete();
  const face = (at: number) => (R.drawRectangle(1e5, 1e5).sketchOnPlane(planeOf({ ...r.f, o: vadd(r.f.o, vscale(n, at)) })) as R.Sketch).face();
  const start = face(0);
  const gap = pieces.map((s) => R.measureDistanceBetween(s, start));
  start.delete();
  const touching = pieces.filter((_, i) => gap[i] < 1e-4);
  let keep = touching;
  if (op === "cut" && !keep.length && pieces.length) {
    const near = Math.min(...gap);
    keep = pieces.filter((_, i) => gap[i] < near + 1e-4);
  }
  if (!keep.length) {
    throw new BuildError(
      op === "add"
        ? 'until: "next" has nowhere to grow: the profile starts inside the part. Sketch on the face it should grow from, or turn it round (reverse: true).'
        : 'until: "next" cuts nothing: the profile never reaches the part.',
    );
  }
  if (op === "add") {
    const end = face(len);
    const runsOn = keep.some((s) => R.measureDistanceBetween(s, end) < 1e-4);
    end.delete();
    if (runsOn) throw new BuildError('until: "next" has nothing to stop at for some of the profile: it would run on past the part. Give a depth, or move the sketch so the part is in the way of all of it.');
  }
  let tool = keep[0];
  for (let i = 1; i < keep.length; i++) tool = tool.fuse(keep[i]);
  return tool;
}

/** A WebAssembly trap (out of memory, an abort): unlike an OpenCASCADE exception, the kernel cannot carry on. */
export function isTrap(e: unknown): boolean {
  return typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;
}

/** Readable text for anything a build throws. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "number") return `OpenCASCADE error ${e}`;
  // OpenCASCADE failures arrive as bare WebAssembly exceptions with no text
  if (typeof WebAssembly !== "undefined" && "Exception" in WebAssembly && e instanceof (WebAssembly as unknown as { Exception: new () => object }).Exception) return "OpenCASCADE could not compute it";
  return String(e);
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
  /** (first index, index count, face id) per B-rep face, for picking faces */
  faceGroups?: Int32Array;
  /** (first point, point count, edge id) per B-rep edge, for picking edges */
  edgeGroups?: Int32Array;
  /** per-vertex RGB, only for imported bodies whose faces have their own colours */
  colors?: Uint8Array;
}

type RawMesh = ReturnType<Shape3D["mesh"]>;

/** Signed volume and area of a triangle mesh. */
function meshMeasure(m: RawMesh): { volume: number; area: number } {
  const P = m.vertices;
  const I = m.triangles;
  let volume = 0;
  let area = 0;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return { volume, area };
}

/**
 * How far a mesh's volume is from the solid's, as a share of what the tessellation's chord error allows (the mesh
 * keeps within `tolerance` of every face, so it can gain or lose at most about its area times that). Over 1 means
 * the mesh is not the solid.
 */
function meshMiss(m: RawMesh, volume: number, tolerance: number): number {
  const s = meshMeasure(m);
  return Math.abs(Math.abs(s.volume) - volume) / (1.5 * s.area * tolerance + 1e-3 * volume + 0.01);
}

/**
 * Triangles for a solid. With the solid's volume, the mesh is checked against it: now and then the tessellator lays a
 * small face's triangles across far more than the face (a sliver beside a spline face, at one particular deflection),
 * which leaves an STL that is not the part, so it meshes finer until the volume agrees.
 */
export function meshShape(shape: Shape3D, quality: "preview" | "final", faceColors?: string[] | null, volume?: number, faceted = false): MeshData {
  const base = quality === "preview" ? { tolerance: 0.25, angularTolerance: 25 } : { tolerance: 0.03, angularTolerance: 10 };
  let opts = base;
  let m = shape.mesh(opts);
  if (volume && volume > 0) {
    let miss = meshMiss(m, volume, opts.tolerance);
    for (const k of [0.7, 0.5, 0.35]) {
      if (miss <= 1) break;
      // finer each time: the tessellator keeps a face's triangles when asked for a coarser mesh
      const finer = { ...base, tolerance: base.tolerance * k };
      const again = shape.mesh(finer);
      const missAgain = meshMiss(again, volume, finer.tolerance);
      // no better finer either (a body that is not closed, say): the mesh is as good as it gets
      if (missAgain > 0.9 * miss) break;
      m = again;
      miss = missAgain;
      opts = finer;
    }
  }
  const e = shape.meshEdges(opts);
  const out: MeshData = {
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    edges: new Float32Array(e.lines),
    faceGroups: new Int32Array(m.faceGroups.flatMap((g) => [g.start, g.count, g.faceId])),
    edgeGroups: new Int32Array(e.edgeGroups.flatMap((g) => [g.start, g.count, g.edgeId])),
  };
  if (faceColors?.length) out.colors = vertexColors(shape, m, faceColors);
  return faceted ? smoothFaceted(out) : out;
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
