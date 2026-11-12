// Cutting flat parts from sheet: a plate's profile from its solid, parts nested without touching (small ones in a
// big one's hole), cuts offset by half the kerf into the scrap with holes first and the pierce off the line, and the
// files for laser software and machines.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { area, diff, inside, inter, loopArea, offset, pathLength, rect, type Region } from "../src/cam/clip";
import { computeSheets, cutAt, cutPaths, cutSeconds, cutStats, cutTimeline, cutterDefaults, flatProfile, nest, sheetDxf, sheetGcode, sheetSvg, type Placed } from "../src/cam/sheet";
import { initKernel } from "./helpers/kernel";

function meshOf(src: string) {
  const m = evaluate(src);
  const p = m.parts[0];
  const core = new KernelCore();
  core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
  return core.mesh(p.hash, "final");
}

/** No two parts closer than the gap (less a little for the grid), all inside the sheet's margin. */
function checkNest(sheet: Placed[], size: [number, number], gap: number, margin: number) {
  for (let i = 0; i < sheet.length; i++) {
    const a = offset(sheet[i].region, gap / 2 - 0.05);
    for (let j = i + 1; j < sheet.length; j++) expect(area(inter(a, offset(sheet[j].region, gap / 2 - 0.05)))).toBeLessThan(1e-6);
    expect(area(diff(sheet[i].region, rect(margin - 0.05, margin - 0.05, size[0] - margin + 0.05, size[1] - margin + 0.05)))).toBeLessThan(1e-6);
  }
}

describe("flat profiles", () => {
  beforeAll(initKernel, 60_000);

  it("cuts a plate through the middle, whichever way it lies, and knows a stepped one", () => {
    const p = flatProfile(
      meshOf(`design "p"
part plate {
  body box(80, 3, 50)
  cut hole(d: 10, through: true, at: (0, 3, 25), dir: -Y)
}
`),
    )!;
    expect(p.thickness).toBeCloseTo(3, 6);
    expect(p.stepped).toBe(false);
    expect(Math.abs(area(p.region) - (80 * 50 - Math.PI * 25))).toBeLessThan(0.5);
    const stepped = flatProfile(
      meshOf(`design "p"
part plate {
  body box(80, 50, 6)
  cut box(20, 20, 3, at: (0, 0, 3))
}
`),
    )!;
    expect(stepped.stepped).toBe(true);
  });
});

describe("nesting", () => {
  it("packs copies without touching, inside the margin, and opens another sheet when one is full", () => {
    const item = { key: "a", label: "Panel", region: rect(0, 0, 100, 50), qty: 6 };
    const n = nest([item], { sheet: [320, 200], gap: 4, margin: 5, rotate: true });
    expect(n.sheets).toHaveLength(1);
    expect(n.sheets[0]).toHaveLength(6);
    checkNest(n.sheets[0], [320, 200], 4, 5);
    expect(n.used).toBeCloseTo((6 * 5000) / (320 * 200), 6);
    const over = nest([{ ...item, qty: 10 }], { sheet: [220, 120], gap: 4, margin: 5, rotate: true });
    expect(over.sheets.length).toBeGreaterThan(1);
    expect(over.sheets.flat()).toHaveLength(10);
    for (const s of over.sheets) checkNest(s, [220, 120], 4, 5);
    const big = nest([{ key: "b", label: "Big", region: rect(0, 0, 500, 500), qty: 1 }], { sheet: [300, 300], gap: 3, margin: 5, rotate: true });
    expect(big.sheets).toHaveLength(0);
    expect(big.unplaced).toEqual([{ key: "b", label: "Big", count: 1 }]);
  });

  it("turns long parts to fit and puts a small part in a big part's hole", () => {
    const long = nest([{ key: "l", label: "Rail", region: rect(0, 0, 30, 180), qty: 1 }], { sheet: [200, 100], gap: 3, margin: 5, rotate: true });
    expect(long.sheets[0]).toHaveLength(1);
    expect(long.sheets[0][0].turn % 2).toBe(1);
    const stuck = nest([{ key: "l", label: "Rail", region: rect(0, 0, 30, 180), qty: 1 }], { sheet: [200, 100], gap: 3, margin: 5, rotate: false });
    expect(stuck.unplaced).toHaveLength(1);
    const ring: Region = diff(rect(0, 0, 200, 200), rect(25, 25, 175, 175));
    const n = nest(
      [
        { key: "ring", label: "Ring", region: ring, qty: 1 },
        { key: "sq", label: "Square", region: rect(0, 0, 100, 100), qty: 1 },
      ],
      { sheet: [210, 210], gap: 3, margin: 3, rotate: true },
    );
    expect(n.sheets).toHaveLength(1);
    expect(n.sheets[0]).toHaveLength(2);
    checkNest(n.sheets[0], [210, 210], 3, 3);
  });

  it("tries the parts in other orders: frames with big windows go first and share a sheet", () => {
    const frame = diff(rect(0, 0, 220, 160), rect(30, 30, 190, 130));
    const n = nest(
      [
        { key: "f", label: "Frame", region: frame, qty: 3 },
        { key: "s", label: "Side", region: rect(0, 0, 200, 120), qty: 6 },
        { key: "t", label: "Tab", region: rect(0, 0, 40, 30), qty: 6 },
      ],
      { sheet: [400, 300], gap: 3, margin: 5, rotate: true },
    );
    // by area alone the sides go first, three to a sheet, and the frames then need two sheets more
    expect(n.sheets).toHaveLength(3);
    expect(n.sheets.some((s) => s.filter((p) => p.key === "f").length === 2)).toBe(true);
    for (const s of n.sheets) checkNest(s, [400, 300], 3, 5);
  });
});

const circle = (cx: number, cy: number, r: number, n = 64): Region => [Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as [number, number])];

describe("cut paths", () => {
  const plate: Region = diff(rect(10, 10, 110, 70), circle(40, 40, 8));
  const placed: Placed[] = [{ key: "p", label: "Plate", copy: 1, turn: 0, region: plate }];

  it("cuts the hole first, then the outline, half the kerf into the scrap with the pierce off the line", () => {
    const paths = cutPaths(placed, { kerf: 0.2, lead: 2, overcut: 0.5 });
    expect(paths.map((p) => p.hole)).toEqual([true, false]);
    const [hole, outer] = paths;
    // the material on the right of the cut: the outline clockwise, the hole counter-clockwise
    expect(loopArea(outer.loop)).toBeLessThan(0);
    expect(loopArea(hole.loop)).toBeGreaterThan(0);
    // the outline 0.1 mm out from the part, the hole 0.1 mm in from its edge
    expect(Math.abs(-loopArea(outer.loop) - 100.2 * 60.2)).toBeLessThan(0.05);
    expect(Math.abs(loopArea(hole.loop) - Math.PI * 7.9 * 7.9)).toBeLessThan(1);
    // pierced in the scrap, a lead-in's length from the start
    expect(inside(hole.pierce, plate)).toBe(false);
    expect(inside(hole.pierce, rect(32, 32, 48, 48))).toBe(true);
    expect(inside(outer.pierce, offset(plate, 0.1))).toBe(false);
    expect(Math.hypot(outer.pierce[0] - outer.loop[0][0], outer.pierce[1] - outer.loop[0][1])).toBeCloseTo(2, 6);
    // and on past the start by the overcut
    expect(pathLength([outer.loop[0], ...outer.overcut], false)).toBeCloseTo(0.5, 6);
    const st = cutStats(paths);
    expect(st.pierces).toBe(2);
    expect(st.cut).toBeGreaterThan(2 * (100 + 60) + 2 * Math.PI * 7.9);
  });

  it("cuts a part sitting in another's hole before that hole, and pierces that hole clear of it", () => {
    const ring: Region = diff(rect(0, 0, 200, 200), rect(25, 25, 175, 175));
    const far: Placed[] = [
      { key: "ring", label: "Ring", copy: 1, turn: 0, region: ring },
      { key: "sq", label: "Square", copy: 1, turn: 0, region: rect(70, 70, 170, 170) },
    ];
    // the ring's middle is nearer the corner, but the square in its hole comes out first
    expect(cutPaths(far, { kerf: 0.2, lead: 2, overcut: 0 }).map((p) => [p.part, p.hole])).toEqual([
      [1, false],
      [0, true],
      [0, false],
    ]);
    const near: Placed[] = [far[0], { ...far[1], region: rect(28, 28, 128, 128) }];
    const paths = cutPaths(near, { kerf: 0.2, lead: 5, overcut: 0 });
    const hole = paths.find((p) => p.hole)!;
    expect(inside(hole.pierce, rect(25, 25, 175, 175))).toBe(true);
    expect(inside(hole.pierce, offset(near[1].region, 0.1))).toBe(false);
  });

  it("times the cutting step by step for the preview", () => {
    const paths = cutPaths(placed, { kerf: 0.2, lead: 2, overcut: 0.5 });
    const c = { ...cutterDefaults("plasma", true, false, 3), passes: 1 };
    const tl = cutTimeline(paths, c);
    expect(tl.steps.map((s) => s.kind)).toEqual(["travel", "pierce", "cut", "travel", "pierce", "cut"]);
    expect(tl.total).toBeCloseTo(cutSeconds(paths, c), 9);
    const cutting = tl.steps[2];
    // halfway through the hole's cut: the head is on the hole's loop, half its length along
    const mid = cutAt(tl, (cutting.t0 + cutting.t1) / 2);
    expect(mid.step).toBe(2);
    expect(pathLength(mid.done, false)).toBeCloseTo(cutting.at[cutting.at.length - 1] / 2, 6);
    expect(cutAt(tl, tl.total).step).toBe(5);
    // the whole job in one go, as the worker runs it
    const r = computeSheets({ items: [{ key: "p", label: "Plate", region: plate, qty: 3 }], nest: { sheet: [300, 200], gap: 3, margin: 5, rotate: true }, cut: { kerf: 0.2, lead: 2, overcut: 0 } });
    expect(r.nest.sheets.flat()).toHaveLength(3);
    expect(r.paths.flat()).toHaveLength(6);
  });

  it("writes G-code for a laser and for a plasma table, and DXF and SVG at 1:1", () => {
    const paths = cutPaths(placed, { kerf: 0.2, lead: 1, overcut: 0 });
    const laser = cutterDefaults("co2", false, true, 3);
    const g = sheetGcode(paths, laser, "plate", "sheet 1 of 1");
    expect(g).toMatch(/^G21 G90 G17 G94$/m);
    expect(g).toMatch(/^M4 S700$/m);
    expect(g).not.toMatch(/^G[01].*Z/m);
    expect(g.match(/^M4 /gm)).toHaveLength(2);
    const plasma = cutterDefaults("plasma", true, false, 3);
    const p = sheetGcode(paths, plasma, "plate", "sheet 1 of 1");
    expect(p).toMatch(/^M3$/m);
    expect(p).toMatch(/^G4 P0.4$/m);
    expect(p).toMatch(/^G0 Z3.8$/m);
    expect(cutSeconds(paths, plasma)).toBeGreaterThan(2 * 0.4);
    // a diode laser takes 3 mm wood in passes
    expect(cutterDefaults("diode", false, true, 3).passes).toBe(2);
    const dxf = sheetDxf(placed);
    expect(dxf.match(/^POLYLINE$/gm)).toHaveLength(2);
    expect(dxf).toMatch(/\nEOF\n$/);
    expect(sheetSvg(placed, [300, 200])).toMatch(/width="300mm" height="200mm" viewBox="0 0 300 200"/);
  });
});
