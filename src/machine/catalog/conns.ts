// A part's spots (further places a pin can be reached) and connectors (plugs,
// sockets and the leads it is sold with), looked up by the names wiring uses.

import type { CatalogPart, ConnDef, PinDef, SpotDef } from "../types";

const same = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b;

/** The pin a wiring name means on a part: a pin's own id or label, or one of its spots. */
export function findPin(part: CatalogPart, name: string): { pin: PinDef; spot?: SpotDef } | undefined {
  const want = name.toLowerCase();
  const pin = part.pins.find((p) => same(p.id, want)) ?? part.pins.find((p) => same(p.label, want));
  if (pin) return { pin };
  const spot = part.spots?.find((s) => same(s.id, want)) ?? part.spots?.find((s) => same(s.label, want));
  const of = spot && part.pins.find((p) => p.id === spot.pin);
  return spot && of ? { pin: of, spot } : undefined;
}

/** The connector or lead with this name. */
export function findConn(part: CatalogPart, name: string): ConnDef | undefined {
  const want = name.toLowerCase();
  return part.conns?.find((c) => same(c.id, want));
}

/** The connector or lead a pin or spot is in, and its place among the contacts. */
export function connOf(part: CatalogPart, id: string): { conn: ConnDef; k: number } | undefined {
  for (const conn of part.conns ?? []) {
    const k = conn.pins.indexOf(id);
    if (k >= 0) return { conn, k };
  }
  return undefined;
}

/** Every name wiring can use on the part: pins, spots and connectors. */
export function wiringNames(part: CatalogPart): string[] {
  return [...part.pins.map((p) => p.id), ...(part.spots ?? []).map((s) => s.id), ...(part.conns ?? []).map((c) => c.id)];
}
