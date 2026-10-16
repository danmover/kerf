// Runs the real OpenCASCADE kernel in Node: hidden-line projection, section
// cuts and measurements used by drawings and the measure tool.

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { KernelCore } from "../src/kernel/core";
import { measure, projectView, type Edge2 } from "../src/kernel/drawing";
import { evaluate } from "../src/lang/evaluator";

const require = createRequire(import.meta.url);
const core = new KernelCore();

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve("replicad-opencascadejs/wasm"));
  const OC = await (opencascade as unknown as (o: { wasmBinary: Buffer }) => Promise<unknown>)({ wasmBinary });
  R.setOC(OC as never);
}, 60_000);

const SRC = `design "Plate"
param w = 60mm
part plate {
  body box(w, 40, 8)
  cut hole(M4, through: true, at: (-20, 0, 8))
  cut hole(M4, through: true, at: (20, 0, 8))
  cut hole(10, depth: 4, at: (0, 0, 8))
}
`;

function setup() {
  const model = evaluate(SRC);
  for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
  return model;
}

const bbox = (edges: Edge2[]) => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const e of edges) {
    if (e.g.t === "L") xs.push(e.g.p[0], e.g.p[2]), ys.push(e.g.p[1], e.g.p[3]);
    else if (e.g.t === "A") xs.push(e.g.c[0] - e.g.r, e.g.c[0] + e.g.r), ys.push(e.g.c[1] - e.g.r, e.g.c[1] + e.g.r);
    else for (let i = 0; i < e.g.p.length; i += 2) xs.push(e.g.p[i]), ys.push(e.g.p[i + 1]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe("drawing projection", () => {
  it("projects the top view with exact hole circles", () => {
    const model = setup();
    const items = model.parts.map((p) => ({ id: p.id, hash: p.hash, xf: p.xf }));
    const r = projectView({ dir: [0, 0, 1], x: [1, 0, 0], items, hidden: true }, (p) => core.placed(p));
    const [x0, y0, x1, y1] = bbox(r.edges);
    expect(x0).toBeCloseTo(-30, 3);
    expect(x1).toBeCloseTo(30, 3);
    expect(y0).toBeCloseTo(-20, 3);
    expect(y1).toBeCloseTo(20, 3);
    const circles = r.edges.filter((e) => e.vis && e.g.t === "A" && e.g.a1 - e.g.a0 > 6.28);
    const radii = circles.map((e) => (e.g.t === "A" ? Math.round(e.g.r * 100) / 100 : 0)).sort();
    expect(radii).toContain(2.25);
    expect(radii).toContain(5);
  });

  it("shows the blind hole as hidden lines in the front view", () => {
    const model = setup();
    const items = model.parts.map((p) => ({ id: p.id, hash: p.hash, xf: p.xf }));
    const r = projectView({ dir: [0, -1, 0], x: [1, 0, 0], items, hidden: true }, (p) => core.placed(p));
    const hidden = r.edges.filter((e) => !e.vis);
    expect(hidden.length).toBeGreaterThan(0);
    // the counterbore floor sits 4 mm below the top face
    expect(hidden.some((e) => e.g.t === "L" && Math.abs(e.g.p[1] - 4) < 1e-6 && Math.abs(e.g.p[3] - 4) < 1e-6)).toBe(true);
    const [, y0, , y1] = bbox(r.edges);
    expect(y0).toBeCloseTo(0, 3);
    expect(y1).toBeCloseTo(8, 3);
  });

  it("cuts a section and returns the cut face for hatching", () => {
    const model = setup();
    const items = model.parts.map((p) => ({ id: p.id, hash: p.hash, xf: p.xf }));
    const r = projectView({ dir: [0, -1, 0], x: [1, 0, 0], items, hidden: false, section: { at: [0, 0, 0], normal: [0, -1, 0] } }, (p) => core.placed(p));
    expect(r.hatch.length).toBe(1);
    // the plane runs through both through holes, so the cut face comes in three pieces
    const loops = r.hatch[0].loops;
    expect(loops.length).toBe(3);
    const xs = loops.flatMap((l) => l.filter((_, i) => i % 2 === 0));
    expect(Math.min(...xs)).toBeCloseTo(-30, 3);
    expect(Math.max(...xs)).toBeCloseTo(30, 3);
    expect(xs.some((x) => Math.abs(x + 22.25) < 1e-6)).toBe(true);
  });
});

describe("measuring", () => {
  it("measures a hole face and the distance between two holes", () => {
    const model = setup();
    const plate = model.parts[0];
    const solid = core.get(plate.hash)!.shape;
    const cyl = solid.faces.filter((f) => f.geomType === "CYLINDRE");
    const left = cyl.find((f) => Math.abs(f.center.x + 20) < 1e-6)!;
    const right = cyl.find((f) => Math.abs(f.center.x - 20) < 1e-6)!;
    const a = { hash: plate.hash, xf: plate.xf, kind: "face" as const, id: left.hashCode, point: [-17.75, 0, 4] as [number, number, number] };
    const b = { hash: plate.hash, xf: plate.xf, kind: "face" as const, id: right.hashCode, point: [17.75, 0, 4] as [number, number, number] };
    const one = measure({ a }, (h) => core.get(h)?.shape);
    expect(one.a.type).toBe("cylinder");
    expect(one.a.radius).toBeCloseTo(2.25, 6);
    const two = measure({ a, b }, (h) => core.get(h)?.shape);
    expect(two.distance).toBeCloseTo(40 - 4.5, 4);
    expect(two.centerDistance).toBeCloseTo(40, 6);
    expect(two.angle).toBeCloseTo(0, 6);
  });

  it("names faces and edges in the mesh by the ids measuring looks up", () => {
    const model = setup();
    const solid = core.get(model.parts[0].hash)!.shape;
    const m = solid.mesh({ tolerance: 0.25, angularTolerance: 25 });
    const e = solid.meshEdges({ tolerance: 0.25, angularTolerance: 25 });
    const faces = new Set(solid.faces.map((f) => f.hashCode));
    const edges = new Set(solid.edges.map((x) => x.hashCode));
    expect(m.faceGroups.length).toBe(faces.size);
    expect(m.faceGroups.every((g) => faces.has(g.faceId))).toBe(true);
    expect(e.edgeGroups.every((g) => edges.has(g.edgeId))).toBe(true);
  });

  it("falls back to the nearest face when the id is stale", () => {
    const model = setup();
    const plate = model.parts[0];
    const r = measure({ a: { hash: plate.hash, xf: plate.xf, kind: "face", id: 12345, point: [0, 0, 8] } }, (h) => core.get(h)?.shape);
    expect(r.a.type).toBe("plane");
    expect(Math.abs(r.a.normal![2])).toBeCloseTo(1, 6);
  });
});
