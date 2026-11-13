// What a flow and cooling run takes and gives, as the worker and the app pass them. World coordinates in mm for
// geometry; the results are in SI units (m³/s, Pa, W, °C) unless a field says otherwise.

export type V3 = [number, number, number];

/** A part in the flow: a solid that blocks the air, conducts heat and may make some. */
export interface FlowBody {
  /** the part instance id (EvalPart.id), or "<fan id>:frame" for a fan's frame and hub */
  id: string;
  name: string;
  /** world-space triangle mesh, mm (empty for a fan's frame, which the grid builds from the fan's size) */
  positions: Float32Array;
  indices: Uint32Array;
  /** thermal conductivity, W/(m·K) */
  k: number;
  /** heat made inside it, W, spread through its volume */
  watts: number;
  /** where the heat figure came from */
  heatWhy?: string;
  /** surface emissivity for radiation to the surroundings (0 for none) */
  emissivity: number;
  /** the hottest it may get, °C, and why */
  maxC?: number;
  limitWhy?: string;
  material: string;
  /** a bought component (its insides averaged) rather than a made part */
  component: boolean;
}

/** A fan in the flow: the solver makes its frame and hub solid and drives the air through its annulus along its curve. */
export interface FlowFan {
  id: string;
  name: string;
  /** the middle of the intake face, mm */
  at: V3;
  /** the way it blows (unit) and one side of its square frame (unit, square to axis) */
  axis: V3;
  side: V3;
  /** frame side, depth along the axis, bore and hub diameters, mm */
  size: number;
  depth: number;
  bore: number;
  hub: number;
  /** pressure rise (Pa) against flow (m³/s), from shut-off (flow 0) to free delivery (rise 0) */
  curve: [number, number][];
  curveWhy: string;
  /** a radial blower: its outlet is a duct on one side, modelled here as an axial fan of the same curve */
  blower?: boolean;
  /** heat its motor makes, W (in its frame and hub), and where the figure came from */
  watts?: number;
  heatWhy?: string;
  /** the hottest its frame may get, °C, and why */
  maxC?: number;
  limitWhy?: string;
}

/** A flow set by the analysis: driven into an opening at a fixed volume (a pump or fan whose curve does not matter). */
export interface FlowDrive {
  label: string;
  /** a point inside the opening's cross-section, mm, and the way the flow goes there (unit) */
  at: V3;
  dir: V3;
  /** m³/s */
  flow: number;
  /** keep the cross-section inside this box (mm) */
  bounds?: { lo: V3; hi: V3 };
}

/** A cross-section the flow through is reported for (an outlet of a manifold). */
export interface FlowSection {
  label: string;
  at: V3;
  /** the way out (unit): flow along it counts positive */
  dir: V3;
  bounds?: { lo: V3; hi: V3 };
}

export interface FlowFluid {
  name: string;
  /** kg/m³, m²/s, J/(kg·K), W/(m·K), 1/K */
  rho: number;
  nu: number;
  cp: number;
  k: number;
  beta: number;
}

export interface FlowInput {
  label: string;
  bodies: FlowBody[];
  fans: FlowFan[];
  drives: FlowDrive[];
  sections: FlowSection[];
  fluid: FlowFluid;
  /** the surroundings, °C */
  ambient: number;
  /** gravity, m/s², world axes; null: no rising warm air */
  gravity: V3 | null;
  /** cell size, mm */
  h: number;
  /** still surroundings round the parts, mm on every side */
  margin: number;
  /** solve the temperatures as well as the flow */
  heat: boolean;
  /** stop after this long, minutes */
  maxMinutes: number;
  /** most outer iterations (default from the grid size) */
  maxIterations?: number;
  /** what the set-up assumed, for the result's notes */
  notes?: string[];
}

export interface FanResult {
  id: string;
  name: string;
  /** m³/s through it and the pressure rise it gives there, Pa */
  flow: number;
  rise: number;
  /** its curve's ends */
  freeFlow: number;
  shutoff: number;
  /** on the curve's steep, unsteady left-hand part (axial fans below about 30 % of free flow) */
  stalled: boolean;
  /** air going through it backwards */
  reversed: boolean;
  /** a radial blower (its curve has no stall) */
  blower: boolean;
  curve: [number, number][];
  curveWhy: string;
  /** the mean temperature of the air going through it, °C */
  temp: number;
}

export interface DriveResult {
  label: string;
  /** m³/s */
  flow: number;
  /** total pressure it takes to drive that flow, Pa */
  rise: number;
  /** mean speed through the opening, m/s, and its area, m² */
  speed: number;
  area: number;
  /** the rise over the opening's dynamic pressure */
  lossCoefficient: number;
}

export interface SectionResult {
  label: string;
  /** m³/s along its way out, and the air's mean temperature there, °C */
  flow: number;
  temp: number;
  area: number;
}

export interface PartTemp {
  id: string;
  name: string;
  /** °C */
  max: number;
  mean: number;
  watts: number;
  heatWhy?: string;
  limit?: number;
  limitWhy?: string;
  material: string;
  component: boolean;
  /** cells it filled (0: too small for the grid; its heat went to the cell it sits in) */
  cells: number;
}

/** Temperature per vertex of one part's mesh, °C. */
export interface SurfaceTemps {
  id: string;
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  temp: Float32Array;
}

/** Polylines through the air: points (xyz, world mm), the speed (m/s) and temperature (°C) at each; line k runs from starts[k] to starts[k + 1]. */
export interface FlowLines {
  points: Float32Array;
  speed: Float32Array;
  temp: Float32Array;
  starts: Uint32Array;
}

/**
 * The solved field on the grid's cells: per cell u, v, w (m/s), temperature (°C) and pressure (Pa), and its kind
 * (0 air, 1 solid, 2 the surroundings). Cell (i, j, k)'s centre: origin + (i + ½, j + ½, k + ½)·h, mm.
 */
export interface FlowField {
  dims: V3;
  origin: V3;
  h: number;
  data: Float32Array;
  kind: Uint8Array;
}

export interface FlowResult {
  label: string;
  /** what flows: "air" or "water" */
  fluid: string;
  /** the surroundings, °C */
  ambient: number;
  /** cell size, mm, grid size and cells */
  h: number;
  dims: V3;
  cells: number;
  fluidCells: number;
  fans: FanResult[];
  drives: DriveResult[];
  sections: SectionResult[];
  parts: PartTemp[];
  /** air through the design, m³/s, and the mean rise of what leaves, K */
  throughFlow: number;
  airRise: number;
  /** heat made, carried off by the air and radiated, W */
  heatIn: number;
  heatAir: number;
  heatRadiated: number;
  maxSpeed: number;
  /** the hottest air, °C */
  maxAir: number;
  iterations: number;
  converged: boolean;
  /** the flow's last mass imbalance over the flow through */
  residual: number;
  /** the heat solve's balance: (made − carried − radiated) / made */
  balance: number;
  surfaces: SurfaceTemps[];
  lines: FlowLines;
  field: FlowField | null;
  warnings: string[];
  assumptions: string[];
  ms: number;
}

export interface FlowProgress {
  stage: string;
  /** 0..1 */
  frac: number;
  iteration?: number;
  residual?: number;
  /** each fan's flow so far, m³/s */
  fans?: number[];
  maxTemp?: number;
}
