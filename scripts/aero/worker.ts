// One thread of the threaded CPU solver (threads.ts): steps its slab of z planes and samples its block planes.

import { parentPort, workerData } from "node:worker_threads";
import { CpuLbm } from "../../src/analysis/aero/cpu";

const { c, shared, ctrl, z, Z, threads } = workerData as {
  c: ConstructorParameters<typeof CpuLbm>[0];
  shared: NonNullable<ConstructorParameters<typeof CpuLbm>[1]>;
  ctrl: Int32Array;
  z: [number, number];
  Z: [number, number];
  threads: number;
};
const lbm = new CpuLbm(c, shared);
let steps = 0;

function barrier() {
  const gen = Atomics.load(ctrl, 1);
  if (Atomics.add(ctrl, 0, 1) === threads - 1) {
    Atomics.store(ctrl, 0, 0);
    Atomics.add(ctrl, 1, 1);
    Atomics.notify(ctrl, 1);
  } else while (Atomics.load(ctrl, 1) === gen) Atomics.wait(ctrl, 1, gen);
}

parentPort!.on("message", (m: { cmd: string; steps: number; fieldEvery: number; avg: boolean; base: number }) => {
  if (m.cmd === "run") {
    steps = m.base;
    for (let s = 0; s < m.steps; s++) {
      lbm.step(m.avg, z[0], z[1]);
      steps++;
      barrier();
      if (m.fieldEvery > 0 && m.avg && steps % m.fieldEvery === 0) {
        lbm.sampleField(Z[0], Z[1]);
        barrier();
      }
    }
  }
  parentPort!.postMessage("done");
});
