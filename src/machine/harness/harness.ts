// The design's wiring harness in 3D: one entry per row of the wire list (the
// same rows as the build pack's wire list and diagram), each with a plug at
// both ends placed on the right pin of the right part, and the route request
// that the cable router (route.ts) turns into a cable run.

import type { Model } from "../../core/model";
import { xformMatrix, type V3 } from "../../kernel/recipe";
import { catalogPart } from "../catalog";
import type { MachineData } from "../types";
import { componentPositions, wireList, wireHex, type WireEnd, type WireRow } from "../wiring";
import { PITCH, cableWires, plugFor, type PlugKind, type PlugSpec } from "./plugs";
import type { RouteWire } from "./route";

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
  const endOf = (e: WireEnd, other: WireEnd): PlugEnd | undefined => {
    const it = inst.get(e.comp);
    const part = it && catalogPart(it.catalogId);
    const spec = part && plugFor(part, e.pin, catalogOf(other));
    if (!it || !part || !spec) return undefined;
    const key = `${e.comp}.${e.pin}`;
    const n = taken.get(key) ?? 0;
    taken.set(key, n + 1);
    const spots = [spec.at, ...(spec.more ?? [])];
    const at = spots[Math.min(n, spots.length - 1)];
    usedSpots.add(`${it.partId}|${e.pin}|${Math.min(n, spots.length - 1)}`);
    parts.add(e.comp);
    const local = localFrame(at, spec.out, spec.row);
    return { partId: it.partId, comp: e.comp, pin: e.pin, label: e.label, part: e.part, spec, local, frame: placeFrame(it.m, local) };
  };
  for (const r of rows) {
    const a = endOf(r.from, r.to);
    const b = endOf(r.to, r.from);
    if (!a || !b) continue;
    const port = catalogPart(inst.get(r.from.comp)!.catalogId)?.pins.find((p) => p.id === r.from.pin)?.port;
    const list = cableWires(port, r.color, r.gauge);
    const wiresIn = list.map((w) => ({ name: w.color, color: wireHex(w.color), d: w.d }));
    wires.push({ id: r.id, row: r, ends: [a, b], wires: wiresIn, d: bundleDiameter(wiresIn.length, wiresIn[0].d), port });
  }
  // headers and terminals on the parts that are wired, used or not
  const sockets: Socket[] = [];
  for (const comp of parts) {
    const it = inst.get(comp)!;
    const part = catalogPart(it.catalogId)!;
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

/** The straight lead out of a plug before the cable is free to bend, mm. */
export const leadLength = (w: HarnessWire) => Math.max(6, w.d * 3);

/** Where each cable's free run starts and ends, for the router. */
export function routeRequests(h: Harness): RouteWire[] {
  const endPoint = (e: PlugEnd, w: HarnessWire) => ({ p: add(e.frame.o, e.frame.z, PLUG_BACK[e.spec.kind] + leadLength(w)), dir: e.frame.z });
  // thick cables first: they claim the clear runs, and thin ones then follow them
  const order = [...h.wires].sort((a, b) => b.d * b.wires.length - a.d * a.wires.length);
  return order.map((w) => ({ id: w.id, a: endPoint(w.ends[0], w), b: endPoint(w.ends[1], w), d: w.d }));
}
