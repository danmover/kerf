// Faults in scenarios: a jammed motor, a part unplugged, a loose or
// flickering wire, a frozen sensor and an old battery, run against the Sand
// Tunneller's real firmware on the bench, and `like:` reusing a scenario.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { runSpec } from "../src/sim/build";
import type { ScenarioDef } from "../src/sim/scenario";

const SOURCE = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");

function withScenario(block: string) {
  const m = evaluate(`${SOURCE}\n${block}\n`);
  return { m, errors: m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) };
}

function scenario(block: string): ScenarioDef {
  const { m, errors } = withScenario(block);
  expect(errors).toEqual([]);
  return m.scenarios!.at(-1)!;
}

const model = evaluate(SOURCE);
const run = (def: ScenarioDef) => runSpec({ ...def.spec, variants: ["expected"] }, model.machine!, model.name).variants[0];

describe("fault blocks", () => {
  it("reads faults and checks them against the machine's parts and pins", () => {
    const def = scenario(`scenario "Jam" { world: sim.bench() firmware: brain duration: 2min faults: [sim.jam(m_front, at: 40s), sim.loose("m_rear.ENC_A", at: 50s, until: 60s, flicker: true)] expect "x": faults == 0 }`);
    expect(def.spec.faults).toEqual([
      { kind: "jam", target: "m_front", at: 40 },
      { kind: "loose", target: "m_rear.ENC_A", at: 50, until: 60, flicker: true },
    ]);
    expect(withScenario(`scenario "Bad" { world: sim.bench() firmware: brain faults: sim.loose("m_front.NOPE", at: 1s) expect "x": faults == 0 }`).errors[0]).toMatch(/m_front has no pin NOPE\. Its pins: .*ENC_A/);
    expect(withScenario(`scenario "Bad" { world: sim.bench() firmware: brain faults: sim.jam(bat, at: 1s) expect "x": faults == 0 }`).errors[0]).toMatch(/sim\.jam\(\) is for a gearmotor or linear actuator, and bat is a battery/);
    expect(withScenario(`scenario "Bad" { world: sim.bench() firmware: brain faults: sim.jam(m_front, at: 5s, until: 2s) expect "x": faults == 0 }`).errors[0]).toMatch(/until must be later than at/);
  });

  it("like: takes another scenario's world, machine and firmware, and changes only what it sets", () => {
    const def = scenario(`scenario "Front jams in the pit" { like: "Cross the pit" faults: sim.jam(m_front, at: 2min) variants: "expected" expect "Stops": fault_stopped }`);
    const base = model.scenarios!.find((s) => s.label === "Cross the pit")!;
    expect(def.spec.world).toEqual(base.spec.world);
    expect(def.spec.duration).toBe(base.spec.duration);
    expect(def.spec.firmware).toBe("brain");
    expect(def.spec.variants).toEqual(["expected"]);
    expect(def.spec.faults).toHaveLength(1);
    expect(withScenario(`scenario "X" { like: "Cross the pt" expect "x": faults == 0 }`).errors[0]).toMatch(/No scenario "Cross the pt" above this one\. Did you mean "Cross the pit"/);
  });
});

describe("faults on the bench, with the real firmware", () => {
  // a 5 s start delay instead of two minutes, so the runs get to work quickly
  const bench = (label: string, faults: string, extra = "") =>
    scenario(`scenario "${label}" { world: sim.bench() firmware: brain duration: 90s config: sim.config(START_DELAY_S: 5) faults: ${faults} ${extra} expect "x": faults == 0 }`);
  const said = (v: ReturnType<typeof run>, re: RegExp) => v.serial.some((l) => l.dir === "out" && re.test(l.text));

  it("a jammed front screw: the firmware backs off, retries, then stops and says it is stuck", () => {
    const v = run(bench("Front jams", "sim.jam(m_front, at: 20s)"));
    expect(v.error).toBeUndefined();
    expect(v.events.some((e) => /Fault: m_front jams/.test(e.text))).toBe(true);
    expect(v.results.fault_time).toBe(20);
    expect(v.results.fault_noticed).toBe(true);
    // it sees the stall within a couple of seconds
    expect(v.results.fault_reaction as number).toBeLessThan(3);
    expect(v.results.fault_stopped).toBe(true);
    expect(v.results.still_at_end).toBe(true);
    expect(String(v.results.state)).toMatch(/^fault \(stuck/);
    // each try drives the jammed motor for a moment, backing off included: seconds in all, not minutes
    expect(v.results["m_front.stall_time"] as number).toBeGreaterThan(5);
    expect(v.results["m_front.stall_time"] as number).toBeLessThan(40);
    expect(v.results["m_rear.stall_time"] as number).toBeLessThan(1);
    expect(v.results.fuse_blown).toBe(false);
  }, 120_000);

  it("a jam that frees: the run carries on", () => {
    const v = run(bench("Front jams briefly", "sim.jam(m_front, at: 20s, until: 21s)"));
    expect(v.events.some((e) => /Fault cleared: m_front frees/.test(e.text))).toBe(true);
    expect(String(v.results.state)).not.toMatch(/fault/);
    expect(v.results.fault_stopped).toBe(false);
  }, 120_000);

  it("an encoder wire off: the screw looks stalled to the firmware, so it backs off and gives up", () => {
    const v = run(bench("Encoder off", 'sim.loose("m_front.ENC_A", at: 20s)'));
    expect(v.results.fault_noticed).toBe(true);
    expect(said(v, /stalled/)).toBe(true);
    // the motor itself was turning: no stall current
    expect(v.results["m_front.stall_time"] as number).toBeLessThan(1);
  }, 120_000);

  it("a wire off at the controller end cuts the same signal", () => {
    const pin = model.machine!.wires.find((w) => w.b.comp === "m_front" && w.b.pin === "ENC_A") ?? model.machine!.wires.find((w) => w.a.comp === "m_front" && w.a.pin === "ENC_A");
    const at = pin ? (pin.a.comp === "m_front" ? pin.b : pin.a) : undefined;
    expect(at?.comp).toBe("ctrl");
    const v = run(bench("Encoder off at the board", `sim.loose("ctrl.${at!.pin}", at: 20s)`));
    expect(said(v, /stalled/)).toBe(true);
  }, 120_000);

  it("a flickering encoder wire makes and loses contact without filling the events", () => {
    const v = run(bench("Encoder flickers", 'sim.loose("m_front.ENC_A", at: 20s, flicker: true)'));
    expect(v.events.filter((e) => /m_front\.ENC_A/.test(e.text))).toHaveLength(1);
  }, 120_000);

  it("the IMU unplugged mid-run: it stops answering", () => {
    const v = run(bench("IMU off", "sim.unplug(imu, at: 20s)"));
    expect(v.error).toBeUndefined();
    expect(v.events.some((e) => /Fault: imu is unplugged/.test(e.text))).toBe(true);
  }, 120_000);

  it("the battery unplugged: everything goes dark", () => {
    const v = run(bench("Battery off", "sim.unplug(bat, at: 20s)"));
    expect(v.stop).toBe("brownout");
    expect(v.summary.time).toBeLessThan(21);
  }, 120_000);

  it("an old battery holds less and sags more", () => {
    const fresh = run(bench("New battery", "[]"));
    const old = run(bench("Old battery", "sim.aged(bat, capacity: 60%, resistance: 2)"));
    expect(old.assumptions.some((a) => /bat is an old battery: 60 %/.test(a))).toBe(true);
    expect(old.results.battery_min_volts as number).toBeLessThan(fresh.results.battery_min_volts as number);
    expect(old.results.battery_left as number).toBeLessThan(fresh.results.battery_left as number);
    expect(old.results.fault_time).toBeUndefined();
  }, 120_000);
});

describe("fault tests in the gallery", () => {
  it("writes each fault test as a scenario like the design's own, a minute into the job", async () => {
    const { SIM_TEMPLATES, templateSource } = await import("../src/sim/templates");
    const faults = SIM_TEMPLATES.filter((t) => t.group === "faults");
    expect(faults.map((t) => t.id)).toEqual(["fault_jam", "fault_wire", "fault_sensor", "fault_flat", "fault_old_battery"]);
    const sources = faults.map((t) => templateSource(t, model).source!);
    expect(sources[0]).toContain('like: "Cross the pit"');
    expect(sources[0]).toContain("sim.jam(m_front, at: 3min)");
    expect(sources[1]).toContain('sim.loose("m_front.ENC_A", at: 3min)');
    expect(sources[2]).toContain("sim.unplug(imu, at: 3min)");
    expect(sources[3]).toContain("charge: 15%");
    // an old battery has to do the whole job: the design's own expectations, all three runs
    expect(sources[4]).toContain('expect "Reaches the far wall": reached');
    expect(sources[4]).not.toContain("variants:");
    const all = evaluate(`${SOURCE}\n${sources.join("\n\n")}\n`);
    expect(all.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    expect(all.scenarios!.map((s) => s.label)).toEqual(["Cross the pit", "m_front jams", "m_front encoder wire loose", "imu stops answering", "Battery nearly flat", "Old battery"]);
  });

  it("the jam test passes in the pit: the firmware notices, stops and keeps the motor cool", async () => {
    const { SIM_TEMPLATES, templateSource } = await import("../src/sim/templates");
    const { outcomesFor } = await import("../src/sim/runtime");
    const def = scenario(templateSource(SIM_TEMPLATES.find((t) => t.id === "fault_jam")!, model).source!);
    const r = runSpec(def.spec, model.machine!, model.name);
    expect(r.variants.map((v) => v.variant)).toEqual(["expected"]);
    expect(outcomesFor(def, r)!.map((o) => [o.label, o.status])).toEqual([
      ["Notices the jam", "pass"],
      ["Ends stopped", "pass"],
      ["m_front stays below 80 °C", "pass"],
      ["No fuse blows", "pass"],
    ]);
  }, 300_000);
});

describe("what the fault tests found", () => {
  it("the firmware notices an IMU that stops answering and backs out rather than dig blind", () => {
    const def = scenario(`scenario "IMU lost in the pit" { like: "Cross the pit" variants: "expected" faults: sim.unplug(imu, at: 3min) expect "Notices": fault_noticed }`);
    const v = run(def);
    expect(v.results.fault_noticed).toBe(true);
    expect(v.results.fault_reaction as number).toBeLessThan(1);
    expect(v.serial.some((l) => /state: backing out \(IMU lost: backing out\)/.test(l.text))).toBe(true);
    expect(v.results.still_at_end).toBe(true);
  }, 300_000);
});
