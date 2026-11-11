// Smart servos daisy-chained on a serial bus: which servos hang off which
// adapter, in the order the wiring chains them. That order is their bus ID
// (the first servo after the adapter is 1), so the build guide, the generated
// firmware and the simulator all number them the same way.

import { catalogPart } from "./catalog";
import type { MachineData } from "./types";

export interface ServoBusDef {
  /** the adapter between the controller's UART and the servos' one-wire bus */
  adapter: string;
  /** the bus protocol (catalog spec `bus`) */
  bus: string;
  baud: number;
  servos: { comp: string; id: number }[];
}

const key = (comp: string, pin: string) => `${comp}.${pin}`;

export function servoBuses(machine: MachineData): ServoBusDef[] {
  const parts = new Map(machine.components.map((c) => [c.name, catalogPart(c.catalogId)]));
  const busOf = (comp: string) => {
    const b = parts.get(comp)?.specs.bus;
    return typeof b === "string" ? b : undefined;
  };
  // the signal wire's hops, pin to pin
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
  const out: ServoBusDef[] = [];
  for (const c of machine.components) {
    const part = parts.get(c.name);
    const bus = busOf(c.name);
    if (!part || !bus || part.kind === "servo" || !part.pins.some((p) => p.id === "SERVO_S")) continue;
    const servos: { comp: string; id: number }[] = [];
    const seen = new Set<string>([key(c.name, "SERVO_S")]);
    let front = [key(c.name, "SERVO_S")];
    while (front.length) {
      const nextFront: string[] = [];
      for (const at of front) {
        for (const to of next.get(at) ?? []) {
          if (seen.has(to)) continue;
          seen.add(to);
          const comp = to.slice(0, to.lastIndexOf("."));
          if (parts.get(comp)?.kind !== "servo" || busOf(comp) !== bus || !to.endsWith(".SIG")) continue;
          servos.push({ comp, id: servos.length + 1 });
          nextFront.push(to);
        }
      }
      front = nextFront;
    }
    const baud = Number(part.specs.baud ?? parts.get(servos[0]?.comp ?? "")?.specs.baud ?? 1_000_000);
    out.push({ adapter: c.name, bus, baud, servos });
  }
  return out;
}
