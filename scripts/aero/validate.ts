// Checks the airflow solver against a sphere's measured drag, on the CPU
// threads of this machine:
//
//   npx tsx scripts/aero/validate.ts [Re=10000] [cells=1.5e6] [quality=standard]
//
// The reference is the Clift, Grace and Weber correlation of the measured
// data (within a few per cent up to Re 2·10⁵). It prints the solver's drag
// coefficient beside it, with the grid, run time and convergence.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runAirflow } from "../../src/analysis/aero/solve";
import { sphereMesh } from "../../src/analysis/aero/geometry";
import type { AeroQuality } from "../../src/analysis/aero/types";
import { ThreadedCpuSolver } from "./threads";

/** Sphere drag coefficient from Clift, Grace and Weber (1978), by Reynolds number range. */
export function sphereCd(re: number): number {
  const w = Math.log10(re);
  if (re <= 20) return (24 / re) * (1 + 0.1315 * re ** (0.82 - 0.05 * w));
  if (re <= 260) return (24 / re) * (1 + 0.1935 * re ** 0.6305);
  if (re <= 1500) return 10 ** (1.6435 - 1.1242 * w + 0.1558 * w * w);
  if (re <= 1.2e4) return 10 ** (-2.4571 + 2.5558 * w - 0.9295 * w * w + 0.1049 * w ** 3);
  if (re <= 4.4e4) return 10 ** (-1.9181 + 0.637 * w - 0.0636 * w * w);
  if (re <= 3.38e5) return 10 ** (-4.339 + 1.5809 * w - 0.1546 * w * w);
  throw new Error("past the drag crisis the correlation does not hold");
}

const re = Number(process.argv[2] ?? 1e4);
const cells = Number(process.argv[3] ?? 1.5e6);
const quality = (process.argv[4] ?? "standard") as AeroQuality;

const dir = mkdtempSync(join(tmpdir(), "kerf-aero-"));
const workerFile = join(dir, "worker.mjs");
await build({ entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", outfile: workerFile, logLevel: "warning" });

const D = 100;
const U = 10;
const m = sphereMesh([0, 0, 0], D / 2, 64);
let last = 0;
const r = await runAirflow(
  {
    label: "sphere",
    bodies: [{ id: "sphere", name: "Sphere", positions: Float32Array.from(m.positions), indices: m.indices }],
    speed: U,
    density: 1.2,
    nu: (U * D * 1e-3) / re,
    facing: [1, 0, 0],
    up: [0, 0, 1],
    yaws: [0],
    ground: false,
    quality,
    cells,
    backend: "cpu",
    maxMinutes: 240,
  },
  {
    solver: async (c) => new ThreadedCpuSolver(c, workerFile),
    solverBackend: "cpu",
    onProgress: (p) => {
      const t = Date.now();
      if (t - last < 10000) return;
      last = t;
      console.log(`${p.stage} ${Math.round(100 * p.frac)} %${p.drag !== undefined ? `, drag ${p.drag.toFixed(4)} N` : ""}`);
    },
  },
);
const y = r.yaws[0];
const cd = y.drag / (0.5 * 1.2 * U * U * Math.PI * (D / 2000) ** 2);
const ref = sphereCd(re);
console.log(
  JSON.stringify(
    { re, cd: +cd.toFixed(4), measured: +ref.toFixed(4), error: `${(100 * (cd / ref - 1)).toFixed(1)} %`, cellsAcross: +(D / r.h).toFixed(1), dims: r.dims, cells: r.cells, steps: y.steps, seconds: Math.round(y.seconds), converged: y.converged, stderr: `${((100 * y.stderr) / y.drag).toFixed(2)} %`, yPlus: +y.yPlus.toFixed(1), friction: +y.parts[0].friction.toFixed(3) },
    null,
    1,
  ),
);
