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
  readonly length: number;
  /** radius for circular edges */
  radius?: number;
  faces: number[];
  readonly convexity: Convexity;
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

interface ToolFace {
  face: R.Face;
  box: [V3, V3];
  kind: string;
  plane?: { n: V3; d: number };
}

/** Plane equation n·p = d of a planar face (the sign of n is not meaningful). */
function planeOfFace(f: R.Face): { n: V3; d: number } | undefined {
  if (String(f.geomType) !== "PLANE") return undefined;
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Surface(f.wrapped, false);
  try {
    const pl = ad.Plane();
    const ax = pl.Axis();
    const dir = ax.Direction();
    const loc = pl.Location();
    const n: V3 = [dir.X(), dir.Y(), dir.Z()];
    const p: V3 = [loc.X(), loc.Y(), loc.Z()];
    for (const o of [pl, ax, dir, loc]) o.delete();
    return { n, d: vdot(n, p) };
  } catch {
    return undefined;
  } finally {
    ad.delete();
  }
}

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
  private featureFaces = new Map<string, Map<number, boolean>>();
  private toolCache = new Map<string, ToolFace[]>();
  private quick: ({ kind: string; box: [V3, V3]; plane?: { n: V3; d: number } } | undefined)[] = [];
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

  /** Triangulate one face (the same tolerances as preview meshes, so a later display mesh reuses it). */
  private ensureMesh(f: R.Face) {
    const m = new (R.getOC().BRepMesh_IncrementalMesh)(f.wrapped, 0.25, false, (25 * Math.PI) / 180, false);
    m.delete();
  }

  face(i: number): FaceSample {
    const hit = this.samples[i];
    if (hit) return hit;
    const f = this.faces[i];
    this.ensureMesh(f);
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
      // centroids of flat triangles already lie on a plane; curved faces need them moved onto the surface
      const flat = String(f.geomType) === "PLANE";
      for (const c of cands.slice(0, 5)) {
        pts.push(flat ? c.c : this.project(f, c.c));
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
    // length and convexity are slower to work out, so they wait until asked for
    let conv: Convexity | undefined;
    let len: number | undefined;
    const convexity = (info: EdgeInfo) => this.convexity(info);
    const info: EdgeInfo = {
      a,
      m,
      b,
      tangent,
      kind,
      get length() {
        return (len ??= e.length);
      },
      radius,
      faces,
      get convexity() {
        return (conv ??= convexity(info));
      },
    };
    this.infos[i] = info;
    return info;
  }

  /** A seam joins a face to itself (the line down the side of a cylinder). */
  isSeam(i: number): boolean {
    const fs = this.adj()[i];
    return fs.length >= 2 && new Set(fs).size === 1;
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
    const side = vdot(this.intoFace(f2, n2, e), n1);
    const side1 = vdot(this.intoFace(f1, n1, e), n2);
    const s = side + side1;
    return s < 0 ? "convex" : "concave";
  }

  /** The direction from the edge's midpoint into face fi, square to the edge. */
  private intoFace(fi: number, n: V3, e: EdgeInfo): V3 {
    // a step along the face either way from the edge: the one that lands on the face is the way in
    const w = vnorm(vcross(n, e.tangent));
    if (vlen(w) > 0.5) {
      const step = 0.02;
      const off = (sign: number) => {
        const v = R.makeVertex(vadd(e.m, vscale(w, sign * step)));
        try {
          return this.dist.distanceBetween(v, this.faces[fi]);
        } catch {
          return NaN;
        } finally {
          v.delete();
        }
      };
      const plus = off(1);
      const minus = off(-1);
      if (plus < step / 2 && !(minus < step / 2)) return w;
      if (minus < step / 2 && !(plus < step / 2)) return vscale(w, -1);
    }
    // a face too thin to step onto: fall back to its nearest sample
    let d = vsub(this.nearestSample(fi, e.m, e.tangent), e.m);
    d = vsub(d, vscale(e.tangent, vdot(d, e.tangent)));
    return d;
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

  /**
   * The face sample nearest p, preferring ones square to the edge from p: beside a curved edge, a sample further
   * round the curve can lie on the other side of the tangent line (a boss root read as convex).
   */
  private nearestSample(fi: number, p: V3, tangent: V3): V3 {
    const s = this.face(fi);
    let best = s.cents[0];
    let bd = Infinity;
    for (const q of s.cents) {
      const d = vsub(q, p);
      const along = vdot(d, tangent);
      const len2 = vdot(d, d);
      if (len2 < 1e-12) continue;
      const score = len2 - along * along + 16 * along * along;
      if (score < bd) {
        bd = score;
        best = q;
      }
    }
    return best;
  }

  /** Tool faces of a feature with their boxes and surface types, prepared once. */
  private toolFaces(name: string): ToolFace[] {
    const hit = this.toolCache.get(name);
    if (hit) return hit;
    const feat = this.features.get(name);
    if (!feat) throw new SelectionError(`no feature named "${name}" in this part (name one with: add ... as ${name})`);
    const out = feat.tools.flatMap((t) => t.faces.map((face): ToolFace => ({ face, box: boxOf(face), kind: String(face.geomType), plane: planeOfFace(face) })));
    this.toolCache.set(name, out);
    return out;
  }

  private faceInfo(fi: number): { kind: string; box: [V3, V3]; plane?: { n: V3; d: number } } {
    const hit = this.quick[fi];
    if (hit) return hit;
    const f = this.faces[fi];
    const kind = String(f.geomType);
    const q = { kind, box: boxOf(f), plane: planeOfFace(f) };
    this.quick[fi] = q;
    return q;
  }

  /** Does face fi lie on the named feature's tool surfaces? (majority of its sample points) */
  onFeature(name: string, fi: number): boolean {
    let memo = this.featureFaces.get(name);
    if (!memo) this.featureFaces.set(name, (memo = new Map()));
    const hit = memo.get(fi);
    if (hit !== undefined) return hit;
    const tf = this.toolFaces(name);
    const q = this.faceInfo(fi);
    let result = false;
    // booleans keep the tools' surfaces, so a face can only lie on a tool face of the same type (and the same plane)
    const near = tf.filter((t) => {
      if (t.kind !== q.kind || !boxesTouch(q.box, t.box, TOL * 10)) return false;
      if (q.plane && t.plane) return Math.abs(vdot(q.plane.n, t.plane.n)) > 1 - 1e-6 && Math.abs(q.plane.d - Math.sign(vdot(q.plane.n, t.plane.n)) * t.plane.d) < TOL;
      return true;
    });
    if (near.length) {
      const probe = this.face(fi).pts;
      const need = Math.floor(probe.length / 2) + 1;
      let on = 0;
      for (let k = 0; k < probe.length; k++) {
        const p = probe[k];
        const cands = near.filter((t) => inBox(p, t.box, TOL * 10));
        if (cands.length) {
          const v = R.makeVertex(p);
          for (const t of cands) {
            if (this.dist.distanceBetween(v, t.face) < TOL) {
              on++;
              break;
            }
          }
          v.delete();
        }
        if (on >= need) break;
        if (on + (probe.length - k - 1) < need) break;
      }
      result = on >= need;
    }
    memo.set(fi, result);
    return result;
  }

  /** Faces of the shape that lie on the named feature's tool surfaces. */
  featureFaceSet(name: string): Set<number> {
    const out = new Set<number>();
    this.faces.forEach((_, fi) => {
      if (this.onFeature(name, fi)) out.add(fi);
    });
    return out;
  }

  /** Which named features a face belongs to. */
  featuresOfFace(fi: number): string[] {
    return [...this.features.keys()].filter((n) => this.onFeature(n, fi));
  }

  // ---------- selection ----------

  /** Edges a selector picks; `cand` limits the search to edges already picked by a cheaper selector. */
  selectEdges(sel: Sel, cand?: Set<number>): Set<number> {
    const all = cand ? [...cand] : this.edges.map((_, i) => i);
    const pick = (f: (i: number) => boolean) => new Set(all.filter(f));
    const sharp = (i: number) => {
      const c = this.edge(i).convexity;
      return c === "convex" || c === "concave";
    };
    if (typeof sel === "string") {
      const [lo, hi] = this.box;
      switch (sel) {
        case "all":
          return pick((i) => !this.isSeam(i));
        case "vertical":
          return pick((i) => this.edge(i).kind === "LINE" && Math.abs(this.edge(i).tangent[2]) > 0.999);
        case "horizontal":
          return pick((i) => {
            const e = this.edge(i);
            return Math.abs(e.a[2] - e.b[2]) < TOL && Math.abs(e.m[2] - e.a[2]) < TOL && !this.isSeam(i);
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
        // where an added feature meets the body is an inside corner, and where a cut does an outside one. Without this,
        // a face the fuse merged across both (a wall flush with the plate's side) pulls the plate's own edges into root,
        // and a hole cut later through a boss puts its rim there.
        const kind = this.features.get(sel.f)?.kind;
        const rootLike = (i: number) => {
          const c = this.edge(i).convexity;
          return kind === "add" ? c === "concave" : kind === "cut" ? c === "convex" : true;
        };
        return pick((i) => {
          const fs = [...new Set(this.adj()[i])];
          const n = fs.filter((f) => this.onFeature(sel.f, f)).length;
          if (sel.part === "root") return n === 1 && fs.length === 2 && rootLike(i);
          if (sel.part === "tip") return n === 2 && !this.isSeam(i) && this.edge(i).convexity !== "smooth";
          return n >= 1 && !this.isSeam(i);
        });
      }
      case "between": {
        const on = (n: string, f: number) => this.onFeature(n, f);
        return pick((i) => {
          const fs = [...new Set(this.adj()[i])];
          return fs.length === 2 && ((on(sel.a, fs[0]) && on(sel.b, fs[1])) || (on(sel.a, fs[1]) && on(sel.b, fs[0])));
        });
      }
      case "near": {
        const v = R.makeVertex(sel.p);
        const out = pick((i) => {
          const e = this.edge(i);
          if (this.isSeam(i)) return false;
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
          return [e.a, e.m, e.b].every((p) => Math.abs(vdot(p, n) - sel.d) < TOL) && !this.isSeam(i);
        });
      }
      case "along": {
        const d = vnorm(sel.d);
        return pick((i) => this.edge(i).kind === "LINE" && Math.abs(vdot(this.edge(i).tangent, d)) > 0.999);
      }
      case "facing": {
        const ff = this.selectFaces(sel);
        return pick((i) => this.edge(i).faces.some((f) => ff.has(f)) && !this.isSeam(i));
      }
      case "circle":
        return pick((i) => {
          const e = this.edge(i);
          return e.kind === "CIRCLE" && (sel.d <= 0 || Math.abs((e.radius ?? 0) * 2 - sel.d) < 0.01);
        });
      case "box":
        return pick((i) => [this.edge(i).a, this.edge(i).m, this.edge(i).b].every((p) => inBox(p, [sel.lo, sel.hi], TOL)) && !this.isSeam(i));
      case "or": {
        const out = new Set<number>();
        for (const s of sel.a) for (const i of this.selectEdges(s, cand)) out.add(i);
        return out;
      }
      case "and": {
        // cheap geometric tests first, so feature lookups only run on what is left
        let out = cand;
        for (const s of [...sel.a].sort((x, y) => selCost(x) - selCost(y))) out = this.selectEdges(s, out);
        return out ?? new Set();
      }
      case "minus": {
        const a = this.selectEdges(sel.a, cand);
        const b = this.selectEdges(sel.b, a);
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
        if (sel.part === "faces" || sel.part === "edges") return pick((i) => this.onFeature(sel.f, i));
        const es = this.selectEdges(sel);
        return pick((i) => this.onFeature(sel.f, i) && [...es].some((e) => this.edge(e).faces.includes(i)));
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
        // the sides of holes and bosses: cylinders of that diameter (a hole into a round bar has no round rim)
        return pick((i) => {
          const s = this.face(i);
          if (s.kind !== "CYLINDRE") return false;
          if (sel.d <= 0) return true;
          return Math.abs(cylinderRadius(this.faces[i]) * 2 - sel.d) < 0.01;
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

  /**
   * The outermost planar faces whose outward normal points along dir (shell's open: Z): every one in that top
   * plane, so a slot cut across the top before shelling still opens on both sides.
   */
  outermostFaces(dir: V3): number[] {
    const d = vnorm(dir);
    const flat: { i: number; h: number }[] = [];
    this.faces.forEach((_, i) => {
      const s = this.face(i);
      if (s.kind === "PLANE" && vdot(s.normals[0], d) >= 0.999) flat.push({ i, h: vdot(s.pts[0], d) });
    });
    const top = flat.reduce((m, f) => Math.max(m, f.h), -Infinity);
    return flat.filter((f) => f.h > top - TOL).map((f) => f.i);
  }
}

/** A cylindrical face's radius, from its surface. */
function cylinderRadius(f: R.Face): number {
  const ad = new (R.getOC().BRepAdaptor_Surface)(f.wrapped, false);
  try {
    const c = ad.Cylinder();
    const r = c.Radius();
    c.delete();
    return r;
  } catch {
    return 0;
  } finally {
    ad.delete();
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

/** Rough cost of evaluating a selector: feature membership needs distance queries. */
function selCost(sel: Sel): number {
  // convexity needs samples of both faces at every edge, so it is the slowest test
  if (typeof sel === "string") return sel === "convex" || sel === "concave" || sel === "sharp" ? 20 : 0;
  switch (sel.s) {
    case "feat":
    case "between":
      return 10;
    case "near":
      return 2;
    case "facing":
      return 3;
    case "or":
    case "and":
      return Math.max(...sel.a.map(selCost));
    case "minus":
      return selCost(sel.a) + selCost(sel.b);
    default:
      return 1;
  }
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
      return `both(${sel.a.map(describeSel).join(", ")})`;
    case "minus":
      return `${describeSel(sel.a)} - ${describeSel(sel.b)}`;
  }
}
