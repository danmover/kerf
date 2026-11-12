// Reads STEP files into solids with OpenCASCADE, then works out what a
// designer needs from them: one body per solid with its name and colour,
// sizes, and the holes and pins that parts get aligned to.
// Runs in the kernel worker, and in Node for tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { IMPORT_META_VERSION, MAX_BODIES, type ImportBody, type ImportCylinder, type ImportMeta } from "./imports";
import { cleanName, stepStructure, type StepStructure } from "./stepText";
import type { V3 } from "./recipe";

/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;

export class StepReadError extends Error {}

export { MAX_BODIES };

export interface LoadedStep {
  bodies: Shape3D[];
  /** per body, the colour of each face in explorer order (null when the body has one colour) */
  faceColors: (string[] | null)[];
  meta: ImportMeta;
}

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

function isStepText(head: string) {
  return /ISO-10303-21\s*;/.test(head);
}

function props(shape: unknown, kind: "volume" | "area") {
  const o = oc();
  const p = new o.GProp_GProps();
  try {
    if (kind === "volume") o.BRepGProp.VolumeProperties(shape, p, false, false, false);
    else o.BRepGProp.SurfaceProperties(shape, p, false, false);
    const c = p.CentreOfMass();
    const out = { mass: p.Mass() as number, center: [c.X(), c.Y(), c.Z()] as V3 };
    del(c);
    return out;
  } finally {
    del(p);
  }
}

function countFaces(shape: unknown): number {
  const o = oc();
  const ex = new o.TopExp_Explorer(shape, o.TopAbs_ShapeEnum.TopAbs_FACE, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  for (; ex.More(); ex.Next()) n++;
  del(ex);
  return n;
}

function faceList(shape: unknown): unknown[] {
  const o = oc();
  const out: unknown[] = [];
  const ex = new o.TopExp_Explorer(shape, o.TopAbs_ShapeEnum.TopAbs_FACE, o.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) out.push(o.TopoDS.Face(ex.Current()));
  del(ex);
  return out;
}

interface Fingerprint {
  faces: number;
  volume: number;
  area: number;
}

/** Shape properties that do not change when the shape is moved: used to match placed solids to file entities. */
function fingerprint(shape: unknown, solid: boolean): Fingerprint {
  return { faces: countFaces(shape), volume: solid ? props(shape, "volume").mass : 0, area: props(shape, "area").mass };
}

const fpKey = (f: Fingerprint) => `${f.faces}|${f.volume.toPrecision(7)}|${f.area.toPrecision(7)}`;

function bbox(shape: Shape3D): [V3, V3] {
  const [a, b] = shape.boundingBox.bounds;
  return [
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
  ];
}

/** Split what the reader produced into bodies: solids, then shells outside solids, then loose faces. */
function explode(shape: unknown): { raw: unknown; kind: ImportBody["kind"] }[] {
  const o = oc();
  const T = o.TopAbs_ShapeEnum;
  const out: { raw: unknown; kind: ImportBody["kind"] }[] = [];
  const ex = new o.TopExp_Explorer(shape, T.TopAbs_SOLID, T.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) out.push({ raw: o.TopoDS.Solid(ex.Current()), kind: "solid" });
  del(ex);
  const sh = new o.TopExp_Explorer(shape, T.TopAbs_SHELL, T.TopAbs_SOLID);
  for (; sh.More(); sh.Next()) out.push({ raw: o.TopoDS.Shell(sh.Current()), kind: "shell" });
  del(sh);
  const fx = new o.TopExp_Explorer(shape, T.TopAbs_FACE, T.TopAbs_SHELL);
  const loose: unknown[] = [];
  for (; fx.More(); fx.Next()) loose.push(fx.Current());
  del(fx);
  if (loose.length) {
    const builder = new o.TopoDS_Builder();
    const comp = new o.TopoDS_Compound();
    builder.MakeCompound(comp);
    for (const f of loose) builder.Add(comp, f);
    del(builder);
    out.push({ raw: comp, kind: "faces" });
  }
  return out;
}

function mergeExtra(list: { raw: unknown; kind: ImportBody["kind"] }[]) {
  if (list.length <= MAX_BODIES) return list;
  const o = oc();
  const keep = list.slice(0, MAX_BODIES - 1);
  const builder = new o.TopoDS_Builder();
  const comp = new o.TopoDS_Compound();
  builder.MakeCompound(comp);
  for (const b of list.slice(MAX_BODIES - 1)) builder.Add(comp, b.raw);
  del(builder);
  keep.push({ raw: comp, kind: "faces" });
  return keep;
}

/** Cylindrical faces of a body, merged per cylinder, classified as holes or pins. */
function cylinders(raw: unknown, body: number, limit: number): ImportCylinder[] {
  const o = oc();
  const found: { axisP: V3; dir: V3; r: number; hole: boolean; sweep: number; vmin: number; vmax: number }[] = [];
  for (const f of faceList(raw)) {
    if (found.length >= limit) break;
    let ad: OC;
    try {
      ad = new o.BRepAdaptor_Surface(f, true);
      if (ad.GetType() !== o.GeomAbs_SurfaceType.GeomAbs_Cylinder) continue;
      const cyl = ad.Cylinder();
      const ax = cyl.Axis();
      const loc = ax.Location();
      const d = ax.Direction();
      const r = cyl.Radius() as number;
      const P: V3 = [loc.X(), loc.Y(), loc.Z()];
      const D: V3 = [d.X(), d.Y(), d.Z()];
      del(cyl, ax, loc, d);
      const uv = o.BRepTools.UVBounds(f, 0, 0, 0, 0);
      const u0 = uv.UMin as number;
      const u1 = uv.UMax as number;
      // outward normal in the middle of the face: a hole's surface faces its own axis
      const pt = new o.gp_Pnt();
      const n = new o.gp_Vec();
      const gf = new o.BRepGProp_Face(f, false);
      gf.Normal((u0 + u1) / 2, (uv.VMin + uv.VMax) / 2, pt, n);
      const X: V3 = [pt.X(), pt.Y(), pt.Z()];
      const N: V3 = [n.X(), n.Y(), n.Z()];
      del(pt, n, gf);
      const rel: V3 = [X[0] - P[0], X[1] - P[1], X[2] - P[2]];
      const along = rel[0] * D[0] + rel[1] * D[1] + rel[2] * D[2];
      const radial: V3 = [rel[0] - D[0] * along, rel[1] - D[1] * along, rel[2] - D[2] * along];
      const hole = radial[0] * N[0] + radial[1] * N[1] + radial[2] * N[2] < 0;
      found.push({ axisP: P, dir: D, r, hole, sweep: Math.min(1, Math.abs(u1 - u0) / (2 * Math.PI)), vmin: uv.VMin, vmax: uv.VMax });
    } catch {
      /* a face the adaptor cannot read is skipped */
    } finally {
      del(ad);
    }
  }
  // faces of one cylinder (CAD systems often split a hole into two halves) are merged
  const merged: { base: V3; dir: V3; r: number; hole: boolean; sweep: number; lo: number; hi: number }[] = [];
  for (const c of found) {
    // put the axis in a canonical direction so halves agree
    const flip = c.dir[2] < -1e-9 || (Math.abs(c.dir[2]) <= 1e-9 && (c.dir[1] < -1e-9 || (Math.abs(c.dir[1]) <= 1e-9 && c.dir[0] < 0)));
    const dir: V3 = flip ? [-c.dir[0], -c.dir[1], -c.dir[2]] : c.dir;
    let lo = flip ? -c.vmax : c.vmin;
    let hi = flip ? -c.vmin : c.vmax;
    // project the axis point so the parameter is measured from the axis' closest point to the origin
    const t0 = c.axisP[0] * dir[0] + c.axisP[1] * dir[1] + c.axisP[2] * dir[2];
    const base: V3 = [c.axisP[0] - dir[0] * t0, c.axisP[1] - dir[1] * t0, c.axisP[2] - dir[2] * t0];
    lo += t0;
    hi += t0;
    const same = merged.find(
      (m) => m.hole === c.hole && Math.abs(m.r - c.r) < 1e-4 && Math.abs(m.dir[0] * dir[0] + m.dir[1] * dir[1] + m.dir[2] * dir[2]) > 0.99999 && Math.hypot(m.base[0] - base[0], m.base[1] - base[1], m.base[2] - base[2]) < 1e-3 && lo <= m.hi + 1e-3 && hi >= m.lo - 1e-3,
    );
    if (same) {
      same.sweep = Math.min(1, same.sweep + c.sweep);
      same.lo = Math.min(same.lo, lo);
      same.hi = Math.max(same.hi, hi);
    } else merged.push({ base, dir, r: c.r, hole: c.hole, sweep: c.sweep, lo, hi });
  }
  return merged.map((m) => ({
    body,
    d: m.r * 2,
    hole: m.hole,
    start: [m.base[0] + m.dir[0] * m.lo, m.base[1] + m.dir[1] * m.lo, m.base[2] + m.dir[2] * m.lo],
    end: [m.base[0] + m.dir[0] * m.hi, m.base[1] + m.dir[1] * m.hi, m.base[2] + m.dir[2] * m.hi],
    sweep: m.sweep,
  }));
}

/** Transfer each solid entity on its own to fingerprint it, so placed solids can be traced back to the file's names and colours. */
function entityFingerprints(reader: OC, ids: number[], budgetMs: number): Map<number, string> {
  const o = oc();
  const model = reader.StepModel();
  const out = new Map<number, string>();
  const t0 = performance.now();
  // entity numbers usually equal the file's #ids; build the map only when they do not
  let byLabel: Map<number, number> | null = null;
  const entityFor = (id: number) => {
    if (!byLabel) {
      if (id <= model.NbEntities()) {
        const e = model.Value(id);
        if (model.IdentLabel(e) === id) return e;
      }
      byLabel = new Map();
      const n = model.NbEntities();
      for (let k = 1; k <= n; k++) byLabel.set(model.IdentLabel(model.Value(k)), k);
    }
    const k = byLabel.get(id);
    return k ? model.Value(k) : null;
  };
  for (const id of ids) {
    if (performance.now() - t0 > budgetMs) break;
    try {
      const ent = entityFor(id);
      if (!ent) continue;
      reader.ClearShapes();
      const progress = new o.Message_ProgressRange();
      const ok = reader.TransferEntity(ent, progress);
      del(progress);
      if (!ok || reader.NbShapes() < 1) continue;
      const s = reader.Shape(1);
      if (s.IsNull()) continue;
      const solid = s.ShapeType() === o.TopAbs_ShapeEnum.TopAbs_SOLID;
      out.set(id, fpKey(fingerprint(s, solid)));
      del(s);
    } catch {
      /* this entity cannot be transferred alone; its body keeps a generic name */
    }
  }
  reader.ClearShapes();
  return out;
}

function stem(file: string) {
  return file.replace(/\.(step|stp|p21)$/i, "") || file;
}

/**
 * Read a STEP file. With `analyse` false only the geometry is loaded (for a
 * file whose analysis is already stored); the body order is the same either way.
 */
export function readStep(data: Uint8Array, file: string, opts: { analyse: boolean; hash?: string } = { analyse: true }): LoadedStep {
  const t0 = performance.now();
  const o = oc();
  const head = new TextDecoder("latin1").decode(data.subarray(0, 2048));
  if (!isStepText(head)) throw new StepReadError("This is not a STEP file. Kerf imports STEP files (.step or .stp) exported from CAD tools.");
  const path = `/import-${opts.hash ?? Math.random().toString(36).slice(2)}.step`;
  o.FS.writeFile(path, data);
  const reader = new o.STEPControl_Reader();
  const warnings: string[] = [];
  try {
    o.Interface_Static.SetCVal("xstep.cascade.unit", "MM");
    const status = reader.ReadFile(path);
    if (status !== o.IFSelect_ReturnStatus.IFSelect_RetDone) throw new StepReadError("OpenCASCADE could not read this STEP file. It may be damaged, or use a STEP variant Kerf does not support.");
    const progress = new o.Message_ProgressRange();
    const n = reader.TransferRoots(progress);
    del(progress);
    if (!n) throw new StepReadError("This STEP file has no 3D geometry Kerf can use (no solids or surfaces).");
    const whole = reader.OneShape();
    if (whole.IsNull()) throw new StepReadError("This STEP file has no 3D geometry Kerf can use (no solids or surfaces).");

    let parts = explode(whole);
    if (!parts.length) throw new StepReadError("This STEP file has no 3D geometry Kerf can use (no solids or surfaces).");
    if (parts.length > MAX_BODIES) warnings.push(`The file has ${parts.length} bodies; the last ${parts.length - MAX_BODIES + 1} are combined into one.`);
    parts = mergeExtra(parts);
    const bodies = parts.map((p) => R.cast(p.raw as never) as unknown as Shape3D);

    const faceColors: (string[] | null)[] = bodies.map(() => null);
    const metaBodies: ImportBody[] = [];
    const cyl: ImportCylinder[] = [];
    let structure: StepStructure | null = null;
    let entityOf: (number | undefined)[] = [];
    let paths: (string[] | undefined)[] = [];

    // names and colours come from the file text, matched to bodies by shape
    try {
      const text = new TextDecoder("latin1").decode(data);
      structure = stepStructure(text);
    } catch {
      warnings.push("Body names and colours could not be read from this file.");
    }
    const prints = parts.map((p) => fingerprint(p.raw, p.kind === "solid"));
    if (structure && structure.solids.size) {
      const fps = entityFingerprints(reader, [...structure.solids.keys()], opts.analyse ? 20_000 : 40_000);
      const byKey = new Map<string, number[]>();
      for (const [id, k] of fps) byKey.set(k, [...(byKey.get(k) ?? []), id]);
      const keys = prints.map(fpKey);
      // the assembly order in the file usually matches the order OpenCASCADE produces; use it when every body agrees
      const inst = structure.instances;
      const solidCount = parts.filter((p) => p.kind === "solid").length;
      const ordered = inst.length === solidCount && inst.every((it, i) => parts[i].kind === "solid" && byKey.get(keys[i])?.includes(it.solid));
      entityOf = parts.map((p, i) => (p.kind !== "solid" ? undefined : ordered ? inst[i].solid : byKey.get(keys[i])?.[0]));
      paths = parts.map((_, i) => (ordered ? inst[i].path : undefined));
      if (entityOf.some((e, i) => e === undefined && parts[i].kind === "solid")) warnings.push("Some bodies could not be matched to names in the file and are numbered instead.");
    }

    const fileTitle = structure?.rootName || "";
    const productCount = new Map<string, number>();
    parts.forEach((p, i) => {
      const shape = bodies[i];
      const box = bbox(shape);
      const vol = p.kind === "solid" ? props(p.raw, "volume") : null;
      const area = props(p.raw, "area");
      const eid = entityOf[i];
      const info = eid !== undefined ? structure?.solids.get(eid) : undefined;
      const path = (paths[i] ?? []).map((x) => cleanName(x)).filter(Boolean);
      let name = "";
      if (path.length) name = path.join(" › ");
      else if (info?.product && info.product !== fileTitle) name = info.product;
      if (info && info.siblings > 1) {
        const k = (productCount.get(`${name}|${info.product}`) ?? 0) + 1;
        productCount.set(`${name}|${info.product}`, k);
        const own = info.name && info.name !== info.product ? info.name : `body ${k}`;
        name = name ? `${name} › ${own}` : own;
      }
      if (!name) name = info?.name || (p.kind === "faces" ? "Surfaces" : parts.length === 1 ? cleanName(fileTitle || stem(file)) : `Body ${i + 1}`);

      // colours: a body colour, or per-face colours when the faces disagree
      let color = info?.color;
      if (info && structure && info.faces.length && info.faces.length === prints[i].faces) {
        const fc = info.faces.map((f) => structure!.faceColors.get(f) ?? info.color ?? "");
        const counts = new Map<string, number>();
        for (const c of fc) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
        if (counts.size) {
          const top = [...counts].sort((a, b) => b[1] - a[1])[0][0];
          color = color ?? top;
          if (counts.size > 1 || fc.some((c) => !c)) faceColors[i] = fc.map((c) => c || color || "#9aa3ad");
        }
      }
      metaBodies.push({
        name: cleanName(name, 120),
        product: cleanName(info?.product ?? ""),
        kind: p.kind,
        color,
        faceColors: faceColors[i] ? true : undefined,
        volume: vol?.mass ?? 0,
        area: area.mass,
        faces: prints[i].faces,
        bbox: box,
        center: vol?.center ?? area.center,
      });
      if (opts.analyse && cyl.length < 4000) cyl.push(...cylinders(p.raw, i, Math.min(1500, 4000 - cyl.length)));
    });

    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of metaBodies)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], b.bbox[0][k]);
        hi[k] = Math.max(hi[k], b.bbox[1][k]);
      }
    if (parts.some((p) => p.kind !== "solid")) warnings.push("Some geometry is surfaces rather than closed solids. It is shown and measured, but not checked for interference.");
    del(whole);
    return {
      bodies,
      faceColors,
      meta: {
        version: IMPORT_META_VERSION,
        file,
        bytes: data.byteLength,
        title: cleanName(fileTitle),
        bodies: metaBodies,
        cylinders: cyl,
        bbox: [lo, hi],
        warnings,
        ms: performance.now() - t0,
      },
    };
  } finally {
    del(reader);
    try {
      o.FS.unlink(path);
    } catch {
      /* already removed */
    }
  }
}
