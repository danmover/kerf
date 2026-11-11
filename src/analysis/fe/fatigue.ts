// Fatigue from a linear static result. The stresses everywhere are those of the loads as written; a load history
// scales them cycle by cycle (the loads keep their shape, so every point's stress scales with them), each cycle is
// judged against the material's S-N curve after a mean-stress correction, and the damage adds up by Miner's rule.
// The safety factor is the factor on the loads at which the damage over the design life reaches 1.
//
// S-N curve (Shigley's estimate, from the material's ultimate and fatigue strengths): from the ultimate strength at
// one cycle to 0.9 of it at 10³ cycles, then a straight line on log-log axes to the fatigue strength at 10⁷ cycles,
// which the surface finish and reliability factors lower (Marin). Past 10⁷ steels, irons and titanium hold an
// endurance limit; aluminium, copper alloys and plastics keep weakening, about 10 % per decade.

import type { MechMaterial } from "../materials";

export type MeanStress = "goodman" | "gerber" | "soderberg" | "swt" | "none";
export type Finish = "polished" | "ground" | "machined" | "hot-rolled" | "forged" | "cast" | "printed";

export const MEAN_STRESS: Record<MeanStress, string> = {
  goodman: "Goodman",
  gerber: "Gerber",
  soderberg: "Soderberg",
  swt: "Smith-Watson-Topper",
  none: "no mean-stress correction",
};

export const FINISHES: Record<Finish, string> = {
  polished: "polished",
  ground: "ground",
  machined: "machined",
  "hot-rolled": "hot-rolled",
  forged: "as forged",
  cast: "as cast",
  printed: "as printed",
};

/** One kind of load cycle, as scales of the analysis's loads (1 = the loads as written): from min to max, count times. */
export interface LoadCycle {
  max: number;
  min: number;
  count: number;
}

/** A fatigue set-up, as the analysis worker gets it. */
export interface FatigueInput {
  /** the counted cycles of one pass of the history (constant amplitude: one kind, counted the design life's cycles) */
  cycles: LoadCycle[];
  /** how many times the history happens in the part's life (constant amplitude: 1) */
  repeats: number;
  /** what the life is counted in: load cycles (constant amplitude) or passes of a history */
  unit: "cycles" | "repeats";
  meanStress: MeanStress;
  /** surface finish per material (same order as the analysis's materials) */
  finishes: Finish[];
  /** chance of lasting the life, 0.5 (the mean curve) to 0.9999 */
  reliability: number;
  /** how the loads repeat, for messages */
  loading: string;
}

/** The corrected S-N curve of one material. */
export interface SnCurve {
  /** ultimate strength, MPa (strength at one cycle) */
  su: number;
  /** yield strength, for Soderberg */
  sy: number;
  /** strength at 10³ cycles */
  s3: number;
  /** fatigue strength at 10⁷ cycles after the Marin factors */
  se: number;
  /** surface factor ka and reliability factor ke */
  ka: number;
  ke: number;
  /** past 10⁷ cycles: an endurance limit, or a slope of about 10 % per decade */
  tail: "flat" | "falling";
  finish: Finish;
}

const KNEE = 1e7;
/** past this many cycles damage is counted as none */
export const INFINITE_LIFE = 1e15;
const TAIL_PER_DECADE = 0.9;

/** Steels, irons and titanium have an endurance limit; other metals and plastics keep weakening. */
export function hasEnduranceLimit(m: MechMaterial): boolean {
  return /steel|iron|stainless|titanium|ti-?6|4140|chromoly/i.test(m.name) && m.E > 90000;
}

export const isMetal = (m: MechMaterial) => m.E >= 40000 || /alumin|steel|iron|brass|bronze|copper|titanium|zamak|alsi/i.test(m.name);

/**
 * Surface factor (Marin ka) from Shigley's fits ka = a·Su^b for metals. Plastics' fatigue strengths are already for
 * printed or moulded parts, so their finish does not lower them further; a printed metal part's rough skin about halves
 * its fatigue strength.
 */
export function surfaceFactor(m: MechMaterial, finish: Finish): number {
  if (!isMetal(m) || finish === "polished") return 1;
  const su = Math.max(m.uts, 1);
  const fit: Record<Exclude<Finish, "polished" | "printed">, [number, number]> = {
    ground: [1.58, -0.085],
    machined: [4.51, -0.265],
    "hot-rolled": [57.7, -0.718],
    forged: [272, -0.995],
    // a cast skin is about as rough as hot-rolled stock
    cast: [57.7, -0.718],
  };
  if (finish === "printed") return 0.55;
  const [a, b] = fit[finish];
  return Math.min(1, a * Math.pow(su, b));
}

/** Reliability factor (Marin ke = 1 − 0.08·z) for the chance of lasting the life. */
export function reliabilityFactor(r: number): number {
  if (!(r > 0.5)) return 1;
  return Math.max(0.5, 1 - 0.08 * normalQuantile(Math.min(r, 0.999999)));
}

/** z with Φ(z) = p (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** A material's S-N curve, with its strengths scaled by k (the knock-down between print layers). */
export function snCurve(m: MechMaterial, finish: Finish, reliability: number, k = 1): SnCurve {
  const su = Math.max(m.uts, m.yield, 1e-6) * k;
  const s3 = 0.9 * su;
  const ka = surfaceFactor(m, finish);
  const ke = reliabilityFactor(reliability);
  // a fatigue strength above the 10³ value would turn the curve upwards
  const se = Math.min(m.fatigue * k * ka * ke, 0.99 * s3);
  return { su, sy: Math.max(m.yield * k, 1e-6), s3, se, ka, ke, tail: hasEnduranceLimit(m) ? "flat" : "falling", finish };
}

/** Cycles to failure at a fully reversed stress amplitude (MPa) on a curve. */
export function cyclesAt(c: SnCurve, s: number): number {
  if (!(s > 0)) return Infinity;
  if (s >= c.su) return 0.5;
  if (s > c.s3) return Math.pow(10, (3 * Math.log(s / c.su)) / Math.log(c.s3 / c.su));
  if (s > c.se) {
    const b = Math.log10(c.se / c.s3) / 4;
    return 1e3 * Math.pow(s / c.s3, 1 / b);
  }
  if (c.tail === "flat") return Infinity;
  const n = KNEE * Math.pow(10, Math.log(c.se / s) / Math.log(1 / TAIL_PER_DECADE));
  return n > INFINITE_LIFE ? Infinity : n;
}

/** The fully reversed stress amplitude a curve takes for a number of cycles (inverse of cyclesAt). */
export function strengthAt(c: SnCurve, n: number): number {
  if (n <= 1) return c.su;
  if (n <= 1e3) return c.su * Math.pow(c.s3 / c.su, Math.log10(n) / 3);
  if (n <= KNEE) {
    const b = Math.log10(c.se / c.s3) / 4;
    return c.s3 * Math.pow(n / 1e3, b);
  }
  if (c.tail === "flat") return c.se;
  return c.se * Math.pow(TAIL_PER_DECADE, Math.log10(n / KNEE));
}

/**
 * The fully reversed amplitude that does as much damage as a cycle between two stresses (MPa), after the mean-stress
 * correction. Infinity: the cycle's mean or peak alone breaks it; 0: no damage (a fully compressive cycle under SWT).
 */
export function equivalentAmplitude(smax: number, smin: number, c: SnCurve, mean: MeanStress): number {
  const sa = (smax - smin) / 2;
  if (!(sa > 0)) return 0;
  const sm = (smax + smin) / 2;
  switch (mean) {
    case "none":
      return sa;
    case "swt":
      return smax > 0 ? Math.sqrt(smax * sa) : 0;
    case "goodman":
      if (sm <= 0) return sa;
      return sm >= c.su ? Infinity : sa / (1 - sm / c.su);
    case "gerber":
      if (sm <= 0) return sa;
      return sm >= c.su ? Infinity : sa / (1 - (sm / c.su) ** 2);
    case "soderberg":
      if (sm <= 0) return sa;
      return sm >= c.sy ? Infinity : sa / (1 - sm / c.sy);
  }
}

/**
 * Damage over one pass of the cycles at a point whose stress is sigma (MPa, signed) under the loads as written: each
 * cycle runs between its min and max scale of that stress. tensionOnly: a cycle that never pulls does no harm (layers
 * pressed together do not come apart).
 */
export function damageOf(sigma: number, cycles: LoadCycle[], c: SnCurve, mean: MeanStress, tensionOnly = false): number {
  let d = 0;
  for (const cy of cycles) {
    const a = cy.max * sigma,
      b = cy.min * sigma;
    if (tensionOnly && Math.max(a, b) <= 0) continue;
    const sar = equivalentAmplitude(Math.max(a, b), Math.min(a, b), c, mean);
    if (!(sar > 0)) continue;
    if (sar === Infinity) return Infinity;
    const n = cyclesAt(c, sar);
    if (n === Infinity) continue;
    d += cy.count / n;
  }
  return d;
}

/**
 * The stress under the loads as written (MPa, of this sign) at which the damage over the design life reaches 1: a
 * point's fatigue safety factor is this over its own stress. Bisection on a log scale: damage only grows with stress.
 */
export function criticalStress(sign: 1 | -1, cycles: LoadCycle[], repeats: number, c: SnCurve, mean: MeanStress, tensionOnly = false): number {
  const dmg = (s: number) => repeats * damageOf(sign * s, cycles, c, mean, tensionOnly);
  let lo = 1e-6,
    hi = c.su * 4;
  // a cycle that only ever presses, judged by SWT, never breaks the part
  if (dmg(hi) < 1) {
    for (let k = 0; k < 8 && dmg(hi) < 1; k++) hi *= 10;
    if (dmg(hi) < 1) return Infinity;
  }
  for (let k = 0; k < 80; k++) {
    const mid = Math.sqrt(lo * hi);
    if (dmg(mid) >= 1) hi = mid;
    else lo = mid;
    if (hi / lo < 1 + 1e-7) break;
  }
  return Math.sqrt(lo * hi);
}

/**
 * Rainflow counting (ASTM E1049, four-point method) of a load trace. With repeat, the history happens again and again,
 * so it is turned to start and end at its largest peak and every cycle closes; otherwise what is left over counts as
 * half cycles. Equal cycles are merged.
 */
export function rainflow(series: number[], repeat = true): LoadCycle[] {
  // turning points
  const tp: number[] = [];
  for (const v of series) {
    if (!Number.isFinite(v)) continue;
    const n = tp.length;
    if (n && v === tp[n - 1]) continue;
    if (n >= 2 && (tp[n - 1] - tp[n - 2]) * (v - tp[n - 1]) > 0) tp[n - 1] = v;
    else tp.push(v);
  }
  if (tp.length < 2) return [];
  let pts = tp;
  if (repeat) {
    let k = 0;
    for (let i = 1; i < tp.length; i++) if (Math.abs(tp[i]) > Math.abs(tp[k])) k = i;
    const ring = [...tp.slice(k), ...tp.slice(0, k), tp[k]];
    // joining the end to the start can leave a point that is not a turn
    pts = [];
    for (const v of ring) {
      const n = pts.length;
      if (n && v === pts[n - 1]) continue;
      if (n >= 2 && (pts[n - 1] - pts[n - 2]) * (v - pts[n - 1]) > 0) pts[n - 1] = v;
      else pts.push(v);
    }
  }
  const out: LoadCycle[] = [];
  const add = (a: number, b: number, count: number) => out.push({ max: Math.max(a, b), min: Math.min(a, b), count });
  const stack: number[] = [];
  for (const p of pts) {
    stack.push(p);
    while (stack.length >= 3) {
      const n = stack.length;
      const X = Math.abs(stack[n - 1] - stack[n - 2]);
      const Y = Math.abs(stack[n - 2] - stack[n - 3]);
      if (X < Y) break;
      if (n === 3) {
        add(stack[0], stack[1], 0.5);
        stack.shift();
      } else {
        add(stack[n - 3], stack[n - 2], 1);
        stack.splice(n - 3, 2);
      }
    }
  }
  for (let i = 0; i + 1 < stack.length; i++) add(stack[i], stack[i + 1], 0.5);
  return mergeCycles(out);
}

/** Cycles with the same max and min added together, largest range first. */
export function mergeCycles(cycles: LoadCycle[]): LoadCycle[] {
  const m = new Map<string, LoadCycle>();
  for (const c of cycles) {
    const k = `${c.max.toPrecision(9)}|${c.min.toPrecision(9)}`;
    const e = m.get(k);
    if (e) e.count += c.count;
    else m.set(k, { ...c });
  }
  return [...m.values()].sort((a, b) => b.max - b.min - (a.max - a.min));
}

/** The share of the damage at a point that each kind of cycle does, largest first. */
export function damageShares(sigma: number, cycles: LoadCycle[], c: SnCurve, mean: MeanStress, tensionOnly = false): { cycle: LoadCycle; share: number }[] {
  const each = cycles.map((cy) => ({ cycle: cy, d: damageOf(sigma, [cy], c, mean, tensionOnly) }));
  const tot = each.reduce((a, e) => a + (Number.isFinite(e.d) ? e.d : 0), 0);
  if (!(tot > 0)) return [];
  return each
    .filter((e) => e.d > 0)
    .map((e) => ({ cycle: e.cycle, share: Number.isFinite(e.d) ? e.d / tot : 1 }))
    .sort((a, b) => b.share - a.share);
}

/** The largest scale of the loads in the history (the static check uses the loads at their worst). */
export function peakScale(cycles: LoadCycle[]): number {
  let p = 0;
  for (const c of cycles) p = Math.max(p, Math.abs(c.max), Math.abs(c.min));
  return p;
}

/** Words for a cycle: "0 to 1×", "−1 to 1×". */
export function cycleWords(c: LoadCycle): string {
  const f = (v: number) => String(Math.round(v * 100) / 100).replace("-", "−");
  return `${f(c.min)} to ${f(c.max)}× the loads`;
}
