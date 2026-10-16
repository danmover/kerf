// End-to-end drawings on the demo designs with the real kernel: automatic
// drawings are planned, projected, composed and written as SVG, PDF and DXF.
// Set DRAWING_OUT to a folder to keep the files for inspection.

import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { KernelCore } from "../src/kernel/core";
import { projectView, type ViewResult } from "../src/kernel/drawing";
import { evaluate } from "../src/lang/evaluator";
import type { Model } from "../src/core/model";
import { composeSheet } from "../src/drawing/compose";
import { autoDrawings, planDrawing } from "../src/drawing/views";
import { sheetsToPdf, sheetToDxf, sheetToSvg } from "../src/drawing/render";
import type { Sheet } from "../src/drawing/sheet";
import type { DrawingSpec } from "../src/drawing/spec";

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
  const volumeOf = (p: { hash: string }) => core.get(p.hash)?.volume;
  return { core, model, bboxOf, volumeOf };
}

function draw(ctx: ReturnType<typeof load>, spec: DrawingSpec, model: Model = ctx.model): Sheet {
  const plan = planDrawing(spec, model, ctx.bboxOf);
  const results = new Map<string, ViewResult>();
  for (const v of plan.views) if (!results.has(v.key)) results.set(v.key, projectView(v.req, (p) => ctx.core.placed(p)));
  return composeSheet({ plan, model, result: (k) => results.get(k), bboxOf: ctx.bboxOf, volumeOf: ctx.volumeOf, today: "2026-10-16" });
}

function save(name: string, sheet: Sheet) {
  if (!OUT) return;
  writeFileSync(join(OUT, `${name}.svg`), sheetToSvg(sheet));
  writeFileSync(join(OUT, `${name}.pdf`), sheetsToPdf([sheet], sheet.title));
  writeFileSync(join(OUT, `${name}.dxf`), sheetToDxf(sheet));
}

const demo = (f: string) => readFileSync(join(__dirname, "../src/demos", f), "utf8");

describe("automatic drawings", () => {
  it("draws every part of the enclosure and the assembly", () => {
    const ctx = load(demo("enclosure.kerf"));
    const specs = autoDrawings(ctx.model, ctx.bboxOf);
    expect(specs.map((s) => s.name)).toEqual(["auto:assembly", "auto:base", "auto:lid"]);
    for (const spec of specs) {
      const sheet = draw(ctx, spec);
      save(`enclosure-${spec.name.slice(5)}`, sheet);
      expect(sheet.pending).toBe(0);
      expect(sheet.views.every((v) => v.state === "ready")).toBe(true);
      expect(sheet.dims.length).toBeGreaterThan(2);
      const svg = sheetToSvg(sheet);
      expect(svg.startsWith("<?xml")).toBe(true);
      expect(svg).toContain(spec.title.replace(/&/g, "&amp;"));
    }
    const base = draw(ctx, specs[1]);
    // overall width and depth link to their parameters
    expect(base.dims.find((d) => d.param === "width")?.value).toBeCloseTo(90, 6);
    expect(base.dims.find((d) => d.param === "depth")?.value).toBeCloseTo(70, 6);
    // the lid screws are called out as a group
    const lid = draw(ctx, specs[2]);
    expect(lid.dims.some((d) => d.text.startsWith("4× Ø3.4 THRU"))).toBe(true);
    const asm = draw(ctx, specs[0]);
    expect(asm.bom.length).toBeGreaterThan(3);
    expect(asm.scale).toBeGreaterThan(0);
  }, 120_000);

  it("draws the reducer's housing, shafts and gears", () => {
    const ctx = load(demo("reducer.kerf"));
    const specs = autoDrawings(ctx.model, ctx.bboxOf);
    const names = specs.map((s) => s.name);
    expect(names).toContain("auto:housing");
    expect(names).toContain("auto:g2");
    for (const spec of specs.filter((s) => ["auto:housing", "auto:out_shaft", "auto:g2", "auto:assembly"].includes(s.name))) {
      const sheet = draw(ctx, spec);
      save(`reducer-${spec.name.slice(5)}`, sheet);
      expect(sheet.pending).toBe(0);
    }
  }, 240_000);
});

describe("drawing blocks", () => {
  it("honours views, sections, details, dimensions and fits from the source", () => {
    const src = `design "Plate"
param w = 60mm
part plate {
  body box(w, 40, 8)
  cut hole(M4, through: true, at: (-20, 0, 8))
  cut hole(M4, through: true, at: (20, 0, 8))
  cut hole(10, depth: 4, at: (0, 0, 8))
}
drawing plate_dwg {
  title: "Mounting plate"
  of: [plate]
  sheet: "A4"
  scale: "1:1"
  views: ["front", "top"]
  section("A", at: (0, 0, 4), normal: -Y, view: "top")
  detail("B", view: "top", at: (20, 0, 8), r: 5, scale: 4)
  dim((-30, -20, 8), (30, -20, 8), view: "top", tol: 0.1)
  diameter((0, 0, 8), 10, view: "top", fit: "H7")
  note("Anodise after machining")
}
`;
    const ctx = load(src);
    const spec = ctx.model.drawings[0];
    expect(ctx.model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const sheet = draw(ctx, spec);
    save("plate", sheet);
    expect(sheet.size).toBe("A4");
    expect(sheet.scale).toBe(1);
    expect(sheet.views.map((v) => v.kind)).toEqual(["front", "top", "section", "detail"]);
    expect(sheet.views.find((v) => v.kind === "detail")?.label).toBe("DETAIL B (4:1)");
    const tol = sheet.dims.find((d) => !d.auto && d.kind === "linear");
    expect(tol?.text).toBe("60 ±0.1");
    const fit = sheet.dims.find((d) => d.fit === "H7");
    expect(fit?.tol?.[0]).toBeCloseTo(0.015, 6);
    expect(fit?.tol?.[1]).toBeCloseTo(0, 6);
    expect(sheet.notes).toContain("ANODISE AFTER MACHINING");
    const pdf = sheetsToPdf([sheet]);
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toBe("%PDF-1.4");
    const dxf = sheetToDxf(sheet);
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
    expect(dxf).toContain("%%c10");
  }, 60_000);
});
