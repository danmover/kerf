// Sheet metal: sheet() and flange() in the language, the bent part and its
// flat pattern in OpenCASCADE, the sheet-metal checks, the flat-pattern
// drawing with its bend table, the laser DXF, and the chassis template.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { projectView, type ViewResult } from "../src/kernel/drawing";
import type { EvalPart, Model } from "../src/core/model";
import { sheetChecks, boxOverlap, polyOverlap } from "../src/core/sheetChecks";
import { composeSheet } from "../src/drawing/compose";
import { autoDrawings, drawingParts, planDrawing } from "../src/drawing/views";
import { bendRows, flatsToDxf, layFlat } from "../src/drawing/flat";
import { specToSource } from "../src/drawing/source";
import type { DrawingSpec } from "../src/drawing/spec";
import type { SheetBox } from "../src/lang/sheet";
import type { V3 } from "../src/kernel/recipe";
import { initKernel } from "./helpers/kernel";
import { fullCheck, problems } from "./helpers/fullcheck";

beforeAll(() => initKernel(), 60_000);

const part = (body: string, extra = "") => `design "T"\npart p {\n  material: "Aluminum 5052"\n  body ${body}\n${extra}}\n`;
const sheetOf = (m: Model, name = "p") => m.parts.find((q) => q.name === name)!.sheet!;
const errors = (src: string) => evaluate(src).diagnostics.map((d) => d.message);

function built(src: string) {
  const model = evaluate(src);
  expect(model.diagnostics.map((d) => d.message)).toEqual([]);
  const core = new KernelCore();
  for (const p of model.parts) {
    core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    if (p.sheet) core.build({ hash: p.sheet.flatHash, recipe: p.sheet.flat, label: `${p.label} flat` });
  }
  const bboxOf = (p: { hash: string }) => core.get(p.hash)?.bbox;
  const volumeOf = (p: { hash: string }) => core.get(p.hash)?.volume;
  return { model, core, bboxOf, volumeOf };
}

const size = (b: [number[], number[]]) => [0, 1, 2].map((k) => b[1][k] - b[0][k]);

describe("sheet()", () => {
  it("records bends, flanges and a flat pattern sized by the bend allowance", () => {
    const m = evaluate(part('sheet(rect(100, 50), t: 2, r: 2, flanges: [flange("left", 20), flange("right", 20)])'));
    expect(m.diagnostics).toEqual([]);
    const s = sheetOf(m);
    expect(s.t).toBe(2);
    expect(s.bends.map((b) => [b.name, b.angle, b.r])).toEqual([
      ["right", 90, 2],
      ["left", 90, 2],
    ]);
    // base flat 100 - 2 × (r + t), each flange h - (r + t) flat, each bend π/2 × (r + k t)
    const ba = (Math.PI / 2) * (2 + 0.44 * 2);
    expect(s.bends[0].allowance).toBeCloseTo(ba, 6);
    expect(s.flatBox[1][0] - s.flatBox[0][0]).toBeCloseTo(92 + 2 * (ba + 16), 6);
    expect(s.flatBox[1][1] - s.flatBox[0][1]).toBeCloseTo(50, 6);
    expect(s.flanges.map((f) => f.flat)).toEqual([16, 16].map((x) => expect.closeTo(x, 6)));
    // made as sheet metal unless the part says otherwise
    expect(m.parts[0].process?.id).toBe("sheet_metal");
  });

  it("explains bad arguments", () => {
    expect(errors(part('sheet(circle(d: 50), t: 2, flanges: [flange("all", 10)])'))[0]).toMatch(/rect\(\) or polygon\(\)/);
    expect(errors(part('sheet(rect(60, 40, r: 3), t: 2)'))[0]).toMatch(/sharp corners/);
    expect(errors(part('sheet(rect(60, 40), t: 2, flanges: [flange("left", 10), flange("left", 12)])'))[0]).toMatch(/two flanges on the left edge/);
    expect(errors(part('sheet(rect(60, 40), t: 2, flanges: [flange("left", 10, angle: 170)])'))[0]).toMatch(/out of range/);
    expect(errors(part('sheet(rect(60, 40), t: 2, flanges: [flange("top", 10)])'))[0]).toMatch(/unknown edge "top"/);
    expect(errors(part('sheet(rect(60, 40), t: 2, k: 0.7)'))[0]).toMatch(/K-factor/);
    expect(errors(part("box(10, 10, 10)", '  add sheet(rect(60, 40), t: 2)\n'))[0]).toMatch(/use it as the body/);
  });

  it("names polygon edges by number and by the way they face", () => {
    const m = evaluate(part('sheet(polygon([(0, 0), (80, 0), (80, 40), (0, 40)]), t: 1.5, flanges: [flange(1, 15), flange("back", 15, angle: -90)])'));
    expect(m.diagnostics).toEqual([]);
    expect(sheetOf(m).bends.map((b) => [b.name, b.angle])).toEqual([
      ["edge 1", 90],
      ["edge 2", -90],
    ]);
  });

  it("builds an L bracket (one flange) with its base and bend", () => {
    const { model, core } = built(part('sheet(rect(60, 40), t: 1.5, flanges: [flange("left", 15)])'));
    const e = core.get(model.parts[0].hash)!;
    expect(size(e.bbox)).toEqual([60, 40, 15].map((x) => expect.closeTo(x, 2)));
    // the base short of the bend, the quarter-round bend (r = t) and the flange above it
    const plate = 57 * 40 * 1.5;
    const bend = (Math.PI / 4) * (3 ** 2 - 1.5 ** 2) * 40;
    const wall = 12 * 40 * 1.5;
    expect(e.volume).toBeCloseTo(plate + bend + wall, 0);
  });

  it("builds the bent part and lays it flat with its holes, keeping the metal", () => {
    const { model, core } = built(part('sheet(rect(100, 50), t: 2, r: 2, flanges: [flange("left", 20), flange("right", 20, lip: 8)])', "  cut hole(d: 6, through: true, at: (0, 0, 5), dir: -Z)\n  cut hole(d: 5, depth: 6, at: (47, 0, 12), dir: X)\n"));
    const p = model.parts[0];
    const bent = core.get(p.hash)!;
    const flat = core.get(p.sheet!.flatHash)!;
    expect(size(bent.bbox)).toEqual([100, 50, 20].map((x) => expect.closeTo(x, 2)));
    const [w, d, h] = size(flat.bbox);
    const fb = p.sheet!.flatBox;
    expect(w).toBeCloseTo(fb[1][0] - fb[0][0], 2);
    expect(d).toBeCloseTo(50, 2);
    expect(h).toBeCloseTo(2, 3);
    // laid flat at the K-factor the metal is a little less than bent (k < 0.5), within a couple of percent
    expect(Math.abs(flat.volume - bent.volume) / bent.volume).toBeLessThan(0.02);
    // both holes come through the flat: seen from above there are two circles
    const view = projectView({ dir: [0, 0, 1], x: [1, 0, 0], items: [{ id: "p", hash: p.sheet!.flatHash, xf: [] }], hidden: false }, (q) => core.placed(q));
    const circles = view.edges.filter((e) => e.vis && e.g.t === "A" && e.g.a1 - e.g.a0 >= 2 * Math.PI - 1e-6);
    expect(circles.map((e) => (e.g as { r: number }).r).sort()).toEqual([2.5, 3]);
  });
});

describe("sheet-metal checks", () => {
  const items = (src: string) => sheetChecks(evaluate(src));

  it("passes a plain tray", () => {
    const r = items(part('sheet(rect(120, 80), t: 1.5, flanges: [flange("all", 30)])'));
    expect(r.map((i) => [i.id, i.status])).toEqual([
      ["sheet:flange:p", "pass"],
      ["sheet:collide:p", "pass"],
      ["sheet:flat:p", "pass"],
    ]);
  });

  it("flags flanges too short to grip and short ones", () => {
    // no flat at all beyond the bend is refused outright; less flat than the sheet is thick fails the check
    expect(errors(part('sheet(rect(60, 40), t: 2, flanges: [flange("left", 4)])'))[0]).toMatch(/too short for its bend/);
    expect(items(part('sheet(rect(60, 40), t: 2, flanges: [flange("left", 5)])')).find((i) => i.id === "sheet:flange:p")?.status).toBe("fail");
    const warn = items(part('sheet(rect(60, 40), t: 2, flanges: [flange("left", 6.5)])')).find((i) => i.id === "sheet:flange:p");
    expect(warn?.status).toBe("warn");
    expect(warn?.detail).toMatch(/8 mm/);
  });

  it("flags flanges that cross when bent over the base", () => {
    const r = items(part('sheet(rect(60, 60), t: 2, flanges: [flange("left", 40, angle: 150), flange("front", 40, angle: 150)])'));
    expect(r.find((i) => i.id === "sheet:collide:p")?.status).toBe("fail");
  });

  it("flags a flat pattern that overlaps itself at an inside corner", () => {
    const r = items(part('sheet(polygon([(0, 0), (80, 0), (80, 30), (30, 30), (30, 80), (0, 80)]), t: 1.5, flanges: [flange(2, 20), flange(3, 20)])'));
    expect(r.find((i) => i.id === "sheet:flat:p")?.status).toBe("fail");
  });

  it("separating-axis tests", () => {
    const box = (c: V3): SheetBox => ({ name: "b", c, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [1, 1, 1] });
    expect(boxOverlap(box([0, 0, 0]), box([1.5, 0, 0]))).toBeCloseTo(0.5, 9);
    expect(boxOverlap(box([0, 0, 0]), box([3, 0, 0]))).toBeLessThanOrEqual(0);
    const sq = (x: number): [number, number][] => [[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]];
    expect(polyOverlap(sq(0), sq(0.75))).toBeCloseTo(0.25, 9);
    expect(polyOverlap(sq(0), sq(2))).toBeLessThanOrEqual(0);
  });
});

describe("flat-pattern drawings and DXF", () => {
  const TRAY = part('sheet(rect(120, 80), t: 1.5, r: 1.5, flanges: [flange("front", 30), flange("back", 30, lip: 10), flange("left", 30), flange("right", 20, inset: 15)])', "  cut hole(d: 5, through: true, at: (40, 0, 10), dir: -Z)\n");

  function draw(ctx: ReturnType<typeof built>, spec: DrawingSpec) {
    const plan = planDrawing(spec, ctx.model, ctx.bboxOf);
    const results = new Map<string, ViewResult>();
    for (const v of plan.views) if (!results.has(v.key)) results.set(v.key, projectView(v.req, (p) => ctx.core.placed(p)));
    return { plan, sheet: composeSheet({ plan, model: ctx.model, result: (k) => results.get(k), bboxOf: ctx.bboxOf, volumeOf: ctx.volumeOf, today: "2026-10-23" }) };
  }

  it("draws the flat pattern with bend lines and a bend table", () => {
    const ctx = built(TRAY);
    const specs = autoDrawings(ctx.model, ctx.bboxOf);
    expect(specs.map((s) => s.name)).toEqual(["auto:p", "auto:p:flat"]);
    const spec = specs[1];
    expect(spec.flat).toBe(true);
    expect(spec.views.map((v) => v.kind)).toEqual(["top"]);
    const { plan, sheet } = draw(ctx, spec);
    expect(plan.parts[0].hash).toBe(ctx.model.parts[0].sheet!.flatHash);
    expect(sheet.views[0].state).toBe("ready");
    expect(sheet.warnings).toEqual([]);
    // overall sizes of the blank
    const fb = ctx.model.parts[0].sheet!.flatBox;
    const values = sheet.dims.map((d) => d.value);
    expect(values).toContainEqual(expect.closeTo(fb[1][0] - fb[0][0], 1));
    expect(values).toContainEqual(expect.closeTo(fb[1][1] - fb[0][1], 1));
    // one chain-dotted line and one tag per bend
    expect(sheet.shapes.filter((s) => s.pen === "phantom").length).toBe(5);
    const texts = sheet.shapes.flatMap((s) => (s.t === "text" ? [s.s] : []));
    expect(texts).toContain("BEND TABLE");
    expect(texts).toContain("B4 UP 90°");
    expect(texts).toContain("UP 90°  R1.5");
    expect(sheet.notes.some((n) => n.startsWith("FLAT PATTERN"))).toBe(true);
    expect(bendRows(plan.parts)?.slice(-2)).toEqual([
      ["THICKNESS", "1.5"],
      ["K-FACTOR", "0.44"],
    ]);
  });

  it("takes flat_pattern in a drawing block, and writes it back", () => {
    const m = evaluate(`${TRAY}drawing blank { title: "Blank"  of: p  flat_pattern: true }\n`);
    expect(m.diagnostics).toEqual([]);
    expect(m.drawings[0].flat).toBe(true);
    expect(m.drawings[0].views.map((v) => v.kind)).toEqual(["top"]);
    // the block covers the automatic flat drawing, not the part's own
    expect(autoDrawings(m).map((s) => s.name)).toEqual(["auto:p"]);
    expect(specToSource(m.drawings[0], "blank")).toContain("flat_pattern: true");
    expect(evaluate(`design "T"\npart q { body box(10, 10, 10) }\ndrawing d { of: q  flat_pattern: true }\n`).diagnostics[0]?.message).toMatch(/no sheet-metal parts|has none/);
  });

  it("lays several parts side by side and writes a 1:1 DXF with CUT and BEND layers", () => {
    const ctx = built(`${TRAY}part q {\n  material: "Aluminum 5052"\n  body sheet(rect(60, 40), t: 1.5, flanges: [flange("left", 15)])\n}\n`);
    const parts = layFlat(ctx.model.parts.filter((p) => p.sheet));
    const [a, b] = parts.map((p: EvalPart) => {
      const fb = p.sheet!.flatBox;
      const dx = p.xf[0]?.op === "translate" ? p.xf[0].v[0] : 0;
      return [fb[0][0] + dx, fb[1][0] + dx];
    });
    expect(b[0] - a[1]).toBeCloseTo(10, 6);
    const flats = parts.map((p) => ({ part: p, edges: projectView({ dir: [0, 0, 1], x: [1, 0, 0], items: [{ id: p.id, hash: p.hash, xf: p.xf }], hidden: false }, (q) => ctx.core.placed(q)).edges.filter((e) => e.vis).map((e) => e.g) }));
    const dxf = flatsToDxf(flats);
    expect(dxf.startsWith("0\nSECTION")).toBe(true);
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
    const ents = dxf.split("\n0\n").slice(1);
    const on = (layer: string, kind: string) => ents.filter((e) => e.startsWith(`${kind}\n`) && e.includes(`\n8\n${layer}\n`)).length;
    expect(on("BEND", "LINE")).toBe(6);
    expect(on("CUT", "CIRCLE")).toBe(1);
    expect(on("CUT", "LINE")).toBeGreaterThan(8);
    expect(on("NOTES", "TEXT")).toBe(8);
    // both blanks are on the sheet, the second beside the first
    expect(drawingParts({ ...autoDrawings(ctx.model)[0], flat: true, of: [] }, ctx.model).map((p) => p.name)).toEqual(["p", "q"]);
  });
});

describe("the Sheet-Metal Chassis template", () => {
  it("passes every check, with a flat pattern for both parts", async () => {
    const src = readFileSync(join(__dirname, "../src/demos/sheet-chassis.kerf"), "utf8");
    const r = await fullCheck(src);
    expect([...r.buildErrors.values()]).toEqual([]);
    expect(problems(r.report)).toEqual([]);
    const sheets = r.report.items.filter((i) => i.id.startsWith("sheet:"));
    expect(sheets.length).toBe(6);
    expect(sheets.every((i) => i.status === "pass")).toBe(true);
    expect(autoDrawings(r.model).filter((s) => s.flat).map((s) => s.name)).toEqual(["auto:tray:flat", "auto:cover:flat"]);
  }, 120_000);
});
