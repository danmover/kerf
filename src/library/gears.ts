// Involute spur gear geometry, shared by the kernel (solids) and the
// mesh checker (2D tooth interference across a rotation).

import type { V2 } from "../kernel/recipe";

export interface GearSpec {
  m: number; // module
  z: number; // teeth
  pa?: number; // pressure angle, degrees
  backlash?: number; // circumferential backlash at the pitch circle, mm
  phase?: number; // degrees
}

export const pitchDiameter = (m: number, z: number) => m * z;
export const tipDiameter = (m: number, z: number) => m * (z + 2);
export const rootDiameter = (m: number, z: number) => m * (z - 2.5);
export const centerDistance = (m: number, z1: number, z2: number) => (m * (z1 + z2)) / 2;

const inv = (a: number) => Math.tan(a) - a;

/** Closed CCW outline of the gear in its local XY plane (no bore). */
export function gearOutline({ m, z, pa = 20, backlash = 0.05, phase = 0 }: GearSpec, flankSteps = 5): V2[] {
  const alpha = (pa * Math.PI) / 180;
  const rp = (m * z) / 2;
  const rb = rp * Math.cos(alpha);
  const ra = rp + m;
  const rf = Math.max(rp - 1.25 * m, 0.1);
  // half tooth angle at the pitch circle, reduced by half the backlash
  const psiP = Math.PI / (2 * z) - backlash / (4 * rp);
  const half = (r: number) => {
    const rr = Math.max(r, rb);
    return psiP + inv(alpha) - inv(Math.acos(Math.min(1, rb / rr)));
  };
  const rStart = Math.max(rb, rf);
  const pts: V2[] = [];
  const pitch = (2 * Math.PI) / z;
  const ph = (phase * Math.PI) / 180;
  const at = (r: number, a: number): V2 => [r * Math.cos(a), r * Math.sin(a)];
  for (let i = 0; i < z; i++) {
    const c = ph + i * pitch;
    // root segment (radial) when the root circle is inside the base circle
    if (rf < rb) pts.push(at(rf, c - half(rb)));
    // lower-angle flank, root -> tip
    for (let s = 0; s <= flankSteps; s++) {
      const r = rStart + ((ra - rStart) * s) / flankSteps;
      pts.push(at(r, c - Math.max(half(r), 0)));
    }
    // tip land (only when the tooth is not pointed)
    const tipHalf = Math.max(half(ra), 0);
    if (tipHalf > 1e-4) pts.push(at(ra, c));
    // upper-angle flank, tip -> root
    for (let s = flankSteps; s >= 0; s--) {
      const r = rStart + ((ra - rStart) * s) / flankSteps;
      pts.push(at(r, c + Math.max(half(r), 0)));
    }
    if (rf < rb) pts.push(at(rf, c + half(rb)));
    // root land midpoint toward the next tooth
    pts.push(at(rf, c + pitch / 2));
  }
  return dedupe(pts);
}

function dedupe(pts: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push(p);
  }
  const f = out[0];
  const l = out[out.length - 1];
  if (out.length > 2 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-4) out.pop();
  return out;
}

/**
 * Rotation (degrees) to give a gear so its teeth interleave with a gear it
 * meshes with. Angles are measured in the shared (u, v) frame of the two
 * parallel axes; theta is the direction from the driver to the driven gear.
 */
export function meshPhase(thetaDeg: number, driverPhaseDeg: number, zDriver: number, zDriven: number): number {
  const p = thetaDeg + 180 + 180 / zDriven + ((thetaDeg - driverPhaseDeg) * zDriver) / zDriven;
  const pitch = 360 / zDriven;
  return ((p % pitch) + pitch) % pitch;
}

// ---------- 2D polygon helpers for tooth interference ----------

export function pointInPolygon(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (crosses(p, poly[i], poly[j])) inside = !inside;
  return inside;
}

/** Whether a ray from p towards +x crosses the edge between corners i and j (the even-odd rule). */
function crosses(p: V2, [xi, yi]: V2, [xj, yj]: V2): boolean {
  return yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
}

/**
 * pointInPolygon for many points against one polygon. The edges are sorted
 * into horizontal bands first, so each point meets only the edges level with
 * it, the only ones its ray can cross: the same answers, many times faster.
 */
function insideTest(poly: V2[]): (p: V2) => boolean {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [, y] of poly) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const n = Math.max(1, poly.length >> 2);
  const h = (y1 - y0) / n || 1;
  const band = (y: number) => Math.min(n - 1, Math.max(0, Math.floor((y - y0) / h)));
  const bands: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const lo = band(Math.min(poly[i][1], poly[j][1]));
    const hi = band(Math.max(poly[i][1], poly[j][1]));
    for (let k = lo; k <= hi; k++) bands[k].push(i);
  }
  return (p) => {
    let inside = false;
    for (const i of bands[band(p[1])]) if (crosses(p, poly[i], poly[i ? i - 1 : poly.length - 1])) inside = !inside;
    return inside;
  };
}

function distToSegment(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Largest depth by which any vertex of A lies inside B (0 when clear). */
export function maxPenetration(a: V2[], b: V2[]): number {
  let worst = 0;
  // quick reject by radius: a point outside the circle through B's farthest corner cannot be inside B,
  // which for two meshing gears leaves only the few teeth in mesh for the full test
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of b) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let r2 = 0;
  for (const [x, y] of b) r2 = Math.max(r2, (x - cx) ** 2 + (y - cy) ** 2);
  const inB = insideTest(b);
  for (const p of a) {
    if ((p[0] - cx) ** 2 + (p[1] - cy) ** 2 > r2) continue;
    if (!inB(p)) continue;
    let d = Infinity;
    for (let i = 0, j = b.length - 1; i < b.length; j = i++) d = Math.min(d, distToSegment(p, b[j], b[i]));
    worst = Math.max(worst, d);
  }
  return worst;
}

/** Densify a polygon so vertex-in-polygon tests catch flank contact. */
export function densify(poly: V2[], maxSeg: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxSeg));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
