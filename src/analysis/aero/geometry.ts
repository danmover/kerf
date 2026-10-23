// From triangle meshes to the lattice: which cells are solid, where each
// wall link crosses the surface, how far each wall cell is from the nearest
// surface and which way it faces, and how much of a cell is filled by
// geometry too thin to make a solid cell of its own. Meshes are already in
// lattice coordinates (cell centres at whole numbers). Overlapping closed
// meshes are fine: solids are the union, and a link's first crossing is
// always on the union's outer surface.

import { FARFIELD, FLUID, INDEX_SHIFT, CX, CY, CZ, Q, SOLID, TYPE_MASK } from "./lattice";
import type { Records } from "./case";

export type V3 = [number, number, number];

export interface Body {
  /** lattice-space vertex positions, xyz per vertex */
  positions: Float32Array | Float64Array;
  indices: Uint32Array;
  /** index into the case's part motions (and the per-part forces) */
  part: number;
}

export interface GridGeometry {
  nx: number;
  ny: number;
  nz: number;
  bodies: Body[];
  /** a road: cells whose centres lie below this height are solid, owned by groundPart */
  ground?: { z: number; part: number };
  periodic?: [boolean, boolean, boolean];
}

export interface GridBuild {
  flags: Uint32Array;
  rec: Records;
  /** wall links whose crossing was not found on the mesh (an open mesh or a sliver), set halfway */
  missed: number;
  solidCells: number;
}

const EPS = 1e-9;

/** Solid cells, far-field cells and boundary records for a set of bodies on a grid. */
export function buildGrid(g: GridGeometry, nParts: number): GridBuild {
  const { nx, ny, nz } = g;
  const N = nx * ny * nz;
  const flags = new Uint32Array(N);
  const [px, py, pz] = g.periodic ?? [false, false, false];
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  // far field round the outside: the inlet plane, the sides and the top (and the bottom with no road)
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const edge = (!px && x === 0) || (!py && (y === 0 || y === ny - 1)) || (!pz && (z === nz - 1 || (z === 0 && !g.ground)));
        if (edge) flags[idx(x, y, z)] = FARFIELD;
      }

  // solids: centre ray parity per column; partial fill from a 3×3 bundle of rays
  const fill = new Map<number, { phi: number; part: number }>();
  for (const b of g.bodies) voxelizeBody(b, g, flags, fill);
  if (g.ground) {
    const zg = g.ground.z;
    for (let z = 0; z < nz && z < zg; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const n = idx(x, y, z);
          if ((flags[n] & TYPE_MASK) !== SOLID) flags[n] = SOLID | (g.ground.part << INDEX_SHIFT);
        }
  }
  const wrapY = (y: number) => (py ? (y + ny) % ny : Math.min(ny - 1, Math.max(0, y)));
  const wrapZ = (z: number) => (pz ? (z + nz) % nz : Math.min(nz - 1, Math.max(0, z)));
  const clampX = (x: number) => (px ? (x + nx) % nx : Math.min(nx - 1, Math.max(0, x)));

  // a gap between two parts narrower than a cell (a tyre under its fork crown, a rider on the saddle) holds no flow
  // the grid can carry, and walls moving past each other across it pump its density up: fill it with one of them
  const squeezed: [number, number][] = [];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const n = idx(x, y, z);
        if ((flags[n] & TYPE_MASK) !== FLUID) continue;
        for (let i = 1; i < Q; i += 2) {
          const a = flags[idx(clampX(x + CX[i]), wrapY(y + CY[i]), wrapZ(z + CZ[i]))];
          const b = flags[idx(clampX(x - CX[i]), wrapY(y - CY[i]), wrapZ(z - CZ[i]))];
          if ((a & TYPE_MASK) === SOLID && (b & TYPE_MASK) === SOLID && a >>> INDEX_SHIFT !== b >>> INDEX_SHIFT) {
            squeezed.push([n, a]);
            break;
          }
        }
      }
  const filled = new Set<number>();
  for (const [n, f] of squeezed) {
    flags[n] = f;
    filled.add(n);
  }
  let solidCells = 0;
  for (let n = 0; n < N; n++) if ((flags[n] & TYPE_MASK) === SOLID) solidCells++;

  // boundary records
  const bins = new TriBins(g.bodies, 4);
  interface Rec {
    cell: number;
    part: number;
    q: Float32Array;
    nrm: V3;
    dist: number;
    phi: number;
  }
  const recs: Rec[] = [];
  let missed = 0;
  const votes = new Map<number, number>();
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const n = idx(x, y, z);
        if ((flags[n] & TYPE_MASK) !== FLUID) continue;
        let q: Float32Array | null = null;
        votes.clear();
        for (let i = 1; i < Q; i++) {
          const s = idx(clampX(x - CX[i]), wrapY(y - CY[i]), wrapZ(z - CZ[i]));
          const sf = flags[s];
          if ((sf & TYPE_MASK) !== SOLID) continue;
          const part = sf >>> INDEX_SHIFT;
          q ??= new Float32Array(18);
          votes.set(part, (votes.get(part) ?? 0) + 1);
          let t = Infinity;
          if (g.ground && part === g.ground.part && CZ[i] > 0) t = z - g.ground.z;
          else t = bins.firstHit([x, y, z], [-CX[i], -CY[i], -CZ[i]], 1 + 1e-4);
          if (!(t <= 1 + 1e-4)) {
            // the solid cell's surface was not met along the link: a grazing or open spot (or a filled gap)
            if (!filled.has(s)) missed++;
            t = 0.5;
          }
          q[i - 1] = Math.min(1, Math.max(1e-3, t));
        }
        const fl = fill.get(n);
        if (!q && !fl) continue;
        let part = fl?.part ?? 0;
        let best = -1;
        for (const [p, v] of votes)
          if (v > best) {
            best = v;
            part = p;
          }
        // the nearest wall point, for the wall model
        let nrm: V3 = [0, 0, 0];
        let dist = 0;
        if (q) {
          const near = bins.nearest([x, y, z], 1.75);
          if (near) {
            nrm = near.n;
            dist = near.d;
          }
          if (g.ground && z - g.ground.z < (near?.d ?? Infinity) && z - g.ground.z < 1.75) {
            nrm = [0, 0, 1];
            dist = z - g.ground.z;
          }
          if (dist < 1e-3) dist = 0;
        }
        recs.push({ cell: n, part, q: q ?? new Float32Array(18), nrm, dist, phi: q ? 0 : fl!.phi });
      }

  recs.sort((a, b) => a.part - b.part || a.cell - b.cell);
  const R = recs.length;
  const rec: Records = {
    count: R,
    cell: new Uint32Array(R),
    part: new Uint32Array(R),
    q: new Float32Array(R * 18),
    nrm: new Float32Array(R * 3),
    dist: new Float32Array(R),
    phi: new Float32Array(R),
    partStart: new Uint32Array(nParts + 1),
  };
  for (let r = 0; r < R; r++) {
    const o = recs[r];
    rec.cell[r] = o.cell;
    rec.part[r] = o.part;
    rec.q.set(o.q, r * 18);
    rec.nrm.set(o.nrm, r * 3);
    rec.dist[r] = o.dist;
    rec.phi[r] = o.phi;
    flags[o.cell] = FLUID | ((r + 1) << INDEX_SHIFT);
  }
  let r = 0;
  for (let p = 0; p <= nParts; p++) {
    while (r < R && rec.part[r] < p) r++;
    rec.partStart[p] = r;
  }
  return { flags, rec, missed, solidCells };
}

/**
 * Marks the cells whose centres lie inside a closed mesh as solid (unless something already is), and records the
 * share of every other cell the mesh fills, measured with a bundle of 3×3 rays per column.
 */
function voxelizeBody(b: Body, g: GridGeometry, flags: Uint32Array, fill: Map<number, { phi: number; part: number }>) {
  const { nx, ny, nz } = g;
  const P = b.positions;
  const I = b.indices;
  const nt = I.length / 3;
  const cols = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    const a = I[3 * t] * 3,
      c1 = I[3 * t + 1] * 3,
      c2 = I[3 * t + 2] * 3;
    const area2 = (P[c1] - P[a]) * (P[c2 + 1] - P[a + 1]) - (P[c1 + 1] - P[a + 1]) * (P[c2] - P[a]);
    if (Math.abs(area2) < 1e-14) continue;
    const i0 = Math.max(0, Math.floor(Math.min(P[a], P[c1], P[c2]) + 0.5 - 0.34)),
      i1 = Math.min(nx - 1, Math.floor(Math.max(P[a], P[c1], P[c2]) + 0.5 + 0.34));
    const j0 = Math.max(0, Math.floor(Math.min(P[a + 1], P[c1 + 1], P[c2 + 1]) + 0.5 - 0.34)),
      j1 = Math.min(ny - 1, Math.floor(Math.max(P[a + 1], P[c1 + 1], P[c2 + 1]) + 0.5 + 0.34));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = i + nx * j;
        let l = cols.get(k);
        if (!l) cols.set(k, (l = []));
        l.push(t);
      }
  }
  const hits: number[] = [];
  const sub = [-1 / 3, 0, 1 / 3];
  const part = b.part;
  const partial = new Map<number, number>();
  for (const [k, tris] of cols) {
    const i = k % nx;
    const j = (k - i) / nx;
    partial.clear();
    for (let sy = 0; sy < 3; sy++)
      for (let sx = 0; sx < 3; sx++) {
        // small irrational offsets so rays never run exactly along mesh edges or vertices
        const x = i + sub[sx] + 0.001371,
          y = j + sub[sy] + 0.002917;
        hits.length = 0;
        for (const t of tris) {
          const a = I[3 * t] * 3,
            c1 = I[3 * t + 1] * 3,
            c2 = I[3 * t + 2] * 3;
          const ax = P[a] - x,
            ay = P[a + 1] - y,
            bx = P[c1] - x,
            by = P[c1 + 1] - y,
            cx = P[c2] - x,
            cy = P[c2 + 1] - y;
          const w0 = bx * cy - by * cx;
          const w1 = cx * ay - cy * ax;
          const w2 = ax * by - ay * bx;
          if ((w0 < 0 || w1 < 0 || w2 < 0) && (w0 > 0 || w1 > 0 || w2 > 0)) continue;
          const s = w0 + w1 + w2;
          if (Math.abs(s) < 1e-18) continue;
          hits.push((w0 * P[a + 2] + w1 * P[c1 + 2] + w2 * P[c2 + 2]) / s);
        }
        if (hits.length < 2) continue;
        hits.sort((p, q) => p - q);
        const centre = sx === 1 && sy === 1;
        for (let m = 0; m + 1 < hits.length; m += 2) {
          const z0 = hits[m],
            z1 = hits[m + 1];
          if (z1 <= z0) continue;
          // fill of the cells the span crosses (cell k spans k − ½ .. k + ½)
          const k0 = Math.max(0, Math.floor(z0 + 0.5)),
            k1 = Math.min(nz - 1, Math.floor(z1 + 0.5));
          for (let kz = k0; kz <= k1; kz++) {
            const lo = Math.max(z0, kz - 0.5),
              hi = Math.min(z1, kz + 0.5);
            if (hi > lo) partial.set(kz, (partial.get(kz) ?? 0) + (hi - lo) / 9);
            if (centre && kz >= z0 && kz <= z1) {
              const n = i + nx * (j + ny * kz);
              if ((flags[n] & TYPE_MASK) !== SOLID) flags[n] = SOLID | (part << INDEX_SHIFT);
            }
          }
        }
      }
    for (const [kz, phi] of partial) {
      const n = i + nx * (j + ny * kz);
      if ((flags[n] & TYPE_MASK) === SOLID) continue;
      const prev = fill.get(n);
      if (!prev) fill.set(n, { phi: Math.min(1, phi), part });
      else {
        if (phi > prev.phi) prev.part = part;
        prev.phi = Math.min(1, prev.phi + phi);
      }
    }
  }
}

/** Triangles of every body in a sparse grid of bins, for link crossings and nearest-point searches. */
export class TriBins {
  private bins = new Map<number, number[]>();
  private P: Float64Array;
  private I: Uint32Array;
  private bx: number;
  private by: number;
  constructor(
    bodies: Body[],
    private size: number,
  ) {
    let nv = 0,
      ni = 0;
    for (const b of bodies) {
      nv += b.positions.length;
      ni += b.indices.length;
    }
    this.P = new Float64Array(nv);
    this.I = new Uint32Array(ni);
    let vo = 0,
      io = 0;
    for (const b of bodies) {
      this.P.set(b.positions, vo);
      for (let k = 0; k < b.indices.length; k++) this.I[io + k] = b.indices[k] + vo / 3;
      vo += b.positions.length;
      io += b.indices.length;
    }
    this.bx = 1 << 16;
    this.by = 1 << 16;
    const P = this.P;
    const I = this.I;
    for (let t = 0; t < I.length / 3; t++) {
      const a = I[3 * t] * 3,
        b = I[3 * t + 1] * 3,
        c = I[3 * t + 2] * 3;
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(P[a + k], P[b + k], P[c + k]) + 8) / size));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(P[a + k], P[b + k], P[c + k]) + 8) / size));
      for (let z = lo[2]; z <= hi[2]; z++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let x = lo[0]; x <= hi[0]; x++) {
            const key = this.key(x, y, z);
            let l = this.bins.get(key);
            if (!l) this.bins.set(key, (l = []));
            l.push(t);
          }
    }
  }

  private key(x: number, y: number, z: number) {
    return x + this.bx * (y + this.by * z);
  }

  /** triangles in the bins a box touches, each once */
  private around(lo: V3, hi: V3, out: Set<number>) {
    out.clear();
    const s = this.size;
    const a = lo.map((v) => Math.floor((v + 8) / s));
    const b = hi.map((v) => Math.floor((v + 8) / s));
    for (let z = a[2]; z <= b[2]; z++)
      for (let y = a[1]; y <= b[1]; y++)
        for (let x = a[0]; x <= b[0]; x++) {
          const l = this.bins.get(this.key(x, y, z));
          if (l) for (const t of l) out.add(t);
        }
  }

  private scratch = new Set<number>();

  /** Distance along d (as a multiple of |d|) to the first triangle the ray from o meets, up to tMax; Infinity if none. */
  firstHit(o: V3, d: V3, tMax: number): number {
    const P = this.P;
    const I = this.I;
    const e: V3 = [o[0] + d[0] * tMax, o[1] + d[1] * tMax, o[2] + d[2] * tMax];
    this.around([Math.min(o[0], e[0]), Math.min(o[1], e[1]), Math.min(o[2], e[2])], [Math.max(o[0], e[0]), Math.max(o[1], e[1]), Math.max(o[2], e[2])], this.scratch);
    let best = Infinity;
    for (const t of this.scratch) {
      const a = I[3 * t] * 3,
        b = I[3 * t + 1] * 3,
        c = I[3 * t + 2] * 3;
      // Möller–Trumbore
      const e1x = P[b] - P[a],
        e1y = P[b + 1] - P[a + 1],
        e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a],
        e2y = P[c + 1] - P[a + 1],
        e2z = P[c + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y,
        py = d[2] * e2x - d[0] * e2z,
        pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det;
      const sx = o[0] - P[a],
        sy = o[1] - P[a + 1],
        sz = o[2] - P[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < -EPS || u > 1 + EPS) continue;
      const qx = sy * e1z - sz * e1y,
        qy = sz * e1x - sx * e1z,
        qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < -EPS || u + v > 1 + EPS) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt >= -1e-6 && tt <= tMax && tt < best) best = Math.max(0, tt);
    }
    return best;
  }

  /** The nearest surface point within r of p: its distance and the unit direction from it to p. */
  nearest(p: V3, r: number): { d: number; n: V3 } | null {
    const P = this.P;
    const I = this.I;
    this.around([p[0] - r, p[1] - r, p[2] - r], [p[0] + r, p[1] + r, p[2] + r], this.scratch);
    let best = r;
    let out: { d: number; n: V3 } | null = null;
    for (const t of this.scratch) {
      const a = I[3 * t] * 3,
        b = I[3 * t + 1] * 3,
        c = I[3 * t + 2] * 3;
      const q = closestOnTriangle(p, [P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]], [P[c], P[c + 1], P[c + 2]]);
      const dx = p[0] - q[0],
        dy = p[1] - q[1],
        dz = p[2] - q[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < best && d > 1e-9) {
        best = d;
        out = { d, n: [dx / d, dy / d, dz / d] };
      }
    }
    return out;
  }
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
  }
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    w = vc * den;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** A closed UV sphere mesh (tests, reference shapes and the rider's joints). */
export function sphereMesh(c: V3, r: number, seg = 32): { positions: Float64Array; indices: Uint32Array } {
  const rings = Math.max(4, Math.round(seg / 2));
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(c[0], c[1], c[2] + r);
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < seg; j++) {
      const ph = (2 * Math.PI * j) / seg;
      pos.push(c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th));
    }
  }
  pos.push(c[0], c[1], c[2] - r);
  const last = pos.length / 3 - 1;
  for (let j = 0; j < seg; j++) idx.push(0, 1 + j, 1 + ((j + 1) % seg));
  for (let i = 0; i < rings - 2; i++)
    for (let j = 0; j < seg; j++) {
      const a = 1 + i * seg + j,
        b = 1 + i * seg + ((j + 1) % seg),
        c2 = a + seg,
        d = b + seg;
      idx.push(a, c2, d, a, d, b);
    }
  const base = 1 + (rings - 2) * seg;
  for (let j = 0; j < seg; j++) idx.push(last, base + ((j + 1) % seg), base + j);
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}
