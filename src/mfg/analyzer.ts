// Kernel-side runner for process checks: meshes each built solid once for
// analysis, keeps the analysis context so several processes can be checked
// against the same part cheaply, and caches results by geometry and rules.

import type { Shape3D } from "replicad";
import { analysisMesh } from "./brep";
import { analyzeSolid, prepareSolid, type Ctx } from "./analyze";
import { stableStringify, type V3 } from "../kernel/recipe";
import type { ProcessProbe, ProcessResult } from "./types";

export class ProcessAnalyzer {
  private solids = new Map<string, { ctx: Ctx; used: number }>();
  private results = new Map<string, { result: ProcessResult; used: number }>();
  private tick = 0;
  maxSolids = 40;
  maxResults = 300;

  run(probe: ProcessProbe, built: { shape: Shape3D; bbox: [V3, V3] } | undefined): ProcessResult {
    const key = `${probe.hash}|${stableStringify(probe.rules)}`;
    const hit = this.results.get(key);
    if (hit) {
      hit.used = ++this.tick;
      return hit.result;
    }
    const t0 = performance.now();
    let result: ProcessResult;
    if (!built) {
      result = { key, findings: [], stats: { triangles: 0, samples: 0 }, ms: 0, error: "The part has not been built" };
    } else {
      try {
        const ctx = this.context(probe.hash, built);
        const { findings, stats } = analyzeSolid(ctx, probe.rules);
        result = { key, findings, stats, ms: performance.now() - t0 };
      } catch (e) {
        result = { key, findings: [], stats: { triangles: 0, samples: 0 }, ms: performance.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
    }
    this.results.set(key, { result, used: ++this.tick });
    trim(this.results, this.maxResults);
    return result;
  }

  private context(hash: string, built: { shape: Shape3D; bbox: [V3, V3] }): Ctx {
    const hit = this.solids.get(hash);
    if (hit) {
      hit.used = ++this.tick;
      return hit.ctx;
    }
    const [lo, hi] = built.bbox;
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    // fine enough to follow small fillets and holes, coarse enough for large parts
    const tolerance = Math.min(0.1, Math.max(0.02, diag / 3000));
    const mesh = built.shape.mesh({ tolerance, angularTolerance: 10 });
    const ctx = prepareSolid(analysisMesh(built.shape, mesh));
    this.solids.set(hash, { ctx, used: ++this.tick });
    trim(this.solids, this.maxSolids);
    return ctx;
  }

  evict(keep: Set<string>) {
    for (const h of this.solids.keys()) if (!keep.has(h)) this.solids.delete(h);
    for (const k of this.results.keys()) if (!keep.has(k.slice(0, k.indexOf("|")))) this.results.delete(k);
  }
}

function trim<T extends { used: number }>(m: Map<string, T>, max: number) {
  if (m.size <= max) return;
  const sorted = [...m.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [k] of sorted.slice(0, m.size - max)) m.delete(k);
}
