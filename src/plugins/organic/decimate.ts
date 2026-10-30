// Mesh simplification by quadric edge collapse (Garland and Heckbert): the
// cheapest edge to remove goes first, so flat areas lose triangles and
// ears, claws and colour borders keep theirs. This is what gives the
// faceted low-poly look of hand-made game models.

export interface DecimateInput {
  positions: Float32Array;
  indices: Uint32Array;
  /** colour of each face; borders between colours are kept in place */
  faceColor?: Int32Array;
}

export interface DecimateOutput {
  positions: Float32Array;
  indices: Uint32Array;
  faceColor: Int32Array;
}

interface HeapItem {
  cost: number;
  a: number;
  b: number;
  x: number;
  y: number;
  z: number;
  sa: number;
  sb: number;
}

class Heap {
  private a: HeapItem[] = [];
  get size() {
    return this.a.length;
  }
  push(it: HeapItem) {
    const a = this.a;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= it.cost) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = it;
  }
  pop(): HeapItem | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (!a.length || !last) return top;
    let i = 0;
    const n = a.length;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && a[r].cost < a[l].cost ? r : l;
      if (a[c].cost >= last.cost) break;
      a[i] = a[c];
      i = c;
    }
    a[i] = last;
    return top;
  }
}

/** Weight of the planes that hold colour borders and open edges in place. */
const SEAM_WEIGHT = 40;

export function decimate(input: DecimateInput, targetFaces: number): DecimateOutput {
  const nv = input.positions.length / 3;
  const nf = input.indices.length / 3;
  const P = Float64Array.from(input.positions);
  const F = Int32Array.from(input.indices);
  const color = input.faceColor ? Int32Array.from(input.faceColor) : new Int32Array(nf);
  const faceAlive = new Uint8Array(nf).fill(1);
  const vertAlive = new Uint8Array(nv).fill(1);
  const stamp = new Int32Array(nv);
  const Q = new Float64Array(nv * 10);
  const vf: number[][] = Array.from({ length: nv }, () => []);
  for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) vf[F[f * 3 + c]].push(f);

  const addPlane = (v: number, a: number, b: number, c: number, d: number, w: number) => {
    const q = v * 10;
    Q[q] += w * a * a;
    Q[q + 1] += w * a * b;
    Q[q + 2] += w * a * c;
    Q[q + 3] += w * a * d;
    Q[q + 4] += w * b * b;
    Q[q + 5] += w * b * c;
    Q[q + 6] += w * b * d;
    Q[q + 7] += w * c * c;
    Q[q + 8] += w * c * d;
    Q[q + 9] += w * d * d;
  };
  const faceNormal = (f: number, out: number[]) => {
    const i = F[f * 3] * 3;
    const j = F[f * 3 + 1] * 3;
    const k = F[f * 3 + 2] * 3;
    const ux = P[j] - P[i];
    const uy = P[j + 1] - P[i + 1];
    const uz = P[j + 2] - P[i + 2];
    const vx = P[k] - P[i];
    const vy = P[k + 1] - P[i + 1];
    const vz = P[k + 2] - P[i + 2];
    out[0] = uy * vz - uz * vy;
    out[1] = uz * vx - ux * vz;
    out[2] = ux * vy - uy * vx;
    return Math.hypot(out[0], out[1], out[2]);
  };

  const n = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    const l = faceNormal(f, n);
    if (l < 1e-12) continue;
    const a = n[0] / l;
    const b = n[1] / l;
    const c = n[2] / l;
    const i = F[f * 3] * 3;
    const d = -(a * P[i] + b * P[i + 1] + c * P[i + 2]);
    const area = l / 2;
    for (let k = 0; k < 3; k++) addPlane(F[f * 3 + k], a, b, c, d, area);
  }

  // edges: which faces use them, to find open edges and colour borders
  const edgeFaces = new Map<number, number[]>();
  const key = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
  for (let f = 0; f < nf; f++)
    for (let k = 0; k < 3; k++) {
      const a = F[f * 3 + k];
      const b = F[f * 3 + ((k + 1) % 3)];
      const e = key(a, b);
      const list = edgeFaces.get(e);
      if (list) list.push(f);
      else edgeFaces.set(e, [f]);
    }
  for (const [e, fs] of edgeFaces) {
    const seam = fs.length !== 2 || color[fs[0]] !== color[fs[1]];
    if (!seam) continue;
    const a = Math.floor(e / nv);
    const b = e - a * nv;
    // a plane through the edge, square to its face
    faceNormal(fs[0], n);
    const ex = P[b * 3] - P[a * 3];
    const ey = P[b * 3 + 1] - P[a * 3 + 1];
    const ez = P[b * 3 + 2] - P[a * 3 + 2];
    let px = ey * n[2] - ez * n[1];
    let py = ez * n[0] - ex * n[2];
    let pz = ex * n[1] - ey * n[0];
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-12) continue;
    px /= pl;
    py /= pl;
    pz /= pl;
    const d = -(px * P[a * 3] + py * P[a * 3 + 1] + pz * P[a * 3 + 2]);
    const w = SEAM_WEIGHT * (ex * ex + ey * ey + ez * ez);
    addPlane(a, px, py, pz, d, w);
    addPlane(b, px, py, pz, d, w);
  }

  const heap = new Heap();
  const qsum = new Float64Array(10);
  const evalQ = (q: Float64Array, x: number, y: number, z: number) =>
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  const consider = (a: number, b: number) => {
    for (let i = 0; i < 10; i++) qsum[i] = Q[a * 10 + i] + Q[b * 10 + i];
    const q = qsum;
    // solve the 3x3 system for the point with least error
    const m00 = q[0];
    const m01 = q[1];
    const m02 = q[2];
    const m11 = q[4];
    const m12 = q[5];
    const m22 = q[7];
    const det = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02);
    let x: number;
    let y: number;
    let z: number;
    const ax = P[a * 3];
    const ay = P[a * 3 + 1];
    const az = P[a * 3 + 2];
    const bx = P[b * 3];
    const by = P[b * 3 + 1];
    const bz = P[b * 3 + 2];
    let cost: number;
    const scale = Math.abs(m00) + Math.abs(m11) + Math.abs(m22);
    if (Math.abs(det) > 1e-9 * scale * scale * scale) {
      const r0 = -q[3];
      const r1 = -q[6];
      const r2 = -q[8];
      x = (r0 * (m11 * m22 - m12 * m12) - m01 * (r1 * m22 - m12 * r2) + m02 * (r1 * m12 - m11 * r2)) / det;
      y = (m00 * (r1 * m22 - m12 * r2) - r0 * (m01 * m22 - m12 * m02) + m02 * (m01 * r2 - r1 * m02)) / det;
      z = (m00 * (m11 * r2 - r1 * m12) - m01 * (m01 * r2 - r1 * m02) + r0 * (m01 * m12 - m11 * m02)) / det;
      // a far-off optimum means a poorly conditioned system: stay on the edge
      const ex = bx - ax;
      const ey = by - ay;
      const ez = bz - az;
      const el = Math.hypot(ex, ey, ez);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const mz = (az + bz) / 2;
      if (Math.hypot(x - mx, y - my, z - mz) > el * 2) {
        x = mx;
        y = my;
        z = mz;
      }
      cost = evalQ(q, x, y, z);
    } else {
      const ca = evalQ(q, ax, ay, az);
      const cb = evalQ(q, bx, by, bz);
      const cm = evalQ(q, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      if (cm <= ca && cm <= cb) {
        x = (ax + bx) / 2;
        y = (ay + by) / 2;
        z = (az + bz) / 2;
        cost = cm;
      } else if (ca <= cb) {
        x = ax;
        y = ay;
        z = az;
        cost = ca;
      } else {
        x = bx;
        y = by;
        z = bz;
        cost = cb;
      }
    }
    heap.push({ cost: Math.max(cost, 0), a, b, x, y, z, sa: stamp[a], sb: stamp[b] });
  };

  for (const e of edgeFaces.keys()) {
    const a = Math.floor(e / nv);
    consider(a, e - a * nv);
  }

  let alive = nf;
  const before = [0, 0, 0];
  const after = [0, 0, 0];
  const nbrs = (v: number, out: Set<number>) => {
    out.clear();
    for (const f of vf[v]) if (faceAlive[f]) for (let k = 0; k < 3; k++) if (F[f * 3 + k] !== v) out.add(F[f * 3 + k]);
    return out;
  };
  const na = new Set<number>();
  const nb = new Set<number>();
  // would moving v to (x, y, z) fold or squash any of its faces (other than those on the edge)?
  const folds = (v: number, other: number, x: number, y: number, z: number) => {
    for (const f of vf[v]) {
      if (!faceAlive[f]) continue;
      let hasOther = false;
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === other) hasOther = true;
      if (hasOther) continue;
      const lb = faceNormal(f, before);
      const sx = P[v * 3];
      const sy = P[v * 3 + 1];
      const sz = P[v * 3 + 2];
      P[v * 3] = x;
      P[v * 3 + 1] = y;
      P[v * 3 + 2] = z;
      const la = faceNormal(f, after);
      P[v * 3] = sx;
      P[v * 3 + 1] = sy;
      P[v * 3 + 2] = sz;
      if (la < 1e-12 || lb < 1e-12) return true;
      if ((before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (la * lb) < 0.25) return true;
    }
    return false;
  };

  while (alive > targetFaces && heap.size) {
    const it = heap.pop()!;
    const { a, b } = it;
    if (!vertAlive[a] || !vertAlive[b] || stamp[a] !== it.sa || stamp[b] !== it.sb) continue;
    // the edge's faces
    const shared: number[] = [];
    for (const f of vf[a]) if (faceAlive[f] && (F[f * 3] === b || F[f * 3 + 1] === b || F[f * 3 + 2] === b)) shared.push(f);
    if (shared.length !== 2) continue;
    // link condition: a and b may share only the two vertices opposite the edge
    nbrs(a, na);
    nbrs(b, nb);
    let common = 0;
    for (const v of na) if (nb.has(v)) common++;
    if (common !== 2) continue;
    if (folds(a, b, it.x, it.y, it.z) || folds(b, a, it.x, it.y, it.z)) continue;

    // collapse b into a
    P[a * 3] = it.x;
    P[a * 3 + 1] = it.y;
    P[a * 3 + 2] = it.z;
    for (let i = 0; i < 10; i++) Q[a * 10 + i] += Q[b * 10 + i];
    for (const f of shared) {
      faceAlive[f] = 0;
      alive--;
    }
    const keep: number[] = [];
    for (const f of vf[a]) if (faceAlive[f]) keep.push(f);
    for (const f of vf[b]) {
      if (!faceAlive[f]) continue;
      for (let k = 0; k < 3; k++) if (F[f * 3 + k] === b) F[f * 3 + k] = a;
      keep.push(f);
    }
    vf[a] = keep;
    vf[b] = [];
    vertAlive[b] = 0;
    // only edges touching a change cost; the old ones go stale with its stamp
    stamp[a]++;
    for (const v of nbrs(a, na)) consider(a, v);
  }

  // compact
  const remap = new Int32Array(nv).fill(-1);
  const pos: number[] = [];
  const idx: number[] = [];
  const fc: number[] = [];
  for (let f = 0; f < nf; f++) {
    if (!faceAlive[f]) continue;
    for (let k = 0; k < 3; k++) {
      const v = F[f * 3 + k];
      if (remap[v] < 0) {
        remap[v] = pos.length / 3;
        pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      }
      idx.push(remap[v]);
    }
    fc.push(color[f]);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), faceColor: new Int32Array(fc) };
}
