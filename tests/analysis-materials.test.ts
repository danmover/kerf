import { describe, expect, it } from "vitest";
import { mechMaterial } from "../src/analysis/materials";

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
