import { describe, expect, it } from "vitest";
import { mechMaterial } from "../src/analysis/materials";
import { materialInfo } from "../src/mfg/materials";
import { MATERIALS } from "../src/library/standards";

describe("material strength data by name", () => {
  it("knows exact names and aliases", () => {
    expect(mechMaterial("PETG").name).toBe("PETG");
    expect(mechMaterial("aluminium").name).toBe("Aluminum 6061-T6");
    expect(mechMaterial("Stainless steel 316").name).toBe("Stainless 316");
  });

  it("takes the most specific match, and the weaker one when names overlap", () => {
    expect(mechMaterial("Brushed stainless steel 316").name).toBe("Stainless 316");
    expect(mechMaterial("316 stainless").name).toBe("Stainless 316");
    expect(mechMaterial("Brushed stainless").name).toBe("Stainless 304");
    expect(mechMaterial("Anodised aluminium").name).toBe("Aluminum 6061-T6");
  });

  it("matches short names as whole words only", () => {
    expect(mechMaterial("Black ABS").name).toBe("ABS");
    expect(mechMaterial("ABS, black").name).toBe("ABS");
    expect(mechMaterial("Silk PLA").name).toBe("PLA");
    // "pa" is a name for nylon but must not match inside other words
    const paper = mechMaterial("paper");
    expect(paper.assumed).toBe(true);
    expect(paper.note).toMatch(/rough guide/);
  });

  it("reads wood and resin as a fill or grade when the name also names a polymer", () => {
    for (const n of ["Wood PLA", "PLA wood fill", "wood-filled PLA"]) {
      expect(mechMaterial(n).name, n).toBe(mechMaterial("PLA").name);
      expect(mechMaterial(n).printedByDefault, n).toBe(true);
    }
    expect(mechMaterial("Glass-filled nylon resin").name).toBe(mechMaterial("Nylon").name);
    // on their own they still name the material
    expect(mechMaterial("6 mm birch plywood").name).toBe(mechMaterial("Wood").name);
    expect(mechMaterial("Grey resin").name).toBe(mechMaterial("Resin").name);
    // and the process rules make them like the polymer
    expect(materialInfo("Wood PLA").processes).toContain("fdm");
    expect(materialInfo("Glass-filled nylon resin").family).toBe("thermoplastic");
    expect(materialInfo("6 mm birch plywood").family).toBe("wood");
  });

  it("prints the wood material as plywood, whatever the panel's species", () => {
    // a pine panel from the hardware shop was listed as birch on its drawing
    expect(MATERIALS["Wood"].label).toBe("Plywood");
    expect(mechMaterial("12 mm pine plywood").name).toBe(mechMaterial("Wood").name);
  });

  it("gives every aluminium grade in the material list its own data, and cast aluminium the weakest", () => {
    expect(mechMaterial("Aluminum 5052").yield).toBeLessThan(mechMaterial("Aluminum 6061").yield);
    expect(mechMaterial("Aluminum A380").name).toBe("Aluminum A380 (die cast)");
    expect(mechMaterial("Aluminum 7075").name).toBe("Aluminum 7075-T6");
    expect(mechMaterial("Die cast aluminium").name).toBe("Aluminum A380 (die cast)");
  });

  it("never treats object built-ins as materials", () => {
    expect(mechMaterial("constructor").assumed).toBe(true);
    expect(mechMaterial("toString").assumed).toBe(true);
  });
});
