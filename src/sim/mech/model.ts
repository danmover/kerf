// The mechanism a run simulates, in SI units: its rigid bodies (mass,
// centre of mass and inertia from the design's own parts), the joints
// between them, what drives them, how they are linked (gears, screws,
// chains, cams, clutches), springs, loads, wheels and tracks, loose objects,
// and the ground. The app resolves it from the scenario's sim.mechanism(...)
// and the built geometry, then sends it to the simulation worker.

import type { M3, Quat, V3 } from "./solver";
import type { Schedule } from "./couplings";

export interface MechBody {
  id: string;
  /** the design names of the parts on it, for people */
  label: string;
  /** EvalPart ids drawn with this body */
  parts: string[];
  /** kg, m, kg·m² about the centre of mass in the design's axes */
  mass: number;
  com: V3;
  inertia: M3;
  /** corners of its shape (design coordinates, m) that touch the floor and blocks */
  points: V3[];
  /** its parts' boxes, for loose objects to press on */
  boxes: { c: V3; h: V3; q: Quat }[];
  fixed?: boolean;
}

export interface MechJoint {
  kind: "pivot" | "slider" | "ball" | "weld";
  name: string;
  body: string;
  /** parent body id ("frame" for the machine's frame or the world when it is fixed) */
  on: string;
  at: V3;
  axis: V3;
  /** end stops in the joint's units from the design pose (rad or m) */
  limits?: [number, number];
  /** friction: a constant torque or force, and a share of the load across the joint (μ × radius for a pivot) */
  friction?: number;
  frictionPerLoad?: number;
  /** viscous damping, N·m·s/rad or N·s/m */
  damping?: number;
  /** a spring on the axis: rate (N·m/rad or N/m) and where it is relaxed (joint units from the design pose) */
  spring?: number;
  free?: number;
  /** where a run begins, in the joint's units from the design pose (the design pose when left out) */
  start?: number;
  /** labels for friction and stops that the resolver assumed, for the run's notes */
  assumed?: string[];
}

export type MechDrive =
  | { kind: "motor"; joint: string; comp: string; sign: number }
  | { kind: "servo"; joint: string; comp: string; sign: number; /** servo angle at the design pose, deg */ zero: number; /** it reads its own angle and starts limp (a CAN actuator), so its joint may have a start: */ limpStart?: boolean }
  | { kind: "actuator"; joint: string; comp: string; sign: number; /** stroke at the design pose, mm */ start: number }
  | { kind: "turn"; name: string; joint: string; speed: Schedule; limit: number }
  | { kind: "force"; name: string; joint: string; value: Schedule }
  | { kind: "solenoid"; name: string; joint: string; dir: number; force: number; stroke: number; on: Schedule }
  | { kind: "cylinder"; name: string; joint: string; sign: number; fOut: number; fIn: number; vmax: number; seal: number; valve: Schedule };

export type MechLink =
  /** b is a joint, or FRAME for a gear fixed to the frame */
  | { kind: "gears"; name: string; a: string; b: string; ca: V3; cb: V3; ra: number; backlash: number; efficiency: number }
  | { kind: "rack"; name: string; pinion: string; rack: string; p: V3; dir: V3; backlash: number; efficiency: number }
  | { kind: "thread"; name: string; screw: string; follower: string; point: V3; k: number; backlash: number; frictionArm: number; what: "lead screw" | "ball screw" | "worm" }
  | { kind: "ratio"; name: string; a: string; b: string; ratio: number; slack: number; efficiency: number; /** a belt's stretch: N·m/rad or N/m at b (rigid when left out) */ stiffness?: number }
  | { kind: "cam"; name: string; cam: string; follower: string; lift: number[]; phase: number; grooved: boolean }
  | { kind: "clutch"; name: string; a?: string; b: string; torque: number; oneWay: boolean; engaged?: Schedule };

export interface MechSpring {
  name: string;
  a: string;
  b: string;
  pa: V3;
  pb: V3;
  k: number;
  c: number;
  free: number;
  push: number;
  /** a load cell component this link is, which reads its pull */
  cell?: string;
}

/** A vane in a jet: where its lift acts, the axis it turns on and its size, SI, design pose. */
export interface MechVane {
  joint: string;
  body: string;
  /** centre of pressure (a quarter chord back from its leading edge, mid-span) */
  cp: V3;
  axis: V3;
  /** m² */
  area: number;
  /** lift slope per radian and the aspect ratio it came from */
  cla: number;
  ar: number;
}

/** A ducted fan's jet: its thrust on the body it rides, along its axis, and the vanes in the jet. */
export interface MechJet {
  name: string;
  fan: string;
  body: string;
  /** the fan's centre and its thrust direction (the jet leaves the other way) */
  at: V3;
  axis: V3;
  vanes: MechVane[];
  /** rad */
  stall: number;
  /** share of the rotor's swirl torque the stators take back */
  recovery: number;
}

/** A wound air-core coil's winding in the design pose: its centre, the way its field points for positive current, radii and length, m. */
export interface MechCoil {
  comp: string;
  body: string;
  c: V3;
  axis: V3;
  ri: number;
  ro: number;
  h: number;
  turns: number;
}

/** A permanent magnet: its centre, the unit vector from its south pole to its north, its moment (A·m²) and size, m. */
export interface MechMagnet {
  comp: string;
  body: string;
  at: V3;
  axis: V3;
  moment: number;
  radius: number;
  length: number;
}

/** A magnetic field sensor: where its Hall elements are and the chip's own X, Y and Z in the design's axes. */
export interface MechFieldSensor {
  comp: string;
  body: string;
  at: V3;
  axes: [V3, V3, V3];
}

/** The design's coils, magnets and field sensors, for the forces between them and what the sensors read. */
export interface MechField {
  coils: MechCoil[];
  magnets: MechMagnet[];
  sensors: MechFieldSensor[];
  /** the earth's field in the design's axes, tesla */
  earth: V3;
}

/** A small wind tunnel's test section with a model in it. */
export interface MechTunnel {
  name: string;
  /** the body in the air stream */
  body: string;
  /** the four-wire fan that moves the air (a component), or the air speed over time, m/s */
  fan?: string;
  speed?: Schedule;
  /** the test section: its centre, the way the air goes, which way is up, and its width, height and length, m */
  at: V3;
  flow: V3;
  up: V3;
  width: number;
  height: number;
  length: number;
  /** the model: drag, lift and side-force areas (coefficient × frontal area), m²; frontal area, m²; width across the flow, m */
  cda: number;
  cla: number;
  cya: number;
  area: number;
  d: number;
  /** pressure lost round the whole circuit, in dynamic heads of the test section */
  loss: number;
  /** the contraction's area ratio (inlet over test section), and the pressure sensor across it */
  contraction: number;
  gauge?: string;
  /** turbulence intensity (a share), the rms unsteady side-force coefficient from vortex shedding, and its Strouhal number */
  turbulence: number;
  shed: number;
  strouhal: number;
  /** points on the model (design coordinates) that can touch the test section's walls; friction on them */
  points: V3[];
  mu: number;
  /** air density, kg/m³ */
  rho: number;
  /** a launch pad standing on the floor under the section's centre: its width (square) and height, m */
  pad?: { w: number; h: number };
}

export interface MechLoad {
  name: string;
  body: string;
  at: V3;
  dir: V3;
  value: Schedule;
  torque: boolean;
  turns: boolean;
}

export interface MechWheel {
  name: string;
  joint: string;
  centre: V3;
  axis: V3;
  radius: number;
  grip: number;
}

export interface MechTrack {
  name: string;
  joint: string;
  frame: string;
  points: V3[];
  radius: number;
  grip: number;
}

export interface MechLoose {
  id: string;
  size: V3;
  mass: number;
  at: V3;
  grip: number;
}

export interface MechGround {
  /** the floor: a point on it and its upward normal; blocks are fixed boxes on it */
  floor: { p: V3; n: V3 } | null;
  blocks: { min: V3; max: V3 }[];
  mu: number;
  roll: number;
  label: string;
  /** which way gravity pulls when the floor slopes (the machine's axes stay level with the floor) */
  down?: V3;
}

export interface MechModel {
  bodies: MechBody[];
  joints: MechJoint[];
  drives: MechDrive[];
  links: MechLink[];
  springs: MechSpring[];
  loads: MechLoad[];
  jets?: MechJet[];
  wheels: MechWheel[];
  tracks: MechTrack[];
  loose: MechLoose[];
  ground: MechGround | null;
  /** the frame is bolted down (a bench) or stands free (on a floor) */
  base: "fixed" | "free";
  gravity: V3;
  /** components that ride on a moving body (an IMU on an arm), by body id; the rest ride on the frame */
  mounts: Record<string, string>;
  /** where a hall sensor senses and where each magnet sits, design pose, m, with its range for sensors (m) */
  magnets?: { sensors: { comp: string; at: V3; range: number }[]; magnets: { comp: string; at: V3 }[] };
  /** coils, magnets and field sensors, when the design has them */
  field?: MechField;
  /** wind tunnel test sections */
  tunnels?: MechTunnel[];
  /** runs without firmware: volts on a motor or actuator over time, or a servo's angle (deg) over time */
  power: Record<string, Schedule>;
  /** the body the camera follows (the frame when it stands free) */
  follow?: string;
  /** part ids left off the machine for this run (sim.without): on no body, not drawn */
  off?: string[];
  /** points followed through the run for motion plots: on a body, at a design-pose point (m) */
  traces?: { name: string; body: string; at: V3 }[];
  /** what the resolver assumed (masses from materials, bearings found on an axis) */
  notes: string[];
}

export const FRAME = "frame";
