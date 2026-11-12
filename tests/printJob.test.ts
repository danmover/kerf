// The design's print job: its printed parts found and grouped into copies, turned to print, and packed onto plates
// for the printer from Settings → Making (one material a plate on one nozzle, two on the two-nozzle X2D).

import { describe, expect, it, vi } from "vitest";
import type { MeshData } from "../src/kernel/build";

// the engine's mesh cache, filled here with real meshes
const h = vi.hoisted(() => ({ meshes: new Map<string, { preview?: MeshData; final?: MeshData }>() }));
vi.mock("../src/core/engine", () => ({ meshes: h.meshes }));

import { evaluate } from "../src/lang/evaluator";
import { buildPart, meshShape } from "../src/kernel/build";
import { copyId, platePrinter, printJob, printedParts } from "../src/app/printPlates";
import { NO_MACHINES } from "../src/mfg/machines";
import type { Model } from "../src/core/model";
import { initKernel } from "./helpers/kernel";

const SRC = `
design "Plates"
part foot_1 { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (-100, 0, 0), r: 3) }
part foot_2 { material: "PETG"  process: mfg.fdm()  body box(40, 30, 10, at: (100, 0, 0), r: 3) }
part foot_3 { material: "PETG"  process: mfg.fdm()  rotate: (0, 0, 30)  body rotate(shape_of(foot_1), 30) }
part bumper { material: "TPU"  body box(30, 30, 8, at: (0, 60, 0)) }
part hook { material: "PETG"  process: mfg.fdm(build: Y)  body box(10, 10, 30, at: (0, -80, 0))  add box(40, 10, 5, at: (15, -80, 30))  add box(10, 4, 8, at: (30, -77, 35)) }
part stand { material: "Aluminum 6061"  process: mfg.cnc_mill()  body box(20, 20, 20, at: (0, 120, 0)) }
part lens { material: "Resin"  process: mfg.sla()  body box(10, 10, 4, at: (60, 120, 0)) }
`;

async function built(src = SRC): Promise<Model> {
  await initKernel();
  const m = evaluate(src);
  expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  for (const p of m.parts) if (p.kind === "part" && !h.meshes.has(p.hash)) h.meshes.set(p.hash, { preview: meshShape(buildPart(p.recipe), "preview") });
  return m;
}

describe("print job", () => {
  it("prints copies from one mesh and leaves parts made another way off the plates", async () => {
    const m = await built();
    const { fdm, other } = printedParts(m);
    expect(fdm.map((p) => p.name).sort()).toEqual(["bumper", "foot_1", "foot_2", "foot_3", "hook"]);
    expect(other.map((p) => p.name)).toEqual(["lens"]);
    const job = printJob(m, platePrinter(NO_MACHINES, m));
    // the three feet (two typed out, one turned) are one part printed three times
    expect(job.plan.parts.map((p) => [p.name, p.qty, p.material])).toEqual([
      ["Foot", 3, "PETG"],
      ["bumper", 1, "TPU"],
      ["hook", 1, "PETG"],
    ]);
    expect(job.waiting).toEqual([]);
    expect(job.allMade).toBe(false);
    // the hook's arm sticks out: it needs supports; the feet lie flat and need none
    const hook = job.plan.parts.findIndex((p) => p.name === "hook");
    expect(job.plan.estimates[hook].supportGrams).toBeGreaterThan(0);
    expect(job.plan.estimates[0].supportGrams).toBe(0);
    // one nozzle on a typical printer: PETG and TPU on plates of their own
    expect(job.plan.printer.nozzles).toBe(1);
    expect(job.plan.plates.map((p) => p.materials)).toEqual([["PETG"], ["TPU"]]);
    // every copy maps back to its part in the design
    expect(job.plan.copies.map((_, i) => copyId(job, i)).sort()).toEqual(["bumper", "foot_1", "foot_2", "foot_3", "hook"]);
  }, 60_000);

  it("puts two materials on one plate on the two-nozzle X2D, on its 256 mm bed", async () => {
    const m = await built();
    const printer = platePrinter({ machines: [], machineFor: { fdm: "bambu-x2d" } }, m);
    expect(printer).toMatchObject({ name: "Bambu Lab X2D", bed: [256, 256], nozzles: 2, from: "machine" });
    const job = printJob(m, printer);
    expect(job.plan.plates.length).toBe(1);
    expect(job.plan.plates[0].materials.sort()).toEqual(["PETG", "TPU"]);
    // asked for one material a plate, it splits them again
    expect(printJob(m, printer, { nozzles: 1 }).plan.plates.length).toBe(2);
  }, 60_000);

  it("prints a mirrored copy of a part that is not symmetric from the mirror image", async () => {
    const m = await built();
    const hook = m.parts.find((p) => p.name === "hook")!;
    m.parts.push({ ...hook, id: "hook_left", name: "hook_left", label: "hook_left", xf: [...hook.xf, { op: "mirror", origin: [0, 0, 0], normal: [1, 0, 0] }] });
    const job = printJob(m, platePrinter(NO_MACHINES, m));
    const hooks = job.plan.parts.filter((p) => p.name.startsWith("hook"));
    expect(hooks.length).toBe(2);
    expect(hooks[0].mesh).not.toBe(hooks[1].mesh);
    // the mirror image: x turned round
    const xs = (mesh: MeshData) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < mesh.positions.length; i += 3) (lo = Math.min(lo, mesh.positions[i])), (hi = Math.max(hi, mesh.positions[i]));
      return [lo, hi];
    };
    const [a0, a1] = xs(hooks[0].mesh);
    const [b0, b1] = xs(hooks[1].mesh);
    expect(b0).toBeCloseTo(-a1, 3);
    expect(b1).toBeCloseTo(-a0, 3);
  }, 60_000);

  it("plans every made part in its own material when none names a printing process or filament", async () => {
    const m = await built(`
design "Metal"
part plate { material: "Aluminum 6061"  body box(60, 40, 5) }
`);
    const job = printJob(m, platePrinter(NO_MACHINES, m));
    expect(job.allMade).toBe(true);
    expect(job.plan.copies.length).toBe(1);
  }, 60_000);
});
