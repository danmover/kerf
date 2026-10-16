import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "../src/lang/parser";
import { evaluate } from "../src/lang/evaluator";
import { solveConflict } from "../src/core/feasibility";

const enclosure = readFileSync(new URL("../src/demos/enclosure.kerf", import.meta.url), "utf8");

describe("conflict solver", () => {
  it("explains a 20% narrower enclosure and proposes fixes", async () => {
    const src = enclosure.replace("param width     = 90mm", "param width     = 72mm");
    expect(src).not.toBe(enclosure);
    const parsed = parse(src);
    const c = await solveConflict(src, parsed, evaluate(src, { parsed }));
    expect(c?.failing.map((f) => f.label)).toContain("Board fits across the width");
    expect(c?.options.length).toBeGreaterThan(0);
    // every option must actually satisfy the hard requirements
    for (const o of c!.options) {
      let fixed = src;
      for (const ch of o.changes) fixed = fixed.replace(new RegExp(`(param ${ch.param}\\s*=\\s*)[0-9.]+`), `$1${ch.to}`);
      const m = evaluate(fixed);
      expect(m.requirements.filter((r) => r.level === "hard" && r.status === "fail")).toEqual([]);
    }
  });

  it("says when holding a parameter makes the request impossible", async () => {
    const src = enclosure.replace("param width     = 90mm", "param width     = 72mm");
    const parsed = parse(src);
    const c = await solveConflict(src, parsed, evaluate(src, { parsed }), { hold: ["width"] });
    expect(c?.infeasible).toBe(true);
  });

  it("returns nothing when every requirement passes", async () => {
    const parsed = parse(enclosure);
    expect(await solveConflict(enclosure, parsed, evaluate(enclosure, { parsed }))).toBeNull();
  });
});
