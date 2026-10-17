// Plain-text summaries of analysis results for the design assistant.

import { fmtNum } from "../lang/values";
import type { SafetyAt, StructuralResult } from "./fe/structural";
import type { DrivetrainResult } from "./drivetrain";
import { dropText, dropVerdict, vibrationText, vibrationVerdict } from "./dynamics";
import { describeRegion, UNRELIABLE_RESIDUAL, type AnalysisSpec, type DrivetrainSpec, type StructuralSpec } from "./spec";

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

type Verdict = "pass" | "warn" | "fail";

/** What a safety factor is judged against; the overall lowest one unless another is given. */
export function modeText(r: StructuralResult, cycles?: number, m: SafetyAt = r.minSafety): string {
  if (m.mode === "layers") return `strength between print layers of ${m.material} (${fmtNum(m.allowable, 1)} MPa)`;
  if (m.mode === "fatigue") return `fatigue strength of ${m.material} for ${cycles ? cycles.toExponential(0) : "many"} cycles (${fmtNum(m.allowable, 1)} MPa)`;
  return `yield strength of ${m.material} (${fmtNum(m.allowable, 1)} MPa)`;
}

/** The lowest safety factor a short way from idealised supports and loads, when the overall lowest sits right on one. */
export function safetyAway(r: StructuralResult): SafetyAt | null {
  return r.minSafety.nearBoundary ? r.minSafety.away : null;
}

/** Reasons not to trust a result to pass: materials without strength data, or a solve that did not converge. */
export function doubts(r: StructuralResult): { assumed: string[]; unreliable: boolean } {
  return { assumed: [...new Set(r.materials.filter((m) => m.assumed).map((m) => m.name))], unreliable: r.solve.residual > UNRELIABLE_RESIDUAL };
}

/**
 * Strength verdict from the lowest safety factor. A low value right at a support or load is only a
 * warning when the part passes a short way off. Doubtful results never pass, and an unconverged
 * solve fails nothing either.
 */
export function strengthVerdict(spec: StructuralSpec, r: StructuralResult): { status: Verdict; note: string } {
  const s = r.minSafety.value;
  let status: Verdict = s >= spec.safety ? "pass" : s >= 1 ? "warn" : "fail";
  let note = "";
  const away = safetyAway(r);
  if (status !== "pass" && away && away.value >= spec.safety) {
    status = "warn";
    note += ` The lowest value sits right at a support or load, where the idealised fixing exaggerates stress; a short way off the lowest safety factor is ${sf(away.value)} at ${p3(away.at)}, against the ${modeText(r, spec.cycles, away)}. Check how that area is really held.`;
  }
  const d = doubts(r);
  if (d.unreliable) {
    status = "warn";
    note += ` The solver did not converge (relative residual ${r.solve.residual.toExponential(1)}), so this is neither a pass nor a fail.`;
  } else if (d.assumed.length && status === "pass") {
    status = "warn";
    note += ` There is no strength data for ${d.assumed.join(", ")}, so PLA values were assumed; set a known material to get a real pass.`;
  }
  return { status, note };
}

/** Deflection against max_deflection:, null when there is no limit. Same doubts as for strength. */
export function stiffnessVerdict(spec: StructuralSpec, r: StructuralResult): Verdict | null {
  if (spec.maxDeflection === undefined) return null;
  const ok = r.maxDisp.value <= spec.maxDeflection;
  const d = doubts(r);
  return d.unreliable || (ok && d.assumed.length) ? "warn" : ok ? "pass" : "fail";
}

/** Only natural frequencies: no loads, so no stresses to judge. */
const modalOnly = (spec: StructuralSpec) => !!spec.modal && !spec.loads.length && !spec.accel;

/** Pass, warn or fail for a structural result, the same way the checks judge it. */
export function structuralVerdict(spec: StructuralSpec, r: StructuralResult): Verdict {
  if (modalOnly(spec)) return vibrationVerdict(spec, r);
  if (spec.drop) return dropVerdict(spec, r, strengthVerdict(spec, r).status);
  const all = [strengthVerdict(spec, r).status, stiffnessVerdict(spec, r) ?? "pass", vibrationVerdict(spec, r)];
  return all.includes("fail") ? "fail" : all.includes("warn") ? "warn" : "pass";
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
  ];
  if (spec.masses?.length) lines.push(`Carried masses: ${spec.masses.map((m) => `${fmtNum(m.grams, 0)} g on ${describeRegion(m.region)}`).join("; ")}.`);
  if (r.modal) {
    const t = vibrationText(spec, r);
    lines.push(`${t.detail}${t.fix ? ` Fix: ${t.fix}` : ""}`);
  }
  if (r.drop) lines.push(dropText(spec, r));
  if (modalOnly(spec)) {
    lines.push("Supports: " + spec.supports.map((s) => describeRegion(s.region)).join("; ") + ".");
    if (r.warnings.length) lines.push("Notes: " + r.warnings.join(" "));
    return lines.join("\n");
  }
  lines.push(
    `Lowest safety factor ${sf(r.minSafety.value)} at ${p3(r.minSafety.at)}, judged against the ${modeText(r, spec.cycles)}; target ${fmtNum(spec.safety, 2)}.${strengthVerdict(spec, r).note}`,
  );
  lines.push(
    `Peak von Mises stress ${fmtNum(r.maxStress.value, 2)} MPa near ${p3(r.maxStress.at)}.` +
      (r.maxStress.nearBoundary && r.maxStress.away ? ` It sits right at a support or load; a short way off the peak is ${fmtNum(r.maxStress.away.value, 2)} MPa.` : ""),
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
  if (r.gravity && !r.drop) lines.push(`Body load: ${p3(spec.accel ?? [0, 0, -1])} g on ${fmtNum(r.mass, 1)} g of material.`);
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
  const setup = spec.drop
    ? `${spec.parts.join(", ")}; ${spec.drop.tip ? `tips over toward ${p3(spec.drop.dir)}` : `falls ${fmtNum((spec.drop.height ?? 0) / 1000, 2)} m`} onto ${spec.drop.floor.name}; safety target ${fmtNum(spec.safety, 2)}`
    : modalOnly(spec)
      ? `${spec.parts.join(", ")}; natural frequencies${spec.modal!.excite.length ? ` against ${spec.modal!.excite.map((e) => e.label).join(", ")}` : ""}`
      : `${spec.parts.join(", ")}; ${spec.supports.length} support(s), ${spec.loads.length} load(s)${spec.accel ? ", body load" : ""}; safety target ${fmtNum(spec.safety, 2)}`;
  let state = "not run yet";
  if (run?.status === "running" || run?.status === "waiting") state = "running";
  else if (run?.status === "error") state = `error: ${run.error ?? "did not finish"}`;
  else if (run?.result && modalOnly(spec)) state = `${structuralVerdict(spec, run.result)}, first mode ${fmtNum(run.result.modal?.modes[0]?.freq ?? 0, 1)} Hz`;
  else if (run?.result) state = `${structuralVerdict(spec, run.result)}${run.result.drop ? `, ${fmtNum(run.result.drop.g, 0)} g on landing` : ""}${run.result.modal ? `, first mode ${fmtNum(run.result.modal.modes[0]?.freq ?? 0, 1)} Hz` : ""}, safety ${sf(run.result.minSafety.value)}, peak ${fmtNum(run.result.maxStress.value, 1)} MPa, deflection ${fmtNum(run.result.maxDisp.value, 3)} mm`;
  return `"${spec.label}" structural (${setup}): ${state}`;
}
