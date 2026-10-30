import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { initKernel } from "./helpers/kernel";
import { evaluate } from "../src/lang/evaluator";
import { buildPartFull, solidVolume } from "../src/kernel/build";
import { meshOrganic } from "../src/plugins/organic/mesh";
import { decimate } from "../src/plugins/organic/decimate";
import type { OrganicModel } from "../src/plugins/organic/model";

const fox = readFileSync(new URL("../src/plugins/organic/templates/fox.kerf", import.meta.url), "utf8");

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
    // mirror: true doubles legs, cheeks and the ear group
    expect(model.items.length).toBeGreaterThan(25);
    // per ear and leg one paint, mirrored and repeated, plus the face, chest ruff and tail tip
    expect(model.items.filter((i) => i.op === "paint").length).toBe(2 + 4 + 4);
    // the tail is one smooth tube of many segments, the cheek ruffs fans of spikes
    expect(model.items.some((i) => i.prim.k === "cones" && i.prim.s.length / 8 >= 8)).toBe(true);
  });

  it("meshes to its triangle budget, closed and the right way out", () => {
    const model = organicModel(fox);
    const final = meshOrganic(model, "final");
    expect(final.indices.length / 3).toBeLessThanOrEqual(16000);
    expect(final.indices.length / 3).toBeGreaterThan(14000);
    expect(final.volume).toBeGreaterThan(0);
    // orange, cream, dark brown tips and boots, pink inner ears, nose
    expect(final.palette).toEqual(expect.arrayContaining(["#e2691f", "#f7e3ca", "#4a2c24", "#f0a49a", "#2a1c19"]));
    const colours = new Set(final.faceColor);
    expect(colours.size).toBe(5);
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

  it("makes curved tubes, curls, tufts and eyes", () => {
    const src = `part p {\n  body organic.model([\n    organic.ball(d: 40, at: (0, 0, 30)),\n    organic.tube(points: [(0, 15, 20), (0, 30, 30), (0, 40, 45)], d: [8, 4]),\n    organic.curl(at: (18, 0, 40), axis: X, r: 8, turns: -1, d: 6, mirror: true),\n    organic.tuft(at: (18, -5, 25), toward: (1, 0, -0.5), length: 10, d: 6, count: 4),\n    organic.eye(at: (8, -18, 34), d: 6, mirror: true),\n  ], style: "smooth", tris: 6000)\n}`;
    const model = organicModel(src);
    const cones = model.items.filter((i) => i.prim.k === "cones").map((i) => (i.prim as { s: number[] }).s);
    // tube, two curls, one tuft of four spikes
    expect(cones).toHaveLength(4);
    const [tube, curl, curlMirror, tuft] = cones;
    expect(tube.length / 8).toBeGreaterThan(4);
    // the tube tapers from 8 to 4 mm across
    expect(tube[6]).toBeCloseTo(4, 6);
    expect(tube[tube.length - 1]).toBeCloseTo(2, 6);
    // the mirrored curl runs the same path on the other side
    expect(curlMirror[0]).toBeCloseTo(-curl[0], 6);
    expect(curlMirror[2]).toBeCloseTo(curl[2], 6);
    expect(tuft.length / 8).toBe(4);
    // each eye: a dark ball and two highlights, lit from the same side on both eyes
    const shine = model.items.filter((i) => i.op === "paint");
    expect(shine).toHaveLength(4);
    const big = shine.filter((i) => (i.prim as { r: number }).r > 0.8).map((i) => (i.prim as { c: number[] }).c);
    expect(big[0][0] - 8).toBeCloseTo(big[1][0] + 8, 6);
    const mesh = meshOrganic(model, "final");
    expect(mesh.palette).toEqual(expect.arrayContaining(["#1b1820", "#ffffff"]));
  });

  it("shades creases darker than open surfaces", () => {
    const m = meshOrganic({ v: 1, items: [{ op: "add", prim: { k: "ball", c: [0, 0, 0], r: 20 }, blend: 0 }, { op: "add", prim: { k: "ball", c: [0, 0, 30], r: 14 }, blend: 4 }], color: "#ffffff", style: "smooth", tris: 4000 }, "final");
    let top = 0;
    let crease = 255;
    for (let v = 0; v < m.positions.length / 3; v++) {
      const z = m.positions[v * 3 + 2];
      const r = Math.hypot(m.positions[v * 3], m.positions[v * 3 + 1]);
      if (z > 40) top = Math.max(top, m.colors[v * 3]);
      // where the small ball meets the big one
      if (z > 14 && z < 20 && r < 14) crease = Math.min(crease, m.colors[v * 3]);
    }
    expect(top).toBeGreaterThan(240);
    expect(crease).toBeLessThan(top * 0.8);
  });

  it("keeps a loose bit as its own solid so the pieces check finds it", async () => {
    const { solidPieces } = await import("../src/kernel/inspect");
    const m = evaluate(`part p {\n  body organic.model([organic.ball(d: 40), organic.ball(d: 12, at: (0, 0, 40))], style: "smooth")\n}`);
    const built = buildPartFull(m.parts[0].recipe);
    const pieces = solidPieces(built.shape);
    expect(pieces?.count).toBe(2);
    expect(pieces?.others[0].at[2]).toBeGreaterThan(30);
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
  it("bakes every triangle's colours into the texture under its corners' uvs", async () => {
    const { gameModel } = await import("../src/plugins/organic/gameExport");
    const model = organicModel(fox);
    const m = meshOrganic(model, "final");
    const mesh = { positions: m.positions, normals: m.normals, indices: m.indices, edges: new Float32Array(0), colors: m.colors };
    const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const g = gameModel([
      { name: "fox", matrix: ident, mesh, color: "#e2691f", painted: true },
      // a plain part keeps its own colour
      { name: "stand", matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1], mesh: { ...mesh, colors: undefined }, color: "#ff0000", painted: false },
    ]);
    const nf = m.indices.length / 3;
    expect(g.cells).toBe(nf + 1);
    // 16k triangles fit Roblox's 1024 px texture
    expect(g.size).toBe(1024);
    expect(g.triangles).toBe(2 * nf);
    const fm = g.meshes[0];
    expect(fm.positions.length).toBe(nf * 9);
    const texel = (u: number, v: number) => {
      const o = (Math.floor(v * g.size) * g.size + Math.floor(u * g.size)) * 4;
      return [g.pixels[o], g.pixels[o + 1], g.pixels[o + 2]];
    };
    const srgb = (l: number) => {
      const x = l / 255;
      return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255);
    };
    // the texel just inside each corner is close to that corner's colour
    for (const f of [0, 1, Math.floor(nf / 2), nf - 1])
      for (let c = 0; c < 3; c++) {
        const v = m.indices[f * 3 + c];
        const [u0, v0] = [fm.uvs[(f * 3 + c) * 2], fm.uvs[(f * 3 + c) * 2 + 1]];
        // nudge toward the triangle's middle so the texel is inside it
        const [um, vm] = [(fm.uvs[f * 6] + fm.uvs[f * 6 + 2] + fm.uvs[f * 6 + 4]) / 3, (fm.uvs[f * 6 + 1] + fm.uvs[f * 6 + 3] + fm.uvs[f * 6 + 5]) / 3];
        const t = texel(u0 + (um - u0) * 0.15, v0 + (vm - v0) * 0.15);
        for (let ch = 0; ch < 3; ch++) expect(Math.abs(t[ch] - srgb(m.colors[v * 3 + ch]))).toBeLessThan(40);
      }
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
