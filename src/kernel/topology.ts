// Picking edges and faces by meaning instead of by index. A part's named
// features (`add cylinder(...) as boss`) keep their tool solids; a face of the
// finished part belongs to a feature when it lies on that tool's surface.
// Edges are then described by the faces they join: `boss.root` is every edge
// between a boss face and a face of anything else. Convex and concave edges
// come from the face normals on either side.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type Sel, type V3 } from "./recipe";

export class SelectionError extends Error {}

export interface FeatureTools {
  name: string;
  /** "add", "cut", "intersect" or "body" */
  kind: string;
  tools: Shape3D[];
}

export type Convexity = "convex" | "concave" | "smooth" | "seam" | "open";

export interface EdgeInfo {
  a: V3;
  m: V3;
  b: V3;
  tangent: V3;
  kind: string;
  length: number;
  /** radius for circular edges */
  radius?: number;
  faces: number[];
  convexity: Convexity;
}

interface FaceSample {
  /** a few points on the surface, spread over the face */
  pts: V3[];
  normals: V3[];
  /** triangle centroids (just inside curved faces), for finding which way a face leaves an edge */
  cents: V3[];
  box: [V3, V3];
  kind: string;
}

const TOL = 1e-3;

function tuple(v: R.Vector): V3 {
  const t = v.toTuple();
  return [t[0], t[1], t[2]];
}

function boxOf(s: { boundingBox: R.BoundingBox }): [V3, V3] {
  const [a, b] = s.boundingBox.bounds;
  return [
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
  ];
}

function boxesTouch(a: [V3, V3], b: [V3, V3], pad: number) {
  for (let i = 0; i < 3; i++) if (a[1][i] + pad < b[0][i] || b[1][i] + pad < a[0][i]) return false;
  return true;
}

function inBox(p: V3, b: [V3, V3], pad: number) {
  for (let i = 0; i < 3; i++) if (p[i] < b[0][i] - pad || p[i] > b[1][i] + pad) return false;
  return true;
}

/** Edges and faces of one shape with lazily computed geometry. */
export class Topo {
  readonly faces: R.Face[];
  readonly edges: R.Edge[];
  readonly box: [V3, V3];
  private samples: (FaceSample | undefined)[] = [];
  private infos: (EdgeInfo | undefined)[] = [];
  private adjacency: number[][] | null = null;
  private meshed = false;
  private featureFaces = new Map<string, Set<number>>();
  private dist = new R.DistanceTool();

  constructor(
    readonly shape: Shape3D,
    readonly features: Map<string, FeatureTools>,
  ) {
    this.faces = shape.faces;
    this.edges = uniqueEdges(shape.edges);
    this.box = boxOf(shape);
  }

  dispose() {
    try {
      this.dist.delete();
    } catch {
      /* already freed */
    }
  }

  private ensureMesh() {
    if (this.meshed) return;
    this.meshed = true;
    // the same tolerances as preview meshes, so the display can reuse this triangulation
    R.getOC().ReplicadMeshExtractor.mesh(this.shape.wrapped, 0.25, (25 * Math.PI) / 180);
  }

  face(i: number): FaceSample {
    const hit = this.samples[i];
    if (hit) return hit;
    this.ensureMesh();
    const f = this.faces[i];
    const tri = f.triangulation();
    const pts: V3[] = [];
    const normals: V3[] = [];
    const cents: V3[] = [];
    if (tri && tri.trianglesIndexes.length) {
      const v = tri.vertices;
      const idx = tri.trianglesIndexes;
      const cands: { c: V3; n: V3; area: number }[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        const p0: V3 = [v[idx[t] * 3], v[idx[t] * 3 + 1], v[idx[t] * 3 + 2]];
        const p1: V3 = [v[idx[t + 1] * 3], v[idx[t + 1] * 3 + 1], v[idx[t + 1] * 3 + 2]];
        const p2: V3 = [v[idx[t + 2] * 3], v[idx[t + 2] * 3 + 1], v[idx[t + 2] * 3 + 2]];
        const cr = vcross(vsub(p1, p0), vsub(p2, p0));
        const area = vlen(cr) / 2;
        if (area < 1e-9) continue;
        cands.push({ c: vscale(vadd(vadd(p0, p1), p2), 1 / 3), n: vnorm(cr), area });
      }
      cents.push(...cands.slice(0, 400).map((c) => c.c));
      // the largest triangles spread across the face
      cands.sort((a, b) => b.area - a.area);
      for (const c of cands.slice(0, 7)) {
        pts.push(this.project(f, c.c));
        normals.push(c.n);
      }
    }
    if (!pts.length) {
      pts.push(tuple(f.center));
      normals.push(vnorm(tuple(f.normalAt())));
    }
    if (!cents.length) cents.push(...pts);
    const s: FaceSample = { pts, normals, cents, box: boxOf(f), kind: String(f.geomType) };
    this.samples[i] = s;
    return s;
  }

  /** Move a point (a triangle centroid, slightly inside a curved face) onto the face's surface. */
  private project(f: R.Face, p: V3): V3 {
    try {
      const [u, v] = f.uvCoordinates(p);
      const b = f.UVBounds;
      const du = b.uMax - b.uMin;
      const dv = b.vMax - b.vMin;
      if (!(du > 0) || !(dv > 0)) return p;
      return tuple(f.pointOnSurface((u - b.uMin) / du, (v - b.vMin) / dv));
    } catch {
      return p;
    }
  }

  private adj(): number[][] {
    if (this.adjacency) return this.adjacency;
    const byHash = new Map<number, number[]>();
    this.edges.forEach((e, i) => byHash.set(e.hashCode, [...(byHash.get(e.hashCode) ?? []), i]));
    const out: number[][] = this.edges.map(() => []);
    this.faces.forEach((f, fi) => {
      for (const e of f.edges) {
        const cands = byHash.get(e.hashCode) ?? [];
        const ei = cands.length === 1 ? cands[0] : cands.find((c) => this.edges[c].isSame(e));
        if (ei !== undefined) out[ei].push(fi);
      }
    });
    this.adjacency = out;
    return out;
  }

  edge(i: number): EdgeInfo {
    const hit = this.infos[i];
    if (hit) return hit;
    const e = this.edges[i];
    const a = tuple(e.startPoint);
    const b = tuple(e.endPoint);
    const m = tuple(e.pointAt(0.5));
    const tangent = vnorm(tuple(e.tangentAt(0.5)));
    const kind = String(e.geomType);
    let radius: number | undefined;
    if (kind === "CIRCLE") radius = circumradius(a, tuple(e.pointAt(1 / 3)), tuple(e.pointAt(2 / 3)));
    const faces = this.adj()[i];
    const info: EdgeInfo = { a, m, b, tangent, kind, length: e.length, radius, faces, convexity: "open" };
    info.convexity = this.convexity(info);
    this.infos[i] = info;
    return info;
  }

  private convexity(e: EdgeInfo): Convexity {
    const fs = [...new Set(e.faces)];
    if (e.faces.length >= 2 && fs.length === 1) return "seam";
    if (fs.length !== 2) return "open";
    const [f1, f2] = fs;
    const n1 = this.normalNear(f1, e.m);
    const n2 = this.normalNear(f2, e.m);
    if (vdot(n1, n2) > Math.cos((12 * Math.PI) / 180)) return "smooth";
    // which way does the second face leave the edge, relative to the first face's outside?
    const c2 = this.nearestSample(f2, e.m);
    let d = vsub(c2, e.m);
    d = vsub(d, vscale(e.tangent, vdot(d, e.tangent)));
    const side = vdot(d, n1);
    const c1 = this.nearestSample(f1, e.m);
    let d1 = vsub(c1, e.m);
    d1 = vsub(d1, vscale(e.tangent, vdot(d1, e.tangent)));
    const side1 = vdot(d1, n2);
    const s = side + side1;
    return s < 0 ? "convex" : "concave";
  }

  private normalNear(fi: number, p: V3): V3 {
    try {
      return vnorm(tuple(this.faces[fi].normalAt(p)));
    } catch {
      const s = this.face(fi);
      let best = 0;
      let bd = Infinity;
      s.pts.forEach((q, k) => {
        const d = vlen(vsub(q, p));
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      return s.normals[best];
    }
  }

  private nearestSample(fi: number, p: V3): V3 {
    const s = this.face(fi);
    let best = s.cents[0];
    let bd = Infinity;
    for (const q of s.cents) {
      const d = vlen(vsub(q, p));
      if (d < bd && d > 1e-6) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  /** Faces of the shape that lie on the named feature's tool surfaces. */
  featureFaceSet(name: string): Set<number> {
    const hit = this.featureFaces.get(name);
    if (hit) return hit;
    const feat = this.features.get(name);
    if (!feat) throw new SelectionError(`no feature named "${name}" in this part (name one with: add ... as ${name})`);
    const out = new Set<number>();
    for (const tool of feat.tools) {
      const tb = boxOf(tool);
      const tfaces = R.makeCompound(tool.faces);
      this.faces.forEach((_, fi) => {
        if (out.has(fi)) return;
        const s = this.face(fi);
        if (!boxesTouch(s.box, tb, TOL * 10)) return;
        const probe = s.pts;
        let on = 0;
        for (const p of probe) {
          if (!inBox(p, tb, TOL * 10)) continue;
          const v = R.makeVertex(p);
          const d = this.dist.distanceBetween(v, tfaces);
          v.delete();
          if (d < TOL) on++;
        }
        if (on * 2 > probe.length) out.add(fi);
      });
      tfaces.delete();
    }
    this.featureFaces.set(name, out);
    return out;
  }

  /** Which named features a face belongs to. */
  featuresOfFace(fi: number): string[] {
    return [...this.features.keys()].filter((n) => this.featureFaceSet(n).has(fi));
  }

  // ---------- selection ----------

  selectEdges(sel: Sel): Set<number> {
    const all = this.edges.map((_, i) => i);
    const pick = (f: (i: number) => boolean) => new Set(all.filter(f));
    const sharp = (i: number) => {
      const c = this.edge(i).convexity;
      return c === "convex" || c === "concave";
    };
    if (typeof sel === "string") {
      const [lo, hi] = this.box;
      switch (sel) {
        case "all":
          return pick((i) => this.edge(i).convexity !== "seam");
        case "vertical":
          return pick((i) => this.edge(i).kind === "LINE" && Math.abs(this.edge(i).tangent[2]) > 0.999);
        case "horizontal":
          return pick((i) => {
            const e = this.edge(i);
            return Math.abs(e.a[2] - e.b[2]) < TOL && Math.abs(e.m[2] - e.a[2]) < TOL && e.convexity !== "seam";
          });
        case "top":
          return pick((i) => [this.edge(i).a, this.edge(i).m, this.edge(i).b].every((p) => Math.abs(p[2] - hi[2]) < TOL));
        case "bottom":
          return pick((i) => [this.edge(i).a, this.edge(i).m, this.edge(i).b].every((p) => Math.abs(p[2] - lo[2]) < TOL));
        case "convex":
          return pick((i) => this.edge(i).convexity === "convex");
        case "concave":
          return pick((i) => this.edge(i).convexity === "concave");
        case "sharp":
          return pick(sharp);
      }
    }
    switch (sel.s) {
      case "feat": {
        const ff = this.featureFaceSet(sel.f);
        return pick((i) => {
          const fs = [...new Set(this.edge(i).faces)];
          const n = fs.filter((f) => ff.has(f)).length;
          if (sel.part === "root") return n === 1 && fs.length === 2;
          if (sel.part === "tip") return n === 2 && this.edge(i).convexity !== "seam" && this.edge(i).convexity !== "smooth";
          return n >= 1 && this.edge(i).convexity !== "seam";
        });
      }
      case "between": {
        const fa = this.featureFaceSet(sel.a);
        const fb = this.featureFaceSet(sel.b);
        return pick((i) => {
          const fs = [...new Set(this.edge(i).faces)];
          return fs.length === 2 && ((fa.has(fs[0]) && fb.has(fs[1])) || (fa.has(fs[1]) && fb.has(fs[0])));
        });
      }
      case "near": {
        const v = R.makeVertex(sel.p);
        const out = pick((i) => {
          const e = this.edge(i);
          if (e.convexity === "seam") return false;
          const eb = boxOfPts([e.a, e.m, e.b]);
          if (!inBox(sel.p, eb, sel.r + e.length)) return false;
          return this.dist.distanceBetween(v, this.edges[i]) <= sel.r + TOL;
        });
        v.delete();
        return out;
      }
      case "plane": {
        const n = vnorm(sel.n);
        return pick((i) => {
          const e = this.edge(i);
          return [e.a, e.m, e.b].every((p) => Math.abs(vdot(p, n) - sel.d) < TOL) && e.convexity !== "seam";
        });
      }
      case "along": {
        const d = vnorm(sel.d);
        return pick((i) => this.edge(i).kind === "LINE" && Math.abs(vdot(this.edge(i).tangent, d)) > 0.999);
      }
      case "facing": {
        const ff = this.selectFaces(sel);
        return pick((i) => this.edge(i).faces.some((f) => ff.has(f)) && this.edge(i).convexity !== "seam");
      }
      case "circle":
        return pick((i) => {
          const e = this.edge(i);
          return e.kind === "CIRCLE" && (sel.d <= 0 || Math.abs((e.radius ?? 0) * 2 - sel.d) < 0.01);
        });
      case "box":
        return pick((i) => [this.edge(i).a, this.edge(i).m, this.edge(i).b].every((p) => inBox(p, [sel.lo, sel.hi], TOL)) && this.edge(i).convexity !== "seam");
      case "or": {
        const out = new Set<number>();
        for (const s of sel.a) for (const i of this.selectEdges(s)) out.add(i);
        return out;
      }
      case "and": {
        let out: number[] | null = null;
        for (const s of sel.a) {
          const next = this.selectEdges(s);
          out = out === null ? [...next] : out.filter((i: number) => next.has(i));
        }
        return new Set(out ?? []);
      }
      case "minus": {
        const a = this.selectEdges(sel.a);
        const b = this.selectEdges(sel.b);
        return new Set([...a].filter((i) => !b.has(i)));
      }
    }
  }

  selectFaces(sel: Sel): Set<number> {
    const all = this.faces.map((_, i) => i);
    const pick = (f: (i: number) => boolean) => new Set(all.filter(f));
    const planarNormal = (i: number): V3 | null => {
      const s = this.face(i);
      if (s.kind !== "PLANE") return null;
      return s.normals[0];
    };
    if (typeof sel === "string") {
      const [lo, hi] = this.box;
      switch (sel) {
        case "all":
          return pick(() => true);
        case "top":
          return pick((i) => this.face(i).pts.every((p) => Math.abs(p[2] - hi[2]) < TOL));
        case "bottom":
          return pick((i) => this.face(i).pts.every((p) => Math.abs(p[2] - lo[2]) < TOL));
        case "vertical":
          // faces a vertical pull would slide along: planar walls, and cylinders or cones around a vertical axis
          return pick((i) => this.face(i).normals.every((n) => Math.abs(n[2]) < 0.02));
        case "horizontal":
          return pick((i) => {
            const n = planarNormal(i);
            return !!n && Math.abs(n[2]) > 0.999;
          });
        default: {
          const es = this.selectEdges(sel);
          return pick((i) => [...es].some((e) => this.edge(e).faces.includes(i)));
        }
      }
    }
    switch (sel.s) {
      case "feat": {
        const ff = this.featureFaceSet(sel.f);
        if (sel.part === "faces" || sel.part === "edges") return new Set(ff);
        const es = this.selectEdges(sel);
        return pick((i) => ff.has(i) && [...es].some((e) => this.edge(e).faces.includes(i)));
      }
      case "between": {
        const es = this.selectEdges(sel);
        return pick((i) => [...es].some((e) => this.edge(e).faces.includes(i)));
      }
      case "near": {
        const v = R.makeVertex(sel.p);
        const out = pick((i) => {
          const s = this.face(i);
          if (!inBox(sel.p, s.box, sel.r)) return false;
          return this.dist.distanceBetween(v, this.faces[i]) <= sel.r + TOL;
        });
        v.delete();
        return out;
      }
      case "plane": {
        const n = vnorm(sel.n);
        return pick((i) => this.face(i).pts.every((p) => Math.abs(vdot(p, n) - sel.d) < TOL));
      }
      case "facing": {
        const d = vnorm(sel.d);
        return pick((i) => {
          const n = planarNormal(i);
          return !!n && vdot(n, d) > 0.999;
        });
      }
      case "along": {
        const d = vnorm(sel.d);
        return pick((i) => this.face(i).normals.every((n) => Math.abs(vdot(n, d)) < 0.02));
      }
      case "circle":
        return pick((i) => {
          const s = this.face(i);
          if (s.kind !== "CYLINDER") return false;
          if (sel.d <= 0) return true;
          const es = this.adj()
            .map((fs, ei) => (fs.includes(i) ? ei : -1))
            .filter((ei) => ei >= 0 && this.edge(ei).kind === "CIRCLE");
          return es.some((ei) => Math.abs((this.edge(ei).radius ?? 0) * 2 - sel.d) < 0.01);
        });
      case "box":
        return pick((i) => this.face(i).pts.every((p) => inBox(p, [sel.lo, sel.hi], TOL)));
      case "or": {
        const out = new Set<number>();
        for (const s of sel.a) for (const i of this.selectFaces(s)) out.add(i);
        return out;
      }
      case "and": {
        let out: number[] | null = null;
        for (const s of sel.a) {
          const next = this.selectFaces(s);
          out = out === null ? [...next] : out.filter((i: number) => next.has(i));
        }
        return new Set(out ?? []);
      }
      case "minus": {
        const a = this.selectFaces(sel.a);
        const b = this.selectFaces(sel.b);
        return new Set([...a].filter((i) => !b.has(i)));
      }
    }
  }

  /** The outermost planar face whose outward normal points along dir (shell's open: Z). */
  outermostFace(dir: V3): number | undefined {
    const d = vnorm(dir);
    let best: number | undefined;
    let bestH = -Infinity;
    this.faces.forEach((_, i) => {
      const s = this.face(i);
      if (s.kind !== "PLANE" || vdot(s.normals[0], d) < 0.999) return;
      const h = vdot(s.pts[0], d);
      if (h > bestH + TOL) {
        bestH = h;
        best = i;
      }
    });
    return best;
  }
}

function boxOfPts(pts: V3[]): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  return [lo, hi];
}

function uniqueEdges(edges: R.Edge[]): R.Edge[] {
  const out: R.Edge[] = [];
  const byHash = new Map<number, R.Edge[]>();
  for (const e of edges) {
    const same = byHash.get(e.hashCode);
    if (same?.some((x) => x.isSame(e))) continue;
    byHash.set(e.hashCode, [...(same ?? []), e]);
    out.push(e);
  }
  return out;
}

function circumradius(a: V3, b: V3, c: V3): number {
  const ab = vlen(vsub(a, b));
  const bc = vlen(vsub(b, c));
  const ca = vlen(vsub(c, a));
  const area = vlen(vcross(vsub(b, a), vsub(c, a))) / 2;
  if (area < 1e-12) return 0;
  return (ab * bc * ca) / (4 * area);
}

/** Human-readable description of a selector, for messages. */
export function describeSel(sel: Sel): string {
  if (typeof sel === "string") return `"${sel}"`;
  const p3 = (p: V3) => `(${p.map((x) => Math.round(x * 100) / 100).join(", ")})`;
  switch (sel.s) {
    case "feat":
      return `${sel.f}.${sel.part}`;
    case "between":
      return `between(${sel.a}, ${sel.b})`;
    case "near":
      return `near(${p3(sel.p)}, ${sel.r})`;
    case "plane":
      return `in_plane(${p3(sel.n)}, ${sel.d})`;
    case "along":
      return `along(${p3(sel.d)})`;
    case "facing":
      return `facing(${p3(sel.d)})`;
    case "circle":
      return sel.d > 0 ? `circles(${sel.d})` : "circles()";
    case "box":
      return `inside(${p3(sel.lo)}, ${p3(sel.hi)})`;
    case "or":
      return sel.a.map(describeSel).join(" + ");
    case "and":
      return sel.a.map(describeSel).join(" & ");
    case "minus":
      return `${describeSel(sel.a)} - ${describeSel(sel.b)}`;
  }
}
