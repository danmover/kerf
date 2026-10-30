import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { fitToOutlines } from "../src/plugins/organic/fit";
import { fitToSheet, meshOrganic } from "../src/plugins/organic/mesh";
import { prepareSheet, readSheet, sheetFrame, sheetOutlines, type SheetData, type ViewImage } from "../src/plugins/organic/sheet";
import type { OrganicModel } from "../src/plugins/organic/model";

type RGB = [number, number, number];

/** A transparent picture with discs and boxes painted on it. */
function picture(w: number, h: number, shapes: { at: [number, number]; r?: number; box?: [number, number]; color: RGB }[]): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (const s of shapes) {
        const inside = s.r ? (x - s.at[0]) ** 2 + (y - s.at[1]) ** 2 <= s.r ** 2 : Math.abs(x - s.at[0]) <= s.box![0] && Math.abs(y - s.at[1]) <= s.box![1];
        if (!inside) continue;
        data.set([...s.color, 255], (y * w + x) * 4);
      }
  return data;
}

/** A sheet of two views side by side: a creature `body` px across with a red top half and a blue bottom half from the front, all green from the side. */
function sheet(body: number): ViewImage {
  const W = 400;
  const H = 200;
  const front = picture(W, H, [
    { at: [100, 100], r: body / 2, color: [220, 40, 40] },
    { at: [100, 100 + body / 4], box: [body / 2, body / 4], color: [40, 60, 220] },
  ]);
  // keep the blue only inside the disc
  for (let y = 0; y < H; y++)
    for (let x = 0; x < 200; x++) if ((x - 100) ** 2 + (y - 100) ** 2 > (body / 2) ** 2) front[(y * W + x) * 4 + 3] = 0;
  const side = picture(W, H, [{ at: [300, 100], r: body / 2, color: [40, 200, 60] }]);
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const src = front[i * 4 + 3] ? front : side;
    data.set(src.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return { width: W, height: H, data };
}

const ball = (d: number, z: number, extra = ""): string => `
part pet {
  body organic.model([
    organic.ball(d: ${d}, at: (0, 0, ${z})${extra}),
  ], color: #808080)
}`;

function modelOf(src: string): OrganicModel {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return (m.parts[0].recipe.base as { data: OrganicModel }).data;
}

describe("creatures from a reference sheet", () => {
  it("reads a sheet's views and colours", () => {
    const data = prepareSheet(sheet(120));
    expect(data.views.map((v) => v.view)).toEqual(["front", "side"]);
    expect(data.palette.length).toBe(3);
    const cuts = readSheet(data);
    expect(cuts.front!.x1 - cuts.front!.x0 + 1).toBeGreaterThan(115);
    // labels survive the run-length coding: the front's top is red, its bottom blue
    const f = cuts.front!;
    const at = (x: number, y: number) => data.palette[f.lab[y * f.w + x]];
    const red = at(f.x0 + 60, f.y0 + 20);
    const blue = at(f.x0 + 60, f.y1 - 20);
    expect(red).not.toBe(blue);
    expect(parseInt(red.slice(1, 3), 16)).toBeGreaterThan(150);
    expect(parseInt(blue.slice(5, 7), 16)).toBeGreaterThan(150);
  });

  it("tags each entry of the shape list so it can be fitted as one", () => {
    const model = modelOf(`
let ear = [organic.ball(d: 6, at: (0, 0, 0)), organic.limb(from: (0, 0, 0), to: (0, 0, 8), d: 4)]
part pet {
  body organic.model([
    organic.ball(d: 30, at: (0, 0, 15)),
    organic.group(ear, at: (8, 0, 28), mirror: true),
  ])
}`);
    expect(model.items.map((i) => i.g)).toEqual([0, 1, 1, 1, 1]);
    expect(model.items.map((i) => i.side ?? 1)).toEqual([1, 1, 1, -1, -1]);
  });

  it("fits the shapes to the outlines", () => {
    // a ball too small and too low for the drawing
    const model = modelOf(`
part pet {
  body organic.model([
    organic.ball(d: 60, at: (0, 0, 30)),
    organic.ball(d: 20, at: (0, 0, 44)),
  ])
}`);
    const frame = sheetFrame(readSheet(prepareSheet(sheet(120))), 60, [0, 0, 0]);
    const fit = fitToOutlines(model, sheetOutlines(frame, 1));
    expect(fit.before.front).toBeGreaterThan(0.8);
    // the drawing is a ball as tall as the model: the small ball only gets in the way of nothing, the big one already fits
    expect(fit.after.front).toBeGreaterThanOrEqual(fit.before.front);
    const tall = modelOf(ball(40, 20));
    const frame2 = sheetFrame(readSheet(prepareSheet(sheet(120))), 40, [0, 0, 0]);
    // the same ball drawn at the model's height: nothing to move
    const still = fitToOutlines(tall, sheetOutlines(frame2, 0.5));
    expect(still.after.front).toBeGreaterThan(0.95);
    expect(still.rows.every((r) => Math.abs(r[4] - 1) < 0.05)).toBe(true);
  });

  it("moves an entry that is in the wrong place", () => {
    const model = modelOf(`
part pet {
  body organic.model([
    organic.ball(d: 40, at: (0, 0, 20)),
    organic.ball(d: 12, at: (0, 0, 6)),
  ])
}`);
    // the drawing: one ball 40 across; the little ball inside it fits anywhere inside, so move the big one off and let it return
    const shifted: OrganicModel = { ...model, items: model.items.map((it, i) => (i === 0 && it.prim.k === "ball" ? { ...it, prim: { ...it.prim, c: [0, 5, 23] } } : it)) };
    const frame = sheetFrame(readSheet(prepareSheet(sheet(120))), 40, [0, 0, 0]);
    const fit = fitToOutlines(shifted, sheetOutlines(frame, 0.5));
    expect(fit.after.side).toBeGreaterThan(fit.before.side + 0.05);
    const row = fit.rows.find((r) => r[0] === 0)!;
    expect(row[2]).toBeLessThan(-2);
    expect(row[3]).toBeLessThan(-1);
  });

  it("colours the surface from the views", () => {
    const data: SheetData = prepareSheet(sheet(120));
    const model: OrganicModel = { ...modelOf(ball(40, 20)), sheet: data };
    const mesh = meshOrganic(model, "preview");
    expect(mesh.palette).toEqual(data.palette);
    const red = data.palette.findIndex((c) => parseInt(c.slice(1, 3), 16) > 150);
    const blue = data.palette.findIndex((c) => parseInt(c.slice(5, 7), 16) > 150 && parseInt(c.slice(1, 3), 16) < 100);
    const green = data.palette.findIndex((c) => parseInt(c.slice(3, 5), 16) > 150);
    // faces looking at the front camera: red above the middle, blue below; faces looking sideways: green
    const tally = { upFront: [0, 0], downFront: [0, 0], side: [0, 0] };
    const p = mesh.positions;
    for (let f = 0; f < mesh.faceColor.length; f++) {
      const [a, b, c] = [mesh.indices[f * 3], mesh.indices[f * 3 + 1], mesh.indices[f * 3 + 2]];
      const cx = (p[a * 3] + p[b * 3] + p[c * 3]) / 3;
      const cy = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3;
      const cz = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
      const col = mesh.faceColor[f];
      if (cy < -15 && Math.abs(cx) < 8) {
        const k = cz > 26 ? "upFront" : cz < 14 ? "downFront" : null;
        if (k) tally[k][col === (k === "upFront" ? red : blue) ? 0 : 1]++;
      }
      if (Math.abs(cx) > 17 && Math.abs(cy) < 6) tally.side[col === green ? 0 : 1]++;
    }
    for (const [ok, bad] of Object.values(tally)) {
      expect(ok).toBeGreaterThan(0);
      expect(ok).toBeGreaterThan(bad * 4);
    }
  });

  it("keeps the fit for the next build of the same model", () => {
    const model: OrganicModel = { ...modelOf(ball(40, 20)), sheet: prepareSheet(sheet(120)) };
    const a = fitToSheet(model);
    expect(fitToSheet({ ...model })).toBe(a);
    expect(fitToSheet({ ...model, fit: false }).result).toBeNull();
  });
});
