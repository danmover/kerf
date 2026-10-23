// The CPU solver on several threads, for runs from Node (validation and
// long design studies): the lattices and record sums live in shared memory,
// each thread steps a slab of z planes, and they meet at a barrier after
// every step. Same calls as the solvers in src/analysis/aero/solve.ts.

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { CpuLbm } from "../../src/analysis/aero/cpu";
import { cellCount, coarseDims, FIELD_AVG, REC_AVG, type LbmCase } from "../../src/analysis/aero/case";
import { Q } from "../../src/analysis/aero/lattice";
import type { Solver } from "../../src/analysis/aero/solve";

const sab = (n: number) => new Float32Array(new SharedArrayBuffer(Math.max(4, n * 4)));

export class ThreadedCpuSolver implements Solver {
  readonly backend = "cpu" as const;
  msPerStep = 0;
  private main: CpuLbm;
  private workers: Worker[] = [];
  private avg = false;
  private steps = 0;
  private fieldSamples = 0;
  private shared: { A: Float32Array; B: Float32Array; recForce: Float32Array; recAvg: Float32Array; recSlip: Float32Array; field: Float32Array };

  constructor(
    readonly c: LbmCase,
    workerFile: string,
    threads = availableParallelism(),
  ) {
    const N = cellCount(c);
    const [cx, cy, cz] = coarseDims(c);
    this.shared = { A: sab(Q * N), B: sab(Q * N), recForce: sab(3 * c.rec.count), recAvg: sab(REC_AVG * c.rec.count), recSlip: sab(3 * c.rec.count), field: sab(cx * cy * cz * FIELD_AVG) };
    this.main = new CpuLbm(c, this.shared);
    this.main.init();
    const ctrl = new Int32Array(new SharedArrayBuffer(8));
    const T = Math.max(1, Math.min(threads, c.nz));
    for (let t = 0; t < T; t++) {
      const z0 = Math.round((t * c.nz) / T);
      const z1 = Math.round(((t + 1) * c.nz) / T);
      const Z0 = Math.round((t * cz) / T);
      const Z1 = Math.round(((t + 1) * cz) / T);
      this.workers.push(new Worker(workerFile, { workerData: { c, shared: this.shared, ctrl, z: [z0, z1], Z: [Z0, Z1], threads: T } }));
    }
  }

  private send(msg: object): Promise<void> {
    return Promise.all(
      this.workers.map(
        (w) =>
          new Promise<void>((res, rej) => {
            const done = (m: unknown) => {
              w.off("error", rej);
              res(m as undefined);
            };
            w.once("message", done);
            w.once("error", rej);
            w.postMessage(msg);
          }),
      ),
    ).then(() => undefined);
  }

  async run(steps: number, fieldEvery: number) {
    const t0 = performance.now();
    await this.send({ cmd: "run", steps, fieldEvery, avg: this.avg, base: this.steps });
    const ms = (performance.now() - t0) / Math.max(1, steps);
    this.msPerStep = this.msPerStep ? 0.7 * this.msPerStep + 0.3 * ms : ms;
    for (let s = 1; s <= steps; s++) if (fieldEvery > 0 && this.avg && (this.steps + s) % fieldEvery === 0) this.fieldSamples++;
    if (this.avg) this.main.avgSteps += steps;
    this.steps += steps;
    // keep the main view of the lattices on the latest one
    if (steps % 2) [this.main.A, this.main.B] = [this.main.B, this.main.A];
  }

  setAveraging(on: boolean) {
    this.avg = on;
  }

  resetAverages() {
    this.shared.recAvg.fill(0);
    this.shared.field.fill(0);
    this.main.avgSteps = 0;
    this.fieldSamples = 0;
  }

  async forces() {
    return this.main.partForces();
  }

  async averages() {
    return { rec: this.shared.recAvg.slice(), field: this.shared.field.slice(), avgSteps: this.main.avgSteps, fieldSamples: this.fieldSamples };
  }

  async snapshot() {
    const keep = this.shared.field.slice();
    this.shared.field.fill(0);
    this.main.sampleField();
    const out = this.shared.field.slice();
    this.shared.field.set(keep);
    return out;
  }

  async slice(y: number) {
    const { nx, nz } = this.c;
    const out = new Float32Array(nx * nz);
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) out[x + nx * z] = Math.hypot(...this.main.cell(x, Math.round(y), z).u) / Math.hypot(...this.c.u);
    return out;
  }

  dispose() {
    for (const w of this.workers) void w.terminate();
  }
}
