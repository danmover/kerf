// O-rings that seal (lib.oring): Kerf measures the gland a ring is drawn in on
// the parts round it, then checks the squeeze, the stretch and how full the
// gland is against Apple Rubber's Seal Design Guide. A piston seal, a rod seal
// and a face seal under a lid, and what goes wrong with each.

import { describe, expect, it } from "vitest";
import { fullCheck, type FullCheck } from "./helpers/fullcheck";
import type { CheckItem } from "../src/core/checks";
import { oringFit, type Gland } from "../src/core/oringChecks";
import type { OringInfo } from "../src/core/model";

const SLOW = 60000;
const noErrors = (r: FullCheck) => expect(r.model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
const find = (items: CheckItem[], id: string) => {
  const f = items.find((i) => i.id === id);
  if (!f) throw new Error(`no ${id} in ${items.map((i) => i.id).filter((i) => /oring|^int:/.test(i)).join(", ")}`);
  return f;
};
const rings = (r: FullCheck) => Object.fromEntries(r.report.items.filter((i) => i.id.startsWith("oring:")).map((i) => [i.id.split(":")[1], i.status]));
const errorOf = async (src: string) => (await fullCheck(src)).model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("\n");

// a 29.8 mm piston in a 30 mm bore, with a groove for a 2.62 mm cord
const piston = (o: { groove?: string; ring?: string; more?: string; piston?: string } = {}) => `
design "piston seal"
part barrel { body tube(40, 30, 60)  held: "clamped in its bracket"  material: "Aluminum 6061" }
part piston { body cylinder(29.8, 20, at: (0, 0, 20))  cut ${o.groove ?? 'oring_groove(29.8, cs: 2.62, at: (0, 0, 30), type: "rod", squeeze: 0.2)'}  ${o.piston ?? "slides: Z  travel: 15"}  held: "its connecting rod"  material: "Aluminum 6061" }
component seal = lib.oring(${o.ring ?? '"NBR", id: 25, cs: 2.62'}) { at: (0, 0, 30), axis: Z  ${o.more ?? "rides: piston"} }
`;
// a 20 mm rod through a gland with the groove in its bore
const rod = (ring = '"NBR", id: 20, cs: 2.62') => `
design "rod seal"
part gland { body tube(40, 20.2, 30)  cut oring_groove(20.2, cs: 2.62, at: (0, 0, 15), type: "bore", squeeze: 0.18)  held: "screwed into the cylinder head"  material: "Aluminum 6061" }
part rod { body cylinder(20, 80, at: (0, 0, -20))  slides: Z  travel: 20  held: "the piston it is screwed to"  material: "Steel" }
component seal = lib.oring(${ring}) { at: (0, 0, 15), axis: Z }
`;
// a pot with a groove in its top face, and a lid on it
const lid = (o: { ring?: string; groove?: string; z?: number } = {}) => `
design "lid seal"
part pot { body cylinder(80, 30)  cut cylinder(40, 25, at: (0, 0, 5))  cut ${o.groove ?? 'oring_groove(56, cs: 3, at: (0, 0, 30), type: "face")'}  held: "stands on the bench"  material: "Aluminum 6061" }
part lid { body cylinder(80, 6, at: (0, 0, 30))  held: "clamped down by its ring"  material: "Aluminum 6061" }
component seal = lib.oring(${o.ring ?? '"EPDM", id: 54, cs: 3, pressure: "inside"'}) { at: (0, 0, ${o.z ?? 28.875}), axis: Z }
`;

describe("what a gland does to its ring", () => {
  const ring: OringInfo = { rubber: "nitrile (NBR)", material: "Nitrile", shore: 70, id: 25, cs: 2.62, temp: [-30, 100], center: [0, 0, 0], axis: [0, 0, 1] };
  const gland = (g: Partial<Gland>): Gland => ({ kind: "radial", a: 12.8, b: 15, lo: -1.8, hi: 1.8, groove: "inner", depth: 2.1, ...g });
  it("stretch thins the cord, and the squeeze is what is left of it", () => {
    const f = oringFit(ring, gland({}))!;
    expect(f.stretch).toBeCloseTo(25.6 / 25 - 1, 9);
    // the middle of the cord goes from 27.62 mm across to 27.8, and the cord keeps its volume
    expect(f.thick).toBeCloseTo(2.62 / Math.sqrt(27.8 / 27.62), 9);
    expect(f.squeeze).toBeCloseTo(1 - 2.2 / f.thick, 9);
    expect(f.fill).toBeCloseTo(((Math.PI / 4) * f.thick ** 2) / (3.6 * 2.2), 9);
    expect(f.open).toBeCloseTo(0.1, 9);
    expect(f.bunch).toBe(0);
  });
  it("a ring pressed into a bore gets thicker and has less room to lie in", () => {
    const f = oringFit({ ...ring, id: 26 }, gland({ a: 10, b: 12.25, groove: "outer" }))!;
    expect(f.stretch).toBeLessThan(0);
    expect(f.bunch).toBeCloseTo(1 - 22.25 / 28.62, 9);
    expect(f.thick).toBeGreaterThan(2.62);
  });
  it("a face seal lies free between its groove's walls unless one is in its way", () => {
    const face = gland({ kind: "face", a: 25.9, b: 30.1, lo: -1.125, hi: 1.125, groove: "lower", depth: 2.25 });
    const free = oringFit({ ...ring, id: 54, cs: 3 }, face)!;
    expect(free.thick).toBe(3);
    expect(free.squeeze).toBeCloseTo(0.25, 9);
    expect(free.width).toBeCloseTo(4.2, 9);
    // too small a ring has to stretch over the inner wall
    const tight = oringFit({ ...ring, id: 50, cs: 3 }, face)!;
    expect(tight.stretch).toBeCloseTo(51.8 / 50 - 1, 9);
    expect(tight.thick).toBeLessThan(3);
  });
  it("is nothing without a gland", () => {
    expect(oringFit(ring, gland({ kind: "loose" }))).toBeNull();
    expect(oringFit(ring, gland({ kind: "none" }))).toBeNull();
  });
});

describe("a piston seal", () => {
  it(
    "is measured in its groove: squeeze, stretch and fill",
    async () => {
      const r = await fullCheck(piston());
      noErrors(r);
      expect(rings(r)).toEqual({ gland: "pass", squeeze: "pass", stretch: "pass", fill: "pass" });
      const g = find(r.report.items, "oring:gland:seal");
      expect(g.title).toBe("seal sits in a groove in piston and seals against barrel");
      // oring_groove(29.8, cs: 2.62, squeeze: 0.2): 1.4 cords wide, 0.8 of a cord deep, under a 30 mm bore
      expect(g.detail).toMatch(/^The groove is 3\.67 mm wide and 2\.1 mm deep; from its bottom to barrel is 2\.2 mm, for a cord of 2\.62 mm\. 0\.1 mm is left between piston and barrel beside the groove/);
      const s = find(r.report.items, "oring:squeeze:seal");
      expect(s.title).toBe("seal is squeezed 16 %");
      expect(s.detail).toMatch(/Its cord is 2\.61 mm where it sits \(2\.62 mm as bought, thinner once the ring is stretched\) and has 2\.2 mm\. Apple Rubber's Seal Design Guide gives 10 to 40 % for a seal that stays still and 10 to 30 % for one that moves; piston slides against barrel, so this one moves\.$/);
      const st = find(r.report.items, "oring:stretch:seal");
      expect(st.title).toBe("seal is stretched 2.4 % to go on");
      expect(st.detail).toMatch(/^Its inside diameter goes from 25 mm to Ø25\.61\./);
      expect(find(r.report.items, "oring:fill:seal").title).toBe("seal fills 66 % of its gland");
      // drawn at its own size it overlaps both sides: that is its squeeze
      expect(find(r.report.items, "int:piston|seal").status).toBe("pass");
      expect(find(r.report.items, "int:barrel|seal").title).toBe("seal is squeezed by barrel");
      // the piston is guided by its bore, not fastened by it, and the ring is held by its gland
      expect(r.report.items.filter((i) => i.id.startsWith("motion:fastened"))).toEqual([]);
      expect(r.report.items.filter((i) => i.status === "fail").map((i) => i.id)).toEqual([]);
      const part = r.model.parts.find((p) => p.name === "seal")!;
      expect(part.oring).toMatchObject({ id: 25, cs: 2.62, shore: 70, material: "Nitrile", center: [0, 0, 30], axis: [0, 0, 1] });
    },
    SLOW,
  );

  it(
    "must ride on a piston that moves",
    async () => {
      const r = await fullCheck(piston({ more: "" }));
      const w = find(r.report.items, "oring:rides:seal");
      expect(w.status).toBe("warn");
      expect(w.title).toBe("seal stays behind when piston moves");
      expect(w.fix).toBe("Add rides: piston to seal.");
    },
    SLOW,
  );

  it(
    "fails with too little squeeze, and with too much for a seal that moves",
    async () => {
      const slack = find((await fullCheck(piston({ groove: 'oring_groove(29.8, cs: 2.62, at: (0, 0, 30), type: "rod", squeeze: 0.06)' }))).report.items, "oring:squeeze:seal");
      expect(slack.status).toBe("fail");
      expect(slack.title).toMatch(/^seal is squeezed only \d %$/);
      expect(slack.fix).toMatch(/^Make the bottom of the groove Ø25\.\d+ \(now Ø24\.87\), which squeezes it 20 %\.$/);
      const hard = 'oring_groove(29.8, cs: 2.62, at: (0, 0, 30), type: "rod", squeeze: 0.38)';
      const tight = find((await fullCheck(piston({ groove: hard, ring: '"NBR", id: 26, cs: 2.62' }))).report.items, "oring:squeeze:seal");
      expect(tight.status).toBe("fail");
      expect(tight.title).toMatch(/^seal is squeezed 3\d %, more than a seal that moves takes$/);
      // the same gland on a seal that stays still is inside its 40 %
      const still = find((await fullCheck(piston({ groove: hard, ring: '"NBR", id: 26, cs: 2.62, duty: "static"' }))).report.items, "oring:squeeze:seal");
      expect(still.status).toBe("pass");
      expect(still.detail).toMatch(/the design says this one stays still\.$/);
    },
    SLOW,
  );

  it(
    "fails when the ring has to stretch more than 5 % to go on",
    async () => {
      const st = find((await fullCheck(piston({ ring: '"NBR", id: 23, cs: 2.62' }))).report.items, "oring:stretch:seal");
      expect(st.status).toBe("fail");
      expect(st.title).toBe("seal is stretched 11.3 % to go on");
      expect(st.fix).toBe("Use a ring of about 25.1 mm inside diameter (2 % stretch).");
    },
    SLOW,
  );

  it(
    "warns when the ring nearly fills its groove and fails when it cannot fit",
    async () => {
      const cut = (w: number) => `tube(31, 25.608, ${w}, at: (0, 0, ${30 - w / 2}))`;
      const near = find((await fullCheck(piston({ groove: cut(2.6) }))).report.items, "oring:fill:seal");
      expect(near.status).toBe("warn");
      expect(near.title).toMatch(/^seal nearly fills its gland \(9\d %\)$/);
      expect(near.fix).toMatch(/^Make the groove 3\.\d mm wide \(now 2\.6\), which leaves it 75 % full\.$/);
      const over = find((await fullCheck(piston({ groove: cut(2.3) }))).report.items, "oring:fill:seal");
      expect(over.status).toBe("fail");
      expect(over.title).toBe("seal does not fit its gland");
    },
    SLOW,
  );

  it(
    "fails when nothing squeezes the ring, and when it is not in a gland at all",
    async () => {
      // a groove deeper than the cord is thick
      const deep = await fullCheck(piston({ groove: "tube(31, 24, 3.6, at: (0, 0, 28.2))" }));
      const g = find(deep.report.items, "oring:gland:seal");
      expect(g.status).toBe("fail");
      expect(g.title).toBe("Nothing squeezes seal");
      expect(g.detail).toMatch(/^Where seal is drawn there is 3 mm across the ring \(between piston and barrel\) and 3\.6 mm along its axis, and its cord is 2\.62 mm/);
      expect(rings(deep)).toEqual({ gland: "fail" });
      // out in the open
      const out = await fullCheck(piston({ more: "", ring: '"NBR", id: 60, cs: 2.62' }).replace("at: (0, 0, 30), axis: Z", "at: (0, 0, 90), axis: Z"));
      expect(find(out.report.items, "oring:gland:seal").title).toMatch(/^(seal is not in a gland|Nothing squeezes seal)$/);
    },
    SLOW,
  );

  it(
    "warns about stretch over a shaft that turns",
    async () => {
      const r = await fullCheck(piston({ piston: "spin: 1", more: "turns_with: piston" }));
      const st = find(r.report.items, "oring:stretch:seal");
      expect(st.status).toBe("warn");
      expect(st.title).toBe("seal is stretched over a turning shaft");
      expect(st.detail).toMatch(/Apple Rubber's guide: a seal on a turning shaft should be designed with no stretch over the shaft\.$/);
    },
    SLOW,
  );
});

describe("a rod seal", () => {
  it(
    "sits in a groove in the bore and seals against the rod that slides through",
    async () => {
      const r = await fullCheck(rod());
      noErrors(r);
      expect(rings(r)).toEqual({ gland: "pass", squeeze: "pass", stretch: "pass", fill: "pass" });
      const g = find(r.report.items, "oring:gland:seal");
      expect(g.title).toBe("seal sits in a groove in gland and seals against rod");
      // the meshes cut the corners of the 20.2 mm bore; the depth still comes out exact
      expect(g.detail).toMatch(/^The groove is 3\.67 mm wide and 2\.15 mm deep; from its bottom to rod is 2\.25 mm, for a cord of 2\.62 mm\. 0\.1 mm is left between rod and gland beside the groove/);
      expect(find(r.report.items, "oring:squeeze:seal").detail).toMatch(/thicker once the ring is pressed in.*rod slides against gland, so this one moves\.$/);
      expect(find(r.report.items, "oring:stretch:seal").title).toBe("seal goes in without stretching");
      // the rod is guided by the gland: neither is carried by the other
      expect(r.report.items.filter((i) => i.id.startsWith("motion:fastened") || i.id.startsWith("oring:rides"))).toEqual([]);
    },
    SLOW,
  );

  it(
    "warns about a ring too big for where it sits",
    async () => {
      const st = find((await fullCheck(rod('"NBR", id: 22.5, cs: 2.62'))).report.items, "oring:stretch:seal");
      expect(st.status).toBe("warn");
      expect(st.title).toBe("seal is too big for where it sits");
      expect(st.detail).toMatch(/Kerf's own rule: past 5 % a ring has to bunch up to go in/);
      expect(st.fix).toBe("Use a ring of about 20 mm inside diameter.");
    },
    SLOW,
  );
});

describe("a face seal under a lid", () => {
  it(
    "is squeezed between the groove's floor and the lid, and seated against the low-pressure wall",
    async () => {
      const r = await fullCheck(lid());
      noErrors(r);
      expect(rings(r)).toEqual({ gland: "pass", squeeze: "pass", stretch: "pass", fill: "pass", seat: "pass" });
      expect(find(r.report.items, "oring:gland:seal").title).toBe("seal sits in a groove in pot and seals against lid");
      expect(find(r.report.items, "oring:gland:seal").detail).toMatch(/^The groove is 4\.2 mm wide and 2\.25 mm deep; from its bottom to lid is 2\.25 mm, for a cord of 3 mm\. Measured/);
      const s = find(r.report.items, "oring:squeeze:seal");
      expect(s.title).toBe("seal is squeezed 25 %");
      expect(s.detail).toMatch(/pot and lid do not move against each other, so this one stays still\.$/);
      expect(find(r.report.items, "oring:fill:seal").title).toBe("seal fills 75 % of its gland");
      expect(find(r.report.items, "oring:seat:seal").detail).toMatch(/^The pressure is on the inside, and seal lies against the groove's outer wall\./);
      expect(r.report.items.filter((i) => i.status === "fail").map((i) => i.id)).toEqual([]);
    },
    SLOW,
  );

  it(
    "warns when pressure has to push the ring across its groove first",
    async () => {
      const w = find((await fullCheck(lid({ ring: '"EPDM", id: 52, cs: 3, pressure: "inside"' }))).report.items, "oring:seat:seal");
      expect(w.status).toBe("warn");
      expect(w.detail).toMatch(/the ring lies 1\.1 mm short of the groove's outer wall/);
      expect(w.fix).toMatch(/^Use a ring of about 54\.2 mm inside diameter/);
      // the same ring is right for pressure from outside: it lies against the inner wall
      const ok = find((await fullCheck(lid({ ring: '"EPDM", id: 52, cs: 3, pressure: "outside"' }))).report.items, "oring:seat:seal");
      expect(ok.status).toBe("pass");
    },
    SLOW,
  );

  it(
    "fails when the groove is so shallow the ring is crushed",
    async () => {
      const r = await fullCheck(lid({ groove: "tube(60.2, 51.8, 1.6, at: (0, 0, 28.4))", z: 29.2 }));
      const s = find(r.report.items, "oring:squeeze:seal");
      expect(s.status).toBe("fail");
      expect(s.title).toBe("seal is squeezed 47 %, more than a seal that stays still takes");
      expect(s.fix).toBe("Make the groove 2.25 mm deep (now 1.6), which squeezes it 25 %.");
      expect(find(r.report.items, "oring:fill:seal").status).toBe("fail");
    },
    SLOW,
  );
});

describe("lib.oring", () => {
  it(
    "says what it cannot be",
    async () => {
      expect(await errorOf(piston({ ring: '"leather", id: 25, cs: 2.62' }))).toMatch(/lib\.oring: rubber must be "NBR", "EPDM" or "silicone" \(got "leather"\)/);
      expect(await errorOf(piston({ ring: '"NBR", id: 4, cs: 2.62' }))).toMatch(/id \(the ring's inside diameter\) must be at least twice the cord/);
      expect(await errorOf(piston({ ring: '"NBR", id: 25, cs: 2.62, duty: "sometimes"' }))).toMatch(/duty must be "static" or "moving"/);
      expect(await errorOf(lid({ ring: '"EPDM", id: 54, cs: 3, pressure: "up"' }))).toMatch(/pressure must be "inside" or "outside"/);
    },
    SLOW,
  );
});
