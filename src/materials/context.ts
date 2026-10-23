// Gathers what the material advisor needs from the live design: the brief,
// the part's geometry, process and loads, and its latest strength analysis.

import { meshes, useDesign } from "../core/engine";
import { partMass, type EvalPart, type Model } from "../core/model";
import { useAnalysis } from "../analysis/runtime";
import { mechMaterial } from "../analysis/materials";
import { materialDensity } from "../library/standards";
import type { StructuralSpec } from "../analysis/spec";
import { briefFacts } from "./brief";
import { materialRecord } from "../library/materialDb";
import { adviseMaterials, stockCost, type Advice, type AnalysisFacts, type Need, type PartFacts } from "./advise";

export { briefFacts };

/** The latest structural result for a part, as numbers the advisor can scale to another material. */
export function analysisFacts(model: Model, name: string): AnalysisFacts | undefined {
  const st = useAnalysis.getState();
  const specs = model.analyses.filter((a): a is StructuralSpec => a.kind === "structural" && a.parts.includes(name));
  const order = [...specs].sort((a, b) => (b.label === st.shown ? 1 : 0) - (a.label === st.shown ? 1 : 0));
  for (const spec of order) {
    const r = st.runs.get(spec.label)?.result;
    if (!r || r.label !== spec.label) continue;
    const fields = r.parts.filter((p) => p.name === name);
    if (!fields.length) continue;
    const exact = spec.parts.every((p) => p === name) && !spec.material;
    let stress = 0;
    let disp = 0;
    for (const f of fields) {
      for (let i = 0; i < f.stress.length; i++) if (f.stress[i] > stress) stress = f.stress[i];
      for (let i = 0; i < f.disp.length; i += 3) disp = Math.max(disp, Math.hypot(f.disp[i], f.disp[i + 1], f.disp[i + 2]));
    }
    if (exact) {
      // the solver's own peaks, which the strength check reads
      stress = r.maxStress.value;
      disp = r.maxDisp.value;
    }
    const part = model.parts.find((p) => p.name === name)!;
    const material = spec.material ?? part.material;
    return {
      label: spec.label,
      target: spec.safety,
      cycles: spec.cycles,
      printed: spec.printed ?? mechMaterial(material).printedByDefault,
      material,
      stress,
      layerStress: exact ? (r.layer?.value ?? null) : null,
      disp,
      maxDeflection: spec.maxDeflection,
      gravity: !!spec.accel,
      exact,
    };
  }
  return undefined;
}

const massOf = (p: EvalPart) => partMass(p, meshes.get(p.hash)?.volume ?? 0, materialDensity(p.material)) ?? 0;

/** What the advisor knows about one part block (all its instances). */
export function partFacts(model: Model, name: string): PartFacts | null {
  const parts = model.parts.filter((p) => p.name === name && !p.id.startsWith(`${name}.`));
  if (!parts.length) return null;
  const p = parts[0];
  const entry = meshes.get(p.hash);
  const volumes = parts.map((q) => meshes.get(q.hash)?.volume);
  const b = model.brief;
  return {
    name,
    label: p.label.replace(/ #\d+$/, "") || name,
    count: parts.length,
    material: p.material,
    finish: p.finish,
    color: p.color,
    process: p.process?.id,
    processOwn: !!p.process && !p.processInherited,
    bought: p.kind === "component" || !!p.imported,
    volume: volumes.every((v) => v !== undefined) ? volumes.reduce<number>((s, v) => s + (v ?? 0), 0) : undefined,
    bbox: entry?.bbox,
    loads: (b?.uses ?? []).filter((u) => u.on === name && u.load !== undefined).map((u) => ({ text: u.text, load: u.load!, cycles: u.cycles })),
    designLoads: (b?.uses ?? []).some((u) => u.load !== undefined && !u.on),
    otherMass: b?.maxMass ? model.parts.filter((q) => q.name !== name && !q.hidden).reduce((s, q) => s + massOf(q), 0) : undefined,
    analysis: analysisFacts(model, name),
  };
}

/** The raw material for every copy of a made part, priced from the material database; null for bought parts and unknown materials. */
export function partMaterialCost(model: Model, name: string) {
  const part = partFacts(model, name);
  const m = part ? materialRecord(part.material) : undefined;
  const c = part && m ? stockCost(m, part, briefFacts(model.brief)) : null;
  return c && part ? { ...c, count: part.count, material: m!.name } : null;
}

/** Rank materials for a part block of the current design, or for the design as a whole. */
export function adviseFor(partName: string | null, opts: { needs?: Need[]; candidates?: string[]; keepProcess?: boolean; model?: Model | null } = {}): Advice | null {
  const model = opts.model ?? useDesign.getState().model;
  if (!model) return null;
  const part = partName ? partFacts(model, partName) : null;
  if (partName && !part) return null;
  return adviseMaterials({ brief: briefFacts(model.brief), part: part ?? undefined, needs: opts.needs, candidates: opts.candidates, keepProcess: opts.keepProcess });
}
