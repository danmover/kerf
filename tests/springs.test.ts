import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { springChecks } from "../src/analysis/springs/report";
import { springCalc, springRate } from "../src/library/springs";
import { hotSoakChecks } from "../src/analysis/hotSoak";

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

  it("makes a peg that clicks into a hole and says what shears it", () => {
    const { m, items } = checks(`part clip {
  material: "ASA"
  process: mfg.fdm(build: Y)
  body box(30, 20, 3)
  add snap_hook(at: (0, 0, 3), length: 14, t: 1.6, w: 4.5, catch: 1.2, angle: 45, root_r: 0, peg: 3) as hook
}`);
    const f = m.parts[0].flex![0];
    expect(f.peg).toBe(3);
    expect(items[0].detail).toMatch(/Ø3 mm peg clicks into the hole and holds until it shears at about [\d.]+ N/);
  });

  it("puts a locking pin on a flexure blade, says how far it draws back and what shears it, and refuses one it cannot hold", () => {
    const { m, items } = checks(`part clip {
  material: "ASA"
  process: mfg.fdm(build: Z)
  body box(30, 20, 3)
  add flexure(at: (0, 0, 3), length: 20, t: 1.2, w: 8, dir: Y, facing: -X, travel: 3, cycles: 500, pin: 3, reach: 5, pin_at: 16, teardrop: -Z) as arm
}`);
    const f = m.parts[0].flex![0];
    expect(f).toMatchObject({ kind: "flexure", peg: 3, reach: 5, pinAt: 16 });
    // 3 × 16²(60 − 16) / (2 × 20³) of the tip's 3 mm
    expect(items[0].detail).toMatch(/Ø3 mm pin, 16 mm from the root, stands 5 mm out of the blade; full travel draws it back 2\.11 mm/);
    expect(items[0].detail).toMatch(/lets go only by shearing twice, at about [\d.]+ N/);
    const errs = (args: string) =>
      evaluate(`design "t"\npart p { body box(30, 20, 3)\n add flexure(at: (0, 0, 3), length: 20, t: 1.2, w: 8, dir: Y, facing: -X, ${args}) }`)
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => d.message)
        .join(" ");
    expect(errs("travel: 2, reach: 5")).toMatch(/give its diameter with pin:/);
    expect(errs("travel: 2, pin: 3, reach: 5, pin_at: 19.5")).toMatch(/pin_at must keep the pin on the blade/);
    expect(errs("angle: 90, pin: 3, reach: 5")).toMatch(/not a living hinge/);
    expect(errs("travel: 2, pin: 10, reach: 5")).toMatch(/no wider than the blade/);
    expect(errs("travel: 2, pin: 3, reach: 5, teardrop: X")).toMatch(/across the pin, not along it/);
    // or lined up with the hole it goes through, which may sit off the blade's middle (here 2 mm down its width)
    const off = checks(`part clip {
  material: "ASA"
  process: mfg.fdm(build: Z)
  body box(30, 20, 3)
  add flexure(at: (0, 0, 3), length: 20, t: 1.2, w: 8, dir: Y, facing: -X, travel: 3, cycles: 500, pin: 3, reach: 5, pin_at: (-4, 16, 1)) as arm
}`).m.parts[0].flex![0];
    expect(off).toMatchObject({ pinAt: 16, pinOff: 2 });
    expect(errs("travel: 2, pin: 3, reach: 5, pin_at: (0, 16, 0)")).toMatch(/pin_at must keep the pin on the blade: at most 2\.5 mm off its middle/);
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

  it("loosens a preloaded latch left in a hot car, and asks for a car's temperatures", () => {
    const clip = (mat: string, temp: string, setting = "On a desk") =>
      hotSoakChecks(
        checks(`brief {
  purpose: "A clip-on cover"
  setting: "${setting}"
  temp: ${temp}
}
part clip {
  material: "${mat}"
  process: mfg.fdm(build: Y)
  body box(30, 20, 3)
  add snap_hook(at: (0, 0, 3), length: 14, t: 1.6, w: 6, catch: 1.2, retain: 45, preload: 0.4) as hook
}`).m,
      );
    // PLA softens at about 52 °C: held bent at 40 °C it relaxes
    const pla = clip("PLA", "0C .. 40C");
    expect(pla).toHaveLength(0);
    const hot = clip("PLA", "0C .. 50C");
    expect(hot[0].status).toBe("warn");
    expect(hot[0].title).toMatch(/hook loosens at 50 °C/);
    expect(hot[0].fix).toMatch(/preload: 0/);
    expect(clip("PC", "0C .. 50C").map((i) => i.status)).toEqual(["pass"]);
    // the brief says car, but stops at 40 °C
    const car = clip("PETG", "0C .. 40C", "Clipped to a car dashboard");
    expect(car.map((i) => i.id)).toEqual(["knocks:hot-car"]);
    expect(car[0].fix).toMatch(/temp: -20C \.\. 70C/);
  });
});
