// The find palette's ranking, the starting points' grouping and the analysis
// kinds the analysis tab and the palette offer.

import { describe, expect, it } from "vitest";
import { norm, rank, readsLikeAsk, score } from "../src/app/find";
import { ANALYSIS_KINDS, kindsFor } from "../src/ui/analysisKinds";
import { AUDIENCES, TEMPLATES, TEMPLATE_CATEGORIES, templateById } from "../src/demos/templates";
import { evaluate } from "../src/lang/evaluator";
import { readFileSync } from "node:fs";

const items = [
  { title: "Add an airflow analysis", keywords: "aero aerodynamics wind tunnel cfd drag cda", detail: "Wind tunnel: drag, CdA, power", group: "Analyse" },
  { title: "Add a strength analysis", keywords: "fea finite element stress strain deflection safety factor", detail: "Stress, deflection and safety factor", group: "Analyse" },
  { title: "Make a mould", keywords: "mould mold casting cast resin", detail: "A two-part printed mould", group: "Make" },
  { title: "Modelling tools", keywords: "advanced manual direct edit", detail: "Box, cylinder, hole, fillet", group: "Model" },
  { title: "Make", keywords: "manufacturing dfm process cost", detail: "How each part is made", group: "Panels" },
  { title: "Export STEP assembly", keywords: "export download step", detail: "Exact solids for any CAD tool · .step", group: "Export" },
  { title: "Section view", keywords: "cut cross section slice", detail: "Cut the model open", group: "View" },
];

describe("find: matching", () => {
  it("finds features by the words people use for them", () => {
    expect(rank("wind tunnel", items)[0].title).toBe("Add an airflow analysis");
    expect(rank("FEA", items)[0].title).toBe("Add a strength analysis");
    expect(rank("advanced", items)[0].title).toBe("Modelling tools");
    expect(rank("cross section", items)[0].title).toBe("Section view");
  });

  it("takes either spelling of mould", () => {
    expect(rank("mold", items)[0].title).toBe("Make a mould");
    expect(rank("moulding", [{ title: "Injection molding" }])).toHaveLength(1);
  });

  it("puts a title that starts with the query ahead of one that only mentions it", () => {
    const r = rank("make", items);
    expect(r[0].title).toBe("Make");
    expect(r.map((x) => x.title)).toContain("Make a mould");
  });

  it("drops items when a word typed matches nothing", () => {
    expect(rank("airflow zebra", items)).toHaveLength(0);
    expect(score("zebra", items[0])).toBe(0);
  });

  it("keeps the order with nothing typed", () => {
    expect(rank("  ", items).map((x) => x.title)).toEqual(items.map((x) => x.title));
  });

  it("ignores case, accents and punctuation", () => {
    expect(norm("  Cervélo S5: AERO!  ")).toBe("cervelo s5 aero");
    expect(rank("STEP", items)[0].title).toBe("Export STEP assembly");
  });

  it("reads sentences and questions as something to ask Claude", () => {
    expect(readsLikeAsk("make the wall 3 mm thicker", rank("make the wall 3 mm thicker", items)[0])).toBe(true);
    expect(readsLikeAsk("why?", undefined)).toBe(true);
    expect(readsLikeAsk("airflow", rank("airflow", items)[0])).toBe(false);
    expect(readsLikeAsk("", undefined)).toBe(false);
  });
});

describe("starting points", () => {
  it("puts every example in a kind, with the features it shows", () => {
    for (const t of TEMPLATES.filter((x) => x.id !== "blank")) {
      expect(TEMPLATE_CATEGORIES.map((c) => c.id), t.id).toContain(t.category);
      expect(t.shows?.length, t.id).toBeGreaterThan(0);
    }
  });

  it("gives each audience a real recommended example, every kind in its order, and three briefs", () => {
    for (const a of AUDIENCES) {
      expect(templateById(a.recommended), a.id).toBeTruthy();
      expect([...a.order].sort()).toEqual(TEMPLATE_CATEGORIES.map((c) => c.id).sort());
      expect(a.briefs).toHaveLength(3);
    }
  });
});

describe("analysis kinds", () => {
  const demo = (name: string) => evaluate(readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8"));

  it("knows which kind each of a design's analyses is", () => {
    const bike = demo("aero-road-bike");
    for (const a of bike.analyses) expect(ANALYSIS_KINDS.filter((k) => k.is(a)), a.label).toHaveLength(1);
  });

  it("offers gear trains only with gears, and bike rules only for bikes", () => {
    const ids = (name: string) => kindsFor(demo(name)).map((k) => k.id);
    expect(ids("shelf")).not.toContain("gears");
    expect(ids("shelf")).not.toContain("uci");
    expect(ids("reducer")).toContain("gears");
    expect(ids("aero-road-bike")).toContain("uci");
    expect(ids("shelf")).toEqual(expect.arrayContaining(["strength", "drop", "vibration", "airflow"]));
  });

  it("offers a current analysis only with a metal part, and tells it from a heat one", () => {
    const ids = (parts: { material?: string; kind?: string }[]) => kindsFor({ parts, analyses: [] }).map((k) => k.id);
    expect(ids([{ material: "Copper", kind: "part" }])).toContain("current");
    expect(ids([{ material: "PETG", kind: "part" }])).not.toContain("current");
    expect(ids([{ material: "Aluminum 6061", kind: "component" }])).not.toContain("current");
    const m = evaluate(`part bar { box(100, 10, 2)  material: "Copper" }
analysis "Bus" { parts: [bar]  heat: [current(face(bar, -X), face(bar, +X), 100A)] }
analysis "Warm" { parts: [bar]  heat: [source(bar, 2W)] }`);
    const kinds = m.analyses.map((a) => ANALYSIS_KINDS.filter((k) => k.is(a)).map((k) => k.id));
    expect(kinds).toEqual([["current"], ["heat"]]);
  });
});

describe("starting a design from a description", () => {
  it("names the project from the first clause, without the request words", async () => {
    const { nameFrom } = await import("../src/app/startDesign");
    expect(nameFrom("Design a wall bracket for a 25 mm tube, held by two M4 screws")).toBe("Wall bracket for a 25 mm tube");
    expect(nameFrom("can you make me a box for an Arduino Uno with a USB cutout")).toBe("Box for an Arduino Uno with a USB cutout");
    expect(nameFrom("A 3:1 spur gearbox on 8 mm shafts. It drives a winch")).toBe("3:1 spur gearbox on 8 mm shafts");
    expect(nameFrom("make a 2.5 mm thick washer")).toBe("2.5 mm thick washer");
    expect(nameFrom("   ")).toBe("Untitled design");
    expect(nameFrom("I need a very long description of a thing that goes on and on without stopping anywhere at all").length).toBeLessThanOrEqual(48);
  });
});
