import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/lang/evaluator";
import { generateFirmware } from "../src/machine/firmware";
import { parseLine } from "../src/sim/printer/gcode";
import { readSetup } from "../src/sim/printer/config";
import { renderMacro } from "../src/sim/printer/macros";
import { KlipperPlanner, WindowPlanner, limitsOf, makeMove, type PlanMove } from "../src/sim/printer/planner";
import { HeaterSim } from "../src/sim/printer/heaters";
import { runPrinter, type PrinterRunOptions } from "../src/sim/printer/run";
import * as THREE from "three";
import type { MeshEntry } from "../src/core/engine";
import { PrinterOverlay, posePrinter } from "../src/ui/viewport/printerOverlay";

const SRC = readFileSync("src/demos/printer.kerf", "utf8");
const model = evaluate(SRC);
const machine = model.machine!;
const klipperFiles = generateFirmware(machine, model.name).find((f) => f.target === "klipper")!.files;
const klipper = readSetup("klipper", klipperFiles);

/** The same printer with a Duet 3 Mini 5+ in place of the SKR, every cable on the Duet's matching port (as in printerFirmware.test.ts). */
const DUET_PORTS: Record<string, string> = { XM: "DRIVER_0", YM: "DRIVER_1", ZAM: "DRIVER_2", ZBM: "DRIVER_3", E0M: "DRIVER_4", HE0: "OUT_1", TH0: "TEMP_1", HB: "OUT_0", THB: "TEMP_0", FAN0: "OUT_3", FAN1: "OUT_4", FAN2: "OUT_5", XSTOP: "IO_5", YSTOP: "IO_6", PROBE: "IO_3", USB: "USB", POWER: "POWER", POWER_GND: "POWER_GND" };
const duet = evaluate(SRC.replace('lib.controller("skr_mini_e3_v3")', 'lib.controller("duet3_mini5plus")').replace(/\bskr\.([A-Z0-9_]+)/g, (_, p: string) => `duet.${DUET_PORTS[p]}`).replace(/\bskr\b/g, "duet"));

const run = (o: Partial<PrinterRunOptions> & { world: PrinterRunOptions["world"] }) => runPrinter({ machine, designName: model.name, duration: 4 * 3600, variants: ["expected"], ...o });
const world = (extra: Partial<PrinterRunOptions["world"]> = {}): PrinterRunOptions["world"] => ({ test: { shape: "cube" }, material: "PLA", ambient: 20, ...extra });

describe("G-code lines", () => {
  it("reads G and M words, comments, checksums and glued parameters", () => {
    expect(parseLine("G1 X10.5 Y-2 E0.04 F3000 ; perimeter")).toMatchObject({ cmd: "G1", params: { X: "10.5", Y: "-2", E: "0.04", F: "3000" }, comment: "perimeter" });
    expect(parseLine("N12 G1X5Y6*71").params).toEqual({ X: "5", Y: "6" });
    expect(parseLine("g28").cmd).toBe("G28");
    expect(parseLine("M307 H1 R2.43 K0.56:0.12 D5.5 C7.06e-8").params).toMatchObject({ R: "2.43", K: "0.56:0.12", C: "7.06e-8" });
    expect(parseLine('M950 H1 C"out1" T1').params.C).toBe("out1");
    expect(parseLine("START_PRINT BED_TEMP=60 EXTRUDER_TEMP=210")).toMatchObject({ cmd: "START_PRINT", extended: true, params: { BED_TEMP: "60", EXTRUDER_TEMP: "210" } });
  });
});

describe("Klipper config read back", () => {
  it("has the printer's limits, steps, probe, mesh and macros", () => {
    expect(klipper.errors).toEqual([]);
    expect(klipper.velocity).toBe(300);
    expect(klipper.accel).toBe(3000);
    expect(klipper.junction).toEqual({ kind: "scv", v: 5 });
    expect(klipper.stepsPerMm.x).toBeCloseTo(80);
    expect(klipper.stepsPerMm.z).toBeCloseTo(400);
    expect(klipper.stepsPerMm.e).toBeCloseTo(415, 0);
    expect(klipper.probe).toMatchObject({ x: -38, y: 0 });
    expect(klipper.probe?.mesh?.count).toEqual([5, 5]);
    expect(klipper.homing.z.probe).toBe(true);
    expect([...klipper.macros.keys()]).toEqual(expect.arrayContaining(["START_PRINT", "END_PRINT"]));
  });

  it("runs the macros' templates", () => {
    const start = renderMacro(klipper.macros.get("START_PRINT")!, { params: { BED_TEMP: "70" }, printer: {} });
    expect(start).toContain("M190 S70.0");
    expect(start).toContain("M109 S210.0");
    const end = renderMacro(klipper.macros.get("END_PRINT")!, { params: {}, printer: { toolhead: { position: { z: 245 }, axis_maximum: { z: 250 } } } });
    expect(end).toContain("G1 Z250.0 F600");
  });
});

describe("planners", () => {
  const corner = (flavor: "klipper" | "marlin", setup = klipper) => {
    const s = { ...setup, flavor, junction: flavor === "klipper" ? setup.junction : ({ kind: "jd", mm: 0.013 } as const), printAccel: 3000, travelAccel: 3000 };
    const L = limitsOf(s);
    const out: PlanMove[] = [];
    const p = flavor === "klipper" ? new KlipperPlanner(() => L, (m) => out.push(m)) : new WindowPlanner(16, flavor, () => L, (m) => out.push(m));
    const tag = { extrude: false, line: 0, file: "t" };
    p.add(makeMove({ start: [0, 0, 0, 0], end: [100, 0, 0, 0], speed: 200, tag }, L, flavor)!);
    p.add(makeMove({ start: [100, 0, 0, 0], end: [100, 100, 0, 0], speed: 200, tag }, L, flavor)!);
    p.flush();
    return out[0].endV;
  };
  it("takes a square corner at Klipper's square_corner_velocity", () => {
    expect(corner("klipper")).toBeCloseTo(5, 3);
  });
  it("takes it at Marlin's junction deviation speed", () => {
    // v² = a·jd·sin(θ/2)/(1 − sin(θ/2)) = 3000 × 0.013 × 2.414
    expect(corner("marlin")).toBeCloseTo(Math.sqrt(3000 * 0.013 * 2.4142), 2);
  });
  it("slows Marlin on short segments with its 16-block buffer, where Klipper's lookahead does not", () => {
    const fastest = (flavor: "klipper" | "marlin") => {
      const s = { ...klipper, flavor, junction: { kind: "jd", mm: 0.013 } as const, printAccel: 3000, travelAccel: 3000, maxV: { x: 500, y: 500, z: 5, e: 50 } };
      const L = limitsOf(s);
      const out: PlanMove[] = [];
      const p = flavor === "klipper" ? new KlipperPlanner(() => L, (m) => out.push(m)) : new WindowPlanner(16, flavor, () => L, (m) => out.push(m));
      for (let i = 0; i < 200; i++) p.add(makeMove({ start: [i * 0.5, 0, 0, 0], end: [(i + 1) * 0.5, 0, 0, 0], speed: 300, tag: { extrude: false, line: i, file: "t" } }, L, flavor)!);
      p.flush();
      return Math.max(...out.map((m) => m.cruiseV));
    };
    expect(fastest("klipper")).toBeCloseTo(300, 0);
    // it must be able to stop within the 15 blocks it can see: √(2 × 3000 × 7.5) ≈ 212 mm/s
    expect(fastest("marlin")).toBeLessThan(220);
  });
});

describe("heaters", () => {
  const phys = { comp: "hotend", label: "Hotend", power: 30, capacity: 13.5, loss: 0.1, lossFan: 0.03, lag: 1.5, limit: 285, from: "" };
  const heat = (power: number) => {
    const h = new HeaterSim(phys, klipper.hotend!, klipper.safety.hotend, "klipper", { ambient: 20, power, loss: 1 }, klipper.wait);
    h.setTarget(210, 0);
    let t = 0;
    let reached = -1;
    while (t < 600 && !h.fault) {
      h.step(0.05, t, 0, 0);
      t += 0.05;
      if (reached < 0 && !h.busy(t)) reached = t;
    }
    return { h, reached };
  };
  it("Klipper's PID brings the hotend to 210 °C and holds it", () => {
    const { h, reached } = heat(1);
    expect(h.fault).toBeNull();
    expect(reached).toBeGreaterThan(60);
    expect(reached).toBeLessThan(300);
    expect(Math.abs(h.sensor - 210)).toBeLessThan(1);
    expect(h.overshoot).toBeLessThan(8);
  });
  it("verify_heater stops a hotend that cannot heat", () => {
    const { h } = heat(0.15);
    expect(h.fault?.msg).toBe("Heater extruder not heating at expected rate");
  });
});

describe("printing through Klipper", () => {
  it("prints the calibration cube", () => {
    const r = run({ world: world() });
    expect(r.error).toBeUndefined();
    const v = r.variants[0];
    expect(v.stop).toBe("the print is done");
    expect(v.results.finished).toBe(true);
    expect(v.results.layer_shifts).toBe(0);
    expect(v.results.under_extrusion).toBeLessThan(0.01);
    expect(v.results.print_time).toBeGreaterThan(8 * 60);
    expect(v.results.print_time).toBeLessThan(25 * 60);
    expect(v.results.first_layer_error).toBeLessThan(0.1);
    expect(v.results.mesh_range).toBeGreaterThan(0);
    expect(v.print!.t.length).toBeGreaterThan(3000);
    expect(v.frames.series["hotend.temp"]).toBeDefined();
  });

  it("skips steps on the heavy bed axis when the acceleration is far too high", () => {
    const r = run({ world: world({ test: { shape: "cube", speed: 200, travel: 400 } }), config: { MAX_ACCEL: 30000, MAX_VELOCITY: 500 } });
    const v = r.variants[0];
    expect(r.firmware.config.map((c) => c.name)).toEqual(["max_accel", "max_velocity"]);
    expect(v.results.y_load).toBeGreaterThan(1);
    expect(v.results.layer_shifts).toBeGreaterThan(0);
    expect(v.events.some((e) => e.kind === "stall" && /Y skipped/.test(e.text))).toBe(true);
  });

  it("refuses a setting the config does not use", () => {
    expect(run({ world: world(), config: { MAX_ACEL: 5000 } }).error).toMatch(/MAX_ACEL changes nothing/);
  });

  it("stops a print that moves before homing, and skips arcs without [gcode_arcs]", () => {
    const v1 = run({ world: { gcode: "G1 X10 Y10 F3000\n", material: "PLA", ambient: 20 } }).variants[0];
    expect(v1.stop).toMatch(/Klipper stopped the print: Must home axis first/);
    const v2 = run({ world: { gcode: "G28\nG2 X20 Y20 I5 J5\nG1 X30\n", material: "PLA", ambient: 20 } }).variants[0];
    expect(v2.results.finished).toBe(true);
    expect(v2.serial.some((l) => l.text === '// Unknown command:"G2"')).toBe(true);
  });
});

describe("Marlin and RepRapFirmware", () => {
  it("prints the cube through Marlin on the same board, from its Configuration.h", () => {
    const r = run({ world: world({ flavor: "marlin" }) });
    expect(r.error).toBeUndefined();
    const v = r.variants[0];
    expect(v.results.firmware).toBe("Marlin");
    expect(v.stop).toBe("the print is done");
    expect(v.results.layer_shifts).toBe(0);
    expect(v.results.first_layer_error).toBeLessThan(0.1);
    expect(v.results.hotend_error).toBeLessThan(5);
  });

  it("prints the cube through RepRapFirmware on a Duet, from config.g and the homing files", () => {
    const r = runPrinter({ machine: duet.machine!, designName: duet.name, duration: 4 * 3600, variants: ["expected"], world: world() });
    expect(r.error).toBeUndefined();
    const v = r.variants[0];
    expect(v.results.firmware).toBe("RepRapFirmware");
    expect(v.stop).toBe("the print is done");
    expect(v.results.layer_shifts).toBe(0);
    expect(v.results.mesh_range).toBeGreaterThan(0);
    expect(v.serial.some((l) => /25 points probed/.test(l.text))).toBe(true);
  });

  it("says when the board cannot run the firmware asked for", () => {
    expect(run({ world: world({ flavor: "reprapfirmware" }) }).error).toMatch(/cannot write RepRapFirmware for the .*SKR Mini E3.*Duet 3 Mini 5\+/);
  });

  it("reports a Marlin config that would not build", () => {
    const files = generateFirmware({ ...machine, firmware: machine.firmware.map((f) => ({ ...f, settings: { ...f.settings, flavor: "marlin" } })) }, model.name)[0].files;
    const broken = files.map((f) => (f.path.endsWith("Configuration.h") ? { ...f, content: f.content.replace(/#define DEFAULT_BED_KD.*\n/, "") } : f));
    expect(readSetup("marlin", broken).errors.join(" ")).toMatch(/DEFAULT_BED_KD: Marlin will not build/);
  });
});

describe("3D playback", () => {
  it("moves the bed with Y, the toolhead with X, the gantry with Z, and grows the print on the bed", () => {
    const pose = posePrinter(SRC, model);
    const moved = (ax: number) => [...pose.moves].filter(([, mv]) => mv[ax].lengthSq() > 0.5).map(([id]) => id);
    expect(moved(0)).toContain(pose.hotId);
    expect(moved(1)).toContain(pose.bedId);
    expect(moved(1)).not.toContain(pose.hotId);
    expect(moved(2)).toContain(pose.hotId);

    const v = run({ world: world() }).variants[0];
    // a one-triangle stand-in for each part's mesh: the overlay only needs something to place
    const tri: MeshEntry = { final: { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) } as MeshEntry["final"], volume: 0, bbox: [[0, 0, 0], [1, 1, 1]], rev: 0 };
    const ov = new PrinterOverlay(model.parts, new Map(model.parts.map((p) => [p.hash, tri])), pose, v.print!);
    const drawn = () => {
      let n = 0;
      ov.object.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry.index && o.geometry.index.count > 3) n = o.geometry.drawRange.count;
      });
      return n;
    };
    const tEnd = v.print!.t[v.print!.t.length - 1];
    ov.setTime(0);
    expect(drawn()).toBe(0);
    ov.setTime(tEnd / 2);
    const half = drawn();
    const noseHalf = ov.nose()!.clone();
    ov.setTime(tEnd);
    expect(half).toBeGreaterThan(0);
    expect(drawn()).toBeGreaterThan(half);
    expect(ov.nose()!.distanceTo(noseHalf)).toBeGreaterThan(0);
    ov.dispose();
  });
});
