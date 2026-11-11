// Plain-text summaries of analysis results for the design assistant.

import { fmtNum } from "../lang/values";
import type { SafetyAt, StructuralResult } from "./fe/structural";
import type { DrivetrainResult } from "./drivetrain";
import { dropText, dropVerdict, vibrationText, vibrationVerdict } from "./dynamics";
import { describeRegion, UNRELIABLE_RESIDUAL, type AnalysisSpec, type DrivetrainSpec, type StructuralSpec, type UciSpec } from "./spec";
import type { CheckItem } from "../core/checks";
import { airflowLine } from "./aeroSummary";
import type { AirflowRun } from "./aeroRuntime";
import { accuracyText, bucklingText, bucklingVerdict, degC, heatOnlySpec, temperatureText, temperatureVerdict } from "./thermalSummary";
import { fatigueModeText, fatigueText, fatigueVerdict } from "./fatigueSummary";

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
  // a hot plastic's allowable is derated for the temperature there
  const hot = m.tempC !== undefined && m.tempC > 30 ? ` at ${fmtNum(m.tempC, 0)} °C` : "";
  if ((m.mode === "fatigue" || m.mode === "layer fatigue") && r.fatigue) return fatigueModeText(m, r.fatigue);
  if (m.mode === "layers" || m.mode === "layer fatigue") return `strength between print layers of ${m.material}${hot} (${fmtNum(m.allowable, 1)} MPa)`;
  if (m.mode === "fatigue") return `fatigue strength of ${m.material}${hot} for ${cycles ? cycles.toExponential(0) : "many"} cycles (${fmtNum(m.allowable, 1)} MPa)`;
  return `yield strength of ${m.material}${hot} (${fmtNum(m.allowable, 1)} MPa)`;
}

/** The lowest safety factor a short way from idealised supports and loads, when the overall lowest sits right on one. */
export function safetyAway(r: StructuralResult): SafetyAt | null {
  return r.minSafety.nearBoundary ? r.minSafety.away : null;
}

/** The static strength's lowest safety factor (yield and print layers at the loads' peak): with fatigue it is reported apart. */
export function staticSafety(r: StructuralResult): StructuralResult["minSafety"] {
  return r.staticSafety ?? r.minSafety;
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
  const st = staticSafety(r);
  const s = st.value;
  let status: Verdict = s >= spec.safety ? "pass" : s >= 1 ? "warn" : "fail";
  let note = "";
  const away = st.nearBoundary ? st.away : null;
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

/**
 * Each contact seat: pressed on, an edge lifting, or slipping. Pulled right
 * off fails; an edge lifting or friction not holding warns, since the band or
 * spring that presses it will give and the part shifts rather than breaks.
 */
export function contactVerdicts(spec: StructuralSpec, r: StructuralResult): { i: number; status: Verdict; title: string; detail: string; fix?: string; margin: number }[] {
  const out: { i: number; status: Verdict; title: string; detail: string; fix?: string; margin: number }[] = [];
  r.supports.forEach((s, i) => {
    const c = s.contact;
    const ct = spec.supports[i]?.contact;
    if (!c || !ct) return;
    const where = describeRegion(spec.supports[i].region);
    const grip = ct.grip?.names.length ? ` and ${ct.grip.names.join(" and ")} round the tube (${fmtNum(ct.grip.force, 1)} N along it, ${fmtNum(ct.grip.moment / 1000, 2)} N·m about it)` : "";
    let detail = `The seat on ${where} is pressed on with ${fmtNum(c.pressing, 1)} N.`;
    detail += ` Friction (μ ${fmtNum(ct.mu, 2)} at the seat${grip}) must hold ${fmtNum(c.slide, 1)} N of sliding and ${fmtNum(c.twist / 1000, 3)} N·m of turning: it holds ${fmtNum(c.slideCap, 1)} N and ${fmtNum(c.twistCap / 1000, 3)} N·m, so it uses ${fmtNum(c.use * 100, 0)} % of its grip.`;
    let status: Verdict = "pass";
    let fix: string | undefined;
    if (c.pressing <= 0) {
      status = "fail";
      detail += " The loads pull it right off the seat.";
      fix = "Press it on harder (a tighter band or a second one) or move the load closer to the seat.";
    } else {
      // with a straight pressure ramp across the seat, the share of it that opens a gap
      const open = Math.min(1, Math.max(0, 1.5 * c.lift - 0.5));
      const near = c.liftAt ? ` near ${p3(c.liftAt)}` : "";
      if (c.lift >= 1) {
        status = "warn";
        detail += ` The loads press it on outside the seat, so it tips over its edge and the side${near} lifts off: it rocks on the seat.`;
        fix = "Widen the seat across the load, press it on harder, or bring the load closer.";
      } else if (open >= 0.5) {
        status = "warn";
        detail += ` The pressure is lopsided: about ${fmtNum(open * 100, 0)} % of the seat${near} lets go, so it rocks and can rattle.`;
        fix = "Widen the seat across the load, press it on harder, or bring the load closer.";
      } else if (open > 0) detail += ` The pressure leans to one side: the edge${near} carries little but stays on.`;
      else detail += " Every part of the seat stays pressed on.";
      if (c.use > 1) {
        status = "warn";
        detail += " Friction cannot hold it: it slides or turns on the seat until something stops it.";
        fix = (fix ? fix + " " : "") + "Add grip (a rubber pad, a band with more pull) or a shape that keys it, such as a seat that hugs the tube's corners.";
      }
    }
    out.push({ i, status, title: `Stays put: ${spec.label}`, detail, fix, margin: c.pressing > 0 ? 1 - c.use : -1 });
  });
  return out;
}

/** Only natural frequencies: no loads, so no stresses to judge. */
const modalOnly = (spec: StructuralSpec) => !!spec.modal && !spec.loads.length && !spec.accel;

/** Pass, warn or fail for a structural result, the same way the checks judge it. */
export function structuralVerdict(spec: StructuralSpec, r: StructuralResult): Verdict {
  if (modalOnly(spec)) return vibrationVerdict(spec, r);
  if (spec.drop) return dropVerdict(spec, r, strengthVerdict(spec, r).status);
  const temp = temperatureVerdict(r)?.status ?? "pass";
  if (heatOnlySpec(spec)) return temp;
  const all = [
    strengthVerdict(spec, r).status,
    stiffnessVerdict(spec, r) ?? "pass",
    vibrationVerdict(spec, r),
    ...contactVerdicts(spec, r).map((c) => c.status),
    spec.thermal ? temp : temp === "fail" ? "fail" : "pass",
    bucklingVerdict(spec, r)?.status ?? "pass",
    fatigueVerdict(spec, r)?.status ?? "pass",
  ];
  return all.includes("fail") ? "fail" : all.includes("warn") ? "warn" : "pass";
}

/** Heat, buckling and the accuracy check, as summary lines. */
function extraLines(spec: StructuralSpec, r: StructuralResult): string[] {
  const out: string[] = [];
  const tt = temperatureText(r);
  const tv = temperatureVerdict(r);
  if (tt && tv && (spec.thermal || tv.status !== "pass")) out.push(`Temperature: ${tv.status.toUpperCase()}. ${tt.detail}${tt.fix ? ` Fix: ${tt.fix}` : ""}`);
  if (r.thermal && !r.heatOnly) out.push(`Thermal stress: the parts carry no thermal stress at ${degC(r.thermal.refTemp ?? 20)} (made and assembled); expansion beyond that pushes against the supports, and hot plastics are weaker and softer.`);
  const bt = bucklingText(spec, r);
  const bv = bucklingVerdict(spec, r);
  if (bt && bv) out.push(`Buckling: ${bv.status.toUpperCase()}. ${bt.detail}${bt.fix ? ` Fix: ${bt.fix}` : ""}`);
  const ft = fatigueText(spec, r);
  const fv = fatigueVerdict(spec, r);
  if (ft && fv) out.push(`Fatigue: ${fv.status.toUpperCase()}. ${ft.detail}${ft.fix ? ` Fix: ${ft.fix}` : ""}`);
  const acc = accuracyText(r);
  if (acc) out.push(`Accuracy check: ${acc.status.toUpperCase()}. ${acc.detail}`);
  return out;
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
  if (heatOnlySpec(spec)) {
    lines[0] = `Analysis "${spec.label}" (heat; parts: ${spec.parts.join(", ")}): ${structuralVerdict(spec, r).toUpperCase()}.`;
    lines.push(...extraLines(spec, r));
    if (spec.thermal?.fixed.length) lines.push("Held temperatures: " + spec.thermal.fixed.map((f) => `${describeRegion(f.region)} at ${degC(f.temp)}`).join("; ") + ".");
    if (r.warnings.length) lines.push("Notes: " + r.warnings.join(" "));
    return lines.join("\n");
  }
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
  const st = staticSafety(r);
  lines.push(
    `Lowest ${r.fatigue ? "static " : ""}safety factor ${sf(st.value)} at ${p3(st.at)}, judged against the ${modeText(r, spec.cycles, st)}${r.fatigue ? ` at the loads' peak (${fmtNum(r.fatigue.peak, 2)}× them)` : ""}; target ${fmtNum(spec.safety, 2)}.${strengthVerdict(spec, r).note}`,
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
      r.supports.map((s, i) => `${s.contact ? "contact" : s.dir ? "roller" : "fixed"} ${describeRegion(spec.supports[i].region)} (${s.nodes} nodes) carries ${fmtNum(Math.hypot(...s.reaction), 1)} N`).join("; ") +
      ".",
  );
  for (const c of contactVerdicts(spec, r)) lines.push(`${c.title}: ${c.status.toUpperCase()}. ${c.detail}${c.fix ? ` Fix: ${c.fix}` : ""}`);
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
  lines.push(...extraLines(spec, r));
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

/** A UCI rules check's items (from the check report) as text. */
export function uciSummary(spec: UciSpec, report: CheckItem[]): string {
  const items = uciItems(spec, report);
  const head = `Analysis "${spec.label}" (UCI road racing rules, 2026)`;
  if (!items.length) return `${head}: not checked yet.`;
  const v = uciVerdict(items);
  return [`${head}: ${v === "pending" ? "MEASURING" : v.toUpperCase()}.`, ...items.map((i) => `  - [${i.status}] ${i.title.replace(/^UCI: /, "")}: ${i.detail}${i.fix ? ` Fix: ${i.fix}` : ""}`)].join("\n");
}

/** The report items a UCI rules check produced. */
export const uciItems = (spec: UciSpec, report: CheckItem[]) => report.filter((i) => i.id.startsWith(`uci:${spec.label}:`));

export function uciVerdict(items: CheckItem[]): "pass" | "warn" | "fail" | "pending" {
  if (!items.length || items.some((i) => i.status === "pending")) return "pending";
  return items.some((i) => i.status === "fail") ? "fail" : items.some((i) => i.status === "warn") ? "warn" : "pass";
}

/** One line per analysis for the design overview. */
export function analysisLine(spec: AnalysisSpec, run: RunLike | undefined, dt: DrivetrainResult | undefined, report: CheckItem[] = [], air?: AirflowRun, study?: string): string {
  if (spec.kind === "airflow") return airflowLine(spec, air);
  if (spec.kind === "study")
    return `"${spec.label}" design study (${spec.goal.text}, varying ${spec.vary.map((v) => v.name).join(", ")}; up to ${spec.runs} designs): ${study ?? "not run yet; it runs only when asked (run_analysis label:)"}`;
  if (spec.kind === "uci") {
    const items = uciItems(spec, report);
    const bad = items.filter((i) => i.status === "fail" || i.status === "warn");
    return `"${spec.label}" UCI road rules: ${uciVerdict(items)}${bad.length ? ` (${bad.map((i) => i.title.replace(/^UCI: /, "")).join("; ")})` : ""}`;
  }
  if (spec.kind === "drivetrain") {
    const state = !dt ? "not calculated" : dt.error ? `error: ${dt.error}` : `${dt.items.filter((i) => i.status === "fail").length} failing of ${dt.items.length} checks`;
    return `"${spec.label}" drivetrain (${spec.drive}, ${fmtNum(spec.torque / 1000, 3)} N·m at ${fmtNum(spec.speed, 0)} rpm): ${state}`;
  }
  if (heatOnlySpec(spec)) {
    const t = spec.thermal!;
    const setup = `${spec.parts.join(", ")}; ${t.heat.length ? `${fmtNum(t.heat.reduce((a, h) => a + h.watts, 0), 2)} W made` : ""}${t.auto ? `${t.heat.length ? ", " : ""}electronics' own losses` : ""}${t.fixed.length ? `, ${t.fixed.length} held surface(s)` : ""}; ${t.coolingText}${t.time ? `; warm-up over ${fmtNum(t.time / 60, 1)} min` : ""}`;
    let state = "not run yet";
    if (run?.status === "running" || run?.status === "waiting") state = "running";
    else if (run?.status === "error") state = `error: ${run.error ?? "did not finish"}`;
    else if (run?.result?.thermal) {
      const tv = temperatureVerdict(run.result);
      state = `${structuralVerdict(spec, run.result)}, hottest ${degC(run.result.thermal.maxTemp.value)} on ${run.result.thermal.maxTemp.part}${tv ? ` (${tv.worst.name} ${degC(tv.worst.max)} against ${degC(tv.worst.limit)})` : ""}`;
    }
    return `"${spec.label}" heat (${setup}): ${state}`;
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
  else if (run?.result) {
    const r = run.result;
    state = `${structuralVerdict(spec, r)}${r.drop ? `, ${fmtNum(r.drop.g, 0)} g on landing` : ""}${r.modal ? `, first mode ${fmtNum(r.modal.modes[0]?.freq ?? 0, 1)} Hz` : ""}, safety ${sf(r.minSafety.value)}, peak ${fmtNum(r.maxStress.value, 1)} MPa, deflection ${fmtNum(r.maxDisp.value, 3)} mm`;
    if (r.thermal && spec.thermal) state += `, hottest ${degC(r.thermal.maxTemp.value)}`;
    if (r.buckling) state += r.buckling.factors.length ? `, buckles at ${fmtNum(r.buckling.factors[0], 2)}× the loads` : ", does not buckle";
    if (r.convergence) state += `, accuracy check ${r.convergence.verdict}`;
  }
  return `"${spec.label}" structural (${setup}): ${state}`;
}
