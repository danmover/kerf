// Parts that touch, as contacts instead of glued. The voxel grid has one set of nodes, so two parts that meet share
// the nodes on their common faces; to let them press, part and slide, the row of cells on one side of the faces
// becomes a thin layer whose material can be switched, cell by cell:
//   stuck   the cell as it is (friction holds the faces together, or they are rough);
//   sliding stiff across the faces, but with almost no shear stiffness along them, carrying instead the friction
//           stress μ·p along the way it slides (none when frictionless);
//   apart   stiff only along the faces (the cell's own material), with almost nothing across or along them.
// The solve is repeated, switching each cell by what the last solve gave (tension across the faces parts them,
// faces that would overlap close, shear past μ·p slides, sliding that reverses sticks), until that settles: the
// usual active-set treatment of contact. The layer keeps its material along the faces, so a part bends with its full
// depth; the cost is that the layer is a whole cell deep, so it should be the thicker part's (picked here).

import type { TouchingSpec, TouchResult, V3 } from "../spec";

/** a layer cell's state */
export const STICK = 0;
export const SLIP = 1;
export const OPEN = 2;

/** shear stiffness left along sliding faces, as a share of the material's: small enough to slide freely */
export const SLIP_G = 1e-5;
/** stiffness left across faces that have come apart, as a share of the material's */
export const OPEN_E = 1e-6;
/** a cell that has flipped between touching and apart this many times stays as it is (it would only flicker) */
const MAX_FLIPS = 4;

/**
 * The directions a layer may face: every whole-number direction with parts from −2 to 2, one of each ± pair (49).
 * Flat faces along the grid get their axis exactly; slopes and bores the nearest of these (within about 10°).
 */
export const AXES: V3[] = (() => {
  const out: V3[] = [];
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
  for (let a = -2; a <= 2; a++)
    for (let b = -2; b <= 2; b++)
      for (let c = -2; c <= 2; c++) {
        if (!a && !b && !c) continue;
        if (gcd(gcd(a, b), c) !== 1) continue;
        // one of each ± pair: the first non-zero part positive
        const first = a || b || c;
        if (first < 0) continue;
        const l = Math.hypot(a, b, c);
        out.push([a / l, b / l, c / l]);
      }
  // the grid's own axes first, so their classes come first
  return out.sort((p, q) => Number(Math.max(...q.map(Math.abs)) > 0.999) - Number(Math.max(...p.map(Math.abs)) > 0.999));
})();

export interface TouchGrid {
  n: [number, number, number];
  h: V3;
  origin: V3;
  owner: Int16Array;
  active: Uint8Array;
}

export interface TouchPartInfo {
  name: string;
  /** a fastener, nut or insert: stays glued under touching: "all" (bolts are modelled bonded) */
  joining?: boolean;
}

export interface TouchPair {
  a: string;
  b: string;
  /** friction coefficient (0: slides freely) */
  mu: number;
  /** never slides */
  rough: boolean;
  /** false: may slide but never comes apart */
  lift: boolean;
  /** found by touching: "all" */
  auto: boolean;
  /** held stuck after it came apart completely (apart) or slid away (slides): nothing else holds it */
  held?: "apart" | "slides";
  /** most of the layer's cells are one cell deep (a thin wall): its stress there is rough */
  thin: boolean;
  /** the parts on the side opposite the layer (whose nodes the layer's far faces share) */
  other: number[];
  /** how many elements deep the layer's part is behind the faces (median, up to 12) */
  deep?: number;
}

export interface TouchLayer {
  pairs: TouchPair[];
  /** grid cell of each layer cell */
  cells: Int32Array;
  pair: Int16Array;
  /** 1: a cell that touches the other part only at an edge or a corner, round a patch's edge; it follows parent's state */
  ring: Uint8Array;
  parent: Int32Array;
  /** unit normal from the layer's part toward the other one, 3 per cell (one of AXES, signed) */
  normal: Float64Array;
  /** index into AXES */
  axis: Int16Array;
  /** area of the faces each cell has against the other part, mm² */
  area: Float64Array;
  /** the cell's depth across the faces, mm */
  depth: Float64Array;
  state: Uint8Array;
  /** friction stress a sliding cell carries along the faces, MPa, and the way it slides (3 per cell) */
  tau: Float64Array;
  dir: Float64Array;
  flips: Uint8Array;
  warnings: string[];
}

/**
 * Where the analysed parts touch and how: the pairs touching: names (and with "all" every other touching pair, but
 * fasteners and nuts), the row of cells that carries each contact, and which way each cell faces. Null when nothing
 * touches as a contact.
 */
export function touchLayer(g: TouchGrid, parts: TouchPartInfo[], spec: TouchingSpec): TouchLayer | null {
  const [nx, ny, nz] = g.n;
  const [hx, hy, hz] = g.h;
  const ne = nx * ny * nz;
  const np = parts.length;
  const warnings: string[] = [];
  const byName = new Map<string, number[]>();
  parts.forEach((p, i) => {
    const l = byName.get(p.name);
    if (l) l.push(i);
    else byName.set(p.name, [i]);
  });
  const key = (p: number, q: number) => (p < q ? p * np + q : q * np + p);
  /** pair of part indices → contact index, or −1 for a pair kept glued */
  const pairOf = new Map<number, number>();
  const pairs: TouchPair[] = [];
  /** per contact: the parts on its a side and on its b side */
  const sideA: Set<number>[] = [];
  const sideB: Set<number>[] = [];
  for (const t of spec.pairs) {
    const ia = byName.get(t.a) ?? [];
    const ib = byName.get(t.b) ?? [];
    if (!ia.length || !ib.length) {
      warnings.push(`touching: ${ia.length ? t.b : t.a} has no geometry in this analysis, so touch(${t.a}, ${t.b}) does nothing.`);
      continue;
    }
    let k = -1;
    if (t.mu !== "glued") {
      k = pairs.length;
      pairs.push({ a: t.a, b: t.b, mu: typeof t.mu === "number" ? t.mu : 0, rough: t.mu === "rough", lift: t.lift, auto: !!t.auto, thin: false, other: [] });
      sideA.push(new Set(ia));
      sideB.push(new Set(ib));
    }
    for (const p of ia) for (const q of ib) if (p !== q && !pairOf.has(key(p, q))) pairOf.set(key(p, q), k);
  }

  // every face between cells of two different parts, by contact
  const faces: number[][] = pairs.map(() => []);
  const nb = [1, nx, nx * ny];
  const lim = [nx, ny, nz];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const e = i + nx * (j + ny * k);
        if (!g.active[e]) continue;
        const p = g.owner[e];
        if (p < 0) continue;
        const ijk = [i, j, k];
        for (let d = 0; d < 3; d++) {
          if (ijk[d] + 1 >= lim[d]) continue;
          const f = e + nb[d];
          if (!g.active[f]) continue;
          const q = g.owner[f];
          if (q < 0 || q === p) continue;
          let c = pairOf.get(key(p, q));
          if (c === undefined) {
            // touching: "all" takes every other pair that touches, but leaves fasteners and nuts glued
            if (spec.all && !parts[p].joining && !parts[q].joining) {
              c = pairs.length;
              const [lo, hi] = p < q ? [p, q] : [q, p];
              pairs.push({ a: parts[lo].name, b: parts[hi].name, mu: spec.all.mu === "rough" ? 0 : spec.all.mu, rough: spec.all.mu === "rough", lift: spec.all.lift, auto: true, thin: false, other: [] });
              sideA.push(new Set([lo]));
              sideB.push(new Set([hi]));
              faces.push([]);
            } else c = -1;
            pairOf.set(key(p, q), c);
          }
          if (c >= 0) faces[c].push(e, f, d);
        }
      }

  // The side that carries each contact. Its cells that share a face with the other part carry the faces; its cells
  // that only share an edge or a corner with the other part (round the edge of a patch, where this part runs on past
  // the other) would tie the other part's edge to this one along the faces, so they join the layer as a ring that
  // follows the cell beside it: stuck, it is as it was; sliding, it bears only across the faces; apart, it is empty.
  // The side with the fewer of those is best (a block on a plate: the block), then one deeper than a cell (not a thin
  // wall), then the bigger part.
  const partCells = new Float64Array(np);
  for (let e = 0; e < ne; e++) if (g.active[e] && g.owner[e] >= 0) partCells[g.owner[e]]++;
  const layerOf = new Int32Array(ne).fill(-1);
  const cells: number[] = [];
  const pairIx: number[] = [];
  const ringOf: number[] = [];
  /** per layer cell: the signed face directions toward the other part, summed (x, y, z), and those faces' areas by axis */
  const raw: number[] = [];
  const faceA: number[] = [];
  const A = [hy * hz, hx * hz, hx * hy];
  const coords = (e: number): [number, number, number] => [e % nx, Math.floor(e / nx) % ny, Math.floor(e / (nx * ny))];
  /** the 26 cells round e (fewer at the grid's edge) */
  const around = (e: number, out: number[]) => {
    out.length = 0;
    const [i, j, k] = coords(e);
    for (let dk = -1; dk <= 1; dk++)
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj && !dk) continue;
          const ii = i + di,
            jj = j + dj,
            kk = k + dk;
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
          out.push(ii + nx * (jj + ny * kk));
        }
    return out;
  };
  const nbrs: number[] = [];
  pairs.forEach((pr, k) => {
    const list = faces[k];
    if (!list.length) {
      if (!pr.auto) warnings.push(`touching: ${pr.a} and ${pr.b} do not touch at this element size, so there is no contact between them to press, part or slide.`);
      return;
    }
    const parts2 = [sideA[k], sideB[k]];
    // per side: its cells that share faces with the other side (with those faces' directions)
    const side = [new Map<number, number[]>(), new Map<number, number[]>()];
    for (let q = 0; q < list.length; q += 3) {
      const e = list[q],
        f = list[q + 1],
        d = list[q + 2];
      const eA = parts2[0].has(g.owner[e]);
      // a cell's face toward the other side: +d for e (f lies beyond it), −d for f
      const add = (s: number, c: number, dir: number) => {
        const m = side[s].get(c);
        if (m) m.push(dir);
        else side[s].set(c, [dir]);
      };
      add(eA ? 0 : 1, e, d + 1);
      add(eA ? 1 : 0, f, -(d + 1));
    }
    // per side: its cells that touch the other side only at an edge or a corner
    const ring = [0, 1].map((s) => {
      const out = new Set<number>();
      for (const c of side[1 - s].keys())
        for (const n of around(c, nbrs)) if (g.active[n] && parts2[s].has(g.owner[n]) && !side[s].has(n)) out.add(n);
      return out;
    });
    const deep = side.map((m) => {
      let n = 0;
      for (const [c, dirs] of m) {
        const ijk = coords(c);
        // deeper than one cell: the cell behind it (away from the faces) is the same part
        const ok = dirs.every((sd) => {
          const d = Math.abs(sd) - 1;
          const back = ijk[d] - Math.sign(sd);
          if (back < 0 || back >= lim[d]) return false;
          const b = c - Math.sign(sd) * nb[d];
          return g.active[b] === 1 && g.owner[b] === g.owner[c];
        });
        if (ok) n++;
      }
      return m.size ? n / m.size : 0;
    });
    const size = (s: number) => {
      let n = 0;
      for (const c of side[s].keys()) n += partCells[g.owner[c]];
      return n / Math.max(1, side[s].size);
    };
    const ringShare = (s: number) => ring[s].size / Math.max(1, side[s].size);
    const thick = (s: number) => deep[s] >= 0.5;
    let s: number;
    if (thick(0) !== thick(1)) s = thick(0) ? 0 : 1;
    else if (Math.abs(ringShare(0) - ringShare(1)) > 0.02) s = ringShare(0) < ringShare(1) ? 0 : 1;
    else if (Math.abs(deep[0] - deep[1]) > 0.05) s = deep[0] > deep[1] ? 0 : 1;
    else s = size(0) >= size(1) ? 0 : 1;
    if (!thick(s)) pr.thin = true;
    pr.other = [...parts2[1 - s]];
    const push = (c: number, dirs: number[], isRing: boolean) => {
      layerOf[c] = cells.length;
      cells.push(c);
      pairIx.push(k);
      ringOf.push(isRing ? 1 : 0);
      const v = [0, 0, 0],
        a = [0, 0, 0];
      for (const sd of dirs) {
        const d = Math.abs(sd) - 1;
        v[d] += Math.sign(sd);
        a[d] += A[d];
      }
      raw.push(...v);
      faceA.push(...a);
    };
    for (const [c, dirs] of side[s]) if (layerOf[c] < 0) push(c, dirs, false);
    for (const c of ring[s]) if (layerOf[c] < 0) push(c, [], true);
  });
  if (!cells.length)
    return pairs.length || spec.pairs.length
      ? { pairs, cells: new Int32Array(0), pair: new Int16Array(0), ring: new Uint8Array(0), parent: new Int32Array(0), normal: new Float64Array(0), axis: new Int16Array(0), area: new Float64Array(0), depth: new Float64Array(0), state: new Uint8Array(0), tau: new Float64Array(0), dir: new Float64Array(0), flips: new Uint8Array(0), warnings }
      : null;

  // each ring cell follows the face-sharing cell of its contact beside it (one across a face if there is one)
  const parent = new Int32Array(cells.length).fill(-1);
  for (let c = 0; c < cells.length; c++) {
    if (!ringOf[c]) continue;
    let best = -1,
      bestD = 4;
    const [i, j, k] = coords(cells[c]);
    for (const n of around(cells[c], nbrs)) {
      const o = layerOf[n];
      if (o < 0 || ringOf[o] || pairIx[o] !== pairIx[c]) continue;
      const [a, b, d] = coords(n);
      const dist = Math.abs(a - i) + Math.abs(b - j) + Math.abs(d - k);
      if (dist < bestD) {
        bestD = dist;
        best = o;
      }
    }
    parent[c] = best;
  }
  // which way each cell faces: its faces toward the other part averaged over the contact's cells within two cells of
  // it, so a stepped slope or a bore faces the way the real surface does, and a flat face exactly along its axis
  const L = cells.length;
  const normal = new Float64Array(3 * L);
  const axis = new Int16Array(L);
  const area = new Float64Array(L);
  const depth = new Float64Array(L);
  const R = 2;
  for (let c = 0; c < L; c++) {
    const [i, j, k] = coords(cells[c]);
    let sx = 0,
      sy = 0,
      sz = 0;
    for (let dk = -R; dk <= R; dk++) {
      const kk = k + dk;
      if (kk < 0 || kk >= nz) continue;
      for (let dj = -R; dj <= R; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -R; di <= R; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          const o = layerOf[ii + nx * (jj + ny * kk)];
          if (o < 0 || pairIx[o] !== pairIx[c]) continue;
          sx += raw[3 * o];
          sy += raw[3 * o + 1];
          sz += raw[3 * o + 2];
        }
      }
    }
    let l = Math.hypot(sx, sy, sz);
    if (l < 1e-9 && ringOf[c]) continue;
    if (l < 1e-9) {
      // faces on opposite sides (a thin sheet between two parts): the axis with the most faces
      const a = [faceA[3 * c], faceA[3 * c + 1], faceA[3 * c + 2]];
      const d = a.indexOf(Math.max(...a));
      sx = d === 0 ? 1 : 0;
      sy = d === 1 ? 1 : 0;
      sz = d === 2 ? 1 : 0;
      l = 1;
    }
    const n: V3 = [sx / l, sy / l, sz / l];
    let best = 0,
      bd = -1;
    AXES.forEach((ax, q) => {
      const d = Math.abs(ax[0] * n[0] + ax[1] * n[1] + ax[2] * n[2]);
      if (d > bd) {
        bd = d;
        best = q;
      }
    });
    const ax = AXES[best];
    const sg = ax[0] * n[0] + ax[1] * n[1] + ax[2] * n[2] < 0 ? -1 : 1;
    axis[c] = best;
    normal[3 * c] = sg * ax[0];
    normal[3 * c + 1] = sg * ax[1];
    normal[3 * c + 2] = sg * ax[2];
    // the area of its faces seen square to the way it faces, and its depth across them
    area[c] = faceA[3 * c] * Math.abs(ax[0]) + faceA[3 * c + 1] * Math.abs(ax[1]) + faceA[3 * c + 2] * Math.abs(ax[2]);
    depth[c] = Math.abs(ax[0]) * hx + Math.abs(ax[1]) * hy + Math.abs(ax[2]) * hz;
  }
  // a ring cell with no faces near it to go by faces the way its cell does
  for (let c = 0; c < L; c++) {
    if (!ringOf[c] || normal[3 * c] || normal[3 * c + 1] || normal[3 * c + 2]) continue;
    const o = parent[c] >= 0 ? parent[c] : -1;
    axis[c] = o >= 0 ? axis[o] : 0;
    for (let d = 0; d < 3; d++) normal[3 * c + d] = o >= 0 ? normal[3 * o + d] : d === 0 ? 1 : 0;
    depth[c] = o >= 0 ? depth[o] : hx;
  }
  // how many elements deep the layer's part is behind its faces: the layer is one of them, and the part bends a little
  // more easily for it (about 90 % ÷ that many, from stacked plates sliding on each other)
  const MAX_DEEP = 12;
  pairs.forEach((pr, k) => {
    if (pr.thin) {
      warnings.push(`Where ${pr.a} touches ${pr.b}, both are only about one element thick, so the contact takes a whole element of one of them and its stress there is rough; use a smaller resolution: to trust it.`);
      return;
    }
    const counts: number[] = [];
    for (let c = 0; c < L; c++) {
      if (pairIx[c] !== k || ringOf[c]) continue;
      // back from the faces along the axis it faces most
      const n = [normal[3 * c], normal[3 * c + 1], normal[3 * c + 2]];
      const d = [0, 1, 2].reduce((b, q) => (Math.abs(n[q]) > Math.abs(n[b]) ? q : b), 0);
      const step = n[d] > 0 ? -1 : 1;
      const ijk = coords(cells[c]);
      const own = g.owner[cells[c]];
      let depthN = 1;
      for (let q = 1; q < MAX_DEEP; q++) {
        ijk[d] += step;
        if (ijk[d] < 0 || ijk[d] >= lim[d]) break;
        const e = ijk[0] + nx * (ijk[1] + ny * ijk[2]);
        if (!g.active[e] || g.owner[e] !== own) break;
        depthN++;
      }
      counts.push(depthN);
    }
    if (!counts.length) return;
    counts.sort((a, b) => a - b);
    const med = counts[Math.floor(counts.length / 2)];
    pr.deep = med;
    const name = g.owner[cells[pairIx.indexOf(k)]] >= 0 ? parts[g.owner[cells[pairIx.indexOf(k)]]].name : pr.a;
    if (med <= 6) warnings.push(`Where ${pr.a} touches ${pr.b}, the contact takes one of the ${med} elements across ${name} there, so ${name} bends up to about ${Math.round(90 / med)} % more easily next to it than it should; a finer resolution: lowers that.`);
  });
  return {
    pairs,
    cells: Int32Array.from(cells),
    pair: Int16Array.from(pairIx),
    ring: Uint8Array.from(ringOf),
    parent,
    normal,
    axis,
    area,
    depth,
    state: new Uint8Array(L),
    tau: new Float64Array(L),
    dir: new Float64Array(3 * L),
    flips: new Uint8Array(L),
    warnings,
  };
}

/** The friction stress a sliding cell carries, as a stress (Voigt xx, yy, zz, xy, yz, zx): τ·(n⊗s + s⊗n). */
export function frictionStress(T: TouchLayer, c: number, out: Float64Array): boolean {
  const t = T.tau[c];
  if (T.state[c] !== SLIP || !(t > 0)) return false;
  const n0 = T.normal[3 * c],
    n1 = T.normal[3 * c + 1],
    n2 = T.normal[3 * c + 2];
  const s0 = T.dir[3 * c],
    s1 = T.dir[3 * c + 1],
    s2 = T.dir[3 * c + 2];
  out[0] = 2 * t * n0 * s0;
  out[1] = 2 * t * n1 * s1;
  out[2] = 2 * t * n2 * s2;
  out[3] = t * (n0 * s1 + n1 * s0);
  out[4] = t * (n1 * s2 + n2 * s1);
  out[5] = t * (n2 * s0 + n0 * s2);
  return true;
}

/** What the faces carry at a cell, from its stress and strain at the centre (Voigt, engineering shear strain). */
export function faceState(T: TouchLayer, c: number, S: Float64Array, E: Float64Array) {
  const n0 = T.normal[3 * c],
    n1 = T.normal[3 * c + 1],
    n2 = T.normal[3 * c + 2];
  const o = 6 * c;
  // traction σ·n, and the normal and tangential parts of it
  const t0 = S[o] * n0 + S[o + 3] * n1 + S[o + 5] * n2;
  const t1 = S[o + 3] * n0 + S[o + 1] * n1 + S[o + 4] * n2;
  const t2 = S[o + 5] * n0 + S[o + 4] * n1 + S[o + 2] * n2;
  const sn = t0 * n0 + t1 * n1 + t2 * n2;
  const tau: V3 = [t0 - sn * n0, t1 - sn * n1, t2 - sn * n2];
  // strain ε·n: its normal part opens the faces, twice its tangential part is how far they slide over the depth
  const e0 = E[o] * n0 + (E[o + 3] / 2) * n1 + (E[o + 5] / 2) * n2;
  const e1 = (E[o + 3] / 2) * n0 + E[o + 1] * n1 + (E[o + 4] / 2) * n2;
  const e2 = (E[o + 5] / 2) * n0 + (E[o + 4] / 2) * n1 + E[o + 2] * n2;
  const en = e0 * n0 + e1 * n1 + e2 * n2;
  const slip: V3 = [2 * (e0 - en * n0), 2 * (e1 - en * n1), 2 * (e2 - en * n2)];
  return { sn, tau, en, slip };
}

/**
 * The next state of every layer cell from the last solve: S the stress (with the friction it carries) and E the
 * strain less any thermal expansion, at each cell's centre, 6 per cell. Returns how many cells changed state and how
 * far the friction stresses moved (as a share of the largest).
 */
export function touchStates(T: TouchLayer, S: Float64Array, E: Float64Array): { changed: number; moved: number } {
  const L = T.cells.length;
  const P = T.pairs.length;
  const sRef = new Float64Array(P);
  const gRef = new Float64Array(P);
  const fs = Array.from({ length: L }, (_, c) => faceState(T, c, S, E));
  for (let c = 0; c < L; c++) {
    if (T.ring[c]) continue;
    const k = T.pair[c];
    const f = fs[c];
    if (T.state[c] === OPEN) gRef[k] = Math.max(gRef[k], Math.abs(f.en));
    else sRef[k] = Math.max(sRef[k], Math.abs(f.sn), Math.hypot(...f.tau));
  }
  let changed = 0;
  let moved = 0,
    tauMax = 0;
  for (let c = 0; c < L; c++) {
    if (T.ring[c]) continue;
    const pr = T.pairs[T.pair[c]];
    const k = T.pair[c];
    const f = fs[c];
    if (pr.held) {
      if (T.state[c] !== STICK) {
        T.state[c] = STICK;
        T.tau[c] = 0;
        changed++;
      }
      continue;
    }
    const tolS = 1e-3 * sRef[k] + 1e-12;
    const closed = pr.rough || pr.mu > 0 ? STICK : SLIP;
    // faces part only under a pull worth the name (a hundredth of the most the contact carries): where two parts bend
    // alike the faces carry next to nothing either way, and flicking those cells open one round at a time changes
    // nothing but the count of rounds
    const tolOpen = 1e-2 * sRef[k] + 1e-12;
    if (T.state[c] === OPEN) {
      // faces that would overlap touch again
      if (f.en < -1e-3 * gRef[k] && T.flips[c] < MAX_FLIPS) {
        T.state[c] = closed;
        T.tau[c] = 0;
        T.flips[c]++;
        changed++;
      }
      continue;
    }
    // pulled across the faces: they part
    if (pr.lift && f.sn > tolOpen && T.flips[c] < MAX_FLIPS) {
      T.state[c] = OPEN;
      T.tau[c] = 0;
      T.flips[c]++;
      changed++;
      continue;
    }
    if (pr.rough) continue;
    const p = Math.max(0, -f.sn);
    const tmag = Math.hypot(...f.tau);
    if (T.state[c] === STICK) {
      // shear past what friction holds: it slides, carrying μ·p the way the shear pushes
      if (pr.mu === 0 || tmag > pr.mu * p + tolS) {
        T.state[c] = SLIP;
        T.tau[c] = pr.mu * p;
        if (tmag > 0) for (let d = 0; d < 3; d++) T.dir[3 * c + d] = f.tau[d] / tmag;
        changed++;
      }
      continue;
    }
    if (pr.mu === 0) continue;
    // sliding: the friction follows the pressure and the way it slides; sliding back against it sticks
    const sm = Math.hypot(...f.slip);
    const back = sm > 0 && f.slip[0] * T.dir[3 * c] + f.slip[1] * T.dir[3 * c + 1] + f.slip[2] * T.dir[3 * c + 2] < 0;
    if (back) {
      T.state[c] = STICK;
      T.tau[c] = 0;
      changed++;
      continue;
    }
    const t = pr.mu * p;
    const s: V3 = sm > 0 ? [f.slip[0] / sm, f.slip[1] / sm, f.slip[2] / sm] : [T.dir[3 * c], T.dir[3 * c + 1], T.dir[3 * c + 2]];
    const dv = Math.hypot(t * s[0] - T.tau[c] * T.dir[3 * c], t * s[1] - T.tau[c] * T.dir[3 * c + 1], t * s[2] - T.tau[c] * T.dir[3 * c + 2]);
    moved = Math.max(moved, dv);
    tauMax = Math.max(tauMax, t, T.tau[c]);
    T.tau[c] = t;
    for (let d = 0; d < 3; d++) T.dir[3 * c + d] = s[d];
  }
  // ring cells follow the cell beside them
  for (let c = 0; c < L; c++) if (T.ring[c]) T.state[c] = T.parent[c] >= 0 ? T.state[T.parent[c]] : STICK;
  return { changed, moved: tauMax > 0 ? moved / tauMax : 0 };
}

/**
 * Contacts that let a part go entirely (it comes off, or slides away with nothing to stop it): u is huge next to
 * where they are. Those pairs are held stuck from then on, and the result says so. Returns how many it held.
 */
export function holdLoose(T: TouchLayer, S: Float64Array, E: Float64Array, umax: number): number {
  const P = T.pairs.length;
  const gap = new Float64Array(P),
    slide = new Float64Array(P),
    openA = new Float64Array(P),
    allA = new Float64Array(P);
  for (let c = 0; c < T.cells.length; c++) {
    if (T.ring[c]) continue;
    const k = T.pair[c];
    const f = faceState(T, c, S, E);
    allA[k] += T.area[c];
    if (T.state[c] === OPEN) {
      gap[k] = Math.max(gap[k], Math.abs(f.en) * T.depth[c]);
      openA[k] += T.area[c];
    } else if (T.state[c] === SLIP) slide[k] = Math.max(slide[k], Math.hypot(...f.slip) * T.depth[c]);
  }
  let held = 0;
  T.pairs.forEach((pr, k) => {
    if (pr.held) return;
    const m = Math.max(gap[k], slide[k]);
    if (m < 0.05 * umax) return;
    pr.held = openA[k] > 0.5 * allA[k] || gap[k] >= slide[k] ? "apart" : "slides";
    held++;
  });
  return held;
}

/**
 * What each contact carries, from the final solve: S, E as for touchStates; F the force each layer cell takes from the
 * other part through the nodes they share (3 per cell, N), which adds up exactly to what crosses the faces; at: a
 * grid cell's centre.
 */
export function touchResults(T: TouchLayer, S: Float64Array, E: Float64Array, F: Float64Array, at: (cell: number) => V3, rounds: number, settled: boolean): TouchResult[] {
  return T.pairs.map((pr, k): TouchResult => {
    let area = 0,
      pressed = 0,
      open = 0,
      sliding = 0,
      force = 0,
      shear = 0,
      gap = 0,
      slip = 0,
      peak = 0,
      cells = 0;
    let peakAt: V3 = [0, 0, 0];
    const tang: V3 = [0, 0, 0];
    for (let c = 0; c < T.cells.length; c++) {
      if (T.pair[c] !== k) continue;
      cells++;
      // the force across the faces (pressing: against the way the cell faces) and along them
      const n0 = T.normal[3 * c],
        n1 = T.normal[3 * c + 1],
        n2 = T.normal[3 * c + 2];
      const fn = F[3 * c] * n0 + F[3 * c + 1] * n1 + F[3 * c + 2] * n2;
      // summed with its sign: a single cell's share also carries what the elements beside it pass along inside the
      // part, which only cancels out over the whole patch
      force -= fn;
      // along the faces: what stuck faces pass, and the friction sliding ones carry (the stiffness the layer keeps
      // along the faces passes a little more where they slide, which is the model's, not the contact's)
      if (T.state[c] === STICK) {
        tang[0] += F[3 * c] - fn * n0;
        tang[1] += F[3 * c + 1] - fn * n1;
        tang[2] += F[3 * c + 2] - fn * n2;
      } else if (T.state[c] === SLIP && !T.ring[c]) {
        const t = T.tau[c] * T.area[c];
        tang[0] += t * T.dir[3 * c];
        tang[1] += t * T.dir[3 * c + 1];
        tang[2] += t * T.dir[3 * c + 2];
      }
      if (T.ring[c]) continue;
      const a = T.area[c];
      const f = faceState(T, c, S, E);
      area += a;
      if (T.state[c] === OPEN) {
        open += a;
        gap = Math.max(gap, Math.max(0, f.en) * T.depth[c]);
        continue;
      }
      const p = -f.sn;
      if (p > 0) {
        pressed += a;
        if (p > peak) {
          peak = p;
          peakAt = at(T.cells[c]);
        }
      }
      if (T.state[c] === SLIP) {
        sliding += a;
        slip = Math.max(slip, Math.hypot(...f.slip) * T.depth[c]);
      }
    }
    shear = Math.hypot(...tang);
    force = Math.max(0, force);
    const share = (v: number) => (area > 0 ? v / area : 0);
    return {
      a: pr.a,
      b: pr.b,
      mu: pr.rough ? "rough" : pr.mu,
      lift: pr.lift,
      auto: pr.auto,
      area,
      pressed: share(pressed),
      open: share(open),
      sliding: share(sliding),
      force,
      shear,
      peak: { value: peak, at: peakAt },
      gap,
      slip,
      cells,
      rounds,
      settled,
      ...(pr.held ? { held: pr.held } : {}),
      ...(pr.thin ? { thin: true } : {}),
    };
  });
}
