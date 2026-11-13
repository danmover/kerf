// Relations between joints (gears, belts, a rack, lead screws, a cam), a pin in a slot, and stops on hinges and
// slides: what one joint turns or slides the other follows, counted from where the parts are drawn, and dragging
// either drives both.

import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { mateDragTo, startMateDrag, type MateDrag } from "../src/core/mateDrag";
import { camLift, movePoint, solveMates, type BodyMove } from "../src/core/mates";
import type { Model } from "../src/core/model";
import type { V3 } from "../src/kernel/recipe";

const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const deg = Math.PI / 180;

/** How far a body has turned about +Z (degrees, −180…180) from where it is drawn. */
const turnZ = (mv: BodyMove | undefined) => (mv ? Math.atan2(mv.R[3], mv.R[0]) / deg : 0);
/** Where a body's drawn point is now. */
const at = (d: MateDrag, body: string, p: V3) => {
  const mv = d.moves.get(body);
  return mv ? movePoint(mv, p) : p;
};

/** Turn a body about a vertical axis through c by pulling a point r out along X round, a step at a time. */
function turnBy(m: Model, d: MateDrag, c: V3, r: number, from: number, to: number, step = 20): MateDrag {
  const n = Math.max(1, Math.ceil(Math.abs(to - from) / step));
  for (let i = 1; i <= n; i++) {
    const a = (from + ((to - from) * i) / n) * deg;
    d = mateDragTo(m, d, [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), c[2]]);
  }
  return d;
}

const GEARS = (how: string) => `design "gears"
part frame { body box(120, 60, 4) }
part pinion { at: (0, 0, 10) body cylinder(d: 20, h: 4) }
part wheel { at: (30, 0, 10) body cylinder(d: 40, h: 4) }
mate drive = revolute(axis(pinion, at: (0, 0, 10), dir: +Z), axis(frame, at: (0, 0, 10), dir: +Z))
mate driven = revolute(axis(wheel, at: (30, 0, 10), dir: +Z), axis(frame, at: (30, 0, 10), dir: ${how.includes("flipped") ? "-Z" : "+Z"}))
mate mesh = ${how.replace("flipped ", "")}
`;

describe("gears and belts", () => {
  it("turns the second gear the other way, by the teeth, and either drives the other", () => {
    const m = evaluate(GEARS("gear(drive, driven, teeth: (20, 40))"));
    expect(errors(m)).toEqual([]);
    expect(m.mates?.list.map((x) => [x.name, x.kind, x.status])).toEqual([
      ["drive", "revolute", "ok"],
      ["driven", "revolute", "ok"],
      ["mesh", "gear", "ok"],
    ]);
    // two hinges and one relation: each part turns, and together they make one motion
    expect(m.mates?.free.find((f) => f.body === "wheel")?.dof).toBe(1);
    let d = startMateDrag(m, "pinion", [10, 0, 10]);
    d = turnBy(m, d, [0, 0, 10], 10, 0, 60);
    expect(turnZ(d.moves.get("pinion"))).toBeCloseTo(60, 2);
    expect(turnZ(d.moves.get("wheel"))).toBeCloseTo(-30, 2);
    // and dragging the wheel turns the pinion back
    let w = startMateDrag(m, "wheel", [30 + 20 * Math.cos(-30 * deg), 20 * Math.sin(-30 * deg), 10], d.moves, d.coords);
    w = turnBy(m, w, [30, 0, 10], 20, -30, 15);
    expect(turnZ(w.moves.get("wheel"))).toBeCloseTo(15, 2);
    expect(turnZ(w.moves.get("pinion"))).toBeCloseTo(-30, 2);
  });

  it("keeps gears that do not divide evenly in step past a whole turn", () => {
    // 30 teeth to 20: the wheel turns 1.5 times as far, so after 420° of the pinion it is 630° round
    const m = evaluate(GEARS("gear(drive, driven, teeth: (30, 20))"));
    let d = startMateDrag(m, "pinion", [10, 0, 10]);
    d = turnBy(m, d, [0, 0, 10], 10, 0, 420);
    expect(d.coords.get("drive")! / deg).toBeCloseTo(420, 1);
    expect(d.coords.get("driven")! / deg).toBeCloseTo(-630, 1);
    // −630° is a quarter turn forward
    expect(turnZ(d.moves.get("wheel"))).toBeCloseTo(90, 1);
  });

  it("reads axes drawn opposite ways, belts the same way round, and ring gears", () => {
    const flipped = evaluate(GEARS("flipped gear(drive, driven, ratio: 0.5)"));
    let d = turnBy(flipped, startMateDrag(flipped, "pinion", [10, 0, 10]), [0, 0, 10], 10, 0, 40);
    expect(turnZ(d.moves.get("wheel"))).toBeCloseTo(-20, 2);
    for (const how of ["belt(drive, driven, d: (20, 40))", "gear(drive, driven, teeth: (20, 40), internal: true)", "chain(drive, driven, teeth: (16, 32))"]) {
      const m = evaluate(GEARS(how));
      expect(errors(m)).toEqual([]);
      d = turnBy(m, startMateDrag(m, "pinion", [10, 0, 10]), [0, 0, 10], 10, 0, 40);
      expect(turnZ(d.moves.get("wheel"))).toBeCloseTo(20, 2);
    }
    const crossed = evaluate(GEARS("belt(drive, driven, d: (20, 40), crossed: true)"));
    d = turnBy(crossed, startMateDrag(crossed, "pinion", [10, 0, 10]), [0, 0, 10], 10, 0, 40);
    expect(turnZ(d.moves.get("wheel"))).toBeCloseTo(-20, 2);
  });
});

describe("racks, screws and cams", () => {
  it("slides a rack π d for each turn of its pinion, the way the pinion's edge goes", () => {
    const src = `design "rack"
part frame { body box(200, 60, 4) }
part pinion { at: (0, 0, 10) body cylinder(d: 20, h: 4) }
part rack { at: (0, 13, 10) body box(120, 6, 4) }
mate turn = revolute(axis(pinion, at: (0, 0, 10), dir: +Z), axis(frame, at: (0, 0, 10), dir: +Z))
mate run = slider(axis(rack, at: (0, 13, 10), dir: +X), axis(frame, at: (0, 13, 10), dir: +X))
mate drive = rack(turn, run, d: 20)
`;
    const m = evaluate(src);
    expect(errors(m)).toEqual([]);
    let d = startMateDrag(m, "pinion", [10, 0, 10]);
    d = turnBy(m, d, [0, 0, 10], 10, 0, 90);
    // the top of the pinion (toward the rack) goes −X as it turns about +Z: a quarter of π × 20
    expect(at(d, "rack", [0, 13, 10])[0]).toBeCloseTo(-5 * Math.PI, 2);
    expect(at(d, "rack", [0, 13, 10])[1]).toBeCloseTo(13, 4);
    // the module and teeth say the same
    const m2 = evaluate(src.replace("d: 20)", "module: 1, teeth: 20, reverse: true)"));
    d = turnBy(m2, startMateDrag(m2, "pinion", [10, 0, 10]), [0, 0, 10], 10, 0, 90);
    expect(at(d, "rack", [0, 13, 10])[0]).toBeCloseTo(5 * Math.PI, 2);
  });

  it("drives a nut along a lead screw, right-hand unless it says, on two joints or one", () => {
    const src = (screw: string) => `design "screw"
part frame { body box(60, 60, 4) }
part screw { at: (0, 0, 10) body cylinder(d: 8, h: 100) }
part nut { at: (20, 0, 50) body box(30, 16, 10) }
mate spin = revolute(axis(screw, at: (0, 0, 10), dir: +Z), axis(frame, at: (0, 0, 10), dir: +Z))
mate guide = slider(axis(nut, at: (20, 0, 50), dir: +Z), axis(frame, at: (20, 0, 50), dir: +Z))
mate feed = ${screw}
`;
    const m = evaluate(src("screw(spin, guide, lead: 8)"));
    expect(errors(m)).toEqual([]);
    let d = turnBy(m, startMateDrag(m, "screw", [4, 0, 10]), [0, 0, 10], 4, 0, 90);
    // a quarter turn forward about +Z: a right-hand screw draws the nut back 2 mm
    expect(at(d, "nut", [20, 0, 50])[2]).toBeCloseTo(48, 3);
    const left = evaluate(src("screw(spin, guide, lead: 8, left: true)"));
    d = turnBy(left, startMateDrag(left, "screw", [4, 0, 10]), [0, 0, 10], 4, 0, 90);
    expect(at(d, "nut", [20, 0, 50])[2]).toBeCloseTo(52, 3);

    // a nut on a fixed screw, on one cylindrical mate: it turns and climbs together, 2 mm a turn
    const one = evaluate(`design "nut"
part screw { body cylinder(d: 8, h: 100) }
part nut { at: (0, 0, 40) body cylinder(d: 14, h: 6) }
mate on = cylindrical(axis(nut, at: (0, 0, 40), dir: +Z), axis(screw, at: (0, 0, 0), dir: +Z))
mate thread = screw(on, lead: 2)
`);
    expect(errors(one)).toEqual([]);
    expect(one.mates?.free.find((f) => f.body === "nut")?.dof).toBe(1);
    const nd = turnBy(one, startMateDrag(one, "nut", [7, 0, 40]), [0, 0, 40], 7, 0, 180, 10);
    expect(nd.coords.get("on")! / deg).toBeCloseTo(180, 0);
    expect(at(nd, "nut", [0, 0, 40])[2]).toBeCloseTo(41, 1);
  });

  it("lifts a follower by the cam's list, spread round a turn, slid or swung", () => {
    expect(camLift([0, 5, 10, 5], 0)).toBeCloseTo(0, 12);
    expect(camLift([0, 5, 10, 5], Math.PI)).toBeCloseTo(10, 12);
    expect(camLift([0, 5, 10, 5], 2 * Math.PI + Math.PI / 2)).toBeCloseTo(5, 12);
    const src = (follower: string, lift: string) => `design "cam"
part frame { body box(80, 80, 4) }
part cam { at: (0, 0, 10) body cylinder(d: 30, h: 6) }
part rod { at: (0, 30, 10) body box(6, 30, 6) }
mate shaft = revolute(axis(cam, at: (0, 0, 10), dir: +Z), axis(frame, at: (0, 0, 10), dir: +Z))
mate guide = ${follower}
mate lift = cam(shaft, guide, lift: ${lift})
`;
    const m = evaluate(src("slider(axis(rod, at: (0, 30, 10), dir: +Y), axis(frame, at: (0, 30, 10), dir: +Y))", "[0, 5, 10, 5]"));
    expect(errors(m)).toEqual([]);
    let d = turnBy(m, startMateDrag(m, "cam", [15, 0, 10]), [0, 0, 10], 15, 0, 180, 15);
    expect(at(d, "rod", [0, 30, 10])[1]).toBeCloseTo(40, 3);
    d = turnBy(m, d, [0, 0, 10], 15, 180, 270, 15);
    expect(at(d, "rod", [0, 30, 10])[1]).toBeCloseTo(35, 3);
    // a rocker follower swings by degrees
    const rocker = evaluate(src("revolute(axis(rod, at: (0, 45, 10), dir: +Z), axis(frame, at: (0, 45, 10), dir: +Z))", "[0, 10, 20, 10]"));
    expect(errors(rocker)).toEqual([]);
    d = turnBy(rocker, startMateDrag(rocker, "cam", [15, 0, 10]), [0, 0, 10], 15, 0, 180, 15);
    expect(turnZ(d.moves.get("rod"))).toBeCloseTo(20, 2);
  });
});

describe("slots and stops", () => {
  it("keeps a pin in its slot, between the ends", () => {
    const m = evaluate(`design "slot"
part plate { body box(80, 30, 4) }
part pin { at: (-10, 0, 10) body cylinder(d: 5, h: 10) }
mate seat = planar(plane(pin, at: (-10, 0, 4), normal: -Z), plane(plate, at: (0, 0, 4), normal: +Z))
mate run = slot(axis(pin, at: (-10, 0, 4), dir: +Z), segment(plate, from: (-20, 0, 4), to: (20, 0, 4)))
`);
    expect(errors(m)).toEqual([]);
    // on the plate it slides along the slot and turns about its own axis
    expect(m.mates?.free.find((f) => f.body === "pin")?.dof).toBe(2);
    let d = startMateDrag(m, "pin", [-10, 0, 4]);
    for (const x of [0, 10, 20, 30]) d = mateDragTo(m, d, [x, 6, 4]);
    // it stops at the slot's end, on its middle line
    const p = at(d, "pin", [-10, 0, 4]);
    expect(p[0]).toBeCloseTo(20, 3);
    expect(p[1]).toBeCloseTo(0, 3);
    const sol = solveMates(m.mates!.bodies, m.mates!.specs, { start: d.moves, drag: { body: "pin", point: [-10, 0, 4], target: [40, 0, 4] } });
    expect(sol.outcomes.find((o) => o.name === "run")?.status).toBe("limit");
  });

  it("stops a hinge and a slide at their limits, measured from where they are drawn", () => {
    const m = evaluate(`design "stops"
part base { body box(60, 40, 10) }
part lid { at: (0, 0, 10) body box(60, 40, 4) }
part tray { at: (0, 0, -20) body box(40, 30, 6) }
mate hinge = revolute(axis(lid, at: (0, 20, 10), dir: -X), axis(base, at: (0, 20, 10), dir: -X), min: 0, max: 100)
mate runner = slider(axis(tray, at: (0, 0, -20), dir: -Y), axis(base, at: (0, 0, -20), dir: -Y), min: 0, max: 25)
`);
    expect(errors(m)).toEqual([]);
    // the lid's front edge swings up and over the hinge (forward about −X): it stops at 100°
    let d = startMateDrag(m, "lid", [0, -20, 14]);
    const r = Math.hypot(40, 4);
    for (const a of [20, 50, 80, 110, 140, 170]) {
      const t = Math.atan2(4, -40) - a * deg;
      d = mateDragTo(m, d, [0, 20 + r * Math.cos(t), 10 + r * Math.sin(t)]);
    }
    expect(d.coords.get("hinge")! / deg).toBeCloseTo(100, 1);
    const sol = solveMates(m.mates!.bodies, m.mates!.specs, { start: d.moves, coords: d.coords, drag: { body: "lid", point: [0, -20, 14], target: [0, 60, 10] } });
    expect(sol.outcomes.find((o) => o.name === "hinge")?.status).toBe("limit");
    // and back down it stops at 0, where it is drawn
    for (const a of [60, 20, -20, -50]) {
      const t = Math.atan2(4, -40) - a * deg;
      d = mateDragTo(m, d, [0, 20 + r * Math.cos(t), 10 + r * Math.sin(t)]);
    }
    expect(d.coords.get("hinge")! / deg).toBeCloseTo(0, 1);
    // the tray slides out 25 mm and no further
    let t = startMateDrag(m, "tray", [0, 0, -20]);
    for (const y of [-10, -20, -30, -40]) t = mateDragTo(m, t, [0, y, -20]);
    expect(at(t, "tray", [0, 0, -20])[1]).toBeCloseTo(-25, 3);
    for (const y of [-10, 0, 10]) t = mateDragTo(m, t, [0, y, -20]);
    expect(at(t, "tray", [0, 0, -20])[1]).toBeCloseTo(0, 3);
  });
});

describe("what a relation needs", () => {
  const base = `design "e"
part frame { body box(100, 60, 4) }
part a { at: (0, 0, 10) body cylinder(d: 20, h: 4) }
part b { at: (30, 0, 10) body box(20, 6, 4) }
mate ta = revolute(axis(a, at: (0, 0, 10), dir: +Z), axis(frame, at: (0, 0, 10), dir: +Z))
mate sb = slider(axis(b, at: (30, 0, 10), dir: +X), axis(frame, at: (30, 0, 10), dir: +X))
`;
  it("says what is wrong", () => {
    expect(errors(evaluate(base + "mate gear(ta, sb, ratio: 2)\n"))[0]).toMatch(/second mate should be a turning joint .*sb is a slider\(\)/);
    expect(errors(evaluate(base + "mate gear(ta, nothing, ratio: 2)\n"))[0]).toMatch(/"nothing" is not defined|no mate called "nothing"/);
    expect(errors(evaluate(base + 'mate gear(ta, "nope", ratio: 2)\n'))[0]).toMatch(/no mate called "nope"/);
    expect(errors(evaluate(base + "mate gear(ta, sb)\n"))[0]).toMatch(/give one of ratio:/);
    expect(errors(evaluate(base + "mate rack(sb, ta, d: 20)\n"))[0]).toMatch(/first mate should be a turning joint/);
    expect(errors(evaluate(base + "mate cam(ta, sb, lift: 3)\n"))[0]).toMatch(/lift: should be a list/);
    expect(errors(evaluate(base + "mate screw(ta, lead: 2)\n"))[0]).toMatch(/on one mate it should be a cylindrical/);
    expect(errors(evaluate(base + "mate slot(axis(b, at: (30, 0, 10), dir: +Z), axis(frame, at: (0, 0, 4), dir: +X))\n"))[0]).toMatch(/slot's middle line/);
    expect(errors(evaluate(base + "mate rack(ta, sb, d: 20)\n"))).toEqual([]);
  });
});
