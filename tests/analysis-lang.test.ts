import { describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import type { StructuralSpec } from "../src/analysis/spec";

const bracket = `design "b"
param load = 40N
param torque = 2Nm
part plate { body box(60, 4, 30, at: (0, 2, 0)) }
part arm { body box(4, 50, 30, at: (28, 29, 0)) }
`;

const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("analysis blocks", () => {
  it("turns an analysis block into a structural set-up", () => {
    const m = evaluate(
      bracket +
        `analysis "Shelf load" {
  parts: [plate, arm]
  fix: face(plate, -Y)
  fix: roller(zone(at: (0, 0, 15), r: 2), Z)
  load: force(face(arm, +Y), (0, 0, -load))
  load: pressure(face(arm, +X), 0.01MPa)
  gravity
  printed
  build: Y
  safety: 2.5
  cycles: 1e5
  max_deflection: 0.5mm
  resolution: "fine"
}`,
    );
    expect(errors(bracket + "")).toHaveLength(0);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    const a = m.analyses[0] as StructuralSpec;
    expect(a.kind).toBe("structural");
    expect(a.parts).toEqual(["plate", "arm"]);
    expect(a.supports[0]).toEqual({ region: { t: "face", part: "plate", dir: [0, -1, 0] } });
    expect(a.supports[1].dir).toEqual([0, 0, 1]);
    expect(a.loads[0]).toMatchObject({ t: "force", f: [0, 0, -40] });
    expect(a.loads[1]).toMatchObject({ t: "pressure", p: 0.01 });
    expect(a.accel).toEqual([0, 0, -1]);
    expect(a.printed).toBe(true);
    expect(a.buildDir).toEqual([0, 1, 0]);
    expect(a.safety).toBe(2.5);
    expect(a.cycles).toBe(1e5);
    expect(a.maxDeflection).toBe(0.5);
    expect(a.resolution).toBe("fine");
    // the analysis shows up in the dependency graph, reading the parts and the load parameter
    expect(m.graph.nodes.some((n) => n.kind === "analysis" && n.label === "Shelf load")).toBe(true);
    expect(m.graph.edges).toContainEqual({ from: "load", to: "analysis:Shelf load" });
    expect(m.graph.edges).toContainEqual({ from: "arm", to: "analysis:Shelf load" });
    expect(m.blocks.some((b) => b.kind === "analysis" && b.name === "Shelf load")).toBe(true);
  });

  it("converts force, torque, pressure and time units", () => {
    const m = evaluate(`design "u"\nparam a = 2kN\nparam b = 3Nm\nparam c = 1bar\nparam d = 100psi\nparam e = 2GPa\nparam f = 5000h\nparam g = 10lbf\nparam h = 5kgf\nparam k = 5 * 9.81N`);
    const v = Object.fromEntries(m.params.map((p) => [p.name, p.value as number]));
    expect(v.a).toBe(2000);
    expect(v.b).toBe(3000);
    expect(v.c).toBeCloseTo(0.1);
    expect(v.d).toBeCloseTo(0.689, 3);
    expect(v.e).toBe(2000);
    expect(v.f).toBe(5000);
    expect(v.g).toBeCloseTo(44.48, 2);
    // the weight of 5 kg, written either way
    expect(v.h).toBeCloseTo(49.03, 2);
    expect(v.k).toBeCloseTo(49.05, 2);
  });

  it("lets analysis functions coexist with parameters of the same name", () => {
    const m = evaluate(bracket + `analysis "Twist" {\n  fix: face(plate, -Y)\n  load: torque(face(arm, +Y), torque, axis: Y)\n}`);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const a = m.analyses[0] as StructuralSpec;
    expect(a.parts.sort()).toEqual(["arm", "plate"]);
    expect(a.loads[0]).toMatchObject({ t: "torque", torque: 2000, axis: [0, 1, 0] });
    // face(), force() and friends are not visible outside analysis blocks
    expect(errors(bracket + `let f = face(plate, -Y)`)[0]).toMatch(/"face" is not defined/);
  });

  it("supports loops for repeated supports", () => {
    const m = evaluate(bracket + `analysis "Screws" {\n  for p in [(-20, 0, 0), (20, 0, 0)] { fix: zone(at: p, r: 3) }\n  load: force(face(arm, +Y), 10N, dir: -Z)\n  parts: [plate, arm]\n}`);
    const a = m.analyses[0] as StructuralSpec;
    expect(a.supports).toHaveLength(2);
    expect(a.supports[1].region).toEqual({ t: "sphere", at: [20, 0, 0], r: 3 });
    expect(a.loads[0]).toMatchObject({ f: [0, 0, -10] });
  });

  it("explains incomplete or wrong set-ups", () => {
    expect(errors(bracket + `analysis "a" {\n  load: force(face(arm, +Y), (0, 0, -1))\n}`)[0]).toMatch(/Add fix:/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n}`)[0]).toMatch(/Add load:/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n  parts: [plate]\n}`)[0]).toMatch(/not in parts:/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(nothing, -Y)\n}`)[0]).toMatch(/"nothing" is not defined/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n  materal: "PLA"\n}`)[0]).toMatch(/Unknown analysis property "materal"/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n  material: "Unobtainium"\n}`)[0]).toMatch(/no strength data/);
    expect(errors(bracket + `analysis "a" {\n  fix: plate\n  load: force(face(arm, +Y), (0, 0, -1))\n}`)[0]).toMatch(/fix: should be a region/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n}\nanalysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n}`)[0]).toMatch(/already an analysis called "a"/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n  speed: 100rpm\n}`)[0]).toMatch(/belongs to a drivetrain analysis/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n  resolution: 0.05mm\n}`)[0]).toMatch(/at least 0\.1mm/);
    expect(errors(bracket + `analysis "a" {\n  fix: face(plate, -Y)\n  load: force(face(arm, +Y), (0, 0, -1))\n  resolution: 0.1mm\n}`)).toEqual([]);
    const many = Array.from({ length: 201 }, (_, i) => `  fix: zone(at: (${(i % 60) - 30}, 0, 0), r: 0.5)`).join("\n");
    expect(errors(bracket + `analysis "a" {\n${many}\n  load: force(face(arm, +Y), (0, 0, -1))\n}`)[0]).toMatch(/at most 200 supports and loads/);
  });

  it("describes a drivetrain duty", () => {
    const src = `design "d"
component g1 = lib.spur_gear(m: 1, z: 12, width: 6, bore: 5) { at: (0, 0, 0), axis: Y, spin: 1 }
component g2 = lib.spur_gear(m: 1, z: 36, width: 6, bore: 5) { at: (24, 0, 0), axis: Y, mesh: g1 }
analysis "Duty" {
  drive: g1
  torque: 0.4Nm
  speed: 3000rpm
  life: 2000h
  safety: 1.5
}`;
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(m.analyses[0]).toMatchObject({ kind: "drivetrain", drive: "g1", torque: 400, speed: 3000, life: 2000, safety: 1.5 });
    expect(m.parts.find((p) => p.id === "g1")?.gear?.bore).toBe(5);
    expect(errors(src.replace("drive: g1", "drive: g1\n  fix: face(g1, -Y)"))[0]).toMatch(/belongs to a structural analysis/);
  });

  it("records bearing ratings on bearing components", () => {
    const m = evaluate(`design "b"\ncomponent b = lib.bearing("608") { at: (0, 10, 0), axis: Y }`);
    const b = m.parts[0].bearing!;
    expect(b.code).toBe("608");
    expect(b.dynamicLoadN).toBe(3450);
    expect(b.center[1]).toBeCloseTo(13.5);
  });
});
