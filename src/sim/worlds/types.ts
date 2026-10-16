// What a simulated environment provides: the mechanical loads on the
// machine's motors, how the machine moves through it, what its sensors see,
// and how to draw it. Worlds are reduced-order models: a few state variables
// and calibrated formulas, not particles or finite elements.

/** The load on a motor's output shaft for one step. */
export interface MotorLoad {
  /** friction-like torque the load resists with (and holds when stopped), N·m */
  coulomb: number;
  /** torque per rad/s of shaft speed, N·m·s */
  viscous: number;
  /** a torque turning the shaft by itself (+ forward), N·m */
  external: number;
  /** inertia the shaft drives, kg·m² */
  inertia: number;
}

export const FREE_LOAD: MotorLoad = { coulomb: 0, viscous: 0, external: 0, inertia: 0 };

/** What the plant tells the world after the motors moved this step. */
export interface PlantView {
  /** output shaft speed, rad/s (+ forward), and angle, rad */
  motor(comp: string): { omega: number; angle: number; current: number; torque: number } | undefined;
  /** linear actuator rod position, mm from fully retracted */
  actuator(comp: string): { pos: number; speed: number; force: number } | undefined;
  /** hobby servo horn angle, degrees */
  servo(comp: string): { angle: number } | undefined;
}

export interface Orientation {
  /** degrees, counter-clockwise seen from above, from the start heading */
  yaw: number;
  /** degrees, nose up */
  pitch: number;
  /** degrees, right side down */
  roll: number;
  /** body rates, degrees per second (roll, pitch, yaw rate) */
  rate: [number, number, number];
  /** acceleration in the body frame excluding gravity, m/s² */
  accel: [number, number, number];
}

export interface WorldEvent {
  t: number;
  kind: "goal" | "contact" | "stall" | "info" | "warn";
  text: string;
}

/**
 * One moving body in the scene. Its pose channels (`<id>.px`, `.py`, `.pz` in
 * mm and `.yaw`, `.pitch`, `.roll` in degrees) place the design point `origin`
 * in the world; the model's parts and components ride on the body whose
 * region holds their centre.
 */
export interface SceneBody {
  id: string;
  /** design-coordinate range along X a member's centre must fall in */
  xmin: number;
  xmax: number;
  origin: [number, number, number];
  /** members inside an X range that also turn with a motor about the design X axis */
  spin: { motor: string; xmin: number; xmax: number; sign: number }[];
}

export interface SceneSpec {
  kind: string;
  /** the environment box in world coordinates, mm */
  box?: { min: [number, number, number]; max: [number, number, number]; fill: "sand" | "water" | "air" | "soil"; fillTop: number; label: string };
  /** a floor plane at this height, mm */
  floor?: number;
  bodies: SceneBody[];
  /** an opening or target to reach */
  target?: { at: [number, number, number]; normal: [number, number, number]; d: number; label: string };
  /** the tunnel the machine leaves behind: a channel of its own path */
  trail?: { channelX: string; channelY: string; channelZ: string; d: number };
  notes: string[];
}

export interface World {
  kind: string;
  /** called once with the plant before the run */
  init?(plant: PlantView): void;
  motorLoad(comp: string): MotorLoad;
  /** force on an actuator rod, N (+ pushes it in) */
  actuatorLoad(comp: string): number;
  /** torque on a servo horn, N·m (+ against increasing angle) */
  servoLoad?(comp: string): number;
  /** advance the world by dt seconds after the motors moved */
  step(dt: number, t: number, plant: PlantView): void;
  /** orientation of the body an IMU sits on */
  orientation(comp: string): Orientation;
  /** distance a range sensor sees, mm */
  range?(comp: string): number;
  /** signals the world puts on nets (by name or "component.PIN"): volts at a time in seconds */
  drives?(): { on: string; v: (t: number) => number }[];
  /** ambient temperature, °C, and how well motors shed heat here (1 = still air) */
  thermal(): { ambient: number; cooling: number };
  /** numbers to record each frame (pose, contact forces, progress) */
  channels(): Record<string, number>;
  /** the run's job is finished (the goal reached and nothing moving) */
  finished(t: number): boolean;
  events: WorldEvent[];
  /** results the scenario's expectations can read */
  results(): Record<string, number | boolean | string>;
  scene(): SceneSpec;
  /** what this world leaves out */
  limits: string[];
}
