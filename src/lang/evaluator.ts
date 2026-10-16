// Evaluates a parsed Kerf program into a Model: parameters, placed parts and
// components with geometry recipes, requirement results and a dependency graph.

import type { Expr, Item, Program, Span, Stmt } from "./ast";
import { parse, type Diagnostic } from "./parser";
import { Fn, Obj, Pending, Ref, ShapeV, Vec, fmtNum, geoKey, show, typeName, type CallCtx, type GeoQuery, type Value } from "./values";
import { CONSTANTS, LibFn, MATH_FNS, MODIFIER_PARAMS, SHAPE_FNS, edgeSel, geoFns, libNamespace, threadConstants } from "./builtins";
import { Args, toThread, toV3 } from "./args";
import { LIBRARY, type CompDef, type LibArgs } from "../library/components";
import { frameFor, recipeHash, rotateAbout, vdot, vnorm, vsub, vcross, type PartOp, type PartRecipe, type ShapeRecipe, type V2, type V3, type Xform, applyXforms, applyXformsToDir } from "../kernel/recipe";
import { meshPhase } from "../library/gears";
import type { DepNode, EvalParam, EvalPart, EvalRequirement, GearInfo, Model, Motion } from "../core/model";
import { DRAWING_CALLS, DRAWING_PROPS, SHEET_NAMES, VIEW_KINDS, defaultSpec, parseScale, type DrawingSpec, type SheetSize, type ViewKind } from "../drawing/spec";

export interface EvalOptions {
  /** param name -> replacement number (used by the feasibility solver) */
  overrides?: Record<string, number>;
  /** skip part geometry (fast path for requirement-only evaluation) */
  skipGeometry?: boolean;
  /** resolved geometric quantities, keyed by geoKey() */
  geo?: Record<string, number>;
  /** reuse an existing parse */
  parsed?: { program: Program; diagnostics: Diagnostic[] };
}

class EvalError extends Error {
  constructor(
    message: string,
    public span: Span,
  ) {
    super(message);
  }
}

const POSITIONAL: Record<string, string[]> = {
  bearing: ["code"],
  screw: ["size", "length"],
  nut: ["size"],
  insert: ["size"],
  spur_gear: ["m", "z", "width", "bore"],
  nema17: ["length"],
  pcb: ["w", "d", "t"],
  usb_c: [],
  connector: ["w", "h", "d"],
  dowel: ["d", "length"],
};
const LIB_ARGS: Record<string, string[]> = {
  bearing: ["code"],
  screw: ["size", "length"],
  nut: ["size"],
  insert: ["size"],
  spur_gear: ["m", "z", "width", "bore", "hub_d", "hub_l", "pa", "backlash"],
  nema17: ["length"],
  pcb: ["w", "d", "t", "hole_inset", "hole_d", "holes"],
  usb_c: ["opening_w", "opening_h"],
  connector: ["w", "h", "d", "opening_w", "opening_h"],
  dowel: ["d", "length"],
};

const PART_PROPS = ["color", "material", "group", "at", "rotate", "turns_with", "spin", "axis", "axis_at", "label"];
const COMP_PROPS = ["at", "axis", "facing", "rotate", "spin", "mesh", "turns_with", "color", "group", "material", "label"];

const DEFAULT_COLORS = ["#5b8cff", "#7f6cf2", "#3fb6a8", "#e0a84e", "#d9706a", "#8aa2b8", "#9ac46a"];

interface CompInfo {
  def: CompDef;
  at: V3;
  axis: V3;
  xf: Xform[];
  motion?: Motion;
  gear?: GearInfo;
  value: Obj;
}

class Scope {
  vars = new Map<string, Value>();
  constructor(public parent?: Scope) {}
  get(name: string): Value | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.get(name);
  }
}

export function evaluate(src: string, opts: EvalOptions = {}): Model {
  const t0 = performance.now();
  const parsed = opts.parsed ?? parse(src);
  const ev = new Evaluator(src, opts);
  ev.run(parsed.program);
  const model = ev.toModel(parsed.diagnostics);
  model.evalMs = performance.now() - t0;
  return model;
}

class Evaluator {
  builtins = new Map<string, Value>();
  globals = new Map<string, Value>();
  defKind = new Map<string, DepNode["kind"]>();
  defLabel = new Map<string, string>();
  deps = new Map<string, Set<string>>();
  current: Set<string> | null = null;
  comps = new Map<string, CompInfo>();
  partMotion = new Map<string, Motion>();
  parts: EvalPart[] = [];
  params: EvalParam[] = [];
  reqs: EvalRequirement[] = [];
  diags: Diagnostic[] = [];
  blocks: Model["blocks"] = [];
  name = "Untitled design";
  notes: string[] = [];
  geoQueries: GeoQuery[] = [];
  drawings: DrawingSpec[] = [];
  callSpan: Span = { start: 0, end: 0 };
  colorIdx = 0;
  stmtGeo: GeoQuery[] = [];
  /** guards against runaway loops in source written by people or the AI */
  steps = 0;

  constructor(
    private src: string,
    private opts: EvalOptions,
  ) {
    for (const [k, v] of Object.entries(CONSTANTS)) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(threadConstants())) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(SHAPE_FNS)) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(MATH_FNS)) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(geoFns())) this.builtins.set(k, v);
    this.builtins.set("lib", libNamespace());
  }

  ctx(): CallCtx {
    return {
      error: (msg: string): never => {
        throw new EvalError(msg, this.callSpan);
      },
      geo: (q: GeoQuery) => {
        const key = geoKey(q);
        this.stmtGeo.push(q);
        const v = this.opts.geo?.[key];
        if (typeof v === "number") return v;
        return new Pending([key]);
      },
    };
  }

  define(name: string, kind: DepNode["kind"], value: Value, span: Span, label?: string) {
    if (this.globals.has(name)) throw new EvalError(`"${name}" is already defined`, span);
    if (this.builtins.has(name)) throw new EvalError(`"${name}" is a built-in name; choose another name`, span);
    this.globals.set(name, value);
    this.defKind.set(name, kind);
    this.defLabel.set(name, label ?? name);
  }

  run(program: Program) {
    for (const s of program.stmts) {
      this.current = new Set();
      this.stmtGeo = [];
      const id = this.stmtId(s);
      try {
        this.stmt(s);
      } catch (e) {
        if (e instanceof EvalError) {
          const where = s.k === "part" ? `In part "${s.name}": ` : s.k === "component" ? `In component "${s.name}": ` : s.k === "drawing" ? `In drawing "${s.name}": ` : "";
          this.diags.push({ message: where + e.message, start: e.span.start, end: Math.max(e.span.end, e.span.start + 1), severity: "error" });
        } else if (e instanceof Error) {
          const span = s.k === "component" ? s.call.span : s.span;
          const where = s.k === "component" ? `In component "${s.name}": ` : "";
          this.diags.push({ message: where + e.message, start: span.start, end: span.end, severity: "error" });
        } else throw e;
      }
      if (id) this.deps.set(id, this.current);
      this.current = null;
    }
  }

  stmtId(s: Stmt): string | undefined {
    if (s.k === "require") return `require:${s.label}`;
    if (s.k === "drawing") return undefined;
    return "name" in s && s.k !== "design" ? s.name : undefined;
  }

  stmt(s: Stmt) {
    switch (s.k) {
      case "design":
        this.name = s.name;
        return;
      case "note":
        this.notes.push(s.text);
        return;
      case "param": {
        this.blocks.push({ name: s.name, kind: "param", span: s.span, locked: s.locked });
        let v = this.expr(s.value, null);
        const ov = this.opts.overrides?.[s.name];
        if (ov !== undefined) v = ov;
        if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
          throw new EvalError(`Parameter "${s.name}" must be a number, text or true/false (got ${typeName(v)}). Use let for vectors and lists.`, s.valueSpan);
        }
        const min = s.min ? this.num(this.expr(s.min, null), s.min.span) : undefined;
        const max = s.max ? this.num(this.expr(s.max, null), s.max.span) : undefined;
        if (typeof v === "number" && ((min !== undefined && v < min - 1e-9) || (max !== undefined && v > max + 1e-9))) {
          this.diags.push({ message: `Parameter "${s.name}" = ${fmtNum(v)} is outside its range ${fmtNum(min ?? -Infinity)}..${fmtNum(max ?? Infinity)}`, start: s.valueSpan.start, end: s.valueSpan.end, severity: "warning" });
        }
        this.define(s.name, "param", v, s.nameSpan);
        this.params.push({
          name: s.name,
          value: v,
          text: this.src.slice(s.valueSpan.start, s.valueSpan.end),
          min,
          max,
          desc: s.desc,
          locked: s.locked,
          span: s.span,
          valueSpan: s.valueSpan,
          usedBy: [],
        });
        return;
      }
      case "let": {
        this.blocks.push({ name: s.name, kind: "let", span: s.span, locked: false });
        const v = this.expr(s.value, null);
        this.define(s.name, "let", v, s.nameSpan);
        return;
      }
      case "interface": {
        this.blocks.push({ name: s.name, kind: "interface", span: s.span, locked: false });
        const scope = new Scope();
        const fields: Record<string, Value> = {};
        for (const f of s.fields) {
          const v = this.expr(f.value, scope);
          fields[f.name] = v;
          scope.vars.set(f.name, v);
        }
        this.define(s.name, "interface", new Obj(fields, "interface", s.name), s.nameSpan);
        return;
      }
      case "component":
        this.component(s);
        return;
      case "part":
        this.part(s);
        return;
      case "require":
        this.requirement(s);
        return;
      case "drawing":
        this.drawing(s);
        return;
    }
  }

  // ---------------- expressions ----------------

  num(v: Value, span: Span, what = "value"): number {
    if (typeof v === "number") return v;
    throw new EvalError(`Expected a number for ${what}, got ${typeName(v)}`, span);
  }

  lookup(name: string, scope: Scope | null, span: Span): Value {
    const local = scope?.get(name);
    if (local !== undefined) return local;
    if (this.globals.has(name)) {
      this.current?.add(name);
      return this.globals.get(name)!;
    }
    if (this.builtins.has(name)) return this.builtins.get(name)!;
    const all = [...this.globals.keys(), ...this.builtins.keys(), ...(scope ? collectScope(scope) : [])];
    const sugg = suggest(name, all);
    throw new EvalError(`"${name}" is not defined${sugg ? `. Did you mean "${sugg}"?` : ". Definitions must come before they are used."}`, span);
  }

  expr(e: Expr, scope: Scope | null): Value {
    if (++this.steps > 2_000_000) throw new EvalError("This design is too large to evaluate (over 2 million steps). Reduce loop sizes.", e.span);
    switch (e.k) {
      case "num":
        return e.v;
      case "str":
        return e.v;
      case "color":
        return e.v;
      case "bool":
        return e.v;
      case "ident":
        return this.lookup(e.name, scope, e.span);
      case "vec": {
        const items = e.items.map((i) => this.expr(i, scope));
        const p = items.find((i) => i instanceof Pending);
        if (p) return p;
        return new Vec(items.map((v, idx) => this.num(v, e.items[idx].span, "a vector component")));
      }
      case "list":
        return e.items.map((i) => this.expr(i, scope));
      case "unary": {
        const v = this.expr(e.arg, scope);
        if (v instanceof Pending) return v;
        if (e.op === "!") return !truthy(v);
        if (typeof v === "number") return -v;
        if (v instanceof Vec) return new Vec(v.v.map((x) => -x));
        throw new EvalError(`Cannot negate ${typeName(v)}`, e.span);
      }
      case "binary":
        return this.binary(e.op, this.expr(e.left, scope), this.expr(e.right, scope), e.span);
      case "ternary": {
        const c = this.expr(e.cond, scope);
        if (c instanceof Pending) return c;
        return truthy(c) ? this.expr(e.a, scope) : this.expr(e.b, scope);
      }
      case "member":
        return this.member(this.expr(e.obj, scope), e.name, e.span);
      case "index": {
        const o = this.expr(e.obj, scope);
        const i = this.num(this.expr(e.index, scope), e.index.span, "an index");
        if (Array.isArray(o) || o instanceof Vec) {
          const arr = Array.isArray(o) ? o : o.v;
          const idx = i < 0 ? arr.length + i : i;
          if (idx < 0 || idx >= arr.length || !Number.isInteger(idx)) throw new EvalError(`Index ${i} is out of range (0..${arr.length - 1})`, e.span);
          return arr[idx];
        }
        throw new EvalError(`Cannot index ${typeName(o)}`, e.span);
      }
      case "call": {
        const callee = this.expr(e.callee, scope);
        if (!(callee instanceof Fn)) throw new EvalError(`${show(callee)} is not a function`, e.callee.span);
        const pos: Value[] = [];
        const named: Record<string, Value> = {};
        for (const a of e.args) {
          const v = this.expr(a.value, scope);
          if (a.name) {
            if (a.name in named) throw new EvalError(`Argument "${a.name}" given twice`, a.span);
            named[a.name] = v;
          } else {
            if (Object.keys(named).length) throw new EvalError("Positional arguments must come before named ones", a.span);
            pos.push(v);
          }
        }
        const saved = this.callSpan;
        this.callSpan = e.span;
        try {
          return callee.call(pos, named, this.ctx());
        } finally {
          this.callSpan = saved;
        }
      }
    }
  }

  member(o: Value, name: string, span: Span): Value {
    if (o instanceof Pending) return o;
    if (o instanceof Vec) {
      if (name === "x") return o.x;
      if (name === "y") return o.y;
      if (name === "z") return o.z;
      if (name === "length") return Math.hypot(...o.v);
      throw new EvalError(`A vector has x, y, z and length, not "${name}"`, span);
    }
    if (Array.isArray(o)) {
      if (name === "length" || name === "count") return o.length;
      if (name === "first") return o[0] ?? null;
      if (name === "last") return o[o.length - 1] ?? null;
      throw new EvalError(`A list has length, first and last, not "${name}"`, span);
    }
    if (o instanceof Obj) {
      if (name in o.fields) return o.fields[name];
      const sugg = suggest(name, Object.keys(o.fields));
      throw new EvalError(`${o.label ?? o.kind} has no field "${name}"${sugg ? `. Did you mean "${sugg}"?` : `. Fields: ${Object.keys(o.fields).join(", ")}`}`, span);
    }
    throw new EvalError(`Cannot read "${name}" of ${typeName(o)}`, span);
  }

  binary(op: string, l: Value, r: Value, span: Span): Value {
    if (op === "&&") {
      if (l instanceof Pending || r instanceof Pending) return mergePending(l, r);
      return truthy(l) && truthy(r);
    }
    if (op === "||") {
      if (l instanceof Pending || r instanceof Pending) return mergePending(l, r);
      return truthy(l) || truthy(r);
    }
    if (l instanceof Pending || r instanceof Pending) return mergePending(l, r);
    if (op === "==" || op === "!=") {
      const eq = typeof l === "number" && typeof r === "number" ? Math.abs(l - r) < 1e-9 : l === r;
      return op === "==" ? eq : !eq;
    }
    if (typeof l === "number" && typeof r === "number") {
      switch (op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          if (r === 0) throw new EvalError("Division by zero", span);
          return l / r;
        case "^":
          return l ** r;
        case "<":
          return l < r;
        case "<=":
          return l <= r + 1e-9;
        case ">":
          return l > r;
        case ">=":
          return l >= r - 1e-9;
      }
    }
    if (l instanceof Vec && r instanceof Vec && (op === "+" || op === "-")) {
      const n = Math.max(l.v.length, r.v.length);
      return new Vec(Array.from({ length: n }, (_, i) => (op === "+" ? (l.v[i] ?? 0) + (r.v[i] ?? 0) : (l.v[i] ?? 0) - (r.v[i] ?? 0))));
    }
    if (l instanceof Vec && typeof r === "number" && (op === "*" || op === "/")) {
      if (op === "/" && r === 0) throw new EvalError("Division by zero", span);
      return new Vec(l.v.map((x) => (op === "*" ? x * r : x / r)));
    }
    if (typeof l === "number" && r instanceof Vec && op === "*") return new Vec(r.v.map((x) => x * l));
    if (op === "+" && (typeof l === "string" || typeof r === "string")) return show(l).replace(/^"|"$/g, "") + show(r).replace(/^"|"$/g, "");
    if (op === "+" && Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
    throw new EvalError(`Cannot apply "${op}" to ${typeName(l)} and ${typeName(r)}`, span);
  }

  // ---------------- components ----------------

  component(s: Extract<Stmt, { k: "component" }>) {
    const callee = this.expr(s.call.callee, null);
    if (!(callee instanceof LibFn)) {
      throw new EvalError(`Components are created from the library, e.g. lib.bearing("608"). Available: ${Object.keys(LIBRARY).map((k) => "lib." + k).join(", ")}`, s.call.callee.span);
    }
    const key = callee.libKey;
    const entry = LIBRARY[key];
    const pos: Value[] = [];
    const named: Record<string, Value> = {};
    for (const a of s.call.args) {
      const v = this.expr(a.value, null);
      if (v instanceof Pending) throw new EvalError("Component sizes cannot depend on measured geometry", a.span);
      if (a.name) named[a.name] = v;
      else pos.push(v);
    }
    this.callSpan = s.call.span;
    const args = new Args(`lib.${key}`, pos, named, this.ctx(), mergeParams(POSITIONAL[key] ?? [], LIB_ARGS[key] ?? []));

    // properties
    const props: Record<string, Value> = {};
    const flags = new Set<string>();
    const propSpans: Record<string, Span> = {};
    for (const it of s.items) {
      if (it.k === "prop") {
        if (!COMP_PROPS.includes(it.name)) throw new EvalError(`Unknown component property "${it.name}". Use: ${COMP_PROPS.join(", ")}`, it.span);
        props[it.name] = this.expr(it.value, null);
        propSpans[it.name] = it.span;
      } else if (it.k === "flag") {
        if (it.name !== "locked" && it.name !== "hidden" && it.name !== "removable") throw new EvalError(`Unknown flag "${it.name}". Components accept locked, hidden and removable.`, it.span);
        flags.add(it.name);
      } else throw new EvalError("Components only take properties (at:, axis:, facing:, rotate:, spin:, mesh:, turns_with:, color:, group:) and flags (locked, hidden, removable)", it.span);
    }
    this.blocks.push({ name: s.name, kind: "component", span: s.span, locked: flags.has("locked") });
    const ctx = this.ctx();
    // `at` may be a single point or a list of points (a pattern of identical components)
    const atList: V3[] = Array.isArray(props.at)
      ? props.at.map((p, i) => toV3(p, ctx, `at[${i}]`))
      : [props.at !== undefined ? toV3(props.at, ctx, "at") : [0, 0, 0]];
    if (!atList.length) throw new EvalError("at: the list of positions is empty", propSpans.at ?? s.span);
    if (atList.length > 200) throw new EvalError("A component pattern is limited to 200 instances", propSpans.at ?? s.span);
    const multi = Array.isArray(props.at);
    const axisIn: V3 = props.axis !== undefined ? toV3(props.axis, ctx, "axis") : [0, 0, 1];
    const axis = vnorm(axisIn);
    const at0 = atList[0];

    // motion & gear phasing
    let phase = 0;
    let motion: Motion | undefined;
    let meshWith: string | undefined;
    const meshV = props.mesh;
    const turnsV = props.turns_with;
    if (props.spin !== undefined) {
      const ratio = this.num(props.spin, propSpans.spin, "spin");
      motion = { origin: at0, axis, ratio };
    }
    if (meshV !== undefined) {
      if (key !== "spur_gear") throw new EvalError("mesh: only applies to lib.spur_gear", propSpans.mesh);
      if (multi) throw new EvalError("mesh: needs a single gear position, not a list", propSpans.mesh);
      const other = this.compRef(meshV, propSpans.mesh, "mesh");
      if (!other.gear) throw new EvalError(`mesh: "${String(other.value.fields.name)}" is not a gear`, propSpans.mesh);
      if (vdot(other.axis, axis) < 0.999) throw new EvalError("mesh: gears must have parallel axes pointing the same way (use the same axis: value)", propSpans.mesh);
      const z = Math.round(args.num("z", 20));
      const { u, v } = frameFor(axis);
      const d = vsub(at0, other.at);
      const theta = (Math.atan2(vdot(d, v), vdot(d, u)) * 180) / Math.PI;
      phase = meshPhase(theta, other.gear.phase, other.gear.z, z);
      const otherRatio = other.motion?.ratio ?? 0;
      motion = { origin: at0, axis, ratio: (-otherRatio * other.gear.z) / z };
      meshWith = String(other.value.fields.name);
    }
    if (turnsV !== undefined) {
      const other = this.motionOf(turnsV, propSpans.turns_with);
      motion = key === "spur_gear" || key === "bearing" ? { origin: at0, axis, ratio: other?.ratio ?? 0 } : { origin: other?.origin ?? at0, axis: other?.axis ?? axis, ratio: other?.ratio ?? 0 };
    }

    const libArgs: LibArgs = {
      num: (n, d) => args.num(n, d),
      str: (n, d) => args.str(n, d),
      thread: (n, d) => toThread(args.value(n) ?? d, ctx, `lib.${key}(): "${n}"`),
      list2: (n) => (args.has(n) ? args.points2(n) : undefined),
      has: (n) => args.has(n),
    };
    let def: CompDef;
    try {
      def = entry.make(libArgs, phase);
    } catch (e) {
      if (e instanceof EvalError) throw e;
      throw new EvalError((e as Error).message, s.call.span);
    }

    // orientation (shared by all instances)
    const rot: Xform[] = [];
    if (def.placement === "axis") {
      if (props.rotate !== undefined) {
        if (meshV !== undefined) throw new EvalError("rotate: cannot be combined with mesh: (the mesh sets the gear's rotation)", propSpans.rotate);
        rot.push({ op: "rotate", angle: this.num(props.rotate, propSpans.rotate, "rotate (degrees about the axis)"), origin: [0, 0, 0], axis: [0, 0, 1] });
      }
      const { u, v, n } = frameFor(axis);
      rot.push(...basisXforms(u, v, n));
    } else if (def.placement === "facing") {
      const fIn: V3 = props.facing !== undefined ? toV3(props.facing, ctx, "facing") : [1, 0, 0];
      if (Math.hypot(fIn[0], fIn[1]) < 1e-9) throw new EvalError("facing: must be a horizontal direction such as X, -X, Y or -Y", propSpans.facing ?? s.span);
      const f = vnorm([fIn[0], fIn[1], 0]);
      rot.push(...basisXforms(f, vcross([0, 0, 1], f), [0, 0, 1]));
    } else if (props.rotate !== undefined) {
      const r = toV3(props.rotate, ctx, "rotate (rx, ry, rz) degrees");
      if (r[0]) rot.push({ op: "rotate", angle: r[0], origin: [0, 0, 0], axis: [1, 0, 0] });
      if (r[1]) rot.push({ op: "rotate", angle: r[1], origin: [0, 0, 0], axis: [0, 1, 0] });
      if (r[2]) rot.push({ op: "rotate", angle: r[2], origin: [0, 0, 0], axis: [0, 0, 1] });
    }

    const lf = def.fields;
    const instanceFields = (xf: Xform[], idx: number): Record<string, Value> => {
      const fields: Record<string, Value> = { name: s.name, kind: key };
      if (multi) fields.index = idx;
      for (const [k, v] of Object.entries(lf.scalars ?? {})) fields[k] = v;
      for (const [k, p] of Object.entries(lf.points ?? {})) fields[k] = new Vec(applyXforms(p, xf));
      for (const [k, d] of Object.entries(lf.dirs ?? {})) fields[k] = new Vec(vnorm(applyXformsToDir(d, xf)));
      for (const [k, list] of Object.entries(lf.pointLists ?? {})) fields[k] = list.map((p) => new Vec(applyXforms(p, xf)));
      for (const [k, sh] of Object.entries(lf.shapes ?? {})) fields[k] = new ShapeV({ t: "xform", shape: sh, xf });
      return fields;
    };
    const xfs = atList.map((p) => [...rot, { op: "translate", v: p } as Xform]);
    const fields0 = instanceFields(xfs[0], 0);
    if (motion) fields0.speed = motion.ratio;
    if (multi) {
      fields0.count = atList.length;
      fields0.all = xfs.map((xf, i) => new Obj(instanceFields(xf, i), "component", `${s.name}[${i}]`));
      // list-valued shapes so `cut screws.opening` style use cuts every instance
      for (const k of Object.keys(lf.shapes ?? {})) fields0[k] = xfs.map((xf) => new ShapeV({ t: "xform", shape: lf.shapes![k], xf }));
    }
    const value = new Obj(fields0, "component", s.name);

    const gear: GearInfo | undefined = def.gear
      ? { m: def.gear.m, z: def.gear.z, width: def.gear.width, pa: def.gear.pa, backlash: args.num("backlash", 0.05), center: at0, axis, phase, meshWith }
      : undefined;
    const info: CompInfo = { def, at: at0, axis, xf: xfs[0], motion, gear, value };
    this.define(s.name, "component", value, s.nameSpan, def.label);
    this.comps.set(s.name, info);

    if (this.opts.skipGeometry) return;
    const anyMoving = def.solids.some((sd) => sd.moving);
    const color = typeof props.color === "string" ? props.color : undefined;
    const group = typeof props.group === "string" ? props.group : groupFor(key);
    xfs.forEach((xf, idx) => {
      for (const sd of def.solids) {
        const base = multi ? `${s.name}#${idx + 1}` : s.name;
        const id = sd.suffix ? `${base}.${sd.suffix}` : base;
        const spins = motion && (!anyMoving || sd.moving);
        this.parts.push({
          id,
          name: s.name,
          label: (typeof props.label === "string" && !sd.suffix ? props.label : sd.label) + (multi ? ` #${idx + 1}` : ""),
          kind: "component",
          libKind: key,
          group,
          color: (!sd.suffix && color) || sd.color,
          material: (typeof props.material === "string" && !sd.suffix ? props.material : undefined) ?? sd.material,
          recipe: sd.recipe,
          hash: recipeHash(sd.recipe),
          xf,
          locked: flags.has("locked"),
          hidden: flags.has("hidden"),
          removable: flags.has("removable"),
          span: s.span,
          deps: [],
          motion: spins && motion ? (multi ? { ...motion, origin: atList[idx] } : motion) : undefined,
          gear: sd.suffix ? undefined : gear,
          fastener:
            def.fastener && !sd.suffix
              ? { headTop: applyXforms(def.fastener.headTop, xf), outward: vnorm(applyXformsToDir(def.fastener.outward, xf)), key: def.fastener.key, headD: def.fastener.headD, size: def.fastener.size }
              : undefined,
          bom: sd.suffix ? undefined : def.bom,
        });
      }
    });
  }

  compRef(v: Value, span: Span, what: string): CompInfo {
    if (v instanceof Obj && v.kind === "component") {
      const c = this.comps.get(String(v.fields.name));
      if (c) return c;
    }
    throw new EvalError(`${what}: expected a component name`, span);
  }

  motionOf(v: Value, span: Span): Motion | undefined {
    if (v instanceof Obj && v.kind === "component") {
      const c = this.comps.get(String(v.fields.name));
      if (c) {
        if (!c.motion) throw new EvalError(`turns_with: "${String(v.fields.name)}" does not move (give it spin:, mesh: or turns_with:)`, span);
        return c.motion;
      }
    }
    if (v instanceof Ref && v.what === "part") {
      const m = this.partMotion.get(v.name);
      if (!m) throw new EvalError(`turns_with: part "${v.name}" does not move`, span);
      return m;
    }
    throw new EvalError("turns_with: expected a moving component or part", span);
  }

  // ---------------- parts ----------------

  part(s: Extract<Stmt, { k: "part" }>) {
    const state: { base: ShapeRecipe | null; ops: PartOp[]; props: Record<string, Value>; propSpans: Record<string, Span>; flags: Set<string> } = {
      base: null,
      ops: [],
      props: {},
      propSpans: {},
      flags: new Set(),
    };
    const scope = new Scope();
    const lockedFlag = s.items.some((i) => i.k === "flag" && i.name === "locked");
    this.blocks.push({ name: s.name, kind: "part", span: s.span, locked: lockedFlag });
    // define the name first so other statements can refer to it even if geometry fails
    this.define(s.name, "part", new Ref(s.name, "part"), s.nameSpan);
    if (this.opts.skipGeometry) {
      // properties can still matter for motion
      return;
    }
    this.items(s.items, scope, state, 0);
    if (!state.base) throw new EvalError(`Part "${s.name}" has no geometry. Start with: body box(...) or body cylinder(...)`, s.nameSpan);
    const ctx = this.ctx();
    const xf: Xform[] = [];
    if (state.props.rotate !== undefined) {
      const r = toV3(state.props.rotate, ctx, "rotate (rx, ry, rz) degrees");
      if (r[0]) xf.push({ op: "rotate", angle: r[0], origin: [0, 0, 0], axis: [1, 0, 0] });
      if (r[1]) xf.push({ op: "rotate", angle: r[1], origin: [0, 0, 0], axis: [0, 1, 0] });
      if (r[2]) xf.push({ op: "rotate", angle: r[2], origin: [0, 0, 0], axis: [0, 0, 1] });
    }
    if (state.props.at !== undefined) xf.push({ op: "translate", v: toV3(state.props.at, ctx, "at") });
    let motion: Motion | undefined;
    if (state.props.turns_with !== undefined) motion = this.motionOf(state.props.turns_with, state.propSpans.turns_with);
    if (state.props.spin !== undefined) {
      const ratio = this.num(state.props.spin, state.propSpans.spin, "spin");
      const axis = state.props.axis !== undefined ? vnorm(toV3(state.props.axis, ctx, "axis")) : ([0, 0, 1] as V3);
      const origin = state.props.axis_at !== undefined ? toV3(state.props.axis_at, ctx, "axis_at") : ([0, 0, 0] as V3);
      motion = { origin, axis, ratio };
    }
    if (motion) this.partMotion.set(s.name, motion);
    const recipe: PartRecipe = { base: state.base, ops: state.ops };
    this.parts.push({
      id: s.name,
      name: s.name,
      label: typeof state.props.label === "string" ? state.props.label : s.name,
      kind: "part",
      group: typeof state.props.group === "string" ? state.props.group : "Parts",
      color: typeof state.props.color === "string" ? state.props.color : DEFAULT_COLORS[this.colorIdx++ % DEFAULT_COLORS.length],
      material: typeof state.props.material === "string" ? state.props.material : "PLA",
      recipe,
      hash: recipeHash(recipe),
      xf,
      locked: state.flags.has("locked"),
      hidden: state.flags.has("hidden"),
      removable: state.flags.has("removable"),
      span: s.span,
      deps: [],
      motion,
    });
  }

  items(items: Item[], scope: Scope, st: { base: ShapeRecipe | null; ops: PartOp[]; props: Record<string, Value>; propSpans: Record<string, Span>; flags: Set<string> }, depth: number) {
    if (depth > 20) throw new EvalError("Blocks are nested too deeply", items[0]?.span ?? { start: 0, end: 0 });
    for (const it of items) {
      switch (it.k) {
        case "prop": {
          if (!PART_PROPS.includes(it.name)) throw new EvalError(`Unknown part property "${it.name}". Use: ${PART_PROPS.join(", ")}`, it.span);
          st.props[it.name] = this.expr(it.value, scope);
          st.propSpans[it.name] = it.span;
          break;
        }
        case "flag":
          if (it.name !== "locked" && it.name !== "hidden" && it.name !== "removable") throw new EvalError(`Unknown flag "${it.name}". Parts accept the flags locked, hidden and removable.`, it.span);
          st.flags.add(it.name);
          break;
        case "let":
          scope.vars.set(it.name, this.expr(it.value, scope));
          break;
        case "op": {
          const shapes = flattenShapes(this.expr(it.shape, scope), it.shape.span);
          for (const sh of shapes) {
            if (it.op === "body" || (it.op === "add" && !st.base)) {
              if (!st.base) st.base = sh.recipe;
              else st.ops.push({ op: "add", shape: sh.recipe });
            } else {
              if (!st.base) throw new EvalError(`"${it.op}" needs a body first (start the part with body ...)`, it.span);
              st.ops.push({ op: it.op, shape: sh.recipe });
            }
          }
          if (st.ops.length > 600) throw new EvalError("A part is limited to 600 operations", it.span);
          break;
        }
        case "modifier": {
          const callee = it.call.callee;
          if (callee.k !== "ident" || !(callee.name in MODIFIER_PARAMS)) {
            throw new EvalError("Only shell(), fillet() and chamfer() can be used as statements. Shapes need body/add/cut/intersect in front.", it.span);
          }
          if (!st.base) throw new EvalError(`${callee.name}() needs a body first`, it.span);
          const pos: Value[] = [];
          const named: Record<string, Value> = {};
          for (const a of it.call.args) {
            const v = this.expr(a.value, scope);
            if (a.name) named[a.name] = v;
            else pos.push(v);
          }
          this.callSpan = it.call.span;
          const a = new Args(callee.name, pos, named, this.ctx(), MODIFIER_PARAMS[callee.name]);
          if (callee.name === "shell") st.ops.push({ op: "shell", t: a.positive("t"), open: a.dir("open", [0, 0, 1]) });
          else st.ops.push({ op: callee.name as "fillet" | "chamfer", r: a.positive("r"), edges: edgeSel(a.str("edges", "all"), this.ctx()) });
          break;
        }
        case "for": {
          const iter = this.expr(it.iter, scope);
          const list = Array.isArray(iter) ? iter : iter instanceof Vec ? iter.v : null;
          if (!list) throw new EvalError(`for ... in needs a list, got ${typeName(iter)}`, it.iter.span);
          for (const v of list) {
            const inner = new Scope(scope);
            inner.vars.set(it.varName, v);
            this.items(it.body, inner, st, depth + 1);
          }
          break;
        }
        case "if": {
          const c = this.expr(it.cond, scope);
          if (truthy(c)) this.items(it.then, new Scope(scope), st, depth + 1);
          else if (it.else) this.items(it.else, new Scope(scope), st, depth + 1);
          break;
        }
      }
    }
  }


  // ---------------- drawings ----------------

  drawing(s: Extract<Stmt, { k: "drawing" }>) {
    const locked = s.items.some((i) => i.k === "flag" && i.name === "locked");
    this.blocks.push({ name: s.name, kind: "drawing", span: s.span, locked });
    if (this.drawings.some((d) => d.name === s.name)) throw new EvalError(`A drawing called "${s.name}" already exists`, s.nameSpan);
    if (this.opts.skipGeometry) return;
    const spec = defaultSpec(s.name, s.name.replace(/_/g, " "), []);
    spec.auto = false;
    spec.locked = locked;
    spec.span = s.span;
    spec.views = [];
    let viewsProp: ViewKind[] | null = null;
    const ctx = () => this.ctx();
    const str = (v: Value, span: Span, what: string): string => {
      if (typeof v === "string") return v;
      if (typeof v === "number") return fmtNum(v, 4);
      throw new EvalError(`${what} should be text in quotes, got ${typeName(v)}`, span);
    };
    const bool = (v: Value, span: Span, what: string): boolean => {
      if (typeof v === "boolean") return v;
      throw new EvalError(`${what} should be true or false`, span);
    };
    const viewKind = (v: Value, span: Span, what: string): ViewKind => {
      const k = typeof v === "string" ? v.toLowerCase() : "";
      if ((VIEW_KINDS as readonly string[]).includes(k)) return k as ViewKind;
      throw new EvalError(`${what} should be one of ${VIEW_KINDS.map((x) => `"${x}"`).join(", ")}`, span);
    };
    const scale = (v: Value, span: Span): number => {
      const n = typeof v === "number" || typeof v === "string" ? parseScale(v) : null;
      if (n === null || n < 0.001 || n > 1000) throw new EvalError('scale should be a positive number such as 0.5, or text such as "1:2"', span);
      return n;
    };
    const names = (v: Value, span: Span): string[] => {
      const list = Array.isArray(v) ? v : [v];
      return list.map((x) => {
        const n = x instanceof Ref ? x.name : x instanceof Obj && (x.kind === "component" || x.kind === "part") ? String(x.fields.name) : typeof x === "string" ? x : null;
        if (!n) throw new EvalError("of: should name parts or components, e.g. of: base or of: [base, lid]", span);
        if (!this.parts.some((p) => p.name === n)) throw new EvalError(`of: "${n}" is not a part or component defined above this drawing`, span);
        return n;
      });
    };
    const walk = (items: Item[], scope: Scope, depth: number) => {
      if (depth > 20) throw new EvalError("Blocks are nested too deeply", items[0]?.span ?? s.span);
      for (const it of items) {
        switch (it.k) {
          case "prop": {
            if (!(DRAWING_PROPS as readonly string[]).includes(it.name)) throw new EvalError(`Unknown drawing property "${it.name}". Use: ${DRAWING_PROPS.join(", ")}`, it.span);
            const v = this.expr(it.value, scope);
            switch (it.name) {
              case "title":
                spec.title = str(v, it.span, "title");
                break;
              case "of":
                spec.of = names(v, it.span);
                break;
              case "sheet": {
                const t = str(v, it.span, "sheet");
                const hit = SHEET_NAMES.find((n) => n.toLowerCase() === t.toLowerCase());
                if (!hit) throw new EvalError(`sheet should be one of ${SHEET_NAMES.map((n) => `"${n}"`).join(", ")}`, it.span);
                spec.sheet = hit as SheetSize;
                break;
              }
              case "orientation": {
                const t = str(v, it.span, "orientation");
                if (t !== "landscape" && t !== "portrait") throw new EvalError('orientation should be "landscape" or "portrait"', it.span);
                spec.orientation = t;
                break;
              }
              case "scale":
                spec.scale = scale(v, it.span);
                break;
              case "projection": {
                const t = str(v, it.span, "projection");
                if (t !== "first" && t !== "third") throw new EvalError('projection should be "first" (ISO) or "third" (ASME)', it.span);
                spec.projection = t;
                break;
              }
              case "hidden_lines":
                spec.hidden = bool(v, it.span, "hidden_lines");
                break;
              case "auto_dims":
                spec.autoDims = bool(v, it.span, "auto_dims");
                break;
              case "parts_list":
                spec.partsList = bool(v, it.span, "parts_list");
                break;
              case "balloons":
                spec.balloons = bool(v, it.span, "balloons");
                break;
              case "views": {
                if (!Array.isArray(v)) throw new EvalError('views should be a list such as ["front", "top", "right", "iso"]', it.span);
                viewsProp = v.map((x) => viewKind(x, it.span, "each view"));
                break;
              }
              default:
                (spec as unknown as Record<string, string>)[it.name] = str(v, it.span, it.name);
            }
            break;
          }
          case "flag":
            if (it.name !== "locked") throw new EvalError(`Unknown flag "${it.name}". Drawings accept the flag locked.`, it.span);
            break;
          case "let":
            scope.vars.set(it.name, this.expr(it.value, scope));
            break;
          case "for": {
            const iter = this.expr(it.iter, scope);
            const list = Array.isArray(iter) ? iter : iter instanceof Vec ? iter.v : null;
            if (!list) throw new EvalError(`for ... in needs a list, got ${typeName(iter)}`, it.iter.span);
            for (const v of list) {
              const inner = new Scope(scope);
              inner.vars.set(it.varName, v);
              walk(it.body, inner, depth + 1);
            }
            break;
          }
          case "if": {
            const c = this.expr(it.cond, scope);
            if (truthy(c)) walk(it.then, new Scope(scope), depth + 1);
            else if (it.else) walk(it.else, new Scope(scope), depth + 1);
            break;
          }
          case "op":
            throw new EvalError(`Drawings do not take ${it.op} shapes. Use view(), section(), detail(), dim(), diameter() and note().`, it.span);
          case "modifier": {
            const callee = it.call.callee;
            const fname = callee.k === "ident" ? callee.name : "";
            if (!(fname in DRAWING_CALLS)) throw new EvalError(`Drawings accept ${Object.keys(DRAWING_CALLS).map((k) => k + "()").join(", ")}`, it.span);
            const pos: Value[] = [];
            const named: Record<string, Value> = {};
            for (const arg of it.call.args) {
              const v = this.expr(arg.value, scope);
              if (v instanceof Pending) throw new EvalError("Drawing positions cannot depend on measured geometry", arg.span);
              if (arg.name) named[arg.name] = v;
              else pos.push(v);
            }
            this.callSpan = it.call.span;
            const a = new Args(fname, pos, named, ctx(), DRAWING_CALLS[fname]);
            const optStr = (n: string) => (a.has(n) ? a.str(n) : undefined);
            const at2 = (n: string): [number, number] | undefined => {
              if (!a.has(n)) return undefined;
              const p = a.vec3(n);
              return [p[0], p[1]];
            };
            const tol = (): [number, number] | undefined => {
              const v = a.value("tol");
              if (v === undefined) return undefined;
              if (typeof v === "number") return [Math.abs(v), -Math.abs(v)];
              if (v instanceof Vec && v.v.length === 2) return [v.v[0], v.v[1]];
              return ctx().error("tol should be a number for ± (tol: 0.1) or (upper, lower) such as tol: (0.1, -0.05)");
            };
            switch (fname) {
              case "view":
                spec.views.push({ kind: viewKind(a.value("kind") ?? null, it.call.span, "view()"), label: optStr("label"), scale: a.has("scale") ? scale(a.value("scale")!, it.call.span) : undefined, hidden: a.has("hidden") ? a.bool("hidden") : undefined, at: at2("at") });
                break;
              case "section":
                spec.sections.push({
                  label: a.str("label"),
                  at: a.vec3("at", [0, 0, 0]),
                  normal: a.dir("normal"),
                  view: a.has("view") ? viewKind(a.value("view")!, it.call.span, "section(view:)") : undefined,
                  scale: a.has("scale") ? scale(a.value("scale")!, it.call.span) : undefined,
                });
                break;
              case "detail":
                spec.details.push({ label: a.str("label"), view: a.str("view", "front"), at: a.vec3("at"), r: a.positive("r"), scale: a.has("scale") ? scale(a.value("scale")!, it.call.span) : 2 });
                break;
              case "dim":
              case "diameter": {
                const align = a.str("align", "auto");
                if (!["auto", "h", "v", "aligned"].includes(align)) ctx().error('align should be "auto", "h", "v" or "aligned"');
                spec.dims.push({
                  kind: fname === "dim" ? "linear" : "diameter",
                  a: a.vec3(fname === "dim" ? "a" : "at"),
                  b: fname === "dim" ? a.vec3("b") : undefined,
                  d: fname === "diameter" ? a.positive("d") : undefined,
                  view: optStr("view"),
                  align: align as "auto",
                  offset: a.has("offset") ? a.num("offset") : undefined,
                  tol: tol(),
                  fit: optStr("fit"),
                  text: optStr("text"),
                  ref: a.bool("ref"),
                  basic: a.bool("basic"),
                  span: it.call.span,
                });
                break;
              }
              case "note":
                spec.notes.push(a.str("text"));
                break;
            }
            break;
          }
        }
      }
    };
    walk(s.items, new Scope(), 0);
    if (viewsProp) spec.views = [...(viewsProp as ViewKind[]).filter((k) => !spec.views.some((v) => v.kind === k)).map((kind) => ({ kind })), ...spec.views];
    if (!spec.views.length && !spec.sections.length) spec.views = defaultSpec("", "", []).views;
    if (spec.views.length + spec.sections.length + spec.details.length > 12) throw new EvalError("A drawing is limited to 12 views", s.span);
    this.drawings.push(spec);
  }

  // ---------------- requirements ----------------

  requirement(s: Extract<Stmt, { k: "require" }>) {
    this.blocks.push({ name: s.label, kind: "require", span: s.span, locked: false });
    const label = s.label;
    let res: { ok: boolean | null; margin?: number; detail: string };
    try {
      res = this.condition(s.expr, null);
    } catch (e) {
      if (!(e instanceof EvalError)) throw e;
      this.reqs.push({ label, level: s.level, status: "error", detail: e.message, span: s.span, deps: [...(this.current ?? [])], geo: [...this.stmtGeo] });
      throw e;
    }
    this.geoQueries.push(...this.stmtGeo);
    this.reqs.push({
      label,
      level: s.level,
      status: res.ok === null ? "pending" : res.ok ? "pass" : "fail",
      margin: res.margin,
      detail: res.detail,
      span: s.span,
      deps: [...(this.current ?? [])],
      geo: [...this.stmtGeo],
    });
  }

  condition(e: Expr, scope: Scope | null): { ok: boolean | null; margin?: number; detail: string } {
    if (e.k === "binary" && (e.op === "&&" || e.op === "||")) {
      const a = this.condition(e.left, scope);
      const b = this.condition(e.right, scope);
      const detail = `${a.detail} ${e.op === "&&" ? "and" : "or"} ${b.detail}`;
      if (a.ok === null || b.ok === null) return { ok: null, detail };
      const margin = a.margin !== undefined && b.margin !== undefined ? (e.op === "&&" ? Math.min(a.margin, b.margin) : Math.max(a.margin, b.margin)) : undefined;
      return { ok: e.op === "&&" ? a.ok && b.ok : a.ok || b.ok, margin, detail };
    }
    if (e.k === "binary" && ["<", "<=", ">", ">=", "=="].includes(e.op)) {
      const l = this.expr(e.left, scope);
      const r = this.expr(e.right, scope);
      const sym = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "==": "=" }[e.op as "<"];
      if (l instanceof Pending || r instanceof Pending) return { ok: null, detail: `measuring… ${sym}` };
      const ln = this.num(l, e.left.span, "the left side");
      const rn = this.num(r, e.right.span, "the right side");
      let margin: number;
      if (e.op === ">=" || e.op === ">") margin = ln - rn;
      else if (e.op === "<=" || e.op === "<") margin = rn - ln;
      else margin = -Math.abs(ln - rn);
      const ok = e.op === "==" ? Math.abs(ln - rn) < 1e-6 : e.op === ">" || e.op === "<" ? margin > 0 : margin >= -1e-9;
      return { ok, margin, detail: `${fmtNum(ln)} ${sym} ${fmtNum(rn)}` };
    }
    const v = this.expr(e, scope);
    if (v instanceof Pending) return { ok: null, detail: "measuring…" };
    return { ok: truthy(v), detail: show(v) };
  }

  // ---------------- output ----------------

  toModel(parseDiags: Diagnostic[]): Model {
    const nodes: DepNode[] = [];
    const edges: { from: string; to: string }[] = [];
    for (const [name, kind] of this.defKind) nodes.push({ id: name, kind, label: this.defLabel.get(name) ?? name });
    for (const r of this.reqs) nodes.push({ id: `require:${r.label}`, kind: "require", label: r.label });
    for (const [id, set] of this.deps) for (const d of set) if (d !== id) edges.push({ from: d, to: id });
    const usedBy = new Map<string, string[]>();
    for (const e of edges) usedBy.set(e.from, [...(usedBy.get(e.from) ?? []), e.to]);
    for (const p of this.params) p.usedBy = usedBy.get(p.name) ?? [];
    for (const p of this.parts) p.deps = [...(this.deps.get(p.name) ?? [])];
    return {
      name: this.name,
      notes: this.notes,
      params: this.params,
      parts: this.parts,
      requirements: this.reqs,
      diagnostics: [...parseDiags, ...this.diags],
      graph: { nodes, edges },
      blocks: this.blocks,
      geoQueries: dedupeGeo(this.geoQueries),
      drawings: this.drawings,
      evalMs: 0,
    };
  }
}

// ---------------- helpers ----------------

function truthy(v: Value): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && v !== undefined;
}

function mergePending(l: Value, r: Value): Pending {
  const keys = [...(l instanceof Pending ? l.keys : []), ...(r instanceof Pending ? r.keys : [])];
  return new Pending(keys);
}

function flattenShapes(v: Value, span: Span): ShapeV[] {
  if (v instanceof ShapeV) return [v];
  if (Array.isArray(v)) return v.flatMap((x) => flattenShapes(x, span));
  throw new EvalError(`Expected a shape (box, cylinder, hole, ...) but got ${typeName(v)}`, span);
}

function mergeParams(a: string[], b: string[]) {
  return [...a, ...b.filter((x) => !a.includes(x))];
}

function groupFor(kind: string): string {
  switch (kind) {
    case "screw":
    case "nut":
    case "insert":
    case "dowel":
      return "Hardware";
    case "bearing":
      return "Bearings";
    case "spur_gear":
      return "Gear train";
    case "nema17":
      return "Drive";
    case "pcb":
    case "usb_c":
    case "connector":
      return "Electronics";
    default:
      return "Components";
  }
}

/** Express a rotation that maps X->u, Y->v, Z->n as a single axis-angle rotation. */
function basisXforms(u: V3, v: V3, n: V3): Xform[] {
  // R columns are u, v, n. R[i][j] = col_j[i]
  const R = [
    [u[0], v[0], n[0]],
    [u[1], v[1], n[1]],
    [u[2], v[2], n[2]],
  ];
  const tr = R[0][0] + R[1][1] + R[2][2];
  const cos = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const angle = Math.acos(cos);
  if (angle < 1e-9) return [];
  let axis: V3;
  if (Math.PI - angle < 1e-6) {
    // 180°: axis from the diagonal
    const xx = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
    const yy = Math.sqrt(Math.max(0, (R[1][1] + 1) / 2));
    const zz = Math.sqrt(Math.max(0, (R[2][2] + 1) / 2));
    if (xx >= yy && xx >= zz) axis = [xx, R[0][1] / (2 * xx), R[0][2] / (2 * xx)];
    else if (yy >= zz) axis = [R[0][1] / (2 * yy), yy, R[1][2] / (2 * yy)];
    else axis = [R[0][2] / (2 * zz), R[1][2] / (2 * zz), zz];
  } else {
    const s = 2 * Math.sin(angle);
    axis = [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s];
  }
  const xf: Xform = { op: "rotate", angle: (angle * 180) / Math.PI, origin: [0, 0, 0], axis: vnorm(axis) };
  // verify (guards the 180° branch sign ambiguity)
  const check = rotateAbout([1, 0, 0], [0, 0, 0], xf.axis, xf.angle);
  const check2 = rotateAbout([0, 1, 0], [0, 0, 0], xf.axis, xf.angle);
  if (Math.hypot(check[0] - u[0], check[1] - u[1], check[2] - u[2]) > 1e-6 || Math.hypot(check2[0] - v[0], check2[1] - v[1], check2[2] - v[2]) > 1e-6) {
    // fall back to an exact two-step construction: Z -> n, then spin X -> u
    return twoStep(u, n);
  }
  return [xf];
}

function twoStep(u: V3, n: V3): Xform[] {
  const out: Xform[] = [];
  const z: V3 = [0, 0, 1];
  let axis = vcross(z, n);
  let ang = (Math.acos(Math.max(-1, Math.min(1, vdot(z, n)))) * 180) / Math.PI;
  if (Math.hypot(...axis) < 1e-9) axis = [1, 0, 0];
  if (ang > 1e-9) out.push({ op: "rotate", angle: ang, origin: [0, 0, 0], axis: vnorm(axis) });
  const x1 = ang > 1e-9 ? rotateAbout([1, 0, 0], [0, 0, 0], vnorm(axis), ang) : ([1, 0, 0] as V3);
  const s = vdot(vcross(x1, u), n);
  const c = vdot(x1, u);
  ang = (Math.atan2(s, c) * 180) / Math.PI;
  if (Math.abs(ang) > 1e-9) out.push({ op: "rotate", angle: ang, origin: [0, 0, 0], axis: n });
  return out;
}

function dedupeGeo(qs: GeoQuery[]): GeoQuery[] {
  const seen = new Map<string, GeoQuery>();
  for (const q of qs) seen.set(geoKey(q), q);
  return [...seen.values()];
}

function collectScope(s: Scope): string[] {
  const out: string[] = [];
  let c: Scope | undefined = s;
  while (c) {
    out.push(...c.vars.keys());
    c = c.parent;
  }
  return out;
}

export function suggest(name: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = levenshtein(name.toLowerCase(), o.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export type { V2 };
