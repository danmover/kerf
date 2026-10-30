// Plugin shapes on the kernel side: each plugin that makes its own triangles
// (rather than OpenCASCADE solids) registers a generator here. The kernel
// worker draws the generator's meshes and builds a coarse solid from its
// "proxy" mesh for the checks.

import { organicGenerator } from "./organic/generator";

export type GenQuality = "preview" | "final" | "proxy";

export interface GeneratedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** linear RGB bytes per vertex */
  colors?: Uint8Array;
}

export interface MeshGenerator {
  mesh(data: unknown, quality: GenQuality): GeneratedMesh;
}

const GENERATORS: Record<string, MeshGenerator> = {
  organic: organicGenerator,
};

export function meshGenerator(id: string): MeshGenerator {
  const g = GENERATORS[id];
  if (!g) throw new Error(`No plugin makes "${id}" shapes`);
  return g;
}
