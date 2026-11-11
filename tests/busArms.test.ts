// Smart bus servos (Feetech STS: Waveshare ST3215): the simulated servo and
// its bus protocol, the controller's extra serial ports, and the generated
// two-arm firmware driving twelve of them from console lines.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { catalogPart } from "../src/machine/catalog";
import { servoBuses } from "../src/machine/busServos";
import { generateFirmware } from "../src/machine/firmware";
import { BusServo, REG, STS, ServoBus } from "../src/sim/engine/busServo";
import { SimHal } from "../src/sim/engine/hal";
import { FEATHER_ESP32_V2, NANO, loadFirmware } from "../src/sim/mcu";
import { runSpec } from "../src/sim/build";
import { FRAME, type MechBody, type MechModel } from "../src/sim/mech/model";
import type { M3, V3 } from "../src/sim/mech/solver";

const JOINTS = ["yaw", "shoulder", "elbow", "wrist", "roll", "tool"];

/** two arms of six servos, wired as the two-arm robot wires them */
function design(scenario = "", settings = "") {
  const servos = ["l", "r"].flatMap((s, a) => JOINTS.map((j, i) => `component ${s}_${j} = lib.servo("waveshare_st3215") { at: (${i * 40}, ${a * 200}, 100), axis: Z }`));
  const chain = (s: string, pin: string, spin: string) => `wire drv_${s}.${pin} -> ${JOINTS.map((j) => `${s}_${j}.${spin}`).join(" -> ")} { gauge: 22 }`;
  return evaluate(
    `design "Duo"
component ctrl = lib.part("feather_esp32_v2") { at: (-200, 0, 0) }
component psu = lib.part("psu_12v_10a") { at: (-400, 0, 0) }
component estop = lib.part("estop_jaycar_sp0786") { at: (-300, -100, 0) }
component fuse_l = lib.part("fuse_holder_atc") { at: (-250, 60, 0), rating: 3A }
component fuse_r = lib.part("fuse_holder_atc") { at: (-250, -60, 0), rating: 3A }
component drv_l = lib.part("waveshare_bus_servo_adapter_a") { at: (-200, 80, 0) }
component drv_r = lib.part("waveshare_bus_servo_adapter_a") { at: (-200, -80, 0) }
${servos.join("\n")}
wire psu.VPOS -> estop.NC_1 { gauge: 16 }
net V12: estop.NC_2, fuse_l.IN, fuse_r.IN { gauge: 16 }
net GND: psu.VNEG, drv_l.GND, drv_r.GND { gauge: 16 }
net LOGIC_GND: ctrl.GND, drv_l.UART_G, drv_r.UART_G, estop.NO_4 { gauge: 24 }
wire ctrl.D14 -> estop.NO_3 { gauge: 24 }
wire fuse_l.OUT -> drv_l.VIN { gauge: 18 }
wire fuse_r.OUT -> drv_r.VIN { gauge: 18 }
wire ctrl.TX -> drv_l.TX { gauge: 24 }
wire ctrl.RX -> drv_l.RX { gauge: 24 }
wire ctrl.D27 -> drv_r.TX { gauge: 24 }
wire ctrl.D33 -> drv_r.RX { gauge: 24 }
${["l", "r"].flatMap((s) => [chain(s, "SERVO_V", "V_PLUS"), chain(s, "SERVO_G", "GND"), chain(s, "SERVO_S", "SIG")]).join("\n")}
firmware arms { board: ctrl, behaviour: "two-arm robot of smart bus servos driven from a computer", joints: "yaw, shoulder, elbow, wrist, roll, tool", limits_lo: "-150, -100, -130, -110, -170, -170", limits_hi: "150, 100, 130, 110, 170, 170", torque: "50, 85, 60, 50, 40, 50" ${settings} }
${scenario}`,
    { skipGeometry: true },
  );
}

const run = (scenario: string, mech?: MechModel) => {
  const m = design(scenario);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const v = runSpec({ ...m.scenarios![0].spec, ...(mech ? { mech } : {}), variants: ["expected"] }, m.machine!, m.name).variants[0];
  expect(v.error).toBeUndefined();
  return { v, r: v.results, lines: v.serial.map((l) => l.text) };
};

/** a packet to a servo, with its checksum */
function pkt(id: number, inst: number, params: number[]): number[] {
  const body = [id, params.length + 2, inst, ...params];
  return [0xff, 0xff, ...body, ~body.reduce((a, b) => a + b, 0) & 255];
}

function send(bus: ServoBus, bytes: number[]): number[] {
  let out: number[] = [];
  for (const b of bytes) out = bus.byte(b, 0)?.bytes ?? out;
  return out;
}

describe("a smart servo on its bus", () => {
  const part = catalogPart("waveshare_st3215")!;
  const make = (ids: number[]) => {
    const bus = new ServoBus("drv");
    for (const id of ids) {
      const s = new BusServo(`s${id}`, part);
      s.id = id;
      s.mem[REG.ID] = id;
      s.tick(0.001, true, 12);
      bus.servos.push(s);
    }
    return bus;
  };

  it("answers a ping, and stays silent for a bad checksum or another servo's number", () => {
    const bus = make([1, 2]);
    expect(send(bus, pkt(2, STS.PING, []))).toEqual([0xff, 0xff, 2, 2, 0, 0xfb]);
    expect(send(bus, pkt(7, STS.PING, []))).toEqual([]);
    const broken = pkt(1, STS.PING, []);
    broken[broken.length - 1] ^= 1;
    expect(send(bus, broken)).toEqual([]);
    expect(bus.bad).toBe(1);
    // noise before a packet does not lose it
    expect(send(bus, [0x12, 0xff, ...pkt(1, STS.PING, [])])).toEqual([0xff, 0xff, 1, 2, 0, 0xfc]);
  });

  it("moves to its goal at the speed and acceleration it was given, and reads back where it is", () => {
    const bus = make([1]);
    const s = bus.servos[0];
    send(bus, pkt(1, STS.WRITE, [REG.TORQUE_ENABLE, 1]));
    // acceleration 50 (5000 steps/s²), goal 3072 (90° on), speed 1024 steps/s
    send(bus, pkt(STS.BROADCAST, STS.SYNC_WRITE, [REG.ACC, 7, 1, 50, 0x00, 0x0c, 0, 0, 0x00, 0x04]));
    let t = 0;
    let peak = 0;
    for (; t < 3 && Math.abs((s.wanted(null) ?? 0) - 270) > 0.01; t += 0.001) {
      const before = s.wanted(null)!;
      s.tick(0.001, true, 12);
      s.step(null, 0, true, 0.001);
      peak = Math.max(peak, (s.wanted(null)! - before) / 0.001);
    }
    // 1024 steps at 1024 steps/s is 1 s, plus the 0.2 s it takes to get up to speed
    expect(t).toBeGreaterThan(1.15);
    expect(t).toBeLessThan(1.3);
    expect(peak).toBeCloseTo(90, 0);
    const back = send(bus, pkt(1, STS.READ, [REG.PRESENT_POSITION, 2]));
    expect(back[5] | (back[6] << 8)).toBe(3072);
  });

  it("goes limp without power, forgets its torque switch, and keeps its number", () => {
    const bus = make([3]);
    const s = bus.servos[0];
    send(bus, pkt(3, STS.WRITE, [REG.TORQUE_ENABLE, 1]));
    expect(s.wanted(null)).toBeCloseTo(180, 3);
    s.tick(0.001, false, 0);
    expect(s.wanted(null)).toBeNull();
    expect(send(bus, pkt(3, STS.PING, []))).toEqual([]);
    s.tick(0.001, true, 12);
    expect(s.wanted(null)).toBeNull();
    expect(send(bus, pkt(3, STS.PING, []))).toHaveLength(6);
  });

  it("answers a sync read one servo after another, and lets go when held past its overload torque", () => {
    const bus = make([1, 2]);
    const back = send(bus, pkt(STS.BROADCAST, STS.SYNC_READ, [REG.PRESENT_POSITION, 2, 1, 2]));
    expect(back).toHaveLength(16);
    expect([back[2], back[10]]).toEqual([1, 2]);
    const s = bus.servos[0];
    send(bus, pkt(1, STS.WRITE, [REG.TORQUE_ENABLE, 1]));
    expect(s.limit()).toBeCloseTo(2.942, 2);
    for (let i = 0; i < 2500; i++) {
      s.follow(null, 180, 2.6, true);
      s.tick(0.001, true, 12);
    }
    expect(s.overloaded).toBe(true);
    expect(s.limit()).toBeCloseTo(0.2 * 2.942, 2);
    expect(send(bus, pkt(1, STS.PING, []))[4] & 0x20).toBe(0x20);
  });
});

describe("servo buses from the wiring", () => {
  it("numbers each adapter's servos along its chain", () => {
    const m = design();
    const buses = servoBuses(m.machine!);
    expect(buses.map((b) => b.adapter)).toEqual(["drv_l", "drv_r"]);
    expect(buses[0].servos).toEqual(JOINTS.map((j, i) => ({ comp: `l_${j}`, id: i + 1 })));
    expect(buses[1].servos.map((s) => s.comp)).toEqual(JOINTS.map((j) => `r_${j}`));
  });
});

const ARDUINO_STUB = `#pragma once
#include <stdint.h>
#include <stddef.h>
#include <ctype.h>
#define HIGH 1
#define LOW 0
#define INPUT_PULLUP 2
#define SERIAL_8N1 0x800001c
class HardwareSerial {
 public:
  void begin(unsigned long baud, uint32_t config = SERIAL_8N1, int8_t rx = -1, int8_t tx = -1);
  void setTimeout(unsigned long ms);
  int available();
  int read();
  void flush();
  size_t write(const uint8_t *buf, size_t n);
  size_t readBytes(uint8_t *buf, size_t n);
  size_t print(const char *);
  size_t print(char);
  size_t print(int);
  size_t print(unsigned int);
  size_t print(long);
  size_t print(unsigned long);
  size_t println(const char *);
  size_t println(int);
  size_t println(unsigned long);
  size_t println(void);
};
extern HardwareSerial Serial, Serial1, Serial2;
unsigned long millis();
void delay(unsigned long);
void pinMode(uint8_t, uint8_t);
int digitalRead(uint8_t);
`;

describe("two-arm firmware", () => {
  it("is generated from the wiring and compiles for the ESP32", { timeout: 30_000 }, () => {
    const m = design();
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const fw = generateFirmware(m.machine!, m.name)[0];
    expect(fw.warnings).toEqual([]);
    expect(fw.summary).toMatch(/2 arms of smart bus servos/);
    const cfg = fw.files.find((f) => f.path.endsWith("config.h"))!.content;
    expect(cfg).toContain("#define N_ARMS 2");
    expect(cfg).toContain("#define MAX_J 6");
    expect(cfg).toContain("static const char ARM_NAME[N_ARMS] = { 'L', 'R' };");
    expect(cfg).toContain("static const int8_t BUS_RX[N_ARMS] = { 7, 33 };");
    expect(cfg).toContain("static const int8_t BUS_TX[N_ARMS] = { 8, 27 };");
    expect(cfg).toMatch(/#define ESTOP_PIN 14 /);
    expect(fw.pinTable.map((p) => p.wire)).toEqual(["drv_l.RX", "drv_r.RX", "drv_l.TX", "drv_r.TX", "estop.NO_3"]);
    const files = Object.fromEntries(fw.files.filter((f) => /\.(ino|h)$/.test(f.path)).map((f) => [f.path.split("/").pop()!, f.content]));
    const lf = loadFirmware(files, FEATHER_ESP32_V2, new SimHal(FEATHER_ESP32_V2, { seed: 1 }));
    expect(lf.staticRam).toBeLessThan(4096);
    let gpp = true;
    try {
      execFileSync("g++", ["--version"], { stdio: "ignore" });
    } catch {
      gpp = false;
    }
    if (gpp) {
      const dir = mkdtempSync(join(tmpdir(), "arms-"));
      try {
        for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
        writeFileSync(join(dir, "Arduino.h"), ARDUINO_STUB);
        execFileSync("g++", ["-std=gnu++17", "-fsyntax-only", "-Wall", "-Werror", "-Wno-unused-variable", "-Wno-unused-function", "-x", "c++", `-I${dir}`, join(dir, "arms.ino")], { stdio: "pipe" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("has no second serial port on a Nano", () => {
    const hal = new SimHal(NANO, { seed: 1 });
    hal.serialBegin(1, 1_000_000);
    expect(hal.faults.map((f) => f.msg).join()).toMatch(/Serial1 does not exist on the Arduino Nano/);
  });

  it("takes hold, moves both arms to arrive together, and reads the angles back", { timeout: 60_000 }, () => {
    const { r, lines } = run(`scenario "Move" {
  world: sim.bench()
  duration: 6s
  console: [sim.type("ping; on", at: 1s), sim.type("mv L 1500 300 -450 600 0 900 -200; mv R 1000 -300 0 0 0 0 0", at: 2s), sim.type("rd; st", at: 5s)]
}`);
    expect(lines).toContain("ok duo 1");
    expect(r["l_yaw.angle"]).toBeCloseTo(210, 0);
    expect(r["l_shoulder.angle"]).toBeCloseTo(135, 0);
    expect(r["l_elbow.angle"]).toBeCloseTo(240, 0);
    expect(r["l_roll.angle"]).toBeCloseTo(270, 0);
    expect(r["l_tool.angle"]).toBeCloseTo(160, 0);
    expect(r["r_yaw.angle"]).toBeCloseTo(150, 0);
    expect(r["r_shoulder.angle"]).toBeCloseTo(180, 0);
    const p = lines.find((l) => l.startsWith("p L"))!;
    const got = p.split(" ").filter((x) => /^-?\d+$/.test(x)).map(Number);
    const want = [300, -450, 600, 0, 900, -200, -300, 0, 0, 0, 0, 0];
    got.forEach((g, i) => expect(Math.abs(g - want[i])).toBeLessThanOrEqual(1));
    expect(r["fw.moves"]).toBe(2);
    expect(r["fw.refused"]).toBe(0);
    expect(r["fw.bus_errors"]).toBe(0);
    expect(String(r.state)).toBe("waiting");
    const order = lines.filter((l) => l.startsWith("state: ")).map((l) => l.slice(7));
    expect(order).toEqual(["limp", "waiting", "moving", "waiting"]);
  });

  it("refuses a move past a limit or while limp, and lets go when the e-stop is pressed", { timeout: 60_000 }, () => {
    const { r, lines } = run(`scenario "Refuse" {
  world: sim.bench()
  duration: 8s
  console: [sim.type("mv L 500 100 0 0 0 0 0", at: 1s), sim.type("on; mv L 500 0 1200 0 0 0 0; j R 3 450 800", at: 1.5s), sim.type("j R 3 0 500", at: 5s), sim.type("on", at: 7s)]
  faults: [sim.press(estop, at: 4s, until: 6s)]
}`);
    expect(lines).toContain("err limp: send on first");
    expect(lines).toContain("err limit L 2");
    expect(lines).toContain("err estop pressed");
    expect(lines).toContain("err estop");
    expect(lines).toContain("estop released: send on");
    expect(r["fw.moves"]).toBe(1);
    expect(r["fw.refused"]).toBe(3);
    expect(r["fw.faults"]).toBe(1);
    // the elbow stays where it was when the power went: nothing drives it on a bench
    expect(r["r_elbow.angle"]).toBeCloseTo(225, 0);
    expect(String(r.state)).toBe("waiting");
  });

  it("turns the last servo on and on for a screwdriver, then holds it again", { timeout: 60_000 }, () => {
    const { r, lines } = run(`scenario "Spin" {
  world: sim.bench()
  duration: 6s
  console: [sim.type("on; spin L 1024", at: 1s), sim.type("spin L 0", at: 3.5s), sim.type("rd", at: 5s)]
}`);
    // a quarter turn a second from the end of the soft start (1.3 s) to 3.5 s, and it keeps what it turned
    const turned = Number(r["l_tool.angle"]) - 180;
    expect(turned).toBeGreaterThan(185);
    expect(turned).toBeLessThan(205);
    expect(lines.filter((l) => l === "ok")).toHaveLength(3);
  });
});

const diag = (a: number): M3 => [a, 0, 0, 0, a, 0, 0, 0, a];
const body = (id: string, mass: number, com: V3, I: M3): MechBody => ({ id, label: id, parts: [], mass, com, inertia: I, points: [], boxes: [] });

/** one link on the left shoulder servo: 0.4 kg, its centre 0.2 m out, level at the zero pose (0.78 N·m to hold) */
function link(): MechModel {
  return {
    bodies: [body("link", 0.4, [0.2, 0, 0], diag(2e-3))],
    joints: [{ kind: "pivot", name: "shoulder_j", body: "link", on: FRAME, at: [0, 0, 0], axis: [0, -1, 0], friction: 0.01 }],
    drives: [{ kind: "servo" as const, joint: "shoulder_j", comp: "l_shoulder", sign: 1, zero: 180 }],
    links: [],
    springs: [],
    loads: [],
    jets: [],
    wheels: [],
    tracks: [],
    loose: [],
    ground: null,
    base: "fixed",
    gravity: [0, 0, -9.80665],
    mounts: {},
    power: {},
    notes: [],
  };
}

describe("a smart servo holding a load", () => {
  it("holds a link level, reports the load, and sags when its torque limit is cut", { timeout: 60_000 }, () => {
    const { r, lines } = run(
      `scenario "Hold" {
  world: sim.bench()
  duration: 7s
  console: [sim.type("on; j L 2 300 1000", at: 1s), sim.type("ld; st", at: 3.5s), sim.type("tq L 2 15", at: 4s)]
}`,
      link(),
    );
    const ld = lines.find((l) => l.startsWith("l L"))!.split(" ").map(Number);
    // 0.4 kg at 0.2 m, 30° up: 0.68 N·m of the 2.94 N·m stall, 23 %
    expect(Math.abs(ld[3])).toBeGreaterThan(200);
    expect(Math.abs(ld[3])).toBeLessThan(260);
    const ma = Number(/L_ma=(\d+)/.exec(lines.find((l) => l.startsWith("s "))!)![1]);
    expect(ma).toBeGreaterThan(700);
    expect(ma).toBeLessThan(1300);
    // at 15 % (0.44 N·m) it cannot hold 0.68 N·m: the link falls
    expect(Number(r["shoulder_j.angle"])).toBeLessThan(-45);
  });
});
