// Imports STL, OBJ and 3MF meshes as solids. The file is read and repaired, each
// closed shell becomes a body, flat areas become single faces and the rest stays
// faceted, and the faces are put together in OpenCASCADE sharing their edges, so
// the bodies are real solids: measured, cut, fastened to and checked like any
// other. Big meshes are simplified first so the solids stay quick to work with.
// Runs in the kernel worker, and in Node for tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { IMPORT_META_VERSION, MAX_BODIES, type ImportBody, type ImportCylinder } from "./imports";
import { readMeshFile, type RawMesh } from "./meshRead";
import { meshBox, repairMesh, type MeshBody, type RepairReport } from "./meshRepair";
import { faceProps, meshCylinders, meshFaces, type FaceSet } from "./meshFaces";
import { simplifyMesh } from "./meshSimplify";
import type { LoadedStep } from "./stepImport";
import type { V3 } from "./recipe";

/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;

export { MeshReadError, MESH_EXTENSIONS, meshFormat } from "./meshRead";

/** Faces a whole file may turn into. More than this and the meshes are simplified first: solids with more faces are slow to build, show and check. */
export const MAX_MESH_FACES = 12_000;

/** Bodies up to this many faces are also checked by OpenCASCADE. */
const CHECK_FACES = 4000;

const oc = (): OC => R.getOC() as OC;

function del(...xs: unknown[]) {
  for (const x of xs) {
    try {
      (x as { delete?: () => void })?.delete?.();
    } catch {
      /* already freed */
    }
  }
}

interface Built {
  shape: Shape3D;
  kind: ImportBody["kind"];
  /** colour index per face, in the order the faces were added */
  colors: number[];
  faces: number;
  /** faces that could not be made (degenerate outlines) */
  failed: number;
}

/** Put a body's faces together in OpenCASCADE, sharing corners and edges, and close them into a solid when they are closed. */
function buildBody(set: FaceSet, shells: number, closed: boolean): Built | null {
  const o = oc();
  const P = set.positions;
  const nV = P.length / 3;
  const vtx = new Map<number, OC>();
  const edges = new Map<number, OC>();
  const trash: OC[] = [];
  const vertex = (i: number) => {
    let v = vtx.get(i);
    if (!v) {
      const p = new o.gp_Pnt(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      const mv = new o.BRepBuilderAPI_MakeVertex(p);
      v = mv.Vertex();
      del(p, mv);
      vtx.set(i, v);
    }
    return v;
  };
  const edge = (a: number, b: number): OC | null => {
    const lo = Math.min(a, b),
      hi = Math.max(a, b);
    const key = lo * nV + hi;
    let e = edges.get(key);
    if (!e) {
      const me = new o.BRepBuilderAPI_MakeEdge(vertex(lo), vertex(hi));
      if (!me.IsDone()) {
        del(me);
        return null;
      }
      e = me.Edge();
      del(me);
      edges.set(key, e);
    }
    if (a === lo) return e;
    const r = e.Reversed();
    const out = o.TopoDS.Edge(r);
    trash.push(r, out);
    return out;
  };
  const wire = (loop: number[]): OC | null => {
    const mw = new o.BRepBuilderAPI_MakeWire();
    try {
      for (let k = 0; k < loop.length; k++) {
        const e = edge(loop[k], loop[(k + 1) % loop.length]);
        if (!e) return null;
        mw.Add(e);
      }
      return mw.IsDone() ? mw.Wire() : null;
    } finally {
      del(mw);
    }
  };

  const builder = new o.TopoDS_Builder();
  const shellShapes: OC[] = [];
  for (let s = 0; s < shells; s++) {
    const sh = new o.TopoDS_Shell();
    builder.MakeShell(sh);
    shellShapes.push(sh);
  }
  const colors: number[] = [];
  let failed = 0;
  let made = 0;
  try {
    for (const f of set.faces) {
      const wires: OC[] = [];
      let face: OC = null;
      try {
        for (const loop of f.loops) {
          const w = wire(loop);
          if (!w) break;
          wires.push(w);
        }
        if (wires.length === f.loops.length) {
          const p = new o.gp_Pnt(f.n[0] * f.d, f.n[1] * f.d, f.n[2] * f.d);
          const dir = new o.gp_Dir(f.n[0], f.n[1], f.n[2]);
          const pln = new o.gp_Pln(p, dir);
          const mf = new o.BRepBuilderAPI_MakeFace(pln, wires[0], true);
          for (const h of wires.slice(1)) mf.Add(h);
          if (mf.IsDone()) face = mf.Face();
          del(p, dir, pln, mf);
        }
      } catch {
        face = null;
      } finally {
        del(...wires);
      }
      if (!face) {
        failed++;
        continue;
      }
      builder.Add(shellShapes[f.shell] ?? shellShapes[0], face);
      del(face);
      colors.push(f.color);
      made++;
    }
    if (!made) return null;
    for (const sh of shellShapes)
      try {
        sh.Closed(closed && !failed);
      } catch {
        /* the flag is a hint; checks look at the edges */
      }
    let shape: OC;
    let kind: ImportBody["kind"] = "shell";
    if (closed && !failed) {
      const solid = new o.TopoDS_Solid();
      builder.MakeSolid(solid);
      for (const sh of shellShapes) builder.Add(solid, sh);
      shape = solid;
      kind = "solid";
    } else if (shellShapes.length === 1) {
      shape = shellShapes[0];
      shellShapes.length = 0;
    } else {
      const comp = new o.TopoDS_Compound();
      builder.MakeCompound(comp);
      for (const sh of shellShapes) builder.Add(comp, sh);
      shape = comp;
    }
    return { shape: R.cast(shape) as unknown as Shape3D, kind, colors, faces: made, failed };
  } finally {
    del(builder);
    for (const x of trash) del(x);
    for (const x of vtx.values()) del(x);
    for (const x of edges.values()) del(x);
    if (shellShapes.length && closed && !failed) for (const x of shellShapes) del(x);
  }
}

/** Whether OpenCASCADE finds the solid sound: closed, every edge shared right, faces on their planes. */
function sound(shape: Shape3D): boolean {
  const o = oc();
  const check = new o.BRepCheck_Analyzer(shape.wrapped, true, false);
  try {
    return !!check.IsValid();
  } finally {
    del(check);
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What repair did, in a line a person can read. Empty when the mesh was already sound. */
export function repairSummary(r: RepairReport): string {
  const bits: string[] = [];
  if (r.flipped) bits.push(`turned ${plural(r.flipped, "triangle")} to face out`);
  if (r.insideOut) bits.push(`turned ${plural(r.insideOut, "inside-out shell")} the right way`);
  if (r.holes) bits.push(`closed ${plural(r.holes, "gap")} in the surface`);
  if (r.duplicates) bits.push(`removed ${plural(r.duplicates, "doubled triangle")}`);
  if (r.degenerate) bits.push(`removed ${plural(r.degenerate, "flat sliver")}`);
  if (!bits.length) return "";
  const s = bits.join(", ");
  return `Repaired the mesh: ${s}.`;
}

function addReport(a: RepairReport, b: RepairReport) {
  for (const k of Object.keys(a) as (keyof RepairReport)[]) a[k] += b[k];
}

/**
 * Read a mesh file into solids. With `analyse` false the holes are not looked
 * for (the analysis is already stored); the bodies come out the same either way.
 */
export async function readMesh(data: Uint8Array, file: string, opts: { analyse: boolean; hash?: string } = { analyse: true }): Promise<LoadedStep> {
  const t0 = performance.now();
  const mf = await readMeshFile(data, file);
  const warnings = [...mf.warnings];

  // STL and OBJ files have no units: millimetres, unless the part would be smaller than a millimetre
  if (mf.unit === null) {
    let size = 0;
    for (const m of mf.meshes) {
      const [lo, hi] = meshBox(m.positions);
      size = Math.max(size, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    }
    if (size > 0 && size < 1) {
      for (const m of mf.meshes) for (let i = 0; i < m.positions.length; i++) m.positions[i] *= 1000;
      warnings.push(`The file has no units and is only ${size.toPrecision(2)} across, so Kerf read it in metres (${(size * 1000).toPrecision(3)} mm). STL and OBJ files from Blender are often in metres.`);
    }
  }

  // repair each object and split it into bodies
  const report: RepairReport = { trianglesIn: 0, welded: 0, degenerate: 0, duplicates: 0, flipped: 0, holes: 0, holeEdges: 0, openEdges: 0, nonManifold: 0, insideOut: 0, voids: 0 };
  let parts: { name: string; mesh: RawMesh; body: MeshBody }[] = [];
  for (const m of mf.meshes) {
    const r = repairMesh(m);
    addReport(report, r.report);
    r.bodies.forEach((b, i) => parts.push({ name: r.bodies.length > 1 ? `${m.name} ${i + 1}` : m.name, mesh: m, body: b }));
  }
  if (!parts.length) throw new Error("The mesh has no triangles Kerf could use.");
  if (parts.length > MAX_BODIES) {
    warnings.push(`The file has ${parts.length} separate pieces; the smallest ${parts.length - MAX_BODIES} are left out.`);
    parts = parts.slice(0, MAX_BODIES);
  }

  // faces: flat areas merged; simplify when the file would make too many
  const [lo0, hi0] = boxOf(parts.map((p) => p.body));
  const diag = Math.hypot(hi0[0] - lo0[0], hi0[1] - lo0[1], hi0[2] - lo0[2]) || 1;
  const tol = Math.min(0.01, Math.max(2e-4, diag * 2e-6));
  let sets = parts.map((p) => meshFaces(p.body, tol));
  const triangles0 = parts.reduce((n, p) => n + p.body.triangles.length / 3, 0);
  for (let round = 0; round < 3; round++) {
    const total = sets.reduce((n, s) => n + s.faces.length, 0);
    if (total <= MAX_MESH_FACES) break;
    const keep = (MAX_MESH_FACES / total) * 0.92;
    parts = parts.map((p, i) => {
      const tris = p.body.triangles.length / 3;
      const want = Math.max(64, Math.floor(tris * keep));
      if (sets[i].faces.length < 400 || want >= tris) return p;
      return { ...p, body: simplifyMesh(p.body, want) };
    });
    sets = parts.map((p) => meshFaces(p.body, tol));
  }
  const triangles1 = parts.reduce((n, p) => n + p.body.triangles.length / 3, 0);
  if (triangles1 < triangles0 * 0.98) warnings.push(`The mesh has ${triangles0.toLocaleString("en")} triangles; Kerf simplified it to ${triangles1.toLocaleString("en")} so the solid stays quick to work with.`);

  const bodies: Shape3D[] = [];
  const faceColors: (string[] | null)[] = [];
  const metaBodies: ImportBody[] = [];
  const cyl: ImportCylinder[] = [];
  let openBodies = 0;
  let unsound = 0;
  for (const [i, p] of parts.entries()) {
    const set = sets[i];
    let built = buildBody(set, p.body.shellStarts.length, p.body.closed);
    // the faces are put together so that the solid is sound by construction; OpenCASCADE's own check is slow, so it
    // only looks over the smaller bodies, where a fault would show most
    if (built && built.kind === "solid" && built.faces <= CHECK_FACES && !sound(built.shape)) {
      // a solid OpenCASCADE finds unsound still shows and measures, but cuts and checks would fail on it: keep its surface
      built.shape.delete();
      built = buildBody(set, p.body.shellStarts.length, false);
      unsound++;
    }
    if (!built) continue;
    if (built.kind !== "solid") openBodies++;
    const shape = built.shape;
    // the solid is exactly the flat faces, so its size, volume and centre come straight from the triangles
    const box = meshBox(set.positions);
    const m = faceProps(set.positions, p.body.triangles);
    // colours: the object's, or per face when the faces differ
    const pal = p.mesh.palette ?? [];
    const used = new Set(built.colors.filter((c) => c >= 0));
    let color = p.mesh.color;
    if (used.size > 1) faceColors.push(built.colors.map((c) => pal[c] ?? color ?? "#9aa3ad"));
    else {
      faceColors.push(null);
      if (used.size === 1) color = pal[[...used][0]] ?? color;
    }
    const index = bodies.length;
    bodies.push(shape);
    metaBodies.push({
      name: p.name,
      product: p.mesh.name,
      kind: built.kind,
      color,
      faceColors: used.size > 1 ? true : undefined,
      volume: built.kind === "solid" ? m.volume : 0,
      area: m.area,
      faces: built.faces,
      bbox: box,
      center: built.kind === "solid" && m.volume > 0 ? m.center : m.areaCenter,
    });
    if (opts.analyse && cyl.length < 4000) cyl.push(...meshCylinders(set, index, Math.min(1500, 4000 - cyl.length)));
  }
  if (!bodies.length) throw new Error("Kerf could not make any faces from this mesh.");

  const fixed = repairSummary(report);
  if (fixed) warnings.push(fixed);
  if (openBodies) warnings.push(`${plural(openBodies, "piece")} could not be closed into a solid (open edges${report.nonManifold ? " or edges shared by more than two triangles" : ""}). It is shown and measured, but not checked for interference.`);
  if (unsound) warnings.push(`${plural(unsound, "piece")} closed but OpenCASCADE found ${unsound === 1 ? "it" : "them"} unsound, so ${unsound === 1 ? "it is" : "they are"} kept as a surface.`);
  if (report.voids) warnings.push(`${plural(report.voids, "hollow")} inside ${report.voids === 1 ? "a piece is" : "pieces are"} kept as ${report.voids === 1 ? "a cavity" : "cavities"}.`);

  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of metaBodies)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], b.bbox[0][k]);
      hi[k] = Math.max(hi[k], b.bbox[1][k]);
    }
  return {
    bodies,
    faceColors,
    meta: {
      version: IMPORT_META_VERSION,
      file,
      bytes: data.byteLength,
      title: mf.title,
      bodies: metaBodies,
      cylinders: cyl,
      bbox: [lo, hi],
      warnings,
      ms: performance.now() - t0,
    },
  };
}

function boxOf(bodies: MeshBody[]): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    const [l, h] = meshBox(b.positions);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], l[k]);
      hi[k] = Math.max(hi[k], h[k]);
    }
  }
  return [lo, hi];
}
