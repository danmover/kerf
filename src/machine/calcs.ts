// Engineering calculators, callable from .kerf as calc.<name>(...). Each one
// returns an object whose fields are its results (base units: mm, N, N·mm,
// MPa, V, A, W, s) and carries a trace: inputs, formulas, assumptions, how
// far to trust it, and what a physical test should confirm. `let x = calc...`
// records the trace in the design's calculations.

import { Args } from "../lang/args";
import { Fn, Obj, typeName, type CallCtx, type Value } from "../lang/values";
import { BEARINGS } from "../library/standards";
import type { CalcLine, CalcTrace } from "./types";

export type CalcBody = Omit<CalcTrace, "name" | "span">;

export class CalcObj extends Obj {
  constructor(
    fields: Record<string, Value>,
    public trace: CalcBody,
  ) {
    super(fields, "calc", trace.title);
  }
}

const D2R = Math.PI / 180;
const G = 9.80665;

/** Round for display: 3 significant figures. */
export function sig(n: number, digits = 3): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const e = digits - Math.ceil(Math.log10(Math.abs(n)));
  // divide by a whole power of ten for big numbers so 2.51e7 stays exact
  return e >= 0 ? Math.round(n * 10 ** e) / 10 ** e : Math.round(n / 10 ** -e) * 10 ** -e;
}

const L = (label: string, value: number, unit: string, note?: string): CalcLine => ({ label, value: sig(value), unit, note });

interface Result {
  fields: Record<string, number | string | boolean>;
  trace: CalcBody;
}

/** Parameter names of every calculator, for the assistant's reference and tool checks. */
export const CALC_PARAMS: Record<string, string[]> = {};

function calcFn(name: string, params: string[], doc: string, impl: (a: Args) => Result): [string, Fn] {
  CALC_PARAMS[name] = params;
  return [
    name,
    new Fn(
      `calc.${name}`,
      (pos, named, ctx) => {
        const r = impl(new Args(`calc.${name}`, pos, named, ctx, params));
        for (const [k, v] of Object.entries(r.fields)) if (typeof v === "number" && !Number.isFinite(v)) r.fields[k] = v > 0 ? 1e12 : v < 0 ? -1e12 : 0;
        return new CalcObj(r.fields, { ...r.trace, fn: name });
      },
      doc,
    ),
  ];
}

/** Read a numeric spec from a catalog component value (or a plain object). */
function spec(v: Value | undefined, key: string, ctx: CallCtx, what: string): number {
  if (v instanceof Obj && typeof v.fields[key] === "number") return v.fields[key] as number;
  return ctx.error(`${what} should be a catalog component with "${key}" (got ${v === undefined ? "nothing" : typeName(v)})`);
}
function compName(v: Value | undefined): string {
  if (v instanceof Obj) return String(v.fields.name ?? v.label ?? v.kind);
  return "motor";
}

// AWG copper: ohms per metre and a conservative chassis-wiring ampacity (A)
const AWG: [number, number, number][] = [
  [30, 0.3386, 0.5],
  [28, 0.2129, 0.8],
  [26, 0.1339, 1.3],
  [24, 0.0842, 2.1],
  [22, 0.053, 3.5],
  [20, 0.0333, 5],
  [18, 0.021, 7],
  [16, 0.0132, 10],
  [14, 0.00829, 15],
  [12, 0.00521, 20],
  [10, 0.00328, 30],
];
export function awgAmpacity(awg: number): number {
  const row = AWG.find((r) => r[0] === awg) ?? AWG.reduce((a, b) => (Math.abs(b[0] - awg) < Math.abs(a[0] - awg) ? b : a));
  return row[2];
}

export const CALC_FNS: Record<string, Fn> = Object.fromEntries([
  calcFn(
    "sand_stress",
    ["depth", "box_w", "box_l", "density", "phi", "wall_phi", "k"],
    "Stress in a box of dry sand at a depth, with Janssen wall arching. depth: mm below the surface; box_w, box_l: box inside size in mm (leave out for an open field: no arching); density: g/cm³ (1.6); phi: internal friction angle (32deg); wall_phi: sand–wall friction (2/3 phi); k: lateral stress ratio (1 − sin phi). Returns sigma_v, sigma_h, sigma_mean (MPa), geostatic (MPa), arching (fraction of the open-field stress).",
    (a) => {
      const z = a.positive("depth");
      const rho = a.num("density", 1.6);
      const phi = a.num("phi", 32);
      const dw = a.num("wall_phi", (2 / 3) * phi);
      const K = a.num("k", 1 - Math.sin(phi * D2R));
      const gamma = rho * G * 1e-6; // N/mm³
      const geo = gamma * z;
      let sv = geo;
      let R = Infinity;
      if (a.has("box_w")) {
        const B = a.positive("box_w");
        const Lb = a.has("box_l") ? a.positive("box_l") : B;
        R = (B * Lb) / (2 * (B + Lb));
        const mu = Math.tan(dw * D2R);
        sv = ((gamma * R) / (mu * K)) * (1 - Math.exp((-mu * K * z) / R));
      }
      const sh = K * sv;
      const inputs = [L("Depth below the sand surface", z / 1000, "m"), L("Sand bulk density", rho * 1000, "kg/m³"), L("Internal friction angle φ", phi, "°"), L("Lateral stress ratio K", K, "")];
      if (Number.isFinite(R)) inputs.push(L("Box inside width", a.num("box_w") / 1000, "m"), L("Hydraulic radius A/P", R / 1000, "m"), L("Sand–wall friction angle δw", dw, "°"));
      return {
        fields: { sigma_v: sv, sigma_h: sh, sigma_mean: (sv + sh) / 2, geostatic: geo, arching: sv / geo, k: K, phi },
        trace: {
          fn: "",
          title: "Sand pressure at the tunnel depth",
          inputs,
          outputs: [L("Vertical stress σv", sv * 1000, "kPa"), L("Horizontal stress σh", sh * 1000, "kPa"), L("Open-field vertical stress (no walls)", geo * 1000, "kPa"), L("Walls carry", (1 - sv / geo) * 100, "%")],
          method: Number.isFinite(R)
            ? ["Janssen silo equation: σv = γR/(μK)·(1 − e^(−μKz/R)), R = A/P of the box, μ = tan δw", "σh = K·σv, K = 1 − sin φ (Jaky)"]
            : ["Geostatic: σv = γz", "σh = K·σv, K = 1 − sin φ (Jaky)"],
          assumptions: ["Dry, uniform sand, poured not compacted", "Box walls are rigid and rough enough to carry friction", "No surcharge on the surface", "Stress around the robot is the undisturbed stress; digging relaxes it near the bore"],
          confidence: "estimate",
          verify: Number.isFinite(R) ? "Janssen arching depends on the wall friction: if the walls are slick (polished steel, plastic film) the stress can be several times higher." : undefined,
        },
      };
    },
  ),

  calcFn(
    "screw_burrow",
    ["d", "core_d", "length", "pitch", "sigma_v", "sigma_h", "phi", "delta", "face", "slip", "drag_length", "drag_d"],
    "Torque and thrust for one screw section of a burrowing robot. d: flight outside diameter, core_d: shell diameter, length: flighted length, pitch: flight pitch (all mm); sigma_v, sigma_h: soil stress (MPa, from calc.sand_stress); phi: sand friction angle (32deg); delta: sand–shell friction angle (2/3 phi); face: true for the front section that cuts the face; slip: fraction of pitch lost (0.5); drag_length, drag_d: non-rotating length and diameter this section drags (mm). Returns torque (N·mm), thrust (expected), thrust_low and thrust_high (N), resist (N), advance_per_rev (mm).",
    (a) => {
      const D = a.positive("d");
      const dc = a.positive("core_d", D * 0.75);
      const Ls = a.positive("length");
      const p = a.positive("pitch");
      const sv = a.positive("sigma_v");
      const sh = a.num("sigma_h", sv * 0.47);
      const phi = a.num("phi", 32);
      const delta = a.num("delta", (2 / 3) * phi);
      const face = a.bool("face");
      const slip = a.num("slip", 0.5);
      const dragL = a.num("drag_length", 0);
      const dragD = a.num("drag_d", dc);
      const sn = (sv + sh) / 2;
      const tphi = Math.tan(phi * D2R);
      const tdel = Math.tan(delta * D2R);
      // The sand between the flights either turns with the screw (shearing on
      // the flight-tip cylinder, sand on sand) or stays put while the shell and
      // flights slide past it (sand on shell). It fails on the weaker surface.
      const Askin = Math.PI * D * Ls;
      const Fskin = sn * tphi * Askin;
      const Tod = (Fskin * D) / 2;
      const rc = dc / 2;
      const Rf = D / 2;
      const Tin = sn * tdel * (Math.PI * dc * Ls * rc + (Ls / p) * Math.PI * (Rf * Rf - rc * rc) * ((Rf + rc) / 2));
      const Tspin = Math.min(Tod, Tin);
      const regime = Tin <= Tod ? "sand stays put, shell and flights slide through it" : "sand turns with the screw";
      // face: the nose cuts a disk of sand pressed by the horizontal stress
      const R = D / 2;
      const Tface = face ? (2 / 3) * sh * tphi * Math.PI * R ** 3 : 0;
      const T = Tspin + Tface;
      // thrust bounds: conveyor model (low) and screw-in-a-nut model (high)
      const tanTheta = (p * Math.max(0.05, Math.min(1, slip))) / (Math.PI * D);
      const thrustLow = (2 * Tspin * tanTheta) / D;
      const dm = (D + dc) / 2;
      const lam = Math.atan(p / (Math.PI * dm));
      const thrustHigh = Math.min((2 * T) / (dm * Math.tan(lam + delta * D2R)), Fskin);
      // expected: when the sand stays put the flights work like a screw in a nut,
      // knocked down by half for slip and loosening; otherwise the conveyor model
      const thrust = Tin <= Tod ? Math.max(thrustLow, 0.5 * thrustHigh) : thrustLow;
      // resistance: face bearing on the annulus the flights cannot clear + drag of non-rotating parts
      const resistFace = face ? sh * Math.PI * R * R * 0.5 : 0;
      const resistDrag = sn * tdel * Math.PI * dragD * dragL;
      const resist = resistFace + resistDrag;
      const adv = p * (1 - slip);
      return {
        fields: { torque: T, thrust, torque_spin: Tspin, torque_face: Tface, torque_sand_turns: Tod, torque_sand_still: Tin, thrust_low: thrustLow, thrust_high: thrustHigh, resist, advance_per_rev: adv, helix_deg: lam / D2R },
        trace: {
          fn: "",
          title: face ? "Front screw: torque and thrust" : "Screw section: torque and thrust",
          inputs: [
            L("Flight diameter", D, "mm"),
            L("Shell diameter", dc, "mm"),
            L("Flighted length", Ls, "mm"),
            L("Pitch", p, "mm"),
            L("Mean normal stress (σv+σh)/2", sn * 1000, "kPa"),
            L("Sand friction angle φ", phi, "°"),
            L("Sand–shell friction angle δ", delta, "°"),
            L("Slip", slip * 100, "%"),
          ],
          outputs: [
            L("Torque to turn the section", T / 1000, "N·m", regime),
            L("  if the sand turned with the screw", Tod / 1000, "N·m"),
            L("  if the sand stays put", Tin / 1000, "N·m"),
            ...(face ? [L("  of which cutting the face", Tface / 1000, "N·m")] : []),
            L("Thrust, expected", thrust, "N"),
            L("Thrust, conservative (conveyor model)", thrustLow, "N"),
            L("Thrust, optimistic (screw-in-nut model)", thrustHigh, "N"),
            L("Resistance this section adds", resist, "N"),
            L("Advance per turn", adv, "mm"),
          ],
          method: [
            "Sand between the flights fails on the weaker surface: turning with the screw, T = σn·tan φ·πDL·D/2, or staying put while the shell and flights slide, T = σn·tan δ·(πdL·d/2 + (L/p)·π(R²−r²)·rm)",
            face ? "Face cutting torque: T = ⅔·σh·tan φ·πR³" : "",
            "Low thrust: the sand moving back along the flights at slip s is resisted by the shear, F = 2T·tanθ/D with tanθ = p·s/(πD)",
            "High thrust: power-screw relation F = 2T/(dm·tan(λ+δ)), capped by the sand's shear strength σn·tan φ·πDL",
            "Expected thrust: half the high value when the sand stays put (the flights act like a screw in a nut), otherwise the low value",
            "Resistance: half the face area at σh (sand the nose pushes rather than clears) plus friction σn·tan δ on non-rotating parts",
          ].filter(Boolean),
          assumptions: [
            "Dry sand at the stress from the sand pressure calculation",
            "Steady advance; start-up and stalls take more torque",
            "Burrowing screws are an open research topic: these numbers can be off by 2× either way",
          ],
          confidence: "rough",
          verify: "Bury the screw section in the test barrel at the design stress and measure motor current (torque) and pull force (thrust) at the design speed.",
        },
      };
    },
  ),

  calcFn(
    "motor_point",
    ["motor", "load", "voltage", "ratio", "efficiency", "continuous"],
    "Operating point of a DC gearmotor from its catalog specs (linear motor model). motor: a catalog gearmotor component; load: torque at the output shaft (N·mm); voltage: supply volts (v_rated); ratio: extra reduction after the motor (1); efficiency: of that extra stage (1); continuous: the largest fraction of stall torque to run continuously (0.5). Returns rpm, current (A), power_in, power_out (W), stall_margin, load_fraction, stall_current.",
    (a) => {
      const m = a.value("motor");
      const ctx = a.ctx;
      const vr = spec(m, "v_rated", ctx, "motor");
      const V = a.num("voltage", vr);
      const k = V / vr;
      const ts = spec(m, "t_stall", ctx, "motor") * k;
      const nf = spec(m, "rpm_free", ctx, "motor") * k;
      const is = spec(m, "i_stall", ctx, "motor") * k;
      const i0 = spec(m, "i_free", ctx, "motor");
      const ratio = a.num("ratio", 1);
      const eff = a.num("efficiency", 1);
      const cont = a.num("continuous", 0.5);
      const T = a.num("load") / (ratio * eff);
      const frac = T / ts;
      const rpm = (nf * Math.max(0, 1 - frac)) / ratio;
      const I = i0 + (is - i0) * Math.min(1, frac);
      const pout = (a.num("load") / 1000) * ((rpm * 2 * Math.PI) / 60);
      const pin = V * I;
      return {
        fields: { rpm, current: I, power_in: pin, power_out: pout, efficiency: pin > 0 ? pout / pin : 0, stall_margin: ts / Math.max(T, 1e-9), load_fraction: frac, stall_current: is, ok: frac <= cont },
        trace: {
          fn: "",
          title: `${compName(m)}: operating point`,
          inputs: [L("Load at the output", a.num("load") / 1000, "N·m"), L("Supply", V, "V"), L("Stall torque at this voltage", ts / 1000, "N·m"), L("Free speed at this voltage", nf, "rpm"), L("Stall current", is, "A"), ...(ratio !== 1 ? [L("Extra reduction", ratio, ":1")] : [])],
          outputs: [L("Speed under load", rpm, "rpm"), L("Current", I, "A"), L("Mechanical power out", pout, "W"), L("Electrical power in", pin, "W"), L("Load / stall torque", frac * 100, "%", frac > cont ? "over the continuous limit: it will overheat" : undefined), L("Stall margin", ts / Math.max(T, 1e-9), "×")],
          method: ["Linear DC motor: speed = free speed·(1 − T/Tstall), current = I0 + (Istall − I0)·T/Tstall", "Free speed, stall torque and stall current scale with supply voltage"],
          assumptions: ["Maker's 12 V figures at room temperature; a hot motor gives less torque", "Gearbox losses are inside the maker's stall torque"],
          confidence: "standard",
          verify: "Measure current at the real load: it gives the real torque through the same line.",
        },
      };
    },
  ),

  calcFn(
    "stepper_axis",
    ["motor", "current", "voltage", "mass", "accel", "speed", "travel_per_rev", "friction", "efficiency", "vertical"],
    "Stepper axis sizing. motor: catalog stepper; current: driver RMS current (A); voltage: supply (24V); mass: moving mass (g); accel: mm/s²; speed: mm/s; travel_per_rev: mm per motor turn (40 for GT2 20T, 8 for T8×8); friction: N (5); efficiency: drive efficiency (0.9 belts, 0.4 lead screws); vertical: true when lifting. Returns torque_needed, torque_available (N·mm), margin, max_speed (mm/s).",
    (a) => {
      const m = a.value("motor");
      const ctx = a.ctx;
      const th = spec(m, "t_hold", ctx, "motor");
      const ir = spec(m, "i_rated", ctx, "motor");
      const lph = spec(m, "l_phase", ctx, "motor") / 1000; // H
      const I = a.num("current", ir * 0.8);
      const V = a.num("voltage", 24);
      const mass = a.num("mass") / 1000; // kg
      const acc = a.num("accel", 3000) / 1000; // m/s²
      const v = a.num("speed", 150);
      const tpr = a.positive("travel_per_rev");
      const fr = a.num("friction", 5);
      const eff = a.num("efficiency", 0.9);
      const vert = a.bool("vertical");
      const F = mass * acc + fr + (vert ? mass * G : 0); // N
      const Tneed = (F * tpr) / (2 * Math.PI * eff); // N·mm
      const rpm = (v / tpr) * 60;
      // full-step rate where the driver can no longer push full current through the winding inductance
      const fc = V / (2 * lph * I);
      const ncorner = (fc / 200) * 60;
      const T0 = th * Math.min(1, I / ir) * 0.85; // microstepping, sinusoidal current
      const Tav = T0 * Math.min(1, ncorner / Math.max(rpm, 1e-9));
      // highest speed with margin 1: T0·nc/n = Tneed
      const nmax = Tneed > 0 ? Math.max(ncorner, (T0 * ncorner) / Tneed) : Infinity;
      return {
        fields: { torque_needed: Tneed, torque_available: Tav, margin: Tav / Math.max(Tneed, 1e-9), force: F, rpm, corner_rpm: ncorner, max_speed: (nmax * tpr) / 60 },
        trace: {
          fn: "",
          title: `${compName(m)}: axis torque`,
          inputs: [L("Moving mass", mass, "kg"), L("Acceleration", acc * 1000, "mm/s²"), L("Speed", v, "mm/s"), L("Travel per motor turn", tpr, "mm"), L("Friction", fr, "N"), L("Drive efficiency", eff * 100, "%"), L("Driver current", I, "A"), L("Supply", V, "V")],
          outputs: [L("Force", F, "N"), L("Torque needed", Tneed, "N·mm"), L("Torque available at speed", Tav, "N·mm"), L("Margin", Tav / Math.max(Tneed, 1e-9), "×"), L("Motor speed", rpm, "rpm"), L("Corner speed", ncorner, "rpm"), L("Highest speed at this acceleration", (nmax * tpr) / 60, "mm/s")],
          method: [
            "F = m·a + friction" + (vert ? " + m·g" : ""),
            "T = F·(travel per turn)/(2π·η)",
            "Available torque ≈ 0.85·Thold·I/Irated up to the corner speed, then falls as 1/speed",
            "Corner full-step rate ≈ V/(2·L·I)",
          ],
          assumptions: ["Rotor inertia neglected (small next to the load on belt axes)", "Datasheet holding torque at rated current", "The corner-speed model is approximate: real torque curves vary with the driver's chopper"],
          confidence: "estimate",
          verify: "Run the axis at the target acceleration and speed with input shaping off; listen for skipped steps, then raise the acceleration until it skips and keep 50 % margin.",
        },
      };
    },
  ),

  calcFn(
    "lead_screw",
    ["lead", "load", "efficiency"],
    "Torque to drive a lead screw. lead: mm per turn; load: N; efficiency (0.4 for brass on steel). Returns torque (N·mm) and backdrives (true when the load can turn the screw).",
    (a) => {
      const lead = a.positive("lead");
      const F = a.num("load");
      const eff = a.num("efficiency", 0.4);
      const T = (F * lead) / (2 * Math.PI * eff);
      return {
        fields: { torque: T, backdrives: eff > 0.5 },
        trace: {
          fn: "",
          title: "Lead screw torque",
          inputs: [L("Lead", lead, "mm"), L("Axial load", F, "N"), L("Efficiency", eff * 100, "%")],
          outputs: [L("Drive torque", T, "N·mm")],
          method: ["T = F·lead/(2π·η)"],
          assumptions: ["Lubricated brass nut"],
          confidence: "standard",
        },
      };
    },
  ),

  calcFn(
    "heater_warmup",
    ["power", "mass", "c", "from", "to", "loss"],
    "Time for a heater to warm a part. power: W; mass: g; c: specific heat J/(g·K) (0.9 aluminium); from, to: °C (25 to 60); loss: heat loss W/K (power/100). Returns time (s) and max_temp (°C).",
    (a) => {
      const P = a.positive("power");
      const m = a.positive("mass");
      const c = a.num("c", 0.9);
      const T0 = a.num("from", 25);
      const T1 = a.num("to", 60);
      const h = a.num("loss", P / 100);
      const dmax = P / h;
      const tau = (m * c) / h;
      const dT = T1 - T0;
      const t = dT >= dmax ? Infinity : -tau * Math.log(1 - dT / dmax);
      return {
        fields: { time: t, max_temp: T0 + dmax, reaches: dT < dmax },
        trace: {
          fn: "",
          title: "Heater warm-up",
          inputs: [L("Heater power", P, "W"), L("Heated mass", m, "g"), L("Specific heat", c, "J/(g·K)"), L("Heat loss", h, "W/K")],
          outputs: [L("Time to reach target", t / 60, "min"), L("Highest temperature it can reach", T0 + dmax, "°C")],
          method: ["Lumped mass with linear loss: t = −τ·ln(1 − ΔT/ΔTmax), τ = m·c/h, ΔTmax = P/h"],
          assumptions: ["Uniform temperature; the loss coefficient is a guess"],
          confidence: "estimate",
          verify: "Time the first heat-up with a thermometer.",
        },
      };
    },
  ),

  calcFn(
    "battery_runtime",
    ["battery", "current", "usable", "peak"],
    "Battery runtime. battery: catalog battery component; current: average draw (A); usable: fraction of capacity to use (0.8); peak: highest draw (A). Returns minutes, time (s, to compare with times like 12min), c_rate and peak_ok.",
    (a) => {
      const b = a.value("battery");
      const ctx = a.ctx;
      const cap = spec(b, "capacity_mah", ctx, "battery") / 1000; // Ah
      const icont = spec(b, "i_cont", ctx, "battery");
      const I = a.positive("current");
      const use = a.num("usable", 0.8);
      const peak = a.num("peak", I);
      const minutes = ((cap * use) / I) * 60;
      return {
        fields: { minutes, time: minutes * 60, c_rate: I / cap, peak_ok: peak <= icont },
        trace: {
          fn: "",
          title: `${compName(b)}: runtime`,
          inputs: [L("Capacity", cap * 1000, "mAh"), L("Average current", I, "A"), L("Usable fraction", use * 100, "%"), L("Peak current", peak, "A")],
          outputs: [L("Runtime", minutes, "min"), L("Discharge rate", I / cap, "C"), L("Battery's continuous limit", icont, "A")],
          method: ["Runtime = capacity·usable/current"],
          assumptions: ["Capacity falls in the cold and with age"],
          confidence: "estimate",
        },
      };
    },
  ),

  calcFn(
    "wire_gauge",
    ["current", "length", "voltage", "max_drop"],
    "Smallest copper wire (AWG) for a current. current: A; length: one-way run (mm); voltage: supply (V); max_drop: allowed voltage drop fraction (0.03). Returns awg, drop (V), drop_pct and fits (false when even 10 AWG is not enough: then awg is 10 and the run needs thicker or parallel wire).",
    (a) => {
      const I = a.positive("current");
      const len = a.num("length", 500) / 1000;
      const V = a.num("voltage", 12);
      const maxDrop = a.num("max_drop", 0.03);
      let pick = AWG[AWG.length - 1];
      let fits = false;
      for (const row of AWG) {
        const drop = row[1] * len * 2 * I;
        if (row[2] >= I && drop / V <= maxDrop) {
          pick = row;
          fits = true;
          break;
        }
      }
      const drop = pick[1] * len * 2 * I;
      return {
        fields: { awg: pick[0], drop, drop_pct: drop / V, fits },
        trace: {
          fn: "",
          title: `Wire size for ${sig(I)} A`,
          inputs: [L("Current", I, "A"), L("One-way length", len * 1000, "mm"), L("Supply", V, "V")],
          outputs: [L("Wire size", pick[0], "AWG"), L("Voltage drop there and back", drop, "V"), L("Drop", (drop / V) * 100, "%")],
          method: ["Pick the thinnest wire whose chassis ampacity ≥ I and whose 2·R·L·I drop ≤ the limit", ...(fits ? [] : [`Nothing up to 10 AWG (30 A) fits ${sig(I)} A over ${sig(len * 1000)} mm: use thicker wire, parallel runs or a shorter run`])],
          assumptions: ["Copper, chassis wiring in free air, PVC or silicone insulation"],
          confidence: "standard",
        },
      };
    },
  ),

  calcFn(
    "bearing_life",
    ["bearing", "load", "rpm"],
    "L10 bearing life. bearing: a lib.bearing component or code like \"6808\"; load: equivalent radial load (N); rpm. Returns hours, time (s, to compare with times like 2000h) and c_ratio.",
    (a) => {
      const bv = a.value("bearing");
      const code = typeof bv === "string" ? bv : bv instanceof Obj ? String(bv.fields.code ?? "") : "";
      const b = BEARINGS[code];
      if (!b) return a.ctx.error(`calc.bearing_life: unknown bearing "${code}"`);
      const P = a.positive("load");
      const n = a.positive("rpm");
      const L10 = Math.pow(b.dynamicLoadN / P, 3);
      const hours = (L10 * 1e6) / (60 * n);
      return {
        fields: { hours, time: hours * 3600, c_ratio: b.dynamicLoadN / P },
        trace: {
          fn: "",
          title: `Bearing ${code}: life`,
          inputs: [L("Dynamic load rating C", b.dynamicLoadN, "N"), L("Load", P, "N"), L("Speed", n, "rpm")],
          outputs: [L("L10 life", hours, "h"), L("C / P", b.dynamicLoadN / P, "×")],
          method: ["L10 = (C/P)³ million revolutions"],
          assumptions: ["Clean, lubricated bearing: sand ingress shortens this a lot"],
          confidence: "standard",
        },
      };
    },
  ),

  calcFn(
    "print_speed",
    ["flow", "layer", "width"],
    "Highest print speed a hotend's melt rate allows. flow: max volumetric flow (mm³/s); layer: layer height (0.2); width: line width (0.45). Returns speed (mm/s).",
    (a) => {
      const f = a.positive("flow");
      const h = a.num("layer", 0.2);
      const w = a.num("width", 0.45);
      const v = f / (h * w);
      return {
        fields: { speed: v },
        trace: {
          fn: "",
          title: "Melt-limited print speed",
          inputs: [L("Hotend flow", f, "mm³/s"), L("Layer height", h, "mm"), L("Line width", w, "mm")],
          outputs: [L("Highest print speed", v, "mm/s")],
          method: ["v = flow/(layer·width)"],
          assumptions: ["Maker's flow figure for PLA at about 220 °C"],
          confidence: "estimate",
          verify: "Print a flow-rate tower and see where the extrusion starts to thin.",
        },
      };
    },
  ),

  calcFn(
    "hinge_steer",
    ["thrust", "angle", "front_length", "d", "sigma_h", "factor"],
    "Moment needed to hold a steering hinge at an angle while burrowing. thrust: axial force through the hinge (N); angle: articulation (deg); front_length: hinge to nose (mm); d: diameter (mm); sigma_h: sideways soil stress (MPa); factor: share of the sideways soil pressure that acts (0.3). Returns moment, moment_thrust and moment_soil (N·mm).",
    (a) => {
      const F = a.num("thrust");
      const ang = a.num("angle", 8);
      const Lf = a.positive("front_length");
      const d = a.positive("d");
      const sh = a.num("sigma_h");
      const k = a.num("factor", 0.3);
      const Mthrust = F * Math.sin(ang * D2R) * (Lf / 2);
      // the front section pivots about its nose as the hinge behind it is pushed along the
      // rear axis, so the sideways soil reaction grows from the nose to the hinge
      const Msoil = (k * sh * d * Lf * Lf) / 6;
      const M = Mthrust + Msoil;
      return {
        fields: { moment: M, moment_thrust: Mthrust, moment_soil: Msoil },
        trace: {
          fn: "",
          title: "Steering hinge moment",
          inputs: [L("Thrust through the hinge", F, "N"), L("Hinge angle", ang, "°"), L("Front section length", Lf, "mm"), L("Diameter", d, "mm"), L("Sideways stress σh", sh * 1000, "kPa"), L("Share of soil pressure acting", k * 100, "%")],
          outputs: [L("Moment to hold the angle", M / 1000, "N·m"), L("  from the thrust", Mthrust / 1000, "N·m"), L("  from the soil on the side", Msoil / 1000, "N·m")],
          method: ["Thrust misalignment: F·sin θ·L/2", "Soil on the side of the front section, rising from nothing at the nose to k·σh·d per mm at the hinge: k·σh·d·L²/6"],
          assumptions: ["The hinge turns gradually while the robot advances, so the front section pivots about its nose", "Only part (k) of the sideways soil stress is mobilised at these small sideways movements: k is a guess"],
          confidence: "rough",
          verify: "In the test barrel, command full steering while advancing and measure the turn radius and the actuator current.",
        },
      };
    },
  ),

  calcFn(
    "actuator_moment",
    ["actuator", "arm", "slope", "friction"],
    "Moment a linear actuator gives on a lever, directly or through a cam slot. actuator: catalog actuator component; arm: hinge to where the force acts, at right angles (mm); slope: sideways movement per mm of stroke for a slanted cam slot (leave out for a direct push); friction: coefficient in the slot (0.2). Returns moment, hold_moment (N·mm, a huge number when self-locking), self_locking and travel_ratio.",
    (a) => {
      const act = a.value("actuator");
      const f = spec(act, "f_max", a.ctx, "actuator");
      const fb = act instanceof Obj && typeof act.fields.f_backdrive === "number" ? (act.fields.f_backdrive as number) : f;
      const arm = a.positive("arm");
      const s = a.num("slope", 0);
      const mu = a.num("friction", 0.2);
      if (s <= 0) {
        return {
          fields: { moment: f * arm, hold_moment: fb * arm, self_locking: false, travel_ratio: 1 },
          trace: {
            fn: "",
            title: `${compName(act)}: steering moment`,
            inputs: [L("Actuator force", f, "N"), L("Back-drive force", fb, "N"), L("Lever arm", arm, "mm")],
            outputs: [L("Moment it can drive", (f * arm) / 1000, "N·m"), L("Moment it can hold unpowered", (fb * arm) / 1000, "N·m")],
            method: ["M = F·arm"],
            assumptions: ["Maker's peak force; continuous force is lower"],
            confidence: "standard",
          },
        };
      }
      // wedge with friction on the slot face: the pin is driven sideways by the slanted slot
      const drive = (f * (1 - mu * s)) / (s + mu);
      const lock = s <= mu;
      const back = lock ? Infinity : (fb * (1 + mu * s)) / (s - mu);
      return {
        fields: { moment: drive * arm, hold_moment: lock ? Infinity : back * arm, self_locking: lock, travel_ratio: s },
        trace: {
          fn: "",
          title: `${compName(act)}: steering moment through a cam slot`,
          inputs: [L("Actuator force", f, "N"), L("Back-drive force", fb, "N"), L("Lever arm", arm, "mm"), L("Slot slope (sideways per stroke)", s, "×"), L("Slot friction", mu, "")],
          outputs: [
            L("Sideways force on the pin", drive, "N"),
            L("Moment it can drive", (drive * arm) / 1000, "N·m"),
            L("Slope ÷ friction", s / mu, "×", lock ? "1 or less, so the slot self-locks: the soil cannot push the steering back unpowered" : "Above 1, so the soil can back-drive it"),
            ...(lock ? [] : [L("Moment it can hold unpowered", (back * arm) / 1000, "N·m")]),
          ],
          method: ["Wedge with friction: F_side = F·(1 − μ·s)/(s + μ)", "Back-driving needs F_side > F_backdrive·(1 + μ·s)/(s − μ), impossible when s ≤ μ", "M = F_side·arm"],
          assumptions: ["Maker's peak force; continuous force is lower", "Slot friction μ is a guess: about 0.15 to 0.3 for a greased steel pin in a printed slot", "Small angles: the arm barely changes over the travel"],
          confidence: "estimate",
          verify: "Clamp the front section, push its nose sideways with a spring scale and check the angle does not move.",
        },
      };
    },
  ),

  calcFn(
    "conveying",
    ["d", "core_d", "pitch", "rpm", "fill", "body_d", "advance"],
    "Can a screw carry the sand its nose cuts? d: flight diameter; core_d: shell diameter; pitch (mm); rpm; fill: channel fill fraction (0.4); body_d: diameter of the hole (mm, d); advance: forward speed (mm/s). Returns capacity and needed (mm³/s) and ratio.",
    (a) => {
      const D = a.positive("d");
      const dc = a.positive("core_d");
      const p = a.positive("pitch");
      const n = a.positive("rpm");
      const fill = a.num("fill", 0.4);
      const bd = a.num("body_d", D);
      const v = a.positive("advance");
      const cap = ((Math.PI * (D * D - dc * dc)) / 4) * p * (n / 60) * fill;
      const need = ((Math.PI * bd * bd) / 4) * v;
      return {
        fields: { capacity: cap, needed: need, ratio: cap / need },
        trace: {
          fn: "",
          title: "Sand conveying along the flights",
          inputs: [L("Flight diameter", D, "mm"), L("Shell diameter", dc, "mm"), L("Pitch", p, "mm"), L("Speed", n, "rpm"), L("Channel fill", fill * 100, "%"), L("Advance speed", v, "mm/s")],
          outputs: [L("Sand the flights can move", cap / 1000, "cm³/s"), L("Sand the nose cuts", need / 1000, "cm³/s"), L("Capacity / need", cap / need, "×")],
          method: ["Capacity = π(D² − d²)/4 · p · n · fill", "Need = π·D²/4 · advance speed"],
          assumptions: ["Fill fraction for dry sand in a horizontal screw is a guess (0.3 to 0.5)"],
          confidence: "estimate",
          verify: "Watch the spoil behind the robot in the test barrel: if the nose stalls while the screws still turn, the flights are not clearing the face.",
        },
      };
    },
  ),
]);

export function calcNamespace(): Obj {
  return new Obj({ ...CALC_FNS }, "calculators", "calc");
}

export function isCalc(v: Value): v is CalcObj {
  return v instanceof CalcObj;
}
