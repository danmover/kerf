// The Practice Amp is the acceptance test for audio designs: its circuit has
// to bias and sound right in the simulator, its board has to place and route
// cleanly, the tuner has to read the right note through the simulated analog
// path, and the whole design has to pass every check with its geometry built.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "../src/lang/evaluator";
import { designCircuit } from "../src/machine/circuit/netlist";
import { adcNodes, circuitChecks, preampFigures, responseDb, stageSwing } from "../src/machine/circuit/analysis";
import { dcOperatingPoint, transient } from "../src/machine/circuit/solver";
import { boardSpecs } from "../src/machine/boards";
import { checkPlacement, routeBoard } from "../src/machine/pcb";
import { generateFirmware } from "../src/machine/firmware";
import { wireList } from "../src/machine/wiring";
import { BRIEFS, scoreBrief } from "../src/machine/briefs";
import { guitarTake, stringNote, STRINGS } from "../src/machine/audio/guitar";
import { ADC_RATE, adcCodes, noteOf, tunerReading, yin } from "../src/machine/audio/pitch";
import { fullCheck, problems } from "./helpers/fullcheck";

const AMP = readFileSync(join(__dirname, "../src/demos/practice-amp.kerf"), "utf8");
const model = evaluate(AMP, { skipGeometry: true });
const m = model.machine!;

describe("Practice Amp design", () => {
  it("evaluates without errors and meets every requirement", () => {
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const failing = model.requirements.filter((r) => r.status !== "pass").map((r) => `${r.label}: ${r.detail ?? r.status}`);
    expect(failing).toEqual([]);
    expect(model.requirements.length).toBeGreaterThanOrEqual(10);
  });

  it("covers every use in its brief with a requirement", () => {
    for (const u of model.brief!.uses) expect(model.requirements.some((r) => r.uses.includes(u.id)), u.id).toBe(true);
  });

  it("wires only the cables to the board's terminals: the board's copper is not a wire", () => {
    const rows = wireList(m);
    expect(rows.length).toBe(14);
    const onBoard = new Set(m.components.filter((c) => c.pcb && !/^j_/.test(c.name)).map((c) => c.name));
    for (const r of rows) for (const e of [r.from, r.to]) expect(onBoard.has(e.comp), `${r.id} lands on ${e.comp}`).toBe(false);
  });
});

describe("Practice Amp circuit", () => {
  const dc = designCircuit(m);
  const op = dcOperatingPoint(dc.circuit);

  it("finds the guitar input, the power amp and a steady operating point", () => {
    expect(dc.input?.node).toBe("TIP");
    expect(dc.output?.kind).toBe("amplifier");
    expect(op.ok).toBe(true);
    expect(op.v.V12).toBeCloseTo(12, 1);
    expect(op.v.V5).toBeCloseTo(5, 1);
  });

  it("biases every op-amp output at half the 12 V rail", () => {
    for (const o of dc.opamps) {
      const e = dc.circuit.elements.find((x) => x.id === o.id)!;
      expect(op.v[e.n[2]!], o.id).toBeGreaterThan(5.5);
      expect(op.v[e.n[2]!], o.id).toBeLessThan(6.5);
    }
  });

  it("passes its own circuit checks", () => {
    const items = circuitChecks(m);
    expect(items.filter((i) => i.status !== "pass").map((i) => i.title)).toEqual([]);
    expect(items.some((i) => i.id === "circuit:bias")).toBe(true);
  });

  it("turns each knob the right way: clockwise is more", () => {
    const base = { gain: 0, bass: 0.5, mid: 0.5, treble: 0.5, master: 1 };
    for (const [k, f] of [["gain", 1000], ["bass", 100], ["mid", 600], ["treble", 4000], ["master", 1000]] as const) {
      const lo = responseDb(m, { ...base, [k]: 0 }, [f], op)![0];
      const hi = responseDb(m, { ...base, [k]: 1 }, [f], op)![0];
      expect(hi - lo, k).toBeGreaterThan(3);
    }
  });

  it("gives clean to overdriven gain, audible tone controls and a high input impedance", () => {
    const f = preampFigures(m, 0.3);
    expect(f.ok).toBe(true);
    expect(f.gain_max_db - f.gain_min_db).toBeGreaterThan(25);
    expect(f.bass_db).toBeGreaterThan(6);
    expect(f.mid_db).toBeGreaterThan(3);
    expect(f.treble_db).toBeGreaterThan(6);
    expect(f.input_kohm).toBeGreaterThan(500);
    expect(f.headroom).toBeGreaterThan(1.2);
    expect(f.tuner_pp).toBeGreaterThan(0.2);
  });

  it("clips in the drive stage only, with gain and tone full up", () => {
    const st = stageSwing(m, { gain: 1, bass: 1, mid: 1, treble: 1, master: 1 }, 0.3, 196, op);
    expect(st.filter((s) => s.clips).map((s) => s.label)).toEqual(["U1B"]);
    for (const s of st.filter((x) => !x.clips && !x.sensing)) expect(s.use, s.label).toBeLessThan(0.85);
  });

  it("plays a guitar take through the whole circuit without the solver losing its way", () => {
    const fs = 32000;
    const wave = guitarTake("riff", fs, 0.3, 0.4);
    const r = transient(dc.circuit, { fs, samples: wave.length, inputs: { guitar: wave }, probes: [dc.output!.node], op, oversample: 2 });
    expect(r.ok).toBe(true);
    expect(r.nonConverged).toBe(0);
    let pk = 0;
    for (const v of r.out[0]) pk = Math.max(pk, Math.abs(v));
    expect(pk).toBeGreaterThan(0.05);
    expect(pk).toBeLessThan(6);
  });

  it("feeds the tuner a signal it reads within a cent, through the simulated analog path", { timeout: 30_000 }, () => {
    const adc = adcNodes(dc, m)[0];
    expect(adc).toBe("ADC");
    const fs = 32000;
    for (const [i, cents] of [[0, -20], [3, 33], [5, 7]] as const) {
      const wave = stringNote(STRINGS[i].hz, cents, fs, 0.12, 0.45);
      const r = transient(dc.circuit, { fs, samples: wave.length, inputs: { guitar: wave }, probes: [adc], op, oversample: 2 });
      const codes = adcCodes(r.out[0], fs);
      const start = Math.round(0.2 * ADC_RATE);
      const rd = tunerReading(codes.slice(start, start + 1024))!;
      expect(rd.note + rd.octave, STRINGS[i].name).toBe(STRINGS[i].name);
      expect(Math.abs(rd.cents - cents), STRINGS[i].name).toBeLessThan(1);
    }
  });
});

describe("pitch reading", () => {
  it("names notes and cents against the reference", () => {
    expect(noteOf(440)).toMatchObject({ note: "A", octave: 4 });
    expect(noteOf(82.41).note + noteOf(82.41).octave).toBe("E2");
    expect(noteOf(446).cents).toBeCloseTo(1200 * Math.log2(446 / 440), 6);
    expect(noteOf(432, 432).cents).toBeCloseTo(0, 6);
  });
  it("finds the period of a sampled waveform and nothing in silence", () => {
    const x = Float64Array.from({ length: 1024 }, (_, i) => Math.sin((2 * Math.PI * 110 * i) / ADC_RATE) + 0.5 * Math.sin((4 * Math.PI * 110 * i) / ADC_RATE));
    expect(1200 * Math.log2(yin(x, ADC_RATE)!.hz / 110)).toBeLessThan(2);
    expect(yin(new Float64Array(1024), ADC_RATE)).toBeUndefined();
  });
});

describe("Practice Amp board", () => {
  const [{ spec }] = boardSpecs(m);

  it("places every part without overlaps", () => {
    expect(spec.parts.length).toBeGreaterThan(50);
    expect(checkPlacement(spec).map((d) => d.message)).toEqual([]);
  });

  it("routes every connection on two layers with a clean rule check", { timeout: 30_000 }, () => {
    const b = routeBoard(spec);
    expect(b.unrouted).toEqual([]);
    expect(b.drc.map((d) => d.message)).toEqual([]);
    expect(b.pours.length).toBeGreaterThan(0);
  });
});

describe("Practice Amp firmware", () => {
  it("generates the tuner sketch on the pins the board wires", () => {
    const [fw] = generateFirmware(m, "Practice Amp with Tuner");
    expect(fw.target).toBe("arduino");
    expect(fw.warnings).toEqual([]);
    expect(fw.files.map((f) => f.path)).toEqual(expect.arrayContaining([expect.stringMatching(/\.ino$/), expect.stringMatching(/README\.md$/)]));
    const pin = (s: string) => fw.pinTable.find((p) => p.signal === s)?.pin;
    expect(pin("GUITAR_IN")).toBe("A0");
    expect(pin("BUTTON")).toMatch(/^D?2$/);
  });
});

describe("Practice Amp with geometry", () => {
  it("passes every check, and the guitar-amp brief in full", { timeout: 240_000 }, async () => {
    const r = await fullCheck(AMP);
    expect(problems(r.report)).toEqual([]);
    expect([...r.buildErrors.values()]).toEqual([]);
    const score = scoreBrief(BRIEFS.find((b) => b.id === "guitar-amp")!, r.model, r.report.items);
    expect(score.lines.filter((l) => !l.ok)).toEqual([]);
  });
});
