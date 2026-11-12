// 3D-print prep: the supports a part needs as it lies on the bed (a ledge needs them, a short span held at both ends
// bridges, a plain block needs none), and printed copies packed onto plates by size and material.

import { describe, expect, it } from "vitest";
import { supportEstimate } from "../src/mfg/supports";
import { packPlates } from "../src/mfg/plates";
import { estimatePart, nozzlesOf, planPrint, plateMatrix } from "../src/mfg/printPlan";
import { MACHINE_PRESETS } from "../src/mfg/machines";
import type { MeshData } from "../src/kernel/build";

type B = [number, number, number, number, number, number];

/** Closed boxes (outward faces) as one mesh: [x0, y0, z0, x1, y1, z1] each. Stacked ones are kept 0.1 mm apart,
 * as a real part's mesh is one closed surface with no faces inside it. */
function boxes(...bs: B[]): { P: Float32Array; I: Uint32Array } {
  const P: number[] = [];
  const I: number[] = [];
  for (const [x0, y0, z0, x1, y1, z1] of bs) {
    const o = P.length / 3;
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) P.push(x, y, z);
    // corners: 0 (x0 y0 z0) 1 (x1 y0 z0) 2 (x0 y1 z0) 3 (x1 y1 z0), 4..7 the same at z1
    const f = [
      [0, 2, 3, 1], // bottom, -Z
      [4, 5, 7, 6], // top, +Z
      [0, 1, 5, 4], // -Y
      [2, 6, 7, 3], // +Y
      [0, 4, 6, 2], // -X
      [1, 3, 7, 5], // +X
    ];
    for (const [a, b, c, d] of f) I.push(o + a, o + b, o + c, o + a, o + c, o + d);
  }
  return { P: new Float32Array(P), I: new Uint32Array(I) };
}

const mesh = (m: { P: Float32Array; I: Uint32Array }): MeshData => ({ positions: m.P, indices: m.I, normals: new Float32Array(0), edges: new Float32Array(0) });

describe("supports", () => {
  it("needs none under a block on the bed", () => {
    const { P, I } = boxes([0, 0, 0, 40, 30, 20]);
    const s = supportEstimate(P, I);
    expect(s.area).toBe(0);
    expect(s.volume).toBe(0);
  });

  it("holds up a ledge, from the bed, at the support's infill", () => {
    // a 10 mm post 30 mm tall with a 40 mm slab on top: 30 mm of it sticks out over the bed
    const { P, I } = boxes([0, 0, 0, 10, 10, 29.9], [0, 0, 30, 40, 10, 35]);
    const s = supportEstimate(P, I);
    expect(s.area).toBeGreaterThan(260);
    expect(s.area).toBeLessThan(340);
    // 300 mm² × 30 mm × 15 %
    expect(s.volume).toBeGreaterThan(1150);
    expect(s.volume).toBeLessThan(1550);
    expect(s.tallest).toBeCloseTo(30, 0);
    expect(s.cells.every((c) => c.fromBed && c.x > 9)).toBe(true);
  });

  it("bridges a short span held at both ends, and supports a long one", () => {
    // two posts 8 mm apart under a slab: a bridge
    const short = boxes([0, 0, 0, 10, 10, 19.9], [18, 0, 0, 28, 10, 19.9], [0, 0, 20, 28, 10, 25]);
    const s = supportEstimate(short.P, short.I);
    expect(s.area).toBe(0);
    expect(s.bridged).toBeGreaterThan(60);
    // 40 mm apart: too far to bridge
    const long = boxes([0, 0, 0, 10, 10, 19.9], [50, 0, 0, 60, 10, 19.9], [0, 0, 20, 60, 10, 25]);
    const l = supportEstimate(long.P, long.I);
    expect(l.area).toBeGreaterThan(330);
    expect(l.bridged).toBe(0);
  });

  it("stands a support on the part below, not the bed", () => {
    // a wide base, a post, and a slab sticking out over the base
    const { P, I } = boxes([0, 0, 0, 50, 20, 4.9], [0, 0, 5, 10, 20, 24.9], [0, 0, 25, 40, 20, 30]);
    const s = supportEstimate(P, I);
    expect(s.cells.length).toBeGreaterThan(0);
    expect(s.cells.every((c) => !c.fromBed)).toBe(true);
    expect(s.tallest).toBeCloseTo(20, 0);
  });
});

describe("plates", () => {
  it("packs copies onto as few beds as it takes, turning them to fit", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ name: `bracket ${i + 1}`, w: 100, d: 60, material: "PETG" }));
    const { plates, tooBig } = packPlates(items, [256, 256]);
    expect(tooBig).toEqual([]);
    expect(plates.length).toBe(2);
    expect(plates.reduce((a, p) => a + p.places.length, 0)).toBe(10);
    // inside the bed, clear of each other by the gap
    for (const p of plates) {
      const r = p.places.map((q) => ({ x0: q.x, y0: q.y, x1: q.x + (q.turned ? 60 : 100), y1: q.y + (q.turned ? 100 : 60) }));
      for (const a of r) expect(a.x0 >= 4.99 && a.y0 >= 4.99 && a.x1 <= 251.01 && a.y1 <= 251.01).toBe(true);
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) expect(r[i].x1 + 6 <= r[j].x0 + 1e-6 || r[j].x1 + 6 <= r[i].x0 + 1e-6 || r[i].y1 + 6 <= r[j].y0 + 1e-6 || r[j].y1 + 6 <= r[i].y0 + 1e-6).toBe(true);
    }
  });

  it("keeps one material a plate on one nozzle, two on two, and lists what is too big", () => {
    const items = [
      { name: "a", w: 40, d: 40, material: "PETG" },
      { name: "b", w: 40, d: 40, material: "PETG" },
      { name: "c", w: 40, d: 40, material: "TPU 95A" },
      { name: "d", w: 300, d: 40, material: "PETG" },
    ];
    const one = packPlates(items, [256, 256], { nozzles: 1 });
    expect(one.tooBig).toEqual([3]);
    expect(one.plates.filter((p) => !p.places.some((q) => q.item === 3)).map((p) => p.materials)).toEqual([["PETG"], ["TPU 95A"]]);
    const two = packPlates(items.slice(0, 3), [256, 256], { nozzles: 2 });
    expect(two.plates.length).toBe(1);
    expect(two.plates[0].materials.sort()).toEqual(["PETG", "TPU 95A"]);
  });
});

describe("print plan", () => {
  it("turns each part to print, estimates it once, and places every copy on a plate", () => {
    const ledge = mesh(boxes([0, 0, 0, 10, 10, 29.9], [0, 0, 30, 40, 10, 35]));
    const block = mesh(boxes([0, 0, 0, 30, 20, 10]));
    const plan = planPrint(
      [
        { name: "ledge", material: "PETG", color: "#888888", qty: 2, mesh: ledge, build: [0, 0, 1] },
        { name: "block", material: "PLA", color: "#cc4444", qty: 3, mesh: block },
      ],
      { name: "Test printer", bed: [220, 220], nozzles: 1 },
    );
    expect(plan.copies.length).toBe(5);
    expect(plan.estimates.length).toBe(2);
    expect(plan.estimates[0].supportGrams).toBeGreaterThan(1);
    expect(plan.estimates[1].supportGrams).toBe(0);
    // a block of 6 cm³ of PLA, printed with walls and 20 % infill: a few grams
    expect(plan.estimates[1].grams).toBeGreaterThan(2);
    expect(plan.estimates[1].grams).toBeLessThan(7.5);
    // one material a plate: PETG and PLA apart
    expect(plan.plates.length).toBe(2);
    expect(plan.grams).toBeCloseTo(plan.plates.reduce((a, p) => a + p.grams, 0), 6);
    // the 3MF placement keeps each copy on its bed
    for (const pl of plan.plates)
      for (const q of pl.places) {
        const c = plan.copies[q.item];
        const m = plateMatrix(c, q);
        for (let i = 0; i < c.positions.length; i += 3) {
          const x = m[0] * c.positions[i] + m[4] * c.positions[i + 1] + m[12];
          const y = m[1] * c.positions[i] + m[5] * c.positions[i + 1] + m[13];
          expect(x).toBeGreaterThanOrEqual(-1e-3);
          expect(y).toBeGreaterThanOrEqual(-1e-3);
          expect(x).toBeLessThanOrEqual(220.001);
          expect(y).toBeLessThanOrEqual(220.001);
        }
      }
  });
});

describe("print estimates", () => {
  const block = boxes([0, 0, 0, 30, 20, 10]);
  it("weighs a part as its slicer settings print it", () => {
    const kerf = estimatePart(block.P, block.I, "PLA");
    const solid = estimatePart(block.P, block.I, "PLA", { print: { walls: 4, top: 5, infill: 1, layer: 0.2, line: 0.44 } });
    // solid: the whole 6 cm³ at PLA's 1.24 g/cm³
    expect(solid.grams).toBeCloseTo(6 * 1.24, 2);
    expect(kerf.grams).toBeLessThan(solid.grams);
    const thin = estimatePart(block.P, block.I, "PLA", { print: { walls: 2, top: 3, infill: 0.15, layer: 0.2, line: 0.44 } });
    expect(thin.grams).toBeLessThan(kerf.grams);
    expect(kerf.hours).toBeGreaterThan(thin.hours);
  });

  it("adds no support plastic when the part turns supports off, but still marks the overhangs", () => {
    const ledge = boxes([0, 0, 0, 10, 10, 29.9], [0, 0, 30, 40, 10, 35]);
    const on = estimatePart(ledge.P, ledge.I, "PETG");
    const off = estimatePart(ledge.P, ledge.I, "PETG", { supports: false });
    expect(on.supportGrams).toBeGreaterThan(0.1);
    expect(off.supportGrams).toBe(0);
    expect(off.supportsOff).toBe(true);
    expect(off.supports.cells.length).toBe(on.supports.cells.length);
    expect(off.hours).toBeLessThan(on.hours);
  });

  it("counts a printer's nozzles from its name and note", () => {
    const by = (id: string) => nozzlesOf(MACHINE_PRESETS.find((m) => m.id === id));
    expect(by("bambu-x2d")).toBe(2);
    expect(by("bambu-h2d")).toBe(2);
    expect(by("prusa-xl-5")).toBe(5);
    expect(by("bambu-x1c")).toBe(1);
    expect(by("prusa-mk4")).toBe(1);
    expect(nozzlesOf(undefined)).toBe(1);
    expect(nozzlesOf({ name: "My IDEX", note: "" })).toBe(2);
  });
});


describe("plate drawing", () => {
  it("covers a part's footprint and nothing past its edges", () => {
    // a panel a whole number of 2 mm cells across, as a float mesh is (sizes a hair off)
    const small = boxes([-50.00001, -30.00001, 0, 50.00001, 30.00001, 4]);
    const f = estimatePart(small.P, small.I, "PETG").footprint;
    expect([f.cell, f.nx, f.ny]).toEqual([2, 50, 30]);
    expect(f.on.every((v) => v === 1)).toBe(true);
    // a bigger one on coarser cells: no cell whose centre is off the part, however its walls fall
    const big = boxes([-100, -75, 0, 100, 75, 4]);
    const g = estimatePart(big.P, big.I, "PETG").footprint;
    expect(g.cell).toBeGreaterThan(2);
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const x = g.x0 + (i + 0.5) * g.cell;
        const y = g.y0 + (j + 0.5) * g.cell;
        expect(g.on[j * g.nx + i] === 1).toBe(x < 100 && y < 75);
      }
  });
});
