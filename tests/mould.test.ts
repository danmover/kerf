// Moulds: mould() in the language, the two halves built round a part in
// OpenCASCADE (split, keys, bolts, sprue, vents, shrink), and the Cast Knob
// and Mould template.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Shape3D } from "replicad";
import { evaluate } from "../src/lang/evaluator";
import { shrinkFor } from "../src/lang/mould";
import { autoSplit, hullArea } from "../src/kernel/mould";
import { buildPart, solidVolume } from "../src/kernel/build";
import { initKernel } from "./helpers/kernel";
import { fullCheck, problems } from "./helpers/fullcheck";

beforeAll(() => initKernel(), 60_000);

const BLOCK = `design "M"
part puck {
  material: "Polyurethane"
  body cylinder(d: 30, h: 10)
}
`;
const half = (args: string) => `${BLOCK}part m { body mould(puck${args ? `, ${args}` : ""}) }\n`;
const errors = (src: string) => evaluate(src).diagnostics.map((d) => d.message);

describe("mould()", () => {
  it("knows how much each material shrinks", () => {
    expect(shrinkFor("ABS")).toBe(0.006);
    expect(shrinkFor("PP")).toBe(0.015);
    expect(shrinkFor("Polyurethane")).toBe(0.002);
    expect(shrinkFor("Aluminium A356")).toBe(0.012);
    expect(shrinkFor("Oak")).toBe(0);
  });

  it("records the half, the part and the settings", () => {
    const m = evaluate(half('half: "bottom", wall: 10, bolts: M4, keys: 2, sprue: 5, vents: 3'));
    expect(m.diagnostics).toEqual([]);
    const r = m.parts.find((p) => p.name === "m")!.recipe.base!;
    expect(r.t).toBe("mould");
    if (r.t !== "mould") return;
    expect([r.half, r.wall, r.keys, r.sprue, r.vents, r.split]).toEqual(["bottom", 10, 2, 5, 3, null]);
    expect(r.bolt).toBeCloseTo(4.5, 1);
    // the part's material sets the shrink unless it is given
    expect(r.shrink).toBe(0.002);
    expect(evaluate(half("shrink: 0")).parts[1].recipe.base).toMatchObject({ shrink: 0 });
  });

  it("explains bad arguments", () => {
    expect(errors(`design "M"\npart m { body mould(nothing) }\n`)[0]).toMatch(/nothing|not defined|unknown/i);
    expect(errors(half('half: "left"'))[0]).toMatch(/"top" or "bottom"/);
    expect(errors(half("keys: 3"))[0]).toMatch(/0, 2 or 4/);
    expect(errors(half("wall: 6, bolts: M4"))[0]).toMatch(/wall of at least/);
    expect(errors(half("shrink: 0.2"))[0]).toMatch(/fraction/);
  });
});

describe("splitting", () => {
  it("measures the convex hull of a section", () => {
    expect(hullArea([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]])).toBeCloseTo(4, 9);
    expect(hullArea([[0, 0], [1, 1]])).toBe(0);
  });

  it("splits at the lowest height where the part is widest", () => {
    // a cone standing on its point is widest at the top, a ball at its middle
    const tri = (pts: number[][], tris: number[][]) => ({ v: pts.flat(), t: tris.flat() });
    const square = (z: number, r: number) => [[-r, -r, z], [r, -r, z], [r, r, z], [-r, r, z]];
    // a double pyramid: widest at z = 5
    const pts = [[0, 0, 0], ...square(5, 4), [0, 0, 10]];
    const faces = [0, 1, 2, 3].map((i) => [0, 1 + i, 1 + ((i + 1) % 4)]).concat([0, 1, 2, 3].map((i) => [5, 1 + i, 1 + ((i + 1) % 4)]));
    expect(autoSplit(tri(pts, faces), 0, 10)).toBeCloseTo(5, 0);
  });
});

describe("the halves", () => {
  function halves(src: string) {
    const m = evaluate(src);
    expect(m.diagnostics).toEqual([]);
    const get = (name: string) => buildPart(m.parts.find((p) => p.name === name)!.recipe) as Shape3D;
    return { m, get };
  }

  it("close round the part without overlapping it or each other", () => {
    const { get } = halves(`${BLOCK}part top { body mould(puck, half: "top", split: 5, shrink: 0, sprue: 0, vents: 0) }\npart bottom { body mould(puck, half: "bottom", split: 5, shrink: 0) }\n`);
    const part = get("puck");
    const top = get("top");
    const bottom = get("bottom");
    const v = (s: Shape3D) => solidVolume(s);
    expect(v(top.intersect(part) as Shape3D)).toBeLessThan(0.5);
    expect(v(bottom.intersect(part) as Shape3D)).toBeLessThan(0.5);
    // the keys' sockets are a little bigger than their bumps
    expect(v(top.intersect(bottom) as Shape3D)).toBeLessThan(0.5);
    // together with the part they fill the block, less the gaps round the keys
    const block = 50 * 50 * 30;
    expect(v(top) + v(bottom) + v(part)).toBeGreaterThan(block - 200);
    expect(v(top) + v(bottom) + v(part)).toBeLessThan(block + 1);
  });

  it("puts a cup's core in the bottom half, which it pulls out with", () => {
    const { get } = halves(`design "C"\npart cup {\n  material: "Polyurethane"\n  body cylinder(d: 30, h: 20)\n  shell(2, open: "bottom")\n}\npart bottom { body mould(cup, half: "bottom", wall: 8) }\n`);
    const [lo, hi] = get("bottom").boundingBox.bounds;
    // the block's floor, plus the core standing up inside the cup
    expect(lo[2]).toBeCloseTo(-8, 1);
    expect(hi[2]).toBeGreaterThan(15);
  });

  it("cuts a sprue, vents and bolt holes, and grows the cavity by the shrink", () => {
    const { get } = halves(`${BLOCK}part plain { body mould(puck, half: "top", sprue: 0, vents: 0, shrink: 0) }\npart full { body mould(puck, half: "top", bolts: M4, shrink: 0) }\npart grown { body mould(puck, half: "top", sprue: 0, vents: 0, shrink: 0.02) }\n`);
    const plain = solidVolume(get("plain"));
    // the puck splits at its base, so the top half is 20 mm tall: a sprue (a cone from 6 to 10.8 mm, about 590 mm³),
    // two 2 mm vents (about 70) and four 4.5 mm bolt holes through it (about 1270)
    const removed = plain - solidVolume(get("full"));
    expect(removed).toBeGreaterThan(1700);
    expect(removed).toBeLessThan(2150);
    // 2% bigger in every direction: the cavity holds the part grown by 2%, which the plain cavity does not
    const big = get("puck").scale(1.02, [0, 0, 5]) as Shape3D;
    expect(solidVolume(get("grown").intersect(big) as Shape3D)).toBeLessThan(0.5);
    expect(solidVolume(get("plain").intersect(big) as Shape3D)).toBeGreaterThan(20);
  });

  it("follows the part when it changes", () => {
    const a = evaluate(half('half: "top"'));
    const b = evaluate(half('half: "top"').replace("d: 30", "d: 34"));
    expect(a.parts[1].hash).not.toBe(b.parts[1].hash);
  });
});

describe("the Cast Knob and Mould template", () => {
  it("passes every check", async () => {
    const src = readFileSync(join(__dirname, "../src/demos/cast-knob.kerf"), "utf8");
    const r = await fullCheck(src);
    expect([...r.buildErrors.values()]).toEqual([]);
    expect(problems(r.report)).toEqual([]);
    expect(r.model.parts.map((p) => p.name)).toEqual(["knob", "mould_bottom", "mould_top"]);
  }, 120_000);

  it("pours into the middle of the knob's top, clear of the pointer groove", async () => {
    const { makeCylinder } = await import("replicad");
    const src = readFileSync(join(__dirname, "../src/demos/cast-knob.kerf"), "utf8");
    const m = evaluate(src);
    const top = m.parts.find((p) => p.name === "mould_top")!;
    // in the mould's own frame (before it is turned over beside the knob) the pour hole runs up the middle
    const shape = buildPart(top.recipe) as Shape3D;
    const probe = makeCylinder(1, 6, [0, 0, 18], [0, 0, 1]);
    expect(solidVolume(shape.intersect(probe) as Shape3D)).toBeLessThan(0.01);
  });
});
