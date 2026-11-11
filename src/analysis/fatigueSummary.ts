// Fatigue results in words, and the fatigue check: the lowest fatigue safety factor (the factor on the loads at which
// the part breaks at the end of its design life) against the analysis's target, with the life and what does the damage.

import { fmtNum } from "../lang/values";
import type { FatigueResult, SafetyAt, StructuralResult } from "./fe/structural";
import { MEAN_STRESS, cycleWords } from "./fe/fatigue";
import type { StructuralSpec } from "./spec";

type Verdict = "pass" | "warn" | "fail";

const p3 = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;
const sf = (v: number) => (!Number.isFinite(v) || v >= 100 ? "over 100" : fmtNum(v, 2));

/** A count in words: 2.5e6, 40,000. */
export function count(v: number): string {
  if (!Number.isFinite(v)) return "no limit";
  return v >= 1e5 ? v.toExponential(1).replace("e+", "e") : fmtNum(v, v < 10 ? 1 : 0);
}

/** The life asked for, in words: "1e7 on-off cycles", "2,000 passes of the history". */
export function designWords(f: FatigueResult): string {
  return f.unit === "cycles" ? `${count(f.design)} cycles` : `${count(f.design)} pass${f.design === 1 ? "" : "es"} of the history`;
}

export function lifeText(v: number, f: FatigueResult): string {
  if (!Number.isFinite(v)) return "no limit (below the endurance limit everywhere)";
  return f.unit === "cycles" ? `${count(v)} cycles` : `${count(v)} pass${v === 1 ? "" : "es"} of the history`;
}

/** Pass at the target, warn between 1 and it, fail below 1; a low value right at a support or load warns when it passes a short way off. */
export function fatigueVerdict(spec: StructuralSpec, r: StructuralResult): { status: Verdict; margin: number } | null {
  const f = r.fatigue;
  if (!f) return null;
  const s = f.minSafety.value;
  let status: Verdict = s >= spec.safety ? "pass" : s >= 1 ? "warn" : "fail";
  const away = f.minSafety.nearBoundary ? f.minSafety.away : null;
  if (status !== "pass" && away && away.value >= spec.safety) status = "warn";
  if (status === "pass" && r.materials.some((m) => m.assumed)) status = "warn";
  return { status, margin: s - spec.safety };
}

const curveText = (f: FatigueResult) =>
  f.curves
    .map(
      (c) =>
        `${c.material}${c.layers ? " between layers" : ""}: ${fmtNum(c.s3, 0)} MPa at 10³ cycles to ${fmtNum(c.se, 1)} MPa at 10⁷ (${c.finishText}${c.ka < 0.999 ? `, surface factor ${fmtNum(c.ka, 2)}` : ""}${c.ke < 0.999 ? `, reliability factor ${fmtNum(c.ke, 3)}` : ""}), ${c.tail === "flat" ? "an endurance limit beyond" : "still falling about 10 % per decade beyond"}; judged by ${c.equivalent}`,
    )
    .join("; ");

/** What a fatigue safety factor is judged against, in words. */
export function fatigueModeText(m: SafetyAt, f: FatigueResult): string {
  return `${m.mode === "layer fatigue" ? "fatigue strength between print layers" : "fatigue strength"} of ${m.material} over ${designWords(f)}, ${f.loading}, ${MEAN_STRESS[f.meanStress]} mean stress (${fmtNum(m.allowable, 1)} MPa fully reversed at that life)`;
}

/** The check's text and a fix when it falls short. */
export function fatigueText(spec: StructuralSpec, r: StructuralResult): { detail: string; fix?: string } | null {
  const f = r.fatigue;
  if (!f) return null;
  const m = f.minSafety;
  let detail = `Lowest fatigue safety factor ${sf(m.value)} near ${p3(m.at)} against the ${fatigueModeText(m, f)}; target ${fmtNum(spec.safety, 2)}.`;
  if (m.nearBoundary && m.away) detail += ` It sits right at a support or load, where the idealised fixing exaggerates stress; a short way off it is ${sf(m.away.value)} at ${p3(m.away.at)}.`;
  detail += ` Shortest life ${lifeText(f.life.value, f)} at ${p3(f.life.at)}, against ${designWords(f)} asked for`;
  detail += Number.isFinite(f.life.value) ? ` (Miner's damage ${fmtNum(f.damage, f.damage < 0.01 ? 4 : 3)} over that life).` : ".";
  if (f.cycles.length > 1 || f.repeats > 1) {
    const top = f.shares.slice(0, 3).map((s) => `${count(s.cycle.count)} × ${cycleWords(s.cycle)} (${fmtNum(s.share * 100, 0)} %)`);
    detail += ` ${f.cycles.length} kind${f.cycles.length > 1 ? "s" : ""} of cycle${f.repeats > 1 ? `, repeated ${count(f.repeats)} times` : ""}${top.length ? `; most of the damage comes from ${top.join(", ")}` : ""}.`;
  }
  if (r.staticSafety) detail += ` At the peak of the loads (${fmtNum(f.peak, 2)}×) the static safety factor is ${sf(r.staticSafety.value)} against yield${r.staticSafety.mode === "layers" ? " between print layers" : ""}.`;
  detail += ` S-N curves: ${curveText(f)}.`;
  const v = fatigueVerdict(spec, r);
  if (!v || v.status === "pass") return { detail };
  return {
    detail,
    fix: "Lower the stress where the life is shortest: thicken it or add material along the load path, round sharp inside corners (a bigger fillet), move holes and steps away from it, or pick a material with a higher fatigue strength. A smoother finish (ground or polished) helps metal parts.",
  };
}
