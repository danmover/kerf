// The geometry core (crates/kerf-geom, built to src/geom/kerf_geom.wasm) inside the kernel's checks: what it
// proves about two parts has to agree with the kernel's exact test, and the checks have to give the same answers
// with it as without it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { buildChecksRequest } from "../src/core/checks";
import { geomCore, poseKey } from "../src/geom/core";
import { xformMatrix, type Xform } from "../src/kernel/recipe";
import type { ChecksResult } from "../src/kernel/protocol";
import { initKernel } from "./helpers/kernel";

beforeAll(async () => {
  await initKernel();
}, 120_000);

const IDENTITY = xformMatrix([]);

describe("the committed build", () => {
  it("was made from the Rust sources in this checkout", () => {
    // fails when crates/ changed without `npm run geom`
    expect(() => execFileSync(process.execPath, ["scripts/build-geom.mjs", "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe("the geometry core on its own", () => {
  it("proves a cylinder clear of one beside it and not of one through it", () => {
    const core = geomCore()!;
    const a = core.cylinder(5, 20);
    const b = core.cylinder(5, 20);
    expect(core.info(a)).toMatchObject({ closed: true, pieces: 1, mismatched: 0, flat: 2, round: 1 });
    const at = (x: number, y = 0, z = 0) => xformMatrix([{ op: "translate", v: [x, y, z] }]);
    // side by side with a hair between them, then touching, then pushed together
    expect(core.classify(a, b, IDENTITY, at(10.001))).toMatchObject({ clear: true, atMost: 0 });
    expect(core.classify(a, b, IDENTITY, at(10))).toMatchObject({ clear: true, atMost: 0 });
    expect(core.classify(a, b, IDENTITY, at(9)).atMost).toBeNull();
    // end to end, and one wholly inside a wider one
    expect(core.classify(a, b, IDENTITY, at(0, 0, 20)).clear).toBe(true);
    const wide = core.cylinder(9, 40);
    expect(core.classify(wide, a, IDENTITY, at(0, 0, 10))).toMatchObject({ clear: false, atMost: null, why: "inside" });
    for (const h of [a, b, wide]) core.drop(h);
    expect(core.info(a)).toBeNull();
  });

  it("says which of two touching parts rests on the other", () => {
    const core = geomCore()!;
    const a = core.cylinder(5, 20);
    const b = core.cylinder(5, 20);
    const up = xformMatrix([{ op: "translate", v: [0, 0, 20] }]);
    // b stands on a
    expect(core.touch(a, b, IDENTITY, up, 0.3)).toEqual({ aOnB: false, bOnA: true });
    expect(core.touch(b, a, up, IDENTITY, 0.3)).toEqual({ aOnB: true, bOnA: false });
    expect(core.touch(a, b, IDENTITY, xformMatrix([{ op: "translate", v: [0, 0, 21] }]), 0.3)).toBeNull();
    core.drop(a);
    core.drop(b);
  });

  it("gives one key to a pair wherever the pair is moved as a whole", () => {
    const a: Xform[] = [{ op: "translate", v: [3, 0, 1] }];
    const b: Xform[] = [{ op: "rotate", origin: [0, 0, 0], axis: [0, 0, 1], angle: 30 }, { op: "translate", v: [0, 7, 0] }];
    const moved: Xform[] = [{ op: "rotate", origin: [5, 5, 0], axis: [1, 2, 3], angle: 71 }, { op: "translate", v: [100, -40, 12] }, { op: "mirror", origin: [0, 0, 0], normal: [1, 0, 0] }];
    const key = poseKey(xformMatrix(a), xformMatrix(b));
    expect(poseKey(xformMatrix([...a, ...moved]), xformMatrix([...b, ...moved]))).toBe(key);
    // and another to the pair when one of the two moves on its own
    expect(poseKey(xformMatrix(a), xformMatrix([...b, { op: "translate", v: [0, 0, 0.001] }]))).not.toBe(key);
  });
});

/** What the checks found, in an order that does not depend on how they were worked out. */
function findings(r: ChecksResult) {
  return {
    interferences: r.interferences.map((i) => `${i.a} x ${i.b} ${i.volume.toFixed(2)}`).sort(),
    contacts: (r.contacts ?? []).map((c) => `${c.a} x ${c.b} ${+c.aOnB}${+c.bOnA}`).sort(),
    access: r.access.map((a) => `${a.id}: ${[...a.blockedBy].sort().join(",")}`).sort(),
    envelopes: r.envelopes.map((e) => `${e.id}: ${[...e.hits].sort().join(",")}`).sort(),
  };
}

describe("the kernel's checks with the geometry core", () => {
  // built-in designs with screws in holes, bearings on shafts, gears and tool access between them
  for (const name of ["enclosure", "reducer", "printer"]) {
    it(`agrees with the exact kernel on the ${name} template`, () => {
      const model = evaluate(readFileSync(new URL(`../src/demos/${name}.kerf`, import.meta.url), "utf8"));
      const core = new KernelCore();
      const built = new Set<string>();
      for (const p of model.parts) {
        if (built.has(p.hash)) continue;
        core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
        built.add(p.hash);
      }
      const req = buildChecksRequest(model, built);
      // with the core, every answer it gives also put to the kernel
      core.audit = [];
      const fast = core.checks(req);
      expect(core.audit).toEqual([]);
      expect(fast.settled!.proved).toBeGreaterThan(0);
      // a second check of the same design asks nothing again
      core.audit = null;
      const again = core.checks(req);
      expect(again.settled).toEqual({ proved: 0, film: 0, reused: again.settled!.reused, exact: 0 });
      expect(findings(again)).toEqual(findings(fast));
      // and without the core, as the checks were before it
      const old = new KernelCore();
      old.useGeomCore = false;
      for (const p of model.parts) if (!old.has(p.hash)) old.build({ hash: p.hash, recipe: p.recipe, label: p.label });
      const slow = old.checks(req);
      expect(findings(fast)).toEqual(findings(slow));
      expect(fast.settled!.exact).toBeLessThan(slow.settled!.exact);
    }, 600_000);
  }
});
