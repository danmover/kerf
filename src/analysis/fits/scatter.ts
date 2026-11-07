// How far real parts come out from their drawn sizes, process by process.
// A made part's diameter is the drawn size plus a systematic bias plus
// normal scatter; a bought part sits somewhere inside its standard
// tolerance band. The numbers follow common calibration experience
// (FDM holes print small and pins print large, by more when the hole lies
// on its side; parts shrink as they cool), ISO 492 for bearings, ISO 965
// (6g) for screw threads and ISO 286 for bought shafts, pins and bores.
// They describe a typical, decently tuned machine, not the best one.

import type { EvalPart, Model } from "../../core/model";
import type { ProcessId } from "../../mfg/types";
import { PROCESSES } from "../../mfg/profiles";
import { vdot, vnorm, type V3 } from "../../kernel/recipe";
import { isPrinted } from "../../library/materials";
import { materialRecord } from "../../library/materialDb";
import { fitLimits } from "../../drawing/spec";
import { copySource } from "../../drawing/copies";
import type { Cyl } from "./geometry";

/**
 * A size distribution: drawn size + bias + N(0, sigma), or uniform in [lo, hi] for bought parts.
 * `common` is a further normal spread shared by every part of the same material in one build
 * (how much that batch of plastic shrinks in that room), so a printed pin in a printed hole of the
 * same plastic shrinks along with it.
 */
export type Scatter = { kind: "normal"; mean: number; sigma: number; common?: number } | { kind: "uniform"; lo: number; hi: number };

export interface Source {
  /** how the part is made, or "bought" */
  how: ProcessId | "bought" | "unknown";
  /** label for messages: "FDM print", "CNC mill", "bought" */
  label: string;
  material: string;
}

/** Linear shrinkage of FDM prints as they cool, as a fraction (slicers do not compensate by default). */
const FDM_SHRINK: Record<string, number> = {
  PLA: 0.003,
  PETG: 0.004,
  ABS: 0.007,
  ASA: 0.006,
  Nylon: 0.012,
  "Nylon CF": 0.004,
  "PETG CF": 0.003,
  PC: 0.006,
  TPU: 0.005,
  PP: 0.015,
};

export function fdmShrink(material: string): number {
  return FDM_SHRINK[material] ?? 0.005;
}

/** How a part is made: its process, else bought for library parts, else a guess from the material. */
export function sourceOf(p: EvalPart): Source {
  if (p.kind === "component") return { how: "bought", label: "bought", material: p.material };
  if (p.process) return { how: p.process.id, label: PROCESSES[p.process.id].short, material: p.material };
  if (isPrinted(p.material)) return { how: "fdm", label: "FDM print (assumed from the material)", material: p.material };
  if (materialRecord(p.material)?.category === "metal") return { how: "cnc_mill", label: "machined (assumed from the material)", material: p.material };
  return { how: "unknown", label: "no process given", material: p.material };
}

/** True when the slicer cancels the part's mean shrink. */
export function shrinkCompensated(p: EvalPart): boolean {
  return fdmSettings(p).shrinkComp;
}

/** FDM settings of a part: layer height, build direction in the part's frame, and the slicer's size compensation. */
function fdmSettings(p: EvalPart): { layer: number; build: V3; holeComp: number; shrinkComp: boolean } {
  const s = p.process?.settings ?? {};
  const layer = typeof s.layer === "number" ? s.layer : 0.2;
  const build = Array.isArray(s.build) && typeof s.build[0] === "number" ? vnorm(s.build as V3) : ([0, 0, 1] as V3);
  return { layer, build, holeComp: typeof s.hole_comp === "number" ? s.hole_comp : 0, shrinkComp: s.shrink_comp === true };
}

/** True when an FDM hole or pin lies on its side (axis across the build direction), so its circle is built from layers. */
export function onItsSide(c: Cyl): boolean {
  if (c.part.kind !== "part") return false;
  const { build } = fdmSettings(c.part);
  return Math.abs(vdot(vnorm(c.axisLocal), build)) < 0.7;
}

// ISO 492 normal class: outer ring 0/−x and bore 0/−x in µm by size
const BEARING_OD: [number, number][] = [
  [18, 8],
  [30, 9],
  [50, 11],
  [80, 13],
  [120, 15],
  [150, 18],
  [Infinity, 25],
];
const BEARING_BORE: [number, number][] = [
  [10, 8],
  [18, 8],
  [30, 10],
  [50, 12],
  [80, 15],
  [Infinity, 20],
];
const band = (t: [number, number][], d: number) => (t.find(([hi]) => d <= hi) ?? t[t.length - 1])[1] / 1000;

/** Bought round features: bearings, screws, pins, motor bosses, shafts and bores. */
function boughtScatter(c: Cyl): Scatter {
  const d = c.d;
  switch (c.role) {
    case "bearing-od":
      return { kind: "uniform", lo: d - band(BEARING_OD, d), hi: d };
    case "bearing-bore":
      return { kind: "uniform", lo: d - band(BEARING_BORE, d), hi: d };
    case "screw": {
      // ISO 965 6g major diameter: es about −0.02, tolerance about 0.024 d + 0.035
      const es = 0.018 + 0.0015 * d;
      return { kind: "uniform", lo: d - es - (0.024 * d + 0.035), hi: d - es };
    }
    case "head":
      // ISO 4762 head diameter: nominal is the maximum
      return { kind: "uniform", lo: d - 0.27, hi: d };
    default:
      break;
  }
  const kind = c.part.libKind ?? "";
  if (c.side === "shaft") {
    if (kind === "dowel") {
      // ISO 8734 pins are m6: slightly over the nominal size
      const f = fitLimits("m6", d) ?? { upper: 0.012, lower: 0.004 };
      return { kind: "uniform", lo: d + f.lower, hi: d + f.upper };
    }
    if (kind === "rod" || kind === "linear_bearing") {
      const f = fitLimits("g6", d) ?? { upper: -0.005, lower: -0.014 };
      return { kind: "uniform", lo: d + f.lower, hi: d + f.upper };
    }
    const f = fitLimits("h7", d) ?? { upper: 0, lower: -0.012 - 0.0005 * d };
    return { kind: "uniform", lo: d + f.lower, hi: d + f.upper };
  }
  // bores of bought parts (gears, pulleys, couplers): H8 is typical for catalogue hubs
  const f = fitLimits("H8", d) ?? { upper: 0.018 + 0.001 * d, lower: 0 };
  return { kind: "uniform", lo: d + f.lower, hi: d + f.upper };
}

/**
 * A tolerance the part's drawing calls on this diameter, as (lower, upper) deviations in mm:
 * `diameter(at, 8, fit: "k6")` or `tol: (0.02, 0)` on a drawing of the part. That is how a press
 * or close fit is asked for while the model stays at the nominal size.
 */
export function calledTolerance(model: Model, c: Cyl): [number, number] | null {
  // a part copied from another with shape_of() is made to that part's drawing
  const src = copySource(c.part);
  const shows = (n: string) => n === c.part.name || (!!src && JSON.stringify(model.parts.find((q) => q.name === n)?.recipe) === src);
  for (const dr of model.drawings ?? []) {
    if (dr.of.length && !dr.of.some(shows)) continue;
    for (const dim of dr.dims) {
      if (dim.kind !== "diameter" || dim.d === undefined || Math.abs(dim.d - c.d) > 0.01) continue;
      if (dim.tol) return [Math.min(dim.tol[0], dim.tol[1]), Math.max(dim.tol[0], dim.tol[1])];
      const f = dim.fit ? fitLimits(dim.fit, c.d) : null;
      if (f) return [f.lower, f.upper];
    }
  }
  return null;
}

/** As-made diameter distribution of one round feature; `called` is a tolerance from its drawing, which the maker holds. */
export function diameterScatter(c: Cyl, src: Source, called?: [number, number] | null): Scatter {
  if (src.how === "bought") return boughtScatter(c);
  if (called) return { kind: "normal", mean: c.d + (called[0] + called[1]) / 2, sigma: Math.max(0.001, (called[1] - called[0]) / 6) };
  const d = c.d;
  const hole = c.side === "hole";
  switch (src.how) {
    case "fdm": {
      const { layer, holeComp, shrinkComp } = fdmSettings(c.part);
      const side = onItsSide(c);
      const shrink = fdmShrink(src.material) * d;
      const meanShrink = shrinkComp ? 0 : shrink;
      // holes close up: the inner perimeter is squashed inwards, facets cut the circle, the ring shrinks as it cools;
      // pins grow by the outer perimeter's squash and shrink with the part. A circle built from layers steps and sags.
      // The slicer can open holes (hole_comp, on radius) and scale the part to cancel the mean shrink (shrink_comp).
      const bias = hole ? -(0.12 + meanShrink) + 2 * holeComp - (side ? 0.6 * layer : 0) : 0.08 - meanShrink + (side ? 0.3 * layer : 0);
      // a slicer tuned to cancel this plastic's shrink leaves less of the batch-to-batch spread
      return { kind: "normal", mean: d + bias, sigma: Math.hypot(0.035 + 0.0004 * d, 0.15 * shrink, side ? 0.03 : 0), common: (shrinkComp ? 0.12 : 0.25) * shrink };
    }
    case "sla":
      return { kind: "normal", mean: d + (hole ? -0.06 - 0.001 * d : 0.04), sigma: 0.025 + 0.001 * d };
    case "sls":
    case "metal_print":
      // loose powder sinters onto every surface: holes small, pins large
      return { kind: "normal", mean: d + (hole ? -0.12 - 0.002 * d : 0.08), sigma: 0.05 + 0.002 * d };
    case "cnc_mill":
    case "cnc_lathe": {
      // a drilled clearance hole cuts a little over size; bored and turned diameters are held close
      const drilled = hole && (c.holeFit === "clearance" || c.holeFit === "close");
      if (drilled) return { kind: "normal", mean: d + 0.05, sigma: 0.02 };
      return { kind: "normal", mean: d + (hole ? 0.01 : -0.005), sigma: 0.007 + 0.00005 * d };
    }
    case "injection":
      return { kind: "normal", mean: d, sigma: 0.015 + 0.0015 * d };
    case "vacuum_cast":
      return { kind: "normal", mean: d, sigma: 0.05 + 0.003 * d };
    case "die_cast":
      return { kind: "normal", mean: d, sigma: 0.03 + 0.002 * d };
    case "investment_cast":
      return { kind: "normal", mean: d, sigma: 0.06 + 0.003 * d };
    case "sand_cast":
      return { kind: "normal", mean: d, sigma: 0.3 + 0.004 * d };
    case "laser_cut":
      return { kind: "normal", mean: d + (hole ? 0.03 : -0.03), sigma: 0.04 + 0.0005 * d };
    case "sheet_metal":
      return { kind: "normal", mean: d, sigma: 0.05 + 0.001 * d };
    default:
      return { kind: "normal", mean: d, sigma: 0.05 + 0.001 * d };
  }
}

/** Scatter of a feature's position relative to another on the same part, `dist` mm away (σ, mm, per axis). */
export function positionSigma(src: Source, dist: number): number {
  switch (src.how) {
    case "fdm":
      return 0.02 + 0.0004 * dist;
    case "sla":
      return 0.02 + 0.0004 * dist;
    case "sls":
    case "metal_print":
      return 0.05 + 0.001 * dist;
    case "cnc_mill":
    case "cnc_lathe":
      return 0.008 + 0.00002 * dist;
    case "injection":
    case "die_cast":
      return 0.015 + 0.0008 * dist;
    case "laser_cut":
    case "sheet_metal":
      return 0.03 + 0.0002 * dist;
    case "bought":
      return 0.015 + 0.0002 * dist;
    case "investment_cast":
    case "vacuum_cast":
      return 0.05 + 0.002 * dist;
    case "sand_cast":
      return 0.25 + 0.004 * dist;
    default:
      return 0.05 + 0.001 * dist;
  }
}

/** Mean and spread of the scale a part comes out at (1 = true size): FDM parts shrink as they cool. `common` is shared by parts of one material. */
export function scaleScatter(src: Source, p?: EvalPart): { mean: number; sigma: number; common?: number } {
  if (src.how === "fdm") {
    const s = fdmShrink(src.material);
    // shrink varies with the batch and the room (shared by parts of one plastic) and with each part's shape; steps per mm are off by about 0.1 %
    return { mean: p && fdmSettings(p).shrinkComp ? 1 : 1 - s, sigma: Math.hypot(0.15 * s, 0.001), common: 0.25 * s };
  }
  if (src.how === "sls") return { mean: 1, sigma: 0.0015 };
  if (src.how === "injection") return { mean: 1, sigma: 0.0008 };
  return { mean: 1, sigma: 0.0002 };
}

/** Thermal expansion of a material, per °C. */
export function expansion(material: string): number {
  return (materialRecord(material)?.cte ?? 23) * 1e-6;
}

/** Plain words for a distribution: "Ø22.45 ± 0.12 mm (FDM print)". */
export function describeScatter(s: Scatter): { mean: number; spread: number } {
  return s.kind === "normal" ? { mean: s.mean, spread: 3 * Math.hypot(s.sigma, s.common ?? 0) } : { mean: (s.lo + s.hi) / 2, spread: (s.hi - s.lo) / 2 };
}
