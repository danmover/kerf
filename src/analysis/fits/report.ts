// The real-world fit check in the report: every fit, gear mesh and screw
// pattern judged over thousands of simulated builds. One summary line, a
// line for every gear mesh, and a line for each fit or pattern that fails
// or needs a look. The full list is in the analysis tab ("As made").
// Pure and cached per model, so it runs in every report, sub-agents too.

import type { Model } from "../../core/model";
import type { CheckItem } from "../../core/checks";
import { findFits } from "./detect";
import { simulateFits, type FitOutcome, type FitReport } from "./simulate";

const cache = new WeakMap<Model, FitReport>();

/** Fit results for a model (worked out once per model). */
export function fitReportFor(model: Model): FitReport {
  let r = cache.get(model);
  if (!r) {
    r = simulateFits(findFits(model), model);
    cache.set(model, r);
  }
  return r;
}

const KIND_WORD: Record<FitOutcome["kind"], string> = {
  "bearing-seat": "bearing seat",
  "bearing-shaft": "bearing on its shaft",
  "gear-bore": "gear bore",
  screw: "screw clearance",
  head: "screw head",
  locating: "locating spigot",
  pin: "pin or shaft",
  "gear-mesh": "gear mesh",
  "screw-pattern": "screw pattern",
};

export function fitItem(o: FitOutcome): CheckItem {
  return {
    id: `fit:${o.key}`,
    category: "fit",
    basis: "virtual test",
    status: o.status,
    title: o.kind === "gear-mesh" || o.kind === "screw-pattern" ? o.title : `Fit: ${o.title}`,
    detail: o.detail,
    parts: o.parts,
    fix: o.fix,
    margin: o.kind === "screw-pattern" ? o.made.p01 : undefined,
  };
}

/** Report pass: adds the fit checks. */
export function fitItems(items: CheckItem[], ctx: { model: Model }): CheckItem[] {
  const out = items.filter((i) => !i.id.startsWith("fit:"));
  const r = fitReportFor(ctx.model);
  if (!r.outcomes.length) return out;
  const fits = r.outcomes.filter((o) => o.kind !== "gear-mesh" && o.kind !== "screw-pattern");
  const bad = r.outcomes.filter((o) => o.status !== "pass");
  for (const o of r.outcomes) if (o.status !== "pass" || o.kind === "gear-mesh") out.push(fitItem(o));
  const instances = fits.reduce((s, o) => s + o.count, 0);
  const kinds = [...new Set(fits.map((o) => KIND_WORD[o.kind]))];
  const temps = r.temps.length ? `, at 20 °C and at ${r.temps.map((t) => `${t} °C`).join(" and ")} from the brief` : "";
  out.push({
    id: "fit:summary",
    category: "fit",
    basis: "virtual test",
    status: bad.some((o) => o.status === "fail") ? "fail" : bad.length ? "warn" : "pass",
    title: "Real-world fit",
    detail:
      `Built ${r.samples.toLocaleString("en")} times in simulation with every part a little off, the way its process makes it: ${fits.length} fits (${instances} places: ${kinds.join(", ")})` +
      `${r.outcomes.length > fits.length ? `, ${r.outcomes.length - fits.length} gear meshes and screw patterns` : ""}${temps}. ` +
      (bad.length ? `${bad.length} need${bad.length === 1 ? "s" : ""} attention: ${bad.map((o) => o.title).join("; ")}.` : "All of them go together and work in practically every build."),
  });
  return out;
}
