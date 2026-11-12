import { beforeAll, describe, expect, it } from "vitest";
import * as R from "replicad";
import { fixture, loadOC } from "./occt";
import { readStep, StepReadError } from "../src/kernel/stepImport";
import { cleanName, decodeStepString, stepStructure } from "../src/kernel/stepText";
import { mountingHoles, type ImportTable } from "../src/kernel/imports";
import { registerImport } from "../src/kernel/build";
import { KernelCore } from "../src/kernel/core";
import { evaluate } from "../src/lang/evaluator";
import type { Model } from "../src/core/model";

const devboard = fixture("devboard.step");
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

/** The devboard fixture with its PCB's first face recoloured, like a pad or a silkscreen face. */
function withFaceColour(): Uint8Array {
  const text = latin1(devboard);
  const face = /#54 = CLOSED_SHELL\(''\s*,\s*\(\s*#(\d+)/.exec(text)![1];
  const extra = [
    `#90001 = STYLED_ITEM('color',(#90002),#${face});`,
    "#90002 = PRESENTATION_STYLE_ASSIGNMENT((#90003));",
    "#90003 = SURFACE_STYLE_USAGE(.BOTH.,#90004);",
    "#90004 = SURFACE_SIDE_STYLE('',(#90005));",
    "#90005 = SURFACE_STYLE_FILL_AREA(#90006);",
    "#90006 = FILL_AREA_STYLE('',(#90007));",
    "#90007 = FILL_AREA_STYLE_COLOUR('',#90008);",
    "#90008 = COLOUR_RGB('',1.,0.8,0.);",
  ].join("\n");
  return new TextEncoder().encode(text.replace(/ENDSEC;\s*END-ISO-10303-21;/, `${extra}\nENDSEC;\nEND-ISO-10303-21;`));
}

beforeAll(loadOC, 60_000);

describe("STEP text", () => {
  it("decodes STEP string escapes", () => {
    expect(decodeStepString("it''s")).toBe("it's");
    expect(decodeStepString("\\X2\\00E9\\X0\\t\\X\\E9")).toBe("été");
  });

  it("reads the assembly tree and colours from the file text", () => {
    const s = stepStructure(latin1(devboard));
    expect(s.rootName).toBe("DevBoard");
    expect(s.instances.map((i) => i.path.join("/"))).toEqual(["PCB", "J1/shell", "J1/tongue", "J2", "U1", "SW1/base", "SW1/cap", "SW2/base", "SW2/cap"]);
    expect(s.solids.size).toBe(7);
  });

  it("keeps file names from smuggling control or direction characters", () => {
    expect(cleanName("Board‮\u0007 name​")).toBe("Board name");
    expect(cleanName("x".repeat(100)).length).toBe(80);
  });
});

describe("reading STEP files", () => {
  it("names bodies by their place in the assembly and keeps their colours", () => {
    const { meta, bodies } = readStep(devboard, "devboard.step");
    expect(bodies).toHaveLength(9);
    expect(meta.title).toBe("DevBoard");
    expect(meta.bodies.map((b) => b.name)).toEqual(["PCB", "J1 › shell", "J1 › tongue", "J2", "U1", "SW1 › base", "SW1 › cap", "SW2 › base", "SW2 › cap"]);
    expect(meta.bodies[0].color).toBe("#006626");
    expect(meta.bodies[0].volume).toBeCloseTo(60 * 40 * 1.6 - 4 * Math.PI * 1.6 ** 2 * 1.6, 0);
    expect(meta.bbox[0].map((v) => +v.toFixed(2))).toEqual([-30, -20, 0]);
    expect(meta.warnings).toEqual([]);
  });

  it("finds the mounting holes", () => {
    const { meta } = readStep(devboard, "devboard.step");
    const holes = mountingHoles(meta);
    expect(holes).toHaveLength(4);
    for (const h of holes) {
      expect(h.d).toBeCloseTo(3.2, 3);
      expect(Math.abs(h.start[0])).toBeCloseTo(26, 3);
      expect(Math.abs(h.start[1])).toBeCloseTo(16, 3);
      expect(h.start[2]).toBeCloseTo(0, 3);
      expect(h.end[2]).toBeCloseTo(1.6, 3);
    }
  });

  it("names bodies the same when the assembly is placed far from the origin", () => {
    const { meta } = readStep(fixture("devboard_offset.step"), "offset.step");
    expect(meta.bodies.map((b) => b.name)).toEqual(["PCB", "J1 › shell", "J1 › tongue", "J2", "U1", "SW1 › base", "SW1 › cap", "SW2 › base", "SW2 › cap"].map((n) => `board › ${n}`));
    expect(meta.bbox[0].map((v) => +v.toFixed(2))).toEqual([120, -120, 0]);
  });

  it("rejects files that are not STEP", () => {
    expect(() => readStep(new TextEncoder().encode("solid cube\nendsolid"), "cube.stl")).toThrow(StepReadError);
  });

  it("colours individual faces in the same order the kernel meshes them", () => {
    const { meta, bodies, faceColors } = readStep(withFaceColour(), "pads.step");
    expect(meta.bodies[0].faceColors).toBe(true);
    const colours = faceColors[0]!;
    expect(colours[0]).toBe("#ffcc00");
    expect(colours.slice(1).every((c) => c === "#006626")).toBe(true);

    // build the body through the kernel and check the gold vertices all lie on the explorer's first face
    registerImport("pads", bodies, faceColors);
    const core = new KernelCore();
    core.build({ hash: "b0", label: "PCB", recipe: { base: { t: "import", asset: "pads", body: 0 }, ops: [] } });
    const mesh = core.mesh("b0", "final");
    expect(mesh.colors).toBeDefined();
    const oc = R.getOC() as never as { TopExp_Explorer: new (...a: unknown[]) => { Current(): unknown; delete(): void }; TopAbs_ShapeEnum: Record<string, unknown>; TopoDS: { Face(s: unknown): unknown } };
    const ex = new oc.TopExp_Explorer(bodies[0].wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const first = R.cast(oc.TopoDS.Face(ex.Current()) as never) as unknown as { boundingBox: { bounds: number[][] } };
    ex.delete();
    const [lo, hi] = first.boundingBox.bounds;
    let gold = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      if (mesh.colors![v * 3] !== 255) continue;
      gold++;
      for (let k = 0; k < 3; k++) {
        expect(mesh.positions[v * 3 + k]).toBeGreaterThanOrEqual(lo[k] - 1e-3);
        expect(mesh.positions[v * 3 + k]).toBeLessThanOrEqual(hi[k] + 1e-3);
      }
    }
    expect(gold).toBeGreaterThan(2);
  });
});

describe("imported files in a design", () => {
  let table: ImportTable;
  let model: Model;
  beforeAll(() => {
    const { meta, bodies, faceColors } = readStep(devboard, "devboard.step");
    registerImport("devboard-hash", bodies, faceColors);
    table = { devboard: { name: "devboard", hash: "devboard-hash", meta } };
    model = evaluate(
      `design "Board case"
component board = step("devboard") {
  at: (0, 0, 5)
}
part tray {
  body box(70, 50, 4, at: (0, 0, 0))
  for h in board.holes {
    add cylinder(d: 6, h: 1, at: (h.x, h.y, 4))
  }
}
require "Board clears the tray": min_distance(board, tray) >= 0
require "USB shell is inside the board outline": board.body("J1 › shell").max.x <= board.max.x
`,
      { imports: table },
    );
  });

  it("places one solid per body with readable labels", () => {
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const board = model.parts.filter((p) => p.name === "board");
    expect(board.map((p) => p.id)).toEqual(["board.1", "board.2", "board.3", "board.4", "board.5", "board.6", "board.7", "board.8", "board.9"]);
    expect(board[1].label).toBe("devboard: J1 › shell");
    expect(board[0].group).toBe("Imported");
    expect(board[0].bom?.description).toMatch(/DevBoard/);
    expect(board.filter((p) => p.bom)).toHaveLength(1);
    expect(board[0].imported).toMatchObject({ asset: "devboard-hash", body: 0, bodyName: "PCB", kind: "solid" });
  });

  it("puts `at` at the centre of the bottom of the file's box", () => {
    // file box x: -30 .. 33 → centre 1.5; holes at ±26 in the file
    const tray = model.parts.find((p) => p.id === "tray")!;
    const pins = tray.recipe.ops.filter((o) => o.op === "add");
    const xs = pins.map((o) => (o as { shape: { at: number[] } }).shape.at[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-27.5, 3);
    expect(xs[3]).toBeCloseTo(24.5, 3);
  });

  it("builds and checks imported bodies in the kernel", () => {
    const core = new KernelCore();
    for (const p of model.parts) core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
    const pcb = model.parts.find((p) => p.id === "board.1")!;
    const placed = core.placed(pcb);
    expect(placed.bbox[0][2]).toBeCloseTo(5, 3);
    const tray = model.parts.find((p) => p.id === "tray")!;
    const gap = core.measure([pcb], [tray]);
    expect(gap.distance).toBeCloseTo(0, 3); // the pins touch the board
    const res = core.checks({
      placed: model.parts.map((p) => ({ id: p.id, name: p.name, label: p.label, hash: p.hash, xf: p.xf, removable: false, moving: false, density: 1, noInterference: false })),
      queries: model.geoQueries,
      access: [],
      envelopes: [],
      ignorePairs: [],
    });
    // the board's own bodies never count as interfering with each other
    expect(res.interferences.filter((i) => i.a.startsWith("board") && i.b.startsWith("board"))).toEqual([]);
    expect(Object.values(res.geoErrors)).toEqual([]);
  });

  it("cuts a pocket with the file's exact shape", () => {
    const m = evaluate(
      `design "pocket"
component board = step("devboard") { at: (0, 0, 2) }
part block {
  body box(80, 60, 6, at: (0, 0, 0))
  cut board.envelope(0.5)
}`,
      { imports: table },
    );
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const core = new KernelCore();
    const block = m.parts.find((p) => p.id === "block")!;
    const e = core.build({ hash: block.hash, recipe: block.recipe, label: "block" });
    expect(e.volume).toBeCloseTo(80 * 60 * 6 - 64 * 41 * 4.5, 0);
  });

  it("explains a missing import and lists the ones there are", () => {
    const m = evaluate(`design "x"\ncomponent b = step("other") { at: (0, 0, 0) }`, { imports: table });
    expect(m.diagnostics[0].message).toMatch(/No file named "other" is imported.*"devboard"/);
  });

  it("still lets a design use the word step for its own names", () => {
    const m = evaluate(`design "x"\nparam step = 5mm\nlet twice = step * 2`, { imports: table });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("evaluates the same before the geometry is loaded (fields come from the stored analysis)", () => {
    const m = evaluate(`design "x"\ncomponent board = step("devboard") { at: (10, 0, 0) rotate: (0, 0, 90) }\nlet n = board.holes.length\nlet b = board.body("cap")`, { imports: table, skipGeometry: true });
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
