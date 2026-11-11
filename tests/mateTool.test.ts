// The mate tool: picks on two parts written as mate references, the kinds that fit them, and the mate line added.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { addMate, classify, drawnXf, mateChoices, pickedRef } from "../src/core/mateTool";
import { applyXforms, type V3 } from "../src/kernel/recipe";
import type { FaceCatalogue } from "../src/core/mates";
import type { Model } from "../src/core/model";
import { initKernel } from "./helpers/kernel";

const SRC = `design "box"
part base { body box(60, 40, 30) cut hole(d: 5, through: true, at: (20, 0, 30)) }
part lid { at: (0, 100, 50) rotate: (0, 0, 3) body box(60, 40, 4) }
part pin { at: (100, 0, 0) body cylinder(d: 5, h: 30, at: (0, 0, 0)) }
`;

function catalogues(m: Model) {
  const core = new KernelCore();
  for (const p of m.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  const raw = core.faces(m.parts.map((p) => p.hash));
  return new Map(Object.entries(raw).flatMap(([h, c]) => ("error" in c ? [] : [[h, c as FaceCatalogue] as const])));
}
const part = (m: Model, n: string) => m.parts.find((p) => p.name === n)!;
const ref = (m: Model, cats: Map<string, FaceCatalogue>, n: string, kind: "face" | "edge" | "vertex", at: V3) => {
  const r = pickedRef(m, part(m, n), cats, kind, at);
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("the mate tool", () => {
  beforeAll(initKernel, 60_000);

  it("writes picks the way a person would", () => {
    const m = evaluate(SRC);
    const cats = catalogues(m);
    expect(ref(m, cats, "lid", "face", [10, 5, 0]).text).toBe("face(lid, -Z)");
    expect(ref(m, cats, "base", "face", [-10, 5, 30]).text).toBe("face(base, +Z)");
    expect(ref(m, cats, "pin", "face", [2.5, 0, 15]).text).toBe("axis(pin, d: 5)");
    // the hole's wall and its rim are the hole's axis
    expect(ref(m, cats, "base", "face", [22.5, 0, 15]).text).toBe("axis(base, d: 5)");
    expect(ref(m, cats, "base", "edge", [22.5, 0, 30]).text).toBe("axis(base, d: 5)");
    // a corner where the part is drawn
    expect(ref(m, cats, "lid", "vertex", [30, 20, 4]).text).toMatch(/^point\(lid, \(/);
    // a straight edge is none of these
    expect(pickedRef(m, part(m, "lid"), cats, "edge", [0, 20, 4])).toMatch(/Pick a round edge/);
  });

  it("offers the mates that fit, the likeliest first, with distances as they are now", () => {
    const m = evaluate(SRC);
    const cats = catalogues(m);
    const under = ref(m, cats, "lid", "face", [10, 5, 0]).geom;
    const top = ref(m, cats, "base", "face", [-10, 5, 30]).geom;
    const choices = mateChoices(under, top);
    expect(choices[0].kind).toBe("against");
    expect(choices.find((c) => c.kind === "distance")?.arg).toBe("20mm");
    const pin = ref(m, cats, "pin", "face", [2.5, 0, 15]).geom;
    const hole = ref(m, cats, "base", "face", [22.5, 0, 15]).geom;
    expect(mateChoices(pin, hole).map((c) => c.kind).slice(0, 2)).toEqual(["concentric", "pin"]);
    expect(mateChoices(pin, top)[0].kind).toBe("perpendicular");
  });

  it("adds a mate line that places the parts", () => {
    const m = evaluate(SRC);
    const cats = catalogues(m);
    const choice = mateChoices(ref(m, cats, "lid", "face", [10, 5, 0]).geom, ref(m, cats, "base", "face", [-10, 5, 30]).geom)[0];
    let r = addMate(SRC, m, choice, { part: "lid", text: ref(m, cats, "lid", "face", [10, 5, 0]).text }, { part: "base", text: ref(m, cats, "base", "face", [-10, 5, 30]).text });
    expect(r.line).toBe("mate lid_to_base = against(face(lid, -Z), face(base, +Z))");
    const faces = (h: string) => cats.get(h);
    let m2 = evaluate(r.src, { faces });
    expect(m2.mates?.list[0].status).toBe("ok");
    expect(applyXforms([0, 0, 0], part(m2, "lid").xf)[2]).toBeCloseTo(30, 6);
    // the pin into the hole, picked on the design where the lid is now mated
    const pinRef = ref(m2, cats, "pin", "face", [2.5, 0, 15]);
    const holeRef = ref(m2, cats, "base", "edge", [22.5, 0, 30]);
    r = addMate(r.src, m2, mateChoices(pinRef.geom, holeRef.geom)[1], { part: "pin", text: pinRef.text }, { part: "base", text: holeRef.text });
    expect(r.line).toBe("mate pin_to_base = pin(axis(pin, d: 5), axis(base, d: 5))");
    m2 = evaluate(r.src, { faces });
    expect(m2.mates?.list.map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(applyXforms([0, 0, 15], part(m2, "pin").xf).map((x) => +x.toFixed(6))).toEqual([20, 0, 15]);
  });

  it("writes a mated part's picks where it is drawn, not where its mates show it", () => {
    const src = `${SRC}mate seat = against(face(lid, -Z), face(base, +Z))\n`;
    const m0 = evaluate(src);
    const cats = catalogues(m0);
    const m = evaluate(src, { faces: (h) => cats.get(h) });
    const lid = part(m, "lid");
    // shown down on the base's top (against() leaves it free to slide over it), drawn 20 mm higher
    expect(applyXforms([0, 0, 0], lid.xf).map((x) => +x.toFixed(6))).toEqual([0, 100, 30]);
    expect(applyXforms([0, 0, 0], drawnXf(m, lid)).map((x) => +x.toFixed(6))).toEqual([0, 100, 50]);
    expect(ref(m, cats, "lid", "vertex", [30, 20, 4]).text).toBe(`point(lid, (${applyXforms([30, 20, 4], drawnXf(m, lid)).map((x) => +x.toFixed(2)).join(", ")}))`);
    expect(classify(cats.get(lid.hash)!, [0, 0, 2], "face")).toBeNull();
  });
});
