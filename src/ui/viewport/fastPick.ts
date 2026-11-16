// Picking parts under the pointer without testing every triangle: a part mesh the pointer's ray reaches gets a
// bounding volume hierarchy (three-mesh-bvh, already bundled for photoreal) the first time, so hover and clicks test
// a few dozen triangles rather than all of a detailed part's. Copies of a part share one geometry, so one tree.

import * as THREE from "three";

type Bvh = typeof import("three-mesh-bvh");
type WithTree = THREE.BufferGeometry & { boundsTree?: unknown };

let lib: Bvh | null = null;
let loading = false;

/** Meshes smaller than this many triangles are tested directly: as quick as a tree, and nothing to build. */
const MIN_TRIANGLES = 1500;

const sphere = new THREE.Sphere();

/**
 * Before a raycast against part meshes: give each one the ray reaches a tree if it has none. Until the library has
 * loaded (on first use), picks go the plain way.
 */
export function prepareRay(ray: THREE.Ray, meshes: Iterable<THREE.Mesh>) {
  if (!lib) {
    if (!loading) {
      loading = true;
      import("three-mesh-bvh")
        .then((m) => (lib = m))
        .catch(() => undefined);
    }
    return;
  }
  for (const m of meshes) {
    const g = m.geometry as WithTree;
    if (!g.boundsTree) {
      const index = g.index;
      if (!index || index.count < MIN_TRIANGLES * 3) continue;
      if (!g.boundingSphere) g.computeBoundingSphere();
      sphere.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld);
      if (!ray.intersectsSphere(sphere)) continue;
      // indirect: the tree keeps its own triangle order and leaves the index (which face groups point into) as it is
      // (an option the library's typings leave out)
      g.boundsTree = new lib.MeshBVH(g, { indirect: true } as ConstructorParameters<Bvh["MeshBVH"]>[1]);
    }
    // falls back to three's own raycast for a geometry without a tree (one swapped in since)
    if (m.raycast !== lib.acceleratedRaycast) m.raycast = lib.acceleratedRaycast;
  }
}
