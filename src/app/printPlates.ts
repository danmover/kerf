// The design's print job, for the Make panel's Print plates view and the 3MF plate export: its printed parts (made
// in filament on an FDM printer, not bought), one of each with how many the design uses, each turned the way it
// prints, estimated with its slicer settings and packed onto as many plates as the printer takes. The printer is
// the FDM machine from Settings → Making, else the bed the brief asks for, else a typical one.

import { meshes } from "../core/engine";
import { briefData } from "../core/brief";
import { buildDirection, isPrinted } from "../machine/pack";
import { copiesOf, sharedName } from "../drawing/copies";
import { DEFAULT_COLORS } from "../lang/evaluator";
import { findMachine, withMachine, type MachineContext, type MachineProfile } from "../mfg/machines";
import { fdmPrint } from "../mfg/infill";
import { PROCESSES } from "../mfg/profiles";
import { nozzlesOf, planPrint, type PrintPart, type PrintPlan, type Printer } from "../mfg/printPlan";
import type { MeshData } from "../kernel/build";
import type { EvalPart, Model } from "../core/model";
import type { ProcessSpec } from "../mfg/types";

export interface PlatePrinter extends Printer {
  /** the machine profile, when one is chosen */
  machine?: MachineProfile;
  /** where the bed comes from */
  from: "machine" | "brief" | "typical";
}

function typicalBed(): [number, number] {
  const d = PROCESSES.fdm.settings.find((s) => s.key === "bed")?.def;
  return Array.isArray(d) && typeof d[0] === "number" && typeof d[1] === "number" ? [d[0], d[1]] : [250, 210];
}

/** The printer the plates are packed for: `pick` (a machine id), else the FDM machine from Settings → Making, else the brief's bed, else a typical one. */
export function platePrinter(ctx: MachineContext, model: Model | null, pick?: string): PlatePrinter {
  const id = pick || ctx.machineFor.fdm;
  const m = id ? findMachine(id, ctx, "fdm") : undefined;
  if (m) {
    const bed = Array.isArray(m.settings.bed) && typeof m.settings.bed[0] === "number" ? (m.settings.bed as number[]) : typicalBed();
    return { name: m.name, bed: [bed[0], bed[1]], nozzles: nozzlesOf(m), machine: m, from: "machine" };
  }
  const b = briefData(model?.brief)?.buildVolume;
  if (b) return { name: `the brief's ${b[0]} × ${b[1]} mm bed`, bed: [b[0], b[1]], nozzles: 1, from: "brief" };
  const t = typicalBed();
  return { name: `a typical ${t[0]} × ${t[1]} mm printer`, bed: t, nozzles: 1, from: "typical" };
}

/** Parts you make (not bought, imported or held in stock), without the extra solids of a multi-body block. */
const madePart = (p: EvalPart) => p.kind === "part" && !p.imported && !p.processNone && !p.hidden && !p.id.startsWith(`${p.name}.`);

/** The made parts that print on an FDM printer (process fdm, or none with a filament material), and those printed another way (resin, powder). */
export function printedParts(model: Model | null, only?: (p: EvalPart) => boolean): { fdm: EvalPart[]; other: EvalPart[]; made: EvalPart[] } {
  const fdm: EvalPart[] = [];
  const other: EvalPart[] = [];
  const made: EvalPart[] = [];
  for (const p of model?.parts ?? []) {
    if (!madePart(p) || (only && !only(p))) continue;
    made.push(p);
    if (!isPrinted(p)) continue;
    if (!p.process || p.process.id === "fdm") fdm.push(p);
    else other.push(p);
  }
  return { fdm, other, made };
}

/** A placement that mirrors the part (an odd number of mirrors) prints the mirror image of its mesh. */
const mirrored = (p: EvalPart) => p.xf.filter((x) => x.op === "mirror").length % 2 === 1;

const mirrorCache = new WeakMap<MeshData, MeshData>();
function mirrorOf(m: MeshData): MeshData {
  const hit = mirrorCache.get(m);
  if (hit) return hit;
  const P = new Float32Array(m.positions);
  for (let i = 0; i < P.length; i += 3) P[i] = -P[i];
  const I = new Uint32Array(m.indices);
  // the mirror turns every face inside out: swap two corners to keep them facing out
  for (let t = 0; t < I.length; t += 3) [I[t + 1], I[t + 2]] = [I[t + 2], I[t + 1]];
  const out: MeshData = { positions: P, indices: I, normals: new Float32Array(0), edges: new Float32Array(0) };
  mirrorCache.set(m, out);
  return out;
}

export interface PrintJob {
  plan: PrintPlan;
  /** each plan part's copies as the design's part ids, by part then copy */
  ids: string[][];
  /** the design's parts behind each plan part (the first of its copies) */
  source: EvalPart[];
  /** printed parts whose geometry is not built yet (left off the plates) */
  waiting: string[];
  /** printed another way (resin, powder): not on these plates */
  other: EvalPart[];
  /** no part names a printing process or a filament, so every made part is on the plates in its own material */
  allMade: boolean;
}

/** The print plan of the design's printed parts (or those `only` keeps) for this printer. */
export function printJob(model: Model | null, printer: PlatePrinter, opts: { only?: (p: EvalPart) => boolean; nozzles?: number } = {}): PrintJob {
  const { fdm, other, made } = printedParts(model, opts.only);
  const allMade = !fdm.length && !other.length && made.length > 0;
  const meshOf = (p: EvalPart) => {
    const e = meshes.get(p.hash);
    const m = e?.final ?? e?.preview;
    return m && m.indices.length ? m : undefined;
  };
  const waiting: string[] = [];
  const list = (allMade ? made : fdm).filter((p) => meshOf(p) || (waiting.push(p.label), false));
  // copies (a pattern, the same part placed twice, the same solid moved and turned, as the drawings and the build
  // pack find them) print from one mesh several times, when they are also the same colour and print settings; each
  // part is its own entry here, so a mirrored copy of a part that is not symmetric stays apart
  const copyOf = copiesOf(
    list.map((p) => ({ ...p, name: p.id })),
    (p) => meshOf(p),
  );
  const groups = new Map<string, EvalPart[]>();
  for (const p of list) {
    // a colour the part chose keeps it apart; the colours parts take in turn when they give none do not
    const look = DEFAULT_COLORS.includes(p.color.toLowerCase()) ? "" : p.color.toLowerCase();
    const key = `${copyOf.get(p.id) ?? p.id}|${look}|${JSON.stringify(p.process ?? null)}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const parts: PrintPart[] = [];
  const ids: string[][] = [];
  const source: EvalPart[] = [];
  for (const g of groups.values()) {
    const p = g[0];
    const base = meshOf(p)!;
    const labels = [...new Set(g.map((x) => x.label))];
    // the printer's settings under the part's own (its overhang limit, bridges and nozzle)
    const spec: ProcessSpec = withMachine(p.process?.id === "fdm" ? p.process : { id: "fdm", settings: {} }, printer.machine);
    const num = (k: string) => (typeof spec.settings[k] === "number" ? (spec.settings[k] as number) : undefined);
    parts.push({
      name: labels.length > 1 ? (sharedName(labels) ?? p.label) : p.label.replace(/ #\d+$/, "") || p.name,
      names: g.map((x) => x.label),
      material: p.material,
      color: p.color,
      qty: g.length,
      mesh: mirrored(p) ? mirrorOf(base) : base,
      build: buildDirection(p),
      maxAngle: num("overhang"),
      bridge: num("bridge"),
      print: fdmPrint(spec),
      supports: spec.settings.supports !== false,
    });
    ids.push(g.map((x) => x.id));
    source.push(p);
  }
  const plan = planPrint(parts, { name: printer.name, bed: printer.bed, nozzles: Math.max(1, opts.nozzles ?? printer.nozzles) });
  return { plan, ids, source, waiting, other, allMade };
}

/** The id in the design of a plan copy. */
export const copyId = (job: PrintJob, item: number): string | undefined => {
  const c = job.plan.copies[item];
  return c ? job.ids[c.part]?.[c.copy] : undefined;
};
