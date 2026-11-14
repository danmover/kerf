// Where the harness meets the CubeSat flight boards (catalog/space.ts). The boards' bus (I2C, the 3.3 V and 5 V buses
// and ground) runs through their PC/104 stack connectors and needs no wires; these are the harness connectors at
// their edges: the EPS's solar inputs, battery and switched outputs, the flight computer's I/O connector, the ADCS's
// sensor connector and the off-stack parts' own connectors. Positions are in each part's own frame, as in plugs.ts.

import type { V3 } from "../../kernel/recipe";
import type { PlugSpec } from "./plugs";

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const NZ: V3 = [0, 0, -1];
const NX: V3 = [-1, 0, 0];

type PlugTable = Record<string, PlugSpec>;

/** a 2.0 mm crimp housing standing up from a board's top: each pin its own contact in the one housing */
const housing = (x: number, y: number, ids: string[], row: V3 = Y, z = 1.6): PlugTable =>
  Object.fromEntries(ids.map((id, k): [string, PlugSpec] => [id, { kind: "ph", at: [x, y, z], out: Z, row, ways: ids.length, used: [k] }]));

// GomSpace P31u: eight two- and four-way connectors near its +X and -X edges, clear of the stack connectors along +Y
// (positions assumed from the board's published outline): the switched outputs and the battery on the +X edge, the
// six solar inputs in pairs with their returns
const P31U: PlugTable = {
  ...housing(38, 10, ["OUT1", "OUT3", "OUT6", "GND_OUT"]),
  ...housing(38, -6, ["VBAT", "GND"]),
  ...housing(38, 26, ["SOLAR3A", "GND_3A"]),
  ...housing(38, -24, ["SOLAR1A", "GND_1A"]),
  ...housing(-38, 10, ["SOLAR1B", "GND_1B"]),
  ...housing(-38, -6, ["SOLAR3B", "GND_3B"]),
  ...housing(-38, 26, ["SOLAR2A", "GND_2A"]),
  ...housing(-38, -24, ["SOLAR2B", "GND_2B"]),
};

// EnduroSat OBC: its seven-way I/O connector on the +X edge (the payload UART, the deployment inputs and a branch of
// the I2C bus for boards off the stack)
const OBC: PlugTable = housing(40, 0, ["TX", "RX", "DEP1", "DEP2", "SDA", "SCL", "GND_IO"]);

// GomSpace BP4: the battery connector at its +X edge, beside the cells
const BP4: PlugTable = housing(42, -20, ["POS", "NEG"]);

// CubeADCS: the sensor connector on the lower board's top, in the half the star tracker sits in
const ADCS: PlugTable = housing(-29.5, -36, ["SENS_3V3", "SENS_SDA", "SENS_SCL", "GND"], X);

// CubeStar: the four-way connector on its +X end (geometrySpace trackerGeometry: a 5 x 12 box at (w/2 + 2.4, 0)),
// the plug going in along its length
const CUBESTAR: PlugTable = Object.fromEntries(
  ["VIN", "GND", "SDA", "SCL"].map((id, k): [string, PlugSpec] => [id, { kind: "ph", at: [25 + 4.9, 0, 5.25], out: X, row: Y, ways: 4, used: [k] }]),
);

// MultiScape100: its harness leaves the focal-plane box's Micro-D on the +X side and turns up towards the bulkhead
const lead = (x: number, y: number, z: number, out: V3 = Z): PlugSpec => ({ kind: "lead", at: [x, y, z], out, row: Y, ways: 1 });
const MULTISCAPE: PlugTable = { V5: lead(43.5, -24, 149.5 + 11.6), GND: lead(43.5, -21, 149.5 + 11.6), RX: lead(43.5, -18, 149.5 + 11.6), TX: lead(43.5, -15, 149.5 + 11.6) };

// ISIS AntS: a short harness off its four-way connector under the board at the +X edge, down through the top frame's
// notch past the top board's edge; the coax off the MMCX jack beside it (geometrySpace antsGeometry)
const ANTS: PlugTable = {
  ...Object.fromEntries(["V3V3", "GND", "SDA", "SCL"].map((id, k): [string, PlugSpec] => [id, lead(45.5, -23 + 2 * k, -3.6, NZ)])),
  RF: lead(45.5, -8, -3, NZ),
};

// the radios' RF outputs: a coax pigtail off the U.FL on the UHF board, and off the S-band board's jack, run flat
// over the board under the top frame
const UHF: PlugTable = { RF: lead(34, -34, 3) };
const SBAND: PlugTable = { RF: lead(34, -36, 3, NX) };
// the S-band patch: the right-angle MMCX plug on the jack under its board, the coax leaving it sideways in the window
const PATCH: PlugTable = { RF: lead(13 * 0.32, -13 * 0.32, -4.5, X) };

// the solar panels: the harness pigtail out of the grommet on each panel's back, through the structure beside it
// (conn_x along its length, conn_y across it)
const panel = (cx: number, cy: number, ids: string[]): PlugTable =>
  Object.fromEntries(ids.map((id, k): [string, PlugSpec] => [id, { kind: "lead", at: [cx + (k - (ids.length - 1) / 2) * 2, cy, -2.6], out: NZ, row: X, ways: 1 }]));

// the hold-down board: its two wires leave the potted exit under the board's end, straight in through the panel it is
// bonded to (on the +Y side, past the end of the stack connectors there)
const HOLDDOWN: PlugTable = { BURN: lead(18.9, 3, -2, NZ), GND: lead(19.9, 3, -2, NZ) };

// Omron D2F: the wires soldered to its three tags under the body
const tag = (x: number): PlugSpec => ({ kind: "lug", at: [x, 0, -3.5], out: NZ, row: X, ways: 1 });
const D2F: PlugTable = { COM: tag(-5.1), NC: tag(-0.5), NO: tag(5.6) };

/** connector positions for the CubeSat parts, by catalog id (each panel's conn_x as in its catalog entry) */
export const SPACE_PLUGS: Record<string, PlugTable> = {
  gomspace_p31u: P31U,
  endurosat_obc: OBC,
  gomspace_bp4_1p4s: BP4,
  cubespace_cubeadcs_3axis_small: ADCS,
  cubespace_cubestar: CUBESTAR,
  simera_multiscape100: MULTISCAPE,
  isis_ants_uhf: ANTS,
  endurosat_uhf_ii: UHF,
  endurosat_sband_tx: SBAND,
  endurosat_sband_patch: PATCH,
  gomspace_dsp_body: panel(104, 33.4, ["POS", "NEG", "WING_POS", "WING_NEG"]),
  gomspace_p110_3u: panel(92, 33.4, ["POS", "NEG"]),
  gomspace_p110_3u_tracker: panel(92, 33.4, ["POS", "NEG"]),
  gomspace_dsp_holddown: HOLDDOWN,
  omron_d2f_f: D2F,
};
