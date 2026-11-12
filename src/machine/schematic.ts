// The schematic sheet: a symbol for every electronic part with pins, laid out where the design's schematic block puts
// it (or in columns by what it does), with its connections drawn the way a schematic draws them: a wire between two
// pins, ground and supply symbols on the power nets, and net labels where a net joins many pins. The app draws it to
// edit (drag a symbol, click two pins to wire them) and it saves as an SVG.

import { catalogPart } from "./catalog";
import { buildNetlist, type Net, type NetPin, type NetSeg } from "./erc";
import type { CatalogKind, CatalogPart, MachineData, PinType } from "./types";
import type { SchematicLayout } from "../core/model";
import type { Span } from "../lang/ast";
import { plainRoute, routeWires, type RouteObstacles } from "./schematicRoute";

export type P2 = [number, number];

/** sheet grid, mm: pins sit on it */
export const GRID = 5;
const STUB = 5;
const CHAR = 1.55;
/** parts with more pins than this show only the pins in use (and their power pins) */
const MAX_PINS_SHOWN = 40;

export type SymbolShape = "box" | "resistor" | "capacitor" | "diode" | "led" | "fuse" | "switch" | "battery" | "motor" | "speaker" | "pot" | "coil";

export interface SchPin {
  /** what a wire line calls it: comp.PIN or comp[1].PIN */
  ref: string;
  id: string;
  label: string;
  type: PinType;
  /** where a wire meets it, and the way out of the symbol from there */
  at: P2;
  out: P2;
  net?: number;
}

export interface SchSymbol {
  /** comp or comp[i] */
  key: string;
  comp: string;
  index: number;
  title: string;
  sub: string;
  shape: SymbolShape;
  /** centre on the sheet, the quarter turn, and the size of the body before turning */
  at: P2;
  rot: 0 | 90 | 180 | 270;
  w: number;
  h: number;
  /** placed by the schematic block (false: laid out automatically) */
  placed: boolean;
  pins: SchPin[];
  hidden: number;
  /** the body's outline on the sheet after turning: left, top, right, bottom */
  box: [number, number, number, number];
  span: Span;
}

export interface SchWire {
  net: number;
  points: P2[];
  /** the wire statements this connection comes from (none for a net's branch) */
  spans: Span[];
  /** the net statement it belongs to, when it is one */
  netSpan?: Span;
  a: string;
  b: string;
}

export interface SchLabel {
  net: number;
  /** the pin it stands on */
  pin: string;
  text: string;
  at: P2;
  out: P2;
  kind: "ground" | "supply" | "label";
}

export interface SchematicSheet {
  symbols: SchSymbol[];
  wires: SchWire[];
  labels: SchLabel[];
  width: number;
  height: number;
  /** sheet origin: the content's top-left corner less the margin */
  origin: P2;
  nets: { id: number; name: string; pins: string[] }[];
}

const COLUMN: Partial<Record<CatalogKind, number>> = {
  battery: 0,
  psu: 0,
  fuse: 0,
  switch: 0,
  connector: 0,
  terminal: 0,
  regulator: 1,
  sensor: 1,
  potentiometer: 1,
  knob: 1,
  jack: 1,
  controller: 2,
  host: 2,
  display: 2,
  resistor: 3,
  capacitor: 3,
  diode: 3,
  opamp: 3,
  header: 3,
  motor_driver: 3,
  stepper_driver: 3,
  esc: 3,
  amplifier: 3,
};

const SHAPE_OF: Partial<Record<CatalogKind, SymbolShape>> = {
  resistor: "resistor",
  capacitor: "capacitor",
  diode: "diode",
  fuse: "fuse",
  switch: "switch",
  battery: "battery",
  speaker: "speaker",
  coil: "coil",
  potentiometer: "pot",
  gearmotor: "motor",
  led: "led",
};

const RIGHT: Set<PinType> = new Set(["out", "io", "analog_out", "motor_out", "pwr_out", "port"]);

const turn = (p: P2, rot: number): P2 => (rot === 90 ? [-p[1], p[0]] : rot === 180 ? [-p[0], -p[1]] : rot === 270 ? [p[1], -p[0]] : p);
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** A two-terminal symbol: its pins at its two ends, its body in the middle (or a pot's wiper below). */
function twoEnds(shape: SymbolShape, pins: CatalogPart["pins"]): { w: number; h: number; local: { pin: (typeof pins)[number]; at: P2; out: P2 }[] } | null {
  if (shape === "pot" && pins.length === 3) {
    return { w: 20, h: 10, local: [{ pin: pins[0], at: [-15, 0], out: [-1, 0] }, { pin: pins[2], at: [15, 0], out: [1, 0] }, { pin: pins[1], at: [0, 10], out: [0, 1] }] };
  }
  if (pins.length !== 2) return null;
  return { w: 20, h: 10, local: [{ pin: pins[0], at: [-15, 0], out: [-1, 0] }, { pin: pins[1], at: [15, 0], out: [1, 0] }] };
}

/**
 * The sheet for the design's electronics, laid out where the schematic block says and the rest in columns. Wires are
 * routed round the symbols; `route: "plain"` skips that for speed (while a symbol is being dragged).
 */
export function schematicSheet(m: MachineData, layout?: SchematicLayout, opts: { route?: "full" | "plain" } = {}): SchematicSheet {
  const nl = buildNetlist(m);
  const used = new Set<string>();
  for (const n of nl.nets) for (const p of n.pins) used.add(p.key);
  for (const c of nl.cables) (used.add(c.a.key), used.add(c.b.key));
  const symbols: SchSymbol[] = [];
  const auto: SchSymbol[][] = [[], [], [], [], []];
  for (const mc of m.components) {
    const part = catalogPart(mc.catalogId);
    if (!part || !part.pins.length) continue;
    for (let i = 0; i < mc.count; i++) {
      const key = mc.count > 1 ? `${mc.name}[${i}]` : mc.name;
      const pinKey = (id: string) => `${mc.name}[${i}].${id}`;
      // instances of a pattern that nothing is wired to stay off the sheet
      if (mc.count > 1 && !part.pins.some((p) => used.has(pinKey(p.id)))) continue;
      const big = part.pins.length > MAX_PINS_SHOWN;
      const shown = big ? part.pins.filter((p) => used.has(pinKey(p.id)) || p.type === "gnd" || p.type === "pwr_in") : part.pins;
      const shape = SHAPE_OF[part.kind] ?? "box";
      const ends = shape === "box" ? null : twoEnds(shape, shown);
      const ref = (id: string) => `${mc.count > 1 ? `${mc.name}[${i}]` : mc.name}.${id}`;
      const own = layout?.places[key];
      const base = own ? undefined : layout?.places[mc.name];
      const rot = (own ?? base)?.rot ?? 0;
      let w: number;
      let h: number;
      let local: { pin: (typeof shown)[number]; at: P2; out: P2 }[];
      let finalShape: SymbolShape = ends ? shape : "box";
      if (ends) ({ w, h, local } = ends);
      else {
        finalShape = "box";
        let left = shown.filter((p) => !RIGHT.has(p.type));
        let right = shown.filter((p) => RIGHT.has(p.type));
        if (!left.length && right.length > 2) (left = right.slice(0, Math.ceil(right.length / 2)), (right = right.slice(left.length)));
        if (!right.length && left.length > 2) (right = left.slice(Math.ceil(left.length / 2)), (left = left.slice(0, left.length - right.length)));
        const lw = Math.max(0, ...left.map((p) => (p.label ?? p.id).length));
        const rw = Math.max(0, ...right.map((p) => (p.label ?? p.id).length));
        // an even number of grid steps wide, for the same reason
        const wide = snap((lw + rw) * CHAR + 14);
        w = Math.max(30, wide + (wide % (2 * GRID) ? GRID : 0));
        // an even number of grid steps tall, so the pins fall on the grid
        const rows = Math.max(left.length, right.length, 1);
        h = (rows + 1 + ((rows + 1) % 2)) * GRID;
        const top = -h / 2 + GRID;
        local = [...left.map((pin, k) => ({ pin, at: [-w / 2 - STUB, top + k * GRID] as P2, out: [-1, 0] as P2 })), ...right.map((pin, k) => ({ pin, at: [w / 2 + STUB, top + k * GRID] as P2, out: [1, 0] as P2 }))];
      }
      const sym: SchSymbol = {
        key,
        comp: mc.name,
        index: i,
        title: mc.ref ?? key,
        sub: part.name,
        shape: finalShape,
        at: own ? [own.x, own.y] : [0, 0],
        rot,
        w,
        h,
        placed: !!(own ?? base),
        pins: local.map((l) => ({ ref: ref(l.pin.id), id: l.pin.id, label: l.pin.label ?? l.pin.id, type: l.pin.type, at: l.at, out: l.out })),
        hidden: part.pins.length - shown.length,
        box: [0, 0, 0, 0],
        span: mc.span,
      };
      // a patterned part placed by its name: its copies in a column down from there
      if (base) {
        const [ex, ey] = rot === 90 || rot === 270 ? [h, w] : [w, h];
        sym.at = rot === 90 || rot === 270 ? [base.x + i * snap(ex + 2 * STUB + 15), base.y] : [base.x, base.y + i * snap(ey + 2 * STUB + 15)];
      }
      symbols.push(sym);
      if (!sym.placed) auto[COLUMN[part.kind] ?? 4].push(sym);
    }
  }
  // the rest in columns by what they do: power, inputs, the controller, drivers and passives, what is driven. A
  // column much taller than the rest of the sheet wraps into another beside it, so the sheet stays landscape.
  const placedBoxes = symbols.filter((s) => s.placed).map((s) => outline(s));
  const right0 = placedBoxes.length ? Math.max(...placedBoxes.map((b) => b[2])) + 30 : 0;
  const tall = (s: SchSymbol) => s.h + 2 * STUB + 16 + 10;
  const wide = (s: SchSymbol) => s.w + 2 * STUB + 24 + 40;
  const flat = auto.flat();
  const area = flat.reduce((a, s) => a + tall(s) * wide(s), 0);
  const limit = Math.max(160, ...flat.map(tall), Math.sqrt(area / 1.6));
  let x = right0;
  for (const col of auto) {
    const chunks: SchSymbol[][] = [];
    let h = Infinity;
    for (const s of col) {
      if (h + tall(s) > limit) (chunks.push([]), (h = 0));
      chunks[chunks.length - 1].push(s);
      h += tall(s);
    }
    for (const chunk of chunks) {
      const cw = Math.max(...chunk.map((s) => s.w + 2 * STUB + 24));
      let y = 0;
      for (const s of chunk) {
        const hh = s.h + 2 * STUB + 16;
        s.at = [snap(x + cw / 2), snap(y + hh / 2)];
        y += hh + 10;
      }
      x += cw + 40;
    }
  }
  // to sheet coordinates
  for (const s of symbols) {
    s.box = outline(s);
    for (const p of s.pins) {
      p.at = add(s.at, turn(p.at, s.rot));
      p.out = turn(p.out, s.rot);
    }
  }
  const pinAt = new Map<string, SchPin>();
  for (const s of symbols) for (const p of s.pins) pinAt.set(`${s.comp}[${s.index}].${p.id}`, p);

  // what the wires and net statements join, pin to pin. A fuse or switch conducts between its ends for the
  // electrical checks, but on a schematic it sits between two nets, so those are kept apart here.
  const groups = connections(nl.nets);
  const wires: SchWire[] = [];
  const ends: { a: SchPin; b: SchPin }[] = [];
  const labels: SchLabel[] = [];
  const nets: SchematicSheet["nets"] = [];
  for (const g of groups) {
    const pins = g.pins.map((p) => ({ np: p, sp: pinAt.get(p.key) })).filter((x): x is { np: NetPin; sp: SchPin } => !!x.sp);
    for (const { sp } of pins) sp.net = g.id;
    nets.push({ id: g.id, name: g.name, pins: pins.map((p) => p.sp.ref) });
    if (!pins.length) continue;
    if (g.kind === "ground" || (g.kind === "supply" && pins.length > 2)) {
      for (const { sp } of pins) labels.push({ net: g.id, pin: sp.ref, text: g.kind === "ground" ? "GND" : g.supply, at: sp.at, out: sp.out, kind: g.kind });
      continue;
    }
    if (pins.length === 2) {
      const [a, b] = pins;
      const spans = g.segs.filter((sg) => sg.bus === undefined).map((sg) => sg.span);
      const netSpan = g.segs.find((sg) => sg.bus !== undefined)?.span;
      wires.push({ net: g.id, points: [], spans, ...(netSpan ? { netSpan } : {}), a: a.sp.ref, b: b.sp.ref });
      ends.push({ a: a.sp, b: b.sp });
      continue;
    }
    for (const { sp } of pins) labels.push({ net: g.id, pin: sp.ref, text: g.name, at: sp.at, out: sp.out, kind: "label" });
  }
  // port-to-port cables (stepper, fan, heater plugs) as wires of their own
  for (const c of nl.cables) {
    const a = pinAt.get(c.a.key);
    const b = pinAt.get(c.b.key);
    if (a && b) (wires.push({ net: -1, points: [], spans: [c.span], a: a.ref, b: b.ref }), ends.push({ a, b }));
  }
  // the wires, round the symbols and their labels
  if (opts.route === "plain") wires.forEach((w, i) => (w.points = plainRoute(ends[i].a, ends[i].b, i, GRID)));
  else {
    const obs: RouteObstacles = { boxes: [], soft: [], pins: symbols.flatMap((s) => s.pins) };
    for (const s of symbols) (obs.boxes.push(s.box), obs.soft.push(...textSpots(s).room));
    for (const l of labels) obs.boxes.push(labelBox(l));
    const paths = routeWires(ends, obs, GRID);
    wires.forEach((w, i) => (w.points = paths[i]));
  }
  // the sheet: everything inside a margin, its top-left corner the origin
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of symbols) {
    xs.push(s.box[0] - 12, s.box[2] + 12);
    ys.push(s.box[1] - 12, s.box[3] + 10);
    for (const r of textSpots(s).room) (xs.push(r[0] - 4, r[2] + 4), ys.push(r[1] - 4, r[3] + 4));
  }
  for (const w of wires) for (const p of w.points) (xs.push(p[0]), ys.push(p[1]));
  for (const l of labels) (xs.push(l.at[0] + l.out[0] * (8 + l.text.length * CHAR * 1.1)), ys.push(l.at[1] + l.out[1] * 12));
  const lo: P2 = [Math.min(0, ...xs) - 15, Math.min(0, ...ys) - 15];
  const hi: P2 = [Math.max(100, ...xs) + 15, Math.max(60, ...ys) + 30];
  return { symbols, wires, labels, width: hi[0] - lo[0], height: hi[1] - lo[1], origin: lo, nets };
}

/** The body's outline on the sheet with its pin stubs, after turning. */
function outline(s: Pick<SchSymbol, "at" | "rot" | "w" | "h">): [number, number, number, number] {
  const hw = s.w / 2 + STUB;
  const hh = s.h / 2 + (s.w === 20 && s.h === 10 ? STUB : 0);
  const [ex, ey] = s.rot === 90 || s.rot === 270 ? [hh, hw] : [hw, hh];
  return [s.at[0] - ex, s.at[1] - ey, s.at[0] + ex, s.at[1] + ey];
}

interface Group {
  id: number;
  name: string;
  pins: NetPin[];
  segs: NetSeg[];
  kind: "ground" | "supply" | null;
  /** what a supply flag reads: the net's name, or the volts its source gives */
  supply: string;
}

const GROUND_NAME = /^(gnd|0v|vss|agnd|dgnd|pgnd|ground)$/i;

/** The pins the wire and net statements join, in groups, each with a name and whether it is ground or a supply. */
function connections(nets: Net[]): Group[] {
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    if (r !== a) parent.set(a, r);
    return r;
  };
  const segs = nets.flatMap((n) => n.segs);
  for (const sg of segs) {
    const ra = find(sg.a.key);
    const rb = find(sg.b.key);
    parent.set(ra, ra);
    if (ra !== rb) parent.set(rb, ra);
  }
  const byRoot = new Map<string, { pins: NetPin[]; segs: NetSeg[]; net: Net }>();
  for (const n of nets)
    for (const p of n.pins) {
      if (!parent.has(p.key)) continue;
      const r = find(p.key);
      const g = byRoot.get(r) ?? { pins: [], segs: [], net: n };
      g.pins.push(p);
      byRoot.set(r, g);
    }
  for (const sg of segs) byRoot.get(find(sg.a.key))?.segs.push(sg);
  let id = 0;
  return [...byRoot.values()].map((g) => {
    const named = g.segs.find((sg) => sg.bus !== undefined)?.label ?? (g.pins.length === g.net.pins.length ? g.net.name : undefined);
    const src = g.pins.find((p) => p.pin.type === "pwr_out") ?? g.pins.find((p) => p.pin.type === "pwr_rail");
    const kind = g.pins.some((p) => p.pin.type === "gnd") || (named && GROUND_NAME.test(named)) ? "ground" : src ? "supply" : null;
    const name = named ?? pinName(g.pins.find((p) => p.pin.type === "pwr_out") ?? g.pins.find((p) => p.pin.type === "gnd") ?? g.pins.find((p) => p.pin.type === "io") ?? g.pins[0]);
    const v = src?.pin.v;
    return { id: id++, name, pins: g.pins, segs: g.segs, kind, supply: named ?? (v ? `${Math.round(v * 10) / 10}V` : name) };
  });
}

const pinName = (p: NetPin) => `${p.comp}${p.mc.count > 1 ? `[${p.index}]` : ""}.${p.pin.id}`;

/** The room a ground, supply or net label takes beside its pin. */
function labelBox(l: SchLabel): [number, number, number, number] {
  const len = l.kind === "ground" ? 6 : l.kind === "supply" ? 4 + (l.out[1] === 0 ? l.text.length * CHAR + 2 : 4) : 3 + l.text.length * CHAR + 3;
  const half = l.kind === "label" && l.out[1] !== 0 ? (l.text.length * CHAR) / 2 + 1 : 3.2;
  const e: P2 = [l.at[0] + l.out[0] * len, l.at[1] + l.out[1] * len];
  // from just off the pin's tip, so the tip itself stays the pin's
  const s: P2 = [l.at[0] + l.out[0] * 0.5, l.at[1] + l.out[1] * 0.5];
  const [px, py] = [Math.abs(l.out[1]) * half, Math.abs(l.out[0]) * half];
  return [Math.min(s[0], e[0]) - px, Math.min(s[1], e[1]) - py, Math.max(s[0], e[0]) + px, Math.max(s[1], e[1]) + py];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The body of a symbol in its own axes (centre at 0, 0), as SVG. */
export function symbolBody(s: Pick<SchSymbol, "shape" | "w" | "h">, stroke: string): string {
  const k = `fill="none" stroke="${stroke}" stroke-width="0.35" stroke-linejoin="round"`;
  // a two-terminal symbol's leads, out to its pins
  const leads = s.shape === "box" ? "" : `<path d="M -15 0 H -10 M 10 0 H 15" fill="none" stroke="${stroke}" stroke-width="0.3"/>`;
  return leads + bodyOnly(s, k, stroke);
}

function bodyOnly(s: Pick<SchSymbol, "shape" | "w" | "h">, k: string, stroke: string): string {
  switch (s.shape) {
    case "resistor":
      return `<path d="M -10 0 h 2 l 1.33 -2.5 l 2.67 5 l 2.67 -5 l 2.67 5 l 2.67 -5 l 2.67 5 l 1.33 -2.5 h 2" ${k}/>`;
    case "pot":
      return `<path d="M -10 0 h 2 l 1.33 -2.5 l 2.67 5 l 2.67 -5 l 2.67 5 l 2.67 -5 l 2.67 5 l 1.33 -2.5 h 2" ${k}/><path d="M 0 10 V 3.2 M -1.6 5.4 L 0 3 L 1.6 5.4" ${k}/>`;
    case "capacitor":
      return `<path d="M -10 0 H -1.2 M 1.2 0 H 10 M -1.2 -4 V 4 M 1.2 -4 V 4" ${k}/>`;
    case "diode":
    case "led":
      return `<path d="M -10 0 H -3 M 3 0 H 10 M -3 -3.5 V 3.5 L 3 0 Z M 3 -3.5 V 3.5" ${k}/>${s.shape === "led" ? `<path d="M 1 -4.5 l 2.5 -2.5 M 3 -4 l 2.5 -2.5" ${k}/>` : ""}`;
    case "fuse":
      return `<path d="M -10 0 H -5 M 5 0 H 10" ${k}/><rect x="-5" y="-2" width="10" height="4" ${k}/><path d="M -5 0 H 5" ${k}/>`;
    case "switch":
      return `<path d="M -10 0 H -4 L 4 -4 M 4 0 H 10" ${k}/><circle cx="-4" cy="0" r="0.7" ${k}/><circle cx="4" cy="0" r="0.7" ${k}/>`;
    case "battery":
      return `<path d="M -10 0 H -1.5 M 1.5 0 H 10 M -1.5 -5 V 5 M 1.5 -2.5 V 2.5" ${k}/><text x="-5" y="-3" font-size="3" fill="${stroke}">+</text>`;
    case "motor":
      return `<path d="M -10 0 H -5 M 5 0 H 10" ${k}/><circle cx="0" cy="0" r="5" ${k}/><text x="0" y="1.6" font-size="4.5" text-anchor="middle" fill="${stroke}">M</text>`;
    case "speaker":
      return `<path d="M -10 0 H -4 M 4 0 H 10" ${k}/><path d="M -4 -2 H -1 V 2 H -4 Z M -1 -2 L 3 -5 V 5 L -1 2" ${k}/>`;
    case "coil":
      return `<path d="M -10 0 H -6 a 1.5 1.5 0 0 1 3 0 a 1.5 1.5 0 0 1 3 0 a 1.5 1.5 0 0 1 3 0 a 1.5 1.5 0 0 1 3 0 H 10" ${k}/>`;
    default:
      return `<rect x="${-s.w / 2}" y="${-s.h / 2}" width="${s.w}" height="${s.h}" rx="0.8" ${k}/>`;
  }
}

/** The printable sheet: white paper, black lines, a frame and a title block. */
export function schematicSvg(sheet: SchematicSheet, title: string): string {
  const ink = "#1b1f24";
  const [ox, oy] = sheet.origin;
  const W = sheet.width;
  const H = sheet.height;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${(W * 4).toFixed(0)}" height="${(H * 4).toFixed(0)}" viewBox="${ox} ${oy} ${W} ${H}" font-family="IBM Plex Sans, Helvetica, Arial, sans-serif">`);
  out.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<rect x="${ox + 4}" y="${oy + 4}" width="${W - 8}" height="${H - 8}" fill="none" stroke="${ink}" stroke-width="0.5"/>`);
  out.push(`<g transform="translate(${ox + W - 74} ${oy + H - 18})"><rect width="70" height="14" fill="none" stroke="${ink}" stroke-width="0.35"/><text x="3" y="6" font-size="3.6" font-weight="600" fill="${ink}">${esc(title)}</text><text x="3" y="11" font-size="2.6" fill="${ink}">Schematic · drawn by Kerf</text></g>`);
  for (const w of sheet.wires) out.push(`<polyline points="${w.points.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${ink}" stroke-width="0.3"/>`);
  for (const s of sheet.symbols) out.push(symbolSvg(s, ink));
  for (const l of sheet.labels) out.push(labelSvg(l, ink));
  out.push("</svg>");
  return out.join("\n");
}

export function symbolSvg(s: SchSymbol, ink: string): string {
  const parts: string[] = [`<g transform="translate(${s.at[0]} ${s.at[1]}) rotate(${s.rot})">`, symbolBody(s, ink)];
  if (s.shape === "box")
    for (const p of s.pins) {
      // pins are drawn back in the symbol's own axes
      const loc = turn([p.at[0] - s.at[0], p.at[1] - s.at[1]], (360 - s.rot) % 360);
      const outL = turn(p.out, (360 - s.rot) % 360);
      const inner: P2 = [loc[0] - outL[0] * STUB, loc[1]];
      parts.push(`<path d="M ${loc[0]} ${loc[1]} H ${inner[0]}" stroke="${ink}" stroke-width="0.3"/>`);
      const anchor = outL[0] < 0 ? "start" : "end";
      parts.push(`<text x="${inner[0] - outL[0] * 1.2}" y="${loc[1] + 1}" font-size="2.6" text-anchor="${anchor}" fill="${ink}">${esc(p.label)}</text>`);
    }
  parts.push("</g>");
  const at = textSpots(s);
  parts.push(`<text x="${at.title[0]}" y="${at.title[1]}" font-size="3.2" font-weight="600" text-anchor="${at.anchor}" fill="${ink}">${esc(s.title)}</text>`);
  parts.push(`<text x="${at.sub[0]}" y="${at.sub[1]}" font-size="2.4" text-anchor="${at.anchor}" fill="${ink}" opacity="0.75">${esc(short(s.sub, 34))}${s.hidden ? ` (+${s.hidden} pins)` : ""}</text>`);
  return parts.join("");
}

/**
 * Where a symbol's name and part go: above and below it, or, when its pins point up and down (a box turned a quarter
 * turn), beside it on the left, clear of the wires and labels on its pins. Also the room they take, for routing.
 */
export function textSpots(s: Pick<SchSymbol, "box" | "rot" | "shape" | "title" | "sub">): { title: P2; sub: P2; anchor: "middle" | "end"; room: [number, number, number, number][] } {
  const [l, t, r, b] = s.box;
  const tw = s.title.length * 2.2;
  const sw = Math.min(35, s.sub.length) * 1.6;
  if (s.shape === "box" && (s.rot === 90 || s.rot === 270)) {
    const cy = (t + b) / 2;
    return { title: [l - 2, cy - 0.5], sub: [l - 2, cy + 3.2], anchor: "end", room: [[l - 3 - Math.max(tw, sw), cy - 4, l - 0.1, cy + 4.5]] };
  }
  const cx = (l + r) / 2;
  const hw = Math.max(r - l, tw) / 2;
  const hs = Math.max(r - l, sw) / 2;
  return { title: [cx, t - 1.5], sub: [cx, b + 3.8], anchor: "middle", room: [[cx - hw, t - 5, cx + hw, t - 0.1], [cx - hs, b + 0.1, cx + hs, b + 5]] };
}

export function labelSvg(l: SchLabel, ink: string): string {
  const [x, y] = l.at;
  const [dx, dy] = l.out;
  if (l.kind === "ground") {
    const e: P2 = [x + dx * 3, y + dy * 3];
    // the bars stand across the way out
    const [px, py] = [-dy, dx];
    const bar = (d: number, half: number) => `M ${e[0] + dx * d - px * half} ${e[1] + dy * d - py * half} L ${e[0] + dx * d + px * half} ${e[1] + dy * d + py * half}`;
    return `<path d="M ${x} ${y} L ${e[0]} ${e[1]} ${bar(0, 3)} ${bar(1.2, 2)} ${bar(2.4, 1)}" fill="none" stroke="${ink}" stroke-width="0.35"/>`;
  }
  if (l.kind === "supply") {
    const e: P2 = [x + dx * 3, y + dy * 3];
    const [px, py] = [-dy, dx];
    const tx = e[0] + dx * 1.5 + (dx === 0 ? 0 : dx * 0.5);
    const anchor = dx < 0 ? "end" : dx > 0 ? "start" : "middle";
    return `<path d="M ${x} ${y} L ${e[0]} ${e[1]} M ${e[0] - px * 2.5} ${e[1] - py * 2.5} L ${e[0] + px * 2.5} ${e[1] + py * 2.5}" fill="none" stroke="${ink}" stroke-width="0.35"/><text x="${tx}" y="${e[1] + dy * 3 + 1 + (dy === 0 ? -2.5 : 0)}" font-size="2.6" font-weight="600" text-anchor="${anchor}" fill="${ink}">${esc(l.text)}</text>`;
  }
  const len = l.text.length * CHAR + 3;
  const e: P2 = [x + dx * 2, y + dy * 2];
  const anchor = dx < 0 ? "end" : "start";
  const w = dx < 0 ? -len : len;
  const flag = dy === 0 ? `M ${x} ${y} L ${e[0]} ${e[1]} L ${e[0] + w * 0.12} ${e[1] - 2} L ${e[0] + w} ${e[1] - 2} L ${e[0] + w} ${e[1] + 2} L ${e[0] + w * 0.12} ${e[1] + 2} Z` : `M ${x} ${y} L ${e[0]} ${e[1]}`;
  return `<path d="${flag}" fill="none" stroke="${ink}" stroke-width="0.3"/><text x="${e[0] + (dy === 0 ? (dx < 0 ? -2 : 2) : 0)}" y="${e[1] + (dy === 0 ? 0.9 : dy * 3 + 1)}" font-size="2.4" text-anchor="${dy === 0 ? anchor : "middle"}" fill="${ink}">${esc(l.text)}</text>`;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The schematic block with these places, as source text. */
export function schematicBlock(places: Record<string, { x: number; y: number; rot: number }>): string {
  const rows = Object.entries(places).map(([name, p]) => `  ${name}: (${fmt(p.x)}, ${fmt(p.y)}${p.rot ? `, ${p.rot}` : ""})`);
  return `schematic {\n${rows.join("\n")}\n}`;
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);
