// The analog circuit solver against hand calculations: dividers, RC and op-amp
// filters, diode clippers, the Fender tone stack's closed form, a regulator,
// input impedance, stiff switching, and a whole guitar preamp rendered at
// audio rate (with its timing targets).

import { describe, expect, it } from "vitest";
import { acImpedance, acTransfer, checkCircuit, dcOperatingPoint, logFreqs, transient } from "../src/machine/circuit/solver";
import type { Circuit, Element } from "../src/machine/circuit/types";

const TL072 = { a0: 2e5, gbw: 3e6, rout: 75, swing: [1.5, 1.5] as [number, number], iq: 1.4e-3 };
const NE5532 = { a0: 1e5, gbw: 10e6, rout: 30, swing: [1.0, 1.0] as [number, number], iq: 4e-3 };
const D1N4148 = { is: 2.52e-9, nf: 1.752, rs: 0.568 };
const LED_RED = { is: 1.8e-18, nf: 1.9, rs: 2 };
const D1N5819 = { is: 3e-5, nf: 1.0, rs: 0.05 };
const VT = (1.380649e-23 * 300) / 1.602176634e-19;

const deg = (rad: number) => (rad * 180) / Math.PI;
const sine = (n: number, fs: number, f: number, amp: number) => Float32Array.from({ length: n }, (_, k) => amp * Math.sin((2 * Math.PI * f * k) / fs));
/** Audio-taper pot: 10 % of the track at half rotation. */
const logPot = (r: number) => (Math.pow(81, r) - 1) / 80;

/** Least-squares fit of a + b·sin + c·cos at frequency f over y[from..]: amplitude and phase. */
function fitSine(y: Float32Array, f: number, fs: number, from: number) {
  let ss = 0, sc = 0, cc = 0, s1 = 0, c1 = 0, n = 0, ys = 0, yc = 0, y1 = 0;
  for (let k = from; k < y.length; k++) {
    const s = Math.sin((2 * Math.PI * f * k) / fs);
    const c = Math.cos((2 * Math.PI * f * k) / fs);
    ss += s * s;
    sc += s * c;
    cc += c * c;
    s1 += s;
    c1 += c;
    n++;
    ys += y[k] * s;
    yc += y[k] * c;
    y1 += y[k];
  }
  // solve the 3×3 normal equations [ss sc s1; sc cc c1; s1 c1 n] · [b c a] = [ys yc y1]
  const A = [
    [ss, sc, s1, ys],
    [sc, cc, c1, yc],
    [s1, c1, n, y1],
  ];
  for (let i = 0; i < 3; i++) {
    for (let r = i + 1; r < 3; r++) {
      const l = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= l * A[i][c];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = A[i][3];
    for (let c = i + 1; c < 3; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return { amp: Math.hypot(x[0], x[1]), phase: Math.atan2(x[1], x[0]), dc: x[2] };
}

function range(y: Float32Array, from = 0) {
  let lo = Infinity, hi = -Infinity;
  for (let k = from; k < y.length; k++) {
    lo = Math.min(lo, y[k]);
    hi = Math.max(hi, y[k]);
  }
  return { lo, hi };
}

describe("DC operating point", () => {
  it("solves a divider, with element currents and power", () => {
    const c: Circuit = {
      elements: [
        { k: "V", id: "V1", n: ["a", "0"], dc: 12 },
        { k: "R", id: "R1", n: ["a", "b"], r: 4.7e3 },
        { k: "R", id: "R2", n: ["b", "0"], r: 2.2e3 },
      ],
    };
    const op = dcOperatingPoint(c);
    expect(op.ok).toBe(true);
    const i = 12 / 6.9e3;
    expect(op.v.b).toBeCloseTo((12 * 2.2) / 6.9, 6);
    expect(op.v["0"]).toBe(0);
    expect(op.i.R1).toBeCloseTo(i, 9);
    expect(op.i.R2).toBeCloseTo(i, 9);
    // the source delivers i out of its + terminal, so the current into n[0] is −i
    expect(op.i.V1).toBeCloseTo(-i, 9);
    expect(op.p.R1).toBeCloseTo(i * i * 4.7e3, 8);
    expect(op.p.R2).toBeCloseTo(i * i * 2.2e3, 8);
    expect(op.p.V1).toBeCloseTo(-12 * i, 8);
    expect(op.p.R1 + op.p.R2 + op.p.V1).toBeCloseTo(0, 9);
  });

  it("drives a resistor from a current source", () => {
    const op = dcOperatingPoint({
      elements: [
        { k: "I", id: "I1", n: ["0", "a"], dc: 1e-3 },
        { k: "R", id: "R1", n: ["a", "0"], r: 2.2e3 },
      ],
    });
    expect(op.ok).toBe(true);
    expect(op.v.a).toBeCloseTo(2.2, 6);
    expect(op.i.I1).toBe(1e-3);
    expect(op.p.I1).toBeCloseTo(-2.2e-3, 9);
    expect(op.p.R1).toBeCloseTo(2.2e-3, 9);
  });

  it("biases diodes: LED, Schottky and zener against the Shockley equation", () => {
    const op = dcOperatingPoint({
      elements: [
        { k: "V", id: "V1", n: ["vcc", "0"], dc: 12 },
        { k: "R", id: "Rled", n: ["vcc", "led"], r: 1e3 },
        { k: "D", id: "LED", n: ["led", "0"], ...LED_RED },
        { k: "R", id: "Rs", n: ["vcc", "sch"], r: 120 },
        { k: "D", id: "D1", n: ["sch", "0"], ...D1N5819 },
        { k: "R", id: "Rz", n: ["vcc", "z"], r: 1e3 },
        { k: "D", id: "Z1", n: ["0", "z"], ...D1N4148, bv: 5.1, ibv: 1e-3 },
      ],
    });
    expect(op.ok).toBe(true);
    // v = n·Vt·ln(1 + i/is) + i·rs, with the current the solver found
    const drop = (i: number, d: { is: number; nf: number; rs: number }) => d.nf * VT * Math.log1p(i / d.is) + i * d.rs;
    expect(op.v.led).toBeCloseTo(drop(op.i.LED, LED_RED), 6);
    expect(op.v.led).toBeGreaterThan(1.75);
    expect(op.v.led).toBeLessThan(1.85);
    expect(op.i.LED).toBeCloseTo((12 - op.v.led) / 1e3, 9);
    expect(op.v.sch).toBeCloseTo(drop(op.i.D1, D1N5819), 6);
    expect(op.i.D1).toBeGreaterThan(0.09);
    // reverse breakdown: about bv, a little more at 6.9 mA than at ibv = 1 mA
    expect(op.v.z).toBeGreaterThan(5.1);
    expect(op.v.z).toBeLessThan(5.3);
    expect(-op.i.Z1).toBeCloseTo((12 - op.v.z) / 1e3, 6);
  });

  it("solves a VCVS and treats an inductor as a short", () => {
    const op = dcOperatingPoint({
      elements: [
        { k: "V", id: "V1", n: ["in", "0"], dc: 0.3 },
        { k: "E", id: "E1", n: ["out", "0", "in", "0"], gain: 10 },
        { k: "L", id: "L1", n: ["out", "x"], l: 1e-3 },
        { k: "R", id: "R1", n: ["x", "0"], r: 100 },
      ],
    });
    expect(op.ok).toBe(true);
    expect(op.v.out).toBeCloseTo(3, 9);
    expect(op.v.x).toBeCloseTo(3, 9);
    expect(op.i.L1).toBeCloseTo(0.03, 9);
  });

  it("reports why it can't solve, and gives up cleanly when Newton has no room", () => {
    const bad = dcOperatingPoint({
      elements: [
        { k: "V", id: "V1", n: ["a", "0"], dc: 1 },
        { k: "V", id: "V2", n: ["a", "0"], dc: 2 },
        { k: "R", id: "R1", n: ["a", "0"], r: 0 },
      ],
    });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/R1: resistance must be positive/);
    expect(bad.message).toMatch(/V2 closes a loop/);
    const starved = dcOperatingPoint({ elements: [{ k: "V", id: "V1", n: ["a", "0"], dc: 5 }, { k: "R", id: "R1", n: ["a", "b"], r: 1e3 }, { k: "D", id: "D1", n: ["b", "0"], ...D1N4148 }] }, { maxIter: 1 });
    expect(starved.ok).toBe(false);
    expect(starved.message).toMatch(/no operating point/);
  });
});

describe("checkCircuit", () => {
  it("passes a sound circuit and names each kind of problem", () => {
    expect(checkCircuit({ elements: [{ k: "V", id: "V1", n: ["a", "0"], dc: 1 }, { k: "R", id: "R1", n: ["a", "0"], r: 1 }] })).toEqual([]);
    const problems = checkCircuit({
      elements: [
        { k: "V", id: "V1", n: ["a", "0"], dc: 9 },
        { k: "V", id: "V2", n: ["b", "a"], dc: 1 },
        { k: "V", id: "V3", n: ["b", "0"], dc: 3 },
        { k: "C", id: "C1", n: ["a", "in"], c: 100e-9 },
        { k: "OA", id: "U1", n: ["in", "out", "out", "a", "0"], ...TL072 },
        { k: "C", id: "C2", n: ["out", "0"], c: -1 },
        { k: "R", id: "R1", n: ["a", "0"], r: 1e3 },
        { k: "R", id: "R1", n: ["a", "0"], r: 2e3 },
      ],
    });
    expect(problems).toContain("V3 closes a loop made only of voltage sources and inductors, which has no DC solution");
    expect(problems).toContain("C2: capacitance must be positive (got -1)");
    expect(problems.some((p) => p.includes('node "in" has no DC path to ground'))).toBe(true);
    expect(problems.some((p) => p.includes('"R1"'))).toBe(true);
    // the floating input still solves, held at 0 V, with the warning in the message
    const op = dcOperatingPoint({ elements: [{ k: "V", id: "V1", n: ["a", "0"], dc: 9 }, { k: "C", id: "C1", n: ["a", "in"], c: 100e-9 }, { k: "R", id: "R1", n: ["in", "x"], r: 1e3 }] });
    expect(op.ok).toBe(true);
    expect(op.message).toMatch(/no DC path/);
  });
});

describe("RC low-pass", () => {
  const R = 10e3;
  const C = 10e-9;
  const fc = 1 / (2 * Math.PI * R * C);
  const circuit: Circuit = {
    elements: [
      { k: "V", id: "Vin", n: ["in", "0"], dc: 0 },
      { k: "R", id: "R1", n: ["in", "out"], r: R },
      { k: "C", id: "C1", n: ["out", "0"], c: C },
    ],
  };

  it("is −3.01 dB and −45° at 1/(2πRC)", () => {
    const ac = acTransfer(circuit, { input: "Vin", out: "out", freqs: [fc / 100, fc, 10 * fc] });
    expect(ac.db[0]).toBeCloseTo(0, 3);
    expect(Math.abs(ac.db[1] + 3.0103)).toBeLessThan(0.05);
    expect(Math.abs(deg(ac.phase[1]) + 45)).toBeLessThan(0.1);
    expect(ac.db[2]).toBeCloseTo(-10 * Math.log10(101), 3);
  });

  it("settles to 0.707 of a sine at fc in the transient, with or without oversampling", () => {
    const fs = 48000;
    const n = Math.round(0.02 * fs);
    for (const oversample of [1, 4]) {
      const tr = transient(circuit, { fs, samples: n, inputs: { Vin: sine(n, fs, fc, 1) }, probes: ["out"], oversample });
      expect(tr.ok).toBe(true);
      expect(tr.nonConverged).toBe(0);
      const fit = fitSine(tr.out[0], fc, fs, n / 2);
      expect(Math.abs(fit.amp / Math.SQRT1_2 - 1)).toBeLessThan(0.01);
      expect(Math.abs(deg(fit.phase) + 45)).toBeLessThan(1);
    }
  });
});

describe("op-amp stages", () => {
  /** Non-inverting gain 11 on a 12 V single supply, biased at 6 V by a divider. */
  const nonInverting = (): Circuit => ({
    elements: [
      { k: "V", id: "Vcc", n: ["vcc", "0"], dc: 12 },
      { k: "R", id: "Rb1", n: ["vcc", "ref"], r: 10e3 },
      { k: "R", id: "Rb2", n: ["ref", "0"], r: 10e3 },
      { k: "C", id: "Cb", n: ["ref", "0"], c: 100e-6 },
      { k: "V", id: "Vin", n: ["src", "0"], dc: 0 },
      { k: "C", id: "Cin", n: ["src", "p"], c: 1e-6 },
      { k: "R", id: "Rbias", n: ["p", "ref"], r: 1e6 },
      { k: "OA", id: "U1", n: ["p", "m", "out", "vcc", "0"], ...TL072 },
      { k: "R", id: "Rf", n: ["out", "m"], r: 100e3 },
      { k: "R", id: "Rg", n: ["m", "ref"], r: 10e3 },
    ],
  });

  it("biases a single-supply non-inverting stage at 6 V with gain 1 + Rf/Rg", () => {
    const c = nonInverting();
    const op = dcOperatingPoint(c);
    expect(op.ok).toBe(true);
    expect(Math.abs(op.v.out - 6)).toBeLessThan(1e-3);
    expect(op.i["U1.supply"]).toBeCloseTo(TL072.iq, 6);
    expect(op.i.Vcc).toBeCloseTo(-(TL072.iq + 12 / 20e3), 6);
    const ac = acTransfer(c, { input: "Vin", out: "out", freqs: [1000], op });
    expect(Math.abs(Math.hypot(ac.h[0].re, ac.h[0].im) / 11 - 1)).toBeLessThan(0.005);
    // the gain-bandwidth product is there: −3 dB near 3 MHz / 11
    const hf = acTransfer(c, { input: "Vin", out: "out", freqs: [3e6 / 11], op });
    expect(hf.db[0]).toBeCloseTo(20 * Math.log10(11) - 3.01, 0);
  });

  it("clips cleanly at 10.5 V and 1.5 V and recovers at once", () => {
    const c = nonInverting();
    const fs = 48000;
    const n = Math.round(0.02 * fs);
    const f = 500;
    const vin = sine(n, fs, f, 1);
    const tr = transient(c, { fs, samples: n, inputs: { Vin: vin }, probes: ["out"] });
    expect(tr.ok).toBe(true);
    expect(tr.nonConverged).toBe(0);
    const y = tr.out[0];
    const { lo, hi } = range(y);
    expect(hi).toBeGreaterThan(10.4);
    expect(hi).toBeLessThanOrEqual(10.5);
    expect(lo).toBeLessThan(1.6);
    expect(lo).toBeGreaterThanOrEqual(1.5);
    expect(Math.abs(hi - 6 - (6 - lo))).toBeLessThan(0.01);
    // no spikes and no sticking: the output stays on 6 + 11·vin clipped to the swing,
    // off it only by the knee and a fraction of a sample's recovery. In the linear
    // range the 273 kHz closed-loop pole lags the steepest slope by about 20 mV.
    for (let k = 1; k < n; k++) {
      const ideal = 6 + 11 * vin[k];
      expect(Math.abs(y[k] - Math.min(10.5, Math.max(1.5, ideal)))).toBeLessThan(0.15);
      if (Math.abs(ideal - 6) < 3.5) expect(Math.abs(y[k] - ideal)).toBeLessThan(0.03);
    }
  });

  it("puts an inverting stage's corner at 1/(2π·Rf·Cf)", () => {
    const Rf = 220e3;
    const Cf = 1e-9;
    const c: Circuit = {
      elements: [
        { k: "V", id: "Vcc", n: ["vcc", "0"], dc: 12 },
        { k: "V", id: "Vref", n: ["ref", "0"], dc: 6 },
        { k: "V", id: "Vin", n: ["in", "ref"], dc: 0 },
        { k: "R", id: "Rin", n: ["in", "m"], r: 10e3 },
        { k: "R", id: "Rf", n: ["m", "out"], r: Rf },
        { k: "C", id: "Cf", n: ["m", "out"], c: Cf },
        { k: "OA", id: "U1", n: ["ref", "m", "out", "vcc", "0"], ...NE5532 },
      ],
    };
    const fc = 1 / (2 * Math.PI * Rf * Cf);
    const op = dcOperatingPoint(c);
    expect(op.v.out).toBeCloseTo(6, 4);
    const freqs = logFreqs(10, 100e3, 200);
    const ac = acTransfer(c, { input: "Vin", out: "out", freqs, op });
    const g0 = 20 * Math.log10(22);
    expect(ac.db[0]).toBeCloseTo(g0, 2);
    expect(Math.abs(deg(ac.phase[0]) - (180 - deg(Math.atan(freqs[0] / fc))))).toBeLessThan(0.05);
    // where the response crosses −3 dB, interpolated on the log axis
    const k = ac.db.findIndex((d) => d < g0 - 3.0103);
    const t = (g0 - 3.0103 - ac.db[k - 1]) / (ac.db[k] - ac.db[k - 1]);
    const f3 = freqs[k - 1] * Math.pow(freqs[k] / freqs[k - 1], t);
    expect(Math.abs(f3 / fc - 1)).toBeLessThan(0.01);
    const at = acTransfer(c, { input: "Vin", out: "out", freqs: [fc], op });
    expect(Math.abs(deg(at.phase[0]) - 135)).toBeLessThan(0.5);
  });
});

describe("diode clipping", () => {
  it("limits a 5 V sine to one 1N4148 drop, as the diode equation says", () => {
    const c: Circuit = {
      elements: [
        { k: "V", id: "Vin", n: ["in", "0"], dc: 0 },
        { k: "R", id: "R1", n: ["in", "out"], r: 1e3 },
        { k: "D", id: "D1", n: ["out", "0"], ...D1N4148 },
        { k: "D", id: "D2", n: ["0", "out"], ...D1N4148 },
      ],
    };
    const fs = 48000;
    const n = 480;
    const tr = transient(c, { fs, samples: n, inputs: { Vin: sine(n, fs, 1000, 5) }, probes: ["out"] });
    expect(tr.ok).toBe(true);
    expect(tr.nonConverged).toBe(0);
    const { lo, hi } = range(tr.out[0]);
    // at the crest (sample 12 is exactly 5 V): v + 1k·i = 5 with v = n·Vt·ln(1 + i/is) + i·rs
    let v = 0.6;
    for (let it = 0; it < 50; it++) {
      const i = (5 - v) / 1e3;
      v = D1N4148.nf * VT * Math.log1p(i / D1N4148.is) + i * D1N4148.rs;
    }
    expect(hi).toBeGreaterThan(0.6);
    expect(hi).toBeLessThan(0.75);
    expect(Math.abs(hi / v - 1)).toBeLessThan(0.002);
    expect(Math.abs(lo + hi)).toBeLessThan(1e-4);
  });

  it("soft-clips a Tube Screamer style stage about one diode drop above its input", () => {
    const tsStage = (drive: number): Circuit => ({
      elements: [
        { k: "V", id: "Vcc", n: ["vcc", "0"], dc: 9 },
        { k: "V", id: "Vref", n: ["ref", "0"], dc: 4.5 },
        { k: "V", id: "Vin", n: ["p", "ref"], dc: 0 },
        { k: "OA", id: "U1", n: ["p", "m", "out", "vcc", "0"], ...TL072 },
        { k: "R", id: "Rg", n: ["m", "g"], r: 4.7e3 },
        { k: "C", id: "Cg", n: ["g", "0"], c: 47e-9 },
        { k: "R", id: "R51", n: ["out", "f"], r: 51e3 },
        { k: "R", id: "Pdrive", n: ["f", "m"], r: Math.max(1, 500e3 * drive) },
        { k: "D", id: "D1", n: ["out", "m"], ...D1N4148 },
        { k: "D", id: "D2", n: ["m", "out"], ...D1N4148 },
      ],
    });
    const fs = 48000;
    const n = Math.round(0.03 * fs);
    const peaks: number[] = [];
    for (const amp of [0.2, 1]) {
      const vin = sine(n, fs, 1000, amp);
      const tr = transient(tsStage(1), { fs, samples: n, inputs: { Vin: vin }, probes: ["out", ["out", "m"]], oversample: 2 });
      expect(tr.ok).toBe(true);
      expect(tr.nonConverged).toBe(0);
      const { lo, hi } = range(tr.out[0], n / 2);
      // the diodes hold the feedback to a junction drop; the op-amp stays far from its rails
      const above = hi - 4.5 - amp;
      expect(above).toBeGreaterThan(0.35);
      expect(above).toBeLessThan(0.75);
      expect(Math.abs(hi - 4.5 - (4.5 - lo))).toBeLessThan(0.02);
      expect(hi).toBeLessThan(7);
      const fb = range(tr.out[1], n / 2);
      expect(fb.hi).toBeLessThan(0.7);
      peaks.push(above);
    }
    // soft: five times the input pushes the drop up only by a fraction of a volt
    expect(peaks[1]).toBeGreaterThan(peaks[0]);
    expect(peaks[1] - peaks[0]).toBeLessThan(0.15);
  });
});

describe("Fender Bassman tone stack", () => {
  const P = { C1: 250e-12, C2: 20e-9, C3: 20e-9, R1: 250e3, R2: 1e6, R3: 25e3, R4: 56e3 };
  type Knobs = { t: number; m: number; l: number };

  /** Yeh and Smith's closed form (DAFx 2006): third-order H(s) in the treble t, mid m and bass l positions. */
  function yeh(f: number, { t, m, l }: Knobs): number {
    const { C1, C2, C3, R1, R2, R3, R4 } = P;
    const C123 = C1 * C2 * C3;
    const b1 = t * C1 * R1 + m * C3 * R3 + l * (C1 * R2 + C2 * R2) + (C1 * R3 + C2 * R3);
    const b2 =
      t * (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4) -
      m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
      m * (C1 * C3 * R1 * R3 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
      l * (C1 * C2 * R1 * R2 + C1 * C2 * R2 * R4 + C1 * C3 * R2 * R4) +
      l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3) +
      (C1 * C2 * R1 * R3 + C1 * C2 * R3 * R4 + C1 * C3 * R3 * R4);
    const b3 =
      l * m * C123 * (R1 * R2 * R3 + R2 * R3 * R4) -
      m * m * C123 * (R1 * R3 * R3 + R3 * R3 * R4) +
      m * C123 * (R1 * R3 * R3 + R3 * R3 * R4) +
      t * C123 * R1 * R3 * R4 -
      t * m * C123 * R1 * R3 * R4 +
      t * l * C123 * R1 * R2 * R4;
    const a1 = C1 * R1 + C1 * R3 + C2 * R3 + C2 * R4 + C3 * R4 + m * C3 * R3 + l * (C1 * R2 + C2 * R2);
    const a2 =
      m * (C1 * C3 * R1 * R3 - C2 * C3 * R3 * R4 + C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
      l * m * (C1 * C3 * R2 * R3 + C2 * C3 * R2 * R3) -
      m * m * (C1 * C3 * R3 * R3 + C2 * C3 * R3 * R3) +
      l * (C1 * C2 * R2 * R4 + C1 * C2 * R1 * R2 + C1 * C3 * R2 * R4 + C2 * C3 * R2 * R4) +
      (C1 * C2 * R1 * R4 + C1 * C3 * R1 * R4 + C1 * C2 * R3 * R4 + C1 * C2 * R1 * R3 + C1 * C3 * R3 * R4 + C2 * C3 * R3 * R4);
    const a3 =
      l * m * C123 * (R1 * R2 * R3 + R2 * R3 * R4) -
      m * m * C123 * (R1 * R3 * R3 + R3 * R3 * R4) +
      m * C123 * (R3 * R3 * R4 + R1 * R3 * R3 - R1 * R3 * R4) +
      l * C123 * R1 * R2 * R4 +
      C123 * R1 * R3 * R4;
    const w = 2 * Math.PI * f;
    // s = jω
    const num = Math.hypot(-b2 * w * w, b1 * w - b3 * w * w * w);
    const den = Math.hypot(1 - a2 * w * w, a1 * w - a3 * w * w * w);
    return 20 * Math.log10(num / den);
  }

  /** Pot halves never quite reach zero ohms. */
  const half = (r: number) => Math.max(r, 1e-3);

  /**
   * Yeh's circuit: the mid pot is a real potentiometer, C3 on its wiper and
   * the bass pot on its top end, which is where the m² terms come from.
   */
  const yehStack = ({ t, m, l }: Knobs): Element[] => [
    { k: "V", id: "Vin", n: ["in", "0"], dc: 0 },
    { k: "R", id: "R4", n: ["in", "A"], r: P.R4 },
    { k: "C", id: "C1", n: ["in", "T"], c: P.C1 },
    { k: "R", id: "R1.a", n: ["T", "W"], r: half((1 - t) * P.R1) },
    { k: "R", id: "R1.b", n: ["W", "B"], r: half(t * P.R1) },
    { k: "C", id: "C2", n: ["A", "B"], c: P.C2 },
    { k: "R", id: "R2", n: ["B", "Mt"], r: half(l * P.R2) },
    { k: "C", id: "C3", n: ["A", "Mw"], c: P.C3 },
    { k: "R", id: "R3.a", n: ["Mt", "Mw"], r: half((1 - m) * P.R3) },
    { k: "R", id: "R3.b", n: ["Mw", "0"], r: half(m * P.R3) },
  ];
  /** The usual drawing: bass and mid pots both as variable resistors, C3 on their junction. */
  const rheostatStack = ({ t, m, l }: Knobs): Element[] => [
    { k: "V", id: "Vin", n: ["in", "0"], dc: 0 },
    { k: "R", id: "R4", n: ["in", "A"], r: P.R4 },
    { k: "C", id: "C1", n: ["in", "T"], c: P.C1 },
    { k: "R", id: "R1.a", n: ["T", "W"], r: half((1 - t) * P.R1) },
    { k: "R", id: "R1.b", n: ["W", "B"], r: half(t * P.R1) },
    { k: "C", id: "C2", n: ["A", "B"], c: P.C2 },
    { k: "R", id: "R2", n: ["B", "M"], r: half(l * P.R2) },
    { k: "C", id: "C3", n: ["A", "M"], c: P.C3 },
    { k: "R", id: "R3", n: ["M", "0"], r: half(m * P.R3) },
  ];

  /** Independent check: dense complex nodal solve of an R/C network driven by 1 V at "in". */
  function nodal(els: Element[], out: string, f: number): number {
    const names = [...new Set(els.flatMap((e) => e.n))].filter((nm) => nm !== "0" && nm !== "in");
    const ix = new Map(names.map((nm, i) => [nm, i]));
    const N = names.length;
    const re = Array.from({ length: N }, () => new Array(N + 1).fill(0));
    const im = Array.from({ length: N }, () => new Array(N + 1).fill(0));
    const w = 2 * Math.PI * f;
    for (const e of els) {
      if (e.k !== "R" && e.k !== "C") continue;
      const [yr, yi] = e.k === "R" ? [1 / e.r, 0] : [0, w * e.c];
      const [a, b] = e.n;
      for (const [p, q] of [
        [a, b],
        [b, a],
      ]) {
        const i = ix.get(p);
        if (i === undefined) continue;
        re[i][i] += yr;
        im[i][i] += yi;
        const j = ix.get(q);
        if (j !== undefined) {
          re[i][j] -= yr;
          im[i][j] -= yi;
        } else if (q === "in") {
          re[i][N] += yr;
          im[i][N] += yi;
        }
      }
    }
    for (let k = 0; k < N; k++) {
      let p = k;
      for (let r = k + 1; r < N; r++) if (Math.hypot(re[r][k], im[r][k]) > Math.hypot(re[p][k], im[p][k])) p = r;
      [re[k], re[p]] = [re[p], re[k]];
      [im[k], im[p]] = [im[p], im[k]];
      const d = re[k][k] ** 2 + im[k][k] ** 2;
      for (let r = k + 1; r < N; r++) {
        const lr = (re[r][k] * re[k][k] + im[r][k] * im[k][k]) / d;
        const li = (im[r][k] * re[k][k] - re[r][k] * im[k][k]) / d;
        for (let c = k; c <= N; c++) {
          const ar = re[k][c];
          const ai = im[k][c];
          re[r][c] -= lr * ar - li * ai;
          im[r][c] -= lr * ai + li * ar;
        }
      }
    }
    const xr = new Array(N).fill(0);
    const xi = new Array(N).fill(0);
    for (let k = N - 1; k >= 0; k--) {
      let sr = re[k][N];
      let si = im[k][N];
      for (let c = k + 1; c < N; c++) {
        sr -= re[k][c] * xr[c] - im[k][c] * xi[c];
        si -= re[k][c] * xi[c] + im[k][c] * xr[c];
      }
      const d = re[k][k] ** 2 + im[k][k] ** 2;
      xr[k] = (sr * re[k][k] + si * im[k][k]) / d;
      xi[k] = (si * re[k][k] - sr * im[k][k]) / d;
    }
    const o = ix.get(out)!;
    return 20 * Math.log10(Math.hypot(xr[o], xi[o]));
  }

  const settings: Knobs[] = [
    { t: 0.5, m: 0.5, l: 0.5 },
    { t: 1, m: 0, l: 0 },
    { t: 0, m: 1, l: 1 },
    { t: 0.2, m: 0.8, l: 0.1 },
    { t: 0.9, m: 0.1, l: 0.9 },
  ];
  const freqs = logFreqs(20, 20000, 30);

  it("matches Yeh and Smith's transfer function to 0.1 dB from 20 Hz to 20 kHz", () => {
    for (const k of settings) {
      const ac = acTransfer({ elements: yehStack(k) }, { input: "Vin", out: "W", freqs });
      for (let i = 0; i < freqs.length; i++) expect(Math.abs(ac.db[i] - yeh(freqs[i], k))).toBeLessThan(0.1);
    }
  });

  it("matches a direct nodal solve with the pots drawn as variable resistors, and Yeh at full mid", () => {
    for (const k of settings) {
      const els = rheostatStack(k);
      const ac = acTransfer({ elements: els }, { input: "Vin", out: "W", freqs });
      for (let i = 0; i < freqs.length; i++) expect(Math.abs(ac.db[i] - nodal(els, "W", freqs[i]))).toBeLessThan(1e-3);
    }
    const full = { t: 0.5, m: 1, l: 0.5 };
    const ac = acTransfer({ elements: rheostatStack(full) }, { input: "Vin", out: "W", freqs });
    for (let i = 0; i < freqs.length; i++) expect(Math.abs(ac.db[i] - yeh(freqs[i], full))).toBeLessThan(0.1);
  });
});

describe("7812 regulator", () => {
  const reg = (vin: number, load: number): Circuit => ({
    elements: [
      { k: "V", id: "Vin", n: ["in", "0"], dc: vin },
      { k: "REG", id: "U1", n: ["in", "0", "out"], vout: 12, dropout: 2, ilim: 1.5, iq: 5e-3, rout: 0.01 },
      { k: "R", id: "Rload", n: ["out", "0"], r: load },
    ],
  });

  it("regulates 24 V down to 12 V at 45 mA and dissipates the difference", () => {
    const op = dcOperatingPoint(reg(24, 12 / 0.045));
    expect(op.ok).toBe(true);
    expect(Math.abs(op.v.out - 12)).toBeLessThan(2e-3);
    expect(-op.i.U1).toBeCloseTo(0.045, 4);
    expect(op.i["U1.in"]).toBeCloseTo(0.05, 4);
    expect(op.i.Vin).toBeCloseTo(-0.05, 4);
    const expected = (24 - 12) * 0.045 + 24 * 5e-3;
    expect(Math.abs(op.p.U1 / expected - 1)).toBeLessThan(0.01);
    // everything the source delivers ends up in the regulator and the load
    expect(op.p.U1 + op.p.Rload + op.p.Vin).toBeCloseTo(0, 6);
  });

  it("drops out with 13 V in and limits its current into a short", () => {
    const low = dcOperatingPoint(reg(13, 12 / 0.045));
    expect(low.ok).toBe(true);
    expect(Math.abs(low.v.out - 11)).toBeLessThan(0.02);
    const short = dcOperatingPoint(reg(24, 1));
    expect(short.ok).toBe(true);
    expect(Math.abs(-short.i.U1 / 1.5 - 1)).toBeLessThan(0.01);
  });
});

describe("acImpedance", () => {
  const follower: Circuit = {
    elements: [
      { k: "V", id: "Vcc", n: ["vcc", "0"], dc: 12 },
      { k: "R", id: "Rb1", n: ["vcc", "ref"], r: 10e3 },
      { k: "R", id: "Rb2", n: ["ref", "0"], r: 10e3 },
      { k: "C", id: "Cb", n: ["ref", "0"], c: 100e-6 },
      { k: "C", id: "Cin", n: ["jack", "p"], c: 100e-9 },
      { k: "R", id: "Rbias", n: ["p", "ref"], r: 1e6 },
      { k: "OA", id: "U1", n: ["p", "out", "out", "vcc", "0"], ...TL072 },
    ],
  };

  it("sees the 1 MΩ bias resistor behind the coupling capacitor", () => {
    const z = acImpedance(follower, { node: "jack", freqs: [1000] }).h[0];
    expect(Math.abs(z.re / 1e6 - 1)).toBeLessThan(0.01);
    expect(Math.abs(z.im / (-1 / (2 * Math.PI * 1000 * 100e-9)) - 1)).toBeLessThan(0.01);
  });

  it("sees a follower's output resistance divided by its loop gain", () => {
    const z = acImpedance(follower, { node: "out", freqs: [1000] }).h[0];
    // rout / (1 + A), with |A| = gbw / f at 1 kHz
    expect(Math.abs(Math.hypot(z.re, z.im) / ((TL072.rout * 1000) / TL072.gbw) - 1)).toBeLessThan(0.05);
  });
});

describe("transient details", () => {
  it("damps a capacitor discharging through a stiff switch within a few samples", () => {
    const fs = 48000;
    const n = 400;
    const ctl = Float32Array.from({ length: n }, (_, k) => (k >= 100 ? 2 : 0));
    const tr = transient(
      {
        elements: [
          { k: "V", id: "V1", n: ["a", "0"], dc: 5 },
          { k: "R", id: "R1", n: ["a", "c"], r: 10e3 },
          { k: "C", id: "C1", n: ["c", "0"], c: 1e-6 },
          { k: "V", id: "Vctl", n: ["ctl", "0"], dc: 0 },
          { k: "SW", id: "S1", n: ["c", "0", "ctl", "0"], ron: 1, roff: 1e9, von: 1, voff: 0 },
        ],
      },
      { fs, samples: n, inputs: { Vctl: ctl }, probes: ["c"] },
    );
    expect(tr.ok).toBe(true);
    const y = tr.out[0];
    expect(y[99]).toBeCloseTo(5, 3);
    // RC is 1 µs against a 21 µs step. The trapezoidal rule would flip the error's
    // sign and keep 82 % of it every step; TR-BDF2 leaves a small overshoot that dies at once.
    const floor = 5 / 10001;
    const err = (k: number) => Math.abs(y[k] - floor);
    expect(err(100)).toBeLessThan(0.05);
    for (let k = 100; k < 105; k++) expect(err(k + 1)).toBeLessThan(0.25 * err(k));
    for (let k = 106; k < n; k++) expect(err(k)).toBeLessThan(1e-6);
  });

  it("follows an RL step with the right time constant", () => {
    const L = 10e-3;
    const R = 100;
    const fs = 48000;
    const n = 48;
    const step = new Float32Array(n).fill(1);
    const circuit: Circuit = {
      elements: [
        { k: "V", id: "Vin", n: ["in", "0"], dc: 0 },
        { k: "L", id: "L1", n: ["in", "x"], l: L },
        { k: "R", id: "R1", n: ["x", "0"], r: R },
      ],
    };
    // the input ramps from 0 to 1 V over the sample before t = 0 and then holds:
    // v = 1 − (τ/T)·e^(−t/τ)·(1 − e^(−T/τ)) for t ≥ 0
    const tau = L / R;
    const T = 1 / fs;
    const exact = (k: number) => 1 - (tau / T) * Math.exp(-k / fs / tau) * (1 - Math.exp(-T / tau));
    // τ is under five samples here, so one step per sample is a real test of the integrator
    const plain = transient(circuit, { fs, samples: n, inputs: { Vin: step }, probes: ["x"] });
    for (let k = 0; k < n; k++) expect(Math.abs(plain.out[0][k] - exact(k))).toBeLessThan(2e-3);
    // oversampled output is band-limited, which rounds the ramp's corners; past the
    // decimation filter's reach (18 samples) only the integration error is left
    const fine = transient(circuit, { fs, samples: n, inputs: { Vin: step }, probes: ["x"], oversample: 4 });
    for (let k = 20; k < n; k++) expect(Math.abs(fine.out[0][k] - exact(k))).toBeLessThan(2e-4);
  });

  it("starts from a given operating point without a thump, even one that went through JSON", () => {
    const c = { elements: preamp() };
    const op = dcOperatingPoint(c);
    const n = 2000;
    for (const start of [op, JSON.parse(JSON.stringify(op))]) {
      const tr = transient(c, { fs: 48000, samples: n, probes: ["out", "gout"], op: start });
      expect(tr.ok).toBe(true);
      const { lo, hi } = range(tr.out[0]);
      expect(Math.max(Math.abs(lo), Math.abs(hi))).toBeLessThan(1e-6);
      expect(Math.abs(tr.out[1][n - 1] - op.v.gout)).toBeLessThan(1e-6);
    }
  });

  it("starts capacitors at their ic when it finds its own operating point", () => {
    const tr = transient(
      {
        elements: [
          { k: "C", id: "C1", n: ["a", "0"], c: 1e-6, ic: 2 },
          { k: "R", id: "R1", n: ["a", "0"], r: 1e3 },
        ],
      },
      { fs: 48000, samples: 96, probes: ["a"], oversample: 4 },
    );
    expect(tr.ok).toBe(true);
    // RC = 1 ms; sample k is (k + 1) / fs after the start
    for (const k of [0, 47, 95]) expect(Math.abs(tr.out[0][k] - 2 * Math.exp(-(k + 1) / 48000 / 1e-3))).toBeLessThan(1e-3);
  });

  it("band-limits oversampled output so clipping harmonics don't alias", () => {
    // a hard diode clipper at a frequency whose aliases fall between its harmonics
    const c: Circuit = {
      elements: [
        { k: "V", id: "Vin", n: ["in", "0"], dc: 0 },
        { k: "R", id: "R1", n: ["in", "out"], r: 2.2e3 },
        { k: "D", id: "D1", n: ["out", "0"], ...D1N4148 },
        { k: "D", id: "D2", n: ["0", "out"], ...D1N4148 },
      ],
    };
    const fs = 48000;
    const n = Math.round(0.05 * fs);
    const f0 = 1234.5;
    const vin = sine(n, fs, f0, 5);
    /** Energy left after fitting dc and every harmonic below Nyquist, relative to the signal. */
    const inharmonic = (y: Float32Array) => {
      const from = n / 4;
      const H: number[] = [];
      for (let h = 1; h * f0 < fs / 2; h++) H.push(h * f0);
      const m = 1 + 2 * H.length;
      const A = Array.from({ length: m }, () => new Float64Array(m + 1));
      const basis = (k: number, out: Float64Array) => {
        out[0] = 1;
        H.forEach((f, i) => {
          out[1 + 2 * i] = Math.sin((2 * Math.PI * f * k) / fs);
          out[2 + 2 * i] = Math.cos((2 * Math.PI * f * k) / fs);
        });
      };
      const row = new Float64Array(m);
      for (let k = from; k < n; k++) {
        basis(k, row);
        for (let i = 0; i < m; i++) {
          for (let j = 0; j < m; j++) A[i][j] += row[i] * row[j];
          A[i][m] += row[i] * y[k];
        }
      }
      for (let i = 0; i < m; i++) {
        for (let r = 0; r < m; r++) {
          if (r === i) continue;
          const l = A[r][i] / A[i][i];
          for (let col = i; col <= m; col++) A[r][col] -= l * A[i][col];
        }
      }
      const coef = A.map((r, i) => r[m] / r[i]);
      let res = 0;
      let sig = 0;
      for (let k = from; k < n; k++) {
        basis(k, row);
        let fit = 0;
        for (let i = 0; i < m; i++) fit += coef[i] * row[i];
        res += (y[k] - fit) ** 2;
        sig += (y[k] - coef[0]) ** 2;
      }
      return 10 * Math.log10(res / sig);
    };
    const db = [1, 4].map((oversample) => inharmonic(transient(c, { fs, samples: n, inputs: { Vin: vin }, probes: ["out"], oversample }).out[0]));
    expect(db[0]).toBeGreaterThan(-50);
    expect(db[1]).toBeLessThan(db[0] - 20);
  });

  it("reports bad probes and inputs instead of throwing", () => {
    const c: Circuit = { elements: [{ k: "V", id: "V1", n: ["a", "0"], dc: 1 }, { k: "R", id: "R1", n: ["a", "0"], r: 1 }] };
    expect(transient(c, { fs: 48000, samples: 10, probes: ["nope"] }).message).toMatch(/unknown node "nope"/);
    expect(transient(c, { fs: 48000, samples: 10, probes: ["a"], inputs: { R1: [1] } }).message).toMatch(/no voltage or current source "R1"/);
  });
});

it("spaces logFreqs evenly per decade with both ends included", () => {
  const f = logFreqs(20, 20000, 10);
  expect(f.length).toBe(31);
  expect(f[0]).toBe(20);
  expect(f[30]).toBe(20000);
  expect(f[10]).toBeCloseTo(200, 9);
});

// ---------------------------------------------------------------------------
// a whole preamp

/**
 * Buffer, diode-clipping gain stage, low-pass, Marshall tone stack, recovery
 * stage and volume, plus a tuner tap, on one 12 V supply with a 6 V reference.
 * Pots are pairs of resistors named <pot>.a (top to wiper) and <pot>.b.
 */
function preamp(): Element[] {
  const e: Element[] = [];
  const R = (id: string, a: string, b: string, r: number) => e.push({ k: "R", id, n: [a, b], r });
  const C = (id: string, a: string, b: string, c: number) => e.push({ k: "C", id, n: [a, b], c });
  const D = (id: string, a: string, b: string) => e.push({ k: "D", id, n: [a, b], ...D1N4148 });
  const U = (id: string, p: string, m: string, o: string) => e.push({ k: "OA", id, n: [p, m, o, "vcc", "0"], ...TL072 });
  e.push({ k: "V", id: "Vcc", n: ["vcc", "0"], dc: 12 });
  R("Rref1", "vcc", "vref", 10e3);
  R("Rref2", "vref", "0", 10e3);
  C("Cref", "vref", "0", 100e-6);
  // input and buffer
  e.push({ k: "V", id: "Vin", n: ["src", "0"], dc: 0 });
  R("Rin", "src", "n1", 1e3);
  C("Cin", "n1", "bin", 100e-9);
  R("Rbias", "bin", "vref", 1e6);
  U("U1", "bin", "buf", "buf");
  // gain stage: 4.7k + 500k log pot at half, 100 pF and diode strings (2 one way, 3 the other) across it
  U("U2", "buf", "gm", "gout");
  R("Rg", "gm", "grc", 4.7e3);
  C("Cg", "grc", "0", 330e-9);
  R("Rf", "gout", "gfb", 4.7e3);
  R("Pgain", "gfb", "gm", 500e3 * logPot(0.5));
  C("Cf", "gout", "gm", 100e-12);
  D("D1", "gout", "d1");
  D("D2", "d1", "gm");
  D("D3", "gm", "d3");
  D("D4", "d3", "d4");
  D("D5", "d4", "gout");
  R("Rlp", "gout", "lp", 2.2e3);
  C("Clp", "lp", "0", 10e-9);
  // Marshall tone stack, its ground side on the reference
  R("Rslope", "lp", "A", 33e3);
  C("Ctreb", "lp", "T", 470e-12);
  R("Ptreb.a", "T", "W", 250e3 * 0.5);
  R("Ptreb.b", "W", "B", 250e3 * 0.5);
  C("Cbass", "A", "B", 22e-9);
  R("Pbass", "B", "M", 1e6 * 0.5);
  C("Cmid", "A", "M", 22e-9);
  R("Pmid", "M", "vref", 25e3 * 0.5);
  // recovery stage, gain 11
  U("U3", "W", "rm", "rout");
  R("Rr1", "rout", "rm", 100e3);
  R("Rr2", "rm", "rc", 10e3);
  C("Cr2", "rc", "0", 10e-6);
  C("Cr1", "rout", "rm", 100e-12);
  // output and volume
  C("Cout", "rout", "o1", 2.2e-6);
  R("Rout", "o1", "o2", 2.2e3);
  const vol = logPot(0.7);
  R("Pvol.a", "o2", "out", 10e3 * (1 - vol));
  R("Pvol.b", "out", "0", 10e3 * vol);
  R("Rload", "out", "0", 20e3);
  // tuner tap: inverting gain −22
  C("Ct1", "buf", "t1", 100e-9);
  R("Rt1", "t1", "tm", 10e3);
  R("Rt2", "tm", "tout", 220e3);
  C("Ct2", "tm", "tout", 1e-9);
  U("U4", "vref", "tm", "tout");
  return e;
}

/** A plucked string: decaying harmonics of 110 Hz, re-plucked every 0.75 s, `peak` volts at most. */
function guitar(fs: number, n: number, peak = 0.3): Float32Array {
  const w = new Float32Array(n);
  const period = Math.round(0.75 * fs);
  for (let k = 0; k < n; k++) {
    const t = (k % period) / fs;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += (1 / h) * Math.exp((-t * h) / 0.6) * Math.sin(2 * Math.PI * 110 * h * t);
    w[k] = s;
  }
  let m = 0;
  for (const v of w) m = Math.max(m, Math.abs(v));
  for (let k = 0; k < n; k++) w[k] *= peak / m;
  return w;
}

describe("guitar preamp", () => {
  const c: Circuit = { elements: preamp(), title: "preamp" };

  it("biases every stage at the 6 V reference and draws the supply current it should", () => {
    expect(checkCircuit(c)).toEqual([]);
    const op = dcOperatingPoint(c);
    expect(op.ok).toBe(true);
    expect(op.v.vref).toBeCloseTo(6, 4);
    for (const nd of ["buf", "gout", "rout", "tout", "W"]) expect(Math.abs(op.v[nd] - 6)).toBeLessThan(1e-3);
    expect(Math.abs(op.v.out)).toBeLessThan(1e-6);
    expect(op.i.Vcc).toBeCloseTo(-(4 * TL072.iq + 12 / 20e3), 5);
    // a gain stage at 1 kHz: buffer × (1 + 54.7k / 4.7k) × tone stack × 11 × volume
    const ac = acTransfer(c, { input: "Vin", out: "out", freqs: [1000], op });
    expect(ac.db[0]).toBeGreaterThan(10);
    expect(ac.db[0]).toBeLessThan(30);
  });

  it("renders a plucked string with no failed steps, matching an oversampled render", () => {
    const fs = 48000;
    const n = Math.round(0.3 * fs);
    const inputs = { Vin: guitar(fs, n) };
    const probes = ["out", "gout"];
    const tr = transient(c, { fs, samples: n, inputs, probes });
    expect(tr.ok).toBe(true);
    expect(tr.nonConverged).toBe(0);
    const g = range(tr.out[1]);
    // the diode strings hold the gain stage to about 2 and 3 junction drops either side of 6 V
    expect(g.hi - 6).toBeGreaterThan(0.8);
    expect(g.hi - 6).toBeLessThan(1.5);
    expect(6 - g.lo).toBeGreaterThan(1.1);
    expect(6 - g.lo).toBeLessThan(2.1);
    const fine = transient(c, { fs, samples: n, inputs, probes, oversample: 4 });
    let err = 0;
    let sig = 0;
    for (let k = 0; k < n; k++) {
      err += (tr.out[0][k] - fine.out[0][k]) ** 2;
      sig += fine.out[0][k] ** 2;
    }
    expect(Math.sqrt(sig / n)).toBeGreaterThan(0.05);
    expect(10 * Math.log10(err / sig)).toBeLessThan(-60);
  });

  describe.skipIf(process.env.KERF_SKIP_PERF === "1")("timing (set KERF_SKIP_PERF=1 to skip on slow machines)", () => {
    it("finds the operating point and a 60-point AC sweep in under 20 ms", () => {
      const freqs = logFreqs(20, 20000, 20).slice(0, 60);
      const times: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        const op = dcOperatingPoint(c);
        acTransfer(c, { input: "Vin", out: "out", freqs, op });
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      console.log(`preamp DC + 60-point AC: first ${times[4].toFixed(1)} ms, median ${times[2].toFixed(2)} ms`);
      expect(freqs.length).toBe(60);
      expect(times[2]).toBeLessThan(20);
    });

    it("renders 3 s at 48 kHz in under 4 s", () => {
      const fs = 48000;
      const n = 3 * fs;
      const inputs = { Vin: guitar(fs, n) };
      const op = dcOperatingPoint(c);
      const t0 = performance.now();
      const tr = transient(c, { fs, samples: n, inputs, probes: ["out", "tout"], op });
      const dt = performance.now() - t0;
      console.log(`preamp transient: ${n} samples in ${dt.toFixed(0)} ms (${((dt / n) * 1000).toFixed(2)} µs per sample), ${tr.nonConverged} unconverged`);
      expect(tr.ok).toBe(true);
      expect(dt).toBeLessThan(4000);
    });
  });
});
