// Air loads, one way: an airflow run's surface pressure and skin friction carried onto the solver's surface.
//
// The run gives the pressure coefficient and the friction at each point of a part's surface mesh. A CAD mesh can be
// coarse (a flat face may be two triangles), so the triangles are first filled with points about one element apart,
// with the values blended across each triangle, and each face of the solver's grid then reads the nearest point that
// faces the same way (a thin wall's two sides stay apart).

import type { AirPartField, V3 } from "../spec";

export interface AirSamples {
  count: number;
  pos: Float32Array;
  nrm: Float32Array;
  cp: Float32Array;
  cf: Float32Array;
  cell: number;
  lo: V3;
  dims: V3;
  cells: Map<number, number[]>;
}

/** at most this many points per part; past it the spacing grows */
const MAX_SAMPLES = 1_500_000;

/** Points over the part's surface about `spacing` apart, each with the pressure, friction and outward normal there. */
export function airSamples(part: AirPartField, spacing: number, cell: number): AirSamples {
  const P = part.positions;
  const I = part.indices;
  const N = part.normals;
  const nt = I.length / 3;
  // how many points each triangle gets, then the spacing that keeps the whole within bounds
  const edge = (a: number, b: number) => Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]);
  const longest = new Float32Array(nt);
  let estimate = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[3 * t],
      b = I[3 * t + 1],
      c = I[3 * t + 2];
    longest[t] = Math.max(edge(a, b), edge(b, c), edge(c, a));
    const n = Math.max(1, Math.ceil(longest[t] / spacing));
    estimate += ((n + 1) * (n + 2)) / 2;
  }
  let step = spacing;
  if (estimate > MAX_SAMPLES) step *= Math.sqrt(estimate / MAX_SAMPLES);
  const pos: number[] = [];
  const nrm: number[] = [];
  const cp: number[] = [];
  const cf: number[] = [];
  for (let t = 0; t < nt; t++) {
    const v = [I[3 * t], I[3 * t + 1], I[3 * t + 2]];
    const A: V3 = [P[3 * v[0]], P[3 * v[0] + 1], P[3 * v[0] + 2]];
    const B: V3 = [P[3 * v[1]], P[3 * v[1] + 1], P[3 * v[1] + 2]];
    const C: V3 = [P[3 * v[2]], P[3 * v[2] + 1], P[3 * v[2] + 2]];
    const u: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const w: V3 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    let n: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const nl = Math.hypot(...n);
    if (nl < 1e-12) continue;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    // the run's normals point out; a triangle wound the other way is turned round to match them
    if (N) {
      const s = v.reduce((acc, k) => acc + N[3 * k] * n[0] + N[3 * k + 1] * n[1] + N[3 * k + 2] * n[2], 0);
      if (s < 0) n = [-n[0], -n[1], -n[2]];
    }
    const k = Math.max(1, Math.ceil(longest[t] / step));
    for (let i = 0; i <= k; i++)
      for (let j = 0; j <= k - i; j++) {
        const b1 = i / k,
          b2 = j / k,
          b0 = 1 - b1 - b2;
        const wts = [b0, b1, b2];
        // the pressure blended from the corners the air reaches (a corner with none, NaN, is left out)
        let sw = 0,
          sp = 0,
          fx = 0,
          fy = 0,
          fz = 0;
        for (let q = 0; q < 3; q++) {
          const c = part.cp[v[q]];
          if (!Number.isFinite(c)) continue;
          const wq = wts[q] + 1e-6;
          sw += wq;
          sp += wq * c;
          fx += wq * part.cf[3 * v[q]];
          fy += wq * part.cf[3 * v[q] + 1];
          fz += wq * part.cf[3 * v[q] + 2];
        }
        if (!(sw > 0)) continue;
        pos.push(b0 * A[0] + b1 * B[0] + b2 * C[0], b0 * A[1] + b1 * B[1] + b2 * C[1], b0 * A[2] + b1 * B[2] + b2 * C[2]);
        nrm.push(n[0], n[1], n[2]);
        cp.push(sp / sw);
        cf.push(fx / sw, fy / sw, fz / sw);
      }
  }
  const count = cp.length;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let s = 0; s < count; s++)
    for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d], pos[3 * s + d]);
      hi[d] = Math.max(hi[d], pos[3 * s + d]);
    }
  const dims: V3 = count ? [Math.floor((hi[0] - lo[0]) / cell) + 1, Math.floor((hi[1] - lo[1]) / cell) + 1, Math.floor((hi[2] - lo[2]) / cell) + 1] : [0, 0, 0];
  const cells = new Map<number, number[]>();
  for (let s = 0; s < count; s++) {
    const key = cellKey(dims, Math.floor((pos[3 * s] - lo[0]) / cell), Math.floor((pos[3 * s + 1] - lo[1]) / cell), Math.floor((pos[3 * s + 2] - lo[2]) / cell));
    const list = cells.get(key);
    if (list) list.push(s);
    else cells.set(key, [s]);
  }
  return { count, pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), cp: Float32Array.from(cp), cf: Float32Array.from(cf), cell, lo, dims, cells };
}

const cellKey = (dims: V3, i: number, j: number, k: number) => i + dims[0] * (j + dims[1] * k);

/** The point nearest p on the side facing n (within one cell each way), or −1 when there is none. */
export function nearestSample(S: AirSamples, p: V3, n: V3): number {
  if (!S.count) return -1;
  const ci = Math.floor((p[0] - S.lo[0]) / S.cell),
    cj = Math.floor((p[1] - S.lo[1]) / S.cell),
    ck = Math.floor((p[2] - S.lo[2]) / S.cell);
  let best = -1;
  let bestD = Infinity;
  for (let dk = -1; dk <= 1; dk++) {
    const k = ck + dk;
    if (k < 0 || k >= S.dims[2]) continue;
    for (let dj = -1; dj <= 1; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= S.dims[1]) continue;
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        if (i < 0 || i >= S.dims[0]) continue;
        const list = S.cells.get(cellKey(S.dims, i, j, k));
        if (!list) continue;
        for (const s of list) {
          // a point on the other side of a thin wall faces away
          if (S.nrm[3 * s] * n[0] + S.nrm[3 * s + 1] * n[1] + S.nrm[3 * s + 2] * n[2] < -0.3) continue;
          const dx = S.pos[3 * s] - p[0],
            dy = S.pos[3 * s + 1] - p[1],
            dz = S.pos[3 * s + 2] - p[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD) {
            bestD = d2;
            best = s;
          }
        }
      }
    }
  }
  return bestD <= S.cell * S.cell ? best : -1;
}

/**
 * The factor that makes the pressures read off the surface add up to the force the run measured on the part (surface
 * pressures read low next to the measured force, and a coarse mesh blurs them): the force's share along what they add
 * up to, kept within 0.33 to 3. 1 when they point too far apart for a factor to mean anything.
 */
export function airScale(got: V3, want: V3): number {
  const gg = got[0] * got[0] + got[1] * got[1] + got[2] * got[2];
  const ww = Math.hypot(want[0], want[1], want[2]);
  if (!(gg > 1e-18) || !(ww > 1e-12)) return 1;
  const along = (got[0] * want[0] + got[1] * want[1] + got[2] * want[2]) / Math.sqrt(gg);
  if (along < 0.5 * ww) return 1;
  return Math.min(3, Math.max(1 / 3, along / Math.sqrt(gg)));
}
