// Scenarios in the design language: `scenario "label" for use { world: ...,
// robot: ..., firmware: brain, expect "label": ... }`. The `sim` namespace
// builds the world and machine descriptions; the evaluator turns a scenario
// block into a ScenarioDef the simulation worker can run, and keeps each
// expectation as an expression to check against the run's results.

import { Args } from "../lang/args";
import type { Expr, Span } from "../lang/ast";
import { Fn, Obj, Vec, typeName, type CallCtx, type Value } from "../lang/values";
import type { BenchSpec } from "./worlds/bench";
import { noteHz, type SignalShape, type SignalSpec } from "./worlds/signals";
import type { HingeSpec, SandPitSpec, ScrewSpec, TunnellerSpec } from "./worlds/sandPit";
import { VARIANTS, type VariantName } from "./worlds/common";
import { catalogPart } from "../machine/catalog";
import type { MachineData } from "../machine/types";

/** A world or machine description made by a sim.* function. */
export class SimSpec extends Obj {
  constructor(
    public what: "world" | "robot" | "screw" | "hinge" | "type" | "config" | "signal" | "fault",
    public data: unknown,
    label: string,
  ) {
    super({}, `sim ${what}`, label);
  }
}

export type PitStart = number | "wall" | "buried";

/**
 * Something going wrong during a run, to see how the machine copes: a motor
 * or actuator jams, a part is unplugged, one wire comes loose, a sensor
 * freezes, or the battery is an old one.
 */
export type FaultKind = "jam" | "unplug" | "loose" | "stuck" | "aged";

export interface FaultSpec {
  kind: FaultKind;
  /** a component name, or "component.PIN" for one loose wire */
  target: string;
  /** seconds after power-up */
  at: number;
  /** when it clears, seconds after power-up (it lasts to the end when left out) */
  until?: number;
  /** a loose wire that keeps making and losing contact */
  flicker?: boolean;
  /** an old battery: the share of its capacity it still has */
  capacity?: number;
  /** an old battery: how many times its new internal resistance */
  resistance?: number;
}

export const FAULT_WORDS: Record<FaultKind, string> = { jam: "jams", unplug: "is unplugged", loose: "comes loose", stuck: "freezes", aged: "is an old one" };

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
  /** things that go wrong during the run (left out when nothing does) */
  faults?: FaultSpec[];
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

export const SCENARIO_PROPS = ["like", "world", "robot", "firmware", "duration", "console", "config", "variants", "charge", "seed", "faults"];

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
    ["length", "width", "depth", "axis", "density", "phi", "wall_phi", "start", "exit", "ambient", "push", "push_to"],
    "A box of dry sand the machine burrows across along its bottom. length: wall to wall along the path; width: across it; depth: sand above the floor; axis: the machine's axis above the floor (100 mm); density: g/cm³ (1.6); phi: friction angle (32deg); wall_phi: sand on the walls (2/3 phi); start: \"buried\" (laid on the floor against the near wall), \"wall\" (its rear section in a hole in the near wall, the front in the sand) or a distance in from the near wall; exit: diameter of the opening in the far wall it has to come out through (leave out for a solid wall); ambient: sand temperature (15C); push: the most a helper pushes the tail with to get it started from the wall (leave out for no help; 150N is a firm push); push_to: how far they push it in (until every screw is in the sand when left out).",
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
        push: a.num("push", 0),
        pushTo: a.num("push_to", 0),
      };
      return new SimSpec("world", { kind: "sand_pit", pit }, "sand pit");
    },
  ),
  simFn(
    "bench",
    ["load", "force", "range", "ambient", "signals"],
    "The machine on the bench: motors turn against their design load (load: on each motor) and sensors see a still, level machine. Use it for power-up, battery runtime, overload and hot-room tests. load: share of the design load (1; 0 runs the motors free, 1.5 is a 50 % overload); force: push on each linear actuator's rod (0 N); range: what a distance sensor sees (1 m); ambient: room temperature (20C); signals: a sim.signal(...) or a list of them, test signals on nets that reach the controller's analog inputs.",
    (a, ctx) => {
      const load = a.num("load", 1);
      if (load < 0) a.ctx.error("sim.bench(): load is a share of the design load, 0 or more");
      const sv = a.value("signals");
      const list = sv === undefined ? [] : Array.isArray(sv) ? sv : [sv];
      const signals = list.map((v, i) => (v instanceof SimSpec && v.what === "signal" ? (v.data as SignalSpec) : ctx.error(`sim.bench(): signal ${i + 1} is ${typeName(v)}, not sim.signal(...)`)));
      return new SimSpec("world", { kind: "bench", bench: { loads: {}, loadFactor: load, forces: {}, force: a.num("force", 0), range: a.positive("range", 1000), ambient: a.num("ambient", 20), signals } }, "bench");
    },
  ),
  simFn(
    "signal",
    ["on", "note", "f", "cents", "shape", "amplitude", "offset", "start", "every", "decay"],
    'A test signal on a net that reaches one of the controller\'s analog inputs, for sim.bench(signals: ...). on: the net\'s name ("TUNER_IN") or "component.PIN"; note: a note name ("E2", "A4", "C#3") or f: its frequency; cents: how far off the note it is (+ sharp); shape: "pluck" (a plucked string, the default with a note), "sine" (the default with f) or "square"; amplitude: peak volts either side of the offset (0.5V); offset: the volts it sits at (2.5V); start: when it starts, seconds after power-up (1s); every: seconds between plucks (3s; 0 plucks once); decay: seconds for a pluck to fade to 37 % (1.5s).',
    (a, ctx) => {
      const on = a.str("on");
      const note = a.value("note");
      let f = a.num("f", 0);
      if (note !== undefined) {
        if (typeof note !== "string" || !Number.isFinite(noteHz(note))) return ctx.error(`sim.signal(): note should be a note name like "E2", "A4" or "C#3"`);
        f = noteHz(note);
      }
      if (!(f > 0)) return ctx.error("sim.signal(): give a note (\"E2\") or a frequency (f: 82.41Hz)");
      f *= 2 ** (a.num("cents", 0) / 1200);
      const shape = a.str("shape", note !== undefined ? "pluck" : "sine");
      if (shape !== "pluck" && shape !== "sine" && shape !== "square") return ctx.error('sim.signal(): shape should be "pluck", "sine" or "square"');
      const spec: SignalSpec = {
        on,
        shape: shape as SignalShape,
        f,
        note: typeof note === "string" ? note : undefined,
        amplitude: a.num("amplitude", 0.5),
        offset: a.num("offset", 2.5),
        start: a.num("start", 1),
        every: a.num("every", shape === "pluck" ? 3 : 0),
        decay: a.positive("decay", 1.5),
      };
      return new SimSpec("signal", spec, `signal on ${on}`);
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
  simFn(
    "jam",
    ["part", "at", "until"],
    "A gearmotor or linear actuator jams: it locks solid whichever way it is driven. part: the motor or actuator; at: when, seconds after power-up; until: when it frees again (it stays jammed when left out). For scenario faults: [...].",
    (a, ctx) => fault("jam", compName(a.value("part"), ctx, "sim.jam(): part"), a),
  ),
  simFn(
    "unplug",
    ["part", "at", "until"],
    "A part comes unplugged: every wire to it is cut. part: any component but the controller (a sensor stops answering, a motor or actuator goes limp, a driver's outputs go off, a battery cuts the power); at: when; until: when it is plugged back in.",
    (a, ctx) => fault("unplug", compName(a.value("part"), ctx, "sim.unplug(): part"), a),
  ),
  simFn(
    "loose",
    ["wire", "at", "until", "flicker"],
    'One wire comes loose. wire: the pin at either end, "component.PIN" like "m_front.ENC_A" or "brain.D5"; at: when; until: when it is pushed back on; flicker: true for a wire that keeps making and losing contact (every 0.05 to 1 s).',
    (a, ctx) => {
      const w = a.value("wire");
      const target = w instanceof Obj && w.kind === "component" ? String(w.fields.name) : typeof w === "string" ? w : ctx.error('sim.loose(): wire should be "component.PIN", like "m_front.ENC_A"');
      if (typeof w === "string" && !/^[A-Za-z_]\w*\.[A-Za-z0-9_+-]+$/.test(w)) ctx.error(`sim.loose(): "${w}" should be "component.PIN", like "m_front.ENC_A"`);
      return fault(typeof w === "string" ? "loose" : "unplug", target, a, a.bool("flicker", false));
    },
  ),
  simFn(
    "stuck",
    ["part", "at", "until"],
    "A sensor freezes: it keeps answering, but with the reading it had at that moment. part: an IMU, distance or voltage sensor, an actuator (its position feedback) or a gearmotor (its encoder stops counting); at: when; until: when it recovers.",
    (a, ctx) => fault("stuck", compName(a.value("part"), ctx, "sim.stuck(): part"), a),
  ),
  simFn(
    "aged",
    ["part", "capacity", "resistance"],
    "An old battery, for the whole run: part: the battery; capacity: the share of its new capacity it still holds (80% is the usual end of life); resistance: how many times its new internal resistance (1.5).",
    (a, ctx) => {
      const capacity = a.num("capacity", 0.8);
      const resistance = a.num("resistance", 1.5);
      if (!(capacity > 0 && capacity <= 1)) ctx.error("sim.aged(): capacity is the share it still holds, like 80%");
      if (!(resistance >= 1)) ctx.error("sim.aged(): resistance is how many times its new resistance, 1 or more, like 1.5");
      return new SimSpec("fault", { kind: "aged", target: compName(a.value("part"), ctx, "sim.aged(): part"), at: 0, capacity, resistance } satisfies FaultSpec, "old battery");
    },
  ),
  simFn("type", ["text", "at"], 'Text typed into the serial console during the run. text: what to type (a newline is added); at: when, seconds after power-up.', (a) => new SimSpec("type", { t: a.num("at", 1), text: a.str("text") }, "console input")),
]);

function fault(kind: FaultKind, target: string, a: Args, flicker = false): SimSpec {
  const at = a.num("at", 0);
  if (at < 0) a.ctx.error(`${a.fname}(): at is a time after power-up, like 1min`);
  const until = a.has("until") ? a.num("until") : undefined;
  if (until !== undefined && until <= at) a.ctx.error(`${a.fname}(): until must be later than at`);
  const f: FaultSpec = { kind, target, at, ...(until !== undefined ? { until } : {}), ...(flicker ? { flicker } : {}) };
  return new SimSpec("fault", f, `${target} ${FAULT_WORDS[kind]}`);
}

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
export function scenarioSpec(
  label: string,
  p: ScenarioProps,
  fail: (msg: string, span: Span) => never,
  imuX: Record<string, number>,
  opts: { base?: ScenarioSpec; machine?: MachineData } = {},
): ScenarioSpec {
  const { base, machine } = opts;
  // like: another scenario takes everything this one leaves out from it
  const inherit = <K extends keyof ScenarioSpec>(name: string, key: K, own: () => ScenarioSpec[K]): ScenarioSpec[K] => (base && p.get(name) === undefined ? base[key] : own());
  const world = p.get("world");
  const robot = p.get("robot");
  let ws: WorldSpec;
  if (world === undefined && base) {
    if (robot !== undefined) return fail("robot: goes with a world: give the world too, or leave robot: out to keep the one from like:", p.span("robot"));
    ws = base.world;
  } else {
    if (world === undefined) return fail(`Scenario "${label}" needs a world, like world: sim.sand_pit(length: 2m, width: 0.5m, depth: 5m) or world: sim.bench()`, p.span("world"));
    if (!(world instanceof SimSpec && world.what === "world")) return fail(`world: should be sim.sand_pit(...) or sim.bench(...), not ${typeName(world)}`, p.span("world"));
    const w = world.data as { kind: string };
    if (w.kind === "sand_pit") {
      const pit = (w as unknown as { pit: Omit<SandPitSpec, "start"> & { start: PitStart } }).pit;
      if (robot === undefined && base?.world.kind === "sand_pit") ws = { kind: "sand_pit", pit, robot: base.world.robot };
      else {
        if (!(robot instanceof SimSpec && robot.what === "robot")) return fail("A sand pit needs the machine in it: robot: sim.screw_tunneller(...)", p.span(robot === undefined ? "world" : "robot"));
        const r = robot.data as TunnellerSpec & { imuOn?: string };
        const h = r.hinge?.x ?? 0;
        const imus: Record<string, number> = {};
        for (const [name, x] of Object.entries(imuX)) imus[name] = r.imuOn === "front" ? h + 1 : r.imuOn === "rear" ? h - 1 : x;
        const { imuOn: _drop, ...rest } = r;
        void _drop;
        ws = { kind: "sand_pit", pit, robot: { ...rest, imus } };
      }
    } else ws = w as WorldSpec;
  }
  return {
    label,
    world: ws,
    firmware: p.firmware ?? base?.firmware,
    duration: inherit("duration", "duration", () => duration(p, fail)),
    console: inherit("console", "console", () => consoleOf(p, fail)),
    config: inherit("config", "config", () => configOf(p, fail)),
    variants: inherit("variants", "variants", () => variantsOf(p, fail)),
    charge: inherit("charge", "charge", () => chargeOf(p, fail)),
    seed: inherit("seed", "seed", () => Math.round(num(p, "seed", 1, fail))),
    faults: faultList(p, fail, machine),
  };
}

function duration(p: ScenarioProps, fail: (msg: string, span: Span) => never): number {
  const d = num(p, "duration", 600, fail);
  if (d <= 0 || d > 4 * 3600) fail("duration: more than 0 s and at most 4 h of simulated time", p.span("duration"));
  return d;
}

function consoleOf(p: ScenarioProps, fail: (msg: string, span: Span) => never): { t: number; text: string }[] {
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
  return consoleList;
}

function configOf(p: ScenarioProps, fail: (msg: string, span: Span) => never): Record<string, number | string> {
  const cfg = p.get("config");
  if (cfg !== undefined && !(cfg instanceof SimSpec && cfg.what === "config")) fail("config: should be sim.config(NAME: value, ...)", p.span("config"));
  return cfg instanceof SimSpec ? (cfg.data as Record<string, number | string>) : {};
}

function variantsOf(p: ScenarioProps, fail: (msg: string, span: Span) => never): VariantName[] {
  const vs = p.get("variants");
  let variants: VariantName[] = [...VARIANTS];
  if (vs !== undefined) {
    const list = Array.isArray(vs) ? vs : [vs];
    variants = list.map((v) => (typeof v === "string" && (VARIANTS as string[]).includes(v) ? (v as VariantName) : fail(`variants: each should be one of ${VARIANTS.map((x) => `"${x}"`).join(", ")}`, p.span("variants"))));
    if (!variants.length) fail("variants: give at least one", p.span("variants"));
  }
  return variants;
}

function chargeOf(p: ScenarioProps, fail: (msg: string, span: Span) => never): number {
  const charge = num(p, "charge", 1, fail);
  if (charge <= 0 || charge > 1) fail("charge: the battery's charge at the start, like 100% or 60%", p.span("charge"));
  return charge;
}

/** Kinds of part each fault can happen to. */
const FAULT_KINDS: Record<FaultKind, (k: string) => boolean> = {
  jam: (k) => k === "gearmotor" || k === "actuator",
  unplug: (k) => k !== "controller",
  loose: () => true,
  stuck: (k) => k === "sensor" || k === "actuator" || k === "gearmotor",
  aged: (k) => k === "battery",
};

const FAULT_PARTS: Record<FaultKind, string> = {
  jam: "a gearmotor or linear actuator",
  unplug: "any part but the controller",
  loose: "any part",
  stuck: "a sensor, an actuator or a gearmotor with an encoder",
  aged: "a battery",
};

/** The faults: list, checked against the design's parts and their pins. */
function faultList(p: ScenarioProps, fail: (msg: string, span: Span) => never, machine?: MachineData): FaultSpec[] | undefined {
  const v = p.get("faults");
  if (v === undefined) return undefined;
  const items = Array.isArray(v) ? v : [v];
  const out: FaultSpec[] = [];
  for (const it of items) {
    if (!(it instanceof SimSpec && it.what === "fault")) return fail("faults: should be a list of sim.jam(...), sim.unplug(...), sim.loose(...), sim.stuck(...) or sim.aged(...)", p.span("faults"));
    const f = it.data as FaultSpec;
    if (machine) {
      const [comp, pin] = f.target.split(".");
      const mc = machine.components.find((c) => c.name === comp);
      if (!mc) return fail(`faults: ${comp} is not a part of the machine`, p.span("faults"));
      if (!FAULT_KINDS[f.kind](mc.kind)) return fail(`faults: sim.${f.kind}() is for ${FAULT_PARTS[f.kind]}, and ${comp} is a ${mc.kind.replace(/_/g, " ")}`, p.span("faults"));
      if (pin !== undefined) {
        const pins = catalogPart(mc.catalogId)?.pins ?? [];
        if (!pins.some((x) => x.id === pin)) return fail(`faults: ${comp} has no pin ${pin}${pins.length ? `. Its pins: ${pins.map((x) => x.id).join(", ")}` : ""}`, p.span("faults"));
      }
    }
    out.push(f);
  }
  return out.length ? out : undefined;
}

function num(p: ScenarioProps, name: string, def: number, fail: (msg: string, span: Span) => never): number {
  const v = p.get(name);
  if (v === undefined) return def;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fail(`${name}: should be a number`, p.span(name));
}
