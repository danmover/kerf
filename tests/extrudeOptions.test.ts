// Extrude options: a taper (draft) on straight, round and curved sides, thin walls, up to the next face, from a
// profile and from a sketch; and draft() on round faces.

import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { initKernel } from "./helpers/kernel";
import { buildPart } from "../src/kernel/build";
import { evaluate } from "../src/lang/evaluator";
import { extrudeExpr } from "../src/sketch/edits";

beforeAll(initKernel, 60_000);

const T5 = Math.tan((5 * Math.PI) / 180);
const frustum = (r1: number, r2: number, h: number) => (Math.PI * h * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;

function parts(body: string) {
  const m = evaluate(`design "t"\n${body}\n`);
  return { m, errors: m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) };
}

/** Each part's solid, with its volume and bounds. */
function built(body: string) {
  const { m, errors } = parts(body);
  expect(errors).toEqual([]);
  return Object.fromEntries(
    m.parts.map((p) => {
      const s = buildPart(p.recipe);
      const [lo, hi] = s.boundingBox.bounds;
      return [p.name, { v: R.measureVolume(s), lo, hi }];
    }),
  );
}

describe("extrude taper", () => {
  it("leans straight, round and curved sides in by the angle, and opens holes up", () => {
    const b = built(`
part cone { body extrude(circle(20), 10, taper: 5) }
part block { body extrude(rect(20, 20), 10, taper: 5) }
part annulus { body extrude(ring(20, 8), 10, taper: 5) }
part oval { body extrude(ellipse(24, 12), 10, taper: 5) }
part plate { body extrude(rect(30, 30) - circle(8), 10, taper: 5) }
part flare { body extrude(circle(20), 10, taper: -5) }
part down { body extrude(circle(20), 10, taper: 5, dir: -Z) }
`);
    const t = 10 * T5;
    expect(b.cone.v).toBeCloseTo(frustum(10, 10 - t, 10), 1);
    const a1 = 400;
    const a2 = (20 - 2 * t) ** 2;
    expect(b.block.v).toBeCloseTo((10 / 3) * (a1 + a2 + Math.sqrt(a1 * a2)), 1);
    expect(b.annulus.v).toBeCloseTo(frustum(10, 10 - t, 10) - frustum(4, 4 + t, 10), 1);
    expect(b.plate.v).toBeCloseTo((10 / 3) * (900 + (30 - 2 * t) ** 2 + Math.sqrt(900 * (30 - 2 * t) ** 2)) - frustum(4, 4 + t, 10), 0);
    expect(b.flare.v).toBeCloseTo(frustum(10, 10 + t, 10), 1);
    // an ellipse can't be tilted by the kernel's draft, so it is skinned to its offset: between the straight and the scaled ellipse
    const straight = Math.PI * 12 * 6 * 10;
    expect(b.oval.v).toBeLessThan(straight);
    expect(b.oval.v).toBeGreaterThan(straight * ((12 - t) / 12) * ((6 - t) / 6));
    expect(b.oval.hi[0]).toBeCloseTo(12, 2);
    // the profile keeps its size where it starts, whichever way it runs
    expect(b.down.v).toBeCloseTo(frustum(10, 10 - t, 10), 1);
    expect(b.down.hi[2]).toBeCloseTo(0, 3);
    expect(b.down.hi[0]).toBeCloseTo(10, 3);
  });

  it("tapers both ways from the middle with symmetric, and from a sketch", () => {
    const b = built(`
part mid { body extrude(circle(20), 20, taper: 5, symmetric: true) }
sketch sq {
  line l1 = (-10, -10) -> (10, -10)
  line l2 = l1.end -> (10, 10)
  line l3 = l2.end -> (-10, 10)
  line l4 = l3.end -> l1.start
}
part boss { body extrude(sq, 10, taper: 5) }
part under { body extrude(sq, 10, taper: 5, reverse: true) }
`);
    const t = 10 * T5;
    expect(b.mid.v).toBeCloseTo(2 * frustum(10, 10 - t, 10), 1);
    expect(b.mid.lo[2]).toBeCloseTo(-10, 3);
    const a2 = (20 - 2 * t) ** 2;
    const pyramid = (10 / 3) * (400 + a2 + Math.sqrt(400 * a2));
    expect(b.boss.v).toBeCloseTo(pyramid, 1);
    expect(b.under.v).toBeCloseTo(pyramid, 1);
    expect(b.under.hi[2]).toBeCloseTo(0, 3);
    expect(b.under.hi[0]).toBeCloseTo(10, 3);
  });

  it("says why when the taper closes the profile up, or is mixed with twist", () => {
    const m = parts(`part p { body extrude(circle(4), 50, taper: 10) }`).m;
    expect(() => buildPart(m.parts[0].recipe)).toThrow(/closes up/);
    expect(parts(`part p { body extrude(circle(4), 5, taper: 5, twist: 10) }`).errors.join()).toMatch(/twist or scale/);
    expect(parts(`part p { body extrude(circle(4), 5, taper: 85) }`).errors.join()).toMatch(/between -80 and 80/);
  });
});

describe("thin walls", () => {
  it("keeps only a wall along the outline, inside, outside or centred on it", () => {
    const b = built(`
part tube { body extrude(circle(20), 10, thin: 2) }
part outer { body extrude(circle(20), 10, thin: 2, thin_side: "outside") }
part centred { body extrude(circle(20), 10, thin: 2, thin_side: "center") }
sketch box_sk {
  line l1 = (0, 0) -> (40, 0)
  line l2 = l1.end -> (40, 20)
  line l3 = l2.end -> (0, 20)
  line l4 = l3.end -> l1.start
}
part frame { body extrude(box_sk, 5, thin: 2) }
`);
    expect(b.tube.v).toBeCloseTo(Math.PI * (100 - 64) * 10, 1);
    expect(b.tube.hi[0]).toBeCloseTo(10, 3);
    expect(b.outer.v).toBeCloseTo(Math.PI * (144 - 100) * 10, 1);
    expect(b.centred.v).toBeCloseTo(Math.PI * (121 - 81) * 10, 1);
    expect(b.frame.v).toBeCloseTo((800 - 36 * 16) * 5, 1);
    expect(parts(`part p { body extrude(circle(4), 5, thin_side: "inside") }`).errors.join()).toMatch(/thin_side goes with thin/);
  });
});

describe("up to the next face", () => {
  it("grows a boss until it meets the part, and cuts through the first wall only", () => {
    const b = built(`
part bridge {
  body box(60, 20, 4)
  add box(4, 20, 26, at: (28, 0, 4))
  add extrude(circle(8), at: (0, 0, 10), dir: X, until: "next")
}
part pocket {
  body box(40, 40, 30)
  cut box(30, 30, 10, at: (0, 0, 10))
  cut extrude(circle(10), at: (0, 0, 30), dir: -Z, until: "next")
}
sketch wall_sk {
  plane: plane(origin: (0, 0, 10), normal: X)
  circle c = (0, 0), d: 6
}
part sk_boss {
  body box(60, 20, 4)
  add box(4, 20, 26, at: (28, 0, 4))
  add extrude(wall_sk, until: "next")
}
`);
    const frame = 60 * 20 * 4 + 4 * 20 * 26;
    // the boss runs from x = 0 to the wall at x = 26
    expect(b.bridge.v).toBeCloseTo(frame + Math.PI * 16 * 26, 0);
    // the cut goes through the 10 mm lid into the cavity and stops: the floor under the cavity is untouched
    expect(b.pocket.v).toBeCloseTo(40 * 40 * 30 - 30 * 30 * 10 - Math.PI * 25 * 10, 0);
    expect(b.sk_boss.v).toBeCloseTo(frame + Math.PI * 9 * 26, 0);
  });

  it("says why when nothing is in the way, or it starts inside", () => {
    const run = (body: string) => {
      const { m, errors } = parts(body);
      expect(errors).toEqual([]);
      return () => buildPart(m.parts[0].recipe);
    };
    expect(run(`part p {\n  body box(60, 20, 4)\n  add box(4, 20, 26, at: (28, 0, 4))\n  add extrude(circle(5), at: (0, 0, 40), dir: X, until: "next")\n}`)).toThrow(/run on past the part/);
    expect(run(`part p {\n  body box(20, 20, 4)\n  add extrude(circle(5), at: (0, 0, 4), until: "next")\n}`)).toThrow(/nothing ahead/);
    expect(run(`part p {\n  body box(20, 20, 4)\n  add extrude(circle(5), at: (0, 0, 10), dir: -Z, until: "next")\n}`)).not.toThrow();
    expect(run(`part p {\n  body box(20, 20, 4)\n  add extrude(circle(5), at: (0, 0, 20), until: "next")\n}`)).toThrow(/nothing ahead/);
    expect(parts(`part p {\n  body box(20, 20, 4)\n  add extrude(circle(5), 3, until: "next")\n}`).errors.join()).toMatch(/not both/);
  });
});

describe("draft()", () => {
  it("drafts round faces too", () => {
    const b = built(`part peg {\n  body cylinder(20, 10)\n  draft(5, faces: "vertical", pull: Z)\n}`);
    expect(b.peg.v).toBeCloseTo(frustum(10, 10 - 10 * T5, 10), 1);
  });
});

describe("the sketch feature panel's code", () => {
  it("writes the ends, taper and thin wall it was given", () => {
    expect(extrudeExpr("s", { kind: "extrude", op: "add", until: "next", reverse: true, taper: 3 }, "10")).toBe('extrude(s, until: "next", reverse: true, taper: 3)');
    expect(extrudeExpr("s", { kind: "extrude", op: "new", depth: 10, symmetric: true, thin: 2, thinSide: "outside" }, "s_depth")).toBe('extrude(s, s_depth, symmetric: true, thin: 2, thin_side: "outside")');
    expect(extrudeExpr("s", { kind: "extrude", op: "cut", through: true, taper: 3, thin: 1.5, thinSide: "inside" }, "10")).toBe("extrude(s, through: true, thin: 1.5)");
  });
});
