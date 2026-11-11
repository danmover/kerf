// A ducted fan on a two-axis gimbal held level by vanes in its jet: the ESP32
// Feather V2 board on the virtual chip, the LSM6DSOX, the ESC arming and
// failing safe, the fan's thrust and gyroscopic torque, vane lift, the HX711
// load cell, an e-stop press, and the generated balance firmware closing the
// loop on the mechanism.

import { describe, expect, it } from "vitest";
import { catalogPart } from "../src/machine/catalog";
import { generateFirmware } from "../src/machine/firmware";
import { evaluate } from "../src/lang/evaluator";
import { EscFan, Lsm6dsox } from "../src/sim/engine/devices";
import { SimHal } from "../src/sim/engine/hal";
import { FEATHER_ESP32_V2, Halt, loadFirmware } from "../src/sim/mcu";
import { Plant } from "../src/sim/engine/plant";
import { Bench } from "../src/sim/worlds/bench";
import { runSpec } from "../src/sim/build";
import { FRAME, type MechBody, type MechModel, type MechVane } from "../src/sim/mech/model";
import type { M3, V3 } from "../src/sim/mech/solver";
import type { Orientation } from "../src/sim/worlds/types";

const G = 9.80665;
const D2R = Math.PI / 180;

const PHI = [45, 135, 225, 315];

/** the rig's parts: v2's, or the cheaper v3 set (MG90D servos, the Makerverse HX710 amplifier, a 1 kg beam cell, a 4S 1800 pack) */
interface RigParts {
  servo: string;
  amp: string;
  cell: string;
  battery: string;
  fuse: string;
  /** the fuse fitted in the holder, A (the holder's own when left out) */
  fuseRating?: number;
}
const V2_PARTS: RigParts = { servo: "savox_sh0264mg", amp: "hx711_breakout", cell: "tal221_500g", battery: "lipo_4s_5000_xt90", fuse: "fuse_holder_maxi" };
const V3_PARTS: RigParts = { servo: "mg90d", amp: "makerverse_load_cell_amp", cell: "beam_cell_1kg", battery: "lipo_4s_1800_xt60", fuse: "fuse_holder_atc" };

/** the rig's electronics, wired as the jet-vane design wires them */
function design(scenario: string, extra = "", imuAt = "at: (0, 60, 0)", parts: RigParts = V2_PARTS) {
  const servos = [1, 2, 3, 4].map((i) => `component s${i} = lib.servo("${parts.servo}") { at: (${i * 40}, 60, 100), axis: Z }`).join("\n");
  const ampVdd = catalogPart(parts.amp)!.pins.some((p) => p.id === "VDD") ? ", hx.VDD" : "";
  const sigs = ["D14", "D32", "D33", "D27"].map((p, i) => `wire fc.${p} -> s${i + 1}.SIG`).join("\n");
  return evaluate(
    `design "Jet vane rig"
component fc = lib.controller("feather_esp32_v2") { at: (0, 0, 0) }
component esc = lib.esc("skywalker_60a_v2") { at: (120, 0, 0) }
component edf = lib.bldc("xfly_edf_64_12b_3200kv") { at: (0, 0, 200), axis: Z }
component bat = lib.battery("${parts.battery}") { at: (250, 0, 0) }
component fuse = lib.fuse("${parts.fuse}") { at: (200, 60, 0)${parts.fuseRating ? `, rating: ${parts.fuseRating}A` : ""} }
component imu = lib.sensor("lsm6dsox_breakout") { ${imuAt} }
component hx = lib.sensor("${parts.amp}") { at: (0, -60, 0) }
component cell = lib.sensor("${parts.cell}") { at: (0, -120, 0) }
component estop = lib.switch("estop_jaycar_sp0786") { at: (300, 0, 0) }
${servos}
wire bat.POS -> fuse.IN { gauge: 10 }
wire fuse.OUT -> esc.B_PLUS { gauge: 10 }
net GND: bat.NEG, esc.B_MINUS, esc.BEC_GND, fc.GND, imu.GND, hx.GND, s1.GND, s2.GND, s3.GND, s4.GND, estop.NO_4
wire esc.PHASE_A -> edf.PHASE_A
wire esc.PHASE_B -> edf.PHASE_B
wire esc.PHASE_C -> edf.PHASE_C
net SERVO_5V: esc.BEC_5V, fc.V5, s1.V_PLUS, s2.V_PLUS, s3.V_PLUS, s4.V_PLUS
wire fc.A0 -> estop.NC_1
wire estop.NC_2 -> esc.SIG
wire fc.A1 -> estop.NO_3
${sigs}
wire fc.QT_3V -> imu.VIN
wire fc.SDA -> imu.SDA
wire fc.SCL -> imu.SCL
net LOGIC_3V: fc.V3, hx.VCC${ampVdd}
wire fc.A3 -> hx.DOUT
wire fc.A5 -> hx.SCK
wire hx.E_PLUS -> cell.EXC_P
wire hx.E_MINUS -> cell.EXC_N
wire hx.A_PLUS -> cell.SIG_P
wire hx.A_MINUS -> cell.SIG_N
firmware balance { board: fc, behaviour: "jet vane balance", i_roll: 0.00292, i_pitch: 0.0025, m_deg_mix_full: 0.00483, h_full: 0.063, vane_phi: "45, 135, 225, 315", cell_lever_mm: 69.2 ${extra} }
${scenario}`,
    { skipGeometry: true },
  );
}

const diag = (a: number, b = a, c = a): M3 => [a, 0, 0, 0, b, 0, 0, 0, c];
const body = (id: string, mass: number, com: V3, I: M3): MechBody => ({ id, label: id, parts: [], mass, com, inertia: I, points: [], boxes: [] });

/**
 * The gimbal as the design builds it: a ring on the post (roll, X) carrying the fan unit (pitch, Y), its
 * centre of mass 3.7 mm under the pivot, and four vanes 72 mm below the pivot in an X, each on a servo
 * turning about the hinge pointing in to the hub.
 */
function gimbal(opts: { lockRoll?: boolean; cell?: boolean } = {}): MechModel {
  const R = 0.024;
  const Lz = 0.0721;
  const vanes: MechVane[] = PHI.map((p, i) => {
    const c = Math.cos(p * D2R);
    const s = Math.sin(p * D2R);
    return { joint: `vane${i + 1}`, body: `vane${i + 1}`, cp: [R * c, R * s, -Lz], axis: [-c, -s, 0], area: 5.2e-4, cla: 1.48, ar: 1 };
  });
  return {
    bodies: [
      body("ring", 0.06, [0, 0, 0], diag(1.2e-4, 6e-5, 1.2e-4)),
      body("unit", 0.62, [0, 0, -0.0037], diag(0.0028, 0.0025, 0.0012)),
      ...vanes.map((v) => body(v.body, 0.004, v.cp, diag(3e-7))),
    ],
    joints: [
      { kind: opts.lockRoll ? "weld" : "pivot", name: "roll", body: "ring", on: FRAME, at: [0, 0, 0], axis: [1, 0, 0], friction: 0.002 },
      { kind: "pivot", name: "pitch", body: "unit", on: "ring", at: [0, 0, 0], axis: [0, 1, 0], friction: 0.002, limits: [-25 * D2R, 25 * D2R] },
      ...vanes.map((v) => ({ kind: "pivot" as const, name: v.joint, body: v.body, on: "unit", at: v.cp, axis: v.axis, friction: 0.0005 })),
    ],
    drives: vanes.map((v, i) => ({ kind: "servo" as const, joint: v.joint, comp: `s${i + 1}`, sign: 1, zero: 90 })),
    links: [],
    // the load cell link: from a lug 69.2 mm out on +X down to the bracket on the frame
    springs: opts.cell ? [{ name: "cell_link", a: "unit", b: FRAME, pa: [0.0692, 0, -0.01], pb: [0.0692, 0, -0.04], k: 15000, c: 20, free: 0.03, push: 0, cell: "cell" }] : [],
    loads: [],
    jets: [{ name: "jet", fan: "edf", body: "unit", at: [0, 0, 0.01], axis: [0, 0, 1], vanes, stall: 25 * D2R, recovery: 0.85 }],
    wheels: [],
    tracks: [],
    loose: [],
    ground: null,
    base: "fixed",
    gravity: [0, 0, -G],
    mounts: { imu: "unit", edf: "unit" },
    power: {},
    notes: [],
  };
}

describe("parts", () => {
  it("has the rig's parts in the catalogue with Australian shops to buy them from", () => {
    for (const id of ["feather_esp32_v2", "skywalker_60a_v2", "xfly_edf_64_12b_3200kv", "savox_sh0264mg", "lsm6dsox_breakout", "hx711_breakout", "tal221_500g", "estop_jaycar_sp0786", "fuse_holder_maxi", "xt90s_pair", "lipo_4s_5000_xt90", "mg90d", "makerverse_load_cell_amp", "beam_cell_1kg", "lipo_4s_1800_xt60"]) {
      const p = catalogPart(id);
      expect(p, id).toBeDefined();
      expect(p!.buy?.some((b) => b.url && /\.au\b|amazon\.com\.au/.test(b.url)), id).toBe(true);
    }
    expect(catalogPart("skywalker_60a_v2")!.kind).toBe("esc");
    expect(catalogPart("xfly_edf_64_12b_3200kv")!.geom?.g).toBe("edf");
  });
});

describe("devices", () => {
  const orient = (o: Partial<Orientation>): (() => Orientation) => () => ({ yaw: 0, pitch: 0, roll: 0, rate: [0, 0, 0], accel: [0, 0, 0], ...o });
  const read16 = (imu: Lsm6dsox, reg: number) => {
    imu.write([reg], 0);
    const [lo, hi] = imu.read(2);
    const v = lo | (hi << 8);
    return v >= 0x8000 ? v - 0x10000 : v;
  };

  it("the LSM6DSOX reads gravity and rates with the chip's own axes", () => {
    const fcpu = 240e6;
    const level = new Lsm6dsox("imu", fcpu, orient({}), { driftPerMin: 0, noise: 0 }, () => 0.5);
    level.write([0x0f], 0);
    expect(level.read(1)[0]).toBe(0x6c);
    level.write([0x10, 0x8a], 0);
    level.write([0x11, 0x88], 0);
    // ±4 g: 0.122 mg a count
    expect(read16(level, 0x2c) * 0.000122).toBeCloseTo(1, 2);
    expect(Math.abs(read16(level, 0x28) * 0.000122)).toBeLessThan(0.01);
    // nose up 10°: gravity's reaction leans toward +X; a nose-up turn is negative about Y
    const up = new Lsm6dsox("imu", fcpu, orient({ pitch: 10, rate: [0, 20, 0] }), { driftPerMin: 0, noise: 0 }, () => 0.5);
    up.write([0x10, 0x8a], 0);
    up.write([0x11, 0x88], 0);
    expect(read16(up, 0x28) * 0.000122).toBeCloseTo(Math.sin(10 * D2R), 2);
    expect(read16(up, 0x24) * 0.035).toBeCloseTo(-20, 0);
  });

  it("the ESC arms after a second and a half at minimum, spins the fan up and stops it when the signal goes", { timeout: 30_000 }, () => {
    const e = new EscFan("edf", catalogPart("skywalker_60a_v2")!, catalogPart("xfly_edf_64_12b_3200kv")!);
    const dt = 0.001;
    let t = 0;
    const run = (s: number, us: number | null, v = 16.2) => {
      for (let i = 0; i < s / dt; i++, t += dt) e.step(us, v, dt, t);
    };
    // full throttle at power-up: it never arms
    run(2, 2000);
    expect(e.armed).toBe(false);
    run(1.6, 1000);
    expect(e.armed).toBe(true);
    expect(e.armedAt).toBeCloseTo(3.5, 1);
    run(1.5, 2000);
    // about its rated 1250 g at full throttle, near its 40 A
    expect(e.thrust / G * 1000).toBeGreaterThan(1050);
    expect(e.thrust / G * 1000).toBeLessThan(1400);
    expect(e.motorCurrent).toBeGreaterThan(30);
    expect(e.motorCurrent).toBeLessThan(48);
    // spool-up takes a few tenths of a second, not an instant
    const e2 = new EscFan("edf", catalogPart("skywalker_60a_v2")!, catalogPart("xfly_edf_64_12b_3200kv")!);
    for (let i = 0; i < 1600; i++) e2.step(1000, 16.2, dt, i * dt);
    let k = 0;
    while (e2.thrust < 0.9 * e.thrust && k < 3000) e2.step(2000, 16.2, dt, 1.6 + k++ * dt);
    expect(k * dt).toBeGreaterThan(0.15);
    expect(k * dt).toBeLessThan(0.8);
    // signal gone: it holds for 250 ms, then stops the motor and needs minimum throttle again
    run(0.2, null);
    expect(e.armed).toBe(true);
    run(0.1, null);
    expect(e.armed).toBe(false);
    run(1, 2000);
    expect(e.armed).toBe(false);
    expect(e.omega).toBeLessThan(1500);
  });
});

describe("balance firmware", () => {
  const bench = design(`scenario "Spool up" {
  world: sim.bench()
  duration: 9s
  console: [sim.type("arm", at: 3s), sim.type("t 60", at: 3.2s)]
  faults: [sim.press(estop, at: 7s)]
}`);

  it("is generated from the wiring and compiles on the ESP32", { timeout: 30_000 }, () => {
    expect(bench.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const fw = generateFirmware(bench.machine!, bench.name)[0];
    expect(fw.summary).toMatch(/jet-vane balance/);
    const cfg = fw.files.find((f) => f.path.endsWith("config.h"))!.content;
    expect(cfg).toMatch(/#define PIN_VANE_1 14/);
    expect(cfg).toMatch(/#define PIN_ESC 26/);
    expect(cfg).toMatch(/#define PIN_ESTOP 25/);
    expect(cfg).toMatch(/#define PIN_HX_DOUT 39/);
    expect(cfg).toMatch(/#define PIN_HX_SCK 4/);
    const files = Object.fromEntries(fw.files.filter((f) => /\.(ino|h)$/.test(f.path)).map((f) => [f.path.split("/").pop()!, f.content]));
    const lf = loadFirmware(files, FEATHER_ESP32_V2, new SimHal(FEATHER_ESP32_V2, { seed: 1 }));
    expect(lf.staticRam).toBeLessThan(FEATHER_ESP32_V2.ramBytes / 10);
  });

  it("puts the console on Bluetooth serial as well as USB, so a free run has no cable on the gimbal", { timeout: 30_000 }, () => {
    const fw = generateFirmware(bench.machine!, bench.name)[0];
    const cfg = fw.files.find((f) => f.path.endsWith("config.h"))!.content;
    const ino = fw.files.find((f) => f.path.endsWith(".ino"))!.content;
    // the Feather V2 is a classic ESP32 with Bluetooth: the console is on both ports
    expect(cfg).toMatch(/#define BT_CONSOLE 1/);
    expect(cfg).toMatch(/#define BT_NAME "JetVane"/);
    expect(ino).toMatch(/#include <BluetoothSerial.h>/);
    expect(ino).toMatch(/SerialBT\.begin\(BT_NAME\)/);
    expect(ino).toMatch(/while \(SerialBT\.available\(\)\) feed\(SerialBT\.read\(\), now\)/);
    // every line the sketch prints goes through the two-port macros
    expect(ino.split("\n").filter((l) => /Serial\.print(ln)?\(/.test(l) && !/#define OUT/.test(l))).toEqual([]);
    expect(fw.files.find((f) => f.path.endsWith("README.md"))!.content).toMatch(/No cable on the gimbal/);
    // bt_console: 0 in the firmware block leaves it out
    const usbOnly = design(`scenario "Bench" { world: sim.bench() duration: 1s }`, ", bt_console: 0");
    expect(usbOnly.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const cfg2 = generateFirmware(usbOnly.machine!, usbOnly.name)[0].files.find((f) => f.path.endsWith("config.h"))!.content;
    expect(cfg2).toMatch(/#define BT_CONSOLE 0/);
  });

  it("sets the integral's limit from the vanes' own moment and reads the accelerometer at 8 g", () => {
    const fw = generateFirmware(bench.machine!, bench.name)[0];
    const cfg = fw.files.find((f) => f.path.endsWith("config.h"))!.content;
    const ino = fw.files.find((f) => f.path.endsWith(".ino"))!.content;
    expect(cfg).toMatch(/#define I_SHARE 0\.6f/);
    expect(cfg).toMatch(/#define REF_WN 14\.0f/);
    expect(cfg).not.toMatch(/I_TORQUE_MAX/);
    expect(ino).toMatch(/float tmax = I_SHARE \* 1\.414f \* VANE_MAX_DEG \* mDeg;/);
    // while the vanes are at their limit the integral may only unwind
    expect(ino).toMatch(/if \(saturated && err\[i\] \* integ\[i\] >= 0\) continue;/);
    expect(ino).toMatch(/imuWrite\(0x10, 0x8E\)/);
    expect(ino).toMatch(/0\.000244f/);
  });

  it("reads every ADC pin of the Feather, the battery monitor too", { timeout: 30_000 }, () => {
    const w = bench.scenarios![0].spec.world;
    if (w.kind !== "bench") throw new Error("not a bench");
    const hal = new SimHal(FEATHER_ESP32_V2, { seed: 1 });
    new Plant(bench.machine!, "fc", FEATHER_ESP32_V2, hal, new Bench(bench.machine!, w.bench, "expected"), { rng: () => 0.5 });
    hal.endCyc = Math.round(0.5 * FEATHER_ESP32_V2.fcpu);
    const sketch = `void setup() { Serial.begin(115200); }
void loop() {
  delay(200);
  Serial.print("batt ");
  Serial.println(analogReadMilliVolts(BATT_MONITOR) * 2);
  Serial.print("adc ");
  Serial.print(analogRead(32));
  Serial.print(" ");
  Serial.print(analogRead(33));
  Serial.print(" ");
  Serial.print(analogRead(37));
  Serial.print(" ");
  Serial.println(analogRead(A2));
}`;
    const fw = loadFirmware({ "t.ino": sketch }, FEATHER_ESP32_V2, hal).fw;
    hal.bindVectors(fw);
    fw.reset();
    try {
      fw.call("setup");
      for (;;) {
        const c0 = hal.cyc;
        fw.call("loop");
        if (hal.cyc - c0 < hal.stepCycles) hal.spend(hal.stepCycles - (hal.cyc - c0));
      }
    } catch (e) {
      if (!(e instanceof Halt)) throw e;
    }
    hal.finishSerial();
    expect(hal.faults).toEqual([]);
    const out = hal.serial.filter((l) => l.dir === "out").map((l) => l.text);
    // no cell on BAT and the board fed on its 5 V pin: the charger's output sits near 4.2 V
    const batt = Number(/batt (\d+)/.exec(out.join("\n"))?.[1]);
    expect(batt).toBeGreaterThan(4000);
    expect(batt).toBeLessThan(4400);
    expect(out.some((l) => /^adc \d+ \d+ \d+ \d+$/.test(l))).toBe(true);
    // GPIO5 (SCK) has no ADC channel
    hal.analogRead(5);
    expect(hal.faults.map((f) => f.msg).join()).toMatch(/GPIO5 is not an ADC pin/);
  });

  it("arms the ESC, spools the fan to the thrust asked for, and stops it when the e-stop is pressed", { timeout: 30_000 }, () => {
    const def = bench.scenarios![0];
    const v = runSpec({ ...def.spec, variants: ["expected"] }, bench.machine!, bench.name).variants[0];
    expect(v.error).toBeUndefined();
    const r = v.results;
    expect(r.faults).toBe(0);
    expect(r["esc.armed_at"]).toBeGreaterThan(1.4);
    expect(r["esc.armed_at"]).toBeLessThan(2.5);
    // 60 % of full static thrust: about 7 N
    expect(r["edf.peak_thrust"]).toBeGreaterThan(5.5);
    expect(r["edf.peak_thrust"]).toBeLessThan(9);
    expect(r["esc.peak_amps"]).toBeGreaterThan(5);
    expect(r.battery_peak_amps).toBeGreaterThan(5);
    // the NC contact cut the ESC's signal and the NO contact told the firmware
    expect(r["esc.signal_lost"]).toBe(true);
    expect(r.fault_noticed).toBe(true);
    expect(r.fault_reaction).toBeLessThan(0.05);
    expect(String(r.state)).toMatch(/fault \(e-stop pressed\)/);
    // two seconds on, the fan is windmilling down with no drive
    expect(r["edf.thrust"]).toBeLessThan(1);
    const amps = v.frames.series["esc.amps"];
    expect(amps[amps.length - 1]).toBeLessThan(0.2);
    // the battery carried the ESC: about 25 A at 60 % thrust, through the 50 A fuse without blowing it
    expect(r.battery_peak_amps).toBeLessThan(40);
    expect(r.fuse_blown).toBe(false);
  });

  it("holds the fan unit level on its gimbal against a knock, with the vanes", { timeout: 30_000 }, () => {
    const m = design(`scenario "Knock" {
  world: sim.bench()
  duration: 13s
  console: [sim.type("arm", at: 3s), sim.type("t 70", at: 3.1s), sim.type("hold", at: 3.2s)]
}`);
    const def = m.scenarios![0];
    const mech = gimbal();
    // a knock on the roll axis at 9 s: 60 N·mm for 0.15 s
    mech.drives.push({ kind: "force", name: "knock", joint: "roll", value: [[0, 0], [9, 0], [9.001, 0.06], [9.15, 0.06], [9.151, 0]] });
    const v = runSpec({ ...def.spec, mech, variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results.faults).toBe(0);
    const t = v.frames.t;
    const roll = v.frames.series["roll.angle"];
    const pitch = v.frames.series["pitch.angle"];
    const at = (s: number) => t.findIndex((x) => x >= s);
    // spooled up and holding: level before the knock
    expect(v.results["edf.peak_thrust"]).toBeGreaterThan(7);
    for (let i = at(8); i < at(9); i++) {
      expect(Math.abs(roll[i])).toBeLessThan(1.5);
      expect(Math.abs(pitch[i])).toBeLessThan(1.5);
    }
    // the knock tips it a few degrees and the vanes bring it back within a second and a half
    let worst = 0;
    for (let i = at(9); i < at(10.5); i++) worst = Math.max(worst, Math.abs(roll[i]));
    expect(worst).toBeGreaterThan(1);
    expect(worst).toBeLessThan(15);
    for (let i = at(11); i < t.length; i++) expect(Math.abs(roll[i])).toBeLessThan(1.5);
    // the vanes did it
    expect(v.results["jet.peak_vane_force"]).toBeGreaterThan(0.05);
    expect(String(v.results.state)).toMatch(/holding level/);
  });

  it("reads the IMU in the rig's axes when the board is mounted on its side", { timeout: 30_000 }, () => {
    // stood on a face looking out along -X: the chip's X runs up, its Z points out along -X
    const m = design(
      `scenario "Knock" {
  world: sim.bench()
  duration: 11s
  console: [sim.type("arm", at: 3s), sim.type("t 70", at: 3.1s), sim.type("hold", at: 3.2s)]
}`,
      "",
      "at: (-40, 0, 0), rotate: (0, -90, 0)",
    );
    expect(m.machine!.components.find((c) => c.name === "imu")!.axes).toEqual([
      [0, 0, 1],
      [0, 1, 0],
      [-1, 0, 0],
    ]);
    const cfg = generateFirmware(m.machine!, m.name)[0].files.find((f) => f.path.endsWith("config.h"))!.content;
    expect(cfg).toContain("#define IMU_R { { 0.0f, 0.0f, -1.0f }, { 0.0f, 1.0f, 0.0f }, { 1.0f, 0.0f, 0.0f } }");
    const mech = gimbal();
    mech.drives.push({ kind: "force", name: "knock", joint: "roll", value: [[0, 0], [9, 0], [9.001, 0.06], [9.15, 0.06], [9.151, 0]] });
    const v = runSpec({ ...m.scenarios![0].spec, mech, variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(v.error).toBeUndefined();
    const t = v.frames.t;
    const roll = v.frames.series["roll.angle"];
    const pitch = v.frames.series["pitch.angle"];
    const at = (s: number) => t.findIndex((x) => x >= s);
    for (let i = at(8); i < at(9); i++) {
      expect(Math.abs(roll[i])).toBeLessThan(1.5);
      expect(Math.abs(pitch[i])).toBeLessThan(1.5);
    }
    let worst = 0;
    for (let i = at(9); i < t.length; i++) worst = Math.max(worst, Math.abs(roll[i]));
    expect(worst).toBeLessThan(15);
    expect(Math.abs(roll[t.length - 1])).toBeLessThan(3);
  });

  it("measures the vane moment on the load cell in the static force test", { timeout: 30_000 }, () => {
    const m = design(`scenario "Force test" {
  world: sim.bench()
  duration: 20s
  console: [sim.type("tare", at: 2.9s), sim.type("arm", at: 3s), sim.type("t 70", at: 3.1s), sim.type("sweep", at: 6s)]
}`);
    const def = m.scenarios![0];
    const mech = gimbal({ lockRoll: true, cell: true });
    const v = runSpec({ ...def.spec, mech, variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(v.error).toBeUndefined();
    const line = v.serial.find((l) => /vane moment:/.test(l.text))?.text ?? "";
    const k = /set LIFT_K to ([\d.]+)/.exec(line);
    expect(line).toMatch(/mN m per deg/);
    // the sim's vanes are the design's prediction, so the test should find LIFT_K close to 1
    expect(Number(k?.[1])).toBeGreaterThan(0.75);
    expect(Number(k?.[1])).toBeLessThan(1.3);
    expect(v.results["cell.peak_force"]).toBeGreaterThan(0.2);
  });

  it("reads the same vane moment with the cheaper parts: MG90D servos, the HX710 amplifier and a 1 kg beam cell", { timeout: 30_000 }, () => {
    const m = design(
      `scenario "Force test" {
  world: sim.bench()
  duration: 20s
  console: [sim.type("tare", at: 2.9s), sim.type("arm", at: 3s), sim.type("t 70", at: 3.1s), sim.type("sweep", at: 6s)]
}`,
      "",
      "at: (0, 60, 0)",
      V3_PARTS,
    );
    const fw = generateFirmware(m.machine!, m.name)[0];
    expect((fw.warnings ?? []).join(" ")).not.toMatch(/HX711|load cell|servo/i);
    const config = fw.files.find((f) => f.path.endsWith("config.h"))!.content;
    // the MG90D moves about 90° on 1 to 2 ms, so about 11 µs a degree
    expect(config).toMatch(/#define SERVO_US_PER_DEG 11\.1/);
    const def = m.scenarios![0];
    const mech = gimbal({ lockRoll: true, cell: true });
    const v = runSpec({ ...def.spec, mech, variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(v.error).toBeUndefined();
    const line = v.serial.find((l) => /vane moment:/.test(l.text))?.text ?? "";
    const k = /set LIFT_K to ([\d.]+)/.exec(line);
    expect(Number(k?.[1])).toBeGreaterThan(0.75);
    expect(Number(k?.[1])).toBeLessThan(1.3);
    expect(v.results["cell.peak_force"]).toBeGreaterThan(0.2);
  });

  it("measures the rotor's momentum and its direction in the coupling test", { timeout: 30_000 }, () => {
    // ROTOR_DIR set the wrong way round: the test must catch it
    const m = design(
      `scenario "Coupling test" {
  world: sim.bench()
  duration: 19.5s
  console: [sim.type("tare", at: 2.9s), sim.type("arm", at: 3s), sim.type("t 70", at: 3.1s), sim.type("couple", at: 6s)]
}`,
      ", rotor_dir: -1",
    );
    const v = runSpec({ ...m.scenarios![0].spec, mech: gimbal({ cell: true }), variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results.faults).toBe(0);
    const text = v.serial.map((l) => l.text).join("\n");
    expect(text).toMatch(/coupling: pitch nudge \+4 deg reads/);
    const h = /rotor momentum: (-?[\d.]+) mN m s at 70 % thrust, predicted (-?[\d.]+) \(fit r2 ([\d.]+)\)/.exec(text);
    expect(h).not.toBeNull();
    const [meas, pred, r2] = [Number(h![1]), Number(h![2]), Number(h![3])];
    // the sim's rotor is the design's, so the measured momentum is the predicted one, the other sign
    expect(meas * pred).toBeLessThan(0);
    expect(Math.abs(meas) / Math.abs(pred)).toBeGreaterThan(0.75);
    expect(Math.abs(meas) / Math.abs(pred)).toBeLessThan(1.3);
    expect(r2).toBeGreaterThan(0.8);
    expect(text).toMatch(/the rotor turns the other way: rotor 1, then save/);
    // the fan goes back to 0 at the end, and winds down
    expect(text).toMatch(/fan back to 0/);
    expect(v.results["edf.thrust"]).toBeLessThan(1);
  });

  it("prints the step response while holding, with gyro rates and the load cell in the log", { timeout: 30_000 }, () => {
    const m = design(`scenario "Steps" {
  world: sim.bench()
  duration: 13s
  console: [sim.type("arm", at: 3s), sim.type("t 70", at: 3.1s), sim.type("hold", at: 3.2s), sim.type("step roll 5", at: 7s), sim.type("step pitch -5", at: 10s)]
}`);
    const v = runSpec({ ...m.scenarios![0].spec, mech: gimbal(), variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results.faults).toBe(0);
    const lines = v.serial.map((l) => l.text);
    for (const [axis, deg] of [
      ["roll", "5.0"],
      ["pitch", "-5.0"],
    ]) {
      const l = lines.find((x) => x.startsWith(`step ${axis} ${deg} deg:`)) ?? "";
      const r = /rise ([\d.]+) s, overshoot (\d+) %, within 10 % after ([\d.]+) s, error (-?[\d.]+) deg/.exec(l);
      expect(r, l).not.toBeNull();
      expect(Number(r![1])).toBeLessThan(0.6);
      // the set point moves along a critically damped path that is fed forward: the unit follows it without overshooting
      expect(Number(r![2])).toBeLessThan(10);
      expect(Number(r![3])).toBeLessThan(1);
      expect(Math.abs(Number(r![4]))).toBeLessThan(0.5);
    }
    // the log ran through each step: roll, pitch, gx, gy, four vanes, thrust, cell
    expect(lines.some((l) => l.startsWith("log: roll, pitch"))).toBe(true);
    const rows = lines.filter((l) => /^-?[\d.]+(,-?[\d.]+){9}$/.test(l)).map((l) => l.split(",").map(Number));
    expect(rows.length).toBeGreaterThan(150);
    // the roll step shows in the roll rate column
    expect(Math.max(...rows.map((r) => Math.abs(r[2])))).toBeGreaterThan(5);
    expect(rows.every((r) => r[8] === 70)).toBe(true);
  });

  it("cuts the fan when the IMU stops answering", { timeout: 30_000 }, () => {
    const m = design(`scenario "IMU unplugged" {
  world: sim.bench()
  duration: 9s
  console: [sim.type("arm", at: 3s), sim.type("t 60", at: 3.1s), sim.type("hold", at: 3.2s)]
  faults: [sim.unplug(imu, at: 7s)]
}`);
    const def = m.scenarios![0];
    const v = runSpec({ ...def.spec, mech: gimbal(), variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(String(v.results.state)).toMatch(/IMU stopped answering/);
    expect(v.results.fault_reaction).toBeLessThan(0.1);
    expect(v.results["edf.thrust"]).toBeLessThan(0.5);
  });

  it("cuts the fan when the IMU freezes: its registers stop changing, noise and all", { timeout: 30_000 }, () => {
    const m = design(`scenario "IMU freezes" {
  world: sim.bench()
  duration: 9s
  console: [sim.type("arm", at: 3s), sim.type("t 60", at: 3.1s), sim.type("hold", at: 3.2s)]
  faults: [sim.stuck(imu, at: 7s)]
}`);
    const def = m.scenarios![0];
    const v = runSpec({ ...def.spec, mech: gimbal(), variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(String(v.results.state)).toMatch(/IMU frozen/);
    expect(v.results.fault_reaction).toBeLessThan(0.2);
    // the drive is cut for good while the rotor is still coasting down
    expect(v.results.fault_cut).toBe(true);
    expect(v.results.fault_cut_time).toBeLessThan(0.2);
    expect(v.results.fault_stopped).toBe(false);
  });

  it("stops the fan when the pendant's plug is pulled: the throttle signal ran through its NC contact", { timeout: 30_000 }, () => {
    const m = design(`scenario "Pendant unplugged" {
  world: sim.bench()
  duration: 9s
  console: [sim.type("arm", at: 3s), sim.type("t 60", at: 3.1s)]
  faults: [sim.unplug(estop, at: 6s)]
}`);
    const def = m.scenarios![0];
    const v = runSpec({ ...def.spec, variants: ["expected"] }, m.machine!, m.name).variants[0];
    expect(v.notes.join(" ")).not.toMatch(/cannot simulate/);
    expect(v.results["esc.signal_lost"]).toBe(true);
    expect(v.results["edf.thrust"]).toBeLessThan(1);
    expect(v.results.fault_cut).toBe(true);
  });

  it("blows the fuse the design fits, not the holder's own", () => {
    const rating = (fuseRating?: number) => {
      const m = design(`scenario "Bench" { world: sim.bench() duration: 1s }`, "", undefined, { ...V3_PARTS, fuseRating });
      const w = m.scenarios![0].spec.world;
      if (w.kind !== "bench") throw new Error("not a bench");
      const plant = new Plant(m.machine!, "fc", FEATHER_ESP32_V2, new SimHal(FEATHER_ESP32_V2, { seed: 1 }), new Bench(m.machine!, w.bench, "expected"), { rng: () => 0.5 });
      return plant.fuses.map((f) => f.rating);
    };
    // the ATC holder comes with a 20 A fuse
    expect(rating()).toEqual([20]);
    expect(rating(40)).toEqual([40]);
  });
});
