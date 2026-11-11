// What is on a bought board and where its pins really are: the catalog
// geometry's features with their looks (look.ts) plus the extras, and, for
// boards without an exact plug table, each pin's place on a real header pin
// or screw terminal contact, so plugs in the 3D wiring land on the pins drawn
// on the board. All in the board's frame: x along its width, y along its
// depth, z up from the underside, the top face at z = t.

import type { CatalogPart, PinDef } from "../types";
import { BOARD_STYLES, DEFAULT_STYLE, type BoardStyle, type Look } from "./look";

/** A part on the board: a catalog feature with its look, or an extra. */
export interface BoardItem {
  look: Look;
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  mark?: string;
}

export type V2 = [number, number];

const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);

export function boardSize(part: CatalogPart): { w: number; d: number; t: number } {
  const d = part.geom.dims;
  return { w: num(d, "w", 50), d: num(d, "d", 30), t: num(d, "t", 1.6) };
}

export function boardStyle(part: CatalogPart): BoardStyle {
  return BOARD_STYLES[part.id] ?? { ...DEFAULT_STYLE, mask: part.geom.color ?? DEFAULT_STYLE.mask };
}

/** A look for a feature from its kind and size, for boards without a style. */
function guessLook(kind: string, w: number, d: number, h: number, female: boolean): Look | null {
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  switch (kind) {
    case "chip":
      if (h >= 3 && long / short > 3) return "dip";
      if (h >= 2.5) return "power";
      if (short >= 6.5 && long - short < 2) return "qfp";
      return h <= 1.15 ? "qfn" : "soic";
    case "header":
      return h <= 3 ? "header_down" : female ? "header_f" : "header_m";
    case "terminal":
      return "terminal";
    case "usb":
      if (w * d >= 150 && h >= 9) return "usb_b";
      if (h >= 6) return "usb_a";
      return long <= 6.5 ? "usb_micro" : "usb_c";
    case "module":
      if (h >= 9) return "drum";
      return w * d >= 300 ? "wroom" : "inductor";
    case "heatsink":
      return "heatsink";
    case "jack":
      return h >= 10 && long >= 12 ? "barrel" : "jack35";
    case "cap":
      return "elcap";
    case "socket":
      return "sdcard";
  }
  return null;
}

/** Everything drawn on the board, in feature order then extras. */
export function boardItems(part: CatalogPart): BoardItem[] {
  const style = boardStyle(part);
  const out: BoardItem[] = [];
  let chip = 0;
  (part.geom.features ?? []).forEach((f, i) => {
    // a part on the underside is a solid of its own (geometry.ts), not part of the drawn top
    if (f.side === "bottom") return;
    const look = style.looks && i < style.looks.length ? style.looks[i] : guessLook(f.kind, f.w, f.d, f.h, !!style.female);
    if (!look) return;
    const mark = f.kind === "chip" || f.kind === "module" ? style.marks?.[chip++] : undefined;
    out.push({ look, x: f.x, y: f.y, w: f.w, d: f.d, h: f.h, mark });
  });
  for (const e of style.extras ?? []) out.push({ ...e });
  return out;
}

export const PIN_LOOKS = new Set<Look>(["header_m", "header_f", "header_down"]);
export const PITCH_HEADER = 2.54;
export const PITCH_TERMINAL = 5.0;

/** Rows of pins in a header: positions on the board, in order along its length (both rows of a double header interleaved). */
export function headerPins(it: BoardItem): V2[] {
  const alongX = it.w >= it.d;
  const long = alongX ? it.w : it.d;
  const short = alongX ? it.d : it.w;
  const n = Math.max(1, Math.round(long / PITCH_HEADER));
  const rows = short >= 4.5 ? 2 : 1;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * PITCH_HEADER;
    for (let r = 0; r < rows; r++) {
      const b = rows === 1 ? 0 : (r - 0.5) * PITCH_HEADER;
      out.push(alongX ? [it.x + a, it.y + b] : [it.x + b, it.y + a]);
    }
  }
  return out;
}

/** Contacts of a screw terminal block, along its length. */
export function terminalContacts(it: BoardItem): V2[] {
  const alongX = it.w >= it.d;
  const long = alongX ? it.w : it.d;
  const n = Math.max(1, Math.round(long / PITCH_TERMINAL));
  return Array.from({ length: n }, (_, i): V2 => {
    const a = (i - (n - 1) / 2) * PITCH_TERMINAL;
    return alongX ? [it.x + a, it.y] : [it.x, it.y + a];
  });
}

/** The unit direction from a spot to the nearest board edge, along x or y. */
export function edgeDir(part: CatalogPart, x: number, y: number): V2 {
  const { w, d } = boardSize(part);
  const gaps: [number, V2][] = [
    [w / 2 - x, [1, 0]],
    [x + w / 2, [-1, 0]],
    [d / 2 - y, [0, 1]],
    [y + d / 2, [0, -1]],
  ];
  gaps.sort((a, b) => a[0] - b[0]);
  return gaps[0][1];
}

/** How a wire meets a pin on a board, in the board's frame (the shape of a plug spec, without the plug kind's details). */
export interface PinSpot {
  kind: "dupont" | "ferrule";
  at: [number, number, number];
  out: [number, number, number];
  row: [number, number, number];
}

const TERMINAL_TYPES = new Set<PinDef["type"]>(["pwr_in", "gnd", "motor_out", "passive", "pwr_out"]);

/**
 * Where each pin of a board meets its wire, for boards without an exact plug
 * table: power and motor pins on screw terminal contacts while there are
 * some, the rest on header pins in order. Pins left over get no spot.
 */
export function pinSpots(part: CatalogPart): Map<string, PinSpot> {
  const { t } = boardSize(part);
  const items = boardItems(part);
  const headers: PinSpot[] = [];
  for (const it of items) {
    if (!PIN_LOOKS.has(it.look)) continue;
    const alongX = it.w >= it.d;
    const row: [number, number, number] = alongX ? [1, 0, 0] : [0, 1, 0];
    for (const [x, y] of headerPins(it)) {
      if (it.look === "header_down") headers.push({ kind: "dupont", at: [x, y, -2.5], out: [0, 0, -1], row });
      else headers.push({ kind: "dupont", at: [x, y, t + (it.look === "header_f" ? it.h : 2.5)], out: [0, 0, 1], row });
    }
  }
  const terminals: PinSpot[] = [];
  for (const it of items) {
    if (it.look !== "terminal") continue;
    const alongX = it.w >= it.d;
    const [ex, ey] = edgeDir(part, it.x, it.y);
    // wires enter on the side facing the nearer edge, across the block's length
    const side: V2 = alongX ? [0, ey || 1] : [ex || 1, 0];
    const half = (alongX ? it.d : it.w) / 2;
    for (const [x, y] of terminalContacts(it))
      terminals.push({ kind: "ferrule", at: [x + side[0] * half, y + side[1] * half, t + it.h * 0.38], out: [side[0], side[1], 0], row: alongX ? [1, 0, 0] : [0, 1, 0] });
  }
  const out = new Map<string, PinSpot>();
  let h = 0;
  let k = 0;
  for (const pin of part.pins) {
    if (pin.port === "usb") continue;
    if (TERMINAL_TYPES.has(pin.type) && k < terminals.length) out.set(pin.id, terminals[k++]);
    else if (h < headers.length) out.set(pin.id, headers[h++]);
    else if (k < terminals.length) out.set(pin.id, terminals[k++]);
  }
  return out;
}
