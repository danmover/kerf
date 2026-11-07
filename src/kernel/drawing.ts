// Drawing and measuring geometry, run in the kernel worker: exact hidden-line
// projection of placed solids (OpenCASCADE HLR), section cuts with their cut
// faces, and exact measurements between picked faces, edges and points.

import * as R from "replicad";
import type { AnyShape, Edge, Face, Shape3D } from "replicad";
import { applyXf } from "./build";
import { applyXforms, reflect, vcross, vdot, vnorm, vsub, type V3, type Xform } from "./recipe";

// ---------- projection ----------

export interface ProjItem {
  id: string;
  hash: string;
  xf: Xform[];
  /** false for parts that are never sectioned (screws, pins, nuts) */
  cut?: boolean;
}

export interface ViewRequest {
  /** camera direction: from the model toward the viewer */
  dir: V3;
  /** view x axis (right on the sheet); y is dir × x */
  x: V3;
  items: ProjItem[];
  /** keep the material on the -normal side of this plane and hatch the cut faces */
  section?: { at: V3; normal: V3 };
  hidden: boolean;
  /** world segments to measure the first item's material along (through-hole checks) */
  probes?: { a: V3; b: V3 }[];
  /** broken-out sections: the view again with the material in front of each plane cut away, for the drawing to show inside a region */
  cutaways?: { at: V3; normal: V3 }[];
}

/** 2D geometry in view coordinates (model millimetres, y up). */
export type Prim2 =
  | { t: "L"; p: [number, number, number, number] }
  /** arc counter-clockwise from a0 to a1 (radians, a1 > a0); a full circle when a1 - a0 ≥ 2π */
  | { t: "A"; c: [number, number]; r: number; a0: number; a1: number }
  | { t: "P"; p: number[] };

export interface Edge2 {
  /** index into the request's items */
  part: number;
  vis: boolean;
  g: Prim2;
}

export interface ViewResult {
  edges: Edge2[];
  /** cut faces of a section, as closed loops (flat x, y lists) per part */
  hatch: { part: number; loops: number[][] }[];
  /** material length along each probe segment */
  probes?: number[];
  /** items whose solid the kernel no longer holds (evicted or not built yet), left out of the view */
  missing?: number[];
  /** each broken-out section's edges and cut faces, in the request's order */
  cutaways?: { edges: Edge2[]; hatch: { part: number; loops: number[][] }[] }[];
  ms: number;
}

type Placed = (p: { hash: string; xf: Xform[] }) => { shape: Shape3D };

function oc() {
  return R.getOC() as unknown as Record<string, new (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown>>;
}

function free(o: unknown) {
  try {
    (o as { delete?: () => void })?.delete?.();
  } catch {
    /* already freed */
  }
}

export function projectView(req: ViewRequest, placed: Placed, meshOf?: MeshOf): ViewResult {
  // many parts and no cut: each part on its own, occlusion from a depth buffer
  if (meshOf && !req.section && !req.cutaways?.length && req.items.length >= FAST_ITEMS) return projectAssembly(req, placed, meshOf);
  const t0 = performance.now();
  const dir = vnorm(req.dir);
  const xAxis = vnorm(req.x);
  const yAxis = vcross(dir, xAxis);
  let probes: number[] | undefined;
  const missing: number[] = [];
  const solids: { part: number; w: Shape3D; cut: boolean }[] = [];
  req.items.forEach((it, part) => {
    try {
      const w = placed(it).shape;
      if (part === 0 && req.probes?.length) probes = req.probes.map((s) => materialAlong(w, s.a, s.b));
      solids.push({ part, w, cut: it.cut !== false });
    } catch {
      missing.push(part);
    }
  });
  const main = cutView(solids, req.section, dir, xAxis, yAxis, req.hidden);
  // a broken-out section shows what lies behind its plane: no hidden lines there
  const cutaways = req.cutaways?.map((c) => cutView(solids, c, dir, xAxis, yAxis, false));
  return { edges: main.edges, hatch: main.hatch, probes, missing: missing.length ? missing : undefined, cutaways, ms: performance.now() - t0 };
}

/** Edges of some placed solids seen along dir, cut by a section plane when there is one (keeping the -normal side), with the cut faces as loops. */
function cutView(solids: { part: number; w: Shape3D; cut: boolean }[], section: { at: V3; normal: V3 } | undefined, dir: V3, xAxis: V3, yAxis: V3, hidden: boolean): { edges: Edge2[]; hatch: ViewResult["hatch"] } {
  const shapes: { part: number; shape: AnyShape; temp: boolean }[] = [];
  const hatch: ViewResult["hatch"] = [];
  for (const { part, w, cut } of solids) {
    if (!section) {
      shapes.push({ part, shape: w, temp: false });
      continue;
    }
    const n = vnorm(section.normal);
    const offset = vdot(section.at, n);
    if (!cut) {
      // whole standard parts stay unsectioned when their centre lies behind the plane
      const [lo, hi] = w.boundingBox.bounds;
      const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      if (vdot(c, n) <= offset) shapes.push({ part, shape: w, temp: false });
      continue;
    }
    const plane = new R.Plane(section.at, null, [-n[0], -n[1], -n[2]]);
    let kept: Shape3D | null = null;
    // cutPlane leaves the cached solid as it is and returns a new one
    try {
      kept = w.cutPlane(plane) as Shape3D | null;
    } catch {
      kept = null;
    }
    if (!kept) {
      free(plane);
      continue;
    }
    shapes.push({ part, shape: kept, temp: true });
    try {
      const faces = new R.FaceFinder().inPlane(plane).find(kept);
      const loops: number[][] = [];
      for (const f of faces) {
        loops.push(...faceLoops(f as Face, xAxis, yAxis));
        free(f);
      }
      if (loops.length) hatch.push({ part, loops });
    } catch {
      /* no cut faces: the plane missed the part */
    }
    free(plane);
  }
  const edges = shapes.length ? hlrEdges(shapes, dir, xAxis, hidden) : [];
  for (const s of shapes) if (s.temp) free(s.shape);
  return { edges, hatch };
}

/** Exact hidden-line removal of some placed solids seen along dir, in view coordinates. */
function hlrEdges(shapes: { part: number; shape: AnyShape }[], dir: V3, xAxis: V3, hidden: boolean): Edge2[] {
  const edges: Edge2[] = [];
  const O = oc();
  const camera = new R.ProjectionCamera([0, 0, 0], dir, xAxis);
  const algo = new O.HLRBRep_Algo();
  for (const s of shapes) algo.Add(s.shape.wrapped, 0);
  const projector = new O.HLRAlgo_Projector(camera.wrapped);
  algo.Projector(projector);
  algo.Update();
  algo.Hide();
  const hlr = new O.HLRBRep_HLRToShape(algo);
  for (const s of shapes) {
    const sets: [string, boolean][] = [
      ["VCompound", true],
      ["OutLineVCompound", true],
    ];
    if (hidden) sets.push(["HCompound", false], ["OutLineHCompound", false]);
    for (const [fn, vis] of sets) {
      let compound: unknown;
      try {
        compound = hlr[fn](s.shape.wrapped);
      } catch {
        continue;
      }
      const c = compound as { IsNull(): boolean };
      if (!c || c.IsNull()) continue;
      const comp = new R.Compound(compound as never);
      for (const e of comp.edges) {
        const g = edgePrim(e);
        if (g) edges.push({ part: s.part, vis, g });
        free(e);
      }
      free(comp);
    }
  }
  free(hlr);
  free(projector);
  free(algo);
  free(camera);
  return edges;
}

// ---------- big assemblies ----------

/** A part's surface mesh in its own coordinates. */
export type MeshOf = (hash: string) => { positions: Float32Array; indices: Uint32Array } | undefined;

/** Views of this many parts or more use the fast projection when meshes are at hand. */
export const FAST_ITEMS = 20;

/** Each part's own hidden-line result, by shape, turn and view, relative to where its origin projects. */
const ownCache = new Map<string, { edges: { vis: boolean; g: Prim2 }[]; used: number }>();
let ownTick = 0;

/**
 * Hidden lines for an assembly of many parts. Exact hidden-line removal over
 * all parts at once grows with every pair of them (minutes for a hundred);
 * here each part is projected exactly on its own, once per shape and turn
 * (screws repeated across the design cost one projection), and where parts
 * hide one another is read from a depth buffer of their meshes. Lines keep
 * their exact shape; only the point where one passes behind another part is
 * found to within a fraction of a millimetre.
 */
export function projectAssembly(req: ViewRequest, placed: Placed, meshOf: MeshOf): ViewResult {
  const t0 = performance.now();
  const dir = vnorm(req.dir);
  const xAxis = vnorm(req.x);
  const yAxis = vcross(dir, xAxis);
  const missing: number[] = [];
  let probes: number[] | undefined;
  const own: Edge2[] = [];
  const poses: { part: number; o: V3; lin: [V3, V3, V3]; hash: string }[] = [];
  req.items.forEach((it, part) => {
    let w: Shape3D;
    try {
      w = placed(it).shape;
    } catch {
      missing.push(part);
      return;
    }
    if (part === 0 && req.probes?.length) probes = req.probes.map((s) => materialAlong(w, s.a, s.b));
    const o = applyXforms([0, 0, 0], it.xf);
    const lin = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as V3[]).map((e) => vsub(applyXforms(e, it.xf), o)) as [V3, V3, V3];
    const key = [it.hash, lin.flat().map((v) => v.toFixed(6)).join(","), dir.map((v) => v.toFixed(6)).join(","), xAxis.map((v) => v.toFixed(6)).join(","), req.hidden ? "h" : ""].join("|");
    const ou = vdot(o, xAxis);
    const ov = vdot(o, yAxis);
    let hit = ownCache.get(key);
    if (!hit) {
      const edges = hlrEdges([{ part: 0, shape: w }], dir, xAxis, req.hidden).map((e) => ({ vis: e.vis, g: shift(e.g, -ou, -ov) }));
      hit = { edges, used: 0 };
      ownCache.set(key, hit);
      if (ownCache.size > 3000) {
        const old = [...ownCache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 1000);
        for (const [k] of old) ownCache.delete(k);
      }
    }
    hit.used = ++ownTick;
    for (const e of hit.edges) own.push({ part, vis: e.vis, g: shift(e.g, ou, ov) });
    poses.push({ part, o, lin, hash: it.hash });
  });

  const depth = depthBuffer(poses, meshOf, dir, xAxis, yAxis);
  const edges: Edge2[] = [];
  for (const e of own) {
    if (!e.vis || !depth) {
      edges.push(e);
      continue;
    }
    for (const run of splitByVisibility(e.g, depth.step, (u, v) => depth.visible(u, v, e.part))) {
      if (run.vis) edges.push({ part: e.part, vis: true, g: run.g });
      else if (req.hidden) edges.push({ part: e.part, vis: false, g: run.g });
    }
  }
  return { edges, hatch: [], probes, missing: missing.length ? missing : undefined, ms: performance.now() - t0 };
}

function shift(g: Prim2, du: number, dv: number): Prim2 {
  if (g.t === "L") return { t: "L", p: [g.p[0] + du, g.p[1] + dv, g.p[2] + du, g.p[3] + dv] };
  if (g.t === "A") return { ...g, c: [g.c[0] + du, g.c[1] + dv] };
  return { t: "P", p: g.p.map((x, i) => x + (i % 2 ? dv : du)) };
}

/** How near the viewer the nearest surface is across the view, and which part it belongs to. */
interface DepthBuffer {
  /** sample spacing along edges, model mm */
  step: number;
  visible: (u: number, v: number, part: number) => boolean;
}

/** Depths closer than this to the front surface count as on it: the meshes stand off the true surfaces by up to their 0.25 mm deflection. */
const DEPTH_EPS = 0.6;

function depthBuffer(poses: { part: number; o: V3; lin: [V3, V3, V3]; hash: string }[], meshOf: MeshOf, dir: V3, xAxis: V3, yAxis: V3): DepthBuffer | null {
  // every part's triangles in view space: u, v and depth toward the viewer
  const tris: number[] = [];
  const triPart: number[] = [];
  /** each part's nearest point to the viewer */
  const front = new Map<number, number>();
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const p of poses) {
    let m: ReturnType<MeshOf>;
    try {
      m = meshOf(p.hash);
    } catch {
      m = undefined;
    }
    if (!m) return null;
    const P = m.positions;
    const proj = new Float64Array((P.length / 3) * 3);
    for (let i = 0; i < P.length; i += 3) {
      const w: V3 = [p.o[0] + P[i] * p.lin[0][0] + P[i + 1] * p.lin[1][0] + P[i + 2] * p.lin[2][0], p.o[1] + P[i] * p.lin[0][1] + P[i + 1] * p.lin[1][1] + P[i + 2] * p.lin[2][1], p.o[2] + P[i] * p.lin[0][2] + P[i + 1] * p.lin[1][2] + P[i + 2] * p.lin[2][2]];
      const u = vdot(w, xAxis);
      const v = vdot(w, yAxis);
      proj[i] = u;
      proj[i + 1] = v;
      proj[i + 2] = vdot(w, dir);
      if (!(proj[i + 2] <= (front.get(p.part) ?? -Infinity))) front.set(p.part, proj[i + 2]);
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const I = m.indices;
    for (let k = 0; k < I.length; k += 3) {
      for (const j of [I[k], I[k + 1], I[k + 2]]) tris.push(proj[j * 3], proj[j * 3 + 1], proj[j * 3 + 2]);
      triPart.push(p.part);
    }
  }
  if (!triPart.length || !Number.isFinite(u0)) return null;
  // about 2000 pixels across the bigger side, none finer than 0.2 mm (the meshes are only good to 0.25 mm)
  const span = Math.max(u1 - u0, v1 - v0, 1e-3);
  const px = Math.max(span / 2000, 0.2);
  const pad = 4;
  const W = Math.ceil((u1 - u0) / px) + 2 * pad;
  const H = Math.ceil((v1 - v0) / px) + 2 * pad;
  const ox = u0 - pad * px;
  const oy = v0 - pad * px;
  const zbuf = new Float32Array(W * H).fill(-Infinity);
  const ids = new Int32Array(W * H).fill(-1);
  // triangles by grid cell, for finding a part's own depth at a point
  const CELL = 8;
  const GW = Math.ceil(W / CELL);
  const GH = Math.ceil(H / CELL);
  const cells: number[][] = Array.from({ length: GW * GH }, () => []);
  const n = triPart.length;
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const ax = (tris[b] - ox) / px;
    const ay = (tris[b + 1] - oy) / px;
    const bx = (tris[b + 3] - ox) / px;
    const by = (tris[b + 4] - oy) / px;
    const cx = (tris[b + 6] - ox) / px;
    const cy = (tris[b + 7] - oy) / px;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const xa = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const xb = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const ya = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const yb = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let gy = Math.floor(ya / CELL); gy <= Math.floor(yb / CELL); gy++) for (let gx = Math.floor(xa / CELL); gx <= Math.floor(xb / CELL); gx++) cells[gy * GW + gx].push(t);
    if (Math.abs(area) < 1e-12) continue;
    const da = tris[b + 2];
    const db = tris[b + 5];
    const dc = tris[b + 8];
    const part = triPart[t];
    for (let y = ya; y <= yb; y++) {
      const py = y + 0.5;
      for (let x = xa; x <= xb; x++) {
        const qx = x + 0.5;
        const w0 = ((bx - qx) * (cy - py) - (by - py) * (cx - qx)) / area;
        const w1 = ((cx - qx) * (ay - py) - (cy - py) * (ax - qx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * da + w1 * db + w2 * dc;
        const k = y * W + x;
        if (d > zbuf[k]) {
          zbuf[k] = d;
          ids[k] = part;
        }
      }
    }
  }
  /** the nearest depth of one part's own surface around a pixel, from its triangles */
  const ownDepth = (x: number, y: number, part: number, r: number): number | undefined => {
    let best: number | undefined;
    const seen = new Set<number>();
    for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy++)
      for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx++) {
        if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
        for (const t of cells[gy * GW + gx]) {
          if (triPart[t] !== part || seen.has(t)) continue;
          seen.add(t);
          const b = t * 9;
          const ax = (tris[b] - ox) / px;
          const ay = (tris[b + 1] - oy) / px;
          const bx = (tris[b + 3] - ox) / px;
          const by = (tris[b + 4] - oy) / px;
          const cx = (tris[b + 6] - ox) / px;
          const cy = (tris[b + 7] - oy) / px;
          const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          if (Math.abs(area) < 1e-12) continue;
          // the point, or the nearest point of the triangle within r pixels
          let w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
          let w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
          let w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) {
            const q = nearestOnTri(x, y, ax, ay, bx, by, cx, cy);
            if (Math.hypot(q[0] - x, q[1] - y) > r) continue;
            w0 = ((bx - q[0]) * (cy - q[1]) - (by - q[1]) * (cx - q[0])) / area;
            w1 = ((cx - q[0]) * (ay - q[1]) - (cy - q[1]) * (ax - q[0])) / area;
            w2 = 1 - w0 - w1;
          }
          const d = w0 * tris[b + 2] + w1 * tris[b + 5] + w2 * tris[b + 8];
          if (best === undefined || d > best) best = d;
        }
      }
    return best;
  };
  // the meshes stand off the true outlines by up to their deflection: look that far around
  const R = Math.max(1, Math.ceil(0.3 / px));
  const owns = new Map<number, number | undefined>();
  const visible = (u: number, v: number, part: number): boolean => {
    const x = (u - ox) / px;
    const y = (v - oy) / px;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return true;
    const c = ids[yi * W + xi];
    if (c === part || c < 0) return true;
    let nearest = Infinity;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const xx = xi + dx;
        const yy = yi + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) return true;
        const k = yy * W + xx;
        // its own surface or open background beside the line: nothing covers it there
        if (ids[k] === part || ids[k] < 0) return true;
        nearest = Math.min(nearest, zbuf[k]);
      }
    // other parts all round: hidden when they are nearer the viewer than any of this part is, else than it is there
    if (nearest > (front.get(part) ?? Infinity) + DEPTH_EPS) return false;
    const key = (yi * W + xi) * 4096 + (part % 4096);
    let own = owns.get(key);
    if (!owns.has(key)) owns.set(key, (own = ownDepth(xi + 0.5, yi + 0.5, part, R + 1)));
    return own === undefined || nearest <= own + DEPTH_EPS;
  };
  return { step: px, visible };
}

function nearestOnTri(x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): [number, number] {
  let best: [number, number] = [ax, ay];
  let bd = Infinity;
  for (const [p0x, p0y, p1x, p1y] of [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay],
  ]) {
    const ex = p1x - p0x;
    const ey = p1y - p0y;
    const L = ex * ex + ey * ey;
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - p0x) * ex + (y - p0y) * ey) / L)) : 0;
    const qx = p0x + ex * t;
    const qy = p0y + ey * t;
    const d = Math.hypot(qx - x, qy - y);
    if (d < bd) {
      bd = d;
      best = [qx, qy];
    }
  }
  return best;
}

/** Splits a line, arc or polyline where it passes behind something, sampling every `step` along it. */
export function splitByVisibility(g: Prim2, step: number, vis: (u: number, v: number) => boolean): { vis: boolean; g: Prim2 }[] {
  // sample parameters along the primitive, then runs of equal visibility, with single-sample flickers smoothed out
  const runs = (n: number, at: (i: number) => [number, number]) => {
    const flags: boolean[] = [];
    for (let i = 0; i <= n; i++) {
      const [u, v] = at(i);
      flags.push(vis(u, v));
    }
    for (let i = 1; i < n; i++) if (flags[i - 1] === flags[i + 1] && flags[i] !== flags[i - 1]) flags[i] = flags[i - 1];
    // a change of visibility falls halfway between its samples
    const out: { vis: boolean; i0: number; i1: number }[] = [];
    let start = 0;
    for (let i = 1; i <= n; i++)
      if (flags[i] !== flags[i - 1]) {
        out.push({ vis: flags[i - 1], i0: start, i1: i - 0.5 });
        start = i - 0.5;
      }
    out.push({ vis: flags[n], i0: start, i1: n });
    return out;
  };
  if (g.t === "L") {
    const [x0, y0, x1, y1] = g.p;
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.min(20000, Math.ceil(L / step)));
    const at = (i: number): [number, number] => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n];
    const rs = runs(n, at);
    if (rs.length === 1) return [{ vis: rs[0].vis, g }];
    return rs.map((r) => {
      const a = at(r.i0);
      const b = at(r.i1);
      return { vis: r.vis, g: { t: "L", p: [a[0], a[1], b[0], b[1]] } as Prim2 };
    });
  }
  if (g.t === "A") {
    const sweep = g.a1 - g.a0;
    const n = Math.max(4, Math.min(20000, Math.ceil((sweep * g.r) / step)));
    const ang = (i: number) => g.a0 + (sweep * i) / n;
    const rs = runs(n, (i) => [g.c[0] + g.r * Math.cos(ang(i)), g.c[1] + g.r * Math.sin(ang(i))]);
    if (rs.length === 1) return [{ vis: rs[0].vis, g }];
    return rs.map((r) => ({ vis: r.vis, g: { t: "A", c: g.c, r: g.r, a0: ang(r.i0), a1: ang(r.i1) } as Prim2 }));
  }
  // a polyline: resample each segment, keeping its corners
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < g.p.length; i += 2) {
    const q: [number, number] = [g.p[i], g.p[i + 1]];
    if (pts.length) {
      const p = pts[pts.length - 1];
      const k = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
      for (let j = 1; j < k; j++) pts.push([p[0] + ((q[0] - p[0]) * j) / k, p[1] + ((q[1] - p[1]) * j) / k]);
    }
    pts.push(q);
  }
  if (pts.length < 2) return [{ vis: true, g }];
  const rs = runs(pts.length - 1, (i) => pts[i]);
  if (rs.length === 1) return [{ vis: rs[0].vis, g }];
  const lerp = (t: number): [number, number] => {
    const i = Math.min(pts.length - 2, Math.floor(t));
    const f = t - i;
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
  };
  return rs.map((r) => {
    const seg: number[] = [...lerp(r.i0)];
    for (let i = Math.ceil(r.i0 + 1e-9); i < r.i1; i++) seg.push(...pts[i]);
    seg.push(...lerp(r.i1));
    return { vis: r.vis, g: (seg.length === 4 ? { t: "L", p: seg } : { t: "P", p: seg }) as Prim2 };
  });
}

/** Length of solid material along a segment: the common of the solid and a line edge. */
function materialAlong(w: Shape3D, a: V3, b: V3): number {
  const O = oc();
  let edge: Edge | null = null;
  let common: Record<string, (...a: unknown[]) => unknown> | null = null;
  let comp: R.Compound | null = null;
  try {
    edge = R.makeLine(a, b);
    common = new O.BRepAlgoAPI_Common(w.wrapped, edge.wrapped);
    common.Build();
    comp = new R.Compound(common.Shape() as never);
    let len = 0;
    for (const e of comp.edges) {
      len += e.length;
      free(e);
    }
    return len;
  } catch {
    return NaN;
  } finally {
    free(comp);
    free(common);
    free(edge);
  }
}

const TAU = Math.PI * 2;

/** Converts a projected edge (lying in z = 0 of the projector frame) to a 2D primitive. */
function edgePrim(e: Edge): Prim2 | null {
  const O = oc();
  const ad = new O.BRepAdaptor_Curve(e.wrapped);
  try {
    const f = ad.FirstParameter() as number;
    const l = ad.LastParameter() as number;
    const at = (t: number): [number, number] => {
      const p = ad.Value(t) as { X(): number; Y(): number; delete(): void };
      const out: [number, number] = [p.X(), p.Y()];
      p.delete();
      return out;
    };
    const type = e.geomType;
    if (type === "LINE") {
      const a = at(f);
      const b = at(l);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) return null;
      return { t: "L", p: [a[0], a[1], b[0], b[1]] };
    }
    if (type === "CIRCLE") {
      const circ = ad.Circle() as { Location(): { X(): number; Y(): number; delete(): void }; Radius(): number; delete(): void };
      const loc = circ.Location();
      const c: [number, number] = [loc.X(), loc.Y()];
      const r = circ.Radius();
      loc.delete();
      circ.delete();
      if (l - f >= TAU - 1e-7) return { t: "A", c, r, a0: 0, a1: TAU };
      const ang = (p: [number, number]) => Math.atan2(p[1] - c[1], p[0] - c[0]);
      let a0 = ang(at(f));
      let a1 = ang(at(l));
      const am = ang(at((f + l) / 2));
      // orient counter-clockwise so the sweep from a0 passes through the midpoint
      const ccw = (from: number, to: number, x: number) => norm(x - from) <= norm(to - from);
      if (!ccw(a0, a1, am)) [a0, a1] = [a1, a0];
      a1 = a0 + norm(a1 - a0);
      return { t: "A", c, r, a0, a1 };
    }
    // everything else: an adaptive polyline, collapsed to a line when straight
    const coarse: [number, number][] = [];
    for (let i = 0; i <= 8; i++) coarse.push(at(f + ((l - f) * i) / 8));
    let len = 0;
    for (let i = 1; i < coarse.length; i++) len += Math.hypot(coarse[i][0] - coarse[i - 1][0], coarse[i][1] - coarse[i - 1][1]);
    if (len < 1e-6) return null;
    const n = Math.max(8, Math.min(256, Math.ceil(len / 0.35)));
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) pts.push(at(f + ((l - f) * i) / n));
    const s = simplify(pts, 0.004);
    if (s.length === 2) return { t: "L", p: [s[0][0], s[0][1], s[1][0], s[1][1]] };
    return { t: "P", p: s.flat() };
  } catch {
    return null;
  } finally {
    ad.delete();
  }
}

function norm(a: number) {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

/** Douglas–Peucker polyline simplification. */
export function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy) || 1e-12;
    let best = -1;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > best) {
        best = d;
        bi = i;
      }
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Boundary loops of a planar face, projected onto the view plane. */
function faceLoops(face: Face, x: V3, y: V3): number[][] {
  const segs: [number, number][][] = [];
  for (const e of face.edges) {
    const pts: [number, number][] = [];
    const type = e.geomType;
    const n = type === "LINE" ? 1 : Math.max(8, Math.min(128, Math.ceil(e.length / 0.4)));
    for (let i = 0; i <= n; i++) {
      const p = e.pointAt(i / n);
      const v: V3 = [p.x, p.y, p.z];
      p.delete();
      pts.push([vdot(v, x), vdot(v, y)]);
    }
    free(e);
    segs.push(pts);
  }
  return chainLoops(segs);
}

/** Joins polyline pieces end to end into closed loops. */
export function chainLoops(segs: [number, number][][], tol = 1e-3): number[][] {
  const left = segs.filter((s) => s.length >= 2);
  const loops: number[][] = [];
  const same = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  while (left.length) {
    const loop = left.shift()!.slice();
    let grew = true;
    while (grew && !same(loop[0], loop[loop.length - 1])) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const s = left[i];
        const end = loop[loop.length - 1];
        if (same(s[0], end)) loop.push(...s.slice(1));
        else if (same(s[s.length - 1], end)) loop.push(...s.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (loop.length >= 3) loops.push(loop.flat());
  }
  return loops;
}

// ---------- measuring ----------

export interface PickRef {
  hash: string;
  xf: Xform[];
  kind: "face" | "edge" | "vertex";
  /** face or edge id from the mesh groups (the OpenCASCADE hash code) */
  id?: number;
  /** picked point in world coordinates */
  point: V3;
}

export interface EntityInfo {
  kind: "face" | "edge" | "vertex";
  /** plane, cylinder, cone, sphere, torus, surface, line, circle, ellipse, curve, point */
  type: string;
  point: V3;
  area?: number;
  length?: number;
  normal?: V3;
  radius?: number;
  center?: V3;
  axis?: V3;
  /** line edges: direction */
  dir?: V3;
}

export interface PickMeasure {
  a: EntityInfo;
  b?: EntityInfo;
  distance?: number;
  p1?: V3;
  p2?: V3;
  /** angle between planes or lines, degrees */
  angle?: number;
  /** shortest distance between the axes (or centres) of round faces and edges */
  centerDistance?: number;
  /** the closest points on those axes, for dimensioning centre to centre */
  c1?: V3;
  c2?: V3;
}

/** How an entity is oriented: a plane by its normal, a line (or a round face's axis) by its direction. */
type Orientation = { kind: "plane" | "line"; v: V3 } | null;

function direction(e: EntityInfo): Orientation {
  if (e.kind === "face" && e.type === "plane" && e.normal) return { kind: "plane", v: e.normal };
  if (e.kind === "face" && (e.type === "cylinder" || e.type === "cone") && e.axis) return { kind: "line", v: e.axis };
  if (e.kind === "edge" && e.type === "line" && e.dir) return { kind: "line", v: e.dir };
  return null;
}

/**
 * The angle between two planes or two lines is the angle between their
 * normals or directions; a line meets a plane at 90° less the angle to its
 * normal. Always 0..90°.
 */
export function angleBetween(a: Orientation, b: Orientation): number | undefined {
  if (!a || !b) return undefined;
  const c = Math.min(1, Math.abs(vdot(vnorm(a.v), vnorm(b.v))));
  const deg = (Math.acos(c) * 180) / Math.PI;
  return a.kind === b.kind ? deg : 90 - deg;
}

/**
 * Closest points between the axes of two round entities (cylinder and cone
 * faces, circle edges) or their centres (spheres): parallel axes are measured
 * square to the axis, skew or crossing axes at their common perpendicular.
 */
export function closestOnAxes(A: EntityInfo, B: EntityInfo): [V3, V3] | null {
  if (!A.center || !B.center) return null;
  const pa = A.center;
  const pb = B.center;
  const da = A.axis ? vnorm(A.axis) : null;
  const db = B.axis ? vnorm(B.axis) : null;
  const w: V3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const at = (p: V3, d: V3, t: number): V3 => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
  if (da && db) {
    const n = vcross(da, db);
    const nn = vdot(n, n);
    if (nn < 1e-10) {
      // parallel: B's axis point level with A's centre
      return [pa, at(pb, da, -vdot(w, da))];
    }
    // closest points of two lines pa + s·da and pb + t·db
    const b = vdot(da, db);
    const d = vdot(da, w);
    const e = vdot(db, w);
    const den = 1 - b * b;
    const sa = (d - b * e) / den;
    const tb = (b * d - e) / den;
    return [at(pa, da, sa), at(pb, db, tb)];
  }
  if (da) return [at(pa, da, vdot(w, da)), pb];
  if (db) return [pa, at(pb, db, -vdot(w, db))];
  return [pa, pb];
}

type GetShape = (hash: string) => Shape3D | undefined;

export function measure(req: { a: PickRef; b?: PickRef }, get: GetShape): PickMeasure {
  const A = entity(req.a, get);
  try {
    if (!req.b) return { a: A.info };
    const B = entity(req.b, get);
    try {
      const out: PickMeasure = { a: A.info, b: B.info };
      const O = oc();
      const ds = new O.BRepExtrema_DistShapeShape();
      ds.LoadS1(A.shape.wrapped);
      ds.LoadS2(B.shape.wrapped);
      ds.Perform();
      if (ds.IsDone() && (ds.NbSolution() as number) > 0) {
        out.distance = ds.Value() as number;
        const p1 = ds.PointOnShape1(1) as { X(): number; Y(): number; Z(): number; delete(): void };
        const p2 = ds.PointOnShape2(1) as { X(): number; Y(): number; Z(): number; delete(): void };
        out.p1 = [p1.X(), p1.Y(), p1.Z()];
        out.p2 = [p2.X(), p2.Y(), p2.Z()];
        p1.delete();
        p2.delete();
      }
      ds.delete();
      const angle = angleBetween(direction(A.info), direction(B.info));
      if (angle !== undefined) out.angle = angle;
      const axes = closestOnAxes(A.info, B.info);
      if (axes) {
        out.centerDistance = Math.hypot(axes[1][0] - axes[0][0], axes[1][1] - axes[0][1], axes[1][2] - axes[0][2]);
        out.c1 = axes[0];
        out.c2 = axes[1];
      }
      return out;
    } finally {
      free(B.shape);
    }
  } finally {
    free(A.shape);
  }
}

function invertXf(p: V3, xf: Xform[]): V3 {
  let q = p;
  for (let i = xf.length - 1; i >= 0; i--) {
    const x = xf[i];
    if (x.op === "translate") q = [q[0] - x.v[0], q[1] - x.v[1], q[2] - x.v[2]];
    else if (x.op === "rotate") q = rotate(q, x.origin, x.axis, -x.angle);
    else q = reflect(q, x.origin, x.normal);
  }
  return q;
}

function rotate(p: V3, o: V3, axis: V3, deg: number): V3 {
  const k = vnorm(axis);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const v: V3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const kv = vcross(k, v);
  const kd = vdot(k, v);
  return [o[0] + v[0] * c + kv[0] * s + k[0] * kd * (1 - c), o[1] + v[1] * c + kv[1] * s + k[1] * kd * (1 - c), o[2] + v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}

/** Finds the picked sub-shape in the cached solid and places it in world coordinates. */
function entity(ref: PickRef, get: GetShape): { shape: AnyShape; info: EntityInfo } {
  if (ref.kind === "vertex") {
    const v = R.makeVertex(ref.point);
    return { shape: v, info: { kind: "vertex", type: "point", point: ref.point } };
  }
  const solid = get(ref.hash);
  if (!solid) throw new Error("That part is still building. Try again in a moment.");
  const local = invertXf(ref.point, ref.xf);
  const list: (Face | Edge)[] = ref.kind === "face" ? solid.faces : solid.edges;
  let hit = ref.id !== undefined ? list.find((s) => s.hashCode === ref.id) : undefined;
  if (!hit) {
    // ids change if the solid was rebuilt: fall back to the sub-shape nearest the picked point
    const v = R.makeVertex(local);
    let best = Infinity;
    for (const s of list) {
      const d = R.measureDistanceBetween(v, s);
      if (d < best) {
        best = d;
        hit = s;
      }
    }
    free(v);
  }
  if (!hit) throw new Error("Nothing was found under the cursor.");
  const placedShape = applyXf(hit.clone() as unknown as Shape3D, ref.xf) as unknown as Face | Edge;
  for (const s of list) if (s !== hit) free(s);
  free(hit);
  const info = ref.kind === "face" ? faceInfo(placedShape as Face, ref.point) : edgeInfo(placedShape as Edge, ref.point);
  return { shape: placedShape, info };
}

const pt = (p: { X(): number; Y(): number; Z(): number; delete?: () => void }): V3 => {
  const out: V3 = [p.X(), p.Y(), p.Z()];
  p.delete?.();
  return out;
};

function faceInfo(f: Face, point: V3): EntityInfo {
  const info: EntityInfo = { kind: "face", type: "surface", point };
  try {
    info.area = R.measureArea(f);
  } catch {
    /* optional */
  }
  const O = oc();
  const ad = new O.BRepAdaptor_Surface(f.wrapped, false);
  try {
    switch (f.geomType) {
      case "PLANE": {
        info.type = "plane";
        const n = f.normalAt(point);
        info.normal = [n.x, n.y, n.z];
        n.delete();
        break;
      }
      case "CYLINDRE": {
        info.type = "cylinder";
        const c = ad.Cylinder() as { Radius(): number; Axis(): { Location(): never; Direction(): never; delete(): void }; delete(): void };
        info.radius = c.Radius();
        const ax = c.Axis();
        info.center = pt(ax.Location());
        info.axis = pt(ax.Direction());
        ax.delete();
        c.delete();
        break;
      }
      case "CONE": {
        info.type = "cone";
        const c = ad.Cone() as { RefRadius(): number; SemiAngle(): number; Axis(): { Location(): never; Direction(): never; delete(): void }; delete(): void };
        info.radius = c.RefRadius();
        const ax = c.Axis();
        info.center = pt(ax.Location());
        info.axis = pt(ax.Direction());
        ax.delete();
        c.delete();
        break;
      }
      case "SPHERE": {
        info.type = "sphere";
        const s = ad.Sphere() as { Radius(): number; Location(): never; delete(): void };
        info.radius = s.Radius();
        info.center = pt(s.Location());
        s.delete();
        break;
      }
      case "TORUS":
        info.type = "torus";
        break;
    }
  } catch {
    /* keep what we have */
  } finally {
    ad.delete();
  }
  return info;
}

function edgeInfo(e: Edge, point: V3): EntityInfo {
  const info: EntityInfo = { kind: "edge", type: "curve", point };
  try {
    info.length = R.measureLength(e);
  } catch {
    /* optional */
  }
  const O = oc();
  const ad = new O.BRepAdaptor_Curve(e.wrapped);
  try {
    switch (e.geomType) {
      case "LINE": {
        info.type = "line";
        const a = e.startPoint;
        const b = e.endPoint;
        info.dir = vnorm([b.x - a.x, b.y - a.y, b.z - a.z]);
        a.delete();
        b.delete();
        break;
      }
      case "CIRCLE": {
        info.type = "circle";
        const c = ad.Circle() as { Radius(): number; Location(): never; Axis(): { Direction(): never; delete(): void }; delete(): void };
        info.radius = c.Radius();
        info.center = pt(c.Location());
        const ax = c.Axis();
        info.axis = pt(ax.Direction());
        ax.delete();
        c.delete();
        break;
      }
      case "ELLIPSE":
        info.type = "ellipse";
        break;
    }
  } catch {
    /* keep what we have */
  } finally {
    ad.delete();
  }
  return info;
}
