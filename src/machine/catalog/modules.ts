// Display and storage modules that firmware drives through a library: character LCDs (an HD44780 controller,
// on its own 16 pins for LiquidCrystal or on a PCF8574 I2C backpack for LiquidCrystal_I2C) and a microSD card
// breakout on SPI for the SD library. Each is the exact product listed, with its pins as printed on it; sizes and
// holes come from the makers' pages, and the notes say where a board in hand may differ.

import type { CatalogPart, PinDef } from "../types";
import { gnd, input, pwrIn, pwrOut } from "./pins";

const CE = "Core Electronics (AU)";
const LCD_1602 = "https://core-electronics.com.au/standard-lcd-16x2-extras-white-on-blue.html";
const LCD_2004 = "https://core-electronics.com.au/standard-lcd-20x4-extras-white-on-blue.html";
const BACKPACK = "https://core-electronics.com.au/i2c-lcd-backpack-for-1602-to-2004-lcds.html";

/** the four pins on the end of a PCF8574 LCD backpack, in the order printed on it */
const backpackPins = (): PinDef[] => [
  gnd("GND", "GND"),
  pwrIn("VCC", 4.5, 5.5, { vabs: 7, draw: 0.028, label: "VCC", note: "5 V: the LCD and its backlight (about 25 mA with the backlight on). The I2C lines work with a 3.3 V board too" }),
  { id: "SDA", type: "in", vmax: 5.5, vih: 2.0, bus: "i2c_sda", required: true, note: "Pulled up to VCC on the backpack (4.7 kΩ)" },
  { id: "SCL", type: "in", vmax: 5.5, vih: 2.0, bus: "i2c_scl", required: true, note: "Pulled up to VCC on the backpack (4.7 kΩ)" },
];

const LCD_NOTES = [
  "Turn the contrast pot until the text shows: a new module often shows nothing, or a row of solid blocks, until you do.",
  "Characters 0 to 7 are your own (lcd.createChar()). The rest come from the LCD's ROM: ASCII, except that a backslash shows as ¥ and ~ as an arrow; (char)223 is the degree sign.",
];

const I2C_NOTES = [
  "Solder the backpack's 16 pins to the LCD's 16 pads, pin 1 to pin 1 (the backpack's pot sits over the LCD board, not over the edge).",
  "The backpack answers at 0x27 (a PCF8574T, as this one is) or 0x3F (a PCF8574AT). If the screen stays blank, run an I2C scanner sketch and use the address it finds.",
  "Use the Library Manager's \"LiquidCrystal I2C\" (Frank de Brabander): LiquidCrystal_I2C lcd(0x27, cols, rows); then lcd.init(); lcd.backlight(); in setup().",
  "Jaycar's XC3706 port expander does the same job with a different pin order (AU$10.25): follow its labels.",
];

export const MODULES: CatalogPart[] = [
  {
    id: "microsd_breakout_ada254",
    kind: "sensor",
    name: "MicroSD card breakout board+ (Adafruit 254)",
    maker: "Adafruit",
    mpn: "254",
    summary: "A microSD card socket on SPI for logging to files with the SD library. Its 3.3 V regulator (150 mA) and CD74HC4050 level shifter let it run from a 5 V or a 3.3 V board.",
    specs: { iface: "spi", driver: "SDCARD", spi_max_mhz: 25, card_gb: 16, v_min: 3.6, v_max: 6, i_write_ma: 100 },
    pins: [
      pwrIn("V5", 3.6, 6, { vabs: 6.5, draw: 0.03, label: "5V", note: "3.6 to 6 V: the regulator makes the card's 3.3 V. The card draws up to 100 mA in short bursts while it writes" }),
      pwrOut("V3", 3.3, 0.05, { label: "3v", required: false, note: "The regulator's 3.3 V output: leave it unconnected, or take up to 50 mA from it" }),
      gnd("GND", "GND"),
      input("CLK", 5.5, 2.3, { label: "CLK", bus: "spi_sck", required: true, note: "SPI clock: the board's SCK (D13 on an Uno or Nano)" }),
      { id: "DO", type: "out", v: 3.3, label: "DO", bus: "spi_miso", required: true, note: "Data out of the card (MISO): D12 on an Uno or Nano. 3.3 V, which a 5 V board reads as high" },
      input("DI", 5.5, 2.3, { label: "DI", bus: "spi_mosi", required: true, note: "Data into the card (MOSI): D11 on an Uno or Nano" }),
      input("CS", 5.5, 2.3, { label: "CS", required: true, note: "Chip select: any digital pin, the one given to SD.begin(). On an Uno or Nano keep pin 10 an output even when CS is on another pin" }),
      { id: "CD", type: "passive", label: "CD", required: false, note: "Card detect: shorted to GND while no card is in. Wire it to a pin with INPUT_PULLUP: high means a card is in" },
    ],
    geom: {
      g: "board",
      dims: { w: 31.85, d: 25.4, t: 1.6 },
      holes: [
        [-13.4, -10.2],
        [13.4, -10.2],
        [-13.4, 10.2],
        [13.4, 10.2],
      ],
      hole_d: 2.5,
      color: "#1d4fa0",
      features: [
        { kind: "socket", x: 3, y: 2.5, w: 14.5, d: 15, h: 1.9 },
        { kind: "chip", x: -8, y: 3, w: 5, d: 10, h: 1.6 },
        { kind: "header", x: 0, y: -11.4, w: 20.3, d: 2.54, h: 2.5 },
      ],
    },
    footprint: {
      k: "pads",
      pads: ["V5", "V3", "GND", "CLK", "DO", "DI", "CS", "CD"].map((pin, i) => ({ pin, num: String(i + 1), x: -8.89 + 2.54 * i, y: -11.4 })),
      drill: 1.0,
      pad: 1.7,
      square: "1",
      lift: 2.5,
    },
    price_usd: 7.5,
    buy: [{ vendor: CE, url: "https://core-electronics.com.au/microsd-card-breakout-board.html" }],
    source: "https://learn.adafruit.com/adafruit-micro-sd-breakout-board-card-tutorial",
    notes: [
      "Use a microSD card of 32 GB or less (SDHC) formatted FAT32. Cards of 64 GB and more come formatted exFAT, which the Arduino SD library cannot read: format them FAT32 first.",
      "On an Uno or Nano the SD library takes 8.3 file names only (DATALOG.TXT, not datalog-2026.csv) and about 600 bytes of RAM for its 512-byte block buffer.",
      "Each write lands in that buffer: the card is written when it fills, or on flush() and close(). Closing after every line is safe but slow, a few milliseconds a line, and now and then a write waits about 25 ms while the card erases.",
      "Hole positions are Adafruit's usual 0.1-inch corner inset: check yours before printing a mount. The header's order is as printed on the board: 5V, 3v, GND, CLK, DO, DI, CS, CD.",
      "The cheaper Makerverse microSD adapter (Core Electronics CE07926, AU$4.15) works the same way: wire its CS, MOSI, CLK and MISO to the same pins and follow its labels.",
    ],
    tests: ["Log for a minute on the bench, then read the card on a computer before trusting the logger."],
  },
  {
    id: "lcd1602_i2c",
    kind: "display",
    name: "LCD 16 × 2, white on blue, with an I2C backpack (HD44780 + PCF8574T)",
    summary: "A 16-character, 2-line backlit LCD (Adafruit 181) with a PCF8574T I2C backpack soldered on: four wires, address 0x27, LiquidCrystal_I2C. Readable in daylight with the backlight on.",
    specs: { iface: "i2c", i2c_addr: "0x27", driver: "HD44780", backpack: "PCF8574", cols: 16, rows: 2, lcd_color: "white_on_blue", v_min: 4.5, v_max: 5.5 },
    pins: backpackPins(),
    geom: {
      g: "board",
      dims: { w: 80.6, d: 36, t: 1.0 },
      holes: [
        [-37.5, -15.5],
        [37.5, -15.5],
        [-37.5, 15.5],
        [37.5, 15.5],
      ],
      hole_d: 3.0,
      color: "#2c6e3a",
      features: [
        { kind: "module", x: 0, y: -1, w: 71.2, d: 24.2, h: 7.4 },
        { kind: "header", x: -13, y: 16, w: 40.6, d: 2.54, h: 1.5 },
        { kind: "module", x: -13, y: 8.3, w: 40, d: 18, h: 11, side: "bottom", color: "#1a1d22" },
      ],
    },
    price_usd: 11.5,
    buy: [
      { vendor: `${CE}: the LCD (ADA181)`, url: LCD_1602 },
      { vendor: `${CE}: its I2C backpack`, url: BACKPACK },
    ],
    notes: [...LCD_NOTES, ...I2C_NOTES],
  },
  {
    id: "lcd2004_i2c",
    kind: "display",
    name: "LCD 20 × 4, white on blue, with an I2C backpack (HD44780 + PCF8574T)",
    summary: "A 20-character, 4-line backlit LCD (Adafruit 198) with a PCF8574T I2C backpack soldered on: four wires, address 0x27, LiquidCrystal_I2C.",
    specs: { iface: "i2c", i2c_addr: "0x27", driver: "HD44780", backpack: "PCF8574", cols: 20, rows: 4, lcd_color: "white_on_blue", v_min: 4.5, v_max: 5.5 },
    pins: backpackPins(),
    geom: {
      g: "board",
      dims: { w: 98, d: 60, t: 1.6 },
      holes: [
        [-46.5, -27.5],
        [46.5, -27.5],
        [-46.5, 27.5],
        [46.5, 27.5],
      ],
      hole_d: 3.5,
      color: "#2c6e3a",
      features: [
        { kind: "module", x: 0, y: -1.5, w: 97, d: 40, h: 8 },
        { kind: "header", x: -20, y: 27.5, w: 40.6, d: 2.54, h: 1.5 },
        { kind: "module", x: -20, y: 19.8, w: 40, d: 18, h: 11, side: "bottom", color: "#1a1d22" },
      ],
    },
    price_usd: 19,
    buy: [
      { vendor: `${CE}: the LCD (ADA198)`, url: LCD_2004 },
      { vendor: `${CE}: its I2C backpack`, url: BACKPACK },
    ],
    notes: [...LCD_NOTES, ...I2C_NOTES, "Board size and holes are the usual 20 × 4 module's (98 × 60 mm, holes 93 × 55 mm apart): check yours before printing a mount."],
  },
  {
    id: "lcd1602_parallel",
    kind: "display",
    name: "LCD 16 × 2, white on blue, on its own 16 pins (HD44780, Adafruit 181)",
    maker: "Adafruit",
    mpn: "181",
    summary: "A 16-character, 2-line backlit LCD wired pin by pin for Arduino's LiquidCrystal library: six controller pins in 4-bit mode (RS, E, D4 to D7), plus the 10 kΩ contrast pot it comes with.",
    specs: { iface: "parallel", driver: "HD44780", cols: 16, rows: 2, lcd_color: "white_on_blue", v_min: 4.5, v_max: 5.5 },
    pins: [
      gnd("VSS", "1 VSS"),
      pwrIn("VDD", 4.5, 5.5, { vabs: 7, draw: 0.002, label: "2 VDD", note: "5 V for the LCD's logic" }),
      { id: "V0", type: "term", label: "3 V0", required: true, note: "Contrast: the wiper of the 10 kΩ pot that comes with it (its ends to 5 V and GND). Unconnected, the screen shows nothing" },
      input("RS", 5.5, 2.2, { label: "4 RS", required: true, note: "Register select: any digital pin" }),
      input("RW", 5.5, 2.2, { label: "5 RW", required: true, note: "Tie to GND: LiquidCrystal only writes. Left open, the LCD reads instead and ignores everything" }),
      input("E", 5.5, 2.2, { label: "6 E", required: true, note: "Enable: any digital pin. The LCD takes each byte as this falls" }),
      ...[0, 1, 2, 3].map((i) => input(`D${i}`, 5.5, 2.2, { label: `${7 + i} D${i}`, note: "Leave open in 4-bit mode" })),
      ...[4, 5, 6, 7].map((i) => input(`D${i}`, 5.5, 2.2, { label: `${7 + i} D${i}`, required: true, note: "Any digital pin" })),
      pwrIn("A", 3, 5.5, { vabs: 6, draw: 0.02, required: false, label: "15 A", note: "Backlight +: to 5 V (about 20 mA), or a PWM pin through a transistor to dim it" }),
      { ...gnd("K", "16 K"), required: false, note: "Backlight −" },
    ],
    geom: {
      g: "board",
      dims: { w: 80.6, d: 36, t: 1.0 },
      holes: [
        [-37.5, -15.5],
        [37.5, -15.5],
        [-37.5, 15.5],
        [37.5, 15.5],
      ],
      hole_d: 3.0,
      color: "#2c6e3a",
      features: [
        { kind: "module", x: 0, y: -1, w: 71.2, d: 24.2, h: 7.4 },
        { kind: "header", x: -13, y: 16, w: 40.6, d: 2.54, h: 2.5 },
      ],
    },
    footprint: {
      k: "pads",
      pads: ["VSS", "VDD", "V0", "RS", "RW", "E", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "A", "K"].map((pin, i) => ({ pin, num: String(i + 1), x: -32.05 + 2.54 * i, y: 16 })),
      drill: 1.0,
      pad: 1.7,
      square: "1",
      lift: 2.5,
    },
    price_usd: 9.95,
    buy: [{ vendor: CE, url: LCD_1602 }],
    source: "https://core-electronics.com.au/standard-lcd-16x2-extras-white-on-blue.html",
    notes: [
      ...LCD_NOTES,
      "It comes with the 10 kΩ contrast pot and a strip of header pins: add the pot to the design (lib.pot(\"B10k\")) with its wiper on V0.",
      "Arduino's LiquidCrystal: LiquidCrystal lcd(rs, en, d4, d5, d6, d7); then lcd.begin(16, 2); in setup().",
    ],
  },
];
