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
  /** a seat only pressed on (by bands, springs or weight), not bonded: the solve checks it stays pressed and does not slide or turn */
  contact?: ContactSpec;
}

export interface ContactSpec {
  /** friction of the seat on what it rests against */
  mu: number;
  /** the way the seat faces, out of the part; face regions use their own direction and a cylinder zone faces away from its axis */
  normal?: V3;
  /** bands round the same tube that grip it too: the sliding force (N) and twisting moment about the tube (N·mm) their friction holds */
  grip?: { force: number; moment: number; names: string[] };
}

/** How a contact seat fared: what presses it, how much of it would lift, and what friction must hold. */
export interface ContactResult {
  /** net force pressing the seat on, N (negative: pulled off) */
  pressing: number;
  /** how far the centre of pressure sits off the seat's middle, as a share of its half-width: above 1/3 an edge starts to unload, from 1 it tips over */
  lift: number;
  /** the edge that unloads */
  liftAt?: V3;
  /** the force sliding the seat along its surface (along the tube for a cylinder zone), N, and what friction holds */
  slide: number;
  slideCap: number;
  /** the moment turning it about the seat's normal (about the tube for a cylinder zone), N·mm, and what friction holds */
  twist: number;
  twistCap: number;
  /** slide/slideCap + twist/twistCap: above 1 it slips */
  use: number;
}

export type LoadSpec =
  /** total force in N spread evenly over the region's surface; from: where it really acts, off the analysed parts (a torque after it carries its moment in) */
  | { t: "force"; region: RegionSpec; f: V3; from?: V3 }
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

/** A bicycle checked against the UCI's technical rules for road racing: which parts are the wheels, saddle and bars, and where the bottom bracket is. */
export interface UciSpec {
  kind: "uci";
  label: string;
  rules: "road";
  /** the bottom bracket axle: a point, or a part turning about it (the crankset) */
  bb: { at?: V3; part?: string };
  wheels: string[];
  saddle: string;
  bars: string;
  /** the two brake levers, for the spacing between the hoods */
  hoods?: string[];
  /** the way the bike rides */
  forward: V3;
  /** what is weighed and measured (default: every part shown) */
  parts?: string[];
  /** rim depth in mm, when given */
  rimDepth?: number;
  span: Span;
}

export type AnalysisSpec = StructuralSpec | DrivetrainSpec | UciSpec;

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
  const n = (x: number) => Math.round(x * 100) / 100;
  const p = (v: V3) => `(${v.map(n).join(", ")})`;
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
      return `zone r ${n(r.r)} mm at ${p(r.at)}`;
    case "box":
      return `zone ${r.size.map(n).join("×")} mm at ${p(r.at)}`;
    case "cyl":
      return `zone ⌀${n(r.d)} mm along ${d(r.axis)} at ${p(r.at)}`;
    case "extreme":
      return `the side that lands first (${d(r.dir)})`;
  }
}
