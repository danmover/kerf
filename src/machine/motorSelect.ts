// Motor choice: every catalog motor of the kinds asked for is run against a
// duty (torque and speed at the output, the supply and the current there is)
// with the same models the motor calculations use, and the ones that pass
// are ranked. calc.motor_select() in hardwareCalcs.ts wraps this.

import { CATALOG, isHad } from "./catalog";
import type { CatalogPart } from "./types";

export const MOTOR_DUTY_KINDS = ["any", "gearmotor", "stepper", "servo", "bldc", "actuator"] as const;
export type MotorDutyKind = (typeof MOTOR_DUTY_KINDS)[number];

export interface MotorDuty {
  /** torque needed at the output shaft, N·mm (0 for an actuator duty) */
  torque: number;
  /** rpm needed at that torque (mm/s for an actuator) */
  speed: number;
  /** force needed, N (actuators) */
  force?: number;
  /** stroke needed, mm (actuators) */
  stroke?: number;
  kind: MotorDutyKind;
  voltage?: number;
  /** what the driver or supply can give each motor, A */
  currentMax?: number;
  /** the largest fraction of a DC motor's stall torque it may run at continuously */
  continuous: number;
  maxSize?: number;
  maxMass?: number;
  /** catalog ids, part numbers or names the user has */
  have: string[];
  prefer: "cheap" | "small" | "strong";
}

export interface MotorCandidate {
  part: CatalogPart;
  /** torque (N·mm) or force (N, actuators) it gives at the duty speed */
  torque: number;
  /** speed it gives at the duty torque, rpm (mm/s for actuators) */
  speed: number;
  margin: number;
  current: number;
  voltage: number;
  basis: string;
  onHand: boolean;
  score: number;
}

const num = (s: CatalogPart["specs"], k: string): number | undefined => (typeof s[k] === "number" ? (s[k] as number) : undefined);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The largest body dimension a size limit is compared with: frame, diameter or case width. */
export function motorSize(p: CatalogPart): number {
  const d = p.geom.dims;
  switch (p.geom.g) {
    case "stepper":
      return d.size ?? 42.3;
    case "gearmotor":
      return Math.max(d.gear_d ?? 0, d.motor_d ?? 0);
    case "micro_gearmotor":
      return Math.max(d.w ?? 12, d.t ?? 10);
    case "tt_motor":
      return d.gear_w ?? 22.5;
    case "servo":
      return d.w ?? 40;
    case "outrunner":
      return d.bell_d ?? 28;
    case "actuator":
      return Math.max(d.body_w ?? 20, d.body_d ?? 15);
    default:
      return 0;
  }
}

const DUTY_KIND: Record<string, MotorDutyKind> = { gearmotor: "gearmotor", stepper: "stepper", servo: "servo", bldc: "bldc", actuator: "actuator" };

function consider(p: CatalogPart, duty: MotorDuty): MotorDutyKind | undefined {
  const k = DUTY_KIND[p.kind];
  if (!k) return undefined;
  if (duty.kind === k) return k;
  if (duty.kind !== "any") return undefined;
  // "any" means rotating motors: hobby servos only turn part of a circle, brushless motors only suit fast duties
  if (k === "servo" || k === "actuator") return undefined;
  if (k === "bldc" && duty.speed < 2000) return undefined;
  return k;
}

type Eval = { ok: true; c: Omit<MotorCandidate, "part" | "onHand" | "score"> } | { ok: false; why: string };

function gearmotor(p: CatalogPart, duty: MotorDuty): Eval {
  const s = p.specs;
  const vr = num(s, "v_rated") ?? 12;
  const V = duty.voltage ?? vr;
  const k = V / vr;
  if (k > 1.3) return { ok: false, why: `a ${vr} V motor: ${V} V would burn it out` };
  if (k < 0.5) return { ok: false, why: `a ${vr} V motor: too slow and weak on ${V} V` };
  const ts = (num(s, "t_stall") ?? 0) * k;
  const nf = (num(s, "rpm_free") ?? 0) * k;
  const is = (num(s, "i_stall") ?? 1) * k;
  const i0 = num(s, "i_free") ?? 0.1;
  if (!(ts > 0 && nf > 0)) return { ok: false, why: "no torque or speed figures" };
  const T = duty.torque;
  const frac = T / ts;
  if (frac > duty.continuous) return { ok: false, why: `needs ${Math.round(frac * 100)} % of its ${r2(ts / 1000)} N·m stall torque (keep under ${Math.round(duty.continuous * 100)} %)` };
  const rpm = nf * (1 - frac);
  if (duty.speed > 0 && rpm < duty.speed * 0.9) return { ok: false, why: `only ${Math.round(rpm)} rpm at that load` };
  const I = i0 + (is - i0) * frac;
  if (duty.currentMax && I > duty.currentMax) return { ok: false, why: `draws ${r2(I)} A at that load, more than the ${duty.currentMax} A there is` };
  const tAt = duty.speed > 0 ? ts * Math.max(0, 1 - duty.speed / nf) : ts * duty.continuous;
  return { ok: true, c: { torque: Math.min(tAt, ts * duty.continuous), speed: rpm, margin: ts / Math.max(T, 1e-9), current: I, voltage: V, basis: `straight torque–speed line from ${r2(ts / 1000)} N·m stall and ${Math.round(nf)} rpm free at ${V} V` } };
}

function stepper(p: CatalogPart, duty: MotorDuty): Eval {
  const s = p.specs;
  const th = num(s, "t_hold");
  const ir = num(s, "i_rated");
  const lph = (num(s, "l_phase") ?? 3) / 1000;
  if (!th || !ir) return { ok: false, why: "no holding torque or current figures" };
  const I = Math.min(ir * 0.85, duty.currentMax ?? Infinity);
  const V = duty.voltage ?? 24;
  const T0 = 0.85 * th * Math.min(1, I / ir);
  const corner = ((V / (2 * lph * I)) / 200) * 60;
  const T = duty.torque;
  const tAt = T0 * Math.min(1, corner / Math.max(duty.speed, 1e-9));
  const margin = tAt / Math.max(T, 1e-9);
  if (margin < 1.5) return { ok: false, why: duty.speed > corner ? `gives ${r2(tAt / 1000)} N·m at ${Math.round(duty.speed)} rpm (torque falls above about ${Math.round(corner)} rpm on ${V} V)` : `${r2(tAt / 1000)} N·m at ${r2(I)} A, under 1.5 × the load` };
  const top = T > 0 ? Math.max(corner, (T0 * corner) / T) : corner * 4;
  return { ok: true, c: { torque: tAt, speed: Math.min(top, 3000), margin, current: I, voltage: V, basis: `about 85 % of ${r2(th / 1000)} N·m holding at ${r2(I)} A, falling above ${Math.round(corner)} rpm on ${V} V` } };
}

function servo(p: CatalogPart, duty: MotorDuty): Eval {
  const s = p.specs;
  const ts = num(s, "t_stall") ?? 0;
  const vmin = num(s, "v_min") ?? 4.8;
  const vmax = num(s, "v_max") ?? 6;
  const V = duty.voltage ?? vmax;
  if (V > vmax + 0.05) return { ok: false, why: `rated ${vmin} to ${vmax} V, not ${V} V` };
  if (V < vmin - 0.05) return { ok: false, why: `needs at least ${vmin} V` };
  const rpm = 10 / (num(s, "speed_s_per_60") ?? 0.2);
  const margin = ts / Math.max(duty.torque, 1e-9);
  if (margin < 2) return { ok: false, why: `${r2(ts / 1000)} N·m stall, under 2 × the load` };
  if (duty.speed > 0 && rpm < duty.speed) return { ok: false, why: `turns at about ${Math.round(rpm)} rpm` };
  const I = num(s, "i_run") ?? 0.5;
  if (duty.currentMax && I > duty.currentMax) return { ok: false, why: `draws about ${I} A running` };
  return { ok: true, c: { torque: ts / 2, speed: rpm, margin, current: I, voltage: V, basis: `${r2(ts / 1000)} N·m stall, half of it for working, ${Math.round(rpm)} rpm from its 60° time` } };
}

function bldc(p: CatalogPart, duty: MotorDuty): Eval {
  const s = p.specs;
  const kv = num(s, "kv");
  const imax = num(s, "i_max");
  if (!kv || !imax) return { ok: false, why: "no Kv or current figures" };
  const vmax = num(s, "v_max") ?? 12.6;
  const V = duty.voltage ?? num(s, "v_nom") ?? vmax;
  if (V > vmax * 1.02) return { ok: false, why: `rated up to ${vmax} V` };
  const kt = 9549 / kv; // N·mm per A
  const I = Math.min(imax * 0.8, duty.currentMax ?? Infinity);
  const tq = kt * I;
  const free = kv * V;
  const margin = tq / Math.max(duty.torque, 1e-9);
  if (margin < 1.5) return { ok: false, why: `about ${Math.round(tq)} N·mm at ${r2(I)} A, under 1.5 × the load` };
  const rpm = free * (1 - duty.torque / (kt * imax * 1.5)) * 0.9;
  if (duty.speed > 0 && rpm < duty.speed) return { ok: false, why: `about ${Math.round(rpm)} rpm at that load on ${V} V` };
  return { ok: true, c: { torque: tq, speed: rpm, margin, current: Math.min(I, duty.torque / kt + (num(s, "i_free") ?? 0.5)), voltage: V, basis: `${r2(kt)} N·mm/A from ${kv} Kv, ${r2(I)} A, about ${Math.round(free)} rpm unloaded on ${V} V` } };
}

function actuator(p: CatalogPart, duty: MotorDuty): Eval {
  const s = p.specs;
  const F = duty.force ?? 0;
  const fmax = num(s, "f_max") ?? 0;
  const stroke = num(s, "stroke") ?? 0;
  if (duty.stroke && stroke < duty.stroke) return { ok: false, why: `${stroke} mm stroke` };
  const vr = num(s, "v_rated") ?? 12;
  if (duty.voltage && Math.abs(duty.voltage - vr) > vr * 0.25) return { ok: false, why: `a ${vr} V actuator` };
  const margin = fmax / Math.max(F, 1e-9);
  if (margin < 1.25) return { ok: false, why: `${fmax} N at most` };
  // speed falls roughly linearly from free speed to zero at the stall force
  const vfree = num(s, "speed_free_mm_s") ?? (num(s, "speed_mm_s") ?? 1) * 1.6;
  const v = vfree * Math.max(0, 1 - F / (fmax * 1.2));
  if (duty.speed > 0 && v < duty.speed * 0.9) return { ok: false, why: `about ${r2(v)} mm/s at ${Math.round(F)} N` };
  const I = (num(s, "i_free") ?? 0.1) + ((num(s, "i_stall") ?? 1) - (num(s, "i_free") ?? 0.1)) * Math.min(1, F / (fmax * 1.2));
  if (duty.currentMax && I > duty.currentMax) return { ok: false, why: `draws ${r2(I)} A at that force` };
  return { ok: true, c: { torque: fmax, speed: v, margin, current: I, voltage: vr, basis: `${fmax} N most, ${r2(vfree)} mm/s unloaded, ${stroke} mm stroke` } };
}

/** Run every catalog motor of the kinds asked for against a duty; best first. */
export function chooseMotor(duty: MotorDuty, parts: CatalogPart[] = CATALOG): { ranked: MotorCandidate[]; rejected: { id: string; why: string }[] } {
  const ranked: MotorCandidate[] = [];
  const rejected: { id: string; why: string }[] = [];
  for (const p of parts) {
    const k = consider(p, duty);
    if (!k) continue;
    const size = motorSize(p);
    const mass = num(p.specs, "mass_g") ?? 0;
    if (duty.maxSize && size > duty.maxSize) {
      rejected.push({ id: p.id, why: `${r2(size)} mm across, over the ${duty.maxSize} mm limit` });
      continue;
    }
    if (duty.maxMass && mass > duty.maxMass) {
      rejected.push({ id: p.id, why: `${mass} g, over the ${duty.maxMass} g limit` });
      continue;
    }
    const e = k === "gearmotor" ? gearmotor(p, duty) : k === "stepper" ? stepper(p, duty) : k === "servo" ? servo(p, duty) : k === "bldc" ? bldc(p, duty) : actuator(p, duty);
    if (!e.ok) {
      rejected.push({ id: p.id, why: e.why });
      continue;
    }
    const onHand = isHad(p, duty.have);
    const price = p.price_usd ?? 30;
    // a margin far from the kind's sweet spot means a motor too weak to last or too big for the job
    // (DC motors last and run efficiently at about a quarter of stall)
    const target = k === "gearmotor" ? 4 : k === "servo" ? 3 : k === "actuator" ? 1.6 : 2;
    const fit = duty.prefer === "strong" ? 0 : Math.abs(Math.log2(e.c.margin / target)) * 4;
    // a gearmotor much faster than needed is run slow on PWM and wastes its torque
    const overspeed = (k === "gearmotor" || k === "actuator") && duty.speed > 0 ? Math.max(0, Math.log2(e.c.speed / duty.speed) - 1) * 6 : 0;
    const base = duty.prefer === "small" ? size + mass / 20 : duty.prefer === "strong" ? -e.c.margin * 5 : price;
    ranked.push({ ...e.c, part: p, onHand, score: base + fit + overspeed - (onHand ? 1000 : 0) });
  }
  ranked.sort((a, b) => a.score - b.score);
  return { ranked, rejected };
}
