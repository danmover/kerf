import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { briefChanges, briefData, briefHasErrors, emptyBrief, openAssumptions, protectedBriefChanges, serializeBrief, slugId, writeBrief, confirmAssumption, processKind } from "../src/core/brief";
import { briefChecks, assemblyStats } from "../src/core/briefChecks";
import { assembleReport } from "../src/core/checks";
import { languageReference } from "../src/ai/reference";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");

const BRACKET = `design "Tube bracket"

brief {
  purpose: "Hold a 25 mm steel tube 40 mm off a workshop wall"
  setting: "Indoor workshop, screwed into plywood"
  priorities: ["strength", "print time"]
  temp: -5C .. 60C
  outdoor: false assumed
  exposure: ["dust", "impacts"]
  process: "FDM print"
  material: "PETG" assumed
  quantity: 4
  max_size: (80, 60, 70)
  max_mass: 0.2kg

  use hold_tube "Holds the tube without slipping" { load: 2kg, dir: -Z, on: holder }
  use mount "Screws to the wall with two M4 screws"
  use drop_in "The tube drops in from the front" assumed

  given tube_d = 25mm "Tube outside diameter, measured"
  given offset = 40mm "Wall to tube centre" assumed

  reference photo1 "Tube against the wall" { file: "ast_abc123", notes: "Tube centre about 40 mm off the wall" }
  reference catalog "Tube supplier page" { url: "https://example.com/tube" }

  assume "Wood screws, not machine screws"
  assume "Printed with 4 walls" confirmed
}

param wall = 4mm
part holder {
  material: "PLA"
  body box(tube_d + 2 * wall, 30, offset + tube_d / 2 + wall)
}
require "Bore fits the tube" for hold_tube: tube_d + 0.4 > tube_d
require "Wall is printable" for hold_tube, mount: wall >= 1.2
require "Typo link" for hold_tub: wall > 0
`;

describe("the brief", () => {
  it("reads every kind of brief entry", () => {
    const m = evaluate(BRACKET);
    const errors = m.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
    const b = m.brief!;
    expect(b.purpose).toMatch(/25 mm steel tube/);
    expect(b.priorities).toEqual(["strength", "print time"]);
    expect(b.temp).toEqual([-5, 60]);
    expect(b.outdoor).toBe(false);
    expect(b.assumed).toEqual(["outdoor", "material"]);
    expect(b.quantity).toBe(4);
    expect(b.maxSize).toEqual([80, 60, 70]);
    expect(b.maxMass).toBeCloseTo(200);
    expect(b.uses.map((u) => u.id)).toEqual(["hold_tube", "mount", "drop_in"]);
    // a hanging mass becomes its weight
    expect(b.uses[0].load).toBeCloseTo(19.62, 2);
    expect(b.uses[0].dir).toEqual([0, 0, -1]);
    expect(b.uses[0].on).toBe("holder");
    expect(b.uses[2].assumed).toBe(true);
    expect(b.givens.map((g) => [g.name, g.value, g.assumed])).toEqual([
      ["tube_d", 25, false],
      ["offset", 40, true],
    ]);
    expect(b.refs[0].file).toBe("ast_abc123");
    expect(b.refs[1].url).toBe("https://example.com/tube");
    expect(b.assumptions).toEqual([
      expect.objectContaining({ text: "Wood screws, not machine screws", confirmed: false }),
      expect.objectContaining({ text: "Printed with 4 walls", confirmed: true }),
    ]);
  });

  it("makes givens usable by the design and tracks who reads them", () => {
    const m = evaluate(BRACKET);
    const tube = m.brief!.givens.find((g) => g.name === "tube_d")!;
    expect(tube.usedBy).toContain("holder");
    expect(m.graph.nodes.find((n) => n.id === "tube_d")?.kind).toBe("given");
    // givens are facts, never parameters the solver may change
    expect(m.params.map((p) => p.name)).toEqual(["wall"]);
  });

  it("links requirements to uses and warns about unknown ones", () => {
    const m = evaluate(BRACKET);
    expect(m.requirements.find((r) => r.label === "Wall is printable")?.uses).toEqual(["hold_tube", "mount"]);
    const warn = m.diagnostics.find((d) => d.message.includes("hold_tub"));
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toMatch(/Did you mean "hold_tube"/);
  });

  it("keeps the rest of the brief when one entry is broken", () => {
    const src = `design "x"\nbrief {\n  purpose: "Hold things"\n  use 12 "bad id"\n  use ok "Still read"\n}\n`;
    const m = evaluate(src);
    expect(m.diagnostics.some((d) => d.severity === "error")).toBe(true);
    expect(m.brief?.purpose).toBe("Hold things");
    expect(m.brief?.uses.map((u) => u.id)).toEqual(["ok"]);
    expect(briefHasErrors(src, m)).toBe(true);
  });

  it("explains bad values", () => {
    const m = evaluate(`design "x"\nbrief {\n  temp: 60C .. 10C\n  quantity: 2.5\n  max_size: (10, 20)\n  colour: "red"\n}\n`);
    const msgs = m.diagnostics.map((d) => d.message).join("\n");
    expect(msgs).toMatch(/lowest temperature comes first/);
    expect(msgs).toMatch(/whole number/);
    expect(msgs).toMatch(/three positive sizes/);
    expect(msgs).toMatch(/no field "colour"/);
    // unknown fields survive a rewrite
    expect(serializeBrief(briefData(m.brief)!)).toContain('colour: "red"');
  });

  it("rejects a second brief", () => {
    const m = evaluate(`design "x"\nbrief {\n}\nbrief {\n}\n`);
    expect(m.diagnostics.some((d) => /one brief/.test(d.message))).toBe(true);
  });

  it("writes the brief back so it reads the same", () => {
    const m = evaluate(BRACKET);
    const data = briefData(m.brief)!;
    const text = serializeBrief(data);
    const again = evaluate(`design "y"\n${text}\npart holder { body box(1, 1, 1) }\nrequire "a" for hold_tube: 1 > 0`);
    expect(again.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(briefData(again.brief)).toEqual(data);
  });

  it("escapes text so quotes and new lines survive", () => {
    const data = { ...emptyBrief(), purpose: 'A "quoted" purpose\\ with a\nnew line' };
    const m = evaluate(`design "q"\n${serializeBrief(data)}\n`);
    expect(m.brief?.purpose).toBe(data.purpose);
  });

  it("adds a brief after the design name and notes", () => {
    const src = `design "Box"\nnote "A note"\n\n// layout\nparam w = 10mm\n`;
    const out = writeBrief(src, evaluate(src), { ...emptyBrief(), purpose: "Store screws" });
    expect(out).toBe(`design "Box"\nnote "A note"\n\nbrief {\n  purpose: "Store screws"\n}\n\n// layout\nparam w = 10mm\n`);
    const m = evaluate(out);
    expect(m.brief?.purpose).toBe("Store screws");
    // and replaces it in place next time
    const out2 = writeBrief(out, m, { ...emptyBrief(), purpose: "Store nails" });
    expect(out2).toBe(out.replace("screws", "nails"));
  });

  it("adds a brief to the blank template", () => {
    const src = demo("blank");
    const out = writeBrief(src, evaluate(src), { ...emptyBrief(), purpose: "A hook" });
    const m = evaluate(out);
    expect(m.diagnostics).toEqual([]);
    expect(m.brief?.purpose).toBe("A hook");
    expect(m.notes).toHaveLength(1);
  });

  it("describes changes in plain words", () => {
    const a = briefData(evaluate(BRACKET).brief)!;
    const b = structuredClone(a);
    b.temp = [-5, 80];
    b.uses = b.uses.filter((u) => u.id !== "mount");
    b.givens[0].text = "22mm";
    b.assumed = ["outdoor"];
    const ch = briefChanges(a, b);
    expect(ch).toContain("temperature range -5 to 60 °C → -5 to 80 °C");
    expect(ch).toContain("removed use “Screws to the wall with two M4 screws”");
    expect(ch).toContain("tube_d 25mm → 22mm");
    expect(ch).toContain("confirmed material");
  });

  it("protects what the user stated but not what Claude assumed", () => {
    const a = briefData(evaluate(BRACKET).brief)!;
    const b = structuredClone(a);
    b.material = "ASA"; // assumed: free to change
    b.givens[1].text = "45mm"; // assumed
    b.uses = b.uses.filter((u) => u.id !== "drop_in"); // assumed
    expect(protectedBriefChanges(a, b)).toEqual([]);
    b.givens[0].text = "30mm";
    b.temp = undefined;
    b.uses = b.uses.filter((u) => u.id !== "mount");
    expect(protectedBriefChanges(a, b)).toEqual(["the temperature range (-5 to 60 °C)", "use mount (“Screws to the wall with two M4 screws”)", "tube_d = 25mm"]);
  });

  it("lists and confirms open assumptions", () => {
    const a = briefData(evaluate(BRACKET).brief)!;
    const open = openAssumptions(a);
    expect(open.map((o) => o.kind + ":" + o.key)).toEqual(["field:outdoor", "field:material", "use:drop_in", "given:offset", "note:Wood screws, not machine screws"]);
    let d = a;
    for (const o of open) d = confirmAssumption(d, o.kind, o.key);
    expect(openAssumptions(d)).toEqual([]);
  });

  it("makes short names from text", () => {
    expect(slugId("Holds the tube without slipping", [])).toBe("holds_tube_without");
    expect(slugId("Holds the tube without slipping", ["holds_tube_without"])).toBe("holds_tube_without2");
    expect(slugId("2 kg load", [])).toBe("use_2_kg_load");
    expect(processKind("3D printed in PETG")).toBe("fdm");
    expect(processKind("machined from bar")).toBe("cnc");
    expect(processKind("Resin print")).toBe("resin");
  });
});

describe("checks from the brief", () => {
  const geom = (h: string, m: ReturnType<typeof evaluate>) => {
    const p = m.parts.find((x) => x.hash === h)!;
    void p;
    // a 33 × 30 × 56.5 mm block like the clamp
    return { volume: 33 * 30 * 56.5, bbox: [[-16.5, -15, 0], [16.5, 15, 56.5]] as [[number, number, number], [number, number, number]] };
  };

  it("covers each use with its requirements", () => {
    const m = evaluate(BRACKET);
    const report = assembleReport(m, { geom: (h) => geom(h, m) });
    const byId = (id: string) => report.items.find((i) => i.id === id)!;
    expect(byId("use:hold_tube").status).toBe("pass");
    expect(byId("use:hold_tube").detail).toMatch(/All 2 of its checks pass/);
    expect(byId("use:mount").status).toBe("pass");
    expect(byId("use:drop_in").status).toBe("warn");
    expect(byId("use:drop_in").detail).toMatch(/No check covers this use yet/);
    expect(byId("use-load:hold_tube").basis).toBe("needs analysis");
    expect(byId("use-load:hold_tube").title).toBe("Strength under 19.6 N down on holder");
  });

  it("checks materials against the environment", () => {
    const m = evaluate(BRACKET);
    const items = briefChecks(m, [], (h) => geom(h, m));
    const temp = items.find((i) => i.id === "brief-temp:PLA")!;
    expect(temp.status).toBe("fail");
    expect(temp.detail).toMatch(/softens around 52 °C, below the 60 °C/);
    expect(items.find((i) => i.id === "brief-impact:PLA")?.status).toBe("warn");
    // indoors: no sunlight check
    expect(items.some((i) => i.id.startsWith("brief-sun"))).toBe(false);
    const asa = evaluate(BRACKET.replace('material: "PLA"', 'material: "ASA"').replace("outdoor: false", "outdoor: true"));
    const items2 = briefChecks(asa, [], (h) => geom(h, asa));
    expect(items2.find((i) => i.id === "brief-temp:ASA")?.status).toBe("pass");
    expect(items2.find((i) => i.id === "brief-sun:ASA")?.status).toBe("pass");
  });

  it("checks size and mass", () => {
    const m = evaluate(BRACKET);
    const items = briefChecks(m, [], (h) => geom(h, m));
    expect(items.find((i) => i.id === "brief-size")).toMatchObject({ status: "pass", detail: "Now 33 × 30 × 56.5 mm" });
    expect(items.find((i) => i.id === "brief-mass")?.status).toBe("pass");
    const small = evaluate(BRACKET.replace("max_size: (80, 60, 70)", "max_size: (80, 60, 50)").replace("max_mass: 0.2kg", "max_mass: 50g"));
    const items2 = briefChecks(small, [], (h) => geom(h, small));
    expect(items2.find((i) => i.id === "brief-size")).toMatchObject({ status: "fail" });
    expect(items2.find((i) => i.id === "brief-size")?.detail).toMatch(/Z is 6.5 mm over/);
    expect(items2.find((i) => i.id === "brief-mass")?.status).toBe("fail");
    const stats = assemblyStats(m, (h) => geom(h, m));
    expect(stats.mass).toBeCloseTo((33 * 30 * 56.5 * 1.24) / 1000, 3);
  });

  it("warns when a given is not used", () => {
    const m = evaluate(`design "x"\nbrief {\n  given gap = 3mm\n}\n`);
    expect(briefChecks(m, [], () => undefined).find((i) => i.id === "given:gap")?.status).toBe("warn");
  });

  it("documents a brief that reads without errors", () => {
    const ref = languageReference();
    const block = ref.slice(ref.indexOf("brief {\n  purpose"), ref.indexOf("\n}\n", ref.indexOf("brief {\n  purpose")) + 2);
    const m = evaluate(`design "doc"\n${block}\npart mount { body box(light_w, bar_d, 10) }\nrequire "Grips" for hold_light, swap: bar_d > 0\n`);
    expect(m.diagnostics).toEqual([]);
    expect(m.brief!.uses.map((u) => u.id)).toEqual(["hold_light", "swap"]);
    expect(m.brief!.maxMass).toBe(60);
  });

  it("hands the process to the parts it makes", () => {
    const src = BRACKET.replace("part holder {", 'part pin {\n  material: "Steel"\n  body cylinder(d: 4, h: 400)\n}\npart holder {');
    const m = evaluate(src);
    // the printer bed and material fit are manufacturing checks on each part now
    expect(m.parts.find((p) => p.name === "holder")?.process?.id).toBe("fdm");
    // a 400 mm steel pin is bought or cut, not printed
    expect(m.parts.find((p) => p.name === "pin")?.process).toBeUndefined();
    const items = briefChecks(m, [], (h) => geom(h, m));
    expect(items.some((i) => i.id.startsWith("brief-process") || i.id.startsWith("brief-bed"))).toBe(false);
  });
});
