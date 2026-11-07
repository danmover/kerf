// PMI in 3D and in STEP AP242: a part's drawing (its dimensions, fits,
// tolerances, datums and frames) placed on the model in world space, and
// written into the kernel's STEP file as semantic PMI tied to the faces.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { KernelCore } from "../src/kernel/core";
import { evaluate } from "../src/lang/evaluator";
import { partPmi, pmiLines, pmiSummary } from "../src/drawing/pmi";
import { addStepPmi, stepIntegrity, stepPmiCounts } from "../src/drawing/stepPmi";

const require = createRequire(import.meta.url);

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve("replicad-opencascadejs/wasm"));
  const OC = await (opencascade as unknown as (o: { wasmBinary: Buffer }) => Promise<unknown>)({ wasmBinary });
  R.setOC(OC as never);
}, 60_000);

function load(src: string) {
  const core = new KernelCore();
  const model = evaluate(src);
  for (const p of model.parts) if (p.kind === "part") core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  const bboxOf = (p: { hash: string }) => core.get(p.hash)?.bbox;
  return { core, model, bboxOf };
}

async function stepOf(ctx: ReturnType<typeof load>, name: string) {
  const part = ctx.model.parts.find((p) => p.name === name)!;
  const blob = ctx.core.exportStep([{ hash: part.hash, xf: part.xf, name: part.id, color: part.color, recipe: part.recipe }]);
  return { part, text: await (blob as Blob).text() };
}

// a milled bearing plate, moved off the origin: a 608 seat, four M4 clearance holes, two dowel holes
const PLATE = `
part plate {
  material: "Aluminium 6061"
  process: mfg.cnc_mill()
  body box(80, 60, 10, at: (100, 50, 20))
  cut cylinder(d: 22, h: 7.01, at: (100, 50, 23), dir: Z)
  cut cylinder(d: 12, h: 4, at: (100, 50, 19), dir: Z)
  for x in [-32, 32] {
    for y in [-22, 22] {
      cut hole(M4, through: true, at: (100 + x, 50 + y, 31), dir: -Z)
    }
  }
  for x in [-20, 20] {
    cut hole(d: 4, depth: 6, at: (100 + x, 68, 30.01), dir: -Z)
  }
}
component brg = lib.bearing("608") { at: (100, 50, 23), axis: Z }
component pins = lib.dowel(d: 4, length: 12) { at: [(80, 68, 24), (120, 68, 24)], axis: Z }
drawing plate_drawing {
  of: plate
  tolerance: "ISO 2768-m"
}
`;

// a turned shaft on two 608 bearings
const SHAFT = `
part shaft {
  material: "Steel"
  process: mfg.cnc_lathe(axis: X)
  body revolve([(0, 0), (4, 0), (4, 30), (6, 30), (6, 40), (4, 40), (4, 70), (3, 70), (3, 90), (0, 90)], at: (0, 10, 5), dir: X)
}
component b1 = lib.bearing("608") { at: (2, 10, 5), axis: X }
component b2 = lib.bearing("608") { at: (55, 10, 5), axis: X }
`;

describe("PMI on the model", () => {
  it("places a plate's callouts, fits and datums where the part sits", () => {
    const ctx = load(PLATE);
    const part = ctx.model.parts.find((p) => p.name === "plate")!;
    const pmi = partPmi(ctx.model, part, ctx.bboxOf)!;
    expect(pmi.drawing).toBe("plate_drawing");
    // the seat shares a callout with the bore under it; each size keeps its own fit
    const seat = pmi.dims.find((d) => d.sizes?.some((s) => s.fit === "H7" && Math.abs(s.r - 11) < 1e-6))!;
    expect(seat.sizes!.find((s) => Math.abs(s.r - 6) < 1e-6)!.fit).toBeUndefined();
    expect(seat.round!.centres[0][0]).toBeCloseTo(100, 3);
    expect(seat.round!.centres[0][1]).toBeCloseTo(50, 3);
    expect(pmi.dims.find((d) => /4× .*M4|4× Ø4\.5/.test(d.text))?.round?.centres.length).toBe(4);
    // datum A is the seating face, facing up or down, on the plate
    const a = pmi.datums.find((d) => d.letter === "A")!;
    expect(Math.abs(a.n[2])).toBeCloseTo(1, 6);
    expect([20, 30]).toContain(Math.round(a.p[2]));
    // annotations stand clear of the part, in its world box's neighbourhood
    for (const d of pmi.dims) for (const k of [0, 1, 2]) expect(Math.abs(d.textAt[k] - [100, 50, 25][k])).toBeLessThan(150);
    expect(pmiSummary(pmi)).toMatch(/dimensions .*geometric tolerances.*datums A B/);
    expect(pmiLines(pmi).some((l) => /H7/.test(l))).toBe(true);
  });

  it("leaves a drawing with pmi: false off", () => {
    const ctx = load(PLATE.replace('tolerance: "ISO 2768-m"', 'tolerance: "ISO 2768-m"\n  pmi: false'));
    expect(partPmi(ctx.model, ctx.model.parts.find((p) => p.name === "plate")!, ctx.bboxOf)).toBeNull();
  });
});

describe("STEP AP242 semantic PMI", () => {
  it("ties the plate's sizes, fits, datums and frames to its faces", async () => {
    const ctx = load(PLATE);
    const { part, text } = await stepOf(ctx, "plate");
    const pmi = partPmi(ctx.model, part, ctx.bboxOf)!;
    const { text: out, report } = addStepPmi(text, [pmi]);
    if (process.env.DRAWING_OUT) writeFileSync(`${process.env.DRAWING_OUT}/plate-pmi.step`, out);
    expect(stepIntegrity(out)).toEqual({ ok: true, problems: [] });
    const n = stepPmiCounts(out);
    expect(n.DATUM).toBe(pmi.datums.length + pmi.dims.filter((d) => d.datum).length);
    expect(n.DATUM_FEATURE).toBe(n.DATUM);
    expect(n.LIMITS_AND_FITS).toBe(2);
    expect(n.DIMENSIONAL_SIZE).toBeGreaterThanOrEqual(4);
    expect(n.DIMENSIONAL_LOCATION).toBeGreaterThanOrEqual(2);
    expect(n.POSITION_TOLERANCE + n.PERPENDICULARITY_TOLERANCE + n.FLATNESS_TOLERANCE).toBeGreaterThanOrEqual(2);
    expect(n.TOLERANCE_ZONE).toBeGreaterThan(0);
    expect(report.parts[0].missed).toEqual([]);
    expect(report.parts[0].written).toBeGreaterThan(8);
    // the kernel still reads the file, with the same solid
    const back = await R.importSTEP(new Blob([out]));
    const box = back.boundingBox;
    expect(box.bounds[0][0]).toBeCloseTo(60, 3);
    expect(box.bounds[1][2]).toBeCloseTo(30, 3);
  });

  it("gives a turned shaft's journal its k6 fit on the right cylinder", async () => {
    const ctx = load(SHAFT);
    const { part, text } = await stepOf(ctx, "shaft");
    const pmi = partPmi(ctx.model, part, ctx.bboxOf)!;
    const journal = pmi.dims.find((d) => d.fit === "k6")!;
    expect(journal.round!.r).toBeCloseTo(4, 6);
    expect(Math.abs(journal.round!.dir[0])).toBeCloseTo(1, 6);
    const { text: out, report } = addStepPmi(text, [pmi]);
    expect(stepIntegrity(out).ok).toBe(true);
    expect(stepPmiCounts(out).LIMITS_AND_FITS).toBeGreaterThanOrEqual(1);
    expect(out).toMatch(/LIMITS_AND_FITS\('k','shaft','6','ISO 286-1'\)/);
    expect(report.parts[0].missed.filter((m) => /k6/.test(m))).toEqual([]);
  });

  it("leaves a file alone when no part has PMI", async () => {
    const ctx = load(PLATE);
    const { text } = await stepOf(ctx, "plate");
    expect(addStepPmi(text, []).text).toBe(text);
  });
});
