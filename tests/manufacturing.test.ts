import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { briefData, serializeBrief } from "../src/core/brief";
import { availability, availabilityText, fullAccess, processList } from "../src/mfg/availability";
import { crossover, estimateCost, logQuantities, type CostGeometry } from "../src/mfg/cost";
import { meshFacts, withStats } from "../src/mfg/geometry";
import { assemblyLearning, defaultTiers, designText, designTotals, planManufacturing, planText, type PlanRequest } from "../src/mfg/advisor";
import { PROCESS_IDS } from "../src/mfg/profiles";
import type { BriefFacts, PartFacts } from "../src/materials/advise";
import type { ProcessId, ProcessResult } from "../src/mfg/types";
import type { V3 } from "../src/kernel/recipe";

const box = (x: number, y: number, z: number): [V3, V3] => [
  [0, 0, 0],
  [x, y, z],
];

/** A hollow 80 × 60 × 30 mm box with 2 mm walls: an enclosure base. */
const enclosure: CostGeometry = {
  volume: 80 * 60 * 30 - 76 * 56 * 28,
  area: 2 * (80 * 60 + 60 * 30 + 80 * 30) * 2,
  bbox: box(80, 60, 30),
  projected: [60 * 30, 80 * 30, 80 * 60],
  wall: 2,
};

/** A solid aluminium block, 60 × 40 × 20 mm. */
const block: CostGeometry = { volume: 60 * 40 * 20, area: 2 * (60 * 40 + 40 * 20 + 60 * 20), bbox: box(60, 40, 20), projected: [800, 1200, 2400] };

/** A 2 mm sheet bracket, 100 × 40 mm before one bend. */
const bracket: CostGeometry = { volume: 100 * 40 * 2, area: 2 * 100 * 40 + 2 * 2 * (100 + 40), bbox: box(60, 40, 42), projected: [3000, 4000, 2400], sheetT: 2, bends: 1, holes: 2 };

const order = { access: "order" as const };

const part = (o: Partial<PartFacts> = {}): PartFacts => ({
  name: "base",
  label: "Base",
  count: 1,
  material: "PETG",
  color: "#2b2f36",
  process: "fdm",
  processOwn: true,
  volume: enclosure.volume,
  bbox: enclosure.bbox,
  loads: [],
  ...o,
});

const brief: BriefFacts = { exposure: [], priorities: ["low cost"], process: "fdm" };

const pass = (key = "x|y"): ProcessResult => ({ key, findings: [{ rule: "wall", status: "pass", title: "Walls are thick enough", detail: "" }], stats: {}, ms: 1 }) as unknown as ProcessResult;
const fail = (rule = "undercut"): ProcessResult => ({ key: "x|y", findings: [{ rule, status: "fail", title: "Undercut", detail: "" }], stats: {}, ms: 1 }) as unknown as ProcessResult;

/** Every process checked and passing, except the ones listed. */
const fits = (failing: ProcessId[] = []): PlanRequest["fits"] => Object.fromEntries(PROCESS_IDS.map((id) => [id, failing.includes(id) ? fail() : pass()]));

const request = (o: Partial<PlanRequest> = {}): PlanRequest => ({
  part: part(),
  geometry: enclosure,
  brief,
  access: fullAccess({}),
  fits: fits(),
  tiers: defaultTiers(),
  labour: 20,
  ...o,
});

describe("process availability", () => {
  it("treats everything as orderable until the user says otherwise", () => {
    const a = fullAccess({});
    expect(PROCESS_IDS.every((id) => a[id] === "order")).toBe(true);
    expect(fullAccess({ fdm: "own", injection: "none", bogus: "own" } as never).fdm).toBe("own");
  });

  it("lets the brief replace what Settings says, list by list", () => {
    const saved = { fdm: "own", laser_cut: "own", injection: "none" } as const;
    const fromSettings = availability(null, saved);
    expect(fromSettings.fromBrief).toBe(false);
    expect(fromSettings.access.laser_cut).toBe("own");
    // the brief's workshop replaces the owned set; ordering still comes from Settings (where owning counts as able to order)
    const b = availability({ workshop: ["CNC milling"] }, saved);
    expect(b.fromBrief).toBe(true);
    expect(b.access.cnc_mill).toBe("own");
    expect(b.access.fdm).toBe("order");
    expect(b.access.injection).toBe("none");
    // can_order replaces the ordered set, so anything not listed is off
    const c = availability({ workshop: ["fdm"], canOrder: ["sheet metal"] }, {});
    expect(c.access.fdm).toBe("own");
    expect(c.access.sheet_metal).toBe("order");
    expect(c.access.cnc_mill).toBe("none");
    expect(availabilityText(c.access, true)).toMatch(/Has: FDM.*\(fdm\).*set in this project's brief/);
  });

  it("reads loose process names", () => {
    expect(processList(["fdm", "laser cut", "CNC machining", "unknown thing", "fdm"])).toEqual(["fdm", "laser_cut", "cnc_mill"]);
  });

  it("round-trips workshop and can_order through the brief", () => {
    const src = `design "x"\nbrief {\n  purpose: "A box"\n  workshop: ["fdm", "laser_cut"]\n  can_order: ["cnc_mill", "sheet metal"]\n}\npart a { body box(1, 1, 1) }\n`;
    const m = evaluate(src);
    expect(m.diagnostics).toEqual([]);
    const data = briefData(m.brief)!;
    expect(data.workshop).toEqual(["fdm", "laser_cut"]);
    expect(data.canOrder).toEqual(["cnc_mill", "sheet metal"]);
    const again = evaluate(`design "y"\n${serializeBrief(data)}\npart a { body box(1, 1, 1) }\n`);
    expect(briefData(again.brief)).toEqual(data);
    // an empty list says "none": nothing can be ordered for this design
    expect(availability({ canOrder: [] }, {}).access.cnc_mill).toBe("none");
  });

  it("warns about a process it does not know", () => {
    const m = evaluate(`design "x"\nbrief {\n  workshop: ["fdm", "basket weaving"]\n}\n`);
    expect(m.diagnostics.some((d) => d.severity === "warning" && /basket weaving/.test(d.message))).toBe(true);
  });
});

describe("cost model", () => {
  it("spreads tooling over the quantity", () => {
    const one = estimateCost("injection", "ABS", enclosure, 1, order)!;
    const many = estimateCost("injection", "ABS", enclosure, 10000, order)!;
    expect(one.tooling).toBeGreaterThan(1000);
    expect(one.unit).toBeGreaterThan(1000);
    expect(many.unit).toBeLessThan(5);
    expect(many.range[0]).toBeLessThan(many.unit);
    expect(many.range[1]).toBeGreaterThan(many.unit);
    expect(many.total).toBeCloseTo(many.unit * 10000, 0);
  });

  it("prices printing with no tooling and a falling unit cost", () => {
    const one = estimateCost("fdm", "PETG", enclosure, 1, order)!;
    const fifty = estimateCost("fdm", "PETG", enclosure, 50, order)!;
    expect(one.tooling).toBe(0);
    expect(one.unit).toBeGreaterThan(3);
    expect(one.unit).toBeLessThan(60);
    expect(fifty.unit).toBeLessThan(one.unit);
  });

  it("makes your own machine cheaper than a service for one part", () => {
    const own = estimateCost("fdm", "PETG", enclosure, 1, { access: "own", labour: 20 })!;
    const shop = estimateCost("fdm", "PETG", enclosure, 1, order)!;
    expect(own.unit).toBeLessThan(shop.unit);
    expect(own.days[1]).toBeLessThanOrEqual(shop.days[0]);
  });

  it("prices machining by material and sheet metal by cut length and bends", () => {
    const al = estimateCost("cnc_mill", "Aluminum 6061", block, 1, order)!;
    const steel = estimateCost("cnc_mill", "Stainless 304", block, 1, order)!;
    expect(al.unit).toBeGreaterThan(30);
    expect(steel.unit).toBeGreaterThan(al.unit);
    const sheet1 = estimateCost("sheet_metal", "Steel (mild)", bracket, 1, order);
    const sheet500 = estimateCost("sheet_metal", "Steel (mild)", bracket, 500, order);
    expect(sheet1 && sheet500).toBeTruthy();
    expect(sheet500!.unit).toBeLessThan(sheet1!.unit / 3);
  });

  it("finds where one process overtakes another", () => {
    const g = enclosure;
    const fdm = (q: number) => estimateCost("fdm", "PETG", g, q, order)!.unit;
    const inj = (q: number) => estimateCost("injection", "ABS", g, q, order)!.unit;
    const at = crossover(fdm, inj, 1, 1_000_000);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(50);
    expect(at!).toBeLessThan(20000);
    expect(inj(at!)).toBeLessThanOrEqual(fdm(at!));
    expect(inj(at! - 1)).toBeGreaterThan(fdm(at! - 1));
    expect(logQuantities(1, 1000, 3)).toEqual([1, 2, 5, 10, 22, 46, 100, 215, 464, 1000]);
  });
});

describe("geometry for costing", () => {
  it("measures a mesh's area and silhouettes", () => {
    // a unit cube as 12 triangles
    const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
    const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const f = meshFacts(p, i);
    expect(f.area).toBeCloseTo(6);
    expect(f.projected.map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 1, 1]);
  });

  it("folds what the checks measured into the geometry", () => {
    const r = { key: "a|b", findings: [{ rule: "undercut", status: "warn", title: "", detail: "" }], stats: { nominalWall: 2.4, bends: 3, holes: 4 }, ms: 1 } as unknown as ProcessResult;
    const g = withStats(block, r);
    expect(g.wall).toBe(2.4);
    expect(g.bends).toBe(3);
    expect(g.holes).toBe(4);
    expect(g.undercuts).toBe(1);
    expect(withStats(block, undefined)).toBe(block);
  });
});

describe("manufacturing advisor", () => {
  it("prints a prototype and moulds production", () => {
    const plan = planManufacturing(request());
    const [proto, batch, prod] = plan.tiers;
    expect(proto.recommended?.process).toMatch(/^(fdm|sla|sls)$/);
    expect(prod.recommended?.process).toMatch(/^(injection|vacuum_cast)$/);
    expect(prod.recommended!.costs[2]!.unit).toBeLessThan(proto.recommended!.costs[0]!.unit);
    expect(batch.cheapest).toBeDefined();
    // the cheapest pick is never dearer than the recommended one
    for (const [i, t] of plan.tiers.entries()) expect(t.cheapest!.costs[i]!.unit).toBeLessThanOrEqual(t.recommended!.costs[i]!.unit);
    expect(plan.bands.length).toBeGreaterThan(1);
    expect(plan.bands[0].from).toBe(1);
    expect(plan.bands.at(-1)!.to).toBeUndefined();
  });

  it("only recommends processes the user can use, and says what they are missing", () => {
    const access = fullAccess(Object.fromEntries(PROCESS_IDS.map((id) => [id, id === "fdm" ? "own" : "none"])));
    const plan = planManufacturing(request({ access }));
    for (const t of plan.tiers) expect(t.recommended?.process).toBe("fdm");
    expect(plan.tiers[0].recommended!.access).toBe("own");
    expect(plan.tiers[2].hints.join(" ")).toMatch(/not in your processes/);
    expect(plan.routes.find((r) => r.process === "injection")!.status).toBe("unavailable");
  });

  it("does not pick a route whose shape checks fail, and says what fixing it would save", () => {
    const plan = planManufacturing(request({ fits: fits(["injection"]) }));
    expect(plan.tiers[2].recommended?.process).not.toBe("injection");
    expect(plan.routes.find((r) => r.process === "injection")!.status).toBe("needs-changes");
    expect(plan.tiers[2].hints.join(" ")).toMatch(/Injection.*once one failing check is fixed/);
  });

  it("keeps the part's material where it suits the process", () => {
    const plan = planManufacturing(request());
    const fdm = plan.routes.find((r) => r.process === "fdm")!;
    expect(fdm.material).toBe("PETG");
    expect(fdm.materialChange).toBe(false);
    expect(fdm.current).toBe(true);
  });

  it("counts every copy of the part in a design", () => {
    const plan = planManufacturing(request({ part: part({ count: 4 }) }));
    expect(plan.count).toBe(4);
    expect(plan.tiers.map((t) => t.parts)).toEqual([4, 200, 20000]);
  });

  it("adds the brief's quantity as its own tier", () => {
    expect(defaultTiers(300).map((t) => [t.qty, !!t.brief])).toEqual([
      [1, false],
      [50, false],
      [300, true],
      [5000, false],
    ]);
    expect(defaultTiers(50).filter((t) => t.brief).map((t) => t.qty)).toEqual([50]);
  });

  it("explains the plan to Claude", () => {
    const text = planText(planManufacturing(request()));
    expect(text).toMatch(/How to make Base/);
    expect(text).toMatch(/Prototype, 1 design/);
    expect(text).toMatch(/recommended: /);
    expect(text).toMatch(/not quotes/);
  });

  it("totals the whole design", () => {
    const plans = [planManufacturing(request()), planManufacturing(request({ part: part({ name: "lid", label: "Lid", count: 2 }) }))];
    const tiers = defaultTiers();
    const extras = { bought: 12.5, assemblySeconds: 600, labour: 30 };
    const totals = designTotals(plans, tiers, extras);
    expect(totals).toHaveLength(3);
    expect(totals[0].assembly).toBeCloseTo(5);
    expect(totals[2].assembly).toBeLessThan(totals[0].assembly);
    expect(totals[2].assembly).toBeCloseTo(5 * assemblyLearning(5000));
    for (const t of totals) {
      expect(t.each).toBeCloseTo(t.made + t.bought + t.assembly);
      expect(t.total).toBeCloseTo(t.each * t.qty);
      expect(t.missing).toEqual([]);
    }
    expect(totals[2].each).toBeLessThan(totals[0].each);
    expect(designText(plans, totals, extras)).toMatch(/per design/);
  });
});
