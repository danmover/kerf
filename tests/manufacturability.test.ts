import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { KernelCore } from "../src/kernel/core";
import { evaluate } from "../src/lang/evaluator";
import { processItems, processProbes, rulesOnMachine } from "../src/mfg/report";
import { resolveRules, specToSource } from "../src/mfg/profiles";
import { processGuideText } from "../src/mfg/guide";
import { bedTurn } from "../src/mfg/analyze";
import { MACHINE_PRESETS, NO_MACHINES, findMachine, machinesText, sanitizeMachineFor, sanitizeMachines, type MachineContext } from "../src/mfg/machines";
import type { ProcessFinding, ProcessResult } from "../src/mfg/types";
import type { Model } from "../src/core/model";

beforeAll(async () => {
  const wasm = readFileSync("node_modules/replicad-opencascadejs/dist/replicad_single.wasm");
  R.setOC((await (opencascade as unknown as (o: { wasmBinary: Buffer }) => Promise<unknown>)({ wasmBinary: wasm })) as never);
});

const core = new KernelCore();

/** Evaluate, build and run each part's process checks, on the given machines. */
function check(src: string, machines: MachineContext = NO_MACHINES): { model: Model; results: Record<string, ProcessResult>; find: (part: string, rule: string) => ProcessFinding | undefined } {
  const model = evaluate(src);
  const errors = model.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
  for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  const probes = processProbes(model, new Set(model.parts.map((p) => p.hash)), machines);
  const res = core.process(probes);
  const results: Record<string, ProcessResult> = {};
  probes.forEach((p, i) => (results[p.id] = res[i]));
  for (const r of Object.values(results)) expect(r.error).toBeUndefined();
  return { model, results, find: (part, rule) => results[part]?.findings.find((f) => f.rule === rule) };
}

// a 30 mm cube with a 20 mm cavity sealed inside it: its ceiling needs support
const SEALED = "body box(30, 30, 30) cut box(20, 20, 20, at: (0, 0, 5))";
// the same cavity with a 3 mm slot out through one wall at mid-height
const SLOTTED = `${SEALED} cut box(12, 16, 3, at: (12, 0, 13.5))`;

describe("printed supports can be got out", () => {
  it("fails supports sealed in a cavity, even soluble ones", () => {
    const { find } = check(`
part sealed { process: "fdm" material: "PETG" ${SEALED} }
part dissolved { process: mfg.fdm(soluble: true) material: "PETG" ${SEALED} }
`);
    expect(find("sealed", "support-trapped")?.status).toBe("fail");
    expect(find("sealed", "support-trapped")?.marks?.length).toBeGreaterThan(0);
    expect(find("dissolved", "support-trapped")?.status).toBe("fail");
  });

  it("fails supports behind a slot narrower than a tool, unless they dissolve", () => {
    const { find } = check(`
part slotted { process: "fdm" material: "PETG" ${SLOTTED} }
part dissolved { process: mfg.fdm(soluble: true) material: "PETG" ${SLOTTED} }
`);
    const narrow = find("slotted", "support-narrow");
    expect(narrow?.status).toBe("fail");
    expect(narrow?.value).toBeLessThan(5);
    expect(find("slotted", "support-trapped")).toBeUndefined();
    expect(find("dissolved", "support-narrow")).toBeUndefined();
    expect(find("dissolved", "support-access")?.status).toBe("pass");
  });

  it("passes supports in a pocket open to the bed, wall to wall", () => {
    const { find } = check(`part recess { process: "fdm" material: "PETG" body box(40, 40, 10) cut box(20, 20, 3, at: (0, 0, -0.01)) }`);
    expect(find("recess", "overhang")?.status).toBe("warn");
    expect(find("recess", "support-access")?.status).toBe("pass");
  });

  it("checks resin supports too", () => {
    const { find } = check(`part sealed { process: "sla" material: "Standard resin" ${SEALED} }`);
    expect(find("sealed", "support-trapped")?.status).toBe("fail");
  });
});

describe("printing on the printer", () => {
  it("warns of gaps that fuse shut", () => {
    const { find } = check(`
part tight { process: "fdm" material: "PETG" body box(30, 10, 10) cut box(0.2, 12, 8, at: (0, 0, 2.01)) }
part loose { process: "fdm" material: "PETG" body box(30, 10, 10) cut box(1, 12, 8, at: (0, 0, 2.01)) }
`);
    expect(find("tight", "clearance")?.status).toBe("warn");
    expect(find("loose", "clearance")?.status).toBe("pass");
  });

  it("fails a printer too cold for the filament and warns of warping without an enclosure", () => {
    const { find } = check(`
part hot { process: mfg.fdm(max_temp: 240) material: "Nylon" body box(20, 20, 5) }
part open { process: mfg.fdm(enclosed: false) material: "ABS" body box(20, 20, 5) }
part fine { process: "fdm" material: "PETG" body box(20, 20, 5) }
`);
    expect(find("hot", "printer")?.status).toBe("fail");
    expect(find("open", "printer")?.status).toBe("warn");
    expect(find("fine", "printer")?.status).toBe("pass");
  });

  it("lays a part too long for the bed across it, and fails one that fits no way", () => {
    expect(bedTurn(200, 100, 256, 256)).toBe(0);
    expect(bedTurn(300, 40, 256, 256)).toBe(40);
    expect(bedTurn(380, 40, 256, 256)).toBeUndefined();
    const { find } = check(`
part long { process: mfg.fdm(bed: (256, 256, 256)) material: "PETG" body box(300, 40, 10) }
part longer { process: mfg.fdm(bed: (256, 256, 256)) material: "PETG" body box(380, 40, 10) }
`);
    expect(find("long", "envelope")?.status).toBe("pass");
    expect(find("long", "envelope")?.detail).toMatch(/laid 40° across the bed/);
    expect(find("longer", "envelope")?.status).toBe("fail");
  });
});

describe("milling on the machine", () => {
  const pocket = "body box(40, 40, 30) cut box(10, 10, 25, at: (0, 0, 5.01))";

  it("fails a pocket deeper than the machine's tools reach, and passes it with long enough tools", () => {
    const { find } = check(`
part short { process: mfg.cnc_mill(tools: [(6, 18), (3, 9)]) material: "Aluminum 6061" ${pocket} }
part long { process: mfg.cnc_mill(tools: [(8, 30), (3, 9)]) material: "Aluminum 6061" ${pocket} }
part usual { process: "cnc_mill" material: "Aluminum 6061" ${pocket} }
`);
    const reach = find("short", "tool-reach");
    expect(reach?.status).toBe("fail");
    expect(reach?.value).toBeGreaterThan(18);
    expect(reach?.fix).toMatch(/tools list/);
    expect(find("long", "tool-reach")?.status).toBe("pass");
    // standard end mills reach 4× their diameter: an Ø8 reaches 32 mm
    expect(find("usual", "tool-reach")?.status).toBe("pass");
    expect(find("usual", "plan")?.status).toBe("info");
  });

  it("fails steel on a router and warns of a slow spindle", () => {
    const { find } = check(`
part routed { process: mfg.cnc_mill(frame: "router") material: "Steel" body box(20, 20, 10) }
part slotted { process: mfg.cnc_mill(rpm: 1500) material: "Steel" body box(30, 20, 10) cut box(3.2, 12, 5, at: (0, 0, 5.01)) }
`);
    expect(find("routed", "machine-material")?.status).toBe("fail");
    expect(find("slotted", "machine-material")?.status).toBe("pass");
    expect(find("slotted", "spindle")?.status).toBe("warn");
  });

  it("reaches a side pocket with a 4th or 5th axis", () => {
    const side = "material: \"Aluminum 6061\" body box(40, 40, 20) cut box(10, 6, 10, at: (0, 17.01, 5))";
    const { find, results } = check(`
part three { process: "cnc_mill" ${side} }
part four { process: mfg.cnc_mill(axes: 4) ${side} }
part five { process: mfg.cnc_mill(axes: 5) ${side} }
`);
    expect(find("three", "reach")?.status).not.toBe("pass");
    expect(find("four", "reach")?.status).toBe("pass");
    expect(find("five", "reach")?.status).toBe("pass");
    expect(results.five.stats.setups).toBeGreaterThanOrEqual(1);
  });

  it("says how to hold stock wider than the vise", () => {
    const { find } = check(`part wide { process: mfg.cnc_mill(vise: 100) material: "Aluminum 6061" body box(160, 160, 20) }`);
    expect(find("wide", "holding")?.status).toBe("info");
  });
});

describe("presses, pours, brakes and cutters", () => {
  it("fails a mould the press cannot hold shut or fill", () => {
    const { find } = check(`
part tray { process: mfg.injection(clamp: 10) material: "ABS" body box(200, 200, 20) shell(2, open: Z) }
part block { process: mfg.injection(shot: 5) material: "ABS" body box(30, 30, 10) }
part cap { process: "injection" material: "ABS" body box(40, 40, 10) shell(2, open: Z) }
`);
    expect(find("tray", "clamp")?.status).toBe("fail");
    expect(find("block", "shot")?.status).toBe("fail");
    expect(find("cap", "clamp")?.status).toBe("pass");
  });

  it("fails a casting heavier than the furnace pours", () => {
    const { find } = check(`
part heavy { process: mfg.sand_cast(max_pour: 1) material: "Aluminum A356" body box(100, 100, 50) }
part light { process: "sand_cast" material: "Aluminum A356" body box(100, 100, 50) }
`);
    expect(find("heavy", "pour")?.status).toBe("fail");
    expect(find("light", "pour")?.status).toBe("pass");
  });

  it("fails a bend longer than the brake and sheet thicker than it bends", () => {
    const bent = "body box(40, 30, 2) add box(2, 30, 30, at: (19, 0, 0))";
    const { find } = check(`
part long { process: mfg.sheet_metal(brake: 20) material: "Steel" ${bent} }
part thick { process: mfg.sheet_metal(max_t: 1) material: "Steel" ${bent} }
`);
    expect(find("long", "brake")?.status).toBe("fail");
    expect(find("thick", "brake")?.status).toBe("fail");
  });

  it("fails a cutter that cannot cut the material, a plate too thick and an outline too big", () => {
    const { find } = check(`
part co2 { process: mfg.laser_cut(source: "co2") material: "Steel" body box(80, 50, 3) }
part fiber { process: mfg.laser_cut(source: "fiber") material: "Steel" body box(80, 50, 3) }
part thick { process: mfg.laser_cut(bed: (600, 400, 2)) material: "Steel" body box(80, 50, 3) }
part big { process: mfg.laser_cut(bed: (60, 40, 10)) material: "Steel" body box(80, 50, 3) }
`);
    expect(find("co2", "cutter-material")?.status).toBe("fail");
    expect(find("fiber", "cutter-material")).toBeUndefined();
    expect(find("thick", "plate-thickness")?.status).toBe("fail");
    expect(find("big", "cut-bed")?.status).toBe("fail");
  });

  it("mills a cross hole on a lathe with live tools", () => {
    const shaft = "body cylinder(d: 20, h: 60) cut cylinder(d: 4, h: 30, at: (-15, 0, 30), dir: X)";
    const { find } = check(`
part plain { process: "cnc_lathe" material: "Aluminum 6061" ${shaft} }
part live { process: mfg.cnc_lathe(live_tools: true) material: "Aluminum 6061" ${shaft} }
`);
    expect(find("plain", "revolve")?.status).toBe("warn");
    expect(find("live", "revolve")?.status).toBe("info");
  });
});

describe("machine profiles", () => {
  const prusa = findMachine("prusa mk4s", NO_MACHINES, "fdm")!;
  const mine = { id: "m-1", name: "Shop mill", process: "cnc_mill" as const, settings: { tools: [[6, 18] as [number, number]], rpm: 8000 } };
  const ctx: MachineContext = { machines: [mine], machineFor: { fdm: prusa.id, cnc_mill: "m-1" } };

  it("finds presets and the user's machines by name", () => {
    expect(prusa.name).toBe("Prusa MK4S");
    expect(findMachine("SHOP MILL", ctx)?.id).toBe("m-1");
    expect(MACHINE_PRESETS.every((m) => m.name && Object.keys(m.settings).length)).toBe(true);
    expect(machinesText(ctx)).toMatch(/Prusa MK4S.*Shop mill/);
  });

  it("checks parts on the chosen machine, with the part's own settings first", () => {
    const fdm = rulesOnMachine({ id: "fdm", settings: {} }, "ABS", ctx);
    expect(fdm.machine).toBe("Prusa MK4S");
    expect(fdm.printer?.enclosed).toBe(false);
    expect(fdm.envelope?.size).toEqual([250, 210, 220]);
    const own = rulesOnMachine({ id: "cnc_mill", settings: { rpm: 3000 } }, "Aluminum 6061", ctx);
    expect(own.machining?.rpm).toBe(3000);
    expect(own.machining?.tools).toEqual([[6, 18]]);
    expect(own.machining?.library).toBe(true);
    // a part can name another machine
    const named = rulesOnMachine({ id: "fdm", settings: {}, machine: "Bambu Lab X1 Carbon" }, "ABS", ctx);
    expect(named.machine).toBe("Bambu Lab X1 Carbon");
    expect(named.printer?.enclosed).toBe(true);
    // with no machine, a typical shop
    expect(rulesOnMachine({ id: "fdm", settings: {} }, "ABS").machine).toBeUndefined();
  });

  it("names the machine in the findings and flags one that is missing", () => {
    const { model, results, find } = check(
      `
part cube { process: "fdm" material: "ABS" body box(20, 20, 5) }
part other { process: mfg.fdm(machine: "Nonesuch 9000") material: "PETG" body box(20, 20, 5) }
`,
      ctx,
    );
    expect(find("cube", "printer")?.detail).toMatch(/Prusa MK4S/);
    const items = processItems(model, results, undefined, ctx);
    expect(items.find((i) => i.id === "mfg:other:machine")?.status).toBe("warn");
  });

  it("round-trips machine: through the language", () => {
    const m = evaluate(`part a { body box(10, 10, 10) process: mfg.cnc_mill(machine: "Shop mill", tools: [(6, 18), (3, 9)], frame: "benchtop") }`);
    expect(m.diagnostics).toEqual([]);
    const spec = m.parts[0].process!;
    expect(spec.machine).toBe("Shop mill");
    expect(spec.settings.tools).toEqual([
      [3, 9],
      [6, 18],
    ]);
    const again = evaluate(`part a { body box(10, 10, 10) process: ${specToSource(spec)} }`).parts[0].process;
    expect(again).toEqual(spec);
    expect(evaluate(`part a { body box(10, 10, 10) process: mfg.cnc_mill(frame: "lathe") }`).diagnostics[0]?.message).toMatch(/"router", "benchtop", "vmc"/);
  });

  it("keeps only machine settings in stored profiles", () => {
    const kept = sanitizeMachines([
      { id: "m-2", name: "Printer", process: "fdm", settings: { max_temp: 260, layer: 0.1, build: [0, 0, 1] } },
      { id: "bad id!", name: "x", process: "fdm", settings: {} },
      { id: "m-3", name: "Nope", process: "welding", settings: {} },
    ]);
    expect(kept).toEqual([{ id: "m-2", name: "Printer", process: "fdm", settings: { max_temp: 260 } }]);
    expect(sanitizeMachineFor({ fdm: "m-2", welding: "m-3", sla: 4 })).toEqual({ fdm: "m-2" });
  });

  it("tells the assistant which machine the guide is for", () => {
    expect(processGuideText({ id: "fdm", settings: {} }, "PETG", { name: "Prusa MK4S" })).toMatch(/Machine: Prusa MK4S/);
    expect(processGuideText({ id: "cnc_mill", settings: {} })).toMatch(/typical shop/);
    expect(resolveRules({ id: "cnc_mill", settings: { tools: [[6, 18]] } }, "Aluminum 6061").machining?.tools).toEqual([[6, 18]]);
  });
});
