// What the design's circuit does, from the solver: the bias of every stage,
// parts against their ratings, how much the knobs change the sound, how loud
// the output gets, and whether any stage runs out of swing before the stage
// that is meant to clip. The check report, the Build tab's Sound section and
// calc.preamp() all read from here.

import type { CheckItem } from "../../core/checks";
import { fmtNum } from "../../lang/values";
import { catalogPart } from "../catalog";
import { longValue } from "../catalog/values";
import type { MachineComponent, MachineData } from "../types";
import { designCircuit, type DesignCircuit, type KnobSettings } from "./netlist";
import { acImpedance, acTransfer, dcOperatingPoint, transient } from "./solver";
import type { DcResult, Element, Node, Probe } from "./types";

export type KnobRole = "gain" | "bass" | "mid" | "treble" | "volume";

const ROLE_RX: [KnobRole, RegExp][] = [
  ["gain", /gain|drive|dist|fuzz/i],
  ["bass", /bass|low/i],
  ["mid", /mid/i],
  ["treble", /treb|high|bright/i],
  ["volume", /vol|master|level/i],
];

/** Which pot is which knob, from its name or role. */
export function knobRoles(dc: DesignCircuit): Partial<Record<KnobRole, string>> {
  const out: Partial<Record<KnobRole, string>> = {};
  for (const p of dc.pots) {
    const text = `${p.comp} ${p.label}`;
    const hit = ROLE_RX.find(([role, rx]) => !out[role] && rx.test(text));
    if (hit) out[hit[0]] = p.comp;
  }
  return out;
}

/** Ambient air inside a closed-ish cabinet, for junction temperatures. */
const T_INSIDE = 40;

/** The preamp's output as the solver probes it: the load's input, against its own ground. */
export const outProbe = (dc: DesignCircuit): Probe | undefined => (dc.output ? (dc.output.ref === "0" ? dc.output.node : [dc.output.node, dc.output.ref]) : undefined);

/** Solver nodes on a controller's analog inputs (the tuner's listening pin). */
export function adcNodes(dc: DesignCircuit, m: MachineData): Node[] {
  return m.components.flatMap((mc) => {
    const p = catalogPart(mc.catalogId);
    return p?.kind === "controller" ? p.pins.filter((x) => x.adc && !x.bus?.startsWith("i2c")).map((x) => dc.nodeOf.get(`${mc.name}.${x.id}`)).filter((n): n is Node => !!n && n !== "0") : [];
  });
}

/**
 * Gain in dB from the guitar to the preamp's output at each frequency. Pass
 * the operating point of another knob setting to skip the DC solve: pots sit
 * behind coupling capacitors, so turning a knob doesn't move the bias.
 */
export function responseDb(m: MachineData, knobs: KnobSettings, freqs: number[], op?: DcResult): number[] | undefined {
  const dc = designCircuit(m, knobs);
  const out = outProbe(dc);
  if (!dc.input || !out) return undefined;
  op ??= dcOperatingPoint(dc.circuit);
  if (!op.ok) return undefined;
  return acTransfer(dc.circuit, { input: dc.input.id, out, freqs, op }).db;
}

/** Elements that conduct between two nodes (both orders). */
function joins(e: Element, a: Node, b: Node): boolean {
  return (e.n[0] === a && e.n[1] === b) || (e.n[0] === b && e.n[1] === a);
}

export interface Stage {
  id: string;
  comp: string;
  label: string;
  /** meant to clip: diodes in its feedback */
  clips: boolean;
  /** its output feeds a controller's analog input */
  sensing: boolean;
  out: Node;
  vpos: Node;
  vneg: Node;
  swing: [number, number];
}

export function stages(dc: DesignCircuit, m: MachineData): Stage[] {
  const els = dc.circuit.elements;
  const adc = new Set<Node>(adcNodes(dc, m));
  const supplyNodes = new Set<Node>(["0"]);
  for (const e of els) if (e.k === "OA") (supplyNodes.add(e.n[3]), supplyNodes.add(e.n[4]));
  // a short walk through resistors and capacitors from a node: does it reach an analog input?
  const reachesAdc = (start: Node): boolean => {
    let front = new Set([start]);
    const seen = new Set([start]);
    for (let hop = 0; hop < 3; hop++) {
      const next = new Set<Node>();
      for (const e of els) {
        if (e.k !== "R" && e.k !== "C") continue;
        for (const [a, b] of [[e.n[0], e.n[1]], [e.n[1], e.n[0]]]) {
          if (front.has(a) && !seen.has(b) && !supplyNodes.has(b)) {
            if (adc.has(b)) return true;
            seen.add(b);
            next.add(b);
          }
        }
      }
      front = next;
    }
    return false;
  };
  const out: Stage[] = [];
  for (const o of dc.opamps) {
    const e = els.find((x) => x.id === o.id);
    if (!e || e.k !== "OA") continue;
    const [, inm, vo, vp, vn] = e.n;
    const clips = els.some((x) => x.k === "D" && joins(x, vo, inm));
    const mc = m.components.find((c) => c.name === o.comp);
    out.push({ id: o.id, comp: o.comp, label: `${mc?.ref ?? o.comp}${o.channel}`, clips, sensing: reachesAdc(vo), out: vo, vpos: vp, vneg: vn, swing: e.swing });
  }
  return out;
}

export interface StageUse {
  label: string;
  /** peak swing as a fraction of what the stage can give before it clips */
  use: number;
  clips: boolean;
  sensing: boolean;
  peak: number;
  room: number;
}

/** Drives the input with a sine and measures how far each op-amp output swings. */
export function stageSwing(m: MachineData, knobs: KnobSettings, peak: number, freq = 196, op?: DcResult): StageUse[] {
  const dc = designCircuit(m, knobs);
  if (!dc.input) return [];
  op ??= dcOperatingPoint(dc.circuit);
  if (!op.ok) return [];
  const st = stages(dc, m);
  const fs = 48000;
  const samples = Math.round(fs * 0.04);
  const wave = new Float32Array(samples);
  for (let i = 0; i < samples; i++) wave[i] = peak * Math.sin((2 * Math.PI * freq * i) / fs);
  const r = transient(dc.circuit, { fs, samples, inputs: { [dc.input.id]: wave }, probes: st.map((s) => s.out), op, oversample: 2 });
  if (!r.ok) return [];
  return st.map((s, k) => {
    const v0 = op.v[s.out] ?? 0;
    const hi = (op.v[s.vpos] ?? 0) - s.swing[0];
    const lo = (op.v[s.vneg] ?? 0) + s.swing[1];
    let up = 0;
    let dn = 0;
    // skip the first period while the coupling capacitors settle
    for (let i = Math.round(fs / freq); i < samples; i++) {
      const d = r.out[k][i] - v0;
      up = Math.max(up, d);
      dn = Math.max(dn, -d);
    }
    const use = Math.max(up / Math.max(1e-6, hi - v0), dn / Math.max(1e-6, v0 - lo));
    return { label: s.label, use, clips: s.clips, sensing: s.sensing, peak: Math.max(up, dn), room: Math.min(hi - v0, v0 - lo) };
  });
}

export interface PreampFigures {
  ok: boolean;
  message?: string;
  /** small-signal gain at 1 kHz with the gain knob at zero and full, tone at noon, volume full (dB) */
  gain_min_db: number;
  gain_max_db: number;
  /** how far each tone knob moves its band, end to end (dB): bass at 100 Hz, middle at 600 Hz, treble at 4 kHz */
  bass_db: number;
  mid_db: number;
  treble_db: number;
  /** input impedance at 1 kHz (kΩ) */
  input_kohm: number;
  /** output peak for the given pickup level, clean, tone at noon, volume full (V) */
  out_peak: number;
  /** worst stage that must not clip: available swing over the peak it reaches at full gain and full tone (×) */
  headroom: number;
  /** peak-to-peak volts at the controller's analog input for a quiet note (20 mV peak) */
  tuner_pp: number;
  stages: StageUse[];
}

const ZERO: PreampFigures = { ok: false, gain_min_db: 0, gain_max_db: 0, bass_db: 0, mid_db: 0, treble_db: 0, input_kohm: 0, out_peak: 0, headroom: 0, tuner_pp: 0, stages: [] };

/** What the circuit is made of, for caching: parts, values and connections. */
export function circuitKey(m: MachineData): string {
  const parts = m.components.filter((c) => catalogPart(c.catalogId)?.sim || c.pcb).map((c) => [c.name, c.catalogId, c.count, c.value, c.taper, c.capType, c.vRating]);
  const nets = m.nets.map((n) => [n.name, n.pins.map((p) => `${p.comp}${p.index ?? ""}.${p.pin}`)]);
  const wires = m.wires.map((w) => [`${w.a.comp}${w.a.index ?? ""}.${w.a.pin}`, `${w.b.comp}${w.b.index ?? ""}.${w.b.pin}`]);
  return JSON.stringify([parts, nets, wires]);
}

const figureCache = new Map<string, PreampFigures>();

/** The figures calc.preamp() reports and the requirements read. */
export function preampFigures(m: MachineData, pickup: number): PreampFigures {
  const key = `${pickup}|${circuitKey(m)}`;
  const hit = figureCache.get(key);
  if (hit) return hit;
  const r = computeFigures(m, pickup);
  if (figureCache.size > 16) figureCache.delete(figureCache.keys().next().value!);
  figureCache.set(key, r);
  return r;
}

function computeFigures(m: MachineData, pickup: number): PreampFigures {
  const base = designCircuit(m);
  if (!base.input) return { ...ZERO, message: "The design has no guitar input jack with a simulation model." };
  if (!base.output) return { ...ZERO, message: "The design has no amplifier or speaker for the preamp to drive." };
  const op = dcOperatingPoint(base.circuit);
  if (!op.ok) return { ...ZERO, message: `The circuit has no stable operating point: ${op.message ?? ""}` };
  const roles = knobRoles(base);
  const noon: KnobSettings = {};
  for (const p of base.pots) noon[p.comp] = 0.5;
  if (roles.volume) noon[roles.volume] = 1;
  const clean = { ...noon, ...(roles.gain ? { [roles.gain]: 0 } : {}) };
  const set = (k: KnobSettings, role: KnobRole, v: number) => (roles[role] ? { ...k, [roles[role]!]: v } : k);
  const at = (knobs: KnobSettings, f: number) => responseDb(m, knobs, [f], op)?.[0];
  const g0 = at(clean, 1000) ?? 0;
  const g1 = at(set(noon, "gain", 1), 1000) ?? 0;
  const span = (role: KnobRole, f: number) => (roles[role] ? Math.abs((at(set(clean, role, 1), f) ?? 0) - (at(set(clean, role, 0), f) ?? 0)) : 0);
  // input impedance: the circuit with the guitar unplugged
  const open = designCircuit(m, noon, { source: false });
  const zin = acImpedance(open.circuit, { node: base.input.node, freqs: [1000], op });
  const zabs = Math.hypot(zin.h[0].re, zin.h[0].im);
  // clean output level, and the stage swings with everything turned up
  const outPeak = 10 ** (g0 / 20) * pickup;
  let worst: StageUse[] = [];
  let free = Infinity;
  for (const knobs of [set(set(set(set(noon, "gain", 1), "bass", 1), "mid", 1), "treble", 1), set(clean, "treble", 1)]) {
    const sw = stageSwing(m, knobs, pickup, 196, op);
    for (const s of sw) if (!s.clips && !s.sensing && s.use > 0) free = Math.min(free, 1 / s.use);
    if (!worst.length || sw.some((s, i) => s.use > (worst[i]?.use ?? 0))) worst = sw;
  }
  // the tuner's input: a quiet low E, 20 mV peak
  let tunerPp = 0;
  const adc = adcNodes(base, m);
  if (adc.length) {
    const r = acTransfer(base.circuit, { input: base.input.id, out: adc[0], freqs: [82.4, 330], op });
    tunerPp = 2 * 0.02 * Math.min(...r.h.map((h) => Math.hypot(h.re, h.im)));
  }
  return {
    ok: true,
    gain_min_db: g0,
    gain_max_db: g1,
    bass_db: span("bass", 100),
    mid_db: span("mid", 600),
    treble_db: span("treble", 4000),
    input_kohm: zabs / 1000,
    out_peak: outPeak,
    headroom: Number.isFinite(free) ? free : 99,
    tuner_pp: tunerPp,
    stages: worst,
  };
}

// ---------------------------------------------------------------- checks

const item = (id: string, status: CheckItem["status"], title: string, detail: string, parts: string[], span?: MachineComponent["span"]): CheckItem => ({ id: `circuit:${id}`, category: "electrical", status, title, detail, parts, span, basis: "simulation" });

/** The circuit's operating point against every part's ratings. */
export function circuitChecks(m: MachineData): CheckItem[] {
  if (!m.components.some((c) => catalogPart(c.catalogId)?.sim)) return [];
  const dc = designCircuit(m);
  if (dc.circuit.elements.length < 2) return [];
  const op = dcOperatingPoint(dc.circuit);
  const out: CheckItem[] = [];
  if (!op.ok) return [item("op", "fail", "Circuit has no steady state", `The simulator could not find the circuit's DC operating point: ${op.message ?? "it did not converge"}. Look for a missing bias resistor or a supply wired backwards.`, [])];
  const byName = new Map(m.components.map((c) => [c.name, c]));
  const V = (n: Node | undefined) => (n === undefined ? 0 : (op.v[n] ?? 0));
  const pin = (comp: string, p: string) => V(dc.nodeOf.get(`${comp}.${p}`));
  const who = (mc: MachineComponent) => mc.ref ?? mc.name;

  // op-amps: inputs inside the common-mode range, outputs biased mid-way
  const bias: string[] = [];
  for (const s of stages(dc, m)) {
    const e = dc.circuit.elements.find((x) => x.id === s.id) as Extract<Element, { k: "OA" }>;
    const mc = byName.get(s.comp)!;
    const part = catalogPart(mc.catalogId)!;
    const vneg = V(s.vneg);
    const vpos = V(s.vpos);
    const vin = V(e.n[0]);
    const vo = V(s.out);
    const cmLow = Number(part.specs.vicm_low ?? 0);
    if (vin - vneg < cmLow - 0.05) out.push(item(`cm:${s.id}`, "fail", `${s.label} input too close to its negative supply`, `${s.label}'s + input sits at ${fmtNum(vin - vneg, 2)} V above V−; ${part.name} needs ${fmtNum(cmLow)} V or more, or its output can flip. Bias it at half the supply.`, [s.comp], mc.span));
    const room = Math.min(vpos - s.swing[0] - vo, vo - (vneg + s.swing[1]));
    if (room < 0.5) out.push(item(`bias:${s.id}`, "fail", `${s.label} output stuck near a rail`, `${s.label}'s output sits at ${fmtNum(vo, 2)} V on a ${fmtNum(vneg, 1)} to ${fmtNum(vpos, 1)} V supply: no room to swing. Check its feedback and bias.`, [s.comp], mc.span));
    else if (room < 2) out.push(item(`bias:${s.id}`, "warn", `${s.label} has little room to swing`, `${s.label}'s output sits at ${fmtNum(vo, 2)} V: ${fmtNum(room, 1)} V before it clips.`, [s.comp], mc.span));
    else bias.push(`${s.label} ${fmtNum(vo, 2)} V`);
  }
  if (bias.length) out.push(item("bias", "pass", "Op-amp bias", `Outputs at rest: ${bias.join(", ")}. Every input is inside the op-amp's common-mode range.`, [...new Set(stages(dc, m).map((s) => s.comp))]));

  // capacitors: polarity and voltage
  const caps: string[] = [];
  for (const mc of m.components) {
    if (mc.kind !== "capacitor" || !mc.vRating) continue;
    const plus = mc.capType === "electrolytic" ? "PLUS" : "A";
    const minus = mc.capType === "electrolytic" ? "MINUS" : "B";
    const v = pin(mc.name, plus) - pin(mc.name, minus);
    const r = mc.vRating;
    if (mc.capType === "electrolytic" && v < -0.3) out.push(item(`pol:${mc.name}`, "fail", `${who(mc)} is backwards`, `${who(mc)} (${longValue(mc.value ?? 0, "farad")}) has ${fmtNum(-v, 2)} V on its minus lead over its plus lead. Turn it round: an electrolytic fitted backwards leaks and can burst.`, [mc.name], mc.span));
    else if (Math.abs(v) > r) out.push(item(`v:${mc.name}`, "fail", `${who(mc)} over its voltage`, `${who(mc)} has ${fmtNum(Math.abs(v), 1)} V across it; it is rated ${fmtNum(r)} V.`, [mc.name], mc.span));
    else if (mc.capType === "electrolytic" && Math.abs(v) > 0.8 * r) out.push(item(`v:${mc.name}`, "warn", `${who(mc)} close to its voltage rating`, `${who(mc)} has ${fmtNum(Math.abs(v), 1)} V across it, ${fmtNum((Math.abs(v) / r) * 100, 0)} % of its ${fmtNum(r)} V rating. Use the next rating up: electrolytics last longer below 80 %.`, [mc.name], mc.span));
    else if (mc.capType === "electrolytic") caps.push(`${who(mc)} ${fmtNum(v, 1)}/${fmtNum(r)} V`);
  }
  if (caps.length) out.push(item("caps", "pass", "Electrolytics the right way round and inside their ratings", caps.join(", "), m.components.filter((c) => c.capType === "electrolytic").map((c) => c.name)));

  // resistors: power
  let hot = false;
  for (const mc of m.components) {
    if (mc.kind !== "resistor") continue;
    const p = Math.abs(op.p[who(mc)] ?? 0);
    const rating = Number(catalogPart(mc.catalogId)?.specs.power_w ?? 0.25);
    if (p > rating) out.push(item(`pw:${mc.name}`, "fail", `${who(mc)} overheats`, `${who(mc)} dissipates ${fmtNum(p * 1000, 0)} mW; it is rated ${fmtNum(rating * 1000, 0)} mW.`, [mc.name], mc.span)), (hot = true);
    else if (p > rating / 2) out.push(item(`pw:${mc.name}`, "warn", `${who(mc)} runs warm`, `${who(mc)} dissipates ${fmtNum(p * 1000, 0)} mW, over half its ${fmtNum(rating * 1000, 0)} mW rating.`, [mc.name], mc.span)), (hot = true);
  }
  if (!hot && m.components.some((c) => c.kind === "resistor")) out.push(item("res", "pass", "Resistor power", "Every resistor runs below half its power rating.", []));

  // regulators and diodes: heat
  for (const mc of m.components) {
    const part = catalogPart(mc.catalogId);
    if (part?.sim?.k === "reg") {
      const vin = pin(mc.name, part.sim.in);
      const vout = pin(mc.name, part.sim.out);
      const iout = Math.abs(op.i[who(mc)] ?? 0);
      const p = Math.max(0, (vin - vout) * iout + vin * part.sim.iq);
      const tj = T_INSIDE + p * Number(part.specs.theta_ja ?? 50);
      const detail = `${fmtNum(vin, 1)} V in, ${fmtNum(vout, 1)} V out at ${fmtNum(iout * 1000, 0)} mA: ${fmtNum(p, 2)} W, about ${fmtNum(tj, 0)} °C at the junction in ${T_INSIDE} °C air with no heatsink.`;
      if (vin - vout < part.sim.dropout + 0.3) out.push(item(`reg:${mc.name}`, "fail", `${who(mc)} drops out`, `${who(mc)} needs ${fmtNum(part.sim.dropout)} V more in than out; it has ${fmtNum(vin - vout, 1)} V.`, [mc.name], mc.span));
      else out.push(item(`reg:${mc.name}`, tj > 125 ? "fail" : tj > 100 ? "warn" : "pass", `${who(mc)} ${part.mpn ?? part.name} heat`, detail + (tj > 100 ? " Add a clip-on heatsink." : ""), [mc.name], mc.span));
    }
    if (part?.sim?.k === "D") {
      const i = Math.abs(op.i[who(mc)] ?? 0);
      const rating = Number(part.specs.i_f ?? 0);
      if (rating && i > 0.7 * rating) out.push(item(`diode:${mc.name}`, i > rating ? "fail" : "warn", `${who(mc)} carries ${fmtNum(i, 2)} A`, `${part.name} is rated ${fmtNum(rating)} A.`, [mc.name], mc.span));
    }
  }
  return out;
}
