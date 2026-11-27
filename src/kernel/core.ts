// Kernel core: content-addressed solid cache, meshing and assembly checks.
// Environment-agnostic so it runs in the worker and in Node tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { applyXf, bboxOf, buildPartFull, importFaceColors, importFaceted, isTrap, meshShape, solidVolume, type MeshData, type MeshQuality } from "./build";
import { displayBuilt, threadMarks, type ThreadMark } from "./threadMarks";
import { applyXforms, hasDetail, recipeHash, stableStringify, vadd, vnorm, vscale, xformMatrix, type V3, type Xform } from "./recipe";
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
import { geomCore, poseKey, type GeomCore } from "../geom/core";
import { exactFaces } from "./exactFaces";

/**
 * How far a preview mesh may stray from a face the kernel gives the geometry core no exact shape for, mm: twice what
 * was seen in practice (see APART_GAP). Flat and round faces are held to the kernel's own numbers instead.
 */
const STRAY = 1;

/**
 * The geometry core's proof that two parts overlap by no more than a film is taken when the most it allows is this
 * much of what would count as a clash. Under 1 only so that rounding in the bound cannot tip an answer.
 */
const ACCEPT = 0.9;

interface CacheEntry {
  shape: Shape3D;
  volume: number;
  bbox: [V3, V3];
  meshes: Partial<Record<MeshQuality, MeshData>>;
  /** the thread stand-ins in this solid (fast and display builds), for drawing threads on them */
  threads: ThreadMark[];
  inspection?: PartInspection;
  /** its flat and round faces, for mates */
  faces?: FaceCatalogue;
  /** the separate solids it is made of, worked out on the first check that needs them */
  pieces?: PartInspection["pieces"] | null;
  /** colours of each face, for imported bodies that carry them */
  faceColors: string[] | null;
  /** a body of an imported mesh: its facets are shown smooth */
  faceted: boolean;
  used: number;
  features: Map<string, FeatureTools>;
  /** cosmetic steps that could not be built */
  warnings: string[];
  /** the solid in the geometry core (its preview mesh with the kernel's exact faces), made on the first check; null when it cannot be */
  geom?: { handle: number; closed: boolean } | null;
}

/** A solid placed in the world for the checks. */
interface World {
  item: PlacedItem;
  /** the solid moved into place in the kernel: made when something first asks, since most checks never need it */
  readonly shape: Shape3D;
  bbox: [V3, V3];
  volume: number;
  /** the placed-solid cache key: geometry hash and placement */
  key: string;
  /** its placement as a 4x4 matrix, by column */
  mat: number[];
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
  /** display builds: detailed, but with threads as stand-ins (only parts with threads and other detail) */
  private displayCache = new Map<string, CacheEntry>();
  private placedCache = new Map<string, { shape: Shape3D; bbox: [V3, V3]; used: number; key: string }>();
  /** overlaps of placed pairs, kept across checks so an edit re-tests only the pairs it moved or changed */
  private pairs = new Map<string, PairResult>();
  /**
   * Overlaps too small to count, by the two solids and how one sits as the other sees it: the same screw in the same
   * hole overlaps by the same amount wherever the two are in the assembly, so it is worked out once.
   */
  private posed = new Map<string, number>();
  /** whether two placed solids touch, by the same pair key */
  private touches = new Map<string, Touch | null>();
  /** the same, by the two solids, how one sits as the other sees it, and which way is down for them */
  private rests = new Map<string, Touch | null>();
  /** whether a tool or a turning part's sweep runs into a placed solid, by the sweep and the solid's key */
  private sweeps = new Map<string, boolean>();
  /** sweep cylinders in the geometry core, by radius and length */
  private cylinders = new Map<string, number>();
  private tick = 0;
  private processes = new ProcessAnalyzer();
  maxEntries = 400;
  /** false: settle every close pair with the kernel's exact test, as before there was a geometry core (for comparing the two) */
  useGeomCore = true;
  /**
   * For testing the geometry core against the kernel. Set to a list, and every overlap the core settles is also put to
   * the kernel's exact test; the ones where the kernel finds more overlap than the core proved possible are added.
   */
  audit: { a: string; b: string; exact: number; atMost: number }[] | null = null;

  private geomCore(): GeomCore | null {
    return this.useGeomCore ? geomCore() : null;
  }

  has(hash: string) {
    return this.cache.has(hash);
  }

  get(hash: string): CacheEntry | undefined {
    const e = this.cache.get(hash);
    if (e) e.used = ++this.tick;
    return e;
  }

  /**
   * Build a part. Final quality builds the detailed version when the recipe has detail; display quality builds the
   * detailed version with its threads left as stand-ins when it has other detail too, else it is the fast build.
   */
  build(item: BuildItem, quality: MeshQuality = "preview"): CacheEntry {
    const display = quality === "display" && displayBuilt(item.recipe);
    if ((quality === "final" && hasDetail(item.recipe)) || display) {
      const cache = display ? this.displayCache : this.detailCache;
      const hit = cache.get(item.hash);
      if (hit) {
        hit.used = ++this.tick;
        return hit;
      }
      const entry = this.make(item, display ? "display" : true);
      cache.set(item.hash, entry);
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

  private make(item: BuildItem, detail: boolean | "display"): CacheEntry {
    const { shape, warnings, features } = buildPartFull(item.recipe, { detail: detail !== false, threads: detail === true });
    let volume = 0;
    try {
      volume = solidVolume(shape);
    } catch {
      volume = 0;
    }
    const threads = detail === true ? [] : threadMarks(item.recipe, detail === "display");
    return { shape, volume, bbox: bboxOf(shape), meshes: {}, threads, faceColors: importFaceColors(item.recipe), faceted: importFaceted(item.recipe), used: ++this.tick, features, warnings };
  }

  mesh(hash: string, quality: MeshQuality): MeshData {
    const e = (quality === "final" ? this.detailCache.get(hash) : quality === "display" ? this.displayCache.get(hash) : undefined) ?? this.get(hash);
    if (!e) throw new Error("not built");
    if (!e.meshes[quality]) e.meshes[quality] = meshShape(e.shape, quality, e.faceColors, e.volume, e.faceted, e.threads);
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
        this.free(e);
        this.cache.delete(h);
      }
    }
    for (const [h, e] of this.detailCache) {
      if (!k.has(h)) {
        safeDelete(e.shape);
        this.detailCache.delete(h);
      }
    }
    for (const [h, e] of this.displayCache) {
      if (!k.has(h)) {
        safeDelete(e.shape);
        this.displayCache.delete(h);
      }
    }
    for (const [key, p] of this.placedCache) {
      if (!k.has(key.split("|")[0])) {
        safeDelete(p.shape);
        this.placedCache.delete(key);
      }
    }
    for (const key of this.pairs.keys()) if (key.split("#").some((pk) => !k.has(pk.split("|")[0]))) this.pairs.delete(key);
    for (const key of this.posed.keys()) if (key.split("#", 2).some((h) => !k.has(h))) this.posed.delete(key);
    for (const key of this.rests.keys()) if (key.split("#", 2).some((h) => !k.has(h))) this.rests.delete(key);
    for (const key of this.sweeps.keys()) if (!k.has(key.slice(key.indexOf("#") + 1).split("|")[0])) this.sweeps.delete(key);
  }

  /** Let go of a built solid, in the kernel and in the geometry core. */
  private free(e: CacheEntry) {
    safeDelete(e.shape);
    if (e.geom) geomCore()?.drop(e.geom.handle);
    e.geom = null;
  }

  /** The solid in the geometry core: its preview mesh, with each face as the kernel knows it. Null when that cannot be made. */
  private geomOf(core: GeomCore, hash: string): { handle: number; closed: boolean } | null {
    const e = this.cache.get(hash);
    if (!e) return null;
    if (e.geom === undefined) {
      e.geom = null;
      try {
        const mesh = this.mesh(hash, "preview");
        const exact = exactFaces(e.shape, mesh);
        if (exact) {
          const handle = core.add(mesh.positions, mesh.indices, exact.triFace, exact.faces, STRAY);
          e.geom = { handle, closed: core.info(handle)?.closed === true };
        }
      } catch {
        e.geom = null;
      }
    }
    return e.geom;
  }

  private trim() {
    for (const map of [this.cache, this.detailCache, this.displayCache]) {
      if (map.size <= this.maxEntries) continue;
      const sorted = [...map.entries()].sort((a, b) => a[1].used - b[1].used);
      for (const [h, e] of sorted.slice(0, map.size - this.maxEntries)) {
        this.free(e);
        map.delete(h);
      }
    }
  }

  placed(p: { hash: string; xf: Xform[] }, key = p.hash + "|" + recipeHash(p.xf)) {
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
    // the solids are moved into place in the kernel only when a test needs one there: most are settled without
    const solid = (p: PlacedItem, key: string) => this.placed(p, key).shape;
    for (const p of placed) {
      const e = this.cache.get(p.hash)!;
      const key = p.hash + "|" + recipeHash(p.xf);
      world.set(p.id, {
        item: p,
        get shape() {
          return solid(p, key);
        },
        bbox: this.placedCache.get(key)?.bbox ?? worldBox(e.bbox, p.xf),
        volume: e.volume,
        key,
        mat: xformMatrix(p.xf),
      });
    }
    const core = this.geomCore();
    const stats = { proved: 0, film: 0, reused: 0, exact: 0 };
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
        const r = this.pairs.get(key) ?? this.overlap(A, B, threshold, surfaceOf, stats);
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
          const P = swap ? B : A;
          const Q = swap ? A : B;
          const gp = core && this.geomOf(core, P.item.hash);
          const gq = core && gp?.closed ? this.geomOf(core, Q.item.hash) : null;
          if (core && gp?.closed && gq?.closed) {
            // the same two solids sitting the same way on each other, the same way up, touch the same way: a
            // sub-assembly moved as a whole is not worked out again
            const pose = `${P.item.hash}#${Q.item.hash}#${poseKey(P.mat, Q.mat)}#${downKey(P.mat)}`;
            t = this.rests.get(pose);
            if (t === undefined) {
              t = core.touch(gp.handle, gq.handle, P.mat, Q.mat, CONTACT_GAP);
              this.rests.set(pose, t);
            } else {
              this.rests.delete(pose);
              this.rests.set(pose, t);
            }
          } else {
            const sa = surfaceOf(P);
            const sb = surfaceOf(Q);
            t = sa && sb ? touching(sa, sb) : null;
          }
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
    for (const key of this.rests.keys()) {
      if (this.rests.size <= 20000) break;
      this.rests.delete(key);
    }
    const boxes: Record<string, [V3, V3]> = {};
    for (const w of list) boxes[w.item.id] = w.bbox;

    // geometric queries for requirements
    const geo: Record<string, number> = {};
    const geoErrors: Record<string, string> = {};
    // a name matches every solid of a part or component; an id matches one solid (a body of an imported file)
    const byName = (name: string) => list.filter((w) => w.item.name === name || w.item.id === name || w.item.of === name);
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
      const sweep = new Sweep(a.diameter / 2, a.length, start, a.outward);
      const blockedBy: string[] = [];
      for (const w of list) {
        if (w.item.id === a.id || w.item.removable) continue;
        if (!boxesOverlap(sweep.bbox, w.bbox, 0)) continue;
        if (this.sweepHits(sweep, w, 0.05, stats)) blockedBy.push(w.item.id);
      }
      sweep.done();
      access.push({ id: a.id, blockedBy });
    }

    // swept envelopes of rotating parts against static geometry
    const envelopes: ChecksResult["envelopes"] = [];
    for (const env of req.envelopes) {
      const sweep = new Sweep(env.d / 2, env.length, env.at, env.axis, env.bore && env.bore < env.d ? env.bore / 2 : 0);
      const ex = new Set(env.exclude);
      const hits: string[] = [];
      for (const w of list) {
        if (w.item.id === env.id || w.item.moving || ex.has(w.item.id)) continue;
        if (!boxesOverlap(sweep.bbox, w.bbox, 0)) continue;
        if (this.sweepHits(sweep, w, 0.5, stats)) hits.push(w.item.id);
      }
      sweep.done();
      envelopes.push({ id: env.id, hits });
    }
    for (const key of this.sweeps.keys()) {
      if (this.sweeps.size <= 40000) break;
      this.sweeps.delete(key);
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

    return { interferences, geo, geoErrors, access, envelopes, ms: performance.now() - t0, pairsTested, pieces, contacts, boxes, settled: stats };
  }

  /**
   * Whether a tool's or a turning part's sweep overlaps a placed solid by more than `limit` mm³. The geometry core
   * proves most of them clear; the kernel settles the rest. Kept by the sweep and the placed solid, so an edit asks
   * again only about what it moved.
   */
  private sweepHits(sweep: Sweep, w: World, limit: number, stats: Settled): boolean {
    const key = `${sweep.key}#${w.key}`;
    let hit = this.sweeps.get(key);
    if (hit !== undefined) stats.reused++;
    else {
      hit = false;
      const core = this.geomCore();
      const g = core && this.geomOf(core, w.item.hash);
      let proved = false;
      // a sweep with a bore is left to the kernel: what is inside the bore is not in its way
      if (core && g?.closed && !sweep.bore) {
        const ck = `${sweep.r}|${sweep.length}`;
        let cyl = this.cylinders.get(ck);
        if (cyl === undefined) {
          if (this.cylinders.size >= 200) {
            for (const h of this.cylinders.values()) core.drop(h);
            this.cylinders.clear();
          }
          cyl = core.cylinder(sweep.r, sweep.length);
          this.cylinders.set(ck, cyl);
        }
        const v = core.classify(cyl, g.handle, sweep.mat, w.mat);
        proved = v.atMost !== null && v.atMost <= 0.5 * limit;
        if (proved && this.audit) {
          const x = exactOverlap(sweep.solid(), w.shape);
          safeDelete(x?.solid);
          if (x && x.volume > v.atMost! + 1e-3) this.audit.push({ a: `sweep ${sweep.key}`, b: w.item.id, exact: x.volume, atMost: v.atMost! });
        }
      }
      if (proved) stats.proved++;
      else {
        stats.exact++;
        const x = exactOverlap(sweep.solid(), w.shape);
        if (x) {
          hit = x.volume > limit;
          safeDelete(x.solid);
        }
      }
    }
    this.sweeps.delete(key);
    this.sweeps.set(key, hit);
    return hit;
  }

  /** How much two placed solids overlap: exactly, unless their meshes show they are well apart. */
  private overlap(A: World, B: World, threshold: number, surfaceOf: (w: World) => PlacedSurface | null, stats: Settled): PairResult {
    const core = this.geomCore();
    const ga = core && this.geomOf(core, A.item.hash);
    const gb = core && ga?.closed ? this.geomOf(core, B.item.hash) : null;
    // the pair by its two solids (in order) and how the second sits as the first sees it
    let pose: string | undefined;
    if (core && ga?.closed && gb?.closed) {
      const flip = A.item.hash > B.item.hash;
      const P = flip ? B : A;
      const Q = flip ? A : B;
      pose = `${P.item.hash}#${Q.item.hash}#${poseKey(P.mat, Q.mat)}`;
      // two copies of one solid can be told either way round
      const known = this.posed.get(pose) ?? (P.item.hash === Q.item.hash ? this.posed.get(`${P.item.hash}#${P.item.hash}#${poseKey(Q.mat, P.mat)}`) : undefined);
      if (known !== undefined) {
        stats.reused++;
        return { volume: known };
      }
      // proved clear, or proved to overlap by no more than a film well under what counts
      const v = core.classify(ga.handle, gb.handle, A.mat, B.mat);
      if (v.atMost !== null && v.atMost <= ACCEPT * threshold) {
        if (v.clear) stats.proved++;
        else stats.film++;
        if (this.audit) {
          const x = exactOverlap(A.shape, B.shape);
          safeDelete(x?.solid);
          if (x && x.volume > v.atMost + 1e-3) this.audit.push({ a: A.item.id, b: B.item.id, exact: x.volume, atMost: v.atMost });
        }
        this.remember(pose, v.atMost);
        return { volume: v.atMost };
      }
    } else {
      const sa = surfaceOf(A);
      const sb = sa && surfaceOf(B);
      if (sa && sb && apart(sa, sb)) return { volume: 0 };
    }
    stats.exact++;
    try {
      const inter = A.shape.intersect(B.shape) as Shape3D;
      let volume = 0;
      let measured = true;
      try {
        volume = R.measureVolume(inter);
      } catch {
        volume = 0;
        measured = false;
      }
      if (pose && measured && volume <= threshold) this.remember(pose, volume);
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

  private remember(pose: string, volume: number) {
    this.posed.set(pose, volume);
    if (this.posed.size > 20000) for (const key of [...this.posed.keys()].slice(0, 5000)) this.posed.delete(key);
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

  /**
   * Manufacturing-process checks of built parts (see src/mfg). `parts`: the parts the probes are of, built first
   * (the fast build) where this kernel does not have them: a kernel that was not the one to build the design can
   * then check its parts alongside the one that did. A part that does not build is reported as not built.
   */
  process(probes: ProcessProbe[], parts: BuildItem[] = []): ProcessResult[] {
    for (const item of parts) {
      try {
        this.build(item, "preview");
      } catch (e) {
        // (a trap leaves the kernel's memory unsafe: that one is the worker's to report)
        if (isTrap(e)) throw e;
        // otherwise the probe below says the part has not been built
      }
    }
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

type Settled = NonNullable<ChecksResult["settled"]>;

/** The kernel's exact overlap of two solids and its volume; null when the kernel cannot work it out. */
/**
 * Which way is down (-Z) as a placed part sees it, rounded to a billionth, as a key. `m`: its placement as a 4x4
 * matrix, by column. Only the direction matters, so the rows of the turn are enough even when it mirrors.
 */
function downKey(m: ArrayLike<number>): string {
  // the world's -Z in the part's own frame: the third row of the turn, negated (its length does not matter here)
  const d = [-m[2], -m[6], -m[10]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return d.map((x) => Math.round((x / l) * 1e9) + 0).join(",");
}

function exactOverlap(a: Shape3D, b: Shape3D): { solid: Shape3D; volume: number } | null {
  try {
    const solid = a.intersect(b) as Shape3D;
    try {
      return { solid, volume: R.measureVolume(solid) };
    } catch {
      safeDelete(solid);
      return null;
    }
  } catch {
    return null;
  }
}

/** A cylinder a tool or a turning part sweeps, with a bore through it when it turns about a still axle. */
class Sweep {
  readonly key: string;
  readonly bbox: [V3, V3];
  /** where it is, as a placement of a cylinder up Z from the origin: a 4x4 matrix, by column */
  readonly mat: number[];
  private shape: Shape3D | null = null;

  constructor(
    readonly r: number,
    readonly length: number,
    private at: V3,
    private axis: V3,
    readonly bore = 0,
  ) {
    const z = vnorm(axis);
    // any two directions square to the axis and each other
    const s: V3 = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const x = vnorm([s[1] * z[2] - s[2] * z[1], s[2] * z[0] - s[0] * z[2], s[0] * z[1] - s[1] * z[0]]);
    const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    this.mat = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, at[0], at[1], at[2], 1];
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      // a disc's reach along an axis is its radius times how far that axis leans off the cylinder's
      const reach = r * Math.sqrt(Math.max(0, 1 - z[k] * z[k]));
      lo[k] = Math.min(at[k], at[k] + z[k] * length) - reach;
      hi[k] = Math.max(at[k], at[k] + z[k] * length) + reach;
    }
    this.bbox = [lo, hi];
    this.key = [r, length, bore, ...at, ...z].join(",");
  }

  /** The sweep as a solid in the kernel, made when the kernel is asked about it. */
  solid(): Shape3D {
    if (!this.shape) {
      let cyl: Shape3D = R.makeCylinder(this.r, this.length, this.at, this.axis);
      if (this.bore) {
        const hole = R.makeCylinder(this.bore, this.length + 0.2, vadd(this.at, vscale(this.axis, -0.1)), this.axis);
        const ring = cyl.cut(hole) as Shape3D;
        safeDelete(hole);
        safeDelete(cyl);
        cyl = ring;
      }
      this.shape = cyl;
    }
    return this.shape;
  }

  done() {
    safeDelete(this.shape ?? undefined);
    this.shape = null;
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
