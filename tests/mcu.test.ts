// The virtual microcontroller: C semantics at the AVR's widths, the Arduino
// core's printing and timing, and the generated Sand Tunneller firmware
// running against a bare board.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { generateFirmware } from "../src/machine/firmware";
import { loadFirmware, NANO, Halt, type Hal, type FnRef } from "../src/sim/mcu";
import { printFloat } from "../src/sim/mcu/lib";

/** A board with nothing connected: time from cycles, serial captured, no I2C devices. */
class BareBoard implements Hal {
  fcpu = 16_000_000;
  cyc = 0;
  nextEvt = Infinity;
  out: number[] = [];
  rx: number[] = [];
  faults: string[] = [];
  pins = new Map<number, number>();
  pwm = new Map<number, number>();
  analog = new Map<number, number>();
  isr = new Map<number, FnRef>();
  eeprom = new Uint8Array(1024).fill(0xff);
  stopAt = Infinity;
  service() {
    if (this.cyc >= this.stopAt) throw new Halt("time");
  }
  spend(c: number) {
    this.cyc += Math.round(c);
    this.service();
  }
  pinMode() {}
  digitalWrite(p: number, v: number) {
    this.pins.set(p, v ? 1 : 0);
  }
  digitalRead(p: number) {
    return this.pins.get(p) ?? 1;
  }
  analogRead(p: number) {
    return this.analog.get(p) ?? 0;
  }
  analogWrite(p: number, v: number) {
    this.pwm.set(p, v);
  }
  analogReference() {}
  attachInterrupt(n: number, fn: FnRef) {
    this.isr.set(n, fn);
  }
  detachInterrupt(n: number) {
    this.isr.delete(n);
  }
  digitalPinToInterrupt(p: number) {
    return p === 2 ? 0 : p === 3 ? 1 : -1;
  }
  setInterrupts() {}
  millis() {
    return Math.floor(this.cyc / 16000) >>> 0;
  }
  micros() {
    return Math.floor(this.cyc / 16) >>> 0;
  }
  tone() {}
  noTone() {}
  serialBegin() {}
  serialWrite(_p: number, b: number[]) {
    this.out.push(...b);
    return b.length;
  }
  serialAvailable() {
    return this.rx.length;
  }
  serialRead() {
    return this.rx.length ? this.rx.shift()! : -1;
  }
  serialPeek() {
    return this.rx.length ? this.rx[0] : -1;
  }
  serialFlush() {}
  wireBegin() {}
  wireSetClock() {}
  wireWrite() {
    return 2;
  }
  wireRead() {
    return [];
  }
  eepromWrite(a: number, v: number) {
    this.eeprom[a] = v;
    this.spend(16000 * 3.3);
  }
  servoPulse() {}
  fault(msg: string, file: string, line: number) {
    this.faults.push(`${file}:${line} ${msg}`);
  }
  stack() {}
  get text() {
    return String.fromCharCode(...this.out);
  }
}

function run(src: string, fn = "test") {
  const hal = new BareBoard();
  const { fw } = loadFirmware({ "t.ino": src }, NANO, hal);
  fw.reset();
  const r = fw.call(fn);
  return { hal, fw, r };
}

describe("C at the AVR's widths", () => {
  it("wraps int at 16 bits and promotes like gcc", () => {
    const { fw } = run(`
      int a; long b; unsigned int c; long d; int e; unsigned long f;
      void test() {
        a = 120 * 1000;          // int overflow: -11072 on the chip
        b = 120 * 1000L;         // long maths
        c = 65535; c++;          // wraps to 0
        d = 40000;               // a long literal
        e = 7 / 2 * 2;           // integer division
        f = 120 * 1000UL;
      }`);
    expect(fw.read("a")).toBe(-11072);
    expect(fw.read("b")).toBe(120000);
    expect(fw.read("c")).toBe(0);
    expect(fw.read("d")).toBe(40000);
    expect(fw.read("e")).toBe(6);
    expect(fw.read("f")).toBe(120000);
  });

  it("keeps double at 32 bits", () => {
    const { fw } = run(`double x; float y; void test() { x = 0.1; y = 1.0 / 3.0; }`);
    expect(fw.read("x")).toBe(Math.fround(0.1));
    expect(fw.read("y")).toBe(Math.fround(1 / 3));
  });

  it("runs structs, arrays, pointers, references, statics and switch", () => {
    const { fw } = run(`
      struct P { int16_t x; uint8_t y; float z; };
      P ps[3] = { {1, 2, 3.5f}, {4, 5, 6.5f} };
      int total, calls, sw;
      void bump(P &p) { p.x += 10; }
      int count() { static int n = 0; return ++n; }
      int sum(const int *a, int n) { int s = 0; for (int i = 0; i < n; i++) s += a[i]; return s; }
      void test() {
        int arr[] = {1, 2, 3, 4};
        bump(ps[1]);
        P *q = &ps[0];
        q->y = 9;
        total = sum(arr, 4) + ps[1].x + q->y;
        count(); count(); calls = count();
        sw = 0;
        for (int i = 0; i < 4; i++) switch (i) { case 0: sw += 1; case 1: sw += 10; break; default: sw += 100; }
      }`);
    expect(fw.read("total")).toBe(10 + 14 + 9);
    expect(fw.read("calls")).toBe(3);
    expect(fw.read("sw")).toBe(1 + 10 + 10 + 100 + 100);
  });

  it("reports out-of-range indexing and division by zero as faults", () => {
    const { hal } = run(`int a[4]; int z = 0; int r; void test() { a[4] = 1; r = 10 / z; }`);
    expect(hal.faults.length).toBe(2);
    expect(hal.faults[0]).toMatch(/Index 4 is outside a \(size 4\)/);
    expect(hal.faults[1]).toMatch(/Division by zero/);
  });

  it("reads memory through pointer casts as bytes", () => {
    const { fw } = run(`
      float f = 1.0f; uint8_t b3; char s[4] = "\\xff"; int u;
      void test() { uint8_t *p = (uint8_t *)&f; b3 = p[3]; u = ((uint8_t *)s)[0]; }`);
    expect(fw.read("b3")).toBe(0x3f);
    expect(fw.read("u")).toBe(255);
  });

  it("rejects what the chip cannot run with a clear message", () => {
    expect(() => run(`void test() { undefinedThing(); }`)).toThrow(/does not know the function undefinedThing/);
    expect(() => run(`#include <SD.h>\nvoid test() {}`)).toThrow(/no library header "SD.h"/);
  });
});

describe("the Arduino core", () => {
  it("prints like Print.cpp", () => {
    const { hal } = run(`void test() {
      Serial.begin(115200);
      Serial.println(3.14159);       // 2 decimals
      Serial.println(1.999, 2);      // rounds to 2.00
      Serial.println(-12);
      Serial.println(255, HEX);
      Serial.println((uint8_t)7, BIN);
      Serial.print('A'); Serial.println();
      Serial.println(F("flash"));
      Serial.println(100000L);
      Serial.println(-1, HEX);       // as unsigned long
    }`);
    expect(hal.text).toBe("3.14\r\n2.00\r\n-12\r\nFF\r\n111\r\nA\r\nflash\r\n100000\r\nFFFFFFFF\r\n");
    // Print.cpp rounds by adding 0.005 in 32-bit floats, so 0.005 itself prints as 0.00 on the chip
    expect(String.fromCharCode(...printFloat(0.005, 2))).toBe("0.00");
    expect(String.fromCharCode(...printFloat(2.675, 2))).toBe("2.68");
  });

  it("formats sprintf like avr-libc (no %f)", () => {
    const { hal } = run(`char buf[40]; void test() {
      sprintf(buf, "%d|%5u|%-4x|%04d|%s|%c|%ld|%f", -5, 42u, 255, 7, "ok", 'z', 70000L, 1.5);
      Serial.print(buf);
    }`);
    expect(hal.text).toBe("-5|   42|ff  |0007|ok|z|70000|?");
  });

  it("catches printf size mistakes", () => {
    expect(() => run(`char b[20]; void test() { long x = 5; sprintf(b, "%d", x); }`)).toThrow(/use %ld/);
  });

  it("round-trips EEPROM.put and get with the AVR layout", () => {
    const { fw, hal } = run(`
      struct R { uint16_t t; int16_t d; int8_t y; float f; };
      R out; int16_t first;
      void test() { R r = { 300, -2, -5, 2.5f }; EEPROM.put(10, r); EEPROM.get(10, out); first = EEPROM.read(10) | (EEPROM.read(11) << 8); }`);
    expect(fw.read("first")).toBe(300);
    expect([...hal.eeprom.slice(10, 19)]).toEqual([44, 1, 254, 255, 251, 0, 0, 32, 64]);
  });

  it("parses with strtol and moves the end pointer", () => {
    const { fw } = run(`long a, b; int rest; void test() { char s[] = "m 2 -150"; char *p = s + 1; a = strtol(p, &p, 10); b = strtol(p, &p, 10); rest = *p; }`);
    expect(fw.read("a")).toBe(2);
    expect(fw.read("b")).toBe(-150);
    expect(fw.read("rest")).toBe(0);
  });

  it("charges time: delay() and the ADC", () => {
    const { hal } = run(`void test() { delay(250); analogRead(A0); }`);
    expect(hal.millis()).toBe(250);
    expect(hal.micros()).toBeGreaterThan(250_100);
  });
});

describe("the generated Sand Tunneller firmware", () => {
  const model = evaluate(readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8"));
  const out = generateFirmware(model.machine!, "Sand Tunneller")[0];
  const files = Object.fromEntries(out.files.map((f) => [f.path.split("/").pop()!, f.content]));

  it("compiles for the Nano and fits its RAM", () => {
    const hal = new BareBoard();
    const { staticRam, uses } = loadFirmware(files, NANO, hal);
    expect(uses).toMatchObject({ serial: true, wire: true, eeprom: true });
    expect(staticRam).toBeGreaterThan(300);
    expect(staticRam).toBeLessThan(2048);
  });

  it("boots, reports the missing IMU and waits for the start delay", () => {
    const hal = new BareBoard();
    const { fw } = loadFirmware(files, NANO, hal);
    fw.reset();
    fw.call("setup");
    expect(hal.text).toContain("Sand Tunneller: brain ready");
    expect(hal.text).toContain("IMU not found");
    expect(hal.text).toContain("Starting in 120 s");
    expect(hal.isr.size).toBe(2);
    // the IMU boot wait took 0.7 s
    expect(hal.millis()).toBeGreaterThanOrEqual(700);
    hal.stopAt = hal.cyc + 16_000 * 2000;
    hal.out = [];
    try {
      for (;;) {
        fw.call("loop");
        hal.spend(16_000);
      }
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    expect(fw.read("state")).toBe(0);
    expect(hal.faults).toEqual([]);
  });

  it("answers the serial console", () => {
    const hal = new BareBoard();
    const { fw } = loadFirmware(files, NANO, hal);
    fw.reset();
    fw.call("setup");
    hal.out = [];
    hal.rx.push(..."h\n".split("").map((c) => c.charCodeAt(0)));
    fw.call("loop");
    expect(hal.text).toContain("Commands:");
    expect(hal.text).toContain("motor 2 = steer");
    hal.out = [];
    hal.rx.push(..."g\n".split("").map((c) => c.charCodeAt(0)));
    fw.call("loop");
    expect(hal.text).toContain("state: digging (go)");
    expect(fw.read("state")).toBe(1);
    // the front motor driver gets PWM on D9 at 0.8 of full
    fw.call("loop");
    expect(hal.pwm.get(9)).toBeGreaterThan(0);
  });
});
