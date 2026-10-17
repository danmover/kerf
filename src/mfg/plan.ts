// Gathers what the manufacturing advisor needs from the live design: the
// part as the material advisor sees it, its measured geometry, its fit to
// every process (one shared kernel analysis), the brief, and which processes
// the user can use. The make panel and Claude's plan_manufacturing tool both
// plan through here, so they show the same numbers.

import { meshes, useDesign, whenChecked } from "../core/engine";
import type { Brief, Model } from "../core/model";
import { useSettings } from "../app/settings";
import { briefFacts, partFacts } from "../materials/context";
import { blockPart } from "../materials/apply";
import type { Need } from "../materials/advise";
import { compareProcesses } from "./compare";
import { availability, type Availability } from "./availability";
import { meshFacts } from "./geometry";
import { defaultTiers, planManufacturing, type ManufacturingPlan, type Tier } from "./advisor";
import type { CostGeometry } from "./cost";
import { PROCESS_IDS } from "./profiles";
import type { ProcessId, ProcessResult } from "./types";
import type { V3 } from "../kernel/recipe";

/** The processes this project can use: the brief's lists, else Settings. */
export function projectAccess(brief: Pick<Brief, "workshop" | "canOrder"> | null | undefined): { access: Availability; fromBrief: boolean } {
  return availability(brief ?? null, useSettings.getState().processAccess);
}

/** One instance of a part block, measured: volume and box from the build, area and silhouettes from its mesh. */
export function partGeometry(model: Model, block: string): CostGeometry | null {
  const part = blockPart(model, block);
  if (!part) return null;
  const entry = meshes.get(part.hash);
  if (!entry) return null;
  const mesh = entry.final ?? entry.preview;
  const facts = mesh ? meshFacts(mesh.positions, mesh.indices) : null;
  const d = [0, 1, 2].map((k) => entry.bbox[1][k] - entry.bbox[0][k]);
  const s = part.process?.settings;
  const axis = (s?.pull ?? s?.build ?? s?.axis) as V3 | undefined;
  return {
    volume: entry.volume,
    // a box's area is a fair stand-in until the mesh arrives
    area: facts?.area ?? 2 * (d[0] * d[1] + d[1] * d[2] + d[0] * d[2]),
    projected: facts?.projected,
    bbox: entry.bbox,
    axis: Array.isArray(axis) && typeof axis[0] === "number" ? axis : undefined,
  };
}

export interface PlanOptions {
  tiers?: Tier[];
  only?: ProcessId[];
  needs?: Need[];
  /** called once the plan without geometry checks is ready, before the slower checks finish */
  onDraft?: (plan: ManufacturingPlan) => void;
}

/** Why a plan could not be made, in plain words. */
export class PlanError extends Error {}

/** A plan, and the process checks behind it (to draw a route's issues on the model). */
export interface PlannedPart {
  plan: ManufacturingPlan;
  fits: Partial<Record<ProcessId, ProcessResult>>;
}

/** Process checks by part shape, material and process: a design change elsewhere does not re-check this part. */
const fitCache = new Map<string, Partial<Record<ProcessId, ProcessResult>>>();
const FIT_CACHE = 48;

/**
 * Plan how to make a part block of the current design: waits for the design
 * to build, checks the part against every process the plan considers, and
 * ranks the routes at each tier.
 */
export async function planPart(block: string, opts: PlanOptions = {}): Promise<PlannedPart> {
  const s = await whenChecked();
  const model = s.model;
  if (!model) throw new PlanError("There is no design yet.");
  const part = blockPart(model, block);
  if (!part) throw new PlanError(`No part named "${block}".`);
  if (part.kind !== "part" || part.imported) throw new PlanError(`${part.label} is bought, not made, so it has no manufacturing plan.`);
  if (s.buildErrors.has(part.hash)) throw new PlanError(`${part.label} does not build, so it cannot be planned: ${s.buildErrors.get(part.hash)}`);
  const facts = partFacts(model, block);
  const geometry = partGeometry(model, block);
  if (!facts || !geometry) throw new PlanError(`${part.label} has not been built yet.`);
  const brief = briefFacts(model.brief);
  const { access } = projectAccess(model.brief);
  const ids = opts.only?.length ? opts.only : PROCESS_IDS;
  const req = {
    part: facts,
    geometry,
    brief,
    needs: opts.needs,
    access,
    tiers: opts.tiers ?? defaultTiers(model.brief?.quantity),
    labour: useSettings.getState().labourRate,
    only: opts.only,
  };
  // the part's own process result is already in the report
  const key = `${part.hash}|${part.material}|${JSON.stringify(part.process ?? null)}|${ids.join(",")}`;
  const cached = fitCache.get(key);
  if (cached) return { plan: planManufacturing({ ...req, fits: cached }), fits: cached };
  const fits: Partial<Record<ProcessId, ProcessResult>> = {};
  const live = s.process[part.id];
  if (live && part.process && !live.error) fits[part.process.id] = live;
  opts.onDraft?.(planManufacturing({ ...req, fits }));
  if (s.kernelStatus !== "error") {
    try {
      for (const o of await compareProcesses(part, ids)) if (!o.result.error) fits[o.id] = o.result;
      fitCache.set(key, fits);
      if (fitCache.size > FIT_CACHE) fitCache.delete(fitCache.keys().next().value!);
    } catch {
      // without the kernel the plan still prices every route; it just cannot check their shapes
    }
  }
  return { plan: planManufacturing({ ...req, fits }), fits };
}

/** Part blocks that are made (not bought), once each, in source order. */
export function madeBlocks(model: Model | null = useDesign.getState().model): { name: string; label: string; count: number }[] {
  const out = new Map<string, { name: string; label: string; count: number }>();
  for (const p of model?.parts ?? []) {
    if (p.kind !== "part" || p.imported || p.hidden || p.id.startsWith(`${p.name}.`)) continue;
    const e = out.get(p.name);
    if (e) e.count++;
    else out.set(p.name, { name: p.name, label: p.label.replace(/ #\d+$/, "") || p.name, count: 1 });
  }
  return [...out.values()];
}

export interface PlannedDesign {
  parts: PlannedPart[];
  /** parts that could not be planned, and why */
  skipped: { label: string; why: string }[];
}

/** Plan every made part of the design, one after another (each checks its shape on the kernel). */
export async function planDesign(opts: { tiers?: Tier[]; onProgress?: (done: number, total: number, label: string) => void; cancelled?: () => boolean } = {}): Promise<PlannedDesign> {
  const blocks = madeBlocks((await whenChecked()).model);
  const out: PlannedDesign = { parts: [], skipped: [] };
  for (const [i, b] of blocks.entries()) {
    if (opts.cancelled?.()) break;
    opts.onProgress?.(i, blocks.length, b.label);
    try {
      out.parts.push(await planPart(b.name, { tiers: opts.tiers }));
    } catch (e) {
      out.skipped.push({ label: b.label, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
