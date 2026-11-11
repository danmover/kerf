// A bought board laid out in detail for drawing: its parts (features, extras
// and the plug table's headers), the small surface-mount parts a real board
// of its kind is covered in, and the copper, pads, holes and silkscreen on
// both faces. Everything is generated from the catalog entry and a seed from
// its id, so a board always looks the same, and it is plain data: the 3D
// view paints and builds it (src/ui/viewport/boards).

import type { CatalogPart } from "../types";
import { PLUGS, PITCH, type PlugKind } from "../harness/plugs";
import { textBox, textStrokes } from "../pcb/font";
import { boardItems, boardSize, boardStyle, edgeDir, headerPins, pinSpots, PIN_LOOKS, TERMINAL_LOOKS, terminalContacts, type BoardItem, type PinSpot, type V2 } from "./pins";
import type { BoardStyle } from "./look";

export type SmdKind = "r0402" | "c0402" | "r0603" | "c0603" | "c0805" | "sot23" | "led" | "sma";

/** body length (x), width (y) and height of each small part */
export const SMD_SIZE: Record<SmdKind, [number, number, number]> = {
  r0402: [1.0, 0.5, 0.35],
  c0402: [1.0, 0.5, 0.5],
  r0603: [1.6, 0.8, 0.45],
  c0603: [1.6, 0.8, 0.8],
  c0805: [2.0, 1.25, 0.9],
  sot23: [2.9, 1.3, 1.0],
  led: [1.6, 0.8, 0.6],
  sma: [4.3, 2.6, 2.1],
};

export interface Smd {
  kind: SmdKind;
  x: number;
  y: number;
  /** body along x (0) or y (90) */
  rot: 0 | 90;
  /** LED colour, capacitor body tone */
  tone?: string;
}

export interface Trace {
  pts: V2[];
  w: number;
}

export interface Pad {
  x: number;
  y: number;
  w: number;
  h: number;
  round?: boolean;
  /** an outline of its own instead of the rectangle (routed boards' turned and oval pads) */
  shape?: PadShape;
}

/** A capsule from a to b (a circle when they meet) or a convex polygon. */
export type PadShape = { k: "cap"; a: V2; b: V2; r: number } | { k: "poly"; pts: V2[] };

export interface Hole {
  x: number;
  y: number;
  d: number;
  /** a plated ring round it (mounting holes and pins) */
  ring: number;
  /** a slot: the far end of its centre line, from (x, y) */
  to?: V2;
}

export interface SilkText {
  text: string;
  x: number;
  y: number;
  size: number;
  rot: number;
}

export interface Face {
  /** copper fill over the face, cut back round everything else */
  pour: boolean;
  traces: Trace[];
  vias: V2[];
  pads: Pad[];
  /** silkscreen strokes, mm wide `silkW` */
  silk: V2[][];
  /** filled silkscreen squares (data-matrix codes, pin-1 marks) */
  blocks: [number, number, number][];
  texts: SilkText[];
  /** solder joints standing on the face: through-hole pins (x, y, radius) */
  joints: [number, number, number][];
  /** copper pour outlines (rings, filled even-odd, already clear of other copper), instead of `pour` */
  polys?: V2[][];
  /** via pad and drill diameters, when not the bought boards' small vias */
  via?: { pad: number; drill: number };
  /** silkscreen strokes with widths of their own */
  strokes?: { pts: V2[]; w: number }[];
}

export interface BoardSocket {
  kind: PlugKind;
  ways: number;
  pitch: number;
  at: [number, number, number];
  out: [number, number, number];
  row: [number, number, number];
}

export interface BoardLayout {
  w: number;
  d: number;
  t: number;
  corner: number;
  style: BoardStyle;
  items: BoardItem[];
  sockets: BoardSocket[];
  smd: Smd[];
  holes: Hole[];
  top: Face;
  bottom: Face;
  silkW: number;
}

type Rect = [number, number, number, number];

/** A small fast generator, seeded so each board always comes out the same. */
export function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const grow = (r: Rect, g: number): Rect => [r[0] - g, r[1] - g, r[2] + g, r[3] + g];
const itemRect = (it: { x: number; y: number; w: number; d: number }): Rect => [it.x - it.w / 2, it.y - it.d / 2, it.x + it.w / 2, it.y + it.d / 2];

/** The board-plane footprint of a socket from the plug table. */
function socketRect(s: BoardSocket): Rect {
  const span = (s.ways - 1) * s.pitch;
  const [ax, ay] = s.at;
  const alongX = Math.abs(s.row[0]) > 0.5;
  const outZ = Math.abs(s.out[2]) > 0.5;
  const half = span / 2 + (s.kind === "ferrule" ? 2.5 : 2.6);
  if (outZ) {
    const deep = s.kind === "xh" ? 3.2 : 3;
    return alongX ? [ax - half, ay - deep, ax + half, ay + deep] : [ax - deep, ay - half, ax + deep, ay + half];
  }
  // a terminal facing sideways: the block sits behind its wire entries
  const back = s.kind === "ferrule" ? 7.6 : 6;
  const ox = s.out[0];
  const oy = s.out[1];
  if (alongX) return oy < 0 ? [ax - half, ay, ax + half, ay + back] : [ax - half, ay - back, ax + half, ay];
  return ox < 0 ? [ax, ay - half, ax + back, ay + half] : [ax - back, ay - half, ax, ay + half];
}

/**
 * Where a board's pins meet their wires when its plug table places them all (BoardStyle.pinsFromPlugs): each pin's
 * own entry, for the names printed beside the pins. A housing several pins share (a servo channel) has its names
 * printed by the board's own labels instead.
 */
function tableSpots(part: CatalogPart): Map<string, PinSpot> {
  const out = new Map<string, PinSpot>();
  const table = PLUGS[part.id] ?? {};
  for (const pin of part.pins) {
    const s = table[pin.id];
    if (!s || s.used) continue;
    if (s.kind === "dupont") out.set(pin.id, { kind: "dupont", at: s.at, out: s.out, row: s.row });
    else if (s.kind === "ferrule" || s.kind === "bare") out.set(pin.id, { kind: "ferrule", at: s.at, out: s.out, row: s.row });
  }
  return out;
}

function sockets(part: CatalogPart, style: BoardStyle): BoardSocket[] {
  const table = PLUGS[part.id];
  if (!table || style.sockets === false) return [];
  const out: BoardSocket[] = [];
  for (const spec of Object.values(table)) {
    if (!spec.socket) continue;
    for (const at of [spec.at, ...(spec.more ?? [])]) out.push({ kind: spec.kind, ways: spec.ways ?? 1, pitch: spec.pitch ?? PITCH[spec.kind], at, out: spec.out, row: spec.row });
  }
  return out;
}

/** Leads of a chip package at the board: foot positions and pad size. */
export function chipLeads(it: BoardItem): { feet: V2[]; pad: [number, number] } {
  const feet: V2[] = [];
  if (it.look === "qfp") {
    const pitch = 0.5;
    const body = Math.min(it.w, it.d) - 2;
    const n = Math.max(4, Math.min(36, Math.floor((body - 1) / pitch)));
    for (let s = 0; s < 4; s++)
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * pitch;
        const r = Math.min(it.w, it.d) / 2 - 0.45;
        feet.push(s === 0 ? [it.x + a, it.y - r] : s === 1 ? [it.x + r, it.y + a] : s === 2 ? [it.x - a, it.y + r] : [it.x - r, it.y - a]);
      }
    return { feet, pad: [0.28, 1.4] };
  }
  if (it.look === "soic" || it.look === "dip") {
    const pitch = it.look === "dip" ? 2.54 : 1.27;
    const alongX = it.w >= it.d;
    const long = alongX ? it.w : it.d;
    const n = Math.max(2, Math.floor((long - (it.look === "dip" ? 1 : 0.6)) / pitch));
    const r = (alongX ? it.d : it.w) / 2 + (it.look === "dip" ? -0.3 : 0.6);
    for (const side of [-1, 1])
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * pitch;
        feet.push(alongX ? [it.x + a, it.y + side * r] : [it.x + side * r, it.y + a]);
      }
    return { feet, pad: it.look === "dip" ? [1.6, 1.6] : [0.6, 1.6] };
  }
  if (it.look === "qfn" || it.look === "drivers") {
    const n = Math.max(3, Math.floor((Math.min(it.w, it.d) - 1) / 0.5));
    for (let s = 0; s < 4; s++)
      for (let i = 0; i < n; i++) {
        const a = (i - (n - 1) / 2) * 0.5;
        const r = Math.min(it.w, it.d) / 2 + 0.15;
        feet.push(s === 0 ? [it.x + a, it.y - r] : s === 1 ? [it.x + r, it.y + a] : s === 2 ? [it.x - a, it.y + r] : [it.x - r, it.y - a]);
      }
    return { feet, pad: [0.25, 0.8] };
  }
  return { feet, pad: [0, 0] };
}

/** The driver chips drawn for a "drivers" row: one QFN with its heat pad per driver. */
export function driverChips(it: BoardItem): BoardItem[] {
  const alongX = it.w >= it.d;
  const long = alongX ? it.w : it.d;
  const n = Math.max(1, Math.min(5, Math.round(long / 20)));
  return Array.from({ length: n }, (_, i) => {
    const a = (i - (n - 1) / 2) * (long / n);
    return { look: "qfn" as const, x: alongX ? it.x + a : it.x, y: alongX ? it.y : it.y + a, w: 5, d: 5, h: 0.9, mark: "TMC2209\nQ-B" };
  });
}

/** Octilinear path from a to b: straight then 45°, or the other way round. */
function octi(a: V2, b: V2, diagFirst: boolean): V2[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const m = Math.min(Math.abs(dx), Math.abs(dy));
  const dg: V2 = [Math.sign(dx) * m, Math.sign(dy) * m];
  if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) return [a, b];
  const mid: V2 = diagFirst ? [a[0] + dg[0], a[1] + dg[1]] : [b[0] - dg[0], b[1] - dg[1]];
  return [a, mid, b];
}

function emptyFace(): Face {
  return { pour: false, traces: [], vias: [], pads: [], silk: [], blocks: [], texts: [], joints: [] };
}

export function boardLayout(part: CatalogPart): BoardLayout {
  const { w, d, t } = boardSize(part);
  const style = boardStyle(part);
  const rand = rng(part.id);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];
  const items = boardItems(part);
  const socks = sockets(part, style);
  const top = emptyFace();
  const bottom = emptyFace();
  top.pour = rand() < 0.55;
  bottom.pour = true;
  const silkW = 0.15;
  const corner = Math.min(1, w / 10, d / 10);

  // keep-outs: the edge, holes, every part and socket
  const keep: Rect[] = [];
  const holes: Hole[] = (part.geom.holes ?? []).map(([x, y]) => ({ x, y, d: part.geom.hole_d ?? 3.2, ring: (part.geom.hole_d ?? 3.2) + 2.4 }));
  for (const h of holes) keep.push([h.x - h.ring / 2 - 0.4, h.y - h.ring / 2 - 0.4, h.x + h.ring / 2 + 0.4, h.y + h.ring / 2 + 0.4]);
  const drawn: BoardItem[] = items.flatMap((it) => (it.look === "drivers" ? driverChips(it) : [it]));
  for (const it of drawn) keep.push(grow(itemRect(it), 0.5));
  for (const s of socks) keep.push(grow(socketRect(s), 0.4));
  const inside = (r: Rect, m = 1.2) => r[0] > -w / 2 + m && r[2] < w / 2 - m && r[1] > -d / 2 + m && r[3] < d / 2 - m;
  const free = (r: Rect, m = 1.2) => inside(r, m) && !keep.some((k) => overlaps(k, r));

  // pads and joints of through-hole parts
  const tht = (x: number, y: number, pad = 1.7, onTop = false) => {
    top.pads.push({ x, y, w: pad, h: pad, round: true });
    bottom.pads.push({ x, y, w: pad, h: pad, round: true });
    (onTop ? top : bottom).joints.push([x, y, pad * 0.45]);
    holes.push({ x, y, d: 1.0, ring: 0 });
  };
  const pins: V2[] = [];
  for (const it of drawn) {
    if (PIN_LOOKS.has(it.look) || it.look === "header_ra") for (const [x, y] of headerPins(it)) {
      tht(x, y, 1.7, it.look === "header_down");
      pins.push([x, y]);
    }
    if (TERMINAL_LOOKS.has(it.look)) for (const [x, y] of terminalContacts(it)) {
      tht(x, y, it.look === "terminal35" ? 1.9 : 2.4);
      pins.push([x, y]);
    }
    // a STEMMA QT socket's four signal pads behind it, and the two that hold it down
    if (it.look === "qt") {
      const [ox, oy] = edgeDir(part, it.x, it.y);
      const deep = (Math.abs(ox) > 0.5 ? it.w : it.d) / 2;
      for (let i = 0; i < 4; i++) {
        const a = (i - 1.5) * 1.0;
        const px = it.x - ox * (deep + 0.3) + (ox ? 0 : a);
        const py = it.y - oy * (deep + 0.3) + (oy ? 0 : a);
        top.pads.push(ox ? { x: px, y: py, w: 1.1, h: 0.6 } : { x: px, y: py, w: 0.6, h: 1.1 });
        pins.push([px, py]);
      }
    }
    if (it.look === "box_header") {
      const n = Math.max(2, Math.round((it.w - 5) / 2.54));
      for (let i = 0; i < n; i++) for (const r of [-1.27, 1.27]) tht(it.x + (i - (n - 1) / 2) * 2.54, it.y + r, 1.6);
    }
    if (it.look === "elcap" || it.look === "drum") for (const s of [-1, 1]) tht(it.x + s * Math.min(it.w, it.d) * 0.22, it.y, 1.8);
    if (it.look === "transducer" || it.look === "jack35" || it.look === "barrel") for (const s of [-1, 1]) tht(it.x + s * it.w * 0.25, it.y, 1.8);
    const { feet, pad } = chipLeads(it);
    const alongX = it.w >= it.d;
    feet.forEach(([x, y], i) => {
      if (it.look === "dip") return tht(x, y, 1.6);
      // pads run across the package edge they sit on
      const side = it.look === "soic" ? (alongX ? 1 : 0) : Math.floor(i / (feet.length / 4)) % 2 === 0 ? 1 : 0;
      top.pads.push(side ? { x, y, w: pad[0], h: pad[1] } : { x, y, w: pad[1], h: pad[0] });
    });
    if (it.look === "qfp" || it.look === "qfn") pins.push(...feet.filter((_, i) => i % 3 === 0));
  }
  for (const s of socks) {
    const alongX = Math.abs(s.row[0]) > 0.5;
    const outZ = Math.abs(s.out[2]) > 0.5;
    for (let i = 0; i < s.ways; i++) {
      const a = (i - (s.ways - 1) / 2) * s.pitch;
      let [x, y] = s.at;
      if (!outZ) {
        // a sideways terminal's pins are under the block, behind its entries
        x -= s.out[0] * 3.8;
        y -= s.out[1] * 3.8;
      }
      const px = alongX ? x + a : x;
      const py = alongX ? y : y + a;
      tht(px, py, s.kind === "ferrule" || s.kind === "fork" ? 2.4 : 1.6);
      pins.push([px, py]);
    }
  }
  for (const h of holes.filter((h) => h.ring)) for (let k = 0; k < 8; k++) top.vias.push([h.x + Math.cos((k * Math.PI) / 4) * (h.ring / 2 + 0.7), h.y + Math.sin((k * Math.PI) / 4) * (h.ring / 2 + 0.7)]);

  // silkscreen
  const label = (text: string, x: number, y: number, size: number, rot = 0, face = top, force = false, gap = 0.6) => {
    const b = textBox(text, size);
    const hw = (rot % 180 === 0 ? b.w : size) / 2 + 0.2;
    const hh = (rot % 180 === 0 ? size : b.w) / 2 + 0.2;
    const r: Rect = [x - hw, y - hh, x + hw, y + hh];
    if (!force && (face === top ? !free(r, gap) : !inside(r, gap))) return false;
    face.texts.push({ text, x, y, size, rot });
    if (face === top) keep.push(r);
    return true;
  };
  // pin names beside the headers and terminals, from the same spots the wiring uses
  const spots = style.pinsFromPlugs ? tableSpots(part) : pinSpots(part);
  for (const [id, s] of spots) {
    const pin = part.pins.find((p) => p.id === id);
    const text = (pin?.label ?? id).replace(/\s*\(.*\)$/, "").slice(0, 6);
    const [x, y] = s.at;
    if (s.kind === "ferrule") {
      const back: V2 = [-s.out[0], -s.out[1]];
      label(text, x + back[0] * 9.5, y + back[1] * 9.5, 1.0, Math.abs(s.out[0]) > 0.5 ? 90 : 0);
      continue;
    }
    // beside a header pin, toward the board's middle, across the row
    const across = Math.abs(s.row[0]) > 0.5;
    const toMid = across ? -Math.sign(y || 1) : -Math.sign(x || 1);
    const size = 0.85;
    const off = 2.4 + textBox(text, size).w / 2;
    if (across ? label(text, x, y + toMid * off, size, 90) : label(text, x + toMid * off, y, size, 0)) continue;
    // no room for it running away from the row: small, square to it, right by the pin (displays and tight modules)
    const small = Math.min(size, (size * 2.05) / textBox(text, size).w);
    // just clear of the header (its keep-out reaches 0.5 mm past the plastic)
    const near = 1.27 + 0.5 + 0.2 + small / 2 + 0.02;
    if (across) label(text, x, y + toMid * near, small, 0, top, false, 0.25);
    else label(text, x + toMid * near, y, small, 90, top, false, 0.25);
  }
  // labels for the plug table's headers: its pin's name on the side away from where the plug goes
  if (PLUGS[part.id]) {
    for (const [id, spec] of Object.entries(PLUGS[part.id])) {
      if (!spec.socket) continue;
      const pin = part.pins.find((p) => p.id === id);
      const text = (pin?.label ?? id).replace(/\s*\(.*\)$/, "").toUpperCase().slice(0, 8);
      if (text === "PLUG") continue;
      const [x, y] = spec.at;
      const outZ = Math.abs(spec.out[2]) > 0.5;
      const along = Math.abs(spec.row[0]) > 0.5;
      if (outZ) {
        const toMid = along ? -Math.sign(y || 1) : -Math.sign(x || 1);
        if (along) label(text, x, y + toMid * 4.4, 1.0, 0);
        else label(text, x + toMid * 4.4, y, 1.0, 90);
      } else label(text, x - spec.out[0] * 10, y - spec.out[1] * 10, 1.0, along ? 0 : 90);
    }
  }
  // outlines and pin-1 marks round the chips, + on the capacitors
  for (const it of drawn) {
    const r = itemRect(it);
    if (it.look === "qfp" || it.look === "soic" || it.look === "qfn") {
      const g = it.look === "qfn" ? 0.5 : 0.25;
      const [x0, y0, x1, y1] = it.look === "qfp" ? grow(r, 0.4) : grow(r, g);
      const c = 0.8;
      top.silk.push([[x0, y0 + c], [x0, y0], [x0 + c, y0]], [[x1 - c, y0], [x1, y0], [x1, y0 + c]], [[x1, y1 - c], [x1, y1], [x1 - c, y1]], [[x0 + c, y1], [x0, y1], [x0, y1 - c]]);
      top.blocks.push([x0 - 0.6, y1 + 0.2, 0.45]);
    } else if (it.look === "elcap") {
      const rr = Math.min(it.w, it.d) / 2 + 0.4;
      top.silk.push(Array.from({ length: 33 }, (_, k): V2 => [it.x + Math.cos((k / 32) * Math.PI * 2) * rr, it.y + Math.sin((k / 32) * Math.PI * 2) * rr]));
      label("+", it.x + rr + 0.9, it.y + rr * 0.6, 1.2, 0, top, true);
    } else if (TERMINAL_LOOKS.has(it.look) || it.look === "inductor" || it.look === "usb_c" || it.look === "usb_micro" || it.look === "button") {
      const [x0, y0, x1, y1] = grow(r, 0.3);
      top.silk.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]);
    }
  }
  // what the board prints at fixed places: channel numbers, row names
  for (const l of style.labels ?? []) label(l.text, l.x, l.y, l.size ?? 1, l.rot ?? 0, top, true);
  // the board's name, as large as fits
  const title = style.title ?? [part.mpn ?? part.name.split(/[,(]/)[0].trim().toUpperCase()];
  for (const line of title) {
    let placed = false;
    for (let size = Math.min(2.6, d / 8); size >= 0.9 && !placed; size *= 0.85) {
      const bw = textBox(line, size).w;
      for (let k = 0; k < 80 && !placed; k++) {
        const rot = bw > w * 0.8 && d > w ? 90 : 0;
        const span = rot ? d : w;
        if (bw > span - 3) break;
        const x = (rand() - 0.5) * (w - (rot ? size : bw) - 3);
        const y = (rand() - 0.5) * (d - (rot ? bw : size) - 3);
        placed = label(line, x, y, size, rot);
      }
    }
    // the underside gets it too, read from below
    label(line, 0, (bottom.texts.length ? -1 : 1) * d * 0.18, Math.min(2, d / 10), 0, bottom);
  }
  // a data-matrix code where there is room (most modern boards carry one)
  if (w * d > 900) {
    for (let k = 0; k < 60; k++) {
      const s = 3.2;
      const x = (rand() - 0.5) * (w - s - 3);
      const y = (rand() - 0.5) * (d - s - 3);
      if (!free([x - s / 2 - 0.4, y - s / 2 - 0.4, x + s / 2 + 0.4, y + s / 2 + 0.4], 1)) continue;
      const n = 10;
      const c = s / n;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const edge = i === 0 || j === 0 || (i === n - 1 && j % 2 === 0) || (j === n - 1 && i % 2 === 0);
          if (edge || (i > 0 && j > 0 && i < n - 1 && j < n - 1 && rand() < 0.5)) top.blocks.push([x - s / 2 + i * c, y - s / 2 + j * c, c]);
        }
      keep.push([x - s / 2, y - s / 2, x + s / 2, y + s / 2]);
      break;
    }
  }
  // small parts: clustered round the chips, the rest scattered
  const chips = drawn.filter((it) => ["qfp", "qfn", "soic", "power", "can", "mosfets", "wroom", "inductor"].includes(it.look));
  const want = Math.round(Math.max(3, Math.min(150, ((w * d) / 52) * (style.smd ?? 1))));
  const smd: Smd[] = [];
  const kinds: SmdKind[] = ["r0402", "c0402", "r0603", "c0603", "c0603", "r0603", "c0805", "sot23"];
  for (let tries = 0; smd.length < want && tries < want * 40; tries++) {
    const kind = smd.length === 0 ? "led" : rand() < 0.03 ? "led" : rand() < 0.04 && w * d > 1500 ? "sma" : pick(kinds);
    const rot: 0 | 90 = rand() < 0.5 ? 0 : 90;
    const [L, W] = SMD_SIZE[kind];
    const hx = (rot ? W : L) / 2 + 0.35;
    const hy = (rot ? L : W) / 2 + 0.35;
    let x: number;
    let y: number;
    if (chips.length && rand() < 0.7) {
      const c = pick(chips);
      const ang = rand() * Math.PI * 2;
      const r = Math.max(c.w, c.d) / 2 + 1 + rand() * 6;
      x = c.x + Math.cos(ang) * r;
      y = c.y + Math.sin(ang) * r;
      // line up in rows like a pick-and-place layout
      x = Math.round(x / 0.5) * 0.5;
      y = Math.round(y / 0.5) * 0.5;
    } else {
      x = (rand() - 0.5) * (w - 3);
      y = (rand() - 0.5) * (d - 3);
    }
    const r: Rect = [x - hx, y - hy, x + hx, y + hy];
    if (!free(r, 1.0)) continue;
    smd.push({ kind, x, y, rot, tone: kind === "led" ? pick(["#3fd46a", "#ff4b3e", "#3f8cff", "#ffb23f"]) : kind.startsWith("c") ? pick(["#a98e66", "#9c8360", "#7d8691", "#b8a07a"]) : undefined });
    keep.push(r);
    // copper pads at both ends
    const ends = smdEnds({ kind, x, y, rot });
    const [pl, pw] = kind === "sot23" ? [0.6, 0.9] : [Math.max(0.5, L * 0.32), W * 1.1];
    for (const [ex, ey] of ends) top.pads.push(rot ? { x: ex, y: ey, w: pw, h: pl } : { x: ex, y: ey, w: pl, h: pw });
  }

  // traces: each small part to a pin or another part near it, or down a via
  const ends: V2[] = smd.flatMap(smdEnds);
  const targets: V2[] = [...pins, ...ends];
  const viaAt = (p: V2) => top.vias.push(p);
  const crossesHole = (pts: V2[]) => holes.some((h) => h.ring && pts.some(([x, y], i) => i > 0 && segNear(pts[i - 1], [x, y], [h.x, h.y], h.ring / 2 + 0.5)));
  for (const s of smd) {
    const [a, b] = smdEnds(s);
    for (const p of [a, b]) {
      if (rand() < 0.3) {
        const v: V2 = [p[0] + (rand() < 0.5 ? -1 : 1) * (1 + rand() * 1.5), p[1] + (rand() < 0.5 ? -1 : 1) * (1 + rand() * 1.5)];
        if (inside([v[0], v[1], v[0], v[1]], 1)) {
          top.traces.push({ pts: octi(p, v, rand() < 0.5), w: 0.25 });
          viaAt(v);
        }
        continue;
      }
      let best: V2 | null = null;
      let bd = 14;
      for (const q of targets) {
        if (q === p || q === a || q === b) continue;
        const dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (dd > 0.8 && dd < bd && rand() < 0.75) {
          bd = dd;
          best = q;
        }
      }
      if (!best) continue;
      const pts = octi(p, best, rand() < 0.5);
      if (!crossesHole(pts)) top.traces.push({ pts, w: rand() < 0.15 ? 0.5 : 0.25 });
    }
  }
  // chip fan-out: short stubs off the leads, many ending in vias
  for (const c of drawn) {
    const { feet } = chipLeads(c);
    feet.forEach((f, i) => {
      if (rand() < 0.45) return;
      const dx = f[0] - c.x;
      const dy = f[1] - c.y;
      const out: V2 = Math.abs(dx) > Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
      const len = 1 + rand() * 2.5;
      const p1: V2 = [f[0] + out[0] * len, f[1] + out[1] * len];
      const bend = (i % 2 ? 1 : -1) * (0.5 + rand() * 2);
      const p2: V2 = out[0] ? [p1[0] + out[0] * Math.abs(bend), p1[1] + bend] : [p1[0] + bend, p1[1] + out[1] * Math.abs(bend)];
      if (!inside([p2[0], p2[1], p2[0], p2[1]], 1)) return;
      top.traces.push({ pts: [f, p1, p2], w: 0.2 });
      if (rand() < 0.6) viaAt(p2);
    });
  }
  // buses: a few parallel runs from the main chip to the pin rows
  const main = chips.slice().sort((a, b) => b.w * b.d - a.w * a.d)[0];
  if (main && pins.length) {
    const rows = drawn.filter((it) => PIN_LOOKS.has(it.look) || it.look === "terminal");
    for (const r of rows.slice(0, 3)) {
      const n = Math.min(8, 3 + Math.floor(rand() * 6));
      const dir: V2 = [r.x - main.x, r.y - main.y];
      const len = Math.hypot(dir[0], dir[1]) || 1;
      const nx = -dir[1] / len;
      const ny = dir[0] / len;
      for (let k = 0; k < n; k++) {
        const o = (k - (n - 1) / 2) * 0.65;
        const a: V2 = [main.x + (dir[0] / len) * (Math.max(main.w, main.d) / 2 + 2) + nx * o, main.y + (dir[1] / len) * (Math.max(main.w, main.d) / 2 + 2) + ny * o];
        const b: V2 = [r.x - (dir[0] / len) * (Math.max(r.w, r.d) / 2 + 1.5) + nx * o, r.y - (dir[1] / len) * (Math.max(r.w, r.d) / 2 + 1.5) + ny * o];
        const pts = octi(a, b, k % 2 === 0);
        if (!crossesHole(pts)) (rand() < 0.6 ? top : bottom).traces.push({ pts, w: 0.25 });
      }
    }
  }
  // the bottom: through-hole joints already, plus a few long runs and vias
  for (const v of top.vias) if (rand() < 0.5) bottom.vias.push(v);
  for (let k = 0; k < Math.min(24, top.vias.length); k++) {
    const a = pick(top.vias);
    const b = pick(top.vias);
    const pts = octi(a, b, rand() < 0.5);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 3 && !crossesHole(pts)) bottom.traces.push({ pts, w: rand() < 0.2 ? 0.6 : 0.3 });
  }
  // power: wide runs from the terminals
  for (const it of drawn.filter((it) => it.look === "terminal")) {
    const cs = terminalContacts(it);
    for (const c of cs.slice(0, 2)) {
      const to: V2 = main ? [main.x + (rand() - 0.5) * main.w, main.y + (rand() - 0.5) * main.d] : [c[0] * 0.3, c[1] * 0.3];
      const pts = octi(c, to, rand() < 0.5);
      if (!crossesHole(pts)) bottom.traces.push({ pts, w: 1.2 + rand() * 0.8 });
    }
  }

  // reference designators by the small parts that have room
  const refs = { r: 0, c: 0, q: 0, d: 0 };
  for (const s of smd) {
    const [L, W] = SMD_SIZE[s.kind];
    const key = s.kind === "sot23" ? "q" : s.kind === "led" || s.kind === "sma" ? "d" : s.kind[0] === "r" ? "r" : "c";
    refs[key as keyof typeof refs]++;
    if (s.kind === "r0402" || s.kind === "c0402" || rand() < 0.35) continue;
    const text = `${key.toUpperCase()}${refs[key as keyof typeof refs]}`;
    const off = (s.rot ? L : W) / 2 + 0.75;
    if (!label(text, s.x, s.y + off, 0.7)) label(text, s.x, s.y - off, 0.7);
  }
  return { w, d, t, corner, style, items: drawn, sockets: socks, smd, holes, top, bottom, silkW };
}

/** The two ends (or three leads) of a small part, where its pads are. */
export function smdEnds(s: Smd): V2[] {
  const [L] = SMD_SIZE[s.kind];
  const a = L / 2 - Math.min(0.25, L * 0.18);
  if (s.kind === "sot23") {
    const out: V2[] = [
      [-0.95, -1.1],
      [0.95, -1.1],
      [0, 1.1],
    ];
    return out.map(([x, y]) => (s.rot ? [s.x - y, s.y + x] : [s.x + x, s.y + y]));
  }
  return s.rot ? [[s.x, s.y - a], [s.x, s.y + a]] : [[s.x - a, s.y], [s.x + a, s.y]];
}

function segNear(a: V2, b: V2, p: V2, r: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < r;
}

/** Text as stroke polylines, for painting silkscreen (mirrored on the bottom so it reads from below). */
export function textLines(tx: SilkText, mirror: boolean): V2[][] {
  return textStrokes(tx.text, tx.x, tx.y, { size: tx.size, rot: tx.rot, mirror }) as V2[][];
}

/** Which edge an item's opening faces (USB sockets, jacks, card slots). */
export function openingDir(part: CatalogPart, it: BoardItem): V2 {
  return edgeDir(part, it.x, it.y);
}
