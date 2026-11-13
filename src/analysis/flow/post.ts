// What a solved flow gives back: each part's temperatures, the flow through cross-sections and out to the
// surroundings, temperatures on the parts' surfaces for drawing, streamlines through the air and the field itself.

import * as grid from "./grid";
import type { Grid } from "./grid";
import type { FlowSolver } from "./flow";
import type { Section } from "./section";
import type { FlowBody, FlowField, FlowLines, PartTemp, SurfaceTemps, V3 } from "./types";

// module-level copies of the imported constants and functions: the hot loops read them millions of times, and an
// imported binding costs a call each where the modules are compiled to CommonJS (the tests)
const { AMBIENT, FLUID, SOLID, cellAt, cellCentre } = grid;

/** Each body's hottest and mean temperature; a body with no cells of its own reads the cell it sits in. */
export function partTemps(g: Grid, T: Float64Array, centres: (number | null)[]): PartTemp[] {
  const n = g.bodies.length;
  const max = new Float64Array(n).fill(-Infinity);
  const sum = new Float64Array(n);
  for (let c = 0; c < g.body.length; c++) {
    const b = g.body[c];
    if (b < 0) continue;
    if (T[c] > max[b]) max[b] = T[c];
    sum[b] += T[c];
  }
  return g.bodies.map((b, i) => {
    const cells = g.bodyCells[i];
    const c = centres[i];
    const t = cells ? undefined : c !== null && c >= 0 ? T[c] : NaN;
    return {
      id: b.id,
      name: b.name,
      max: cells ? max[i] : t!,
      mean: cells ? sum[i] / cells : t!,
      watts: b.watts,
      ...(b.heatWhy ? { heatWhy: b.heatWhy } : {}),
      ...(b.maxC !== undefined ? { limit: b.maxC } : {}),
      ...(b.limitWhy ? { limitWhy: b.limitWhy } : {}),
      material: b.material,
      component: b.component,
      cells,
    };
  });
}

/** The cell a body's middle is in (for bodies too small to fill a cell), or null with no mesh. */
export function bodyCentres(g: Grid): (number | null)[] {
  return g.bodies.map((b) => {
    if (!b.positions.length) return null;
    const m: V3 = [0, 0, 0];
    const n = b.positions.length / 3;
    for (let i = 0; i < b.positions.length; i += 3) for (let a = 0; a < 3; a++) m[a] += b.positions[i + a] / n;
    return cellAt(g, m);
  });
}

/** Temperature at each vertex of each body's mesh, from the nearest of its own cells. */
export function surfaceTemps(g: Grid, T: Float64Array, bodies: FlowBody[], mean: (i: number) => number): SurfaceTemps[] {
  const { nx, ny, nz } = g;
  const out: SurfaceTemps[] = [];
  bodies.forEach((b, bi) => {
    if (!b.indices.length) return;
    const nv = b.positions.length / 3;
    const temp = new Float32Array(nv);
    const fallback = mean(bi);
    for (let v = 0; v < nv; v++) {
      const p: V3 = [b.positions[3 * v], b.positions[3 * v + 1], b.positions[3 * v + 2]];
      const i0 = Math.floor((p[0] - g.origin[0]) / g.hmm);
      const j0 = Math.floor((p[1] - g.origin[1]) / g.hmm);
      const k0 = Math.floor((p[2] - g.origin[2]) / g.hmm);
      let best = -1;
      let bd = Infinity;
      for (let dk = -1; dk <= 1; dk++)
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const i = i0 + di;
            const j = j0 + dj;
            const k = k0 + dk;
            if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
            const c = i + nx * (j + ny * k);
            if (g.body[c] !== bi) continue;
            const q = cellCentre(g, c);
            const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
            if (d < bd) {
              bd = d;
              best = c;
            }
          }
      temp[v] = best >= 0 ? T[best] : fallback;
    }
    out.push({ id: b.id, name: b.name, positions: b.positions, indices: b.indices, temp });
  });
  return out;
}

/** Flow (m³/s) through a cross-section along its way, and the flow-weighted air temperature there. */
export function sectionFlow(flow: FlowSolver, T: Float64Array, s: Section): { flow: number; temp: number } {
  const area = flow.g.h * flow.g.h;
  let q = 0;
  let qt = 0;
  let qa = 0;
  for (const c of s.cells) {
    const f0 = flow.faceBelow(s.axis, c);
    // the face on the way out of the cell
    const f = s.sign > 0 ? f0 + flow.faceStride(s.axis, s.axis) : f0;
    const u = flow.U[s.axis][f] * s.sign;
    q += u * area;
    qa += Math.abs(u) * area;
    qt += Math.abs(u) * area * T[c];
  }
  return { flow: q, temp: qa > 0 ? qt / qa : T[s.cells[0]] };
}

/** Air leaving to the surroundings: m³/s, and its mean temperature rise over the ambient. */
export function throughFlow(flow: FlowSolver, T: Float64Array, ambient: number): { flow: number; rise: number } {
  const { g } = flow;
  const { nx, ny } = g;
  const area = g.h * g.h;
  let out = 0;
  let heat = 0;
  for (let c = 0; c < g.kind.length; c++) {
    if (g.kind[c] !== FLUID) continue;
    for (let a = 0; a < 3; a++) {
      const cs = a === 0 ? 1 : a === 1 ? nx : nx * ny;
      const f0 = flow.faceBelow(a, c);
      if (g.kind[c - cs] === AMBIENT) {
        const u = -flow.U[a][f0];
        if (u > 0) {
          out += u * area;
          heat += u * area * (T[c] - ambient);
        }
      }
      if (g.kind[c + cs] === AMBIENT) {
        const u = flow.U[a][f0 + flow.faceStride(a, a)];
        if (u > 0) {
          out += u * area;
          heat += u * area * (T[c] - ambient);
        }
      }
    }
  }
  return { flow: out, rise: out > 0 ? heat / out : 0 };
}

/** Velocity (m/s) and temperature at a point (mm), trilinear between cell centres; solids and the surroundings read as still. */
function sample(flow: FlowSolver, T: Float64Array, vel: Float32Array, p: V3, out: Float64Array): boolean {
  const g = flow.g;
  const { nx, ny, nz } = g;
  const x = (p[0] - g.origin[0]) / g.hmm - 0.5;
  const y = (p[1] - g.origin[1]) / g.hmm - 0.5;
  const z = (p[2] - g.origin[2]) / g.hmm - 0.5;
  const i = Math.floor(x);
  const j = Math.floor(y);
  const k = Math.floor(z);
  if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return false;
  const c0 = cellAt(g, p);
  if (c0 < 0 || g.kind[c0] !== FLUID) return false;
  const fx = x - i;
  const fy = y - j;
  const fz = z - k;
  out[0] = out[1] = out[2] = out[3] = 0;
  let wsum = 0;
  for (let dk = 0; dk < 2; dk++)
    for (let dj = 0; dj < 2; dj++)
      for (let di = 0; di < 2; di++) {
        const c = i + di + nx * (j + dj + ny * (k + dk));
        const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy) * (dk ? fz : 1 - fz);
        if (g.kind[c] === SOLID) continue;
        out[0] += w * vel[3 * c];
        out[1] += w * vel[3 * c + 1];
        out[2] += w * vel[3 * c + 2];
        out[3] += w * T[c];
        wsum += w;
      }
  if (wsum <= 0) return false;
  out[3] /= wsum;
  return true;
}

/** Streamlines from seed points (mm), traced both ways through the cell-centre velocities. */
export function streamlines(flow: FlowSolver, T: Float64Array, seeds: V3[], maxLines = 220): FlowLines {
  const g = flow.g;
  const N = g.nx * g.ny * g.nz;
  const vel = new Float32Array(3 * N);
  let vmax = 0;
  for (let c = 0; c < N; c++) {
    if (g.kind[c] !== FLUID) continue;
    const v = flow.cellVelocity(c);
    vel[3 * c] = v[0];
    vel[3 * c + 1] = v[1];
    vel[3 * c + 2] = v[2];
    vmax = Math.max(vmax, Math.hypot(v[0], v[1], v[2]));
  }
  const pts: number[] = [];
  const spd: number[] = [];
  const tmp: number[] = [];
  const starts: number[] = [];
  const s = new Float64Array(4);
  const step = 0.5 * g.hmm;
  const maxSteps = Math.ceil((3 * (g.nx + g.ny + g.nz)) / 0.5);
  const slow = vmax * 0.01;
  for (const seed of seeds.slice(0, maxLines)) {
    const halves: { p: V3; v: number; t: number }[][] = [];
    for (const way of [1, -1]) {
      const line: { p: V3; v: number; t: number }[] = [];
      const p: V3 = [...seed];
      for (let n = 0; n < maxSteps; n++) {
        if (!sample(flow, T, vel, p, s)) break;
        const sp = Math.hypot(s[0], s[1], s[2]);
        if (sp < slow) break;
        line.push({ p: [...p], v: sp, t: s[3] });
        // midpoint step
        const mid: V3 = [p[0] + (way * 0.5 * step * s[0]) / sp, p[1] + (way * 0.5 * step * s[1]) / sp, p[2] + (way * 0.5 * step * s[2]) / sp];
        if (!sample(flow, T, vel, mid, s)) break;
        const sm = Math.hypot(s[0], s[1], s[2]);
        if (sm < slow) break;
        p[0] += (way * step * s[0]) / sm;
        p[1] += (way * step * s[1]) / sm;
        p[2] += (way * step * s[2]) / sm;
      }
      halves.push(line);
    }
    const line = [...halves[1].reverse(), ...halves[0].slice(1)];
    if (line.length < 4) continue;
    starts.push(pts.length / 3);
    for (const q of line) {
      pts.push(q.p[0], q.p[1], q.p[2]);
      spd.push(q.v);
      tmp.push(q.t);
    }
  }
  starts.push(pts.length / 3);
  return { points: new Float32Array(pts), speed: new Float32Array(spd), temp: new Float32Array(tmp), starts: new Uint32Array(starts) };
}

/** Seeds for streamlines: across each fan's outlet and each set flow, then the fastest openings to the surroundings. */
export function seedPoints(flow: FlowSolver, extra: V3[][], count = 160): V3[] {
  const g = flow.g;
  const seeds: V3[] = [];
  for (const group of extra) {
    const take = Math.max(1, Math.floor(count / Math.max(1, extra.length) / 2));
    for (let i = 0; i < group.length && i < take * 4; i += Math.max(1, Math.floor(group.length / take))) seeds.push(group[i]);
  }
  // air cells next to the surroundings with the most flow through them
  const open: { c: number; u: number }[] = [];
  for (let c = 0; c < g.kind.length; c++) {
    if (g.kind[c] !== FLUID) continue;
    const s = flow.cellSpeed(c);
    if (s > 0) open.push({ c, u: s });
  }
  open.sort((a, b) => b.u - a.u);
  const stride = Math.max(1, Math.floor(open.length / (count * 4)));
  for (let i = 0; i < open.length && seeds.length < count; i += stride) seeds.push(cellCentre(g, open[i].c));
  return seeds;
}

/** The field to draw: per cell velocity, temperature and pressure, every cell. */
export function fieldOf(flow: FlowSolver, T: Float64Array): FlowField {
  const g = flow.g;
  const N = g.nx * g.ny * g.nz;
  const data = new Float32Array(5 * N);
  for (let c = 0; c < N; c++) {
    if (g.kind[c] === FLUID) {
      const v = flow.cellVelocity(c);
      data[5 * c] = v[0];
      data[5 * c + 1] = v[1];
      data[5 * c + 2] = v[2];
      data[5 * c + 4] = flow.p[c];
    }
    data[5 * c + 3] = T[c];
  }
  return { dims: [g.nx, g.ny, g.nz], origin: g.origin, h: g.hmm, data, kind: g.kind.slice() };
}
