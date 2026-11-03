// Turns a distance field into triangles with surface nets: one vertex per
// grid cell the surface passes through, one quad per grid edge it crosses.
// Blocks of the grid far from the surface are skipped, so only the thin
// shell round the surface is evaluated.

export type DistFn = (x: number, y: number, z: number) => number;
type V3 = [number, number, number];

export interface RawMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Most grid points one mesh may use (about 160 MB of floats would be too much for a worker). */
export const MAX_GRID_POINTS = 12_000_000;

const BLOCK = 8;

export function surfaceNets(dist: DistFn, lo: V3, hi: V3, cellIn: number): RawMesh {
  let cell = cellIn;
  const dims = () => [0, 1, 2].map((i) => Math.ceil((hi[i] - lo[i]) / cell) + 3);
  let [nx, ny, nz] = dims();
  while (nx * ny * nz > MAX_GRID_POINTS) {
    cell *= 1.15;
    [nx, ny, nz] = dims();
  }
  // one empty cell of margin all round
  const ox = lo[0] - cell;
  const oy = lo[1] - cell;
  const oz = lo[2] - cell;
  const sxy = nx * ny;
  const vals = new Float32Array(nx * ny * nz);

  // coarse pass: blocks whose centre is far from the surface are all one side of it
  const reach = BLOCK * cell * 0.87 * 1.3 + cell;
  const bx = Math.ceil((nx - 1) / BLOCK);
  const by = Math.ceil((ny - 1) / BLOCK);
  const bz = Math.ceil((nz - 1) / BLOCK);
  const active: number[] = [];
  for (let k = 0; k < bz; k++)
    for (let j = 0; j < by; j++)
      for (let i = 0; i < bx; i++) {
        const cx = ox + (i * BLOCK + BLOCK / 2) * cell;
        const cy = oy + (j * BLOCK + BLOCK / 2) * cell;
        const cz = oz + (k * BLOCK + BLOCK / 2) * cell;
        const d = dist(cx, cy, cz);
        if (Math.abs(d) <= reach) {
          active.push(i, j, k);
          continue;
        }
        const i1 = Math.min(nx, i * BLOCK + BLOCK + 1);
        const j1 = Math.min(ny, j * BLOCK + BLOCK + 1);
        const k1 = Math.min(nz, k * BLOCK + BLOCK + 1);
        for (let z = k * BLOCK; z < k1; z++)
          for (let y = j * BLOCK; y < j1; y++) {
            const row = z * sxy + y * nx;
            for (let x = i * BLOCK; x < i1; x++) vals[row + x] = d;
          }
      }
  // exact values near the surface (written last so they win on shared block faces)
  for (let a = 0; a < active.length; a += 3) {
    const i = active[a];
    const j = active[a + 1];
    const k = active[a + 2];
    const i1 = Math.min(nx, i * BLOCK + BLOCK + 1);
    const j1 = Math.min(ny, j * BLOCK + BLOCK + 1);
    const k1 = Math.min(nz, k * BLOCK + BLOCK + 1);
    for (let z = k * BLOCK; z < k1; z++) {
      const pz = oz + z * cell;
      for (let y = j * BLOCK; y < j1; y++) {
        const py = oy + y * cell;
        const row = z * sxy + y * nx;
        for (let x = i * BLOCK; x < i1; x++) vals[row + x] = dist(ox + x * cell, py, pz);
      }
    }
  }
  // the outermost points are always outside, so the surface closes
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) {
          const at = z * sxy + y * nx + x;
          if (vals[at] <= 0) vals[at] = cell * 0.01;
        }

  // a vertex in every cell the surface crosses
  const cx = nx - 1;
  const cy = ny - 1;
  const cz = nz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const pos: number[] = [];
  const corner = [0, 1, nx, nx + 1, sxy, sxy + 1, sxy + nx, sxy + nx + 1];
  const cOff = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const EDGES = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const v = new Float64Array(8);
  for (let z = 0; z < cz; z++)
    for (let y = 0; y < cy; y++)
      for (let x = 0; x < cx; x++) {
        const base = z * sxy + y * nx + x;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = vals[base + corner[c]];
          if (v[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [a, b] of EDGES) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += cOff[a][0] + (cOff[b][0] - cOff[a][0]) * t;
          sy += cOff[a][1] + (cOff[b][1] - cOff[a][1]) * t;
          sz += cOff[a][2] + (cOff[b][2] - cOff[a][2]) * t;
          n++;
        }
        cellVert[(z * cy + y) * cx + x] = pos.length / 3;
        pos.push(ox + (x + sx / n) * cell, oy + (y + sy / n) * cell, oz + (z + sz / n) * cell);
      }

  // a quad round every grid edge the surface crosses, facing out of the inside
  const idx: number[] = [];
  const C = (x: number, y: number, z: number) => cellVert[(z * cy + y) * cx + x];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) [b, d] = [d, b];
    // split along the shorter diagonal
    const d1 = dist2(pos, a, c);
    const d2 = dist2(pos, b, d);
    if (d1 <= d2) idx.push(a, b, c, a, c, d);
    else idx.push(a, b, d, b, c, d);
  };
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const p = z * sxy + y * nx + x;
        const inside = vals[p] < 0;
        if (x + 1 < nx && y > 0 && z > 0 && y < ny - 1 && z < nz - 1 && inside !== vals[p + 1] < 0) quad(C(x, y - 1, z - 1), C(x, y, z - 1), C(x, y, z), C(x, y - 1, z), !inside);
        if (y + 1 < ny && x > 0 && z > 0 && x < nx - 1 && z < nz - 1 && inside !== vals[p + nx] < 0) quad(C(x - 1, y, z - 1), C(x - 1, y, z), C(x, y, z), C(x, y, z - 1), !inside);
        if (z + 1 < nz && x > 0 && y > 0 && x < nx - 1 && y < ny - 1 && inside !== vals[p + sxy] < 0) quad(C(x - 1, y - 1, z), C(x, y - 1, z), C(x, y, z), C(x - 1, y, z), !inside);
      }

  const positions = new Float32Array(pos);
  project(positions, dist, cell);
  return { positions, indices: new Uint32Array(idx) };
}

function dist2(p: number[], a: number, b: number) {
  const dx = p[a * 3] - p[b * 3];
  const dy = p[a * 3 + 1] - p[b * 3 + 1];
  const dz = p[a * 3 + 2] - p[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Pull each vertex onto the surface along the field's gradient, never more than half a cell. */
function project(pos: Float32Array, dist: DistFn, cell: number) {
  const e = cell * 0.05;
  const lim = cell * 0.5;
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i];
    let y = pos[i + 1];
    let z = pos[i + 2];
    const x0 = x;
    const y0 = y;
    const z0 = z;
    for (let it = 0; it < 2; it++) {
      const d = dist(x, y, z);
      const gx = dist(x + e, y, z) - dist(x - e, y, z);
      const gy = dist(x, y + e, z) - dist(x, y - e, z);
      const gz = dist(x, y, z + e) - dist(x, y, z - e);
      const g2 = (gx * gx + gy * gy + gz * gz) / (4 * e * e);
      if (g2 < 1e-6) break;
      const s = d / g2 / (2 * e);
      x -= gx * s;
      y -= gy * s;
      z -= gz * s;
    }
    const mx = x - x0;
    const my = y - y0;
    const mz = z - z0;
    const m = Math.sqrt(mx * mx + my * my + mz * mz);
    const k = m > lim ? lim / m : 1;
    pos[i] = x0 + mx * k;
    pos[i + 1] = y0 + my * k;
    pos[i + 2] = z0 + mz * k;
  }
}

/** Unit gradient of the field: the outward normal at a point on the surface. */
export function fieldNormal(dist: DistFn, x: number, y: number, z: number, e: number): V3 {
  const gx = dist(x + e, y, z) - dist(x - e, y, z);
  const gy = dist(x, y + e, z) - dist(x, y - e, z);
  const gz = dist(x, y, z + e) - dist(x, y, z - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
}
