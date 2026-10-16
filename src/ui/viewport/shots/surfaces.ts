// Surfaces for product shots, drawn procedurally into canvases: wood with
// planks and grain, concrete, slate, marble, brushed steel, a cutting mat
// with a millimetre grid, paper and felt. Each comes with a matching normal
// map, so the surface catches the light in the rasteriser and the path
// tracer alike, and nothing is downloaded.

import * as THREE from "three";
import type { SurfaceId } from "../../../shots/spec";

export interface SurfaceLook {
  map: THREE.Texture;
  normal: THREE.Texture;
  /** size of one texture tile in mm */
  tile: number;
  roughness: number;
  metalness: number;
  clearcoat: number;
  /** average colour, linear, for the background beyond the surface's edge */
  tone: THREE.Color;
}

const N = 512;

// ---------- noise ----------

function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise with period `p` cells. */
function vnoise(x: number, y: number, p: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (a: number) => ((a % p) + p) % p;
  const a = hash(w(xi), w(yi), seed);
  const b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed);
  const d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal noise over the unit square, tileable. */
function fbm(u: number, v: number, base: number, octaves: number, seed: number) {
  let s = 0;
  let amp = 0.5;
  let f = base;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += amp * vnoise(u * f, v * f, f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

type Painter = (u: number, v: number) => { c: [number, number, number]; h: number };

const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (s: string): [number, number, number] => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function wood(light: string, dark: string, planks: number, seed: number, flecks: number): Painter {
  const L = hex(light);
  const D = hex(dark);
  return (u, v) => {
    // planks run along u; each has its own tone and grain offset
    const pv = v * planks;
    const pi = Math.floor(pv);
    const pf = pv - pi;
    const tone = hash(pi, 7, seed) * 0.35 - 0.15;
    const warp = fbm(u, v, 3, 3, seed + pi) * 0.9;
    const grain = Math.sin((pf * 9 + warp * 6 + hash(pi, 3, seed) * 10) * Math.PI * 2);
    const fine = fbm(u * 1, v * 8, 16, 2, seed + 40) - 0.5;
    let t = clamp01(0.45 + grain * 0.22 + fine * 0.5 + tone);
    // medullary rays (oak) catch the light as small streaks
    if (flecks > 0) t = clamp01(t - flecks * smooth(0.78, 0.95, fbm(u * 2, v * 10, 24, 2, seed + 90)));
    const seam = smooth(0.0, 0.012, pf) * smooth(0.0, 0.012, 1 - pf);
    const c = mix(D, L, t);
    return { c: [c[0] * (0.55 + 0.45 * seam), c[1] * (0.55 + 0.45 * seam), c[2] * (0.55 + 0.45 * seam)], h: t * 0.4 + seam * 0.6 };
  };
}

const PAINTERS: Record<SurfaceId, { paint: Painter; tile: number; roughness: number; metalness: number; clearcoat: number; bump: number }> = {
  walnut: { paint: wood("#7b5236", "#3a2416", 3, 11, 0), tile: 480, roughness: 0.42, metalness: 0, clearcoat: 0.35, bump: 1.2 },
  oak: { paint: wood("#c79c68", "#8c6338", 3, 23, 0.25), tile: 480, roughness: 0.5, metalness: 0, clearcoat: 0.15, bump: 1.2 },
  concrete: {
    paint: (u, v) => {
      const n = fbm(u, v, 4, 6, 3);
      const pores = smooth(0.82, 0.9, fbm(u, v, 64, 2, 9));
      const g = 120 + n * 70 - pores * 45;
      return { c: [g * 1.02, g, g * 0.97], h: n - pores * 0.8 };
    },
    tile: 600,
    roughness: 0.86,
    metalness: 0,
    clearcoat: 0,
    bump: 2.2,
  },
  slate: {
    paint: (u, v) => {
      const layers = fbm(u * 0.3, v * 3, 6, 5, 21);
      const n = fbm(u, v, 12, 4, 5);
      const g = 46 + layers * 34 + n * 16;
      return { c: [g * 0.94, g * 0.99, g * 1.06], h: layers * 0.8 + n * 0.3 };
    },
    tile: 500,
    roughness: 0.62,
    metalness: 0,
    clearcoat: 0.05,
    bump: 1.6,
  },
  marble: {
    paint: (u, v) => {
      const t = fbm(u, v, 3, 6, 31);
      const vein = Math.abs(Math.sin((u * 3 + v * 2 + t * 5) * Math.PI));
      const k = Math.pow(1 - vein, 9);
      const base = 226 + fbm(u, v, 8, 3, 2) * 18;
      const c: [number, number, number] = [base - k * 110, base - k * 106, base - k * 98];
      return { c, h: 0.5 - k * 0.2 };
    },
    tile: 700,
    roughness: 0.12,
    metalness: 0,
    clearcoat: 0.6,
    bump: 0.2,
  },
  steel: {
    paint: (u, v) => {
      const streak = fbm(u * 0.05, v * 40, 64, 3, 41);
      const n = fbm(u, v, 4, 3, 8);
      const g = 150 + streak * 46 + n * 16;
      return { c: [g * 0.98, g, g * 1.02], h: streak };
    },
    tile: 300,
    roughness: 0.34,
    metalness: 1,
    clearcoat: 0,
    bump: 0.5,
  },
  cutting_mat: {
    paint: (u, v) => {
      // 300 mm tile: a line every 10 mm, a bold one every 50 mm
      const x = u * 300;
      const y = v * 300;
      const line = (a: number, every: number, w: number) => {
        const d = Math.abs(((a + every / 2) % every) - every / 2);
        return 1 - smooth(w * 0.5, w, d);
      };
      const fine = Math.max(line(x, 10, 0.35), line(y, 10, 0.35));
      const bold = Math.max(line(x, 50, 0.8), line(y, 50, 0.8));
      const n = fbm(u, v, 20, 2, 12) * 10;
      const base: [number, number, number] = [36 + n, 92 + n, 70 + n];
      const c = mix(mix(base, [118, 182, 150], fine * 0.55), [196, 232, 212], bold * 0.85);
      return { c, h: 0.5 - fine * 0.08 - bold * 0.12 + fbm(u, v, 80, 2, 4) * 0.1 };
    },
    tile: 300,
    roughness: 0.7,
    metalness: 0,
    clearcoat: 0,
    bump: 0.3,
  },
  paper: {
    paint: (u, v) => {
      const n = fbm(u, v, 32, 4, 17);
      const g = 236 + n * 12;
      return { c: [g, g * 0.985, g * 0.955], h: n };
    },
    tile: 260,
    roughness: 0.9,
    metalness: 0,
    clearcoat: 0,
    bump: 0.25,
  },
  felt: {
    paint: (u, v) => {
      const n = fbm(u, v, 48, 5, 27);
      const g = 92 + n * 34;
      return { c: [g * 0.98, g, g * 1.04], h: n };
    },
    tile: 220,
    roughness: 0.96,
    metalness: 0,
    clearcoat: 0,
    bump: 0.8,
  },
};

const cache = new Map<SurfaceId, SurfaceLook>();

/** The textures and material settings of a surface (made once, then cached). */
export function surfaceLook(id: SurfaceId): SurfaceLook {
  const hit = cache.get(id);
  if (hit) return hit;
  const p = PAINTERS[id];
  const color = new Uint8ClampedArray(N * N * 4);
  const height = new Float32Array(N * N);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const { c, h } = p.paint(x / N, y / N);
      const i = (y * N + x) * 4;
      color[i] = c[0];
      color[i + 1] = c[1];
      color[i + 2] = c[2];
      color[i + 3] = 255;
      height[y * N + x] = h;
      r += c[0];
      g += c[1];
      b += c[2];
    }
  // normal map from the height field (tileable differences)
  const nrm = new Uint8ClampedArray(N * N * 4);
  const k = p.bump * 6;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const hx = height[y * N + ((x + 1) % N)] - height[y * N + ((x + N - 1) % N)];
      const hy = height[((y + 1) % N) * N + x] - height[((y + N - 1) % N) * N + x];
      const nx = -hx * k;
      const ny = -hy * k;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      nrm[i] = (nx / l) * 127 + 128;
      nrm[i + 1] = (ny / l) * 127 + 128;
      nrm[i + 2] = (1 / l) * 127 + 128;
      nrm[i + 3] = 255;
    }
  const tex = (data: Uint8ClampedArray, srgb: boolean) => {
    const t = new THREE.DataTexture(new Uint8Array(data.buffer as ArrayBuffer), N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };
  const n2 = N * N;
  const look: SurfaceLook = {
    map: tex(color, true),
    normal: tex(nrm, false),
    tile: p.tile,
    roughness: p.roughness,
    metalness: p.metalness,
    clearcoat: p.clearcoat,
    tone: new THREE.Color(`rgb(${Math.round(r / n2)}, ${Math.round(g / n2)}, ${Math.round(b / n2)})`),
  };
  cache.set(id, look);
  return look;
}
