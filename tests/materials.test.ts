import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setBlockProps } from "../src/core/sourceEdit";
import { evaluate } from "../src/lang/evaluator";
import { FINISHES, MATERIAL_LIST, materialDef, resolveFinish } from "../src/library/materials";
import { appearanceFor, Detail } from "../src/ui/viewport/render/appearance";

const ENCLOSURE = readFileSync(new URL("../src/demos/enclosure.kerf", import.meta.url), "utf8");

describe("materials", () => {
  it("lists only finishes that exist, with the default first", () => {
    for (const m of MATERIAL_LIST) {
      expect(m.finishes.length).toBeGreaterThan(0);
      for (const f of m.finishes) expect(FINISHES[f], `${m.name}: ${f}`).toBeDefined();
      expect(m.density).toBeGreaterThan(0);
    }
  });

  it("falls back to the material's default finish when the one asked for doesn't apply", () => {
    expect(resolveFinish("Aluminum 6061", "anodized")).toBe("anodized");
    expect(resolveFinish("Aluminum 6061", "printed")).toBe(materialDef("Aluminum 6061")!.finishes[0]);
    expect(resolveFinish("PLA", undefined)).toBe("printed");
    expect(resolveFinish("Unobtainium", "polished")).toBe("polished");
    expect(resolveFinish("Unobtainium", "sparkly")).toBe("matte");
  });

  it("gives every material and finish a physically plausible look", () => {
    for (const m of MATERIAL_LIST)
      for (const f of m.finishes) {
        const a = appearanceFor(m.name, f, m.color);
        expect(a.roughness, a.key).toBeGreaterThanOrEqual(0);
        expect(a.roughness, a.key).toBeLessThanOrEqual(1);
        expect(a.metalness, a.key).toBeGreaterThanOrEqual(0);
        expect(a.metalness, a.key).toBeLessThanOrEqual(1);
        expect(a.envBoost, a.key).toBeGreaterThanOrEqual(1);
      }
    expect(appearanceFor("PLA", "printed", "#ffffff").detail).toBe(Detail.Layers);
    expect(appearanceFor("Aluminum 6061", "brushed", "#c4c8ce").metalness).toBe(1);
    expect(appearanceFor("Acrylic", "clear", "#ffffff").transmission).toBe(1);
    expect(appearanceFor("Carbon fiber", undefined, "#222222").detail).toBe(Detail.Weave);
  });
});

describe("finish in the language", () => {
  it("passes finish through to parts", () => {
    const m = evaluate(`design "t"\npart p {\n  material: "Aluminum 6061"\n  finish: "anodized"\n  body box(10, 10, 10)\n}`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts[0].finish).toBe("anodized");
  });

  it("warns about unknown materials and finishes that don't fit, with a suggestion", () => {
    const m = evaluate(`design "t"\npart p {\n  material: "Aluminium 6061"\n  finish: "printed"\n  body box(10, 10, 10)\n}`);
    const msgs = m.diagnostics.map((d) => d.message).join("\n");
    expect(msgs).toMatch(/Aluminum 6061/);
    const n = evaluate(`design "t"\npart p {\n  material: "Steel"\n  finish: "printed"\n  body box(10, 10, 10)\n}`);
    expect(n.diagnostics.some((d) => d.severity === "warning" && /printed/.test(d.message))).toBe(true);
  });
});

describe("setBlockProps", () => {
  it("replaces existing properties in place and adds new ones with matching indentation", () => {
    const out = setBlockProps(ENCLOSURE, "base", { material: '"Aluminum 6061"', finish: '"machined"', color: "#c4c8ce" });
    expect(out).toMatch(/part base \{\n  finish: "machined"\n  color: #c4c8ce\n  material: "Aluminum 6061"/);
    const m = evaluate(out);
    const base = m.parts.find((p) => p.name === "base")!;
    expect(base.material).toBe("Aluminum 6061");
    expect(base.finish).toBe("machined");
    expect(base.color.toLowerCase()).toBe("#c4c8ce");
    // the rest of the design is untouched
    expect(out.replace(/\n  finish: "machined"/, "").replace("#c4c8ce", "#4f7cff").replace('"Aluminum 6061"', '"PETG"')).toBe(ENCLOSURE);
  });

  it("removes a property when given null", () => {
    const withFinish = setBlockProps(ENCLOSURE, "lid", { finish: '"gloss"' });
    const back = setBlockProps(withFinish, "lid", { finish: null });
    expect(back).toBe(ENCLOSURE);
  });

  it("handles single-line blocks and blockless components", () => {
    const src = `design "t"\npart a { body box(1, 1, 1) }\ncomponent b = lib.screw(M3, 8)\n`;
    const a = setBlockProps(src, "a", { color: "#ff0000" });
    expect(a).toContain(`part a { color: #ff0000, body box(1, 1, 1) }`);
    const b = setBlockProps(src, "b", { finish: '"polished"' });
    expect(b).toContain(`component b = lib.screw(M3, 8) { finish: "polished" }`);
    expect(evaluate(b).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("leaves the source alone when the block doesn't exist", () => {
    expect(setBlockProps(ENCLOSURE, "nope", { color: "#000000" })).toBe(ENCLOSURE);
  });
});
