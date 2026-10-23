// The D3Q19 lattice and the numbers every airflow kernel shares. The CPU
// reference solver and the WGSL kernels are both written from these, so a
// direction index means the same thing everywhere: 0 at rest, then the six
// faces, then the twelve edges, each followed by its opposite.

export const Q = 19;

export const CX = [0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 0, 0, 1, -1, 1, -1, 0, 0] as const;
export const CY = [0, 0, 0, 1, -1, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 1, -1] as const;
export const CZ = [0, 0, 0, 0, 0, 1, -1, 0, 0, 1, -1, 1, -1, 0, 0, -1, 1, -1, 1] as const;
export const W = [1 / 3, ...Array(6).fill(1 / 18), ...Array(12).fill(1 / 36)] as readonly number[];

/** the direction pointing the other way */
export const OPP = CX.map((_, i) => (i === 0 ? 0 : i % 2 ? i + 1 : i - 1));

// Cell types, in the low four bits of a cell's flag word. The upper 24 bits
// hold the part index (solid cells) or the boundary record index + 1 (fluid
// cells next to a wall or holding a sub-grid part).
export const FLUID = 0;
export const SOLID = 1;
/** held at the free-stream equilibrium: the inlet and the far field */
export const FARFIELD = 2;
export const TYPE_MASK = 15;
export const INDEX_SHIFT = 8;

// Wall model: the log law as an explicit power law (Werner and Wengle), u+ = A·y+^B above the
// viscous sublayer, which ends where the two laws meet.
export const WW_A = 8.3;
export const WW_B = 1 / 7;
export const WW_YPLUS = 11.81;
/** von Kármán's constant and van Driest's damping length (in wall units), for the eddy viscosity next to a wall */
export const KAPPA = 0.41;
export const VAN_DRIEST = 26;
/** share of the gap to its target the wall model's slip closes each step */
export const SLIP_RATE = 0.1;

/** drag coefficient of geometry thinner than a cell (spokes, cables, mesh), as a cylinder in cross flow */
export const SUBGRID_CD = 1.0;

/**
 * Smagorinsky constant. 0.12 to 0.17 is usual for LES; the lower end keeps more of the small eddies that a wake
 * sheds, which matters at the coarse cells a whole vehicle allows.
 */
export const SMAGORINSKY = 0.14;

/**
 * Away from walls the Smagorinsky viscosity is scaled by how three-dimensional the strain is: r/q^1.5 of the strain
 * tensor (q its second invariant, r = −det), zero in a plain shear like a laminar boundary layer's edge and about 0.2
 * in turbulence. Full strength from SGS_STRAIN up, never below SGS_FLOOR (shear layers still need some damping).
 * Without it the model thickens laminar boundary layers: a sphere at Re 10⁴ read 36 % low, 21 % low with it. Cells
 * on a wall keep the full model: their relaxation times sit so close to ½ that Re 10⁵ went unstable without it.
 */
export const SGS_STRAIN = 0.2;
export const SGS_FLOOR = 0.1;

/**
 * Lattice speed of the free stream. Compressibility errors grow with its square (Mach 0.13 here, about 2 % on
 * pressure next to the body), while the run time falls as it rises.
 */
export const U_LATTICE = 0.075;
