// Surface detail as tileable textures, for the photoreal path tracer. The
// interactive view draws the same patterns procedurally in its shader
// (partShader.ts); a path tracer can only take texture maps, so each kind of
// detail is baked once into a normal map, a roughness map and, where the
// pattern changes colour, a colour map. Parts get matching UVs in
// millimetres (photoreal.ts), so one texture serves every part.

import * as THREE from "three";
import { Detail } from "./appearance";

export interface DetailMaps {
  normal: THREE.DataTexture;
  rough: THREE.DataTexture;
  color: THREE.DataTexture | null;
  /** the tile covers this many pattern periods (detailScale), so tile size = cells × detailScale mm */
  cells: number;
  /** steepest slope in the tile, in height units per tile: normalScale = amp × slope / tile size */
  slope: number;
  /** mean of the colour map, so the base colour can be lifted to keep the average */
  colorMean: number;
}

const N = 256;

/** Value noise that wraps every `px` × `py` lattice cells. */
function periodicNoise(px: number, py: number, seed: number) {
  const vals = new Float32Array(px * py);
  let s = (seed * 2654435761) >>> 0;
  for (let i = 0; i < vals.length; i++) {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    vals[i] = s / 4294967296;
  }
  const at = (x: number, y: number) => vals[(((y % py) + py) % py) * px + (((x % px) + px) % px)];
  // u, v in [0, 1) tile coordinates
  return (u: number, v: number) => {
    const x = u * px;
    const y = v * py;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * fx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * fx;
    return a + (b - a) * fy;
  };
}

interface Pattern {
  cells: number;
  /** height 0..1, roughness pattern 0..1, colour pattern 0..1 (1 = base colour) */
  sample: (u: number, v: number) => [number, number, number];
  /** colour contrast: how far the colour pattern darkens, 0 = no colour map */
  tint: number;
}

const TAU = Math.PI * 2;

function pattern(kind: Detail): Pattern | null {
  switch (kind) {
    case Detail.Layers: {
      // FDM layer lines along u; each layer wanders a little
      const cells = 16;
      const wob = periodicNoise(4, cells, 11);
      const fine = periodicNoise(32, cells, 12);
      return {
        cells,
        tint: 0.08,
        sample: (u, v) => {
          const q = v * cells + (wob(u, v) - 0.5) * 0.12;
          const w = 0.5 + 0.5 * Math.cos(TAU * q);
          const h = Math.min(1, Math.max(0, w + (fine(u, v) - 0.5) * 0.25));
          return [h, 1 - h, 0.4 + 0.6 * h];
        },
      };
    }
    case Detail.Brushed: {
      const cells = 64;
      const a = periodicNoise(1, cells, 21);
      const b = periodicNoise(2, cells * 2, 22);
      const c = periodicNoise(3, cells * 4, 23);
      return {
        cells,
        tint: 0,
        sample: (u, v) => {
          const s = a(u, v) * 0.5 + b(u, v) * 0.3 + c(u, v) * 0.2;
          return [s, s, 1];
        },
      };
    }
    case Detail.Machined: {
      // fine tool marks with a slow wander, like a fly-cut face
      const cells = 64;
      const a = periodicNoise(6, cells, 31);
      const b = periodicNoise(12, cells * 2, 32);
      const wander = periodicNoise(2, 2, 33);
      return {
        cells,
        tint: 0,
        sample: (u, v) => {
          const vv = v + (wander(u, v) - 0.5) * 0.02;
          const s = a(u, vv) * 0.65 + b(u, vv) * 0.35;
          return [s, s, 1];
        },
      };
    }
    case Detail.Grain: {
      const cells = 64;
      const a = periodicNoise(cells, cells, 41);
      const b = periodicNoise(cells * 2, cells * 2, 42);
      return {
        cells,
        tint: 0,
        sample: (u, v) => {
          const s = a(u, v) * 0.6 + b(u, v) * 0.4;
          return [s, s, 1];
        },
      };
    }
    case Detail.Peel: {
      const cells = 16;
      const a = periodicNoise(cells, cells, 51);
      const b = periodicNoise(cells * 2, cells * 2, 52);
      const c = periodicNoise(cells * 5, cells * 5, 53);
      return {
        cells,
        tint: 0,
        sample: (u, v) => {
          const s = a(u, v) * 0.55 + b(u, v) * 0.3 + c(u, v) * 0.15;
          return [s, s, 1];
        },
      };
    }
    case Detail.Weave: {
      // 2×2 twill: tows alternate direction every two cells along the diagonal
      const cells = 8;
      const fib = periodicNoise(cells * 2, cells * 24, 61);
      return {
        cells,
        tint: 0.42,
        sample: (u, v) => {
          const x = u * cells;
          const y = v * cells;
          const cx = Math.floor(x);
          const cy = Math.floor(y);
          const warp = (((cx + cy) % 4) + 4) % 4 < 2;
          const across = warp ? y - cy : x - cx;
          const bulge = Math.sin(Math.PI * across);
          const f = warp ? fib(u, v) : fib(v, u);
          return [bulge * 0.85 + f * 0.15, warp ? 0.3 + f * 0.4 : 0.6 + f * 0.4, warp ? 0.15 + 0.2 * f : 0.85 + 0.15 * f];
        },
      };
    }
    case Detail.Wood: {
      // growth rings as stripes along u, warped, with pores along the grain
      const cells = 16;
      const warp = periodicNoise(2, 4, 71);
      const pores = periodicNoise(8, cells * 16, 72);
      return {
        cells,
        tint: 0.4,
        sample: (u, v) => {
          const ring = (((v + (warp(u, v) - 0.5) * 0.35) * cells) % 1 + 1) % 1;
          const late = smooth(0.55, 0.9, ring) * (1 - smooth(0.92, 1, ring));
          const pore = pores(u, v);
          return [late * 0.6 + pore * 0.4, pore, 1 - (late * 0.85 + pore * 0.15)];
        },
      };
    }
    default:
      return null;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function dataTexture(data: Uint8Array<ArrayBuffer>) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const cache = new Map<Detail, DetailMaps | null>();

/** Baked maps for one kind of detail, made on first use. */
export function detailMaps(kind: Detail): DetailMaps | null {
  if (cache.has(kind)) return cache.get(kind)!;
  const p = pattern(kind);
  if (!p) {
    cache.set(kind, null);
    return null;
  }
  const h = new Float32Array(N * N);
  const r = new Float32Array(N * N);
  const c = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const [hh, rr, cc] = p.sample((x + 0.5) / N, (y + 0.5) / N);
      const i = y * N + x;
      h[i] = hh;
      r[i] = rr;
      c[i] = cc;
    }
  // slopes in height units per tile, wrapping at the edges
  const dx = new Float32Array(N * N);
  const dy = new Float32Array(N * N);
  let slope = 1e-6;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      dx[i] = ((h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)]) / 2) * N;
      dy[i] = ((h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x]) / 2) * N;
      slope = Math.max(slope, Math.abs(dx[i]), Math.abs(dy[i]));
    }
  const nd = new Uint8Array(N * N * 4);
  const rd = new Uint8Array(N * N * 4);
  const cd = p.tint > 0 ? new Uint8Array(N * N * 4) : null;
  let mean = 0;
  for (let i = 0; i < N * N; i++) {
    const ax = -dx[i] / slope;
    const ay = -dy[i] / slope;
    const len = Math.hypot(ax, ay, 1);
    nd[i * 4] = Math.round(((ax / len) * 0.5 + 0.5) * 255);
    nd[i * 4 + 1] = Math.round(((ay / len) * 0.5 + 0.5) * 255);
    nd[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
    nd[i * 4 + 3] = 255;
    // roughness multiplier in the green channel (three.js reads roughness from G)
    const g = Math.round((0.82 + 0.18 * r[i]) * 255);
    rd[i * 4] = g;
    rd[i * 4 + 1] = g;
    rd[i * 4 + 2] = g;
    rd[i * 4 + 3] = 255;
    if (cd) {
      const k = 1 - p.tint + p.tint * c[i];
      mean += k;
      const v = Math.round(k * 255);
      cd[i * 4] = v;
      cd[i * 4 + 1] = v;
      cd[i * 4 + 2] = v;
      cd[i * 4 + 3] = 255;
    }
  }
  const out: DetailMaps = {
    normal: dataTexture(nd),
    rough: dataTexture(rd),
    color: cd ? dataTexture(cd) : null,
    cells: p.cells,
    slope,
    colorMean: cd ? mean / (N * N) : 1,
  };
  cache.set(kind, out);
  return out;
}

/** Mean of the roughness map, so material roughness can be lifted to keep its average. */
export const ROUGH_MAP_MEAN = 0.91;
