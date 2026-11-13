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
  // loads that leave a mode with no stiffness would buckle the parts
  if (r.modal.buckles) v = "fail";
  for (const h of resonances(spec, r)) v = worst(v, h.status);
  if (spec.modal?.ringing) for (const g of ringing(r, spec.modal.ringing)) if (g.amp > RINGING_VISIBLE) v = worst(v, "warn");
  return v;
}

/** detail: the frequencies and what they mean; notes: the same without the list of frequencies (for views that list them). */
export function vibrationText(spec: StructuralSpec, r: StructuralResult): { title: string; detail: string; notes: string; fix?: string } {
  const m = r.modal!;
  const was = (i: number) => {
    const u = m.unloaded?.[i];
    if (!u) return "";
    const pc = ((m.modes[i].freq - u) / u) * 100;
    return ` (${hz(u)} unloaded, ${Math.abs(pc) < 0.05 ? "the same" : `${pc > 0 ? "+" : "−"}${fmtNum(Math.abs(pc), Math.abs(pc) < 10 ? 1 : 0)} %`})`;
  };
  const list = m.modes.map((md, i) => `${i + 1}) ${hz(md.freq)}${was(i)}, ${modeWords(md)}`).join("; ");
  let detail = `Moving mass ${fmtNum(m.mass, 0)} g.`;
  if (m.unloaded) detail += m.buckles ? " Under the loads a mode is left with no stiffness: they would buckle the parts (check buckling)." : " The frequencies are under the loads: their tension stiffens the parts and compression softens them.";
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
  if (m.buckles && !fix) fix = "Lighten the loads that press on the parts, or stiffen them against buckling (shorter or deeper members, bracing).";
  return { title: `Vibration: ${spec.label}: first mode ${hz(m.modes[0]?.freq ?? 0)}${m.unloaded ? " under load" : ""}`, detail: `Natural frequencies${m.unloaded ? " under the loads" : ""}: ${list}. ${detail}`, notes: detail, fix };
}

// ---------- shaking: a sine sweep or random vibration ----------

/** A direction in words: +Z, or its components. */
const along = (d: number[]) => {
  const k = [0, 1, 2].find((i) => Math.abs(d[i]) > 0.999);
  return k === undefined ? `(${d.map((v) => fmtNum(v, 2)).join(", ")})` : `${d[k] > 0 ? "+" : "−"}${"XYZ"[k]}`;
};

/** A length of time in words: 40 s, 12 min, 3.5 h, 20 days, 8 years. */
export function lifeWords(s: number): string {
  if (!Number.isFinite(s)) return "for good";
  if (s < 120) return `${fmtNum(s, s < 10 ? 1 : 0)} s`;
  if (s < 7200) return `${fmtNum(s / 60, s < 600 ? 1 : 0)} min`;
  if (s < 2 * 86400) return `${fmtNum(s / 3600, s < 36000 ? 1 : 0)} h`;
  if (s < 2 * 365.25 * 86400) return `${fmtNum(s / 86400, 0)} days`;
  const y = s / (365.25 * 86400);
  return y > 1e4 ? "more than 10,000 years" : `${fmtNum(y, y < 10 ? 1 : 0)} years`;
}

/** A count in words: 5.3×10⁶. */
const count = (n: number) => {
  if (n < 1e4) return fmtNum(n, 0);
  const e = Math.floor(Math.log10(n));
  const sup = String(e).replace(/[0-9]/g, (c) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(c)]);
  return `${fmtNum(n / 10 ** e, 1)}×10${sup}`;
};

/** The mode nearest a frequency (on a log scale), and its index. */
function nearestMode(r: StructuralResult, f: number): { mode: ModeResult; index: number } | null {
  const ms = r.modal?.modes ?? [];
  let best = -1;
  for (let i = 0; i < ms.length; i++) if (best < 0 || Math.abs(Math.log(ms[i].freq / f)) < Math.abs(Math.log(ms[best].freq / f))) best = i;
  return best < 0 ? null : { mode: ms[best], index: best };
}

/**
 * The verdict on shaking: the safety factor of the stresses it shakes them to (amplitude or 3σ) against the fatigue
 * strength for the cycles it is shaken for, as the strength check judges it; a life shorter than the duration asked fails.
 */
export function shakingVerdict(spec: StructuralSpec, r: StructuralResult, strength: Verdict): Verdict {
  const v = r.vibration;
  if (!v) return "pass";
  let out = strength;
  const dur = spec.modal?.duration;
  if (dur !== undefined && Number.isFinite(v.life) && v.life < dur) out = "fail";
  return out;
}

/** A sine sweep or random shaking in words: what shakes it, how hard it answers, the worst stress and how long it lasts. */
export function shakingText(spec: StructuralSpec, r: StructuralResult, note = ""): { title: string; detail: string; fix?: string } | null {
  const v = r.vibration;
  if (!v) return null;
  const pc = (x: number) => `${fmtNum(x * 100, x < 0.1 ? 1 : 0)} %`;
  const ms = r.modal?.modes ?? [];
  const inBand = ms.map((m, i) => ({ m, i })).filter(({ m }) => m.freq >= v.lo && m.freq <= v.hi);
  const bandModes = inBand.length ? ` Modes inside the band: ${inBand.map(({ m, i }) => `${i + 1} (${hz(m.freq)})`).join(", ")}.` : " No mode lies inside the band, so it answers well away from resonance.";
  const sfv = r.minSafety;
  const away = sfv.nearBoundary ? sfv.away : null;
  const sfText = (x: number) => (!Number.isFinite(x) || x >= 100 ? "over 100" : fmtNum(x, 2));
  const judged = `against the ${sfv.mode === "fatigue" ? `fatigue strength of ${sfv.material} for ${count(v.cycles)} cycles` : `yield strength of ${sfv.material}`} (${fmtNum(sfv.allowable, 1)} MPa), target ${fmtNum(spec.safety, 2)}`;
  const dur = spec.modal?.duration;
  let detail: string;
  let title: string;
  if (v.kind === "sine") {
    const at = v.at ?? v.lo;
    const near = nearestMode(r, at);
    const nearText = near && Math.abs(Math.log(near.mode.freq / at)) < 0.15 ? ` (mode ${near.index + 1}, ${hz(near.mode.freq)})` : "";
    detail = v.dir
      ? `Swept from ${hz(v.lo)} to ${hz(v.hi)} with the supports shaken at ${fmtNum(v.level, 2)} g (peak) along ${along(v.dir)}, damping ${pc(v.damping)}.`
      : `Swept from ${hz(v.lo)} to ${hz(v.hi)} with the loads going up and down at their full size, damping ${pc(v.damping)}.`;
    detail += bandModes;
    detail += ` The worst is at ${hz(at)}${nearText}, where it moves ${fmtNum(Math.min(v.gain ?? 1, 999), (v.gain ?? 1) < 10 ? 1 : 0)} times as far as the same ${v.dir ? "acceleration" : "loads"} held still.`;
    detail += ` There the peak stress is ${fmtNum(r.maxStress.value, 1)} MPa (von Mises) near ${p3(r.maxStress.at)} and the largest movement ${fmtNum(r.maxDisp.value, r.maxDisp.value < 0.1 ? 4 : 3)} mm; the lowest safety factor is ${sfText(sfv.value)} ${judged}.`;
    if (away) detail += ` It sits right at a support or load; a short way off it is ${sfText(away.value)}.`;
    detail += Number.isFinite(v.life)
      ? ` At that stress it lasts about ${lifeWords(v.life)} of shaking at ${hz(at)} (${count(v.life * at)} cycles)${dur !== undefined ? `, ${v.life >= dur ? `${fmtNum(v.life / dur, v.life / dur < 10 ? 1 : 0)} times` : "less than"} the ${lifeWords(dur)} asked for` : ""}.`
      : ` At that stress it does not wear out: it stays below ${v.lifeMaterial}'s fatigue limit.`;
    title = `Shaking: ${spec.label}: worst at ${hz(at)}`;
  } else {
    const rms = v.rms!;
    detail = `Shaken at random along ${along(v.dir ?? [0, 0, 1])} with ${spec.modal?.random?.label ?? `${hz(v.lo)}–${hz(v.hi)}`} (${fmtNum(v.level, 2)} g rms overall), damping ${pc(v.damping)}.`;
    detail += bandModes;
    detail += ` RMS (1σ): it moves up to ${fmtNum(rms.disp, rms.disp < 0.1 ? 4 : 3)} mm, and the stress reaches ${fmtNum(rms.stress, 1)} MPa (von Mises) near ${p3(rms.at)}.`;
    detail += ` The stresses shown are 3σ, which it stays below 99.7 % of the time: peak ${fmtNum(r.maxStress.value, 1)} MPa near ${p3(r.maxStress.at)}, lowest safety factor ${sfText(sfv.value)} ${judged}.`;
    if (away) detail += ` It sits right at a support or load; a short way off it is ${sfText(away.value)}.`;
    const swings = v.nu0 ?? 0;
    detail += Number.isFinite(v.life)
      ? ` Its stress swings about ${fmtNum(swings, swings < 10 ? 1 : 0)} times a second there; by Steinberg's three bands (68 % of the swings at 1σ, 27 % at 2σ, 4 % at 3σ) it lasts about ${lifeWords(v.life)} of this shaking${dur !== undefined ? `, ${v.life >= dur ? `${fmtNum(v.life / dur, v.life / dur < 10 ? 1 : 0)} times` : "less than"} the ${lifeWords(dur)} asked for` : ""}.`
      : ` Even its 3σ swings stay below ${v.lifeMaterial}'s fatigue limit, so it does not wear out.`;
    title = `Random shaking: ${spec.label}: ${fmtNum(rms.stress, 1)} MPa rms`;
  }
  if (v.massShare < 0.8 && v.dir) detail += ` The modes found move ${pc(v.massShare)} of the mass along the shaking, so the answer is a little low.`;
  detail += note;
  const peak = r.maxDisp.at;
  const lowMode = inBand[0];
  const fix =
    sfv.value < spec.safety || (dur !== undefined && Number.isFinite(v.life) && v.life < dur)
      ? `Stiffen it where it moves most, near ${p3(peak)} (a brace, a gusset, a deeper section)${lowMode ? ` to lift mode ${lowMode.i + 1} (${hz(lowMode.m.freq)}) out of the band or make it move less` : ""}; add damping (rubber mounts, a damped layer); or lighten what it carries.`
      : undefined;
  return { title, detail, fix };
}

/** Where it lands the plastic or metal is crushed a little; judged a short way off, like a support. */
const crushed = (r: StructuralResult) => (r.minSafety.nearBoundary && r.minSafety.away && r.minSafety.value < 1 ? r.minSafety.away : null);

/**
 * A drop is judged a short way from the spot that lands when the lowest safety factor sits right on it:
 * a dent or scuff there is what a drop does, not a break. Doubts about the solve still hold it back.
 */
export function dropVerdict(spec: StructuralSpec, r: StructuralResult, strength: Verdict): Verdict {
  if (!r.drop || r.drop.g === 0) return "pass";
  const away = r.minSafety.nearBoundary ? r.minSafety.away : null;
  if (!away) return strength;
  const v: Verdict = away.value >= spec.safety ? (r.minSafety.value < 1 ? "warn" : "pass") : away.value >= 1 ? "warn" : "fail";
  return strength === "warn" && v === "pass" ? "warn" : v;
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
  let text = `${how} onto ${d.floor} at ${fmtNum(d.speed, 1)} m/s. The impact lasts about ${fmtNum(d.pulseMs, d.pulseMs < 1 ? 2 : 1)} ms with ${fmtNum(d.squash, 3)} mm of give: peak deceleration ${fmtNum(d.g, 0)} g, ${fmtNum(d.force, 0)} N where it lands (${fmtNum(d.contact.area, 0)} mm² of contact near ${p3(d.contact.at)}).`;
  const sway = Number.isFinite(d.bodyHz) ? `The parts flex at about ${hz(d.bodyHz)} under this load` : "The parts barely flex under this load";
  if (d.amplification < 0.8) text += ` ${sway}, slower than the impact, so it is over before they flex fully: they feel about ${fmtNum(d.felt, 0)} g.`;
  else if (d.amplification <= 1.2) text += ` ${sway}, fast enough to feel the full ${fmtNum(d.felt, 0)} g.`;
  else text += ` ${sway}, about as long as the impact lasts, which adds to it: they feel about ${fmtNum(d.felt, 0)} g.`;
  const part = worstPart(r);
  const dent = crushed(r);
  if (dent) text += ` Right where it lands it is crushed a little (a scuff or small dent, which a drop always leaves); a short way off the lowest safety factor is ${fmtNum(Math.min(dent.value, 99), 2)} at ${p3(dent.at)}.`;
  else text += ` The worst stress is ${fmtNum(r.maxStress.value, 1)} MPa${part ? ` in ${part}` : ""} near ${p3(r.maxStress.at)}, safety factor ${fmtNum(Math.min(r.minSafety.value, 99), 2)}.`;
  if (spec.masses?.length) text += ` Carried masses push with ${spec.masses.map((m) => `${fmtNum((m.grams / 1000) * 9.80665 * d.felt, 0)} N (${fmtNum(m.grams, 0)} g)`).join(", ")} on what holds them.`;
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
  if (r.vibration) {
    const t = shakingText(spec, r, strength.note)!;
    const status = shakingVerdict(spec, r, strength.status);
    out.push({ ...base, category: "vibration", id: id("shaking"), status, margin: r.minSafety.value - spec.safety, title: t.title, detail: t.detail, ...(t.fix ? { fix: t.fix } : {}) });
  }
  if (r.drop) {
    const status = dropVerdict(spec, r, strength.status);
    out.push({
      ...base,
      category: "knocks",
      id: id("drop"),
      status,
      margin: (r.minSafety.nearBoundary && r.minSafety.away ? r.minSafety.away : r.minSafety).value - spec.safety,
      title: `${r.drop.tip ? "Tip-over" : "Drop"}: ${spec.label}`,
      detail: dropText(spec, r) + strength.note,
      fix: status === "pass" ? undefined : `Thicken or round the area near ${p3((crushed(r) ?? r.minSafety).at)}, add a rib, or soften the landing (rubber feet, a bumper on the side that hits first).`,
    });
  }
  return out;
}
