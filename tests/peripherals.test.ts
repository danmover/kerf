// The virtual chip's peripherals driven from their registers: the ADC running
// free with ISR(ADC_vect), SREG, registers it does not model, and an SSD1306
// OLED on the I2C bus.

import { describe, expect, it } from "vitest";
import { SimHal, type I2CDevice, type PlantPort } from "../src/sim/engine/hal";
import { Ssd1306 } from "../src/sim/engine/devices";
import { CError, Halt, loadFirmware, NANO } from "../src/sim/mcu";
import { Plant } from "../src/sim/engine/plant";
import { Bench } from "../src/sim/worlds/bench";
import { noteHz, signalFn, type SignalSpec } from "../src/sim/worlds/signals";
import { evaluate } from "../src/lang/evaluator";

/** A board with a signal on A0 and an OLED at 0x3C, run like the engine runs a scenario. */
function run(sketch: string, seconds: number, signal: (s: number) => number = () => 2.5, plantFor?: (hal: SimHal) => unknown) {
  const hal = new SimHal(NANO, { seed: 3 });
  const oled = new Ssd1306("oled", 128, 64, NANO.fcpu);
  const plant: PlantPort = {
    step: (_t0, t1) => oled.tick(t1),
    analogVolts: (pin, t) => (pin === NANO.analog[0] ? signal(t / NANO.fcpu) : undefined),
    vref: () => 5,
    i2c: (addr): I2CDevice | undefined => (addr === 0x3c ? oled : undefined),
  };
  // a real plant from a design attaches itself to the HAL
  if (plantFor) plantFor(hal);
  else hal.plant = plant;
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
  oled.tick(hal.cyc, true);
  const out = hal.serial.filter((l) => l.dir === "out").map((l) => l.text);
  return { hal, oled, out, faults: hal.faults.map((f) => f.msg) };
}

const FREE_RUNNING = `
volatile uint8_t buf[256];
volatile uint16_t n = 0;
volatile bool full = false;
volatile unsigned long isrs = 0;

ISR(ADC_vect) {
  isrs++;
  if (full) return;
  buf[n++] = ADCH;
  // enough samples: stop the conversions from inside the handler
  if (n >= 256) { ADCSRA &= ~(_BV(ADATE) | _BV(ADIE)); full = true; }
}

void startAdc() {
  n = 0;
  full = false;
  ADCSRA |= _BV(ADATE) | _BV(ADIE) | _BV(ADSC);
}

void setup() {
  Serial.begin(115200);
  cli();
  ADMUX = _BV(REFS0) | _BV(ADLAR) | 0;   // AVcc, left-adjusted, A0
  ADCSRB = 0;                             // free running
  DIDR0 = _BV(ADC0D);
  ADCSRA = _BV(ADEN) | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);   // 16 MHz / 128
  sei();
  startAdc();
}

void loop() {
  if (!full) return;
  int crossings = 0;
  uint8_t lo = 255, hi = 0;
  for (int i = 1; i < 256; i++) {
    if (buf[i - 1] < 128 && buf[i] >= 128) crossings++;
    if (buf[i] < lo) lo = buf[i];
    if (buf[i] > hi) hi = buf[i];
  }
  Serial.print("crossings "); Serial.print(crossings);
  Serial.print(" range "); Serial.print(lo); Serial.print(" "); Serial.println(hi);
  startAdc();
}
`;

describe("the ADC from its registers", () => {
  it("runs free at 16 MHz / 128 / 13, about 9.6 kHz, into ISR(ADC_vect)", () => {
    const sketch = FREE_RUNNING.replace("if (full) return;", "if (full) return;\n  if (n >= 250) n = 0;");
    const { hal, faults } = run(sketch, 1.0);
    expect(faults).toEqual([]);
    // the first conversion takes 25 ADC clocks, the rest 13
    expect(hal.adcConversions).toBeGreaterThan(9600);
    expect(hal.adcConversions).toBeLessThan(9630);
    expect(hal.isrCount).toBe(hal.adcConversions);
  });

  it("samples the signal on A0: a 440 Hz note through 256 samples, stopped and restarted by the firmware", () => {
    const { out, faults } = run(FREE_RUNNING, 0.2, (s) => 2.5 + Math.sin(2 * Math.PI * 440 * s));
    expect(faults).toEqual([]);
    // a block every 27 ms or so: the samples, then the firmware's own look at them
    expect(out.length).toBeGreaterThanOrEqual(6);
    for (const line of out) {
      const [, c, lo, hi] = /crossings (\d+) range (\d+) (\d+)/.exec(line)!.map(Number);
      // 256 samples at 9.6 kHz is 26.6 ms: 11 or 12 cycles of 440 Hz
      expect(c).toBeGreaterThanOrEqual(11);
      expect(c).toBeLessThanOrEqual(12);
      // 1.5 V and 3.5 V left-adjusted: 306 and 716 counts, so ADCH 76 and 179
      expect(lo).toBeGreaterThanOrEqual(75);
      expect(lo).toBeLessThanOrEqual(78);
      expect(hi).toBeGreaterThanOrEqual(177);
      expect(hi).toBeLessThanOrEqual(180);
    }
  });

  it("does single conversions polled on ADSC, right-adjusted in ADC", () => {
    const { out } = run(
      `void setup() {
        Serial.begin(115200);
        ADMUX = _BV(REFS0);
        ADCSRA = _BV(ADEN) | 7;
        ADCSRA |= _BV(ADSC);
        while (ADCSRA & _BV(ADSC)) { }
        uint16_t v = ADC;
        Serial.println(v);
        Serial.println(ADCSRA & _BV(ADIF) ? "flag" : "no flag");
        ADCSRA |= _BV(ADIF);
        Serial.println(ADCSRA & _BV(ADIF) ? "flag" : "no flag");
      }
      void loop() {}`,
      0.05,
      () => 1.25,
    );
    expect(Number(out[0])).toBeGreaterThanOrEqual(254);
    expect(Number(out[0])).toBeLessThanOrEqual(257);
    // writing a one to ADIF clears it, as on the chip
    expect(out.slice(1, 3)).toEqual(["flag", "no flag"]);
  });

  it("says what is wrong with a set-up the chip would get wrong", () => {
    const noIsr = run(
      `void setup() { ADMUX = _BV(REFS0); ADCSRA = _BV(ADEN) | _BV(ADSC) | _BV(ADIE) | 7; }
      void loop() {}`,
      0.01,
    );
    expect(noIsr.faults.some((f) => /no ISR\(ADC_vect\)/.test(f))).toBe(true);
    const fast = run(
      `void setup() { ADMUX = _BV(REFS0); ADCSRA = _BV(ADEN) | _BV(ADSC) | 1; }
      void loop() {}`,
      0.01,
    );
    expect(fast.faults.some((f) => /ADC clock is 8000 kHz/.test(f))).toBe(true);
    const timer = run(
      `ISR(TIMER1_COMPA_vect) { }
      void setup() { }
      void loop() {}`,
      0.01,
    );
    expect(timer.faults.some((f) => /ISR\(TIMER1_COMPA_vect\) never runs/.test(f))).toBe(true);
  });
});

describe("other registers", () => {
  it("keeps the interrupt flag in SREG for save, cli and restore", () => {
    const { out } = run(
      `void setup() {
        Serial.begin(115200);
        uint8_t s = SREG;
        cli();
        Serial.println(SREG & 0x80 ? "on" : "off");
        SREG = s;
        Serial.println(SREG & 0x80 ? "on" : "off");
      }
      void loop() {}`,
      0.01,
    );
    expect(out).toEqual(["off", "on"]);
  });

  it("names a register it does not model instead of calling it undeclared", () => {
    expect(() => run("void setup() { TCCR1A = 0; }\nvoid loop() {}", 0.01)).toThrow(CError);
    expect(() => run("void setup() { TCCR1A = 0; }\nvoid loop() {}", 0.01)).toThrow(/TCCR1A is an ATmega328P register the simulator does not model yet/);
    // a variable of the sketch's own with a register's name is just a variable
    expect(run("int ADC = 3;\nvoid setup() { Serial.begin(9600); Serial.println(ADC + 1); }\nvoid loop() {}", 0.01).out).toEqual(["4"]);
  });
});

describe("the I2C clock from its registers", () => {
  const timed = (clock: string) => `#include <Wire.h>
void setup() {
  Serial.begin(115200);
  Wire.begin();
  ${clock}
  unsigned long t0 = micros();
  Wire.beginTransmission(0x3C);
  for (uint8_t i = 0; i < 16; i++) Wire.write(i);
  Wire.endTransmission();
  Serial.println(micros() - t0);
  Serial.println(TWBR);
  Serial.println(TWSR, HEX);
}
void loop() {}`;

  it("runs at 100 kHz by default, and at 400 kHz from TWBR = 12 or Wire.setClock()", () => {
    const slow = run(timed(""), 0.05);
    const reg = run(timed("TWBR = 12;"), 0.05);
    const lib = run(timed("Wire.setClock(400000);"), 0.05);
    for (const r of [slow, reg, lib]) expect(r.faults).toEqual([]);
    const us = (r: { out: string[] }) => Number(r.out[0]);
    // 17 bytes of 9 clocks each, plus start and stop
    expect(us(slow)).toBeGreaterThan(1500);
    expect(us(reg) / us(slow)).toBeGreaterThan(0.22);
    expect(us(reg) / us(slow)).toBeLessThan(0.3);
    expect(Math.abs(us(lib) - us(reg))).toBeLessThan(20);
    // Wire.setClock() writes TWBR as the AVR core does; TWSR reads "no state"
    expect(slow.out.slice(1)).toEqual(["72", "F8"]);
    expect(lib.out.slice(1)).toEqual(["12", "F8"]);
  });
});

describe("C++ that real AVR sketches use", () => {
  it("sizes an array from a const local, wrapped to its type", () => {
    const { out, faults } = run(
      `#define SAMPLES 512
#define BLOCK 64
void setup() {
  Serial.begin(115200);
  const uint8_t N_BLOCKS = SAMPLES / BLOCK;
  uint16_t sums[N_BLOCKS];
  const uint8_t WRAP = 300;
  char tiny[WRAP];
  Serial.println(sizeof(sums));
  Serial.println(sizeof(tiny));
  { const int N_BLOCKS = 3; long inner[N_BLOCKS]; Serial.println(sizeof(inner)); }
}
void loop() {}`,
      0.01,
    );
    expect(faults).toEqual([]);
    expect(out).toEqual(["16", "44", "12"]);
  });

  it("does not take a variable or a parameter as an array size", () => {
    expect(() => run("void f(int n) { int a[n]; a[0] = 1; }\nvoid setup() { f(2); }\nvoid loop() {}", 0.01)).toThrow(/n is not a constant/);
    expect(() => run("const int N = 4;\nvoid setup() { int N = analogRead(A0); int a[N]; a[0] = 1; }\nvoid loop() {}", 0.01)).toThrow(/N is not a constant/);
  });

  it("takes an empty asm barrier as a no-op and nops as cycles, and refuses other assembly", () => {
    const { out, faults } = run(
      `#include <avr/cpufunc.h>
#define MEMORY_BARRIER() __asm__ __volatile__("" ::: "memory")
void setup() {
  Serial.begin(115200);
  MEMORY_BARRIER();
  _MemoryBarrier();
  _NOP();
  asm volatile("");
  unsigned long a = micros();
  for (int i = 0; i < 1000; i++) __asm__ __volatile__("nop\\n\\tnop\\n\\t" "nop\\n\\tnop");
  unsigned long b = micros();
  for (int i = 0; i < 1000; i++) MEMORY_BARRIER();
  unsigned long c = micros();
  Serial.println(b - a > c - b ? "nops take time" : "nops are free");
}
void loop() {}`,
      0.05,
    );
    expect(faults).toEqual([]);
    expect(out).toEqual(["nops take time"]);
    expect(() => run('void setup() { asm volatile("cli"); }\nvoid loop() {}', 0.01)).toThrow(/cannot run inline assembly \(asm\("cli"\)\)/);
    expect(() => run('uint8_t x;\nvoid setup() { asm volatile("" : "=r"(x)); }\nvoid loop() {}', 0.01)).toThrow(/cannot run inline assembly/);
  });
});

describe("an SSD1306 OLED on the I2C bus", () => {
  const INIT = "0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF";
  const lit = (o: Ssd1306, x: number, y: number) => (o.image()[y * 16 + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  const sketch = (draw: string, init = INIT) => `#include <Wire.h>
const uint8_t init_seq[] = { ${init} };
void cmd(uint8_t c) { Wire.beginTransmission(0x3C); Wire.write(0x00); Wire.write(c); Wire.endTransmission(); }
void setup() {
  Wire.begin();
  for (uint8_t i = 0; i < sizeof(init_seq); i++) cmd(init_seq[i]);
  ${draw}
}
void loop() {}`;

  it("draws what the firmware sends in horizontal addressing, upright", () => {
    const { oled } = run(
      sketch(`
  cmd(0x21); cmd(0); cmd(127);
  cmd(0x22); cmd(0); cmd(7);
  for (int i = 0; i < 1024; i += 16) {
    Wire.beginTransmission(0x3C);
    Wire.write(0x40);
    for (int j = 0; j < 16; j++) {
      int col = (i + j) % 128, page = (i + j) / 128;
      Wire.write(page == 1 && col >= 10 && col < 20 ? 0xFF : 0x00);
    }
    Wire.endTransmission();
  }`),
      0.3,
    );
    // a 10 × 8 block at x 10..19, y 8..15
    expect(lit(oled, 10, 8)).toBe(true);
    expect(lit(oled, 19, 15)).toBe(true);
    expect(lit(oled, 9, 8)).toBe(false);
    expect(lit(oled, 10, 16)).toBe(false);
    expect(oled.frames.length).toBeGreaterThan(0);
    expect(oled.frames[oled.frames.length - 1].px.some((b) => b !== 0)).toBe(true);
  });

  it("follows page addressing, and inverts", () => {
    const { oled } = run(sketch(`cmd(0x20); cmd(0x02); cmd(0xB2); cmd(0x05); cmd(0x10);
  Wire.beginTransmission(0x3C); Wire.write(0x40); Wire.write(0x01); Wire.endTransmission();
  cmd(0xA7);`), 0.2);
    // page 2, column 5, bit 0: x 5, y 16, drawn dark on the inverted panel
    expect(lit(oled, 5, 16)).toBe(false);
    expect(lit(oled, 5, 17)).toBe(true);
    expect(lit(oled, 6, 16)).toBe(true);
  });

  it("stays dark, and says why, when the charge pump is never turned on", () => {
    const o = new Ssd1306("oled", 128, 64, NANO.fcpu);
    const warnings: string[] = [];
    o.warn = (m) => warnings.push(m);
    o.write([0x00, 0xa1, 0xc8, 0xaf]);
    o.write([0x40, 0xff, 0xff]);
    expect(o.image().every((b) => b === 0)).toBe(true);
    expect(warnings[0]).toMatch(/charge pump off/);
  });
});

describe("test signals on the bench", () => {
  const design = (signal: string) =>
    evaluate(`component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
net TUNER_IN: ctrl.A0
firmware tuner { board: ctrl, behaviour: "Show the note a guitar plays" }
scenario "Hear a note" {
  world: sim.bench(signals: ${signal})
  duration: 1s
}`);

  it("names notes in equal temperament from A4 = 440 Hz", () => {
    expect(noteHz("A4")).toBeCloseTo(440, 6);
    expect(noteHz("E2")).toBeCloseTo(82.407, 2);
    expect(noteHz("C#3")).toBeCloseTo(138.59, 1);
    expect(noteHz("Bb1")).toBeCloseTo(58.27, 1);
    expect(noteHz("H2")).toBeNaN();
  });

  it("plucks a string at the note's pitch, ten cents sharp when asked", () => {
    const m = design('sim.signal(on: "TUNER_IN", note: "A2", cents: 10, start: 0s)');
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const w = m.scenarios![0].spec.world;
    if (w.kind !== "bench") throw new Error("not a bench");
    const s = w.bench.signals![0];
    expect(s.shape).toBe("pluck");
    expect(s.f).toBeCloseTo(110 * 2 ** (10 / 1200), 6);
    // its period, by autocorrelation over the first 0.2 s
    const v = signalFn(s);
    const fs = 20000;
    const x = Array.from({ length: fs * 0.2 }, (_, i) => v(i / fs) - s.offset);
    let best = 0;
    let lag = 0;
    for (let k = fs / 400; k < fs / 60; k++) {
      let c = 0;
      for (let i = 0; i + k < x.length; i++) c += x[i] * x[i + k];
      if (c > best) [best, lag] = [c, k];
    }
    expect(fs / lag).toBeGreaterThan(108);
    expect(fs / lag).toBeLessThan(113);
    // it stays within its amplitude and fades
    expect(Math.max(...x.map(Math.abs))).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(Math.abs(v(2.9) - s.offset)).toBeLessThan(0.1);
  });

  it("feeds the analog input its net reaches, and says when a signal goes nowhere", () => {
    const m = design('[sim.signal(on: "TUNER_IN", f: 200Hz, amplitude: 1V), sim.signal(on: "NOPE", f: 50Hz)]');
    const w = m.scenarios![0].spec.world;
    if (w.kind !== "bench") throw new Error("not a bench");
    const hal = new SimHal(NANO, { seed: 1 });
    const plant = new Plant(m.machine!, "ctrl", NANO, hal, new Bench(m.machine!, w.bench, "expected"), { rng: () => 0.5 });
    const v = signalFn(w.bench.signals![0] as SignalSpec);
    for (const t of [1.0, 1.0013, 1.37]) expect(plant.analogVolts(NANO.analog[0], t * NANO.fcpu)).toBeCloseTo(v(t), 9);
    expect(plant.notes.some((n) => /signal on NOPE goes nowhere/.test(n))).toBe(true);
  });

  it("reaches firmware that samples it from the registers", () => {
    const m = design('sim.signal(on: "TUNER_IN", shape: "sine", note: "A4", amplitude: 1V, start: 0s)');
    const w = m.scenarios![0].spec.world;
    if (w.kind !== "bench") throw new Error("not a bench");
    const { out, faults } = run(FREE_RUNNING, 0.2, undefined, (hal) => new Plant(m.machine!, "ctrl", NANO, hal, new Bench(m.machine!, w.bench, "expected"), { rng: () => 0.5 }));
    expect(faults).toEqual([]);
    expect(out.length).toBeGreaterThanOrEqual(6);
    for (const line of out) {
      const [, c] = /crossings (\d+)/.exec(line)!.map(Number);
      expect(c).toBeGreaterThanOrEqual(11);
      expect(c).toBeLessThanOrEqual(12);
    }
  });
});
