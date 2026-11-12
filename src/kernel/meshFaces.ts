// Turns a repaired mesh's triangles into the faces of a solid: triangles that lie
// in one plane become one flat face with an outline and holes, corners are moved
// onto the planes they belong to so every face is exactly flat, corners that only
// run a straight edge are dropped, and rings of narrow faces round an axis are
// recognised as the holes and pins that parts get aligned to. Pure TypeScript.

import type { ImportCylinder } from "./imports";
import { EdgeTable, type MeshBody } from "./meshRepair";

type P3 = [number, number, number];

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: P3): P3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

export interface MeshFace {
  /** the triangles that make it up */
  tris: number[];
  /** outward unit normal and the plane's offset: n·p = d */
  n: P3;
  d: number;
  /** palette index of its colour, or -1 */
  color: number;
  /** corner loops in order: the outline first (counter-clockwise seen from outside), then the holes */
  loops: number[][];
  /** which shell of the body it belongs to (0 = the outside) */
  shell: number;
}

export interface FaceSet {
  /** corner positions after flattening */
  positions: Float64Array;
  faces: MeshFace[];
}

/**
 * Volume, area and centres of a closed faceted body from its triangles (the
 * solid is exactly these flat faces). Hollows face inwards, so they subtract.
 */
export function faceProps(P: ArrayLike<number>, T: ArrayLike<number>): { volume: number; area: number; center: P3; areaCenter: P3 } {
  // measured from the first corner, so far-off parts keep their precision
  const o: P3 = [P[0] ?? 0, P[1] ?? 0, P[2] ?? 0];
  let vol = 0,
    area = 0;
  const vc: P3 = [0, 0, 0];
  const ac: P3 = [0, 0, 0];
  for (let t = 0; t + 2 < T.length; t += 3) {
    const a: P3 = [P[T[t] * 3] - o[0], P[T[t] * 3 + 1] - o[1], P[T[t] * 3 + 2] - o[2]];
    const b: P3 = [P[T[t + 1] * 3] - o[0], P[T[t + 1] * 3 + 1] - o[1], P[T[t + 1] * 3 + 2] - o[2]];
    const c: P3 = [P[T[t + 2] * 3] - o[0], P[T[t + 2] * 3 + 1] - o[1], P[T[t + 2] * 3 + 2] - o[2]];
    const v = dot(a, cross(b, c)) / 6;
    const ar = len(cross(sub(b, a), sub(c, a))) / 2;
    vol += v;
    area += ar;
    for (let k = 0; k < 3; k++) {
      vc[k] += (v * (a[k] + b[k] + c[k])) / 4;
      ac[k] += (ar * (a[k] + b[k] + c[k])) / 3;
    }
  }
  const center: P3 = vol !== 0 ? [vc[0] / vol + o[0], vc[1] / vol + o[1], vc[2] / vol + o[2]] : [...o];
  const areaCenter: P3 = area > 0 ? [ac[0] / area + o[0], ac[1] / area + o[1], ac[2] / area + o[2]] : [...o];
  return { volume: vol, area, center, areaCenter };
}

/** Corner → triangles that use it, as offsets into one list. */
function cornerTriangles(nV: number, T: ArrayLike<number>) {
  const count = new Int32Array(nV + 1);
  for (let i = 0; i < T.length; i++) count[T[i] + 1]++;
  for (let v = 0; v < nV; v++) count[v + 1] += count[v];
  const list = new Int32Array(T.length);
  const fill = count.slice(0, nV);
  for (let i = 0; i < T.length; i++) list[fill[T[i]]++] = (i / 3) | 0;
  return { at: count, list };
}

/**
 * Faces for one body. `tol` is how far a corner may sit from a plane and still
 * count as on it (mm); corners are then moved onto their planes exactly.
 */
export function meshFaces(body: MeshBody, tol: number): FaceSet {
  const P = Float64Array.from(body.positions);
  const T = body.triangles;
  const nT = T.length / 3;
  const nV = P.length / 3;
  const pt = (i: number): P3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const colorOf = (t: number) => (body.triColor ? body.triColor[t] : -1);
  const shellOf = (t: number) => {
    let s = 0;
    while (s + 1 < body.shellStarts.length && body.shellStarts[s + 1] <= t) s++;
    return s;
  };

  const normal = new Float64Array(nT * 3);
  const area = new Float64Array(nT);
  const triNormal = (t: number): P3 => {
    const a = pt(T[t * 3]),
      b = pt(T[t * 3 + 1]),
      c = pt(T[t * 3 + 2]);
    return cross(sub(b, a), sub(c, a));
  };
  for (let t = 0; t < nT; t++) {
    const n = triNormal(t);
    const l = len(n);
    area[t] = l / 2;
    const u = l > 0 ? scale(n, 1 / l) : [0, 0, 0];
    normal[t * 3] = u[0];
    normal[t * 3 + 1] = u[1];
    normal[t * 3 + 2] = u[2];
  }
  const nrm = (t: number): P3 => [normal[t * 3], normal[t * 3 + 1], normal[t * 3 + 2]];

  const edges = new EdgeTable(Math.ceil(nT * 1.6) + 16);
  for (let t = 0; t < nT; t++) {
    edges.add(T[t * 3], T[t * 3 + 1], t);
    edges.add(T[t * 3 + 1], T[t * 3 + 2], t);
    edges.add(T[t * 3 + 2], T[t * 3], t);
  }
  const across = (t: number, a: number, b: number) => {
    const u = edges.users(a, b);
    return u.length === 2 ? (u[0] === t ? u[1] : u[0]) : -1;
  };

  // ---- grow flat regions from the biggest triangles, whose normals are the most exact
  const region = new Int32Array(nT).fill(-1);
  const regions: { tris: number[]; n: P3; d: number; color: number }[] = [];
  const seeds = Array.from({ length: nT }, (_, i) => i).sort((a, b) => area[b] - area[a]);
  for (const s of seeds) {
    if (region[s] >= 0) continue;
    const id = regions.length;
    const n0 = nrm(s);
    const d0 = dot(n0, pt(T[s * 3]));
    const col = colorOf(s);
    const tris = [s];
    region[s] = id;
    if (area[s] > 0) {
      for (let qi = 0; qi < tris.length; qi++) {
        const t = tris[qi];
        for (let i = 0; i < 3; i++) {
          const nb = across(t, T[t * 3 + i], T[t * 3 + ((i + 1) % 3)]);
          if (nb < 0 || region[nb] >= 0 || colorOf(nb) !== col) continue;
          // facing the same way (a triangle with no area takes the plane it lies in)
          if (area[nb] > 0 && dot(nrm(nb), n0) < 0.9995) continue;
          let flat = true;
          for (let k = 0; k < 3 && flat; k++) flat = Math.abs(dot(n0, pt(T[nb * 3 + k])) - d0) <= tol;
          if (!flat) continue;
          region[nb] = id;
          tris.push(nb);
        }
      }
    }
    regions.push({ tris, n: n0, d: d0, color: col });
  }
  // a region's plane from all its triangles
  for (const r of regions) {
    if (r.tris.length === 1) {
      const t = r.tris[0];
      r.n = nrm(r.tris[0]);
      r.d = dot(r.n, pt(T[t * 3]));
      continue;
    }
    let n: P3 = [0, 0, 0];
    for (const t of r.tris) n = [n[0] + normal[t * 3] * area[t], n[1] + normal[t * 3 + 1] * area[t], n[2] + normal[t * 3 + 2] * area[t]];
    n = unit(n);
    let d = 0,
      w = 0;
    for (const t of r.tris) {
      const c = scale([P[T[t * 3] * 3] + P[T[t * 3 + 1] * 3] + P[T[t * 3 + 2] * 3], P[T[t * 3] * 3 + 1] + P[T[t * 3 + 1] * 3 + 1] + P[T[t * 3 + 2] * 3 + 1], P[T[t * 3] * 3 + 2] + P[T[t * 3 + 1] * 3 + 2] + P[T[t * 3 + 2] * 3 + 2]], 1 / 3);
      d += dot(n, c) * area[t];
      w += area[t];
    }
    r.n = n;
    r.d = w > 0 ? d / w : dot(n, pt(T[r.tris[0] * 3]));
  }

  // ---- move corners onto the planes of the multi-triangle regions they belong to
  const around = cornerTriangles(nV, T);
  const planesAt = (v: number) => {
    const out: number[] = [];
    for (let k = around.at[v]; k < around.at[v + 1]; k++) {
      const r = region[around.list[k]];
      if (regions[r].tris.length > 1 && !out.includes(r)) out.push(r);
    }
    return out;
  };
  for (let v = 0; v < nV; v++) {
    const rs = planesAt(v);
    if (!rs.length) continue;
    const x0 = pt(v);
    // least squares over the planes, held lightly to where the corner was
    const lam = 1e-9;
    const A = [lam, 0, 0, 0, lam, 0, 0, 0, lam];
    const b: P3 = [lam * x0[0], lam * x0[1], lam * x0[2]];
    for (const r of rs) {
      const { n, d } = regions[r];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) A[i * 3 + j] += n[i] * n[j];
        b[i] += n[i] * d;
      }
    }
    const x = solve3(A, b);
    if (!x || len(sub(x, x0)) > 4 * tol) continue;
    // no triangle round the corner may fold over or vanish
    let ok = true;
    const before: P3[] = [];
    for (let k = around.at[v]; k < around.at[v + 1]; k++) before.push(triNormal(around.list[k]));
    P[v * 3] = x[0];
    P[v * 3 + 1] = x[1];
    P[v * 3 + 2] = x[2];
    for (let k = around.at[v], i = 0; k < around.at[v + 1] && ok; k++, i++) {
      const after = triNormal(around.list[k]);
      ok = len(before[i]) === 0 || (dot(after, before[i]) > 0 && len(after) > 0);
    }
    if (!ok) {
      P[v * 3] = x0[0];
      P[v * 3 + 1] = x0[1];
      P[v * 3 + 2] = x0[2];
    }
  }

  // ---- a region that is still not flat, or whose outline cannot be traced, falls back to its triangles
  const flatTol = Math.max(1e-9, tol * 1e-4);
  const faces: MeshFace[] = [];
  const single = (t: number) => {
    const n = unit(triNormal(t));
    faces.push({ tris: [t], n, d: dot(n, pt(T[t * 3])), color: colorOf(t), loops: [[T[t * 3], T[t * 3 + 1], T[t * 3 + 2]]], shell: shellOf(t) });
  };
  for (const [id, r] of regions.entries()) {
    if (r.tris.length === 1) {
      if (area[r.tris[0]] > 0) single(r.tris[0]);
      continue;
    }
    let flat = true;
    for (const t of r.tris) for (let k = 0; k < 3 && flat; k++) flat = Math.abs(dot(r.n, pt(T[t * 3 + k])) - r.d) <= flatTol;
    const loops = flat ? traceLoops(r.tris, id, region, T, across, r.n, pt) : null;
    if (!loops) {
      for (const t of r.tris) if (area[t] > 0) single(t);
      continue;
    }
    faces.push({ tris: r.tris, n: r.n, d: r.d, color: r.color, loops, shell: shellOf(r.tris[0]) });
  }

  // ---- corners that only run a straight edge between two faces are not needed by either
  const faceOf = new Int32Array(nT).fill(-1);
  faces.forEach((f, i) => {
    for (const t of f.tris) faceOf[t] = i;
  });
  const removable = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) {
    let a = -1,
      b = -1,
      more = false;
    for (let k = around.at[v]; k < around.at[v + 1] && !more; k++) {
      const f = faceOf[around.list[k]];
      if (f === a || f === b) continue;
      if (a < 0) a = f;
      else if (b < 0) b = f;
      else more = true;
    }
    removable[v] = !more && b >= 0 ? 1 : 0;
  }
  for (const f of faces) {
    if (f.tris.length === 1) continue;
    f.loops = f.loops.map((loop) => {
      const keep = loop.filter((v, i) => {
        if (!removable[v]) return true;
        const u = pt(loop[(i + loop.length - 1) % loop.length]);
        const w = pt(loop[(i + 1) % loop.length]);
        const span = len(sub(w, u));
        return span <= 0 || len(cross(sub(pt(v), u), sub(w, u))) / span > flatTol;
      });
      return keep.length >= 3 ? keep : loop;
    });
  }
  // both faces at such a corner see the same two neighbours of it, so they drop it alike and their shared edges still match
  return { positions: P, faces };
}

/**
 * The outline and holes of a flat region, traced along the edges its triangles
 * do not share with each other. Null when a corner is met twice (the region
 * touches itself) or the loops do not make one outline with holes.
 */
function traceLoops(tris: number[], id: number, region: Int32Array, T: ArrayLike<number>, across: (t: number, a: number, b: number) => number, n: P3, pt: (i: number) => P3): number[][] | null {
  const next = new Map<number, number>();
  for (const t of tris)
    for (let i = 0; i < 3; i++) {
      const a = T[t * 3 + i],
        b = T[t * 3 + ((i + 1) % 3)];
      const o = across(t, a, b);
      if (o >= 0 && region[o] === id) continue;
      if (next.has(a)) return null;
      next.set(a, b);
    }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    for (let guard = 0; guard <= next.size; guard++) {
      if (seen.has(v)) break;
      seen.add(v);
      loop.push(v);
      const w = next.get(v);
      if (w === undefined) return null;
      v = w;
    }
    if (v !== start || loop.length < 3) return null;
    loops.push(loop);
  }
  // the outline winds counter-clockwise about the normal; holes wind the other way
  const areaAbout = (loop: number[]) => {
    const o = pt(loop[0]);
    let s = 0;
    for (let i = 1; i + 1 < loop.length; i++) s += dot(cross(sub(pt(loop[i]), o), sub(pt(loop[i + 1]), o)), n);
    return s / 2;
  };
  const areas = loops.map(areaAbout);
  const outer = areas.filter((a) => a > 0);
  if (outer.length !== 1) return null;
  const k = areas.findIndex((a) => a > 0);
  return [loops[k], ...loops.filter((_, i) => i !== k)];
}

function solve3(A: number[], b: P3): P3 | null {
  const [a, b1, c, d, e, f, g, h, i] = A;
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-30) return null;
  const inv = [(e * i - f * h) / det, (c * h - b1 * i) / det, (b1 * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b1 * g - a * h) / det, (a * e - b1 * d) / det];
  return [inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2], inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2], inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2]];
}

/**
 * Holes and pins: rings of narrow flat faces whose shared edges all run along
 * one axis, with corners on one circle about it. A CAD program's STL of a
 * drilled hole is exactly that. Returned like the cylinders read from STEP files.
 */
export function meshCylinders(set: FaceSet, body: number, limit = 1500): ImportCylinder[] {
  const P = set.positions;
  const pt = (i: number): P3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const faces = set.faces;
  // faces meeting along each edge of their outlines
  const owner = new Map<string, number[]>();
  faces.forEach((f, i) => {
    for (const loop of f.loops)
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k],
          b = loop[(k + 1) % loop.length];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const l = owner.get(key);
        if (l) l.push(i);
        else owner.set(key, [i]);
      }
  });
  const parent = faces.map((_, i) => i);
  const axis: (P3 | null)[] = faces.map(() => null);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const canon = (d: P3): P3 => (d[2] < -1e-9 || (Math.abs(d[2]) <= 1e-9 && (d[1] < -1e-9 || (Math.abs(d[1]) <= 1e-9 && d[0] < 0))) ? [-d[0], -d[1], -d[2]] : d);
  const maxBend = Math.cos((50 * Math.PI) / 180);
  for (const [key, l] of owner) {
    if (l.length !== 2) continue;
    const [i, j] = l;
    const A = faces[i],
      B = faces[j];
    const c = dot(A.n, B.n);
    if (c < maxBend || c > 0.99999) continue;
    const [a, b] = key.split(",").map(Number);
    const e = unit(sub(pt(b), pt(a)));
    if (Math.abs(dot(e, A.n)) > 0.02 || Math.abs(dot(e, B.n)) > 0.02) continue;
    const ax = canon(unit(cross(A.n, B.n)));
    const ri = root(i),
      rj = root(j);
    if (ri === rj) continue;
    const ai = axis[ri],
      aj = axis[rj];
    if ((ai && Math.abs(dot(ai, ax)) < 0.999) || (aj && Math.abs(dot(aj, ax)) < 0.999)) continue;
    parent[rj] = ri;
    axis[ri] = ai ?? aj ?? ax;
  }
  const groups = new Map<number, number[]>();
  faces.forEach((_, i) => {
    const r = root(i);
    if (r === i && !axis[r]) return;
    const l = groups.get(r);
    if (l) l.push(i);
    else groups.set(r, [i]);
  });
  const out: ImportCylinder[] = [];
  for (const [r, list] of groups) {
    if (out.length >= limit) break;
    if (list.length < 3 || !axis[r]) continue;
    const d = axis[r]!;
    const e1 = unit(Math.abs(d[0]) < 0.9 ? cross(d, [1, 0, 0]) : cross(d, [0, 1, 0]));
    const e2 = cross(d, e1);
    const corners = new Set<number>();
    for (const f of list) for (const loop of faces[f].loops) for (const v of loop) corners.add(v);
    const pts = [...corners].map(pt);
    const uv = pts.map((p) => [dot(p, e1), dot(p, e2)] as [number, number]);
    const fit = circleFit(uv);
    if (!fit) continue;
    const { cx, cy, r: rad } = fit;
    let worst = 0;
    for (const [u, v] of uv) worst = Math.max(worst, Math.abs(Math.hypot(u - cx, v - cy) - rad));
    if (!(rad > 0) || worst > Math.max(0.02 * rad, 0.005)) continue;
    // how much of a turn the faces cover
    const arcs: [number, number][] = [];
    let holeVotes = 0;
    for (const f of list) {
      const loopPts = faces[f].loops[0].map(pt);
      const ang = loopPts.map((p) => Math.atan2(dot(p, e2) - cy, dot(p, e1) - cx));
      const mid = Math.atan2(ang.reduce((s, a) => s + Math.sin(a), 0), ang.reduce((s, a) => s + Math.cos(a), 0));
      let lo = 0,
        hi = 0;
      for (const a of ang) {
        let x = a - mid;
        while (x > Math.PI) x -= 2 * Math.PI;
        while (x < -Math.PI) x += 2 * Math.PI;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      arcs.push([mid + lo, mid + hi]);
      // a hole's faces look at its axis
      const radial: P3 = sub(scale(e1, Math.cos(mid)), scale(e2, -Math.sin(mid)));
      if (dot(faces[f].n, radial) < 0) holeVotes++;
    }
    const sweep = arcCover(arcs) / (2 * Math.PI);
    let lo = Infinity,
      hi = -Infinity;
    for (const p of pts) {
      const a = dot(p, d);
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
    const base: P3 = [e1[0] * cx + e2[0] * cy, e1[1] * cx + e2[1] * cy, e1[2] * cx + e2[2] * cy];
    out.push({
      body,
      d: rad * 2,
      hole: holeVotes * 2 > list.length,
      start: [base[0] + d[0] * lo, base[1] + d[1] * lo, base[2] + d[2] * lo],
      end: [base[0] + d[0] * hi, base[1] + d[1] * hi, base[2] + d[2] * hi],
      sweep: Math.min(1, sweep),
    });
  }
  return out;
}

/** Least-squares circle through 2D points (Kåsa's fit). */
function circleFit(pts: [number, number][]): { cx: number; cy: number; r: number } | null {
  if (pts.length < 3) return null;
  // centre the points first so the sums stay well conditioned
  let mx = 0,
    my = 0;
  for (const [x, y] of pts) {
    mx += x / pts.length;
    my += y / pts.length;
  }
  let suu = 0,
    suv = 0,
    svv = 0,
    suuu = 0,
    svvv = 0,
    suvv = 0,
    svuu = 0;
  for (const [x, y] of pts) {
    const u = x - mx,
      v = y - my;
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-18) return null;
  const a = (suuu + suvv) / 2,
    b = (svvv + svuu) / 2;
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length);
  return { cx: uc + mx, cy: vc + my, r };
}

/** Total angle covered by arcs given as [from, to] radians (from ≤ to, each shorter than a turn). */
function arcCover(arcs: [number, number][]): number {
  const TAU = 2 * Math.PI;
  const segs: [number, number][] = [];
  for (const [a, b] of arcs) {
    let s = a % TAU;
    if (s < 0) s += TAU;
    const e = s + (b - a);
    if (e > TAU) {
      segs.push([s, TAU], [0, e - TAU]);
    } else segs.push([s, e]);
  }
  segs.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = -1,
    ce = -1;
  for (const [s, e] of segs) {
    if (s > ce + 1e-9) {
      if (ce > cs) total += ce - cs;
      cs = s;
      ce = e;
    } else ce = Math.max(ce, e);
  }
  if (ce > cs) total += ce - cs;
  // facets between corners leave tiny gaps at the corners themselves: a ring that nearly closes is whole
  return total > TAU * 0.98 ? TAU : total;
}
