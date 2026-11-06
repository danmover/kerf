// The building blocks, built with the real kernel: each makes one solid, mating
// pieces placed on the same numbers fit together without touching, and the
// fields a design reads come out right.

import { beforeAll, describe, expect, it } from "vitest";
import { fullCheck, problems } from "./helpers/fullcheck";
import { evaluate } from "../src/lang/evaluator";
import { initKernel } from "./helpers/kernel";

beforeAll(() => initKernel(), 60_000);

/** Fails, build errors and pieces, by part. */
async function built(src: string) {
  const r = await fullCheck(src);
  const diags = r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  // the test designs are not fastened together; whether a part is held up is not the blocks' business
  const fails = problems({ ...r.report, items: r.report.items.filter((i) => !i.id.startsWith("held:")) }, ["fail"]);
  const vol = (name: string) => r.core.get(r.model.parts.find((p) => p.name === name)!.hash)!.volume;
  return { ...r, diags, fails, vol };
}

const PLA = 'material: "PLA"\n  process: mfg.fdm()';

describe("building blocks", () => {
  it("hinge: two leaves on the same axis turn past each other, each one piece", async () => {
    const r = await built(`design "Hinge"
part leaf_a {
  ${PLA}
  body box(40, 21, 3, at: (0, -14.5, 0))
  add hinge(at: (0, 0, 3.5), axis: X, length: 40, side: "outer", toward: -Y)
}
part leaf_b {
  ${PLA}
  body box(40, 21, 3, at: (0, 14.5, 0))
  add hinge(at: (0, 0, 3.5), axis: X, length: 40, side: "inner", toward: Y)
}
`);
    expect(r.diags).toEqual([]);
    expect(r.buildErrors.size).toBe(0);
    expect(r.fails).toEqual([]);
    expect(r.report.items.filter((i) => /piece/i.test(i.title))).toEqual([]);
  }, 120_000);

  it("lid lip and vents: the lip slides into the box's opening and the slots go through the lid", async () => {
    const r = await built(`design "Box"
part tray {
  ${PLA}
  body box(60, 40, 20, r: 4)
  shell(2, open: Z)
}
part lid {
  ${PLA}
  removable
  body box(60, 40, 2, at: (0, 0, 20), r: 4)
  add lid_lip(w: 56, d: 36, r: 2, at: (0, 0, 20))
  add vents(at: (0, 0, 22), size: (30, 20), depth: 2.2)
}
`);
    expect(r.diags).toEqual([]);
    expect(r.fails).toEqual([]);
    // the plate, a 1.6 mm ring 4 mm deep round 55.6 × 35.6, less eight 2 × 20 slots through the plate
    const rounded = (w: number, d: number, r: number) => w * d - (4 - Math.PI) * r * r;
    const plate = 2 * rounded(60, 40, 4);
    const ring = 4 * (rounded(55.6, 35.6, 1.8) - rounded(52.4, 32.4, 0.2));
    const slots = 2 * 8 * (2 * 18 + Math.PI);
    expect(Math.abs(r.vol("lid") - (plate + ring - slots))).toBeLessThan(10);
  }, 120_000);

  it("cable clip and tube clamp: one piece each, with their strain and screw", async () => {
    const r = await built(`design "Clips"
part plate {
  ${PLA}
  body box(40, 20, 2)
  add cable_clip(at: (0, 0, 2), d: 5, along: X)
}
part clamp {
  ${PLA}
  body box(8, 10, 10, at: (44, 0, 0))
  add tube_clamp(at: (60, 0, 5), d: 20)
}
let clip = cable_clip(at: (0, 0, 2), d: 5)
let clamp_screw = tube_clamp(at: (0, 0, 0), d: 20).screw_len
`);
    expect(r.diags).toEqual([]);
    expect(r.buildErrors.size).toBe(0);
    expect(r.fails).toEqual([]);
    expect(r.report.items.filter((i) => /piece/i.test(i.title))).toEqual([]);
    // a C round the cable: the ring less its bore, the foot and the mouth
    expect(r.vol("plate")).toBeGreaterThan(40 * 20 * 2 + 200);
  }, 120_000);

  it("dovetail and bayonet: the tail slides in its socket, and the lugs sit in their slots turned home", async () => {
    const src = `design "Joints"
part rail {
  ${PLA}
  body box(40, 30, 5)
  add dovetail(at: (0, 0, 5), along: Y, length: 30)
}
part slider {
  ${PLA}
  body box(40, 30, 6, at: (0, 0, 5))
  add dovetail(at: (0, 0, 5), along: Y, length: 30, side: "socket")
}
part jar {
  ${PLA}
  body cylinder(d: 40, h: 29.5, at: (80, 0, 0))
  add bayonet(at: (80, 0, 20), d: 40, dir: Z, side: "lugs")
}
part cap {
  ${PLA}
  body cylinder(d: 48, h: 12, at: (80, 0, 20))
  cut cylinder(d: 40.6, h: 10, at: (80, 0, 19.9))
  add bayonet(at: (80, 0, 20), d: 40, dir: Z, side: "slots")
}
`;
    const r = await built(src);
    expect(r.diags).toEqual([]);
    expect(r.buildErrors.size).toBe(0);
    expect(r.fails).toEqual([]);
    expect(r.report.items.filter((i) => /piece/i.test(i.title))).toEqual([]);
    // turned the wrong way, the lugs run into the cap's wall
    const off = await built(src.replace('side: "lugs")', 'side: "lugs", start: 60)'));
    expect(off.fails.join("\n")).toMatch(/jar overlaps cap|cap overlaps jar/);
    // the tail stands on the rail; the socket is cut out of the slider
    expect(r.vol("rail")).toBeGreaterThan(40 * 30 * 5 + 30 * 4 * 8);
    expect(r.vol("slider")).toBeLessThan(40 * 30 * 6 - 30 * 4 * 8);
  }, 120_000);

  it("mount holes: a motor's screw holes and pilot through its plate", async () => {
    const r = await built(`design "Motor plate"
component motor = lib.nema17() { at: (0, 0, 0), axis: Z }
part plate {
  ${PLA}
  body box(50, 50, 4)
  add mount_holes(for: motor, depth: 4)
}
`);
    expect(r.diags).toEqual([]);
    expect(r.fails).toEqual([]);
    const holes = 4 * Math.PI * (3.4 / 2) ** 2 * 4 + Math.PI * (22.6 / 2) ** 2 * 4;
    expect(r.vol("plate")).toBeCloseTo(50 * 50 * 4 - holes, -1);
  }, 120_000);

  it("leaves a feature named before the blocks existed (as hinge, as vents) building", () => {
    const m = evaluate(`design "x"\npart p {\n  material: "PETG"\n  body box(30, 20, 3)\n  add flexure(at: (0, 0, 3), length: 20, t: 0.8, w: 6, travel: 1) as hinge\n  fillet(0.4, edges: hinge.root)\n}\n`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("explains a block that cannot work as asked", () => {
    const err = (call: string) => evaluate(`design "x"\npart p {\n  body box(20, 20, 20)\n  add ${call}\n}\n`).diagnostics.find((d) => d.severity === "error")?.message ?? "";
    expect(err("hinge(at: (0, 0, 0), length: 6, knuckles: 5)")).toMatch(/fewer knuckles/);
    expect(err("cable_clip(at: (0, 0, 0), d: 5, mouth: 6)")).toMatch(/narrower than the cable/);
    expect(err("bayonet(at: (0, 0, 0), d: 10, lugs: 6, turn: 40)")).toMatch(/room to turn/);
    expect(err("mount_holes(for: 3)")).toMatch(/placed component/);
  });
});
