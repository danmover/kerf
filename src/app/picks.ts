// What is picked in the 3D view below the level of whole parts: faces, edges
// and corners, chosen with the selection filter (Q) or by dragging a box
// (B). A pick knows its part and a point on it in the part's own
// coordinates, so it can be written as a selector, near(point, 0.2) (less on a thin face), for a
// fillet, a chamfer or Claude, and kept as a named selection set.

import { create } from "zustand";
import type { MeshData } from "../kernel/build";
import type { V3 } from "../kernel/recipe";
import type { Model } from "../core/model";
import { fmtNum } from "../lang/values";

export type PickFilter = "part" | "face" | "edge" | "vertex";
export const FILTERS: PickFilter[] = ["part", "face", "edge", "vertex"];
export const FILTER_WORD: Record<PickFilter, string> = { part: "parts", face: "faces", edge: "edges", vertex: "corners" };

export interface Pick {
  partId: string;
  kind: "face" | "edge" | "vertex";
  /** the face's or edge's id in the mesh (a corner: the edge it ends) */
  id?: number;
  /** a point on it in the part's own coordinates: inside a face, along an edge away from its ends, or the corner itself */
  at: V3;
  /** the face's index range or the edge's point range in `data` */
  range?: [number, number];
  /** the mesh it was picked on (its ids and ranges belong to this mesh) */
  data?: MeshData;
}

interface PickState {
  filter: PickFilter;
  /** dragging in the view draws a selection box instead of turning the view */
  box: boolean;
  picks: Pick[];
}

export const usePicks = create<PickState>(() => ({ filter: "part", box: false, picks: [] }));

/** Pick parts, faces, edges or corners. Going back to parts drops the finer picks. */
export function setFilter(filter: PickFilter) {
  usePicks.setState((s) => ({ filter, picks: filter === "part" ? [] : s.picks }));
}

export function cycleFilter(back = false) {
  const i = FILTERS.indexOf(usePicks.getState().filter);
  setFilter(FILTERS[(i + (back ? FILTERS.length - 1 : 1)) % FILTERS.length]);
}

export const toggleBox = (on = !usePicks.getState().box) => usePicks.setState({ box: on });
export const setPicks = (picks: Pick[]) => usePicks.setState({ picks });
export const clearPicks = () => usePicks.setState({ picks: [] });

export const samePick = (a: Pick, b: Pick) => a.partId === b.partId && a.kind === b.kind && Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]) < 1e-6;

/** Add picks to the list, or with `toggle` take back ones already there. */
export function addPicks(more: Pick[], toggle: boolean) {
  const cur = usePicks.getState().picks;
  let next = [...cur];
  for (const p of more) {
    const i = next.findIndex((q) => samePick(q, p) || (q.partId === p.partId && q.kind === p.kind && q.range && p.range && q.range[0] === p.range[0] && q.data === p.data));
    if (i >= 0) {
      if (toggle) next = next.filter((_, k) => k !== i);
    } else next.push(p);
  }
  setPicks(next);
}

// ---------- where a pick is ----------

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The point a selector names a pick by: inside a face (the middle of the
 * triangle farthest from the face's edges, so near() catches it and not its
 * neighbours, even on a thin chamfer), the middle of an edge (a point along
 * it, not an end), or the corner itself.
 */
export function anchorOf(kind: Pick["kind"], at: V3, range: [number, number] | undefined, data: MeshData | undefined): V3 {
  if (!data || !range || kind === "vertex") return at.map(r3) as V3;
  if (kind === "face") return (faceSpot(range, data)?.p ?? at).map(r3) as V3;
  // an edge: its points in order, then the one nearest half way along
  const E = data.edges;
  const pts: V3[] = [];
  for (let k = range[0]; k + 1 < range[0] + range[1]; k += 2) {
    if (k === range[0]) pts.push([E[k * 3], E[k * 3 + 1], E[k * 3 + 2]]);
    pts.push([E[(k + 1) * 3], E[(k + 1) * 3 + 1], E[(k + 1) * 3 + 2]]);
  }
  if (pts.length < 2) return at.map(r3) as V3;
  if (pts.length === 2) return pts[0].map((v, i) => r3((v + pts[1][i]) / 2)) as V3;
  const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]));
  const total = lens.reduce((s, l) => s + l, 0);
  let run = 0;
  for (let i = 0; i < lens.length; i++) {
    if (run + lens[i] >= total / 2) {
      const t = lens[i] > 0 ? (total / 2 - run) / lens[i] : 0;
      return pts[i].map((v, k) => r3(v + (pts[i + 1][k] - v) * t)) as V3;
    }
    run += lens[i];
  }
  return pts[pts.length - 1].map(r3) as V3;
}

/** How far near() reaches for a pick: 0.2 mm, less on a face so thin its neighbours are closer, at most 0.25 (a coarse mesh of a big curve can sit 0.22 mm off it). */
function reachOf(p: Pick): number {
  if (p.kind !== "face" || !p.range || !p.data) return 0.2;
  const clear = faceSpot(p.range, p.data)?.clear;
  return clear === undefined ? 0.2 : Math.min(0.25, Math.max(0.02, Math.round(clear * 40) / 100));
}

const spots = new WeakMap<MeshData, Map<number, { p: V3; clear: number } | null>>();

/**
 * Inside a face: the middle of its triangle farthest from the face's edges (the triangle sides used once), and how
 * far that is. Big faces are sampled, about 400 triangles. Kept per mesh.
 */
function faceSpot(range: [number, number], data: MeshData): { p: V3; clear: number } | null {
  let byStart = spots.get(data);
  if (!byStart) spots.set(data, (byStart = new Map()));
  const known = byStart.get(range[0]);
  if (known !== undefined) return known;
  const P = data.positions;
  const I = data.indices;
  const key = (v: number) => `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`;
  const sides = new Map<string, { a: number; b: number; n: number }>();
  const tris: number[] = [];
  for (let i = range[0]; i + 2 < range[0] + range[1]; i += 3) {
    tris.push(i);
    for (const [a, b] of [[I[i], I[i + 1]], [I[i + 1], I[i + 2]], [I[i + 2], I[i]]]) {
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const s = sides.get(k);
      if (s) s.n++;
      else sides.set(k, { a, b, n: 1 });
    }
  }
  const rim = [...sides.values()].filter((s) => s.n === 1);
  let best: { p: V3; clear: number } | null = null;
  const step = Math.max(1, Math.ceil(tris.length / 400));
  for (let t = 0; t < tris.length; t += step) {
    const i = tris[t];
    const c: V3 = [0, 1, 2].map((k) => (P[I[i] * 3 + k] + P[I[i + 1] * 3 + k] + P[I[i + 2] * 3 + k]) / 3) as V3;
    let d = Infinity;
    for (const s of rim) {
      d = Math.min(d, segDist(c, P, s.a * 3, s.b * 3));
      if (best && d <= best.clear) break;
    }
    if (!best || d > best.clear) best = { p: c, clear: d };
  }
  byStart.set(range[0], best);
  return best;
}

function segDist(p: V3, P: Float32Array, a: number, b: number): number {
  const ab: V3 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const ap: V3 = [p[0] - P[a], p[1] - P[a + 1], p[2] - P[a + 2]];
  const L = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = L > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

const vec = (v: V3) => `(${v.map((x) => fmtNum(Math.abs(x) < 5e-4 ? 0 : x, 3)).join(", ")})`;

/** The selector for some picks on one part: near(point, reach), or a list of them. */
export function selectorFor(picks: Pick[]): string {
  const one = (p: Pick) => `near(${vec(anchorOf(p.kind, p.at, p.range, p.data))}, ${fmtNum(reachOf(p), 2)})`;
  return picks.length === 1 ? one(picks[0]) : `[${picks.map(one).join(", ")}]`;
}

/** Picks gathered by the part block they belong to (a pattern's copies share one block). */
export function picksByBlock(model: Model | null, picks: Pick[]): { block: string; label: string; local: boolean; picks: Pick[] }[] {
  const out = new Map<string, { block: string; label: string; local: boolean; picks: Pick[] }>();
  for (const p of picks) {
    const part = model?.parts.find((q) => q.id === p.partId);
    if (!part) continue;
    const g = out.get(part.name) ?? { block: part.name, label: part.label, local: part.kind === "part", picks: [] };
    g.picks.push(p);
    out.set(part.name, g);
  }
  return [...out.values()];
}

const KIND_WORD: Record<Pick["kind"], [string, string]> = { face: ["face", "faces"], edge: ["edge", "edges"], vertex: ["corner", "corners"] };

/** "2 edges and a face" */
export function countText(picks: Pick[]): string {
  const parts = (["face", "edge", "vertex"] as const)
    .map((k) => [k, picks.filter((p) => p.kind === k).length] as const)
    .filter(([, n]) => n)
    .map(([k, n]) => (n === 1 ? `1 ${KIND_WORD[k][0]}` : `${n} ${KIND_WORD[k][1]}`));
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "nothing");
}

/** For Claude: what the user has picked in the view, as selectors per part. */
export function picksSummary(model: Model | null): string {
  const { picks, filter } = usePicks.getState();
  if (!picks.length) return "";
  const groups = picksByBlock(model, picks.slice(0, 40));
  const text = groups.map((g) => {
    const kinds = (["face", "edge", "vertex"] as const).filter((k) => g.picks.some((p) => p.kind === k));
    return kinds.map((k) => `${g.block}: ${countText(g.picks.filter((p) => p.kind === k))} ${selectorFor(g.picks.filter((p) => p.kind === k))}`).join("; ");
  });
  return `The user has picked in the 3D view (selection filter: ${FILTER_WORD[filter]}): ${text.join("; ")}. The points are in each part's own coordinates; use the selectors as they are for edges:, faces: or open: (fillet(1, edges: near(...)) on that part).`;
}

// ---------- named selection sets ----------

export interface SelectionSet {
  name: string;
  /** whole parts, by instance id */
  parts?: string[];
  /** faces, edges and corners, by part and point */
  picks?: { partId: string; kind: Pick["kind"]; at: V3 }[];
}

const KEY = (design: string) => `kerf.selectionSets.${design}`;

export function savedSets(design: string): SelectionSet[] {
  try {
    const s = localStorage.getItem(KEY(design));
    const v = s ? (JSON.parse(s) as unknown) : [];
    return Array.isArray(v) ? (v as SelectionSet[]).filter((x) => x && typeof x.name === "string") : [];
  } catch {
    return [];
  }
}

export const useSets = create<{ version: number }>(() => ({ version: 0 }));

export function saveSet(design: string, set: SelectionSet) {
  const list = savedSets(design).filter((s) => s.name !== set.name);
  list.push(set);
  try {
    localStorage.setItem(KEY(design), JSON.stringify(list));
  } catch {
    // a full or private store: the set lasts until the page reloads
  }
  useSets.setState((s) => ({ version: s.version + 1 }));
}

export function deleteSet(design: string, name: string) {
  try {
    localStorage.setItem(KEY(design), JSON.stringify(savedSets(design).filter((s) => s.name !== name)));
  } catch {
    // nothing to do
  }
  useSets.setState((s) => ({ version: s.version + 1 }));
}

/**
 * Find a saved pick on the part's current mesh: the face whose triangle is
 * nearest the point, the edge whose segment is, or the corner. Null when
 * nothing is within `tol` (the part changed too much).
 */
export function resolvePick(partId: string, kind: Pick["kind"], at: V3, data: MeshData, tol = 0.25): Pick | null {
  const near2 = (x: number, y: number, z: number) => (x - at[0]) ** 2 + (y - at[1]) ** 2 + (z - at[2]) ** 2;
  if (kind === "face") {
    const fg = data.faceGroups;
    if (!fg) return null;
    const P = data.positions;
    const I = data.indices;
    let best = Infinity;
    let range: [number, number] | undefined;
    let id: number | undefined;
    for (let g = 0; g < fg.length; g += 3) {
      for (let i = fg[g]; i + 2 < fg[g] + fg[g + 1]; i += 3) {
        const d = triDist2(at, P, I[i] * 3, I[i + 1] * 3, I[i + 2] * 3);
        if (d < best) {
          best = d;
          range = [fg[g], fg[g + 1]];
          id = fg[g + 2];
        }
      }
    }
    return range && best <= tol * tol ? { partId, kind, id, at, range, data } : null;
  }
  const eg = data.edgeGroups;
  if (!eg) return null;
  const E = data.edges;
  let best = Infinity;
  let range: [number, number] | undefined;
  let id: number | undefined;
  for (let g = 0; g < eg.length; g += 3) {
    const start = eg[g];
    const count = eg[g + 1];
    if (kind === "vertex") {
      for (const k of [start, start + count - 1]) {
        const d = near2(E[k * 3], E[k * 3 + 1], E[k * 3 + 2]);
        if (d < best) {
          best = d;
          range = [start, count];
          id = eg[g + 2];
        }
      }
      continue;
    }
    for (let k = start; k + 1 < start + count; k += 2) {
      const d = segDist2(at, E, k * 3, (k + 1) * 3);
      if (d < best) {
        best = d;
        range = [start, count];
        id = eg[g + 2];
      }
    }
  }
  return range && best <= tol * tol ? { partId, kind, id: kind === "vertex" ? undefined : id, at, range, data } : null;
}

function segDist2(p: V3, A: Float32Array, a: number, b: number): number {
  const dx = A[b] - A[a];
  const dy = A[b + 1] - A[a + 1];
  const dz = A[b + 2] - A[a + 2];
  const l2 = dx * dx + dy * dy + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - A[a]) * dx + (p[1] - A[a + 1]) * dy + (p[2] - A[a + 2]) * dz) / l2)) : 0;
  return (A[a] + dx * t - p[0]) ** 2 + (A[a + 1] + dy * t - p[1]) ** 2 + (A[a + 2] + dz * t - p[2]) ** 2;
}

/** Squared distance from p to a triangle (corners at offsets a, b, c in P). */
function triDist2(p: V3, P: Float32Array, a: number, b: number, c: number): number {
  const A: V3 = [P[a], P[a + 1], P[a + 2]];
  const ab: V3 = [P[b] - A[0], P[b + 1] - A[1], P[b + 2] - A[2]];
  const ac: V3 = [P[c] - A[0], P[c + 1] - A[1], P[c + 2] - A[2]];
  const ap: V3 = [p[0] - A[0], p[1] - A[1], p[2] - A[2]];
  const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  // the plane's foot, kept inside the triangle by its barycentric weights
  const d00 = dot(ab, ab);
  const d01 = dot(ab, ac);
  const d11 = dot(ac, ac);
  const d20 = dot(ap, ab);
  const d21 = dot(ap, ac);
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-18) return Math.min(segDist2(p, P, a, b), segDist2(p, P, a, c), segDist2(p, P, b, c));
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  if (v >= 0 && w >= 0 && v + w <= 1) {
    const q: V3 = [A[0] + ab[0] * v + ac[0] * w, A[1] + ab[1] * v + ac[1] * w, A[2] + ab[2] * v + ac[2] * w];
    return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
  }
  return Math.min(segDist2(p, P, a, b), segDist2(p, P, a, c), segDist2(p, P, b, c));
}
