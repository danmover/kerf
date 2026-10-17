// Values measured on a real part, in place of its catalog specs, for the
// simulation (`measured: sim.measured(...)` on a component). Kept apart from
// the scenario language so the simulation worker reads it without the
// evaluator.

import { catalogPart } from "./catalog";
import type { CatalogPart, MachineComponent } from "./types";

/**
 * What sim.measured() can set on a part, by kind: the name in the call, the
 * catalog spec the simulation reads instead, and how the value converts.
 */
export const MEASURED: Record<string, Record<string, { spec: string; doc: string; toSpec?: (v: number, specs: Record<string, unknown>) => number }>> = {
  gearmotor: {
    i_free: { spec: "i_free", doc: "current running free at its rated voltage (A)" },
    i_stall: { spec: "i_stall", doc: "stall current at its rated voltage (A): rated volts over the winding resistance" },
    rpm_free: { spec: "rpm_free", doc: "output speed running free at its rated voltage (rpm)" },
    t_stall: { spec: "t_stall", doc: "stall torque at the output at its rated voltage (N·mm)" },
  },
  battery: {
    r_int: { spec: "r_int_mohm", doc: "the whole pack's internal resistance, with its leads (Ohm)", toSpec: (v, s) => (v * 1000) / (typeof s.cells === "number" && s.cells > 0 ? s.cells : 1) },
    capacity: { spec: "capacity_mah", doc: "capacity (mAh)" },
  },
};

/** A component's catalog part with any measured values in place of its specs. */
export function measuredPart(mc: MachineComponent): CatalogPart | undefined {
  const p = catalogPart(mc.catalogId);
  return p && mc.measured ? { ...p, specs: { ...p.specs, ...mc.measured } } : p;
}
