// Smart servos on a one-wire serial bus (Feetech STS: Waveshare ST3215 and its
// kin). Each servo keeps a control table the controller reads and writes in
// packets; it runs its own motion profile to the goal it was given and reports
// where it is, how hard it is working, its voltage and its temperature. A bus
// is every servo behind one adapter, on one UART of the controller.

import type { CatalogPart } from "../../machine/types";
import { Servo } from "./devices";
import type { UartPeer } from "./hal";

const STEPS = 4096;
/** degrees per step */
const DEG = 360 / STEPS;

export const STS = { PING: 0x01, READ: 0x02, WRITE: 0x03, REG_WRITE: 0x04, ACTION: 0x05, SYNC_READ: 0x82, SYNC_WRITE: 0x83, BROADCAST: 0xfe } as const;

/** The control table's addresses (two-byte values low byte first). 0 to 39 are kept through a power cut, 40 on are not. */
export const REG = {
  ID: 5,
  BAUD: 6,
  MIN_ANGLE: 9,
  MAX_ANGLE: 11,
  MAX_TEMPERATURE: 13,
  MAX_TORQUE: 16,
  MODE: 33,
  PROTECT_TORQUE: 34,
  PROTECT_TIME: 35,
  OVERLOAD_TORQUE: 36,
  TORQUE_ENABLE: 40,
  ACC: 41,
  GOAL_POSITION: 42,
  GOAL_TIME: 44,
  GOAL_SPEED: 46,
  TORQUE_LIMIT: 48,
  LOCK: 55,
  PRESENT_POSITION: 56,
  PRESENT_SPEED: 58,
  PRESENT_LOAD: 60,
  PRESENT_VOLTAGE: 62,
  PRESENT_TEMPERATURE: 63,
  STATUS: 65,
  MOVING: 66,
  PRESENT_CURRENT: 69,
} as const;

/** status bits a servo sends back with every answer */
export const STS_ERR = { VOLTAGE: 0x01, OVERHEAT: 0x04, OVERLOAD: 0x20 } as const;

const TABLE = 72;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class BusServo extends Servo {
  id = 1;
  /** the control table */
  mem = new Uint8Array(TABLE);
  /** where the servo's own motion profile has got to (steps, not wrapped) and how fast it is moving (steps/s) */
  private set = STEPS / 2;
  private vel = 0;
  /** steps added to the horn's true position: set when the controller declares where it stands to be the middle */
  private offset = 0;
  private held: { addr: number; data: number[] } | null = null;
  /** torque on the horn (N·m, from the mechanism), volts at its plug, winding temperature (°C) */
  load = 0;
  volts = 0;
  temp = 25;
  peakTemp = 25;
  /** it gave up holding: over its overload torque for its protection time. Writing torque enable clears it. */
  overloaded = false;
  private overFor = 0;
  private live = false;
  private lastAngle = 180;
  private speedNow = 0;
  /** steps/s with no load */
  readonly maxSteps: number;
  private iIdle: number;
  /** packets it acted on */
  packets = 0;

  constructor(name: string, part: CatalogPart) {
    super(name, part);
    this.angle = 180;
    this.target = 180;
    this.maxSteps = this.speed / DEG;
    this.iIdle = typeof part.specs.i_idle === "number" ? part.specs.i_idle : 0.05;
    const m = this.mem;
    m[REG.ID] = 1;
    this.w16(REG.MIN_ANGLE, 0);
    this.w16(REG.MAX_ANGLE, STEPS - 1);
    m[REG.MAX_TEMPERATURE] = 70;
    this.w16(REG.MAX_TORQUE, 1000);
    m[REG.PROTECT_TORQUE] = 20;
    m[REG.PROTECT_TIME] = 200;
    m[REG.OVERLOAD_TORQUE] = 80;
  }

  r16(a: number): number {
    return this.mem[a] | (this.mem[a + 1] << 8);
  }
  private w16(a: number, v: number) {
    this.mem[a] = v & 255;
    this.mem[a + 1] = (v >> 8) & 255;
  }
  /** answers on the bus: it has power */
  get alive() {
    return this.live;
  }
  get torqueOn() {
    return this.live && this.mem[REG.TORQUE_ENABLE] === 1;
  }

  private powerOn() {
    const m = this.mem;
    m.fill(0, REG.TORQUE_ENABLE);
    this.set = this.angle / DEG + this.offset;
    this.vel = 0;
    this.w16(REG.GOAL_POSITION, clamp(Math.round(this.set), 0, STEPS - 1));
    this.w16(REG.TORQUE_LIMIT, this.r16(REG.MAX_TORQUE));
    this.overloaded = false;
    this.overFor = 0;
    this.held = null;
  }

  /** one step of the servo's own controller: its profile toward the goal, its protections and its heating */
  tick(dt: number, powered: boolean, volts: number) {
    this.volts = volts;
    if (!powered) {
      this.live = false;
      this.vel = 0;
      this.temp += ((25 - this.temp) * dt) / 200;
      return;
    }
    if (!this.live) {
      this.live = true;
      this.powerOn();
    }
    this.speedNow = dt > 0 ? (this.angle - this.lastAngle) / DEG / dt : 0;
    this.lastAngle = this.angle;
    // the motor's copper loss warms it: about 4.4 Ω, 10 °C/W to the air, a few minutes to settle
    this.temp += (dt * (25 + this.current * this.current * 44 - this.temp)) / 200;
    if (this.temp > this.peakTemp) this.peakTemp = this.temp;
    const m = this.mem;
    if (m[REG.TORQUE_ENABLE] !== 1) {
      this.set = this.angle / DEG + this.offset;
      this.vel = 0;
      this.overFor = 0;
      return;
    }
    // held past its overload torque for its protection time: it drops to its protection torque
    if (Math.abs(this.load) >= (m[REG.OVERLOAD_TORQUE] / 100) * this.tStall) {
      this.overFor += dt;
      if (this.overFor >= m[REG.PROTECT_TIME] / 100) this.overloaded = true;
    } else this.overFor = 0;
    const acc = m[REG.ACC] ? m[REG.ACC] * 100 : 1e7;
    const dv = acc * dt;
    if (m[REG.MODE] === 1) {
      // wheel mode: the goal speed is a speed to turn at, its top bit the direction
      const raw = this.r16(REG.GOAL_SPEED);
      const want = (raw & 0x8000 ? -1 : 1) * Math.min(raw & 0x7fff, this.maxSteps);
      this.vel += clamp(want - this.vel, -dv, dv);
      this.set += this.vel * dt;
      return;
    }
    const lo = this.r16(REG.MIN_ANGLE);
    const hi = this.r16(REG.MAX_ANGLE);
    let goal = this.r16(REG.GOAL_POSITION) & 0x7fff;
    if (hi > lo) goal = clamp(goal, lo, hi);
    const top = Math.min(this.maxSteps, this.r16(REG.GOAL_SPEED) & 0x7fff || this.maxSteps);
    const err = goal - this.set;
    const want = Math.sign(err) * Math.min(top, Math.sqrt(2 * acc * Math.abs(err)));
    this.vel += clamp(want - this.vel, -dv, dv);
    const step = this.vel * dt;
    if (Math.abs(err) < 0.5 || (Math.sign(step) === Math.sign(err) && Math.abs(step) >= Math.abs(err))) {
      this.set = goal;
      this.vel = 0;
    } else this.set += step;
  }

  /** the most torque it will give now, N·m */
  limit(): number {
    const share = Math.min(this.r16(REG.TORQUE_LIMIT), this.r16(REG.MAX_TORQUE), 1000) / 1000;
    return this.tStall * (this.overloaded ? Math.min(share, this.mem[REG.PROTECT_TORQUE] / 100) : share);
  }

  /** the angle its controller is steering to (deg; 180 is the middle of its turn), or null when it is limp */
  override wanted(_us: number | null): number | null {
    return this.torqueOn ? (this.set - this.offset) * DEG : null;
  }

  private amps(torque: number) {
    if (!this.live) return 0;
    if (this.mem[REG.TORQUE_ENABLE] !== 1) return this.iIdle;
    const share = Math.min(1, Math.abs(torque) / this.tStall);
    return this.iIdle + (Math.abs(this.vel) > 1 ? this.iRun : 0) + share * (this.iStall - this.iIdle);
  }

  override step(_us: number | null, load: number, powered: boolean, _dt: number) {
    // on a bench with no mechanism: the horn is where the profile is, unless the load is more than it can give
    this.load = load;
    if (powered && this.torqueOn && Math.abs(load) < this.limit()) this.angle = (this.set - this.offset) * DEG;
    this.current = powered ? this.amps(load) : 0;
  }

  override follow(_us: number | null, angle: number, torque: number, powered: boolean) {
    this.angle = angle;
    this.load = torque;
    this.target = (this.set - this.offset) * DEG;
    this.current = powered ? this.amps(torque) : 0;
  }

  private status(): number {
    return (this.overloaded ? STS_ERR.OVERLOAD : 0) | (this.temp > this.mem[REG.MAX_TEMPERATURE] ? STS_ERR.OVERHEAT : 0) | (this.volts < 6 ? STS_ERR.VOLTAGE : 0);
  }

  private refresh() {
    const m = this.mem;
    const pos = Math.round(this.angle / DEG + this.offset);
    this.w16(REG.PRESENT_POSITION, m[REG.MODE] === 1 ? ((pos % STEPS) + STEPS) % STEPS : clamp(pos, 0, STEPS - 1));
    const sp = Math.round(this.speedNow);
    this.w16(REG.PRESENT_SPEED, sp < 0 ? 0x8000 | Math.min(0x7fff, -sp) : Math.min(0x7fff, sp));
    const ld = Math.round(Math.min(1, Math.abs(this.load) / this.tStall) * 1000);
    this.w16(REG.PRESENT_LOAD, this.load < 0 ? 0x400 | ld : ld);
    m[REG.PRESENT_VOLTAGE] = clamp(Math.round(this.volts * 10), 0, 255);
    m[REG.PRESENT_TEMPERATURE] = clamp(Math.round(this.temp), 0, 255);
    m[REG.STATUS] = this.status();
    m[REG.MOVING] = Math.abs(this.speedNow) > 8 ? 1 : 0;
    this.w16(REG.PRESENT_CURRENT, Math.round(this.current / 0.0065));
  }

  private store(addr: number, data: number[]) {
    const m = this.mem;
    for (let i = 0; i < data.length; i++) {
      const a = addr + i;
      // what it measures cannot be written
      if (a < 0 || a >= REG.PRESENT_POSITION) {
        if (a !== REG.LOCK) continue;
      }
      const was = m[a];
      if (a === REG.TORQUE_ENABLE && (data[i] & 255) === 128) {
        // 128 to the torque switch: where the horn stands becomes the middle of its turn
        this.offset = STEPS / 2 - this.angle / DEG;
        this.set = STEPS / 2;
        this.w16(REG.GOAL_POSITION, STEPS / 2);
        m[a] = 0;
        continue;
      }
      m[a] = data[i] & 255;
      if (a === REG.ID) this.id = m[a];
      if (a === REG.MODE && was === 1 && m[a] !== 1) {
        // back from turning on and on: its encoder reads one turn, so the whole turns it made are forgotten
        this.offset -= Math.floor((this.angle / DEG + this.offset) / STEPS) * STEPS;
        this.set = this.angle / DEG + this.offset;
        this.vel = 0;
        this.w16(REG.GOAL_POSITION, clamp(Math.round(this.set), 0, STEPS - 1));
      }
      if (a === REG.TORQUE_ENABLE && m[a] === 1) {
        this.overloaded = false;
        this.overFor = 0;
        if (was !== 1) {
          // it takes hold where it stands
          this.set = this.angle / DEG + this.offset;
          this.vel = 0;
          if (addr + data.length <= REG.GOAL_POSITION) this.w16(REG.GOAL_POSITION, clamp(Math.round(this.set), 0, STEPS - 1));
        }
      }
    }
  }

  /** one instruction for this servo: the parameters of its answer */
  handle(inst: number, p: number[]): { err: number; data: number[] } | null {
    if (!this.live) return null;
    this.packets++;
    switch (inst) {
      case STS.PING:
        return { err: this.status(), data: [] };
      case STS.READ: {
        this.refresh();
        const a = p[0] ?? 0;
        const n = p[1] ?? 0;
        const data: number[] = [];
        for (let i = 0; i < n; i++) data.push(a + i < TABLE ? this.mem[a + i] : 0);
        return { err: this.status(), data };
      }
      case STS.WRITE:
        this.store(p[0] ?? 0, p.slice(1));
        return { err: this.status(), data: [] };
      case STS.REG_WRITE:
        this.held = { addr: p[0] ?? 0, data: p.slice(1) };
        return { err: this.status(), data: [] };
      case STS.ACTION:
        if (this.held) this.store(this.held.addr, this.held.data);
        this.held = null;
        return { err: this.status(), data: [] };
      default:
        return null;
    }
  }
}

function packet(id: number, err: number, data: number[]): number[] {
  const body = [id, data.length + 2, err, ...data];
  let sum = 0;
  for (const b of body) sum += b;
  return [0xff, 0xff, ...body, ~sum & 255];
}

/** Every servo behind one bus adapter: it frames the bytes the controller sends into packets and answers for its servos. */
export class ServoBus implements UartPeer {
  servos: BusServo[] = [];
  /** packets that arrived whole, and ones dropped for a bad checksum or length */
  packets = 0;
  bad = 0;
  /** seconds from the end of a request to the first byte of its answer */
  delay = 0.0002;
  private buf: number[] = [];
  constructor(public name: string) {}

  byte(b: number, _t: number): { after: number; bytes: number[] } | null {
    const q = this.buf;
    q.push(b & 255);
    for (;;) {
      while (q.length && q[0] !== 0xff) q.shift();
      if (q.length < 2) return null;
      if (q[1] !== 0xff) {
        q.shift();
        continue;
      }
      if (q.length < 4) return null;
      if (q[2] === 0xff) {
        q.shift();
        continue;
      }
      const len = q[3];
      if (len < 2 || len > 150) {
        q.splice(0, 2);
        this.bad++;
        continue;
      }
      if (q.length < 4 + len) return null;
      const pkt = q.splice(0, 4 + len);
      let sum = 0;
      for (let i = 2; i < pkt.length - 1; i++) sum += pkt[i];
      if ((~sum & 255) !== pkt[pkt.length - 1]) {
        this.bad++;
        return null;
      }
      this.packets++;
      const out = this.run(pkt[2], pkt[4], pkt.slice(5, -1));
      return out.length ? { after: this.delay, bytes: out } : null;
    }
  }

  private run(id: number, inst: number, p: number[]): number[] {
    const byId = (i: number) => this.servos.find((s) => s.id === i && s.alive);
    if (inst === STS.SYNC_WRITE) {
      const addr = p[0] ?? 0;
      const n = p[1] ?? 0;
      for (let i = 2; i + n < p.length; i += n + 1) byId(p[i])?.handle(STS.WRITE, [addr, ...p.slice(i + 1, i + 1 + n)]);
      return [];
    }
    if (inst === STS.SYNC_READ) {
      // each servo named answers in turn
      const out: number[] = [];
      for (const i of p.slice(2)) {
        const r = byId(i)?.handle(STS.READ, [p[0] ?? 0, p[1] ?? 0]);
        if (r) out.push(...packet(i, r.err, r.data));
      }
      return out;
    }
    if (id === STS.BROADCAST) {
      // everyone acts, nobody answers
      for (const s of this.servos) s.handle(inst, p);
      return [];
    }
    const r = byId(id)?.handle(inst, p);
    return r ? packet(id, r.err, r.data) : [];
  }
}
