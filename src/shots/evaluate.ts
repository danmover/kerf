// Evaluating `shot <name> { ... }` blocks into ShotSpecs. A mistake in one
// line of a shot is reported on that line and the shot keeps the default for
// it, so the shot list never loses a shot to a typo. Part names are read as
// written (they may be defined further down the file) and checked once the
// whole design is known: a name that isn't there is a flag on the shot.

import type { Expr, Item, Span, Stmt } from "../lang/ast";
import type { Model } from "../core/model";
import { Args } from "../lang/args";
import { Obj, Ref, Vec, fmtNum, typeName, type CallCtx, type Value } from "../lang/values";
import type { V3 } from "../kernel/recipe";
import {
  ASPECTS,
  APERTURE_RANGE,
  BACKDROPS,
  FILL_RANGE,
  LENS_RANGE,
  LIGHTINGS,
  MOTIONS,
  PROP_IDS,
  SHOT_CALLS,
  SHOT_KINDS,
  SHOT_PROPS,
  SURFACES,
  defaultShot,
  type ShotAspect,
  type ShotKind,
  type ShotSpec,
} from "./spec";

/** What the shot evaluator needs from the design evaluator. */
export interface ShotHost {
  expr(e: Expr, scope: unknown): Value;
  scope(parent?: unknown): unknown;
  setVar(scope: unknown, name: string, v: Value): void;
  /** report a warning */
  warn(msg: string, span: Span): void;
  /** a call context whose errors point at span */
  ctx(span: Span): CallCtx;
}

class LineError extends Error {
  constructor(
    msg: string,
    public span: Span,
  ) {
    super(msg);
  }
}

const quoted = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");

/** Names written as identifiers or strings, read without evaluating (parts may come later in the file). */
function namesOf(e: Expr, host: ShotHost, scope: unknown): string[] {
  if (e.k === "ident") return [e.name];
  if (e.k === "str") return [e.v];
  if (e.k === "list") return e.items.flatMap((i) => namesOf(i, host, scope));
  const v = host.expr(e, scope);
  const one = (x: Value): string => {
    if (typeof x === "string") return x;
    if (x instanceof Ref) return x.name;
    if (x instanceof Obj && (x.kind === "component" || x.kind === "part")) return String(x.fields.name);
    throw new LineError(`expected part or component names, e.g. [lid, base], got ${typeName(x)}`, e.span);
  };
  return Array.isArray(v) ? v.map(one) : [one(v)];
}

export function evalShot(s: Extract<Stmt, { k: "shot" }>, host: ShotHost): ShotSpec {
  // the kind sets the defaults, wherever it is written in the block
  let kind: ShotKind = "angle";
  const kindItem = s.items.find((i): i is Extract<Item, { k: "prop" }> => i.k === "prop" && i.name === "kind");
  if (kindItem) {
    try {
      const v = host.expr(kindItem.value, null);
      const k = typeof v === "string" ? v.toLowerCase().replace(/[\s-]+/g, "_") : "";
      if ((SHOT_KINDS as readonly string[]).includes(k)) kind = k as ShotKind;
      else host.warn(`kind should be one of ${quoted(SHOT_KINDS)}`, kindItem.span);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      host.warn(e.message, kindItem.span);
    }
  }
  const spec = defaultShot(s.name, kind, s.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
  spec.span = s.span;
  spec.locked = s.items.some((i) => i.k === "flag" && i.name === "locked");
  const set = new Set<string>();
  if (kindItem) set.add("kind");

  const num = (v: Value, span: Span, what: string, min: number, max: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new LineError(`${what} should be a number, got ${typeName(v)}`, span);
    if (v < min - 1e-9 || v > max + 1e-9) throw new LineError(`${what} should be between ${fmtNum(min)} and ${fmtNum(max)} (got ${fmtNum(v)})`, span);
    return v;
  };
  const str = (v: Value, span: Span, what: string): string => {
    if (typeof v === "string") return v;
    throw new LineError(`${what} should be text in quotes, got ${typeName(v)}`, span);
  };
  const word = <T extends string>(v: Value, span: Span, what: string, options: readonly T[]): T => {
    const t = typeof v === "string" ? v.toLowerCase().replace(/[\s-]+/g, "_") : "";
    if ((options as readonly string[]).includes(t)) return t as T;
    throw new LineError(`${what} should be one of ${quoted(options)}`, span);
  };
  const vec = (v: Value, span: Span, what: string, n: 2 | 3): number[] => {
    if (v instanceof Vec && (v.v.length === n || (n === 3 && v.v.length === 2))) return n === 3 ? [v.v[0], v.v[1], v.v[2] ?? 0] : [v.v[0], v.v[1]];
    throw new LineError(`${what} should be ${n === 2 ? "a pair like (35deg, 20deg)" : "a point like (0, 0, 10)"}, got ${typeName(v)}`, span);
  };
  const axis = (v: Value, span: Span): "x" | "y" | "z" => {
    if (typeof v === "string" && /^[xyz]$/i.test(v)) return v.toLowerCase() as "x" | "y" | "z";
    if (v instanceof Vec) {
      const a = v.v.map(Math.abs);
      const i = a.indexOf(Math.max(...a));
      if (a[i] > 0 && a.filter((x) => x > 1e-9).length === 1) return (["x", "y", "z"] as const)[i];
    }
    throw new LineError('section should cut across an axis: "x", "y" or "z" (or X, Y, Z)', span);
  };

  const prop = (it: Extract<Item, { k: "prop" }>, scope: unknown) => {
    const name = it.name;
    if (!(SHOT_PROPS as readonly string[]).includes(name) && name !== "section") throw new LineError(`Unknown shot property "${name}". Use: ${SHOT_PROPS.join(", ")}`, it.span);
    if (name === "kind") return;
    set.add(name);
    switch (name) {
      case "frame":
        spec.frame = namesOf(it.value, host, scope);
        return;
      case "hide":
        spec.hide = namesOf(it.value, host, scope);
        return;
      case "ghost":
        spec.ghost = namesOf(it.value, host, scope);
        return;
      case "focus": {
        if (it.value.k === "ident" || it.value.k === "str") {
          spec.focus = namesOf(it.value, host, scope)[0];
          return;
        }
        const v = host.expr(it.value, scope);
        if (v instanceof Vec) spec.focus = vec(v, it.span, "focus", 3) as V3;
        else spec.focus = namesOf(it.value, host, scope)[0];
        return;
      }
    }
    const v = host.expr(it.value, scope);
    switch (name) {
      case "title":
        spec.title = str(v, it.span, "title");
        return;
      case "angle": {
        const [t, h] = vec(v, it.span, "angle", 2);
        spec.angle = [t, num(h, it.span, "the angle's height", -89, 89)];
        return;
      }
      case "lens":
        spec.lens = num(v, it.span, "lens (mm)", LENS_RANGE[0], LENS_RANGE[1]);
        return;
      case "aperture":
        if (v === false || (typeof v === "string" && /^(sharp|all|none|off)$/i.test(v))) spec.aperture = null;
        else spec.aperture = num(v, it.span, "aperture (f-number)", APERTURE_RANGE[0], APERTURE_RANGE[1]);
        return;
      case "fill":
        spec.fill = num(v, it.span, "fill", FILL_RANGE[0], FILL_RANGE[1]);
        return;
      case "offset": {
        const [x, y] = vec(v, it.span, "offset", 2);
        spec.offset = [num(x, it.span, "offset across", -0.45, 0.45), num(y, it.span, "offset up", -0.45, 0.45)];
        return;
      }
      case "roll":
        spec.roll = num(v, it.span, "roll", -180, 180);
        return;
      case "aspect": {
        const t = typeof v === "string" ? v.replace(/\s/g, "").replace(/x/i, ":") : "";
        if (!(ASPECTS as readonly string[]).includes(t)) throw new LineError(`aspect should be one of ${quoted(ASPECTS)}`, it.span);
        spec.aspect = t as ShotAspect;
        return;
      }
      case "lighting":
        spec.lighting = word(v, it.span, "lighting", LIGHTINGS);
        return;
      case "light_angle":
        spec.lightAngle = ((num(v, it.span, "light_angle", -720, 720) % 360) + 360) % 360;
        return;
      case "backdrop":
        spec.backdrop = word(v, it.span, "backdrop", BACKDROPS);
        return;
      case "color": {
        const t = str(v, it.span, "color");
        if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t)) throw new LineError("color should be a colour such as #20232a", it.span);
        spec.color = t;
        return;
      }
      case "surface":
        spec.surface = word(v, it.span, "surface", SURFACES);
        return;
      case "explode":
        spec.explode = num(v, it.span, "explode", 0, 1.5);
        return;
      case "section":
        if (v === false) spec.section = null;
        else spec.section = { axis: axis(v, it.span), at: null };
        return;
      case "props": {
        const list = Array.isArray(v) ? v : [v];
        spec.props = list.map((x) => word(x, it.span, "each prop", PROP_IDS));
        return;
      }
      case "motion":
        spec.motion = word(v, it.span, "motion", MOTIONS);
        return;
      case "duration":
        spec.duration = num(v, it.span, "duration (seconds)", 1, 60);
        return;
      case "note":
        spec.note = str(v, it.span, "note");
        return;
    }
  };

  const call = (it: Extract<Item, { k: "modifier" }>, scope: unknown) => {
    const callee = it.call.callee;
    const fname = callee.k === "ident" ? callee.name : "";
    if (!(fname in SHOT_CALLS)) throw new LineError(`Shots accept ${Object.keys(SHOT_CALLS).map((k) => k + "()").join(" and ")} besides properties`, it.span);
    const pos: Value[] = [];
    const named: Record<string, Value> = {};
    let target: string | V3 | undefined;
    it.call.args.forEach((arg, i) => {
      // a callout's target is a part name as written, or a point
      if (fname === "callout" && (arg.name === "target" || (!arg.name && i === 0))) {
        if (arg.value.k === "ident" || arg.value.k === "str") {
          target = namesOf(arg.value, host, scope)[0];
          return;
        }
        const v = host.expr(arg.value, scope);
        if (v instanceof Vec) target = vec(v, arg.span, "the callout's point", 3) as V3;
        else target = namesOf(arg.value, host, scope)[0];
        return;
      }
      const v = host.expr(arg.value, scope);
      if (arg.name) named[arg.name] = v;
      else pos.push(v);
    });
    const a = new Args(fname, fname === "callout" ? [null as unknown as Value, ...pos] : pos, named, host.ctx(it.call.span), SHOT_CALLS[fname]);
    if (fname === "callout") {
      if (target === undefined) throw new LineError('callout() needs a part or a point, then the text: callout(lid, "Tool-free lid")', it.span);
      const text = a.str("text");
      if (!text.trim()) throw new LineError("callout() needs some text", it.span);
      if (spec.callouts.length >= 12) throw new LineError("A shot is limited to 12 callouts", it.span);
      spec.callouts.push({ target, text, span: it.call.span });
      set.add("callout");
    } else {
      const ax = a.value("axis");
      spec.section = { axis: axis(ax ?? "x", it.span), at: a.has("at") ? a.num("at") : null };
      set.add("section");
    }
  };

  const walk = (items: Item[], scope: unknown, depth: number) => {
    if (depth > 20) throw new LineError("Blocks are nested too deeply", items[0]?.span ?? s.span);
    for (const it of items) {
      try {
        switch (it.k) {
          case "prop":
            prop(it, scope);
            break;
          case "flag":
            if (it.name !== "locked") throw new LineError(`Unknown flag "${it.name}". Shots accept the flag locked.`, it.span);
            break;
          case "let":
            host.setVar(scope, it.name, host.expr(it.value, scope));
            break;
          case "if": {
            const c = host.expr(it.cond, scope);
            const truthy = typeof c === "boolean" ? c : typeof c === "number" ? c !== 0 : !!c;
            if (truthy) walk(it.then, host.scope(scope), depth + 1);
            else if (it.else) walk(it.else, host.scope(scope), depth + 1);
            break;
          }
          case "for": {
            const iter = host.expr(it.iter, scope);
            const list = Array.isArray(iter) ? iter : iter instanceof Vec ? iter.v : null;
            if (!list) throw new LineError(`for ... in needs a list, got ${typeName(iter)}`, it.iter.span);
            for (const v of list) {
              const inner = host.scope(scope);
              host.setVar(inner, it.varName, v);
              walk(it.body, inner, depth + 1);
            }
            break;
          }
          case "modifier":
            call(it, scope);
            break;
          default:
            throw new LineError("Shots do not take shapes. Use properties such as angle:, lens: and lighting:, and callout() or section().", it.span);
        }
      } catch (e) {
        if (e instanceof LineError) {
          host.warn(e.message, e.span);
          spec.problems.push(e.message);
        } else if (e instanceof Error && "span" in e) {
          // an evaluation error inside an expression: report it on its line and carry on
          const span = (e as unknown as { span: Span }).span;
          host.warn(e.message, span);
          spec.problems.push(e.message);
        } else throw e;
      }
    }
  };
  walk(s.items, host.scope(), 0);
  spec.set = [...set];
  return spec;
}

/**
 * Check every shot's part names against the finished model. Unknown names are
 * dropped from the shot and flagged, so the shot still renders.
 */
export function finishShots(model: Model, warn: (msg: string, span: Span) => void) {
  const known = (n: string) => model.parts.some((p) => p.name === n || p.id === n || p.group === n);
  for (const shot of model.shots) {
    const span = shot.span ?? { start: 0, end: 0 };
    const check = (list: string[], what: string): string[] =>
      list.filter((n) => {
        if (known(n)) return true;
        const msg = `${what} names "${n}", which is not a part or component of this design`;
        shot.problems.push(msg);
        warn(`In shot "${shot.name}": ${msg}`, span);
        return false;
      });
    shot.frame = check(shot.frame, "frame");
    shot.hide = check(shot.hide, "hide");
    shot.ghost = check(shot.ghost, "ghost");
    if (typeof shot.focus === "string" && !known(shot.focus)) {
      shot.problems.push(`focus names "${shot.focus}", which is not a part or component of this design`);
      warn(`In shot "${shot.name}": focus names "${shot.focus}", which is not a part or component`, span);
      shot.focus = null;
    }
    shot.callouts = shot.callouts.filter((c) => {
      if (typeof c.target !== "string" || known(c.target)) return true;
      const msg = `a callout points at "${c.target}", which is not a part or component`;
      shot.problems.push(msg);
      warn(`In shot "${shot.name}": ${msg}`, c.span ?? span);
      return false;
    });
    const shown = model.parts.filter((p) => !p.hidden && !shot.hide.some((n) => p.name === n || p.id === n || p.group === n));
    if (model.parts.length && !shown.length) shot.problems.push("Every part is hidden, so there is nothing to photograph");
  }
}

/** The parts of a model a shot names (by part name, instance id or group). */
export function partsNamed(model: Model, names: string[]): string[] {
  if (!names.length) return [];
  return model.parts.filter((p) => names.some((n) => p.name === n || p.id === n || p.group === n)).map((p) => p.id);
}
