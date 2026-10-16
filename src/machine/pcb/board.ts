// Circuit board placement: the rules a board is made to, where every pad and
// hole lands on the board, and the quick placement check the editor runs on
// every drag (parts overlapping, off the board, over a screw, pins the nets
// name that the footprint lacks). Routing lives in route.ts.

import { bodyShape, boxesTouch, capsule, circle, cosSin, grow, normDeg, padShape, partXf, shapeBox, shapeEdgeDist, shapeGap, type Shape } from "./geom";
import { DEFAULT_RULES, type BoardRules, type BoardSpec, type DrcItem, type Pad, type PlacedPart } from "./types";

export function boardRules(spec: BoardSpec): BoardRules {
  const r = spec.rules ?? {};
  return { ...DEFAULT_RULES, ...r, via: { ...DEFAULT_RULES.via, ...(r.via ?? {}) } };
}

/** A pad in board coordinates. */
export interface PlacedPad {
  ref: string;
  pin: string;
  num?: string;
  x: number;
  y: number;
  shape: Pad["shape"];
  w: number;
  h: number;
  drill: number;
  slot?: number;
  /** degrees counter-clockwise seen from the top; a pad's shape is symmetric, so mirroring leaves only the part's turn */
  rot: number;
  side: "top" | "bottom";
  /** index into spec.parts */
  part: number;
  /** the net its pin is on, if any */
  net?: string;
}

export interface PlacedHole {
  x: number;
  y: number;
  d: number;
  /** the part it belongs to; board mounting holes have none */
  ref?: string;
}

/** Smallest drill and annular ring the board houses make without extra cost. */
export const MIN_DRILL = 0.3;
export const MIN_RING = 0.15;
/** Smallest gap between the edges of two drilled holes. */
export const MIN_HOLE_GAP = 0.25;

/** Keep-out radius around a mounting hole for parts and pads: a screw head, washer or standoff is about twice the hole. */
export const headRadius = (d: number) => d;

export const pinKey = (ref: string, pin: string) => `${ref}\u0000${pin}`;

/** The net of every pin the nets name (the first net, when a pin is wrongly in two). */
export function pinNets(spec: BoardSpec): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of spec.nets) for (const p of n.pins) if (!m.has(pinKey(p.ref, p.pin))) m.set(pinKey(p.ref, p.pin), n.name);
  return m;
}

export function placedPads(spec: BoardSpec): PlacedPad[] {
  const nets = pinNets(spec);
  const out: PlacedPad[] = [];
  spec.parts.forEach((part, pi) => {
    const xf = partXf(part);
    const rot = normDeg(part.rot);
    for (const pad of part.fp.pads) {
      const [x, y] = xf(pad.x, pad.y);
      const pp: PlacedPad = { ref: part.ref, pin: pad.pin, x, y, shape: pad.shape, w: pad.w, h: pad.h, drill: pad.drill, rot, side: part.side, part: pi };
      if (pad.num !== undefined) pp.num = pad.num;
      if (pad.slot !== undefined) pp.slot = pad.slot;
      const net = nets.get(pinKey(part.ref, pad.pin));
      if (net !== undefined) pp.net = net;
      out.push(pp);
    }
  });
  return out;
}

/** Non-plated holes: the board's mounting holes and the footprints' own. */
export function placedHoles(spec: BoardSpec): PlacedHole[] {
  const out: PlacedHole[] = spec.holes.map((h) => ({ x: h.x, y: h.y, d: h.d }));
  for (const part of spec.parts) {
    const xf = partXf(part);
    for (const h of part.fp.holes ?? []) {
      const [x, y] = xf(h.x, h.y);
      out.push({ x, y, d: h.d, ref: part.ref });
    }
  }
  return out;
}

/** Drill and annular ring problems of one plated hole (pads and vias). */
export function drillProblems(what: string, p: { shape: Pad["shape"]; w: number; h: number; drill: number; slot?: number }): string[] {
  const out: string[] = [];
  if (p.drill < MIN_DRILL - 1e-9) out.push(`${what} has a ${mm(p.drill)} mm drill; board houses need at least ${mm(MIN_DRILL)} mm.`);
  const short = p.shape === "circle" ? Math.max(p.w, p.h) : Math.min(p.w, p.h);
  const long = p.shape === "circle" ? short : Math.max(p.w, p.h);
  const ring = Math.min((short - p.drill) / 2, p.slot !== undefined ? (long - p.slot) / 2 : Infinity);
  if (ring < MIN_RING - 1e-9) out.push(`${what} leaves a ${mm(Math.max(0, ring))} mm copper ring round its hole; it needs at least ${mm(MIN_RING)} mm.`);
  return out;
}

export const mm = (v: number) => (Math.round(v * 100) / 100).toString();
const padName = (p: PlacedPad) => `${p.ref} pin ${p.num ?? p.pin}`;

/**
 * The placement check. Fast enough to run while a part is dragged: a few
 * hundred pads and bodies, compared pairwise only when their boxes meet.
 */
export function checkPlacement(spec: BoardSpec): DrcItem[] {
  const rules = boardRules(spec);
  const out: DrcItem[] = [];
  const byRef = new Map<string, PlacedPart>();
  for (const p of spec.parts) {
    if (byRef.has(p.ref)) out.push({ kind: "pin", message: `Two parts are called ${p.ref}.`, x: p.x, y: p.y, refs: [p.ref] });
    else byRef.set(p.ref, p);
  }

  // the netlist against the footprints
  const inNet = new Set<string>();
  const netOfPin = new Map<string, string>();
  for (const n of spec.nets) {
    for (const pr of n.pins) {
      const part = byRef.get(pr.ref);
      if (!part) {
        out.push({ kind: "pin", message: `Net ${n.name} names ${pr.ref}.${pr.pin}, but there is no part ${pr.ref} on the board.`, x: 0, y: 0, nets: [n.name] });
        continue;
      }
      if (!part.fp.pads.some((pd) => pd.pin === pr.pin)) {
        out.push({ kind: "pin", message: `Net ${n.name} names ${pr.ref}.${pr.pin}, but the ${part.fp.name} footprint has no pin ${pr.pin}.`, x: part.x, y: part.y, refs: [pr.ref], nets: [n.name] });
        continue;
      }
      inNet.add(pr.ref);
      const k = pinKey(pr.ref, pr.pin);
      const prev = netOfPin.get(k);
      if (prev !== undefined && prev !== n.name) out.push({ kind: "short", message: `${pr.ref}.${pr.pin} is in two nets, ${prev} and ${n.name}.`, x: part.x, y: part.y, refs: [pr.ref], nets: [prev, n.name] });
      else netOfPin.set(k, n.name);
    }
  }
  for (const p of spec.parts) if (!inNet.has(p.ref)) out.push({ kind: "pin", message: `${p.ref} (${p.value}) is in no net, so nothing connects to it.`, x: p.x, y: p.y, refs: [p.ref] });

  const pads = placedPads(spec);
  const holes = placedHoles(spec);
  const shapes = pads.map((p) => padShape(p));
  const boxes = shapes.map(shapeBox);

  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    for (const msg of drillProblems(padName(p), p)) out.push({ kind: "drill", message: msg, x: p.x, y: p.y, refs: [p.ref] });
    const e = shapeEdgeDist(spec, shapes[i]);
    if (e < rules.edge - 1e-6)
      out.push({ kind: "offboard", message: e < 0 ? `${padName(p)} is off the board.` : `${padName(p)} is ${mm(e)} mm from the board edge; copper needs ${mm(rules.edge)} mm.`, x: p.x, y: p.y, refs: [p.ref] });
    for (const h of holes) {
      if (h.ref === p.ref) continue;
      // board mounting holes keep pads clear of the screw head; a footprint's own holes only need copper clearance
      const keep = h.ref === undefined ? headRadius(h.d) : h.d / 2 + rules.edge;
      const g = shapeGap(shapes[i], circle(h.x, h.y, keep));
      if (g < -1e-6) out.push({ kind: "clearance", message: `${padName(p)} is too close to the ${mm(h.d)} mm ${h.ref ? `hole of ${h.ref}` : "mounting hole"}.`, x: p.x, y: p.y, refs: h.ref ? [p.ref, h.ref] : [p.ref] });
    }
  }

  // pad to pad: copper clearance between different pins, and drills too close together
  for (let i = 0; i < pads.length; i++) {
    const a = pads[i];
    const ba = grow(boxes[i], rules.clearance + 1);
    for (let j = i + 1; j < pads.length; j++) {
      const b = pads[j];
      if (!boxesTouch(ba, boxes[j])) continue;
      if (a.ref === b.ref && a.pin === b.pin) continue;
      const sameNet = a.net !== undefined && a.net === b.net;
      const hg = shapeGap(holeShape(a), holeShape(b));
      if (hg < MIN_HOLE_GAP - 1e-6) {
        out.push({ kind: hg < 0 ? "overlap" : "drill", message: `The holes of ${padName(a)} and ${padName(b)} ${hg < 0 ? "overlap" : `are only ${mm(hg)} mm apart`}.`, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, refs: uniq([a.ref, b.ref]) });
        continue;
      }
      if (sameNet) continue;
      const g = shapeGap(shapes[i], shapes[j]);
      if (g < rules.clearance - 1e-6) {
        const nets = [a.net, b.net].filter((n): n is string => !!n);
        out.push({
          kind: g < 0 ? "overlap" : "clearance",
          message: g < 0 ? `${padName(a)} and ${padName(b)} overlap.` : `${padName(a)} and ${padName(b)} are ${mm(g)} mm apart; they need ${mm(rules.clearance)} mm.`,
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          refs: uniq([a.ref, b.ref]),
          ...(nets.length ? { nets } : {}),
        });
      }
    }
  }

  // bodies: off the board, on top of each other, over another part's pads or a screw
  const bodies = spec.parts.map((p) => bodyShape(p, 0.05));
  const bboxes = bodies.map(shapeBox);
  spec.parts.forEach((p, i) => {
    if (shapeEdgeDist(spec, bodies[i]) < -0.01) out.push({ kind: "offboard", message: `${p.ref} hangs over the board edge.`, x: p.x, y: p.y, refs: [p.ref] });
    for (let j = i + 1; j < spec.parts.length; j++) {
      const q = spec.parts[j];
      if (q.side !== p.side || !boxesTouch(bboxes[i], bboxes[j])) continue;
      if (shapeGap(bodies[i], bodies[j]) < 0) out.push({ kind: "overlap", message: `${p.ref} and ${q.ref} overlap.`, ...mid(bodies[i], bodies[j]), refs: [p.ref, q.ref] });
    }
    // a pad under any other body can't be soldered or holds the part off the board
    const hit = new Set<string>();
    for (let k = 0; k < pads.length; k++) {
      const pd = pads[k];
      if (pd.part === i || hit.has(pd.ref) || !boxesTouch(bboxes[i], boxes[k])) continue;
      if (shapeGap(bodies[i], shapes[k]) < 0) {
        hit.add(pd.ref);
        out.push({ kind: "overlap", message: `${p.ref} sits over ${padName(pd)}${pd.side !== p.side ? ", which is soldered on that side" : ""}.`, x: pd.x, y: pd.y, refs: [p.ref, pd.ref] });
      }
    }
    for (const h of holes) {
      if (h.ref === p.ref) continue;
      const keep = h.ref === undefined ? headRadius(h.d) : h.d / 2;
      if (shapeGap(bodies[i], circle(h.x, h.y, keep)) < 0) out.push({ kind: "overlap", message: `${p.ref} is in the way of the ${h.ref ? `hole of ${h.ref}` : "mounting screw"} at (${mm(h.x)}, ${mm(h.y)}).`, x: h.x, y: h.y, refs: h.ref ? [p.ref, h.ref] : [p.ref] });
    }
  });
  return out;
}

/** The drilled hole of a pad: a circle, or for a slot a capsule along the pad's long side. */
export function holeShape(p: Pick<PlacedPad, "x" | "y" | "w" | "h" | "rot" | "drill" | "slot">): Shape {
  if (!p.slot || p.slot <= p.drill) return circle(p.x, p.y, p.drill / 2);
  const [c, s] = cosSin(p.rot);
  const [ux, uy] = p.w >= p.h ? [c, s] : [-s, c];
  const half = (p.slot - p.drill) / 2;
  return capsule(p.x - ux * half, p.y - uy * half, p.x + ux * half, p.y + uy * half, p.drill / 2);
}

const uniq = (xs: string[]) => [...new Set(xs)];

function mid(a: Shape, b: Shape): { x: number; y: number } {
  const ba = shapeBox(a);
  const bb = shapeBox(b);
  return { x: (Math.max(ba[0], bb[0]) + Math.min(ba[2], bb[2])) / 2, y: (Math.max(ba[1], bb[1]) + Math.min(ba[3], bb[3])) / 2 };
}

// ---------------------------------------------------------------- hash

/** 53-bit string hash (cyrb53). */
function cyrb53(s: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Hash of everything the copper depends on: outline, holes, pads and where
 * they are, nets and rules. Values, names, bodies and texts only change the
 * silkscreen, which the output files draw from the current spec, so a cached
 * RoutedBoard stays good when only those change (swap in the new spec).
 */
export function boardHash(spec: BoardSpec): string {
  const r = boardRules(spec);
  const key = JSON.stringify([
    spec.w,
    spec.h,
    spec.corner ?? 0,
    spec.holes.map((h) => [h.x, h.y, h.d]),
    spec.parts.map((p) => [p.ref, p.x, p.y, normDeg(p.rot), p.side, p.fp.pads.map((d) => [d.pin, d.x, d.y, d.shape, d.w, d.h, d.drill, d.slot ?? 0]), (p.fp.holes ?? []).map((h) => [h.x, h.y, h.d])]),
    spec.nets.map((n) => [n.name, n.pins.map((p) => [p.ref, p.pin]), n.width ?? 0, !!n.pour]),
    [r.clearance, r.track, r.via.pad, r.via.drill, r.grid, r.edge],
  ]);
  return cyrb53(key, 1).toString(16).padStart(14, "0") + cyrb53(key, 2).toString(16).padStart(14, "0");
}
