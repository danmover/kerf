// The 3D printer demo's firmware in each flavor Kerf writes: Klipper (the SKR
// Mini E3 V3's default, unchanged), Marlin on the same board, and
// RepRapFirmware on a Duet 3 Mini 5+ with the same printer rewired to it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { machineChecks } from "../src/machine/checks";
import { generateFirmware, type FirmwareOutput } from "../src/machine/firmware";
import { boardFlavors, flavorOf } from "../src/machine/firmware/printer";
import { catalogPart } from "../src/machine/catalog";

const PRINTER = readFileSync(join(__dirname, "../src/demos/printer.kerf"), "utf8");

/** The design with `flavor: "<f>"` in its firmware block. */
const withFlavor = (src: string, f: string) => {
  const out = src.replace(/firmware printer \{ board: (\w+),/, `firmware printer { board: $1, flavor: "${f}",`);
  expect(out).not.toBe(src);
  return out;
};

/** The SKR's ports and the Duet 3 Mini 5+ port each device moves to. */
const DUET_PORTS: Record<string, string> = { XM: "DRIVER_0", YM: "DRIVER_1", ZAM: "DRIVER_2", ZBM: "DRIVER_3", E0M: "DRIVER_4", HE0: "OUT_1", TH0: "TEMP_1", HB: "OUT_0", THB: "TEMP_0", FAN0: "OUT_3", FAN1: "OUT_4", FAN2: "OUT_5", XSTOP: "IO_5", YSTOP: "IO_6", PROBE: "IO_3", USB: "USB", POWER: "POWER", POWER_GND: "POWER_GND" };
/** The same printer with a Duet 3 Mini 5+ in place of the SKR and every cable moved to the Duet's matching port. */
const DUET = (() => {
  const s = PRINTER.replace('lib.controller("skr_mini_e3_v3")', 'lib.controller("duet3_mini5plus")').replace(/\bskr\.([A-Z0-9_]+)/g, (_, p: string) => {
    expect(DUET_PORTS[p], p).toBeDefined();
    return `duet.${DUET_PORTS[p]}`;
  });
  return s.replace(/\bskr\b/g, "duet");
})();

const firmwareOf = (src: string): FirmwareOutput => {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const out = generateFirmware(m.machine!, m.name);
  expect(out.length).toBe(1);
  return out[0];
};
const file = (fw: FirmwareOutput, name: string) => {
  const f = fw.files.find((x) => x.path.endsWith(`/${name}`));
  expect(f, name).toBeDefined();
  return f!.content;
};
/** A `#define NAME value` from a Marlin config, without its comment. */
const define = (h: string, name: string) => {
  const m = new RegExp(`^[ \\t]*#define ${name}(?:[ \\t]+(.*?))?[ \\t]*(?://.*)?$`, "m").exec(h);
  expect(m, name).not.toBeNull();
  return (m![1] ?? "").trim();
};
const nums = (s: string) => s.replace(/[{}]/g, "").split(",").map((v) => Number(v.trim()));
/** The first config.g line that starts with this command, without its comment. */
const gline = (g: string, start: string) => {
  const l = g.split("\n").find((x) => x.startsWith(`${start} `) || x === start);
  expect(l, start).toBeDefined();
  return l!.replace(/\s*;.*$/, "");
};
/** A command's letter parameters: "M92 X80 Y80" → { X: "80", Y: "80" }. */
const params = (line: string) => Object.fromEntries(line.split(/\s+/).slice(1).map((p) => [p[0], p.slice(1)]));

describe("printer firmware flavors", () => {
  it("reads flavor names and each board's firmwares from the catalog", () => {
    expect(flavorOf("Marlin 2")).toBe("marlin");
    expect(flavorOf("RRF")).toBe("reprapfirmware");
    expect(flavorOf("RepRapFirmware 3.5")).toBe("reprapfirmware");
    expect(flavorOf("klipper")).toBe("klipper");
    expect(flavorOf("smoothieware")).toBeUndefined();
    expect(boardFlavors(catalogPart("skr_mini_e3_v3")!)).toEqual(["klipper", "marlin"]);
    expect(boardFlavors(catalogPart("duet3_mini5plus")!)).toEqual(["reprapfirmware"]);
    expect(boardFlavors(catalogPart("arduino_nano")!)).toEqual([]);
  });

  it("writes Klipper for the SKR by default, and when asked", () => {
    for (const src of [PRINTER, withFlavor(PRINTER, "klipper")]) {
      const fw = firmwareOf(src);
      expect(fw.target).toBe("klipper");
      expect(fw.warnings).toEqual([]);
      expect(fw.files.map((f) => f.path)).toEqual(["firmware/printer/printer.cfg", "firmware/printer/README.md"]);
    }
    // the flavor setting changes nothing in the Klipper files
    const a = firmwareOf(PRINTER);
    const b = firmwareOf(withFlavor(PRINTER, "klipper"));
    expect(b.files).toEqual(a.files);
  });

  it("warns about a flavor it does not know and writes the board's default", () => {
    const fw = firmwareOf(withFlavor(PRINTER, "smoothieware"));
    expect(fw.target).toBe("klipper");
    expect(fw.warnings).toEqual([expect.stringMatching(/flavor "smoothieware" is not one Kerf writes .*writing Klipper/)]);
  });

  it("writes nothing for RepRapFirmware on the SKR, and names the board that runs it", () => {
    const fw = firmwareOf(withFlavor(PRINTER, "rrf"));
    expect(fw.target).toBe("none");
    expect(fw.files).toEqual([]);
    expect(fw.summary).toMatch(/cannot write RepRapFirmware for the BIGTREETECH SKR Mini E3 V3\.0: it runs Klipper or Marlin/);
    expect(fw.summary).toContain("Duet 3 Mini 5+");
    expect(fw.summary).toContain("duet3_mini5plus");
    expect(fw.warnings).toEqual([fw.summary]);
  });

  describe("Marlin on the SKR Mini E3 V3", () => {
    const fw = firmwareOf(withFlavor(PRINTER, "Marlin 2"));
    const h = file(fw, "Configuration.h");
    const adv = file(fw, "Configuration_adv.h");

    it("is generated with no warnings", () => {
      expect(fw.target).toBe("marlin");
      expect(fw.warnings).toEqual([]);
      expect(fw.files.map((f) => f.path)).toEqual(["firmware/printer/Configuration.h", "firmware/printer/Configuration_adv.h", "firmware/printer/README.md"]);
      expect(define(h, "CONFIGURATION_H_VERSION")).toBe("02010206");
      expect(define(adv, "CONFIGURATION_ADV_H_VERSION")).toBe("02010206");
      expect(define(h, "MOTHERBOARD")).toBe("BOARD_BTT_SKR_MINI_E3_V3_0");
      expect(define(h, "SERIAL_PORT")).toBe("2");
      expect(define(h, "SERIAL_PORT_2")).toBe("-1");
      for (const ax of ["X", "Y", "Z", "E0"]) expect(define(h, `${ax}_DRIVER_TYPE`)).toBe("TMC2209");
      expect(file(fw, "README.md")).toContain("STM32G0B1RE_btt");
    });

    it("has the right steps/mm, speeds and accelerations", () => {
      const steps = nums(define(h, "DEFAULT_AXIS_STEPS_PER_UNIT"));
      expect(steps.slice(0, 3)).toEqual([80, 80, 400]);
      // 200 steps × 16 microsteps × 50:17 gearing / 22.68 mm
      expect(steps[3]).toBeCloseTo((3200 * 50) / 17 / 22.68, 1);
      expect(nums(define(h, "DEFAULT_MAX_FEEDRATE")).slice(0, 2)).toEqual([300, 300]);
      expect(nums(define(h, "DEFAULT_MAX_ACCELERATION")).slice(0, 2)).toEqual([3000, 3000]);
      expect(define(h, "DEFAULT_ACCELERATION")).toBe("3000");
      expect(define(h, "JUNCTION_DEVIATION_MM")).toBe("0.013");
      expect(h).not.toMatch(/^#define CLASSIC_JERK/m);
      expect(define(h, "X_BED_SIZE")).toBe("220");
      expect(define(h, "Z_MAX_POS")).toBe("250");
    });

    it("sets the heaters, thermistors and starting PID values", () => {
      expect(define(h, "TEMP_SENSOR_0")).toBe("5"); // the E3D V6's Semitec 104NT
      expect(define(h, "TEMP_SENSOR_BED")).toBe("1"); // EPCOS 100k
      expect(Number(define(h, "HEATER_0_MAXTEMP"))).toBeLessThanOrEqual(275);
      expect(define(h, "BED_MAXTEMP")).toBe("115");
      expect(h).toMatch(/^#define PIDTEMP$/m);
      expect(h).toMatch(/^#define PIDTEMPBED$/m);
      expect(Number(define(h, "DEFAULT_KP"))).toBeGreaterThan(0);
      expect(Number(define(h, "DEFAULT_BED_KD"))).toBeGreaterThan(0);
      expect(h).toMatch(/^#define THERMAL_PROTECTION_HOTENDS/m);
      expect(h).toMatch(/^#define THERMAL_PROTECTION_BED/m);
      expect(define(h, "EXTRUDE_MINTEMP")).toBe("170");
    });

    it("sets the BLTouch, homes Z on it in the middle of the bed and levels where it reaches", () => {
      expect(h).toMatch(/^#define BLTOUCH\b/m);
      expect(h).toMatch(/^#define USE_PROBE_FOR_Z_HOMING\b/m);
      expect(h).not.toMatch(/^#define USE_ZMIN_PLUG/m);
      expect(nums(define(h, "NOZZLE_TO_PROBE_OFFSET"))).toEqual([-38, 0, 0]);
      expect(define(h, "Z_MIN_PROBE_ENDSTOP_INVERTING")).toBe("false");
      // Marlin's Z_SAFE_HOMING point is where the probe goes: the middle of the bed
      expect(define(h, "Z_SAFE_HOMING_X_POINT")).toBe("110");
      expect(define(h, "Z_SAFE_HOMING_Y_POINT")).toBe("110");
      expect(h).toMatch(/^#define AUTO_BED_LEVELING_BILINEAR\b/m);
      expect(define(h, "GRID_MAX_POINTS_X")).toBe("5");
      expect(define(h, "PROBING_MARGIN")).toBe("10");
    });

    it("runs the motors at the firmware block's RMS currents", () => {
      expect(define(adv, "X_CURRENT")).toBe("900");
      expect(define(adv, "Y_CURRENT")).toBe("1000");
      expect(define(adv, "Z_CURRENT")).toBe("1000"); // two motors in parallel on one driver
      expect(define(adv, "E0_CURRENT")).toBe("500");
      expect(define(adv, "X_RSENSE")).toBe("0.11");
      expect(define(adv, "CHOPPER_TIMING")).toBe("CHOPPER_DEFAULT_24V");
    });

    it("sets linear advance, the fans and the SD card", () => {
      expect(adv).toMatch(/^#define LIN_ADVANCE\b/m);
      expect(define(adv, "ADVANCE_K")).toBe("0");
      expect(define(adv, "E0_AUTO_FAN_PIN")).toBe("FAN1_PIN");
      expect(define(adv, "CONTROLLER_FAN_PIN")).toBe("FAN2_PIN");
      expect(define(adv, "BLOCK_BUFFER_SIZE")).toBe("16");
      expect(adv).toMatch(/^#define ARC_SUPPORT\b/m);
      expect(h).toMatch(/^#define EEPROM_SETTINGS\b/m);
      expect(h).toMatch(/^#define SDSUPPORT\b/m);
    });

    it("takes pressure_advance, jerk and junction_deviation from the firmware block", () => {
      const src = PRINTER.replace("e_run_current: 0.5 }", "e_run_current: 0.5, pressure_advance: 0.05, jerk: 8 }");
      const t = firmwareOf(withFlavor(src, "marlin"));
      expect(define(file(t, "Configuration_adv.h"), "ADVANCE_K")).toBe("0.05");
      const th = file(t, "Configuration.h");
      expect(th).toMatch(/^#define CLASSIC_JERK\b/m);
      expect(define(th, "DEFAULT_XJERK")).toBe("8");
      expect(th).not.toMatch(/^#define JUNCTION_DEVIATION_MM/m);
      const j = firmwareOf(withFlavor(PRINTER.replace("e_run_current: 0.5 }", "e_run_current: 0.5, junction_deviation: 0.02 }"), "marlin"));
      expect(define(file(j, "Configuration.h"), "JUNCTION_DEVIATION_MM")).toBe("0.02");
    });

    it("warns when a device is not on the port Marlin's pins file uses for it", () => {
      // swap the part and hotend fans: Klipper names the pins, Marlin cannot
      const src = withFlavor(PRINTER, "marlin").replace("wire skr.FAN0 -> part_fan.PLUG", "wire skr.FAN1 -> part_fan.PLUG").replace("wire skr.FAN1 -> hotend_fan.PLUG", "wire skr.FAN0 -> hotend_fan.PLUG");
      const t = firmwareOf(src);
      expect(t.warnings).toEqual([
        expect.stringMatching(/^part_fan \(part cooling fan\) is on skr\.FAN1, but Marlin drives the part cooling fan from skr\.FAN0/),
        expect.stringMatching(/^hotend_fan \(hotend fan\) is on skr\.FAN0, which Marlin keeps for the part cooling fan/),
      ]);
      expect(define(file(t, "Configuration_adv.h"), "E0_AUTO_FAN_PIN")).toBe("FAN0_PIN");
      expect(firmwareOf(src.replace(/flavor: "marlin", /, "")).warnings).toEqual([]);
    });
  });

  describe("RepRapFirmware on a Duet 3 Mini 5+", () => {
    const fw = firmwareOf(DUET);
    const g = file(fw, "config.g");

    it("is the Duet's default, generated with no warnings", () => {
      expect(fw.target).toBe("reprapfirmware");
      expect(fw.warnings).toEqual([]);
      expect(fw.files.map((f) => f.path)).toEqual(
        ["config.g", "homex.g", "homey.g", "homez.g", "homeall.g", "deployprobe.g", "retractprobe.g"].map((n) => `firmware/printer/sys/${n}`).concat("firmware/printer/README.md"),
      );
      expect(firmwareOf(withFlavor(DUET, "reprapfirmware")).files).toEqual(fw.files);
    });

    it("passes the wiring and engineering checks without new failures", () => {
      const m = evaluate(DUET);
      expect(machineChecks(m.machine!).filter((i) => i.status === "fail").map((i) => `${i.title}: ${i.detail}`)).toEqual([]);
    });

    it("maps every motor to the driver it is cabled to, with steps, speeds and peak currents", () => {
      expect(params(gline(g, "M584"))).toEqual({ X: "0.0", Y: "0.1", Z: "0.2:0.3", E: "0.4" });
      for (const d of [0, 1, 2, 3, 4]) expect(g).toMatch(new RegExp(`^M569 P0\\.${d} S1 D[23]\\b`, "m"));
      expect(gline(g, "M350")).toBe("M350 X16 Y16 Z16 E16 I1");
      const steps = params(gline(g, "M92"));
      expect([steps.X, steps.Y, steps.Z].map(Number)).toEqual([80, 80, 400]);
      expect(Number(steps.E)).toBeCloseTo((3200 * 50) / 17 / 22.68, 1);
      expect(params(gline(g, "M566"))).toEqual({ X: "900", Y: "900", Z: "12", E: "120" });
      expect(params(gline(g, "M203"))).toEqual({ X: "18000", Y: "18000", Z: "300", E: "3600" });
      expect(params(gline(g, "M201"))).toEqual({ X: "3000", Y: "3000", Z: "100", E: "5000" });
      expect(gline(g, "M204")).toBe("M204 P3000 T3000");
      // peak = RMS × √2: 0.9, 1.0, 1.0 (each Z motor has its own driver here) and 0.5 A
      expect(params(gline(g, "M906"))).toEqual({ X: "1270", Y: "1410", Z: "1410", E: "710", I: "30" });
      for (const [ax, v] of Object.entries(params(gline(g, "M906")))) if (ax !== "I") expect(Number(v)).toBeLessThanOrEqual(2000);
      expect(gline(g, "M208")).toBe("M208 X0:220 Y0:220 Z0:250");
    });

    it("reads the endstops and the BLTouch on the IO ports they are cabled to", () => {
      expect(gline(g, "M574 X1")).toBe('M574 X1 S1 P"io5.in"');
      expect(gline(g, "M574 Y1")).toBe('M574 Y1 S1 P"io6.in"');
      expect(gline(g, "M574 Z1")).toBe("M574 Z1 S2");
      expect(gline(g, "M950 S0")).toBe('M950 S0 C"io3.out"');
      expect(gline(g, "M558")).toBe('M558 P9 C"io3.in" H5 F120 T6000');
      expect(params(gline(g, "G31"))).toEqual({ P: "25", X: "-38", Y: "0", Z: "0" });
      // mesh points are probe positions: the nozzle must stay inside its travel when the probe is there
      const mesh = params(gline(g, "M557"));
      expect(mesh.P).toBe("5");
      for (const [ax, off, size] of [["X", -38, 220], ["Y", 0, 220]] as const) {
        const [lo, hi] = mesh[ax].split(":").map(Number);
        expect(lo - off).toBeGreaterThanOrEqual(0);
        expect(hi - off).toBeLessThanOrEqual(size);
        expect(hi - lo).toBeGreaterThanOrEqual(0.7 * size);
      }
      expect(file(fw, "deployprobe.g")).toMatch(/^M280 P0 S10\b/m);
      expect(file(fw, "retractprobe.g")).toMatch(/^M280 P0 S90\b/m);
    });

    it("sets the heaters and thermistors on the outputs they are cabled to", () => {
      expect(gline(g, "M308 S0")).toBe('M308 S0 P"temp0" Y"thermistor" A"Bed" T100000 B4613 C8.93e-8');
      expect(gline(g, "M308 S1")).toBe('M308 S1 P"temp1" Y"thermistor" A"Hotend" T100000 B4725 C7.06e-8');
      expect(gline(g, "M950 H0")).toBe('M950 H0 C"out0" T0');
      expect(gline(g, "M950 H1")).toBe('M950 H1 C"out1" T1');
      expect(gline(g, "M140")).toBe("M140 H0");
      expect(gline(g, "M143 H0")).toBe("M143 H0 S115");
      expect(Number(params(gline(g, "M143 H1")).S)).toBeLessThanOrEqual(275);
      expect(g).not.toMatch(/^M307/m); // tuned with M303 and saved by M500
      expect(gline(g, "M302")).toBe("M302 S170 R170");
    });

    it("sets the fans, the tool and pressure advance", () => {
      expect(gline(g, "M950 F0")).toBe('M950 F0 C"out3" Q500');
      expect(gline(g, "M106 P0")).toBe('M106 P0 C"Part" S0 H-1');
      expect(gline(g, "M950 F1")).toBe('M950 F1 C"out4" Q500');
      expect(gline(g, "M106 P1")).toBe('M106 P1 C"Hotend" S1 H1 T45');
      expect(gline(g, "M950 F2")).toBe('M950 F2 C"out5" Q500');
      expect(gline(g, "M563")).toBe('M563 P0 S"Hotend" D0 H1 F0');
      expect(gline(g, "M572")).toBe("M572 D0 S0");
      expect(g).toMatch(/^M501\b/m);
      expect(g.split("\n").filter((l) => l.trim()).at(-1)).toMatch(/^T0\b/);
    });

    it("homes X and Y on their switches and Z on the probe over the middle of the bed", () => {
      const hx = file(fw, "homex.g");
      expect(hx).toMatch(/^G91\b/m);
      expect(hx).toMatch(/^G1 H1 X-225 F\d+/m);
      expect(hx).toMatch(/^G90\b/m);
      expect(file(fw, "homey.g")).toMatch(/^G1 H1 Y-225 F\d+/m);
      for (const n of ["homez.g", "homeall.g"]) {
        const z = file(fw, n);
        // the nozzle goes where the probe lands on the bed centre (the probe is 38 mm left of it)
        expect(z, n).toMatch(/^G1 X148 Y110 F\d+/m);
        expect(z, n).toMatch(/^G30\b/m);
      }
      expect(file(fw, "homeall.g")).toMatch(/^G1 H1 X-225 Y-225 F\d+/m);
    });

    it("writes nothing for Klipper or Marlin on the Duet", () => {
      for (const f of ["klipper", "marlin"]) {
        const t = firmwareOf(withFlavor(DUET, f));
        expect(t.target).toBe("none");
        expect(t.summary).toContain("BIGTREETECH SKR Mini E3 V3.0");
      }
    });
  });

  it("keeps a hostile design name or text setting on one line of every Marlin and RepRapFirmware file", () => {
    const evil = 'Evil "x"\n[heater_bed]\nmax_temp: 400\nint injected = 1; ??/\\';
    for (const src of [withFlavor(PRINTER, "marlin"), DUET]) {
      const m = evaluate(src);
      const plain = generateFirmware(m.machine!, "Plain");
      const machine = structuredClone(m.machine!);
      for (const fw of machine.firmware) fw.settings = { ...fw.settings, kinematics: `cartesian\n${evil}` };
      const bad = generateFirmware(machine, evil);
      expect(bad[0].files.length).toBeGreaterThan(2);
      bad.forEach((fw, i) =>
        fw.files.forEach((f, j) => {
          const lines = f.content.split("\n");
          if (!f.path.endsWith(".md")) expect(lines.length, f.path).toBe(plain[i].files[j].content.split("\n").length);
          for (const l of lines.filter((x) => x.includes("Evil"))) {
            if (f.path.endsWith(".h")) {
              // a C comment can't end in a backslash (it would swallow the next line); the one string is escaped
              if (l.trimStart().startsWith("//")) expect(l.endsWith("\\"), l).toBe(false);
              else expect(l, l).toMatch(/^#define CUSTOM_MACHINE_NAME "Evil \\"x\\" \[heater_bed\] max_temp: 400 int injected = 1; \\\?\\\?\/\\\\"$/);
            }
            // in G-code the name only appears in comments and as M550's name, made of letters, digits and hyphens
            if (f.path.endsWith(".g")) expect(l.startsWith(";") || /^M550 P"Evil-x-heater-bed[A-Za-z0-9-]*" +;/.test(l), l).toBe(true);
          }
        }),
      );
    }
  });
});
