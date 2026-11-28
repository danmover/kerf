// A good part of a report reads the design alone (gears, fasteners, linkages, sheet parts, chains, the electrics). It
// can be worked out while the kernel is still at the geometry, and the report then takes it instead of working it
// out. The report must be the same one either way.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { assembleReport, reportAhead, type CheckItem } from "../src/core/checks";

const designs = [...readdirSync("src/demos").filter((f) => f.endsWith(".kerf")).map((f) => `src/demos/${f}`), "bench/designs/robot-dog.kerf"];
const read = (file: string) => evaluate(readFileSync(file, "utf8"));
/** a report's items, without how long it took */
const said = (items: CheckItem[]) => JSON.stringify(items);

describe("the part of a report worked out ahead", () => {
  it("leaves every design's report as it is", () => {
    let families = 0;
    for (const file of designs) {
      const plain = said(assembleReport(read(file)).items);
      const model = read(file);
      for (const _ of reportAhead(model)) families++;
      expect(said(assembleReport(model).items), file).toBe(plain);
    }
    expect(families).toBeGreaterThan(designs.length);
  }, 120_000);

  it("is handed to one report only: the next works it out again, and shares nothing with the first", () => {
    const model = read("bench/designs/robot-dog.kerf");
    for (const _ of reportAhead(model));
    const first = assembleReport(model).items;
    const second = assembleReport(model).items;
    expect(said(second)).toBe(said(first));
    const firstItems = new Set(first);
    expect(second.some((i) => firstItems.has(i))).toBe(false);
  }, 60_000);

  it("is taken as far as it has got, and stops once the report is put together", () => {
    const plain = said(assembleReport(read("bench/designs/robot-dog.kerf")).items);
    const model = read("bench/designs/robot-dog.kerf");
    const work = reportAhead(model);
    // two families in, the report is asked for
    work.next();
    work.next();
    expect(said(assembleReport(model).items)).toBe(plain);
    expect(work.next().done).toBe(true);
  }, 60_000);

  it("of one design is not taken by the report of another", () => {
    const a = read("src/demos/enclosure.kerf");
    const b = read("src/demos/reducer.kerf");
    const plain = said(assembleReport(read("src/demos/reducer.kerf")).items);
    for (const _ of reportAhead(a));
    expect(said(assembleReport(b).items)).toBe(plain);
  });
});
