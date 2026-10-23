// Runs an airflow analysis: for each yaw angle, lays out the tunnel(s),
// lets the flow settle, then averages the forces until their mean is known
// to the quality's tolerance (batch means on the drag), and turns the
// averages into forces, surface fields and flow pictures. The GPU does the
// stepping where WebGPU is available; the CPU solver is the fallback, on a
// coarser grid.

import { CpuLbm } from "./cpu";
import { gpuAdapter, gpuCellLimit, GpuError, GpuLbm } from "./gpu";
import { cellCount, coarseDims, type LbmCase } from "./case";
import { SOLID, TYPE_MASK, U_LATTICE } from "./lattice";
import { bodyAxes, buildLevel, cellBudget, dot, meanFlow, planRun, scale, toWorld, vecToWorld, type BuiltLevel, type LevelPlan } from "./setup";
import { blockFlow, flowVolume, frontalArea, integrateDrag, meanMoment, meanPartForces, streamlines, surfaceFields, vortexSurface, wakeSurface, wallData } from "./post";
import type { V3 } from "./geometry";
import type { AirflowInput, AirflowProgress, AirflowResult, PartForce, SurfaceField, YawResult } from "./types";

/** One solver, CPU or GPU, behind the calls a run makes. */
export interface Solver {
  readonly backend: "gpu" | "cpu";
  /** milliseconds per step, measured */
  readonly msPerStep: number;
  run(steps: number, fieldEvery: number): Promise<void>;
  setAveraging(on: boolean): void;
  resetAverages(): void;
  /** instantaneous force per part, lattice units */
  forces(): Promise<Float64Array>;
  averages(): Promise<{ rec: Float32Array; field: Float32Array; avgSteps: number; fieldSamples: number }>;
  /** the instantaneous flow per block, in the averaged field's layout (one sample) */
  snapshot(): Promise<Float32Array>;
  /** speed share on the plane y, nx × nz (−1 in solids) */
  slice(y: number): Promise<Float32Array>;
  dispose(): void;
}

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

export class CpuSolver implements Solver {
  readonly backend = "cpu" as const;
  msPerStep = 0;
  readonly lbm: CpuLbm;
  private avg = false;

  constructor(c: LbmCase) {
    this.lbm = new CpuLbm(c);
  }

  async run(steps: number, fieldEvery: number) {
    let t = performance.now();
    for (let s = 0; s < steps; s++) {
      const t0 = performance.now();
      this.lbm.step(this.avg);
      if (fieldEvery > 0 && this.avg && this.lbm.steps % fieldEvery === 0) this.lbm.sampleField();
      const t1 = performance.now();
      this.msPerStep = this.msPerStep ? 0.9 * this.msPerStep + 0.1 * (t1 - t0) : t1 - t0;
      // let messages (a cancel) through now and then
      if (t1 - t > 60) {
        await yieldNow();
        t = performance.now();
      }
    }
  }

  setAveraging(on: boolean) {
    this.avg = on;
  }

  resetAverages() {
    this.lbm.resetAverages();
  }

  async forces() {
    return this.lbm.partForces();
  }

  async averages() {
    const l = this.lbm;
    return { rec: l.recAvg.slice(), field: l.field.slice(), avgSteps: l.avgSteps, fieldSamples: l.fieldSamples };
  }

  async snapshot() {
    return this.lbm.snapshot();
  }

  async slice(y: number) {
    const { nx, ny, nz, flags, u } = this.lbm.c;
    const out = new Float32Array(nx * nz);
    const Y = Math.min(ny - 1, Math.max(0, Math.round(y)));
    const U = Math.hypot(...u) || 1;
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const n = x + nx * (Y + ny * z);
        if ((flags[n] & TYPE_MASK) === SOLID) out[x + nx * z] = -1;
        else out[x + nx * z] = Math.hypot(...this.lbm.cell(x, Y, z).u) / U;
      }
    return out;
  }

  dispose() {}
}

export class GpuSolver implements Solver {
  readonly backend = "gpu" as const;
  private constructor(readonly lbm: GpuLbm) {}

  static async create(c: LbmCase, half: boolean, adapter: GPUAdapter | null) {
    return new GpuSolver(await GpuLbm.create(c, half, adapter));
  }

  get msPerStep() {
    return this.lbm.msPerStep;
  }

  run(steps: number, fieldEvery: number) {
    return this.lbm.run(steps, fieldEvery);
  }

  setAveraging(on: boolean) {
    this.lbm.setAveraging(on);
  }

  resetAverages() {
    this.lbm.resetAverages();
  }

  forces() {
    return this.lbm.partForces();
  }

  averages() {
    return this.lbm.averages();
  }

  snapshot() {
    return this.lbm.snapshot();
  }

  slice(y: number) {
    return this.lbm.slice(y);
  }

  dispose() {
    this.lbm.dispose();
  }
}

export interface RunOptions {
  onProgress?: (p: AirflowProgress) => void;
  /** checked between batches of steps: true stops the run */
  aborted?: () => boolean;
  /** make the solver for a case (Node runs and tests bring their own, e.g. a threaded CPU solver) */
  solver?: (c: LbmCase) => Promise<Solver>;
  /** what the given solver is, for sizing the grid */
  solverBackend?: "gpu" | "cpu";
}

export class AirflowCancelled extends Error {
  constructor() {
    super("the airflow run was stopped");
  }
}

/** Tolerance on the mean drag (standard error over mean) and how long to average, by quality. */
const QUALITY = {
  draft: { tol: 0.03, avg: 0.5 },
  standard: { tol: 0.015, avg: 1 },
  fine: { tol: 0.0075, avg: 1.5 },
} as const;

/** Standard error of a series' mean by batch means (10 batches). */
export function batchStderr(xs: number[]): number {
  const B = 10;
  if (xs.length < 2 * B) return Infinity;
  const m = Math.floor(xs.length / B);
  const means: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = (xs.length - B * m) + b * m, e = i + m; i < e; i++) s += xs[i];
    means.push(s / m);
  }
  const mu = means.reduce((a, b) => a + b, 0) / B;
  const v = means.reduce((a, b) => a + (b - mu) ** 2, 0) / (B - 1);
  return Math.sqrt(v / B);
}

/** Run the analysis: every yaw in turn, each to its own converged averages. */
export async function runAirflow(input: AirflowInput, opt: RunOptions = {}): Promise<AirflowResult> {
  const t0 = performance.now();
  const warnings: string[] = [];
  const half = input.half ?? true;
  let backend: "gpu" | "cpu" = opt.solverBackend ?? "cpu";
  let adapter: GPUAdapter | null = null;
  let adapterName: string | undefined;
  if (!opt.solver && input.backend !== "cpu") {
    adapter = await gpuAdapter();
    if (adapter) {
      backend = "gpu";
      const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
      adapterName = [info?.vendor, info?.description || info?.architecture].filter(Boolean).join(" ") || undefined;
    } else warnings.push("No WebGPU here, so it ran on the CPU on a coarser grid. Kerf's desktop app on a computer with a graphics card runs it much finer.");
  }
  const deadline = t0 + Math.max(0.5, input.maxMinutes) * 60e3;
  const yaws: YawResult[] = [];
  let shared: SurfaceField[] | undefined;
  let first: LevelPlan | null = null;
  let outerPlan: LevelPlan | null = null;
  const { F, U: up, R } = bodyAxes(input);
  const q = 0.5 * input.density * input.speed * input.speed;
  const ms = () => performance.now() - t0;

  for (const [yi, yaw] of input.yaws.entries()) {
    let budget = cellBudget(input.quality, backend === "gpu");
    if (backend === "gpu" && adapter) {
      const lim = 0.9 * gpuCellLimit(adapter, half);
      budget = { inner: Math.min(budget.inner, lim), outer: Math.min(budget.outer, lim) };
    }
    const plan = planRun(input, yaw, budget);
    outerPlan ??= plan.levels[0];
    const yawStart = performance.now();
    const share = (deadline - yawStart) / (input.yaws.length - yi);
    const yawDeadline = yawStart + share;
    const beta = (yaw * Math.PI) / 180;
    const roadSpeed = input.speed * Math.cos(beta);
    let parent: { plan: LevelPlan; mean: Float32Array; dims: V3; coarse: number } | undefined;
    let result: YawResult | null = null;

    for (const [li, lp] of plan.levels.entries()) {
      const last = li === plan.levels.length - 1;
      const lv = buildLevel(input, yaw, lp, parent);
      if (last && yi === 0) {
        if (lv.missed > 0.01 * Math.max(1, lv.case.rec.count)) warnings.push(`${lv.missed} wall links did not meet a surface (an open or self-crossing mesh); they were treated as walls halfway along.`);
        for (const [k, b] of input.bodies.entries()) {
          const own = lv.case.rec.partStart[k + 1] - lv.case.rec.partStart[k];
          if (own === 0) warnings.push(`${b.name} is too small for the cells and adds no drag.`);
        }
      }
      let solver: Solver;
      try {
        solver = opt.solver ? await opt.solver(lv.case) : backend === "gpu" ? await GpuSolver.create(lv.case, half, adapter) : new CpuSolver(lv.case);
      } catch (e) {
        if (!(e instanceof GpuError) || opt.solver) throw e;
        // the GPU could not take it: the CPU, coarser, from this yaw on
        warnings.push(`The GPU could not run it (${e.message}), so it ran on the CPU on a coarser grid.`);
        backend = "cpu";
        adapter = null;
        return runAirflow({ ...input, backend: "cpu" }, opt).then((r) => ({ ...r, warnings: [...warnings, ...r.warnings] }));
      }
      try {
        const out = await settleAndAverage(input, lv, solver, {
          last,
          nested: !!parent,
          size: plan.size,
          deadline: last ? yawDeadline : yawStart + 0.25 * share,
          progress: (frac, stage, extra) =>
            opt.onProgress?.({
              stage: plan.levels.length > 1 ? `${stage} (${last ? "close up" : "whole tunnel"})` : stage,
              frac: (yi + (plan.levels.length > 1 ? (last ? 0.3 + 0.7 * frac : 0.3 * frac) : frac)) / input.yaws.length,
              yaw,
              ...extra,
            }),
          aborted: opt.aborted,
          dragOf: (Fl) => -dot(vecToWorld(lp.frame, Fl), F) * forceScale(input, lp.frame.h),
        });
        if (!last) {
          const dims = coarseDims(lv.case);
          parent = { plan: lp, mean: meanFlow(out.field, dims[0] * dims[1] * dims[2]), dims, coarse: lv.case.coarse };
          continue;
        }
        opt.onProgress?.({ stage: "Working out the results", frac: (yi + 0.98) / input.yaws.length, yaw });
        const fs = forceScale(input, lp.frame.h);
        const pf = meanPartForces(lv, out.rec, out.avgSteps);
        const wd = wallData(lv, out.rec, out.avgSteps);
        const surface = surfaceFields(lv, input.bodies, wd, shared);
        shared ??= surface;
        const parts: PartForce[] = [];
        const total: V3 = [0, 0, 0];
        for (const [k, b] of input.bodies.entries()) {
          const Fw = scale(vecToWorld(lp.frame, [pf[3 * k], pf[3 * k + 1], pf[3 * k + 2]]), fs);
          total[0] += Fw[0];
          total[1] += Fw[1];
          total[2] += Fw[2];
          const drag = -dot(Fw, F);
          const split = integrateDrag(surface[k], scale(F, -1));
          const fr = split.friction + split.pressure !== 0 ? split.friction / (split.friction + split.pressure) : 0;
          parts.push({ id: b.id, name: b.name, drag, side: -dot(Fw, R), lift: dot(Fw, up), cda: drag / q, friction: Math.min(1, Math.max(0, fr)), extra: b.extra });
        }
        const drag = -dot(total, F);
        const area = frontalArea(input.bodies, lp.frame.ex, lp.frame.ey, lp.frame.ez);
        const centre = toWorld(lp.frame, [(lp.body.lo[0] + lp.body.hi[0]) / 2, (lp.body.lo[1] + lp.body.hi[1]) / 2, (lp.body.lo[2] + lp.body.hi[2]) / 2]);
        const M = scale(meanMoment(lv, out.rec, out.avgSteps, centre, lv.parts.findIndex((p) => p.road)), fs * 1e-3);
        const bf = blockFlow(lv, out.field);
        const snap = blockFlow(lv, out.snapshot);
        const yp = Array.from(wd.yPlus).filter(Number.isFinite).sort((a, b) => a - b);
        const thin = Math.max(1, Math.min(plan.size[1], plan.size[2]));
        result = {
          yaw,
          drag,
          side: -dot(total, R),
          lift: dot(total, up),
          windDrag: dot(total, lp.frame.ex),
          cda: drag / q,
          area,
          cd: area > 0 ? drag / q / area : 0,
          watts: drag * roadSpeed,
          pitch: dot(M, R),
          yawMoment: -dot(M, up),
          parts,
          history: decimate(out.history, 240),
          stderr: out.stderr,
          converged: out.converged,
          steps: out.steps,
          seconds: (performance.now() - yawStart) / 1e3,
          surface,
          streamlines: streamlines(lv, bf),
          wake: wakeSurface(lv, bf),
          vortices: vortexSurface(lv, snap, thin),
          volume: flowVolume(lv, bf),
          yPlus: yp.length ? yp[Math.floor(yp.length / 2)] : NaN,
        };
        first ??= lp;
      } finally {
        solver.dispose();
      }
    }
    if (result) {
      if (!result.converged) warnings.push(`At ${yaw}° the drag had not settled to the quality's tolerance in the time allowed (±${((100 * result.stderr) / Math.max(1e-9, Math.abs(result.drag))).toFixed(1)} %).`);
      yaws.push(result);
    }
  }

  if (!first) throw new Error("no yaw angles to run");
  const fp = first;
  const size = planRun(input, input.yaws[0] ?? 0, cellBudget(input.quality, backend === "gpu")).size;
  const tunnel = outerPlan!;
  const crossSection = tunnel.dims[1] * tunnel.dims[2] * (tunnel.frame.h * 1e-3) ** 2;
  return {
    label: input.label,
    speed: input.speed,
    density: input.density,
    yaws,
    h: fp.frame.h,
    dims: fp.dims,
    cells: cellCount({ nx: fp.dims[0], ny: fp.dims[1], nz: fp.dims[2] }),
    backend,
    adapter: adapterName,
    reynolds: (input.speed * size[0] * 1e-3) / input.nu,
    blockage: yaws.length ? yaws[0].area / crossSection : 0,
    warnings: [...new Set(warnings)],
    ms: ms(),
  };
}

/** Lattice force → newtons for a cell size (mm): ρ h² (U / U_lattice)². */
export function forceScale(input: Pick<AirflowInput, "density" | "speed">, hMm: number): number {
  return input.density * (hMm * 1e-3) ** 2 * (input.speed / U_LATTICE) ** 2;
}

function decimate(xs: number[], n: number): number[] {
  if (xs.length <= n) return xs;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * (xs.length - 1)) / (n - 1))]);
  return out;
}

interface Phase {
  last: boolean;
  nested: boolean;
  size: V3;
  deadline: number;
  progress: (frac: number, stage: string, extra: Partial<AirflowProgress>) => void;
  aborted?: () => boolean;
  /** body-axis drag in newtons from a lattice force (world sum over the bodies) */
  dragOf: (F: V3) => number;
}

interface PhaseOut {
  rec: Float32Array;
  field: Float32Array;
  snapshot: Float32Array;
  avgSteps: number;
  history: number[];
  stderr: number;
  converged: boolean;
  steps: number;
}

/**
 * Settle then average one level. Times are in steps for the air to cross a number of cells: the outer tunnel only
 * needs its averaged flow round the bodies; the level that counts averages until the drag's standard error is
 * within tolerance (but at least long enough for a few eddies to shed).
 */
async function settleAndAverage(input: AirflowInput, lv: BuiltLevel, s: Solver, ph: Phase): Promise<PhaseOut> {
  const h = lv.plan.frame.h;
  const T = (cells: number) => Math.ceil(cells / U_LATTICE);
  const Lb = ph.size[0] / h;
  const S = Math.max(ph.size[1], ph.size[2], 0.3 * ph.size[0]) / h;
  const D = Math.max(1, Math.min(ph.size[1], ph.size[2])) / h;
  const qual = QUALITY[input.quality];
  const develop = !ph.last ? T(1.5 * Lb + 2 * S) : ph.nested ? T(0.6 * lv.case.nx) : T(2 * Lb + 2 * S);
  const avgMin = !ph.last ? T(0.5 * (Lb + S)) : Math.ceil(qual.avg * T(Math.max(1.5 * Lb, 10 * D)));
  const avgMax = ph.last ? 4 * avgMin : avgMin;
  const every = Math.min(100, Math.max(5, Math.round(T(Lb / 50))));
  const fieldEvery = Math.max(4, Math.round(every / 2));
  const roadPart = lv.parts.findIndex((p) => p.road);
  const nb = lv.parts.length;
  const yMid = Math.round((lv.plan.body.lo[1] + lv.plan.body.hi[1]) / 2);
  const f = lv.plan.frame;
  const total = (Fp: Float64Array): V3 => {
    const t: V3 = [0, 0, 0];
    for (let p = 0; p < nb; p++) {
      if (p === roadPart) continue;
      t[0] += Fp[3 * p];
      t[1] += Fp[3 * p + 1];
      t[2] += Fp[3 * p + 2];
    }
    return t;
  };
  const cells = cellCount(lv.case);
  let lastSlice = 0;
  let lastNote = 0;
  const qd = 0.5 * input.density * input.speed * input.speed;
  const note = async (frac: number, stage: string, drag: number) => {
    const now = performance.now();
    if (now - lastNote < 400) return;
    lastNote = now;
    const extra: Partial<AirflowProgress> = { drag, cda: drag / qd, mlups: s.msPerStep > 0 ? cells / (s.msPerStep * 1e3) : undefined };
    if (now - lastSlice > 1500) {
      lastSlice = now;
      const data = await s.slice(yMid);
      extra.slice = { w: lv.case.nx, h: lv.case.nz, data, origin: toWorld(f, [0, yMid, 0]), ex: f.ex, ez: f.ez, cell: h };
    }
    ph.progress(frac, stage, extra);
  };
  const check = () => {
    if (ph.aborted?.()) throw new AirflowCancelled();
  };

  let steps = 0;
  const devStage = ph.last ? "Letting the flow settle" : "Settling the flow round the tunnel";
  const devCap = ph.deadline - 0.5 * (ph.deadline - performance.now());
  while (steps < develop) {
    check();
    const n = Math.min(every, develop - steps);
    await s.run(n, 0);
    steps += n;
    const d = ph.dragOf(total(await s.forces()));
    await note((0.45 * steps) / develop, devStage, d);
    // don't let settling eat the averaging's time
    if (performance.now() > devCap && steps > 0.5 * develop) break;
  }

  s.resetAverages();
  s.setAveraging(true);
  const hist: number[] = [];
  let avg = 0;
  let stderr = Infinity;
  let converged = false;
  const avgStage = ph.last ? "Averaging the forces" : "Averaging the tunnel's flow";
  while (avg < avgMax) {
    check();
    await s.run(every, fieldEvery);
    avg += every;
    steps += every;
    const d = ph.dragOf(total(await s.forces()));
    hist.push(d);
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    if (avg >= avgMin) {
      stderr = batchStderr(hist);
      if (!ph.last || stderr <= qual.tol * Math.abs(mean)) {
        converged = true;
        break;
      }
    }
    await note(0.45 + (0.55 * avg) / (ph.last ? Math.max(avgMin, Math.min(avgMax, avg * 1.25)) : avgMax), avgStage, mean);
    if (performance.now() > ph.deadline && avg >= Math.min(avgMin, 0.5 * avgMax)) break;
  }
  s.setAveraging(false);
  const a = await s.averages();
  const snapshot = ph.last ? await s.snapshot() : new Float32Array(0);
  if (!Number.isFinite(stderr)) stderr = batchStderr(hist);
  return { rec: a.rec, field: a.field, snapshot, avgSteps: a.avgSteps, history: hist, stderr, converged, steps };
}
