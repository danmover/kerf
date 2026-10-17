import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { KernelCore } from "../src/kernel/core";
import { evaluate } from "../src/lang/evaluator";
import { applyDefaultProcess, ownProcess, processFromText, processFromValue } from "../src/mfg/spec";
import { setPartProcess, withSetting } from "../src/mfg/edit";
import { compareProbes, findingFor, findingId, parseFindingId, processItems, processProbes, summarize } from "../src/mfg/report";
import { PROCESS_IDS, generalToleranceFor, resolveRules, specToSource } from "../src/mfg/profiles";
import { materialFit } from "../src/mfg/materials";
import { processGuideText, processReference } from "../src/mfg/guide";
import { languageReference } from "../src/ai/reference";
import { MODIFIER_PARAMS } from "../src/lang/builtins";
import type { ProcessFinding, ProcessResult, ProcessSpec } from "../src/mfg/types";
import type { Model } from "../src/core/model";
import { briefData, isProcessSource, processKind, serializeBrief } from "../src/core/brief";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");

describe("process in the design language", () => {
  it("reads mfg.* calls, names and shared processes", () => {
    const m = evaluate(`
let mould = mfg.injection(pull: Y, draft: 1.5, material: "ABS")
part a { body box(10, 10, 10) process: mould }
part b { body box(10, 10, 10) process: "laser cut" }
part c { body box(10, 10, 10) process: mfg.cnc_mill(tool_d: 2, setups: [Z, -Z, X]) material: "POM" }
part d { body box(10, 10, 10) }
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const byName = Object.fromEntries(m.parts.map((p) => [p.name, p]));
    expect(byName.a.process).toEqual({ id: "injection", settings: { pull: [0, 1, 0], draft: 1.5 }, material: "ABS" });
    expect(byName.a.material).toBe("ABS");
    expect(byName.b.process).toEqual({ id: "laser_cut", settings: {} });
    // no material anywhere: the process's usual one
    expect(byName.b.material).toBe("Aluminum 6061");
    expect(byName.c.process?.settings.setups).toEqual([
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
    ]);
    expect(byName.c.material).toBe("POM");
    expect(byName.d.process).toBeUndefined();
    expect(byName.d.material).toBe("PLA");
    expect(byName.a.processSpan).toBeDefined();
  });

  it("gives requirements the process's rule numbers", () => {
    const m = evaluate(`
let printed = mfg.fdm(nozzle: 0.6)
param wall = 1.5
require "Printable wall": wall >= printed.min_wall
require "Mill corner": mfg.cnc_mill(tool_d: 4).min_inner_r == 2
require "Mould draft": mfg.injection(texture: true).draft >= 3
`);
    const req = Object.fromEntries(m.requirements.map((r) => [r.label, r.status]));
    expect(req["Printable wall"]).toBe("fail"); // 3 × 0.6 mm nozzle = 1.8 mm
    expect(req["Mill corner"]).toBe("pass");
    expect(req["Mould draft"]).toBe("pass");
  });

  it("explains bad settings and unknown processes", () => {
    const m = evaluate(`
part e { body box(10, 10, 10) process: mfg.fdm(bogus: 1) }
part f { body box(10, 10, 10) process: "welded" }
part g { body box(10, 10, 10) process: mfg.injection(pull: 3) }
`);
    const msgs = m.diagnostics.map((d) => d.message).join("\n");
    expect(msgs).toMatch(/no setting "bogus"/);
    expect(msgs).toMatch(/"welded" is not a process/);
    expect(msgs).toMatch(/pull .* should be a direction/);
  });

  it("recognises plain process names", () => {
    expect(processFromText("Injection moulded")).toBe("injection");
    expect(processFromText("CNC turning")).toBe("cnc_lathe");
    expect(processFromText("cnc")).toBe("cnc_mill");
    expect(processFromText("laser-cut acrylic")).toBe("laser_cut");
    expect(processFromText("3D printed (FDM)")).toBe("fdm");
    expect(processFromText("sheet_metal")).toBe("sheet_metal");
    expect(processFromText("hand carved")).toBeNull();
    // the printing technology decides, not the word "printed"
    expect(processFromText("SLA printed")).toBe("sla");
    expect(processFromText("SLS print")).toBe("sls");
    expect(processFromText("MJF printed nylon")).toBe("sls");
    expect(processFromText("3D printed in resin")).toBe("sla");
    expect(processFromText("selective laser sintering")).toBe("sls");
    expect(processFromText("die cast")).toBe("die_cast");
    // castings and metal printing are not die casting or FDM
    expect(processFromText("vacuum cast")).toBe("vacuum_cast");
    expect(processFromText("DMLS printed titanium")).toBe("metal_print");
    // processes Kerf has no rules for are not mistaken for one it has
    expect(processFromText("binder jetted steel")).toBeNull();
    expect(processFromText("binder jet")).toBeNull();
    expect(processFromValue({ id: "sla", settings: {} })).toEqual({ id: "sla", settings: {} });
    expect(processFromValue("nope")).toBeNull();
  });

  it("keeps direction lists short", () => {
    const many = Array.from({ length: 10000 }, (_, i) => [Math.cos(i), Math.sin(i), 0.3]);
    const v = processFromValue({ id: "cnc_mill", settings: { setups: [[0, 0, 1], [0, 0, 2], ...many], tool_d: "big" } })!;
    expect(v.settings.tool_d).toBeUndefined();
    const setups = v.settings.setups as number[][];
    expect(setups.length).toBe(12);
    expect(setups[0]).toEqual([0, 0, 1]);
    expect(setups.filter((d) => d[2] === 1)).toHaveLength(1);
    expect(resolveRules({ id: "cnc_mill", settings: { setups: many as [number, number, number][] } }, "Aluminum 6061").reach?.dirs.length).toBe(12);
    const m = evaluate(`part p { process: mfg.cnc_mill(setups: [Z, -Z, Z, X, -X, Y, -Y, (1,1,0), (1,-1,0), (-1,1,0), (-1,-1,0), (1,0,1), (1,0,-1), (0,1,1)]) body box(10, 10, 10) }`);
    expect(m.diagnostics.find((d) => d.severity === "error")?.message).toMatch(/at most 12 different directions/);
    const ok = evaluate(`part p { process: mfg.cnc_mill(setups: [Z, -Z, Z, X]) body box(10, 10, 10) }`);
    expect(ok.parts[0].process?.settings.setups).toHaveLength(3);
  });

  it("round-trips process source", () => {
    const spec: ProcessSpec = {
      id: "cnc_mill",
      settings: {
        tool_d: 2,
        setups: [
          [0, 0, 1],
          [0, 0, -1],
          [1, 0, 0],
        ],
      },
      material: "Aluminum 6061",
    };
    const src = specToSource(spec);
    expect(src).toBe('mfg.cnc_mill(tool_d: 2, setups: [Z, -Z, X], material: "Aluminum 6061")');
    const m = evaluate(`part p { body box(10, 10, 10) process: ${src} }`);
    expect(m.parts[0].process).toEqual(spec);
  });
});

describe("design-wide default process", () => {
  it("fills parts with no process, keeps their own material and sets the printer bed", () => {
    const m = evaluate(`
part a { body box(10, 10, 10) }
part b { body box(10, 10, 10) material: "PETG" }
part c { body box(10, 10, 10) process: mfg.cnc_mill(tool_d: 2) }
part d { body box(10, 10, 10) process: mfg.fdm(build: -Z) }
`);
    applyDefaultProcess(m, processFromValue("resin printed"), { buildVolume: [120, 70, 150] });
    const by = Object.fromEntries(m.parts.map((p) => [p.name, p]));
    expect(by.a.process).toEqual({ id: "sla", settings: { bed: [120, 70, 150] } });
    expect(by.a.processInherited).toBe(true);
    expect(by.a.material).toBe("Resin");
    // PETG is not a resin: that part is made another way
    expect(by.b.material).toBe("PETG");
    expect(by.b.process).toBeUndefined();
    expect(by.c.process).toEqual({ id: "cnc_mill", settings: { tool_d: 2 } });
    expect(by.c.processInherited).toBeUndefined();
    expect(by.d.process?.settings.bed).toEqual([120, 70, 150]);
    expect(resolveRules(by.d.process!, by.d.material).envelope?.size).toEqual([120, 70, 150]);
    // written back without the default, so the part's source keeps following the brief
    expect(ownProcess(by.d)).toEqual({ id: "fdm", settings: { build: [0, 0, -1] } });
    expect(processProbes(m, new Set(m.parts.map((p) => p.hash))).map((p) => p.id)).toEqual(["a", "c", "d"]);
  });

  it("comes from the brief, with its material and build volume", () => {
    const m = evaluate(`design "x"
brief {
  process: "FDM print"
  material: "PETG"
  build_volume: (180, 180, 180)
}
part cap { body box(10, 10, 2) }
part holder { body box(10, 10, 10) material: "PLA" }
part pin { body cylinder(d: 4, h: 400) material: "Steel" }
part plate { body box(50, 50, 3) process: mfg.laser_cut() }
part shim { body box(5, 5, 1) process: false }
`);
    expect(m.diagnostics).toEqual([]);
    const by = Object.fromEntries(m.parts.map((p) => [p.name, p]));
    expect(m.brief?.processSpec).toEqual({ id: "fdm", settings: {} });
    expect(by.cap.process).toEqual({ id: "fdm", settings: { bed: [180, 180, 180] } });
    expect(by.cap.processInherited).toBe(true);
    expect(by.cap.material).toBe("PETG");
    expect(by.holder.process?.id).toBe("fdm");
    expect(by.holder.material).toBe("PLA");
    // a steel pin is bought or cut, not printed
    expect(by.pin.process).toBeUndefined();
    expect(by.plate.process).toEqual({ id: "laser_cut", settings: {} });
    expect(by.plate.material).toBe("Aluminum 6061");
    // opted out: bought or made by hand
    expect(by.shim.process).toBeUndefined();
    expect(by.shim.processNone).toBe(true);
    const cap = "part cap { body box(10, 10, 2) }";
    expect(setPartProcess(cap, evaluate(cap).parts[0], false)).toBe("part cap { process: false body box(10, 10, 2) }");
  });

  it("reads a process value in the brief and writes it back as code", () => {
    const src = `design "x"
brief {
  process: mfg.fdm(layer: 0.28, bed: (200, 200, 180), material: "ASA")
}
part a { body box(10, 10, 10) }
`;
    const m = evaluate(src);
    expect(m.diagnostics).toEqual([]);
    expect(m.brief?.process).toBe('mfg.fdm(layer: 0.28, bed: (200, 200, 180), material: "ASA")');
    expect(m.parts[0].process).toEqual({ id: "fdm", settings: { layer: 0.28, bed: [200, 200, 180] }, material: "ASA" });
    expect(m.parts[0].material).toBe("ASA");
    expect(processKind(m.brief?.process)).toBe("fdm");
    const again = serializeBrief(briefData(m.brief)!);
    expect(again).toContain('  process: mfg.fdm(layer: 0.28, bed: (200, 200, 180), material: "ASA")\n');
    // anything that is not plain process source stays text
    expect(isProcessSource("mfg.fdm(layer: 0.2) }\npart x {")).toBe(false);
    expect(isProcessSource('mfg.fdm(material: "a)')).toBe(false);
    expect(isProcessSource("mfg.fdm(bed: (1, 2, 3]))")).toBe(false);
    expect(isProcessSource("mfg.fdm() // x")).toBe(false);
    expect(processKind("binder jetted")).toBe("other");
    expect(processKind("vacuum cast")).toBe("vacuum_cast");
    expect(processKind("CNC machined")).toBe("cnc");
  });
});

describe("process source edits", () => {
  const src = `part a {
  material: "PETG"
  body box(10, 10, 10)
}
part b { body box(5, 5, 5) }
part c {
  process: "fdm"
  body box(10, 10, 10)
}
`;
  const model = () => evaluate(src);
  const part = (m: Model, n: string) => m.parts.find((p) => p.name === n)!;

  it("inserts, replaces and removes the process property", () => {
    const m = model();
    const a = setPartProcess(src, part(m, "a"), { id: "cnc_mill", settings: {} });
    expect(a).toContain('part a {\n  process: mfg.cnc_mill()\n  material: "PETG"');
    const b = setPartProcess(src, part(m, "b"), { id: "sla", settings: {} });
    expect(b).toContain("part b { process: mfg.sla() body box(5, 5, 5) }");
    const c = setPartProcess(src, part(m, "c"), withSetting({ id: "fdm", settings: {} }, "build", [0, 0, -1]));
    expect(c).toContain("process: mfg.fdm(build: -Z)");
    const gone = setPartProcess(src, part(m, "c"), null);
    expect(gone).toContain("part c {\n  body box(10, 10, 10)\n}");
    for (const s of [a, b, c, gone]) expect(evaluate(s).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("drops settings that return to their default", () => {
    expect(withSetting({ id: "fdm", settings: { build: [0, 0, -1] } }, "build", [0, 0, 1]).settings).toEqual({});
    expect(withSetting({ id: "fdm", settings: {} }, "layer", 0.1).settings).toEqual({ layer: 0.1 });
  });
});

describe("process rules and guidance", () => {
  it("scales rules with settings and material", () => {
    expect(resolveRules({ id: "fdm", settings: { nozzle: 0.6 } }, "PLA").wall).toMatchObject({ fail: 1.2, warn: 1.8 });
    expect(resolveRules({ id: "cnc_mill", settings: { tool_d: 6 } }, "Aluminum 6061").innerRadius?.min).toBe(3);
    expect(resolveRules({ id: "injection", settings: { texture: true } }, "ABS").draft?.warn).toBe(3);
    expect(resolveRules({ id: "sheet_metal", settings: {} }, "Aluminum 6061").sheet?.bendFactor).toBe(2);
  });

  it("knows which materials suit which process", () => {
    expect(materialFit("PLA", "fdm").status).toBe("pass");
    expect(materialFit("Steel", "injection").status).toBe("fail");
    expect(materialFit("Aluminum 6061", "die_cast").status).toBe("warn");
  });

  it("tells the assistant the rules and the source to write", () => {
    const g = processGuideText({ id: "injection", settings: { pull: [0, 1, 0] } }, "ABS");
    expect(g).toContain("process: mfg.injection(pull: Y)");
    expect(g).toMatch(/Draft every face/);
    expect(g).toMatch(/\.min_wall = 1\.2/);
    for (const id of PROCESS_IDS) expect(processReference()).toContain(`mfg.${id}(`);
    expect(languageReference()).toContain("## Manufacturing processes");
  });

  it("names the draft, rib and fillet syntax now that the language has them", () => {
    // draft(), rib(), gusset() and named selections arrived with detailed modelling (#17)
    expect(MODIFIER_PARAMS.draft).toEqual(["angle", "faces", "pull", "neutral"]);
    const spec: ProcessSpec = { id: "injection", settings: { pull: [0, 1, 0], draft: 1.5 } };
    const g = processGuideText(spec, "ABS");
    expect(g).not.toMatch(/no draft modifier yet/);
    expect(g).toContain("draft(1.5, faces: facing(X) + facing(-X) + facing(Z) + facing(-Z), pull: Y)");
    expect(g).toContain("add rib(");
    expect(g).toContain('fillet(r, edges: "concave")');
    expect(processGuideText({ id: "die_cast", settings: {} })).toContain('faces: "vertical", pull: Z');
    expect(processGuideText({ id: "cnc_mill", settings: {} })).toContain('both("vertical", "concave")');
  });

  it("gives drawings a general tolerance for each process", () => {
    expect(generalToleranceFor({ id: "cnc_mill", settings: {} })).toBe("ISO 2768-m");
    expect(generalToleranceFor({ id: "laser_cut", settings: {} })).toBe("ISO 2768-m");
    expect(generalToleranceFor({ id: "fdm", settings: {} })).toBe("±0.3 UNLESS STATED");
    expect(generalToleranceFor({ id: "injection", settings: {} })).toBe("±0.1 UNLESS STATED");
  });
});

// ---------------- geometry: real OpenCASCADE solids ----------------

beforeAll(async () => {
  const wasm = readFileSync("node_modules/replicad-opencascadejs/dist/replicad_single.wasm");
  R.setOC((await (opencascade as unknown as (o: { wasmBinary: Buffer }) => Promise<unknown>)({ wasmBinary: wasm })) as never);
});

const core = new KernelCore();

/** Evaluate, build and run each part's process checks. */
function check(src: string): { model: Model; results: Record<string, ProcessResult>; find: (part: string, rule: string) => ProcessFinding | undefined } {
  const model = evaluate(src);
  const errors = model.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
  for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  const probes = processProbes(model, new Set(model.parts.map((p) => p.hash)));
  const res = core.process(probes);
  const results: Record<string, ProcessResult> = {};
  probes.forEach((p, i) => (results[p.id] = res[i]));
  for (const r of Object.values(results)) expect(r.error).toBeUndefined();
  return { model, results, find: (part, rule) => results[part]?.findings.find((f) => f.rule === rule) };
}

describe("injection moulding", () => {
  it("fails straight walls and passes drafted ones", () => {
    const { find } = check(`
part straight { process: "injection" material: "ABS" body box(60, 40, 25, r: 3) shell(2, open: Z) }
part drafted { process: "injection" material: "ABS" body cone(d1: 37, d2: 40, h: 20) shell(2, open: Z) }
part reversed { process: "injection" material: "ABS" body cone(d1: 40, d2: 37, h: 20) shell(2, open: Z) }
`);
    expect(find("straight", "draft")?.status).toBe("fail");
    expect(find("straight", "draft")?.marks?.length).toBeGreaterThan(0);
    expect(find("straight", "undercut")?.status).toBe("pass");
    expect(find("straight", "wall-thin")?.status).toBe("pass");
    expect(find("drafted", "draft")?.status).toBe("pass");
    expect(find("drafted", "undercut")?.status).toBe("pass");
    // tapered the wrong way for an open top: the core cannot pull out
    expect(find("reversed", "undercut")?.status).toBe("fail");
  });

  it("finds undercuts and the pull direction that removes them", () => {
    const { find } = check(`
part clip {
  process: mfg.injection(draft: 0.5)
  material: "ABS"
  body box(40, 20, 2)
  add box(2, 20, 15, at: (19, 0, 2))
  add box(4, 20, 2, at: (16, 0, 13))
}
`);
    const u = find("clip", "undercut")!;
    expect(u.status).toBe("fail");
    expect(u.alt).toMatchObject({ setting: "pull" });
    expect(Math.abs((u.alt!.value as number[])[2])).toBeLessThan(0.5);
  });

  it("warns about thick sections", () => {
    const { find } = check(`part block { process: "injection" material: "ABS" body box(40, 40, 20) }`);
    expect(find("block", "wall-thick")?.status).toBe("warn");
  });
});

describe("CNC", () => {
  it("fails pocket corners tighter than the tool and passes rounded ones", () => {
    const { find } = check(`
part sharp { process: mfg.cnc_mill(tool_d: 3) material: "Aluminum 6061" body box(60, 40, 20) cut box(30, 20, 10, at: (0, 0, 10.01)) }
part rounded { process: mfg.cnc_mill(tool_d: 3) material: "Aluminum 6061" body box(60, 40, 20) cut box(30, 20, 10, at: (0, 0, 10.01), r: 2) }
`);
    expect(find("sharp", "inside-corners")?.status).toBe("fail");
    expect(find("sharp", "inside-corners")?.lines?.length).toBeGreaterThan(0);
    expect(find("rounded", "inside-corners")?.status).toBe("pass");
  });

  it("asks for another setup for a side hole, and passes once it has one", () => {
    const part = (setups: string) => `part blk { process: mfg.cnc_mill(setups: ${setups}) material: "Aluminum 6061" body box(60, 40, 20) cut cylinder(d: 6, h: 80, at: (-40, 0, 10), dir: X) }`;
    const r = check(part("[Z, -Z]")).find("blk", "reach")!;
    expect(r.status).toBe("fail");
    expect(r.alt?.setting).toBe("setups");
    expect((r.alt!.value as number[][]).some((d) => Math.abs(d[0]) > 0.99)).toBe(true);
    expect(check(part("[Z, -Z, X]")).find("blk", "reach")?.status).toBe("pass");
  });

  it("reaches crossing holes from the setups that drill them", () => {
    const { find } = check(`
part crossed {
  process: mfg.cnc_mill(setups: [Z, -Z, X, -X])
  material: "Aluminum 6061"
  body box(40, 30, 20)
  cut cylinder(d: 8, h: 40, at: (0, 0, -10))
  cut cylinder(d: 6, h: 60, at: (-30, 0, 10), dir: X)
}`);
    expect(find("crossed", "reach")?.status).toBe("pass");
  });

  it("turns round parts and flags cross holes as a second operation", () => {
    const shaft = `body revolve([(0, 0), (10, 0), (10, 20), (6, 20), (6, 60), (0, 60)])`;
    const { find } = check(`
part plain { process: mfg.cnc_lathe(axis: Z) material: "Steel" ${shaft} }
part drilled { process: mfg.cnc_lathe(axis: Z) material: "Steel" ${shaft} cut cylinder(d: 3, h: 30, at: (-15, 0, 40), dir: X) }
`);
    expect(find("plain", "revolve")?.status).toBe("pass");
    expect(find("drilled", "revolve")?.status).toBe("warn");
  });
});

describe("3D printing", () => {
  it("suggests the orientation that avoids supports", () => {
    const t = (build: string) => `part t { process: mfg.fdm(build: ${build}) material: "PLA" body box(10, 10, 20) add box(50, 30, 5, at: (0, 0, 20)) }`;
    const o = check(t("Z")).find("t", "overhang")!;
    expect(o.status).toBe("warn");
    expect(o.alt).toMatchObject({ setting: "build", value: [0, 0, -1] });
    expect(check(t("-Z")).find("t", "overhang")?.status).toBe("pass");
  });

  it("prints a small fillet along the bottom edge without support", () => {
    const { find } = check(`part base { process: "fdm" material: "PLA" body box(30, 30, 10) fillet(1, edges: "bottom") }`);
    expect(find("base", "overhang")?.status).toBe("pass");
  });

  it("fails walls thinner than two nozzle widths", () => {
    const { find } = check(`part cup { process: "fdm" material: "PLA" body box(40, 40, 20) shell(0.6, open: Z) }`);
    expect(find("cup", "wall-thin")?.status).toBe("fail");
  });

  it("fails sealed voids in powder printing", () => {
    const { find } = check(`part ball { process: "sls" material: "Nylon" body box(20, 20, 20) cut sphere(d: 10, at: (0, 0, 10)) }`);
    expect(find("ball", "voids")?.status).toBe("fail");
  });
});

describe("sheet and plate", () => {
  it("fails a sharp bend", () => {
    const { find } = check(`part l { process: "sheet_metal" material: "Steel" body box(40, 30, 2) add box(2, 30, 30, at: (19, 0, 0)) }`);
    expect(find("l", "bend-radius")?.status).toBe("fail");
    expect(find("l", "sheet-uniform")?.status).toBe("pass");
  });

  it("passes a flat plate and fails a pocket in it", () => {
    const { find } = check(`
part plate { process: "laser_cut" material: "Steel" body box(80, 50, 3) cut hole(5, through: true, at: (20, 0, 3)) }
part pocket { process: "laser_cut" material: "Steel" body box(80, 50, 3) cut box(20, 20, 2, at: (0, 0, 1.5)) }
`);
    expect(find("plate", "flat-profile")?.status).toBe("pass");
    expect(find("pocket", "flat-profile")?.status).toBe("fail");
  });
});

describe("process checks in the design", () => {
  it("leave the demo designs without failures", () => {
    for (const name of ["enclosure", "reducer"]) {
      const { model, results } = check(demo(name));
      expect(Object.keys(results).length).toBeGreaterThan(1);
      const items = processItems(model, results);
      expect(items.filter((i) => i.status === "fail")).toEqual([]);
      expect(items.some((i) => i.status === "pass")).toBe(true);
    }
    // builds both demos in OpenCASCADE: about 3 s alone, more on a shared CI runner
  }, 60_000);

  it("reports findings as checks with fixes and one-click options", () => {
    const { model, results } = check(`part t { process: "fdm" material: "PLA" body box(10, 10, 20) add box(50, 30, 5, at: (0, 0, 20)) }`);
    const items = processItems(model, results);
    const overhang = items.find((i) => i.title.includes("support"))!;
    expect(overhang).toMatchObject({ category: "process", status: "warn", parts: ["t"] });
    expect(overhang.fix).toBeTruthy();
    expect(overhang.action).toMatchObject({ kind: "process-setting", part: "t", setting: "build" });
    expect(parseFindingId(overhang.id)).toMatchObject({ part: "t", rule: "overhang" });
    expect(findingFor(overhang.id, results)?.finding.marks?.length).toBeGreaterThan(0);
    expect(findingId("a#2", "draft", 1)).toBe("mfg:a#2:draft#1");
  });

  it("notes parts with no process", () => {
    const m = evaluate(`part a { body box(1, 1, 1) }`);
    expect(processItems(m, {}).map((i) => i.id)).toEqual(["mfg:none"]);
  });

  it("does not keep a result for a part that has not been built yet", () => {
    const model = evaluate(`part late { process: "fdm" body box(31, 23, 11) }`);
    const p = model.parts[0];
    const probes = processProbes(model, new Set([p.hash]));
    expect(core.process(probes)[0].error).toMatch(/not been built/);
    core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    expect(core.process(probes)[0].error).toBeUndefined();
  });

  it("caches results and compares every process on one analysis", () => {
    const { model } = check(`part cup { process: "fdm" material: "PLA" body box(40, 40, 20) shell(2, open: Z) }`);
    const part = model.parts[0];
    const probes = processProbes(model, new Set([part.hash]));
    expect(core.process(probes)[0]).toBe(core.process(probes)[0]);
    const all = core.process(compareProbes(part));
    expect(all).toHaveLength(PROCESS_IDS.length);
    const byId = Object.fromEntries(compareProbes(part).map((p, i) => [p.id, summarize(all[i])!]));
    expect(byId.fdm.fail).toBe(0);
    expect(byId.laser_cut.fail).toBeGreaterThan(0);
    expect(byId.cnc_lathe.fail).toBeGreaterThan(0);
  }, 30_000);
});
