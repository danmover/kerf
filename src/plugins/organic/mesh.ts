// From an organic model to triangles: sample the field on a grid, make a
// surface, colour every triangle, then shape the mesh for its style.
//  - lowpoly: simplified to the triangle budget and drawn faceted, one flat
//    colour per facet (the chunky look of stylised game pets)
//  - smooth and detailed: dense, smooth normals, colours split along borders

import { decimate } from "./decimate";
import { fieldNormal, surfaceNets } from "./mesher";
import { makeField, type Field } from "./sdf";
import { MAX_TRIS, STYLE_TRIS, type OrganicModel, type Prim } from "./model";

export type OrganicQuality = "preview" | "final" | "proxy";

export interface OrganicMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** linear RGB bytes per vertex */
  colors: Uint8Array;
  /** palette index of each triangle */
  faceColor: Int32Array;
  /** "#rrggbb" by palette index */
  palette: string[];
  /** enclosed volume, mm³ */
  volume: number;
  bbox: [[number, number, number], [number, number, number]];
  /** grid cell used, mm */
  cell: number;
  ms: number;
}

/** Grid cells across the model's largest size, by style and quality. */
const CELLS: Record<OrganicModel["style"], Record<OrganicQuality, number>> = {
  lowpoly: { preview: 64, final: 120, proxy: 40 },
  smooth: { preview: 72, final: 150, proxy: 40 },
  detailed: { preview: 80, final: 280, proxy: 40 },
};

/** Thinnest part of a shape that should survive meshing, mm. */
function thickness(p: Prim): number {
  switch (p.k) {
    case "ball":
      return p.r * 2;
    case "ellipsoid":
      return Math.min(...p.r) * 2;
    case "limb":
      return Math.max(p.ra, p.rb) * 2;
    case "box":
      return Math.min(...p.h) * 2;
    case "slab":
      return p.t * 2;
    case "torus":
      return p.r * 2;
    case "gem":
      return p.r * 2;
  }
}

export function meshOrganic(model: OrganicModel, quality: OrganicQuality): OrganicMesh {
  const t0 = performance.now();
  // previews and stand-ins skip the fine detail (it would only alias at their grid size)
  const field = makeField(quality === "final" ? model : { ...model, detail: undefined });
  const size = Math.max(field.hi[0] - field.lo[0], field.hi[1] - field.lo[1], field.hi[2] - field.lo[2]);
  let thin = Infinity;
  for (const it of model.items) if (it.op === "add") thin = Math.min(thin, thickness(it.prim));
  let cell = size / CELLS[model.style][quality];
  // thin ears, fins and horns need a few cells across them
  if (quality !== "proxy" && Number.isFinite(thin)) cell = Math.min(cell, Math.max(thin / 2.5, size / 400));
  if (quality === "final" && model.style === "detailed" && model.detail) cell = Math.min(cell, Math.max(model.detail.scale / 3, size / 400));
  const raw = surfaceNets(field.dist, field.lo, field.hi, cell);
  const faceColor = colourFaces(field, raw.positions, raw.indices);

  let budget = model.tris > 0 ? model.tris : STYLE_TRIS[model.style];
  if (quality === "preview") budget = Math.min(budget * (model.style === "lowpoly" ? 1 : 0.5), 60000);
  if (quality === "proxy") budget = 900;
  budget = Math.max(12, Math.min(MAX_TRIS, Math.round(budget)));

  let positions = raw.positions;
  let indices = raw.indices;
  let colours = faceColor;
  if (indices.length / 3 > budget) {
    const d = decimate({ positions, indices, faceColor }, budget);
    positions = d.positions;
    indices = d.indices;
    colours = d.faceColor;
  }

  const volume = signedVolume(positions, indices);
  const bbox = boxOf(positions);
  const linear = field.palette.map(linearBytes);
  const out =
    model.style === "lowpoly" || quality === "proxy"
      ? faceted(positions, indices, colours, linear)
      : smoothSplit(positions, indices, colours, linear, field, cell);
  return { ...out, faceColor: colours, palette: field.palette, volume, bbox, cell, ms: performance.now() - t0 };
}

function colourFaces(field: Field, pos: Float32Array, idx: Uint32Array): Int32Array {
  const fc = new Int32Array(idx.length / 3);
  for (let f = 0; f < fc.length; f++) {
    const a = idx[f * 3] * 3;
    const b = idx[f * 3 + 1] * 3;
    const c = idx[f * 3 + 2] * 3;
    fc[f] = field.sample((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3).color;
  }
  return fc;
}

/** Every facet its own three corners, flat normal and colour. */
function faceted(pos: Float32Array, idx: Uint32Array, fc: Int32Array, rgb: [number, number, number][]) {
  const nf = idx.length / 3;
  const positions = new Float32Array(nf * 9);
  const normals = new Float32Array(nf * 9);
  const colors = new Uint8Array(nf * 9);
  const indices = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const a = idx[f * 3] * 3;
    const b = idx[f * 3 + 1] * 3;
    const c = idx[f * 3 + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const col = rgb[fc[f]] ?? [200, 200, 200];
    for (let k = 0; k < 3; k++) {
      const s = idx[f * 3 + k] * 3;
      const o = (f * 3 + k) * 3;
      positions[o] = pos[s];
      positions[o + 1] = pos[s + 1];
      positions[o + 2] = pos[s + 2];
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
      colors[o] = col[0];
      colors[o + 1] = col[1];
      colors[o + 2] = col[2];
      indices[f * 3 + k] = f * 3 + k;
    }
  }
  return { positions, normals, colors, indices };
}

/** Shared corners with smooth normals, split only where two colours meet. */
function smoothSplit(pos: Float32Array, idx: Uint32Array, fc: Int32Array, rgb: [number, number, number][], field: Field, cell: number) {
  const nv = pos.length / 3;
  const normal = new Float32Array(nv * 3);
  const e = cell * 0.25;
  for (let v = 0; v < nv; v++) {
    const n = fieldNormal(field.dist, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], e);
    normal[v * 3] = n[0];
    normal[v * 3 + 1] = n[1];
    normal[v * 3 + 2] = n[2];
  }
  const copies = new Map<number, number>();
  const P: number[] = [];
  const N: number[] = [];
  const C: number[] = [];
  const I = new Uint32Array(idx.length);
  for (let f = 0; f < fc.length; f++) {
    const col = fc[f];
    for (let k = 0; k < 3; k++) {
      const v = idx[f * 3 + k];
      const key = v * 4096 + col;
      let o = copies.get(key);
      if (o === undefined) {
        o = P.length / 3;
        copies.set(key, o);
        P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        N.push(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]);
        const c = rgb[col] ?? [200, 200, 200];
        C.push(c[0], c[1], c[2]);
      }
      I[f * 3 + k] = o;
    }
  }
  return { positions: new Float32Array(P), normals: new Float32Array(N), colors: new Uint8Array(C), indices: I };
}

export function signedVolume(pos: Float32Array, idx: Uint32Array): number {
  let v = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f] * 3;
    const b = idx[f + 1] * 3;
    const c = idx[f + 2] * 3;
    v +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}

function boxOf(pos: Float32Array): OrganicMesh["bbox"] {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  if (!pos.length) return [
    [0, 0, 0],
    [0, 0, 0],
  ];
  return [lo, hi];
}

/** "#rrggbb" to linear-light bytes, which is how vertex colours are drawn. */
export function linearBytes(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    const l = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    return Math.round(l * 255);
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
}
