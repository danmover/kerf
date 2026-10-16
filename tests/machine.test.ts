// The machine layer end to end: catalog, engineering calculators, wiring
// rules, generated firmware (compiled against a mock Arduino core when a
// compiler is installed) and the full geometry check of the sand tunneller.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as R from "replicad";
import { evaluate } from "../src/lang/evaluator";
import { buildPart } from "../src/kernel/build";
import { CATALOG, shopLinks } from "../src/machine/catalog";
import { sig } from "../src/machine/calcs";
import { machineChecks } from "../src/machine/checks";
import { BRIEFS, scoreBrief } from "../src/machine/briefs";
import { generateFirmware } from "../src/machine/firmware";
import { fullCheck, problems } from "./helpers/fullcheck";
import { initKernel } from "./helpers/kernel";

const TUNNELLER = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");
const MOCK_CORE = join(__dirname, "fixtures/arduino");

/** Whether this compiler is installed and can build for the target at all. */
const canCompile = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, "-fsyntax-only", "-x", "c++", "-"], { input: "#include <stdint.h>\nint main() { return 0; }\n", stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

const errors = (src: string) =>
  evaluate(src)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.message);

describe("catalog", () => {
  it("has unique ids, unique pins and a way to buy every part", () => {
    const ids = CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of CATALOG) {
      const pins = p.pins.map((x) => x.id);
      expect(new Set(pins).size, `${p.id} pins`).toBe(pins.length);
      expect(p.buy.length, `${p.id} buy links`).toBeGreaterThan(0);
      expect(shopLinks(p).length, `${p.id} shop links`).toBeGreaterThan(0);
      for (const b of p.buy) if (b.url) expect(b.url, p.id).toMatch(/^https:\/\//);
    }
  });
});

describe("calculators", () => {
  it("rounds to significant figures without float noise", () => {
    expect(sig(25100000.000000004)).toBe(25100000);
    expect(sig(0.0123456)).toBe(0.0123);
    expect(sig(-4.5678, 2)).toBe(-4.6);
  });

  it("says when a steering slot self-locks", () => {
    const m = evaluate(`
design "cam"
component act = lib.actuator("actuonix_p16p_50_256") { at: (0, 0, 0), axis: X }
let tight = calc.actuator_moment(actuator: act, arm: 30mm, slope: 0.2, friction: 0.2)
let free = calc.actuator_moment(actuator: act, arm: 30mm, slope: 0.5, friction: 0.2)
let direct = calc.actuator_moment(actuator: act, arm: 30mm)
require "slot at the friction angle holds": tight.self_locking
require "steep slot back-drives": !free.self_locking
require "slanted slot multiplies the push": tight.moment > direct.moment
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const r of m.requirements) expect(r.status, r.label).toBe("pass");
  });

  it("sizes a screw against sand and picks the motor operating point", () => {
    const m = evaluate(`
design "burrow"
component mf = lib.gearmotor("gobilda_5203_188") { at: (0, 0, 0), axis: X }
let sand = calc.sand_stress(depth: 9.5m, box_w: 1m)
let screw = calc.screw_burrow(d: 90, core_d: 72, length: 176, pitch: 40, sigma_v: sand.sigma_v, sigma_h: sand.sigma_h, face: true)
let point = calc.motor_point(motor: mf, load: screw.torque, voltage: 11.1)
require "Janssen arching caps the pressure": sand.sigma_v < 30kPa
require "the motor runs below stall": point.load_fraction < 1
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const r of m.requirements) expect(r.status, r.label).toBe("pass");
    expect(m.machine!.calcs.map((c) => c.fn)).toEqual(["sand_stress", "screw_burrow", "motor_point"]);
  });
});

describe("benchmark briefs", () => {
  it("say what is missing from an incomplete answer", () => {
    const score = scoreBrief(BRIEFS[0], evaluate(`
design "half a drill"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
part shell { body cylinder(d: 60, h: 200) }
`));
    const missing = score.lines.filter((l) => !l.ok).map((l) => l.label);
    expect(missing).toEqual(["Buys the parts the brief needs", "Sizes the machine with calculations", "Wires the electronics", "Writes the firmware", "States and meets requirements", "Plans physical tests"]);
    expect(score.score).toBe(2);
  });

  it("want the job written into a brief when the request gives its numbers", () => {
    const pit = BRIEFS.find((b) => b.id === "sand-pit")!;
    const line = (src: string) => scoreBrief(pit, evaluate(src)).lines.find((l) => l.label === "Writes the job into the brief");
    expect(line(`design "x"\npart a { body box(1, 1, 1) }\n`)).toMatchObject({ ok: false, detail: "no brief block" });
    const brief = `design "x"\nbrief {\n  use cross "Crosses the pit"\n  given pit_l = 2m "Pit length"\n  given pit_depth = 5m "Sand depth"\n}\nlet run = pit_l + pit_depth\n`;
    expect(line(brief)).toMatchObject({ ok: false, detail: "no requirement for cross" });
    expect(line(brief + `require "Long enough" for cross: run > 1m\n`)).toMatchObject({ ok: true });
  });
});

describe("wiring rules", () => {
  it("flags a motor wired straight to a microcontroller pin", () => {
    const m = evaluate(`
design "bad"
component ctrl = lib.controller("arduino_nano") { at: (0, 0, 0) }
component mf = lib.gearmotor("gobilda_5203_188") { at: (100, 0, 0), axis: X }
wire ctrl.D9 -> mf.M_PLUS
wire ctrl.GND -> mf.M_MINUS
`);
    const fails = machineChecks(m.machine!).filter((c) => c.status === "fail");
    expect(fails.length).toBeGreaterThan(0);
  });
});

describe("flight shape", () => {
  it("builds a helical screw flight fused to its core", async () => {
    await initKernel();
    const m = evaluate(`
design "auger"
part screw {
  body tube(od: 72, id: 60, h: 120)
  add flight(d: 90, core_d: 72, pitch: 40, length: 120, t: 3, root_t: 10)
}
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const shape = buildPart(m.parts[0].recipe);
    const vol = R.measureVolume(shape);
    const tube = (Math.PI / 4) * (72 ** 2 - 60 ** 2) * 120;
    // three turns of a 9 mm deep blade between 3 and 10 mm thick
    expect(vol).toBeGreaterThan(tube + 3 * Math.PI * 81 * 9 * 3 * 0.8);
    expect(vol).toBeLessThan(tube + 3 * Math.PI * 81 * 9 * 10);
  }, 120000);
});

describe("sand tunneller", () => {
  const model = evaluate(TUNNELLER);

  it("evaluates with every requirement and machine check passing", () => {
    expect(errors(TUNNELLER)).toEqual([]);
    for (const r of model.requirements) expect(`${r.label}: ${r.status} ${r.detail}`).toMatch(/: pass /);
    const bad = machineChecks(model.machine!).filter((c) => c.status === "fail" || c.status === "warn");
    expect(bad.map((c) => `${c.title}: ${c.detail}`)).toEqual([]);
  });

  it("sizes itself from the pit in its brief, so a wider pit fails the motor and battery checks", () => {
    expect(model.brief?.givens.map((g) => g.name)).toEqual(["pit_l", "pit_depth", "pit_w", "floor_gap"]);
    const uses = model.brief!.uses.map((u) => u.id);
    for (const u of uses) expect(model.requirements.some((r) => r.uses.includes(u))).toBe(true);
    // in a 1 m wide pit the walls carry less of the sand: about 27 kPa at the bottom instead of 17
    const wide = evaluate(TUNNELLER.replace(/given pit_w = 0\.5m/, "given pit_w = 1m"));
    const failing = wide.requirements.filter((r) => r.status === "fail").map((r) => r.label);
    expect(failing).toEqual(["Front motor runs below half its stall torque", "Rear motor runs below half its stall torque", "Battery lasts two crossings"]);
  });

  it("generates an Arduino sketch with its pins taken from the wiring", () => {
    const [fw] = generateFirmware(model.machine!, model.name ?? "design");
    expect(fw.target).toBe("arduino");
    expect(fw.warnings).toEqual([]);
    const ino = fw.files.find((f) => f.path.endsWith(".ino"))!;
    const config = fw.files.find((f) => f.path.endsWith("config.h"))!;
    expect(ino.content).toContain("void setup()");
    expect(config.content).toMatch(/#define STEER_SLOPE\s+0\.2f/);
    expect(fw.pinTable.length).toBeGreaterThan(10);
  });

  const compilers = [
    { name: "g++", cmd: "g++", args: ["-std=gnu++17"] },
    { name: "clang for AVR", cmd: "clang++", args: ["--target=avr", "-mmcu=atmega328p", "-std=gnu++17", "-ffreestanding"] },
  ];
  for (const c of compilers) {
    it.skipIf(!canCompile(c.cmd, c.args))(`firmware compiles with ${c.name} against the mock Arduino core`, () => {
      const [fw] = generateFirmware(model.machine!, model.name ?? "design");
      const dir = mkdtempSync(join(tmpdir(), "kerf-fw-"));
      try {
        for (const f of fw.files) {
          const p = join(dir, f.path);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.content);
        }
        const ino = join(dir, fw.files.find((f) => f.path.endsWith(".ino"))!.path);
        execFileSync(c.cmd, [...c.args, "-fsyntax-only", "-Wall", "-Werror", "-x", "c++", "-include", join(MOCK_CORE, "Arduino.h"), `-I${MOCK_CORE}`, `-I${dirname(ino)}`, ino], { stdio: "pipe" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("builds every part with no interference, blocked screws or failed checks", async () => {
    const r = await fullCheck(TUNNELLER);
    expect([...r.buildErrors.values()]).toEqual([]);
    expect(problems(r.report, ["fail", "warn"])).toEqual([]);
    // it answers both of dan's drill briefs completely
    for (const id of ["sand-drill", "sand-pit"]) {
      const score = scoreBrief(BRIEFS.find((b) => b.id === id)!, r.model, r.report.items);
      expect(score.lines.filter((l) => !l.ok)).toEqual([]);
    }
  }, 900000);
});
