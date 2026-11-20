// The wiring tab's filters over the harness: by what the cables carry, by
// voltage, by the part they go to and by words; and each cable's load
// against its rating, for colouring the harness by load.

import { useMemo } from "react";
import { useDesign } from "../../core/engine";
import type { Harness, HarnessWire } from "../../machine/harness/harness";
import { cableLoads, carriesOf } from "../../machine/harness/details";
import type { MachineData } from "../../machine/types";
import type { WiringFilter } from "../wiringView";

/** A voltage rounded for the filter chips. */
export const roundV = (v: number) => Math.round(v * 10) / 10;

export function matches(w: HarnessWire, f: WiringFilter, volts: Map<string, number | undefined>): boolean {
  if (f.kinds.length && !f.kinds.includes(carriesOf(w.row))) return false;
  if (f.comp && !w.ends.some((e) => e.comp === f.comp || e.comp.replace(/\[\d+\]$/, "") === f.comp)) return false;
  if (f.volts.length) {
    const v = volts.get(w.id);
    if (v === undefined || !f.volts.includes(roundV(v))) return false;
  }
  const t = f.text.trim().toLowerCase();
  if (t) {
    const hay = [w.id, w.row.net, w.row.label, w.row.cable, ...w.ends.flatMap((e) => [e.comp, e.pin, e.label, e.part])].filter(Boolean).join(" ").toLowerCase();
    if (!t.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

export const filtering = (f: WiringFilter) => !!(f.kinds.length || f.volts.length || f.comp || f.text.trim());

/** The cables a filter keeps, or null when it keeps them all. */
export function harnessShown(h: Harness, f: WiringFilter, m: MachineData | undefined): Set<string> | null {
  if (!filtering(f)) return null;
  const volts = new Map<string, number | undefined>();
  if (f.volts.length && m) for (const [id, l] of cableLoads(m, h)) volts.set(id, l.volts);
  return new Set(h.wires.filter((w) => matches(w, f, volts)).map((w) => w.id));
}

/** Each cable's current as a share of what its wire is rated for (undefined where either is unknown). */
export function useCableLoads(h: Harness | null): Map<string, number | undefined> {
  const m = useDesign((s) => s.model?.machine);
  return useMemo(() => {
    const out = new Map<string, number | undefined>();
    if (!h || !m) return out;
    for (const [id, l] of cableLoads(m, h)) out.set(id, l.amps !== undefined && l.rating ? l.amps / l.rating : undefined);
    return out;
  }, [h, m]);
}
