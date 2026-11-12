// Direct editing: changing a solid's faces whatever made it, the part's own features, an imported STEP body or a
// mesh made solid, with no history to go back to.
//
// - push_pull moves faces along their outward normals. A flat face goes out (adding material) or in (taking it
//   away) and the faces around it stretch to follow, whether they stand square, slope or taper like a cone; a
//   round face (a hole or a boss) gets bigger or smaller.
// - replace_faces puts flat faces into the plane of another face, flush with it or at its slope.
// - delete_faces takes faces away and heals the solid: holes, pockets, slots and lettering are filled in, bosses
//   and ribs cut off, rounds and chamfers turned back into sharp edges.
// - move_faces moves or copies a feature such as a hole, a pocket or a boss.
//
// Each is built from prisms, offsets, drafts and booleans the kernel already has: a pushed face's prism has its
// sides tilted to lie in the faces around it, a feature's faces are closed off where they meet the face it sits
// on to give its solid, and a round's solid is the room between it and the faces it joins.

import * as R from "replicad";
import type { Shape3D } from "replicad";
import { shapeValid } from "./profiles";
import { vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type V3 } from "./recipe";

export class DirectError extends Error {}

/** How far from square a flat face's neighbours may lean for push_pull to stretch them, degrees. */
export const MAX_SLOPE = 60;

const tup = (v: { toTuple(): number[] }): V3 => {
  const t = v.toTuple();
  return [t[0], t[1], t[2]];
};
const kindOf = (f: R.Face) => String(f.geomType);
const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 10) / 10;
const fmt = (x: number) => String(Math.round(x * 1000) / 1000);

/** Which faces of a solid meet at each of its edges. */
class Adj {
  readonly faces: R.Face[];
  private byHash = new Map<number, { e: R.Edge; fs: number[] }[]>();
  private dist = new R.DistanceTool();
  readonly size: number;

  constructor(readonly shape: Shape3D, faces?: R.Face[]) {
    this.faces = faces ?? shape.faces;
    this.faces.forEach((f, fi) => {
      for (const e of f.edges) {
        const list = this.byHash.get(e.hashCode) ?? [];
        let hit = list.find((x) => x.e.isSame(e));
        if (!hit) {
          hit = { e, fs: [] };
          list.push(hit);
          this.byHash.set(e.hashCode, list);
        }
        if (!hit.fs.includes(fi)) hit.fs.push(fi);
      }
    });
    const [lo, hi] = shape.boundingBox.bounds;
    this.size = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
  }

  /** The faces other than fi meeting at an edge of fi: none for a seam (a cylinder's side meeting itself). */
  others(e: R.Edge, fi: number): number[] {
    const hit = this.byHash.get(e.hashCode)?.find((x) => x.e.isSame(e));
    return hit ? hit.fs.filter((g) => g !== fi) : [];
  }

  /** A face's edges, each once. */
  edgesOf(fi: number): R.Edge[] {
    const out: R.Edge[] = [];
    for (const e of this.faces[fi].edges) if (!out.some((x) => x.isSame(e))) out.push(e);
    return out;
  }

  distance(p: V3, s: R.Face | Shape3D): number {
    const v = R.makeVertex(p);
    try {
      return this.dist.distanceBetween(v, s);
    } finally {
      v.delete();
    }
  }

  dispose() {
    try {
      this.dist.delete();
    } catch {
      /* already freed */
    }
  }
}

/** The outward normal of a face at a point on it (pointing away from the solid). */
function normalAt(f: R.Face, p: V3): V3 {
  return vnorm(tup(f.normalAt(p)));
}

/** A flat face's plane: a point on it and its outward normal. */
function planeOf(f: R.Face): { p: V3; n: V3 } {
  const p = tup(f.center);
  return { p, n: normalAt(f, p) };
}

/** A point well inside a face (the middle of its largest mesh triangle, on the surface). */
function insidePoint(f: R.Face): V3 {
  const m = new (R.getOC().BRepMesh_IncrementalMesh)(f.wrapped, 0.25, false, (25 * Math.PI) / 180, false);
  m.delete();
  const tri = f.triangulation();
  let best = -1;
  let out: V3 = tup(f.center);
  if (tri) {
    const v = tri.vertices;
    const I = tri.trianglesIndexes;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a: V3 = [v[I[t] * 3], v[I[t] * 3 + 1], v[I[t] * 3 + 2]];
      const b: V3 = [v[I[t + 1] * 3], v[I[t + 1] * 3 + 1], v[I[t + 1] * 3 + 2]];
      const c: V3 = [v[I[t + 2] * 3], v[I[t + 2] * 3 + 1], v[I[t + 2] * 3 + 2]];
      const area = vlen(vcross(vsub(b, a), vsub(c, a)));
      if (area > best) {
        best = area;
        out = vscale(vadd(vadd(a, b), c), 1 / 3);
      }
    }
  }
  if (kindOf(f) === "PLANE") return out;
  try {
    const [u, w] = f.uvCoordinates(out);
    const bb = f.UVBounds;
    return tup(f.pointOnSurface((u - bb.uMin) / (bb.uMax - bb.uMin), (w - bb.vMin) / (bb.vMax - bb.vMin)));
  } catch {
    return out;
  }
}

interface Probe {
  kind: string;
  p: V3;
  n: V3;
}

const probeOf = (f: R.Face): Probe => {
  const p = insidePoint(f);
  return { kind: kindOf(f), p, n: normalAt(f, p) };
};

/** The face of the solid a probe lies on (the same kind of surface, facing the same way), or -1. */
function findFace(adj: Adj, pr: Probe): number {
  const tol = Math.max(1e-5, adj.size * 1e-6);
  let best = -1;
  let bestD = Infinity;
  adj.faces.forEach((f, i) => {
    if (kindOf(f) !== pr.kind) return;
    const [lo, hi] = f.boundingBox.bounds;
    for (let k = 0; k < 3; k++) if (pr.p[k] < lo[k] - 1e-3 || pr.p[k] > hi[k] + 1e-3) return;
    const d = adj.distance(pr.p, f);
    if (d < bestD && d < tol && vdot(normalAt(f, pr.p), pr.n) > 0.999) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The solid made valid: positive volume, checked, one or more solids. */
function solidOf(s: R.AnyShape, what: string): Shape3D {
  if (!R.isShape3D(s)) throw new DirectError(`${what} did not come out as a solid`);
  if (!shapeValid(s)) throw new DirectError(`${what} came out broken`);
  return s;
}

/** A solid turned the right way out (the kernel's offsets and prisms of a face can come out inside out). */
function rightWayOut(s: Shape3D): Shape3D {
  return R.measureVolume(s) < 0 ? (R.cast(s.wrapped.Reversed()) as Shape3D) : s;
}

/** A face thickened into a solid by d along its outward normal (inward when negative). */
function thickFace(f: R.Face, d: number): Shape3D {
  const oc = R.getOC();
  const b = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    // offset into the face's back so the solid comes out the right way round: outward is the reversed face's back
    b.MakeThickSolidBySimple(d > 0 ? f.wrapped.Reversed() : f.wrapped, -Math.abs(d));
    b.Build();
    if (!b.IsDone()) throw new DirectError(`the face could not be offset by ${fmt(d)} mm`);
    const s = R.cast(b.Shape());
    if (!R.isShape3D(s)) throw new DirectError(`the face could not be offset by ${fmt(d)} mm`);
    // a copy: the offset solid is built on the face itself, and booleans with a solid sharing it go wrong
    return copyOf(rightWayOut(s));
  } finally {
    b.delete();
  }
}

/** A deep copy of a solid, sharing no faces or edges with the one it came from. */
function copyOf(s: Shape3D): Shape3D {
  const oc = R.getOC();
  const tr = new oc.gp_Trsf();
  const cp = new oc.BRepBuilderAPI_Transform(s.wrapped, tr, true);
  try {
    return R.cast(cp.Shape()) as Shape3D;
  } finally {
    cp.delete();
    tr.delete();
  }
}

// ---------------------------------------------------------------- push and pull

/**
 * The room a flat face sweeps through moving along its normal n by len (in when negative): its prism, with each
 * side tilted to lie in the face next to it (flat, sloping or conical) so the neighbours stretch to follow.
 */
function column(adj: Adj, fi: number, n: V3, P: V3, len: number): Shape3D {
  const oc = R.getOC();
  const F = adj.faces[fi];
  // the prism's base must face out of it: away from the push for a push out
  const base = len > 0 ? F.wrapped.Reversed() : F.wrapped;
  const vec = new oc.gp_Vec(n[0] * len, n[1] * len, n[2] * len);
  const mk = new oc.BRepPrimAPI_MakePrism(base, vec, false, true);
  const [flo, fhi] = F.boundingBox.bounds;
  const eps = Math.max(1e-5, 1e-4 * Math.hypot(fhi[0] - flo[0], fhi[1] - flo[1], fhi[2] - flo[2]));
  try {
    if (!mk.IsDone()) throw new DirectError("the face could not be swept along its normal");
    let prism = R.cast(mk.Shape()) as Shape3D;
    const tilts: { face: R.Face; angle: number }[] = [];
    for (const e of adj.edgesOf(fi)) {
      const others = adj.others(e, fi);
      if (!others.length) continue;
      const G = adj.faces[others[0]];
      const gen = mk.Generated(e.wrapped);
      if (gen.IsEmpty()) {
        gen.delete();
        continue;
      }
      const side = R.cast(gen.First()) as R.Face;
      gen.delete();
      const angles: number[] = [];
      for (const t of [0.2, 0.5, 0.8]) {
        const p = tup(e.pointAt(t));
        const T = vnorm(tup(e.tangentAt(t)));
        // out of the face across this edge, in its plane
        let w = vnorm(vcross(n, T));
        if (adj.distance(vadd(p, vscale(w, eps)), F) < eps * 0.25) w = vscale(w, -1);
        const g = normalAt(G, p);
        const gs = vdot(g, w) >= 0 ? g : vscale(g, -1);
        angles.push(Math.atan2(vdot(gs, n), vdot(gs, w)));
      }
      const a = angles[1];
      if (Math.max(...angles) - Math.min(...angles) > 2e-3) throw new DirectError(`the ${kindWord(G)} face next to it curves along their shared edge, so it can't be stretched to follow`);
      if (Math.abs(a) > (MAX_SLOPE * Math.PI) / 180) {
        throw new DirectError(
          Math.abs(a) > (85 * Math.PI) / 180
            ? "a round runs into its edge: take the round off with delete_faces() first, push or pull the face, then round the edge again"
            : `the face next to it leans ${deg(Math.abs(a))}° from square, more than the ${MAX_SLOPE}° push_pull can stretch`,
        );
      }
      if (Math.abs(a) > 1e-7) tilts.push({ face: side, angle: a });
    }
    if (tilts.length) {
      const b = new oc.BRepOffsetAPI_DraftAngle(prism.wrapped);
      const at = new oc.gp_Pnt(P[0], P[1], P[2]);
      const dir = new oc.gp_Dir(n[0], n[1], n[2]);
      const pln = new oc.gp_Pln(at, dir);
      try {
        for (const t of tilts) {
          b.Add(t.face.wrapped, dir, t.angle, pln, true);
          if (!b.AddDone()) throw new DirectError("the sloping faces around it could not be stretched that far");
        }
        b.Build();
        if (!b.IsDone()) throw new DirectError("the sloping faces around it meet before the face gets there");
        prism = R.cast(b.ModifiedShape(prism.wrapped)) as Shape3D;
      } finally {
        b.delete();
        pln.delete();
        dir.delete();
        at.delete();
      }
    }
    prism = rightWayOut(prism);
    if (!shapeValid(prism) || R.measureVolume(prism) < 1e-9) throw new DirectError("the sloping faces around it meet before the face gets there");
    return prism;
  } finally {
    mk.delete();
    vec.delete();
  }
}

const kindWord = (f: R.Face) => {
  const k = kindOf(f);
  return k === "PLANE" ? "flat" : k === "CYLINDRE" ? "round" : k === "CONE" ? "conical" : k === "SPHERE" ? "spherical" : k === "TORUS" ? "rounded" : "curved";
};

/** A round face (or any curved one) moved out or in by d: a hole or boss gets smaller or bigger. */
function pushCurved(adj: Adj, fi: number, d: number): Shape3D {
  const F = adj.faces[fi];
  for (const e of adj.edgesOf(fi)) {
    const others = adj.others(e, fi);
    if (!others.length) continue;
    const G = adj.faces[others[0]];
    for (const t of [0.2, 0.5, 0.8]) {
      const p = tup(e.pointAt(t));
      if (Math.abs(vdot(normalAt(G, p), normalAt(F, p))) > 0.03)
        throw new DirectError(`a ${kindWord(F)} face can be pushed or pulled where the faces at its ends stand square to it, and the ${kindWord(G)} face next to this one doesn't (a chamfer or round on the edge: delete_faces() it first)`);
    }
  }
  const shell = thickFace(F, d);
  return d > 0 ? adj.shape.fuse(shell) : adj.shape.cut(shell);
}

/** Flat faces of one plane moved together (their prisms joined), so faces split by a slot move as one. */
function pushFlat(adj: Adj, group: number[], d: number): Shape3D {
  const { p, n } = planeOf(adj.faces[group[0]]);
  let col: Shape3D | null = null;
  for (const fi of group) {
    const c = column(adj, fi, n, p, d);
    col = col ? col.fuse(c) : c;
  }
  return d > 0 ? adj.shape.fuse(col!) : adj.shape.cut(col!);
}

/** Selected faces grouped: flat faces sharing a plane go together, everything else on its own. */
function groupFaces(faces: R.Face[]): R.Face[][] {
  const groups: { plane?: { p: V3; n: V3 }; faces: R.Face[] }[] = [];
  for (const f of faces) {
    if (kindOf(f) !== "PLANE") {
      groups.push({ faces: [f] });
      continue;
    }
    const pl = planeOf(f);
    const g = groups.find((x) => x.plane && vdot(x.plane.n, pl.n) > 1 - 1e-9 && Math.abs(vdot(vsub(pl.p, x.plane.p), pl.n)) < 1e-6);
    if (g) g.faces.push(f);
    else groups.push({ plane: pl, faces: [f] });
  }
  return groups.map((g) => g.faces);
}

/**
 * push_pull: move faces along their outward normals by d mm, out when positive (adding material) and in when
 * negative. Faces in different planes go one after another, so two sides of a box pushed out meet at their corner.
 */
export function pushPull(shape: Shape3D, faces: R.Face[], d: number): Shape3D {
  if (!faces.length) throw new DirectError("no faces to push or pull");
  if (!(Math.abs(d) > 1e-6)) return shape;
  const groups = groupFaces(faces).map((g) => g.map(probeOf));
  let s = shape;
  for (const g of groups) {
    const adj = new Adj(s);
    try {
      const idx = g.map((pr) => findFace(adj, pr));
      if (idx.some((i) => i < 0)) throw new DirectError("a face moved by an earlier one in the same push_pull() could not be found again: push or pull them in separate steps");
      s = solidOf(g[0].kind === "PLANE" ? pushFlat(adj, idx, d) : pushCurved(adj, idx[0], d), `push_pull(${fmt(d)})`);
    } finally {
      adj.dispose();
    }
  }
  return s;
}

// ---------------------------------------------------------------- replace (into another plane)

/** A big box filling the side of a plane opposite its normal, around `at`. */
function halfSpace(p: V3, n: V3, at: V3, size: number): Shape3D {
  const nn = vnorm(n);
  const foot = vsub(at, vscale(nn, vdot(vsub(at, p), nn)));
  let box = (R.makeBaseBox(2 * size, 2 * size, size) as Shape3D).translate([0, 0, -size]);
  const z: V3 = [0, 0, 1];
  const axis = vcross(z, nn);
  if (vlen(axis) > 1e-9) box = box.rotate((Math.acos(Math.max(-1, Math.min(1, vdot(z, nn)))) * 180) / Math.PI, [0, 0, 0], vnorm(axis));
  else if (nn[2] < 0) box = box.rotate(180, [0, 0, 0], [1, 0, 0]);
  return box.translate(foot);
}

/**
 * replace_faces: each flat face moved into the plane (p, n), flush with another face or at its slope; the faces
 * around it stretch to meet it there.
 */
export function replaceFaces(shape: Shape3D, faces: R.Face[], target: { p: V3; n: V3 }): Shape3D {
  if (!faces.length) throw new DirectError("no faces to replace");
  const probes = faces.map((f) => {
    if (kindOf(f) !== "PLANE") throw new DirectError(`only flat faces can be replaced with a plane, and one picked is ${kindWord(f)}`);
    return probeOf(f);
  });
  let s = shape;
  for (const pr of probes) {
    const adj = new Adj(s);
    try {
      const fi = findFace(adj, pr);
      if (fi < 0) throw new DirectError("a face moved by an earlier one in the same replace_faces() could not be found again: replace them in separate steps");
      const F = adj.faces[fi];
      const { p, n } = planeOf(F);
      let m = vnorm(target.n);
      if (vdot(m, n) < 0) m = vscale(m, -1);
      const c = vdot(m, n);
      if (c < Math.cos(((90 - 10) * Math.PI) / 180)) throw new DirectError("the new plane is within 10° of square to the face, so the face can't be moved into it");
      // how far along n each point of the face's outline moves to reach the plane
      const ts: number[] = [];
      for (const e of adj.edgesOf(fi)) for (let k = 0; k <= 8; k++) ts.push(vdot(m, vsub(target.p, tup(e.pointAt(k / 8)))) / c);
      const tmax = Math.max(...ts);
      const tmin = Math.min(...ts);
      if (tmax - tmin < 1e-6) {
        s = Math.abs(tmax) < 1e-6 ? s : solidOf(pushFlat(adj, [fi], tmax), "replace_faces()");
        continue;
      }
      const big = 4 * (adj.size + Math.abs(tmax) + Math.abs(tmin));
      let out = s;
      if (tmax > 1e-6) {
        const up = column(adj, fi, n, p, tmax + 1e-3 * adj.size);
        out = out.fuse(up.intersect(halfSpace(target.p, m, p, big)) as Shape3D);
      }
      if (tmin < -1e-6) {
        const down = column(adj, fi, n, p, tmin - 1e-3 * adj.size);
        out = out.cut(down.cut(halfSpace(target.p, m, p, big)));
      }
      s = solidOf(out, "replace_faces()");
    } finally {
      adj.dispose();
    }
  }
  return s;
}

/** The plane of the first flat face in a list (the face to replace others with). */
export function targetPlane(faces: R.Face[]): { p: V3; n: V3 } {
  const f = faces.find((x) => kindOf(x) === "PLANE");
  if (!f) throw new DirectError("with: picks no flat face to line the faces up with");
  return planeOf(f);
}

// ---------------------------------------------------------------- features: delete, move, copy

interface Feature {
  /** the feature's own solid: the room a hole or pocket takes up, or a boss's material */
  solid: Shape3D;
  /** true for a hole, pocket or a round's missing corner (filled to delete), false for material (cut away) */
  cavity: boolean;
  /** a round or chamfer: deleting it makes the edge sharp; it can't be moved */
  blend: boolean;
  faces: number[];
}

/** Faces split into connected groups (sharing edges). */
function components(adj: Adj, picked: number[]): number[][] {
  const left = new Set(picked);
  const out: number[][] = [];
  while (left.size) {
    const first = left.values().next().value as number;
    left.delete(first);
    const comp = [first];
    for (let k = 0; k < comp.length; k++) {
      for (const e of adj.edgesOf(comp[k])) {
        for (const g of adj.others(e, comp[k])) {
          if (left.has(g)) {
            left.delete(g);
            comp.push(g);
          }
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/** Add the faces bounded only by the group (a hole's floor, a boss's top): they belong to the same feature. */
function grow(adj: Adj, comp: number[]): number[] {
  const inC = new Set(comp);
  let changed = true;
  while (changed) {
    changed = false;
    const cands = new Set<number>();
    for (const fi of inC) for (const e of adj.edgesOf(fi)) for (const g of adj.others(e, fi)) if (!inC.has(g)) cands.add(g);
    for (const g of cands) {
      const edges = adj.edgesOf(g).filter((e) => adj.others(e, g).length);
      if (edges.length && edges.every((e) => adj.others(e, g).every((h) => inC.has(h)))) {
        inC.add(g);
        changed = true;
      }
    }
  }
  return [...inC];
}

/** The group's boundary edges, each with the face outside the group it meets, chained into closed loops. */
function boundaryLoops(adj: Adj, comp: number[]): { e: R.Edge; out: number }[][] {
  const inC = new Set(comp);
  const bound: { e: R.Edge; out: number; a: V3; b: V3 }[] = [];
  for (const fi of comp) {
    for (const e of adj.edgesOf(fi)) {
      const out = adj.others(e, fi).find((g) => !inC.has(g));
      if (out === undefined || bound.some((x) => x.e.isSame(e))) continue;
      bound.push({ e, out, a: tup(e.startPoint), b: tup(e.endPoint) });
    }
  }
  const tol = Math.max(1e-6, adj.size * 1e-5);
  const same = (p: V3, q: V3) => vlen(vsub(p, q)) < tol;
  const used = new Set<number>();
  const loops: { e: R.Edge; out: number }[][] = [];
  for (let i = 0; i < bound.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const loop = [bound[i]];
    const start = bound[i].a;
    let end = bound[i].b;
    while (!same(end, start)) {
      const j = bound.findIndex((x, k) => !used.has(k) && (same(x.a, end) || same(x.b, end)));
      if (j < 0) throw new DirectError("the picked faces' edges don't close up into loops");
      used.add(j);
      loop.push(bound[j]);
      end = same(bound[j].a, end) ? bound[j].b : bound[j].a;
    }
    loops.push(loop);
  }
  return loops;
}

/** A face closing a loop of edges, on the surface of the face(s) the loop runs along, or null when there is none. */
function capFor(adj: Adj, loop: { e: R.Edge; out: number }[]): R.Face | null {
  const oc = R.getOC();
  const outs = [...new Set(loop.map((x) => x.out))];
  const first = adj.faces[outs[0]];
  const flat = outs.every((g) => kindOf(adj.faces[g]) === "PLANE");
  if (flat) {
    const pl = planeOf(first);
    if (!outs.every((g) => {
      const q = planeOf(adj.faces[g]);
      return Math.abs(vdot(q.n, pl.n)) > 1 - 1e-7 && Math.abs(vdot(vsub(q.p, pl.p), pl.n)) < 1e-5;
    }))
      return null;
  } else if (outs.length > 1) return null;
  const mw = new oc.BRepBuilderAPI_MakeWire();
  try {
    for (const x of loop) mw.Add(x.e.wrapped);
    if (!mw.IsDone()) return null;
    const wire = mw.Wire();
    let mf;
    if (flat) mf = new oc.BRepBuilderAPI_MakeFace(wire, true);
    else {
      const surf = oc.BRep_Tool.Surface(first.wrapped);
      mf = new oc.BRepBuilderAPI_MakeFace(surf, wire, true);
    }
    try {
      if (!mf.IsDone()) return null;
      const f = R.cast(mf.Face());
      return f instanceof R.Face ? f : null;
    } finally {
      mf.delete();
      wire.delete();
    }
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) throw e;
    return null;
  } finally {
    mw.delete();
  }
}

/** Faces sewn into a closed solid, or null when they leave a gap. */
function sewSolid(faces: R.Face[]): Shape3D | null {
  const oc = R.getOC();
  const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  try {
    for (const f of faces) sew.Add(f.wrapped);
    sew.Perform();
    if (sew.NbFreeEdges() > 0) return null;
    const shell = R.cast(sew.SewedShape());
    if (!(shell instanceof R.Shell)) return null;
    const fix = new oc.ShapeFix_Solid();
    try {
      const solid = R.cast(fix.SolidFromShell(shell.wrapped));
      if (!R.isShape3D(solid)) return null;
      const s = rightWayOut(solid);
      return R.measureVolume(s) > 1e-9 && shapeValid(s) ? s : null;
    } finally {
      fix.delete();
    }
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) throw e;
    return null;
  } finally {
    sew.delete();
  }
}

const vol = (s: Shape3D) => Math.abs(R.measureVolume(s));

/** A feature on a face (a hole, pocket, slot, letter, boss or rib): its faces closed off where it meets that face. */
function featureOnFace(adj: Adj, comp: number[]): Feature | null {
  const loops = boundaryLoops(adj, comp);
  if (!loops.length) return null;
  const caps: R.Face[] = [];
  for (const loop of loops) {
    const cap = capFor(adj, loop);
    if (!cap) return null;
    caps.push(cap);
  }
  const solid = sewSolid([...comp.map((i) => adj.faces[i]), ...caps]);
  if (!solid) return null;
  const v = vol(solid);
  const inside = vol(adj.shape.intersect(solid) as Shape3D);
  const cavity = inside < 0.5 * v;
  // faces closing off everything (every round of a rounded box): not a feature on a face
  if (!cavity && inside > 0.99 * vol(adj.shape)) return null;
  return { solid, cavity, blend: false, faces: comp };
}

/**
 * The material side of a face's whole surface as a solid (a flat face's half of space, a round face's cylinder).
 * `end`: a face the round stops at (meeting it square, like the end of a box) rather than one it joins.
 */
type Side = { solid: Shape3D; inside: boolean; end: boolean };

function sideOf(adj: Adj, g: R.Face, around: V3, big: number, end: boolean): Side {
  const oc = R.getOC();
  const k = kindOf(g);
  if (k === "PLANE") {
    const { p, n } = planeOf(g);
    return { solid: halfSpace(p, n, around, big), inside: true, end };
  }
  const ad = new oc.BRepAdaptor_Surface(g.wrapped, true);
  try {
    if (k === "CYLINDRE") {
      const cyl = ad.Cylinder();
      const ax = cyl.Axis();
      const loc = ax.Location();
      const dir = ax.Direction();
      const o: V3 = [loc.X(), loc.Y(), loc.Z()];
      const a: V3 = vnorm([dir.X(), dir.Y(), dir.Z()]);
      const r = cyl.Radius();
      for (const x of [cyl, ax, loc, dir]) x.delete();
      const p = insidePoint(g);
      const radial = vsub(vsub(p, o), vscale(a, vdot(vsub(p, o), a)));
      const inside = vdot(normalAt(g, p), radial) > 0;
      const foot = vadd(o, vscale(a, vdot(vsub(around, o), a) - big));
      return { solid: R.makeCylinder(r, 2 * big, foot, a) as Shape3D, inside, end };
    }
    if (k === "SPHERE") {
      const sph = ad.Sphere();
      const loc = sph.Location();
      const c: V3 = [loc.X(), loc.Y(), loc.Z()];
      const r = sph.Radius();
      sph.delete();
      loc.delete();
      const p = insidePoint(g);
      const inside = vdot(normalAt(g, p), vsub(p, c)) > 0;
      return { solid: R.makeSphere(r).translate(c) as Shape3D, inside, end };
    }
  } finally {
    ad.delete();
  }
  throw new DirectError(`a round or chamfer can be taken off where it joins flat, round (cylindrical) or spherical faces, and this one joins a ${kindWord(g)} face`);
}

/** A round's radius, or a chamfer's (or other face's) width: how big the corner it cut off can be. */
function blendSize(f: R.Face): number {
  const oc = R.getOC();
  const k = kindOf(f);
  if (k === "CYLINDRE" || k === "SPHERE" || k === "TORUS") {
    const ad = new oc.BRepAdaptor_Surface(f.wrapped, true);
    try {
      const g = (k === "CYLINDRE" ? ad.Cylinder() : k === "SPHERE" ? ad.Sphere() : ad.Torus()) as unknown as { Radius?(): number; MinorRadius?(): number; MajorRadius?(): number; delete(): void };
      try {
        if (g.Radius) return g.Radius();
        // stay inside the doughnut's hole: offsetting a fat torus further turns it inside out
        return Math.min(g.MinorRadius!(), (0.9 * g.MajorRadius!()) / 2.5);
      } finally {
        g.delete();
      }
    } finally {
      ad.delete();
    }
  }
  // a strip's width from its area and outline (a chamfer along an edge is a long thin strip)
  const area = R.measureArea(f);
  const perim = f.edges.reduce((sum, e) => sum + e.length, 0);
  return perim > 0 ? (4 * area) / perim : Math.sqrt(area);
}

/**
 * A round or chamfer (or a run of them): the room between it and the edge it replaced, found where the faces it
 * joins, carried on, meet: filled for a round on an outside edge, cut away for one in an inside corner.
 */
function blendFeature(adj: Adj, comp: number[]): Feature {
  const inC = new Set(comp);
  // each face the round meets, and whether it only stops there (square to it) or joins it
  const supports = new Map<number, boolean>();
  for (const fi of comp)
    for (const e of adj.edgesOf(fi))
      for (const g of adj.others(e, fi)) {
        if (inC.has(g)) continue;
        const p = tup(e.pointAt(0.5));
        const end = Math.abs(vdot(normalAt(adj.faces[fi], p), normalAt(adj.faces[g], p))) < 0.1;
        supports.set(g, (supports.get(g) ?? true) && end);
      }
  if (!supports.size) throw new DirectError("the picked faces make up the whole solid");
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const fi of comp) {
    const [a, b] = adj.faces[fi].boundingBox.bounds;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
  }
  const diag = Math.max(1e-3, vlen(vsub(hi, lo)));
  // how far the edge it replaced can be from the round: a few times its radius (a chamfer's width)
  const reach = 2.5 * Math.max(...comp.map((fi) => blendSize(adj.faces[fi])));
  const mid = vscale(vadd(lo, hi), 0.5);
  const big = 4 * (diag + 2 * reach);
  const sides = [...supports].map(([g, end]) => sideOf(adj, adj.faces[g], mid, big, end));
  const room = (d: number) => {
    let k: Shape3D | null = null;
    for (const fi of comp) {
      const t = thickFace(adj.faces[fi], d);
      k = k ? k.fuse(t) : t;
    }
    return k!;
  };
  // outside edge: the room outside the round and inside every face it joins; inside corner: the round's own
  // material outside every face it joins
  const corner = (d: number, outside: boolean) => {
    let x = room(outside ? d : -d);
    // keep to the material side of the faces it stops at, and of the faces it joins for an outside edge; leave
    // the material side of the faces an inside round joins
    for (const s of sides) x = (s.inside === (outside || s.end) ? x.intersect(s.solid) : x.cut(s.solid)) as Shape3D;
    return x;
  };
  const tiny = 1e-9 * diag ** 3;
  for (const outside of [true, false]) {
    try {
      const x = corner(reach, outside);
      const v = vol(x);
      if (!(v > tiny)) continue;
      const inS = vol(adj.shape.intersect(x) as Shape3D);
      if (outside ? inS > 0.02 * v : inS < 0.98 * v) continue;
      // a real corner is closed in by the faces the round joins: reaching further finds no more room
      if (Math.abs(vol(corner(1.6 * reach, outside)) - v) > 1e-3 * v + tiny) continue;
      return { solid: x, cavity: outside, blend: true, faces: comp };
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) throw e;
    }
  }
  throw new DirectError("Kerf can't work out what the picked faces would heal into: pick every face of the hole, pocket or boss (its sides with its floor or top), or a round or chamfer between faces that can meet");
}

/** The features the picked faces make, each with its solid. */
function featuresOf(adj: Adj, picked: number[]): Feature[] {
  return components(adj, picked).map((c) => {
    const feat = featureOnFace(adj, c);
    if (feat) return feat;
    // a curved floor or top (a drill point, a dome) comes with the sides that bound it
    const more = grow(adj, c);
    if (more.length > c.length && more.length < adj.faces.length) {
      const grown = featureOnFace(adj, more);
      if (grown) return grown;
    }
    try {
      return blendFeature(adj, c);
    } catch (e) {
      if (e instanceof DirectError && onCurvedFace(adj, c)) throw new DirectError("the feature sits on a curved face, and Kerf closes features off on flat faces only so far: cut or add a new shape to change it instead");
      throw e;
    }
  });
}

/** Whether a group of faces is ringed by one curved face (a hole drilled into a round bar). */
function onCurvedFace(adj: Adj, comp: number[]): boolean {
  try {
    return boundaryLoops(adj, comp).some((loop) => {
      const outs = new Set(loop.map((x) => x.out));
      return outs.size === 1 && kindOf(adj.faces[[...outs][0]]) !== "PLANE";
    });
  } catch {
    return false;
  }
}

function indicesOf(adj: Adj, faces: R.Face[]): number[] {
  return faces.map((f) => {
    const i = adj.faces.findIndex((g) => g.isSame(f));
    if (i < 0) throw new DirectError("a picked face is not on this solid");
    return i;
  });
}

/** The solid with the features filled in or cut away. */
function heal(s: Shape3D, feats: Feature[]): Shape3D {
  let out = s;
  for (const f of feats) if (f.cavity) out = out.fuse(f.solid);
  for (const f of feats) if (!f.cavity) out = out.cut(f.solid);
  return out;
}

/** delete_faces: the picked faces taken away and the solid healed. */
export function deleteFaces(shape: Shape3D, faces: R.Face[]): Shape3D {
  if (!faces.length) throw new DirectError("no faces to delete");
  const adj = new Adj(shape);
  try {
    const feats = featuresOf(adj, indicesOf(adj, faces));
    return solidOf(heal(shape, feats), "delete_faces()");
  } finally {
    adj.dispose();
  }
}

export interface FaceMove {
  by: V3;
  /** degrees about `axis` through `about` (the feature's middle when not given) */
  turn: number;
  axis: V3;
  about?: V3;
  copy: boolean;
}

/** move_faces: a feature (hole, pocket, boss, rib) moved or copied, the solid healed where it was. */
export function moveFaces(shape: Shape3D, faces: R.Face[], mv: FaceMove): Shape3D {
  if (!faces.length) throw new DirectError("no faces to move");
  const adj = new Adj(shape);
  let feats: Feature[];
  try {
    const picked = indicesOf(adj, faces);
    // one flat side moved straight out or in is a push or pull
    if (picked.length === 1 && kindOf(adj.faces[picked[0]]) === "PLANE" && !mv.turn && !mv.copy) {
      if (!featureOnFace(adj, picked)) {
        const { n } = planeOf(adj.faces[picked[0]]);
        const along = vdot(mv.by, n);
        if (vlen(vsub(mv.by, vscale(n, along))) > 1e-6) throw new DirectError("a flat side of the solid can only move straight out or in (along its normal): use push_pull()");
        return pushPull(shape, faces, along);
      }
    }
    feats = featuresOf(adj, picked);
  } finally {
    adj.dispose();
  }
  const blend = feats.find((f) => f.blend);
  if (blend) throw new DirectError("rounds and chamfers can't be moved: delete_faces() them, or round other edges");
  let out = mv.copy ? shape : heal(shape, feats);
  for (const f of feats) {
    let moved = f.solid;
    if (Math.abs(mv.turn) > 1e-9) {
      const [a, b] = moved.boundingBox.bounds;
      const about = mv.about ?? ([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as V3);
      moved = moved.rotate(mv.turn, about, vnorm(mv.axis));
    }
    if (vlen(mv.by) > 1e-9) moved = moved.translate(mv.by);
    out = f.cavity ? out.cut(moved) : out.fuse(moved);
  }
  const result = solidOf(out, "move_faces()");
  if (result.solids?.length > 1 && (shape.solids?.length ?? 1) < result.solids.length) throw new DirectError("the moved feature no longer touches the rest of the solid");
  return result;
}

