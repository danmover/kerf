// Runs a mechanism scenario that has no firmware: the mechanism's motors and
// actuators get the volts the scenario gives them over time (their rated
// volts when it gives none), servos the angles it asks for, and the inputs
// (a hand on a crank, a solenoid, an air cylinder) do the rest. The motors,
// actuators and servos are the same models the firmware runs use, so their
// current and heating come out the same way.

import type { MachineData } from "../../machine/types";
import { catalogPart } from "../../machine/catalog";
import { Actuator, DCMotor, Servo } from "../engine/devices";
import type { Frames, RunResult, VariantRun } from "../engine/run";
import { VARIANTS, type VariantName } from "../worlds/common";
import type { DriveIO, PlantView, WorldEvent } from "../worlds/types";
import type { MechWorld } from "../worlds/mechanism";
import { ramp, type Schedule } from "./couplings";

export interface MechRunOptions {
  machine?: MachineData;
  world: (variant: VariantName, seed: number) => MechWorld;
  /** longest simulated time, s */
  duration: number;
  variants?: VariantName[];
  seed?: number;
  frameHz?: number;
  onProgress?: (variant: VariantName, done: number) => void;
}

/** frames a second worth recording for a run this long: fast enough to follow a turning crank */
export function mechFrameHz(duration: number): number {
  return duration <= 20 ? 100 : duration <= 120 ? 30 : 10;
}

export function runMechanism(opts: MechRunOptions): RunResult {
  const variants = opts.variants ?? VARIANTS;
  const out: VariantRun[] = variants.map((v) => runOne(opts, v, (opts.seed ?? 1) + VARIANTS.indexOf(v) * 7919));
  return { firmware: { name: "", board: "", boardName: "", files: [], config: [] }, variants: out };
}

interface Dev {
  io: DriveIO;
  motor?: DCMotor;
  act?: Actuator;
  servo?: Servo;
  power?: Schedule;
}

function runOne(opts: MechRunOptions, variant: VariantName, seed: number): VariantRun {
  const wall0 = Date.now();
  const world = opts.world(variant, seed);
  const model = world.model;
  const { ambient, cooling } = world.thermal();
  const notes: string[] = [];
  const devs: Dev[] = [];
  for (const d of model.drives) {
    if (d.kind !== "motor" && d.kind !== "servo" && d.kind !== "actuator") continue;
    const mc = opts.machine?.components.find((c) => c.name === d.comp);
    const part = mc ? catalogPart(mc.catalogId) : undefined;
    if (!part) {
      notes.push(`${d.comp} is not a catalog ${d.kind}, so it does not drive ${d.joint}`);
      continue;
    }
    const power = model.power[d.comp];
    const io: DriveIO = { comp: d.comp, kind: d.kind, v: null, ilim: 99, us: null, powered: true, dev: null };
    if (d.kind === "motor") {
      const m = new DCMotor(d.comp, part, ambient);
      io.dev = m;
      devs.push({ io, motor: m, power });
      if (!power) notes.push(`${d.comp} runs at its rated ${m.vr} V the whole run (give sim.power(${d.comp}, volts: ...) to change that)`);
    } else if (d.kind === "actuator") {
      const a = new Actuator(d.comp, part, d.start);
      io.dev = a;
      devs.push({ io, act: a, power });
      if (!power) notes.push(`${d.comp} extends at its rated ${a.vr} V the whole run`);
    } else {
      const s = new Servo(d.comp, part);
      s.angle = d.zero;
      io.dev = s;
      devs.push({ io, servo: s, power });
    }
  }

  const view: PlantView = {
    motor: (c) => {
      const m = devs.find((d) => d.io.comp === c)?.motor;
      return m ? { omega: m.omega, angle: m.angle, current: m.current, torque: m.torque } : undefined;
    },
    actuator: (c) => {
      const a = devs.find((d) => d.io.comp === c)?.act;
      return a ? { pos: a.pos, speed: a.speed, force: a.force } : undefined;
    },
    servo: (c) => {
      const s = devs.find((d) => d.io.comp === c)?.servo;
      return s ? { angle: s.angle } : undefined;
    },
  };
  world.init?.(view);

  const dt = 1e-3;
  const frameDt = 1 / (opts.frameHz ?? mechFrameHz(opts.duration));
  const cols: Record<string, number[]> = {};
  const times: number[] = [];
  let names: string[] | null = null;
  const record = (t: number) => {
    const row: Record<string, number> = {};
    for (const d of devs) {
      const c = d.io.comp;
      if (d.motor) {
        row[`${c}.rpm`] = (d.motor.omega * 60) / (2 * Math.PI);
        row[`${c}.amps`] = d.motor.current;
        row[`${c}.volts`] = d.motor.volts;
        row[`${c}.temp`] = d.motor.temp;
        row[`${c}.torque`] = d.motor.torque;
        row[`${c}.turns`] = d.motor.angle / (2 * Math.PI);
      } else if (d.act) {
        row[`${c}.pos`] = d.act.pos;
        row[`${c}.amps`] = d.act.current;
        row[`${c}.force`] = d.act.force;
      } else if (d.servo) {
        row[`${c}.angle`] = d.servo.angle;
        row[`${c}.amps`] = d.servo.current;
      }
    }
    Object.assign(row, world.channels());
    if (!names) {
      names = Object.keys(row);
      for (const n of names) cols[n] = [];
    }
    times.push(t);
    for (const n of names) cols[n].push(row[n] ?? NaN);
  };

  // the run ends a while after everything has come to rest once the inputs have finished changing
  const lastInput = Math.max(0, ...Object.values(model.power).flatMap((s) => s.map((p) => p[0])), ...model.drives.flatMap((d) => (d.kind === "turn" ? d.speed : d.kind === "force" ? d.value : d.kind === "solenoid" ? d.on : d.kind === "cylinder" ? d.valve : []).map((p) => p[0])), ...model.loads.flatMap((l) => l.value.map((p) => p[0])));
  let stop = "duration";
  let stillSince = 0;
  let nextFrame = 0;
  let t = 0;
  const steps = Math.round(opts.duration / dt);
  for (let k = 0; k < steps; k++) {
    for (const d of devs) {
      if (d.motor || d.act) {
        const vr = d.motor ? d.motor.vr : d.act!.vr;
        d.io.v = d.power ? ramp(d.power, t) : vr;
      } else if (d.servo) {
        const ang = d.power ? ramp(d.power, t) : null;
        d.io.us = ang === null ? 500 + (d.servo.angle / d.servo.range) * 2000 : 500 + (Math.max(0, Math.min(d.servo.range, ang)) / d.servo.range) * 2000;
      }
    }
    const moved = world.couple(
      devs.map((d) => d.io),
      dt,
      t,
    );
    for (const d of devs) {
      const mv = moved.get(d.io.comp);
      if (!mv) continue;
      if (d.motor) d.motor.follow(d.io.v, d.io.ilim, mv.speed, dt, ambient, cooling);
      else if (d.act) d.act.follow(d.io.v, mv.pos, mv.speed, mv.load, dt);
      else if (d.servo) d.servo.follow(d.io.us, mv.pos, mv.load, true);
    }
    world.step(dt, t, view);
    t += dt;
    if (t >= nextFrame) {
      record(t);
      nextFrame += frameDt;
      if (k % 2000 === 0) opts.onProgress?.(variant, Math.min(1, t / opts.duration));
    }
    if (world.unstable) {
      stop = "the simulation went unstable";
      break;
    }
    let moving = false;
    for (const b of world.sys.bodies.values()) {
      if (b.fixed) continue;
      if (Math.hypot(...b.v) > 1e-3 || Math.hypot(...b.w) > 1e-2) {
        moving = true;
        break;
      }
    }
    if (moving) stillSince = t;
    else if (t > lastInput + 0.5 && t - stillSince > 2) {
      stop = "everything stopped";
      break;
    }
  }
  record(t);
  opts.onProgress?.(variant, 1);

  const frames: Frames = { t: Float32Array.from(times), series: {} };
  for (const [n, v] of Object.entries(cols)) frames.series[n] = Float32Array.from(v);
  const events: WorldEvent[] = [...world.events].sort((a, b) => a.t - b.t);
  const motors = devs.filter((d) => d.motor).map((d) => ({ name: d.io.comp, peakAmps: d.motor!.peakCurrent, maxTemp: d.motor!.maxTemp, wh: d.motor!.energy / 3600, loadPeak: peakShare(frames, `${d.io.comp}.torque`, Number(d.motor!.part.specs.t_stall ?? 1000) / 1000), heatGuess: d.motor!.heatGuess || undefined }));
  const results: Record<string, number | boolean | string> = { ...world.results() };
  results.time = t;
  results.stopped = stop;
  for (const m of motors) {
    results[`${m.name}.peak_amps`] = m.peakAmps;
    results[`${m.name}.max_temp`] = m.maxTemp;
    results[`${m.name}.load`] = m.loadPeak;
  }
  for (const d of devs) if (d.act) results[`${d.io.comp}.travel`] = d.act.travel;
  return {
    variant,
    stop,
    frames,
    events,
    serial: [],
    faults: [],
    results,
    summary: { time: t, wallMs: Date.now() - wall0, ram: { used: 0, total: 0, static: 0, stack: 0 }, loopMax: 0, isrLoad: 0, motors, eepromWrites: 0 },
    scene: world.scene(),
    displays: [],
    assumptions: [...world.assumptions, ...devs.flatMap((d) => d.motor?.assumed ?? [])],
    notes,
    limits: [...world.limits, "No firmware: the motors and actuators get the volts the scenario gives them, straight from an ideal supply."],
  };
}

/** the highest one-second average of a series as a share of a value */
function peakShare(f: Frames, name: string, of: number): number {
  const s = f.series[name];
  if (!s || !s.length) return 0;
  const n = Math.max(1, Math.round(1 / Math.max(1e-6, (f.t[f.t.length - 1] - f.t[0]) / Math.max(1, f.t.length - 1))));
  let best = 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    sum += Math.abs(s[i]);
    if (i >= n) sum -= Math.abs(s[i - n]);
    if (i >= n - 1 || i === s.length - 1) best = Math.max(best, sum / Math.min(n, i + 1));
  }
  return best / of;
}
