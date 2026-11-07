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
import { autoDrawings, drawnCopies, planDrawing } from "../src/drawing/views";
import { dxfText, sheetsToPdf, sheetToDxf, sheetToSvg } from "../src/drawing/render";
import type { Sheet } from "../src/drawing/sheet";
import { fitText, textWidth } from "../src/drawing/text";
import type { DrawingSpec } from "../src/drawing/spec";
import { addBlockLine, blockRange, ensureBlock, setBlockProp, setDimTolerance, specToSource } from "../src/drawing/source";

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
  return { core, model, bboxOf, volumeOf, src };
}

function draw(ctx: ReturnType<typeof load>, spec: DrawingSpec, model: Model = ctx.model): Sheet {
  const plan = planDrawing(spec, model, ctx.bboxOf);
  const results = new Map<string, ViewResult>();
  for (const v of plan.views) if (!results.has(v.key)) results.set(v.key, projectView(v.req, (p) => ctx.core.placed(p)));
  const reevaluate = (overrides: Record<string, number>) => evaluate(ctx.src, { overrides });
  return composeSheet({ plan, model, result: (k) => results.get(k), bboxOf: ctx.bboxOf, volumeOf: ctx.volumeOf, today: "2026-10-16", reevaluate });
}

function save(name: string, sheet: Sheet) {
  if (!OUT) return;
  writeFileSync(join(OUT, `${name}.svg`), sheetToSvg(sheet));
  writeFileSync(join(OUT, `${name}.pdf`), sheetsToPdf([sheet], sheet.title));
  writeFileSync(join(OUT, `${name}.dxf`), sheetToDxf(sheet));
}

const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
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
    // the vents go through the lid (the kernel measures no material behind
    // them), and the screw clearance pockets open on the underside
    expect(lid.dims.filter((d) => / DEEP/.test(d.text)).map((d) => d.text)).toEqual(["4× Ø3.4 THRU · M3 CLEARANCE · Ø10 × 2.1 DEEP FAR SIDE"]);
    expect(lid.dims.map((d) => d.text)).toContain("7× 2.4 × 26 R1.1 THRU");
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
      if (spec.name === "auto:housing") expect(sheet.dims.some((d) => /Ø9 THRU/.test(d.text))).toBe(true);
    }
  }, 240_000);

  it("draws copies once with how many to make, keeps a left and a right hand apart and leaves bought parts out", () => {
    const ctx = load(`
part foot_1 { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (-100, 0, 0), r: 3)  cut hole(d: 5, through: true, at: (-110, 5, 10), dir: -Z) }
part foot_2 { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (100, 0, 0), r: 3)  cut hole(d: 5, through: true, at: (90, 5, 10), dir: -Z) }
part foot_3 { material: "PETG"  process: mfg.fdm()  rotate: (0, 0, 30)  body rotate(shape_of(foot_1), 30) }
part bracket_left { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (0, 80, 0))  add box(10, 30, 30, at: (15, 80, 10))  cut hole(d: 5, through: true, at: (-10, 72, 10), dir: -Z) }
part bracket_right { material: "PETG"  process: mfg.fdm()  body mirror(shape_of(bracket_left), normal: X) }
part plate_a { material: "PETG"  process: mfg.fdm()  body box(60, 30, 4, at: (0, -80, 0))  cut hole(d: 5, through: true, at: (-20, -80, 4), dir: -Z) }
part plate_b { material: "PETG"  process: mfg.fdm()  body box(60, 30, 4, at: (0, -140, 0))  cut hole(d: 5, through: true, at: (-10, -140, 4), dir: -Z) }
part strap_left { material: "PETG"  process: mfg.fdm()  body box(50, 12, 3, at: (0, 200, 0))  cut hole(d: 4, through: true, at: (-15, 200, 3), dir: -Z) }
part strap_right { material: "PETG"  process: mfg.fdm()  body mirror(shape_of(strap_left), normal: X) }
part spacer { material: "Nylon"  process: false  body cylinder(d: 8, h: 5, at: (0, 150, 0)) }
`);
    const meshOf = (p: { hash: string }) => (ctx.core.get(p.hash) ? ctx.core.mesh(p.hash, "preview") : undefined);
    const specs = autoDrawings(ctx.model, ctx.bboxOf, meshOf as never);
    const titles = Object.fromEntries(specs.map((s) => [s.name, s.title]));
    // the feet typed out twice and the one turned into place with shape_of() are one part
    expect(titles["auto:foot_1"]).toBe("Foot (make 3)");
    expect(titles["auto:foot_2"]).toBeUndefined();
    expect(titles["auto:foot_3"]).toBeUndefined();
    expect([...drawnCopies(ctx.model, meshOf as never)].sort()).toEqual([
      ["foot_2", "foot_1"],
      ["foot_3", "foot_1"],
      ["strap_right", "strap_left"],
    ]);
    // the mirror image of a strap that is symmetric the other way is the same strap turned over
    expect(titles["auto:strap_left"]).toBe("Strap (make 2)");
    // a mirror image is another part, and so is a plate of the same size with its hole somewhere else
    expect(titles["auto:bracket_left"]).toBe("Bracket left");
    expect(titles["auto:bracket_right"]).toBe("Bracket right");
    expect(titles["auto:plate_a"]).toBe("Plate a");
    expect(titles["auto:plate_b"]).toBe("Plate b");
    // bought or already on hand
    expect(titles["auto:spacer"]).toBeUndefined();
    const sheet = draw(ctx, specs.find((s) => s.name === "auto:foot_1")!);
    expect(sheet.pending).toBe(0);
  }, 120_000);
});

describe("parameter links", () => {
  const plate = (holes: string) => `design "Links"
param w = 60mm
param boss_h = 40mm
param pitch = 40mm
param boss_d = 12mm
part plate {
  body box(w, 50, 8)
  add cylinder(d: boss_d, h: boss_h, at: (0, 15, 8))
${holes}
}
`;

  it("links a dimension to the parameter that drives it, not one that only shares its value", () => {
    const ctx = load(plate("  cut hole(M4, through: true, at: (-pitch / 2, -10, 8))\n  cut hole(M4, through: true, at: (pitch / 2, -10, 8))"));
    const sheet = draw(ctx, autoDrawings(ctx.model, ctx.bboxOf).find((s) => s.name === "auto:plate")!);
    const spacing = sheet.dims.find((d) => /spacing \(horizontal\)/.test(d.label) && close(d.value, 40));
    expect(spacing?.param).toBe("pitch");
    expect(sheet.dims.find((d) => /Overall width/.test(d.label))?.param).toBe("w");
    expect(sheet.dims.find((d) => /Boss Ø12/.test(d.label))?.param).toBe("boss_d");
    // nothing measures boss_h one for one: the overall height is 8 + boss_h
    expect(sheet.dims.some((d) => d.param === "boss_h")).toBe(false);
  }, 60_000);

  it("leaves a dimension unlinked when its value comes from a literal", () => {
    // boss_h is the only 40 mm parameter here, which used to be enough for a link
    const ctx = load(plate("  cut hole(M4, through: true, at: (-20, -10, 8))\n  cut hole(M4, through: true, at: (20, -10, 8))").replace("param pitch = 40mm\n", ""));
    const sheet = draw(ctx, autoDrawings(ctx.model, ctx.bboxOf).find((s) => s.name === "auto:plate")!);
    const spacing = sheet.dims.find((d) => /spacing \(horizontal\)/.test(d.label) && close(d.value, 40));
    expect(spacing).toBeDefined();
    expect(spacing!.param).toBeUndefined();
  }, 60_000);
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
    // the whole file stays ASCII, with other characters escaped
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(dxf)).toBe(true);
    expect(dxfText("4× Ø3.4 ±0.1 −0.05 Größe")).toBe("4\\U+00D7 %%c3.4 %%p0.1 -0.05 Gr\\U+00F6\\U+00DFe");
    // the document title is UTF-16 with a byte order mark
    const titled = new TextDecoder("latin1").decode(sheetsToPdf([sheet], "Größe ×"));
    expect(titled).toContain("/Title <FEFF0047007200F600DF0065002000D7>");
  }, 60_000);
});

describe("editing drawings from the sheet", () => {
  it("keeps a tolerance on an automatic dimension when the design changes", () => {
    const src = demo("enclosure.kerf");
    const ctx = load(src);
    const spec = autoDrawings(ctx.model, ctx.bboxOf).find((s) => s.name === "auto:base")!;
    const sheet = draw(ctx, spec);
    const width = sheet.dims.find((d) => d.param === "width")!;
    expect(width.id).toMatch(/^top:/);
    // the automatic drawing becomes a block, and the tolerance names the dimension
    const block = ensureBlock(src, ctx.model, spec);
    expect(block.name).toBe("base_drawing");
    const viewName = sheet.views[width.view].name;
    let next = setDimTolerance(block.src, block.name, width, viewName, { kind: "pm", t: 0.1 });
    expect(next).toContain(`tol("${width.id}", 0.1)`);
    next = setBlockProp(next, block.name, "revision", '"B"');

    const ctx2 = load(next);
    expect(ctx2.model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const sheet2 = draw(ctx2, ctx2.model.drawings[0]);
    expect(sheet2.warnings).toEqual([]);
    expect(sheet2.spec.revision).toBe("B");
    const w2 = sheet2.dims.find((d) => d.param === "width")!;
    expect(w2.text).toBe("90 ±0.1");
    expect(sheetToSvg(sheet2)).toContain("KRF-BASE<");

    // a wider enclosure: the same dimension, still toleranced, and no stale copy
    const wider = load(next.replace(/param width\s*=\s*90mm/, "param width = 95mm"));
    const sheet3 = draw(wider, wider.model.drawings[0]);
    save("enclosure-base-95", sheet3);
    // five millimetres wider still fits the same sheet and scale
    expect([sheet3.size, sheet3.scale]).toEqual([sheet2.size, sheet2.scale]);
    const w3 = sheet3.dims.filter((d) => d.param === "width");
    expect(w3.map((d) => d.text)).toEqual(["95 ±0.1"]);
    expect(sheet3.dims.some((d) => d.text.startsWith("90"))).toBe(false);

    // changing it edits the tol() line, and "general" removes it
    const changed = setDimTolerance(next, block.name, w2, viewName, { kind: "limits", upper: 0.1, lower: -0.05 });
    expect(changed).toContain(`tol("${width.id}", (0.1, -0.05))`);
    expect(changed.match(/tol\(/g)?.length).toBe(1);
    const removed = setDimTolerance(next, block.name, w2, viewName, { kind: "none" });
    expect(removed).not.toContain("tol(");
    expect(load(removed).model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  }, 120_000);

  it("writes a drawing block that reads back as the same drawing", () => {
    const ctx = load(demo("enclosure.kerf"));
    const spec = autoDrawings(ctx.model, ctx.bboxOf).find((s) => s.name === "auto:lid")!;
    const block = specToSource({ ...spec, tols: [{ id: "top:x", fit: "H7", span: { start: 0, end: 0 } }] }, "lid_drawing");
    const back = load(`${demo("enclosure.kerf")}\n${block}\n`);
    const d = back.model.drawings[0];
    expect(d.of).toEqual(spec.of);
    expect(d.views.map((v) => v.kind)).toEqual(spec.views.map((v) => v.kind));
    expect(d.tols.map((t) => [t.id, t.fit])).toEqual([["top:x", "H7"]]);
  }, 60_000);
});

describe("finding drawing blocks in the source", () => {
  const src = `param drawing = 3mm
// drawing plate_dwg { is only a comment here
drawing plate_dwg {
  title: "Plate { and } braces"
  /* TODO: } check the fits */
  views: ["front"] // } not the end either
}
part after { body box(10, 10, drawing) }
`;

  it("skips braces in strings and comments", () => {
    const r = blockRange(src, "plate_dwg")!;
    expect(src.slice(r.start, r.end).startsWith("drawing plate_dwg {\n  title")).toBe(true);
    expect(src.slice(r.start, r.end).endsWith('// } not the end either\n}')).toBe(true);
    const next = addBlockLine(src, "plate_dwg", 'note("Deburr")');
    expect(next).toContain('// } not the end either\n  note("Deburr")\n}\npart after');
    expect(evaluate(next).drawings[0].notes).toContain("Deburr");
  });

  it("still parses a parameter called drawing", () => {
    const model = evaluate(src);
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(model.params.find((p) => p.name === "drawing")?.value).toBeCloseTo(3, 9);
    expect(model.drawings.map((d) => d.name)).toEqual(["plate_dwg"]);
  });
});

describe("fitting text", () => {
  it("keeps the longest start of the text that fits with an ellipsis", () => {
    const s = "Mounting plate for the two-stage reducer housing";
    for (const w of [4, 12, 30, 61]) {
      let out = s;
      while (out.length > 1 && textWidth(out + "…", 3.5, false) > w) out = out.slice(0, -1);
      expect(fitText(s, 3.5, w)).toBe(out.trimEnd() + "…");
    }
    expect(fitText(s, 3.5, 1000)).toBe(s);
  });
});
