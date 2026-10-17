import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import type { V3 } from "../src/kernel/recipe";
import { geometryFromMeshes } from "../src/mfg/dfa";
import { fanConductance, fanCfm, heatItems, heatSpaces, heatText, type HeatSpace } from "../src/machine/heat";
import { initKernel } from "./helpers/kernel";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");

describe("heat inside the box", () => {
  beforeAll(async () => {
    await initKernel();
  }, 60_000);
  const core = new KernelCore();
  const built = new Map<string, { bbox: [V3, V3]; volume: number }>();

  function spaces(src: string): HeatSpace[] {
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const p of m.parts) {
      if (built.has(p.hash)) continue;
      const e = core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
      built.set(p.hash, { bbox: e.bbox, volume: e.volume });
    }
    return heatSpaces(m, { geometry: geometryFromMeshes(m, (h) => built.get(h)) });
  }
  const comps = (sp: HeatSpace) => sp.sources.map((s) => s.comp).sort();

  it("finds the tunneller's sealed body, joined across its two sections, and keeps it cool in the sand", () => {
    const [body, ...rest] = spaces(demo("sand-tunneller"));
    expect(rest).toEqual([]);
    expect(body.name).toBe("body_a and body_b");
    expect(comps(body)).toEqual(["bat", "ctrl", "drv_f", "drv_r", "drv_s", "imu", "reg", "vsense"]);
    // sealed: the front end wall is part of body_a, the rear core closes body_b
    expect(body.open).toBe(0);
    expect(body.buried).toBe(true);
    expect(body.ambient).toBe(35);
    // the longest simulated run, not steady state
    expect(body.duty).toBeGreaterThan(600);
    expect(body.air).toBeLessThan(body.steady);
    expect(body.status).toBe("pass");
    // the battery is most of the heat: about 6.7 A through its internal resistance
    expect(body.sources.find((s) => s.comp === "bat")!.watts).toBeGreaterThan(1);
  }, 120_000);

  it("finds the amp's cabinet from its panels, with the gap between the back panels as an opening", () => {
    const [cab, ...rest] = spaces(demo("practice-amp"));
    expect(rest).toEqual([]);
    expect(cab.name).toBe("Cabinet");
    expect(comps(cab)).toEqual(["amp", "nano", "pcb", "reg12", "reg5"]);
    expect(cab.open).toBeGreaterThan(0.02);
    expect(cab.gOpen).toBeGreaterThan(0);
    expect(cab.status).toBe("pass");
    // the 7812 drops 12 V: its chip runs well above the air, and is judged on that
    expect(cab.limits.find((l) => l.label === "reg12")!.text).toMatch(/chip at about \d+ °C/);
  }, 120_000);

  it("counts the printer's fan on the electronics box lid, and leaves the open-frame supply alone", () => {
    const [ebox, ...rest] = spaces(demo("printer"));
    expect(rest).toEqual([]);
    expect(comps(ebox)).toEqual(["buck", "pi", "skr"]);
    expect(ebox.fans.map((f) => f.comp)).toEqual(["board_fan"]);
    expect(ebox.gFans).toBeCloseTo(fanConductance(fanCfm(40)), 5);
    // the board and its four drivers (the Z pair share one), the Pi and the buck converter
    expect(ebox.watts).toBeGreaterThan(6);
    expect(ebox.watts).toBeLessThan(14);
    expect(ebox.air).toBeLessThan(35);
    expect(ebox.status).toBe("pass");
  }, 120_000);

  it("warns when the printer's electronics box loses its fan, and says how much a fan brings it down", () => {
    const src = demo("printer").replace(/(component board_fan = lib\.fan\("fan_4010_24v"\) \{ at: )\(-209, 89, 200\)/, "$1(-209, 89, 600)");
    expect(src).not.toBe(demo("printer"));
    const [ebox] = spaces(src);
    expect(ebox.fans).toEqual([]);
    expect(ebox.air).toBeGreaterThan(60);
    expect(ebox.status).not.toBe("pass");
    expect(ebox.fix).toMatch(/40 mm fan/);
    const [item] = heatItems([ebox]);
    expect(item).toMatchObject({ id: expect.stringMatching(/^heat:/), category: "engineering", basis: "calculation", status: ebox.status });
    expect(item.title).toMatch(/ebox gets (warm|too hot) inside/);
    expect(item.parts).toContain("skr");
  }, 120_000);

  it("judges a hot room: the tunneller's battery is warned about at 50 °C sand", () => {
    const [body] = spaces(demo("sand-tunneller").replace("temp: 5C .. 35C assumed", "temp: 5C .. 50C"));
    expect(body.ambientAssumed).toBe(false);
    expect(body.limits.find((l) => l.label === "bat")!.status).toBe("warn");
    expect(heatText([body])).toMatch(/LiPo must stay under 60 °C/);
  }, 120_000);
});

describe("heat helpers", () => {
  it("rates fans by frame size", () => {
    expect(fanCfm(40)).toBe(7);
    expect(fanCfm(45)).toBeCloseTo(8.5);
    expect(fanConductance(7)).toBeGreaterThan(1.5);
  });
  it("reports nothing for a design with no machine parts", () => {
    expect(heatSpaces(evaluate(demo("bracket")), { geometry: () => undefined })).toEqual([]);
  });
});
