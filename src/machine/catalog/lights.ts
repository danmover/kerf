// Lights and show hardware: addressable LED rings, sticks and jewels, the
// buttons and emergency stop on a ride's control panel, a hall sensor and the
// magnet it sees, and a slip ring that carries wires onto a part that keeps
// turning. LED numbers are Adafruit's: each WS2812B draws up to 60 mA at full
// white (three 18 to 20 mA channels) and about 1 mA dark.

import type { CatalogPart, PinDef } from "../types";
import { gnd, input, pwrIn } from "./pins";

/** A WS2812B board's pins: 5 V and ground, data in, data out to the next board in the chain. */
function pixelPins(n: number): PinDef[] {
  return [
    pwrIn("V5", 3.5, 5.3, { label: "5V", vabs: 6, draw: n * 0.06, note: `Up to ${(n * 0.06).toFixed(2)} A at full white. Give the board its own 5 V supply wires, and a 470 µF capacitor across 5V and GND at the first board` }),
    gnd(),
    input("DIN", 5.5, 3.5, { label: "Data in", required: true, note: "Reads high above 0.7 × its 5 V supply (3.5 V): a 5 V controller drives it directly; a 3.3 V one needs a level shifter. Put a 300 to 500 Ω resistor in the data wire" }),
    { id: "DOUT", type: "out", v: 5, vref: "V5", label: "Data out", note: "To the next board's DIN" },
  ];
}

const adafruit = (id: number) => ({ vendor: "Adafruit", url: `https://www.adafruit.com/product/${id}` });

function ring(id: string, item: number, n: number, od: number, idd: number, price: number, mass: number): CatalogPart {
  return {
    id,
    kind: "led",
    name: `Adafruit NeoPixel Ring, ${n} × WS2812B (${od} mm)`,
    maker: "Adafruit",
    mpn: String(item),
    summary: `Round board of ${n} addressable RGB LEDs (WS2812B 5050), ${od} mm across with a ${idd} mm hole, 5 V, up to ${(n * 0.06).toFixed(2)} A at full white. One data wire drives it; chain more boards from its data out.`,
    specs: { leds: n, chip: "WS2812B", order: "GRB", od, id: idd, ma_per_led: 60, idle_ma: 1, mass_g: mass },
    pins: pixelPins(n),
    geom: { g: "led", dims: { od, id: idd, t: 1.6, n, led: 5, led_h: 1.6 }, color: "#16191e" },
    price_usd: price,
    buy: [adafruit(item), { vendor: "Marketplace", search: `WS2812B ${n} LED ring ${Math.round(od)}mm` }],
    source: `https://www.adafruit.com/product/${item}`,
    notes: ["Solder the three wires to the pads on the back: 5V, GND and DIN (DOUT for the next board).", "Glue or clip it by its edge: it has no mounting holes."],
  };
}

export const LIGHTS: CatalogPart[] = [
  // ---------------- addressable LEDs ----------------
  ring("neopixel_ring_12", 1643, 12, 37, 23, 7.5, 2.5),
  ring("neopixel_ring_16", 1463, 16, 44.5, 31.75, 9.95, 3.5),
  ring("neopixel_ring_24", 1586, 24, 65.5, 52.3, 16.95, 6.5),
  {
    id: "neopixel_ring_60",
    kind: "led",
    name: "Adafruit NeoPixel 60 Ring, 4 × 1/4 ring of 15 WS2812B (158 mm)",
    maker: "Adafruit",
    mpn: "1768",
    summary: "Four quarter-ring boards of 15 addressable RGB LEDs each, soldered into one 60-LED ring 158 mm across (about a 145 mm hole), 5 V, up to 3.6 A at full white.",
    specs: { leds: 60, chip: "WS2812B", order: "GRB", od: 158, id: 145, ma_per_led: 60, idle_ma: 1, mass_g: 16 },
    pins: pixelPins(60),
    geom: { g: "led", dims: { od: 158, id: 145, t: 1.6, n: 60, led: 5, led_h: 1.6 }, color: "#16191e" },
    price_usd: 4 * 9.95,
    buy: [adafruit(1768), { vendor: "Marketplace", search: "WS2812B 60 LED ring 1/4 arc 158mm" }],
    source: "https://www.adafruit.com/product/1768",
    notes: ["Sold as quarters: buy four and solder the 5V, GND and data joints between them into one ring.", "Feed 5 V and GND at two opposite joints as well as at the start: thin copper drops voltage round 60 LEDs.", "The hole size is not published: about 145 mm, measure yours before printing a seat."],
  },
  {
    id: "neopixel_stick_8",
    kind: "led",
    name: "Adafruit NeoPixel Stick, 8 × WS2812B (51 mm)",
    maker: "Adafruit",
    mpn: "1426",
    summary: "Straight strip board of 8 addressable RGB LEDs, 51.1 × 10.2 mm, 5 V, up to 0.48 A at full white.",
    specs: { leds: 8, chip: "WS2812B", order: "GRB", w: 51.1, d: 10.2, ma_per_led: 60, idle_ma: 1, mass_g: 3 },
    pins: pixelPins(8),
    geom: { g: "led", dims: { w: 51.1, d: 10.2, t: 1.6, n: 8, led: 5, led_h: 1.6 }, color: "#16191e" },
    price_usd: 5.95,
    buy: [adafruit(1426), { vendor: "Marketplace", search: "WS2812B 8 LED stick" }],
    source: "https://www.adafruit.com/product/1426",
    notes: ["Pads at both ends: DIN at one, DOUT at the other, 5V and GND at both."],
  },
  {
    id: "neopixel_jewel_7",
    kind: "led",
    name: "Adafruit NeoPixel Jewel, 7 × WS2812B (23 mm)",
    maker: "Adafruit",
    mpn: "2226",
    summary: "Round board of 7 addressable RGB LEDs, six round one in the middle, 23 mm across, 5 V, up to 0.42 A at full white. A lantern, a beacon or an eye.",
    specs: { leds: 7, chip: "WS2812B", order: "GRB", od: 23, id: 0, ma_per_led: 60, idle_ma: 1, mass_g: 1.5 },
    pins: pixelPins(7),
    geom: { g: "led", dims: { od: 23, id: 0, t: 1.6, n: 7, led: 5, led_h: 1.6 }, color: "#16191e" },
    price_usd: 5.95,
    buy: [adafruit(2226), { vendor: "Marketplace", search: "WS2812B 7 LED jewel" }],
    source: "https://www.adafruit.com/product/2226",
  },

  // ---------------- control panel ----------------
  {
    id: "button_16mm",
    kind: "switch",
    name: "16 mm momentary push button, panel mount (normally open)",
    generic: true,
    summary: "Metal momentary push button for a 16 mm panel hole: the contacts close while it is pressed. A ride's start button.",
    specs: { hole_d: 16, rating_a: 2, v_max: 36, momentary: 1 },
    pins: [
      { id: "A", type: "passive", label: "NO", required: true },
      { id: "B", type: "passive", label: "C", required: true, note: "Wire one contact to a controller pin set to INPUT_PULLUP and the other to GND: the pin reads LOW while it is pressed" },
    ],
    geom: { g: "panel_jack", dims: { bush_d: 16, bush_l: 10, nut_af: 20, nut_t: 2.5, body_w: 14, body_d: 14, body_l: 18, hole_d: 16.2, cap_d: 13, cap_h: 2.5 }, color: "#c8ccd2", color2: "#22252b" },
    price_usd: 2,
    buy: [{ vendor: "Marketplace", search: "16mm momentary push button metal waterproof" }],
  },
  {
    id: "estop_jaycar_sp0786",
    kind: "switch",
    name: "Latching emergency stop, 22 mm, 1 NC + 1 NO (Jaycar SP0786)",
    maker: "Jaycar",
    mpn: "SP0786",
    summary: "Red 40 mm mushroom head for a 22 mm hole with one normally closed and one normally open contact: pressing it opens NC, closes NO and latches; twist to release.",
    specs: { hole_d: 22.5, rating_a: 10, v_max: 250, latching: 1, contacts: "1NC+1NO" },
    pins: [
      { id: "NC_1", type: "passive", label: "NC 1", through: "NC_2", required: true, note: "Normally closed: put it in the signal or supply that must break when it is pressed, so the stop works whatever the controller is doing" },
      { id: "NC_2", type: "passive", label: "NC 2", through: "NC_1", required: true },
      { id: "NO_3", type: "passive", label: "NO 3", note: "Normally open: closes when pressed, so the controller can see the stop (a pin with its pull-up on, to GND here)" },
      { id: "NO_4", type: "passive", label: "NO 4" },
    ],
    geom: { g: "panel_jack", dims: { bush_d: 22, bush_l: 10, nut_af: 28, nut_t: 3, body_w: 30, body_d: 34, body_l: 36, hole_d: 22.5, cap_d: 40, cap_h: 16, panel_t: 3 }, color: "#d63a2f", color2: "#2b2f36" },
    price_usd: 12,
    buy: [{ vendor: "Jaycar (AU)", url: "https://www.jaycar.com.au/latching-emergency-stop-switch/p/SP0786" }],
    notes: ["An emergency stop must act in hardware: its NC contact breaks the ESC signal (or the motor supply); the NO contact only tells the firmware."],
  },
  {
    id: "estop_22mm",
    kind: "switch",
    name: "22 mm emergency stop button, mushroom head, normally closed",
    generic: true,
    summary: "Red mushroom-head emergency stop for a 22 mm panel hole: pressing it opens the contacts and latches; twist to release. 10 A.",
    specs: { hole_d: 22.5, rating_a: 10, v_max: 250, latching: 1 },
    pins: [
      { id: "IN", type: "passive", label: "NC 1", through: "OUT", required: true, note: "Normally closed: put it in the motors' supply so pressing it cuts their power whatever the controller is doing" },
      { id: "OUT", type: "passive", label: "NC 2", through: "IN", required: true },
    ],
    geom: { g: "panel_jack", dims: { bush_d: 22, bush_l: 10, nut_af: 28, nut_t: 3, body_w: 30, body_d: 30, body_l: 32, hole_d: 22.5, cap_d: 40, cap_h: 14 }, color: "#d63a2f", color2: "#2b2f36" },
    price_usd: 6,
    buy: [{ vendor: "Marketplace", search: "22mm emergency stop button mushroom NC" }],
    notes: ["An emergency stop must cut power in hardware: wire it in the motor supply, not only to a controller pin."],
  },

  // ---------------- sensing ----------------
  {
    id: "hall_ky003",
    kind: "sensor",
    name: "Hall effect sensor module KY-003 (A3144)",
    generic: true,
    summary: "A3144 hall switch on a small board with a pull-up and an indicator LED: its output goes low when a magnet's south pole comes within about 6 mm. Homing a turntable or counting turns.",
    // sense_*: where the chip's face is on the board, from its centre underneath
    specs: { iface: "hall", range_mm: 6, v_min: 4.5, v_max: 24, sense_x: 7.5, sense_y: 0, sense_z: 3.1 },
    pins: [pwrIn("VCC", 4.5, 24, { label: "+", draw: 0.004 }), gnd("GND", "−"), { id: "S", type: "out", v: 5, vref: "VCC", label: "S", required: true, note: "Low while a magnet is near" }],
    // the three header pins point down out of the board's far end from the chip, so it can lie flat just under what it senses
    geom: { g: "board", dims: { w: 18.5, d: 15, t: 1.6 }, holes: [[0, 4.5]], hole_d: 3, color: "#1d4fa0", features: [{ kind: "chip", x: 7.5, y: 0, w: 4, d: 3, h: 1.5 }, { kind: "header", x: -7.5, y: 0, w: 2.54, d: 7.62, h: 2.5 }] },
    price_usd: 1.5,
    buy: [{ vendor: "Marketplace", search: "KY-003 hall effect sensor module" }],
    notes: ["The A3144 sees one pole only: face the magnet's south pole at the printed face of the chip.", "Fit the header pins pointing down out of the back of the board (most sellers ship them loose or bent flat), so the board lies flat with the chip a few millimetres from the magnet's path."],
  },
  {
    id: "magnet_6x3_n35",
    kind: "magnet",
    name: "Neodymium disc magnet 6 × 3 mm, N35",
    generic: true,
    summary: "Small N35 disc magnet, 6 mm across and 3 mm thick, for a hall sensor to see. Press or glue it into a 6.1 mm pocket.",
    specs: { d: 6, h: 3, grade: "N35", mass_g: 0.64 },
    pins: [],
    geom: { g: "disc", dims: { d: 6, h: 3 }, color: "#c3c8cf", material: "Steel" },
    price_usd: 0.1,
    buy: [{ vendor: "Marketplace", search: "neodymium disc magnet 6x3mm N35" }],
    notes: ["Mark the south pole before gluing it in (a hall sensor shows which side it sees)."],
  },

  // ---------------- wires onto a turning part ----------------
  {
    id: "slip_ring_12mm_6",
    kind: "connector",
    name: "Adafruit miniature slip ring, 12 mm, 6 wires, 2 A",
    maker: "Adafruit",
    mpn: "1196",
    summary: "Carries six wires from a fixed part onto one that keeps turning: a 12 mm body 17 mm long, 2 A per wire, up to 300 rpm, 26 AWG leads at both ends.",
    specs: { circuits: 6, rating_a: 2, v_max: 240, rpm_max: 300, d: 12, h: 17 },
    pins: [1, 2, 3, 4, 5, 6].flatMap((i): PinDef[] => [
      { id: `S${i}`, type: "passive", label: `fixed wire ${i}`, through: `R${i}`, required: false },
      { id: `R${i}`, type: "passive", label: `turning wire ${i}`, through: `S${i}`, required: false },
    ]),
    geom: { g: "disc", dims: { d: 12, h: 17, collar_d: 7.8, collar_h: 5 }, color: "#c8ccd2", material: "Aluminum 6061" },
    price_usd: 15,
    buy: [adafruit(1196), { vendor: "Marketplace", search: "12mm slip ring 6 wire 2A" }],
    source: "https://www.adafruit.com/product/1196",
    notes: ["The body stays with the fixed part and the collar turns with the moving one: hold the body in a clamp and couple the collar to the turning shaft.", "Two wires each for 5 V and ground keep the voltage drop down when LEDs draw over 1 A."],
  },
];
