import { describe, expect, it } from "vitest";
import { adviceText, adviseMaterials, needsFromName, stockCost, type AnalysisFacts, type BriefFacts, type PartFacts } from "../src/materials/advise";
import { MATERIAL_DB, materialRecord, pricePerKg } from "../src/library/materialDb";
import { MATERIAL_LIST } from "../src/library/materials";
import { MATERIAL_SERVICE } from "../src/library/materialService";
import { allowableStress, mechMaterial } from "../src/analysis/materials";
import { materialInfo, suggestMaterials } from "../src/mfg/materials";
import type { V3 } from "../src/kernel/recipe";

const box = (x: number, y: number, z: number): [V3, V3] => [
  [0, 0, 0],
  [x, y, z],
];

const part = (o: Partial<PartFacts> = {}): PartFacts => ({
  name: "bracket",
  label: "Bracket",
  count: 1,
  material: "PLA",
  color: "#f2f0eb",
  process: "fdm",
  processOwn: false,
  volume: 30000,
  bbox: box(60, 40, 30),
  loads: [{ text: "Holds a shelf", load: 80 }],
  ...o,
});

const outdoor: BriefFacts = { temp: [-10, 60], outdoor: true, exposure: ["sunlight", "rain"], priorities: ["strength", "low cost"], process: "fdm" };
const indoor: BriefFacts = { exposure: [], priorities: ["strength", "low cost"], process: "fdm" };

const shelfLoad: AnalysisFacts = { label: "Shelf load", target: 2, printed: true, material: "PLA", stress: 9, layerStress: 6, disp: 0.6, gravity: false, exact: true };

describe("material database", () => {
  it("feeds every material view from one record", () => {
    const names = MATERIAL_DB.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(MATERIAL_LIST.map((m) => m.name)).toEqual(names);
    for (const m of MATERIAL_DB) {
      expect(MATERIAL_SERVICE[m.name].maxC, m.name).toBe(m.maxC);
      expect(mechMaterial(m.name).E, m.name).toBe(m.mech.E);
      expect(materialInfo(m.name).family, m.name).toBe(m.family);
      expect(m.processes.length, m.name).toBeGreaterThan(0);
      expect(m.mech.yield, m.name).toBeLessThanOrEqual(m.mech.uts);
      expect(m.minC, m.name).toBeLessThan(m.maxC);
      expect(m.snapStrain, m.name).toBeGreaterThan(0);
      for (const p of m.processes) expect(pricePerKg(m, p), `${m.name} by ${p}`).not.toBeNull();
    }
  });

  it("keeps special-purpose materials out of the process suggestions", () => {
    expect(suggestMaterials("fdm")).not.toContain("TPU");
    expect(suggestMaterials("cnc_mill")).not.toContain("FR4");
    expect(suggestMaterials("fdm")).toContain("PETG");
  });
});

describe("material advisor", () => {
  it("picks a UV-stable printing plastic for an outdoor printed bracket, and rules PLA out", () => {
    const a = adviseMaterials({ brief: outdoor, part: part() });
    expect(a.recommended).toBe("ASA");
    const pla = a.options.find((o) => o.name === "PLA")!;
    expect(pla.current).toBe(true);
    expect(pla.verdict).toBe("unsuitable");
    expect(pla.criteria.find((k) => k.key === "heat")!.grade).toBe("fail");
    // printed materials first, then the ones that need another process
    const firstOther = a.options.findIndex((o) => o.otherWay);
    const lastSame = a.options.map((o) => !o.otherWay && o.verdict !== "unsuitable").lastIndexOf(true);
    expect(firstOther).toBeGreaterThan(lastSame);
    const alu = a.options.find((o) => o.name === "Aluminum 6061")!;
    expect(alu.processChange).toMatchObject({ from: "fdm", to: "cnc_mill" });
    expect(alu.finish).toBe("anodized");
    expect(adviceText(a)).toContain("If made another way:");
  });

  it("scales the latest analysis to each material", () => {
    const a = adviseMaterials({ brief: indoor, part: part({ analysis: shelfLoad }) });
    const pla = a.options.find((o) => o.name === "PLA")!;
    const allow = allowableStress(mechMaterial("PLA")).value;
    const lf = materialRecord("PLA")!.mech.layerFactor;
    expect(pla.estimate!.safety).toBeCloseTo(Math.min(allow / 9, (allow * lf) / 6), 6);
    expect(pla.estimate!.deflection).toBeCloseTo(0.6, 6);
    expect(pla.estimate!.exact).toBe(true);
    const petg = a.options.find((o) => o.name === "PETG")!;
    expect(petg.estimate!.deflection).toBeCloseTo((0.6 * mechMaterial("PLA").E) / mechMaterial("PETG").E, 6);
    // with self-weight in the load, the estimate is only approximate
    const g = adviseMaterials({ brief: indoor, part: part({ analysis: { ...shelfLoad, gravity: true } }) });
    expect(g.options.find((o) => o.name === "PETG")!.estimate!.exact).toBe(false);
  });

  it("fails a material the analysis says would break", () => {
    const a = adviseMaterials({ brief: indoor, part: part({ analysis: { ...shelfLoad, stress: 60, layerStress: 50 } }) });
    const pla = a.options.find((o) => o.name === "PLA")!;
    expect(pla.estimate!.safety).toBeLessThan(1);
    expect(pla.verdict).toBe("unsuitable");
  });

  it("reads what a gear needs from its name", () => {
    expect(needsFromName("gear_big")).toEqual(["low friction", "wear resistant"]);
    const a = adviseMaterials({ brief: null, part: part({ name: "gear_big", label: "Big gear", process: undefined, loads: [] }) });
    expect(a.options.slice(0, 2).map((o) => o.name).sort()).toEqual(["Nylon", "POM"]);
    expect(a.basis.join(" ")).toContain("(from the name)");
  });

  it("keeps a moulded food part on moulding plastics that take the heat", () => {
    const a = adviseMaterials({ brief: { exposure: ["food contact"], priorities: ["looks"], process: "injection", quantity: 5000, temp: [0, 90] } });
    const best = a.options.find((o) => o.name === a.recommended)!;
    expect(best.process).toBe("injection");
    expect(best.otherWay).toBe(false);
    expect(best.criteria.find((k) => k.key === "food")!.grade).not.toBe("poor");
    expect(["PLA", "PETG", "ABS"].every((n) => a.options.find((o) => o.name === n)!.verdict === "unsuitable")).toBe(true);
    // die-cast alloys only join at production quantities
    expect(a.options.some((o) => o.name === "Zamak 3")).toBe(true);
    const few = adviseMaterials({ brief: { exposure: [], priorities: [], process: "injection", quantity: 10 } });
    expect(few.options.some((o) => o.name === "Zamak 3")).toBe(false);
  });

  it("only suggests another process when the part's own process allows it", () => {
    const own = part({ processOwn: true });
    const kept = adviseMaterials({ brief: indoor, part: own });
    expect(kept.options.find((o) => o.name === "Steel")!.verdict).toBe("unsuitable");
    const free = adviseMaterials({ brief: indoor, part: own, keepProcess: false });
    const steel = free.options.find((o) => o.name === "Steel")!;
    expect(steel.verdict).not.toBe("unsuitable");
    expect(steel.otherWay).toBe(true);
  });

  it("cuts plates and machines blocks", () => {
    const block = adviseMaterials({ brief: null, part: part({ process: undefined, material: "Acrylic" }) });
    expect(block.options.find((o) => o.name === "Acrylic")!.process).toBe("cnc_mill");
    const plate = adviseMaterials({ brief: null, part: part({ process: undefined, material: "Acrylic", bbox: box(120, 80, 4), volume: 120 * 80 * 4 }) });
    expect(plate.options.find((o) => o.name === "Acrylic")!.process).toBe("laser_cut");
  });

  it("mills 6061 rather than the gummy sheet alloy, and still bends the sheet alloy", () => {
    const milled = adviseMaterials({ brief: null, part: part({ process: "cnc_mill", material: "Aluminum 6061" }) });
    const rank = (n: string) => milled.options.findIndex((o) => o.name === n);
    expect(rank("Aluminum 6061")).toBeLessThan(rank("Aluminum 5052"));
    const gummy = milled.options.find((o) => o.name === "Aluminum 5052")!.criteria.find((k) => k.key === "making")!;
    expect(gummy.grade).toBe("poor");
    expect(gummy.why).toMatch(/6061/);
    const bent = adviseMaterials({ brief: null, part: part({ process: "sheet_metal", material: "Aluminum 5052", bbox: box(120, 80, 2), volume: 120 * 80 * 2 }) });
    expect(bent.options.find((o) => o.name === "Aluminum 5052")!.criteria.find((k) => k.key === "making")!.grade).toBe("good");
  });

  it("brings in special materials only when a need calls for them", () => {
    const plain = adviseMaterials({ brief: null, part: part({ name: "cover", label: "Cover", process: undefined }) });
    expect(plain.options.some((o) => o.name === "TPU" || o.name === "Silicone")).toBe(false);
    const seal = adviseMaterials({ brief: null, part: part({ name: "seal", label: "Seal", process: undefined, loads: [] }), needs: ["soft"] });
    expect(["TPU", "Silicone"]).toContain(seal.recommended);
    expect(seal.options.find((o) => o.name === "PETG")!.verdict).toBe("unsuitable");
  });

  it("rules out a material that takes the design over its mass limit", () => {
    const a = adviseMaterials({ brief: { ...indoor, maxMass: 120 }, part: part({ otherMass: 60 }) });
    const steel = a.options.find((o) => o.name === "Steel")!;
    expect(steel.criteria.find((k) => k.key === "mass")!.grade).toBe("fail");
    expect(steel.verdict).toBe("unsuitable");
    expect(a.options.find((o) => o.name === "PETG")!.verdict).not.toBe("unsuitable");
  });

  it("prices material by the form it is bought in", () => {
    const a = adviseMaterials({ brief: null, part: part({ process: "cnc_mill", material: "Aluminum 6061" }) });
    const alu = a.options.find((o) => o.name === "Aluminum 6061")!;
    expect(alu.costForm).toBe("stock");
    // the stock block, not the finished part
    const stock = (65 * 45 * 35) / 1e6;
    expect(alu.cost).toBeCloseTo(stock * 2.7 * pricePerKg(materialRecord("Aluminum 6061")!, "cnc_mill")!.price, 6);
    // the parts list prices the same stock
    const listed = stockCost(materialRecord("Aluminum 6061")!, part({ process: "cnc_mill", material: "Aluminum 6061" }), null)!;
    expect(listed.cost).toBeCloseTo(alu.cost!, 6);
    expect(listed.form).toBe("stock");
    expect(stockCost(materialRecord("PLA")!, part({ bought: true }), null)).toBeNull();
  });
});
