import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { loadOC } from "./occ";
import { buildPartFull, buildShape, solidVolume } from "../src/kernel/build";
import { buildThread } from "../src/kernel/threads";
import type { PartRecipe, ShapeRecipe, ThreadSpec3 } from "../src/kernel/recipe";
import { evaluate } from "../src/lang/evaluator";

beforeAll(loadOC, 60000);

const valid = (s: R.Shape3D) => {
  const oc = R.getOC();
  const check = new oc.BRepCheck_Analyzer(s.wrapped, true, false);
  const ok = check.IsValid();
  check.delete();
  return ok;
};

/** Build every part fast and in detail; return them with their timings. */
function buildAll(src: string) {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return m.parts.map((p) => {
    let t = performance.now();
    const fast = buildPartFull(p.recipe);
    const fastMs = performance.now() - t;
    t = performance.now();
    const detail = buildPartFull(p.recipe, { detail: true });
    return { part: p, fast, detail, fastMs, detailMs: performance.now() - t };
  });
}

const SHOWCASE = `design "Modelling check"

part plate {
  body box(60, 40, 4) as base
  add screw_boss(at: (-20, 0, 4), size: M3, h: 8, gussets: 3) as b1
  add screw_boss(at: (20, 0, 4), size: M3, h: 8, fit: "tap")
  add snap_hook(at: (0, 15, 4), length: 12, t: 1.6, w: 6, catch: 0.8, facing: Y)
  add rib((-10, -15, 4), (10, -15, 4), t: 1.2, h: 5)
  add gusset((10, -15, 4), along: X, size: 4, t: 1.2)
  add emboss(text("KERF", size: 6), at: (0, -5, 4), facing: Z, h: 0.6)
  cut engrave(text("v1", size: 4, font: "mono"), at: (0, 0, 0), facing: -Z, depth: 0.4)
  cut oring_groove(d: 20, cs: 1.5, at: (0, 0, 4), type: "face") as groove
  fillet(3, edges: both(base.edges, "vertical"))
  cosmetic {
    chamfer(0.3, edges: base.tip)
  }
}

part bottle {
  body loft([circle(40), rounded(rect(44, 44), 8), circle(30), circle(24)], heights: [0, 40, 70, 80], wall: 1.6) as shell_body
  add tube(od: 28, id: 20.8, h: 2, at: (0, 0, 80)) as collar
  add thread(d: 26, pitch: 3, form: "trapezoid", length: 10, at: (0, 0, 82), clearance: 0.15, bore: 20.8) as neck
  chamfer(0.5, edges: both(collar.edges, "convex"))
  material: "PETG"
  at: (100, 0, 0)
}

part handle {
  body box(30, 20, 4)
  add pipe(path([(-10, 0, 4), (-10, 0, 20), (10, 0, 20), (10, 0, 4)], r: 5), d: 6) as grip
  fillet(1.5, edges: grip.root)
  at: (0, 80, 0)
}

part knob {
  body revolve(outline([(0, 0), (12, 0), spline_to((14, 6)), spline_to((10, 12)), (0, 12)]), axis: Z) as dome
  cut hole(M4, fit: "thread", depth: 8, at: (0, 0, 0), dir: Z)
  add extrude(ngon(6, af: 10) - circle(4), h: 3, at: (0, 0, 12))
  at: (40, 80, 0)
}

part twisty {
  body box(30, 20, 10)
  draft(3, faces: "vertical", pull: Z)
  add extrude(rect(20, 10, r: 2), h: 30, twist: 90, scale: 0.6, at: (0, 0, 10))
  add sweep(circle(3), helix(d: 26, pitch: 8, h: 24, at: (0, 0, 12)))
  at: (80, 80, 0)
}
`;

describe("detailed modelling", () => {
  it("builds every new feature, fast and in detail", () => {
    for (const b of buildAll(SHOWCASE)) {
      expect(b.fast.warnings, b.part.id).toEqual([]);
      expect(b.detail.warnings, b.part.id).toEqual([]);
      expect(valid(b.detail.shape), b.part.id).toBe(true);
      expect(solidVolume(b.detail.shape), b.part.id).toBeGreaterThan(0);
    }
  }, 120000);

  it("rounds and breaks edges picked by feature name", () => {
    const recipe: PartRecipe = {
      base: { t: "box", w: 40, d: 30, h: 5, at: [0, 0, 0], r: 0 },
      baseName: "plate",
      ops: [
        { op: "add", shape: { t: "cyl", d: 10, h: 8, at: [0, 0, 5], dir: [0, 0, 1] }, name: "boss" },
        { op: "cut", shape: { t: "hole", d: 4, depth: 20, at: [0, 0, 13], dir: [0, 0, -1] }, name: "bore" },
        { op: "fillet", r: 2, edges: { s: "feat", f: "boss", part: "root" } },
        { op: "chamfer", r: 0.6, edges: { s: "feat", f: "bore", part: "root" } },
        { op: "fillet", r: 1, edges: "vertical" },
        { op: "chamfer", r: 0.4, edges: { s: "minus", a: "convex", b: { s: "feat", f: "bore", part: "edges" } }, cosmetic: true },
      ],
    };
    const fast = buildPartFull(recipe);
    const detail = buildPartFull(recipe, { detail: true });
    expect(fast.warnings).toEqual([]);
    expect(detail.warnings).toEqual([]);
    // the root fillet adds material, the bore and edge breaks take it away
    const plain = 40 * 30 * 5 + Math.PI * 25 * 8 - Math.PI * 4 * 13;
    expect(solidVolume(fast.shape)).toBeGreaterThan(plain);
    expect(solidVolume(detail.shape)).toBeLessThan(solidVolume(fast.shape));
  });
});

describe("threads", () => {
  const m3: ThreadSpec3 = { d: 3, pitch: 0.5, form: "iso", starts: 1, left: false, clearance: 0 };

  it("sews long threads from one-lead pieces, matching the pitch-diameter volume", () => {
    const t = buildThread(m3, 12, [0, 0, 0], [0, 0, 1], false, 0, true);
    expect(valid(t)).toBe(true);
    expect(t.faces.length).toBeGreaterThanOrEqual(24);
    // a symmetric thread's section has the area of its pitch circle
    const d2 = 3 - 0.649519 * 0.5;
    expect(solidVolume(t) / ((Math.PI / 4) * d2 * d2 * 12)).toBeCloseTo(1, 1);
    const left = buildThread({ ...m3, left: true, starts: 2 }, 7.3, [0, 0, 0], [1, 0, 0], false, 0, true);
    expect(valid(left)).toBe(true);
  });

  it("cuts an internal thread among many faces the same as a plain cut", () => {
    const spec: ThreadSpec3 = { d: 14, pitch: 2, form: "iso", starts: 1, left: false, clearance: 0.1 };
    const knurl: ShapeRecipe = { t: "knurl", d: 24, h: 8, at: [0, 0, 0], dir: [0, 0, 1], count: 24, depth: 0.6, style: "straight" };
    const tool: ShapeRecipe = { t: "thread", spec, length: 8.2, at: [0, 0, -0.1], dir: [0, 0, 1], internal: true, lead: 0 };
    const recipe: PartRecipe = { base: knurl, ops: [{ op: "cut", shape: tool }] };
    const plain = buildShape(knurl, true).cut(buildShape(tool, true));
    const split = buildPartFull(recipe, { detail: true });
    expect(split.warnings).toEqual([]);
    expect(valid(split.shape)).toBe(true);
    expect(solidVolume(split.shape)).toBeCloseTo(solidVolume(plain), 1);
  }, 60000);

  it("gives library screws and nuts real threads in detail builds only", () => {
    const built = buildAll(`design "hw"
component s = lib.screw(M3, 12) { at: (0, 0, 0), axis: -Z }
component l = lib.screw(M4, 40) { at: (20, 0, 0), axis: -Z }
component n = lib.nut(M3) { at: (40, 0, 0), axis: Z }
`);
    for (const b of built) {
      expect(b.detail.warnings, b.part.id).toEqual([]);
      expect(valid(b.detail.shape), b.part.id).toBe(true);
      // threads are swapped in, not stacked on: the detailed solid stays close to the fast one
      expect(Math.abs(solidVolume(b.detail.shape) / solidVolume(b.fast.shape) - 1), b.part.id).toBeLessThan(0.15);
      expect(b.detailMs, b.part.id).toBeLessThan(15000);
    }
    // checks see a tap-size shank: M3 tap 2.5 mm over 12 mm under a 5.5 x 3 mm head
    const screw = built[0];
    expect(solidVolume(screw.fast.shape)).toBeLessThan(Math.PI * 2.75 ** 2 * 3 + Math.PI * 1.25 ** 2 * 12.01);
  }, 120000);
});

describe("screw-top canister demo", () => {
  it("builds the jar and the knurled, threaded lid in detail without warnings", () => {
    const src = readFileSync(new URL("../src/demos/canister.kerf", import.meta.url), "utf8");
    for (const b of buildAll(src)) {
      expect(b.detail.warnings, b.part.id).toEqual([]);
      expect(valid(b.detail.shape), b.part.id).toBe(true);
      expect(Math.abs(solidVolume(b.detail.shape) / solidVolume(b.fast.shape) - 1), b.part.id).toBeLessThan(0.1);
      expect(b.detailMs, b.part.id).toBeLessThan(30000);
    }
  }, 120000);
});
