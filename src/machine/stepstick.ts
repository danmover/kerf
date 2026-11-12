// StepStick stepper drivers (A4988, DRV8825, TMC2209) and the steppers on them, as both the simulation and the
// firmware Kerf writes see them: the microstep settings each driver's mode pins can choose, what it is set to
// unless the design gives the real setting (measured: sim.measured(current:, microsteps:)), and so how many
// steps a turn of the stepper takes.

import type { NetPin, Netlist } from "./erc";
import type { CatalogPart } from "./types";

/** the microstep settings each driver's mode pins can choose */
export const STEP_MODES: Record<string, number[]> = { a4988: [1, 2, 4, 8, 16], drv8825: [1, 2, 4, 8, 16, 32], tmc2209: [8, 16, 32, 64] };

const num = (p: CatalogPart | undefined, key: string): number | undefined => {
  const v = p?.specs[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
};

/**
 * The microstep setting a driver runs at: the design's own (microsteps_set), else its usual one (1/16 on an
 * A4988, the most a DRV8825 does, 1/8 on a TMC2209 with its MS pins open), snapped to what its mode pins give.
 */
export function driverMicrosteps(drv: CatalogPart): { micro: number; asked: number; modes: number[] } {
  const modes = STEP_MODES[drv.id] ?? [1, 2, 4, 8, 16];
  const asked = num(drv, "microsteps_set") ?? (drv.id === "tmc2209" ? 8 : (num(drv, "microsteps") ?? 16));
  const micro = modes.reduce((a, b) => (Math.abs(b - asked) < Math.abs(a - asked) ? b : a), modes[0]);
  return { micro, asked, modes };
}

/** The phase current a driver is set to, A: the design's own (i_set), else 80 % of the stepper's rating within what the driver carries without a heatsink. */
export function driverCurrent(drv: CatalogPart, motor?: CatalogPart): number {
  const set = num(drv, "i_set");
  if (set) return set;
  const icont = num(drv, "i_cont") ?? 1;
  const rated = num(motor, "i_rated");
  return rated ? Math.min(0.8 * rated, icont) : 0.8 * icont;
}

/** Full steps a turn of a stepper (200 for 1.8°). */
export function fullSteps(motor: CatalogPart): number {
  return Math.round(360 / (num(motor, "step_deg") ?? 1.8));
}

/** A stepper and the StepStick driver its cable plugs into. */
export interface DrivenStepper {
  motor: NetPin;
  driver: NetPin;
}

/** Each stepper whose cable reaches a StepStick driver's MOTOR port, in the order the wiring plugs them in. */
export function drivenSteppers(nl: Netlist): DrivenStepper[] {
  const out: DrivenStepper[] = [];
  for (const cab of nl.cables)
    for (const [motor, driver] of [
      [cab.a, cab.b],
      [cab.b, cab.a],
    ])
      if (motor.part.kind === "stepper" && motor.pin.id === "PLUG" && driver.part.kind === "stepper_driver" && driver.pin.id === "MOTOR") out.push({ motor, driver });
  return out;
}
