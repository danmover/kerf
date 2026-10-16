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
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
  // quick reject by radius
  for (const p of a) {
    if (!pointInPolygon(p, b)) continue;
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
