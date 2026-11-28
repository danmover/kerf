// Work that is done once and not again: how a design holds together, read between frames for everyone who asks at
// the same time; its fits, found among thousands of holes without trying every hole against every shaft; a part's
// making checks, worked out in a kernel that did not build the design; and the sweep through the motion, which has
// nothing to get ready when nothing moves.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { findHolds, prepareHolds, type Holds } from "../src/core/holds";
import { findFits } from "../src/analysis/fits/detect";
import { sweepChecks } from "../src/core/sweepChecks";
import { processProbes } from "../src/mfg/report";
import { KernelCore } from "../src/kernel/core";
import type { ProcessResult } from "../src/mfg/types";
import { initKernel } from "./helpers/kernel";
import { fullCheck } from "./helpers/fullcheck";

const PLATES = `
part a { material: "Aluminum 6061"  body box(30, 30, 3)  cut hole(M3, through: true, at: (10, 0, 3)) }
part b { material: "Aluminum 6061"  body box(30, 30, 3, at: (0, 0, 3))  cut hole(M3, through: true, at: (10, 0, 6)) }
component s = lib.screw(M3, 12) { at: (10, 0, 6), axis: -Z }
component n = lib.nut(M3) { at: (10, 0, -2.4), axis: -Z }
`;

/** two plates held by a grid of screws and nuts: more than is read in one go between frames */
const SCREWS = 180;
const spots = Array.from({ length: SCREWS }, (_, i) => [(i % 20) * 12 - 114, Math.floor(i / 20) * 12 - 66]);
const MANY = `
part a { material: "Aluminum 6061"  body box(260, 160, 3)
${spots.map(([x, y]) => `  cut hole(M3, through: true, at: (${x}, ${y}, 3))`).join("\n")}
}
part b { material: "Aluminum 6061"  body box(260, 160, 3, at: (0, 0, 3))
${spots.map(([x, y]) => `  cut hole(M3, through: true, at: (${x}, ${y}, 6))`).join("\n")}
}
component s = lib.screw(M3, 12) { at: [${spots.map(([x, y]) => `(${x}, ${y}, 6)`).join(", ")}], axis: -Z }
component n = lib.nut(M3) { at: [${spots.map(([x, y]) => `(${x}, ${y}, -2.4)`).join(", ")}], axis: -Z }
`;

const noMesh = () => undefined;
const stacksOf = (h: Holds) => h.stacks.map((s) => [s.screw.id, s.tight, s.clamped.map((p) => p.id), s.layers.map((l) => [l.part.id, l.a, l.b])]);

describe("how a design holds together, read between frames", () => {
  it("gives what reading it in one go gives", async () => {
    const held = await prepareHolds(evaluate(PLATES), noMesh);
    const direct = findHolds(evaluate(PLATES), noMesh);
    expect(held).not.toBeNull();
    expect(direct.stacks).toHaveLength(1);
    expect(stacksOf(held!)).toEqual(stacksOf(direct));
    expect(held!.joins.map((j) => [j.a.id, j.b.id, j.kind])).toEqual(direct.joins.map((j) => [j.a.id, j.b.id, j.kind]));
  });

  it("is read once for everyone who asks at the same time, and kept for whoever asks next", async () => {
    const model = evaluate(MANY);
    const first = prepareHolds(model, noMesh);
    // too much for one go: the second asks while the first is still being read, and joins it
    const second = prepareHolds(model, noMesh);
    expect(second).toBe(first);
    const held = await first;
    expect(held?.stacks).toHaveLength(SCREWS);
    expect(await prepareHolds(model, noMesh)).toBe(held);
    expect(findHolds(model, noMesh)).toBe(held);
  });

  it("is dropped once nobody who asked still wants it, and read for the next to ask", async () => {
    const model = evaluate(MANY);
    expect(await prepareHolds(model, noMesh, () => false)).toBeNull();
    const held = await prepareHolds(model, noMesh);
    expect(held?.stacks).toHaveLength(SCREWS);
  });

  it("carries on for one who still wants it when another has stopped", async () => {
    const model = evaluate(MANY);
    const gone = prepareHolds(model, noMesh, () => false);
    const kept = prepareHolds(model, noMesh, () => true);
    expect((await kept)?.stacks).toHaveLength(SCREWS);
    expect(await gone).toBe(await kept);
  });
});

describe("finding the fits without trying every hole against every shaft", () => {
  /** a printed block with a hole at a place, and a bought dowel in it */
  const pinAt = (x: number, name: string) => `
part ${name} {
  material: "PETG"
  process: mfg.fdm()
  body box(20, 20, 10, at: (${x}, 0, 0))
  cut cylinder(d: 5.2, h: 12, at: (${x}, 0, -1), dir: Z)
}
component ${name}_pin = lib.dowel(d: 5, length: 16) { at: (${x}, 0, 0), axis: Z }
`;

  it("finds a pin in its hole wherever the pair is, however far from the rest", () => {
    // next door, across the room, and further out than the search keeps separate places for
    const xs = [0, 40, 4000, -250000, 900000];
    const found = findFits(evaluate(xs.map((x, i) => pinAt(x, `block${i}`)).join("\n")));
    expect(found.fits.map((f) => f.kind)).toEqual(xs.map(() => "pin"));
    expect(found.fits.map((f) => f.instances.length)).toEqual(xs.map(() => 1));
    expect(found.fits.map((f) => Math.round(f.instances[0].at[0]))).toEqual(xs);
  });

  it("finds a long rod in holes at both of its ends", () => {
    const found = findFits(
      evaluate(`
part rod {
  material: "Steel"
  process: mfg.cnc_lathe(axis: Z)
  body cylinder(d: 8, h: 300, at: (0, 0, -150), dir: Z)
}
part top {
  material: "Aluminum 6061"
  process: mfg.cnc_mill()
  body box(30, 30, 8, at: (0, 0, 130))
  cut cylinder(d: 8.02, h: 10, at: (0, 0, 129), dir: Z)
}
part bottom {
  material: "Aluminum 6061"
  process: mfg.cnc_mill()
  body box(30, 30, 8, at: (0, 0, -140))
  cut cylinder(d: 8.02, h: 10, at: (0, 0, -141), dir: Z)
}
`),
    );
    expect(found.fits.map((f) => f.instances[0].hole.part.name).sort()).toEqual(["bottom", "top"]);
    expect(found.fits.every((f) => f.instances[0].shaft.part.name === "rod")).toBe(true);
  });

  it("keeps a pin out of a hole it is beside but not in", () => {
    const found = findFits(evaluate(pinAt(0, "block").replace("at: (0, 0, 0), axis: Z", "at: (0.6, 0, 0), axis: Z")));
    expect(found.fits).toEqual([]);
  });
});

describe("a part's making checks in a kernel that did not build it", () => {
  const SRC = `
part bracket {
  material: "PETG"
  process: mfg.fdm()
  body box(40, 20, 4)
  add box(4, 20, 30, at: (-18, 0, 4))
  cut cylinder(d: 4.4, h: 6, at: (8, 0, -1), dir: Z)
}
`;
  /** a result without how long it took */
  const told = (r: ProcessResult[]) => r.map((x) => ({ ...x, ms: 0 }));

  it("builds the part it is handed first and says what the kernel that built the design says", async () => {
    await initKernel();
    const model = evaluate(SRC);
    const items = model.parts.map((p) => ({ hash: p.hash, recipe: p.recipe, label: p.label }));
    const probes = processProbes(model, new Set(model.parts.map((p) => p.hash)));
    expect(probes).toHaveLength(1);
    const builder = new KernelCore();
    for (const item of items) builder.build(item);
    const direct = builder.process(probes);
    expect(direct[0].error).toBeUndefined();
    const other = new KernelCore();
    expect(told(other.process(probes, items))).toEqual(told(direct));
    // and without the part, it says the part is not built rather than guessing
    expect(new KernelCore().process(probes)[0].error).toBeTruthy();
  });

  it("says a part that does not build is not built", async () => {
    await initKernel();
    const model = evaluate(SRC);
    const probes = processProbes(model, new Set(model.parts.map((p) => p.hash)));
    const broken = model.parts.map((p) => ({ hash: p.hash, recipe: { ...p.recipe, base: { t: "no such shape" } as unknown as typeof p.recipe.base }, label: p.label }));
    const r = new KernelCore().process(probes, broken);
    expect(r).toHaveLength(1);
    expect(r[0].error).toBeTruthy();
  });
});

describe("the sweep through the motion", () => {
  it("has nothing to do, and gets no surface ready, when nothing in the design moves", async () => {
    const r = await fullCheck(PLATES);
    const asked: string[] = [];
    const mesh = (h: string) => {
      asked.push(h);
      return r.core.mesh(h, "preview");
    };
    const holds = findHolds(r.model, (h) => r.core.mesh(h, "preview"));
    expect(sweepChecks(r.model, holds, r.kernel, mesh)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("says how many parts are still to get ready when it runs out of time, and finishes with time", async () => {
    const r = await fullCheck(`
part base { material: "Aluminum 6061"  body box(80, 80, 6)  cut cylinder(d: 8, h: 8, at: (0, 0, -1), dir: Z) }
part arm {
  material: "Aluminum 6061"
  spin: 1
  axis: Z
  axis_at: (0, 0, 0)
  body box(60, 10, 6, at: (25, 0, 8))
}
`);
    expect(r.model.parts.find((p) => p.name === "arm")?.motion).toBeTruthy();
    // the solids as a kernel that has just built them hands them over: nothing about their surfaces is kept yet
    const fresh = new Map(r.model.parts.map((p) => [p.hash, { ...r.core.mesh(p.hash, "preview")! }]));
    const mesh = (h: string) => fresh.get(h);
    const holds = findHolds(r.model, mesh);
    // no time at all: nothing is ready, and the report says so instead of saying the sweep is clear
    const hurried = sweepChecks(r.model, holds, r.kernel, mesh, [], -1);
    expect(hurried.map((i) => [i.id, i.status])).toEqual([["sweep:partial", "pending"]]);
    expect(hurried[0].detail).toMatch(/^2 parts still to get ready/);
    // with time, the sweep is made and nothing is left pending
    const full = sweepChecks(r.model, holds, r.kernel, mesh);
    expect(full.some((i) => i.id === "sweep:partial")).toBe(false);
    expect(full.every((i) => i.status !== "pending")).toBe(true);
  });
});
