// Character LCDs and a microSD card wired into a design and run from firmware: the HD44780 takes what the
// LiquidCrystal libraries send as the real one does (an I2C backpack's bytes, or the module's own pins as E falls),
// shows a row of blocks until it is set up, garbles text when two data wires are swapped, and the SD card keeps
// the files the firmware writes, once its wires are on the hardware SPI pins.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { Halt, loadFirmware, NANO } from "../src/sim/mcu";
import { Plant } from "../src/sim/engine/plant";
import { Bench, type BenchSpec } from "../src/sim/worlds/bench";
import { evaluate } from "../src/lang/evaluator";
import { rngFrom } from "../src/sim/worlds/common";
import { Hd44780, Pcf8574Lcd, romGlyph } from "../src/sim/engine/lcd";
import { displayLook, peripheralResults } from "../src/sim/engine/peripherals";
import { catalogPart } from "../src/machine/catalog";

const BENCH: BenchSpec = { loads: {}, loadFactor: 1, forces: {}, force: 0, range: 300, ambient: 25 };

function design(body: string) {
  const m = evaluate(
    `design "Bench"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component psu = lib.psu("psu_12v_2a") { at: (200, 0, 0) }
wire psu.VPOS -> ctrl.VIN
${body}`,
    { skipGeometry: true },
  );
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return m;
}

function run(m: ReturnType<typeof design>, sketch: string, seconds: number) {
  const hal = new SimHal(NANO, { seed: 3 });
  const plant = new Plant(m.machine!, "ctrl", NANO, hal, new Bench(m.machine!, BENCH, "expected"), { rng: rngFrom(11) });
  hal.endCyc = Math.round(seconds * NANO.fcpu);
  const fw = loadFirmware({ "t.ino": sketch }, NANO, hal).fw;
  hal.bindVectors(fw);
  fw.reset();
  try {
    fw.call("setup");
    for (;;) {
      const c0 = hal.cyc;
      fw.call("loop");
      const used = hal.cyc - c0;
      if (used < hal.stepCycles) hal.spend(hal.stepCycles - used);
      else if (hal.cyc >= hal.nextEvt) hal.service();
    }
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
  }
  hal.finishSerial();
  const lcd = plant.displays[0] as unknown as Hd44780 | undefined;
  lcd?.tick(hal.cyc, true);
  return {
    hal,
    plant,
    lcd,
    out: hal.serial.filter((l) => l.dir === "out").map((l) => l.text),
    events: plant.events.map((e) => e.text),
    faults: hal.faults.map((f) => f.msg),
  };
}

/** the cell at (row, col) of the LCD's last frame is solid: all 5 × 8 dots dark */
function solid(lcd: Hd44780, row: number, col: number) {
  const px = lcd.frames[lcd.frames.length - 1].px;
  const stride = lcd.w >> 3;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 5; x++) {
      const X = col * 6 + x;
      if (!(px[(row * 9 + y) * stride + (X >> 3)] & (0x80 >> (X & 7)))) return false;
    }
  return true;
}

const I2C_LCD = `
component lcd = lib.display("lcd1602_i2c") { at: (0, 60, 0) }
net GND: psu.VNEG, ctrl.GND, lcd.GND
wire ctrl.V5 -> lcd.VCC
wire ctrl.A4 -> lcd.SDA
wire ctrl.A5 -> lcd.SCL`;

const I2C_SKETCH = (addr = "0x27", start = "lcd.init();") => `
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(${addr}, 16, 2);
byte heart[8] = {0b00000, 0b01010, 0b11111, 0b11111, 0b01110, 0b00100, 0b00000, 0b00000};
void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  ${start}
  unsigned long t1 = millis();
  lcd.backlight();
  lcd.createChar(0, heart);
  lcd.setCursor(0, 0);
  unsigned long t2 = micros();
  lcd.print("Hello, world!");
  unsigned long t3 = micros();
  lcd.setCursor(0, 1);
  lcd.write(byte(0));
  lcd.print(" 23.5");
  lcd.write(223);
  lcd.print("C \\\\");
  Serial.println(t1 - t0);
  Serial.println(t3 - t2);
}
void loop() {}
`;

describe("a 16 × 2 LCD on an I2C backpack", () => {
  it("shows what LiquidCrystal_I2C prints, at the speed 100 kHz I2C allows", () => {
    const r = run(design(I2C_LCD), I2C_SKETCH(), 1.3);
    expect(r.faults).toEqual([]);
    expect(r.events).toEqual([]);
    const lcd = r.lcd!;
    expect(lcd.text()).toEqual(["Hello, world!   ", "\x00 23.5\xdfC \\      "]);
    // the look the app and Claude get: the ROM's own characters, custom ones as a box
    expect(displayLook(lcd).look?.text).toEqual(["Hello, world!   ", "□ 23.5°C ¥      "]);
    // init(): 50 ms, a second with the backlight off, then the 4-bit start-up
    const [init, print] = r.out.map(Number);
    expect(init).toBeGreaterThanOrEqual(1060);
    expect(init).toBeLessThan(1090);
    // six one-byte transmissions a character at 100 kHz: about 1.3 ms each
    expect(print / 13).toBeGreaterThan(1100);
    expect(print / 13).toBeLessThan(1500);
    expect(lcd.frames[lcd.frames.length - 1].light).toBe(1);
    // the heart from CGRAM in the first cell of row 2
    expect(Array.from(lcd.cgram.subarray(0, 8))).toEqual([0, 10, 31, 31, 14, 4, 0, 0]);
  });

  it("shows a row of blocks with its backlight on when the sketch has the wrong address", () => {
    const r = run(design(I2C_LCD), I2C_SKETCH("0x3F"), 1.3);
    expect(r.faults.some((f) => /nothing answered at address 0x3F/.test(f) && /0x27/.test(f))).toBe(true);
    const lcd = r.lcd!;
    for (let c = 0; c < 16; c++) expect(solid(lcd, 0, c)).toBe(true);
    expect(solid(lcd, 1, 0)).toBe(false);
    // the backpack's pins come up high, so its backlight is on
    expect(lcd.frames[lcd.frames.length - 1].light).toBe(1);
  });

  it("says so when begin() is used without init(), which never starts Wire", () => {
    const r = run(design(I2C_LCD), I2C_SKETCH("0x27", "lcd.begin(16, 2);"), 1.3);
    expect(r.faults.some((f) => /Wire was not started/.test(f) && /lcd\.init\(\)/.test(f))).toBe(true);
    expect(solid(r.lcd!, 0, 0)).toBe(true);
  });

  it("warns that println() puts junk on the screen", () => {
    const r = run(design(I2C_LCD), `#include <LiquidCrystal_I2C.h>\nLiquidCrystal_I2C lcd(0x27, 16, 2);\nvoid setup() { lcd.init(); lcd.println("hi"); }\nvoid loop() {}`, 1.2);
    expect(r.faults.some((f) => /println\(\)/.test(f))).toBe(true);
    expect(r.lcd!.text()[0].slice(0, 4)).toBe("hi\r\n");
  });
});

const PARALLEL = (d4 = "D5", d5 = "D4") => `
component lcd = lib.display("lcd1602_parallel") { at: (0, 60, 0) }
component pot = lib.pot("B10k") { at: (0, 120, 0) }
net GND: psu.VNEG, ctrl.GND, lcd.VSS, lcd.RW, lcd.K, pot.CCW
net LOGIC: ctrl.V5, lcd.VDD, lcd.A, pot.CW
wire pot.W -> lcd.V0
wire ctrl.D12 -> lcd.RS
wire ctrl.D11 -> lcd.E
wire ctrl.${d4} -> lcd.D4
wire ctrl.${d5} -> lcd.D5
wire ctrl.D3 -> lcd.D6
wire ctrl.D2 -> lcd.D7`;

// Arduino's HelloWorld example
const HELLO = `
#include <LiquidCrystal.h>
const int rs = 12, en = 11, d4 = 5, d5 = 4, d6 = 3, d7 = 2;
LiquidCrystal lcd(rs, en, d4, d5, d6, d7);
void setup() {
  Serial.begin(115200);
  lcd.begin(16, 2);
  unsigned long t0 = micros();
  lcd.print("hello, world!");
  Serial.println(micros() - t0);
}
void loop() {
  lcd.setCursor(0, 1);
  lcd.print(millis() / 1000);
}
`;

describe("a 16 × 2 LCD on its own pins", () => {
  it("runs Arduino's HelloWorld in 4-bit mode", () => {
    const r = run(design(PARALLEL()), HELLO, 2.2);
    expect(r.faults).toEqual([]);
    expect(r.plant.notes).toEqual([]);
    expect(r.lcd!.text()).toEqual(["hello, world!   ", "2               "]);
    // seven digitalWrites and 102 µs of waits a nibble: about 0.28 ms a character
    const us = Number(r.out[0]) / 13;
    expect(us).toBeGreaterThan(230);
    expect(us).toBeLessThan(330);
  });

  it("shows garbage when D4 and D5 are swapped in the wiring", () => {
    const r = run(design(PARALLEL("D4", "D5")), HELLO, 0.5);
    expect(r.lcd!.text()[0]).not.toBe("hello, world!   ");
  });

  it("stays blank with V0 left unconnected", () => {
    const body = PARALLEL().replace("wire pot.W -> lcd.V0\n", "");
    const r = run(design(body), HELLO, 0.5);
    expect(r.plant.notes.some((n) => /V0 \(contrast\) is not connected/.test(n))).toBe(true);
    const px = r.lcd!.frames[r.lcd!.frames.length - 1]?.px ?? new Uint8Array(1);
    expect(px.every((b) => b === 0)).toBe(true);
  });
});

describe("the HD44780 itself", () => {
  it("draws ¥ for a backslash, arrows at 0x7E and 0x7F, and loses bytes sent while it is busy", () => {
    expect(romGlyph(0x5c)).toEqual([0x11, 0x0a, 0x1f, 0x04, 0x1f, 0x04, 0x04, 0]);
    expect(romGlyph(0x7e)).toEqual([0, 0x04, 0x02, 0x1f, 0x02, 0x04, 0, 0]);
    const lcd = new Hd44780("lcd", 16, 2, 16e6);
    const warns: string[] = [];
    lcd.warn = (m) => warns.push(m);
    const pcf = new Pcf8574Lcd(lcd);
    // its supply comes up at 0, as the plant's first step shows it
    lcd.tick(0);
    const ms = 16e3;
    // one 8-bit instruction through the backpack's top four bits (the low ones float high)
    const strobe8 = (v: number, t: number) => pcf.write([v | 0x04, v], t);
    let t = 50 * ms;
    strobe8(0x30, t);
    strobe8(0x30, (t += 5 * ms));
    strobe8(0x30, (t += ms));
    strobe8(0x20, (t += ms));
    const send = (v: number, rs: number, at: number) => {
      pcf.write([(v & 0xf0) | rs | 0x04, (v & 0xf0) | rs], at);
      pcf.write([((v << 4) & 0xf0) | rs | 0x04, ((v << 4) & 0xf0) | rs], at);
    };
    send(0x28, 0, (t += ms));
    send(0x0c, 0, (t += ms));
    send(0x01, 0, (t += ms));
    // 0.1 ms after a clear: still busy for 1.4 ms more
    send(0x41, 1, (t += ms / 10));
    expect(warns.some((w) => /still busy/.test(w))).toBe(true);
    send(0x41, 1, (t += 2 * ms));
    expect(lcd.text()[0][0]).toBe("A");
  });

  it("is in the catalogue with its I2C address and its pins", () => {
    const p = catalogPart("lcd1602_i2c")!;
    expect(p.specs.i2c_addr).toBe("0x27");
    expect(p.pins.map((x) => x.id)).toEqual(["GND", "VCC", "SDA", "SCL"]);
    expect(catalogPart("lcd1602_parallel")!.pins.length).toBe(16);
  });
});

const SD = (miso = "D12") => `
component sd = lib.sensor("microsd_breakout_ada254") { at: (0, 60, 0) }
net GND: psu.VNEG, ctrl.GND, sd.GND
wire ctrl.V5 -> sd.V5
wire ctrl.D13 -> sd.CLK
wire ctrl.${miso} -> sd.DO
wire ctrl.D11 -> sd.DI
wire ctrl.D4 -> sd.CS`;

const LOGGER = `
#include <SPI.h>
#include <SD.h>
void setup() {
  Serial.begin(115200);
  if (!SD.begin(4)) {
    Serial.println("init failed");
    return;
  }
  File f = SD.open("LOG.TXT", FILE_WRITE);
  for (int i = 0; i < 3; i++) {
    f.print("t=");
    f.println(i);
  }
  f.close();
  f = SD.open("LOG.TXT");
  while (f.available()) Serial.write(f.read());
  f.close();
}
void loop() {}
`;

describe("a microSD breakout in the design", () => {
  it("keeps the files the firmware writes, for the run's results", () => {
    const r = run(design(SD()), LOGGER, 0.5);
    expect(r.faults).toEqual([]);
    expect(r.plant.notes).toEqual([]);
    expect(r.out).toEqual(["t=0", "t=1", "t=2"]);
    const cards = peripheralResults(r.plant).sdCards!;
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe("sd");
    expect(cards[0].files).toEqual([{ path: "/LOG.TXT", bytes: 15, text: "t=0\r\nt=1\r\nt=2\r\n" }]);
    expect(cards[0].blocksWritten).toBeGreaterThan(0);
  });

  it("is off the bus when DO is not on the MISO pin, so SD.begin() fails after its timeout", () => {
    const r = run(design(SD("D9")), LOGGER, 2.6);
    expect(r.plant.notes.some((n) => /DO goes to pin 9, not the MISO pin \(12\)/.test(n))).toBe(true);
    expect(r.out).toEqual(["init failed"]);
    expect(peripheralResults(r.plant).sdCards).toBeUndefined();
  });
});
