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
  | { t: "cyl"; at: V3; axis: V3; d: number; length: number }
  /** the outermost surface of the analysed parts along a direction (what hits the floor first) */
  | { t: "extreme"; dir: V3 };

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

/** A mass the parts carry that is not modelled as a solid (a motor, a battery, a payload), spread over a region. */
export interface MassSpec {
  region: RegionSpec;
  grams: number;
}

/** A frequency the design is shaken at, in Hz: one speed, or a band it runs through. */
export interface Excitation {
  lo: number;
  hi: number;
  label: string;
}

export interface ModalSpec {
  /** how many natural frequencies to find */
  modes: number;
  excite: Excitation[];
  /** damping ratio (0.02: bolted frames and printed parts) */
  damping: number;
  /** printer moves: acceleration in mm/s² that sets the frame ringing after each move */
  ringing?: number;
}

/** A floor: stiff ones by their elastic modulus, soft ones by how much they give per area. */
export interface FloorSpec {
  name: string;
  /** MPa */
  E?: number;
  /** soft floors: N/mm of give per mm² of contact */
  soft?: number;
}

export interface DropSpec {
  /** fall height in mm (for a tip-over, worked out from the shape) */
  height?: number;
  /** it tips over toward dir instead of falling */
  tip?: boolean;
  /** the way it moves into the floor: -Z lands flat on its bottom, (1, 0, -1) on an edge */
  dir: V3;
  floor: FloorSpec;
}

export const FLOORS: Record<string, FloorSpec> = {
  concrete: { name: "concrete", E: 30000 },
  tile: { name: "tiles", E: 50000 },
  steel: { name: "steel", E: 200000 },
  wood: { name: "a wooden floor or table", E: 10000 },
  carpet: { name: "carpet", soft: 0.05 },
  grass: { name: "grass", soft: 0.02 },
};

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
  /** extra masses (mass(region, 350g)): weight under gravity and in drops, inertia in vibration */
  masses?: MassSpec[];
  /** natural frequencies instead of (or as well as) a static load */
  modal?: ModalSpec;
  /** a drop, knock or tip-over instead of a static load */
  drop?: DropSpec;
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

/** the smallest element size accepted from resolution:, in mm */
export const MIN_ELEMENT_SIZE = 0.1;

/** above this relative residual a solve is not trusted to pass or fail anything */
export const UNRELIABLE_RESIDUAL = 1e-3;

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
    case "extreme":
      return `the side that lands first (${d(r.dir)})`;
  }
}
