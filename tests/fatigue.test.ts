import { describe, expect, it } from "vitest";
import {
  criticalStress,
  cyclesAt,
  damageOf,
  damageShares,
  equivalentAmplitude,
  mergeCycles,
  normalQuantile,
  rainflow,
  reliabilityFactor,
  snCurve,
  strengthAt,
  surfaceFactor,
  type FatigueInput,
  type LoadCycle,
} from "../src/analysis/fe/fatigue";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { fatigueText, fatigueVerdict } from "../src/analysis/fatigueSummary";
import { mechMaterial } from "../src/analysis/materials";
import type { StructuralSpec } from "../src/analysis/spec";
import { evaluate } from "../src/lang/evaluator";

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const steel = mechMaterial("Steel");
const alu = mechMaterial("Aluminium");

describe("S-N curves", () => {
  it("follows Shigley's estimate with an endurance limit for steel", () => {
    const c = snCurve(steel, "polished", 0.5);
    expect(c.su).toBe(steel.uts);
    expect(c.s3).toBeCloseTo(0.9 * steel.uts, 9);
    expect(c.se).toBeCloseTo(steel.fatigue, 9);
    expect(c.tail).toBe("flat");
    expect(rel(cyclesAt(c, c.s3 * 0.999999), 1e3)).toBeLessThan(1e-3);
    expect(rel(cyclesAt(c, c.se * 1.000001), 1e7)).toBeLessThan(1e-3);
    expect(cyclesAt(c, c.se * 0.99)).toBe(Infinity);
    expect(cyclesAt(c, 0)).toBe(Infinity);
    for (const n of [10, 500, 2e3, 1e5, 3e6]) expect(rel(cyclesAt(c, strengthAt(c, n)), n)).toBeLessThan(1e-6);
    expect(strengthAt(c, 1e9)).toBe(c.se);
  });

  it("keeps weakening past 10⁷ cycles for aluminium", () => {
    const c = snCurve(alu, "polished", 0.5);
    expect(c.tail).toBe("falling");
    expect(cyclesAt(c, c.se * 0.9)).toBeGreaterThan(9e7);
    expect(cyclesAt(c, c.se * 0.9)).toBeLessThan(1.1e8);
    expect(strengthAt(c, 1e8)).toBeCloseTo(0.9 * c.se, 6);
  });

  it("lowers the fatigue strength for the surface finish and the reliability (Marin factors)", () => {
    // Shigley example 6-3: a machined steel of 520 MPa ultimate strength has ka = 0.860
    expect(surfaceFactor({ ...steel, uts: 520 }, "machined")).toBeCloseTo(0.86, 2);
    expect(surfaceFactor(steel, "polished")).toBe(1);
    expect(surfaceFactor(steel, "ground")).toBeGreaterThan(surfaceFactor(steel, "machined"));
    expect(surfaceFactor(steel, "machined")).toBeGreaterThan(surfaceFactor(steel, "hot-rolled"));
    expect(surfaceFactor(steel, "hot-rolled")).toBeGreaterThan(surfaceFactor(steel, "forged"));
    // a plastic's fatigue strength is already for printed or moulded parts
    expect(surfaceFactor(mechMaterial("PETG"), "printed")).toBe(1);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    // Shigley table 6-5: 99 % → 0.814, 99.9 % → 0.753
    expect(reliabilityFactor(0.99)).toBeCloseTo(0.814, 3);
    expect(reliabilityFactor(0.999)).toBeCloseTo(0.753, 3);
    expect(reliabilityFactor(0.5)).toBe(1);
    const c = snCurve(steel, "machined", 0.99);
    expect(c.se).toBeCloseTo(steel.fatigue * c.ka * c.ke, 9);
    expect(c.ke).toBeCloseTo(0.814, 3);
  });
});

describe("mean stress", () => {
  const c = { ...snCurve(steel, "polished", 0.5), su: 600, sy: 400 };
  it("turns a cycle with a mean into an equivalent fully reversed amplitude", () => {
    // 100 to 300 MPa: amplitude 100, mean 200
    expect(equivalentAmplitude(300, 100, c, "none")).toBeCloseTo(100, 9);
    expect(equivalentAmplitude(300, 100, c, "goodman")).toBeCloseTo(150, 9);
    expect(equivalentAmplitude(300, 100, c, "gerber")).toBeCloseTo(112.5, 9);
    expect(equivalentAmplitude(300, 100, c, "soderberg")).toBeCloseTo(200, 9);
    expect(equivalentAmplitude(300, 100, c, "swt")).toBeCloseTo(Math.sqrt(300 * 100), 9);
    // a compressive mean does not help (Goodman), and a cycle that only presses does no harm under SWT
    expect(equivalentAmplitude(-100, -300, c, "goodman")).toBeCloseTo(100, 9);
    expect(equivalentAmplitude(-100, -300, c, "swt")).toBe(0);
    // a mean at the ultimate strength breaks it outright
    expect(equivalentAmplitude(700, 500, c, "goodman")).toBe(Infinity);
  });

  it("finds the stress at which the damage over the life reaches 1", () => {
    const m = snCurve(steel, "machined", 0.5);
    const reversed: LoadCycle[] = [{ max: 1, min: -1, count: 1e5 }];
    expect(rel(criticalStress(1, reversed, 1, m, "goodman"), strengthAt(m, 1e5))).toBeLessThan(1e-5);
    // on-off at 10⁷ with Goodman: σ/2 = Se·(1 − σ/2Su)
    const onOff: LoadCycle[] = [{ max: 1, min: 0, count: 1e7 }];
    expect(rel(criticalStress(1, onOff, 1, m, "goodman"), (2 * m.se) / (1 + m.se / m.su))).toBeLessThan(1e-4);
    // the same cycle pressing: no mean-stress penalty, so twice the endurance limit
    expect(rel(criticalStress(-1, onOff, 1, m, "goodman"), 2 * m.se)).toBeLessThan(1e-4);
    expect(criticalStress(-1, onOff, 1, m, "swt")).toBe(Infinity);
    // a history repeated twice as often takes a lower stress
    const blocks: LoadCycle[] = [
      { max: 1, min: -1, count: 1e4 },
      { max: 2, min: -2, count: 10 },
    ];
    const s1 = criticalStress(1, blocks, 10, m, "goodman");
    const s2 = criticalStress(1, blocks, 20, m, "goodman");
    expect(s2).toBeLessThan(s1);
    expect(10 * damageOf(s1, blocks, m, "goodman")).toBeCloseTo(1, 5);
    const shares = damageShares(s1, blocks, m, "goodman");
    expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 9);
    expect(shares[0].share).toBeGreaterThanOrEqual(shares[1].share);
    // between print layers, a cycle that only presses them together does nothing
    expect(damageOf(-50, onOff, m, "goodman", true)).toBe(0);
    expect(damageOf(-50, onOff, m, "goodman", false)).toBe(0);
    expect(damageOf(-400, onOff, m, "goodman", false)).toBeGreaterThan(0);
    expect(damageOf(-400, onOff, m, "goodman", true)).toBe(0);
  });
});

describe("rainflow counting", () => {
  it("matches the ASTM E1049 example", () => {
    const cycles = rainflow([-2, 1, -3, 5, -1, 3, -4, 4, -2], false);
    const byRange = new Map<number, number>();
    for (const c of cycles) byRange.set(c.max - c.min, (byRange.get(c.max - c.min) ?? 0) + c.count);
    expect(Object.fromEntries(byRange)).toEqual({ 3: 0.5, 4: 1.5, 6: 0.5, 8: 1, 9: 0.5 });
  });

  it("closes every cycle of a repeating history", () => {
    const cycles = rainflow([-2, 1, -3, 5, -1, 3, -4, 4, -2], true);
    expect(cycles.reduce((a, c) => a + c.count, 0)).toBe(4);
    for (const c of cycles) expect(Number.isInteger(c.count)).toBe(true);
    expect(cycles[0]).toEqual({ max: 5, min: -4, count: 1 });
    // points that are not turns, repeats and flat runs drop out
    expect(rainflow([0, 0.5, 1, 1, 0, 0, 1, 0])).toEqual([{ max: 1, min: 0, count: 2 }]);
    expect(rainflow([1, 1, 1])).toEqual([]);
    expect(mergeCycles([{ max: 1, min: 0, count: 2 }, { max: 2, min: 0, count: 1 }, { max: 1, min: 0, count: 3 }])).toEqual([
      { max: 2, min: 0, count: 1 },
      { max: 1, min: 0, count: 5 },
    ]);
  });
});

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

const beam: FeaPart = { id: "beam", name: "beam", mesh: gridBox([0, 0, 0], [100, 10, 10], [20, 4, 4]), material: 0 };

function fatigueRun(f: Partial<FatigueInput>, over: Partial<StructuralInput> = {}, force = 100) {
  const fatigue: FatigueInput = { cycles: [{ max: 1, min: 0, count: 1e7 }], repeats: 1, unit: "cycles", meanStress: "goodman", finishes: ["machined"], reliability: 0.5, loading: "on-off", ...f };
  return runStructural({
    label: "fatigue",
    parts: [beam],
    materials: [steel],
    supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] } }],
    loads: [{ t: "force", region: { t: "face", part: "beam", dir: [1, 0, 0] }, f: [0, 0, -force] }],
    target: 8000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    fatigue,
    ...over,
  });
}

describe("fatigue in the structural solver", () => {
  it("judges an on-off cantilever by Goodman against the machined S-N curve, and the static check at the peak", () => {
    const r = fatigueRun({});
    const f = r.fatigue!;
    expect(f).toBeDefined();
    expect(r.staticSafety).toBeDefined();
    expect(f.unit).toBe("cycles");
    expect(f.design).toBe(1e7);
    expect(f.peak).toBe(1);
    expect(f.minSafety.mode).toBe("fatigue");
    expect(r.staticSafety!.mode).toBe("yield");
    // the static check is against yield; the fatigue one against the on-off Goodman line at the same stress
    const c = snCurve(steel, "machined", 0.5);
    const crit = (2 * c.se) / (1 + c.se / c.su);
    expect(rel(f.minSafety.value / r.staticSafety!.value, crit / steel.yield)).toBeLessThan(0.04);
    // the overall lowest is the lower of the two
    expect(r.minSafety.value).toBeCloseTo(Math.min(f.minSafety.value, r.staticSafety!.value), 4);
    expect(f.curves).toHaveLength(1);
    expect(f.curves[0]).toMatchObject({ material: steel.name, finish: "machined", tail: "flat", equivalent: "signed von Mises" });
    // 60 MPa at the root is under the endurance limit: no limit to the life
    expect(f.life.value).toBe(Infinity);
    expect(f.damage).toBe(0);
    expect(r.parts[0].life).toBeDefined();
    expect(Math.max(...r.parts[0].life!)).toBeLessThanOrEqual(9);
    expect(r.ranges.life).toBeDefined();
    const v = fatigueVerdict({ safety: 2 } as StructuralSpec, r)!;
    expect(v.status).toBe("pass");
    expect(fatigueText({ safety: 2 } as StructuralSpec, r)!.fix).toBeUndefined();
  });

  it("is lower for fully reversed loading than on-off, and gives a finite life above the endurance limit", () => {
    const onOff = fatigueRun({}, {}, 400);
    const rev = fatigueRun({ cycles: [{ max: 1, min: -1, count: 1e7 }], loading: "fully reversed" }, {}, 400);
    expect(rev.fatigue!.minSafety.value).toBeLessThan(onOff.fatigue!.minSafety.value);
    const c = snCurve(steel, "machined", 0.5);
    expect(rel(rev.fatigue!.minSafety.value / rev.staticSafety!.value, c.se / steel.yield)).toBeLessThan(0.04);
    const f = rev.fatigue!;
    expect(f.minSafety.value).toBeLessThan(1);
    expect(Number.isFinite(f.life.value)).toBe(true);
    expect(f.life.value).toBeLessThan(1e7);
    // the life is the S-N curve's at the peak stress, which the static safety factor gives
    expect(rel(f.life.value, cyclesAt(c, steel.yield / rev.staticSafety!.value))).toBeLessThan(0.35);
    expect(f.damage).toBeCloseTo(1e7 / f.life.value, 6);
    // fatigue now sets the overall lowest safety factor
    expect(rev.minSafety.mode).toBe("fatigue");
    const spec = { safety: 2 } as StructuralSpec;
    expect(fatigueVerdict(spec, rev)!.status).toBe("fail");
    const t = fatigueText(spec, rev)!;
    expect(t.detail).toMatch(/Lowest fatigue safety factor 0\.\d\d/);
    expect(t.detail).toMatch(/Shortest life [\d.e]+ cycles/);
    expect(t.detail).toMatch(/Miner's damage/);
    expect(t.fix).toMatch(/fillet/);
  });

  it("adds up the blocks of a history by Miner's rule, with the static check at its peak", () => {
    const one = fatigueRun({ cycles: [{ max: 1, min: -1, count: 1e5 }], unit: "repeats", repeats: 10, loading: "blocks" }, {}, 300);
    const two = fatigueRun(
      {
        cycles: [
          { max: 1, min: -1, count: 1e5 },
          { max: 2, min: -2, count: 100 },
        ],
        unit: "repeats",
        repeats: 10,
        loading: "blocks",
      },
      {},
      300,
    );
    expect(two.fatigue!.design).toBe(10);
    expect(two.fatigue!.peak).toBe(2);
    expect(two.fatigue!.minSafety.value).toBeLessThan(one.fatigue!.minSafety.value);
    expect(two.fatigue!.life.value).toBeLessThan(one.fatigue!.life.value);
    expect(rel(two.staticSafety!.value, one.staticSafety!.value / 2)).toBeLessThan(1e-3);
    const shares = two.fatigue!.shares;
    expect(shares.length).toBe(2);
    expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 6);
    const t = fatigueText({ safety: 2 } as StructuralSpec, two)!;
    expect(t.detail).toMatch(/passes of the history/);
    expect(t.detail).toMatch(/most of the damage comes from/);
  });

  it("checks fatigue between print layers, which only a pull across them hurts", () => {
    const pla = mechMaterial("PLA");
    const printed = { parts: [beam], materials: [pla], printed: true };
    // layers across the beam: bending pulls them apart
    const across = fatigueRun({ finishes: ["printed"] }, { ...printed, buildDir: [1, 0, 0] }, 20);
    expect(across.fatigue!.minSafety.mode).toBe("layer fatigue");
    expect(across.fatigue!.curves.some((c) => c.layers)).toBe(true);
    // layers along it: the bulk fatigue strength governs
    const along = fatigueRun({ finishes: ["printed"] }, { ...printed, buildDir: [0, 0, 1] }, 20);
    expect(along.fatigue!.minSafety.mode).toBe("fatigue");
    expect(along.fatigue!.minSafety.value).toBeGreaterThan(across.fatigue!.minSafety.value);
    // PLA is brittle: judged by its largest principal stress
    expect(across.fatigue!.curves[0].equivalent).toBe("signed largest principal stress");
    // a column pressed along its layers: no layer fatigue at all
    const column: FeaPart = { id: "col", name: "col", mesh: gridBox([0, 0, 0], [10, 10, 40], [4, 4, 16]), material: 0 };
    const pressed = fatigueRun(
      { finishes: ["printed"] },
      {
        ...printed,
        parts: [column],
        buildDir: [0, 0, 1],
        supports: [{ region: { t: "face", part: "col", dir: [0, 0, -1] } }],
        loads: [{ t: "force", region: { t: "face", part: "col", dir: [0, 0, 1] }, f: [0, 0, -500] }],
      },
    );
    expect(pressed.fatigue!.minSafety.mode).toBe("fatigue");
  });

  it("rejects fatigue mixed with a drop or natural frequencies", () => {
    expect(() => fatigueRun({}, { modes: 3 } as Partial<StructuralInput>)).toThrow();
  });
});

const box = `design "f"
part bar { body box(100, 10, 10, at: (50, 5, 5)) }
`;
const analysis = (lines: string) => `${box}analysis "Fatigue" {
  parts: [bar]
  fix: face(bar, -X)
  load: force(face(bar, +X), (0, 0, -100))
${lines}
}`;
const specOf = (lines: string) => {
  const m = evaluate(analysis(lines));
  const errs = m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
  return { spec: m.analyses[0] as StructuralSpec | undefined, errs };
};

describe("fatigue in the design language", () => {
  it("takes a constant load cycle from cycles: and loading:", () => {
    const { spec, errs } = specOf(`  cycles: 1e6\n  loading: "on-off"\n  mean_stress: "gerber"\n  finish: "ground"\n  reliability: 99%`);
    expect(errs).toEqual([]);
    expect(spec!.fatigue).toEqual({
      cycles: [{ max: 1, min: 0, count: 1e6 }],
      repeats: 1,
      unit: "cycles",
      loading: "on-off (0 to 1× the loads)",
      meanStress: "gerber",
      finish: "ground",
      reliability: 0.99,
      source: "constant",
    });
  });

  it("defaults to fully reversed loading and Goodman, and leaves a short count to the static check", () => {
    expect(specOf("  cycles: 1e7").spec!.fatigue).toMatchObject({ cycles: [{ max: 1, min: -1, count: 1e7 }], meanStress: "goodman", reliability: 0.5 });
    expect(specOf("  cycles: 500").spec!.fatigue).toBeUndefined();
    expect(specOf("  cycles: 1e3\n  loading: 0.2").spec!.fatigue!.cycles).toEqual([{ max: 1, min: 0.2, count: 1e3 }]);
  });

  it("takes a history of load blocks or a trace of load scales", () => {
    const blocks = specOf("  history: [block(1e5, 1), block(1e3, 2, min: 0)]\n  repeats: 50").spec!.fatigue!;
    expect(blocks.unit).toBe("repeats");
    expect(blocks.repeats).toBe(50);
    expect(blocks.cycles).toEqual([
      { max: 1, min: -1, count: 1e5 },
      { max: 2, min: 0, count: 1e3 },
    ]);
    const trace = specOf("  history: [0, 1, 0.2, 1, 0]\n  repeats: 1e4").spec!.fatigue!;
    expect(trace.source).toBe("trace");
    expect(trace.cycles).toEqual([
      { max: 1, min: 0, count: 1 },
      { max: 1, min: 0.2, count: 1 },
    ]);
  });

  it("explains a fatigue set-up it cannot use", () => {
    expect(specOf('  cycles: 1e6\n  loading: "sideways"').errs[0]).toMatch(/loading:/);
    expect(specOf('  cycles: 1e6\n  mean_stress: "wild"').errs[0]).toMatch(/mean_stress:/);
    expect(specOf('  cycles: 1e6\n  finish: "shiny"').errs[0]).toMatch(/finish:/);
    expect(specOf("  cycles: 1e6\n  reliability: 0.3").errs[0]).toMatch(/reliability:/);
    expect(specOf("  history: [block(10, 1)]\n  cycles: 1e6").errs[0]).toMatch(/repeats:/);
    expect(specOf("  repeats: 10").errs[0]).toMatch(/history:/);
    expect(specOf('  loading: "on-off"').errs[0]).toMatch(/cycles:/);
    expect(specOf("  history: [1, 1, 1]").errs[0]).toMatch(/never changes/);
    expect(specOf('  history: ["a", "b"]').errs[0]).toMatch(/load blocks/);
    expect(specOf("  history: [block(10, 0)]").errs[0]).toMatch(/peak/);
  });
});
