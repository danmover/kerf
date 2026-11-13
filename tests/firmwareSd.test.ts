// SPI and SD cards as the firmware uses them: the SPI library's clock, modes and transfers on the bus, and the SD
// library's files on a card (8.3 names and FILE_WRITE appending on the Uno and Nano; long names, "/" paths and
// FILE_WRITE truncating on the ESP32), with each block taking its time on the bus.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { FEATHER_ESP32_V2, Halt, loadFirmware, NANO, type Board } from "../src/sim/mcu";
import { SdCard } from "../src/sim/mcu/sdcard";
import type { SpiDevice } from "../src/sim/mcu/vm";

function run(sketch: string, seconds: number, opts: { board?: Board; setup?: (hal: SimHal) => void } = {}) {
  const board = opts.board ?? NANO;
  const hal = new SimHal(board, { seed: 5 });
  hal.endCyc = Math.round(seconds * board.fcpu);
  opts.setup?.(hal);
  const fw = loadFirmware({ "sketch.ino": sketch }, board, hal).fw;
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
  const lines = hal.serial.filter((l) => l.dir === "out");
  return { hal, lines: lines.map((l) => l.text), at: lines.map((l) => l.t), faults: hal.faults.map((f) => f.msg) };
}

/** a device that answers each byte with the byte it got before, inverted */
class Echo implements SpiDevice {
  name = "echo chip";
  maxHz = 8e6;
  modes = [0];
  last = 0;
  selects: boolean[] = [];
  transfer(b: number) {
    const r = ~this.last & 255;
    this.last = b;
    return r;
  }
  select(on: boolean) {
    this.selects.push(on);
  }
}

describe("SPI", () => {
  it("transfers bytes with the device selected, at the rate SPISettings picks", () => {
    const echo = new Echo();
    const r = run(
      `#include <SPI.h>
void setup() {
  Serial.begin(115200);
  SPI.begin();
  pinMode(7, OUTPUT);
  digitalWrite(7, HIGH);
  SPI.beginTransaction(SPISettings(3000000, MSBFIRST, SPI_MODE0));
  digitalWrite(7, LOW);
  unsigned long t0 = micros();
  uint8_t a = SPI.transfer(0x12);
  uint8_t b = SPI.transfer(0x34);
  uint8_t buf[4] = { 1, 2, 3, 4 };
  SPI.transfer(buf, 4);
  unsigned long dt = micros() - t0;
  digitalWrite(7, HIGH);
  SPI.endTransaction();
  Serial.println(a, HEX);
  Serial.println(b, HEX);
  Serial.println(buf[0], HEX);
  Serial.println(buf[3], HEX);
  Serial.println(dt);
  Serial.println(SPI.transfer(0x55), HEX);
}
void loop() {}`,
      0.05,
      { setup: (hal) => hal.spi.attach(7, echo) },
    );
    expect(r.lines.slice(0, 4)).toEqual(["FF", "ED", "CB", "FC"]);
    // 3 MHz asks for F_CPU/8 = 2 MHz: 6 bytes of 4 µs each, and the calls around them
    expect(r.hal.spi.hz).toBe(2e6);
    expect(Number(r.lines[4])).toBeGreaterThanOrEqual(24);
    expect(Number(r.lines[4])).toBeLessThan(40);
    // nothing selected: MISO floats high
    expect(r.lines[5]).toBe("FF");
    expect(echo.selects).toEqual([true, false]);
    expect(r.faults).toEqual([]);
  });

  it("says when two devices are selected at once, or the clock is too fast for one", () => {
    const a = new Echo();
    const b = new Echo();
    b.name = "slow chip";
    b.maxHz = 1e6;
    const r = run(
      `#include <SPI.h>
void setup() {
  SPI.begin();
  pinMode(7, OUTPUT);
  pinMode(8, OUTPUT);
  digitalWrite(7, LOW);
  digitalWrite(8, LOW);
  SPI.transfer(1);
}
void loop() {}`,
      0.01,
      {
        setup: (hal) => {
          hal.spi.attach(7, a);
          hal.spi.attach(8, b);
        },
      },
    );
    expect(r.faults.some((f) => f.includes("selected at once"))).toBe(true);
    expect(r.faults.some((f) => f.includes("faster than slow chip takes"))).toBe(true);
  });
});

const LOGGER = `#include <SPI.h>
#include <SD.h>
const int chipSelect = 4;
void setup() {
  Serial.begin(115200);
  if (!SD.begin(chipSelect)) {
    Serial.println("Card failed, or not present");
    while (1);
  }
  Serial.println("card initialized.");
}
int n = 0;
void loop() {
  File dataFile = SD.open("datalog.txt", FILE_WRITE);
  if (dataFile) {
    unsigned long t0 = millis();
    dataFile.print("reading ");
    dataFile.println(n++);
    dataFile.close();
    if (n == 3) Serial.println(millis() - t0);
  } else {
    Serial.println("error opening datalog.txt");
  }
  if (n == 5) {
    File f = SD.open("DATALOG.TXT");
    Serial.println(f.name());
    Serial.println(f.size());
    while (f.available()) Serial.write(f.read());
    f.close();
    Serial.println(SD.exists("nothere.txt") ? "yes" : "no");
    Serial.println(SD.open("a_long_name.txt", FILE_WRITE) ? "opened" : "no long names");
    while (1);
  }
  delay(100);
}`;

describe("SD card (Uno and Nano)", () => {
  it("logs lines to a file the way the Datalogger example does", () => {
    const card = new SdCard("microSD module");
    const r = run(LOGGER, 1.2, { setup: (hal) => hal.spi.attach(4, card) });
    expect(r.lines[0]).toBe("card initialized.");
    // open, append and close: a few block reads and writes on the bus, several milliseconds
    const ms = Number(r.lines[1]);
    expect(ms).toBeGreaterThanOrEqual(3);
    expect(ms).toBeLessThan(30);
    expect(r.lines.slice(2, 4)).toEqual(["DATALOG.TXT", String(5 * "reading 0\r\n".length)]);
    expect(r.lines.slice(4, 9)).toEqual(["reading 0", "reading 1", "reading 2", "reading 3", "reading 4"]);
    expect(r.lines.slice(9)).toEqual(["no", "no long names"]);
    expect(card.report()).toEqual([{ path: "/DATALOG.TXT", bytes: 55, text: "reading 0\r\nreading 1\r\nreading 2\r\nreading 3\r\nreading 4\r\n" }]);
    expect(card.writes).toBeGreaterThan(5);
  });

  it("fails SD.begin() after its timeout when no card answers", () => {
    const r = run(LOGGER, 2.5);
    expect(r.lines).toEqual(["Card failed, or not present"]);
    expect(r.at[0]).toBeGreaterThan(2);
    expect(r.faults.some((f) => f.includes("no microSD card module has its CS on pin 4"))).toBe(true);
  });

  it("cannot read an exFAT card", () => {
    const card = new SdCard("microSD module", 64 * 2 ** 30, "exFAT");
    const r = run(LOGGER, 0.5, { setup: (hal) => hal.spi.attach(4, card) });
    expect(r.lines).toEqual(["Card failed, or not present"]);
    expect(r.faults.some((f) => f.includes("exFAT"))).toBe(true);
  });

  it("makes folders, lists them and removes files", () => {
    const card = new SdCard("microSD module");
    const r = run(
      `#include <SD.h>
void setup() {
  Serial.begin(115200);
  SD.begin(10);
  SD.mkdir("logs/2026");
  File a = SD.open("logs/2026/a.csv", FILE_WRITE);
  a.println("1,2,3");
  a.close();
  File b = SD.open("logs/b.txt", FILE_WRITE);
  b.print("x");
  b.close();
  File dir = SD.open("logs");
  while (true) {
    File e = dir.openNextFile();
    if (!e) break;
    Serial.print(e.name());
    Serial.println(e.isDirectory() ? "/" : "");
    e.close();
  }
  Serial.println(SD.remove("logs/b.txt") ? "removed" : "kept");
  Serial.println(SD.exists("logs/b.txt") ? "still there" : "gone");
  Serial.println(SD.rmdir("logs/2026") ? "removed" : "not empty");
}
void loop() {}`,
      0.6,
      { setup: (hal) => hal.spi.attach(10, card) },
    );
    expect(r.lines).toEqual(["2026/", "B.TXT", "removed", "gone", "not empty"]);
  });
});

describe("SD card (ESP32)", () => {
  it("wants paths from /, keeps long names, truncates with FILE_WRITE and appends with FILE_APPEND", () => {
    const card = new SdCard("microSD module");
    const r = run(
      `#include "FS.h"
#include "SD.h"
#include "SPI.h"
void writeFile(fs::FS &fs, const char *path, const char *message) {
  File file = fs.open(path, FILE_WRITE);
  if (!file) {
    Serial.println("Failed to open file for writing");
    return;
  }
  file.print(message);
  file.close();
}
void appendFile(fs::FS &fs, const char *path, const char *message) {
  File file = fs.open(path, FILE_APPEND);
  file.print(message);
  file.close();
}
void setup() {
  Serial.begin(115200);
  if (!SD.begin(5)) {
    Serial.println("Card Mount Failed");
    return;
  }
  Serial.println(SD.cardType() == CARD_SDHC ? "SDHC" : "other");
  writeFile(SD, "/hello world.txt", "Hello ");
  appendFile(SD, "/hello world.txt", "World!");
  writeFile(SD, "/second.txt", "one");
  writeFile(SD, "/second.txt", "two");
  writeFile(SD, "nope.txt", "x");
  File f = SD.open("/hello world.txt");
  Serial.println(f.name());
  while (f.available()) Serial.write(f.read());
  Serial.println();
  f.close();
}
void loop() {}`,
      0.5,
      { board: FEATHER_ESP32_V2, setup: (hal) => hal.spi.attach(5, card) },
    );
    expect(r.lines).toEqual(["SDHC", "Failed to open file for writing", "hello world.txt", "Hello World!"]);
    expect(card.report().map((f) => [f.path, f.text])).toEqual([
      ["/hello world.txt", "Hello World!"],
      ["/second.txt", "two"],
    ]);
    expect(r.faults.some((f) => f.includes('starts with "/"'))).toBe(true);
  });
});
