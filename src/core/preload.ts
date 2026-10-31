// A sprung blade drawn where it presses on its mate: flexure(..., preload:, against:) is drawn unbent and its mate where
// it sits, so the two overlap by the preload along the blade's travel. That overlap is the spring's squeeze, not a clash,
// as long as nowhere is it deeper than the preload: a shape moved δ into another overlaps it by at most δ along any line
// in the direction it moved, so rays cast that way through the overlap tell the two apart.

import type { MeshData } from "../kernel/build";
import type { Interference } from "../kernel/protocol";
import { applyXformsToDir, vcross, vdot, vnorm, type V3 } from "../kernel/recipe";
import type { EvalPart, FlexInfo } from "./model";

/** The deepest a closed mesh runs along dir: rays cast that way across it, each run from where it goes in to where it comes out. */
export function depthAlong(mesh: MeshData, dir: V3, rays = 24): number {
  const d = vnorm(dir);
  const e1 = vnorm(Math.abs(d[0]) < 0.9 ? vcross(d, [1, 0, 0]) : vcross(d, [0, 1, 0]));
  const e2 = vcross(d, e1);
  const P = mesh.positions;
  const n = P.length / 3;
  const s = new Float64Array(n);
  const t = new Float64Array(n);
  const h = new Float64Array(n);
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p: V3 = [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    s[i] = vdot(p, e1);
    t[i] = vdot(p, e2);
    h[i] = vdot(p, d);
    s0 = Math.min(s0, s[i]);
    s1 = Math.max(s1, s[i]);
    t0 = Math.min(t0, t[i]);
    t1 = Math.max(t1, t[i]);
  }
  if (!(s1 > s0) || !(t1 > t0)) return 0;
  const I = mesh.indices;
  let deepest = 0;
  for (let a = 0; a < rays; a++) {
    for (let b = 0; b < rays; b++) {
      // off a regular grid, so no ray runs exactly along a shared edge
      const rs = s0 + ((a + 0.5 + 0.137 * Math.sin(7 * a + 3 * b)) / rays) * (s1 - s0);
      const rt = t0 + ((b + 0.5 + 0.113 * Math.cos(5 * a + 11 * b)) / rays) * (t1 - t0);
      const hits: number[] = [];
      for (let k = 0; k < I.length; k += 3) {
        const i0 = I[k], i1 = I[k + 1], i2 = I[k + 2];
        const ax = s[i1] - s[i0], ay = t[i1] - t[i0], bx = s[i2] - s[i0], by = t[i2] - t[i0];
        const area = ax * by - ay * bx;
        if (Math.abs(area) < 1e-12) continue;
        const px = rs - s[i0], py = rt - t[i0];
        const u = (px * by - py * bx) / area;
        const v = (ax * py - ay * px) / area;
        if (u < 0 || v < 0 || u + v > 1) continue;
        hits.push(h[i0] + u * (h[i1] - h[i0]) + v * (h[i2] - h[i0]));
      }
      // a ray through a closed surface goes in and out in turn; one that grazes an edge is left out
      if (hits.length < 2 || hits.length % 2) continue;
      hits.sort((x, y) => x - y);
      for (let k = 0; k < hits.length; k += 2) deepest = Math.max(deepest, hits[k + 1] - hits[k]);
    }
  }
  return deepest;
}

/** How much deeper than its preload a sprung blade's overlap may run: the preview mesh's facets. */
export const preloadTolerance = (preload: number) => Math.max(0.05, 0.1 * preload);

export interface PreloadOverlap {
  host: EvalPart;
  mate: EvalPart;
  flex: FlexInfo;
  /** the overlap's deepest run along the blade's travel, mm */
  depth: number;
}

/** When an overlap is a sprung blade pressing on the part it bears on, by no more than its preload: the blade and how deep. */
export function preloadOverlap(i: Interference, partOf: (id: string) => EvalPart | undefined): PreloadOverlap | null {
  const A = partOf(i.a);
  const B = partOf(i.b);
  if (!A || !B || !i.mesh) return null;
  for (const [host, mate] of [
    [A, B],
    [B, A],
  ]) {
    for (const f of host.flex ?? []) {
      if (f.kind !== "flexure" || !f.preload || f.against !== mate.name) continue;
      const depth = depthAlong(i.mesh, applyXformsToDir(f.facing, host.xf));
      if (depth > 0 && depth <= f.preload + preloadTolerance(f.preload)) return { host, mate, flex: f, depth };
    }
  }
  return null;
}
