// More motors: steppers from NEMA 8 to NEMA 34, DC gearmotors from N20 and
// TT to 25 mm and 37 mm, more goBILDA and Pololu ratios, brushless
// outrunners, micro servos and longer linear actuators. Each has its
// mounting interface (bolt pattern, pilot or boss, screw size and thread
// depth, shaft with its flat or key) so mounts can be made to fit it.
// Spec keys use Kerf base units: torque in N·mm, length in mm, current in A,
// voltage in V, mass in g. Parts marked generic are sold by many sellers:
// their figures are typical listing values.

import type { CatalogPart } from "../types";
import { dcMotorPins, gobilda, kgcm, nema17, pololu37, servoPins, stepperPlug } from "./motion";
import { pwrIn } from "./pins";

interface StepperSpec {
  id: string;
  name: string;
  maker?: string;
  generic: boolean;
  frame: 8 | 11 | 14 | 17 | 23 | 34;
  len: number;
  i: number;
  r: number;
  l: number;
  hold: number;
  mass: number;
  price: number;
  shaft_d: number;
  shaft_l: number;
  key_w?: number;
  url?: string;
  search: string;
}

// face size, hole spacing, hole (tap drill or clearance), thread depth or flange, pilot, front-bearing radial rating
const FRAMES = {
  8: { size: 20.3, spacing: 16, hole_d: 1.6, depth: 2.5, flange_t: 0, pilot_d: 15, pilot_h: 1.5, radial: 10, holes: "4 × M2 tapped 2.5 deep on a 16 mm square" },
  11: { size: 28.2, spacing: 23, hole_d: 2.05, depth: 2.5, flange_t: 0, pilot_d: 22, pilot_h: 2, radial: 15, holes: "4 × M2.5 tapped 2.5 deep on a 23 mm square" },
  14: { size: 35.2, spacing: 26, hole_d: 2.5, depth: 3.5, flange_t: 0, pilot_d: 22, pilot_h: 2, radial: 20, holes: "4 × M3 tapped 3.5 deep on a 26 mm square" },
  17: { size: 42.3, spacing: 31, hole_d: 2.5, depth: 4.5, flange_t: 0, pilot_d: 22, pilot_h: 2, radial: 28, holes: "4 × M3 tapped 4.5 deep on a 31 mm square" },
  23: { size: 56.4, spacing: 47.14, hole_d: 5.2, depth: 0, flange_t: 5, pilot_d: 38.1, pilot_h: 1.6, radial: 75, holes: "4 × 5.2 mm through holes on a 47.14 mm square (M5 bolts and nuts)" },
  34: { size: 86, spacing: 69.6, hole_d: 6.5, depth: 0, flange_t: 10, pilot_d: 73, pilot_h: 2, radial: 220, holes: "4 × 6.5 mm through holes on a 69.6 mm square (M6 bolts and nuts)" },
} as const;

function stepper(s: StepperSpec): CatalogPart {
  const f = FRAMES[s.frame];
  return {
    id: s.id,
    kind: "stepper",
    name: s.name,
    maker: s.maker,
    generic: s.generic,
    summary: `NEMA ${s.frame} bipolar stepper, ${s.len} mm body, ${s.i} A per phase, ${(s.hold / 1000).toFixed(s.hold < 100 ? 3 : 2)} N·m holding, ${s.r} Ω, ${s.l} mH, ${s.shaft_d} mm ${s.key_w ? "keyed" : "D"} shaft, ${f.holes}.`,
    specs: { frame: s.frame, step_deg: 1.8, i_rated: s.i, r_phase: s.r, l_phase: s.l, t_hold: s.hold, mass_g: s.mass, shaft_d: s.shaft_d, radial_n: f.radial, radial_at: 20 },
    pins: stepperPlug(s.i),
    geom: {
      g: "stepper",
      dims: { size: f.size, l: s.len, pilot_d: f.pilot_d, pilot_h: f.pilot_h, shaft_d: s.shaft_d, shaft_l: s.shaft_l, hole_spacing: f.spacing, hole_d: f.hole_d, ...(f.depth ? { hole_depth: f.depth } : {}), ...(f.flange_t ? { flange_t: f.flange_t } : {}), ...(s.key_w ? { key_w: s.key_w } : {}) },
    },
    price_usd: s.price,
    buy: [...(s.url ? [{ vendor: "StepperOnline", url: s.url }] : []), { vendor: "Marketplace", search: s.search }],
    source: s.url,
    notes: [
      "Run it at 70 to 85 % of the rated current. Check the phase pairs with a multimeter before plugging in: cable colours vary.",
      ...(f.flange_t ? [`The flange holes are through holes: bolt it with ${s.frame === 23 ? "M5" : "M6"} bolts and nuts, or screws into a tapped plate.`] : [`Screw in no deeper than ${f.depth} mm: longer screws bottom out in the holes.`]),
    ],
  };
}

function jga25(ratio: number, rpm: number, stallKgcm: number, gearL: number): CatalogPart {
  return {
    id: `jga25_370_12v_${String(ratio).replace(".", "_")}`,
    kind: "gearmotor",
    name: `JGA25-370 gearmotor 12 V ${ratio}:1 (${rpm} rpm)`,
    generic: true,
    summary: `25 mm spur gearmotor, 12 V, ${rpm} rpm free, ${(kgcm(stallKgcm) / 1000).toFixed(2)} N·m stall at 1.5 A, 4 mm D shaft, 2 × M3 holes 17 mm apart in the face.`,
    specs: { v_rated: 12, ratio, rpm_free: rpm, i_free: 0.05, i_stall: 1.5, t_stall: kgcm(stallKgcm), shaft: "4 mm D (3.5 across the flat)", mass_g: 95 },
    pins: dcMotorPins(12),
    geom: { g: "gearmotor", dims: { gear_d: 25, gear_l: gearL, motor_d: 24.4, motor_l: 30.8, shaft_d: 4, shaft_l: 9.6, shaft_flat: 0.5, boss_d: 7, boss_h: 2.5, hole_d: 2.5, hole_depth: 4.5 }, holes: [[8.5, 0], [-8.5, 0]], color: "#b3b8bf", color2: "#d4d8dc" },
    price_usd: 9,
    buy: [{ vendor: "Marketplace", search: `JGA25-370 12V ${rpm}rpm gear motor` }],
    notes: ["Sold by many sellers with small differences: check the shaft and hole spacing on yours.", "Screw in no deeper than 4.5 mm.", "Run it below about half the stall torque continuously."],
  };
}

function pololuMicro(ratio: number, rpm: number, stallKgcm: number): CatalogPart {
  return {
    id: `pololu_micro_hp6v_${ratio}`,
    kind: "gearmotor",
    name: `Pololu ${ratio}:1 Micro Metal Gearmotor HP 6V (N20 size)`,
    maker: "Pololu",
    summary: `12 × 10 mm micro gearmotor, 6 V, ${rpm} rpm free, ${(kgcm(stallKgcm) / 1000).toFixed(3)} N·m stall at 1.6 A, 3 mm D shaft, 2 × M1.6 holes 9 mm apart in the face.`,
    specs: { v_rated: 6, ratio, rpm_free: rpm, i_free: 0.1, i_stall: 1.6, t_stall: kgcm(stallKgcm), shaft: "3 mm D (2.5 across the flat)", mass_g: 9.5 },
    pins: dcMotorPins(6),
    geom: { g: "micro_gearmotor", dims: { w: 12, t: 10, gear_l: 9, motor_l: 15, shaft_d: 3, shaft_flat: 0.5, shaft_l: 10, boss_d: 4, boss_h: 0.8, hole_spacing: 9, hole_d: 1.25, hole_depth: 2 } },
    price_usd: 22,
    buy: [{ vendor: "Pololu", search: `Pololu ${ratio}:1 Micro Metal Gearmotor HP 6V` }, { vendor: "Marketplace", search: `N20 gear motor 6V ${rpm}rpm` }],
    source: "https://www.pololu.com/category/60/micro-metal-gearmotors",
    notes: ["Clamp it with a bracket round the gearbox (Pololu sells them) or two M1.6 screws in the face, no deeper than 2 mm.", "Generic N20 motors have the same body but weaker, varied gearing."],
  };
}

function p16(stroke: number, price: number, mass: number): CatalogPart {
  const ret = stroke + 47;
  return {
    id: `actuonix_p16p_${stroke}_256`,
    kind: "actuator",
    name: `Actuonix P16-P linear actuator, ${stroke} mm stroke, 256:1, 12 V, with position feedback`,
    maker: "Actuonix",
    mpn: `P16-${stroke}-256-12-P`,
    summary: `Lead-screw linear actuator, ${stroke} mm stroke, 250 N at 2.5 mm/s, 300 N maximum, 12 V, 1 A stall, potentiometer feedback, 4 mm clevis pins.`,
    specs: { v_rated: 12, f_max: 300, f_backdrive: 500, speed_mm_s: 2.5, speed_free_mm_s: 4.8, stroke, i_stall: 1.0, i_free: 0.06, mass_g: mass, feedback: "potentiometer", ret_l: ret },
    pins: [
      { id: "M_PLUS", label: "Motor V+ (pin 3, red)", type: "motor", v: 12, channel: "M", required: true },
      { id: "M_MINUS", label: "Motor V− (pin 4, black)", type: "motor", v: 12, channel: "M", required: true },
      pwrIn("FB_VCC", 0, 15, { label: "Feedback + (pin 5, yellow)", draw: 0.0005, required: false, note: "Connect to the controller's analog reference (5 V or 3.3 V)" }),
      { id: "FB_GND", type: "gnd", label: "Feedback − (pin 1, orange)" },
      { id: "FB", type: "analog_out", v: 5, vref: "FB_VCC", label: "Feedback wiper (pin 2, purple)" },
    ],
    geom: { g: "actuator", dims: { body_w: 20.6, body_d: 15.6, body_l: stroke + 30, rod_d: 6, stroke, ret_l: ret } },
    price_usd: price,
    buy: [{ vendor: "Actuonix", url: "https://www.actuonix.com/p16-p" }, { vendor: "Marketplace", search: `Actuonix P16-P ${stroke}mm 256:1 12V` }],
    source: "https://www.actuonix.com/p16-p",
    notes: ["Needs a small DC motor driver and an analog pin: the firmware closes the position loop.", "Mount both ends on pins so it can swing: side load bends the rod."],
  };
}

export const MOTORS: CatalogPart[] = [
  // ---- steppers ----
  stepper({ id: "nema8_8hs15_0604s", name: "NEMA 8 stepper 8HS15-0604S (38 mm, 0.6 A)", generic: true, frame: 8, len: 38, i: 0.6, r: 10.8, l: 5.5, hold: 18, mass: 60, price: 15, shaft_d: 4, shaft_l: 15, search: "NEMA 8 stepper motor 20x20x38mm 0.6A" }),
  stepper({ id: "nema11_11hs20_0674s", name: "NEMA 11 stepper 11HS20-0674S (51 mm, 0.67 A)", generic: true, frame: 11, len: 51, i: 0.67, r: 8, l: 6.5, hold: 95, mass: 200, price: 16, shaft_d: 5, shaft_l: 20, search: "NEMA 11 stepper motor 28x28x51mm" }),
  stepper({ id: "nema14_14hs11_1004s", name: "StepperOnline 14HS11-1004S NEMA 14 (28 mm, 1 A)", maker: "StepperOnline", generic: false, frame: 14, len: 28, i: 1.0, r: 3.5, l: 3.5, hold: 125, mass: 130, price: 12, shaft_d: 5, shaft_l: 24, search: "14HS11-1004S NEMA 14 stepper" }),
  nema17("nema17_17hs3401", "NEMA 17 stepper 17HS3401 (34 mm, 1.3 A)", undefined, true, { i: 1.3, r: 2.4, l: 2.8, hold: 280, len: 34, inertia: 34, mass: 220, price: 9, search: "17HS3401 NEMA 17 stepper motor 34mm" }),
  nema17("nema17_17hs24_2104s", "StepperOnline 17HS24-2104S NEMA 17 (60 mm, 2.1 A)", "StepperOnline", false, { i: 2.1, r: 1.6, l: 3.0, hold: 650, len: 60, inertia: 140, mass: 500, price: 16, search: "17HS24-2104S NEMA 17 60mm" }),
  stepper({ id: "nema23_23hs30_2804s", name: "StepperOnline 23HS30-2804S NEMA 23 (76 mm, 2.8 A)", maker: "StepperOnline", generic: false, frame: 23, len: 76, i: 2.8, r: 1.13, l: 5.4, hold: 1900, mass: 1150, price: 35, shaft_d: 6.35, shaft_l: 21, search: "23HS30-2804S NEMA 23 1.9Nm" }),
  stepper({ id: "nema23_23hs45_4204s", name: "StepperOnline 23HS45-4204S NEMA 23 (112 mm, 4.2 A)", maker: "StepperOnline", generic: false, frame: 23, len: 112, i: 4.2, r: 0.9, l: 3.8, hold: 3000, mass: 1800, price: 50, shaft_d: 8, shaft_l: 21, search: "23HS45-4204S NEMA 23 3Nm 8mm shaft" }),
  stepper({ id: "nema34_80mm_4_5nm", name: "NEMA 34 stepper (80 mm, 4.5 N·m, 6 A)", generic: true, frame: 34, len: 80, i: 6, r: 0.45, l: 4, hold: 4500, mass: 2300, price: 60, shaft_d: 14, shaft_l: 32, key_w: 5, search: "NEMA 34 stepper motor 4.5Nm 80mm 14mm keyed shaft" }),
  stepper({ id: "nema34_114mm_8_5nm", name: "NEMA 34 stepper (114 mm, 8.5 N·m, 6 A)", generic: true, frame: 34, len: 114, i: 6, r: 0.6, l: 6, hold: 8500, mass: 3800, price: 90, shaft_d: 14, shaft_l: 32, key_w: 5, search: "NEMA 34 stepper motor 8.5Nm 14mm keyed shaft" }),

  // ---- DC gearmotors ----
  gobilda("13.7", 13.7, 435, 18.7, 383.6, 41.4, 40, 430),
  gobilda("26.9", 26.9, 223, 33.9, 753.2, 41.4, 40, 440),
  gobilda("50.9", 50.9, 117, 68.4, 1425.2, 50.1, 42, 480),
  gobilda("99.5", 99.5, 60, 133.2, 2786.2, 50.1, 42, 490),
  pololu37(19, 4751, 530, 8, 1216, 22, 190),
  pololu37(30, 4752, 330, 14, 1920, 22, 195),
  pololu37(70, 4754, 150, 27, 4480, 24, 205),
  pololu37(100, 4755, 100, 34, 6400, 26.5, 210),
  jga25(21.3, 282, 2.5, 19),
  jga25(46.8, 128, 6, 21),
  jga25(78, 77, 9, 23),
  jga25(103, 58, 10, 23),
  jga25(226, 27, 15, 25),
  pololuMicro(30, 1000, 0.65),
  pololuMicro(100, 320, 2.2),
  pololuMicro(298, 100, 5),
  {
    id: "tt_motor_48_6v",
    kind: "gearmotor",
    name: "TT gearmotor 1:48, 3 to 6 V (yellow hobby motor)",
    generic: true,
    summary: "Plastic hobby gearmotor, 200 rpm free and about 0.08 N·m stall at 6 V, 150 mA unloaded, double-D shaft through both sides, two through holes for M3 screws.",
    specs: { v_rated: 6, ratio: 48, rpm_free: 200, i_free: 0.15, i_stall: 1.1, t_stall: kgcm(0.8), shaft: "5.4 mm double-D (3.7 across the flats)", mass_g: 30.6 },
    pins: dcMotorPins(6),
    geom: { g: "tt_motor", dims: { gear_l: 37, gear_w: 22.5, gear_t: 18.8, shaft_x: 11, motor_d: 20, motor_t: 15, motor_l: 25, shaft_d: 5.4, shaft_af: 3.7, shaft_l: 9, hole_d: 3.2 }, holes: [[-20, 8], [-20, -8]] },
    price_usd: 2,
    buy: [{ vendor: "Marketplace", search: "TT gear motor 1:48 3-6V dual shaft" }],
    notes: ["Hole positions differ between makers: measure yours before printing a mount and slot the mount holes by a millimetre.", "Plastic gears: keep the load well under the stall torque and expect wear."],
  },

  // ---- brushless outrunners ----
  {
    id: "a2212_1000kv",
    kind: "bldc",
    name: "A2212 1000 kV brushless outrunner",
    generic: true,
    summary: "28 mm outrunner for 3S (11.1 V) with 10 × 4.5 in props, 1000 rpm per volt, 12 A continuous, 3.17 mm shaft, M3 holes 16 and 19 mm apart in the back. Needs a 20 to 30 A ESC.",
    specs: { kv: 1000, v_nom: 11.1, v_max: 12.6, i_max: 12, i_free: 0.5, poles: 14, mass_g: 47, shaft_d: 3.17, esc_a: 30 },
    pins: [
      { id: "PHASE_A", label: "Phase A", type: "motor", v: 12.6, channel: "M", required: false, note: "Brushless: wire the three phases to an ESC, not a brushed motor driver" },
      { id: "PHASE_B", label: "Phase B", type: "motor", v: 12.6, channel: "M", required: false },
      { id: "PHASE_C", label: "Phase C", type: "motor", v: 12.6, channel: "M", required: false },
    ],
    geom: { g: "outrunner", dims: { base_d: 27.7, base_h: 4, bell_d: 27.7, bell_h: 22, shaft_d: 3.17, shaft_l: 12, hole_d: 2.5, hole_depth: 3 }, holes: [[8, 0], [-8, 0], [0, 9.5], [0, -9.5]], color: "#2a2e35", color2: "#b9bfc7" },
    price_usd: 10,
    buy: [{ vendor: "Marketplace", search: "A2212 1000KV brushless motor" }],
    notes: ["M3 screws no deeper than 3 mm into the back: longer ones cut into the windings.", "Swap any two phase wires to reverse it."],
  },
  {
    id: "fpv_2207_1750kv",
    kind: "bldc",
    name: "2207 1750 kV brushless motor (6S FPV)",
    generic: true,
    summary: "27.5 mm outrunner for 6S (22.2 V) with 5 in props, 1750 rpm per volt, about 35 A peak, M5 shaft, 4 × M3 on a 16 mm circle. Needs a 35 A or bigger ESC.",
    specs: { kv: 1750, v_nom: 22.2, v_max: 25.2, i_max: 35, i_free: 1.2, poles: 14, mass_g: 33, shaft_d: 5, esc_a: 45 },
    pins: [
      { id: "PHASE_A", label: "Phase A", type: "motor", v: 25.2, channel: "M", required: false, note: "Brushless: wire the three phases to an ESC" },
      { id: "PHASE_B", label: "Phase B", type: "motor", v: 25.2, channel: "M", required: false },
      { id: "PHASE_C", label: "Phase C", type: "motor", v: 25.2, channel: "M", required: false },
    ],
    geom: { g: "outrunner", dims: { base_d: 27.5, base_h: 3, bell_d: 27.5, bell_h: 16, shaft_d: 5, shaft_l: 12, hole_d: 2.5, hole_depth: 3 }, holes: [[8, 0], [0, 8], [-8, 0], [0, -8]], color: "#16191e", color2: "#c0392b" },
    price_usd: 20,
    buy: [{ vendor: "Marketplace", search: "2207 1750KV brushless motor 6S" }],
    notes: ["M3 screws no deeper than 3 mm into the base."],
  },

  // ---- micro servos ----
  {
    id: "sg90",
    kind: "servo",
    name: "SG90 9 g micro servo",
    generic: true,
    summary: "Micro servo, about 0.18 N·m stall at 4.8 V, 4.8 to 6 V, plastic gears, 0.1 s per 60°.",
    specs: { t_stall: kgcm(1.8), v_min: 4.8, v_max: 6, speed_s_per_60: 0.1, i_stall: 0.65, i_run: 0.15, mass_g: 9, range_deg: 180 },
    pins: servoPins(4.8, 6, 0.15),
    geom: { g: "servo", dims: { w: 22.8, d: 12.2, h: 22.7, flange_w: 32.3, flange_t: 2.5, flange_z: 4.5, shaft_x: 5.9, spline_d: 4.8, screw: 2 }, holes: [[8, 0], [-19.8, 0]], hole_d: 2 },
    price_usd: 2,
    buy: [{ vendor: "Marketplace", search: "SG90 micro servo" }],
    notes: ["The supplied screws are M2 self-tappers through the tabs into the plate."],
  },
  {
    id: "mg90s",
    kind: "servo",
    name: "MG90S metal-gear micro servo",
    generic: true,
    summary: "Micro servo, about 0.22 N·m stall at 4.8 V, 4.8 to 6 V, metal gears, 0.1 s per 60°.",
    specs: { t_stall: kgcm(2.2), v_min: 4.8, v_max: 6, speed_s_per_60: 0.1, i_stall: 0.7, i_run: 0.15, mass_g: 13.4, range_deg: 180 },
    pins: servoPins(4.8, 6, 0.15),
    geom: { g: "servo", dims: { w: 22.8, d: 12.2, h: 22.7, flange_w: 32.3, flange_t: 2.5, flange_z: 4.5, shaft_x: 5.9, spline_d: 4.8, screw: 2 }, holes: [[8, 0], [-19.8, 0]], hole_d: 2, color: "#22262c" },
    price_usd: 4,
    buy: [{ vendor: "Marketplace", search: "MG90S metal gear servo" }],
  },

  // ---- linear actuators ----
  p16(100, 100, 120),
  p16(150, 105, 145),
  {
    id: "linear_actuator_12v_100mm_900n",
    kind: "actuator",
    name: "12 V linear actuator, 100 mm stroke, 900 N",
    generic: true,
    summary: "Electric push rod with built-in limit switches, 900 N at about 10 mm/s, 12 V, 3 A at full load, 6 mm clevis pins, 210 mm closed.",
    specs: { v_rated: 12, f_max: 900, f_backdrive: 900, speed_mm_s: 10, speed_free_mm_s: 14, stroke: 100, i_stall: 3, i_free: 0.6, mass_g: 1100, ret_l: 210 },
    pins: [
      { id: "M_PLUS", label: "Red", type: "motor", v: 12, channel: "M", required: true },
      { id: "M_MINUS", label: "Black", type: "motor", v: 12, channel: "M", required: true },
    ],
    geom: { g: "actuator", dims: { body_w: 33, body_d: 55, body_l: 200, rod_d: 20, stroke: 100, ret_l: 210, pin_d: 6 } },
    price_usd: 35,
    buy: [{ vendor: "Marketplace", search: "12V linear actuator 100mm stroke 900N" }],
    notes: ["Reverse the polarity to retract; the limit switches stop it at each end.", "Sizes vary between sellers: check the closed length and pin size on the listing."],
  },
];
