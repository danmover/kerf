import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { decisionStatus, withValues } from "../src/core/decisions";

const demo = (name: string) => readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8");

describe("decisions in the example designs", () => {
  for (const name of ["enclosure", "reducer"]) {
    it(`${name}: every decision is in effect and every option evaluates`, () => {
      const src = demo(name);
      const m = evaluate(src);
      expect(m.diagnostics).toEqual([]);
      expect(m.decisions.length).toBeGreaterThanOrEqual(3);
      for (const d of m.decisions) {
        const st = decisionStatus(d, m);
        expect(st.chosen, d.name).toBeDefined();
        expect(st.drift, d.name).toEqual([]);
        for (const o of d.options) {
          if (!o.sets.length) continue;
          const alt = evaluate(withValues(src, m, Object.fromEntries(o.sets.map((s) => [s.param, s.value]))));
          expect(alt.diagnostics.filter((x) => x.severity === "error"), `${d.name}: ${o.label}`).toEqual([]);
        }
      }
    });
  }
});
