// Where each pin's plug sits on its part, what kind of connector it is, and
// the wires inside each kind of cable. The 3D wiring draws a real connector
// body at every wire end from this, so you can see what plugs into what.
//
// Positions are in the part's own frame, the frame the part's geometry is
// built in (machine/geometry.ts): a board's origin is the centre of its
// underside with the top face at z = t, a stepper's is the centre of its
// mounting face with the body along -Z, a box's is the centre of its bottom.
// `out` points the way the plug goes in, away from the part, and `row` runs
// along the line of contacts. Parts without an entry get a plug placed from
// their geometry class, so every design draws, just less exactly.

import type { V3 } from "../../kernel/recipe";
import type { CatalogPart, PinDef } from "../types";
import { pinSpots } from "../boards3d/pins";
import { FIELD_PLUGS } from "./fieldPlugs";

export type PlugKind =
  /** JST XH 2.50 mm: printer board headers, stepper and fan leads */
  | "xh"
  /** JST PH 2.00 mm: the socket on a stepper's end cap */
  | "ph"
  /** 2.54 mm Dupont housing on a pin header */
  | "dupont"
  /** bootlace ferrule in a screw terminal */
  | "ferrule"
  /** fork crimp under a barrier-strip screw (power supplies) */
  | "fork"
  /** ring crimp on a stud or screw */
  | "ring"
  | "usb_c"
  | "usb_micro"
  /** USB-A plug on a cable, into a computer's socket */
  | "usb_a"
  /** XT60 battery connector */
  | "xt60"
  /** a lead that leaves the part itself (fans, heater cartridges, sensors) */
  | "lead"
  /** wire soldered to a pad */
  | "solder"
  /** wire soldered through a jack's or switch's solder lug, under heatshrink */
  | "lug"
  /** 5.5 × 2.1 mm DC barrel plug on a power brick's cord */
  | "barrel"
  /** 6.3 mm insulated female spade on a tab (switches, motors) */
  | "spade"
  /** JST SH 1.0 mm: the STEMMA QT and Qwiic plug */
  | "sh"
  /** a stripped end in a lever connector (Wago 221) */
  | "lever"
  /** a stripped or tinned end clamped in a screw terminal, with no ferrule */
  | "bare";

export interface PlugSpec {
  kind: PlugKind;
  /** where the plug meets the part: a header's foot on the board, a terminal's wire entry, a lead's exit (mm, part frame) */
  at: V3;
  /** the way the plug goes in, pointing away from the part (unit vector, part frame) */
  out: V3;
  /** along the line of contacts (unit vector, part frame) */
  row: V3;
  /** contact positions in the housing; more than the cable's wires when some are left empty */
  ways?: number;
  /** contact spacing, mm (the kind's standard pitch when left out) */
  pitch?: number;
  /** which contacts the cable's wires go to, in wire order (0 based); the first ones when left out */
  used?: number[];
  /** the part has no header or terminal of its own in its geometry: draw one under the plug */
  socket?: boolean;
  /** identical terminals the same pin also has (a supply's three −V screws): further wires on the pin take these in turn */
  more?: V3[];
}

/** Standard contact pitch of each kind, mm. */
export const PITCH: Record<PlugKind, number> = {
  xh: 2.5,
  ph: 2.0,
  dupont: 2.54,
  ferrule: 5.0,
  fork: 9.5,
  ring: 8,
  usb_c: 0,
  usb_micro: 0,
  usb_a: 0,
  xt60: 7.2,
  lead: 1.6,
  solder: 4,
  lug: 6,
  barrel: 0,
  spade: 6,
  sh: 1.0,
  lever: 5.6,
  bare: 5.0,
};

/** Names shown when a plug is picked. */
export const PLUG_NAME: Record<PlugKind, string> = {
  xh: "JST XH 2.5 mm",
  ph: "JST PH 2.0 mm",
  dupont: "Dupont 2.54 mm",
  ferrule: "ferrule in a screw terminal",
  fork: "fork terminal under the screw",
  ring: "ring terminal",
  usb_c: "USB-C",
  usb_micro: "micro-USB",
  usb_a: "USB-A",
  xt60: "XT60",
  lead: "the part's own lead",
  solder: "soldered to the pad",
  lug: "soldered to the lug",
  barrel: "5.5 × 2.1 mm DC barrel plug",
  spade: "6.3 mm spade",
  sh: "STEMMA QT plug (JST SH 1.0 mm)",
  lever: "stripped end in the lever connector",
  bare: "bare end in the screw terminal",
};

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const NX: V3 = [-1, 0, 0];
const NY: V3 = [0, -1, 0];
const NZ: V3 = [0, 0, -1];

type PlugTable = Record<string, PlugSpec>;

/** a row of plugs along a board edge, all the same kind, centres `step` apart from x0 */
function along(ids: string[], kind: PlugKind, x0: number, step: number, y: number, z: number, ways: number, opts: Partial<PlugSpec> = {}): PlugTable {
  const out: PlugTable = {};
  ids.forEach((id, i) => (out[id] = { kind, at: [x0 + i * step, y, z], out: Z, row: X, ways, socket: true, ...opts }));
  return out;
}

// SKR Mini E3 V3.0, board frame (103.75 × 70.25, top face at z = 1.6). The
// layout follows BTT's board: the screw terminal at the bottom left (POWER,
// HB, HE0, wires entering from the board edge), the stepper headers along the
// top edge in driver order, fans and thermistors along the bottom edge,
// endstops and the probe on the right, USB-C on the right edge. Header
// positions are approximate (within a few mm); the order on each edge is BTT's.
const SKR_T = 1.6;
const SKR: PlugTable = {
  POWER: { kind: "ferrule", at: [-44, -34.7, SKR_T + 5], out: NY, row: X, ways: 1, socket: true },
  POWER_GND: { kind: "ferrule", at: [-39, -34.7, SKR_T + 5], out: NY, row: X, ways: 1, socket: true },
  HB: { kind: "ferrule", at: [-31.5, -34.7, SKR_T + 5], out: NY, row: X, ways: 2, socket: true },
  HE0: { kind: "ferrule", at: [-21.5, -34.7, SKR_T + 5], out: NY, row: X, ways: 2, socket: true },
  ...along(["XM", "YM", "ZAM", "ZBM", "E0M"], "xh", -37.5, 14, 30.5, SKR_T, 4),
  ...along(["FAN0", "FAN1", "FAN2"], "xh", -6, 8.5, -30.5, SKR_T, 2),
  ...along(["TH0", "THB"], "xh", 20, 8.5, -30.5, SKR_T, 2),
  ...along(["XSTOP", "YSTOP"], "xh", 31.5, 11, 30.5, SKR_T, 3),
  ZSTOP: { kind: "xh", at: [42.5, 21, SKR_T], out: Z, row: X, ways: 3, socket: true },
  PROBE: { kind: "dupont", at: [40, -6, SKR_T], out: Z, row: X, ways: 5, socket: true },
  USB: { kind: "usb_c", at: [51.9, 10, SKR_T + 1.6], out: X, row: Y },
};

// Raspberry Pi Zero 2 W (65 × 30, top at 1.4): the 40-pin GPIO header along
// the top edge (pin 1 at the left), micro-USB OTG data port on the bottom edge.
// 5 V goes to GPIO pin 2 and ground to pin 6, outer row.
const PI_T = 1.4;
const PI: PlugTable = {
  V5: { kind: "dupont", at: [-24.13, 12.77, PI_T], out: Z, row: X, ways: 1, socket: true },
  GND: { kind: "dupont", at: [-19.05, 12.77, PI_T], out: Z, row: X, ways: 1, socket: true },
  USB: { kind: "usb_micro", at: [8.9, -15, PI_T + 1.4], out: NY, row: X },
};

// Mean Well LRS-350 (215 × 115 × 30 box, top face up): the barrier strip
// across the +X end, screws facing the top, wires leaving past the end. From
// +Y: L, N, earth, three −V and three +V, 9.5 mm apart.
const LRS_AT = (i: number): V3 => [116.5, 38 - 9.5 * i, 21];
const LRS: PlugTable = {
  AC_L: { kind: "fork", at: LRS_AT(0), out: X, row: Y, ways: 1, socket: true },
  AC_N: { kind: "fork", at: LRS_AT(1), out: X, row: Y, ways: 1, socket: true },
  FG: { kind: "fork", at: LRS_AT(2), out: X, row: Y, ways: 1, socket: true },
  V_MINUS: { kind: "fork", at: LRS_AT(5), out: X, row: Y, ways: 1, socket: true, more: [LRS_AT(4), LRS_AT(3)] },
  V_PLUS: { kind: "fork", at: LRS_AT(6), out: X, row: Y, ways: 1, socket: true, more: [LRS_AT(7), LRS_AT(8)] },
};

const STEPPER_PLUG = (l: number, size: number): PlugSpec => ({
  // the 6-way JST PH socket on the end cap, near the back; the cable uses contacts 1, 3, 4 and 6
  kind: "ph",
  at: [size / 2, 0, -l + 6.5],
  out: X,
  row: Y,
  ways: 6,
  used: [0, 2, 3, 5],
  socket: true,
});

// NeoPixel boards: the wires are soldered to pads on the back and leave straight out behind
// the board, so it is glued over a hole for them. Rings and the jewel have their four pads
// side by side in the board's band at +X; the stick has DIN, 5V and GND at its -X end and
// DOUT at the +X end.
function pixelPads(x: number): PlugTable {
  const pad = (y: number): PlugSpec => ({ kind: "solder", at: [x, y, 0], out: NZ, row: Y, ways: 1 });
  return { V5: pad(-3.75), GND: pad(-1.25), DIN: pad(1.25), DOUT: pad(3.75) };
}
const STICK_PADS: PlugTable = {
  DIN: { kind: "solder", at: [-23.5, 2.5, 0], out: NZ, row: Y, ways: 1 },
  V5: { kind: "solder", at: [-23.5, 0, 0], out: NZ, row: Y, ways: 1 },
  GND: { kind: "solder", at: [-23.5, -2.5, 0], out: NZ, row: Y, ways: 1 },
  DOUT: { kind: "solder", at: [23.5, 0, 0], out: NZ, row: Y, ways: 1 },
};

// a capsule slip ring: the fixed wires leave the end of its body (at), the turning ones the end of its collar
function slipLeads(n: number, len: number): PlugTable {
  const out: PlugTable = {};
  for (let i = 1; i <= n; i++) {
    const a = (2 * Math.PI * (i - 1)) / n;
    const at = (z: number): V3 => [2 * Math.cos(a), 2 * Math.sin(a), z];
    out[`S${i}`] = { kind: "lead", at: at(0), out: NZ, row: X, ways: 1 };
    out[`R${i}`] = { kind: "lead", at: at(len), out: Z, row: X, ways: 1 };
  }
  return out;
}

// ESP32-DevKitC V4 (54.4 × 27.9, antenna at +X): its two 19-pin rows by Espressif's pinout, pin 1 of each at
// the antenna end. J2 is the +Y row (3V3, EN, 36, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, GND, 13, 9, 10, 11, 5V),
// J3 the -Y row (GND, 23, 22, TX0, RX0, 21, GND, 19, 18, 5, 17, 16, 4, 0, 2, 15, 8, 7, 6). The pins point down
// through the board, so Dupont housings push on from underneath (or from above with the board turned over).
function devkitcPins(): PlugTable {
  const out: PlugTable = {};
  const row = (ids: (string | null)[], y: number) =>
    ids.forEach((id, i) => {
      if (id && !out[id]) out[id] = { kind: "dupont", at: [-2 + (9 - i) * 2.54, y, -2.5], out: NZ, row: X, ways: 1 };
    });
  row(["V3V3", null, "IO36", "IO39", "IO34", "IO35", "IO32", "IO33", "IO25", "IO26", "IO27", "IO14", "IO12", "GND", "IO13", null, null, null, "V5"], 12.7);
  row([null, "IO23", "IO22", null, null, "IO21", null, "IO19", "IO18", "IO5", "IO17", "IO16", "IO4", "IO0", "IO2", "IO15", null, null, null], -12.7);
  // the two more ground pins, for further wires on GND
  out.GND.more = [[-2 + 9 * 2.54, -12.7, -2.5], [-2 + 3 * 2.54, -12.7, -2.5]];
  return out;
}

// Waveshare ST3215 / Feetech STS3215 (bus_servo frame: origin on the output axis at the case top): two 3-pin
// 2.5 mm sockets side by side in the recess in the bottom face, GND, VCC, signal across each. The three wires of a
// lead share one 3-way housing, so the three pins sit at the socket's centre, each on its own contact. A lead comes
// in on one socket and the next servo's lead leaves from the other, so a pin's second wire takes the second socket.
const BUS_SERVO: PlugTable = Object.fromEntries(
  (["GND", "V_PLUS", "SIG"] as const).map((id, k): [string, PlugSpec] => [id, { kind: "xh", at: [-14.05, 5.2, -25.6], out: NZ, row: Y, ways: 3, used: [k], more: [[-14.05, -5.2, -25.6]] }]),
);

/**
 * A STEMMA QT socket on a board: the plug goes in flat, the way `out` points, at the socket's mouth. The four
 * contacts (GND, V+, SDA, SCL) share the one housing, so each spot is the same plug with its own contact.
 */
function qtPlugs(id: string, at: V3, out: V3, row: V3): PlugTable {
  const t: PlugTable = {};
  ["GND", "V", "SDA", "SCL"].forEach((s, k) => (t[`${id}_${s}`] = { kind: "sh", at, out, row, ways: 4, used: [k] }));
  return t;
}

// PCA9685 servo board (62.5 × 25.4, top at 1.6). Channel k is a column of three pins near the -Y edge: GND at the
// edge, V+, then the pulse; a servo plug covers all three. The control header's right-angle pins point out of the
// -X end; the power terminal's wires go in from the +Y edge.
const HUB_T = 1.6;
const hubX = (k: number) => -22.86 + 2.54 * (k + Math.floor(k / 4));
const HUB: PlugTable = {};
["GND", "OE", "SCL", "SDA", "VCC", "VP"].forEach((id, i) => (HUB[id] = { kind: "dupont", at: [-31.27, (2.5 - i) * 2.54, HUB_T + 1.27], out: NX, row: Y, ways: 1 }));
for (let k = 0; k < 16; k++) ["G", "V", "P"].forEach((p, i) => (HUB[`${p}${k}`] = { kind: "dupont", at: [hubX(k), -7.62, HUB_T + 2.5], out: Z, row: Y, ways: 3, used: [i] }));
HUB.T_VP = { kind: "bare", at: [-2.54, 12.7, HUB_T + 3.8], out: Y, row: X, ways: 1 };
HUB.T_GND = { kind: "bare", at: [2.54, 12.7, HUB_T + 3.8], out: Y, row: X, ways: 1 };

// Adafruit NAU7802 (25.3 × 23): six 3.5 mm screw terminals along +Y, a STEMMA QT socket at each end
const NAU: PlugTable = { ...qtPlugs("QT1", [-12.65, 0.6, 3.1], NX, Y), ...qtPlugs("QT2", [12.65, 0.6, 3.1], X, NY) };
["E_PLUS", "E_MINUS", "A_MINUS", "A_PLUS", "B_MINUS", "B_PLUS"].forEach((id, i) => (NAU[id] = { kind: "bare", at: [(i - 2.5) * 3.5, 11.5, 1.6 + 3.2], out: Y, row: X, ways: 1, pitch: 3.5 }));

/** Plugs for catalog parts, by catalog id and pin (or spot) id. */
export const PLUGS: Record<string, PlugTable> = {
  ...FIELD_PLUGS,
  esp32_devkitc: devkitcPins(),
  waveshare_st3215: BUS_SERVO,
  // Bus Servo Adapter (A) (42 × 33, top at 1.6): supply screw terminal on the -X edge, the UART header along the
  // +Y edge, the servo port a 3-way socket near the +X edge (positions approximate, from the product photos)
  waveshare_bus_servo_adapter_a: {
    VIN: { kind: "ferrule", at: [-20.3, -4, 5.4], out: NX, row: Y, ways: 1, more: [[-20.3, -4, 5.4]] },
    GND: { kind: "ferrule", at: [-20.3, -9, 5.4], out: NX, row: Y, ways: 1, more: [[-20.3, -9, 5.4]] },
    TX: { kind: "dupont", at: [3.46, 13.5, 4.1], out: Z, row: X, ways: 1 },
    RX: { kind: "dupont", at: [6, 13.5, 4.1], out: Z, row: X, ways: 1 },
    UART_G: { kind: "dupont", at: [8.54, 13.5, 4.1], out: Z, row: X, ways: 1 },
    // the servo port: one 3-way housing for the lead's three wires, each pin on its own contact
    // (a second port beside it is on the same three nets, for a second chain)
    SERVO_G: { kind: "xh", at: [16, 6, 1.6], out: Z, row: Y, ways: 3, used: [0], socket: true, more: [[9.6, 6, 1.6]] },
    SERVO_V: { kind: "xh", at: [16, 6, 1.6], out: Z, row: Y, ways: 3, used: [1], socket: true, more: [[9.6, 6, 1.6]] },
    SERVO_S: { kind: "xh", at: [16, 6, 1.6], out: Z, row: Y, ways: 3, used: [2], socket: true, more: [[9.6, 6, 1.6]] },
  },
  // Arducam B0196 (38 × 38): the 4-pin lead stands out of its socket on the back of the board
  arducam_b0196: { USB: { kind: "lead", at: [0, -8.5, -4.5], out: NZ, row: X, ways: 1 } },
  pca9685_servo_16: HUB,
  nau7802_breakout: NAU,
  // the sockets of boards that take a plug whole; their other pins are found on their headers
  feather_esp32_v2: {
    ...qtPlugs("QT", [-10.75, -4.5, 3.1], NX, Y),
    USB_5V: { kind: "usb_c", at: [-27.95, 0, 3.2], out: NX, row: Y, ways: 2, used: [0] },
    USB_GND: { kind: "usb_c", at: [-27.95, 0, 3.2], out: NX, row: Y, ways: 2, used: [1] },
  },
  lsm6dsox_breakout: { ...qtPlugs("QT1", [-12.8, -1.5, 3.1], NX, Y), ...qtPlugs("QT2", [12.8, -1.5, 3.1], X, NY) },
  // Hobbywing Skywalker 60A V2 (73 × 30 × 12): the two battery leads and the thin signal lead leave one end, the
  // three motor leads the other
  skywalker_60a_v2: {
    B_PLUS: { kind: "lead", at: [-36.5, -4.5, 4.9], out: NX, row: Y, ways: 1 },
    B_MINUS: { kind: "lead", at: [-36.5, 4.5, 4.9], out: NX, row: Y, ways: 1 },
    PHASE_A: { kind: "lead", at: [36.5, -7, 4.9], out: X, row: Y, ways: 1 },
    PHASE_B: { kind: "lead", at: [36.5, 0, 4.9], out: X, row: Y, ways: 1 },
    PHASE_C: { kind: "lead", at: [36.5, 7, 4.9], out: X, row: Y, ways: 1 },
    BEC_GND: { kind: "lead", at: [-36.5, 11.5, 3], out: NX, row: Y, ways: 3, pitch: 1.3, used: [0] },
    BEC_5V: { kind: "lead", at: [-36.5, 11.5, 3], out: NX, row: Y, ways: 3, pitch: 1.3, used: [1] },
    SIG: { kind: "lead", at: [-36.5, 11.5, 3], out: NX, row: Y, ways: 3, pitch: 1.3, used: [2] },
  },
  // Jaycar SP0786 e-stop: each contact's two screw terminals are on opposite sides of its block, behind the panel
  estop_jaycar_sp0786: {
    NC_1: { kind: "bare", at: [-7.5, -17, -30], out: NY, row: X, ways: 1 },
    NC_2: { kind: "bare", at: [-7.5, 17, -30], out: Y, row: X, ways: 1 },
    NO_3: { kind: "bare", at: [7.5, -17, -30], out: NY, row: X, ways: 1 },
    NO_4: { kind: "bare", at: [7.5, 17, -30], out: Y, row: X, ways: 1 },
  },
  // Wago 221 lever connectors: both wires go in the -Y end, side by side
  wago_221_412: {
    A: { kind: "lever", at: [-3.28, -9.3, 2.7], out: NY, row: X, ways: 1 },
    B: { kind: "lever", at: [3.28, -9.3, 2.7], out: NY, row: X, ways: 1 },
  },
  wago_221_612: {
    A: { kind: "lever", at: [-4, -10.55, 3.4], out: NY, row: X, ways: 1 },
    B: { kind: "lever", at: [4, -10.55, 3.4], out: NY, row: X, ways: 1 },
  },
  skr_mini_e3_v3: SKR,
  // KY-023 thumb stick (34 × 26): its five right-angle header pins stick out of the -X end on the top side, in the
  // board's order GND, +5V, VRx, VRy, SW, so Dupont plugs go on along -X
  joystick_ky023: Object.fromEntries(
    ["GND", "VCC", "VRX", "VRY", "SW"].map((id, k): [string, PlugSpec] => [id, { kind: "dupont", at: [-17, (k - 2) * 2.54, 2.87], out: NX, row: Y, ways: 1, socket: true }]),
  ),
  rpi_zero_2w: PI,
  lrs_350_24: LRS,
  // 36 × 26 buck module: input pads at the -X end, output pads at the +X end beside the USB socket
  buck_24v_5v_3a: {
    IN_POS: { kind: "solder", at: [-15.5, 7, 1.6], out: NX, row: Y, ways: 1 },
    IN_NEG: { kind: "solder", at: [-15.5, -7, 1.6], out: NX, row: Y, ways: 1 },
    OUT_POS: { kind: "solder", at: [15.5, 9.5, 1.6], out: X, row: Y, ways: 1 },
    OUT_NEG: { kind: "solder", at: [15.5, -9.5, 1.6], out: X, row: Y, ways: 1 },
  },
  // inline MAXI fuse holder: a 10 AWG pigtail out of each end
  fuse_holder_maxi: {
    IN: { kind: "lead", at: [-23, 0, 13], out: NX, row: Y, ways: 1 },
    OUT: { kind: "lead", at: [23, 0, 13], out: X, row: Y, ways: 1 },
  },
  // inline blade fuse holder with a screw terminal in each end (Jaycar SZ2044): a stripped wire goes straight in
  fuse_holder_blade_screw: {
    IN: { kind: "bare", at: [-31, 0, 8], out: NX, row: Y, ways: 1 },
    OUT: { kind: "bare", at: [31, 0, 8], out: X, row: Y, ways: 1 },
  },
  // one way of a terminal strip: a wire in each end of its brass tube
  terminal_strip_30a_way: {
    A: { kind: "bare", at: [0, -11, 7], out: NY, row: X, ways: 1 },
    B: { kind: "bare", at: [0, 11, 7], out: Y, row: X, ways: 1 },
  },
  // ATC blade fuse holder with a screw terminal at each end
  fuse_holder_atc: {
    IN: { kind: "ring", at: [-17, 0, 22], out: NX, row: Y, ways: 1 },
    OUT: { kind: "ring", at: [17, 0, 22], out: X, row: Y, ways: 1 },
  },
  // XH-M542 amp board (79 × 54): 2-way screw terminals for power (y = 14) and the speaker (y = -12)
  // on the -X edge, the 3-way input terminal on the +X edge
  tpa3116_mono: {
    VCC: { kind: "ferrule", at: [-36, 16.5, 5.6], out: NX, row: Y, ways: 1 },
    GND: { kind: "ferrule", at: [-36, 11.5, 5.6], out: NX, row: Y, ways: 1 },
    OUT_P: { kind: "ferrule", at: [-36, -9.5, 5.6], out: NX, row: Y, ways: 1 },
    OUT_N: { kind: "ferrule", at: [-36, -14.5, 5.6], out: NX, row: Y, ways: 1 },
    IN: { kind: "ferrule", at: [38, -5, 5.6], out: X, row: Y, ways: 1 },
    IN_GND: { kind: "ferrule", at: [38, 0, 5.6], out: X, row: Y, ways: 1 },
  },
  nema17_17hs4401: { PLUG: STEPPER_PLUG(40, 42.3) },
  nema17_17hs08_1004s: { PLUG: STEPPER_PLUG(21.5, 42.3) },
  // V6 heater block (23 × 16 × 11.5 at x = 4, z 5 to 16.5): cartridge and thermistor leads leave the -Y face
  e3d_v6_24v: {
    HEATER: { kind: "lead", at: [9, -8, 10.75], out: NY, row: Z, ways: 2, pitch: 2.4 },
    THERM: { kind: "lead", at: [-2, -8, 8], out: NY, row: X, ways: 2, pitch: 1.2 },
  },
  // 235 mm bed: heater and thermistor wires soldered to pads under the back edge
  heated_bed_235_24v: {
    HEATER: { kind: "solder", at: [-62, 108, 0], out: NZ, row: X, ways: 2, pitch: 7 },
    THERM: { kind: "solder", at: [-44, 108, 0], out: NZ, row: X, ways: 2, pitch: 4 },
  },
  // fan leads leave the frame at one corner
  fan_4010_24v: { PLUG: { kind: "lead", at: [20, 15, 5], out: X, row: Z, ways: 2 } },
  blower_5015_24v: { PLUG: { kind: "lead", at: [25.5, -19, 7.5], out: X, row: Z, ways: 2 } },
  // mechanical endstop board (40 × 16): XH 3-way at the end away from the switch
  endstop_mech: { PLUG: { kind: "xh", at: [-14, 1, 1.6], out: Z, row: Y, ways: 3, socket: true } },
  // the BLTouch's own 5-wire lead leaves the side of the case next to its mount
  bltouch: { PLUG: { kind: "lead", at: [13, 0, 5], out: X, row: Z, ways: 5, pitch: 1.1 } },
  neopixel_ring_12: pixelPads(15),
  neopixel_ring_16: pixelPads(19),
  neopixel_ring_24: pixelPads(29.5),
  neopixel_ring_60: pixelPads(75.75),
  neopixel_jewel_7: pixelPads(8),
  neopixel_stick_8: STICK_PADS,
  slip_ring_12mm_6: slipLeads(6, 22),
};

/** Wires inside each kind of cable, in contact order: colour and insulated diameter (mm). */
const CABLE_WIRES: Record<string, { colors: string[]; d: number }> = {
  stepper4: { colors: ["black", "green", "red", "blue"], d: 1.3 },
  fan2: { colors: ["red", "black"], d: 1.1 },
  heater2: { colors: ["red", "red"], d: 1.5 },
  therm2: { colors: ["white", "white"], d: 1.0 },
  endstop3: { colors: ["red", "black", "white"], d: 1.1 },
  probe5: { colors: ["brown", "red", "orange", "black", "white"], d: 0.95 },
  usb: { colors: ["black"], d: 3.6 },
};

/** Insulated outside diameter of silicone wire by AWG, mm. */
const AWG_OD: Record<number, number> = { 8: 5.6, 10: 4.4, 12: 3.6, 14: 2.9, 16: 2.4, 18: 2.0, 20: 1.7, 22: 1.5, 24: 1.3, 26: 1.1, 28: 0.95 };

export function wireDiameter(awg: number | undefined): number {
  if (awg === undefined) return 1.5;
  const g = Math.round(awg);
  return AWG_OD[g] ?? (g < 8 ? 6.5 : 0.9);
}

/** The conductors of a cable between two port pins (or one wire): colour names and diameters. */
export function cableWires(port: string | undefined, color: string, gauge: number | undefined): { color: string; d: number }[] {
  const c = port ? CABLE_WIRES[port] : undefined;
  if (c) {
    // a gauge set in the design (heater leads) sizes every wire in the cable
    const d = gauge !== undefined ? wireDiameter(gauge) : c.d;
    return c.colors.map((col) => ({ color: col, d }));
  }
  if (port) {
    // another multi-way port: count its ways from the trailing digit (stepper4, probe5)
    const n = Number(/(\d+)$/.exec(port)?.[1] ?? 1);
    return Array.from({ length: Math.max(1, n) }, (_, i) => ({ color: ["black", "red", "white", "green", "blue", "yellow"][i % 6], d: wireDiameter(gauge ?? 24) }));
  }
  return [{ color, d: wireDiameter(gauge) }];
}

const num = (d: Record<string, number>, k: string, def: number) => (typeof d[k] === "number" ? d[k] : def);

/**
 * Where a ducted fan's k-th motor lead (0, 1, 2) leaves the housing, and the way it points: out of the side at
 * lead_az over the stator (z = -0.7 length, the vanes' middle), one behind the other along the axis, at the end of
 * the short stubs geometry.ts draws.
 */
export function edfLeadExit(d: Record<string, number>, k: number): { p: V3; out: V3 } {
  const od = num(d, "od", 70);
  const L = num(d, "length", 66);
  const a = (num(d, "lead_az", 0) * Math.PI) / 180;
  const u: V3 = [Math.cos(a), Math.sin(a), 0];
  const r = od / 2 + EDF_STUB;
  return { p: [u[0] * r, u[1] * r, -0.7 * L + (Math.max(0, Math.min(2, k)) - 1) * 3.4], out: u };
}
/** how far a ducted fan's motor leads stand out of its housing before the harness takes over, mm */
export const EDF_STUB = 6;

/** the part's natural plug kind when the catalog has no entry for it */
function defaultKind(part: CatalogPart, pin: PinDef): PlugKind {
  if (pin.port === "usb") return "usb_micro";
  if (pin.port) return part.geom.g === "board" ? "xh" : "lead";
  // a pack's own leads, with its connector on the end of them
  if (part.kind === "battery") return "lead";
  if (part.kind === "psu") return "fork";
  if (part.kind === "fuse" || part.kind === "switch") return "spade";
  if (part.geom.g === "gearmotor" || part.geom.g === "micro_gearmotor" || part.geom.g === "tt_motor") return "solder";
  if (part.geom.g === "board") return pin.type === "pwr_in" || pin.type === "gnd" || pin.type === "motor_out" || pin.type === "passive" ? "ferrule" : "dupont";
  return "lead";
}

/**
 * A board's pin with its wire soldered straight to the pad (`leads: "soldered"`):
 * the joint sits on the top face over the pin and the wire leaves it upwards,
 * where a plug would need room for its housing and lead. Other parts keep their own.
 */
export function solderedPlug(part: CatalogPart, spec: PlugSpec): PlugSpec {
  if (part.geom.g !== "board") return spec;
  return { kind: "solder", at: [spec.at[0], spec.at[1], num(part.geom.dims, "t", 1.6)], out: Z, row: spec.row, ways: 1 };
}

/**
 * Where the leads leave the parts the box class draws in detail (geometry.ts
 * boxLook): a LiPo's out of its +X end near the top, an ESC's battery
 * leads out of its -X end and the motor and signal leads out of +X, a mated XT
 * pair's A side out of the bottom and B side out of the top, a bar load
 * cell's out of the side of its gauge potting.
 */
function sideLead(part: CatalogPart, pin: PinDef, w: number, dd: number, h: number): PlugSpec | undefined {
  switch (part.geom.style) {
    case "lipo": {
      const k = part.pins.indexOf(pin);
      return { kind: "lead", at: [w / 2, (k - (part.pins.length - 1) / 2) * 10, h - Math.min(8, h / 4)], out: X, row: Y, ways: 1 };
    }
    case "esc": {
      const mid = (h - Math.min(1.6, h * 0.15) - 0.6) / 2;
      const motor = part.pins.filter((p) => p.type === "motor_out");
      const k = motor.indexOf(pin);
      if (k >= 0) return { kind: "lead", at: [w / 2, (k - (motor.length - 1) / 2) * Math.min(8, dd / 4), mid], out: X, row: Y, ways: 1 };
      const j = part.pins.filter((p) => p.type !== "motor_out").indexOf(pin);
      // the two battery leads at the -X end; the thin signal / BEC lead goes with the motor leads (toward the motor and its controller)
      if (j < 2) return { kind: "lead", at: [-w / 2, (j - 0.5) * Math.min(9, dd / 3.4), mid], out: NX, row: Y, ways: 1 };
      return { kind: "lead", at: [w / 2, dd / 2 - 3.5, Math.min(2 + (j - 2) * 2.5, 2 * mid - 1)], out: X, row: Z, ways: 1 };
    }
    case "xt": {
      const side = /_A$/.test(pin.id) ? 0 : 1;
      const x = (/^NEG|MINUS/.test(pin.id) ? 1 : -1) * w * 0.24;
      return side ? { kind: "lead", at: [x, 0, h], out: Z, row: X, ways: 1 } : { kind: "lead", at: [x, 0, 0], out: NZ, row: X, ways: 1 };
    }
    // a bar load cell's four fine wires come out of the gauge potting on its +Y side
    case "load_cell": {
      const k = part.pins.indexOf(pin);
      return { kind: "lead", at: [(k - (part.pins.length - 1) / 2) * 1.6, dd / 2, h / 2], out: Y, row: X, ways: 1 };
    }
  }
  return undefined;
}

/**
 * The plug for one pin of a part. Parts in PLUGS use their entry; others get
 * a place from their geometry: board pins line up along the long edges,
 * motors take their leads at the back, boxes on the top face, panel jacks and
 * switches at their solder lugs. `peer` is the part at the wire's other end:
 * a power brick's cord plugs into the front of a panel jack. `spot` is the
 * place on the part the wire meets the pin, when it is not the pin's own.
 */
export function plugFor(part: CatalogPart, pinId: string, peer?: CatalogPart, spot?: string): PlugSpec | undefined {
  const pin = part.pins.find((p) => p.id === pinId);
  if (!pin) return undefined;
  // a spot is somewhere else the pin can be reached (a socket's contact, a channel's own supply pin)
  const known = (spot ? PLUGS[part.id]?.[spot] : undefined) ?? PLUGS[part.id]?.[pinId];
  if (known) return known;
  const kind = defaultKind(part, pin);
  const ways = pin.port ? Number(/(\d+)$/.exec(pin.port)?.[1] ?? 1) : 1;
  const d = part.geom.dims;
  const i = part.pins.indexOf(pin);
  const n = part.pins.length;
  switch (part.geom.g) {
    case "depth_camera":
      // the USB-C socket in the +X end, half way back (geometryLegged.ts)
      return { kind: "usb_c", at: [num(d, "w", 90) / 2, 0, num(d, "d", 25) / 2], out: X, row: Y, ways: 1 };
    case "jetson_devkit": {
      // the ports along the -Y edge (geometryLegged.ts): two stacks of two USB-A, and the DC jack
      const top = 3.2 + num(d, "t", 1.6);
      const y = -num(d, "d", 79) / 2 - 1.5;
      const usb = /^USB(\d)$/.exec(pinId);
      if (usb) {
        const k = Number(usb[1]) - 1;
        return { kind: "usb_a", at: [k < 2 ? -8.5 : 9.5, y, top + (k % 2 ? 4.9 : 12.6)], out: NY, row: X, ways: 1 };
      }
      return { kind: "barrel", at: [-40, y, top + 6.2], out: NY, row: X, ways: 1 };
    }
    case "board": {
      // on the header pin or terminal contact drawn on the board, when it has them
      const spot = pinSpots(part).get(pinId);
      if (spot) return { kind: spot.kind, at: spot.at, out: spot.out, row: spot.row, ways: 1 };
      const w = num(d, "w", 50);
      const dd = num(d, "d", 30);
      const t = num(d, "t", 1.6);
      // pins in catalog order: the first half along the -Y edge, the rest along +Y
      const half = Math.ceil(n / 2);
      const side = i < half ? -1 : 1;
      const k = i < half ? i : i - half;
      const count = i < half ? half : n - half;
      const x = (-w / 2 + 4) + ((w - 8) * (k + 0.5)) / Math.max(1, count);
      const y = side * (dd / 2 - 3);
      if (kind === "ferrule") return { kind, at: [x, side * dd / 2, t + 5], out: [0, side, 0], row: X, ways, socket: true };
      return { kind, at: [x, y, t], out: Z, row: X, ways, socket: true };
    }
    case "gearmotor": {
      const back = num(d, "gear_l", 25) + num(d, "motor_l", 40) + num(d, "enc_l", 0);
      const r = num(d, "motor_d", 35) * 0.3;
      const off = num(d, "shaft_offset", 0);
      return { kind, at: [-off + (pin.id.match(/MINUS|NEG|2$|B$/) ? -r : r), 0, -back], out: NZ, row: X, ways };
    }
    case "micro_gearmotor": {
      // the solder tabs on the can's end cap
      const back = num(d, "gear_l", 9) + num(d, "motor_l", 15) + num(d, "enc_l", 0);
      return { kind, at: [(pin.id.match(/MINUS|NEG|2$|B$/) ? -1 : 1) * num(d, "w", 12) / 4, 0, -back - 1], out: NZ, row: X, ways };
    }
    case "tt_motor": {
      // tabs on the end of the can, which sticks out along -X
      const end = num(d, "shaft_x", 11) - num(d, "gear_l", 37) - num(d, "motor_l", 25);
      return { kind, at: [end - 1, 0, -num(d, "gear_t", 18.8) / 2 + (pin.id.match(/MINUS|NEG|2$|B$/) ? -4 : 4)], out: [-1, 0, 0], row: Z, ways };
    }
    case "outrunner": {
      // the three phase leads leave the side of the base
      const r = num(d, "base_d", 28) / 2;
      return { kind, at: [r, (i - 1) * 2.5, num(d, "base_h", 4) / 2], out: X, row: Y, ways: 1 };
    }
    case "stepper":
      return STEPPER_PLUG(num(d, "l", 40), num(d, "size", 42.3));
    case "panel_jack": {
      // the lugs behind the body (geometry.ts): a brick's cord plugs into the front instead
      if (peer?.geom.g === "brick" || peer?.geom.g === "desk_supply") return { kind: "barrel", at: [0, 0, num(d, "nut_t", 2.4)], out: Z, row: X, ways: 1 };
      const bw = num(d, "body_w", 13);
      const x = n > 1 ? -bw / 4 + (bw / 2) * (i / (n - 1)) : 0;
      return { kind: "lug", at: [x, 0, -num(d, "panel_t", 3) - num(d, "body_l", 20) - 5.5], out: NZ, row: X, ways: 1 };
    }
    case "speaker": {
      // spade tabs on the basket, + first
      const tab = num(d, "cutout_d", 231) / 2 - 26;
      return { kind: "spade", at: [tab, i === 0 ? 18 : -18, -23], out: NZ, row: X, ways: 1 };
    }
    case "pcb_part": {
      // a screw terminal on a circuit board takes the wire in its -Y face
      const fp = part.footprint;
      if (fp?.k !== "inline" || fp.style !== "terminal") break;
      const k = fp.pins.indexOf(pinId);
      return { kind: "ferrule", at: [(k - (fp.pins.length - 1) / 2) * fp.pitch, -3.8, 3.8], out: NY, row: X, ways: 1 };
    }
    case "servo": {
      // the three wires of its lead leave the end of the case side by side: ground, power, signal
      const k = ["GND", "V_PLUS", "SIG"].indexOf(pinId);
      return { kind: "lead", at: [num(d, "w", 40) / 2 - num(d, "shaft_x", 10), 0, -num(d, "h", 37) / 2], out: X, row: Z, ways: 3, pitch: 1.3, used: [Math.max(0, k)] };
    }
    case "desk_supply": {
      // a desktop supply's DC lead leaves the middle of its +X end, above the feet (geometryBenchParts.ts)
      const h = num(d, "h", 40);
      const foot = Math.min(num(d, "foot_h", 1), h / 10);
      return { kind: "lead", at: [num(d, "w", 170) / 2, 0, foot + (h - foot) / 2], out: X, row: Y, ways: 1 };
    }
    case "edf": {
      // the three motor leads leave the housing's side through a stator vane, at lead_az, one behind the other
      // along the axis (geometry.ts edf), and run out sideways: never through the intake or the jet
      const at = edfLeadExit(d, Math.max(0, part.pins.filter((q) => q.type === "motor").indexOf(pin)));
      return { kind: "lead", at: at.p, out: at.out, row: Z, ways: 1 };
    }
    case "fan": {
      const s = num(d, "size", 40);
      return { kind, at: [s / 2, s / 2 - 5, num(d, "t", 10) / 2], out: X, row: Z, ways };
    }
    case "box":
    case "brick": {
      const w = num(d, "w", 50);
      const h = num(d, "h", 20);
      // a power brick's cord leaves the middle of its +X end
      if (part.kind === "psu" && part.geom.g === "brick") return { kind: "lead", at: [w / 2, 0, h / 2], out: X, row: Y, ways: 1 };
      const look = part.geom.g === "box" ? sideLead(part, pin, w, num(d, "d", 30), h) : undefined;
      if (look) return look;
      // spread along the +X end of the top face
      const dd = num(d, "d", 30);
      const y = -dd / 2 + (dd * (i + 0.5)) / Math.max(1, n);
      return { kind, at: [w / 2 - 4, y, h], out: Z, row: Y, ways };
    }
  }
  return { kind, at: [0, 0, 0], out: Z, row: X, ways };
}
