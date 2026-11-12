// Picking faces, edges and corners in the 3D view: where a pick is named
// (anchorOf), the selector it is written as, finding it again on a rebuilt
// mesh, and filleting the picked edges, checked on a real solid: the
// selector written for one picked edge rounds that edge and no other.

import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { evaluate } from "../src/lang/evaluator";
import { buildPart, meshShape, type MeshData } from "../src/kernel/build";
import { anchorOf, countText, resolvePick, selectorFor, type Pick } from "../src/app/picks";
import { applyQuick } from "../src/core/quickCommands";
import type { V3 } from "../src/kernel/recipe";
import { initKernel } from "./helpers/kernel";

/** A unit square in z = 0 as two triangles (one face), with its four sides as edges and a bent edge. */
function squareMesh(): MeshData {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  // edge 1: (0,0)→(10,0); edge 2: a bent edge (10,0)→(10,4)→(10,10), as point pairs
  const edges = new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 4, 0, 10, 4, 0, 10, 10, 0]);
  return { positions, normals, indices, edges, faceGroups: new Int32Array([0, 6, 7]), edgeGroups: new Int32Array([0, 2, 11, 2, 4, 12]) };
}

describe("where a pick is named", () => {
  const data = squareMesh();

  it("names a face by a point inside it and an edge half way along it", () => {
    const face = anchorOf("face", [1, 1, 0], [0, 6], data);
    // inside the square, off its edges
    expect(face[2]).toBe(0);
    expect(face[0]).toBeGreaterThan(0.5);
    expect(face[0]).toBeLessThan(9.5);
    expect(face[1]).toBeGreaterThan(0.5);
    expect(face[1]).toBeLessThan(9.5);
    expect(anchorOf("edge", [0, 0, 0], [0, 2], data)).toEqual([5, 0, 0]);
    // the bent edge is 10 long: half way is at y = 5, on its second segment
    expect(anchorOf("edge", [10, 0, 0], [2, 4], data)).toEqual([10, 5, 0]);
    expect(anchorOf("vertex", [10.00004, 0, 0], undefined, data)).toEqual([10, 0, 0]);
  });

  it("writes near() selectors, one or a list", () => {
    const e1: Pick = { partId: "p", kind: "edge", at: [0, 0, 0], range: [0, 2], data };
    const e2: Pick = { partId: "p", kind: "edge", at: [10, 1, 0], range: [2, 4], data };
    expect(selectorFor([e1])).toBe("near((5, 0, 0), 0.2)");
    expect(selectorFor([e1, e2])).toBe("[near((5, 0, 0), 0.2), near((10, 5, 0), 0.2)]");
    const f: Pick = { partId: "p", kind: "face", at: [2, 2, 0], range: [0, 6], data };
    expect(countText([f, e1, e2])).toBe("1 face and 2 edges");
    expect(countText([e1, { partId: "p", kind: "vertex", at: [0, 0, 0] }])).toBe("1 edge and 1 corner");
  });

  it("finds a pick again by its point, and lets it go when the part moved away", () => {
    expect(resolvePick("p", "face", [3, 6, 0.1], data)).toMatchObject({ kind: "face", id: 7, range: [0, 6] });
    expect(resolvePick("p", "face", [3, 6, 2], data)).toBeNull();
    expect(resolvePick("p", "edge", [10, 7, 0], data)).toMatchObject({ kind: "edge", id: 12, range: [2, 4] });
    expect(resolvePick("p", "edge", [5, 0.1, 0], data)).toMatchObject({ id: 11 });
    expect(resolvePick("p", "vertex", [10, 10.1, 0], data)).toMatchObject({ kind: "vertex", range: [2, 4] });
    expect(resolvePick("p", "vertex", [5, 5, 0], data)).toBeNull();
  });
});

describe("filleting picked edges", () => {
  beforeAll(() => initKernel(), 60_000);

  const SRC = `design "Picks"

part block {
  material: "PETG"
  body box(20, 20, 20)
}
`;

  it("rounds just the picked edges, by the selectors written from the mesh", () => {
    const model = evaluate(SRC);
    const part = model.parts[0];
    const shape = buildPart(part.recipe);
    const before = R.measureShapeVolumeProperties(shape).volume;
    const data = meshShape(shape, "final");
    const eg = data.edgeGroups!;
    expect(eg.length / 3).toBe(12);
    const edgeAt = (g: number): V3 => anchorOf("edge", [0, 0, 0], [eg[g * 3], eg[g * 3 + 1]], data);
    // two edges that share no corner, so each rounds on its own
    const first = edgeAt(0);
    let other = -1;
    for (let g = 1; g < 12 && other < 0; g++) {
      const a = edgeAt(g);
      const apart = first.filter((v, i) => Math.abs(v - a[i]) < 1e-6).length === 0;
      if (apart) other = g;
    }
    expect(other).toBeGreaterThan(0);
    const picked = [first, edgeAt(other)];
    const r = applyQuick({ k: "fillet", r: 2 }, { src: SRC, model, target: "block", spot: { local: picked[0], edges: picked } });
    if (!r.ok) throw new Error(r.why);
    expect(r.src).toContain("fillet(2, edges: [near((");
    expect(r.title).toMatch(/the 2 edges you picked/);
    const next = evaluate(r.src);
    expect(next.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const after = R.measureShapeVolumeProperties(buildPart(next.parts[0].recipe)).volume;
    // each rounded 20 mm edge takes off (r² − πr²/4) × 20
    const perEdge = (4 - Math.PI) * 20;
    expect(before - after).toBeCloseTo(2 * perEdge, 1);
  });
});
