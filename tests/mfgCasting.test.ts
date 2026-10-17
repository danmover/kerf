// Sand casting, investment casting, vacuum casting and metal printing: how
// they are named, the rules they resolve to, the materials that suit them,
// and the checks on real OpenCASCADE solids.

import { beforeAll, describe, expect, it } from "vitest";
import { KernelCore } from "../src/kernel/core";
import { evaluate } from "../src/lang/evaluator";
import { processFromText } from "../src/mfg/spec";
import { PROCESSES, PROCESS_IDS, generalToleranceFor, guideLines, resolveRules } from "../src/mfg/profiles";
import { defaultMaterial, materialFit, materialInfo, suggestMaterials } from "../src/mfg/materials";
import { processGuideText, processPromptSection, processReference } from "../src/mfg/guide";
import { compareProbes, processItems, processProbes, summarize } from "../src/mfg/report";
import { PROCESSES as BRIEF_PROCESSES, processKind } from "../src/core/brief";
import { COST_FORM, materialRecord, pricePerKg } from "../src/library/materialDb";
import { MATERIAL_SERVICE } from "../src/library/materialService";
import { mechMaterial } from "../src/analysis/materials";
import { generalDeviation } from "../src/drawing/spec";
import { adviseMaterials, processLabel, type PartFacts } from "../src/materials/advise";
import { appearanceFor } from "../src/ui/viewport/render/appearance";
import { initKernel } from "./helpers/kernel";
import type { ProcessFinding, ProcessId, ProcessResult } from "../src/mfg/types";
import type { Model } from "../src/core/model";

const NEW: ProcessId[] = ["sand_cast", "investment_cast", "vacuum_cast", "metal_print"];

describe("naming the new processes", () => {
  it("reads castings and metal printing from plain words", () => {
    expect(processFromText("sand cast")).toBe("sand_cast");
    expect(processFromText("Sand casting, machined on the bore")).toBe("sand_cast");
    expect(processFromText("green sand cast iron")).toBe("sand_cast");
    expect(processFromText("investment cast")).toBe("investment_cast");
    expect(processFromText("Lost-wax cast bronze")).toBe("investment_cast");
    expect(processFromText("vacuum casting")).toBe("vacuum_cast");
    expect(processFromText("urethane cast")).toBe("vacuum_cast");
    expect(processFromText("cast in silicone moulds")).toBe("vacuum_cast");
    // "resin" alone means SLA printing, but resin casting is vacuum casting
    expect(processFromText("resin cast")).toBe("vacuum_cast");
    expect(processFromText("SLA master, vacuum cast in PU")).toBe("vacuum_cast");
    expect(processFromText("3D printed in resin")).toBe("sla");
  });

  it("never reads metal printing as FDM or SLS", () => {
    for (const t of ["metal printed", "metal 3D printed", "Metal 3D print", "DMLS", "SLM printed", "laser powder bed fusion", "direct metal laser sintering", "metal_print"]) {
      expect(processFromText(t), t).toBe("metal_print");
    }
    expect(processFromText("3D printed titanium")).toBe("metal_print");
    expect(processFromText("printed in stainless steel")).toBe("metal_print");
    // a plastic named with the metal is still a plastic print
    expect(processFromText("3D printed steel-filled PLA")).toBe("fdm");
    expect(processFromText("3D printed")).toBe("fdm");
    // a metal word elsewhere in the sentence does not make the print metal
    expect(processFromText("3D printed brackets on an aluminium extrusion frame")).toBe("fdm");
    expect(processFromText("binder jetted stainless")).toBeNull();
  });

  it("keeps plain casting meaning die casting", () => {
    expect(processFromText("cast")).toBe("die_cast");
    expect(processFromText("casting")).toBe("die_cast");
    expect(processFromText("die cast")).toBe("die_cast");
    expect(processFromText("Die cast")).toBe("die_cast");
  });

  it("offers each process in the brief's picker under a label that reads back as it", () => {
    for (const p of BRIEF_PROCESSES.filter((x) => x.kind !== "other")) {
      expect(processKind(p.label), p.label).toBe(p.kind);
    }
    expect(BRIEF_PROCESSES.map((p) => p.label)).toEqual(expect.arrayContaining(["Sand cast", "Investment cast", "Vacuum cast", "Metal 3D print", "Die cast"]));
    expect(processKind("sand cast")).toBe("sand_cast");
    expect(processKind("lost wax")).toBe("investment_cast");
    expect(processKind("DMLS")).toBe("metal_print");
    // only the metal printer takes a build volume among the new ones
    expect(BRIEF_PROCESSES.find((p) => p.kind === "metal_print")?.print).toBe(true);
    expect(BRIEF_PROCESSES.find((p) => p.kind === "sand_cast")?.print).toBeUndefined();
    expect(MATERIAL_SERVICE["Cast iron"].processes).toEqual(["sand_cast", "cnc"]);
  });

  it("works in the design language and gives each process its usual material", () => {
    const m = evaluate(`
part a { body box(40, 40, 10) process: "sand cast" }
part b { body box(40, 40, 10) process: mfg.investment_cast(cores: false) }
part c { body box(40, 40, 10) process: mfg.vacuum_cast() }
part d { body box(40, 40, 10) process: mfg.metal_print(build: -Z, material: "Titanium") }
require "Cast wall": 5 >= mfg.sand_cast().min_wall
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const by = Object.fromEntries(m.parts.map((p) => [p.name, p]));
    expect(by.a.process?.id).toBe("sand_cast");
    expect(by.a.material).toBe("Aluminum A356");
    expect(by.b.process).toEqual({ id: "investment_cast", settings: { cores: false } });
    expect(by.b.material).toBe("Stainless 304");
    expect(by.c.material).toBe("Polyurethane");
    expect(by.d.material).toBe("Titanium");
    expect(m.requirements[0].status).toBe("pass");
    for (const id of NEW) expect(processReference()).toContain(`mfg.${id}(`);
  });
});

describe("rules for the new processes", () => {
  it("sand casting: thick walls by alloy, draft, cores, cored holes and a big envelope", () => {
    const r = resolveRules({ id: "sand_cast", settings: {} }, "Aluminum A356");
    expect(r.wall).toMatchObject({ fail: 3, warn: 4, thickRatio: 2 });
    expect(r.draft).toMatchObject({ pull: [0, 0, 1], warn: 2, fail: 0 });
    expect(r.reach).toMatchObject({ severity: "info", what: "mould", relief: "sand cores" });
    expect(r.innerRadius).toMatchObject({ min: 3, factor: 0.5, severity: "warn" });
    expect(r.holes).toMatchObject({ minD: 10 });
    expect(r.holes?.minDFail).toBeUndefined();
    expect(r.envelope?.size).toEqual([1000, 800, 600]);
    expect(r.voids?.severity).toBe("fail");
    // steel and iron flow less than aluminium and need thicker walls
    expect(resolveRules({ id: "sand_cast", settings: {} }, "Cast iron").wall).toMatchObject({ fail: 4, warn: 5 });
    expect(resolveRules({ id: "sand_cast", settings: {} }, "Steel").wall).toMatchObject({ fail: 5, warn: 6 });
    expect(resolveRules({ id: "sand_cast", settings: { cores: false, draft: 3 } }, "Bronze")).toMatchObject({ reach: { severity: "fail" }, draft: { warn: 3 } });
  });

  it("investment casting: thin walls, no draft, cores allowed, small holes drilled", () => {
    const r = resolveRules({ id: "investment_cast", settings: {} }, "Stainless 304");
    expect(r.wall).toMatchObject({ fail: 1, warn: 1.5 });
    expect(r.draft).toBeUndefined();
    expect(r.reach).toMatchObject({ severity: "info", what: "mould" });
    expect(r.innerRadius).toMatchObject({ min: 0.5, severity: "warn" });
    expect(r.holes).toMatchObject({ minD: 2.5, maxDepthRatio: 4 });
    expect(r.envelope?.size).toEqual([500, 400, 300]);
    expect(r.voids?.severity).toBe("fail");
    expect(resolveRules({ id: "investment_cast", settings: { cores: false } }, "Steel").reach?.severity).toBe("fail");
  });

  it("vacuum casting: a wall window, no draft and no undercut rules", () => {
    const r = resolveRules({ id: "vacuum_cast", settings: {} }, "Polyurethane");
    expect(r.wall).toMatchObject({ fail: 0.8, warn: 1.5, max: 8 });
    expect(r.draft).toBeUndefined();
    expect(r.reach).toBeUndefined();
    expect(r.holes?.minD).toBe(1);
    expect(r.envelope?.size).toEqual([900, 600, 400]);
    expect(r.voids?.severity).toBe("fail");
    expect(PROCESSES.vacuum_cast.bestFor).toMatch(/20 to 25 parts/);
  });

  it("metal printing: thin walls, supported overhangs, short bridges and the bed along the build", () => {
    const r = resolveRules({ id: "metal_print", settings: { build: [0, 0, -1] } }, "AlSi10Mg");
    expect(r.wall).toMatchObject({ fail: 0.4, warn: 0.8 });
    expect(r.overhang).toMatchObject({ build: [0, 0, -1], max: 45, severity: "warn", bridgeR: 4, span: 2 });
    expect(r.bedContact).toBeUndefined();
    expect(r.holes?.minD).toBe(1);
    expect(r.envelope).toMatchObject({ size: [250, 250, 300], frame: [0, 0, -1] });
    expect(r.voids?.severity).toBe("fail");
    expect(resolveRules({ id: "metal_print", settings: { bed: [400, 400, 400] } }, "Titanium").envelope?.size).toEqual([400, 400, 400]);
  });

  it("explains every rule in plain words, with the source and modelling tips", () => {
    for (const id of NEW) {
      const lines = guideLines(resolveRules({ id, settings: {} }, defaultMaterial(id)));
      expect(lines.length, id).toBeGreaterThan(3);
      const g = processGuideText({ id, settings: {} });
      expect(g, id).toContain(`process: mfg.${id}()`);
      expect(g, id).toContain("## Modelling it in Kerf");
      expect(g, id).not.toMatch(/undefined|NaN/);
    }
    expect(processGuideText({ id: "sand_cast", settings: {} })).toMatch(/sand cores, which are allowed here/);
    expect(processGuideText({ id: "sand_cast", settings: {} })).toContain('draft(2, faces: "vertical", pull: Z)');
    expect(processGuideText({ id: "investment_cast", settings: {} })).not.toMatch(/Draft every face/);
    expect(processGuideText({ id: "metal_print", settings: {} })).toMatch(/Flat ceilings wider than 2 mm need support/);
    expect(processGuideText({ id: "vacuum_cast", settings: {} })).toMatch(/Polyurethane/);
    expect(processPromptSection()).toMatch(/sand casting for one-off to hundreds/);
  });

  it("states casting tolerance grades on drawings", () => {
    expect(generalToleranceFor({ id: "sand_cast", settings: {} })).toBe("ISO 8062-3 DCTG 10");
    expect(generalToleranceFor({ id: "investment_cast", settings: {} })).toBe("ISO 8062-3 DCTG 6");
    expect(generalToleranceFor({ id: "vacuum_cast", settings: {} })).toBe("±0.25 UNLESS STATED");
    expect(generalToleranceFor({ id: "metal_print", settings: {} })).toBe("±0.2 UNLESS STATED");
    expect(generalToleranceFor({ id: "die_cast", settings: {} })).toBe("±0.15 UNLESS STATED");
    // half the total casting tolerance of the size range
    expect(generalDeviation("ISO 8062-3 DCTG 10", 50)).toBe(1.4);
    expect(generalDeviation("ISO 8062-3 DCTG 10", 120)).toBe(1.8);
    expect(generalDeviation("ISO 8062-3 DCTG 6", 20)).toBe(0.29);
    expect(generalDeviation("ISO 8062-3 DCTG 6", 5000)).toBeNull();
  });
});

describe("materials for the new processes", () => {
  it("fits the casting and printing materials to their processes", () => {
    const pass: [string, ProcessId][] = [
      ["Aluminum A356", "sand_cast"],
      ["Aluminum A356", "investment_cast"],
      ["Cast iron", "sand_cast"],
      ["Cast iron", "cnc_lathe"],
      ["Bronze", "sand_cast"],
      ["Bronze", "cnc_lathe"],
      ["Polyurethane", "vacuum_cast"],
      ["AlSi10Mg", "metal_print"],
      ["Stainless 316", "metal_print"],
      ["Titanium", "metal_print"],
      ["Titanium", "investment_cast"],
      ["Stainless 304", "investment_cast"],
      ["Steel 4140", "investment_cast"],
      ["Steel", "sand_cast"],
      ["Brass", "investment_cast"],
    ];
    for (const [m, p] of pass) expect(materialFit(m, p).status, `${m} by ${p}`).toBe("pass");
    expect(materialFit("Steel", "vacuum_cast").status).toBe("fail");
    expect(materialFit("PLA", "sand_cast").status).toBe("fail");
    expect(materialFit("Polyurethane", "metal_print").status).toBe("fail");
    // existing fits are unchanged
    expect(materialFit("PLA", "fdm").status).toBe("pass");
    expect(materialFit("Steel", "injection").status).toBe("fail");
    expect(materialFit("Aluminum 6061", "die_cast").status).toBe("warn");
  });

  it("points wrought aluminium at the casting and printing alloys", () => {
    for (const m of ["Aluminum 6061", "Aluminum 7075", "Aluminum 5052"]) {
      for (const p of ["sand_cast", "investment_cast"] as ProcessId[]) {
        const f = materialFit(m, p);
        expect(f.status, `${m} by ${p}`).toBe("warn");
        expect(f.detail).toContain("Aluminum A356");
      }
    }
    expect(materialFit("Aluminum 6061", "metal_print").detail).toContain("AlSi10Mg");
    expect(materialFit("Aluminium", "sand_cast").detail).toContain("Aluminum A356");
    // "possible but don't": never suggested for the process
    expect(suggestMaterials("sand_cast")).not.toContain("Aluminum 6061");
    expect(suggestMaterials("sand_cast")).toEqual(expect.arrayContaining(["Aluminum A356", "Cast iron", "Bronze"]));
    expect(suggestMaterials("vacuum_cast")).toEqual(["Polyurethane"]);
    expect(suggestMaterials("metal_print")).toEqual(expect.arrayContaining(["AlSi10Mg", "Stainless 316", "Titanium"]));
  });

  it("tells a vacuum-cast ABS part to name the polyurethane", () => {
    for (const m of ["ABS", "PP", "TPU"]) {
      const f = materialFit(m, "vacuum_cast");
      expect(f.status, m).toBe("warn");
      expect(f.detail, m).toContain('"Polyurethane"');
      expect(f.detail, m).toContain(`behaves like ${m}`);
    }
  });

  it("reads loose names for the new materials", () => {
    expect(materialInfo("Grey iron").processes).toContain("sand_cast");
    expect(materialInfo("ductile iron castings").family).toBe("metal");
    expect(materialInfo("Aluminium bronze").processes).toContain("sand_cast");
    expect(materialInfo("ABS-like PU resin").processes).toEqual(["vacuum_cast"]);
    expect(materialInfo("polyurethane").processes).toEqual(["vacuum_cast"]);
    expect(materialInfo("AlSi10Mg stress relieved").processes).toEqual(["metal_print"]);
    expect(materialInfo("A356-T6").processes).toContain("sand_cast");
    expect(materialInfo("316L stainless").processes).toContain("metal_print");
    expect(materialInfo("TPU 95A").processes).toContain("fdm");
    expect(mechMaterial("grey iron").name).toBe(materialRecord("Cast iron")!.grade);
    expect(mechMaterial("SAE 660 bearing bronze").name).toBe(materialRecord("Bronze")!.grade);
    expect(mechMaterial("PU resin").name).toBe(materialRecord("Polyurethane")!.grade);
    expect(mechMaterial("printed aluminium").name).toBe(materialRecord("AlSi10Mg")!.grade);
    expect(mechMaterial("Die cast aluminium").name).toBe("Aluminum A380 (die cast)");
  });

  it("prices each process in the form it buys", () => {
    expect(COST_FORM).toMatchObject({ sand_cast: "ingot", investment_cast: "ingot", vacuum_cast: "resin", metal_print: "powder" });
    expect(pricePerKg(materialRecord("Aluminum A356")!, "sand_cast")?.form).toBe("ingot");
    expect(pricePerKg(materialRecord("Cast iron")!, "sand_cast")?.form).toBe("ingot");
    expect(pricePerKg(materialRecord("Stainless 304")!, "investment_cast")?.form).toBe("ingot");
    expect(pricePerKg(materialRecord("Polyurethane")!, "vacuum_cast")?.form).toBe("resin");
    expect(pricePerKg(materialRecord("Titanium")!, "metal_print")).toEqual({ form: "powder", price: 300 });
    expect(pricePerKg(materialRecord("Stainless 316")!, "metal_print")?.form).toBe("powder");
    // machining is still priced as bar stock
    expect(pricePerKg(materialRecord("Titanium")!, "cnc_mill")?.form).toBe("stock");
  });

  it("renders the new materials with existing finishes", () => {
    for (const name of ["Aluminum A356", "Cast iron", "Bronze", "Polyurethane", "AlSi10Mg"]) {
      const m = materialRecord(name)!;
      for (const f of m.finishes) expect(appearanceFor(name, f, m.color).finish, `${name} ${f}`).toBe(f);
    }
    expect(appearanceFor("Cast iron", "bead-blasted", "#5c6066").roughness).toBeGreaterThan(appearanceFor("Steel", "bead-blasted", "#8b929c").roughness);
  });

  it("compares casting alloys and printing powders only for parts made that way", () => {
    const part = (o: Partial<PartFacts>): PartFacts => ({ name: "housing", label: "Housing", count: 1, material: "Aluminum A356", color: "#b7bbc1", process: "sand_cast", processOwn: true, volume: 80000, bbox: [[0, 0, 0], [120, 80, 40]], loads: [], ...o });
    const cast = adviseMaterials({ brief: null, part: part({}) });
    const same = cast.options.filter((o) => !o.otherWay && o.verdict !== "unsuitable").map((o) => o.name);
    expect(same).toEqual(expect.arrayContaining(["Aluminum A356", "Cast iron", "Bronze"]));
    expect(cast.options.find((o) => o.name === "Aluminum A356")?.process).toBe("sand_cast");
    expect(cast.options.find((o) => o.name === "Polyurethane")).toBeUndefined();
    const printed = adviseMaterials({ brief: null, part: part({ material: "PLA", process: "fdm", processOwn: false }) });
    for (const n of ["Aluminum A356", "Cast iron", "Polyurethane", "AlSi10Mg"]) expect(printed.options.find((o) => o.name === n), n).toBeUndefined();
    const vac = adviseMaterials({ brief: { exposure: [], priorities: [], process: "vacuum_cast", quantity: 40 } });
    expect(vac.recommended).toBe("Polyurethane");
    expect(processLabel("vacuum_cast")).toBe("vacuum casting");
    const metal = adviseMaterials({ brief: { exposure: [], priorities: [], process: "metal_print", quantity: 5 } });
    expect(metal.options.filter((o) => !o.otherWay).map((o) => o.name)).toEqual(expect.arrayContaining(["AlSi10Mg", "Stainless 316", "Titanium"]));
  });
});

// ---------------- geometry: real OpenCASCADE solids ----------------

beforeAll(initKernel);

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

const CLIP = `body box(40, 20, 6) add box(6, 20, 20, at: (17, 0, 6)) add box(12, 20, 6, at: (14, 0, 20))`;

describe("castings on real solids", () => {
  it("fails 2 mm walls for sand casting, which investment casting makes", () => {
    const cup = `body box(60, 40, 30, r: 3) shell(2, open: Z)`;
    const { find } = check(`
part sand { process: "sand_cast" material: "Aluminum A356" ${cup} }
part lost_wax { process: "investment_cast" material: "Aluminum A356" ${cup} }
`);
    expect(find("sand", "wall-thin")?.status).toBe("fail");
    expect(find("sand", "wall-thin")?.detail).toMatch(/freezes in the sand/);
    expect(find("lost_wax", "wall-thin")?.status).toBe("pass");
    // no draft rule for investment casting
    expect(find("lost_wax", "draft")).toBeUndefined();
  });

  it("warns about straight sides on a sand casting and passes drafted ones", () => {
    const { find } = check(`
part block { process: "sand_cast" material: "Cast iron" body box(60, 40, 30) }
part drafted { process: "sand_cast" material: "Cast iron" body cone(d1: 60, d2: 55, h: 30) }
`);
    const d = find("block", "draft")!;
    expect(d.status).toBe("warn");
    expect(d.detail).toMatch(/pattern tears the sand/);
    expect(d.fix).toMatch(/patternmaker adds draft/);
    expect(find("block", "undercut")?.status).toBe("pass");
    expect(find("drafted", "draft")?.status).toBe("pass");
  });

  it("allows cored undercuts by default and fails them without cores", () => {
    const { find } = check(`
part cored { process: "sand_cast" material: "Aluminum A356" ${CLIP} }
part uncored { process: mfg.sand_cast(cores: false) material: "Aluminum A356" ${CLIP} }
part wax { process: "investment_cast" material: "Stainless 304" ${CLIP} }
`);
    const u = find("cored", "undercut")!;
    expect(u.status).toBe("info");
    expect(u.detail).toMatch(/needs sand cores, which you've allowed/);
    expect(find("uncored", "undercut")?.status).toBe("fail");
    expect(find("wax", "undercut")?.status).toBe("info");
    expect(find("wax", "undercut")?.detail).toMatch(/soluble wax or ceramic cores/);
  });

  it("drills small holes in sand castings rather than failing them", () => {
    const { find } = check(`part plate { process: "sand_cast" material: "Aluminum A356" body box(80, 60, 12) cut hole(6, through: true, at: (20, 0, 12)) }`);
    const h = find("plate", "hole-small")!;
    expect(h.status).toBe("warn");
    expect(h.detail).toMatch(/drilled after casting/);
  });

  it("vacuum casts a moulded cover with no draft, and warns about a solid brick", () => {
    const { find, model, results } = check(`
part cover { process: "vacuum_cast" body box(60, 40, 25, r: 3) shell(2, open: Z) }
part brick { process: "vacuum_cast" body box(40, 40, 20) }
`);
    expect(find("cover", "wall-thin")?.status).toBe("pass");
    expect(find("cover", "draft")).toBeUndefined();
    expect(find("cover", "undercut")).toBeUndefined();
    expect(find("brick", "wall-thick")?.status).toBe("warn");
    expect(find("brick", "wall-thick")?.title).toBe("Sections over 8 mm");
    const items = processItems(model, results);
    expect(items.filter((i) => i.status === "fail")).toEqual([]);
  });
});

describe("metal printing on real solids", () => {
  it("fails a sealed void, which traps powder", () => {
    const { find } = check(`part ball { process: "metal_print" material: "Stainless 316" body box(20, 20, 20) cut sphere(d: 10, at: (0, 0, 10)) }`);
    expect(find("ball", "voids")?.status).toBe("fail");
    expect(find("ball", "voids")?.fix).toMatch(/powder/);
  });

  it("warns about supports and suggests the build direction that avoids them", () => {
    const t = (build: string) => `part t { process: mfg.metal_print(build: ${build}) body box(10, 10, 20) add box(50, 30, 5, at: (0, 0, 20)) }`;
    const o = check(t("Z")).find("t", "overhang")!;
    expect(o.status).toBe("warn");
    expect(o.detail).toMatch(/Metal supports/);
    expect(o.alt).toMatchObject({ setting: "build", value: [0, 0, -1] });
    expect(check(t("-Z")).find("t", "overhang")?.status).toBe("pass");
    // the metal printer does not need a big flat face on the bed
    expect(check(t("Z")).find("t", "bed")).toBeUndefined();
  });

  it("supports a flat ceiling that a plastic printer would bridge", () => {
    const tunnel = `body box(40, 30, 20) cut box(60, 6, 4, at: (0, 0, 8))`;
    const { find } = check(`
part metal { process: "metal_print" ${tunnel} }
part plastic { process: "fdm" material: "PLA" ${tunnel} }
`);
    expect(find("plastic", "overhang")?.status).toBe("pass");
    expect(find("metal", "overhang")?.status).toBe("warn");
  });
});

describe("every process on one part", () => {
  it("runs all of them, the new ones included", () => {
    const { model } = check(`part cup { process: "fdm" material: "PLA" body box(40, 40, 20) shell(2, open: Z) }`);
    const part = model.parts[0];
    const probes = compareProbes(part);
    expect(probes.map((p) => p.id)).toEqual(PROCESS_IDS);
    const all = core.process(probes);
    const byId = Object.fromEntries(probes.map((p, i) => [p.id, all[i]]));
    for (const id of NEW) {
      expect(byId[id].error, id).toBeUndefined();
      expect(summarize(byId[id]), id).not.toBeNull();
    }
    // a 2 mm cup is too thin to sand cast but fine to vacuum cast
    expect(summarize(byId.sand_cast)!.fail).toBeGreaterThan(0);
    expect(summarize(byId.vacuum_cast)!.fail).toBe(0);
  }, 30_000);
});
