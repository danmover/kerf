// Where the wires leave the magnetic-levitation parts (catalog/fields.ts): hand-wound coils, the Hall sensor
// board, the current monitors and the pressure gauge. Positions are in each part's own frame, as in plugs.ts.

import type { V3 } from "../../kernel/recipe";
import type { PlugSpec } from "./plugs";

const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const Z: V3 = [0, 0, 1];
const NY: V3 = [0, -1, 0];
const NZ: V3 = [0, 0, -1];

type PlugTable = Record<string, PlugSpec>;

const lead = (at: V3, out: V3, row: V3): PlugSpec => ({ kind: "lead", at, out, row, ways: 1 });

// Adafruit INA3221 (38.6 × 22.9): three 2-way screw terminals along the +Y edge, wires entering from that edge,
// each channel's + contact on the left; power and I2C soldered to the header pads along the -Y edge.
const INA_T = 1.6;
const inaTerminal = (x: number): PlugSpec => ({ kind: "ferrule", at: [x, 11, INA_T + 3.4], out: Y, row: X, ways: 1 });
const inaPad = (k: number): PlugSpec => ({ kind: "solder", at: [(k - 2.5) * 2.54, -9.9, INA_T], out: Z, row: X, ways: 1 });
const INA3221: PlugTable = {
  CH1P: inaTerminal(-13.25),
  CH1N: inaTerminal(-9.75),
  CH2P: inaTerminal(-1.75),
  CH2N: inaTerminal(1.75),
  CH3P: inaTerminal(9.75),
  CH3N: inaTerminal(13.25),
  VIN: inaPad(0),
  GND: inaPad(1),
  SCL: inaPad(2),
  SDA: inaPad(3),
  WRN: inaPad(4),
  CRI: inaPad(5),
};

// A STEMMA QT lead plugged into the socket on a board's +X end: four fine wires leave the back of the little plug,
// 1.9 mm above the board, in the order ground, power, data, clock.
const qtLead = (edge: number, t: number, k: number): PlugSpec => lead([edge + 4.3, (1.5 - k) * 1, t + 1.9], X, Y);

/** Plugs for the catalog parts in catalog/fields.ts, by catalog id and pin id. */
export const FIELD_PLUGS: Record<string, PlugTable> = {
  // the lift coil's two ends leave the outside of the winding side by side, near its top, along +Y
  coil_lift_84x18: {
    M_PLUS: lead([3, 42, 15], Y, X),
    M_MINUS: lead([-3, 42, 15], Y, X),
  },
  // a steering coil's ends drop out past its lower flange, just outside the winding on the +X +Y diagonal:
  // turn the coil (rotate:) so that corner faces the hole its leads leave by
  coil_steer_29x18: {
    M_PLUS: lead([10.5, 12.5, -1.3], NZ, X),
    M_MINUS: lead([12.5, 10.5, -1.3], NZ, X),
  },
  // the nulling winding's ends leave its outside along +Y, near its far face
  coil_null_39x3: {
    M_PLUS: lead([-2.2, 19.6, 2.4], Y, X),
    M_MINUS: lead([2.2, 19.6, 2.4], Y, X),
  },
  // Adafruit TMAG5273 (25.3 × 17.7), mounted flat with no header: a STEMMA QT lead in the socket on its +X end
  tmag5273_breakout: {
    GND: qtLead(12.65, 1.6, 0),
    VIN: qtLead(12.65, 1.6, 1),
    SDA: qtLead(12.65, 1.6, 2),
    SCL: qtLead(12.65, 1.6, 3),
  },
  ina3221_breakout: INA3221,
  ina3221_breakout_41: INA3221,
  // Sensirion SDP810: four pins in the little connector on its -Y face, beside the high-pressure port
  sdp810_500pa: Object.fromEntries(["SCL", "VDD", "GND", "SDA"].map((id, k): [string, PlugSpec] => [id, lead([4.4 + (k - 1.5) * 1.5, -13.25, 5.75], NY, X)])),
};
