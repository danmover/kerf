// The worked examples Claude can read while it designs.

import { describe, expect, it } from "vitest";
import { EXAMPLE_MAX_CHARS, EXAMPLE_TOOL, exampleText } from "../src/ai/examples";
import { TEMPLATES } from "../src/demos/templates";

describe("worked examples", () => {
  it("offers every template but the blank one and the tutorials, by id, with what each shows", () => {
    const ids = (EXAMPLE_TOOL.input_schema.properties.id as { enum: string[] }).enum;
    expect(ids).toEqual(TEMPLATES.filter((t) => t.id !== "blank" && t.category !== "learn").map((t) => t.id));
    expect(EXAMPLE_TOOL.description).toContain("reducer (Two-Stage Spur Reducer: gears, bearings, strength)");
  });

  it("gives a whole example, cut short with a note when it is long", () => {
    const r = exampleText("bracket");
    if ("error" in r) throw new Error(r.error);
    expect(r.text).toContain(TEMPLATES.find((t) => t.id === "bracket")!.source.trim());
    const big = TEMPLATES.reduce((a, t) => (t.source.length > a.source.length ? t : a));
    const long = exampleText(big.id);
    if ("error" in long) throw new Error(long.error);
    expect(long.text.length).toBeLessThan(EXAMPLE_MAX_CHARS + 1000);
    expect(long.text).toMatch(/ask for one part of it with part:/);
  });

  it("gives one part with the params and lets it reads, and names the parts when one is not there", () => {
    const r = exampleText("enclosure", "lid");
    if ("error" in r) throw new Error(r.error);
    expect(r.text).toMatch(/^part lid \{/m);
    expect(r.text).toMatch(/^param lid_t/m);
    expect(r.text).not.toMatch(/^part base \{/m);
    const miss = exampleText("enclosure", "hinge");
    expect("error" in miss && miss.error).toMatch(/has: .*base.*lid/);
    expect("error" in exampleText("nothing")).toBe(true);
  });
});
