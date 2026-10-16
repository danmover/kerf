// The design's circuit boards as the router sees them: each part placed with
// `on: board` becomes a footprint at its position, and every `net` statement
// that joins pins on the board becomes copper. Track widths follow the current
// a net carries (the wiring rules' netlist knows which nets are power); the
// net with the most ground pins is poured over both layers.

import { catalogPart } from "./catalog";
import { footprintFor } from "./catalog/footprints";
import { shortValue } from "./catalog/values";
import { buildNetlist, type Net } from "./erc";
import type { BoardNet, BoardSpec, PlacedPart } from "./pcb/types";
import type { BoardDef, MachineComponent, MachineData } from "./types";

/** Track widths, mm: what a 1 oz outer layer carries for a 10 °C rise is far above these. */
export const TRACK = { signal: 0.4, power: 0.6, high: 1.2 };

/** Text printed beside a part's reference: its value, part number or role. */
export function silkValue(mc: MachineComponent): string {
  const p = catalogPart(mc.catalogId);
  if (mc.value !== undefined) {
    if (p?.valued === "pot") return `${mc.taper ?? ""}${shortValue(mc.value, "ohm")}`;
    if (p?.valued === "farad") return shortValue(mc.value, "farad") + (mc.capType === "electrolytic" && mc.vRating ? `/${mc.vRating}V` : "");
    return shortValue(mc.value, "ohm");
  }
  if (mc.role && mc.role.length <= 12) return mc.role.toUpperCase();
  if (p?.mpn) return p.mpn.replace(/(CP|CV|CN|N)$/, "");
  if (p?.kind === "display") return "OLED";
  return (p?.name.split(/[\s(]/)[0] ?? mc.name).toUpperCase();
}

/** The parts placed on one board, in the order they are written. */
export function boardComponents(m: MachineData, board: string): MachineComponent[] {
  return m.components.filter((c) => c.pcb?.board === board);
}

/** Which board each board-mounted component is on. */
export function boardOf(m: MachineData): Map<string, string> {
  return new Map(m.components.filter((c) => c.pcb).map((c) => [c.name, c.pcb!.board]));
}

function widthFor(net: Net | undefined, gndHeavy: boolean): number | undefined {
  if (!net) return undefined;
  const pins = net.pins;
  const amps = Math.max(0, ...pins.map((p) => (p.pin.type === "pwr_in" ? (p.pin.draw ?? 0) : 0)));
  const power = pins.some((p) => p.pin.type === "pwr_in" || p.pin.type === "pwr_out" || p.pin.type === "pwr_rail");
  if (amps >= 0.5 || (gndHeavy && pins.some((p) => p.pin.type === "gnd" && p.part.kind === "amplifier"))) return TRACK.high;
  if (power || gndHeavy) return TRACK.power;
  return undefined;
}

export function boardSpecFor(m: MachineData, b: BoardDef): BoardSpec {
  const comps = boardComponents(m, b.name);
  const byName = new Map(comps.map((c) => [c.name, c]));
  const parts: PlacedPart[] = [];
  for (const mc of comps) {
    const p = catalogPart(mc.catalogId);
    const fp = p && footprintFor(p, { value: mc.value, taper: mc.taper, capType: mc.capType, vRating: mc.vRating });
    if (!fp || !mc.pcb || !mc.ref) continue;
    parts.push({ ref: mc.ref, value: silkValue(mc), fp, x: mc.pcb.x, y: mc.pcb.y, rot: mc.pcb.rot, side: mc.pcb.side });
  }
  const nl = buildNetlist(m);
  const nets: BoardNet[] = [];
  for (const n of m.nets) {
    const seen = new Set<string>();
    const pins: BoardNet["pins"] = [];
    let erc: Net | undefined;
    for (const r of n.pins) {
      const mc = byName.get(r.comp);
      if (!mc?.ref) continue;
      const k = `${mc.ref}.${r.pin}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pins.push({ ref: mc.ref, pin: r.pin });
      erc ??= nl.netOf.get(`${r.comp}[${r.index ?? 0}].${r.pin}`);
    }
    if (!pins.length) continue;
    const gnds = erc?.pins.filter((p) => p.pin.type === "gnd").length ?? 0;
    const bn: BoardNet = { name: n.name, pins };
    const w = n.width ?? widthFor(erc, gnds >= 2);
    if (w !== undefined) bn.width = w;
    if (n.pour) bn.pour = true;
    nets.push(bn);
  }
  // pour the ground: the net with the most ground pins, unless the design chose one
  if (!nets.some((n) => n.pour) && !m.nets.some((n) => n.pour === false)) {
    let best: BoardNet | undefined;
    let most = 1;
    for (const bn of nets) {
      const g = bn.pins.filter((pr) => {
        const mc = comps.find((c) => c.ref === pr.ref);
        return catalogPart(mc?.catalogId ?? "")?.pins.find((x) => x.id === pr.pin)?.type === "gnd";
      }).length;
      if (g > most || (g === most && best && /^(gnd|0v|ground)$/i.test(bn.name))) {
        best = bn;
        most = g;
      }
    }
    if (best || nets.find((n) => /^(gnd|ground)$/i.test(n.name))) (best ?? nets.find((n) => /^(gnd|ground)$/i.test(n.name))!).pour = true;
  }
  return { name: b.title, w: b.w, h: b.d, corner: b.corner, holes: b.holes, parts, nets };
}

export function boardSpecs(m: MachineData): { def: BoardDef; spec: BoardSpec }[] {
  return m.boards.map((def) => ({ def, spec: boardSpecFor(m, def) }));
}
