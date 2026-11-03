// Small, fast 3D noises for surface detail and wobbly paint edges. Fixed
// tables, so the same model always gives the same surface.

const PERM = new Uint8Array(512);
{
  // a fixed shuffle of 0..255 (xorshift, constant seed)
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 0x9e3779b9 >>> 0;
  for (let i = 255; i > 0; i--) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    const j = s % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

const GRAD = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad(h: number, x: number, y: number, z: number) {
  const g = (h % 12) * 3;
  return GRAD[g] * x + GRAD[g + 1] * y + GRAD[g + 2] * z;
}

/** Gradient (Perlin) noise, about -1 to 1. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const X = xi & 255;
  const Y = yi & 255;
  const Z = zi & 255;
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);
  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(grad(PERM[AA], xf, yf, zf), grad(PERM[BA], xf - 1, yf, zf), u), l(grad(PERM[AB], xf, yf - 1, zf), grad(PERM[BB], xf - 1, yf - 1, zf), u), v),
    l(l(grad(PERM[AA + 1], xf, yf, zf - 1), grad(PERM[BA + 1], xf - 1, yf, zf - 1), u), l(grad(PERM[AB + 1], xf, yf - 1, zf - 1), grad(PERM[BB + 1], xf - 1, yf - 1, zf - 1), u), v),
    w,
  );
}

const hash = (x: number, y: number, z: number, k: number) => PERM[(PERM[(PERM[(x + k * 31) & 255] + y) & 255] + z) & 255] / 255;

/** Distances to the nearest and second-nearest of a jittered grid of points (cell noise). */
export function voronoi3(x: number, y: number, z: number): [number, number] {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  let f1 = Infinity;
  let f2 = Infinity;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx;
        const cy = yi + dy;
        const cz = zi + dz;
        const px = cx + hash(cx, cy, cz, 0);
        const py = cy + hash(cx, cy, cz, 1);
        const pz = cz + hash(cx, cy, cz, 2);
        const d = Math.hypot(px - x, py - y, pz - z);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
  return [f1, f2];
}
