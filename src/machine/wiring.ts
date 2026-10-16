// Wiring outputs: the list of physical wires to cut and crimp, and a printable
// wiring diagram. Both come from the design's wire and net statements and the
// catalog pin data, through the same netlist the rules check uses.
//
// Diagram layout: parts sit in columns (power, control, drivers and sensors,
// motors and loads), each a box listing the pins in use. Wires run in the
// vertical channels between columns; a wire that has to cross a column goes
// through the gap between two boxes. Nets that join many pins (power and
// ground) are drawn as rails along the top and bottom with a trunk down into
// each channel, like a ladder diagram.

import type { Model } from "../core/model";
import { xformMatrix, type V3 } from "../kernel/recipe";
import { awgAmpacity } from "./calcs";
import { catalogPart } from "./catalog";
import { buildNetlist, netLabel, type Net, type NetPin, type Netlist } from "./erc";
import type { CatalogKind, CatalogPart, MachineComponent, MachineData, PinRef } from "./types";

export type WireKind = "ground" | "power" | "motor" | "signal" | "cable";

export interface WireEnd {
  /** component name, with [i] for pattern instances */
  comp: string;
  index: number;
  pin: string;
  /** label printed on the part, or the pin id when it has none */
  label: string;
  part: string;
}

export interface WireRow {
  /** W1, W2, ... in build order: ground first, power last */
  id: string;
  from: WireEnd;
  to: WireEnd;
  net: string;
  kind: WireKind;
  /** AWG */
  gauge?: number;
  /** the design gave no gauge: Kerf suggests this one */
  gaugeSuggested: boolean;
  color: string;
  colorSuggested: boolean;
  /** cut length in mm: the distance between the parts plus slack, when positions are known */
  lengthMm?: number;
  /** the net has a name in the design; otherwise `net` is the controller pin or the wire's label */
  named: boolean;
  /** the design's own label for the wire */
  label?: string;
  /** cables between connector ports (stepper, fan, heater...) */
  cable?: string;
  note?: string;
}

/** One drawn connection: a two-pin wire, a cable, or a net joining many pins. */
interface Item {
  id: number;
  name: string;
  kind: WireKind;
  bus: boolean;
  pins: NetPin[];
  /** for buses: the pin the star wiring starts from */
  hub?: NetPin;
  color: string;
  colorSuggested: boolean;
  gauge?: number;
  gaugeSuggested: boolean;
  label?: string;
  cable?: string;
  /** the net has a name in the design (not one Kerf made up from a pin) */
  named: boolean;
}

// ---------------------------------------------------------------- items

const instName = (p: { comp: string; index: number; mc: MachineComponent }) => (p.mc.count > 1 ? `${p.comp}[${p.index}]` : p.comp);
const pinText = (p: NetPin) => p.pin.label ?? p.pin.id;

const COLOR_WORDS = ["red", "black", "white", "yellow", "orange", "green", "blue", "purple", "violet", "brown", "grey", "gray", "pink"];

/** A lead colour named in the pin label, e.g. "Encoder A (yellow)". */
function labelColor(p: NetPin): string | undefined {
  const m = (p.pin.label ?? "").toLowerCase().match(new RegExp(`\\b(${COLOR_WORDS.join("|")})\\b`));
  return m?.[1];
}

const POWER_KINDS: CatalogKind[] = ["battery", "psu", "regulator", "fuse", "switch", "connector"];

function classify(pins: NetPin[], net: Net | undefined): WireKind {
  if (pins.some((p) => p.pin.type === "port")) return "cable";
  const all = net?.pins ?? pins;
  if (pins.some((p) => p.pin.type === "gnd") || all.some((p) => p.pin.type === "gnd")) return "ground";
  if (pins.some((p) => p.pin.type === "motor" || p.pin.type === "motor_out")) return "motor";
  if (all.some((p) => p.pin.type === "pwr_out" || p.pin.type === "pwr_rail" || p.pin.type === "pwr_in")) return "power";
  return "signal";
}

const CABLE_NAMES: Record<string, string> = {
  stepper4: "4-wire stepper cable",
  fan2: "2-wire fan lead",
  heater2: "heater leads",
  therm2: "thermistor lead",
  endstop3: "3-wire endstop cable",
  probe5: "5-wire probe cable",
  usb: "USB cable",
};

const SIGNAL_FALLBACK = ["blue", "purple", "brown", "grey", "white", "yellow"];
/** Cables are drawn in muted, distinct sheath colours so each one can be followed across the diagram. */
const CABLE_HUES = ["#4b5563", "#1f6f8b", "#7b4fa0", "#a35a1f", "#2f7d4f", "#9c3d54", "#3d5aa8", "#7a6a1f"];

function defaultColor(kind: WireKind, pins: NetPin[], n: number): string {
  if (kind === "ground") return "black";
  if (kind === "power") return "red";
  if (kind === "cable") return "grey";
  // the device's own lead colour, if its label names one
  const lead = pins.map(labelColor).find(Boolean);
  if (lead) return lead === "gray" ? "grey" : lead === "violet" ? "purple" : lead;
  if (kind === "motor") return pins.some((p) => /MINUS|NEG|2$|B$/.test(p.pin.id)) ? "grey" : "white";
  const bus = pins.map((p) => p.pin.bus).find(Boolean);
  if (bus === "i2c_sda") return "blue";
  if (bus === "i2c_scl") return "yellow";
  if (bus === "uart_tx" || bus === "uart_rx") return "green";
  if (pins.some((p) => p.pin.type === "analog_out")) return "green";
  if (pins.some((p) => p.pin.needs === "pwm")) return "orange";
  return SIGNAL_FALLBACK[n % SIGNAL_FALLBACK.length];
}

const GAUGES = [26, 24, 22, 20, 18, 16, 14, 12, 10];

function suggestGauge(kind: WireKind, pins: NetPin[], all: NetPin[]): number | undefined {
  if (kind === "cable") return undefined;
  if (kind === "signal") return 24;
  if (kind === "motor") {
    const motor = pins.find((p) => p.pin.type === "motor");
    const stall = motor && typeof motor.part.specs.i_stall === "number" ? motor.part.specs.i_stall : undefined;
    const need = stall !== undefined ? Math.max(1, stall * 0.6) : 5;
    return GAUGES.find((g) => awgAmpacity(g) >= need) ?? 12;
  }
  // power and ground: heavy when the net reaches the main supply or a motor driver's supply
  const heavy = all.some((p) => p.part.kind === "battery" || p.part.kind === "psu" || ((p.part.kind === "motor_driver" || p.part.kind === "stepper_driver") && p.pin.type === "pwr_in" && (p.pin.vmax ?? 0) > 6));
  return heavy ? 18 : 22;
}

/** The pin a star-wired net starts from: its supply, else the power-side terminal, else the first pin. */
function hubOf(pins: NetPin[]): NetPin {
  return (
    pins.find((p) => p.pin.type === "pwr_out") ??
    pins.find((p) => p.pin.type === "pwr_rail") ??
    pins.find((p) => p.pin.type === "passive" && POWER_KINDS.includes(p.part.kind)) ??
    pins.find((p) => p.pin.type === "gnd" && POWER_KINDS.includes(p.part.kind)) ??
    pins[0]
  );
}

function resolver(nl: Netlist) {
  return (r: PinRef): NetPin | undefined => nl.pinsOf.get(r.comp)?.find((p) => p.index === (r.index ?? 0) && p.pin.id === r.pin);
}

function buildItems(m: MachineData, nl: Netlist): Item[] {
  const resolve = resolver(nl);
  const items: Item[] = [];
  const seenPairs = new Set<string>();
  let signals = 0;
  const add = (pins: NetPin[], o: { name?: string; color?: string; gauge?: number; label?: string }) => {
    const net = pins[0].pin.type === "port" ? undefined : nl.netOf.get(pins[0].key);
    const kind = classify(pins, net);
    const bus = pins.length > 2;
    if (!bus) {
      const pair = pins.map((p) => p.key).sort().join("|");
      if (seenPairs.has(pair)) return;
      seenPairs.add(pair);
    }
    const color = o.color ?? defaultColor(kind, pins, kind === "signal" ? signals++ : 0);
    const gauge = o.gauge ?? suggestGauge(kind, pins, net?.pins ?? pins);
    const cable = kind === "cable" ? (CABLE_NAMES[pins.find((p) => p.pin.port)?.pin.port ?? ""] ?? "cable") : undefined;
    const name = o.name ?? net?.name ?? o.label ?? (cable ? `${instName(pins[0])}.${pins[0].pin.id}` : net ? netLabel(net) : `${instName(pins[0])}.${pins[0].pin.id}`);
    items.push({ id: items.length, name, kind, bus, pins, hub: bus ? hubOf(pins) : undefined, color, colorSuggested: o.color === undefined, gauge, gaugeSuggested: o.gauge === undefined && gauge !== undefined, label: o.label, cable, named: !!(o.name ?? net?.name) });
  };
  for (const w of m.wires) {
    const a = resolve(w.a);
    const b = resolve(w.b);
    if (!a || !b || a.key === b.key) continue;
    // the two halves of a connector pair, or a fuse or switch, join inside the part: no wire to make
    if (a.comp === b.comp && a.index === b.index && a.pin.through === b.pin.id) continue;
    add([a, b], { color: w.color, gauge: w.gauge, label: w.label });
  }
  for (const n of m.nets) {
    const seen = new Set<string>();
    const pins = n.pins.map(resolve).filter((p): p is NetPin => !!p && !seen.has(p.key) && !!seen.add(p.key));
    if (pins.length >= 2) add(pins, { name: n.name, color: n.color, gauge: n.gauge });
  }
  return items;
}

// ---------------------------------------------------------------- wire list

/** Where each component sits (its `at` point per instance), from the evaluated parts. */
export function componentPositions(model: Model): Map<string, V3[]> {
  const out = new Map<string, V3[]>();
  for (const p of model.parts) {
    if (p.kind !== "component" || !p.bom) continue;
    const m = xformMatrix(p.xf);
    const inst = p.id.match(/#(\d+)$/);
    const idx = inst ? Number(inst[1]) - 1 : 0;
    const list = out.get(p.name) ?? [];
    list[idx] = [m[12], m[13], m[14]];
    out.set(p.name, list);
  }
  return out;
}

const SLACK_MM = 150;

function estimateLength(a: NetPin, b: NetPin, pos?: Map<string, V3[]>): number | undefined {
  const pa = pos?.get(a.comp)?.[a.index];
  const pb = pos?.get(b.comp)?.[b.index];
  if (!pa || !pb) return undefined;
  // routed along the frame rather than in a straight line, plus slack for the ends and a service loop
  const run = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
  return Math.ceil((run + SLACK_MM) / 50) * 50;
}

const end = (p: NetPin): WireEnd => ({ comp: instName(p), index: p.index, pin: p.pin.id, label: pinText(p), part: p.part.name });

const KIND_ORDER: Record<WireKind, number> = { ground: 0, signal: 1, motor: 2, cable: 3, power: 4 };

/** Every physical wire to make, in build order: ground first, power last. Nets are wired as a star from their supply pin. */
export function wireList(m: MachineData, positions?: Map<string, V3[]>): WireRow[] {
  const nl = buildNetlist(m);
  const items = buildItems(m, nl);
  const rows: (Omit<WireRow, "id"> & { order: number })[] = [];
  // a named net's wires stay together; unnamed wires group by kind
  const groupFirst = new Map<string, number>();
  items.forEach((it, i) => {
    const g = it.named ? `net:${it.name}` : `kind:${it.kind}`;
    if (!groupFirst.has(g)) groupFirst.set(g, i);
  });
  items.forEach((it, order) => {
    const group = groupFirst.get(it.named ? `net:${it.name}` : `kind:${it.kind}`)!;
    const pairs: [NetPin, NetPin][] = it.bus ? it.pins.filter((p) => p !== it.hub).map((p) => [it.hub!, p]) : [[it.pins[0], it.pins[1]]];
    for (const [a, b] of pairs) {
      const notes: string[] = [];
      if (it.cable) notes.push(`Use the ${it.cable} supplied with the part, or one of the same type.`);
      if (it.bus && it.pins.length > 3 && b === it.pins.find((p) => p !== it.hub)) notes.push(`${it.pins.length} pins on this net: a terminal block or lever connector near ${instName(a)} keeps it tidy.`);
      rows.push({
        order: KIND_ORDER[it.kind] * 1e6 + group * 1e3 + order,
        named: it.named,
        from: end(a),
        to: end(b),
        net: it.name,
        kind: it.kind,
        gauge: it.gauge,
        gaugeSuggested: it.gaugeSuggested,
        color: it.color,
        colorSuggested: it.colorSuggested,
        lengthMm: estimateLength(a, b, positions),
        label: it.label,
        cable: it.cable,
        note: notes.join(" ") || undefined,
      });
    }
  });
  rows.sort((x, y) => x.order - y.order);
  return rows.map(({ order: _o, ...r }, i) => ({ id: `W${i + 1}`, ...r }));
}

export function csvCell(v: string | number | undefined): string {
  const t = v === undefined ? "" : String(v);
  // neutralise spreadsheet formula injection (a lone "+" or "-" pin label is not a formula)
  const safe = /^[=@\t\r]/.test(t) || /^[+\-]./.test(t) ? "'" + t : t;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function wiresCsv(rows: WireRow[]): string {
  const head = ["Wire", "From", "From label", "To", "To label", "Net", "Gauge (AWG)", "Colour", "Length (mm)", "Type", "Label", "Notes"];
  const lines = [head.join(",")];
  for (const r of rows) {
    const notes = [r.gaugeSuggested ? "Gauge suggested by Kerf" : "", r.colorSuggested ? "Colour suggested by Kerf" : "", r.note ?? ""].filter(Boolean).join(". ");
    lines.push([r.id, `${r.from.comp}.${r.from.pin}`, r.from.label, `${r.to.comp}.${r.to.pin}`, r.to.label, r.net, r.cable ? "" : r.gauge, r.cable ? "" : r.color, r.lengthMm, r.cable ?? r.kind, r.label, notes].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- diagram

export const WIRE_HEX: Record<string, string> = {
  red: "#d32f2f",
  black: "#212121",
  white: "#ffffff",
  yellow: "#f2c200",
  orange: "#ef7d00",
  green: "#2e8b3e",
  blue: "#1e63c4",
  purple: "#8338b0",
  violet: "#8338b0",
  brown: "#7a4b32",
  grey: "#9a9a9a",
  gray: "#9a9a9a",
  pink: "#e0457b",
};

/** A printable colour for a wire colour name ("red", "dark blue", "#ff8800"). */
export function wireHex(name: string): string {
  const s = name.trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  if (WIRE_HEX[s]) return WIRE_HEX[s];
  const word = COLOR_WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(s));
  return word ? WIRE_HEX[word] : "#555555";
}

const isLight = (hex: string) => {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// layout constants (px)
const PIN_H = 18;
const PAD = 10;
const NAME_H = 18;
const PART_LINE_H = 13;
const MONO_W = 0.6; // monospace advance per em
const SANS_W = 0.58;
const TRACK = 10;
const CH_PAD = 46; // room on each side of a channel for gauge labels on the stubs
const ROW = 12; // corridor and rail row pitch
const MIN_GAP = 26;
const FONT = "'IBM Plex Sans', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'IBM Plex Mono', Menlo, Consolas, monospace";

const textW = (s: string, size: number, mono = true) => s.length * size * (mono ? MONO_W : SANS_W);

const COLUMN_OF: Partial<Record<CatalogKind, number>> = {
  battery: 0,
  psu: 0,
  fuse: 0,
  switch: 0,
  connector: 0,
  regulator: 0,
  controller: 1,
  host: 1,
  motor_driver: 2,
  stepper_driver: 2,
  sensor: 2,
};

interface BoxPin {
  np: NetPin;
  side: "L" | "R";
  text: string;
  sub?: string;
  y: number;
  /** sort key inside the side: rails up top, then point-to-point, then bottom rails */
  group: number;
  bary: number;
}

interface Box {
  key: string;
  name: string;
  role?: string;
  part: CatalogPart;
  col: number;
  pins: BoxPin[];
  partLines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  bary: number;
}

interface Stub {
  y: number;
  side: "L" | "R";
  pin?: BoxPin;
}

/** One item's vertical run in one channel. */
interface Run {
  item: Item;
  ch: number;
  y0: number;
  y1: number;
  stubs: Stub[];
  x: number;
}

function wrap(s: string, max: number, lines: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = (kept[lines - 1] + " " + out.slice(lines).join(" ")).slice(0, max - 1) + "…";
    return kept;
  }
  return out;
}

export interface WiringDiagram {
  svg: string;
  width: number;
  height: number;
  /** wires drawn, counting each pin of a net */
  connections: number;
  parts: number;
}

/** A printable wiring diagram (SVG, white background) of every wired catalog part. */
export function wiringDiagram(m: MachineData, opts: { title?: string } = {}): WiringDiagram {
  const nl = buildNetlist(m);
  const items = buildItems(m, nl);

  // ---- boxes: every catalog part with pins, one per instance in use
  const usedPins = new Map<string, Set<string>>();
  for (const it of items) for (const p of it.pins) usedPins.set(`${p.comp}[${p.index}]`, (usedPins.get(`${p.comp}[${p.index}]`) ?? new Set()).add(p.key));
  const boxes: Box[] = [];
  const boxOf = new Map<string, Box>();
  for (const mc of m.components) {
    const part = catalogPart(mc.catalogId);
    if (!part || !part.pins.length) continue;
    for (let i = 0; i < mc.count; i++) {
      const k = `${mc.name}[${i}]`;
      if (mc.count > 1 && !usedPins.has(k)) continue;
      const box: Box = { key: k, name: mc.count > 1 ? `${mc.name}[${i}]` : mc.name, role: mc.role, part, col: COLUMN_OF[part.kind] ?? 3, pins: [], partLines: wrap(part.name, 34, 2), x: 0, y: 0, w: 0, h: 0, bary: 0 };
      boxes.push(box);
      boxOf.set(k, box);
    }
  }
  // without driver boards, sensors sit with the motors and loads, next to the controller
  if (!boxes.some((b) => b.part.kind === "motor_driver" || b.part.kind === "stepper_driver")) for (const b of boxes) if (b.part.kind === "sensor") b.col = 3;
  // drop empty columns
  const cols = [...new Set(boxes.map((b) => b.col))].sort((a, b) => a - b);
  for (const b of boxes) b.col = cols.indexOf(b.col);
  const nCols = cols.length;
  const colTitle = (c: number) => {
    const kinds = new Set(boxes.filter((b) => b.col === c).map((b) => b.part.kind));
    const orig = cols[c];
    if (orig === 0) return "POWER";
    if (orig === 1) return "CONTROL";
    if (orig === 2) return kinds.has("sensor") ? "DRIVERS AND SENSORS" : "DRIVERS";
    return kinds.has("sensor") ? "SENSORS, MOTORS AND LOADS" : "MOTORS AND LOADS";
  };

  const boxFor = (p: NetPin) => boxOf.get(`${p.comp}[${p.index}]`)!;
  const railOf = (it: Item): "top" | "bottom" | undefined => (it.bus ? (it.kind === "power" ? "top" : "bottom") : undefined);

  const ctrlCol = Math.max(0, cols.indexOf(1));

  // ---- pin sides
  const pinItems = new Map<string, Item[]>();
  for (const it of items) for (const p of it.pins) pinItems.set(p.key, [...(pinItems.get(p.key) ?? []), it]);
  const boxPin = new Map<string, BoxPin>();
  for (const [key, its] of pinItems) {
    const np = its[0].pins.find((p) => p.key === key)!;
    const box = boxFor(np);
    if (!box) continue;
    // point-to-point wires face the parts they go to; rail pins and same-column wires face the controller
    let score = 0;
    for (const it of its) if (!it.bus) for (const q of it.pins) if (q.key !== key && boxFor(q)) score += Math.sign(boxFor(q).col - box.col);
    const towardCtrl = box.col < ctrlCol ? "R" : box.col > ctrlCol ? "L" : ctrlCol > 0 ? "L" : "R";
    const side = score > 0 ? "R" : score < 0 ? "L" : towardCtrl;
    const rail = its.map(railOf).find(Boolean);
    const label = np.pin.label;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const sub = label && !norm(label).includes(norm(np.pin.id)) && np.pin.id.length <= 8 ? np.pin.id : undefined;
    const bp: BoxPin = { np, side, text: label ?? np.pin.id, sub, y: 0, group: rail === "top" ? 0 : rail === "bottom" ? 2 : 1, bary: 0 };
    boxPin.set(key, bp);
    box.pins.push(bp);
  }
  // keep catalog pin order as the starting order
  for (const b of boxes) b.pins.sort((x, y) => b.part.pins.indexOf(x.np.pin) - b.part.pins.indexOf(y.np.pin));

  // ---- sizes
  const headW = (b: Box) => Math.max(textW(b.name, 13, false) + (b.role ? textW(b.role, 11, false) + 10 : 0), ...b.partLines.map((l) => textW(l, 10.5, false)));
  const pinW = (p: BoxPin) => textW(p.text, 11) + (p.sub ? textW(p.sub, 9.5) + 8 : 0);
  for (const b of boxes) {
    const left = b.pins.filter((p) => p.side === "L");
    const right = b.pins.filter((p) => p.side === "R");
    const lw = Math.max(0, ...left.map(pinW));
    const rw = Math.max(0, ...right.map(pinW));
    b.w = Math.max(150, headW(b) + 2 * PAD, lw + rw + 2 * PAD + 24);
    const rows = Math.max(left.length, right.length, 1);
    b.h = NAME_H + b.partLines.length * PART_LINE_H + 10 + rows * PIN_H + 6;
  }
  const colW = Array.from({ length: nCols }, (_, c) => Math.max(150, ...boxes.filter((b) => b.col === c).map((b) => b.w)));
  for (const b of boxes) b.w = colW[b.col];

  const topRails = items.filter((it) => railOf(it) === "top");
  const bottomRails = items.filter((it) => railOf(it) === "bottom");

  // vertical frame
  const TITLE_H = opts.title ? 74 : 44;
  const railTop = TITLE_H + 14;
  const railTopH = topRails.length * ROW + (topRails.length ? 10 : 0);
  const colTitleY = railTop + railTopH + 14;
  const colTop = colTitleY + 12;

  // corridor gap heights per column: gap g sits above box g (g = boxes.length is below the last box)
  const colBoxes = () => Array.from({ length: nCols }, (_, c) => boxes.filter((b) => b.col === c));
  let order = colBoxes();
  const gapH = new Map<string, number>();
  const layoutY = () => {
    for (let c = 0; c < nCols; c++) {
      let y = colTop;
      order[c].forEach((b, i) => {
        y += gapH.get(`${c}:${i}`) ?? (i === 0 ? 8 : MIN_GAP);
        b.y = y;
        const hdr = NAME_H + b.partLines.length * PART_LINE_H + 10;
        const left = b.pins.filter((p) => p.side === "L");
        const right = b.pins.filter((p) => p.side === "R");
        left.forEach((p, r) => (p.y = y + hdr + r * PIN_H + PIN_H / 2));
        right.forEach((p, r) => (p.y = y + hdr + r * PIN_H + PIN_H / 2));
        y += b.h;
      });
    }
  };
  // devices keep the pin order printed on the board; the controller's pins follow what they drive
  const sortPins = () => {
    for (const b of boxes) b.pins.sort((x, y) => x.group - y.group || (b.col === ctrlCol ? x.bary - y.bary : b.part.pins.indexOf(x.np.pin) - b.part.pins.indexOf(y.np.pin)));
  };

  // partner pins of a pin over point-to-point wires (rails do not pull on the order)
  const partners = (bp: BoxPin): BoxPin[] => {
    const out: BoxPin[] = [];
    for (const it of pinItems.get(bp.np.key) ?? []) {
      if (it.bus) continue;
      for (const q of it.pins) if (q.key !== bp.np.key && boxPin.has(q.key)) out.push(boxPin.get(q.key)!);
    }
    return out;
  };
  const mean = (v: number[]) => v.reduce((a, x) => a + x, 0) / v.length;
  // the power column follows the flow of current: source, connector, fuse, switch, regulator
  const FLOW: Partial<Record<CatalogKind, number>> = { battery: 0, psu: 0, connector: 1, fuse: 2, switch: 3, regulator: 4 };
  const designIdx = new Map(m.components.map((c, i) => [c.name, i]));
  order = order.map((list, c) => (cols[c] === 0 ? [...list].sort((a, b) => (FLOW[a.part.kind] ?? 5) - (FLOW[b.part.kind] ?? 5) || (designIdx.get(a.key.split("[")[0]) ?? 0) - (designIdx.get(b.key.split("[")[0]) ?? 0)) : list));
  const orderPins = () => {
    for (const b of boxes) for (const p of b.pins) {
      const ys = partners(p).map((q) => q.y);
      p.bary = ys.length ? mean(ys) : p.y;
    }
    sortPins();
    layoutY();
  };
  layoutY();
  for (let pass = 0; pass < 6; pass++) {
    orderPins();
    // boxes follow the parts they connect to on the controller's side; the power and control columns keep their order
    for (const b of boxes) {
      const all = b.pins.flatMap(partners).filter((q) => boxFor(q.np) !== b);
      const near = all.filter((q) => Math.abs(boxFor(q.np).col - ctrlCol) < Math.abs(b.col - ctrlCol));
      const use = near.length ? near : all;
      b.bary = use.length ? mean(use.map((q) => q.y)) : b.y + b.h / 2;
    }
    order = order.map((list, c) => (cols[c] <= 1 || list.length < 2 ? list : [...list].sort((a, b) => a.bary - b.bary)));
    layoutY();
  }
  orderPins();
  orderPins();

  // ---- channels and corridors
  // channel c sits left of column c; a pin on the left of a box in column c uses channel c, on the right channel c + 1
  const chOf = (bp: BoxPin) => (bp.side === "L" ? boxFor(bp.np).col : boxFor(bp.np).col + 1);
  interface Corr {
    item: Item;
    col: number;
    gap: number;
    target: number;
    y: number;
  }
  const corrs: Corr[] = [];
  const gapRange = (c: number, g: number): [number, number] => {
    const list = order[c];
    if (g === 0) return [colTop, list[0]?.y ?? colTop + 20];
    if (g >= list.length) {
      const last = list[list.length - 1];
      return [last.y + last.h, last.y + last.h + MIN_GAP];
    }
    return [list[g - 1].y + list[g - 1].h, list[g].y];
  };
  const p2p = items.filter((it) => !it.bus);
  const planCorridors = () => {
    corrs.length = 0;
    for (const it of p2p) {
      let [a, b] = it.pins.map((p) => boxPin.get(p.key)!);
      if (!a || !b) continue;
      if (chOf(a) > chOf(b)) [a, b] = [b, a];
      const ca = chOf(a);
      const cb = chOf(b);
      for (let col = ca; col < cb; col++) {
        const t = (col - ca + 1) / (cb - ca + 1);
        const target = a.y + t * (b.y - a.y);
        let best = 0;
        let bestD = Infinity;
        for (let g = 0; g <= order[col].length; g++) {
          const [g0, g1] = gapRange(col, g);
          const d = Math.abs((g0 + g1) / 2 - target);
          if (d < bestD) {
            bestD = d;
            best = g;
          }
        }
        corrs.push({ item: it, col, gap: best, target, y: 0 });
      }
    }
  };
  planCorridors();
  for (const c of corrs) gapH.set(`${c.col}:${c.gap}`, Math.max(gapH.get(`${c.col}:${c.gap}`) ?? (c.gap === 0 ? 8 : MIN_GAP), (corrs.filter((x) => x.col === c.col && x.gap === c.gap).length + 1) * ROW + 6));
  layoutY();
  // rows inside each gap, ordered by where the wire is heading
  const byGap = new Map<string, Corr[]>();
  for (const c of corrs) byGap.set(`${c.col}:${c.gap}`, [...(byGap.get(`${c.col}:${c.gap}`) ?? []), c]);
  for (const [, list] of byGap) {
    const [g0, g1] = gapRange(list[0].col, list[0].gap);
    list.sort((x, y) => x.target - y.target);
    const top = (g0 + g1) / 2 - ((list.length - 1) * ROW) / 2;
    list.forEach((c, i) => (c.y = top + i * ROW));
  }
  const colBottom = Math.max(colTop + 40, ...boxes.map((b) => b.y + b.h)) + 18;
  const railBottomY0 = colBottom + 10;

  // rail rows
  const railY = new Map<number, number>();
  topRails.forEach((it, i) => railY.set(it.id, railTop + 6 + i * ROW));
  bottomRails.forEach((it, i) => railY.set(it.id, railBottomY0 + 6 + i * ROW));
  const height = railBottomY0 + bottomRails.length * ROW + 40;

  // ---- runs per channel
  const runs: Run[] = [];
  const runAt = (item: Item, ch: number) => {
    let r = runs.find((x) => x.item === item && x.ch === ch);
    if (!r) {
      r = { item, ch, y0: Infinity, y1: -Infinity, stubs: [], x: 0 };
      runs.push(r);
    }
    return r;
  };
  const extend = (r: Run, y: number) => {
    r.y0 = Math.min(r.y0, y);
    r.y1 = Math.max(r.y1, y);
  };
  for (const it of items) {
    if (it.bus) {
      const ry = railY.get(it.id)!;
      const chs = new Set<number>();
      for (const p of it.pins) {
        const bp = boxPin.get(p.key);
        if (!bp) continue;
        const ch = chOf(bp);
        chs.add(ch);
        const r = runAt(it, ch);
        r.stubs.push({ y: bp.y, side: bp.side === "R" ? "L" : "R", pin: bp });
        extend(r, bp.y);
      }
      const sorted = [...chs].sort((a, b) => a - b);
      for (const ch of sorted) {
        const r = runAt(it, ch);
        extend(r, ry);
        // the rail comes in from the left margin and continues to the last trunk
        r.stubs.push({ y: ry, side: "L" });
        if (ch !== sorted[sorted.length - 1]) r.stubs.push({ y: ry, side: "R" });
      }
    } else {
      let [a, b] = it.pins.map((p) => boxPin.get(p.key)!);
      if (!a || !b) continue;
      if (chOf(a) > chOf(b)) [a, b] = [b, a];
      const ca = chOf(a);
      const cb = chOf(b);
      const ra = runAt(it, ca);
      ra.stubs.push({ y: a.y, side: a.side === "R" ? "L" : "R", pin: a });
      extend(ra, a.y);
      const mine = corrs.filter((c) => c.item === it).sort((x, y) => x.col - y.col);
      for (const c of mine) {
        const left = runAt(it, c.col);
        left.stubs.push({ y: c.y, side: "R" });
        extend(left, c.y);
        const right = runAt(it, c.col + 1);
        right.stubs.push({ y: c.y, side: "L" });
        extend(right, c.y);
      }
      const rb = runAt(it, cb);
      rb.stubs.push({ y: b.y, side: b.side === "R" ? "L" : "R", pin: b });
      extend(rb, b.y);
    }
  }

  // ---- track order per channel: greedy insertion that minimises crossings
  const cross = (A: Run, B: Run) => {
    // A is left of B
    let n = 0;
    for (const s of A.stubs) if (s.side === "R" && s.y > B.y0 + 0.5 && s.y < B.y1 - 0.5) n++;
    for (const s of B.stubs) if (s.side === "L" && s.y > A.y0 + 0.5 && s.y < A.y1 - 0.5) n++;
    return n;
  };
  const chRuns: Run[][] = Array.from({ length: nCols + 1 }, () => []);
  for (let ch = 0; ch <= nCols; ch++) {
    const list = runs.filter((r) => r.ch === ch).sort((a, b) => a.y1 - a.y0 - (b.y1 - b.y0));
    const placed: Run[] = [];
    const cost = (arr: Run[], x: Run, at: number) => {
      let c = 0;
      for (let i = 0; i < at; i++) c += cross(arr[i], x);
      for (let i = at; i < arr.length; i++) c += cross(x, arr[i]);
      return c;
    };
    for (const r of list) {
      let best = 0;
      let bestC = Infinity;
      for (let at = 0; at <= placed.length; at++) {
        const c = cost(placed, r, at);
        if (c < bestC) {
          bestC = c;
          best = at;
        }
      }
      placed.splice(best, 0, r);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const r of [...placed]) {
        placed.splice(placed.indexOf(r), 1);
        let best = 0;
        let bestC = Infinity;
        for (let at = 0; at <= placed.length; at++) {
          const c = cost(placed, r, at);
          if (c < bestC) {
            bestC = c;
            best = at;
          }
        }
        placed.splice(best, 0, r);
      }
    }
    chRuns[ch] = placed;
  }

  // ---- horizontal frame
  const railLabel = (it: Item) => `${it.name}${it.gauge ? `  ${it.gauge} AWG` : ""}`;
  const marginL = 24;
  const labelArea = Math.max(0, ...[...topRails, ...bottomRails].map((it) => textW(railLabel(it), 10.5) + 22));
  const chW = chRuns.map((list, ch) => (list.length ? list.length * TRACK + 2 * CH_PAD - TRACK : ch === 0 || ch === nCols ? 16 : 40));
  let x = marginL + labelArea;
  const chX: number[] = [];
  const colX: number[] = [];
  for (let c = 0; c <= nCols; c++) {
    chX[c] = x;
    x += chW[c];
    if (c < nCols) {
      colX[c] = x;
      x += colW[c];
    }
  }
  const width = Math.max(x + 24, 640);
  for (const b of boxes) b.x = colX[b.col];
  for (let ch = 0; ch <= nCols; ch++) chRuns[ch].forEach((r, i) => (r.x = chX[ch] + CH_PAD + i * TRACK));
  const edgeX = (ch: number, side: "L" | "R") => (side === "L" ? chX[ch] : chX[ch] + chW[ch]);

  // ---- draw
  const hexOf = new Map(items.map((it) => [it.id, wireHex(it.color)]));
  const strokeW = (it: Item) => (it.kind === "cable" ? 5 : it.bus || it.kind === "power" || it.kind === "ground" ? 2.4 : it.kind === "motor" ? 2.2 : 1.5);
  let cables = 0;
  const cableHue = new Map(items.filter((it) => it.kind === "cable").map((it) => [it.id, it.colorSuggested ? CABLE_HUES[cables++ % CABLE_HUES.length] : wireHex(it.color)]));
  const path = (it: Item, d: string) => {
    const hex = hexOf.get(it.id)!;
    const w = strokeW(it);
    if (it.kind === "cable") return `<path d="${d}" fill="none" stroke="${cableHue.get(it.id)}" stroke-width="${w}" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#f3f4f6" stroke-width="1.4" stroke-linejoin="round"/>`;
    const casing = isLight(hex) ? `<path d="${d}" fill="none" stroke="#555" stroke-width="${w + 1.6}" stroke-linejoin="round"/>` : "";
    return `${casing}<path d="${d}" fill="none" stroke="${hex}" stroke-width="${w}" stroke-linejoin="round"/>`;
  };
  const dots: string[] = [];
  const labels: string[] = [];
  const wiresSvg: string[] = [];

  // rails
  for (const it of [...topRails, ...bottomRails]) {
    const ry = railY.get(it.id)!;
    const mine = runs.filter((r) => r.item === it);
    if (!mine.length) continue;
    const xEnd = Math.max(...mine.map((r) => r.x));
    const x0 = marginL + labelArea - 8;
    wiresSvg.push(`<g>${path(it, `M${x0} ${ry}H${xEnd}`)}</g>`);
    labels.push(`<text x="${x0 - 6}" y="${ry + 3.5}" text-anchor="end" font-family="${MONO}" font-size="10.5" fill="#222"><tspan font-weight="600">${esc(it.name)}</tspan>${it.gauge ? `<tspan fill="#666">  ${it.gauge} AWG</tspan>` : ""}</text>`);
    for (const r of mine) dots.push(`<circle cx="${r.x}" cy="${ry}" r="2.6" fill="${hexOf.get(it.id) === "#ffffff" ? "#555" : hexOf.get(it.id)}"/>`);
  }
  // channel runs: vertical plus stubs
  for (const r of runs) {
    const it = r.item;
    const segs: string[] = [];
    if (r.y1 > r.y0) segs.push(`M${r.x} ${r.y0}V${r.y1}`);
    for (const s of r.stubs) {
      if (!s.pin) continue; // rails and corridors are drawn on their own
      const ex = edgeX(r.ch, s.side);
      segs.push(`M${ex} ${s.y}H${r.x}`);
      if (it.bus || r.stubs.filter((t) => t.pin).length > 1 || (r.y0 < s.y && s.y < r.y1)) {
        if (it.bus) dots.push(`<circle cx="${r.x}" cy="${s.y}" r="2.6" fill="${hexOf.get(it.id) === "#ffffff" ? "#555" : hexOf.get(it.id)}"/>`);
      }
    }
    wiresSvg.push(path(it, segs.join("")));
  }
  // corridors: horizontal runs through a column between boxes
  for (const c of corrs) {
    const a = runs.find((r) => r.item === c.item && r.ch === c.col)!;
    const b = runs.find((r) => r.item === c.item && r.ch === c.col + 1)!;
    wiresSvg.push(path(c.item, `M${a.x} ${c.y}H${b.x}`));
  }
  // gauge labels on one end of each point-to-point wire; plain signal wires say it once in the header
  const sigGauges = p2p.filter((it) => it.kind === "signal" && it.gauge).map((it) => it.gauge!);
  const signalGauge = sigGauges.length ? [...new Set(sigGauges)].sort((a, b) => sigGauges.filter((g) => g === b).length - sigGauges.filter((g) => g === a).length)[0] : undefined;
  const labelCount = new Map<string, number>();
  const tag = (bp: BoxPin, txt: string) => {
    const n = labelCount.get(bp.np.key) ?? 0;
    labelCount.set(bp.np.key, n + 1);
    const ch = chOf(bp);
    const ex = edgeX(ch, bp.side === "R" ? "L" : "R");
    const right = bp.side === "R";
    const y = n === 0 ? bp.y - 5 : bp.y + 11 + (n - 1) * 10;
    labels.push(`<text x="${right ? ex + 5 : ex - 5}" y="${y}" text-anchor="${right ? "start" : "end"}" font-family="${MONO}" font-size="8.5" fill="#444" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(txt)}</text>`);
  };
  for (const it of p2p) {
    const ends = it.pins.map((p) => boxPin.get(p.key)!).filter(Boolean);
    if (ends.length < 2) continue;
    // label the end whose pin carries only this wire, so labels on a shared pin do not pile up
    const shared = (bp: BoxPin) => (pinItems.get(bp.np.key) ?? []).filter((x) => !x.bus).length > 1;
    const [a, b] = shared(ends[0]) && !shared(ends[1]) ? [ends[1], ends[0]] : [ends[0], ends[1]];
    const far = chOf(a) !== chOf(b);
    const spec = it.cable ? it.cable.replace(/ cable$| lead$/, "") : it.kind === "signal" && it.gauge === signalGauge ? "" : it.gauge ? `${it.gauge} AWG` : "";
    const boxB = boxFor(b.np);
    const boxA = boxFor(a.np);
    const txtA = [spec, far ? `→ ${boxB.name}` : ""].filter(Boolean).join(" ");
    if (txtA) tag(a, txtA);
    if (far) tag(b, `← ${boxA.name}.${a.np.pin.id}`);
  }
  // junctions where wires leave a shared pin
  for (const [key, its] of pinItems) {
    const bp = boxPin.get(key);
    if (!bp) continue;
    const mine = runs.filter((r) => its.includes(r.item) && !r.item.bus && r.stubs.some((st) => st.pin === bp));
    if (mine.length < 2) continue;
    const xs = mine.map((r) => r.x).sort((p, q) => (bp.side === "R" ? p - q : q - p));
    for (const x of xs.slice(0, -1)) dots.push(`<circle cx="${x}" cy="${bp.y}" r="2.6" fill="#333"/>`);
  }

  // boxes
  const boxSvg: string[] = [];
  for (const b of boxes) {
    const hdr = NAME_H + b.partLines.length * PART_LINE_H + 10;
    const g: string[] = [];
    g.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="#ffffff" stroke="#3a3f47" stroke-width="1.2"/>`);
    g.push(`<path d="M${b.x} ${b.y + 6}a6 6 0 0 1 6 -6H${b.x + b.w - 6}a6 6 0 0 1 6 6V${b.y + hdr}H${b.x}Z" fill="#eef1f5"/>`);
    g.push(`<line x1="${b.x}" y1="${b.y + hdr}" x2="${b.x + b.w}" y2="${b.y + hdr}" stroke="#c9ced6"/>`);
    g.push(`<text x="${b.x + PAD}" y="${b.y + 17}" font-family="${FONT}" font-size="13" font-weight="700" fill="#111">${esc(b.name)}${b.role ? `<tspan font-weight="400" font-size="11" fill="#555">  ${esc(b.role)}</tspan>` : ""}</text>`);
    b.partLines.forEach((l, i) => g.push(`<text x="${b.x + PAD}" y="${b.y + NAME_H + 12 + i * PART_LINE_H}" font-family="${FONT}" font-size="10.5" fill="#4a4f57">${esc(l)}</text>`));
    if (!b.pins.length) g.push(`<text x="${b.x + PAD}" y="${b.y + hdr + 13}" font-family="${FONT}" font-size="10.5" font-style="italic" fill="#888">not wired yet</text>`);
    for (const p of b.pins) {
      const left = p.side === "L";
      const px = left ? b.x : b.x + b.w;
      const tx = left ? b.x + PAD : b.x + b.w - PAD;
      const sub = p.sub ? `<tspan fill="#8a8f98" font-size="9.5">${left ? "  " : ""}${esc(p.sub)}${left ? "" : "  "}</tspan>` : "";
      const main = `<tspan fill="#1b1f24">${esc(p.text)}</tspan>`;
      g.push(`<text x="${tx}" y="${p.y + 3.8}" text-anchor="${left ? "start" : "end"}" font-family="${MONO}" font-size="11">${left ? main + sub : sub + main}</text>`);
      g.push(`<circle cx="${px}" cy="${p.y}" r="2.8" fill="#ffffff" stroke="#3a3f47" stroke-width="1.2"/>`);
    }
    boxSvg.push(`<g><title>${esc(`${b.name}: ${b.part.name}`)}</title>${g.join("")}</g>`);
  }

  // column titles
  const colTitles = Array.from({ length: nCols }, (_, c) => `<text x="${colX[c] + colW[c] / 2}" y="${colTitleY}" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="600" letter-spacing="1.2" fill="#8a8f98">${colTitle(c)}</text>`);

  // title and legend
  const head: string[] = [];
  const connections = items.reduce((n, it) => n + (it.bus ? it.pins.length - 1 : 1), 0);
  if (opts.title) {
    head.push(`<text x="${marginL}" y="34" font-family="${FONT}" font-size="20" font-weight="700" fill="#111">${esc(opts.title)}</text>`);
    head.push(`<text x="${marginL}" y="54" font-family="${FONT}" font-size="11.5" fill="#555">Wiring diagram · ${boxes.length} parts · ${connections} wires · lines are coloured as the wire should be${signalGauge ? ` · signal wires are ${signalGauge} AWG unless marked` : ""}</text>`);
  }
  const legend: [string, string, number][] = [
    ["Power", WIRE_HEX.red, 2.4],
    ["Ground", WIRE_HEX.black, 2.4],
    ["Signal", WIRE_HEX.blue, 1.5],
    ["Cable", "cable", 5],
  ];
  let lx = width - 24 - legend.length * 78 - 150;
  const ly = opts.title ? 30 : 22;
  for (const [name, hex, w] of legend) {
    if (hex === "cable") head.push(`<path d="M${lx} ${ly}h22" stroke="#4b5563" stroke-width="${w}"/><path d="M${lx} ${ly}h22" stroke="#e5e7eb" stroke-width="1.6"/>`);
    else head.push(`<path d="M${lx} ${ly}h22" stroke="${hex}" stroke-width="${w}"/>`);
    head.push(`<text x="${lx + 28}" y="${ly + 3.5}" font-family="${FONT}" font-size="10.5" fill="#333">${name}</text>`);
    lx += 78;
  }
  head.push(`<circle cx="${lx + 4}" cy="${ly}" r="2.8" fill="#212121"/><text x="${lx + 12}" y="${ly + 3.5}" font-family="${FONT}" font-size="10.5" fill="#333">joined</text>`);
  head.push(`<text x="${width - 24}" y="${ly + 20}" text-anchor="end" font-family="${FONT}" font-size="10" fill="#666">Small numbers give the wire size in AWG. Rails along the top and bottom join every pin on them.</text>`);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" font-family="${FONT}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...head,
    ...colTitles,
    ...wiresSvg,
    ...boxSvg,
    ...dots,
    ...labels,
    `</svg>`,
  ].join("\n");
  return { svg, width: Math.ceil(width), height: Math.ceil(height), connections, parts: boxes.length };
}
