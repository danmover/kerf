// Parts for machines that work with magnetic fields and moving air: wound
// air-core coils, a levitation magnet, a 3-axis field sensor, coil-current
// and tunnel-pressure sensors, a coil driver and a 120 mm PWM tunnel fan.
// Specs are from the maker's page or datasheet (see `source`). The coils are
// wound by hand to a recipe: their resistance and inductance are worked out
// from the copper (sim/mech/field.ts) and are what a careful winding gives.

import type { CatalogPart, PinDef } from "../types";
import { gnd, input, motorOut, pwrIn, pwrOut } from "./pins";

/** The two ends of a winding. Positive current (in at START, out at END) makes the field point along the coil's axis. */
const coilPins = (iHold: number): PinDef[] => [
  { id: "M_PLUS", label: "START", type: "motor", channel: "A", required: true, note: `Start of the winding (the inner end). About ${iHold} A in normal use` },
  { id: "M_MINUS", label: "END", type: "motor", channel: "A", required: true, note: "End of the winding (the outer end)" },
];

/** One shunt channel of a current monitor: the current passes in at + and out at −. */
const shuntPins = (n: number): PinDef[] => [
  { id: `CH${n}P`, label: `VIN${n}+`, type: "passive", through: `CH${n}N`, imax: 3.2, note: "Current in: the side the current comes from" },
  { id: `CH${n}N`, label: `VIN${n}-`, type: "passive", through: `CH${n}P`, imax: 3.2, note: "Current out: the side the current goes on to" },
];

const ina3221 = (id: string, addr: string, jumper: string): CatalogPart => ({
  id,
  kind: "sensor",
  name: `Adafruit INA3221 triple current and voltage monitor (STEMMA QT)${addr === "0x40" ? "" : `, address ${addr}`}`,
  maker: "Adafruit",
  mpn: "6062",
  summary: `Three separate shunt channels on one I2C chip (${addr}${jumper}): each measures ±3.2 A through its own 0.05 Ω 1 % shunt in 0.8 mA steps, and the voltage on it up to 26 V. 3 to 5 V logic. 38.6 x 22.9 mm with 3.5 mm terminal blocks.`,
  specs: { iface: "i2c", i2c_addr: addr, chip: "INA3221", measures: "current, voltage", channels: 3, shunt_ohm: 0.05, i_max: 3.2, v_bus_max: 26, lsb_ua: 800, v_min: 2.7, v_max: 5.5, mass_g: 5.2 },
  pins: [
    pwrIn("VIN", 2.7, 5.5, { label: "VIN", vabs: 6, draw: 0.0004 }),
    gnd(),
    { id: "SCL", type: "in", vmax: 5.5, vih: 2.0, bus: "i2c_scl", required: true },
    { id: "SDA", type: "in", vmax: 5.5, vih: 2.0, bus: "i2c_sda", required: true },
    ...shuntPins(1),
    ...shuntPins(2),
    ...shuntPins(3),
    { id: "WRN", type: "out", v: 3.3, label: "WRN", note: "Warning alert, open drain" },
    { id: "CRI", type: "out", v: 3.3, label: "CRI", note: "Critical alert, open drain" },
  ],
  geom: {
    g: "board",
    dims: { w: 38.6, d: 22.9, t: 1.6 },
    holes: [
      [-16.76, -8.89],
      [16.76, -8.89],
      [-16.76, 8.89],
      [16.76, 8.89],
    ],
    hole_d: 2.5,
    features: [
      { kind: "chip", x: 0, y: -2, w: 4, d: 4, h: 0.9 },
      { kind: "terminal", x: -11.5, y: 7.2, w: 7, d: 7.6, h: 8.9 },
      { kind: "terminal", x: 0, y: 7.2, w: 7, d: 7.6, h: 8.9 },
      { kind: "terminal", x: 11.5, y: 7.2, w: 7, d: 7.6, h: 8.9 },
      { kind: "chip", x: -11.5, y: 0.6, w: 6.3, d: 3.2, h: 0.7 },
      { kind: "chip", x: 0, y: 2.2, w: 6.3, d: 3.2, h: 0.7 },
      { kind: "chip", x: 11.5, y: 0.6, w: 6.3, d: 3.2, h: 0.7 },
      { kind: "socket", x: -16.6, y: -1.5, w: 4.2, d: 6, h: 3 },
      { kind: "socket", x: 16.6, y: -1.5, w: 4.2, d: 6, h: 3 },
    ],
    color: "#16181b",
  },
  price_usd: 12.5,
  buy: [
    { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/adafruit-ina3221-triple-power-monitor-stemma-qt-qwiic.html" },
    { vendor: "Pakronics (AU)", url: "https://www.pakronics.com.au/products/adafruit-ina3221-triple-0-26-vdc-3-2-amp-power-monitor-ada6062" },
    { vendor: "Adafruit", url: "https://www.adafruit.com/product/6062" },
  ],
  source: "https://www.ti.com/lit/ds/symlink/ina3221.pdf",
  notes: [
    "Each channel is its own pair of terminals: wire the load's current in at VINn+ and out at VINn−. A positive reading is current flowing + to −.",
    "On a PWM driver put the shunt on the side of the load that stays at one voltage (a bridge's low-side output in slow decay), not the side that switches.",
    ...(addr === "0x40" ? [] : ["Bridge the address jumper on the back with solder so this board answers at 0x41 and can share the bus with a second one."]),
    "Mounting holes assumed 0.1 in in from the corners: check against the board before printing a mount.",
  ],
});

export const FIELDS: CatalogPart[] = [
  // ---------------- wound coils ----------------
  {
    id: "coil_lift_84x18",
    kind: "coil",
    name: "Air-core lift coil, 548 turns of 0.71 mm enamelled wire, 44 ID x 84 OD x 18 mm",
    generic: true,
    summary: "A hand-wound ring coil with no iron: 548 turns of 0.71 mm enamelled copper on a printed bobbin, about 4.8 Ω and 17.5 mH, 110 m and 390 g of wire. Holds a 12 mm magnet 38 mm below its centre at about 0.74 A (2.6 W).",
    specs: { turns: 548, wire_d: 0.71, id: 44, od: 84, h: 18, r_ohm: 4.79, l_mh: 17.5, wire_m: 110, mass_g: 391, i_free: 0.75, i_12v: 2.5, i_cont: 1.6, temp_max: 105 },
    pins: coilPins(0.75),
    geom: { g: "ring", dims: { od: 84, id: 44, l: 18 }, color: "#b0622a", material: "Copper" },
    price_usd: 26,
    buy: [{ vendor: "Marketplace", search: "enamelled copper winding wire 0.71mm 500g" }],
    source: "Worked out from the winding: resistance from 110 m of 0.71 mm copper at 20 °C, inductance by Wheeler's multilayer formula, field from the Biot-Savart law.",
    notes: [
      "Wind it on its printed bobbin with a drill or a hand winder, layer by layer, counting turns: 548 fills the 20 x 18 mm window at ordinary hand tension. Measure the finished resistance and put it in with measured: so the simulation uses your coil.",
      "Positive current in at START makes its field point along the axis. If the magnet is pushed away instead of pulled, swap the two leads.",
      "It runs warm, not hot: 2.6 W holding, about 16 W for the second it takes to lift off. Leave the bobbin's outside open to the air.",
    ],
    tests: ["Measure the winding's resistance (about 4.8 Ω at room temperature) and check it against the driver's current limit at 12 V."],
  },
  {
    id: "coil_steer_29x18",
    kind: "coil",
    name: "Air-core steering coil, 821 turns of 0.4 mm enamelled wire, 8 ID x 29 OD x 18 mm",
    generic: true,
    summary: "A small hand-wound coil with no iron: 821 turns of 0.4 mm enamelled copper on a printed bobbin, about 6.5 Ω and 5.6 mH, 48 m and 54 g of wire. Four of them under a floating magnet push it sideways about 19 mN per amp each.",
    specs: { turns: 821, wire_d: 0.4, id: 8, od: 29, h: 18, r_ohm: 6.53, l_mh: 5.6, wire_m: 47.7, mass_g: 54, i_free: 0.3, i_12v: 1.84, i_cont: 0.72, temp_max: 105 },
    pins: coilPins(0.3),
    geom: { g: "ring", dims: { od: 29, id: 8, l: 18 }, color: "#b0622a", material: "Copper" },
    price_usd: 5,
    buy: [{ vendor: "Marketplace", search: "enamelled copper winding wire 0.4mm 500g" }],
    source: "Worked out from the winding: resistance from 47.7 m of 0.4 mm copper at 20 °C, inductance by Wheeler's multilayer formula, field from the Biot-Savart law.",
    notes: ["Wind all four the same way round and mark each START lead, so equal currents give equal fields.", "Positive current in at START makes its field point along the axis."],
    tests: ["Measure each winding's resistance: the four should agree within 3 %."],
  },
  {
    id: "coil_null_39x3",
    kind: "coil",
    name: "Sensor nulling winding, 25 turns of 0.4 mm enamelled wire, 34.8 ID x 39.2 OD x 3 mm",
    generic: true,
    summary:
      "A thin ring of 25 turns wound around a field sensor, in the sensor's own plane, and wired in series with the lift coil the opposite way round. It makes 0.84 mT per amp at its centre, which cancels what the 84 mm lift coil makes 68 mm below its centre, so the sensor sees only the magnet. About 0.40 Ω and 0.04 mH, 2.9 m of wire.",
    specs: { turns: 25, wire_d: 0.4, id: 34.8, od: 39.2, h: 3, r_ohm: 0.398, l_mh: 0.041, wire_m: 2.91, mass_g: 3.3, i_free: 0.75, i_cont: 2, temp_max: 105 },
    pins: coilPins(0.75),
    geom: { g: "ring", dims: { od: 39.2, id: 34.8, l: 3 }, color: "#b0622a", material: "Copper" },
    price_usd: 1,
    buy: [{ vendor: "Marketplace", search: "enamelled copper winding wire 0.4mm 500g" }],
    source: "Worked out from the winding: the field at the centre of 25 turns of 18.5 mm mean radius against the lift coil's on its axis, both from the Biot-Savart law.",
    notes: [
      "Wire it in series with the lift coil, between the lift coil's END and the current shunt, so the same current runs through both: its field then follows the lift coil's exactly, with nothing to tune and no delay.",
      "Five layers of five turns fill its 3 x 2.2 mm groove. Keep it that low: the sensor board's cable has to pass over it.",
      "It must oppose the lift coil at the sensor. With the magnet out, run the firmware's coil check: the lift channel should read under 0.05 mT per amp. About 1.7 mT per amp means it is the wrong way round, so swap its two leads. A reading over 0.05 mT per amp means a turn too many or too few.",
      "A lift coil that changes the sensor's reading makes a height controller chase its own output. Cancelling the field in copper is steadier than taking it away in the firmware, where the current and field readings are never taken at quite the same instant.",
    ],
    tests: ["With the magnet out, drive the lift coil at 0.5 A and check the field sensor's reading moves by less than 0.03 mT."],
  },

  // ---------------- magnets ----------------
  {
    id: "magnet_12x12_n45",
    kind: "magnet",
    name: "Neodymium cylinder magnet 12 x 12 mm, N45, magnetised along its axis",
    generic: true,
    summary: "A 12 mm diameter, 12 mm long N45 cylinder magnetised end to end: about 1.35 T remanence, a dipole of 1.46 A·m², 10.2 g. The core of a levitated model.",
    specs: { d: 12, h: 12, grade: "N45", br_t: 1.35, moment_am2: 1.458, mass_g: 10.2, temp_max: 80 },
    pins: [],
    geom: { g: "disc", dims: { d: 12, h: 12 }, color: "#c3c8cf", material: "Steel" },
    price_usd: 3,
    buy: [{ vendor: "Marketplace", search: "neodymium cylinder magnet 12mm x 12mm N45 axially magnetised" }],
    source: "Moment from remanence times volume over µ0 (N45: 1.32 to 1.38 T).",
    notes: ["Its north pole is the `end` face (along its axis from `at`). Mark it with paint before pressing it into a model.", "Strong enough to pinch skin against steel, and it wipes bank cards: keep it in its model.", "Loses strength for good above 80 °C: do not print over it or use a heat gun near it."],
  },

  // ---------------- field, current and pressure sensors ----------------
  {
    id: "tmag5273_breakout",
    kind: "sensor",
    name: "Adafruit TMAG5273 (A1) 3-axis Hall-effect field sensor breakout (STEMMA QT)",
    maker: "Adafruit",
    mpn: "6489",
    summary: "TI TMAG5273A1: flux density on three axes, ±40 or ±80 mT, 16 bits (820 or 410 counts per mT), up to 10 kHz on three axes over I2C (0x35), with averaging up to 32 samples. 3 to 5 V in. 25.3 x 17.7 mm.",
    specs: {
      iface: "i2c",
      i2c_addr: "0x35",
      chip: "TMAG5273A1",
      measures: "magnetic field on three axes",
      range_mt: 40,
      range_hi_mt: 80,
      noise_xy_ut: 125,
      noise_z_ut: 68,
      offset_ut: 300,
      gain_err_pct: 5,
      v_min: 3,
      v_max: 5,
      // the Hall elements sit in the middle of the SOT-23 package, 0.65 mm under its top
      sense_x: 0,
      sense_y: 0,
      sense_z: 2.05,
      mass_g: 1.7,
    },
    pins: [
      pwrIn("VIN", 3, 5.5, { label: "VIN", vabs: 6, draw: 0.0023 }),
      pwrOut("V3O", 3.3, 0.1, { label: "3Vo" }),
      gnd(),
      { id: "SCL", type: "in", vmax: 5.5, vih: 2.0, bus: "i2c_scl", required: true },
      { id: "SDA", type: "in", vmax: 5.5, vih: 2.0, bus: "i2c_sda", required: true },
      { id: "INT", type: "out", v: 3.3, label: "INT" },
    ],
    geom: {
      g: "board",
      dims: { w: 25.3, d: 17.7, t: 1.6 },
      holes: [
        [-10.16, -6.35],
        [10.16, -6.35],
        [-10.16, 6.35],
        [10.16, 6.35],
      ],
      hole_d: 2.5,
      features: [
        { kind: "chip", x: 0, y: 0, w: 2.9, d: 1.6, h: 1.1 },
        { kind: "socket", x: -10.5, y: 0, w: 4.2, d: 6, h: 3 },
        { kind: "socket", x: 10.5, y: 0, w: 4.2, d: 6, h: 3 },
      ],
      color: "#16181b",
    },
    price_usd: 5.95,
    buy: [
      { vendor: "Pakronics (AU)", url: "https://pakronics.com.au/products/adafruit-tmag5273-a1-3d-hall-effect-magnetometer-breakout-ada6489" },
      { vendor: "Core Electronics (AU), SparkFun's board of the same chip", url: "https://core-electronics.com.au/sparkfun-linear-3d-hall-effect-sensor-tmag5273-qwiic.html" },
      { vendor: "Adafruit", url: "https://www.adafruit.com/product/6489" },
    ],
    source: "https://www.ti.com/lit/ds/symlink/tmag5273.pdf",
    notes: [
      "The chip reads Z out of the top of the board and X along its long side.",
      "Its zero is off by up to 0.3 mT and its scale by about 5 % from chip to chip: zero it with no magnet near, and set the scale from a magnet at a known distance.",
      "It reads every field there is, a coil's as well as a magnet's: take away the coils' share (their current times a constant found with the magnet out).",
      "Leave the pin header off and plug in a STEMMA QT cable to mount it flat.",
    ],
  },
  ina3221("ina3221_breakout", "0x40", ", 0x41 with the jumper bridged"),
  ina3221("ina3221_breakout_41", "0x41", ", its address jumper bridged"),
  {
    id: "sdp810_500pa",
    kind: "sensor",
    name: "Sensirion SDP810-500Pa differential pressure sensor",
    maker: "Sensirion",
    mpn: "SDP810-500PA",
    summary: "The pressure difference between two 5 mm tube ports, ±500 Pa in 1/60 Pa steps, within 3 % of the reading and 0.1 Pa at zero, 2000 readings a second over I2C (0x25). 3.3 V. For air speed from a pitot tube or a tunnel's contraction.",
    specs: { iface: "i2c", i2c_addr: "0x25", chip: "SDP810", measures: "pressure difference", range_pa: 500, counts_per_pa: 60, zero_pa: 0.1, span_err_pct: 3, v_min: 2.7, v_max: 5.5, port_d: 5.2, mass_g: 6 },
    pins: [
      pwrIn("VDD", 2.7, 5.5, { label: "VDD", vabs: 5.5, draw: 0.0038 }),
      gnd(),
      { id: "SCL", type: "in", vmax: 5.5, vih: 2.3, bus: "i2c_scl", required: true },
      { id: "SDA", type: "in", vmax: 5.5, vih: 2.3, bus: "i2c_sda", required: true },
    ],
    geom: { g: "dp_sensor", dims: { w: 29, d: 18, h: 12.5, port_d: 5.2, port_l: 11, port_pitch: 12.8, lug_w: 9, hole_d: 3.4 }, color: "#1d2024" },
    price_usd: 38,
    buy: [
      { vendor: "DigiKey (AU)", url: "https://www.digikey.com.au/en/products/detail/sensirion-ag/SDP810-500PA/6605489" },
      { vendor: "Core Electronics (AU), DFRobot's ±500 Pa sensor instead", url: "https://core-electronics.com.au/differential-pressure-sensor-500pa.html" },
    ],
    source: "https://sensirion.com/products/catalog/SDP810-500Pa",
    notes: [
      "It has no pull-ups: the controller's or another board's on the same bus do the job.",
      "The port nearer the connector is the high side. Air flows through it a little (it measures by flow), so keep both tubes the same length and under half a metre.",
      "Its four pins are 2 mm apart in a row: use the maker's cable (SEK-SDP8xx) or solder wires on.",
    ],
  },

  // ---------------- a driver for one coil ----------------
  {
    id: "drv8871_breakout",
    kind: "motor_driver",
    name: "Adafruit DRV8871 single H-bridge driver breakout, 3.6 A peak",
    maker: "Adafruit",
    mpn: "3190",
    summary: "One brushed motor or coil, 6.5 to 45 V, limited to about 2.1 A by the fitted 30 kΩ resistor (3.6 A peak without it), two PWM inputs, 3.3 or 5 V logic. 24.4 x 20.4 mm with terminal blocks.",
    specs: { channels: 1, i_cont: 2, i_peak: 2.1, v_min: 6.5, v_max: 45, control: "in1_in2_pwm_both", pwm_khz_max: 200, r_on: 0.565 },
    pins: [
      pwrIn("VM", 6.5, 45, { label: "VMotor", vabs: 50, draw: 0.003, note: "Coil or motor supply" }),
      gnd(),
      input("AIN1", 5.5, 1.5, { label: "IN1", needs: "pwm", required: true, note: "Pulled low on the chip: both inputs low lets the output float (coast)" }),
      input("AIN2", 5.5, 1.5, { label: "IN2", needs: "pwm", required: true }),
      motorOut("AOUT1", "A", 2, 2.1, "OUT1"),
      motorOut("AOUT2", "A", 2, 2.1, "OUT2"),
    ],
    geom: {
      g: "board",
      dims: { w: 24.4, d: 20.4, t: 1.6 },
      holes: [
        [-9.6, -7.6],
        [9.6, -7.6],
      ],
      hole_d: 2.5,
      features: [
        { kind: "chip", x: 0, y: -1, w: 5, d: 4, h: 1.5 },
        { kind: "terminal", x: -6.2, y: 6.2, w: 7, d: 7.6, h: 8.1 },
        { kind: "terminal", x: 6.2, y: 6.2, w: 7, d: 7.6, h: 8.1 },
        { kind: "header", x: 0, y: -8.9, w: 10.2, d: 2.54, h: 2.5 },
      ],
      color: "#16181b",
    },
    price_usd: 7.5,
    buy: [
      { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/adafruit-drv8871-dc-motor-driver-breakout-board-3-6a-max.html" },
      { vendor: "Pakronics (AU)", url: "https://pakronics.com.au/products/adafruit-drv8871-dc-motor-driver-breakout-board-3-6a-max-ada3190" },
      { vendor: "Adafruit", url: "https://www.adafruit.com/product/3190" },
    ],
    source: "https://www.ti.com/lit/ds/symlink/drv8871.pdf",
    notes: [
      "For steady current in a coil hold IN1 high and PWM IN2: the output is then driven for the low part of IN2 and braked (both ends low) for the high part, so OUT2 never leaves ground and a shunt there reads cleanly.",
      "Never tie IN1 high with a wire: at power-up that would put the full supply on the coil before the firmware runs.",
      "The two switches in the path add 0.57 Ω.",
      "Mounting holes assumed on the header edge, 19.2 mm apart: check against the board before printing a mount.",
    ],
  },

  // ---------------- a two-channel driver with mounting holes ----------------
  {
    id: "tb6612_breakout",
    kind: "motor_driver",
    name: "Adafruit TB6612 1.2 A DC and stepper motor driver breakout",
    maker: "Adafruit",
    mpn: "2448",
    summary: "Two small DC motors or two coils, 1.2 A each (3 A peak), 4.5 to 13.5 V, 2.7 to 5 V logic, with reverse-supply protection. 26.7 x 19.1 mm with two 2.5 mm mounting holes.",
    specs: { channels: 2, i_cont: 1.2, i_peak: 3, v_min: 4.5, v_max: 13.5, control: "in1_in2_pwm", pwm_khz_max: 100, r_on: 0.5, mass_g: 2 },
    pins: [
      pwrIn("VM", 4.5, 13.5, { label: "VM", vabs: 15, draw: 0.002, note: "Motor supply" }),
      pwrIn("VCC", 2.7, 5.5, { label: "Vcc", vabs: 6, draw: 0.002, note: "Logic supply" }),
      gnd(),
      input("AIN1", 5.5, 0.7 * 3.3, { required: true }),
      input("AIN2", 5.5, 0.7 * 3.3, { required: true }),
      input("PWMA", 5.5, 0.7 * 3.3, { needs: "pwm", required: true }),
      input("BIN1", 5.5, 0.7 * 3.3),
      input("BIN2", 5.5, 0.7 * 3.3),
      input("PWMB", 5.5, 0.7 * 3.3, { needs: "pwm" }),
      input("STBY", 5.5, 0.7 * 3.3, { required: true, note: "Pull high to enable" }),
      motorOut("AO1", "A", 1.2, 3, "MOTORA 1"),
      motorOut("AO2", "A", 1.2, 3, "MOTORA 2"),
      motorOut("BO1", "B", 1.2, 3, "MOTORB 1"),
      motorOut("BO2", "B", 1.2, 3, "MOTORB 2"),
    ],
    // from Adafruit's board file: 26.67 x 19.05 mm, two plated 2.5 mm holes 21.59 mm apart on the output side,
    // the 10-pin control header along one long edge and the 6-pin output header along the other
    geom: {
      g: "board",
      dims: { w: 26.67, d: 19.05, t: 1.6 },
      holes: [
        [-10.795, -6.985],
        [10.795, -6.985],
      ],
      hole_d: 2.5,
      features: [
        { kind: "chip", x: 1.65, y: -0.4, w: 8.2, d: 5.6, h: 1.6 },
        { kind: "header", x: 0, y: 6.985, w: 25.4, d: 2.54, h: 2.5 },
        { kind: "header", x: 0, y: -8.255, w: 15.24, d: 2.54, h: 2.5 },
      ],
      color: "#1f4fa3",
    },
    price_usd: 4.95,
    buy: [
      { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/catalog/product/view/sku/ADA2448" },
      { vendor: "Adafruit", url: "https://www.adafruit.com/products/2448" },
    ],
    source: "https://github.com/adafruit/Adafruit-TB6612-Motor-Driver-Breakout-PCB",
    notes: [
      "To run a coil one way only, tie IN1 to the logic supply and IN2 to ground and put the PWM on the PWM pin: the output is driven for the high part and braked (both ends low) for the low part, so its second output never leaves ground and a shunt there reads cleanly.",
      "STBY has a pull-down on the chip: the outputs stay off until the firmware drives it high.",
      "The two switches in the path add about 0.5 Ω.",
    ],
  },

  // ---------------- a supply with room for the fan starting while the coils are at their peak ----------------
  {
    id: "psu_12v_8a",
    kind: "psu",
    name: "12 V 8 A desktop power supply (5.5 × 2.1 mm, centre +)",
    generic: true,
    summary: "Sealed desktop brick, 100 to 240 V AC in, 12 V 8 A out (96 W). Room for a 3 A fan starting while coils are at their peak, with no mains wiring inside the design.",
    specs: { v_out: 12, i_out: 8, power_w: 96, plug: "5.5 × 2.1 mm centre positive" },
    pins: [pwrOut("VPOS", 12, 8, { label: "+12 V (centre)" }), gnd("VNEG", "0 V (sleeve)")],
    geom: { g: "brick", dims: { w: 150, d: 60, h: 36 }, color: "#1b1d21" },
    sim: { k: "supply", pos: "VPOS", neg: "VNEG", v: 12, r: 0.06 },
    external: true,
    price_usd: 24,
    buy: [{ vendor: "Marketplace", search: "12V 8A power adapter 5.5x2.1mm center positive" }],
    notes: ["Buy one with a safety mark (RCM in Australia, UL, CE, UKCA) from a known seller: it is the only mains part.", "A panel jack is good for about 5 A: keep what the design really draws under that."],
  },

  // ---------------- tunnel fan ----------------
  {
    id: "fan_arctic_s12038_8k",
    kind: "fan",
    name: "Arctic S12038-8K 120 x 38 mm server fan, 12 V, 4-pin PWM",
    maker: "Arctic",
    mpn: "ACFAN00294A",
    summary: "A 120 x 38 mm dual ball bearing server fan: 800 to 8000 rpm from a 25 kHz PWM signal, 370 m³/h (220 CFM) free flow and 363 Pa (37 mm of water) shut off, 12 V at 2.2 A (3.2 A starting), tacho output. Loud at full speed.",
    specs: { iface: "pwm_fan", v_rated: 12, v_start: 6.5, i_rated: 2.2, i_max: 3.2, rpm_max: 8000, rpm_min: 800, flow_m3h: 370, pressure_pa: 363, pwm_hz: 25000, tach_ppr: 2, spin_up_s: 1.6, mass_g: 328 },
    pins: [
      pwrIn("V12", 10.8, 13.2, { label: "+12V", vabs: 13.8, draw: 2.2, note: "Pin 2, yellow" }),
      gnd("GND", "GND"),
      input("PWM", 5.25, 2.0, { label: "PWM", needs: "pwm", note: "Pin 4, blue: 25 kHz, 3.3 or 5 V. Pulled up inside the fan, so left open it runs flat out" }),
      { id: "TACH", type: "out", v: 3.3, label: "TACH", needs: "irq", note: "Pin 3, green: open collector, two pulses a turn. Needs a pull-up to the controller's logic voltage (its input's own is enough)" },
    ],
    geom: { g: "fan", dims: { size: 120, t: 38, hole_spacing: 105, hole_d: 4.3 }, color: "#15171a" },
    price_usd: 22,
    buy: [{ vendor: "Arctic", url: "https://www.arctic.de/en/S12038-8K" }, { vendor: "Marketplace", search: "Arctic S12038-8K 120mm server fan" }],
    source: "https://www.arctic.de/en/S12038-8K",
    notes: [
      "It blows out of the face with the label and struts. An arrow on the frame shows the way.",
      "Hold its PWM line low at start-up: an open PWM wire means full speed.",
      "8000 rpm is loud (about 70 dB) and the blades are stiff: keep a guard on the open side.",
    ],
    tests: ["Check the fan starts at the lowest PWM the firmware uses and that the tacho count matches the speed by ear or strobe."],
  },
];
