// Travel and rolling that the design states once and Kerf carries through: a
// lift that runs to the end of its travel and back with the drive turning
// back at the top, wheels and rollers turned by what they run on so their
// surfaces never slip, and the checks that take a wheel on its track or a
// tyre on the part it drives as contact that is meant, held to what rolling
// needs, instead of as a collision.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { applyMat, motionPose, solveLink, type Mat4 } from "../src/core/kinematics";
import { linkChecks } from "../src/core/linkChecks";
import { sweepAngles } from "../src/core/sweepChecks";
import type { CheckItem } from "../src/core/checks";
import type { Model } from "../src/core/model";
import type { V3 } from "../src/kernel/recipe";
import { fullCheck } from "./helpers/fullcheck";
import { initKernel } from "./helpers/kernel";
import { KernelCore } from "../src/kernel/core";
import { resolveMechanism } from "../src/sim/mech/resolve";

const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const part = (m: Model, name: string) => m.parts.find((p) => p.name === name)!;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** The inverse of a pose (a turn and a move). */
const unpose = (m: Mat4): Mat4 => {
  const t: V3 = [m[12], m[13], m[14]];
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1];
};

// a car that runs 400 mm up a square tower on a guide wheel
const lift = (car = "", wheel = "rolls_on: tower  touch: (20, 0, 110)") => `
design "lift"
part tower { body box(40, 40, 600) }
part car { body box(160, 160, 20, at: (0, 0, 100))  cut box(100, 100, 40, at: (0, 0, 90))  slides: Z  travel: 400  ${car} }
part wheel { body cylinder(d: 30, h: 10, at: (35, -5, 110), dir: Y)  axis: Y  axis_at: (35, 0, 110)  rides: car  ${wheel} }
`;

describe("a part with travel of its own", () => {
  it("runs to the end of its travel and back, the drive turning back with it", () => {
    const m = evaluate(lift());
    expect(errors(m)).toEqual([]);
    const car = part(m, "car").motion!;
    expect(car.kind).toBe("slide");
    expect(m.driveRange).toBe(360);
    const z = (deg: number) => applyMat(motionPose(car, deg), [0, 0, 100])[2] - 100;
    expect(z(0)).toBeCloseTo(0, 9);
    expect(z(90)).toBeCloseTo(100, 9);
    expect(z(360)).toBeCloseTo(400, 9);
    // past the top the drive turns back: the same way down as up
    expect(z(450)).toBeCloseTo(300, 9);
    expect(z(720)).toBeCloseTo(0, 9);
    expect(z(810)).toBeCloseTo(100, 9);
    // no rod is missing: it moves by its travel
    expect(linkChecks(m)).toEqual([]);
    // swept from one end to the other, no step moving it more than 2 mm
    const at = sweepAngles([car]);
    expect(at[0]).toBe(0);
    expect(at[at.length - 1]).toBe(360);
    expect(at.length).toBeGreaterThanOrEqual(201);
  });

  it("moves per_turn: for each turn of the drive, which sets how long the drive runs", () => {
    const m = evaluate(lift("per_turn: 8"));
    expect(errors(m)).toEqual([]);
    // 400 mm at 8 mm a turn: 50 turns up
    expect(m.driveRange).toBe(50 * 360);
    const z = (deg: number) => applyMat(motionPose(part(m, "car").motion!, deg), [0, 0, 0])[2];
    expect(z(360)).toBeCloseTo(8, 9);
    expect(z(50 * 360)).toBeCloseTo(400, 9);
    expect(z(51 * 360)).toBeCloseTo(392, 9);
  });

  it("goes the other way with a negative travel, and carries what rides on it", () => {
    const m = evaluate(`
part gate { body box(200, 10, 100, at: (0, 0, 300))  slides: Z  travel: -250 }
part handle { body box(20, 20, 20, at: (0, 15, 340))  rides: gate }
`);
    expect(errors(m)).toEqual([]);
    for (const n of ["gate", "handle"]) expect(applyMat(motionPose(part(m, n).motion!, 360), [0, 0, 300])[2]).toBeCloseTo(50, 9);
  });

  it("says what is missing or mixed up", () => {
    expect(errors(evaluate(`part a { body box(10, 10, 10)  travel: 100 }`))[0]).toMatch(/travel: needs slides:/);
    expect(errors(evaluate(`part a { body box(10, 10, 10)  slides: Z  per_turn: 8 }`))[0]).toMatch(/per_turn: goes with slides: and travel:/);
    expect(errors(evaluate(`part a { body box(10, 10, 10)  slides: Z  travel: 100  spin: 1 }`))[0]).toMatch(/spin: with travel:/);
    expect(errors(evaluate(`part a { body box(10, 10, 10)  slides: Z  travel: 0 }`))[0]).toMatch(/travel: how far it moves/);
    // a rod cannot also drive a part that moves by its travel
    const m = evaluate(`
part crank { body cylinder(d: 50, h: 10)  spin: 1 }
part a { body box(10, 10, 10, at: (0, 0, 80))  slides: Z  travel: 100 }
part rod { body box(5, 5, 60, at: (20, 0, 10))  links: [crank, a]  pins: [(20, 0, 10), (20, 0, 80)] }
`);
    expect(errors(m)[0]).toMatch(/already moves by its own travel:/);
    // a slide with neither a rod nor travel still fails, now saying both ways out
    expect(linkChecks(evaluate(`part a { body box(10, 10, 10)  slides: Z }`))[0].fix).toMatch(/give a travel:/);
  });
});

describe("a part that rolls on another", () => {
  it("turns a guide wheel so its rim never slips on the tower as the car climbs", () => {
    const m = evaluate(lift());
    expect(errors(m)).toEqual([]);
    const wheel = part(m, "wheel");
    expect(wheel.motion?.kind).toBe("roll");
    expect(wheel.motion?.roll).toMatchObject({ onName: "tower", r: 15 });
    expect(wheel.rollsOn).toEqual({ names: ["tower"], touch: [20, 0, 110] });
    const car = part(m, "car").motion!;
    for (const deg of [0.5, 45, 200, 359, 400, 700]) {
      // the wheel's own material at the touch point stands still against the tower
      const c = applyMat(motionPose(car, deg), [20, 0, 110]);
      const q = applyMat(unpose(motionPose(wheel.motion!, deg)), c);
      const v = dist(applyMat(motionPose(wheel.motion!, deg + 1e-3), q), applyMat(motionPose(wheel.motion!, deg - 1e-3), q)) / 2e-3;
      expect(v).toBeLessThan(1e-6);
    }
    // 400 mm of travel on a 15 mm rolling radius
    const top = motionPose(wheel.motion!, 360);
    const turn = 400 / 15;
    expect(top[0]).toBeCloseTo(Math.cos(turn), 6);
    // its far side goes up twice as fast as the car: it turns with the top of the rim toward the tower
    expect(-top[2]).toBeCloseTo(Math.sin(-turn), 6);
    // the sweep samples the wheel no coarser than 7.5° of its own turn
    expect(sweepAngles([wheel.motion]).length).toBeGreaterThan((turn * 180) / Math.PI / 7.5);
  });

  it("turns a disc from the tyre pressed on its rim, the other way and slower by the radii", () => {
    const m = evaluate(`
part tyre { body cylinder(d: 20, h: 10, at: (60, 0, 0))  spin: 2  axis: Z  axis_at: (60, 0, 0) }
part disc { body cylinder(d: 100, h: 10)  axis: Z  rolls_on: tyre  touch: (50, 0, 5) }
`);
    expect(errors(m)).toEqual([]);
    const disc = motionPose(part(m, "disc").motion!, 90);
    // tyre 2 × 90° on a 10 mm radius against a 50 mm rim: 36° back
    expect((Math.atan2(disc[1], disc[0]) * 180) / Math.PI).toBeCloseTo(-36, 6);
    expect(m.driveRange).toBeUndefined();
  });

  it("turns a roller carried round a still post, like a planet with no teeth", () => {
    const m = evaluate(`
part post { body cylinder(d: 60, h: 20) }
part arm { body box(80, 10, 5, at: (20, 0, 20))  spin: 1  axis: Z }
part roller { body cylinder(d: 20, h: 10, at: (40, 0, 5))  axis: Z  axis_at: (40, 0, 0)  rides: arm  rolls_on: post  touch: (30, 0, 10) }
`);
    expect(errors(m)).toEqual([]);
    // round a post three times its size it turns four times for each turn of the arm
    const r = motionPose(part(m, "roller").motion!, 30);
    expect((Math.atan2(r[1], r[0]) * 180) / Math.PI).toBeCloseTo(120, 5);
  });

  it("adds up the turn of a roller whose speed keeps changing (on a piston)", () => {
    const m = evaluate(`
part crank { body cylinder(d: 50, h: 10, at: (0, -5, 0), dir: Y)  spin: 1  axis: Y }
part piston { body cylinder(d: 30, h: 20, at: (0, 0, 90))  slides: Z }
part rod { body box(8, 6, 80, at: (0, 0, 20))  links: [crank, piston]  pins: [(0, 0, 20), (0, 0, 100)] }
part wall { body box(10, 40, 200, at: (35, 0, 0)) }
part roller { body cylinder(d: 20, h: 10, at: (20, -5, 100), dir: Y)  axis: Y  axis_at: (20, 0, 100)  rides: piston  rolls_on: wall  touch: (30, 0, 100) }
`);
    expect(errors(m)).toEqual([]);
    const roller = part(m, "roller").motion!;
    const link = part(m, "rod").motion!.link!;
    for (const deg of [10, 90, 180, 275, 360, 500]) {
      // rolled by exactly how far the piston has slid, over its 10 mm radius
      const turn = solveLink(link, deg).x / 10;
      const R = motionPose(roller, deg);
      expect(R[0]).toBeCloseTo(Math.cos(turn), 5);
      expect(-R[2]).toBeCloseTo(Math.sin(turn), 5);
    }
    // the same angle always gives the same turn, whatever was asked before
    expect(motionPose(roller, 90)).toEqual(motionPose(roller, 90));
  });

  it("keeps a motor-driven wheel's own spin and just notes what it runs on", () => {
    const m = evaluate(lift("", "spin: 3  rolls_on: [tower, car]"));
    expect(errors(m)).toEqual([]);
    const wheel = part(m, "wheel");
    expect(wheel.motion?.kind).toBeUndefined();
    expect(wheel.motion?.ratio).toBe(3);
    expect(wheel.rollsOn).toEqual({ names: ["tower", "car"] });
  });

  it("says what is missing", () => {
    expect(errors(evaluate(lift("", "rolls_on: tower")))[0]).toMatch(/rolls_on: give touch: \(x, y, z\), the point where wheel meets tower/);
    expect(errors(evaluate(lift("", "touch: (20, 0, 110)")))[0]).toMatch(/touch: goes with rolls_on:/);
    expect(errors(evaluate(lift("", "rolls_on: tower  touch: (35, 0, 110)")))[0]).toMatch(/is on wheel's own axis/);
    expect(errors(evaluate(lift("", "rolls_on: wheel  touch: (20, 0, 110)")))[0]).toMatch(/cannot roll on itself/);
    expect(errors(evaluate(lift("", "rolls_on: 5  touch: (20, 0, 110)")))[0]).toMatch(/rolls_on: expected a part or component/);
  });
});

const pick = (items: CheckItem[], prefix: RegExp) => items.filter((i) => prefix.test(i.id)).map((i) => `${i.status} ${i.id}`).sort();
const find = (items: CheckItem[], id: string) => items.find((i) => i.id === id)!;

// a drop ride: the car climbs the tower on a guide wheel, and passes a motor's tyre on the way up
const ride = (o: { gap?: number; said?: boolean; tyre?: string; spin?: number; wheel?: string; press?: number; tower?: number } = {}) => `
design "drop ride"
part base { body box(300, 300, 10, at: (0, 0, -10))  held: "bolted to the floor" }
part tower { body box(40, 40, ${o.tower ?? 600})  held: "welded to the base" }
part car { body box(160, 160, 20, at: (0, 0, 100))  cut box(100, 100, 40, at: (0, 0, 90))  slides: Z  travel: 400  held: "its hoist rope" }
part wheel { body cylinder(d: 30, h: 10, at: (${35 - (o.press ?? 0)}, -5, 110), dir: Y)  material: "${o.wheel ?? "POM"}"  axis: Y  axis_at: (${35 - (o.press ?? 0)}, 0, 110)  rides: car  rolls_on: tower  touch: (20, 0, 110)  held: "its axle" }
part tyre { body cylinder(d: 50, h: 10, at: (${105 + (o.gap ?? 0)}, -5, 300), dir: Y)  material: "${o.tyre ?? "TPU"}"  axis: Y  axis_at: (${105 + (o.gap ?? 0)}, 0, 300)  spin: ${o.spin ?? 3}  ${o.said ? "rolls_on: car" : ""}  held: "its motor" }
`;

describe("contact that is meant", () => {
  it("takes a wheel on its track and a tyre on the car it drives as running contact, not a collision", async () => {
    const { report } = await fullCheck(ride({ gap: -1.5, said: true }));
    expect(pick(report.items, /^(sweep|roll|int):/)).toEqual(["pass int:none", "pass roll:ok:tyre|car", "pass roll:ok:wheel|tower", "pass sweep:ok"]);
    const wheel = find(report.items, "roll:ok:wheel|tower");
    expect(wheel.detail).toMatch(/wheel is on tower through the whole motion\. Their surfaces move together there: it rolls without slipping\./);
    const tyre = find(report.items, "roll:ok:tyre|car");
    // 1.5 mm into a 25 mm rubber tyre, which takes 2.5 mm; it spins faster than the car passes
    expect(tyre.detail).toMatch(/pressed in 1\.5 mm at most \(rubber of this size gives about 2\.5 mm\)/);
    expect(tyre.detail).toMatch(/passes car's at about \d+ mm for each turn of the drive there, so it drives by friction/);
    expect(find(report.items, "sweep:ok").detail).toMatch(/swept through their whole travel/);
  }, 120_000);

  it("takes an unsaid rubber wheel as a tyre, and says how to confirm it", async () => {
    const { report } = await fullCheck(ride({ gap: -1.5 }));
    expect(pick(report.items, /^(sweep|roll):/)).toEqual(["info roll:tyre:tyre|car", "pass roll:ok:wheel|tower", "pass sweep:ok"]);
    const tyre = find(report.items, "roll:tyre:tyre|car");
    expect(tyre.detail).toMatch(/tyre is a rubber wheel and meets car .*so Kerf takes it as a tyre doing its job, not a collision/);
    expect(tyre.fix).toMatch(/give tyre rolls_on: car/);
  }, 120_000);

  it("still warns when an unsaid hard roller scrapes a part passing it, and offers rolls_on:", async () => {
    const { report } = await fullCheck(ride({ gap: 0.05, tyre: "Steel" }));
    expect(pick(report.items, /^(sweep|roll):/)).toEqual(["pass roll:ok:wheel|tower", "warn sweep:rub:car|tyre"]);
    const rub = find(report.items, "sweep:rub:car|tyre");
    expect(rub.detail).toMatch(/comes into contact with it at 2\d\d mm into car's travel/);
    expect(rub.fix).toMatch(/If tyre is meant to run on car there .* give tyre rolls_on: car \(two hard parts must then only touch/);
  }, 120_000);

  it("sees two surfaces that meet without sliding as rolling, said or not", async () => {
    // the car passes at 400 mm a turn; a 25 mm roller turning 2.5465 times a turn has the same rim speed
    const { report } = await fullCheck(ride({ gap: 0.05, tyre: "Steel", spin: 400 / (2 * Math.PI * 25) }));
    expect(pick(report.items, /^(sweep|roll):/)).toEqual(["pass roll:ok:tyre|car", "pass roll:ok:wheel|tower", "pass sweep:ok"]);
    expect(find(report.items, "roll:ok:tyre|car").detail).toMatch(/^Not said with rolls_on:, but the two meet without sliding\. .*it rolls without slipping\./);
  }, 120_000);

  it("fails a tyre pressed in further than rubber gives, and warns of one that never touches", async () => {
    const deep = await fullCheck(ride({ gap: -5, said: true }));
    expect(pick(deep.report.items, /^(sweep|roll):/)).toEqual(["fail roll:digs:tyre|car", "pass roll:ok:wheel|tower"]);
    const digs = find(deep.report.items, "roll:digs:tyre|car");
    expect(digs.detail).toMatch(/it is 5 mm into it near .*rubber of this size gives about 2\.5 mm/);
    expect(digs.fix).toMatch(/Move tyre at least 2\.5 mm away from car/);
    const apart = await fullCheck(ride({ gap: 3, said: true }));
    expect(pick(apart.report.items, /^(sweep|roll):/)).toEqual(["pass roll:ok:wheel|tower", "pass sweep:ok", "warn roll:apart:tyre|car"]);
    expect(find(apart.report.items, "roll:apart:tyre|car").detail).toMatch(/the closest the two come, drawn or moving, is 3 mm/);
  }, 120_000);

  it("lets a rubber wheel be drawn pressed onto its track, but not a hard one", async () => {
    const soft = await fullCheck(ride({ press: 1, wheel: "TPU", said: true }));
    expect(pick(soft.report.items, /^(int|roll):/)).toEqual(["pass int:none", "pass int:tower|wheel", "pass roll:ok:tyre|car", "pass roll:ok:wheel|tower"]);
    expect(find(soft.report.items, "int:tower|wheel").title).toBe("wheel is pressed onto tower");
    expect(find(soft.report.items, "roll:ok:wheel|tower").detail).toMatch(/pressed in 1 mm at most \(rubber of this size gives about 1\.\d mm\)/);
    const hard = await fullCheck(ride({ press: 1, said: true }));
    expect(pick(hard.report.items, /^(int|roll):/)).toEqual(["fail int:tower|wheel", "pass roll:ok:tyre|car"]);
    const clash = find(hard.report.items, "int:tower|wheel");
    expect(clash.title).toMatch(/^wheel is drawn 0\.9 mm into tower|^wheel is drawn 1 mm into tower/);
    expect(clash.fix).toMatch(/Place wheel so its rim just touches tower .*or give it a rubber tyre/);
  }, 120_000);

  it("warns when a guide wheel runs off the end of its track", async () => {
    const { report } = await fullCheck(ride({ tower: 300, said: true }));
    const off = find(report.items, "roll:leaves:wheel|tower");
    expect(off.status).toBe("warn");
    expect(off.detail).toMatch(/on it for only \d\d% of the motion/);
  }, 120_000);
});

describe("a lift in the simulation", () => {
  it("slides between the ends of its travel, with its wheel pivoting on it", async () => {
    await initKernel();
    const model = evaluate(`${ride({ said: true })}
scenario "Run it" {
  mechanism: sim.mechanism(sim.turn(tyre, speed: 60rpm))
  duration: 1s
}`);
    expect(errors(model)).toEqual([]);
    const core = new KernelCore();
    for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    const geom = (h: string) => {
      const e = core.get(h);
      return e ? { preview: core.mesh(h, "preview"), volume: e.volume, bbox: e.bbox, rev: 0 } : undefined;
    };
    const r = resolveMechanism(model.scenarios![0].spec, model, geom, true);
    if (!("mech" in r)) throw new Error(JSON.stringify(r));
    expect(r.mech.joints.map((j) => `${j.kind} ${j.name} on ${j.on}`).sort()).toEqual(["pivot tyre on frame", "pivot wheel on car", "slider car on frame"]);
    const car = r.mech.joints.find((j) => j.name === "car")!;
    expect(car.limits).toEqual([0, 0.4]);
  }, 120_000);
});
