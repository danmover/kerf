// The app's side of a script's calls: the open design from the engine, other readings of it built in the agents'
// geometry workers, files from the same exporters as the Export menu, and strength analyses solved as a design study
// solves them.

import { meshes, setSource, useDesign, whenChecked, whenRefined } from "../core/engine";
import { measureIsolated } from "../agents/isolated";
import { commitSource, endPreview, realSource, useProject } from "../app/project";
import { kernel } from "../kernel/client";
import { meshesFor } from "../app/exports";
import { exportFilesOf } from "./files";
import { liveAirSource, resolveThermal, solveOnce, structuralInput } from "../analysis/runtime";
import { summarise as analysisSummary } from "../analysis/study";
import type { StructuralSpec } from "../analysis/spec";
import type { AnalysisSummary, DesignRead, ExportFormat, ExportOptions, ScriptHost } from "./session";

/** The open design as it stands, once its checks have run. */
async function current(): Promise<DesignRead> {
  await whenChecked();
  const s = useDesign.getState();
  if (!s.model) throw new Error("No design is open.");
  return {
    source: s.source,
    model: s.model,
    report: s.report,
    geom: (h) => meshes.get(h),
    mesh: (h) => meshes.get(h)?.final ?? meshes.get(h)?.preview,
  };
}

/** The host for one run, bound to the design open when it started: once another design is open the run can't reach it. */
export function appScriptHost(author: "you" | "claude", project = useProject.getState().current?.id): ScriptHost {
  const open = () => useProject.getState().current?.id === project;
  const here = () => {
    if (!open()) throw new Error("The design was closed, so the run stopped.");
  };
  return {
    source: () => (here(), realSource()),
    current: () => (here(), current()),
    async measure(source) {
      const r = await measureIsolated(source, () => []);
      return {
        source,
        model: r.model,
        report: r.report,
        geom: (h) => r.parts.get(h),
        mesh: (h) => r.parts.get(h)?.mesh,
        ...(r.error ? { error: r.error } : {}),
      };
    },
    async show(source) {
      here();
      // a version being previewed goes away first, so the change is made to the real design
      endPreview();
      setSource(source);
      return current();
    },
    keep(before, message) {
      if (!open()) return;
      commitSource(useDesign.getState().source, author, message, { undoBase: before });
    },
    async analyse(read, name): Promise<AnalysisSummary> {
      const all = read.model.analyses.filter((a): a is StructuralSpec => a.kind === "structural");
      const spec = name ? all.find((a) => a.label === name) : all[0];
      if (!spec) {
        const other = name ? read.model.analyses.find((a) => a.label === name) : undefined;
        if (other) throw new Error(`"${name}" is ${other.kind === "airflow" ? "an airflow" : `a ${other.kind}`} analysis; scripts run strength analyses for now.`);
        throw new Error(all.length ? `The design has no strength analysis called "${name}". Its strength analyses: ${all.map((a) => `"${a.label}"`).join(", ")}.` : "The design has no strength analysis (an analysis block).");
      }
      if (read.model.diagnostics.some((d) => d.severity === "error")) throw new Error(`The design has errors, so "${spec.label}" was not run.`);
      const parts = read.model.parts.filter((q) => spec.parts.includes(q.name));
      const prep = structuralInput(resolveThermal(spec, read.model), parts, false, new Map(), read.mesh, liveAirSource(read.model));
      if (!prep) throw new Error(`The parts of "${spec.label}" did not build.`);
      if (prep.error) throw new Error(prep.error);
      if (prep.wait) throw new Error(`${prep.wait}: run it again once the airflow analysis is done.`);
      const r = analysisSummary(spec, await solveOnce(prep.input!));
      return {
        name: r.label,
        verdict: String(r.verdict),
        ...(r.safety !== undefined ? { safety: r.safety } : {}),
        ...(r.stress !== undefined ? { stress: r.stress } : {}),
        ...(r.deflection !== undefined ? { deflection: r.deflection } : {}),
        ...(r.frequency !== undefined ? { frequency: r.frequency } : {}),
        ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
        ...(r.buckling !== undefined ? { buckling: r.buckling } : {}),
      };
    },
    exportFiles(read, format: ExportFormat, opts: ExportOptions) {
      here();
      const live = read.source === useDesign.getState().source;
      return exportFilesOf(read, format, opts, {
        name: useProject.getState().current?.name || read.model.name || "design",
        step: (items) => kernel.exportStep(items),
        async meshes(parts) {
          // the open design's own fine meshes, or fine meshes built now for another reading
          if (live) {
            await whenRefined();
            return (p) => meshes.get(p.hash)?.final ?? meshes.get(p.hash)?.preview;
          }
          const built = await meshesFor(parts);
          return (p) => built.get(p.hash);
        },
      });
    },
    projects: () => useProject.getState().projects.map((p) => ({ name: p.name, updated: p.updatedAt })),
  };
}
