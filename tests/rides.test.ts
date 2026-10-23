// The ride and engine templates: each passes every check (held together,
// screws closed, linkages that go all the way round, printable, fits that
// work as made) and its ride simulation meets its own expectations.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fullCheck, problems } from "./helpers/fullcheck";
import { findHolds } from "../src/core/holds";
import { resolveMechanism } from "../src/sim/mech/resolve";
import { runSpec } from "../src/sim/build";
import { outcomesFor } from "../src/sim/runtime";
import { emptyMachine } from "../src/machine/types";
import { templateById } from "../src/demos/templates";

const demo = (name: string) => readFileSync(join(__dirname, `../src/demos/${name}.kerf`), "utf8");

// parts that move only because they are pressed, pinned or bolted to a moving part, and what carries them
const RIDES: Record<string, Record<string, string>> = {
  engine: { wrist_pin: "piston", crank_pin: "crank" },
  teacups: { deck_bearing_low: "deck", deck_bearing_high: "deck", cup_bearings: "deck" },
  "pirate-ship": { hull: "arm_drive", arm_far: "arm_drive", mast: "arm_drive", arm_screws: "arm_drive", arm_bearings: "arm_drive", rocker_pin: "arm_drive", crank_pin: "motor" },
  "ferris-wheel": { gondola_pins: "wheel", tie_rods: "wheel", rim_bearings: "wheel" },
};

describe.each(["engine", "teacups", "pirate-ship", "ferris-wheel"])("the %s template", (name) => {
  it("passes every check, carries what is fastened to its moving parts, and meets its ride simulation's expectations", async () => {
    expect(templateById(name)?.source).toBe(demo(name));
    const { model, report, buildErrors, core } = await fullCheck(demo(name));
    expect(model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    expect([...buildErrors.values()]).toEqual([]);
    expect(problems(report)).toEqual([]);
    const holds = findHolds(model, (h) => (core.get(h) ? core.mesh(h, "preview") : undefined));
    const carried = new Map([...holds.carried].map(([id, c]) => [model.parts.find((p) => p.id === id)!.name, c.from.name]));
    for (const [part, by] of Object.entries(RIDES[name])) expect(`${part} rides ${carried.get(part)}`).toBe(`${part} rides ${by}`);
    const geom = (h: string) => {
      const e = core.get(h);
      return e ? { preview: core.mesh(h, "preview"), volume: e.volume, bbox: e.bbox, rev: 0 } : undefined;
    };
    for (const def of model.scenarios ?? []) {
      const r = resolveMechanism(def.spec, model, geom, true);
      if (!("mech" in r)) throw new Error(JSON.stringify(r));
      const res = runSpec({ ...def.spec, mech: r.mech, variants: ["expected"] }, emptyMachine(), model.name);
      expect(res.variants[0].error).toBeUndefined();
      expect(outcomesFor(def, res)!.map((o) => `${o.status} ${o.label}`)).toEqual(def.expects.map((e) => `pass ${e.label}`));
    }
  }, 120_000);
});
