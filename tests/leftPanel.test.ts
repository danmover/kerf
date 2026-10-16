import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { autoRange, clampParam, dayLabel, describePart, displayUnit, paramImpacts, paramSections, roundTo, shortHash, sourceSections, stepFor } from "../src/ui/left/insights";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");
const param = (src: string, name: string) => evaluate(src).params.find((p) => p.name === name)!;

describe("left panel: parameter sections", () => {
  it("reads section titles from comment rules", () => {
    const src = `// ── Layout ─────\nparam a = 1\n// -- Fit and finish --\n// plain comment\n// == Gears ==\n`;
    expect(sourceSections(src).map((s) => s.title)).toEqual(["Layout", "Fit and finish", "Gears"]);
  });

  it("groups the reducer's parameters under its two section comments", () => {
    const src = demo("reducer");
    const s = paramSections(src, evaluate(src).params);
    expect(s.map((x) => [x.title, x.params.length])).toEqual([
      ["Requirements in numbers", 8],
      ["Housing, shafts and mounting", 7],
    ]);
  });

  it("puts parameters above any heading in an untitled section and marks blank-line breaks", () => {
    const src = `design "t"\nparam a = 1\n\nparam b = 2\n// ── Size ──\nparam c = 3mm\nparam d = 4mm\n`;
    const s = paramSections(src, evaluate(src).params);
    expect(s.map((x) => x.title)).toEqual([null, "Size"]);
    expect([...s[0].breaks]).toEqual(["b"]);
    expect(s[1].breaks.size).toBe(0);
  });
});

describe("left panel: what a parameter drives", () => {
  const m = evaluate(demo("reducer"));
  const impacts = paramImpacts(m);

  it("finds the parts a parameter shapes directly and the checks it feeds", () => {
    const z1 = impacts.get("z1")!;
    expect(z1.direct).toEqual(["g1"]);
    expect(z1.checks).toContain("Pinions have at least 10 teeth");
    expect(z1.parts).toContain("g2"); // moved through the centre distance
  });

  it("does not spread through meshing gears", () => {
    // the mounting spacing only touches the housing
    expect(impacts.get("foot_px")!.parts).toEqual(["housing"]);
  });

  it("maps part names to every placed instance", () => {
    const wall = impacts.get("wall")!;
    expect(wall.direct).toContain("motor_screws");
    expect(wall.partIds.filter((id) => id.startsWith("motor_screws#")).length).toBe(4);
  });
});

describe("left panel: units and stepping", () => {
  it("shows values in the unit they were written in", () => {
    expect(displayUnit(param(`param w = 2cm`, "w")).suffix).toBe("mm");
    expect(displayUnit(param(`param a = 30deg`, "a")).suffix).toBe("°");
    expect(displayUnit(param(`param f = 90 "Fold angle (degrees)"`, "f")).suffix).toBe("°");
    const z = displayUnit(param(`param z = 12 "Teeth"`, "z"));
    expect(z.integer).toBe(true);
    expect(z.suffix).toBe("");
    expect(displayUnit(param(`param r = 1.5`, "r")).integer).toBe(false);
    expect(displayUnit(param(`param b = "625"`, "b")).suffix).toBe("");
  });

  it("steps whole numbers by one and keeps sizes positive", () => {
    const z = param(`param z = 12`, "z");
    expect(stepFor(z)).toBe(1);
    expect(clampParam(z, -4)).toBe(1);
    const w = param(`param w = 2mm range 1.2 .. 4`, "w");
    expect(autoRange(w)).toEqual([1.2, 4]);
    expect(clampParam(w, 9)).toBe(4);
    expect(roundTo(2.3456, 0.01)).toBe(2.35);
    expect(roundTo(0.1 + 0.2, 0.1)).toBe(0.3);
  });
});

describe("left panel: labels", () => {
  it("describes library parts by what they are and custom parts by material", () => {
    const m = evaluate(demo("reducer"));
    const byName = (n: string) => m.parts.find((p) => p.name === n)!;
    expect(describePart(m, byName("g1"))).toBe("Spur gear m1 z12");
    expect(describePart(m, byName("housing"))).toBe("PETG");
  });

  it("gives versions a short stable hash", () => {
    expect(shortHash("abc")).toMatch(/^[0-9a-f]{7}$/);
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
  });

  it("names days relative to today", () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    expect(dayLabel(new Date(2026, 9, 16, 1, 0).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 15, 23, 0).getTime(), now)).toBe("Yesterday");
  });
});
