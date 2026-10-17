// Adds the heat checks to every report: one per closed space that holds
// electronics, worked out from the solids built so far (their boxes from the
// engine's mesh cache) and the design's working currents. Keeps the latest
// result where Claude's tools and the build pack can read it.

import { meshes, refreshReport } from "../core/engine";
import { registerReportPass, type ReportContext } from "../core/reportPasses";
import type { CheckItem } from "../core/checks";
import { geometryFromMeshes } from "../mfg/dfa";
import { heatItems, heatSpaces, type HeatSpace } from "./heat";

let latest: HeatSpace[] = [];

/** The heat balance behind the latest live checks. */
export function latestHeat(): HeatSpace[] {
  return latest;
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

let started = false;

/** Hook the heat checks into the report (after the simulations, whose run length they read from the source). */
export function startHeatChecks() {
  if (started) return;
  started = true;
  registerReportPass("heat", heatPass, 45);
  refreshReport();
}
