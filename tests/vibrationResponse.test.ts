import { describe, expect, it } from "vitest";
import { runStructural, type FeaPart, type StructuralInput } from "../src/analysis/fe/structural";
import { boxMesh, type V3 } from "../src/analysis/fe/voxel";
import { mechMaterial } from "../src/analysis/materials";
import { cyclePeak, G_MM, grms, psdAt, PSD_PRESETS, steinbergLife, symEigen } from "../src/analysis/fe/vibration";
import { dynamicItems, shakingText } from "../src/analysis/dynamics";
import { structuralSummary } from "../src/analysis/summary";
import type { StructuralSpec } from "../src/analysis/spec";
import { evaluate } from "../src/lang/evaluator";

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe("shaking helpers", () => {
  it("works out the overall level of a spectrum and reads it between its points", () => {
    // NAVMAT P-9492 is 6.06 g rms; ASTM D4169's truck at level II about 0.52 g rms
    expect(grms(PSD_PRESETS.navmat.points)).toBeCloseTo(6.06, 2);
    expect(grms(PSD_PRESETS.truck.points)).toBeCloseTo(0.517, 2);
    // a flat spectrum: S·(f₁ − f₀)
    expect(grms([[20, 0.01], [2000, 0.01]])).toBeCloseTo(Math.sqrt(19.8), 6);
    // straight on log-log axes: +3 dB/octave from 0.01 at 20 Hz doubles every octave
    const pts = PSD_PRESETS.navmat.points;
    expect(psdAt(pts, 40)).toBeCloseTo(0.02, 6);
    expect(psdAt(pts, 200)).toBeCloseTo(0.04, 9);
    expect(psdAt(pts, 10)).toBe(0);
    expect(psdAt(pts, 3000)).toBe(0);
  });

  it("finds the largest von Mises stress over a cycle of stresses out of phase", () => {
    // one stress alone: its amplitude
    const a = [100, 0, 0, 0, 0, 0];
    const b = [0, 0, 0, 0, 0, 0];
    expect(cyclePeak(a, 0, b, 0).vm).toBeCloseTo(100, 9);
    // a pull and a shear a quarter cycle apart: σ cos θ and τ sin θ, so the peak is the larger of σ and √3·τ
    const c = [0, 0, 0, 40, 0, 0];
    expect(cyclePeak(a, 0, [0, 0, 0, -40, 0, 0], 0).vm).toBeCloseTo(100, 6);
    expect(cyclePeak([0, 0, 0, 0, 0, 0], 0, c, 0).vm).toBeCloseTo(40 * Math.sqrt(3), 6);
    // a pull along x and one along y half a cycle apart swing through pure shear: von Mises peaks at √3·σ
    expect(cyclePeak([50, -50, 0, 0, 0, 0], 0, b, 0).vm).toBeCloseTo(50 * Math.sqrt(3), 6);
  });

  it("splits a covariance into independent shapes and adds Steinberg's three bands", () => {
    const A = new Float64Array([4, 1, 0.5, 1, 3, 0.2, 0.5, 0.2, 1]);
    const { val, vec } = symEigen(A, 3);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let m = 0; m < 3; m++) s += vec[i * 3 + m] * val[m] * vec[j * 3 + m];
        expect(s).toBeCloseTo(A[i * 3 + j], 9);
      }
    // N(s) = 10⁷·(100/s)⁵: at 1σ = 100 MPa crossing 50 times a second
    const N = (s: number) => 1e7 * (100 / s) ** 5;
    const d = 0.683 / N(100) + 0.271 / N(200) + 0.0433 / N(300);
    expect(steinbergLife(100, 50, N)).toBeCloseTo(1 / (50 * d), 6);
    expect(steinbergLife(0, 50, N)).toBe(Infinity);
  });
});

// A steel cantilever 200 mm long, 10 mm wide (Y) and 6 mm deep (Z): it bends first along Z, well apart from Y.
const L = 200,
  W = 10,
  T = 6;
const steel = mechMaterial("Steel");
const beam: FeaPart = { id: "beam", name: "beam", mesh: boxMesh([0, 0, 0], [L, W, T]), material: 0 };
function input(over: Partial<StructuralInput>): StructuralInput {
  return {
    label: "shaker",
    parts: [beam],
    materials: [steel],
    supports: [{ region: { t: "face", part: "beam", dir: [-1, 0, 0] } }],
    loads: [],
    target: 9000,
    printed: false,
    buildDir: [0, 0, 1],
    safety: 1.5,
    modes: 6,
    ...over,
  };
}
// Euler–Bernoulli's first cantilever mode: φ(x) = cosh βx − cos βx − σ(sinh βx − sin βx), βL = 1.8751
const bL = 1.875104,
  sig = (Math.cosh(bL) + Math.cos(bL)) / (Math.sinh(bL) + Math.sin(bL));
const phi = (x: number) => Math.cosh(bL * x) - Math.cos(bL * x) - sig * (Math.sinh(bL * x) - Math.sin(bL * x));
const phi2 = (x: number) => Math.cosh(bL * x) + Math.cos(bL * x) - sig * (Math.sinh(bL * x) + Math.sin(bL * x));
/** the tip's movement relative to the base per unit of the first mode's response: Γ₁φ₁(L) = 1.566 for a uniform cantilever */
const tipFactor = (() => {
  let a = 0,
    b = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    a += phi(x) / n;
    b += phi(x) ** 2 / n;
  }
  return (a / b) * phi(1);
})();
/** the bending stress at x along the top face per mm of tip movement in the first mode */
const stressPerTip = (x: number) => (steel.E * (T / 2) * (bL / L) ** 2 * phi2(x / L)) / phi(1);
/** the result's von Mises stress on the top face at x, half way across */
function topStress(r: ReturnType<typeof runStructural>, x: number): number {
  const v = r.interior!;
  const i = Math.round((x - v.origin[0]) / v.step[0]);
  const j = Math.round((W / 2 - v.origin[1]) / v.step[1]);
  const k = Math.round((T - v.origin[2]) / v.step[2]);
  return v.stress![i + v.n[0] * (j + v.n[1] * k)];
}

describe("shaking a cantilever", () => {
  it("answers a sine sweep through its first mode as beam theory does", () => {
    const zeta = 0.02;
    const r = runStructural(input({ shake: { lo: 20, hi: 400, accel: 1, dir: [0, 0, 1] }, damping: zeta }));
    const v = r.vibration!;
    expect(v.kind).toBe("sine");
    const f1 = r.modal!.modes[0].freq;
    // about 122 Hz by beam theory (1.875²/2π · √(EI/ρAL⁴))
    expect(rel(f1, 122.3)).toBeLessThan(0.02);
    // the worst stress comes at the first mode, shaking about Q = 1/2ζ = 25 times the slow answer
    expect(rel(v.at!, f1)).toBeLessThan(0.01);
    expect(v.gain!).toBeGreaterThan(23);
    expect(v.gain!).toBeLessThan(27.5);
    // the tip moves Γ₁φ₁(L)·Q·A/ω₁² relative to the base
    expect(tipFactor).toBeCloseTo(1.566, 2);
    const w1 = 2 * Math.PI * f1;
    const tip = (tipFactor * G_MM) / (2 * zeta * w1 * w1);
    expect(rel(r.maxDisp.value, tip)).toBeLessThan(0.02);
    expect(r.maxDisp.at[0]).toBeGreaterThan(L - 2);
    // half way along, the top face is stressed as the first mode's curvature says
    expect(rel(topStress(r, L / 2), stressPerTip(L / 2) * r.maxDisp.value)).toBeLessThan(0.03);
    expect(rel(topStress(r, L / 5), stressPerTip(L / 5) * r.maxDisp.value)).toBeLessThan(0.03);
    // the response across the band peaks at the mode
    const c = v.curve!;
    const peak = c.disp.indexOf(Math.max(...c.disp));
    expect(rel(c.f[peak], f1)).toBeLessThan(0.01);
    expect(c.disp[0]).toBeLessThan(0.05 * c.disp[peak]);
    // judged against the fatigue strength of machined steel for 10⁷ cycles, below the 190 MPa of a polished one
    expect(r.minSafety.mode).toBe("fatigue");
    expect(r.minSafety.allowable).toBeLessThan(190);
    expect(v.cycles).toBe(1e7);
    // the mode moves about 61 % of the beam's mass along Z, and the next bending mode about 19 % more
    expect(v.massShare).toBeGreaterThan(0.75);
  }, 60_000);

  it("gives the RMS movement of random shaking as Miles' equation does", () => {
    const zeta = 0.02;
    const S = 0.01;
    const r = runStructural(input({ random: { points: [[20, S], [2000, S]], dir: [0, 0, 1] }, damping: zeta, duration: 3600 }));
    const v = r.vibration!;
    expect(v.kind).toBe("random");
    expect(v.level).toBeCloseTo(Math.sqrt(19.8), 3);
    const f1 = r.modal!.modes[0].freq;
    const w1 = 2 * Math.PI * f1;
    // σ = Γ₁φ₁(L)·√(π/2 · f₁ · Q · S)·g / ω₁²
    const miles = (tipFactor * Math.sqrt((Math.PI / 2) * f1 * (1 / (2 * zeta)) * S) * G_MM) / (w1 * w1);
    expect(rel(v.rms!.disp, miles)).toBeLessThan(0.02);
    // the movement shown is 3σ
    expect(rel(r.maxDisp.value, 3 * v.rms!.disp)).toBeLessThan(0.02);
    // the stresses shown are 3σ of the RMS von Mises stress
    expect(rel(r.maxStress.value, 3 * v.rms!.stress)).toBeLessThan(0.02);
    // the first mode carries it, so the stress swings at about its frequency
    expect(v.nu0!).toBeGreaterThan(0.95 * f1);
    expect(v.nu0!).toBeLessThan(2 * f1);
    // an hour of shaking at about ν₀ cycles a second
    expect(rel(v.cycles, 3600 * v.nu0!)).toBeLessThan(1e-9);
    expect(v.life).toBeGreaterThan(0);
  }, 60_000);

  it("shakes the loads up and down when the sweep has no acceleration", () => {
    const F = 2;
    const zeta = 0.05;
    const tipLoad = { t: "force" as const, region: { t: "face" as const, part: "beam", dir: [1, 0, 0] as V3 }, f: [0, 0, -F] as V3 };
    const r = runStructural(input({ loads: [tipLoad], shake: { lo: 50, hi: 300 }, damping: zeta }));
    const v = r.vibration!;
    expect(v.dir).toBeUndefined();
    expect(v.level).toBe(1);
    const f1 = r.modal!.modes[0].freq;
    expect(rel(v.at!, f1)).toBeLessThan(0.01);
    // a tip force F at resonance: the static tip deflection FL³/3EI times about Q = 10 (mode 1 takes 97 % of it)
    const I = (W * T ** 3) / 12;
    const tStatic = (F * L ** 3) / (3 * steel.E * I);
    expect(r.maxDisp.value).toBeGreaterThan(0.85 * 10 * tStatic);
    expect(r.maxDisp.value).toBeLessThan(1.1 * 10 * tStatic);
    expect(v.gain!).toBeGreaterThan(8.5);
    expect(v.gain!).toBeLessThan(11);
  }, 60_000);
});

describe("shaking in the design language", () => {
  const bracket = `
part bracket {
  material: "Aluminum 6061"
  body box(100, 10, 10, at: (50, 0, 0))
}
`;
  const spec = (block: string) => {
    const m = evaluate(bracket + block);
    expect(m.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    return m.analyses[0] as StructuralSpec;
  };
  const error = (block: string) => evaluate(bracket + block).diagnostics.find((d) => d.severity === "error")?.message ?? "";

  it("reads sine sweeps and random shaking", () => {
    const s = spec(`analysis "Shaker" {\n  fix: face(bracket, -X)\n  shake: sine(10Hz, 500Hz, 2g, Z)\n  damping: 3%\n  duration: 2h\n  finish: "ground"\n}`);
    expect(s.modal).toMatchObject({ modes: 12, damping: 0.03, duration: 7200, finish: "ground", shake: { lo: 10, hi: 500, accel: 2, dir: [0, 0, 1], label: "10–500 Hz at 2 g" } });
    expect(s.safety).toBe(1.5);
    expect(s.resolution).toBe("standard");
    const r = spec(`analysis "Truck" {\n  fix: face(bracket, -X)\n  random: psd("truck", -Y)\n  modes: 8\n}`);
    expect(r.modal?.modes).toBe(8);
    expect(r.modal?.random?.dir).toEqual([0, -1, 0]);
    expect(r.modal?.random?.label).toMatch(/ASTM D4169 truck.*1–200 Hz, 0\.52 g rms/);
    const own = spec(`analysis "Own" {\n  fix: face(bracket, -X)\n  random: psd([(20Hz, 0.01), (80Hz, 0.04), (350Hz, 0.04), (2000Hz, 0.007)], X)\n}`);
    expect(own.modal?.random?.points).toEqual(PSD_PRESETS.navmat.points);
    expect(own.modal?.random?.label).toBe("20–2000 Hz, 6.06 g rms");
    const loads = spec(`analysis "Pump" {\n  fix: face(bracket, -X)\n  load: force(face(bracket, +X), 5N, dir: -Z)\n  shake: sine(20Hz, 200Hz)\n}`);
    expect(loads.modal?.shake).toEqual({ lo: 20, hi: 200, label: "20–200 Hz" });
  });

  it("explains what shaking cannot go with", () => {
    const fix = "  fix: face(bracket, -X)\n";
    expect(error(`analysis "x" {\n${fix}  load: force(face(bracket, +X), 5N, dir: -Z)\n  shake: sine(10Hz, 500Hz, 2g)\n}`)).toMatch(/leave out load:, gravity and accel:/);
    expect(error(`analysis "x" {\n${fix}  gravity\n  random: psd("navmat", Z)\n}`)).toMatch(/leave out load:, gravity and accel:/);
    expect(error(`analysis "x" {\n${fix}  shake: sine(10Hz, 500Hz)\n}`)).toMatch(/needs load:/);
    expect(error(`analysis "x" {\n${fix}  shake: sine(10Hz, 500Hz, 1g)\n  random: psd("navmat", Z)\n}`)).toMatch(/not both/);
    expect(error(`analysis "x" {\n${fix}  load: force(face(bracket, +X), 5N, dir: -Z)\n  duration: 1h\n}`)).toMatch(/goes with shake: or random:/);
    expect(error(`analysis "x" {\n${fix}  random: psd("navmat", Z)\n  history: [block(1e6, 1)]\n}`)).toMatch(/shaking makes its own cycles/);
    expect(error(`analysis "x" {\n${fix}  random: psd("earthquake", Z)\n}`)).toMatch(/"navmat", "truck"/);
    expect(error(`analysis "x" {\n${fix}  random: psd([(200Hz, 0.01), (20Hz, 0.01)], Z)\n}`)).toMatch(/go up/);
    expect(error(`analysis "x" {\n${fix}  shake: sine(500Hz, 10Hz, 1g)\n}`)).toMatch(/higher one/);
    expect(error(`analysis "x" {\n  parts: [bracket]\n  shake: sine(10Hz, 500Hz, 1g)\n  drop: 1m\n}`)).toMatch(/Check shaking in a separate analysis from the drop/);
    expect(error(`analysis "x" {\n${fix}  shake: sine(10Hz, 500Hz, 1g)\n  duration: 1h\n  cycles: 1e6\n}`)).toMatch(/not both/);
  });

  it("reports the worst frequency, the stress there and how long it lasts", () => {
    const s = spec(`analysis "Shaker" {\n  fix: face(bracket, -X)\n  shake: sine(20Hz, 400Hz, 1g, Z)\n  modes: 6\n}`);
    const r = runStructural(input({ shake: { lo: 20, hi: 400, accel: 1, dir: [0, 0, 1] }, damping: 0.02 }));
    const t = shakingText(s, r)!;
    expect(t.title).toMatch(/^Shaking: Shaker: worst at 1\d\d Hz$/);
    expect(t.detail).toMatch(/shaken at 1 g \(peak\) along \+Z/);
    expect(t.detail).toMatch(/Modes inside the band: 1 \(/);
    expect(t.detail).toMatch(/times as far as the same acceleration held still/);
    expect(t.detail).toMatch(/fatigue strength of Steel \(mild, S275\) for 1×10⁷ cycles/);
    const items = dynamicItems(s, r, { basis: "simulation", span: s.span, parts: [] }, { status: "pass", note: "" });
    expect(items.map((i) => i.id)).toEqual(["fea:Shaker:modes", "fea:Shaker:shaking"]);
    const text = structuralSummary(s, { status: "done", result: r, resolution: "standard" });
    expect(text).toMatch(/Shaking: (PASS|WARN|FAIL)\./);
    expect(text).not.toMatch(/Reactions balance/);
  }, 60_000);
});
