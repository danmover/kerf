// Topology optimisation in words: the shape found against the parts it was cut from, how the shape itself holds up
// under the loads, and how to make it (the profile for a plate, an STL otherwise).

import { fmtNum } from "../lang/values";
import type { StructuralResult, TopologyResult } from "./fe/structural";
import type { StructuralSpec } from "./spec";
import { staticSafety } from "./summary";

const pct = (x: number) => `${fmtNum(x * 100, x < 0.1 ? 1 : 0)} %`;
const grams = (g: number) => (g >= 1000 ? `${fmtNum(g / 1000, 2)} kg` : `${fmtNum(g, g < 10 ? 1 : 0)} g`);
const p3 = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;

/** The shape found: material kept, stiffness, openings, whether it settled, and the shape's own strength. */
export function topologyText(spec: StructuralSpec, r: StructuralResult): { detail: string; fix?: string; weak: boolean } {
  const t = r.topology!;
  const even = Math.pow(t.kept, 3);
  const st = staticSafety(r);
  const weak = st.value < spec.safety;
  const parts: string[] = [
    `Found a shape that keeps ${pct(t.kept)} of the material (${grams(t.massBefore)} down to ${grams(t.massAfter)}) and is ${pct(t.stiffness)} as stiff as the parts left solid under these loads; the same material spread evenly would be about ${pct(even)}.`,
    `${t.pieces > 1 ? `It is in ${t.pieces} pieces` : "It is one piece"}${t.openings ? ` with ${t.openings} opening${t.openings > 1 ? "s" : ""} through it` : ""}, members about ${fmtNum(t.minMember, 1)} mm or thicker${t.cut ? `, the same all the way through along ${t.cut} so it can be cut from plate` : ""}${t.symmetry.length ? `, mirrored across ${t.symmetry.join(" and ")}` : ""}.`,
    t.converged ? `It settled after ${t.iterations} design steps (${fmtNum(t.ms / 1000, 1)} s).` : `It stopped after ${t.iterations} design steps (${fmtNum(t.ms / 1000, 1)} s) before fully settling; the shape is close, and more iterations: may refine it.`,
    `As found, the shape's peak stress is ${fmtNum(r.maxStress.value, 1)} MPa near ${p3(r.maxStress.at)}, lowest safety factor ${fmtNum(st.value, 2)} (target ${fmtNum(spec.safety, 2)}), largest deflection ${fmtNum(r.maxDisp.value, 3)} mm.`,
  ];
  if (t.preserved > 0.005) parts.push(`${pct(t.preserved)} of the material was kept solid where the parts are held and loaded${spec.topology?.preserve.length || spec.topology?.preserveParts.length ? " and by preserve:" : ""}.`);
  if (t.trimmed > 0.005) parts.push(`${pct(t.trimmed)} of the material was left out because it no longer joined the supports.`);
  const fix = weak
    ? `As it is the shape is too weak for a safety factor of ${fmtNum(spec.safety, 2)}: keep more material (topology: ${Math.min(90, Math.round(t.keep * 100) + 15)}%) or make the members thicker when modelling it, then check the part in an analysis of its own.`
    : undefined;
  return { detail: parts.join(" "), ...(fix ? { fix } : {}), weak };
}

/** How to make the shape: the profile to cut from plate, else an STL to model from. */
export function topologyNext(t: TopologyResult): string {
  if (t.outline?.loops.length)
    return `To make it, extrude the profile below ${fmtNum(t.outline.to - t.outline.from, 2)} mm along ${t.outline.axis} (from ${fmtNum(t.outline.from, 2)} to ${fmtNum(t.outline.to, 2)}), or download it as DXF for a laser or waterjet from the Analysis tab.`;
  return "To make it, model the shape as a part (look at it with capture_view results), or download it as STL from the Analysis tab to print it or model over it.";
}

/** The profile of a shape cut from plate, as point lists in the plane's own axes, for modelling it. */
export function outlineText(t: TopologyResult, maxPoints = 400): string {
  const o = t.outline;
  if (!o || !o.loops.length) return "";
  const [u, v] = o.plane;
  let used = 0;
  const lines = [`Profile in the ${u}${v} plane, as (${u.toLowerCase()}, ${v.toLowerCase()}) in mm (outsides anticlockwise, holes clockwise):`];
  for (const [i, l] of o.loops.entries()) {
    if (used + l.points.length > maxPoints) {
      lines.push(`  …and ${o.loops.length - i} smaller loop${o.loops.length - i > 1 ? "s" : ""} (${o.loops.slice(i).filter((x) => !x.outer).length} holes) left out here.`);
      break;
    }
    used += l.points.length;
    lines.push(`  ${l.outer ? "outside" : "hole"} (${fmtNum(l.area, 0)} mm²): [${l.points.map(([a, b]) => `(${fmtNum(a, 1)}, ${fmtNum(b, 1)})`).join(", ")}]`);
  }
  return lines.join("\n");
}

/** The whole topology result for the assistant. */
export function topologySummary(spec: StructuralSpec, run: { status: string; result?: StructuralResult; error?: string; setup?: boolean; resolution: string; stale?: boolean } | undefined): string {
  const head = `Analysis "${spec.label}" (topology optimisation, keep ${pct(spec.topology!.keep)}; parts: ${spec.parts.join(", ")})`;
  if (!run || run.status === "idle") {
    if (run?.result?.topology) return `${head}: the design changed since this shape was found, so it is out of date; run it again with run_analysis label: "${spec.label}".\n${topologySummaryBody(spec, run.result)}`;
    return `${head}: ready, not run yet. It takes many solves (about half a minute at the standard resolution), so it runs only when asked: run_analysis label: "${spec.label}".`;
  }
  if (run.status === "waiting" || run.status === "running") return `${head}: still finding the shape.`;
  if (run.status === "error" || !run.result?.topology) return `${head}: ${run.setup ? "the set-up cannot be solved as written" : "did not finish"}. ${run.error ?? ""}`.trim();
  return `${head}:\n${topologySummaryBody(spec, run.result)}`;
}

function topologySummaryBody(spec: StructuralSpec, r: StructuralResult): string {
  const t = r.topology!;
  const tx = topologyText(spec, r);
  const lines = [tx.detail];
  if (tx.fix) lines.push(`Fix: ${tx.fix}`);
  lines.push(`Model: ${r.mesh.elements.toLocaleString("en")} elements kept of ${r.mesh.cell.map((c) => fmtNum(c, 2)).join(" × ")} mm on a ${r.mesh.grid.join(" × ")} grid.`);
  lines.push(topologyNext(t));
  const out = outlineText(t);
  if (out) lines.push(out);
  if (r.warnings.length) lines.push("Notes: " + r.warnings.join(" "));
  return lines.join("\n");
}

/** One line for the design overview. */
export function topologyLine(spec: StructuralSpec, run: { status: string; result?: StructuralResult; error?: string } | undefined): string {
  const head = `"${spec.label}" topology optimisation (${spec.parts.join(", ")}; keep ${pct(spec.topology!.keep)})`;
  if (!run || run.status === "idle") return `${head}: ${run?.result?.topology ? "out of date, the design changed" : "not run yet; it runs only when asked (run_analysis label:)"}`;
  if (run.status === "waiting" || run.status === "running") return `${head}: finding the shape`;
  if (run.status === "error" || !run.result?.topology) return `${head}: error: ${run.error ?? "did not finish"}`;
  const t = run.result.topology;
  return `${head}: kept ${pct(t.kept)}, ${pct(t.stiffness)} as stiff as solid, ${t.openings} opening${t.openings === 1 ? "" : "s"}, shape's safety ${fmtNum(staticSafety(run.result).value, 2)}`;
}
