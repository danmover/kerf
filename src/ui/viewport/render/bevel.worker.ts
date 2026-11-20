// Finds a mesh's rounded-edge bands (bevel.ts) off the main thread: the mesh
// in, the bands back, transferred. Plain geometry, no network.

import { bevelBands, type BevelBands, type BevelInput } from "./bevel";

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = ({ data }: MessageEvent<{ key: string; data: BevelInput }>) => {
  let bands: BevelBands | null = null;
  try {
    bands = bevelBands(data.data);
  } catch {
    bands = null;
  }
  post({ key: data.key, bands }, bands ? [bands.positions.buffer, bands.normals.buffer, bands.bevel.buffer, bands.indices.buffer] as ArrayBuffer[] : []);
};
