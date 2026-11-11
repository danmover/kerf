// The result inside the parts, for a section through them: the solver's node values on a regular grid that the
// viewport turns into 3D textures for the cut face, and reads back where the cursor points.

import type { V3 } from "./voxel";

/**
 * The result inside the parts, for a section through them: samples on a regular grid (the solver's nodes, averaged in
 * blocks on a large model), filled a little way past the surface so they blend cleanly up to it.
 */
export interface ResultVolume {
  /** the first sample's position and the spacing of the samples, mm */
  origin: V3;
  step: V3;
  /** samples along x, y and z (x varies fastest) */
  n: [number, number, number];
  /** per sample: displacement xyz (mm); none for temperatures alone */
  disp?: Float32Array;
  /** von Mises stress (MPa), largest principal strain, and utilisation (1 / factor of safety) */
  stress?: Float32Array;
  strain?: Float32Array;
  util?: Float32Array;
  /** °C, and fatigue life over the design life as log10, when the result has them */
  temp?: Float32Array;
  life?: Float32Array;
  /** current density, A/mm², when current runs through the parts */
  current?: Float32Array;
}

/**
 * Node values on a regular grid, kept to about 200k samples (blocks of s × s × s nodes averaged on a large model) and
 * filled two samples past the surface from the samples inside, so sampling between them near the surface does not
 * blend in the empty outside.
 */
export function sampleInterior(
  grid: { n: [number, number, number]; origin: V3; h: V3 },
  has: (n: number) => boolean,
  scalars: ((n: number) => number)[],
  vec?: Float64Array,
): { origin: V3; step: V3; n: [number, number, number]; scalars: Float32Array[]; vec: Float32Array | null } {
  const [NX, NY, NZ] = grid.n;
  const s = Math.max(1, Math.ceil(Math.cbrt((NX * NY * NZ) / 200_000)));
  const vx = Math.ceil(NX / s),
    vy = Math.ceil(NY / s),
    vz = Math.ceil(NZ / s);
  const nv = vx * vy * vz;
  const out = scalars.map(() => new Float32Array(nv));
  const vo = vec ? new Float32Array(3 * nv) : null;
  const cnt = new Float32Array(nv);
  for (let k = 0; k < NZ; k++)
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const n = i + NX * (j + NY * k);
        if (!has(n)) continue;
        const q = Math.floor(i / s) + vx * (Math.floor(j / s) + vy * Math.floor(k / s));
        cnt[q]++;
        if (vo && vec) for (let d = 0; d < 3; d++) vo[3 * q + d] += vec[3 * n + d];
        for (let f = 0; f < scalars.length; f++) out[f][q] += scalars[f](n);
      }
  for (let q = 0; q < nv; q++) {
    const c = cnt[q];
    if (!c) continue;
    if (vo) for (let d = 0; d < 3; d++) vo[3 * q + d] /= c;
    for (const a of out) a[q] /= c;
  }
  for (let pass = 0; pass < 2; pass++) {
    const fillFrom: [number, number[]][] = [];
    for (let k = 0; k < vz; k++)
      for (let j = 0; j < vy; j++)
        for (let i = 0; i < vx; i++) {
          const q = i + vx * (j + vy * k);
          if (cnt[q]) continue;
          const nb = [i > 0 ? q - 1 : -1, i < vx - 1 ? q + 1 : -1, j > 0 ? q - vx : -1, j < vy - 1 ? q + vx : -1, k > 0 ? q - vx * vy : -1, k < vz - 1 ? q + vx * vy : -1].filter((b) => b >= 0 && cnt[b] > 0);
          if (nb.length) fillFrom.push([q, nb]);
        }
    for (const [q, nb] of fillFrom) {
      const w = 1 / nb.length;
      for (const b of nb) {
        if (vo) for (let d = 0; d < 3; d++) vo[3 * q + d] += w * vo[3 * b + d];
        for (const a of out) a[q] += w * a[b];
      }
    }
    for (const [q] of fillFrom) cnt[q] = 0.5;
  }
  const half = (s - 1) / 2;
  const [hx, hy, hz] = grid.h;
  return { origin: [grid.origin[0] + half * hx, grid.origin[1] + half * hy, grid.origin[2] + half * hz], step: [s * hx, s * hy, s * hz], n: [vx, vy, vz], scalars: out, vec: vo };
}

/** A value between the samples at a point, trilinear (the samples sit at origin + i·step; outside, the nearest edge). */
export function sampleVolume(v: ResultVolume, get: (q: number) => number, p: V3): number {
  const [nx, ny, nz] = v.n;
  let sum = 0;
  const i0 = [0, 0, 0];
  const t = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const x = Math.min(Math.max((p[d] - v.origin[d]) / v.step[d], 0), v.n[d] - 1);
    i0[d] = Math.max(0, Math.min(Math.floor(x), v.n[d] - 2));
    t[d] = v.n[d] < 2 ? 0 : x - i0[d];
  }
  for (let c = 0; c < 8; c++) {
    const a = c & 1,
      b = (c >> 1) & 1,
      e = (c >> 2) & 1;
    const w = (a ? t[0] : 1 - t[0]) * (b ? t[1] : 1 - t[1]) * (e ? t[2] : 1 - t[2]);
    if (!w) continue;
    const i = Math.min(i0[0] + a, nx - 1),
      j = Math.min(i0[1] + b, ny - 1),
      k = Math.min(i0[2] + e, nz - 1);
    sum += w * get(i + nx * (j + ny * k));
  }
  return sum;
}
