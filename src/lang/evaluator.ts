// Evaluates a parsed Kerf program into a Model: parameters, placed parts and
// components with geometry recipes, requirement results and a dependency graph.

import type { BriefItem, BriefProp, Expr, Item, Program, Span, Stmt } from "./ast";
import { parse, type Diagnostic } from "./parser";
import { Fn, Obj, Pending, Ref, ShapeV, Vec, fmtNum, geoKey, show, typeName, type CallCtx, type GeoQuery, type Value } from "./values";
import { CONSTANTS, LibFn, MATH_FNS, MODIFIER_PARAMS, SHAPE_FNS, edgeSel, geoFns, libNamespace, threadConstants } from "./builtins";
import { Args, toThread, toV3 } from "./args";
import { LIBRARY, type CompDef, type LibArgs } from "../library/components";
import { ImportFn, STEP_FN, evalImports, findImport, importDef, importFields, missingImportMessage, type ImportOrigin } from "./imports";
import type { ImportRef, ImportTable } from "../kernel/imports";
import { frameFor, recipeHash, rotateAbout, vdot, vnorm, vsub, vcross, type PartOp, type PartRecipe, type ShapeRecipe, type V2, type V3, type Xform, applyXforms, applyXformsToDir } from "../kernel/recipe";
import { meshPhase } from "../library/gears";
import { FINISHES, MATERIAL_LIST, materialDef } from "../library/materials";
import type { Brief, BriefUse, DepNode, EvalDecision, EvalParam, EvalPart, EvalRequirement, GearInfo, Model, Motion } from "../core/model";
import { suggest } from "./suggest";
import { evaluateSketch, type SketchHost } from "../sketch/evaluate";
import { SOLVE_MS, budgetMs, type Budget } from "../sketch/solver";
import { sketchFns } from "../sketch/fns";
import { flipPlane, isPlane, planeConstants } from "../sketch/planes";
import type { EvalSketch } from "../sketch/types";
import { ANALYSIS_FNS, buildAnalysis, type AnalysisItem } from "../analysis/lang";
import type { AnalysisSpec } from "../analysis/spec";

export interface EvalOptions {
  /** param name -> replacement number (used by the feasibility solver) */
  overrides?: Record<string, number>;
  /** skip part geometry (fast path for requirement-only evaluation) */
  skipGeometry?: boolean;
  /** resolved geometric quantities, keyed by geoKey() */
  geo?: Record<string, number>;
  /** reuse an existing parse */
  parsed?: { program: Program; diagnostics: Diagnostic[] };
  /** STEP files imported into the project (defaults to the table set with setEvalImports) */
  imports?: ImportTable;
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
  step: ["file"],
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
  step: ["file", "origin"],
};

const PART_PROPS = ["color", "material", "finish", "group", "at", "rotate", "turns_with", "spin", "axis", "axis_at", "label"];
const COMP_PROPS = ["at", "axis", "facing", "rotate", "spin", "mesh", "turns_with", "color", "group", "material", "finish", "label"];

/** Fields of the brief block, by the type of value each takes. */
const BRIEF_TEXT = ["purpose", "setting", "look", "process", "material"] as const;
const BRIEF_LISTS = ["priorities", "exposure"] as const;
const BRIEF_VECTORS = { build_volume: "buildVolume", max_size: "maxSize" } as const;
export const BRIEF_FIELDS = [...BRIEF_TEXT, ...BRIEF_LISTS, "temp", "outdoor", "quantity", "build_volume", "max_size", "max_mass"];
const GRAVITY = 9.81;

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
  decisions: EvalDecision[] = [];
  sketches: EvalSketch[] = [];
  /** sketch solving time shared by the whole evaluation (from its first sketch), so a huge file cannot freeze the page */
  sketchBudget: Budget | undefined;
  analyses: AnalysisSpec[] = [];
  /** functions that win over other names in call position (analysis blocks) */
  callOverride: Record<string, Fn> | null = null;
  diags: Diagnostic[] = [];
  blocks: Model["blocks"] = [];
  name = "Untitled design";
  notes: string[] = [];
  brief: Brief | null = null;
  geoQueries: GeoQuery[] = [];
  callSpan: Span = { start: 0, end: 0 };
  colorIdx = 0;
  stmtGeo: GeoQuery[] = [];
  reqStmts: Extract<Stmt, { k: "require" }>[] = [];
  /** guards against runaway loops in source written by people or the AI */
  steps = 0;

  constructor(
    private src: string,
    private opts: EvalOptions,
  ) {
    for (const [k, v] of Object.entries(CONSTANTS)) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(threadConstants())) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(SHAPE_FNS)) this.builtins.set(k, v);
    // after the other shape functions: extrude() and revolve() of a sketch, anything else falls through
    const registered = (name: string) => {
      const f = this.builtins.get(name);
      return f instanceof Fn ? f : undefined;
    };
    for (const [k, v] of Object.entries(sketchFns(registered))) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(planeConstants())) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(MATH_FNS)) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(geoFns())) this.builtins.set(k, v);
    this.builtins.set("lib", libNamespace());
  }

  ctx(): CallCtx {
    return {
      error: (msg: string): never => {
        throw new EvalError(msg, this.callSpan);
      },
      warn: (msg: string) => this.diags.push({ message: msg, start: this.callSpan.start, end: Math.max(this.callSpan.end, this.callSpan.start + 1), severity: "warning" }),
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
          const where = s.k === "part" ? `In part "${s.name}": ` : s.k === "component" ? `In component "${s.name}": ` : s.k === "analysis" ? `In analysis "${s.label}": ` : "";
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
    // decisions record choices; nothing reads them, so they stay out of the dependency graph
    if (s.k === "analysis") return `analysis:${s.label}`;
    return "name" in s && s.k !== "design" && s.k !== "decision" ? s.name : undefined;
  }

  stmt(s: Stmt) {
    switch (s.k) {
      case "design":
        this.name = s.name;
        return;
      case "note":
        this.notes.push(s.text);
        return;
      case "brief":
        this.briefBlock(s);
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
      case "decision":
        this.decision(s);
        return;
      case "sketch":
        this.sketch(s);
        return;
      case "analysis":
        this.analysis(s);
        return;
    }
  }

  // ---------------- decisions ----------------

  decision(s: Extract<Stmt, { k: "decision" }>) {
    this.blocks.push({ name: s.name, kind: "decision", span: s.span, locked: false });
    if (this.decisions.some((d) => d.name === s.name)) throw new EvalError(`Decision "${s.name}" is already defined`, s.nameSpan);
    const d: EvalDecision = { name: s.name, title: s.title, options: [], span: s.span, bodyStart: s.bodyStart, props: {} };
    const KNOWN = ["ask", "chose", "by", "why"] as const;
    for (const p of s.props) {
      if (!(KNOWN as readonly string[]).includes(p.name)) {
        this.diags.push({ message: `Unknown decision field "${p.name}". Use ask, chose, by or why.`, start: p.span.start, end: p.span.end, severity: "warning" });
        continue;
      }
      const v = this.expr(p.value, null);
      if (typeof v !== "string") throw new EvalError(`Decision field "${p.name}" must be text in quotes`, p.value.span);
      (d as unknown as Record<string, string>)[p.name] = v;
      d.props[p.name] = { span: p.span, valueSpan: p.value.span };
    }
    for (const o of s.options) {
      if (d.options.some((x) => x.label === o.label)) {
        this.diags.push({ message: `Option "${o.label}" appears twice in decision "${s.name}"`, start: o.span.start, end: o.span.end, severity: "warning" });
        continue;
      }
      const sets: EvalDecision["options"][number]["sets"] = [];
      for (const st of o.sets) {
        // one bad value should not hide the rest of the decision
        try {
          const v = this.expr(st.value, null);
          if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") throw new EvalError(`Option value for "${st.param}" must be a number, text or true/false`, st.value.span);
          sets.push({ param: st.param, value: v, span: st.span, valueSpan: st.value.span });
        } catch (e) {
          if (!(e instanceof EvalError)) throw e;
          this.diags.push({ message: `In decision "${s.name}": ${e.message}`, start: e.span.start, end: Math.max(e.span.end, e.span.start + 1), severity: "error" });
        }
      }
      d.options.push({ label: o.label, note: o.note, sets, span: o.span });
    }
    if (d.chose !== undefined && d.options.length && !d.options.some((o) => o.label === d.chose)) {
      const sp = d.props.chose.valueSpan;
      this.diags.push({ message: `Decision "${s.name}" chose "${d.chose}", which is not one of its options`, start: sp.start, end: sp.end, severity: "warning" });
    }
    this.decisions.push(d);
  }

  // ---------------- sketches ----------------

  sketch(s: Extract<Stmt, { k: "sketch" }>) {
    const locked = s.items.some((i) => i.k === "flag" && i.name === "locked");
    this.blocks.push({ name: s.name, kind: "sketch", span: s.span, locked });
    const host: SketchHost = {
      src: this.src,
      expr: (e, scope) => this.expr(e, scope as Scope),
      newScope: () => new Scope(),
      setVar: (scope, name, v) => (scope as Scope).vars.set(name, v),
      fail: (msg, span) => {
        throw new EvalError(msg, span);
      },
      diag: (message, span, severity) => this.diags.push({ message, start: span.start, end: Math.max(span.end, span.start + 1), severity }),
      report: (e) => {
        if (!(e instanceof EvalError)) return false;
        this.diags.push({ message: e.message, start: e.span.start, end: Math.max(e.span.end, e.span.start + 1), severity: "error" });
        return true;
      },
      budget: (this.sketchBudget ??= budgetMs(4 * SOLVE_MS)),
    };
    const { value, sketch } = evaluateSketch(host, s);
    this.define(s.name, "sketch", value, s.nameSpan);
    this.sketches.push(sketch);
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
    if (name === "step") return STEP_FN;
    const all = [...this.globals.keys(), ...this.builtins.keys(), "step", ...(scope ? collectScope(scope) : [])];
    const sugg = suggest(name, all);
    throw new EvalError(`"${name}" is not defined${sugg ? `. Did you mean "${sugg}"?` : ". Definitions must come before they are used."}`, span);
  }

  /** count work toward the step limit; loops and list joins count by size, so an empty loop body still costs */
  tick(n: number, span: Span) {
    this.steps += n;
    if (this.steps > 2_000_000) throw new EvalError("This design is too large to evaluate (over 2 million steps). Reduce loop sizes.", span);
  }

  expr(e: Expr, scope: Scope | null): Value {
    this.tick(1, e.span);
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
        if (isPlane(v)) return flipPlane(v);
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
        const override = e.callee.k === "ident" ? this.callOverride?.[e.callee.name] : undefined;
        const callee = override ?? this.expr(e.callee, scope);
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
    if (op === "+" && Array.isArray(l) && Array.isArray(r)) {
      if (l.length + r.length > 100_000) throw new EvalError("Lists are limited to 100,000 items", span);
      this.tick(l.length + r.length, span);
      return [...l, ...r];
    }
    throw new EvalError(`Cannot apply "${op}" to ${typeName(l)} and ${typeName(r)}`, span);
  }

  // ---------------- components ----------------

  component(s: Extract<Stmt, { k: "component" }>) {
    const callee = this.expr(s.call.callee, null);
    if (!(callee instanceof LibFn) && !(callee instanceof ImportFn)) {
      throw new EvalError(`Components are created from the library, e.g. lib.bearing("608"), or from an imported STEP file with step("name"). Available: ${Object.keys(LIBRARY).map((k) => "lib." + k).join(", ")}`, s.call.callee.span);
    }
    const key = callee instanceof ImportFn ? "step" : callee.libKey;
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
    const args = new Args(key === "step" ? "step" : `lib.${key}`, pos, named, this.ctx(), mergeParams(POSITIONAL[key] ?? [], LIB_ARGS[key] ?? []));

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
      } else throw new EvalError("Components only take properties (at:, axis:, facing:, rotate:, spin:, mesh:, turns_with:, color:, group:, material:, finish:) and flags (locked, hidden, removable)", it.span);
    }
    this.checkMaterial(props, propSpans);
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
    let imported: { ref: ImportRef; origin: ImportOrigin } | undefined;
    if (key === "step") {
      const table = this.opts.imports ?? evalImports();
      const file = args.str("file");
      const ref = findImport(table, file);
      if (!ref) throw new EvalError(missingImportMessage(table, file), s.call.span);
      const origin = args.str("origin", "base");
      if (origin !== "base" && origin !== "center" && origin !== "file") throw new EvalError('step(): origin must be "base" (centre of the bottom, the default), "center" or "file" (the file\'s own origin)', s.call.span);
      if (!ref.meta.bodies.length) throw new EvalError(`"${ref.name}" has no geometry Kerf could read`, s.call.span);
      imported = { ref, origin };
      def = importDef(ref, origin);
    } else {
      try {
        def = entry.make(libArgs, phase);
      } catch (e) {
        if (e instanceof EvalError) throw e;
        throw new EvalError((e as Error).message, s.call.span);
      }
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
      if (imported) {
        const base = multi ? `${s.name}#${idx + 1}` : s.name;
        const ids = def.solids.map((sd) => (sd.suffix ? `${base}.${sd.suffix}` : base));
        const own = importFields(imported.ref, imported.origin, xf, ids);
        // keep the lazy body list lazy
        for (const k of Object.keys(own)) Object.defineProperty(fields, k, Object.getOwnPropertyDescriptor(own, k)!);
        fields.name = s.name;
      }
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
      ? { m: def.gear.m, z: def.gear.z, width: def.gear.width, pa: def.gear.pa, bore: def.gear.bore, backlash: args.num("backlash", 0.05), center: at0, axis, phase, meshWith }
      : undefined;
    const info: CompInfo = { def, at: at0, axis, xf: xfs[0], motion, gear, value };
    this.define(s.name, "component", value, s.nameSpan, def.label);
    this.comps.set(s.name, info);

    if (this.opts.skipGeometry) return;
    const anyMoving = def.solids.some((sd) => sd.moving);
    const color = typeof props.color === "string" ? props.color : undefined;
    const group = typeof props.group === "string" ? props.group : groupFor(key);
    xfs.forEach((xf, idx) => {
      def.solids.forEach((sd, sdIdx) => {
        const base = multi ? `${s.name}#${idx + 1}` : s.name;
        const id = sd.suffix ? `${base}.${sd.suffix}` : base;
        const spins = motion && (!anyMoving || sd.moving);
        this.parts.push({
          id,
          name: s.name,
          label: (typeof props.label === "string" && (!sd.suffix || imported) ? (imported && def.solids.length > 1 ? `${props.label}: ${imported.ref.meta.bodies[sdIdx].name}` : props.label) : sd.label) + (multi ? ` #${idx + 1}` : ""),
          kind: "component",
          libKind: key,
          group,
          color: ((!sd.suffix || imported) && color) || sd.color,
          material: (typeof props.material === "string" && (!sd.suffix || imported) ? props.material : undefined) ?? sd.material,
          finish: (typeof props.finish === "string" && (!sd.suffix || imported) ? props.finish : undefined) ?? (typeof props.material === "string" && (!sd.suffix || imported) ? undefined : sd.finish),
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
          bearing: def.bearing && !sd.suffix ? { ...def.bearing, center: applyXforms([0, 0, def.bearing.width / 2], xf), axis } : undefined,
          fastener:
            def.fastener && !sd.suffix
              ? { headTop: applyXforms(def.fastener.headTop, xf), outward: vnorm(applyXformsToDir(def.fastener.outward, xf)), key: def.fastener.key, headD: def.fastener.headD, size: def.fastener.size }
              : undefined,
          bom: (imported ? sdIdx > 0 : sd.suffix) ? undefined : def.bom,
          imported: imported
            ? {
                asset: imported.ref.hash,
                file: imported.ref.name,
                body: sdIdx,
                bodyName: imported.ref.meta.bodies[sdIdx].name,
                kind: imported.ref.meta.bodies[sdIdx].kind,
                faceColors: !color && !!imported.ref.meta.bodies[sdIdx].faceColors,
              }
            : undefined,
        });
      });
    });
  }

  compRef(v: Value, span: Span, what: string): CompInfo {
    if (v instanceof Obj && v.kind === "component") {
      const c = this.comps.get(String(v.fields.name));
      if (c) return c;
    }
    throw new EvalError(`${what}: expected a component name`, span);
  }

  /** Warn about material and finish names Kerf does not know, with the closest match. */
  checkMaterial(props: Record<string, Value>, spans: Record<string, Span>) {
    const material = props.material;
    if (props.material !== undefined && typeof material !== "string") throw new EvalError('material: expected a name in quotes, like "PETG"', spans.material);
    if (props.finish !== undefined && typeof props.finish !== "string") throw new EvalError('finish: expected a name in quotes, like "anodized"', spans.finish);
    const def = typeof material === "string" ? materialDef(material) : undefined;
    if (typeof material === "string" && !def) {
      const sugg = suggest(material, MATERIAL_LIST.map((m) => m.name));
      this.diags.push({ message: `Unknown material "${material}"${sugg ? `. Did you mean "${sugg}"?` : ""} Mass uses 1.2 g/cm³ and it draws as a plain plastic.`, start: spans.material.start, end: spans.material.end, severity: "warning" });
    }
    const finish = props.finish;
    if (typeof finish === "string") {
      const allowed = def ? def.finishes : Object.keys(FINISHES);
      if (!allowed.includes(finish)) {
        const sugg = suggest(finish, allowed);
        const what = def ? `${def.name} can be ${allowed.map((f) => `"${f}"`).join(", ")}` : `Finishes: ${allowed.join(", ")}`;
        this.diags.push({ message: `Finish "${finish}" does not apply here${sugg ? `. Did you mean "${sugg}"?` : "."} ${what}.`, start: spans.finish.start, end: spans.finish.end, severity: "warning" });
      }
    }
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
    this.checkMaterial(state.props, state.propSpans);
    const recipe: PartRecipe = { base: state.base, ops: state.ops };
    this.parts.push({
      id: s.name,
      name: s.name,
      label: typeof state.props.label === "string" ? state.props.label : s.name,
      kind: "part",
      group: typeof state.props.group === "string" ? state.props.group : "Parts",
      color: typeof state.props.color === "string" ? state.props.color : DEFAULT_COLORS[this.colorIdx++ % DEFAULT_COLORS.length],
      material: typeof state.props.material === "string" ? state.props.material : "PLA",
      finish: typeof state.props.finish === "string" ? state.props.finish : undefined,
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
            this.tick(1, it.iter.span);
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

  // ---------------- the brief ----------------

  briefBlock(s: Extract<Stmt, { k: "brief" }>) {
    if (this.brief) throw new EvalError("A design has one brief. Merge the two brief blocks into one.", { start: s.span.start, end: s.span.start + 5 });
    const b: Brief = { span: s.span, priorities: [], exposure: [], assumed: [], uses: [], givens: [], refs: [], assumptions: [], extra: [] };
    this.brief = b;
    // one bad entry should not hide the rest of the brief
    for (const it of s.items) {
      try {
        this.briefItem(b, it);
      } catch (e) {
        if (!(e instanceof EvalError)) throw e;
        this.diags.push({ message: `In the brief: ${e.message}`, start: e.span.start, end: Math.max(e.span.end, e.span.start + 1), severity: "error" });
      }
    }
  }

  briefItem(b: Brief, it: BriefItem) {
    const text = (e: Expr, what: string) => {
      const v = this.expr(e, null);
      if (typeof v !== "string") throw new EvalError(`${what} should be text in quotes`, e.span);
      return v;
    };
    const number = (e: Expr, what: string) => this.num(this.expr(e, null), e.span, what);
    switch (it.k) {
      case "field": {
        const n = it.name;
        if (it.to && n !== "temp") throw new EvalError(`Only temp takes a range (temp: -10C .. 40C)`, it.span);
        if ((BRIEF_TEXT as readonly string[]).includes(n)) {
          (b as unknown as Record<string, string>)[n] = text(it.value, n);
        } else if ((BRIEF_LISTS as readonly string[]).includes(n)) {
          const v = this.expr(it.value, null);
          const list = Array.isArray(v) ? v : [v];
          if (!list.every((x) => typeof x === "string")) throw new EvalError(`${n} should be a list of text, like ["sunlight", "rain"]`, it.value.span);
          b[n as "priorities" | "exposure"] = list as string[];
        } else if (n === "temp") {
          let lo: number;
          let hi: number;
          if (it.to) {
            lo = number(it.value, "the lowest temperature");
            hi = number(it.to, "the highest temperature");
          } else {
            const v = this.expr(it.value, null);
            if (!(v instanceof Vec) || v.v.length !== 2) throw new EvalError("temp should be a range in °C, like temp: -10C .. 40C", it.value.span);
            [lo, hi] = v.v;
          }
          if (lo > hi) throw new EvalError("temp: the lowest temperature comes first", it.span);
          b.temp = [lo, hi];
        } else if (n === "outdoor") {
          const v = this.expr(it.value, null);
          if (typeof v !== "boolean") throw new EvalError("outdoor should be true or false", it.value.span);
          b.outdoor = v;
        } else if (n === "quantity") {
          const q = number(it.value, "quantity");
          if (!(q >= 1) || Math.round(q) !== q) throw new EvalError("quantity should be a whole number of 1 or more", it.value.span);
          b.quantity = q;
        } else if (n in BRIEF_VECTORS) {
          const v = this.expr(it.value, null);
          if (!(v instanceof Vec) || v.v.length !== 3 || v.v.some((x) => !(x > 0))) throw new EvalError(`${n} should be three positive sizes in mm, like (220, 220, 250)`, it.value.span);
          b[BRIEF_VECTORS[n as keyof typeof BRIEF_VECTORS]] = v.v3();
        } else if (n === "max_mass") {
          const m = number(it.value, "max_mass");
          if (!(m > 0)) throw new EvalError("max_mass should be a positive mass, like 60g", it.value.span);
          b.maxMass = m;
        } else {
          b.extra.push({ name: n, text: this.src.slice(it.value.span.start, (it.to ?? it.value).span.end), span: it.span });
          this.diags.push({ message: `The brief has no field "${n}". Known fields: ${BRIEF_FIELDS.join(", ")}.`, start: it.nameSpan.start, end: it.nameSpan.end, severity: "warning" });
          return;
        }
        if (it.assumed) b.assumed.push(n);
        return;
      }
      case "use": {
        if (b.uses.some((u) => u.id === it.id)) throw new EvalError(`The brief already has a use named "${it.id}"`, it.idSpan);
        const u: BriefUse = { id: it.id, text: it.text, assumed: it.assumed, span: it.span };
        for (const p of it.props) this.useProp(u, p);
        b.uses.push(u);
        return;
      }
      case "given": {
        this.blocks.push({ name: it.name, kind: "given", span: it.span, locked: false });
        const v = this.expr(it.value, null);
        if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
          throw new EvalError(`Given "${it.name}" must be a number, text or true/false (got ${typeName(v)})`, it.valueSpan);
        }
        this.define(it.name, "given", v, it.nameSpan);
        b.givens.push({ name: it.name, value: v, text: this.src.slice(it.valueSpan.start, it.valueSpan.end), desc: it.desc, assumed: it.assumed, span: it.span, valueSpan: it.valueSpan, usedBy: [] });
        return;
      }
      case "reference": {
        if (b.refs.some((r) => r.id === it.id)) throw new EvalError(`The brief already has a reference named "${it.id}"`, it.idSpan);
        const r: Brief["refs"][number] = { id: it.id, title: it.title, span: it.span };
        for (const p of it.props) {
          if (p.name === "file") {
            const f = text(p.value, "file");
            if (!/^ast_[a-z0-9]{4,32}$/.test(f)) throw new EvalError(`file should be a stored file id like "ast_k3j9x2"`, p.value.span);
            r.file = f;
          } else if (p.name === "url") {
            const url = text(p.value, "url");
            if (!/^https?:\/\/\S+$/i.test(url)) throw new EvalError("url should start with https:// or http://", p.value.span);
            r.url = url;
          } else if (p.name === "notes") r.notes = text(p.value, "notes");
          else this.diags.push({ message: `A reference takes file, url and notes, not "${p.name}"`, start: p.span.start, end: p.span.end, severity: "warning" });
        }
        b.refs.push(r);
        return;
      }
      case "assume":
        b.assumptions.push({ text: it.text, confirmed: it.confirmed, span: it.span });
        return;
    }
  }

  useProp(u: BriefUse, p: BriefProp) {
    switch (p.name) {
      case "load": {
        const v = this.num(this.expr(p.value, null), p.value.span, "load");
        // a mass hanging from the part ("2kg") becomes its weight in newtons
        const unit = p.value.k === "num" ? p.value.unit : undefined;
        u.load = unit === "kg" || unit === "g" ? (v / 1000) * GRAVITY : v;
        if (!(u.load > 0)) throw new EvalError("load should be a positive force, like 30N or 2kg", p.value.span);
        return;
      }
      case "dir": {
        const v = this.expr(p.value, null);
        if (!(v instanceof Vec)) throw new EvalError("dir should be a direction such as -Z or (0, 1, 0)", p.value.span);
        const d = v.v3();
        if (Math.hypot(...d) < 1e-9) throw new EvalError("dir cannot be zero", p.value.span);
        // +0 turns the -0 of a negated axis into a plain 0
        u.dir = vnorm(d).map((x) => x + 0) as V3;
        return;
      }
      case "on":
        // a part name, written bare or in quotes; checked once every part is known
        if (p.value.k === "ident") u.on = p.value.name;
        else u.on = String(this.expr(p.value, null));
        return;
      case "cycles": {
        const c = this.num(this.expr(p.value, null), p.value.span, "cycles");
        if (!(c >= 1)) throw new EvalError("cycles should be 1 or more", p.value.span);
        u.cycles = Math.round(c);
        return;
      }
      case "note": {
        const v = this.expr(p.value, null);
        if (typeof v !== "string") throw new EvalError("note should be text in quotes", p.value.span);
        u.note = v;
        return;
      }
    }
    this.diags.push({ message: `A use takes load, dir, on, cycles and note, not "${p.name}"`, start: p.span.start, end: p.span.end, severity: "warning" });
  }

  /** Links that can only be checked once the whole design is known. */
  briefLinks() {
    const b = this.brief;
    const uses = new Set(b?.uses.map((u) => u.id) ?? []);
    for (const s of this.reqStmts) {
      for (const u of s.uses) {
        if (uses.has(u.name)) continue;
        const sugg = suggest(u.name, [...uses]);
        const msg = b ? `The brief has no use named "${u.name}"${sugg ? `. Did you mean "${sugg}"?` : ""}` : `"for ${u.name}" refers to the brief, but this design has no brief`;
        this.diags.push({ message: msg, start: u.span.start, end: u.span.end, severity: "warning" });
      }
    }
    if (!b) return;
    const names = new Set(this.parts.map((p) => p.name));
    for (const u of b.uses) {
      if (u.on && !names.has(u.on)) this.diags.push({ message: `Use "${u.id}" acts on "${u.on}", which is not a part or component in this design`, start: u.span.start, end: u.span.end, severity: "warning" });
    }
  }

  // ---------------- requirements ----------------

  requirement(s: Extract<Stmt, { k: "require" }>) {
    this.blocks.push({ name: s.label, kind: "require", span: s.span, locked: false });
    this.reqStmts.push(s);
    const label = s.label;
    let res: { ok: boolean | null; margin?: number; detail: string };
    try {
      res = this.condition(s.expr, null);
    } catch (e) {
      if (!(e instanceof EvalError)) throw e;
      this.reqs.push({ label, level: s.level, uses: s.uses.map((u) => u.name), status: "error", detail: e.message, span: s.span, deps: [...(this.current ?? [])], geo: [...this.stmtGeo] });
      throw e;
    }
    this.geoQueries.push(...this.stmtGeo);
    this.reqs.push({
      label,
      level: s.level,
      uses: s.uses.map((u) => u.name),
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

  // ---------------- analyses ----------------

  analysis(s: Extract<Stmt, { k: "analysis" }>) {
    this.blocks.push({ name: s.label, kind: "analysis", span: s.span, locked: s.items.some((i) => i.k === "flag" && i.name === "locked") });
    if (this.analyses.some((a) => a.label === s.label)) throw new EvalError(`There is already an analysis called "${s.label}"`, s.labelSpan);
    const props: AnalysisItem[] = [];
    const flags: AnalysisItem[] = [];
    const saved = this.callOverride;
    this.callOverride = ANALYSIS_FNS;
    try {
      this.analysisItems(s.items, new Scope(), props, flags, 0);
    } finally {
      this.callOverride = saved;
    }
    const spec = buildAnalysis(s.label, props, flags, s.span, {
      fail: (msg, span) => {
        throw new EvalError(msg, span);
      },
      kindOf: (name) => {
        const k = this.defKind.get(name);
        if (k) this.current?.add(name);
        return k;
      },
    });
    // the parts it reads are dependencies, so the graph and incremental reruns see them
    if (spec.kind === "structural") for (const p of spec.parts) if (this.defKind.has(p)) this.current?.add(p);
    if (spec.kind === "drivetrain") {
      const k = this.defKind.get(spec.drive);
      if (k !== "component" && k !== "part") throw new EvalError(`drive: "${spec.drive}" is not a component or part`, s.span);
      this.current?.add(spec.drive);
    }
    this.analyses.push(spec);
  }

  analysisItems(items: Item[], scope: Scope, props: AnalysisItem[], flags: AnalysisItem[], depth: number) {
    if (depth > 20) throw new EvalError("Blocks are nested too deeply", items[0]?.span ?? { start: 0, end: 0 });
    for (const it of items) {
      switch (it.k) {
        case "prop":
          props.push({ name: it.name, value: this.expr(it.value, scope), span: it.span });
          break;
        case "flag":
          flags.push({ name: it.name, value: true, span: it.span });
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
            this.analysisItems(it.body, inner, props, flags, depth + 1);
          }
          break;
        }
        case "if": {
          const c = this.expr(it.cond, scope);
          if (truthy(c)) this.analysisItems(it.then, new Scope(scope), props, flags, depth + 1);
          else if (it.else) this.analysisItems(it.else, new Scope(scope), props, flags, depth + 1);
          break;
        }
        default:
          throw new EvalError("An analysis block takes properties such as fix:, load:, safety:, flags such as gravity, and let, for and if.", it.span);
      }
    }
  }

  // ---------------- output ----------------

  toModel(parseDiags: Diagnostic[]): Model {
    this.briefLinks();
    const nodes: DepNode[] = [];
    const edges: { from: string; to: string }[] = [];
    for (const [name, kind] of this.defKind) nodes.push({ id: name, kind, label: this.defLabel.get(name) ?? name });
    for (const r of this.reqs) nodes.push({ id: `require:${r.label}`, kind: "require", label: r.label });
    for (const a of this.analyses) nodes.push({ id: `analysis:${a.label}`, kind: "analysis", label: a.label });
    for (const [id, set] of this.deps) for (const d of set) if (d !== id) edges.push({ from: d, to: id });
    const usedBy = new Map<string, string[]>();
    for (const e of edges) usedBy.set(e.from, [...(usedBy.get(e.from) ?? []), e.to]);
    for (const p of this.params) p.usedBy = usedBy.get(p.name) ?? [];
    for (const g of this.brief?.givens ?? []) g.usedBy = usedBy.get(g.name) ?? [];
    for (const p of this.parts) p.deps = [...(this.deps.get(p.name) ?? [])];
    // an option may name only parameters (defined anywhere in the file)
    const paramNames = new Set(this.params.map((p) => p.name));
    for (const d of this.decisions)
      for (const o of d.options)
        for (const st of o.sets)
          if (!paramNames.has(st.param)) this.diags.push({ message: `Option "${o.label}" sets "${st.param}", which is not a parameter`, start: st.span.start, end: st.span.end, severity: "warning" });
    for (const sk of this.sketches) sk.usedBy = (usedBy.get(sk.name) ?? []).filter((n) => this.defKind.get(n) === "part");
    return {
      name: this.name,
      notes: this.notes,
      brief: this.brief,
      params: this.params,
      parts: this.parts,
      requirements: this.reqs,
      decisions: this.decisions,
      sketches: this.sketches,
      analyses: this.analyses,
      diagnostics: [...parseDiags, ...this.diags],
      graph: { nodes, edges },
      blocks: this.blocks,
      geoQueries: dedupeGeo(this.geoQueries),
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
    case "step":
      return "Imported";
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

export { suggest };
export type { V2 };
