// The hook a scenario uses to run a design's circuit over time. It builds the
// circuit from the machine's wiring, finds its operating point, plays the
// inputs through it and hands back each probed net as a waveform, so a
// scenario can feed a controller's analog pins from the real analog path.
// Coupling is one way: nothing a controller does feeds back into the circuit.

import type { MachineData } from "../types";
import { designCircuit, type KnobSettings } from "./netlist";
import { dcOperatingPoint, transient } from "./solver";
import type { Node } from "./types";

export type CircuitInputs = Record<string, (t: number) => number> | { fs: number; samples: Record<string, Float32Array> };

export interface SimulateCircuitOptions {
  /**
   * Signals by input name, in volts on top of the input's resting level: functions of time in seconds, or
   * waveforms sampled at their own rate (resampled to `fs`). An input is named by its source id ("guitar")
   * or by the component that carries it (the input jack's name).
   */
  inputs: CircuitInputs;
  /** output sample rate in Hz; defaults to the sampled inputs' rate, else 32 kHz */
  fs?: number;
  /** seconds to run; defaults to the length of the sampled inputs */
  duration?: number;
  /** nets to record, by net name or as "component.pin" */
  probes: string[];
  /** pot positions 0..1 by component name (knobs left out sit at their defaults) */
  knobs?: KnobSettings;
  /** internal steps per output sample (default 2, which keeps clipping stages accurate) */
  oversample?: number;
  onProgress?: (fraction: number) => void;
}

export interface SimulateCircuitResult {
  ok: boolean;
  fs: number;
  /** one waveform per requested probe, in volts to ground */
  probes: Record<string, Float32Array>;
  /** the circuit's named nets, for choosing probes */
  nets: string[];
  warnings: string[];
  message?: string;
}

const DEFAULT_FS = 32000;
/** Longest run, so a typo in `duration` cannot lock a tab up. */
const MAX_SECONDS = 60;

export function simulateCircuit(m: MachineData, o: SimulateCircuitOptions): SimulateCircuitResult {
  const dc = designCircuit(m, o.knobs ?? {});
  const nodes = new Set<Node>();
  for (const e of dc.circuit.elements) for (const n of e.n) if (n !== "0") nodes.add(n);
  // named nets only: a part's internal nodes are "component.something"
  const nets = [...nodes].filter((n) => /^[A-Za-z]\w*$/.test(n)).sort();
  const sampled = "samples" in o.inputs && typeof o.inputs.fs === "number" ? (o.inputs as { fs: number; samples: Record<string, Float32Array> }) : undefined;
  const fs = o.fs ?? sampled?.fs ?? DEFAULT_FS;
  const fail = (message: string): SimulateCircuitResult => ({ ok: false, fs, probes: {}, nets, warnings: dc.warnings, message });
  if (!(fs > 0)) return fail("The sample rate must be above zero.");

  // inputs: a source id, or the component whose source it is
  const sourceOf = (name: string): string | undefined => {
    if (dc.circuit.elements.some((e) => e.id === name && (e.k === "V" || e.k === "I"))) return name;
    if (dc.input && dc.input.comp === name) return dc.input.id;
    return undefined;
  };
  const named = Object.keys(sampled ? sampled.samples : o.inputs);
  const longest = sampled ? Math.max(0, ...Object.values(sampled.samples).map((w) => w.length)) / sampled.fs : 0;
  const seconds = Math.min(MAX_SECONDS, o.duration ?? longest);
  if (!(seconds > 0)) return fail("Give a duration, or sampled inputs to set one.");
  const samples = Math.round(seconds * fs);
  const inputs: Record<string, Float32Array> = {};
  for (const name of named) {
    const id = sourceOf(name);
    if (!id) return fail(`No circuit input called "${name}". Inputs: ${[dc.input?.id, dc.input?.comp].filter(Boolean).join(", ") || "none"}.`);
    const w = new Float32Array(samples);
    if (sampled) {
      const src = sampled.samples[name];
      const r = sampled.fs / fs;
      for (let k = 0; k < samples; k++) {
        const x = k * r;
        const i = Math.floor(x);
        if (i + 1 < src.length) w[k] = src[i] + (src[i + 1] - src[i]) * (x - i);
        else w[k] = src.length ? src[src.length - 1] : 0;
      }
    } else {
      const f = (o.inputs as Record<string, (t: number) => number>)[name];
      for (let k = 0; k < samples; k++) w[k] = f(k / fs);
    }
    inputs[id] = w;
  }

  const probeNodes: Node[] = [];
  for (const p of o.probes) {
    const n = nodes.has(p) ? p : dc.nodeOf.get(p);
    if (!n || !nodes.has(n)) return fail(`No net called "${p}" in the circuit. Nets: ${nets.join(", ")}.`);
    probeNodes.push(n);
  }

  const op = dcOperatingPoint(dc.circuit);
  if (!op.ok) return fail(op.message ?? "The circuit has no steady operating point.");
  const r = transient(dc.circuit, { fs, samples, inputs, probes: probeNodes, op, oversample: o.oversample ?? 2, onProgress: o.onProgress });
  if (!r.ok) return fail(r.message ?? "The circuit simulation failed.");
  const probes: Record<string, Float32Array> = {};
  o.probes.forEach((p, i) => (probes[p] = r.out[i]));
  const warnings = [...dc.warnings];
  if (r.nonConverged) warnings.push(`${r.nonConverged} time steps did not fully converge.`);
  return { ok: true, fs, probes, nets, warnings };
}
