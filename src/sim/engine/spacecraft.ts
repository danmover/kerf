// Spacecraft models for CubeSat flight boards: the catalog parts with specs.space_dev. The electrical power system
// (EPS) takes the battery bus and feeds the 3.3 V and 5 V buses and six switched outputs, which the flight computer
// turns on and off over I2C, and its solar inputs charge the battery from the panels the sun falls on. The attitude
// system (ADCS) detumbles the satellite after separation and points it (at the sun, at the ground or with its patch
// antenna down); the radios, the antenna system and the imager answer their commands and draw what the real boards
// draw in each state; each burn-wire hold-down melts its line after a few seconds of current, which frees its wings
// to swing open on their spring hinges, and the hinge switch beside it lets go. The orbit (sim.orbit(...)) gives the
// sun: eclipse, and the angle it makes with each panel in the attitude the ADCS holds.
//
// The flight computer reaches every board through the plant's I2C bus and its UART, so the signals view shows each
// transaction. The protocols follow the boards' published command sets in a reduced form (see each device below).

import { catalogPart } from "../../machine/catalog";
import type { Net } from "../../machine/erc";
import type { CatalogPart, MachineComponent } from "../../machine/types";
import { Regulator } from "./devices";
import type { I2CDevice } from "./hal";
import type { Plant } from "./plant";

type V3 = [number, number, number];

/** A circular, sun-synchronous orbit for sim.orbit(...). */
export interface OrbitSpec {
  /** altitude, km */
  alt: number;
  /** local time of the ascending node, hours (10.5 is 10:30) */
  ltan: number;
  /** the sun's declination, degrees: 0 at the equinoxes, 23.44 at the June solstice */
  decl: number;
  /** where the run starts, degrees round the orbit from the point nearest the sun */
  start: number;
  /** body rates at separation, deg/s */
  tipoff: number;
  /** the satellite's moment of inertia about its tumble axis, kg·m² */
  inertia: number;
  /** the body axis the open wings' cells face */
  wings: V3;
  /** the wings are already open (a later orbit) */
  deployed: boolean;
}

const MU = 398600.4418;
const RE = 6378.137;
const SUN_W_M2 = 1361;
const D2R = Math.PI / 180;

const num = (part: CatalogPart, k: string, d: number) => {
  const v = Number(part.specs[k]);
  return Number.isFinite(v) ? v : d;
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** turn v about the unit axis k by a radians */
function turn(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const d = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}

/** The orbit's sun geometry: period, beta angle and eclipse. */
export function orbitGeometry(o: OrbitSpec) {
  const a = RE + o.alt;
  const period = 2 * Math.PI * Math.sqrt((a * a * a) / MU);
  // sun-synchronous: the inclination that turns the orbit's plane once a year
  const incl = Math.acos(Math.max(-1, -Math.pow(a / 12352.5, 3.5)));
  const node = (o.ltan - 12) * 15 * D2R;
  const beta = Math.asin(Math.cos(o.decl * D2R) * Math.sin(incl) * Math.sin(node) + Math.sin(o.decl * D2R) * Math.cos(incl));
  const rho = RE / a;
  // the share of each orbit in Earth's shadow (a cylinder behind it)
  const x = Math.sqrt(1 - rho * rho) / Math.cos(beta);
  const eclipse = x >= 1 ? 0 : Math.acos(x) / Math.PI;
  return { a, period, incl: incl / D2R, beta: beta / D2R, eclipse, rho };
}

/** One switched output or bus of the EPS: a converter from the battery bus, on while its switch is. */
class EpsRail extends Regulator {
  constructor(
    name: string,
    part: CatalogPart,
    v: number,
    imax: number,
    public on: () => boolean,
    /** current its loads draw beyond their standing draw (a radio transmitting, a burn resistor), A */
    public extra: () => number,
  ) {
    super(name, part);
    this.vout = v;
    this.eff = 0.92;
    this.vinMin = 6.5;
    this.imax = imax;
  }
  out(vin: number) {
    return this.on() && vin >= this.vinMin ? this.vout : 0;
  }
  inputCurrent(vin: number) {
    if (vin <= 0.5) return 0;
    const vo = this.out(vin);
    return (vo * (this.load + (vo > 0 ? this.extra() : 0))) / (this.eff * vin);
  }
}

interface Panel {
  comp: string;
  cells: number;
  /** watts per cell in full sun, at its working temperature */
  wCell: number;
  /** cells-out direction in the body, stowed */
  n: V3;
  at: V3;
  deployable: boolean;
}

interface Burn {
  comp: string;
  burn?: Net;
  ohm: number;
  burnS: number;
  heat: number;
  cutAt: number;
  at: V3;
  /** the wings it holds and the hinge switches it frees */
  wings: Panel[];
  sense: { comp: string; pin: number }[];
  /** the wings' angle, degrees from stowed, and rate, deg/s */
  angle: number;
  rate: number;
  openAt: number;
}

/** The spacecraft on one plant: shared state for its boards. */
class Craft {
  orbit?: OrbitSpec;
  geo?: ReturnType<typeof orbitGeometry>;
  /** sun direction in the body */
  sun: V3 = unit([0.3, 0.55, 0.78]);
  /** body rates, deg/s */
  w: V3 = [0, 0, 0];
  panels: Panel[] = [];
  burns: Burn[] = [];
  /** EPS output switches, OUT1..OUT6 */
  outs = [false, false, false, false, false, false];
  /** extra current on each EPS rail (by net id), A */
  extraOn = new Map<number, () => number>();
  battery?: { name: string };
  // ADCS
  adcsRun = false;
  ctrlMode = 0;
  target = 0;
  adcsPowered = () => false;
  adcsW = 0;
  slewMax = 2;
  // radios
  uhfTxOn = false;
  uhfBusyUntil = 0;
  uhfPowered = () => false;
  sbandOn = false;
  sbandPowered = () => false;
  antsArmed = false;
  antsDeploying = -1;
  antsBurnS = 4;
  antsDone = 0;
  antsStart = 0;
  antsPowered = () => false;
  cameraImaging = 0;
  cameraPowered = () => false;
  // what happened
  sunlit = true;
  solarW = 0;
  harvestW = 0;
  loadW = 0;
  minSoc = Infinity;
  socStart = -1;
  solarWh = 0;
  loadWh = 0;
  eclipseS = 0;
  beacons = 0;
  firstBeacon = -1;
  detumbledAt = -1;
  antennaAt = -1;
  images = 0;
  downlinkS = 0;
  peakRate = 0;
  epsW = 0.16;
  now = 0;

  get uhfTx() {
    return this.uhfBusyUntil > this.now;
  }

  sunAt(t: number): { v: V3; lit: boolean; r: V3; h: V3 } {
    // the orbit's own frame: x toward the point nearest the sun, z along the orbit's normal; the sun is at beta out of
    // the plane
    if (!this.orbit || !this.geo) return { v: this.sun, lit: true, r: [0, 0, 1] as V3, h: [1, 0, 0] as V3 };
    const g = this.geo;
    const u = this.orbit.start * D2R + (2 * Math.PI * t) / g.period;
    const b = g.beta * D2R;
    const r: V3 = [Math.cos(u), Math.sin(u), 0];
    const h: V3 = [0, 0, 1];
    const v: V3 = [Math.cos(b), 0, Math.sin(b)];
    const sr = dot(v, r);
    const lit = !(sr < 0 && Math.sqrt(Math.max(0, 1 - sr * sr)) < g.rho);
    return { v, lit, r, h };
  }

  tick(p: Plant, dt: number, t: number) {
    this.now = t;
    const s = this.sunAt(t);
    this.sunlit = s.lit;
    if (!s.lit) this.eclipseS += dt;
    // attitude: tumbling, detumbling with the torquers, or held by the wheels
    const rate = len(this.w);
    if (rate > this.peakRate) this.peakRate = rate;
    const on = this.adcsPowered() && this.adcsRun;
    const geo = this.geo;
    if (on && this.ctrlMode === 1 && geo && this.orbit) {
      // B-dot: the torquers' dipole against the field's turning, about two thirds effective on average
      const alpha = ((2 / 3) * 0.24 * fieldT(geo)) / this.orbit.inertia / D2R;
      const k = Math.max(0, 1 - (alpha * dt) / Math.max(rate, 1e-6));
      this.w = this.w.map((x) => x * k) as V3;
    } else if (on && this.ctrlMode >= 5 && this.orbit) {
      // the wheels: first null the rates, then slew to the target at their momentum limit
      const alpha = (0.23e-3 / this.orbit.inertia) / D2R;
      if (rate > 0.05) this.w = this.w.map((x) => x * Math.max(0, 1 - (alpha * dt) / rate)) as V3;
      const want = heldSun(this, t, this.target);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(this.sun, want))));
      const step = Math.min(ang, this.slewMax * D2R * dt);
      if (ang > 1e-6) {
        const ax = cross(this.sun, want);
        this.sun = len(ax) > 1e-9 ? unit(turn(this.sun, unit(ax), step)) : want;
      }
      this.adcsW = ang > 0.002 ? this.slewMax : rate;
    }
    if (!(on && this.ctrlMode >= 5)) {
      // a free body: the sun turns the other way round the body's rate
      if (rate > 1e-6) this.sun = unit(turn(this.sun, unit(this.w), -rate * D2R * dt));
      this.adcsW = rate;
    }
    if (this.detumbledAt < 0 && this.orbit && rate < 0.5 && t > 1) this.detumbledAt = t;

    // the burn wires, the wings and their hinge switches
    for (const b of this.burns) {
      const v = p.netV.get(b.burn?.id ?? -1) ?? 0;
      if (b.cutAt < 0 && v > 3) {
        b.heat += dt * Math.min(1.5, (v / 5) ** 2);
        if (b.heat >= b.burnS) {
          b.cutAt = t;
          p.events.push({ t, kind: "info", text: `${b.comp}: the hold-down line melted through after ${b.heat.toFixed(1)} s of burning` });
          for (const sw of b.sense) p.hal.setExternal(sw.pin, -1);
        }
      }
      if (b.cutAt >= 0 && b.angle < 90) {
        // the hinge springs swing both wings out (no gravity): about 25 N·mm on panels of 0.3 kg 41 to 123 mm out
        const inertia = b.wings.reduce((a, w, i) => a + 0.15 * ((0.082 * 0.082) / 12 + (0.041 * (1 + 2 * (i % 2))) ** 2), 0) || 0.0027;
        b.rate += ((0.025 / inertia) / D2R) * dt;
        b.angle = Math.min(90, b.angle + b.rate * dt);
        if (b.angle >= 90) {
          b.openAt = t;
          p.events.push({ t, kind: "info", text: `${b.wings.map((w) => w.comp).join(" and ")} open and latched, ${((t - b.cutAt) * 1000).toFixed(0)} ms after the line let go` });
        }
      }
    }

    // the sun on each panel
    let solar = 0;
    if (s.lit) {
      const open = (w: Panel) => this.burns.some((b) => b.wings.includes(w) && b.angle >= 90) || (this.orbit?.deployed ?? false);
      const covered = (pn: Panel) => {
        // a stowed panel under another on the same face sees nothing; a wing lying cells-in sees nothing
        if (pn.deployable) return !open(pn) && (dot(pn.n, pn.at) < 0 || this.panels.some((o) => o !== pn && o.deployable && !open(o) && dot(o.at, pn.n) > dot(pn.at, pn.n) + 0.5));
        return this.panels.some((o) => o !== pn && o.deployable && !open(o) && dot(o.at, pn.n) > dot(pn.at, pn.n) + 0.5);
      };
      for (const pn of this.panels) {
        if (covered(pn)) continue;
        const n = pn.deployable && open(pn) ? (this.orbit?.wings ?? pn.n) : pn.n;
        const c = dot(n, this.sun);
        if (c > 0) solar += pn.cells * pn.wCell * c;
      }
    }
    this.solarW = solar;
    // the battery: the plant has taken the loads out of it; the solar inputs put back what the MPPT converters make,
    // up to the EPS's limit, and no more than the charger takes once it is full
    const bat = p.batteries[0]?.b;
    if (bat) {
      if (this.socStart < 0) this.socStart = bat.soc;
      const vb = Math.max(1, bat.volts());
      let harvest = Math.min(solar * 0.9, 30);
      const load = bat.current * vb;
      if (bat.soc >= 0.995) harvest = Math.min(harvest, Math.max(0, load));
      const ich = harvest / vb;
      bat.soc = Math.min(1, bat.soc + (ich * dt) / (3600 * bat.capAh));
      bat.ah -= (ich * dt) / 3600;
      bat.current -= ich;
      this.harvestW = harvest;
      this.loadW = load;
      this.solarWh += (harvest * dt) / 3600;
      this.loadWh += (Math.max(0, load) * dt) / 3600;
      if (bat.soc < this.minSoc) this.minSoc = bat.soc;
    }
      if (this.sbandOn && this.sbandPowered()) this.downlinkS += dt;
    // the antenna system's burn sequence: one element after another
    if (this.antsDeploying >= 0 && this.antsPowered()) {
      if (t - this.antsStart >= this.antsBurnS) {
        this.antsDone |= 1 << this.antsDeploying;
        p.events.push({ t, kind: "info", text: `UHF antenna element ${this.antsDeploying + 1} deployed` });
        this.antsDeploying = this.antsDeploying < 3 ? this.antsDeploying + 1 : -1;
        this.antsStart = t;
        if (this.antsDeploying < 0 && this.antennaAt < 0) this.antennaAt = t;
      }
    }
  }

  channels(out: Record<string, number>) {
    out["orbit.sunlit"] = this.sunlit ? 1 : 0;
    out["eps.solar_watts"] = this.harvestW;
    out["eps.load_watts"] = this.loadW;
    out["adcs.rate"] = this.adcsW;
    out["adcs.mode"] = this.adcsRun ? this.ctrlMode : 0;
    for (const b of this.burns) out[`${b.comp}.wing_angle`] = b.angle;
    out["uhf.transmitting"] = this.uhfTx ? 1 : 0;
    out["sband.transmitting"] = this.sbandOn && this.sbandPowered() ? 1 : 0;
    out["camera.imaging"] = this.cameraImaging > 0 ? 1 : 0;
    for (let i = 0; i < 6; i++) out[`eps.out${i + 1}`] = this.outs[i] ? 1 : 0;
  }

  results(p: Plant): Record<string, number | boolean | string> {
    const r: Record<string, number | boolean | string> = {
      beacons: this.beacons,
      first_beacon: this.firstBeacon,
      detumbled_at: this.detumbledAt,
      antenna_deployed_at: this.antennaAt,
      peak_rate: this.peakRate,
      images: this.images,
      downlink_time: this.downlinkS,
      solar_wh: this.solarWh,
      load_wh: this.loadWh,
      eclipse_time: this.eclipseS,
      min_soc: Number.isFinite(this.minSoc) ? this.minSoc : 0,
      soc_start: Math.max(0, this.socStart),
    };
    const bat = p.batteries[0]?.b;
    if (bat) r.soc_end = bat.soc;
    if (this.geo) {
      r.orbit_period = this.geo.period;
      r.beta_angle = this.geo.beta;
    }
    for (const b of this.burns) {
      r[`${b.comp}.released_at`] = b.cutAt;
      r[`${b.comp}.open_at`] = b.openAt;
    }
    const opens = this.burns.map((b) => b.openAt);
    r.wings_open_at = opens.length && opens.every((x) => x >= 0) ? Math.max(...opens) : -1;
    return r;
  }
}

const crafts = new WeakMap<Plant, Craft>();

function craftOf(p: Plant): Craft {
  let c = crafts.get(p);
  if (c) return c;
  c = new Craft();
  crafts.set(p, c);
  const craft = c;
  const o = p.world.orbit?.();
  if (o) {
    craft.orbit = o;
    craft.geo = orbitGeometry(o);
    const g = craft.geo;
    p.assumptions.push(
      `Orbit: circular, ${o.alt} km, sun-synchronous at ${g.incl.toFixed(1)}° with its ascending node at ${fmtLtan(o.ltan)} local time; period ${(g.period / 60).toFixed(1)} min, beta angle ${g.beta.toFixed(1)}°, ${(g.eclipse * 100).toFixed(0)} % of each orbit in eclipse (${((g.eclipse * g.period) / 60).toFixed(1)} min)`,
      "Sunlight 1361 W/m² (AM0), no albedo or Earth infrared on the panels; cells at their start-of-life efficiency less 8 % for their working temperature, through each EPS input's MPPT converter at 90 %",
      `Separation: ${o.tipoff}°/s tip-off rate; detumbling with the magnetorquers in a ${(fieldT(craft.geo) * 1e6).toFixed(0)} µT field, and ${o.inertia} kg·m² about the tumble axis`,
    );
    if (o.deployed) p.assumptions.push("The wings start open: this run is a later orbit in normal operations, after the deployment");
    const s = craft.sunAt(0);
    craft.sun = s.v;
  } else p.notes.push("No orbit for the spacecraft boards: use world: sim.orbit(...) for the sun and eclipse. Without it the panels see full sun on their faces and nothing tumbles.");
  craft.w = o ? (unit([0.62, -0.48, 0.62]).map((x) => x * o.tipoff) as V3) : [0, 0, 0];
  p.extras.push({
    tick: (dt, t) => craft.tick(p, dt, t),
    channels: (out) => craft.channels(out),
    results: () => craft.results(p),
  });
  return c;
}

const fmtLtan = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

/** Earth's field at the orbit, T (a dipole's average over a polar orbit) */
const fieldT = (g: { a: number }) => 3.12e-5 * Math.pow(RE / g.a, 3) * 1.3;

/** the sun in the body for an attitude the ADCS holds: 0 at the sun, 1 imager at the ground, 2 patch at the ground */
function heldSun(c: Craft, t: number, target: number): V3 {
  const s = c.sunAt(t);
  if (target === 0) return c.orbit?.wings ?? [1, 0, 0];
  // nadir pointing: body Z up (imager, which looks along -Z, at the ground) or down (the patch on +Z at the ground);
  // body X along the orbit's normal on the sun's side, so the open wings take what light the plane lets them
  const zb: V3 = target === 1 ? s.r : (s.r.map((x) => -x) as V3);
  const side = Math.sign(dot(s.v, s.h)) || 1;
  const xb: V3 = s.h.map((x) => x * side) as V3;
  const yb = cross(zb, xb);
  return unit([dot(s.v, xb), dot(s.v, yb), dot(s.v, zb)]);
}

// ---------- the boards ----------

/** Put a spacecraft board on its bus: true for any part with specs.space_dev. */
export function attachSpacecraft(p: Plant, mc: MachineComponent, part: CatalogPart): boolean {
  const dev = String(part.specs.space_dev ?? "");
  if (!dev) return false;
  const c = craftOf(p);
  switch (dev) {
    case "eps":
      eps(p, c, mc, part);
      break;
    case "solar": {
      const n = mc.axes ? (mc.axes[2] as V3) : ([0, 0, 1] as V3);
      const wCell = num(part, "cell_cm2", 30.18) * 1e-4 * num(part, "eff", 0.295) * SUN_W_M2 * 0.92;
      for (let i = 0; i < Math.max(1, mc.count); i++) c.panels.push({ comp: mc.name, cells: num(part, "cells", 6), wCell, n: unit(n), at: mc.at ?? [0, 0, 0], deployable: part.specs.deployable === true });
      break;
    }
    case "burn":
      c.burns.push({ comp: mc.name, burn: p.netOf(mc.name, "BURN"), ohm: num(part, "burn_ohm", 10), burnS: num(part, "burn_s", 5), heat: 0, cutAt: -1, at: mc.at ?? [0, 0, 0], wings: [], sense: [], angle: 0, rate: 0, openAt: -1 });
      break;
    case "adcs":
      adcs(p, c, mc, part);
      break;
    case "uhf":
      uhf(p, c, mc, part);
      break;
    case "sband":
      sband(p, c, mc, part);
      break;
    case "ants":
      ants(p, c, mc, part);
      break;
    case "camera":
      camera(p, c, mc, part);
      break;
    default:
      // the star tracker and sun sensors sit on the ADCS's own bus, and the flight computer is the chip itself
      break;
  }
  p.finishers.push(() => finish(p, c));
  return true;
}

/** once every board is on: pair the hold-downs with their wings and hinge switches, and the board's own SD card */
function finish(p: Plant, c: Craft) {
  if ((c as unknown as { done?: boolean }).done) return;
  (c as unknown as { done?: boolean }).done = true;
  const d2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const wings = c.panels.filter((x) => x.deployable);
  for (const w of wings) {
    let best: Burn | undefined;
    for (const b of c.burns) if (dot(b.at, w.at) > 0 && (!best || d2(b.at, w.at) < d2(best.at, w.at))) best = b;
    best?.wings.push(w);
  }
  // hinge switches: switches whose common contact goes to a pin of the flight computer
  const senses: { comp: string; pin: number; at: V3 }[] = [];
  for (const mc of p.machine.components) {
    const part = catalogPart(mc.catalogId);
    if (part?.kind !== "switch") continue;
    const pin = p.mcuPinFor(mc.name, "COM");
    if (pin >= 0) senses.push({ comp: mc.name, pin, at: mc.at ?? [0, 0, 0] });
  }
  for (const s of senses) {
    let best: Burn | undefined;
    for (const b of c.burns) if (!best || d2(b.at, s.at) < d2(best.at, s.at)) best = b;
    if (!best) continue;
    best.sense.push({ comp: s.comp, pin: s.pin });
    // stowed: the wing's tab holds the plunger in, so the common contact is on the grounded NO contact
    if (!c.orbit?.deployed) p.hal.setExternal(s.pin, 0);
  }
  if (c.orbit?.deployed)
    for (const b of c.burns) {
      b.angle = 90;
      b.cutAt = 0;
      b.openAt = 0;
    }
}

const be16 = (v: number) => {
  const x = Math.max(0, Math.min(65535, Math.round(v)));
  return [(x >> 8) & 255, x & 255];
};
const le16s = (v: number) => {
  const x = Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;
  return [x & 255, (x >> 8) & 255];
};

/**
 * GomSpace NanoPower P31u, on I2C at its address (0x02). Commands, as GomSpace's: 9 [channel, on, delay(2)] sets one
 * output (0 to 5 are OUT1 to OUT6); 8 [0] asks for housekeeping, which a read then returns as cmd, error, battery
 * volts (mV), solar current (mA), system current (mA), the outputs as a mask, the battery mode and the board's
 * temperature: a short form of GomSpace's eps_hk_t.
 */
function eps(p: Plant, c: Craft, mc: MachineComponent, part: CatalogPart) {
  const vbat = p.netOf(mc.name, "VBAT");
  const outV = String(part.specs.out_v ?? "5,5,5,3.3,3.3,3.3").split(",").map(Number);
  const outI = String(part.specs.out_limit_a ?? "2,2,2,1.5,1.5,1.5").split(",").map(Number);
  const extra = (n: Net | undefined) => () => (n ? (c.extraOn.get(n.id)?.() ?? 0) : 0);
  const rail = (id: string, v: number, imax: number, on: () => boolean) => {
    const vout = p.netOf(mc.name, id);
    if (!vout) return;
    p.regs.push({ r: new EpsRail(`${mc.name} ${id}`, part, v, imax, on, extra(vout)), comp: mc.name, vin: vbat, vout });
  };
  rail("V3V3", 3.3, num(part, "v3_imax", 5), () => true);
  rail("V5", 5, num(part, "v5_imax", 4), () => true);
  for (let i = 0; i < 6; i++) rail(`OUT${i + 1}`, outV[i] ?? 5, outI[i] ?? 2, () => c.outs[i]);
  // the flight computer's own draw on the 3.3 V bus, past the standing 30 mA the plant counts for it
  const v3 = p.netOf(mc.name, "V3V3");
  if (v3) addExtra(c, v3, () => 0.1);
  let cmd = 0;
  const dev: I2CDevice = {
    write(bytes) {
      if (!bytes.length) return;
      cmd = bytes[0];
      if (cmd === 9 && bytes.length >= 3) {
        const ch = bytes[1];
        if (ch < 6) {
          const want = bytes[2] !== 0;
          if (c.outs[ch] !== want) p.events.push({ t: p.t, kind: "info", text: `EPS: OUT${ch + 1} ${want ? "on" : "off"}` });
          c.outs[ch] = want;
        }
      }
    },
    read(n) {
      const bat = p.batteries[0]?.b;
      const vb = bat ? bat.volts() : 0;
      const sun = (c.harvestW / Math.max(1, vb)) * 1000;
      const sys = (Math.max(0, c.loadW) / Math.max(1, vb)) * 1000;
      const mask = c.outs.reduce((m, o, i) => m | ((o ? 1 : 0) << i), 0);
      const mode = !bat ? 0 : bat.soc < 0.2 ? 1 : bat.soc < 0.5 ? 2 : 3;
      const out = cmd === 8 ? [8, 0, ...be16(vb * 1000), ...be16(sun), ...be16(sys), mask, mode, ...be16(20)] : [cmd, 1];
      return Array.from({ length: n }, (_, i) => out[i] ?? 0);
    },
  };
  p.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x02"), 16), { dev, comp: mc.name, vcc: vbat });
}

function addExtra(c: Craft, n: Net, f: () => number) {
  const before = c.extraOn.get(n.id);
  c.extraOn.set(n.id, before ? () => before() + f() : f);
}

const powered = (p: Plant, mc: MachineComponent, pin: string, vmin: number) => {
  const n = p.netOf(mc.name, pin);
  return () => (n ? p.volts(n, mc.name) >= vmin : false);
};

/**
 * CubeSpace CubeADCS (3-axis, small), on I2C at its address (0x57), in a reduced form of CubeSpace's command set:
 * telecommand 10 [run mode] (1 enabled), 13 [control mode, timeout(2)] (0 none, 1 detumbling, 5 three-axis on the
 * wheels) and 17 [target] (0 the wings at the sun, 1 the imager at the ground, 2 the S-band patch at the ground);
 * telemetry 146 returns the body rates as three signed 16-bit numbers in 0.01 deg/s, low byte first.
 */
function adcs(p: Plant, c: Craft, mc: MachineComponent, part: CatalogPart) {
  c.adcsPowered = powered(p, mc, "V3V3", 3);
  const v3 = p.netOf(mc.name, "V3V3");
  const idle = num(part, "p_idle_w", 0.4);
  const det = num(part, "p_detumble_w", 1.1);
  const point = num(part, "p_point_w", 1.9);
  if (v3) addExtra(c, v3, () => Math.max(0, ((!c.adcsRun ? idle : c.ctrlMode === 1 ? det : c.ctrlMode >= 5 ? point : idle) - 0.3) / 3.3));
  if (c.orbit) c.slewMax = Math.min(3, ((0.9 * num(part, "wheel_mnms", 1.77) * 1e-3) / c.orbit.inertia) / D2R);
  let tlm = 0;
  const dev: I2CDevice = {
    write(bytes) {
      if (!bytes.length) return;
      const id = bytes[0];
      if (id === 10 && bytes.length >= 2) {
        c.adcsRun = bytes[1] === 1;
        p.events.push({ t: p.t, kind: "info", text: `ADCS: ${c.adcsRun ? "enabled" : "off"}` });
      } else if (id === 13 && bytes.length >= 2) {
        if (c.ctrlMode !== bytes[1]) p.events.push({ t: p.t, kind: "info", text: `ADCS: control mode ${bytes[1] === 1 ? "detumbling" : bytes[1] >= 5 ? "three-axis on the wheels" : "none"}` });
        c.ctrlMode = bytes[1];
      } else if (id === 17 && bytes.length >= 2) {
        c.target = bytes[1];
      } else tlm = id;
    },
    read(n) {
      const w = c.adcsRun && c.ctrlMode >= 5 ? (c.w.map((x) => (x / Math.max(1e-9, len(c.w))) * c.adcsW) as V3) : c.w;
      const out = tlm === 146 ? [...le16s(w[0] * 100), ...le16s(w[1] * 100), ...le16s(w[2] * 100)] : [];
      return Array.from({ length: n }, (_, i) => out[i] ?? 0);
    },
  };
  p.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x57"), 16), { dev, comp: mc.name, vcc: v3 });
}

/**
 * EnduroSat UHF Transceiver II, on I2C at its address (0x22): 0x01 [on] enables its transmitter (the CDS keeps it
 * off for 45 minutes after separation), 0x10 [length, bytes...] sends one frame, and a read returns whether it is
 * still sending. It keys up for the frame's time at its baud rate (with 18 bytes of framing) and draws its
 * transmitting power for that long.
 */
function uhf(p: Plant, c: Craft, mc: MachineComponent, part: CatalogPart) {
  c.uhfPowered = powered(p, mc, "V3V3", 3);
  const v3 = p.netOf(mc.name, "V3V3");
  const baud = num(part, "baud", 9600);
  const txW = num(part, "p_txin_w", 4);
  const rxW = num(part, "p_rx_w", 0.3);
  if (v3) addExtra(c, v3, () => (c.uhfBusyUntil > p.t ? (txW - rxW) / 3.3 : 0));
  const dev: I2CDevice = {
    write(bytes) {
      if (!bytes.length) return;
      if (bytes[0] === 0x01 && bytes.length >= 2) {
        c.uhfTxOn = bytes[1] !== 0;
        p.events.push({ t: p.t, kind: "info", text: `UHF: transmitter ${c.uhfTxOn ? "enabled" : "inhibited"}` });
      } else if (bytes[0] === 0x10 && bytes.length >= 2) {
        if (!c.uhfTxOn || c.uhfBusyUntil > p.t) return;
        const n = Math.min(bytes[1], bytes.length - 2);
        c.uhfBusyUntil = p.t + ((n + 18) * 8) / baud;
        c.beacons++;
        if (c.firstBeacon < 0) {
          c.firstBeacon = p.t;
          const text = String.fromCharCode(...bytes.slice(2, 2 + n).filter((b) => b >= 32 && b < 127));
          p.events.push({ t: p.t, kind: "info", text: `UHF: first beacon on ${num(part, "f_mhz", 437.5)} MHz: "${text}"` });
        }
      }
    },
    read(n) {
      const out = [c.uhfBusyUntil > p.t ? 1 : 0, c.uhfTxOn ? 1 : 0];
      return Array.from({ length: n }, (_, i) => out[i] ?? 0);
    },
  };
  p.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x22"), 16), { dev, comp: mc.name, vcc: v3 });
}

/** EnduroSat S-band transmitter, on I2C (0x26): 0x01 [on] starts and stops the downlink, which draws its transmitting power. */
function sband(p: Plant, c: Craft, mc: MachineComponent, part: CatalogPart) {
  c.sbandPowered = powered(p, mc, "V5", 4.5);
  const v5 = p.netOf(mc.name, "V5");
  const txW = num(part, "p_txin_w", 11);
  const idleW = num(part, "p_idle_w", 0.5);
  if (v5) addExtra(c, v5, () => (c.sbandOn && c.sbandPowered() ? (txW - idleW) / 5 : 0));
  const dev: I2CDevice = {
    write(bytes) {
      if (bytes[0] === 0x01 && bytes.length >= 2) {
        const on = bytes[1] !== 0;
        if (on !== c.sbandOn) p.events.push({ t: p.t, kind: "info", text: `S-band: downlink ${on ? "started" : "ended"}` });
        c.sbandOn = on;
      }
    },
    read(n) {
      return Array.from({ length: n }, (_, i) => (i === 0 ? (c.sbandOn ? 1 : 0) : 0));
    },
  };
  p.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x26"), 16), { dev, comp: mc.name, vcc: v5 });
}

/**
 * ISISPACE antenna system, on I2C (0x31), with ISIS's commands: 0xAD arms it, 0xAC disarms it, 0xA5 [seconds] burns
 * each element's release in turn, and 0xC3 reads the two status bytes: a bit set for each element not yet deployed
 * (bits 15, 11, 7 and 3) and bit 0 while armed.
 */
function ants(p: Plant, c: Craft, mc: MachineComponent, part: CatalogPart) {
  c.antsPowered = powered(p, mc, "V3V3", 3);
  const v3 = p.netOf(mc.name, "V3V3");
  c.antsBurnS = num(part, "burn_s", 4);
  if (v3) addExtra(c, v3, () => (c.antsDeploying >= 0 && c.antsPowered() ? 0.3 : 0));
  let cmd = 0;
  const dev: I2CDevice = {
    write(bytes) {
      if (!bytes.length) return;
      cmd = bytes[0];
      if (cmd === 0xad) c.antsArmed = true;
      else if (cmd === 0xac) c.antsArmed = false;
      else if (cmd === 0xa5 && c.antsArmed && c.antsDeploying < 0 && c.antsDone !== 15) {
        c.antsDeploying = 0;
        c.antsStart = p.t;
        p.events.push({ t: p.t, kind: "info", text: "Antenna system: deploying its four elements in turn" });
      }
    },
    read(n) {
      if (cmd !== 0xc3) return Array.from({ length: n }, () => 0);
      let st = c.antsArmed ? 1 : 0;
      [15, 11, 7, 3].forEach((bit, i) => {
        if (!(c.antsDone & (1 << i))) st |= 1 << bit;
      });
      const out = [st & 255, (st >> 8) & 255];
      return Array.from({ length: n }, (_, i) => out[i] ?? 0);
    },
  };
  p.i2cDevs.set(parseInt(String(part.specs.i2c_addr ?? "0x31"), 16), { dev, comp: mc.name, vcc: v3 });
}

/**
 * Simera Sense MultiScape100 on the flight computer's UART: a line "IMG <seconds>" starts imaging for that long and
 * it answers "ACK IMG"; "STATUS" gets "OK" and its image count. It draws its imaging power while it images.
 */
function camera(p: Plant, c: Craft, mc: MachineComponent, part: CatalogPart) {
  c.cameraPowered = powered(p, mc, "V5", 4.5);
  const v5 = p.netOf(mc.name, "V5");
  const imgW = num(part, "p_img_w", 5.8);
  const idleW = num(part, "p_idle_w", 1.5);
  // the standing catalog draw is its idle power
  if (v5) addExtra(c, v5, () => (c.cameraImaging > p.t && c.cameraPowered() ? (imgW - idleW) / 5 : 0));
  const tx = p.mcuPinFor(mc.name, "RX");
  const rx = p.mcuPinFor(mc.name, "TX");
  if (tx < 0) {
    p.notes.push(`${mc.name}: its RX is not wired to a pin of the ${p.board.name}, so it never hears a command.`);
    return;
  }
  let line = "";
  p.hal.attachUart(tx, rx, {
    byte(b, t) {
      if (b !== 10 && b !== 13) {
        if (line.length < 64) line += String.fromCharCode(b);
        return null;
      }
      const cmd = line.trim();
      line = "";
      if (!cmd || !c.cameraPowered()) return null;
      const m = /^IMG\s+(\d+)/.exec(cmd);
      let reply = "ERR";
      if (m) {
        c.cameraImaging = t + Number(m[1]);
        c.images++;
        p.events.push({ t, kind: "info", text: `${mc.name}: imaging for ${m[1]} s` });
        reply = "ACK IMG";
      } else if (cmd === "STATUS") reply = `OK ${c.images}`;
      return { after: 0.002, bytes: [...reply].map((ch) => ch.charCodeAt(0)).concat([10]) };
    },
  });
}
