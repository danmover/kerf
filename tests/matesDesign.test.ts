// Mates in a design: the `mate` statement, its errors, the kernel's lists of each solid's faces, and parts placed
// by them once the design is read again with those lists (as the app does after building).

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { parse } from "../src/lang/parser";
import { KernelCore } from "../src/kernel/core";
import { buildPart } from "../src/kernel/build";
import { faceCatalogue } from "../src/kernel/faces";
import { applyXforms, applyXformsToDir, type V3 } from "../src/kernel/recipe";
import type { FaceCatalogue } from "../src/core/mates";
import type { Model } from "../src/core/model";
import { initKernel } from "./helpers/kernel";

const near = (a: V3, b: V3, tol = 1e-3) => {
  for (let k = 0; k < 3; k++) if (Math.abs(a[k] - b[k]) > tol) throw new Error(`(${a.map((x) => x.toFixed(4))}) is not (${b.join(", ")})`);
};
const part = (m: Model, name: string) => {
  const p = m.parts.find((x) => x.name === name);
  if (!p) throw new Error(`no part ${name}`);
  return p;
};
const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("the mate statement", () => {
  it("places a part by points and planes given in the design, with no kernel", () => {
    const m = evaluate(`design "m"
part base { body box(60, 40, 10) }
part block { at: (100, 0, 0) body box(20, 20, 20) }
mate seat = against(plane(block, at: (100, 0, 0), normal: -Z), plane(base, at: (0, 0, 10), normal: +Z))
mate corner = coincident(point(block, (100, 0, 0)), point(base, (10, 5, 10)))
`);
    expect(errors(m)).toEqual([]);
    const b = part(m, "block");
    near(applyXforms([0, 0, 0], b.xf), [10, 5, 10]);
    near(applyXformsToDir([0, 0, 1], b.xf), [0, 0, 1]);
    expect(m.mates?.list.map((x) => [x.name, x.status])).toEqual([
      ["seat", "ok"],
      ["corner", "ok"],
    ]);
    // the base is not moved; the block can still turn about the point it is pinned at
    near(applyXforms([0, 0, 0], part(m, "base").xf), [0, 0, 0]);
    const free = m.mates?.free.find((f) => f.body === "block");
    expect(free?.dof).toBe(1);
    // a mate is a block of the design, and the mated part depends on what it is mated to
    expect(m.blocks.some((x) => x.name === "seat" && x.kind === "mate")).toBe(true);
  });

  it("parses unnamed mates and mates named like other statements", () => {
    const p = parse(`design "m"
part a { body box(10, 10, 10) }
part b { at: (0, 0, 30) body box(10, 10, 10) }
mate against(plane(b, at: (0, 0, 30), normal: -Z), plane(a, at: (0, 0, 10), normal: +Z))
mate gap = distance(point(b, (0, 0, 30)), point(a, (0, 0, 10)), 5mm)
`);
    const mates = p.program.stmts.filter((s) => s.k === "mate");
    expect(mates.map((s) => (s.k === "mate" ? s.name : ""))).toEqual([undefined, "gap"]);
  });

  it("says what is wrong with a mate", () => {
    const run = (line: string) => errors(evaluate(`design "m"\npart a { body box(10, 10, 10) }\npart b { at: (0, 0, 30) body box(10, 10, 10) }\n${line}\n`)).join("\n");
    expect(run("mate x = against(face(c, -Z), face(a, +Z))")).toMatch(/"c" is not defined/);
    expect(run("let k = 4\nmate x = against(face(k, -Z), face(a, +Z))")).toMatch(/face\(\): the part should be a part or component, got/);
    expect(run("mate x = against(face(a, -Z), face(a, +Z))")).toMatch(/a mate joins two different parts; both are a/);
    expect(run("mate x = against(b, face(a, +Z))")).toMatch(/say which of b's faces or holes it holds by/);
    expect(run("mate x = angle(face(b, +Z), face(a, +Z), 30deg, max: 40deg)")).toMatch(/not both/);
    expect(run("mate x = distance(point(b, (0, 0, 30)), point(a, (0, 0, 0)))")).toMatch(/give the distance/);
    expect(run("mate x = face(b, +Z)")).toMatch(/A mate is one of against\(\)/);
    expect(run("mate x = face(b)")).toMatch(/say which face/);
    // a plane against an axis cannot hold
    expect(run("mate x = against(axis(b, at: (0, 0, 30), dir: Z), plane(a, at: (0, 0, 10), normal: +Z))")).not.toBe("");
    expect(run("mate x = against(plane(b, at: (0, 0, 30), normal: -Z), plane(a, at: (0, 0, 10), normal: +Z))\nmate x = flush(plane(b, at: (5, 0, 30), normal: +X), plane(a, at: (5, 0, 0), normal: +X))")).toMatch(/already a mate called "x"/);
  });

  it("reports a mate that fights the ones before it, and leaves it out", () => {
    const m = evaluate(`design "m"
part a { body box(10, 10, 10) }
part b { at: (0, 0, 30) body box(10, 10, 10) }
mate seat = against(plane(b, at: (0, 0, 30), normal: -Z), plane(a, at: (0, 0, 10), normal: +Z))
mate lift = distance(plane(b, at: (0, 0, 30), normal: -Z), plane(a, at: (0, 0, 10), normal: +Z), 5mm)
`);
    const lift = m.mates?.list.find((x) => x.name === "lift");
    expect(lift?.status).toBe("conflict");
    expect(errors(m).join("\n")).toMatch(/off by 5 mm/);
    // the first one still holds
    near(applyXforms([0, 0, 0], part(m, "b").xf), [0, 0, 10]);
  });

  it("waits for the kernel's lists of faces before placing by faces and holes", () => {
    const m = evaluate(`design "m"
part a { body box(10, 10, 10) }
part b { at: (0, 0, 30) body box(10, 10, 12) }
mate seat = against(face(b, -Z), face(a, +Z))
`);
    expect(errors(m)).toEqual([]);
    expect(m.mates?.list[0].status).toBe("waiting");
    expect(m.mateQueries?.length).toBe(2);
    near(applyXforms([0, 0, 0], part(m, "b").xf), [0, 0, 30]);
  });
});

describe("the kernel's lists of faces", () => {
  beforeAll(initKernel, 60_000);

  it("lists a block's flat faces with outward normals and a hole once, along its axis", () => {
    const m = evaluate(`design "m"
part base { body box(60, 40, 10) cut hole(d: 5, through: true, at: (20, 0, 10)) }
`);
    const cat: FaceCatalogue = faceCatalogue(buildPart(part(m, "base").recipe));
    expect(cat.planes.length).toBe(6);
    // the top's middle is off centre by the hole it has lost
    const top = cat.planes.find((p) => p.n[2] > 0.99)!;
    const holeArea = Math.PI * 2.5 * 2.5;
    near(top.p, [(-holeArea * 20) / (2400 - holeArea), 0, 10], 1e-3);
    expect(top.area).toBeCloseTo(2400 - holeArea, 1);
    const bottom = cat.planes.find((p) => p.n[2] < -0.99)!;
    expect(bottom.p[2]).toBeCloseTo(0, 6);
    expect(cat.rounds.length).toBe(1);
    const hole = cat.rounds[0];
    expect(hole.r).toBeCloseTo(2.5, 6);
    expect(hole.len).toBeCloseTo(10, 4);
    near(hole.p, [20, 0, 5]);
    expect(Math.abs(hole.d[2])).toBeCloseTo(1, 9);
    near(cat.box[0], [-30, -20, 0], 1e-3);
    near(cat.box[1], [30, 20, 10], 1e-3);
  });

  it("gives a cone's middle radius and length along its axis", async () => {
    const m = evaluate(`design "m"
part plate { body box(40, 40, 10) cut hole(M4, csink: true, through: true, at: (0, 0, 10)) }
`);
    const cat = faceCatalogue(buildPart(part(m, "plate").recipe));
    const cone = cat.rounds.find((r) => r.len < 5 && r.r > 2.3);
    expect(cone).toBeTruthy();
    // a countersink's cone is wider than the M4 clearance hole and shorter than the plate
    expect(cone!.p[2]).toBeGreaterThan(5);
    const bore = cat.rounds.find((r) => r !== cone)!;
    expect(bore.r).toBeLessThan(cone!.r);
  });

  it("places parts by their faces and holes once the kernel has listed them", () => {
    const src = `design "hinge"
part base { body box(60, 40, 10) cut hole(d: 5, through: true, at: (20, 0, 10)) }
part pin { at: (100, 50, 3) body cylinder(d: 5, h: 30, at: (0, 0, 0)) }
part lid { at: (0, 100, 40) rotate: (0, 0, 3) body box(60, 40, 6) }
mate seat = against(face(lid, -Z), face(base, +Z))
mate square = flush(face(lid, +X), face(base, +X))
mate edge = flush(face(lid, +Y), face(base, +Y))
mate shaft = pin(axis(pin), axis(base, d: 5))
`;
    const first = evaluate(src);
    expect(first.mates?.list.every((x) => x.status === "waiting")).toBe(true);
    const core = new KernelCore();
    for (const p of first.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    const cats = core.faces(first.mateQueries ?? []);
    expect(Object.values(cats).every((c) => !("error" in c))).toBe(true);
    const m = evaluate(src, { faces: (h) => cats[h] as FaceCatalogue | undefined });
    expect(errors(m)).toEqual([]);
    expect(m.mates?.list.map((x) => x.status)).toEqual(["ok", "ok", "ok", "ok"]);
    // the lid sits squarely on the base, edges level
    const lid = part(m, "lid");
    near(applyXforms([0, 0, 0], lid.xf), [0, 0, 10]);
    near(applyXformsToDir([1, 0, 0], lid.xf), [1, 0, 0], 1e-6);
    // the pin is in the hole, centred along it, and can still turn
    const pin = part(m, "pin");
    near(applyXforms([0, 0, 15], pin.xf), [20, 0, 5]);
    near(applyXformsToDir([0, 0, 1], pin.xf), [0, 0, 1], 1e-6);
    expect(m.mates?.free.find((f) => f.body === "pin")?.dof).toBe(1);
    expect(m.mates?.free.find((f) => f.body === "lid")?.dof).toBe(0);
    // the base stays where it is drawn
    near(applyXforms([0, 0, 0], part(m, "base").xf), [0, 0, 0]);
    // the kernel keeps each list with its solid
    expect(core.faces([part(m, "base").hash])[part(m, "base").hash]).toBe(cats[part(m, "base").hash]);
  });
});
