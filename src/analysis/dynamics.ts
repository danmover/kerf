// Verdicts and plain words for the dynamic analyses: natural frequencies
// against what shakes the design (motor speeds, a drill, printer moves),
// and drops, knocks and tip-overs. Shared by the check report, the
// assistant's summaries and the analysis tab.

import type { CheckItem, CheckStatus } from "../core/checks";
import { fmtNum } from "../lang/values";
import type { ModeResult, StructuralResult } from "./fe/structural";
import type { Excitation, StructuralSpec } from "./spec";

type Verdict = "pass" | "warn" | "fail";
const p3 = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;
const hz = (f: number) => `${fmtNum(f, f < 10 ? 2 : f < 100 ? 1 : 0)} Hz`;
const worst = (a: Verdict, b: Verdict): Verdict => (a === "fail" || b === "fail" ? "fail" : a === "warn" || b === "warn" ? "warn" : "pass");

/** A mode that moves enough of the mass to matter when the base is shaken. */
const matters = (m: ModeResult) => m.share[0] + m.share[1] + m.share[2] >= 0.05;

/** How a mode moves, in words: the axis most of its mass sways along. */
export function modeWords(m: ModeResult): string {
  const k = [0, 1, 2].reduce((a, b) => (m.share[b] > m.share[a] ? b : a), 0);
  const tot = m.share[0] + m.share[1] + m.share[2];
  if (tot < 0.05) return "twists or flexes locally";
  return `sways along ${"XYZ"[k]} (${fmtNum(m.share[k] * 100, 0)} % of the mass)`;
}

/** Response of a mode with damping ratio ζ to shaking at r = f / fₙ, relative to a slow push. */
export function amplification(r: number, zeta: number): number {
  return 1 / Math.sqrt((1 - r * r) ** 2 + (2 * zeta * r) ** 2);
}

export interface ResonanceHit {
  source: Excitation;
  mode: ModeResult;
  index: number;
  /** the excitation frequency closest to the mode, and how much it amplifies */
  at: number;
  gain: number;
  status: Verdict;
}

/** Modes that the excitations land on or near. Inside the band ±10 % is a fail; within a factor √2 a warning. */
export function resonances(spec: StructuralSpec, r: StructuralResult): ResonanceHit[] {
  const ms = r.modal?.modes ?? [];
  const zeta = spec.modal?.damping ?? 0.02;
  const out: ResonanceHit[] = [];
  for (const src of spec.modal?.excite ?? []) {
    ms.forEach((m, index) => {
      if (!matters(m)) return;
      const at = Math.min(Math.max(m.freq, src.lo), src.hi);
      const ratio = at / m.freq;
      let status: Verdict = "pass";
      if (m.freq >= src.lo * 0.9 && m.freq <= src.hi * 1.1) status = "fail";
      else if (m.freq >= src.lo / Math.SQRT2 && m.freq <= src.hi * Math.SQRT2) status = "warn";
      if (status !== "pass") out.push({ source: src, mode: m, index, at, gain: amplification(ratio, zeta), status });
    });
  }
  return out;
}

/** After a printer move with acceleration a (mm/s²), how far each sideways mode rings, mm. */
export function ringing(r: StructuralResult, accel: number): { mode: ModeResult; index: number; amp: number; axis: number }[] {
  return (r.modal?.modes ?? []).map((m, index) => {
    const w2 = (2 * Math.PI * m.freq) ** 2;
    // base acceleration a along X or Y excites mode i by Γ a / ω²; its largest movement is the shape's peak times that
    const ax = Math.abs(m.gamma[0]) >= Math.abs(m.gamma[1]) ? 0 : 1;
    return { mode: m, index, amp: (m.peak.value * Math.abs(m.gamma[ax]) * accel) / w2, axis: ax };
  });
}

/** Visible ripples on a print start at about this much ringing. */
const RINGING_VISIBLE = 0.02;

export function vibrationVerdict(spec: StructuralSpec, r: StructuralResult): Verdict {
  if (!r.modal) return "pass";
  let v: Verdict = r.modal.converged ? "pass" : "warn";
  for (const h of resonances(spec, r)) v = worst(v, h.status);
  if (spec.modal?.ringing) for (const g of ringing(r, spec.modal.ringing)) if (g.amp > RINGING_VISIBLE) v = worst(v, "warn");
  return v;
}

export function vibrationText(spec: StructuralSpec, r: StructuralResult): { title: string; detail: string; fix?: string } {
  const m = r.modal!;
  const list = m.modes.map((md, i) => `${i + 1}) ${hz(md.freq)}, ${modeWords(md)}`).join("; ");
  let detail = `Natural frequencies: ${list}. Moving mass ${fmtNum(m.mass, 0)} g.`;
  const hits = resonances(spec, r);
  const ex = spec.modal?.excite ?? [];
  if (ex.length) {
    if (!hits.length) detail += ` Nothing that shakes it (${ex.map((e) => e.label).join(", ")}) comes near a frequency that moves much of its mass, so it does not resonate.`;
    for (const h of hits) {
      detail +=
        h.status === "fail"
          ? ` ${h.source.label} runs right through mode ${h.index + 1} at ${hz(h.mode.freq)}: it resonates, shaking about ${fmtNum(Math.min(h.gain, 999), 0)} times harder than the same force held still.`
          : ` ${h.source.label} comes within a factor of √2 of mode ${h.index + 1} at ${hz(h.mode.freq)} (shaking amplified about ${fmtNum(h.gain, 1)} times).`;
    }
  }
  if (spec.modal?.ringing) {
    const rings = ringing(r, spec.modal.ringing).filter((g) => g.amp > 1e-5).sort((a, b) => b.amp - a.amp);
    if (rings.length) {
      const g = rings[0];
      detail += ` After a ${fmtNum(spec.modal.ringing, 0)} mm/s² move along ${"XY"[g.axis]} it rings up to ${fmtNum(g.amp, 4)} mm at ${hz(g.mode.freq)}${g.amp > RINGING_VISIBLE ? `: visible ripples on prints, spaced about ${fmtNum(100 / g.mode.freq, 2)} mm apart at 100 mm/s` : ", too little to show on prints"}.`;
    }
  }
  if (!m.converged) detail += ` The frequency solver stopped at a residual of ${m.residual.toExponential(1)}, so frequencies may be off by a few percent.`;
  const bad = hits.filter((h) => h.status !== "pass").sort((a, b) => a.mode.freq - b.mode.freq);
  let fix: string | undefined;
  if (bad.length) {
    const h = bad[0];
    const want = h.source.hi * Math.SQRT2;
    fix = `Stiffen it where mode ${h.index + 1} moves most, near ${p3(h.mode.peak.at)} (a brace, gusset or deeper section), to lift ${hz(h.mode.freq)} above about ${hz(want)}; or keep ${h.source.label} away from ${hz(h.mode.freq)}.`;
  } else if (spec.modal?.ringing && ringing(r, spec.modal.ringing).some((g) => g.amp > RINGING_VISIBLE)) fix = "Stiffen the frame against sway (diagonal braces, a stiffer gantry), lower the acceleration, or let the firmware cancel the ringing (input shaping).";
  return { title: `Vibration: ${spec.label}: first mode ${hz(m.modes[0]?.freq ?? 0)}`, detail, fix };
}

export function dropVerdict(spec: StructuralSpec, r: StructuralResult, strength: Verdict): Verdict {
  return r.drop && r.drop.g === 0 ? "pass" : strength;
}

/** The part that takes the highest stress. */
function worstPart(r: StructuralResult): string | null {
  let best = -1,
    name: string | null = null;
  for (const p of r.parts) {
    let m = 0;
    for (let i = 0; i < p.stress.length; i++) if (p.stress[i] > m) m = p.stress[i];
    if (m > best) {
      best = m;
      name = p.name;
    }
  }
  return name;
}

export function dropText(spec: StructuralSpec, r: StructuralResult): string {
  const d = r.drop!;
  if (d.g === 0) return d.tip ? "It is too low and wide to tip over that way: its centre of mass stays inside its base." : "No fall height, so nothing happens.";
  const how = d.tip ? `Tips over onto its ${p3(d.dir)} side (its centre of mass falls ${fmtNum(d.height, 0)} mm)` : `Falls ${fmtNum(d.height / 1000, 2)} m`;
  const stop = d.force > 0 ? (2 * (d.energy * 1000)) / d.force : 0; // mm of give in body and floor
  let text = `${how} onto ${d.floor} at ${fmtNum(d.speed, 1)} m/s and stops within about ${fmtNum(stop, 2)} mm: peak deceleration ${fmtNum(d.g, 0)} g, a force of ${fmtNum(d.force, 0)} N on the side that lands (${fmtNum(d.contact.area, 0)} mm² of contact near ${p3(d.contact.at)}).`;
  const part = worstPart(r);
  text += ` The worst stress is ${fmtNum(r.maxStress.value, 1)} MPa${part ? ` in ${part}` : ""} near ${p3(r.maxStress.at)}, safety factor ${fmtNum(Math.min(r.minSafety.value, 99), 2)}.`;
  if (spec.masses?.length) text += ` Carried masses push with ${spec.masses.map((m) => `${fmtNum((m.grams / 1000) * 9.80665 * d.g, 0)} N (${fmtNum(m.grams, 0)} g)`).join(", ")} on what holds them.`;
  return text;
}

/** Report items for a modal or drop analysis (the static strength items are added by the caller when there are loads). */
export function dynamicItems(spec: StructuralSpec, r: StructuralResult, base: Pick<CheckItem, "basis" | "span" | "parts">, strength: { status: Verdict; note: string }): CheckItem[] {
  const id = (s: string) => `fea:${spec.label}:${s}`;
  const out: CheckItem[] = [];
  if (r.modal) {
    const t = vibrationText(spec, r);
    out.push({ ...base, category: "vibration", id: id("modes"), status: vibrationVerdict(spec, r) as CheckStatus, title: t.title, detail: t.detail, fix: t.fix });
  }
  if (r.drop) {
    const status = dropVerdict(spec, r, strength.status);
    out.push({
      ...base,
      category: "knocks",
      id: id("drop"),
      status,
      margin: r.minSafety.value - spec.safety,
      title: `${r.drop.tip ? "Tip-over" : "Drop"}: ${spec.label}`,
      detail: dropText(spec, r) + strength.note,
      fix: status === "pass" ? undefined : `Thicken or round the area near ${p3(r.maxStress.at)}, add a rib, or soften the landing (rubber feet, a bumper on the side that hits first).`,
    });
  }
  return out;
}
