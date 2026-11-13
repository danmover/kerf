// AccelStepper and MultiStepper on the virtual chip: the same speed ramp as the library's source, the same pin
// patterns, the time its float maths takes on an Uno (so it tops out near 5000 steps a second however fast it is
// asked to go), and the steps reaching a stepper on an A4988 in the design.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { Halt, loadFirmware, NANO } from "../src/sim/mcu";
import { Plant } from "../src/sim/engine/plant";
import { Bench, type BenchSpec } from "../src/sim/worlds/bench";
import { evaluate } from "../src/lang/evaluator";
import { rngFrom } from "../src/sim/worlds/common";

const BENCH: BenchSpec = { loads: {}, loadFactor: 1, forces: {}, force: 0, range: 300, ambient: 25 };

const DESIGN = `design "Bench"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component psu = lib.psu("psu_12v_2a") { at: (200, 0, 0) }
wire psu.VPOS -> ctrl.VIN
component drv = lib.stepper_driver("a4988") { at: (100, 0, 0) }
component mot = lib.stepper("nema17_17hs4401") { at: (100, 100, 0) }
wire psu.VPOS -> drv.VMOT
net GND: psu.VNEG, ctrl.GND, drv.GND
net LOGIC: ctrl.V5, drv.VDD
wire ctrl.D3 -> drv.STEP
wire ctrl.D4 -> drv.DIR
wire ctrl.D5 -> drv.EN
wire drv.MOTOR -> mot.PLUG`;

function run(sketch: string, seconds: number, withPlant = true) {
  const m = evaluate(DESIGN, { skipGeometry: true });
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const hal = new SimHal(NANO, { seed: 3 });
  const plant = withPlant ? new Plant(m.machine!, "ctrl", NANO, hal, new Bench(m.machine!, BENCH, "expected"), { rng: rngFrom(11) }) : null;
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
  return {
    out: hal.serial.filter((l) => l.dir === "out").map((l) => l.text),
    faults: hal.faults.map((f) => f.msg),
    r: (plant ? plant.steppers.results() : {}) as Record<string, number>,
  };
}

describe("AccelStepper", () => {
  it("ramps an A4988's stepper to 6400 steps as the library's trapezoid does", () => {
    const { out, faults, r } = run(
      `#include <AccelStepper.h>
AccelStepper stepper(AccelStepper::DRIVER, 3, 4);
void setup() {
  Serial.begin(115200);
  stepper.setEnablePin(5);
  stepper.setPinsInverted(false, false, true);   // the A4988's EN is active low
  stepper.enableOutputs();
  stepper.setMaxSpeed(4000);
  stepper.setAcceleration(8000);
  delay(100);
  unsigned long t0 = millis();
  stepper.runToNewPosition(6400);
  Serial.println(millis() - t0);
  Serial.println(stepper.currentPosition());
}
void loop() {}`,
      3,
    );
    expect(faults).toEqual([]);
    // up to 4000 steps/s in 0.5 s (1000 steps), 4400 steps at speed, 1000 steps down: 2.1 s
    const ms = Number(out[0]);
    expect(ms).toBeGreaterThan(2050);
    expect(ms).toBeLessThan(2250);
    expect(out[1]).toBe("6400");
    expect(r["mot.steps"]).toBe(6400);
    expect(r["mot.turns"]).toBeCloseTo(2, 3);
  });

  it("starts at the speed equation 15 gives and cannot go faster than its maths on an Uno", () => {
    const { out } = run(
      `#include <AccelStepper.h>
AccelStepper stepper(1, 3, 4);
void setup() {
  Serial.begin(115200);
  stepper.setMaxSpeed(20000);
  stepper.setAcceleration(1000);
  stepper.moveTo(100);
  Serial.println(stepper.speed());
  stepper.setAcceleration(1000000);
  stepper.setCurrentPosition(0);
  stepper.moveTo(20000);
  unsigned long t0 = micros();
  while (stepper.distanceToGo() > 10000) stepper.run();
  unsigned long t1 = micros();
  while (stepper.distanceToGo() > 5000) stepper.run();
  Serial.println(5000.0 * 1e6 / (micros() - t1));
}
void loop() {}`,
      8,
      false,
    );
    // 1e6 / (0.676 * sqrt(2 / 1000) * 1e6) steps/s
    expect(Number(out[0])).toBeCloseTo(33.08, 1);
    // asked for 20000 steps/s: each step's speed update takes about 150 µs of float maths
    const rate = Number(out[1]);
    expect(rate).toBeGreaterThan(3500);
    expect(rate).toBeLessThan(7000);
  });

  it("drives a four-wire motor with the library's full-step pattern", () => {
    const { out } = run(
      `#include <AccelStepper.h>
AccelStepper m(AccelStepper::FULL4WIRE, 8, 9, 10, 11);
void setup() {
  Serial.begin(115200);
  m.setMaxSpeed(1000);
  m.setSpeed(1000);
  for (long p = 1; p <= 4; ) {
    if (m.runSpeed()) {
      Serial.print(digitalRead(8)); Serial.print(digitalRead(9)); Serial.print(digitalRead(10)); Serial.println(digitalRead(11));
      p++;
    }
  }
}
void loop() {}`,
      1,
      false,
    );
    expect(out).toEqual(["0110", "0101", "1001", "1010"]);
  });

  it("moves two steppers to arrive together with MultiStepper", () => {
    const { out } = run(
      `#include <AccelStepper.h>
#include <MultiStepper.h>
AccelStepper a(AccelStepper::DRIVER, 3, 4);
AccelStepper b(AccelStepper::DRIVER, 6, 7);
MultiStepper both;
void setup() {
  Serial.begin(115200);
  a.setMaxSpeed(400);
  b.setMaxSpeed(400);
  both.addStepper(a);
  both.addStepper(b);
  long to[2] = {800, -400};
  unsigned long t0 = millis();
  both.moveTo(to);
  both.runSpeedToPosition();
  Serial.println(millis() - t0);
  Serial.println(a.currentPosition());
  Serial.println(b.currentPosition());
}
void loop() {}`,
      3,
      false,
    );
    expect(Number(out[0])).toBeGreaterThan(1950);
    expect(Number(out[0])).toBeLessThan(2100);
    expect(out.slice(1)).toEqual(["800", "-400"]);
  });
});
