// Surfaces for shell elements: a part's display mesh welded into one surface, the side of a thin wall to model
// (one face of a sheet, or the whole outer skin of a laminate), and an even triangle mesh laid over it.
//
// The display mesh comes from the CAD kernel's tessellation: long slivers across flat faces and narrow strips
// round bends, fine for drawing and poor for elements. remesh() rebuilds it at a chosen size (smaller round
// tight curves and small holes, growing gently away from them) by repeated splits, collapses, flips and
// relaxation (Botsch and Kobbelt's isotropic remeshing), keeping every crease and outline where it was: an
// edge between two of the surface's smooth patches is never smoothed over, and its ends stay put.

export type V3 = [number, number, number];

export interface SurfaceMesh {
  /** xyz per vertex */
  P: Float64Array;
  /** three vertices per triangle, counter-clockwise seen from outside the material */
  T: Int32Array;
  /** smooth patch of each triangle: creases and outlines run between patches */
  patch: Int32Array;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const pt = (P: ArrayLike<number>, i: number): V3 => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
const DEG = Math.PI / 180;

/** Merges vertices closer than tol (the kernel repeats them along every face boundary) and drops degenerate triangles. */
export function weld(positions: ArrayLike<number>, indices: ArrayLike<number>, tol: number): SurfaceMesh {
  const nv = positions.length / 3;
  const map = new Int32Array(nv);
  const cells = new Map<string, number[]>();
  const out: number[] = [];
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let v = 0; v < nv; v++) {
    const x = positions[3 * v],
      y = positions[3 * v + 1],
      z = positions[3 * v + 2];
    const cx = Math.floor(x / tol),
      cy = Math.floor(y / tol),
      cz = Math.floor(z / tol);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = cells.get(key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const w of list)
            if (Math.abs(out[3 * w] - x) <= tol && Math.abs(out[3 * w + 1] - y) <= tol && Math.abs(out[3 * w + 2] - z) <= tol) {
              found = w;
              break;
            }
        }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const k = key(cx, cy, cz);
      const list = cells.get(k);
      if (list) list.push(found);
      else cells.set(k, [found]);
    }
    map[v] = found;
  }
  const T: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = map[indices[t]],
      b = map[indices[t + 1]],
      c = map[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    const pa = pt(out, a),
      pb = pt(out, b),
      pc = pt(out, c);
    if (len(cross(sub(pb, pa), sub(pc, pa))) < 1e-14 * (1 + dot(pa, pa))) continue;
    T.push(a, b, c);
  }
  return { P: Float64Array.from(out), T: Int32Array.from(T), patch: new Int32Array(T.length / 3) };
}

// ---------- a bounding volume tree over triangles, for rays and nearest points ----------

interface BNode {
  lo: V3;
  hi: V3;
  /** children, or -1 for a leaf */
  l: number;
  r: number;
  first: number;
  count: number;
}

export interface NearHit {
  tri: number;
  q: V3;
  d2: number;
  /** barycentric weights of the triangle's corners at q */
  w: V3;
}

/** closest point on triangle abc to p (Ericson), with its barycentric weights */
function closestOnTri(p: V3, a: V3, b: V3, c: V3): { q: V3; w: V3 } {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { q: a, w: [1, 0, 0] };
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { q: b, w: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { q: add(a, scale(ab, v)), w: [1 - v, v, 0] };
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { q: c, w: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { q: add(a, scale(ac, w)), w: [1 - w, 0, w] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { q: add(b, scale(sub(c, b), w)), w: [0, 1 - w, w] };
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den,
    w = vc * den;
  return { q: add(a, add(scale(ab, v), scale(ac, w))), w: [1 - v - w, v, w] };
}

export class TriBVH {
  private nodes: BNode[] = [];
  private order: Int32Array;
  constructor(
    readonly P: ArrayLike<number>,
    readonly T: ArrayLike<number>,
    tris?: ArrayLike<number>,
  ) {
    const list = tris ? Int32Array.from(tris) : Int32Array.from({ length: T.length / 3 }, (_, i) => i);
    this.order = list;
    const cen = new Float64Array(3 * list.length);
    for (let k = 0; k < list.length; k++) {
      const t = list[k];
      for (let c = 0; c < 3; c++) cen[3 * k + c] = (P[3 * T[3 * t] + c] + P[3 * T[3 * t + 1] + c] + P[3 * T[3 * t + 2] + c]) / 3;
    }
    const idx = Int32Array.from({ length: list.length }, (_, i) => i);
    const build = (first: number, count: number): number => {
      const lo: V3 = [Infinity, Infinity, Infinity],
        hi: V3 = [-Infinity, -Infinity, -Infinity];
      const clo: V3 = [Infinity, Infinity, Infinity],
        chi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let k = first; k < first + count; k++) {
        const t = list[idx[k]];
        for (let j = 0; j < 3; j++) {
          const v = T[3 * t + j];
          for (let c = 0; c < 3; c++) {
            lo[c] = Math.min(lo[c], P[3 * v + c]);
            hi[c] = Math.max(hi[c], P[3 * v + c]);
          }
        }
        for (let c = 0; c < 3; c++) {
          clo[c] = Math.min(clo[c], cen[3 * idx[k] + c]);
          chi[c] = Math.max(chi[c], cen[3 * idx[k] + c]);
        }
      }
      const id = this.nodes.length;
      this.nodes.push({ lo, hi, l: -1, r: -1, first, count });
      if (count <= 6) return id;
      const ext = sub(chi, clo);
      const ax = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
      if (!(ext[ax] > 0)) return id;
      const sl = Array.from(idx.subarray(first, first + count)).sort((a, b) => cen[3 * a + ax] - cen[3 * b + ax]);
      idx.set(sl, first);
      const half = count >> 1;
      const l = build(first, half),
        r = build(first + half, count - half);
      this.nodes[id].l = l;
      this.nodes[id].r = r;
      return id;
    };
    if (list.length) build(0, list.length);
    this.order = Int32Array.from(idx, (i) => list[i]);
  }

  private corner(t: number, j: number): V3 {
    return pt(this.P, this.T[3 * t + j]);
  }

  /** first hit of the ray o + s·d (d unit) for 0 < s < smax, leaving out the triangles skip() names */
  ray(o: V3, d: V3, smax: number, skip?: (tri: number) => boolean): { s: number; tri: number } | null {
    if (!this.nodes.length) return null;
    let best: { s: number; tri: number } | null = null;
    let bound = smax;
    const inv: V3 = [1 / d[0], 1 / d[1], 1 / d[2]];
    const stack = [0];
    while (stack.length) {
      const nd = this.nodes[stack.pop()!];
      let t0 = 0,
        t1 = bound;
      for (let c = 0; c < 3; c++) {
        let a = (nd.lo[c] - o[c]) * inv[c],
          b = (nd.hi[c] - o[c]) * inv[c];
        if (a > b) {
          const x = a;
          a = b;
          b = x;
        }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) break;
      }
      if (t0 > t1) continue;
      if (nd.l < 0) {
        for (let k = nd.first; k < nd.first + nd.count; k++) {
          const t = this.order[k];
          if (skip && skip(t)) continue;
          // Möller–Trumbore
          const a = this.corner(t, 0),
            b = this.corner(t, 1),
            c = this.corner(t, 2);
          const e1 = sub(b, a),
            e2 = sub(c, a);
          const pv = cross(d, e2);
          const det = dot(e1, pv);
          if (Math.abs(det) < 1e-18) continue;
          const id = 1 / det;
          const tv = sub(o, a);
          const u = dot(tv, pv) * id;
          if (u < -1e-9 || u > 1 + 1e-9) continue;
          const qv = cross(tv, e1);
          const v = dot(d, qv) * id;
          if (v < -1e-9 || u + v > 1 + 1e-9) continue;
          const s = dot(e2, qv) * id;
          if (s > 1e-9 && s < bound) {
            bound = s;
            best = { s, tri: t };
          }
        }
      } else stack.push(nd.l, nd.r);
    }
    return best;
  }

  /** the nearest point to p on the triangles accept() allows */
  nearest(p: V3, accept?: (tri: number) => boolean, maxD = Infinity): NearHit | null {
    if (!this.nodes.length) return null;
    let best: NearHit | null = null;
    let bound = maxD * maxD;
    const boxD2 = (nd: BNode) => {
      let s = 0;
      for (let c = 0; c < 3; c++) {
        const v = p[c] < nd.lo[c] ? nd.lo[c] - p[c] : p[c] > nd.hi[c] ? p[c] - nd.hi[c] : 0;
        s += v * v;
      }
      return s;
    };
    const stack = [0];
    while (stack.length) {
      const nd = this.nodes[stack.pop()!];
      if (boxD2(nd) > bound) continue;
      if (nd.l < 0) {
        for (let k = nd.first; k < nd.first + nd.count; k++) {
          const t = this.order[k];
          if (accept && !accept(t)) continue;
          const { q, w } = closestOnTri(p, this.corner(t, 0), this.corner(t, 1), this.corner(t, 2));
          const dd = sub(p, q);
          const d2 = dot(dd, dd);
          if (d2 < bound) {
            bound = d2;
            best = { tri: t, q, d2, w };
          }
        }
      } else {
        const a = this.nodes[nd.l],
          b = this.nodes[nd.r];
        // nearer box last, so it is searched first
        if (boxD2(a) < boxD2(b)) stack.push(nd.r, nd.l);
        else stack.push(nd.l, nd.r);
      }
    }
    return best;
  }
}

// ---------- edges, patches and creases ----------

const ekey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

/** edge → triangles that share it */
function edgeMap(T: ArrayLike<number>, nv: number, alive?: ArrayLike<number>): Map<number, number[]> {
  const m = new Map<number, number[]>();
  const nt = T.length / 3;
  for (let t = 0; t < nt; t++) {
    if (alive && !alive[t]) continue;
    for (let j = 0; j < 3; j++) {
      const k = ekey(T[3 * t + j], T[3 * t + ((j + 1) % 3)], nv);
      const l = m.get(k);
      if (l) l.push(t);
      else m.set(k, [t]);
    }
  }
  return m;
}

function triNormal(P: ArrayLike<number>, T: ArrayLike<number>, t: number): V3 {
  const a = pt(P, T[3 * t]),
    b = pt(P, T[3 * t + 1]),
    c = pt(P, T[3 * t + 2]);
  return cross(sub(b, a), sub(c, a));
}

/**
 * Splits the surface into smooth patches: triangles joined across edges whose faces turn less than angle (degrees).
 * Edges shared by more or fewer than two triangles are outlines. Returns the patch count.
 */
export function findPatches(m: SurfaceMesh, angle = 30): number {
  const nv = m.P.length / 3,
    nt = m.T.length / 3;
  const E = edgeMap(m.T, nv);
  const nrm = Array.from({ length: nt }, (_, t) => norm(triNormal(m.P, m.T, t)));
  const cosA = Math.cos(angle * DEG);
  const patch = m.patch.fill(-1);
  let np = 0;
  for (let s = 0; s < nt; s++) {
    if (patch[s] >= 0) continue;
    patch[s] = np;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const t = q[h];
      for (let j = 0; j < 3; j++) {
        const l = E.get(ekey(m.T[3 * t + j], m.T[3 * t + ((j + 1) % 3)], nv))!;
        if (l.length !== 2) continue;
        const o = l[0] === t ? l[1] : l[0];
        if (patch[o] >= 0 || dot(nrm[t], nrm[o]) < cosA) continue;
        patch[o] = np;
        q.push(o);
      }
    }
    np++;
  }
  return np;
}

// ---------- which side of a thin wall to model ----------

export interface WallSide {
  /** the source triangles kept as the shell's surface */
  tris: number[];
  /** wall thickness behind each kept triangle, mm */
  t: number[];
  /** area of the side kept and of everything */
  area: number;
  total: number;
}

/**
 * Finds a thin wall's two faces and keeps one: each patch whose inward rays meet a facing patch close behind is
 * a wall face; the wall faces fall into two sides (outlines, bores and edges between them are left out), and
 * the larger side is kept, with the wall's thickness behind each triangle. Returns a reason instead when the
 * part is not one simple wall (ribs, bosses, solid lumps, or nothing thin).
 */
export function wallSide(m: SurfaceMesh, bvh: TriBVH, size: number, tHint?: number): WallSide | { why: string } {
  const nv = m.P.length / 3,
    nt = m.T.length / 3;
  let np = 0;
  for (let t = 0; t < nt; t++) np = Math.max(np, m.patch[t] + 1);
  const th = new Float64Array(nt).fill(Infinity);
  const area = new Float64Array(nt);
  const hitTri = new Int32Array(nt).fill(-1);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const nn = triNormal(m.P, m.T, t);
    const a2 = len(nn);
    area[t] = a2 / 2;
    total += a2 / 2;
    if (!(a2 > 0)) continue;
    const n = scale(nn, 1 / a2);
    const c: V3 = [0, 1, 2].map((k) => (m.P[3 * m.T[3 * t] + k] + m.P[3 * m.T[3 * t + 1] + k] + m.P[3 * m.T[3 * t + 2] + k]) / 3) as V3;
    const d = scale(n, -1);
    const hit = bvh.ray(add(c, scale(d, 1e-7 * size)), d, size, (o) => o === t);
    if (!hit) continue;
    const hn = norm(triNormal(m.P, m.T, hit.tri));
    if (dot(hn, n) > -0.7) continue;
    th[t] = hit.s;
    hitTri[t] = hit.tri;
  }
  // a patch is a wall face when most of it sees a facing face close behind
  const pArea = new Float64Array(np),
    pWall = new Float64Array(np);
  const pT: number[][] = Array.from({ length: np }, () => []);
  for (let t = 0; t < nt; t++) {
    pArea[m.patch[t]] += area[t];
    pT[m.patch[t]].push(t);
  }
  // the wall's thickness: what the sheet says, else the most common short distance behind the faces
  let tWall = tHint ?? 0;
  if (!tWall) {
    const ds: { d: number; a: number }[] = [];
    for (let t = 0; t < nt; t++) if (Number.isFinite(th[t]) && th[t] < 0.25 * size) ds.push({ d: th[t], a: area[t] });
    if (!ds.length) return { why: "it has no thin walls: every face is far from the one behind it" };
    ds.sort((x, y) => x.d - y.d);
    const half = ds.reduce((s, x) => s + x.a, 0) / 2;
    let acc = 0;
    for (const x of ds) {
      acc += x.a;
      if (acc >= half) {
        tWall = x.d;
        break;
      }
    }
  }
  const near = (d: number) => Number.isFinite(d) && d < 1.6 * tWall + 0.05 && d > 0.4 * tWall;
  for (let t = 0; t < nt; t++) if (near(th[t])) pWall[m.patch[t]] += area[t];
  // each patch's outline length: an edge face or a bore through the wall is a strip about as wide as the wall
  const E = edgeMap(m.T, nv);
  const pPerim = new Float64Array(np);
  for (const [k, l] of E) {
    const a = Math.floor(k / nv),
      b = k % nv;
    const el = len(sub(pt(m.P, a), pt(m.P, b)));
    for (const t of l) if (l.length !== 2 || m.patch[l[0]] !== m.patch[l[1]]) pPerim[m.patch[t]] += el;
  }
  const isWall = new Uint8Array(np);
  for (let p = 0; p < np; p++) if (pArea[p] > 0 && pWall[p] / pArea[p] > 0.6 && pArea[p] > 0.9 * tWall * pPerim[p]) isWall[p] = 1;
  // wall faces joined along their edges: the two sides
  const comp = new Int32Array(np).fill(-1);
  let nc = 0;
  const padj: Set<number>[] = Array.from({ length: np }, () => new Set<number>());
  for (const l of E.values())
    for (let i = 0; i < l.length; i++)
      for (let j = i + 1; j < l.length; j++) {
        const a = m.patch[l[i]],
          b = m.patch[l[j]];
        if (a !== b) {
          padj[a].add(b);
          padj[b].add(a);
        }
      }
  for (let s = 0; s < np; s++) {
    if (!isWall[s] || comp[s] >= 0) continue;
    comp[s] = nc;
    const q = [s];
    for (let h = 0; h < q.length; h++) for (const o of padj[q[h]]) if (isWall[o] && comp[o] < 0) (comp[o] = nc), q.push(o);
    nc++;
  }
  const cArea = new Float64Array(nc);
  for (let p = 0; p < np; p++) if (comp[p] >= 0) cArea[comp[p]] += pArea[p];
  const wallArea = cArea.reduce((s, x) => s + x, 0);
  if (!nc || wallArea < 0.5 * total) return { why: `less than half of its surface is thin wall (about ${(tWall || 0).toFixed(2)} mm)` };
  const ranked = [...cArea.keys()].sort((a, b) => cArea[b] - cArea[a]);
  const keep = ranked[0];
  const other = ranked[1];
  // what else is wall but on neither main side (a rib, a boss) means it is not one simple sheet
  const stray = ranked.slice(2).reduce((s, c) => s + cArea[c], 0);
  if (other === undefined) return { why: "its thin faces do not form two sides of one wall" };
  if (stray > 0.03 * wallArea) return { why: "it has ribs, bosses or walls branching off, which one sheet cannot follow" };
  // the kept side must face the other side across the wall nearly everywhere
  let paired = 0,
    keptArea = 0;
  const tris: number[] = [];
  const tt: number[] = [];
  for (let t = 0; t < nt; t++) {
    if (comp[m.patch[t]] !== keep) continue;
    tris.push(t);
    keptArea += area[t];
    const ok = near(th[t]) && hitTri[t] >= 0 && comp[m.patch[hitTri[t]]] === other;
    if (ok) paired += area[t];
    tt.push(ok ? th[t] : tWall);
  }
  if (paired < 0.85 * keptArea) return { why: "its two faces do not run parallel over most of it, so it is not one even wall" };
  // thickness by patch: the area-weighted mean of what lies behind it
  const pSum = new Float64Array(np),
    pW = new Float64Array(np);
  tris.forEach((t, i) => {
    if (!near(th[t])) return;
    pSum[m.patch[t]] += tt[i] * area[t];
    pW[m.patch[t]] += area[t];
  });
  const tOut = tris.map((t) => (pW[m.patch[t]] > 0 ? pSum[m.patch[t]] / pW[m.patch[t]] : tWall));
  return { tris, t: tOut, area: keptArea, total };
}

/** The triangles listed, as a surface of their own (vertices renumbered), with their patches. */
export function subSurface(m: SurfaceMesh, tris: number[]): { mesh: SurfaceMesh; vmap: Int32Array } {
  const nv = m.P.length / 3;
  const vmap = new Int32Array(nv).fill(-1);
  const P: number[] = [];
  const T: number[] = [];
  const patch: number[] = [];
  for (const t of tris) {
    for (let j = 0; j < 3; j++) {
      const v = m.T[3 * t + j];
      if (vmap[v] < 0) {
        vmap[v] = P.length / 3;
        P.push(m.P[3 * v], m.P[3 * v + 1], m.P[3 * v + 2]);
      }
      T.push(vmap[v]);
    }
    patch.push(m.patch[t]);
  }
  return { mesh: { P: Float64Array.from(P), T: Int32Array.from(T), patch: Int32Array.from(patch) }, vmap };
}

// ---------- sizes ----------

/**
 * The element size wanted at each vertex: h at most, smaller where the surface curves tightly (a share of the
 * radius) and along tightly curved outlines (small holes), never below hMin, and growing by at most grade per mm
 * away from where it is small.
 */
export function sizeField(m: SurfaceMesh, h: number, hMin: number, grade = 0.35): Float64Array {
  const nv = m.P.length / 3,
    nt = m.T.length / 3;
  const hv = new Float64Array(nv).fill(h);
  const E = edgeMap(m.T, nv);
  const nrm = Array.from({ length: nt }, (_, t) => norm(triNormal(m.P, m.T, t)));
  const cen = Array.from({ length: nt }, (_, t) => scale(add(add(pt(m.P, m.T[3 * t]), pt(m.P, m.T[3 * t + 1])), pt(m.P, m.T[3 * t + 2])), 1 / 3));
  const featNb: number[][] = Array.from({ length: nv }, () => []);
  for (const [k, l] of E) {
    const a = Math.floor(k / nv),
      b = k % nv;
    if (l.length === 2 && m.patch[l[0]] === m.patch[l[1]]) {
      const phi = Math.acos(Math.max(-1, Math.min(1, dot(nrm[l[0]], nrm[l[1]]))));
      const d = len(sub(cen[l[0]], cen[l[1]]));
      if (phi > 1e-3 && d > 0) {
        // the radius the faces turn on, and a share of it per element
        const want = 0.45 * (d / phi);
        hv[a] = Math.min(hv[a], want);
        hv[b] = Math.min(hv[b], want);
      }
    } else {
      featNb[a].push(b);
      featNb[b].push(a);
    }
  }
  for (let v = 0; v < nv; v++) {
    const f = featNb[v];
    if (f.length !== 2) continue;
    const p = pt(m.P, v);
    const u = sub(p, pt(m.P, f[0])),
      w = sub(pt(m.P, f[1]), p);
    const lu = len(u),
      lw = len(w);
    if (!(lu > 0 && lw > 0)) continue;
    const psi = Math.acos(Math.max(-1, Math.min(1, dot(u, w) / (lu * lw))));
    if (psi < 1e-3 || psi > 40 * DEG) continue;
    const want = 0.5 * (((lu + lw) / 2) / psi);
    hv[v] = Math.min(hv[v], want);
  }
  for (let v = 0; v < nv; v++) hv[v] = Math.max(hMin, hv[v]);
  // grade outward: Dijkstra over the mesh edges
  const nb: number[][] = Array.from({ length: nv }, () => []);
  for (const k of E.keys()) {
    const a = Math.floor(k / nv),
      b = k % nv;
    nb[a].push(b);
    nb[b].push(a);
  }
  const heap: [number, number][] = [];
  const push = (x: [number, number]) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  for (let v = 0; v < nv; v++) if (hv[v] < h) push([hv[v], v]);
  while (heap.length) {
    const [hh, v] = pop();
    if (hh > hv[v]) continue;
    const p = pt(m.P, v);
    for (const w of nb[v]) {
      const cand = hh + grade * len(sub(pt(m.P, w), p));
      if (cand < hv[w]) {
        hv[w] = cand;
        push([cand, w]);
      }
    }
  }
  return hv;
}

// ---------- isotropic remeshing ----------

/**
 * An even triangle mesh over the surface, its edges near the size field's sizes. Creases and outlines (edges
 * between patches, or with one triangle) stay: they are split and shortened along themselves only, and their
 * corners never move. Every triangle keeps the patch it came from.
 */
export function remesh(src: SurfaceMesh, size: Float64Array, iterations = 6): SurfaceMesh {
  const bvh = new TriBVH(src.P, src.T);
  const P: number[] = Array.from(src.P);
  const T: number[] = Array.from(src.T);
  const patch: number[] = Array.from(src.patch);
  const hv: number[] = Array.from(size);
  let alive: number[] = new Array(T.length / 3).fill(1);
  const nVerts = () => P.length / 3;
  const nTris = () => T.length / 3;
  const elen = (a: number, b: number) => Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]);
  const want = (a: number, b: number) => 0.5 * (hv[a] + hv[b]);
  const tnorm = (a: number, b: number, c: number): V3 => cross(sub(pt(P, b), pt(P, a)), sub(pt(P, c), pt(P, a)));
  const sizeAt = (hit: NearHit) => hit.w[0] * size[src.T[3 * hit.tri]] + hit.w[1] * size[src.T[3 * hit.tri + 1]] + hit.w[2] * size[src.T[3 * hit.tri + 2]];

  const compact = () => {
    const nt = nTris();
    const used = new Int32Array(nVerts()).fill(-1);
    const nT: number[] = [],
      nPatch: number[] = [];
    for (let t = 0; t < nt; t++) {
      if (!alive[t]) continue;
      nT.push(T[3 * t], T[3 * t + 1], T[3 * t + 2]);
      nPatch.push(patch[t]);
    }
    const nP: number[] = [],
      nH: number[] = [];
    for (let i = 0; i < nT.length; i++) {
      const v = nT[i];
      if (used[v] < 0) {
        used[v] = nP.length / 3;
        nP.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
        nH.push(hv[v]);
      }
      nT[i] = used[v];
    }
    const copy = (dst: number[], from: number[]) => {
      dst.length = from.length;
      for (let i = 0; i < from.length; i++) dst[i] = from[i];
    };
    copy(P, nP);
    copy(T, nT);
    copy(patch, nPatch);
    copy(hv, nH);
    alive = new Array(nTris()).fill(1);
  };

  /** creases and outlines: an edge with other than two triangles, or two from different patches */
  const isFeature = (l: number[]) => l.length !== 2 || patch[l[0]] !== patch[l[1]];

  const vertexTris = () => {
    const vt: number[][] = Array.from({ length: nVerts() }, () => []);
    for (let t = 0; t < nTris(); t++) if (alive[t]) for (let j = 0; j < 3; j++) vt[T[3 * t + j]].push(t);
    return vt;
  };

  /** 0: free, 1: on a crease or outline, 2: a corner that never moves */
  const kinds = (E: Map<number, number[]>) => {
    const nv = nVerts();
    const fn: number[][] = Array.from({ length: nv }, () => []);
    for (const [k, l] of E)
      if (isFeature(l)) {
        const a = Math.floor(k / nv),
          b = k % nv;
        fn[a].push(b);
        fn[b].push(a);
      }
    const kind = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) {
      const f = fn[v];
      if (!f.length) continue;
      if (f.length !== 2) {
        kind[v] = 2;
        continue;
      }
      const u = norm(sub(pt(P, v), pt(P, f[0]))),
        w = norm(sub(pt(P, f[1]), pt(P, v)));
      kind[v] = dot(u, w) < Math.cos(30 * DEG) ? 2 : 1;
    }
    return { kind, fn };
  };

  const splitPass = (): number => {
    const nv = nVerts();
    const E = edgeMap(T, nv, alive);
    const list: { a: number; b: number; l: number; tris: number[] }[] = [];
    for (const [k, l] of E) {
      if (l.length > 2) continue;
      const a = Math.floor(k / nv),
        b = k % nv;
      const L = elen(a, b);
      if (L > (4 / 3) * want(a, b)) list.push({ a, b, l: L, tris: l });
    }
    list.sort((x, y) => y.l - x.l);
    const dirty = new Uint8Array(nTris() + 2 * list.length);
    let n = 0;
    for (const e of list) {
      if (e.tris.some((t) => dirty[t])) continue;
      const m = nVerts();
      P.push((P[3 * e.a] + P[3 * e.b]) / 2, (P[3 * e.a + 1] + P[3 * e.b + 1]) / 2, (P[3 * e.a + 2] + P[3 * e.b + 2]) / 2);
      hv.push(want(e.a, e.b));
      for (const t of e.tris) {
        let k = 0;
        while (!((T[3 * t + k] === e.a && T[3 * t + ((k + 1) % 3)] === e.b) || (T[3 * t + k] === e.b && T[3 * t + ((k + 1) % 3)] === e.a))) k++;
        const u = T[3 * t + k],
          v = T[3 * t + ((k + 1) % 3)],
          c = T[3 * t + ((k + 2) % 3)];
        T[3 * t] = u;
        T[3 * t + 1] = m;
        T[3 * t + 2] = c;
        const nt = nTris();
        T.push(m, v, c);
        patch.push(patch[t]);
        alive.push(1);
        dirty[t] = 1;
        dirty[nt] = 1;
      }
      n++;
    }
    return n;
  };

  /**
   * Collapses edges shorter than 0.8 of the size wanted, shortest first. The vertex → triangle lists and the crease
   * links are kept up to date as it goes, so one pass takes whole runs of short edges, each checked on the mesh as it
   * stands.
   */
  const collapsePass = (): number => {
    const nv = nVerts();
    const E = edgeMap(T, nv, alive);
    const VT = vertexTris();
    const { kind, fn } = kinds(E);
    const list: { a: number; b: number; l: number }[] = [];
    for (const [k, l] of E) {
      if (l.length > 2) continue;
      const a = Math.floor(k / nv),
        b = k % nv;
      const L = elen(a, b);
      if (L < 0.8 * want(a, b)) list.push({ a, b, l: L });
    }
    list.sort((x, y) => x.l - y.l);
    const gone = new Uint8Array(nv);
    // per-collapse scratch: a mark per vertex, cleared by bumping the stamp
    const mark = new Int32Array(nv);
    let stamp = 0;
    const edgeTris = (a: number, b: number, out: number[]) => {
      out.length = 0;
      for (const t of VT[a]) if (T[3 * t] === b || T[3 * t + 1] === b || T[3 * t + 2] === b) out.push(t);
      return out;
    };
    const tris: number[] = [];
    let n = 0;
    const tryCollapse = (a: number, b: number): boolean => {
      if (kind[a] === 2) return false;
      const feat = tris.length !== 2 || patch[tris[0]] !== patch[tris[1]];
      let c = -1;
      if (kind[a] === 1) {
        if (!feat || fn[a].length !== 2 || !fn[a].includes(b)) return false;
        // along a crease: only where the crease runs nearly straight through a
        c = fn[a][0] === b ? fn[a][1] : fn[a][0];
        if (c === b) return false;
        const bc = sub(pt(P, c), pt(P, b));
        const lbc = len(bc);
        if (!(lbc > 0)) return false;
        const off = len(cross(sub(pt(P, a), pt(P, b)), bc)) / lbc;
        if (off > 0.08 * lbc) return false;
      } else if (feat) return false;
      // keeps the surface a surface: a and b share only the corners across their edge
      stamp += 3;
      for (const t of tris) for (let j = 0; j < 3; j++) mark[T[3 * t + j]] = stamp + 2;
      for (const t of VT[a]) for (let j = 0; j < 3; j++) if (mark[T[3 * t + j]] !== stamp + 2) mark[T[3 * t + j]] = stamp + 1;
      for (const t of VT[b]) for (let j = 0; j < 3; j++) if (mark[T[3 * t + j]] === stamp + 1) return false;
      // no triangle turns over or grows an edge too long, with b where it ends up
      const mid: V3 | null = kind[a] === 0 && kind[b] === 0 ? scale(add(pt(P, a), pt(P, b)), 0.5) : null;
      const pb = mid ?? pt(P, b);
      const at = (v: number) => (v === a || v === b ? pb : pt(P, v));
      for (const list of [VT[a], VT[b]])
        for (const t of list) {
          if (tris.includes(t)) continue;
          const v0 = T[3 * t],
            v1 = T[3 * t + 1],
            v2 = T[3 * t + 2];
          const before = tnorm(v0, v1, v2);
          const q0 = at(v0);
          const na2 = cross(sub(at(v1), q0), sub(at(v2), q0));
          const la = len(na2),
            lb = len(before);
          if (!(la > 1e-12 * (lb + 1e-30)) || dot(na2, before) < 0.7 * la * lb) return false;
          // an edge already too long (split later anyway) may stay so, growing a little; no other may become too long
          for (const v of [v0, v1, v2]) {
            if (v === a || v === b) continue;
            const L = len(sub(pt(P, v), pb));
            if (L > (4 / 3) * want(v, b)) {
              const was = list === VT[a] ? elen(v, a) : elen(v, b);
              if (!(was > (4 / 3) * want(v, b)) || L > 1.05 * was) return false;
            }
          }
        }
      // collapse: a's triangles go to b, the ones across the edge go
      for (const t of tris) {
        alive[t] = 0;
        for (let j = 0; j < 3; j++) {
          const v = T[3 * t + j];
          if (v !== a) {
            const l = VT[v];
            const i = l.indexOf(t);
            if (i >= 0) l.splice(i, 1);
          }
        }
      }
      for (const t of VT[a]) {
        if (!alive[t]) continue;
        for (let j = 0; j < 3; j++) if (T[3 * t + j] === a) T[3 * t + j] = b;
        VT[b].push(t);
      }
      VT[a] = [];
      gone[a] = 1;
      // the crease now runs b – c
      if (c >= 0) {
        fn[b] = fn[b].map((x) => (x === a ? c : x));
        fn[c] = fn[c].map((x) => (x === a ? b : x));
      }
      // two free vertices meet halfway (b keeps its place when it sits on a crease)
      if (mid) {
        P[3 * b] = mid[0];
        P[3 * b + 1] = mid[1];
        P[3 * b + 2] = mid[2];
        hv[b] = 0.5 * (hv[a] + hv[b]);
      }
      return true;
    };
    for (const e of list) {
      if (gone[e.a] || gone[e.b]) continue;
      if (!edgeTris(e.a, e.b, tris).length || tris.length > 2) continue;
      if (!(elen(e.a, e.b) < 0.8 * want(e.a, e.b))) continue;
      if (tryCollapse(e.a, e.b) || tryCollapse(e.b, e.a)) n++;
    }
    compact();
    return n;
  };

  const flipPass = (delaunay: boolean): number => {
    const nv = nVerts();
    const E = edgeMap(T, nv, alive);
    const val = new Int32Array(nv);
    const boundary = new Uint8Array(nv);
    for (const [k, l] of E) {
      const a = Math.floor(k / nv),
        b = k % nv;
      val[a]++;
      val[b]++;
      if (l.length === 1) boundary[a] = boundary[b] = 1;
    }
    const dirty = new Uint8Array(nTris());
    let n = 0;
    for (const [k, l] of E) {
      if (l.length !== 2 || patch[l[0]] !== patch[l[1]]) continue;
      const [t1, t2] = l;
      if (dirty[t1] || dirty[t2]) continue;
      const a0 = Math.floor(k / nv),
        b0 = k % nv;
      // t1 runs a → b, t2 runs b → a
      let j = 0;
      while (!(T[3 * t1 + j] === a0 || T[3 * t1 + j] === b0) || !(T[3 * t1 + ((j + 1) % 3)] === a0 || T[3 * t1 + ((j + 1) % 3)] === b0)) j++;
      const a = T[3 * t1 + j],
        b = T[3 * t1 + ((j + 1) % 3)],
        c = T[3 * t1 + ((j + 2) % 3)];
      let d = -1;
      for (let i = 0; i < 3; i++) if (T[3 * t2 + i] !== a && T[3 * t2 + i] !== b) d = T[3 * t2 + i];
      if (d < 0 || c === d || E.has(ekey(c, d, nv))) continue;
      if (delaunay) {
        const ang = (o: number, x: number, y: number) => {
          const u = sub(pt(P, x), pt(P, o)),
            w = sub(pt(P, y), pt(P, o));
          return Math.acos(Math.max(-1, Math.min(1, dot(u, w) / (len(u) * len(w) || 1))));
        };
        if (ang(c, a, b) + ang(d, b, a) <= Math.PI + 1e-3) continue;
        if (val[c] >= 9 || val[d] >= 9) continue;
      } else {
        const tg = (v: number) => (boundary[v] ? 4 : 6);
        const dev = (v: number, x: number) => (x - tg(v)) ** 2;
        const before = dev(a, val[a]) + dev(b, val[b]) + dev(c, val[c]) + dev(d, val[d]);
        const after = dev(a, val[a] - 1) + dev(b, val[b] - 1) + dev(c, val[c] + 1) + dev(d, val[d] + 1);
        if (after >= before) continue;
      }
      const n1 = norm(tnorm(a, b, c)),
        n2 = norm(tnorm(b, a, d));
      const avg = norm(add(n1, n2));
      const m1 = tnorm(c, a, d),
        m2 = tnorm(d, b, c);
      const l1 = len(m1),
        l2 = len(m2);
      if (!(l1 > 0 && l2 > 0) || dot(m1, avg) < 0.5 * l1 || dot(m2, avg) < 0.5 * l2) continue;
      // keeps triangles from getting much worse: the new shortest height no less than half the old
      const q = (x: number, y: number, z: number) => {
        const ar = len(tnorm(x, y, z));
        const lm = Math.max(elen(x, y), elen(y, z), elen(z, x));
        return ar / (lm * lm);
      };
      if (!delaunay && Math.min(q(c, a, d), q(d, b, c)) < 0.5 * Math.min(q(a, b, c), q(b, a, d))) continue;
      T[3 * t1] = c;
      T[3 * t1 + 1] = a;
      T[3 * t1 + 2] = d;
      T[3 * t2] = d;
      T[3 * t2 + 1] = b;
      T[3 * t2 + 2] = c;
      val[a]--;
      val[b]--;
      val[c]++;
      val[d]++;
      dirty[t1] = dirty[t2] = 1;
      n++;
    }
    return n;
  };

  const smoothPass = () => {
    const nv = nVerts();
    const E = edgeMap(T, nv, alive);
    const VT = vertexTris();
    const { kind } = kinds(E);
    const next: (V3 | null)[] = new Array(nv).fill(null);
    for (let v = 0; v < nv; v++) {
      if (kind[v] !== 0 || !VT[v].length) continue;
      let c: V3 = [0, 0, 0],
        nn: V3 = [0, 0, 0],
        wsum = 0;
      for (const t of VT[v]) {
        const tn = tnorm(T[3 * t], T[3 * t + 1], T[3 * t + 2]);
        const ar = len(tn);
        const g = scale(add(add(pt(P, T[3 * t]), pt(P, T[3 * t + 1])), pt(P, T[3 * t + 2])), 1 / 3);
        c = add(c, scale(g, ar));
        nn = add(nn, tn);
        wsum += ar;
      }
      if (!(wsum > 0)) continue;
      c = scale(c, 1 / wsum);
      const n = norm(nn);
      const p = pt(P, v);
      let d = sub(c, p);
      d = sub(d, scale(n, dot(d, n)));
      const q = add(p, scale(d, 0.7));
      const pp = patch[VT[v][0]];
      const hit = bvh.nearest(q, (t) => src.patch[t] === pp);
      next[v] = hit ? hit.q : q;
      if (hit) hv[v] = sizeAt(hit);
    }
    // move, then put back any vertex whose triangles turned over
    const old = P.slice();
    for (let v = 0; v < nv; v++) {
      const q = next[v];
      if (!q) continue;
      P[3 * v] = q[0];
      P[3 * v + 1] = q[1];
      P[3 * v + 2] = q[2];
    }
    for (let v = 0; v < nv; v++) {
      if (!next[v]) continue;
      for (const t of VT[v]) {
        const vs = [T[3 * t], T[3 * t + 1], T[3 * t + 2]];
        const before = cross(sub(pt(old, vs[1]), pt(old, vs[0])), sub(pt(old, vs[2]), pt(old, vs[0])));
        const after = tnorm(vs[0], vs[1], vs[2]);
        if (dot(before, after) < 0.2 * len(before) * len(after) || len(after) < 1e-3 * len(before)) {
          P[3 * v] = old[3 * v];
          P[3 * v + 1] = old[3 * v + 1];
          P[3 * v + 2] = old[3 * v + 2];
          break;
        }
      }
    }
  };

  // the display's tessellation has runs of short edges (round outlines, fans of slivers): take them out first, so
  // the splits do not fill the long triangles between them with far more corners than wanted
  for (let s = 0; s < 3 && collapsePass() > 0; s++);
  for (let it = 0; it < iterations; it++) {
    for (let s = 0; s < 10 && splitPass() > 0; s++);
    compact();
    // a pass takes the short edges it can; a few more catch the ones that only came free after it
    let before = nTris();
    for (let s = 0; s < 25; s++) {
      const n = collapsePass();
      if (!n || nTris() > 0.995 * before) break;
      before = nTris();
    }
    for (let s = 0; s < 3 && flipPass(false) > 0; s++);
    smoothPass();
  }
  for (let s = 0; s < 4 && flipPass(true) > 0; s++);
  smoothPass();
  compact();
  return { P: Float64Array.from(P), T: Int32Array.from(T), patch: Int32Array.from(patch) };
}
