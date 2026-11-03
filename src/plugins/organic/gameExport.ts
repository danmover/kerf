// "Game model" export: a .glb for Roblox, Unity, Godot and the like. Game
// engines want a colour texture rather than vertex colours (Roblox ignores
// those), so the colours are baked into one texture: every triangle of a
// painted model gets its own small square, filled with its corners' colours
// blended across it (so the baked shading in the creases and the clean colour
// borders come along), and a plain part gets one square of its colour.

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
  /** the baked texture, sRGB RGBA, size × size */
  size: number;
  pixels: Uint8Array<ArrayBuffer>;
  /** texture squares used: one per painted triangle, one per plain part */
  cells: number;
  triangles: number;
}

/** Largest texture Roblox keeps at full size. */
const TEXTURE = 1024;

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
  const painted = items.map((it) => it.painted && !!it.mesh.colors);
  const cells = items.reduce((n, it, k) => n + (painted[k] ? it.mesh.indices.length / 3 : 1), 0);
  const grid = Math.max(1, Math.ceil(Math.sqrt(cells)));
  // the biggest square that fits the texture, 4 px at least (then the texture grows)
  const cell = [16, 8, 4].find((c) => grid * c <= TEXTURE) ?? 4;
  let size = 64;
  while (size < grid * cell) size *= 2;
  const pixels = new Uint8Array(size * size * 4);
  // corners of a triangle's square, inset a pixel so mipmaps and filtering stay inside it
  const pad = cell >= 8 ? 1 : 0.5;
  const span = cell - 2 * pad;
  let next = 0;
  const place = () => {
    const i = next++;
    return [(i % grid) * cell, Math.floor(i / grid) * cell];
  };
  const fill = (x0: number, y0: number, a: number[], b: number[], c: number[]) => {
    for (let ty = 0; ty < cell; ty++)
      for (let tx = 0; tx < cell; tx++) {
        // where this texel falls on the triangle, clamped onto it so the margin repeats the edge
        let u = Math.max(0, (tx + 0.5 - pad) / span);
        let v = Math.max(0, (ty + 0.5 - pad) / span);
        if (u + v > 1) {
          const k = 1 / (u + v);
          u *= k;
          v *= k;
        }
        const w = 1 - u - v;
        const o = ((y0 + ty) * size + x0 + tx) * 4;
        for (let ch = 0; ch < 3; ch++) pixels[o + ch] = Math.round(w * a[ch] + u * b[ch] + v * c[ch]);
        pixels[o + 3] = 255;
      }
  };

  let triangles = 0;
  const meshes = items.map((it, k) => {
    const m = it.matrix;
    const src = it.mesh;
    // a mirroring placement turns triangles inside out: flip them back
    const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    const nf = src.indices.length / 3;
    triangles += nf;
    // painted: three corners of its own per triangle, each pointing into the triangle's square
    const corners = painted[k] ? Uint32Array.from(src.indices) : null;
    const nv = corners ? nf * 3 : src.positions.length / 3;
    const vertexOf = (i: number) => (corners ? corners[i] : i);
    const positions = new Float32Array(nv * 3);
    const normals = new Float32Array(nv * 3);
    const uvs = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      const v = vertexOf(i);
      const x = src.positions[v * 3];
      const y = src.positions[v * 3 + 1];
      const z = src.positions[v * 3 + 2];
      const px = m[0] * x + m[4] * y + m[8] * z + m[12];
      const py = m[1] * x + m[5] * y + m[9] * z + m[13];
      const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
      // Kerf is Z up with fronts toward -Y; glTF is Y up with fronts toward +Z, in metres
      positions[i * 3] = px / 1000;
      positions[i * 3 + 1] = pz / 1000;
      positions[i * 3 + 2] = -py / 1000;
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
      normals[i * 3] = qx;
      normals[i * 3 + 1] = qz;
      normals[i * 3 + 2] = -qy;
    }
    if (corners) {
      const col = src.colors!;
      const rgb = (v: number) => [srgbByte(col[v * 3]), srgbByte(col[v * 3 + 1]), srgbByte(col[v * 3 + 2])];
      for (let f = 0; f < nf; f++) {
        const [x0, y0] = place();
        fill(x0, y0, rgb(corners[f * 3]), rgb(corners[f * 3 + 1]), rgb(corners[f * 3 + 2]));
        // glTF puts uv (0, 0) at the image's top left
        const at = [
          [x0 + pad, y0 + pad],
          [x0 + pad + span, y0 + pad],
          [x0 + pad, y0 + pad + span],
        ];
        for (let c = 0; c < 3; c++) {
          uvs[(f * 3 + c) * 2] = at[c][0] / size;
          uvs[(f * 3 + c) * 2 + 1] = at[c][1] / size;
        }
      }
    } else {
      const [x0, y0] = place();
      const c = hexRgb(it.color);
      fill(x0, y0, c, c, c);
      for (let i = 0; i < nv; i++) {
        uvs[i * 2] = (x0 + cell / 2) / size;
        uvs[i * 2 + 1] = (y0 + cell / 2) / size;
      }
    }
    const indices = corners ? Uint32Array.from({ length: nf * 3 }, (_, i) => i) : Uint32Array.from(src.indices);
    if (det < 0)
      for (let f = 0; f < indices.length; f += 3) {
        const t = indices[f + 1];
        indices[f + 1] = indices[f + 2];
        indices[f + 2] = t;
      }
    return { name: it.name, positions, normals, uvs, indices };
  });
  return { meshes, size, pixels, cells, triangles };
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
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ name: "baked", map: tex, roughness: 0.7, metalness: 0 });
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
