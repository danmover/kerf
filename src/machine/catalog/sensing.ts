// Distance and temperature sensors the simulator models (sim/engine/sensors.ts): an infrared ranger and a
// LiDAR, and an NTC thermistor module, the TMP36 and the MCP9808. Specs are from the maker's datasheet or
// manual (see `source`); prices and links are the Australian shops that stock them.

import type { CatalogPart } from "../types";
import { gnd, input, pwrIn } from "./pins";

export const SENSING: CatalogPart[] = [
  {
    id: "sharp_gp2y0a21",
    kind: "sensor",
    name: "Sharp GP2Y0A21YK0F infrared distance sensor (10 to 80 cm)",
    maker: "Sharp",
    mpn: "GP2Y0A21YK0F",
    summary:
      "Triangulating infrared ranger: an analog voltage that falls with distance, about 2.3 V at 10 cm to 0.4 V at 80 cm (not linear), a new reading every 38 ms. Nearer than about 7 cm the voltage falls again, so a close object reads as a far one. 5 V, about 30 mA in pulses. 44.5 x 18.9 x 13.5 mm with two 3.2 mm holes 37 mm apart.",
    specs: { iface: "analog", chip: "GP2Y0A21YK0F", measures: "distance", range_min_mm: 100, range_mm: 800, update_ms: 38.3, v_min: 4.5, v_max: 5.5, mass_g: 3.5 },
    pins: [
      { id: "VO", type: "analog_out", v: 3.3, label: "Vo", required: true, note: "Distance as a voltage (about 3.1 V at its 7 cm peak): needs an ADC pin" },
      gnd("GND", "GND"),
      pwrIn("VCC", 4.5, 5.5, { label: "Vcc", vabs: 7, draw: 0.03, note: "Draws in 30 mA pulses: put a 10 µF capacitor across Vcc and GND at the sensor" }),
    ],
    // it looks out of the lens face, the box's +Z face; the mounting tabs lie in that face
    geom: { g: "box", dims: { w: 44.5, d: 18.9, h: 13.5, r: 1 }, holes: [[-18.5, 0], [18.5, 0]], hole_d: 3.2, color: "#1a1a1a" },
    price_usd: 14.95,
    buy: [
      { vendor: "Core Electronics (AU), Pololu's, cable sold separately", url: "https://core-electronics.com.au/sharp-gp2y0a21yk0f-analog-distance-sensor-10-80cm.html" },
      { vendor: "Core Electronics (AU), Adafruit's, with its JST cable", url: "https://core-electronics.com.au/ir-distance-sensor-includes-cable-10cm-80cm-gp2y0a21yk0f.html" },
      { vendor: "Pololu", url: "https://www.pololu.com/product/136" },
    ],
    source: "https://global.sharp/products/device/lineup/data/pdf/datasheet/gp2y0a21yk_e.pdf",
    notes: [
      "Its 3-pin socket is a 2 mm JST PH: buy the cable with it, or solder wires to the pins.",
      "Average several readings: the output steps every 38 ms and carries spikes from its LED pulses.",
      "Mount it so nothing comes nearer than 10 cm, or the reading folds back and looks far away.",
    ],
  },
  {
    id: "tf_luna",
    kind: "sensor",
    name: "Benewake TF-Luna LiDAR distance sensor (0.2 to 8 m, I2C or UART)",
    maker: "Benewake",
    mpn: "TF-Luna",
    summary:
      "Time-of-flight laser ranger: 0.2 to 8 m on a white target (2.5 m on a dark one) to ±6 cm (±2 % past 3 m), 1 cm steps, up to 100 readings a second on I2C (address 0x10, CFG tied to GND) with signal strength and chip temperature. 3.7 to 5.2 V, 70 mA, 3.3 V logic, 2° beam. 35 x 21.25 x 13.5 mm, under 5 g.",
    specs: { iface: "i2c", i2c_addr: "0x10", chip: "TF-Luna", measures: "distance", range_min_mm: 200, range_mm: 8000, accuracy_mm: 60, fps: 100, fov_deg: 2, v_min: 3.7, v_max: 5.2, mass_g: 5 },
    pins: [
      pwrIn("VCC", 3.7, 5.2, { label: "+5V", vabs: 6, draw: 0.07, note: "70 mA, 150 mA peaks" }),
      { id: "SDA", type: "in", vmax: 5, vih: 2.0, bus: "i2c_sda", label: "RXD/SDA", required: true, note: "3.3 V logic" },
      { id: "SCL", type: "in", vmax: 5, vih: 2.0, bus: "i2c_scl", label: "TXD/SCL", required: true, note: "3.3 V logic" },
      gnd("GND", "GND"),
      input("CFG", 3.6, 2.0, { label: "CFG", required: true, note: "Tie to GND for I2C (read at power-up); open or 3.3 V starts it in UART mode" }),
      { id: "MUX", type: "out", v: 3.3, label: "MUX", note: "Data ready in I2C mode" },
    ],
    // it looks out of its two lenses, the box's +Z face
    geom: { g: "box", dims: { w: 35, d: 21.25, h: 13.5, r: 1 }, color: "#202326" },
    price_usd: 25,
    buy: [
      { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/tf-luna-lidar-sensor-8m-range.html" },
      { vendor: "Pakronics (AU), DFRobot's", url: "https://pakronics.com.au/products/tf-luna-lidar-module-short-range-distance-sensor-ss101990656" },
      { vendor: "Waveshare", url: "https://www.waveshare.com/tf-luna-lidar-range-sensor.htm" },
    ],
    source: "https://cdn.robotshop.com/media/b/ben/rb-ben-17/pdf/tf-luna-8m-lidar-distance-sensor-instructions-manual.pdf",
    notes: [
      "Comes with a 6-pin 1.25 mm JST GH to jumper lead. Pin 1 (+5V) is the red wire.",
      "It holds by two small lugs: take their spacing off Benewake's drawing before printing a bracket, or clamp its body.",
      "Below its signal threshold (100) it reports 0 cm: treat 0 as no reading. Nearer than 20 cm it reads about 20 cm whatever is there.",
      "Its laser is Class 1 (eye safe), at 850 nm (invisible).",
    ],
  },
  {
    id: "xc4494_ntc",
    kind: "sensor",
    name: "Duinotech temperature sensor module (10 kΩ NTC thermistor, XC4494)",
    maker: "Duinotech (Jaycar)",
    mpn: "XC4494",
    summary:
      "A 10 kΩ NTC thermistor from VCC to OUT and a 10 kΩ resistor from OUT to GND: OUT is half the supply at 25 °C and rises as it warms. Read it on an analog pin and convert with the Steinhart-Hart equation. Responds in about 8 s. 3-pin plug.",
    specs: { iface: "analog", chip: "XC4494", measures: "temperature", r25: 10000, r_fixed: 10000, tau_s: 8, v_min: 3, v_max: 5.5, mass_g: 2 },
    pins: [
      gnd("GND", "GND"),
      pwrIn("VCC", 3, 5.5, { label: "VCC", vabs: 6, draw: 0.00025, note: "Feed it from the controller's own supply so the reading scales with its ADC reference" }),
      { id: "OUT", type: "analog_out", v: 5, label: "OUT", required: true, note: "Rises with temperature: needs an ADC pin" },
    ],
    geom: { g: "board", dims: { w: 18.5, d: 15, t: 1.6 }, holes: [[-6, 0]], hole_d: 3, color: "#1d3f8f", features: [{ kind: "module", x: 5.5, y: 0, w: 3, d: 2, h: 3 }, { kind: "header", x: 8.2, y: 0, w: 2.5, d: 7.6, h: 2.5 }] },
    price_usd: 4.5,
    buy: [{ vendor: "Jaycar (AU)", url: "https://www.jaycar.com.au/duinotech-arduino-compatible-temperature-sensor-module/p/XC4494" }],
    source: "https://assets.jaycar.com.au/XC4494_manualMain_77418.pdf",
    notes: [
      "Convert with R = 10000 × (1023 / reading − 1) and Steinhart-Hart A = 1.129148e-3, B = 2.34125e-4, C = 8.76741e-8 (Jaycar's own coefficients for it).",
      "Board size and its hole are the common KY-013 layout: check yours before printing a mount.",
      "Cheap thermistors read a degree or two off: calibrate against a thermometer at room temperature.",
    ],
  },
  {
    id: "tmp36",
    kind: "sensor",
    name: "TMP36 analog temperature sensor (TO-92)",
    maker: "Analog Devices",
    mpn: "TMP36GT9Z",
    summary: "−40 to 125 °C as a voltage: 0.5 V at 0 °C and 10 mV per °C (0.75 V at 25 °C), within ±2 °C. 2.7 to 5.5 V, 50 µA. Pins seen from the flat face: +Vs, Vout, GND.",
    specs: { iface: "analog", chip: "TMP36", measures: "temperature", mv_per_c: 10, offset_v: 0.5, accuracy_c: 2, tau_s: 60, v_min: 2.7, v_max: 5.5, mass_g: 0.2 },
    pins: [
      pwrIn("VS", 2.7, 5.5, { label: "+Vs", vabs: 7, draw: 0.00005 }),
      { id: "VOUT", type: "analog_out", v: 2, label: "Vout", required: true, note: "0.5 V + 10 mV/°C: needs an ADC pin" },
      gnd("GND", "GND"),
    ],
    geom: { g: "pcb_part", dims: {} },
    footprint: { k: "inline", pins: ["VS", "VOUT", "GND"], pitch: 2.54, drill: 0.8, pad: 1.5, style: "to92" },
    price_usd: 1.5,
    buy: [
      { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/tmp36-analog-temperature-sensor-tmp36.html" },
      { vendor: "Adafruit", url: "https://www.adafruit.com/product/165" },
    ],
    source: "https://www.analog.com/media/en/technical-documentation/data-sheets/TMP35_36_37.pdf",
    notes: [
      "Wrong way round it gets hot fast: check the flat face before powering it.",
      "On a 5 V Arduino one ADC step is about half a degree: analogReference(INTERNAL) (1.1 V) gives about a tenth of a degree up to 60 °C.",
      "In still air it takes about a minute to follow a change: glue it to what you are measuring.",
    ],
  },
  {
    id: "mcp9808_breakout",
    kind: "sensor",
    name: "Adafruit MCP9808 high accuracy I2C temperature sensor breakout (STEMMA QT)",
    maker: "Adafruit",
    mpn: "5027",
    summary:
      "Microchip MCP9808: ±0.25 °C typical (±0.5 °C from −20 to 100 °C) in 0.0625 °C steps, a reading every 250 ms, over I2C at 0x18 (to 0x1F with A0 to A2), with a programmable alert output. 2.7 to 5.5 V, 200 µA. 25.4 x 17.6 mm with four 2.5 mm holes.",
    specs: { iface: "i2c", i2c_addr: "0x18", chip: "MCP9808", measures: "temperature", resolution_c: 0.0625, accuracy_c: 0.25, tau_s: 30, v_min: 2.7, v_max: 5.5, mass_g: 1.1 },
    pins: [
      pwrIn("VIN", 2.7, 5.5, { label: "VIN", vabs: 6, draw: 0.0002, note: "Power and logic level: use the controller's logic voltage" }),
      gnd(),
      { id: "SCL", type: "in", vmax: 5.5, vih: 2.3, bus: "i2c_scl", required: true },
      { id: "SDA", type: "in", vmax: 5.5, vih: 2.3, bus: "i2c_sda", required: true },
      { id: "ALERT", type: "out", v: 5, label: "Alert", note: "Open drain: low when the temperature passes the limits set in its registers" },
      input("A0", 5.5, 2.3, { label: "A0", note: "Pulled low on the board: tie to VIN for address 0x19" }),
      input("A1", 5.5, 2.3, { label: "A1", note: "Pulled low on the board: tie to VIN to add 2 to the address" }),
      input("A2", 5.5, 2.3, { label: "A2", note: "Pulled low on the board: tie to VIN to add 4 to the address" }),
    ],
    geom: {
      g: "board",
      dims: { w: 25.4, d: 17.6, t: 1.6 },
      holes: [
        [-10.16, -6.35],
        [10.16, -6.35],
        [-10.16, 6.35],
        [10.16, 6.35],
      ],
      hole_d: 2.5,
      features: [
        { kind: "chip", x: 0, y: 0, w: 3, d: 3, h: 1 },
        { kind: "socket", x: -10.5, y: 0, w: 4.2, d: 6, h: 3 },
        { kind: "socket", x: 10.5, y: 0, w: 4.2, d: 6, h: 3 },
      ],
      color: "#16181b",
    },
    price_usd: 4.95,
    buy: [
      { vendor: "Core Electronics (AU)", url: "https://core-electronics.com.au/adafruit-mcp9808-high-accuracy-i2c-temperature-sensor-breakout-stemma-qt-qwiic.html" },
      { vendor: "Pakronics (AU)", url: "https://www.pakronics.com.au/products/adafruit-mcp9808-high-accuracy-i2c-temperature-sensor-breakout-ada5027" },
      { vendor: "Adafruit", url: "https://www.adafruit.com/product/5027" },
    ],
    source: "https://ww1.microchip.com/downloads/en/DeviceDoc/25095A.pdf",
    notes: [
      "Mask the top three bits of the temperature register (T_A): they are alert flags, set from power-up while the limits are 0 °C.",
      "Leave the header off and plug in a STEMMA QT cable to mount it flat.",
    ],
  },
];
