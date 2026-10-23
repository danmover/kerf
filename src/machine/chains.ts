// Roller chains (lib.chain) and the sprockets they run on (lib.sprocket):
// the chain standards, the ISO 606 tooth form, where every roller sits
// (seated in a tooth gap on each sprocket, evenly spaced along the free
// spans), the chain as a solid of real links, and what the chain asks of the
// drive: the ratio each sprocket must turn at, link count, wrap, chain line
// and pull. The evaluator lays a chain out with layoutBelt (the pitch-line
// geometry is the same as a belt's), the viewport moves the links with
// chainRollers, and chainChecks reads the ChainInfo the part carries.

import type { PartRecipe, Profile, ProfileSeg, ShapeRecipe, V2, V3, Xform } from "../kernel/recipe";
import { vadd, vscale } from "../kernel/recipe";
import type { BeltSpec } from "./belts";

// ---------------------------------------------------------------- chain data

export interface ChainSpec {
  id: string;
  name: string;
  /** pitch, mm */
  pitch: number;
  /** roller diameter d1 */
  roller: number;
  /** width between the inner plates b1 */
  inner: number;
  /** plate height and thickness */
  plateH: number;
  plateT: number;
  pinD: number;
  /** minimum tensile strength, N */
  breakN: number;
  /** kg per metre */
  mass: number;
  /** a derailleur chain: made to run a little out of line */
  bike: boolean;
  /** fewest teeth a sprocket should have */
  minTeeth: number;
  /** price of a chain about 1.5 m long, USD */
  price: number;
  search: string;
}

export const CHAINS: Record<string, ChainSpec> = {
  bike_11s: { id: "bike_11s", name: "11-speed bicycle chain (Shimano CN-HG901 class)", pitch: 12.7, roller: 7.75, inner: 2.18, plateH: 7.4, plateT: 0.75, pinD: 3.6, breakN: 8000, mass: 0.175, bike: true, minTeeth: 9, price: 45, search: "11 speed road chain Shimano Dura-Ace CN-HG901 116 links" },
  bike_12s: { id: "bike_12s", name: "12-speed bicycle chain (Shimano CN-M9100 class)", pitch: 12.7, roller: 7.75, inner: 2.1, plateH: 7.4, plateT: 0.7, pinD: 3.6, breakN: 8000, mass: 0.168, bike: true, minTeeth: 9, price: 50, search: "12 speed chain Shimano CN-M9100 126 links" },
  bike_1s: { id: "bike_1s", name: "Single-speed bicycle chain, 1/2 × 1/8 in", pitch: 12.7, roller: 7.75, inner: 3.3, plateH: 7.6, plateT: 1.1, pinD: 3.7, breakN: 9500, mass: 0.26, bike: true, minTeeth: 9, price: 15, search: "single speed chain 1/2 x 1/8 112 links" },
  ansi_25: { id: "ansi_25", name: "ANSI #25 roller chain, 1/4 in pitch", pitch: 6.35, roller: 3.3, inner: 3.18, plateH: 6.0, plateT: 0.76, pinD: 2.31, breakN: 3100, mass: 0.14, bike: false, minTeeth: 9, price: 12, search: "#25 roller chain 1/4 inch pitch 5 feet" },
  iso_06b: { id: "iso_06b", name: "ISO 06B roller chain, 3/8 in pitch", pitch: 9.525, roller: 6.35, inner: 5.72, plateH: 8.2, plateT: 1.3, pinD: 3.28, breakN: 9000, mass: 0.41, bike: false, minTeeth: 9, price: 20, search: "06B-1 roller chain 3/8 pitch 5 feet" },
};

export const CHAIN_IDS = Object.keys(CHAINS);

export class ChainError extends Error {}

export function chainSpec(id: string): ChainSpec {
  const c = CHAINS[id];
  if (!c) throw new ChainError(`"${id}" is not a chain. Chains: ${CHAIN_IDS.join(", ")}`);
  return c;
}

/** A chain's pitch-line geometry is a belt's: the radii are given, so only the pitch matters here. */
export function chainAsBelt(c: ChainSpec): BeltSpec {
  return { pitch: c.pitch, width: c.inner, thickness: 0, toothH: 0, pld: 0, mass: c.mass, ea: 1e9, teMax: c.breakN, tMin: 0, tMax: c.breakN, tNominal: 0, minTeeth: c.minTeeth, core: "steel", closed: true };
}

// ---------------------------------------------------------------- sprocket tooth form (ISO 606)

export const sprocketPd = (p: number, z: number) => p / Math.sin(Math.PI / z);
/** the smallest tip diameter the standard allows, which is what most sprockets are cut to */
export const sprocketTip = (p: number, z: number, d1: number) => sprocketPd(p, z) + p * (1 - 1.6 / z) - d1;
/** roller seating radius */
export const seatRadius = (d1: number) => 0.505 * d1 + 0.069 * Math.cbrt(d1);
export const sprocketRoot = (p: number, z: number, d1: number) => sprocketPd(p, z) - 2 * seatRadius(d1);
/** tooth width for a single-strand chain */
export const toothWidth = (c: ChainSpec) => 0.93 * c.inner;

/**
 * The tooth outline: a roller seat at each gap (gap 0 on +x), straight flanks
 * tangent to it, and the tip circle between. Teeth too pointed for a tip land
 * meet at a point.
 */
export function sprocketProfile(p: number, z: number, d1: number): Profile {
  const R = sprocketPd(p, z) / 2;
  const ra = sprocketTip(p, z, d1) / 2;
  const ri = seatRadius(d1);
  const half = ((140 - 90 / z) * Math.PI) / 180 / 2;
  const step = (2 * Math.PI) / z;
  const at = (c: V2, r: number, a: number): V2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  // where a flank line from P along -d (entry) or +d (exit) reaches the tip circle
  const toTip = (P: V2, d: V2): V2 => {
    const b = P[0] * d[0] + P[1] * d[1];
    const c = P[0] * P[0] + P[1] * P[1] - ra * ra;
    const t = -b + Math.sqrt(Math.max(0, b * b - c));
    return [P[0] + t * d[0], P[1] + t * d[1]];
  };
  const gaps = Array.from({ length: z }, (_, i) => {
    const th = i * step;
    const C: V2 = [R * Math.cos(th), R * Math.sin(th)];
    const phiIn = th + Math.PI + half;
    const phiOut = th + Math.PI - half;
    const S1 = at(C, ri, phiIn);
    const S2 = at(C, ri, phiOut);
    // travel round the seat is clockwise about its centre: direction (sin φ, -cos φ)
    const dIn: V2 = [Math.sin(phiIn), -Math.cos(phiIn)];
    const dOut: V2 = [Math.sin(phiOut), -Math.cos(phiOut)];
    return { th, S1, S2, bottom: at(C, ri, th + Math.PI), E1: toTip(S1, [-dIn[0], -dIn[1]]), E2: toTip(S2, dOut), dIn, dOut };
  });
  const ang = (q: V2) => Math.atan2(q[1], q[0]);
  const segs: ProfileSeg[] = [];
  // tooth i lies between gap i's exit and gap i+1's entry
  const tips = gaps.map((g, i) => {
    const n = gaps[(i + 1) % z];
    let a2 = ang(n.E1);
    let a1 = ang(g.E2);
    while (a2 < a1) a2 += 2 * Math.PI;
    if (a2 - a1 > 1e-4 && a2 - a1 < step) return { a: g.E2, b: n.E1, mid: at([0, 0], ra, (a1 + a2) / 2) };
    // pointed tooth: the two flank lines cross below the tip circle
    const p1 = g.S2;
    const d1v = g.dOut;
    const p2 = n.S1;
    const d2v: V2 = [-n.dIn[0], -n.dIn[1]];
    const den = d1v[0] * d2v[1] - d1v[1] * d2v[0];
    const t = ((p2[0] - p1[0]) * d2v[1] - (p2[1] - p1[1]) * d2v[0]) / den;
    const X: V2 = [p1[0] + t * d1v[0], p1[1] + t * d1v[1]];
    return { a: X, b: X, mid: undefined };
  });
  const start = tips[z - 1].b;
  for (let i = 0; i < z; i++) {
    const g = gaps[i];
    segs.push({ s: "line", to: g.S1 });
    segs.push({ s: "arc", via: g.bottom, to: g.S2 });
    const t = tips[i];
    segs.push({ s: "line", to: t.a });
    if (t.mid) segs.push({ s: "arc", via: t.mid, to: t.b });
  }
  return { t: "path2", start, segs };
}

// ---------------------------------------------------------------- the laid-out chain

export interface ChainNode {
  name: string;
  /** centre in the chain's plane, pitch radius, and which way the chain runs round it (+1 counter-clockwise in (u, v)) */
  c: V2;
  r: number;
  dir: 1 | -1;
  z: number;
  /** degrees of wrap, and rollers seated over it */
  wrap: number;
  engaged: number;
  outside: boolean;
  /** distance of its tooth plane from the chain's plane, and the tilt of its axis from square, degrees */
  offset: number;
  tilt: number;
  /** angle in the plane of a seat (gap centre) as drawn, radians */
  seat0: number;
  /** how it turns: its rate about its own axis (× the driver) and that axis' sign against the plane normal */
  rate: number;
  axisSign: 1 | -1;
  /** turned by the chain alone (a jockey wheel or tensioner) rather than carrying the drive */
  idler: boolean;
  /** its own declared rate when it does not match what the chain makes it turn at */
  declared?: number;
}

export type ChainPiece = { k: "line"; a: V2; b: V2; len: number; s0: number } | { k: "arc"; node: number; c: V2; r: number; a0: number; sweep: number; s0: number };

export interface ChainInfo {
  name: string;
  spec: ChainSpec;
  plane: { o: V3; u: V3; v: V3; n: V3 };
  pieces: ChainPiece[];
  /** pitch-line length of the path, mm */
  length: number;
  /** links the chain is bought or cut to (even), and what the path needs exactly */
  links: number;
  needLinks: number;
  linksGiven: boolean;
  /** an idler, jockey wheel or tensioner takes up the slack */
  tensioner: boolean;
  nodes: ChainNode[];
  /** links that pass per degree of the driver (signed: positive runs along the path's order) */
  linkRate: number;
  /** mm of travel along the laid-out path per degree of the driver: linkRate × length / links */
  speed: number;
  drive?: string;
  /** torque at the drive sprocket, N·mm, and the pull it puts in the chain, N */
  torque?: number;
  pull?: number;
  spans: { from: string; to: string; length: number }[];
}

const TAU = Math.PI * 2;

/**
 * Where every roller sits, in the chain's plane, with the driver turned
 * `angle` degrees. Each roller has a place along the pitch line that moves
 * with the chain; a roller on a sprocket drops into the tooth gap nearest it
 * (the gaps turn with the sprocket), and the rollers on a free span between
 * two seated ones slide along with them, so every link stays about a pitch
 * long and the first roller off a sprocket lifts out of its gap the way a
 * real chain does.
 */
export function chainRollers(c: ChainInfo, angle = 0): V2[] {
  return rollerPlaces(c, angle).map((r) => r.q);
}

/**
 * The rollers as chainRollers places them, each with how far it sits off the
 * chain's plane (along its normal): on a sprocket, that sprocket's tooth
 * plane; on a span, partway from one sprocket's plane to the next, so a
 * derailleur chain angles across from the chainring to the cog it is on.
 */
export function rollerPlaces(c: ChainInfo, angle = 0): { q: V2; w: number }[] {
  const N = c.links;
  const L = c.length;
  const ds = L / N;
  const shift = c.speed * angle;
  const rad = (angle * Math.PI) / 180;
  const wrapS = (s: number) => ((s % L) + L) % L;
  const P = c.pieces.length;
  const offOf = (k: number) => {
    const p = c.pieces[((k % P) + P) % P];
    return p.k === "arc" ? c.nodes[p.node].offset : 0;
  };
  // the place on the pitch line, and for a place on a sprocket the seat it drops into
  let pi = 0;
  const place = (s0: number): { q: V2; w: number; shift: number | null } => {
    const s = wrapS(s0);
    let tries = 0;
    while (tries++ < P && !inPiece(c.pieces[pi], s, L)) pi = (pi + 1) % P;
    const p = c.pieces[pi];
    if (p.k === "line") {
      const t = Math.min(1, Math.max(0, (s - p.s0) / Math.max(1e-9, p.len)));
      const w = offOf(pi - 1) + (offOf(pi + 1) - offOf(pi - 1)) * t;
      return { q: [p.a[0] + (p.b[0] - p.a[0]) * t, p.a[1] + (p.b[1] - p.a[1]) * t], w, shift: null };
    }
    const nd = c.nodes[p.node];
    const rel = s - p.s0 < 0 ? s - p.s0 + L : s - p.s0;
    const phi = p.a0 + Math.sign(p.sweep) * (rel / p.r);
    const step = TAU / nd.z;
    const base = nd.seat0 + nd.rate * nd.axisSign * rad;
    const a = base + Math.round((phi - base) / step) * step;
    return { q: [p.c[0] + p.r * Math.cos(a), p.c[1] + p.r * Math.sin(a)], w: nd.offset, shift: (a - phi) * Math.sign(p.sweep) * p.r };
  };
  const s = Array.from({ length: N }, (_, k) => k * ds + shift);
  const first = s.map(place);
  const seated = first.map((f, k) => (f.shift !== null ? k : -1)).filter((k) => k >= 0);
  if (!seated.length) return first;
  const out = [...first];
  seated.forEach((a, i) => {
    const b = i + 1 < seated.length ? seated[i + 1] : seated[0] + N;
    const da = first[a].shift!;
    const db = first[b % N].shift!;
    for (let j = a + 1; j < b; j++) out[j % N] = place(s[j % N] + da + ((db - da) * (j - a)) / (b - a));
  });
  return out;
}

function inPiece(p: ChainPiece, s: number, L: number): boolean {
  const len = p.k === "line" ? p.len : Math.abs(p.sweep) * p.r;
  const e = p.s0 + len;
  return (s >= p.s0 - 1e-9 && s < e + 1e-9) || (e > L && s < e - L);
}

/** World point of a point in the chain's plane. */
export const chainPoint = (c: ChainInfo, q: V2): V3 => vadd(c.plane.o, vadd(vscale(c.plane.u, q[0]), vscale(c.plane.v, q[1])));

// ---------------------------------------------------------------- the solid

/** One link's plate outline along u, centred: two round ends joined by a waist. */
export function plateProfile(c: ChainSpec): Profile {
  const p = c.pitch;
  return { t: "union2", ps: [{ t: "circle", d: c.plateH, c: [-p / 2, 0] }, { t: "circle", d: c.plateH, c: [p / 2, 0] }, { t: "rect", w: p, h: 0.78 * c.plateH, r: 0, c: [0, 0] }] };
}

/** Where the plates sit across the chain: inner plates just outside the rollers, outer plates outside those. */
export function plateOffsets(c: ChainSpec): { inner: number; outer: number } {
  return { inner: c.inner / 2, outer: c.inner / 2 + c.plateT + 0.05 };
}

/** The chain as a solid: every roller, pin and plate where it sits, each link built once and placed. */
export function chainRecipe(info: ChainInfo): PartRecipe {
  const c = info.spec;
  const { u, n } = info.plane;
  const rollers = rollerPlaces(info, 0);
  const off = plateOffsets(c);
  const pair = (z0: number): ShapeRecipe => ({
    t: "union",
    shapes: [
      { t: "extrude", p: plateProfile(c), h: c.plateT, f: { o: vscale(n, z0), u, n }, twist: 0, scale: 1 },
      { t: "extrude", p: plateProfile(c), h: c.plateT, f: { o: vscale(n, -z0 - c.plateT), u, n }, twist: 0, scale: 1 },
    ],
  });
  const roller: ShapeRecipe = {
    t: "union",
    shapes: [
      { t: "cyl", d: c.roller, h: c.inner, at: vscale(n, -c.inner / 2), dir: n },
      { t: "cyl", d: c.pinD, h: c.inner + 4 * c.plateT + 0.4, at: vscale(n, -(c.inner / 2 + 2 * c.plateT + 0.2)), dir: n },
    ],
  };
  const at = (q: V2, w: number): Xform => ({ op: "translate", v: vadd(chainPoint(info, q), vscale(n, w)) });
  const innerX: Xform[][] = [];
  const outerX: Xform[][] = [];
  rollers.forEach((ra, k) => {
    const rb = rollers[(k + 1) % rollers.length];
    const [a, b] = [ra.q, rb.q];
    const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    const xf: Xform[] = [{ op: "rotate", angle: ang, origin: [0, 0, 0], axis: n }, at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], (ra.w + rb.w) / 2)];
    (k % 2 === 0 ? innerX : outerX).push(xf);
  });
  return {
    base: {
      t: "instances",
      items: [
        { shape: roller, xfs: rollers.map((r) => [at(r.q, r.w)]) },
        { shape: pair(off.inner), xfs: innerX },
        { shape: pair(off.outer), xfs: outerX },
      ],
    },
    ops: [],
  };
}

// ---------------------------------------------------------------- figures

/** Links to buy: what is asked for, else the next even number that reaches round the path. */
export function linksFor(needLinks: number, given?: number): number {
  if (given !== undefined) return given;
  return Math.max(4, 2 * Math.ceil(needLinks / 2 - 1e-6));
}

/** Speed ripple from the chain riding up and down the sprocket's flats (polygon action): 1 - cos(180°/z). */
export const polygonRipple = (z: number) => 1 - Math.cos(Math.PI / z);
