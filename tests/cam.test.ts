// CNC toolpaths: slicing a real part, planning its cuts for a sheet held by tabs and for a block in a vise, and
// cutting them on a height map to show the tool never goes into the part and leaves nothing it can reach.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { Slicer, setupRotation } from "../src/cam/slice";
import { area, diff, inside, offset, rect } from "../src/cam/clip";
import { levelsDown, planCam, DEFAULT_SETTINGS, type CamPart, type CamSettings } from "../src/cam/plan";
import { compare, partHeights, simulate } from "../src/cam/sim";
import { cutting } from "../src/cam/feeds";
import { writeGcode } from "../src/cam/gcode";
import { timeline, toolAt } from "../src/cam/timeline";
import { computeCam } from "../src/cam/compute";
import { jobFor, requestFor, setupChoices, setupName } from "../src/cam/job";
import { camSummary } from "../src/ai/camTool";
import { parseTools, toolsText } from "../src/ui/CamPanel";
import { initKernel } from "./helpers/kernel";

const PLATE = `design "plate"
part plate {
  body box(80, 60, 12)
  cut box(30, 16, 7, at: (10, 5, 6), r: 4)
  cut hole(d: 10, through: true, at: (-25, 15, 12))
  cut hole(d: 2, through: true, at: (25, -20, 12))
}
`;

function slicerFor(src: string, dir: [number, number, number] = [0, 0, 1]) {
  const m = evaluate(src);
  const p = m.parts[0];
  const core = new KernelCore();
  core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
  return new Slicer(core.mesh(p.hash, "final"), setupRotation(dir));
}

function camPart(sl: Slicer): CamPart {
  return { section: (z) => sl.section(z), floors: sl.floors().map((f) => f.z), top: sl.hi[2], bottom: sl.lo[2], lo: [sl.lo[0], sl.lo[1]], hi: [sl.hi[0], sl.hi[1]] };
}

describe("flat regions", () => {
  it("grows, shrinks and takes areas from each other", () => {
    const sq = rect(0, 0, 10, 10);
    expect(area(sq)).toBeCloseTo(100, 6);
    expect(area(offset(sq, -2))).toBeCloseTo(36, 6);
    // grown with round corners: 14 × 14 less the four corners' squares plus a circle
    expect(area(offset(sq, 2))).toBeCloseTo(100 + 4 * 20 + Math.PI * 4, 1);
    const ring = diff(sq, rect(3, 3, 7, 7));
    expect(area(ring)).toBeCloseTo(84, 6);
    expect(inside([5, 5], ring)).toBe(false);
    expect(inside([1, 1], ring)).toBe(true);
  });

  it("steps down evenly between the floors", () => {
    expect(levelsDown(12, [6], -0.3, 4)).toEqual([9, 6, 2.85, -0.3]);
  });
});

describe("slicing a part", () => {
  beforeAll(initKernel, 60_000);

  it("finds the floors and cuts the outline with its holes and pocket", () => {
    const sl = slicerFor(PLATE);
    expect(sl.floors().map((f) => f.z)).toEqual([12, 6]);
    // above the pocket floor: the plate less the pocket and both holes
    // (the mesh's straight chords round the holes and corners leave a little more material than the true circles)
    const a = area(sl.section(8));
    expect(Math.abs(a - (80 * 60 - (30 * 16 - (4 - Math.PI) * 16) - Math.PI * 25 - Math.PI))).toBeLessThan(1.5);
    expect(sl.open).toBe(0);
    // turned over, the tool comes from below: the plate's bottom is now its top
    const flipped = slicerFor(PLATE, [0, 0, -1]);
    expect(flipped.hi[2]).toBeCloseTo(0, 6);
    expect(flipped.lo[2]).toBeCloseTo(-12, 6);
  });
});

describe("planning the cuts", () => {
  beforeAll(initKernel, 60_000);

  const base = (over: Partial<CamSettings>): CamSettings => ({
    ...DEFAULT_SETTINGS,
    stock: { lo: [-45, -35], hi: [45, 35], top: 12, bottom: 0 },
    tools: [
      { d: 6, reach: 25 },
      { d: 3, reach: 15 },
    ],
    material: "Plywood",
    frame: "router",
    rpmMax: 24000,
    hold: "tabs",
    ...over,
  });

  it("cuts a sheet out round a slot with tabs, never into the part", () => {
    const sl = slicerFor(PLATE);
    const plan = planCam(camPart(sl), base({}));
    expect(plan.ops.map((o) => o.kind)).toEqual(["rough", "finish"]);
    expect(plan.tabs.length).toBeGreaterThanOrEqual(2);
    expect(plan.seconds).toBeGreaterThan(30);
    expect(plan.warnings.join(" ")).toMatch(/1 hole \(Ø2 mm\) is smaller than the smallest end mill/);
    // cut on a height map: no gouge, the pocket and holes cut, and the tabs still there
    const cell = 0.25;
    const cut = simulate(plan, cell);
    const part = partHeights(sl, plan.stock, cell);
    const c = compare(cut, part, -Infinity);
    expect(c.gouge).toBeLessThan(0.02);
    const at = (x: number, y: number) => cut.h[Math.floor((y - cut.y0) / cell) * cut.nx + Math.floor((x - cut.x0) / cell)];
    expect(at(10, 5)).toBeCloseTo(6, 3);
    expect(at(-25, 15)).toBeLessThan(0);
    // round the outside: through, except at a tab
    const t = plan.tabs[0];
    const outward = (p: [number, number], d: number): [number, number] => {
      // straight out from the plate's nearest edge
      const dx = Math.abs(p[0]) - 40,
        dy = Math.abs(p[1]) - 30;
      return dx > dy ? [p[0] + Math.sign(p[0]) * d, p[1]] : [p[0], p[1] + Math.sign(p[1]) * d];
    };
    const o = outward(t, 1.5);
    expect(at(o[0], o[1])).toBeCloseTo(2, 2);
    expect(at(40.8, 1.3 + (t[1] === 0 ? 20 : 0))).toBeLessThan(0);
  });

  it("clears a block in a vise down to the part, facing the top, and finishes every wall", () => {
    const sl = slicerFor(PLATE);
    const plan = planCam(camPart(sl), base({ hold: "base", stock: { lo: [-43, -33], hi: [43, 33], top: 13, bottom: -5 }, material: "Aluminum 6061", frame: "vmc", rpmMax: 12000 }));
    expect(plan.ops.map((o) => o.kind)).toEqual(["face", "rough", "finish"]);
    const cell = 0.25;
    const cut = simulate(plan, cell);
    const part = partHeights(sl, plan.stock, cell);
    const c = compare(cut, part, -Infinity);
    expect(c.gouge).toBeLessThan(0.02);
    // nothing left on the part but where its walls meet the floors (a cell's width)
    let over = 0;
    for (let k = 0; k < cut.h.length; k++) if (part.h[k] > -Infinity && cut.h[k] - part.h[k] > 0.05) over++;
    expect(over / cut.h.length).toBeLessThan(0.01);
    // all round the part cut down to its bottom, the base left under it
    expect(cut.h[0]).toBeCloseTo(0, 3);
  });

  it("drills holes too small for the end mills with a drill their size, pecking", () => {
    const sl = slicerFor(PLATE);
    const plan = planCam(camPart(sl), base({ tools: [{ d: 6, reach: 25 }, { d: 3, reach: 15 }, { d: 2, reach: 16, drill: true }] }));
    expect(plan.ops.map((o) => `${o.kind} ${o.d}`)).toEqual(["rough 6", "finish 6", "drill 2"]);
    expect(plan.warnings.join(" ")).not.toMatch(/hole/);
    expect(plan.left.holes).toHaveLength(0);
    const drill = plan.ops[2];
    // through the 12 mm plate and the point out the bottom, in 6 mm pecks with the chips cleared between
    expect(Math.min(...drill.moves.map((m) => m.p[2]))).toBeCloseTo(-0.3 - 0.6, 6);
    expect(drill.moves.filter((m) => m.k === "plunge")).toHaveLength(3);
    for (const m of drill.moves) {
      expect(m.p[0]).toBeCloseTo(25, 3);
      expect(m.p[1]).toBeCloseTo(-20, 3);
    }
    const cell = 0.25;
    const cut = simulate(plan, cell);
    expect(compare(cut, partHeights(sl, plan.stock, cell), -Infinity).gouge).toBeLessThan(0.02);
    expect(cut.h[Math.floor((-20 - cut.y0) / cell) * cut.nx + Math.floor((25 - cut.x0) / cell)]).toBeLessThan(0);
    // its own file for GRBL, named as a drill
    const files = writeGcode(plan, "grbl", "plate", "setup 1 of 1: top up");
    expect(files.map((f) => f.name)).toEqual(["plate setup 1 of 1 - 1 T1 6mm.nc", "plate setup 1 of 1 - 2 T3 2mm drill.nc"]);
    expect(files[1].text).toMatch(/\(T3: 2 mm twist drill\)/);
    // a drill too big for the hole leaves it
    const big = planCam(camPart(sl), base({ tools: [{ d: 6, reach: 25 }, { d: 2.5, reach: 16, drill: true }] }));
    expect(big.ops.some((o) => o.kind === "drill")).toBe(false);
    expect(big.warnings.join(" ")).toMatch(/add a Ø2 mm drill to the tools/);
  });

  it("clears inside corners with a smaller tool when the larger does not fit", () => {
    const sl = slicerFor(`design "slot"
part plate {
  body box(60, 40, 10)
  cut box(20, 5, 5, at: (0, 0, 5))
}
`);
    const plan = planCam(camPart(sl), base({ hold: "base", stock: { lo: [-32, -22], hi: [32, 22], top: 10, bottom: -4 } }));
    // a 5 mm slot is too narrow for the 6 mm tool: the 3 mm one cuts it
    expect(plan.ops.map((o) => `${o.kind} ${o.d}`)).toEqual(["rough 6", "finish 6", "rest 3", "finish 3"]);
    const cut = simulate(plan, 0.2);
    const c = compare(cut, partHeights(sl, plan.stock, 0.2), -Infinity);
    expect(c.gouge).toBeLessThan(0.02);
    // the slot's square corners stay (no tool fits them), and are reported
    expect(plan.warnings.join(" ")).toMatch(/material is left where no tool fits/);
  });

  it("picks spindle speed and feed from the material and the tool", () => {
    const wood = cutting(6, "Plywood", "router", 24000);
    expect(wood.rpm).toBe(24000);
    expect(wood.feed).toBeGreaterThan(2000);
    const al = cutting(6, "Aluminum 6061", "router", 24000);
    expect(al.rpm).toBeLessThanOrEqual(24000);
    expect(al.stepdown).toBeCloseTo(1.5, 6);
    expect(al.feed).toBeLessThan(wood.feed);
    // inside the material's speed limit the spindle turns slower for a big tool
    expect(cutting(20, "Steel", "vmc", 12000).rpm).toBeLessThan(2000);
  });
});

describe("G-code", () => {
  beforeAll(initKernel, 60_000);

  it("writes a file per tool for GRBL and one with tool changes for LinuxCNC, zeroed on the stock's top front-left corner", () => {
    const sl = slicerFor(`design "slot"
part plate {
  body box(60, 40, 10)
  cut box(20, 5, 5, at: (0, 0, 5))
}
`);
    const plan = planCam(camPart(sl), { ...DEFAULT_SETTINGS, stock: { lo: [-32, -22], hi: [32, 22], top: 10, bottom: -4 }, tools: [{ d: 6, reach: 25 }, { d: 3, reach: 15 }], material: "Plywood", frame: "router", rpmMax: 24000, hold: "base" });
    const grbl = writeGcode(plan, "grbl", "plate", "setup 1 of 1: top up");
    expect(grbl.map((f) => f.name)).toEqual(["plate setup 1 of 1 - 1 T1 6mm.nc", "plate setup 1 of 1 - 2 T2 3mm.nc"]);
    for (const f of grbl) {
      expect(f.text).not.toMatch(/M6/);
      expect(f.text).toMatch(/^G21 G90 G17 G94$/m);
      expect(f.text).toMatch(/M30\n$/);
    }
    expect(grbl[1].text).toMatch(/zero Z on the stock top again/);
    // every move inside the stock (or a tool's radius past it), never above the safe height or below the cut
    const nums = (t: string, a: string) => [...t.matchAll(new RegExp(`${a}(-?[\\d.]+)`, "g"))].map((m) => +m[1]);
    const xs = nums(grbl[0].text, "X"),
      zs = nums(grbl[0].text, "Z");
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-3.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(64 + 3.01);
    expect(Math.max(...zs)).toBeCloseTo(5, 6);
    expect(Math.min(...zs)).toBeCloseTo(-10, 6);
    const lcnc = writeGcode(plan, "linuxcnc", "plate", "setup 1 of 1: top up");
    expect(lcnc).toHaveLength(1);
    expect(lcnc[0].name).toBe("plate setup 1 of 1.ngc");
    expect(lcnc[0].text).toMatch(/T1 M6\nG43 H1/);
    expect(lcnc[0].text).toMatch(/T2 M6\nG43 H2/);
    expect(lcnc[0].text).toMatch(/^G64 P0.01$/m);
  });
});

describe("the toolpaths panel's job", () => {
  beforeAll(initKernel, 60_000);

  it("plays the cutting back in time, the tool where the feeds have it", () => {
    const sl = slicerFor(PLATE);
    const plan = planCam(camPart(sl), { ...DEFAULT_SETTINGS, stock: { lo: [-45, -35], hi: [45, 35], top: 12, bottom: 0 }, tools: [{ d: 6, reach: 25 }], material: "Plywood", frame: "router", rpmMax: 24000, hold: "tabs" });
    const tl = timeline(plan, "router");
    // the same time the plan gives, every move later than the last
    expect(tl.total).toBeCloseTo(plan.seconds, 6);
    for (let i = 1; i < tl.t.length; i++) expect(tl.t[i]).toBeGreaterThanOrEqual(tl.t[i - 1]);
    const first = plan.ops[0].moves[0].p;
    expect(toolAt(tl, 0).p).toEqual(first.map((x) => Math.fround(x)));
    const last = plan.ops[plan.ops.length - 1].moves.at(-1)!.p;
    expect(toolAt(tl, tl.total + 5).p).toEqual(last.map((x) => Math.fround(x)));
    // half way through a move, half way along it
    const i = tl.start[0] + 5;
    const mid = toolAt(tl, (tl.t[i - 1] + tl.t[i]) / 2);
    expect(mid.i).toBe(i);
    for (let k = 0; k < 3; k++) expect(mid.p[k]).toBeCloseTo((tl.p[3 * (i - 1) + k] + tl.p[3 * i + k]) / 2, 4);
  });

  it("reads end mills written as diameter × reach", () => {
    expect(parseTools("6 × 22, 3x12")).toEqual([
      { d: 6, reach: 22 },
      { d: 3, reach: 12 },
    ]);
    expect(parseTools("6mm; 1.5")).toEqual([
      { d: 6, reach: 24 },
      { d: 1.5, reach: 6 },
    ]);
    expect(parseTools("6 x 20, drill 2 × 15, 1.5 drill")).toEqual([
      { d: 6, reach: 20 },
      { d: 2, reach: 15, drill: true },
      { d: 1.5, reach: 12, drill: true },
    ]);
    expect(toolsText([{ d: 2, reach: 15, drill: true }])).toBe("drill 2 × 15");
    expect(parseTools("six")).toBeNull();
    expect(parseTools("")).toBeNull();
    expect(toolsText([{ d: 3.175, reach: 12.5 }])).toBe("3.175 × 12.5");
  });

  it("sets a milled part up from its process, plans it and says what it found", () => {
    const m = evaluate(`design "bracket"
part bracket {
  material: "Aluminum 6061"
  process: mfg.cnc_mill(tools: [(6, 25), (3, 12)], frame: "benchtop")
  body box(60, 30, 10)
  cut box(20, 5, 5, at: (0, 0, 5))
}
`);
    const p = m.parts[0];
    const job = jobFor(p);
    // the process's setups come first, top then bottom
    expect(setupChoices(p).slice(0, 2).map((c) => c.label)).toEqual(["Setup 1 of 2: Top (+Z)", "Setup 2 of 2: Bottom (−Z)"]);
    expect(job.setup).toEqual([0, 0, 1]);
    expect(job.frame).toBe("benchtop");
    expect(job.hold).toBe("base");
    expect(job.tools).toEqual([
      { d: 6, reach: 25 },
      { d: 3, reach: 12 },
    ]);
    expect(setupName(job, p)).toBe("setup 1 of 2: top up");
    expect(setupName({ ...job, setup: [1, 0, 0] }, p)).toBe("setup right side up");
    const core = new KernelCore();
    core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
    const r = computeCam(requestFor(job, core.mesh(p.hash, "final")));
    expect(r.plan.ops.map((o) => o.kind)).toEqual(["face", "rough", "finish", "rest", "finish"]);
    expect(r.gouge).toBeLessThan(0.02);
    expect(r.maps.after).toHaveLength(5);
    expect(r.size.map((x) => +x.toFixed(3))).toEqual([60, 30, 10]);
    const text = camSummary(job, r, p);
    expect(text).toMatch(/^CNC toolpaths for bracket, setup 1 of 2: top up \(tool from \+Z\), a block in a vise/);
    expect(text).toMatch(/Stock 66 × 36 × 16 mm/);
    expect(text).toMatch(/G-code for GRBL: 2 files, a file per tool/);
    expect(text).toMatch(/material is left where no tool fits/);
  });
});

describe("tabs and points", () => {
  it("says a point near the outline is inside it", () => {
    const sq = offset(rect(0, 0, 10, 10), 0);
    expect(inside([10, 5], sq)).toBe(true);
  });
});
