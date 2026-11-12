// The `app` block of the design language: a control room or live view for
// the machine, made of panels that read its signals and controls that send
// it commands. The functions here only exist inside an app block.
//
//   app "Maglev control room" {
//     twin: "Hold the model in the full wind and read its drag"
//     baud: 500000
//     hello: "log on"
//     telemetry: [csv("T", "ms mode x:µm y:µm z:µm zref iLift:mA i1:mA i2:mA i3:mA i4:mA")]
//     derive: [derive("air", "speed / 100", unit: "m/s", label: "air speed")]
//     panels: [
//       readout("Wind", [signal("air", max: 15), signal("drag / 100", label: "drag", unit: "mN")], big: true),
//       scope("Top view", "x", "y", range: 600, unit: "µm"),
//       chart("Position", ["x", "y", "z"], window: 30s),
//       controls("Run", [button("Launch", "launch", tone: "accent"), button("Land", "land"), slider("Fan", "fan {}", max: 100, unit: "%")]),
//       console(),
//     ]
//   }

import { Args } from "../lang/args";
import { Fn, Obj, typeName, type Value } from "../lang/values";
import type { Span } from "../lang/ast";
import { compiled, ExprError } from "./expr";
import { parseColumns } from "./lines";
import { panelKindInfo, type AppSpec, type ControlSpec, type DeriveDef, type LampDef, type ModelMove, type PanelKind, type PanelSpec, type SignalItem, type TelemetryFormat } from "./spec";

export const APP_PROPS = ["twin", "firmware", "baud", "hello", "telemetry", "derive", "commands", "columns", "window", "accent", "about", "panels"];
const FLAGS = ["locked"];

const FORMAT = "app telemetry";
const DERIVE = "app value";
const SIGNAL = "app signal";
const PANEL = "app panel";
const CONTROL = "app control";
const LAMP = "app lamp";
const ZONE = "gauge zone";
const MOVE = "model move";

function def(name: string, params: string[], impl: (a: Args) => Value, doc: string): [string, Fn] {
  return [name, new Fn(name, (pos, named, ctx) => impl(new Args(name, pos, named, ctx, params)), doc)];
}

const wrap = (kind: string, spec: unknown, label: string) => new Obj({ spec: spec as Value }, kind, label);
const unwrap = <T>(v: Value | undefined, kind: string): T | undefined => (v instanceof Obj && v.kind === kind ? (v.fields.spec as unknown as T) : undefined);

/** An expression for a signal, checked as it is written. */
function exprArg(a: Args, name: string, def?: string): string {
  const s = a.str(name, def).trim();
  const c = compiled(s);
  if (c instanceof ExprError) a.ctx.error(`${a.fname}(): ${name} "${s}": ${c.message}`);
  return s;
}

function optExpr(a: Args, name: string): string | undefined {
  return a.has(name) ? exprArg(a, name) : undefined;
}

const optStr = (a: Args, name: string) => (a.has(name) ? a.str(name) : undefined);
const optNum = (a: Args, name: string) => (a.has(name) ? a.num(name) : undefined);

function toSignal(v: Value, a: Args, what: string): SignalItem {
  const s = unwrap<SignalItem>(v, SIGNAL);
  if (s) return s;
  if (typeof v === "string") {
    const c = compiled(v.trim());
    if (c instanceof ExprError) a.ctx.error(`${a.fname}(): ${what} "${v}": ${c.message}`);
    return { expr: v.trim() };
  }
  return a.ctx.error(`${a.fname}(): ${what} should be a signal's name or expression in quotes ("drag / 100") or signal("…", unit: "mN"), got ${typeName(v)}`);
}

function signalList(a: Args, name: string): SignalItem[] {
  const v = a.value(name);
  if (v === undefined) return a.ctx.error(`${a.fname}() needs ${name}: a signal in quotes, or a list of them`);
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) a.ctx.error(`${a.fname}(): ${name} is an empty list`);
  if (list.length > 24) a.ctx.error(`${a.fname}(): ${list.length} signals is too many for one panel (24 at most): split them over two panels`);
  return list.map((x, i) => toSignal(x, a, list.length > 1 ? `signal ${i + 1}` : name));
}

function strList(a: Args, name: string): string[] {
  const v = a.value(name);
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x, i) => {
    if (typeof x === "string") return x;
    if (typeof x === "number") return String(x);
    return a.ctx.error(`${a.fname}(): item ${i + 1} of ${name} should be text in quotes, got ${typeName(x)}`);
  });
}

/** Grid size: w and h, or the kind's usual size. */
function size(a: Args, kind: PanelKind): { w: number; h: number } {
  const info = panelKindInfo(kind);
  const w = Math.round(a.num("w", info.w));
  const h = Math.round(a.num("h", info.h));
  if (w < 1 || w > 12) a.ctx.error(`${a.fname}(): w is the panel's width in grid columns, 1 to 12 (got ${w})`);
  if (h < 1 || h > 12) a.ctx.error(`${a.fname}(): h is the panel's height in grid rows, 1 to 12 (got ${h})`);
  return { w, h };
}

const panel = (kind: PanelKind, a: Args, rest: object, title?: string) => wrap(PANEL, { kind, title: title ?? a.str("title", panelKindInfo(kind).label), ...size(a, kind), ...rest }, `${kind} panel`);
const SIZE = ["w", "h"];

function controlKey(a: Args): string | undefined {
  const k = optStr(a, "key");
  if (k !== undefined && !/^[a-z0-9 ]$/i.test(k)) a.ctx.error(`${a.fname}(): key is one letter, digit or " " (the space bar), got "${k}"`);
  return k;
}

const COLORS = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|accent|green|amber|red|blue|violet|teal|grey|gray)$/i;
function color(a: Args, name: string): string | undefined {
  const v = a.value(name);
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : v instanceof Obj && v.kind === "color" ? String(v.fields.hex) : null;
  if (!s || !COLORS.test(s)) return a.ctx.error(`${a.fname}(): ${name} is a colour: #rrggbb, or one of accent, green, amber, red, blue, violet, teal, grey`);
  return s;
}

/** Functions that only exist inside app blocks; they take precedence there when called. */
export const APP_FNS: Record<string, Fn> = Object.fromEntries([
  // ---- telemetry: how the firmware's lines become signals ----
  def(
    "csv",
    ["prefix", "columns", "sep"],
    (a) => {
      const prefix = a.str("prefix");
      const cols = parseColumns(a.str("columns"));
      if (!cols.length) a.ctx.error('csv(): columns names each value in order, like "ms mode x:µm y:µm"');
      const dup = cols.find((c, i) => cols.findIndex((d) => d.name === c.name) !== i);
      if (dup) a.ctx.error(`csv(): the column "${dup.name}" is named twice`);
      for (const c of cols) if (!/^[A-Za-z_µ][\w.µ]*$/.test(c.name)) a.ctx.error(`csv(): "${c.name}" is not a usable name: start with a letter, then letters, digits, _ or .`);
      const sep = a.str("sep", ",");
      if (sep !== "," && sep !== ";" && sep !== "\t" && sep !== " ") a.ctx.error('csv(): sep is ",", ";", " " or "\\t"');
      return wrap(FORMAT, { kind: "csv", prefix, columns: cols, sep } satisfies TelemetryFormat, `csv "${prefix}"`);
    },
    'csv("T", "ms mode x:µm y:µm") → lines like T,1234,2,-31,12: the first word, then the values in that order. A unit after a colon labels the column. prefix "" reads lines of bare numbers.',
  ),
  def(
    "keys",
    ["prefix", "spaced"],
    (a) => wrap(FORMAT, { kind: "keys", prefix: a.str("prefix", ""), spaced: a.bool("spaced") || undefined } satisfies TelemetryFormat, "key=value lines"),
    'keys() → lines like x=1.2 y=3.4 or speed: 12.5, rpm: 3000 (keys("D") only those that start with D; spaced: true also reads names and numbers with only a space between, "dist 120 mm  yaw 1.5").',
  ),
  def("json", ["prefix"], (a) => wrap(FORMAT, { kind: "json", prefix: a.str("prefix", "") } satisfies TelemetryFormat, "JSON lines"), 'json() → lines that are JSON objects, {"x": 1.2}; nested objects give names with dots.'),
  def(
    "derive",
    ["name", "expr", "unit", "label", "digits"],
    (a) => {
      const name = a.str("name");
      if (!/^[A-Za-z_µ][\w.µ]*$/.test(name)) a.ctx.error(`derive(): "${name}" is not a usable name: start with a letter, then letters, digits, _ or .`);
      return wrap(DERIVE, { name, expr: exprArg(a, "expr"), unit: optStr(a, "unit"), label: optStr(a, "label"), digits: optNum(a, "digits") } satisfies DeriveDef, `value ${name}`);
    },
    'derive("air", "speed / 100", unit: "m/s") → a signal worked out from others, usable by name in any panel.',
  ),
  // ---- one signal with how to show it ----
  def(
    "signal",
    ["expr", "label", "unit", "digits", "color", "max", "min", "warn", "alarm"],
    (a) =>
      wrap(
        SIGNAL,
        {
          expr: exprArg(a, "expr"),
          label: optStr(a, "label"),
          unit: optStr(a, "unit"),
          digits: optNum(a, "digits"),
          color: color(a, "color"),
          max: optNum(a, "max"),
          min: optNum(a, "min"),
          warn: optExpr(a, "warn"),
          alarm: optExpr(a, "alarm"),
        } satisfies SignalItem,
        "signal",
      ),
    'signal("drag / 100", label: "drag", unit: "mN", digits: 2, max: 25, warn: "drag > 2000") → a value with its label, unit, bar and warning colours.',
  ),
  // ---- panels ----
  def(
    "readout",
    ["title", "signals", "big", ...SIZE],
    (a) => panel("readout", a, { signals: signalList(a, "signals"), big: a.bool("big") }),
    'readout("Wind", ["air", "drag"], big: true) → live numbers.',
  ),
  def(
    "gauge",
    ["title", "signal", "min", "max", "zones", ...SIZE],
    (a) => {
      const signal = toSignal(a.value("signal") ?? a.ctx.error("gauge() needs a signal"), a, "signal");
      const min = a.num("min", 0);
      const max = a.num("max", signal.max ?? 100);
      if (!(max > min)) a.ctx.error("gauge(): max must be more than min");
      const zv = a.value("zones");
      const zones = (zv === undefined ? [] : Array.isArray(zv) ? zv : [zv]).map((z, i) => unwrap<{ from: number; to: number; color: string }>(z, ZONE) ?? a.ctx.error(`gauge(): zone ${i + 1} should be zone(from, to, "red")`));
      return panel("gauge", a, { signal, min, max, zones });
    },
    'gauge("Fan", "rpm", max: 6000, zones: [zone(5000, 6000, "red")]) → a dial.',
  ),
  def(
    "zone",
    ["from", "to", "color"],
    (a) => wrap(ZONE, { from: a.num("from"), to: a.num("to"), color: color(a, "color") ?? "amber" }, "zone"),
    'zone(80, 100, "red") → a coloured band on a gauge.',
  ),
  def(
    "chart",
    ["title", "signals", "window", "min", "max", "unit", ...SIZE],
    (a) => {
      const window = a.num("window", 0);
      if (window < 0 || window > 3600) a.ctx.error("chart(): window is how many seconds it shows, up to 3600");
      return panel("chart", a, { signals: signalList(a, "signals"), window, min: optNum(a, "min"), max: optNum(a, "max"), unit: optStr(a, "unit") });
    },
    'chart("Position", ["x", "y", "z"], window: 30s, unit: "µm") → values over time, scrolling.',
  ),
  def(
    "scope",
    ["title", "x", "y", "range", "trail", "unit", ...SIZE],
    (a) => {
      const range = optNum(a, "range");
      if (range !== undefined && !(range > 0)) a.ctx.error("scope(): range is the half-width shown, above 0");
      return panel("scope", a, { x: toSignal(a.value("x") ?? a.ctx.error("scope() needs x"), a, "x"), y: toSignal(a.value("y") ?? a.ctx.error("scope() needs y"), a, "y"), range, trail: a.num("trail", 3), unit: optStr(a, "unit") });
    },
    'scope("Top view", "x", "y", range: 500, trail: 3s, unit: "µm") → one value against another with a fading trail.',
  ),
  def(
    "bars",
    ["title", "signals", "min", "max", "unit", ...SIZE],
    (a) => panel("bars", a, { signals: signalList(a, "signals"), min: optNum(a, "min"), max: optNum(a, "max"), unit: optStr(a, "unit") }),
    'bars("Coil currents", ["iLift", "i1", "i2"], min: -2000, max: 2000, unit: "mA") → values side by side as bars.',
  ),
  def(
    "lamp",
    ["label", "when", "color", "off"],
    (a) => wrap(LAMP, { label: a.str("label"), when: exprArg(a, "when"), color: color(a, "color"), off: optStr(a, "off") } satisfies LampDef, "lamp"),
    `lamp("Floating", "mode == 2", color: "green", off: "landed") → a light that is on while the condition is true.`,
  ),
  def(
    "lamps",
    ["title", "lamps", ...SIZE],
    (a) => {
      const v = a.value("lamps");
      const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
      if (!list.length) a.ctx.error('lamps() needs lamps: [lamp("Floating", "mode == 2"), ...]');
      return panel("lamps", a, { lamps: list.map((l, i) => unwrap<LampDef>(l, LAMP) ?? a.ctx.error(`lamps(): item ${i + 1} should be lamp("label", "condition")`)) });
    },
    'lamps("Status", [lamp("Floating", "mode == 2"), lamp("Fault", "fault != \'\'", color: "red")]) → status lights.',
  ),
  def("state", ["title", ...SIZE], (a) => panel("state", a, {}), 'state() → what the firmware says it is doing (its "state: ..." lines), its faults and recent events.'),
  def(
    "controls",
    ["title", "controls", ...SIZE],
    (a) => {
      const v = a.value("controls");
      const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
      if (!list.length) a.ctx.error('controls() needs controls: [button("Start", "start"), ...]');
      return panel("controls", a, { controls: list.map((c, i) => unwrap<ControlSpec>(c, CONTROL) ?? a.ctx.error(`controls(): item ${i + 1} should be button(), slider(), toggle(), field() or choice()`)) });
    },
    'controls("Run", [button("Start", "start"), slider("Speed", "speed {}", max: 100)]) → buttons, sliders, switches and fields that send commands.',
  ),
  def(
    "button",
    ["label", "send", "confirm", "tone", "key"],
    (a) => {
      const tone = a.oneOf("tone", ["plain", "accent", "danger"] as const, "plain");
      return wrap(CONTROL, { kind: "button", label: a.str("label"), send: a.str("send"), confirm: optStr(a, "confirm"), tone, key: controlKey(a) } satisfies ControlSpec, "button");
    },
    'button("Launch", "launch", tone: "accent", key: "l", confirm: "Is the model on its pad?") → sends a command when pressed.',
  ),
  def(
    "slider",
    ["label", "send", "min", "max", "step", "value", "unit", "live", "key"],
    (a) => {
      const min = a.num("min", 0);
      const max = a.num("max", 100);
      if (!(max > min)) a.ctx.error("slider(): max must be more than min");
      const step = a.num("step", (max - min) / 100 >= 1 ? 1 : Number(((max - min) / 100).toPrecision(1)));
      if (!(step > 0)) a.ctx.error("slider(): step must be above 0");
      const value = a.num("value", min);
      return wrap(CONTROL, { kind: "slider", label: a.str("label"), send: a.str("send"), min, max, step, value, unit: optStr(a, "unit"), live: a.bool("live"), key: controlKey(a) } satisfies ControlSpec, "slider");
    },
    'slider("Fan", "fan {}", min: 0, max: 100, unit: "%") → sends the value in place of {} when let go (live: true sends while it moves).',
  ),
  def(
    "toggle",
    ["label", "on", "off", "state", "key"],
    (a) => wrap(CONTROL, { kind: "toggle", label: a.str("label"), on: a.str("on"), off: a.str("off"), state: optExpr(a, "state"), key: controlKey(a) } satisfies ControlSpec, "toggle"),
    'toggle("Data stream", "log on", "log off", state: "rate > 0") → a switch: one command on, another off; state: shows what the machine reports.',
  ),
  def(
    "field",
    ["label", "send", "placeholder", "key"],
    (a) => wrap(CONTROL, { kind: "field", label: a.str("label"), send: a.str("send"), placeholder: optStr(a, "placeholder"), key: controlKey(a) } satisfies ControlSpec, "field"),
    'field("Go to", "go {}", placeholder: "x y z") → a text box that sends what is typed in place of {}.',
  ),
  def(
    "choice",
    ["label", "options", "send", "key"],
    (a) => {
      const options = strList(a, "options");
      if (options.length < 2) a.ctx.error('choice() needs options: at least two, like ["slow", "fast"]');
      return wrap(CONTROL, { kind: "choice", label: a.str("label"), options, send: a.str("send"), key: controlKey(a) } satisfies ControlSpec, "choice");
    },
    'choice("Mode", ["hold", "orbit", "sweep"], "mode {}") → buttons for one of a few options.',
  ),
  def("console", ["title", "commands", ...SIZE], (a) => panel("console", a, { commands: strList(a, "commands") }), 'console(commands: ["launch", "land"]) → the serial console, with a line to type commands.'),
  def(
    "log",
    ["title", "match", ...SIZE],
    (a) => {
      const match = optStr(a, "match");
      if (match) {
        try {
          new RegExp(match, "i");
        } catch {
          a.ctx.error(`log(): match "${match}" is not a valid pattern`);
        }
      }
      return panel("log", a, { match });
    },
    'log("Sweep points", match: "^S,") → the lines that match a pattern (any line without one).',
  ),
  def("table", ["title", "signals", ...SIZE], (a) => panel("table", a, { signals: signalList(a, "signals") }), 'table("Coils", ["iLift", "i1", "i2"]) → values with lowest, highest and average.'),
  def("note", ["title", "text", ...SIZE], (a) => panel("note", a, { text: a.str("text") }), 'note("First run", "Put the model on its pad, then Launch.") → text for whoever uses the app.'),
  def(
    "custom",
    ["title", "code", "uses", ...SIZE],
    (a) => {
      const code = a.str("code");
      if (code.length > 60_000) a.ctx.error("custom(): code is over 60,000 characters");
      if (!/\bfunction\s+draw\s*\(|\bdraw\s*=/.test(code)) a.ctx.error("custom(): code needs a function draw(g) { ... }: it is called every frame with g.ctx, g.w, g.h, g.v(name), g.history(name, seconds) and g.send(command)");
      return panel("custom", a, { code, uses: strList(a, "uses") });
    },
    'custom("Flow", code: """function draw(g) { ... }""", uses: ["x", "z"]) → your own drawing on a canvas, run walled off from the rest of Kerf.',
  ),
  def(
    "model",
    ["title", "parts", "moves", "view", ...SIZE],
    (a) => {
      const pv = a.value("parts");
      const parts = (pv === undefined ? [] : Array.isArray(pv) ? pv : [pv]).map((p) => partName(p, a));
      const mv = a.value("moves");
      const moves = (mv === undefined ? [] : Array.isArray(mv) ? mv : [mv]).map((m, i) => unwrap<ModelMove>(m, MOVE) ?? a.ctx.error(`model(): move ${i + 1} should be slide(), turn() or spin()`));
      const view = a.oneOf("view", ["iso", "front", "side", "top"] as const, "iso");
      return panel("model", a, { parts, moves, view });
    },
    'model("Live", moves: [slide(ball, Z, "z / 1000"), spin(rotor, Z, "rpm")]) → the design in 3D, parts moved by live values (parts: [...] shows only those).',
  ),
  def("slide", ["part", "axis", "expr"], (a) => wrap(MOVE, { part: partName(a.value("part"), a), kind: "slide", axis: a.dir("axis"), expr: exprArg(a, "expr") } satisfies ModelMove, "slide"), 'slide(ball, Z, "z / 1000") → moves a part along a direction, mm.'),
  def(
    "turn",
    ["part", "axis", "expr", "about"],
    (a) => wrap(MOVE, { part: partName(a.value("part"), a), kind: "turn", axis: a.dir("axis"), about: a.has("about") ? a.vec3("about") : undefined, expr: exprArg(a, "expr") } satisfies ModelMove, "turn"),
    'turn(arm, Y, "shoulder", about: (0, 0, 40)) → turns a part about an axis through a point, degrees.',
  ),
  def(
    "spin",
    ["part", "axis", "expr", "about"],
    (a) => wrap(MOVE, { part: partName(a.value("part"), a), kind: "spin", axis: a.dir("axis"), about: a.has("about") ? a.vec3("about") : undefined, expr: exprArg(a, "expr") } satisfies ModelMove, "spin"),
    'spin(rotor, Z, "rpm") → keeps a part turning at a speed, rpm.',
  ),
  def("camera", ["title", "overlay", ...SIZE], (a) => panel("camera", a, { overlay: a.has("overlay") ? signalList(a, "overlay") : [] }), 'camera("Bench", overlay: ["air", "drag"]) → a USB camera\'s picture with live values over it.'),
]);

function partName(v: Value | undefined, a: Args): string {
  if (typeof v === "string") return v;
  if (v instanceof Obj && v.kind === "component" && typeof v.fields.name === "string") return v.fields.name;
  if (v && typeof v === "object" && "name" in v && typeof (v as { name: unknown }).name === "string") return (v as { name: string }).name;
  return a.ctx.error(`${a.fname}(): give a part or component, or its name in quotes`);
}

export interface AppItem {
  name: string;
  value: Value;
  span: Span;
}

export interface AppEnv {
  fail: (msg: string, span: Span) => never;
  /** the source spans of the panels: list's items, when it is written as a list */
  panelSpans?: Span[];
}

/** Turn an app block's properties into its spec. */
export function buildApp(label: string, props: AppItem[], flags: AppItem[], span: Span, labelSpan: Span, env: AppEnv): AppSpec {
  const fail = env.fail;
  for (const p of props) if (!APP_PROPS.includes(p.name)) fail(`Unknown app property "${p.name}". Use ${APP_PROPS.join(", ")}.`, p.span);
  for (const f of flags) if (!FLAGS.includes(f.name)) fail(`Unknown flag "${f.name}" in an app`, f.span);
  const one = (name: string) => {
    const all = props.filter((p) => p.name === name);
    if (all.length > 1) fail(`"${name}:" is given twice`, all[1].span);
    return all[0];
  };
  const list = (name: string): { v: Value[]; span: Span } => {
    const p = one(name);
    if (!p) return { v: [], span };
    return { v: Array.isArray(p.value) ? p.value : [p.value], span: p.span };
  };
  const num = (name: string, def: number, lo: number, hi: number): number => {
    const p = one(name);
    if (!p) return def;
    const v = p.value;
    if (typeof v !== "number" || !Number.isFinite(v)) return fail(`${name}: should be a number, got ${typeName(v)}`, p.span);
    if (v < lo || v > hi) fail(`${name}: should be ${lo} to ${hi}`, p.span);
    return v;
  };
  const text = (name: string): string | undefined => {
    const p = one(name);
    if (!p) return undefined;
    const v = p.value;
    if (typeof v !== "string") return fail(`${name}: should be text in quotes, got ${typeName(v)}`, p.span);
    return v;
  };

  // the twin: a scenario's world, or none; checked once every scenario is known (finishApps)
  let twin: string | null | undefined;
  const tw = one("twin");
  if (tw) {
    if (tw.value === null || tw.value === false || tw.value === "none") twin = null;
    else if (typeof tw.value !== "string") fail('twin: names the scenario whose world the simulated twin runs, in quotes, or "none"', tw.span);
    else twin = tw.value;
  }
  const firmware = text("firmware");

  const tele = list("telemetry");
  const telemetry = tele.v.map((v) => unwrap<TelemetryFormat>(v, FORMAT) ?? fail('telemetry: is a list of csv("T", "…"), keys() or json()', tele.span));
  const der = list("derive");
  const derive = der.v.map((v) => unwrap<DeriveDef>(v, DERIVE) ?? fail('derive: is a list of derive("name", "expression")', der.span));
  const dupD = derive.find((d, i) => derive.findIndex((e) => e.name === d.name) !== i);
  if (dupD) fail(`derive: "${dupD.name}" is worked out twice`, der.span);
  const helloP = one("hello");
  const hello = !helloP ? [] : (Array.isArray(helloP.value) ? helloP.value : [helloP.value]).map((v) => (typeof v === "string" ? v : fail("hello: is a command in quotes, or a list of them, sent when the app connects", helloP.span)));
  const cmd = list("commands");
  const commands = cmd.v.map((v) => (typeof v === "string" ? v : fail("commands: is a list of commands in quotes, for the console to suggest", cmd.span)));

  const pan = list("panels");
  if (!one("panels")) fail(`app "${label}" needs panels: [ ... ]: readout(), chart(), controls(), console() and the rest`, labelSpan);
  if (pan.v.length > 60) fail(`panels: ${pan.v.length} panels is too many for one app (60 at most): make a second app`, pan.span);
  const spans = env.panelSpans && env.panelSpans.length === pan.v.length ? env.panelSpans : undefined;
  const panels = pan.v.map((v, i) => {
    const p = unwrap<PanelSpec>(v, PANEL);
    if (!p) return fail(`panels: item ${i + 1} is ${typeName(v)}, not a panel: use readout(), gauge(), chart(), scope(), bars(), lamps(), state(), controls(), console(), log(), table(), note(), model(), camera() or custom()`, spans?.[i] ?? pan.span);
    return spans ? { ...p, span: { start: spans[i].start, end: spans[i].end } } : { ...p };
  });
  const accent = text("accent");
  if (accent !== undefined && !COLORS.test(accent)) fail("accent: is a colour, #rrggbb", one("accent")!.span);
  return {
    name: label,
    twin: twin as string | null,
    twinGiven: twin !== undefined,
    twinSpan: tw ? { start: tw.span.start, end: tw.span.end } : undefined,
    firmware,
    firmwareSpan: firmware !== undefined ? { start: one("firmware")!.span.start, end: one("firmware")!.span.end } : undefined,
    baud: num("baud", 115200, 300, 4_000_000),
    telemetry,
    derive,
    hello,
    commands,
    columns: num("columns", 6, 1, 12),
    window: num("window", 30, 1, 3600),
    accent,
    about: text("about"),
    panels,
    span: { start: span.start, end: span.end },
    labelSpan: { start: labelSpan.start, end: labelSpan.end },
  };
}

/**
 * Settle what an app names elsewhere in the design, once the whole file is
 * read (an app may come before the scenarios it uses): the twin defaults to
 * the first scenario that runs the firmware.
 */
export function finishApps(apps: AppSpec[], scenarios: { label: string; firmware?: string; printer?: boolean }[], firmware: string[]): { message: string; span: { start: number; end: number }; severity: "error" | "warning" }[] {
  const out: { message: string; span: { start: number; end: number }; severity: "error" | "warning" }[] = [];
  const names = scenarios.map((s) => s.label);
  for (const app of apps) {
    if (app.firmware !== undefined && !firmware.includes(app.firmware)) out.push({ message: `In app "${app.name}": there is no firmware block "${app.firmware}"${firmware.length ? `. Firmware: ${firmware.join(", ")}` : ""}`, span: app.firmwareSpan ?? app.labelSpan, severity: "error" });
    if (!app.twinGiven) {
      const usable = scenarios.filter((s) => !s.printer && (!app.firmware || !s.firmware || s.firmware === app.firmware));
      app.twin = usable[0]?.label ?? null;
      continue;
    }
    if (app.twin !== null && !names.includes(app.twin)) {
      out.push({ message: `In app "${app.name}": twin: there is no scenario "${app.twin}"${names.length ? `. Scenarios: ${names.map((s) => `"${s}"`).join(", ")}` : ". Add a scenario for the machine first, or write twin: \"none\""}`, span: app.twinSpan ?? app.labelSpan, severity: "error" });
      app.twin = null;
    }
  }
  return out;
}
