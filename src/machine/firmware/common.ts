// Shared helpers for firmware generators: which controller pin drives what,
// found from the design's netlist, so generated code always matches the wiring.

import { catalogPart } from "../catalog";
import { buildNetlist, type NetPin, type Netlist } from "../erc";
import type { CatalogPart, FirmwareDef, MachineComponent, MachineData } from "../types";

export interface GenFile {
  path: string;
  content: string;
}

export interface FwContext {
  m: MachineData;
  fw: FirmwareDef;
  nl: Netlist;
  board: MachineComponent;
  boardPart: CatalogPart;
  designName: string;
}

export function fwContext(m: MachineData, fw: FirmwareDef, designName: string): FwContext | string {
  if (!fw.board) return `firmware ${fw.name}: give it board: <controller>`;
  const board = m.components.find((c) => c.name === fw.board);
  const boardPart = board && catalogPart(board.catalogId);
  if (!board || !boardPart) return `firmware ${fw.name}: board "${fw.board}" is not a catalog part`;
  // the name is free text from the design (written by anyone, or by Claude): never let it start a new line
  return { m, fw, nl: buildNetlist(m), board, boardPart, designName: oneLine(designName) };
}

/**
 * Free text made safe to put on one line of generated code or config: control characters and line
 * separators become spaces, and it is cut to a sensible length. Every name, label and text setting
 * that reaches a generated file goes through this.
 */
export function oneLine(s: string, max = 120): string {
  const t = s
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Text for the inside of a C string literal. */
export const cString = (s: string) => oneLine(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\?/g, "\\?");

/** Text for a C `//` comment: a trailing backslash would splice the next line into the comment. */
export const cComment = (s: string) => oneLine(s).replace(/\\/g, "/").replace(/\?(?=\?)/g, "? ");

/** The controller pin wired to `comp.pin`, if any. */
export function ctrlPinFor(c: FwContext, comp: string, pin: string, index = 0): NetPin | undefined {
  const net = c.nl.netOf.get(`${comp}[${index}].${pin}`);
  return net?.pins.find((p) => p.comp === c.board.name && (p.pin.type === "io" || p.pin.type === "pwr_rail" || p.pin.type === "pwr_out"));
}

/** Is `comp.pin` tied to a supply (always high)? */
export function tiedHigh(c: FwContext, comp: string, pin: string, index = 0): boolean {
  const net = c.nl.netOf.get(`${comp}[${index}].${pin}`);
  return !!net?.pins.some((p) => p.pin.type === "pwr_out" || p.pin.type === "pwr_rail");
}

export function componentsOfKind(c: FwContext, ...kinds: string[]): MachineComponent[] {
  return c.m.components.filter((x) => kinds.includes(catalogPart(x.catalogId)?.kind ?? ""));
}

/** The driver output pins a DC motor (or actuator) is connected to. */
export function driverFor(c: FwContext, motor: string): { driver: MachineComponent; part: CatalogPart; channel: string } | undefined {
  const net = c.nl.netOf.get(`${motor}[0].M_PLUS`);
  const out = net?.pins.find((p) => p.pin.type === "motor_out");
  if (!out) return undefined;
  return { driver: out.mc, part: out.part, channel: out.pin.channel ?? "A" };
}

export const ident = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

export function setting(fw: FirmwareDef, key: string, def: number): number;
export function setting(fw: FirmwareDef, key: string, def: string): string;
export function setting(fw: FirmwareDef, key: string, def: boolean): boolean;
export function setting(fw: FirmwareDef, key: string, def: number | string | boolean): number | string | boolean {
  const v = fw.settings[key];
  if (v === undefined) return def;
  if (typeof def === "number") return typeof v === "number" ? v : Number(v) || def;
  if (typeof def === "boolean") return typeof v === "boolean" ? v : v === "true" || v === 1;
  return oneLine(String(v), 400);
}

export function cNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10000) / 10000);
}
