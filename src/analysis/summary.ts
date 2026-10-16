// Plain-text summaries of analysis results for the design assistant.

import { fmtNum } from "../lang/values";
import type { StructuralResult } from "./fe/structural";
import type { DrivetrainResult } from "./drivetrain";
import { describeRegion, type AnalysisSpec, type DrivetrainSpec, type StructuralSpec } from "./spec";

/** What the assistant needs of a structural run (a subset of the runtime's StructuralRun). */
export interface RunLike {
  status: "waiting" | "running" | "done" | "error";
  result?: StructuralResult;
  error?: string;
  setup?: boolean;
  resolution: string;
}

const p3 = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;
const sf = (v: number) => (!Number.isFinite(v) || v >= 100 ? "over 100" : fmtNum(v, 2));

/** Lowest safety factor a short way off a support or load, when the peak sits right on one. */
function awaySafety(r: StructuralResult): number | null {
  const a = r.maxStress.away;
  if (!r.maxStress.nearBoundary || !a || a.value <= 0) return null;
  return r.minSafety.value * (r.maxStress.value / a.value);
}

function basisText(r: StructuralResult, cycles?: number): string {
  const m = r.minSafety;
  if (m.mode === "layers") return `the strength between print layers of ${m.material} (${fmtNum(m.allowable, 1)} MPa)`;
  if (m.mode === "fatigue") return `the fatigue strength of ${m.material} for ${cycles ? cycles.toExponential(0) : "many"} cycles (${fmtNum(m.allowable, 1)} MPa)`;
  return `the yield strength of ${m.material} (${fmtNum(m.allowable, 1)} MPa)`;
}

/** Pass, warn or fail for a structural result, the same way the checks judge it. */
export function structuralVerdict(spec: StructuralSpec, r: StructuralResult): "pass" | "warn" | "fail" {
  const s = r.minSafety.value;
  const strength = s >= spec.safety ? "pass" : s >= 1 ? "warn" : "fail";
  const away = awaySafety(r);
  const judged = strength !== "pass" && away !== null && away >= spec.safety ? "warn" : strength;
  if (spec.maxDeflection !== undefined && r.maxDisp.value > spec.maxDeflection) return "fail";
  return judged;
}

export function structuralSummary(spec: StructuralSpec, run: RunLike | undefined): string {
  const head = `Analysis "${spec.label}" (structural; parts: ${spec.parts.join(", ")})`;
  if (!run || run.status === "waiting" || run.status === "running") return `${head}: still running.`;
  if (run.status === "error" || !run.result) {
    return `${head}: ${run.setup ? "the set-up cannot be solved as written" : "did not finish"}. ${run.error ?? ""}${run.setup ? " Fix the analysis block and run it again." : ""}`.trim();
  }
  const r = run.result;
  const mats = [...new Set(r.materials.map((m) => `${m.name}${m.assumed ? " (properties assumed)" : ""}`))].join(", ");
  const printed = r.materials.some((m) => m.layerFactor < 1) && r.layer !== null;
  const lines = [
    `${head}: ${structuralVerdict(spec, r).toUpperCase()}.`,
    `Model: ${mats}${printed ? `, printed with layers stacked along ${p3(spec.buildDir)}` : ""}; ${run.resolution} resolution, ${r.mesh.elements.toLocaleString("en")} elements of ${r.mesh.cell.map((c) => fmtNum(c, 2)).join(" × ")} mm; solved in ${fmtNum(r.solve.ms.total / 1000, 1)} s (${r.solve.converged ? "converged" : "NOT fully converged"} in ${r.solve.iterations} iterations).`,
    `Lowest safety factor ${sf(r.minSafety.value)} at ${p3(r.minSafety.at)}, judged against ${basisText(r, spec.cycles)}; target ${fmtNum(spec.safety, 2)}.`,
  ];
  const away = awaySafety(r);
  lines.push(
    `Peak von Mises stress ${fmtNum(r.maxStress.value, 2)} MPa near ${p3(r.maxStress.at)}.` +
      (away !== null && r.maxStress.away
        ? ` The peak sits right at a support or load, where the idealised fixing exaggerates stress; a short way off it is ${fmtNum(r.maxStress.away.value, 2)} MPa (safety factor ${sf(away)}).`
        : ""),
  );
  lines.push(`Largest deflection ${fmtNum(r.maxDisp.value, 4)} mm at ${p3(r.maxDisp.at)}${spec.maxDeflection !== undefined ? ` (limit ${fmtNum(spec.maxDeflection, 3)} mm: ${r.maxDisp.value <= spec.maxDeflection ? "passes" : "FAILS"})` : ""}.`);
  lines.push(`Largest principal strain ${fmtNum(Math.abs(r.maxStrain.value) * 100, 4)} % (${fmtNum(Math.abs(r.maxStrain.value) * 1e6, 0)} microstrain). Mass ${fmtNum(r.mass, 2)} g.`);
  if (r.hotSpots.length) lines.push("Hot spots (separate high-stress areas): " + r.hotSpots.slice(0, 5).map((h, i) => `${i + 1}) ${p3(h.at)} ${fmtNum(h.stress, 1)} MPa, safety ${sf(h.safety)}`).join("; ") + ".");
  if (r.layer) lines.push(`Worst stress across print layers: ${fmtNum(r.layer.value, 2)} MPa at ${p3(r.layer.at)}.`);
  lines.push(
    "Supports: " +
      r.supports.map((s, i) => `${s.dir ? "roller" : "fixed"} ${describeRegion(spec.supports[i].region)} (${s.nodes} nodes) carries ${fmtNum(Math.hypot(...s.reaction), 1)} N`).join("; ") +
      ".",
  );
  if (r.loads.length)
    lines.push(
      "Loads: " +
        r.loads
          .map((l, i) => {
            const where = describeRegion(spec.loads[i].region);
            const L = spec.loads[i];
            if (L.t === "torque") return `torque ${fmtNum(L.torque / 1000, 3)} N·m about ${p3(L.axis)} through ${p3(l.at)} on ${where} (${fmtNum(l.area, 0)} mm²)`;
            return `${l.kind} totalling ${fmtNum(l.magnitude, 1)} N on ${where} (${fmtNum(l.area, 0)} mm², centred ${p3(l.at)})`;
          })
          .join("; ") +
        ".",
    );
  if (r.gravity) lines.push(`Body load: ${p3(spec.accel ?? [0, 0, -1])} g on ${fmtNum(r.mass, 1)} g of material.`);
  lines.push(`Reactions balance the loads to within ${r.equilibrium < 1e-3 ? "0.1" : fmtNum(r.equilibrium * 100, 2)} %.`);
  if (r.warnings.length) lines.push("Notes: " + r.warnings.join(" "));
  return lines.join("\n");
}

export function drivetrainSummary(spec: DrivetrainSpec, r: DrivetrainResult | undefined): string {
  const head = `Analysis "${spec.label}" (drivetrain; ${spec.drive} at ${fmtNum(spec.torque / 1000, 3)} N·m, ${fmtNum(spec.speed, 0)} rpm)`;
  if (!r) return `${head}: not calculated.`;
  if (r.error) return `${head}: cannot be calculated. ${r.error}`;
  const fails = r.items.filter((i) => i.status === "fail").length;
  const warns = r.items.filter((i) => i.status === "warn").length;
  const lines = [`${head}: ${fails ? "FAIL" : warns ? "WARN" : "PASS"}. Input power ${fmtNum(r.power, 2)} W.`];
  if (r.outputs.length) lines.push("Outputs: " + r.outputs.map((o) => `${o.name} ${fmtNum(o.rpm, 1)} rpm, ${fmtNum(o.torque / 1000, 3)} N·m`).join("; ") + ".");
  for (const i of r.items) lines.push(`  - [${i.status}] ${i.title}: ${i.detail}`);
  if (r.warnings.length) lines.push("Notes: " + r.warnings.join(" "));
  return lines.join("\n");
}

/** One line per analysis for the design overview. */
export function analysisLine(spec: AnalysisSpec, run: RunLike | undefined, dt: DrivetrainResult | undefined): string {
  if (spec.kind === "drivetrain") {
    const state = !dt ? "not calculated" : dt.error ? `error: ${dt.error}` : `${dt.items.filter((i) => i.status === "fail").length} failing of ${dt.items.length} checks`;
    return `"${spec.label}" drivetrain (${spec.drive}, ${fmtNum(spec.torque / 1000, 3)} N·m at ${fmtNum(spec.speed, 0)} rpm): ${state}`;
  }
  const setup = `${spec.parts.join(", ")}; ${spec.supports.length} support(s), ${spec.loads.length} load(s)${spec.accel ? ", body load" : ""}; safety target ${fmtNum(spec.safety, 2)}`;
  let state = "not run yet";
  if (run?.status === "running" || run?.status === "waiting") state = "running";
  else if (run?.status === "error") state = `error: ${run.error ?? "did not finish"}`;
  else if (run?.result) state = `${structuralVerdict(spec, run.result)}, safety ${sf(run.result.minSafety.value)}, peak ${fmtNum(run.result.maxStress.value, 1)} MPa, deflection ${fmtNum(run.result.maxDisp.value, 3)} mm`;
  return `"${spec.label}" structural (${setup}): ${state}`;
}
