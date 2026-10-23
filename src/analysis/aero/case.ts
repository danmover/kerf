// One airflow problem on the lattice, as the solvers take it: the grid, what
// each cell is, the wall links next to bodies, how each body moves, and the
// relaxation settings. Everything is in lattice units (cell size 1, time step
// 1, free-stream density 1). setup.ts builds it from meshes; the tests build
// small ones by hand.

import type { V3 } from "./geometry";

/** How a body moves, so its walls drag the air with them: u = v + w × (p − c), lattice units. */
export interface PartMotion {
  c: V3;
  /** angular velocity, radians per step */
  w: V3;
  /** velocity, cells per step */
  v: V3;
}

/**
 * Boundary records: one per fluid cell next to a wall or holding part of a body thinner than a cell. Sorted by part
 * so each part's records are one run (partStart[p] .. partStart[p + 1]).
 */
export interface Records {
  count: number;
  cell: Uint32Array;
  /** the part that owns the record (the one most of its wall links lead to) */
  part: Uint32Array;
  /** for each of the 18 moving directions i: where the wall sits along the link to the solid cell the population arrives from, 0..1 of the way (0: no wall that way) */
  q: Float32Array;
  /** unit normal from the nearest wall point toward the cell centre, and the distance to it, for the wall model (dist 0: none) */
  nrm: Float32Array;
  dist: Float32Array;
  /** the share of the cell filled by geometry too thin to resolve, with no wall link of its own */
  phi: Float32Array;
  partStart: Uint32Array;
}

export interface LbmCase {
  nx: number;
  ny: number;
  nz: number;
  /** per cell: type in the low bits, part or record index above (lattice.ts) */
  flags: Uint32Array;
  rec: Records;
  parts: PartMotion[];
  /** free-stream velocity, lattice units */
  u: V3;
  /**
   * Far-field cells with a state of their own (an inflow profile, or the edge of a nested run taken from a coarser
   * one): velocity xyz and density change per entry; a far-field cell's upper flag bits hold its entry + 1 (0: the free stream).
   */
  far?: Float32Array;
  /** relaxation time from the molecular viscosity: 3ν + ½ */
  tau0: number;
  /** Smagorinsky constant (0 turns the eddy viscosity off) */
  cs: number;
  wallModel: boolean;
  /** the sponge before the outlet: from x = spongeX the relaxation time rises to spongeTau at the last plane */
  spongeX: number;
  spongeTau: number;
  /** wrap round in x, y or z instead of holding an inlet, outlet or far field there (channels, slabs and tests) */
  periodic: [boolean, boolean, boolean];
  /** cells per side of a block of the averaged flow field (1 or 2) */
  coarse: number;
  /** a flow to start from instead of the free stream (the averaged flow of a coarser run round the same bodies) */
  start?: StartField;
}

/**
 * A coarser grid's flow, as velocity xyz and density change per cell (lattice units, 4 floats per cell). Cell
 * (x, y, z) of this case sits at offset + scale·(x, y, z) on it, and takes its flow by trilinear interpolation.
 */
export interface StartField {
  dims: V3;
  data: Float32Array;
  scale: number;
  offset: V3;
}

/** The start field's flow at a cell of the case: velocity xyz and density change into out[0..3]. */
export function startAt(s: StartField, x: number, y: number, z: number, out: Float64Array) {
  const d = s.dims;
  const lo = [0, 0, 0];
  const fr = [0, 0, 0];
  const p = [x, y, z];
  for (let k = 0; k < 3; k++) {
    const t = Math.min(Math.max(s.offset[k] + s.scale * p[k], 0), d[k] - 1);
    lo[k] = Math.min(Math.floor(t), Math.max(d[k] - 2, 0));
    fr[k] = t - lo[k];
  }
  out.fill(0, 0, 4);
  for (let k = 0; k < 8; k++) {
    const bx = k & 1,
      by = (k >> 1) & 1,
      bz = k >> 2;
    const w = (bx ? fr[0] : 1 - fr[0]) * (by ? fr[1] : 1 - fr[1]) * (bz ? fr[2] : 1 - fr[2]);
    if (!w) continue;
    const o = 4 * (Math.min(lo[0] + bx, d[0] - 1) + d[0] * (Math.min(lo[1] + by, d[1] - 1) + d[1] * Math.min(lo[2] + bz, d[2] - 1)));
    for (let j = 0; j < 4; j++) out[j] += w * s.data[o + j];
  }
}

export const cellCount = (c: Pick<LbmCase, "nx" | "ny" | "nz">) => c.nx * c.ny * c.nz;

/** Dimensions of the averaged flow field. */
export function coarseDims(c: Pick<LbmCase, "nx" | "ny" | "nz" | "coarse">): V3 {
  const k = c.coarse;
  return [Math.ceil(c.nx / k), Math.ceil(c.ny / k), Math.ceil(c.nz / k)];
}

/** Floats per record in the averaged record output: force (3), density change (1), velocity (3), samples of nothing else */
export const REC_AVG = 8;
/** Floats per coarse cell in the averaged field: velocity (3), density change (1), |u|² (1), fluid samples (1), spare (2) */
export const FIELD_AVG = 8;

/** Empty records, for cases with no walls. */
export function noRecords(nParts: number): Records {
  return { count: 0, cell: new Uint32Array(0), part: new Uint32Array(0), q: new Float32Array(0), nrm: new Float32Array(0), dist: new Float32Array(0), phi: new Float32Array(0), partStart: new Uint32Array(nParts + 1) };
}
