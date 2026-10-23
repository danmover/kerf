// A standard rider for bike airflow runs: a mannequin of tapered capsules
// and ellipsoids sized from the rider's height (segment lengths and girths
// from standard anthropometric tables), sat on the saddle, feet on pedals
// with the cranks level, hands on the bars in the chosen position. The
// torso angle is the position's usual one, adjusted until the arms reach
// the hands with the elbows a little bent.

import type { RiderPosition } from "../spec";
import type { V3 } from "./geometry";
import { add, cross, dot, norm, scale, sub } from "./setup";

/** Where the rider meets the bike, world mm: the saddle's top, the bars' box, the bottom bracket. */
export interface RiderAnchors {
  saddle: V3;
  bars: { lo: V3; hi: V3 };
  bb: V3;
  forward: V3;
  up: V3;
}

export interface RiderMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** for the summary: torso angle from level (degrees) and where the hands went */
  torsoAngle: number;
}

const TORSO_ANGLE: Record<RiderPosition, number> = { drops: 20, hoods: 32, tops: 45, tt: 10, upright: 62 };

/** Mesh builder: closed surfaces appended into one triangle list. */
class Builder {
  P: number[] = [];
  I: number[] = [];

  /** A capsule tapering from radius ra at a to rb at b (each end a hemisphere), elliptical when sx ≠ 1 across `side`. */
  capsule(a: V3, b: V3, ra: number, rb: number, seg = 20, side?: V3, sx = 1) {
    const ax = norm(sub(b, a));
    let u = side ? norm(sub(side, scale(ax, dot(side, ax)))) : norm(cross(ax, Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    if (!Number.isFinite(u[0])) u = norm(cross(ax, [1, 0, 0]));
    const v = cross(ax, u);
    const rings: { c: V3; r: number; along: number }[] = [];
    const cap = 6;
    // the end at a: a hemisphere
    for (let k = cap; k >= 1; k--) {
      const t = (k / cap) * (Math.PI / 2);
      rings.push({ c: add(a, scale(ax, -ra * Math.sin(t))), r: ra * Math.cos(t), along: 0 });
    }
    const body = 6;
    for (let k = 0; k <= body; k++) {
      const t = k / body;
      rings.push({ c: add(a, scale(sub(b, a), t)), r: ra + (rb - ra) * t, along: t });
    }
    for (let k = 1; k <= cap; k++) {
      const t = (k / cap) * (Math.PI / 2);
      rings.push({ c: add(b, scale(ax, rb * Math.sin(t))), r: rb * Math.cos(t), along: 1 });
    }
    this.lathe(rings, u, v, seg, sx);
  }

  /** An ellipsoid with semi-axes along three (unit) directions. */
  ellipsoid(c: V3, axes: [V3, V3, V3], r: V3, seg = 24) {
    const rings: { c: V3; r: number; along: number }[] = [];
    const n = 12;
    for (let k = 0; k <= n; k++) {
      const t = -Math.PI / 2 + (k / n) * Math.PI;
      rings.push({ c: add(c, scale(axes[0], r[0] * Math.sin(t))), r: Math.cos(t), along: 0 });
    }
    // ring radius 1 scaled per axis
    this.lathe(rings, scale(axes[1], r[1]), scale(axes[2], r[2]), seg, 1, true);
  }

  private lathe(rings: { c: V3; r: number }[], u: V3, v: V3, seg: number, sx: number, unitAxes = false) {
    const base = this.P.length / 3;
    const first = rings[0];
    const last = rings[rings.length - 1];
    // poles
    this.P.push(...first.c);
    const inner = rings.slice(1, -1);
    for (const g of inner)
      for (let s = 0; s < seg; s++) {
        const a = (2 * Math.PI * s) / seg;
        const cu = Math.cos(a) * g.r * (unitAxes ? 1 : sx);
        const cv = Math.sin(a) * g.r;
        this.P.push(g.c[0] + u[0] * cu + v[0] * cv, g.c[1] + u[1] * cu + v[1] * cv, g.c[2] + u[2] * cu + v[2] * cv);
      }
    this.P.push(...last.c);
    const top = base + 1 + inner.length * seg;
    const ring = (k: number, s: number) => base + 1 + k * seg + (s % seg);
    for (let s = 0; s < seg; s++) this.I.push(base, ring(0, s + 1), ring(0, s));
    for (let k = 0; k + 1 < inner.length; k++)
      for (let s = 0; s < seg; s++) {
        this.I.push(ring(k, s), ring(k, s + 1), ring(k + 1, s + 1));
        this.I.push(ring(k, s), ring(k + 1, s + 1), ring(k + 1, s));
      }
    for (let s = 0; s < seg; s++) this.I.push(top, ring(inner.length - 1, s), ring(inner.length - 1, s + 1));
  }
}

/** Two-link reach: the middle joint between a and c for links l1, l2, bending toward `bend`. */
function joint(a: V3, c: V3, l1: number, l2: number, bend: V3): V3 {
  const d = sub(c, a);
  const L = Math.min(Math.hypot(...d), 0.999 * (l1 + l2));
  const e = norm(d);
  const x = (L * L + l1 * l1 - l2 * l2) / (2 * L);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const side = norm(sub(bend, scale(e, dot(bend, e))));
  return add(add(a, scale(e, x)), scale(side, h));
}

/** The rider, world mm, for a height (mm) and position. */
export function riderMesh(at: RiderAnchors, position: RiderPosition, height: number): RiderMesh {
  const H = height;
  const F = norm(at.forward);
  const U = norm(sub(at.up, scale(F, dot(at.up, F))));
  const R = cross(F, U);
  const thigh = 0.245 * H,
    shank = 0.246 * H,
    upperArm = 0.186 * H,
    forearm = 0.146 * H,
    torso = 0.29 * H;
  const crank = 172.5;
  const k = H / 1780;

  // hips: sit bones on the saddle, the hip joints a little above and behind its top
  const hipC = add(add(at.saddle, scale(U, 85 * k)), scale(F, -20 * k));
  const hipW = 85 * k;
  // pedals level, ankles above and behind the spindles
  const pedalY = 110 * k;
  const feet = [1, -1].map((s) => add(add(add(at.bb, scale(F, s * crank)), scale(R, s * pedalY)), scale(U, 70 * k)));
  const ankles = feet.map((p) => add(p, scale(F, -55 * k)));
  const hips = [1, -1].map((s) => add(hipC, scale(R, s * hipW)));
  const knees = hips.map((h, i) => joint(h, ankles[i], thigh, shank, add(F, scale(U, 0.3))));

  // hands on the bars
  const { lo, hi } = at.bars;
  const proj = (p: V3) => [dot(p, F), dot(p, R), dot(p, U)];
  const corners: V3[] = [];
  for (let c = 0; c < 8; c++) corners.push([c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
  const pf = corners.map(proj);
  const fMax = Math.max(...pf.map((p) => p[0])),
    fMin = Math.min(...pf.map((p) => p[0]));
  const rMax = Math.max(...pf.map((p) => p[1])),
    rMin = Math.min(...pf.map((p) => p[1]));
  const uMax = Math.max(...pf.map((p) => p[2])),
    uMin = Math.min(...pf.map((p) => p[2]));
  const halfW = (rMax - rMin) / 2;
  const rMid = (rMax + rMin) / 2;
  const world = (f: number, r: number, u: number): V3 => add(add(scale(F, f), scale(R, r)), scale(U, u));
  let hand: (s: number) => V3;
  switch (position) {
    case "drops":
      hand = (s) => world(fMax - 0.45 * (fMax - fMin), rMid + s * (halfW - 20 * k), uMin + 25 * k);
      break;
    case "hoods":
      hand = (s) => world(fMax - 10 * k, rMid + s * (halfW - 25 * k), uMax + 15 * k);
      break;
    case "tops":
      hand = (s) => world(fMin + 0.35 * (fMax - fMin), rMid + s * Math.min(halfW - 40 * k, 140 * k), uMax);
      break;
    case "tt":
      hand = (s) => world(fMax + 120 * k, rMid + s * 45 * k, uMax + 110 * k);
      break;
    default:
      hand = (s) => world(fMin + 0.5 * (fMax - fMin), rMid + s * (halfW - 30 * k), uMax);
  }
  const hands = [1, -1].map(hand);
  const shoulderW = 0.13 * H;
  const handMid = scale(add(hands[0], hands[1]), 0.5);

  // torso angle: the position's usual one, moved until the arms reach with the elbows a little bent
  const arm = upperArm + forearm;
  const shoulderAt = (deg: number) => add(hipC, scale(add(scale(F, Math.cos((deg * Math.PI) / 180)), scale(U, Math.sin((deg * Math.PI) / 180))), torso));
  const reachOk = (deg: number) => {
    const sh = shoulderAt(deg);
    const d = Math.hypot(...sub(add(handMid, scale(R, 0)), sh));
    const lateral = Math.abs(halfW - shoulderW);
    const reach = Math.hypot(d, lateral);
    return { reach, ok: reach <= 0.94 * arm && reach >= 0.55 * arm };
  };
  let ang = TORSO_ANGLE[position];
  for (let dA = 0; dA <= 45; dA += 1) {
    if (reachOk(ang + dA).ok) {
      ang += dA;
      break;
    }
    if (dA <= 15 && reachOk(ang - dA).ok) {
      ang -= dA;
      break;
    }
  }
  const shC = shoulderAt(ang);
  const shoulders = [1, -1].map((s) => add(shC, scale(R, s * shoulderW)));
  const tAxis = norm(sub(shC, hipC));
  const tNorm = cross(tAxis, R);
  const elbows =
    position === "tt"
      ? hands.map((h) => add(h, scale(F, -forearm)))
      : shoulders.map((sh, i) => joint(sh, hands[i], upperArm, forearm, add(add(scale(U, -0.6), scale(F, -0.3)), scale(R, i ? -0.15 : 0.15))));

  const b = new Builder();
  // torso: pelvis and chest as ellipsoids along the torso axis
  b.ellipsoid(add(hipC, scale(tAxis, 0.04 * H)), [tAxis, R, tNorm], [0.09 * H, 0.09 * H, 0.062 * H]);
  b.ellipsoid(add(hipC, scale(tAxis, 0.5 * torso)), [tAxis, R, tNorm], [0.55 * torso, 0.095 * H, 0.066 * H]);
  b.ellipsoid(add(shC, scale(tAxis, -0.02 * H)), [tAxis, R, tNorm], [0.08 * H, 0.105 * H, 0.058 * H]);
  // neck and helmeted head, looking ahead
  const neck = add(shC, scale(add(tAxis, scale(U, 0.6)), 0.04 * H));
  const head = add(add(shC, scale(norm(add(tAxis, scale(U, 1.2))), 0.115 * H)), scale(F, 0.02 * H));
  b.capsule(shC, neck, 0.035 * H, 0.032 * H, 16);
  b.ellipsoid(head, [F, R, U], [0.075 * H, 0.058 * H, 0.068 * H]);
  // limbs
  for (let i = 0; i < 2; i++) {
    b.capsule(hips[i], knees[i], 0.045 * H, 0.031 * H, 18);
    b.capsule(knees[i], ankles[i], 0.03 * H, 0.02 * H, 16);
    b.capsule(ankles[i], add(feet[i], scale(F, 0.08 * H)), 0.022 * H, 0.018 * H, 12, U, 1.4);
    b.capsule(shoulders[i], elbows[i], 0.025 * H, 0.02 * H, 14);
    b.capsule(elbows[i], hands[i], 0.019 * H, 0.015 * H, 14);
  }
  return { positions: Float32Array.from(b.P), indices: Uint32Array.from(b.I), torsoAngle: ang };
}
