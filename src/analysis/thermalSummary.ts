// Verdicts and plain words for heat, thermal stress, buckling and the
// accuracy check. Shared by the check report, the assistant's summaries and
// the analysis tab, so all three judge a result the same way.

import { fmtNum } from "../lang/values";
import type { StructuralResult, ThermalResult } from "./fe/structural";
import type { StructuralSpec } from "./spec";

type Verdict = "pass" | "warn" | "fail";
const p3 = (p: number[]) => `(${p.map((v) => fmtNum(v, 1)).join(", ")})`;
export const degC = (t: number) => `${fmtNum(t, Math.abs(t) < 100 ? 1 : 0)} °C`;
const pct = (x: number) => `${fmtNum(x * 100, x < 0.1 ? 1 : 0)} %`;

/** How long, in words. */
export function duration(s: number): string {
  if (s < 90) return `${fmtNum(s, s < 10 ? 1 : 0)} s`;
  if (s < 5400) return `${fmtNum(s / 60, s < 600 ? 1 : 0)} min`;
  return `${fmtNum(s / 3600, 1)} h`;
}

/** Temperatures only: a heat analysis with nothing holding the parts. */
export const heatOnlySpec = (spec: StructuralSpec) => !!spec.thermal && !spec.supports.length;

export type PartTemp = ThermalResult["parts"][number];

/**
 * The part closest to (or furthest past) its temperature limit. Past the limit fails; within the last tenth of
 * the headroom above the surroundings warns, and so do assumed properties that would otherwise pass.
 */
export function temperatureVerdict(r: StructuralResult): { status: Verdict; worst: PartTemp; margin: number } | null {
  const t = r.thermal;
  if (!t?.parts.length) return null;
  let worst = t.parts[0];
  for (const p of t.parts) if (p.limit - p.max < worst.limit - worst.max) worst = p;
  const margin = worst.limit - worst.max;
  const headroom = Math.max(worst.limit - t.ambient, 1);
  let status: Verdict = margin < 0 ? "fail" : margin < 0.1 * headroom ? "warn" : "pass";
  if (status === "pass" && t.parts.some((p) => p.assumed && p.max > t.ambient + 5)) status = "warn";
  if (!t.solve.converged && status === "pass") status = "warn";
  return { status, worst, margin };
}

/** The temperature check in words: the hottest point, each part, where the heat comes from and where it goes. */
export function temperatureText(r: StructuralResult): { detail: string; fix?: string } | null {
  const t = r.thermal;
  const v = temperatureVerdict(r);
  if (!t || !v) return null;
  let detail: string;
  if (t.transient) {
    const tr = t.transient;
    const end = tr.max.at(-1) ?? t.maxTemp.value;
    detail = `After ${duration(tr.time)} from ${degC(tr.start)}, the hottest point is ${degC(end)} on ${t.maxTemp.part} near ${p3(t.maxTemp.at)}.`;
    detail += tr.settles !== null ? ` Left running it would settle at about ${degC(tr.settles)}.` : " Nothing takes the heat away, so it keeps heating for as long as it runs.";
    if (tr.overLimit) detail += ` ${tr.overLimit.part} passes its limit after ${duration(tr.overLimit.time)}.`;
  } else detail = `Hottest point ${degC(t.maxTemp.value)} on ${t.maxTemp.part} near ${p3(t.maxTemp.at)}.`;
  detail += ` Closest to its limit: ${v.worst.name} at ${degC(v.worst.max)}, limit ${degC(v.worst.limit)} (${v.worst.limitWhy}).`;
  if (t.parts.length > 1)
    detail +=
      " Each part: " +
      t.parts
        .slice(0, 8)
        .map((p) => `${p.name} ${degC(p.max)}`)
        .join(", ") +
      (t.parts.length > 8 ? ` and ${t.parts.length - 8} more` : "") +
      ".";
  const made = t.sources.reduce((a, s) => a + s.watts, 0);
  if (t.sources.length)
    detail +=
      ` Heat made: ${fmtNum(made, 2)} W (` +
      t.sources
        .slice(0, 6)
        .map((s) => `${s.label} ${fmtNum(s.watts, 2)} W${s.why ? `, ${s.why}` : ""}`)
        .join("; ") +
      (t.sources.length > 6 ? `; ${t.sources.length - 6} more` : "") +
      ").";
  detail += ` Surroundings ${degC(t.ambient)}${t.ambientWhy ? ` (${t.ambientWhy})` : ""}${t.cooling ? `, ${t.cooling}` : ""}.`;
  if (t.balance && t.balance.made > 1e-6) {
    const b = t.balance;
    const share = (x: number) => fmtNum(Math.max(0, (100 * x) / b.made), 0);
    detail += ` Where it goes: ${share(b.film)} % into the air${b.radiation > 1e-6 ? `, ${share(b.radiation)} % radiated` : ""}${Math.abs(b.held) > 0.01 * b.made ? `, ${share(b.held)} % into held surfaces` : ""}.`;
  }
  let fix: string | undefined;
  if (v.status !== "pass") {
    const soft = t.parts.find((p) => p.name === v.worst.name && /softens/.test(p.limitWhy));
    fix = soft
      ? `Keep the heat away from ${v.worst.name}: more cooling (cooling: "fan" or vents), a metal plate or heatsink between it and the source, standoffs, or a plastic rated hotter (PETG, ASA, PC or PA-CF).`
      : `Give ${v.worst.name} more cooling: airflow (cooling: "fan"), a heatsink or a metal plate to spread the heat into, or less power through it.`;
  }
  return { detail, fix };
}

/** The lowest buckling factor against the target: under 1 the loads as given buckle the parts. */
export function bucklingVerdict(spec: StructuralSpec, r: StructuralResult): { status: Verdict; factor: number | null; margin: number } | null {
  if (!r.buckling || !spec.buckling) return null;
  const f = r.buckling.factors[0];
  if (f === undefined) return { status: "pass", factor: null, margin: Infinity };
  let status: Verdict = f < 1 ? "fail" : f < spec.buckling.safety ? "warn" : "pass";
  if (!r.buckling.converged && status === "pass") status = "warn";
  return { status, factor: f, margin: f - spec.buckling.safety };
}

export function bucklingText(spec: StructuralSpec, r: StructuralResult): { detail: string; fix?: string } | null {
  const v = bucklingVerdict(spec, r);
  const b = r.buckling;
  if (!v || !b) return null;
  if (v.factor === null)
    return {
      detail:
        b.reversed !== null
          ? `Nothing buckles under these loads: they stretch the slender parts rather than press them. Reversed, they would buckle at ${fmtNum(b.reversed, 2)}× their size.`
          : "Nothing buckles under these loads: they stretch the parts rather than press them.",
    };
  const target = spec.buckling!.safety;
  let detail = `The loads would have to be ${fmtNum(v.factor, 2)}× as large to buckle the parts (target ${fmtNum(target, 1)}×); the first buckled shape moves most near ${p3(b.peaks[0])}.`;
  if (b.factors.length > 1) detail += ` The next shapes need ${b.factors.slice(1).map((x) => `${fmtNum(x, 2)}×`).join(", ")}.`;
  detail += ` This assumes a perfect shape and straight loads; real parts with small dents, print lines or off-centre loads buckle sooner, which is why the target is above 1.`;
  if (v.status === "fail") detail += " Under the loads as given, it buckles.";
  return {
    detail,
    fix: v.status === "pass" ? undefined : "Make the slender walls or struts thicker, add ribs or a flange, shorten the unsupported length or brace it partway, or use a stiffer material.",
  };
}

/** The accuracy check: how far the answers moved when the elements shrank, and whether to trust them. */
export function accuracyText(r: StructuralResult): { status: Verdict; detail: string } | null {
  const c = r.convergence;
  if (!c) return null;
  const moves: string[] = [];
  if (!r.heatOnly) moves.push(`deflection ${pct(c.change.disp)}`, `stress ${pct(c.change.stress)}`, `safety factor ${pct(c.change.safety)}`);
  if (c.change.temp !== undefined) moves.push(`temperature rise ${pct(c.change.temp)}`);
  if (c.change.buckling !== undefined) moves.push(`buckling factor ${pct(c.change.buckling)}`);
  let detail = `Solved with ${fmtNum(c.coarse.h, 2)} mm elements and again with ${fmtNum(c.fine.h, 2)} mm (${c.coarse.elements.toLocaleString("en")} then ${c.fine.elements.toLocaleString("en")} elements): ${moves.join(", ")} moved.`;
  detail +=
    c.verdict === "converged"
      ? " The answers have settled, so the element size is not what limits them."
      : c.verdict === "close"
        ? " Close to settled: expect the true values within about the change shown."
        : " Not settled yet: the elements are too large for these answers; use a smaller resolution: before relying on them.";
  if (c.singular) detail += ` The peak stress at a support or load keeps rising (${fmtNum(c.coarse.peak, 1)} → ${fmtNum(c.fine.peak, 1)} MPa): it is a singularity of the idealised fixing, so judge the part by the stress a short way off.`;
  if (c.limited) detail += " The second solve could not use much smaller elements, so this check is weak.";
  return { status: c.verdict === "converged" ? "pass" : "warn", detail };
}
