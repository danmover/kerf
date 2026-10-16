// Helpers for writing pin lists in the catalog.

import type { BusKind, PinDef } from "../types";

export const gnd = (id = "GND", label?: string): PinDef => ({ id, label, type: "gnd", required: true });

export function pwrIn(id: string, vmin: number, vmax: number, opts: Partial<PinDef> = {}): PinDef {
  return { id, type: "pwr_in", vmin, vmax, vabs: opts.vabs ?? vmax, draw: opts.draw ?? 0, required: opts.required ?? true, ...opts };
}

export function pwrOut(id: string, v: number, imax: number, opts: Partial<PinDef> = {}): PinDef {
  return { id, type: "pwr_out", v, imax, ...opts };
}

export function rail(id: string, v: number, imax: number, draw: number, opts: Partial<PinDef> = {}): PinDef {
  return { id, type: "pwr_rail", v, imax, draw, ...opts };
}

export function input(id: string, vmax: number, vih: number, opts: Partial<PinDef> = {}): PinDef {
  return { id, type: "in", vmax, vih, ...opts };
}

export function motorOut(id: string, channel: string, imax: number, ipeak: number, label?: string): PinDef {
  return { id, label, type: "motor_out", channel, imax, ipeak };
}

export function port(id: string, kind: string, side: "source" | "sink", opts: Partial<PinDef> = {}): PinDef {
  return { id, type: "port", port: kind, side, ...opts };
}

/** Arduino-style GPIO list: D0..Dn plus analog pins, with PWM and bus capabilities. */
export function avrPins(opts: { digital: number; pwm: number[]; analog: number; analogOnly?: number[]; bus: Record<string, BusKind>; serial?: Record<number, string>; irq?: number[] }): PinDef[] {
  const out: PinDef[] = [];
  for (let i = 0; i < opts.digital; i++) {
    const id = `D${i}`;
    out.push({ id, type: "io", v: 5, imax: 0.02, pwm: opts.pwm.includes(i), irq: (opts.irq ?? [2, 3]).includes(i), mcu: String(i), bus: opts.bus[id], note: opts.serial?.[i] });
  }
  for (let i = 0; i < opts.analog; i++) {
    const id = `A${i}`;
    const only = opts.analogOnly?.includes(i);
    out.push({ id, type: "io", v: 5, imax: only ? 0 : 0.02, adc: true, input_only: only, mcu: `A${i}`, bus: opts.bus[id], note: only ? "Analog input only" : undefined });
  }
  return out;
}
