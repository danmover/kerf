// Steppers on StepStick drivers and distance and temperature sensors outside a printer simulation, run from
// firmware on the virtual chip: a stepper turns as many steps as the firmware gives it, slips when it is asked
// to start too fast or carry too much, and its driver shuts down hot; the sensors read through analogRead and
// Wire with their own curves, register maps and update rates.

import { describe, expect, it } from "vitest";
import { SimHal } from "../src/sim/engine/hal";
import { Halt, loadFirmware, NANO } from "../src/sim/mcu";
import { Plant } from "../src/sim/engine/plant";
import { Bench, type BenchSpec } from "../src/sim/worlds/bench";
import { FaultInjector } from "../src/sim/engine/faults";
import { sharpVolts, ntcOhms } from "../src/sim/engine/sensors";
import { evaluate } from "../src/lang/evaluator";
import { rngFrom } from "../src/sim/worlds/common";
import { generateFirmware } from "../src/machine/firmware";
import { runSpec } from "../src/sim/build";
import { SIM_TEMPLATES, templateSource } from "../src/sim/templates";
import { outcomesFor } from "../src/sim/runtime";

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

/** a design's firmware run on its bench, the way the engine runs a scenario */
function run(m: ReturnType<typeof design>, sketch: string, seconds: number, bench: Partial<BenchSpec> = {}, faults?: ConstructorParameters<typeof FaultInjector>[0], each?: (plant: Plant, t: number) => void) {
  const hal = new SimHal(NANO, { seed: 3 });
  const inj = faults ? new FaultInjector(faults, rngFrom(5)) : undefined;
  const w0 = new Bench(m.machine!, { ...BENCH, ...bench }, "expected");
  const world = inj ? inj.wrap(w0) : w0;
  const plant = new Plant(m.machine!, "ctrl", NANO, hal, world, { rng: rngFrom(11) });
  inj?.attach(plant);
  plant.afterStep = (t) => {
    inj?.step(t);
    each?.(plant, t);
  };
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
  const out = hal.serial.filter((l) => l.dir === "out").map((l) => l.text);
  const r = { ...plant.steppers.results(), ...plant.sensing.results() } as Record<string, number>;
  return { hal, plant, out, r, events: [...plant.events, ...(inj?.events ?? [])].map((e) => e.text), faults: hal.faults.map((f) => f.msg) };
}

// ---------- steppers ----------

const STEPPER = (drv = "", mot = "", extra = "") => `
component drv = lib.stepper_driver("a4988") { at: (100, 0, 0) ${drv} }
component mot = lib.stepper("nema17_17hs4401") { at: (100, 100, 0) ${mot} }
wire psu.VPOS -> drv.VMOT
net GND: psu.VNEG, ctrl.GND, drv.GND
${extra || "net LOGIC: ctrl.V5, drv.VDD"}
wire ctrl.D3 -> drv.STEP
wire ctrl.D4 -> drv.DIR
wire ctrl.D5 -> drv.EN
wire drv.MOTOR -> mot.PLUG`;

/** a blocking move: `steps` steps (negative backwards), up to `vmax` steps/s at `accel` steps/s² (0: no ramp) */
const MOVER = (moves: string, en = "LOW") => `
const int STEP_PIN = 3;
const int DIR_PIN = 4;
const int EN_PIN = 5;

void move(long steps, float vmax, float accel) {
  digitalWrite(DIR_PIN, steps >= 0 ? HIGH : LOW);
  delayMicroseconds(5);
  long n = steps >= 0 ? steps : -steps;
  for (long i = 0; i < n; i++) {
    float v = vmax;
    if (accel > 0) {
      float up = sqrt(2.0 * accel * (i + 1));
      float down = sqrt(2.0 * accel * (n - i));
      if (up < v) v = up;
      if (down < v) v = down;
      if (v < 200) v = 200;
    }
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(2);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds((unsigned long)(1000000.0 / v) - 2);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(EN_PIN, OUTPUT);
  digitalWrite(EN_PIN, ${en});
  delay(100);
  ${moves}
  Serial.println("done");
}

void loop() {}
`;

describe("a stepper on an A4988, from digitalWrite", () => {
  it("turns the steps it is given when the speed is ramped, both ways", () => {
    const m = design(STEPPER());
    const a = run(m, MOVER("move(6400, 6400, 12800);"), 2.5);
    expect(a.faults).toEqual([]);
    expect(a.out).toEqual(["done"]);
    // 1/16 step and 1 A a phase by default (80 % of the motor's 1.7 A, the A4988's 1 A without a heatsink)
    expect(a.r["mot.steps"]).toBe(6400);
    expect(a.r["mot.turns"]).toBeCloseTo(2, 3);
    expect(a.r["mot.lost_steps"]).toBe(0);
    // asked for 120 rpm, it gets what the loop's float maths leaves time for
    expect(a.r["mot.max_rpm"]).toBeGreaterThan(80);
    expect(a.r["mot.max_rpm"]).toBeLessThan(125);
    expect(a.plant.assumptions.join("\n")).toMatch(/drv: set to 1 A a phase at 1\/16 step.*sim\.measured\(current: 1A, microsteps: 16\)/);
    expect(a.plant.assumptions.join("\n")).toMatch(/pull-out torque 200 N·mm up to 643 rpm on 12 V/);
    const b = run(m, MOVER("move(-3200, 3200, 6400);"), 2);
    expect(b.r["mot.turns"]).toBeCloseTo(-1, 3);
    expect(b.r["mot.lost_steps"]).toBe(0);
  });

  it("starts at up to about 1200 full steps a second without a ramp, and buzzes in place when asked for 15 rev/s at once", () => {
    const full = design(STEPPER("measured: sim.measured(microsteps: 1)"));
    const ok = run(full, MOVER("move(1200, 1200, 0);"), 1.4);
    expect(ok.r["mot.turns"]).toBeCloseTo(6, 3);
    expect(ok.r["mot.lost_steps"]).toBe(0);
    const tooFast = run(full, MOVER("move(3000, 3000, 0);"), 1.6);
    expect(tooFast.r["mot.steps"]).toBe(3000);
    expect(Math.abs(tooFast.r["mot.turns"])).toBeLessThan(0.1);
    expect(tooFast.r["mot.lost_steps"]).toBeGreaterThan(2500);
    expect(tooFast.events.join("\n")).toMatch(/mot lost steps at \d+ rpm with \d+ rpm asked for.*Ramp the speed up more gently/);
    // the same speed reached with a ramp keeps every step
    const ramped = run(full, MOVER("move(4500, 3000, 2000);"), 3.5);
    expect(ramped.r["mot.turns"]).toBeCloseTo(22.5, 3);
    expect(ramped.r["mot.lost_steps"]).toBe(0);
    expect(ramped.r["mot.max_rpm"]).toBeGreaterThan(700);
  });

  it("stalls under more load than its pull-out torque, and carries it at the current the design measured", () => {
    const weak = run(design(STEPPER("", "load: 250")), MOVER("move(3200, 3200, 6400);"), 1.8);
    expect(weak.r["mot.turns"]).toBeCloseTo(0, 3);
    expect(weak.r["mot.lost_steps"]).toBeGreaterThan(150);
    expect(weak.events.join("\n")).toMatch(/it has 200 N·mm there against 250 N·mm of load/);
    const strong = run(design(STEPPER("measured: sim.measured(current: 1.7A)", "load: 250")), MOVER("move(3200, 3200, 6400);"), 1.8);
    expect(strong.r["mot.turns"]).toBeCloseTo(1, 1);
    expect(strong.r["mot.lost_steps"]).toBe(0);
    expect(strong.r["mot.peak_amps"]).toBeCloseTo(1.7, 6);
    // only what it was not told is assumed
    expect(strong.plant.assumptions.find((a) => /^drv: set to/.test(a))).toMatch(/^drv: set to 1\/16 step \(/);
  });

  it("steps from tone() on STEP, and loses its place when the shaft jams", () => {
    const m = design(STEPPER());
    const t = run(m, "void setup() { pinMode(3, OUTPUT); pinMode(4, OUTPUT); pinMode(5, OUTPUT); digitalWrite(4, HIGH); digitalWrite(5, LOW); delay(100); tone(3, 800); delay(2000); noTone(3); } void loop() {}", 2.5);
    expect(t.r["mot.steps"]).toBe(1600);
    expect(t.r["mot.turns"]).toBeCloseTo(0.5, 3);
    const jam = run(m, MOVER("move(6400, 3200, 6400);"), 2.5, {}, [{ kind: "jam", target: "mot", at: 0.6 }]);
    expect(jam.r["mot.turns"]).toBeGreaterThan(0.05);
    expect(jam.r["mot.turns"]).toBeLessThan(0.5);
    expect(jam.r["mot.lost_steps"]).toBeGreaterThan(200);
    expect(jam.events).toContain("Fault: mot jams");
  });

  it("ignores its steps with EN high or no logic supply", () => {
    const en = run(design(STEPPER()), MOVER("move(3200, 3200, 6400);", "HIGH"), 1.8);
    expect(en.r["mot.steps"]).toBe(3200);
    expect(en.r["mot.turns"]).toBe(0);
    expect(en.events).toContain("drv ignores its STEP pulses: EN is high");
    const noLogic = run(design(STEPPER("", "", "net LOGIC: ctrl.V5")), MOVER("move(3200, 3200, 6400);"), 1.8);
    expect(noLogic.r["mot.turns"]).toBe(0);
    expect(noLogic.r["mot.peak_amps"]).toBe(0);
    expect(noLogic.events).toContain("drv ignores its STEP pulses: nothing powers its VDD (logic) pin");
  });

  it("shuts the A4988 down when it holds 2 A a phase for long, and drops a TMC2209 to half current at standstill", () => {
    const hot = run(design(STEPPER("measured: sim.measured(current: 2A)")), MOVER("delay(30000);"), 30);
    expect(hot.plant.notes).toContain("drv is set to 2 A, above mot's 1.7 A rating: it will run hot.");
    expect(hot.r["drv.shutdowns"]).toBe(1);
    expect(hot.events.join("\n")).toMatch(/drv overheated and shut down: 2 A a phase is past its 1 A rating/);
    // both phases' copper loss from the 12 V supply, through the driver's bridge
    expect(hot.r["drv.peak_amps"]).toBeGreaterThan(0.7);
    expect(hot.r["drv.peak_amps"]).toBeLessThan(0.8);
    const tmc = run(design(STEPPER().replace('"a4988"', '"tmc2209"')), MOVER("move(1600, 1600, 3200); delay(2000);"), 4);
    // 1/8 step and 80 % of the motor's rating by default
    expect(tmc.r["mot.steps"]).toBe(1600);
    expect(tmc.r["mot.turns"]).toBeCloseTo(1, 3);
    expect(tmc.r["mot.peak_amps"]).toBeCloseTo(1.36, 6);
    expect(tmc.plant.steppers.motors[0].current).toBeCloseTo(0.68, 6);
  });
});

// ---------- sensors ----------

const SENSORS = `
component ir = lib.sensor("sharp_gp2y0a21") { at: (0, 100, 0) }
component ntc = lib.sensor("xc4494_ntc") { at: (30, 100, 0) }
component t36 = lib.sensor("tmp36") { at: (60, 100, 0) }
component luna = lib.sensor("tf_luna") { at: (90, 100, 0) }
component mcp = lib.sensor("mcp9808_breakout") { at: (120, 100, 0) }
net GND: psu.VNEG, ctrl.GND, ir.GND, ntc.GND, t36.GND, luna.GND, LUNA_CFG mcp.GND
net V5: ctrl.V5, ir.VCC, ntc.VCC, t36.VS, luna.VCC, mcp.VIN
wire ctrl.A0 -> ir.VO
wire ctrl.A1 -> ntc.OUT
wire ctrl.A2 -> t36.VOUT
net SDA: ctrl.A4, luna.SDA, mcp.SDA
net SCL: ctrl.A5, luna.SCL, mcp.SCL`;
const sensors = (cfg = "luna.CFG, ") => design(SENSORS.replace("LUNA_CFG ", cfg));

const READER = (setup = "", every = 500) => `
#include <Wire.h>

unsigned int mcpReg(byte r) {
  Wire.beginTransmission(0x18);
  Wire.write(r);
  Wire.endTransmission();
  Wire.requestFrom(0x18, 2);
  unsigned int hi = Wire.read();
  unsigned int lo = Wire.read();
  return (hi << 8) | lo;
}

float mcpC() {
  unsigned int raw = mcpReg(0x05) & 0x1FFF;
  float c = (raw & 0x0FFF) / 16.0;
  if (raw & 0x1000) c -= 256;
  return c;
}

int lunaCm() {
  Wire.beginTransmission(0x10);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return -1;
  Wire.requestFrom(0x10, 2);
  int lo = Wire.read();
  int hi = Wire.read();
  return lo | (hi << 8);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  ${setup}
}

void loop() {
  static unsigned long last = 0;
  if (millis() - last < ${every}) return;
  last = millis();
  float vIr = analogRead(A0) * 5.0 / 1023;
  float cmIr = 27.86 * pow(vIr, -1.15);
  float adc = analogRead(A1);
  float r = 10000.0 * (1023.0 / adc - 1.0);
  float lr = log(r);
  float cNtc = 1.0 / (0.001129148 + 0.000234125 * lr + 0.0000000876741 * lr * lr * lr) - 273.15;
  float c36 = (analogRead(A2) * 5.0 / 1023 - 0.5) * 100;
  Serial.print("ir "); Serial.print(cmIr, 1);
  Serial.print(" ntc "); Serial.print(cNtc, 2);
  Serial.print(" tmp36 "); Serial.print(c36, 2);
  Serial.print(" luna "); Serial.print(lunaCm());
  Serial.print(" mcp "); Serial.println(mcpC(), 4);
}
`;

describe("sensors, read through analogRead and Wire", () => {
  const parse = (line: string) => Object.fromEntries([...line.matchAll(/(\w+) (-?[\d.]+)/g)].map((x) => [x[1], Number(x[2])]));

  it("read a target at 300 mm and 25 °C air, each through its own curve or registers", () => {
    const a = run(sensors(), READER(`Serial.print("first "); Serial.println(mcpC(), 4); delay(300); Serial.print("id "); Serial.print(mcpReg(6), HEX); Serial.print(" "); Serial.println(mcpReg(7), HEX);`), 3);
    expect(a.faults).toEqual([]);
    // the MCP9808 reads 0 °C until its first conversion (250 ms at its finest resolution); its IDs are 0x0054 and 0x0400
    expect(a.out[0]).toBe("first 0.0000");
    expect(a.out[1]).toBe("id 54 400");
    const rows = a.out.slice(2).map(parse);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      // the Sharp's datasheet curve back to centimetres, within its ±8 % unit spread
      expect(r.ir).toBeGreaterThan(26);
      expect(r.ir).toBeLessThan(34);
      // the Duinotech module through Jaycar's Steinhart-Hart example, and the TMP36's 10 mV/°C
      expect(Math.abs(r.ntc - 25)).toBeLessThan(1.2);
      expect(Math.abs(r.tmp36 - 25)).toBeLessThan(2.5);
      // the TF-Luna in centimetres within its ±6 cm, and the MCP9808 within ±0.25 °C in 1/16 °C steps
      expect(Math.abs(r.luna - 30)).toBeLessThanOrEqual(6);
      expect(Math.abs(r.mcp - 25)).toBeLessThanOrEqual(0.3);
      expect((r.mcp * 16) % 1).toBe(0);
    }
    expect(a.r["luna.reads"]).toBe(rows.length);
    expect(Math.abs(a.r["mcp.temp"] - 25)).toBeLessThanOrEqual(0.3);
  });

  it("follow the bench: a nearer target and warmer air; the TF-Luna reads about 20 cm nearer than 0.2 m and 0 past its reach", () => {
    const near = run(sensors(), READER(), 2, { range: 120, ambient: 40 }).out.map(parse);
    for (const r of near) {
      expect(r.ir).toBeGreaterThan(10);
      expect(r.ir).toBeLessThan(14);
      expect(r.luna).toBeGreaterThanOrEqual(14);
      expect(r.luna).toBeLessThanOrEqual(26);
      expect(Math.abs(r.ntc - 40)).toBeLessThan(1.5);
      expect(Math.abs(r.mcp - 40)).toBeLessThanOrEqual(0.3);
    }
    const far = run(sensors(), READER(), 1.2, { range: 9000 }).out.map(parse);
    for (const r of far) {
      expect(r.luna).toBe(0);
      // nothing in the Sharp's range: its output flattens near 0.3 V, which the curve calls well past 80 cm
      expect(r.ir).toBeGreaterThan(90);
    }
    expect(sharpVolts(74)).toBeCloseTo(3.15, 2);
    expect(sharpVolts(800)).toBeCloseTo(0.4, 1);
    expect(sharpVolts(20)).toBeLessThan(sharpVolts(74));
    expect(ntcOhms(25)).toBeCloseTo(10000, -2);
    expect(ntcOhms(0)).toBeGreaterThan(30000);
  });

  it("set the MCP9808's flags, resolution and the TF-Luna's mode as their datasheets say", () => {
    // T_UPPER at 20 °C: T_A comes back with its above-upper and at-or-above-critical (0 °C by default) bits set
    const flags = run(sensors(), READER(`Wire.beginTransmission(0x18); Wire.write(0x02); Wire.write(0x01); Wire.write(0x40); Wire.endTransmission(); delay(300); Serial.print("ta "); Serial.println(mcpReg(5), HEX);`), 0.8);
    const ta = parseInt(flags.out[0].split(" ")[1], 16);
    expect(ta & 0xe000).toBe(0xc000);
    expect(Math.abs((ta & 0x1fff) / 16 - 25)).toBeLessThanOrEqual(0.3);
    // half-degree resolution: a reading every 30 ms in 0.5 °C steps
    const coarse = run(sensors(), READER(`Wire.beginTransmission(0x18); Wire.write(0x08); Wire.write(0x00); Wire.endTransmission();`, 50), 0.6);
    const rows = coarse.out.map(parse);
    for (const r of rows) expect((r.mcp * 2) % 1).toBe(0);
    // it is not ready for its first 0.1 s, and with CFG open it is a UART part that never answers on I2C
    expect(rows[0].luna).toBe(-1);
    expect(rows[1].luna).toBeGreaterThan(20);
    const uart = run(sensors(""), READER(), 1.2);
    expect(uart.out.map(parse).every((r) => r.luna === -1)).toBe(true);
    expect(uart.plant.notes.join("\n")).toMatch(/luna\.CFG is not tied to ground/);
  });

  it("hold their last reading when stuck", () => {
    const f = run(sensors(), READER("", 200), 2.5, {}, [{ kind: "stuck", target: "luna", at: 1 }, { kind: "stuck", target: "mcp", at: 1 }]);
    expect(f.events).toContain("Fault: luna freezes");
    const rows = f.out.map(parse);
    const after = rows.slice(6);
    expect(after.length).toBeGreaterThanOrEqual(5);
    expect(new Set(after.map((r) => r.luna)).size).toBe(1);
    expect(new Set(after.map((r) => r.mcp)).size).toBe(1);
  });
});

// ---------- the bench firmware Kerf writes ----------

const BENCH_DESIGN = `design "Stepper and sensor bench"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component psu = lib.psu("psu_12v_2a") { at: (200, 0, 0) }
component drv = lib.stepper_driver("a4988") { at: (100, 0, 0) }
component mot = lib.stepper("nema17_17hs4401") { at: (100, 100, 0) }
component ir = lib.sensor("sharp_gp2y0a21") { at: (0, 100, 0) }
component ntc = lib.sensor("xc4494_ntc") { at: (30, 100, 0) }
component t36 = lib.sensor("tmp36") { at: (60, 100, 0) }
component luna = lib.sensor("tf_luna") { at: (90, 100, 0) }
component mcp = lib.sensor("mcp9808_breakout") { at: (120, 100, 0) }
wire psu.VPOS -> ctrl.VIN
wire psu.VPOS -> drv.VMOT
net GND: psu.VNEG, ctrl.GND, drv.GND, ir.GND, ntc.GND, t36.GND, luna.GND, luna.CFG, mcp.GND
net V5: ctrl.V5, drv.VDD, ir.VCC, ntc.VCC, t36.VS, luna.VCC, mcp.VIN
wire ctrl.D3 -> drv.STEP
wire ctrl.D4 -> drv.DIR
wire ctrl.D5 -> drv.EN
wire drv.MOTOR -> mot.PLUG
wire ctrl.A0 -> ir.VO
wire ctrl.A1 -> ntc.OUT
wire ctrl.A2 -> t36.VOUT
net SDA: ctrl.A4, luna.SDA, mcp.SDA
net SCL: ctrl.A5, luna.SCL, mcp.SCL
firmware bench { board: ctrl, behaviour: "bring-up tests" }`;

describe("the bench firmware Kerf writes", () => {
  it("drives each stepper from the wiring and reads each sensor in its own units", () => {
    const m = evaluate(BENCH_DESIGN, { skipGeometry: true });
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const fw = generateFirmware(m.machine!, m.name)[0];
    expect(fw.warnings).toEqual([]);
    const file = (end: string) => fw.files.find((f) => f.path.endsWith(end))!.content;
    expect(file("pins.h")).toMatch(/#define MOT_STEP\s+3\s+\/\/ ctrl\.D3 -> drv\.STEP/);
    expect(file("pins.h")).toMatch(/#define MOT_STEPS_REV\s+3200L\s+\/\/ 200 full steps a turn × 16/);
    expect(file("pins.h")).toMatch(/#define IR_PIN\s+A0/);
    expect(file("pins.h")).toMatch(/luna: .* at 0x10 on the I2C pins/);
    expect(file("config.h")).toMatch(/#define STEPPER_RPM\s+120/);
    const ino = file(".ino");
    expect(ino).toContain("#include <Wire.h>");
    expect(ino).toContain("case 'j':");
    expect(ino).toContain("case 'r': readSensors(); break;");
    expect(file("README.md")).toMatch(/\| `j <n> <steps>` \|/);
    expect(file("README.md")).toMatch(/\*\*mot\*\* on drv: 3200 steps a turn/);
  });

  it("jogs the stepper a turn in the power-up test with loop() still keeping up, and answers j and r from the console", () => {
    const m = evaluate(BENCH_DESIGN, { skipGeometry: true });
    const block = templateSource(SIM_TEMPLATES.find((t) => t.id === "power_up")!, m).source!;
    expect(block).toContain('console: [sim.type("j 0 3200", at: 2s)]');
    const withIt = evaluate(`${BENCH_DESIGN}\n${block.replace("duration: 1min", "duration: 6s")}\n`, { skipGeometry: true });
    expect(withIt.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const def = withIt.scenarios!.at(-1)!;
    const r = runSpec({ ...def.spec, variants: ["expected"] }, withIt.machine!, withIt.name);
    expect(r.error).toBeUndefined();
    const v = r.variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results["mot.turns"]).toBeCloseTo(1, 3);
    const outcomes = outcomesFor(def, r)!;
    for (const label of ["Stays powered", "No firmware mistakes", "mot turns a turn", "mot keeps every step", "loop() keeps up"]) expect(outcomes.find((o) => o.label === label)?.status, label).toBe("pass");
    const out = v.serial.filter((l) => l.dir === "out").map((l) => l.text);
    expect(out).toContain("mot moving 3200 steps");
    expect(out).toContain("mot at 3200 steps");

    // back half a turn, then the sensors
    const spec = { ...def.spec, console: [{ t: 1, text: "j 0 -1600\n" }, { t: 3, text: "r\n" }], variants: ["expected" as const] };
    const r2 = runSpec(spec, withIt.machine!, withIt.name).variants[0];
    expect(r2.results["mot.turns"]).toBeCloseTo(-0.5, 3);
    const line = r2.serial.filter((l) => l.dir === "out").map((l) => l.text).find((t) => t.startsWith("ir "))!;
    // the bench's target is 1 m away, past the Sharp's 80 cm, in 20 °C air
    expect(line).toMatch(/^ir out of range {2}ntc (19|20)\.\d C {2}t36 (1[89]|2[01])\.\d C {2}luna (9[4-9]|10[0-6]) cm {2}mcp (19|20)\.\d\d C$/);
  }, 120_000);
});
