// Analysis set-ups as the evaluator produces them from `analysis` blocks:
// plain, serialisable descriptions that the solver worker and the
// drivetrain calculator consume. Units: mm, N, MPa, N·mm, rpm, hours.

import type { Span } from "../lang/ast";
import type { Finish, LoadCycle, MeanStress } from "./fe/fatigue";

export type V3 = [number, number, number];

/** Where a load or support acts. Zones are grown by about one element so they always catch the voxel surface. */
export type RegionSpec =
  | { t: "face"; part: string; dir: V3 }
  | ({ t: "sphere"; at: V3; r: number } & Within)
  | ({ t: "box"; at: V3; size: V3 } & Within)
  | ({ t: "cyl"; at: V3; axis: V3; d: number; length: number } & Within)
  /** the outermost surface of the analysed parts along a direction (what hits the floor first) */
  | { t: "extreme"; dir: V3 };

/** A zone kept to the part of it inside another zone (a curved seat that stops short of the necks beside it). */
export interface Within {
  within?: Extract<RegionSpec, { t: "sphere" | "box" | "cyl" }>;
}

export interface SupportSpec {
  region: RegionSpec;
  /** undefined: held in every direction; otherwise held along this axis only (a roller or sliding support); a spring's direction */
  dir?: V3;
  /** a seat only pressed on (by bands, springs or weight), not bonded: the solve checks it stays pressed and does not slide or turn */
  contact?: ContactSpec;
  /**
   * An elastic support instead of a rigid one: rubber feet, a soft mount, the flex of what it bolts to. rate: the
   * springs' total stiffness, N/mm, spread over the region by area (every way, or along dir); perArea: stiffness per
   * mm² of surface, N/mm³, pressing along the surface's normal (a pad: its modulus over its thickness).
   */
  spring?: { rate?: number; perArea?: number };
  /**
   * A pin through a bore (or a bushing round a shaft), the region a cylinder zone: held across the pin and, unless
   * slide, along it, free to turn about it. It bears only where the loads press the bore onto it unless tight.
   */
  pin?: { slide: boolean; tight: boolean };
  /** a set displacement, mm: the region is moved this far and held there (along dir only, when dir is given) */
  move?: V3;
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
  | { t: "torque"; region: RegionSpec; torque: number; axis: V3; at?: V3 }
  /**
   * a force in N pushed onto a bore by what turns in it (or onto a shaft by its bearing), the region a cylinder zone:
   * spread over the half it presses on with a cosine, none at the sides; a share along the axis is spread evenly
   */
  | { t: "bearing"; region: RegionSpec; f: V3 };

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

/** Heat made inside the design: through a part's volume (part:) or over a region of its surface, in watts. */
export interface HeatLoadSpec {
  /** a part or component block name: every instance of it makes this heat, spread through its volume */
  part?: string;
  /** one placed instance (EvalPart.id), for heat worked out per component ("fans#2") */
  id?: string;
  region?: RegionSpec;
  watts: number;
  /** what to call it, and where the number came from */
  label: string;
  why?: string;
}

/**
 * Current through conducting parts (a busbar, a heater element, a battery strap): it goes in over one region and out
 * over another, and makes heat wherever it flows (Joule heating, I²R), worked out from the parts' shape and resistivity,
 * which rises as they warm. Either the current through (amps) or the voltage across (volts) is given.
 */
export interface CurrentSpec {
  from: RegionSpec;
  to: RegionSpec;
  /** A through it */
  amps?: number;
  /** V across it */
  volts?: number;
  label: string;
}

/** A surface held at a temperature: a heated bed, a chilled plate, a hot engine block it bolts to. */
export interface FixedTempSpec {
  region: RegionSpec;
  /** °C */
  temp: number;
}

/** Cooling on part of the surface: a film coefficient and the temperature of what flows past it. */
export interface FilmSpec {
  region: RegionSpec;
  /** W/(m²·K) */
  h: number;
  /** a named cooling ("fan"): its convection alone, used instead of h when emissivity: works out radiation on its own */
  conv?: number;
  /** °C; unset: the analysis's ambient */
  ambient?: number;
}

/**
 * A heat analysis: where heat is made (watts), how the surface is cooled, and any surfaces held at a temperature.
 * Solved by conduction through the parts on the same voxel grid as the stress analysis; with fix: as well, the
 * temperatures then load the structure (thermal stress) and soften hot plastics.
 */
export interface ThermalSpec {
  heat: HeatLoadSpec[];
  /** current through conductors, whose Joule heat adds to the heat made */
  currents?: CurrentSpec[];
  /** heat: "auto": every electronic part's loss at its working current, from the machine's power budget */
  auto: boolean;
  fixed: FixedTempSpec[];
  /** film coefficient on every surface no film() covers, W/(m²·K) */
  cooling: number;
  /** what that cooling is, for messages */
  coolingText: string;
  films: FilmSpec[];
  /** the surrounding air, °C; unset: the brief's hottest service temperature, else 25 °C */
  ambient?: number;
  /** where the ambient came from, when the runtime filled it in */
  ambientWhy?: string;
  /** surface emissivity: radiation is then worked out on its own (cooling: is convection only) */
  emissivity?: number;
  /** warm-up over this long, s (a transient run); unset: the steady state it settles at */
  time?: number;
  /** temperature everything starts at, °C (default: ambient) */
  start?: number;
  /** highest allowed temperature for every part, °C (default: each material's long-use limit) */
  maxTemp?: number;
}

/**
 * Fatigue: how the loads repeat over the part's life. The loads as written are the peak; each counted cycle runs
 * between a min and a max scale of them. Judged against each material's S-N curve after a mean-stress correction,
 * with the damage added up by Miner's rule.
 */
export interface FatigueSpec {
  /** the counted cycles of one pass of the history (constant amplitude: one kind, counted cycles: times) */
  cycles: LoadCycle[];
  /** how many times the history happens in the part's life (constant amplitude: 1) */
  repeats: number;
  /** what the life is counted in */
  unit: "cycles" | "repeats";
  /** how the loads repeat, in words: "fully reversed", "on-off (0 to peak)", "R = 0.2", "a history of 3 load blocks" */
  loading: string;
  meanStress: MeanStress;
  /** surface finish for every part; unset: from how each part is made (machined, cast, printed...) */
  finish?: Finish;
  /** chance of lasting the life (0.5 = the mean S-N curve) */
  reliability: number;
  /** where the cycles came from */
  source: "constant" | "blocks" | "trace";
  /** a trace as written (load scales), for showing it */
  trace?: number[];
}

/** Linear (eigenvalue) buckling: how many times the loads it takes to buckle the parts, and the shapes they buckle in. */
export interface BucklingSpec {
  modes: number;
  /** required lowest buckling factor; buckling is sensitive to small imperfections, so this is larger than a strength safety factor */
  safety: number;
}

/**
 * Two analysed parts that touch, as a contact instead of glued: pressed together they bear on each other, pulled
 * apart they part (unless lift is false), and along the faces they slide once friction lets go.
 */
export interface TouchSpec {
  a: string;
  b: string;
  /** found by the analysis (the parts a tightened bolt clamps), not written: no warning when they do not touch */
  auto?: boolean;
  /** friction coefficient (0 slides freely); rough never slides; glued keeps the pair bonded (an exception to "all") */
  mu: number | "rough" | "glued";
  /** false: the faces may slide but never come apart (something not analysed holds them together) */
  lift: boolean;
}

/** touching: how analysed parts that touch meet, instead of glued where they touch. */
export interface TouchingSpec {
  pairs: TouchSpec[];
  /** touching: "all": every other pair that touches, except fasteners, nuts and inserts (they stay glued) */
  all?: { mu: number | "rough"; lift: boolean };
}

/** How a contact between two parts fared. */
/**
 * Bolts tightened before the loads, by part name: to a tension (N), by a torque on the thread (N·mm), or (neither) as
 * such a bolt usually is; all: every other fastener in the analysis.
 */
export interface PreloadSpec {
  bolts: { part: string; force?: number; torque?: number }[];
  all?: { force?: number; torque?: number };
}

/** A tightened bolt: what it was tightened to, and what it carries under the loads. */
export interface BoltResult {
  part: string;
  size: string;
  grade?: string;
  /** the tension it is tightened to, N, and how that was chosen */
  preload: number;
  why: string;
  /** the tension in it under the loads, N */
  force: number;
  /** its tensile stress area (mm²), the stress there under the loads (MPa), and its proof load (N) */
  area: number;
  stress: number;
  proof: number;
  /** the free length stretched between its head and where its thread holds, mm */
  grip: number;
  /** what its thread holds in, and whether that is plastic, wood or an insert in them */
  into: string;
  soft: boolean;
  /** the parts it clamps */
  clamps: string[];
}

export interface TouchResult {
  a: string;
  b: string;
  mu: number | "rough";
  lift: boolean;
  /** found by touching: "all" */
  auto: boolean;
  /** area of the faces in touch, mm² */
  area: number;
  /** shares of that area pressed together, come apart, and sliding along each other */
  pressed: number;
  open: number;
  sliding: number;
  /** total force pressing the faces together, N, and the shear force along them, N */
  force: number;
  shear: number;
  /** highest contact pressure, MPa, and where */
  peak: { value: number; at: V3 };
  /** widest gap where they came apart and longest slide, mm */
  gap: number;
  slip: number;
  /** elements in the contact layer, solves it took, and whether what presses, parts and slides settled */
  cells: number;
  rounds: number;
  settled: boolean;
  /** held together for the answer, as nothing else holds them: they come right apart, or slide away */
  held?: "apart" | "slides";
  /** one element thick where they touch: the stress there is rough */
  thin?: boolean;
}

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
  /** fatigue over the part's life: set when cycles: passes 1000, or a load history or the way the loads repeat is given */
  fatigue?: FatigueSpec;
  /**
   * FDM print: true treats every plastic part as printed, false none; unset, the parts with an fdm process or a filament
   * material are. Each printed part gets walls, skins and infill from its process and is weaker and softer across its layers.
   */
  printed?: boolean;
  /** the way the layers stack, for every printed part; unset (buildGiven false) each part's own way on the bed */
  buildDir: V3;
  buildGiven?: boolean;
  resolution: Resolution;
  /** extra masses (mass(region, 350g)): weight under gravity and in drops, inertia in vibration */
  masses?: MassSpec[];
  /** natural frequencies instead of (or as well as) a static load */
  modal?: ModalSpec;
  /** a drop, knock or tip-over instead of a static load */
  drop?: DropSpec;
  /** heat: temperatures from heat loads and cooling; with supports, they load the structure too */
  thermal?: ThermalSpec;
  /** the whole model at this temperature, °C: thermal expansion against the supports without a heat solve */
  uniformTemp?: number;
  /** the temperature it was made and assembled at, where it has no thermal stress, °C */
  refTemp?: number;
  /** linear buckling: load factors and buckled shapes */
  buckling?: BucklingSpec;
  /** solve twice, the second time with smaller elements, and report how much the answers moved */
  converge?: boolean;
  /** topology optimisation: find the stiffest shape for these loads that keeps a share of the parts' material */
  topology?: TopologySpec;
  /** touching parts as contacts (pressed, parting, sliding) instead of glued */
  touching?: TouchingSpec;
  /** bolts tightened before the loads */
  preload?: PreloadSpec;
  span: Span;
}

/**
 * Topology optimisation (topology: 30%): the shape, cut from the analysed parts, that is stiffest under the loads and
 * supports for the share of their material kept. It runs on demand, and its result is that shape, checked.
 */
export interface TopologySpec {
  /** share of the material to keep, 0–1 */
  keep: number;
  /** regions kept solid beyond where the parts are held and loaded (bosses round holes, mounting faces) */
  preserve: RegionSpec[];
  /** analysed parts kept as they are (in the analysis, not reshaped) */
  preserveParts: string[];
  /** the thinnest member it may leave, mm (unset: about three elements) */
  minMember?: number;
  /** mirror planes through the middle of the parts, by the axis across them */
  symmetry: ("X" | "Y" | "Z")[];
  /** extrusion: the same profile all the way through along this axis, to cut from plate (laser, waterjet, 2-axis milling) */
  cut?: "X" | "Y" | "Z";
  /** most design iterations (default 80) */
  iterations?: number;
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

/** A standard rider on a bike, sat on its saddle with hands on the bars: the position sets the frontal area. */
export type RiderPosition = "drops" | "hoods" | "tops" | "tt" | "upright";

/**
 * Air flowing past the design: drag, side force and lift at each yaw angle, the drag area (CdA), the power it costs,
 * and the flow itself, from a lattice-Boltzmann LES on the GPU.
 */
export interface AirflowSpec {
  kind: "airflow";
  label: string;
  /** air speed past the design, mm/s; at a yaw angle the road speed is this × cos yaw */
  speed: number;
  /** parts in the air; empty: every part shown */
  parts: string[];
  /** the way the design travels, and up */
  forward: V3;
  up: V3;
  /** yaw angles, degrees; positive: the wind comes from the right-hand side */
  yaw: number[];
  /** a rolling road under it (wheels turn with it) */
  ground: boolean;
  /** the parts that roll on the road (they and what turns with them spin); unset: found from the parts' own motion */
  wheels?: string[];
  rider?: { position: RiderPosition; height: number; saddle?: string; bars?: string; bb?: string };
  resolution: Resolution;
  /** air density, kg/m³, and kinematic viscosity, m²/s */
  density: number;
  nu: number;
  /** limits that make check items: drag area m², drag N, power W, lift N (negative: downforce wanted) */
  maxCda?: number;
  maxDrag?: number;
  maxWatts?: number;
  maxLift?: number;
  /** stop after this long, seconds */
  time?: number;
  span: Span;
}

/** A parameter a design study varies, between these values. */
export interface StudyVariable {
  /** the param's name */
  name: string;
  min: number;
  max: number;
  /** values snap to multiples of this from min (whole numbers for a count) */
  step?: number;
}

/** What a design study's answer is judged by: a measured or analysed value to make as small or as large as it can. */
export type StudyMeasure = "mass" | "safety" | "deflection" | "stress" | "frequency" | "temperature" | "buckling";

export interface StudyGoal {
  sense: "min" | "max";
  what: StudyMeasure;
  /** mass of one part (default every made part); the analysis a result comes from (default the worst of those it solves) */
  of?: string;
  text: string;
}

/** A limit every design the study picks must meet, beyond the analyses' own targets and the design's checks. */
export interface StudyLimit {
  what: StudyMeasure;
  op: "<=" | ">=";
  value: number;
  of?: string;
  text: string;
}

/**
 * A design study: vary parameters within their ranges, build and check each design, solve the analyses that cover
 * the parts they change, and find the best one that still passes: the lightest bracket that is strong enough, the
 * stiffest frame for its mass. Run on demand (it builds many designs), never on every edit.
 */
export interface StudySpec {
  kind: "study";
  label: string;
  vary: StudyVariable[];
  goal: StudyGoal;
  limits: StudyLimit[];
  /** the structural analyses solved for every design; unset: those covering parts the parameters change */
  using?: string[];
  /** the most designs it may build, the current one included */
  runs: number;
  span: Span;
}

export type AnalysisSpec = StructuralSpec | DrivetrainSpec | UciSpec | AirflowSpec | StudySpec;

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
      return `zone r ${n(r.r)} mm at ${p(r.at)}${r.within ? `, within the ${describeRegion(r.within)}` : ""}`;
    case "box":
      return `zone ${r.size.map(n).join("×")} mm at ${p(r.at)}${r.within ? `, within the ${describeRegion(r.within)}` : ""}`;
    case "cyl":
      return `zone ⌀${n(r.d)} mm along ${d(r.axis)} at ${p(r.at)}${r.within ? `, within the ${describeRegion(r.within)}` : ""}`;
    case "extreme":
      return `the side that lands first (${d(r.dir)})`;
  }
}
