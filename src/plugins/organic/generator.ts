// The organic plugin's kernel side: meshes on demand, remembered for the
// last few models so the preview, final and stand-in meshes of one edit are
// each made once.

import type { GeneratedMesh, GenQuality, MeshGenerator } from "../kernel";
import { meshOrganic, type OrganicMesh } from "./mesh";
import { isOrganicModel } from "./model";

const recent = new Map<string, OrganicMesh>();
const KEEP = 24;

export function organicMesh(data: unknown, quality: GenQuality): OrganicMesh {
  if (!isOrganicModel(data)) throw new Error("This organic shape was written by a newer Kerf");
  const key = quality + JSON.stringify(data);
  const hit = recent.get(key);
  if (hit) {
    recent.delete(key);
    recent.set(key, hit);
    return hit;
  }
  const m = meshOrganic(data, quality);
  recent.set(key, m);
  while (recent.size > KEEP) recent.delete(recent.keys().next().value!);
  return m;
}

export const organicGenerator: MeshGenerator = {
  mesh(data, quality): GeneratedMesh {
    const m = organicMesh(data, quality);
    return { positions: m.positions, normals: m.normals, indices: m.indices, colors: m.colors };
  },
};
