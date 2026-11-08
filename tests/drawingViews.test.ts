// Views that show part of a part or more of an assembly: broken views of
// long parts (automatic and break_view()), auxiliary views square onto an
// inclined face, crop views, broken-out sections and exploded views, with the
// drawing-block calls for each. Set DRAWING_OUT to keep the sheets for a look.

import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { KernelCore } from "../src/kernel/core";
import { projectView, type ViewResult } from "../src/kernel/drawing";
import { evaluate } from "../src/lang/evaluator";
import { composeSheet } from "../src/drawing/compose";
import { autoDrawings, planDrawing } from "../src/drawing/views";
import { sheetsToPdf, sheetToSvg } from "../src/drawing/render";
import type { Sheet } from "../src/drawing/sheet";
import type { DrawingSpec } from "../src/drawing/spec";
import { specToSource } from "../src/drawing/source";

const require = createRequire(import.meta.url);
const OUT = process.env.DRAWING_OUT;

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve("replicad-opencascadejs/wasm"));
  const OC = await (opencascade as unknown as (o: { wasmBinary: Buffer }) => Promise<unknown>)({ wasmBinary });
  R.setOC(OC as never);
  if (OUT) mkdirSync(OUT, { recursive: true });
}, 60_000);

function load(src: string) {
  const core = new KernelCore();
  const model = evaluate(src);
  for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  const bboxOf = (p: { hash: string }) => core.get(p.hash)?.bbox;
  return { core, model, bboxOf, src };
}

function draw(ctx: ReturnType<typeof load>, spec: DrawingSpec, name?: string): { sheet: Sheet; results: Map<string, ViewResult> } {
  const plan = planDrawing(spec, ctx.model, ctx.bboxOf);
  const results = new Map<string, ViewResult>();
  for (const v of plan.views) if (!results.has(v.key)) results.set(v.key, projectView(v.req, (p) => ctx.core.placed(p)));
  const sheet = composeSheet({ plan, model: ctx.model, result: (k) => results.get(k), bboxOf: ctx.bboxOf, today: "2026-11-07" });
  if (OUT && name) {
    writeFileSync(join(OUT, `${name}.svg`), sheetToSvg(sheet));
    writeFileSync(join(OUT, `${name}.pdf`), sheetsToPdf([sheet], sheet.title));
  }
  return { sheet, results };
}

const auto = (ctx: ReturnType<typeof load>, name: string) => autoDrawings(ctx.model, ctx.bboxOf).find((s) => s.name === name)!;
const block = (ctx: ReturnType<typeof load>, name: string) => ctx.model.drawings.find((d) => d.name === name)!;
const viewWidth = (s: Sheet, kind: string) => {
  const v = s.views.find((x) => x.kind === kind)!;
  return v.box[2] - v.box[0];
};

// a turned shaft: a long plain middle between stepped, grooved ends
const SHAFT = `
part shaft {
  material: "Steel"
  process: mfg.cnc_lathe(axis: X)
  body revolve([(0, 0), (6, 0), (6, 25), (10, 25), (10, 375), (6, 375), (6, 400), (0, 400)], at: (0, 0, 0), dir: X)
}
`;

// a rail: a long bar with holes near its ends
const RAIL = `
part rail {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(500, 20, 10, at: (0, 0, 0))
  for x in [-235, -215, 215, 235] {
    cut hole(M5, through: true, at: (x, 0, 10), dir: -Z)
  }
}
`;

describe("broken views", () => {
  it("breaks a long shaft by itself, keeps the true length and draws it bigger", () => {
    const ctx = load(SHAFT);
    const spec = auto(ctx, "auto:shaft");
    const plan = planDrawing(spec, ctx.model, ctx.bboxOf);
    expect(plan.breaks.length).toBe(1);
    expect(plan.breaks[0].axis).toBe(0);
    // the steps and their surroundings stay
    expect(plan.breaks[0].from).toBeGreaterThan(25);
    expect(plan.breaks[0].to).toBeLessThan(375);
    const broken = draw(ctx, spec, "views-shaft").sheet;
    const whole = draw(ctx, { ...spec, autoBreak: false }, "views-shaft-whole").sheet;
    expect(broken.scale).toBeGreaterThanOrEqual(whole.scale);
    // at the same scale the broken front view is much shorter
    const same = draw(ctx, { ...spec, scale: whole.scale }).sheet;
    expect(viewWidth(same, "front")).toBeLessThan(viewWidth(whole, "front") * 0.6);
    // the length is still 400, measured between the real ends
    const len = same.dims.find((d) => d.text === "400");
    expect(len).toBeTruthy();
    expect(len!.a![0]).toBeCloseTo(0, 3);
    expect(len!.b![0]).toBeCloseTo(400, 3);
    // zigzag break lines: thin polylines in the front view
    expect(same.shapes.filter((s) => s.key === `v${same.views.findIndex((v) => v.kind === "front")}` && s.t === "poly" && s.pen === "thin").length).toBeGreaterThanOrEqual(2);
  });

  it("breaks a rail between its end holes; breaks: false and break_view() choose", () => {
    const ctx = load(RAIL);
    const spec = auto(ctx, "auto:rail");
    const plan = planDrawing(spec, ctx.model, ctx.bboxOf);
    expect(plan.breaks.length).toBe(1);
    expect(plan.breaks[0].from).toBeGreaterThan(-215);
    expect(plan.breaks[0].to).toBeLessThan(215);
    const sheet = draw(ctx, spec, "views-rail").sheet;
    expect(sheet.dims.some((d) => d.text === "500")).toBe(true);
    // no dimension is left inside the gap
    for (const d of sheet.dims) expect(Number.isFinite(d.box[0])).toBe(true);

    const own = load(`${RAIL}
drawing rail_drawing {
  of: rail
  views: ["front", "top"]
  break_view(X, -100, 150)
}
drawing plain {
  of: rail
  breaks: false
}`);
    const p1 = planDrawing(block(own, "rail_drawing"), own.model, own.bboxOf);
    expect(p1.breaks).toEqual([{ axis: 0, from: -100, to: 150 }]);
    const p2 = planDrawing(block(own, "plain"), own.model, own.bboxOf);
    expect(p2.breaks).toEqual([]);
  });

  it("leaves short and busy parts whole", () => {
    const ctx = load(`
part plate {
  body box(120, 80, 6, at: (0, 0, 0))
  for x in [-50, -25, 0, 25, 50] { cut hole(M4, through: true, at: (x, 0, 6), dir: -Z) }
}`);
    expect(planDrawing(auto(ctx, "auto:plate"), ctx.model, ctx.bboxOf).breaks).toEqual([]);
  });
});

// a block with a 45° face (on its -X side: the profile's u runs along -X) drilled square to it
const WEDGE = `
part wedge {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body prism([(-30, 0), (30, 0), (30, 20), (10, 40), (-30, 40)], h: 30, at: (0, -15, 0), dir: Y)
  cut hole(M4, depth: 8, at: (-20, 0, 30), dir: (0.7071, 0, -0.7071))
}
`;

describe("auxiliary views", () => {
  it("adds a view square onto a face drilled at an angle, with its arrow and the hole's callout", () => {
    const ctx = load(WEDGE);
    const spec = auto(ctx, "auto:wedge");
    expect(spec.aux.length).toBe(1);
    expect(spec.aux[0].normal[0]).toBeCloseTo(-0.7071, 3);
    expect(spec.aux[0].normal[2]).toBeCloseTo(0.7071, 3);
    const { sheet } = draw(ctx, spec, "views-wedge");
    const vi = sheet.views.findIndex((v) => v.kind === "aux");
    expect(vi).toBeGreaterThanOrEqual(0);
    expect(sheet.views[vi].label).toMatch(/^VIEW [A-Z]/);
    expect(sheet.shapes.some((s) => s.key === `aux:${sheet.views[vi].name}`)).toBe(true);
    // the hole is called out where it shows round
    expect(sheet.dims.some((d) => d.view === vi && /Ø3\.4|M4/.test(d.text))).toBe(true);
    expect(specToSource(spec, "wedge_drawing")).toMatch(/aux_view\("[A-Z]", normal: \(-0\.7071, 0, 0\.7071\)/);
    // the wedge is about the hole's size, so its view is whole
    expect(spec.aux[0].crop).toBeUndefined();
  });

  it("shows just the angled feature of a long part, drawn bigger", () => {
    const ctx = load(`
part arm {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(400, 30, 20, at: (0, 0, 0))
  cut hole(M5, depth: 10, at: (180, 0, 20), dir: (0.7071, 0, -0.7071))
}`);
    const spec = auto(ctx, "auto:arm");
    expect(spec.aux.length).toBe(1);
    const crop = spec.aux[0].crop!;
    expect(crop).toBeTruthy();
    expect(crop[1][0] - crop[0][0]).toBeLessThan(60);
    const { sheet } = draw(ctx, spec, "views-partial-aux");
    const aux = sheet.views.find((v) => v.kind === "aux")!;
    expect(aux.scale).toBeGreaterThan(sheet.scale);
    expect(aux.label).toMatch(/\(\d+:\d+\)$/);
    expect(specToSource(spec, "arm_drawing")).toMatch(/aux_view\("[A-Z]", normal: .*crop: \[/);
  });

  it("draws a part laid along a slanted axis square to that axis", () => {
    const ctx = load(`
part pin {
  material: "Steel"
  process: mfg.cnc_lathe()
  body cylinder(d: 20, h: 80, at: (5, 5, 5), dir: (1, 0, 1))
  cut hole(M5, depth: 12, at: (5, 5, 5), dir: (-1, 0, -1))
}`);
    const spec = auto(ctx, "auto:pin");
    // seen square, the hole is not at an angle any more
    expect(spec.aux).toEqual([]);
    const { sheet } = draw(ctx, spec, "views-squared-pin");
    expect(sheet.dims.some((d) => d.text === "80")).toBe(true);
    expect(sheet.dims.some((d) => d.text === "20" || /Ø20/.test(d.text))).toBe(true);
  });
});

describe("crop views and broken-out sections", () => {
  it("crops a view to a box, with freehand edges and only the dimensions inside it", () => {
    const ctx = load(`${RAIL}
drawing end {
  of: rail
  views: []
  view("top", crop: [(150, -20, 0), (260, 20, 10)])
  breaks: false
}`);
    const { sheet } = draw(ctx, block(ctx, "end"), "views-crop");
    const vi = sheet.views.findIndex((v) => v.kind === "top");
    // the view is only as wide as the crop
    expect(sheet.views[vi].box[2] - sheet.views[vi].box[0]).toBeCloseTo(100 * sheet.views[vi].scale, 0);
    // no overall length measured to the crop's edge
    expect(sheet.dims.some((d) => d.text === "500" || d.text === "100")).toBe(false);
    // the holes it shows keep their callout
    expect(sheet.dims.some((d) => d.view === vi && /Ø5\.5|M5/.test(d.text))).toBe(true);
    // a freehand line where the crop cuts the bar
    expect(sheet.shapes.some((s) => s.key === `v${vi}` && s.t === "poly" && s.pen === "thin" && s.p.length > 20)).toBe(true);
  });

  it("cuts away a circle of a view to show a blind hole inside", () => {
    const ctx = load(`
part block {
  body box(60, 40, 30, at: (0, 0, 0))
  cut hole(M6, depth: 18, at: (0, 0, 30), dir: -Z)
}
drawing inside {
  of: block
  views: ["front", "top"]
  broken_out("front", at: (0, 0, 20), r: 12)
}`);
    const { sheet, results } = draw(ctx, block(ctx, "inside"), "views-broken-out");
    const r = [...results.values()].find((x) => x.cutaways?.length);
    expect(r).toBeTruthy();
    expect(r!.cutaways![0].hatch.length).toBeGreaterThan(0);
    expect(sheet.shapes.some((s) => s.pen === "hatch")).toBe(true);
    expect(sheet.shapes.some((s) => s.key === "cut:0")).toBe(true);
  });
});

describe("exploded views", () => {
  it("moves the parts apart and puts the balloons on it", () => {
    const ctx = load(`
part base { body box(80, 60, 8, at: (0, 0, 0)) }
part block { body box(30, 30, 20, at: (0, 0, 8)) }
part lid { body box(30, 30, 4, at: (0, 0, 28)) }
drawing asm {
  views: ["front", "top"]
  view("iso", exploded: true)
  parts_list: true
}`);
    const spec = block(ctx, "asm");
    const plan = planDrawing(spec, ctx.model, ctx.bboxOf);
    const ex = plan.views.find((v) => v.exploded)!;
    expect(ex).toBeTruthy();
    // the base stays; the block lifts off it and the lid off the block, further
    const lift = (id: string) => ex.req.items.find((it) => it.id === id)!.xf.filter((x) => x.op === "translate").reduce((z, x) => z + (x.op === "translate" ? x.v[2] : 0), 0);
    expect(ex.req.items.find((it) => it.id === "base")!.xf.length).toBe(ctx.model.parts.find((p) => p.id === "base")!.xf.length);
    expect(lift("lid")).toBeGreaterThan(lift("block"));
    expect(ex.req.items.find((it) => it.id === "block")!.xf.length).toBeGreaterThan(ctx.model.parts.find((p) => p.id === "block")!.xf.length);
    const { sheet } = draw(ctx, spec, "views-exploded");
    const vi = sheet.views.findIndex((v) => v.label.startsWith("EXPLODED"));
    expect(vi).toBeGreaterThanOrEqual(0);
    expect(sheet.shapes.some((s) => /^b\d+$/.test(s.key))).toBe(true);
    expect(specToSource(spec, "asm")).toMatch(/view\("iso", exploded: true\)/);
  });
});

describe("drawing code", () => {
  it("writes every new view call back so it evaluates the same", () => {
    const ctx = load(`${RAIL}
drawing all {
  of: rail
  views: ["front", "top"]
  view("right", crop: [(-10, -10, 0), (10, 10, 10)])
  aux_view("B", normal: (1, 0, 1), at: (250, 0, 5), view: "front", scale: 2)
  break_view(X, -100, 100)
  broken_out("front", at: (235, 0, 5), r: 6)
  breaks: false
}`);
    const spec = block(ctx, "all");
    const text = specToSource(spec, "all");
    const again = evaluate(`${RAIL}\n${text}`).drawings.find((d) => d.name === "all")!;
    const plain = (vs: DrawingSpec["views"]) => vs.map(({ span: _s, ...v }) => v);
    expect(plain(again.views)).toEqual(plain(spec.views));
    expect(again.aux).toEqual(spec.aux);
    expect(again.breaks).toEqual(spec.breaks);
    expect(again.cutaways).toEqual(spec.cutaways);
    expect(again.autoBreak).toBe(false);
  });
});
