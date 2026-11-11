// Which way a printed part lies on the bed, shared by the build pack (which turns each STL that way) and the strength
// analysis (whose print layers stack the same way): on its largest flat face it can rest on, unless the modelled bottom
// is nearly as good, or the way its process's build: says.

type V3 = [number, number, number];

/**
 * The outward normal of the face a mesh rests on when printed (in the mesh's own frame) and that face's flat area.
 * With a build direction, the face opposite it.
 */
export function restFace(P: ArrayLike<number>, I: ArrayLike<number>, build?: V3): { n: V3; area: number } {
  const nTri = I.length / 3;
  const area = new Float64Array(nTri);
  const nrm = new Float64Array(nTri * 3);
  const buckets = new Map<string, { n: V3; area: number }>();
  for (let t = 0; t < nTri; t++) {
    const a = I[t * 3] * 3;
    const b = I[t * 3 + 1] * 3;
    const c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a],
      uy = P[b + 1] - P[a + 1],
      uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a],
      vy = P[c + 1] - P[a + 1],
      vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    area[t] = l / 2;
    nrm[t * 3] = nx / l;
    nrm[t * 3 + 1] = ny / l;
    nrm[t * 3 + 2] = nz / l;
    const key = `${Math.round((nx / l) * 50)},${Math.round((ny / l) * 50)},${Math.round((nz / l) * 50)}`;
    const e = buckets.get(key) ?? { n: [nx / l, ny / l, nz / l] as V3, area: 0 };
    e.area += l / 2;
    buckets.set(key, e);
  }
  // area of the flat face on the outside in each candidate direction (pockets and steps do not count)
  const restArea = (n: V3) => {
    let support = -Infinity;
    for (let i = 0; i < P.length; i += 3) support = Math.max(support, P[i] * n[0] + P[i + 1] * n[1] + P[i + 2] * n[2]);
    let a = 0;
    for (let t = 0; t < nTri; t++) {
      if (!area[t] || nrm[t * 3] * n[0] + nrm[t * 3 + 1] * n[1] + nrm[t * 3 + 2] * n[2] < 0.999) continue;
      const v = I[t * 3] * 3;
      if (Math.abs(P[v] * n[0] + P[v + 1] * n[1] + P[v + 2] * n[2] - support) < 0.05) a += area[t];
    }
    return a;
  };
  if (build) {
    const n: V3 = [-build[0], -build[1], -build[2]];
    return { n, area: restArea(n) };
  }
  const candidates = [...buckets.values()].sort((x, y) => y.area - x.area).slice(0, 12);
  const down: V3 = [0, 0, -1];
  if (!candidates.some((c) => c.n[2] < -0.999)) candidates.push({ n: down, area: 0 });
  let best = { n: down, area: restArea(down) };
  const asModelled = best.area;
  for (const c of candidates) {
    const a = restArea(c.n);
    if (a > best.area + 1e-6) best = { n: c.n, area: a };
  }
  // keep the modelled orientation when it is nearly as good: designers often model printed parts the way they print
  if (asModelled >= best.area * 0.9) best = { n: down, area: asModelled };
  return best;
}

/** The way a printed part's layers stack, in its own frame: away from the face it rests on. */
export function printUp(P: ArrayLike<number>, I: ArrayLike<number>, build?: V3): V3 {
  const { n } = restFace(P, I, build);
  return [-n[0] + 0, -n[1] + 0, -n[2] + 0];
}
