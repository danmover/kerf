// The interference check: an exact boolean for parts that come close, and a
// mesh test that skips the boolean for parts that are well apart (even inside
// each other's bounding boxes) without missing a part wholly inside another.

import { beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { KernelCore } from "../src/kernel/core";
import { buildChecksRequest } from "../src/core/checks";
import { apart, closedSurface, placeSurface } from "../src/kernel/apart";
import type { MeshData } from "../src/kernel/build";
import { initKernel } from "./helpers/kernel";

/** A closed box mesh from lo to hi, its faces' corners repeated the way the kernel's meshes repeat them. */
function boxMesh(lo: number[], hi: number[], dropFace = false): MeshData {
  const c = (i: number) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const f of faces.slice(dropFace ? 1 : 0)) {
    const base = positions.length / 3;
    for (const i of f) positions.push(...c(i));
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(positions.length), indices: new Uint32Array(indices), edges: new Float32Array(0) };
}

const placed = (m: MeshData) => placeSurface(closedSurface(m)!, []);

describe("mesh proof that two solids are apart", () => {
  it("needs a closed mesh", () => {
    expect(closedSurface(boxMesh([0, 0, 0], [1, 1, 1]))).not.toBeNull();
    expect(closedSurface(boxMesh([0, 0, 0], [1, 1, 1], true))).toBeNull();
  });

  it("calls boxes with a clear gap apart, and boxes that nearly touch, touch or cross not", () => {
    const a = placed(boxMesh([0, 0, 0], [10, 10, 10]));
    expect(apart(a, placed(boxMesh([13, 0, 0], [20, 10, 10])))).toBe(true);
    expect(apart(a, placed(boxMesh([11.5, 0, 0], [20, 10, 10])))).toBe(false);
    expect(apart(a, placed(boxMesh([10, 0, 0], [20, 10, 10])))).toBe(false);
    expect(apart(a, placed(boxMesh([5, 5, 5], [20, 20, 20])))).toBe(false);
    // edges crossing through each other with no corner inside the other box
    expect(apart(a, placed(boxMesh([-5, 3, 3], [15, 7, 7])))).toBe(false);
  });

  it("does not call a box inside another apart", () => {
    const outer = placed(boxMesh([0, 0, 0], [10, 10, 10]));
    const inner = placed(boxMesh([4, 4, 4], [6, 6, 6]));
    expect(apart(outer, inner)).toBe(false);
    expect(apart(inner, outer)).toBe(false);
  });

  it("does not call a part apart when only one of its pieces is inside the other", () => {
    const outer = placed(boxMesh([0, 0, 0], [10, 10, 10]));
    const clear = boxMesh([20, 0, 0], [22, 2, 2]);
    const buried = boxMesh([4, 4, 4], [6, 6, 6]);
    // one part made of two separate boxes, the clear one first
    const offset = clear.positions.length / 3;
    const both: MeshData = {
      positions: new Float32Array([...clear.positions, ...buried.positions]),
      normals: new Float32Array(clear.positions.length + buried.positions.length),
      indices: new Uint32Array([...clear.indices, ...[...buried.indices].map((i) => i + offset)]),
      edges: new Float32Array(0),
    };
    expect(closedSurface(both)!.pieces).toHaveLength(2);
    expect(apart(outer, placed(both))).toBe(false);
    expect(apart(outer, placed(clear))).toBe(true);
  });
});

describe("interference check", () => {
  beforeAll(() => initKernel());

  function check(src: string, core = new KernelCore()) {
    const model = evaluate(src);
    for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    return core.checks(buildChecksRequest(model, new Set(model.parts.map((p) => p.hash))));
  }

  it("finds parts that overlap", () => {
    const r = check(`part a { body box(20, 20, 20) }\npart b { body box(20, 20, 20, at: (10, 0, 0)) }`);
    expect(r.pairsTested).toBe(1);
    expect(r.interferences).toHaveLength(1);
    expect(r.interferences[0].volume).toBeCloseTo(4000, 0);
  });

  it("finds a part wholly inside another, though their surfaces never meet", () => {
    const r = check(`part block { body box(40, 40, 40) }\npart chip { body box(4, 4, 4, at: (0, 0, 10)) }`);
    expect(r.interferences).toHaveLength(1);
    expect(r.interferences[0].volume).toBeCloseTo(64, 0);
  });

  it("passes a part sitting clear inside a tube's bore", () => {
    const r = check(`part sleeve { body tube(od: 60, id: 40, h: 50) }\npart core { body box(10, 10, 10, at: (0, 0, 20)) }`);
    expect(r.pairsTested).toBe(1);
    expect(r.interferences).toEqual([]);
  });

  it("keeps results across checks and hands out a fresh overlap mesh each time", () => {
    const core = new KernelCore();
    const src = `part a { body box(20, 20, 20) }\npart b { body box(20, 20, 20, at: (10, 0, 0)) }`;
    const first = check(src, core);
    const mesh = first.interferences[0].mesh!;
    // the worker transfers the mesh to the page, which empties these arrays here
    structuredClone(mesh, { transfer: [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer, mesh.edges.buffer] });
    expect(mesh.positions.length).toBe(0);
    const again = check(src, core);
    expect(again.interferences[0].volume).toBe(first.interferences[0].volume);
    expect(again.interferences[0].mesh!.positions.length).toBeGreaterThan(0);
  });
});
