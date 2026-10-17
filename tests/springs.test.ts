import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { springChecks } from "../src/analysis/springs/report";
import { springCalc, springRate } from "../src/library/springs";

const checks = (src: string) => {
  const m = evaluate(`design "t"\n${src}`);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return { m, items: springChecks(m) };
};

describe("springs, snap fits and flexures", () => {
  it("works out a compression spring by the book", () => {
    // Shigley-style example: music wire, d 1, D 9, 8 active coils
    expect(springRate({ d: 1, od: 10, coils: 8, material: "Steel" }).k).toBeCloseTo(1.66, 1);
    const { m, items } = checks(`component sp = lib.spring(d: 1, od: 10, free: 30, coils: 8, installed: 24, working: 16) { at: (0, 0, 0), axis: Z }`);
    const sp = m.parts.find((p) => p.name === "sp")!;
    expect(sp.spring).toMatchObject({ d: 1, od: 10, free: 30, installed: 24, working: 16 });
    const r = springCalc(sp.spring!, sp.material);
    expect(r.preload).toBeCloseTo(1.66 * 6, 0);
    expect(r.solid).toBeCloseTo(10);
    expect(r.Ssy).toBeCloseTo(995, -1);
    expect(items[0].title).toMatch(/Spring sp: 1\.66 N\/mm/);
    expect(items[0].status).not.toBe("fail");
  });

  it("catches coil bind, set and buckling", () => {
    const bind = checks(`component sp = lib.spring(d: 1.5, od: 10, free: 30, coils: 14, installed: 28, working: 20) { at: (0, 0, 0), axis: Z }`).items[0];
    expect(bind.status).toBe("fail");
    expect(bind.detail).toMatch(/coil bind/);
    const long = checks(`component sp = lib.spring(d: 0.8, od: 8, free: 60, coils: 20, installed: 55, working: 40, cycles: 1000) { at: (0, 0, 0), axis: Z }`).items[0];
    expect(long.detail).toMatch(/buckles sideways/);
  });

  it("breaks a snap hook printed with its layers across the arm, and passes it printed lying down", () => {
    const hook = (build: string) => `part clip {
  material: "PETG"
  process: mfg.fdm(build: ${build})
  body box(30, 20, 3)
  add snap_hook(at: (0, 0, 3), length: 12, t: 1.6, w: 6, catch: 1) as hook
}`;
    const upright = checks(hook("Z")).items[0];
    expect(upright.status).toBe("fail");
    expect(upright.fix).toMatch(/lies along the bed/);
    const flat = checks(hook("Y")).items[0];
    expect(flat.status).toBe("pass");
    expect(flat.detail).toMatch(/Push-in force about [\d.]+ N/);
    expect(flat.detail).toMatch(/does not let go/);
  });

  it("says whether a latch stays tight or goes slack", () => {
    const latch = (extra: string) =>
      checks(`part clip {
  material: "PETG"
  process: mfg.fdm(build: Y)
  body box(30, 20, 3)
  add snap_hook(at: (0, 0, 3), length: 14, t: 1.6, w: 6, catch: 1.2${extra}) as hook
}`).items[0];
    expect(latch("").detail).toMatch(/no preload, it has up to [\d.]+ mm of play/);
    expect(latch(", retain: 45, preload: 0.4").detail).toMatch(/stays tight/);
    const slack = latch(", retain: 75, preload: 0.05");
    expect(slack.status).toBe("warn");
    expect(slack.detail).toMatch(/goes slack/);
    // a sloped catch can be pulled apart again
    expect(latch(", retain: 45, preload: 0.4").detail).toMatch(/pulls apart at about [\d.]+ N/);
  });

  it("checks flexure blades and living hinges", () => {
    const { items } = checks(`part flex {
  material: "PETG"
  process: mfg.fdm(build: Y)
  body box(30, 20, 3)
  add flexure(at: (0, 0, 3), length: 20, t: 0.8, w: 6, travel: 1) as blade
}
part box_lid {
  material: "PP"
  process: mfg.fdm(build: X)
  body box(30, 20, 2, at: (0, 40, 0))
  add flexure(at: (0, 40, 2), length: 2, t: 0.4, w: 20, angle: 120) as hinge
}
part bad_lid {
  material: "PLA"
  process: mfg.fdm(build: X)
  body box(30, 20, 2, at: (0, 80, 0))
  add flexure(at: (0, 80, 2), length: 2, t: 0.4, w: 20, angle: 120) as hinge
}`);
    const [blade, pp, pla] = items;
    expect(blade.status).toBe("pass");
    expect(blade.detail).toMatch(/N\/mm/);
    expect(pp.status).toBe("pass");
    expect(pla.status).toBe("fail");
    expect(pla.fix).toMatch(/PP or TPU/);
  });
});
