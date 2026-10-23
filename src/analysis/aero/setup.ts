// From a design to lattice cases: the wind tunnel's axes at each yaw, how big
// the tunnel and its cells are, and the grid, walls and moving parts in it.
//
// A run uses two nested tunnels when the bodies are small next to the space
// the air needs round them: a coarse outer tunnel big enough that its walls
// barely squeeze the flow, and a fine inner box just round the bodies whose
// inlet, sides and top hold the outer run's averaged flow (and which starts
// from it, so its wake is half grown already). Only the inner box's forces
// are reported.
//
// The tunnel frame has the wind along +x and up along +z. A body facing F
// with the wind at yaw β from its right sees the air come at it along
// −(cos β F + sin β R), R = F × up, and the road slide past at the road
// speed U cos β along −F.

import { buildGrid, type Body, type V3 } from "./geometry";
import { cellCount, startAt, type LbmCase, type PartMotion, type StartField } from "./case";
import { FARFIELD, INDEX_SHIFT, SMAGORINSKY, TYPE_MASK, U_LATTICE } from "./lattice";
import type { AeroBody, AeroQuality, AirflowInput } from "./types";

/** Where a grid sits in the world: cell (i, j, k)'s centre is origin + (i·ex + j·ey + k·ez)·h, mm. */
export interface Frame {
  origin: V3;
  ex: V3;
  ey: V3;
  ez: V3;
  h: number;
}

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1));

/** World point → lattice coordinates. */
export function toLattice(f: Frame, p: V3): V3 {
  const d = sub(p, f.origin);
  return [dot(d, f.ex) / f.h, dot(d, f.ey) / f.h, dot(d, f.ez) / f.h];
}

/** Lattice coordinates → world point. */
export function toWorld(f: Frame, q: V3): V3 {
  return add(f.origin, scale(add(add(scale(f.ex, q[0]), scale(f.ey, q[1])), scale(f.ez, q[2])), f.h));
}

/** A lattice-frame vector → world. */
export const vecToWorld = (f: Frame, v: V3): V3 => add(add(scale(f.ex, v[0]), scale(f.ey, v[1])), scale(f.ez, v[2]));

/** The body's own axes: the way it faces, up (made square to the facing) and its right. */
export function bodyAxes(input: Pick<AirflowInput, "facing" | "up">): { F: V3; U: V3; R: V3 } {
  const F = norm(input.facing);
  let U = sub(input.up, scale(F, dot(input.up, F)));
  if (Math.hypot(...U) < 1e-6) U = Math.abs(F[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  U = norm(U);
  return { F, U, R: cross(F, U) };
}

/** The tunnel's axes at a yaw (degrees, positive: the wind comes from the body's right). */
export function windAxes(input: Pick<AirflowInput, "facing" | "up">, yaw: number): { ex: V3; ey: V3; ez: V3 } {
  const { F, U, R } = bodyAxes(input);
  const b = (yaw * Math.PI) / 180;
  const ex = norm(scale(add(scale(F, Math.cos(b)), scale(R, Math.sin(b))), -1));
  return { ex, ey: cross(U, ex), ez: U };
}

/** Cells for the inner box (or the only one) and the outer tunnel, by quality and where it runs. */
export function cellBudget(quality: AeroQuality, gpu: boolean): { inner: number; outer: number } {
  const inner = gpu ? { draft: 2e6, standard: 10e6, fine: 32e6 }[quality] : { draft: 4e5, standard: 1.2e6, fine: 3e6 }[quality];
  return { inner, outer: Math.min(4e6, Math.max(2.5e5, 0.2 * inner)) };
}

export interface Bounds {
  lo: V3;
  hi: V3;
}

/** The bodies' extent along the tunnel's axes, mm from the world origin. */
export function boundsAlong(bodies: AeroBody[], ax: { ex: V3; ey: V3; ez: V3 }): Bounds {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  const axes = [ax.ex, ax.ey, ax.ez];
  for (const b of bodies) {
    const P = b.positions;
    for (let v = 0; v < P.length; v += 3) {
      for (let k = 0; k < 3; k++) {
        const a = axes[k];
        const s = P[v] * a[0] + P[v + 1] * a[1] + P[v + 2] * a[2];
        if (s < lo[k]) lo[k] = s;
        if (s > hi[k]) hi[k] = s;
      }
    }
  }
  return { lo, hi };
}

/** One nested level of a run: its grid in the world, and how far its box reaches past the bodies, mm. */
export interface LevelPlan {
  frame: Frame;
  dims: V3;
  /** the road's height in lattice z (cells below it are road), or null for none */
  groundZ: number | null;
  /** the bodies' box in lattice coordinates */
  body: Bounds;
  /** cells in the sponge before the outlet */
  sponge: number;
}

export interface RunPlan {
  axes: { ex: V3; ey: V3; ez: V3 };
  /** outer first; the last level is the one whose forces count */
  levels: LevelPlan[];
  /** the bodies' size: along the wind, across it and up, mm */
  size: V3;
}

/**
 * Lays out the tunnel(s) for one yaw. The outer tunnel leaves room for the flow to go round and the wake to
 * grow; the inner box hugs the bodies. Two levels only when the outer would be several times the inner's volume.
 */
export function planRun(input: AirflowInput, yaw: number, budget: { inner: number; outer: number }): RunPlan {
  const axes = windAxes(input, yaw);
  const b = boundsAlong(input.bodies, axes);
  const L = b.hi[0] - b.lo[0];
  const W = b.hi[1] - b.lo[1];
  const H = b.hi[2] - b.lo[2];
  const S = Math.max(H, W, 0.3 * L, 1);
  // the wake's width scale: the near wake, about two of these long, sets the base pressure
  const D = Math.max(Math.min(H, W), 0.1 * S);
  const ground = input.ground;

  // at low Reynolds numbers the body's disturbance dies away slowly (viscous, not potential, flow), so a tight tunnel
  // adds drag (a sphere at Re 200 read 12 % more than in a tunnel over twice as wide): widen them below Re 2·10⁴
  const re = (input.speed * S * 1e-3) / input.nu;
  const g = 1 + 0.6 * Math.min(2, Math.max(0, Math.log10(2e4 / re)));
  // margins: [upstream, downstream, each side, below, above], mm
  const outerM = [g * S + 0.2 * L, 2 * S + 0.5 * L, g * 1.5 * S, ground ? 0 : g * 1.5 * S, g * 1.5 * S];
  const side = g * Math.max(0.25 * S, 0.6 * D);
  const innerM = [g * Math.max(0.3 * S, 0.75 * D), Math.max(0.5 * S + 0.15 * L, 2 * D) * 1.06, side, ground ? 0 : side, g * Math.max(0.3 * S, 0.6 * D)];
  const box = (m: number[]): [V3, V3] => [
    [b.lo[0] - m[0], b.lo[1] - m[2], b.lo[2] - m[3]],
    [b.hi[0] + m[1], b.hi[1] + m[2], b.hi[2] + m[4]],
  ];
  const vol = ([lo, hi]: [V3, V3]) => (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  const inner = box(innerM);
  const outer = box(outerM);
  const fixedH = input.h && input.h > 0 ? input.h : 0;
  const hIn = fixedH || Math.cbrt(vol(inner) / (input.cells > 0 ? input.cells : budget.inner));
  const hOut = Math.cbrt(vol(outer) / budget.outer);
  // nesting pays when the outer tunnel at the inner's cell size would need several times the cells
  const nest = hOut > 1.6 * hIn;
  const boxes: [V3, V3, number][] = nest ? [[...outer, hOut], [...inner, hIn]] : [[...outer, Math.max(hIn, Math.cbrt(vol(outer) / Math.max(budget.inner, 1)))]];
  const levels = boxes.map(([lo, hi, h]) => level(axes, b, lo, hi, h, ground));
  return { axes, levels, size: [L, W, H] };
}

function level(axes: { ex: V3; ey: V3; ez: V3 }, b: Bounds, lo: V3, hi: V3, h: number, ground: boolean): LevelPlan {
  // a road one cell below the lowest point; the cell centres from half a cell below it, so the road plane sits between
  const zRoad = b.lo[2];
  const lo2: V3 = [lo[0], lo[1], ground ? zRoad - 1.5 * h : lo[2]];
  // an even count along x for the GPU's paired cells
  const nx = 2 * Math.max(8, Math.ceil((hi[0] - lo2[0]) / h / 2));
  const ny = Math.max(8, Math.ceil((hi[1] - lo2[1]) / h));
  const nz = Math.max(8, Math.ceil((hi[2] - lo2[2]) / h));
  const origin = add(add(scale(axes.ex, lo2[0]), scale(axes.ey, lo2[1])), scale(axes.ez, lo2[2]));
  const frame: Frame = { origin, ...axes, h };
  const L = (v: number, k: number) => (v - lo2[k]) / h;
  return {
    frame,
    dims: [nx, ny, nz],
    // the road surface a quarter of a cell into the tyres, so they touch it
    groundZ: ground ? L(zRoad + 0.25 * h, 2) : null,
    body: { lo: [L(b.lo[0], 0), L(b.lo[1], 1), L(b.lo[2], 2)], hi: [L(b.hi[0], 0), L(b.hi[1], 1), L(b.hi[2], 2)] },
    sponge: Math.max(6, Math.round(0.06 * nx)),
  };
}

/** What part index means in a case: a body, or the road. */
export interface PartInfo {
  id: string;
  name: string;
  extra?: boolean;
  road?: boolean;
}

export interface BuiltLevel {
  plan: LevelPlan;
  case: LbmCase;
  parts: PartInfo[];
  /** body index → its lattice-space mesh (for mapping results back) */
  bodies: Body[];
  missed: number;
  solidCells: number;
}

/** Lattice viscosity for a cell size: the air's ν scaled by the lattice speed. */
export function latticeNu(input: Pick<AirflowInput, "nu" | "speed">, hMm: number): number {
  return (input.nu * U_LATTICE) / (input.speed * hMm * 1e-3);
}

/**
 * The lattice case for one level: voxelised bodies, the road and its motion, spinning wheels, the free stream along
 * +x, and (for an inner level) the far field and start flow taken from the outer run's averaged flow.
 */
export function buildLevel(input: AirflowInput, yaw: number, plan: LevelPlan, parent?: { plan: LevelPlan; mean: Float32Array; dims: V3; coarse: number }): BuiltLevel {
  const { frame } = plan;
  const [nx, ny, nz] = plan.dims;
  const { F, U } = bodyAxes(input);
  const beta = (yaw * Math.PI) / 180;
  const road = U_LATTICE * Math.cos(beta);
  const parts: PartInfo[] = input.bodies.map((b) => ({ id: b.id, name: b.name, extra: b.extra }));
  const motions: PartMotion[] = [];
  const bodies: Body[] = [];
  for (const [k, b] of input.bodies.entries()) {
    const P = b.positions;
    const out = new Float64Array(P.length);
    for (let v = 0; v < P.length; v += 3) {
      const q = toLattice(frame, [P[v], P[v + 1], P[v + 2]]);
      out[v] = q[0];
      out[v + 1] = q[1];
      out[v + 2] = q[2];
    }
    bodies.push({ positions: out, indices: b.indices, part: k });
    let m: PartMotion = { c: [0, 0, 0], w: [0, 0, 0], v: [0, 0, 0] };
    if (b.wheel && input.ground) {
      const ax = norm(b.wheel.axis);
      // the rolling radius: given, or the farthest point from the axle
      let R = b.wheel.radius ?? 0;
      if (!R)
        for (let v = 0; v < P.length; v += 3) {
          const d = sub([P[v], P[v + 1], P[v + 2]], b.wheel.origin);
          R = Math.max(R, Math.hypot(...sub(d, scale(ax, dot(d, ax)))));
        }
      if (R > 0) {
        // rolls forward at the road speed: ω = (V/R)·(up × F), the part of it about the axle
        const spin = dot(cross(U, F), ax);
        const wWorld = scale(ax, (spin * road) / (R / frame.h));
        m = { c: toLattice(frame, b.wheel.origin), w: [dot(wWorld, frame.ex), dot(wWorld, frame.ey), dot(wWorld, frame.ez)], v: [0, 0, 0] };
      }
    }
    motions.push(m);
  }
  const roadPart = parts.length;
  if (plan.groundZ !== null) {
    parts.push({ id: "road", name: "Road", road: true });
    // the road slides back along −F at the road speed
    const v = scale(F, -road);
    motions.push({ c: [0, 0, 0], w: [0, 0, 0], v: [dot(v, frame.ex), dot(v, frame.ey), dot(v, frame.ez)] });
  }
  const g = buildGrid({ nx, ny, nz, bodies, ground: plan.groundZ !== null ? { z: plan.groundZ, part: roadPart } : undefined }, parts.length);

  const nu = latticeNu(input, frame.h);
  const c: LbmCase = {
    nx,
    ny,
    nz,
    flags: g.flags,
    rec: g.rec,
    parts: motions,
    u: [U_LATTICE, 0, 0],
    tau0: 3 * nu + 0.5,
    cs: SMAGORINSKY,
    wallModel: true,
    spongeX: nx - 1 - plan.sponge,
    spongeTau: 1,
    periodic: [false, false, false],
    coarse: cellCount({ nx, ny, nz }) > 4e6 ? 2 : 1,
  };
  if (parent) nestIn(c, plan, parent);
  return { plan, case: c, parts, bodies, missed: g.missed, solidCells: g.solidCells };
}

/**
 * Hangs an inner level off the outer run's averaged flow (velocity and density change per block): its far-field
 * cells hold that flow, and every cell starts from it.
 */
function nestIn(c: LbmCase, plan: LevelPlan, parent: { plan: LevelPlan; mean: Float32Array; dims: V3; coarse: number }) {
  const P = parent.plan.frame;
  const f = plan.frame;
  const k = parent.coarse;
  const d = sub(f.origin, P.origin);
  // block coordinates on the parent's averaged grid: block centres sit at (k − 1)/2 + k·i in its cells
  const start: StartField = {
    dims: parent.dims,
    data: parent.mean,
    scale: f.h / (P.h * k),
    offset: [(dot(d, P.ex) / P.h - (k - 1) / 2) / k, (dot(d, P.ey) / P.h - (k - 1) / 2) / k, (dot(d, P.ez) / P.h - (k - 1) / 2) / k],
  };
  c.start = start;
  const { nx, ny, flags } = c;
  const far: number[] = [];
  const s = new Float64Array(4);
  for (let n = 0; n < flags.length; n++) {
    if ((flags[n] & TYPE_MASK) !== FARFIELD) continue;
    startAt(start, n % nx, Math.floor(n / nx) % ny, Math.floor(n / (nx * ny)), s);
    far.push(s[0], s[1], s[2], s[3]);
    flags[n] = FARFIELD | ((far.length / 4) << INDEX_SHIFT);
  }
  c.far = Float32Array.from(far);
}

/**
 * The averaged flow per block as velocity and density change (4 floats per block), from the solver's sums. Blocks
 * no air reached (inside solids) are left at rest.
 */
export function meanFlow(field: Float32Array, blocks: number): Float32Array {
  const out = new Float32Array(blocks * 4);
  for (let b = 0; b < blocks; b++) {
    const n = field[b * 8 + 5];
    if (!(n > 0)) continue;
    out[4 * b] = field[b * 8] / n;
    out[4 * b + 1] = field[b * 8 + 1] / n;
    out[4 * b + 2] = field[b * 8 + 2] / n;
    out[4 * b + 3] = field[b * 8 + 3] / n;
  }
  return out;
}
