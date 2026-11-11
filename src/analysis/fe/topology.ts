// Topology optimisation on the analysis grid: which of a part's material to keep so that what is left is as stiff
// as it can be under its loads and supports, for the share of material asked for.
//
// Each element carries a density x between empty and solid, and its stiffness goes as x³ (SIMP), so half-dense
// material is a poor bargain and the answer drifts to solid and empty. A tent filter as wide as the thinnest member
// keeps members from getting thinner than that (and stops checkerboards), a smoothed step (a Heaviside projection,
// sharpened as the design settles) makes the result crisp, and an optimality-criteria update moves material from
// where it does little to where it carries load, holding the share of material asked for. Mirror planes and a
// cut-from-plate direction tie elements together. The shape it finds is drawn as a smoothed surface through the
// density at one half, which is also what is exported to print.

import type { V3 } from "./voxel";

/** The optimisation asked for, as the solver takes it (regions resolved to the grid by the caller). */
export interface TopologyOptions {
  /** share of the design space's material to keep, 0–1 */
  keep: number;
  /** filter radius, mm: about the thinnest member it leaves */
  radius: number;
  /** mirror planes through the middle of the design space, by axis (0 = X) */
  symmetry: number[];
  /** the same profile all the way through along this axis (to cut from plate), by axis */
  cut?: number;
  /** most design iterations */
  iterations: number;
}

/** What the optimiser needs from the analysis: the grid, which elements may change, and a way to solve. */
export interface TopologyProblem {
  /** element counts of the (padded) grid, and the cell size, mm */
  n: [number, number, number];
  h: V3;
  /** cells within the design space's bounding box along each axis (mirror planes are at their middle) */
  cells: [number, number, number];
  /** per element: 1 in the model, 2 kept solid (where it is held or loaded, or preserve:), 0 empty */
  state: Uint8Array;
  /** per element: stiffness when solid (E × fill × …), and solid volume, mm³ */
  E0: Float64Array;
  vol: Float64Array;
  /** solve with these element stiffnesses, starting from u0: the displacements and the compliance fᵀu, N·mm */
  solve(stiff: Float64Array, u0: Float64Array | null, tol: number): { u: Float64Array; compliance: number; iterations: number };
  /** per element in the model: uₑᵀ·Kₑ·uₑ with Kₑ the element's matrix at unit stiffness */
  energy(u: Float64Array, out: Float64Array): void;
  /** the design so far (densities after the filter and step), every few iterations */
  preview?(xbar: Float64Array, iteration: number, volume: number): void;
  progress?(iteration: number, of: number, compliance: number, volume: number, change: number): void;
  /** stop early (the run was cancelled): return true */
  stopped?(): boolean;
}

export interface TopologyRun {
  /** per element: the density, 0–1 (1 where kept solid, 0 outside the model) */
  xbar: Float64Array;
  iterations: number;
  converged: boolean;
  /** per iteration: compliance (N·mm), share of the material in use, largest change of a density, solver iterations */
  history: { compliance: number; volume: number; change: number; solver: number }[];
  /** the compliance of the design space left solid, N·mm, for how much stiffness the optimised shape gives up */
  solidCompliance: number;
  /** share of the design space kept solid however the optimisation goes (supports, loads, preserve:) */
  preserved: number;
  /** where the time went, ms: solving, the energies, and updating the design */
  ms: { solve: number; energy: number; update: number };
}

export class TopologyError extends Error {}

/** SIMP penalty, the floor on stiffness (a share of solid), and the sharpest the step gets */
const PENALTY = 3;
const EMIN = 1e-6;
const BETA_MAX = 16;
const ETA = 0.5;

/**
 * A tent filter over the elements in the model, separable along the axes (the product of a tent per axis), normalised
 * over the model so it does not bleed into the empty cells round it: x̃ = W(m·x) / W(m).
 */
export class TentFilter {
  private w: Float64Array[];
  private R: number[];
  private norm: Float64Array;
  private a: Float64Array;
  private b: Float64Array;
  private src: Float64Array;
  constructor(
    private n: [number, number, number],
    radiusCells: [number, number, number],
    private mask: Uint8Array,
  ) {
    this.R = radiusCells.map((r) => Math.max(0, Math.ceil(r) - 1));
    this.w = radiusCells.map((r, ax) => Float64Array.from({ length: 2 * this.R[ax] + 1 }, (_, q) => Math.max(0, 1 - Math.abs(q - this.R[ax]) / Math.max(r, 1e-9))));
    const ne = n[0] * n[1] * n[2];
    this.a = new Float64Array(ne);
    this.b = new Float64Array(ne);
    this.norm = new Float64Array(ne);
    this.src = new Float64Array(ne);
    const ones = new Float64Array(ne);
    for (let e = 0; e < ne; e++) ones[e] = mask[e] ? 1 : 0;
    this.pass(ones, this.norm);
  }

  /** out = W·src over the whole grid (separable) */
  private pass(src: Float64Array, out: Float64Array) {
    const [nx, ny, nz] = this.n;
    const strides = [1, nx, nx * ny];
    const lens = [nx, ny, nz];
    let from = src;
    const bufs = [this.a, this.b, out];
    for (let ax = 0; ax < 3; ax++) {
      const to = bufs[ax];
      const R = this.R[ax],
        w = this.w[ax],
        st = strides[ax],
        len = lens[ax];
      if (R === 0) {
        to.set(from);
        from = to;
        continue;
      }
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++) {
          const row = nx * (j + ny * k);
          for (let i = 0; i < nx; i++) {
            const c = ax === 0 ? i : ax === 1 ? j : k;
            const e = row + i;
            const q0 = c < R ? -c : -R,
              q1 = len - 1 - c < R ? len - 1 - c : R;
            let s = 0;
            for (let q = q0; q <= q1; q++) s += w[q + R] * from[e + q * st];
            to[e] = s;
          }
        }
      from = to;
    }
  }

  /** x̃ = W(m·x) / W(m) over the model (0 outside it) */
  apply(x: Float64Array, out: Float64Array) {
    const m = this.mask;
    const src = this.src;
    for (let e = 0; e < x.length; e++) src[e] = m[e] ? x[e] : 0;
    this.pass(src, out);
    for (let e = 0; e < out.length; e++) out[e] = m[e] && this.norm[e] > 0 ? out[e] / this.norm[e] : 0;
  }

  /** the chain rule back through the filter: given d/dx̃, d/dx = m·W(g / W(m)) */
  back(g: Float64Array, out: Float64Array) {
    const m = this.mask;
    const src = this.src;
    for (let e = 0; e < g.length; e++) src[e] = m[e] && this.norm[e] > 0 ? g[e] / this.norm[e] : 0;
    this.pass(src, out);
    for (let e = 0; e < out.length; e++) if (!m[e]) out[e] = 0;
  }
}

/** The smoothed step (Heaviside projection) at sharpness β, and its slope. */
export function project(xt: number, beta: number): number {
  const d = Math.tanh(beta * ETA) + Math.tanh(beta * (1 - ETA));
  return (Math.tanh(beta * ETA) + Math.tanh(beta * (xt - ETA))) / d;
}
function projectSlope(xt: number, beta: number): number {
  const d = Math.tanh(beta * ETA) + Math.tanh(beta * (1 - ETA));
  const t = Math.tanh(beta * (xt - ETA));
  return (beta * (1 - t * t)) / d;
}

/**
 * Groups of elements that share one design value: mirror images of each other, and whole lines along the cut
 * direction. A group with any element kept solid is kept solid. Returns the group of each element (−1 when it is not
 * a design element) and the number of groups.
 */
function designGroups(P: TopologyProblem, opt: TopologyOptions): { group: Int32Array; count: number } {
  const [nx, ny, nz] = P.n;
  const ne = nx * ny * nz;
  const parent = new Int32Array(ne);
  for (let e = 0; e < ne; e++) parent[e] = e;
  const find = (e: number): number => {
    while (parent[e] !== e) {
      parent[e] = parent[parent[e]];
      e = parent[e];
    }
    return e;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const st = P.state;
  const stride = [1, nx, nx * ny];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const e = i + nx * (j + ny * k);
        if (!st[e]) continue;
        const ijk = [i, j, k];
        for (const ax of opt.symmetry) {
          const m = P.cells[ax] - 1 - ijk[ax];
          if (m < 0 || m >= P.n[ax] || m === ijk[ax]) continue;
          const f = e + (m - ijk[ax]) * stride[ax];
          if (st[f]) union(e, f);
        }
        if (opt.cut !== undefined && ijk[opt.cut] + 1 < P.n[opt.cut]) {
          const f = e + stride[opt.cut];
          if (st[f]) union(e, f);
        }
      }
  // a group with a solid element stays solid
  const solidRoot = new Uint8Array(ne);
  for (let e = 0; e < ne; e++) if (st[e] === 2) solidRoot[find(e)] = 1;
  const group = new Int32Array(ne).fill(-1);
  const id = new Int32Array(ne).fill(-1);
  let count = 0;
  for (let e = 0; e < ne; e++) {
    if (st[e] !== 1) continue;
    const r = find(e);
    if (solidRoot[r]) {
      st[e] = 2;
      continue;
    }
    if (id[r] < 0) id[r] = count++;
    group[e] = id[r];
  }
  return { group, count };
}

/** Find the stiffest shape that keeps opt.keep of the design space's material. */
/** Whether the compliance has stayed within rel of its mean over the last n steps. */
function settled(h: TopologyRun["history"], n: number, rel: number): boolean {
  if (h.length < n) return false;
  let lo = Infinity,
    hi = -Infinity,
    m = 0;
  for (let i = h.length - n; i < h.length; i++) {
    lo = Math.min(lo, h[i].compliance);
    hi = Math.max(hi, h[i].compliance);
    m += h[i].compliance / n;
  }
  return m > 0 && (hi - lo) / m < rel;
}

export function optimise(P: TopologyProblem, opt: TopologyOptions): TopologyRun {
  const [nx, ny, nz] = P.n;
  const ne = nx * ny * nz;
  const st = P.state;
  const { group, count } = designGroups(P, opt);
  let vSpace = 0,
    vSolid = 0;
  for (let e = 0; e < ne; e++) {
    if (!st[e]) continue;
    vSpace += P.vol[e];
    if (st[e] === 2) vSolid += P.vol[e];
  }
  if (!(vSpace > 0)) throw new TopologyError("There is no material to optimise.");
  const target = opt.keep * vSpace;
  const preserved = vSolid / vSpace;
  if (!count) throw new TopologyError("Every element is kept solid (where the part is held and loaded, or by preserve:), so there is nothing left to optimise.");
  if (vSolid >= target)
    throw new TopologyError(
      `The regions kept solid where the part is held and loaded${preserved > 0 ? " (and by preserve:)" : ""} already take ${Math.round(preserved * 100)} % of the material, more than the ${Math.round(opt.keep * 100)} % asked to keep. Keep more, or hold and load it over smaller regions.`,
    );
  const mask = new Uint8Array(ne);
  for (let e = 0; e < ne; e++) mask[e] = st[e] ? 1 : 0;
  const filter = new TentFilter(P.n, [opt.radius / P.h[0], opt.radius / P.h[1], opt.radius / P.h[2]], mask);

  // design values per group, starting evenly at the share asked for
  const gVol = new Float64Array(count);
  for (let e = 0; e < ne; e++) if (group[e] >= 0) gVol[group[e]] += P.vol[e];
  const x = new Float64Array(count).fill(Math.min(1, (target - vSolid) / (vSpace - vSolid)));
  const xe = new Float64Array(ne);
  const xt = new Float64Array(ne);
  const xbar = new Float64Array(ne);
  const stiff = new Float64Array(ne);
  const ce = new Float64Array(ne);
  const g = new Float64Array(ne);
  const gv = new Float64Array(ne);
  const dcx = new Float64Array(ne);
  const dvx = new Float64Array(ne);
  const dcG = new Float64Array(count);
  const dvG = new Float64Array(count);
  const xNew = new Float64Array(count);
  let beta = 1;
  let lamLast = 0;

  /** element densities from the group values, through the filter and the step */
  const physical = (xs: Float64Array) => {
    for (let e = 0; e < ne; e++) xe[e] = st[e] === 2 ? 1 : group[e] >= 0 ? xs[group[e]] : 0;
    filter.apply(xe, xt);
    let v = 0;
    for (let e = 0; e < ne; e++) {
      const b = st[e] === 2 ? 1 : st[e] ? project(xt[e], beta) : 0;
      xbar[e] = b;
      v += P.vol[e] * b;
    }
    return v;
  };

  // the design space left solid, for how much stiffness the shape gives up
  for (let e = 0; e < ne; e++) stiff[e] = st[e] ? P.E0[e] : 0;
  const solid = P.solve(stiff, null, 1e-4);
  let u: Float64Array | null = solid.u;

  const history: TopologyRun["history"] = [];
  const ms = { solve: 0, energy: 0, update: 0 };
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let it = 0;
  let converged = false;
  let sinceBeta = 0;
  physical(x);
  for (; it < opt.iterations; it++) {
    if (P.stopped?.()) break;
    for (let e = 0; e < ne; e++) stiff[e] = st[e] ? P.E0[e] * (EMIN + (1 - EMIN) * Math.pow(xbar[e], PENALTY)) : 0;
    let t = clock();
    const s = P.solve(stiff, u, beta >= BETA_MAX ? 5e-4 : 1e-3);
    u = s.u;
    ms.solve += clock() - t;
    t = clock();
    P.energy(u, ce);
    ms.energy += clock() - t;
    t = clock();
    // d(compliance)/d(density) per element, back through the step and the filter, then summed per group
    for (let e = 0; e < ne; e++) {
      if (group[e] < 0) {
        g[e] = 0;
        gv[e] = 0;
        continue;
      }
      const slope = projectSlope(xt[e], beta);
      g[e] = -PENALTY * Math.pow(xbar[e], PENALTY - 1) * (1 - EMIN) * P.E0[e] * ce[e] * slope;
      gv[e] = P.vol[e] * slope;
    }
    filter.back(g, dcx);
    filter.back(gv, dvx);
    dcG.fill(0);
    dvG.fill(0);
    for (let e = 0; e < ne; e++) {
      const q = group[e];
      if (q < 0) continue;
      dcG[q] += dcx[e];
      dvG[q] += dvx[e];
    }
    let cMax = 0,
      vMax = 0;
    for (let q = 0; q < count; q++) {
      cMax = Math.max(cMax, -dcG[q]);
      vMax = Math.max(vMax, dvG[q]);
    }
    // smaller steps as the step sharpens: at β = 16 a step of 0.2 flips an element from empty to solid
    const move = Math.max(0.05, Math.min(0.2, 0.28 / Math.sqrt(beta)));
    // optimality criteria: scale each value by √(−dc / λ dv), within the move limit, with λ found so the
    // material in use is the share asked for
    const volAt = (lam: number) => {
      for (let q = 0; q < count; q++) {
        const r = Math.max(0, -dcG[q] / (cMax || 1)) / (lam * Math.max(dvG[q] / (vMax || 1), 1e-12));
        const v = x[q] * Math.sqrt(r);
        xNew[q] = Math.min(1, x[q] + move, Math.max(0, x[q] - move, v));
      }
      return physical(xNew);
    };
    // λ moves little from one step to the next: start near the last one and widen until it brackets the answer
    let lo = lamLast > 0 ? lamLast / 4 : 1e-12,
      hi = lamLast > 0 ? lamLast * 4 : 1e12;
    if (lamLast > 0) {
      while (lo > 1e-12 && volAt(lo) <= target) lo /= 16;
      while (hi < 1e12 && volAt(hi) > target) hi *= 16;
    }
    for (let b = 0; b < 80 && hi / lo > 1 + 1e-6; b++) {
      const lam = Math.sqrt(lo * hi);
      const v = volAt(lam);
      if (Math.abs(v - target) < 1e-4 * target) {
        lo = hi = lam;
        break;
      }
      if (v > target) lo = lam;
      else hi = lam;
    }
    lamLast = Math.sqrt(lo * hi);
    volAt(lamLast);
    let change = 0;
    for (let q = 0; q < count; q++) {
      change = Math.max(change, Math.abs(xNew[q] - x[q]));
      x[q] = xNew[q];
    }
    const used = physical(x) / vSpace;
    ms.update += clock() - t;
    history.push({ compliance: s.compliance, volume: used, change, solver: s.iterations });
    P.progress?.(it + 1, opt.iterations, s.compliance, used, change);
    sinceBeta++;
    // sharpen the step once the design has settled at this sharpness (or after a while), and stop once the
    // sharpest step has stopped making the shape stiffer: a few elements on the edge of the threshold can go on
    // flipping for ever, so the design change alone never settles
    if (beta >= BETA_MAX && sinceBeta >= 6 && settled(history, 5, 0.002) && Math.abs(used - opt.keep) < 0.01) {
      converged = true;
      it++;
      break;
    }
    if (beta < BETA_MAX && it >= 12 && sinceBeta >= 5 && (change < 0.03 || settled(history, 4, 0.005) || sinceBeta >= 10)) {
      beta *= 2;
      sinceBeta = 0;
      physical(x);
    }
    if (P.preview && (it % 4 === 0 || it < 2)) P.preview(xbar, it + 1, used);
  }
  return { xbar: Float64Array.from(xbar), iterations: it, converged, history, solidCompliance: solid.compliance, preserved, ms };
}

// ---------- the surface through the density ----------

/** The 6 tetrahedra of a cube about its 0–7 diagonal (corner a = dx + 2dy + 4dz); neighbouring cubes match. */
const TETS = [
  [0, 1, 3, 7],
  [0, 1, 5, 7],
  [0, 2, 3, 7],
  [0, 2, 6, 7],
  [0, 4, 5, 7],
  [0, 4, 6, 7],
];

/**
 * The surface where a per-element value crosses iso, through the element centres (marching tetrahedra, which leaves
 * a closed surface with no holes or ambiguous cases). Values outside the grid count as 0, so the surface closes at
 * the grid's edge. Triangles face out of the material.
 */
export function isoSurface(value: Float64Array | Float32Array, n: [number, number, number], origin: V3, h: V3, iso = 0.5): { positions: Float32Array; indices: Uint32Array } {
  const [nx, ny, nz] = n;
  // points at element centres, with a ring of zeros round the grid
  const PX = nx + 2,
    PY = ny + 2,
    PZ = nz + 2;
  const at = (i: number, j: number, k: number) => (i < 1 || j < 1 || k < 1 || i > nx || j > ny || k > nz ? 0 : value[i - 1 + nx * (j - 1 + ny * (k - 1))]);
  const pos: number[] = [];
  const idx: number[] = [];
  const edgeVert = new Map<number, number>();
  const NP = PX * PY * PZ;
  const point = (p: number): V3 => {
    const i = p % PX,
      j = Math.floor(p / PX) % PY,
      k = Math.floor(p / (PX * PY));
    return [origin[0] + (i - 0.5) * h[0], origin[1] + (j - 0.5) * h[1], origin[2] + (k - 0.5) * h[2]];
  };
  const cv = new Float64Array(8);
  const cp = new Int32Array(8);
  const vertexOn = (a: number, b: number, va: number, vb: number): number => {
    const lo = Math.min(a, b),
      hi = Math.max(a, b);
    const key = lo * NP + hi;
    let v = edgeVert.get(key);
    if (v !== undefined) return v;
    const t = Math.abs(vb - va) > 1e-12 ? Math.min(1, Math.max(0, (iso - va) / (vb - va))) : 0.5;
    const pa = point(a),
      pb = point(b);
    v = pos.length / 3;
    pos.push(pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1]), pa[2] + t * (pb[2] - pa[2]));
    edgeVert.set(key, v);
    return v;
  };
  const tri = (a: number, b: number, c: number, outward: V3) => {
    const ax = pos[3 * a],
      ay = pos[3 * a + 1],
      az = pos[3 * a + 2];
    const ux = pos[3 * b] - ax,
      uy = pos[3 * b + 1] - ay,
      uz = pos[3 * b + 2] - az;
    const vx = pos[3 * c] - ax,
      vy = pos[3 * c + 1] - ay,
      vz = pos[3 * c + 2] - az;
    const nxv = uy * vz - uz * vy,
      nyv = uz * vx - ux * vz,
      nzv = ux * vy - uy * vx;
    if (nxv * outward[0] + nyv * outward[1] + nzv * outward[2] >= 0) idx.push(a, b, c);
    else idx.push(a, c, b);
  };
  for (let k = 0; k < PZ - 1; k++)
    for (let j = 0; j < PY - 1; j++)
      for (let i = 0; i < PX - 1; i++) {
        let any = 0,
          all = 1;
        for (let c = 0; c < 8; c++) {
          const di = c & 1,
            dj = (c >> 1) & 1,
            dk = (c >> 2) & 1;
          cv[c] = at(i + di, j + dj, k + dk);
          cp[c] = i + di + PX * (j + dj + PY * (k + dk));
          if (cv[c] >= iso) any = 1;
          else all = 0;
        }
        if (!any || all) continue;
        for (const t of TETS) {
          const ins: number[] = [],
            outs: number[] = [];
          for (const c of t) (cv[c] >= iso ? ins : outs).push(c);
          if (!ins.length || !outs.length) continue;
          // outward: from the inside corners toward the outside ones
          const ci = ins.reduce((s, c) => [s[0] + (c & 1), s[1] + ((c >> 1) & 1), s[2] + ((c >> 2) & 1)], [0, 0, 0]).map((v) => v / ins.length);
          const co = outs.reduce((s, c) => [s[0] + (c & 1), s[1] + ((c >> 1) & 1), s[2] + ((c >> 2) & 1)], [0, 0, 0]).map((v) => v / outs.length);
          const out: V3 = [(co[0] - ci[0]) * h[0], (co[1] - ci[1]) * h[1], (co[2] - ci[2]) * h[2]];
          const V = (a: number, b: number) => vertexOn(cp[a], cp[b], cv[a], cv[b]);
          if (ins.length === 1) tri(V(ins[0], outs[0]), V(ins[0], outs[1]), V(ins[0], outs[2]), out);
          else if (ins.length === 3) tri(V(outs[0], ins[0]), V(outs[0], ins[1]), V(outs[0], ins[2]), out);
          else {
            // two in, two out: a quad across the four edges between them
            const a = V(ins[0], outs[0]),
              b = V(ins[0], outs[1]),
              c = V(ins[1], outs[1]),
              d = V(ins[1], outs[0]);
            tri(a, b, c, out);
            tri(a, c, d, out);
          }
        }
      }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/**
 * Taubin smoothing (a shrinking step then an inflating one, each pass): rounds off the voxel steps without shrinking
 * the shape the way plain averaging does.
 */
export function smoothSurface(positions: Float32Array, indices: Uint32Array, passes = 8, lambda = 0.5, mu = -0.53) {
  const nv = positions.length / 3;
  // neighbours of each vertex, from the triangles' edges (each listed once per vertex)
  const deg = new Int32Array(nv + 1);
  const seen = new Set<number>();
  const edges: number[] = [];
  for (let t = 0; t < indices.length; t += 3)
    for (let s = 0; s < 3; s++) {
      const a = indices[t + s],
        b = indices[t + ((s + 1) % 3)];
      const key = Math.min(a, b) * nv + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(a, b);
      deg[a]++;
      deg[b]++;
    }
  const start = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
  const fillAt = Int32Array.from(start.subarray(0, nv));
  const nb = new Int32Array(start[nv]);
  for (let q = 0; q < edges.length; q += 2) {
    nb[fillAt[edges[q]]++] = edges[q + 1];
    nb[fillAt[edges[q + 1]]++] = edges[q];
  }
  const tmp = new Float32Array(positions.length);
  const step = (f: number) => {
    for (let v = 0; v < nv; v++) {
      const s0 = start[v],
        s1 = start[v + 1];
      if (s1 === s0) {
        tmp[3 * v] = positions[3 * v];
        tmp[3 * v + 1] = positions[3 * v + 1];
        tmp[3 * v + 2] = positions[3 * v + 2];
        continue;
      }
      let ax = 0,
        ay = 0,
        az = 0;
      for (let q = s0; q < s1; q++) {
        const w = nb[q];
        ax += positions[3 * w];
        ay += positions[3 * w + 1];
        az += positions[3 * w + 2];
      }
      const c = 1 / (s1 - s0);
      tmp[3 * v] = positions[3 * v] + f * (ax * c - positions[3 * v]);
      tmp[3 * v + 1] = positions[3 * v + 1] + f * (ay * c - positions[3 * v + 1]);
      tmp[3 * v + 2] = positions[3 * v + 2] + f * (az * c - positions[3 * v + 2]);
    }
    positions.set(tmp);
  };
  for (let p = 0; p < passes; p++) {
    step(lambda);
    step(mu);
  }
}

/** A closed surface's separate pieces and the openings through them (the genus: a ring has one, a ladder its rungs less one). */
export function surfaceStats(indices: Uint32Array, nVerts: number): { pieces: number; openings: number } {
  const parent = new Int32Array(nVerts);
  for (let v = 0; v < nVerts; v++) parent[v] = v;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(indices[t]);
    for (let s = 1; s < 3; s++) {
      const b = find(indices[t + s]);
      if (a !== b) parent[b] = a;
    }
  }
  // Euler characteristic per piece: V − E + F, with each edge shared by two triangles
  const chi = new Map<number, number>();
  const used = new Uint8Array(nVerts);
  for (let t = 0; t < indices.length; t += 3) {
    const r = find(indices[t]);
    chi.set(r, (chi.get(r) ?? 0) + 1 - 1.5);
    for (let s = 0; s < 3; s++) used[indices[t + s]] = 1;
  }
  for (let v = 0; v < nVerts; v++) if (used[v]) chi.set(find(v), (chi.get(find(v)) ?? 0) + 1);
  let openings = 0;
  for (const c of chi.values()) openings += Math.max(0, Math.round((2 - c) / 2));
  return { pieces: chi.size, openings };
}

// ---------- the outline of a shape cut from plate ----------

export interface Loop {
  /** the outside of a piece (anticlockwise) or a hole in it (clockwise), in the plane's own (u, v) */
  outer: boolean;
  points: [number, number][];
  /** mm², positive */
  area: number;
}

/**
 * Closed outlines where a value on a 2D grid of cells crosses iso (marching squares between cell centres, with a ring
 * of empty cells round the grid so every outline closes). Each is walked with the inside on its left, so outsides run
 * anticlockwise and holes clockwise; they are then thinned to within tol (Douglas-Peucker) and specks under minArea
 * dropped. value is indexed a + na·b.
 */
export function profileLoops(value: Float64Array, n: [number, number], origin: [number, number], h: [number, number], tol: number, minArea: number, iso = 0.5): Loop[] {
  const [na, nb] = n;
  const at = (a: number, b: number) => (a < 0 || b < 0 || a >= na || b >= nb ? 0 : value[a + na * b]);
  const W = na + 2;
  // crossing points by edge: horizontal edge from cell (a, b) to (a + 1, b) is 2·id, vertical (a, b)–(a, b + 1) 2·id + 1
  const eid = (a: number, b: number, vert: boolean) => 2 * (a + 1 + W * (b + 1)) + (vert ? 1 : 0);
  const pts = new Map<number, [number, number]>();
  const next = new Map<number, number>();
  const cross = (a0: number, b0: number, a1: number, b1: number): number => {
    const vert = a0 === a1;
    const id = eid(Math.min(a0, a1), Math.min(b0, b1), vert);
    if (!pts.has(id)) {
      const v0 = at(a0, b0),
        v1 = at(a1, b1);
      const t = Math.abs(v1 - v0) > 1e-12 ? Math.min(1, Math.max(0, (iso - v0) / (v1 - v0))) : 0.5;
      pts.set(id, [origin[0] + (a0 + 0.5 + t * (a1 - a0)) * h[0], origin[1] + (b0 + 0.5 + t * (b1 - b0)) * h[1]]);
    }
    return id;
  };
  for (let b = -1; b < nb; b++)
    for (let a = -1; a < na; a++) {
      // corners anticlockwise: (a, b), (a + 1, b), (a + 1, b + 1), (a, b + 1)
      const ca: [number, number][] = [
        [a, b],
        [a + 1, b],
        [a + 1, b + 1],
        [a, b + 1],
      ];
      const ins = ca.map(([i, j]) => at(i, j) > iso);
      const k = ins.filter(Boolean).length;
      if (k === 0 || k === 4) continue;
      // walking the square's edges anticlockwise, an edge from inside to outside is an exit and the reverse an entry;
      // each outline piece runs from an exit to an entry, keeping the inside on its left
      const exits: number[] = [],
        entries: number[] = [],
        order: ("x" | "n")[] = [];
      const ids: number[] = [];
      for (let q = 0; q < 4; q++) {
        const r = (q + 1) % 4;
        if (ins[q] === ins[r]) continue;
        const id = cross(ca[q][0], ca[q][1], ca[r][0], ca[r][1]);
        ids.push(id);
        order.push(ins[q] ? "x" : "n");
        (ins[q] ? exits : entries).push(id);
      }
      if (exits.length === 1) {
        next.set(exits[0], entries[0]);
        continue;
      }
      // a saddle: the middle decides whether the two inside corners join (each exit to the next entry round the
      // square) or stay apart (each exit to the entry before it)
      const mid = (at(a, b) + at(a + 1, b) + at(a + 1, b + 1) + at(a, b + 1)) / 4 > iso;
      for (let q = 0; q < 4; q++) {
        if (order[q] !== "x") continue;
        const to = mid ? ids[(q + 1) % 4] : ids[(q + 3) % 4];
        next.set(ids[q], to);
      }
    }
  const loops: Loop[] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: [number, number][] = [];
    let id: number | undefined = start;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      ring.push(pts.get(id)!);
      id = next.get(id);
    }
    if (ring.length < 3) continue;
    let A = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i],
        q = ring[(i + 1) % ring.length];
      A += p[0] * q[1] - q[0] * p[1];
    }
    A /= 2;
    if (Math.abs(A) < minArea) continue;
    loops.push({ outer: A > 0, points: thinLoop(ring, tol), area: Math.abs(A) });
  }
  // outsides first, biggest first
  return loops.sort((p, q) => (p.outer === q.outer ? q.area - p.area : p.outer ? -1 : 1));
}

/** A closed polyline thinned to within tol of the original (Douglas-Peucker on its two halves). */
function thinLoop(P: [number, number][], tol: number): [number, number][] {
  if (P.length <= 4) return P;
  // split at the point farthest from the first
  let far = 0,
    best = -1;
  for (let i = 1; i < P.length; i++) {
    const d = Math.hypot(P[i][0] - P[0][0], P[i][1] - P[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const keep = new Uint8Array(P.length);
  keep[0] = keep[far] = 1;
  const dp = (i0: number, i1: number) => {
    // indices i0 < i1 along the ring (i1 may be P.length, standing for 0)
    const a = P[i0],
      b = P[i1 % P.length];
    let worst = -1,
      wi = -1;
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    for (let i = i0 + 1; i < i1; i++) {
      const p = P[i];
      const d = L > 1e-12 ? Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / L : Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (worst > tol) {
      keep[wi] = 1;
      dp(i0, wi);
      dp(wi, i1);
    }
  };
  dp(0, far);
  dp(far, P.length);
  const out = P.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : P;
}
