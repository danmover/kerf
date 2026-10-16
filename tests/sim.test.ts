// Simulation scenarios end to end: scenario blocks in the design language,
// expectations judged across the three runs, firmware setting overrides, the
// gallery's templates, and real runs of the Sand Tunneller's generated
// firmware on the bench and in the sand pit.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { applyConfig } from "../src/sim/engine/run";
import { runSpec, pitStart } from "../src/sim/build";
import { judge, checkRun } from "../src/sim/expect";
import { fmtResult, resultInfo } from "../src/sim/results";
import { SIM_TEMPLATES, templateSource } from "../src/sim/templates";
import { outcomesFor, scenarioKey } from "../src/sim/runtime";
import { matchSeries, valueAt } from "../src/sim/frames";
import type { ScenarioDef } from "../src/sim/scenario";

const SOURCE = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");
const model = evaluate(SOURCE);

function withScenario(block: string) {
  const m = evaluate(`${SOURCE}\n${block}\n`);
  return { m, errors: m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) };
}

function scenario(block: string): ScenarioDef {
  const { m, errors } = withScenario(block);
  expect(errors).toEqual([]);
  return m.scenarios!.at(-1)!;
}

describe("scenario blocks", () => {
  it("the Sand Tunneller's pit scenario reads the brief's pit and the design's own sizes", () => {
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const def = model.scenarios!.find((s) => s.label === "Cross the pit")!;
    expect(def.uses).toEqual(["cross", "steer", "reserve"]);
    expect(def.expects.map((e) => e.label)).toContain("Reaches the far wall");
    const w = def.spec.world;
    if (w.kind !== "sand_pit") throw new Error("expected a sand pit");
    expect(w.pit).toMatchObject({ length: 2000, depth: 5000, start: "wall", push: 150 });
    expect(w.robot.screws.map((s) => s.motor)).toEqual(["m_front", "m_rear"]);
    // the rear screw counter-rotates and faces backwards
    expect(w.robot.screws[1].turn).toBe(-1);
    expect(w.robot.screws[1].from).toBeLessThan(w.robot.screws[1].to);
    expect(def.spec.duration).toBe(1200);
    expect(def.spec.variants).toEqual(["pessimistic", "expected", "optimistic"]);
  });

  it("starting from the wall puts the hinge at the wall face", () => {
    const def = model.scenarios![0];
    if (def.spec.world.kind !== "sand_pit") throw new Error("expected a sand pit");
    expect(pitStart(def.spec.world).x).toBe(0);
    expect(pitStart({ ...def.spec.world, pit: { ...def.spec.world.pit, start: "buried" } }).x).toBeGreaterThan(400);
  });

  it("explains mistakes in a scenario", () => {
    expect(withScenario(`scenario "No world" { firmware: brain expect "x": faults == 0 }`).errors[0]).toMatch(/needs a world/);
    expect(withScenario(`scenario "Typo" { world: sim.bench() durration: 1min expect "x": faults == 0 }`).errors[0]).toMatch(/Did you mean "duration"/);
    expect(withScenario(`scenario "Fw" { world: sim.bench() firmware: brian expect "x": faults == 0 }`).errors[0]).toMatch(/Did you mean "brain"/);
    expect(withScenario(`scenario "Pit" { world: sim.sand_pit(length: 2m, width: 0.5m, depth: 5m) expect "x": reached }`).errors[0]).toMatch(/robot: sim.screw_tunneller/);
    expect(withScenario(`scenario "Cross the pit" { world: sim.bench() expect "x": faults == 0 }`).errors[0]).toMatch(/already defined/);
    const empty = withScenario(`scenario "Empty" { world: sim.bench() }`);
    expect(empty.errors).toEqual([]);
    expect(empty.m.diagnostics.some((d) => /nothing to check/.test(d.message))).toBe(true);
  });

  it("captures design values an expectation names", () => {
    const def = scenario(`scenario "Env" { world: sim.bench(load: 0) duration: 1min let limit = 70C expect "Cool": m_front.max_temp < limit expect "Pit": progress > pit_l / 2 }`);
    expect(def.expects[0].env).toMatchObject({ limit: 70 });
    expect(def.expects[1].env).toMatchObject({ pit_l: 2000 });
  });
});

describe("expectations", () => {
  const def = scenario(
    `scenario "Judge" { world: sim.bench() duration: 1min
      expect "Near": miss < 100mm
      expect "Warm" soft: m_front.max_temp < 80C
      expect "Typo": m_front.max_tmp < 80C
      expect "Arrived": reached && time_to_wall < 10min }`,
  );
  const [near, warm, typo, arrived] = def.expects;
  const run = (variant: "pessimistic" | "expected" | "optimistic", results: Record<string, number | boolean | string>) => ({ variant, results });

  it("passes on the expected run and warns when another run fails", () => {
    const pass = judge(near, [run("pessimistic", { reached: true, miss: 60 }), run("expected", { reached: true, miss: 30 }), run("optimistic", { reached: true, miss: 10 })], "sand_pit");
    expect(pass.status).toBe("pass");
    expect(pass.detail).toMatch(/^expected run: miss 30 mm \(needs under 100 mm\)\. It also passes in the pessimistic and optimistic runs\.$/);
    expect(pass.margin).toBeCloseTo(70);
    const warn = judge(near, [run("pessimistic", { reached: true, miss: 160 }), run("expected", { reached: true, miss: 30 })], "sand_pit");
    expect(warn.status).toBe("warn");
    expect(warn.detail).toMatch(/fails in the pessimistic run \(miss 160 mm/);
  });

  it("fails when the expected run fails, and a soft one only warns", () => {
    expect(judge(near, [run("expected", { reached: true, miss: 130 }), run("optimistic", { reached: true, miss: 40 })], "sand_pit")).toMatchObject({ status: "fail" });
    const soft = judge(warm, [run("expected", { "m_front.max_temp": 95 })], "sand_pit");
    expect(soft.status).toBe("warn");
    expect(soft.detail).toMatch(/95 °C/);
  });

  it("a result the run never recorded fails, with why", () => {
    const c = checkRun(near, { reached: false, remaining: 1480 }, "sand_pit");
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/miss was not recorded: it never reached the far wall \(1480 mm short\)/);
    expect(checkRun(arrived, { reached: false, remaining: 300 }, "sand_pit").ok).toBe(false);
    expect(checkRun(arrived, { reached: true, time_to_wall: 351 }, "sand_pit").ok).toBe(true);
  });

  it("a name that is not a result is a mistake in the expectation, with a suggestion", () => {
    const c = checkRun(typo, { "m_front.max_temp": 40 }, "sand_pit");
    expect(c.ok).toBeNull();
    expect(c.detail).toMatch(/not a result of this run/);
    expect(judge(typo, [run("expected", { "m_front.max_temp": 40 })], "sand_pit").status).toBe("fail");
  });

  it("knows result units, including per-motor results", () => {
    expect(resultInfo("m_front.max_temp", "sand_pit")?.unit).toBe("C");
    expect(resultInfo("battery_left")?.unit).toBe("share");
    expect(resultInfo("push_peak", "sand_pit")?.unit).toBe("N");
    expect(resultInfo("nonsense", "sand_pit")).toBeUndefined();
    expect(fmtResult(0.57, "share")).toBe("57 %");
    expect(fmtResult(true, "yes/no")).toBe("yes");
  });
});

describe("firmware settings for one run", () => {
  const files = { "config.h": "#define POWER            0.8     // 0..1 of full PWM\n#define STEER_SIGN       -1      // sign\n" };

  it("rewrites a #define and keeps its comment", () => {
    const f = { ...files };
    const changed = applyConfig(f, { POWER: 0.6 });
    expect(changed).toEqual([{ name: "POWER", from: "0.8", to: "0.6" }]);
    expect(f["config.h"]).toMatch(/#define POWER {12}0\.6 {5}\/\/ 0\.\.1 of full PWM/);
  });

  it("names the settings there are when one is not", () => {
    const err = applyConfig({ ...files }, { SPEED: 1 });
    expect(typeof err).toBe("string");
    expect(err).toMatch(/no setting SPEED\. Its settings: POWER, STEER_SIGN/);
  });
});

describe("the template gallery", () => {
  it("writes bench tests from the design, and asks Claude to set up the pit", () => {
    const power = SIM_TEMPLATES.find((t) => t.id === "power_up")!;
    const { source } = templateSource(power, model);
    expect(source).toMatch(/^scenario "Power-up on the bench" \{/);
    expect(source).toMatch(/expect "m_front turns" soft: abs\(m_front\.turns\) > 1/);
    // what the gallery inserts must evaluate cleanly in the design
    expect(withScenario(source!).errors).toEqual([]);
    const overload = templateSource(SIM_TEMPLATES.find((t) => t.id === "overload")!, model).source!;
    expect(overload).toMatch(/battery_min_volts > 0\.8 \* bat\.v_nom/);
    expect(withScenario(overload).errors).toEqual([]);
    const pit = templateSource(SIM_TEMPLATES.find((t) => t.id === "sand_pit")!, model);
    expect(pit.prompt).toMatch(/brief's givens \(pit_l/);
  });

  it("says why a design without firmware cannot be simulated", () => {
    const plain = evaluate(`design "Bracket"\npart plate { body box(40, 20, 4) }`);
    expect(templateSource(SIM_TEMPLATES[0], plain).reason).toMatch(/add a controller/);
  });
});

describe("run keys", () => {
  it("ignore where the scenario sits in the source, and change with what it does", () => {
    const a = model.scenarios![0];
    const moved = evaluate(`// a comment that moves every span\n${SOURCE}`).scenarios![0];
    expect(scenarioKey(moved.spec, evaluate(`// x\n${SOURCE}`).machine, model.name)).toBe(scenarioKey(a.spec, model.machine, model.name));
    expect(scenarioKey({ ...a.spec, duration: 60 }, model.machine, model.name)).not.toBe(scenarioKey(a.spec, model.machine, model.name));
  });
});

describe("runs with the generated firmware", () => {
  it("powers up on the bench: the firmware starts, both screws turn, nothing is mis-wired", () => {
    const def = scenario(templateSource(SIM_TEMPLATES.find((t) => t.id === "power_up")!, model).source!.replace("Power-up on the bench", "Bench"));
    const r = runSpec({ ...def.spec, variants: ["expected"] }, model.machine!, model.name);
    expect(r.error).toBeUndefined();
    const v = r.variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results.faults).toBe(0);
    expect(Math.abs(v.results["m_front.turns"] as number)).toBeGreaterThan(1);
    expect(v.results.ram_use as number).toBeLessThan(1);
    // the console shows the firmware's own start-up messages
    expect(v.serial.some((l) => l.dir === "out")).toBe(true);
    const outs = outcomesFor(def, r)!;
    expect(outs.find((o) => o.label === "No firmware mistakes")?.status).toBe("pass");
    // recorded series read back at any time
    expect(matchSeries(v.frames, "*.amps")).toEqual(expect.arrayContaining(["m_front.amps", "m_rear.amps"]));
    expect(Number.isFinite(valueAt(v.frames, "m_front.temp", 90))).toBe(true);
  }, 120_000);

  it("crosses the pit from the wall with a helper's push, in the expected run", () => {
    const def = model.scenarios!.find((s) => s.label === "Cross the pit")!;
    const r = runSpec({ ...def.spec, variants: ["expected"] }, model.machine!, model.name);
    expect(r.error).toBeUndefined();
    const v = r.variants[0];
    expect(v.error).toBeUndefined();
    expect(v.results.reached).toBe(true);
    expect(v.results.miss as number).toBeLessThan(150);
    // one person's push gets it started, and only until the rear screw bites
    expect(v.results.push_peak as number).toBeGreaterThan(0);
    expect(v.results.push_peak as number).toBeLessThanOrEqual(150);
    expect(v.results.push_distance as number).toBeLessThan(500);
    expect(v.events.some((e) => e.kind === "goal" && /far wall/.test(e.text))).toBe(true);
    expect(v.scene.box?.max).toEqual([2000, 250, 5000]);
  }, 300_000);
});
