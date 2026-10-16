// Turns closed triangle meshes into a voxel grid with a fill fraction per
// cell. Rays are cast along +Z through each column at a few sub-sample
// positions; the length of each ray inside the solid gives the fill of every
// cell it crosses, exactly along Z and sampled across X and Y. Cells that are
// only partly inside keep a proportional stiffness, so walls that do not
// line up with the grid are not rounded to whole voxels.

export type V3 = [number, number, number];

export interface TriMesh {
  /** world-space vertex positions, xyz per vertex */
  positions: Float32Array | Float64Array;
  indices: Uint32Array;
}

export interface GridSpec {
  /** cell size, the same on every axis or per axis */
  h: number | V3;
  origin: V3;
  /** element counts along x, y, z */
  n: V3;
}

/** Per-cell fill fraction (0..1) of one mesh on a grid. */
export function voxelizeMesh(mesh: TriMesh, g: GridSpec, samples = 3): Float32Array {
  const [nx, ny, nz] = g.n;
  const [hx, hy, hz] = typeof g.h === "number" ? [g.h, g.h, g.h] : g.h;
  const [ox, oy, oz] = g.origin;
  const fill = new Float32Array(nx * ny * nz);
  const P = mesh.positions;
  const I = mesh.indices;
  const nt = I.length / 3;

  // bin triangles by the grid columns their XY footprint overlaps
  const bins: number[][] = new Array(nx * ny);
  for (let t = 0; t < nt; t++) {
    const a = I[3 * t] * 3,
      b = I[3 * t + 1] * 3,
      c = I[3 * t + 2] * 3;
    // skip triangles seen edge-on from above: a vertical ray cannot cross them
    const area2 = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]);
    if (Math.abs(area2) < 1e-14) continue;
    const x0 = Math.min(P[a], P[b], P[c]),
      x1 = Math.max(P[a], P[b], P[c]);
    const y0 = Math.min(P[a + 1], P[b + 1], P[c + 1]),
      y1 = Math.max(P[a + 1], P[b + 1], P[c + 1]);
    const i0 = Math.max(0, Math.floor((x0 - ox) / hx)),
      i1 = Math.min(nx - 1, Math.floor((x1 - ox) / hx));
    const j0 = Math.max(0, Math.floor((y0 - oy) / hy)),
      j1 = Math.min(ny - 1, Math.floor((y1 - oy) / hy));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = i + nx * j;
        (bins[k] ??= []).push(t);
      }
  }

  const s = Math.max(1, Math.round(samples));
  const w = 1 / (s * s * hz);
  // small irrational offsets so rays never run exactly along mesh edges or vertices
  const jx = 0.01371 * hx,
    jy = 0.02917 * hy;
  const hits: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const tris = bins[i + nx * j];
      if (!tris) continue;
      for (let sy = 0; sy < s; sy++)
        for (let sx = 0; sx < s; sx++) {
          const x = ox + (i + (sx + 0.5) / s) * hx + jx / s;
          const y = oy + (j + (sy + 0.5) / s) * hy + jy / s;
          hits.length = 0;
          for (const t of tris) {
            const a = I[3 * t] * 3,
              b = I[3 * t + 1] * 3,
              c = I[3 * t + 2] * 3;
            const ax = P[a] - x,
              ay = P[a + 1] - y,
              bx = P[b] - x,
              by = P[b + 1] - y,
              cx = P[c] - x,
              cy = P[c + 1] - y;
            const w0 = bx * cy - by * cx;
            const w1 = cx * ay - cy * ax;
            const w2 = ax * by - ay * bx;
            if ((w0 < 0 || w1 < 0 || w2 < 0) && (w0 > 0 || w1 > 0 || w2 > 0)) continue;
            const sum = w0 + w1 + w2;
            if (Math.abs(sum) < 1e-18) continue;
            hits.push((w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2]) / sum);
          }
          if (hits.length < 2) continue;
          hits.sort((p, q) => p - q);
          // even-odd rule: inside between consecutive pairs (an odd leftover means an open mesh; ignore it)
          for (let m = 0; m + 1 < hits.length; m += 2) {
            const z0 = hits[m] - oz,
              z1 = hits[m + 1] - oz;
            if (z1 <= z0) continue;
            const k0 = Math.max(0, Math.floor(z0 / hz)),
              k1 = Math.min(nz - 1, Math.floor(z1 / hz));
            for (let k = k0; k <= k1; k++) {
              const lo = Math.max(z0, k * hz),
                hi = Math.min(z1, (k + 1) * hz);
              if (hi > lo) fill[i + nx * (j + ny * k)] += (hi - lo) * w;
            }
          }
        }
    }
  for (let e = 0; e < fill.length; e++) if (fill[e] > 1) fill[e] = 1;
  return fill;
}

/** Enclosed volume of a closed mesh (divergence theorem); orientation-independent. */
export function meshVolume(mesh: TriMesh): number {
  const P = mesh.positions;
  const I = mesh.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3,
      b = I[t + 1] * 3,
      c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return Math.abs(v / 6);
}

export function meshBounds(meshes: TriMesh[]): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const P = m.positions;
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (P[i + k] < lo[k]) lo[k] = P[i + k];
        if (P[i + k] > hi[k]) hi[k] = P[i + k];
      }
  }
  return [lo, hi];
}

/** Box mesh helper (used by tests and as a reference shape). */
export function boxMesh(lo: V3, hi: V3): TriMesh {
  const p: number[] = [];
  for (let k = 0; k < 8; k++) p.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
  const f = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const idx: number[] = [];
  for (const [a, b, c, d] of f) idx.push(a, b, c, a, c, d);
  return { positions: new Float64Array(p), indices: new Uint32Array(idx) };
}
