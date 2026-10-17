// Adds the heat and service-life checks to every report. Heat: one check
// per closed space that holds electronics, from the solids built so far
// (their boxes from the engine's mesh cache) and the design's working
// currents. Service: lives and upkeep, counted in runs of the longest
// simulation with what it measured once it has run. Keeps the latest
// results where the Build tab, Claude's tools and the build pack read them.

import { meshes, refreshReport } from "../core/engine";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { CheckItem } from "../core/checks";
import type { Model } from "../core/model";
import { geometryFromMeshes } from "../mfg/dfa";
import { useSim } from "../sim/runtime";
import { heatItems, heatSpaces, type HeatSpace } from "./heat";
import { mainScenario, serviceItems, servicePlan, type ServicePlan, type UseFacts } from "./service";

let latest: HeatSpace[] = [];

/** The heat balance behind the latest live checks. */
export function latestHeat(): HeatSpace[] {
  return latest;
}

/** What the machine's job measured in simulation, once it has run: its run time and the battery it used. */
export function simUse(model: Model): UseFacts | undefined {
  const s = mainScenario(model);
  const v = s && useSim.getState().runs.get(s.label)?.result?.variants.find((x) => x.variant === "expected" && !x.error);
  const time = v?.results.time;
  if (!s || !v || typeof time !== "number" || time <= 0) return undefined;
  const used = v.results.battery_used;
  return { label: s.label, time, batteryUsed: typeof used === "number" ? used : undefined };
}

/** The service plan for a model, with the simulation's measurements when it has run. */
export function servicePlanFor(model: Model): ServicePlan {
  return servicePlan(model, simUse(model));
}

function heatPass(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  if (!ctx.model.machine?.components.length) {
    if (ctx.live) latest = [];
    return items;
  }
  const spaces = heatSpaces(ctx.model, { geometry: geometryFromMeshes(ctx.model, (h) => meshes.get(h), (p) => ctx.buildErrors.has(p.hash)) });
  if (ctx.live) latest = spaces;
  return [...items, ...heatItems(spaces)];
}

function servicePass(items: CheckItem[], ctx: ReportContext): CheckItem[] {
  if (!ctx.model.machine?.components.length) return items;
  return [...items, ...serviceItems(ctx.live ? servicePlanFor(ctx.model) : servicePlan(ctx.model))];
}

let started = false;

/** Hook the heat and service checks into the report (after the simulations, whose results they read). */
export function startHeatAndWearChecks() {
  if (started) return;
  started = true;
  registerReportPass("heat", heatPass, 45);
  registerReportPass("service", servicePass, 46);
  refreshReport();
}
