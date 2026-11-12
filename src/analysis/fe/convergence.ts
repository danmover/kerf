// An accuracy check: the same analysis solved twice, the second time with
// elements about a third smaller each way, and how far the answers moved.
// This is how analysts judge whether a number is real or an artefact of the
// element size. At a sharp inside corner or a point support the peak stress
// keeps rising as the elements shrink (a singularity of the idealised
// geometry or fixing), while the stress a short way off settles.

import { runStructural, type ConvergencePoint, type ConvergenceResult, type Progress, type StructuralInput, type StructuralResult } from "./structural";

/** element size of the first solve over that of the second */
export const REFINE = 1.5;
/** answers that move less than this between the solves count as converged; up to CLOSE as close */
export const CONVERGED = 0.05;
export const CLOSE = 0.15;

/** The answers an accuracy check compares. */
export function convergencePoint(r: StructuralResult): ConvergencePoint {
  const stress = r.maxStress.nearBoundary && r.maxStress.away ? r.maxStress.away.value : r.maxStress.value;
  const safety = r.minSafety.nearBoundary && r.minSafety.away ? r.minSafety.away.value : r.minSafety.value;
  return {
    h: r.mesh.h,
    elements: r.mesh.elements,
    disp: r.maxDisp.value,
    stress,
    peak: r.maxStress.value,
    safety,
    ...(r.thermal ? { temp: r.thermal.maxTemp.value } : {}),
    ...(r.buckling?.factors.length ? { buckling: r.buckling.factors[0] } : {}),
  };
}

/** How much the answers moved from the first solve to the second, and what that says. */
export function compareSolves(coarse: StructuralResult, fine: StructuralResult): ConvergenceResult {
  const c = convergencePoint(coarse);
  const f = convergencePoint(fine);
  const moved = (a: number, b: number, floor: number) => (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(b - a) / Math.max(Math.abs(b), floor) : 0);
  const structural = !fine.heatOnly;
  const change: ConvergenceResult["change"] = {
    disp: structural ? moved(c.disp, f.disp, 1e-9) : 0,
    stress: structural ? moved(c.stress, f.stress, 1e-6) : 0,
    // a part with next to no stress has a huge safety factor that means nothing either way
    safety: structural && f.safety < 100 && c.safety < 100 ? moved(c.safety, f.safety, 1e-6) : 0,
  };
  if (c.temp !== undefined && f.temp !== undefined && fine.thermal) {
    // the rise above the surroundings is what the elements can get wrong
    const amb = fine.thermal.ambient;
    change.temp = moved(c.temp - amb, f.temp - amb, 0.5);
  }
  if (c.buckling !== undefined && f.buckling !== undefined) change.buckling = moved(c.buckling, f.buckling, 1e-9);
  const worst = Math.max(change.disp, change.stress, change.safety, change.temp ?? 0, change.buckling ?? 0);
  const verdict = worst <= CONVERGED ? "converged" : worst <= CLOSE ? "close" : "not converged";
  const singular = structural && coarse.maxStress.nearBoundary && fine.maxStress.nearBoundary && c.peak > 0 && (f.peak - c.peak) / c.peak > 0.1;
  const limited = f.h > c.h / 1.25;
  return { coarse: c, fine: f, change, verdict, singular, limited };
}

/** Solve, solve again with smaller elements, and return the finer result with how much the answers moved. */
export function runConverged(inp: StructuralInput, progress: Progress = () => undefined): StructuralResult {
  // beams follow a frame's bending exactly with a handful of elements per member: there is nothing to refine
  if (inp.elements === "beams") {
    const r = runStructural(inp, progress);
    return { ...r, warnings: [...r.warnings, "The accuracy check is for solid elements: beams are exact for the members' bending and stretching, so it was solved once."] };
  }
  const coarse = runStructural(inp, (s, frac, info) => progress(`Accuracy check, first solve: ${s.toLowerCase()}`, 0.22 * frac, info));
  const fine = runStructural({ ...inp, h: coarse.mesh.h / REFINE }, (s, frac, info) => progress(`Accuracy check, finer solve: ${s.toLowerCase()}`, 0.22 + 0.78 * frac, info));
  const convergence = compareSolves(coarse, fine);
  const warnings = [...fine.warnings];
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  if (convergence.limited) warnings.push("The finer solve could not use much smaller elements (the model is near the size limit), so the accuracy check is weak.");
  if (convergence.verdict === "not converged") {
    const worst = Object.entries(convergence.change).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
    warnings.push(`The ${worst[0] === "disp" ? "deflection" : worst[0] === "temp" ? "temperature" : worst[0]} moved by ${pct(worst[1] ?? 0)} between the two solves, so the elements are still too large for it: use a smaller resolution: before relying on it.`);
  }
  if (convergence.singular)
    warnings.push(
      `The peak stress at a support or load rose by ${pct((convergence.fine.peak - convergence.coarse.peak) / convergence.coarse.peak)} with smaller elements: it is a singularity of the idealised fixing and would keep rising. Judge the part by the stress a short way off (${Math.round(convergence.fine.stress * 10) / 10} MPa).`,
    );
  return { ...fine, warnings, convergence };
}
