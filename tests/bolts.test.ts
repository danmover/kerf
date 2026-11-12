import { beforeAll, describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import type { TriMesh, V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { stressAreaOf, tighten } from "../src/analysis/fe/bolts";
import type { StructuralSpec } from "../src/analysis/spec";
import { boltText, structuralSummary } from "../src/analysis/summary";
import { evaluate } from "../src/lang/evaluator";
import { structuralInput } from "../src/analysis/runtime";
import { buildPart, meshShape } from "../src/kernel/build";
import { initKernel } from "./helpers/kernel";

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

/** Closed cylinders along Z (a bolt's head and shank), one mesh. */
function cylinders(cx: number, cy: number, pieces: [r: number, z0: number, z1: number][], n = 40): TriMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const [r, z0, z1] of pieces) {
    const b = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      pos.push(cx + r * Math.cos(t), cy + r * Math.sin(t), z0, cx + r * Math.cos(t), cy + r * Math.sin(t), z1);
    }
    const cb = pos.length / 3;
    pos.push(cx, cy, z0, cx, cy, z1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const bi = b + 2 * i,
        bj = b + 2 * j;
      idx.push(bi, bj, bj + 1, bi, bj + 1, bi + 1);
      idx.push(cb + 1, bi + 1, bj + 1);
      idx.push(cb, bj, bi);
    }
  }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

// an M8 socket screw (8.8) through a 10 mm steel plate into a tapped one under it; the screw comes first, so the
// plates' cells inside it are its own
const screw: FeaPart = {
  id: "screw",
  name: "screw",
  mesh: cylinders(30, 30, [
    [6.5, 20, 28],
    [4, 4, 20.01],
  ]),
  material: 0,
  joining: true,
  bolt: { headTop: [30, 30, 28], outward: [0, 0, 1], size: "M8", headD: 13, grade: "8.8" },
};
const top: FeaPart = { id: "top", name: "top", mesh: gridBox([0, 0, 10], [60, 60, 20], [4, 4, 4]), material: 0 };
const base: FeaPart = { id: "base", name: "base", mesh: gridBox([0, 0, 0], [60, 60, 10], [4, 4, 4]), material: 0 };

const run = (rest: Partial<StructuralInput>) =>
  runStructural({
    label: "b",
    parts: [screw, top, base],
    materials: [mechMaterial("Steel")],
    supports: [{ region: { t: "face", part: "base", dir: [0, 0, -1] } }],
    loads: [],
    target: 30000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 2,
    preload: [{ part: "screw" }],
    ...rest,
  });

// 75 % of an M8 8.8's proof load
const M8 = 0.75 * stressAreaOf(8, 1.25) * 580;

describe("tightened bolts", { timeout: 180000 }, () => {
  it("tightens a bolt to its preload, which presses the plates together", () => {
    const r = run({ loads: [{ t: "force", region: { t: "face", part: "top", dir: [1, 0, 0] }, f: [0, 0, -1] }] });
    const b = r.bolts![0];
    expect(b.preload).toBeCloseTo(M8, 0);
    expect(b.why).toMatch(/75 % of its proof load \(8\.8\)/);
    expect(b.into).toBe("base");
    expect(b.clamps).toEqual(["top"]);
    expect(b.grip).toBeGreaterThan(6);
    expect(b.grip).toBeLessThan(12);
    expect(Math.abs(b.force / b.preload - 1)).toBeLessThan(0.01);
    expect(b.stress).toBeCloseTo(b.force / b.area, 6);
    // the plates touch as contacts, and what clamps them is the bolt's tension
    const t = r.touching!.find((x) => x.a === "base" || x.b === "base")!;
    expect(t.auto).toBe(true);
    expect(t.pressed).toBeGreaterThan(0.05);
    expect(t.force / b.force).toBeGreaterThan(0.95);
    expect(t.force / b.force).toBeLessThan(1.05);
    expect(r.equilibrium).toBeLessThan(1e-3);
  });

  it("opens the joint once a pull beats the preload, and the bolt then carries it", () => {
    const pull = (f: number) => run({ target: 20000, loads: [{ t: "force", region: { t: "face", part: "top", dir: [0, 0, 1] }, f: [0, 0, f] }] });
    // pulled over the whole plate, a tightened joint takes the pull off what presses the plates together, and the
    // bolt hardly feels it
    const light = pull(0.25 * M8);
    const b1 = light.bolts![0];
    expect(Math.abs(b1.force / b1.preload - 1)).toBeLessThan(0.1);
    expect(Math.abs(light.touching![0].force - (b1.preload - 0.25 * M8)) / b1.preload).toBeLessThan(0.1);
    // pulled harder than it is tightened, the plates part and the bolt carries it all
    const twice = pull(2 * M8);
    const b2 = twice.bolts![0];
    expect(twice.touching![0].open).toBeGreaterThan(0.95);
    expect(b2.force / (2 * M8)).toBeGreaterThan(0.9);
    expect(b2.force / (2 * M8)).toBeLessThan(1.1);
    // past its proof load: it fails
    const spec = { preload: { bolts: [{ part: "screw" }] } } as StructuralSpec;
    expect(boltText(spec, twice)!.status).toBe("fail");
    expect(boltText(spec, twice)!.detail).toMatch(/screw is stretched past its proof load/);
    expect(boltText(spec, twice)!.detail).toMatch(/open the joint between (top and base|base and top) all the way/);
    expect(boltText(spec, light)!.status).toBe("info");
  });

  it("holds a side load by the friction its preload makes, until the load beats it", () => {
    const side = (v: number) => run({ target: 20000, loads: [{ t: "force", region: { t: "face", part: "top", dir: [1, 0, 0] }, f: [-v, 0, 0] }] });
    // a tenth of what friction holds: most of it crosses the faces where the bolt presses them, and the bolt bending
    // in its hole takes the rest (tightening it already let the faces slip a micron or so outward from it, as the top
    // plate dished under its head)
    const held = side(0.1 * 0.3 * M8);
    const holds = held.touching![0];
    expect(holds.held).toBeUndefined();
    expect(holds.shear / (0.1 * 0.3 * M8)).toBeGreaterThan(0.7);
    expect(holds.shear / (0.1 * 0.3 * M8)).toBeLessThan(1.05);
    expect(holds.slip).toBeLessThan(0.005);
    // twice what friction holds: where they still touch it slides (the far edge lifts, as the push tips it), held
    // back only by the bolt bending in its hole
    const slipped = side(2 * 0.3 * M8);
    const slips = slipped.touching![0];
    expect(slips.sliding + slips.open).toBeGreaterThan(0.9);
    expect(slips.slip).toBeGreaterThan(5 * holds.slip);
    // judged as a bolted joint: the first uses a tenth of its friction, the second slips
    const spec = { preload: { bolts: [{ part: "screw" }] } } as StructuralSpec;
    const ok = boltText(spec, held)!;
    expect(ok.status).toBe("info");
    expect(ok.detail).toMatch(/uses (7|8|9|10|11) % of the friction its clamping gives/);
    const bad = boltText(spec, slipped)!;
    expect(bad.status).toBe("fail");
    expect(bad.detail).toMatch(/The joint between (top and base|base and top) slips/);
    expect(bad.fix).toMatch(/dowel pin/);
  });

  it("says when it cannot tighten one", () => {
    // no head: a set screw
    const r = runStructural({
      label: "b",
      parts: [{ ...screw, bolt: { ...screw.bolt!, headD: 7.9 }, mesh: cylinders(30, 30, [[4, 4, 28]]) }, top, base],
      materials: [mechMaterial("Steel")],
      supports: [{ region: { t: "face", part: "base", dir: [0, 0, -1] } }],
      loads: [{ t: "force", region: { t: "face", part: "top", dir: [1, 0, 0] }, f: [0, 0, -10] }],
      target: 8000,
      printed: false,
      buildDir: [0, 0, 1],
      safety: 2,
      preload: [{ part: "screw" }, { part: "top" }],
    });
    const w = r.warnings.join(" ");
    expect(w).toMatch(/screw has no head to tighten against/);
    expect(w).toMatch(/top is not a screw or bolt/);
    expect(r.bolts ?? []).toEqual([]);
  });
});

describe("how tight", () => {
  it("does a bolt up to 75 % of its proof load in metal, gently in plastic, or as given", () => {
    const proof = stressAreaOf(5, 0.8) * 580;
    expect(tighten({ part: "s" }, 5, "8.8", proof, false).target).toBeCloseTo(0.75 * proof, 6);
    // 1 N·m on an M5 in plastic: 1000 / (0.2 × 5)
    expect(tighten({ part: "s" }, 5, "8.8", proof, true)).toMatchObject({ target: 1000, why: expect.stringMatching(/1 N·m/) });
    expect(tighten({ part: "s", torque: 4000 }, 5, "8.8", proof, false).target).toBeCloseTo(4000, 6);
    expect(tighten({ part: "s", force: 2500 }, 5, "8.8", proof, true)).toEqual({ target: 2500, why: "as given" });
  });
});

describe("preload: in the language", { timeout: 120000 }, () => {
  const src = (body: string) => `design "c"
part plate { body box(60, 60, 10, at: (30, 30, 5)) }
part block { body box(20, 20, 20, at: (30, 30, 20)) }
component screw_1 = lib.screw(M5, 16) { at: (30, 30, 30), axis: -Z }
analysis "Bolted" {
  fix: face(plate, -Z)
  load: force(face(block, +X), (-200N, 0, 0))
${body}
}
`;
  const errorsOf = (body: string) =>
    evaluate(src(body))
      .diagnostics.filter((d) => d.severity === "error")
      .map((d) => d.message)
      .join("\n");
  const spec = (body: string) => {
    const errs = errorsOf(body);
    if (errs) throw new Error(errs);
    return evaluate(src(body)).analyses[0] as StructuralSpec;
  };

  it("reads bolts, tensions, torques and all", () => {
    expect(spec("  preload: screw_1").preload).toEqual({ bolts: [{ part: "screw_1" }] });
    expect(spec("  preload: bolt(screw_1, 3kN)").preload).toEqual({ bolts: [{ part: "screw_1", force: 3000 }] });
    expect(spec("  preload: bolt(screw_1, torque: 2Nm)").preload).toEqual({ bolts: [{ part: "screw_1", torque: 2000 }] });
    expect(spec('  preload: "all"').preload).toEqual({ bolts: [], all: {} });
    expect(spec("  preload: 4kN").preload).toEqual({ bolts: [], all: { force: 4000 } });
    expect(spec('  preload: [bolt("all", torque: 1Nm), bolt(screw_1, 3kN)]').preload).toEqual({ bolts: [{ part: "screw_1", force: 3000 }], all: { torque: 1000 } });
    // the bolt it names is analysed
    expect(spec("  preload: screw_1").parts).toContain("screw_1");
  });

  it("says what is wrong", () => {
    expect(errorsOf("  preload: bolt(screw_1, 3kN, torque: 2Nm)")).toMatch(/not both/);
    expect(errorsOf("  preload: bolt(nothing, 3kN)")).toMatch(/nothing/);
    expect(errorsOf("  preload: (0, 0, 1)")).toMatch(/preload: lists the bolts/);
    expect(errorsOf("  preload: [screw_1, screw_1]")).toMatch(/given twice/);
    expect(errorsOf("  preload: screw_1\n  modes: 4")).toMatch(/natural frequencies/);
  });

  it("puts the bolts in the summary", () => {
    const s = spec("  preload: screw_1");
    const r = run({ loads: [{ t: "force", region: { t: "face", part: "top", dir: [1, 0, 0] }, f: [0, 0, -1] }] });
    const text = structuralSummary({ ...s, loads: [{ t: "force", region: { t: "face", part: "top", dir: [1, 0, 0] }, f: [0, 0, -1] }] }, { status: "done", result: r, resolution: "draft" });
    expect(text).toMatch(/Tightened bolts: screw \(M8 8\.8 into base\): tightened to 15\.\d+ kN \(75 % of its proof load \(8\.8\)\), clamping top/);
  });
});

describe("a library screw, tightened", { timeout: 300000 }, () => {
  beforeAll(initKernel);
  it("finds its head, shank and thread in the real solids", () => {
    const m = evaluate(`design "bolted"
part top {
  material: "Steel"
  body box(60, 60, 10, at: (30, 30, 10))
  cut hole(d: 8.4, through: true, at: (30, 30, 20))
}
part base {
  material: "Steel"
  body box(60, 60, 10, at: (30, 30, 0))
  cut hole(d: 6.8, depth: 9, at: (30, 30, 10))
}
component bolt_1 = lib.screw(M8, 16, grade: "8.8") { at: (30, 30, 20), axis: -Z }
analysis "Bolted" {
  fix: face(base, -Z)
  load: force(face(top, +Z), (0, 0, 1kN))
  preload: bolt(bolt_1, torque: 10Nm)
  resolution: 1.6mm
}
`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const spec = m.analyses[0] as StructuralSpec;
    expect(spec.parts.sort()).toEqual(["base", "bolt_1", "top"]);
    const parts = m.parts.filter((p) => spec.parts.includes(p.name));
    const meshes = new Map(parts.map((p) => [p.hash, meshShape(buildPart(p.recipe), "preview")]));
    const prep = structuralInput(spec, parts, false, new Map(), (h) => meshes.get(h));
    expect(prep?.error).toBeUndefined();
    const input = prep!.input!;
    expect(input.preload).toEqual([{ part: "bolt_1", torque: 10000 }]);
    // an 8.8 bolt is judged as 8.8, not as mild steel
    expect(input.materials[input.parts.find((p) => p.name === "bolt_1")!.material].yield).toBe(580);
    const r = runStructural(input);
    const b = r.bolts![0];
    // 10 N·m on an M8: 10000 / (0.2 × 8)
    expect(b.preload).toBeCloseTo(6250, 0);
    expect(b.into).toBe("base");
    expect(b.clamps).toEqual(["top"]);
    expect(Math.abs(b.force / b.preload - 1)).toBeLessThan(0.1);
    const t = r.touching![0];
    expect([t.a, t.b].sort()).toEqual(["base", "top"]);
    expect(t.pressed).toBeGreaterThan(0.02);
    expect(r.warnings.join(" ")).not.toMatch(/preload:/);
  });
});
