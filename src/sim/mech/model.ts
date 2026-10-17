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
  /** labels for friction and stops that the resolver assumed, for the run's notes */
  assumed?: string[];
}

export type MechDrive =
  | { kind: "motor"; joint: string; comp: string; sign: number }
  | { kind: "servo"; joint: string; comp: string; sign: number; /** servo angle at the design pose, deg */ zero: number }
  | { kind: "actuator"; joint: string; comp: string; sign: number; /** stroke at the design pose, mm */ start: number }
  | { kind: "turn"; name: string; joint: string; speed: Schedule; limit: number }
  | { kind: "force"; name: string; joint: string; value: Schedule }
  | { kind: "solenoid"; name: string; joint: string; dir: number; force: number; stroke: number; on: Schedule }
  | { kind: "cylinder"; name: string; joint: string; sign: number; fOut: number; fIn: number; vmax: number; seal: number; valve: Schedule };

export type MechLink =
  | { kind: "gears"; name: string; a: string; b: string; ca: V3; cb: V3; ra: number; backlash: number; efficiency: number }
  | { kind: "rack"; name: string; pinion: string; rack: string; p: V3; dir: V3; backlash: number; efficiency: number }
  | { kind: "thread"; name: string; screw: string; follower: string; point: V3; k: number; backlash: number; frictionArm: number; what: "lead screw" | "ball screw" | "worm" }
  | { kind: "ratio"; name: string; a: string; b: string; ratio: number; slack: number; efficiency: number }
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
  wheels: MechWheel[];
  tracks: MechTrack[];
  loose: MechLoose[];
  ground: MechGround | null;
  /** the frame is bolted down (a bench) or stands free (on a floor) */
  base: "fixed" | "free";
  gravity: V3;
  /** components that ride on a moving body (an IMU on an arm), by body id; the rest ride on the frame */
  mounts: Record<string, string>;
  /** runs without firmware: volts on a motor or actuator over time, or a servo's angle (deg) over time */
  power: Record<string, Schedule>;
  /** the body the camera follows (the frame when it stands free) */
  follow?: string;
  /** what the resolver assumed (masses from materials, bearings found on an axis) */
  notes: string[];
}

export const FRAME = "frame";
