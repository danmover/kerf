// Proves from their surface meshes that two placed solids cannot overlap, so
// the interference check can skip the exact boolean for them. A boolean with
// long helical faces (a screw flight) takes seconds even when the other part
// sits well clear, inside the flight's bounding box; the meshes show the gap
// in a millisecond. Pairs that come close still get the exact boolean.

import { TriBVH } from "../mfg/bvh";
import { weld } from "../persist/meshFormats";
import { applyXforms, type Xform } from "./recipe";
import type { MeshData } from "./build";

/**
 * How far apart the two meshes must stay (mm). Preview meshes are asked to
 * keep within 0.25 mm of the true surface and in practice stray up to about
 * 0.5 mm (knurls, fillets), so this leaves twice what two meshes together can be off by.
 */
export const APART_GAP = 2;

/** A solid's surface as one welded, closed triangle mesh (in the part's own coordinates). */
export interface Surface {
  positions: number[];
  triangles: number[];
  /** one triangle of each separate piece of the mesh, for the inside test */
  pieces: number[];
}

/** A surface placed in the world, indexed for apart(). */
export interface PlacedSurface {
  mesh: TriBVH;
  pieces: number[];
}

/** The welded surface of a solid's mesh, or null when it is not closed (a face that failed to mesh): an open mesh proves nothing. */
export function closedSurface(mesh: MeshData): Surface | null {
  const { positions, triangles } = weld(mesh);
  if (!triangles.length) return null;
  const n = positions.length / 3;
  // each edge of a closed surface is shared by an even number of triangles (two, or four where solids meet along an edge)
  const edges = new Map<number, number>();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  for (const c of edges.values()) if (c % 2) return null;
  // triangles sharing a corner belong to the same piece
  const root = Array.from({ length: n }, (_, i) => i);
  const find = (i: number) => {
    while (root[i] !== i) i = root[i] = root[root[i]];
    return i;
  };
  for (let t = 0; t < triangles.length; t += 3) {
    root[find(triangles[t + 1])] = find(triangles[t]);
    root[find(triangles[t + 2])] = find(triangles[t]);
  }
  const seen = new Set<number>();
  const pieces: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const r = find(triangles[t]);
    if (!seen.has(r)) {
      seen.add(r);
      pieces.push(t / 3);
    }
  }
  return { positions, triangles, pieces };
}

/** The surface moved to where the part is placed, indexed for apart(). */
export function placeSurface(s: Surface, xf: Xform[]): PlacedSurface {
  const pos = new Float64Array(s.positions.length);
  for (let i = 0; i < pos.length; i += 3) {
    const q = applyXforms([s.positions[i], s.positions[i + 1], s.positions[i + 2]], xf);
    pos[i] = q[0];
    pos[i + 1] = q[1];
    pos[i + 2] = q[2];
  }
  return { mesh: new TriBVH(pos, s.triangles), pieces: s.pieces };
}

// a point counts as inside when a ray along any of these says so, so one
// unlucky ray (grazing an edge) can only cost a boolean, never miss an overlap
const RAYS = [
  [0.5773, 0.5774, 0.5772],
  [-0.6, 0.48, 0.64],
  [0.36, -0.8, 0.48],
];

/**
 * Whether two placed closed surfaces are certainly apart: no triangle of one
 * comes within APART_GAP of the other, and neither solid is inside the other.
 */
export function apart(a: PlacedSurface, b: PlacedSurface): boolean {
  if (a.mesh.near(b.mesh, APART_GAP)) return false;
  // clear of each other's surfaces, so each piece is either separate or wholly inside the other
  return !inside(b, a) && !inside(a, b);
}

/** Whether any piece of `inner` lies inside `outer`, tested at a corner of the piece. */
function inside(inner: PlacedSurface, outer: PlacedSurface): boolean {
  const T = inner.mesh.tris;
  return inner.pieces.some((t) => RAYS.some((d) => outer.mesh.contains(T[t * 9], T[t * 9 + 1], T[t * 9 + 2], d)));
}
