// Editing the design from its schematic sheet. Each change is written into the design's source, as a person would
// write it: the schematic block for where the symbols sit, a wire line (or one more pin on a net line) for a new
// connection, and the statement taken out for a removed one. Nothing here touches the app, so it tests on its own.

import type { SchematicLayout } from "../core/model";
import type { Span } from "../lang/ast";
import { schematicBlock, type SchematicSheet } from "./schematic";
import type { MachineData, PinRef } from "./types";

export type Place = { x: number; y: number; rot: number };

/** A pin as one key whatever way it is written: comp[i].PIN, the first copy when no copy is given. */
export function pinKey(ref: string): string {
  const m = /^([A-Za-z_]\w*)(?:\[(\d+)\])?\.(.+)$/.exec(ref.trim());
  return m ? `${m[1]}[${m[2] ?? 0}].${m[3]}` : ref;
}

const refKey = (p: PinRef) => `${p.comp}[${p.index ?? 0}].${p.pin}`;

/** Every symbol's place as the sheet shows it, with these changes: the layout stays as it is seen when one moves. */
export function placesOf(sheet: SchematicSheet, changes: Record<string, Partial<Place>> = {}): Record<string, Place> {
  const out: Record<string, Place> = {};
  for (const s of sheet.symbols) out[s.key] = { x: s.at[0], y: s.at[1], rot: s.rot, ...changes[s.key] };
  return out;
}

/** The source with its schematic block giving these places: rewritten where it is, or added at the end. */
export function withSchematic(src: string, layout: SchematicLayout | undefined, places: Record<string, Place>): string {
  const block = schematicBlock(places);
  if (layout && src.slice(layout.span.start, layout.span.start + 9) === "schematic") return src.slice(0, layout.span.start) + block + src.slice(layout.span.end);
  const body = src.replace(/\s*$/, "");
  return `${body}${body ? "\n\n" : ""}${block}\n`;
}

export type Connect = { src: string; how: "wire" | "net"; net?: string } | { src: null; why: string };

/**
 * The source with two pins joined. A pin already on a net line brings the other pin onto that net (one more pin in
 * its list, so it keeps the net's gauge and colour); otherwise a wire line goes in after the last one.
 */
export function withConnection(src: string, m: MachineData, a: string, b: string): Connect {
  const ka = pinKey(a);
  const kb = pinKey(b);
  if (ka === kb) return { src: null, why: "that is the same pin" };
  if (m.wires.some((w) => (refKey(w.a) === ka && refKey(w.b) === kb) || (refKey(w.a) === kb && refKey(w.b) === ka))) return { src: null, why: `${a} and ${b} are already wired together` };
  const netOf = (k: string) => m.nets.find((n) => n.pins.some((p) => refKey(p) === k) && src.slice(n.span.start, n.span.start + 3) === "net");
  const na = netOf(ka);
  const nb = netOf(kb);
  if (na && na === nb) return { src: null, why: `${a} and ${b} are both on the ${na.name} net already` };
  const on = na && !nb ? { net: na, add: b } : nb && !na ? { net: nb, add: a } : null;
  if (on) {
    const last = on.net.pins[on.net.pins.length - 1];
    return { src: `${src.slice(0, last.span.end)}, ${on.add}${src.slice(last.span.end)}`, how: "net", net: on.net.name };
  }
  const line = `wire ${a} -> ${b}`;
  // after the last wire line (or net line) written in this design, with its indent
  const ends = [...m.wires, ...m.nets].map((s) => s.span).filter((sp) => /^(wire|net)\b/.test(src.slice(sp.start, sp.start + 4)));
  if (!ends.length) {
    const body = src.replace(/\s*$/, "");
    return { src: `${body}${body ? "\n\n" : ""}${line}\n`, how: "wire" };
  }
  const end = Math.max(...ends.map((sp) => sp.end));
  const lineStart = src.lastIndexOf("\n", end - 1) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
  const nl = src.indexOf("\n", end);
  const at = nl < 0 ? src.length : nl;
  return { src: `${src.slice(0, at)}\n${indent}${line}${src.slice(at)}`, how: "wire" };
}

/** The source without these statements (the wire lines, or the net line, a connection on the sheet comes from). */
export function withoutStatements(src: string, spans: Span[]): string {
  let out = src;
  // from the end, so the earlier spans keep their places
  for (const sp of [...new Map(spans.map((s) => [s.start, s])).values()].sort((x, y) => y.start - x.start)) out = cut(out, sp.start, sp.end);
  return out;
}

/** The source with this pin taken off whatever joins it: its wire lines out, and its place in a net line's list. */
export function withoutPin(src: string, m: MachineData, ref: string): string {
  const k = pinKey(ref);
  const cuts: { start: number; end: number; line: boolean }[] = [];
  for (const w of m.wires) if ((refKey(w.a) === k || refKey(w.b) === k) && src.slice(w.span.start, w.span.start + 4) === "wire") cuts.push({ ...w.span, line: true });
  for (const n of m.nets) {
    if (src.slice(n.span.start, n.span.start + 3) !== "net") continue;
    const i = n.pins.findIndex((p) => refKey(p) === k);
    if (i < 0) continue;
    // a net left with one pin joins nothing: the line goes
    if (n.pins.length <= 2) {
      cuts.push({ ...n.span, line: true });
      continue;
    }
    // the pin and the comma before it (or after it, for the first in the list)
    const p = n.pins[i];
    const start = i > 0 ? n.pins[i - 1].span.end : p.span.start;
    const end = i > 0 ? p.span.end : n.pins[i + 1].span.start;
    cuts.push({ start, end, line: false });
  }
  let out = src;
  for (const c of cuts.sort((x, y) => y.start - x.start)) out = c.line ? cut(out, c.start, c.end) : out.slice(0, c.start) + out.slice(c.end);
  return out;
}

/** A statement cut out: its whole line when nothing else is on it. */
function cut(src: string, start: number, end: number): string {
  const ls = src.lastIndexOf("\n", start - 1) + 1;
  const le = src.indexOf("\n", end);
  const lineEnd = le < 0 ? src.length : le;
  if (src.slice(ls, start).trim() || src.slice(end, lineEnd).trim()) return src.slice(0, start) + src.slice(end);
  return src.slice(0, ls) + src.slice(lineEnd < src.length ? lineEnd + 1 : lineEnd);
}
