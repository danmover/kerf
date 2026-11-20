// Rounded edges for the 3D view. No real part has knife-sharp edges: they are
// broken, deburred, moulded or worn round, and that thin round catches the
// light, which is much of what makes a render read as a real object. The
// solid stays as it is (checks, exports and drawings see the true edges);
// the view lays a thin band over each face along every sharp edge, flat on
// the face, whose normals turn from the face's own to halfway toward the
// other face's at the edge. Shaded, the two bands of an edge look like a
// small round, and at a silhouette the band on the visible face still turns
// toward the hidden one, so outlines catch a rim of light too.
//
// The bands are found from the mesh alone: each B-rep face is meshed on its
// own, so the edges of its triangles that no other triangle of the face
// shares are its boundary, and two faces' boundaries meet where their points
// coincide. The band's width is set in the vertex shader (the part's edge
// radius, but never less than a fraction of a pixel, so edges still read
// from far away) and never more than its face allows (`aBevel`'s length).

import * as THREE from "three";
import type { MeshData } from "../../../kernel/build";

/** Edges whose faces meet more sharply than this (degrees between their normals) are rounded. */
export const SHARP_DEG = 22;

export interface BevelInput {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** (first index, index count, face id) per B-rep face */
  faceGroups: Int32Array;
}

export interface BevelBands {
  positions: Float32Array;
  /** unit normals, as normalised 16-bit integers */
  normals: Int16Array;
  /** per vertex: xyz is the way into its face times the most the band may reach there (0 on the edge itself), w is 1 */
  bevel: Float32Array;
  indices: Uint32Array | Uint16Array;
  /** sharp edge segments found */
  segments: number;
}

class Grow {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(Math.max(16, cap));
  }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
}

class GrowU32 {
  a: Uint32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Uint32Array(Math.max(16, cap));
  }
  push(v: number) {
    if (this.n >= this.a.length) {
      const b = new Uint32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

/**
 * The bands for one mesh, or null when it has no sharp edges (or no faces to find them from). Widths are in the
 * mesh's units (mm); `reach` caps how far a band may run into a face as a share of the triangle beside it.
 */
export function bevelBands(m: BevelInput, opts: { sharpDeg?: number; reach?: number } = {}): BevelBands | null {
  const P = m.positions;
  const N = m.normals;
  const I = m.indices;
  const G = m.faceGroups;
  const nV = P.length / 3;
  const nG = G.length / 3;
  if (!nG || !I.length) return null;
  const cosSharp = Math.cos(((opts.sharpDeg ?? SHARP_DEG) * Math.PI) / 180);
  const reach = opts.reach ?? 0.45;

  // 1. each face's boundary: the triangle edges no other triangle of that face shares, kept with their winding
  const bA = new GrowU32(1024);
  const bB = new GrowU32(1024);
  const bO = new GrowU32(1024);
  const bG = new GrowU32(1024);
  const seen = new Map<number, number>();
  for (let g = 0; g < nG; g++) {
    const s = G[g * 3];
    const c = G[g * 3 + 1];
    const end = Math.min(s + c, I.length);
    seen.clear();
    for (let t = s; t + 2 < end; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = I[t + k];
        const b = I[t + ((k + 1) % 3)];
        const key = a < b ? a * nV + b : b * nV + a;
        const had = seen.get(key);
        seen.set(key, had === undefined ? t + k : -1);
      }
    }
    for (const slot of seen.values()) {
      if (slot < 0) continue;
      const t = slot - (slot % 3);
      const k = slot - t;
      bA.push(I[t + k]);
      bB.push(I[t + ((k + 1) % 3)]);
      bO.push(I[t + ((k + 2) % 3)]);
      bG.push(g);
    }
  }
  const nE = bA.n;
  if (!nE) return null;

  // 2. boundaries of two faces meet where their end points coincide (to a micrometre)
  const pk: (string | undefined)[] = new Array(nV);
  const pointKey = (v: number) => {
    let s = pk[v];
    if (s === undefined) {
      s = `${Math.round(P[v * 3] * 1000)},${Math.round(P[v * 3 + 1] * 1000)},${Math.round(P[v * 3 + 2] * 1000)}`;
      pk[v] = s;
    }
    return s;
  };
  const open = new Map<string, number>();
  const pairs = new GrowU32(1024);
  for (let e = 0; e < nE; e++) {
    const ka = pointKey(bA.a[e]);
    const kb = pointKey(bB.a[e]);
    if (ka === kb) continue;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const other = open.get(key);
    if (other === undefined) open.set(key, e);
    else if (other >= 0) {
      pairs.push(other);
      pairs.push(e);
      // a third face on the same edge (not a closed solid there): leave it plain
      open.set(key, -1);
    }
  }

  // 3. the bands: one strip on each face of every sharp edge
  const pos = new Grow(pairs.n * 6);
  const nrm = new Grow(pairs.n * 6);
  const dir = new Grow(pairs.n * 6);
  const wmax: number[] = [];
  const idx = new GrowU32(pairs.n * 12);
  const edgeVert = new Map<number, number>();
  const innerVert = new Map<number, number>();
  let segments = 0;

  const vertex = (v: number, nx: number, ny: number, nz: number) => {
    pos.push3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    nrm.push3(nx, ny, nz);
    dir.push3(0, 0, 0);
    wmax.push(0);
    return wmax.length - 1;
  };
  /** the edge's own point, shared by both strips and by the next segment along the edge */
  const onEdge = (a: number, b: number) => {
    const key = a < b ? a * nV + b : b * nV + a;
    let id = edgeVert.get(key);
    if (id === undefined) {
      let x = N[a * 3] + N[b * 3];
      let y = N[a * 3 + 1] + N[b * 3 + 1];
      let z = N[a * 3 + 2] + N[b * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      x /= l;
      y /= l;
      z /= l;
      id = vertex(a, x, y, z);
      edgeVert.set(key, id);
    }
    return id;
  };
  /** the strip's inner side at a face's point, for the edge it shares with face `partner`: its way in adds up along the edge */
  const inside = (v: number, partner: number, ix: number, iy: number, iz: number, w: number) => {
    const key = v * nG + partner;
    let id = innerVert.get(key);
    if (id === undefined) {
      id = vertex(v, N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
      innerVert.set(key, id);
      wmax[id] = w;
    } else wmax[id] = Math.min(wmax[id], w);
    dir.a[id * 3] += ix;
    dir.a[id * 3 + 1] += iy;
    dir.a[id * 3 + 2] += iz;
    return id;
  };
  /** one face's strip along edge a→b (that face's winding), its triangle's third point o, the matching points on the other face */
  const strip = (a: number, b: number, o: number, pa: number, pb: number, partner: number, convex: boolean) => {
    const ax = P[a * 3],
      ay = P[a * 3 + 1],
      az = P[a * 3 + 2];
    const tx = P[b * 3] - ax,
      ty = P[b * 3 + 1] - ay,
      tz = P[b * 3 + 2] - az;
    const tt = tx * tx + ty * ty + tz * tz;
    if (tt < 1e-12) return;
    const dx = P[o * 3] - ax,
      dy = P[o * 3 + 1] - ay,
      dz = P[o * 3 + 2] - az;
    const f = (dx * tx + dy * ty + dz * tz) / tt;
    let ix = dx - tx * f,
      iy = dy - ty * f,
      iz = dz - tz * f;
    const h = Math.hypot(ix, iy, iz);
    if (h < 1e-6) return;
    ix /= h;
    iy /= h;
    iz /= h;
    // an inside corner gets a narrower round than an outside one
    const w = h * reach * (convex ? 1 : 0.5);
    const e0 = onEdge(a, pa);
    const e1 = onEdge(b, pb);
    const i1 = inside(b, partner, ix, iy, iz, w);
    const i0 = inside(a, partner, ix, iy, iz, w);
    idx.push(e0);
    idx.push(e1);
    idx.push(i1);
    idx.push(e0);
    idx.push(i1);
    idx.push(i0);
  };

  const dot = (u: number, v: number) => N[u * 3] * N[v * 3] + N[u * 3 + 1] * N[v * 3 + 1] + N[u * 3 + 2] * N[v * 3 + 2];
  for (let p = 0; p < pairs.n; p += 2) {
    const e1 = pairs.a[p];
    const e2 = pairs.a[p + 1];
    const a1 = bA.a[e1],
      b1 = bB.a[e1],
      o1 = bO.a[e1],
      g1 = bG.a[e1];
    const a2 = bA.a[e2],
      b2 = bB.a[e2],
      o2 = bO.a[e2],
      g2 = bG.a[e2];
    // the two faces run along their shared edge in opposite directions (a closed, consistently wound solid), or the same
    const flip = pointKey(a2) === pointKey(b1);
    const pa1 = flip ? b2 : a2;
    const pb1 = flip ? a2 : b2;
    // smooth across the edge (a fillet's tangent edge, a cylinder's seam): nothing to round
    if ((dot(a1, pa1) + dot(b1, pb1)) * 0.5 > cosSharp) continue;
    // an outside edge when the other face's normal points away from this face's inside
    const tx = P[b1 * 3] - P[a1 * 3],
      ty = P[b1 * 3 + 1] - P[a1 * 3 + 1],
      tz = P[b1 * 3 + 2] - P[a1 * 3 + 2];
    const dx = P[o1 * 3] - P[a1 * 3],
      dy = P[o1 * 3 + 1] - P[a1 * 3 + 1],
      dz = P[o1 * 3 + 2] - P[a1 * 3 + 2];
    const tt = tx * tx + ty * ty + tz * tz || 1;
    const f = (dx * tx + dy * ty + dz * tz) / tt;
    const inx = dx - tx * f,
      iny = dy - ty * f,
      inz = dz - tz * f;
    const convex = N[pa1 * 3] * inx + N[pa1 * 3 + 1] * iny + N[pa1 * 3 + 2] * inz < 0;
    strip(a1, b1, o1, pa1, pb1, g2, convex);
    strip(a2, b2, o2, flip ? b1 : a1, flip ? a1 : b1, g1, convex);
    segments++;
  }
  const nOut = wmax.length;
  if (!segments || !nOut) return null;

  // 4. each inner point's way in (the mean of its segments' ways in) times the most it may reach
  const bevel = new Float32Array(nOut * 4);
  const normals = new Int16Array(nOut * 3);
  for (let v = 0; v < nOut; v++) {
    const x = dir.a[v * 3],
      y = dir.a[v * 3 + 1],
      z = dir.a[v * 3 + 2];
    const l = Math.hypot(x, y, z);
    const k = l > 1e-9 ? wmax[v] / l : 0;
    bevel[v * 4] = x * k;
    bevel[v * 4 + 1] = y * k;
    bevel[v * 4 + 2] = z * k;
    bevel[v * 4 + 3] = 1;
    for (let c = 0; c < 3; c++) normals[v * 3 + c] = Math.round(Math.max(-1, Math.min(1, nrm.a[v * 3 + c])) * 32767);
  }
  const indices = nOut < 65536 ? Uint16Array.from(idx.a.subarray(0, idx.n)) : idx.a.slice(0, idx.n);
  return { positions: pos.a.slice(0, nOut * 3), normals, bevel, indices, segments };
}

/** The bands as a geometry the part's own material draws (its shader reads aBevel). */
export function bevelGeometry(b: BevelBands): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(b.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(b.normals, 3, true));
  g.setAttribute("aBevel", new THREE.BufferAttribute(b.bevel, 4));
  g.setIndex(new THREE.BufferAttribute(b.indices, 1));
  g.computeBoundingSphere();
  return g;
}

type Done = (key: string, bands: BevelBands | null) => void;

/**
 * Finds the bands off the main thread, one mesh at a time. A mesh asked for again while it waits is not done twice;
 * `drop` forgets one that is no longer shown. Without workers (tests) it does nothing.
 */
export class BevelBuilder {
  private worker: Worker | null = null;
  private queue: { key: string; data: BevelInput }[] = [];
  private busy: string | null = null;
  private dropped = new Set<string>();
  private failed = false;

  constructor(private done: Done) {}

  request(key: string, data: MeshData) {
    if (this.failed || !data.faceGroups?.length || typeof Worker === "undefined") return;
    if (this.busy === key || this.queue.some((j) => j.key === key)) return;
    this.dropped.delete(key);
    this.queue.push({ key, data: { positions: data.positions, normals: data.normals, indices: data.indices, faceGroups: data.faceGroups } });
    this.next();
  }

  drop(key: string) {
    this.queue = this.queue.filter((j) => j.key !== key);
    if (this.busy === key) this.dropped.add(key);
  }

  private next() {
    if (this.busy || !this.queue.length) return;
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL("./bevel.worker.ts", import.meta.url), { type: "module", name: "kerf-bevel" });
      } catch {
        this.failed = true;
        this.queue = [];
        return;
      }
      this.worker.onmessage = ({ data }: MessageEvent<{ key: string; bands: BevelBands | null }>) => {
        const key = this.busy;
        this.busy = null;
        if (key && !this.dropped.delete(key)) this.done(key, data.bands);
        this.next();
      };
      this.worker.onerror = () => {
        // no rounded edges then: the view is as before
        this.failed = true;
        this.queue = [];
        this.busy = null;
        this.worker?.terminate();
        this.worker = null;
      };
    }
    const job = this.queue.shift()!;
    this.busy = job.key;
    // copies: the view keeps drawing from the originals
    this.worker.postMessage({ key: job.key, data: job.data });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.queue = [];
  }
}
