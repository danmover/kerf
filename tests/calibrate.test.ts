import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { runSpec } from "../src/sim/build";
import { applyFits, benchScenario, calibrateUnavailable, fitBench, parseBench } from "../src/sim/calibrate";

const SOURCE = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");
function benchLog(src: string) {
  const m = evaluate(`${src}\n${benchScenario(evaluate(src))}\n`);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const def = m.scenarios!.at(-1)!;
  const v = runSpec({ ...def.spec, variants: ["expected"] }, m.machine!, m.name).variants[0];
  expect(v.error).toBeUndefined();
  return { m, v, text: v.serial.filter((l) => l.dir === "out").map((l) => l.text).join("\n") };
}

describe("calibrating from a bench test", () => {
  it("the simulated bench test gives back the catalog numbers the simulation runs on", () => {
    const { m, text } = benchLog(SOURCE);
    const log = parseBench(text);
    expect(log.complete).toBe(true);
    expect(log.motors.map((x) => x.name)).toEqual(["m_front", "m_rear"]);
    const { fits, problems } = fitBench(m, log);
    expect(problems).toEqual([]);
    const front = fits.find((f) => f.comp === "m_front")!;
    const get = (k: string) => front.fields.find((f) => f.key === k)!;
    // goBILDA 5203 188:1: 9.2 A stall, 0.25 A free, 30 rpm at 12 V
    expect(get("i_stall").measured).toBeGreaterThan(9.2 * 0.85);
    expect(get("i_stall").measured).toBeLessThan(9.2 * 1.1);
    expect(get("i_free").measured).toBeCloseTo(0.25, 1);
    expect(get("rpm_free").measured).toBeGreaterThan(30 * 0.9);
    expect(get("rpm_free").measured).toBeLessThan(30 * 1.1);
    // the pack's resistance the simulation used, read back from the sag (the wiring adds a little)
    const bat = fits.find((f) => f.kind === "battery")!.fields[0];
    expect(bat.measured / bat.before).toBeGreaterThan(0.85);
    expect(bat.measured / bat.before).toBeLessThan(1.15);
  }, 120_000);

  it("finds a weaker motor than the catalog's once it is measured, and writes it back to the design", () => {
    const weak = SOURCE.replace(/(component m_front = lib\.gearmotor\("gobilda_5203_188"\) \{)/, "$1\n  measured: sim.measured(i_stall: 7A, rpm_free: 26rpm)");
    const { m, v, text } = benchLog(weak);
    expect(v.assumptions).toContain("m_front: measured on the real part (i_stall 7, rpm_free 26), in place of the catalog's numbers");
    const front = fitBench(m, parseBench(text)).fits.find((f) => f.comp === "m_front")!;
    expect(front.fields.find((f) => f.key === "i_stall")!.before).toBe(7);
    const get = (k: string) => front.fields.find((f) => f.key === k)!.measured;
    expect(get("i_stall")).toBeGreaterThan(7 * 0.85);
    expect(get("i_stall")).toBeLessThan(7 * 1.1);
    expect(get("rpm_free")).toBeGreaterThan(26 * 0.9);
    expect(get("rpm_free")).toBeLessThan(26 * 1.1);
    const next = applyFits(SOURCE, [front]);
    expect(next).toMatch(/component m_front = lib\.gearmotor\("gobilda_5203_188"\) \{[^}]*measured: sim\.measured\(i_stall: [\d.]+A, i_free: [\d.]+A, rpm_free: [\d.]+rpm, t_stall: [\d.]+Nm\)/);
    const m2 = evaluate(next);
    expect(m2.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m2.machine!.components.find((c) => c.name === "m_front")!.measured).toMatchObject({ i_stall: get("i_stall"), rpm_free: get("rpm_free") });
    // torque goes back in as N·m and is simulated in N·mm, like the catalog's
    expect(m2.machine!.components.find((c) => c.name === "m_front")!.measured!.t_stall).toBeCloseTo(get("t_stall"), 6);
  }, 120_000);

  it("reads a pasted serial log with timestamps and other lines in it, and says what is missing", () => {
    const log = parseBench(["12:01:02.345 -> state: waiting", "12:01:03.001 -> cal start: hold the machine still", "cal rest vbat=12.410", "cal m_front peak_amps=8.95 peak_vbat=12.080 free_amps=0.260 free_rpm=29.10 free_vbat=12.380", "cal m_rear peak_amps=-1.00 peak_vbat=12.100 free_amps=-1.000 free_rpm=-1.00 free_vbat=12.390"].join("\n"));
    expect(log.restVbat).toBe(12.41);
    expect(log.complete).toBe(false);
    expect(log.motors[1]).toMatchObject({ name: "m_rear", peakAmps: undefined, freeRpm: undefined });
    const { fits, problems } = fitBench(evaluate(SOURCE), log);
    expect(fits.map((f) => f.comp)).toEqual(["m_front", "bat"]);
    expect(problems).toEqual([expect.stringMatching(/stops before "cal end"/), expect.stringMatching(/^m_rear: no current readings/)]);
    // the battery sagged 0.33 V at 8.95 A: about 37 mΩ with its leads
    expect(fits[1].fields[0].measured).toBeCloseTo(36.9, 0);
  });

  it("says when a design has nothing the bench test can measure", () => {
    expect(calibrateUnavailable(evaluate(SOURCE))).toBeNull();
    const amp = evaluate(readFileSync(join(__dirname, "../src/demos/practice-amp.kerf"), "utf8"));
    expect(calibrateUnavailable(amp)).toMatch(/no gearmotors/);
  });

  it("checks measured: values against the part", () => {
    const bad = (prop: string) => evaluate(SOURCE.replace(/(component m_front = lib\.gearmotor\("gobilda_5203_188"\) \{)/, `$1\n  measured: ${prop}`)).diagnostics.filter((d) => d.severity === "error").map((d) => d.message)[0];
    expect(bad("sim.measured(r_int: 9mOhm)")).toMatch(/r_int is not measured on a gearmotor\. Use i_free, i_stall, rpm_free, t_stall/);
    expect(bad("2A")).toMatch(/measured: should be sim\.measured/);
    expect(bad("sim.measured(i_free: 0A)")).toMatch(/above zero/);
    const bat = evaluate(SOURCE.replace(/lib\.battery\("lipo_3s_2200"\) \{/, 'lib.battery("lipo_3s_2200") { measured: sim.measured(r_int: 36mOhm),'));
    expect(bat.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // the whole pack's 36 mΩ is 12 mΩ a cell for the simulation's battery
    expect(bat.machine!.components.find((c) => c.name === "bat")!.measured!.r_int_mohm).toBeCloseTo(12, 9);
  });
});
