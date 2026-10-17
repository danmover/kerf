// Heaters as each firmware runs them. The hotend and bed are heated masses
// that lose heat to the room (more with the part fan blowing), with the
// thermistor lagging behind; melting filament takes heat too. On top sits the
// firmware's own controller and safety checks:
//   Klipper: PID per 255 of output (heaters.py ControlPID), sampled every
//     0.3 s, and [verify_heater] (max_error, check_gain_time, hysteresis).
//   Marlin: PID inside PID_FUNCTIONAL_RANGE and full power or off outside it,
//     THERMAL_PROTECTION (period, hysteresis) and WATCH_TEMP when heating.
//   RepRapFirmware: model-based PID from M307 (heating rate, cooling rate,
//     dead time) and M570 fault detection.

import type { HeaterSafety, HeaterSetup } from "./config";
import type { PrinterFlavor } from "../../machine/firmware/printer";
import type { HeaterPhys } from "./machine";

export interface HeaterEnv {
  ambient: number;
  /** multiplies the heater's power (cartridge tolerance, supply voltage) */
  power: number;
  /** multiplies its loss to the room (draughts, a missing silicone sock) */
  loss: number;
}

/** A firmware stopping because of a heater. */
export interface HeaterFault {
  heater: string;
  msg: string;
}

const PERIOD: Record<PrinterFlavor, number> = { klipper: 0.3, marlin: 0.164, reprapfirmware: 0.25 };

export class HeaterSim {
  /** heated mass and thermistor, °C */
  T: number;
  sensor: number;
  target = 0;
  /** output, 0..1 */
  duty = 0;
  fault: HeaterFault | null = null;
  /** the most it has read above its target since the target last changed, °C */
  overshoot = 0;
  /** energy into the heater, J */
  energy = 0;
  private ctrlTimer = 0;
  private safeTimer = 0;
  // Klipper PID
  private prevT = 0;
  private prevDeriv = 0;
  private integ = 0;
  private smoothed: number;
  // Marlin
  private dState = 0;
  private kdTerm = 0;
  private pidReset = true;
  private tr = { state: "off" as "off" | "first" | "stable", target: 0, timer: 0 };
  private watch = { target: 0, until: 0 };
  // Klipper verify_heater
  private vh = { approaching: false, starting: false, error: 0, goalTemp: 0, goalTime: 0, lastTarget: 0 };
  // RepRapFirmware
  private rrfMode: "off" | "heating" | "stable" = "off";
  private rrfCount = 0;
  private rrfSetAt = 0;
  private rrfLast = 0;
  // Marlin and RRF wait residency
  private settledSince = -1;
  private bangOn = false;

  constructor(
    readonly phys: HeaterPhys,
    readonly setup: HeaterSetup,
    readonly safety: HeaterSafety,
    readonly flavor: PrinterFlavor,
    readonly env: HeaterEnv,
    private wait: { window: number; residency: number },
  ) {
    this.T = env.ambient;
    this.sensor = env.ambient;
    this.smoothed = env.ambient;
    this.prevT = env.ambient;
    this.dState = env.ambient;
  }

  setTarget(t: number, now: number) {
    const v = Math.max(0, t);
    if (v === this.target) return;
    this.target = v;
    this.overshoot = 0;
    this.settledSince = -1;
    if (this.flavor === "marlin") {
      // WATCH_TEMP: when heating from well below, it must gain watchIncrease within watchPeriod
      const s = this.safety;
      if (s.kind === "marlin" && v > 0 && this.sensor < v - (s.watchIncrease + 3 + 1)) this.watch = { target: this.sensor + s.watchIncrease, until: now + s.watchPeriod };
      else this.watch = { target: 0, until: 0 };
    }
    if (this.flavor === "reprapfirmware") {
      this.rrfMode = v > 0 ? "heating" : "off";
      this.rrfSetAt = now;
      this.rrfCount = 0;
    }
  }

  /** advance the physics by dt with the part fan at `fan` (0..1) and `flowW` watts going into melting filament */
  step(dt: number, now: number, fan: number, flowW: number) {
    const p = this.phys;
    const heat = this.fault ? 0 : this.duty * p.power * this.env.power;
    this.energy += heat * dt;
    const loss = (p.loss + p.lossFan * fan) * this.env.loss;
    this.T += ((heat - loss * (this.T - this.env.ambient) - flowW) / p.capacity) * dt;
    this.sensor += (this.T - this.sensor) * Math.min(1, dt / p.lag);
    if (this.target > 0) this.overshoot = Math.max(this.overshoot, this.sensor - this.target);
    if (this.fault) {
      this.duty = 0;
      return;
    }
    this.ctrlTimer -= dt;
    if (this.ctrlTimer <= 0) {
      const period = PERIOD[this.flavor];
      this.ctrlTimer += period;
      this.control(period, now);
    }
    this.safeTimer -= dt;
    if (this.safeTimer <= 0) {
      this.safeTimer += 1;
      this.check(now);
    }
    // waits: inside the window long enough
    if (this.target > 0 && Math.abs(this.sensor - this.target) <= this.wait.window) {
      if (this.settledSince < 0) this.settledSince = now;
    } else if (this.target > 0 && Math.abs(this.sensor - this.target) > this.wait.window + 3) this.settledSince = -1;
  }

  /** the firmware would still be waiting for this heater (M109, M190, M116) */
  busy(now: number): boolean {
    if (this.target <= 0 || this.fault) return false;
    if (this.flavor === "klipper") {
      if (this.setup.control === "bangbang") return this.smoothed < this.target - 2;
      return Math.abs(this.target - this.smoothed) > 1 || Math.abs(this.prevDeriv) > 0.1;
    }
    if (this.flavor === "marlin") return this.settledSince < 0 || now - this.settledSince < this.wait.residency;
    return Math.abs(this.sensor - this.target) > 1;
  }

  /** what the firmware reports as the temperature */
  get reading(): number {
    return this.flavor === "klipper" ? this.smoothed : this.sensor;
  }

  private control(dt: number, now: number) {
    const s = this.setup;
    const temp = this.sensor;
    const target = this.target;
    if (this.flavor === "klipper") {
      // heaters.py: smoothed temperature for waits and checks
      this.smoothed += (temp - this.smoothed) * Math.min(dt / Math.max(s.smooth, 1e-3), 1);
      if (target <= 0) {
        this.duty = 0;
      } else if (s.control === "bangbang") {
        if (this.bangOn && temp >= target + 2) this.bangOn = false;
        else if (!this.bangOn && temp <= target - 2) this.bangOn = true;
        this.duty = this.bangOn ? s.maxPower : 0;
      } else {
        const kp = s.kp / 255;
        const ki = s.ki / 255;
        const kd = s.kd / 255;
        const minDeriv = s.smooth;
        const tdiff = temp - this.prevT;
        const deriv = dt >= minDeriv ? tdiff / dt : (this.prevDeriv * (minDeriv - dt) + tdiff) / minDeriv;
        const err = target - temp;
        const integMax = ki ? s.maxPower / ki : 0;
        const integ = Math.max(0, Math.min(integMax, this.integ + err * dt));
        const co = kp * err + ki * integ - kd * deriv;
        const bounded = Math.max(0, Math.min(s.maxPower, co));
        this.duty = bounded;
        this.prevDeriv = deriv;
        if (co === bounded) this.integ = integ;
      }
      this.prevT = temp;
      return;
    }
    if (this.flavor === "marlin") {
      if (s.control === "bangbang") {
        // BED_CHECK_INTERVAL bang-bang with BED_HYSTERESIS
        if (target <= 0) this.duty = 0;
        else if (temp > target + 2) this.duty = 0;
        else if (temp < target - 2) this.duty = s.maxPower;
        this.dState = temp;
        return;
      }
      const err = target - temp;
      const range = 10;
      let out: number;
      if (target <= 0 || err < -range) {
        out = 0;
        this.pidReset = true;
      } else if (err > range) {
        out = 255 * s.maxPower;
        this.pidReset = true;
      } else {
        if (this.pidReset) {
          this.integ = 0;
          this.kdTerm = 0;
          this.pidReset = false;
        }
        // Marlin keeps Ki and Kd in per-sample units
        const ki = s.ki * dt;
        const kd = s.kd / dt;
        this.kdTerm += 0.05 * (kd * (this.dState - temp) - this.kdTerm);
        this.integ = Math.max(0, Math.min((255 * s.maxPower) / Math.max(ki, 1e-9), this.integ + err));
        out = s.kp * err + ki * this.integ + this.kdTerm;
        out = Math.max(0, Math.min(255 * s.maxPower, out));
      }
      this.dState = temp;
      this.duty = out / 255;
      return;
    }
    // RepRapFirmware: PID worked out from the heater model
    const m = s.model ?? { r: (this.phys.power / this.phys.capacity) * 0.9, k: (this.phys.loss * 100) / this.phys.capacity, kFan: 0, d: this.phys.lag * 2 };
    if (target <= 0) {
      this.duty = 0;
      this.integ = 0;
      this.rrfLast = temp;
      return;
    }
    const tau = 100 / Math.max(m.k, 1e-6);
    const gain = (m.r * tau) / Math.max(s.maxPower, 1e-6);
    const frac = m.d / tau;
    const heating = this.rrfMode === "heating";
    const kP = 0.7 / (gain * frac);
    const recipTi = heating ? 1 / Math.sqrt(tau * m.d) : 1 / (1.14 * tau ** 0.25 * m.d ** 0.75);
    const tD = m.d * 0.7;
    const err = target - temp;
    const deriv = (temp - this.rrfLast) / dt;
    this.rrfLast = temp;
    this.integ = Math.max(0, Math.min(s.maxPower, this.integ + err * kP * recipTi * dt));
    const pd = kP * (err - tD * deriv);
    let out = pd + this.integ;
    if (out > s.maxPower) {
      out = s.maxPower;
      // RRF stops the integral winding up past full power
      this.integ = Math.max(0, out - pd);
    }
    this.duty = Math.max(0, out);
    void now;
  }

  /** each firmware's own heater safety, once a second */
  private check(now: number) {
    const s = this.safety;
    const temp = this.sensor;
    const name = this.setup.name;
    if (temp > this.setup.maxTemp) {
      this.trip(
        this.flavor === "klipper"
          ? `MCU shutdown: ADC out of range (${name} read ${temp.toFixed(1)} °C, above its max_temp of ${this.setup.maxTemp} °C)`
          : this.flavor === "marlin"
            ? `Error:MAXTEMP triggered, system stopped! Heater_ID: ${this.setup.role === "bed" ? "bed" : 0}`
            : `Error: ${name} fault: temperature limit of ${this.setup.maxTemp} °C exceeded`,
      );
      return;
    }
    if (s.kind === "klipper") {
      const v = this.vh;
      const target = this.target;
      const t = this.smoothed;
      if (t >= target - s.hysteresis || target <= 0) {
        v.approaching = v.starting = false;
        if (t <= target + s.hysteresis) v.error = 0;
        v.lastTarget = target;
        return;
      }
      v.error += target - s.hysteresis - t;
      if (!v.approaching) {
        if (target !== v.lastTarget) {
          v.approaching = v.starting = true;
          v.goalTemp = t + s.heatingGain;
          v.goalTime = now + s.checkGainTime;
        } else if (v.error >= s.maxError) {
          this.trip(`Heater ${name} not heating at expected rate`);
          return;
        }
      } else if (t >= v.goalTemp) {
        v.starting = false;
        v.error = 0;
        v.goalTemp = t + s.heatingGain;
        v.goalTime = now + s.checkGainTime;
      } else if (now >= v.goalTime) v.approaching = false;
      else if (v.starting) v.goalTemp = Math.min(v.goalTemp, t + s.heatingGain);
      v.lastTarget = target;
      return;
    }
    if (s.kind === "marlin") {
      if (!s.on) return;
      const tr = this.tr;
      const id = this.setup.role === "bed" ? "bed" : "0";
      if (tr.target !== this.target) {
        tr.target = this.target;
        tr.state = this.target > 0 ? "first" : "off";
      }
      if (tr.state === "first" && temp >= tr.target) tr.state = "stable";
      if (tr.state === "stable") {
        if (temp >= tr.target - s.hysteresis) tr.timer = now + s.period;
        else if (now >= tr.timer) {
          this.trip(`Error:Thermal Runaway, system stopped! Heater_ID: ${id}`);
          return;
        }
      }
      if (this.watch.until && now >= this.watch.until) {
        if (temp < this.watch.target) {
          this.trip(`Error:Heating failed, system stopped! Heater_ID: ${id}`);
          return;
        }
        // still heating: watch the next step
        if (temp < this.target - (s.watchIncrease + 4)) this.watch = { target: temp + s.watchIncrease, until: now + s.watchPeriod };
        else this.watch = { target: 0, until: 0 };
      }
      return;
    }
    // RepRapFirmware: too slow while heating, or too far off once stable
    const m = this.setup.model;
    const err = this.target - temp;
    if (this.rrfMode === "heating") {
      if (err <= 1) {
        this.rrfMode = "stable";
        this.rrfCount = 0;
      } else if (m && now - this.rrfSetAt > m.d * 2) {
        const expected = m.r * this.duty - m.k * Math.max(0, temp - this.env.ambient) / 100;
        const rate = this.lastRate(temp);
        if (expected > 0.2 && rate < expected * 0.25) {
          this.rrfCount++;
          if (this.rrfCount > s.time) this.trip(`Error: ${name} fault: temperature rising much more slowly than the expected ${expected.toFixed(1)} °C/s`);
        } else this.rrfCount = 0;
      }
    } else if (this.rrfMode === "stable") {
      if (Math.abs(err) > s.excursion && temp > 45) {
        this.rrfCount++;
        if (this.rrfCount > s.time) this.trip(`Error: ${name} fault: temperature excursion exceeded ${s.excursion.toFixed(1)} °C for more than ${s.time.toFixed(1)} seconds`);
      } else if (this.rrfCount) this.rrfCount--;
    }
  }

  private rateRef = { t: NaN };
  /** temperature change over the last second, °C/s */
  private lastRate(temp: number): number {
    const prev = this.rateRef.t;
    this.rateRef.t = temp;
    return Number.isFinite(prev) ? temp - prev : Infinity;
  }

  private trip(msg: string) {
    this.fault = { heater: this.setup.name, msg };
    this.duty = 0;
  }
}
