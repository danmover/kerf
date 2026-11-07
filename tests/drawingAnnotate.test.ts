// Drawing annotations a checker expects beyond lengths and diameters:
// radii, chamfers and angles read off the views, ordinate and chain
// dimensioning, hole tables, revision tables, surface texture and weld
// symbols, and the drawing-block calls for each. Set DRAWING_OUT to keep the
// sheets for a look.

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
  const volumeOf = (p: { hash: string }) => core.get(p.hash)?.volume;
  return { core, model, bboxOf, volumeOf, src };
}

function draw(ctx: ReturnType<typeof load>, spec: DrawingSpec, name?: string): Sheet {
  const plan = planDrawing(spec, ctx.model, ctx.bboxOf);
  const results = new Map<string, ViewResult>();
  for (const v of plan.views) if (!results.has(v.key)) results.set(v.key, projectView(v.req, (p) => ctx.core.placed(p)));
  const reevaluate = (overrides: Record<string, number>) => evaluate(ctx.src, { overrides });
  const sheet = composeSheet({ plan, model: ctx.model, result: (k) => results.get(k), bboxOf: ctx.bboxOf, volumeOf: ctx.volumeOf, today: "2026-11-07", reevaluate });
  if (OUT && name) {
    writeFileSync(join(OUT, `${name}.svg`), sheetToSvg(sheet));
    writeFileSync(join(OUT, `${name}.pdf`), sheetsToPdf([sheet], sheet.title));
  }
  return sheet;
}

const auto = (ctx: ReturnType<typeof load>, name: string) => autoDrawings(ctx.model, ctx.bboxOf).find((s) => s.name === name)!;
const block = (ctx: ReturnType<typeof load>, name: string) => ctx.model.drawings.find((d) => d.name === name)!;

// a milled bracket: rounded corners, chamfered top edges, a sloped end and a hole pattern
const BRACKET = `
part bracket {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body prism([(-50, 0), (40, 0), (50, 20), (50, 30), (-50, 30)], h: 40, at: (0, -20, 0), dir: Y)
  chamfer(1, edges: facing(Z))
  for x in [-30, -10, 10] {
    cut hole(M5, through: true, at: (x, 0, 31), dir: -Z)
  }
}
`;

describe("radii, chamfers and angles from the views", () => {
  it("calls out chamfers and the sloped end's angle", () => {
    const ctx = load(BRACKET);
    const sheet = draw(ctx, auto(ctx, "auto:bracket"), "annot-bracket");
    const texts = sheet.dims.map((d) => d.text);
    expect(sheet.dims.some((d) => d.kind === "chamfer" && /1 × 45°/.test(d.text))).toBe(true);
    const ang = sheet.dims.filter((d) => d.kind === "angle");
    expect(ang.length).toBeGreaterThan(0);
    // the slope rises 20 over 10: 63.4° to the base, or its supplement where it meets the top
    expect(ang.some((d) => /^(63\.4|116\.6|153\.4|26\.6)°/.test(d.text))).toBe(true);
    expect(texts.join(" ")).not.toMatch(/NaN/);
  });

  it("calls out rounded corners and fillets once by radius", () => {
    const ctx = load(`
part plate {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(80, 50, 8, at: (0, 0, 0), r: 6)
  fillet(2, edges: facing(Z))
  cut hole(d: 6.6, through: true, at: (0, 0, 9), dir: -Z)
}
`);
    const sheet = draw(ctx, auto(ctx, "auto:plate"), "annot-radii");
    const radii = sheet.dims.filter((d) => d.kind === "radius");
    expect(radii.some((d) => /^4× R6$/.test(d.text))).toBe(true);
    // the hole is not a radius
    expect(radii.some((d) => /R3\.3/.test(d.text))).toBe(false);
    // each radius once on the sheet
    const vals = radii.map((d) => d.text.replace(/^\d+× /, ""));
    expect(new Set(vals).size).toBe(vals.length);
  });
});

// a plate with a scatter of holes no row of dimensions can hold
const SCATTER = `
part panel {
  material: "Aluminium 5052"
  process: mfg.cnc_mill()
  body box(160, 90, 4, at: (80, 45, 0))
  for p in [(12, 10), (31, 22), (47, 15), (66, 40), (83, 27), (98, 61), (117, 12), (131, 74), (146, 50)] {
    cut hole(d: 4.5, through: true, at: (p[0], p[1], 5), dir: -Z)
  }
}
`;

describe("ordinate, chain and hole tables", () => {
  it("turns to ordinates when a view has too many positions for rows", () => {
    const ctx = load(SCATTER);
    const sheet = draw(ctx, auto(ctx, "auto:panel"), "annot-ordinate-auto");
    const ords = sheet.dims.filter((d) => d.kind === "ordinate");
    expect(ords.length).toBeGreaterThanOrEqual(10);
    expect(ords.some((d) => d.text === "0")).toBe(true);
    expect(ords.some((d) => d.text === "160")).toBe(true);
    expect(sheet.warnings.join(" ")).not.toMatch(/not dimensioned/);
  });

  it("lists holes in a hole table instead of dimensioning them", () => {
    const ctx = load(`${SCATTER}
drawing panel_dwg {
  title: "Panel"
  of: panel
  hole_table: true
  revision("A", "First issue", date: "2026-11-01", by: "dm")
  revision("B", "Holes moved for M4 screws", date: "2026-11-07", by: "dm")
}
`);
    const sheet = draw(ctx, block(ctx, "panel_dwg"), "annot-hole-table");
    expect(sheet.holeTable?.rows.length).toBe(9);
    const a1 = sheet.holeTable!.rows.find((r) => r.tag === "A1")!;
    expect(a1.size).toMatch(/Ø4\.5 THRU/);
    // positions measured from the lower left corner
    expect(sheet.holeTable!.rows.some((r) => r.x === 12 && r.y === 10)).toBe(true);
    expect(sheet.dims.some((d) => /Feature (position|ordinate)/.test(d.label))).toBe(false);
    expect(sheet.dims.some((d) => d.kind === "callout" && /Ø4\.5/.test(d.text))).toBe(false);
    expect(sheet.revisions.map((r) => r.rev)).toEqual(["A", "B"]);
    expect(sheet.shapes.some((s) => s.t === "text" && s.s === "REVISIONS")).toBe(true);
    // the title block takes the last revision
    expect(sheet.shapes.some((s) => s.key === "tb" && s.t === "text" && s.s === "B")).toBe(true);
  });

  it("dimensions positions as ordinates or chains when the block asks", () => {
    const src = (style: string) => `
part strip {
  material: "Steel S275"
  process: mfg.cnc_mill()
  body box(120, 30, 6, at: (60, 15, 0))
  for x in [15, 40, 75, 100] {
    cut hole(d: 5.5, through: true, at: (x, 15, 7), dir: -Z)
  }
}
drawing strip_dwg {
  title: "Strip"
  of: strip
  dim_style: "${style}"
}
`;
    const ord = load(src("ordinate"));
    const s1 = draw(ord, block(ord, "strip_dwg"), "annot-ordinate");
    const xs = s1.dims.filter((d) => d.kind === "ordinate" && /horizontal/.test(d.label)).map((d) => Number(d.text));
    expect(xs).toEqual(expect.arrayContaining([0, 15, 40, 75, 100, 120]));
    // the edge-to-edge ordinates already give the length in that view
    const top = s1.views.findIndex((v) => v.name === "top");
    expect(s1.dims.some((d) => d.view === top && d.kind === "linear" && d.value === 120)).toBe(false);
    const chain = load(src("chain"));
    const s2 = draw(chain, block(chain, "strip_dwg"), "annot-chain");
    const spans = s2.dims.filter((d) => /Feature spacing \(horizontal\)/.test(d.label)).map((d) => d.value);
    expect(spans).toEqual(expect.arrayContaining([15, 25, 35]));
  });
});

describe("written in the drawing block", () => {
  const SRC = `${BRACKET}
drawing bracket_dwg {
  title: "Bracket"
  of: bracket
  angle((-40, 0, 0), (-50, 0, 20), (-50, 0, 0), view: "front", tol: 0.5)
  radius((0, 0, 30), 12, view: "front", text: "R12 MAX")
  chamfer((-50, 0, 29.5), 1, view: "front")
  arc_length((0, 0, 0), (20, 0, 0), (0, 0, 20), view: "front")
  ordinate([(-30, 0, 0), (10, 0, 0)], view: "top", origin: (-50, -20, 0), axis: "x")
  roughness((-50, 0, 15), 0.8, view: "front", process: "ground", lay: "=")
  roughness(ra: 6.3)
  weld((50, 0, 10), "fillet", size: 4, length: "50", all_round: true, field: true, note: "135", view: "front")
  revision("C", "Slope added")
}
`;
  it("draws each one and reports it", () => {
    const ctx = load(SRC);
    const sheet = draw(ctx, block(ctx, "bracket_dwg"), "annot-manual");
    const by = (k: string) => sheet.dims.filter((d) => d.kind === k && !d.auto);
    expect(by("angle")[0].text).toMatch(/^63\.4° ±0\.5°/);
    expect(by("angle")[0].value).toBeCloseTo(63.435, 2);
    expect(by("radius")[0].text).toBe("R12 MAX");
    expect(by("chamfer")[0].text).toBe("1 × 45°");
    expect(by("arc")[0].value).toBeCloseTo(Math.PI * 10, 3);
    expect(by("ordinate").map((d) => d.text)).toEqual(["0", "20", "60"]);
    expect(by("roughness")[0].text).toMatch(/Ra 0\.8, GROUND, lay =/);
    expect(by("weld")[0].text).toMatch(/fillet weld a4 × 50, arrow side, all round, site weld, 135/);
    expect(sheet.symbols.some((s) => s.kind === "roughness" && /whole part Ra 6\.3/.test(s.text))).toBe(true);
    expect(sheet.notes.join(" ")).toMatch(/SURFACE TEXTURE Ra 6\.3/);
    expect(sheet.warnings).toEqual([]);
  });

  it("writes them back to source that evaluates to the same drawing", () => {
    const ctx = load(SRC);
    const spec = block(ctx, "bracket_dwg");
    const text = specToSource({ ...spec, holeTable: true, dimStyle: "ordinate" }, "again");
    for (const w of ["angle(", "radius(", "chamfer(", "arc_length(", "ordinate(", "roughness(", "weld(", "revision(", "hole_table: true", 'dim_style: "ordinate"']) expect(text).toContain(w);
    const again = evaluate(`${BRACKET}\n${text}`).drawings.find((d) => d.name === "again")!;
    expect(again.marks).toEqual(spec.marks.map((m) => ({ ...m, span: expect.anything() })));
    expect(again.welds.length).toBe(1);
    expect(again.roughness.length).toBe(2);
    expect(again.revisions[0].rev).toBe("C");
  });

  it("puts the seat's surface texture symbol on its callout", () => {
    const ctx = load(`
part plate {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(60, 60, 10, at: (0, 0, 0))
  cut cylinder(d: 22, h: 7.01, at: (0, 0, 3), dir: Z)
  cut cylinder(d: 12, h: 4, at: (0, 0, -1), dir: Z)
}
component brg = lib.bearing("608") { at: (0, 0, 3), axis: Z }
`);
    const sheet = draw(ctx, auto(ctx, "auto:plate"), "annot-seat");
    const seat = sheet.dims.find((d) => d.role?.includes("608"))!;
    expect(seat.finish).toBe("Ra 1.6");
    expect(seat.text).toMatch(/Ra 1\.6/);
  });
});
