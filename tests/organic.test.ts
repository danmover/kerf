import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { initKernel } from "./helpers/kernel";
import { evaluate } from "../src/lang/evaluator";
import { buildPartFull, solidVolume } from "../src/kernel/build";
import { meshOrganic } from "../src/plugins/organic/mesh";
import { decimate } from "../src/plugins/organic/decimate";
import type { OrganicModel } from "../src/plugins/organic/model";

const fox = readFileSync(new URL("../src/plugins/organic/templates/zephyr-fox.kerf", import.meta.url), "utf8");

function organicModel(src: string): OrganicModel {
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const base = m.parts[0].recipe.base!;
  expect(base.t).toBe("meshgen");
  return (base as { data: OrganicModel }).data;
}

describe("organic shapes", () => {
  beforeAll(initKernel, 60000);

  it("evaluates a creature into one painted model", () => {
    const m = evaluate(fox);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.parts).toHaveLength(1);
    expect(m.parts[0].painted).toBe(true);
    const model = organicModel(fox);
    // mirror: true doubles legs, paws, cheeks and the ear group
    expect(model.items.length).toBeGreaterThan(20);
    // two paints per ear, mirrored, plus the face, chest and paws
    expect(model.items.filter((i) => i.op === "paint").length).toBe(7);
  });

  it("meshes to its triangle budget, closed and the right way out", () => {
    const model = organicModel(fox);
    const final = meshOrganic(model, "final");
    expect(final.indices.length / 3).toBeLessThanOrEqual(2600);
    expect(final.indices.length / 3).toBeGreaterThan(2000);
    expect(final.volume).toBeGreaterThan(0);
    // sky blue, white, dark blue tips, nose
    expect(final.palette).toEqual(expect.arrayContaining(["#7ec4ef", "#fbfcff", "#3b7cc6", "#23406e"]));
    const colours = new Set(final.faceColor);
    expect(colours.size).toBe(4);
    // the head is the widest part and the ears are the top
    expect(final.bbox[1][2]).toBeGreaterThan(100);
    expect(final.bbox[0][2]).toBeLessThan(1);
  });

  it("builds a solid stand-in the checks can use", () => {
    const m = evaluate(fox);
    const built = buildPartFull(m.parts[0].recipe);
    const mesh = meshOrganic(organicModel(fox), "final");
    const v = solidVolume(built.shape);
    expect(Math.abs(v - mesh.volume) / mesh.volume).toBeLessThan(0.05);
  });

  it("refuses add and cut after an organic body", () => {
    const m = evaluate(`part p {\n  body organic.model([organic.ball(d: 20)])\n  cut cylinder(d: 4, h: 30)\n}`);
    expect(m.diagnostics.some((d) => d.severity === "error" && /organic.model\(\) makes the whole part/.test(d.message))).toBe(true);
  });

  it("mirrors, groups and carves", () => {
    const src = `part p {\n  body organic.model([\n    organic.ball(d: 40),\n    organic.group([organic.limb(from: (0, 0, 0), to: (0, 0, 20), d: 8, d2: 2)], at: (10, 0, 15), rotate: (0, 30, 0), mirror: true),\n    organic.carve(organic.ball(d: 10, at: (0, -20, 0)), color: #ff8899),\n  ], style: "smooth", tris: 8000)\n}`;
    const model = organicModel(src);
    const horns = model.items.filter((i) => i.prim.k === "limb");
    expect(horns).toHaveLength(2);
    const [a, b] = horns.map((h) => (h.prim as { b: number[] }).b);
    // mirror images across x = 0, tips leaning outward
    expect(a[0]).toBeCloseTo(-b[0], 6);
    expect(a[0]).toBeGreaterThan(10);
    const mesh = meshOrganic(model, "final");
    expect(mesh.palette).toContain("#ff8899");
    expect(mesh.indices.length / 3).toBeLessThanOrEqual(8000);
  });

  it("keeps colour borders when simplifying", () => {
    const model: OrganicModel = {
      v: 1,
      items: [
        { op: "add", prim: { k: "ball", c: [0, 0, 0], r: 20 }, blend: 0 },
        { op: "paint", prim: { k: "box", c: [0, 0, 15], h: [30, 30, 15], r: 0 }, color: "#ffffff", blend: 0 },
      ],
      color: "#222222",
      style: "lowpoly",
      tris: 300,
    };
    const m = meshOrganic(model, "final");
    // every white facet sits above the border at z = 0, give or take a facet
    for (let f = 0; f < m.faceColor.length; f++) {
      if (m.palette[m.faceColor[f]] !== "#ffffff") continue;
      const z = (m.positions[f * 9 + 2] + m.positions[f * 9 + 5] + m.positions[f * 9 + 8]) / 3;
      expect(z).toBeGreaterThan(-3);
    }
  });

  it("decimate stops at its target and stays closed", () => {
    const m = meshOrganic({ v: 1, items: [{ op: "add", prim: { k: "ellipsoid", c: [0, 0, 0], r: [30, 20, 10] }, blend: 0 }], color: "#888888", style: "smooth", tris: 400000 }, "final");
    const d = decimate({ positions: m.positions, indices: m.indices }, 500);
    expect(d.indices.length / 3).toBeLessThanOrEqual(500);
    // closed: every edge used by exactly two faces
    const edges = new Map<string, number>();
    for (let f = 0; f < d.indices.length; f += 3)
      for (let k = 0; k < 3; k++) {
        const a = d.indices[f + k];
        const b = d.indices[f + ((k + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
  });
});

describe("game model export", () => {
  it("gives every colour one texture square and every corner its colour's uv", async () => {
    const { gameModel } = await import("../src/plugins/organic/gameExport");
    const model = organicModel(fox);
    const m = meshOrganic(model, "final");
    const mesh = { positions: m.positions, normals: m.normals, indices: m.indices, edges: new Float32Array(0), colors: m.colors };
    const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const g = gameModel([
      { name: "fox", matrix: ident, mesh, color: "#7ec4ef", painted: true },
      // a plain part keeps its own colour
      { name: "stand", matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1], mesh: { ...mesh, colors: undefined }, color: "#ff0000", painted: false },
    ]);
    expect(g.colors).toBe(5);
    expect(g.size).toBe(64);
    expect(g.triangles).toBe(2 * (m.indices.length / 3));
    // the texel under each corner's uv is that corner's colour
    const fm = g.meshes[0];
    const texel = (u: number, v: number) => {
      const o = (Math.floor(v * g.size) * g.size + Math.floor(u * g.size)) * 4;
      return [g.pixels[o], g.pixels[o + 1], g.pixels[o + 2]];
    };
    const white = texel(fm.uvs[0], fm.uvs[1]);
    expect(white.every((c) => c >= 0)).toBe(true);
    const sky = m.palette.indexOf("#7ec4ef");
    const f = [...m.faceColor].indexOf(sky);
    expect(texel(fm.uvs[f * 6], fm.uvs[f * 6 + 1])).toEqual([0x7e, 0xc4, 0xef]);
    expect(texel(g.meshes[1].uvs[0], g.meshes[1].uvs[1])).toEqual([255, 0, 0]);
    // metres, Y up, the front (Kerf -Y) toward +Z
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < fm.positions.length; i += 3) {
      maxY = Math.max(maxY, fm.positions[i + 1]);
      maxZ = Math.max(maxZ, fm.positions[i + 2]);
    }
    expect(maxY).toBeCloseTo(m.bbox[1][2] / 1000, 4);
    expect(maxZ).toBeCloseTo(-m.bbox[0][1] / 1000, 4);
  });
});
