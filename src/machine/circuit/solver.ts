// Analog circuit solver: modified nodal analysis with Newton–Raphson for the
// operating point, a complex small-signal sweep for frequency responses and
// impedances, and a fixed-step transient for rendering audio through a
// circuit. The transient integrates with TR-BDF2: second order like the
// trapezoidal rule, but it damps the stiff modes (an op-amp's closed loop,
// a diode snapping on across a capacitor) that make the trapezoidal rule
// ring at half the sample rate.

import { inspect } from "./check";
import { compile, sourceRhs, type Compiled } from "./compile";
import { Devices, type Tol } from "./devices";
import { ComplexLU, RealLU, makePlan, numericOrder } from "./sparse";
import type { AcResult, Circuit, Complex, DcResult, Node, Probe, TranOptions, TranResult } from "./types";

export { checkCircuit } from "./check";

// Operating points are solved tightly: they feed bias checks and every
// small-signal result. Transient steps use looser tolerances that are still
// far below audibility (around −100 dB on a volt).
const DC_TOL: Tol = { rel: 1e-6, absI: 1e-13, absV: 1e-9, jrel: 0, jabs: 0 };
const TRAN_TOL: Tol = { rel: 1e-4, absI: 1e-10, absV: 1e-6, jrel: 1e-3, jabs: 1e-9 };

/** Conductance that pins a capacitor with a starting voltage while the transient's operating point is found. */
const G_IC = 1e4;

// TR-BDF2 with γ = 2 − √2: both stages then share one matrix, G + κ·B with κ = 2 / (γh).
const GAMMA = 2 - Math.SQRT2;
const BDF_A = 1 / (GAMMA * (2 - GAMMA));
const BDF_B = ((1 - GAMMA) * (1 - GAMMA)) / (GAMMA * (2 - GAMMA));

/** Newton iterations per transient stage before the step is split in two. */
const TRAN_MAXIT = 30;
/** How many times a step may be halved. */
const TRAN_MAXLEVEL = 5;

/** The full solution vector behind each operating point this module returned, so later analyses can start from it exactly. */
const FULL = new WeakMap<DcResult, { names: string[]; x: Float64Array }>();

// ---------------------------------------------------------------------------
// operating point

interface DcState {
  cc: Compiled;
  dev: Devices;
  lu: RealLU;
  m: Float64Array;
  rhs: Float64Array;
  src: Float64Array;
  xn: Float64Array;
  /** pin capacitors that have a starting voltage */
  ic: boolean;
}

function dcState(cc: Compiled, ic: boolean): DcState {
  const lu = new RealLU(cc.plan);
  return {
    cc,
    dev: new Devices(cc, lu.plan.map),
    lu,
    m: new Float64Array(cc.nnz + 1),
    rhs: new Float64Array(cc.n + 1),
    src: new Float64Array(cc.n + 1),
    xn: new Float64Array(cc.n + 1),
    ic,
  };
}

/** Rebuild the pivot order from the matrix values after a zero pivot. */
function replan(s: DcState, base: Float64Array): boolean {
  const { cc } = s;
  const full = base.slice();
  s.dev.bind();
  s.dev.stampJ(full);
  const { pr, pc } = numericOrder(cc.n, cc.rows, cc.cols, full);
  s.lu = new RealLU(makePlan(cc.n, cc.rows, cc.cols, pr, pc));
  s.dev.bind(s.lu.plan.map);
  s.lu.load(base);
  s.dev.stampJ(s.lu.a);
  return s.lu.factor();
}

/** Newton from x with a shunt to ground on every node and the sources scaled; returns the iterations used, or −1. */
function newtonDc(s: DcState, x: Float64Array, maxIter: number, gshunt: number, scale: number): number {
  const { cc, dev, m, rhs, src, xn } = s;
  const { n, nv } = cc;
  sourceRhs(cc, scale, src);
  m.set(cc.G);
  for (let q = 0; q < cc.diag.length; q++) m[cc.diag[q]] += gshunt;
  if (s.ic) {
    const { cap } = cc;
    for (let q = 0; q < cap.ic.length; q++) {
      const v = cap.ic[q];
      if (Number.isNaN(v)) continue;
      m[cap.slots[4 * q]] += G_IC;
      m[cap.slots[4 * q + 1]] += G_IC;
      m[cap.slots[4 * q + 2]] -= G_IC;
      m[cap.slots[4 * q + 3]] -= G_IC;
      src[cap.a[q]] += G_IC * v;
      src[cap.b[q]] -= G_IC * v;
    }
  }
  dev.evalAll(x);
  for (let it = 1; it <= maxIter; it++) {
    s.lu.load(m);
    dev.stampJ(s.lu.a);
    if (!s.lu.factor() && !replan(s, m)) return -1;
    rhs.set(src);
    dev.stampRhs(rhs);
    s.lu.solve(rhs, xn);
    let small = true;
    for (let i = 0; i < n; i++) {
      const a = xn[i];
      if (!Number.isFinite(a)) return -1;
      const d = Math.abs(a - x[i]);
      if (d > 1e-6 * Math.max(Math.abs(a), Math.abs(x[i])) + (i < nv ? 1e-9 : 1e-12)) small = false;
    }
    const devOk = dev.update(xn, DC_TOL);
    x.set(xn);
    if (devOk && small) return it;
  }
  return -1;
}

interface OpSolution {
  x: Float64Array;
  ok: boolean;
  iterations: number;
  message?: string;
}

/** Plain Newton, then gmin stepping, then source stepping. */
function solveOp(cc: Compiled, init: Float64Array | null, maxIter: number, ic: boolean): OpSolution {
  const s = dcState(cc, ic);
  const x = new Float64Array(cc.n + 1);
  const reset = () => (init ? x.set(init) : x.fill(0));
  reset();
  let total = 0;
  const run = (g: number, scale: number) => {
    const it = newtonDc(s, x, maxIter, g, scale);
    total += it < 0 ? maxIter : it;
    return it >= 0;
  };
  if (run(0, 1)) return { x, ok: true, iterations: total };

  // gmin stepping: a big shunt makes every node easy, then shrink it
  const saved = new Float64Array(cc.n + 1);
  reset();
  let ok = run(1e-2, 1);
  let g = 1e-2;
  let factor = 10;
  while (ok && g > 0) {
    const next = g / factor < 1e-12 ? 0 : g / factor;
    saved.set(x);
    if (run(next, 1)) {
      g = next;
      factor = Math.min(factor * 3, 1e4);
    } else {
      x.set(saved);
      factor = Math.sqrt(factor);
      if (factor < 1.01) ok = false;
    }
  }
  if (ok) return { x, ok: true, iterations: total };

  // source stepping: ramp every source up from zero
  x.fill(0);
  ok = run(0, 0);
  let scale = 0;
  let ds = 0.1;
  while (ok && scale < 1) {
    const next = Math.min(1, scale + ds);
    saved.set(x);
    if (run(0, next)) {
      scale = next;
      ds = Math.min(ds * 2, 0.5);
    } else {
      x.set(saved);
      ds /= 4;
      if (ds < 1e-4) ok = false;
    }
  }
  if (ok) return { x, ok: true, iterations: total };
  return {
    x,
    ok: false,
    iterations: total,
    message: `no operating point found: Newton, gmin stepping and source stepping all failed to converge (sources reached ${Math.round(scale * 100)} %)`,
  };
}

/** Starting vector from an operating point this module did not produce (or produced for another circuit). */
function seedFrom(cc: Compiled, op: DcResult): Float64Array {
  const prev = FULL.get(op);
  if (prev && prev.names.length === cc.names.length && prev.names.every((nm, i) => nm === cc.names[i])) return prev.x.slice();
  const x = new Float64Array(cc.n + 1);
  for (const [nm, i] of cc.nodes) if (i < cc.n) x[i] = op.v[nm] ?? 0;
  const els = cc.circuit.elements;
  const { dio, oa, vs, ind, vcvs } = cc;
  for (let q = 0; q < dio.j.length; q++) if (dio.j[q] !== dio.a[q]) x[dio.j[q]] = x[dio.a[q]];
  for (let q = 0; q < oa.x.length; q++) x[oa.x[q]] = x[oa.o[q]];
  for (const g of [vs, ind, vcvs]) for (let q = 0; q < g.k.length; q++) x[g.k[q]] = op.i[els[g.el[q]].id] ?? 0;
  return x;
}

/** The full state to start an analysis from: re-converged from `op` when given (cheap), solved from scratch otherwise. */
function startState(cc: Compiled, op: DcResult | undefined, ic: boolean): OpSolution {
  if (!op) return solveOp(cc, null, 100, ic);
  const seed = seedFrom(cc, op);
  const r = solveOp(cc, seed, 50, false);
  if (r.ok) return r;
  return { x: seed, ok: false, iterations: r.iterations, message: "the given operating point does not converge for this circuit; starting from it as is" };
}

function dcResult(cc: Compiled, sol: OpSolution, warn: string[]): DcResult {
  const { x } = sol;
  const els = cc.circuit.elements;
  const v: Record<Node, number> = {};
  for (const [nm, i] of cc.nodes) v[nm] = i === cc.n ? 0 : x[i];
  const i: Record<string, number> = {};
  const p: Record<string, number> = {};
  const id = (el: number) => els[el].id;
  const { res, cap, ind, vs, isrc, vcvs, dio, oa, sw, reg } = cc;
  for (let q = 0; q < res.el.length; q++) {
    const vab = x[res.a[q]] - x[res.b[q]];
    i[id(res.el[q])] = vab * res.g[q];
    p[id(res.el[q])] = vab * vab * res.g[q];
  }
  for (let q = 0; q < cap.el.length; q++) {
    if (cap.el[q] < 0) continue;
    i[id(cap.el[q])] = 0;
    p[id(cap.el[q])] = 0;
  }
  for (let q = 0; q < ind.el.length; q++) {
    i[id(ind.el[q])] = x[ind.k[q]];
    p[id(ind.el[q])] = 0;
  }
  for (const g of [vs, vcvs]) {
    for (let q = 0; q < g.el.length; q++) {
      i[id(g.el[q])] = x[g.k[q]];
      p[id(g.el[q])] = (x[g.a[q]] - x[g.b[q]]) * x[g.k[q]];
    }
  }
  for (let q = 0; q < isrc.el.length; q++) {
    i[id(isrc.el[q])] = isrc.dc[q];
    p[id(isrc.el[q])] = (x[isrc.a[q]] - x[isrc.b[q]]) * isrc.dc[q];
  }
  const dev = new Devices(cc);
  dev.evalAll(x);
  for (let q = 0; q < dio.el.length; q++) {
    i[id(dio.el[q])] = dev.dI[q];
    p[id(dio.el[q])] = dev.dI[q] * (x[dio.a[q]] - x[dio.k[q]]);
  }
  for (let q = 0; q < oa.el.length; q++) {
    const io = dev.oF[3 * q];
    const iq = dev.oF[3 * q + 2];
    const w = dev.oJ[8 * q + 7];
    const vo = x[oa.o[q]];
    const vp = x[oa.vp[q]];
    const vn = x[oa.vn[q]];
    i[id(oa.el[q])] = -io;
    i[`${id(oa.el[q])}.supply`] = iq + w * io;
    p[id(oa.el[q])] = iq * (vp - vn) + w * io * (vp - vo) + (1 - w) * io * (vn - vo);
  }
  for (let q = 0; q < sw.el.length; q++) {
    i[id(sw.el[q])] = dev.sI[q];
    p[id(sw.el[q])] = dev.sI[q] * (x[sw.a[q]] - x[sw.b[q]]);
  }
  for (let q = 0; q < reg.el.length; q++) {
    const io = dev.rF[2 * q];
    const iq = dev.rF[2 * q + 1];
    i[id(reg.el[q])] = -io;
    i[`${id(reg.el[q])}.in`] = io + iq;
    p[id(reg.el[q])] = (x[reg.i[q]] - x[reg.o[q]]) * io + (x[reg.i[q]] - x[reg.g[q]]) * iq;
  }
  const notes = [sol.message, ...warn].filter(Boolean);
  const out: DcResult = { ok: sol.ok, v, i, p, iterations: sol.iterations, ...(notes.length ? { message: notes.join("; ") } : {}) };
  FULL.set(out, { names: cc.names, x: x.slice() });
  return out;
}

const failedDc = (message: string): DcResult => ({ ok: false, v: {}, i: {}, p: {}, iterations: 0, message });

/** DC operating point: capacitors open, inductors shorted, every nonlinear element at its bias. */
export function dcOperatingPoint(c: Circuit, opts: { maxIter?: number } = {}): DcResult {
  const { fatal, warn } = inspect(c);
  if (fatal.length) return failedDc(fatal.join("; "));
  const cc = compile(c);
  return dcResult(cc, solveOp(cc, null, opts.maxIter ?? 100, false), warn);
}

// ---------------------------------------------------------------------------
// small signal

function probeIndex(cc: Compiled, p: Probe): [number, number] {
  const one = (nm: Node) => {
    const i = cc.nodes.get(nm);
    if (i === undefined) throw new Error(`unknown node "${nm}"`);
    return i;
  };
  return typeof p === "string" ? [one(p), cc.n] : [one(p[0]), one(p[1])];
}

function acSweep(cc: Compiled, x0: Float64Array, br: Float64Array, out: [number, number], freqs: number[]): AcResult {
  const { n, rows, cols, B } = cc;
  const dev = new Devices(cc);
  dev.evalAll(x0);
  const re = cc.G.slice();
  dev.stampJ(re);
  const bi = new Float64Array(n + 1);
  const xr = new Float64Array(n + 1);
  const xi = new Float64Array(n + 1);
  let lu = new ComplexLU(cc.plan);
  const h: Complex[] = [];
  for (const f of freqs) {
    const w = 2 * Math.PI * f;
    lu.load(re, B, w);
    if (!lu.factor()) {
      const im = B.map((b) => b * w);
      const { pr, pc } = numericOrder(n, rows, cols, re, im);
      lu = new ComplexLU(makePlan(n, rows, cols, pr, pc));
      lu.load(re, B, w);
      if (!lu.factor()) {
        h.push({ re: NaN, im: NaN });
        continue;
      }
    }
    lu.solve(br, bi, xr, xi);
    h.push({ re: xr[out[0]] - xr[out[1]], im: xi[out[0]] - xi[out[1]] });
  }
  return {
    freqs: freqs.slice(),
    h,
    db: h.map((z) => 20 * Math.log10(Math.hypot(z.re, z.im))),
    phase: h.map((z) => Math.atan2(z.im, z.re)),
  };
}

function acPrepare(c: Circuit, op: DcResult | undefined): { cc: Compiled; x: Float64Array } {
  const { fatal } = inspect(c);
  if (fatal.length) throw new Error(fatal.join("; "));
  const cc = compile(c);
  return { cc, x: startState(cc, op, false).x };
}

/**
 * Small-signal transfer from source `input` (a V source driven with 1 V, or
 * an I source with 1 A) to `out`, linearised at the operating point. Every
 * other source is zeroed.
 */
export function acTransfer(c: Circuit, opts: { input: string; out: Probe; freqs: number[]; op?: DcResult }): AcResult {
  const { cc, x } = acPrepare(c, opts.op);
  const br = new Float64Array(cc.n + 1);
  const els = cc.circuit.elements;
  const v = [...cc.vs.el].findIndex((el) => els[el].id === opts.input);
  const s = [...cc.isrc.el].findIndex((el) => els[el].id === opts.input);
  if (v >= 0) br[cc.vs.k[v]] = 1;
  else if (s >= 0) {
    br[cc.isrc.a[s]] -= 1;
    br[cc.isrc.b[s]] += 1;
  } else throw new Error(`no voltage or current source "${opts.input}" to drive`);
  return acSweep(cc, x, br, probeIndex(cc, opts.out), opts.freqs);
}

/** Impedance to ground at `node` (h in ohms), with voltage sources shorted and current sources open. */
export function acImpedance(c: Circuit, opts: { node: Node; freqs: number[]; op?: DcResult }): AcResult {
  const { cc, x } = acPrepare(c, opts.op);
  const br = new Float64Array(cc.n + 1);
  const at = probeIndex(cc, opts.node);
  if (at[0] === cc.n) throw new Error("the impedance of ground to ground is zero");
  br[at[0]] = 1;
  return acSweep(cc, x, br, at, opts.freqs);
}

/** `perDecade` points per decade from f0 to f1, both included. */
export function logFreqs(f0: number, f1: number, perDecade: number): number[] {
  if (!(f0 > 0) || !(f1 > 0)) throw new Error("frequencies must be positive");
  const steps = Math.max(1, Math.round(Math.abs(Math.log10(f1 / f0)) * perDecade));
  const out: number[] = [];
  for (let k = 0; k <= steps; k++) out.push(f0 * Math.pow(f1 / f0, k / steps));
  out[steps] = f1;
  return out;
}

// ---------------------------------------------------------------------------
// transient

/** Linear interpolation of a waveform at fractional sample t; silence outside it. */
function sampleAt(w: Float32Array | number[], t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = i >= 0 && i < w.length ? w[i] : 0;
  const b = i + 1 >= 0 && i + 1 < w.length ? w[i + 1] : 0;
  return a + (b - a) * f;
}

/**
 * Render a transient. The circuit sits at its operating point one sample
 * before the first output sample, and output sample k is the state at the
 * time of input sample k.
 */
export function transient(c: Circuit, o: TranOptions): TranResult {
  const samples = Math.max(0, Math.floor(o.samples));
  const out = o.probes.map(() => new Float32Array(samples));
  const fail = (message: string): TranResult => ({ ok: false, out, nonConverged: 0, message });
  if (!(o.fs > 0)) return fail("the sample rate must be positive");
  const M = Math.max(1, Math.floor(o.oversample ?? 1));
  const { fatal } = inspect(c);
  if (fatal.length) return fail(fatal.join("; "));
  const cc = compile(c);
  const { n, nnz, G, B, rows, cols, cap, ind } = cc;
  const els = cc.circuit.elements;

  let probes: [number, number][];
  try {
    probes = o.probes.map((p) => probeIndex(cc, p));
  } catch (err) {
    return fail(`${(err as Error).message} in the probes`);
  }

  // inputs: a V source's branch row, or an I source's two nodes
  const inRow: number[] = [];
  const inA: number[] = [];
  const inB: number[] = [];
  const waves: (Float32Array | number[])[] = [];
  for (const [id, wave] of Object.entries(o.inputs ?? {})) {
    const v = [...cc.vs.el].findIndex((el) => els[el].id === id);
    const s = [...cc.isrc.el].findIndex((el) => els[el].id === id);
    if (v >= 0) {
      inRow.push(cc.vs.k[v]);
      inA.push(n);
      inB.push(n);
    } else if (s >= 0) {
      inRow.push(n);
      inA.push(cc.isrc.a[s]);
      inB.push(cc.isrc.b[s]);
    } else return fail(`no voltage or current source "${id}" for an input waveform`);
    waves.push(wave);
  }

  const start = startState(cc, o.op, true);
  if (!start.ok && !o.op) return fail(start.message ?? "no operating point");

  let xn = new Float64Array(n + 1);
  let xNext = new Float64Array(n + 1);
  const xg = new Float64Array(n + 1);
  xn.set(start.x);

  // reactive state at the start of the step
  const nc = cap.c.length;
  const vC = new Float64Array(nc);
  const iC = new Float64Array(nc);
  const vCg = new Float64Array(nc);
  for (let q = 0; q < nc; q++) {
    vC[q] = xn[cap.a[q]] - xn[cap.b[q]];
    // a pinned capacitor starts out carrying the current its pin was supplying
    if (!o.op && !Number.isNaN(cap.ic[q])) iC[q] = G_IC * (vC[q] - cap.ic[q]);
  }
  const nl = ind.l.length;
  const iL = new Float64Array(nl);
  const vL = new Float64Array(nl);
  const iLg = new Float64Array(nl);
  for (let q = 0; q < nl; q++) {
    iL[q] = xn[ind.k[q]];
    vL[q] = xn[ind.a[q]] - xn[ind.b[q]];
  }

  let lu = new RealLU(cc.plan);
  const dev = new Devices(cc, lu.plan.map);
  dev.evalAll(xn);
  const src = new Float64Array(n + 1);
  sourceRhs(cc, 1, src);
  const rhs0 = new Float64Array(n + 1);
  const rhs = new Float64Array(n + 1);

  // one base matrix (in factor slots) per step size
  const hSample = 1 / M;
  const hSec = 1 / (o.fs * M);
  let bases: Float64Array[] = [];
  const base = (lv: number) => {
    let b = bases[lv];
    if (!b) {
      const kap = (2 / (GAMMA * hSec)) * 2 ** lv;
      b = new Float64Array(lu.plan.size + 1);
      const { map } = lu.plan;
      for (let s = 0; s < nnz; s++) b[map[s]] = G[s] + kap * B[s];
      bases[lv] = b;
    }
    return b;
  };
  let factoredLevel = -1;
  let broken = "";

  const refactor = (lv: number): boolean => {
    lu.a.set(base(lv));
    dev.stampJ(lu.a);
    if (lu.factor()) {
      factoredLevel = lv;
      return true;
    }
    // a zero pivot: order the pivots from the values instead
    const kap = (2 / (GAMMA * hSec)) * 2 ** lv;
    const m = new Float64Array(nnz + 1);
    for (let s = 0; s < nnz; s++) m[s] = G[s] + kap * B[s];
    dev.bind();
    dev.stampJ(m);
    const { pr, pc } = numericOrder(n, rows, cols, m);
    lu = new RealLU(makePlan(n, rows, cols, pr, pc));
    dev.bind(lu.plan.map);
    bases = [];
    lu.a.set(base(lv));
    dev.stampJ(lu.a);
    if (lu.factor()) {
      factoredLevel = lv;
      return true;
    }
    factoredLevel = -1;
    return false;
  };

  const newton = (lv: number, x: Float64Array): boolean => {
    for (let it = 0; it < TRAN_MAXIT; it++) {
      if ((dev.dirty || factoredLevel !== lv) && !refactor(lv)) {
        broken = "the circuit matrix became singular";
        return false;
      }
      rhs.set(rhs0);
      dev.stampRhs(rhs);
      lu.solve(rhs, x);
      if (!Number.isFinite(x[0]) || !Number.isFinite(x[n - 1])) return false;
      if (dev.update(x, TRAN_TOL)) return true;
    }
    return false;
  };

  const sources = (t: number) => {
    rhs0.set(src);
    for (let q = 0; q < waves.length; q++) {
      const v = sampleAt(waves[q], t);
      rhs0[inRow[q]] += v;
      rhs0[inA[q]] -= v;
      rhs0[inB[q]] += v;
    }
  };

  let nonConverged = 0;
  const ca = cap.a;
  const cb = cap.b;
  const cv = cap.c;

  /** Advance from time t (in samples) by h samples; splits itself when Newton struggles. */
  const step = (t: number, h: number, lv: number): boolean => {
    const kap = (2 / (GAMMA * hSec)) * 2 ** lv;
    // stage 1: trapezoidal to t + γh
    sources(t + GAMMA * h);
    for (let q = 0; q < nc; q++) {
      const s = kap * cv[q] * vC[q] + iC[q];
      rhs0[ca[q]] += s;
      rhs0[cb[q]] -= s;
    }
    for (let q = 0; q < nl; q++) rhs0[ind.k[q]] -= kap * ind.l[q] * iL[q] + vL[q];
    let ok = newton(lv, xg);
    if (!ok && lv < TRAN_MAXLEVEL && !broken) return split(t, h, lv);
    if (!ok) nonConverged++;
    for (let q = 0; q < nc; q++) vCg[q] = xg[ca[q]] - xg[cb[q]];
    for (let q = 0; q < nl; q++) iLg[q] = xg[ind.k[q]];
    // stage 2: BDF2 through t, t + γh and t + h
    sources(t + h);
    for (let q = 0; q < nc; q++) {
      const s = kap * cv[q] * (BDF_A * vCg[q] - BDF_B * vC[q]);
      rhs0[ca[q]] += s;
      rhs0[cb[q]] -= s;
    }
    for (let q = 0; q < nl; q++) rhs0[ind.k[q]] -= kap * ind.l[q] * (BDF_A * iLg[q] - BDF_B * iL[q]);
    ok = newton(lv, xNext);
    if (!ok && lv < TRAN_MAXLEVEL && !broken) return split(t, h, lv);
    if (!ok) nonConverged++;
    for (let q = 0; q < nc; q++) {
      const v1 = xNext[ca[q]] - xNext[cb[q]];
      iC[q] = kap * cv[q] * (v1 - BDF_A * vCg[q] + BDF_B * vC[q]);
      vC[q] = v1;
    }
    for (let q = 0; q < nl; q++) {
      iL[q] = xNext[ind.k[q]];
      vL[q] = xNext[ind.a[q]] - xNext[ind.b[q]];
    }
    const tmp = xn;
    xn = xNext;
    xNext = tmp;
    return true;
  };
  const split = (t: number, h: number, lv: number): boolean => {
    // the start state is untouched; re-linearise there and take two half steps
    dev.evalAll(xn);
    return step(t, h / 2, lv + 1) && step(t + h / 2, h / 2, lv + 1);
  };

  const np = probes.length;
  const progressEvery = 4096;
  for (let k = 0; k < samples; k++) {
    for (let j = 0; j < M; j++) {
      step(k - 1 + j * hSample, hSample, 0);
      if (broken) return { ok: false, out, nonConverged, message: `${broken} at ${((k / o.fs) * 1000).toFixed(2)} ms` };
    }
    for (let p = 0; p < np; p++) out[p][k] = xn[probes[p][0]] - xn[probes[p][1]];
    if (o.onProgress && k % progressEvery === progressEvery - 1) o.onProgress((k + 1) / samples);
  }
  o.onProgress?.(1);
  const notes: string[] = [];
  if (!start.ok && start.message) notes.push(start.message);
  if (nonConverged) notes.push(`${nonConverged} step${nonConverged === 1 ? "" : "s"} did not fully converge`);
  return { ok: true, out, nonConverged, ...(notes.length ? { message: notes.join("; ") } : {}) };
}
