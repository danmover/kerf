import { describe, expect, it, vi } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { configColumns, configItems, configVerdict, deleteConfig, familyTableCsv, readConfig, rowValue, saveConfig, showConfig } from "../src/core/configs";
import { setParamValue } from "../src/core/sourceEdit";
import { withValues } from "../src/core/decisions";
import type { Model } from "../src/core/model";

const SRC = `design "tray"
param width = 60mm "Outer width"
param depth = 45mm
param wall = 2mm range 1.2 .. 4
param label = "M"
part tray { body box(width, depth, 20)
  shell(wall, open: facing(Z)) }
require "Fits the drawer": width <= 70
require "Wall is printable" soft: wall >= 1.6

configs "Sizes" {
  show: "Medium"
  config "Small" { width: 40, depth: 30, label: "S" }
  config "Medium" { width: 60mm, depth: 45 } "The one most people buy"
  config "Large" { width: 80, depth: 60, wall: 3 } "For the big drill set"
}
`;

const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const warnings = (m: Model) => m.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
const param = (m: Model, name: string) => m.params.find((p) => p.name === name)!;
const value = (m: Model, name: string) => param(m, name).value;
const showing = (label: string) => SRC.replace('show: "Medium"', `show: "${label}"`);
/** the design with the configs block's rows replaced */
const withRows = (rows: string) => SRC.replace(/ {2}config "Small"[\s\S]*?\n}\n$/, `${rows}\n}\n`);

describe("configurations in the design language", () => {
  it("reads the design as the configuration show: names", () => {
    const m = evaluate(SRC);
    expect(errors(m)).toEqual([]);
    expect(warnings(m)).toEqual([]);
    expect(m.configs).toMatchObject({ title: "Sizes", shown: "Medium", active: "Medium" });
    expect(m.configs!.rows.map((r) => [r.label, r.note])).toEqual([
      ["Small", undefined],
      ["Medium", "The one most people buy"],
      ["Large", "For the big drill set"],
    ]);
    expect(m.configs!.rows[0].sets.map((s) => [s.param, s.value])).toEqual([
      ["width", 40],
      ["depth", 30],
      ["label", "S"],
    ]);
    expect(param(m, "width")).toMatchObject({ value: 60, config: "Medium", asWritten: 60 });
    // what the row leaves, the parameter gives
    expect(param(m, "wall")).toMatchObject({ value: 2 });
    expect(param(m, "wall").config).toBeUndefined();
    const large = evaluate(showing("Large"));
    expect([value(large, "width"), value(large, "depth"), value(large, "wall"), value(large, "label")]).toEqual([80, 60, 3, "M"]);
    expect(large.requirements.find((r) => r.label === "Fits the drawer")?.status).toBe("fail");
  });

  it("reads any configuration on request, and the parameters as written without one", () => {
    const small = evaluate(SRC, { config: "Small" });
    expect(errors(small)).toEqual([]);
    expect([value(small, "width"), value(small, "label")]).toEqual([40, "S"]);
    expect(small.configs).toMatchObject({ shown: "Medium", active: "Small" });
    expect(errors(evaluate(SRC, { config: "Huge" })).join("\n")).toMatch(/There is no configuration "Huge" \(the configurations are "Small", "Medium", "Large"\)/);
    expect(errors(evaluate(`param a = 1\n`, { config: "Huge" })).join("\n")).toMatch(/There is no configuration "Huge": the design has no configs block/);
    const unknown = evaluate(showing("Huge"));
    expect(warnings(unknown).join("\n")).toMatch(/show: "Huge" is not one of the configurations \("Small", "Medium", "Large"\), so the parameters are read as written/);
    expect(param(unknown, "width")).toMatchObject({ value: 60 });
    expect(unknown.configs!.active).toBeUndefined();
    const written = evaluate(SRC.replace('  show: "Medium"\n', ""));
    expect(written.configs!.active).toBeUndefined();
    expect(written.params.every((p) => !p.config)).toBe(true);
    // a study's or solver's values win over the row
    expect(param(evaluate(showing("Large"), { overrides: { width: 55 } }), "width")).toMatchObject({ value: 55 });
  });

  it("points the shown configuration's values at its row, so edits change the row", () => {
    const src = showing("Large");
    const m = evaluate(src);
    const wider = setParamValue(src, param(m, "width"), 85);
    expect(wider).toContain('config "Large" { width: 85, depth: 60, wall: 3 }');
    expect(wider).toContain("param width = 60mm");
    expect(value(evaluate(wider), "width")).toBe(85);
    expect(value(evaluate(wider, { config: "Small" }), "width")).toBe(40);
    // a value the row leaves is the parameter's own, shared by every configuration that leaves it
    const relabelled = setParamValue(src, param(m, "label"), "XL");
    expect(relabelled).toContain('param label = "XL"');
    expect(value(evaluate(relabelled, { config: "Medium" }), "label")).toBe("XL");
    // the same for edits that set several values at once (a decision's option, the assistant)
    const both = withValues(src, m, { depth: 70, wall: 3.5 });
    expect(both).toContain('config "Large" { width: 80, depth: 70, wall: 3.5 }');
    expect(both).toContain("param wall = 2mm range 1.2 .. 4");
  });

  it("says what is wrong in a configuration", () => {
    const one = (rows: string, show = "A") => evaluate(withRows(rows).replace('show: "Medium"', `show: "${show}"`));
    const odd = one(`  config "A" { width: "wide" }`);
    expect(errors(odd).join("\n")).toMatch(/Configuration "A" sets width to .+, but width is .+; the parameter's own value is used/);
    expect(value(odd, "width")).toBe(60);
    expect(warnings(one(`  config "A" { Width: 50 }`)).join("\n")).toMatch(/Configuration "A" sets Width, which is not a parameter of the design \(did you mean width\?\)/);
    expect(errors(one(`  config "A" { width: depth * 2 }`)).join("\n")).toMatch(/In configuration "A": the value for width must be written out, like width: 80 \(a configuration's values cannot be worked out from depth or other names\)/);
    expect(errors(one(`  config "A" { width: 50, width: 55 }`)).join("\n")).toMatch(/width is set twice/);
    expect(warnings(one(`  config "A" { width: 50 }\n  config "A" { width: 55 }`)).join("\n")).toMatch(/Configuration "A" appears twice/);
    expect(warnings(one(`  config "A" { wall: 0.5 }`)).join("\n")).toMatch(/Parameter "wall" = 0.5 \(configuration "A"\) is outside its range 1.2..4/);
    expect(warnings(evaluate(SRC.replace('show: "Medium"', 'show: "Medium"\n  colour: "red"'))).join("\n")).toMatch(/Unknown configs field "colour"/);
    expect(errors(evaluate(`${SRC}\nconfigs { config "B" { width: 1 } }\n`)).join("\n")).toMatch(/A design has one configs block/);
    // a mistake in one row leaves the rest of the design readable
    const broken = evaluate(withRows(`  config "A" { width 50 }`));
    expect(errors(broken).length).toBeGreaterThan(0);
    expect(broken.parts.map((p) => p.name)).toEqual(["tray"]);
    // "configs" is still an ordinary name elsewhere
    expect(errors(evaluate(`let configs = 3\nparam n = configs + 1\n`))).toEqual([]);
  });
});

describe("switching, saving and taking out configurations", () => {
  it("switches by writing show:, and back to the parameters as written by taking it out", () => {
    const m = evaluate(SRC);
    const large = showConfig(SRC, m, "Large");
    expect(large).toContain('  show: "Large"\n');
    expect(evaluate(large).configs!.active).toBe("Large");
    const written = showConfig(SRC, m, null);
    expect(written).toContain('configs "Sizes" {\n  config "Small"');
    expect(evaluate(written).configs!.active).toBeUndefined();
    const again = showConfig(written, evaluate(written), "Small");
    expect(again).toContain('configs "Sizes" {\n  show: "Small"\n  config "Small"');
    expect(value(evaluate(again), "width")).toBe(40);
  });

  it("saves the values as they are as a new configuration, or brings one up to date", () => {
    const m = evaluate(SRC);
    expect(configColumns(m)).toEqual(["width", "depth", "wall", "label"]);
    const added = saveConfig(SRC, m, "Workshop", { note: "For the bench, wide" });
    expect(added).toContain('"For the big drill set"\n  config "Workshop" { width: 60mm, depth: 45, wall: 2mm, label: "M" } "For the bench, wide"\n}');
    expect(evaluate(added).configs!.rows.map((r) => r.label)).toEqual(["Small", "Medium", "Large", "Workshop"]);
    // the row of that name is replaced, keeping what it is for, and shown if asked
    const wider = withValues(SRC, m, { width: 66 });
    const updated = saveConfig(wider, evaluate(wider), "Large", { show: true });
    expect(updated).toContain('config "Large" { width: 66mm, depth: 45, wall: 2mm, label: "M" } "For the big drill set"');
    const u = evaluate(updated);
    expect(errors(u)).toEqual([]);
    expect(u.configs).toMatchObject({ shown: "Large", active: "Large" });
    expect(value(u, "width")).toBe(66);
    // the first one makes the block, with every parameter that is not locked
    const plain = `param width = 60mm\nparam depth = 45mm\nparam hole = 5mm locked\npart p { body box(width, depth, 10) }\n`;
    const first = saveConfig(plain, evaluate(plain), "Base", { show: true });
    expect(first).toBe(`${plain}\nconfigs "Configurations" {\n  show: "Base"\n  config "Base" { width: 60mm, depth: 45mm }\n}\n`);
    expect(evaluate(first).configs).toMatchObject({ active: "Base" });
  });

  it("takes a configuration out, and show: with it when it was the one shown", () => {
    const m = evaluate(SRC);
    const noMedium = deleteConfig(SRC, m, "Medium");
    expect(noMedium).not.toContain("Medium");
    expect(noMedium).toContain('configs "Sizes" {\n  config "Small" { width: 40, depth: 30, label: "S" }\n  config "Large"');
    const n = evaluate(noMedium);
    expect(errors(n)).toEqual([]);
    expect(n.configs!.active).toBeUndefined();
    const noSmall = evaluate(deleteConfig(SRC, m, "Small"));
    expect(noSmall.configs!.rows.map((r) => r.label)).toEqual(["Medium", "Large"]);
    expect(noSmall.configs!.active).toBe("Medium");
  });
});

describe("checking every configuration", () => {
  it("reads each configuration other than the one shown, for what breaks or fails in it", () => {
    const src = withRows(`  config "Small" { width: 40, depth: 30, label: "S" }
  config "Medium" { width: 60mm, depth: 45 }
  config "Large" { width: 80, depth: 60, wall: 3 }
  config "Flat" { width: 0 }
  config "Heavy" { wall: 4.5 }`);
    const m = evaluate(src);
    const items = configItems(m, src);
    expect(items.map((i) => i.id)).toEqual(["config:Small", "config:Large", "config:Flat", "config:Heavy"]);
    const by = (label: string) => items.find((i) => i.id === `config:${label}`)!;
    expect(by("Small")).toMatchObject({ status: "pass", title: "Configuration “Small” reads cleanly", detail: "2 of 2 requirements met." });
    expect(by("Large")).toMatchObject({ status: "fail", title: "Configuration “Large” fails “Fits the drawer” (short by 10)" });
    expect(by("Large").detail).toMatch(/^1 of 2 requirements met; failing: “Fits the drawer”/);
    expect(by("Flat")).toMatchObject({ status: "fail", title: "Configuration “Flat” does not build" });
    expect(by("Flat").detail).toMatch(/box\(\): "w" must be greater than 0/);
    expect(by("Heavy")).toMatchObject({ status: "warn", title: "Configuration “Heavy” goes outside a parameter's range" });
    // each points at its row, so a click shows it in the code
    expect(src.slice(by("Flat").span!.start, by("Flat").span!.end)).toBe('config "Flat" { width: 0 }');
    // read once for the same source
    expect(configItems(m, src)).toEqual(items);
    expect(configItems(evaluate(`param a = 1\n`), `param a = 1\n`)).toEqual([]);
  });

  it("reads a slow design's configurations a few at a time, asking for the rest to follow", () => {
    const src = `${SRC}// a slow one\n`;
    const m = evaluate(src);
    let step = 200;
    let clock = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (clock += step));
    try {
      let asked = 0;
      const first = configItems(m, src, () => asked++);
      expect(first.map((i) => i.id)).toEqual(["config:Small", "config:more"]);
      expect(first[1]).toMatchObject({ status: "info", title: "1 configuration not read yet" });
      expect(asked).toBe(1);
      step = 0;
      expect(configItems(m, src, () => asked++).map((i) => i.id)).toEqual(["config:Small", "config:Large"]);
      expect(asked).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("writes the family table: a row per configuration, a column per value they set", () => {
    const m = evaluate(showing("Large"));
    const verdicts = new Map(m.configs!.rows.map((r) => [r.label, configVerdict(readConfig(showing("Large"), r.label), r.label)]));
    expect(rowValue(m, m.configs!.rows[0], "wall")).toBe(2);
    expect(familyTableCsv(m, verdicts).split("\n")).toEqual([
      "Configuration,width,depth,wall,label,Requirements,Notes",
      "Small,40,30,2,S,2 of 2 met,",
      "Medium,60,45,2,M,2 of 2 met,The one most people buy",
      "Large,80,60,3,M,1 of 2 met,For the big drill set",
      "",
    ]);
    const noted = evaluate(SRC.replace("For the big drill set", 'For \\"big\\" sets, and more'));
    expect(errors(noted)).toEqual([]);
    expect(familyTableCsv(noted)).toContain('Large,80,60,3,M,,"For ""big"" sets, and more"');
  });
});
