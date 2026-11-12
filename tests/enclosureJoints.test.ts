// Where enclosure shells meet: lip_groove() gives one shell a lip and the other the groove it sits in, with a gap
// all round; and vents() in honeycomb and round fan-grille styles.

import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { initKernel } from "./helpers/kernel";
import { buildPart } from "../src/kernel/build";
import { evaluate } from "../src/lang/evaluator";

beforeAll(initKernel, 60_000);

function build(body: string) {
  const m = evaluate(`design "t"\n${body}\n`);
  expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return { m, shapes: Object.fromEntries(m.parts.map((p) => [p.name, buildPart(p.recipe)])) };
}

describe("lip_groove", () => {
  const shells = (style: string, t = 2) => `
part base {
  body box(80, 50, 30)
  cut box(${80 - 2 * t}, ${50 - 2 * t}, 30, at: (0, 0, ${t}))
  add lip_groove(rect(80, 50), wall: ${t}, h: 2, at: (0, 0, 30), side: "lip"${style})
}
part lid {
  body box(80, 50, 10, at: (0, 0, 30))
  cut box(${80 - 2 * t}, ${50 - 2 * t}, ${10 - t}, at: (0, 0, 30))
  add lip_groove(rect(80, 50), wall: ${t}, h: 2, at: (0, 0, 30), side: "groove"${style})
}
part plain_base {
  body box(80, 50, 30)
  cut box(${80 - 2 * t}, ${50 - 2 * t}, 30, at: (0, 0, ${t}))
}
part plain_lid {
  body box(80, 50, 10, at: (0, 0, 30))
  cut box(${80 - 2 * t}, ${50 - 2 * t}, ${10 - t}, at: (0, 0, 30))
}`;

  it("stands a lip on the inner half of the wall and cuts a groove for it in the other shell, with room to spare", () => {
    const { shapes: s } = build(shells(""));
    const v = (k: string) => R.measureVolume(s[k]);
    // lip: from 1.15 to 2 mm in from the outside, 2 mm tall
    expect(v("base") - v("plain_base")).toBeCloseTo((77.7 * 47.7 - 76 * 46) * 2, 0);
    // groove: the wall's inner half (1 to 2 mm in) taken out 2.15 mm deep
    expect(v("plain_lid") - v("lid")).toBeCloseTo((78 * 48 - 76 * 46) * 2.15, 0);
    // closed up, the two shells don't overlap anywhere
    expect(R.measureVolume(s.base.intersect(s.lid))).toBeLessThan(1e-3);
  });

  it("makes a tongue in a channel, and says when the wall is too thin", () => {
    const { shapes: s } = build(shells(', style: "tongue"', 3));
    expect(R.measureVolume(s.base.intersect(s.lid))).toBeLessThan(1e-3);
    // a tongue from 1.15 to 1.85 mm in, in a channel from 1 to 2 mm in
    expect(R.measureVolume(s.base) - R.measureVolume(s.plain_base)).toBeCloseTo((77.7 * 47.7 - 76.3 * 46.3) * 2, 0);
    expect(R.measureVolume(s.plain_lid) - R.measureVolume(s.lid)).toBeCloseTo((78 * 48 - 76 * 46) * 2.15, 0);
    const m = evaluate(`design "t"\npart p {\n  body box(20, 20, 5)\n  add lip_groove(rect(20, 20), wall: 1.2, at: (0, 0, 5), style: "tongue")\n}\n`);
    expect(m.diagnostics.map((d) => d.message).join()).toMatch(/thicker wall/);
  });
});

describe("vents", () => {
  it("cuts a honeycomb and a round fan grille through a plate", () => {
    const { shapes: s } = build(`
part hex_plate {
  body box(60, 60, 2)
  add vents(at: (0, 0, 2), size: (40, 30), slot: 4, pitch: 5.5, depth: 2, style: "hex") as hx
}
part fan_plate {
  body box(60, 60, 2)
  add vents(at: (0, 0, 2), size: 38, slot: 3, pitch: 5, depth: 2, style: "rings", spokes: 4) as fan
}
part plain { body box(60, 60, 2) }
`);
    const plain = R.measureVolume(s.plain);
    const removed = (k: string) => plain - R.measureVolume(s[k]);
    // honeycomb: every hexagon whole and inside the area
    const hex = s.hex_plate.boundingBox.bounds;
    expect(hex[1][2]).toBeCloseTo(2, 3);
    const hexArea = (3 * Math.sqrt(3)) / 2 * (4 / Math.sqrt(3)) ** 2;
    expect(removed("hex_plate") / 2 / hexArea).toBeCloseTo(Math.round(removed("hex_plate") / 2 / hexArea), 2);
    expect(removed("hex_plate")).toBeGreaterThan(0);
    // the fan grille: a centre hole and three rings, crossed by four spokes
    expect(removed("fan_plate")).toBeGreaterThan(0);
    expect(removed("fan_plate")).toBeLessThan((Math.PI * 19 * 19) * 2);
  });
});
