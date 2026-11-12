// Linear static stress analysis of one or more parts: voxel mesh, supports
// and loads, multigrid solve, then stresses recovered at the nodes and
// sampled back onto the real CAD surface for display. Environment-agnostic
// so it runs in the analysis worker and in Node tests.

import { CORNERS, constitutive, principal, vonMises, elementMatrices, elementMatricesFor, layeredConstitutive, type ElementMatrices } from "./element";
import { infillStiffness, infillStrength, layerStiffness, type InfillPattern } from "../../mfg/infill";
import { applyK, buildHierarchy, coarseningPlan, makeLevel, pcg, restiffen, withFine, type Hierarchy, type NodeSprings } from "./solver";
import { AXES, frictionStress, holdLoose, OPEN, OPEN_E, SLIP_G, STICK, touchLayer, touchResults, touchStates, type TouchLayer } from "./touching";
import { boltLayout, boltStress, type BoltInfo, type BoltWant } from "./bolts";
import { jacobiEigen } from "./dense";
import { meshBounds, meshVolume, voxelizeMesh, type TriMesh, type V3 } from "./voxel";
import { sampleInterior, type ResultVolume } from "./volume";
import { joulePower, solveCurrent, type CurrentGrid, type CurrentSolve } from "./electric";
import { rhoAt, type ElectricMaterial } from "../electricMaterials";
import { amps, ohms } from "../thermalSummary";
export type { ResultVolume } from "./volume";
import type { BoltResult, ContactResult, FloorSpec, LoadSpec, MassSpec, RegionSpec, SupportSpec, TopologySpec, TouchingSpec, TouchResult } from "../spec";
import { isoSurface, optimise, profileLoops, smoothSurface, surfaceStats, TopologyError, type Loop, type TopologyRun } from "./topology";
import { lowestModes } from "./modal";
import { describeRegion, MIN_ELEMENT_SIZE, UNRELIABLE_RESIDUAL } from "../spec";
import { allowableStress, type MechMaterial } from "../materials";
import { COMPONENT_THERMAL, strengthAt, type ThermalMaterial } from "../thermalMaterials";
import { activeNodes, heatBalance, solveSteady, solveTransient, type HeatGrid, type HeatSolve, type ThermalInput } from "./thermal";
import { bucklingModes } from "./buckling";
import { corotate, elementFrame, internalForce, largeEffect, maxTurn, solveLarge, turnVoigt } from "./large";
import { runBeams, type BeamMember, type BeamResult } from "./beams";
import { runShells, ShellFallback, type ShellPart, type ShellResult } from "./shells";
import { FINISHES, criticalStress, damageOf, damageShares, peakScale, snCurve, strengthAt as snStrengthAt, type FatigueInput, type Finish, type LoadCycle, type MeanStress, type SnCurve } from "./fatigue";

export class FeaError extends Error {}

export interface FeaPart {
  /** instance id (EvalPart.id) */
  id: string;
  /** block name in the design */
  name: string;
  /** the frame (or other group) it belongs to: face() can name the group for all of its parts */
  group?: string;
  /** a frame member, analysed as a beam when the analysis uses beam elements */
  beam?: BeamMember;
  /** a thin wall (a laminate, a sheet), analysed as a shell when the analysis uses shell elements */
  shell?: ShellPart;
  /** world-space triangle mesh */
  mesh: TriMesh;
  /** world-space vertex normals, for display */
  normals?: Float32Array;
  /** index into materials */
  material: number;
  /** printed on an FDM printer: which way its layers stack and what is solid inside it */
  print?: PartPrint;
  /** a fastener, nut or insert: stays glued under touching: "all" */
  joining?: boolean;
  /** a screw or bolt: where its head is and its size, to tighten it (preload) */
  bolt?: BoltInfo;
  /** a nut, threaded insert or standoff: what a screw's thread holds in */
  threads?: "nut" | "insert";
}

/** How a printed part is printed, as the analysis models it. */
export interface PartPrint {
  /** the way its layers stack, world frame */
  build: V3;
  /** solid walls round each layer's outline, and the solid skin under its tops and over its bottoms, mm */
  wall: number;
  skin: number;
  /** sparse infill share inside (1: solid) and its pattern */
  infill: number;
  pattern: InfillPattern;
  /** the settings in words ("4 walls, 5 top and bottom layers, 40 % gyroid infill") */
  words: string;
  /** where the build direction comes from: the analysis's build:, the part's process build:, or how it lies on the bed */
  from: "analysis" | "process" | "bed";
}

export interface StructuralInput {
  label: string;
  parts: FeaPart[];
  materials: MechMaterial[];
  supports: SupportSpec[];
  loads: LoadSpec[];
  /** body acceleration in g */
  accel?: V3;
  /** target number of active elements when h is not given */
  target: number;
  h?: number;
  printed: boolean;
  buildDir: V3;
  cycles?: number;
  safety: number;
  maxDeflection?: number;
  /** relative residual for the solve */
  tol?: number;
  /** masses the parts carry that are not modelled as solids */
  masses?: MassSpec[];
  /** find this many natural frequencies and mode shapes */
  modes?: number;
  /**
   * A drop: accel is 1 g along dir and the support is the side that lands; the result is scaled to the
   * peak deceleration the fall's energy gives against the body's and the floor's stiffness.
   */
  drop?: { height?: number; tip?: boolean; dir: V3; floor: FloorSpec };
  /** heat: solve the temperatures first; with supports they then load the structure and soften hot plastics */
  thermal?: ThermalInput;
  /** the whole model at this temperature (°C), for thermal expansion without a heat solve */
  uniformTemp?: number;
  /** the temperature with no thermal stress (made and assembled), °C; default 20 */
  refTemp?: number;
  /** thermal properties per material (same order as materials); needed with thermal or uniformTemp */
  thermalMaterials?: ThermalMaterial[];
  /** electrical properties per material (same order as materials); needed with thermal currents */
  electricMaterials?: ElectricMaterial[];
  /** linear buckling: how many buckling factors and shapes to find */
  buckling?: { modes: number };
  /** an accuracy check: solve again with smaller elements and compare (run by runConverged) */
  converge?: boolean;
  /** fatigue over the part's life: the loads as written scaled by a history, against each material's S-N curve */
  fatigue?: FatigueInput;
  /** topology optimisation: find the stiffest shape that keeps a share of the material, then analyse that shape */
  topology?: TopologySpec;
  /** touching parts as contacts that press, part and slide, instead of glued where they touch */
  touching?: TouchingSpec;
  /** bolts tightened before the loads (each part by name); the parts they clamp touch as contacts unless touching: says */
  preload?: BoltWant[];
  /**
   * large deflection: true solves with the parts free to bend and turn far (snap fits, flexures, springs), false keeps
   * the small-deflection answer, unset switches it on when that answer turns a part more than LARGE_TURN
   */
  large?: boolean;
  /**
   * "beams": every part is a frame member (FeaPart.beam), solved as beams through its joints; "shells": every part is
   * a thin wall (FeaPart.shell), solved as shells on its surface
   */
  elements?: "beams" | "shells";
  /** the element type was chosen, not asked for: a part that turns out not to be one wall falls back to solids */
  elementsAuto?: boolean;
  /** warnings the input step found (a carbon layup solved as solid), put in front of the result's own */
  inputWarnings?: string[];
}

/** The large-deflection solve: how far the parts turned, and how it went. */
export interface LargeResult {
  /** switched on because the small-deflection answer turned a part more than LARGE_TURN (not asked for) */
  auto: boolean;
  converged: boolean;
  /** the share of the loads it balanced */
  reached: number;
  steps: number;
  newton: number;
  iterations: number;
  /** the most any part of the model turns, degrees, and how far the small-deflection answer had it turn */
  turn: number;
  linearTurn: number;
  /** the small-deflection answer's largest deflection, mm, to compare */
  linearDisp: number;
  ms: number;
  why?: string;
}

/** Topology optimisation: the shape found, against the parts it was cut from. */
export interface TopologyResult {
  /** share of the material asked to keep, and of the shape found */
  keep: number;
  kept: number;
  /** grams: the parts as designed, and the shape found */
  massBefore: number;
  massAfter: number;
  /** the shape's stiffness under these loads as a share of the parts as designed (their compliance over its) */
  stiffness: number;
  iterations: number;
  converged: boolean;
  /** per iteration: compliance (N·mm), share of the material in use, largest change of a density, solver iterations */
  history: { compliance: number; volume: number; change: number; solver: number }[];
  /** the thinnest member it was set to leave, mm */
  minMember: number;
  /** openings through the shape, and its separate pieces */
  openings: number;
  pieces: number;
  /** share of the material kept solid where the parts are held and loaded (and by preserve:) */
  preserved: number;
  symmetry: string[];
  cut?: string;
  /** bits too thin or cut off from the supports that the final shape leaves out, share of the material */
  trimmed: number;
  /** with cut:, the profile to cut from plate: closed outlines in the plane across the cut axis, and the plate's span along it */
  outline?: { axis: "X" | "Y" | "Z"; plane: ["X" | "Y" | "Z", "X" | "Y" | "Z"]; from: number; to: number; loops: Loop[] };
  ms: number;
  /** of which solving, the energies and updating the design, ms */
  time: { solve: number; energy: number; update: number };
}

/** The shape so far, while a topology optimisation runs. */
export interface TopologyPreview {
  positions: Float32Array;
  indices: Uint32Array;
  iteration: number;
  /** share of the material in use */
  volume: number;
}

/** Fatigue: the life and safety factor of every point under the load history, against each material's S-N curve. */
export interface FatigueResult {
  /** what the life is counted in, and the life asked for */
  unit: "cycles" | "repeats";
  design: number;
  /** how the loads repeat, in words */
  loading: string;
  meanStress: MeanStress;
  /** the counted cycles of one pass of the history, largest range first */
  cycles: LoadCycle[];
  repeats: number;
  /** the largest scale of the loads in the history (the static check is at this) */
  peak: number;
  /** the lowest fatigue safety factor: the factor on the loads at which the damage over the design life reaches 1 */
  minSafety: SafetyAt & { nearBoundary: boolean; away: SafetyAt | null };
  /** the shortest life (in unit), at the weakest point; Infinity below the endurance limit */
  life: Located;
  /** Miner's damage at the weakest point over the design life (1 = it breaks at the end of it) */
  damage: number;
  /** at the point with the shortest life: the share of its damage each kind of cycle does (largest first) */
  shares: { cycle: LoadCycle; share: number }[];
  /** the S-N curve used for each material, after the surface and reliability factors */
  curves: { material: string; finish: Finish; finishText: string; ka: number; ke: number; su: number; s3: number; se: number; tail: "flat" | "falling"; equivalent: "signed von Mises" | "signed largest principal stress" | "the pull across the layers"; layers?: boolean }[];
  reliability: number;
}

/** Temperatures from a heat analysis. */
export interface ThermalResult {
  /** surroundings, °C */
  ambient: number;
  ambientWhy?: string;
  cooling: string;
  maxTemp: Located & { part: string };
  minTemp: Located;
  /** hottest point of each part (by block name), against its limit */
  parts: { name: string; max: number; mean: number; at: V3; limit: number; limitWhy: string; material: string; assumed: boolean }[];
  /** the heat made, where it was made and what made it */
  sources: { label: string; watts: number; why?: string }[];
  /** in a steady state, where the heat goes, W */
  balance: { made: number; film: number; radiation: number; held: number } | null;
  /** a warm-up over time: the hottest temperature (overall and per part) after each step */
  transient?: {
    time: number;
    start: number;
    times: number[];
    max: number[];
    parts: { name: string; max: number[] }[];
    /** where it would settle if it ran on (null: no way for the heat to leave, it keeps heating) */
    settles: number | null;
    /** the first part to pass its limit and when, s */
    overLimit: { part: string; time: number } | null;
  };
  hotSpots: { at: V3; temp: number; part: string }[];
  solve: { iterations: number; residual: number; converged: boolean; ms: number };
  /** thermal stress: the temperature the parts carry no thermal stress at */
  refTemp?: number;
  /** current through conductors (current() in heat:): what each did, at the temperatures they settle at */
  currents?: CurrentResult[];
  /** where the current runs densest, A/mm², over all of them together, and the typical density (the median where it runs) */
  currentPeak?: Located & { part: string; typical: number };
}

/** One current() through the parts: resistance, voltage, power and where it goes. */
export interface CurrentResult {
  label: string;
  /** where it goes in and comes out, in words */
  from: string;
  to: string;
  /** at the temperatures the parts settle at: A through, V across, Ω, and the heat it makes (I²R), W */
  amps: number;
  volts: number;
  ohms: number;
  watts: number;
  /** the same at 20 °C, before it warms */
  cold: { amps: number; volts: number; ohms: number; watts: number };
  /** given: the current through it, or the voltage across it */
  driven: "amps" | "volts";
  /** the parts it heats, with their share of its heat */
  parts: { name: string; share: number }[];
}

/** Linear buckling: factors on the loads at which the parts buckle. */
export interface BucklingResult {
  /** load factors from the lowest up (only those that buckle under the loads as given) */
  factors: number[];
  /** where each buckled shape moves most */
  peaks: V3[];
  /** the lowest factor if the loads were reversed, when one was found */
  reversed: number | null;
  iterations: number;
  converged: boolean;
  ms: number;
}

export interface ModeResult {
  /** natural frequency, Hz */
  freq: number;
  /** share of the moving mass that takes part along X, Y and Z (effective modal mass) */
  share: V3;
  /** participation factor along X, Y and Z (displacement of the largest-moving point per unit base acceleration × ω²) */
  gamma: V3;
  /** the largest-moving point and its shape amplitude (M-normalised shape, mm per √t) */
  peak: Located;
}

export interface ModalResult {
  modes: ModeResult[];
  /** moving mass, kg */
  mass: number;
  iterations: number;
  residual: number;
  converged: boolean;
  ms: number;
}

export interface DropResult {
  /** fall height used (worked out for a tip-over), mm */
  height: number;
  tip: boolean;
  /** the way it moves into the floor (for an edge or corner, from the centre of mass through the point that lands) */
  dir: V3;
  floor: string;
  /** peak deceleration of the whole body in g, peak contact force in N, impact speed in m/s, energy in J */
  g: number;
  force: number;
  speed: number;
  energy: number;
  /** how long the impact lasts, ms, and how far the contact gives, mm */
  pulseMs: number;
  squash: number;
  /** the parts' own lowest frequency for this load (Rayleigh, from the 1 g shape), Hz, and how they answer the pulse: */
  bodyHz: number;
  /** below 1 the impact is over before they can flex fully; up to about 1.8 when it lasts about as long as their swing */
  amplification: number;
  /** the g the parts are loaded with: g × amplification */
  felt: number;
  /** total weight in N and the contact's stiffness, N/mm */
  weight: number;
  contactStiffness: number;
  contact: { at: V3; area: number };
  /** centre of mass */
  com: V3;
}

/**
 * Peak response of an undamped oscillator to a half-sine pulse, relative to the same acceleration held
 * still (the shock response spectrum), for a pulse lasting tau of the oscillator's periods. About 4·tau
 * for short pulses, peaking near 1.77 at tau ≈ 0.8 and settling to 1 for long ones.
 */
export function halfSineShock(tau: number): number {
  if (!(tau > 0)) return 0;
  let beta = 1 / (2 * tau);
  if (Math.abs(1 - beta) < 1e-6) beta = 1 - 1e-6;
  // during the pulse, with a(t) = sin(Ωt), ω = 1: x(t) = (sin Ωt − β sin t) / (1 − β²), Ω = β
  const td = Math.PI / beta;
  const k = 1 / (1 - beta * beta);
  let peak = 0;
  for (let i = 1; i <= 400; i++) {
    const t = (td * i) / 400;
    peak = Math.max(peak, Math.abs(k * (Math.sin(beta * t) - beta * Math.sin(t))));
  }
  // afterwards it swings freely with the amplitude it has when the pulse ends
  const x = k * (Math.sin(beta * td) - beta * Math.sin(td));
  const v = k * (beta * Math.cos(beta * td) - beta * Math.cos(td));
  return Math.max(peak, Math.hypot(x, v));
}

export interface PartField {
  id: string;
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array;
  /** per vertex: displacement xyz (mm) */
  disp: Float32Array;
  /** per vertex: von Mises stress (MPa) */
  stress: Float32Array;
  /** per vertex: largest principal strain by magnitude (fraction) */
  strain: Float32Array;
  /** per vertex: factor of safety */
  safety: Float32Array;
  /** per mode: the mode shape at each vertex (xyz), scaled so the largest movement is 1 (buckled shapes when the analysis buckles) */
  modes?: Float32Array[];
  /** per vertex: temperature (°C), when the analysis has heat or a set temperature */
  temp?: Float32Array;
  /** per vertex: fatigue life over the design life, as log10 (0: it lasts exactly the life asked for), when the analysis has fatigue */
  life?: Float32Array;
  /** per vertex: current density (A/mm²), when the analysis has current through conductors */
  current?: Float32Array;
}

export interface Located {
  value: number;
  at: V3;
}


export interface StructuralResult {
  label: string;
  mesh: { h: number; cell: V3; grid: V3; elements: number; nodes: number; dofs: number; levels: number; partial: number };
  solve: { iterations: number; residual: number; converged: boolean; history: number[]; ms: { mesh: number; setup: number; solve: number; post: number; total: number } };
  maxDisp: Located;
  maxStress: Located & { nearBoundary: boolean; away: Located | null };
  maxStrain: Located;
  /** lowest safety factor; away: the lowest a short way from supports and loads, when the overall lowest sits on one */
  minSafety: SafetyAt & { nearBoundary: boolean; away: SafetyAt | null };
  layer: Located | null;
  hotSpots: { at: V3; stress: number; safety: number }[];
  applied: V3;
  reaction: V3;
  equilibrium: number;
  mass: number;
  volume: number;
  /** at: centroid of the loaded surface (a torque's centre for torques); vector: net force; axis: a torque's axis */
  /** pressure: for a bearing load, the peak of its cosine spread (in the middle of the side it presses), MPa */
  loads: { kind: LoadSpec["t"]; region: string; at: V3; vector: V3; magnitude: number; area: number; nodes: number; axis?: V3; pressure?: number }[];
  supports: {
    region: string;
    dir?: V3;
    at: V3;
    nodes: number;
    reaction: V3;
    markers: Float32Array;
    contact?: ContactResult;
    /** an elastic support, a pin through a bore, or a region moved a set distance (unset: fixed, a roller or a contact seat) */
    kind?: "spring" | "pin" | "move";
    /** an elastic support: its stiffness (N/mm in all, or N/mm per mm² of surface) and how far it gives on average, mm */
    spring?: { rate?: number; perArea?: number; give: number };
    /**
     * A pin: held all round (tight) or only where the loads press the bore onto it, free to slide along it or not; the
     * share of the bore that presses on it, and the bearing pressure (its force over the bore's projected area d × length).
     */
    pin?: { tight: boolean; slide: boolean; share: number; pressure: number; d: number; length: number; axis: V3; rounds: number };
    /** the set displacement, mm */
    moved?: V3;
  }[];
  gravity: { vector: V3; at: V3 } | null;
  parts: PartField[];
  /** the fields inside the parts, for a section through them */
  interior?: ResultVolume;
  ranges: { stress: [number, number]; disp: [number, number]; strain: [number, number]; safety: [number, number]; temp?: [number, number]; life?: [number, number]; current?: [number, number] };
  warnings: string[];
  materials: { name: string; E: number; yield: number; allowable: number; basis: "yield" | "fatigue"; layerFactor: number; assumed: boolean }[];
  /** printed parts: how each is printed, the share of it that is solid walls and skin, and its stiffness across its layers */
  printing?: { part: string; build: V3; from: PartPrint["from"]; words: string; solid: number; infillStiffness: number; infillStrength: number; across: number }[];
  modal?: ModalResult;
  drop?: DropResult;
  thermal?: ThermalResult;
  buckling?: BucklingResult;
  /** only temperatures were solved for (a heat analysis with no supports): the stress fields are empty */
  heatOnly?: boolean;
  /** a second, finer solve and how much the answers moved (an accuracy check) */
  convergence?: ConvergenceResult;
  /** fatigue over the design life, when the analysis has it */
  fatigue?: FatigueResult;
  /** with fatigue: the lowest safety factor against yield (and print layers) at the peak of the history, apart from fatigue */
  staticSafety?: SafetyAt & { nearBoundary: boolean; away: SafetyAt | null };
  /** topology optimisation: the parts are the shape found, and the stresses are that shape's */
  topology?: TopologyResult;
  /** touching parts as contacts: what each pair presses, parts and slides */
  touching?: TouchResult[];
  /** tightened bolts: what each was tightened to and carries under the loads */
  bolts?: BoltResult[];
  /** solved for large deflection (the parts turn as they bend): how far and how it went */
  large?: LargeResult;
  /** a frame solved as beams: each member's forces and peak stress */
  beams?: BeamResult;
  /** the walls as shells, when the analysis used shell elements */
  shells?: ShellResult;
}

/** The same analysis solved twice, the second time with smaller elements. */
export interface ConvergenceResult {
  coarse: ConvergencePoint;
  fine: ConvergencePoint;
  /** relative change of each answer from the coarse to the fine solve */
  change: { disp: number; stress: number; safety: number; temp?: number; buckling?: number };
  verdict: "converged" | "close" | "not converged";
  /** the peak sits at a support or load and keeps rising with smaller elements: a stress singularity */
  singular: boolean;
  /** the finer solve could not use smaller elements (memory limit) */
  limited: boolean;
}

export interface ConvergencePoint {
  h: number;
  elements: number;
  disp: number;
  /** peak stress a short way from supports and loads (the peak itself when it is not at one) */
  stress: number;
  peak: number;
  safety: number;
  temp?: number;
  buckling?: number;
}

export type SafetyAt = Located & {
  /** what it is judged against: yield, the strength between print layers, fatigue (in the bulk or between layers) */
  mode: "yield" | "fatigue" | "layers" | "layer fatigue";
  allowable: number;
  material: string;
  /** the temperature there, °C, when the analysis has heat (the allowable is derated for it) */
  tempC?: number;
  /** in a printed part's sparse infill, whose strength is a share of the solid's (the allowable is lowered for it) */
  infill?: boolean;
};

export type Progress = (stage: string, frac: number, info?: { iter?: number; residual?: number; preview?: TopologyPreview }) => void;

const FILL_MIN = 0.12;
/** strength of the bond between print layers in shear, as a share of its strength in tension */
const LAYER_SHEAR = 0.7;
/**
 * A pin is held by springs across its bore (and along it), this many times stiffer than a layer of the part's own
 * material one element thick: rigid enough that the pin gives about 1 % as much as the part next to it, soft enough
 * that the solver still converges quickly.
 */
const PIN_STIFF = 100;
/** rounds of the solve that finds where each pin presses on its bore */
const PIN_ROUNDS = 10;
/** most solves to settle where touching parts press, part and slide */
const TOUCH_ROUNDS = 16;
/** rounds for tightening the bolts before the loads (each tunes the prestress to the tension wanted) */
const BOLT_ROUNDS = 12;
const MAX_CELLS = 3_500_000;
/** a small-deflection answer that turns any part of the model more than this (radians, 10°) is solved again for large deflection */
export const LARGE_TURN = (10 * Math.PI) / 180;
/** past this turn (1°), one large-deflection step from the small-deflection answer checks it; a change over LARGE_EFFECT solves again */
const LARGE_LOOK = Math.PI / 180;
const LARGE_EFFECT = 0.03;
/** the large-deflection solve stops by this long after the analysis started, ms */
const LARGE_BUDGET_MS = 150_000;
/** solid elements, about three times the "fine" target: beyond this memory and time grow past what a browser tab should spend */
export const MAX_ELEMENTS = 350_000;
const G0 = 9.80665;

const FACE_CORNERS = [
  [0, 2, 4, 6],
  [1, 3, 5, 7],
  [0, 1, 4, 5],
  [2, 3, 6, 7],
  [0, 1, 2, 3],
  [4, 5, 6, 7],
];
const FACE_NORMAL: V3[] = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-12 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l];
};
const fmt = (n: number, d = 2) => String(Math.round(n * 10 ** d) / 10 ** d);
const fmtP = (p: V3) => `(${p.map((v) => fmt(v, 1)).join(", ")})`;

/**
 * A torque T shared over weighted points as a couple: each is pushed as if the points were turned rigidly about
 * their own weighted centre (f = w ω × r, with I ω = T for I their weighted inertia), so the pushes add up to
 * exactly T and nothing else: no net force and no twist about any other axis. Plain pushes round the axis would
 * also tip a zone that is not symmetric about it. null when the points have no lever arm about T (all on its line).
 */
export function shareTorque(ps: V3[], w: number[], T: V3): V3[] | null {
  const tot = w.reduce((s, v) => s + v, 0);
  if (!(tot > 0)) return null;
  const c: V3 = [0, 0, 0];
  ps.forEach((p, s) => {
    for (let d = 0; d < 3; d++) c[d] += (p[d] * w[s]) / tot;
  });
  const rs = ps.map((p): V3 => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  const I = new Float64Array(9);
  rs.forEach((r, s) => {
    const r2 = dot(r, r);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[a * 3 + b] += w[s] * ((a === b ? r2 : 0) - r[a] * r[b]);
  });
  const { values, vectors } = jacobiEigen(I, 3);
  const big = Math.max(...values, 0);
  const mag = Math.hypot(...T);
  const om: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v: V3 = [vectors[3 * k], vectors[3 * k + 1], vectors[3 * k + 2]];
    const tk = dot(v, T);
    // points on a line cannot be twisted about that line
    if (big < 1e-12 || values[k] <= 1e-9 * big) {
      if (Math.abs(tk) > 1e-6 * mag) return null;
      continue;
    }
    for (let d = 0; d < 3; d++) om[d] += (tk / values[k]) * v[d];
  }
  return rs.map((r, s): V3 => [w[s] * (om[1] * r[2] - om[2] * r[1]), w[s] * (om[2] * r[0] - om[0] * r[2]), w[s] * (om[0] * r[1] - om[1] * r[0])]);
}

/**
 * Cells per axis for the analysis grid. Cells fit the bounding box exactly, thin directions get
 * smaller cells within about 3:1 of the others, and the grid and its solid elements stay within
 * MAX_CELLS and MAX_ELEMENTS by enlarging cells (and, for very thin parts, stretching them further).
 * cells is null when even that cannot bring the model within limits.
 */
export function sizeGrid(ext: V3, volume: number, target: number, h?: number): { cells: V3 | null; raised: boolean } {
  const asked = h ?? Math.cbrt(Math.max(volume, 1e-9) / Math.max(target, 100));
  const fit = (h0: number, aspect: number): V3 => {
    const c = ext.map((e) => Math.max(1, Math.round(e / h0)));
    const small = Math.min(...ext.map((e, d) => e / c[d]));
    for (let d = 0; d < 3; d++) c[d] = Math.max(c[d], Math.ceil(ext[d] / (aspect * small) - 1e-9));
    return c as V3;
  };
  const count = (c: V3) => c[0] * c[1] * c[2];
  const active = (c: V3) => (volume * count(c)) / (ext[0] * ext[1] * ext[2]);
  let h0 = asked;
  let aspect = 3;
  let cells = fit(h0, aspect);
  if (!h) while (active(cells) > 4 * target && aspect < 40) cells = fit(h0, (aspect *= 1.5));
  const over = () => count(cells) > MAX_CELLS || active(cells) > MAX_ELEMENTS;
  if (over()) {
    // size directly from the worse of the two ratios, then nudge for rounding (bounded)
    h0 *= Math.cbrt(Math.max(count(cells) / MAX_CELLS, active(cells) / MAX_ELEMENTS));
    cells = fit(h0, aspect);
    for (let k = 0; k < 40 && over(); k++) cells = fit((h0 *= 1.05), aspect);
    // a thin part: the cell shape limit keeps the count up, so let cells stretch further
    for (let k = 0; k < 40 && over() && aspect < 200; k++) cells = fit(h0, (aspect *= 1.25));
  }
  return { cells: over() ? null : cells, raised: h0 > asked * 1.01 };
}

export function runStructural(inp: StructuralInput, progress: Progress = () => undefined): StructuralResult {
  if (!inp.parts.length) throw new FeaError("Nothing to analyse: the analysis names no parts with built geometry.");
  if (inp.inputWarnings?.length) {
    const r = runStructural({ ...inp, inputWarnings: undefined }, progress);
    return { ...r, warnings: [...inp.inputWarnings, ...r.warnings] };
  }
  if (inp.elements === "beams") {
    if (!inp.supports.length) throw new FeaError("The analysis has no supports. Add fix: to say how the frame is held, for example fix: face(stand, -Z).");
    if (!inp.loads.length && !inp.accel && !inp.supports.some((s) => s.move)) throw new FeaError("The analysis has no loads. Add load: force(...), pressure(...) or torque(...), or gravity.");
    return runBeams(inp, progress);
  }
  if (inp.elements === "shells") {
    if (!inp.supports.length) throw new FeaError("The analysis has no supports. Add fix: to say how the part is held, for example fix: face(bracket, -Z).");
    if (!inp.loads.length && !inp.accel && !inp.supports.some((s) => s.move)) throw new FeaError("The analysis has no loads. Add load: force(...), pressure(...) or torque(...), or gravity.");
    try {
      return runShells(inp, progress);
    } catch (e) {
      if (!(e instanceof ShellFallback) || !inp.elementsAuto) throw e instanceof ShellFallback ? new FeaError(`${e.message}. Use elements: "solid" to analyse it with solid elements.`) : e;
      const r = runStructural({ ...inp, elements: undefined, elementsAuto: undefined }, progress);
      return { ...r, warnings: [`${e.message}, so it was solved with solid elements.`, ...r.warnings] };
    }
  }
  const t0 = now();
  const warnings: string[] = [];
  /** temperatures only: a heat analysis with nothing holding the parts */
  const heatOnly = !!inp.thermal && !inp.supports.length;
  const temps = !!inp.thermal || inp.uniformTemp !== undefined;
  if (temps && (!inp.thermalMaterials || inp.thermalMaterials.length !== inp.materials.length)) throw new FeaError("Thermal properties are missing for the analysed materials.");
  if (!inp.supports.length && !heatOnly) throw new FeaError("The analysis has no supports. Add fix: to say how the part is held, for example fix: face(bracket, -Y).");
  const moved = inp.supports.some((s) => s.move);
  if (!heatOnly && !inp.loads.length && !inp.accel && !inp.modes && !temps && !moved) throw new FeaError("The analysis has no loads. Add load: force(...), pressure(...) or torque(...), or gravity.");
  if (inp.buckling && !inp.loads.length && !inp.accel && !temps && !moved) throw new FeaError("Buckling needs loads to scale: add load: (or gravity) to say what presses on the parts.");
  if (inp.buckling && inp.modes) throw new FeaError("Check natural frequencies and buckling in separate analyses.");
  if (inp.drop && (temps || inp.buckling)) throw new FeaError(`A drop works out its own forces from the fall; check ${temps ? "heat and temperatures" : "buckling"} in a separate analysis.`);
  if (inp.fatigue && (inp.drop || temps || inp.modes)) throw new FeaError(`Check fatigue in a separate analysis from the ${inp.drop ? "drop" : temps ? "heat and temperatures" : "natural frequencies"}.`);
  if (inp.fatigue && !inp.fatigue.cycles.length) throw new FeaError("The fatigue history has no load cycles in it.");
  if (inp.topology) {
    const other = temps ? "heat and temperatures" : inp.drop ? "a drop" : inp.modes ? "natural frequencies" : inp.buckling ? "buckling" : inp.fatigue ? "fatigue" : inp.converge ? "an accuracy check" : null;
    if (other) throw new FeaError(`Optimise the shape (topology:) in an analysis of its own, apart from ${other}; then check the shape you make from it with those.`);
    if (moved) throw new FeaError("topology: finds the stiffest shape under loads; a support that moves a set distance (displace) has no load to be stiff against. Use a force instead.");
    if (!inp.loads.length) throw new FeaError("topology: needs loads to be stiff against: add load: force(...), pressure(...) or torque(...).");
    if (!(inp.topology.keep > 0 && inp.topology.keep < 1)) throw new FeaError("topology: is the share of the material to keep, between 0 % and 100 %, like topology: 30%.");
  }
  if (inp.touching || inp.preload?.length) {
    const other = inp.modes ? "natural frequencies" : inp.drop ? "a drop" : inp.buckling ? "buckling" : inp.fatigue ? "fatigue" : inp.topology ? "topology optimisation" : null;
    if (other)
      throw new FeaError(
        inp.touching
          ? `touching: lets touching parts press, part and slide under the loads, which ${other} cannot follow: check ${other} with the parts glued, in an analysis of its own.`
          : `preload: tightens the bolts so the parts they clamp press together, part and slide, which ${other} cannot follow: check ${other} in an analysis of its own.`,
      );
  }

  // ---------- grid ----------
  // Cells fit the bounding box exactly (their size differs slightly per axis), so the outer faces of
  // prismatic parts, where supports and loads usually sit, fall on element faces instead of cutting
  // through half-filled cells. Thin directions get smaller cells, kept within about 3:1 of the others.
  const meshes = inp.parts.map((p) => p.mesh);
  const [lo, hi] = meshBounds(meshes);
  const ext: V3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  if (!ext.every((e) => Number.isFinite(e) && e > 0)) throw new FeaError("The analysed parts have no usable geometry.");
  const diag = Math.hypot(...ext);
  const volume = meshes.reduce((s, m) => s + meshVolume(m), 0);
  if (inp.h !== undefined && !(Number.isFinite(inp.h) && inp.h >= MIN_ELEMENT_SIZE)) throw new FeaError(`resolution: the element size must be at least ${MIN_ELEMENT_SIZE} mm.`);
  const { cells: cellsN, raised } = sizeGrid(ext, volume, inp.target, inp.h);
  if (!cellsN) throw new FeaError("These parts are too large and thin to analyse in one go here. Analyse fewer parts at once, or the thin part on its own.");
  const hv: V3 = [ext[0] / cellsN[0], ext[1] / cellsN[1], ext[2] / cellsN[2]];
  const [hx, hy, hz] = hv;
  const hmax = Math.max(...hv);
  /** nominal element size, for messages */
  const h = Math.cbrt(hx * hy * hz);
  if (raised) warnings.push(`${inp.h ? `Element size raised from ${fmt(inp.h)} mm to ${fmt(h)} mm` : `Elements enlarged to ${fmt(h)} mm`} to keep the model within memory (about ${MAX_ELEMENTS.toLocaleString("en")} elements at most).`);
  if (hmax / Math.min(...hv) > 4.5) warnings.push(`Elements are stretched up to ${fmt(hmax / Math.min(...hv), 0)}:1 to fit a thin part; stresses are less reliable than usual.`);
  const plan = coarseningPlan(cellsN, hv);
  const [nx, ny, nz] = plan.padded;
  const origin: V3 = [lo[0], lo[1], lo[2]];
  const NX = nx + 1,
    NY = ny + 1,
    NZ = nz + 1;
  const ne = nx * ny * nz;
  const nn = NX * NY * NZ;
  const nodePos = (n: number): V3 => {
    const i = n % NX,
      j = Math.floor(n / NX) % NY,
      k = Math.floor(n / (NX * NY));
    return [origin[0] + i * hx, origin[1] + j * hy, origin[2] + k * hz];
  };
  progress("Meshing", 0.02);

  // ---------- voxelise ----------
  const fill = new Float32Array(ne);
  const best = new Float32Array(ne);
  const owner = new Int16Array(ne).fill(-1);
  const grid = { h: hv, origin, n: [nx, ny, nz] as V3 };
  /**
   * Heat: each part's true surface area over the area of its voxel skin. A stepped voxel surface has more area than
   * the smooth one it stands for (about 1.5× on a sphere), which would overstate cooling.
   */
  const areaScale = new Float64Array(inp.parts.length).fill(1);
  inp.parts.forEach((p, pi) => {
    const f = voxelizeMesh(p.mesh, grid, 3);
    if (inp.thermal) {
      let vox = 0;
      const A = [hy * hz, hy * hz, hx * hz, hx * hz, hx * hy, hx * hy];
      for (let k = 0; k < nz; k++)
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const e = i + nx * (j + ny * k);
            if (f[e] < FILL_MIN) continue;
            const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1, k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
            for (let d = 0; d < 6; d++) if (nb[d] < 0 || f[nb[d]] < FILL_MIN) vox += A[d];
          }
      const true_ = meshArea(p.mesh);
      if (vox > 0 && true_ > 0) areaScale[pi] = Math.min(1.5, Math.max(0.25, true_ / vox));
    }
    for (let e = 0; e < ne; e++) {
      const v = f[e];
      if (v <= 0) continue;
      fill[e] += v;
      if (v > best[e]) {
        best[e] = v;
        owner[e] = pi;
      }
    }
    progress("Meshing", 0.02 + (0.18 * (pi + 1)) / inp.parts.length);
  });
  const active = new Uint8Array(ne);
  let nActive = 0;
  for (let e = 0; e < ne; e++) {
    if (fill[e] > 1) fill[e] = 1;
    if (fill[e] >= FILL_MIN) {
      active[e] = 1;
      nActive++;
    }
  }
  if (nActive < 8) throw new FeaError(`The parts are too small for ${fmt(h)} mm elements. Use a smaller element size, for example resolution: ${fmt(h / 3)}mm.`);

  // ---------- bolts tightened before the loads: each shank stands free in its hole ----------
  const boltL = inp.preload?.length
    ? boltLayout(
        { n: [nx, ny, nz], h: hv, origin, owner, active, fill },
        inp.parts.map((p) => ({ name: p.name, ...(p.bolt ? { bolt: p.bolt } : {}), ...(p.threads ? { threads: p.threads } : {}), metal: inp.materials[p.material].E >= 40000, ...(p.joining ? { joining: true } : {}) })),
        inp.preload,
      )
    : null;
  const bolts = boltL?.bolts ?? [];
  if (boltL) {
    warnings.push(...boltL.warnings);
    for (const e of boltL.freed)
      if (active[e]) {
        active[e] = 0;
        nActive--;
      }
  }
  /** each grid cell's bolt (by index), where it is a bolt's stretched free length, or −1 */
  const boltOf = bolts.length ? new Int16Array(ne).fill(-1) : null;
  bolts.forEach((b, i) => {
    for (const e of b.grip) boltOf![e] = i;
  });
  const tMesh = now();

  const eIndex = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const elemNode0 = (e: number) => {
    const i = e % nx,
      j = Math.floor(e / nx) % ny,
      k = Math.floor(e / (nx * ny));
    return i + NX * (j + NY * k);
  };
  const off = [0, 1, NX, NX + 1, NX * NY, NX * NY + 1, NX * NY + NX, NX * NY + NX + 1];

  // ---------- islands (face-connected pieces) ----------
  const island = new Int32Array(ne).fill(-1);
  const islandSize: number[] = [];
  {
    const queue = new Int32Array(nActive);
    for (let e0 = 0; e0 < ne; e0++) {
      if (!active[e0] || island[e0] >= 0) continue;
      const id = islandSize.length;
      let head = 0,
        tail = 0;
      queue[tail++] = e0;
      island[e0] = id;
      while (head < tail) {
        const e = queue[head++];
        const i = e % nx,
          j = Math.floor(e / nx) % ny,
          k = Math.floor(e / (nx * ny));
        const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1, k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
        for (const f of nb)
          if (f >= 0 && active[f] && island[f] < 0) {
            island[f] = id;
            queue[tail++] = f;
          }
      }
      islandSize.push(tail);
    }
  }

  // ---------- exposed faces ----------
  const exposed = () => {
    const fe: number[] = [];
    const fd: number[] = [];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const e = eIndex(i, j, k);
          if (!active[e]) continue;
          const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1, k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
          for (let d = 0; d < 6; d++)
            if (nb[d] < 0 || !active[nb[d]]) {
              fe.push(e);
              fd.push(d);
            }
        }
    return { fe: Int32Array.from(fe), fd: Uint8Array.from(fd) };
  };
  let faces = exposed();

  // ---------- regions ----------
  interface Sel {
    nodes: number[];
    w: number[];
    av: number[];
    area: number;
  }
  const partsByName = new Map<string, number[]>();
  // a frame's name stands for all its members in face()
  const groupsByName = new Map<string, number[]>();
  inp.parts.forEach((p, i) => {
    partsByName.set(p.name, [...(partsByName.get(p.name) ?? []), i]);
    if (p.group && p.group !== p.name) groupsByName.set(p.group, [...(groupsByName.get(p.group) ?? []), i]);
  });
  const select = (r: RegionSpec): Sel => {
    const map = new Map<number, number>();
    const sel: Sel = { nodes: [], w: [], av: [], area: 0 };
    const pad = 0.75 * hmax;
    let partSet: Set<number> | null = null;
    let maxProj = 0;
    let dir: V3 = [0, 0, 1];
    let faceTol = 0;
    let axis: V3 = [0, 0, 1];
    if (r.t === "face") {
      const idx = partsByName.get(r.part) ?? groupsByName.get(r.part);
      if (!idx) throw new FeaError(`face(${r.part}, …): "${r.part}" is not one of the analysed parts (${[...partsByName.keys()].join(", ")}).`);
      partSet = new Set(idx);
      dir = norm(r.dir);
      faceTol = 0.5 * (Math.abs(dir[0]) * hx + Math.abs(dir[1]) * hy + Math.abs(dir[2]) * hz);
      maxProj = -Infinity;
      for (const pi of idx) {
        const P = inp.parts[pi].mesh.positions;
        for (let v = 0; v < P.length; v += 3) maxProj = Math.max(maxProj, P[v] * dir[0] + P[v + 1] * dir[1] + P[v + 2] * dir[2]);
      }
    } else if (r.t === "extreme") {
      // what lands first: every analysed part's surface within reach of the furthest point along dir
      dir = norm(r.dir);
      const flat = Math.max(Math.abs(dir[0]), Math.abs(dir[1]), Math.abs(dir[2])) > 0.999;
      faceTol = flat ? 0.5 * (Math.abs(dir[0]) * hx + Math.abs(dir[1]) * hy + Math.abs(dir[2]) * hz) : 1.5 * hmax;
      maxProj = -Infinity;
      for (const p of inp.parts) {
        const P = p.mesh.positions;
        for (let v = 0; v < P.length; v += 3) maxProj = Math.max(maxProj, P[v] * dir[0] + P[v + 1] * dir[1] + P[v + 2] * dir[2]);
      }
    } else if (r.t === "cyl") axis = norm(r.axis);
    // a zone kept to where it overlaps another
    const within = r.t === "sphere" || r.t === "box" || r.t === "cyl" ? r.within : undefined;
    const inZone = (z: NonNullable<typeof within>, p: V3): boolean => {
      switch (z.t) {
        case "sphere":
          return Math.hypot(p[0] - z.at[0], p[1] - z.at[1], p[2] - z.at[2]) <= z.r + pad;
        case "box":
          return Math.abs(p[0] - z.at[0]) <= z.size[0] / 2 + pad && Math.abs(p[1] - z.at[1]) <= z.size[1] / 2 + pad && Math.abs(p[2] - z.at[2]) <= z.size[2] / 2 + pad;
        case "cyl": {
          const ax = norm(z.axis);
          const v: V3 = [p[0] - z.at[0], p[1] - z.at[1], p[2] - z.at[2]];
          const s = dot(v, ax);
          if (s < -pad || s > z.length + pad) return false;
          return Math.hypot(v[0] - s * ax[0], v[1] - s * ax[1], v[2] - s * ax[2]) <= z.d / 2 + pad;
        }
      }
    };
    const inside = (p: V3): boolean => {
      if (within && !inZone(within, p)) return false;
      switch (r.t) {
        case "face":
        case "extreme":
          return dot(p, dir) >= maxProj - faceTol;
        case "sphere":
          return Math.hypot(p[0] - r.at[0], p[1] - r.at[1], p[2] - r.at[2]) <= r.r + pad;
        case "box":
          return Math.abs(p[0] - r.at[0]) <= r.size[0] / 2 + pad && Math.abs(p[1] - r.at[1]) <= r.size[1] / 2 + pad && Math.abs(p[2] - r.at[2]) <= r.size[2] / 2 + pad;
        case "cyl": {
          const v: V3 = [p[0] - r.at[0], p[1] - r.at[1], p[2] - r.at[2]];
          const s = dot(v, axis);
          if (s < -pad || s > r.length + pad) return false;
          const rad = Math.hypot(v[0] - s * axis[0], v[1] - s * axis[1], v[2] - s * axis[2]);
          return rad <= r.d / 2 + pad;
        }
      }
    };
    // a quarter of each exposed cell face goes to each of its corners
    const quarter = [(hy * hz) / 4, (hy * hz) / 4, (hx * hz) / 4, (hx * hz) / 4, (hx * hy) / 4, (hx * hy) / 4];
    for (let f = 0; f < faces.fe.length; f++) {
      const e = faces.fe[f];
      const d = faces.fd[f];
      const q = quarter[d];
      if (partSet && !partSet.has(owner[e])) continue;
      const nrm = FACE_NORMAL[d];
      if (r.t === "face" && dot(nrm, dir) <= 0.5) continue;
      if (r.t === "extreme" && dot(nrm, dir) <= 0.2) continue;
      const n0 = elemNode0(e);
      for (const a of FACE_CORNERS[d]) {
        const n = n0 + off[a];
        if (!inside(nodePos(n))) continue;
        let s = map.get(n);
        if (s === undefined) {
          s = sel.nodes.length;
          map.set(n, s);
          sel.nodes.push(n);
          sel.w.push(0);
          sel.av.push(0, 0, 0);
        }
        sel.w[s] += q;
        sel.av[3 * s] += q * nrm[0];
        sel.av[3 * s + 1] += q * nrm[1];
        sel.av[3 * s + 2] += q * nrm[2];
        sel.area += q;
      }
    }
    return sel;
  };

  // ---------- heat only ----------
  // A heat analysis with nothing holding the parts only wants temperatures: solve them and stop here.
  if (heatOnly) return heatOnlyResult(runHeat());

  // ---------- supports and the pieces they hold ----------
  const supportSel = inp.supports.map((s, i) => {
    const sel = select(s.region);
    if (!sel.nodes.length) throw new FeaError(`Support ${i + 1} (${describeRegion(s.region)}) does not touch the part's surface. Move the zone onto the part.`);
    return sel;
  });
  const islandHeld = new Uint8Array(islandSize.length);
  const nodeIslands = (n: number, out: Set<number>) => {
    const i = n % NX,
      j = Math.floor(n / NX) % NY,
      k = Math.floor(n / (NX * NY));
    for (let dk = -1; dk <= 0; dk++)
      for (let dj = -1; dj <= 0; dj++)
        for (let di = -1; di <= 0; di++) {
          const a = i + di,
            b = j + dj,
            c = k + dk;
          if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
          const e = eIndex(a, b, c);
          if (active[e]) out.add(island[e]);
        }
  };
  for (const sel of supportSel) {
    const s = new Set<number>();
    for (const n of sel.nodes) nodeIslands(n, s);
    for (const id of s) islandHeld[id] = 1;
  }
  let loose = 0;
  let looseBig = -1;
  for (let id = 0; id < islandSize.length; id++) {
    if (islandHeld[id]) continue;
    loose += islandSize[id];
    if (looseBig < 0 || islandSize[id] > islandSize[looseBig]) looseBig = id;
  }
  if (loose > 0) {
    if (loose > 0.02 * nActive || islandSize[looseBig] > 200) {
      let c: V3 = [0, 0, 0];
      let cnt = 0;
      for (let e = 0; e < ne; e++)
        if (island[e] === looseBig) {
          const p = nodePos(elemNode0(e));
          c = [c[0] + p[0], c[1] + p[1], c[2] + p[2]];
          cnt++;
        }
      c = [c[0] / cnt + hx / 2, c[1] / cnt + hy / 2, c[2] / cnt + hz / 2];
      throw new FeaError(
        `Part of the model near ${fmtP(c)} (${islandSize[looseBig]} elements) is not connected to any support, so it would fly away. ` +
          `Either it is a separate part that needs its own support, or a wall thinner than the ${fmt(h)} mm elements cuts it off: try resolution: "fine".`,
      );
    }
    for (let e = 0; e < ne; e++)
      if (active[e] && !islandHeld[island[e]]) {
        active[e] = 0;
        nActive--;
      }
    warnings.push(`Ignored ${loose} element${loose > 1 ? "s" : ""} in small loose pieces that no support holds (thin slivers at this element size).`);
    faces = exposed();
  }

  // ---------- temperatures, for thermal stress ----------
  if (inp.thermal) {
    // the heat solve and then the stress solve share the progress bar
    const outer = progress;
    progress = (stage, frac, info) => outer(stage, stage.startsWith("Heat") ? 0.2 + 0.3 * frac : 0.5 + 0.5 * frac, info);
  }
  const heat = inp.thermal ? runHeat() : null;
  /** per node, °C: the solved temperatures, or the one set for the whole model */
  const nodeT: Float64Array | null = heat ? heat.T : inp.uniformTemp !== undefined ? new Float64Array(nn).fill(inp.uniformTemp) : null;
  /** no thermal stress at this temperature: the surroundings of a heat analysis (the stress comes from the heat it makes), else 20 °C */
  const refTemp = inp.refTemp ?? (inp.thermal ? inp.thermal.ambient : 20);
  /** per element: its temperature (the mean of its corners), and the share of its stiffness a hot plastic keeps */
  const cellT = nodeT ? new Float32Array(ne) : null;
  const kfac = new Float32Array(ne).fill(1);
  if (nodeT && cellT) {
    const tms = inp.thermalMaterials!;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const n0 = elemNode0(e);
      let s = 0;
      for (let a = 0; a < 8; a++) s += nodeT[n0 + off[a]];
      cellT[e] = s / 8;
      const tm = tms[inp.parts[owner[e]].material];
      if (tm.softens) kfac[e] = strengthAt(tm, cellT[e]);
    }
  }
  /** the strength left at a node's temperature, as a share of the room-temperature value */
  const derate = (n: number, mi: number) => (nodeT && n >= 0 ? strengthAt(inp.thermalMaterials![mi], nodeT[n]) : 1);

  // ---------- boundary conditions ----------
  const bc = new Uint8Array(3 * nn);
  /** where a support moves its region a set distance: the displacement of each dof it holds, mm */
  let uSet: Float64Array | null = null;
  /** springs to the ground that stay as they are: elastic supports, and the springs holding pins along their axis */
  const springAcc = new Map<number, Float64Array>();
  /** each support's own springs, to add up the force it carries afterwards */
  const springOf: { node: number; k: Float64Array }[][] = inp.supports.map(() => []);
  /**
   * The springs across each pin's bore, one per node: on while the bore presses on the pin (all the time for a tight
   * pin). side is +1 where the part is the shaft inside (moving out presses), −1 where it is the bore round the pin.
   */
  const pinSprings: { sup: number; node: number; rho: V3; side: number; k: number; w: number; on: boolean }[] = [];
  /** directions springs and pins hold each node along, for the check that the supports stop every rigid motion */
  const heldDirs = new Map<number, V3[]>();
  const holdAlong = (n: number, d: V3) => {
    const l = heldDirs.get(n);
    if (l) l.push(d);
    else heldDirs.set(n, [d]);
  };
  /** k·d·dᵀ as (xx, yy, zz, xy, yz, zx) */
  const outer = (k: number, d: V3) => Float64Array.of(k * d[0] * d[0], k * d[1] * d[1], k * d[2] * d[2], k * d[0] * d[1], k * d[1] * d[2], k * d[2] * d[0]);
  const addSpring = (si: number, n: number, k6: Float64Array) => {
    springOf[si].push({ node: n, k: k6 });
    const v = springAcc.get(n);
    if (v) for (let c = 0; c < 6; c++) v[c] += k6[c];
    else springAcc.set(n, Float64Array.from(k6));
  };
  /** the stiffest material round a node */
  const stiffestAt = (n: number) => {
    const i = n % NX,
      j = Math.floor(n / NX) % NY,
      k = Math.floor(n / (NX * NY));
    let E = 0;
    for (let dk = -1; dk <= 0; dk++)
      for (let dj = -1; dj <= 0; dj++)
        for (let di = -1; di <= 0; di++) {
          const a = i + di,
            b = j + dj,
            c = k + dk;
          if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
          const e = eIndex(a, b, c);
          if (active[e]) E = Math.max(E, inp.materials[inp.parts[owner[e]].material].E);
        }
    return E;
  };
  const supportInfo: StructuralResult["supports"] = [];
  inp.supports.forEach((s, i) => {
    const sel = select(s.region);
    if (!sel.nodes.length) throw new FeaError(`Support ${i + 1} (${describeRegion(s.region)}) does not touch the part's surface.`);
    let comps = [0, 1, 2];
    let dir: V3 | undefined;
    const extra: Partial<StructuralResult["supports"][number]> = {};
    const along = (what: string): [number, V3] => {
      const d = norm(s.dir!);
      const k = [0, 1, 2].reduce((a, b) => (Math.abs(d[b]) > Math.abs(d[a]) ? b : a), 0);
      if (Math.abs(Math.abs(d[k]) - 1) > 0.02) warnings.push(`Support ${i + 1}: ${what} act along X, Y or Z; ${fmtP(d)} was treated as ${"XYZ"[k]}.`);
      const a: V3 = [0, 0, 0];
      a[k] = 1;
      return [k, a];
    };
    if (s.spring) {
      // an elastic support: springs spread over the region by area, along one direction or every way
      comps = [];
      const tot = sel.w.reduce((a, b) => a + b, 0) || 1;
      const d = s.dir ? norm(s.dir) : undefined;
      if (d) dir = d;
      sel.nodes.forEach((n, q) => {
        const nrm = norm([sel.av[3 * q], sel.av[3 * q + 1], sel.av[3 * q + 2]]);
        const k = s.spring!.rate !== undefined ? (s.spring!.rate * sel.w[q]) / tot : (s.spring!.perArea ?? 0) * sel.w[q];
        if (!(k > 0)) return;
        const way = d ?? (s.spring!.rate !== undefined ? undefined : nrm);
        if (way) {
          addSpring(i, n, outer(k, way));
          holdAlong(n, way);
        } else {
          addSpring(i, n, Float64Array.of(k, k, k, 0, 0, 0));
          holdAlong(n, [1, 0, 0]);
          holdAlong(n, [0, 1, 0]);
          holdAlong(n, [0, 0, 1]);
        }
      });
      extra.kind = "spring";
      extra.spring = { ...(s.spring.rate !== undefined ? { rate: s.spring.rate } : { perArea: s.spring.perArea }), give: 0 };
    } else if (s.pin) {
      // a pin through a bore (or a bushing round a shaft): stiff springs across it at every node, and along it unless
      // it slides; nothing round it, so the part turns freely about the pin
      comps = [];
      if (s.region.t !== "cyl") throw new FeaError(`Support ${i + 1}: a pin needs a cylinder zone round the bore, like pin(zone(at: c, d: 6, axis: Y, length: 10)).`);
      const z = s.region;
      const ax = norm(z.axis);
      dir = ax;
      const rows: { n: number; q: number; rho: V3 }[] = [];
      let lean = 0;
      let sMin = Infinity,
        sMax = -Infinity;
      sel.nodes.forEach((n, q) => {
        const p = nodePos(n);
        const v: V3 = [p[0] - z.at[0], p[1] - z.at[1], p[2] - z.at[2]];
        const sa = dot(v, ax);
        const rv: V3 = [v[0] - sa * ax[0], v[1] - sa * ax[1], v[2] - sa * ax[2]];
        const rl = Math.hypot(...rv);
        const a: V3 = [sel.av[3 * q], sel.av[3 * q + 1], sel.av[3 * q + 2]];
        const al = Math.hypot(...a) || 1;
        // the flat faces either side of the bore are not on the pin
        if (rl < 1e-9 || Math.abs(dot(a, ax)) / al > 0.9) return;
        const rho: V3 = [rv[0] / rl, rv[1] / rl, rv[2] / rl];
        lean += dot(a, rho);
        rows.push({ n, q, rho });
        sMin = Math.min(sMin, sa);
        sMax = Math.max(sMax, sa);
      });
      if (!rows.length) throw new FeaError(`Support ${i + 1}: the pin zone (${describeRegion(s.region)}) finds no bore or shaft surface round its axis. Give the zone the bore's diameter and put it on the bore's axis.`);
      // the part's surface faces out of the axis on a shaft, in toward it in a bore
      const side = lean > 0 ? 1 : -1;
      const hAvg = (hx + hy + hz) / 3;
      for (const r of rows) {
        const k = (PIN_STIFF * (stiffestAt(r.n) || inp.materials[0].E) * sel.w[r.q]) / hAvg;
        pinSprings.push({ sup: i, node: r.n, rho: r.rho, side, k, w: sel.w[r.q], on: true });
        holdAlong(r.n, r.rho);
        if (!s.pin.slide) {
          addSpring(i, r.n, outer(k, ax));
          holdAlong(r.n, ax);
        }
      }
      extra.kind = "pin";
      extra.pin = { tight: s.pin.tight, slide: s.pin.slide, share: 1, pressure: 0, d: z.d, length: Math.max(sMax - sMin, Math.min(hx, hy, hz)), axis: ax, rounds: 0 };
    } else if (s.dir) {
      const [k, a] = along(s.move ? "set displacements" : "rollers");
      comps = [k];
      dir = a;
    }
    if (s.move && !s.spring && !s.pin) {
      // the region moves this far and is held there (along one axis only when a direction is given)
      const mv: V3 = s.dir ? [0, 0, 0] : [...s.move];
      if (s.dir) mv[comps[0]] = Math.hypot(...s.move) * (Math.sign(s.move[comps[0]]) || 1);
      uSet ??= new Float64Array(3 * nn);
      for (const n of sel.nodes) for (const k of comps) uSet[3 * n + k] = mv[k];
      extra.kind = "move";
      extra.moved = mv;
    }
    let c: V3 = [0, 0, 0];
    for (const n of sel.nodes) {
      for (const k of comps) bc[3 * n + k] = 1;
      const p = nodePos(n);
      c = [c[0] + p[0], c[1] + p[1], c[2] + p[2]];
    }
    const m = sel.nodes.length;
    const step = Math.max(1, Math.floor(m / 260));
    const markers: number[] = [];
    for (let q = 0; q < m; q += step) {
      const p = nodePos(sel.nodes[q]);
      // nudge the marker out along the surface normal so it sits on the voxel skin
      const a: V3 = norm([sel.av[3 * q], sel.av[3 * q + 1], sel.av[3 * q + 2]]);
      markers.push(p[0], p[1], p[2], a[0], a[1], a[2]);
    }
    supportInfo.push({ region: describeRegion(s.region), dir, at: [c[0] / m, c[1] / m, c[2] / m], nodes: m, reaction: [0, 0, 0], markers: Float32Array.from(markers), ...extra });
  });
  // every spring as the solver takes it: one 3×3 per node, the pins' springs across their bores added while they press
  const springNodes = [...new Set([...springAcc.keys(), ...pinSprings.map((p) => p.node)])].sort((a, b) => a - b);
  const springAt = new Map(springNodes.map((n, q) => [n, q]));
  const springs: NodeSprings | null = springNodes.length ? { node: Int32Array.from(springNodes), k: new Float64Array(6 * springNodes.length) } : null;
  const assembleSprings = () => {
    if (!springs) return;
    springs.k.fill(0);
    for (const [n, v] of springAcc) {
      const o = 6 * springAt.get(n)!;
      for (let c = 0; c < 6; c++) springs.k[o + c] += v[c];
    }
    for (const p of pinSprings) {
      if (!p.on) continue;
      const o = 6 * springAt.get(p.node)!;
      const v = outer(p.k, p.rho);
      for (let c = 0; c < 6; c++) springs.k[o + c] += v[c];
    }
  };
  assembleSprings();

  // ---------- loads ----------
  const f = new Float64Array(3 * nn);
  const loadInfo: StructuralResult["loads"] = [];
  const loadNodes: number[] = [];
  inp.loads.forEach((ld, i) => {
    const sel = select(ld.region);
    if (!sel.nodes.length) throw new FeaError(`Load ${i + 1} (${ld.t} on ${describeRegion(ld.region)}) does not touch the part's surface. Move the zone onto the part.`);
    const tot = sel.w.reduce((s, v) => s + v, 0);
    let R: V3 = [0, 0, 0];
    let c: V3 = [0, 0, 0];
    sel.nodes.forEach((n, s) => {
      const p = nodePos(n);
      c = [c[0] + p[0] * sel.w[s], c[1] + p[1] * sel.w[s], c[2] + p[2] * sel.w[s]];
      loadNodes.push(n);
    });
    c = [c[0] / tot, c[1] / tot, c[2] / tot];
    if (ld.t === "force") {
      sel.nodes.forEach((n, s) => {
        const k = sel.w[s] / tot;
        for (let d = 0; d < 3; d++) f[3 * n + d] += ld.f[d] * k;
      });
      R = [...ld.f] as V3;
    } else if (ld.t === "pressure") {
      sel.nodes.forEach((n, s) => {
        for (let d = 0; d < 3; d++) {
          const v = -ld.p * sel.av[3 * s + d];
          f[3 * n + d] += v;
          R[d] += v;
        }
      });
    } else if (ld.t === "bearing") {
      // what turns in a bore (or a bushing round a shaft) presses on the side it is pushed toward, hardest in the middle
      // and not at all at the sides: a cosine spread over that half, pushing straight into the surface. A share along
      // the axis (a thrust) is spread evenly.
      if (ld.region.t !== "cyl") throw new FeaError(`Load ${i + 1}: a bearing load needs a cylinder zone round the bore or shaft, like bearing(zone(at: c, d: 22, axis: Y, length: 7), 300N, dir: -Z).`);
      const z = ld.region;
      const ax = norm(z.axis);
      const fa = dot(ld.f, ax);
      const fr: V3 = [ld.f[0] - fa * ax[0], ld.f[1] - fa * ax[1], ld.f[2] - fa * ax[2]];
      const frL = Math.hypot(...fr);
      const rows: { n: number; q: number; rho: V3 }[] = [];
      let lean = 0;
      let sMin = Infinity,
        sMax = -Infinity;
      sel.nodes.forEach((n, q) => {
        const p = nodePos(n);
        const v: V3 = [p[0] - z.at[0], p[1] - z.at[1], p[2] - z.at[2]];
        const sa = dot(v, ax);
        const rv: V3 = [v[0] - sa * ax[0], v[1] - sa * ax[1], v[2] - sa * ax[2]];
        const rl = Math.hypot(...rv);
        const a: V3 = [sel.av[3 * q], sel.av[3 * q + 1], sel.av[3 * q + 2]];
        const al = Math.hypot(...a) || 1;
        if (rl < 1e-9 || Math.abs(dot(a, ax)) / al > 0.9) return;
        const rho: V3 = [rv[0] / rl, rv[1] / rl, rv[2] / rl];
        lean += dot(a, rho);
        rows.push({ n, q, rho });
        sMin = Math.min(sMin, sa);
        sMax = Math.max(sMax, sa);
      });
      if (!rows.length) throw new FeaError(`Load ${i + 1}: the bearing zone (${describeRegion(ld.region)}) finds no bore or shaft surface round its axis. Give the zone the bore's diameter and put it on the bore's axis.`);
      // the surface's outward normal: away from the axis on a shaft, toward it in a bore
      const side = lean > 0 ? 1 : -1;
      let peak = 0;
      let loadedArea = 0;
      if (frL > 1e-12) {
        const fd: V3 = [fr[0] / frL, fr[1] / frL, fr[2] / frL];
        // the load presses where the surface faces against it: cos θ = −n·f̂
        const cosOf = rows.map((r) => Math.max(0, -side * dot(r.rho, fd)));
        let sum = 0;
        rows.forEach((r, j) => (sum += sel.w[r.q] * cosOf[j] * cosOf[j]));
        if (!(sum > 0)) throw new FeaError(`Load ${i + 1}: the bearing zone has no surface facing the load. Check the zone's axis and the load's direction.`);
        peak = frL / sum;
        const got: V3 = [0, 0, 0];
        let wsum = 0;
        rows.forEach((r, j) => {
          const c = cosOf[j];
          if (!c) return;
          // pressure peak·cos θ over the node's area, straight into the surface (−n)
          const k = peak * sel.w[r.q] * c;
          for (let d = 0; d < 3; d++) {
            const v = -side * r.rho[d] * k;
            f[3 * r.n + d] += v;
            got[d] += v;
          }
          wsum += sel.w[r.q] * c;
          loadedArea += sel.w[r.q];
        });
        // the stepped surface leaves a little off the total: share the rest out like the load
        const miss: V3 = [fr[0] - got[0], fr[1] - got[1], fr[2] - got[2]];
        rows.forEach((r, j) => {
          const c = cosOf[j];
          if (!c) return;
          for (let d = 0; d < 3; d++) f[3 * r.n + d] += (miss[d] * sel.w[r.q] * c) / wsum;
        });
      }
      if (Math.abs(fa) > 1e-12) sel.nodes.forEach((n, q) => {
        for (let d = 0; d < 3; d++) f[3 * n + d] += (fa * ax[d] * sel.w[q]) / tot;
      });
      R = [...ld.f] as V3;
      // the peak of a cosine spread over half the cylinder, 4F / (π·d·L), from the true bore rather than its stepped voxel skin
      const len = Math.max(sMax - sMin, Math.min(hx, hy, hz));
      const pressure = peak > 0 ? (4 * frL) / (Math.PI * z.d * len) : 0;
      loadInfo.push({ kind: "bearing", region: describeRegion(ld.region), at: c, vector: R, magnitude: Math.hypot(...R), area: loadedArea || sel.area, nodes: sel.nodes.length, axis: ax, pressure });
      return;
    } else {
      const ax = norm(ld.axis);
      const pushes = shareTorque(sel.nodes.map(nodePos), sel.w, [ld.torque * ax[0], ld.torque * ax[1], ld.torque * ax[2]]);
      if (!pushes) throw new FeaError(`Load ${i + 1}: the torque zone sits on its own axis, so it has no lever arm. Put the zone on a surface away from the axis (for example a bore or a flange).`);
      sel.nodes.forEach((n, s) => {
        for (let d = 0; d < 3; d++) {
          f[3 * n + d] += pushes[s][d];
          R[d] += pushes[s][d];
        }
      });
    }
    if (ld.t === "torque") loadInfo.push({ kind: ld.t, region: describeRegion(ld.region), at: ld.at ?? c, vector: R, magnitude: Math.abs(ld.torque), area: sel.area, nodes: sel.nodes.length, axis: norm(ld.torque < 0 ? [-ld.axis[0], -ld.axis[1], -ld.axis[2]] : ld.axis) });
    else loadInfo.push({ kind: ld.t, region: describeRegion(ld.region), at: c, vector: R, magnitude: Math.hypot(...R), area: sel.area, nodes: sel.nodes.length });
  });

  // ---------- printed parts: solid walls and skins round a sparse infill ----------
  // A part printed on an FDM printer is solid only in its walls (round every layer's outline) and its skins (under
  // tops, over bottoms); inside, the infill is a lattice with a share of the solid's stiffness and strength. Without
  // print settings per part, printed: and build: of the analysis make every part solid and layered (as before).
  const legacyPrint = inp.printed && !inp.parts.some((p) => p.print);
  const prints: (PartPrint | null)[] = inp.parts.map(
    (p) => p.print ?? (legacyPrint ? { build: norm(inp.buildDir), wall: 0, skin: 0, infill: 1, pattern: "gyroid", words: "solid", from: "analysis" } : null),
  );
  const anyLayered = prints.some((pp, i) => pp && inp.materials[inp.parts[i].material].layerFactor < 1);
  /** per element: the share of it that is solid wall or skin, and of the solid's stiffness, strength and mass it has (1 outside printed parts) */
  const solidShare = new Float32Array(ne).fill(1);
  const kPrint = new Float32Array(ne).fill(1);
  const sPrint = new Float32Array(ne).fill(1);
  const mPrint = new Float32Array(ne).fill(1);
  prints.forEach((pp, pi) => {
    // a shape being optimised has no walls yet: it is taken as solid, to print solid (or with enough walls to fill it)
    if (!pp || pp.infill >= 0.999 || inp.topology) return;
    const share = shellShare(pi, pp);
    const kI = infillStiffness(pp.infill, pp.pattern),
      sI = infillStrength(pp.infill, pp.pattern);
    for (let e = 0; e < ne; e++) {
      if (!active[e] || owner[e] !== pi) continue;
      const sh = share[e];
      solidShare[e] = sh;
      kPrint[e] = sh + (1 - sh) * kI;
      sPrint[e] = sh + (1 - sh) * sI;
      mPrint[e] = sh + (1 - sh) * pp.infill;
    }
  });

  // ---------- materials ----------
  const matOf = (e: number) => inp.parts[owner[e]].material;
  const matCount = new Array(inp.materials.length).fill(0);
  let mass = 0;
  let solidVolume = 0;
  for (let e = 0; e < ne; e++) {
    if (!active[e]) continue;
    matCount[matOf(e)]++;
    const v = fill[e] * hx * hy * hz;
    solidVolume += v;
    mass += (v / 1000) * inp.materials[matOf(e)].density * mPrint[e];
  }
  // ---------- carried masses (kg per node) ----------
  const extra = new Float64Array(nn);
  let extraKg = 0;
  (inp.masses ?? []).forEach((ms, i) => {
    const sel = select(ms.region);
    if (!sel.nodes.length) throw new FeaError(`Mass ${i + 1} (${fmt(ms.grams, 0)} g on ${describeRegion(ms.region)}) does not touch the part's surface. Move the zone onto the part.`);
    const tot = sel.w.reduce((a, b) => a + b, 0) || 1;
    sel.nodes.forEach((n, q) => (extra[n] += (ms.grams / 1000) * (sel.w[q] / tot)));
    extraKg += ms.grams / 1000;
  });
  mass += extraKg * 1000;
  const mainMat = matCount.indexOf(Math.max(...matCount));
  const nu = inp.materials[mainMat].nu;
  if (new Set(inp.materials.map((m) => m.nu)).size > 1 && matCount.filter((c) => c > 0).length > 1) warnings.push("Mixed materials share one Poisson's ratio in this model; stiffness and stress are still per material.");

  // an edge or corner drop decelerates along the line from the centre of mass through the point that
  // lands (how drop tests set up a corner drop); otherwise the held patch would have to stop it turning
  let dropDir: V3 | undefined;
  if (inp.drop && !inp.drop.tip && inp.drop.dir.filter((x) => Math.abs(x) > 1e-6).length > 1) {
    let c: V3 = [0, 0, 0];
    let mt = 0;
    const add = (m: number, p: V3) => {
      c = [c[0] + m * p[0], c[1] + m * p[1], c[2] + m * p[2]];
      mt += m;
    };
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const p = nodePos(elemNode0(e));
      add(fill[e] * mPrint[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-6, [p[0] + hx / 2, p[1] + hy / 2, p[2] + hz / 2]);
    }
    for (let n = 0; n < nn; n++) if (extra[n]) add(extra[n], nodePos(n));
    const at = supportInfo[0].at;
    const com: V3 = [c[0] / mt, c[1] / mt, c[2] / mt];
    const d: V3 = [at[0] - com[0], at[1] - com[1], at[2] - com[2]];
    const l = Math.hypot(...d);
    if (l > 1e-9 && dot(d, norm(inp.drop.dir)) > 0) dropDir = [d[0] / l, d[1] / l, d[2] / l];
  }
  let gravity: StructuralResult["gravity"] = null;
  if (inp.accel && Math.hypot(...inp.accel) > 0) {
    const a = dropDir ?? inp.accel;
    let c: V3 = [0, 0, 0];
    let mtot = 0;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const m = fill[e] * mPrint[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-6; // kg
      const n0 = elemNode0(e);
      for (let q = 0; q < 8; q++) {
        const n = n0 + off[q];
        for (let d = 0; d < 3; d++) f[3 * n + d] += (m * a[d] * G0) / 8;
      }
      const p = nodePos(n0);
      c = [c[0] + m * (p[0] + hx / 2), c[1] + m * (p[1] + hy / 2), c[2] + m * (p[2] + hz / 2)];
      mtot += m;
    }
    for (let n = 0; n < nn; n++) {
      const m = extra[n];
      if (!m) continue;
      for (let d = 0; d < 3; d++) f[3 * n + d] += m * a[d] * G0;
      const p = nodePos(n);
      c = [c[0] + m * p[0], c[1] + m * p[1], c[2] + m * p[2]];
      mtot += m;
    }
    gravity = { vector: [mtot * a[0] * G0, mtot * a[1] * G0, mtot * a[2] * G0], at: [c[0] / mtot, c[1] / mtot, c[2] / mtot] };
  }
  const applied: V3 = [0, 0, 0];
  for (let n = 0; n < nn; n++) for (let d = 0; d < 3; d++) applied[d] += f[3 * n + d];

  // ---------- thermal expansion against the supports ----------
  // Each element's thermal strain α·ΔT is uniform (from its corners' mean temperature), so the incompatible modes
  // stay exactly condensed: the load is f = E·fill·α·ΔT·Σ_g T_gᵀ·D·(1, 1, 1, 0, 0, 0)·V/8 and the stress afterwards
  // E·D·(T_g·u − ε_th). The loads of each element add up to nothing, so applied (the outside loads) is unchanged.
  const em = elementMatrices(nu, hx, hy, hz);
  // printed plastics are stiffer along their layers than across them: the solid walls and skins of each printed part
  // get an element of their own, turned to its build direction (its infill stays isotropic)
  const classMats: ElementMatrices[] = [];
  const cls = new Uint8Array(ne);
  {
    const keys = new Map<string, number>();
    prints.forEach((pp, pi) => {
      if (!pp) return;
      const { rE, rG } = layerStiffness(inp.materials[inp.parts[pi].material]);
      if (rE >= 0.999 && rG >= 0.999) return;
      const b = norm(pp.build);
      const key = `${nu}|${rE.toFixed(3)}|${rG.toFixed(3)}|${b.map((x) => x.toFixed(4)).join(",")}`;
      let c = keys.get(key);
      if (c === undefined) {
        if (classMats.length >= 15) return;
        classMats.push(elementMatricesFor(layeredConstitutive(nu, rE, rG, b), key, nu, hx, hy, hz));
        c = classMats.length;
        keys.set(key, c);
      }
      for (let e = 0; e < ne; e++) if (active[e] && owner[e] === pi && solidShare[e] >= 0.5) cls[e] = c;
    });
  }
  /** the element matrices an element uses */
  const emOf = (e: number): ElementMatrices => (cls[e] ? classMats[cls[e] - 1] : em);
  const thermalStrain = (e: number) => (cellT ? inp.thermalMaterials![matOf(e)].alpha * (cellT[e] - refTemp) : 0);
  const detJ = (hx * hy * hz) / 8;
  const thvOf = new Map<ElementMatrices, Float64Array>();
  /** an element's thermal load for a unit E·α·ΔT: Σ_g T_gᵀ·D·(1, 1, 1, 0, 0, 0)·V/8 */
  const thermalLoad = (m: ElementMatrices) => {
    let thv = thvOf.get(m);
    if (thv) return thv;
    const dv = new Float64Array(6);
    for (let r = 0; r < 6; r++) dv[r] = m.D[r * 6] + m.D[r * 6 + 1] + m.D[r * 6 + 2];
    thv = new Float64Array(24);
    for (const T of m.strainGauss)
      for (let j = 0; j < 24; j++) {
        let s = 0;
        for (let r = 0; r < 6; r++) s += T[r * 24 + j] * dv[r];
        thv[j] += detJ * s;
      }
    thvOf.set(m, thv);
    return thv;
  };
  if (cellT) {
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const eth = thermalStrain(e);
      if (!eth) continue;
      const thv = thermalLoad(emOf(e));
      const c = inp.materials[matOf(e)].E * kfac[e] * kPrint[e] * fill[e] * eth;
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++) {
        const d = 3 * (n0 + off[a]);
        f[d] += c * thv[3 * a];
        f[d + 1] += c * thv[3 * a + 1];
        f[d + 2] += c * thv[3 * a + 2];
      }
    }
  }

  // ---------- rigid-body check per held piece ----------
  checkHeld();

  // ---------- touching parts: contacts that press, part and slide instead of glued ----------
  // the parts tightened bolts clamp touch as contacts too, so the loads can part and slide them (with the friction
  // touching: "all" gives, μ 0.3 otherwise; a pair touching: names keeps what it says)
  const boltPairs: TouchingSpec["pairs"] = [];
  {
    const have = new Set<string>();
    const named = (a: string, c: string) => inp.touching?.pairs.some((t) => (t.a === a && t.b === c) || (t.a === c && t.b === a));
    for (const b of bolts)
      for (const p of b.clamps)
        for (const q of b.clamps) {
          const a = inp.parts[p].name,
            c = inp.parts[q].name;
          if (a >= c || have.has(`${a}|${c}`) || named(a, c)) continue;
          have.add(`${a}|${c}`);
          boltPairs.push({ a, b: c, mu: inp.touching?.all?.mu ?? 0.3, lift: inp.touching?.all?.lift ?? true, auto: true });
        }
  }
  const touchSpec: TouchingSpec | undefined = boltPairs.length ? { ...(inp.touching ?? {}), pairs: [...(inp.touching?.pairs ?? []), ...boltPairs] } : inp.touching;
  const touch: TouchLayer | null = touchSpec ? touchLayer({ n: [nx, ny, nz], h: hv, origin, owner, active }, inp.parts.map((p) => ({ name: p.name, joining: p.joining })), touchSpec) : null;
  if (touch) warnings.push(...touch.warnings);
  const touchOn = !!touch && touch.cells.length > 0;
  /** each grid cell's index in the contact layer, or −1 */
  const layerIx = touchOn ? new Int32Array(ne).fill(-1) : null;
  if (touch && layerIx) touch.cells.forEach((e, c) => (layerIx[e] = c));
  /** each layer cell's own element class (stuck), and the sliding and parted ones by the way it faces */
  const cls0 = touchOn ? Uint8Array.from(cls) : cls;
  const touchCls = new Map<string, number>();
  /**
   * The element of a layer cell that is not stuck: sliding (bears across the faces, not along them), apart (only its
   * own material along the faces), a ring cell sliding (bears only across the faces) or a ring cell apart (empty).
   */
  const touchClass = (axis: number, kind: "slide" | "apart" | "ring" | "void") => {
    const k = kind === "void" ? kind : `${kind}|${axis}`;
    let c = touchCls.get(k);
    if (c === undefined) {
      const ax = AXES[axis];
      let D: Float64Array;
      if (kind === "void") D = constitutive(nu).map((v) => v * OPEN_E);
      else if (kind === "ring") D = layeredConstitutive(0, 1 / OPEN_E, SLIP_G / OPEN_E, ax).map((v) => v * OPEN_E);
      else D = layeredConstitutive(nu, kind === "apart" ? OPEN_E : 1, SLIP_G, ax);
      classMats.push(elementMatricesFor(D, `touch|${nu}|${k}|${ax.map((x) => x.toFixed(4)).join(",")}`, nu, hx, hy, hz));
      c = classMats.length;
      touchCls.set(k, c);
    }
    return c;
  };
  /** loads from the touching faces: the friction sliding faces carry, and the thermal push parted faces lose */
  let fT: Float64Array | null = null;
  const sg0 = new Float64Array(6);
  const applyTouch = () => {
    if (!touch || !touchOn) return;
    fT ??= new Float64Array(3 * nn);
    fT.fill(0);
    for (let c = 0; c < touch.cells.length; c++) {
      const e = touch.cells[c];
      const st = touch.state[c];
      cls[e] = st === STICK ? cls0[e] : touchClass(touch.axis[c], touch.ring[c] ? (st === OPEN ? "void" : "ring") : st === OPEN ? "apart" : "slide");
      const me = emOf(e);
      const n0 = elemNode0(e);
      if (frictionStress(touch, c, sg0)) {
        // the friction it carries as a stress σ0: f = −fill·Σ_g T_gᵀ·σ0·V/8
        for (const T of me.strainGauss)
          for (let j = 0; j < 24; j++) {
            let v = 0;
            for (let r = 0; r < 6; r++) v += T[r * 24 + j] * sg0[r];
            fT[3 * (n0 + off[j / 3 | 0]) + (j % 3)] -= fill[e] * detJ * v;
          }
      }
      const eth = thermalStrain(e);
      if (eth && cls[e] !== cls0[e]) {
        // the thermal load was made with the stuck element: correct it to the one in use
        const t1 = thermalLoad(me);
        const t0 = thermalLoad(cls0[e] ? classMats[cls0[e] - 1] : em);
        const k = inp.materials[matOf(e)].E * kfac[e] * kPrint[e] * fill[e] * eth;
        for (let j = 0; j < 24; j++) fT[3 * (n0 + off[j / 3 | 0]) + (j % 3)] += k * (t1[j] - t0[j]);
      }
    }
  };
  /** the force each layer cell takes from the other part, through the nodes it shares with that part's cells (3 per cell) */
  const touchForces = (uu: Float64Array) => {
    const T = touch!;
    const L = T.cells.length;
    const F = new Float64Array(3 * L);
    const ue = new Float64Array(24),
      fe = new Float64Array(24);
    const other = T.pairs.map((pr) => new Set(pr.other));
    for (let c = 0; c < L; c++) {
      const e = T.cells[c];
      const me = emOf(e);
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++) {
        const d = 3 * (n0 + off[a]);
        ue[3 * a] = uu[d];
        ue[3 * a + 1] = uu[d + 1];
        ue[3 * a + 2] = uu[d + 2];
      }
      // its nodal forces: K·u, with the friction it carries and less its free thermal expansion
      const sK = dense[e];
      for (let i = 0; i < 24; i++) {
        let v = 0;
        for (let j = 0; j < 24; j++) v += me.K[i * 24 + j] * ue[j];
        fe[i] = sK * v;
      }
      if (frictionStress(T, c, sg0))
        for (const G of me.strainGauss)
          for (let j = 0; j < 24; j++) {
            let v = 0;
            for (let r = 0; r < 6; r++) v += G[r * 24 + j] * sg0[r];
            fe[j] += fill[e] * detJ * v;
          }
      const eth = thermalStrain(e);
      if (eth) {
        const thv = thermalLoad(me);
        const k = inp.materials[matOf(e)].E * kfac[e] * kPrint[e] * fill[e] * eth;
        for (let j = 0; j < 24; j++) fe[j] -= k * thv[j];
      }
      // the corners it shares with a cell of the other part
      const set = other[T.pair[c]];
      const i0 = e % nx,
        j0 = Math.floor(e / nx) % ny,
        k0 = Math.floor(e / (nx * ny));
      for (let a = 0; a < 8; a++) {
        const ci = i0 + (a & 1),
          cj = j0 + ((a >> 1) & 1),
          ck = k0 + ((a >> 2) & 1);
        let shared = false;
        for (let q = 0; q < 8 && !shared; q++) {
          const ii = ci - (q & 1),
            jj = cj - ((q >> 1) & 1),
            kk = ck - ((q >> 2) & 1);
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
          const f = ii + nx * (jj + ny * kk);
          if (active[f] && set.has(owner[f])) shared = true;
        }
        if (!shared) continue;
        F[3 * c] += fe[3 * a];
        F[3 * c + 1] += fe[3 * a + 1];
        F[3 * c + 2] += fe[3 * a + 2];
      }
    }
    return F;
  };
  /** each layer cell's stress (with the friction it carries) and its strain less thermal expansion, at its centre */
  const touchFields = (uu: Float64Array) => {
    const L = touch!.cells.length;
    const S = new Float64Array(6 * L),
      E = new Float64Array(6 * L);
    const ue = new Float64Array(24),
      eps = new Float64Array(6);
    for (let c = 0; c < L; c++) {
      const e = touch!.cells[c];
      const me = emOf(e);
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++) {
        const d = 3 * (n0 + off[a]);
        ue[3 * a] = uu[d];
        ue[3 * a + 1] = uu[d + 1];
        ue[3 * a + 2] = uu[d + 2];
      }
      const eth = thermalStrain(e);
      for (let r = 0; r < 6; r++) {
        let v = 0;
        for (let j = 0; j < 24; j++) v += me.strainCenter[r * 24 + j] * ue[j];
        eps[r] = r < 3 ? v - eth : v;
        E[6 * c + r] = eps[r];
      }
      const Ee = inp.materials[matOf(e)].E * kfac[e] * kPrint[e];
      for (let r = 0; r < 6; r++) {
        let v = 0;
        for (let q = 0; q < 6; q++) v += me.D[r * 6 + q] * eps[q];
        S[6 * c + r] = Ee * v;
      }
      if (frictionStress(touch!, c, sg0)) for (let r = 0; r < 6; r++) S[6 * c + r] += sg0[r];
    }
    return { S, E };
  };

  /** the tightened bolts' prestress, as loads on the nodes: f = −fill·Σ_g T_gᵀ·σ0·V/8 over each free length */
  let fB: Float64Array | null = null;
  const sgB = new Float64Array(6);
  const boltLoads = () => {
    if (!bolts.length) return;
    fB ??= new Float64Array(3 * nn);
    fB.fill(0);
    for (const b of bolts) {
      if (!(b.p !== 0)) continue;
      boltStress(b, sgB);
      for (const e of b.grip) {
        const me = emOf(e);
        const n0 = elemNode0(e);
        for (const T of me.strainGauss)
          for (let j = 0; j < 24; j++) {
            let v = 0;
            for (let r = 0; r < 6; r++) v += T[r * 24 + j] * sgB[r];
            fB[3 * (n0 + off[(j / 3) | 0]) + (j % 3)] -= fill[e] * detJ * v;
          }
      }
    }
  };
  /** the tension in a bolt, N: the stress along it (with its prestress) over its free length, as a force across it */
  const boltForce = (bi: number, uu: Float64Array) => {
    const b = bolts[bi];
    const [a0, a1, a2] = b.axis;
    const ue = new Float64Array(24),
      eps = new Float64Array(6);
    let s = 0;
    for (const e of b.grip) {
      const me = emOf(e);
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++) {
        const d = 3 * (n0 + off[a]);
        ue[3 * a] = uu[d];
        ue[3 * a + 1] = uu[d + 1];
        ue[3 * a + 2] = uu[d + 2];
      }
      const eth = thermalStrain(e);
      for (let r = 0; r < 6; r++) {
        let v = 0;
        for (let j = 0; j < 24; j++) v += me.strainCenter[r * 24 + j] * ue[j];
        eps[r] = r < 3 ? v - eth : v;
      }
      const Ee = inp.materials[matOf(e)].E * kfac[e] * kPrint[e];
      const sig = new Float64Array(6);
      for (let r = 0; r < 6; r++) {
        let v = 0;
        for (let q = 0; q < 6; q++) v += me.D[r * 6 + q] * eps[q];
        sig[r] = Ee * v;
      }
      const saa = sig[0] * a0 * a0 + sig[1] * a1 * a1 + sig[2] * a2 * a2 + 2 * (sig[3] * a0 * a1 + sig[4] * a1 * a2 + sig[5] * a2 * a0);
      s += fill[e] * (saa + b.p) * hx * hy * hz;
    }
    return s / b.length;
  };

  // ---------- solve ----------
  progress("Setting up the solver", 0.22);
  const dense = new Float64Array(ne);
  for (let e = 0; e < ne; e++) if (active[e]) dense[e] = inp.materials[matOf(e)].E * fill[e] * kfac[e] * kPrint[e];
  // ---------- topology optimisation: the shape to keep, which the rest of the analysis then checks ----------
  const topo = inp.topology ? shapeFor(inp.topology) : null;
  let fine = makeLevel(nx, ny, nz, hv, nu, dense, bc, [0, 0, 0], classMats.length ? { cls, mats: classMats } : undefined, springs);
  let H = buildHierarchy(fine, plan.shifts, nu);
  const fs = Float64Array.from(f);
  for (let i = 0; i < fs.length; i++) if (!fine.free[i]) fs[i] = 0;
  const tSetup = now();

  // ---------- natural frequencies ----------
  /** lumped mass in tonnes per node: each element's mass shared by its eight corners, plus carried masses */
  const lumpedMass = () => {
    const nodeMass = new Float64Array(nn);
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const m = (fill[e] * mPrint[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-9) / 8;
      const n0 = elemNode0(e);
      for (let q = 0; q < 8; q++) nodeMass[n0 + off[q]] += m;
    }
    for (let n = 0; n < nn; n++) nodeMass[n] += extra[n] * 1e-3;
    return nodeMass;
  };
  let modal: ModalResult | undefined;
  let shapes: Float64Array[] = [];
  if (inp.modes) {
    progress("Finding natural frequencies", 0.25);
    const tm = now();
    const nodeMass = lumpedMass();
    const mvec = new Float64Array(3 * nn);
    const mtot: V3 = [0, 0, 0];
    for (let n = 0; n < nn; n++) {
      const m = nodeMass[n];
      for (let d = 0; d < 3; d++)
        if (fine.free[3 * n + d]) {
          mvec[3 * n + d] = m;
          mtot[d] += m;
        }
    }
    const k = Math.max(1, Math.min(12, Math.round(inp.modes)));
    const sol = lowestModes(H, mvec, k, { onIter: (it, res) => progress("Finding natural frequencies", 0.25 + 0.6 * Math.min(1, it / 60), { iter: it, residual: res }) });
    shapes = sol.shapes;
    const modes: ModeResult[] = sol.lambda.map((lam, j) => {
      const phi = sol.shapes[j];
      const gamma: V3 = [0, 0, 0];
      let peak = 0,
        peakN = 0;
      for (let n = 0; n < nn; n++) {
        for (let d = 0; d < 3; d++) gamma[d] += phi[3 * n + d] * mvec[3 * n + d];
        const a = Math.hypot(phi[3 * n], phi[3 * n + 1], phi[3 * n + 2]);
        if (a > peak) {
          peak = a;
          peakN = n;
        }
      }
      return {
        freq: Math.sqrt(Math.max(lam, 0)) / (2 * Math.PI),
        share: gamma.map((g, d) => (mtot[d] > 0 ? (g * g) / mtot[d] : 0)) as V3,
        gamma,
        peak: { value: peak, at: nodePos(peakN) },
      };
    });
    if (!sol.converged) warnings.push(`The frequency solver stopped at a residual of ${sol.residual.toExponential(1)}; frequencies may be off by a few percent.`);
    modal = { modes, mass: ((mtot[0] + mtot[1] + mtot[2]) * 1e6) / 3, iterations: sol.iterations, residual: sol.residual, converged: sol.converged, ms: now() - tm };
  }
  progress("Solving", 0.3);
  const tol = inp.tol ?? 1e-6;
  /** the loads, less what a region moved a set distance pulls on the rest (the moved dofs then join the answer) */
  /** tightening the bolts: their prestress (and the friction it makes) is all that loads the parts */
  let preloadOnly = false;
  const rhs = (): Float64Array => {
    if (preloadOnly) {
      const out = new Float64Array(3 * nn);
      for (let i = 0; i < out.length; i++) if (fine.free[i]) out[i] = (fB ? fB[i] : 0) + (fT ? fT[i] : 0);
      return out;
    }
    if (!uSet && !fT && !fB) return fs;
    const out = Float64Array.from(fs);
    // what touching faces carry (friction along sliding faces), and the tightened bolts' prestress
    if (fT) for (let i = 0; i < out.length; i++) if (fine.free[i]) out[i] += fT[i];
    if (fB) for (let i = 0; i < out.length; i++) if (fine.free[i]) out[i] += fB[i];
    if (!uSet) return out;
    const g = new Float64Array(3 * nn);
    applyK(fine, uSet, g, false);
    for (let i = 0; i < out.length; i++) out[i] = fine.free[i] ? out[i] - g[i] : 0;
    return out;
  };
  const solveOnce = (stage: string, x0?: Float64Array, to = tol) =>
    pcg(H, rhs(), {
      tol: to,
      maxIter: 300,
      x0,
      onIter: (it, rel) => progress(stage, 0.3 + 0.6 * Math.min(1, Math.log(rel) / Math.log(to)), { iter: it, residual: rel }),
    });
  // A pin with clearance bears only on the side the loads press the bore onto it: solve, let go where the bore pulls
  // away from the pin, hold where it pushes in, and solve again until that settles (roughly at first, then to the
  // full accuracy). Loads that reverse in a fatigue history press the other side half the time, so there each pin
  // holds all round, as a linear answer must.
  const reverses = !!inp.fatigue && inp.fatigue.cycles.some((cy) => cy.min < 0 || cy.max < 0);
  const freePins = reverses ? [] : pinSprings.filter((p) => !inp.supports[p.sup].pin!.tight);
  if (reverses && pinSprings.some((p) => !inp.supports[p.sup].pin!.tight)) warnings.push("The loads reverse, so each pin is taken as fitting its bore all round (a pin with clearance bears on one side, then the other).");
  const rough = Math.max(tol, 1e-4);
  const settles = freePins.length > 0 || touchOn;
  // ---------- tightening the bolts, before the loads ----------
  // The bolts alone load the parts: solve, set each bolt's prestress to give the tension wanted (the answer scales
  // with it), let the faces it clamps settle, and again until both hold still. The loads then go on with the
  // prestress kept, as a tightened bolt keeps its stretch, so its tension changes with what the joint does.
  let uPre: Float64Array | undefined;
  let boltRounds = 0;
  if (bolts.length) {
    preloadOnly = true;
    boltLoads();
    let settledB = false;
    for (; boltRounds < BOLT_ROUNDS; boltRounds++) {
      // closer than the rough rounds of the contacts: the tension is read off this answer
      const s = solveOnce(`Tightening the bolts${boltRounds ? ` (round ${boltRounds + 1})` : ""}`, uPre, Math.max(tol, 1e-5));
      uPre = s.u;
      let change = 0;
      let few = true;
      if (touchOn) {
        const { S, E } = touchFields(uPre);
        const st = touchStates(touch!, S, E);
        few = st.changed <= Math.max(2, 0.05 * touch!.cells.length);
        if (st.changed || st.moved > 0.02) {
          change += st.changed + (st.moved > 0.02 ? 1 : 0);
          applyTouch();
          fine = makeLevel(nx, ny, nz, hv, nu, dense, bc, [0, 0, 0], { cls, mats: classMats }, springs);
          H = withFine(H, fine, nu);
        }
      }
      let wrong = 0;
      bolts.forEach((b, i) => {
        if (b.p === 0) return;
        const N = boltForce(i, uPre!);
        if (!(N > 1e-6 * b.target)) {
          warnings.push(`preload: ${b.label} pulls on nothing that resists it, so it is left untightened; check its head bears on a part and its thread goes into one.`);
          b.p = 0;
          wrong++;
          return;
        }
        const r = b.target / N;
        if (Math.abs(r - 1) > 2e-3) {
          b.p *= r;
          wrong++;
        }
      });
      if (!change && !wrong) {
        settledB = true;
        break;
      }
      boltLoads();
      // a few cells still switching at the edge of a clamped patch, with the bolts where they should be, is settled
      if (!wrong && few && boltRounds > 1) {
        settledB = true;
        break;
      }
    }
    if (!settledB) warnings.push(`Tightening the bolts had not quite settled after ${BOLT_ROUNDS} rounds; their tensions may be a little off what was asked.`);
    preloadOnly = false;
  }
  let { u, stats } = solveOnce("Solving", uPre, settles ? rough : tol);
  let pinRounds = 1;
  let touchSettled = true;
  if (settles && stats.iterations > 0) {
    // Pins that bear on one side, and touching faces that press, part or slide: switch each by the last solve and
    // solve again (roughly) until nothing switches, then once more to the full accuracy. The first solve has every
    // touching face stuck, as glued; a part a contact lets go entirely moves far more than that.
    let iterations = stats.iterations;
    let settled = false;
    const umax = (v: Float64Array) => {
      let m = 0;
      for (let n = 0; n < nn; n++) m = Math.max(m, Math.hypot(v[3 * n], v[3 * n + 1], v[3 * n + 2]));
      return m;
    };
    const u0 = umax(u);
    let uLast = u0;
    const rounds = touchOn ? TOUCH_ROUNDS : PIN_ROUNDS;
    for (; pinRounds < rounds; pinRounds++) {
      let pinChange = 0;
      for (const p of freePins) {
        const n = p.node;
        const ur = u[3 * n] * p.rho[0] + u[3 * n + 1] * p.rho[1] + u[3 * n + 2] * p.rho[2];
        const on = p.side * ur > 0;
        if (on !== p.on) {
          p.on = on;
          pinChange++;
        }
      }
      let touchChange = 0;
      let creeping = false;
      if (touchOn) {
        const { S, E } = touchFields(u);
        const um = umax(u);
        if (um > 200 * u0 && um > 1e-4 * diag) touchChange += holdLoose(touch!, S, E, um);
        const st = touchStates(touch!, S, E);
        // a few cells still switching at the edge of a contact while nothing else moves is settled enough: where two
        // parts bend alike the faces carry next to nothing either way, and the edge creeps a cell or two each round
        creeping = pinRounds > 2 && st.changed <= Math.max(2, 0.05 * touch!.cells.length) && Math.abs(um - uLast) <= 1e-3 * um;
        uLast = um;
        touchChange += st.changed + (st.moved > 0.02 ? 1 : 0);
      }
      if (!pinChange && !touchChange) {
        settled = true;
        break;
      }
      if (pinChange) assembleSprings();
      if (touchChange) {
        applyTouch();
        fine = makeLevel(nx, ny, nz, hv, nu, dense, bc, [0, 0, 0], { cls, mats: classMats }, springs);
      }
      // the springs changed: the coarse grids and smoothers follow them; contacts change only the fine grid's elements
      H = pinChange ? buildHierarchy(fine, plan.shifts, nu) : withFine(H, fine, nu);
      // the last few switches go into the final solve
      if (creeping && !pinChange) {
        settled = true;
        break;
      }
      ({ u, stats } = solveOnce(touchOn ? `Solving where the parts touch (round ${pinRounds + 1})` : `Solving where the pins bear (round ${pinRounds + 1})`, u, rough));
      iterations += stats.iterations;
    }
    if (!settled) {
      if (touchOn) touchSettled = false;
      warnings.push(
        touchOn
          ? `Where the parts touch (what presses, parts and slides) had not quite settled after ${rounds} rounds; the stress next to the contacts may be a little off.`
          : `Where the pins bear on their bores had not quite settled after ${PIN_ROUNDS} rounds; the stress next to them may be a little off.`,
      );
    }
    ({ u, stats } = solveOnce("Solving", u));
    stats = { ...stats, iterations: iterations + stats.iterations };
  }
  /** what each contact carries */
  const touching: TouchResult[] | undefined = touch?.pairs.length
    ? (() => {
        const { S, E } = touchOn ? touchFields(u) : { S: new Float64Array(0), E: new Float64Array(0) };
        const centre = (e: number): V3 => [origin[0] + ((e % nx) + 0.5) * hx, origin[1] + ((Math.floor(e / nx) % ny) + 0.5) * hy, origin[2] + (Math.floor(e / (nx * ny)) + 0.5) * hz];
        // a pair found for a bolt that does not touch (a spacer between them) is not a contact
        const all = touchResults(touch, S, E, touchOn ? touchForces(u) : new Float64Array(0), centre, pinRounds, touchSettled).filter((t) => t.cells > 0 || !t.auto);
        return all.length ? all : undefined;
      })()
    : undefined;
  /** what each tightened bolt was tightened to and carries under the loads */
  const boltResults: BoltResult[] | undefined = bolts.length
    ? bolts.map((b, i) => {
        const force = b.p === 0 ? 0 : boltForce(i, u);
        return {
          part: b.label,
          size: b.size,
          ...(b.grade ? { grade: b.grade } : {}),
          preload: b.p === 0 ? 0 : b.target,
          why: b.why,
          force,
          area: b.area,
          stress: force / b.area,
          proof: b.proof,
          grip: b.length,
          into: inp.parts[b.into].name,
          soft: b.soft,
          clamps: b.clamps.filter((c) => c !== b.into).map((c) => inp.parts[c].name),
        };
      })
    : undefined;
  // ---------- large deflection ----------
  // The small-deflection answer moves every point straight along its first direction; a part that turns far (a snap
  // arm pushed home, a flexure, a spring) instead swings round, shortens and stiffens or softens with the stress it
  // carries. Solved again with each element turning as it bends, when asked, when that answer turns a part > 10°, or
  // when one large-deflection step from it moves the answer more than 3 % (a strap or plate stiffening as it stretches).
  let largeResult: LargeResult | undefined;
  const largeBlock = touchOn ? "touching faces" : freePins.length ? "pins with clearance" : bolts.length ? "tightened bolts" : inp.modes ? "natural frequencies" : inp.drop ? "a drop" : inp.buckling ? "buckling" : inp.fatigue ? "fatigue" : inp.topology ? "topology optimisation" : inp.thermal || inp.uniformTemp !== undefined ? "temperatures" : null;
  if (inp.large !== false && stats.residual <= UNRELIABLE_RESIDUAL) {
    const uLin = Float64Array.from(u);
    if (uSet) for (let i = 0; i < uLin.length; i++) if (uSet[i]) uLin[i] = uSet[i];
    const linearTurn = maxTurn(fine, uLin);
    if (largeBlock) {
      if (inp.large) warnings.push(`large_deflection: is not solved with ${largeBlock} yet, so this is the small-deflection answer.`);
      else if (linearTurn > LARGE_TURN) warnings.push(`Parts turn up to ${Math.round((linearTurn * 180) / Math.PI)}° under the loads, where a small-deflection answer is only rough; with ${largeBlock} Kerf cannot solve it for large deflection yet.`);
    } else if (inp.large || linearTurn > LARGE_TURN || (linearTurn > LARGE_LOOK && largeEffect(H, fs, uSet ?? null, uLin) > LARGE_EFFECT)) {
      const tL = now();
      let linearDisp = 0;
      for (let k = 0; k < nn; k++) linearDisp = Math.max(linearDisp, Math.hypot(uLin[3 * k], uLin[3 * k + 1], uLin[3 * k + 2]));
      const sol = solveLarge({
        H,
        f: fs,
        set: uSet ?? null,
        guess: uLin,
        steps: Math.min(10, Math.max(1, Math.ceil(linearTurn / 0.2))),
        deadline: t0 + (inp.large ? LARGE_BUDGET_MS + 80_000 : LARGE_BUDGET_MS),
        onProgress: (reached, it, res) => progress(`Large deflection: ${Math.round(reached * 100)} % of the loads${it ? ` (iteration ${it + 1})` : ""}`, 0.5 + 0.4 * reached, { iter: it, residual: res }),
      });
      largeResult = {
        auto: !inp.large,
        converged: sol.converged,
        reached: sol.reached,
        steps: sol.steps,
        newton: sol.newton,
        iterations: sol.iterations,
        turn: (sol.turn * 180) / Math.PI,
        linearTurn: (linearTurn * 180) / Math.PI,
        linearDisp,
        ms: now() - tL,
        ...(sol.why ? { why: sol.why } : {}),
      };
      if (sol.converged) u = sol.u;
      else warnings.push(`The large-deflection solve stopped at ${Math.round(sol.reached * 100)} % of the loads because ${sol.why ?? "it did not settle"}, so these are the small-deflection results, which can be well off when parts turn this far (up to ${Math.round((linearTurn * 180) / Math.PI)}°).`);
    }
  }
  const large = !!largeResult?.converged;
  if (uSet) for (let i = 0; i < u.length; i++) if (uSet[i]) u[i] = uSet[i];
  if (stats.residual > UNRELIABLE_RESIDUAL) warnings.push(`The solver did not converge (relative residual ${stats.residual.toExponential(1)} after ${stats.iterations} iterations), so these numbers are unreliable. Check that supports hold every part, or try another resolution.`);
  else if (!stats.converged) warnings.push(`The solver stopped at a relative residual of ${stats.residual.toExponential(1)} after ${stats.iterations} iterations; results may be off by a few percent.`);
  const tSolve = now();

  // ---------- drop: the impact pulse, and how the parts answer it ----------
  // The body hits the floor through the contact's stiffness: a half-sine pulse whose peak and length
  // follow from the impact speed. The parts flex like their 1 g shape at their own frequency (Rayleigh),
  // so a pulse shorter than their swing loads them less than its peak, and one about as long loads them
  // more (the shock response spectrum). The 1 g solution is scaled by the g they feel.
  let dropResult: DropResult | undefined;
  if (inp.drop && gravity) {
    const dr = inp.drop;
    const W = Math.hypot(...gravity.vector);
    const com = gravity.at;
    let height = dr.height ?? 0;
    if (dr.tip) {
      // it pivots on its bottom edge and lands on the side it falls toward: the centre of mass drops from
      // its height above the base to its distance from that side
      const side = norm(dr.dir);
      let reach = -Infinity;
      for (const p of inp.parts) {
        const P = p.mesh.positions;
        for (let v = 0; v < P.length; v += 3) reach = Math.max(reach, P[v] * side[0] + P[v + 1] * side[1] + P[v + 2] * side[2]);
      }
      height = Math.max(0, com[2] - lo[2] - (reach - dot(com, side)));
    }
    // the parts' frequency in this shape: ω² = fᵀu / Σ m|u|² (N·mm over t·mm²)
    const nodeMass = lumpedMass();
    let fu = 0,
      mu2 = 0;
    for (let i = 0; i < u.length; i++) fu += fs[i] * u[i];
    for (let n = 0; n < nn; n++) if (nodeMass[n]) mu2 += nodeMass[n] * (u[3 * n] ** 2 + u[3 * n + 1] ** 2 + u[3 * n + 2] ** 2);
    const wb = mu2 > 0 && fu > 0 ? Math.sqrt(fu / mu2) : Infinity;
    // the contact: a flat punch of the landing patch's area pressed into the floor, with the body's own
    // material at the patch (plastics give far more than a concrete floor does)
    const contact = supportSel[0];
    const area = Math.max(contact.area, hx * hy * 0.25);
    const at = supportInfo[0].at;
    let near = -1,
      best = Infinity;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const p = nodePos(elemNode0(e));
      const d2 = (p[0] + hx / 2 - at[0]) ** 2 + (p[1] + hy / 2 - at[1]) ** 2 + (p[2] + hz / 2 - at[2]) ** 2;
      if (d2 < best) {
        best = d2;
        near = e;
      }
    }
    const bm = inp.materials[near >= 0 ? matOf(near) : mainMat];
    const punch = (Estar: number) => 2 * Estar * Math.sqrt(area / Math.PI);
    const bodyC = (1 - bm.nu * bm.nu) / bm.E;
    const kc =
      dr.floor.soft !== undefined
        ? 1 / (1 / Math.max(20, dr.floor.soft * area) + 1 / punch(1 / bodyC))
        : punch(1 / (bodyC + (1 - 0.2 * 0.2) / (dr.floor.E ?? 30000)));
    const M = W / (G0 * 1000); // tonnes
    const wc = Math.sqrt(kc / M);
    const v = Math.sqrt(2 * G0 * 1000 * height); // mm/s
    const G = height > 0 ? (v * wc) / (G0 * 1000) : 0;
    const td = Math.PI / wc;
    const amp = Number.isFinite(wb) ? halfSineShock((td * wb) / (2 * Math.PI)) : 1;
    const felt = G * amp;
    for (let i = 0; i < u.length; i++) {
      u[i] *= felt;
      f[i] *= felt;
    }
    for (let d = 0; d < 3; d++) applied[d] *= felt;
    gravity.vector = [gravity.vector[0] * felt, gravity.vector[1] * felt, gravity.vector[2] * felt];
    dropResult = {
      height,
      tip: !!dr.tip,
      dir: norm(dropDir ?? dr.dir),
      floor: dr.floor.name,
      g: G,
      force: G * W,
      speed: v / 1000,
      energy: (W * height) / 1000,
      pulseMs: td * 1000,
      squash: wc > 0 ? v / wc : 0,
      bodyHz: wb / (2 * Math.PI),
      amplification: amp,
      felt,
      weight: W,
      contactStiffness: kc,
      contact: { at, area: contact.area },
      com,
    };
    if (felt > 0 && felt < 1) warnings.push("The landing is soft enough that the drop barely loads the parts.");
  }
  progress("Recovering stresses", 0.92);

  // reactions: full K·u at held dofs (with large deflection, the force the turned elements push back with)
  const Ku = large ? internalForce(H, u) : new Float64Array(3 * nn);
  if (!large) applyK(fine, u, Ku, false);
  // the friction sliding faces carry pushes on the nodes too
  if (fT) for (let i = 0; i < Ku.length; i++) Ku[i] -= fT[i];
  // and the tightened bolts' prestress, which pulls on the nodes inside them
  if (fB) for (let i = 0; i < Ku.length; i++) Ku[i] -= fB[i];
  const reaction: V3 = [0, 0, 0];
  /** the force springs push back on the body with */
  const springPush: V3 = [0, 0, 0];
  inp.supports.forEach((sp, si) => {
    const sel = select(sp.region);
    const R: V3 = [0, 0, 0];
    const info = supportInfo[si];
    if (sp.spring || sp.pin) {
      // springs push back with −k·u
      let give = 0,
        wsum = 0;
      for (const { node: n, k } of springOf[si]) {
        const a = u[3 * n],
          b = u[3 * n + 1],
          c = u[3 * n + 2];
        R[0] -= k[0] * a + k[3] * b + k[5] * c;
        R[1] -= k[3] * a + k[1] * b + k[4] * c;
        R[2] -= k[5] * a + k[4] * b + k[2] * c;
      }
      let onW = 0,
        allW = 0;
      for (const p of pinSprings) {
        if (p.sup !== si) continue;
        allW += p.w;
        if (!p.on) continue;
        onW += p.w;
        const n = p.node;
        const ur = u[3 * n] * p.rho[0] + u[3 * n + 1] * p.rho[1] + u[3 * n + 2] * p.rho[2];
        for (let d = 0; d < 3; d++) R[d] -= p.k * ur * p.rho[d];
      }
      if (info.spring) {
        // how far it gives: the mean movement along its direction (into the surface for a pad), or overall
        sel.nodes.forEach((n, q) => {
          const w = sel.w[q];
          const uu: V3 = [u[3 * n], u[3 * n + 1], u[3 * n + 2]];
          const nrm = norm([sel.av[3 * q], sel.av[3 * q + 1], sel.av[3 * q + 2]]);
          // along its axis, into the surface for a pad (it presses in along the surface's outward normal), or overall
          give += w * (sp.dir ? dot(uu, norm(sp.dir)) : sp.spring!.perArea !== undefined ? dot(uu, nrm) : Math.hypot(...uu));
          wsum += w;
        });
        const g = wsum > 0 ? give / wsum : 0;
        info.spring.give = sp.dir ? Math.abs(g) : g;
        if (sp.spring?.perArea !== undefined && !sp.dir && g < 0) warnings.push(`Support ${si + 1}: the pad is pulled rather than pressed; a real pad would let go there.`);
      }
      if (info.pin) {
        info.pin.share = allW > 0 ? onW / allW : 0;
        const ax = info.pin.axis;
        const across = Math.hypot(R[0] - dot(R, ax) * ax[0], R[1] - dot(R, ax) * ax[1], R[2] - dot(R, ax) * ax[2]);
        info.pin.pressure = across / Math.max(info.pin.d * info.pin.length, 1e-9);
        info.pin.rounds = pinRounds;
      }
      for (let d = 0; d < 3; d++) springPush[d] += R[d];
    } else {
      const seen = new Set<number>();
      for (const n of sel.nodes) {
        if (seen.has(n)) continue;
        seen.add(n);
        for (let d = 0; d < 3; d++) if (bc[3 * n + d]) R[d] += Ku[3 * n + d] - f[3 * n + d];
      }
    }
    info.reaction = R;
    const ct = sp.contact;
    if (ct) info.contact = contactCheck(sp, ct, sel, Ku, f, bc, nodePos);
  });
  for (let n = 0; n < nn; n++) for (let d = 0; d < 3; d++) if (bc[3 * n + d] && fine.free[3 * n + d] === 0 && Ku[3 * n + d] !== 0) reaction[d] += Ku[3 * n + d] - f[3 * n + d];
  for (let d = 0; d < 3; d++) reaction[d] += springPush[d];
  // the bolts' tension loads the parts too (inside them, so it adds nothing to the balance but what the solve leaves)
  const appliedMag = Math.hypot(...applied) + bolts.reduce((t, b) => t + (b.p !== 0 ? b.target : 0), 0) || 1;
  const equilibrium = Math.hypot(applied[0] + reaction[0], applied[1] + reaction[1], applied[2] + reaction[2]) / appliedMag;

  // ---------- stress recovery ----------
  const nodeS = new Float64Array(6 * nn);
  const nodeE = new Float64Array(6 * nn);
  const nodeW = new Float64Array(nn);
  /** strain weights: as nodeW, without the layer cells of sliding or parted contacts (their strain is the slide or the gap) */
  const nodeWE = touchOn ? new Float64Array(nn) : null;
  const nodeMat = new Int16Array(nn).fill(-1);
  const nodeMatW = new Float32Array(nn);
  /** the part that has the most of each node, and the share of the solid's strength there (a printed part's infill is weaker) */
  const nodePart = new Int16Array(nn).fill(-1);
  const nodeStr = new Float64Array(nn);
  const ue = new Float64Array(24);
  const sg = new Float64Array(48);
  const eg = new Float64Array(48);
  // large deflection: each element's strain is what is left once its turn is taken off, turned back after
  const frame = large ? elementFrame(hv, nx + 1, ny + 1) : null;
  const Rot = new Float64Array(9);
  /** buckling: each active element and its stress (at its centre, times its fill) */
  const cellList = inp.buckling ? new Int32Array(nActive) : null;
  const cellStress = inp.buckling ? new Float64Array(6 * nActive) : null;
  let cellN = 0;
  for (let e = 0; e < ne; e++) {
    if (!active[e]) continue;
    const n0 = elemNode0(e);
    for (let a = 0; a < 8; a++) {
      const d = 3 * (n0 + off[a]);
      ue[3 * a] = u[d];
      ue[3 * a + 1] = u[d + 1];
      ue[3 * a + 2] = u[d + 2];
    }
    const Ee = inp.materials[matOf(e)].E * kfac[e] * kPrint[e];
    const me = emOf(e);
    const turned = frame ? corotate(frame, ue, Rot) : false;
    // the strain that makes stress: the total less the free thermal expansion
    const eth = thermalStrain(e);
    for (let g = 0; g < 8; g++) {
      const T = me.strainGauss[g];
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let j = 0; j < 24; j++) s += T[r * 24 + j] * ue[j];
        eg[6 * g + r] = r < 3 ? s - eth : s;
      }
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let c = 0; c < 6; c++) s += me.D[r * 6 + c] * eg[6 * g + c];
        sg[6 * g + r] = Ee * s;
      }
      if (turned) {
        turnVoigt(eg, 6 * g, Rot, 2);
        turnVoigt(sg, 6 * g, Rot, 1);
      }
    }
    // a contact layer cell: the friction it carries along sliding faces, and no strain of its own while it slides or is apart
    const lc = layerIx ? layerIx[e] : -1;
    if (lc >= 0 && frictionStress(touch!, lc, sg0)) for (let g = 0; g < 8; g++) for (let r = 0; r < 6; r++) sg[6 * g + r] += sg0[r];
    // a tightened bolt's free length: the tension it was stretched to
    const bi = boltOf ? boltOf[e] : -1;
    if (bi >= 0) {
      boltStress(bolts[bi], sgB);
      for (let g = 0; g < 8; g++) for (let r = 0; r < 6; r++) sg[6 * g + r] += sgB[r];
    }
    const loose = lc >= 0 && touch!.state[lc] !== STICK;
    if (cellList && cellStress && cellN < cellList.length) {
      cellList[cellN] = e;
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let g = 0; g < 8; g++) s += sg[6 * g + r];
        cellStress[6 * cellN + r] = (s / 8) * fill[e];
      }
      cellN++;
    }
    const w = fill[e];
    for (let a = 0; a < 8; a++) {
      const n = n0 + off[a];
      for (let r = 0; r < 6; r++) {
        let s = 0,
          t = 0;
        for (let g = 0; g < 8; g++) {
          const x = em.extrap[a * 8 + g];
          s += x * sg[6 * g + r];
          t += x * eg[6 * g + r];
        }
        nodeS[6 * n + r] += w * s;
        if (!loose) nodeE[6 * n + r] += w * t;
      }
      nodeW[n] += w;
      if (nodeWE && !loose) nodeWE[n] += w;
      nodeStr[n] += w * sPrint[e];
      if (w > nodeMatW[n]) {
        nodeMatW[n] = w;
        nodeMat[n] = matOf(e);
        nodePart[n] = owner[e];
      }
    }
  }

  // ---------- buckling ----------
  let buckling: BucklingResult | undefined;
  if (inp.buckling && cellList && cellStress) {
    progress("Finding buckling loads", 0.93);
    const tb = now();
    const sol = bucklingModes({
      H,
      cells: cellList.subarray(0, cellN),
      stress: cellStress.subarray(0, 6 * cellN),
      n: [nx, ny, nz],
      h: hv,
      modes: inp.buckling.modes,
      onIter: (it, change) => progress("Finding buckling loads", 0.93 + 0.06 * Math.min(1, it / 40), { iter: it, residual: change }),
    });
    shapes = sol.shapes;
    const peaks = sol.shapes.map((v): V3 => {
      let big = 0,
        at = 0;
      for (let n = 0; n < nn; n++) {
        const a = Math.hypot(v[3 * n], v[3 * n + 1], v[3 * n + 2]);
        if (a > big) {
          big = a;
          at = n;
        }
      }
      return nodePos(at);
    });
    buckling = { factors: sol.factors, peaks, reversed: sol.reversed, iterations: sol.iterations, converged: sol.converged, ms: now() - tb };
    if (!sol.converged) warnings.push(`The buckling solver stopped after ${sol.iterations} rounds before the factors settled; treat them as rough.`);
    if (!sol.factors.length) warnings.push(sol.reversed !== null ? `Nothing buckles under these loads; with the loads reversed it would buckle at ${fmt(sol.reversed, 2)}× them.` : "Nothing buckles under these loads: they stretch the parts rather than press them.");
  }

  // ---------- nodal results ----------
  const fat = inp.fatigue ? fatigueSetup(inp.fatigue) : null;
  // with fatigue, the static check is against yield at the history's peak, and fatigue gets its own life and safety
  const allow = inp.materials.map((m) => (fat ? { value: m.yield, basis: "yield" as const } : allowableStress(m, inp.cycles)));
  /** the largest and smallest scale of the loads over the history (1 and 1 for a static load) */
  const sHi = fat ? fat.hi : 1,
    sLo = fat ? fat.lo : 1;
  const sAbs = Math.max(Math.abs(sHi), Math.abs(sLo));
  /** each part's build direction (null: not printed in layers) */
  const buildOf = prints.map((pp) => (pp ? norm(pp.build) : null));
  /** the layers' build direction at a node, when its part is printed in a plastic with weaker layers */
  const layerDir = (n: number): V3 | null => {
    const pi = nodePart[n];
    if (pi < 0) return null;
    const b = buildOf[pi];
    return b && inp.materials[nodeMat[n]].layerFactor < 1 ? b : null;
  };
  const vm = new Float32Array(nn);
  const strainN = new Float32Array(nn);
  /** per node: the lowest safety factor (static, or fatigue when it is lower), and what it is judged against (0 yield, 1 layers, 2 fatigue, 3 fatigue between layers) */
  const sfN = new Float32Array(nn);
  const sfMode = new Uint8Array(nn);
  /** with fatigue: the static safety factor and the fatigue one apart, and the life in the design's units */
  const sfStatic = fat ? new Float32Array(nn) : sfN;
  const staticMode = fat ? new Uint8Array(nn) : sfMode;
  const sfFat = fat ? new Float32Array(nn) : null;
  const fatMode = fat ? new Uint8Array(nn) : null;
  const lifeN = fat ? new Float64Array(nn) : null;
  const layerN = new Float32Array(nn);
  /** per node: the share of the solid's strength (1, or less in a printed part's infill) */
  const strN = new Float32Array(nn).fill(1);
  for (let n = 0; n < nn; n++) {
    const w = nodeW[n];
    if (!(w > 0)) continue;
    const o = 6 * n;
    const wE = nodeWE ? nodeWE[n] || 1 : w;
    for (let r = 0; r < 6; r++) {
      nodeS[o + r] /= w;
      nodeE[o + r] /= wE;
    }
    const str = Math.min(1, nodeStr[n] / w);
    strN[n] = str;
    const s = vonMises(nodeS, o);
    vm[n] = s;
    const pe = principal(nodeE[o], nodeE[o + 1], nodeE[o + 2], nodeE[o + 3] / 2, nodeE[o + 4] / 2, nodeE[o + 5] / 2);
    strainN[n] = Math.abs(pe[0]) >= Math.abs(pe[2]) ? pe[0] : pe[2];
    const mi = nodeMat[n];
    const m = inp.materials[mi];
    // a hot plastic is weaker: the allowable falls with the temperature there; so is a printed part's infill
    const al = allow[mi].value * derate(n, mi) * str;
    let sf = s > 1e-9 ? al / (s * sAbs) : 1e6;
    let mode = 0;
    let sn = 0;
    const lb = layerDir(n);
    if (lb) {
      // the pull across the layers (n·σ·n along the build direction) and the slide along them (the rest of σ·n)
      const { normal, shear } = layerStress(o, lb);
      sn = normal;
      // the most it pulls the layers apart over the history, and the most it slides them
      const pull = Math.max(sn * sHi, sn * sLo);
      layerN[n] = pull;
      const Sn = al * m.layerFactor;
      const q = (Math.max(pull, 0) / Sn) ** 2 + ((shear * sAbs) / (LAYER_SHEAR * Sn)) ** 2;
      if (q > 1e-18) {
        const sfl = 1 / Math.sqrt(q);
        if (sfl < sf) {
          sf = sfl;
          mode = 1;
        }
      }
    }
    sfStatic[n] = Math.min(sf, 1e6);
    staticMode[n] = mode;
    if (fat && sfFat && fatMode && lifeN) {
      // a weaker infill takes the same damage at a stress lowered by its share of the strength (the S-N curve scales with it)
      const bulk = fat.at(mi, false, fat.equivalent(mi, nodeS, o, s) / str);
      let fsf = bulk.sf;
      let dmg = bulk.damage;
      let fm = 2;
      if (lb) {
        const lay = fat.at(mi, true, sn / str);
        if (lay.sf < fsf) {
          fsf = lay.sf;
          fm = 3;
        }
        dmg = Math.max(dmg, lay.damage);
      }
      sfFat[n] = Math.min(fsf, 1e6);
      fatMode[n] = fm;
      lifeN[n] = dmg > 0 ? fat.design / dmg : Infinity;
      const useFat = sfFat[n] < sfStatic[n];
      sfN[n] = useFat ? sfFat[n] : sfStatic[n];
      sfMode[n] = useFat ? fm : mode;
    }
  }

  // nodes next to supports and loads, where idealised boundary conditions distort stress
  const nearBC = new Uint8Array(nn);
  {
    const R = 2;
    const mark = (n: number) => {
      const i = n % NX,
        j = Math.floor(n / NX) % NY,
        k = Math.floor(n / (NX * NY));
      for (let c = Math.max(0, k - R); c <= Math.min(NZ - 1, k + R); c++)
        for (let b = Math.max(0, j - R); b <= Math.min(NY - 1, j + R); b++)
          for (let a = Math.max(0, i - R); a <= Math.min(NX - 1, i + R); a++) nearBC[a + NX * (b + NY * c)] = 1;
    };
    for (let n = 0; n < nn; n++) if (bc[3 * n] | bc[3 * n + 1] | bc[3 * n + 2]) mark(n);
    for (const n of loadNodes) mark(n);
  }

  let iD = -1,
    iS = -1,
    iE = -1,
    iF = -1,
    iA = -1,
    iFA = -1,
    iL = -1,
    // with fatigue: the lowest static and fatigue safety factors (overall and away from supports and loads), the shortest life
    iSt = -1,
    iStA = -1,
    iFt = -1,
    iFtA = -1,
    iLife = -1;
  let dMax = 0;
  // a tightened bolt is judged by its tension against its proof load (it is meant to be stretched near it, and its
  // thread yields a little where it starts, as real ones do), not by the peak stress in its voxels
  const tightPart = bolts.length ? new Uint8Array(inp.parts.length) : null;
  for (const b of bolts) if (b.p !== 0) tightPart![b.part] = 1;
  for (let n = 0; n < nn; n++) {
    if (!(nodeW[n] > 0)) continue;
    const d = Math.hypot(u[3 * n], u[3 * n + 1], u[3 * n + 2]);
    if (iD < 0 || d > dMax) {
      dMax = d;
      iD = n;
    }
    if (tightPart && nodePart[n] >= 0 && tightPart[nodePart[n]]) continue;
    if (iS < 0 || vm[n] > vm[iS]) iS = n;
    if (iE < 0 || Math.abs(strainN[n]) > Math.abs(strainN[iE])) iE = n;
    if (iF < 0 || sfN[n] < sfN[iF]) iF = n;
    if (!nearBC[n] && (iA < 0 || vm[n] > vm[iA])) iA = n;
    if (!nearBC[n] && (iFA < 0 || sfN[n] < sfN[iFA])) iFA = n;
    if (anyLayered && (iL < 0 || layerN[n] > layerN[iL])) iL = n;
    if (fat && sfFat && lifeN) {
      if (iSt < 0 || sfStatic[n] < sfStatic[iSt]) iSt = n;
      if (!nearBC[n] && (iStA < 0 || sfStatic[n] < sfStatic[iStA])) iStA = n;
      if (iFt < 0 || sfFat[n] < sfFat[iFt]) iFt = n;
      if (!nearBC[n] && (iFtA < 0 || sfFat[n] < sfFat[iFtA])) iFtA = n;
      if (iLife < 0 || lifeN[n] < lifeN[iLife]) iLife = n;
    }
  }

  // hot spots: the highest-stress surface regions, spread apart
  const surfaceNode = new Uint8Array(nn);
  for (let q = 0; q < faces.fe.length; q++) {
    const n0 = elemNode0(faces.fe[q]);
    for (const a of FACE_CORNERS[faces.fd[q]]) surfaceNode[n0 + off[a]] = 1;
  }
  const cand: number[] = [];
  for (let n = 0; n < nn; n++) if (surfaceNode[n] && nodeW[n] > 0) cand.push(n);
  cand.sort((a, b) => vm[b] - vm[a]);
  const spots: number[] = [];
  for (const n of cand) {
    if (spots.length >= 3 || vm[n] < 0.3 * vm[iS]) break;
    const p = nodePos(n);
    if (spots.every((m) => dist(nodePos(m), p) > Math.max(6 * hmax, 0.12 * diag))) spots.push(n);
  }

  // ---------- sample onto the CAD surface ----------
  const sample = (x: number, y: number, z: number, out: Float64Array) => {
    const fx = (x - origin[0]) / hx,
      fy = (y - origin[1]) / hy,
      fz = (z - origin[2]) / hz;
    const i = clampI(Math.floor(fx), 0, nx - 1),
      j = clampI(Math.floor(fy), 0, ny - 1),
      k = clampI(Math.floor(fz), 0, nz - 1);
    const tx = clamp01(fx - i),
      ty = clamp01(fy - j),
      tz = clamp01(fz - k);
    const n0 = i + NX * (j + NY * k);
    out.fill(0);
    let wsum = 0;
    for (let a = 0; a < 8; a++) {
      const n = n0 + off[a];
      if (!(nodeW[n] > 0)) continue;
      const w = (a & 1 ? tx : 1 - tx) * (a & 2 ? ty : 1 - ty) * (a & 4 ? tz : 1 - tz) + 1e-9;
      accumulate(n, w, out);
      wsum += w;
    }
    if (wsum < 1e-6) {
      // the vertex sits in a cell that was too thin to keep: use the nearest kept node
      let bestN = -1,
        bestD = Infinity;
      for (let c = Math.max(0, k - 2); c <= Math.min(NZ - 1, k + 3); c++)
        for (let b = Math.max(0, j - 2); b <= Math.min(NY - 1, j + 3); b++)
          for (let a = Math.max(0, i - 2); a <= Math.min(NX - 1, i + 3); a++) {
            const n = a + NX * (b + NY * c);
            if (!(nodeW[n] > 0)) continue;
            const d = (a - fx) ** 2 + (b - fy) ** 2 + (c - fz) ** 2;
            if (d < bestD) {
              bestD = d;
              bestN = n;
            }
          }
      if (bestN >= 0) {
        accumulate(bestN, 1, out);
        wsum = 1;
      }
    }
    if (wsum > 0) for (let q = 0; q < out.length; q++) out[q] /= wsum;
  };
  function accumulate(n: number, w: number, out: Float64Array) {
    out[0] += w * u[3 * n];
    out[1] += w * u[3 * n + 1];
    out[2] += w * u[3 * n + 2];
    out[3] += w * vm[n];
    out[4] += w * strainN[n];
    // safety blends badly near zero stress; interpolate its inverse (utilisation)
    out[5] += w * (1 / Math.max(sfN[n], 1e-6));
    if (nodeT) out[6] += w * nodeT[n];
    if (lifeN && fat) out[7] += w * lifeLog(lifeN[n] / fat.design);
  }
  const tmp = new Float64Array(8);
  const ranges: StructuralResult["ranges"] = {
    stress: [Infinity, -Infinity],
    disp: [0, 0],
    strain: [Infinity, -Infinity],
    safety: [Infinity, -Infinity],
    ...(nodeT ? { temp: [Infinity, -Infinity] as [number, number] } : {}),
    ...(lifeN ? { life: [Infinity, -Infinity] as [number, number] } : {}),
    ...(heat?.J ? { current: [0, 0] as [number, number] } : {}),
  };
  /** the fields on a surface: a part's own, or the shape a topology optimisation found */
  const fieldOn = (p: { id: string; name: string }, P: Float32Array | Float64Array, indices: Uint32Array, normals: Float32Array | null): PartField => {
    const nv = P.length / 3;
    const disp = new Float32Array(3 * nv);
    const stress = new Float32Array(nv);
    const strain = new Float32Array(nv);
    const safety = new Float32Array(nv);
    const temp = nodeT ? new Float32Array(nv) : undefined;
    const life = lifeN ? new Float32Array(nv) : undefined;
    for (let v = 0; v < nv; v++) {
      sample(P[3 * v], P[3 * v + 1], P[3 * v + 2], tmp);
      if (temp && ranges.temp) {
        temp[v] = tmp[6];
        ranges.temp[0] = Math.min(ranges.temp[0], tmp[6]);
        ranges.temp[1] = Math.max(ranges.temp[1], tmp[6]);
      }
      if (life && ranges.life) {
        life[v] = tmp[7];
        ranges.life[0] = Math.min(ranges.life[0], tmp[7]);
        ranges.life[1] = Math.max(ranges.life[1], tmp[7]);
      }
      disp[3 * v] = tmp[0];
      disp[3 * v + 1] = tmp[1];
      disp[3 * v + 2] = tmp[2];
      stress[v] = tmp[3];
      strain[v] = tmp[4];
      safety[v] = tmp[5] > 0 ? Math.min(1 / tmp[5], 1e6) : 1e6;
      const dm = Math.hypot(tmp[0], tmp[1], tmp[2]);
      if (dm > ranges.disp[1]) ranges.disp[1] = dm;
      ranges.stress[0] = Math.min(ranges.stress[0], tmp[3]);
      ranges.stress[1] = Math.max(ranges.stress[1], tmp[3]);
      ranges.strain[0] = Math.min(ranges.strain[0], tmp[4]);
      ranges.strain[1] = Math.max(ranges.strain[1], tmp[4]);
      ranges.safety[0] = Math.min(ranges.safety[0], safety[v]);
      ranges.safety[1] = Math.max(ranges.safety[1], safety[v]);
    }
    const current = heat?.J ? currentAt(heat.J, heat.on, P, ranges) : undefined;
    return { id: p.id, name: p.name, positions: Float32Array.from(P), normals, indices, disp, stress, strain, safety, ...(temp ? { temp } : {}), ...(life ? { life } : {}), ...(current ? { current } : {}) };
  };
  // a topology optimisation shows the shape it found (each part's share of it, smoothed), in place of the parts
  let topology: TopologyResult | undefined;
  let parts: PartField[];
  if (topo) {
    const surfaces = inp.parts.map((_, pi) => topo.surfaceOf(topo.xbar, pi, 10));
    parts = inp.parts.map((p, pi) => fieldOn(p, surfaces[pi].positions, surfaces[pi].indices, null));
    let openings = 0,
      pieces = 0;
    for (const sf of surfaces) {
      const st = surfaceStats(sf.indices, sf.positions.length / 3);
      openings += st.openings;
      pieces += st.pieces;
    }
    const r = topo.run;
    const last = r.history[r.history.length - 1];
    topology = {
      keep: topo.spec.keep,
      kept: solidVolume / Math.max(topo.space, 1e-12),
      massBefore: topo.massBefore,
      massAfter: mass,
      stiffness: 0,
      iterations: r.iterations,
      converged: r.converged,
      history: r.history,
      minMember: topo.minMember,
      openings,
      pieces,
      preserved: r.preserved,
      symmetry: topo.spec.symmetry,
      ...(topo.spec.cut ? { cut: topo.spec.cut } : {}),
      trimmed: topo.trimmed,
      ...(topo.spec.cut ? { outline: plateOutline(topo.spec.cut, topo.xbar, topo.state, topo.gone) } : {}),
      ms: now() - topo.tTopo,
      time: r.ms,
    };
    // the shape's own compliance (the check solve, on the elements kept) against the parts left solid
    let c = 0;
    for (let i = 0; i < u.length; i++) c += fs[i] * u[i];
    topology.stiffness = c > 0 ? r.solidCompliance / c : last ? r.solidCompliance / last.compliance : 0;
  } else parts = inp.parts.map((p) => fieldOn(p, p.mesh.positions, p.mesh.indices, p.normals ?? null));
  if (ranges.current && heat?.result.currentPeak) ranges.current[1] = Math.max(ranges.current[1], heat.result.currentPeak.value);
  // mode shapes on the CAD surface, each scaled so its largest movement is 1
  if (shapes.length) {
    const sampleVec = (vec: Float64Array, x: number, y: number, z: number, out: Float64Array) => {
      const fx = (x - origin[0]) / hx,
        fy = (y - origin[1]) / hy,
        fz = (z - origin[2]) / hz;
      const i = clampI(Math.floor(fx), 0, nx - 1),
        j = clampI(Math.floor(fy), 0, ny - 1),
        k = clampI(Math.floor(fz), 0, nz - 1);
      const tx = clamp01(fx - i),
        ty = clamp01(fy - j),
        tz = clamp01(fz - k);
      const n0 = i + NX * (j + NY * k);
      out.fill(0);
      let wsum = 0;
      for (let a = 0; a < 8; a++) {
        const n = n0 + off[a];
        if (!(nodeW[n] > 0)) continue;
        const w = (a & 1 ? tx : 1 - tx) * (a & 2 ? ty : 1 - ty) * (a & 4 ? tz : 1 - tz) + 1e-9;
        out[0] += w * vec[3 * n];
        out[1] += w * vec[3 * n + 1];
        out[2] += w * vec[3 * n + 2];
        wsum += w;
      }
      if (wsum > 0) for (let q = 0; q < 3; q++) out[q] /= wsum;
    };
    const t3 = new Float64Array(3);
    shapes.forEach((vec, mi) => {
      const per = parts.map((pf) => {
        const P = pf.positions;
        const out = new Float32Array(P.length);
        for (let v = 0; v < P.length; v += 3) {
          sampleVec(vec, P[v], P[v + 1], P[v + 2], t3);
          out[v] = t3[0];
          out[v + 1] = t3[1];
          out[v + 2] = t3[2];
        }
        return out;
      });
      let mx = 0;
      for (const a of per) for (let v = 0; v < a.length; v += 3) mx = Math.max(mx, Math.hypot(a[v], a[v + 1], a[v + 2]));
      const sc = mx > 0 ? 1 / mx : 0;
      per.forEach((a, pi) => {
        for (let v = 0; v < a.length; v++) a[v] *= sc;
        (parts[pi].modes ??= [])[mi] = a;
      });
    });
  }
  // the node maxima are the reported values; keep the colour scale consistent with them
  ranges.stress[1] = Math.max(ranges.stress[1], vm[iS]);
  ranges.disp[1] = Math.max(ranges.disp[1], dMax);

  // ---------- warnings about accuracy ----------
  let partial = 0;
  for (let e = 0; e < ne; e++) if (active[e] && fill[e] < 0.9) partial++;
  const partialShare = partial / Math.max(nActive, 1);
  if (partialShare > 0.55) warnings.push(`Many elements are only partly filled: walls are thin compared with the ${fmt(h)} mm elements, so stiffness and stress are rough. Use resolution: "fine" before relying on the numbers.`);
  if (iS >= 0 && nearBC[iS] && iA >= 0 && vm[iA] < 0.85 * vm[iS])
    warnings.push(`The peak stress sits right at a support or load, where the idealised fixing exaggerates it. A short way off it is ${fmt(vm[iA], 1)} MPa; real fixings spread load and are somewhat gentler.`);
  if (!large && (dMax > 0.05 * Math.min(...ext.filter((e) => e > 0)) || dMax > 0.02 * diag))
    warnings.push(`The part deflects a lot compared with its size: a linear analysis is no longer accurate, and the real part may buckle or bend further.${largeBlock || largeResult ? "" : " large_deflection: true solves it with the parts turning as they bend."}`);
  const yieldNode = iS >= 0 ? inp.materials[nodeMat[iS]] : null;
  const yieldThere = yieldNode ? yieldNode.yield * derate(iS, nodeMat[iS]) : 0;
  if (yieldNode && vm[iS] > yieldThere)
    warnings.push(
      `Peak stress (${fmt(vm[iS], 1)} MPa) is above the yield strength of ${yieldNode.name} (${fmt(yieldThere, 1)} MPa${nodeT ? ` at ${fmt(nodeT[iS], 0)} °C` : ""}): the part would bend permanently or break, and stresses beyond yield are not physical.`,
    );
  for (const m of inp.materials) if (m.assumed && matCount[inp.materials.indexOf(m)] > 0) warnings.push(m.note ?? `No strength data for ${m.name}.`);
  if (Math.hypot(...applied) > 0 && equilibrium > 0.02) warnings.push(`Reactions balance the loads only to ${fmt(equilibrium * 100, 1)}%.`);

  const pos = (n: number): V3 => (n >= 0 ? nodePos(n) : [0, 0, 0]);
  /** a node's safety factor and what it is judged against: the lowest of all, the static one or the fatigue one */
  const safetyAt = (n: number, which: "all" | "static" | "fatigue" = "all"): SafetyAt => {
    const mi = n >= 0 ? nodeMat[n] : mainMat;
    const md = n < 0 ? 0 : which === "static" ? staticMode[n] : which === "fatigue" && fatMode ? fatMode[n] : sfMode[n];
    const value = n < 0 ? Infinity : which === "static" ? sfStatic[n] : which === "fatigue" && sfFat ? sfFat[n] : sfN[n];
    const temp = nodeT && n >= 0 ? { tempC: nodeT[n] } : {};
    if (md >= 2 && fat) {
      const c = md === 3 ? fat.layerCurves[mi] ?? fat.curves[mi] : fat.curves[mi];
      const fstr = n >= 0 ? strN[n] : 1;
      return { value, at: pos(n), mode: md === 3 ? "layer fatigue" : "fatigue", allowable: snStrengthAt(c, fat.total) * fstr, material: inp.materials[mi].name, ...temp, ...(fstr < 0.95 ? { infill: true } : {}) };
    }
    const layers = md === 1;
    const str = n >= 0 ? strN[n] : 1;
    return {
      value,
      at: pos(n),
      mode: layers ? "layers" : allow[mi].basis,
      allowable: allow[mi].value * (layers ? inp.materials[mi].layerFactor : 1) * derate(n, mi) * str,
      material: inp.materials[mi].name,
      ...temp,
      ...(str < 0.95 ? { infill: true } : {}),
    };
  };
  const safetyNearBC = iF >= 0 && !!nearBC[iF];
  if (!fat && iF >= 0 && sfMode[iF] !== 1 && allow[nodeMat[iF]].basis === "fatigue")
    warnings.push("Fatigue strengths are for polished test pieces. Rough, printed or machined surfaces, notches and threads lower them, often by half, so keep a generous margin.");
  let fatigue: FatigueResult | undefined;
  let staticSafety: StructuralResult["staticSafety"];
  if (fat && iFt >= 0 && lifeN && sfFat && fatMode) {
    const nb = !!nearBC[iFt];
    const stNb = iSt >= 0 && !!nearBC[iSt];
    staticSafety = { ...safetyAt(iSt, "static"), nearBoundary: stNb, away: stNb && iStA >= 0 ? safetyAt(iStA, "static") : null };
    // what does the damage where the life is shortest
    let shares: FatigueResult["shares"] = [];
    if (iLife >= 0 && Number.isFinite(lifeN[iLife])) {
      const mi = nodeMat[iLife];
      const o = 6 * iLife;
      const layer = fatMode[iLife] === 3 && !!fat.layerCurves[mi];
      const lb = layerDir(iLife);
      const sigma = (layer && lb ? layerStress(o, lb).normal : fat.equivalent(mi, nodeS, o, vm[iLife])) / strN[iLife];
      shares = fat.shares(mi, layer, sigma).slice(0, 6);
    }
    fatigue = {
      unit: inp.fatigue!.unit,
      design: fat.design,
      loading: inp.fatigue!.loading,
      meanStress: inp.fatigue!.meanStress,
      cycles: inp.fatigue!.cycles,
      repeats: inp.fatigue!.repeats,
      peak: peakScale(inp.fatigue!.cycles),
      minSafety: { ...safetyAt(iFt, "fatigue"), nearBoundary: nb, away: nb && iFtA >= 0 ? safetyAt(iFtA, "fatigue") : null },
      life: { value: iLife >= 0 ? lifeN[iLife] : Infinity, at: pos(iLife) },
      damage: iLife >= 0 && Number.isFinite(lifeN[iLife]) ? fat.design / lifeN[iLife] : 0,
      shares,
      curves: fat.curveInfo(),
      reliability: inp.fatigue!.reliability,
    };
    if (fatigue.minSafety.value < 1e5)
      warnings.push(
        "Fatigue lives come from S-N curves estimated from each material's strengths (Shigley), with the surface and reliability factors shown; sharp notches smaller than the elements, threads and welds shorten them further. Treat a life within a few times the target as uncertain.",
      );
  }
  // how each printed part was modelled: the share of it that is solid, and how its infill and layers compare to the solid
  const printing: NonNullable<StructuralResult["printing"]> = [];
  prints.forEach((pp, pi) => {
    if (!pp || (pp.words === "solid" && legacyPrint)) return;
    let solid = 0,
      all = 0;
    for (let e = 0; e < ne; e++) {
      if (!active[e] || owner[e] !== pi) continue;
      solid += fill[e] * solidShare[e];
      all += fill[e];
    }
    if (!all) return;
    printing.push({
      part: inp.parts[pi].name,
      build: norm(pp.build),
      from: pp.from,
      words: pp.words,
      solid: solid / all,
      infillStiffness: pp.infill >= 0.999 ? 1 : infillStiffness(pp.infill, pp.pattern),
      infillStrength: pp.infill >= 0.999 ? 1 : infillStrength(pp.infill, pp.pattern),
      across: layerStiffness(inp.materials[inp.parts[pi].material]).rE,
    });
  });
  // ---------- the fields inside, for a section through the result ----------
  const interior = (() => {
    const v = sampleInterior(
      { n: [NX, NY, NZ], origin, h: hv },
      (n) => nodeW[n] > 0,
      [
        (n) => vm[n],
        (n) => strainN[n],
        (n) => 1 / Math.max(sfN[n], 1e-6),
        ...(nodeT ? [(n: number) => nodeT[n]] : []),
        ...(lifeN && fat ? [(n: number) => lifeLog(lifeN[n] / fat.design)] : []),
        ...(heat?.J ? [(n: number) => heat.J![n]] : []),
      ],
      u,
    );
    const [stress, strain, util, ...rest] = v.scalars;
    return {
      origin: v.origin,
      step: v.step,
      n: v.n,
      disp: v.vec!,
      stress,
      strain,
      util,
      ...(nodeT ? { temp: rest.shift()! } : {}),
      ...(lifeN && fat ? { life: rest.shift()! } : {}),
      ...(heat?.J ? { current: rest.shift()! } : {}),
    } satisfies ResultVolume;
  })();

  const tEnd = now();
  progress("Done", 1);
  return {
    label: inp.label,
    ...(topology ? { topology } : {}),
    interior,
    mesh: { h, cell: hv, grid: [nx, ny, nz], elements: nActive, nodes: fine.free.length / 3, dofs: fine.free.reduce((s, v) => s + v, 0), levels: H.levels.length, partial: partialShare },
    solve: { iterations: stats.iterations, residual: stats.residual, converged: stats.converged, history: stats.history, ms: { mesh: tMesh - t0, setup: tSetup - tMesh, solve: tSolve - tSetup, post: tEnd - tSolve, total: tEnd - t0 } },
    maxDisp: { value: dMax, at: pos(iD) },
    maxStress: { value: iS >= 0 ? vm[iS] : 0, at: pos(iS), nearBoundary: iS >= 0 && !!nearBC[iS], away: iA >= 0 ? { value: vm[iA], at: pos(iA) } : null },
    maxStrain: { value: iE >= 0 ? strainN[iE] : 0, at: pos(iE) },
    minSafety: { ...safetyAt(iF), nearBoundary: safetyNearBC, away: safetyNearBC && iFA >= 0 ? safetyAt(iFA) : null },
    layer: anyLayered && iL >= 0 ? { value: layerN[iL], at: pos(iL) } : null,
    hotSpots: spots.map((n) => ({ at: nodePos(n), stress: vm[n], safety: sfN[n] })),
    applied,
    reaction,
    equilibrium,
    mass,
    volume: solidVolume,
    loads: loadInfo,
    supports: supportInfo,
    gravity,
    parts,
    ranges,
    warnings,
    materials: inp.materials.map((m, i) => ({ name: m.name, E: m.E, yield: m.yield, allowable: allow[i].value, basis: allow[i].basis, layerFactor: m.layerFactor, assumed: !!m.assumed })),
    ...(printing.length ? { printing } : {}),
    modal,
    drop: dropResult,
    ...(heat ? { thermal: { ...heat.result, refTemp } } : nodeT ? { thermal: uniformThermal(nodeT, refTemp) } : {}),
    ...(buckling ? { buckling } : {}),
    ...(fatigue ? { fatigue, staticSafety } : {}),
    ...(touching ? { touching } : {}),
    ...(boltResults ? { bolts: boltResults } : {}),
    ...(largeResult ? { large: largeResult } : {}),
  };

  // ----- helpers that need the closure -----
  /** the stress on a node's print layers: the pull across them (n·σ·n along the build direction) and the slide along them */
  /**
   * Topology optimisation: the elements to keep for the stiffest shape with the share of material asked for. Where the
   * parts are held and loaded (and preserve:) stays solid; the rest is optimised, then the elements under one half and
   * any bits cut off from the supports are left out of the model, and the loads, weight and mass follow.
   */
  function shapeFor(spec: TopologySpec) {
    const tTopo = now();
    const names = new Set(inp.parts.map((p) => p.name));
    for (const n of spec.preserveParts) if (!names.has(n)) throw new FeaError(`preserve: "${n}" is not one of the analysed parts (${[...names].join(", ")}).`);
    // which elements may change: 1 in the design, 2 kept solid
    const state = new Uint8Array(ne);
    for (let e = 0; e < ne; e++) if (active[e]) state[e] = 1;
    const heldNodes = new Uint8Array(nn);
    for (const sel of supportSel) for (const n of sel.nodes) heldNodes[n] = 1;
    const keepNodes = Uint8Array.from(heldNodes);
    for (const n of loadNodes) keepNodes[n] = 1;
    for (let n = 0; n < nn; n++) if (extra[n]) keepNodes[n] = 1;
    const centre = (e: number): V3 => {
      const p = nodePos(elemNode0(e));
      return [p[0] + hx / 2, p[1] + hy / 2, p[2] + hz / 2];
    };
    spec.preserve.forEach((r) => {
      const sel = select(r);
      for (const n of sel.nodes) keepNodes[n] = 1;
      // a zone keeps every element whose middle is in it (a boss round a hole), not just the surface it touches
      let inside = 0;
      if (r.t === "sphere" || r.t === "box" || r.t === "cyl")
        for (let e = 0; e < ne; e++)
          if (active[e] && inZone(r, centre(e))) {
            state[e] = 2;
            inside++;
          }
      if (!sel.nodes.length && !inside) throw new FeaError(`preserve: ${describeRegion(r)} does not touch the parts. Move it onto them.`);
    });
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      if (spec.preserveParts.includes(inp.parts[owner[e]].name)) {
        state[e] = 2;
        continue;
      }
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++)
        if (keepNodes[n0 + off[a]]) {
          state[e] = 2;
          break;
        }
    }
    const vol = new Float64Array(ne);
    for (let e = 0; e < ne; e++) if (active[e]) vol[e] = fill[e] * hx * hy * hz;
    const classes = classMats.length ? { cls, mats: classMats } : undefined;
    let fsT: Float64Array | null = null;
    // one set of grids for the whole run: each step only changes the stiffness of the cells. The coarse
    // factorisation is redone when the stiffness has moved a long way from the one it was made for (the first
    // steps), when the solver starts needing more iterations, or every few steps.
    let Ht: Hierarchy | null = null;
    let made = 0,
      since = 0,
      base = 0,
      last = 0;
    const total = (s: Float64Array) => {
      let t = 0;
      for (let e = 0; e < s.length; e++) t += s[e];
      return t;
    };
    const solveAt = (stiff: Float64Array, u0: Float64Array | null, tol: number) => {
      if (!Ht) {
        const L = makeLevel(nx, ny, nz, hv, nu, stiff, bc, [0, 0, 0], classes, springs);
        Ht = buildHierarchy(L, plan.shifts, nu);
        made = total(stiff);
        since = 0;
        fsT = Float64Array.from(f);
        for (let i = 0; i < fsT.length; i++) if (!L.free[i]) fsT[i] = 0;
      } else {
        const sum = total(stiff);
        const refresh = since >= 6 || Math.abs(sum / made - 1) > 0.15 || last > 1.5 * base + 3;
        restiffen(Ht, stiff, refresh);
        if (refresh) {
          made = sum;
          since = 0;
        } else since++;
      }
      const { u, stats } = pcg(Ht, fsT!, { tol, maxIter: 300, ...(u0 ? { x0: u0 } : {}) });
      if (since === 0) base = stats.iterations;
      last = stats.iterations;
      let c = 0;
      for (let i = 0; i < u.length; i++) c += fsT![i] * u[i];
      return { u, compliance: c, iterations: stats.iterations };
    };
    const ue = new Float64Array(24);
    const energy = (u: Float64Array, out: Float64Array) => {
      for (let e = 0; e < ne; e++) {
        if (!active[e]) {
          out[e] = 0;
          continue;
        }
        const n0 = elemNode0(e);
        for (let a = 0; a < 8; a++) {
          const d = 3 * (n0 + off[a]);
          ue[3 * a] = u[d];
          ue[3 * a + 1] = u[d + 1];
          ue[3 * a + 2] = u[d + 2];
        }
        const K = emOf(e).K;
        let w = 0;
        for (let r = 0; r < 24; r++) {
          let t = 0;
          const o = 24 * r;
          for (let c = 0; c < 24; c++) t += K[o + c] * ue[c];
          w += ue[r] * t;
        }
        out[e] = w;
      }
    };
    const surfaceOf = (xbar: Float64Array, only: number | null, passes: number, iso = 0.5) => {
      const v = new Float64Array(ne);
      for (let e = 0; e < ne; e++) if (active[e] && (only === null || owner[e] === only)) v[e] = xbar[e] * fill[e];
      const sf = isoSurface(v, [nx, ny, nz], origin, hv, iso);
      if (passes) smoothSurface(sf.positions, sf.indices, passes);
      return sf;
    };
    // early on the densities are still grey (all near the share kept), so the shape so far is drawn where the
    // densest elements holding that share of the material are, not at one half
    const previewIso = (xbar: Float64Array) => {
      const bins = new Float64Array(201);
      let total = 0;
      for (let e = 0; e < ne; e++)
        if (active[e]) {
          bins[Math.min(200, Math.max(0, Math.round(xbar[e] * 200)))] += vol[e];
          total += vol[e];
        }
      let acc = 0;
      for (let b = 200; b > 0; b--) {
        acc += bins[b];
        if (acc >= spec.keep * total) return Math.min(0.5, Math.max(0.05, (b - 0.5) / 200));
      }
      return 0.05;
    };
    const minMember = Math.max(1.5 * hmax, spec.minMember ?? 2.5 * hmax);
    const iterations = Math.max(5, Math.min(300, Math.round(spec.iterations ?? 80)));
    const axes = { X: 0, Y: 1, Z: 2 } as const;
    let run: TopologyRun;
    try {
      run = optimise(
        {
          n: [nx, ny, nz],
          h: hv,
          cells: [cellsN![0], cellsN![1], cellsN![2]],
          state,
          E0: Float64Array.from(dense),
          vol,
          solve: solveAt,
          energy,
          progress: (it, of, c, v, change) => progress(`Optimising the shape: iteration ${it}, ${Math.round(v * 100)} % of the material`, 0.22 + 0.63 * Math.min(1, it / of), { iter: it, residual: Math.max(change, 1e-9) }),
          preview: (xbar, it, v) => {
            const sf = surfaceOf(xbar, null, 2, previewIso(xbar));
            progress(`Optimising the shape: iteration ${it}, ${Math.round(v * 100)} % of the material`, 0.22 + 0.63 * Math.min(1, it / iterations), { preview: { positions: sf.positions, indices: sf.indices, iteration: it, volume: v } });
          },
        },
        { keep: spec.keep, radius: minMember, symmetry: spec.symmetry.map((a) => axes[a]), ...(spec.cut ? { cut: axes[spec.cut] } : {}), iterations },
      );
    } catch (e) {
      if (e instanceof TopologyError) throw new FeaError(e.message);
      throw e;
    }
    progress("Checking the shape found", 0.86);
    // ---------- the shape: what is under one half goes, then any bit cut off from the supports ----------
    const x = run.xbar;
    let space = 0;
    for (let e = 0; e < ne; e++) if (active[e]) space += vol[e];
    const gone = new Uint8Array(ne);
    for (let e = 0; e < ne; e++)
      if (active[e] && state[e] === 1 && x[e] < 0.5) {
        active[e] = 0;
        dense[e] = 0;
        gone[e] = 1;
      }
    const reached = new Uint8Array(ne);
    const queue = new Int32Array(ne);
    let head = 0,
      tail = 0;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++)
        if (heldNodes[n0 + off[a]]) {
          reached[e] = 1;
          queue[tail++] = e;
          break;
        }
    }
    while (head < tail) {
      const e = queue[head++];
      const i = e % nx,
        j = Math.floor(e / nx) % ny,
        k = Math.floor(e / (nx * ny));
      const nb = [i > 0 ? e - 1 : -1, i < nx - 1 ? e + 1 : -1, j > 0 ? e - nx : -1, j < ny - 1 ? e + nx : -1, k > 0 ? e - nx * ny : -1, k < nz - 1 ? e + nx * ny : -1];
      for (const g of nb)
        if (g >= 0 && active[g] && !reached[g]) {
          reached[g] = 1;
          queue[tail++] = g;
        }
    }
    let trimmed = 0,
      keptCut = 0;
    for (let e = 0; e < ne; e++)
      if (active[e] && !reached[e]) {
        if (state[e] === 2) keptCut += vol[e];
        active[e] = 0;
        dense[e] = 0;
        gone[e] = 1;
        trimmed += vol[e];
      }
    // a region kept solid that nothing loads can end up on its own: it cannot stay in a part that is held
    if (keptCut > 0)
      warnings.push(
        `Some of what preserve: keeps solid (${fmt(keptCut / 1000, 2)} cm³) ended up cut off from the rest of the shape, as nothing loads it, so the shape found leaves it out. Load it (a bolt's pull, the weight it carries) or join it to the shape when modelling the part.`,
      );
    // every load still has the shape under it
    inp.loads.forEach((ld, i) => {
      const nodes = select(ld.region).nodes;
      const touches = nodes.some((n) => {
        const ii = n % NX,
          jj = Math.floor(n / NX) % NY,
          kk = Math.floor(n / (NX * NY));
        for (let dk = -1; dk <= 0; dk++)
          for (let dj = -1; dj <= 0; dj++)
            for (let di = -1; di <= 0; di++) {
              const a = ii + di,
                b = jj + dj,
                c = kk + dk;
              if (a >= 0 && b >= 0 && c >= 0 && a < nx && b < ny && c < nz && active[eIndex(a, b, c)]) return true;
            }
        return false;
      });
      if (!touches)
        throw new FeaError(`With ${Math.round(spec.keep * 100)} % of the material the shape found does not join load ${i + 1} (${ld.t} on ${describeRegion(ld.region)}) to the supports. Keep more material, like topology: ${Math.min(90, Math.round(spec.keep * 100) + 15)}%.`);
    });
    // the weight of what went no longer pulls on the shape
    if (gravity && inp.accel) {
      const a = dropDir ?? inp.accel;
      for (let e = 0; e < ne; e++) {
        if (!gone[e]) continue;
        const m = fill[e] * mPrint[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-6;
        const n0 = elemNode0(e);
        for (let q = 0; q < 8; q++) for (let d = 0; d < 3; d++) f[3 * (n0 + off[q]) + d] -= (m * a[d] * G0) / 8;
      }
      let c: V3 = [0, 0, 0];
      let mt = 0;
      for (let e = 0; e < ne; e++) {
        if (!active[e]) continue;
        const m = fill[e] * mPrint[e] * hx * hy * hz * inp.materials[matOf(e)].density * 1e-6;
        const p = centre(e);
        c = [c[0] + m * p[0], c[1] + m * p[1], c[2] + m * p[2]];
        mt += m;
      }
      for (let n = 0; n < nn; n++)
        if (extra[n]) {
          const p = nodePos(n);
          c = [c[0] + extra[n] * p[0], c[1] + extra[n] * p[1], c[2] + extra[n] * p[2]];
          mt += extra[n];
        }
      if (mt > 0) gravity = { vector: [mt * a[0] * G0, mt * a[1] * G0, mt * a[2] * G0], at: [c[0] / mt, c[1] / mt, c[2] / mt] };
      for (let d = 0; d < 3; d++) applied[d] = 0;
      for (let n = 0; n < nn; n++) for (let d = 0; d < 3; d++) applied[d] += f[3 * n + d];
    }
    const massBefore = mass;
    nActive = 0;
    mass = extraKg * 1000;
    solidVolume = 0;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      nActive++;
      solidVolume += vol[e];
      mass += (vol[e] / 1000) * inp.materials[matOf(e)].density * mPrint[e];
    }
    faces = exposed();
    return { spec, run, xbar: x, state, gone, surfaceOf, space, trimmed: trimmed / Math.max(space, 1e-12), massBefore, minMember, tTopo };
  }

  /**
   * The profile of a shape cut from plate: per column across the cut axis, the most material along it (the density
   * times how much of the cell is inside the parts, leaving out bits cut off from the supports), outlined at one half.
   */
  function plateOutline(cut: "X" | "Y" | "Z", xbar: Float64Array, state: Uint8Array, gone: Uint8Array): NonNullable<TopologyResult["outline"]> {
    const c = cut === "X" ? 0 : cut === "Y" ? 1 : 2;
    const [ua, va] = c === 0 ? [1, 2] : c === 1 ? [0, 2] : [0, 1];
    const n = [nx, ny, nz];
    const na = n[ua],
      nb = n[va];
    const col = new Float64Array(na * nb);
    const ijk = [0, 0, 0];
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const e = i + nx * (j + ny * k);
          if (!state[e] || (gone[e] && xbar[e] >= 0.5)) continue;
          ijk[0] = i;
          ijk[1] = j;
          ijk[2] = k;
          const q = ijk[ua] + na * ijk[va];
          col[q] = Math.max(col[q], xbar[e] * fill[e]);
        }
    const hu = hv[ua],
      hw = hv[va];
    const loops = profileLoops(col, [na, nb], [origin[ua], origin[va]], [hu, hw], 0.3 * Math.min(hu, hw), 2.25 * hu * hw);
    let from = Infinity,
      to = -Infinity;
    for (const p of inp.parts)
      for (let i = c; i < p.mesh.positions.length; i += 3) {
        from = Math.min(from, p.mesh.positions[i]);
        to = Math.max(to, p.mesh.positions[i]);
      }
    const AX = ["X", "Y", "Z"] as const;
    const r = (v: number) => Math.round(v * 100) / 100;
    return { axis: cut, plane: [AX[ua], AX[va]], from: r(from), to: r(to), loops: loops.map((l) => ({ ...l, points: l.points.map(([a, b]) => [r(a), r(b)] as [number, number]), area: r(l.area) })) };
  }

  /** Whether a point is inside a zone (a sphere, box or cylinder), for regions kept solid. */
  function inZone(z: RegionSpec, p: V3): boolean {
    if ("within" in z && z.within && !inZone(z.within, p)) return false;
    switch (z.t) {
      case "sphere":
        return Math.hypot(p[0] - z.at[0], p[1] - z.at[1], p[2] - z.at[2]) <= z.r;
      case "box":
        return Math.abs(p[0] - z.at[0]) <= z.size[0] / 2 && Math.abs(p[1] - z.at[1]) <= z.size[1] / 2 && Math.abs(p[2] - z.at[2]) <= z.size[2] / 2;
      case "cyl": {
        const ax = norm(z.axis);
        const v: V3 = [p[0] - z.at[0], p[1] - z.at[1], p[2] - z.at[2]];
        const s = dot(v, ax);
        if (s < 0 || s > z.length) return false;
        return Math.hypot(v[0] - s * ax[0], v[1] - s * ax[1], v[2] - s * ax[2]) <= z.d / 2;
      }
      default:
        return false;
    }
  }

  function layerStress(o: number, b: V3): { normal: number; shear: number } {
    const S = nodeS;
    // traction on the layer plane, t = σ·b (Voigt: xx, yy, zz, xy, yz, zx)
    const tx = S[o] * b[0] + S[o + 3] * b[1] + S[o + 5] * b[2];
    const ty = S[o + 3] * b[0] + S[o + 1] * b[1] + S[o + 4] * b[2];
    const tz = S[o + 5] * b[0] + S[o + 4] * b[1] + S[o + 2] * b[2];
    const normal = tx * b[0] + ty * b[1] + tz * b[2];
    return { normal, shear: Math.hypot(tx - normal * b[0], ty - normal * b[1], tz - normal * b[2]) };
  }

  /**
   * The share of each element of a printed part that is solid wall or skin: walls run round the outline of every layer
   * (measured within the layer, across the build direction) and skins lie under tops and over bottoms (measured along
   * it). The grid's axis nearest the build direction stands in for it.
   */
  function shellShare(pi: number, pp: PartPrint): Float32Array {
    const out = new Float32Array(ne);
    const b = norm(pp.build);
    const ax = Math.abs(b[0]) >= Math.abs(b[1]) && Math.abs(b[0]) >= Math.abs(b[2]) ? 0 : Math.abs(b[1]) >= Math.abs(b[2]) ? 1 : 2;
    const dims = [nx, ny, nz];
    const hs = [hx, hy, hz];
    const stride = [1, nx, nx * ny];
    const u = (ax + 1) % 3,
      v = (ax + 2) % 3;
    const inside = (e: number) => active[e] === 1 && owner[e] === pi;
    // the depth of a cell's centre below the surface where it is the first cell in: a partly filled cell holds its
    // material on the inner side, so its centre sits nearer the surface (or past it)
    const first = (e: number, h: number) => (fill[e] < 0.99 ? fill[e] * h - h / 2 : h / 2);
    // within each layer: chamfer distance (depth below the outline, mm) of every cell centre
    const dW = new Float32Array(ne);
    const hu = hs[u],
      hvv = hs[v],
      hd = Math.hypot(hu, hvv);
    const hw = (hu + hvv) / 2;
    const nu_ = dims[u],
      nv_ = dims[v];
    for (let w = 0; w < dims[ax]; w++) {
      const at = (a: number, c: number) => w * stride[ax] + a * stride[u] + c * stride[v];
      // outside the part (and past the grid) a centre lies half a cell out
      const get = (a: number, c: number) => (a < 0 || c < 0 || a >= nu_ || c >= nv_ ? -hw / 2 : dW[at(a, c)]);
      for (let c = 0; c < nv_; c++)
        for (let a = 0; a < nu_; a++) {
          const e = at(a, c);
          dW[e] = inside(e) ? (fill[e] < 0.99 ? first(e, hw) : Infinity) : -hw / 2;
        }
      for (let c = 0; c < nv_; c++)
        for (let a = 0; a < nu_; a++) {
          const e = at(a, c);
          if (!inside(e)) continue;
          dW[e] = Math.min(dW[e], get(a - 1, c) + hu, get(a, c - 1) + hvv, get(a - 1, c - 1) + hd, get(a + 1, c - 1) + hd);
        }
      for (let c = nv_ - 1; c >= 0; c--)
        for (let a = nu_ - 1; a >= 0; a--) {
          const e = at(a, c);
          if (!inside(e)) continue;
          dW[e] = Math.min(dW[e], get(a + 1, c) + hu, get(a, c + 1) + hvv, get(a + 1, c + 1) + hd, get(a - 1, c + 1) + hd);
        }
    }
    // along the build direction: the depth below the nearer top or bottom
    const ha = hs[ax];
    const up = new Float32Array(ne);
    for (let c = 0; c < nv_; c++)
      for (let a = 0; a < nu_; a++) {
        let run = -Infinity;
        for (let w = 0; w < dims[ax]; w++) {
          const e = w * stride[ax] + a * stride[u] + c * stride[v];
          run = inside(e) ? (run === -Infinity ? first(e, ha) : run + ha) : -Infinity;
          up[e] = run;
        }
        run = -Infinity;
        for (let w = dims[ax] - 1; w >= 0; w--) {
          const e = w * stride[ax] + a * stride[u] + c * stride[v];
          if (!inside(e)) {
            run = -Infinity;
            continue;
          }
          run = run === -Infinity ? first(e, ha) : run + ha;
          // how much of the cell lies within the skin, and within the walls
          const depthV = Math.min(up[e], run);
          const sV = Math.min(1, Math.max(0, (pp.skin - (depthV - ha / 2)) / ha));
          const sW = Math.min(1, Math.max(0, (pp.wall - (dW[e] - hw / 2)) / hw));
          out[e] = Math.max(sV, sW);
        }
      }
    return out;
  }

  /** The S-N curves and the per-point fatigue sums for the history. */
  function fatigueSetup(fi: FatigueInput) {
    const total = fi.cycles.reduce((a, c) => a + c.count, 0) * fi.repeats;
    const design = fi.unit === "cycles" ? total : fi.repeats;
    let hi = -Infinity,
      lo = Infinity;
    for (const c of fi.cycles) {
      hi = Math.max(hi, c.max);
      lo = Math.min(lo, c.min);
    }
    const finishOf = (i: number): Finish => fi.finishes[i] ?? "machined";
    const curves: SnCurve[] = inp.materials.map((m, i) => snCurve(m, finishOf(i), fi.reliability));
    const layerCurves: (SnCurve | null)[] = inp.materials.map((m, i) => (anyLayered && m.layerFactor < 1 ? snCurve(m, finishOf(i), fi.reliability, m.layerFactor) : null));
    // brittle materials crack from the largest tension; ductile ones by von Mises, signed by the largest principal stress
    const brittle = inp.materials.map((m) => m.elongation < 5);
    const crit = new Map<string, number>();
    const critical = (mi: number, layer: boolean, sign: 1 | -1) => {
      const key = `${mi}|${layer}|${sign}`;
      let v = crit.get(key);
      if (v === undefined) crit.set(key, (v = criticalStress(sign, fi.cycles, fi.repeats, layer ? layerCurves[mi]! : curves[mi], fi.meanStress, layer)));
      return v;
    };
    return {
      design,
      total,
      hi,
      lo,
      curves,
      layerCurves,
      equivalent(mi: number, S: Float64Array, o: number, vmv: number): number {
        const p = principal(S[o], S[o + 1], S[o + 2], S[o + 3], S[o + 4], S[o + 5]);
        const big = Math.abs(p[0]) >= Math.abs(p[2]) ? p[0] : p[2];
        return brittle[mi] ? big : (big < 0 ? -1 : 1) * vmv;
      },
      at(mi: number, layer: boolean, sigma: number): { sf: number; damage: number } {
        if (!(Math.abs(sigma) > 1e-9)) return { sf: 1e6, damage: 0 };
        const c = layer ? layerCurves[mi]! : curves[mi];
        const damage = fi.repeats * damageOf(sigma, fi.cycles, c, fi.meanStress, layer);
        return { sf: critical(mi, layer, sigma > 0 ? 1 : -1) / Math.abs(sigma), damage };
      },
      shares(mi: number, layer: boolean, sigma: number) {
        return damageShares(sigma, fi.cycles, layer ? layerCurves[mi]! : curves[mi], fi.meanStress, layer);
      },
      curveInfo(): FatigueResult["curves"] {
        const out: FatigueResult["curves"] = [];
        const seen = new Set<string>();
        inp.materials.forEach((m, i) => {
          if (!matCount[i]) return;
          const key = `${m.name}|${finishOf(i)}`;
          if (seen.has(key)) return;
          seen.add(key);
          const c = curves[i];
          const equivalent = brittle[i] ? "signed largest principal stress" : "signed von Mises";
          out.push({ material: m.name, finish: c.finish, finishText: FINISHES[c.finish], ka: c.ka, ke: c.ke, su: c.su, s3: c.s3, se: c.se, tail: c.tail, equivalent });
          const lc = layerCurves[i];
          if (lc) out.push({ material: m.name, finish: lc.finish, finishText: FINISHES[lc.finish], ka: lc.ka, ke: lc.ke, su: lc.su, s3: lc.s3, se: lc.se, tail: lc.tail, equivalent: "the pull across the layers", layers: true });
        });
        return out;
      },
    };
  }
  function checkHeld() {
    // gather the directions each piece is held along (held dofs, springs and pins) and test whether they stop all six rigid motions
    const pieces = new Map<number, { nodes: number[]; dirs: V3[][] }>();
    const tmpSet = new Set<number>();
    const AXES: V3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const visit = (n: number, dirs: V3[]) => {
      tmpSet.clear();
      nodeIslands(n, tmpSet);
      for (const id of tmpSet) {
        const p = pieces.get(id) ?? { nodes: [], dirs: [] };
        p.nodes.push(n);
        p.dirs.push(dirs);
        pieces.set(id, p);
      }
    };
    for (let n = 0; n < nn; n++) {
      const held = [0, 1, 2].filter((d) => bc[3 * n + d]).map((d) => AXES[d]);
      const more = heldDirs.get(n);
      if (held.length || more) visit(n, more ? [...held, ...more] : held);
    }
    for (const [id, p] of pieces) {
      if (!islandHeld[id] || islandSize[id] < 1) continue;
      let c: V3 = [0, 0, 0];
      for (const n of p.nodes) {
        const q = nodePos(n);
        c = [c[0] + q[0], c[1] + q[1], c[2] + q[2]];
      }
      c = [c[0] / p.nodes.length, c[1] / p.nodes.length, c[2] / p.nodes.length];
      const Lc = Math.max(diag, h);
      const G = new Float64Array(36);
      const m = new Float64Array(6);
      p.nodes.forEach((n, q) => {
        const pp = nodePos(n);
        const r: V3 = [(pp[0] - c[0]) / Lc, (pp[1] - c[1]) / Lc, (pp[2] - c[2]) / Lc];
        for (const g of p.dirs[q]) {
          // how far each of the six rigid modes (Tx, Ty, Tz, Rx, Ry, Rz) moves this node along g: g, and r × g
          m[0] = g[0];
          m[1] = g[1];
          m[2] = g[2];
          m[3] = r[1] * g[2] - r[2] * g[1];
          m[4] = r[2] * g[0] - r[0] * g[2];
          m[5] = r[0] * g[1] - r[1] * g[0];
          for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) G[a * 6 + b] += m[a] * m[b];
        }
      });
      const { values, vectors } = jacobiEigen(G, 6);
      const maxV = Math.max(...values, 1e-30);
      const k = values.indexOf(Math.min(...values));
      if (values[k] < 1e-7 * maxV || values[k] < 1e-10) {
        const v = vectors.slice(k * 6, k * 6 + 6);
        const big = [0, 1, 2, 3, 4, 5].sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]))[0];
        // a free turn about a pin's own axis is what a pin is for: say so
        const rot: V3 = norm([v[3], v[4], v[5]]);
        const onPin = big >= 3 && inp.supports.find((sp) => sp.pin && sp.region.t === "cyl" && Math.abs(dot(norm(sp.region.axis), rot)) > 0.95);
        if (onPin && onPin.region.t === "cyl")
          throw new FeaError(
            `The supports do not hold the part still: it can swing about the pin at ${fmtP(onPin.region.at)}, since a pin lets it turn. Add a second pin, a spring or a fix: away from it, or hold what the load turns it with.`,
          );
        const what = big < 3 ? `slide along ${"XYZ"[big]}` : `spin about ${"XYZ"[big - 3]} (around ${fmtP(c)})`;
        throw new FeaError(`The supports do not hold the part still: it can ${what}. Fix a larger area, or add another support (fix: or roller(…)) away from the first.`);
      }
    }
  }

  // ----- heat (runHeat is called before the supports are set up, so these use only what is declared above select) -----

  /** The analysed parts' block names, and which name each part instance has. */
  function partNames(): { names: string[]; nameOf: Int32Array } {
    const names = [...partsByName.keys()];
    const nameOf = new Int32Array(inp.parts.length);
    names.forEach((nm, k) => partsByName.get(nm)!.forEach((pi) => (nameOf[pi] = k)));
    return { names, nameOf };
  }

  /** The kept node nearest a point. */
  function nearestKept(p: V3): number {
    let bestN = 0,
      bestD = Infinity;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++) {
        const n = n0 + off[a];
        const i = n % NX,
          j = Math.floor(n / NX) % NY,
          k = Math.floor(n / (NX * NY));
        const d = (origin[0] + i * hx - p[0]) ** 2 + (origin[1] + j * hy - p[1]) ** 2 + (origin[2] + k * hz - p[2]) ** 2;
        if (d < bestD) {
          bestD = d;
          bestN = n;
        }
      }
    }
    return bestN;
  }

  /**
   * Each block name's nodes (the corners of the elements its instances own), and per node the name it was last
   * listed under. A part too small to own an element gets the kept node nearest its middle.
   */
  function nodesByName(names: string[], nameOf: Int32Array): { lists: Int32Array[]; nodeName: Int32Array } {
    const cellsOf: number[][] = names.map(() => []);
    for (let e = 0; e < ne; e++) if (active[e]) cellsOf[nameOf[owner[e]]].push(e);
    const nodeName = new Int32Array(nn).fill(-1);
    // name by name, so a node two names share is listed under both
    const lists = cellsOf.map((cells, k) => {
      const list: number[] = [];
      for (const e of cells) {
        const n0 = elemNode0(e);
        for (let a = 0; a < 8; a++) {
          const n = n0 + off[a];
          if (nodeName[n] === k) continue;
          nodeName[n] = k;
          list.push(n);
        }
      }
      if (!list.length) {
        const [l, u] = meshBounds([inp.parts[partsByName.get(names[k])![0]].mesh]);
        const n = nearestKept([(l[0] + u[0]) / 2, (l[1] + u[1]) / 2, (l[2] + u[2]) / 2]);
        list.push(n);
        if (nodeName[n] < 0) nodeName[n] = k;
      }
      return Int32Array.from(list);
    });
    return { lists, nodeName };
  }

  /** The temperature limit of a part: the analysis's max_temp:, or its material's long-use limit. */
  function limitOf(tm: ThermalMaterial, maxTemp: number | undefined): { limit: number; why: string } {
    if (maxTemp !== undefined) return { limit: maxTemp, why: "the analysis's max_temp:" };
    if (tm.name === COMPONENT_THERMAL.name) return { limit: tm.maxC, why: "a typical rating for electronics" };
    return { limit: tm.maxC, why: tm.softens ? `${tm.name} softens past it` : `${tm.name}'s long-use limit` };
  }

  /** Per part, the hottest point, the mean and the limit; overall the hottest and coolest points and the hottest surface spots. */
  function tempStats(T: Float64Array, valid: Uint8Array, nb: { lists: Int32Array[]; nodeName: Int32Array }, names: string[], ambient: number, maxTemp: number | undefined): Pick<ThermalResult, "maxTemp" | "minTemp" | "parts" | "hotSpots"> {
    const tms = inp.thermalMaterials!;
    const parts = names.map((nm, k) => {
      const list = nb.lists[k];
      let mx = -Infinity,
        at = list[0] ?? 0,
        sum = 0;
      for (let x = 0; x < list.length; x++) {
        const v = T[list[x]];
        sum += v;
        if (v > mx) {
          mx = v;
          at = list[x];
        }
      }
      const tm = tms[inp.parts[partsByName.get(nm)![0]].material];
      const lim = limitOf(tm, maxTemp);
      return { name: nm, max: mx, mean: sum / Math.max(1, list.length), at: nodePos(at), limit: lim.limit, limitWhy: lim.why, material: tm.name, assumed: !!tm.assumed };
    });
    let hot = 0;
    parts.forEach((p, k) => {
      if (p.max > parts[hot].max) hot = k;
    });
    let lowN = -1;
    for (let n = 0; n < nn; n++) if (valid[n] && (lowN < 0 || T[n] < T[lowN])) lowN = n;
    const maxT = parts.length ? parts[hot].max : ambient;
    // the hottest surface spots, spread apart
    const surf = new Uint8Array(nn);
    for (let q = 0; q < faces.fe.length; q++) {
      const n0 = elemNode0(faces.fe[q]);
      for (const a of FACE_CORNERS[faces.fd[q]]) surf[n0 + off[a]] = 1;
    }
    const cand: number[] = [];
    for (let n = 0; n < nn; n++) if (surf[n] && valid[n]) cand.push(n);
    cand.sort((a, b) => T[b] - T[a]);
    const spots: number[] = [];
    for (const n of cand) {
      if (spots.length >= 3 || T[n] - ambient < 0.5 * (maxT - ambient) || maxT - ambient < 0.5) break;
      const p = nodePos(n);
      if (spots.every((m) => dist(nodePos(m), p) > Math.max(6 * hmax, 0.12 * diag))) spots.push(n);
    }
    return {
      maxTemp: { value: maxT, at: parts.length ? parts[hot].at : [0, 0, 0], part: parts.length ? parts[hot].name : "" },
      minTemp: { value: lowN >= 0 ? T[lowN] : ambient, at: lowN >= 0 ? nodePos(lowN) : [0, 0, 0] },
      parts,
      hotSpots: spots.map((n) => ({ at: nodePos(n), temp: T[n], part: names[nb.nodeName[n]] ?? "" })),
    };
  }

  /** A field on the grid nodes at a point (trilinear over the valid corners, else the nearest valid node). */
  function sampleScalar(field: Float64Array, valid: Uint8Array, x: number, y: number, z: number, fallback: number): number {
    const fx = (x - origin[0]) / hx,
      fy = (y - origin[1]) / hy,
      fz = (z - origin[2]) / hz;
    const i = clampI(Math.floor(fx), 0, nx - 1),
      j = clampI(Math.floor(fy), 0, ny - 1),
      k = clampI(Math.floor(fz), 0, nz - 1);
    const tx = clamp01(fx - i),
      ty = clamp01(fy - j),
      tz = clamp01(fz - k);
    const n0 = i + NX * (j + NY * k);
    let s = 0,
      wsum = 0;
    for (let a = 0; a < 8; a++) {
      const n = n0 + off[a];
      if (!valid[n]) continue;
      const w = (a & 1 ? tx : 1 - tx) * (a & 2 ? ty : 1 - ty) * (a & 4 ? tz : 1 - tz) + 1e-9;
      s += w * field[n];
      wsum += w;
    }
    if (wsum > 1e-6) return s / wsum;
    let bestN = -1,
      bestD = Infinity;
    for (let c = Math.max(0, k - 2); c <= Math.min(NZ - 1, k + 3); c++)
      for (let b = Math.max(0, j - 2); b <= Math.min(NY - 1, j + 3); b++)
        for (let a = Math.max(0, i - 2); a <= Math.min(NX - 1, i + 3); a++) {
          const n = a + NX * (b + NY * c);
          if (!valid[n]) continue;
          const d = (a - fx) ** 2 + (b - fy) ** 2 + (c - fz) ** 2;
          if (d < bestD) {
            bestD = d;
            bestN = n;
          }
        }
    return bestN >= 0 ? field[bestN] : fallback;
  }

  /** Heat conduction through the active elements: films and radiation on the exposed faces, heat made, held temperatures. */
  function runHeat(): { T: Float64Array; on: Uint8Array; J: Float64Array | null; result: ThermalResult; ms: number } {
    const th = inp.thermal!;
    const tms = inp.thermalMaterials!;
    const tStart = now();
    progress("Heat: setting up", 0.22);
    const cellArr: number[] = [];
    for (let e = 0; e < ne; e++) if (active[e]) cellArr.push(e);
    const cells = Int32Array.from(cellArr);
    const V = hx * hy * hz;
    const kc = new Float64Array(cells.length);
    const cap = new Float64Array(cells.length);
    cells.forEach((e, c) => {
      const tm = tms[inp.parts[owner[e]].material];
      // W/(m·K) → W/(mm·K); g/cm³ → g/mm³, times J/(g·K) and mm³: J/K
      kc[c] = (tm.k / 1000) * fill[e];
      cap[c] = (tm.density / 1000) * tm.cp * V * fill[e];
    });

    // cooling: a quarter of each exposed cell face goes to each of its corners, its area corrected for the voxel staircase
    const quarter = [(hy * hz) / 4, (hy * hz) / 4, (hx * hz) / 4, (hx * hz) / 4, (hx * hy) / 4, (hx * hy) / 4];
    const rawArea = new Float64Array(nn);
    const area = new Float64Array(nn);
    for (let q = 0; q < faces.fe.length; q++) {
      const e = faces.fe[q],
        d = faces.fd[q];
      const n0 = elemNode0(e);
      for (const c of FACE_CORNERS[d]) {
        rawArea[n0 + off[c]] += quarter[d];
        area[n0 + off[c]] += quarter[d] * areaScale[owner[e]];
      }
    }
    const hA = new Float64Array(nn);
    const hAT = new Float64Array(nn);
    // films replace the overall cooling where they reach; a later film only takes what earlier ones left
    const covered = new Float64Array(nn);
    th.films.forEach((fl, i) => {
      const sel = select(fl.region);
      if (!sel.nodes.length) throw new FeaError(`Cooling ${i + 1} (film on ${describeRegion(fl.region)}) does not touch the parts' surface. Move the zone onto the part.`);
      const hm = fl.h / 1e6;
      const ta = fl.ambient ?? th.ambient;
      sel.nodes.forEach((n, s) => {
        const a = Math.min(area[n] - covered[n], rawArea[n] > 0 ? (sel.w[s] * area[n]) / rawArea[n] : 0);
        if (!(a > 0)) return;
        covered[n] += a;
        hA[n] += hm * a;
        hAT[n] += hm * a * ta;
      });
    });
    const hDef = th.cooling / 1e6;
    const eps = th.emissivity !== undefined && th.emissivity > 0 ? Math.min(1, th.emissivity) : 0;
    const epsA = eps ? new Float64Array(nn) : undefined;
    for (let n = 0; n < nn; n++) {
      if (!(area[n] > 0)) continue;
      const rest = area[n] - covered[n];
      if (hDef > 0 && rest > 0) {
        hA[n] += hDef * rest;
        hAT[n] += hDef * rest * th.ambient;
      }
      if (epsA) epsA[n] = eps * area[n];
    }

    // heat made: through a part's volume, or over a region of its surface
    const q = new Float64Array(nn);
    const sources: ThermalResult["sources"] = [];
    const ownCells: number[][] = inp.parts.map(() => []);
    for (const e of cells) ownCells[owner[e]].push(e);
    const tooSmall = new Set<string>();
    const spread = (pi: number, watts: number) => {
      const list = ownCells[pi];
      let vol = 0;
      for (const e of list) vol += fill[e];
      if (!(vol > 0)) {
        const [l, u] = meshBounds([inp.parts[pi].mesh]);
        q[nearestKept([(l[0] + u[0]) / 2, (l[1] + u[1]) / 2, (l[2] + u[2]) / 2])] += watts;
        tooSmall.add(inp.parts[pi].name);
        return;
      }
      for (const e of list) {
        const w = (watts * fill[e]) / vol / 8;
        const n0 = elemNode0(e);
        for (let a = 0; a < 8; a++) q[n0 + off[a]] += w;
      }
    };
    th.heat.forEach((hl, i) => {
      if (!(Number.isFinite(hl.watts) && hl.watts >= 0)) throw new FeaError(`Heat ${i + 1} (${hl.label}): the power should be a number of watts, 0 or more.`);
      const why = hl.why ? { why: hl.why } : {};
      if (hl.id !== undefined || hl.part !== undefined) {
        const idx = hl.id !== undefined ? inp.parts.flatMap((p, pi) => (p.id === hl.id ? [pi] : [])) : (partsByName.get(hl.part!) ?? []);
        if (!idx.length) throw new FeaError(`Heat ${i + 1} (${hl.label}): "${hl.part ?? hl.id}" is not one of the analysed parts (${[...partsByName.keys()].join(", ")}). Add it to parts:.`);
        for (const pi of idx) spread(pi, hl.watts);
        sources.push({ label: hl.label, watts: hl.watts * idx.length, ...why });
      } else if (hl.region) {
        const sel = select(hl.region);
        if (!sel.nodes.length) throw new FeaError(`Heat ${i + 1} (${hl.label} on ${describeRegion(hl.region)}) does not touch the parts' surface. Move the zone onto the part.`);
        const tot = sel.w.reduce((s, v) => s + v, 0) || 1;
        sel.nodes.forEach((n, s) => (q[n] += (hl.watts * sel.w[s]) / tot));
        sources.push({ label: hl.label, watts: hl.watts, ...why });
      }
    });
    if (tooSmall.size) {
      const list = [...tooSmall];
      warnings.push(`${list.join(", ")} ${list.length > 1 ? "are" : "is"} smaller than the ${fmt(h)} mm elements, so ${list.length > 1 ? "their" : "its"} heat is put at the nearest solid point. Use a smaller resolution: to see ${list.length > 1 ? "their" : "its"} own temperature.`);
    }

    // current through conductors: its Joule heat, worked out from the potential across them at each pass's temperatures
    const qBase = Float64Array.from(q);
    const joule = th.currents?.length ? currentSetup() : null;
    const startT = th.time !== undefined && th.time > 0 ? (th.start ?? th.ambient) : th.ambient;
    let jl = joule ? jouleAt(joule, null, startT) : null;
    const jouleCold = joule ? jouleAt(joule, null, 20) : null;
    const addJoule = () => {
      if (jl) for (let n = 0; n < nn; n++) q[n] = qBase[n] + jl.qJ[n];
    };
    addJoule();

    // surfaces held at a temperature
    const fixedT = new Float64Array(nn).fill(NaN);
    th.fixed.forEach((ft, i) => {
      const sel = select(ft.region);
      if (!sel.nodes.length) throw new FeaError(`Held temperature ${i + 1} (${fmt(ft.temp, 0)} °C on ${describeRegion(ft.region)}) does not touch the parts' surface. Move the zone onto the part.`);
      for (const n of sel.nodes) fixedT[n] = ft.temp;
    });
    // a held surface is pressed against what holds it, so the air does not cool it as well
    for (let n = 0; n < nn; n++)
      if (Number.isFinite(fixedT[n])) {
        hA[n] = 0;
        hAT[n] = 0;
        if (epsA) epsA[n] = 0;
      }
    const g: HeatGrid = { n: [nx, ny, nz], h: hv, cells, kc, cap, hA, hAT, ...(epsA ? { epsA } : {}), ambient: th.ambient, q, fixedT };
    const on = activeNodes(g);

    // pieces heat cannot cross between (elements touching at an edge or a corner still conduct), and whether
    // anything takes heat away from each: in a steady state a heated piece with no way out has no answer
    const trapped: { names: string[]; watts: number }[] = [];
    {
      const piece = new Int32Array(ne).fill(-1);
      const pieces: { path: boolean; watts: number; parts: Set<number> }[] = [];
      const queue = new Int32Array(cells.length);
      for (const e0 of cells) {
        if (piece[e0] >= 0) continue;
        const id = pieces.length;
        const pc = { path: false, watts: 0, parts: new Set<number>() };
        pieces.push(pc);
        let head = 0,
          tail = 0;
        queue[tail++] = e0;
        piece[e0] = id;
        while (head < tail) {
          const e = queue[head++];
          pc.parts.add(owner[e]);
          const i = e % nx,
            j = Math.floor(e / nx) % ny,
            k = Math.floor(e / (nx * ny));
          for (let dk = -1; dk <= 1; dk++)
            for (let dj = -1; dj <= 1; dj++)
              for (let di = -1; di <= 1; di++) {
                const a = i + di,
                  b = j + dj,
                  c = k + dk;
                if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
                const e2 = eIndex(a, b, c);
                if (active[e2] && piece[e2] < 0) {
                  piece[e2] = id;
                  queue[tail++] = e2;
                }
              }
        }
      }
      const nodePiece = new Int32Array(nn).fill(-1);
      for (const e of cells) {
        const n0 = elemNode0(e);
        for (let a = 0; a < 8; a++) nodePiece[n0 + off[a]] = piece[e];
      }
      for (let n = 0; n < nn; n++) {
        const id = nodePiece[n];
        if (id < 0) continue;
        pieces[id].watts += q[n];
        if (hA[n] > 0 || (epsA && epsA[n] > 0) || Number.isFinite(fixedT[n])) pieces[id].path = true;
      }
      for (const pc of pieces) if (!pc.path && pc.watts > 1e-9) trapped.push({ names: [...new Set([...pc.parts].map((pi) => inp.parts[pi].name))], watts: pc.watts });
    }
    if (trapped.length && !th.time)
      throw new FeaError(
        `The ${fmt(trapped[0].watts, 2)} W made in ${trapped[0].names.join(", ")} has nowhere to go: no cooling, film or held temperature reaches ${trapped[0].names.length > 1 ? "them" : "it"}, so it would heat up without limit. ` +
          `Give it cooling: (for example cooling: "still air"), a film(...) or a held temperature, or run a warm-up with time: to see how hot it gets.`,
      );

    const { names, nameOf } = partNames();
    const nb = nodesByName(names, nameOf);
    const limits = names.map((nm) => limitOf(tms[inp.parts[partsByName.get(nm)![0]].material], th.maxTemp).limit);
    let T: Float64Array;
    let iterations = 0,
      residual = 0,
      converged = true;
    let transient: ThermalResult["transient"];
    let balance: ThermalResult["balance"] = null;
    if (th.time !== undefined && th.time > 0) {
      const time = th.time;
      const start = th.start ?? th.ambient;
      const times: number[] = [];
      const maxs: number[] = [];
      const per: number[][] = names.map(() => []);
      const warm = () => {
        times.length = 0;
        maxs.length = 0;
        for (const p of per) p.length = 0;
        progress("Heat: warming up", 0.25);
        return solveTransient(g, time, start, (t, Tn) => {
          times.push(t);
          let m = -Infinity;
          for (let n = 0; n < nn; n++) if (on[n] && Tn[n] > m) m = Tn[n];
          maxs.push(m);
          nb.lists.forEach((list, k) => {
            let pm = -Infinity;
            for (let x = 0; x < list.length; x++) if (Tn[list[x]] > pm) pm = Tn[list[x]];
            per[k].push(pm);
          });
          progress("Heat: warming up", 0.25 + 0.6 * Math.min(1, t / time));
        });
      };
      let s = warm();
      // the current's heat was worked out at the starting temperature: if the resistance moves much as it warms, run
      // the warm-up again with the resistance halfway between its start and its end
      if (joule && jl) {
        const end = jouleAt(joule, s.T, 0);
        if (Math.abs(end.total - jl.total) > 0.03 * Math.max(jl.total, 1e-12)) {
          const mid = Float64Array.from(s.T, (v) => (v + start) / 2);
          jl = jouleAt(joule, mid, 0);
          addJoule();
          iterations += s.iterations;
          s = warm();
          warnings.push("The current's resistance changes as the conductors warm, so the warm-up takes it halfway between its value at the start and at the end.");
        }
      }
      T = s.T;
      iterations += s.iterations;
      residual = s.residual;
      converged = s.converged;
      let settles: number | null = null;
      if (!trapped.length) {
        progress("Heat: where it settles", 0.87);
        // where it settles, with the current's heat at the settled temperatures
        const qWarm = Float64Array.from(q);
        const jlWarm = jl;
        let ss = solveSteady(g, { start: T });
        if (joule && jl) {
          const st = settleCurrent(ss);
          ss = st.s;
          iterations += st.iterations;
        }
        q.set(qWarm);
        jl = jlWarm;
        let m = -Infinity;
        for (let n = 0; n < nn; n++) if (on[n] && ss.T[n] > m) m = ss.T[n];
        settles = m;
        iterations += ss.iterations;
      }
      let overLimit: { part: string; time: number } | null = null;
      for (let k = 0; k < names.length; k++) {
        const series = per[k];
        const L = limits[k];
        const i = series.findIndex((v) => v > L);
        if (i < 0) continue;
        const t = i === 0 ? 0 : times[i - 1] + ((L - series[i - 1]) / Math.max(series[i] - series[i - 1], 1e-12)) * (times[i] - times[i - 1]);
        if (!overLimit || t < overLimit.time) overLimit = { part: names[k], time: t };
      }
      transient = { time, start, times, max: maxs, parts: names.map((nm, k) => ({ name: nm, max: per[k] })), settles, overLimit };
    } else {
      progress("Heat: solving", 0.3);
      let s = solveSteady(g);
      iterations = s.iterations;
      // the current's heat at the temperatures it makes, until they agree: a conductor's resistance rises as it warms
      if (joule && jl) {
        const settledS = settleCurrent(s);
        s = settledS.s;
        iterations += settledS.iterations;
      }
      T = s.T;
      residual = s.residual;
      converged = s.converged;
      balance = heatBalance(g, T);
    }
    if (!converged) warnings.push(`The heat solver stopped at a relative residual of ${residual.toExponential(1)}; temperatures may be off by a few percent.`);
    const notes = new Set<string>();
    for (const p of inp.parts) {
      const tm = tms[p.material];
      if (tm.note) notes.add(tm.note);
    }
    for (const n of notes) warnings.push(n);
    progress("Heat: done", 0.95);
    // what each current did, at the temperatures it ended at, and how dense it runs (the field shown on the parts)
    let currents: CurrentResult[] | undefined;
    let currentPeak: ThermalResult["currentPeak"];
    let J: Float64Array | null = null;
    if (joule && jl && jouleCold) {
      const fin = th.time !== undefined && th.time > 0 ? jouleAt(joule, T, 0) : jl;
      currents = joule.terminals.map((tm, i) => {
        const p = fin.per[i];
        const shares = new Map<string, number>();
        const own = joulePower(joule.grid, Float64Array.from(tm.phi!, (v) => v * p.volts));
        own.power.forEach((w, k) => {
          const nm = inp.parts[owner[joule.grid.cells[k]]].name;
          shares.set(nm, (shares.get(nm) ?? 0) + w);
        });
        const parts = [...shares]
          .map(([name, w]) => ({ name, share: w / Math.max(own.total, 1e-30) }))
          .filter((x) => x.share >= 0.01)
          .sort((a, b) => b.share - a.share);
        sources.push({ label: tm.cs.label, watts: p.watts, why: `I²R, ${amps(p.amps)} through ${ohms(p.ohms)}` });
        return { label: tm.cs.label, from: describeRegion(tm.cs.from), to: describeRegion(tm.cs.to), amps: p.amps, volts: p.volts, ohms: p.ohms, watts: p.watts, cold: jouleCold.per[i], driven: tm.cs.amps !== undefined ? "amps" : "volts", parts };
      });
      // per node: the current density of the conducting cells around it (none in the parts that do not conduct)
      J = new Float64Array(nn);
      const wsum = new Float64Array(nn);
      let best = -1;
      fin.density.forEach((d, k) => {
        const e = joule.grid.cells[k];
        const n0 = elemNode0(e);
        for (let a = 0; a < 8; a++) {
          J![n0 + off[a]] += fill[e] * d;
          wsum[n0 + off[a]] += fill[e];
        }
        if (best < 0 || d > fin.density[best]) best = k;
      });
      for (let n = 0; n < nn; n++) if (wsum[n] > 0) J[n] /= wsum[n];
      if (best >= 0) {
        const e = joule.grid.cells[best];
        const i = e % nx,
          j = Math.floor(e / nx) % ny,
          k = Math.floor(e / (nx * ny));
        // the median density over the cells the current really runs through, to say how much it crowds at its peak
        const run = Float64Array.from(fin.density.filter((d) => d > 0.02 * fin.density[best])).sort();
        const typical = run.length ? run[run.length >> 1] : fin.density[best];
        currentPeak = { value: fin.density[best], at: [origin[0] + (i + 0.5) * hx, origin[1] + (j + 0.5) * hy, origin[2] + (k + 0.5) * hz], part: inp.parts[owner[e]].name, typical };
      }
      const made = currents.reduce((a, c) => a + c.watts, 0);
      if (Math.abs(made - fin.total) > 0.02 * Math.max(fin.total, 1e-12))
        warnings.push(`The currents share conductors, so their heat together (${fmt(fin.total, 3)} W) is not the sum of each one's I²R (${fmt(made, 3)} W); the temperatures use the heat together.`);
      const notes = new Set(joule.grid.cells.length ? inp.electricMaterials!.flatMap((m) => (m.note && m.conductor ? [m.note] : [])) : []);
      for (const n of notes) warnings.push(n);
    }
    const result: ThermalResult = {
      ambient: th.ambient,
      ...(th.ambientWhy ? { ambientWhy: th.ambientWhy } : {}),
      cooling: th.coolingText,
      ...tempStats(T, on, nb, names, th.ambient, th.maxTemp),
      sources,
      balance,
      ...(transient ? { transient } : {}),
      ...(currents ? { currents } : {}),
      ...(currentPeak ? { currentPeak } : {}),
      solve: { iterations, residual, converged, ms: now() - tStart },
    };
    return { T, on, J, result, ms: now() - tStart };

    /** The conducting cells, and each current's two ends checked: on the parts, on metal, apart. */
    function currentSetup() {
      const ems = inp.electricMaterials;
      if (!ems || ems.length !== inp.materials.length) throw new FeaError("Electrical properties are missing for the analysed materials.");
      const list: number[] = [];
      for (const e of cells) if (ems[inp.parts[owner[e]].material].conductor) list.push(e);
      const grid: CurrentGrid = { n: [nx, ny, nz], h: hv, cells: Int32Array.from(list), sigma: new Float64Array(list.length), bulk: new Float64Array(list.length) };
      const cond = new Uint8Array(nn);
      for (const e of grid.cells) {
        const n0 = elemNode0(e);
        for (let a = 0; a < 8; a++) cond[n0 + off[a]] = 1;
      }
      const onWhat = (r: RegionSpec) => {
        if (r.t === "face") {
          const pi = partsByName.get(r.part)?.[0];
          if (pi !== undefined) return `${r.part} (${inp.materials[inp.parts[pi].material].name})`;
        }
        return "a part";
      };
      const terminals = th.currents!.map((cs, i) => {
        const name = `Current ${i + 1} (${cs.label})`;
        const ends = [cs.from, cs.to].map((r, k) => {
          const sel = select(r);
          const where = k ? "where it comes out" : "where it goes in";
          if (!sel.nodes.length) throw new FeaError(`${name}: ${where} (${describeRegion(r)}) does not touch the parts' surface. Move the zone onto the part.`);
          const at = sel.nodes.filter((n) => cond[n]);
          if (!at.length) throw new FeaError(`${name}: ${where} (${describeRegion(r)}) is on ${onWhat(r)}, which does not conduct. Put it on a metal part, or give the part a metal material.`);
          return at;
        });
        const out = new Set(ends[1]);
        if (ends[0].some((n) => out.has(n))) throw new FeaError(`${name}: where it goes in (${describeRegion(cs.from)}) and where it comes out (${describeRegion(cs.to)}) overlap. Pick two separate ends, like face(bar, -X) and face(bar, +X).`);
        return { cs, name, from: Int32Array.from(ends[0]), to: Int32Array.from(ends[1]), phi: null as Float64Array | null, ref: 0 };
      });
      let sMax = 0;
      for (const e of grid.cells) sMax = Math.max(sMax, 1 / (ems[inp.parts[owner[e]].material].rho * 1000));
      return { ems, grid, cond, terminals, tiny: 1e-12 * sMax * Math.min(hx, hy, hz) };
    }

    /** Each current's resistance and power, and the heat it makes at each node, with the conductors at these temperatures (per node, or T0 everywhere). */
    function jouleAt(jx: NonNullable<ReturnType<typeof currentSetup>>, Tn: Float64Array | null, T0: number) {
      const { ems, grid, cond, terminals } = jx;
      for (let k = 0; k < grid.cells.length; k++) {
        const e = grid.cells[k];
        let t = T0;
        if (Tn) {
          const n0 = elemNode0(e);
          let sum = 0;
          for (let a = 0; a < 8; a++) sum += Tn[n0 + off[a]];
          t = sum / 8;
        }
        // Ω·m → Ω·mm, so σ is in S/mm
        grid.bulk[k] = 1 / (rhoAt(ems[inp.parts[owner[e]].material], t) * 1000);
        grid.sigma[k] = grid.bulk[k] * fill[e];
      }
      const phi = new Float64Array(nn);
      const per = terminals.map((tm) => {
        const sol: CurrentSolve = solveCurrent(grid, tm.from, tm.to, tm.phi ? { phi: tm.phi, ref: tm.ref } : undefined);
        tm.phi = sol.phi;
        tm.ref = sol.ref;
        if (!(sol.conductance > jx.tiny))
          throw new FeaError(`${tm.name}: no metal joins where it goes in (${describeRegion(tm.cs.from)}) to where it comes out (${describeRegion(tm.cs.to)}), so it has nowhere to flow. The conducting parts must touch along the way.`);
        const short = `${tm.name}: the current solve stopped short of full accuracy; its resistance may be off by a percent or so.`;
        if (!sol.converged && !warnings.includes(short)) warnings.push(short);
        const ohms = 1 / sol.conductance;
        const volts = tm.cs.amps !== undefined ? tm.cs.amps * ohms : tm.cs.volts!;
        for (let n = 0; n < nn; n++) if (cond[n]) phi[n] += volts * sol.phi[n];
        return { amps: volts / ohms, volts, ohms, watts: (volts * volts) / ohms };
      });
      const jp = joulePower(grid, phi);
      const qJ = new Float64Array(nn);
      for (let k = 0; k < grid.cells.length; k++) {
        const n0 = elemNode0(grid.cells[k]);
        const w = jp.power[k] / 8;
        for (let a = 0; a < 8; a++) qJ[n0 + off[a]] += w;
      }
      return { per, qJ, total: jp.total, density: jp.density };
    }

    /**
     * Steady temperatures and the current's heat that agree: the heat at the latest temperatures sets the next solve,
     * by a secant step on (heat made − heat assumed) once there are two passes, so a conductor whose resistance rises
     * linearly with temperature settles in three or four. A current whose heat outruns the cooling runs away.
     */
    function settleCurrent(s0: HeatSolve): { s: HeatSolve; iterations: number } {
      let s = s0;
      let iterations = 0;
      const cold = jl!.total;
      let used = jl!.total;
      let usedPrev = 0;
      let gapPrev: number | null = null;
      for (let pass = 0; pass < 14; pass++) {
        jl = jouleAt(joule!, s.T, 0);
        const made = jl.total;
        const gap = made - used;
        if (Math.abs(gap) <= 0.003 * Math.max(made, 1e-12)) {
          addJoule();
          return { s, iterations };
        }
        if (made > 20 * Math.max(cold, 1e-12))
          throw new FeaError(
            `The current runs away: its heat keeps rising as the conductor warms (${fmt(cold, 2)} W cold, over ${fmt(made, 1)} W and climbing), because its resistance grows faster than the cooling can take the heat away. It would overheat until it fuses. ` +
              `Use a thicker conductor or a better conducting metal, less current, or more cooling.`,
          );
        let next = made;
        if (gapPrev !== null && Math.abs(gap - gapPrev) > 1e-12 * made) {
          const step = used - (gap * (used - usedPrev)) / (gap - gapPrev);
          if (step > 0 && step < 4 * made) next = step;
        }
        usedPrev = used;
        gapPrev = gap;
        used = next;
        const k = next / made;
        for (let n = 0; n < nn; n++) q[n] = qBase[n] + k * jl.qJ[n];
        progress("Heat: current and temperature", Math.min(0.85, 0.3 + 0.05 * pass));
        s = solveSteady(g, { start: s.T });
        iterations += s.iterations;
      }
      warnings.push("The current's heat and the temperatures it makes had not quite settled after 14 passes; the temperatures may be off by a degree or two.");
      return { s, iterations };
    }
  }

  /** Current density at each vertex of a surface (A/mm²), widening ranges.current to take it in. */
  function currentAt(J: Float64Array, valid: Uint8Array, P: ArrayLike<number>, ranges: { current?: [number, number] }): Float32Array {
    const nv = P.length / 3;
    const out = new Float32Array(nv);
    for (let v = 0; v < nv; v++) {
      const x = sampleScalar(J, valid, P[3 * v], P[3 * v + 1], P[3 * v + 2], 0);
      out[v] = x;
      if (ranges.current) ranges.current[1] = Math.max(ranges.current[1], x);
    }
    return out;
  }

  /** A heat analysis with nothing holding the parts: temperatures only, with empty stress fields. */
  function heatOnlyResult(r: { T: Float64Array; on: Uint8Array; J: Float64Array | null; result: ThermalResult; ms: number }): StructuralResult {
    const tPost = now();
    const temp: [number, number] = [Infinity, -Infinity];
    const cur: { current?: [number, number] } = r.J ? { current: [0, 0] } : {};
    const parts: PartField[] = inp.parts.map((p) => {
      const P = p.mesh.positions;
      const nv = P.length / 3;
      const t = new Float32Array(nv);
      for (let v = 0; v < nv; v++) {
        const x = sampleScalar(r.T, r.on, P[3 * v], P[3 * v + 1], P[3 * v + 2], r.result.ambient);
        t[v] = x;
        if (x < temp[0]) temp[0] = x;
        if (x > temp[1]) temp[1] = x;
      }
      return {
        id: p.id,
        name: p.name,
        positions: Float32Array.from(P),
        normals: p.normals ?? null,
        indices: p.mesh.indices,
        disp: new Float32Array(3 * nv),
        stress: new Float32Array(nv),
        strain: new Float32Array(nv),
        safety: new Float32Array(nv).fill(1e6),
        temp: t,
        ...(r.J ? { current: currentAt(r.J, r.on, P, cur) } : {}),
      };
    });
    temp[0] = Math.min(temp[0], r.result.minTemp.value);
    temp[1] = Math.max(temp[1], r.result.maxTemp.value);
    // the legend reaches the densest cell, as the label on it says
    if (cur.current && r.result.currentPeak) cur.current[1] = Math.max(cur.current[1], r.result.currentPeak.value);
    let mass = 0,
      solid = 0,
      partial = 0,
      nodes = 0;
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const v = fill[e] * hx * hy * hz;
      solid += v;
      mass += (v / 1000) * inp.materials[inp.parts[owner[e]].material].density;
      if (fill[e] < 0.9) partial++;
    }
    for (let n = 0; n < nn; n++) if (r.on[n]) nodes++;
    const inside = sampleInterior({ n: [NX, NY, NZ], origin, h: hv }, (n) => r.on[n] > 0, [(n) => r.T[n], ...(r.J ? [(n: number) => r.J![n]] : [])]);
    const tEnd = now();
    progress("Done", 1);
    return {
      label: inp.label,
      interior: { origin: inside.origin, step: inside.step, n: inside.n, temp: inside.scalars[0], ...(r.J ? { current: inside.scalars[1] } : {}) },
      mesh: { h, cell: hv, grid: [nx, ny, nz], elements: nActive, nodes, dofs: nodes, levels: 1, partial: partial / Math.max(1, nActive) },
      solve: { iterations: r.result.solve.iterations, residual: r.result.solve.residual, converged: r.result.solve.converged, history: [], ms: { mesh: tMesh - t0, setup: 0, solve: r.ms, post: tEnd - tPost, total: tEnd - t0 } },
      maxDisp: { value: 0, at: [0, 0, 0] },
      maxStress: { value: 0, at: [0, 0, 0], nearBoundary: false, away: null },
      maxStrain: { value: 0, at: [0, 0, 0] },
      minSafety: { value: 1e6, at: [0, 0, 0], mode: "yield", allowable: 0, material: inp.materials[0]?.name ?? "", nearBoundary: false, away: null },
      layer: null,
      hotSpots: [],
      applied: [0, 0, 0],
      reaction: [0, 0, 0],
      equilibrium: 0,
      mass,
      volume: solid,
      loads: [],
      supports: [],
      gravity: null,
      parts,
      ranges: { stress: [0, 0], disp: [0, 0], strain: [0, 0], safety: [1e6, 1e6], temp, ...cur },
      warnings,
      materials: inp.materials.map((m) => {
        const a = allowableStress(m, inp.cycles);
        return { name: m.name, E: m.E, yield: m.yield, allowable: a.value, basis: a.basis, layerFactor: m.layerFactor, assumed: !!m.assumed };
      }),
      thermal: r.result,
      heatOnly: true,
    };
  }

  /** The whole model at one set temperature (temperature: 60C): what that means for each part's limit. */
  function uniformThermal(T: Float64Array, ref: number): ThermalResult {
    const on = new Uint8Array(nn);
    for (let e = 0; e < ne; e++) {
      if (!active[e]) continue;
      const n0 = elemNode0(e);
      for (let a = 0; a < 8; a++) on[n0 + off[a]] = 1;
    }
    const { names, nameOf } = partNames();
    const t = inp.uniformTemp ?? ref;
    return {
      ambient: t,
      ambientWhy: "the temperature: set for the whole model",
      cooling: "",
      ...tempStats(T, on, nodesByName(names, nameOf), names, t, undefined),
      hotSpots: [],
      sources: [],
      balance: null,
      solve: { iterations: 0, residual: 0, converged: true, ms: 0 },
      refTemp: ref,
    };
  }
}

const clampI = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Surface area of a triangle mesh, mm². */
function meshArea(m: TriMesh): number {
  const P = m.positions,
    I = m.indices;
  let a = 0;
  for (let t = 0; t < I.length; t += 3) {
    const i = 3 * I[t],
      j = 3 * I[t + 1],
      k = 3 * I[t + 2];
    const ux = P[j] - P[i],
      uy = P[j + 1] - P[i + 1],
      uz = P[j + 2] - P[i + 2];
    const vx = P[k] - P[i],
      vy = P[k + 1] - P[i + 1],
      vz = P[k + 2] - P[i + 2];
    a += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return a;
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Fatigue life over the design life as log10, kept to -6..9 (9: no limit, below the endurance limit). */

export const lifeLog = (ratio: number) => (ratio === Infinity || !(ratio < 1e9) ? 9 : ratio <= 1e-6 ? -6 : Math.log10(ratio));
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export { CORNERS };

/**
 * A seat that is only pressed on: from the reaction at each of its nodes, the
 * net force pressing it, how much of it would rather pull (an edge lifting),
 * and the sliding force and twisting moment its friction (plus any bands round
 * the same tube) has to hold.
 */
function contactCheck(sup: SupportSpec, ct: NonNullable<SupportSpec["contact"]>, sel: { nodes: number[]; av: number[] }, Ku: Float64Array, f: Float64Array, bc: Uint8Array, nodePos: (n: number) => V3): ContactResult {
  const r = sup.region;
  const unit = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
  };
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const tube = r.t === "cyl" ? { at: r.at, axis: unit(r.axis) } : null;
  // the way whatever it rests on pushes the part, at each node
  const inward = (p: V3, q: number): V3 => {
    if (ct.normal) return unit([-ct.normal[0], -ct.normal[1], -ct.normal[2]]);
    if (r.t === "face") return unit([-r.dir[0], -r.dir[1], -r.dir[2]]);
    if (tube) {
      const d: V3 = [p[0] - tube.at[0], p[1] - tube.at[1], p[2] - tube.at[2]];
      const a = dot(d, tube.axis);
      return unit([d[0] - a * tube.axis[0], d[1] - a * tube.axis[1], d[2] - a * tube.axis[2]]);
    }
    return unit([-sel.av[3 * q], -sel.av[3 * q + 1], -sel.av[3 * q + 2]]);
  };
  const seen = new Set<number>();
  const nodes: { p: V3; R: V3; n: V3 }[] = [];
  sel.nodes.forEach((nd, q) => {
    if (seen.has(nd)) return;
    seen.add(nd);
    const R: V3 = [0, 0, 0];
    for (let d = 0; d < 3; d++) if (bc[3 * nd + d]) R[d] = Ku[3 * nd + d] - f[3 * nd + d];
    const p = nodePos(nd);
    nodes.push({ p, R, n: inward(p, q) });
  });
  let push = 0;
  let pull = 0;
  let c: V3 = [0, 0, 0];
  let avgN: V3 = [0, 0, 0];
  for (const k of nodes) {
    const rn = dot(k.R, k.n);
    if (rn >= 0) push += rn;
    else pull -= rn;
    c = [c[0] + k.p[0], c[1] + k.p[1], c[2] + k.p[2]];
    avgN = [avgN[0] + k.n[0], avgN[1] + k.n[1], avgN[2] + k.n[2]];
  }
  const m = Math.max(1, nodes.length);
  c = [c[0] / m, c[1] / m, c[2] / m];
  // Whether an edge lifts is judged from where the pressing force acts, not
  // node by node: a held seat shows pulling at single nodes (it stops the part
  // flexing and shrinking across) even where the real seat stays pressed.
  // Each coordinate across the seat gives the centre of pressure's offset from
  // the middle as a share of the half-width: under 1/3 every part stays
  // pressed (as with a straight pressure ramp), 1 and more and it tips over
  // that edge. Round a tube the coordinates are along it and round it.
  const { lift, liftAt } = seatLift(nodes, tube, unit(avgN), push - pull, c);
  // slide along the tube (or across a flat seat) and twist about the tube's axis (or the seat's normal)
  const axis = tube ? tube.axis : unit(avgN);
  const pivot = tube ? tube.at : c;
  let slideV: V3 = [0, 0, 0];
  let twist = 0;
  let twistHold = 0;
  for (const k of nodes) {
    const rn = dot(k.R, k.n);
    const t: V3 = [k.R[0] - rn * k.n[0], k.R[1] - rn * k.n[1], k.R[2] - rn * k.n[2]];
    const arm: V3 = [k.p[0] - pivot[0], k.p[1] - pivot[1], k.p[2] - pivot[2]];
    const along = dot(arm, axis);
    const rho = Math.hypot(arm[0] - along * axis[0], arm[1] - along * axis[1], arm[2] - along * axis[2]);
    twist += dot(cross(arm, t), axis);
    if (rn > 0) twistHold += ct.mu * rn * rho;
    slideV = [slideV[0] + t[0], slideV[1] + t[1], slideV[2] + t[2]];
  }
  // a tube: only the part along it slides; the rest of the tangential force is the twist, already counted
  const slide = tube ? Math.abs(dot(slideV, axis)) : Math.hypot(...slideV);
  const pressing = push - pull;
  const slideCap = ct.mu * Math.max(0, pressing) + (ct.grip?.force ?? 0);
  const twistCap = twistHold + (ct.grip?.moment ?? 0);
  const use = (slideCap > 0 ? slide / slideCap : slide > 1e-6 ? Infinity : 0) + (twistCap > 0 ? Math.abs(twist) / twistCap : Math.abs(twist) > 1e-6 ? Infinity : 0);
  return { pressing, lift, liftAt, slide, slideCap, twist: Math.abs(twist), twistCap, use };
}

/** How far a seat's centre of pressure sits off its middle (share of the half-width, worst direction) and the edge it unloads. */
function seatLift(nodes: { p: V3; R: V3; n: V3 }[], tube: { at: V3; axis: V3 } | null, avgN: V3, pressing: number, centre: V3): { lift: number; liftAt?: V3 } {
  if (pressing <= 0 || nodes.length < 2) return { lift: pressing > 0 ? 0 : 1 };
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0];
  };
  // two coordinates across the seat for each node
  let coords: (k: { p: V3; n: V3 }) => [number, number];
  if (tube) {
    const ref = unit([avgN[0] - dot(avgN, tube.axis) * tube.axis[0], avgN[1] - dot(avgN, tube.axis) * tube.axis[1], avgN[2] - dot(avgN, tube.axis) * tube.axis[2]]);
    const side = cross(tube.axis, ref);
    coords = (k) => [dot([k.p[0] - tube.at[0], k.p[1] - tube.at[1], k.p[2] - tube.at[2]], tube.axis), Math.atan2(dot(k.n, side), dot(k.n, ref))];
  } else {
    const u = unit(cross(avgN, Math.abs(avgN[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const v = cross(avgN, u);
    coords = (k) => {
      const d: V3 = [k.p[0] - centre[0], k.p[1] - centre[1], k.p[2] - centre[2]];
      return [dot(d, u), dot(d, v)];
    };
  }
  const q = nodes.map((k) => ({ k, c: coords(k), rn: dot(k.R, k.n) }));
  let lift = 0;
  let liftAt: V3 | undefined;
  for (const d of [0, 1]) {
    let lo = Infinity;
    let hi = -Infinity;
    let moment = 0;
    for (const e of q) {
      lo = Math.min(lo, e.c[d]);
      hi = Math.max(hi, e.c[d]);
      moment += e.rn * e.c[d];
    }
    const half = (hi - lo) / 2;
    if (half < 1e-9) continue;
    const off = moment / pressing - (lo + hi) / 2;
    const share = Math.abs(off) / half;
    if (share <= lift) continue;
    lift = share;
    // the edge it unloads: the far side from where the pressure gathers
    const far = q.reduce((a, b) => (off > 0 ? (b.c[d] < a.c[d] ? b : a) : b.c[d] > a.c[d] ? b : a));
    liftAt = far.k.p;
  }
  return { lift, liftAt };
}
