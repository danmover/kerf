// The firmware debugger: breakpoints with conditions and hit counts, logpoints, watches, stopping on firmware
// mistakes, the call stack with each frame's variables, and the recording after each stop that stepping walks. A
// debugged run must be the same run as an undebugged one, so its stops line up with the replay.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { Halt, loadFirmware, NANO, type DebugSpec } from "../src/sim/mcu";
import { checkFirmware } from "../src/sim/mcu/check";
import { edges, SignalRecorder, toVcd } from "../src/sim/engine/probes";
import { lineChange } from "../src/ui/firmware/lineChange";

function run(files: Record<string, string>, seconds: number, debug?: DebugSpec, signals = false) {
  const hal = new SimHal(NANO, { seed: 5 });
  const probe = signals ? (hal.probe = new SignalRecorder(hal)) : null;
  hal.endCyc = Math.round(seconds * NANO.fcpu);
  const lf = loadFirmware(files, NANO, hal, undefined, debug);
  const fw = lf.fw;
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
  return { hal, out: hal.serial.filter((l) => l.dir === "out").map((l) => `${l.t.toFixed(4)} ${l.text}`), debug: fw.debug?.(), faults: hal.faults, signals: probe?.result(hal.cyc) };
}

const SKETCH = `#include "util.h"

struct Reading { int raw; float volts; };
Reading last = { 0, 0.0 };
int count = 0;
int table[4] = { 1, 2, 3, 4 };

int scaled(int raw) {
  int doubled = raw * 2;
  return doubled + OFFSET;
}

void setup() {
  Serial.begin(115200);
  Serial.println("state: ready");
}

void loop() {
  int raw = analogRead(A0);

  last.raw = scaled(raw);
  last.volts = raw * (5.0 / 1023.0);
  count++;
  if (count % 50 == 0) Serial.println(count);
  delay(10);
}
`;
const UTIL = `#pragma once
#define OFFSET 7
`;
const files = { "probe.ino": SKETCH, "util.h": UTIL };

describe("firmware debugger", () => {
  it("stops at a breakpoint with the stack, locals, globals and watches", () => {
    const r = run(files, 1, { breakpoints: [{ id: "a", file: "probe.ino", line: 9 }], watches: ["count * 2", "last.raw", "OFFSET"], maxStops: 5 });
    const d = r.debug!;
    expect(d.bound.a).toBe(9);
    expect(d.stops.length).toBe(5);
    expect(d.more).toBe(true);
    const s = d.stops[0];
    expect(s.reason).toBe("breakpoint");
    expect(s.fn).toBe("scaled");
    expect(s.stack.map((f) => f.fn)).toEqual(["scaled", "loop"]);
    expect(s.stack[1].line).toBe(21);
    // raw is the parameter; doubled isn't declared yet at the line that declares it
    expect(s.stack[0].locals.map((v) => v.name)).toEqual(["raw"]);
    expect(s.stack[1].locals.map((v) => v.name)).toEqual(["raw"]);
    expect(s.globals.find((g) => g.name === "table")?.value).toBe("[1, 2, 3, 4]");
    expect(s.globals.find((g) => g.name === "last")?.value).toMatch(/^\{raw: 0, volts: 0\}$/);
    expect(s.watches.map((w) => w.expr)).toEqual(["count * 2", "last.raw", "OFFSET"]);
    expect(s.watches[0].value).toBe("0");
    expect(s.watches[2].value).toBe("7");
    // the second stop is the next pass of loop(): count went up once
    expect(d.stops[1].watches[0].value).toBe("2");
    expect(d.hits.a).toBeGreaterThan(50);
  });

  it("records what runs after a stop, for stepping over, into and out", () => {
    const d = run(files, 0.2, { breakpoints: [{ id: "b", file: "probe.ino", line: 21 }], maxStops: 1, traceSteps: 12 }).debug!;
    const s = d.stops[0];
    expect(s.fn).toBe("loop");
    expect(s.depth).toBe(1);
    const lines = s.trace.map((st) => `${d.sites[st.s].fn}:${d.sites[st.s].line}@${st.d}`);
    // into scaled(), back out to loop's next lines
    expect(lines.slice(0, 5)).toEqual(["scaled:9@2", "scaled:10@2", "loop:22@1", "loop:23@1", "loop:24@1"]);
    // doubled is set once its line has run
    const second = s.trace[1];
    const names = d.sites[second.s].locals.map((l) => l.name);
    expect(names).toEqual(["raw", "doubled"]);
    expect(Number(second.v[1])).toBe(Number(second.v[0]) * 2);
    // a global that changes shows on the step after the change
    expect(s.trace.some((st) => st.g?.some(([n]) => n === "count"))).toBe(true);
  });

  it("binds a breakpoint on a line without code to the next line with some", () => {
    const d = run(files, 0.1, { breakpoints: [{ id: "c", file: "probe.ino", line: 20 }, { id: "x", file: "probe.ino", line: 200 }], maxStops: 1 }).debug!;
    expect(d.bound.c).toBe(21);
    expect(d.bound.x).toBe(null);
  });

  it("stops only when the condition holds, and from the hit asked for", () => {
    const d = run(files, 2, { breakpoints: [{ id: "k", file: "probe.ino", line: 24, cond: "count == 30" }, { id: "h", file: "probe.ino", line: 25, hit: 3 }], maxStops: 40 }).debug!;
    const ks = d.stops.filter((s) => s.bp === "k");
    expect(ks.length).toBe(1);
    expect(ks[0].globals.find((g) => g.name === "count")?.value).toBe("30");
    expect(d.hits.k).toBe(1);
    const hs = d.stops.filter((s) => s.bp === "h");
    // the third pass on: 2 skipped
    expect(hs[0].globals.find((g) => g.name === "count")?.value).toBe("3");
  });

  it("logpoints print without stopping", () => {
    const d = run(files, 0.25, { breakpoints: [{ id: "l", file: "probe.ino", line: 23, log: "count={count} raw={last.raw}" }] }).debug!;
    expect(d.stops.length).toBe(0);
    expect(d.logs.length).toBeGreaterThan(10);
    expect(d.logs[0].text).toMatch(/^count=0 raw=\d+$/);
    expect(d.logs[3].text).toMatch(/^count=3 /);
  });

  it("won't watch what would change the firmware, and says why", () => {
    const d = run(files, 0.05, { breakpoints: [{ id: "a", file: "probe.ino", line: 23, cond: "count++" }], watches: ["count = 3", "Serial.read()", "nosuch + 1"], maxStops: 2 }).debug!;
    expect(d.errors.some((e) => e.bp === "a" && /\+\+/.test(e.message))).toBe(true);
    expect(d.errors.some((e) => e.watch === "count = 3")).toBe(true);
    expect(d.errors.some((e) => e.watch === "Serial.read()" && /calls a function/.test(e.message))).toBe(true);
    expect(d.stops.length).toBe(0);
  });

  it("stops where the firmware makes a mistake", () => {
    const bad = `int buf[4];
int i = 0;
void setup() { Serial.begin(9600); }
void loop() {
  buf[i] = i;
  i++;
  delay(5);
}
`;
    const r = run({ "bad.ino": bad }, 0.2, { breakpoints: [], breakOnFault: true });
    const d = r.debug!;
    expect(d.stops.length).toBe(1);
    const s = d.stops[0];
    expect(s.reason).toBe("fault");
    expect(s.line).toBe(5);
    expect(s.fault).toMatch(/index|range|bounds/i);
    expect(s.globals.find((g) => g.name === "i")?.value).toBe("4");
    // the mistakes are still the run's
    expect(r.faults.length).toBeGreaterThan(1);
    expect(r.faults[0].line).toBe(5);
  });

  it("a debugged run is the same run", () => {
    const plain = run(files, 1.5);
    const dbg = run(files, 1.5, { breakpoints: [{ id: "a", file: "probe.ino", line: 9 }, { id: "l", file: "probe.ino", line: 23, log: "{count}" }], watches: ["last.volts"], breakOnFault: true, maxStops: 20 });
    expect(dbg.out).toEqual(plain.out);
    expect(dbg.hal.cyc).toBe(plain.hal.cyc);
  });

  it("compile check: the first mistake on its file and line, or the RAM it takes", () => {
    const ok = checkFirmware(
      Object.entries(files).map(([path, content]) => ({ path, content })),
      "arduino_nano",
    );
    expect(ok.ok).toBe(true);
    expect(ok.ram!.used).toBeGreaterThan(20);
    expect(ok.ram!.total).toBe(2048);
    const broken = checkFirmware(
      [
        { path: "probe.ino", content: SKETCH.replace("count++;", "cuont++;") },
        { path: "util.h", content: UTIL },
      ],
      "arduino_nano",
    );
    expect(broken.problem).toEqual({ file: "probe.ino", line: 23, message: '"cuont" is not declared' });
  });
});

describe("logic analyser", () => {
  const SIG = `#include <Servo.h>
Servo arm;
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
  arm.attach(9);
  arm.write(90);
  analogWrite(5, 64);
}
int n = 0;
void loop() {
  digitalWrite(13, n & 1);
  if (n == 3) tone(8, 440);
  if (n == 6) noTone(8);
  int v = analogRead(A0);
  Serial.print("v");
  Serial.println(v);
  n++;
  delay(50);
}
`;
  it("records each pin's levels, PWM, servo pulses and tones, the serial bytes on the wire and the analog readings", () => {
    const r = run({ "sig.ino": SIG }, 0.6, undefined, true);
    const tr = r.signals!;
    const led = tr.pins.find((p) => p.pin === 13)!;
    expect(led.name).toBe("D13");
    const levels = led.segs.filter((s) => s.k === "l").map((s) => s.v);
    expect(levels.slice(0, 4)).toEqual([0, 1, 0, 1]);
    // each pass is 50 ms apart
    const dt = led.segs[2].t - led.segs[1].t;
    expect(dt).toBeGreaterThan(0.049);
    expect(dt).toBeLessThan(0.053);
    const pwm = tr.pins.find((p) => p.pin === 5)!.segs.at(-1)!;
    expect(pwm.k).toBe("pwm");
    expect(pwm.duty).toBeCloseTo(64 / 255, 3);
    expect(pwm.hz).toBe(NANO.pwm[5]);
    const servo = tr.pins.find((p) => p.pin === 9)!.segs.at(-1)!;
    expect(servo.k).toBe("servo");
    expect(servo.us).toBeGreaterThan(1400);
    const tone = tr.pins.find((p) => p.pin === 8)!.segs;
    expect(tone.some((s) => s.k === "tone" && s.hz === 440)).toBe(true);
    expect(tone.at(-1)!.k).not.toBe("tone");
    // "v" then the number, then CR LF, one byte at 115200 baud each
    const tx = tr.uart.filter((u) => u.dir === "tx");
    expect(String.fromCharCode(tx[0].b)).toBe("v");
    expect(tx[0].t1 - tx[0].t0).toBeCloseTo(10 / 115200, 5);
    expect(tr.adc.length).toBeGreaterThan(8);
    expect(tr.adc[0].pin).toBe(NANO.analog[0]);
    // PWM drawn out as edges: 980 Hz on pin 5 for 10 ms is about 10 periods
    const e = edges(tr.pins.find((p) => p.pin === 5)!, 0.3, 0.31);
    expect(e.length).toBeGreaterThan(16);
    expect(e.length).toBeLessThan(26);
    const vcd = toVcd(tr, 0, 0.2, { names: new Map([[13, "led"]]) });
    expect(vcd).toMatch(/\$var wire 1 \S+ D13_led \$end/);
    expect(vcd).toMatch(/\$var reg 8 \S+ Serial_tx \$end/);
    expect(vcd).toMatch(/\$enddefinitions \$end/);
    expect(vcd).toMatch(/^#\d+$/m);
  });

  it("recording changes nothing in the run", () => {
    const plain = run({ "sig.ino": SIG }, 0.6);
    const rec = run({ "sig.ino": SIG }, 0.6, undefined, true);
    expect(rec.out).toEqual(plain.out);
    expect(rec.hal.cyc).toBe(plain.hal.cyc);
  });
});

describe("firmware editor: changes made elsewhere", () => {
  const apply = (a: string, c: { from: number; to: number; insert: string }) => a.slice(0, c.from) + c.insert + a.slice(c.to);
  const cases: [string, string][] = [
    ["a\nb\nc\n", "a\nX\nb\nc\n"],
    ["{\n  s;\n}\n", "{\n  u;\n  s;\n}\n"],
    ["a\nb\nc", "a\nB\nc"],
    ["a\nb\nc", "a\nc"],
    ["x", "x\nx"],
    ["x\ny", "x"],
    ["", "x"],
    ["x\n", ""],
    ["a\nb\n", "a\nb\nc\n"],
    ["a\nb\nc\nd", "a\nB\nC\nd"],
  ];
  it("turns one version into the other", () => {
    for (const [a, b] of cases) expect(apply(a, lineChange(a, b))).toBe(b);
  });
  it("inserts whole lines at a line's start, so code below moves down with its breakpoint", () => {
    const c = lineChange("{\n  s;\n}\n", "{\n  u;\n  s;\n}\n");
    expect(c).toEqual({ from: 2, to: 2, insert: "  u;\n" });
  });
});
