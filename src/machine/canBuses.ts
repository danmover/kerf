// Actuators on CAN buses: which CAN-commanded actuators (catalog spec bus "cubemars_mit") hang off which
// transceiver, found by following the design's CAN_H wiring from the transceiver. Their CAN ids run on from one
// bus to the next in the order the wiring lists them (the first actuator on the first transceiver's bus is 1), so
// the build guide, the generated firmware and the simulator all number them the same way, and no two share an id.

import { catalogPart } from "./catalog";
import type { MachineData } from "./types";

export interface CanBusDef {
  /** the transceiver between the controller's CAN port and the bus */
  transceiver: string;
  bus: string;
  baud: number;
  motors: { comp: string; id: number }[];
}

const key = (comp: string, pin: string) => `${comp}.${pin}`;

export function canBuses(machine: MachineData): CanBusDef[] {
  const parts = new Map(machine.components.map((c) => [c.name, catalogPart(c.catalogId)]));
  const next = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (!next.has(a)) next.set(a, []);
    next.get(a)!.push(b);
  };
  for (const w of machine.wires) {
    link(key(w.a.comp, w.a.pin), key(w.b.comp, w.b.pin));
    link(key(w.b.comp, w.b.pin), key(w.a.comp, w.a.pin));
  }
  for (const n of machine.nets) {
    const pins = n.pins.map((p) => key(p.comp, p.pin));
    for (let i = 1; i < pins.length; i++) {
      link(pins[i - 1], pins[i]);
      link(pins[i], pins[i - 1]);
    }
  }
  const out: CanBusDef[] = [];
  let id = 0;
  for (const c of machine.components) {
    const part = parts.get(c.name);
    if (!part || part.kind === "servo" || !part.pins.some((p) => p.id === "CAN_H") || !part.pins.some((p) => p.id === "CAN_TX")) continue;
    const motors: CanBusDef["motors"] = [];
    let bus = "";
    let baud = 1_000_000;
    const seen = new Set<string>([key(c.name, "CAN_H")]);
    let front = [key(c.name, "CAN_H")];
    while (front.length) {
      const nextFront: string[] = [];
      for (const at of front)
        for (const to of next.get(at) ?? []) {
          if (seen.has(to)) continue;
          seen.add(to);
          if (!to.endsWith(".CAN_H")) continue;
          nextFront.push(to);
          const comp = to.slice(0, to.lastIndexOf("."));
          const mp = parts.get(comp);
          const b = mp?.specs.bus;
          if (mp?.kind !== "servo" || typeof b !== "string" || motors.some((m) => m.comp === comp)) continue;
          bus = b;
          baud = Number(mp.specs.baud ?? baud);
          motors.push({ comp, id: ++id });
        }
      front = nextFront;
    }
    if (motors.length) out.push({ transceiver: c.name, bus, baud, motors });
  }
  return out;
}
