// Motion planning the way each firmware does it. Every firmware cuts G-code
// moves into straight segments with trapezoid speed profiles (accelerate,
// cruise, decelerate) and plans how fast to take each corner; they differ in
// the corner rule and how far ahead they look:
//   Klipper: square_corner_velocity turned into a junction deviation, with a
//     centripetal limit for short moves, and its "smoothed" lookahead that keeps
//     minimum_cruise_ratio of short moves at cruise speed. Looks ahead as far
//     as the queue reaches (moves are flushed lazily, as in toolhead.py).
//   Marlin: junction deviation (or classic jerk), with an arc limit on moves
//     under 1 mm, planned over a fixed BLOCK_BUFFER_SIZE window: the newest
//     block must always be able to stop, so short segments slow it down.
//   RepRapFirmware: per-axis instantaneous speed changes (M566) planned over
//     its move queue.

import type { AxisE, Junction, PrinterSetup } from "./config";

export interface MoveTag {
  /** the move puts down plastic */
  extrude: boolean;
  /** G-code source line, for messages */
  line: number;
  file: string;
}

export interface PlanMove {
  start: [number, number, number, number];
  end: [number, number, number, number];
  d: [number, number, number, number];
  /** length: XYZ distance, or the filament length of an extrude-only move */
  dist: number;
  /** d / dist */
  r: [number, number, number, number];
  /** moves the toolhead (not extrude-only) */
  kin: boolean;
  accel: number;
  maxCruiseV2: number;
  deltaV2: number;
  smoothDeltaV2: number;
  maxStartV2: number;
  maxSmoothedV2: number;
  minMoveT: number;
  /** Klipper's junction deviation for this move, mm */
  jd: number;
  /** jerk planners: the speed it may start from or stop to at rest, squared */
  safeV2: number;
  /** speeds the planner chose, mm/s */
  startV: number;
  cruiseV: number;
  endV: number;
  tag: MoveTag;
  /** things to do once the move is done (temperature and fan changes queued behind it) */
  after?: (() => void)[];
}

export interface MoveRequest {
  start: [number, number, number, number];
  end: [number, number, number, number];
  /** requested speed, mm/s */
  speed: number;
  tag: MoveTag;
}

/** The limits a planner takes from the running firmware (M204, SET_VELOCITY_LIMIT and the config). */
export interface Limits {
  velocity: number;
  accel: number;
  printAccel: number;
  travelAccel: number;
  retractAccel: number;
  minCruiseRatio: number;
  junction: Junction;
  maxV: Record<AxisE, number>;
  maxA: Record<AxisE, number>;
  /** Klipper extruder */
  cornerV: number;
}

export function limitsOf(s: PrinterSetup): Limits {
  return {
    velocity: s.velocity,
    accel: s.accel,
    printAccel: s.printAccel,
    travelAccel: s.travelAccel,
    retractAccel: s.retractAccel,
    minCruiseRatio: s.minCruiseRatio,
    junction: s.junction.kind === "jerk" ? { kind: "jerk", v: { ...s.junction.v } } : { ...s.junction },
    maxV: { ...s.maxV },
    maxA: { ...s.maxA },
    cornerV: s.extruder.cornerV,
  };
}

const AX: AxisE[] = ["x", "y", "z", "e"];

/** A move with its own limits worked out, before any corner is planned. */
export function makeMove(req: MoveRequest, L: Limits, flavor: PrinterSetup["flavor"]): PlanMove | null {
  const d: [number, number, number, number] = [req.end[0] - req.start[0], req.end[1] - req.start[1], req.end[2] - req.start[2], req.end[3] - req.start[3]];
  let dist = Math.hypot(d[0], d[1], d[2]);
  let kin = true;
  if (dist < 1e-9) {
    kin = false;
    dist = Math.abs(d[3]);
    if (dist < 1e-9) return null;
  }
  const inv = 1 / dist;
  const r: [number, number, number, number] = [d[0] * inv, d[1] * inv, d[2] * inv, d[3] * inv];
  let v = Math.max(1e-3, req.speed);
  let accel: number;
  if (flavor === "klipper") {
    v = Math.min(v, L.velocity);
    accel = kin ? L.accel : 99999999.9;
    if (!kin) {
      // extrude-only moves take the extruder's own limits
      v = Math.min(v, L.maxV.e);
      accel = Math.min(accel, L.maxA.e);
    } else if (d[2]) {
      const zr = dist / Math.abs(d[2]);
      v = Math.min(v, L.maxV.z * zr);
      accel = Math.min(accel, L.maxA.z * zr);
    }
  } else {
    // Marlin and RepRapFirmware: the kind of move picks the acceleration, then each axis caps speed and acceleration
    accel = !kin ? L.retractAccel : d[3] > 0 ? L.printAccel : L.travelAccel;
    if (!Number.isFinite(accel)) accel = 3000;
    for (let i = 0; i < 4; i++) {
      const ri = Math.abs(r[i]);
      if (ri < 1e-12) continue;
      // extrusion during a printing move rarely limits it, but the extruder's limits still apply
      v = Math.min(v, L.maxV[AX[i]] / ri);
      accel = Math.min(accel, L.maxA[AX[i]] / ri);
    }
  }
  const deltaV2 = 2 * dist * accel;
  const atd = flavor === "klipper" ? accel * (1 - L.minCruiseRatio) : accel;
  let jd = 0;
  if (L.junction.kind === "scv") jd = (L.junction.v * L.junction.v * (Math.SQRT2 - 1)) / L.accel;
  let safeV2 = 0;
  if (L.junction.kind === "jerk") {
    // the speed every axis may jump to from rest (Marlin's "safe speed")
    let safe = v;
    for (let i = 0; i < 4; i++) {
      const sp = Math.abs(r[i]) * v;
      const j = L.junction.v[AX[i]];
      if (sp > j) safe = Math.min(safe, j / Math.abs(r[i]));
    }
    safeV2 = safe * safe;
  }
  return {
    start: req.start,
    end: req.end,
    d,
    dist,
    r,
    kin,
    accel,
    maxCruiseV2: v * v,
    deltaV2,
    smoothDeltaV2: Math.min(2 * dist * atd, deltaV2),
    maxStartV2: 0,
    maxSmoothedV2: 0,
    minMoveT: dist / v,
    jd,
    safeV2,
    startV: 0,
    cruiseV: 0,
    endV: 0,
    tag: req.tag,
  };
}

/** The fastest speed² the move may start at, coming off `prev` without stopping. */
export function junctionV2(prev: PlanMove, m: PlanMove, L: Limits, flavor: PrinterSetup["flavor"]): number {
  if (!m.kin || !prev.kin) return flavor === "klipper" || L.junction.kind !== "jerk" ? 0 : Math.min(m.safeV2, prev.safeV2);
  const cosT = -(m.r[0] * prev.r[0] + m.r[1] * prev.r[1] + m.r[2] * prev.r[2]);
  if (flavor === "klipper") {
    // toolhead.py Move.calc_junction
    let e2 = m.maxCruiseV2;
    const dr = m.r[3] - prev.r[3];
    if (dr) e2 = (L.cornerV / Math.abs(dr)) ** 2;
    let v2 = Math.min(e2, m.maxCruiseV2, prev.maxCruiseV2, prev.maxStartV2 + prev.deltaV2);
    const sin2 = Math.sqrt(Math.max(0.5 * (1 - cosT), 0));
    const cos2 = Math.sqrt(Math.max(0.5 * (1 + cosT), 0));
    const oms = 1 - sin2;
    if (oms > 0 && cos2 > 0) {
      const R = sin2 / oms;
      const qt = (0.25 * sin2) / cos2;
      v2 = Math.min(v2, R * m.jd * m.accel, R * prev.jd * prev.accel, m.deltaV2 * qt, prev.deltaV2 * qt);
    }
    return v2;
  }
  const cap = Math.min(m.maxCruiseV2, prev.maxCruiseV2);
  if (L.junction.kind === "jd") {
    // Marlin planner.cpp: junction deviation with the junction's own acceleration limit
    if (cosT > 0.999999) return 0;
    const c = Math.max(cosT, -0.999999);
    const sin2 = Math.sqrt(0.5 * (1 - c));
    let jx = m.r[0] - prev.r[0];
    let jy = m.r[1] - prev.r[1];
    let jz = m.r[2] - prev.r[2];
    const jn = Math.hypot(jx, jy, jz) || 1;
    jx /= jn;
    jy /= jn;
    jz /= jn;
    let ja = m.accel;
    for (const [ri, ax] of [[jx, "x"], [jy, "y"], [jz, "z"]] as const) if (Math.abs(ri) > 1e-9) ja = Math.min(ja, L.maxA[ax] / Math.abs(ri));
    let v2 = (ja * L.junction.mm * sin2) / (1 - sin2);
    if (m.dist < 1) {
      // short segments are an arc: keep v²/r within the acceleration
      const theta = Math.PI - Math.acos(c);
      if (theta > 1e-6) v2 = Math.min(v2, (m.dist * ja) / theta);
    }
    return Math.min(v2, cap);
  }
  if (L.junction.kind !== "jerk") return cap;
  // jerk: the highest common speed at which no axis changes speed by more than its jerk limit
  const jerk = L.junction.v;
  const vp = Math.sqrt(prev.maxCruiseV2);
  const vm = Math.sqrt(m.maxCruiseV2);
  let v = Math.min(vp, vm);
  for (let i = 0; i < 4; i++) {
    const dv = Math.abs(m.r[i] - prev.r[i]);
    if (dv * v > jerk[AX[i]]) v = jerk[AX[i]] / dv;
  }
  // both moves may as well use their own safe speeds if that is faster
  const vj = Math.max(v * v, Math.min(prev.safeV2, m.safeV2));
  return Math.min(vj, cap);
}

function setJunction(m: PlanMove, start2: number, cruise2: number, end2: number) {
  m.startV = Math.sqrt(Math.max(0, start2));
  m.cruiseV = Math.sqrt(Math.max(1e-12, cruise2));
  m.endV = Math.sqrt(Math.max(0, end2));
}

export interface Planner {
  /** queue a move; moves the planner commits go to the executor */
  add(m: PlanMove): void;
  /** run `fn` once every move queued so far is done */
  after(fn: () => void): void;
  /** plan everything queued to a stop and execute it */
  flush(): void;
  /** moves waiting in the queue */
  readonly queued: number;
  /** the last move queued since the toolhead last stopped */
  readonly last: PlanMove | null;
}

/** Klipper's lookahead queue (toolhead.py LookAheadQueue), flushed lazily every 250 ms of queued moves. */
export class KlipperPlanner implements Planner {
  private q: PlanMove[] = [];
  private junctionFlush = 0.25;
  private prev: PlanMove | null = null;
  constructor(
    private L: () => Limits,
    private exec: (m: PlanMove) => void,
  ) {}
  get queued() {
    return this.q.length;
  }
  get last() {
    return this.prev;
  }
  add(m: PlanMove) {
    const prev = this.prev;
    if (prev) {
      if (m.kin && prev.kin) {
        m.maxStartV2 = junctionV2(prev, m, this.L(), "klipper");
        m.maxSmoothedV2 = Math.min(m.maxStartV2, prev.maxSmoothedV2 + prev.smoothDeltaV2);
      }
    }
    this.q.push(m);
    this.prev = m;
    if (this.q.length === 1) return;
    this.junctionFlush -= m.minMoveT;
    if (this.junctionFlush <= 0) this.run(true);
  }
  after(fn: () => void) {
    const lastQ = this.q[this.q.length - 1];
    if (lastQ) (lastQ.after ??= []).push(fn);
    else fn();
  }
  flush() {
    this.run(false);
    this.prev = null;
  }
  private run(lazy: boolean) {
    this.junctionFlush = 0.25;
    const q = this.q;
    let update = lazy;
    let flushCount = q.length;
    const delayed: [PlanMove, number, number][] = [];
    let nextEnd2 = 0;
    let nextSmooth2 = 0;
    let peak2 = 0;
    for (let i = flushCount - 1; i >= 0; i--) {
      const m = q[i];
      const reachStart2 = nextEnd2 + m.deltaV2;
      const start2 = Math.min(m.maxStartV2, reachStart2);
      const reachSmooth2 = nextSmooth2 + m.smoothDeltaV2;
      const smooth2 = Math.min(m.maxSmoothedV2, reachSmooth2);
      if (smooth2 < reachSmooth2) {
        if (smooth2 + m.smoothDeltaV2 > nextSmooth2 || delayed.length) {
          if (update && peak2) {
            flushCount = i;
            update = false;
          }
          peak2 = Math.min(m.maxCruiseV2, (smooth2 + reachSmooth2) * 0.5);
          if (delayed.length) {
            if (!update && i < flushCount) {
              let mc2 = peak2;
              for (let k = delayed.length - 1; k >= 0; k--) {
                const [dm, ms2, me2] = delayed[k];
                mc2 = Math.min(mc2, ms2);
                setJunction(dm, Math.min(ms2, mc2), mc2, Math.min(me2, mc2));
              }
            }
            delayed.length = 0;
          }
        }
        if (!update && i < flushCount) {
          const cruise2 = Math.min((start2 + reachStart2) * 0.5, m.maxCruiseV2, peak2);
          setJunction(m, Math.min(start2, cruise2), cruise2, Math.min(nextEnd2, cruise2));
        }
      } else delayed.push([m, start2, nextEnd2]);
      nextEnd2 = start2;
      nextSmooth2 = smooth2;
    }
    if (update || !flushCount) return;
    if (!lazy && delayed.length) {
      // moves still waiting for a peak at the very start of the queue: each takes its own best
      for (const [dm, ms2, me2] of delayed) {
        const mc2 = Math.min(dm.maxCruiseV2, (ms2 + me2 + dm.deltaV2) / 2);
        setJunction(dm, Math.min(ms2, mc2), mc2, Math.min(me2, mc2));
      }
    }
    const done = q.splice(0, flushCount);
    for (const m of done) {
      this.exec(m);
      if (m.after) for (const fn of m.after) fn();
    }
  }
}

/** Marlin's block buffer and RepRapFirmware's move queue: a fixed window, with the newest move always able to stop. */
export class WindowPlanner implements Planner {
  private q: PlanMove[] = [];
  private prev: PlanMove | null = null;
  /** the speed² the toolhead leaves the last executed move at */
  private exitV2 = 0;
  constructor(
    private size: number,
    private flavor: PrinterSetup["flavor"],
    private L: () => Limits,
    private exec: (m: PlanMove) => void,
  ) {}
  get queued() {
    return this.q.length;
  }
  get last() {
    return this.prev;
  }
  add(m: PlanMove) {
    const prev = this.prev;
    m.maxStartV2 = prev ? junctionV2(prev, m, this.L(), this.flavor) : m.safeV2;
    if (!prev) m.maxStartV2 = Math.min(m.safeV2, m.maxCruiseV2);
    this.prev = m;
    this.q.push(m);
    if (this.q.length >= Math.max(2, this.size)) this.step();
  }
  after(fn: () => void) {
    const lastQ = this.q[this.q.length - 1];
    if (lastQ) (lastQ.after ??= []).push(fn);
    else fn();
  }
  flush() {
    while (this.q.length) this.step();
    this.prev = null;
    this.exitV2 = 0;
  }
  /** plan and run the oldest move with what the window can see */
  private step() {
    const q = this.q;
    let next2 = 0;
    for (let j = q.length - 1; j >= 1; j--) next2 = Math.min(q[j].maxStartV2, next2 + q[j].deltaV2, q[j].maxCruiseV2);
    const m = q[0];
    const start2 = Math.min(this.exitV2, m.maxCruiseV2);
    const end2 = Math.min(next2, start2 + m.deltaV2);
    const cruise2 = Math.max(start2, end2, Math.min(m.maxCruiseV2, (start2 + end2 + m.deltaV2) / 2));
    setJunction(m, start2, cruise2, end2);
    q.shift();
    this.exitV2 = end2;
    this.exec(m);
    if (m.after) for (const fn of m.after) fn();
  }
}

/** The accelerate, cruise and decelerate parts of a planned move: lengths (mm) and times (s). */
export function phases(m: PlanMove): { accelD: number; cruiseD: number; decelD: number; accelT: number; cruiseT: number; decelT: number } {
  const a = m.accel;
  const v0 = m.startV;
  const vc = m.cruiseV;
  const v1 = m.endV;
  const accelD = Math.max(0, (vc * vc - v0 * v0) / (2 * a));
  const decelD = Math.max(0, (vc * vc - v1 * v1) / (2 * a));
  const cruiseD = Math.max(0, m.dist - accelD - decelD);
  return {
    accelD,
    cruiseD,
    decelD,
    accelT: accelD > 0 ? accelD / ((v0 + vc) / 2) : 0,
    cruiseT: cruiseD / vc,
    decelT: decelD > 0 ? decelD / ((v1 + vc) / 2) : 0,
  };
}
