// Direct editing: push_pull, replace_faces, delete_faces and move_faces on Kerf's own parts, on an imported STEP
// body and on a mesh made solid. Volumes are checked against the exact answers.

import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import type { Shape3D } from "replicad";
import { initKernel } from "./helpers/kernel";
import { buildPart, registerImport } from "../src/kernel/build";
import { replaceFaces } from "../src/kernel/direct";
import { directEdit } from "../src/core/directEdits";
import { readStep } from "../src/kernel/stepImport";
import { readMesh } from "../src/kernel/meshImport";
import { KernelCore } from "../src/kernel/core";
import type { ImportTable } from "../src/kernel/imports";
import { evaluate } from "../src/lang/evaluator";
import { writeStl } from "../src/persist/files";

beforeAll(initKernel, 60_000);

const PI = Math.PI;

function evalParts(body: string, imports?: ImportTable) {
  const m = evaluate(`design "t"\n${body}\n`, imports ? { imports } : undefined);
  return { m, errors: m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) };
}

/** Each part's solid. */
function built(body: string, imports?: ImportTable): Record<string, Shape3D> {
  const { m, errors } = evalParts(body, imports);
  expect(errors).toEqual([]);
  return Object.fromEntries(m.parts.map((p) => [p.name, buildPart(p.recipe)]));
}

/** The message a part fails to build with. */
function buildError(body: string): string {
  const { m, errors } = evalParts(body);
  expect(errors).toEqual([]);
  try {
    buildPart(m.parts[0].recipe);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

const vol = (s: Shape3D) => R.measureVolume(s);
const top = (s: Shape3D) => s.boundingBox.bounds[1][2];
/** How much of a small upright cylinder at (x, y) the solid fills: 1 solid there, 0 a hole there. */
function filled(s: Shape3D, x: number, y: number, z0 = 0, h = 10, d = 1): number {
  const probe = R.makeCylinder(d / 2, h, [x, y, z0]) as Shape3D;
  return vol(s.intersect(probe) as Shape3D) / vol(probe);
}

/** The exact volume of a square frustum 40 wide at the base whose sides lean in 10°. */
function frustum(h: number): number {
  const b = 40 - 2 * h * Math.tan((10 * PI) / 180);
  return (h / 3) * (40 * 40 + 40 * b + b * b);
}

describe("push_pull", { timeout: 60_000 }, () => {
  it("pushes and pulls a flat face, and stretches square and sloping sides to follow", () => {
    const b = built(`
part up { body box(40, 30, 10) push_pull(5, faces: facing(Z)) }
part down { body box(40, 30, 10) push_pull(-4, faces: facing(Z)) }
part corner { body box(40, 30, 10) push_pull(5, faces: [facing(X), facing(Y)]) }
part taller { body extrude(rect(40, 40), 10, taper: 10) push_pull(5, faces: facing(Z)) }
part lower { body extrude(rect(40, 40), 10, taper: 10) push_pull(-4, faces: facing(Z)) }
`);
    expect(vol(b.up)).toBeCloseTo(40 * 30 * 15, 3);
    expect(top(b.up)).toBeCloseTo(15, 6);
    expect(vol(b.down)).toBeCloseTo(40 * 30 * 6, 3);
    // the two sides meet at their corner: the box is simply bigger
    expect(vol(b.corner)).toBeCloseTo(45 * 35 * 10, 3);
    expect(b.corner.faces).toHaveLength(6);
    // the sloping sides carry on at their slope, up and down
    expect(vol(b.taller)).toBeCloseTo(frustum(15), 2);
    expect(vol(b.lower)).toBeCloseTo(frustum(6), 2);
    expect(b.taller.faces).toHaveLength(6);
  });

  it("makes a hole or a boss bigger or smaller", () => {
    const b = built(`
part wider { body box(40, 30, 10) cut hole(d: 6, through: true, at: (0, 0, 10)) push_pull(-1, faces: circles(6)) }
part narrower { body box(40, 30, 10) cut hole(d: 6, through: true, at: (0, 0, 10)) push_pull(0.5, faces: circles(6)) }
part fatter { body box(40, 30, 10) add cylinder(d: 10, h: 8, at: (5, 0, 10)) as boss push_pull(1, faces: circles(10)) }
`);
    expect(vol(b.wider)).toBeCloseTo(12000 - PI * 16 * 10, 2);
    expect(vol(b.narrower)).toBeCloseTo(12000 - PI * 6.25 * 10, 2);
    expect(vol(b.fatter)).toBeCloseTo(12000 + PI * 36 * 8, 2);
  });

  it("says what to do when a round runs into the face, or nothing is picked", () => {
    expect(buildError(`part p { body box(40, 30, 10) fillet(2, edges: "top") push_pull(3, faces: facing(Z)) }`)).toMatch(/round runs into its edge.*delete_faces/);
    expect(buildError(`part p { body box(40, 30, 10) push_pull(3, faces: near((100, 0, 0), 0.1)) }`)).toMatch(/matched no faces/);
    expect(evalParts(`part p { body box(40, 30, 10) push_pull(0, faces: facing(Z)) }`).errors.join(" ")).toMatch(/can't be 0/);
    expect(evalParts(`part p { body box(40, 30, 10) push_pull(2) }`).errors.join(" ")).toMatch(/faces: says which faces/);
  });
});

describe("delete_faces", { timeout: 60_000 }, () => {
  it("fills holes and pockets and cuts off bosses", () => {
    const b = built(`
part a { body box(40, 30, 10) cut hole(d: 6, through: true, at: (0, 0, 10)) delete_faces(faces: circles(6)) }
part blind { body box(40, 30, 10) cut cylinder(d: 6, h: 6, at: (0, 0, 4)) delete_faces(faces: circles(6)) }
part bossed { body box(40, 30, 10) add cylinder(d: 10, h: 8, at: (5, 0, 10)) as boss delete_faces(faces: boss.faces) }
part pocketed { body box(40, 30, 10) cut box(20, 10, 5, at: (0, 0, 5)) as pocket delete_faces(faces: pocket.faces) }
`);
    for (const k of ["a", "blind", "bossed", "pocketed"]) {
      expect(vol(b[k])).toBeCloseTo(12000, 2);
      expect(b[k].faces).toHaveLength(6);
    }
  });

  it("turns rounds and chamfers back into sharp edges, outside and in", () => {
    const b = built(`
part round { body box(40, 30, 10) fillet(3, edges: near((20, 0, 10))) delete_faces(faces: near((19.121, 0, 9.121), 0.1)) }
part bevel { body box(40, 30, 10) chamfer(2, edges: near((20, 0, 10))) delete_faces(faces: near((19, 0, 9), 0.1)) }
part inside { body box(40, 30, 10) add box(10, 30, 20, at: (-15, 0, 10)) fillet(2, edges: near((-10, 0, 10))) delete_faces(faces: near((-9.414, 0, 10.586), 0.1)) }
part all { body box(40, 30, 10) fillet(2) delete_faces(faces: "all" - facing(X) - facing(-X) - facing(Y) - facing(-Y) - facing(Z) - facing(-Z)) }
`);
    expect(vol(b.round)).toBeCloseTo(12000, 2);
    expect(vol(b.bevel)).toBeCloseTo(12000, 2);
    expect(vol(b.inside)).toBeCloseTo(18000, 2);
    expect(b.inside.faces).toHaveLength(8);
    // every round of a rounded box, corners and all
    expect(vol(b.all)).toBeCloseTo(12000, 2);
    expect(b.all.faces).toHaveLength(6);
  });

  it("refuses faces that can't be healed", () => {
    expect(buildError(`part p { body box(40, 30, 10) delete_faces(faces: facing(Z)) }`)).toMatch(/can't work out what the picked faces would heal into/);
  });
});

describe("move_faces", { timeout: 60_000 }, () => {
  it("moves, turns and copies features, healing where they were", () => {
    const b = built(`
part moved { body box(40, 30, 10) cut hole(d: 6, through: true, at: (0, 0, 10)) move_faces(faces: circles(6), by: (10, 5, 0)) }
part copies { body box(40, 30, 10) cut hole(d: 6, through: true, at: (0, 0, 10)) move_faces(faces: circles(6), by: (-10, 0, 0), copy: true) }
part bossed { body box(40, 30, 10) add cylinder(d: 10, h: 8, at: (5, 0, 10)) as boss move_faces(faces: boss.faces, by: (-15, 0, 0)) }
part turned { body box(40, 30, 10) cut box(20, 4, 10, at: (0, 0, 0)) as groove move_faces(faces: groove.faces, turn: 90) }
`);
    expect(vol(b.moved)).toBeCloseTo(12000 - PI * 9 * 10, 2);
    expect(filled(b.moved, 0, 0)).toBeCloseTo(1, 3);
    expect(filled(b.moved, 10, 5)).toBeCloseTo(0, 3);
    expect(vol(b.copies)).toBeCloseTo(12000 - 2 * PI * 9 * 10, 2);
    expect(filled(b.copies, 0, 0) + filled(b.copies, -10, 0)).toBeCloseTo(0, 3);
    expect(vol(b.bossed)).toBeCloseTo(12000 + PI * 25 * 8, 2);
    expect(filled(b.bossed, -10, 0, 10, 8)).toBeCloseTo(1, 3);
    expect(filled(b.bossed, 5, 0, 10, 8)).toBeCloseTo(0, 3);
    // the slot along x now runs along y
    expect(vol(b.turned)).toBeCloseTo(12000 - 20 * 4 * 10, 2);
    expect(filled(b.turned, 8, 0)).toBeCloseTo(1, 3);
    expect(filled(b.turned, 0, 8)).toBeCloseTo(0, 3);
  });

  it("moves a flat side along its normal as a push, and won't move a round", () => {
    const b = built(`part side { body box(40, 30, 10) move_faces(faces: facing(X), by: (5, 0, 0)) }`);
    expect(vol(b.side)).toBeCloseTo(45 * 30 * 10, 3);
    expect(buildError(`part p { body box(40, 30, 10) fillet(3, edges: near((20, 0, 10))) move_faces(faces: near((19.121, 0, 9.121), 0.1), by: (0, 0, -1)) }`)).toMatch(/rounds and chamfers can't be moved/);
  });
});

describe("from the 3D view", { timeout: 60_000 }, () => {
  const src = `design "t"
part plate {
  body box(40, 30, 10)
  cut cylinder(d: 6, h: 20, at: (0, 0, -5))
}
`;
  it("adds the edit as the part's last step, one undoable change", () => {
    const model = evaluate(src);
    const r = directEdit(src, model, { k: "push_pull", by: 2 }, [{ block: "plate", faces: "near((10, 5, 10), 0.25)", count: 1 }]);
    if (!r.ok) throw new Error(r.why);
    expect(r.src).toContain("  cut cylinder(d: 6, h: 20, at: (0, 0, -5))\n  push_pull(2, faces: near((10, 5, 10), 0.25))\n}");
    expect(r.title).toBe("Pushed a face of plate out 2 mm");
    expect(vol(built(r.src.replace('design "t"\n', "")).plate)).toBeCloseTo((1200 - PI * 9) * 12, 1);
    const moved = directEdit(src, model, { k: "move_faces", by: [10, 0, 0], copy: true }, [{ block: "plate", faces: "circles(6)", count: 1 }]);
    if (!moved.ok) throw new Error(moved.why);
    expect(moved.src).toContain("move_faces(faces: circles(6), by: (10, 0, 0), copy: true)");
    expect(moved.title).toBe("Copied a face of plate by (10, 0, 0)");
    expect(vol(built(moved.src.replace('design "t"\n', "")).plate)).toBeCloseTo(12000 - 2 * PI * 90, 1);
  });

  it("says why not: no distance, a locked part, a library part", () => {
    const model = evaluate(src);
    const g = [{ block: "plate", faces: "near((10, 5, 10), 0.25)", count: 1 }];
    expect(directEdit(src, model, { k: "push_pull", by: 0 }, g)).toMatchObject({ ok: false, why: expect.stringMatching(/distance in mm/) });
    expect(directEdit(src, model, { k: "move_faces", by: [0, 0, 0], copy: false }, g)).toMatchObject({ ok: false, why: expect.stringMatching(/x, y and z/) });
    const locked = src.replace("  body box", "  locked\n  body box");
    expect(directEdit(locked, evaluate(locked), { k: "delete_faces" }, g)).toMatchObject({ ok: false, why: expect.stringMatching(/locked/) });
    const lib = `design "t"\ncomponent m = lib.nema17() { at: (0, 0, 0) }\n`;
    expect(directEdit(lib, evaluate(lib), { k: "delete_faces" }, [{ block: "m", faces: "near((0, 0, 0), 0.2)", count: 1 }])).toMatchObject({ ok: false, why: expect.stringMatching(/library part/) });
  });
});

describe("replace_faces", { timeout: 60_000 }, () => {
  it("lines a face up with another face, or with a sloping plane", () => {
    const b = built(`
part flush {
  body box(40, 30, 10)
  add cylinder(d: 8, h: 8, at: (-10, 0, 10))
  add cylinder(d: 8, h: 4, at: (10, 0, 10))
  replace_faces(faces: near((10, 0, 14), 0.1), with: near((-10, 0, 18), 0.1))
}
`);
    expect(vol(b.flush)).toBeCloseTo(12000 + 2 * PI * 16 * 8, 2);
    const box = R.makeBaseBox(40, 30, 10) as Shape3D;
    const topFace = box.faces.filter((f) => f.geomType === "PLANE" && f.normalAt(f.center).z > 0.9);
    // z = 12 - 0.2 x over the top: as much again as a flat top at 12, and 16 high at x = -20
    const sloped = replaceFaces(box, topFace, { p: [0, 0, 12], n: [0.2, 0, 1] });
    expect(vol(sloped)).toBeCloseTo(40 * 30 * 12, 2);
    expect(top(sloped)).toBeCloseTo(16, 4);
  });
});

describe("direct edits on imported files", { timeout: 60_000 }, () => {
  const core = new KernelCore();
  let table: ImportTable;
  let meshVolume = 0;
  beforeAll(async () => {
    // a bracket "from another CAD program": a STEP file of a plate with a hole
    const m = evaluate('design "src"\npart bracket { body box(40, 30, 10) cut hole(d: 6, through: true, at: (0, 0, 10)) }');
    const p = m.parts[0];
    const blob = core.exportStep([{ hash: p.hash, recipe: p.recipe, name: "bracket", xf: [], color: "#888888" }]);
    const step = readStep(new Uint8Array(await blob.arrayBuffer()), "bracket.step");
    registerImport("bracket-hash", step.bodies, step.faceColors);
    // the same plate as an STL mesh: faceted, its hole a ring of flat facets
    core.build({ hash: p.hash, recipe: p.recipe, label: p.label }, "final");
    const stl = new Uint8Array(writeStl([{ mesh: core.mesh(p.hash, "final"), xf: [] }]));
    const mesh = await readMesh(stl, "plate.stl");
    registerImport("plate-hash", mesh.bodies, mesh.faceColors, true);
    meshVolume = mesh.meta.bodies[0].volume;
    table = { bracket: { name: "bracket", hash: "bracket-hash", meta: step.meta }, plate: { name: "plate", hash: "plate-hash", meta: mesh.meta } };
  });

  it("makes an imported STEP body a part and pushes, fills and moves its faces", () => {
    const b = built(
      `
part taller { body step("bracket") push_pull(2, faces: facing(Z)) }
part solid { body step("bracket") delete_faces(faces: circles(6)) }
part moved { body step("bracket") move_faces(faces: circles(6), by: (12, 0, 0)) }
`,
      table,
    );
    expect(vol(b.taller)).toBeCloseTo((1200 - PI * 9) * 12, 1);
    expect(vol(b.solid)).toBeCloseTo(12000, 1);
    expect(filled(b.moved, 12, 0)).toBeCloseTo(0, 3);
    expect(filled(b.moved, 0, 0)).toBeCloseTo(1, 3);
  });

  it("pushes a face of a mesh made solid, its faceted hole carried up with it", () => {
    const b = built(`part thicker { body step("plate") push_pull(3, faces: facing(Z)) }`, table);
    expect(vol(b.thicker)).toBeCloseTo((meshVolume * 13) / 10, 0);
    expect(top(b.thicker)).toBeCloseTo(13, 3);
  });

  it("from the 3D view, makes an imported file a part where it was, then edits it", () => {
    const src = `design "t"
component bracket = step("bracket") { at: (5, 0, 20), rotate: (0, 0, 90), color: #4f7cff }
`;
    const model = evaluate(src, { imports: table });
    expect(model.parts[0].imported).toBeTruthy();
    const r = directEdit(src, model, { k: "delete_faces" }, [{ block: "bracket", faces: "circles(6)", count: 1 }]);
    if (!r.ok) throw new Error(r.why);
    expect(r.src).toContain("part bracket {\n  at: (5, 0, 20)\n  rotate: (0, 0, 90)\n  color: #4f7cff\n  body step(\"bracket\")\n  delete_faces(faces: circles(6))\n}");
    expect(r.title).toMatch(/^Made .+ a part\. Took a face off .+ and closed it up$/);
    const next = evaluate(r.src, { imports: table });
    expect(next.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const part = next.parts[0];
    expect(part.kind).toBe("part");
    // placed as the component was: turned a quarter about Z and moved, so it spans 30 along X and 40 along Y
    const placed = model.parts[0].xf;
    expect(part.xf).toEqual(placed);
    expect(vol(buildPart(part.recipe))).toBeCloseTo(12000, 1);
  });

  it("names a missing file and a bad body number", () => {
    expect(evalParts(`part p { body step("nothing") }`, table).errors.join(" ")).toMatch(/No file named "nothing"/);
    expect(evalParts(`part p { body step("bracket", body: 3) }`, table).errors.join(" ")).toMatch(/body is the body's number from 1 to 1/);
  });
});
