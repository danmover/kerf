// The chip's own timers and pin interrupts as firmware drives them: the ATmega328P's timers 0–2 through their
// registers (CTC and PWM modes, their interrupts, flags polled by hand, the prescaler change that speeds up
// millis()), its ports and pin-change and external interrupts, the TimerOne library, and the ESP32 core 3.x
// hardware timers. Each sketch is one that runs on the real board; the numbers are the ones the chip gives.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { CError, FEATHER_ESP32_V2, Halt, loadFirmware, NANO, type Board } from "../src/sim/mcu";

interface RunOpts {
  board?: Board;
  /** external pin changes: [seconds, pin, level] */
  pins?: [number, number, number][];
}

function run(sketch: string, seconds: number, opts: RunOpts = {}) {
  const board = opts.board ?? NANO;
  const hal = new SimHal(board, { seed: 5 });
  hal.endCyc = Math.round(seconds * board.fcpu);
  for (const [t, pin, level] of opts.pins ?? []) hal.schedulePin(Math.round(t * board.fcpu), pin, level);
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

const num = (s: string) => Number(s.trim());

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

describe("ATmega328P timers through their registers", () => {
  it("runs a CTC compare-match interrupt at 1 kHz", () => {
    const r = run(
      `volatile unsigned long ticks = 0;
ISR(TIMER1_COMPA_vect) { ticks++; }
void setup() {
  Serial.begin(115200);
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = 249;
  TCCR1B |= (1 << WGM12) | (1 << CS11) | (1 << CS10);
  TIMSK1 |= (1 << OCIE1A);
  interrupts();
}
void loop() {
  static unsigned long last = 0;
  if (millis() - last >= 1000) {
    last += 1000;
    noInterrupts();
    unsigned long t = ticks;
    interrupts();
    Serial.println(t);
  }
}`,
      2.05,
    );
    expect(r.lines.length).toBe(2);
    expect(Math.abs(num(r.lines[0]) - 1000)).toBeLessThanOrEqual(1);
    expect(Math.abs(num(r.lines[1]) - 2000)).toBeLessThanOrEqual(1);
    expect(r.faults).toEqual([]);
  });

  it("makes 25 kHz fast PWM from ICR1 (mode 14), as a fan needs", () => {
    const r = run(
      `void setup() {
  pinMode(9, OUTPUT);
  TCCR1A = (1 << COM1A1) | (1 << WGM11);
  TCCR1B = (1 << WGM13) | (1 << WGM12) | (1 << CS10);
  ICR1 = 639;
  OCR1A = 320;
}
void loop() {}`,
      0.05,
    );
    expect(r.hal.pwmHz(9)).toBeCloseTo(25000, 3);
    expect(r.hal.duty[9]).toBeCloseTo(321 / 640, 6);
    expect(r.faults).toEqual([]);
  });

  it("speeds analogWrite() up to 31 kHz when the sketch changes timer 1's prescaler", () => {
    for (const order of ["prescaler first", "analogWrite first"]) {
      const hack = "TCCR1B = (TCCR1B & 0b11111000) | 0x01;";
      const write = "analogWrite(9, 128);";
      const r = run(`void setup() { pinMode(9, OUTPUT); ${order === "prescaler first" ? hack + write : write + hack} }\nvoid loop() {}`, 0.02);
      expect(r.hal.pwmHz(9)).toBeCloseTo(16e6 / 510, 2);
      expect(r.hal.duty[9]).toBeCloseTo(128 / 255, 6);
    }
    // untouched, pin 9 keeps the board's own 490 Hz
    const plain = run("void setup() { analogWrite(9, 64); }\nvoid loop() {}", 0.02);
    expect(plain.hal.pwmHz(9)).toBeCloseTo(NANO.pwm[9], 6);
    expect(plain.hal.duty[9]).toBeCloseTo(64 / 255, 6);
  });

  it("counts timer 2 overflows a sketch polls and clears by hand", () => {
    const r = run(
      `void setup() {
  Serial.begin(115200);
  TCCR2A = 0;
  TCCR2B = (1 << CS22) | (1 << CS21) | (1 << CS20);
  TIFR2 = (1 << TOV2);
}
unsigned long n = 0;
void loop() {
  if (TIFR2 & (1 << TOV2)) {
    TIFR2 = (1 << TOV2);
    n++;
  }
  if (millis() >= 1000) {
    Serial.println(n);
    while (1) {}
  }
}`,
      1.1,
    );
    // 16 MHz / 1024 / 256 = 61.04 overflows a second
    expect(Math.abs(num(r.lines[0]) - 61)).toBeLessThanOrEqual(1);
  });

  it("reads a 16-bit count a byte at a time through TEMP", () => {
    const r = run(
      `void setup() {
  Serial.begin(115200);
  TCCR1A = 0;
  TCCR1B = (1 << CS12);
  TCNT1H = 0x12;
  TCNT1L = 0x34;
  unsigned int a = TCNT1;
  delayMicroseconds(1600);
  uint8_t lo = TCNT1L;
  uint8_t hi = TCNT1H;
  Serial.println(a);
  Serial.println((hi << 8) | lo);
}
void loop() {}`,
      0.05,
    );
    expect(num(r.lines[0])).toBeGreaterThanOrEqual(0x1234);
    expect(num(r.lines[0])).toBeLessThan(0x1234 + 3);
    // 1.6 ms at 16 MHz / 256 is 100 counts more
    expect(Math.abs(num(r.lines[1]) - (0x1234 + 100))).toBeLessThanOrEqual(3);
  });

  it("runs millis() 64 times fast after a timer 0 prescaler change, and says so", () => {
    const r = run(
      `void setup() {
  Serial.begin(115200);
  TCCR0B = (TCCR0B & 0xF8) | 0x01;
}
void loop() {
  delay(6400);
  Serial.println(millis());
}`,
      0.35,
    );
    expect(r.lines.length).toBe(3);
    expect(r.at[0]).toBeGreaterThan(0.099);
    expect(r.at[0]).toBeLessThan(0.102);
    expect(Math.abs(num(r.lines[0]) - 6400)).toBeLessThan(8);
    expect(r.faults.some((f) => f.includes("64 times fast"))).toBe(true);
  });

  it("refuses ISR(TIMER0_OVF_vect), which the core already uses for millis()", () => {
    const r = run("ISR(TIMER0_OVF_vect) { }\nvoid setup() { }\nvoid loop() { }", 0.01);
    expect(r.faults.some((f) => f.includes("multiple definition of __vector_16"))).toBe(true);
  });
});

describe("ATmega328P ports and pin interrupts", () => {
  it("drives and reads pins through DDRx, PORTx and PINx", () => {
    const r = run(
      `void setup() {
  Serial.begin(115200);
  DDRB |= (1 << DDB5);
  DDRD &= ~(1 << DDD2);
  PORTD |= (1 << PORTD2);
}
void loop() {
  PINB = (1 << PINB5);
  Serial.print((PORTB >> PORTB5) & 1);
  Serial.print(" ");
  Serial.println((PIND >> PIND2) & 1);
  delay(100);
}`,
      0.35,
      { pins: [[0.25, 2, 0]] },
    );
    expect(r.lines).toEqual(["1 1", "0 1", "1 1", "0 0"]);
    expect(r.hal.mode[13]).toBe(1);
  });

  it("runs a pin-change interrupt on every edge and INT0 on falling ones", () => {
    const r = run(
      `volatile int changes = 0;
volatile int falls = 0;
ISR(PCINT0_vect) { changes++; }
ISR(INT0_vect) { falls++; }
void setup() {
  Serial.begin(115200);
  pinMode(8, INPUT_PULLUP);
  pinMode(2, INPUT_PULLUP);
  PCICR |= (1 << PCIE0);
  PCMSK0 |= (1 << PCINT0);
  EICRA = (1 << ISC01);
  EIMSK = (1 << INT0);
}
void loop() {
  delay(500);
  Serial.print(changes);
  Serial.print(" ");
  Serial.println(falls);
}`,
      0.55,
      {
        pins: [
          [0.1, 8, 0],
          [0.2, 8, 1],
          [0.3, 8, 0],
          [0.4, 8, 1],
          [0.15, 2, 0],
          [0.25, 2, 1],
          [0.35, 2, 0],
        ],
      },
    );
    expect(r.lines).toEqual(["4 2"]);
  });
});

describe("TimerOne", () => {
  it("runs its callback at the period and makes PWM on pin 10", () => {
    const r = run(
      `#include <TimerOne.h>
volatile unsigned long n = 0;
void tick() { n++; }
void setup() {
  Serial.begin(115200);
  Timer1.initialize(500);
  Timer1.attachInterrupt(tick);
  Timer1.pwm(10, 512);
}
void loop() {
  delay(1000);
  noInterrupts();
  unsigned long c = n;
  interrupts();
  Serial.println(c);
}`,
      1.05,
    );
    expect(Math.abs(num(r.lines[0]) - 2000)).toBeLessThanOrEqual(2);
    expect(r.hal.pwmHz(10)).toBeCloseTo(2000, 3);
    expect(r.hal.duty[10]).toBeCloseTo(0.5, 3);
    expect(r.faults).toEqual([]);
  });

  it("does not compile for an ESP32", () => {
    const e = compileError("#include <TimerOne.h>\nvoid t() {}\nvoid setup() { Timer1.initialize(1000); Timer1.attachInterrupt(t); }\nvoid loop() {}", FEATHER_ESP32_V2);
    expect(e).toContain("timerBegin()");
  });
});

describe("ESP32 hardware timers (core 3.x)", () => {
  const ESP = { board: FEATHER_ESP32_V2 };

  it("runs the alarm's handler at 1 kHz", () => {
    const r = run(
      `hw_timer_t *timer = NULL;
volatile uint32_t n = 0;
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
void IRAM_ATTR onTimer() {
  portENTER_CRITICAL_ISR(&mux);
  n++;
  portEXIT_CRITICAL_ISR(&mux);
}
void setup() {
  Serial.begin(115200);
  timer = timerBegin(1000000);
  timerAttachInterrupt(timer, &onTimer);
  timerAlarm(timer, 1000, true, 0);
}
void loop() {
  delay(500);
  Serial.print(n);
  Serial.print(" ");
  Serial.println(timerGetFrequency(timer));
}`,
      0.55,
      ESP,
    );
    const [n, hz] = r.lines[0].split(" ").map(Number);
    expect(Math.abs(n - 500)).toBeLessThanOrEqual(1);
    expect(hz).toBe(1000000);
    expect(r.faults).toEqual([]);
  });

  it("reloads to the last argument at each alarm, as the core passes it to the timer", () => {
    const r = run(
      `hw_timer_t *timer;
volatile uint32_t n = 0;
void onTimer() { n++; }
void setup() {
  Serial.begin(115200);
  timer = timerBegin(1000000);
  timerAttachInterrupt(timer, onTimer);
  timerAlarm(timer, 1000, true, 400);
}
void loop() {
  delay(600);
  Serial.println(n);
  timerDetachInterrupt(timer);
  delay(100);
  Serial.println(n);
  while (true) delay(10);
}`,
      0.75,
      ESP,
    );
    // the first alarm after 1000 µs, then one every 600 µs
    expect(Math.abs(num(r.lines[0]) - 999)).toBeLessThanOrEqual(1);
    expect(num(r.lines[1])).toBe(num(r.lines[0]));
    expect(r.faults.some((f) => f.includes("every 600 ticks"))).toBe(true);
  });

  it("passes timerAttachInterruptArg()'s argument to the handler", () => {
    const r = run(
      `hw_timer_t *timer;
volatile uint32_t count = 0;
void onTimer(void *arg) { (*(volatile uint32_t *)arg)++; }
void setup() {
  Serial.begin(115200);
  timer = timerBegin(10000);
  timerAttachInterruptArg(timer, onTimer, (void *)&count);
  timerAlarm(timer, 100, true, 0);
}
void loop() {
  delay(250);
  Serial.println(count);
  while (true) delay(10);
}`,
      0.3,
      ESP,
    );
    expect(Math.abs(num(r.lines[0]) - 25)).toBeLessThanOrEqual(1);
  });

  it("explains the core 2.x calls that no longer compile", () => {
    const begin = compileError("hw_timer_t *t;\nvoid f() {}\nvoid setup() { t = timerBegin(0, 80, true); }\nvoid loop() {}", FEATHER_ESP32_V2);
    expect(begin).toContain("timerBegin(frequency)");
    expect(begin).toContain("core 2.x");
    const attach = compileError("hw_timer_t *t;\nvoid f() {}\nvoid setup() { t = timerBegin(1000000); timerAttachInterrupt(t, &f, true); }\nvoid loop() {}", FEATHER_ESP32_V2);
    expect(attach).toContain("timerAttachInterrupt(timer, fn)");
    const write = compileError("hw_timer_t *t;\nvoid setup() { t = timerBegin(1000000); timerAlarmWrite(t, 1000000, true); timerAlarmEnable(t); }\nvoid loop() {}", FEATHER_ESP32_V2);
    expect(write).toContain("timerAlarm(timer, ticks, autoreload, 0)");
    expect(compileError("hw_timer_t *t;\nvoid setup() { t = timerBegin(1000000); timerReadMilis(t); }\nvoid loop() {}", FEATHER_ESP32_V2)).toContain("timerReadMillis");
  });

  it("does not compile timerBegin() for an Uno or Nano", () => {
    expect(compileError("void setup() { timerBegin(1000000); }\nvoid loop() {}", NANO)).toContain("ESP32");
  });
});
