// Thin walls as shells. A carbon layup is made as its outer surface with the plies laid inside it, so it is modelled
// as that surface carrying a skin as thick as the laminate; a sheet-metal part (or another part that is one thin
// wall) as one of its faces carrying the sheet behind it. Small cubes would have to be thinner than the wall to bend
// like it, which a bike frame's 1.1 mm laminate or a 1.5 mm bracket never allows at a sensible count; shells bend
// and stretch like the wall with a few thousand triangles.
//
// The surface is remeshed into even triangles (shellMesh.ts), each a flat shell with six freedoms per corner and the
// wall's material offset behind its face (shellElement.ts), and the whole system is solved directly (sparse.ts).
// Stresses are worked out on both faces of the wall: a sheet shows each face its own, a laminate's outside shows the
// worse of its two faces (the inside one cannot be seen). Several shell parts that touch are joined where they meet.

import { allowableStress, type MechMaterial } from "../materials";
import { describeRegion, type RegionSpec } from "../spec";
import { principal, vonMises } from "./element";
import { BlockSystem, factorBlocks, nodeLinks, type BlockMatrix } from "./sparse";
import { planeQ, shellFrame, shellLocalK, shellLocalKg, shellStrains, toLocal18, toWorld18, type ShellFrame, type ShellLocal } from "./shellElement";
import { findPatches, remesh, sizeField, subSurface, TriBVH, wallSide, weld, type SurfaceMesh } from "./shellMesh";
import { failureStrength, fibreField, laminate, newPlyCheck, plyCheck, PLY_FAILURES, qBar, type FibreField, type FibreRule, type Laminate, type PlyFailure, type PlyMaterial } from "./laminate";
import { FeaError, type BucklingResult, type PartField, type Progress, type SafetyAt, type StructuralInput, type StructuralResult } from "./structural";
import type { V3 } from "./voxel";

const G0 = 9.80665;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** How a part is a thin wall, for shell elements. */
export interface ShellPart {
  /**
   * laminate: its whole outer surface is a skin t thick laid inside it (a carbon layup); sheet: one of its faces
   * carries a sheet t thick (sheet metal); wall: a thin-walled part whose wall is measured from its two faces
   */
  kind: "laminate" | "sheet" | "wall";
  /** the laminate's or the sheet's thickness, mm (a wall's is measured) */
  t?: number;
  /** a composite wall's plies, in place of an even quasi-isotropic laminate */
  plies?: ShellPlies;
}

/** One ply of a stack: its angle from 0° (degrees, counterclockwise seen from outside), material and thickness, mm. */
export interface ShellPly {
  angle: number;
  m: PlyMaterial;
  t: number;
}

/** A wall's plies: a stack laid from the outer surface inward, and more plies inside it over zones. */
export interface ShellPlies {
  plies: ShellPly[];
  /** plies added inside the stack over a region: reinforcement at joints, bearing seats and bolts */
  patches: { region: RegionSpec; plies: ShellPly[]; label: string }[];
  /** the layup as written, for the report: "[0/±45/90]s of T700-class carbon UD" */
  label: string;
  /** where 0° runs (default "auto": along the tubes on a part made of tubes, else along its length) */
  fibre?: FibreRule;
}

/** How a wall's plies came out: the first ply to fail and how, and the factor that breaks fibres. */
export interface ShellPliesResult {
  label: string;
  /** where 0° runs, in words: "along its tubes", "along its length (X)", "along (0, 0, 1)" */
  fibre: string;
  /** the plies through the wall from the outside in (the zones' plies after the stack) */
  stack: { angle: number; material: string; t: number; zone?: string }[];
  /** the base stack's thickness, mm */
  t: number;
  /** first-ply failure (Tsai–Wu): the factor on the loads that cracks the first ply, which ply (from 1), how, where */
  first: { safety: number; ply: number; angle: number; material: string; failure: PlyFailure; at: V3; strength: number };
  /** the factor on the loads at which stress along the fibres reaches their strength, and where */
  fibreSafety: number;
  fibreAt: V3;
  /** each ply's own lowest Tsai–Wu factor and how it would fail */
  perPly: { ply: number; angle: number; material: string; safety: number; failure: PlyFailure; zone?: string }[];
  /** share of the wall's area squeezed thinner than its plies (where two walls meet inside the part) */
  squeezed: number;
  /** share of the area where the 0° direction asked for runs nearly square to the wall, so 0° follows the part there */
  fallback: number;
}

export interface ShellPartResult {
  part: string;
  kind: ShellPart["kind"];
  /** the wall modelled: mean thickness and its range, mm */
  t: number;
  tMin: number;
  tMax: number;
  /** area of the surface the shell lies on, mm² */
  area: number;
  elements: number;
  /** peak von Mises stress on either face, MPa, and where */
  stress: number;
  at: V3;
  safety: number;
  /** a composite wall's plies, when it was given them */
  plies?: ShellPliesResult;
}

export interface ShellResult {
  parts: ShellPartResult[];
  elements: number;
  nodes: number;
  /** joins between shell parts that touch */
  ties: number;
  /** the lowest buckling factor of the loads as given, and the part that moves most in that shape */
  buckling?: { factor: number; part: string };
  /** how the walls were modelled, in words */
  notes: string[];
}

/** A part that is not one wall: when shells were chosen rather than asked for, the solid elements take it. */
export class ShellFallback extends Error {
  constructor(
    message: string,
    readonly part: string,
  ) {
    super(message);
  }
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const AXIS = ["X", "Y", "Z"];
/** a line's direction in words: an axis when it is one */
const lineText = (d: V3) => {
  const k = [0, 1, 2].reduce((b, i) => (Math.abs(d[i]) > Math.abs(d[b]) ? i : b), 0);
  const u = d[k] < 0 ? scale(d, -1) : d;
  return Math.abs(u[k]) > 0.999 ? AXIS[k] : `(${u.map((x) => fmt(x, 2)).join(", ")})`;
};
function fibreWords(f: FibreField): string {
  return f.how === "tubes" ? "along its tubes" : f.how === "length" ? `along its length (${lineText(f.dir)})` : `along ${lineText(f.dir)}`;
}
/** a triangle's stiffness before it is built */
const NO_LOCAL = { K: new Float64Array(0) } as ShellLocal;
const fmt = (x: number, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toString();

interface ShellEl {
  n: [number, number, number];
  part: number;
  t: number;
  fr: ShellFrame;
  loc: ShellLocal;
  /** world stiffness, 18 × 18 */
  Kw: Float64Array;
  /** outward unit normal of the face the shell lies on (the material is behind it) */
  nrm: V3;
  /** how thick the part leaves room for (a laminate meets the one from the other side in the middle), mm */
  room: number;
  /** a composite wall's plies through this triangle */
  lam?: ElPlies;
}

/** the plies through one triangle, from the outside in */
interface ElPlies {
  L: Laminate;
  m: PlyMaterial[];
  /** each ply's angle in the triangle's axes, radians */
  a: Float64Array;
  /** each ply's number in its part's list (the stack, then the zones' plies) */
  idx: Int32Array;
  /** the outer and inner plies' stiffness in the triangle's axes, for the stresses on the faces */
  qTop: Float64Array;
  qBot: Float64Array;
}

interface PartSurf {
  pi: number;
  kind: ShellPart["kind"];
  /** the part's own welded surface, for distances to it */
  full: TriBVH;
  /** the face kept, before and after remeshing */
  side: SurfaceMesh;
  sideT: number[];
  /** each side triangle's room for the wall, mm (Infinity where nothing is behind it) */
  sideRoom: number[];
  mesh: SurfaceMesh;
  meshBvh: TriBVH;
  node0: number;
  el0: number;
  elN: number;
  /** each remeshed triangle's element (−1: too small to keep) */
  elOfTri: Int32Array;
  area: number;
  size: number;
  h: number;
}

export function runShells(inp: StructuralInput, progress: Progress = () => undefined): StructuralResult {
  const t0 = now();
  const warnings: string[] = [];
  const notes: string[] = [];
  progress("Shells: finding the walls", 0.03);

  // ---- each part's wall: the face to model and the thickness behind it ----
  const surfs: PartSurf[] = [];
  for (let pi = 0; pi < inp.parts.length; pi++) {
    const p = inp.parts[pi];
    const sp = p.shell;
    if (!sp) throw new FeaError(`${p.name} is not a thin-walled part, so it cannot be analysed with shells. Analyse the thin parts on their own, or use elements: "solid".`);
    const Pp = p.mesh.positions;
    const lo: V3 = [Infinity, Infinity, Infinity],
      hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < Pp.length; i += 3)
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], Pp[i + c]);
        hi[c] = Math.max(hi[c], Pp[i + c]);
      }
    const size = len(sub(hi, lo));
    if (!(size > 0)) throw new FeaError(`${p.name} has no size to analyse.`);
    const m = weld(Pp, p.mesh.indices, 1e-5 * size + 1e-7);
    // a closed surface listed inside out is turned the right way
    let vol = 0;
    for (let t = 0; t < m.T.length; t += 3) {
      const a = m.T[t] * 3,
        b = m.T[t + 1] * 3,
        c = m.T[t + 2] * 3;
      vol += (m.P[a] * (m.P[b + 1] * m.P[c + 2] - m.P[b + 2] * m.P[c + 1]) - m.P[a + 1] * (m.P[b] * m.P[c + 2] - m.P[b + 2] * m.P[c]) + m.P[a + 2] * (m.P[b] * m.P[c + 1] - m.P[b + 1] * m.P[c])) / 6;
    }
    if (vol < 0)
      for (let t = 0; t < m.T.length; t += 3) {
        const x = m.T[t + 1];
        m.T[t + 1] = m.T[t + 2];
        m.T[t + 2] = x;
      }
    findPatches(m, 30);
    const full = new TriBVH(m.P, m.T);
    let tris: number[];
    let tt: number[];
    let room: number[];
    if (sp.kind === "laminate") {
      // the whole outside, the plies behind it; where the part is thinner than two laminates they meet in the middle
      const plyT = (list: ShellPly[]) => list.reduce((x, q) => x + q.t, 0);
      const wall = sp.plies ? plyT(sp.plies.plies) : (sp.t ?? 1.2);
      // as thick as it gets: with every zone's plies inside the stack
      const reach = wall + (sp.plies?.patches.reduce((x, z) => x + plyT(z.plies), 0) ?? 0);
      tris = [];
      tt = [];
      room = [];
      for (let t = 0; t < m.T.length / 3; t++) {
        const a: V3 = [m.P[3 * m.T[3 * t]], m.P[3 * m.T[3 * t] + 1], m.P[3 * m.T[3 * t] + 2]];
        const b: V3 = [m.P[3 * m.T[3 * t + 1]], m.P[3 * m.T[3 * t + 1] + 1], m.P[3 * m.T[3 * t + 1] + 2]];
        const c: V3 = [m.P[3 * m.T[3 * t + 2]], m.P[3 * m.T[3 * t + 2] + 1], m.P[3 * m.T[3 * t + 2] + 2]];
        const nn = cross(sub(b, a), sub(c, a));
        if (!(len(nn) > 0)) continue;
        const n = norm(nn);
        const g = scale(add(add(a, b), c), 1 / 3);
        const hit = full.ray(add(g, scale(n, -1e-7 * size)), scale(n, -1), 2 * reach + 1e-6, (o) => o === t);
        tris.push(t);
        tt.push(hit ? Math.min(wall, hit.s / 2) : wall);
        room.push(hit ? hit.s / 2 : Infinity);
      }
    } else {
      const side = wallSide(m, full, size, sp.t);
      if ("why" in side) throw new ShellFallback(`${p.name} cannot be modelled as one ${sp.kind === "sheet" ? "sheet" : "thin wall"}: ${side.why}`, p.name);
      tris = side.tris;
      // a sheet is as thick as the sheet it is cut from; a wall as thick as it measures
      tt = sp.kind === "sheet" && sp.t ? side.t.map(() => sp.t!) : side.t;
      room = tt.map(() => Infinity);
    }
    const { mesh: sideMesh } = subSurface(m, tris);
    let area = 0;
    for (let t = 0; t < sideMesh.T.length / 3; t++) {
      const a: V3 = [sideMesh.P[3 * sideMesh.T[3 * t]], sideMesh.P[3 * sideMesh.T[3 * t] + 1], sideMesh.P[3 * sideMesh.T[3 * t] + 2]];
      const b: V3 = [sideMesh.P[3 * sideMesh.T[3 * t + 1]], sideMesh.P[3 * sideMesh.T[3 * t + 1] + 1], sideMesh.P[3 * sideMesh.T[3 * t + 1] + 2]];
      const c: V3 = [sideMesh.P[3 * sideMesh.T[3 * t + 2]], sideMesh.P[3 * sideMesh.T[3 * t + 2] + 1], sideMesh.P[3 * sideMesh.T[3 * t + 2] + 2]];
      area += len(cross(sub(b, a), sub(c, a))) / 2;
    }
    surfs.push({ pi, kind: sp.kind, full, side: sideMesh, sideT: tt, sideRoom: room, mesh: sideMesh, meshBvh: full, node0: 0, el0: 0, elN: 0, elOfTri: new Int32Array(0), area, size, h: 0 });
  }

  // ---- triangles of about the size the resolution asks for (a few thousand corners in all) ----
  const areaAll = surfs.reduce((s, x) => s + x.area, 0);
  const nodesWanted = Math.max(300, Math.min(6000, Math.round(inp.target / 12)));
  const hAll = inp.h ?? Math.sqrt((2 * areaAll) / (Math.sqrt(3) * nodesWanted));
  progress("Shells: laying the triangles", 0.08);
  for (const s of surfs) {
    const tMin = Math.min(...s.sideT);
    s.h = inp.h ?? Math.min(hAll, s.size / 8);
    const hMin = Math.max(0.6 * tMin, s.h / 12);
    const field = sizeField(s.side, s.h, Math.min(hMin, s.h));
    s.mesh = remesh(s.side, field);
    s.meshBvh = new TriBVH(s.mesh.P, s.mesh.T);
  }

  // ---- nodes and elements ----
  const nodeP: number[] = [];
  const nodePart: number[] = [];
  const els: ShellEl[] = [];
  const mats = inp.parts.map((p) => inp.materials[p.material]);
  for (const s of surfs) {
    s.node0 = nodeP.length / 3;
    s.el0 = els.length;
    for (let i = 0; i < s.mesh.P.length; i++) nodeP.push(s.mesh.P[i]);
    for (let v = 0; v < s.mesh.P.length / 3; v++) nodePart.push(s.pi);
    const sideBvh = new TriBVH(s.side.P, s.side.T);
    s.elOfTri = new Int32Array(s.mesh.T.length / 3).fill(-1);
    for (let t = 0; t < s.mesh.T.length / 3; t++) {
      const n: [number, number, number] = [s.node0 + s.mesh.T[3 * t], s.node0 + s.mesh.T[3 * t + 1], s.node0 + s.mesh.T[3 * t + 2]];
      const pa: V3 = [nodeP[3 * n[0]], nodeP[3 * n[0] + 1], nodeP[3 * n[0] + 2]];
      const pb: V3 = [nodeP[3 * n[1]], nodeP[3 * n[1] + 1], nodeP[3 * n[1] + 2]];
      const pc: V3 = [nodeP[3 * n[2]], nodeP[3 * n[2] + 1], nodeP[3 * n[2] + 2]];
      const fr = shellFrame(pa, pb, pc);
      if (!(fr.area > 1e-12 * s.size * s.size)) continue;
      const g = scale(add(add(pa, pb), pc), 1 / 3);
      const hit = sideBvh.nearest(g);
      const tEl = hit ? s.sideT[hit.tri] : s.sideT[0];
      const room = hit ? s.sideRoom[hit.tri] : s.sideRoom[0];
      s.elOfTri[t] = els.length;
      // the stiffness follows once the plies' fibre directions are known
      els.push({ n, part: s.pi, t: tEl, fr, loc: NO_LOCAL, Kw: NO_LOCAL.K, nrm: [fr.R[6], fr.R[7], fr.R[8]], room });
    }
    s.elN = els.length - s.el0;
    if (!s.elN) throw new FeaError(`${inp.parts[s.pi].name} has no surface left to model as a shell.`);
  }
  const nn = nodeP.length / 3;
  const ne = els.length;
  const posOf = (n: number): V3 => [nodeP[3 * n], nodeP[3 * n + 1], nodeP[3 * n + 2]];
  let scaleLen = 0;
  for (let n = 0; n < nn; n++) scaleLen = Math.max(scaleLen, len(posOf(n)));
  const hMean = Math.sqrt((4 * areaAll) / (Math.sqrt(3) * Math.max(1, ne)));
  const hNominal = Math.max(...surfs.map((x) => x.h));

  // per node: the area it stands for, its normal, the wall behind it, and the outline it lies on
  const nArea = new Float64Array(nn);
  const nNrm = new Float64Array(3 * nn);
  const nT = new Float64Array(nn);
  const elsOf: number[][] = Array.from({ length: nn }, () => []);
  els.forEach((e, ei) => {
    for (const v of e.n) {
      nArea[v] += e.fr.area / 3;
      for (let c = 0; c < 3; c++) nNrm[3 * v + c] += (e.fr.area / 3) * e.nrm[c];
      nT[v] += (e.fr.area / 3) * e.t;
      elsOf[v].push(ei);
    }
  });
  for (let v = 0; v < nn; v++) {
    if (nArea[v] > 0) nT[v] /= nArea[v];
    const l = Math.hypot(nNrm[3 * v], nNrm[3 * v + 1], nNrm[3 * v + 2]) || 1;
    for (let c = 0; c < 3; c++) nNrm[3 * v + c] /= l;
  }
  const normalOf = (v: number): V3 => [nNrm[3 * v], nNrm[3 * v + 1], nNrm[3 * v + 2]];
  /** the point behind a node on the wall's other face */
  const backOf = (v: number): V3 => sub(posOf(v), scale(normalOf(v), nT[v]));
  // outline: edges with one triangle; each outline node stands for half its outline edges times the wall
  const edgeCount = new Map<number, number>();
  for (const e of els)
    for (let j = 0; j < 3; j++) {
      const a = e.n[j],
        b = e.n[(j + 1) % 3];
      const k = a < b ? a * nn + b : b * nn + a;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  const rimLen = new Float64Array(nn);
  /** the outline's direction at each outline node */
  const rimDir = new Float64Array(3 * nn);
  for (const [k, c] of edgeCount) {
    if (c !== 1) continue;
    const a = Math.floor(k / nn),
      b = k % nn;
    const d = sub(posOf(b), posOf(a));
    const l = len(d);
    rimLen[a] += l / 2;
    rimLen[b] += l / 2;
    for (const v of [a, b]) {
      // kept pointing one way at a node, whichever way its two edges were listed
      const s = rimDir[3 * v] * d[0] + rimDir[3 * v + 1] * d[1] + rimDir[3 * v + 2] * d[2] < 0 ? -1 : 1;
      for (let c2 = 0; c2 < 3; c2++) rimDir[3 * v + c2] += s * d[c2];
    }
  }
  const tMesh = now();

  // ---- parts that touch are joined where one's wall meets the other ----
  const ties: { a: number; b: number }[] = [];
  if (surfs.length > 1) {
    progress("Shells: joining the parts", 0.2);
    for (let i = 0; i < surfs.length; i++)
      for (let j = 0; j < surfs.length; j++) {
        if (i === j) continue;
        const A = surfs[i],
          B = surfs[j];
        if (i > j && ties.some((t) => nodePart[t.a] === B.pi && nodePart[t.b] === A.pi)) continue;
        const reach = 0.3 + 0.5 * Math.max(...A.sideT, ...B.sideT);
        for (let v = A.node0; v < A.node0 + A.mesh.P.length / 3; v++) {
          const p = posOf(v);
          const d1 = B.full.nearest(p, undefined, reach);
          const d2 = d1 ? d1 : B.full.nearest(backOf(v), undefined, reach);
          if (!d2) continue;
          const hit = B.meshBvh.nearest(d2.q);
          if (!hit) continue;
          const corner = hit.w[0] >= hit.w[1] && hit.w[0] >= hit.w[2] ? 0 : hit.w[1] >= hit.w[2] ? 1 : 2;
          ties.push({ a: v, b: B.node0 + B.mesh.T[3 * hit.tri + corner] });
        }
      }
  }

  // ---- regions → nodes ----
  const partsByName = new Map<string, number[]>();
  inp.parts.forEach((p, i) => {
    partsByName.set(p.name, [...(partsByName.get(p.name) ?? []), i]);
    if (p.group && p.group !== p.name) partsByName.set(p.group, [...(partsByName.get(p.group) ?? []), i]);
  });
  interface Sel {
    nodes: number[];
    w: number[];
    area: number;
    /** a face region (held flat when it is an outline) */
    face: boolean;
    rim: boolean;
    dir?: V3;
    /** triangles under the region and which way the face it is on faces (for pressure) */
    els: { e: number; n: V3 }[];
    /** an edge region's outline direction at each of its nodes, along the outline it covers */
    tau?: Map<number, V3>;
  }
  const inZone = (z: Extract<RegionSpec, { t: "sphere" | "box" | "cyl" }>, p: V3, pad: number): boolean => {
    switch (z.t) {
      case "sphere":
        return len(sub(p, z.at)) <= z.r + pad;
      case "box":
        return Math.abs(p[0] - z.at[0]) <= z.size[0] / 2 + pad && Math.abs(p[1] - z.at[1]) <= z.size[1] / 2 + pad && Math.abs(p[2] - z.at[2]) <= z.size[2] / 2 + pad;
      case "cyl": {
        const ax = norm(z.axis);
        const v = sub(p, z.at);
        const s = dot(v, ax);
        if (s < -pad || s > z.length + pad) return false;
        return len(sub(v, scale(ax, s))) <= z.d / 2 + pad;
      }
    }
  };
  const select = (r: RegionSpec): Sel => {
    const sel: Sel = { nodes: [], w: [], area: 0, face: r.t === "face" || r.t === "extreme", rim: false, els: [] };
    const w = new Map<number, number>();
    if (r.t === "face" || r.t === "extreme") {
      let pis: number[];
      if (r.t === "face") {
        const idx = partsByName.get(r.part);
        if (!idx) throw new FeaError(`face(${r.part}, …): "${r.part}" is not one of the analysed parts (${[...partsByName.keys()].join(", ")}).`);
        pis = idx;
      } else pis = inp.parts.map((_, i) => i);
      const dir = norm(r.dir);
      sel.dir = dir;
      let maxProj = -Infinity;
      for (const pi of pis) {
        const P = inp.parts[pi].mesh.positions;
        for (let i = 0; i < P.length; i += 3) maxProj = Math.max(maxProj, P[i] * dir[0] + P[i + 1] * dir[1] + P[i + 2] * dir[2]);
      }
      const pset = new Set(pis);
      const tol = 0.3 * hMean + 1e-4 * scaleLen;
      // the wall's faces that face dir at the far side, on either face of the wall
      for (let ei = 0; ei < ne; ei++) {
        const e = els[ei];
        if (!pset.has(e.part)) continue;
        const s = dot(e.nrm, dir);
        if (Math.abs(s) <= 0.5) continue;
        const pts = e.n.map((v) => (s > 0 ? posOf(v) : sub(posOf(v), scale(e.nrm, e.t))));
        if (!pts.every((q) => dot(q, dir) >= maxProj - tol)) continue;
        for (const v of e.n) w.set(v, (w.get(v) ?? 0) + e.fr.area / 3);
        sel.area += e.fr.area;
        sel.els.push({ e: ei, n: s > 0 ? e.nrm : scale(e.nrm, -1) });
      }
      // else the wall's edge there (the end of a tube, a flange's edge): its outline
      if (!w.size) {
        sel.rim = true;
        for (let v = 0; v < nn; v++) {
          if (!pset.has(nodePart[v]) || !(rimLen[v] > 0)) continue;
          if (Math.max(dot(posOf(v), dir), dot(backOf(v), dir)) < maxProj - tol) continue;
          w.set(v, rimLen[v] * nT[v]);
          sel.area += rimLen[v] * nT[v];
        }
        // the outline's direction within the region (at a corner, not the other outline leaving it)
        sel.tau = new Map();
        for (const [k, c] of edgeCount) {
          if (c !== 1) continue;
          const a = Math.floor(k / nn),
            b = k % nn;
          if (!w.has(a) || !w.has(b)) continue;
          const d = sub(posOf(b), posOf(a));
          for (const v of [a, b]) {
            const o = sel.tau.get(v);
            sel.tau.set(v, o ? add(o, dot(o, d) < 0 ? scale(d, -1) : d) : d);
          }
        }
      }
    } else {
      for (let v = 0; v < nn; v++) {
        const pad = 0.5 * nT[v] + 0.05 * hMean;
        const p = posOf(v),
          b = backOf(v);
        const inside = (q: V3) => inZone(r, q, pad) && (!r.within || inZone(r.within, q, pad));
        if (!inside(p) && !inside(b)) continue;
        w.set(v, nArea[v]);
        sel.area += nArea[v];
      }
      for (let ei = 0; ei < ne; ei++) if (els[ei].n.every((v) => w.has(v))) sel.els.push({ e: ei, n: els[ei].nrm });
    }
    if (!w.size) throw new FeaError(`${describeRegion(r)} reaches none of the shells' surface, so it holds or loads nothing. Use face(part, dir) on a face or an edge of the wall, or a zone around the place.`);
    for (const [v, x] of w) {
      sel.nodes.push(v);
      sel.w.push(x);
    }
    return sel;
  };

  // ---- composite walls: where each ply's fibres run, the zones' extra plies, then every wall's stiffness ----
  interface PartPlies {
    /** the part's plies in order (the stack, then each zone's), each with its zone and nominal depth to its middle */
    list: { angle: number; m: PlyMaterial; t: number; zone?: string; depth: number }[];
    field: FibreField;
    /** the stack's own thickness, mm */
    t: number;
    squeezedA: number;
    /** how far the plies were stretched or squeezed to fit a measured wall: the mean of |factor − 1| */
    fitted: number;
  }
  const partPlies = new Map<number, PartPlies>();
  for (const s of surfs) {
    const sp = inp.parts[s.pi].shell?.plies;
    if (!sp) continue;
    // 0° on each triangle
    const ids = Array.from({ length: s.elN }, (_, k) => s.el0 + k);
    const field = fibreField(
      {
        corners: Int32Array.from(ids.flatMap((e) => els[e].n)),
        R: Float64Array.from(ids.flatMap((e) => [...els[e].fr.R])),
        xy: Float64Array.from(ids.flatMap((e) => [...els[e].fr.xy])),
        area: Float64Array.from(ids.map((e) => els[e].fr.area)),
        nodeP,
        nodeN: nNrm,
      },
      sp.fibre ?? "auto",
    );
    const list: PartPlies["list"] = [];
    let depth = 0;
    for (const q of sp.plies) {
      list.push({ ...q, depth: depth + q.t / 2 });
      depth += q.t;
    }
    const stackT = depth;
    // the zones' plies, inside the stack: which triangles each covers
    const extra: number[][] = ids.map(() => []);
    const zoneFirst: number[] = [];
    sp.patches.forEach((z, zi) => {
      zoneFirst.push(list.length);
      for (const q of z.plies) {
        list.push({ ...q, zone: z.label, depth: depth + q.t / 2 });
        depth += q.t;
      }
      let sel: Sel;
      try {
        sel = select(z.region);
      } catch (err) {
        if (err instanceof FeaError) throw new FeaError(`The plies of ${z.label} reach none of the walls, so they add nothing. Put their zone around a place on ${inp.parts[s.pi].name}'s wall.`);
        throw err;
      }
      let got = 0;
      for (const { e } of sel.els)
        if (e >= s.el0 && e < s.el0 + s.elN) {
          extra[e - s.el0].push(zi);
          got++;
        }
      if (!got) warnings.push(`The plies of ${z.label} reach none of ${inp.parts[s.pi].name}'s wall, so they add nothing there.`);
    });
    let squeezedA = 0,
      fit = 0;
    ids.forEach((ei, k) => {
      const e = els[ei];
      const mine: { q: ShellPly; idx: number }[] = sp.plies.map((q, i) => ({ q, idx: i }));
      for (const zi of extra[k]) sp.patches[zi].plies.forEach((q, i) => mine.push({ q, idx: zoneFirst[zi] + i }));
      const total = mine.reduce((x, p) => x + p.q.t, 0);
      // a laminate is as thick as its plies, but meets the one from the other side in the middle; a measured wall
      // (or a sheet) keeps its thickness, and the plies are taken to fill it
      let f: number;
      if (s.kind === "laminate") {
        e.t = Math.min(total, e.room);
        f = e.t / total;
        if (f < 0.999) squeezedA += e.fr.area;
      } else {
        f = e.t / total;
        fit += Math.abs(f - 1) * e.fr.area;
      }
      const laid = mine.map((p) => ({ m: p.q.m, t: p.q.t * f, a: field.phi[k] + (p.q.angle * Math.PI) / 180 }));
      const L = laminate(laid);
      e.lam = {
        L,
        m: laid.map((p) => p.m),
        a: Float64Array.from(laid.map((p) => p.a)),
        idx: Int32Array.from(mine.map((p) => p.idx)),
        qTop: qBar(laid[0].m, laid[0].a),
        qBot: qBar(laid[laid.length - 1].m, laid[laid.length - 1].a),
      };
    });
    const areaPart = ids.reduce((x, e) => x + els[e].fr.area, 0);
    partPlies.set(s.pi, { list, field, t: stackT, squeezedA, fitted: areaPart > 0 ? fit / areaPart : 0 });
  }
  for (const e of els) {
    const mat = mats[e.part];
    e.loc = shellLocalK(e.fr.xy, { E: mat.E, nu: mat.nu, z0: -e.t, z1: 0, ...(e.lam ? { abd: e.lam.L } : {}) });
    e.Kw = toWorld18(e.loc.K, e.fr.R);
  }
  if (partPlies.size) {
    // the zones' plies thicken the wall
    nT.fill(0);
    for (const e of els) for (const v of e.n) nT[v] += (e.fr.area / 3) * e.t;
    for (let v = 0; v < nn; v++) if (nArea[v] > 0) nT[v] /= nArea[v];
  }

  // ---- loads ----
  const F = new Float64Array(6 * nn);
  const loadsOut: StructuralResult["loads"] = [];
  const centroid = (sel: Sel): V3 => {
    let c: V3 = [0, 0, 0];
    const tw = sel.w.reduce((a, b) => a + b, 0);
    sel.nodes.forEach((n, i) => (c = add(c, scale(posOf(n), sel.w[i] / tw))));
    return c;
  };
  const spread = (sel: Sel, f: V3, weights = sel.w) => {
    const tw = weights.reduce((a, b) => a + b, 0);
    if (!(tw > 0)) return;
    sel.nodes.forEach((n, i) => {
      for (let k = 0; k < 3; k++) F[6 * n + k] += (f[k] * weights[i]) / tw;
    });
  };
  /** a moment M on the region as forces round its centre: no net force, and exactly M */
  const spreadMoment = (sel: Sel, M: V3) => {
    const c = centroid(sel);
    const S = new Float64Array(9);
    let J = 0;
    const r = sel.nodes.map((n) => sub(posOf(n), c));
    sel.nodes.forEach((_, i) => {
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[3 * a + b] += sel.w[i] * r[i][a] * r[i][b];
      J += sel.w[i] * dot(r[i], r[i]);
    });
    if (!(J > 0)) {
      // a single point: a turn at it
      for (const n of sel.nodes) for (let k = 0; k < 3; k++) F[6 * n + 3 + k] += M[k] / sel.nodes.length;
      return;
    }
    // (J·I − S) α = M in its own axes; what the points cannot carry as forces (a turn about the line they lie on) goes on as turns
    const A = new Float64Array(9);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[3 * a + b] = (a === b ? J : 0) - S[3 * a + b];
    const { val, V } = jacobi(A, 3);
    let al: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      if (!(val[k] > 1e-6 * J)) continue;
      const ev: V3 = [V[k], V[3 + k], V[6 + k]];
      al = add(al, scale(ev, dot(ev, M) / val[k]));
    }
    let got: V3 = [0, 0, 0];
    sel.nodes.forEach((n, i) => {
      const f = scale(cross(al, r[i]), sel.w[i]);
      for (let k = 0; k < 3; k++) F[6 * n + k] += f[k];
      got = add(got, cross(r[i], f));
    });
    const rest = sub(M, got);
    if (len(rest) > 1e-6 * (len(M) + 1e-30)) for (const n of sel.nodes) for (let k = 0; k < 3; k++) F[6 * n + 3 + k] += rest[k] / sel.nodes.length;
  };
  for (const ld of inp.loads) {
    const sel = select(ld.region);
    const c = centroid(sel);
    if (ld.t === "force") {
      spread(sel, ld.f);
      if (ld.from) spreadMoment(sel, cross(sub(ld.from, c), ld.f));
      loadsOut.push({ kind: "force", region: describeRegion(ld.region), at: ld.from ?? c, vector: ld.f, magnitude: len(ld.f), area: sel.area, nodes: sel.nodes.length });
    } else if (ld.t === "bearing") {
      // pressed onto the half of the bore it pushes toward, with a cosine; along the axis, evenly
      const axis = ld.region.t === "cyl" ? norm(ld.region.axis) : null;
      const fAx = axis ? scale(axis, dot(ld.f, axis)) : ([0, 0, 0] as V3);
      const fPerp = sub(ld.f, fAx);
      if (axis && len(fPerp) > 0) {
        const fh = norm(fPerp);
        const at = (ld.region as { at: V3 }).at;
        const ws = sel.nodes.map((n, i) => {
          const v = sub(posOf(n), at);
          const rad = norm(sub(v, scale(axis, dot(v, axis))));
          return sel.w[i] * Math.max(0, dot(rad, fh));
        });
        if (ws.some((x) => x > 0)) spread(sel, fPerp, ws);
        else spread(sel, fPerp);
        spread(sel, fAx);
      } else spread(sel, ld.f);
      loadsOut.push({ kind: "bearing", region: describeRegion(ld.region), at: c, vector: ld.f, magnitude: len(ld.f), area: sel.area, nodes: sel.nodes.length });
    } else if (ld.t === "pressure") {
      let total: V3 = [0, 0, 0];
      if (sel.els.length) {
        for (const { e, n } of sel.els) {
          const f = scale(n, -ld.p * els[e].fr.area);
          total = add(total, f);
          for (const v of els[e].n) for (let k = 0; k < 3; k++) F[6 * v + k] += f[k] / 3;
        }
      } else {
        if (!sel.dir) throw new FeaError(`pressure() on ${describeRegion(ld.region)} finds no face of the wall to press on. Use face(part, dir).`);
        total = scale(sel.dir, -ld.p * sel.area);
        spread(sel, total);
      }
      loadsOut.push({ kind: "pressure", region: describeRegion(ld.region), at: c, vector: total, magnitude: len(total), area: sel.area, nodes: sel.nodes.length });
    } else if (ld.t === "torque") {
      const ax = norm(ld.axis);
      spreadMoment(sel, scale(ax, ld.torque));
      loadsOut.push({ kind: "torque", region: describeRegion(ld.region), at: ld.at ?? c, vector: [0, 0, 0], magnitude: ld.torque, area: sel.area, nodes: sel.nodes.length, axis: ax });
    }
  }
  // the walls' own weight (and what they carry) under gravity or an acceleration
  let gravity: StructuralResult["gravity"] = null;
  let massKg = 0;
  let volume = 0;
  const elMass = els.map((e) => (e.lam ? e.lam.L.rhoT : mats[e.part].density * e.t) * 1e-6 * e.fr.area);
  els.forEach((e, ei) => {
    massKg += elMass[ei];
    volume += e.t * e.fr.area;
  });
  if (inp.accel) {
    const a = inp.accel;
    let mt = 0;
    let c: V3 = [0, 0, 0];
    els.forEach((e, ei) => {
      const me = elMass[ei];
      for (const v of e.n) for (let k = 0; k < 3; k++) F[6 * v + k] += (me / 3) * a[k] * G0;
      mt += me;
      c = add(c, scale(add(add(posOf(e.n[0]), posOf(e.n[1])), posOf(e.n[2])), me / 3));
    });
    for (const ms of inp.masses ?? []) {
      const sel = select(ms.region);
      const kg = ms.grams / 1000;
      spread(sel, scale(a, kg * G0));
      mt += kg;
      c = add(c, scale(centroid(sel), kg));
    }
    if (mt > 0) gravity = { vector: scale(a, mt * G0), at: scale(c, 1 / mt) };
  }

  // ---- supports ----
  interface Hold {
    n: V3;
    val: number;
    sup: number;
  }
  const holds: Hold[][][] = Array.from({ length: nn }, () => [[], []]);
  const springs: { n: number; k: number; dir?: V3; sup: number }[] = [];
  const supportSel: Sel[] = [];
  const supWarn = new Set<string>();
  const perp = (d: V3): [V3, V3] => {
    const a: V3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const p = norm(cross(d, a));
    return [p, cross(d, p)];
  };
  inp.supports.forEach((s, si) => {
    const sel = select(s.region);
    supportSel.push(sel);
    const dir = s.dir ? norm(s.dir) : undefined;
    if (s.spring) {
      const tw = sel.w.reduce((a, b) => a + b, 0);
      sel.nodes.forEach((n, i) => {
        if (s.spring!.perArea !== undefined) springs.push({ n, k: s.spring!.perArea * sel.w[i], dir: dir ?? normalOf(n), sup: si });
        else springs.push({ n, k: ((s.spring!.rate ?? 0) * sel.w[i]) / tw, ...(dir ? { dir } : {}), sup: si });
      });
      return;
    }
    if (s.contact) supWarn.add("Seats that are only pressed on (contact:) are taken as held both ways in shells.");
    if (s.pin && !s.pin.tight) supWarn.add("Pins are taken as tight in shells (held all round the bore, free to turn).");
    for (const n of sel.nodes) {
      const T = holds[n][0],
        Rt = holds[n][1];
      if (s.pin && s.region.t === "cyl") {
        // the bore's wall held across the pin, each point toward the axis; along it unless it slides; free to turn
        const ax = norm(s.region.axis);
        const v = sub(posOf(n), s.region.at);
        const radial = sub(v, scale(ax, dot(v, ax)));
        if (len(radial) > 1e-9) T.push({ n: norm(radial), val: 0, sup: si });
        else {
          const [p1, p2] = perp(ax);
          T.push({ n: p1, val: 0, sup: si }, { n: p2, val: 0, sup: si });
        }
        if (!s.pin.slide) T.push({ n: ax, val: 0, sup: si });
        continue;
      }
      const mv = s.move ?? [0, 0, 0];
      if (dir) {
        T.push({ n: dir, val: dot(mv, dir), sup: si });
        // an edge of the wall held along dir: every point of it (along the outline and through the wall) keeps its
        // place along dir, so the edge cannot turn in any way that would move one of them along dir
        if (sel.rim) {
          const tau = norm(sel.tau?.get(n) ?? [rimDir[3 * n], rimDir[3 * n + 1], rimDir[3 * n + 2]]);
          for (const a of [cross(tau, dir), cross(normalOf(n), dir)]) if (len(a) > 0.2) Rt.push({ n: norm(a), val: 0, sup: si });
        }
      } else {
        T.push({ n: [1, 0, 0], val: mv[0], sup: si }, { n: [0, 1, 0], val: mv[1], sup: si }, { n: [0, 0, 1], val: mv[2], sup: si });
        Rt.push({ n: [1, 0, 0], val: 0, sup: si }, { n: [0, 1, 0], val: 0, sup: si }, { n: [0, 0, 1], val: 0, sup: si });
      }
    }
  });
  warnings.push(...supWarn);
  const fixedVal = new Float64Array(6 * nn);
  const isFixed = new Uint8Array(6 * nn);
  const penalties: { n: number; kind: number; dir: V3; val: number }[] = [];
  const supOfNode = new Int32Array(nn).fill(-1);
  for (let n = 0; n < nn; n++)
    for (let kind = 0; kind < 2; kind++) {
      // the held directions made independent: one nearly along another (two supports, or an edge's two rules, holding
      // the same turn) is the same hold, and must not lock the direction between them
      const basis: Hold[] = [];
      for (const h of holds[n][kind]) {
        if (supOfNode[n] < 0) supOfNode[n] = h.sup;
        let v = h.n;
        let val = h.val;
        for (const b of basis) {
          const c = dot(v, b.n);
          v = sub(v, scale(b.n, c));
          val -= c * b.val;
        }
        const l = len(v);
        if (l < 0.3) continue;
        v = scale(v, 1 / l);
        val /= l;
        const ax = v.findIndex((x) => Math.abs(x) > 1 - 1e-4);
        if (ax >= 0) {
          const sg = Math.sign(v[ax]);
          v = [0, 0, 0];
          v[ax] = sg;
        }
        basis.push({ n: v, val, sup: h.sup });
      }
      for (const h of basis) {
        const k = h.n.findIndex((x) => Math.abs(x) === 1);
        if (k >= 0) {
          const dof = 6 * n + 3 * kind + k;
          isFixed[dof] = 1;
          fixedVal[dof] = h.val * h.n[k];
        } else penalties.push({ n, kind, dir: h.n, val: h.val });
      }
    }
  for (const s of springs) if (supOfNode[s.n] < 0) supOfNode[s.n] = s.sup;

  // every part must reach a support, through its own wall or the parts it is joined to
  {
    const adj: number[][] = Array.from({ length: nn }, () => []);
    for (const e of els)
      for (let j = 0; j < 3; j++) {
        adj[e.n[j]].push(e.n[(j + 1) % 3]);
        adj[e.n[(j + 1) % 3]].push(e.n[j]);
      }
    for (const t of ties) adj[t.a].push(t.b), adj[t.b].push(t.a);
    const seen = new Uint8Array(nn);
    const q: number[] = [];
    for (let n = 0; n < nn; n++) if (supOfNode[n] >= 0) (seen[n] = 1), q.push(n);
    for (let h = 0; h < q.length; h++) for (const t of adj[q[h]]) if (!seen[t]) (seen[t] = 1), q.push(t);
    const loose = surfs.filter((s) => !seen[s.node0]).map((s) => inp.parts[s.pi].name);
    if (loose.length) throw new FeaError(`${loose.join(", ")} ${loose.length > 1 ? "are" : "is"} not held: nothing holds ${loose.length > 1 ? "them" : "it"}, and ${loose.length > 1 ? "they do" : "it does"} not touch a part that is held. Hold ${loose.length > 1 ? "them" : "it"} too.`);
  }

  // ---- the equations ----
  progress("Shells: building the equations", 0.3);
  const extra: [number, number][] = ties.map((t) => [t.a, t.b]);
  const { ptr, idx } = nodeLinks(
    nn,
    els.map((e) => e.n),
    extra,
  );
  const sys = new BlockSystem(nn, 6, nodeP, ptr, idx);
  const K = sys.matrix();
  const rhs = new Float64Array(6 * nn);
  for (let g = 0; g < 6 * nn; g++) rhs[g] = F[g];
  const kc = new Float64Array(18 * 18);
  const dofs = new Int32Array(18);
  let diagSum = 0,
    diagN = 0;
  /** each freedom's own stiffness, before any holds */
  const diagK = new Float64Array(6 * nn);
  for (const e of els) for (let a = 0; a < 3; a++) for (let k = 0; k < 6; k++) diagK[6 * e.n[a] + k] += e.Kw[19 * (6 * a + k)];
  for (const e of els) {
    for (let a = 0; a < 3; a++) for (let k = 0; k < 6; k++) dofs[6 * a + k] = 6 * e.n[a] + k;
    kc.set(e.Kw);
    for (let i = 0; i < 18; i++) {
      if (isFixed[dofs[i]]) continue;
      for (let j = 0; j < 18; j++) if (isFixed[dofs[j]]) rhs[dofs[i]] -= e.Kw[18 * i + j] * fixedVal[dofs[j]];
    }
    for (let i = 0; i < 18; i++)
      if (isFixed[dofs[i]])
        for (let j = 0; j < 18; j++) {
          kc[18 * i + j] = 0;
          kc[18 * j + i] = 0;
        }
    for (let i = 0; i < 18; i++)
      if (i % 6 < 3) {
        diagSum += e.Kw[19 * i];
        diagN++;
      }
    K.addElement(e.n, kc);
  }
  const dScale = diagN ? diagSum / diagN : 1;
  for (let g = 0; g < 6 * nn; g++)
    if (isFixed[g]) {
      K.addEntry(Math.floor(g / 6), g % 6, Math.floor(g / 6), g % 6, dScale);
      rhs[g] = dScale * fixedVal[g];
    }
  // oblique holds as stiff springs, springs, and the joins between parts
  const kPenOf = (n: number, kind: number) => 1e5 * Math.max(diagK[6 * n + 3 * kind], diagK[6 * n + 3 * kind + 1], diagK[6 * n + 3 * kind + 2], 1e-30);
  const addBlock3 = (n: number, kind: number, M: number[], val: V3 | null) => {
    for (let i = 0; i < 3; i++) {
      const gi = 6 * n + 3 * kind + i;
      if (isFixed[gi]) continue;
      if (val) rhs[gi] += val[i];
      for (let j = 0; j < 3; j++) {
        const gj = 6 * n + 3 * kind + j;
        if (isFixed[gj] || M[3 * i + j] === 0) continue;
        K.addEntry(n, 3 * kind + i, n, 3 * kind + j, i === j ? M[3 * i + j] : M[3 * i + j] / 2);
      }
    }
  };
  const outer = (d: V3, k: number) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => k * d[i] * d[j]));
  for (const p of penalties) {
    const k = kPenOf(p.n, p.kind);
    addBlock3(p.n, p.kind, outer(p.dir, k), scale(p.dir, k * p.val));
  }
  for (const s of springs) addBlock3(s.n, 0, s.dir ? outer(s.dir, s.k) : [s.k, 0, 0, 0, s.k, 0, 0, 0, s.k], null);
  const kTie = 1e3 * dScale;
  for (const t of ties)
    for (let k = 0; k < 3; k++) {
      const ga = 6 * t.a + k,
        gb = 6 * t.b + k;
      if (!isFixed[ga]) K.addEntry(t.a, k, t.a, k, kTie);
      if (!isFixed[gb]) K.addEntry(t.b, k, t.b, k, kTie);
      if (!isFixed[ga] && !isFixed[gb]) K.addEntry(t.a, k, t.b, k, -kTie);
      else if (isFixed[gb] && !isFixed[ga]) rhs[ga] += kTie * fixedVal[gb];
      else if (isFixed[ga] && !isFixed[gb]) rhs[gb] += kTie * fixedVal[ga];
    }
  const tSetup = now();
  progress("Shells: solving", 0.4);
  const fac = factorBlocks(K);
  if (!fac.ok) {
    const n = Math.floor(fac.dof / 6),
      k = fac.dof % 6;
    throw new FeaError(
      `${inp.parts[nodePart[n]].name} is not held enough: it can ${k < 3 ? `move along ${AXIS[k]}` : `turn about ${AXIS[k - 3]}`} near (${posOf(n).map((x) => fmt(x)).join(", ")}) without bending. Hold it more firmly (fix: rather than a roller), or add a support.`,
    );
  }
  const U = Float64Array.from(rhs);
  fac.solve(U);
  for (let g = 0; g < 6 * nn; g++) if (isFixed[g]) U[g] = fixedVal[g];
  const tSolve = now();
  progress("Shells: stresses", 0.6);

  // ---- internal forces and reactions ----
  const Fint = new Float64Array(6 * nn);
  const dw = new Float64Array(18);
  const ql: Float64Array[] = [];
  for (const e of els) {
    for (let a = 0; a < 3; a++) for (let k = 0; k < 6; k++) dw[6 * a + k] = U[6 * e.n[a] + k];
    for (let i = 0; i < 18; i++) {
      let s = 0;
      for (let j = 0; j < 18; j++) s += e.Kw[18 * i + j] * dw[j];
      Fint[6 * e.n[Math.floor(i / 6)] + (i % 6)] += s;
    }
    const q = new Float64Array(18);
    toLocal18(dw, e.fr.R, q);
    ql.push(q);
  }
  // the joins pull the parts together like any spring inside the model
  for (const t of ties)
    for (let k = 0; k < 3; k++) {
      const f = kTie * (U[6 * t.a + k] - U[6 * t.b + k]);
      Fint[6 * t.a + k] += f;
      Fint[6 * t.b + k] -= f;
    }
  const Fspring = new Float64Array(6 * nn);
  for (const s of springs)
    for (let i = 0; i < 3; i++) {
      let v = 0;
      for (let j = 0; j < 3; j++) v += (s.dir ? s.k * s.dir[i] * s.dir[j] : i === j ? s.k : 0) * U[6 * s.n + j];
      Fspring[6 * s.n + i] += v;
    }
  let resid = 0,
    fmax = 0;
  const held = new Uint8Array(nn);
  for (let n = 0; n < nn; n++) if (holds[n][0].length || holds[n][1].length) held[n] = 1;
  for (let g = 0; g < 6 * nn; g++) {
    fmax = Math.max(fmax, Math.abs(F[g]));
    if (!held[Math.floor(g / 6)]) resid = Math.max(resid, Math.abs(Fint[g] + Fspring[g] - F[g]));
  }
  const residual = fmax > 0 ? resid / fmax : 0;
  const supportsOut: StructuralResult["supports"] = inp.supports.map((s, si) => {
    const sel = supportSel[si];
    const R: V3 = [0, 0, 0];
    for (const n of sel.nodes) {
      if (supOfNode[n] !== si) continue;
      for (let k = 0; k < 3; k++) R[k] += s.spring ? -Fspring[6 * n + k] : Fint[6 * n + k] + Fspring[6 * n + k] - F[6 * n + k];
    }
    const at = centroid(sel);
    const markers = new Float32Array(3 * sel.nodes.length);
    sel.nodes.forEach((n, i) => markers.set(posOf(n), 3 * i));
    let give = 0;
    if (s.spring) {
      for (const n of sel.nodes) give += s.dir ? Math.abs(dot([U[6 * n], U[6 * n + 1], U[6 * n + 2]], norm(s.dir))) : Math.hypot(U[6 * n], U[6 * n + 1], U[6 * n + 2]);
      give /= sel.nodes.length;
    }
    return {
      region: describeRegion(s.region),
      ...(s.dir ? { dir: norm(s.dir) } : {}),
      at,
      nodes: sel.nodes.length,
      reaction: R,
      markers,
      ...(s.spring ? { kind: "spring" as const, spring: { ...(s.spring.rate !== undefined ? { rate: s.spring.rate } : {}), ...(s.spring.perArea !== undefined ? { perArea: s.spring.perArea } : {}), give } } : {}),
      ...(s.move ? { kind: "move" as const, moved: s.move } : {}),
      ...(s.pin
        ? {
            kind: "pin" as const,
            pin: {
              tight: true,
              slide: s.pin.slide,
              share: 1,
              pressure: s.region.t === "cyl" && s.region.d * s.region.length > 0 ? len(R) / (s.region.d * s.region.length) : 0,
              d: s.region.t === "cyl" ? s.region.d : 0,
              length: s.region.t === "cyl" ? s.region.length : 0,
              axis: norm(s.region.t === "cyl" ? s.region.axis : (s.dir ?? [0, 0, 1])),
              rounds: 0,
            },
          }
        : {}),
    };
  });
  const applied: V3 = [0, 0, 0];
  for (let n = 0; n < nn; n++) for (let k = 0; k < 3; k++) applied[k] += F[6 * n + k];
  const reaction: V3 = [0, 0, 0];
  for (const s of supportsOut) for (let k = 0; k < 3; k++) reaction[k] += s.reaction[k];
  const equilibrium = len(applied) > 1e-9 ? len(add(applied, reaction)) / len(applied) : 0;

  // ---- stresses on both faces, averaged to the nodes ----
  // per node and face (0: the face the shell lies on, 1: the other): the stress and strain tensors in world axes
  const nS = new Float64Array(12 * nn);
  const nE = new Float64Array(12 * nn);
  const nW = new Float64Array(nn);
  const memN: Float64Array[] = [];
  const st = new Float64Array(6);
  const CORNER_L: [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const tensor = (R: Float64Array, s: [number, number, number], out: Float64Array, o: number, w: number, shear2 = 1) => {
    // in-plane (σx, σy, τxy) in the triangle's axes → world xx yy zz xy yz zx
    const e1: V3 = [R[0], R[1], R[2]],
      e2: V3 = [R[3], R[4], R[5]];
    const [sx, sy, txy] = [s[0], s[1], s[2] / shear2];
    const comp = (i: number, j: number) => sx * e1[i] * e1[j] + sy * e2[i] * e2[j] + txy * (e1[i] * e2[j] + e2[i] * e1[j]);
    out[o] += w * comp(0, 0);
    out[o + 1] += w * comp(1, 1);
    out[o + 2] += w * comp(2, 2);
    out[o + 3] += w * comp(0, 1);
    out[o + 4] += w * comp(1, 2);
    out[o + 5] += w * comp(2, 0);
  };
  // composite walls: per node and ply (the part's own list), the Tsai–Wu utilisation and the stress along the fibres
  // over their strength, each the worse of the ply's top and bottom, averaged over the triangles round the node
  const plyOff = new Int32Array(nn + 1);
  for (let v = 0; v < nn; v++) plyOff[v + 1] = plyOff[v] + (partPlies.get(nodePart[v])?.list.length ?? 0);
  const plyU = new Float64Array(plyOff[nn]),
    plyF = new Float64Array(plyOff[nn]),
    plyW = new Float64Array(plyOff[nn]),
    plyTop = new Float64Array(plyOff[nn]);
  const plyMode = new Uint8Array(plyOff[nn]);
  const pc = newPlyCheck();
  els.forEach((e, ei) => {
    const mat = mats[e.part];
    const Q = planeQ(mat.E, mat.nu);
    const nuz = mat.nu / (1 - mat.nu);
    const lam = e.lam;
    for (let a = 0; a < 3; a++) {
      shellStrains(e.loc, CORNER_L[a], ql[ei], st);
      const v = e.n[a];
      const w = e.fr.area;
      nW[v] += w;
      if (lam)
        for (let k = 0; k < lam.m.length; k++) {
          let u = 0,
            f = 0,
            mode = 0;
          for (let side = 0; side < 2; side++) {
            const z = lam.L.z[k + side];
            plyCheck(lam.m[k], st[0] + z * st[3], st[1] + z * st[4], st[2] + z * st[5], lam.a[k], pc);
            if (pc.u > u) {
              u = pc.u;
              mode = pc.mode;
            }
            f = Math.max(f, pc.f);
          }
          const j = plyOff[v] + lam.idx[k];
          plyU[j] += w * u;
          plyF[j] += w * f;
          plyW[j] += w;
          if (u > plyTop[j]) {
            plyTop[j] = u;
            plyMode[j] = mode;
          }
        }
      for (let face = 0; face < 2; face++) {
        const z = face ? -e.t : 0;
        const ex = st[0] + z * st[3],
          ey = st[1] + z * st[4],
          gxy = st[2] + z * st[5];
        // a laminate's faces are its outer and inner plies, at their own angles
        const q = lam ? (face ? lam.qBot : lam.qTop) : Q;
        const s: [number, number, number] = [q[0] * ex + q[1] * ey + q[2] * gxy, q[3] * ex + q[4] * ey + q[5] * gxy, q[6] * ex + q[7] * ey + q[8] * gxy];
        tensor(e.fr.R, s, nS, 12 * v + 6 * face, w);
        const ez = -nuz * (ex + ey);
        tensor(e.fr.R, [ex, ey, gxy], nE, 12 * v + 6 * face, w, 2);
        // through the wall (along the normal)
        const nrm = e.nrm;
        const zz = (i: number, j: number) => ez * nrm[i] * nrm[j];
        const o = 12 * v + 6 * face;
        nE[o] += w * zz(0, 0);
        nE[o + 1] += w * zz(1, 1);
        nE[o + 2] += w * zz(2, 2);
        nE[o + 3] += w * zz(0, 1);
        nE[o + 4] += w * zz(1, 2);
        nE[o + 5] += w * zz(2, 0);
      }
    }
    // membrane forces per width at the centre, for buckling
    shellStrains(e.loc, [1 / 3, 1 / 3, 1 / 3], ql[ei], st);
    if (lam) {
      const { A, B } = lam.L;
      const N = new Float64Array(3);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) N[r] += A[3 * r + c] * st[c] + B[3 * r + c] * st[3 + c];
      memN.push(N);
      return;
    }
    const t = e.t;
    const a1 = t,
      b1 = -(t * t) / 2;
    const ex = a1 * st[0] + b1 * st[3],
      ey = a1 * st[1] + b1 * st[4],
      gxy = a1 * st[2] + b1 * st[5];
    memN.push(new Float64Array([Q[0] * ex + Q[1] * ey, Q[3] * ex + Q[4] * ey, Q[8] * gxy]));
  });
  for (let v = 0; v < nn; v++) {
    if (!(nW[v] > 0)) continue;
    for (let k = 0; k < 12; k++) {
      nS[12 * v + k] /= nW[v];
      nE[12 * v + k] /= nW[v];
    }
  }
  // per node: its worst ply's utilisation (and which ply, and how it fails) and its worst stress along the fibres
  const nodeU = new Float64Array(nn),
    nodeF = new Float64Array(nn);
  const nodePly = new Int32Array(nn);
  for (let v = 0; v < nn; v++)
    for (let j = plyOff[v]; j < plyOff[v + 1]; j++) {
      if (!(plyW[j] > 0)) continue;
      const u = plyU[j] / plyW[j],
        f = plyF[j] / plyW[j];
      if (u > nodeU[v]) {
        nodeU[v] = u;
        nodePly[v] = j - plyOff[v];
      }
      nodeF[v] = Math.max(nodeF[v], f);
    }
  const cycles = inp.cycles;
  const allow = inp.materials.map((m) => allowableStress(m, cycles));
  const vmN = new Float64Array(2 * nn);
  const epN = new Float64Array(2 * nn);
  const largestStrain = (o: number) => {
    const p = principal(nE[o], nE[o + 1], nE[o + 2], nE[o + 3], nE[o + 4], nE[o + 5]);
    return Math.abs(p[0]) >= Math.abs(p[2]) ? p[0] : p[2];
  };
  for (let v = 0; v < nn; v++)
    for (let face = 0; face < 2; face++) {
      vmN[2 * v + face] = vonMises(nS, 12 * v + 6 * face);
      epN[2 * v + face] = largestStrain(12 * v + 6 * face);
    }
  // per part: peaks on either face
  const partOut: ShellPartResult[] = surfs.map((s) => {
    let stress = 0,
      at: V3 = posOf(s.node0);
    for (let v = s.node0; v < s.node0 + s.mesh.P.length / 3; v++)
      for (let face = 0; face < 2; face++)
        if (vmN[2 * v + face] > stress) {
          stress = vmN[2 * v + face];
          at = face ? backOf(v) : posOf(v);
        }
    const ts = els.slice(s.el0, s.el0 + s.elN).map((e) => e.t);
    const area = els.slice(s.el0, s.el0 + s.elN).reduce((x, e) => x + e.fr.area, 0);
    const tMean = els.slice(s.el0, s.el0 + s.elN).reduce((x, e) => x + e.t * e.fr.area, 0) / area;
    const al = allow[inp.parts[s.pi].material].value;
    const out: ShellPartResult = { part: inp.parts[s.pi].name, kind: s.kind, t: tMean, tMin: Math.min(...ts), tMax: Math.max(...ts), area, elements: s.elN, stress, at, safety: stress > 0 ? Math.min(al / stress, 1e6) : 1e6 };
    const pp = partPlies.get(s.pi);
    if (!pp) return out;
    // the first ply to fail, each ply's own worst, and the worst stress along the fibres
    let worst = 0,
      wv = s.node0,
      fWorst = 0,
      fv = s.node0;
    const per = pp.list.map(() => ({ u: 0, mode: 0 }));
    for (let v = s.node0; v < s.node0 + s.mesh.P.length / 3; v++) {
      if (nodeU[v] > worst) {
        worst = nodeU[v];
        wv = v;
      }
      if (nodeF[v] > fWorst) {
        fWorst = nodeF[v];
        fv = v;
      }
      for (let k = 0; k < pp.list.length; k++) {
        const j = plyOff[v] + k;
        if (!(plyW[j] > 0)) continue;
        const u = plyU[j] / plyW[j];
        if (u > per[k].u) per[k] = { u, mode: plyMode[j] };
      }
    }
    const k = nodePly[wv];
    const q = pp.list[k];
    const failure = PLY_FAILURES[per[k].mode];
    const sf = (u: number) => (u > 0 ? Math.min(1 / u, 1e6) : 1e6);
    out.safety = sf(worst);
    out.plies = {
      label: inp.parts[s.pi].shell!.plies!.label,
      fibre: fibreWords(pp.field),
      stack: pp.list.map((p) => ({ angle: p.angle, material: p.m.label, t: p.t, ...(p.zone ? { zone: p.zone } : {}) })),
      t: pp.t,
      first: { safety: out.safety, ply: k + 1, angle: q.angle, material: q.m.label, failure, strength: failureStrength(q.m, failure), at: sub(posOf(wv), scale(normalOf(wv), Math.min(q.depth, nT[wv]))) },
      fibreSafety: sf(fWorst),
      fibreAt: posOf(fv),
      perPly: pp.list.map((p, i) => ({ ply: i + 1, angle: p.angle, material: p.m.label, safety: sf(per[i].u), failure: PLY_FAILURES[per[i].mode], ...(p.zone ? { zone: p.zone } : {}) })),
      squeezed: area > 0 ? pp.squeezedA / area : 0,
      fallback: pp.field.fallback,
    };
    return out;
  });

  // ---- fields on the parts' own surfaces ----
  const ranges: StructuralResult["ranges"] = { stress: [Infinity, -Infinity], disp: [0, 0], strain: [Infinity, -Infinity], safety: [Infinity, -Infinity] };
  let maxDisp = { value: 0, at: [0, 0, 0] as V3 };
  let maxStress = { value: 0, at: [0, 0, 0] as V3 };
  let maxStrain = { value: 0, at: [0, 0, 0] as V3 };
  let minSafety: SafetyAt = { value: Infinity, at: [0, 0, 0], mode: allow[0].basis, allowable: allow[0].value, material: inp.materials[0].name };
  const tensorAt = (verts: number[], wts: V3, face: number, f: number, out: Float64Array) => {
    out.fill(0);
    for (let k = 0; k < 3; k++)
      for (let c = 0; c < 6; c++) {
        const v = verts[k];
        const top = nS[12 * v + c],
          bot = nS[12 * v + 6 + c];
        out[c] += wts[k] * (face < 0 ? (1 - f) * top + f * bot : face ? bot : top);
      }
  };
  const tmpS = new Float64Array(6);
  /** a point's movement from the shell's corners: their moves, plus their turns carrying the point off the face */
  const moveAt = (field: Float64Array, verts: number[], wts: V3, off: V3): V3 => {
    let u: V3 = [0, 0, 0],
      th: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = verts[k];
      u = add(u, scale([field[6 * v], field[6 * v + 1], field[6 * v + 2]], wts[k]));
      th = add(th, scale([field[6 * v + 3], field[6 * v + 4], field[6 * v + 5]], wts[k]));
    }
    return add(u, cross(th, off));
  };
  const surfOfPart = new Map<number, PartSurf>();
  for (const s of surfs) surfOfPart.set(s.pi, s);
  interface Spot {
    verts: number[];
    w: V3;
    off: V3;
    /** -1: between the faces at depth f, 0: the shell's face, 1: the other */
    face: number;
    f: number;
  }
  const spots: Spot[][] = [];
  const partsOut: PartField[] = inp.parts.map((p, pi) => {
    const s = surfOfPart.get(pi)!;
    const P = p.mesh.positions;
    const nv = P.length / 3;
    const disp = new Float32Array(3 * nv),
      stress = new Float32Array(nv),
      strain = new Float32Array(nv),
      safety = new Float32Array(nv).fill(1e6);
    const al = allow[p.material].value;
    const plied = partPlies.has(pi);
    const sp: Spot[] = [];
    for (let v = 0; v < nv; v++) {
      const q: V3 = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
      const hit = s.meshBvh.nearest(q);
      if (!hit) {
        sp.push({ verts: [s.node0, s.node0, s.node0], w: [1, 0, 0], off: [0, 0, 0], face: 0, f: 0 });
        continue;
      }
      const verts = [0, 1, 2].map((k) => s.node0 + s.mesh.T[3 * hit.tri + k]);
      const ei = s.elOfTri[hit.tri];
      const e = ei >= 0 ? els[ei] : undefined;
      const nrm = e ? e.nrm : normalOf(verts[0]);
      const t = e ? e.t : nT[verts[0]];
      const off = sub(q, hit.q);
      const z = dot(off, nrm);
      // a laminate's outside shows the worse of its two faces; a sheet shows the face the point is on
      const face = s.kind === "laminate" ? -2 : z > -0.25 * t ? 0 : z < -0.75 * t ? 1 : -1;
      const f = Math.max(0, Math.min(1, -z / Math.max(t, 1e-9)));
      sp.push({ verts, w: hit.w, off, face, f });
    }
    spots.push(sp);
    for (let v = 0; v < nv; v++) {
      const { verts, w, off, face, f } = sp[v];
      const u = moveAt(U, verts, w, off);
      disp[3 * v] = u[0];
      disp[3 * v + 1] = u[1];
      disp[3 * v + 2] = u[2];
      let vm: number, ep: number;
      if (face === -2) {
        tensorAt(verts, w, 0, 0, tmpS);
        const a = vonMises(tmpS);
        tensorAt(verts, w, 1, 0, tmpS);
        const b = vonMises(tmpS);
        vm = Math.max(a, b);
        const ea = w[0] * epN[2 * verts[0]] + w[1] * epN[2 * verts[1]] + w[2] * epN[2 * verts[2]];
        const eb = w[0] * epN[2 * verts[0] + 1] + w[1] * epN[2 * verts[1] + 1] + w[2] * epN[2 * verts[2] + 1];
        ep = Math.abs(ea) >= Math.abs(eb) ? ea : eb;
      } else {
        tensorAt(verts, w, face, f, tmpS);
        vm = vonMises(tmpS);
        const fr = face < 0 ? f : face;
        const ea = w[0] * epN[2 * verts[0]] + w[1] * epN[2 * verts[1]] + w[2] * epN[2 * verts[2]];
        const eb = w[0] * epN[2 * verts[0] + 1] + w[1] * epN[2 * verts[1] + 1] + w[2] * epN[2 * verts[2] + 1];
        ep = (1 - fr) * ea + fr * eb;
      }
      stress[v] = vm;
      strain[v] = ep;
      if (plied) {
        const u = w[0] * nodeU[verts[0]] + w[1] * nodeU[verts[1]] + w[2] * nodeU[verts[2]];
        safety[v] = u > 0 ? Math.min(1 / u, 1e6) : 1e6;
      } else safety[v] = vm > 0 ? Math.min(al / vm, 1e6) : 1e6;
      const q: V3 = [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
      const dm = len(u);
      if (dm > maxDisp.value) maxDisp = { value: dm, at: q };
      if (Math.abs(ep) > Math.abs(maxStrain.value)) maxStrain = { value: ep, at: q };
    }
    for (let v = 0; v < nv; v++) {
      ranges.disp[1] = Math.max(ranges.disp[1], Math.hypot(disp[3 * v], disp[3 * v + 1], disp[3 * v + 2]));
      ranges.stress[0] = Math.min(ranges.stress[0], stress[v]);
      ranges.stress[1] = Math.max(ranges.stress[1], stress[v]);
      ranges.strain[0] = Math.min(ranges.strain[0], strain[v]);
      ranges.strain[1] = Math.max(ranges.strain[1], strain[v]);
      ranges.safety[0] = Math.min(ranges.safety[0], safety[v]);
      ranges.safety[1] = Math.max(ranges.safety[1], safety[v]);
    }
    return { id: p.id, name: p.name, positions: Float32Array.from(P), normals: p.normals ?? null, indices: p.mesh.indices, disp, stress, strain, safety };
  });
  // the walls' own peaks count (a display vertex may sit between the nodes where it peaks)
  for (const po of partOut) {
    const pi = inp.parts.findIndex((p) => p.name === po.part);
    if (po.stress > maxStress.value) maxStress = { value: po.stress, at: po.at };
    if (po.safety < minSafety.value) {
      const mi = inp.parts[pi].material;
      const f = po.plies?.first;
      minSafety = f
        ? { value: po.safety, at: f.at, mode: "ply", allowable: f.strength, material: f.material, ply: { index: f.ply, angle: f.angle, failure: f.failure } }
        : { value: po.safety, at: po.at, mode: allow[mi].basis, allowable: allow[mi].value, material: inp.materials[mi].name };
    }
  }
  for (let n = 0; n < nn; n++) {
    const dm = Math.hypot(U[6 * n], U[6 * n + 1], U[6 * n + 2]);
    if (dm > maxDisp.value) maxDisp = { value: dm, at: posOf(n) };
  }
  ranges.disp[1] = Math.max(ranges.disp[1], maxDisp.value);
  ranges.stress[1] = Math.max(ranges.stress[1], maxStress.value);
  // hot spots: the highest stresses, at least a few elements apart
  const hotSpots: StructuralResult["hotSpots"] = [];
  {
    // how hard each node is worked: its stress over the allowable, or a composite wall's worst ply
    const utilOf = (v: number, sv: number) => (partPlies.has(nodePart[v]) ? nodeU[v] : sv / allow[inp.parts[nodePart[v]].material].value);
    const cand = [...Array(nn).keys()].map((v) => {
      const sv = Math.max(vmN[2 * v], vmN[2 * v + 1]);
      return { v, s: sv, u: utilOf(v, sv) };
    });
    cand.sort((a, b) => (partPlies.size ? b.u - a.u : b.s - a.s));
    for (const c of cand) {
      if (hotSpots.length >= 5 || !(c.s > 0) || !(c.u > 0)) break;
      const p = vmN[2 * c.v] >= vmN[2 * c.v + 1] ? posOf(c.v) : backOf(c.v);
      if (hotSpots.some((h) => len(sub(h.at, p)) < 4 * hMean)) continue;
      hotSpots.push({ at: p, stress: c.s, safety: Math.min(1 / c.u, 1e6) });
    }
  }
  let maxTurn = 0;
  for (let n = 0; n < nn; n++) maxTurn = Math.max(maxTurn, Math.hypot(U[6 * n + 3], U[6 * n + 4], U[6 * n + 5]));
  if (maxTurn > 0.17)
    warnings.push(`The wall turns up to ${fmt((maxTurn * 180) / Math.PI, 0)}° under these loads, which is past what a small-deflection solve follows; treat the stresses and deflection as rough.`);
  const tPost = now();

  // ---- buckling: K + λ·Kg singular, Kg from the walls' in-plane forces ----
  let buckling: BucklingResult | undefined;
  let shellBuckling: ShellResult["buckling"];
  const loaded = inp.loads.length > 0 || !!inp.accel;
  // pressed somewhere: an element whose smaller in-plane force is a real push
  let nScale = 0;
  for (const N of memN) nScale = Math.max(nScale, Math.abs(N[0]), Math.abs(N[1]), Math.abs(N[2]));
  const pressed = memN.some((N) => {
    const c = (N[0] + N[1]) / 2,
      r = Math.hypot((N[0] - N[1]) / 2, N[2]);
    return c - r < -0.05 * nScale;
  });
  if (pressed && loaded) {
    progress("Shells: buckling", 0.75);
    const tb = now();
    const want = Math.max(1, inp.buckling?.modes ?? 1);
    const Kg = sys.matrix();
    const kg = new Float64Array(18 * 18);
    els.forEach((e, ei) => {
      const kl = shellLocalKg(e.loc, memN[ei]);
      const kw = toWorld18(kl, e.fr.R);
      for (let a = 0; a < 3; a++) for (let k = 0; k < 6; k++) dofs[6 * a + k] = 6 * e.n[a] + k;
      kg.set(kw);
      for (let i = 0; i < 18; i++)
        if (isFixed[dofs[i]])
          for (let j = 0; j < 18; j++) {
            kg[18 * i + j] = 0;
            kg[18 * j + i] = 0;
          }
      Kg.addElement(e.n, kg);
    });
    // asked for: the modes to full accuracy; otherwise a quick look at the lowest, for a warning when it is near
    // the quick look starts from the bent shape (a pushed wall's first ripple often follows it) and stops at 1 %;
    // near the warning it goes on (a short subspace run only ever overestimates the factor)
    let res = inp.buckling ? subspace(Kg, fac.solve, 6 * nn, want, 2 * want + 6, 80, 1e-7, [U]) : subspace(Kg, fac.solve, 6 * nn, 1, 3, 10, 1e-2, [U]);
    const quick = res.mus.find((m) => m > 0);
    if (!inp.buckling && quick && 1 / quick < 6 && !res.converged) res = subspace(Kg, fac.solve, 6 * nn, 1, 4, 30, 1e-3, res.X);
    const factors = res.mus.filter((m) => m > 0).slice(0, want).map((m) => 1 / m);
    const neg = res.mus.filter((m) => m < 0);
    const reversed = neg.length ? 1 / -Math.min(...neg) : null;
    const shapes = res.X.slice(0, factors.length);
    const peaks: V3[] = [];
    for (const sh of shapes) {
      let best = 0,
        at: V3 = [0, 0, 0],
        bp = "";
      for (let n = 0; n < nn; n++) {
        const dm = Math.hypot(sh[6 * n], sh[6 * n + 1], sh[6 * n + 2]);
        if (dm > best) {
          best = dm;
          at = posOf(n);
          bp = inp.parts[nodePart[n]].name;
        }
      }
      peaks.push(at);
      if (!shellBuckling && factors.length) shellBuckling = { factor: factors[0], part: bp };
    }
    if (inp.buckling) {
      buckling = { factors, peaks, reversed, iterations: res.iterations, converged: res.converged, ms: now() - tb };
      partsOut.forEach((pf, pi) => {
        const sp = spots[pi];
        pf.modes = shapes.map((sh) => {
          let mx = 0;
          for (let n = 0; n < nn; n++) mx = Math.max(mx, Math.hypot(sh[6 * n], sh[6 * n + 1], sh[6 * n + 2]));
          const out = new Float32Array(3 * sp.length);
          sp.forEach((x, v) => {
            const u = moveAt(sh, x.verts, x.w, x.off);
            for (let k = 0; k < 3; k++) out[3 * v + k] = mx > 0 ? u[k] / mx : 0;
          });
          return out;
        });
      });
    } else if (shellBuckling && shellBuckling.factor < 3)
      warnings.push(
        `${shellBuckling.part} would buckle at ${shellBuckling.factor.toFixed(2)}× these loads: thin walls that are pushed or sheared ripple and fold long before the material gives. Add buckling to the analysis to see the shape, and stiffen the wall there (a bend, a rib or a thicker wall).`,
      );
  }

  // ---- notes ----
  const lam = partOut.filter((p) => p.kind === "laminate");
  const sheets = partOut.filter((p) => p.kind !== "laminate");
  const tText = (p: ShellPartResult) => (p.tMax - p.tMin > 0.05 * p.t ? `${fmt(p.tMin, 2)} to ${fmt(p.tMax, 2)} mm` : `${fmt(p.t, 2)} mm`);
  const tris = (p: ShellPartResult) => `${p.elements.toLocaleString("en")} shell triangles`;
  const zoneWords = (p: ShellPliesResult) => {
    const zones = [...new Set(p.stack.filter((q) => q.zone).map((q) => q.zone!))];
    return zones.length ? `, with more plies in ${zones.join(", ")}` : "";
  };
  for (const p of lam)
    notes.push(
      p.plies
        ? `${p.part} as its plies under its outer surface: ${p.plies.label}, ${fmt(p.plies.t, 2)} mm, 0° ${p.plies.fibre}${zoneWords(p.plies)} (${tris(p)})`
        : `${p.part} as a ${tText(p)} laminate under its outer surface (${tris(p)})`,
    );
  for (const p of sheets)
    notes.push(
      p.plies
        ? `${p.part} as its ${tText(p)} ${p.kind === "sheet" ? "sheet" : "wall"} on one face, laid as ${p.plies.label} with 0° ${p.plies.fibre}${zoneWords(p.plies)} (${tris(p)})`
        : `${p.part} as its ${tText(p)} ${p.kind === "sheet" ? "sheet" : "wall"} on one face (${tris(p)})`,
    );
  if (lam.some((p) => !p.plies))
    notes.push("the laminate is taken as even and quasi-isotropic: its plies' directions are not modelled (give them with layup:), and the factory builds it up at joints and bearing seats, so stresses there come out higher than in the real part");
  if (partOut.some((p) => p.plies))
    notes.push(
      "each ply is checked at its top and bottom by Tsai–Wu against typical strengths for its material: its first crack (first-ply failure), usually in the resin and well before fibres break. A data sheet's values for the prepreg bought replace them for sign-off. Stress between the plies (interlaminar shear, and peel at edges and joints) and the cure's own stresses are not modelled",
    );
  for (const p of partOut) {
    const q = p.plies;
    if (!q) continue;
    if (q.squeezed > 0.01) notes.push(`where ${p.part}'s walls meet inside it (${fmt(q.squeezed * 100, 0)} % of its area) its plies are taken thinner, to fit`);
    const pp = partPlies.get(inp.parts.findIndex((x) => x.name === p.part));
    if (p.kind !== "laminate" && pp && pp.fitted > 0.1) notes.push(`${p.part}'s plies add to ${fmt(pp.t, 2)} mm; they are taken as thick as its ${tText(p)} wall`);
    if (q.fallback > 0.02)
      warnings.push(`The 0° direction asked for runs nearly square to ${p.part}'s wall over ${fmt(q.fallback * 100, 0)} % of it; its 0° plies follow the part there instead. Give fibre: a direction that lies along the wall.`);
  }
  if (ties.length) notes.push(`the parts are joined where they touch (${ties.length} points), as if bonded`);
  if (residual > 1e-6) warnings.push(`The shell solve left a residual of ${residual.toExponential(1)}; a part may be close to moving freely somewhere.`);

  // a material only plied walls use is their plies
  const plyNames = (i: number) => {
    const users = inp.parts.flatMap((p, pi) => (p.material === i ? [pi] : []));
    if (!users.length || !users.every((pi) => partPlies.has(pi))) return null;
    return `plies of ${[...new Set(users.flatMap((pi) => partPlies.get(pi)!.list.map((q) => q.m.label)))].join(" and ")}`;
  };
  const materials = inp.materials.map((m: MechMaterial, i) => ({ name: plyNames(i) ?? m.name, E: m.E, yield: m.yield, allowable: allow[i].value, basis: allow[i].basis, layerFactor: m.layerFactor, assumed: !!m.assumed }));
  if (inp.parts.some((p) => p.print)) warnings.push("Printed layers are not modelled in shells: the walls are taken as solid material.");
  const tEnd = now();
  progress("Shells: done", 1);
  return {
    label: inp.label,
    // the size asked for (the largest triangles): curved and narrow places are finer; an accuracy check refines from it
    mesh: { h: hNominal, cell: [hMean, hMean, hMean], grid: [ne, 0, 0], elements: ne, nodes: nn, dofs: 6 * nn, levels: 0, partial: 0 },
    solve: { iterations: 1, residual, converged: residual < 1e-6, history: [residual], ms: { mesh: tMesh - t0, setup: tSetup - tMesh, solve: tSolve - tSetup, post: tPost - tSolve, total: tEnd - t0 } },
    maxDisp,
    maxStress: { ...maxStress, nearBoundary: false, away: null },
    maxStrain,
    minSafety: { ...minSafety, value: Number.isFinite(minSafety.value) ? minSafety.value : 1e6, nearBoundary: false, away: null },
    layer: null,
    hotSpots,
    applied,
    reaction,
    equilibrium,
    mass: massKg * 1000,
    volume,
    loads: loadsOut,
    supports: supportsOut,
    gravity,
    parts: partsOut,
    ranges,
    warnings,
    materials,
    ...(buckling ? { buckling } : {}),
    shells: { parts: partOut, elements: ne, nodes: nn, ties: ties.length, ...(shellBuckling ? { buckling: shellBuckling } : {}), notes },
  };
}

/**
 * The few largest μ of K⁻¹(−Kg) by subspace iteration (1/μ are the lowest buckling factors), with K-orthonormal
 * vectors kept apart by Gram–Schmidt and a Rayleigh–Ritz step on each round.
 */
function subspace(Kg: BlockMatrix, solve: (x: Float64Array) => void, n: number, want: number, size: number, maxIt: number, tol: number, start: Float64Array[] = []): { mus: number[]; X: Float64Array[]; iterations: number; converged: boolean } {
  const q = Math.min(n, size);
  const dotv = (a: Float64Array, b: Float64Array) => {
    let t = 0;
    for (let j = 0; j < n; j++) t += a[j] * b[j];
    return t;
  };
  const seed = (i: number) => {
    const v = new Float64Array(n);
    for (let j = 0; j < n; j++) v[j] = Math.sin(1.3 * (j + 1) * (i + 1) + 0.4 * i) + 0.3 * Math.cos(0.7 * j * (i + 1) + i);
    return v;
  };
  let X: Float64Array[] = [...Array(q).keys()].map((i) => (i < start.length && start[i].some((x) => x !== 0) ? Float64Array.from(start[i]) : seed(i)));
  let seeds = q;
  const tmp = new Float64Array(n);
  let mus: number[] = [];
  let prev: number[] = [];
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIt; iterations++) {
    const Q: Float64Array[] = [],
      KQ: Float64Array[] = [];
    for (const xv of X) {
      Kg.mul(xv, tmp);
      const ky = new Float64Array(n);
      for (let j = 0; j < n; j++) ky[j] = -tmp[j];
      const y = Float64Array.from(ky);
      solve(y);
      const n0 = dotv(y, ky);
      for (let pass = 0; pass < 2; pass++)
        for (let j = 0; j < Q.length; j++) {
          const c = dotv(KQ[j], y);
          for (let t = 0; t < n; t++) {
            y[t] -= c * Q[j][t];
            ky[t] -= c * KQ[j][t];
          }
        }
      const n2 = dotv(y, ky);
      if (!(n2 > 1e-12 * Math.abs(n0)) || !(n2 > 0)) continue;
      const sc = 1 / Math.sqrt(n2);
      for (let t = 0; t < n; t++) {
        y[t] *= sc;
        ky[t] *= sc;
      }
      Q.push(y);
      KQ.push(ky);
    }
    const qq = Q.length;
    if (!qq) break;
    const Ar = new Float64Array(qq * qq);
    for (let j = 0; j < qq; j++) {
      Kg.mul(Q[j], tmp);
      for (let i = 0; i <= j; i++) Ar[i * qq + j] = Ar[j * qq + i] = -dotv(Q[i], tmp);
    }
    const { val, V } = jacobi(Ar, qq);
    const ord = [...val.keys()].sort((a, b) => val[b] - val[a]);
    mus = ord.map((i) => val[i]);
    X = ord.map((ci) => {
      const v = new Float64Array(n);
      for (let a = 0; a < qq; a++) {
        const za = V[a * qq + ci];
        if (za === 0) continue;
        const y = Q[a];
        for (let t = 0; t < n; t++) v[t] += za * y[t];
      }
      let mx = 0;
      for (let t = 0; t < n; t++) mx = Math.max(mx, Math.abs(v[t]));
      if (mx > 0) for (let t = 0; t < n; t++) v[t] /= mx;
      return v;
    });
    while (X.length < q) X.push(seed(seeds++));
    const pos = mus.filter((m) => m > 0).slice(0, want);
    if (prev.length === pos.length && pos.every((m, i) => Math.abs(m - prev[i]) <= tol * Math.abs(m)) && (pos.length || iterations > 8)) {
      converged = true;
      iterations++;
      break;
    }
    prev = pos;
  }
  return { mus, X, iterations, converged };
}

/** eigenvalues and vectors (columns of V) of a small symmetric matrix, by Jacobi rotations */
function jacobi(A0: Float64Array, n: number): { val: number[]; V: Float64Array } {
  const A = Float64Array.from(A0);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i * n + j] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const th = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p],
            akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k],
            aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p],
            vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  return { val: [...Array(n).keys()].map((i) => A[i * n + i]), V };
}
