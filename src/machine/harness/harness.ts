// The design's wiring harness in 3D: one entry per row of the wire list (the
// same rows as the build pack's wire list and diagram), each with a plug at
// both ends placed on the right pin of the right part, and the route request
// that the cable router (route.ts) turns into a cable run. A terminal takes
// only so many wires (one per crimp housing, two in a twin ferrule or under
// a screw); the rest are joined to the first wire in a splice next to it, so
// plugs never sit on top of each other.

import type { Model } from "../../core/model";
import { xformMatrix, type V3 } from "../../kernel/recipe";
import { catalogPart } from "../catalog";
import type { MachineData } from "../types";
import { componentPositions, wireList, wireHex, type WireEnd, type WireRow } from "../wiring";
import { PITCH, cableWires, plugFor, type PlugKind, type PlugSpec } from "./plugs";
import type { RouteKeepOut, RouteWire } from "./route";
import { slotPoint, type TravelPlan } from "./travel";

/** A plug frame: origin and axes (x along the contacts, z the way it goes in, y = z × x). */
export interface Frame {
  o: V3;
  x: V3;
  y: V3;
  z: V3;
}

export interface PlugEnd {
  /** the component instance's main solid: the plug moves with it */
  partId: string;
  /** component name, with [i] for pattern instances */
  comp: string;
  pin: string;
  /** label printed on the part, or the pin id */
  label: string;
  /** the part's name, e.g. "BIGTREETECH SKR Mini E3 V3.0" */
  part: string;
  spec: PlugSpec;
  /** the plug in the part's own frame */
  local: Frame;
  /** the plug in the assembly */
  frame: Frame;
  /** the terminal's wires are joined in a splice next to it: this end runs through it (with no plug of its own unless it is the splice's first wire) */
  splice?: Splice;
}

/** Wires joined in a heat-shrunk crimp splice just behind a terminal that cannot take them all. */
export interface Splice {
  /** the wire that keeps the plug on the terminal */
  host: string;
  /** every wire through the splice, the host first */
  wires: string[];
  /** where the sleeve starts and ends, in the assembly; dir runs from the plug along the lead */
  from: V3;
  to: V3;
  dir: V3;
  across: V3;
  /** the part and pin it is on */
  partId: string;
  comp: string;
  pin: string;
  label: string;
}

export interface HarnessWire {
  /** W1, W2, ... as in the wire list */
  id: string;
  row: WireRow;
  ends: [PlugEnd, PlugEnd];
  /** the wires inside the cable, in contact order: colour (hex) and insulated diameter */
  wires: { color: string; name: string; d: number }[];
  /** outside diameter of the cable as a whole, mm */
  d: number;
  /** the connector kind of a cable between ports (stepper4, fan2...) */
  port?: string;
}

/** A header, terminal or barrier screw drawn on a part whose geometry has none. */
export interface Socket {
  partId: string;
  kind: PlugKind;
  ways: number;
  pitch: number;
  local: Frame;
  /** a cable is plugged in */
  used: boolean;
}

export interface Harness {
  wires: HarnessWire[];
  sockets: Socket[];
}

/** How far each kind of plug stands off the part: the wires leave its back here, mm along `out`. */
export const PLUG_BACK: Record<PlugKind, number> = {
  xh: 9.8,
  ph: 8.2,
  dupont: 16.5,
  ferrule: 8,
  fork: 13,
  ring: 13,
  usb_c: 22,
  usb_micro: 17,
  xt60: 16,
  lead: 3,
  solder: 1.2,
  lug: 6,
  barrel: 26,
  spade: 15,
};

/** How many wires one terminal of each kind takes: a crimp housing holds one, a twin ferrule, a screw or a solder joint two. */
export const SPOT_WIRES: Record<PlugKind, number> = {
  xh: 1,
  ph: 1,
  dupont: 1,
  ferrule: 2,
  fork: 2,
  ring: 2,
  usb_c: 1,
  usb_micro: 1,
  xt60: 1,
  lead: 1,
  solder: 2,
  lug: 2,
  barrel: 1,
  spade: 1,
};

/** Length of a splice's heat-shrink sleeve, mm. */
export const SPLICE_LEN = 18;

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

export const applyPoint = (m: number[], p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
export const applyDir = (m: number[], d: V3): V3 => norm([m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]]);

/** an orthonormal frame from a spec's out and row (row is made square to out) */
function localFrame(o: V3, out: V3, row: V3): Frame {
  const z = norm(out);
  let x = add(row, z, -dot(row, z));
  if (Math.hypot(...x) < 1e-6) x = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  x = norm(add(x, z, -dot(x, z)));
  return { o, x, y: cross(z, x), z };
}

export function placeFrame(m: number[], f: Frame): Frame {
  return { o: applyPoint(m, f.o), x: applyDir(m, f.x), y: applyDir(m, f.y), z: applyDir(m, f.z) };
}

/** A point in a plug's frame (x along the contacts, z out of the part), in the frame's space. */
export function inFrame(f: Frame, x: number, y: number, z: number): V3 {
  return [f.o[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z, f.o[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z, f.o[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z];
}

/** Where wire `i` of `n` leaves the back of a plug, in the plug's frame (x, along the contacts). */
export function contactX(spec: PlugSpec, i: number, n: number): number {
  const ways = Math.max(spec.ways ?? n, n);
  const pitch = spec.pitch ?? PITCH[spec.kind];
  const slot = spec.used?.[i] ?? i;
  return (slot - (ways - 1) / 2) * pitch;
}

/** Bundle diameter of n round wires of diameter d. */
export function bundleDiameter(n: number, d: number): number {
  const k = [1, 1, 2, 2.15, 2.41, 2.7, 3, 3, 3][Math.min(n, 8)] ?? Math.sqrt(n) * 1.15;
  return d * k;
}

/** Component instances: name (with [i]) → the main solid's id and placement. */
function instances(model: Model): Map<string, { partId: string; m: number[]; catalogId: string }> {
  const out = new Map<string, { partId: string; m: number[]; catalogId: string }>();
  const counts = new Map<string, number>();
  for (const c of model.machine?.components ?? []) counts.set(c.name, c.count);
  for (const p of model.parts) {
    if (p.kind !== "component" || !p.bom?.catalogId) continue;
    const inst = p.id.match(/#(\d+)$/);
    const idx = inst ? Number(inst[1]) - 1 : 0;
    const key = (counts.get(p.name) ?? 1) > 1 ? `${p.name}[${idx}]` : p.name;
    out.set(key, { partId: p.id, m: xformMatrix(p.xf), catalogId: p.bom.catalogId });
  }
  return out;
}

/**
 * The harness for a design: every wire in the wire list with a plug at each
 * end. Pins that take several wires (a supply's −V) spread them over the
 * pin's identical terminals, then share the last one.
 */
export function buildHarness(model: Model, m: MachineData | undefined = model.machine): Harness {
  if (!m) return { wires: [], sockets: [] };
  const rows = wireList(m, componentPositions(model));
  const inst = instances(model);
  const taken = new Map<string, number>();
  const wires: HarnessWire[] = [];
  const usedSpots = new Set<string>();
  const parts = new Set<string>();
  const catalogOf = (e: WireEnd) => {
    const it = inst.get(e.comp);
    return it && catalogPart(it.catalogId);
  };
  // the wire ends on each terminal, in wire list order
  const onSpot = new Map<string, { wire: number; end: 0 | 1 }[]>();
  const endOf = (e: WireEnd, other: WireEnd): (PlugEnd & { spot: string }) | undefined => {
    const it = inst.get(e.comp);
    const part = it && catalogPart(it.catalogId);
    const spec = part && plugFor(part, e.pin, catalogOf(other));
    if (!it || !part || !spec) return undefined;
    const key = `${e.comp}.${e.pin}`;
    const n = taken.get(key) ?? 0;
    taken.set(key, n + 1);
    const spots = [spec.at, ...(spec.more ?? [])];
    // a pin with several identical terminals (a supply's −V screws) fills them in turn
    const k = n % spots.length;
    usedSpots.add(`${it.partId}|${e.pin}|${k}`);
    parts.add(e.comp);
    const local = localFrame(spots[k], spec.out, spec.row);
    return { partId: it.partId, comp: e.comp, pin: e.pin, label: e.label, part: e.part, spec, local, frame: placeFrame(it.m, local), spot: `${it.partId}|${e.pin}|${k}` };
  };
  for (const r of rows) {
    const a = endOf(r.from, r.to);
    const b = endOf(r.to, r.from);
    if (!a || !b) continue;
    const port = catalogPart(inst.get(r.from.comp)!.catalogId)?.pins.find((p) => p.id === r.from.pin)?.port;
    const list = cableWires(port, r.color, r.gauge);
    const wiresIn = list.map((w) => ({ name: w.color, color: wireHex(w.color), d: w.d }));
    [a, b].forEach((e, k) => onSpot.set(e.spot, [...(onSpot.get(e.spot) ?? []), { wire: wires.length, end: k as 0 | 1 }]));
    const { spot: _a, ...ea } = a;
    const { spot: _b, ...eb } = b;
    wires.push({ id: r.id, row: r, ends: [ea, eb], wires: wiresIn, d: bundleDiameter(wiresIn.length, wiresIn[0].d), port });
  }
  // more wires on a terminal than it takes: the extra ones join the first in a splice behind its plug
  for (const list of onSpot.values()) {
    const first = wires[list[0].wire].ends[list[0].end];
    const room = SPOT_WIRES[first.spec.kind];
    if (list.length <= room) continue;
    // the ones the terminal still takes keep their own plugs; the host is the first, the rest join it
    const joined = [list[0], ...list.slice(room)];
    const host = wires[list[0].wire];
    const f = first.frame;
    const from = add(f.o, f.z, PLUG_BACK[first.spec.kind] + leadLength(host));
    const splice: Splice = { host: host.id, wires: joined.map((j) => wires[j.wire].id), from, to: add(from, f.z, SPLICE_LEN), dir: f.z, across: f.x, partId: first.partId, comp: first.comp, pin: first.pin, label: first.label };
    for (const j of joined) wires[j.wire].ends[j.end].splice = splice;
  }
  // headers and terminals on the parts that are wired, used or not
  const sockets: Socket[] = [];
  for (const comp of parts) {
    const it = inst.get(comp)!;
    const part = catalogPart(it.catalogId)!;
    // a bought board's own 3D model draws its connectors (ui/viewport/boards)
    if (part.geom.g === "board") continue;
    for (const pin of part.pins) {
      const spec = plugFor(part, pin.id);
      if (!spec?.socket) continue;
      [spec.at, ...(spec.more ?? [])].forEach((at, i) => {
        sockets.push({ partId: it.partId, kind: spec.kind, ways: spec.ways ?? 1, pitch: spec.pitch ?? PITCH[spec.kind], local: localFrame(at, spec.out, spec.row), used: usedSpots.has(`${it.partId}|${pin.id}|${i}`) });
      });
    }
  }
  return { wires, sockets };
}

/**
 * The space a plug's body takes in its plug frame (x along the contacts, y
 * across, z out of the part), as the 3D wiring draws it: lo and hi corners.
 * Null for ends with no body of their own (a part's own lead, a joint
 * soldered to a pad or lug).
 */
export function plugBox(spec: PlugSpec, wires: { d: number }[]): [V3, V3] | null {
  const n = wires.length;
  const pitch = spec.pitch ?? PITCH[spec.kind];
  const span = (Math.max(spec.ways ?? n, n) - 1) * pitch;
  const xs = wires.map((_, i) => contactX(spec, i, n));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const dmax = Math.max(...wires.map((w) => w.d));
  switch (spec.kind) {
    case "xh":
      return [[-(span / 2 + 2.45), -2.85, 1.5], [span / 2 + 2.45, 3.55, 9.8]];
    case "ph":
      return [[-(span / 2 + 1.95), -2.25, 1], [span / 2 + 1.95, 2.7, 8.2]];
    case "dupont": {
      const w = Math.max(1, spec.ways ?? n) * 1.27;
      return [[-w, -1.27, 2.5], [w, 1.27, 16.5]];
    }
    case "ferrule":
      return [[x0 - dmax * 0.62, -dmax * 0.62, 0.6], [x1 + dmax * 0.62, dmax * 0.62, 8]];
    case "fork":
    case "ring": {
      const r = Math.max(2, dmax * 0.85);
      return [[x0 - 3.2, -r, 4.5], [x1 + 3.2, r, 13]];
    }
    case "usb_c":
      return [[-6, -3.3, 0], [6, 3.3, 23]];
    case "usb_micro":
      return [[-5.3, -3, 0], [5.3, 3, 18]];
    case "xt60":
      return [[-7.8, -4, 0], [7.8, 4, 16]];
    case "spade":
      return [[x0 - 3.7, -2.3, 0], [x1 + 3.7, 2.3, 15]];
    case "barrel":
      return [[-5, -5, 0], [5, 5, 26]];
    default:
      return null;
  }
}

/** How far each kind of plug slides along its pins before it comes off, mm (0: it is screwed or soldered on). */
export const PULL: Record<PlugKind, number> = {
  xh: 4.5,
  ph: 3.5,
  dupont: 6,
  ferrule: 0,
  fork: 0,
  ring: 0,
  usb_c: 6.5,
  usb_micro: 5,
  xt60: 8,
  lead: 0,
  solder: 0,
  lug: 0,
  barrel: 9.5,
  spade: 7,
};

/** The straight lead out of a plug before the cable is free to bend, mm. */
export const leadLength = (w: HarnessWire) => Math.max(6, w.d * 3);

/** Where a cable's free run starts at one of its ends: past the plug's straight lead, or just past the splice it runs through. */
export function runStart(e: PlugEnd, w: HarnessWire): { p: V3; dir: V3 } {
  if (e.splice) return { p: add(e.splice.to, e.splice.dir, 2), dir: e.splice.dir };
  return { p: add(e.frame.o, e.frame.z, PLUG_BACK[e.spec.kind] + leadLength(w)), dir: e.frame.z };
}

/** Where each cable's free run starts and ends, for the router. */
export function routeRequests(h: Harness, plan?: TravelPlan | null): RouteWire[] {
  const endPoint = runStart;
  // thick cables first: they claim the clear runs, and thin ones then follow them
  const order = [...h.wires].sort((a, b) => b.d * b.wires.length - a.d * a.wires.length);
  if (!plan) return order.map((w) => ({ id: w.id, a: endPoint(w.ends[0], w), b: endPoint(w.ends[1], w), d: w.d }));
  const { avoid } = keepOutBits(plan);
  const links = new Map(plan.links.map((l) => [l.id, l]));
  const carrierOf = new Map<string, string>();
  for (const c of plan.carriers) for (const id of c.parts) carrierOf.set(id, c.id);
  const out: RouteWire[] = [];
  for (const w of order) {
    const pieces = plan.pieces[w.id];
    if (!pieces) {
      // a cable that does not move still keeps out of the way of what does
      const on = carrierOf.get(w.ends[0].partId) ?? null;
      out.push({ id: w.id, a: endPoint(w.ends[0], w), b: endPoint(w.ends[1], w), d: w.d, avoid: avoid(on) });
      continue;
    }
    for (const pc of pieces) {
      const end = (e: (typeof pc)["a"]) => {
        if ("plug" in e) return endPoint(w.ends[e.plug], w);
        const l = links.get(e.link)!;
        const dir = e.end === "F" ? l.outF : l.outG;
        return { p: add(slotPoint(plan, l, e.end, w.id), dir, leadLength(w)), dir };
      };
      out.push({ id: pc.id, a: end(pc.a), b: end(pc.b), d: w.d, avoid: avoid(pc.carrier) });
    }
  }
  return out;
}

/** The keep-out boxes for the router, and which of them a run on each carrier (null: the frame) stays out of. */
export function keepOutBits(plan: TravelPlan): { bits: Map<string, number>; avoid: (carrier: string | null) => number; boxes: RouteKeepOut[] } {
  const bits = new Map<string, number>();
  for (const s of plan.sweeps) if (!bits.has(s.key) && bits.size < 16) bits.set(s.key, 1 << bits.size);
  const boxes = plan.sweeps.filter((s) => bits.has(s.key)).map((s) => ({ lo: s.lo, hi: s.hi, bit: bits.get(s.key)! }));
  const parent = new Map(plan.carriers.map((c) => [c.id, c.parent]));
  const under = (c: string, of: string | null) => {
    // is carrier c carried by `of` (or by the frame, when of is null)?
    for (let p: string | null | undefined = parent.get(c); ; p = parent.get(p!)) {
      if (p === of) return true;
      if (p === null || p === undefined) return of === null;
    }
  };
  const chainOn = new Map(plan.links.filter((l) => l.chain).map((l) => [`chain:${l.id}`, l.parent]));
  const avoid = (carrier: string | null) => {
    let m = 0;
    for (const [key, bit] of bits) {
      const chainParent = chainOn.get(key);
      // a run on the frame keeps out of everything that moves; a run on a carrier, out of what rides on it
      if (chainParent !== undefined) {
        if (carrier === null || chainParent === carrier || (chainParent !== null && under(chainParent, carrier))) m |= bit;
      } else if (carrier === null || under(key, carrier)) m |= bit;
    }
    return m;
  };
  return { bits, avoid, boxes };
}
