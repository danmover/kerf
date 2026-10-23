// Linear static stress analysis of one or more parts: voxel mesh, supports
// and loads, multigrid solve, then stresses recovered at the nodes and
// sampled back onto the real CAD surface for display. Environment-agnostic
// so it runs in the analysis worker and in Node tests.

import { CORNERS, principal, vonMises, elementMatrices } from "./element";
import { applyK, buildHierarchy, coarseningPlan, makeLevel, pcg } from "./solver";
import { jacobiEigen } from "./dense";
import { meshBounds, meshVolume, voxelizeMesh, type TriMesh, type V3 } from "./voxel";
import type { ContactResult, FloorSpec, LoadSpec, MassSpec, RegionSpec, SupportSpec } from "../spec";
import { lowestModes } from "./modal";
import { describeRegion, MIN_ELEMENT_SIZE, UNRELIABLE_RESIDUAL } from "../spec";
import { allowableStress, type MechMaterial } from "../materials";

export class FeaError extends Error {}

export interface FeaPart {
  /** instance id (EvalPart.id) */
  id: string;
  /** block name in the design */
  name: string;
  /** world-space triangle mesh */
  mesh: TriMesh;
  /** world-space vertex normals, for display */
  normals?: Float32Array;
  /** index into materials */
  material: number;
}

export interface StructuralInput {
  label: string;
  parts: FeaPart[];
  materials: MechMaterial[];
  supports: SupportSpec[];
  loads: LoadSpec[];
  /** body acceleration in g */
  accel?: V3;
  /** target number of active elements when h is not given */
  target: number;
  h?: number;
  printed: boolean;
  buildDir: V3;
  cycles?: number;
  safety: number;
  maxDeflection?: number;
  /** relative residual for the solve */
  tol?: number;
  /** masses the parts carry that are not modelled as solids */
  masses?: MassSpec[];
  /** find this many natural frequencies and mode shapes */
  modes?: number;
  /**
   * A drop: accel is 1 g along dir and the support is the side that lands; the result is scaled to the
   * peak deceleration the fall's energy gives against the body's and the floor's stiffness.
   */
  drop?: { height?: number; tip?: boolean; dir: V3; floor: FloorSpec };
}

export interface ModeResult {
  /** natural frequency, Hz */
  freq: number;
  /** share of the moving mass that takes part along X, Y and Z (effective modal mass) */
  share: V3;
  /** participation factor along X, Y and Z (displacement of the largest-moving point per unit base acceleration × ω²) */
  gamma: V3;
  /** the largest-moving point and its shape amplitude (M-normalised shape, mm per √t) */
  peak: Located;
}

export interface ModalResult {
  modes: ModeResult[];
  /** moving mass, kg */
  mass: number;
  iterations: number;
  residual: number;
  converged: boolean;
  ms: number;
}

export interface DropResult {
  /** fall height used (worked out for a tip-over), mm */
  height: number;
  tip: boolean;
  /** the way it moves into the floor (for an edge or corner, from the centre of mass through the point that lands) */
  dir: V3;
  floor: string;
  /** peak deceleration of the whole body in g, peak contact force in N, impact speed in m/s, energy in J */
  g: number;
  force: number;
  speed: number;
  energy: number;
  /** how long the impact lasts, ms, and how far the contact gives, mm */
  pulseMs: number;
  squash: number;
  /** the parts' own lowest frequency for this load (Rayleigh, from the 1 g shape), Hz, and how they answer the pulse: */
  bodyHz: number;
  /** below 1 the impact is over before they can flex fully; up to about 1.8 when it lasts about as long as their swing */
  amplification: number;
  /** the g the parts are loaded with: g × amplification */
  felt: number;
  /** total weight in N and the contact's stiffness, N/mm */
  weight: number;
  contactStiffness: number;
  contact: { at: V3; area: number };
  /** centre of mass */
  com: V3;
}

/**
 * Peak response of an undamped oscillator to a half-sine pulse, relative to the same acceleration held
 * still (the shock response spectrum), for a pulse lasting tau of the oscillator's periods. About 4·tau
 * for short pulses, peaking near 1.77 at tau ≈ 0.8 and settling to 1 for long ones.
 */
export function halfSineShock(tau: number): number {
  if (!(tau > 0)) return 0;
  let beta = 1 / (2 * tau);
  if (Math.abs(1 - beta) < 1e-6) beta = 1 - 1e-6;
  // during the pulse, with a(t) = sin(Ωt), ω = 1: x(t) = (sin Ωt − β sin t) / (1 − β²), Ω = β
  const td = Math.PI / beta;
  const k = 1 / (1 - beta * beta);
  let peak = 0;
  for (let i = 1; i <= 400; i++) {
    const t = (td * i) / 400;
    peak = Math.max(peak, Math.abs(k * (Math.sin(beta * t) - beta * Math.sin(t))));
  }
  // afterwards it swings freely with the amplitude it has when the pulse ends
  const x = k * (Math.sin(beta * td) - beta * Math.sin(td));
  const v = k * (beta * Math.cos(beta * td) - beta * Math.cos(td));
  return Math.max(peak, Math.hypot(x, v));
}

export interface PartField {
  id: string;
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array;
  /** per vertex: displacement xyz (mm) */
  disp: Float32Array;
  /** per vertex: von Mises stress (MPa) */
  stress: Float32Array;
  /** per vertex: largest principal strain by magnitude (fraction) */
  strain: Float32Array;
  /** per vertex: factor of safety */
  safety: Float32Array;
  /** per mode: the mode shape at each vertex (xyz), scaled so the largest movement is 1 */
  modes?: Float32Array[];
}

export interface Located {
  value: number;
  at: V3;
}

export interface StructuralResult {
  label: string;
  mesh: { h: number; cell: V3; grid: V3; elements: number; nodes: number; dofs: number; levels: number; partial: number };
  solve: { iterations: number; residual: number; converged: boolean; history: number[]; ms: { mesh: number; setup: number; solve: number; post: number; total: number } };
  maxDisp: Located;
  maxStress: Located & { nearBoundary: boolean; away: Located | null };
  maxStrain: Located;
  /** lowest safety factor; away: the lowest a short way from supports and loads, when the overall lowest sits on one */
  minSafety: SafetyAt & { nearBoundary: boolean; away: SafetyAt | null };
  layer: Located | null;
  hotSpots: { at: V3; stress: number; safety: number }[];
  applied: V3;
  reaction: V3;
  equilibrium: number;
  mass: number;
  volume: number;
  /** at: centroid of the loaded surface (a torque's centre for torques); vector: net force; axis: a torque's axis */
  loads: { kind: LoadSpec["t"]; region: string; at: V3; vector: V3; magnitude: number; area: number; nodes: number; axis?: V3 }[];
  supports: { region: string; dir?: V3; at: V3; nodes: number; reaction: V3; markers: Float32Array; contact?: ContactResult }[];
  gravity: { vector: V3; at: V3 } | null;
  parts: PartField[];
  ranges: { stress: [number, number]; disp: [number, number]; strain: [number, number]; safety: [number, number] };
  warnings: string[];
  materials: { name: string; E: number; yield: number; allowable: number; basis: "yield" | "fatigue"; layerFactor: number; assumed: boolean }[];
  modal?: ModalResult;
  drop?: DropResult;
}

export type SafetyAt = Located & { mode: "yield" | "fatigue" | "layers"; allowable: number; material: string };

export type Progress = (stage: string, frac: number, info?: { iter?: number; residual?: number }) => void;

const FILL_MIN = 0.12;
const MAX_CELLS = 3_500_000;
/** solid elements, about three times the "fine" target: beyond this memory and time grow past what a browser tab should spend */
export const MAX_ELEMENTS = 350_000;
const G0 = 9.80665;

const FACE_CORNERS = [
  [0, 2, 4, 6],
  [1, 3, 5, 7],
  [0, 1, 4, 5],
  [2, 3, 6, 7],
  [0, 1, 2, 3],
  [4, 5, 6, 7],
];
const FACE_NORMAL: V3[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l];
};
const fmt = (n: number, d = 2) => String(Math.round(n * 10 ** d) / 10 ** d);
const fmtP = (p: V3) => `(${p.map((v) => fmt(v, 1)).join(", ")})`;

/**
 * A torque T shared over weighted points as a couple: each is pushed as if the points were turned rigidly about
 * their own weighted centre (f = w ω × r, with I ω = T for I their weighted inertia), so the pushes add up to
 * exactly T and nothing else: no net force and no twist about any other axis. Plain pushes round the axis would
 * also tip a zone that is not symmetric about it. null when the points have no lever arm about T (all on its line).
 */
export function shareTorque(ps: V3[], w: number[], T: V3): V3[] | null {
  const tot = w.reduce((s, v) => s + v, 0);
  if (!(tot > 0)) return null;
  const c: V3 = [0, 0, 0];
  ps.forEach((p, s) => {
    for (let d = 0; d < 3; d++) c[d] += (p[d] * w[s]) / tot;
  });
  const rs = ps.map((p): V3 => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  const I = new Float64Array(9);
  rs.forEach((r, s) => {
    const r2 = dot(r, r);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[a * 3 + b] += w[s] * ((a === b ? r2 : 0) - r[a] * r[b]);
  });
  const { values, vectors } = jacobiEigen(I, 3);
  const big = Math.max(...values, 0);
  const mag = Math.hypot(...T);
  const om: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v: V3 = [vectors[3 * k], vectors[3 * k + 1], vectors[3 * k + 2]];
    const tk = dot(v, T);
    // points on a line cannot be twisted about that line
    if (big < 1e-12 || values[k] <= 1e-9 * big) {
      if (Math.abs(tk) > 1e-6 * mag) return null;
      continue;
    }
    for (let d = 0; d < 3; d++) om[d] += (tk / values[k]) * v[d];
  }
  return rs.map((r, s): V3 => [w[s] * (om[1] * r[2] - om[2] * r[1]), w[s] * (om[2] * r[0] - om[0] * r[2]), w[s] * (om[0] * r[1] - om[1] * r[0])]);
}

/**
 * Cells per axis for the analysis grid. Cells fit the bounding box exactly, thin directions get
 * smaller cells within about 3:1 of the others, and the grid and its solid elements stay within
 * MAX_CELLS and MAX_ELEMENTS by enlarging cells (and, for very thin parts, stretching them further).
 * cells is null when even that cannot bring the model within limits.
 */
export function sizeGrid(ext: V3, volume: number, target: number, h?: number): { cells: V3 | null; raised: boolean } {
  const asked = h ?? Math.cbrt(Math.max(volume, 1e-9) / Math.max(target, 100));
  const fit = (h0: number, aspect: number): V3 => {
    const c = ext.map((e) => Math.max(1, Math.round(e / h0)));
    const small = Math.min(...ext.map((e, d) => e / c[d]));
    for (let d = 0; d < 3; d++) c[d] = Math.max(c[d], Math.ceil(ext[d] / (aspect * small) - 1e-9));
    return c as V3;
  };
  const count = (c: V3) => c[0] * c[1] * c[2];
  const active = (c: V3) => (volume * count(c)) / (ext[0] * ext[1] * ext[2]);
  let h0 = asked;
  let aspect = 3;
  let cells = fit(h0, aspect);
  if (!h) while (active(cells) > 4 * target && aspect < 40) cells = fit(h0, (aspect *= 1.5));
  const over = () => count(cells) > MAX_CELLS || active(cells) > MAX_ELEMENTS;
  if (over()) {
    // size directly from the worse of the two ratios, then nudge for rounding (bounded)
    h0 *= Math.cbrt(Math.max(count(cells) / MAX_CELLS, active(cells) / MAX_ELEMENTS));
    cells = fit(h0, aspect);
    for (let k = 0; k < 40 && over(); k++) cells = fit((h0 *= 1.05), aspect);
    // a thin part: the cell shape limit keeps the count up, so let cells stretch further
    for (let k = 0; k < 40 && over() && aspect < 200; k++) cells = fit(h0, (aspect *= 1.25));
  }
  return { cells: over() ? null : cells, raised: h0 > asked * 1.01 };
}

export function runStructural(inp: StructuralInput, progress: Progress = () => undefined): StructuralResult {
  const t0 = now();
  const warnings: string[] = [];
  if (!inp.parts.length) throw new FeaError("Nothing to analyse: the analysis names no parts with built geometry.");
  if (!inp.supports.length) throw new FeaError("The analysis has no supports. Add fix: to say how the part is held, for example fix: face(bracket, -Y).");
  if (!inp.loads.length && !inp.accel && !inp.modes) throw new FeaError("The analysis has no loads. Add load: force(...), pressure(...) or torque(...), or gravity.");

  // ---------- grid ----------
  // Cells fit the bounding box exactly (their size differs slightly per axis), so the outer faces of
  // prismatic parts, where supports and loads usually sit, fall on element faces instead of cutting
  // through half-filled cells. Thin directions get smaller cells, kept within about 3:1 of the others.
  const meshes = inp.parts.map((p) => p.mesh);
  const [lo, hi] = meshBounds(meshes);
  const ext: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  if (!ext.every((e) => Number.isFinite(e) && e > 0)) throw new FeaError("The analysed parts have no usable geometry.");
  const diag = Math.hypot(...ext);
  const volume = meshes.reduce((s, m) => s + meshVolume(m), 0);
  if (inp.h !== undefined && !(Number.isFinite(inp.h) && inp.h >= MIN_ELEMENT_SIZE)) throw new FeaError(`resolution: the element size must be at least ${MIN_ELEMENT_SIZE} mm.`);
  const { cells: cellsN, raised } = sizeGrid(ext, volume, inp.target, inp.h);
  if (!cellsN) throw new FeaError("These parts are too large and thin to analyse in one go here. Analyse fewer parts at once, or the thin part on its own.");
  const hv: V3 = [ext[0] / cellsN[0], ext[1] / cellsN[1], ext[2] / cellsN[2]];
  const [hx, hy, hz] = hv;
  const hmax = Math.max(...hv);
  /** nominal element size, for messages */
  const h = Math.cbrt(hx * hy * hz);
  if (raised) warnings.push(`${inp.h ? `Element size raised from ${fmt(inp.h)} mm to ${fmt(h)} mm` : `Elements enlarged to ${fmt(h)} mm`} to keep the model within memory (about ${MAX_ELEMENTS.toLocaleString("en")} elements at most).`);
  if (hmax / Math.min(...hv) > 4.5) warnings.push(`Elements are stretched up to ${fmt(hmax / Math.min(...hv), 0)}:1 to fit a thin part; stresses are less reliable than usual.`);
  const plan = coarseningPlan(cellsN, hv);
  const [nx, ny, nz] = plan.padded;
  const origin: V3 = [lo[0], lo[1], lo[2]];
  const NX = nx + 1,
    NY = ny + 1,
    NZ = nz + 1;
  const ne = nx * ny * nz;
  const nn = NX * NY * NZ;
  const nodePos = (n: number): V3 => {
    const i = n % NX,
      j = Math.floor(n / NX) % NY,
      k = Math.floor(n / (NX * NY));
    return [origin[0] + i * hx, origin[1] + j * hy, origin[2] + k * hz];
  };
  progress("Meshing", 0.02);

  // ---------- voxelise ----------
  const fill = new Float32Array(ne);
  const best = new Float32Array(ne);
  const owner = new Int16Array(ne).fill(-1);
  const grid = { h: hv, origin, n: [nx, ny, nz] as V3 };
  inp.parts.forEach((p, pi) => {
    const f = voxelizeMesh(p.mesh, grid, 3);
    for (let e = 0; e < ne; e++) {
      const v = f[e];
      if (v <= 0) continue;
      fill[e] += v;
      if (v > best[e]) {
        best[e] = v;
        owner[e] = pi;
      }
    }
    progress("Meshing", 0.02 + (0.18 * (pi + 1)) / inp.parts.length);
  });
  const active = new Uint8Array(ne);
  let nActive = 0;
  for (let e = 0; e < ne; e++) {
    if (fill[e] > 1) fill[e] = 1;
    if (fill[e] >= FILL_MIN) {
      active[e] = 1;
      nActive++;
    }
  }
  if (nActive < 8) throw new FeaError(`The parts are too small for ${fmt(h)} mm elements. Use a smaller element size, for example resolution: ${fmt(h / 3)}mm.`);
  const tMesh = now();

  const eIndex = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const elemNode0 = (e: number) => {
    const i = e % nx,
      j = Math.floor(e / nx) % ny,
      k = Math.floor(e / (nx * ny));
    return i + NX * (j + NY * k);
  };
  const off = [0, 1, NX, NX + 1, NX * NY, NX * NY + 1, NX * NY + NX, NX * NY + NX + 1];

  // ---------- islands (face-connected pieces) ----------
  const island = new Int32Array(ne).fill(-1);
  const islandSize: number[] = [];
  {
    const queue = new Int32Array(nActive);
    for (let e0 = 0; e0 < ne; e0++) {
      if (!active[e0] || island[e0] >= 0) continue;
      const id = islandSize.length;
      let head = 0,
        tail = 0;
      queue[tail++] = e0;
      island[e0] = id;
      while (head < tail) {
        const e = queue[head++];
        const i = e % nx,
          j = Math.floor(e / nx) % ny,
          k = Math.floor(e / (nx * ny));
        const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1, k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
        for (const f of nb)
          if (f >= 0 && active[f] && island[f] < 0) {
            island[f] = id;
            queue[tail++] = f;
          }
      }
      islandSize.push(tail);
    }
  }

  // ---------- exposed faces ----------
  const exposed = () => {
    const fe: number[] = [];
    const fd: number[] = [];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const e = eIndex(i, j, k);
          if (!active[e]) continue;
          const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1, k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
          for (let d = 0; d < 6; d++)
            if (nb[d] < 0 || !active[nb[d]]) {
              fe.push(e);
              fd.push(d);
            }
        }
    return { fe: Int32Array.from(fe), fd: Uint8Array.from(fd) };
  };
  let faces = exposed();

  // ---------- regions ----------
  interface Sel {
    nodes: number[];
    w: number[];
    av: number[];
    area: number;
  }
  const partsByName = new Map<string, number[]>();
  inp.parts.forEach((p, i) => partsByName.set(p.name, [...(partsByName.get(p.name) ?? []), i]));
  const select = (r: RegionSpec): Sel => {
    const map = new Map<number, number>();
    const sel: Sel = { nodes: [], w: [], av: [], area: 0 };
    const pad = 0.75 * hmax;
    let partSet: Set<number> | null = null;
    let maxProj = 0;
    let dir: V3 = [0, 0, 1];
    let faceTol = 0;
    let axis: V3 = [0, 0, 1];
    if (r.t === "face") {
      const idx = partsByName.get(r.part);
      if (!idx) throw new FeaError(`face(${r.part}, …): "${r.part}" is not one of the analysed parts (${[...partsByName.keys()].join(", ")}).`);
      partSet = new Set(idx);
      dir = norm(r.dir);
      faceTol = 0.5 * (Math.abs(dir[0]) * hx + Math.abs(dir[1]) * hy + Math.abs(dir[2]) * hz);
      maxProj = -Infinity;
      for (const pi of idx) {
        const P = inp.parts[pi].mesh.positions;
        for (let v = 0; v < P.length; v += 3) maxProj = Math.max(maxProj, P[v] * dir[0] + P[v + 1] * dir[1] + P[v + 2] * dir[2]);
      }
    } else if (r.t === "extreme") {
      // what lands first: every analysed part's surface within reach of the furthest point along dir
      dir = norm(r.dir);
      const flat = Math.max(Math.abs(dir[0]), Math.abs(dir[1]), Math.abs(dir[2])) > 0.999;
      faceTol = flat ? 0.5 * (Math.abs(dir[0]) * hx + Math.abs(dir[1]) * hy + Math.abs(dir[2]) * hz) : 1.5 * hmax;
      maxProj = -Infinity;
      for (const p of inp.parts) {
        const P = p.mesh.positions;
        for (let v = 0; v < P.length; v += 3) maxProj = Math.max(maxProj, P[v] * dir[0] + P[v + 1] * dir[1] + P[v + 2] * dir[2]);
      }
    } else if (r.t === "cyl") axis = norm(r.axis);
    const inside = (p: V3): boolean => {
      switch (r.t) {
        case "face":
        case "extreme":
          return dot(p, dir) >= maxProj - faceTol;
        case "sphere":
          return Math.hypot(p[0] - r.at[0], p[1] - r.at[1], p[2] - r.at[2]) <= r.r + pad;
        case "box":
          return Math.abs(p[0] - r.at[0]) <= r.size[0] / 2 + pad && Math.abs(p[1] - r.at[1]) <= r.size[1] / 2 + pad && Math.abs(p[2] - r.at[2]) <= r.size[2] / 2 + pad;
        case "cyl": {
          const v: V3 = [p[0] - r.at[0], p[1] - r.at[1], p[2] - r.at[2]];
          const s = dot(v, axis);
          if (s < -pad || s > r.length + pad) return false;
          const rad = Math.hypot(v[0] - s * axis[0], v[1] - s * axis[1], v[2] - s * axis[2]);
          return rad <= r.d / 2 + pad;
        }
      }
    };
    // a quarter of each exposed cell face goes to each of its corners
    const quarter = [(hy * hz) / 4, (hy * hz) / 4, (hx * hz) / 4, (hx * hz) / 4, (hx * hy) / 4, (hx * hy) / 4];
    for (let f = 0; f < faces.fe.length; f++) {
      const e = faces.fe[f];
      const d = faces.fd[f];
      const q = quarter[d];
      if (partSet && !partSet.has(owner[e])) continue;
      const nrm = FACE_NORMAL[d];
      if (r.t === "face" && dot(nrm, dir) <= 0.5) continue;
      if (r.t === "extreme" && dot(nrm, dir) <= 0.2) continue;
      const n0 = elemNode0(e);
      for (const a of FACE_CORNERS[d]) {
        const n = n0 + off[a];
        if (!inside(nodePos(n))) continue;
        let s = map.get(n);
        if (s === undefined) {
          s = sel.nodes.length;
          map.set(n, s);
          sel.nodes.push(n);
          sel.w.push(0);
          sel.av.push(0, 0, 0);
        }
        sel.w[s] += q;
        sel.av[3 * s] += q * nrm[0];
        sel.av[3 * s + 1] += q * nrm[1];
        sel.av[3 * s + 2] += q * nrm[2];
        sel.area += q;
      }
    }
    return sel;
  };

  // ---------- supports and the pieces they hold ----------
  const supportSel = inp.supports.map((s, i) => {
    const sel = select(s.region);
    if (!sel.nodes.length) throw new FeaError(`Support ${i + 1} (${describeRegion(s.region)}) does not touch the part's surface. Move the zone onto the part.`);
    return sel;
  });
  const islandHeld = new Uint8Array(islandSize.length);
  const nodeIslands = (n: number, out: Set<number>) => {
    const i = n % NX,
      j = Math.floor(n / NX) % NY,
      k = Math.floor(n / (NX * NY));
    for (let dk = -1; dk <= 0; dk++)
      for (let dj = -1; dj <= 0; dj++)
        for (let di = -1; di <= 0; di++) {
          const a = i + di,
            b = j + dj,
            c = k + dk;
          if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
          const e = eIndex(a, b, c);
          if (active[e]) out.add(island[e]);
        }
  };
  for (const sel of supportSel) {
    const s = new Set<number>();
    for (const n of sel.nodes) nodeIslands(n, s);
    for (const id of s) islandHeld[id] = 1;
  }
  let loose = 0;
  let looseBig = -1;
  for (let id = 0; id < islandSize.length; id++) {
    if (islandHeld[id]) continue;
    loose += islandSize[id];
    if (looseBig < 0 || islandSize[id] > islandSize[looseBig]) looseBig = id;
  }
  if (loose > 0) {
    if (loose > 0.02 * nActive || islandSize[looseBig] > 200) {
      let c: V3 = [0, 0, 0];
      let cnt = 0;
      for (let e = 0; e < ne; e++)
        if (island[e] === looseBig) {
          const p = nodePos(elemNode0(e));
          c = [c[0] + p[0], c[1] + p[1], c[2] + p[2]];
          cnt++;
        }
      c = [c[0] / cnt + hx / 2, c[1] / cnt + hy / 2, c[2] / cnt + hz / 2];
      throw new FeaError(
        `Part of the model near ${fmtP(c)} (${islandSize[looseBig]} elements) is not connected to any support, so it would fly away. ` +
          `Either it is a separate part that needs its own support, or a wall thinner than the ${fmt(h)} mm elements cuts it off: try resolution: "fine".`,
      );
    }
    for (let e = 0; e < ne; e++)
      if (active[e] && !islandHeld[island[e]]) {
        active[e] = 0;
        nActive--;
      }
    warnings.push(`Ignored ${loose} element${loose > 1 ? "s" : ""} in small loose pieces that no support holds (thin slivers at this element size).`);
    faces = exposed();
  }

  // ---------- boundary conditions ----------
  const bc = new Uint8Array(3 * nn);
  const supportInfo: StructuralResult["supports"] = [];
  inp.supports.forEach((s, i) => {
    const sel = select(s.region);
    if (!sel.nodes.length) throw new FeaError(`Support ${i + 1} (${describeRegion(s.region)}) does not touch the part's surface.`);
    let comps = [0, 1, 2];
    let dir: V3 | undefined;
    if (s.dir) {
      const d = norm(s.dir);
      const k = [0, 1, 2].reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a), 0);
      if (Math.abs(Math.abs(d[k]) - 1) > 0.02) warnings.push(`Support ${i + 1}: rollers act along X, Y or Z; ${fmtP(d)} was treated as ${"XYZ"[k]}.`);
      comps = [k];
      dir = [0, 0, 0];
      dir[k] = 1;
    }
    let c: V3 = [0, 0, 0];
    for (const n of sel.nodes) {
      for (const k of comps) bc[3 * n + k] = 1;
      const p = nodePos(n);
      c = [c[0] + p[0], c[1] + p[1], c[2] + p[2]];
    }
    const m = sel.nodes.length;
    const step = Math.max(1, Math.floor(m / 260));
    const markers: number[] = [];
    for (let q = 0; q < m; q += step) {
      const p = nodePos(sel.nodes[q]);
      // nudge the marker out along the surface normal so it sits on the voxel skin
      const a: V3 = norm([sel.av[3 * q], sel.av[3 * q + 1], sel.av[3 * q + 2]]);
      markers.push(p[0], p[1], p[2], a[0], a[1], a[2]);
    }
    supportInfo.push({ region: describeRegion(s.region), dir, at: [c[0] / m, c[1] / m, c[2] / m], nodes: m, reaction: [0, 0, 0], markers: Float32Array.from(markers) });
  });

  // ---------- loads ----------
  const f = new Float64Array(3 * nn);
  const loadInfo: StructuralResult["loads"] = [];
  const loadNodes: number[] = [];
  inp.loads.forEach((ld, i) => {
    const sel = select(ld.region);
    if (!sel.nodes.length) throw new FeaError(`Load ${i + 1} (${ld.t} on ${describeRegion(ld.region)}) does not touch the part's surface. Move the zone onto the part.`);
    const tot = sel.w.reduce((s, v) => s + v, 0);
    let R: V3 = [0, 0, 0];
    let c: V3 = [0, 0, 0];
    sel.nodes.forEach((n, s) => {
      const p = nodePos(n);
      c = [c[0] + p[0] * sel.w[s], c[1] + p[1] * sel.w[s], c[2] + p[2] * sel.w[s]];
      loadNodes.push(n);
    });
    c = [c[0] / tot, c[1] / tot, c[2] / tot];
    if (ld.t === "force") {
      sel.nodes.forEach((n, s) => {
        const k = sel.w[s] / tot;
        for (let d = 0; d < 3; d++) f[3 * n + d] += ld.f[d] * k;
      });
      R = [...ld.f] as V3;
    } else if (ld.t === "pressure") {
      sel.nodes.forEach((n, s) => {
        for (let d = 0; d < 3; d++) {
          const v = -ld.p * sel.av[3 * s + d];
          f[3 * n + d] += v;
          R[d] += v;
        }
      });
    } else {
      const ax = norm(ld.axis);
      const pushes = shareTorque(sel.nodes.map(nodePos), sel.w, [ld.torque * ax[0], ld.torque * ax[1], ld.torque * ax[2]]);
      if (!pushes) throw new FeaError(`Load ${i + 1}: the torque zone sits on its own axis, so it has no lever arm. Put the zone on a surface away from the axis (for example a bore or a flange).`);
      sel.nodes.forEach((n, s) => {
        for (let d = 0; d < 3; d++) {
          f[3 * n + d] += pushes[s][d];
          R[d] += pushes[s][d];
        }
      });
    }
    if (ld.t === "torque") loadInfo.push({ kind: ld.t, region: describeRegion(ld.region), at: ld.at ?? c, vector: R, magnitude: Math.abs(ld.torque), area: sel.area, nodes: sel.nodes.length, axis: norm(ld.torque < 0 ? [-ld.axis[0], -ld.axis[1], -ld.axis[2]] : ld.axis) });
    else loadInfo.push({ kind: ld.t, region: describeRegion(ld.region), at: c, vector: R, magnitude: Math.hypot(...R), area: sel.area, nodes: sel.nodes.length });
  });

  // ---------- materials ----------
  const matOf = (e: number) => inp.parts[owner[e]].material;
  const matCount = new Array(inp.materials.length).fill(0);
  let mass = 0;
  let solidVolume = 0;
  for (let e = 0; e < ne; e++) {
    if (!active[e]) continue;
    matCount[matOf(e)]++;
    const v = fill[e] * hx * hy * hz;
    solidVolume += v;
    mass += (v / 1000) * inp.materials[matOf(e)].density;
  }
  // ---------- carried masses (kg per node) ----------
  const extra = new Float64Array(nn);
  let extraKg = 0;
  (inp.masses ?? []).forEach((ms, i) => {
    const sel = select(ms.region);
    if (!sel.nodes.length) throw new FeaError(`Mass ${i + 1} (${fmt(ms.grams, 0)} g on ${describeRegion(ms.region)}) does not touch the part's surface. Move the zone onto the part.`);
    const tot = sel.w.reduce((a, b) => a + b, 0) || 1;
    sel.nodes.forEach((n, q) => (extra[n] += (ms.grams / 1000) * (sel.w[q] / tot)));
    extraKg += ms.grams / 1000;
  });
  mass += extraKg * 1000;
  const mainMat = matCount.indexOf(Math.max(...matCount));
  const nu = inp.materials[mainMat].nu;
  if (new Set(inp.materials.map((m) => m.nu)).size > 1 && matCount.filter((c) => c > 0).length > 1) warnings.push("Mixed materials share one Poisson's ratio in this model; stiffness and stress are still per material.");

  // an edge or corner drop decelerates along the line from the centre of mass through the point that
  // lands (how drop tests set up a corner drop); otherwise the held patch would have to stop it turning
  let dropDir: V3 | undefined;
  if (inp.drop && !inp.drop.tip && inp.drop.dir.filter((x) => Math.abs(x) > 1e-6).length > 1) {
    let c: V3 = [0, 0, 0];
    let mt = 0;
    const add = (m: number, p: V3) => {
      c = [c[0] + m * p[0], c[1] + m * p[1], c[2] + m * p[2]];
      mt += m;
    };
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const p = nodePos(elemNode0(e));
      add(fill[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-6, [p[0] + hx / 2, p[1] + hy / 2, p[2] + hz / 2]);
    }
    for (let n = 0; n < nn; n++) if (extra[n]) add(extra[n], nodePos(n));
    const at = supportInfo[0].at;
    const com: V3 = [c[0] / mt, c[1] / mt, c[2] / mt];
    const d: V3 = [at[0] - com[0], at[1] - com[1], at[2] - com[2]];
    const l = Math.hypot(...d);
    if (l > 1e-9 && dot(d, norm(inp.drop.dir)) > 0) dropDir = [d[0] / l, d[1] / l, d[2] / l];
  }
  let gravity: StructuralResult["gravity"] = null;
  if (inp.accel && Math.hypot(...inp.accel) > 0) {
    const a = dropDir ?? inp.accel;
    let c: V3 = [0, 0, 0];
    let mtot = 0;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const m = fill[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-6; // kg
      const n0 = elemNode0(e);
      for (let q = 0; q < 8; q++) {
        const n = n0 + off[q];
        for (let d = 0; d < 3; d++) f[3 * n + d] += (m * a[d] * G0) / 8;
      }
      const p = nodePos(n0);
      c = [c[0] + m * (p[0] + hx / 2), c[1] + m * (p[1] + hy / 2), c[2] + m * (p[2] + hz / 2)];
      mtot += m;
    }
    for (let n = 0; n < nn; n++) {
      const m = extra[n];
      if (!m) continue;
      for (let d = 0; d < 3; d++) f[3 * n + d] += m * a[d] * G0;
      const p = nodePos(n);
      c = [c[0] + m * p[0], c[1] + m * p[1], c[2] + m * p[2]];
      mtot += m;
    }
    gravity = { vector: [mtot * a[0] * G0, mtot * a[1] * G0, mtot * a[2] * G0], at: [c[0] / mtot, c[1] / mtot, c[2] / mtot] };
  }
  const applied: V3 = [0, 0, 0];
  for (let n = 0; n < nn; n++) for (let d = 0; d < 3; d++) applied[d] += f[3 * n + d];

  // ---------- rigid-body check per held piece ----------
  checkHeld();

  // ---------- solve ----------
  progress("Setting up the solver", 0.22);
  const dense = new Float64Array(ne);
  for (let e = 0; e < ne; e++) if (active[e]) dense[e] = inp.materials[matOf(e)].E * fill[e];
  const fine = makeLevel(nx, ny, nz, hv, nu, dense, bc);
  const H = buildHierarchy(fine, plan.shifts, nu);
  const fs = Float64Array.from(f);
  for (let i = 0; i < fs.length; i++) if (!fine.free[i]) fs[i] = 0;
  const tSetup = now();

  // ---------- natural frequencies ----------
  /** lumped mass in tonnes per node: each element's mass shared by its eight corners, plus carried masses */
  const lumpedMass = () => {
    const nodeMass = new Float64Array(nn);
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const m = (fill[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-9) / 8;
      const n0 = elemNode0(e);
      for (let q = 0; q < 8; q++) nodeMass[n0 + off[q]] += m;
    }
    for (let n = 0; n < nn; n++) nodeMass[n] += extra[n] * 1e-3;
    return nodeMass;
  };
  let modal: ModalResult | undefined;
  let shapes: Float64Array[] = [];
  if (inp.modes) {
    progress("Finding natural frequencies", 0.25);
    const tm = now();
    const nodeMass = lumpedMass();
    const mvec = new Float64Array(3 * nn);
    const mtot: V3 = [0, 0, 0];
    for (let n = 0; n < nn; n++) {
      const m = nodeMass[n];
      for (let d = 0; d < 3; d++)
        if (fine.free[3 * n + d]) {
          mvec[3 * n + d] = m;
          mtot[d] += m;
        }
    }
    const k = Math.max(1, Math.min(12, Math.round(inp.modes)));
    const sol = lowestModes(H, mvec, k, { onIter: (it, res) => progress("Finding natural frequencies", 0.25 + 0.6 * Math.min(1, it / 60), { iter: it, residual: res }) });
    shapes = sol.shapes;
    const modes: ModeResult[] = sol.lambda.map((lam, j) => {
      const phi = sol.shapes[j];
      const gamma: V3 = [0, 0, 0];
      let peak = 0,
        peakN = 0;
      for (let n = 0; n < nn; n++) {
        for (let d = 0; d < 3; d++) gamma[d] += phi[3 * n + d] * mvec[3 * n + d];
        const a = Math.hypot(phi[3 * n], phi[3 * n + 1], phi[3 * n + 2]);
        if (a > peak) {
          peak = a;
          peakN = n;
        }
      }
      return {
        freq: Math.sqrt(Math.max(lam, 0)) / (2 * Math.PI),
        share: gamma.map((g, d) => (mtot[d] > 0 ? (g * g) / mtot[d] : 0)) as V3,
        gamma,
        peak: { value: peak, at: nodePos(peakN) },
      };
    });
    if (!sol.converged) warnings.push(`The frequency solver stopped at a residual of ${sol.residual.toExponential(1)}; frequencies may be off by a few percent.`);
    modal = { modes, mass: ((mtot[0] + mtot[1] + mtot[2]) * 1e6) / 3, iterations: sol.iterations, residual: sol.residual, converged: sol.converged, ms: now() - tm };
  }
  progress("Solving", 0.3);
  const tol = inp.tol ?? 1e-6;
  const { u, stats } = pcg(H, fs, {
    tol,
    maxIter: 300,
    onIter: (it, rel) => progress("Solving", 0.3 + 0.6 * Math.min(1, Math.log(rel) / Math.log(tol)), { iter: it, residual: rel }),
  });
  if (stats.residual > UNRELIABLE_RESIDUAL) warnings.push(`The solver did not converge (relative residual ${stats.residual.toExponential(1)} after ${stats.iterations} iterations), so these numbers are unreliable. Check that supports hold every part, or try another resolution.`);
  else if (!stats.converged) warnings.push(`The solver stopped at a relative residual of ${stats.residual.toExponential(1)} after ${stats.iterations} iterations; results may be off by a few percent.`);
  const tSolve = now();

  // ---------- drop: the impact pulse, and how the parts answer it ----------
  // The body hits the floor through the contact's stiffness: a half-sine pulse whose peak and length
  // follow from the impact speed. The parts flex like their 1 g shape at their own frequency (Rayleigh),
  // so a pulse shorter than their swing loads them less than its peak, and one about as long loads them
  // more (the shock response spectrum). The 1 g solution is scaled by the g they feel.
  let dropResult: DropResult | undefined;
  if (inp.drop && gravity) {
    const dr = inp.drop;
    const W = Math.hypot(...gravity.vector);
    const com = gravity.at;
    let height = dr.height ?? 0;
    if (dr.tip) {
      // it pivots on its bottom edge and lands on the side it falls toward: the centre of mass drops from
      // its height above the base to its distance from that side
      const side = norm(dr.dir);
      let reach = -Infinity;
      for (const p of inp.parts) {
        const P = p.mesh.positions;
        for (let v = 0; v < P.length; v += 3) reach = Math.max(reach, P[v] * side[0] + P[v + 1] * side[1] + P[v + 2] * side[2]);
      }
      height = Math.max(0, com[2] - lo[2] - (reach - dot(com, side)));
    }
    // the parts' frequency in this shape: ω² = fᵀu / Σ m|u|² (N·mm over t·mm²)
    const nodeMass = lumpedMass();
    let fu = 0,
      mu2 = 0;
    for (let i = 0; i < u.length; i++) fu += fs[i] * u[i];
    for (let n = 0; n < nn; n++) if (nodeMass[n]) mu2 += nodeMass[n] * (u[3 * n] ** 2 + u[3 * n + 1] ** 2 + u[3 * n + 2] ** 2);
    const wb = mu2 > 0 && fu > 0 ? Math.sqrt(fu / mu2) : Infinity;
    // the contact: a flat punch of the landing patch's area pressed into the floor, with the body's own
    // material at the patch (plastics give far more than a concrete floor does)
    const contact = supportSel[0];
    const area = Math.max(contact.area, hx * hy * 0.25);
    const at = supportInfo[0].at;
    let near = -1,
      best = Infinity;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const p = nodePos(elemNode0(e));
      const d2 = (p[0] + hx / 2 - at[0]) ** 2 + (p[1] + hy / 2 - at[1]) ** 2 + (p[2] + hz / 2 - at[2]) ** 2;
      if (d2 < best) {
        best = d2;
        near = e;
      }
    }
    const bm = inp.materials[near >= 0 ? matOf(near) : mainMat];
    const punch = (Estar: number) => 2 * Estar * Math.sqrt(area / Math.PI);
    const bodyC = (1 - bm.nu * bm.nu) / bm.E;
    const kc =
      dr.floor.soft !== undefined
        ? 1 / (1 / Math.max(20, dr.floor.soft * area) + 1 / punch(1 / bodyC))
        : punch(1 / (bodyC + (1 - 0.2 * 0.2) / (dr.floor.E ?? 30000)));
    const M = W / (G0 * 1000); // tonnes
    const wc = Math.sqrt(kc / M);
    const v = Math.sqrt(2 * G0 * 1000 * height); // mm/s
    const G = height > 0 ? (v * wc) / (G0 * 1000) : 0;
    const td = Math.PI / wc;
    const amp = Number.isFinite(wb) ? halfSineShock((td * wb) / (2 * Math.PI)) : 1;
    const felt = G * amp;
    for (let i = 0; i < u.length; i++) {
      u[i] *= felt;
      f[i] *= felt;
    }
    for (let d = 0; d < 3; d++) applied[d] *= felt;
    gravity.vector = [gravity.vector[0] * felt, gravity.vector[1] * felt, gravity.vector[2] * felt];
    dropResult = {
      height,
      tip: !!dr.tip,
      dir: norm(dropDir ?? dr.dir),
      floor: dr.floor.name,
      g: G,
      force: G * W,
      speed: v / 1000,
      energy: (W * height) / 1000,
      pulseMs: td * 1000,
      squash: wc > 0 ? v / wc : 0,
      bodyHz: wb / (2 * Math.PI),
      amplification: amp,
      felt,
      weight: W,
      contactStiffness: kc,
      contact: { at, area: contact.area },
      com,
    };
    if (felt > 0 && felt < 1) warnings.push("The landing is soft enough that the drop barely loads the parts.");
  }
  progress("Recovering stresses", 0.92);

  // reactions: full K·u at held dofs
  const Ku = new Float64Array(3 * nn);
  applyK(fine, u, Ku, false);
  const reaction: V3 = [0, 0, 0];
  inp.supports.forEach((_, si) => {
    const sel = select(inp.supports[si].region);
    const R: V3 = [0, 0, 0];
    const seen = new Set<number>();
    for (const n of sel.nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      for (let d = 0; d < 3; d++) if (bc[3 * n + d]) R[d] += Ku[3 * n + d] - f[3 * n + d];
    }
    supportInfo[si].reaction = R;
    const ct = inp.supports[si].contact;
    if (ct) supportInfo[si].contact = contactCheck(inp.supports[si], ct, sel, Ku, f, bc, nodePos);
  });
  for (let n = 0; n < nn; n++) for (let d = 0; d < 3; d++) if (bc[3 * n + d] && fine.free[3 * n + d] === 0 && Ku[3 * n + d] !== 0) reaction[d] += Ku[3 * n + d] - f[3 * n + d];
  const appliedMag = Math.hypot(...applied) || 1;
  const equilibrium = Math.hypot(applied[0] + reaction[0], applied[1] + reaction[1], applied[2] + reaction[2]) / appliedMag;

  // ---------- stress recovery ----------
  const em = elementMatrices(nu, hx, hy, hz);
  const nodeS = new Float64Array(6 * nn);
  const nodeE = new Float64Array(6 * nn);
  const nodeW = new Float64Array(nn);
  const nodeMat = new Int16Array(nn).fill(-1);
  const nodeMatW = new Float32Array(nn);
  const ue = new Float64Array(24);
  const sg = new Float64Array(48);
  const eg = new Float64Array(48);
  for (let e = 0; e < ne; e++) {
    if (!active[e]) continue;
    const n0 = elemNode0(e);
    for (let a = 0; a < 8; a++) {
      const d = 3 * (n0 + off[a]);
      ue[3 * a] = u[d];
      ue[3 * a + 1] = u[d + 1];
      ue[3 * a + 2] = u[d + 2];
    }
    const mat = inp.materials[matOf(e)];
    for (let g = 0; g < 8; g++) {
      const T = em.strainGauss[g];
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let j = 0; j < 24; j++) s += T[r * 24 + j] * ue[j];
        eg[6 * g + r] = s;
      }
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let c = 0; c < 6; c++) s += em.D[r * 6 + c] * eg[6 * g + c];
        sg[6 * g + r] = mat.E * s;
      }
    }
    const w = fill[e];
    for (let a = 0; a < 8; a++) {
      const n = n0 + off[a];
      for (let r = 0; r < 6; r++) {
        let s = 0,
          t = 0;
        for (let g = 0; g < 8; g++) {
          const x = em.extrap[a * 8 + g];
          s += x * sg[6 * g + r];
          t += x * eg[6 * g + r];
        }
        nodeS[6 * n + r] += w * s;
        nodeE[6 * n + r] += w * t;
      }
      nodeW[n] += w;
      if (w > nodeMatW[n]) {
        nodeMatW[n] = w;
        nodeMat[n] = matOf(e);
      }
    }
  }

  // ---------- nodal results ----------
  const allow = inp.materials.map((m) => allowableStress(m, inp.cycles));
  const bd = norm(inp.buildDir);
  const vm = new Float32Array(nn);
  const strainN = new Float32Array(nn);
  const sfN = new Float32Array(nn);
  const sfMode = new Uint8Array(nn);
  const layerN = new Float32Array(nn);
  for (let n = 0; n < nn; n++) {
    const w = nodeW[n];
    if (!(w > 0)) continue;
    const o = 6 * n;
    for (let r = 0; r < 6; r++) {
      nodeS[o + r] /= w;
      nodeE[o + r] /= w;
    }
    const s = vonMises(nodeS, o);
    vm[n] = s;
    const pe = principal(nodeE[o], nodeE[o + 1], nodeE[o + 2], nodeE[o + 3] / 2, nodeE[o + 4] / 2, nodeE[o + 5] / 2);
    strainN[n] = Math.abs(pe[0]) >= Math.abs(pe[2]) ? pe[0] : pe[2];
    const m = inp.materials[nodeMat[n]];
    const al = allow[nodeMat[n]].value;
    let sf = s > 1e-9 ? al / s : 1e6;
    let mode = 0;
    if (inp.printed && m.layerFactor < 1) {
      // normal stress across the layers: n·σ·n along the build direction
      const sn =
        bd[0] * bd[0] * nodeS[o] +
        bd[1] * bd[1] * nodeS[o + 1] +
        bd[2] * bd[2] * nodeS[o + 2] +
        2 * (bd[0] * bd[1] * nodeS[o + 3] + bd[1] * bd[2] * nodeS[o + 4] + bd[2] * bd[0] * nodeS[o + 5]);
      layerN[n] = sn;
      if (sn > 1e-9) {
        const sfl = (al * m.layerFactor) / sn;
        if (sfl < sf) {
          sf = sfl;
          mode = 1;
        }
      }
    }
    sfN[n] = Math.min(sf, 1e6);
    sfMode[n] = mode;
  }

  // nodes next to supports and loads, where idealised boundary conditions distort stress
  const nearBC = new Uint8Array(nn);
  {
    const R = 2;
    const mark = (n: number) => {
      const i = n % NX,
        j = Math.floor(n / NX) % NY,
        k = Math.floor(n / (NX * NY));
      for (let c = Math.max(0, k - R); c <= Math.min(NZ - 1, k + R); c++)
        for (let b = Math.max(0, j - R); b <= Math.min(NY - 1, j + R); b++)
          for (let a = Math.max(0, i - R); a <= Math.min(NX - 1, i + R); a++) nearBC[a + NX * (b + NY * c)] = 1;
    };
    for (let n = 0; n < nn; n++) if (bc[3 * n] | bc[3 * n + 1] | bc[3 * n + 2]) mark(n);
    for (const n of loadNodes) mark(n);
  }

  let iD = -1,
    iS = -1,
    iE = -1,
    iF = -1,
    iA = -1,
    iFA = -1,
    iL = -1;
  let dMax = 0;
  for (let n = 0; n < nn; n++) {
    if (!(nodeW[n] > 0)) continue;
    const d = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
    if (iD < 0 || d > dMax) {
      dMax = d;
      iD = n;
    }
    if (iS < 0 || vm[n] > vm[iS]) iS = n;
    if (iE < 0 || Math.abs(strainN[n]) > Math.abs(strainN[iE])) iE = n;
    if (iF < 0 || sfN[n] < sfN[iF]) iF = n;
    if (!nearBC[n] && (iA < 0 || vm[n] > vm[iA])) iA = n;
    if (!nearBC[n] && (iFA < 0 || sfN[n] < sfN[iFA])) iFA = n;
    if (inp.printed && (iL < 0 || layerN[n] > layerN[iL])) iL = n;
  }

  // hot spots: the highest-stress surface regions, spread apart
  const surfaceNode = new Uint8Array(nn);
  for (let q = 0; q < faces.fe.length; q++) {
    const n0 = elemNode0(faces.fe[q]);
    for (const a of FACE_CORNERS[faces.fd[q]]) surfaceNode[n0 + off[a]] = 1;
  }
  const cand: number[] = [];
  for (let n = 0; n < nn; n++) if (surfaceNode[n] && nodeW[n] > 0) cand.push(n);
  cand.sort((a, b) => vm[b] - vm[a]);
  const spots: number[] = [];
  for (const n of cand) {
    if (spots.length >= 3 || vm[n] < 0.3 * vm[iS]) break;
    const p = nodePos(n);
    if (spots.every((m) => dist(nodePos(m), p) > Math.max(6 * hmax, 0.12 * diag))) spots.push(n);
  }

  // ---------- sample onto the CAD surface ----------
  const sample = (x: number, y: number, z: number, out: Float64Array) => {
    const fx = (x - origin[0]) / hx,
      fy = (y - origin[1]) / hy,
      fz = (z - origin[2]) / hz;
    const i = clampI(Math.floor(fx), 0, nx - 1),
      j = clampI(Math.floor(fy), 0, ny - 1),
      k = clampI(Math.floor(fz), 0, nz - 1);
    const tx = clamp01(fx - i),
      ty = clamp01(fy - j),
      tz = clamp01(fz - k);
    const n0 = i + NX * (j + NY * k);
    out.fill(0);
    let wsum = 0;
    for (let a = 0; a < 8; a++) {
      const n = n0 + off[a];
      if (!(nodeW[n] > 0)) continue;
      const w = (a & 1 ? tx : 1 - tx) * (a & 2 ? ty : 1 - ty) * (a & 4 ? tz : 1 - tz) + 1e-9;
      accumulate(n, w, out);
      wsum += w;
    }
    if (wsum < 1e-6) {
      // the vertex sits in a cell that was too thin to keep: use the nearest kept node
      let bestN = -1,
        bestD = Infinity;
      for (let c = Math.max(0, k - 2); c <= Math.min(NZ - 1, k + 3); c++)
        for (let b = Math.max(0, j - 2); b <= Math.min(NY - 1, j + 3); b++)
          for (let a = Math.max(0, i - 2); a <= Math.min(NX - 1, i + 3); a++) {
            const n = a + NX * (b + NY * c);
            if (!(nodeW[n] > 0)) continue;
            const d = (a - fx) ** 2 + (b - fy) ** 2 + (c - fz) ** 2;
            if (d < bestD) {
              bestD = d;
              bestN = n;
            }
          }
      if (bestN >= 0) {
        accumulate(bestN, 1, out);
        wsum = 1;
      }
    }
    if (wsum > 0) for (let q = 0; q < out.length; q++) out[q] /= wsum;
  };
  function accumulate(n: number, w: number, out: Float64Array) {
    out[0] += w * u[3 * n];
    out[1] += w * u[3 * n + 1];
    out[2] += w * u[3 * n + 2];
    out[3] += w * vm[n];
    out[4] += w * strainN[n];
    // safety blends badly near zero stress; interpolate its inverse (utilisation)
    out[5] += w * (1 / Math.max(sfN[n], 1e-6));
  }
  const tmp = new Float64Array(6);
  const ranges = { stress: [Infinity, -Infinity] as [number, number], disp: [0, 0] as [number, number], strain: [Infinity, -Infinity] as [number, number], safety: [Infinity, -Infinity] as [number, number] };
  const parts: PartField[] = inp.parts.map((p) => {
    const P = p.mesh.positions;
    const nv = P.length / 3;
    const disp = new Float32Array(3 * nv);
    const stress = new Float32Array(nv);
    const strain = new Float32Array(nv);
    const safety = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      sample(P[3 * v], P[3 * v + 1], P[3 * v + 2], tmp);
      disp[3 * v] = tmp[0];
      disp[3 * v + 1] = tmp[1];
      disp[3 * v + 2] = tmp[2];
      stress[v] = tmp[3];
      strain[v] = tmp[4];
      safety[v] = tmp[5] > 0 ? Math.min(1 / tmp[5], 1e6) : 1e6;
      const dm = Math.hypot(tmp[0], tmp[1], tmp[2]);
      if (dm > ranges.disp[1]) ranges.disp[1] = dm;
      ranges.stress[0] = Math.min(ranges.stress[0], tmp[3]);
      ranges.stress[1] = Math.max(ranges.stress[1], tmp[3]);
      ranges.strain[0] = Math.min(ranges.strain[0], tmp[4]);
      ranges.strain[1] = Math.max(ranges.strain[1], tmp[4]);
      ranges.safety[0] = Math.min(ranges.safety[0], safety[v]);
      ranges.safety[1] = Math.max(ranges.safety[1], safety[v]);
    }
    return { id: p.id, name: p.name, positions: Float32Array.from(P), normals: p.normals ?? null, indices: p.mesh.indices, disp, stress, strain, safety };
  });
  // mode shapes on the CAD surface, each scaled so its largest movement is 1
  if (shapes.length) {
    const sampleVec = (vec: Float64Array, x: number, y: number, z: number, out: Float64Array) => {
      const fx = (x - origin[0]) / hx,
        fy = (y - origin[1]) / hy,
        fz = (z - origin[2]) / hz;
      const i = clampI(Math.floor(fx), 0, nx - 1),
        j = clampI(Math.floor(fy), 0, ny - 1),
        k = clampI(Math.floor(fz), 0, nz - 1);
      const tx = clamp01(fx - i),
        ty = clamp01(fy - j),
        tz = clamp01(fz - k);
      const n0 = i + NX * (j + NY * k);
      out.fill(0);
      let wsum = 0;
      for (let a = 0; a < 8; a++) {
        const n = n0 + off[a];
        if (!(nodeW[n] > 0)) continue;
        const w = (a & 1 ? tx : 1 - tx) * (a & 2 ? ty : 1 - ty) * (a & 4 ? tz : 1 - tz) + 1e-9;
        out[0] += w * vec[3 * n];
        out[1] += w * vec[3 * n + 1];
        out[2] += w * vec[3 * n + 2];
        wsum += w;
      }
      if (wsum > 0) for (let q = 0; q < 3; q++) out[q] /= wsum;
    };
    const t3 = new Float64Array(3);
    shapes.forEach((vec, mi) => {
      const per = parts.map((pf) => {
        const P = pf.positions;
        const out = new Float32Array(P.length);
        for (let v = 0; v < P.length; v += 3) {
          sampleVec(vec, P[v], P[v + 1], P[v + 2], t3);
          out[v] = t3[0];
          out[v + 1] = t3[1];
          out[v + 2] = t3[2];
        }
        return out;
      });
      let mx = 0;
      for (const a of per) for (let v = 0; v < a.length; v += 3) mx = Math.max(mx, Math.hypot(a[v], a[v + 1], a[v + 2]));
      const sc = mx > 0 ? 1 / mx : 0;
      per.forEach((a, pi) => {
        for (let v = 0; v < a.length; v++) a[v] *= sc;
        (parts[pi].modes ??= [])[mi] = a;
      });
    });
  }
  // the node maxima are the reported values; keep the colour scale consistent with them
  ranges.stress[1] = Math.max(ranges.stress[1], vm[iS]);
  ranges.disp[1] = Math.max(ranges.disp[1], dMax);

  // ---------- warnings about accuracy ----------
  let partial = 0;
  for (let e = 0; e < ne; e++) if (active[e] && fill[e] < 0.9) partial++;
  const partialShare = partial / Math.max(nActive, 1);
  if (partialShare > 0.55) warnings.push(`Many elements are only partly filled: walls are thin compared with the ${fmt(h)} mm elements, so stiffness and stress are rough. Use resolution: "fine" before relying on the numbers.`);
  if (iS >= 0 && nearBC[iS] && iA >= 0 && vm[iA] < 0.85 * vm[iS])
    warnings.push(`The peak stress sits right at a support or load, where the idealised fixing exaggerates it. A short way off it is ${fmt(vm[iA], 1)} MPa; real fixings spread load and are somewhat gentler.`);
  if (dMax > 0.05 * Math.min(...ext.filter((e) => e > 0)) || dMax > 0.02 * diag)
    warnings.push("The part deflects a lot compared with its size: a linear analysis is no longer accurate, and the real part may buckle or bend further.");
  const yieldNode = iS >= 0 ? inp.materials[nodeMat[iS]] : null;
  if (yieldNode && vm[iS] > yieldNode.yield) warnings.push(`Peak stress (${fmt(vm[iS], 1)} MPa) is above the yield strength of ${yieldNode.name} (${yieldNode.yield} MPa): the part would bend permanently or break, and stresses beyond yield are not physical.`);
  for (const m of inp.materials) if (m.assumed && matCount[inp.materials.indexOf(m)] > 0) warnings.push(m.note ?? `No strength data for ${m.name}.`);
  if (Math.hypot(...applied) > 0 && equilibrium > 0.02) warnings.push(`Reactions balance the loads only to ${fmt(equilibrium * 100, 1)}%.`);

  const pos = (n: number): V3 => (n >= 0 ? nodePos(n) : [0, 0, 0]);
  const safetyAt = (n: number): SafetyAt => {
    const mi = n >= 0 ? nodeMat[n] : mainMat;
    const layers = n >= 0 && sfMode[n] === 1;
    return {
      value: n >= 0 ? sfN[n] : Infinity,
      at: pos(n),
      mode: layers ? "layers" : allow[mi].basis,
      allowable: allow[mi].value * (layers ? inp.materials[mi].layerFactor : 1),
      material: inp.materials[mi].name,
    };
  };
  const safetyNearBC = iF >= 0 && !!nearBC[iF];
  if (iF >= 0 && sfMode[iF] !== 1 && allow[nodeMat[iF]].basis === "fatigue")
    warnings.push("Fatigue strengths are for polished test pieces. Rough, printed or machined surfaces, notches and threads lower them, often by half, so keep a generous margin.");
  const tEnd = now();
  progress("Done", 1);
  return {
    label: inp.label,
    mesh: { h, cell: hv, grid: [nx, ny, nz], elements: nActive, nodes: fine.free.length / 3, dofs: fine.free.reduce((s, v) => s + v, 0), levels: H.levels.length, partial: partialShare },
    solve: { iterations: stats.iterations, residual: stats.residual, converged: stats.converged, history: stats.history, ms: { mesh: tMesh - t0, setup: tSetup - tMesh, solve: tSolve - tSetup, post: tEnd - tSolve, total: tEnd - t0 } },
    maxDisp: { value: dMax, at: pos(iD) },
    maxStress: { value: iS >= 0 ? vm[iS] : 0, at: pos(iS), nearBoundary: iS >= 0 && !!nearBC[iS], away: iA >= 0 ? { value: vm[iA], at: pos(iA) } : null },
    maxStrain: { value: iE >= 0 ? strainN[iE] : 0, at: pos(iE) },
    minSafety: { ...safetyAt(iF), nearBoundary: safetyNearBC, away: safetyNearBC && iFA >= 0 ? safetyAt(iFA) : null },
    layer: inp.printed && iL >= 0 ? { value: layerN[iL], at: pos(iL) } : null,
    hotSpots: spots.map((n) => ({ at: nodePos(n), stress: vm[n], safety: sfN[n] })),
    applied,
    reaction,
    equilibrium,
    mass,
    volume: solidVolume,
    loads: loadInfo,
    supports: supportInfo,
    gravity,
    parts,
    ranges,
    warnings,
    materials: inp.materials.map((m, i) => ({ name: m.name, E: m.E, yield: m.yield, allowable: allow[i].value, basis: allow[i].basis, layerFactor: m.layerFactor, assumed: !!m.assumed })),
    modal,
    drop: dropResult,
  };

  // ----- helpers that need the closure -----
  function checkHeld() {
    // gather held dofs per piece and test whether they stop all six rigid motions
    const pieces = new Map<number, { nodes: number[]; comps: number[] }>();
    const tmpSet = new Set<number>();
    for (let n = 0; n < nn; n++) {
      if (!(bc[3 * n] | bc[3 * n + 1] | bc[3 * n + 2])) continue;
      tmpSet.clear();
      nodeIslands(n, tmpSet);
      for (const id of tmpSet) {
        const p = pieces.get(id) ?? { nodes: [], comps: [] };
        p.nodes.push(n);
        p.comps.push(bc[3 * n] | (bc[3 * n + 1] << 1) | (bc[3 * n + 2] << 2));
        pieces.set(id, p);
      }
    }
    for (const [id, p] of pieces) {
      if (!islandHeld[id] || islandSize[id] < 1) continue;
      let c: V3 = [0, 0, 0];
      for (const n of p.nodes) {
        const q = nodePos(n);
        c = [c[0] + q[0], c[1] + q[1], c[2] + q[2]];
      }
      c = [c[0] / p.nodes.length, c[1] / p.nodes.length, c[2] / p.nodes.length];
      const Lc = Math.max(diag, h);
      const G = new Float64Array(36);
      const m = new Float64Array(6);
      p.nodes.forEach((n, q) => {
        const pp = nodePos(n);
        const x = (pp[0] - c[0]) / Lc,
          y = (pp[1] - c[1]) / Lc,
          z = (pp[2] - c[2]) / Lc;
        for (let d = 0; d < 3; d++) {
          if (!(p.comps[q] & (1 << d))) continue;
          // the d-component of the six rigid modes: Tx, Ty, Tz, Rx, Ry, Rz
          m.fill(0);
          m[d] = 1;
          if (d === 0) {
            m[4] = z;
            m[5] = -y;
          } else if (d === 1) {
            m[3] = -z;
            m[5] = x;
          } else {
            m[3] = y;
            m[4] = -x;
          }
          for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) G[a * 6 + b] += m[a] * m[b];
        }
      });
      const { values, vectors } = jacobiEigen(G, 6);
      const maxV = Math.max(...values, 1e-30);
      const k = values.indexOf(Math.min(...values));
      if (values[k] < 1e-7 * maxV || values[k] < 1e-10) {
        const v = vectors.slice(k * 6, k * 6 + 6);
        const big = [0, 1, 2, 3, 4, 5].sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]))[0];
        const what = big < 3 ? `slide along ${"XYZ"[big]}` : `spin about ${"XYZ"[big - 3]} (around ${fmtP(c)})`;
        throw new FeaError(`The supports do not hold the part still: it can ${what}. Fix a larger area, or add another support (fix: or roller(…)) away from the first.`);
      }
    }
  }
}

const clampI = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export { CORNERS };

/**
 * A seat that is only pressed on: from the reaction at each of its nodes, the
 * net force pressing it, how much of it would rather pull (an edge lifting),
 * and the sliding force and twisting moment its friction (plus any bands round
 * the same tube) has to hold.
 */
function contactCheck(sup: SupportSpec, ct: NonNullable<SupportSpec["contact"]>, sel: { nodes: number[]; av: number[] }, Ku: Float64Array, f: Float64Array, bc: Uint8Array, nodePos: (n: number) => V3): ContactResult {
  const r = sup.region;
  const unit = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
  };
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const tube = r.t === "cyl" ? { at: r.at, axis: unit(r.axis) } : null;
  // the way whatever it rests on pushes the part, at each node
  const inward = (p: V3, q: number): V3 => {
    if (ct.normal) return unit([-ct.normal[0], -ct.normal[1], -ct.normal[2]]);
    if (r.t === "face") return unit([-r.dir[0], -r.dir[1], -r.dir[2]]);
    if (tube) {
      const d: V3 = [p[0] - tube.at[0], p[1] - tube.at[1], p[2] - tube.at[2]];
      const a = dot(d, tube.axis);
      return unit([d[0] - a * tube.axis[0], d[1] - a * tube.axis[1], d[2] - a * tube.axis[2]]);
    }
    return unit([-sel.av[3 * q], -sel.av[3 * q + 1], -sel.av[3 * q + 2]]);
  };
  const seen = new Set<number>();
  const nodes: { p: V3; R: V3; n: V3 }[] = [];
  sel.nodes.forEach((nd, q) => {
    if (seen.has(nd)) return;
    seen.add(nd);
    const R: V3 = [0, 0, 0];
    for (let d = 0; d < 3; d++) if (bc[3 * nd + d]) R[d] = Ku[3 * nd + d] - f[3 * nd + d];
    const p = nodePos(nd);
    nodes.push({ p, R, n: inward(p, q) });
  });
  let push = 0;
  let pull = 0;
  let c: V3 = [0, 0, 0];
  let avgN: V3 = [0, 0, 0];
  for (const k of nodes) {
    const rn = dot(k.R, k.n);
    if (rn >= 0) push += rn;
    else pull -= rn;
    c = [c[0] + k.p[0], c[1] + k.p[1], c[2] + k.p[2]];
    avgN = [avgN[0] + k.n[0], avgN[1] + k.n[1], avgN[2] + k.n[2]];
  }
  const m = Math.max(1, nodes.length);
  c = [c[0] / m, c[1] / m, c[2] / m];
  // Whether an edge lifts is judged from where the pressing force acts, not
  // node by node: a held seat shows pulling at single nodes (it stops the part
  // flexing and shrinking across) even where the real seat stays pressed.
  // Each coordinate across the seat gives the centre of pressure's offset from
  // the middle as a share of the half-width: under 1/3 every part stays
  // pressed (as with a straight pressure ramp), 1 and more and it tips over
  // that edge. Round a tube the coordinates are along it and round it.
  const { lift, liftAt } = seatLift(nodes, tube, unit(avgN), push - pull, c);
  // slide along the tube (or across a flat seat) and twist about the tube's axis (or the seat's normal)
  const axis = tube ? tube.axis : unit(avgN);
  const pivot = tube ? tube.at : c;
  let slideV: V3 = [0, 0, 0];
  let twist = 0;
  let twistHold = 0;
  for (const k of nodes) {
    const rn = dot(k.R, k.n);
    const t: V3 = [k.R[0] - rn * k.n[0], k.R[1] - rn * k.n[1], k.R[2] - rn * k.n[2]];
    const arm: V3 = [k.p[0] - pivot[0], k.p[1] - pivot[1], k.p[2] - pivot[2]];
    const along = dot(arm, axis);
    const rho = Math.hypot(arm[0] - along * axis[0], arm[1] - along * axis[1], arm[2] - along * axis[2]);
    twist += dot(cross(arm, t), axis);
    if (rn > 0) twistHold += ct.mu * rn * rho;
    slideV = [slideV[0] + t[0], slideV[1] + t[1], slideV[2] + t[2]];
  }
  // a tube: only the part along it slides; the rest of the tangential force is the twist, already counted
  const slide = tube ? Math.abs(dot(slideV, axis)) : Math.hypot(...slideV);
  const pressing = push - pull;
  const slideCap = ct.mu * Math.max(0, pressing) + (ct.grip?.force ?? 0);
  const twistCap = twistHold + (ct.grip?.moment ?? 0);
  const use = (slideCap > 0 ? slide / slideCap : slide > 1e-6 ? Infinity : 0) + (twistCap > 0 ? Math.abs(twist) / twistCap : Math.abs(twist) > 1e-6 ? Infinity : 0);
  return { pressing, lift, liftAt, slide, slideCap, twist: Math.abs(twist), twistCap, use };
}

/** How far a seat's centre of pressure sits off its middle (share of the half-width, worst direction) and the edge it unloads. */
function seatLift(nodes: { p: V3; R: V3; n: V3 }[], tube: { at: V3; axis: V3 } | null, avgN: V3, pressing: number, centre: V3): { lift: number; liftAt?: V3 } {
  if (pressing <= 0 || nodes.length < 2) return { lift: pressing > 0 ? 0 : 1 };
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0];
  };
  // two coordinates across the seat for each node
  let coords: (k: { p: V3; n: V3 }) => [number, number];
  if (tube) {
    const ref = unit([avgN[0] - dot(avgN, tube.axis) * tube.axis[0], avgN[1] - dot(avgN, tube.axis) * tube.axis[1], avgN[2] - dot(avgN, tube.axis) * tube.axis[2]]);
    const side = cross(tube.axis, ref);
    coords = (k) => [dot([k.p[0] - tube.at[0], k.p[1] - tube.at[1], k.p[2] - tube.at[2]], tube.axis), Math.atan2(dot(k.n, side), dot(k.n, ref))];
  } else {
    const u = unit(cross(avgN, Math.abs(avgN[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const v = cross(avgN, u);
    coords = (k) => {
      const d: V3 = [k.p[0] - centre[0], k.p[1] - centre[1], k.p[2] - centre[2]];
      return [dot(d, u), dot(d, v)];
    };
  }
  const q = nodes.map((k) => ({ k, c: coords(k), rn: dot(k.R, k.n) }));
  let lift = 0;
  let liftAt: V3 | undefined;
  for (const d of [0, 1]) {
    let lo = Infinity;
    let hi = -Infinity;
    let moment = 0;
    for (const e of q) {
      lo = Math.min(lo, e.c[d]);
      hi = Math.max(hi, e.c[d]);
      moment += e.rn * e.c[d];
    }
    const half = (hi - lo) / 2;
    if (half < 1e-9) continue;
    const off = moment / pressing - (lo + hi) / 2;
    const share = Math.abs(off) / half;
    if (share <= lift) continue;
    lift = share;
    // the edge it unloads: the far side from where the pressure gathers
    const far = q.reduce((a, b) => (off > 0 ? (b.c[d] < a.c[d] ? b : a) : b.c[d] > a.c[d] ? b : a));
    liftAt = far.k.p;
  }
  return { lift, liftAt };
}
