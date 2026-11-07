// The design language's side of mechanism physics: sim.mechanism(...) and
// the items in it (joints, gears, screws, chains, cams, clutches, springs,
// loads, inputs, wheels, tracks, loose boxes), and sim.floor(...). They keep
// the design's names and units (mm, degrees, grams, N, N·mm, rpm, seconds);
// the app resolves them against the built parts (masses, centres, gear
// sizes) just before a run.

import { Args } from "../../lang/args";
import { Fn, Obj, Ref, Vec, typeName, type CallCtx, type Value } from "../../lang/values";
import type { Schedule } from "./couplings";

type V3 = [number, number, number];

export interface MechJointItem {
  k: "pivot" | "slider" | "ball" | "weld" | "free";
  /** the joint's name: what results and plots call it */
  name: string;
  /** the parts and components that move together on it */
  what: string[];
  /** the body it hangs on: a member's name, or null for the frame */
  on: string | null;
  at?: V3;
  axis?: V3;
  /** end stops from the design pose, deg or mm */
  limits?: [number, number];
  /** friction torque (N·mm) or force (N) */
  friction?: number;
  damping?: number;
  spring?: number;
  free?: number;
  /** the motor, servo, actuator, cylinder or solenoid that drives it */
  drive?: string;
  /** a servo's angle at the design pose, deg */
  zero?: number;
}

export type MechItem =
  | MechJointItem
  | { k: "gears"; name: string; a: string; b: string; backlash?: number; efficiency: number }
  | { k: "rack"; name: string; pinion: string; rack: string; backlash?: number; efficiency: number }
  | { k: "screw"; name: string; screw: string; nut: string; lead: number; d: number; ball: boolean; mu: number; backlash: number; worm: boolean }
  | { k: "chain"; name: string; a: string; b: string; ratio: number; slack: number; efficiency: number; chain: boolean }
  | { k: "cam"; name: string; cam: string; follower: string; lift?: number[]; grooved: boolean }
  | { k: "clutch"; name: string; a: string | null; b: string; torque: number; oneWay: boolean; engaged?: Schedule }
  | { k: "spring"; name: string; a: string | null; b: string | null; atA: V3; atB: V3; rate: number; free?: number; damping: number; push: number; cell?: string }
  | { k: "jet"; name: string; fan: string; vanes: string[]; chord?: number; span?: number; lift?: number; stall: number; recovery: number }
  | { k: "payload"; name: string; on: string; mass: number; at?: V3 }
  | { k: "load"; name: string; on: string; at?: V3; dir: V3; value: Schedule; torque: boolean; turns: boolean }
  | { k: "turn"; name: string; joint: string; speed: Schedule; limit: number }
  | { k: "motor"; name: string; comp: string }
  | { k: "push"; name: string; joint: string; value: Schedule }
  | { k: "solenoid"; name: string; joint: string; force: number; stroke: number; on: Schedule; pull: boolean }
  | { k: "cylinder"; name: string; joint: string; bore: number; rod: number; pressure: number; speed: number; seal?: number; valve: Schedule; retract: boolean }
  | { k: "wheel"; name: string; what: string; d?: number; grip: number }
  | { k: "track"; name: string; sprocket: string; d: number; length: number; toward?: V3; grip: number }
  | { k: "box"; name: string; size: V3; mass: number; at: V3; grip: number }
  | { k: "power"; comp: string; value: Schedule };

export interface MechSpec {
  items: MechItem[];
  /** "fixed": the frame is bolted down; "free": it stands on the floor; left out: by the world */
  base?: "fixed" | "free";
  /** add the design's own gear trains (spin:, mesh:, turns_with:) as bodies on pivots */
  auto: boolean;
  /** the body the camera follows */
  follow?: string;
}

export interface FloorSpec {
  surface: string;
  grip: number;
  roll: number;
  /** slope, deg, rising along `uphill` */
  slope: number;
  uphill: V3;
  ambient: number;
  /** fixed blocks on the floor, mm */
  blocks: { min: V3; max: V3 }[];
}

/** grip and rolling resistance on common floors, for a rubber tyre and a hard part */
export const SURFACES: Record<string, { grip: number; roll: number }> = {
  concrete: { grip: 0.8, roll: 0.015 },
  wood: { grip: 0.6, roll: 0.012 },
  tile: { grip: 0.5, roll: 0.01 },
  carpet: { grip: 0.7, roll: 0.06 },
  grass: { grip: 0.45, roll: 0.1 },
  gravel: { grip: 0.55, roll: 0.08 },
  sand: { grip: 0.4, roll: 0.2 },
  ice: { grip: 0.08, roll: 0.01 },
};

/** A mechanism item or a floor block made by a sim.* function. */
export class MechValue extends Obj {
  constructor(
    public item: MechItem | { k: "block"; min: V3; max: V3 },
    label: string,
  ) {
    super({}, "sim mechanism item", label);
  }
}

// ---------- argument helpers ----------

function nameOf(v: Value | undefined, ctx: CallCtx, what: string): string {
  if (v instanceof Ref) return v.name;
  if (v instanceof Obj && v.kind === "component") return String(v.fields.name);
  if (typeof v === "string" && v) return v;
  return ctx.error(`${what} should be a part or component (or a joint's name in quotes), got ${v === undefined ? "nothing" : typeName(v)}`);
}

function namesOf(v: Value | undefined, ctx: CallCtx, what: string): string[] {
  if (Array.isArray(v)) {
    if (!v.length) ctx.error(`${what} should name at least one part or component`);
    return v.map((x, i) => nameOf(x, ctx, `${what} item ${i + 1}`));
  }
  return [nameOf(v, ctx, what)];
}

function v3(v: Value, ctx: CallCtx, what: string): V3 {
  if (v instanceof Vec && (v.v.length === 3 || v.v.length === 2)) return v.v3();
  return ctx.error(`${what} should be a point or direction like (0, 0, 50) or Y, got ${typeName(v)}`);
}

function optV3(a: Args, name: string): V3 | undefined {
  const v = a.value(name);
  return v === undefined ? undefined : v3(v, a.ctx, `${a.fname}(): ${name}`);
}

function dirOf(a: Args, name: string, def?: V3): V3 | undefined {
  const d = optV3(a, name) ?? def;
  if (!d) return undefined;
  const l = Math.hypot(...d);
  if (l < 1e-9) a.ctx.error(`${a.fname}(): ${name} must be a direction, not (0, 0, 0)`);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** a number, or a list of (time, value) points: straight lines between them */
function schedule(a: Args, name: string, def?: number): Schedule | undefined {
  const v = a.value(name);
  if (v === undefined) return def === undefined ? undefined : [[0, def]];
  if (typeof v === "number") return [[0, v]];
  if (typeof v === "boolean") return [[0, v ? 1 : 0]];
  if (Array.isArray(v) && v.length) {
    const out: Schedule = v.map((p, i) => {
      if (p instanceof Vec && p.v.length === 2) return [p.v[0], p.v[1]] as [number, number];
      return a.ctx.error(`${a.fname}(): ${name} point ${i + 1} should be (time, value), like (2s, 30rpm)`);
    });
    for (let i = 1; i < out.length; i++) if (out[i][0] < out[i - 1][0]) a.ctx.error(`${a.fname}(): ${name} times must go up`);
    return out;
  }
  return a.ctx.error(`${a.fname}(): ${name} should be a number or a list of (time, value) points like [(0s, 0rpm), (1s, 60rpm)]`);
}

function range(a: Args, name: string): [number, number] | undefined {
  const v = a.value(name);
  if (v === undefined) return undefined;
  if (v instanceof Vec && v.v.length === 2 && v.v[0] < v.v[1]) return [v.v[0], v.v[1]];
  return a.ctx.error(`${a.fname}(): ${name} should be (lowest, highest) from the design pose, like (-10deg, 90deg)`);
}

function share(a: Args, name: string, def: number): number {
  const s = a.num(name, def);
  if (!(s > 0 && s <= 1)) a.ctx.error(`${a.fname}(): ${name} is a share between 0 and 100%`);
  return s;
}

function mechFn(name: string, params: string[], doc: string, impl: (a: Args) => MechValue): [string, Fn] {
  return [name, new Fn(`sim.${name}`, (pos, named, ctx) => impl(new Args(`sim.${name}`, pos, named, ctx, params)), doc)];
}

function joint(k: MechJointItem["k"], a: Args): MechJointItem {
  const what = namesOf(a.value("what"), a.ctx, `${a.fname}(): what`);
  const on = a.value("on");
  const j: MechJointItem = {
    k,
    name: a.has("name") ? a.str("name") : what[0],
    what,
    on: on === undefined || on === "frame" ? null : nameOf(on, a.ctx, `${a.fname}(): on`),
    at: optV3(a, "at"),
  };
  if (k === "pivot" || k === "slider") {
    j.axis = dirOf(a, "axis");
    j.limits = range(a, "limits");
    if (a.has("friction")) j.friction = a.num("friction");
    if (a.has("damping")) j.damping = a.num("damping");
    if (a.has("spring")) j.spring = a.num("spring");
    if (a.has("free")) j.free = a.num("free");
    if (a.has("drive")) j.drive = nameOf(a.value("drive"), a.ctx, `${a.fname}(): drive`);
    if (a.has("zero")) j.zero = a.num("zero");
  }
  return j;
}

const JOINT_DOC = "what: the part or component (or a list of them) that moves as one rigid body; on: the body it hangs on (a part on another joint), the frame when left out; name: what results call it (the first part's name)";

export const MECH_FNS: [string, Fn][] = [
  mechFn(
    "pivot",
    ["what", "on", "at", "axis", "limits", "friction", "damping", "spring", "free", "drive", "zero", "name"],
    `A hinge or shaft turning about an axis. ${JOINT_DOC}; at: a point on the axis and axis: its direction (both from the part's spin:/mesh: or gear when left out); limits: end stops from the design pose, like (-10deg, 90deg); friction: torque in its bearings (N·mm); damping: N·mm per deg/s; spring: a torsion spring, N·mm per deg, relaxed at free: (deg from the design pose, 0); drive: the gearmotor or servo turning it (a servo also takes zero: its angle at the design pose, deg). Results: <name>.angle, .angle_min, .angle_max, .turns, .max_rpm, .peak_torque, .hold_torque (the most averaged over any one second: a servo reaches its stall torque for a moment whenever it starts or corrects, so judge its load by this), .bearing_load, .hit_stop.`,
    (a) => new MechValue(joint("pivot", a), "pivot"),
  ),
  mechFn(
    "slider",
    ["what", "on", "at", "axis", "limits", "friction", "damping", "spring", "free", "drive", "name"],
    `A carriage or rod sliding along an axis. ${JOINT_DOC}; at: a point on its line and axis: the way it slides; limits: end stops from the design pose, like (0mm, 300mm) (a linear actuator's stroke sets them); friction: N; damping: N per mm/s; spring: N/mm, relaxed at free: (mm from the design pose); drive: the linear actuator, air cylinder or solenoid working it. Results: <name>.pos, .pos_min, .pos_max, .travel, .max_speed, .peak_force, .bearing_load, .hit_stop.`,
    (a) => new MechValue(joint("slider", a), "slider"),
  ),
  mechFn("ball", ["what", "on", "at", "name"], `A ball joint (rod end): turns every way about at:. ${JOINT_DOC}.`, (a) => new MechValue(joint("ball", a), "ball joint")),
  mechFn("weld", ["what", "on", "at", "name"], `Fixes a body rigidly to another (or the frame). ${JOINT_DOC}.`, (a) => new MechValue(joint("weld", a), "weld")),
  mechFn("free", ["what", "name"], "A loose part of the design with no joint: it falls, slides and tumbles on the floor (a ball in a chute, a part dropped into a tray).", (a) => new MechValue(joint("free", a), "free body")),
  mechFn(
    "gears",
    ["a", "b", "backlash", "efficiency", "name"],
    "Two lib.spur_gear components in mesh, each on its own pivot (added for you from spin:/mesh: when they turn). backlash: at the pitch circle (the gears' own, 0.05 mm when they give none); efficiency: per mesh (98%). Results: <name>.peak_force (tooth force, N). Gears that mesh: in the design are linked automatically.",
    (a) => {
      const g1 = nameOf(a.value("a"), a.ctx, "sim.gears(): a");
      const g2 = nameOf(a.value("b"), a.ctx, "sim.gears(): b");
      return new MechValue({ k: "gears", name: a.has("name") ? a.str("name") : `${g1}-${g2}`, a: g1, b: g2, backlash: a.has("backlash") ? a.num("backlash") : undefined, efficiency: share(a, "efficiency", 0.98) }, "gears");
    },
  ),
  mechFn(
    "rack",
    ["pinion", "rack", "backlash", "efficiency", "name"],
    "A pinion (a lib.spur_gear on a pivot) driving a rack on a slider: the rack moves the pinion's pitch radius per radian. backlash: mm (0.05); efficiency: 97%.",
    (a) => {
      const p = nameOf(a.value("pinion"), a.ctx, "sim.rack(): pinion");
      const r = nameOf(a.value("rack"), a.ctx, "sim.rack(): rack");
      return new MechValue({ k: "rack", name: a.has("name") ? a.str("name") : `${p}-${r}`, pinion: p, rack: r, backlash: a.has("backlash") ? a.num("backlash") : undefined, efficiency: share(a, "efficiency", 0.97) }, "rack and pinion");
    },
  ),
  mechFn(
    "lead_screw",
    ["screw", "nut", "lead", "d", "ball", "friction", "backlash", "name"],
    "A lead screw or ball screw on a pivot driving a nut on a slider. lead: travel per turn (+ right-hand, - left-hand); d: thread diameter; ball: true for a ball screw (90 % efficient, back-drivable); friction: thread friction coefficient (0.15 for a plastic nut on steel, 0.2 for bronze, dry steel 0.3). A screw whose friction angle is above its lead angle holds its load without power. Results: <name>.peak_thrust (N).",
    (a) => {
      const s = nameOf(a.value("screw"), a.ctx, "sim.lead_screw(): screw");
      const n = nameOf(a.value("nut"), a.ctx, "sim.lead_screw(): nut");
      const ball = a.bool("ball", false);
      return new MechValue({ k: "screw", name: a.has("name") ? a.str("name") : `${s}-${n}`, screw: s, nut: n, lead: a.num("lead"), d: a.positive("d", 8), ball, mu: a.num("friction", ball ? 0.005 : 0.15), backlash: a.num("backlash", ball ? 0.005 : 0.1), worm: false }, "lead screw");
    },
  ),
  mechFn(
    "worm",
    ["worm", "wheel", "lead", "d", "friction", "backlash", "name"],
    "A worm on a pivot turning a worm wheel on another pivot. lead: the worm's lead (module × π × starts); d: worm pitch diameter; friction: 0.05 for bronze on hardened steel with oil, 0.15 dry. A single-start worm usually locks: the wheel cannot turn the worm back.",
    (a) => {
      const s = nameOf(a.value("worm"), a.ctx, "sim.worm(): worm");
      const n = nameOf(a.value("wheel"), a.ctx, "sim.worm(): wheel");
      return new MechValue({ k: "screw", name: a.has("name") ? a.str("name") : `${s}-${n}`, screw: s, nut: n, lead: a.num("lead"), d: a.positive("d"), ball: false, mu: a.num("friction", 0.08), backlash: a.num("backlash", 0.1), worm: true }, "worm gear");
    },
  ),
  mechFn(
    "chain",
    ["a", "b", "teeth", "pitch", "slack", "efficiency", "name"],
    "A roller chain from a sprocket on one pivot to a sprocket on another. teeth: (driving, driven); pitch: chain pitch (12.7 mm, 08B / #40); slack: free play of the chain at the sprockets (1 mm); efficiency: 98%. Results: <name>.peak_torque at the driven sprocket (N·mm).",
    (a) => {
      const s1 = nameOf(a.value("a"), a.ctx, "sim.chain(): a");
      const s2 = nameOf(a.value("b"), a.ctx, "sim.chain(): b");
      const t = a.value("teeth");
      if (!(t instanceof Vec && t.v.length === 2 && t.v[0] >= 6 && t.v[1] >= 6)) return a.ctx.error("sim.chain(): teeth should be (driving, driven), like (15, 45)");
      const p = a.positive("pitch", 12.7);
      // slack as an angle at the driven sprocket
      const rb = p / (2 * Math.sin(Math.PI / t.v[1]));
      return new MechValue({ k: "chain", name: a.has("name") ? a.str("name") : `${s1}-${s2}`, a: s1, b: s2, ratio: t.v[0] / t.v[1], slack: ((a.num("slack", 1) / rb) * 180) / Math.PI, efficiency: share(a, "efficiency", 0.98), chain: true }, "chain");
    },
  ),
  mechFn(
    "couple",
    ["a", "b", "ratio", "slack", "efficiency", "name"],
    "Any drive given as a ratio between two joints: b moves ratio × a (a belt Kerf has no lib.belt for, a gearbox it has no closer model for, a cable). slack: lost motion at b (deg or mm); efficiency: 95%.",
    (a) => {
      const s1 = nameOf(a.value("a"), a.ctx, "sim.couple(): a");
      const s2 = nameOf(a.value("b"), a.ctx, "sim.couple(): b");
      return new MechValue({ k: "chain", name: a.has("name") ? a.str("name") : `${s1}-${s2}`, a: s1, b: s2, ratio: a.num("ratio"), slack: a.num("slack", 0), efficiency: share(a, "efficiency", 0.95), chain: false }, "coupling");
    },
  ),
  mechFn(
    "cam",
    ["cam", "follower", "lift", "grooved", "name"],
    "A cam on a pivot pushing a follower on a slider (whose axis points away from the cam). lift: the follower's lift over one turn, evenly spaced, starting at the design pose and going the way the cam turns (mm); worked out from the cam's own shape when left out; grooved: true for a slot cam that drives both ways. A spring-return follower can leave the cam when it turns too fast. Results: <name>.jump (mm), .lifted_time, .peak_force.",
    (a) => {
      const c = nameOf(a.value("cam"), a.ctx, "sim.cam(): cam");
      const f = nameOf(a.value("follower"), a.ctx, "sim.cam(): follower");
      const lv = a.value("lift");
      let lift: number[] | undefined;
      if (lv !== undefined) {
        if (!Array.isArray(lv) || lv.length < 8 || !lv.every((x) => typeof x === "number")) return a.ctx.error("sim.cam(): lift should be a list of at least 8 lifts (mm) over one turn");
        lift = lv as number[];
      }
      return new MechValue({ k: "cam", name: a.has("name") ? a.str("name") : c, cam: c, follower: f, lift, grooved: a.bool("grooved", false) }, "cam");
    },
  ),
  mechFn(
    "clutch",
    ["a", "b", "torque", "one_way", "engaged", "name"],
    "A friction clutch between two pivots on one axis: b turns with a until the torque passes torque: (N·mm), then it slips. one_way: true for a freewheel (drives b forward, lets it overrun); engaged: 1 or 0 over time, like [(0s, 1), (3s, 0)]. Results: <name>.slip_time.",
    (a) => {
      const x = nameOf(a.value("a"), a.ctx, "sim.clutch(): a");
      const y = nameOf(a.value("b"), a.ctx, "sim.clutch(): b");
      const oneWay = a.bool("one_way", false);
      return new MechValue({ k: "clutch", name: a.has("name") ? a.str("name") : `${x}-${y} clutch`, a: x, b: y, torque: oneWay && !a.has("torque") ? Infinity : a.positive("torque"), oneWay, engaged: schedule(a, "engaged") }, "clutch");
    },
  ),
  mechFn(
    "brake",
    ["what", "torque", "engaged", "name"],
    "A brake on a pivot: holds it against the frame up to torque: (N·mm). engaged: 1 or 0 over time.",
    (a) => {
      const y = nameOf(a.value("what"), a.ctx, "sim.brake(): what");
      return new MechValue({ k: "clutch", name: a.has("name") ? a.str("name") : `${y} brake`, a: null, b: y, torque: a.positive("torque"), oneWay: false, engaged: schedule(a, "engaged") }, "brake");
    },
  ),
  mechFn(
    "spring",
    ["a", "b", "at_a", "at_b", "rate", "free", "damping", "push", "cell", "name"],
    "A spring, damper or gas spring between a point on each of two bodies (a body is a part on a joint; leave a or b out for the frame). at_a, at_b: its ends in the design pose; rate: N/mm; free: its free length (its length in the design pose, so no preload, when left out); damping: N per mm/s; push: a gas spring's force, N; cell: a load cell component that is this link (give its stiffness as rate:, about 15 N/mm for a 500 g bar cell): the HX711 it is wired to reads the link's pull. Results: <name>.peak_force, .min_length, .max_length.",
    (a) => {
      const A = a.value("a");
      const B = a.value("b");
      return new MechValue(
        {
          k: "spring",
          name: a.has("name") ? a.str("name") : "spring",
          a: A === undefined || A === "frame" ? null : nameOf(A, a.ctx, "sim.spring(): a"),
          b: B === undefined || B === "frame" ? null : nameOf(B, a.ctx, "sim.spring(): b"),
          atA: v3(a.value("at_a") ?? a.ctx.error("sim.spring() needs at_a"), a.ctx, "sim.spring(): at_a"),
          atB: v3(a.value("at_b") ?? a.ctx.error("sim.spring() needs at_b"), a.ctx, "sim.spring(): at_b"),
          rate: a.num("rate", 0),
          free: a.has("free") ? a.positive("free") : undefined,
          damping: a.num("damping", 0),
          push: a.num("push", 0),
          cell: a.has("cell") ? nameOf(a.value("cell"), a.ctx, "sim.spring(): cell") : undefined,
        },
        "spring",
      );
    },
  ),
  mechFn("payload", ["on", "mass", "at", "name"], "A mass carried by a body (what a gripper holds, a weight on an arm). on: a part on a joint; mass: g or kg; at: its centre (the body's centre when left out).", (a) =>
    new MechValue({ k: "payload", name: a.has("name") ? a.str("name") : "payload", on: nameOf(a.value("on"), a.ctx, "sim.payload(): on"), mass: a.positive("mass"), at: optV3(a, "at") }, "payload"),
  ),
  mechFn(
    "load",
    ["on", "force", "torque", "dir", "at", "turns", "name"],
    "A force (N) or torque (N·mm) on a body, steady or over time like [(0s, 0N), (1s, 50N)]. dir: its direction (a torque's axis); at: where a force acts (the body's centre); turns: true when it turns with the body (a cutting force on a tool).",
    (a) => {
      const torque = a.has("torque");
      if (torque === a.has("force")) return a.ctx.error("sim.load(): give force: or torque:");
      return new MechValue({ k: "load", name: a.has("name") ? a.str("name") : "load", on: nameOf(a.value("on"), a.ctx, "sim.load(): on"), at: optV3(a, "at"), dir: dirOf(a, "dir", [0, 0, -1])!, value: schedule(a, torque ? "torque" : "force")!, torque, turns: a.bool("turns", false) }, "load");
    },
  ),
  mechFn(
    "jet",
    ["fan", "vanes", "chord", "span", "lift", "stall", "recovery", "name"],
    "A ducted fan's jet and the vanes steering it. fan: the design's ducted fan (or propeller) component, spun by its ESC from the scenario's firmware: its thrust pushes the body it rides along its axis, and its rotor's momentum makes the gyroscopic torque when that body turns; vanes: the vanes in the jet, each a part on its own sim.pivot across the jet (a servo's drive:), each giving lift from the jet's dynamic pressure as it turns from the design pose (low aspect ratio, with the duct wall at its root); chord, span: each vane's size, mm (from its shape when left out, span capped at the jet's annulus); lift: lift slope per radian (worked out from the vane's aspect ratio when left out); stall: the vane angle past which its lift stops growing (25deg); recovery: share of the rotor's swirl torque the stators take back (85%). Results: <name>.peak_vane_force (N), .stall_time, .peak_gyro (N·mm); channels <vane>.lift and <name>.side_force.",
    (a) => {
      const fan = nameOf(a.value("fan"), a.ctx, "sim.jet(): fan");
      const vanes = a.has("vanes") ? namesOf(a.value("vanes"), a.ctx, "sim.jet(): vanes") : [];
      const stall = a.num("stall", 25);
      if (!(stall > 2 && stall < 60)) a.ctx.error("sim.jet(): stall is a vane angle in degrees, 2 to 60");
      return new MechValue(
        {
          k: "jet",
          name: a.has("name") ? a.str("name") : `${fan} jet`,
          fan,
          vanes,
          chord: a.has("chord") ? a.positive("chord") : undefined,
          span: a.has("span") ? a.positive("span") : undefined,
          lift: a.has("lift") ? a.positive("lift") : undefined,
          stall,
          recovery: share(a, "recovery", 0.85),
        },
        "jet",
      );
    },
  ),
  mechFn("turn", ["joint", "speed", "limit", "name"], "Turns a pivot (or moves a slider) at a speed, like a hand on a crank or a test rig: speed: rpm (mm/s on a slider), steady or over time like [(0s, 0rpm), (1s, 60rpm)]; limit: the most torque (N·mm) or force (N) it gives (no limit when left out). Results: <name>.peak_torque or .peak_force, .peak_power.", (a) => {
    const j = nameOf(a.value("joint"), a.ctx, "sim.turn(): joint");
    return new MechValue({ k: "turn", name: a.has("name") ? a.str("name") : `turn ${j}`, joint: j, speed: schedule(a, "speed")!, limit: a.positive("limit", 1e9) }, "turn");
  }),
  mechFn("motor", ["motor", "name"], "The design's gearmotor turning the shaft it is on (its spin:, mesh: or turns_with: line, or a sim.pivot it belongs to), driven by the scenario's firmware through its wiring: the firmware's PWM, the supply and the motor's own torque curve set how it moves. Results come from the shaft it turns (<part>.max_rpm, .turns) and the motor (<motor>.peak_amps, .stall_time, .max_temp).", (a) => {
    const m = nameOf(a.value("motor"), a.ctx, "sim.motor(): motor");
    return new MechValue({ k: "motor", name: a.has("name") ? a.str("name") : m, comp: m }, "motor");
  }),
  mechFn("push", ["joint", "force", "name"], "A torque (N·mm, on a pivot) or force (N, on a slider) along a joint, steady or over time.", (a) => {
    const j = nameOf(a.value("joint"), a.ctx, "sim.push(): joint");
    return new MechValue({ k: "push", name: a.has("name") ? a.str("name") : `push ${j}`, joint: j, value: schedule(a, "force")! }, "push");
  }),
  mechFn("solenoid", ["joint", "force", "stroke", "on", "pull", "name"], "A solenoid working a slider: force: its pull at full stroke (N, it grows as the gap closes); stroke: mm; on: 1 or 0 over time; pull: true when it pulls the slider back (- along its axis). Add a sim.spring for its return spring.", (a) => {
    const j = nameOf(a.value("joint"), a.ctx, "sim.solenoid(): joint");
    return new MechValue({ k: "solenoid", name: a.has("name") ? a.str("name") : `${j} solenoid`, joint: j, force: a.positive("force"), stroke: a.positive("stroke"), on: schedule(a, "on", 1)!, pull: a.bool("pull", false) }, "solenoid");
  }),
  mechFn(
    "cylinder",
    ["joint", "bore", "rod", "pressure", "speed", "seal", "valve", "retract", "name"],
    "A pneumatic cylinder on a slider: bore, rod: mm; pressure: supply (6bar); speed: what the valve and flow allow (200 mm/s); seal: seal friction (N, about 3 % of its force); valve: 1 extend, 0 retract, -1 exhausted (rod free), over time like [(0s, 1), (2s, 0)]; retract: true when extending moves the slider back.",
    (a) => {
      const j = nameOf(a.value("joint"), a.ctx, "sim.cylinder(): joint");
      const bore = a.positive("bore");
      const rod = a.num("rod", bore * 0.4);
      if (rod >= bore) a.ctx.error("sim.cylinder(): rod must be thinner than bore");
      return new MechValue({ k: "cylinder", name: a.has("name") ? a.str("name") : `${j} cylinder`, joint: j, bore, rod, pressure: a.positive("pressure", 0.6), speed: a.positive("speed", 200), seal: a.has("seal") ? a.num("seal") : undefined, valve: schedule(a, "valve", 1)!, retract: a.bool("retract", false) }, "air cylinder");
    },
  ),
  mechFn("wheel", ["what", "d", "grip", "name"], "A wheel rolling on the floor (with sim.floor): what: the wheel part, on its own pivot; d: its diameter (from its shape); grip: tyre on floor (the floor's). Results: <name>.slip_time.", (a) => {
    const w = nameOf(a.value("what"), a.ctx, "sim.wheel(): what");
    return new MechValue({ k: "wheel", name: a.has("name") ? a.str("name") : `${w} tyre`, what: w, d: a.has("d") ? a.positive("d") : undefined, grip: a.num("grip", -1) }, "wheel");
  }),
  mechFn("track", ["sprocket", "d", "length", "toward", "grip", "name"], "A crawler track: its sprocket (a part on a pivot) drives a bottom run of length: (mm) that touches the floor, running from under the sprocket toward: (forward, square to the sprocket's axis); d: the sprocket's pitch diameter; grip: track on floor.", (a) => {
    const s = nameOf(a.value("sprocket"), a.ctx, "sim.track(): sprocket");
    return new MechValue({ k: "track", name: a.has("name") ? a.str("name") : `${s} track`, sprocket: s, d: a.positive("d"), length: a.positive("length"), toward: dirOf(a, "toward"), grip: a.num("grip", -1) }, "track");
  }),
  mechFn("box", ["size", "mass", "at", "grip", "name"], "A loose box the machine pushes, grips, lifts or carries: size: (x, y, z) mm; mass: g or kg; at: its centre in the design's coordinates; grip: friction on it (0.5). Results: <name>.x, .y, .z (where its centre ended up), .moved, .z_max (the highest its centre got).", (a) =>
    new MechValue({ k: "box", name: a.has("name") ? a.str("name") : "box", size: v3(a.value("size") ?? a.ctx.error("sim.box() needs size"), a.ctx, "sim.box(): size"), mass: a.positive("mass"), at: v3(a.value("at") ?? a.ctx.error("sim.box() needs at"), a.ctx, "sim.box(): at"), grip: a.num("grip", 0.5) }, "box"),
  ),
  mechFn("power", ["what", "volts", "angle"], "With no firmware: the volts on a gearmotor or linear actuator over time, like [(0s, 0V), (0.5s, 12V), (4s, 12V), (4.5s, -12V)], or a servo's angle (deg) over time. Motors and actuators run at their rated volts when left out.", (a) => {
    const c = nameOf(a.value("what"), a.ctx, "sim.power(): what");
    const v = schedule(a, a.has("angle") ? "angle" : "volts");
    if (!v) return a.ctx.error("sim.power(): give volts: or angle:");
    return new MechValue({ k: "power", comp: c, value: v }, "power");
  }),
  mechFn("block", ["from", "to"], "A fixed block on the floor (a step, a wall, a kerb): from, to: two opposite corners, mm, in the design's coordinates.", (a) => {
    const p = v3(a.value("from") ?? a.ctx.error("sim.block() needs from"), a.ctx, "sim.block(): from");
    const q = v3(a.value("to") ?? a.ctx.error("sim.block() needs to"), a.ctx, "sim.block(): to");
    return new MechValue({ k: "block", min: [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2])], max: [Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])] }, "block");
  }),
];

function flatItems(vs: Value[], ctx: CallCtx, out: MechItem[]) {
  for (const v of vs) {
    if (Array.isArray(v)) flatItems(v, ctx, out);
    else if (v instanceof MechValue && v.item.k !== "block") out.push(v.item);
    else ctx.error(`sim.mechanism(): each item should be sim.pivot(...), sim.gears(...), sim.spring(...) and so on, not ${typeName(v)}`);
  }
}

/** sim.mechanism(items..., base:, auto:, follow:) */
export const MECHANISM_FN = new Fn(
  "sim.mechanism",
  (pos, named, ctx) => {
    for (const k of Object.keys(named)) if (!["base", "auto", "follow"].includes(k)) ctx.error(`sim.mechanism() has no argument "${k}". It takes its items, then base:, auto: and follow:`);
    const items: MechItem[] = [];
    flatItems(pos, ctx, items);
    const base = named.base;
    if (base !== undefined && base !== "fixed" && base !== "free") ctx.error('sim.mechanism(): base should be "fixed" (bolted down) or "free" (standing on the floor)');
    const auto = named.auto === undefined ? true : named.auto === true || named.auto === 1;
    const follow = named.follow === undefined ? undefined : nameOf(named.follow, ctx, "sim.mechanism(): follow");
    const names = new Set<string>();
    for (const it of items) {
      if (!("name" in it)) continue;
      if (names.has(it.name)) ctx.error(`sim.mechanism(): two items are called "${it.name}": give one a name: of its own`);
      names.add(it.name);
    }
    const spec: MechSpec = { items, base: base as MechSpec["base"], auto, follow };
    return new MechSpecValue(spec);
  },
  'The design\'s moving parts as rigid bodies with real masses, for a scenario\'s mechanism: property. Items: sim.pivot, sim.slider, sim.ball, sim.weld, sim.free, sim.gears, sim.rack, sim.lead_screw, sim.worm, sim.chain, sim.couple, sim.cam, sim.clutch, sim.brake, sim.spring, sim.payload, sim.load, sim.jet, sim.turn, sim.motor, sim.push, sim.solenoid, sim.cylinder, sim.wheel, sim.track, sim.box, sim.power. base: "fixed" (bolted to the bench) or "free" (stands on sim.floor); auto: also add the design\'s own gear trains from spin:/mesh: and its timing belts (lib.belt) between pulleys on joints (true); follow: the part the camera follows. Everything not on a joint is the frame.',
);

export class MechSpecValue extends Obj {
  constructor(public spec: MechSpec) {
    super({}, "sim mechanism", "mechanism");
  }
}

/** sim.floor(...): an open floor for a machine that stands, drives or walks on it */
export const FLOOR_FN = new Fn(
  "sim.floor",
  (pos, named, ctx) => {
    const a = new Args("sim.floor", pos, named, ctx, ["surface", "grip", "roll", "slope", "uphill", "ambient", "blocks"]);
    const surface = a.str("surface", "concrete");
    const s = SURFACES[surface];
    if (!s) return ctx.error(`sim.floor(): surface should be one of ${Object.keys(SURFACES).map((k) => `"${k}"`).join(", ")}`);
    const bv = a.value("blocks");
    const list = bv === undefined ? [] : Array.isArray(bv) ? bv : [bv];
    const blocks = list.map((v, i) => (v instanceof MechValue && v.item.k === "block" ? { min: v.item.min, max: v.item.max } : ctx.error(`sim.floor(): block ${i + 1} should be sim.block(from: ..., to: ...)`)));
    const slope = a.num("slope", 0);
    if (slope < 0 || slope >= 60) ctx.error("sim.floor(): slope is in degrees, 0 to 60");
    const spec: FloorSpec = { surface, grip: a.num("grip", s.grip), roll: a.num("roll", s.roll), slope, uphill: dirOf(a, "uphill", [1, 0, 0])!, ambient: a.num("ambient", 20), blocks };
    return new FloorValue(spec);
  },
  'An open floor under the machine (with a mechanism: whose base is "free"): it stands, drives, climbs or tips on it. surface: "concrete", "wood", "tile", "carpet", "grass", "gravel", "sand" or "ice" (sets grip and roll); grip: friction coefficient; roll: rolling resistance coefficient; slope: degrees, rising along uphill: (X); ambient: °C; blocks: sim.block(...) steps and walls on it.',
);

export class FloorValue extends Obj {
  constructor(public spec: FloorSpec) {
    super({}, "sim world", "floor");
  }
}
