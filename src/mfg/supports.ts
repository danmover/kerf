// The support material a printed part needs as it lies on the bed: a column under every downward face steeper than
// the printer's overhang limit, down to the bed or to the part below, the way a slicer's normal supports go. Short
// spans held at both ends bridge instead, and faces just off the bed squash onto it, as the overhang check says.
// The columns at the support's infill give the grams and minutes they add; their footprint shows where they go.

import { TriBVH } from "./bvh";

export interface SupportOptions {
  /** steepest overhang that prints without support, degrees from vertical (45) */
  maxAngle?: number;
  /** column spacing, mm: 2, coarser on a big part so it stays quick */
  cell?: number;
  /** support infill as a share of solid (0.15) */
  density?: number;
  /** a gap under a downward face shorter than this needs nothing, mm (the first layers squash onto the bed) */
  minGap?: number;
  /** spans up to this long, held at both ends, bridge without support, mm (10) */
  bridge?: number;
}

export interface SupportCell {
  /** the column's centre on the bed, in the part's print frame */
  x: number;
  y: number;
  /** from the bed (true) or standing on the part itself */
  fromBed: boolean;
  /** column height, mm */
  h: number;
}

export interface SupportEstimate {
  /** support material, mm³ (as solid plastic) */
  volume: number;
  /** downward surface held up, mm² (seen from below) */
  area: number;
  /** spans that bridge instead, mm² (seen from below) */
  bridged: number;
  /** tallest column, mm */
  tallest: number;
  cell: number;
  cells: SupportCell[];
}

const EMPTY: SupportEstimate = { volume: 0, area: 0, bridged: 0, tallest: 0, cell: 2, cells: [] };

/** A part's supports, from its mesh in the print frame (z up, resting on z = 0). */
export function supportEstimate(P: ArrayLike<number>, I: ArrayLike<number>, opts: SupportOptions = {}): SupportEstimate {
  const n = Math.floor(I.length / 3);
  if (!n) return EMPTY;
  const sinMax = Math.sin(((opts.maxAngle ?? 45) * Math.PI) / 180);
  const density = opts.density ?? 0.15;
  const minGap = opts.minGap ?? 0.5;
  const bridge = opts.bridge ?? 10;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    x0 = Math.min(x0, P[i]);
    x1 = Math.max(x1, P[i]);
    y0 = Math.min(y0, P[i + 1]);
    y1 = Math.max(y1, P[i + 1]);
    z0 = Math.min(z0, P[i + 2]);
    z1 = Math.max(z1, P[i + 2]);
  }
  // at most about 6000 columns, so a big part stays quick
  const cell = Math.max(opts.cell ?? 2, Math.sqrt(((x1 - x0) * (y1 - y0)) / 6000));
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  const ox = (x0 + x1) / 2 - (nx * cell) / 2;
  const oy = (y0 + y1) / 2 - (ny * cell) / 2;
  const bvh = new TriBVH(P, I);
  const T = bvh.tris;
  const nz = (tri: number) => {
    const o = tri * 9;
    const ux = T[o + 3] - T[o];
    const uy = T[o + 4] - T[o + 1];
    const uz = T[o + 5] - T[o + 2];
    const vx = T[o + 6] - T[o];
    const vy = T[o + 7] - T[o + 1];
    const vz = T[o + 8] - T[o + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    return cz / (Math.hypot(cx, cy, cz) || 1);
  };
  // each column: where the ray down it meets the part, top to bottom, and which way each face there looks
  const hits: { z: number; up: number }[][] = new Array(nx * ny);
  const top = z1 + 1;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      // a hair off the cell centre, off the edges of a mesh drawn on round numbers
      const x = ox + (i + 0.5) * cell + 1.3e-3;
      const y = oy + (j + 0.5) * cell + 0.7e-3;
      const list: { z: number; up: number }[] = [];
      let t = 0;
      let skip = -1;
      for (let k = 0; k < 64; k++) {
        const h = bvh.raycast(x, y, top, 0, 0, -1, t, top - z0 + 1, skip);
        if (!h) break;
        const up = nz(h.tri);
        const last = list[list.length - 1];
        // a ray down a shared edge meets both triangles: one face there, not two
        if (!last || last.z - (top - h.t) > 1e-3 || Math.sign(last.up) !== Math.sign(up)) list.push({ z: top - h.t, up });
        t = h.t + 1e-4;
        skip = h.tri;
      }
      hits[j * nx + i] = list;
    }
  // inside the part at this height in a column: below an odd number of faces
  const solidAt = (i: number, j: number, z: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    let inside = false;
    for (const h of hits[j * nx + i]) {
      if (h.z < z) break;
      inside = !inside;
    }
    return inside;
  };
  // the downward faces that need holding up, with the gap under each
  type Need = { i: number; j: number; z: number; gap: number; fromBed: boolean };
  const needs: Need[] = [];
  const at = new Map<number, Need[]>();
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const list = hits[j * nx + i];
      for (let k = 0; k < list.length; k++) {
        const h = list[k];
        if (-h.up <= sinMax + 1e-6) continue;
        const below = list[k + 1];
        const gap = h.z - (below ? below.z : 0);
        if (gap < minGap) continue;
        const nd: Need = { i, j, z: h.z, gap, fromBed: !below };
        needs.push(nd);
        const key = j * nx + i;
        at.set(key, [...(at.get(key) ?? []), nd]);
      }
    }
  // spans held at both ends bridge: group the faces into ceilings, and a ceiling no wider than a bridge whose rows
  // end in solid part on both sides needs no support
  const seen = new Set<Need>();
  const bridged = new Set<Need>();
  const near = (a: Need, b: Need) => Math.abs(a.z - b.z) <= cell * 1.5;
  for (const s of needs) {
    if (seen.has(s)) continue;
    const region: Need[] = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const c = stack.pop()!;
      region.push(c);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        for (const o of at.get(j * nx + i) ?? []) if (!seen.has(o) && near(c, o)) (seen.add(o), stack.push(o));
      }
    }
    let i0 = Infinity;
    let i1 = -Infinity;
    let j0 = Infinity;
    let j1 = -Infinity;
    for (const r of region) (i0 = Math.min(i0, r.i), (i1 = Math.max(i1, r.i)), (j0 = Math.min(j0, r.j)), (j1 = Math.max(j1, r.j)));
    const spanX = (i1 - i0 + 1) * cell;
    const spanY = (j1 - j0 + 1) * cell;
    if (Math.min(spanX, spanY) > bridge + cell) continue;
    // across the narrow way: each row's two ends must sit against the part at that height
    const acrossX = spanX <= spanY;
    const rows = new Map<number, Need[]>();
    for (const r of region) {
      const k = acrossX ? r.j : r.i;
      rows.set(k, [...(rows.get(k) ?? []), r]);
    }
    // held: the part goes on down past the ceiling just beyond each end (a wall or post, not more of the ceiling)
    let held = 0;
    for (const row of rows.values()) {
      const lo = row.reduce((a, b) => ((acrossX ? b.i < a.i : b.j < a.j) ? b : a));
      const hi = row.reduce((a, b) => ((acrossX ? b.i > a.i : b.j > a.j) ? b : a));
      const a = acrossX ? solidAt(lo.i - 1, lo.j, lo.z - 0.3) : solidAt(lo.i, lo.j - 1, lo.z - 0.3);
      const b = acrossX ? solidAt(hi.i + 1, hi.j, hi.z - 0.3) : solidAt(hi.i, hi.j + 1, hi.z - 0.3);
      if (a && b) held++;
    }
    if (held >= 0.8 * rows.size) for (const r of region) bridged.add(r);
  }
  const out: SupportEstimate = { volume: 0, area: 0, bridged: 0, tallest: 0, cell, cells: [] };
  const a = cell * cell;
  for (const s of needs) {
    if (bridged.has(s)) {
      out.bridged += a;
      continue;
    }
    out.area += a;
    out.volume += s.gap * a * density;
    out.tallest = Math.max(out.tallest, s.gap);
    out.cells.push({ x: ox + (s.i + 0.5) * cell, y: oy + (s.j + 0.5) * cell, fromBed: s.fromBed, h: s.gap });
  }
  return out;
}
