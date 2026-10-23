// From a finished run to what people look at: forces in newtons, pressure
// and skin friction on each body's own mesh, the frontal area, streamlines
// through the averaged flow, the wake as the surface where the air has lost
// all its total pressure, the eddies as a Q-criterion surface, and a
// downsampled flow volume for slices.

import { coarseDims, FIELD_AVG, REC_AVG } from "./case";
import { frictionVelocity } from "./cpu";
import { FLUID, INDEX_SHIFT, SOLID, TYPE_MASK, U_LATTICE } from "./lattice";
import { cross, dot, norm, sub, toLattice, toWorld, vecToWorld, type BuiltLevel, type Frame } from "./setup";
import type { V3 } from "./geometry";
import type { AeroBody, FlowVolume, IsoSurface, Lines, SurfaceField } from "./types";

/** Mean force per part from the record sums, lattice units (3 per part). */
export function meanPartForces(lv: BuiltLevel, rec: Float32Array, avgSteps: number): Float64Array {
  const { rec: R, parts } = lv.case;
  const out = new Float64Array(parts.length * 3);
  const k = 1 / Math.max(1, avgSteps);
  for (let r = 0; r < R.count; r++) {
    const p = R.part[r];
    for (let j = 0; j < 3; j++) out[3 * p + j] += rec[r * REC_AVG + j] * k;
  }
  return out;
}

/** Moment of the mean record forces about a world point, lattice force × mm (world axes). */
export function meanMoment(lv: BuiltLevel, rec: Float32Array, avgSteps: number, about: V3, skipPart: number): V3 {
  const { rec: R, nx, ny } = lv.case;
  const f = lv.plan.frame;
  const k = 1 / Math.max(1, avgSteps);
  const M: V3 = [0, 0, 0];
  for (let r = 0; r < R.count; r++) {
    if (R.part[r] === skipPart) continue;
    const n = R.cell[r];
    const p = sub(toWorld(f, [n % nx, Math.floor(n / nx) % ny, Math.floor(n / (nx * ny))]), about);
    const F = vecToWorld(f, [rec[r * REC_AVG] * k, rec[r * REC_AVG + 1] * k, rec[r * REC_AVG + 2] * k]);
    const m = cross(p, F);
    M[0] += m[0];
    M[1] += m[1];
    M[2] += m[2];
  }
  return M;
}

/** Area-weighted vertex normals for a mesh. */
export function vertexNormals(P: ArrayLike<number>, I: ArrayLike<number>): Float32Array {
  const N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t],
      b = 3 * I[t + 1],
      c = 3 * I[t + 2];
    const u: V3 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const v: V3 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = cross(u, v);
    for (const o of [a, b, c]) {
      N[o] += n[0];
      N[o + 1] += n[1];
      N[o + 2] += n[2];
    }
  }
  for (let o = 0; o < N.length; o += 3) {
    const l = Math.hypot(N[o], N[o + 1], N[o + 2]) || 1;
    N[o] /= l;
    N[o + 1] /= l;
    N[o + 2] /= l;
  }
  return N;
}

export interface WallData {
  /** per record: pressure coefficient and skin friction coefficient (world xyz) */
  cp: Float32Array;
  cf: Float32Array;
  /** the wall model's y+ at the first cell, per record with a wall (NaN otherwise) */
  yPlus: Float32Array;
}

/** Pressure and wall shear at each boundary record from its averaged flow. */
export function wallData(lv: BuiltLevel, rec: Float32Array, avgSteps: number): WallData {
  const { rec: R, nx, ny, tau0, parts } = lv.case;
  const nu = (tau0 - 0.5) / 3;
  const k = 1 / Math.max(1, avgSteps);
  const cp = new Float32Array(R.count);
  const cf = new Float32Array(R.count * 3);
  const yPlus = new Float32Array(R.count).fill(NaN);
  const q = 0.5 * U_LATTICE * U_LATTICE;
  const f = lv.plan.frame;
  for (let r = 0; r < R.count; r++) {
    const o = r * REC_AVG;
    const drho = rec[o + 3] * k;
    cp[r] = drho / 3 / q;
    const d = R.dist[r];
    if (!(d > 0)) continue;
    const n = R.cell[r];
    const pos: V3 = [n % nx, Math.floor(n / nx) % ny, Math.floor(n / (nx * ny))];
    const nw: V3 = [R.nrm[3 * r], R.nrm[3 * r + 1], R.nrm[3 * r + 2]];
    const m = parts[R.part[r]];
    const wp = sub(pos, [nw[0] * d, nw[1] * d, nw[2] * d]);
    const b = add3(m.v, cross(m.w, sub(wp, m.c)));
    const v: V3 = [rec[o + 4] * k - b[0], rec[o + 5] * k - b[1], rec[o + 6] * k - b[2]];
    const vn = dot(v, nw);
    const t: V3 = [v[0] - vn * nw[0], v[1] - vn * nw[1], v[2] - vn * nw[2]];
    const ut = Math.hypot(...t);
    if (ut < 1e-9) continue;
    const utau = frictionVelocity(ut, d, nu);
    yPlus[r] = (utau * d) / nu;
    const tw = ((1 + drho) * utau * utau) / q;
    const tw3 = vecToWorld(f, [(t[0] / ut) * tw, (t[1] / ut) * tw, (t[2] / ut) * tw]);
    cf.set(tw3, 3 * r);
  }
  return { cp, cf, yPlus };
}

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * The wall data on each body's own mesh: every vertex takes the inverse-distance mean of the records within two
 * cells on its outer side (so the two faces of a thin wall keep their own pressures). NaN where none are near:
 * geometry too thin for the cells, or buried in another body.
 */
export function surfaceFields(lv: BuiltLevel, bodies: AeroBody[], wd: WallData, shared?: SurfaceField[]): SurfaceField[] {
  const { nx, ny, nz, flags } = lv.case;
  const f = lv.plan.frame;
  const out: SurfaceField[] = [];
  for (const [k, b] of bodies.entries()) {
    const P = b.positions;
    const nv = P.length / 3;
    const normals = shared?.[k]?.normals ?? b.normals ?? vertexNormals(P, b.indices);
    const cp = new Float32Array(nv);
    const cf = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const p = toLattice(f, [P[3 * v], P[3 * v + 1], P[3 * v + 2]]);
      // the normal in lattice axes
      const nW: V3 = [normals[3 * v], normals[3 * v + 1], normals[3 * v + 2]];
      const nl: V3 = [dot(nW, f.ex), dot(nW, f.ey), dot(nW, f.ez)];
      let sw = 0,
        sp = 0,
        sx = 0,
        sy = 0,
        sz = 0;
      const x0 = Math.round(p[0]),
        y0 = Math.round(p[1]),
        z0 = Math.round(p[2]);
      for (let dz = -2; dz <= 2; dz++) {
        const z = z0 + dz;
        if (z < 0 || z >= nz) continue;
        for (let dy = -2; dy <= 2; dy++) {
          const y = y0 + dy;
          if (y < 0 || y >= ny) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const x = x0 + dx;
            if (x < 0 || x >= nx) continue;
            const fl = flags[x + nx * (y + ny * z)];
            if ((fl & TYPE_MASK) !== FLUID || fl >>> INDEX_SHIFT === 0) continue;
            const r = (fl >>> INDEX_SHIFT) - 1;
            const ex = x - p[0],
              ey = y - p[1],
              ez = z - p[2];
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 > 5 || ex * nl[0] + ey * nl[1] + ez * nl[2] < -0.35) continue;
            const w = 1 / (d2 + 0.3);
            sw += w;
            sp += w * wd.cp[r];
            sx += w * wd.cf[3 * r];
            sy += w * wd.cf[3 * r + 1];
            sz += w * wd.cf[3 * r + 2];
          }
        }
      }
      if (sw > 0) {
        cp[v] = sp / sw;
        cf[3 * v] = sx / sw;
        cf[3 * v + 1] = sy / sw;
        cf[3 * v + 2] = sz / sw;
      } else {
        cp[v] = NaN;
        cf[3 * v] = cf[3 * v + 1] = cf[3 * v + 2] = NaN;
      }
    }
    out.push({ id: b.id, name: b.name, positions: shared?.[k]?.positions ?? b.positions, normals, indices: shared?.[k]?.indices ?? b.indices, cp, cf, extra: b.extra });
  }
  return out;
}

/** Pressure and friction drag along a direction from the mapped surface fields, coefficient × m² (the friction share comes from these). */
export function integrateDrag(s: SurfaceField, dir: V3): { pressure: number; friction: number } {
  const P = s.positions;
  const I = s.indices;
  let pressure = 0,
    friction = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t],
      b = I[t + 1],
      c = I[t + 2];
    const pa: V3 = [P[3 * a], P[3 * a + 1], P[3 * a + 2]];
    const n = cross(sub([P[3 * b], P[3 * b + 1], P[3 * b + 2]], pa), sub([P[3 * c], P[3 * c + 1], P[3 * c + 2]], pa));
    // the triangle's area vector, m² (half the cross product, mm² → m²)
    const A: V3 = [n[0] * 5e-7, n[1] * 5e-7, n[2] * 5e-7];
    const cp = (s.cp[a] + s.cp[b] + s.cp[c]) / 3;
    if (Number.isFinite(cp)) pressure -= cp * dot(A, dir);
    const area = Math.hypot(...A);
    let fd = 0;
    for (const v of [a, b, c]) fd += s.cf[3 * v] * dir[0] + s.cf[3 * v + 1] * dir[1] + s.cf[3 * v + 2] * dir[2];
    if (Number.isFinite(fd)) friction += (fd / 3) * area;
  }
  return { pressure, friction };
}

/** The area the bodies show to the wind (along ex), m², by rasterising their shadow. */
export function frontalArea(bodies: AeroBody[], ex: V3, ey: V3, ez: V3, res = 1024): number {
  let lo = [Infinity, Infinity],
    hi = [-Infinity, -Infinity];
  for (const b of bodies) {
    const P = b.positions;
    for (let v = 0; v < P.length; v += 3) {
      const y = P[v] * ey[0] + P[v + 1] * ey[1] + P[v + 2] * ey[2];
      const z = P[v] * ez[0] + P[v + 1] * ez[1] + P[v + 2] * ez[2];
      lo = [Math.min(lo[0], y), Math.min(lo[1], z)];
      hi = [Math.max(hi[0], y), Math.max(hi[1], z)];
    }
  }
  if (!(hi[0] > lo[0]) || !(hi[1] > lo[1])) return 0;
  const px = Math.max(hi[0] - lo[0], hi[1] - lo[1]) / res;
  const W = Math.ceil((hi[0] - lo[0]) / px) + 1;
  const H = Math.ceil((hi[1] - lo[1]) / px) + 1;
  const img = new Uint8Array(W * H);
  for (const b of bodies) {
    const P = b.positions;
    const I = b.indices;
    const Y = (v: number) => (P[3 * v] * ey[0] + P[3 * v + 1] * ey[1] + P[3 * v + 2] * ey[2] - lo[0]) / px;
    const Z = (v: number) => (P[3 * v] * ez[0] + P[3 * v + 1] * ez[1] + P[3 * v + 2] * ez[2] - lo[1]) / px;
    for (let t = 0; t < I.length; t += 3) {
      const ay = Y(I[t]),
        az = Z(I[t]),
        by = Y(I[t + 1]),
        bz = Z(I[t + 1]),
        cy = Y(I[t + 2]),
        cz = Z(I[t + 2]);
      const area = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      if (Math.abs(area) < 1e-12) continue;
      const s = Math.sign(area);
      const x0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
        x1 = Math.min(W - 1, Math.ceil(Math.max(ay, by, cy)));
      const y0 = Math.max(0, Math.floor(Math.min(az, bz, cz))),
        y1 = Math.min(H - 1, Math.ceil(Math.max(az, bz, cz)));
      for (let j = y0; j <= y1; j++)
        for (let i = x0; i <= x1; i++) {
          const py = i + 0.5,
            pz = j + 0.5;
          const e0 = s * ((by - ay) * (pz - az) - (bz - az) * (py - ay));
          const e1 = s * ((cy - by) * (pz - bz) - (cz - bz) * (py - by));
          const e2 = s * ((ay - cy) * (pz - cz) - (az - cz) * (py - cy));
          if (e0 >= 0 && e1 >= 0 && e2 >= 0) img[i + W * j] = 1;
        }
    }
  }
  let n = 0;
  for (let i = 0; i < img.length; i++) n += img[i];
  return n * px * px * 1e-6;
}

/** The averaged flow on the level's blocks: velocity xyz and density change per block (4 floats), solids at rest, plus which blocks hold air. */
export interface BlockFlow {
  dims: V3;
  coarse: number;
  /** ux, uy, uz, drho per block, lattice units */
  data: Float32Array;
  fluid: Uint8Array;
}

export function blockFlow(lv: BuiltLevel, field: Float32Array): BlockFlow {
  const dims = coarseDims(lv.case);
  const nb = dims[0] * dims[1] * dims[2];
  const data = new Float32Array(nb * 4);
  const fluid = new Uint8Array(nb);
  for (let b = 0; b < nb; b++) {
    const n = field[b * FIELD_AVG + 5];
    if (!(n > 0)) continue;
    fluid[b] = 1;
    for (let j = 0; j < 4; j++) data[4 * b + j] = field[b * FIELD_AVG + j] / n;
  }
  return { dims, coarse: lv.case.coarse, data, fluid };
}

/** Block coordinates → world, mm. */
function blockToWorld(f: Frame, k: number, b: V3): V3 {
  return toWorld(f, [k * b[0] + (k - 1) / 2, k * b[1] + (k - 1) / 2, k * b[2] + (k - 1) / 2]);
}

function sampleVel(bf: BlockFlow, p: V3, out: V3): boolean {
  const [dx, dy, dz] = bf.dims;
  if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] > dx - 1 || p[1] > dy - 1 || p[2] > dz - 1) return false;
  const x0 = Math.min(Math.floor(p[0]), dx - 2),
    y0 = Math.min(Math.floor(p[1]), dy - 2),
    z0 = Math.min(Math.floor(p[2]), dz - 2);
  const fx = p[0] - x0,
    fy = p[1] - y0,
    fz = p[2] - z0;
  out[0] = out[1] = out[2] = 0;
  for (let c = 0; c < 8; c++) {
    const bx = c & 1,
      by = (c >> 1) & 1,
      bz = c >> 2;
    const w = (bx ? fx : 1 - fx) * (by ? fy : 1 - fy) * (bz ? fz : 1 - fz);
    const o = 4 * (x0 + bx + dx * (y0 + by + dy * (z0 + bz)));
    out[0] += w * bf.data[o];
    out[1] += w * bf.data[o + 1];
    out[2] += w * bf.data[o + 2];
  }
  return true;
}

/**
 * Streamlines through the averaged flow from a rake of seeds just upstream of the bodies. Lines that pass close
 * to a body are kept first; a thinner set of the others shows the flow round it.
 */
export function streamlines(lv: BuiltLevel, bf: BlockFlow, max = 360): Lines {
  const f = lv.plan.frame;
  const k = bf.coarse;
  const [dx, dy, dz] = bf.dims;
  const toB = (v: number) => (v - (k - 1) / 2) / k;
  const { lo, hi } = lv.plan.body;
  // blocks within two of a solid one
  const near = new Uint8Array(dx * dy * dz);
  for (let z = 0; z < dz; z++)
    for (let y = 0; y < dy; y++)
      for (let x = 0; x < dx; x++) {
        if (bf.fluid[x + dx * (y + dy * z)]) continue;
        for (let c = -2; c <= 2; c++)
          for (let b = -2; b <= 2; b++)
            for (let a = -2; a <= 2; a++) {
              const X = x + a,
                Y = y + b,
                Z = z + c;
              if (X >= 0 && Y >= 0 && Z >= 0 && X < dx && Y < dy && Z < dz) near[X + dx * (Y + dy * Z)] = 1;
            }
      }
  // the road is solid too: ignore nearness to it
  const zFloor = lv.plan.groundZ !== null ? toB(lv.plan.groundZ) + 2.5 : -Infinity;
  const sx = Math.max(0.5, toB(lo[0] - 0.12 * (hi[0] - lo[0])));
  const NY = 34,
    NZ = 26;
  const padY = 0.12 * (hi[1] - lo[1]) + 2 * k,
    padZ = 0.08 * (hi[2] - lo[2]) + 2 * k;
  const y0 = toB(lo[1] - padY),
    y1 = toB(hi[1] + padY);
  const z0 = Math.max(toB(lo[2] - padZ), lv.plan.groundZ !== null ? toB(lv.plan.groundZ) + 0.6 : 0),
    z1 = toB(hi[2] + padZ);
  const lines: { pts: number[]; spd: number[]; score: number }[] = [];
  const k1: V3 = [0, 0, 0],
    k2: V3 = [0, 0, 0],
    k3: V3 = [0, 0, 0],
    k4: V3 = [0, 0, 0];
  const h = 0.4;
  const maxSteps = Math.ceil((3 * dx) / h);
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NY; i++) {
      let p: V3 = [sx, y0 + ((i + 0.5) / NY) * (y1 - y0), z0 + ((j + 0.5) / NZ) * (z1 - z0)];
      const pts: number[] = [];
      const spd: number[] = [];
      let score = 0;
      for (let s = 0; s < maxSteps; s++) {
        if (!sampleVel(bf, p, k1)) break;
        const sp = Math.hypot(...k1) / U_LATTICE;
        if (s % 3 === 0) {
          const w = blockToWorld(f, k, p);
          pts.push(w[0], w[1], w[2]);
          spd.push(sp);
        }
        if (sp < 0.02) break;
        const bi = Math.round(p[0]) + dx * (Math.round(p[1]) + dy * Math.round(p[2]));
        if (near[bi] && p[2] > zFloor) score++;
        // RK4 on the direction of the flow, a fixed distance per step
        const st = h / (Math.hypot(...k1) || 1);
        const q2: V3 = [p[0] + 0.5 * st * k1[0], p[1] + 0.5 * st * k1[1], p[2] + 0.5 * st * k1[2]];
        if (!sampleVel(bf, q2, k2)) break;
        const q3: V3 = [p[0] + 0.5 * st * k2[0], p[1] + 0.5 * st * k2[1], p[2] + 0.5 * st * k2[2]];
        if (!sampleVel(bf, q3, k3)) break;
        const q4: V3 = [p[0] + st * k3[0], p[1] + st * k3[1], p[2] + st * k3[2]];
        if (!sampleVel(bf, q4, k4)) break;
        p = [p[0] + (st / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), p[1] + (st / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]), p[2] + (st / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])];
      }
      if (pts.length >= 6) lines.push({ pts, spd, score: score + (((i * 7 + j * 3) % 5 === 0) ? 0.5 : 0) });
    }
  lines.sort((a, b) => b.score - a.score);
  const kept = lines.filter((l) => l.score > 0).slice(0, max);
  const starts = [0];
  const pts: number[] = [];
  const spd: number[] = [];
  for (const l of kept) {
    pts.push(...l.pts);
    spd.push(...l.spd);
    starts.push(spd.length);
  }
  return { points: Float32Array.from(pts), speed: Float32Array.from(spd), starts: Uint32Array.from(starts) };
}

/**
 * Surface nets: one vertex per block cube the iso-surface passes through, at the mean of its edge crossings, and a
 * quad across every crossed edge. Inside is where the value is below iso; normals point out.
 */
export function surfaceNets(val: Float32Array, dims: V3, iso: number, colour: Float32Array | null): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; value: Float32Array } {
  const [dx, dy, dz] = dims;
  const at = (x: number, y: number, z: number) => val[x + dx * (y + dy * z)];
  const cubeIdx = new Int32Array(Math.max(0, (dx - 1) * (dy - 1) * (dz - 1))).fill(-1);
  const P: number[] = [];
  const N: number[] = [];
  const C: number[] = [];
  const I: number[] = [];
  const E = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const cv = new Float64Array(8);
  for (let z = 0; z < dz - 1; z++)
    for (let y = 0; y < dy - 1; y++)
      for (let x = 0; x < dx - 1; x++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = at(x + (c & 1), y + ((c >> 1) & 1), z + (c >> 2));
          cv[c] = v;
          if (v < iso) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          n = 0;
        for (const [a, b] of E) {
          if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
          const t = (iso - cv[a]) / (cv[b] - cv[a]);
          sx += (a & 1) + t * ((b & 1) - (a & 1));
          sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          sz += (a >> 2) + t * ((b >> 2) - (a >> 2));
          n++;
        }
        const px = x + sx / n,
          py = y + sy / n,
          pz = z + sz / n;
        cubeIdx[x + (dx - 1) * (y + (dy - 1) * z)] = P.length / 3;
        P.push(px, py, pz);
        // gradient by central differences at the nearest node
        const X = Math.min(dx - 2, Math.max(1, Math.round(px))),
          Y = Math.min(dy - 2, Math.max(1, Math.round(py))),
          Z = Math.min(dz - 2, Math.max(1, Math.round(pz)));
        const g = norm([at(X + 1, Y, Z) - at(X - 1, Y, Z), at(X, Y + 1, Z) - at(X, Y - 1, Z), at(X, Y, Z + 1) - at(X, Y, Z - 1)]);
        N.push(g[0], g[1], g[2]);
        C.push(colour ? colour[Math.round(px) + dx * (Math.round(py) + dy * Math.round(pz))] : 0);
      }
  const ci = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= dx - 1 || y >= dy - 1 || z >= dz - 1 ? -1 : cubeIdx[x + (dx - 1) * (y + (dy - 1) * z)]);
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) I.push(a, c, b, a, d, c);
    else I.push(a, b, c, a, c, d);
  };
  for (let z = 0; z < dz; z++)
    for (let y = 0; y < dy; y++)
      for (let x = 0; x < dx; x++) {
        const v0 = at(x, y, z) < iso;
        // each quad winds round +x, +y or +z; flip it when the inside is beyond the edge
        if (x < dx - 1 && v0 !== at(x + 1, y, z) < iso) quad(ci(x, y - 1, z - 1), ci(x, y, z - 1), ci(x, y, z), ci(x, y - 1, z), !v0);
        if (y < dy - 1 && v0 !== at(x, y + 1, z) < iso) quad(ci(x - 1, y, z - 1), ci(x - 1, y, z), ci(x, y, z), ci(x, y, z - 1), !v0);
        if (z < dz - 1 && v0 !== at(x, y, z + 1) < iso) quad(ci(x - 1, y - 1, z), ci(x, y - 1, z), ci(x, y, z), ci(x - 1, y, z), !v0);
      }
  return { positions: Float32Array.from(P), normals: Float32Array.from(N), indices: Uint32Array.from(I), value: Float32Array.from(C) };
}

/** Block-grid mesh → world (positions, normals). */
function placeIso(f: Frame, k: number, m: ReturnType<typeof surfaceNets>, flipNormals: boolean): IsoSurface {
  const P = m.positions;
  for (let v = 0; v < P.length; v += 3) {
    const w = blockToWorld(f, k, [P[v], P[v + 1], P[v + 2]]);
    P[v] = w[0];
    P[v + 1] = w[1];
    P[v + 2] = w[2];
  }
  const N = m.normals;
  for (let v = 0; v < N.length; v += 3) {
    const s = flipNormals ? -1 : 1;
    const w = vecToWorld(f, [s * N[v], s * N[v + 1], s * N[v + 2]]);
    N[v] = w[0];
    N[v + 1] = w[1];
    N[v + 2] = w[2];
  }
  return { positions: P, normals: N, indices: m.indices, value: m.value };
}

/** Speed as a share of the free stream per block. */
function speedShare(bf: BlockFlow): Float32Array {
  const n = bf.fluid.length;
  const s = new Float32Array(n);
  for (let b = 0; b < n; b++) s[b] = Math.hypot(bf.data[4 * b], bf.data[4 * b + 1], bf.data[4 * b + 2]) / U_LATTICE;
  return s;
}

/**
 * The wake: where the averaged flow has lost all its total pressure (Cp + |u|²/U² = 0, the surface automotive
 * aerodynamicists draw). Solids count as free stream, so the surface wraps the separated air, not the bodies.
 */
export function wakeSurface(lv: BuiltLevel, bf: BlockFlow): IsoSurface | null {
  const n = bf.fluid.length;
  const cpt = new Float32Array(n);
  const q = 0.5 * U_LATTICE * U_LATTICE;
  const sp = speedShare(bf);
  for (let b = 0; b < n; b++) cpt[b] = bf.fluid[b] ? bf.data[4 * b + 3] / 3 / q + sp[b] * sp[b] : 1;
  // the road's boundary layer is not wake: hold the blocks next to it at the free stream
  if (lv.plan.groundZ !== null) {
    const [dx, dy] = bf.dims;
    const zr = Math.floor((lv.plan.groundZ - (bf.coarse - 1) / 2) / bf.coarse) + 1;
    for (let z = 0; z <= zr; z++) for (let i = 0; i < dx * dy; i++) cpt[i + dx * dy * z] = 1;
  }
  const m = surfaceNets(cpt, bf.dims, 0, sp);
  if (!m.indices.length) return null;
  return placeIso(lv.plan.frame, bf.coarse, m, false);
}

/**
 * Eddies: the Q-criterion (rotation beating strain) on the instantaneous flow, at a level that shows the
 * strongest one or two per cent of the swirling air but never below half of (U/D)².
 */
export function vortexSurface(lv: BuiltLevel, snap: BlockFlow, D: number): IsoSurface | null {
  const [dx, dy, dz] = snap.dims;
  const n = dx * dy * dz;
  const Qv = new Float32Array(n);
  const u = snap.data;
  const g = (x: number, y: number, z: number, c: number) => u[4 * (x + dx * (y + dy * z)) + c];
  const pos: number[] = [];
  for (let z = 1; z < dz - 1; z++)
    for (let y = 1; y < dy - 1; y++)
      for (let x = 1; x < dx - 1; x++) {
        const b = x + dx * (y + dy * z);
        if (!snap.fluid[b]) continue;
        const J = [0, 1, 2].map((c) => [(g(x + 1, y, z, c) - g(x - 1, y, z, c)) / 2, (g(x, y + 1, z, c) - g(x, y - 1, z, c)) / 2, (g(x, y, z + 1, c) - g(x, y, z - 1, c)) / 2]);
        let s2 = 0,
          o2 = 0;
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) {
            const s = 0.5 * (J[i][j] + J[j][i]);
            const o = 0.5 * (J[i][j] - J[j][i]);
            s2 += s * s;
            o2 += o * o;
          }
        const q = 0.5 * (o2 - s2);
        Qv[b] = q;
        if (q > 0) pos.push(q);
      }
  if (pos.length < 20) return null;
  pos.sort((a, b) => a - b);
  const Db = Math.max(1, D / (lv.plan.frame.h * snap.coarse));
  const floor = 0.5 * (U_LATTICE / Db) ** 2;
  const level = Math.max(pos[Math.floor(0.985 * (pos.length - 1))], floor);
  // inside is Q above the level: negate so "below iso" is inside
  for (let b = 0; b < n; b++) Qv[b] = -Qv[b];
  const m = surfaceNets(Qv, snap.dims, -level, speedShare(snap));
  if (!m.indices.length) return null;
  return placeIso(lv.plan.frame, snap.coarse, m, false);
}

/** The averaged flow, thinned to at most maxCells blocks, as velocity (world axes, share of the free stream) and Cp per cell (NaN in solids). */
export function flowVolume(lv: BuiltLevel, bf: BlockFlow, maxCells = 1.2e6): FlowVolume {
  const [dx, dy, dz] = bf.dims;
  const s = Math.max(1, Math.ceil(Math.cbrt((dx * dy * dz) / maxCells)));
  const dims: V3 = [Math.ceil(dx / s), Math.ceil(dy / s), Math.ceil(dz / s)];
  const data = new Float32Array(dims[0] * dims[1] * dims[2] * 4);
  const f = lv.plan.frame;
  const q = 0.5 * U_LATTICE * U_LATTICE;
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const o = 4 * (x + dims[0] * (y + dims[1] * z));
        const b = Math.min(dx - 1, x * s) + dx * (Math.min(dy - 1, y * s) + dy * Math.min(dz - 1, z * s));
        if (!bf.fluid[b]) {
          data[o] = data[o + 1] = data[o + 2] = data[o + 3] = NaN;
          continue;
        }
        const w = vecToWorld(f, [bf.data[4 * b] / U_LATTICE, bf.data[4 * b + 1] / U_LATTICE, bf.data[4 * b + 2] / U_LATTICE]);
        data[o] = w[0];
        data[o + 1] = w[1];
        data[o + 2] = w[2];
        data[o + 3] = bf.data[4 * b + 3] / 3 / q;
      }
  const k = bf.coarse;
  return { dims, origin: blockToWorld(f, k, [0, 0, 0]), ex: f.ex, ey: f.ey, ez: f.ez, h: f.h * k * s, data };
}

/** Whether a cell is solid (for probes). */
export const isSolid = (lv: BuiltLevel, n: number) => (lv.case.flags[n] & TYPE_MASK) === SOLID;
