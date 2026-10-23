// The ride and engine templates: each passes every check (held together,
// screws closed, linkages that go all the way round, printable, fits that
// work as made) and its ride simulation meets its own expectations. The rides
// also route their wiring with nothing in the way, and their firmware
// compiles against the mock Arduino core.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fullCheck, problems } from "./helpers/fullcheck";
import { findHolds } from "../src/core/holds";
import { resolveMechanism } from "../src/sim/mech/resolve";
import { runSpec } from "../src/sim/build";
import { outcomesFor } from "../src/sim/runtime";
import { emptyMachine } from "../src/machine/types";
import { templateById } from "../src/demos/templates";
import { generateFirmware } from "../src/machine/firmware";
import { buildHarness } from "../src/machine/harness/harness";
import { mountParts, mountSpecs, screwSpecs, solidsInput } from "../src/machine/harness/inputs";
import { runWiring } from "../src/machine/harness/wiringRun";
import { wiringItems } from "../src/machine/harness/checks";

const demo = (name: string) => readFileSync(join(__dirname, `../src/demos/${name}.kerf`), "utf8");

// parts that move only because they are pressed, pinned or bolted to a moving part, and what carries them
const RIDES: Record<string, Record<string, string>> = {
  engine: { wrist_pin: "piston", crank_pin: "crank" },
  teacups: { deck_bearings: "deck", idler_bearings: "deck", table_bearings: "deck" },
  "pirate-ship": { hull: "arm_drive", arm_far: "arm_drive", mast: "arm_drive", crows_nest: "arm_drive", arm_screws: "arm_drive", arm_bearings: "arm_drive", rocker_pin: "arm_drive", crank_pin: "crank" },
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
      const res = runSpec({ ...def.spec, mech: r.mech, variants: ["expected"] }, model.machine ?? emptyMachine(), model.name);
      expect(res.variants[0].error).toBeUndefined();
      expect(outcomesFor(def, res)!.map((o) => `${o.status} ${o.label}`)).toEqual(def.expects.map((e) => `pass ${e.label}`));
    }
  }, 120_000);
});

const MOCK_CORE = join(__dirname, "fixtures/arduino");
const canCompile = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, "-fsyntax-only", "-x", "c++", "-"], { input: "#include <stdint.h>\nint main() { return 0; }\n", stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

describe.each(["teacups", "pirate-ship", "ferris-wheel"])("the %s ride's electronics", (name) => {
  it("routes every cable with room for it and nothing in the way of its plugs", async () => {
    const { model, core } = await fullCheck(demo(name));
    const harness = buildHarness(model);
    const mounts = mountParts(model);
    const mesh = (h: string) => {
      const e = core.get(h);
      const m = e ? core.mesh(h, "preview") : undefined;
      return e && m ? { positions: m.positions, indices: m.indices, bbox: e.bbox } : undefined;
    };
    const { geos, placed } = solidsInput({ ...model, parts: model.parts.filter((p) => !p.hidden) }, mesh, mounts);
    const run = runWiring({ geos, placed, wires: [] }, { harness, mounts: mountSpecs(model, (h) => core.get(h)?.bbox, mounts), screws: screwSpecs(model) });
    const items = wiringItems(harness, run.findings ?? null, run.mounts, model);
    expect(items.filter((i) => i.status === "fail" || i.status === "warn").map((i) => `${i.title}: ${i.detail}`)).toEqual([]);
  }, 120_000);

  it.skipIf(!canCompile("g++", ["-std=gnu++17"]))("writes a ride sketch that compiles against the mock Arduino core", async () => {
    const { model } = await fullCheck(demo(name));
    const [fw] = generateFirmware(model.machine!, model.name ?? name);
    expect(fw.target).toBe("arduino");
    expect(fw.warnings).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "kerf-ride-"));
    try {
      for (const f of fw.files) {
        const p = join(dir, f.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.content);
      }
      const ino = join(dir, fw.files.find((f) => f.path.endsWith(".ino"))!.path);
      execFileSync("g++", ["-std=gnu++17", "-fsyntax-only", "-Wall", "-Werror", "-x", "c++", "-include", join(MOCK_CORE, "Arduino.h"), `-I${MOCK_CORE}`, `-I${dirname(ino)}`, ino], { stdio: "pipe" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
