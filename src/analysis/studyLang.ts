// A design study in the analysis block: an analysis with vary: lists the
// parameters to change and their ranges, what to make as small or large as it
// can (goal:), and any limits beyond the analyses' own targets (keep:).
//
//   analysis "Lightest bracket" {
//     vary: [thickness, bend_r(1mm, 6mm), ribs(0, 4, 1)]
//     goal: "min mass"
//     keep: ["deflection <= 0.4mm"]
//     runs: 16
//   }

import { Obj, typeName, type Value } from "../lang/values";
import { UNITS } from "../lang/lexer";
import type { Span } from "../lang/ast";
import type { StudyGoal, StudyLimit, StudyMeasure, StudySpec, StudyVariable } from "./spec";
import type { AnalysisEnv, AnalysisItem } from "./lang";

export const STUDY_PROPS = ["vary", "goal", "keep", "using", "runs"];
/** the Obj kind the evaluator makes for each vary: entry (a parameter by name, not its value) */
export const STUDY_VARIABLE = "study variable";
export const MAX_STUDY_VARIABLES = 6;
export const DEFAULT_STUDY_RUNS = 12;
export const MAX_STUDY_RUNS = 40;

const MEASURES: Record<string, StudyMeasure> = {
  mass: "mass",
  weight: "mass",
  safety: "safety",
  "safety factor": "safety",
  deflection: "deflection",
  sag: "deflection",
  stress: "stress",
  frequency: "frequency",
  "first mode": "frequency",
  temperature: "temperature",
  temp: "temperature",
  buckling: "buckling",
  "buckling factor": "buckling",
};

/** the unit each measure is written in, for messages */
export const MEASURE_UNIT: Record<StudyMeasure, string> = { mass: "g", safety: "", deflection: "mm", stress: "MPa", frequency: "Hz", temperature: "°C", buckling: "×" };

/** the way each measure is better, when a goal only names it ("lightest") */
const SHORTHAND: Record<string, [StudyGoal["sense"], StudyMeasure]> = {
  lightest: ["min", "mass"],
  stiffest: ["min", "deflection"],
  strongest: ["max", "safety"],
  coolest: ["min", "temperature"],
};

/** "min mass", "max safety of Bracket load", "lightest": what the study optimises. */
export function parseGoal(text: string): StudyGoal | string {
  const t = text.trim().replace(/\s+/g, " ");
  const short = SHORTHAND[t.toLowerCase()];
  if (short) return { sense: short[0], what: short[1], text: t };
  const m = /^(min(?:imi[sz]e)?|max(?:imi[sz]e)?|lowest|highest|least|most)\s+(.+?)(?:\s+of\s+(.+))?$/i.exec(t);
  if (!m) return `goal: "${text}" is not a goal Kerf knows. Write "min mass", "max safety", "min deflection", "min stress", "max frequency", "min temperature" or "max buckling", optionally followed by "of <part or analysis>".`;
  const what = MEASURES[m[2].toLowerCase()];
  if (!what) return `goal: "${m[2]}" is not something Kerf measures. Use mass, safety, deflection, stress, frequency, temperature or buckling.`;
  const sense = /^(min|lowest|least)/i.test(m[1]) ? "min" : "max";
  return { sense, what, ...(m[3] ? { of: m[3].trim().replace(/^"|"$/g, "") } : {}), text: t };
}

/** "mass <= 120g", "safety of Shelf load >= 2.5", "frequency >= 80Hz": a limit every chosen design meets. */
export function parseLimit(text: string): StudyLimit | string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = /^(.+?)(?:\s+of\s+(.+?))?\s*(<=|>=|≤|≥|<|>)\s*(-?[\d.]+(?:e-?\d+)?)\s*([a-zA-Z%°×]*)$/.exec(t);
  if (!m) return `keep: "${text}" should read like "mass <= 120g", "safety >= 2.5" or "deflection of Shelf load <= 0.4mm".`;
  const what = MEASURES[m[1].toLowerCase()];
  if (!what) return `keep: "${m[1]}" is not something Kerf measures. Use mass, safety, deflection, stress, frequency, temperature or buckling.`;
  let value = Number(m[4]);
  const unit = m[5].replace(/^°/, "");
  if (unit && unit !== "x" && unit !== "×") {
    const k = UNITS[unit];
    if (k === undefined) return `keep: "${m[5]}" in "${text}" is not a unit Kerf knows.`;
    value *= k;
  }
  if (!Number.isFinite(value)) return `keep: "${text}" needs a number to compare with.`;
  const op = m[3] === "<=" || m[3] === "≤" || m[3] === "<" ? "<=" : ">=";
  return { what, op, value, ...(m[2] ? { of: m[2].trim().replace(/^"|"$/g, "") } : {}), text: t };
}

/** Whole numbers without a unit (a count of ribs or holes) only take whole values. */
function isCount(p: { value: number; text: string }): boolean {
  return Number.isInteger(p.value) && /^\s*-?\d+\s*$/.test(p.text);
}

export function buildStudy(label: string, props: AnalysisItem[], flags: AnalysisItem[], span: Span, env: AnalysisEnv): StudySpec {
  const fail = env.fail;
  for (const p of props)
    if (!STUDY_PROPS.includes(p.name))
      fail(`"${p.name}:" does not belong in a design study (an analysis with vary:), which takes ${STUDY_PROPS.join(", ")}. Put fix:, load: and the rest in the analyses it solves, and name them with using:.`, p.span);
  for (const f of flags) if (f.name !== "locked") fail(`A design study takes no flags ("${f.name}")`, f.span);
  const one = (name: string) => {
    const all = props.filter((p) => p.name === name);
    if (all.length > 1) fail(`"${name}:" is given twice`, all[1].span);
    return all[0];
  };
  const strings = (p: AnalysisItem, what: string): string[] => {
    const list = Array.isArray(p.value) ? p.value : [p.value];
    return list.map((v) => (typeof v === "string" ? v : fail(`${what} should be text in quotes, got ${typeName(v)}`, p.span)));
  };

  const varyP = one("vary")!;
  const vary: StudyVariable[] = [];
  const entries = Array.isArray(varyP.value) ? varyP.value : [varyP.value];
  for (const v of entries) {
    if (!(v instanceof Obj) || v.kind !== STUDY_VARIABLE) fail("vary: lists parameters by name, like vary: [thickness, rib_h(2mm, 8mm)]", varyP.span);
    const f = (v as Obj).fields;
    const name = String(f.name);
    if (vary.some((x) => x.name === name)) fail(`vary: "${name}" is listed twice`, varyP.span);
    const prm = env.param?.(name);
    if (!prm) fail(`vary: "${name}" is not a parameter declared above this analysis. Declare it with param ${name} = … range a .. b.`, varyP.span);
    if (typeof prm!.value !== "number") fail(`vary: "${name}" is ${typeof prm!.value === "string" ? "text" : "true or false"}; a study varies numbers.`, varyP.span);
    if (prm!.locked) fail(`vary: "${name}" is locked. Unlock it to let the study change it.`, varyP.span);
    const value = prm!.value as number;
    const min = typeof f.min === "number" ? f.min : prm!.min;
    const max = typeof f.max === "number" ? f.max : prm!.max;
    if (min === undefined || max === undefined) {
      const lo = Math.abs(value) > 0 ? value * 0.5 : 0;
      const hi = Math.abs(value) > 0 ? value * 1.5 : 1;
      fail(`vary: "${name}" has no range to try. Give one here, like ${name}(${+lo.toPrecision(3)}, ${+hi.toPrecision(3)}), or on the param: range a .. b.`, varyP.span);
    }
    if (!(max! > min!)) fail(`vary: "${name}" needs its largest value above its smallest (got ${min} to ${max})`, varyP.span);
    let step = typeof f.step === "number" ? f.step : undefined;
    if (step !== undefined && !(step > 0 && step <= max! - min!)) fail(`vary: "${name}"'s step should be above 0 and no more than its range`, varyP.span);
    if (step === undefined && isCount({ value, text: prm!.text }) && Number.isInteger(min) && Number.isInteger(max)) step = 1;
    vary.push({ name, min: min!, max: max!, ...(step !== undefined ? { step } : {}) });
  }
  if (!vary.length) fail("vary: needs at least one parameter", varyP.span);
  if (vary.length > MAX_STUDY_VARIABLES) fail(`A study varies at most ${MAX_STUDY_VARIABLES} parameters at once; pick the ones that matter most.`, varyP.span);

  const goalP = one("goal");
  let goal: StudyGoal = { sense: "min", what: "mass", text: "min mass" };
  if (goalP) {
    if (typeof goalP.value !== "string") fail('goal: should be text like "min mass" or "max safety"', goalP.span);
    const g = parseGoal(goalP.value as string);
    if (typeof g === "string") fail(g, goalP.span);
    goal = g as StudyGoal;
  }

  const limits: StudyLimit[] = [];
  const keepP = one("keep");
  if (keepP)
    for (const s of strings(keepP, "keep:")) {
      const l = parseLimit(s);
      if (typeof l === "string") fail(l, keepP.span);
      limits.push(l as StudyLimit);
    }

  const usingP = one("using");
  const using = usingP ? strings(usingP, "using: (analysis labels)") : undefined;
  if (using && !using.length) fail("using: names at least one analysis", usingP!.span);

  const runsP = one("runs");
  let runs = Math.max(DEFAULT_STUDY_RUNS, 2 * vary.length + 4);
  if (runsP) {
    if (typeof runsP.value !== "number" || !Number.isInteger(runsP.value)) fail("runs: should be a whole number of designs, like runs: 16", runsP.span);
    runs = runsP.value as number;
    if (runs < 3 || runs > MAX_STUDY_RUNS) fail(`runs: should be between 3 and ${MAX_STUDY_RUNS} (each run builds and checks the whole design)`, runsP.span);
  }
  return { kind: "study", label, vary, goal, limits, ...(using ? { using } : {}), runs, span };
}

/** The value the evaluator gives one vary: entry. */
export function studyVariable(name: string, nums: number[]): Value {
  const fields: Record<string, Value> = { name };
  if (nums[0] !== undefined) fields.min = nums[0];
  if (nums[1] !== undefined) fields.max = nums[1];
  if (nums[2] !== undefined) fields.step = nums[2];
  return new Obj(fields, STUDY_VARIABLE, name);
}
