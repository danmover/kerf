// What an airflow run takes and gives, in the design's own units (mm, N,
// m/s), as the worker and the app pass them. World coordinates throughout,
// except the flow volume, which keeps the wind tunnel's axes and says how to
// place them.

import type { V3 } from "./geometry";

export interface AeroBody {
  /** the part instance id (EvalPart.id), or "rider" for the standard rider */
  id: string;
  /** the name shown for it */
  name: string;
  /** world-space triangle mesh, mm */
  positions: Float32Array;
  indices: Uint32Array;
  /** world-space vertex normals, pointing out */
  normals?: Float32Array;
  /** a wheel, or a part turning with one (hub, disc): it turns about this axle so the tyre rolls on the road; radius: the rolling radius, mm */
  wheel?: { axis: V3; origin: V3; radius?: number };
  /** not a part of the design (the rider): drawn with the results, counted in the totals */
  extra?: boolean;
}

export type AeroQuality = "draft" | "standard" | "fine";

export interface AirflowInput {
  label: string;
  bodies: AeroBody[];
  /** air speed the design sees, m/s (at a yaw angle the road speed is this × cos yaw) */
  speed: number;
  /** kg/m³ */
  density: number;
  /** kinematic viscosity, m²/s */
  nu: number;
  /** unit vectors: the way the front points, and up */
  facing: V3;
  up: V3;
  /** yaw angles to run, degrees; positive: the wind comes from the right-hand side */
  yaws: number[];
  /** a road under it, moving with the road speed (wheels spin with it) */
  ground: boolean;
  quality: AeroQuality;
  /** cells in the grid, or a fixed cell size in mm */
  cells: number;
  h?: number;
  /** where to run: the GPU when there is one, or the CPU (slower, coarser) */
  backend: "auto" | "gpu" | "cpu";
  /** 16-bit storage of the populations on the GPU (half the memory) */
  half?: boolean;
  /** stop after this long, minutes */
  maxMinutes: number;
}

/** Pressure and friction on one body's surface, per vertex of its mesh. */
export interface SurfaceField {
  id: string;
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array;
  /** pressure coefficient (p − p∞) / ½ρU² (NaN where no air reaches) */
  cp: Float32Array;
  /** skin friction coefficient vector τw / ½ρU², xyz */
  cf: Float32Array;
  extra?: boolean;
}

/** Polylines: points (xyz, world mm) and the speed at each as a share of the free stream; line k runs from starts[k] to starts[k + 1]. */
export interface Lines {
  points: Float32Array;
  speed: Float32Array;
  starts: Uint32Array;
}

export interface IsoSurface {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** a value per vertex for colouring (speed as a share of the free stream) */
  value: Float32Array;
}

/**
 * The averaged flow on a box of cells aligned with the wind: per cell velocity xyz as a share of the free stream
 * and the pressure coefficient (NaN inside solids). World point of cell (i, j, k): origin + (i·ex + j·ey + k·ez)·h.
 */
export interface FlowVolume {
  dims: V3;
  origin: V3;
  ex: V3;
  ey: V3;
  ez: V3;
  h: number;
  data: Float32Array;
}

export interface PartForce {
  id: string;
  name: string;
  /** body axes, N: drag holds it back along the way it faces, side pushes it to its left (the wind's way at positive yaw), lift */
  drag: number;
  side: number;
  lift: number;
  /** drag area, m² */
  cda: number;
  /** the share of its drag that is skin friction (the rest is pressure) */
  friction: number;
  extra?: boolean;
}

export interface YawResult {
  yaw: number;
  drag: number;
  side: number;
  lift: number;
  /** drag along the wind, N */
  windDrag: number;
  /** drag area from the body-axis drag, m² */
  cda: number;
  /** area the wind sees, m² */
  area: number;
  cd: number;
  /** power the drag costs at the road speed, W */
  watts: number;
  /** pitching and yawing moments about the bodies' centre, N·m (positive: nose up, nose to the right) */
  pitch: number;
  yawMoment: number;
  parts: PartForce[];
  /** drag through the averaging, N */
  history: number[];
  /** standard error of the mean drag, N */
  stderr: number;
  converged: boolean;
  steps: number;
  seconds: number;
  surface: SurfaceField[];
  streamlines: Lines;
  wake: IsoSurface | null;
  vortices: IsoSurface | null;
  volume: FlowVolume | null;
  /** the wall model's typical y+ at the first cell (median over the wall) */
  yPlus: number;
}

export interface AirflowResult {
  label: string;
  speed: number;
  density: number;
  yaws: YawResult[];
  /** cell size, mm, and grid size */
  h: number;
  dims: V3;
  cells: number;
  backend: "gpu" | "cpu";
  adapter?: string;
  /** Reynolds number on the bodies' length along the wind */
  reynolds: number;
  /** share of the tunnel's cross-section the bodies block */
  blockage: number;
  warnings: string[];
  ms: number;
}

/** Live state while a run goes: which yaw, how far, the drag so far and a picture of the flow. */
export interface AirflowProgress {
  stage: string;
  /** 0..1 over the whole run */
  frac: number;
  yaw?: number;
  drag?: number;
  cda?: number;
  /** speed as a share of the free stream on the vertical plane through the bodies, nx × nz, for a live view */
  slice?: { w: number; h: number; data: Float32Array; origin: V3; ex: V3; ez: V3; cell: number };
  /** million cell updates per second */
  mlups?: number;
}
