// A design study: change parameters within their ranges, build and check each
// design away from the open one, solve the analyses that cover the parts the
// parameters change, and find the best design that still passes everything.
// It spends few runs the way engineering optimisers do: a spread of designs
// across the ranges first, then a radial-basis surrogate of the goal and of
// every limit's margin picks the most promising untried design, which is then
// built and solved for real. The best one is confirmed at the analyses' own
// resolution at the end, since every run before that shares a coarse one.

import type { Model } from "../core/model";
import type { MeasuredResult } from "../agents/isolated";
import { withValues } from "../core/decisions";
import { materialDensity } from "../library/standards";
import { fmtNum } from "../lang/values";
import type { StructuralResult } from "./fe/structural";
import type { StructuralSpec, StudyGoal, StudyLimit, StudyMeasure, StudySpec } from "./spec";
import { structuralVerdict } from "./summary";
import { bucklingVerdict, temperatureVerdict } from "./thermalSummary";
import { vibrationVerdict } from "./dynamics";
import { MEASURE_UNIT } from "./studyLang";

type Verdict = "pass" | "warn" | "fail";

export interface StudyDeps {
  /** build, check and measure a design away from the open one */
  measure(src: string, onStage?: (s: string) => void): Promise<MeasuredResult>;
  /** solve one analysis of a built design; draft: the coarse resolution every run shares */
  analyse(spec: StructuralSpec, model: Model, built: MeasuredResult, draft: boolean, signal?: AbortSignal): Promise<StructuralResult>;
  /** designs built at once */
  parallel: number;
  progress?(p: StudyProgress): void;
}

export interface StudyProgress {
  done: number;
  total: number;
  stage: string;
  runs: StudyRun[];
  best: number | null;
}

/** A target or limit, its value and its margin (0 or more: it holds). */
export interface StudyCheck {
  text: string;
  value: number;
  margin: number;
  unit: string;
}

/** What one analysis said about one design. */
export interface StudyAnalysis {
  label: string;
  verdict: Verdict;
  error?: string;
  safety?: number;
  deflection?: number;
  stress?: number;
  frequency?: number;
  temperature?: number;
  buckling?: number;
}

export interface StudyRun {
  index: number;
  values: Record<string, number>;
  /** the design as it is now */
  current: boolean;
  status: "done" | "error";
  error?: string;
  /** the goal's value, in its unit (g, mm, MPa, Hz, °C, × or a safety factor) */
  goal: number | null;
  mass: number | null;
  checks: StudyCheck[];
  /** checks that pass in the current design and fail in this one */
  newFails: string[];
  analyses: StudyAnalysis[];
  feasible: boolean;
  ms: number;
}

export interface StudyResult {
  label: string;
  runs: StudyRun[];
  /** index of the best design that passes, if any did */
  best: number | null;
  /** how much the goal changes across each parameter's range, from the surrogate at the best design */
  sensitivity: { name: string; effect: number }[];
  /** the analyses solved for every design */
  using: string[];
  notes: string[];
  /** the best design solved again at the analyses' own resolution */
  confirmed?: { goal: number | null; checks: StudyCheck[]; analyses: StudyAnalysis[]; feasible: boolean };
  ms: number;
  stopped: boolean;
  /** the source it varied */
  base: string;
}

export class StudyError extends Error {}

// ---------- the parameters' box ----------

/** A round number near x: 1, 2 or 5 times a power of ten. */
function nice(x: number): number {
  const e = Math.floor(Math.log10(x));
  const f = x / 10 ** e;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * 10 ** e;
}

interface Box {
  names: string[];
  lo: number[];
  hi: number[];
  /** values snap to multiples of this from lo */
  q: number[];
}

function boxOf(spec: StudySpec): Box {
  return {
    names: spec.vary.map((v) => v.name),
    lo: spec.vary.map((v) => v.min),
    hi: spec.vary.map((v) => v.max),
    // a step when given, else about a two-hundredth of the range, so values stay readable
    q: spec.vary.map((v) => v.step ?? nice((v.max - v.min) / 200)),
  };
}

/** Parameter values for a point of the unit box, snapped to each step. */
function valuesAt(b: Box, x: number[]): number[] {
  return x.map((t, i) => {
    const span = b.hi[i] - b.lo[i];
    const steps = Math.round((Math.min(1, Math.max(0, t)) * span) / b.q[i]);
    const v = Math.min(b.hi[i], b.lo[i] + steps * b.q[i]);
    return +v.toPrecision(10);
  });
}

const unitOf = (b: Box, v: number[]) => v.map((x, i) => (x - b.lo[i]) / (b.hi[i] - b.lo[i]));
const keyOf = (v: number[]) => v.join("|");

/** A repeatable random sequence (mulberry32), so a study tries the same designs each time it runs on the same design. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i]));

/** A spread of designs across the box: a grid for one or two parameters, otherwise the best-spread of several Latin hypercubes. */
export function spreadPoints(n: number, count: number, rand: () => number): number[][] {
  if (count <= 0) return [];
  if (n === 1) {
    const k = Math.max(2, count);
    return Array.from({ length: k }, (_, i) => [i / (k - 1)]);
  }
  if (n === 2 && count >= 9)
    return [0, 0.5, 1].flatMap((a) => [0, 0.5, 1].map((b) => [a, b]));
  if (n === 2 && count >= 5) return [[0, 0], [0, 1], [1, 0], [1, 1], [0.5, 0.5]];
  let best: number[][] = [];
  let bestGap = -1;
  for (let trial = 0; trial < 24; trial++) {
    const cols = Array.from({ length: n }, () => {
      const order = Array.from({ length: count }, (_, i) => i);
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      return order.map((o) => (count === 1 ? 0.5 : (o + 0.5) / count));
    });
    const pts = Array.from({ length: count }, (_, i) => cols.map((c) => c[i]));
    let gap = Infinity;
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) gap = Math.min(gap, dist(pts[i], pts[j]));
    if (gap > bestGap) {
      bestGap = gap;
      best = pts;
    }
  }
  return best;
}

// ---------- the surrogate ----------

/**
 * A cubic radial-basis interpolant with a linear tail (a constant one with too few points), on standardised values.
 * Returns null when the points do not determine one.
 */
export function fitSurrogate(X: number[][], y: number[]): ((x: number[]) => number) | null {
  const m = X.length;
  if (!m) return null;
  const n = X[0].length;
  const mean = y.reduce((a, b) => a + b, 0) / m;
  const sd = Math.sqrt(y.reduce((a, b) => a + (b - mean) ** 2, 0) / m) || 1;
  const ys = y.map((v) => (v - mean) / sd);
  if (m === 1) return () => mean;
  const tail = m >= n + 2 ? n + 1 : 1;
  const N = m + tail;
  const A = Array.from({ length: N }, () => new Float64Array(N));
  const b = new Float64Array(N);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) A[i][j] = dist(X[i], X[j]) ** 3;
    A[i][i] += 1e-10;
    A[i][m] = A[m][i] = 1;
    if (tail > 1)
      for (let k = 0; k < n; k++) {
        A[i][m + 1 + k] = X[i][k];
        A[m + 1 + k][i] = X[i][k];
      }
    b[i] = ys[i];
  }
  const w = solveDense(A, b);
  if (!w) return null;
  return (x: number[]) => {
    let s = w[m];
    for (let i = 0; i < m; i++) s += w[i] * dist(x, X[i]) ** 3;
    if (tail > 1) for (let k = 0; k < n; k++) s += w[m + 1 + k] * x[k];
    return mean + sd * s;
  };
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solveDense(A: Float64Array[], b: Float64Array): Float64Array | null {
  const N = b.length;
  const M = A.map((r) => Float64Array.from(r));
  const x = Float64Array.from(b);
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    [x[c], x[p]] = [x[p], x[c]];
    for (let r = c + 1; r < N; r++) {
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k < N; k++) M[r][k] -= f * M[c][k];
      x[r] -= f * x[c];
    }
  }
  for (let c = N - 1; c >= 0; c--) {
    let s = x[c];
    for (let k = c + 1; k < N; k++) s -= M[c][k] * x[k];
    x[c] = s / M[c][c];
  }
  return x.every(Number.isFinite) ? x : null;
}

// ---------- measuring one design ----------

const made = (m: Model) => m.parts.filter((p) => p.kind === "part");

/** Mass in grams of every made part, or of the parts called `of`; null when one did not build. */
export function designMass(model: Model, built: MeasuredResult, of?: string): number | null {
  const parts = made(model).filter((p) => !of || p.name === of);
  if (!parts.length) return null;
  let g = 0;
  for (const p of parts) {
    const v = built.parts.get(p.hash)?.volume;
    if (v === undefined) return null;
    g += (v / 1000) * materialDensity(p.material);
  }
  return g;
}

/** The safety factor a study judges by: a short way off a support or load when the lowest sits right at one (a singularity of the idealised fixing). */
const studySafety = (r: StructuralResult) => (r.minSafety.nearBoundary && r.minSafety.away ? Math.max(r.minSafety.value, r.minSafety.away.value) : r.minSafety.value);
const studyStress = (r: StructuralResult) => (r.maxStress.nearBoundary && r.maxStress.away ? r.maxStress.away.value : r.maxStress.value);
const loaded = (r: StructuralResult) => !r.heatOnly && (r.maxDisp.value > 0 || !r.modal);

function summarise(spec: StructuralSpec, r: StructuralResult): StudyAnalysis {
  return {
    label: spec.label,
    verdict: structuralVerdict(spec, r),
    ...(loaded(r) ? { safety: studySafety(r), deflection: r.maxDisp.value, stress: studyStress(r) } : {}),
    ...(r.modal?.modes[0] ? { frequency: r.modal.modes[0].freq } : {}),
    ...(r.thermal ? { temperature: r.thermal.maxTemp.value } : {}),
    ...(r.buckling?.factors.length ? { buckling: r.buckling.factors[0] } : {}),
  };
}

/** Each analysis's own targets as margins: its safety target, max_deflection:, temperature limits, buckling target, resonances. */
function targetChecks(spec: StructuralSpec, r: StructuralResult): StudyCheck[] {
  const out: StudyCheck[] = [];
  const name = `"${spec.label}"`;
  if (loaded(r)) {
    const s = studySafety(r);
    out.push({ text: `safety of ${name} ≥ ${fmtNum(spec.safety, 2)}`, value: s, margin: Math.min(s, 1e3) / spec.safety - 1, unit: "" });
  }
  if (spec.maxDeflection !== undefined && !r.heatOnly) out.push({ text: `deflection of ${name} ≤ ${fmtNum(spec.maxDeflection, 3)} mm`, value: r.maxDisp.value, margin: 1 - r.maxDisp.value / spec.maxDeflection, unit: "mm" });
  const tv = temperatureVerdict(r);
  if (tv && r.thermal) out.push({ text: `${tv.worst.name} under ${fmtNum(tv.worst.limit, 0)} °C`, value: tv.worst.max, margin: tv.margin / Math.max(tv.worst.limit - r.thermal.ambient, 1), unit: "°C" });
  const bv = bucklingVerdict(spec, r);
  if (bv && bv.factor !== null) out.push({ text: `buckling of ${name} ≥ ${fmtNum(spec.buckling!.safety, 1)}×`, value: bv.factor, margin: bv.factor / spec.buckling!.safety - 1, unit: "×" });
  if (spec.modal?.excite.length) {
    const v = vibrationVerdict(spec, r);
    out.push({ text: `${name} clear of resonance`, value: v === "fail" ? 0 : 1, margin: v === "fail" ? -1 : 0.25, unit: "" });
  }
  return out;
}

/** A measure of one design: its mass, or the worst value among the analyses (or the one named). */
export function measureOf(what: StudyMeasure, of: string | undefined, mass: (of?: string) => number | null, analyses: StudyAnalysis[]): number | null {
  if (what === "mass") return mass(of);
  const from = analyses.filter((a) => (!of || a.label === of) && a[what] !== undefined).map((a) => a[what]!);
  if (!from.length) return null;
  // the worst one: lowest safety, frequency and buckling factor; highest deflection, stress and temperature
  return what === "safety" || what === "frequency" || what === "buckling" ? Math.min(...from) : Math.max(...from);
}

function limitCheck(l: StudyLimit, value: number | null): StudyCheck {
  if (value === null) return { text: l.text, value: NaN, margin: -1, unit: MEASURE_UNIT[l.what] };
  const scale = Math.max(Math.abs(l.value), 1e-9);
  return { text: l.text, value, margin: (l.op === "<=" ? l.value - value : value - l.value) / scale, unit: MEASURE_UNIT[l.what] };
}

/** "of": a part for mass, an analysis for the rest. */
function checkOf(what: StudyMeasure, of: string | undefined, model: Model, using: StructuralSpec[], where: string) {
  if (!of) return;
  if (what === "mass") {
    if (!made(model).some((p) => p.name === of)) throw new StudyError(`${where} names "${of}", which is not a made part of this design.`);
  } else if (!using.some((s) => s.label === of)) throw new StudyError(`${where} names "${of}", which is not one of the analyses the study solves (${using.map((s) => `"${s.label}"`).join(", ") || "none"}).`);
}

/** The analyses a study solves: those named in using:, else the structural ones the varied parameters reach. */
export function studyAnalyses(spec: StudySpec, model: Model): StructuralSpec[] {
  const structural = model.analyses.filter((a): a is StructuralSpec => a.kind === "structural");
  if (spec.using) {
    const out = spec.using.map((l) => {
      const a = model.analyses.find((x) => x.label === l);
      if (!a) throw new StudyError(`using: "${l}" is not an analysis of this design. Analyses: ${model.analyses.map((x) => `"${x.label}"`).join(", ")}.`);
      if (a.kind !== "structural") throw new StudyError(`using: "${l}" is a ${a.kind} analysis; a study solves strength, heat, vibration and buckling analyses.`);
      return a;
    });
    return out;
  }
  // everything the parameters reach through the dependency graph
  const next = new Map<string, string[]>();
  for (const e of model.graph.edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set<string>(spec.vary.map((v) => v.name));
  const todo = [...seen];
  while (todo.length) for (const t of next.get(todo.pop()!) ?? []) if (!seen.has(t)) seen.add(t), todo.push(t);
  return structural.filter((a) => seen.has(`analysis:${a.label}`) || a.parts.some((p) => seen.has(p))).slice(0, 3);
}

/** the margin the surrogate must predict before a design counts as likely to pass */
const SAFE = 0.004;
const TIME_LIMIT_MS = 20 * 60_000;

/** Run a design study on a design that has built, from its source and model. */
export async function runStudy(spec: StudySpec, source: string, model: Model, deps: StudyDeps, signal?: AbortSignal): Promise<StudyResult> {
  const t0 = Date.now();
  const using = studyAnalyses(spec, model);
  const goal: StudyGoal = spec.goal;
  if (goal.what !== "mass" && !using.length)
    throw new StudyError(`The goal "${goal.text}" comes from an analysis, but no structural analysis covers the parts these parameters change. Name one with using:.`);
  checkOf(goal.what, goal.of, model, using, `goal: "${goal.text}"`);
  for (const l of spec.limits) {
    checkOf(l.what, l.of, model, using, `keep: "${l.text}"`);
    if (l.what !== "mass" && !using.length) throw new StudyError(`keep: "${l.text}" comes from an analysis, but the study solves none. Name one with using:.`);
  }
  for (const v of spec.vary) {
    const p = model.params.find((x) => x.name === v.name);
    if (!p) throw new StudyError(`vary: "${v.name}" is no longer a parameter of the design.`);
  }

  const box = boxOf(spec);
  const now = box.names.map((n) => model.params.find((p) => p.name === n)!.value as number);
  const runs: StudyRun[] = [];
  const tried = new Map<string, number>();
  const notes: string[] = [];
  let baseStatus = new Map<string, string>();
  let bestBuilt: { run: StudyRun; built: MeasuredResult } | null = null;
  const sign = goal.sense === "min" ? 1 : -1;
  const better = (a: StudyRun, b: StudyRun | null) => !b || (a.goal !== null && b.goal !== null && sign * a.goal < sign * b.goal);
  const bestRun = () => runs.filter((r) => r.feasible && r.goal !== null).reduce<StudyRun | null>((b, r) => (better(r, b) ? r : b), null);
  const report = (stage: string) => deps.progress?.({ done: runs.length, total: spec.runs, stage, runs: [...runs], best: bestRun()?.index ?? null });

  const evaluateOne = async (vals: number[], current: boolean): Promise<StudyRun> => {
    const t = Date.now();
    const values = Object.fromEntries(box.names.map((n, i) => [n, vals[i]]));
    const run: StudyRun = { index: runs.length, values, current, status: "done", goal: null, mass: null, checks: [], newFails: [], analyses: [], feasible: false, ms: 0 };
    runs.push(run);
    tried.set(keyOf(vals), run.index);
    try {
      const src = current ? source : withValues(source, model, values);
      const built = await deps.measure(src);
      if (built.error && !built.report) throw new Error(built.error);
      const m = built.model;
      if (m.diagnostics.some((d) => d.severity === "error")) throw new Error(m.diagnostics.find((d) => d.severity === "error")!.message);
      const items = (built.report?.items ?? []).filter((i) => !i.id.startsWith("fea:"));
      if (current) baseStatus = new Map(items.map((i) => [i.id, i.status]));
      else run.newFails = items.filter((i) => i.status === "fail" && baseStatus.get(i.id) !== "fail").map((i) => i.title);
      for (const a of using) {
        const s = m.analyses.find((x): x is StructuralSpec => x.kind === "structural" && x.label === a.label) ?? a;
        try {
          const r = await deps.analyse(s, m, built, true, signal);
          run.analyses.push(summarise(s, r));
          run.checks.push(...targetChecks(s, r));
        } catch (e) {
          run.analyses.push({ label: a.label, verdict: "fail", error: e instanceof Error ? e.message : String(e) });
          run.checks.push({ text: `"${a.label}" solves`, value: 0, margin: -1, unit: "" });
        }
      }
      const mass = (of?: string) => designMass(m, built, of);
      run.mass = mass();
      run.goal = measureOf(goal.what, goal.of, mass, run.analyses);
      for (const l of spec.limits) run.checks.push(limitCheck(l, measureOf(l.what, l.of, mass, run.analyses)));
      run.feasible = run.goal !== null && !run.newFails.length && run.checks.every((c) => c.margin >= 0) && run.analyses.every((a) => a.verdict !== "fail");
      if (run.feasible && (!bestBuilt || better(run, bestBuilt.run))) bestBuilt = { run, built };
    } catch (e) {
      run.status = "error";
      run.error = e instanceof Error ? e.message : String(e);
    }
    run.ms = Date.now() - t;
    return run;
  };

  const stopped = () => !!signal?.aborted || Date.now() - t0 > TIME_LIMIT_MS;
  const batch = async (points: number[][]) => {
    for (let i = 0; i < points.length && !stopped(); i += deps.parallel) {
      const chunk = points.slice(i, i + deps.parallel);
      report(`Building and solving design${chunk.length > 1 ? "s" : ""} ${runs.length + 1}${chunk.length > 1 ? `–${runs.length + chunk.length}` : ""} of ${spec.runs}`);
      await Promise.all(chunk.map((v) => evaluateOne(v, false)));
    }
  };

  // the current design first: what every other one is compared with
  report("Building and solving the current design");
  const base = await evaluateOne(now, true);
  if (base.status === "error") throw new StudyError(`The current design could not be measured: ${base.error}`);

  // a spread across the ranges
  const n = box.names.length;
  const rand = rng(0x5eed + n * 977 + spec.runs);
  const left = spec.runs - 1;
  const spread = n === 1 ? Math.min(5, left) : n === 2 ? (left >= 12 ? 9 : Math.min(5, left)) : Math.min(left - (left >= 6 ? 2 : 0), Math.max(n + 3, Math.round(0.5 * left)));
  const first: number[][] = [];
  for (const u of spreadPoints(n, spread, rand)) {
    const v = valuesAt(box, u);
    if (!tried.has(keyOf(v)) && !first.some((f) => keyOf(f) === keyOf(v))) first.push(v);
  }
  await batch(first.slice(0, left));

  // then the surrogate's picks
  let stale = 0;
  while (runs.length < spec.runs && !stopped()) {
    const okRuns = runs.filter((r) => r.status === "done" && r.goal !== null);
    if (okRuns.length < 2) break;
    const X = okRuns.map((r) => unitOf(box, box.names.map((nm) => r.values[nm])));
    const fGoal = fitSurrogate(X, okRuns.map((r) => sign * r.goal!));
    const keys = [...new Set(okRuns.flatMap((r) => r.checks.map((c) => c.text)))];
    const fChecks = keys.map((k) => fitSurrogate(X, okRuns.map((r) => r.checks.find((c) => c.text === k)?.margin ?? -1)));
    const fFails = fitSurrogate(X, okRuns.map((r) => (r.newFails.length ? -r.newFails.length : 0.5)));
    if (!fGoal) break;
    const before = bestRun();
    const anchor = before ? unitOf(box, box.names.map((nm) => before.values[nm])) : X[okRuns.reduce((bi, r, i) => (Math.min(...r.checks.map((c) => c.margin), 0) > Math.min(...okRuns[bi].checks.map((c) => c.margin), 0) ? i : bi), 0)];
    const cands: number[][] = [];
    for (let i = 0; i < 1500; i++) cands.push(box.names.map(() => rand()));
    // near the best so far, wide and close, so the last runs settle onto the edge of what passes
    for (let i = 0; i < 600; i++) cands.push(anchor.map((a) => Math.min(1, Math.max(0, a + 0.15 * gauss(rand)))));
    for (let i = 0; i < 400; i++) cands.push(anchor.map((a) => Math.min(1, Math.max(0, a + 0.03 * gauss(rand)))));
    const scored: { v: number[]; u: number[]; g: number; worst: number }[] = [];
    const seen = new Set<string>();
    for (const c of cands) {
      const v = valuesAt(box, c);
      const k = keyOf(v);
      if (tried.has(k) || seen.has(k)) continue;
      seen.add(k);
      const u = unitOf(box, v);
      if (X.some((x) => dist(x, u) < 0.008)) continue;
      const margins = fChecks.map((f) => (f ? f(u) : 0));
      if (fFails) margins.push(fFails(u));
      scored.push({ v, u, g: fGoal(u), worst: margins.length ? Math.min(...margins) : 1 });
    }
    if (!scored.length) break;
    const feasible = scored.filter((s) => s.worst >= SAFE);
    const order = feasible.length ? feasible.sort((a, b) => a.g - b.g) : scored.sort((a, b) => b.worst - a.worst);
    const picks: typeof order = [];
    for (const s of order) {
      if (picks.length >= Math.min(deps.parallel, spec.runs - runs.length)) break;
      if (picks.every((p) => dist(p.u, s.u) > 0.12)) picks.push(s);
    }
    await batch(picks.map((p) => p.v));
    const after = bestRun();
    const gain = before && after && before.goal !== null && after.goal !== null ? (sign * (before.goal - after.goal)) / Math.max(Math.abs(before.goal), 1e-9) : after && !before ? 1 : 0;
    stale = gain > 0.002 ? 0 : stale + 1;
    if (stale >= 3 && runs.length >= first.length + 5) {
      notes.push("The study stopped early: the last designs it tried no longer improved on the best one.");
      break;
    }
  }

  const best = bestRun();
  // what matters: the goal across each parameter's range, the others held at the best design
  const ok = runs.filter((r) => r.status === "done" && r.goal !== null);
  const sensitivity: StudyResult["sensitivity"] = [];
  const fit = ok.length >= 3 ? fitSurrogate(ok.map((r) => unitOf(box, box.names.map((nm) => r.values[nm]))), ok.map((r) => r.goal!)) : null;
  if (fit) {
    const at = unitOf(box, box.names.map((nm) => (best ?? base).values[nm]));
    box.names.forEach((nm, i) => {
      const lo = [...at];
      const hi = [...at];
      lo[i] = 0;
      hi[i] = 1;
      sensitivity.push({ name: nm, effect: fit(hi) - fit(lo) });
    });
    sensitivity.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  }

  // the best one again at the analyses' own resolution
  let confirmed: StudyResult["confirmed"];
  const top = bestBuilt as { run: StudyRun; built: MeasuredResult } | null;
  if (top && best && top.run.index === best.index && using.length && !stopped()) {
    report("Confirming the best design at the analyses' own resolution");
    const analyses: StudyAnalysis[] = [];
    const checks: StudyCheck[] = [];
    const m = top.built.model;
    for (const a of using) {
      const s = m.analyses.find((x): x is StructuralSpec => x.kind === "structural" && x.label === a.label) ?? a;
      try {
        const r = await deps.analyse(s, m, top.built, false, signal);
        analyses.push(summarise(s, r));
        checks.push(...targetChecks(s, r));
      } catch (e) {
        analyses.push({ label: a.label, verdict: "fail", error: e instanceof Error ? e.message : String(e) });
      }
    }
    const mass = (of?: string) => designMass(m, top.built, of);
    for (const l of spec.limits) checks.push(limitCheck(l, measureOf(l.what, l.of, mass, analyses)));
    const g = measureOf(goal.what, goal.of, mass, analyses);
    confirmed = { goal: g, checks, analyses, feasible: checks.every((c) => c.margin >= 0) && analyses.every((a) => a.verdict !== "fail" && !a.error) };
    if (!confirmed.feasible) notes.push("At the analyses' own resolution the best design no longer meets every target, so the coarse runs were optimistic near the limit: take the next best, or keep a little more margin.");
  }
  if (!best) notes.push(base.feasible ? "No design the study tried beat the current one while passing everything." : "No design the study tried passes everything, the current one included: widen the ranges, relax a limit or add a parameter that matters.");
  if (signal?.aborted) notes.push("Stopped before the study finished; the results so far are below.");
  else if (Date.now() - t0 > TIME_LIMIT_MS) notes.push(`Stopped after ${Math.round(TIME_LIMIT_MS / 60000)} minutes; the results so far are below.`);
  report("Done");
  return { label: spec.label, runs, best: best?.index ?? null, sensitivity, using: using.map((s) => s.label), notes, ...(confirmed ? { confirmed } : {}), ms: Date.now() - t0, stopped: !!signal?.aborted, base: source };
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
