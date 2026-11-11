// The sheet cutting job: the design's flat parts found and grouped by material and thickness, a job from their
// process, the layout, the files, and Claude's sheet_layout tool on the same.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { meshes, useDesign } from "../src/core/engine";
import type { Model } from "../src/core/model";
import { gatherSheets, groupName, hasSheetParts, jobForGroup, layOut, perSet, pickCutter, qtyOf, sheetFiles, sheetSummary, useSheets, type SheetGroup } from "../src/cam/sheetJob";
import { findGroup, runCamTool } from "../src/ai/camTool";
import { initKernel } from "./helpers/kernel";

const SRC = `design "shelf"
part side_l { material: "Birch plywood" process: mfg.laser_cut() body box(200, 6, 120) cut hole(d: 20, through: true, at: (60, 6, 60), dir: -Y) }
part side_r { material: "Birch plywood" process: mfg.laser_cut() at: (0, 150, 0) body box(200, 6, 120) cut hole(d: 20, through: true, at: (60, 6, 60), dir: -Y) }
part shelf { material: "Birch plywood" process: mfg.laser_cut() body box(150, 100, 6, at: (0, 75, 60)) }
part bracket { material: "Mild steel" process: mfg.laser_cut(source: "fiber") body box(60, 40, 3, at: (0, 0, 130)) }
part block { material: "PETG" body box(30, 30, 30, at: (150, 0, 0)) }
part washer { material: "PETG" body cylinder(d: 20, h: 3, at: (-150, 0, 0)) }
`;

let model: Model;

function load(src: string): Model {
  const m = evaluate(src);
  const core = new KernelCore();
  for (const p of m.parts) {
    if (meshes.has(p.hash)) continue;
    core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
    const mesh = core.mesh(p.hash, "final");
    const lo: [number, number, number] = [Infinity, Infinity, Infinity],
      hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], mesh.positions[i + k]);
        hi[k] = Math.max(hi[k], mesh.positions[i + k]);
      }
    meshes.set(p.hash, { final: mesh, volume: 0, bbox: [lo, hi], rev: 0 });
  }
  useDesign.setState({ model: m, stage: "done" });
  return m;
}

describe("sheet cutting jobs", () => {
  beforeAll(async () => {
    await initKernel();
    model = load(SRC);
  }, 60_000);

  let groups: SheetGroup[];

  it("finds the flat parts by material and thickness, copies as one shape, and leaves out what is not a plate", async () => {
    expect(hasSheetParts(model)).toBe(true);
    groups = await gatherSheets(model);
    expect(groups.map(groupName)).toEqual(["Birch plywood 6 mm", "Mild steel 3 mm", "PETG 3 mm"]);
    const [ply, steel, petg] = groups;
    expect(ply.items.map((i) => [i.label, i.count, i.how])).toEqual([
      ["side_l", 2, "laser"],
      ["shelf", 1, "laser"],
    ]);
    expect(ply.items[0].names).toEqual(["side_l", "side_r"]);
    expect(steel.items.map((i) => i.how)).toEqual(["laser"]);
    // the washer is flat but made some other way; the block is no plate at all
    expect(petg.items.map((i) => [i.label, i.how])).toEqual([["washer", "flat"]]);
  });

  it("starts a job from the process: the cutter that suits the material and a sheet the parts fit", () => {
    const [ply, steel, petg] = groups;
    const j = jobForGroup(ply, model);
    expect(j.cutter).toBe("co2");
    // the smallest common sheet that takes them all at once
    expect(j.sheet).toEqual([400, 400]);
    expect(j.kerf).toBeCloseTo(0.2, 9);
    expect(jobForGroup(steel, model).cutter).toBe("fiber");
    expect(jobForGroup(steel, model).sheet).toEqual([400, 400]);
    expect(jobForGroup({ ...ply, items: ply.items.map((i) => ({ ...i, count: i.count * 8 })) }, model).sheet).toEqual([600, 400]);
    expect(pickCutter("Stainless 304", 20)).toBe("plasma");
    expect(pickCutter("PVC", 3)).toBe("waterjet");
    // a merely flat part counts in its own group, but not beside parts made by cutting
    expect(perSet(jobForGroup(petg, model), petg, petg.items[0])).toBe(1);
  });

  it("lays out the sheets, counts sets, and writes a file per sheet", async () => {
    const ply = groups[0];
    const j = jobForGroup(ply, model);
    const r = await layOut(j, ply);
    expect(r.nest.sheets).toHaveLength(1);
    expect(r.nest.sheets[0]).toHaveLength(3);
    expect(r.paths[0].filter((p) => p.hole)).toHaveLength(2);
    // each side's hole before its outline
    for (const [k, p] of r.paths[0].entries()) if (p.hole) expect(r.paths[0].slice(k + 1).some((q) => q.part === p.part && !q.hole)).toBe(true);
    const more = { ...j, qty: { [ply.items[0].key]: 3 }, sets: 2, sheet: [400, 300] as [number, number] };
    expect(qtyOf(more, ply, ply.items[0])).toBe(6);
    const r2 = await layOut(more, ply);
    expect(r2.nest.sheets.flat()).toHaveLength(8);
    const n = r2.nest.sheets.length;
    expect(n).toBeGreaterThan(1);
    const dxf = sheetFiles(more, ply, r2, "dxf");
    expect(dxf).toHaveLength(n);
    expect(dxf[0].name).toMatch(/^shelf-Birch-plywood-6-mm-sheet-1-of-\d\.dxf$/);
    const g = sheetFiles(j, ply, r, "gcode")[0];
    expect(g.name).toBe("shelf-Birch-plywood-6-mm.nc");
    expect(g.text).toMatch(/^M4 S900$/m);
    expect(sheetSummary(j, ply, r, groups)).toMatch(/1 sheet, \d+% used/);
  });

  it("lets Claude lay out a group by its words or a part in it, and open it in the panel", async () => {
    expect(findGroup(groups, "plywood 6")?.key).toBe(groups[0].key);
    expect(findGroup(groups, "6mm birch")?.key).toBe(groups[0].key);
    expect(findGroup(groups, "bracket")?.key).toBe(groups[1].key);
    expect(findGroup(groups, "acrylic")).toBeUndefined();
    const out = await runCamTool("sheet_layout", { group: "plywood", qty: { side_l: 4 }, sheet: [400, 300], open: true });
    expect(out?.isError).toBeFalsy();
    expect(out?.content).toMatch(/Sheet cutting for Birch plywood 6 mm on a co2 laser: sheets of 400 × 300 mm/);
    expect(out?.content).toMatch(/side_l × 4, shelf × 1/);
    expect(useSheets.getState().open).toBe(true);
    expect(useSheets.getState().result?.nest.sheets.flat()).toHaveLength(5);
    const bad = await runCamTool("sheet_layout", { group: "acrylic" });
    expect(bad?.isError).toBe(true);
    expect(bad?.content).toMatch(/Birch plywood 6 mm; Mild steel 3 mm; PETG 3 mm/);
  });
});
