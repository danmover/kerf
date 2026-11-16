// Every board the firmware simulator runs as itself, with the catches its own Arduino core and chip have: the
// Mega's four UARTs and timer 5 for Servo, the ESP32's flash, input-only and strapping pins, the XIAO ESP32C3's
// Serial1 on its USB lines, the Pico's PWM slices and its 10-bit analogRead(), the Black Pill's shared EXTI lines and
// timer channels, and the Trinket's ATtiny85 with no serial port at all. Each sketch is one that builds and runs (or
// fails to build) the same way on the real board.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { BLACKPILL_F411, boardFor, BOARDS, CError, ESP32_DEVKITC, FEATHER_ESP32_V2, Halt, loadFirmware, mcuPin, MEGA, NANO, PICO, TRINKET_5V, UNO, XIAO_ESP32C3, XIAO_ESP32S3, type Board } from "../src/sim/mcu";
import { evaluate } from "../src/lang/evaluator";
import { runSpec } from "../src/sim/build";
import { generateFirmware } from "../src/machine/firmware";
import { catalogPart } from "../src/machine/catalog";
import { BOARDS as BOARD_PARTS } from "../src/machine/catalog/boards";

interface RunOpts {
  /** external pin changes: [seconds, pin, level] */
  pins?: [number, number, number][];
  /** volts on analog pins */
  volts?: Record<number, number>;
  /** a pin whose writes are timed */
  watch?: number;
}

function run(sketch: string, board: Board, seconds: number, opts: RunOpts = {}) {
  const hal = new SimHal(board, { seed: 5 });
  const v = opts.volts;
  if (v) hal.plant = { step: () => undefined, analogVolts: (p) => v[p], vref: () => board.adcRefV, i2c: () => undefined };
  hal.endCyc = Math.round(seconds * board.fcpu);
  for (const [t, pin, level] of opts.pins ?? []) hal.schedulePin(Math.round(t * board.fcpu), pin, level);
  const writes: number[] = [];
  if (opts.watch !== undefined) hal.onWrite.set(opts.watch, (_l, t) => writes.push(t / board.fcpu));
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
  const lines = hal.serial.filter((l) => l.dir === "out").map((l) => l.text);
  return { hal, fw, lines, writes, faults: hal.faults.map((f) => f.msg) };
}

/** the compile error a sketch stops at, or "" when it builds */
function compileError(sketch: string, board: Board): string {
  try {
    loadFirmware({ "sketch.ino": sketch }, board, new SimHal(board));
    return "";
  } catch (e) {
    if (e instanceof CError) return e.message;
    throw e;
  }
}

const once = (body: string) => `void setup() {\n${body}\n}\nvoid loop() {}\n`;
const num = (s: string) => Number(s.trim());

describe("every board", () => {
  // the DevKitC and the XIAO ESP32C3 have no user LED
  const ledOf = (b: Board) => (b.ledBuiltin >= 0 ? "LED_BUILTIN" : b === ESP32_DEVKITC ? "13" : "D10");
  const pinOf = (b: Board) => (b.ledBuiltin >= 0 ? b.ledBuiltin : b === ESP32_DEVKITC ? 13 : 10);
  for (const b of BOARDS)
    it(`blinks on the ${b.name}, on time`, () => {
      const led = ledOf(b);
      const r = run(`void setup() { pinMode(${led}, OUTPUT); }\nvoid loop() { digitalWrite(${led}, HIGH); delay(250); digitalWrite(${led}, LOW); delay(250); }`, b, 2.1, { watch: pinOf(b) });
      expect(r.faults).toEqual([]);
      expect(r.writes.length).toBe(9);
      expect(r.writes[4]).toBeCloseTo(1, 2);
      expect(r.writes[8]).toBeCloseTo(2, 2);
    });

  it("knows each one's catalogue part", () => {
    for (const b of BOARDS) for (const id of b.parts) expect(boardFor(id)).toBe(b);
    expect(BOARDS.map((b) => b.name)).toEqual(["Arduino Nano", "Arduino Uno", "ESP32 Feather V2", "Arduino Mega 2560", "ESP32-DevKitC", "XIAO ESP32S3", "XIAO ESP32C3", "Raspberry Pi Pico", "STM32F411 Black Pill", "Adafruit Trinket 5V", "Teensy 4.1"]);
  });

  it("starts an output at the level each core leaves it", () => {
    // the AVR's PORT bit is the pull-up and then the output level; the RP2040 core's pinMode() clears it; the ESP32 and STM32 keep it
    const after = (b: Board, pin: number, first: string) => num(run(once(`Serial.begin(115200);\n${first}\npinMode(${pin}, OUTPUT);\nSerial.println(digitalRead(${pin}));`), b, 0.05).lines[0]);
    expect(after(NANO, 7, `pinMode(7, INPUT_PULLUP);`)).toBe(1);
    expect(after(FEATHER_ESP32_V2, 13, `pinMode(13, INPUT_PULLUP);`)).toBe(0);
    expect(after(NANO, 7, `digitalWrite(7, HIGH);`)).toBe(1);
    expect(after(ESP32_DEVKITC, 13, `digitalWrite(13, HIGH);`)).toBe(1);
    expect(after(BLACKPILL_F411, 5, `digitalWrite(PA5, HIGH);`)).toBe(1);
    expect(after(PICO, 3, `digitalWrite(3, HIGH);`)).toBe(0);
  });

  it("stops a sketch using a register only the ATmega328P has, as the other cores do", () => {
    expect(compileError(once("TCCR1A = 0;"), UNO)).toBe("");
    expect(compileError(once("TCCR1A = 0;"), BLACKPILL_F411)).toMatch(/'TCCR1A' was not declared in this scope: it is an AVR register, and the STM32F411 Black Pill's STM32F411CEU6 has none/);
    expect(compileError(once("ADMUX = 0x40;"), FEATHER_ESP32_V2)).toMatch(/'ADMUX' was not declared in this scope/);
    expect(compileError(once("analogReadResolution(12);"), NANO)).toMatch(/'analogReadResolution' was not declared in this scope: the AVR core's analogRead\(\) is always 10 bits/);
  });
});

describe("Arduino Mega 2560", () => {
  it("has Serial3, pins to 53, A15 and its own SPI pins", () => {
    const r = run(once(`Serial.begin(115200);\nSerial3.begin(9600);\npinMode(53, OUTPUT);\ndigitalWrite(53, HIGH);\nSerial.println(digitalRead(53));\nSerial.println(A15);\nSerial.println(SS);\nSerial.println(NUM_ANALOG_INPUTS);`), MEGA, 0.05);
    expect(r.faults).toEqual([]);
    expect(r.lines).toEqual(["1", "69", "53", "16"]);
  });

  it("gives Servo timer 5, so pins 44 to 46 lose PWM and 9 and 10 keep it (the Uno loses 9 and 10)", () => {
    const sketch = (pin: number) => `#include <Servo.h>\nServo s;\n${once(`s.attach(${pin === 44 ? 2 : 9});\nanalogWrite(10, 128);\nanalogWrite(${pin}, 128);`)}`;
    expect(run(sketch(44), MEGA, 0.02).faults).toEqual(["analogWrite(44) while Servo uses timer 5: that stops PWM on pin 44"]);
    expect(run(sketch(11), UNO, 0.02).faults).toEqual(["analogWrite(10) while Servo uses timer 1: that stops PWM on pin 10"]);
  });

  it("stops a sketch at a serial port the board does not have", () => {
    expect(compileError(once("Serial1.begin(9600);"), UNO)).toBe("sketch.ino:2: 'Serial1' was not declared in this scope: the Arduino Uno has one hardware serial port, Serial");
    expect(compileError(once("Serial3.begin(9600);"), MEGA)).toBe("");
    expect(compileError(once("Serial3.begin(9600);"), FEATHER_ESP32_V2)).toBe("sketch.ino:2: 'Serial3' was not declared in this scope: the ESP32 Feather V2 has Serial, Serial1, Serial2");
    // a sketch's own object of that name is fine
    expect(compileError(`int Serial1 = 3;\n${once("Serial1++;")}`, UNO)).toBe("");
  });
});

describe("ESP32-DevKitC", () => {
  it("faults on the flash pins and on driving or pulling up an input-only pin, and tells a strapping pin's catch once", () => {
    const r = run(once(`Serial.begin(115200);\npinMode(6, OUTPUT);\npinMode(34, OUTPUT);\npinMode(35, INPUT_PULLUP);\npinMode(0, INPUT_PULLUP);\nSerial.println(digitalRead(0));\nSerial.println(digitalRead(0));\nSerial.println(A0);`), ESP32_DEVKITC, 0.05);
    expect(r.lines).toEqual(["1", "1", "36"]);
    expect(r.faults).toEqual([
      "pinMode(6): GPIO6 to 11 run the ESP32 module's flash chip: using one crashes the board",
      "pinMode(34): GPIO34 is input-only on the ESP32-DevKitC, so it cannot drive anything",
      "pinMode(35, INPUT_PULLUP): GPIO35 has no internal pull resistors on the ESP32-DevKitC, so the pin floats; fit a 10 kΩ resistor",
      "pinMode(0): GPIO0 is a strapping pin (the BOOT button): held low at reset, the board waits for an upload instead of running the sketch",
    ]);
  });

  it("has no LED_BUILTIN and no A1, as its pins_arduino.h", () => {
    expect(compileError(once("pinMode(LED_BUILTIN, OUTPUT);"), ESP32_DEVKITC)).toMatch(/LED_BUILTIN/);
    expect(compileError(once("analogRead(A1);"), ESP32_DEVKITC)).toMatch(/A1/);
    expect(compileError(once("analogRead(A4);"), ESP32_DEVKITC)).toBe("");
  });

  it("sends at the baud rate the sketch asks for", () => {
    const r = run(once(`Serial.begin(9600);\nunsigned long t0 = micros();\nfor (int i = 0; i < 100; i++) Serial.print("0123456789");\nunsigned long t1 = micros();\nSerial.println();\nSerial.println(t1 - t0);`), ESP32_DEVKITC, 1.5);
    // 1000 characters at 960 a second, less the 256 the buffer takes
    expect(num(r.lines.at(-1)!)).toBeGreaterThan(700_000);
  });
});

describe("Seeed Studio XIAO ESP32S3 and ESP32C3", () => {
  it("name their pads D0 to D10 and A0.., as Seeed's variants do", () => {
    const r = run(once("Serial.begin(115200);\nSerial.println(D0);\nSerial.println(D7);\nSerial.println(D10);\nSerial.println(A10);\nSerial.println(LED_BUILTIN);"), XIAO_ESP32S3, 0.05);
    expect(r.lines).toEqual(["1", "44", "9", "9", "21"]);
    const c = run(once("Serial.begin(115200);\nSerial.println(D0);\nSerial.println(D6);\nSerial.println(D10);\nSerial.println(A2);"), XIAO_ESP32C3, 0.05);
    expect(c.lines).toEqual(["2", "21", "10", "4"]);
    expect(compileError(once("pinMode(LED_BUILTIN, OUTPUT);"), XIAO_ESP32C3)).toMatch(/LED_BUILTIN/);
  });

  it("send at USB speed whatever the baud rate", () => {
    const r = run(once(`Serial.begin(9600);\nunsigned long t0 = micros();\nfor (int i = 0; i < 100; i++) Serial.print("0123456789");\nunsigned long t1 = micros();\nSerial.println();\nSerial.println(t1 - t0);`), XIAO_ESP32S3, 0.2);
    expect(num(r.lines.at(-1)!)).toBeLessThan(5000);
  });

  it("warn that the C3's Serial1 starts on its USB lines, and take the pads when begin() names them", () => {
    const r = run(once("Serial1.begin(9600);"), XIAO_ESP32C3, 0.02);
    expect(r.faults).toEqual([
      "Serial1.begin(): its RX pin is GPIO18, the core's default. GPIO18 is the USB port's D-: using it as a pin drops the USB serial port; name other pins with Serial1.begin(baud, SERIAL_8N1, rx, tx)",
      "Serial1.begin(): its TX pin is GPIO19, the core's default. GPIO19 is the USB port's D+: using it as a pin drops the USB serial port; name other pins with Serial1.begin(baud, SERIAL_8N1, rx, tx)",
    ]);
    expect(run(once("Serial1.begin(9600, SERIAL_8N1, D7, D6);"), XIAO_ESP32C3, 0.02).faults).toEqual([]);
    expect(compileError(once("Serial2.begin(9600);"), XIAO_ESP32C3)).toBe("sketch.ino:2: 'Serial2' was not declared in this scope: the XIAO ESP32C3 has Serial, Serial1");
  });

  it("fault on the S3's PSRAM pins", () => {
    expect(run(once("pinMode(35, OUTPUT);"), XIAO_ESP32S3, 0.02).faults).toEqual(["pinMode(35): GPIO33 to 37 run the XIAO ESP32S3's octal PSRAM: using one crashes the board"]);
  });
});

describe("Raspberry Pi Pico", () => {
  it("reads 10 bits until analogReadResolution(12), from its 12-bit ADC", () => {
    const r = run(once("Serial.begin(115200);\nSerial.println(analogRead(A0));\nanalogReadResolution(12);\nSerial.println(analogRead(26));\nSerial.println(analogReadMilliVolts(26));"), PICO, 0.05, { volts: { 26: 1.65 } });
    expect(r.faults).toEqual([]);
    expect(Math.abs(num(r.lines[0]) - 511.5)).toBeLessThan(2);
    expect(Math.abs(num(r.lines[1]) - 2047.5)).toBeLessThan(3);
    expect(Math.abs(num(r.lines[2]) - 1650)).toBeLessThan(5);
    // GP0 is no ADC pin
    expect(run(once("analogRead(0);"), PICO, 0.02).faults).toEqual(["analogRead(0): GP0 is not an ADC pin on the Raspberry Pi Pico (it reads GP26, GP27, GP28, GP29)"]);
  });

  it("shares one duty between a pin and the one 16 above it, which are one PWM slice's channel", () => {
    const r = run(once("analogWrite(0, 64);\nanalogWrite(16, 192);\nanalogWrite(1, 32);"), PICO, 0.02);
    expect(r.faults).toEqual(["analogWrite(16): GP16 and GP0 share PWM slice 0 channel A on the Raspberry Pi Pico, so both carry the duty written last; move one to a pin on another channel"]);
    expect(r.hal.duty[0]).toBeCloseTo(192 / 255, 6);
    expect(r.hal.duty[1]).toBeCloseTo(32 / 255, 6);
  });

  it("sets every pin's PWM at once with analogWriteFreq() and analogWriteRange()", () => {
    const r = run(once("analogWriteFreq(20000);\nanalogWriteRange(1000);\nanalogWrite(2, 250);\nanalogWriteFreq(50);"), PICO, 0.02);
    expect(r.hal.duty[2]).toBeCloseTo(0.25, 6);
    expect(r.hal.pwmHz(2)).toBe(100);
    expect(r.faults).toEqual(["analogWriteFreq(50): the Raspberry Pi Pico's core takes 100 Hz to 1 MHz, so the PWM runs at 100 Hz"]);
    expect(compileError(once("analogWriteFreq(20000);"), UNO)).toMatch(/'analogWriteFreq' was not declared in this scope/);
    expect(compileError(once("analogWriteResolution(5, 12);"), PICO)).toMatch(/analogWriteResolution\(pin, value\) is the ESP32 core's call/);
  });

  it("says setup1() and loop1() would run on the second core, which the simulator does not", () => {
    const r = run(`void setup() {}\nvoid loop() {}\nvoid setup1() {}\nvoid loop1() {}\n`, PICO, 0.01);
    expect(r.faults).toEqual(["setup1() runs on the RP2040's second core, which the simulator does not run yet: only setup() and loop() run here, so move its work into loop()"]);
    expect(run(`void setup() {}\nvoid loop() {}\nvoid setup1() {}\n`, NANO, 0.01).faults).toEqual([]);
  });
});

describe("STM32F411 Black Pill", () => {
  it("takes STM32duino's pin names, and analog numbers for A0 to A9", () => {
    const r = run(once("Serial.begin(115200);\nSerial.println(PA5);\nSerial.println(PB0);\nSerial.println(analogRead(8));\nSerial.println(analogRead(PB0));\nSerial.println(analogRead(A8));\nSerial.println(LED_BUILTIN == PC13);"), BLACKPILL_F411, 0.05, { volts: { 16: 1.0 } });
    expect(r.faults).toEqual([]);
    expect(r.lines.slice(0, 2)).toEqual(["5", "16"]);
    for (const l of r.lines.slice(2, 5)) expect(Math.abs(num(l) - (1.0 / 3.3) * 1023)).toBeLessThan(2);
    expect(r.lines[5]).toBe("1");
  });

  it("gives PA0 and PB0 one interrupt line: the later attachInterrupt() takes it", () => {
    const sketch = `volatile int a = 0, b = 0;
void onA() { a++; }
void onB() { b++; }
void setup() {
  pinMode(PA0, INPUT_PULLUP);
  pinMode(PB0, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PA0), onA, FALLING);
  attachInterrupt(digitalPinToInterrupt(PB0), onB, FALLING);
}
void loop() {}`;
    const r = run(sketch, BLACKPILL_F411, 0.1, { pins: [[0.02, 0, 0], [0.03, 0, 1], [0.05, 16, 0], [0.06, 16, 1]] });
    expect(r.faults).toEqual(["attachInterrupt(16): PB0 and PA0 share interrupt line EXTI0 on the STM32F411 Black Pill, so PA0's handler stops; put one on a pin with another number"]);
    expect(r.fw.read("a")).toBe(0);
    expect(r.fw.read("b")).toBe(1);
  });

  it("puts PA0 and PA5 on one timer channel, TIM2_CH1", () => {
    const r = run(once("analogWrite(PA0, 50);\nanalogWrite(PA5, 200);\nanalogWriteResolution(12);\nanalogWrite(PA1, 2048);"), BLACKPILL_F411, 0.02);
    expect(r.faults).toEqual(["analogWrite(5): PA5 and PA0 share TIM2_CH1 on the STM32F411 Black Pill, so both carry the duty written last; move one to a pin on another channel"]);
    expect(r.hal.duty[0]).toBeCloseTo(200 / 255, 6);
    expect(r.hal.duty[1]).toBeCloseTo(2048 / 4095, 6);
  });

  it("keeps Serial1 on PA9 and PA10, and leaves the crystal pins alone", () => {
    expect(run(once("Serial1.begin(9600, SERIAL_8N1, PB7, PB6);"), BLACKPILL_F411, 0.02).faults).toEqual(["Serial1.begin(baud, config, rx, tx) is the ESP32 core's: on the STM32F411 Black Pill Serial1 is fixed to its own pins"]);
    expect(run(once("pinMode(PH0, OUTPUT);"), BLACKPILL_F411, 0.02).faults).toEqual(["pinMode(34): PH0 and PH1 run the Black Pill's 25 MHz crystal: the chip's clock stops if they are used"]);
  });
});

describe("Adafruit Trinket 5V (ATtiny85)", () => {
  it("has no Serial, Wire, SPI, Servo or tone(), so those sketches stop at the build", () => {
    expect(compileError(once("Serial.begin(9600);"), TRINKET_5V)).toMatch(/^sketch.ino:2: 'Serial' was not declared in this scope: the ATtiny85 has no UART/);
    expect(compileError(`#include <Wire.h>\n${once("Wire.begin();")}`, TRINKET_5V)).toMatch(/^sketch.ino:3: 'Wire' was not declared in this scope: the ATtiny85 has no TWI port/);
    expect(compileError(once("tone(1, 440);"), TRINKET_5V)).toMatch(/^sketch.ino:2: tone\(\) does not build for the ATtiny85/);
    expect(compileError(`#include <Servo.h>\nServo s;\n${once("s.attach(0);")}`, TRINKET_5V)).toMatch(/^sketch.ino:\d: The Servo library does not build for the ATtiny85/);
  });

  it("reads A1 on pin #2, and faults when A1 is given to digitalWrite()", () => {
    const r = run(`int a = 0, c = 0;\n${once("a = analogRead(A1);\nc = analogRead(1);\ndigitalWrite(A1, HIGH);")}`, TRINKET_5V, 0.02, { volts: { 2: 2.5 } });
    expect(Math.abs(Number(r.fw.read("a")) - 511.5)).toBeLessThan(2);
    expect(Math.abs(Number(r.fw.read("c")) - 511.5)).toBeLessThan(2);
    expect(r.faults).toEqual(["digitalWrite(7): 7 is A1 on the Adafruit Trinket 5V, a number only analogRead() takes; digitalWrite() takes the pin's own number, 2 (#2)"]);
  });

  it("reads against its 1.1 V reference with analogReference(INTERNAL)", () => {
    const r = run(`int a = 0;\n${once("analogReference(INTERNAL);\na = analogRead(A1);")}`, TRINKET_5V, 0.02, { volts: { 2: 0.55 } });
    expect(Math.abs(Number(r.fw.read("a")) - 511.5)).toBeLessThan(2);
  });

  it("counts micros() in 8 µs steps at 8 MHz", () => {
    const hal = new SimHal(TRINKET_5V);
    const steps = new Set<number>();
    for (let i = 0; i < 300; i++) {
      hal.spend(37);
      steps.add(hal.micros() % 8);
    }
    expect([...steps]).toEqual([0]);
    hal.spend(8_000_000);
    expect(hal.millis()).toBeGreaterThanOrEqual(1000);
    expect(hal.millis()).toBeLessThanOrEqual(1003);
  });

  it("faults on the RESET pin and tells #3's USB catch once", () => {
    const r = run(once("pinMode(5, OUTPUT);\npinMode(3, OUTPUT);\ndigitalWrite(3, HIGH);"), TRINKET_5V, 0.02);
    expect(r.faults).toEqual([
      "pinMode(5): pin #5 is the ATtiny85's RESET line on the Trinket: it cannot be used as a pin",
      "pinMode(3): #3 is also USB D-, with a 1.5 kΩ pull-up and a 3.6 V zener on it: fine for inputs and LEDs, but it cannot drive a 5 V signal high",
    ]);
  });
});

describe("the boards in the catalogue", () => {
  it("map every pin to one the simulated board has, with ADC and PWM where the part says", () => {
    const parts = [...BOARD_PARTS, catalogPart("arduino_mega")!, catalogPart("esp32_devkitc")!, catalogPart("rpi_pico")!];
    for (const part of parts) {
      const b = boardFor(part.id)!;
      expect(b, part.id).toBeDefined();
      for (const p of part.pins.filter((x) => x.type === "io")) {
        const n = mcuPin(b, p.mcu);
        expect(n, `${part.id}.${p.id}`).toBeDefined();
        expect(b.noPins?.[n!], `${part.id}.${p.id}`).toBeUndefined();
        if (p.pwm) expect(n! in b.pwm, `${part.id}.${p.id} PWM`).toBe(true);
        if (p.adc) expect((b.adcPins ?? b.analog).includes(n!), `${part.id}.${p.id} ADC`).toBe(true);
        // a XIAO pad, a Black Pill pin, a Trinket #: the macro of its own name is the same pin
        const own = b.pinMacros?.[p.id];
        if (own !== undefined) expect(own, `${part.id}.${p.id}`).toBe(n);
      }
    }
  });

  it("run Kerf's own firmware for each one as that board, without a mistake", () => {
    const cases: [string, string, string][] = [
      ["arduino_mega", "D6", "V5"],
      ["esp32_devkitc", "IO13", "V5"],
      ["rpi_pico", "GP6", "VSYS"],
      ["esp32s3_xiao", "D3", "V5"],
      ["esp32c3_xiao", "D3", "V5"],
      ["blackpill_f411", "PB0", "V5"],
    ];
    for (const [id, pin, v5] of cases) {
      const m = evaluate(`design "Lights"
component ctrl = lib.controller("${id}") { at: (0, 0, 0) }
component psu = lib.psu("usb_c_power_5v") { at: (200, 0, 0) }
component stick = lib.led("neopixel_stick_8") { at: (100, 0, 0) }
net GND: psu.GND, ctrl.GND, stick.GND
net V5: psu.VBUS, ctrl.${v5}, stick.V5
wire ctrl.${pin} -> stick.DIN
firmware lights { board: ctrl }
scenario "Glow" { world: sim.bench() firmware: lights duration: 1s expect "no mistakes": faults == 0 }`);
      expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message), id).toEqual([]);
      const r = runSpec(m.scenarios![0].spec, m.machine!, "Lights", { variants: ["expected"] });
      expect(r.error, id).toBeUndefined();
      expect(r.firmware?.boardName, id).toBe(boardFor(id)!.name);
      const v = r.variants[0];
      expect(v.faults, id).toEqual([]);
      expect(v.serial[0]?.text, id).toBe("Lights: lights ready");
    }
  });

  it("run a sketch of your own on the Trinket, which Kerf writes no firmware for", () => {
    const m = evaluate(`design "Blinky"
component ctrl = lib.controller("trinket_5v") { at: (0, 0, 0) }
firmware blink { board: ctrl, code: "own" }
scenario "Blink" { world: sim.bench() firmware: blink duration: 1s expect "no mistakes": faults == 0 }`);
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const fw = m.machine!.firmware[0];
    expect(generateFirmware(m.machine!, "Blinky")[0].warnings.join(" ")).toMatch(/no sketch of your own is saved for blink yet/);
    fw.own = { files: [{ path: "blink.ino", content: `void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() { digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN)); delay(100); }\n` }] };
    const out = generateFirmware(m.machine!, "Blinky")[0];
    expect(out.own).toBe(true);
    expect(out.warnings).toEqual([]);
    const r = runSpec(m.scenarios![0].spec, m.machine!, "Blinky", { variants: ["expected"] });
    expect(r.error).toBeUndefined();
    expect(r.firmware?.boardName).toBe("Adafruit Trinket 5V");
    expect(r.variants[0].faults).toEqual([]);
  });
});
