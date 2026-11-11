// DXF drawings brought into sketches: what the reader understands (units,
// polylines with bulges, splines, ellipses, blocks, centre lines, other
// planes) and that the sketch it writes is exact, joined and fully defined.

import { describe, expect, it } from "vitest";
import { DxfError, readDxf, type DxfCurve } from "../src/sketch/dxfRead";
import { MAX_DXF_CURVES, dxfCountsText, dxfStatements } from "../src/sketch/dxfSketch";
import { SKETCH_RESERVED } from "../src/sketch/evaluate";
import { splineBeziers } from "../src/sketch/curves";
import { evaluate } from "../src/lang/evaluator";
import { flatsToDxf } from "../src/drawing/flat";

type G = [number, string | number][];

/** An ASCII DXF from entities given as group code pairs. */
function dxf(ents: G[], o: { units?: number; measurement?: number; layers?: [string, string, number?][]; blocks?: { name: string; base?: [number, number]; ents: G[] }[] } = {}): string {
  const out: string[] = [];
  const w = (pairs: G) => pairs.forEach(([c, v]) => out.push(String(c), String(v)));
  w([[0, "SECTION"], [2, "HEADER"]]);
  if (o.units !== undefined) w([[9, "$INSUNITS"], [70, o.units]]);
  if (o.measurement !== undefined) w([[9, "$MEASUREMENT"], [70, o.measurement]]);
  w([[0, "ENDSEC"]]);
  if (o.layers) {
    w([[0, "SECTION"], [2, "TABLES"], [0, "TABLE"], [2, "LAYER"]]);
    for (const [name, lt, flags] of o.layers) w([[0, "LAYER"], [2, name], [70, flags ?? 0], [62, 7], [6, lt]]);
    w([[0, "ENDTAB"], [0, "ENDSEC"]]);
  }
  if (o.blocks) {
    w([[0, "SECTION"], [2, "BLOCKS"]]);
    for (const b of o.blocks) {
      w([[0, "BLOCK"], [8, "0"], [2, b.name], [70, 0], [10, b.base?.[0] ?? 0], [20, b.base?.[1] ?? 0], [30, 0]]);
      b.ents.forEach(w);
      w([[0, "ENDBLK"]]);
    }
    w([[0, "ENDSEC"]]);
  }
  w([[0, "SECTION"], [2, "ENTITIES"]]);
  ents.forEach(w);
  w([[0, "ENDSEC"], [0, "EOF"]]);
  return out.join("\n");
}

const line = (x1: number, y1: number, x2: number, y2: number, extra: G = []): G => [[0, "LINE"], ...(extra.some(([c]) => c === 8) ? [] : ([[8, "0"]] as G)), ...extra, [10, x1], [20, y1], [11, x2], [21, y2]];
const circle = (x: number, y: number, r: number, extra: G = []): G => [[0, "CIRCLE"], [8, "0"], ...extra, [10, x], [20, y], [40, r]];
const arc = (x: number, y: number, r: number, a0: number, a1: number, extra: G = []): G => [[0, "ARC"], [8, "0"], ...extra, [10, x], [20, y], [40, r], [50, a0], [51, a1]];
const lwpoly = (pts: [number, number, number?][], closed: boolean, extra: G = []): G => [[0, "LWPOLYLINE"], [8, "0"], ...extra, [90, pts.length], [70, closed ? 1 : 0], ...pts.flatMap(([x, y, b]): G => [[10, x], [20, y], ...(b ? ([[42, b]] as G) : [])])];

/** A design holding the sketch the statements make, evaluated. */
function sketchFrom(st: { geometry: string[]; constraints: string[] }, extra = "") {
  const src = `design "t"\nsketch outline {\n  plane: XY\n${[...st.geometry, ...st.constraints].map((l) => `  ${l}`).join("\n")}\n}\n${extra}`;
  const m = evaluate(src);
  const sk = m.sketches.find((s) => s.name === "outline")!;
  return { src, m, sk };
}
const taken = () => new Set(SKETCH_RESERVED);
const kinds = (cs: DxfCurve[]) => cs.map((c) => c.t).join(" ");

describe("reading DXF", () => {
  it("reads lines, arcs, circles and polylines with bulges, in the file's unit", () => {
    const d = readDxf(
      dxf(
        [
          lwpoly(
            [
              [0, 0],
              [2, 0, 1],
              [2, 1],
              [0, 1],
            ],
            true,
          ),
          circle(1, 0.5, 0.125),
          [[0, "TEXT"], [8, "0"], [10, 0], [20, 0], [40, 1], [1, "NOTE"]],
          [[0, "DIMENSION"], [8, "0"], [2, "*D1"]],
        ],
        { units: 1 },
      ),
    );
    expect(d.unit).toBe("inches");
    expect(d.scale).toBe(25.4);
    expect(kinds(d.curves)).toBe("line arc line line circle");
    // the bulge of 1 is a half circle bulging out past x = 2 inches
    const a = d.curves[1] as Extract<DxfCurve, { t: "arc" }>;
    expect(a.r).toBeCloseTo(12.7, 9);
    expect(a.c[0]).toBeCloseTo(50.8, 9);
    expect(a.c[1]).toBeCloseTo(12.7, 9);
    expect(a.sweep).toBeCloseTo(Math.PI, 9);
    expect(d.skipped).toEqual({ text: 1, dimension: 1 });
    expect(d.warnings).toEqual([]);
  });

  it("guesses millimetres, or inches for an imperial drawing, and takes an override", () => {
    const one = [line(0, 0, 10, 0)];
    expect(readDxf(dxf(one)).warnings.join(" ")).toMatch(/does not give its unit.*millimetres/);
    const imp = readDxf(dxf(one, { measurement: 0 }));
    expect(imp.readAs).toBe("inches");
    expect((imp.curves[0] as Extract<DxfCurve, { t: "line" }>).b[0]).toBeCloseTo(254, 9);
    const mm = readDxf(dxf(one, { units: 1 }), { unit: "mm" });
    expect((mm.curves[0] as Extract<DxfCurve, { t: "line" }>).b[0]).toBe(10);
  });

  it("turns centre and hidden lines into guides and leaves out hidden layers", () => {
    const d = readDxf(
      dxf([line(0, 0, 10, 0, [[6, "CENTER"]]), line(0, 0, 0, 10, [[8, "DASHED_LAYER"]]), line(0, 0, 5, 5, [[8, "OFF"]]), line(1, 1, 2, 2)], {
        units: 4,
        layers: [
          ["DASHED_LAYER", "HIDDEN"],
          ["OFF", "CONTINUOUS", 1],
        ],
      }),
    );
    expect(d.curves.map((c) => (c.t === "line" ? c.guide : null))).toEqual([true, true, false]);
    expect(d.skipped["hidden item"]).toBe(1);
  });

  it("reads arcs drawn from below, blocks placed turned, scaled and in rows", () => {
    // extrusion (0, 0, -1): the arc's x runs the other way and it turns clockwise as seen from above
    const d = readDxf(dxf([arc(10, 0, 5, 0, 90, [[210, 0], [220, 0], [230, -1]])], { units: 4 }));
    const a = d.curves[0] as Extract<DxfCurve, { t: "arc" }>;
    expect(a.c[0]).toBeCloseTo(-10, 9);
    // from (−10, 5) round to (−15, 0), counter-clockwise
    expect(a.a0).toBeCloseTo(Math.PI / 2, 9);
    expect(a.sweep).toBeCloseTo(Math.PI / 2, 9);

    const b = readDxf(
      dxf(
        [
          [[0, "INSERT"], [8, "0"], [2, "HOLE"], [10, 100], [20, 50], [41, 2], [42, 2], [50, 90], [70, 3], [71, 2], [44, 10], [45, 20]],
          [[0, "INSERT"], [8, "0"], [2, "HOLE"], [10, 10], [20, 5], [41, 2], [42, 1]],
        ],
        { units: 4, blocks: [{ name: "HOLE", base: [1, 1], ents: [circle(1, 1, 1), line(1, 1, 2, 1)] }] },
      ),
    );
    // 3 × 2 copies, then one stretched copy whose circle becomes an ellipse
    expect(kinds(b.curves)).toBe(`${"circle line ".repeat(6)}ellipse line`);
    const centres = b.curves.filter((c): c is Extract<DxfCurve, { t: "circle" }> => c.t === "circle").map((c) => [Math.round(c.c[0]), Math.round(c.c[1]), c.r]);
    // turned a quarter: the columns run up the page, the rows to the left
    expect(centres).toEqual([
      [100, 50, 2],
      [80, 50, 2],
      [100, 60, 2],
      [80, 60, 2],
      [100, 70, 2],
      [80, 70, 2],
    ]);
    const e = b.curves[12] as Extract<DxfCurve, { t: "ellipse" }>;
    expect([e.rx, e.ry]).toEqual([2, 1]);
    expect(e.c).toEqual([10, 5]);
    // the block's line, turned a quarter and doubled, runs up from the insertion point
    const l = b.curves[1] as Extract<DxfCurve, { t: "line" }>;
    expect(l.a[0]).toBeCloseTo(100, 9);
    expect(l.b[1]).toBeCloseTo(52, 9);
  });

  it("samples B-splines and pieces of ellipses closely, and keeps whole ellipses", () => {
    // a cubic B-spline with a clamped knot vector
    const P = [
      [0, 0],
      [10, 20],
      [30, -10],
      [40, 10],
      [55, 0],
    ];
    const U = [0, 0, 0, 0, 1, 2, 2, 2, 2];
    const spline: G = [[0, "SPLINE"], [8, "0"], [70, 8], [71, 3], [72, U.length], [73, P.length], ...U.map((k): [number, number] => [40, k]), ...P.flatMap(([x, y]): G => [[10, x], [20, y], [30, 0]])];
    const ellipse: G = [[0, "ELLIPSE"], [8, "0"], [10, 0], [20, 0], [30, 0], [11, 20], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]];
    const half: G = [[0, "ELLIPSE"], [8, "0"], [10, 0], [20, 0], [30, 0], [11, 0], [21, 20], [31, 0], [40, 0.25], [41, 0], [42, Math.PI]];
    const d = readDxf(dxf([spline, ellipse, half], { units: 4 }));
    expect(kinds(d.curves)).toBe("spline ellipse spline");
    const s = d.curves[0] as Extract<DxfCurve, { t: "spline" }>;
    expect(s.pts[0]).toEqual([0, 0]);
    expect(s.pts[s.pts.length - 1][0]).toBeCloseTo(55, 9);
    expect(s.pts.length).toBeLessThan(60);
    // the smooth curve through the samples stays on the true B-spline
    const bez = splineBeziers(s.pts, false);
    const truth = (t: number) => {
      // de Boor on the reference control points
      const basis = (i: number, k: number, x: number): number => {
        if (k === 0) return (U[i] <= x && x < U[i + 1]) || (x === 2 && U[i] < 2 && U[i + 1] === 2) ? 1 : 0;
        const a = U[i + k] - U[i] ? ((x - U[i]) / (U[i + k] - U[i])) * basis(i, k - 1, x) : 0;
        const b = U[i + k + 1] - U[i + 1] ? ((U[i + k + 1] - x) / (U[i + k + 1] - U[i + 1])) * basis(i + 1, k - 1, x) : 0;
        return a + b;
      };
      let x = 0;
      let y = 0;
      P.forEach((p, i) => {
        const n = basis(i, 3, t);
        x += n * p[0];
        y += n * p[1];
      });
      return [x, y];
    };
    // every point of the smooth curve lies on the true one (a fine polyline of it)
    const fine = Array.from({ length: 4001 }, (_, k) => truth((2 * k) / 4000));
    let worst = 0;
    for (const b of bez)
      for (let j = 0; j <= 20; j++) {
        const t = j / 20;
        const u = 1 - t;
        const px = u * u * u * b.a[0] + 3 * u * u * t * b.c1[0] + 3 * u * t * t * b.c2[0] + t * t * t * b.b[0];
        const py = u * u * u * b.a[1] + 3 * u * u * t * b.c1[1] + 3 * u * t * t * b.c2[1] + t * t * t * b.b[1];
        let best = Infinity;
        for (let k = 0; k + 1 < fine.length; k++) {
          const [ax, ay] = fine[k];
          const [bx, by] = fine[k + 1];
          const dx = bx - ax;
          const dy = by - ay;
          const L = dx * dx + dy * dy;
          const q = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
          best = Math.min(best, Math.hypot(px - ax - q * dx, py - ay - q * dy));
        }
        worst = Math.max(worst, best);
      }
    expect(worst).toBeLessThan(0.021);
    const e = d.curves[1] as Extract<DxfCurve, { t: "ellipse" }>;
    expect([e.rx, e.ry, e.angle]).toEqual([20, 10, 0]);
    // half an ellipse standing up, 20 tall and 5 wide: from the top round the left to the bottom
    const h = d.curves[2] as Extract<DxfCurve, { t: "spline" }>;
    expect(h.pts[0][1]).toBeCloseTo(20, 9);
    expect(h.pts[h.pts.length - 1][1]).toBeCloseTo(-20, 9);
    expect(Math.min(...h.pts.map((p) => p[0]))).toBeCloseTo(-5, 2);
  });

  it("refuses binary DXF and files that are not DXF", () => {
    expect(() => readDxf("AutoCAD Binary DXF\r\n\u001a\u0000")).toThrow(/binary DXF.*ASCII/);
    expect(() => readDxf("hello\nworld\n")).toThrow(DxfError);
    expect(() => readDxf("0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n")).toThrow(/no ENTITIES/);
  });
});

describe("DXF into a sketch", () => {
  it("writes a plate as one joined, fully defined outline with its holes", () => {
    // a 60 × 40 plate with rounded corners (bulges), a slot and two holes, plus a centre line through it
    const k = Math.tan(Math.PI / 8);
    const d = readDxf(
      dxf(
        [
          lwpoly(
            [
              [5, 0],
              [55, 0, k],
              [60, 5],
              [60, 35, k],
              [55, 40],
              [5, 40, k],
              [0, 35],
              [0, 5, k],
            ],
            true,
          ),
          circle(10, 10, 2.5),
          circle(50, 10, 2.5),
          line(20, 25, 40, 25),
          arc(40, 30, 5, 270, 90),
          line(40, 35, 20, 35),
          arc(20, 30, 5, 90, 270),
          line(30, -5, 30, 45, [[6, "CENTER"]]),
        ],
        { units: 4 },
      ),
    );
    const st = dxfStatements(d, taken(), { file: "plate.dxf", recentre: true });
    expect(st.counts).toEqual({ lines: 7, arcs: 6, circles: 2, splines: 0, ellipses: 0, points: 0, guides: 1 });
    expect(dxfCountsText(st.counts)).toBe("7 lines, 6 arcs and 2 circles");
    expect(st.moved).toBeNull();
    expect(st.geometry[0]).toMatch(/^\/\/ from plate\.dxf \(millimetres\), fixed where it was drawn/);
    // each loop is written in order, sharing points
    expect(st.geometry[1]).toBe("line l1 = (5, 0) -> (55, 0)");
    expect(st.geometry[2]).toBe("arc a1 = l1.end -> (60, 5), center: (55, 5)");
    expect(st.geometry[3]).toBe("line l2 = a1.end -> (60, 35)");
    expect(st.geometry.some((g) => g === "construction line l7 = (30, -5) -> (30, 45)")).toBe(true);
    expect(st.constraints).toContain("diameter c1 = 5");
    const { sk, m } = sketchFrom(st, "part plate { body extrude(outline, 3) }\n");
    expect(m.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(sk.redundant).toBe(0);
    // the outline less the corner rounding, the slot and the holes
    const area = 60 * 40 - 4 * (25 - (Math.PI * 25) / 4) - (20 * 10 + Math.PI * 25) - 2 * Math.PI * 2.5 * 2.5;
    expect(sk.profile.regions).toHaveLength(1);
    expect(sk.profile.area).toBeCloseTo(area, 1);
  });

  it("closes small gaps, drops curves drawn twice and moves a drawing far from its origin", () => {
    const g = 0.004;
    const d = readDxf(dxf([line(1000, 1000, 1040, 1000), line(1040 + g, 1000, 1040, 1020), line(1040, 1020 + g, 1000, 1020), line(1000 - g, 1020, 1000, 1000 + g), line(1040, 1020, 1000, 1020), circle(1020, 1010, 3)], { units: 4 }));
    const st = dxfStatements(d, taken(), { file: "far.dxf", recentre: true });
    expect(st.joined).toBe(4);
    expect(st.duplicates).toBe(1);
    expect(st.moved).toEqual([-1020, -1010]);
    expect(st.counts.lines).toBe(4);
    const { sk } = sketchFrom(st);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(sk.profile.regions).toHaveLength(1);
    expect(sk.profile.area).toBeCloseTo(40 * 20 - Math.PI * 9, 1);
    // the box now sits round the origin
    const xs = sk.points.filter((p) => p.owner && !p.external).map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(-20, 2);
  });

  it("brings in splines and ellipses as editable curves of a closed profile", () => {
    // a D shape: a straight back and a curved front drawn as a spline, and an elliptical window
    const P = [
      [0, 0],
      [30, 0],
      [40, 20],
      [30, 40],
      [0, 40],
    ];
    const U = [0, 0, 0, 0, 1, 2, 2, 2, 2];
    const spline: G = [[0, "SPLINE"], [8, "0"], [70, 8], [71, 3], [72, U.length], [73, P.length], ...U.map((q): [number, number] => [40, q]), ...P.flatMap(([x, y]): G => [[10, x], [20, y], [30, 0]])];
    const ellipse: G = [[0, "ELLIPSE"], [8, "0"], [10, 15], [20, 20], [30, 0], [11, 6], [21, 6], [31, 0], [40, 0.5], [41, 0], [42, 2 * Math.PI]];
    const d = readDxf(dxf([spline, line(0, 40, 0, 0), ellipse], { units: 4 }));
    const st = dxfStatements(d, taken(), { file: "d.dxf", recentre: true });
    expect(st.counts).toMatchObject({ splines: 1, lines: 1, ellipses: 1 });
    expect(st.geometry.find((g) => g.startsWith("ellipse"))).toBe("ellipse e1 = (15, 20), rx: 8.485, ry: 4.243, angle: 45");
    const { sk } = sketchFrom(st);
    expect(sk.solved).toBe(true);
    expect(sk.dof).toBe(0);
    expect(sk.profile.regions).toHaveLength(1);
    expect(sk.profile.area).toBeGreaterThan(1000);
  });

  it("refuses drawings with nothing to bring in, or too much", () => {
    expect(() => dxfStatements(readDxf(dxf([[[0, "TEXT"], [8, "0"], [1, "HELLO"]]], { units: 4 })), taken(), { file: "notes.dxf" })).toThrow(/no lines, arcs or curves.*1 text/);
    const many = Array.from({ length: MAX_DXF_CURVES + 1 }, (_, i) => line(i, 0, i, 1));
    expect(() => dxfStatements(readDxf(dxf(many, { units: 4 })), taken(), { file: "big.dxf" })).toThrow(/Kerf brings up to/);
  });

  it("reads back Kerf's own flat pattern DXF with its bend line as a guide", () => {
    const flat = flatsToDxf([
      {
        edges: [
          { t: "L", p: [0, 0, 80, 0] },
          { t: "L", p: [80, 0, 80, 30] },
          { t: "L", p: [80, 30, 0, 30] },
          { t: "L", p: [0, 30, 0, 0] },
          { t: "A", c: [20, 15], r: 3, a0: 0, a1: 2 * Math.PI },
        ] as never,
        part: { label: "bracket", material: "steel", xf: [], sheet: { t: 2, k: 0.44, flatBox: [[0, 0], [80, 30]], bends: [{ name: "b1", angle: 90, r: 2, line: [[40, 0], [40, 30]] }] } } as never,
      },
    ]);
    const d = readDxf(flat);
    expect(d.unit).toBe("millimetres");
    const st = dxfStatements(d, taken(), { file: "bracket-flat.dxf", recentre: true });
    expect(st.counts.circles).toBe(1);
    const { sk } = sketchFrom(st);
    expect(sk.profile.regions).toHaveLength(1);
    expect(sk.profile.area).toBeCloseTo(80 * 30 - Math.PI * 9, 1);
  });
});
