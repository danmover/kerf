// Frames: structural members along lines (2020 extrusion or welded steel
// sections), trimmed and lengthened where they meet, with a cut list. The
// solids are checked on the real kernel: mitred, slanted and coped ends meet
// without the pieces overlapping, and a piece weighs what its section and
// centre-line length say.

import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { evaluate } from "../src/lang/evaluator";
import { applyXf, bboxOf, buildPart, solidVolume } from "../src/kernel/build";
import { parseSection, planFrame, sectionProfile, type Section } from "../src/lang/frames";
import { catalogPart } from "../src/machine/catalog";
import { cutList } from "../src/machine/pack";
import { bomRows } from "../src/persist/files";
import { setBlockProps } from "../src/core/sourceEdit";
import type { Model } from "../src/core/model";
import { initKernel } from "./helpers/kernel";
import { fullCheck, problems } from "./helpers/fullcheck";
import { applyFastenPlan, planFasteners } from "../src/core/autoFasten";
import { openJoints } from "../src/app/frameFasten";

const issues = (m: Model, severity: "error" | "warning") => m.diagnostics.filter((d) => d.severity === severity).map((d) => d.message);
const design = (body: string) => `design "Frame"\n${body}\n`;
const catalog = (id: string) => {
  const p = catalogPart(id);
  return p?.kind === "extrusion" ? { id: p.id, name: p.name, w: Number(p.specs.w), h: Number(p.specs.h), massPerM: Number(p.specs.mass_g_per_m) } : undefined;
};
const section = (text: string) => parseSection(text, catalog) as Section;

describe("frames", () => {
  it("makes a 2020 box frame: full-height posts, rails between them and a cut list", () => {
    const m = evaluate(design(`frame stand {\n  profile: "2020"\n  box: (400, 300, 250)\n}`));
    expect(m.diagnostics).toEqual([]);
    const f = m.frames![0];
    expect(f.cuts.map((c) => [c.qty, c.length])).toEqual([
      [4, 360],
      [4, 260],
      [4, 250],
    ]);
    expect(f.total).toBe(3480);
    // 1 m bars, 3 mm per saw cut
    expect(f.stock).toEqual({ length: 1000, bars: 4 });
    // a front rail runs between the posts' faces, 10 mm up, flush with the outside
    const rail = f.members.find((x) => x.name === "stand_5")!;
    expect(rail.start).toEqual([-180, -140, 10]);
    expect(rail.end).toEqual([180, -140, 10]);
    expect(rail.joints).toEqual(["tee", "tee"]);
    // the members are catalog extrusions: on the parts list and the build pack's cut list
    const rows = bomRows(m).filter((r) => r.catalogId === "vslot_2020");
    expect(rows.map((r) => [r.qty, r.description])).toEqual(
      expect.arrayContaining([
        [4, "2020 V-slot aluminium extrusion, cut to 360 mm"],
        [4, "2020 V-slot aluminium extrusion, cut to 260 mm"],
        [4, "2020 V-slot aluminium extrusion, cut to 250 mm"],
      ]),
    );
    expect(cutList(m)[0].cuts.map((c) => [c.length, c.qty])).toEqual([
      [360, 4],
      [260, 4],
      [250, 4],
    ]);
    // one block for the frame: its members are edited through it
    expect(m.blocks.map((b) => `${b.name}:${b.kind}`)).toEqual(["stand:frame"]);
    expect(m.parts.every((p) => p.frame === "stand" && p.span.start === m.blocks[0].span.start)).toBe(true);
    expect(m.parts.map((p) => p.label).slice(0, 5)).toEqual(["stand post 1", "stand post 2", "stand post 3", "stand post 4", "stand rail 1"]);
  });

  it("stops a line that ends on a member at its face, whether drawn to its middle or its face", () => {
    const m = evaluate(
      design(`frame side {
  profile: "2020"
  path: [(0, 0, 0), (0, 0, 300)]
  path: [(0, 0, 150), (200, 0, 150)]
  path: [(100, 0, 150), (100, 0, 300)]
  path: [(200, 0, 10), (200, 0, 140)]
}`),
    );
    expect(m.diagnostics).toEqual([]);
    const len = Object.fromEntries(m.frames![0].members.map((x) => [x.name, x.length]));
    // the rail stops on the post's face; the upright stands on the rail; the last one drawn to the rail's underside stops there
    expect(len).toEqual({ side_1: 300, side_2: 190, side_3: 140, side_4: 130 });
    expect(m.frames![0].members[2].joints).toEqual(["tee", "free"]);
  });

  it("lets the upright run through a corner and the longer side run past the shorter", () => {
    const m = evaluate(design(`frame base {\n  profile: "2040"\n  box: (500, 300)\n  rotate: 90\n}`));
    expect(m.diagnostics).toEqual([]);
    const f = m.frames![0];
    // 2040 lying flat (40 across, 20 up): the long sides run the full 500, the short ones fit between
    expect(f.cuts.map((c) => [c.qty, c.length])).toEqual([
      [2, 500],
      [2, 220],
    ]);
    expect(f.members.every((x) => x.start[2] === 10)).toBe(true);
  });

  it("reads sections and says what is wrong with one", () => {
    expect(section("box 40x20x2")).toMatchObject({ kind: "box", w: 40, h: 20, t: 2, dims: "40 × 20 × 2 mm" });
    expect(section("SHS 25 x 25 x 1.6")).toMatchObject({ kind: "box", w: 25, t: 1.6 });
    expect(section("box 25x1.6")).toMatchObject({ kind: "box", w: 25, h: 25, t: 1.6 });
    expect(section("tube 26.9x2.6")).toMatchObject({ kind: "tube", round: true, w: 26.9 });
    expect(section("angle 30x3")).toMatchObject({ kind: "angle", w: 30, h: 30, t: 3 });
    expect(section("flat 40x5")).toMatchObject({ kind: "flat", w: 40, h: 5 });
    expect(section("rod 12")).toMatchObject({ kind: "rod", round: true, w: 12 });
    expect(section("2040")).toMatchObject({ kind: "extrusion", catalogId: "vslot_2040", w: 20, h: 40 });
    expect(section("vslot_2020")).toMatchObject({ catalogId: "vslot_2020" });
    expect(parseSection("box 40x20x15", catalog)).toMatch(/wall \(15 mm\) must be less than half/);
    expect(parseSection("3030", catalog)).toMatch(/no 3030 profile/);
    expect(parseSection("girder 9", catalog)).toMatch(/profile: should be "2020"/);
    const m = evaluate(design(`frame f {\n  profile: "box 40x40"\n  box: (300, 300, 300)\n}`));
    expect(issues(m, "error")[0]).toMatch(/In frame "f": profile: "box 40x40": the wall/);
  });

  it("takes its lines from a sketch, leaving out the construction lines", () => {
    const m = evaluate(
      design(`sketch side {
  plane: XZ
  line l1 = (0, 0) -> (0, 400)
  line l2 = l1.end -> (300, 400)
  line l3 = l2.end -> (300, 0)
  construction line c = l1.start -> l3.end
}
frame gate {
  profile: "box 30x30x2"
  path: side
}`),
    );
    expect(issues(m, "error")).toEqual([]);
    const f = m.frames![0];
    expect(f.members.map((x) => x.role)).toEqual(["post", "rail", "post"]);
    // drawn in the XZ plane: the posts stand up, the rail runs along X at the top
    expect(f.members[1].from).toEqual([0, 0, 400]);
    // the posts run through the top corners, the rail fits between them
    expect(f.members.map((x) => x.length)).toEqual([415, 270, 415]);
  });

  it("lets later statements read the frame and its members", () => {
    const m = evaluate(
      design(`frame stand {
  profile: "2020"
  box: (400, 300, 250)
  levels: [120]
}
let shelf_z = stand.members[12].start.z
require "tall enough": stand.h >= 250
require "every member": stand.count == 16`),
    );
    expect(issues(m, "error")).toEqual([]);
    expect(m.requirements.every((r) => r.status === "pass")).toBe(true);
    expect(m.frames![0].members).toHaveLength(16);
    expect(m.params).toEqual([]);
  });

  it("warns about members that cross, and catches mistakes in the block", () => {
    const m = evaluate(design(`frame x {\n  profile: "box 20x20x2"\n  path: [(0, 0, 0), (100, 0, 100)]\n  path: [(0, 0, 100), (100, 0, 0)]\n}`));
    expect(issues(m, "warning")).toEqual([expect.stringMatching(/member 1 and member 2 cross: split one/)]);
    expect(issues(evaluate(design(`frame y {\n  profile: "2020"\n  ends: "miter"\n  box: (300, 200)\n}`)), "warning")[0]).toMatch(/cut square and joined with brackets/);
    expect(issues(evaluate(design(`frame z {\n  profile: "2020"\n  material: "Steel"\n  box: (300, 200)\n}`)), "error")[0]).toMatch(/is aluminium: give it an aluminium alloy/);
    expect(issues(evaluate(design(`frame w {\n  profile: "2020"\n  size: (300, 200)\n}`)), "error")[0]).toMatch(/Unknown frame property "size"/);
    expect(issues(evaluate(design(`frame v {\n  profile: "2020"\n}`)), "error")[0]).toMatch(/A frame needs its lines/);
    expect(issues(evaluate(design(`frame u {\n  profile: "2020"\n  box: (30, 30, 30)\n}`)), "error")[0]).toMatch(/too small/);
  });

  it("sends a member's colour or lock to its frame block", () => {
    const src = design(`frame stand {\n  profile: "2020"\n  box: (400, 300, 250)\n}`);
    const out = setBlockProps(src, "stand_3", { color: "#222222" });
    expect(out).toContain("  color: #222222\n");
    expect(evaluate(out).parts.every((p) => p.color === "#222222")).toBe(true);
  });

  it("plans a mitre at half the corner's angle, and a brace cut to sit flat on what it meets", () => {
    const sec = section("box 40x40x3");
    const { members } = planFrame(
      [
        { a: [0, 0, 20], b: [500, 0, 20], rot: 0 },
        { a: [500, 0, 20], b: [500, 300, 20], rot: 0 },
      ],
      sec,
      { miter: true },
    );
    expect(members[0].ends[1]).toMatchObject({ joint: "miter", angle: 45, ext: 20, axis: 0 });
    expect(members[0].length).toBe(520);
    expect(members[0].axial).toBe(500);
  });
});

describe("frame solids", () => {
  beforeAll(() => initKernel(), 60_000);

  const solids = (m: Model) => m.parts.map((p) => applyXf(buildPart(p.recipe), p.xf));
  const overlap = (a: R.Shape3D, b: R.Shape3D) => {
    try {
      return solidVolume(a.clone().intersect(b.clone()) as R.Shape3D);
    } catch {
      return 0;
    }
  };
  const worstOverlap = (s: R.Shape3D[]) => {
    let worst = 0;
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) worst = Math.max(worst, overlap(s[i], s[j]));
    return worst;
  };

  it("mitres a welded rectangle: pieces meet without overlapping and weigh what their centre lines say", () => {
    const m = evaluate(design(`frame base {\n  profile: "box 40x40x3"\n  box: (600, 400)\n  ends: "miter"\n}`));
    expect(m.diagnostics).toEqual([]);
    const f = m.frames![0];
    expect(f.cuts).toEqual([
      { length: 600, qty: 2, ends: ["45° mitre", "45° mitre"], members: ["base_1", "base_3"] },
      { length: 400, qty: 2, ends: ["45° mitre", "45° mitre"], members: ["base_2", "base_4"] },
    ]);
    const s = solids(m);
    expect(worstOverlap(s)).toBeLessThan(1);
    // a mitred piece holds as much as a square-cut one as long as its centre line
    const sec = section("box 40x40x3");
    const straight = buildPart({ base: { t: "extrude", p: sectionProfile(sec), h: 560, f: { o: [0, 0, 0], u: [1, 0, 0], n: [0, 0, 1] }, twist: 0, scale: 1 }, ops: [] });
    expect(solidVolume(s[0]) / solidVolume(straight)).toBeCloseTo(1, 3);
    // the outside is the box asked for
    const all = s.reduce((a, b) => a.fuse(b) as R.Shape3D);
    const [lo, hi] = bboxOf(all);
    expect([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((x) => Math.round(x * 100) / 100)).toEqual([600, 400, 40]);
    // the parts list prices it from the section's weight
    const row = bomRows(m).find((r) => r.description.startsWith("40 × 40 × 3 mm steel box section, cut to 600 mm"))!;
    expect(row).toMatchObject({ qty: 2, kind: "Buy", length: 600 });
    expect(row.price).toBeGreaterThan(5);
  }, 60_000);

  it("cuts a brace on the slant so both its ends sit flat on the members it meets", () => {
    const m = evaluate(
      design(`frame bay {
  profile: "box 30x30x2"
  path: [(0, 0, 0), (0, 0, 400)]
  path: [(0, 0, 385), (300, 0, 385)]
  path: [(0, 0, 100), (200, 0, 385)]
}`),
    );
    expect(m.diagnostics).toEqual([]);
    const f = m.frames![0];
    expect(f.members[2].ends).toEqual(["54.9° slant", "35.1° slant"]);
    const s = solids(m);
    expect(worstOverlap(s)).toBeLessThan(1);
    // the brace's ends lie on the post's face (x = 15) and the rail's underside (z = 370)
    const [lo, hi] = bboxOf(s[2]);
    expect(lo[0]).toBeCloseTo(15, 2);
    expect(hi[2]).toBeCloseTo(370, 2);
  }, 60_000);

  it("copes a tube to fit round the tube it meets", () => {
    const m = evaluate(design(`frame rail {\n  profile: "tube 26.9x2.6"\n  path: [(0, 0, 0), (0, 0, 300)]\n  path: [(0, 0, 150), (200, 0, 150)]\n}`));
    expect(m.diagnostics).toEqual([]);
    const f = m.frames![0];
    expect(f.members[1].ends).toEqual(["coped", "square"]);
    const s = solids(m);
    expect(overlap(s[0], s[1])).toBeLessThan(1);
    // the saddle reaches round to the post's middle at its sides
    expect(bboxOf(s[1])[0][0]).toBeCloseTo(0, 1);
    // and leaves no gap: a rail 0.5 mm closer would overlap the post
    expect(f.members[1].length).toBeCloseTo(200, 0);
  }, 60_000);
});

describe("fastening a frame", () => {
  it("puts corner brackets on every joint of a 2020 frame, and then nothing fails", async () => {
    const src = design(`frame base {\n  profile: "2020"\n  box: (300, 200)\n}`);
    const before = await fullCheck(src);
    expect(before.report.items.filter((i) => i.id.startsWith("complete:joint:") && i.status === "fail")).toHaveLength(4);
    expect(openJoints(before.report, before.model, "base")).toBe(4);
    const mesh = (h: string) => (before.core.get(h) ? before.core.mesh(h, "preview") : undefined);
    const plan = planFasteners(before.model, mesh, { parts: before.model.frames![0].members.map((m) => m.name), kernel: before.kernel });
    expect(plan.skipped).toEqual([]);
    const next = applyFastenPlan(src, before.model, plan);
    expect(next).toMatch(/lib\.corner_bracket\("2020"\)/);
    // the hardware is written after the frame block
    expect(next.indexOf("corner_bracket")).toBeGreaterThan(next.indexOf("\n}"));
    const after = await fullCheck(next);
    expect(problems(after.report, ["fail"])).toEqual([]);
    expect(openJoints(after.report, after.model, "base")).toBe(0);
  }, 180_000);
});
