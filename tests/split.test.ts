import { beforeAll, describe, expect, it } from "vitest";
import { initKernel } from "./helpers/kernel";
import { evaluate } from "../src/lang/evaluator";
import { buildPart, meshShape, solidVolume, type MeshData } from "../src/kernel/build";
import { splitTable } from "../src/core/splitGeom";
import { bomRows } from "../src/persist/files";
import { envelopeFit } from "../src/mfg/analyze";
import { rulesOnMachine } from "../src/mfg/report";
import type { Model } from "../src/core/model";
import { applyQuick, parseQuick, vocabOf } from "../src/core/quickCommands";
import { setBlockProps } from "../src/core/sourceEdit";
import { splitItems } from "../src/core/splitChecks";
import { madeParts } from "../src/machine/pack";

/** The engine's two passes: the split part built whole, its cuts and pins from that mesh, then the pieces. */
function splitEval(src: string, table = splitTable()): Model {
  const meshes = new Map<string, MeshData>();
  let model = evaluate(src, { splits: table.lookup });
  for (let pass = 0; pass < 3; pass++) {
    for (const q of model.splitQueries ?? []) {
      if (meshes.has(q.hash)) continue;
      const p = model.parts.find((x) => x.hash === q.hash);
      if (p) meshes.set(q.hash, meshShape(buildPart(p.recipe), "preview"));
    }
    if (!table.resolve(model, (h) => meshes.get(h))) break;
    model = evaluate(src, { splits: table.lookup });
  }
  return model;
}

const errors = (m: Model) => m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const warnings = (m: Model) => m.diagnostics.filter((d) => d.severity === "warning").map((d) => d.message);
const pieces = (m: Model, name: string) => m.parts.filter((p) => p.name === name || (p.split?.part === name && p.split.piece !== undefined));
const vol = (r: Parameters<typeof buildPart>[0]) => solidVolume(buildPart(r));

describe("pieces() and split:", () => {
  it("reads directions, cuts, counts and pins, and says what is wrong", () => {
    const m = evaluate(`part bar { body box(400, 60, 40)  split: pieces(X, at: [100, -50], pins: 3, pin: (4, 16)) }`);
    expect(errors(m)).toEqual([]);
    const q = m.splitQueries![0];
    expect(q.spec).toEqual({ axes: [{ dir: [1, 0, 0], at: [-50, 100] }], join: "dowel", pins: 3, pin: 4, length: 16 });
    // until the cuts are worked out the part is whole
    expect(pieces(m, "bar").map((p) => p.id)).toEqual(["bar"]);
    expect(m.splits?.[0].status).toBe("waiting");
    const bad = (split: string) => errors(evaluate(`part bar { body box(400, 60, 40)  split: ${split} }`))[0] ?? "";
    expect(bad(`pieces(X, at: [100], count: 3)`)).toMatch(/at: \(where the cuts are\) or count:/);
    expect(bad(`pieces(X, count: 1)`)).toMatch(/2 to 31/);
    expect(bad(`pieces(X, join: "glue", pins: 2)`)).toMatch(/has no pins/);
    expect(bad(`pieces(X, join: "rivets")`)).toMatch(/"dowel", "printed", "glue", "none"/);
    expect(bad(`pieces(X, pin: (4, 6))`)).toMatch(/twice as long/);
    expect(bad(`[X, pieces(X, at: [0])]`)).toMatch(/two of the directions are the same/);
    expect(bad(`"x"`)).toMatch(/should be a direction like X, Y or Z/);
    expect(bad(`pieces(X, at: [10, 11])`)).toMatch(/less than 2 mm apart/);
  });
});

describe("splitting a part as built", () => {
  beforeAll(initKernel, 60_000);

  it("cuts a bar too long for the printer into the fewest pieces that fit, on two dowels", () => {
    const m = splitEval(`part bar {
      material: "PLA"
      process: mfg.fdm()
      body box(400, 60, 40)
      split: X
    }`);
    expect(errors(m)).toEqual([]);
    const ps = pieces(m, "bar");
    expect(ps.map((p) => p.id)).toEqual(["bar_1", "bar_2"]);
    expect(ps.map((p) => p.name)).toEqual(["bar_1", "bar_2"]);
    expect(ps.map((p) => p.label)).toEqual(["bar (piece 1 of 2)", "bar (piece 2 of 2)"]);
    const rec = m.splits![0];
    expect(rec.status).toBe("split");
    expect(rec.cuts).toEqual([{ axis: "x", at: [0] }]);
    // the section is 60 × 40: two 5 mm pins fit with walls round them
    expect(rec.pin).toMatchObject({ d: 5, length: 20, count: 2, name: "bar_pins", hole: 5.2 });
    expect(rec.joints).toEqual([expect.objectContaining({ axis: "x", at: 0, pins: 2 })]);
    expect(rec.joints[0].area).toBeGreaterThan(2300);
    expect(rec.joints[0].area).toBeLessThan(2500);
    // each piece fits the build volume
    const env = rulesOnMachine({ id: "fdm", settings: {} }, "PLA").envelope!;
    for (const s of rec.sizes) expect(envelopeFit(s, env).fits).toBe(true);
    // the pins are dowels, two of them, on the parts list
    const pins = m.parts.filter((p) => p.name === "bar_pins");
    expect(pins).toHaveLength(2);
    expect(pins.every((p) => p.libKind === "dowel" && p.split?.part === "bar")).toBe(true);
    const row = bomRows(m).find((r) => r.description.startsWith("Dowel pin"));
    expect(row).toMatchObject({ qty: 2, description: "Dowel pin 5×20", kind: "Buy" });
    // the pieces add up to the bar less the pin holes: each pin 10.5 mm into each piece
    const holes = 4 * Math.PI * 2.6 ** 2 * 10.5;
    const whole = 400 * 60 * 40;
    const sum = ps.reduce((t, p) => t + vol(p.recipe), 0);
    expect(Math.abs(sum - (whole - holes)) / whole).toBeLessThan(0.002);
    // the pins sit across the cut, well apart, inside the bar
    const at = pins.map((p) => p.xf.find((x) => x.op === "translate"));
    for (const t of at) {
      const v = (t as { v: [number, number, number] }).v;
      expect(v[0]).toBeCloseTo(-10, 5);
      expect(Math.abs(v[1])).toBeLessThanOrEqual(30 - 2.6 - 2);
      expect(v[2]).toBeGreaterThanOrEqual(2.6 + 2);
      expect(v[2]).toBeLessThanOrEqual(40 - 2.6 - 2);
    }
    const [a, b] = at.map((t) => (t as { v: [number, number, number] }).v);
    expect(Math.hypot(a[1] - b[1], a[2] - b[2])).toBeGreaterThan(40);
  });

  it("cuts into equal pieces, at given heights, and on the printer chosen", () => {
    const three = splitEval(`part bar { material: "PETG"  process: mfg.fdm()  body box(450, 40, 30)  split: pieces(X, count: 3) }`);
    expect(three.splits![0].cuts[0].at).toEqual([-75, 75]);
    expect(pieces(three, "bar")).toHaveLength(3);
    // the middle piece has holes from both ends
    expect(pieces(three, "bar")[1].recipe.ops.filter((o) => o.op === "cut")).toHaveLength(4);
    const at = splitEval(`part bar { material: "PETG"  process: mfg.fdm()  body box(450, 40, 30)  split: pieces(X, at: [100]) }`);
    expect(at.splits![0].cuts[0].at).toEqual([100]);
    expect(at.splits![0].sizes.map((s) => s[0])).toEqual([325, 125]);
    // a bigger printer takes the bar in fewer pieces
    const big = splitTable(() => ({ machines: [], machineFor: {} }));
    const onBig = splitEval(`part bar { material: "PETG"  process: mfg.fdm(bed: (500, 500, 500))  body box(450, 40, 30)  split: X }`, big);
    expect(onBig.splits![0].status).toBe("whole");
    expect(warnings(onBig).join(" ")).toMatch(/fits the printer's build volume in one piece/);
    expect(pieces(onBig, "bar").map((p) => p.id)).toEqual(["bar"]);
  });

  it("finds no room for pins in thin walls and says so", () => {
    const m = splitEval(`part duct {
      material: "PETG"
      process: mfg.fdm()
      body box(420, 60, 60)
      shell(2, open: [X, -X])
      split: X
    }`);
    expect(pieces(m, "duct")).toHaveLength(2);
    expect(m.splits![0].pin).toBeUndefined();
    expect(warnings(m).join(" ")).toMatch(/the joint at x = 0 has no room for pins/);
  });

  it("cuts a plate in a grid, pins in every joint", () => {
    const m = splitEval(`part plate { material: "PLA"  process: mfg.fdm()  body box(400, 400, 12)  split: [X, Y] }`);
    expect(errors(m)).toEqual([]);
    const rec = m.splits![0];
    expect(rec.pieces).toHaveLength(4);
    expect(rec.joints).toHaveLength(4);
    expect(rec.joints.every((j) => j.pins === 2)).toBe(true);
    // a pattern of pins per direction
    expect(new Set(m.parts.filter((p) => p.libKind === "dowel").map((p) => p.name))).toEqual(new Set(["plate_pins_1", "plate_pins_2"]));
    const sum = pieces(m, "plate").reduce((t, p) => t + vol(p.recipe), 0);
    expect(sum).toBeLessThan(400 * 400 * 12);
    expect(sum).toBeGreaterThan(400 * 400 * 12 * 0.995);
  });

  it("glues, prints its own pins, or just cuts", () => {
    const glue = splitEval(`part bar { material: "PLA"  process: mfg.fdm()  body box(400, 60, 40)  split: pieces(X, join: "glue") }`);
    expect(pieces(glue, "bar").map((p) => p.held)).toEqual([undefined, "glued to the piece beside it"]);
    expect(glue.parts.some((p) => p.libKind === "dowel")).toBe(false);
    const printed = splitEval(`part bar { material: "PLA"  process: mfg.fdm()  body box(400, 60, 40)  split: pieces(X, join: "printed") }`);
    const pins = printed.parts.find((p) => p.name === "bar_pins")!;
    expect(pins.kind).toBe("part");
    expect(pins.process?.id).toBe("fdm");
    expect(printed.splits![0].pin?.hole).toBe(5.3);
    const none = splitEval(`part bar { material: "PLA"  process: mfg.fdm()  body box(400, 60, 40)  split: pieces(X, join: "none") }`);
    expect(pieces(none, "bar").every((p) => !p.recipe.ops.some((o) => o.op === "cut"))).toBe(true);
  });

  it("asks where to cut a part with no machine, refuses moving and sheet parts, and gives the whole to shape_of()", () => {
    const loose = splitEval(`part bar { body box(400, 60, 40)  split: X }`);
    expect(errors(loose).join(" ")).toMatch(/no machine to fit .*pieces\(X, at: \[\.\.\]\)/);
    expect(pieces(loose, "bar")).toHaveLength(1);
    const spun = evaluate(`part rotor { body box(400, 60, 40)  spin: 1  split: pieces(X, at: [0]) }`);
    expect(errors(spun).join(" ")).toMatch(/a moving part is made whole/);
    const m = splitEval(`part bar { material: "PLA"  process: mfg.fdm()  body box(400, 60, 40)  split: X }
part cover { body box(420, 80, 50) at: (0, 0, -5)  cut shape_of(bar) }`);
    expect(errors(m)).toEqual([]);
    const cover = m.parts.find((p) => p.name === "cover")!;
    const cut = cover.recipe.ops.find((o) => o.op === "cut") as { shape: { t: string; part?: { ops: unknown[] } } };
    expect(cut.shape.t).toBe("part");
    expect(cut.shape.part?.ops).toEqual([]);
  });
});

describe("split parts in the rest of the design", () => {
  beforeAll(initKernel, 60_000);
  const BAR = `part bar {
  material: "PLA"
  process: mfg.fdm()
  body box(400, 60, 40)
  split: X
}
`;

  it("files each piece as a part to print, and the pins as bought parts", () => {
    const m = splitEval(BAR);
    const made = madeParts(m);
    expect(made.map((x) => x.names)).toEqual([["bar_1"], ["bar_2"]]);
    expect(made.map((x) => x.file)).toEqual(["print/bar_1.stl", "print/bar_2.stl"]);
    const item = splitItems(m)[0];
    expect(item).toMatchObject({ id: "split:bar", status: "pass", title: "bar is made in 2 pieces" });
    expect(item.detail).toMatch(/^Cut across x at x = 0, the fewest pieces that fit the printer's build volume \(250 × 210 × 210 mm\)\. Pieces bar_1 and bar_2: 200 × 60 × 40; 200 × 60 × 40 mm\. 2 steel dowel pins Ø5 × 20 mm \(ISO 8734\), up to 2 in each joint, in Ø5.2 mm holes 10.5 mm deep/);
    // a piece is edited through its part
    expect(setBlockProps(BAR, "bar_2", { color: "#ff0000" })).toMatch(/part bar \{\n  color: #ff0000/);
  });

  it("lets analyses, mates and other parts name the whole part", () => {
    const m = splitEval(`${BAR}
part base { body box(500, 100, 10) at: (0, 0, -10) }
mate seat = against(face(bar, -Z), face(base, +Z))
analysis "Bar load" {
  fix: face(bar, -X)
  load: force(face(bar, +X), 100N, dir: -Z)
  parts: [bar]
}`);
    expect(errors(m)).toEqual([]);
    expect(m.analyses[0].kind === "structural" && m.analyses[0].parts).toEqual(["bar_1", "bar_2"]);
    expect(m.mates?.list[0].status).not.toBe("conflict");
    // a single piece can be analysed on its own, but the whole part's faces need every piece
    const one = splitEval(`${BAR}
analysis "Half" {
  fix: face(bar, -X)
  parts: [bar_1]
}`);
    expect(errors(one).join("\n")).toMatch(/face\(bar, …\) is every piece of bar \(it is made in pieces\), and parts: leaves some out\. Give parts: \[bar\], or name single pieces, like face\(bar_1, -Z\)/);
  });

  it("splits from a quick command, across the part's longest side", () => {
    const src = `part rail { material: "PETG"  process: mfg.fdm()  body box(60, 420, 20) }
`;
    const model = evaluate(src);
    const cmd = parseQuick("split it into 3", vocabOf(model))!;
    expect(cmd).toEqual({ k: "split", count: 3, target: undefined });
    const r = applyQuick(cmd, { src, model, target: "rail", box: () => [[-30, -210, 0], [30, 210, 20]] });
    expect(r.ok && r.src).toMatch(/split: pieces\(Y, count: 3\)/);
    expect(parseQuick("split along x", vocabOf(model))).toEqual({ k: "split", axis: 0, target: undefined });
    expect(parseQuick("halve the rail and glue it", vocabOf(model))).toEqual({ k: "split", count: 2, glue: true, target: "rail" });
    const glued = applyQuick(parseQuick("halve the rail and glue it", vocabOf(model))!, { src, model, box: () => [[-30, -210, 0], [30, 210, 20]] });
    expect(glued.ok && glued.src).toMatch(/split: pieces\(Y, count: 2, join: "glue"\)/);
    // a command on a piece goes to its part
    const m = splitEval(`part rail { material: "PETG"  process: mfg.fdm()  body box(60, 420, 20)  split: Y }\n`);
    const moved = applyQuick(parseQuick("move 10 up", vocabOf(m))!, { src: `part rail { material: "PETG"  process: mfg.fdm()  body box(60, 420, 20)  split: Y }\n`, model: m, target: "rail_2" });
    expect(moved.ok && moved.src).toMatch(/at: \(0, 0, 10\)/);
    // splitting it again goes across its longest side, measured over its pieces
    const halves = (b: string): [[number, number, number], [number, number, number]] | undefined => (b === "rail_1" ? [[-30, -210, 0], [30, 0, 20]] : b === "rail_2" ? [[-30, 0, 0], [30, 210, 20]] : undefined);
    const again = applyQuick(parseQuick("split it into 3", vocabOf(m))!, { src: `part rail { material: "PETG"  process: mfg.fdm()  body box(60, 420, 20)  split: Y }\n`, model: m, target: "rail_2", box: halves });
    expect(again.ok && again.src).toMatch(/split: pieces\(Y, count: 3\)/);
  });
});
