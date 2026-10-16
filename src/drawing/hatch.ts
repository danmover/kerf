// Section hatching and detail-view clipping, in sheet coordinates.

/**
 * Hatch lines filling closed loops (flat x, y lists) by the even-odd rule.
 * angle in degrees on paper (counter-clockwise), spacing in sheet mm.
 */
export function hatchLines(loops: number[][], angle: number, spacing: number): [number, number, number, number][] {
  const a = (-angle * Math.PI) / 180; // sheet y points down
  const c = Math.cos(a);
  const s = Math.sin(a);
  // rotate into a frame where hatch lines are horizontal
  const rot = (x: number, y: number): [number, number] => [x * c + y * s, -x * s + y * c];
  const back = (u: number, v: number): [number, number] => [u * c - v * s, u * s + v * c];
  const edges: [number, number, number, number][] = [];
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const l of loops) {
    const n = l.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ax, ay] = rot(l[2 * i], l[2 * i + 1]);
      const [bx, by] = rot(l[2 * j], l[2 * j + 1]);
      edges.push([ax, ay, bx, by]);
      v0 = Math.min(v0, ay, by);
      v1 = Math.max(v1, ay, by);
    }
  }
  const out: [number, number, number, number][] = [];
  if (!Number.isFinite(v0) || spacing <= 0) return out;
  const first = Math.ceil(v0 / spacing) * spacing;
  for (let v = first; v <= v1 && out.length < 20000; v += spacing) {
    const xs: number[] = [];
    for (const [ax, ay, bx, by] of edges) {
      // half-open rule so shared vertices count once
      if (ay <= v === by <= v) continue;
      xs.push(ax + ((v - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < 1e-6) continue;
      const [x1, y1] = back(xs[i], v);
      const [x2, y2] = back(xs[i + 1], v);
      out.push([x1, y1, x2, y2]);
    }
  }
  return out;
}

/** Signed area of a loop (positive counter-clockwise in a y-up frame). */
export function loopArea(l: number[]): number {
  let a = 0;
  const n = l.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += l[2 * i] * l[2 * j + 1] - l[2 * j] * l[2 * i + 1];
  }
  return a / 2;
}

/** Parts of segment ab inside the circle (c, r), as parameter ranges. */
export function clipSegmentToCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): [number, number][] {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const A = dx * dx + dy * dy;
  if (A < 1e-18) return fx * fx + fy * fy <= r * r ? [[0, 1]] : [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [];
  const sq = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - sq) / (2 * A));
  const t1 = Math.min(1, (-B + sq) / (2 * A));
  return t1 > t0 ? [[t0, t1]] : [];
}

/** Clips a polyline (flat list) to a circle, returning the inside pieces. */
export function clipPolylineToCircle(p: number[], cx: number, cy: number, r: number): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1];
    const bx = p[i + 2];
    const by = p[i + 3];
    const ranges = clipSegmentToCircle(ax, ay, bx, by, cx, cy, r);
    if (!ranges.length) {
      flush();
      continue;
    }
    const [t0, t1] = ranges[0];
    const sx = ax + (bx - ax) * t0;
    const sy = ay + (by - ay) * t0;
    const ex = ax + (bx - ax) * t1;
    const ey = ay + (by - ay) * t1;
    if (t0 > 1e-9) flush();
    if (!cur.length) cur.push(sx, sy);
    cur.push(ex, ey);
    if (t1 < 1 - 1e-9) flush();
  }
  flush();
  return out;
}

/** Points along an arc (paper angles, counter-clockwise; sheet y down). */
export function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, maxSeg = 0.5): number[] {
  const sweep = a1 - a0;
  const n = Math.max(8, Math.min(720, Math.ceil((Math.abs(sweep) * r) / maxSeg)));
  const p: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    p.push(cx + r * Math.cos(a), cy - r * Math.sin(a));
  }
  return p;
}
