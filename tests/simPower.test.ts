// Power in the simulation: plug-in adapters and mains supplies are live
// sources (the Nano behind a buck converter on a plug pack powers up), they
// cut out when overloaded, a current-limited bench supply can stand in for
// the design's own battery, and the controller's USB port has its polyfuse.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { runSpec } from "../src/sim/build";
import { ADAPTER, BENCH_SUPPLY, Supply, USB_PORT } from "../src/sim/engine/devices";
import { SIM_TEMPLATES, templateSource } from "../src/sim/templates";
import { outcomesFor } from "../src/sim/runtime";
import { valueAt } from "../src/sim/frames";

const SOURCE = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");

/** The Sand Tunneller on a 12 V supply in place of its LiPo: it feeds the drivers and the 5 V buck, and the buck feeds the Nano's 5V pin. */
function onSupply(id: string, pos: string, neg: string) {
  return SOURCE.replace('component bat = lib.battery("lipo_3s_2200")', `component bat = lib.psu("${id}")`)
    .replace(/bat\.v_nom/g, "12")
    .replace(/^let run = calc\.battery_runtime.*$/m, "")
    .replace(/^require "Battery (lasts|covers).*$/gm, "")
    .replace("wire bat.POS ->", `wire bat.${pos} ->`)
    .replace("wire bat.NEG ->", `wire bat.${neg} ->`);
}

function powerUp(source: string, world?: string) {
  const m = evaluate(source);
  const errors = m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  expect(errors).toEqual([]);
  let block = templateSource(SIM_TEMPLATES.find((t) => t.id === "power_up")!, m).source!.replace("Power-up on the bench", "Bench");
  if (world) block = block.replace("sim.bench(load: 0)", world);
  const withIt = evaluate(`${source}\n${block}\n`);
  expect(withIt.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const def = withIt.scenarios!.at(-1)!;
  const r = runSpec({ ...def.spec, variants: ["expected"] }, withIt.machine!, withIt.name);
  expect(r.error).toBeUndefined();
  return { def, r, v: r.variants[0] };
}

describe("supplies", () => {
  it("an adapter holds its voltage up to its rating, cuts out past it and tries again", () => {
    const s = new Supply("psu", 12, 2, 0.15, ADAPTER);
    expect(s.step(1.5, 0.001)).toBeUndefined();
    expect(s.volts()).toBeCloseTo(12 - 1.5 * 0.15, 3);
    let said: string | undefined;
    for (let i = 0; i < 100 && !said; i++) said = s.step(3.5, 0.001);
    expect(said).toMatch(/psu cut out: 3\.5 A is past its 2 A rating/);
    expect(s.trips).toBe(1);
    expect(s.volts()).toBe(0);
    for (let i = 0; i < 1001; i++) s.step(0, 0.001);
    expect(s.volts()).toBeCloseTo(12, 3);
  });

  it("a bench supply lets its voltage fall to hold its current limit", () => {
    const s = new Supply("bench_supply", 12, 1, 0.01, BENCH_SUPPLY);
    // a 4 Ω load wants 3 A at 12 V
    let said: string | undefined;
    for (let i = 0; i < 2000; i++) said = s.step(s.volts() / 4, 0.001) ?? said;
    expect(said).toMatch(/1 A current limit/);
    expect(s.volts() / 4).toBeGreaterThan(0.85);
    expect(s.volts() / 4).toBeLessThan(1.15);
    expect(s.trips).toBe(0);
  });

  it("a USB port's polyfuse rides out a short surge but trips on a lasting overload", () => {
    const s = new Supply("USB", 5, 0.5, 0.3, USB_PORT);
    for (let i = 0; i < 100; i++) expect(s.step(1.5, 0.001)).toBeUndefined();
    let said: string | undefined;
    for (let i = 0; i < 1000 && !said; i++) said = s.step(1.5, 0.001);
    expect(said).toMatch(/cut out/);
    expect(s.volts()).toBe(0);
  });
});

describe("power-up from a plug-in adapter", () => {
  it("powers the Nano through the buck converter from a mains supply: it stays powered and both screws turn", () => {
    const { def, v, r } = powerUp(onSupply("lrs_150_12", "V_PLUS", "V_MINUS"));
    expect(v.stop).not.toBe("brownout");
    expect(v.events.some((e) => /browned out|cut out/.test(e.text))).toBe(false);
    expect(v.results.browned_out).toBe(false);
    expect(Math.abs(v.results["m_front.turns"] as number)).toBeGreaterThan(1);
    expect(v.results.supply_trips).toBe(0);
    expect(v.results.supply_min_volts as number).toBeGreaterThan(11);
    // starting both motors at once is the peak
    expect(v.results.supply_peak_amps as number).toBeGreaterThan(5);
    expect(v.results.battery_left).toBeUndefined();
    expect(v.assumptions.some((a) => /bat: plugged in and switched on for the whole run, 12 V up to 12.5 A/.test(a))).toBe(true);
    expect(v.frames.series["bat.volts"]).toBeDefined();
    expect(outcomesFor(def, r)!.find((o) => o.label === "Stays powered")?.status).toBe("pass");
  }, 120_000);

  it("a 2 A plug pack powers the Nano, then cuts out when both motors start at once", () => {
    const { def, v, r } = powerUp(onSupply("psu_12v_2a", "VPOS", "VNEG"));
    // the logic is up and running on the buck's 5 V through the start delay
    expect(valueAt(v.frames, "logic.volts", 30)).toBeCloseTo(5, 1);
    expect(v.serial.some((l) => l.dir === "out")).toBe(true);
    const cut = v.events.find((e) => /cut out/.test(e.text));
    expect(cut?.text).toMatch(/^bat cut out: [\d.]+ A is past its 2 A rating/);
    expect(v.events.some((e) => /browned out/.test(e.text) && e.t >= cut!.t)).toBe(true);
    expect(v.results.browned_out).toBe(true);
    expect(v.results.supply_trips).toBe(1);
    expect(outcomesFor(def, r)!.find((o) => o.label === "Stays powered")?.status).toBe("fail");
  }, 120_000);

  it("runs from a current-limited bench supply in place of the battery, and browns out when the limit is too low", () => {
    const ok = powerUp(SOURCE, "sim.bench(load: 0, supply: sim.supply(volts: 12V, amps: 15A))").v;
    expect(ok.results.browned_out).toBe(false);
    expect(ok.results.battery_left).toBeUndefined();
    expect(ok.results.supply_peak_amps as number).toBeLessThan(16);
    expect(ok.assumptions.some((a) => /bench supply at 12 V with its current limit at 15 A, clipped on where bat connects/.test(a))).toBe(true);
    expect(Math.abs(ok.results["m_front.turns"] as number)).toBeGreaterThan(1);
    // 20 mA is less than the logic alone draws
    const starved = powerUp(SOURCE, "sim.bench(load: 0, supply: sim.supply(volts: 12V, amps: 20mA))").v;
    expect(starved.results.browned_out).toBe(true);
    expect(starved.events.some((e) => /current limit/.test(e.text))).toBe(true);
  }, 240_000);

  it("explains a bench supply that has nowhere to go", () => {
    const { v } = powerUp(SOURCE, 'sim.bench(load: 0, supply: sim.supply(volts: 12V, on: "NOPE"))');
    expect(v.notes.some((n) => /bench supply goes nowhere: there is no net called NOPE/.test(n))).toBe(true);
  }, 120_000);

  it("checks what sim.supply() is given", () => {
    const bad = (w: string) => evaluate(`${SOURCE}\nscenario "S" { world: ${w} duration: 1min expect "x": faults == 0 }\n`).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    expect(bad("sim.bench(supply: sim.supply(volts: 400V))")[0]).toMatch(/up to about 60 V/);
    expect(bad("sim.bench(supply: 12)")[0]).toMatch(/not sim.supply/);
    expect(bad('sim.bench(supply: sim.supply(volts: 12V, on: "a b"))')[0]).toMatch(/net name or "component.PIN"/);
  });
});
