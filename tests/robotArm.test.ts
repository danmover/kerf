// The robot arm: the generated firmware on the virtual Nano driving five
// servos on a four-joint arm, jogged from the console and the pendant's
// joysticks, recording and playing back points, refusing moves it cannot
// make, and letting go when the e-stop is pressed.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFirmware } from "../src/machine/firmware";
import { evaluate } from "../src/lang/evaluator";
import { SimHal } from "../src/sim/engine/hal";
import { NANO, loadFirmware } from "../src/sim/mcu";
import { runSpec } from "../src/sim/build";
import { FRAME, type MechBody, type MechModel } from "../src/sim/mech/model";
import type { M3, V3 } from "../src/sim/mech/solver";

const G = 9.80665;
const D2R = Math.PI / 180;
const L1 = 0.14;
const L2 = 0.14;
const TOOL = 0.07;
const SZ = 0.12;

/** the arm's electronics, wired as the design wires them */
function design(scenario: string, extra = "") {
  return evaluate(
    `design "Robot arm"
component ctrl = lib.controller("arduino_nano") { at: (0, -150, 0) }
component psu = lib.psu("psu_12v_5a") { at: (200, -150, 0) }
component reg = lib.regulator("d36v50f6") { at: (100, -150, 0) }
component estop = lib.switch("estop_jaycar_sp0786") { at: (150, -200, 0) }
component base = lib.servo("dfrobot_ser0063") { at: (0, 0, 40), axis: Z, role: "base" }
component shoulder = lib.servo("dfrobot_ser0064") { at: (0, 0, 120), axis: -Y, role: "shoulder" }
component elbow = lib.servo("dfrobot_ser0063") { at: (0, 0, 260), axis: -Y, role: "elbow" }
component wrist = lib.servo("mg90d") { at: (140, 0, 260), axis: -Y, role: "wrist" }
component grip = lib.servo("mg90d") { at: (140, 0, 200), axis: X, role: "gripper" }
component j1 = lib.sensor("joystick_ky023") { at: (-100, -250, 0), role: "left" }
component j2 = lib.sensor("joystick_ky023") { at: (-40, -250, 0), role: "right" }
wire psu.VPOS -> estop.NC_1 { gauge: 18 }
wire estop.NC_2 -> reg.VIN { gauge: 18 }
wire psu.VPOS -> ctrl.VIN { gauge: 22 }
net GND: psu.VNEG, reg.GND, ctrl.GND, base.GND, shoulder.GND, elbow.GND, wrist.GND, grip.GND, j1.GND, j2.GND, estop.NO_4
net SERVO_6V: reg.VOUT, base.V_PLUS, shoulder.V_PLUS, elbow.V_PLUS, wrist.V_PLUS, grip.V_PLUS
net LOGIC_5V: ctrl.V5, j1.VCC, j2.VCC
wire ctrl.D3 -> base.SIG
wire ctrl.D5 -> shoulder.SIG
wire ctrl.D6 -> elbow.SIG
wire ctrl.D9 -> wrist.SIG
wire ctrl.D10 -> grip.SIG
wire ctrl.A0 -> j1.VRX
wire ctrl.A1 -> j1.VRY
wire ctrl.D2 -> j1.SW
wire ctrl.A2 -> j2.VRX
wire ctrl.A3 -> j2.VRY
wire ctrl.D4 -> j2.SW
wire ctrl.D8 -> estop.NO_3
firmware arm { board: ctrl, behaviour: "robot arm pick and place", l1: 140, l2: 140, tool: 70, shoulder_z: 120, elbow_min: -160, elbow_max: -15 ${extra} }
${scenario}`,
    { skipGeometry: true },
  );
}

const diag = (a: number, b = a, c = a): M3 => [a, 0, 0, 0, b, 0, 0, 0, c];
const body = (id: string, mass: number, com: V3, I: M3): MechBody => ({ id, label: id, parts: [], mass, com, inertia: I, points: [], boxes: [] });

/** the arm as a mechanism: base yaw on the frame, then three pitch joints about -Y (servo splines facing -Y) */
function arm(): MechModel {
  const lim: [number, number] = [-88 * D2R, 88 * D2R];
  return {
    bodies: [body("turntable", 0.2, [0, 0, 0.05], diag(3e-4)), body("upper", 0.15, [0, 0, SZ + L1 / 2], diag(4e-4)), body("fore", 0.12, [L2 / 2, 0, SZ + L1], diag(3e-4)), body("tool", 0.06, [L2, 0, SZ + L1 - 0.035], diag(5e-5))],
    joints: [
      { kind: "pivot", name: "base_j", body: "turntable", on: FRAME, at: [0, 0, 0], axis: [0, 0, 1], friction: 0.01, limits: lim },
      { kind: "pivot", name: "shoulder_j", body: "upper", on: "turntable", at: [0, 0, SZ], axis: [0, -1, 0], friction: 0.01, limits: lim },
      { kind: "pivot", name: "elbow_j", body: "fore", on: "upper", at: [0, 0, SZ + L1], axis: [0, -1, 0], friction: 0.01, limits: lim },
      { kind: "pivot", name: "wrist_j", body: "tool", on: "fore", at: [L2, 0, SZ + L1], axis: [0, -1, 0], friction: 0.005, limits: lim },
    ],
    drives: ["base", "shoulder", "elbow", "wrist"].map((c) => ({ kind: "servo" as const, joint: `${c}_j`, comp: c, sign: 1, zero: 90 })),
    links: [],
    springs: [],
    loads: [],
    jets: [],
    wheels: [],
    tracks: [],
    loose: [],
    ground: null,
    base: "fixed",
    gravity: [0, 0, -G],
    mounts: {},
    power: {},
    notes: [],
  };
}

/** the grip point (mm) from the joint angles (deg, from the design pose) */
function tip(r: Record<string, unknown>) {
  const a = (n: string) => Number(r[`${n}_j.angle`]);
  const psi = a("base") * D2R;
  const t1 = (90 + a("shoulder")) * D2R;
  const b = t1 + (-90 + a("elbow")) * D2R;
  const ph = b + (-90 + a("wrist")) * D2R;
  const rr = L1 * Math.cos(t1) + L2 * Math.cos(b) + TOOL * Math.cos(ph);
  return { x: rr * Math.cos(psi) * 1000, y: rr * Math.sin(psi) * 1000, z: (SZ + L1 * Math.sin(t1) + L2 * Math.sin(b) + TOOL * Math.sin(ph)) * 1000, pitch: ph / D2R };
}

const run = (src: string, extra = "") => {
  const m = design(src, extra);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const v = runSpec({ ...m.scenarios![0].spec, mech: arm(), variants: ["expected"] }, m.machine!, m.name).variants[0];
  expect(v.error).toBeUndefined();
  return { v, r: v.results, lines: v.serial.map((l) => l.text) };
};

describe("arm firmware", () => {
  it("is generated from the wiring, compiles, and fits the Nano", { timeout: 30_000 }, () => {
    const m = design("");
    const fw = generateFirmware(m.machine!, m.name)[0];
    expect(fw.warnings).toEqual([]);
    expect(fw.summary).toMatch(/robot arm/);
    const cfg = fw.files.find((f) => f.path.endsWith("config.h"))!.content;
    for (const d of ["PIN_BASE 3", "PIN_SHOULDER 5", "PIN_ELBOW 6", "PIN_WRIST 9", "PIN_GRIP 10", "PIN_J1X A0", "PIN_J1Y A1", "PIN_J1SW 2", "PIN_J2X A2", "PIN_J2Y A3", "PIN_J2SW 4", "PIN_ESTOP 8"]) expect(cfg).toContain(`#define ${d}`);
    const files = Object.fromEntries(fw.files.filter((f) => /\.(ino|h)$/.test(f.path)).map((f) => [f.path.split("/").pop()!, f.content]));
    const lf = loadFirmware(files, NANO, new SimHal(NANO, { seed: 1 }));
    expect(lf.staticRam).toBeLessThan(1400);
    let gpp = true;
    try {
      execFileSync("g++", ["--version"], { stdio: "ignore" });
    } catch {
      gpp = false;
    }
    if (gpp) {
      const dir = mkdtempSync(join(tmpdir(), "arm-"));
      try {
        for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
        const core = join(__dirname, "fixtures/arduino");
        execFileSync("g++", ["-std=gnu++17", "-fsyntax-only", "-Wall", "-Werror", "-Wno-unused-variable", "-x", "c++", "-include", join(core, "Arduino.h"), `-I${core}`, `-I${dir}`, join(dir, "arm.ino")], { stdio: "pipe" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("goes where it is told and refuses what it cannot reach", { timeout: 60_000 }, () => {
    const { r, lines } = run(`scenario "Goto" {
  world: sim.bench()
  duration: 9s
  console: [sim.type("goto 200 50 60", at: 1.5s), sim.type("goto 500 0 60", at: 5s), sim.type("goto 150 0 0", at: 5.2s), sim.type("where", at: 6s)]
}`);
    const p = tip(r);
    expect(lines.some((l) => /can't go to 500 0 60: out of reach/.test(l))).toBe(true);
    expect(lines.some((l) => /can't go to 150 0 0: below the lowest/.test(l))).toBe(true);
    expect(Math.hypot(p.x - 200, p.y - 50, p.z - 60)).toBeLessThan(4);
    expect(Math.abs(p.pitch + 90)).toBeLessThan(1.5);
    expect(r["fw.moves"]).toBe(1);
    expect(r["fw.refused"]).toBe(2);
  });

  it("jogs forward, back, up, down, left and right from the console, queued in order", { timeout: 60_000 }, () => {
    const { r, lines } = run(`scenario "Jog" {
  world: sim.bench()
  duration: 12s
  console: [sim.type("goto 180 0 100; fwd 40; down 30; left 30; up 10; back 20", at: 1.5s)]
}`);
    const p = tip(r);
    // 180 + 40 - 20 = 200 out, swung 30° left, 100 - 30 + 10 = 80 up
    expect(Math.hypot(p.x - 200 * Math.cos(30 * D2R), p.y - 200 * Math.sin(30 * D2R), p.z - 80)).toBeLessThan(4);
    expect(r["fw.moves"]).toBe(6);
    expect(String(r.state)).toBe("ready");
    // the shoulder holds the arm up steadily, well under the moment's peaks as it starts and stops
    const hold = Number(r["shoulder_j.hold_torque"]);
    expect(hold).toBeGreaterThan(50);
    expect(hold).toBeLessThan(Number(r["shoulder_j.peak_torque"]));
    expect(lines.filter((l) => l === "state: moving").length).toBe(1);
  });

  it("jogs from the pendant's sticks and stops at the edge of its reach", { timeout: 60_000 }, () => {
    const { r } = run(`scenario "Pendant" {
  world: sim.bench(signals: [sim.signal(on: "j1.VRY", volts: [(0s, 2.5V), (2s, 2.5V), (2.1s, 4.8V), (3.1s, 4.8V), (3.2s, 2.5V)]), sim.signal(on: "j2.VRY", volts: [(0s, 2.5V), (4s, 2.5V), (4.1s, 0.4V), (4.6s, 0.4V), (4.7s, 2.5V)]), sim.signal(on: "j1.VRX", volts: [(0s, 2.5V), (6s, 2.5V), (6.1s, 5V), (12s, 5V), (12.1s, 2.5V)])])
  duration: 14s
}`);
    const p = tip(r);
    const reach = Math.hypot(p.x, p.y);
    // home is 140 out, 190 up: about 60 mm further out, 25 mm lower
    expect(reach).toBeGreaterThan(180);
    expect(reach).toBeLessThan(225);
    expect(p.z).toBeGreaterThan(150);
    expect(p.z).toBeLessThan(180);
    // pushed right for 6 s at 45°/s: it stops at the base's limit, not past it
    expect(Number(r["base_j.angle"])).toBeLessThan(-80);
    expect(Number(r["base_j.angle"])).toBeGreaterThan(-90);
  });

  it("records points from the pendant's button and plays them back with the grip", { timeout: 60_000 }, () => {
    const { r, lines } = run(`scenario "Teach" {
  world: sim.bench()
  duration: 22s
  console: [sim.type("clear", at: 1s), sim.type("goto 200 0 60", at: 1.2s), sim.type("grab", at: 4.5s), sim.type("goto 150 120 80", at: 5.5s), sim.type("release", at: 9s), sim.type("home", at: 10s), sim.type("list", at: 13.5s), sim.type("play", at: 14s)]
  faults: [sim.press(j2, at: 4s, until: 4.2s), sim.press(j2, at: 8.5s, until: 8.7s)]
}`);
    expect(lines.filter((l) => /^point \d: /.test(l))).toEqual(["point 1: 200 0 60 pitch -90 (open)", "point 2: 150 120 80 pitch -90 (holding)", "point 1: 200 0 60 pitch -90 (open)", "point 2: 150 120 80 pitch -90 (holding)"]);
    const p = tip(r);
    expect(Math.hypot(p.x - 150, p.y - 120, p.z - 80)).toBeLessThan(4);
    expect(String(r.state)).toBe("done");
    expect(r["fw.nPoints"]).toBe(2);
  });

  it("runs the program in the design's firmware block at power-up", { timeout: 60_000 }, () => {
    const { r, lines } = run(
      `scenario "Program" {
  world: sim.bench()
  duration: 25s
}`,
      `, program: "goto 200 0 60; grab; up 60; left 60; down 60; release; wait 0.5; home", autorun: true`,
    );
    expect(lines.filter((l) => l.startsWith("> "))).toEqual(["> goto 200 0 60", "> grab", "> up 60", "> left 60", "> down 60", "> release", "> wait 0.5", "> home"]);
    expect(String(r.state)).toBe("done");
    expect(r["fw.moves"]).toBe(7);
    const p = tip(r);
    expect(Math.hypot(p.x - 140, p.y, p.z - 190)).toBeLessThan(4);
  });

  it("stops a program at a move it cannot make", { timeout: 60_000 }, () => {
    const m = design("", `, program: "goto 200 0 60; goto 900 0 60; grab"`);
    const fw = generateFirmware(m.machine!, m.name)[0];
    expect(fw.warnings).toEqual([]);
    const { lines, r } = run(`scenario "Bad program" {
  world: sim.bench()
  duration: 8s
  console: [sim.type("run", at: 1s)]
}`, `, program: "goto 200 0 60; goto 900 0 60; grab"`);
    expect(lines).toContain("program stopped");
    expect(lines.some((l) => l === "> grab")).toBe(false);
    expect(String(r.state)).toBe("ready");
  });

  it("warns about commands a program cannot run", () => {
    const m = design("", `, program: "goto 200 0 60; dance; rec"`);
    const fw = generateFirmware(m.machine!, m.name)[0];
    expect(fw.warnings.join(" ")).toMatch(/"dance", "rec" are not commands a program can run/);
  });

  it("lets go of every servo when the e-stop is pressed, and will not reset while it is held", { timeout: 60_000 }, () => {
    const { r, lines } = run(`scenario "E-stop" {
  world: sim.bench()
  duration: 8s
  console: [sim.type("goto 250 0 100", at: 1.5s), sim.type("reset", at: 5s), sim.type("fwd 10", at: 5.5s)]
  faults: [sim.press(estop, at: 2.5s)]
}`);
    expect(lines.some((l) => l.startsWith("FAULT: e-stop pressed"))).toBe(true);
    expect(lines).toContain("the e-stop is still pressed: twist it to release it first");
    expect(lines).toContain("fault: release the e-stop and type reset first");
    expect(String(r.state)).toMatch(/fault/);
    expect(r["fw.faults"]).toBe(1);
    expect(r.fault_noticed).toBe(true);
  });
});
