// The 3D printer demo is one of the acceptance tests for complete machines:
// it must evaluate cleanly, pass the wiring and engineering checks, generate a
// Klipper config with the board's real pins and sane mechanics, and build as
// real solids that do not collide anywhere in the print volume.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as R from "replicad";
import { evaluate } from "../src/lang/evaluator";
import { machineChecks } from "../src/machine/checks";
import { BRIEFS, scoreBrief } from "../src/machine/briefs";
import { generateFirmware } from "../src/machine/firmware";
import { bomRows } from "../src/persist/files";
import { fullCheck, problems, type FullCheck } from "./helpers/fullcheck";

const PRINTER = readFileSync(join(__dirname, "../src/demos/printer.kerf"), "utf8");

/** The design with the toolhead and bed moved to another printer position. */
const at = (x: number, y: number, z: number) =>
  PRINTER.replace(/param show_x\s*=\s*\d+mm/, `param show_x = ${x}mm`).replace(/param show_y\s*=\s*\d+mm/, `param show_y = ${y}mm`).replace(/param show_z\s*=\s*\d+mm/, `param show_z = ${z}mm`);

/** printer.cfg as section → key → value, with trailing comments removed. */
function sections(cfg: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  let cur: Record<string, string> | undefined;
  for (const raw of cfg.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) out.set(head[1], (cur = {}));
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]] = kv[2].trim();
  }
  return out;
}
const pair = (s: string) => s.split(",").map((v) => Number(v.trim()));

// Warnings the design is expected to raise, and why each is genuine:
// - the 220 W bed draws 9.2 A of the SKR's 10 A bed output (the usual Ender-3 load; the test plan checks the MOSFET temperature);
// - bed, hotend, motors and fans together are about 92 % of the 14.6 A supply when everything heats at once.
// the toolhead's carriage-to-rail and extruder-to-motor screws are not drawn yet: the BMG and the carriage cover each
// other's hex-key paths, so they need a toolhead layout with access holes first
const EXPECTED_WARNINGS = [/^skr\.HB near its limit/, /^Power budget: V24/, /^x_carriage has 5 screw holes with nothing in them/, /^extruder_mount has 5 screw holes with nothing in them/];

describe("3D printer demo", () => {
  const model = evaluate(PRINTER);

  it("evaluates without errors and meets its requirements", () => {
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    // geometric requirements stay pending until the solids are built (checked below)
    expect(model.requirements.filter((r) => r.status !== "pass" && !(r.status === "pending" && r.geo.length)).map((r) => `${r.label}: ${r.detail}`)).toEqual([]);
    expect(model.requirements.length).toBeGreaterThanOrEqual(25);
    expect(model.parts.filter((p) => p.kind === "part").length).toBeGreaterThanOrEqual(20);
  });

  it("passes the wiring and engineering checks", () => {
    const items = machineChecks(model.machine!);
    expect(items.filter((i) => i.status === "fail").map((i) => `${i.title}: ${i.detail}`)).toEqual([]);
    for (const w of items.filter((i) => i.status === "warn")) expect(EXPECTED_WARNINGS.some((re) => re.test(w.title)), `${w.title}: ${w.detail}`).toBe(true);
    // every calculator the brief asks for is used
    const fns = new Set(model.machine!.calcs.map((c) => c.fn));
    for (const fn of ["stepper_axis", "lead_screw", "heater_warmup", "print_speed", "wire_gauge"]) expect(fns.has(fn), fn).toBe(true);
  });

  it("lists every bought part with a price and somewhere to buy it", () => {
    const rows = bomRows(model).filter((r) => r.kind === "Buy" && r.catalogId);
    expect(rows.length).toBeGreaterThan(15);
    for (const r of rows) {
      expect(r.price, r.description).toBeGreaterThan(0);
      expect(r.links.length, r.description).toBeGreaterThan(0);
    }
  });

  describe("printer.cfg", () => {
    const [fw] = generateFirmware(model.machine!, model.name);
    const cfg = fw.files.find((f) => f.path.endsWith("printer.cfg"))!.content;
    const s = sections(cfg);
    const get = (sec: string) => {
      const v = s.get(sec);
      expect(v, `[${sec}]`).toBeDefined();
      return v!;
    };

    it("is generated for Klipper with no warnings", () => {
      expect(fw.target).toBe("klipper");
      expect(fw.warnings).toEqual([]);
      expect(get("printer")).toMatchObject({ kinematics: "cartesian", max_velocity: "300", max_accel: "3000" });
    });

    it("uses the SKR Mini E3 V3's pins from BIGTREETECH's reference config", () => {
      expect(get("stepper_x")).toMatchObject({ step_pin: "PB13", dir_pin: "!PB12", enable_pin: "!PB14", endstop_pin: "^PC0", position_endstop: "0", position_max: "220" });
      expect(get("stepper_y")).toMatchObject({ step_pin: "PB10", dir_pin: "!PB2", enable_pin: "!PB11", endstop_pin: "^PC1", position_endstop: "0", position_max: "220" });
      expect(get("stepper_z")).toMatchObject({ step_pin: "PB0", dir_pin: "PC5", enable_pin: "!PB1", endstop_pin: "probe:z_virtual_endstop", position_max: "250" });
      expect(get("extruder")).toMatchObject({ step_pin: "PB3", dir_pin: "!PB4", enable_pin: "!PD1", heater_pin: "PC8", sensor_pin: "PA0" });
      expect(get("heater_bed")).toMatchObject({ heater_pin: "PC9", sensor_pin: "PC4" });
      expect(get("fan")).toMatchObject({ pin: "PC6" });
      expect(get("heater_fan hotend_fan")).toMatchObject({ pin: "PC7", heater: "extruder" });
      expect(get("controller_fan controller_fan")).toMatchObject({ pin: "PB15" });
      expect(get("bltouch")).toMatchObject({ sensor_pin: "^PC14", control_pin: "PA1" });
      const addr: Record<string, string> = { stepper_x: "0", stepper_y: "2", stepper_z: "1", extruder: "3" };
      for (const [sec, a] of Object.entries(addr)) expect(get(`tmc2209 ${sec}`)).toMatchObject({ uart_pin: "PC11", tx_pin: "PC10", uart_address: a });
    });

    it("has the right rotation distances", () => {
      expect(get("stepper_x").rotation_distance).toBe("40");
      expect(get("stepper_y").rotation_distance).toBe("40");
      expect(get("stepper_z").rotation_distance).toBe("8");
      expect(get("extruder")).toMatchObject({ rotation_distance: "22.68", gear_ratio: "50:17" });
    });

    it("runs the motors at sane currents", () => {
      // [section, motors on the driver, motor rating in A]
      const motors: [string, number, number][] = [["stepper_x", 1, 1.7], ["stepper_y", 1, 1.7], ["stepper_z", 2, 1.7], ["extruder", 1, 1.0]];
      for (const [sec, n, rated] of motors) {
        const run = Number(get(`tmc2209 ${sec}`).run_current);
        expect(run, sec).toBeGreaterThanOrEqual(0.4);
        expect(run, sec).toBeLessThanOrEqual(1.0); // BTT: at most about 1 A on this board's drivers
        expect(run / n, sec).toBeLessThanOrEqual(0.85 * rated);
      }
    });

    it("homes Z and meshes the bed where the probe can reach", () => {
      const probe = get("bltouch");
      const off = [Number(probe.x_offset), Number(probe.y_offset)];
      expect(off).toEqual([-38, 0]);
      const size = [220, 220];
      const home = pair(get("safe_z_home").home_xy_position);
      for (const i of [0, 1]) {
        expect(home[i]).toBeGreaterThanOrEqual(0);
        expect(home[i]).toBeLessThanOrEqual(size[i]);
        // the probe, not the nozzle, lands on the middle of the bed
        expect(Math.abs(home[i] + off[i] - size[i] / 2)).toBeLessThanOrEqual(1);
      }
      const lo = pair(get("bed_mesh").mesh_min);
      const hi = pair(get("bed_mesh").mesh_max);
      for (const i of [0, 1]) {
        // mesh points are probe positions: the nozzle must be inside its travel when the probe is there
        expect(lo[i] - off[i]).toBeGreaterThanOrEqual(0);
        expect(hi[i] - off[i]).toBeLessThanOrEqual(size[i]);
        expect(lo[i]).toBeGreaterThanOrEqual(0);
        expect(hi[i]).toBeLessThanOrEqual(size[i]);
        expect(hi[i] - lo[i]).toBeGreaterThanOrEqual(0.7 * size[i]);
      }
    });

    it("parks without lifting past the top of the Z travel", () => {
      expect(cfg).toMatch(/axis_maximum\.z/);
    });
  });

  describe("geometry", () => {
    const expectClean = (r: FullCheck) => {
      expect([...r.buildErrors.values()]).toEqual([]);
      expect(problems(r.report, ["fail"])).toEqual([]);
      for (const w of r.report.items.filter((i) => i.status === "warn")) expect(EXPECTED_WARNINGS.some((re) => re.test(w.title)), `${w.title}: ${w.detail}`).toBe(true);
    };

    it("builds every part, with no collisions, unreachable screws or failed requirements", async () => {
      const r = await fullCheck(PRINTER);
      expectClean(r);
      // the geometric requirements are measured on the built solids
      const reqs = r.report.items.filter((i) => i.category === "requirement");
      expect(reqs.filter((i) => i.status !== "pass").map((i) => `${i.title}: ${i.detail}`)).toEqual([]);

      // every printed part is one valid solid
      const oc = R.getOC() as unknown as { BRepCheck_Analyzer: new (s: unknown, geom: boolean, par: boolean) => { IsValid(): boolean; delete(): void } };
      // (process: false parts are bought: the silicone bed spacers)
      const printed = r.model.parts.filter((p) => p.kind === "part" && !p.processNone);
      for (const p of printed) {
        const e = r.core.get(p.hash)!;
        const shape = e.shape as unknown as { solids: unknown[]; wrapped: unknown };
        expect(shape.solids.length, p.name).toBe(1);
        expect(e.volume, p.name).toBeGreaterThan(1000);
        const check = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
        expect(check.IsValid(), p.name).toBe(true);
        check.delete();
      }
      expect(["PETG", "ABS"]).toEqual(expect.arrayContaining([...new Set(printed.map((p) => p.material))]));

      // it answers the printer brief completely (requirement statuses from the built geometry)
      const resolved = { ...r.model, requirements: r.model.requirements.map((q) => ({ ...q, status: reqs.find((i) => i.id === `req:${q.label}`)?.status === "pass" ? ("pass" as const) : q.status })) };
      const score = scoreBrief(BRIEFS.find((b) => b.id === "printer")!, resolved, r.report.items);
      expect(score.lines.filter((l) => !l.ok)).toEqual([]);
    }, 300000);

    it("does not collide at the corners of the print volume", async () => {
      // home corner (bed back, toolhead left, nozzle on the bed) and the opposite top corner
      for (const [x, y, z] of [[0, 0, 0], [220, 220, 250]]) expectClean(await fullCheck(at(x, y, z)));
    }, 300000);
  });
});
