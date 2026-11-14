// Quasi-direct-drive robot actuators on CAN: the CubeMars AK series (AK70-10 and its kin) in their "MIT mode", the
// protocol MIT's Mini Cheetah drivers brought in. Each actuator has its own FOC driver; the controller sends it one
// 8-byte frame per control tick with a position, a speed, a stiffness, a damping and a feed-forward torque, packed
// into 16 + 12 + 12 + 12 + 12 bits over fixed ranges, and the driver runs
//   τ = kp (p_des − p) + kd (v_des − v) + τ_ff
// at its own rate until the next frame. It answers every frame with its position, speed and torque (16 + 12 + 12
// bits), its temperature and an error code. Three special frames switch it into motor mode (…FC), out of it (…FD)
// and set its zero (…FE). A bus is every actuator on one twisted pair, behind one transceiver on one of the
// controller's CAN ports: frames share the wire, so each takes its time at the bus rate.

import type { CatalogPart } from "../../machine/types";
import { Servo } from "./devices";

/** one CAN frame: an 11-bit identifier and up to 8 data bytes */
export interface CanFrame {
  id: number;
  len: number;
  buf: number[];
}

/** What hangs on a CAN port of the controller (a transceiver and the actuators behind it). */
export interface CanPeer {
  /** a frame the chip put on the bus, complete at t (seconds): the frames that answer it and how long after t each starts (seconds) */
  frame(f: CanFrame, t: number): { after: number; frame: CanFrame }[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** a float packed into an unsigned integer of `bits` bits over [lo, hi], as the MIT-mode code does it */
export const floatToUint = (x: number, lo: number, hi: number, bits: number) => Math.round(((clamp(x, lo, hi) - lo) * ((1 << bits) - 1)) / (hi - lo));
export const uintToFloat = (u: number, lo: number, hi: number, bits: number) => (u * (hi - lo)) / ((1 << bits) - 1) + lo;

/** bits of a standard 8-byte data frame on the wire, with typical bit stuffing and the 3-bit gap after it */
const FRAME_BITS = 125;

export class AkMotor extends Servo {
  /** its CAN id (set with CubeMars' tool; the design gives each its own) */
  id = 1;
  readonly pMax: number;
  readonly vMax: number;
  readonly tMax: number;
  readonly kpMax: number;
  readonly kdMax: number;
  /** output torque per amp of phase current, N·m/A */
  private ktOut: number;
  private rPhase: number;
  private iIdle: number;
  private tPeak: number;
  /** the rotor seen at the output, through the gearbox (J × ratio²), kg·m² */
  readonly rotorJ: number;
  /** torque it takes to back-drive it out of motor mode (gearbox and cogging), N·m */
  readonly dragNm: number;
  /** the driver's lowest supply, V: below it the actuator drops out of motor mode */
  readonly vMin: number;
  /** in motor mode, taking commands */
  enabled = false;
  /** the command it is holding: rad, rad/s, N·m/rad, N·m·s/rad, N·m (its own sense, from its zero) */
  pDes = 0;
  vDes = 0;
  kp = 0;
  kd = 0;
  tFf = 0;
  /** output angle from its zero (rad) and speed (rad/s), from the mechanism */
  pos = 0;
  vel = 0;
  /** torque it gave last step, N·m */
  torque = 0;
  /** the output's angle in the design pose, deg on the Servo scale (its zero is set there on a jig) */
  private zeroDeg: number;
  temp = 25;
  peakTemp = 25;
  volts = 0;
  /** frames it acted on, and commands it got while out of motor mode (ignored) */
  frames = 0;
  ignored = 0;
  /** it lost power while in motor mode: it comes back out of it */
  browned = false;
  private lastTick = 0;

  constructor(name: string, part: CatalogPart) {
    super(name, part);
    const s = part.specs;
    const n = (k: string, d: number) => (typeof s[k] === "number" ? (s[k] as number) : Number(s[k] ?? d) || d);
    this.pMax = n("p_max_rad", 12.5);
    this.vMax = n("v_max_rad_s", 50);
    this.tMax = n("t_max_nm", 25);
    this.kpMax = n("kp_max", 500);
    this.kdMax = n("kd_max", 5);
    this.tPeak = n("t_peak", 24800) / 1000;
    // the rated point gives the output's torque constant: 8.3 N·m at 7.2 A for the AK70-10
    this.ktOut = n("t_rated", 8300) / 1000 / n("i_rated", 7.2);
    this.rPhase = n("r_phase", 0.27);
    this.iIdle = n("i_idle", 0.12);
    this.rotorJ = n("rotor_inertia", 0) * n("ratio", 1) ** 2;
    this.dragNm = n("t_backdrive", 0.3);
    this.vMin = n("v_min", 18);
    this.zeroDeg = this.range / 2;
    this.angle = this.zeroDeg;
  }

  get tPeakNm() {
    return this.tPeak;
  }

  /** the impedance law's torque at the present state, N·m (what the mechanism applies as a stiff, damped row) */
  law(): number {
    if (!this.enabled) return 0;
    return clamp(this.kp * (this.pDes - this.pos) + this.kd * (this.vDes - this.vel) + this.tFf, -this.tPeak, this.tPeak);
  }

  /** what the mechanism needs each step: the command in the output's sense, or null when limp */
  command(): { p: number; v: number; kp: number; kd: number; t: number; tmax: number } | null {
    if (!this.enabled) return null;
    return { p: this.pDes, v: this.vDes, kp: this.kp, kd: this.kd, t: this.tFf, tmax: this.tPeak };
  }

  /** a mechanism runs it: never driven by a pulse */
  wanted(): number | null {
    return null;
  }

  /** the plant's step: its supply, and the heat in its windings */
  tick(dt: number, powered: boolean, volts: number) {
    this.volts = volts;
    if (!powered || volts < this.vMin) {
      if (this.enabled) this.browned = true;
      this.enabled = false;
      this.current = 0;
      return;
    }
    // supply current: the shaft's power and the copper's loss, over the bus volts, and the driver's own
    const iPh = Math.abs(this.torque) / this.ktOut;
    const pCu = 1.5 * iPh * iPh * this.rPhase;
    const pMech = this.torque * this.vel;
    this.current = Math.max(0, (pMech + pCu) / Math.max(1, volts)) + this.iIdle;
    // windings: about 1.2 K/W to the case, 6 min to settle
    const tEq = 25 + pCu * 1.2;
    this.temp += ((tEq - this.temp) * dt) / 360;
    if (this.temp > this.peakTemp) this.peakTemp = this.temp;
    this.lastTick += dt;
  }

  /** the angle (deg, Servo scale), speed (deg/s) and torque the mechanism gave */
  follow(_us: number | null, angle: number, torque: number, powered: boolean) {
    this.angle = angle;
    this.pos = (angle - this.zeroDeg) * (Math.PI / 180);
    this.torque = powered ? torque : 0;
  }

  /** a frame with this actuator's id: act on it and answer, or null for no answer */
  receive(f: CanFrame): CanFrame | null {
    // its driver is off without its supply: nothing answers
    if (this.volts < this.vMin) return null;
    const b = f.buf;
    if (f.len === 8 && b[0] === 0xff && b[1] === 0xff && b[2] === 0xff && b[3] === 0xff && b[4] === 0xff && b[5] === 0xff && b[6] === 0xff && b[7] >= 0xfc && b[7] <= 0xfe) {
      if (b[7] === 0xfc) {
        this.enabled = true;
        // it starts holding nothing: the first command sets the gains
        this.kp = this.kd = this.tFf = 0;
      } else if (b[7] === 0xfd) this.enabled = false;
      else this.zeroDeg = this.angle;
      this.frames++;
      return this.reply();
    }
    if (f.len !== 8) return null;
    if (!this.enabled) {
      this.ignored++;
      return this.reply();
    }
    const pInt = (b[0] << 8) | b[1];
    const vInt = (b[2] << 4) | (b[3] >> 4);
    const kpInt = ((b[3] & 0xf) << 8) | b[4];
    const kdInt = (b[5] << 4) | (b[6] >> 4);
    const tInt = ((b[6] & 0xf) << 8) | b[7];
    this.pDes = uintToFloat(pInt, -this.pMax, this.pMax, 16);
    this.vDes = uintToFloat(vInt, -this.vMax, this.vMax, 12);
    this.kp = uintToFloat(kpInt, 0, this.kpMax, 12);
    this.kd = uintToFloat(kdInt, 0, this.kdMax, 12);
    this.tFf = uintToFloat(tInt, -this.tMax, this.tMax, 12);
    this.frames++;
    return this.reply();
  }

  /** its answer: id, position (16 bits), speed (12), torque (12), temperature (°C + 40) and error code */
  private reply(): CanFrame {
    const p = floatToUint(this.pos, -this.pMax, this.pMax, 16);
    const v = floatToUint(this.vel, -this.vMax, this.vMax, 12);
    const t = floatToUint(this.torque, -this.tMax, this.tMax, 12);
    const err = this.temp > 80 ? 1 : 0;
    return { id: 0, len: 8, buf: [this.id, p >> 8, p & 0xff, v >> 4, ((v & 0xf) << 4) | (t >> 8), t & 0xff, clamp(Math.round(this.temp + 40), 0, 255), err] };
  }
}

/** The actuators on one CAN bus, as the controller's port sees them. */
export class AkBus implements CanPeer {
  motors: AkMotor[] = [];
  /** frames that went out with no actuator of that id on the bus */
  unanswered = 0;
  /** frames sent, and the time the wire was busy, s */
  sent = 0;
  busy = 0;
  constructor(
    public name: string,
    public baud = 1_000_000,
  ) {}
  /** how long one frame takes on the wire, s */
  frameTime(len: number) {
    return (FRAME_BITS - 8 * (8 - len)) / this.baud;
  }
  frame(f: CanFrame, _t: number) {
    this.sent++;
    this.busy += this.frameTime(f.len);
    const m = this.motors.find((x) => x.id === f.id);
    if (!m) {
      this.unanswered++;
      return [];
    }
    const r = m.receive(f);
    if (!r) return [];
    this.busy += this.frameTime(r.len);
    // the driver answers about 20 µs after the frame ends
    return [{ after: 20e-6, frame: r }];
  }
}
