import { describe, expect, it } from "vitest";
import { bevelBands, type BevelInput } from "../src/ui/viewport/render/bevel";

// A box meshed the way the kernel meshes a solid: each face on its own, with its own copies of its corners.
function box(w: number, d: number, h: number): BevelInput {
  const P: number[] = [];
  const N: number[] = [];
  const I: number[] = [];
  const G: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  const half = [w / 2, d / 2, h / 2];
  faces.forEach(([n, u, v], f) => {
    const base = P.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) P.push((n[k] + u[k] * su + v[k] * sv) * half[k]);
      N.push(...n);
    }
    G.push(I.length, 6, f);
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return { positions: new Float32Array(P), normals: new Float32Array(N), indices: new Uint32Array(I), faceGroups: new Int32Array(G) };
}

describe("rounded edges", () => {
  it("lays two strips along each of a box's twelve edges", () => {
    const b = bevelBands(box(10, 20, 30))!;
    expect(b.segments).toBe(12);
    expect(b.indices.length).toBe(12 * 2 * 2 * 3);
    // every strip lies flat on its face, wound the same way as the face
    const P = b.positions;
    const B = b.bevel;
    for (let t = 0; t < b.indices.length; t += 3) {
      const at = (i: number) => {
        const v = b.indices[t + i];
        return [0, 1, 2].map((k) => P[v * 3 + k] + B[v * 4 + k]);
      };
      const [p0, p1, p2] = [at(0), at(1), at(2)];
      const u = p1.map((x, k) => x - p0[k]);
      const v = p2.map((x, k) => x - p0[k]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const vi = b.indices[t + 2];
      const fn = [0, 1, 2].map((k) => b.normals[vi * 3 + k] / 32767);
      // the inner corner's normal is its face's, and the triangle faces the same way
      expect(n[0] * fn[0] + n[1] * fn[1] + n[2] * fn[2]).toBeGreaterThan(0);
    }
  });

  it("turns the normal halfway at the edge and keeps the face's own on the inner side", () => {
    const b = bevelBands(box(10, 10, 10))!;
    let edge = 0;
    let inner = 0;
    for (let v = 0; v < b.bevel.length / 4; v++) {
      const reach = Math.hypot(b.bevel[v * 4], b.bevel[v * 4 + 1], b.bevel[v * 4 + 2]);
      const n = [0, 1, 2].map((k) => b.normals[v * 3 + k] / 32767);
      const big = Math.max(...n.map(Math.abs));
      if (reach === 0) {
        edge++;
        expect(big).toBeCloseTo(Math.SQRT1_2, 3);
      } else {
        inner++;
        expect(big).toBeCloseTo(1, 3);
        // never more than its face allows: under half the face
        expect(reach).toBeLessThan(5);
      }
    }
    expect(edge).toBe(24);
    expect(inner).toBe(48);
  });

  it("leaves smooth joins alone", () => {
    // two faces of one flat square, split down the middle: their shared edge is not an edge of the solid
    const m: BevelInput = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0]),
      normals: new Float32Array(Array.from({ length: 8 }, () => [0, 0, 1]).flat()),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
      faceGroups: new Int32Array([0, 6, 0, 6, 6, 1]),
    };
    expect(bevelBands(m)).toBeNull();
  });
});
