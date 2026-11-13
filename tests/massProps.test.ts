// Mass properties from meshes against textbook answers: a box, a cylinder
// (faceted, so within its facets' error), two boxes apart (parallel axes),
// a turned box (principal axes) and a component's given mass.

import { describe, expect, it } from "vitest";
import { combine, inertiaAbout, massProperties, massPropsText, meshMoments, type M3 } from "../src/core/massProps";
import { boxMesh } from "../src/analysis/fe/voxel";
import type { MeshData } from "../src/kernel/build";
import type { EvalPart, Model } from "../src/core/model";
import type { Xform } from "../src/kernel/recipe";

type V3 = [number, number, number];

const mesh = (lo: V3, hi: V3): MeshData => {
  const b = boxMesh(lo, hi);
  return { positions: Float32Array.from(b.positions), normals: new Float32Array(b.positions.length), indices: Uint32Array.from(b.indices), edges: new Float32Array(0) };
};

function cylinder(r: number, h: number, n = 256): MeshData {
  const pos: number[] = [0, 0, 0, 0, 0, h];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pos.push(r * Math.cos(a), r * Math.sin(a), 0, r * Math.cos(a), r * Math.sin(a), h);
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0 = 2 + 2 * i,
      t0 = b0 + 1,
      b1 = 2 + 2 * j,
      t1 = b1 + 1;
    idx.push(0, b1, b0, 1, t0, t1, b0, b1, t1, b0, t1, t0);
  }
  return { positions: Float32Array.from(pos), normals: new Float32Array(pos.length), indices: Uint32Array.from(idx), edges: new Float32Array(0) };
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

function part(id: string, hash: string, over: Partial<EvalPart> = {}): EvalPart {
  return { id, name: id, label: id, kind: "part", group: "", color: "#888", material: "Steel", recipe: {} as EvalPart["recipe"], hash, xf: [], locked: false, hidden: false, removable: false, span: { start: 0, end: 0 }, deps: [], ...over } as EvalPart;
}

describe("mass properties", () => {
  it("gives a box its centre and the textbook inertia", () => {
    // 100 × 40 × 20 mm: I = m (b² + c²) / 12 about each axis through the centre
    const m = meshMoments(mesh([0, 0, 0], [100, 40, 20]), []);
    expect(m.volume).toBeCloseTo(80000, 3);
    expect(m.com).toEqual([expect.closeTo(50, 6), expect.closeTo(20, 6), expect.closeTo(10, 6)]);
    const mp = combine([{ mass: 80, com: m.com, second: m.cov.map((x) => x * 1e-3) as M3 }], 1, 0);
    expect(rel(mp.inertia[0], (80 * (40 ** 2 + 20 ** 2)) / 12)).toBeLessThan(1e-9);
    expect(rel(mp.inertia[4], (80 * (100 ** 2 + 20 ** 2)) / 12)).toBeLessThan(1e-9);
    expect(rel(mp.inertia[8], (80 * (100 ** 2 + 40 ** 2)) / 12)).toBeLessThan(1e-9);
    expect(Math.abs(mp.inertia[1]) + Math.abs(mp.inertia[2]) + Math.abs(mp.inertia[5])).toBeLessThan(1e-6);
    // principal axes, smallest first: along the box's long side
    expect(Math.abs(mp.principal.axes[0][0])).toBeCloseTo(1, 9);
    expect(Math.abs(mp.principal.axes[2][2])).toBeCloseTo(1, 9);
    expect(mp.gyration[0]).toBeCloseTo(Math.sqrt((40 ** 2 + 20 ** 2) / 12), 6);
  });

  it("gives a cylinder ½mr² about its axis and m(3r² + h²)/12 across", () => {
    const m = meshMoments(cylinder(10, 60), [], Math.PI * 100 * 60);
    expect(m.com[2]).toBeCloseTo(30, 6);
    const mass = 50;
    const mp = combine([{ mass, com: m.com, second: m.cov.map((x) => (x * mass) / m.volume) as M3 }], 1, 0);
    expect(rel(mp.inertia[8], 0.5 * mass * 100)).toBeLessThan(2e-3);
    expect(rel(mp.inertia[0], (mass * (3 * 100 + 3600)) / 12)).toBeLessThan(2e-3);
  });

  it("sums parts about their common centre, follows where parts are placed, and shares a component's mass", () => {
    const meshes = new Map<string, MeshData>([["cube", mesh([-5, -5, -5], [5, 5, 5])]]);
    const at = (x: number): Xform[] => [{ op: "translate", v: [x, 0, 0] }];
    const model = {
      parts: [part("a", "cube", { xf: at(-50) }), part("b", "cube", { xf: at(50) }), part("c", "cube", { xf: at(0), hidden: true }), part("m.1", "cube", { kind: "component", name: "m", xf: [{ op: "translate", v: [0, 100, 0] }], mass: 20 })],
    } as unknown as Model;
    const solid = (h: string) => ({ mesh: meshes.get(h), volume: 1000 });
    const two = massProperties(model, solid, (p) => p.id === "a" || p.id === "b");
    // steel, 7.85 g/cm³: 7.85 g each, 100 mm apart
    expect(two.mass).toBeCloseTo(15.7, 6);
    expect(two.com[0]).toBeCloseTo(0, 6);
    // each cube's own m·s²/6 plus m·d² about Z
    const own = (7.85 * 100) / 6;
    expect(rel(two.inertia[8], 2 * (own + 7.85 * 2500))).toBeLessThan(1e-6);
    expect(rel(two.inertia[0], 2 * own)).toBeLessThan(1e-6);
    // about a point 50 mm along Y the parallel axes add m·d² to Ixx and Izz
    const Ip = inertiaAbout(two, [0, 50, 0]);
    expect(rel(Ip[0], two.inertia[0] + 15.7 * 2500)).toBeLessThan(1e-6);
    // the component weighs what it says
    const all = massProperties(model, solid);
    expect(all.mass).toBeCloseTo(35.7, 6);
    expect(all.solids).toBe(3);
    expect(massPropsText(all, [0, 0, 0])).toMatch(/centre of mass \(0, 56\.02, 0\) mm/);
  });

  it("finds a turned box's principal axes", () => {
    const xf: Xform[] = [{ op: "rotate", angle: 30, origin: [0, 0, 0], axis: [0, 0, 1] }];
    const m = meshMoments(mesh([-50, -10, -5], [50, 10, 5]), xf);
    const mp = combine([{ mass: 10, com: m.com, second: m.cov.map((x) => x * (10 / m.volume)) as M3 }], 1, 0);
    // the long side, turned 30° about Z
    const a = mp.principal.axes[0];
    expect(Math.abs(a[0])).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(Math.abs(a[1])).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(mp.principal.moments[0]).toBeCloseTo((10 * (400 + 100)) / 12, 4);
    // products of inertia show up along the world axes
    expect(Math.abs(mp.inertia[1])).toBeGreaterThan(1);
  });

  it("counts solids still building as pending", () => {
    const model = { parts: [part("a", "none")] } as unknown as Model;
    const mp = massProperties(model, () => undefined);
    expect(mp.solids).toBe(0);
    expect(mp.pending).toBe(1);
  });
});
