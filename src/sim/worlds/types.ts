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

/**
 * A motor, actuator or servo a world moves itself (a mechanism it simulates as rigid bodies), with what its
 * driver gives it this step.
 */
export interface DriveIO {
  comp: string;
  kind: "motor" | "actuator" | "servo";
  /** volts on the terminals (+ forward; null: open), the driver's current limit, A */
  v: number | null;
  ilim: number;
  /** a servo's pulse, µs (null: none), and whether it has power */
  us: number | null;
  powered: boolean;
  /** the device's own model, for its constants (kt, ke, resistance, stall force, rated speed) */
  dev: unknown;
}

/** How a world moved a device this step, for the plant to take its current and heating from. */
export interface DriveMotion {
  /** output speed: rad/s (motor), mm/s (actuator) or °/s (servo) */
  speed: number;
  /** rod position, mm from fully in (actuator), or horn angle, ° (servo) */
  pos: number;
  /** torque (N·m) or force (N, + pushing the rod in) the mechanism put on it */
  load: number;
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
  /** the EvalPart ids on this body (a mechanism's bodies), instead of an X range; its pose then comes from
   * `<id>.qw/.qx/.qy/.qz`, the turn from the design pose, and `origin` is its design-pose centre of mass */
  parts?: string[];
  /** a loose box with this size, mm, drawn at origin */
  box?: [number, number, number];
}

export interface SceneSpec {
  kind: string;
  /** the environment box in world coordinates, mm */
  box?: { min: [number, number, number]; max: [number, number, number]; fill: "sand" | "water" | "air" | "soil"; fillTop: number; label: string };
  /** a floor plane at this height, mm */
  floor?: number;
  /** a floor that may slope (a point on it and its up direction) and fixed blocks on it, mm */
  ground?: { p: [number, number, number]; n: [number, number, number]; blocks: { min: [number, number, number]; max: [number, number, number] }[]; label: string; down?: [number, number, number] };
  /** the body a camera should follow */
  follow?: string;
  bodies: SceneBody[];
  /** an opening or target to reach */
  target?: { at: [number, number, number]; normal: [number, number, number]; d: number; label: string };
  /** the tunnel the machine leaves behind: a channel of its own path */
  trail?: { channelX: string; channelY: string; channelZ: string; d: number };
  notes: string[];
}

/** A current-limited bench supply, clipped on where the design's batteries and supplies connect (or on a net). */
export interface BenchSupplySpec {
  volts: number;
  /** current limit, A */
  amps: number;
  /** a net name or "component.PIN"; where the design's own batteries and supplies connect when left out */
  on?: string;
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
  /**
   * Worlds that simulate the machine's mechanism move its motors, actuators and servos themselves: given what
   * each driver puts out this step, they step the mechanism and say how each device moved.
   */
  couple?(io: DriveIO[], dt: number, t: number): Map<string, DriveMotion>;
  /** advance the world by dt seconds after the motors moved */
  step(dt: number, t: number, plant: PlantView): void;
  /** orientation of the body an IMU sits on */
  orientation(comp: string): Orientation;
  /** distance a range sensor sees, mm */
  range?(comp: string): number;
  /** signals the world puts on nets (by name or "component.PIN"): volts at a time in seconds */
  drives?(): { on: string; v: (t: number) => number }[];
  /** a bench supply that powers the machine in place of its own batteries and supplies */
  supply?(): BenchSupplySpec | undefined;
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
