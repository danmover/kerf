// Builds the design thousands of times over in numbers: every made part
// comes out a little off the way its process really makes it, every bought
// part somewhere inside its tolerance, and each fit, gear mesh and screw
// pattern is judged on every build. The answer is the share of builds in
// which something will not go together, cracks, binds or rattles, plus the
// drawn size that would fix it. Seeded, so the same design gives the same
// numbers every time.

import type { EvalPart, Model } from "../../core/model";
import type { CheckStatus } from "../../core/checks";
import { hashString, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type V3 } from "../../kernel/recipe";
import { centerDistance } from "../../library/gears";
import { materialRecord } from "../../library/materialDb";
import { axisDistance, fitsOnAxis, type FitDef, type FitInstance, type FoundFits, type GearPair, type ScrewJoint } from "./detect";
import type { Cyl } from "./geometry";
import { calledTolerance, describeScatter, diameterScatter, expansion, onItsSide, positionSigma, scaleScatter, shrinkCompensated, sourceOf, type Scatter, type Source } from "./scatter";

export const SAMPLES = 4000;

export type FitMode = "wont-fit" | "tight" | "cracks" | "creeps" | "slips" | "loose" | "preload" | "binds" | "misaligned";

export interface ModeRate {
  mode: FitMode;
  /** share of builds in which it happens (any instance of the fit) */
  rate: number;
  severity: "fail" | "warn";
  /** temperature it happens at, when only hot or cold */
  temp?: number;
}

export interface SideInfo {
  part: string;
  partId: string;
  d: number;
  how: string;
  /** as-made mean diameter and ± spread (3σ, or half the tolerance band) */
  mean: number;
  spread: number;
  side: boolean;
}

export interface FitOutcome {
  key: string;
  kind: FitDef["kind"] | "gear-mesh" | "screw-pattern";
  title: string;
  intent?: FitDef["intent"];
  status: CheckStatus;
  modes: ModeRate[];
  /** diametral clearance (negative: interference) as drawn and as made */
  nominal: number;
  made: { p01: number; p50: number; p99: number };
  /** histogram of the as-made clearance over `range`, and the band that works */
  hist: number[];
  range: [number, number];
  good: [number, number];
  hole?: SideInfo;
  shaft?: SideInfo;
  count: number;
  parts: string[];
  /** world positions of the instances and the axis, for markers on the model */
  at: V3[];
  axis: V3;
  detail: string;
  fix?: string;
}

export interface FitReport {
  outcomes: FitOutcome[];
  samples: number;
  temps: number[];
  ms: number;
}

// ---------- random numbers ----------

function rng(seed: string): () => number {
  let a = parseInt(hashString(seed).slice(0, 8), 16) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** `shared` is the build-by-build draw common to the part's material (see Scatter.common). */
function draw(s: Scatter, r: () => number, n: number, shared?: Float64Array): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = s.kind === "normal" ? s.mean + s.sigma * gauss(r) + (s.common && shared ? s.common * shared[i] : 0) : s.lo + (s.hi - s.lo) * r();
  return out;
}

/** One standard normal per build for each material: what that batch of plastic does in that room. */
function sharedDraws(seed: string, n: number): (material: string) => Float64Array {
  const by = new Map<string, Float64Array>();
  return (material) => {
    let z = by.get(material);
    if (!z) {
      const r = rng(`${seed}|${material}`);
      z = new Float64Array(n);
      for (let i = 0; i < n; i++) z[i] = gauss(r);
      by.set(material, z);
    }
    return z;
  };
}

function quantile(sorted: Float64Array, q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

// ---------- limits ----------

const isPlastic = (material: string) => (materialRecord(material)?.category ?? "plastic") !== "metal";

/** Strain the hole's material takes at its bore without yielding (or, for brittle plastics, cracking). */
function yieldStrain(material: string): number {
  const m = materialRecord(material);
  if (!m) return 0.015;
  return m.mech.yield / m.mech.E;
}

/** Clearance above which a fit stops doing its job. `turns`: the part inside the bearing ring (or the ring's housing) rotates. */
function looseLimit(kind: FitDef["kind"], d: number, turns = true): number {
  switch (kind) {
    case "bearing-seat":
      // an outer ring that turns with its housing must grip; one in a still housing may slide a little (H7)
      return turns ? 0.02 + 0.0004 * d : 0.03 + 0.0005 * d;
    case "bearing-shaft":
      // an inner ring on a turning shaft must grip or it creeps round and wears the shaft; on a still one it may slide (g6)
      return turns ? 0.02 + 0.0004 * d : 0.06 + 0.0015 * d;
    case "gear-bore":
      return 0.06 + 0.002 * d;
    case "pin":
      return 0.1 + 0.004 * d;
    case "locating":
      return 0.5;
    case "screw":
      return 0.4 * d;
    default:
      return Infinity;
  }
}

/** Interference a plastic part can be pushed past by hand: the plastic gives. */
const pushLimit = (d: number) => 0.03 + 0.003 * d;

interface Judged {
  /** severity of each mode for one clearance value; null when it works */
  (c: number): FitMode | null;
}

/** `expected`: the mean clearance as made. */
function judge(f: FitDef, inst: FitInstance, holeSrc: Source, shaftSrc: Source, expected: number): { at: Judged; good: [number, number]; intent: FitDef["intent"]; severity: Record<FitMode, "fail" | "warn"> } {
  const d = inst.hole.d;
  const plasticHole = isPlastic(holeSrc.material);
  const plasticShaft = isPlastic(shaftSrc.material);
  const plastic = plasticHole || plasticShaft;
  const turns = f.kind === "bearing-seat" ? !!inst.hole.part.motion : f.kind === "bearing-shaft" ? !!inst.shaft.part.motion : true;
  // a clearance that comes out wider than the fit's loose limit, once the process has had its say (printed
  // holes close up), is a pass-through hole on purpose: a bushing held by its nut, a knob on a set screw
  const limit = looseLimit(f.kind, d, turns);
  const passThrough = f.kind !== "bearing-seat" && f.kind !== "bearing-shaft" && f.kind !== "gear-bore" && expected > limit;
  const intent = passThrough ? "clearance" : f.intent;
  const loose = passThrough ? Infinity : limit;
  // plastic gives way: a little interference pushes in by hand, more needs a vice; metal on metal takes a
  // press up to about 0.0025 d + 0.01 mm, beyond that it needs heating or galls
  const pressLimit = plastic ? pushLimit(d) : 0.0025 * d + 0.01;
  // hoop strain at the bore of a hub about twice the bore's size is about 0.6 × interference / d;
  // a plastic pin squeezed by a metal bore takes about interference / d
  const eyH = yieldStrain(holeSrc.material);
  const eyS = yieldStrain(shaftSrc.material);
  const crackAt = plasticHole ? -(eyH * d) / 0.6 : plasticShaft ? -0.8 * eyS * d : -Math.max((eyH * d) / 0.6, pressLimit);
  const crackMode: FitMode = plasticHole ? "cracks" : "wont-fit";
  // plastic under constant strain relaxes: past its creep limit the grip fades over months
  const creepH = materialRecord(holeSrc.material)?.creepLimit;
  const creepS = materialRecord(shaftSrc.material)?.creepLimit;
  const creepAt = plasticHole && creepH !== undefined ? -(creepH * eyH * d) / 0.6 : plasticShaft && creepS !== undefined ? -creepS * eyS * d : -Infinity;
  const bearingMetal = (f.kind === "bearing-seat" || f.kind === "bearing-shaft") && !plastic;
  const severity: Record<FitMode, "fail" | "warn"> = { "wont-fit": "fail", cracks: "fail", binds: "fail", misaligned: "fail", tight: "warn", creeps: "warn", slips: "warn", loose: "warn", preload: "warn" };
  if (intent === "clearance") {
    return {
      at: (c) => (c <= -pressLimit ? "wont-fit" : c <= 0 ? "tight" : c > loose ? "loose" : null),
      good: [0, loose],
      intent,
      severity,
    };
  }
  // press and transition fits: the hole is meant to grip
  const preloadAt = -0.012 - 0.0003 * d;
  return {
    at: (c) => {
      if (c < crackAt) return crackMode;
      if (bearingMetal && c < preloadAt) return "preload";
      if (c < creepAt) return "creeps";
      if (intent === "press" && c > 0) return "slips";
      if (c > loose) return "loose";
      return null;
    },
    good: [Math.max(crackAt, creepAt, bearingMetal ? preloadAt : -Infinity), intent === "press" ? 0 : loose],
    intent,
    severity,
  };
}

// ---------- the run ----------

interface Ctx {
  model: Model;
  n: number;
  temps: number[];
  failRate: number;
  warnRate: number;
  noteRate: number;
}

function sideInfo(c: FitInstance["hole"], src: Source, s: Scatter): SideInfo {
  const { mean, spread } = describeScatter(s);
  return { part: c.part.name, partId: c.part.id, d: c.d, how: src.label, mean, spread, side: src.how === "fdm" && onItsSide(c) };
}

const MODE_TEXT: Record<FitMode, string> = {
  "wont-fit": "will not go together",
  tight: "is tight enough to need force or reaming",
  cracks: "is pressed so hard the hole cracks or yields",
  creeps: "grips harder than the plastic holds for long, so it creeps loose over months",
  slips: "comes out with clearance, so the press fit does not grip (it spins or slides)",
  loose: "is loose enough to rattle or wobble",
  preload: "squeezes the bearing so hard its internal clearance goes and it runs rough and hot",
  binds: "binds: the teeth jam",
  misaligned: "does not line up, so a screw will not go through",
};

const pct = (r: number) => (r >= 0.995 ? "every" : r < 0.001 ? "under 0.1 % of" : r < 0.01 ? `${(Math.round(r * 1000) / 10).toFixed(1)} % of` : `${Math.round(r * 100)} % of`);
const mm = (n: number, d = 2) => `${Math.round(n * 10 ** d) / 10 ** d}`;

function statusOf(modes: ModeRate[], ctx: Ctx): CheckStatus {
  let s: CheckStatus = "pass";
  for (const m of modes) {
    if (m.severity === "fail" && m.rate >= ctx.failRate) return "fail";
    if (m.severity === "fail" && m.rate >= ctx.warnRate) s = "warn";
    if (m.severity === "warn" && m.rate >= ctx.noteRate) s = "warn";
  }
  return s;
}

function histogram(values: Float64Array[], lo: number, hi: number, bins = 28): number[] {
  const h = new Array(bins).fill(0);
  const w = (hi - lo) / bins || 1;
  for (const arr of values) for (const v of arr) h[Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)))]++;
  return h;
}

function roundTo(x: number, step: number) {
  return Math.round(x / step) * step;
}

/** What drawn size would bring the fit into its good band, if anything simple will. */
function suggestFix(inst: FitInstance, holeSrc: Source, shaftSrc: Source, holeMean: number, shaftMean: number, sorted: Float64Array, good: [number, number]): string | undefined {
  const p50 = quantile(sorted, 0.5);
  const spread = (quantile(sorted, 0.99865) - quantile(sorted, 0.00135)) / 2;
  const [g0, g1] = good;
  const width = (Number.isFinite(g1) ? g1 : g0 + 4 * spread + 0.2) - g0;
  const target = width > 2 * spread ? g0 + Math.max(spread, Math.min(width / 2, spread * 1.3 + 0.02)) : g0 + width / 2;
  const delta = target - p50;
  if (Math.abs(delta) < 0.02) return undefined;
  const fine = (s: Source) => (["fdm", "sls", "sla", "metal_print", "unknown"].includes(s.how) ? 0.05 : 0.01);
  if (holeSrc.how !== "bought") {
    const now = inst.hole.d;
    const next = roundTo(now + delta, fine(holeSrc));
    if (Math.abs(next - now) < 1e-9) return undefined;
    if (next < inst.shaft.d - 1e-6) {
      // a hole drawn smaller than its shaft would overlap the solids: call the size on the drawing
      const dev = holeMean - now + delta;
      const hw = Math.max(0.004, Math.min(width / 4, 0.015));
      return `Call the size on ${inst.hole.part.name}'s drawing so the hole is made to grip: diameter(..., ${mm(now, 3)}, tol: (${mm(dev + hw, 3)}, ${mm(dev - hw, 3)})). The model stays at Ø${mm(now, 3)}.`;
    }
    return `Draw the hole in ${inst.hole.part.name} at Ø${mm(next, 3)} mm instead of Ø${mm(now, 3)} so it comes out where this fit works.`;
  }
  if (shaftSrc.how !== "bought") {
    const now = inst.shaft.d;
    const name = inst.shaft.part.name;
    if (delta > 0) {
      const next = roundTo(now - delta, fine(shaftSrc));
      if (Math.abs(next - now) < 1e-9) return undefined;
      return `Draw ${name} at Ø${mm(next, 3)} mm instead of Ø${mm(now, 3)} so it comes out where this fit works.`;
    }
    // a bigger shaft can't be drawn without the solids overlapping: have the slicer cancel the shrink, or call the size on the drawing
    if (shaftSrc.how === "fdm" && !shrinkCompensated(inst.shaft.part)) return `Turn on shrink_comp: true in ${name}'s mfg.fdm(...) so the slicer cancels the plastic's shrink and it comes out at size.`;
    const dev = shaftMean - now - delta;
    const hw = Math.max(0.004, Math.min(width / 4, 0.015));
    return `Call the size on ${name}'s drawing so it is made to grip: diameter(..., ${mm(now, 3)}, tol: (${mm(dev + hw, 3)}, ${mm(dev - hw, 3)})). The model stays at Ø${mm(now, 3)}.`;
  }
  return "Both parts are bought: choose parts with a closer tolerance, or add a sleeve or adhesive.";
}

/** How one round feature comes out, with the tolerance its drawing calls (read once per run). */
function scatterOf(c: Cyl, ctx: Ctx, plan: Plan): Scatter {
  const called = plan.called.get(c);
  return diameterScatter(c, sourceOf(c.part), called !== undefined ? called : calledTolerance(ctx.model, c));
}

/**
 * One place of a fit, build by build: the hole's and the shaft's diameters as made, and the clearance between them.
 * Seeded by the fit and the place, so it gives the same numbers whenever it is asked.
 */
function drawPlace(f: FitDef, idx: number, ctx: Ctx, plan: Plan, shared: (material: string) => Float64Array): { h: Float64Array; s: Float64Array; c: Float64Array } {
  const inst = f.instances[idx];
  const r = rng(`${f.key}#${idx}`);
  const h = draw(scatterOf(inst.hole, ctx, plan), r, ctx.n, shared(inst.hole.part.material));
  const s = draw(scatterOf(inst.shaft, ctx, plan), r, ctx.n, shared(inst.shaft.part.material));
  const c = new Float64Array(ctx.n);
  for (let i = 0; i < ctx.n; i++) c[i] = h[i] - s[i] - 2 * inst.ecc;
  return { h, s, c };
}

/**
 * The as-made clearance of every place of every fit, build by build. A fit that is run leaves its draws here; a gear
 * mesh or a screw pattern that asks about a fit whose answer was kept has them drawn again then (the same numbers).
 */
class Draws {
  private made = new Map<FitInstance, Float64Array>();
  private shared = new Map<FitDef, (material: string) => Float64Array>();

  constructor(
    private plan: Plan,
    private ctx: Ctx,
  ) {}

  /** the build-by-build draw each material shares within a fit */
  sharedOf(f: FitDef): (material: string) => Float64Array {
    let s = this.shared.get(f);
    if (!s) this.shared.set(f, (s = sharedDraws(f.key, this.ctx.n)));
    return s;
  }

  set(inst: FitInstance, c: Float64Array) {
    this.made.set(inst, c);
  }

  get(inst: FitInstance): Float64Array | undefined {
    let c = this.made.get(inst);
    if (!c) {
      const o = this.plan.owner.get(inst);
      if (!o) return undefined;
      c = drawPlace(o.fit, o.index, this.ctx, this.plan, this.sharedOf(o.fit)).c;
      this.made.set(inst, c);
    }
    return c;
  }
}

/** Yields after each of the fit's places, so a caller with a page to keep moving can stop there for a moment. */
function* runFit(f: FitDef, ctx: Ctx, samples: Draws, plan: Plan): Generator<void, FitOutcome> {
  const all: Float64Array[] = [];
  const failRuns = new Map<string, Uint8Array>();
  const first = f.instances[0];
  const holeSrc = sourceOf(first.hole.part);
  const shaftSrc = sourceOf(first.shaft.part);
  const hs = scatterOf(first.hole, ctx, plan);
  const ss = scatterOf(first.shaft, ctx, plan);
  const j = judge(f, first, holeSrc, shaftSrc, describeScatter(hs).mean - describeScatter(ss).mean);
  const ah = expansion(holeSrc.material);
  const as = expansion(shaftSrc.material);
  const temps = [20, ...ctx.temps.filter((t) => t !== 20)];
  const mark = (mode: FitMode, t: number, i: number) => {
    const k = `${mode}|${t}`;
    let arr = failRuns.get(k);
    if (!arr) failRuns.set(k, (arr = new Uint8Array(ctx.n)));
    arr[i] = 1;
  };
  const shared = samples.sharedOf(f);
  for (let idx = 0; idx < f.instances.length; idx++) {
    const inst = f.instances[idx];
    const { h, s, c } = drawPlace(f, idx, ctx, plan, shared);
    samples.set(inst, c);
    all.push(c);
    for (const t of temps) {
      const dT = t - 20;
      for (let i = 0; i < ctx.n; i++) {
        const ct = c[i] + dT * (h[i] * ah - s[i] * as);
        const m = j.at(ct);
        if (m) mark(m, t, i);
      }
    }
    yield;
  }
  // rates: share of builds where any instance shows the mode; at room temperature first, then new ones when hot or cold
  const modes: ModeRate[] = [];
  const seen = new Set<FitMode>();
  for (const t of temps) {
    for (const [k, arr] of failRuns) {
      const [mode, ts] = k.split("|");
      if (Number(ts) !== t) continue;
      let n = 0;
      for (let i = 0; i < arr.length; i++) n += arr[i];
      const rate = n / ctx.n;
      const m = mode as FitMode;
      if (t !== 20 && seen.has(m)) {
        const base = modes.find((x) => x.mode === m && x.temp === undefined);
        if (base && rate < base.rate * 1.5 + ctx.warnRate) continue;
      }
      if (rate < ctx.warnRate / 2) continue;
      modes.push({ mode: m, rate, severity: j.severity[m], temp: t === 20 ? undefined : t });
      if (t === 20) seen.add(m);
    }
  }
  modes.sort((a, b) => (a.severity === b.severity ? b.rate - a.rate : a.severity === "fail" ? -1 : 1));
  const pooled = new Float64Array(all.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of all) {
    pooled.set(a, o);
    o += a.length;
  }
  const sorted = pooled.slice().sort();
  const made = { p01: quantile(sorted, 0.01), p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99) };
  const lo = Math.min(made.p01, j.good[0], f.nominal) - 0.03;
  const hi = Math.max(made.p99, Number.isFinite(j.good[1]) ? j.good[1] : made.p99, f.nominal) + 0.03;
  const status = statusOf(modes, ctx);
  const hole = sideInfo(first.hole, holeSrc, hs);
  const shaft = sideInfo(first.shaft, shaftSrc, ss);
  const many = f.instances.length > 1;
  const describe = (s: SideInfo, word: string) => `${word} Ø${mm(s.d, 3)} (${s.how}${s.side ? ", on its side" : ""}) comes out Ø${mm(s.mean, 3)} ± ${mm(s.spread, 3)}`;
  let detail = `${describe(hole, `The ${f.kind === "bearing-shaft" || f.kind === "gear-bore" ? "bore" : "hole"} in ${hole.part}`)}; ${describe(shaft, shaft.part)}. `;
  detail += `Drawn ${f.nominal >= 0 ? `${mm(f.nominal, 3)} mm clearance` : `${mm(-f.nominal, 3)} mm interference`}; as made ${mm(made.p01, 3)} to ${mm(made.p99, 3)} mm (98 % of builds, negative is interference).`;
  const bad = modes.filter((m) => m.rate >= ctx.warnRate);
  if (bad.length) detail += " " + bad.map((m) => `In ${pct(m.rate)} builds${m.temp !== undefined ? ` at ${m.temp} °C` : ""} ${many ? "one of them" : "it"} ${MODE_TEXT[m.mode]}.`).join(" ");
  else detail += ` It works in ${pct(1 - modes.reduce((s, m) => s + m.rate, 0))} builds.`;
  const fix = status === "pass" ? undefined : suggestFix(first, holeSrc, shaftSrc, describeScatter(hs).mean, describeScatter(ss).mean, sorted, j.good);
  const parts = [...new Set(f.instances.flatMap((i) => [i.hole.part.id, i.shaft.part.id]))];
  return {
    key: f.key,
    kind: f.kind,
    title: f.title,
    intent: j.intent,
    status,
    modes,
    nominal: f.nominal,
    made,
    hist: histogram(all, lo, hi),
    range: [lo, hi],
    good: j.good,
    hole,
    shaft,
    count: f.instances.length,
    parts,
    at: f.instances.map((i) => i.at),
    axis: first.hole.axis,
    detail,
    fix,
  };
}

// ---------- gear meshes ----------

type Chain = { fit: FitDef; inst: FitInstance; index: number }[];

/**
 * The fits that hold each gear of a pair: its own bore, its shaft's bearings and their seats, a motor's pilot (not
 * other gears' bores). Null for two gears of different modules, which do not mesh.
 */
function gearChains(g: GearPair, fits: FitDef[]): { axis: V3; ca: Chain; cb: Chain } | null {
  const A = g.a.gear!;
  const B = g.b.gear!;
  if (Math.abs(A.m - B.m) > 1e-9) return null;
  const axis = vnorm(B.axis);
  const chain = (gear: EvalPart) => fitsOnAxis(fits, gear.gear!.center, axis).filter((x) => x.fit.kind !== "gear-bore" || x.inst.hole.part === gear);
  return { axis, ca: chain(g.a), cb: chain(g.b) };
}

function runGear(g: GearPair, fits: FitDef[], samples: Draws, ctx: Ctx): FitOutcome | null {
  const A = g.a.gear!;
  const B = g.b.gear!;
  const chains = gearChains(g, fits);
  if (!chains) return null;
  const { axis, ca, cb } = chains;
  const a0 = axisDistance(A.center, B.center, axis);
  const ideal = centerDistance(A.m, A.z, B.z);
  const tanA = Math.tan(((B.pa ?? 20) * Math.PI) / 180);
  // drawn circumferential backlash: each gear's teeth are thinned by half its backlash, plus what the centre distance adds
  const j0 = (A.backlash + B.backlash) / 2 + 2 * (a0 - ideal) * tanA;
  const r = rng(`gear|${g.key}`);
  const n = ctx.n;
  const jarr = new Float64Array(n);
  // radial float from every fit along each gear's axis; housings that hold both axes add their hole position scatter
  const seatParts = (c: Chain) => new Set(c.map((x) => x.inst.hole.part).filter((p) => p.kind === "part"));
  const sa = seatParts(ca);
  const sb = seatParts(cb);
  const shared = [...sa].filter((p) => sb.has(p));
  const posSig = shared.length ? Math.max(...shared.map((p) => positionSigma(sourceOf(p), a0))) : Math.hypot(...[...sa, ...sb].map((p) => positionSigma(sourceOf(p), a0 / 2)), 0.02);
  const tooth = (p: EvalPart) => {
    const src = sourceOf(p);
    // printed teeth come out fat (the outer wall squashes outwards); cut and moulded gears hold their thickness
    if (src.how === "fdm") return { mean: 0.12, sigma: 0.05 };
    if (src.how === "sls" || src.how === "metal_print") return { mean: 0.1, sigma: 0.05 };
    if (src.how === "sla") return { mean: 0.05, sigma: 0.03 };
    return { mean: 0, sigma: 0.012 };
  };
  const ta = tooth(g.a);
  const tb = tooth(g.b);
  const floatOf = (c: Chain, i: number) => {
    let along = 0;
    for (const x of c) {
      const cl = samples.get(x.inst)?.[i] ?? 0;
      if (cl > 0) along += (cl / 2) * Math.cos(2 * Math.PI * r());
    }
    return along;
  };
  let bind = 0,
    loose = 0;
  const looseAt = 0.1 * A.m + 0.12;
  for (let i = 0; i < n; i++) {
    const da = floatOf(cb, i) - floatOf(ca, i) + posSig * gauss(r);
    const j = j0 + 2 * da * tanA - (ta.mean + ta.sigma * gauss(r)) - (tb.mean + tb.sigma * gauss(r));
    jarr[i] = j;
    if (j <= 0) bind++;
    else if (j > looseAt) loose++;
  }
  const modes: ModeRate[] = [];
  if (bind / n >= ctx.warnRate / 2) modes.push({ mode: "binds", rate: bind / n, severity: "fail" });
  if (loose / n >= ctx.warnRate / 2) modes.push({ mode: "loose", rate: loose / n, severity: "warn" });
  const sorted = jarr.slice().sort();
  const made = { p01: quantile(sorted, 0.01), p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99) };
  const status = statusOf(modes, ctx);
  const sources = [...ca, ...cb].filter((x) => (samples.get(x.inst)?.some((v) => v > 0.02) ?? false)).map((x) => x.fit.title);
  let detail = `Backlash drawn ${mm(j0, 3)} mm at the pitch circle; as made ${mm(made.p01, 3)} to ${mm(made.p99, 3)} mm.`;
  if (sources.length) detail += ` The gears move off their drawn centres by the play in ${[...new Set(sources)].join(", ")}.`;
  if (ta.mean > 0 || tb.mean > 0) detail += " Printed teeth come out thicker than drawn, which eats backlash.";
  if (bind / n >= ctx.warnRate) detail += ` In ${pct(bind / n)} builds the teeth jam.`;
  if (loose / n >= ctx.noteRate) detail += ` In ${pct(loose / n)} builds there is more than ${mm(looseAt)} mm of play (lost motion and noise).`;
  let fix: string | undefined;
  if (status !== "pass" && bind / n >= ctx.warnRate) {
    const need = Math.max(0.02, -quantile(sorted, 0.003) + 0.02);
    fix = `Give the gears about ${mm(need, 2)} mm more backlash (backlash: on lib.spur_gear, or move the axes ${mm(need / (2 * tanA), 3)} mm apart), or tighten the fits that let them float.`;
  } else if (status !== "pass") fix = "Tighten the fits that let the gears float, or reduce the drawn backlash.";
  return {
    key: `gear|${g.key}`,
    kind: "gear-mesh",
    title: `Gear mesh ${g.title}`,
    status,
    modes,
    nominal: j0,
    made,
    hist: histogram([jarr], Math.min(made.p01, 0) - 0.03, Math.max(made.p99, looseAt) + 0.03),
    range: [Math.min(made.p01, 0) - 0.03, Math.max(made.p99, looseAt) + 0.03],
    good: [0, looseAt],
    count: 1,
    parts: [g.a.id, g.b.id],
    at: [vscale(vadd(A.center, B.center), 0.5)],
    axis,
    detail,
    fix,
  };
}

// ---------- screw patterns ----------

function perpOf(v: V3, axis: V3): V3 {
  return vsub(v, vscale(axis, vdot(v, axis)));
}

const FOLLOWERS = new Set(["nut", "insert", "standoff"]);

/** The screw patterns of a design: its screws grouped by the parts they join, two or more to a pattern. */
function patternGroups(joints: ScrewJoint[]): [string, ScrewJoint[]][] {
  const groups = new Map<string, ScrewJoint[]>();
  for (const j of joints) {
    const parts = [...new Set([...j.through.map((t) => t.hole.part.name), ...j.threads.map((p) => p.name)])].sort();
    if (parts.length < 2) continue;
    const key = `${j.screw.name}|${parts.join("+")}`;
    const list = groups.get(key);
    if (list) list.push(j);
    else groups.set(key, [j]);
  }
  return [...groups].filter(([, list]) => list.length >= 2);
}

/** One screw pattern; null where nothing has to line up. Yields every few hundred builds (see runFit). */
function* runPattern(key: string, list: ScrewJoint[], samples: Draws, ctx: Ctx): Generator<void, FitOutcome | null> {
  {
    const axis = vnorm(list[0].through[0].hole.axis);
    // every part the pattern passes through or threads into, with each screw's hole clearance in it (0 where it threads)
    const partsByName = new Map<string, EvalPart>();
    for (const j of list) {
      for (const t of j.through) partsByName.set(t.hole.part.name, t.hole.part);
      for (const p of j.threads) partsByName.set(p.name, p);
    }
    // a washer is loose on its screw until the screw is tight: it never sets where a screw goes
    let loose = false;
    for (const [name, p] of partsByName)
      if (p.libKind === "washer") {
        partsByName.delete(name);
        loose = true;
      }
    // a nut floats on the screw, and an insert sits in its host's pocket and moves with it: neither sets where the screw goes
    for (const [name, p] of partsByName) if (FOLLOWERS.has(p.libKind ?? "") && partsByName.size > 2) partsByName.delete(name);
    // with the washers gone, one part and the nuts or inserts that follow it leave nothing to line up
    if (loose && [...partsByName.values()].filter((p) => !FOLLOWERS.has(p.libKind ?? "")).length < 2) return null;
    const names = [...partsByName.keys()];
    if (names.length < 2) return null;
    const pos = list.map((j) => j.through[0].shaft.at);
    const centre = vscale(pos.reduce((s, p) => vadd(s, p), [0, 0, 0] as V3), 1 / pos.length);
    const r = rng(`pattern|${key}`);
    // a steel screw cuts its way through a plastic hole that is a little off: forcing, but it goes
    const sd = list[0].through[0].shaft.d;
    let bad = 0,
      forced = 0;
    const misses = new Float64Array(ctx.n);
    const u = vnorm(perpOf(Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], axis));
    const v = vcross(axis, u);
    const np = pos.length;
    // what does not change from build to build, read once: each part's scale scatter and give, where each of its
    // holes sits across the screws and how far off it lands, and each screw's room in it (its fit's draws, or the
    // drawn clearance where the hole is not a fit)
    const sides = names.map((name) => {
      const p = partsByName.get(name)!;
      const src = sourceOf(p);
      const sc = scaleScatter(src, p);
      const du = new Float64Array(np);
      const dv = new Float64Array(np);
      const sigma = new Float64Array(np);
      pos.forEach((q, k) => {
        const d = perpOf(vsub(q, centre), axis);
        du[k] = vdot(d, u);
        dv[k] = vdot(d, v);
        sigma[k] = positionSigma(src, vlen(d) * 2);
      });
      const rooms = list.map((j) => {
        const t = j.through.find((x) => x.hole.part.name === name);
        return t ? { draws: samples.get(t), drawn: t.hole.d - t.shaft.d } : null;
      });
      return { material: p.material, mean: sc.mean, sigma: sc.sigma, common: sc.common ?? 0, du, dv, pos: sigma, rooms, give: isPlastic(p.material) ? 0.04 * sd : 0, ex: new Float64Array(np), ey: new Float64Array(np) };
    });
    const room = (side: (typeof sides)[number], k: number, i: number) => {
      const t = side.rooms[k];
      return t ? Math.max(0, t.draws?.[i] ?? t.drawn) / 2 : 0;
    };
    const common = new Map<string, number>();
    for (let i = 0; i < ctx.n; i++) {
      // each part's holes: scaled about the pattern centre plus scatter, in the plane across the screws
      common.clear();
      for (const side of sides) {
        if (!common.has(side.material)) common.set(side.material, gauss(r));
        const k = side.mean - 1 + side.sigma * gauss(r) + side.common * common.get(side.material)!;
        for (let q = 0; q < np; q++) {
          side.ex[q] = k * side.du[q] + side.pos[q] * gauss(r);
          side.ey[q] = k * side.dv[q] + side.pos[q] * gauss(r);
        }
      }
      let worst = Infinity,
        worstForced = Infinity;
      for (let a = 0; a < sides.length; a++)
        for (let b = a + 1; b < sides.length; b++) {
          const A = sides[a];
          const B = sides[b];
          // the parts settle where the screws let them: take out the average offset
          let mx = 0,
            my = 0;
          for (let k = 0; k < np; k++) {
            mx += A.ex[k] - B.ex[k];
            my += A.ey[k] - B.ey[k];
          }
          mx /= np;
          my /= np;
          for (let k = 0; k < list.length; k++) {
            const m = Math.hypot(A.ex[k] - B.ex[k] - mx, A.ey[k] - B.ey[k] - my);
            const left = room(A, k, i) + room(B, k, i) - m;
            worst = Math.min(worst, left);
            worstForced = Math.min(worstForced, left + A.give + B.give);
          }
        }
      misses[i] = worst;
      if (worstForced < 0) bad++;
      else if (worst < 0) forced++;
      if ((i & 255) === 255) yield;
    }
    const rate = bad / ctx.n;
    const modes: ModeRate[] = [];
    if (rate >= ctx.warnRate / 2) modes.push({ mode: "misaligned", rate, severity: "fail" });
    // forcing a screw through by hand is routine in plastic: mentioned, not flagged
    const status = statusOf(modes, ctx);
    const sorted = misses.slice().sort();
    const made = { p01: quantile(sorted, 0.01), p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99) };
    const screw = list[0].screw;
    const threads = [...new Set(list.flatMap((j) => j.threads.map((p) => p.name)))];
    const throughNames = [...new Set(list.flatMap((j) => j.through.map((t) => t.hole.part.name)))];
    let detail = `${list.length} ${screw.fastener?.size ?? ""} screws (${screw.name}) pass through ${throughNames.join(" and ")}${threads.length ? ` into ${threads.join(" and ")}` : ""}. Spare room after the hole positions and shrink of every part: ${mm(made.p01, 3)} to ${mm(made.p99, 3)} mm.`;
    if (rate >= ctx.warnRate) detail += ` In ${pct(rate)} builds a screw will not go through without drilling a hole out.`;
    if (forced / ctx.n >= ctx.noteRate) detail += ` In ${pct(forced / ctx.n)} builds a screw has to be forced through the plastic.`;
    const fix = status === "pass" ? undefined : `Open the clearance holes in ${throughNames.join(" and ")} by about ${mm(Math.max(0.1, -quantile(sorted, 0.002) * 2), 2)} mm, or make one row of holes slots.`;
    return {
      key: `pattern|${key}`,
      kind: "screw-pattern",
      title: `Screw pattern lines up: ${screw.name} through ${throughNames.join(" + ")}${threads.length ? ` into ${threads.join(" + ")}` : ""}`,
      status,
      modes,
      nominal: Math.min(...list.map((j) => Math.min(...j.through.map((t) => (t.hole.d - t.shaft.d) / 2)))),
      made,
      hist: histogram([misses], Math.min(0, made.p01) - 0.03, made.p99 + 0.03),
      range: [Math.min(0, made.p01) - 0.03, made.p99 + 0.03],
      good: [0, Infinity],
      count: list.length,
      parts: [...new Set([...list.map((j) => j.screw.id), ...[...partsByName.values()].map((p) => p.id)])],
      at: pos,
      axis,
      detail,
      fix,
    };
  }
}

// ---------- what was worked out before ----------
//
// A design is checked again after every edit, and most edits leave most of its fits as they were. Each answer is
// kept under everything it was worked out from, so the next check builds only what changed. An answer found here is
// the one a fresh run gives, digit for digit, because the draws are seeded by the fit and not by the run.
//
// WHATEVER THE STUDY READS MUST BE IN THESE KEYS. A fit's key holds its sizes, roles and print directions, both
// parts (name, how each is made and of what, whether it moves), the tolerance its drawing calls, how far off line
// each place is drawn, and the run's settings. Where the fit sits is left out, because its numbers do not depend
// on it, and is put back from the design in hand. A screw pattern's and a gear mesh's keys also hold where
// everything sits, and name the draws they read.

const KEPT = 6000;
const kept = new Map<string, FitOutcome>();

function keep(key: string, o: FitOutcome) {
  kept.delete(key);
  kept.set(key, o);
  if (kept.size > KEPT)
    for (const k of kept.keys()) {
      kept.delete(k);
      if (kept.size <= KEPT) break;
    }
}

function recall(key: string): FitOutcome | undefined {
  const o = kept.get(key);
  // the ones used last are kept longest
  if (o) {
    kept.delete(key);
    kept.set(key, o);
  }
  return o;
}

/** An answer and the key it was worked out under. */
export type FitLearned = [key: string, outcome: FitOutcome];

/** Take in answers worked out elsewhere (the fit worker's), so the same question is answered here next time. */
export function rememberFits(learned: FitLearned[]) {
  for (const [key, o] of learned) keep(key, o);
}

/** How many answers are kept. */
export function fitsKept(): number {
  return kept.size;
}

/** Forget every answer kept (for tests, and for measuring a fresh run). */
export function forgetFits() {
  kept.clear();
}

/** A number as it goes into a key: the ones JSON cannot tell apart are spelled out. */
const num = (x: number): number | string => (Number.isFinite(x) && !Object.is(x, -0) ? x : Object.is(x, -0) ? "-0" : String(x));
const nums = (v: readonly number[]) => v.map(num);

interface Plan {
  /** the run's settings, as they go into every key */
  ctxKey: string;
  /** the tolerance each round feature's drawing calls */
  called: Map<Cyl, [number, number] | null>;
  /** the fit and the place each instance belongs to */
  owner: Map<FitInstance, { fit: FitDef; index: number }>;
  /** a key for each of found.fits and found.gears */
  fits: string[];
  gears: string[];
  patterns: { key: string; list: ScrewJoint[]; memo: string }[];
}

const plans = new WeakMap<FoundFits, Plan>();

/** Reads everything a run of the study depends on into keys. Yields now and then (see fitWork). */
function* planFor(found: FoundFits, ctx: Ctx): Generator<void, Plan> {
  const ctxKey = JSON.stringify([ctx.n, nums(ctx.temps), ctx.failRate, ctx.warnRate, ctx.noteRate]);
  const had = plans.get(found);
  if (had?.ctxKey === ctxKey) return had;
  const called = new Map<Cyl, [number, number] | null>();
  const owner = new Map<FitInstance, { fit: FitDef; index: number }>();
  // what the study reads of a part, and of a round feature in the part's own frame
  const parts = new Map<EvalPart, unknown[]>();
  const partData = (p: EvalPart) => {
    let d = parts.get(p);
    if (!d) parts.set(p, (d = [p.id, p.name, p.kind, p.libKind ?? 0, p.material, p.process ?? 0, !!p.motion, p.gear ?? 0, p.fastener ?? 0]));
    return d;
  };
  const cyls = new Map<Cyl, unknown[]>();
  const cylData = (c: Cyl) => {
    let d = cyls.get(c);
    if (!d) {
      const tol = calledTolerance(ctx.model, c);
      called.set(c, tol);
      cyls.set(c, (d = [c.side, num(c.d), num(c.length), nums(c.axisLocal), c.role, c.thread?.name ?? 0, c.holeFit ?? 0, tol ? nums(tol) : 0, partData(c.part)]));
    }
    return d;
  };
  /** one place's draws: what seeds them and what they are drawn from */
  const placeData = (inst: FitInstance) => {
    const o = owner.get(inst);
    return [o ? [o.fit.key, o.index] : 0, cylData(inst.hole), cylData(inst.shaft), num(inst.ecc)];
  };
  const where = (c: Cyl) => [nums(c.at), nums(c.axis)];

  const fits: string[] = [];
  let since = 0;
  for (const f of found.fits) {
    f.instances.forEach((inst, index) => owner.set(inst, { fit: f, index }));
    fits.push(JSON.stringify(["fit", ctxKey, f.key, f.kind, f.intent, f.title, num(f.nominal), f.instances.map((inst) => [cylData(inst.hole), cylData(inst.shaft), num(inst.ecc)])]));
    if ((since += f.instances.length) >= 64) {
      since = 0;
      yield;
    }
  }
  const gears: string[] = [];
  for (const g of found.gears) {
    const chains = gearChains(g, found.fits);
    const chainData = (c: Chain) => c.map((x) => [x.fit.kind, x.fit.title, placeData(x.inst), where(x.inst.hole), nums(x.inst.at)]);
    gears.push(JSON.stringify(["gear", ctxKey, g.key, g.title, partData(g.a), partData(g.b), chains ? [chainData(chains.ca), chainData(chains.cb)] : 0]));
    yield;
  }
  const patterns: Plan["patterns"] = [];
  for (const [key, list] of patternGroups(found.joints)) {
    const memo = JSON.stringify(["pattern", ctxKey, key, list.map((j) => [partData(j.screw), j.through.map((t) => [placeData(t), where(t.hole), where(t.shaft)]), j.threads.map(partData)])]);
    patterns.push({ key, list, memo });
    if ((since += list.length) >= 32) {
      since = 0;
      yield;
    }
  }
  const plan: Plan = { ctxKey, called, owner, fits, gears, patterns };
  plans.set(found, plan);
  return plan;
}

// ---------- entry ----------

export interface FitOptions {
  /** extra temperatures to judge the fits at, °C (the brief's service range) */
  temps?: number[];
  samples?: number;
  quantity?: number;
  /** filled with every answer of the run and the key it was worked out under (see rememberFits) */
  learned?: FitLearned[];
}

function ctxOf(model: Model, opts: FitOptions): Ctx {
  const q = opts.quantity ?? model.brief?.quantity ?? 1;
  return {
    model,
    n: opts.samples ?? SAMPLES,
    temps: opts.temps ?? (model.brief?.temp ? [model.brief.temp[0], model.brief.temp[1]] : []),
    // one-offs: a fit that fails in 1 build of 20 is a problem; for a production run, 1 in 100
    failRate: q >= 50 ? 0.01 : 0.05,
    warnRate: q >= 50 ? 0.001 : 0.005,
    noteRate: q >= 50 ? 0.02 : 0.1,
  };
}

/** Judge every fit, gear mesh and screw pattern over many simulated builds. */
export function simulateFits(found: FoundFits, model: Model, opts: FitOptions = {}): FitReport {
  const work = fitWork(found, model, opts);
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
  }
}

/**
 * simulateFits a piece at a time: it yields every few milliseconds of work, so the page can run it between frames
 * (core/slices.ts) instead of stopping for it. The result is the same either way. Only what no earlier run has
 * answered is built (see "what was worked out before").
 */
export function* fitWork(found: FoundFits, model: Model, opts: FitOptions = {}): Generator<void, FitReport> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const ctx = ctxOf(model, opts);
  const plan = yield* planFor(found, ctx);
  const samples = new Draws(plan, ctx);
  const outcomes: FitOutcome[] = [];
  const add = (key: string, o: FitOutcome) => {
    outcomes.push(o);
    opts.learned?.push([key, o]);
  };
  for (let i = 0; i < found.fits.length; i++) {
    const f = found.fits[i];
    const had = recall(plan.fits[i]);
    if (had) {
      // where it is comes from this design: nothing else in the answer depends on it
      add(plan.fits[i], { ...had, at: f.instances.map((x) => x.at), axis: f.instances[0].hole.axis });
      continue;
    }
    const o = yield* runFit(f, ctx, samples, plan);
    keep(plan.fits[i], o);
    add(plan.fits[i], o);
  }
  for (let i = 0; i < found.gears.length; i++) {
    let o: FitOutcome | null | undefined = recall(plan.gears[i]);
    if (!o) {
      o = runGear(found.gears[i], found.fits, samples, ctx);
      if (o) keep(plan.gears[i], o);
      yield;
    }
    if (o) add(plan.gears[i], o);
  }
  for (const p of plan.patterns) {
    let o: FitOutcome | null | undefined = recall(p.memo);
    if (!o) {
      o = yield* runPattern(p.key, p.list, samples, ctx);
      if (o) keep(p.memo, o);
    }
    if (o) add(p.memo, o);
  }
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { outcomes, samples: ctx.n, temps: ctx.temps, ms: t1 - t0 };
}

/**
 * How much of a run is still to work out, in simulated builds of one place (a fit's place counts once for each
 * temperature it is judged at; a pattern's screw counts for each part it passes through). Nothing: every answer is
 * kept, and the run is a matter of putting them together.
 */
export function* fitWorkLeft(found: FoundFits, model: Model, opts: FitOptions = {}): Generator<void, number> {
  const ctx = ctxOf(model, opts);
  const plan = yield* planFor(found, ctx);
  let left = 0;
  found.fits.forEach((f, i) => {
    if (!kept.has(plan.fits[i])) left += f.instances.length * (1 + ctx.temps.length);
  });
  found.gears.forEach((_, i) => {
    if (!kept.has(plan.gears[i])) left += 4;
  });
  for (const p of plan.patterns) if (!kept.has(p.memo)) left += p.list.length * (2 + p.list[0].through.length + p.list[0].threads.length);
  return left;
}
