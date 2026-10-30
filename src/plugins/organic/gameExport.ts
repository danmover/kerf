// "Game model" export: a .glb for Roblox, Unity, Godot and the like. Game
// engines want a colour texture rather than vertex colours (Roblox ignores
// those), so every colour on the model gets a small square in one palette
// texture and each triangle's corners point at its colour's square. Flat
// colours stay exact and the texture stays tiny.

import type { MeshData } from "../../kernel/build";

export interface GameItem {
  name: string;
  /** column-major 4x4 placement in the design, mm */
  matrix: number[];
  mesh: MeshData;
  /** the part's colour, for meshes without their own ("#rrggbb", sRGB) */
  color: string;
  /** use the mesh's vertex colours (linear bytes) */
  painted: boolean;
}

export interface GameMesh {
  name: string;
  /** metres, Y up, the creature's front toward +Z (glTF's convention) */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export interface GameModel {
  meshes: GameMesh[];
  /** palette texture, sRGB RGBA, size × size */
  size: number;
  pixels: Uint8Array<ArrayBuffer>;
  colors: number;
  triangles: number;
}

/** Pixels per colour square: enough that mipmaps keep each colour clean a few levels down. */
const CELL = 16;

const srgbByte = (linearByte: number) => {
  const l = linearByte / 255;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
};

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(/^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "9aa3ad", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function gameModel(items: GameItem[]): GameModel {
  const palette: [number, number, number][] = [];
  const index = new Map<number, number>();
  const cellOf = (rgb: [number, number, number]) => {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    let i = index.get(key);
    if (i === undefined) {
      i = palette.length;
      palette.push(rgb);
      index.set(key, i);
    }
    return i;
  };
  // first pass: every vertex's colour square
  const cells = items.map((it) => {
    const nv = it.mesh.positions.length / 3;
    const c = new Int32Array(nv);
    if (it.painted && it.mesh.colors) {
      const col = it.mesh.colors;
      for (let v = 0; v < nv; v++) c[v] = cellOf([srgbByte(col[v * 3]), srgbByte(col[v * 3 + 1]), srgbByte(col[v * 3 + 2])]);
    } else c.fill(cellOf(hexRgb(it.color)));
    return c;
  });

  const cols = Math.max(1, Math.ceil(Math.sqrt(palette.length)));
  let size = 64;
  while (size < cols * CELL) size *= 2;
  const per = Math.floor(size / CELL);
  const pixels = new Uint8Array(size * size * 4);
  palette.forEach((rgb, i) => {
    const cx = (i % per) * CELL;
    const cy = Math.floor(i / per) * CELL;
    for (let y = cy; y < cy + CELL; y++)
      for (let x = cx; x < cx + CELL; x++) {
        const o = (y * size + x) * 4;
        pixels[o] = rgb[0];
        pixels[o + 1] = rgb[1];
        pixels[o + 2] = rgb[2];
        pixels[o + 3] = 255;
      }
  });

  let triangles = 0;
  const meshes = items.map((it, k) => {
    const m = it.matrix;
    const src = it.mesh;
    const nv = src.positions.length / 3;
    const positions = new Float32Array(nv * 3);
    const normals = new Float32Array(nv * 3);
    const uvs = new Float32Array(nv * 2);
    for (let v = 0; v < nv; v++) {
      const x = src.positions[v * 3];
      const y = src.positions[v * 3 + 1];
      const z = src.positions[v * 3 + 2];
      const px = m[0] * x + m[4] * y + m[8] * z + m[12];
      const py = m[1] * x + m[5] * y + m[9] * z + m[13];
      const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
      // Kerf is Z up with fronts toward -Y; glTF is Y up with fronts toward +Z, in metres
      positions[v * 3] = px / 1000;
      positions[v * 3 + 1] = pz / 1000;
      positions[v * 3 + 2] = -py / 1000;
      const nx = src.normals[v * 3];
      const ny = src.normals[v * 3 + 1];
      const nz = src.normals[v * 3 + 2];
      let qx = m[0] * nx + m[4] * ny + m[8] * nz;
      let qy = m[1] * nx + m[5] * ny + m[9] * nz;
      let qz = m[2] * nx + m[6] * ny + m[10] * nz;
      const l = Math.hypot(qx, qy, qz) || 1;
      qx /= l;
      qy /= l;
      qz /= l;
      normals[v * 3] = qx;
      normals[v * 3 + 1] = qz;
      normals[v * 3 + 2] = -qy;
      const cell = cells[k][v];
      uvs[v * 2] = ((cell % per) * CELL + CELL / 2) / size;
      // glTF puts uv (0, 0) at the image's top left
      uvs[v * 2 + 1] = (Math.floor(cell / per) * CELL + CELL / 2) / size;
    }
    // a mirroring placement turns triangles inside out: flip them back
    const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    const indices = Uint32Array.from(src.indices);
    if (det < 0)
      for (let f = 0; f < indices.length; f += 3) {
        const t = indices[f + 1];
        indices[f + 1] = indices[f + 2];
        indices[f + 2] = t;
      }
    triangles += indices.length / 3;
    return { name: it.name, positions, normals, uvs, indices };
  });
  return { meshes, size, pixels, colors: palette.length, triangles };
}

/** Most triangles Roblox imports in one mesh. */
export const ROBLOX_MAX_TRIS = 20000;

/** The game model as binary glTF, built with three.js's exporter. */
export async function gameGlb(model: GameModel, title: string): Promise<ArrayBuffer> {
  const THREE = await import("three");
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const tex = new THREE.DataTexture(model.pixels, model.size, model.size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ name: "palette", map: tex, roughness: 0.75, metalness: 0 });
  const root = new THREE.Group();
  root.name = title;
  const geos: InstanceType<typeof THREE.BufferGeometry>[] = [];
  for (const m of model.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(m.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    geos.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = m.name;
    root.add(mesh);
  }
  const scene = new THREE.Scene();
  scene.add(root);
  try {
    return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
  } finally {
    geos.forEach((g) => g.dispose());
    mat.dispose();
    tex.dispose();
  }
}
