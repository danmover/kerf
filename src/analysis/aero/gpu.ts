/// <reference types="@webgpu/types" />
// The airflow solver on the GPU through WebGPU: buffers for two lattices,
// the cell flags, the boundary records and their outputs, and the pipelines
// for a step, the per-part force sums, the averaged field and start-up.
// Steps ping-pong between the lattices; work is submitted in batches sized
// to a few tens of milliseconds so the rest of the app keeps drawing.

import { REC_AVG, FIELD_AVG, cellCount, coarseDims, type LbmCase } from "./case";
import { CLEAR_SUMS_KERNEL, MAX_PARTS, MODE_AVERAGE, MODE_PX, MODE_PY, MODE_PZ, MODE_WALL, PARAMS_BYTES, REC_OUT, REC_WORDS, REDUCE_KERNEL, WORKGROUP, fieldKernel, initKernel, sliceKernel, stepKernel } from "./kernels";
import { toHalf } from "./half";

export class GpuError extends Error {}

/** Bytes per cell the solver needs on the GPU (two lattices, flags), for sizing a grid. */
export const gpuBytesPerCell = (half: boolean) => 2 * 19 * (half ? 2 : 4) + 4;

/** The WebGPU adapter and the largest buffers it allows, or null where WebGPU is missing or blocked. */
export async function gpuAdapter(): Promise<GPUAdapter | null> {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (!nav?.gpu) return null;
  try {
    return await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    return null;
  }
}

/** The most cells one lattice can hold on this adapter (each half of a lattice is one storage binding). */
export function gpuCellLimit(a: GPUAdapter, half: boolean): number {
  const bind = Math.min(a.limits.maxStorageBufferBindingSize, a.limits.maxBufferSize);
  return Math.floor(bind / (10 * (half ? 2 : 4)));
}

export class GpuLbm {
  readonly N: number;
  readonly NP: number;
  private A: GPUBuffer[];
  private B: GPUBuffer[];
  private flags: GPUBuffer;
  private recs: GPUBuffer;
  private recOut: GPUBuffer;
  private far: GPUBuffer;
  private partF: GPUBuffer;
  private field: GPUBuffer;
  private params: GPUBuffer;
  private paramData: ArrayBuffer;
  private stepPipe: GPUComputePipeline;
  private reducePipe: GPUComputePipeline;
  private fieldPipe: GPUComputePipeline;
  private clearPipe: GPUComputePipeline;
  private clearGroup: GPUBindGroup;
  /** step bind groups: A→B and B→A */
  private stepGroups: GPUBindGroup[];
  private fieldGroups: GPUBindGroup[];
  private reduceGroup: GPUBindGroup;
  private parity = 0;
  private mode = 0;
  avgSteps = 0;
  fieldSamples = 0;
  steps = 0;
  /** milliseconds per step, measured */
  msPerStep = 0;
  private lost = false;
  private uNow: [number, number, number];

  private constructor(
    readonly device: GPUDevice,
    readonly c: LbmCase,
    readonly half: boolean,
  ) {
    this.N = cellCount(c);
    if (half && c.nx % 2) throw new GpuError("the half-precision lattice needs an even number of cells along x");
    this.NP = half ? this.N / 2 : this.N;
    const d = device;
    const latt = () => [0, 1].map((k) => d.createBuffer({ size: Math.max(16, (k ? 9 : 10) * this.NP * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }));
    this.A = latt();
    this.B = latt();
    this.flags = this.upload(c.flags, GPUBufferUsage.STORAGE);
    this.recs = this.upload(packRecords(c), GPUBufferUsage.STORAGE);
    this.recOut = d.createBuffer({ size: Math.max(16, c.rec.count * REC_OUT * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.far = this.upload(c.far?.length ? c.far : new Float32Array(4), GPUBufferUsage.STORAGE);
    this.partF = d.createBuffer({ size: Math.max(16, c.parts.length * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const [cx, cy, cz] = coarseDims(c);
    this.field = d.createBuffer({ size: Math.max(16, cx * cy * cz * FIELD_AVG * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.uNow = [...c.u];
    this.paramData = new ArrayBuffer(PARAMS_BYTES);
    this.params = d.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.mode = (c.periodic[0] ? MODE_PX : 0) | (c.periodic[1] ? MODE_PY : 0) | (c.periodic[2] ? MODE_PZ : 0) | (c.wallModel ? MODE_WALL : 0);
    this.writeParams();

    const mod = (code: string) => d.createShaderModule({ code });
    this.stepPipe = d.createComputePipeline({ layout: "auto", compute: { module: mod(stepKernel(half)), entryPoint: "main" } });
    this.reducePipe = d.createComputePipeline({ layout: "auto", compute: { module: mod(REDUCE_KERNEL), entryPoint: "main" } });
    this.fieldPipe = d.createComputePipeline({ layout: "auto", compute: { module: mod(fieldKernel(half)), entryPoint: "main" } });
    this.clearPipe = d.createComputePipeline({ layout: "auto", compute: { module: mod(CLEAR_SUMS_KERNEL), entryPoint: "main" } });
    const initPipe = d.createComputePipeline({ layout: "auto", compute: { module: mod(initKernel(half)), entryPoint: "main" } });

    const ent = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer } });
    const stepGroup = (src: GPUBuffer[], dst: GPUBuffer[]) =>
      d.createBindGroup({
        layout: this.stepPipe.getBindGroupLayout(0),
        entries: [ent(0, this.params), ent(1, src[0]), ent(2, src[1]), ent(3, dst[0]), ent(4, dst[1]), ent(5, this.flags), ent(6, this.recs), ent(7, this.recOut), ent(8, this.far)],
      });
    this.stepGroups = [stepGroup(this.A, this.B), stepGroup(this.B, this.A)];
    const fieldGroup = (src: GPUBuffer[]) => d.createBindGroup({ layout: this.fieldPipe.getBindGroupLayout(0), entries: [ent(0, this.params), ent(1, src[0]), ent(2, src[1]), ent(5, this.flags), ent(6, this.field)] });
    // the field is read from the lattice the last step wrote
    this.fieldGroups = [fieldGroup(this.A), fieldGroup(this.B)];
    this.reduceGroup = d.createBindGroup({ layout: this.reducePipe.getBindGroupLayout(0), entries: [ent(0, this.params), ent(1, this.recOut), ent(2, this.partF)] });
    this.clearGroup = d.createBindGroup({ layout: this.clearPipe.getBindGroupLayout(0), entries: [ent(0, this.params), ent(1, this.recOut)] });

    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(initPipe);
    // the flow to start from: a coarser run's, or the free stream
    const st = c.start;
    const startBuf = this.upload(st ? st.data : new Float32Array(4), GPUBufferUsage.STORAGE);
    const startPar = new ArrayBuffer(32);
    if (st) {
      new Uint32Array(startPar, 0, 4).set([...st.dims, 1]);
      new Float32Array(startPar, 16, 4).set([...st.offset, st.scale]);
    }
    const startUni = this.upload(new Uint8Array(startPar), GPUBufferUsage.UNIFORM);
    pass.setBindGroup(0, d.createBindGroup({ layout: initPipe.getBindGroupLayout(0), entries: [ent(0, this.params), ent(3, this.A[0]), ent(4, this.A[1]), ent(5, this.flags), ent(6, startBuf), ent(7, startUni)] }));
    this.dispatch(pass, this.NP);
    pass.end();
    d.queue.submit([enc.finish()]);
    void d.queue.onSubmittedWorkDone().then(() => {
      startBuf.destroy();
      startUni.destroy();
    });
    device.lost.then(() => {
      this.lost = true;
    });
  }

  /** A solver for one case, on a device of its own sized for it. */
  static async create(c: LbmCase, half = true, adapter?: GPUAdapter | null): Promise<GpuLbm> {
    const a = adapter ?? (await gpuAdapter());
    if (!a) throw new GpuError("WebGPU is not available");
    if (c.parts.length > MAX_PARTS) throw new GpuError(`at most ${MAX_PARTS} parts can be analysed at once`);
    const N = cellCount(c);
    const need = 10 * (half ? N / 2 : N) * 4;
    if (need > a.limits.maxStorageBufferBindingSize || need > a.limits.maxBufferSize) throw new GpuError(`the grid is too big for this GPU (${Math.round(need / 1e6)} MB per buffer)`);
    const device = await a.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.max(need, 134217728),
        maxBufferSize: Math.max(need, 268435456),
        maxStorageBuffersPerShaderStage: 8,
      },
    });
    const errors: string[] = [];
    device.onuncapturederror = (e) => errors.push(e.error.message);
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    const s = new GpuLbm(device, c, half);
    const oom = await device.popErrorScope();
    const val = await device.popErrorScope();
    if (oom || val) {
      s.dispose();
      throw new GpuError(oom ? "the GPU ran out of memory for this grid" : `the GPU solver could not start: ${val!.message}`);
    }
    return s;
  }

  private upload(data: ArrayBufferView, usage: number): GPUBuffer {
    const size = Math.max(16, Math.ceil(data.byteLength / 4) * 4);
    const b = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    b.unmap();
    return b;
  }

  private dispatch(pass: GPUComputePassEncoder, threads: number) {
    const groups = Math.ceil(threads / WORKGROUP);
    const x = Math.min(groups, 32768);
    pass.dispatchWorkgroups(x, Math.ceil(groups / x));
  }

  /** The uniform block: grid, relaxation, free stream, part motions and record runs. */
  private writeParams() {
    const c = this.c;
    const u32 = new Uint32Array(this.paramData);
    const f32 = new Float32Array(this.paramData);
    const [cx, cy, cz] = coarseDims(c);
    u32.set([c.nx, c.ny, c.nz, this.NP, this.mode, c.parts.length, c.rec.count, c.coarse]);
    f32.set([c.tau0, 18 * c.cs * c.cs, c.spongeX, c.spongeTau], 8);
    f32.set([this.uNow[0], this.uNow[1], this.uNow[2], (c.tau0 - 0.5) / 3], 12);
    u32.set([cx, cy, cz, 0], 16);
    let o = 20;
    for (const m of c.parts) {
      f32.set([...m.c, 0, ...m.w, 0, ...m.v, 0], o);
      o += 12;
    }
    const ps = 20 + 4 * (3 * MAX_PARTS + 3);
    for (let k = 0; k < c.rec.partStart.length; k++) u32[ps + k] = c.rec.partStart[k];
    this.device.queue.writeBuffer(this.params, 0, this.paramData);
  }


  /** Change the free stream held at the far field (a gust, a ramp). */
  setInflow(u: [number, number, number]) {
    this.uNow = [...u];
    this.writeParams();
  }

  /** Average (or stop averaging) the wall forces and the near-wall flow from the next step on. */
  setAveraging(on: boolean) {
    this.mode = on ? this.mode | MODE_AVERAGE : this.mode & ~MODE_AVERAGE;
    this.writeParams();
  }

  get averaging() {
    return (this.mode & MODE_AVERAGE) !== 0;
  }

  /** Run a number of steps, sampling the averaged field every fieldEvery steps while averaging (0: never). */
  async run(steps: number, fieldEvery = 0, budgetMs = 40): Promise<void> {
    let done = 0;
    let batch = this.msPerStep > 0 ? Math.max(1, Math.min(200, Math.floor(budgetMs / this.msPerStep))) : 4;
    while (done < steps) {
      if (this.lost) throw new GpuError("the GPU device was lost (a driver reset or the tab was hidden too long)");
      const n = Math.min(batch, steps - done);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      for (let k = 0; k < n; k++) {
        pass.setPipeline(this.stepPipe);
        pass.setBindGroup(0, this.stepGroups[this.parity]);
        this.dispatch(pass, this.NP);
        this.parity ^= 1;
        this.steps++;
        if (this.averaging) this.avgSteps++;
        if (fieldEvery > 0 && this.averaging && this.steps % fieldEvery === 0) {
          pass.setPipeline(this.fieldPipe);
          // after a step from A the latest lattice is B (parity now 1): field group 1 reads B
          pass.setBindGroup(0, this.fieldGroups[this.parity]);
          this.dispatch(pass, this.fieldCells);
          this.fieldSamples++;
        }
      }
      pass.end();
      const t0 = performance.now();
      this.device.queue.submit([enc.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      const ms = (performance.now() - t0) / n;
      this.msPerStep = this.msPerStep ? 0.7 * this.msPerStep + 0.3 * ms : ms;
      done += n;
      batch = Math.max(1, Math.min(200, Math.floor(budgetMs / Math.max(this.msPerStep, 1e-3))));
    }
  }

  private get fieldCells() {
    const [cx, cy, cz] = coarseDims(this.c);
    return cx * cy * cz;
  }

  /** Instantaneous force on each part from the last step, lattice units (3 per part). */
  async partForces(): Promise<Float64Array> {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.reducePipe);
    pass.setBindGroup(0, this.reduceGroup);
    if (this.c.parts.length) pass.dispatchWorkgroups(this.c.parts.length);
    pass.end();
    const raw = await this.read(this.partF, this.c.parts.length * 16, enc);
    const out = new Float64Array(this.c.parts.length * 3);
    for (let p = 0; p < this.c.parts.length; p++) for (let k = 0; k < 3; k++) out[3 * p + k] = raw[4 * p + k];
    return out;
  }

  /** The averaged wall data (REC_AVG floats per record) and field (FIELD_AVG per coarse cell) summed so far. */
  async averages(): Promise<{ rec: Float32Array; field: Float32Array; avgSteps: number; fieldSamples: number }> {
    const R = this.c.rec.count;
    const raw = R ? await this.read(this.recOut, R * REC_OUT * 4) : new Float32Array(0);
    const rec = new Float32Array(R * REC_AVG);
    for (let r = 0; r < R; r++) for (let k = 0; k < REC_AVG; k++) rec[r * REC_AVG + k] = k < 7 ? raw[r * REC_OUT + 4 + k] : 0;
    const field = await this.read(this.field, this.fieldCells * FIELD_AVG * 4);
    return { rec, field, avgSteps: this.avgSteps, fieldSamples: this.fieldSamples };
  }

  /** Start the averages again (after the flow has settled, or for another yaw). */
  resetAverages() {
    const enc = this.device.createCommandEncoder();
    if (this.c.rec.count) {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.clearPipe);
      pass.setBindGroup(0, this.clearGroup);
      this.dispatch(pass, this.c.rec.count);
      pass.end();
    }
    enc.clearBuffer(this.field);
    this.device.queue.submit([enc.finish()]);
    this.avgSteps = 0;
    this.fieldSamples = 0;
  }

  /** The instantaneous flow on the coarse grid (velocity, density change, |u|² per block), for eddies and a live view. */
  async snapshot(): Promise<Float32Array> {
    const avg = this.averaging;
    if (avg) this.setAveraging(false);
    const tmp = this.device.createBuffer({ size: this.field.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const enc = this.device.createCommandEncoder();
    // copy the sums aside, write the snapshot over the field, read it, and put the sums back
    enc.copyBufferToBuffer(this.field, 0, tmp, 0, this.field.size);
    const pass = enc.beginComputePass();
    pass.setPipeline(this.fieldPipe);
    pass.setBindGroup(0, this.fieldGroups[this.parity]);
    this.dispatch(pass, this.fieldCells);
    pass.end();
    const out = await this.read(this.field, this.fieldCells * FIELD_AVG * 4, enc);
    const enc2 = this.device.createCommandEncoder();
    enc2.copyBufferToBuffer(tmp, 0, this.field, 0, this.field.size);
    this.device.queue.submit([enc2.finish()]);
    tmp.destroy();
    if (avg) this.setAveraging(true);
    return out;
  }

  private sliceKit?: { pipe: GPUComputePipeline; out: GPUBuffer; uni: GPUBuffer; groups: GPUBindGroup[] };

  /** Speed as a share of the free stream on the plane y (nx × nz, x fastest; −1 in solids), for the live view. */
  async slice(y: number): Promise<Float32Array> {
    const { nx, nz } = this.c;
    const d = this.device;
    if (!this.sliceKit) {
      const pipe = d.createComputePipeline({ layout: "auto", compute: { module: d.createShaderModule({ code: sliceKernel(this.half) }), entryPoint: "main" } });
      const out = d.createBuffer({ size: Math.max(16, nx * nz * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const uni = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const ent = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer } });
      const groups = [this.A, this.B].map((src) =>
        d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [ent(0, this.params), ent(1, src[0]), ent(2, src[1]), ent(5, this.flags), ent(6, out), ent(7, uni)] }),
      );
      this.sliceKit = { pipe, out, uni, groups };
    }
    const k = this.sliceKit;
    d.queue.writeBuffer(k.uni, 0, new Uint32Array([Math.min(this.c.ny - 1, Math.max(0, Math.round(y))), 0, 0, 0]));
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(k.pipe);
    // the latest lattice: A after an even number of steps, B after an odd
    pass.setBindGroup(0, k.groups[this.parity]);
    this.dispatch(pass, nx * nz);
    pass.end();
    return this.read(k.out, nx * nz * 4, enc);
  }

  /** The latest populations as plain floats, Q per cell in SoA order (tests: compare with the CPU solver). */
  async populations(): Promise<Float32Array> {
    const src = this.parity ? this.B : this.A;
    const out = new Float32Array(19 * this.N);
    for (const [k, buf] of src.entries()) {
      const dirs = k ? 9 : 10;
      const raw = await this.read(buf, dirs * this.NP * 4);
      for (let i = 0; i < dirs; i++) {
        const dir = k * 10 + i;
        if (!this.half) out.set(raw.subarray(i * this.N, (i + 1) * this.N), dir * this.N);
        else {
          const w = new Uint32Array(raw.buffer, raw.byteOffset + i * this.NP * 4, this.NP);
          for (let p = 0; p < this.NP; p++) {
            out[dir * this.N + 2 * p] = fromHalf(w[p] & 0xffff);
            out[dir * this.N + 2 * p + 1] = fromHalf(w[p] >>> 16);
          }
        }
      }
    }
    return out;
  }

  private async read(buf: GPUBuffer, bytes: number, enc = this.device.createCommandEncoder()): Promise<Float32Array> {
    const size = Math.max(16, Math.ceil(bytes / 4) * 4);
    const st = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyBufferToBuffer(buf, 0, st, 0, size);
    this.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(st.getMappedRange().slice(0, bytes));
    st.unmap();
    st.destroy();
    return out;
  }

  dispose() {
    for (const b of [...this.A, ...this.B, this.flags, this.recs, this.recOut, this.far, this.partF, this.field, this.params]) b.destroy();
    this.sliceKit?.out.destroy();
    this.sliceKit?.uni.destroy();
    this.device.destroy();
  }
}

/** Boundary records as the kernel reads them: REC_WORDS u32 per record, halves packed in pairs. */
export function packRecords(c: LbmCase): Uint32Array {
  const R = c.rec.count;
  const out = new Uint32Array(Math.max(1, R) * REC_WORDS);
  const pk = (a: number, b: number) => (toHalf(a) | (toHalf(b) << 16)) >>> 0;
  for (let r = 0; r < R; r++) {
    const o = r * REC_WORDS;
    for (let k = 0; k < 9; k++) out[o + k] = pk(c.rec.q[r * 18 + 2 * k], c.rec.q[r * 18 + 2 * k + 1]);
    out[o + 9] = pk(c.rec.nrm[3 * r], c.rec.nrm[3 * r + 1]);
    out[o + 10] = pk(c.rec.nrm[3 * r + 2], c.rec.dist[r]);
    out[o + 11] = ((c.rec.part[r] & 0xffff) | (toHalf(c.rec.phi[r]) << 16)) >>> 0;
  }
  return out;
}

function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
