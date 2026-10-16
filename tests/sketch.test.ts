import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import * as R from "replicad";
import { parse } from "../src/lang/parser";
import { evaluate } from "../src/lang/evaluator";
import { buildPart } from "../src/kernel/build";
import { firstConflict, solveSketch, type SketchDef } from "../src/sketch/solver";
import { buildProfile } from "../src/sketch/regions";
import type { EvalSketch } from "../src/sketch/types";

const RECT = `
sketch base {
  line l1 = (0, 0) -> (40, 0)
  line l2 = l1.end -> (40, 25)
  line l3 = l2.end -> (0, 25)
  line l4 = l3.end -> l1.start
  horizontal l1, l3
  vertical l2, l4
  coincident l1.start, origin
  length l1 = w
  length l2 = h
}`;

const design = (body: string, params = "param w = 40\nparam h = 25") => `design "t"\n${params}\n${body}\n`;
const sketchOf = (src: string, name?: string): EvalSketch => {
  const m = evaluate(src);
  const sk = name ? m.sketches.find((s) => s.name === name) : m.sketches[0];
  if (!sk) throw new Error("no sketch: " + JSON.stringify(m.diagnostics));
  return sk;
};
const pt = (sk: EvalSketch, id: string) => {
  const p = sk.points.find((q) => q.id === id)!;
  return [p.x, p.y];
};

describe("sketch syntax", () => {
  it("parses geometry, constraints and dimensions", () => {
    const { program, diagnostics } = parse(design(RECT));
    expect(diagnostics).toEqual([]);
    const s = program.stmts.find((x) => x.k === "sketch");
    expect(s?.k).toBe("sketch");
    if (s?.k !== "sketch") return;
    expect(s.items.filter((i) => i.k === "entity").length).toBe(4);
    const len = s.items.find((i) => i.k === "constraint" && i.name === "length");
    expect(len && len.k === "constraint" && len.value?.k).toBe("ident");
  });

  it("parses circles, arcs, construction geometry and flags", () => {
    const { diagnostics, program } = parse(`sketch s {
  plane: -XZ
  offset: 5
  locked
  construction line axis = (0, -10) -> (0, 10)
  circle c = (0, 0), d: 10
  arc a = (5, 0) -> (-5, 0), center: (0, 0)
  point p = (3, 4)
  tangent a, c
}`);
    expect(diagnostics).toEqual([]);
    const s = program.stmts[0];
    if (s.k !== "sketch") throw new Error();
    const axis = s.items.find((i) => i.k === "entity" && i.name === "axis");
    expect(axis && axis.k === "entity" && axis.construction).toBe(true);
    expect(s.items.some((i) => i.k === "flag" && i.name === "locked")).toBe(true);
  });

  it("reports a malformed line with its position", () => {
    const { diagnostics } = parse(`sketch s {\n  line l1 = (0, 0) (10, 0)\n}`);
    expect(diagnostics[0]?.severity).toBe("error");
    expect(diagnostics[0].start).toBeGreaterThan(10);
  });
});

describe("constraint solver", () => {
  const rect = (extra: SketchDef["constraints"] = []): SketchDef => ({
    points: [
      { id: "a", x: 0, y: 0, fixed: true },
      { id: "b", x: 9, y: 1, fixed: false },
      { id: "c", x: 10, y: 6, fixed: false },
      { id: "d", x: 1, y: 5, fixed: false },
    ],
    lines: [
      { id: "l1", a: "a", b: "b" },
      { id: "l2", a: "b", b: "c" },
      { id: "l3", a: "c", b: "d" },
      { id: "l4", a: "d", b: "a" },
    ],
    circles: [],
    arcs: [],
    constraints: [
      { kind: "horizontal", refs: ["a", "b"], src: 0 },
      { kind: "horizontal", refs: ["c", "d"], src: 1 },
      { kind: "vertical", refs: ["b", "c"], src: 2 },
      { kind: "vertical", refs: ["d", "a"], src: 3 },
      ...extra,
    ],
  });

  it("squares up a rough rectangle and counts what is left free", () => {
    const r = solveSketch(rect());
    expect(r.ok).toBe(true);
    expect(r.points.b[1]).toBeCloseTo(0, 9);
    expect(r.points.c[0]).toBeCloseTo(r.points.b[0], 9);
    expect(r.points.d[0]).toBeCloseTo(0, 9);
    // width and height are still free
    expect(r.dof).toBe(2);
    expect(r.freedom.b.kind).toBe("line");
    expect(r.freedom.c.kind).toBe("free");
  });

  it("moves geometry as little as possible", () => {
    const r = solveSketch(rect());
    // b only needed to drop onto the x axis; its x stays near where it was drawn
    expect(r.points.b[0]).toBeCloseTo(9.5, 0);
  });

  it("is fully defined with two dimensions", () => {
    const r = solveSketch(
      rect([
        { kind: "length", refs: ["l1"], value: 40, src: 4 },
        { kind: "length", refs: ["l2"], value: 25, src: 5 },
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    expect(r.points.c).toEqual([40, 25]);
    expect(Object.values(r.freedom).every((f) => f.kind === "fixed" || f.kind === "defined")).toBe(true);
  });

  it("flags a redundant constraint instead of failing", () => {
    const r = solveSketch(rect([{ kind: "parallel", refs: ["l1", "l3"], src: 4 }]));
    expect(r.ok).toBe(true);
    expect(r.redundant).toEqual([4]);
  });

  it("blames the constraint that causes a conflict", () => {
    const def = rect([
      { kind: "length", refs: ["l1"], value: 40, src: 4 },
      { kind: "length", refs: ["l3"], value: 30, src: 5 },
    ]);
    const r = solveSketch(def);
    expect(r.ok).toBe(false);
    expect(firstConflict(def)).toBe(5);
  });

  it("makes a line tangent to an arc it shares an end with", () => {
    const def: SketchDef = {
      points: [
        { id: "p", x: 0, y: 0, fixed: true },
        { id: "q", x: 10, y: 1, fixed: false },
        { id: "c", x: 10, y: 6, fixed: false },
        { id: "e", x: 15, y: 5, fixed: false },
      ],
      lines: [{ id: "l", a: "p", b: "q" }],
      circles: [],
      arcs: [{ id: "a", c: "c", a: "q", b: "e" }],
      constraints: [
        { kind: "horizontal", refs: ["p", "q"], src: 0 },
        { kind: "tangent", refs: ["l", "a"], src: 1 },
      ],
    };
    const r = solveSketch(def);
    expect(r.ok).toBe(true);
    const [q, c, e] = [r.points.q, r.points.c, r.points.e];
    // radius at the joint is perpendicular to the line (which is horizontal)
    expect(c[0] - q[0]).toBeCloseTo(0, 6);
    // both ends of the arc stay on one radius
    expect(Math.hypot(e[0] - c[0], e[1] - c[1])).toBeCloseTo(Math.hypot(q[0] - c[0], q[1] - c[1]), 6);
  });

  it("drags a point while the others follow the constraints", () => {
    const def = rect();
    def.points[2] = { ...def.points[2], x: 30, y: 20 };
    const r = solveSketch(def, { heavy: ["c"] });
    expect(r.ok).toBe(true);
    expect(r.points.c[0]).toBeCloseTo(30, 3);
    expect(r.points.c[1]).toBeCloseTo(20, 3);
    expect(r.points.b[0]).toBeCloseTo(30, 6);
    expect(r.points.d[1]).toBeCloseTo(20, 6);
  });
});

describe("profiles", () => {
  const P = { a: [0, 0], b: [10, 0], c: [10, 10], d: [0, 10], o: [5, 5] } as Record<string, [number, number]>;
  const square = [
    { id: "l1", a: "a", b: "b" },
    { id: "l2", a: "b", b: "c" },
    { id: "l3", a: "c", b: "d" },
    { id: "l4", a: "d", b: "a" },
  ];

  it("finds a region with a hole and its exact area", () => {
    const pr = buildProfile(P, square, [], [{ id: "c1", c: "o", r: 2 }]);
    expect(pr.error).toBeUndefined();
    expect(pr.regions.length).toBe(1);
    expect(pr.regions[0].holes.length).toBe(1);
    expect(pr.area).toBeCloseTo(100 - Math.PI * 4, 9);
  });

  it("names the open end of an unfinished outline", () => {
    const pr = buildProfile(P, square.slice(0, 3), [], []);
    expect(pr.regions.length).toBe(0);
    expect(pr.error?.message).toMatch(/open/);
    expect(pr.error?.refs.length).toBeGreaterThan(0);
  });

  it("rejects a profile that crosses itself", () => {
    const bow = [
      { id: "l1", a: "a", b: "c" },
      { id: "l2", a: "c", b: "b" },
      { id: "l3", a: "b", b: "d" },
      { id: "l4", a: "d", b: "a" },
    ];
    const pr = buildProfile(P, bow, [], []);
    expect(pr.error?.message).toMatch(/cross/);
  });

  it("treats an island inside a hole as its own region", () => {
    const pr = buildProfile(P, square, [], [
      { id: "c1", c: "o", r: 4 },
      { id: "c2", c: "o", r: 2 },
    ]);
    expect(pr.regions.length).toBe(2);
    expect(pr.area).toBeCloseTo(100 - Math.PI * 16 + Math.PI * 4, 9);
  });
});

describe("sketches in a design", () => {
  it("solves from parameters and is fully defined", () => {
    const sk = sketchOf(design(RECT));
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(pt(sk, "l2.end")).toEqual([40, 25]);
    expect(sk.points.find((p) => p.id === "l2.end")?.status).toBe("defined");
    expect(sk.profile.area).toBeCloseTo(1000);
  });

  it("follows a parameter change", () => {
    const sk = sketchOf(design(RECT, "param w = 60\nparam h = 25"));
    expect(pt(sk, "l2.end")).toEqual([60, 25]);
  });

  it("records the dependency from parameters to the sketch to the part", () => {
    const m = evaluate(design(RECT + `\npart plate { body extrude(base, 5) }`));
    expect(m.graph.edges).toEqual(expect.arrayContaining([{ from: "w", to: "base" }, { from: "base", to: "plate" }]));
    expect(m.sketches[0].usedBy).toEqual(["plate"]);
    expect(m.graph.nodes.find((n) => n.id === "base")?.kind).toBe("sketch");
  });

  it("places a sketch on the XZ plane in world space", () => {
    const m = evaluate(design(RECT.replace("sketch base {", "sketch base {\n  plane: XZ\n  offset: 3") + `\nlet corner = base.l2.end`));
    expect(m.diagnostics).toEqual([]);
    const p = m.parts.length;
    expect(p).toBe(0);
    const sk = m.sketches[0];
    expect(sk.frame.n).toEqual([0, -1, 0]);
    expect(sk.frame.o).toEqual([0, -3, 0]);
  });

  it("exposes sketch geometry to later expressions", () => {
    const m = evaluate(design(RECT + `\nparam diag = 1\nlet d = base.l1.length + base.area / 1000\nrequire "wide enough": base.l1.length >= 30`));
    expect(m.diagnostics).toEqual([]);
    expect(m.requirements[0].status).toBe("pass");
  });

  it("flips a plane with a minus sign", () => {
    const sk = sketchOf(design(RECT.replace("sketch base {", "sketch base {\n  plane: -XY")));
    expect(sk.frame.n).toEqual([-0, -0, -1]);
    expect(sk.frame.u[0]).toBe(-1);
  });

  it("accepts a custom plane", () => {
    const sk = sketchOf(design(RECT.replace("sketch base {", "sketch base {\n  plane: plane(origin: (0, 0, 10), normal: (1, 1, 0))")));
    expect(sk.frame.o).toEqual([0, 0, 10]);
    expect(sk.frame.n[0]).toBeCloseTo(Math.SQRT1_2);
    expect(sk.frame.u[2]).toBeCloseTo(0);
  });

  it("suggests the right name for a misspelled constraint and keeps solving the rest", () => {
    const src = design(RECT.replace("vertical l2, l4", "verticle l2, l4"));
    const m = evaluate(src);
    const err = m.diagnostics.find((d) => d.severity === "error");
    expect(err?.message).toMatch(/Did you mean "vertical"/);
    const sk = m.sketches[0];
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(2);
  });

  it("marks the conflicting constraint in the source", () => {
    const src = design(RECT + "").replace("length l2 = h", "length l2 = h\n  length l4 = 30");
    const m = evaluate(src);
    const sk = m.sketches[0];
    expect(sk.solved).toBe(false);
    const bad = sk.constraints.find((c) => c.status === "conflict");
    expect(src.slice(bad!.span.start, bad!.span.end)).toMatch(/length l4 = 30/);
    expect(m.diagnostics.some((d) => d.severity === "error" && /cannot hold together/.test(d.message))).toBe(true);
  });

  it("warns about a redundant constraint", () => {
    const m = evaluate(design(RECT.replace("length l2 = h", "length l2 = h\n  parallel l1, l3")));
    expect(m.sketches[0].constraints.find((c) => c.kind === "parallel")?.status).toBe("redundant");
    expect(m.diagnostics.some((d) => d.severity === "warning" && /Already implied/.test(d.message))).toBe(true);
  });

  it("rejects geometry used before it is declared", () => {
    const m = evaluate(`sketch s {\n  length l9 = 4\n  line l1 = (0, 0) -> (1, 0)\n}`);
    expect(m.diagnostics[0].message).toMatch(/not geometry/);
  });

  it("explains why an open sketch cannot be extruded", () => {
    const m = evaluate(design(RECT.replace("line l4 = l3.end -> l1.start", "") .replace("vertical l2, l4", "vertical l2").replace("coincident l1.start, origin", "fix l1.start") + `\npart p { body extrude(base, 5) }`));
    expect(m.diagnostics.some((d) => /no usable profile.*open/.test(d.message))).toBe(true);
  });

  it("refuses to revolve a profile that crosses its axis", () => {
    const m = evaluate(`sketch s {\n  circle c = (0, 0), r: 5\n}\npart p { body revolve(s, axis: s.y_axis) }`);
    expect(m.diagnostics.some((d) => /crosses the axis/.test(d.message))).toBe(true);
  });

  it("keeps the point-list revolve working", () => {
    const m = evaluate(`part p { body revolve([(0, 0), (5, 0), (5, 10), (0, 10)]) }`);
    expect(m.diagnostics).toEqual([]);
    expect(m.parts[0].recipe.base?.t).toBe("revolve");
  });

  it("rounds and cuts profile corners while dimensions keep their sharp corners", () => {
    const one = sketchOf(design(RECT.replace("length l2 = h", "length l2 = h\n  fillet l1, l2 = 5")));
    expect(pt(one, "l1.end")).toEqual([40, 0]);
    expect(one.profile.corners.length).toBe(1);
    expect(one.profile.area).toBeCloseTo(1000 - (25 - (Math.PI * 25) / 4), 6);
    const all = sketchOf(design(RECT.replace("length l2 = h", "length l2 = h\n  chamfer l1.start, l1.end, l2.end, l3.end = 2")));
    expect(all.profile.area).toBeCloseTo(1000 - 4 * 2, 6);
  });

  it("explains a fillet that is too big for its lines", () => {
    const m = evaluate(design(RECT.replace("length l2 = h", "length l2 = h\n  fillet l2.start, l2.end = 14")));
    expect(m.sketches[0].profile.error?.message).toMatch(/smaller radius/);
  });

  it("follows geometry projected from an earlier sketch", () => {
    const tab = (w: number) =>
      sketchOf(
        design(RECT + `\nsketch tab {\n  line t1 = base.l2.end -> (50, 25)\n  line t2 = t1.end -> (50, 0)\n  line t3 = t2.end -> base.l1.end\n  horizontal t1, t3\n  vertical t2\n  hdistance t1.start, t1.end = 10\n}`, `param w = ${w}\nparam h = 25`),
        "tab",
      );
    const a = tab(40);
    expect(a.dof).toBe(0);
    expect(pt(a, "t1.end")).toEqual([50, 25]);
    expect(a.curves.some((c) => c.external)).toBe(false);
    const b = tab(60);
    expect(pt(b, "t1.end")).toEqual([70, 25]);
    expect(b.points.find((p) => p.id === "base.l2.end")?.external).toBe(true);
  });

  it("projects references from a sketch on another plane", () => {
    const sk = sketchOf(
      design(`sketch side {\n  plane: XZ\n  point tip = (12, 30)\n  fix tip\n}\nsketch top {\n  plane: XY\n  circle c = (0, 0), d: 4\n  coincident c.center, side.tip\n  diameter c = 4\n}`),
      "top",
    );
    // XZ x maps to world X; the projection onto XY drops the height
    expect(pt(sk, "c.center")).toEqual([12, 0]);
    expect(sk.dof).toBe(0);
  });

  it("projects another sketch's line for a point-on-line relation", () => {
    const sk = sketchOf(design(RECT + `\nsketch s2 {\n  point p = (10, 30)\n  coincident p, base.l3\n  hdistance origin, p = 10\n}`), "s2");
    expect(pt(sk, "p")).toEqual([10, 25]);
    const ext = sk.curves.find((c) => c.id === "base.l3");
    expect(ext?.external && ext.construction).toBe(true);
  });

  it("asks for a circle's centre when another sketch's circle is used as a point", () => {
    const m = evaluate(design(`sketch a {\n  circle c = (0, 0), r: 3\n}\nsketch b {\n  point p = (1, 1)\n  coincident p, a.c\n}`));
    expect(m.diagnostics.map((d) => d.message).join("\n")).toMatch(/a\.c\.center/);
  });

  it("does not rebuild a part when an unrelated sketch changes", () => {
    const a = evaluate(design(RECT + `\nsketch other {\n  circle c = (0, 0), r: 3\n}\npart plate { body extrude(base, 5) }`));
    const b = evaluate(design(RECT + `\nsketch other {\n  circle c = (0, 0), r: 4\n}\npart plate { body extrude(base, 5) }`));
    expect(a.parts[0].hash).toBe(b.parts[0].hash);
  });
});

describe("sketch solids (OpenCASCADE)", () => {
  beforeAll(async () => {
    const wasm = fileURLToPath(new URL("../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
    const OC = await (opencascade as unknown as (o: { locateFile: () => string }) => Promise<unknown>)({ locateFile: () => wasm });
    R.setOC(OC as never);
  }, 60_000);

  const volumes = (src: string) => {
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return Object.fromEntries(m.parts.map((p) => [p.name, R.measureShapeVolumeProperties(buildPart(p.recipe)).volume]));
  };

  it("extrudes a plate with a hole, and revolves a profile with an arc", () => {
    const v = volumes(`
sketch plate_sk {
  line l1 = (0, 0) -> (40, 0)
  line l2 = l1.end -> (40, 25)
  line l3 = l2.end -> (0, 25)
  line l4 = l3.end -> l1.start
  circle c1 = (20, 12.5), d: 8
}
sketch prof {
  plane: XZ
  line a = (5, 0) -> (15, 0)
  line b = a.end -> (15, 10)
  arc c = b.end -> (5, 10), center: (10, 10)
  line d = c.end -> a.start
}
part plate { body extrude(plate_sk, 5) }
part ring { body revolve(prof, axis: prof.y_axis) }
part slab { body extrude(prof, 10, symmetric: true) }
sketch rounded {
  line l1 = (0, 0) -> (20, 0)
  line l2 = l1.end -> (20, 10)
  line l3 = l2.end -> (0, 10)
  line l4 = l3.end -> l1.start
  fillet l1.start, l1.end, l2.end, l3.end = 2
}
part pad { body extrude(rounded, 3) }
part cutaway {
  body box(50, 30, 10, at: (20, 12.5, -2))
  cut extrude(plate_sk, 1, through: true)
}`);
    const profArea = 100 + (Math.PI * 25) / 2;
    expect(v.plate).toBeCloseTo(5000 - Math.PI * 16 * 5, 3);
    // Pappus: area × path of the centroid (x = 10)
    expect(v.ring).toBeCloseTo(profArea * 2 * Math.PI * 10, 2);
    expect(v.slab).toBeCloseTo(profArea * 10, 3);
    expect(v.pad).toBeCloseTo((200 - 4 * (4 - Math.PI)) * 3, 3);
    // the cut leaves the frame around the plate plus the plug where the hole was
    expect(v.cutaway).toBeCloseTo(50 * 30 * 10 - (1000 - Math.PI * 16) * 10, 2);
  });
});
