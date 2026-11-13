// The jet-vane rig wired the plug-together way: a PCA9685 servo board making
// every pulse over I2C, an NAU7802 load cell board, the e-stop in the servo
// board's logic supply, the firmware timing the board's clock through one
// jumper, and a third axis (the unit turning about its own jet).

import { describe, expect, it } from "vitest";
import { catalogPart } from "../src/machine/catalog";
import { generateFirmware } from "../src/machine/firmware";
import { evaluate } from "../src/lang/evaluator";
import { Nau7802, Pca9685 } from "../src/sim/engine/devices";
import { SimHal } from "../src/sim/engine/hal";
import { FEATHER_ESP32_V2, loadFirmware } from "../src/sim/mcu";
import { runSpec } from "../src/sim/build";
import { FRAME, type MechBody, type MechModel, type MechVane } from "../src/sim/mech/model";
import type { M3, V3 } from "../src/sim/mech/solver";

const G = 9.80665;
const D2R = Math.PI / 180;
const PHI = [45, 135, 225, 315];
const FCPU = 240e6;
const ms = (x: number) => (x * FCPU) / 1000;

/** the rig's numbers for the firmware block: two axes, and the heading's */
const FW2 = `i_roll: 0.00448, i_pitch: 0.00381, m_deg_mix_full: 0.0054687, h_full: 0.04765, thrust_cap: 0.5, vane_phi: "45, 135, 225, 315", cell_lever_mm: 69.2, pend_roll: 0.0368, pend_pitch: 0.0368`;
const FW3 = `${FW2}, i_yaw: 0.0022, m_deg_yaw_full: 0.002595`;

/** the rig's electronics, every joint a plug or a lever connector */
function design(scenario: string, opts: { fw?: string; osc?: number; sense?: boolean; estop?: boolean } = {}) {
  const servos = [1, 2, 3, 4].map((i) => `component s${i} = lib.servo("mg90d") { at: (${i * 40}, 60, 100), axis: Z }\nwire s${i}.LEAD -> hub.CH${i - 1}`).join("\n");
  // the servo board's logic supply: out through the e-stop's normally-closed contact and back
  const vcc =
    opts.estop === false
      ? `wire nau.QT2_V -> hub.VCC { gauge: 28, color: "red" }`
      : `wire nau.QT2_V -> wago_a.A { gauge: 28, color: "red" }
wire wago_a.B -> estop.NC_1 { gauge: 22, color: "red" }
wire estop.NC_2 -> wago_b.A { gauge: 22, color: "red" }
wire wago_b.B -> hub.VCC { gauge: 28, color: "red" }`;
  return evaluate(
    `design "Jet vane rig"
component fc = lib.controller("feather_esp32_v2") { at: (0, 0, 0) }
component imu = lib.sensor("lsm6dsox_breakout") { at: (50, 0, 5), axis: Z }
component nau = lib.sensor("nau7802_breakout") { at: (90, 0, 5), axis: Z }
component hub = lib.motor_driver("pca9685_servo_16") { at: (40, 50, 5), axis: Z${opts.osc ? `, measured: sim.measured(osc: ${opts.osc})` : ""} }
component esc = lib.esc("skywalker_60a_v2") { at: (0, -60, 2), axis: Z }
component bat = lib.battery("lipo_6s_1300_xt60") { at: (-110, -60, 2), axis: Z }
component xt60 = lib.connector("xt60_pigtail") { at: (-60, -90, 2), axis: Z }
component wago_p1 = lib.connector("wago_221_612") { at: (-60, -30, 2), axis: Z }
component wago_p2 = lib.connector("wago_221_612") { at: (-40, -30, 2), axis: Z }
component wago_n = lib.connector("wago_221_612") { at: (-20, -30, 2), axis: Z }
component wago_a = lib.connector("wago_221_412") { at: (120, 30, 2), axis: Z }
component wago_b = lib.connector("wago_221_412") { at: (135, 30, 2), axis: Z }
component fuse = lib.fuse("fuse_holder_maxi") { at: (-90, -20, 2), axis: Z, rating: 40A }
component estop = lib.switch("estop_jaycar_sp0786") { at: (130, -60, 40), axis: Z }
component cell = lib.sensor("beam_cell_1kg") { at: (100, -40, 10), axis: Z }
component edf = lib.bldc("fms_edf_70_12b_3060_1900kv") { at: (60, -90, 60), axis: Z }
${servos}
wire bat.LEAD -> xt60.PLUG
wire xt60.POS_B -> wago_p1.A
wire wago_p1.B -> fuse.IN
wire fuse.OUT -> wago_p2.A
wire wago_p2.B -> esc.B_PLUS
wire xt60.NEG_B -> wago_n.A
wire wago_n.B -> esc.B_MINUS
wire esc.MOTOR -> edf.LEADS
wire esc.SIGNAL -> hub.CH4
wire fc.QT -> imu.QT1 { cable: "STEMMA QT cable, 50 mm", length: 50 }
wire imu.QT2 -> nau.QT1 { cable: "STEMMA QT cable, 100 mm", length: 100 }
wire nau.QT2_GND -> hub.GND { gauge: 28, color: "black" }
wire nau.QT2_SCL -> hub.SCL { gauge: 28, color: "yellow" }
wire nau.QT2_SDA -> hub.SDA { gauge: 28, color: "blue" }
${vcc}
wire hub.POWER -> fc.USB { cable: "USB-C plug to bare leads, 30 cm", length: 300 }
wire cell.LEAD -> nau.CELL
${opts.sense === false ? "" : `wire hub.P15 -> fc.D14 { gauge: 26, color: "white" }`}
firmware balance { board: fc, behaviour: "jet vane balance", ${opts.fw ?? FW3} }
${scenario}`,
    { skipGeometry: true },
  );
}

const diag = (a: number, b = a, c = a): M3 => [a, 0, 0, 0, b, 0, 0, 0, c];
const body = (id: string, mass: number, com: V3, I: M3): MechBody => ({ id, label: id, parts: [], mass, com, inertia: I, points: [], boxes: [] });

/**
 * Three axes: a ring on the frame (roll, X), an arch in the ring (pitch, Y) and the fan unit hung in the arch
 * on its own jet's axis (yaw, Z), with the battery and the electronics riding on it; four vanes below.
 */
function gimbal3(opts: { lockRoll?: boolean; lockYaw?: boolean; cell?: boolean } = {}): MechModel {
  const R = 0.01977;
  const Lz = 0.08334;
  const vanes: MechVane[] = PHI.map((p, i) => {
    const c = Math.cos(p * D2R);
    const s = Math.sin(p * D2R);
    return { joint: `vane${i + 1}`, body: `vane${i + 1}`, cp: [R * c, R * s, -Lz], axis: [-c, -s, 0], area: 5.265e-4, cla: 1.4833, ar: 1 };
  });
  return {
    bodies: [
      body("ring", 0.07, [0, 0, 0], diag(1.6e-4, 8e-5, 1.6e-4)),
      body("arch", 0.06, [0, 0, 0.03], diag(1.2e-4, 1.5e-4, 6e-5)),
      body("unit", 1.25, [0, 0, -0.003], diag(0.0042, 0.0036, 0.0022)),
      ...vanes.map((v) => body(v.body, 0.004, v.cp, diag(3e-7))),
    ],
    joints: [
      { kind: opts.lockRoll ? "weld" : "pivot", name: "roll", body: "ring", on: FRAME, at: [0, 0, 0], axis: [1, 0, 0], friction: 0.002, limits: [-25 * D2R, 25 * D2R] },
      { kind: "pivot", name: "pitch", body: "arch", on: "ring", at: [0, 0, 0], axis: [0, 1, 0], friction: 0.002, limits: [-25 * D2R, 25 * D2R] },
      { kind: opts.lockYaw ? "weld" : "pivot", name: "yaw", body: "unit", on: "arch", at: [0, 0, 0.08], axis: [0, 0, 1], friction: 0.001, limits: [-45 * D2R, 45 * D2R] },
      ...vanes.map((v) => ({ kind: "pivot" as const, name: v.joint, body: v.body, on: "unit", at: v.cp, axis: v.axis, friction: 0.0005 })),
    ],
    drives: vanes.map((v, i) => ({ kind: "servo" as const, joint: v.joint, comp: `s${i + 1}`, sign: 1, zero: 90 })),
    links: [],
    springs: opts.cell ? [{ name: "cell_link", a: "unit", b: "ring", pa: [0.0692, 0, -0.01], pb: [0.0692, 0, -0.04], k: 15000, c: 20, free: 0.03, push: 0, cell: "cell" }] : [],
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

const run = (m: ReturnType<typeof design>, mech: MechModel) => {
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const v = runSpec({ ...m.scenarios![0].spec, mech, variants: ["expected"] }, m.machine!, m.name).variants[0];
  expect(v.error).toBeUndefined();
  return v;
};
const said = (v: { serial: { dir: string; text: string; t: number }[] }, re: RegExp) => v.serial.find((l) => l.dir === "out" && re.test(l.text));

describe("servo board (PCA9685)", () => {
  const part = catalogPart("pca9685_servo_16")!;
  const reg = (chip: Pca9685, r: number) => {
    chip.write([r], 0);
    return chip.read(1)[0];
  };

  it("wakes asleep with every output off, takes a frame rate only while asleep, and gives the pulse its registers say", () => {
    const chip = new Pca9685("hub", FCPU, part);
    chip.power(3.3, true);
    expect(reg(chip, 0x00)).toBe(0x11);
    expect(reg(chip, 0xfe)).toBe(0x1e);
    expect(reg(chip, 0x09)).toBe(0x10);
    expect(chip.asleep()).toBe(true);
    // awake: the prescaler does not take a value
    chip.write([0x00, 0x20], 0);
    chip.write([0xfe, 121], 0);
    expect(reg(chip, 0xfe)).toBe(0x1e);
    // asleep it does: 121 is 50 Hz, 30 is 197 Hz
    chip.write([0x00, 0x30], 0);
    chip.write([0xfe, 121], 0);
    expect(chip.hz()).toBeCloseTo(50.03, 1);
    chip.write([0xfe, 30], 0);
    expect(chip.hz()).toBeCloseTo(196.9, 1);
    chip.write([0x00, 0x20], ms(1));
    // channel 3 on at count 0 and off at 1210: 1210 x 31 / 25 MHz
    chip.write([0x06 + 4 * 3, 0, 0, 1210 & 0xff, 1210 >> 8], ms(1));
    // nothing until its oscillator has started and a frame has ended
    chip.tick(ms(1.2));
    expect(chip.pulseUs(3)).toBeNull();
    chip.tick(ms(8));
    expect(chip.pulseUs(3)).toBeCloseTo(1500.4, 1);
    expect(chip.pulseUs(0)).toBeNull();
    // the all-channel register turns every output off at once
    chip.write([0xfd, 0x10], ms(9));
    chip.tick(ms(15));
    expect(chip.pulseUs(3)).toBeNull();
  });

  it("is out by its oscillator's error on every pulse, and shows a pin wired to an output each edge", () => {
    const fast = new Pca9685("hub", FCPU, { ...part, specs: { ...part.specs, osc_mhz: 27 } });
    fast.power(3.3, true);
    fast.write([0x00, 0x30], 0);
    fast.write([0xfe, 30], 0);
    fast.write([0x00, 0x20], 0);
    fast.write([0x06 + 4 * 3, 0, 0, 1210 & 0xff, 1210 >> 8], 0);
    // channel 15: high for half of each frame
    fast.write([0x06 + 4 * 15, 0, 0, 0, 0x08], 0);
    fast.tick(ms(8));
    expect(fast.pulseUs(3)).toBeCloseTo((1210 * 31) / 27, 1);
    expect(fast.held(3)).toBe(-1);
    expect(fast.held(0)).toBe(0);
    const edges = fast.edges(15, ms(8), ms(20));
    const up = edges.find((e) => e[1] === 1)!;
    const down = edges.find((e) => e[1] === 0 && e[0] > up[0])!;
    // 2048 counts of 31 / 27 MHz each
    expect(((down[0] - up[0]) / FCPU) * 1e6).toBeCloseTo((2048 * 31) / 27, 0);
    const next = edges.find((e) => e[1] === 1 && e[0] > up[0])!;
    expect(((next[0] - up[0]) / FCPU) * 1e6).toBeCloseTo((4096 * 31) / 27, 0);
  });

  it("loses its settings when its supply is cut: asleep and still answering while the bus has power, dead without", () => {
    const chip = new Pca9685("hub", FCPU, part);
    chip.power(3.3, true);
    chip.write([0x00, 0x30], 0);
    chip.write([0xfe, 30], 0);
    chip.write([0x00, 0x20], 0);
    chip.write([0x06, 0, 0, 0xb9, 0x04], 0);
    chip.tick(ms(8));
    expect(chip.pulseUs(0)).toBeGreaterThan(1400);
    chip.power(0, true);
    chip.tick(ms(9));
    expect(chip.pulseUs(0)).toBeNull();
    expect(chip.ready()).toBe(true);
    expect(reg(chip, 0x00)).toBe(0x11);
    expect(chip.resets).toBe(1);
    // the pull-ups cannot run its oscillator: waking it just resets it again
    chip.write([0x00, 0x20], ms(10));
    expect(chip.asleep()).toBe(true);
    chip.power(0, false);
    expect(chip.ready()).toBe(false);
  });
});

describe("load cell board (NAU7802)", () => {
  it("converts once it is powered up and started, and reads the bridge at its gain", () => {
    const adc = new Nau7802("nau", FCPU, () => 0.5e-3, 0, () => 0.5);
    const reg = (r: number, t: number) => {
      adc.write([r], t);
      return adc.read(1, t)[0];
    };
    adc.tick(0, true);
    expect(reg(0x1f, 0)).toBe(0x0f);
    adc.write([0x00, 0x01], 0);
    adc.write([0x00, 0x02], 0);
    // powered up 200 µs after the digital side is switched on
    expect(reg(0x00, ms(0.1)) & 0x08).toBe(0);
    expect(reg(0x00, ms(1)) & 0x08).toBe(0x08);
    adc.write([0x00, 0x86], ms(1));
    adc.write([0x01, 0x2f], ms(1));
    adc.write([0x02, 0x30], ms(1));
    // not started: no samples
    for (let t = 1; t < 100; t++) adc.tick(ms(t), true);
    expect(adc.samples).toBe(0);
    adc.write([0x00, 0x96], ms(100));
    // four conversions to settle, then one every 12.5 ms
    for (let t = 100; t < 140; t++) adc.tick(ms(t), true);
    expect(adc.samples).toBe(0);
    expect(reg(0x00, ms(140)) & 0x20).toBe(0);
    for (let t = 140; t < 300; t++) adc.tick(ms(t), true);
    expect(adc.samples).toBeGreaterThan(10);
    expect(adc.samples).toBeLessThan(14);
    expect(reg(0x00, ms(300)) & 0x20).toBe(0x20);
    adc.write([0x12], ms(300));
    const [a, b, c] = adc.read(3, ms(300));
    // 0.5 mV/V at gain 128 of 2^24
    expect((a << 16) | (b << 8) | c).toBe(Math.round(0.5e-3 * 128 * 2 ** 24));
    // read: the ready flag falls until the next sample
    expect(reg(0x00, ms(300)) & 0x20).toBe(0);
    // its supply gone, its settings go with it
    adc.tick(ms(301), false);
    adc.tick(ms(302), true);
    expect(reg(0x00, ms(302)) & 0x16).toBe(0);
  });
});

describe("balance firmware through the servo board", () => {
  const bench = design(`scenario "Spool up" {
  world: sim.bench()
  duration: 14s
  console: [sim.type("arm", at: 3s), sim.type("t 60", at: 3.2s), sim.type("reset", at: 9s), sim.type("arm", at: 11.7s), sim.type("t 30", at: 12s)]
  faults: [sim.press(estop, at: 7s, until: 8s)]
}`);

  it("is generated from the plug-together wiring and compiles with no servo library", { timeout: 30_000 }, () => {
    expect(bench.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const fw = generateFirmware(bench.machine!, bench.name)[0];
    expect(fw.warnings).toEqual([]);
    expect(fw.summary).toMatch(/heading hold on the third axis, pulses through hub/);
    const file = (end: string) => fw.files.find((f) => f.path.endsWith(end))!.content;
    const cfg = file("config.h");
    expect(cfg).toMatch(/#define HUB_ADDR 0x40/);
    for (let i = 0; i < 4; i++) expect(cfg).toContain(`#define HUB_CH_VANE_${i + 1} ${i}`);
    expect(cfg).toMatch(/#define HUB_CH_ESC 4/);
    expect(cfg).toMatch(/#define HUB_CH_SENSE 15/);
    expect(cfg).toMatch(/#define PIN_HUB_SENSE 14/);
    expect(cfg).toMatch(/#define CELL_ADDR 0x2A/);
    expect(cfg).not.toMatch(/PIN_VANE_1|PIN_ESC |PIN_HX_/);
    // one frame rate for every output, and the ESC's range as it leaves the factory with the stop pulse under it
    expect(cfg).toMatch(/#define SERVO_HZ 200/);
    expect(cfg).toMatch(/#define ESC_HZ SERVO_HZ/);
    expect(cfg).toMatch(/#define ESC_MIN_US 1100/);
    expect(cfg).toMatch(/#define ESC_MAX_US 1940/);
    expect(cfg).toMatch(/#define ESC_STOP_US 1000/);
    expect(cfg).toMatch(/#define I_YAW 0\.0022f/);
    const ino = file(".ino");
    expect(ino).not.toMatch(/ESP32Servo|Servo vane1/);
    expect(ino).toMatch(/bool estopPressed\(\) \{ return !hubUp \|\|/);
    // the pin table says what each thing plugs into
    expect(fw.pinTable.find((p) => p.signal === "vane 2 servo")).toMatchObject({ pin: "hub channel 1", wire: "s2.SIG" });
    expect(fw.pinTable.find((p) => p.signal === "ESC signal")).toMatchObject({ pin: "hub channel 4" });
    expect(fw.pinTable.find((p) => /^e-stop/.test(p.signal))).toMatchObject({ pin: "hub VCC", wire: "estop NC contact" });
    expect(file("README.md")).toMatch(/times it against its own crystal/);
    const files = Object.fromEntries(fw.files.filter((f) => /\.(ino|h)$/.test(f.path)).map((f) => [f.path.split("/").pop()!, f.content]));
    const lf = loadFirmware(files, FEATHER_ESP32_V2, new SimHal(FEATHER_ESP32_V2, { seed: 1 }));
    expect(lf.staticRam).toBeLessThan(FEATHER_ESP32_V2.ramBytes / 10);
  });

  it("warns when nothing can stop the pulses or time the board's clock", () => {
    const bare = design(`scenario "Bench" { world: sim.bench() duration: 1s }`, { estop: false, sense: false, fw: FW2 });
    const fw = generateFirmware(bare.machine!, bare.name)[0];
    expect(fw.warnings.join("\n")).toMatch(/No e-stop: put a switch's normally-closed contact in hub's VCC wire/);
    expect(fw.warnings.join("\n")).toMatch(/hub's own clock can be 8 % out/);
    const cfg = fw.files.find((f) => f.path.endsWith("config.h"))!.content;
    expect(cfg).toMatch(/#define PIN_HUB_SENSE -1/);
    expect(cfg).not.toMatch(/I_YAW/);
    expect(fw.summary).not.toMatch(/third axis/);
  });

  it("arms the ESC through the board, sees the e-stop as the board losing its settings, and comes back on reset", { timeout: 60_000 }, () => {
    const v = run(bench, gimbal3({ lockRoll: true, lockYaw: true }));
    const r = v.results;
    expect(r.faults).toBe(0);
    // the stop pulse reaches the ESC as soon as the board is up, well before the console
    expect(r["esc.armed_at"]).toBeGreaterThan(1.4);
    expect(r["esc.armed_at"]).toBeLessThan(1.8);
    expect(r["hub.frame_hz"]).toBeCloseTo(196.9, 0);
    // 60 % of the rig's 12.3 N
    expect(r["edf.peak_thrust"]).toBeGreaterThan(6.5);
    expect(r["edf.peak_thrust"]).toBeLessThan(9.5);
    // pressed at 7 s: the board's supply is cut, its pulses end, and the ESC stops the fan by itself
    expect(r.fault_noticed).toBe(true);
    expect(r.fault_reaction).toBeLessThan(0.02);
    expect(r["hub.resets"]).toBe(1);
    expect(said(v, /^FAULT: e-stop pressed or servo board unplugged/)!.t).toBeLessThan(7.02);
    expect(v.events.some((e) => e.t > 7.2 && e.t < 7.3 && /lost its signal/.test(e.text))).toBe(true);
    const t = v.frames.t;
    const thrust = v.frames.series["edf.thrust"];
    const at = (s: number) => t.findIndex((x) => x >= s);
    expect(thrust[at(6.9)]).toBeGreaterThan(6.5);
    expect(thrust[at(8.9)]).toBeLessThan(0.5);
    // released, reset: the board is set up again, the ESC arms again and the fan runs
    expect(v.events.filter((e) => /edf armed/.test(e.text)).length).toBe(2);
    expect(String(r.state)).toBe("armed");
    expect(r["edf.thrust"]).toBeGreaterThan(3);
    expect(r["edf.thrust"]).toBeLessThan(5.5);
  });

  it("stops the fan when the board's data wire comes off, by switching its supply", { timeout: 60_000 }, () => {
    const m = design(`scenario "Data wire off" {
  world: sim.bench()
  duration: 10s
  console: [sim.type("arm", at: 3s), sim.type("t 50", at: 3.1s)]
  faults: [sim.loose("hub.SDA", at: 7s)]
}`);
    const v = run(m, gimbal3({ lockRoll: true, lockYaw: true }));
    // the board would go on sending its last pulses; with its supply switched off for a moment it cannot
    expect(v.results.fault_reaction).toBeLessThan(0.02);
    expect(v.results.fault_cut).toBe(true);
    expect(v.results.fault_cut_time).toBeLessThan(0.35);
    expect(v.results["esc.signal_lost"]).toBe(true);
    expect(v.results["edf.thrust"]).toBeLessThan(0.5);
    expect(String(v.results.state)).toMatch(/fault \(e-stop pressed or servo board unplugged\)/);
  });

  it("times the board's clock on the jumper, so a chip 8 % out still gives the pulses asked for", { timeout: 60_000 }, () => {
    const sc = `scenario "Spool up" {
  world: sim.bench()
  duration: 7s
  console: [sim.type("arm", at: 3s), sim.type("t 50", at: 3.2s), sim.type("show", at: 6.9s)]
}`;
    const mech = () => gimbal3({ lockRoll: true, lockYaw: true });
    const fast = run(design(sc, { osc: 27 }), mech());
    expect(said(fast, /^servo board clock 26\.9\d+ MHz \(timed\)/)).toBeDefined();
    expect(fast.results["hub.frame_hz"]).toBeCloseTo(212.6, 0);
    // half the rig's 12.3 N, as with a chip that is spot on
    expect(fast.results["edf.thrust"]).toBeGreaterThan(6.6);
    expect(fast.results["edf.thrust"]).toBeLessThan(7.7);
    expect(fast.events.find((e) => /edf armed/.test(e.text))!.text).toMatch(/signal at (999|1000|1001) µs/);
    // without the jumper the same chip runs every pulse 7 % short: the firmware says it has not timed it
    const blind = run(design(sc, { osc: 27, sense: false }), mech());
    expect(said(blind, /^servo board clock 25\.000 MHz \(not timed/)).toBeDefined();
    expect(blind.results["edf.thrust"]).toBeLessThan(0.75 * (fast.results["edf.thrust"] as number));
  });

  it("holds level and holds its heading on the third axis, turns to a new one, and takes a knock", { timeout: 90_000 }, () => {
    const m = design(`scenario "Three axes" {
  world: sim.bench()
  duration: 19s
  console: [sim.type("arm", at: 3s), sim.type("t 50", at: 3.1s), sim.type("hold", at: 5s), sim.type("t 70", at: 8s), sim.type("yaw 30", at: 11s), sim.type("show", at: 18.9s)]
}`);
    const mech = gimbal3();
    // a knock on the roll axis at 15 s: 60 N·mm for 0.15 s
    mech.drives.push({ kind: "force", name: "knock", joint: "roll", value: [[0, 0], [15, 0], [15.001, 0.06], [15.15, 0.06], [15.151, 0]] });
    const v = run(m, mech);
    expect(v.results.faults).toBe(0);
    expect(String(v.results.state)).toMatch(/holding level/);
    const t = v.frames.t;
    const s = v.frames.series;
    const at = (x: number) => t.findIndex((y) => y >= x);
    const worst = (name: string, from: number, to: number) => {
      let w = 0;
      for (let i = at(from); i < at(to); i++) w = Math.max(w, Math.abs(s[name][i]));
      return w;
    };
    // the fan's start-up twists the free unit round onto its stop; holding walks it back to the middle
    expect(s["yaw.angle"][at(4.9)]).toBeLessThan(-40);
    expect(worst("yaw.angle", 7.5, 11)).toBeLessThan(2);
    // level all the way through, the climb to 70 % and the turn included
    expect(worst("roll.angle", 5.5, 15)).toBeLessThan(1);
    expect(worst("pitch.angle", 5.5, 15)).toBeLessThan(1);
    // turned to 30° and held there
    for (let i = at(13.5); i < t.length; i++) expect(Math.abs(s["yaw.angle"][i] - 30)).toBeLessThan(2);
    // the knock tips it a few degrees and it comes back
    expect(worst("roll.angle", 15, 16)).toBeGreaterThan(1);
    expect(worst("roll.angle", 15, 16)).toBeLessThan(12);
    expect(worst("roll.angle", 17, 19)).toBeLessThan(1.5);
    // what holds off the jet's swirl is a steady angle on all four vanes, and the loop found it
    const trim = Number(/heading trim (-?[\d.]+) deg/.exec(said(v, /^heading trim/)!.text)![1]);
    expect(trim).toBeGreaterThan(2.5);
    expect(trim).toBeLessThan(7.5);
    expect(v.results["jet.stall_time"]).toBe(0);
  });

  it("takes its heading from the home stop when the loop first closes, wherever the unit sat at arming", { timeout: 120_000 }, () => {
    const m = design(
      `scenario "Home stop" {
  world: sim.bench()
  duration: 12s
  console: [sim.type("arm", at: 3s), sim.type("t 50", at: 3.1s), sim.type("hold", at: 3.2s)]
}`,
      { fw: `${FW3}, yaw_home: -45` },
    );
    // parked on the stop the rotor's start-up twists it toward (a joint's start:), or left in the middle of its travel
    for (const parked of [true, false]) {
      const mech = gimbal3();
      if (parked) mech.joints.find((j) => j.name === "yaw")!.start = -45 * D2R;
      const v = run(m, mech);
      expect(v.results.faults).toBe(0);
      const t = v.frames.t;
      const yaw = v.frames.series["yaw.angle"];
      const at = (x: number) => t.findIndex((y) => y >= x);
      expect(yaw[0]).toBeCloseTo(parked ? -45 : 0, 1);
      // parked, it stays put until the loop takes over; left in the middle, the twist swings it onto that stop
      if (parked) for (let i = 0; i < at(3.6); i++) expect(Math.abs(yaw[i] + 45)).toBeLessThan(0.5);
      let closed = at(3.6);
      while (v.frames.series["fw.yawVane"][closed] === 0 && closed < t.length - 1) closed++;
      expect(yaw[closed]).toBeLessThan(-40);
      // either way, once the fan has finished climbing the loop walks it to the middle of its travel and holds it
      // there: the heading counts from the stop
      for (let i = at(10); i < t.length; i++) expect(Math.abs(yaw[i])).toBeLessThan(2);
    }
  });

  it("runs the static force test on the load cell board", { timeout: 60_000 }, () => {
    const m = design(
      `scenario "Force test" {
  world: sim.bench()
  duration: 20s
  console: [sim.type("tare", at: 2.9s), sim.type("arm", at: 3s), sim.type("t 70", at: 3.1s), sim.type("sweep", at: 6s)]
}`,
      { fw: FW2 },
    );
    const v = run(m, gimbal3({ lockRoll: true, lockYaw: true, cell: true }));
    const line = said(v, /vane moment:/)?.text ?? "";
    expect(line).toMatch(/mN m per deg/);
    // the sim's vanes are the design's prediction, so the test should find LIFT_K close to 1
    const k = Number(/set LIFT_K to ([\d.]+)/.exec(line)?.[1]);
    expect(k).toBeGreaterThan(0.8);
    expect(k).toBeLessThan(1.25);
    expect(v.results["nau.samples"]).toBeGreaterThan(1000);
    expect(v.results["cell.peak_force"]).toBeGreaterThan(0.3);
  });
});
