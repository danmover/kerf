// From the parts to the cells the flow is solved on: a box of equal cubes round the parts with a margin of still
// surroundings, each cell air, solid (and which part) or the surroundings themselves (the outer layer, held at the
// ambient pressure and temperature). Solids are found by casting rays along all three axes through the cell centres:
// a cell is solid where its centre is inside a part, and every stretch of a part a ray crosses fills at least the
// cell its middle is in, so a wall thinner than a cell still stops the air (it is drawn a cell thick). Fans are built
// from their size: frame and hub solid, the annulus between them air the fan pushes.

import type { FlowBody, FlowFan, V3 } from "./types";

export const FLUID = 0;
export const SOLID = 1;
export const AMBIENT = 2;

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  /** cell size, mm and m */
  hmm: number;
  h: number;
  /** the box's low corner, mm */
  origin: V3;
  kind: Uint8Array;
  /** the body a solid cell belongs to (index into bodies, fans' frames at the end), else −1 */
  body: Int32Array;
  /** the fan whose annulus an air cell is in, else −1 */
  fan: Int16Array;
  /** distance from an air cell's centre to the nearest solid, m */
  wall: Float64Array;
  /** sealed pockets of air (not open to the surroundings): one cell of each, and the pocket of every air cell (−1 open) */
  pockets: number[];
  pocket: Int32Array;
  /** cells per body */
  bodyCells: Int32Array;
  bodies: FlowBody[];
  /** the index in bodies of each fan's frame */
  frames: number[];
  /** a body mesh that was not closed (an odd number of crossings on some rays) */
  leaky: string[];
}

const EPS_B = 1.3e-4 * (Math.SQRT2 - 1);
const EPS_C = 1.7e-4 * ((Math.sqrt(5) - 1) / 2);

/** Mark the cells inside one mesh (rays along each axis), calling mark for each. Returns false when a ray crossed it an odd number of times. */
function voxelize(P: Float32Array, I: Uint32Array, D: V3, o: V3, h: number, mark: (c: number) => void): boolean {
  let closed = true;
  const nt = I.length / 3;
  const strides: V3 = [1, D[0], D[0] * D[1]];
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    const nb = D[b];
    const nc = D[c];
    // bin triangles by the columns (b, c) their shadow covers
    const count = new Int32Array(nb * nc + 1);
    const range = new Int32Array(nt * 4);
    for (let t = 0; t < nt; t++) {
      const p0 = I[3 * t] * 3;
      const p1 = I[3 * t + 1] * 3;
      const p2 = I[3 * t + 2] * 3;
      const bmin = Math.min(P[p0 + b], P[p1 + b], P[p2 + b]);
      const bmax = Math.max(P[p0 + b], P[p1 + b], P[p2 + b]);
      const cmin = Math.min(P[p0 + c], P[p1 + c], P[p2 + c]);
      const cmax = Math.max(P[p0 + c], P[p1 + c], P[p2 + c]);
      const i0 = Math.max(0, Math.ceil((bmin - o[b]) / h - 0.5 - EPS_B));
      const i1 = Math.min(nb - 1, Math.floor((bmax - o[b]) / h - 0.5 - EPS_B));
      const j0 = Math.max(0, Math.ceil((cmin - o[c]) / h - 0.5 - EPS_C));
      const j1 = Math.min(nc - 1, Math.floor((cmax - o[c]) / h - 0.5 - EPS_C));
      range[4 * t] = i0;
      range[4 * t + 1] = i1;
      range[4 * t + 2] = j0;
      range[4 * t + 3] = j1;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) count[i + nb * j + 1]++;
    }
    for (let q = 1; q <= nb * nc; q++) count[q] += count[q - 1];
    const tris = new Int32Array(count[nb * nc]);
    const fill = count.slice(0, nb * nc);
    for (let t = 0; t < nt; t++) for (let j = range[4 * t + 2]; j <= range[4 * t + 3]; j++) for (let i = range[4 * t]; i <= range[4 * t + 1]; i++) tris[fill[i + nb * j]++] = t;
    const hits: number[] = [];
    for (let j = 0; j < nc; j++)
      for (let i = 0; i < nb; i++) {
        const col = i + nb * j;
        if (count[col] === count[col + 1]) continue;
        const yb = o[b] + (i + 0.5 + EPS_B) * h;
        const yc = o[c] + (j + 0.5 + EPS_C) * h;
        hits.length = 0;
        for (let q = count[col]; q < count[col + 1]; q++) {
          const t = tris[q];
          const p0 = I[3 * t] * 3;
          const p1 = I[3 * t + 1] * 3;
          const p2 = I[3 * t + 2] * 3;
          const ab = P[p1 + b] - P[p0 + b];
          const ac = P[p1 + c] - P[p0 + c];
          const bb = P[p2 + b] - P[p0 + b];
          const bc = P[p2 + c] - P[p0 + c];
          const det = ab * bc - ac * bb;
          if (Math.abs(det) < 1e-14) continue;
          const qb = yb - P[p0 + b];
          const qc = yc - P[p0 + c];
          const u = (qb * bc - qc * bb) / det;
          const v = (ab * qc - ac * qb) / det;
          if (u < 0 || v < 0 || u + v > 1) continue;
          hits.push(P[p0 + a] + u * (P[p1 + a] - P[p0 + a]) + v * (P[p2 + a] - P[p0 + a]));
        }
        if (hits.length < 2) {
          if (hits.length) closed = false;
          continue;
        }
        hits.sort((x, y) => x - y);
        if (hits.length % 2) closed = false;
        const base = i * strides[b] + j * strides[c];
        for (let q = 0; q + 1 < hits.length; q += 2) {
          const s0 = (hits[q] - o[a]) / h - 0.5;
          const s1 = (hits[q + 1] - o[a]) / h - 0.5;
          const k0 = Math.max(0, Math.ceil(s0));
          const k1 = Math.min(D[a] - 1, Math.floor(s1));
          if (k1 >= k0) for (let k = k0; k <= k1; k++) mark(base + k * strides[a]);
          else {
            const k = Math.floor((s0 + s1) / 2 + 0.5);
            if (k >= 0 && k < D[a]) mark(base + k * strides[a]);
          }
        }
      }
  }
  return closed;
}

/** Squared distance transform along one line (Felzenszwalb and Huttenlocher 2012), f "far" as a large number. */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

const FAR = 1e20;

/** Distance from every cell to the nearest solid cell, in cells (about 1e10 with no solid at all). */
function distanceToSolid(kind: Uint8Array, nx: number, ny: number, nz: number): Float64Array {
  const N = nx * ny * nz;
  const g = new Float64Array(N);
  for (let c = 0; c < N; c++) g[c] = kind[c] === SOLID ? 0 : FAR;
  const n = Math.max(nx, ny, nz);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (len: number, count: number, at: (line: number, q: number) => number) => {
    for (let line = 0; line < count; line++) {
      for (let q = 0; q < len; q++) f[q] = g[at(line, q)];
      edt1(f, len, d, v, z);
      for (let q = 0; q < len; q++) g[at(line, q)] = d[q];
    }
  };
  pass(nx, ny * nz, (line, q) => q + nx * line);
  pass(ny, nx * nz, (line, q) => (line % nx) + nx * (q + ny * Math.floor(line / nx)));
  pass(nz, nx * ny, (line, q) => line + nx * ny * q);
  for (let c = 0; c < N; c++) g[c] = Math.sqrt(g[c]);
  return g;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The grid for a set of bodies and fans: cell size hmm, margin mm of surroundings on every side. */
export function buildGrid(bodies: FlowBody[], fans: FlowFan[], hmm: number, margin: number, lo0?: V3, hi0?: V3): Grid {
  // the box round every body and fan
  const lo: V3 = lo0 ? [...lo0] : [Infinity, Infinity, Infinity];
  const hi: V3 = hi0 ? [...hi0] : [-Infinity, -Infinity, -Infinity];
  if (!lo0 || !hi0) {
    for (const b of bodies)
      for (let i = 0; i < b.positions.length; i += 3)
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], b.positions[i + a]);
          hi[a] = Math.max(hi[a], b.positions[i + a]);
        }
    for (const f of fans) {
      const r = f.size * 0.75;
      for (let a = 0; a < 3; a++) {
        const e = [f.at[a], f.at[a] + f.axis[a] * f.depth];
        lo[a] = Math.min(lo[a], Math.min(...e) - r);
        hi[a] = Math.max(hi[a], Math.max(...e) + r);
      }
    }
  }
  const D: V3 = [0, 0, 0];
  const origin: V3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    // margin, plus one cell for the surroundings' layer
    const len = hi[a] - lo[a] + 2 * margin;
    D[a] = Math.max(3, Math.ceil(len / hmm) + 2);
    origin[a] = (lo[a] + hi[a]) / 2 - (D[a] * hmm) / 2;
  }
  const [nx, ny, nz] = D;
  const N = nx * ny * nz;
  const kind = new Uint8Array(N);
  const body = new Int32Array(N).fill(-1);
  const fan = new Int16Array(N).fill(-1);
  const prio = new Int8Array(N).fill(-1);
  const all = [...bodies];
  const leaky: string[] = [];
  bodies.forEach((b, bi) => {
    if (!b.indices.length) return;
    const pr = (b.watts > 0 ? 2 : 0) + (b.component ? 1 : 0);
    const ok = voxelize(b.positions, b.indices, D, origin, hmm, (c) => {
      if (pr > prio[c]) {
        prio[c] = pr;
        body[c] = bi;
        kind[c] = SOLID;
      }
    });
    if (!ok) leaky.push(b.name);
  });
  // fans: hub and frame solid, the annulus air the fan drives
  const frames: number[] = [];
  fans.forEach((f, fi) => {
    const fb = all.length;
    frames.push(fb);
    all.push({
      id: `${f.id}:frame`,
      name: `${f.name} frame and hub`,
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      k: 0.25,
      watts: f.watts ?? 0,
      ...(f.heatWhy ? { heatWhy: f.heatWhy } : {}),
      ...(f.maxC !== undefined ? { maxC: f.maxC, limitWhy: f.limitWhy } : {}),
      emissivity: 0.9,
      material: "PBT",
      component: true,
    });
    const other: V3 = [f.axis[1] * f.side[2] - f.axis[2] * f.side[1], f.axis[2] * f.side[0] - f.axis[0] * f.side[2], f.axis[0] * f.side[1] - f.axis[1] * f.side[0]];
    const reach = f.size * 0.75 + f.depth;
    const ci = (x: number, a: number) => Math.floor((x - origin[a]) / hmm);
    const c0 = [0, 1, 2].map((a) => Math.max(0, ci(f.at[a] - reach, a)));
    const c1 = [0, 1, 2].map((a) => Math.min(D[a] - 1, ci(f.at[a] + reach, a)));
    for (let k = c0[2]; k <= c1[2]; k++)
      for (let j = c0[1]; j <= c1[1]; j++)
        for (let i = c0[0]; i <= c1[0]; i++) {
          const p: V3 = [origin[0] + (i + 0.5) * hmm - f.at[0], origin[1] + (j + 0.5) * hmm - f.at[1], origin[2] + (k + 0.5) * hmm - f.at[2]];
          const s = dot(p, f.axis);
          if (s < 0 || s > f.depth) continue;
          const e1 = dot(p, f.side);
          const e2 = dot(p, other);
          if (Math.abs(e1) > f.size / 2 || Math.abs(e2) > f.size / 2) continue;
          const r = Math.hypot(e1, e2);
          const c = i + nx * (j + ny * k);
          if (r <= f.hub / 2 || r > f.bore / 2) {
            kind[c] = SOLID;
            body[c] = fb;
            fan[c] = -1;
          } else {
            kind[c] = FLUID;
            body[c] = -1;
            fan[c] = fi;
          }
        }
  });
  // the surroundings: the outer layer
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) {
          const c = i + nx * (j + ny * k);
          kind[c] = AMBIENT;
          body[c] = -1;
          fan[c] = -1;
        }
  const bodyCells = new Int32Array(all.length);
  for (let c = 0; c < N; c++) if (body[c] >= 0) bodyCells[body[c]]++;

  // wall distance: from the centre to the nearest solid's face
  const dist = distanceToSolid(kind, nx, ny, nz);
  const h = hmm / 1000;
  const wall = new Float64Array(N);
  for (let c = 0; c < N; c++) wall[c] = kind[c] === SOLID ? 0 : Math.max(0.5, dist[c] - 0.5) * h;

  // air that the surroundings cannot reach: sealed pockets
  const pocket = new Int32Array(N).fill(-2);
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  for (let c = 0; c < N; c++)
    if (kind[c] === AMBIENT) {
      pocket[c] = -1;
      queue[qt++] = c;
    }
  const sxy = nx * ny;
  const flood = (label: number) => {
    while (qh < qt) {
      const c = queue[qh++];
      const i = c % nx;
      const j = ((c - i) / nx) % ny;
      const k = (c - i - nx * j) / sxy;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1, k > 0 ? c - sxy : -1, k < nz - 1 ? c + sxy : -1];
      for (const n of nb)
        if (n >= 0 && kind[n] === FLUID && pocket[n] === -2) {
          pocket[n] = label;
          queue[qt++] = n;
        }
    }
  };
  flood(-1);
  const pockets: number[] = [];
  for (let c = 0; c < N; c++)
    if (kind[c] === FLUID && pocket[c] === -2) {
      const label = pockets.length;
      pockets.push(c);
      pocket[c] = label;
      qh = 0;
      qt = 0;
      queue[qt++] = c;
      flood(label);
    }
  return { nx, ny, nz, hmm, h, origin, kind, body, fan, wall, pockets, pocket, bodyCells, bodies: all, frames, leaky };
}

/** The cell a point (mm) is in, or −1 outside the grid. */
export function cellAt(g: Grid, p: V3): number {
  const i = Math.floor((p[0] - g.origin[0]) / g.hmm);
  const j = Math.floor((p[1] - g.origin[1]) / g.hmm);
  const k = Math.floor((p[2] - g.origin[2]) / g.hmm);
  if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return -1;
  return i + g.nx * (j + g.ny * k);
}

/** The centre of a cell, mm. */
export function cellCentre(g: Grid, c: number): V3 {
  const i = c % g.nx;
  const j = ((c - i) / g.nx) % g.ny;
  const k = (c - i - g.nx * j) / (g.nx * g.ny);
  return [g.origin[0] + (i + 0.5) * g.hmm, g.origin[1] + (j + 0.5) * g.hmm, g.origin[2] + (k + 0.5) * g.hmm];
}
