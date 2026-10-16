// Analysis set-ups as the evaluator produces them from `analysis` blocks:
// plain, serialisable descriptions that the solver worker and the
// drivetrain calculator consume. Units: mm, N, MPa, N·mm, rpm, hours.

import type { Span } from "../lang/ast";

export type V3 = [number, number, number];

/** Where a load or support acts. Zones are grown by about one element so they always catch the voxel surface. */
export type RegionSpec =
  | { t: "face"; part: string; dir: V3 }
  | { t: "sphere"; at: V3; r: number }
  | { t: "box"; at: V3; size: V3 }
  | { t: "cyl"; at: V3; axis: V3; d: number; length: number };

export interface SupportSpec {
  region: RegionSpec;
  /** undefined: held in every direction; otherwise held along this axis only (a roller or sliding support) */
  dir?: V3;
}

export type LoadSpec =
  /** total force in N spread evenly over the region's surface */
  | { t: "force"; region: RegionSpec; f: V3 }
  /** pressure in MPa pushing into the region's surface */
  | { t: "pressure"; region: RegionSpec; p: number }
  /** torque in N·mm about an axis through a point (default: the centre of the loaded surface) */
  | { t: "torque"; region: RegionSpec; torque: number; axis: V3; at?: V3 };

export type Resolution = "draft" | "standard" | "fine" | { h: number };

export interface StructuralSpec {
  kind: "structural";
  label: string;
  /** part and component block names analysed together (bonded where they touch) */
  parts: string[];
  supports: SupportSpec[];
  loads: LoadSpec[];
  /** body acceleration in g (gravity: (0, 0, -1)) */
  accel?: V3;
  /** replaces the parts' own material */
  material?: string;
  /** required minimum factor of safety */
  safety: number;
  /** stiffness limit in mm */
  maxDeflection?: number;
  /** load cycles in service: above about 1000 the fatigue strength is used */
  cycles?: number;
  /** FDM print: weaker between layers stacked along buildDir */
  printed?: boolean;
  buildDir: V3;
  resolution: Resolution;
  span: Span;
}

export interface DrivetrainSpec {
  kind: "drivetrain";
  label: string;
  /** the component that drives the train */
  drive: string;
  /** input torque in N·mm */
  torque: number;
  /** input speed in rpm */
  speed: number;
  /** target bearing life in hours */
  life?: number;
  safety: number;
  span: Span;
}

export type AnalysisSpec = StructuralSpec | DrivetrainSpec;

export const RESOLUTION_TARGET: Record<"draft" | "standard" | "fine", number> = {
  draft: 8_000,
  standard: 30_000,
  fine: 110_000,
};

export function describeRegion(r: RegionSpec): string {
  const p = (v: V3) => `(${v.map((x) => Math.round(x * 100) / 100).join(", ")})`;
  const d = (v: V3) => {
    const names = ["X", "Y", "Z"];
    const k = v.findIndex((x) => Math.abs(Math.abs(x) - 1) < 1e-6);
    if (k >= 0 && v.filter((x) => Math.abs(x) > 1e-6).length === 1) return (v[k] < 0 ? "-" : "+") + names[k];
    return p(v);
  };
  switch (r.t) {
    case "face":
      return `${r.part} ${d(r.dir)} face`;
    case "sphere":
      return `zone r ${r.r} mm at ${p(r.at)}`;
    case "box":
      return `zone ${r.size.join("×")} mm at ${p(r.at)}`;
    case "cyl":
      return `zone ⌀${r.d} mm along ${d(r.axis)} at ${p(r.at)}`;
  }
}
