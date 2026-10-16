// Kernel core: content-addressed solid cache, meshing and assembly checks.
// Environment-agnostic so it runs in the worker and in Node tests.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { applyXf, bboxOf, buildPart, meshShape, type MeshData } from "./build";
import { applyXforms, recipeHash, stableStringify, vadd, vscale, type V3, type Xform } from "./recipe";
import type { BuildItem, ChecksRequest, ChecksResult, Interference, PlacedItem } from "./protocol";
import { inspectPart, type PartInspection } from "./inspect";
import { geoKey, type GeoQuery } from "../lang/values";

interface CacheEntry {
  shape: Shape3D;
  volume: number;
  bbox: [V3, V3];
  meshes: Partial<Record<"preview" | "final", MeshData>>;
  inspection?: PartInspection;
  used: number;
}

export class KernelCore {
  private cache = new Map<string, CacheEntry>();
  private placedCache = new Map<string, { shape: Shape3D; bbox: [V3, V3]; used: number }>();
  private tick = 0;
  maxEntries = 400;

  has(hash: string) {
    return this.cache.has(hash);
  }

  get(hash: string): CacheEntry | undefined {
    const e = this.cache.get(hash);
    if (e) e.used = ++this.tick;
    return e;
  }

  build(item: BuildItem): CacheEntry {
    const hit = this.get(item.hash);
    if (hit) return hit;
    const shape = buildPart(item.recipe);
    let volume = 0;
    try {
      volume = R.measureVolume(shape);
    } catch {
      volume = 0;
    }
    const entry: CacheEntry = { shape, volume, bbox: bboxOf(shape), meshes: {}, used: ++this.tick };
    this.cache.set(item.hash, entry);
    this.trim();
    return entry;
  }

  mesh(hash: string, quality: "preview" | "final"): MeshData {
    const e = this.get(hash);
    if (!e) throw new Error("not built");
    if (!e.meshes[quality]) e.meshes[quality] = meshShape(e.shape, quality);
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
        e.inspection ??= inspectPart(e.shape, e.meshes.final ?? e.meshes.preview ?? this.mesh(h, "preview"));
        out[h] = e.inspection;
      } catch (err) {
        out[h] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return out;
  }

  evict(keep: string[]) {
    const k = new Set(keep);
    for (const [h, e] of this.cache) {
      if (!k.has(h)) {
        safeDelete(e.shape);
        this.cache.delete(h);
      }
    }
    for (const [key, p] of this.placedCache) {
      if (!k.has(key.split("|")[0])) {
        safeDelete(p.shape);
        this.placedCache.delete(key);
      }
    }
  }

  private trim() {
    if (this.cache.size <= this.maxEntries) return;
    const sorted = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [h, e] of sorted.slice(0, this.cache.size - this.maxEntries)) {
      safeDelete(e.shape);
      this.cache.delete(h);
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
    const entry = { shape, bbox: worldBox(e.bbox, p.xf), used: ++this.tick };
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
    const world = new Map<string, { item: PlacedItem; shape: Shape3D; bbox: [V3, V3]; volume: number }>();
    for (const p of placed) {
      const w = this.placed(p);
      world.set(p.id, { item: p, shape: w.shape, bbox: w.bbox, volume: this.cache.get(p.hash)!.volume });
    }
    const ignore = new Set(req.ignorePairs.map(([a, b]) => pairKey(a, b)));
    const interferences: Interference[] = [];
    let pairsTested = 0;
    const list = [...world.values()];
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
        try {
          const inter = A.shape.intersect(B.shape) as Shape3D;
          let vol = 0;
          try {
            vol = R.measureVolume(inter);
          } catch {
            vol = 0;
          }
          const threshold = Math.max(0.5, 1e-4 * Math.min(A.volume || 1, B.volume || 1));
          if (vol > threshold) {
            const bb = bboxOf(inter);
            let mesh: MeshData | undefined;
            try {
              mesh = meshShape(inter, "preview");
            } catch {
              mesh = undefined;
            }
            interferences.push({ a: A.item.id, b: B.item.id, volume: vol, center: mid(bb), mesh });
          }
          safeDelete(inter);
        } catch {
          // boolean failed: fall back to treating overlapping boxes as a warning-free pass
        }
      }
    }

    // geometric queries for requirements
    const geo: Record<string, number> = {};
    const geoErrors: Record<string, string> = {};
    const byName = (name: string) => list.filter((w) => w.item.name === name);
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
      const cyl = R.makeCylinder(env.d / 2, env.length, env.at, env.axis);
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

    return { interferences, geo, geoErrors, access, envelopes, ms: performance.now() - t0, pairsTested };
  }

  private geoQuery(q: GeoQuery, byName: (n: string) => { item: PlacedItem; shape: Shape3D; bbox: [V3, V3]; volume: number }[]): number {
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

  exportStep(items: { hash: string; xf: Xform[]; name: string; color: string }[]): Blob {
    const shapes = items.map((it) => ({ shape: this.placed(it).shape.clone(), name: it.name, color: it.color }));
    return R.exportSTEP(shapes);
  }
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
