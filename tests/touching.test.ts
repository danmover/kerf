import { describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import type { StructuralSpec, TouchingSpec } from "../src/analysis/spec";
import { structuralSummary, structuralVerdict, touchingText } from "../src/analysis/summary";
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

const part = (name: string, lo: V3, hi: V3, more: Partial<FeaPart> = {}): FeaPart => ({ id: name, name, mesh: gridBox(lo, hi, [4, 4, 4]), material: 0, ...more });

const run = (parts: FeaPart[], rest: Partial<StructuralInput>, touching?: TouchingSpec) =>
  runStructural({ label: "t", parts, materials: [mechMaterial("Steel")], supports: [], loads: [], target: 8000, printed: false, buildDir: [0, 0, 1], safety: 2, ...rest, ...(touching ? { touching } : {}) });

const pair = (a: string, b: string, mu: number | "rough" | "glued", lift = true): TouchingSpec => ({ pairs: [{ a, b, mu, lift }] });

describe("touching parts as contacts", { timeout: 120000 }, () => {
  // two steel plates stacked into a 100 mm cantilever, loaded on the top one's free end
  const plates = [part("lower", [0, 0, 0], [100, 20, 10]), part("upper", [0, 0, 10], [100, 20, 20])];
  const cantilever = (touching?: TouchingSpec) =>
    run(
      plates,
      {
        supports: [{ region: { t: "face", part: "lower", dir: [-1, 0, 0] } }, { region: { t: "face", part: "upper", dir: [-1, 0, 0] } }],
        loads: [{ t: "force", region: { t: "face", part: "upper", dir: [1, 0, 0] }, f: [0, 0, -200] }],
      },
      touching,
    );

  it("lets stacked plates slide over each other, and keeps rough ones together", () => {
    const glued = cantilever();
    const free = cantilever(pair("lower", "upper", 0));
    const rough = cantilever(pair("lower", "upper", "rough"));
    // glued they bend as one 20 mm beam; sliding freely, as two 10 mm beams sharing the load: four times as far
    // (a little more here, as the contact takes one of the six elements across a plate)
    const ratio = free.maxDisp.value / glued.maxDisp.value;
    expect(ratio).toBeGreaterThan(3.8);
    expect(ratio).toBeLessThan(4.7);
    expect(rough.maxDisp.value / glued.maxDisp.value).toBeLessThan(1.1);
    const t = free.touching![0];
    expect(t.cells).toBeGreaterThan(0);
    expect(t.held).toBeUndefined();
    // the tip of the top plate presses on the bottom one and carries half the load across, and next to the wall
    // they press a little more, where it stops the plates' faces spreading as they bend
    expect(t.force).toBeGreaterThan(90);
    expect(t.force).toBeLessThan(160);
    expect(t.open).toBeGreaterThan(0.2);
    expect(t.shear).toBeLessThan(5);
    expect(free.equilibrium).toBeLessThan(1e-3);
    expect(free.warnings.join(" ")).toMatch(/one of the 6 elements across/);
  });

  // a 20 mm steel block on a plate, pressed down and pushed sideways near its top
  const blockOnPlate = [part("plate", [0, 0, 0], [60, 60, 10]), part("block", [20, 20, 10], [40, 40, 30])];
  const pushed = (side: number, touching?: TouchingSpec, down = -200) =>
    run(
      blockOnPlate,
      {
        supports: [{ region: { t: "face", part: "plate", dir: [0, 0, -1] } }],
        loads: [
          { t: "force", region: { t: "face", part: "block", dir: [0, 0, 1] }, f: [0, 0, down] },
          ...(side ? [{ t: "force" as const, region: { t: "face" as const, part: "block", dir: [1, 0, 0] as V3 }, f: [-side, 0, 0] as V3 }] : []),
        ],
      },
      touching,
    );

  it("lifts the heel of a block pushed over, unless it may not part", () => {
    const lifts = pushed(120, pair("plate", "block", "rough"));
    const held = pushed(120, pair("plate", "block", "rough", false));
    const a = lifts.touching![0];
    expect(a.open).toBeGreaterThan(0.1);
    expect(a.open).toBeLessThan(0.5);
    // what presses it down crosses the faces, all of it
    expect(a.force).toBeGreaterThan(190);
    expect(a.force).toBeLessThan(210);
    expect(a.gap).toBeGreaterThan(0);
    expect(held.touching![0].open).toBe(0);
    expect(lifts.maxDisp.value).toBeGreaterThan(held.maxDisp.value);
    // it rocks onto its toe: the peak pressure is higher than with the heel held down
    expect(a.peak.value).toBeGreaterThan(held.touching![0].peak.value);
    expect(a.peak.at[0]).toBeLessThan(30);
  });

  it("holds a block that friction can hold, and says when it slides away", () => {
    const holds = pushed(20, pair("plate", "block", 0.3));
    const t = holds.touching![0];
    expect(t.held).toBeUndefined();
    expect(t.sliding).toBeLessThan(0.2);
    expect(t.shear).toBeGreaterThan(15);
    expect(t.shear).toBeLessThan(21);
    expect(touchingText({ touching: pair("plate", "block", 0.3) } as StructuralSpec, holds)!.status).toBe("info");
    // 100 N sideways against 0.3 × 200 N of friction: nothing stops it
    const slides = pushed(100, pair("plate", "block", 0.3));
    expect(slides.touching![0].held).toBe("slides");
    const tt = touchingText({ touching: pair("plate", "block", 0.3) } as StructuralSpec, slides)!;
    expect(tt.status).toBe("fail");
    expect(tt.detail).toMatch(/slides away/);
    expect(tt.fix).toMatch(/keys it/);
  });

  it("says when the loads pull a part off", () => {
    const off = pushed(0, pair("plate", "block", 0.3), 50);
    expect(off.touching![0].held).toBe("apart");
    const tt = touchingText({ touching: pair("plate", "block", 0.3) } as StructuralSpec, off)!;
    expect(tt.status).toBe("fail");
    expect(tt.detail).toMatch(/pull block and plate apart/);
  });

  it('finds every touching pair with "all", leaving fasteners glued, and warns of pairs that do not touch', () => {
    const three = [...blockOnPlate, part("cap", [25, 25, 30], [35, 35, 36], { joining: true }), part("far", [0, 0, 40], [5, 5, 45])];
    const r = run(three, { supports: [{ region: { t: "face", part: "plate", dir: [0, 0, -1] } }, { region: { t: "face", part: "far", dir: [0, 0, 1] } }], loads: [{ t: "force", region: { t: "face", part: "cap", dir: [0, 0, 1] }, f: [0, 0, -100] }] }, { pairs: [{ a: "plate", b: "far", mu: 0.3, lift: true }], all: { mu: 0.2, lift: true } });
    const names = r.touching!.map((t) => `${t.a}-${t.b}${t.auto ? "*" : ""}`);
    // the plate and block pair is found; the cap (a fastener) stays glued to the block
    expect(names).toContain("plate-block*");
    expect(names.some((n) => n.includes("cap"))).toBe(false);
    expect(r.touching!.find((t) => t.b === "block")!.mu).toBe(0.2);
    expect(r.warnings.join(" ")).toMatch(/plate and far do not touch/);
  });
});

describe("touching: in the language", { timeout: 60000 }, () => {
  const src = (body: string, load = "force(face(block, +X), (-20N, 0, 0))") => `design "c"
part plate { body box(60, 60, 10, at: (30, 30, 5)) }
part block { body box(20, 20, 20, at: (30, 30, 20)) }
analysis "Pushed" {
  fix: face(plate, -Z)
  load: ${load}
${body}
}
`;
  const errorsOf = (body: string, load?: string) =>
    evaluate(src(body, load))
      .diagnostics.filter((d) => d.severity === "error")
      .map((d) => d.message)
      .join("\n");
  const spec = (body: string, load?: string) => {
    const errs = errorsOf(body, load);
    if (errs) throw new Error(errs);
    return evaluate(src(body, load)).analyses[0] as StructuralSpec;
  };

  it("reads pairs, friction, all and the shorthand", () => {
    expect(spec("  touching: touch(plate, block, mu: 0.2)").touching).toEqual({ pairs: [{ a: "plate", b: "block", mu: 0.2, lift: true }] });
    expect(spec('  touching: touch(plate, block, mu: "rough", lift: false)').touching!.pairs[0]).toMatchObject({ mu: "rough", lift: false });
    expect(spec("  touching: [plate, block]").touching!.pairs[0]).toMatchObject({ a: "plate", b: "block", mu: 0.3 });
    expect(spec('  touching: "all"').touching).toEqual({ pairs: [], all: { mu: 0.3, lift: true } });
    expect(spec('  touching: [touch("all", mu: 0.15), touch(plate, block, mu: "glued")]').touching).toEqual({ pairs: [{ a: "plate", b: "block", mu: "glued", lift: true }], all: { mu: 0.15, lift: true } });
    // the parts it names are analysed
    expect(spec("  touching: touch(plate, block)").parts.sort()).toEqual(["block", "plate"]);
  });

  it("says what is wrong", () => {
    expect(errorsOf("  touching: touch(plate, plate)")).toMatch(/two different parts/);
    expect(errorsOf("  touching: touch(plate, block, mu: 3)")).toMatch(/friction coefficient/);
    expect(errorsOf("  touching: touch(plate, nothing)")).toMatch(/nothing/);
    expect(errorsOf("  touching: 5")).toMatch(/touching: lists/);
    expect(errorsOf("  touching: touch(plate, block)\n  modes: 4")).toMatch(/natural frequencies/);
    expect(errorsOf("  touching: touch(plate, block)\n  buckling")).toMatch(/buckling/);
  });

  it("puts the contacts in the summary", () => {
    const s = spec("  touching: touch(plate, block, mu: 0.3)", "[force(face(block, +Z), (0, 0, -200N)), force(face(block, +X), (-20N, 0, 0))]");
    expect(s.loads.length).toBe(2);
    const r = run([part("plate", [0, 0, 0], [60, 60, 10]), part("block", [20, 20, 10], [40, 40, 30])], { supports: s.supports, loads: s.loads }, s.touching);
    const text = structuralSummary(s, { status: "done", result: r, resolution: "draft" });
    expect(text).toMatch(/Touching parts \(contacts, not glued\): plate and block \(μ 0\.3\): pressed together over/);
    expect(structuralVerdict(s, r)).not.toBe("fail");
  });
});
