// Smarter automatic drawings: the views a part needs, fits and roles read
// from the parts around it (bearing seats, dowel holes, shaft journals),
// gear centre distances toleranced from their backlash, and datums with
// geometric tolerances for machined parts. Set DRAWING_OUT to keep the
// sheets for a look.

import { beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { KernelCore } from "../src/kernel/core";
import { projectAssembly, projectView, type ViewResult } from "../src/kernel/drawing";
import { evaluate } from "../src/lang/evaluator";
import { composeSheet } from "../src/drawing/compose";
import { autoDrawings, autoViews, planDrawing } from "../src/drawing/views";
import { sheetsToPdf, sheetToSvg } from "../src/drawing/render";
import type { Sheet } from "../src/drawing/sheet";
import type { DrawingSpec } from "../src/drawing/spec";
import { holePosition } from "../src/drawing/gdt";

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
  const sheet = composeSheet({ plan, model: ctx.model, result: (k) => results.get(k), bboxOf: ctx.bboxOf, volumeOf: ctx.volumeOf, today: "2026-11-06", reevaluate });
  if (OUT && name) {
    writeFileSync(join(OUT, `${name}.svg`), sheetToSvg(sheet));
    writeFileSync(join(OUT, `${name}.pdf`), sheetsToPdf([sheet], sheet.title));
  }
  return sheet;
}

const demo = (f: string) => readFileSync(join(__dirname, "../src/demos", f), "utf8");
const auto = (ctx: ReturnType<typeof load>, name: string) => autoDrawings(ctx.model, ctx.bboxOf).find((s) => s.name === name)!;

// a milled bearing plate: a 608 seat, four M4 clearance holes, two dowel holes
const PLATE = `
param pitch = 64
part plate {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(80, 60, 10, at: (0, 0, 0))
  cut cylinder(d: 22, h: 7.01, at: (0, 0, 3), dir: Z)
  cut cylinder(d: 12, h: 4, at: (0, 0, -1), dir: Z)
  for x in [-pitch / 2, pitch / 2] {
    for y in [-22, 22] {
      cut hole(M4, through: true, at: (x, y, 11), dir: -Z)
    }
  }
  for x in [-20, 20] {
    cut hole(d: 4, depth: 6, at: (x, 18, 10.01), dir: -Z)
  }
}
component brg = lib.bearing("608") { at: (0, 0, 3), axis: Z }
component pins = lib.dowel(d: 4, length: 12) { at: [(-20, 18, 4), (20, 18, 4)], axis: Z }
`;

// a turned shaft on two 608 bearings, with a gear on its end
const SHAFT = `
part shaft {
  material: "Steel"
  process: mfg.cnc_lathe(axis: X)
  body revolve([(0, 0), (4, 0), (4, 30), (6, 30), (6, 40), (4, 40), (4, 70), (3, 70), (3, 90), (0, 90)], at: (0, 0, 0), dir: X)
}
component b1 = lib.bearing("608") { at: (2, 0, 0), axis: X }
component b2 = lib.bearing("608") { at: (55, 0, 0), axis: X }
component g = lib.spur_gear(m: 1, z: 30, width: 8, bore: 6) { at: (75, 0, 0), axis: X }
`;

describe("views the part needs", () => {
  it("draws a plate whose features all run one way in two views and an iso", () => {
    const ctx = load(PLATE);
    expect(autoViews(ctx.model.parts.find((p) => p.name === "plate")!)).toEqual(["front", "top", "iso"]);
  });

  it("keeps three views when features run more than one way", () => {
    const ctx = load(demo("reducer.kerf"));
    expect(autoViews(ctx.model.parts.find((p) => p.name === "housing")!)).toEqual(["front", "top", "right", "iso"]);
  });
});

describe("fits and roles from the assembly", () => {
  it("gives a bearing seat H7 and dowel holes H7 on a machined plate, with their job in the callout", () => {
    const ctx = load(PLATE);
    const sheet = draw(ctx, auto(ctx, "auto:plate"), "plate");
    const seat = sheet.dims.find((d) => d.text.includes("SEAT FOR 608 BEARING"))!;
    expect(seat).toBeTruthy();
    expect(seat.text).toMatch(/Ø22 H7 \(\+0\.021\/0\)/);
    expect(seat.fit).toBe("H7");
    const dowel = sheet.dims.find((d) => d.text.includes("FOR Ø4 DOWEL"))!;
    expect(dowel.text).toMatch(/Ø4 H7/);
  });

  it("gives the shaft's bearing journals k6 and makes the first one datum A", () => {
    const ctx = load(SHAFT);
    const sheet = draw(ctx, auto(ctx, "auto:shaft"), "shaft");
    const journals = sheet.dims.filter((d) => d.role === "608 BEARING SEAT");
    expect(journals.length).toBe(1);
    expect(journals[0].fit).toBe("k6");
    expect(journals[0].datum).toBe("A");
    // the gear seat runs true to the bearing axis
    const gear = sheet.dims.find((d) => d.role?.startsWith("GEAR SEAT"))!;
    expect(gear.frames?.[0]).toMatch(/^runout 0\.02 \| A$/);
    expect(sheet.datums.map((d) => d.letter)).toEqual(["A"]);
  });
});

describe("datums and geometric tolerances", () => {
  it("frames a machined plate on its seating face and centre planes, with basic positions", () => {
    const ctx = load(PLATE);
    const sheet = draw(ctx, auto(ctx, "auto:plate"));
    expect(sheet.datums.map((d) => d.letter)).toEqual(["A", "B", "C"]);
    expect(sheet.datums[0].what).toMatch(/^bottom face/);
    // M4 clearance holes float: T = 4.5 − 4 at maximum material
    const holes = sheet.dims.find((d) => d.text.startsWith("4× Ø4.5 THRU"))!;
    expect(holes.frames).toEqual(["position Ø0.5 (M) | A | B | C"]);
    // the seat is square to the face it sits on
    const seat = sheet.dims.find((d) => d.text.includes("SEAT FOR 608 BEARING"))!;
    expect(seat.frames?.some((f) => f.startsWith("position Ø0.03 |"))).toBe(true);
    // feature positions are basic; overall sizes keep their tolerance
    const positions = sheet.dims.filter((d) => /Feature (spacing|position)|Pattern pitch/.test(d.label));
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((d) => d.basic && d.general === undefined)).toBe(true);
    expect(sheet.dims.filter((d) => d.label.startsWith("Overall")).every((d) => !d.basic)).toBe(true);
    // the overall width carries datum B
    expect(sheet.dims.some((d) => d.datum === "B" && d.label.startsWith("Overall"))).toBe(true);
    expect(sheet.notes.some((n) => n.includes("ISO 1101"))).toBe(true);
    expect(sheet.notes).toContain("SURFACE TEXTURE Ra 3.2 µm UNLESS STATED.");
  });

  it("turns frames off with gdt: false and on for a printed part with gdt: true", () => {
    const ctx = load(PLATE);
    const off = draw(ctx, { ...auto(ctx, "auto:plate"), gdt: false });
    expect(off.datums).toEqual([]);
    expect(off.dims.some((d) => d.frames?.length || d.basic)).toBe(false);
    const printed = load(demo("enclosure.kerf"));
    expect(draw(printed, auto(printed, "auto:lid")).datums).toEqual([]);
    const on = draw(printed, { ...auto(printed, "auto:lid"), gdt: true }, "lid-gdt");
    // its automatic section is A-A, so the datums skip that letter
    expect(on.datums.map((d) => d.letter)).toEqual(["B", "C", "D"]);
  });

  it("lets a gdt() call replace the frame Kerf chose", () => {
    const ctx = load(PLATE);
    const spec = auto(ctx, "auto:plate");
    const first = draw(ctx, spec);
    const holes = first.dims.find((d) => d.text.startsWith("4× Ø4.5 THRU"))!;
    const span = { start: 0, end: 0 };
    const sheet = draw(ctx, { ...spec, frames: [{ id: holes.id!, kind: "position", tol: 0.3, datums: ["A", "B"], mmc: false, span }] });
    expect(sheet.dims.find((d) => d.id === holes.id)!.frames).toEqual(["position Ø0.3 | A | B"]);
  });

  it("reads gdt: and gdt() in a drawing block", () => {
    const m = evaluate(`${PLATE}\ndrawing plate_dwg {\n  of: plate\n  gdt: true\n  gdt("top:4-holes-o4.5", "position", 0.25, "A B C", mmc: true)\n}\n`);
    const d = m.drawings.find((x) => x.name === "plate_dwg")!;
    expect(d.gdt).toBe(true);
    expect(d.viewsAuto).toBe(true);
    expect(d.frames).toEqual([expect.objectContaining({ id: "top:4-holes-o4.5", kind: "position", tol: 0.25, datums: ["A", "B", "C"], mmc: true })]);
    const bad = evaluate(`${PLATE}\ndrawing x {\n  of: plate\n  gdt("top:a", "wobble", 0.1)\n}\n`);
    expect(bad.diagnostics.some((d) => /kind should be one of/.test(d.message))).toBe(true);
  });

  it("works out fastener position tolerances from the clearance", () => {
    const hole = (thread: string, d: number, fit?: string) => ({ t: "hole" as const, part: "p", d, depth: 5, through: true, at: [0, 0, 0] as [number, number, number], dir: [0, 0, -1] as [number, number, number], thread, fit });
    expect(holePosition(hole("M3", 3.4), "subtractive")).toEqual({ tol: 0.4, mmc: true });
    // a tapped hole holds its screw: half the mating clearance
    expect(holePosition(hole("M3", 2.5, "tap"), "subtractive")).toEqual({ tol: 0.2, mmc: true });
    expect(holePosition(hole("M5", 4.2, "insert"), "formative").tol).toBe(0.25);
  });
});

describe("gear centre distances", () => {
  it("dimensions the reducer housing's shaft spacings with a tolerance from the backlash", () => {
    const ctx = load(demo("reducer.kerf"));
    const sheet = draw(ctx, auto(ctx, "auto:housing"), "housing");
    const cds = sheet.dims.filter((d) => d.label.startsWith("Gear centre distance"));
    expect(cds.length).toBe(2);
    for (const d of cds) {
      expect(d.tol![0]).toBeGreaterThan(0.05);
      expect(d.tol![0]).toBeLessThan(0.15);
      expect(d.text).toMatch(/±0\.\d+/);
    }
    // the printed housing can't promise that: the drawing says so
    expect(sheet.warnings.some((w) => /gear centre distance needs ±/.test(w))).toBe(true);
    expect(sheet.notes).toContain("GEAR CENTRE DISTANCES SET THE BACKLASH: HOLD THEIR TOLERANCE.");
    // printed parts get their build direction
    expect(sheet.notes.some((n) => n.startsWith("PRINT ON THE FRONT FACE"))).toBe(true);
    // bearing seats are named, without an ISO fit on a print
    const seat = sheet.dims.find((d) => d.text.includes("SEAT FOR 625 BEARING"))!;
    expect(seat.fit).toBeUndefined();
  });
});

// a vane set at 45° in the design, with a blind pocket and a through hole
const VANE = `
part vane {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(40, 4, 60, at: (0, 0, 30))
  cut cylinder(d: 10, h: 2, at: (0, 2.01, 40), dir: -Y)
  cut hole(d: 5, through: true, at: (0, 3, 15), dir: -Y)
  rotate: (0, 0, 45)
  at: (100, 50, 0)
}
`;

describe("parts placed at an angle", () => {
  it("draws a part turned 45° square to its own faces, with true lengths and a section that cuts it", () => {
    const ctx = load(VANE);
    const spec = auto(ctx, "auto:vane");
    const plan = planDrawing(spec, ctx.model, ctx.bboxOf);
    expect(plan.parts[0].worldXf).toBeTruthy();
    const sheet = draw(ctx, spec, "vane");
    const values = sheet.dims.filter((d) => d.kind !== "callout").map((d) => d.value);
    expect(values.some((v) => Math.abs(v - 40) < 1e-6)).toBe(true);
    expect(values.some((v) => Math.abs(v - 60) < 1e-6)).toBe(true);
    // nothing measured across the diagonal of the turned outline
    expect(values.some((v) => Math.abs(v - (40 + 4) / Math.SQRT2) < 0.01)).toBe(false);
    const sec = plan.views.findIndex((v) => v.kind === "section");
    expect(sec).toBeGreaterThanOrEqual(0);
    const res = projectView(plan.views[sec].req, (p) => ctx.core.placed(p));
    expect(res.hatch.length).toBeGreaterThan(0);
    expect(sheet.dims.some((d) => d.text.startsWith("Ø5 THRU"))).toBe(true);
  });
});

// a vane mount: a pivot bore with an arc slot about it (a loop of cylinders), and a straight slot of overlapping holes
const SLOTS = `
part mount {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(80, 60, 6, at: (0, 0, 0))
  cut hole(d: 6, through: true, at: (0, 0, 7), dir: -Z)
  for a in linspace(15, 75, 13) {
    cut cylinder(d: 4.2, h: 8, at: (25 * cos(a), 25 * sin(a), -1), dir: Z)
  }
  for x in linspace(-30, -10, 9) {
    cut hole(d: 5, through: true, at: (x, -20, 7), dir: -Z)
  }
}
`;

describe("slots modelled as rows of cuts", () => {
  it("calls an arc of overlapping cylinders one arc slot and a row of holes one straight slot", () => {
    const ctx = load(SLOTS);
    const sheet = draw(ctx, auto(ctx, "auto:mount"), "slots");
    const texts = sheet.dims.filter((d) => d.kind === "callout").map((d) => d.text);
    const arc = texts.find((t) => t.startsWith("ARC SLOT"))!;
    expect(arc).toBe("ARC SLOT 4.2 WIDE THRU · R25 × 60° (15° TO 75°)");
    expect(texts.some((t) => t.startsWith("SLOT 5 × 25 THRU"))).toBe(true);
    // no callout per cut, and no dimension per cut centre
    expect(texts.some((t) => /13×|9×/.test(t))).toBe(false);
    expect(sheet.dims.length).toBeLessThan(20);
  });
});

// a rig with four vanes cut alike under different names, and many other parts
function rig(extra: string) {
  // two placed with at:, two modelled where they sit
  const vanes = [0, 1, 2, 3].map((k) => (k < 2 ? `part vane_${k + 1} { material: "PLA" body box(30, 3, 40, at: (0, 0, 20)) at: (${k * 40}, 0, 0) }` : `part vane_${k + 1} { material: "PLA" body box(30, 3, 40, at: (${k * 40}, 0, 20)) }`)).join("\n");
  const blocks = Array.from({ length: 44 }, (_, k) => `part block_${k} { material: "PLA" body box(${10 + k}, 10, 5, at: (${(k % 11) * 60}, ${40 + Math.floor(k / 11) * 30}, 0)) }`).join("\n");
  return `${vanes}\n${blocks}\n${extra}`;
}

describe("assembly sheets with many parts", () => {
  it("lists parts made alike once and keeps a long parts list on the sheet", () => {
    const ctx = load(rig(`drawing ga { title: "Rig" sheet: "A3" }`));
    const spec = ctx.model.drawings.find((d) => d.name === "ga")!;
    const sheet = draw(ctx, spec, "rig");
    const vane = sheet.bom.find((l) => l.name === "Vane")!;
    expect(vane.qty).toBe(4);
    expect(sheet.bom.length).toBe(45);
    // every line of the parts list is inside the sheet's frame
    const bom = sheet.shapes.filter((x) => x.key === "bom");
    const ys = bom.flatMap((x) => (x.t === "line" || x.t === "poly" ? x.p.filter((_, i) => i % 2 === 1) : x.t === "text" ? [x.at[1]] : []));
    expect(Math.min(...ys)).toBeGreaterThan(9);
  });

  it("falls back to a scale that fits when the one asked for does not", () => {
    const ctx = load(rig(`drawing ga { title: "Rig" sheet: "A3" scale: "2:1" }`));
    const spec = ctx.model.drawings.find((d) => d.name === "ga")!;
    const sheet = draw(ctx, spec);
    expect(sheet.scale).toBeLessThan(2);
    expect(sheet.warnings.some((w) => w.startsWith("At 2:1 the views do not fit"))).toBe(true);
    // the views keep apart
    const boxes = sheet.views.map((v) => v.box);
    const overlap = boxes.some((a, i) => boxes.some((b, j) => j > i && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]));
    expect(overlap).toBe(false);
  });
});

describe("hidden lines for big assemblies", () => {
  // a plate in front of two rows of blocks: the middle ones are behind it
  const xs = [-180, -150, -120, -60, -30, 0, 30, 60, 120, 150, 180];
  const SRC = [`part plate { body box(200, 5, 100, at: (0, -50, 0)) }`, ...xs.flatMap((x, i) => [20, 70].map((z, k) => `part b${i}_${k} { body box(10, 10, 10, at: (${x}, 0, ${z})) }`))].join("\n");
  const length = (r: ViewResult, part?: number) => r.edges.filter((e) => e.vis && (part === undefined || e.part === part)).reduce((a, e) => a + (e.g.t === "L" ? Math.hypot(e.g.p[2] - e.g.p[0], e.g.p[3] - e.g.p[1]) : 0), 0);

  it("matches the exact projection, one part at a time with a depth buffer", () => {
    const ctx = load(SRC);
    const plan = planDrawing(auto(ctx, "auto:assembly"), ctx.model, ctx.bboxOf);
    const front = plan.views.find((v) => v.kind === "front")!;
    expect(front.req.items.length).toBeGreaterThanOrEqual(20);
    const placed = (p: Parameters<typeof ctx.core.placed>[0]) => ctx.core.placed(p);
    const meshOf = (h: string) => ctx.core.mesh(h, "preview");
    const fast = projectView(front.req, placed, meshOf);
    const exact = projectView(front.req, placed);
    expect(Math.abs(length(fast) / length(exact) - 1)).toBeLessThan(0.02);
    plan.parts.forEach((p, i) => {
      const x = Number(/^b(\d+)/.exec(p.name)?.[1] ?? -1);
      if (x < 0) return;
      const hidden = Math.abs(xs[x]) <= 60;
      expect(length(fast, i) > 0).toBe(!hidden);
      expect(length(exact, i) > 0).toBe(!hidden);
    });
    // a second view of the same parts reuses each part's projection
    const again = projectAssembly(front.req, placed, meshOf);
    expect(again.edges.length).toBe(fast.edges.length);
  });
});

