// Simulation runs saved with the project: a long run is thinned to fit, each
// scenario keeps its latest few runs, and opening the project again shows a
// saved run whose inputs still match as the scenario's result, ready to
// replay, without running it again. One whose inputs changed stays on show
// as the last run.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { useDesign } from "../src/core/engine";
import { useProject } from "../src/app/project";
import type { ProjectRecord } from "../src/persist/db";
import type { RunResult, VariantRun } from "../src/sim/engine/run";
import { forSaving, resultBytes, saveRun, savedRuns } from "../src/sim/saved";
import { loadSavedRuns, resetSim, scenarioKey, simItems, useSim } from "../src/sim/runtime";

const SOURCE = readFileSync(join(__dirname, "../src/demos/sand-tunneller.kerf"), "utf8");

function fakeRun(frames: number, label = "x"): RunResult {
  const t = Float32Array.from({ length: frames }, (_, i) => i / 10);
  const v: VariantRun = {
    variant: "expected",
    stop: "duration",
    frames: { t, series: { "m.rpm": Float32Array.from(t, (x) => x * 2), "m.amps": Float32Array.from(t, () => 1) } },
    events: [{ t: 1, kind: "info", text: label }],
    serial: [],
    faults: [],
    results: { faults: 0, time: frames / 10 },
    summary: { time: frames / 10, wallMs: 1, ram: { used: 1, total: 2, static: 1, stack: 0 }, loopMax: 1, isrLoad: 0, motors: [], eepromWrites: 0 },
    scene: { kind: "bench", floor: 0, bodies: [], notes: [] },
    assumptions: [],
    notes: [],
    limits: [],
    displays: [],
  };
  return { firmware: { name: "brain", board: "ctrl", boardName: "Arduino Nano", files: [], config: [] }, variants: [v] };
}

describe("saving runs", () => {
  it("thins a long run's frames evenly to fit, keeping the end", () => {
    const r = fakeRun(100_000);
    const small = forSaving(r, resultBytes(r) / 4);
    const f = small.variants[0].frames;
    expect(resultBytes(small)).toBeLessThanOrEqual(resultBytes(r) / 4);
    expect(f.t[f.t.length - 1]).toBeCloseTo(r.variants[0].frames.t[99_999], 3);
    expect(f.series["m.rpm"].length).toBe(f.t.length);
    expect(f.series["m.rpm"][1]).toBeCloseTo(f.t[1] * 2, 3);
    // a short run is saved as it is
    const short = fakeRun(100);
    expect(forSaving(short)).toBe(short);
  });

  it("keeps each scenario's latest three runs and one copy of each", async () => {
    for (let i = 0; i < 5; i++) {
      await saveRun("p_keep", "Bench", `k${i}`, fakeRun(10, `run ${i}`));
      await new Promise((r) => setTimeout(r, 2));
    }
    await saveRun("p_keep", "Bench", "k4", fakeRun(10, "run 4 again"));
    await saveRun("p_keep", "Pit", "k9", fakeRun(10, "pit"));
    const saved = await savedRuns("p_keep");
    expect(saved.filter((s) => s.label === "Bench").map((s) => s.runKey)).toEqual(["k4", "k3", "k2"]);
    expect(saved.find((s) => s.runKey === "k4")!.result.variants[0].events[0].text).toBe("run 4 again");
    expect(saved.some((s) => s.label === "Pit")).toBe(true);
    expect(await savedRuns("p_other")).toEqual([]);
  });
});

describe("opening a project with saved runs", () => {
  const model = evaluate(SOURCE);
  const def = model.scenarios!.find((s) => s.label === "Cross the pit")!;
  const ctx = { model, live: true, rev: 1, buildErrors: new Map(), process: null };
  const open = (id: string) => useProject.setState({ current: { id, name: "Tunneller", source: SOURCE, template: "sand-tunneller", createdAt: 0, updatedAt: 0 } as ProjectRecord });

  it("shows a saved run whose inputs still match as the result, without running it again", async () => {
    const result = fakeRun(50, "saved pit run");
    await saveRun("p_open", def.label, scenarioKey(def.spec, model.machine, model.name), result);
    resetSim();
    // automatic runs off, so nothing else starts a worker here
    useSim.setState({ auto: false });
    open("p_open");
    useDesign.setState({ model });
    const loaded = loadSavedRuns("p_open");
    // nothing is scheduled until the saved runs are in
    simItems([], ctx);
    expect(useSim.getState().runs.size).toBe(0);
    await loaded;
    const run = useSim.getState().runs.get(def.label)!;
    expect(run.status).toBe("done");
    expect(run.stale).toBe(false);
    expect(run.savedAt).toBeGreaterThan(0);
    expect(run.result!.variants[0].events[0].text).toBe("saved pit run");
    // its expectations are judged from the saved run
    const items = simItems([], ctx);
    expect(items.some((i) => i.id.startsWith(`sim:${def.label}:expect:`) && i.status !== "pending")).toBe(true);
  });

  it("keeps a saved run on show as the last run when the design changed since", async () => {
    // a scenario this session has not run, so only the saved run can show
    const changed = evaluate(SOURCE.replace("duration: 20min", "duration: 19min"));
    await saveRun("p_changed", def.label, "an-older-key", fakeRun(50, "before the change"));
    resetSim();
    useSim.setState({ auto: false });
    open("p_changed");
    useDesign.setState({ model: changed });
    await loadSavedRuns("p_changed");
    simItems([], { ...ctx, model: changed });
    const run = useSim.getState().runs.get(def.label)!;
    expect(run.status).toBe("idle");
    expect(run.stale).toBe(true);
    expect(run.result!.variants[0].events[0].text).toBe("before the change");
    expect(run.savedAt).toBeGreaterThan(0);
    useProject.setState({ current: null });
    resetSim();
  });
});
