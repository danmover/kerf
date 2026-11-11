// The shape a topology optimisation has found so far, drawn inside the parts it is cut from (which stay faintly in
// view) while the run goes on. Each new preview replaces the last.

import * as THREE from "three";
import type { SceneOverlay } from "./scene";
import type { TopologyPreview } from "../../analysis/fe/structural";
import { TOPOLOGY_GHOST } from "./resultsOverlay";

export class TopologyPreviewOverlay implements SceneOverlay {
  readonly object = new THREE.Group();
  readonly replaces = new Set<string>();
  readonly ghosts: ReadonlyMap<string, number>;
  private mesh: THREE.Mesh | null = null;
  private mat: THREE.MeshStandardMaterial;
  shown: TopologyPreview | null = null;

  constructor(partIds: string[], color: string) {
    this.ghosts = new Map(partIds.map((id) => [id, TOPOLOGY_GHOST]));
    this.mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.58, metalness: 0.04, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  }

  update(p: TopologyPreview) {
    if (p === this.shown) return;
    this.shown = p;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
    g.setIndex(new THREE.BufferAttribute(p.indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = g;
    } else {
      this.mesh = new THREE.Mesh(g, this.mat);
      this.mesh.castShadow = true;
      this.mesh.receiveShadow = true;
      this.object.add(this.mesh);
    }
  }

  setClipping(planes: THREE.Plane[] | null) {
    this.mat.clippingPlanes = planes;
    this.mat.needsUpdate = true;
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mat.dispose();
  }
}
