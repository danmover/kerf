import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { initKernel } from "./helpers/kernel";
import { buildPart, solidVolume } from "../src/kernel/build";
import { evaluate } from "../src/lang/evaluator";
import { applyQuick, parseQuick, vocabOf } from "../src/core/quickCommands";
import type { Model } from "../src/core/model";

beforeAll(initKernel, 60000);

const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
/** The one part a design makes, built. */
function built(src: string): R.Shape3D {
  const m = evaluate(src);
  expect(errors(m)).toEqual([]);
  return buildPart(m.parts[0].recipe);
}
const buildError = (src: string) => {
  const m = evaluate(src);
  expect(errors(m)).toEqual([]);
  try {
    buildPart(m.parts[0].recipe);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
};
const half = (s: R.Shape3D, side: -1 | 1) => solidVolume(s.intersect(R.makeBaseBox(20, 40, 30).translate([side * 10, 0, -5]) as R.Shape3D) as R.Shape3D);
/** what a fillet of radius r takes off a square edge, per mm of edge */
const corner = (r: number) => (1 - Math.PI / 4) * r * r;

// a 40 × 20 × 10 block, its top back edge (y = 10, z = 10) running along x from -20 to 20
const BLOCK = (mod: string) => `part block { body box(40, 20, 10)\n  ${mod}\n}`;
const BACK = "near((0, 10, 10), 0.5)";

describe("fillets whose radius changes along the edge", () => {
  it("grows from one radius to another, from the end asked for", () => {
    const grow = built(BLOCK(`fillet([1, 4], edges: ${BACK})`));
    const removed = 8000 - solidVolume(grow);
    // ∫ (1 - π/4) r² dx for r going 1 → 4 over 40 mm, give or take the ends
    expect(removed).toBeGreaterThan(40 * corner(1) * 7 * 0.95);
    expect(removed).toBeLessThan(40 * corner(1) * 7 * 1.1);
    // without from: the list starts at the end lowest in x, so the small radius is at x = -20
    expect(4000 - half(grow, -1)).toBeLessThan((4000 - half(grow, 1)) / 3);
    // from: puts the first radius at the end nearest it
    const back = built(BLOCK(`fillet([1, 4], edges: ${BACK}, from: (20, 10, 10))`));
    expect(4000 - half(back, 1)).toBeLessThan((4000 - half(back, -1)) / 3);
    expect(8000 - solidVolume(back)).toBeCloseTo(removed, 0);
  });

  it("swells in the middle with three radii, at fractions given or spread evenly", () => {
    const even = 8000 - solidVolume(built(BLOCK(`fillet([1, 4, 1], edges: ${BACK})`)));
    const two = 8000 - solidVolume(built(BLOCK(`fillet([1, 4], edges: ${BACK})`)));
    expect(even).toBeGreaterThan(40 * corner(1) * 0.95);
    expect(even).toBeLessThan(40 * corner(4));
    // the peak a quarter of the way along: the halves differ
    const early = built(BLOCK(`fillet([1, 4, 1], edges: ${BACK}, at: [0, 0.25, 1])`));
    expect(4000 - half(early, -1)).toBeGreaterThan(4000 - half(early, 1));
    expect(two).toBeGreaterThan(0);
  });

  it("runs the law over a chain of tangent edges, and says what is wrong", () => {
    // the top outline of a block with one rounded corner: a line, the arc and a line in one run
    const run = built(`part block { body box(40, 20, 10)\n  fillet(5, edges: near((20, 10, 5), 0.5))\n  fillet([1, 3], edges: near((20, 0, 10), 0.5))\n}`);
    expect(solidVolume(run)).toBeGreaterThan(7800);
    // all the way round, the list must end where it starts
    expect(buildError(`part block { body box(40, 20, 10, r: 4)\n  fillet([1, 3], edges: near((0, 10, 10), 0.5))\n}`)).toMatch(/go all the way round, so the list of radii must end on the radius it starts with, like \[1, 3, 1\]/);
    expect(solidVolume(built(`part block { body box(40, 20, 10, r: 4)\n  fillet([1, 3, 1], edges: near((0, 10, 10), 0.5))\n}`))).toBeLessThan(8000);
    const bad = (mod: string) => errors(evaluate(BLOCK(mod))).join("\n");
    expect(bad(`fillet([1], edges: ${BACK})`)).toMatch(/needs 2 to 12 of them/);
    expect(bad(`fillet([1, 0], edges: ${BACK})`)).toMatch(/radius 2 in the list should be a size in mm above 0/);
    expect(bad(`fillet([1, 2, 3], at: [0, 1], edges: ${BACK})`)).toMatch(/3 numbers, one for each radius/);
    expect(bad(`fillet([1, 2], at: [0.5, 0.2], edges: ${BACK})`)).toMatch(/should go up along the edges/);
    expect(bad(`fillet(2, from: (0, 0, 0), edges: ${BACK})`)).toMatch(/at: and from: go with a list of radii/);
  });
});

describe("full rounds", () => {
  const exact = (w: number, len: number) => w * w * (0.5 - Math.PI / 8) * len;

  it("rounds a rib's top right over, a half-round between its sides", () => {
    const src = `part plate { body box(60, 40, 4)\n  add box(60, 3, 12, at: (0, 0, 4)) as fin\n  full_round(faces: in_plane(Z, 16))\n}`;
    const s = built(src);
    const removed = 60 * 40 * 4 + 60 * 3 * 12 - solidVolume(s);
    expect(removed / exact(3, 60)).toBeGreaterThan(0.995);
    expect(removed / exact(3, 60)).toBeLessThan(1.005);
    // nothing left above the round's crown
    expect(s.boundingBox.bounds[1][2]).toBeCloseTo(16, 3);
  });

  it("rounds a tube's end, a disc's edge and a curved rib", () => {
    const tube = built(`part tube { body cylinder(d: 20, h: 30)\n  cut cylinder(d: 16, h: 30)\n  full_round(faces: in_plane(Z, 30))\n}`);
    const ring = Math.PI * (100 - 64) * 30;
    // a half-round of width 2 swept round a 9 mm circle (Pappus)
    expect((ring - solidVolume(tube)) / (exact(2, 2 * Math.PI * 9))).toBeCloseTo(1, 1);
    const disc = built(`part disc { body cylinder(d: 40, h: 4)\n  full_round(faces: near((20, 0, 2), 0.1))\n}`);
    expect(solidVolume(disc)).toBeLessThan(Math.PI * 400 * 4 - 150);
    // a curved rib: half a ring standing on a plate
    const arc = built(`part plate { body box(60, 60, 4)\n  add cylinder(d: 50, h: 12, at: (0, 0, 4))\n  cut cylinder(d: 44, h: 12, at: (0, 0, 4))\n  cut box(60, 30, 12, at: (0, -15, 4))\n  full_round(faces: in_plane(Z, 16))\n}`);
    expect(arc.boundingBox.bounds[1][2]).toBeCloseTo(16, 3);
  });

  it("refuses faces with no two long sides, and a face picked with its sides", () => {
    expect(buildError(`part block { body box(20, 20, 10)\n  full_round(faces: in_plane(Z, 10))\n}`)).toMatch(/is about as long as it is wide, so it has no two long sides to round between/);
    expect(buildError(`part plate { body box(60, 40, 4)\n  add box(60, 3, 12, at: (0, 0, 4)) as fin\n  full_round(faces: fin)\n}`)).toMatch(/share the edge through|about as long as it is wide/);
    expect(errors(evaluate(`part block { body box(20, 20, 10)\n  full_round()\n}`)).join("\n")).toMatch(/full_round\(\): faces: picks the face to round right over/);
  });
});

describe("face fillets and uneven chamfers", () => {
  it("rounds where two sets of faces meet", () => {
    const s = built(BLOCK("fillet(2, edges: between(facing(Z), facing(Y)))"));
    expect(8000 - solidVolume(s)).toBeCloseTo(40 * corner(2), 0);
    const both = built(BLOCK("fillet(2, edges: between(facing(Z), [facing(Y), facing(-Y)]))"));
    expect(8000 - solidVolume(both)).toBeCloseTo(80 * corner(2), 0);
  });

  it("cuts two sizes, or a size and an angle, the first along the face on: picks", () => {
    const dd = built(BLOCK(`chamfer((2, 1), edges: ${BACK}, on: facing(Z))`));
    expect(8000 - solidVolume(dd)).toBeCloseTo(40, 3);
    // 2 along the top: the top face loses 2 mm, the back 1 mm
    expect(dd.faces.find((f) => f.geomType === "PLANE" && f.normalAt().z > 0.999)!.boundingBox.bounds[1][1]).toBeCloseTo(8, 3);
    const da = built(BLOCK(`chamfer(2, angle: 30, edges: ${BACK}, on: facing(Z))`));
    expect(8000 - solidVolume(da)).toBeCloseTo(40 * 2 * 2 * Math.tan(Math.PI / 6) * 0.5, 2);
    const bad = (mod: string) => errors(evaluate(BLOCK(mod))).join("\n");
    expect(bad(`chamfer((2, 1), edges: ${BACK})`)).toMatch(/two sizes need on:/);
    expect(bad(`chamfer(2, angle: 30, edges: ${BACK})`)).toMatch(/angle: needs on:/);
    expect(bad(`chamfer(2, angle: 95, edges: ${BACK}, on: facing(Z))`)).toMatch(/between 0 and 90/);
    expect(buildError(BLOCK(`chamfer((2, 1), edges: ${BACK}, on: facing(-Z))`))).toMatch(/should pick one of the two faces at each edge, and at the edge through \(0, 10, 10\) it picks neither/);
  });
});

describe("rounds from a quick command", () => {
  const SRC = `part rib { body box(60, 3, 12) }\n`;
  it("grows a fillet from the end clicked, and rounds the face clicked right over", () => {
    const model = evaluate(SRC);
    const grow = parseQuick("fillet 1 to 3", vocabOf(model));
    expect(grow).toEqual({ k: "fillet", r: 1, to: 3, edges: undefined, target: undefined });
    const r = applyQuick(grow!, { src: SRC, model, target: "rib", spot: { local: [-29, 1.5, 12], normal: [0, 0, 1], edge: { mid: [0, 1.5, 12], dist: 0.1 } } });
    expect(r.ok && r.src).toMatch(/fillet\(\[1, 3\], edges: near\(\(0, 1\.5, 12\), 0\.2\), from: \(-29, 1\.5, 12\)\)/);
    expect(r.ok && r.title).toMatch(/1 mm to 3 mm, from the end you picked/);
    for (const said of ["full round", "round it over", "full round the top"]) expect(parseQuick(said, vocabOf(model))).toEqual({ k: "full_round", target: undefined });
    const full = applyQuick({ k: "full_round" }, { src: SRC, model, target: "rib", spot: { local: [5, 0, 12], normal: [0, 0, 1] } });
    expect(full.ok && full.src).toMatch(/full_round\(faces: both\(facing\(Z\), near\(\(5, 0, 12\), 0\.2\)\)\)/);
    expect(solidVolume(buildPart(evaluate(full.ok ? full.src : "").parts[0].recipe))).toBeLessThan(60 * 3 * 12 - 50);
    expect(applyQuick({ k: "full_round" }, { src: SRC, model, target: "rib" })).toMatchObject({ ok: false });
  });
});
