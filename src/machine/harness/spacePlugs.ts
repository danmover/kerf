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

type PlugTable = Record<string, PlugSpec>;

/** one contact of a 2.0 mm crimp housing standing up from a board's top */
const up = (x: number, y: number, z = 1.6, row: V3 = Y): PlugSpec => ({ kind: "ph", at: [x, y, z], out: Z, row, ways: 1 });

// GomSpace P31u: eight two- to four-way connectors near its +X and -X edges (positions assumed from the board's
// published outline, clear of the stack connectors along +Y)
const P31U: PlugTable = {
  OUT1: up(38, 6),
  OUT3: up(38, 9),
  OUT6: up(38, 12),
  GND_OUT: up(38, 15),
  SOLAR1A: up(38, -8),
  GND_1A: up(38, -4),
  SOLAR1B: up(-38, 8),
  GND_1B: up(-38, 12),
  VBAT: up(-38, -8),
  GND: up(-38, -4),
  SOLAR2A: up(-38, 24),
  GND_2A: up(-38, 28),
  SOLAR3A: up(38, 24),
  GND_3A: up(38, 28),
  SOLAR2B: up(-38, -26),
  GND_2B: up(-38, -22),
  SOLAR3B: up(38, -26),
  GND_3B: up(38, -22),
};

// EnduroSat OBC: its I/O connector on the +X edge (the payload UART, the deployment inputs and a branch of the I2C
// bus for boards off the stack)
const OBC: PlugTable = {
  TX: up(40, -9),
  RX: up(40, -6),
  DEP1: up(40, -3),
  DEP2: up(40, 0),
  SDA: up(40, 3),
  SCL: up(40, 6),
  GND_IO: up(40, 9),
};

// GomSpace BP4: the battery connector at its -X edge, beside the cells
const BP4: PlugTable = { POS: up(-42, -22), NEG: up(-42, -18) };

// CubeADCS: the sensor connector on the lower board's top, in the half the star tracker sits in
const ADCS: PlugTable = {
  SENS_3V3: up(-34, -36, 1.6, X),
  SENS_SDA: up(-31, -36, 1.6, X),
  SENS_SCL: up(-28, -36, 1.6, X),
  GND: up(-25, -36, 1.6, X),
};

// CubeStar: the connector on its +X end (geometrySpace trackerGeometry: a 5 x 12 box at (w/2 + 2.4, 0))
const side = (y: number): PlugSpec => ({ kind: "ph", at: [25 + 4.9, y, 5.25], out: X, row: Y, ways: 1 });
const CUBESTAR: PlugTable = { VIN: side(-4.5), GND: side(-1.5), SDA: side(1.5), SCL: side(4.5) };

// MultiScape100: its harness leaves the focal-plane box on the +X side as a pigtail
const lead = (y: number): PlugSpec => ({ kind: "lead", at: [45.6, y, 149.5 + 9], out: X, row: Y, ways: 1 });
const MULTISCAPE: PlugTable = { V5: lead(-24), GND: lead(-21), RX: lead(-18), TX: lead(-15) };

// ISIS AntS: its connector hangs under the board near the +X edge (geometrySpace antsGeometry)
const down = (x: number, y: number, z: number): PlugSpec => ({ kind: "ph", at: [x, y, z], out: NZ, row: X, ways: 1 });
const ANTS: PlugTable = { V3V3: down(34.5, -20, -3.6), GND: down(36.5, -20, -3.6), SDA: down(38.5, -20, -3.6), SCL: down(40.5, -20, -3.6) };

// the solar panels: the harness connector under each panel's back (conn_x along its length, 10 mm in from its +Y edge)
const panel = (cx: number, w = 82): PlugTable => {
  const y = w / 2 - 10;
  const at = (dx: number): V3 => [cx + dx, y, -3.2];
  return {
    POS: { kind: "ph", at: at(-3), out: NZ, row: X, ways: 1 },
    NEG: { kind: "ph", at: at(-1), out: NZ, row: X, ways: 1 },
    WING_POS: { kind: "ph", at: at(1), out: NZ, row: X, ways: 1 },
    WING_NEG: { kind: "ph", at: at(3), out: NZ, row: X, ways: 1 },
  };
};

// the hold-down board: its two-way connector under the board, through the panel it is bonded to
const HOLDDOWN: PlugTable = { BURN: { kind: "ph", at: [12, 3, -3], out: NZ, row: X, ways: 1 }, GND: { kind: "ph", at: [14, 3, -3], out: NZ, row: X, ways: 1 } };

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
  gomspace_dsp_body: panel(106),
  gomspace_p110_3u: panel(91),
  gomspace_p110_3u_tracker: panel(91),
  gomspace_dsp_holddown: HOLDDOWN,
  omron_d2f_f: D2F,
};
