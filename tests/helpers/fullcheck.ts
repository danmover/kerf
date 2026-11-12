// Evaluates a design, builds every part with OpenCASCADE in Node and runs the
// same checks the app runs (requirements, interference, tool access, brief,
// machine, and each part's manufacturing process).

import { evaluate } from "../../src/lang/evaluator";
import { KernelCore } from "../../src/kernel/core";
import { assembleReport, buildChecksRequest, type CheckReport } from "../../src/core/checks";
import { composeReport } from "../../src/core/reportPasses";
import { processProbes } from "../../src/mfg/report";
import type { ProcessResult } from "../../src/mfg/types";
import type { Model } from "../../src/core/model";
import { initKernel } from "./kernel";
import type { FaceLookup } from "../../src/lang/mates";
import { splitTable } from "../../src/core/splitGeom";
import { buildHarness } from "../../src/machine/harness/harness";
import { mountParts, mountSpecs, screwSpecs, solidsInput } from "../../src/machine/harness/inputs";
import { runWiring } from "../../src/machine/harness/wiringRun";
import { wiringItems } from "../../src/machine/harness/checks";
import { pivotJoints } from "../../src/machine/harness/pivots";
import { flowZones } from "../../src/machine/harness/flow";

export interface FullCheck {
  model: Model;
  report: CheckReport;
  buildErrors: Map<string, string>;
  core: KernelCore;
  /** the kernel's checks result (contacts, clearances, boxes) */
  kernel: ReturnType<KernelCore["checks"]>;
  /** the cable routes and wiring findings, when the wiring checks ran */
  wiring?: ReturnType<typeof runWiring>;
  ms: number;
}

export interface FullCheckOptions {
  /** also run the mount and wiring checks, which the app runs after the others (machines only) */
  wiring?: boolean;
}

export async function fullCheck(src: string, opts: FullCheckOptions = {}): Promise<FullCheck> {
  const t0 = Date.now();
  await initKernel();
  let model = evaluate(src);
  const core = new KernelCore();
  const buildErrors = new Map<string, string>();
  const built = new Set<string>();
  const buildAll = () => {
    for (const p of model.parts) {
      if (built.has(p.hash) || buildErrors.has(p.hash)) continue;
      try {
        core.build({ hash: p.hash, recipe: p.recipe, label: p.label });
        built.add(p.hash);
      } catch (e) {
        buildErrors.set(p.hash, e instanceof Error ? e.message : String(e));
      }
    }
  };
  buildAll();
  // split parts: as the app does, each is built whole, its cuts worked out from that mesh, then the design is read
  // again with the pieces in its place
  const splits = model.splitQueries?.length ? splitTable() : undefined;
  for (let pass = 0; splits && pass < 3; pass++) {
    if (!splits.resolve(model, (h) => (built.has(h) ? core.mesh(h, "preview") : undefined))) break;
    model = evaluate(src, { splits: splits.lookup });
    buildAll();
  }
  // mates pick from the built solids' faces: as the app does, the design is read again once they are listed
  let faces: FaceLookup | undefined;
  if (model.mateQueries?.length) {
    const cats = core.faces(model.mateQueries.filter((h) => built.has(h)));
    faces = (h) => {
      const c = cats[h];
      return c && !("error" in c) ? c : undefined;
    };
    model = evaluate(src, { faces, ...(splits ? { splits: splits.lookup } : {}) });
  }
  const result = core.checks(buildChecksRequest(model, built));
  const geoModel = model.geoQueries.length ? evaluate(src, { geo: result.geo, faces, ...(splits ? { splits: splits.lookup } : {}) }) : null;
  const geom = (h: string) => {
    const e = core.get(h);
    return e ? { volume: e.volume, bbox: e.bbox } : undefined;
  };
  const mesh = (h: string) => (core.get(h) ? core.mesh(h, "preview") : undefined);
  const base = assembleReport(model, { geoModel, kernel: result, buildErrors, geom, mesh });
  const probes = processProbes(model, built);
  const results = core.process(probes);
  const process: Record<string, ProcessResult> = {};
  probes.forEach((p, i) => (process[p.id] = results[i]));
  let report = composeReport(base, { model, live: false, rev: 0, buildErrors, process });
  let wiring: ReturnType<typeof runWiring> | undefined;
  if (opts.wiring && model.machine) {
    const harness = buildHarness(model);
    const mounts = mountParts(model);
    const wmesh = (h: string) => {
      const e = core.get(h);
      const m = e ? core.mesh(h, "preview") : undefined;
      return e && m ? { positions: m.positions, indices: m.indices, bbox: e.bbox } : undefined;
    };
    const { geos, placed } = solidsInput({ ...model, parts: model.parts.filter((p) => !p.hidden) }, wmesh, mounts);
    // as the app routes them: cables keep out of fans' airflow and cross pivots beside their bearings
    const run = runWiring({ geos, placed, wires: [] }, { harness, mounts: mountSpecs(model, (h) => core.get(h)?.bbox, mounts), screws: screwSpecs(model), pivots: pivotJoints(model), flow: flowZones(model) });
    const items = [...report.items, ...wiringItems(harness, run.findings ?? null, run.mounts, model)];
    const counts = { pass: 0, fail: 0, warn: 0, pending: 0, info: 0 };
    for (const i of items) counts[i.status]++;
    report = { ...report, items, counts };
    wiring = run;
  }
  // the model with geometry measurements filled in, when the design asks for any
  return { model: geoModel ?? model, report, buildErrors, core, kernel: result, wiring, ms: Date.now() - t0 };
}

/** One line per item that is not a pass, for test output. */
export function problems(r: CheckReport, include: ("fail" | "warn" | "info")[] = ["fail", "warn"]): string[] {
  return r.items.filter((i) => (include as string[]).includes(i.status)).map((i) => `${i.status} [${i.category}] ${i.title}: ${i.detail}`);
}
