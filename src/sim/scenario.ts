// Scenarios in the design language: `scenario "label" for use { world: ...,
// robot: ..., firmware: brain, expect "label": ... }`. The `sim` namespace
// builds the world and machine descriptions; the evaluator turns a scenario
// block into a ScenarioDef the simulation worker can run, and keeps each
// expectation as an expression to check against the run's results.

import { Args } from "../lang/args";
import type { Expr, Span } from "../lang/ast";
import { Fn, Obj, Vec, typeName, type CallCtx, type Value } from "../lang/values";
import type { BenchSpec } from "./worlds/bench";
import type { HingeSpec, SandPitSpec, ScrewSpec, TunnellerSpec } from "./worlds/sandPit";
import { VARIANTS, type VariantName } from "./worlds/common";

/** A world or machine description made by a sim.* function. */
export class SimSpec extends Obj {
  constructor(
    public what: "world" | "robot" | "screw" | "hinge" | "type" | "config",
    public data: unknown,
    label: string,
  ) {
    super({}, `sim ${what}`, label);
  }
}

export type PitStart = number | "wall" | "buried";

export type WorldSpec =
  | { kind: "sand_pit"; pit: Omit<SandPitSpec, "start"> & { start: PitStart }; robot: TunnellerSpec }
  | { kind: "bench"; bench: BenchSpec };

/** Everything a run needs (the expectations are checked afterwards, on the main thread). */
export interface ScenarioSpec {
  label: string;
  world: WorldSpec;
  /** firmware block to run; the first one when left out */
  firmware?: string;
  /** longest simulated time, s */
  duration: number;
  console: { t: number; text: string }[];
  /** #define values to change in the generated firmware for this run */
  config: Record<string, number | string>;
  variants: VariantName[];
  /** battery charge at the start, 0..1 */
  charge: number;
  seed: number;
}

export interface ScenarioExpect {
  label: string;
  level: "hard" | "soft";
  expr: Expr;
  /** the expression as written */
  text: string;
  /** design values the expression names, captured when the design was evaluated */
  env: Record<string, number | string | boolean>;
  span: Span;
}

export interface ScenarioDef {
  label: string;
  uses: string[];
  spec: ScenarioSpec;
  expects: ScenarioExpect[];
  span: Span;
  labelSpan: Span;
}

export const SCENARIO_PROPS = ["world", "robot", "firmware", "duration", "console", "config", "variants", "charge", "seed"];

// ---------- the sim namespace ----------

function simFn(name: string, params: string[], doc: string, impl: (a: Args, ctx: CallCtx) => Value): [string, Fn] {
  return [name, new Fn(`sim.${name}`, (pos, named, ctx) => impl(new Args(`sim.${name}`, pos, named, ctx, params), ctx), doc)];
}

const compName = (v: Value | undefined, ctx: CallCtx, what: string): string => {
  if (v instanceof Obj && v.kind === "component") return String(v.fields.name);
  return ctx.error(`${what} should be a component, like m_front (got ${v === undefined ? "nothing" : typeName(v)})`);
};

const signOf = (v: Value | undefined, ctx: CallCtx, what: string, def: number): number => {
  if (v === undefined) return def;
  if (typeof v === "number") return v < 0 ? -1 : 1;
  if (v instanceof Vec) return v.x < 0 ? -1 : 1;
  return ctx.error(`${what} should be X or -X`);
};

const SIM_FNS: Record<string, Fn> = Object.fromEntries([
  simFn(
    "sand_pit",
    ["length", "width", "depth", "axis", "density", "phi", "wall_phi", "start", "exit", "ambient"],
    "A box of dry sand the machine burrows across along its bottom. length: wall to wall along the path; width: across it; depth: sand above the floor; axis: the machine's axis above the floor (100 mm); density: g/cm³ (1.6); phi: friction angle (32deg); wall_phi: sand on the walls (2/3 phi); start: \"buried\" (laid on the floor against the near wall), \"wall\" (its rear section in a hole in the near wall, the front in the sand) or a distance in from the near wall; exit: diameter of the opening in the far wall it has to come out through (leave out for a solid wall); ambient: sand temperature (15C).",
    (a) => {
      const phi = a.num("phi", 32);
      const st = a.value("start");
      let start: PitStart = "buried";
      if (typeof st === "number") start = st;
      else if (st === "wall" || st === "buried") start = st;
      else if (st !== undefined) a.ctx.error('sim.sand_pit(): start should be "buried", "wall" or a distance in from the near wall');
      const pit = {
        length: a.positive("length"),
        width: a.positive("width"),
        depth: a.positive("depth"),
        axis: a.positive("axis", 100),
        density: a.positive("density", 1.6),
        phi,
        wallPhi: a.num("wall_phi", (2 / 3) * phi),
        start,
        exitD: a.num("exit", 0),
        ambient: a.num("ambient", 15),
      };
      return new SimSpec("world", { kind: "sand_pit", pit }, "sand pit");
    },
  ),
  simFn(
    "bench",
    ["load", "force", "range", "ambient"],
    "The machine on the bench: motors turn against their design load (load: on each motor) and sensors see a still, level machine. Use it for power-up, battery runtime, overload and hot-room tests. load: share of the design load (1; 0 runs the motors free, 1.5 is a 50 % overload); force: push on each linear actuator's rod (0 N); range: what a distance sensor sees (1 m); ambient: room temperature (20C).",
    (a) => {
      const load = a.num("load", 1);
      if (load < 0) a.ctx.error("sim.bench(): load is a share of the design load, 0 or more");
      return new SimSpec("world", { kind: "bench", bench: { loads: {}, loadFactor: load, forces: {}, force: a.num("force", 0), range: a.positive("range", 1000), ambient: a.num("ambient", 20) } }, "bench");
    },
  ),
  simFn(
    "screw",
    ["motor", "d", "core", "pitch", "from", "length", "dir", "face", "advance", "turn"],
    "One screw section of a burrowing machine. motor: the gearmotor that turns it; d: flight outside diameter; core: shell diameter; pitch: flight pitch; from: design X where the flights start; length: flighted length along dir (X or -X, default X); face: true for the section that cuts the face; advance: -1 if it pulls backwards when its motor turns forward; turn: its turning sense about X, 1 or -1 (the face section 1 and the others -1 by default, so they counter-rotate).",
    (a, ctx) => {
      const motorV = a.value("motor");
      const motor = compName(motorV, ctx, "sim.screw(): motor");
      const from = a.num("from");
      const length = a.positive("length");
      const dir = signOf(a.value("dir"), ctx, "sim.screw(): dir", 1);
      const face = a.bool("face", false);
      const s: ScrewSpec = {
        motor,
        d: a.positive("d"),
        core: a.positive("core"),
        pitch: a.positive("pitch"),
        from: dir > 0 ? from : from - length,
        to: dir > 0 ? from + length : from,
        face,
        advance: a.num("advance", 1) < 0 ? -1 : 1,
        // counter-rotating sections by default: their twisting cancels
        turn: a.has("turn") ? (a.num("turn") < 0 ? -1 : 1) : face ? 1 : -1,
      };
      if (s.core >= s.d) ctx.error("sim.screw(): core must be smaller than d");
      return new SimSpec("screw", s, `screw on ${motor}`);
    },
  ),
  simFn(
    "cam_hinge",
    ["actuator", "arm", "slope", "mid", "stop", "extend", "friction", "at"],
    "A steering hinge (vertical pin) worked by a linear actuator through a slanted cam slot. actuator: the actuator component; arm: hinge pin to the follower pin; slope: sideways movement per mm of stroke; mid: stroke when straight; stop: hinge angle (deg) where the slot ends stop it; extend: \"left\" or \"right\", the way the nose turns as the actuator extends; friction: in the slot (0.2); at: design X of the hinge pin (0).",
    (a, ctx) => hinge(a, ctx, a.positive("slope"), a.num("friction", 0.2)),
  ),
  simFn(
    "hinge",
    ["actuator", "arm", "mid", "stop", "extend", "at"],
    "A steering hinge (vertical pin) pushed directly by a linear actuator on a lever. actuator: the actuator; arm: hinge pin to where it pushes, at right angles; mid: stroke when straight; stop: largest hinge angle (deg); extend: \"left\" or \"right\", the way the nose turns as it extends; at: design X of the hinge pin (0).",
    (a, ctx) => hinge(a, ctx, 1, 0.05),
  ),
  simFn(
    "screw_tunneller",
    ["screws", "delta", "body", "between", "nose", "tail", "hinge", "imu_on"],
    "A burrowing machine driven by screw sections. screws: a list of sim.screw(...); delta: sand sliding on its shell (0.6 × 32deg); body: diameter of the part that does not turn; between: its design X range (from, to); nose, tail: design X of the front and rear tips; hinge: a sim.cam_hinge(...) or sim.hinge(...) if it steers; imu_on: \"rear\" or \"front\", the body its IMU rides on (by its position when left out).",
    (a, ctx) => {
      const list = a.value("screws");
      if (!Array.isArray(list) || !list.length) return ctx.error("sim.screw_tunneller(): screws should be a list of sim.screw(...)");
      const screws = list.map((v, i) => (v instanceof SimSpec && v.what === "screw" ? (v.data as ScrewSpec) : ctx.error(`sim.screw_tunneller(): screw ${i + 1} is ${typeName(v)}, not sim.screw(...)`)));
      const between = a.value("between");
      if (!(between instanceof Vec) || between.v.length !== 2) return ctx.error("sim.screw_tunneller(): between should be the static body's design X range, like (r_shell0, f0)");
      const hv = a.value("hinge");
      let hingeSpec: HingeSpec | undefined;
      if (hv !== undefined) {
        if (!(hv instanceof SimSpec && hv.what === "hinge")) return ctx.error("sim.screw_tunneller(): hinge should be sim.cam_hinge(...) or sim.hinge(...)");
        hingeSpec = hv.data as HingeSpec;
      }
      const imuOn = a.has("imu_on") ? a.str("imu_on") : undefined;
      if (imuOn !== undefined && imuOn !== "rear" && imuOn !== "front") ctx.error('sim.screw_tunneller(): imu_on should be "rear" or "front"');
      const nose = a.num("nose");
      const tail = a.num("tail");
      if (nose <= tail) ctx.error("sim.screw_tunneller(): nose must be in front of tail (a larger X)");
      const robot: TunnellerSpec & { imuOn?: string } = {
        screws,
        delta: a.num("delta", 0.6 * 32),
        body: { d: a.positive("body"), from: Math.min(between.v[0], between.v[1]), to: Math.max(between.v[0], between.v[1]) },
        nose,
        tail,
        hinge: hingeSpec,
        imus: {},
        imuOn,
      };
      return new SimSpec("robot", robot, "screw tunneller");
    },
  ),
  simFn("type", ["text", "at"], 'Text typed into the serial console during the run. text: what to type (a newline is added); at: when, seconds after power-up.', (a) => new SimSpec("type", { t: a.num("at", 1), text: a.str("text") }, "console input")),
]);

function hinge(a: Args, ctx: CallCtx, slope: number, friction: number): SimSpec {
  const actuator = compName(a.value("actuator"), ctx, `${a.fname}(): actuator`);
  const ext = a.str("extend", "left");
  if (ext !== "left" && ext !== "right") ctx.error(`${a.fname}(): extend should be "left" or "right"`);
  const h: HingeSpec = { x: a.num("at", 0), actuator, arm: a.positive("arm"), slope, mid: a.num("mid"), stop: a.positive("stop"), dir: ext === "left" ? 1 : -1, friction };
  return new SimSpec("hinge", h, `hinge on ${actuator}`);
}

/** sim.config(NAME: value, ...): #define values to change in the generated firmware. Takes any names. */
const CONFIG_FN = new Fn(
  "sim.config",
  (pos, named, ctx) => {
    if (pos.length) ctx.error("sim.config() takes named values only, like sim.config(STEER_SIGN: -1)");
    const out: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(named)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) ctx.error(`sim.config(): "${k}" is not a firmware setting name (they are in capitals, like POWER)`);
      if (typeof v === "number" || typeof v === "string") out[k] = v;
      else if (typeof v === "boolean") out[k] = v ? 1 : 0;
      else ctx.error(`sim.config(): ${k} should be a number or text`);
    }
    return new SimSpec("config", out, "firmware settings");
  },
  "Firmware settings (#define values in config.h) to change for this run only, e.g. sim.config(STEER_SIGN: -1, POWER: 0.7). Use it to try a fix before changing the firmware block.",
);

const SIM_ENTRIES: [string, Fn][] = [...Object.entries(SIM_FNS), ["config", CONFIG_FN]];
export const SIM_DOCS: Record<string, string> = Object.fromEntries(SIM_ENTRIES.map(([k, f]) => [k, f.doc ?? ""]));

export function simNamespace(): Obj {
  return new Obj({ ...SIM_FNS, config: CONFIG_FN }, "simulations", "sim");
}

// ---------- scenario props to a spec ----------

export interface ScenarioProps {
  get(name: string): Value | undefined;
  span(name: string): Span;
  firmware?: string;
}

/**
 * Builds the run spec from a scenario's evaluated properties. `fail` raises
 * an error at a property; `imuX` gives the design X of each IMU component.
 */
export function scenarioSpec(label: string, p: ScenarioProps, fail: (msg: string, span: Span) => never, imuX: Record<string, number>): ScenarioSpec {
  const world = p.get("world");
  if (world === undefined) return fail(`Scenario "${label}" needs a world, like world: sim.sand_pit(length: 2m, width: 0.5m, depth: 5m) or world: sim.bench()`, p.span("world"));
  if (!(world instanceof SimSpec && world.what === "world")) return fail(`world: should be sim.sand_pit(...) or sim.bench(...), not ${typeName(world)}`, p.span("world"));
  const w = world.data as { kind: string };
  let ws: WorldSpec;
  if (w.kind === "sand_pit") {
    const robot = p.get("robot");
    if (!(robot instanceof SimSpec && robot.what === "robot")) return fail("A sand pit needs the machine in it: robot: sim.screw_tunneller(...)", p.span(robot === undefined ? "world" : "robot"));
    const r = robot.data as TunnellerSpec & { imuOn?: string };
    const h = r.hinge?.x ?? 0;
    const imus: Record<string, number> = {};
    for (const [name, x] of Object.entries(imuX)) imus[name] = r.imuOn === "front" ? h + 1 : r.imuOn === "rear" ? h - 1 : x;
    const { imuOn: _drop, ...rest } = r;
    void _drop;
    ws = { kind: "sand_pit", pit: (w as unknown as { pit: Omit<SandPitSpec, "start"> & { start: PitStart } }).pit, robot: { ...rest, imus } };
  } else ws = w as WorldSpec;
  const duration = num(p, "duration", 600, fail);
  if (duration <= 0 || duration > 4 * 3600) fail("duration: between 1 s and 4 h of simulated time", p.span("duration"));
  const consoleV = p.get("console");
  const consoleList: { t: number; text: string }[] = [];
  if (consoleV !== undefined) {
    const items = Array.isArray(consoleV) ? consoleV : [consoleV];
    for (const it of items) {
      if (it instanceof SimSpec && it.what === "type") consoleList.push(it.data as { t: number; text: string });
      else if (typeof it === "string") consoleList.push({ t: 1, text: it });
      else fail('console: should be a list of sim.type("g", at: 2s)', p.span("console"));
    }
  }
  const cfg = p.get("config");
  if (cfg !== undefined && !(cfg instanceof SimSpec && cfg.what === "config")) fail("config: should be sim.config(NAME: value, ...)", p.span("config"));
  const vs = p.get("variants");
  let variants: VariantName[] = [...VARIANTS];
  if (vs !== undefined) {
    const list = Array.isArray(vs) ? vs : [vs];
    variants = list.map((v) => (typeof v === "string" && (VARIANTS as string[]).includes(v) ? (v as VariantName) : fail(`variants: each should be one of ${VARIANTS.map((x) => `"${x}"`).join(", ")}`, p.span("variants"))));
    if (!variants.length) fail("variants: give at least one", p.span("variants"));
  }
  const charge = num(p, "charge", 1, fail);
  if (charge <= 0 || charge > 1) fail("charge: the battery's charge at the start, like 100% or 60%", p.span("charge"));
  return {
    label,
    world: ws,
    firmware: p.firmware,
    duration,
    console: consoleList,
    config: cfg instanceof SimSpec ? (cfg.data as Record<string, number | string>) : {},
    variants,
    charge,
    seed: Math.round(num(p, "seed", 1, fail)),
  };
}

function num(p: ScenarioProps, name: string, def: number, fail: (msg: string, span: Span) => never): number {
  const v = p.get(name);
  if (v === undefined) return def;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fail(`${name}: should be a number`, p.span(name));
}
