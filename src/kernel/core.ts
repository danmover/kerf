// Kernel core: content-addressed solid cache, meshing and assembly checks.
// Environment-agnostic so it runs in the worker and in Node tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { applyXf, bboxOf, buildPartFull, importFaceColors, meshShape, solidVolume, type MeshData } from "./build";
import { applyXforms, hasDetail, recipeHash, stableStringify, vadd, vscale, type V3, type Xform } from "./recipe";
import type { BuildItem, ChecksRequest, ChecksResult, ExportItem, InspectRequest, InspectResult, Interference, PlacedItem } from "./protocol";
import { inspectPart as inspectForReview, solidPieces, type PartInspection } from "./inspect";
import { inspectShape } from "./selectInspect";
import { geoKey, type GeoQuery } from "../lang/values";
import { ProcessAnalyzer } from "../mfg/analyzer";
import type { ProcessProbe, ProcessResult } from "../mfg/types";
import type { FeatureTools } from "./topology";
import { faceCatalogue } from "./faces";
import type { FaceCatalogue } from "../core/mates";
import { CONTACT_GAP, apart, closedSurface, placeSurface, touching, type PlacedSurface, type Touch } from "./apart";

interface CacheEntry {
  shape: Shape3D;
  volume: number;
  bbox: [V3, V3];
  meshes: Partial<Record<"preview" | "final", MeshData>>;
  inspection?: PartInspection;
  /** its flat and round faces, for mates */
  faces?: FaceCatalogue;
  /** the separate solids it is made of, worked out on the first check that needs them */
  pieces?: PartInspection["pieces"] | null;
  /** colours of each face, for imported bodies that carry them */
  faceColors: string[] | null;
  used: number;
  features: Map<string, FeatureTools>;
  /** cosmetic steps that could not be built */
  warnings: string[];
}

/** A solid placed in the world for the checks. */
interface World {
  item: PlacedItem;
  shape: Shape3D;
  bbox: [V3, V3];
  volume: number;
  /** the placed-solid cache key: geometry hash and placement */
  key: string;
}

/** How much two placed solids overlap; the centre and mesh only when it counts as an interference. */
interface PairResult {
  volume: number;
  center?: V3;
  mesh?: MeshData;
}

export interface MeasureResult {
  distance: number;
  /** closest points on each side (equal when the shapes touch or overlap) */
  a: V3;
  b: V3;
}

export class KernelCore {
  /** fast builds: what checks, measurements and previews use */
  private cache = new Map<string, CacheEntry>();
  /** detailed builds (threads, knurls, cosmetic steps) for final meshes and STEP export */
  private detailCache = new Map<string, CacheEntry>();
  private placedCache = new Map<string, { shape: Shape3D; bbox: [V3, V3]; used: number; key: string }>();
  /** overlaps of placed pairs, kept across checks so an edit re-tests only the pairs it moved or changed */
  private pairs = new Map<string, PairResult>();
  /** whether two placed solids touch, by the same pair key */
  private touches = new Map<string, Touch | null>();
  private tick = 0;
  private processes = new ProcessAnalyzer();
  maxEntries = 400;

  has(hash: string) {
    return this.cache.has(hash);
  }

  get(hash: string): CacheEntry | undefined {
    const e = this.cache.get(hash);
    if (e) e.used = ++this.tick;
    return e;
  }

  /** Build a part. Final quality builds the detailed version when the recipe has detail. */
  build(item: BuildItem, quality: "preview" | "final" = "preview"): CacheEntry {
    if (quality === "final" && hasDetail(item.recipe)) {
      const hit = this.detailCache.get(item.hash);
      if (hit) {
        hit.used = ++this.tick;
        return hit;
      }
      const entry = this.make(item, true);
      this.detailCache.set(item.hash, entry);
      this.trim();
      return entry;
    }
    const hit = this.get(item.hash);
    if (hit) return hit;
    const entry = this.make(item, false);
    this.cache.set(item.hash, entry);
    this.trim();
    return entry;
  }

  private make(item: BuildItem, detail: boolean): CacheEntry {
    const { shape, warnings, features } = buildPartFull(item.recipe, { detail });
    let volume = 0;
    try {
      volume = solidVolume(shape);
    } catch {
      volume = 0;
    }
    return { shape, volume, bbox: bboxOf(shape), meshes: {}, faceColors: importFaceColors(item.recipe), used: ++this.tick, features, warnings };
  }

  mesh(hash: string, quality: "preview" | "final"): MeshData {
    const e = (quality === "final" ? this.detailCache.get(hash) : undefined) ?? this.get(hash);
    if (!e) throw new Error("not built");
    if (!e.meshes[quality]) e.meshes[quality] = meshShape(e.shape, quality, e.faceColors, e.volume);
    return e.meshes[quality]!;
  }

  /** Inspect built parts for detail review; results are cached with the solid. */
  inspect(hashes: string[]): Record<string, PartInspection | { error: string }> {
    const out: Record<string, PartInspection | { error: string }> = {};
    for (const h of hashes) {
      const e = this.get(h);
      if (!e) {
        out[h] = { error: "not built" };
        continue;
      }
      try {
        e.inspection ??= inspectForReview(e.shape, e.meshes.final ?? e.meshes.preview ?? this.mesh(h, "preview"));
        out[h] = e.inspection;
      } catch (err) {
        out[h] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return out;
  }

  /** Each built part's flat and round faces in its own coordinates, for mates; cached with the solid. */
  faces(hashes: string[]): Record<string, FaceCatalogue | { error: string }> {
    const out: Record<string, FaceCatalogue | { error: string }> = {};
    for (const h of hashes) {
      const e = this.get(h);
      if (!e) {
        out[h] = { error: "not built" };
        continue;
      }
      try {
        e.faces ??= faceCatalogue(e.shape);
        out[h] = e.faces;
      } catch (err) {
        out[h] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return out;
  }

  /** Describe a built part for inspect_part: named features, sharp edges, and what a selector picks. */
  inspectPart(req: InspectRequest): InspectResult {
    const e = this.build({ hash: req.hash, recipe: req.recipe, label: req.label });
    return inspectShape(e.shape, e.features, req, e.volume);
  }

  evict(keep: string[]) {
    const k = new Set(keep);
    this.processes.evict(k);
    for (const [h, e] of this.cache) {
      if (!k.has(h)) {
        safeDelete(e.shape);
        this.cache.delete(h);
      }
    }
    for (const [h, e] of this.detailCache) {
      if (!k.has(h)) {
        safeDelete(e.shape);
        this.detailCache.delete(h);
      }
    }
    for (const [key, p] of this.placedCache) {
      if (!k.has(key.split("|")[0])) {
        safeDelete(p.shape);
        this.placedCache.delete(key);
      }
    }
    for (const key of this.pairs.keys()) if (key.split("#").some((pk) => !k.has(pk.split("|")[0]))) this.pairs.delete(key);
  }

  private trim() {
    for (const map of [this.cache, this.detailCache]) {
      if (map.size <= this.maxEntries) continue;
      const sorted = [...map.entries()].sort((a, b) => a[1].used - b[1].used);
      for (const [h, e] of sorted.slice(0, map.size - this.maxEntries)) {
        safeDelete(e.shape);
        map.delete(h);
      }
    }
  }

  placed(p: { hash: string; xf: Xform[] }) {
    const key = p.hash + "|" + recipeHash(p.xf);
    const hit = this.placedCache.get(key);
    if (hit) {
      hit.used = ++this.tick;
      return hit;
    }
    const e = this.get(p.hash);
    if (!e) throw new Error("not built: " + p.hash);
    const shape = applyXf(e.shape.clone(), p.xf);
    const entry = { shape, bbox: worldBox(e.bbox, p.xf), used: ++this.tick, key };
    this.placedCache.set(key, entry);
    if (this.placedCache.size > 1200) {
      const sorted = [...this.placedCache.entries()].sort((a, b) => a[1].used - b[1].used);
      for (const [k, v] of sorted.slice(0, 300)) {
        safeDelete(v.shape);
        this.placedCache.delete(k);
      }
    }
    return entry;
  }

  checks(req: ChecksRequest): ChecksResult {
    const t0 = performance.now();
    const placed = req.placed.filter((p) => this.cache.has(p.hash));
    const world = new Map<string, World>();
    for (const p of placed) {
      const w = this.placed(p);
      world.set(p.id, { item: p, shape: w.shape, bbox: w.bbox, volume: this.cache.get(p.hash)!.volume, key: w.key });
    }
    const ignore = new Set(req.ignorePairs.map(([a, b]) => pairKey(a, b)));
    const interferences: Interference[] = [];
    let pairsTested = 0;
    const list = [...world.values()];
    // each part's closed surface mesh, placed, made when a pair first needs it
    const surfaces = new Map<string, PlacedSurface | null>();
    const surfaceOf = (w: World) => {
      let s = surfaces.get(w.item.id);
      if (s === undefined) {
        try {
          const closed = closedSurface(this.mesh(w.item.hash, "preview"));
          s = closed && placeSurface(closed, w.item.xf);
        } catch {
          s = null;
        }
        surfaces.set(w.item.id, s);
      }
      return s;
    };
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (!boxesOverlap(A.bbox, B.bbox, -0.01)) continue;
        if (ignore.has(pairKey(A.item.id, B.item.id))) continue;
        if (A.item.noInterference || B.item.noInterference) continue;
        // parts of the same multi-solid component never interfere with themselves
        if (A.item.id.split(".")[0] === B.item.id.split(".")[0]) continue;
        pairsTested++;
        const threshold = Math.max(0.5, 1e-4 * Math.min(A.volume || 1, B.volume || 1));
        const key = A.key < B.key ? `${A.key}#${B.key}` : `${B.key}#${A.key}`;
        const r = this.pairs.get(key) ?? this.overlap(A, B, threshold, surfaceOf);
        // most recently used last, so trimming drops the pairs of old edits first
        this.pairs.delete(key);
        this.pairs.set(key, r);
        // a copy of the mesh: the worker hands it over to the page, and the kept one stays here
        if (r.volume > threshold && r.center) interferences.push({ a: A.item.id, b: B.item.id, volume: r.volume, center: r.center, mesh: r.mesh && copyMesh(r.mesh) });
      }
    }
    for (const key of this.pairs.keys()) {
      if (this.pairs.size <= 5000) break;
      this.pairs.delete(key);
    }

    // which parts touch, and which holds which up: for the check that every part is held in place
    const contacts: NonNullable<ChecksResult["contacts"]> = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (!boxesOverlap(A.bbox, B.bbox, CONTACT_GAP)) continue;
        if (A.item.id.split(".")[0] === B.item.id.split(".")[0]) continue;
        const swap = A.key > B.key;
        const key = swap ? `${B.key}#${A.key}` : `${A.key}#${B.key}`;
        let t = this.touches.get(key);
        if (t === undefined) {
          const sa = surfaceOf(swap ? B : A);
          const sb = surfaceOf(swap ? A : B);
          t = sa && sb ? touching(sa, sb) : null;
        }
        this.touches.delete(key);
        this.touches.set(key, t);
        if (t) contacts.push({ a: A.item.id, b: B.item.id, aOnB: swap ? t.bOnA : t.aOnB, bOnA: swap ? t.aOnB : t.bOnA });
      }
    }
    for (const key of this.touches.keys()) {
      if (this.touches.size <= 20000) break;
      this.touches.delete(key);
    }
    const boxes: Record<string, [V3, V3]> = {};
    for (const w of list) boxes[w.item.id] = w.bbox;

    // geometric queries for requirements
    const geo: Record<string, number> = {};
    const geoErrors: Record<string, string> = {};
    // a name matches every solid of a part or component; an id matches one solid (a body of an imported file)
    const byName = (name: string) => list.filter((w) => w.item.name === name || w.item.id === name);
    for (const q of req.queries) {
      const key = geoKey(q);
      try {
        geo[key] = this.geoQuery(q, byName);
      } catch (e) {
        geoErrors[key] = e instanceof Error ? e.message : String(e);
      }
    }

    // fastener tool access
    const access: ChecksResult["access"] = [];
    for (const a of req.access) {
      const start = vadd(a.headTop, vscale(a.outward, 0.05));
      const tool = R.makeCylinder(a.diameter / 2, a.length, start, a.outward);
      const tb = bboxOf(tool);
      const blockedBy: string[] = [];
      for (const w of list) {
        if (w.item.id === a.id || w.item.removable) continue;
        if (!boxesOverlap(tb, w.bbox, 0)) continue;
        try {
          const inter = tool.intersect(w.shape) as Shape3D;
          const v = R.measureVolume(inter);
          safeDelete(inter);
          if (v > 0.05) blockedBy.push(w.item.id);
        } catch {
          /* ignore */
        }
      }
      safeDelete(tool);
      access.push({ id: a.id, blockedBy });
    }

    // swept envelopes of rotating parts against static geometry
    const envelopes: ChecksResult["envelopes"] = [];
    for (const env of req.envelopes) {
      let cyl: Shape3D = R.makeCylinder(env.d / 2, env.length, env.at, env.axis);
      if (env.bore && env.bore < env.d) {
        const hole = R.makeCylinder(env.bore / 2, env.length + 0.2, vadd(env.at, vscale(env.axis, -0.1)), env.axis);
        const ring = cyl.cut(hole) as Shape3D;
        safeDelete(hole);
        safeDelete(cyl);
        cyl = ring;
      }
      const cb = bboxOf(cyl);
      const ex = new Set(env.exclude);
      const hits: string[] = [];
      for (const w of list) {
        if (w.item.id === env.id || w.item.moving || ex.has(w.item.id)) continue;
        if (!boxesOverlap(cb, w.bbox, 0)) continue;
        try {
          const inter = cyl.intersect(w.shape) as Shape3D;
          const v = R.measureVolume(inter);
          safeDelete(inter);
          if (v > 0.5) hits.push(w.item.id);
        } catch {
          /* ignore */
        }
      }
      safeDelete(cyl);
      envelopes.push({ id: env.id, hits });
    }

    // parts made of solids that do not touch: usually a feature added where it misses the body
    const pieces: NonNullable<ChecksResult["pieces"]> = {};
    for (const p of placed) {
      const e = this.cache.get(p.hash)!;
      if (e.pieces === undefined) {
        try {
          e.pieces = solidPieces(e.shape) ?? null;
        } catch {
          e.pieces = null;
        }
      }
      if (e.pieces && e.pieces.count > 1) pieces[p.hash] = e.pieces;
    }

    return { interferences, geo, geoErrors, access, envelopes, ms: performance.now() - t0, pairsTested, pieces, contacts, boxes };
  }

  /** How much two placed solids overlap: exactly, unless their meshes show they are well apart. */
  private overlap(A: World, B: World, threshold: number, surfaceOf: (w: World) => PlacedSurface | null): PairResult {
    const sa = surfaceOf(A);
    const sb = sa && surfaceOf(B);
    if (sa && sb && apart(sa, sb)) return { volume: 0 };
    try {
      const inter = A.shape.intersect(B.shape) as Shape3D;
      let volume = 0;
      try {
        volume = R.measureVolume(inter);
      } catch {
        volume = 0;
      }
      const out: PairResult = { volume };
      if (volume > threshold) {
        out.center = mid(bboxOf(inter));
        try {
          out.mesh = meshShape(inter, "preview");
        } catch {
          out.mesh = undefined;
        }
      }
      safeDelete(inter);
      return out;
    } catch {
      // boolean failed: fall back to treating overlapping boxes as a warning-free pass
      return { volume: 0 };
    }
  }

  private geoQuery(q: GeoQuery, byName: (n: string) => World[]): number {
    const A = byName(q.a);
    if (!A.length) throw new Error(`"${q.a}" has no built geometry`);
    switch (q.q) {
      case "volume":
        return A.reduce((s, w) => s + w.volume, 0);
      case "mass":
        return A.reduce((s, w) => s + (w.volume / 1000) * w.item.density, 0);
      case "bbox": {
        const ax = q.axis === "x" ? 0 : q.axis === "y" ? 1 : 2;
        const lo = Math.min(...A.map((w) => w.bbox[0][ax]));
        const hi = Math.max(...A.map((w) => w.bbox[1][ax]));
        return q.side === "min" ? lo : q.side === "max" ? hi : hi - lo;
      }
      case "min_distance": {
        const B = byName(q.b);
        if (!B.length) throw new Error(`"${q.b}" has no built geometry`);
        let best = Infinity;
        const tool = new R.DistanceTool();
        for (const a of A)
          for (const b of B) {
            // quick lower bound from boxes
            if (boxGap(a.bbox, b.bbox) > best) continue;
            const d = tool.distanceBetween(a.shape, b.shape);
            if (d < best) best = d;
          }
        try {
          tool.delete();
        } catch {
          /* ignore */
        }
        return best;
      }
    }
  }

  /** Manufacturing-process checks of built parts (see src/mfg). */
  process(probes: ProcessProbe[]): ProcessResult[] {
    return probes.map((p) => this.processes.run(p, this.get(p.hash)));
  }

  /** Smallest distance between two groups of placed solids, with the closest points. */
  measure(a: { hash: string; xf: Xform[] }[], b: { hash: string; xf: Xform[] }[]): MeasureResult {
    const A = a.filter((p) => this.cache.has(p.hash)).map((p) => this.placed(p));
    const B = b.filter((p) => this.cache.has(p.hash)).map((p) => this.placed(p));
    if (!A.length || !B.length) throw new Error("Both sides need built geometry to measure.");
    const oc = R.getOC() as unknown as OCDist;
    let best: MeasureResult | null = null;
    for (const x of A)
      for (const y of B) {
        if (best && boxGap(x.bbox, y.bbox) > best.distance) continue;
        const tool = new oc.BRepExtrema_DistShapeShape();
        try {
          tool.LoadS1(x.shape.wrapped);
          tool.LoadS2(y.shape.wrapped);
          tool.Perform();
          if (!tool.IsDone() || tool.NbSolution() < 1) continue;
          const d = tool.Value();
          if (!best || d < best.distance) {
            const p = tool.PointOnShape1(1);
            const q = tool.PointOnShape2(1);
            best = { distance: d, a: [p.X(), p.Y(), p.Z()], b: [q.X(), q.Y(), q.Z()] };
            p.delete();
            q.delete();
          }
        } finally {
          tool.delete();
        }
      }
    if (!best) throw new Error("The kernel could not measure between these parts.");
    return best;
  }

  exportStep(items: ExportItem[]): Blob {
    // the detailed solid when it has been built (real threads, cosmetic detail), else the fast one
    const shapes = items.map((it) => {
      const e = it.recipe ? this.build({ hash: it.hash, recipe: it.recipe, label: it.name }, it.fast ? "preview" : "final") : (this.detailCache.get(it.hash) ?? this.get(it.hash));
      if (!e) throw new Error("not built: " + it.name);
      return { shape: applyXf(e.shape.clone(), it.xf), name: it.name, color: it.color };
    });
    return R.exportSTEP(shapes);
  }
}

interface OCPoint {
  X(): number;
  Y(): number;
  Z(): number;
  delete(): void;
}

interface OCDist {
  BRepExtrema_DistShapeShape: new () => {
    LoadS1(s: unknown): void;
    LoadS2(s: unknown): void;
    Perform(): boolean;
    IsDone(): boolean;
    NbSolution(): number;
    Value(): number;
    PointOnShape1(n: number): OCPoint;
    PointOnShape2(n: number): OCPoint;
    delete(): void;
  };
}

function safeDelete(s: { delete?: () => void } | undefined) {
  try {
    s?.delete?.();
  } catch {
    /* already freed */
  }
}

function pairKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function boxesOverlap(a: [V3, V3], b: [V3, V3], pad: number) {
  for (let i = 0; i < 3; i++) if (a[1][i] + pad < b[0][i] || b[1][i] + pad < a[0][i]) return false;
  return true;
}

function boxGap(a: [V3, V3], b: [V3, V3]) {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const d = Math.max(0, b[0][i] - a[1][i], a[0][i] - b[1][i]);
    s += d * d;
  }
  return Math.sqrt(s);
}

function copyMesh(m: MeshData): MeshData {
  return {
    positions: m.positions.slice(),
    normals: m.normals.slice(),
    indices: m.indices.slice(),
    edges: m.edges.slice(),
    faceGroups: m.faceGroups?.slice(),
    edgeGroups: m.edgeGroups?.slice(),
    colors: m.colors?.slice(),
  };
}

function mid(b: [V3, V3]): V3 {
  return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2];
}

/** World-space AABB of a local box after a transform chain. */
export function worldBox(b: [V3, V3], xf: Xform[]): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p: V3 = [i & 1 ? b[1][0] : b[0][0], i & 2 ? b[1][1] : b[0][1], i & 4 ? b[1][2] : b[0][2]];
    const q = applyXforms(p, xf);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], q[k]);
      hi[k] = Math.max(hi[k], q[k]);
    }
  }
  return [lo, hi];
}

export { stableStringify };
