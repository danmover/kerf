// Mesh import: STL, OBJ and 3MF files read, repaired and turned into solids
// with flat faces merged, hollows kept, holes found and big meshes simplified.

import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { loadOC } from "./occt";
import { earClip, parseObj, parseStl, readMeshFile } from "../src/kernel/meshRead";
import { repairMesh, weldCorners } from "../src/kernel/meshRepair";
import { meshCylinders, meshFaces } from "../src/kernel/meshFaces";
import { simplifyMesh } from "../src/kernel/meshSimplify";
import { readMesh, repairSummary } from "../src/kernel/meshImport";
import { smoothFaceted } from "../src/kernel/meshSmooth";
import { mountingHoles } from "../src/kernel/imports";
import { KernelCore } from "../src/kernel/core";
import { writeStl } from "../src/persist/files";
import { threeMfFiles, IDENTITY, translation } from "../src/persist/meshFormats";
import { zip } from "../src/persist/zip";
import { evaluate } from "../src/lang/evaluator";

type P3 = [number, number, number];

/** A box as 12 triangles facing out, its corners repeated per triangle like an STL. */
function boxTris(lo: P3, hi: P3, inward = false): number[] {
  const c = (i: number): P3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const out: number[] = [];
  for (const q of quads) {
    const tri = [
      [q[0], q[1], q[2]],
      [q[0], q[2], q[3]],
    ];
    for (const t of tri) for (const i of inward ? [t[0], t[2], t[1]] : t) out.push(...c(i));
  }
  return out;
}

function soup(...parts: number[][]) {
  const positions = Float64Array.from(parts.flat());
  const triangles = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { positions, triangles };
}

function stlOf(positions: ArrayLike<number>): Uint8Array {
  const n = positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + t * 50 + 12 + k * 4, positions[t * 9 + k], true);
  return new Uint8Array(buf);
}

/** A UV sphere: smooth, so no two triangles share a plane. */
function sphere(r: number, rings: number, segs: number): number[] {
  const p = (i: number, j: number): P3 => {
    const th = (Math.PI * i) / rings;
    const ph = (2 * Math.PI * j) / segs;
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
  };
  const out: number[] = [];
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < segs; j++) {
      const a = p(i, j),
        b = p(i + 1, j),
        c = p(i + 1, j + 1),
        d = p(i, j + 1);
      if (i > 0) out.push(...a, ...b, ...d);
      if (i < rings - 1) out.push(...b, ...c, ...d);
    }
  return out;
}

const core = new KernelCore();

/** A kernel-built part tessellated the way CAD programs write STL files. */
function cadStl(src: string): Uint8Array {
  const m = evaluate(src);
  const p = m.parts[0];
  core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
  const mesh = core.mesh(p.hash, "final");
  return new Uint8Array(writeStl([{ mesh, xf: [] }]));
}

beforeAll(loadOC, 60_000);

describe("reading mesh files", () => {
  it("reads binary and text STL, OBJ with quads, and fills polygons by ear clipping", async () => {
    const box = boxTris([0, 0, 0], [10, 20, 30]);
    const bin = parseStl(stlOf(box), "box");
    expect(bin).toHaveLength(1);
    expect(bin[0].triangles.length).toBe(36);
    const text = `solid part\n${Array.from({ length: 12 }, (_, t) => `facet normal 0 0 0\nouter loop\n${[0, 1, 2].map((k) => `vertex ${box[t * 9 + k * 3]} ${box[t * 9 + k * 3 + 1]} ${box[t * 9 + k * 3 + 2]}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid part\n`;
    const txt = parseStl(new TextEncoder().encode(text));
    expect(txt[0].name).toBe("part");
    expect(Array.from(txt[0].positions)).toEqual(box);
    const obj = parseObj("o cube\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n");
    expect(obj.meshes[0].name).toBe("cube");
    expect(obj.meshes[0].triangles.length).toBe(36);
    // an L shape needs clipping, a fan would cross outside it
    const L: P3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [1, 1, 0],
      [1, 2, 0],
      [0, 2, 0],
    ];
    const tris = earClip(L)!;
    expect(tris).toHaveLength(12);
    let area = 0;
    for (let k = 0; k < tris.length; k += 3) {
      const [a, b, c] = [L[tris[k]], L[tris[k + 1]], L[tris[k + 2]]];
      area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    expect(area).toBeCloseTo(3, 9);
  });

  it("reads 3MF packages with units, transforms and colours", async () => {
    const mesh = core.mesh((() => {
      const m = evaluate('design "t"\npart a { body box(10, 10, 10) }');
      const p = m.parts[0];
      core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
      return p.hash;
    })(), "final");
    const files = threeMfFiles(
      [
        { name: "red", color: "#ff0000", mesh, matrix: IDENTITY },
        { name: "blue", color: "#0000ff", mesh, matrix: translation(30, 0, 0) },
      ],
      "pair",
    );
    const data = await zip(files);
    const f = await readMeshFile(data, "pair.3mf");
    expect(f.unit).toBe("millimeter");
    expect(f.meshes.map((m) => m.name)).toEqual(["red", "blue"]);
    expect(f.meshes.map((m) => m.color)).toEqual(["#ff0000", "#0000ff"]);
    const xs = Array.from(f.meshes[1].positions).filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(25, 6);
  });
});

describe("repairing meshes", () => {
  it("welds corners, turns stray triangles and inside-out shells, and closes gaps", () => {
    const box = boxTris([0, 0, 0], [10, 10, 10]);
    // flip one triangle and drop another
    const bad = box.slice();
    [bad[3], bad[4], bad[5], bad[6], bad[7], bad[8]] = [bad[6], bad[7], bad[8], bad[3], bad[4], bad[5]];
    const open = bad.slice(9);
    const { bodies, report } = repairMesh(soup(open));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].closed).toBe(true);
    expect(bodies[0].volume).toBeCloseTo(1000, 6);
    expect(report.welded).toBeGreaterThan(0);
    expect(report.holes).toBe(1);
    expect(repairSummary(report)).toMatch(/closed 1 gap/);
    const inside = repairMesh(soup(boxTris([0, 0, 0], [10, 10, 10], true)));
    expect(inside.report.insideOut).toBe(1);
    expect(inside.bodies[0].volume).toBeCloseTo(1000, 6);
  });

  it("keeps a shell inside another as its hollow, and separate shells as separate bodies", () => {
    const hollow = repairMesh(soup(boxTris([0, 0, 0], [10, 10, 10]), boxTris([2, 2, 2], [8, 8, 8])));
    expect(hollow.bodies).toHaveLength(1);
    expect(hollow.bodies[0].shellStarts).toEqual([0, 12]);
    expect(hollow.bodies[0].volume).toBeCloseTo(1000 - 216, 6);
    expect(hollow.report.voids).toBe(1);
    const two = repairMesh(soup(boxTris([0, 0, 0], [10, 10, 10]), boxTris([20, 0, 0], [25, 5, 5])));
    expect(two.bodies.map((b) => Math.round(b.volume))).toEqual([1000, 125]);
  });

  it("merges a corner only with its own copies", () => {
    const w = weldCorners([0, 0, 0, 0, 0, 0, 1e-6, 0, 0, 1, 0, 0], 1e-4);
    expect(w.positions.length).toBe(6);
    expect(Array.from(w.remap)).toEqual([0, 0, 0, 1]);
  });
});

describe("mesh faces", () => {
  it("merges each flat side into one face and finds the drilled hole", () => {
    const stl = cadStl('design "t"\npart plate { body box(40, 30, 6) cut hole(d: 8, through: true, at: (0, 0, 6)) }');
    const raw = parseStl(stl)[0];
    const { bodies } = repairMesh(raw);
    expect(bodies).toHaveLength(1);
    const set = meshFaces(bodies[0], 2e-4);
    const flat = set.faces.filter((f) => f.tris.length > 1 || f.loops.length > 1);
    // top and bottom (each with the hole), four sides, and the hole's facets
    expect(set.faces.filter((f) => f.loops.length === 2)).toHaveLength(2);
    expect(flat.length).toBeGreaterThanOrEqual(6);
    const cyl = meshCylinders(set, 0);
    const holes = cyl.filter((c) => c.hole && c.sweep > 0.95);
    expect(holes).toHaveLength(1);
    expect(holes[0].d).toBeCloseTo(8, 1);
    expect(Math.abs(holes[0].end[2] - holes[0].start[2])).toBeCloseTo(6, 3);
  });
});

describe("mesh solids", () => {
  it("imports a CAD program's STL as one sound solid with its hole to align to", async () => {
    const stl = cadStl('design "t"\npart plate { body box(40, 30, 6) cut hole(d: 8, through: true, at: (0, 0, 6)) }');
    const { bodies, meta } = await readMesh(stl, "plate.stl");
    expect(bodies).toHaveLength(1);
    expect(meta.bodies[0].kind).toBe("solid");
    expect(meta.bodies[0].name).toBe("plate");
    expect(meta.bodies[0].volume).toBeCloseTo(40 * 30 * 6 - Math.PI * 16 * 6, -1);
    expect(meta.bodies[0].faces).toBeLessThan(80);
    const holes = mountingHoles(meta);
    expect(holes).toHaveLength(1);
    expect(holes[0].d).toBeCloseTo(8, 1);
    // a real solid: it can be cut
    const cut = bodies[0].cut(R.makeBaseBox(10, 10, 10).translate([20, 15, 0]) as never);
    expect(R.measureVolume(cut as never)).toBeLessThan(meta.bodies[0].volume);
  });

  it("imports a smooth mesh, a hollow and an open box", async () => {
    const ball = await readMesh(stlOf(sphere(10, 24, 48)), "ball.stl");
    expect(ball.meta.bodies[0].kind).toBe("solid");
    expect(ball.meta.bodies[0].volume).toBeGreaterThan(0.95 * (4 / 3) * Math.PI * 1000);
    const hollow = await readMesh(stlOf([...boxTris([0, 0, 0], [10, 10, 10]), ...boxTris([2, 2, 2], [8, 8, 8])]), "hollow.stl");
    expect(hollow.meta.bodies).toHaveLength(1);
    expect(hollow.meta.bodies[0].volume).toBeCloseTo(784, 3);
    expect(hollow.meta.warnings.join(" ")).toMatch(/hollow/);
    const open = await readMesh(stlOf(boxTris([0, 0, 0], [10, 10, 10]).slice(18)), "open.stl");
    expect(open.meta.bodies[0].kind).toBe("solid");
    expect(open.meta.bodies[0].faces).toBe(6);
    expect(open.meta.warnings.join(" ")).toMatch(/closed 1 gap/);
  });

  it("reads a tiny unitless mesh in metres", async () => {
    const m = await readMesh(stlOf(boxTris([0, 0, 0], [0.05, 0.02, 0.01])), "blender.stl");
    expect(m.meta.bbox[1][0]).toBeCloseTo(50, 4);
    expect(m.meta.warnings.join(" ")).toMatch(/metres/);
  });

  it("simplifies a mesh too big to keep as it is", () => {
    const { bodies } = repairMesh(soup(sphere(10, 60, 120)));
    const before = bodies[0].triangles.length / 3;
    const small = simplifyMesh(bodies[0], 2000);
    expect(small.triangles.length / 3).toBeLessThanOrEqual(2010);
    expect(small.triangles.length / 3).toBeLessThan(before);
    const again = repairMesh(small);
    expect(again.bodies).toHaveLength(1);
    expect(again.bodies[0].closed).toBe(true);
    expect(again.bodies[0].volume).toBeGreaterThan(0.97 * (4 / 3) * Math.PI * 1000);
  });
});

describe("showing faceted solids", () => {
  it("shades gentle facets smooth without lines between them, and keeps sharp edges crisp", () => {
    // a flat face, a face tilted 8 degrees from it along one edge, and a wall folded 90 degrees along another
    const faces: P3[][] = [
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[0, 10, 0], [10, 0, 0], [10, 10, 1]],
      [[10, 0, 0], [0, 0, 0], [0, 0, -10]],
    ];
    const positions: number[] = [];
    const normals: number[] = [];
    for (const [a, b, c] of faces) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      for (const p of [a, b, c]) positions.push(...p), normals.push(n[0] / l, n[1] / l, n[2] / l);
    }
    const edges = [10, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 1];
    const out = smoothFaceted({
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      edges: Float32Array.from(edges),
      faceGroups: Int32Array.from([0, 3, 0, 3, 3, 1, 6, 3, 2]),
      edgeGroups: Int32Array.from([0, 2, 0, 2, 2, 1, 4, 2, 2]),
    });
    // the flat face's corner on the gentle edge leans towards the tilted face, not the wall
    expect(out.normals[3]).toBeLessThan(-0.01);
    expect(out.normals[5]).toBeGreaterThan(0.99);
    expect(out.normals[4]).toBeLessThan(0);
    expect(out.normals[4]).toBeGreaterThan(-0.1);
    // the wall keeps its own normal
    expect(out.normals[6 * 3 + 1]).toBeCloseTo(-1, 6);
    // the line along the gentle edge goes; the fold and the open border keep theirs
    expect(Array.from(out.edgeGroups!).filter((_, i) => i % 3 === 2)).toEqual([1, 2]);
    expect(out.edges).toHaveLength(12);
  });
});
