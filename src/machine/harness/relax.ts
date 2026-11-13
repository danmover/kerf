// Relaxes routed cables together, as a real harness settles: each run is a
// chain of points that keeps its ends at the plugs, smooths its bends, keeps
// its own radius clear of every part, and pushes apart from the cables
// around it, so bundles sit side by side and crossings pass over each other
// instead of through. Each point is pushed from the nearest place on the
// cables around it (between their points, so a run is moved evenly along
// its length and stays smooth). The parts are felt through the router's
// signed distance field, then exactly (nearest point on the meshes) for the
// last rounds. Plain arithmetic: it runs in the cable worker and in Node tests.

import type { V3 } from "../../kernel/recipe";
import type { Solids } from "./solids";

/** Distance to the parts' surfaces at a point (positive outside them), from the router's grid. */
export interface SignedField {
  /** the grid's cell size, mm */
  h: number;
  phi(x: number, y: number, z: number): number;
  /** whether a point is outside the assembly (out in the open, not inside an enclosure) */
  outside?(x: number, y: number, z: number): boolean;
  /** which closed-off space inside the assembly a point is in (0 outside it, or in a part) */
  region?(x: number, y: number, z: number): number;
  /** whether a point is in a fan's intake or jet */
  flow?(x: number, y: number, z: number): boolean;
}

export interface RelaxInput {
  id: string;
  pts: V3[];
  /** outer radius, mm */
  r: number;
}

/** Room left between a cable and a part, and between two cables, mm. */
const CLEAR = 0.25;
const GAP = 0.1;
const ROUNDS = 36;
/** the last rounds measure the parts exactly */
const EXACT = 8;
const FAIR = 0.35;

/** A cell's key, wrapping every 1024 cells: far-apart cells that share one only cost a few extra distance checks. */
const cellKey = (x: number, y: number, z: number) => (x & 1023) | ((y & 1023) << 10) | ((z & 1023) << 20);

interface Chain {
  p: Float64Array;
  n: number;
  r: number;
  ends: [V3, V3];
}

/** Points along a polyline about `step` apart, keeping both ends. */
function resample(pts: V3[], step: number): Float64Array {
  if (pts.length < 2) return new Float64Array(pts.flat());
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const L = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(L / step) + 1);
  const out = new Float64Array(n * 3);
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const s = (L * k) / (n - 1);
    while (seg < pts.length - 1 && cum[seg] < s) seg++;
    const a = pts[seg - 1];
    const b = pts[seg];
    const t = cum[seg] > cum[seg - 1] ? (s - cum[seg - 1]) / (cum[seg] - cum[seg - 1]) : 0;
    for (let c = 0; c < 3; c++) out[k * 3 + c] = a[c] + (b[c] - a[c]) * Math.max(0, Math.min(1, t));
  }
  return out;
}

/** Relax every cable together and return their new centre lines, in the order given. */
export function relaxCables(cables: RelaxInput[], field: SignedField, solids: Solids | null): V3[][] {
  if (!cables.length) return [];
  const h = field.h;
  const chains: Chain[] = cables.map((c) => {
    const step = Math.max(0.7, Math.min(c.r * 1.2, h * 0.5));
    const p = resample(c.pts, step);
    return { p, n: p.length / 3, r: c.r, ends: [c.pts[0], c.pts[c.pts.length - 1]] };
  });
  const rMax = Math.max(...chains.map((c) => c.r));
  const cell = 2 * rMax + GAP + 0.01;
  // two cables that start at the same place (wires on one terminal, a splice) may touch there
  const sharedEnd = (a: Chain, b: Chain): V3[] => {
    const out: V3[] = [];
    for (const ea of a.ends) for (const eb of b.ends) if (Math.hypot(ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2]) < a.r + b.r + 1) out.push(ea);
    return out;
  };
  const shared = new Map<string, V3[]>();
  const sharedOf = (i: number, j: number) => {
    const key = i < j ? `${i}|${j}` : `${j}|${i}`;
    let s = shared.get(key);
    if (!s) shared.set(key, (s = sharedEnd(chains[i], chains[j])));
    return s;
  };
  const delta = chains.map((c) => new Float64Array(c.p.length));
  const best = new Map<number, { j: number; d2: number }>();
  const g: V3 = [0, 0, 0];
  // where each point was at the end of the last round, and whether that was clear of the parts:
  // a point that was clear never moves into one (a thin wall would let it out the other side)
  const prev = chains.map((c) => c.p.slice());
  const clear = chains.map((c) => {
    const out = new Uint8Array(c.n);
    for (let i = 0; i < c.n; i++) out[i] = field.phi(c.p[i * 3], c.p[i * 3 + 1], c.p[i * 3 + 2]) >= 0 ? 1 : 0;
    return out;
  });
  // likewise a point out of a fan's intake or jet stays out of it: smoothing a bend must not pull the cable back in
  const flow = field.flow;
  const calm = chains.map((c) => {
    const out = new Uint8Array(c.n);
    for (let i = 0; i < c.n; i++) out[i] = flow?.(c.p[i * 3], c.p[i * 3 + 1], c.p[i * 3 + 2]) ? 0 : 1;
    return out;
  });

  for (let round = 0; round < ROUNDS; round++) {
    // fair the bends
    for (const c of chains) {
      const q = c.p.slice();
      for (let i = 1; i < c.n - 1; i++) for (let k = 0; k < 3; k++) c.p[i * 3 + k] = q[i * 3 + k] + FAIR * (0.5 * (q[(i - 1) * 3 + k] + q[(i + 1) * 3 + k]) - q[i * 3 + k]);
    }
    // apart from each other
    const hash = new Map<number, number[]>();
    chains.forEach((c, ci) => {
      for (let i = 1; i < c.n - 1; i++) {
        const k = cellKey(Math.floor(c.p[i * 3] / cell), Math.floor(c.p[i * 3 + 1] / cell), Math.floor(c.p[i * 3 + 2] / cell));
        let list = hash.get(k);
        if (!list) hash.set(k, (list = []));
        list.push(ci, i);
      }
    });
    for (const d of delta) d.fill(0);
    chains.forEach((a, ai) => {
      for (let i = 1; i < a.n - 1; i++) {
        const x = a.p[i * 3],
          y = a.p[i * 3 + 1],
          z = a.p[i * 3 + 2];
        const cx = Math.floor(x / cell),
          cy = Math.floor(y / cell),
          cz = Math.floor(z / cell);
        // the nearest point of each cable around this one
        best.clear();
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dz = -1; dz <= 1; dz++) {
              const list = hash.get(cellKey(cx + dx, cy + dy, cz + dz));
              if (!list) continue;
              for (let m = 0; m < list.length; m += 2) {
                const bi = list[m];
                if (bi === ai) continue;
                const b = chains[bi];
                const j = list[m + 1];
                const ex = x - b.p[j * 3],
                  ey = y - b.p[j * 3 + 1],
                  ez = z - b.p[j * 3 + 2];
                const d2 = ex * ex + ey * ey + ez * ez;
                const was = best.get(bi);
                if (!was || d2 < was.d2) best.set(bi, { j, d2 });
              }
            }
        for (const [bi, hit] of best) {
          const b = chains[bi];
          const need = a.r + b.r + GAP;
          // the nearest place on that cable's centre line, between its points
          const j = hit.j;
          let qx = b.p[j * 3],
            qy = b.p[j * 3 + 1],
            qz = b.p[j * 3 + 2];
          let d2 = hit.d2;
          for (const o of [-1, 1]) {
            const k = j + o;
            if (k < 0 || k > b.n - 1) continue;
            const sx = b.p[k * 3] - b.p[j * 3],
              sy = b.p[k * 3 + 1] - b.p[j * 3 + 1],
              sz = b.p[k * 3 + 2] - b.p[j * 3 + 2];
            const l2 = sx * sx + sy * sy + sz * sz;
            if (l2 < 1e-12) continue;
            const t = Math.max(0, Math.min(1, ((x - b.p[j * 3]) * sx + (y - b.p[j * 3 + 1]) * sy + (z - b.p[j * 3 + 2]) * sz) / l2));
            const px = b.p[j * 3] + sx * t,
              py = b.p[j * 3 + 1] + sy * t,
              pz = b.p[j * 3 + 2] + sz * t;
            const e2 = (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2;
            if (e2 < d2) {
              d2 = e2;
              qx = px;
              qy = py;
              qz = pz;
            }
          }
          if (d2 >= need * need) continue;
          const near = sharedOf(ai, bi);
          if (near.length && near.some((e) => Math.hypot(x - e[0], y - e[1], z - e[2]) < 4 * need + 4 && Math.hypot(qx - e[0], qy - e[1], qz - e[2]) < 4 * need + 4)) continue;
          const d = Math.sqrt(d2);
          const tx = a.p[(i + 1) * 3] - a.p[(i - 1) * 3],
            ty = a.p[(i + 1) * 3 + 1] - a.p[(i - 1) * 3 + 1],
            tz = a.p[(i + 1) * 3 + 2] - a.p[(i - 1) * 3 + 2];
          let ux: number, uy: number, uz: number;
          if (d > 1e-6) {
            ux = (x - qx) / d;
            uy = (y - qy) / d;
            uz = (z - qz) / d;
          } else {
            // on top of each other: split them across the run, the same way every round (the later cable gives way to +s)
            const s = Math.abs(tz) < 0.9 * Math.hypot(tx, ty, tz) ? [ty, -tx, 0] : [0, tz, -ty];
            const l = (Math.hypot(s[0], s[1], s[2]) || 1) * (ai < bi ? 1 : -1);
            ux = s[0] / l;
            uy = s[1] / l;
            uz = s[2] / l;
          }
          const push = (need - d) / 2;
          delta[ai][i * 3] += ux * push;
          delta[ai][i * 3 + 1] += uy * push;
          delta[ai][i * 3 + 2] += uz * push;
        }
      }
    });
    chains.forEach((c, ci) => {
      const d = delta[ci];
      for (let i = 1; i < c.n - 1; i++) {
        const l = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
        if (!l) continue;
        // a point squeezed from several sides moves no more than one cable's width a round
        const s = Math.min(1, (2 * c.r) / l) * 0.8;
        for (let k = 0; k < 3; k++) c.p[i * 3 + k] += d[i * 3 + k] * s;
      }
    });
    // out of the parts, last, so they win over everything else
    const exact = solids && round >= ROUNDS - EXACT;
    chains.forEach((c, ci) => {
      const need = c.r + CLEAR;
      const was = prev[ci];
      const ok = clear[ci];
      const still = calm[ci];
      const back = (i: number) => {
        for (let k = 0; k < 3; k++) c.p[i * 3 + k] = was[i * 3 + k];
      };
      // whether a move from one place to another goes through a part's own surface
      const crosses = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
        const len = Math.hypot(bx - ax, by - ay, bz - az);
        return len > 1e-6 && !!solids!.raycast([ax, ay, az], [(bx - ax) / len, (by - ay) / len, (bz - az) / len], len);
      };
      for (let i = 1; i < c.n - 1; i++) {
        const x = c.p[i * 3],
          y = c.p[i * 3 + 1],
          z = c.p[i * 3 + 2];
        if (flow && still[i] && flow(x, y, z)) {
          back(i);
          continue;
        }
        // a point in a place the field calls solid (a socket in the gap behind a board, a plug inside a bought part's
        // filled box) has no field to hold it there: it never goes through a part's own surface on its way out
        if (solids && !ok[i] && crosses(was[i * 3], was[i * 3 + 1], was[i * 3 + 2], x, y, z)) {
          back(i);
          continue;
        }
        const f = field.phi(x, y, z);
        if (f >= need + (exact ? h : 0)) continue;
        if (f < 0 && ok[i]) {
          back(i);
          continue;
        }
        if (exact) {
          const hit = solids!.nearest([x, y, z], need + h);
          if (!hit) continue;
          if (hit.inside) {
            // moved in this round from a place that was truly clear: back there
            const before = ok[i] ? solids!.nearest([was[i * 3], was[i * 3 + 1], was[i * 3 + 2]], need + h) : null;
            if (ok[i] && !before?.inside) {
              back(i);
              continue;
            }
            // it was in already. Grazing a face the grid's field is too coarse to see (the rounded side of a part,
            // a sharp edge): out through that face. Deep in, where the search had to cut through a part: left there
            if (hit.d > Math.max(1, need)) continue;
          } else if (hit.d >= need) continue;
          let ux = hit.inside ? hit.at[0] - x : x - hit.at[0];
          let uy = hit.inside ? hit.at[1] - y : y - hit.at[1];
          let uz = hit.inside ? hit.at[2] - z : z - hit.at[2];
          const l = Math.hypot(ux, uy, uz);
          if (l < 1e-9) continue;
          ux /= l;
          uy /= l;
          uz /= l;
          c.p[i * 3] = hit.at[0] + ux * need;
          c.p[i * 3 + 1] = hit.at[1] + uy * need;
          c.p[i * 3 + 2] = hit.at[2] + uz * need;
          continue;
        }
        const e = 0.3 * h;
        g[0] = field.phi(x + e, y, z) - field.phi(x - e, y, z);
        g[1] = field.phi(x, y + e, z) - field.phi(x, y - e, z);
        g[2] = field.phi(x, y, z + e) - field.phi(x, y, z - e);
        const l = Math.hypot(g[0], g[1], g[2]);
        if (l < 1e-9) continue;
        const move = Math.min(h, need - f);
        if (solids && !ok[i] && crosses(x, y, z, x + (g[0] / l) * move, y + (g[1] / l) * move, z + (g[2] / l) * move)) continue;
        for (let k = 0; k < 3; k++) c.p[i * 3 + k] += (g[k] / l) * move;
      }
      for (let i = 0; i < c.n; i++) {
        if (!ok[i]) ok[i] = field.phi(c.p[i * 3], c.p[i * 3 + 1], c.p[i * 3 + 2]) >= 0 ? 1 : 0;
        if (flow && !still[i]) still[i] = flow(c.p[i * 3], c.p[i * 3 + 1], c.p[i * 3 + 2]) ? 0 : 1;
      }
      was.set(c.p);
    });
  }
  return chains.map((c) => {
    const out: V3[] = [];
    for (let i = 0; i < c.n; i++) out.push([c.p[i * 3], c.p[i * 3 + 1], c.p[i * 3 + 2]]);
    return out;
  });
}
