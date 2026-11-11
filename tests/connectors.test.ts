import { describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import type { RegionSpec, StructuralSpec } from "../src/analysis/spec";
import { structuralSummary } from "../src/analysis/summary";
import { evaluate } from "../src/lang/evaluator";

/** Closed box surface with its faces split into a grid. */
function gridBox(lo: V3, hi: V3, div: V3): TriMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let a = 0; a < 3; a++)
    for (const side of [0, 1]) {
      const u = (a + 1) % 3,
        v = (a + 2) % 3;
      const nu = div[u],
        nv = div[v];
      const base = pos.length / 3;
      for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++) {
          const p = [0, 0, 0];
          p[a] = side ? hi[a] : lo[a];
          p[u] = lo[u] + ((hi[u] - lo[u]) * i) / nu;
          p[v] = lo[v] + ((hi[v] - lo[v]) * j) / nv;
          pos.push(...p);
        }
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const q = base + i + (nu + 1) * j;
          if (side) idx.push(q, q + 1, q + nu + 2, q, q + nu + 2, q + nu + 1);
          else idx.push(q, q + nu + 2, q + 1, q, q + nu + 1, q + nu + 2);
        }
    }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

/** A flat plate x0..x1 × y0..y1 × 0..t with a round hole through it along Z. */
function plateWithHole(x0: number, x1: number, y0: number, y1: number, t: number, c: [number, number], r: number, n = 96): TriMesh {
  const corners = [
    [x1, y1],
    [x0, y1],
    [x0, y0],
    [x1, y0],
  ].map(([x, y]) => Math.atan2(y - c[1], x - c[0]));
  const angles = [...Array.from({ length: n }, (_, i) => -Math.PI + (2 * Math.PI * i) / n), ...corners].sort((a, b) => a - b);
  // the plate's outline seen from the hole's centre, along each angle
  const outer = angles.map((a) => {
    const d = [Math.cos(a), Math.sin(a)];
    let s = Infinity;
    if (d[0] > 1e-12) s = Math.min(s, (x1 - c[0]) / d[0]);
    if (d[0] < -1e-12) s = Math.min(s, (x0 - c[0]) / d[0]);
    if (d[1] > 1e-12) s = Math.min(s, (y1 - c[1]) / d[1]);
    if (d[1] < -1e-12) s = Math.min(s, (y0 - c[1]) / d[1]);
    return [c[0] + s * d[0], c[1] + s * d[1]];
  });
  const inner = angles.map((a) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  const pos: number[] = [];
  const m = angles.length;
  // vertices: inner bottom, inner top, outer bottom, outer top
  for (const [x, y] of inner) pos.push(x, y, 0);
  for (const [x, y] of inner) pos.push(x, y, t);
  for (const [x, y] of outer) pos.push(x, y, 0);
  for (const [x, y] of outer) pos.push(x, y, t);
  const IB = 0,
    IT = m,
    OB = 2 * m,
    OT = 3 * m;
  const idx: number[] = [];
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    // top (+Z) ring, counter-clockwise from above
    idx.push(IT + i, OT + i, OT + j, IT + i, OT + j, IT + j);
    // bottom (-Z)
    idx.push(IB + i, OB + j, OB + i, IB + i, IB + j, OB + j);
    // outer wall, facing out
    idx.push(OB + i, OB + j, OT + j, OB + i, OT + j, OT + i);
    // the hole's wall, facing the axis
    idx.push(IB + i, IT + j, IB + j, IB + i, IT + i, IT + j);
  }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

const steel = mechMaterial("Steel");
const face = (part: string, dir: V3): RegionSpec => ({ t: "face", part, dir });
const hole: RegionSpec = { t: "cyl", at: [10, 10, 0], axis: [0, 0, 1], d: 8, length: 5 };

function beam(over: Partial<StructuralInput>) {
  const part: FeaPart = { id: "beam", name: "beam", mesh: gridBox([0, 0, 0], [100, 10, 10], [20, 4, 4]), material: 0 };
  return runStructural({
    label: "test",
    parts: [part],
    materials: [steel],
    supports: [{ region: face("beam", [-1, 0, 0]) }],
    loads: [],
    target: 8000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  });
}

function lug(over: Partial<StructuralInput>) {
  const part: FeaPart = { id: "lug", name: "lug", mesh: plateWithHole(0, 60, 0, 20, 5, [10, 10], 4), material: 0 };
  return runStructural({
    label: "lug",
    parts: [part],
    materials: [steel],
    supports: [],
    loads: [],
    target: 20000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    ...over,
  });
}

describe("springs", { timeout: 60000 }, () => {
  it("a block on springs gives the load over their stiffness", () => {
    const part: FeaPart = { id: "block", name: "block", mesh: gridBox([0, 0, 0], [20, 20, 20], [4, 4, 4]), material: 0 };
    const r = runStructural({
      label: "springs",
      parts: [part],
      materials: [steel],
      supports: [{ region: face("block", [0, 0, -1]), spring: { rate: 500 } }],
      loads: [{ t: "force", region: face("block", [0, 0, 1]), f: [0, 0, -1000] }],
      target: 4000,
      printed: false,
      buildDir: [0, 0, 1],
      safety: 2,
    });
    const s = r.supports[0];
    expect(s.kind).toBe("spring");
    // 1000 N on 500 N/mm: 2 mm, the steel block itself barely squashes
    expect(s.spring!.give).toBeGreaterThan(1.95);
    expect(s.spring!.give).toBeLessThan(2.05);
    expect(s.reaction[2]).toBeCloseTo(1000, 0);
    expect(r.equilibrium).toBeLessThan(1e-3);
    expect(r.maxDisp.value).toBeGreaterThan(1.95);
  });

  it("a pad gives the pressure over its stiffness per area, along the surface's normal", () => {
    const part: FeaPart = { id: "block", name: "block", mesh: gridBox([0, 0, 0], [20, 20, 10], [4, 4, 2]), material: 0 };
    const r = runStructural({
      label: "pad",
      parts: [part],
      materials: [steel],
      // a pad under it, and something stopping it sliding about
      supports: [{ region: face("block", [0, 0, -1]), spring: { perArea: 2 } }, { region: face("block", [-1, 0, 0]), dir: [1, 0, 0] }, { region: face("block", [0, -1, 0]), dir: [0, 1, 0] }],
      loads: [{ t: "pressure", region: face("block", [0, 0, 1]), p: 1 }],
      target: 4000,
      printed: false,
      buildDir: [0, 0, 1],
      safety: 2,
    });
    // 1 MPa on 2 N/mm per mm²: it sinks 0.5 mm
    expect(r.supports[0].spring!.give).toBeGreaterThan(0.48);
    expect(r.supports[0].spring!.give).toBeLessThan(0.52);
    expect(r.supports[0].reaction[2]).toBeCloseTo(400, -1);
  });

  it("a spring at the tip of a cantilever takes its share of the load", () => {
    const free = beam({ loads: [{ t: "force", region: face("beam", [1, 0, 0]), f: [0, 0, -100] }] });
    const tipK = 100 / free.maxDisp.value;
    // a spring as stiff as the beam's tip takes about half
    const r = beam({
      supports: [{ region: face("beam", [-1, 0, 0]) }, { region: face("beam", [1, 0, 0]), dir: [0, 0, 1], spring: { rate: tipK } }],
      loads: [{ t: "force", region: face("beam", [1, 0, 0]), f: [0, 0, -100] }],
    });
    expect(r.supports[1].reaction[2]).toBeGreaterThan(40);
    expect(r.supports[1].reaction[2]).toBeLessThan(60);
    expect(r.maxDisp.value).toBeLessThan(0.6 * free.maxDisp.value);
    expect(r.equilibrium).toBeLessThan(1e-3);
  });
});

describe("set displacements", { timeout: 60000 }, () => {
  it("pushing the tip as far as a force moved it takes that force back", () => {
    const free = beam({ loads: [{ t: "force", region: face("beam", [1, 0, 0]), f: [0, 0, -100] }] });
    // the tip face's mean drop
    const d = free.maxDisp.value;
    const r = beam({ supports: [{ region: face("beam", [-1, 0, 0]) }, { region: face("beam", [1, 0, 0]), dir: [0, 0, -1], move: [0, 0, -d] }] });
    expect(r.supports[1].kind).toBe("move");
    expect(r.supports[1].moved![2]).toBeCloseTo(-d, 6);
    // within a few percent of 100 N (an even push versus an even force)
    // the push holds the tip down: the support pulls it down with about 100 N
    expect(-r.supports[1].reaction[2]).toBeGreaterThan(95);
    expect(-r.supports[1].reaction[2]).toBeLessThan(110);
    expect(Math.abs(r.supports[0].reaction[2] + r.supports[1].reaction[2])).toBeLessThan(1);
    expect(r.maxDisp.value).toBeCloseTo(d, 2);
  });

  it("moving the tip every way holds it square, which is about four times as stiff", () => {
    const along = beam({ supports: [{ region: face("beam", [-1, 0, 0]) }, { region: face("beam", [1, 0, 0]), dir: [0, 0, -1], move: [0, 0, -0.1] }] });
    const square = beam({ supports: [{ region: face("beam", [-1, 0, 0]) }, { region: face("beam", [1, 0, 0]), move: [0, 0, -0.1] }] });
    const ratio = square.supports[1].reaction[2] / along.supports[1].reaction[2];
    // a fixed-guided beam against a cantilever: 12EI/L³ over 3EI/L³, less with shear
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(4.3);
  });
});

describe("pins", { timeout: 60000 }, () => {
  it("a pin pulled on bears on the side it is pulled against, about half its bore", () => {
    const pull: StructuralInput["loads"] = [{ t: "force", region: face("lug", [1, 0, 0]), f: [500, 0, 0] }];
    // the roller stops the lug swinging about the pin; the pull runs through the pin, so it carries nothing
    const roller = { region: face("lug", [1, 0, 0]), dir: [0, 1, 0] as V3 };
    const r = lug({ supports: [{ region: hole, pin: { slide: false, tight: false } }, roller], loads: pull });
    const p = r.supports[0];
    expect(p.kind).toBe("pin");
    expect(p.reaction[0]).toBeCloseTo(-500, -1);
    expect(Math.abs(r.supports[1].reaction[1])).toBeLessThan(10);
    expect(p.pin!.share).toBeGreaterThan(0.3);
    expect(p.pin!.share).toBeLessThan(0.7);
    expect(p.pin!.rounds).toBeGreaterThan(1);
    // bearing pressure: 500 N over 8 × 5 mm
    expect(p.pin!.pressure).toBeGreaterThan(11);
    expect(p.pin!.pressure).toBeLessThan(14);
    expect(r.equilibrium).toBeLessThan(2e-3);
    // a tight pin holds all round, so the lug stretches less and its hole is less loaded
    const t = lug({ supports: [{ region: hole, pin: { slide: false, tight: true } }, roller], loads: pull });
    expect(t.supports[0].pin!.share).toBe(1);
    expect(t.maxDisp.value).toBeLessThan(r.maxDisp.value);
    expect(r.maxStress.value).toBeGreaterThan(t.maxStress.value);
  });

  it("a part on one pin is free to swing about it", () => {
    expect(() => lug({ supports: [{ region: hole, pin: { slide: false, tight: false } }], loads: [{ t: "force", region: face("lug", [1, 0, 0]), f: [0, 100, 0] }] })).toThrow(/swing about the pin/);
  });

  it("a pin that slides lets the part slide along it", () => {
    expect(() =>
      lug({ supports: [{ region: hole, pin: { slide: true, tight: false } }, { region: face("lug", [1, 0, 0]), dir: [0, 1, 0] }], loads: [{ t: "force", region: face("lug", [1, 0, 0]), f: [500, 0, 0] }] }),
    ).toThrow(/slide along Z/);
  });
});

describe("bearing loads", { timeout: 60000 }, () => {
  it("a bearing load presses on half the bore with the force it was given", () => {
    const fixEnd = [{ region: face("lug", [1, 0, 0]) }];
    const b = lug({ supports: fixEnd, loads: [{ t: "bearing", region: hole, f: [-500, 0, 0] }] });
    const even = lug({ supports: fixEnd, loads: [{ t: "force", region: hole, f: [-500, 0, 0] }] });
    const l = b.loads[0];
    expect(l.kind).toBe("bearing");
    expect(l.vector[0]).toBeCloseTo(-500, 6);
    // half the bore is loaded
    expect(l.area / even.loads[0].area).toBeGreaterThan(0.35);
    expect(l.area / even.loads[0].area).toBeLessThan(0.65);
    // peak 4F/(π d L)
    expect(l.pressure!).toBeCloseTo((4 * 500) / (Math.PI * 8 * 5), 0);
    expect(b.equilibrium).toBeLessThan(1e-3);
    expect(b.supports[0].reaction[0]).toBeCloseTo(500, -1);
    // pushing only the side it presses on loads the ligament beside the hole harder than an even pull would
    expect(b.maxStress.value).toBeGreaterThan(0.9 * even.maxStress.value);
  });

  it("a thrust along the axis is spread evenly", () => {
    const b = lug({ supports: [{ region: face("lug", [1, 0, 0]) }], loads: [{ t: "bearing", region: hole, f: [-300, 0, 200] }] });
    expect(b.loads[0].vector).toEqual([-300, 0, 200]);
    expect(b.supports[0].reaction[0]).toBeCloseTo(300, -1);
    expect(b.supports[0].reaction[2]).toBeCloseTo(-200, -1);
  });
});

describe("connectors in the language", { timeout: 60000 }, () => {
  const src = (body: string) => `design "c"
part lug { body box(60, 20, 5, at: (30, 10, 2.5)) }
analysis "Lug" {
  parts: [lug]
${body}
}
`;
  const errorsOf = (body: string) =>
    evaluate(src(body))
      .diagnostics.filter((d) => d.severity === "error")
      .map((d) => d.message)
      .join("\n");
  const spec = (body: string) => {
    const m = evaluate(src(body));
    const errs = errorsOf(body);
    if (errs) throw new Error(errs);
    return m.analyses[0] as StructuralSpec;
  };

  it("reads springs, pins, set displacements and bearing loads", () => {
    const a = spec(`  fix: [pin(zone(at: (10, 10, 0), d: 8, axis: Z, length: 5)), spring(face(lug, +X), 500, axis: Y), spring(face(lug, -Z), per_area: 1.5), displace(face(lug, +Y), 0.2mm, dir: +Y), displace(face(lug, -Y), (0, 0, -0.1))]
  load: bearing(zone(at: (10, 10, 0), d: 8, axis: Z, length: 5), 300N, dir: -X)`);
    expect(a.supports[0]).toMatchObject({ pin: { slide: false, tight: false } });
    expect(a.supports[1]).toMatchObject({ spring: { rate: 500 }, dir: [0, 1, 0] });
    expect(a.supports[2]).toMatchObject({ spring: { perArea: 1.5 } });
    expect(a.supports[3]).toMatchObject({ dir: [0, 1, 0], move: [0, 0.2, 0] });
    expect(a.supports[4]).toMatchObject({ move: [0, 0, -0.1] });
    expect(a.supports[4].dir).toBeUndefined();
    expect(a.loads[0]).toMatchObject({ t: "bearing", f: [-300, 0, 0] });
  });

  it("a set displacement is enough to analyse", () => {
    const a = spec(`  fix: [face(lug, -X), displace(face(lug, +X), 1mm, dir: -Z)]`);
    expect(a.loads).toHaveLength(0);
    expect(a.supports[1].move).toEqual([0, 0, -1]);
  });

  it("says what is wrong", () => {
    const err = errorsOf;
    expect(err(`  fix: pin(face(lug, -X))\n  load: force(face(lug, +X), 10N)`)).toMatch(/cylinder zone/);
    expect(err(`  fix: spring(face(lug, -X), 100, per_area: 2)\n  load: force(face(lug, +X), 10N)`)).toMatch(/rate: .* or per_area/);
    expect(err(`  fix: displace(face(lug, +X), 1mm, dir: -Z)`)).toMatch(/nothing else holds the part/);
    expect(err(`  fix: face(lug, -X)\n  load: pin(zone(at: (10, 10, 0), d: 8, axis: Z, length: 5))`)).toMatch(/goes in fix:/);
    expect(err(`  fix: face(lug, -X)\n  load: bearing(face(lug, +X), 10N)`)).toMatch(/cylinder zone/);
    expect(err(`  fix: [face(lug, -X), displace(face(lug, +X), 1mm)]`)).toMatch(/give the way it moves/);
  });

  it("the summary says what each support does", () => {
    const sp = spec(`  fix: [pin(zone(at: (10, 10, 0), d: 8, axis: Z, length: 5)), roller(face(lug, +X), Y)]
  load: force(face(lug, +X), (500N, 0, 0))`);
    const r = lug({ supports: sp.supports, loads: sp.loads });
    const text = structuralSummary(sp, { status: "done", result: r, resolution: "draft" });
    expect(text).toMatch(/pin zone ⌀8 mm along \+Z .*bears on \d+ % of its bore, [\d.]+ MPa bearing pressure/);
    const mv = spec(`  fix: [face(lug, -X), displace(face(lug, +X), 0.05mm, dir: -Z)]`);
    const r2 = lug({ supports: mv.supports, loads: mv.loads });
    const t2 = structuralSummary(mv, { status: "done", result: r2, resolution: "draft" });
    expect(t2).toMatch(/moved \(0, 0, -0\.05\) mm \(free to slide the other ways\) takes [\d.]+ N/);
    expect(t2).toMatch(/how many times further it could be pushed before the part fails/);
  });
});
