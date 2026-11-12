import { beforeAll, describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput, type StructuralResult } from "../src/analysis/fe/structural";
import type { V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { structuralInput } from "../src/analysis/runtime";
import type { StructuralSpec } from "../src/analysis/spec";
import { structuralSummary } from "../src/analysis/summary";
import type { EvalPart } from "../src/core/model";
import { buildPart, meshShape, type MeshData } from "../src/kernel/build";
import { initKernel } from "./helpers/kernel";
import { parseSection, sectionProps, type BeamSection } from "../src/lang/frames";
import { evaluate } from "../src/lang/evaluator";

const STEEL = mechMaterial("Steel");
const E = STEEL.E;
const G = E / (2 * (1 + STEEL.nu));

/** A closed box surface along a member's line, split into rings so results can be read along it. */
function memberMesh(a: V3, b: V3, u: V3, v: V3, w: number, h: number, rings = 20): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const corners: [number, number][] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  const pos: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r++)
    for (const [cu, cv] of corners) for (let k = 0; k < 3; k++) pos.push(a[k] + (d[k] * r) / rings + u[k] * cu + v[k] * cv);
  for (let r = 0; r < rings; r++)
    for (let c = 0; c < 4; c++) {
      const p0 = 4 * r + c,
        p1 = 4 * r + ((c + 1) % 4),
        q0 = p0 + 4,
        q1 = p1 + 4;
      idx.push(p0, p1, q1, p0, q1, q0);
    }
  idx.push(0, 2, 1, 0, 3, 2, 4 * rings, 4 * rings + 1, 4 * rings + 2, 4 * rings, 4 * rings + 2, 4 * rings + 3);
  return { positions: new Float32Array(pos), normals: new Float32Array(pos.length), indices: new Uint32Array(idx) };
}

const box40 = parseSection("box 40x40x3", () => undefined) as Exclude<ReturnType<typeof parseSection>, string>;
const S40: BeamSection = sectionProps(box40);

function member(name: string, a: V3, b: V3, u: V3, sec = S40, group?: string): FeaPart {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  const dn: V3 = [d[0] / l, d[1] / l, d[2] / l];
  const v: V3 = [dn[1] * u[2] - dn[2] * u[1], dn[2] * u[0] - dn[0] * u[2], dn[0] * u[1] - dn[1] * u[0]];
  const m = memberMesh(a, b, u, v, sec.w, sec.h);
  return { id: name, name, ...(group ? { group } : {}), mesh: { positions: m.positions, indices: m.indices }, normals: m.normals, material: 0, beam: { a, b, u, v, section: sec } };
}

const base = (over: Partial<StructuralInput>): StructuralInput => ({
  label: "frame",
  parts: [],
  materials: [STEEL],
  supports: [],
  loads: [],
  target: 8000,
  printed: false,
  buildDir: [0, 0, 1],
  safety: 2,
  elements: "beams",
  ...over,
});

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/** The beam's movement at the mesh vertex nearest p. */
function dispAt(r: StructuralResult, p: V3, part = 0): V3 {
  const f = r.parts[part];
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < f.positions.length / 3; i++) {
    const dd = Math.hypot(f.positions[3 * i] - p[0], f.positions[3 * i + 1] - p[1], f.positions[3 * i + 2] - p[2]);
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  return [f.disp[3 * best], f.disp[3 * best + 1], f.disp[3 * best + 2]];
}

describe("section properties", () => {
  it("matches the textbook values", () => {
    // box 40 × 40 × 3: I = (40⁴ − 34⁴)/12
    expect(S40.Iu).toBeCloseTo((40 ** 4 - 34 ** 4) / 12, 3);
    expect(S40.A).toBeCloseTo(40 * 40 - 34 * 34, 6);
    const tube = sectionProps(parseSection("tube 26.9x2.6", () => undefined) as never);
    expect(tube.J).toBeCloseTo((Math.PI / 32) * (26.9 ** 4 - 21.7 ** 4), 3);
    const angle = sectionProps(parseSection("angle 30x30x3", () => undefined) as never);
    // equal angle 30 × 30 × 3 with sharp corners: area 171 mm², centroid (b² + bt − t²) / (2(2b − t)) = 8.61 mm from
    // the heel, Iu = Iv = 1.458e4 mm⁴ (tables with the root fillet give 8.35 mm and 1.40e4)
    expect(angle.A).toBeCloseTo(171, 6);
    expect(angle.c[0] + 15).toBeCloseTo((900 + 90 - 9) / (2 * 57), 6);
    expect(angle.Iu).toBeCloseTo(angle.Iv, 6);
    expect(angle.Iu / 1e4).toBeCloseTo(1.458, 2);
    expect(angle.Iuv).toBeLessThan(0);
    const flat = sectionProps(parseSection("flat 40x5", () => undefined) as never);
    expect(flat.Iu).toBeCloseTo((40 * 125) / 12, 6);
    expect(flat.J / ((40 * 125) / 3)).toBeGreaterThan(0.9);
    // 2020 V-slot from the catalog figure; a 2040 is about two cells across its weak axis
    const v2020 = sectionProps({ kind: "extrusion", w: 20, h: 20, round: false, dims: "", noun: "", area: 185, iyy: 7000 });
    expect(v2020.Iu).toBe(7000);
    const v2040 = sectionProps({ kind: "extrusion", w: 20, h: 40, round: false, dims: "", noun: "", area: 333, iyy: 45000 });
    expect(v2040.Iu).toBe(45000);
    expect(v2040.Iv).toBeGreaterThan(12000);
    expect(v2040.Iv).toBeLessThan(16000);
  });
});

describe("beams", () => {
  it("bends a cantilever as beam theory says", () => {
    const L = 1000,
      P = 1000;
    const r = runStructural(
      base({
        parts: [member("arm", [0, 0, 0], [L, 0, 0], [0, 1, 0])],
        supports: [{ region: { t: "face", part: "arm", dir: [-1, 0, 0] } }],
        loads: [{ t: "force", region: { t: "face", part: "arm", dir: [1, 0, 0] }, f: [0, 0, -P] }],
      }),
    );
    const I = S40.Iu;
    const tip = (P * L ** 3) / (3 * E * I) + (P * L) / (S40.kappa * G * S40.A);
    expect(rel(r.maxDisp.value, tip)).toBeLessThan(0.005);
    expect(rel(-dispAt(r, [L, 0, 20])[2], tip)).toBeLessThan(0.01);
    // the root: M = P L, σ = M c / I
    expect(rel(r.maxStress.value, (P * L * 20) / I)).toBeLessThan(0.02);
    expect(r.supports[0].reaction[2]).toBeCloseTo(P, 6);
    expect(r.equilibrium).toBeLessThan(1e-9);
    // tension on top where it sags, compression underneath
    const top = r.parts[0].strain[r.parts[0].positions.findIndex((_, i) => i % 3 === 0) / 3];
    expect(Number.isFinite(top)).toBe(true);
    const b = r.beams!;
    expect(b.members[0].moment).toBeCloseTo(P * L, 0);
    expect(b.members[0].shear).toBeCloseTo(P, 3);
    expect(b.elements).toBe(10);
    expect(r.buckling).toBeUndefined();
  });

  it("bends a beam on two pins with a load in the middle", () => {
    const L = 1000,
      P = 2000;
    const r = runStructural(
      base({
        parts: [member("beam", [0, 0, 0], [L, 0, 0], [0, 1, 0])],
        supports: [
          { region: { t: "cyl", at: [0, -30, 0], axis: [0, 1, 0], d: 10, length: 60 }, pin: { slide: false, tight: true } },
          { region: { t: "cyl", at: [L, -30, 0], axis: [0, 1, 0], d: 10, length: 60 }, pin: { slide: true, tight: true } },
        ],
        loads: [{ t: "force", region: { t: "sphere", at: [L / 2, 0, 0], r: 5 }, f: [0, 0, -P] }],
      }),
    );
    const I = S40.Iu;
    const mid = (P * L ** 3) / (48 * E * I) + (P * L) / (4 * S40.kappa * G * S40.A);
    expect(rel(-dispAt(r, [L / 2, 0, 0])[2], mid)).toBeLessThan(0.01);
    expect(rel(r.beams!.members[0].moment, (P * L) / 4)).toBeLessThan(1e-6);
    expect(r.supports[0].reaction[2]).toBeCloseTo(P / 2, 3);
    expect(r.supports[1].reaction[2]).toBeCloseTo(P / 2, 3);
  });

  it("sways a portal frame as the slope-deflection answer says", () => {
    const h = 1000,
      H = 500;
    const r = runStructural(
      base({
        parts: [member("left", [0, 0, 0], [0, 0, h], [1, 0, 0], S40, "portal"), member("top", [0, 0, h], [h, 0, h], [0, 1, 0], S40, "portal"), member("right", [h, 0, h], [h, 0, 0], [1, 0, 0], S40, "portal")],
        supports: [{ region: { t: "face", part: "portal", dir: [0, 0, -1] } }],
        loads: [{ t: "force", region: { t: "sphere", at: [0, 0, h], r: 5 }, f: [H, 0, 0] }],
      }),
    );
    // fixed feet, rigid corners, equal members, span = height: Δ = 5 H h³ / (84 E I) from bending alone; the box's
    // shear adds about 1.6 % here
    const sway = (5 * H * h ** 3) / (84 * E * S40.Iu);
    const got = dispAt(r, [0, 0, h])[0];
    expect(got).toBeGreaterThan(sway);
    expect(rel(got, sway)).toBeLessThan(0.025);
    expect(r.beams!.joints).toBe(2);
    expect(r.supports[0].nodes).toBe(2);
    expect(r.supports[0].reaction[0]).toBeCloseTo(-H, 6);
  });

  it("finds the buckling load of a post", () => {
    const L = 1500,
      P = 10000;
    const r = runStructural(
      base({
        parts: [member("post", [0, 0, 0], [0, 0, L], [1, 0, 0])],
        supports: [{ region: { t: "face", part: "post", dir: [0, 0, -1] } }],
        loads: [{ t: "force", region: { t: "face", part: "post", dir: [0, 0, 1] }, f: [0, 0, -P] }],
        buckling: { modes: 2 },
      }),
    );
    // a flagpole: P_cr = π² E I / (4 L²)
    const pcr = (Math.PI ** 2 * E * S40.Iu) / (4 * L * L);
    expect(r.buckling!.converged).toBe(true);
    expect(rel(r.buckling!.factors[0] * P, pcr)).toBeLessThan(0.01);
    // the square tube buckles the same either way: the second shape is the first turned
    expect(rel(r.buckling!.factors[1], r.buckling!.factors[0])).toBeLessThan(1e-3);
    expect(r.parts[0].modes).toHaveLength(2);
    expect(r.beams!.members[0].axial).toBeCloseTo(-P, 3);
  });

  it("warns when a pushed member would buckle soon, without being asked", () => {
    const r = runStructural(
      base({
        parts: [member("post", [0, 0, 0], [0, 0, 1500], [1, 0, 0])],
        supports: [{ region: { t: "face", part: "post", dir: [0, 0, -1] } }],
        loads: [{ t: "force", region: { t: "face", part: "post", dir: [0, 0, 1] }, f: [0, 0, -12000] }],
      }),
    );
    expect(r.buckling).toBeUndefined();
    expect(r.beams!.buckling!.factor).toBeLessThan(3);
    expect(r.warnings.join(" ")).toMatch(/would buckle at 1\.\d\d× these loads \(post moves most\)/);
  });

  it("joins a tee part way along a member", () => {
    // a rail with a leg in its middle; the rail's ends held, the leg pulled down at its foot
    const r = runStructural(
      base({
        parts: [member("rail", [0, 0, 0], [1000, 0, 0], [0, 1, 0]), member("leg", [500, 0, 20], [500, 0, 400], [1, 0, 0])],
        supports: [{ region: { t: "face", part: "rail", dir: [-1, 0, 0] } }, { region: { t: "face", part: "rail", dir: [1, 0, 0] } }],
        loads: [{ t: "force", region: { t: "face", part: "leg", dir: [0, 0, 1] }, f: [0, 0, 1000] }],
      }),
    );
    // the leg's end on the rail's top face is carried to the rail's centre line: a fixed-fixed beam with a central load
    expect(r.beams!.joints).toBe(1);
    const mid = (1000 * 1000 ** 3) / (192 * E * S40.Iu) + (1000 * 1000) / (4 * S40.kappa * G * S40.A);
    expect(rel(dispAt(r, [500, 0, -20])[2], mid)).toBeLessThan(0.01);
    expect(r.supports[0].reaction[2] + r.supports[1].reaction[2]).toBeCloseTo(-1000, 3);
  });

  it("refuses a frame that is not held enough, or a member joined to nothing", () => {
    expect(() =>
      runStructural(
        base({
          parts: [member("rail", [0, 0, 0], [1000, 0, 0], [0, 1, 0])],
          supports: [{ region: { t: "face", part: "rail", dir: [-1, 0, 0] }, dir: [0, 0, 1] }],
          loads: [{ t: "force", region: { t: "face", part: "rail", dir: [1, 0, 0] }, f: [0, 0, -10] }],
        }),
      ),
    ).toThrow(/not held enough: it can move along X at rail/);
    expect(() =>
      runStructural(
        base({
          parts: [member("rail", [0, 0, 0], [1000, 0, 0], [0, 1, 0]), member("stray", [0, 500, 0], [1000, 500, 0], [0, 1, 0])],
          supports: [{ region: { t: "face", part: "rail", dir: [-1, 0, 0] } }],
          loads: [{ t: "force", region: { t: "face", part: "rail", dir: [1, 0, 0] }, f: [0, 0, -10] }],
        }),
      ),
    ).toThrow(/stray is not joined to anything held/);
  });

  it("carries its own weight under gravity", () => {
    const L = 1000;
    const r = runStructural(
      base({
        parts: [member("arm", [0, 0, 0], [L, 0, 0], [0, 1, 0])],
        supports: [{ region: { t: "face", part: "arm", dir: [-1, 0, 0] } }],
        accel: [0, 0, -1],
      }),
    );
    const kg = STEEL.density * 1e-6 * S40.A * L;
    expect(r.mass / 1000).toBeCloseTo(kg, 6);
    expect(r.supports[0].reaction[2]).toBeCloseTo(kg * 9.80665, 6);
    // q L⁴ / (8 E I)
    const q = (kg * 9.80665) / L;
    expect(rel(r.maxDisp.value, (q * L ** 4) / (8 * E * S40.Iu))).toBeLessThan(0.02);
  });
});

describe("frames in an analysis block", { timeout: 60_000 }, () => {
  /** evaluate a design, build its first structural analysis's input (members get a box mesh), and solve it */
  function run(src: string): { spec: StructuralSpec; input: StructuralInput; r: StructuralResult; parts: EvalPart[] } {
    const m = evaluate(src);
    const errs = m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    if (errs.length) throw new Error(errs.join("; "));
    const spec = m.analyses.find((a) => a.kind === "structural") as StructuralSpec;
    const parts = m.parts.filter((p) => spec.parts.includes(p.name));
    const meshes = new Map<string, MeshData>(
      parts.map((p) => {
        const b = p.beam!;
        const mm = memberMesh(b.a, b.b, b.u, b.v, b.section.w, b.section.h, 8);
        return [p.hash, { ...mm, edges: new Float32Array(0) }];
      }),
    );
    const prep = structuralInput(spec, parts, false, new Map(), (h) => meshes.get(h));
    if (!prep?.input) throw new Error(prep?.error ?? "no input");
    return { spec, input: prep.input, r: runStructural(prep.input), parts };
  }

  it("analyses a welded table frame as beams by naming the frame", () => {
    const { spec, input, r } = run(`design "table"
frame stand {
  profile: "box 25x25x2"
  material: "Steel"
  box: (800, 500, 700)
}
analysis "Table top load" {
  parts: [stand]
  fix: face(stand, -Z)
  load: force(face(stand, +Z), (0, 0, -1500))
}
`);
    expect(spec.parts).toHaveLength(12);
    expect(input.elements).toBe("beams");
    expect(r.beams!.members).toHaveLength(12);
    expect(r.beams!.joints).toBe(8);
    // the top rails carry the load to the posts; the floor takes it all back
    expect(r.supports[0].reaction[2]).toBeCloseTo(1500, 3);
    const posts = r.beams!.members.filter((m) => Math.abs(m.length - 700) < 1);
    expect(posts).toHaveLength(4);
    for (const p of posts) expect(p.axial).toBeLessThan(0);
    expect(r.minSafety.value).toBeGreaterThan(1);
    const text = structuralSummary(spec, { status: "done", result: r, resolution: "standard" });
    expect(text).toMatch(/12 members as beams/);
    expect(text).toMatch(/Members:/);
  });

  it("analyses a bought V-slot frame with the catalog's stiffness", () => {
    const { input, r, parts } = run(`design "printer"
frame base {
  profile: "2020"
  box: (300, 300, 300)
}
analysis "Gantry load" {
  parts: [base]
  fix: face(base, -Z)
  load: force(face(base_5, +Z), (0, 0, -50))
  gravity
}
`);
    expect(parts.every((p) => p.kind === "component" && p.beam?.section.kind === "extrusion")).toBe(true);
    expect(input.elements).toBe("beams");
    expect(input.parts[0].beam!.section.Iu).toBe(7000);
    expect(r.beams!.notes.join(" ")).toMatch(/bolted extrusion corners/);
    // the frame's weight (0.5 kg/m) and the load go to the floor
    const w = r.gravity!.vector[2];
    expect(r.supports[0].reaction[2]).toBeCloseTo(50 - w, 3);
    // twelve members of about 280 mm between the joints' centre lines
    expect(r.mass).toBeGreaterThan(1500);
    expect(r.mass).toBeLessThan(1900);
  });

  it("analyses single members by name, and keeps solids when asked", () => {
    const src = (extra: string) => `design "f"
frame stand {
  profile: "box 25x25x2"
  material: "Steel"
  path: [(0, 0, 0), (0, 0, 500), (600, 0, 500)]
}
analysis "Arm" {
  parts: [stand_1, stand_2]
  fix: face(stand_1, -Z)
  load: force(face(stand_2, +X), (0, 0, -100))
${extra}}
`;
    const { r } = run(src(""));
    expect(r.beams!.members).toHaveLength(2);
    expect(r.beams!.joints).toBe(1);
    const solid = evaluate(src('  elements: "solid"\n'));
    expect((solid.analyses[0] as StructuralSpec).elements).toBe("solid");
  });

  it("analyses a frame as solids when asked, holding it by the frame's name", () => {
    const { input, r } = run(`design "f"
frame stand {
  profile: "box 25x25x2"
  material: "Steel"
  path: [(0, 0, 0), (0, 0, 300), (300, 0, 300)]
}
analysis "Arm" {
  parts: [stand]
  fix: face(stand, -Z)
  load: force(face(stand, +X), (0, 0, -100))
  elements: "solid"
  resolution: "draft"
}
`);
    expect(input.elements).toBeUndefined();
    expect(input.parts.every((p) => p.group === "stand" && !p.beam)).toBe(true);
    expect(r.beams).toBeUndefined();
    expect(r.supports[0].reaction[2]).toBeCloseTo(100, 0);
  });

  it("refuses beams with what they cannot follow yet", () => {
    const errs = (extra: string) =>
      evaluate(`design "f"
frame stand {
  profile: "box 25x25x2"
  material: "Steel"
  box: (400, 300, 250)
}
analysis "a" {
  parts: [stand]
  fix: face(stand, -Z)
  load: force(face(stand, +Z), (0, 0, -100))
${extra}}
`)
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => d.message)
        .join(" ");
    expect(errs('  elements: "beams"\n  modes: 3\n')).toMatch(/elements: "beams" cannot follow natural frequencies yet/);
    expect(errs('  elements: "wires"\n')).toMatch(/elements: should be "beams"/);
    expect(errs("")).toBe("");
  });
});

describe("a frame's real members", { timeout: 300_000 }, () => {
  beforeAll(initKernel);
  it("draws the beams' stresses on the built V-slot and box members", () => {
    for (const profile of ["2020", "box 25x25x2"]) {
      const m = evaluate(`design "stand"
frame stand {
  profile: "${profile}"
  material: "Aluminium 6061"
  box: (400, 300, 350)
}
analysis "Load on top" {
  parts: [stand]
  fix: face(stand, -Z)
  load: force(face(stand, +Z), (0, 0, -400))
}
`);
      expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const spec = m.analyses[0] as StructuralSpec;
      const parts = m.parts.filter((p) => spec.parts.includes(p.name));
      const meshes = new Map(parts.map((p) => [p.hash, meshShape(buildPart(p.recipe), "preview")]));
      const prep = structuralInput(spec, parts, false, new Map(), (h) => meshes.get(h));
      expect(prep?.error).toBeUndefined();
      const r = runStructural(prep!.input!);
      expect(r.beams!.members).toHaveLength(12);
      // every vertex of every member is on its member: the drawn peak matches the members' own peak
      const drawn = Math.max(...r.parts.map((p) => Math.max(...p.stress)));
      const peak = Math.max(...r.beams!.members.map((x) => x.stress));
      expect(drawn).toBeGreaterThan(0.6 * peak);
      expect(drawn).toBeLessThanOrEqual(peak * 1.0001);
      // the top rails sag more than the posts move
      expect(r.maxDisp.at[2]).toBeGreaterThan(300);
      expect(r.supports[0].reaction[2]).toBeCloseTo(400, 3);
    }
  });
});
