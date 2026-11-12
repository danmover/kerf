import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/lang/evaluator";
import { runStructural } from "../src/analysis/fe/structural";
import type { AirflowSpec, AirLoadSpec, StructuralSpec } from "../src/analysis/spec";
import type { AirflowResult, PartForce, SurfaceField, YawResult } from "../src/analysis/aero/types";
import { airField, airKey, airflowNamed, partForceWorld, resultId, type AirSource } from "../src/analysis/airLoads";
import { airSamples, airScale, nearestSample } from "../src/analysis/fe/airLoads";
import { liveAirSource, structuralInput } from "../src/analysis/runtime";
import { useAirflow } from "../src/analysis/aeroRuntime";
import { structuralSummary } from "../src/analysis/summary";
import { buildPart, meshShape, type MeshData } from "../src/kernel/build";
import { initKernel } from "./helpers/kernel";
import type { EvalPart, Model } from "../src/core/model";

beforeAll(() => initKernel(), 60_000);
afterEach(() => useAirflow.setState({ runs: new Map() }));

const SIGN = `design "Sign"
part sign {
  material: "Aluminum 6061"
  body box(4, 300, 200)
}
analysis "Gale" {
  airflow: 90kmh
  forward: -X
  parts: [sign]
}
analysis "Sign in a gale" {
  fix: face(sign, -Z)
  load: air("Gale")
}
`;

const errors = (src: string) => evaluate(src).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
const specs = (m: Model) => ({ aero: m.analyses.find((a) => a.kind === "airflow") as AirflowSpec, strength: m.analyses.find((a) => a.kind === "structural") as StructuralSpec });
const meshesOf = (parts: EvalPart[]) => new Map(parts.map((p) => [p.hash, meshShape(buildPart(p.recipe), "preview")]));

/** A run's surface on a part: pressure 1 on the faces looking into the wind (−X), −0.5 on the ones behind, 0 on the edges. */
function fakeRun(part: EvalPart, mesh: MeshData, measured: number): AirflowResult {
  const nv = mesh.positions.length / 3;
  const cp = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const nx = mesh.normals[3 * v];
    cp[v] = nx < -0.9 ? 1 : nx > 0.9 ? -0.5 : 0;
  }
  const surface: SurfaceField = { id: part.id, name: part.name, positions: mesh.positions, normals: mesh.normals, indices: Uint32Array.from(mesh.indices), cp, cf: new Float32Array(nv * 3) };
  const force: PartForce = { id: part.id, name: part.name, drag: measured, side: 0, lift: 0, cda: 0, friction: 0 };
  const yaw = { yaw: 0, drag: measured, side: 0, lift: 0, parts: [force], surface: [surface] } as unknown as YawResult;
  return { label: "Gale", speed: 25, density: 1.225, yaws: [yaw], h: 10, dims: [10, 10, 10], cells: 1000, backend: "cpu", reynolds: 1e5, blockage: 0.05, warnings: [], ms: 1 };
}

describe("air loads in the language", () => {
  it("reads air() with its yaw, speed and scale", () => {
    const m = evaluate(SIGN.replace('air("Gale")', 'air("Gale", yaw: 0, speed: 120kmh, scale: 1.5)'));
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const { strength } = specs(m);
    expect(strength.parts).toEqual(["sign"]);
    const l = strength.loads[0] as AirLoadSpec;
    expect(l).toMatchObject({ t: "air", analysis: "Gale", yaw: 0, scale: 1.5 });
    expect(l.speed! / 1000).toBeCloseTo(120 / 3.6, 6);
  });

  it("asks for a speed with its unit and a yaw it could have", () => {
    expect(errors(SIGN.replace('air("Gale")', 'air("Gale", speed: 30)'))[0]).toMatch(/speed with its unit/);
    expect(errors(SIGN.replace('air("Gale")', 'air("Gale", yaw: 60)'))[0]).toMatch(/from -45 to 45/);
  });

  it("names the airflow analyses there are when it names one that is not there", () => {
    const m = evaluate(SIGN);
    expect(airflowNamed(m, "Gale")).toMatchObject({ kind: "airflow", label: "Gale" });
    expect(airflowNamed(m, "gale")).toMatchObject({ label: "Gale" });
    expect(airflowNamed(m, "Storm")).toMatch(/no airflow analysis called "Storm"; this design has "Gale"/);
    expect(airflowNamed({ analyses: [] }, "Storm")).toMatch(/this design has none/);
  });
});

describe("air loads on the solver", () => {
  it("presses the run's pressures onto the surface, matched to the force the run measured", () => {
    const m = evaluate(SIGN);
    const { aero, strength } = specs(m);
    const parts = m.parts.filter((p) => strength.parts.includes(p.name));
    const meshes = meshesOf(parts);
    // ½ρv² at 25 m/s on 300 × 200 mm, 1 in front and −0.5 behind: 1.5 × 382.8 Pa × 0.06 m² = 34.45 N along +X
    const q = 0.5 * 1.225 * 25 * 25;
    const fromSurface = 1.5 * q * 0.06;
    const run = fakeRun(parts[0], meshes.get(parts[0].hash)!, 1.2 * fromSurface);
    const air: AirSource = () => ({ result: run, aero, id: resultId(run) });
    const prep = structuralInput(strength, parts, false, new Map(), (h) => meshes.get(h), air);
    expect(prep?.error).toBeUndefined();
    const field = (prep!.input!.loads[0] as AirLoadSpec).field!;
    expect(field.q).toBeCloseTo(q * 1e-6, 12);
    expect(field.parts.map((p) => p.name)).toEqual(["sign"]);
    // the run's drag, back along forward (−X), is a push along +X
    expect(field.parts[0].force[0]).toBeCloseTo(1.2 * fromSurface, 6);
    const r = runStructural(prep!.input!);
    const ld = r.loads[0];
    expect(ld.kind).toBe("air");
    expect(ld.air!.parts[0].scale).toBeGreaterThan(1.12);
    expect(ld.air!.parts[0].scale).toBeLessThan(1.28);
    expect(ld.magnitude / (1.2 * fromSurface)).toBeCloseTo(1, 2);
    expect(ld.vector[0] / ld.magnitude).toBeGreaterThan(0.999);
    // the wetted area is the plate's whole skin
    expect(ld.area / (2 * (300 * 200 + 4 * 300 + 4 * 200))).toBeGreaterThan(0.9);
    expect(ld.area / (2 * (300 * 200 + 4 * 300 + 4 * 200))).toBeLessThan(1.1);
    // the plate bends away from the wind
    expect(r.maxDisp.value).toBeGreaterThan(0);
    expect(r.equilibrium).toBeLessThan(0.01);
    const text = structuralSummary(strength, { status: "done", result: r, resolution: "draft" });
    expect(text).toMatch(/air from "Gale" \(0° yaw, 90 km\/h\) totalling 41\.\d N: 41\.\d N on sign over \d+ mm², pressures ×1\.2 to match the 41\.\d N the run measured/);
  }, 120_000);

  it("loads at another speed as the square of the speed, keeps parts it does not analyse out, and picks a yaw", () => {
    const m = evaluate(SIGN);
    const { aero, strength } = specs(m);
    const sign = m.parts[0];
    const mesh = meshesOf([sign]).get(sign.hash)!;
    const run = fakeRun(sign, mesh, 30);
    const twice = airField({ t: "air", analysis: "Gale", speed: 50000, scale: 1 }, aero, run, [sign]).field!;
    expect(twice.q).toBeCloseTo(0.5 * 1.225 * 50 * 50 * 1e-6, 12);
    expect(twice.parts[0].force[0]).toBeCloseTo(120, 6);
    expect(twice.runSpeed).toBe(25);
    // a part in the air that this analysis leaves out is named with the force on it
    const other = { ...sign, id: "someone_else", name: "flag" };
    const left = airField({ t: "air", analysis: "Gale", scale: 2 }, aero, run, [other]);
    expect(left.error).toMatch(/none of flag is in that analysis's air \(it has sign\)/);
    expect(airField({ t: "air", analysis: "Gale", yaw: 5, scale: 1 }, aero, run, [sign]).error).toMatch(/runs at 0°; give one of those/);
    // body axes: drag holds it back along forward, side pushes it left (toward −right), lift up
    const f = partForceWorld({ forward: [1, 0, 0], up: [0, 0, 1] }, { id: "a", name: "a", drag: 3, side: 2, lift: 1, cda: 0, friction: 0 });
    expect(f).toEqual([-3, 2, 1]);
    void strength;
  });

  it("reads the nearest point on the same side of a thin wall, and keeps the scale sensible", () => {
    // a 2 mm wall: two faces 2 mm apart, pressure 1 in front (−X) and −1 behind
    const pos = Float32Array.from([0, 0, 0, 0, 10, 0, 0, 0, 10, 2, 0, 0, 2, 10, 0, 2, 0, 10]);
    const S = airSamples({ name: "w", positions: pos, indices: Uint32Array.from([0, 2, 1, 3, 4, 5]), cp: Float32Array.from([1, 1, 1, -1, -1, -1]), cf: new Float32Array(18), force: [0, 0, 0] }, 1, 3);
    expect(S.count).toBeGreaterThan(50);
    const front = nearestSample(S, [0.9, 2, 2], [-1, 0, 0]);
    const back = nearestSample(S, [1.1, 2, 2], [1, 0, 0]);
    expect(S.cp[front]).toBeCloseTo(1, 6);
    expect(S.cp[back]).toBeCloseTo(-1, 6);
    expect(nearestSample(S, [40, 40, 40], [1, 0, 0])).toBe(-1);
    expect(airScale([10, 0, 0], [12, 0, 0])).toBeCloseTo(1.2, 6);
    expect(airScale([10, 0, 0], [0, 12, 0])).toBe(1);
    expect(airScale([1, 0, 0], [100, 0, 0])).toBe(3);
  });
});

describe("air loads in the app", () => {
  it("wait for the airflow run, then take it, and run again with each new one", () => {
    const m = evaluate(SIGN);
    const { strength } = specs(m);
    const air = liveAirSource(m);
    expect(air("Gale")).toEqual({ wait: 'Waiting for the airflow run "Gale" to finish' });
    expect(airKey(strength, air)).toBe("|air:Gale:wait");
    const run = fakeRun(m.parts[0], meshesOf([m.parts[0]]).get(m.parts[0].hash)!, 30);
    const base = { label: "Gale", key: "k", stage: "Done", frac: 1, startedAt: 0 };
    useAirflow.setState({ runs: new Map([["Gale", { ...base, status: "running" as const, stale: true, result: run }]]) });
    expect("wait" in air("Gale")).toBe(true);
    useAirflow.setState({ runs: new Map([["Gale", { ...base, status: "done" as const, stale: false, result: run }]]) });
    const st = air("Gale");
    expect("result" in st && st.result).toBe(run);
    expect(airKey(strength, air)).toBe(`|air:Gale#${resultId(run)}`);
    useAirflow.setState({ runs: new Map([["Gale", { ...base, status: "error" as const, stale: false, error: "Stopped." }]]) });
    expect(air("Gale")).toEqual({ error: 'The airflow analysis "Gale" did not finish (Stopped.), so its air cannot load this analysis yet.' });
    expect(liveAirSource(m)("Storm")).toMatchObject({ error: expect.stringMatching(/no airflow analysis called "Storm"/) });
    // a run with no air source (an alternative being compared) says why it has no air
    const parts = m.parts.filter((p) => strength.parts.includes(p.name));
    const meshes = meshesOf(parts);
    expect(structuralInput(strength, parts, false, new Map(), (h) => meshes.get(h))?.error).toMatch(/design's own airflow run/);
    useAirflow.setState({ runs: new Map() });
    expect(structuralInput(strength, parts, false, new Map(), (h) => meshes.get(h), liveAirSource(m))).toEqual({ wait: 'Waiting for the airflow run "Gale" to finish' });
  });
});
