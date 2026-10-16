// Builds the photoreal view's BVH off the main thread. The same messages as
// three-mesh-bvh's generateMeshBVH worker (its package is marked free of side
// effects, so the bundler drops a plain import of that file): positions and
// index in, the serialized tree and the arrays back, all transferred.

import * as THREE from "three";
import { MeshBVH, type MeshBVHOptions } from "three-mesh-bvh";

interface Job {
  index: Uint32Array | Uint16Array | null;
  position: Float32Array;
  options: MeshBVHOptions & { groups?: { start: number; count: number; materialIndex?: number }[] };
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = ({ data }: MessageEvent<Job>) => {
  const { index, position, options } = data;
  try {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3, false));
    if (index) geometry.setIndex(new THREE.BufferAttribute(index, 1, false));
    for (const g of options.groups ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
    const bvh = new MeshBVH(geometry, { ...options, onProgress: undefined });
    // the tree's own buffers go back as they are, without copies
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false }) as ReturnType<typeof MeshBVH.serialize> & { indirectBuffer?: Uint32Array | null };
    const buffers: ArrayBufferLike[] = [position.buffer, ...serialized.roots];
    if (serialized.index) buffers.push(serialized.index.buffer);
    if (serialized.indirectBuffer) buffers.push(serialized.indirectBuffer.buffer);
    post({ error: null, serialized, position, progress: 1 }, [...new Set(buffers)].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer));
  } catch (error) {
    post({ error: error instanceof Error ? error.message : String(error), serialized: null, position: null, progress: 1 });
  }
};
