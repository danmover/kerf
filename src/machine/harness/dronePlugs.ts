// Where the wires meet the FPV quad parts (catalog/drone.ts), in each part's own frame as in plugs.ts: the flight
// controller's pads and JST SH ports, the 4-in-1 ESC's big battery and motor pads and its stack-cable socket, the
// motors' lead exits, the air unit's coax and antenna sockets, and the leads of the camera, antennas, GPS, buzzer
// and capacitor. Pad positions follow the boards' layouts as drawn (catalog geometry), within a millimetre or two.

import type { V3 } from "../../kernel/recipe";
import type { PlugSpec } from "./plugs";

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const NX: V3 = [-1, 0, 0];
const NY: V3 = [0, -1, 0];
const NZ: V3 = [0, 0, -1];

type PlugTable = Record<string, PlugSpec>;

const lead = (at: V3, out: V3, row: V3): PlugSpec => ({ kind: "lead", at, out, row, ways: 1 });
const pad = (x: number, y: number, t: number): PlugSpec => ({ kind: "solder", at: [x, y, t], out: Z, row: X, ways: 1 });
/** one contact of a JST SH socket lying on a board, the plug going in along `out` */
const sh = (at: V3, out: V3, row: V3, ways: number, k: number): PlugSpec => ({ kind: "sh", at, out, row, ways, used: [k], socket: true });

// Kakute H7 V1.5 (35 x 35, top at 1.6, the arrow along +X): the ESC port on the rear edge, the HD video port on the
// front edge, the GPS's UART3 and I2C pads on the rear edge beside the ESC port, its 5v and G on the left (+Y) edge
// with the USB-C, and the receiver's and buzzer's pads along the right (-Y) edge.
const FC_T = 1.6;
const fcEsc: V3 = [-17.5, -4.5, FC_T + 1.5];
const fcVtx: V3 = [17.5, 0, FC_T + 1.5];
const KAKUTE: PlugTable = {
  ...Object.fromEntries(["VBAT", "R7", "GND", "CURR", "M1", "M2", "M3", "M4"].map((id, k) => [id, sh(fcEsc, NX, Y, 8, k)])),
  ...Object.fromEntries(["V9", "GND_VTX", "T1", "R1", "GND_VTX2", "R6"].map((id, k) => [id, sh(fcVtx, X, NY, 6, k)])),
  T3: pad(-15.9, 2.6, FC_T),
  R3: pad(-15.9, 4.8, FC_T),
  SDA: pad(-15.9, 7.0, FC_T),
  SCL: pad(-15.9, 9.2, FC_T),
  V5_2: pad(-8, 15.9, FC_T),
  G3: pad(-5.8, 15.9, FC_T),
  V5: pad(-8.5, -15.9, FC_T),
  G2: pad(-6.3, -15.9, FC_T),
  T4: pad(-4.1, -15.9, FC_T),
  R4: pad(-1.9, -15.9, FC_T),
  V5_3: pad(1.9, -15.9, FC_T),
  BZ: pad(4.1, -15.9, FC_T),
  G4: pad(6.3, -15.9, FC_T),
  LED: pad(8.5, -15.9, FC_T),
};

// Tekko32 F4 Metal 4in1 (43 x 44, top at 2, forward along +X as the flight controller): the battery pads on the
// rear edge, each motor's three pads along the side edge at its corner (Betaflight's order: 1 rear right, 2 front
// right, 3 rear left, 4 front left; right is -Y), and the stack cable's socket standing up near the rear.
const ESC_T = 2;
const corner: Record<number, [number, number]> = { 1: [-1, -1], 2: [1, -1], 3: [-1, 1], 4: [1, 1] };
const escSock: V3 = [-9, 0, ESC_T];
const TEKKO: PlugTable = {
  BAT_PLUS: pad(-19.2, 5.5, ESC_T),
  BAT_MINUS: pad(-19.2, -5.5, ESC_T),
  ...Object.fromEntries(
    [1, 2, 3, 4].flatMap((m) => {
      const [sx, sy] = corner[m];
      // A outermost, towards the corner
      return ["A", "B", "C"].map((ph, k) => [`M${m}${ph}`, pad(sx * (20 - k * 3), sy * 20.6, ESC_T)]);
    }),
  ),
  ...Object.fromEntries(["VBAT", "TLM", "GND_FC", "CURR", "S1", "S2", "S3", "S4"].map((id, k) => [id, { kind: "sh" as const, at: escSock, out: Z, row: Y, ways: 8, used: [k], socket: true }])),
};

/** Plugs for the parts in catalog/drone.ts, by catalog id and pin id. */
export const DRONE_PLUGS: Record<string, PlugTable> = {
  // the three phase leads leave the base's side at -Y (geometryDrone.ts fpvMotorGeometry)
  tmotor_f60pro_v_1950kv: {
    PHASE_A: lead([-2.05, -15.3, 1.62], NY, X),
    PHASE_B: lead([0, -15.3, 1.62], NY, X),
    PHASE_C: lead([2.05, -15.3, 1.62], NY, X),
  },
  holybro_kakute_h7_v15: KAKUTE,
  holybro_tekko32_f4_metal_65a: TEKKO,
  // the capacitor's two legs, bent down out of its base
  esc_cap_1000u_35v: { PLUS: lead([2.5, 0, -10], NZ, X), MINUS: lead([-2.5, 0, -10], NZ, X) },
  // the air unit: camera coax socket in its +Y face, the U.FL sockets on its rear corners, the 3-in-1 cable out of
  // the 6-way socket in its +X side
  dji_o4_air_unit_pro: {
    CAM: { kind: "ufl", at: [0, 16.75, 2.5], out: Y, row: X, ways: 1 },
    ANT1: { kind: "ufl", at: [13.55, -13.55, 7.35], out: Z, row: X, ways: 1 },
    ANT2: { kind: "ufl", at: [-13.55, -13.55, 7.35], out: Z, row: X, ways: 1 },
    ...Object.fromEntries(["VIN", "GND", "RX", "TX", "GND2", "SBUS"].map((id, k) => [id, lead([17.05, 2 + (k - 2.5) * 0.9, 2.6], X, Y)])),
  },
  // the camera's coax out of the boot on its back
  dji_o4_pro_camera: { CAM: lead([0, -4.66, -18.45], NZ, X) },
  // an antenna's coax leaves the base of its element, back along -Z
  dji_o4_antenna: { RF: lead([0, 0, 0], NZ, X) },
  radiomaster_t_antenna_65: { RF: lead([0, 0, 0], NZ, X) },
  // RP1: four pads along the -X end (G, 5V, TX, RX), the U.FL socket at the +X end
  radiomaster_rp1_v2: {
    GND: pad(-5.2, -3.75, 1),
    V5: pad(-5.2, -1.25, 1),
    TX: pad(-5.2, 1.25, 1),
    RX: pad(-5.2, 3.75, 1),
    ANT: { kind: "ufl", at: [4.9, 0, 3], out: Z, row: X, ways: 1 },
  },
  // the GH cable out of the socket under the board's -Y edge
  matek_m10q_5883: Object.fromEntries(["V5", "GND", "TX", "RX", "SCL", "SDA"].map((id, k) => [id, lead([(k - 2.5) * 1.25, -10.2, -2.1], NY, X)])),
  // the buzzer's three leads out of its -X end
  vifly_finder_2: Object.fromEntries(["V5", "GND", "BZ"].map((id, k) => [id, lead([-14.9, (k - 1) * 1.3, 7.2], NX, Y)])),
};
