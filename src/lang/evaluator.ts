// Evaluates a parsed Kerf program into a Model: parameters, placed parts and
// components with geometry recipes, requirement results and a dependency graph.

import type { BriefItem, BriefProp, Expr, Item, Program, Span, Stmt } from "./ast";
import { parse, parseExpression, type Diagnostic } from "./parser";
import { FeatRef, FeatureV, Fn, Obj, Pending, ProfileV, Ref, SelV, ShapeV, Vec, fmtNum, geoKey, show, typeName, type CallCtx, type GeoQuery, type Value } from "./values";
import { CONSTANTS, LibFn, MATH_FNS, MODIFIER_PARAMS, SHAPE_FNS, geoFns, libNamespace, threadConstants } from "./builtins";
import { MODELLING_FNS, allowableStrain, featMember, isSelValue, selFeatures, selMember, toSel } from "./modelling";
import { Args, toThread, toV3 } from "./args";
import { LIBRARY, type CompDef, type LibArgs } from "../library/components";
import { ImportFn, STEP_FN, evalImports, findImport, importDef, importFields, missingImportMessage, type ImportOrigin } from "./imports";
import type { ImportRef, ImportTable } from "../kernel/imports";
import { frameFor, hasDetail, recipeHash, rotateAbout, vdot, vnorm, vsub, vcross, type OpenSpec, type PartOp, type PartRecipe, type Sel, type ShapeRecipe, type V2, type V3, type Xform, applyXforms, applyXformsToDir } from "../kernel/recipe";
import { meshPhase } from "../library/gears";
import { FINISHES, MATERIAL_LIST, materialDef } from "../library/materials";
import type { Brief, BriefUse, DepNode, EvalDecision, EvalParam, EvalPart, EvalRequirement, GearInfo, Model, Motion } from "../core/model";
import { CalcObj, calcNamespace } from "../machine/calcs";
import { catalogPart } from "../machine/catalog";
import { MACHINE_LIBRARY, groupForCatalog } from "../machine/library";
import { emptyMachine, type MachineData, type PinRef } from "../machine/types";
import { suggest } from "./suggest";
import { evaluateSketch, type SketchHost } from "../sketch/evaluate";
import { SOLVE_MS, budgetMs, type Budget } from "../sketch/solver";
import { sketchFns } from "../sketch/fns";
import { flipPlane, isPlane, planeConstants } from "../sketch/planes";
import type { EvalSketch } from "../sketch/types";
import { ANALYSIS_FNS, buildAnalysis, type AnalysisItem } from "../analysis/lang";
import type { AnalysisSpec } from "../analysis/spec";
import { ProcessV, applyDefaultProcess, mfgNamespace, partMaterial, processFromValue, toProcess } from "../mfg/spec";
import { specToSource } from "../mfg/profiles";
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

const PART_PROPS = ["color", "material", "finish", "process", "group", "at", "rotate", "turns_with", "spin", "axis", "axis_at", "label"];
const COMP_PROPS = ["at", "axis", "facing", "rotate", "spin", "mesh", "turns_with", "color", "group", "material", "finish", "label"];

/** Fields of the brief block, by the type of value each takes. */
const BRIEF_TEXT = ["purpose", "setting", "look", "process", "material"] as const;
const BRIEF_LISTS = ["priorities", "exposure"] as const;
const BRIEF_VECTORS = { build_volume: "buildVolume", max_size: "maxSize" } as const;
export const BRIEF_FIELDS = [...BRIEF_TEXT, ...BRIEF_LISTS, "temp", "outdoor", "quantity", "build_volume", "max_size", "max_mass"];
/** extra properties of purchasable catalog parts */
const MACHINE_PROPS = ["role", "load", "buy", "price", "rating"];
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

interface PartState {
  base: ShapeRecipe | null;
  baseName?: string;
  ops: PartOp[];
  props: Record<string, Value>;
  propSpans: Record<string, Span>;
  flags: Set<string>;
  /** the part's top scope, where `as` names live */
  root: Scope;
  /** inside a cosmetic { } block */
  cosmetic: boolean;
  feats: Map<string, { kind: string; cosmetic: boolean }>;
  /** counters for unnamed ready-made features (screw_boss#1) */
  auto: Map<string, number>;
  strain: { strain: number; span: Span }[];
}

class Scope {
  vars = new Map<string, Value>();
  constructor(public parent?: Scope) {}
  get(name: string): Value | undefined {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.get(name);
  }
}

/**
 * Evaluate a selector written as text (`boss.root`, `near((0, 0, 10))`,
 * `"top" + circles(3)`) for a part with the given feature names, seeing the params and lets of the design source.
 */
export function evaluateSelector(text: string, features: string[], design?: string): { sel?: Sel; error?: string } {
  const parsed = parseExpression(text);
  if (!parsed.expr) return { error: parsed.error };
  const ev = new Evaluator(design ?? text, {});
  // the design's params and lets, so near((0, 0, wall), 1) can use them
  if (design) ev.run(parse(design).program);
  const scope = new Scope();
  for (const f of features) scope.vars.set(f, new FeatRef(f, "feature"));
  try {
    const v = ev.expr(parsed.expr, scope);
    ev.callSpan = parsed.expr.span;
    return { sel: toSel(v, ev.ctx(), "the selection") };
  } catch (e) {
    if (e instanceof EvalError || e instanceof Error) return { error: e.message };
    throw e;
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
  drawings: DrawingSpec[] = [];
  callSpan: Span = { start: 0, end: 0 };
  colorIdx = 0;
  stmtGeo: GeoQuery[] = [];
  reqStmts: Extract<Stmt, { k: "require" }>[] = [];
  /** guards against runaway loops in source written by people or the AI */
  steps = 0;
  machine: MachineData = emptyMachine();

  constructor(
    private src: string,
    private opts: EvalOptions,
  ) {
    for (const [k, v] of Object.entries(CONSTANTS)) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(threadConstants())) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(SHAPE_FNS)) this.builtins.set(k, v);
    for (const [k, v] of Object.entries(MODELLING_FNS)) this.builtins.set(k, v);
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
    this.builtins.set("calc", calcNamespace());
    this.builtins.set("mfg", mfgNamespace());
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
      tick: (n: number) => this.tick(n, this.callSpan),
    };
  }

  define(name: string, kind: DepNode["kind"], value: Value, span: Span, label?: string) {
    if (this.globals.has(name)) throw new EvalError(`"${name}" is already defined`, span);
    // a design's own names shadow built-in ones (lookup reads globals first), so designs written before a
    // built-in of the same name was added keep working
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
          const where = s.k === "part" ? `In part "${s.name}": ` : s.k === "component" ? `In component "${s.name}": ` : s.k === "drawing" ? `In drawing "${s.name}": ` : s.k === "analysis" ? `In analysis "${s.label}": ` : "";
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
    if (s.k === "drawing" || s.k === "wire" || s.k === "net" || s.k === "firmware" || s.k === "test" || s.k === "buy") return undefined;
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
        if (v instanceof CalcObj) this.machine.calcs.push({ ...v.trace, name: s.name, span: s.span });
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
      case "decision":
        this.decision(s);
        return;
      case "sketch":
        this.sketch(s);
        return;
      case "analysis":
        this.analysis(s);
        return;
      case "wire":
      case "net":
      case "firmware":
      case "test":
      case "buy":
        this.machineStmt(s);
        return;
    }
  }

  // ---------------- machines: wiring, firmware, tests, purchases ----------------

  pinRef(e: Expr): PinRef {
    if (e.k !== "member") throw new EvalError("Expected a pin like ctrl.D5", e.span);
    let comp: string;
    let index: number | undefined;
    if (e.obj.k === "ident") comp = e.obj.name;
    else if (e.obj.k === "index" && e.obj.obj.k === "ident") {
      comp = e.obj.obj.name;
      index = this.num(this.expr(e.obj.index, null), e.obj.index.span, "an instance index");
    } else throw new EvalError("Expected a pin like ctrl.D5", e.span);
    const info = this.comps.get(comp);
    if (!info) {
      const sugg = suggest(comp, [...this.comps.keys()]);
      throw new EvalError(`"${comp}" is not a component${sugg ? `. Did you mean "${sugg}"?` : ". Define components before wiring them."}`, e.obj.span);
    }
    this.current?.add(comp);
    const part = info.def.catalog ? catalogPart(info.def.catalog.id) : undefined;
    if (!part) throw new EvalError(`"${comp}" is not a catalog part, so it has no pins to wire`, e.obj.span);
    const want = e.name.toLowerCase();
    const pin = part.pins.find((p) => p.id.toLowerCase() === want) ?? part.pins.find((p) => p.label?.toLowerCase() === want);
    if (!pin) {
      const sugg = suggest(e.name, part.pins.map((p) => p.id));
      throw new EvalError(`${part.name} has no pin "${e.name}"${sugg ? `. Did you mean "${sugg}"?` : `. Pins: ${part.pins.map((p) => p.id).join(", ")}`}`, e.span);
    }
    const count = info.value.fields.count;
    if (index !== undefined && (typeof count !== "number" || index < 0 || index >= count || !Number.isInteger(index))) {
      throw new EvalError(`"${comp}" has ${typeof count === "number" ? count : 1} instance(s): index ${index} is out of range`, e.obj.span);
    }
    return { comp, index, pin: pin.id, span: e.span };
  }

  machineProps(items: Item[], allowed: string[] | null, what: string): Record<string, number | string | boolean> {
    const out: Record<string, number | string | boolean> = {};
    for (const it of items) {
      if (it.k !== "prop") throw new EvalError(`${what} only takes properties like gauge: 22`, it.span);
      if (allowed && !allowed.includes(it.name)) throw new EvalError(`Unknown ${what} property "${it.name}". Use: ${allowed.join(", ")}`, it.span);
      const v = this.expr(it.value, null);
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[it.name] = v;
      else if (v instanceof Obj && v.kind === "component") out[it.name] = String(v.fields.name);
      else if (v instanceof Obj && v.kind === "calc") throw new EvalError(`${it.name}: give one result of the calculation, e.g. ${it.name}: speed.rpm`, it.span);
      else throw new EvalError(`${it.name} should be a number, text or true/false (got ${typeName(v)})`, it.span);
    }
    return out;
  }

  machineStmt(s: Extract<Stmt, { k: "wire" | "net" | "firmware" | "test" | "buy" }>) {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const numv = (v: unknown) => (typeof v === "number" ? v : undefined);
    switch (s.k) {
      case "wire": {
        const refs = s.path.map((e) => this.pinRef(e));
        const pr = this.machineProps(s.items, ["gauge", "color", "label"], "wire");
        for (let i = 0; i + 1 < refs.length; i++) this.machine.wires.push({ a: refs[i], b: refs[i + 1], gauge: numv(pr.gauge), color: str(pr.color), label: str(pr.label), span: s.span });
        return;
      }
      case "net": {
        if (this.machine.nets.some((n) => n.name === s.name)) throw new EvalError(`Net "${s.name}" is already defined: add the pins to it`, s.nameSpan);
        const pins = s.pins.map((e) => this.pinRef(e));
        const pr = this.machineProps(s.items, ["gauge", "color"], "net");
        this.machine.nets.push({ name: s.name, pins, gauge: numv(pr.gauge), color: str(pr.color), span: s.span });
        return;
      }
      case "firmware": {
        if (this.machine.firmware.some((f) => f.name === s.name)) throw new EvalError(`Firmware "${s.name}" is already defined`, s.nameSpan);
        const settings = this.machineProps(s.items, null, "firmware");
        const board = str(settings.board);
        if (board && !this.comps.has(board)) throw new EvalError(`firmware board: "${board}" is not a component`, s.span);
        this.machine.firmware.push({ name: s.name, board, settings, span: s.span });
        return;
      }
      case "test": {
        const v = this.expr(s.procedure, null);
        if (typeof v !== "string") throw new EvalError("A test needs a procedure in quotes: test \"Label\": \"what to do and what to measure\"", s.procedure.span);
        this.machine.tests.push({ label: s.label, procedure: v, span: s.span });
        return;
      }
      case "buy": {
        const pr = this.machineProps(s.items, ["qty", "price", "url", "search"], "buy");
        const url = str(pr.url);
        if (url !== undefined && !/^https?:\/\//.test(url)) throw new EvalError('url: should be a web address in quotes, e.g. url: "https://www.pololu.com/product/713"', s.span);
        this.machine.items.push({ name: s.label, label: s.label, qty: numv(pr.qty) ?? 1, price: numv(pr.price), buyUrl: str(pr.url), search: str(pr.search) ?? s.label, span: s.span });
        return;
      }
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
    if (o instanceof FeatRef) {
      const m = featMember(o, name);
      if (m !== undefined) return m;
      throw new EvalError(`Feature "${o.name}" has root, tip, edges, faces, convex and concave, not "${name}"`, span);
    }
    if (o instanceof SelV) {
      const m = selMember(o, name);
      if (m !== undefined) return m;
      throw new EvalError(`A selection has convex and concave, not "${name}"`, span);
    }
    if (o instanceof FeatureV) {
      if (name in o.info) return o.info[name];
      throw new EvalError(`${o.kind}() has ${Object.keys(o.info).join(", ")}, not "${name}"`, span);
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
    if (l instanceof ProfileV && r instanceof ProfileV && (op === "+" || op === "-")) {
      // a chain of additions copies the list each time: count it so long chains hit the step budget
      if (op === "+") {
        const ps = [...(l.recipe.t === "union2" ? l.recipe.ps : [l.recipe]), r.recipe];
        this.tick(ps.length, span);
        return new ProfileV({ t: "union2", ps });
      }
      const b = l.recipe.t === "diff2" ? [...l.recipe.b, r.recipe] : [r.recipe];
      this.tick(b.length, span);
      return new ProfileV(l.recipe.t === "diff2" ? { t: "diff2", a: l.recipe.a, b } : { t: "diff2", a: l.recipe, b });
    }
    if ((isSelValue(l) || isSelValue(r)) && (op === "+" || op === "-")) {
      const ctx = this.ctx();
      const saved = this.callSpan;
      this.callSpan = span;
      try {
        const a = toSel(l, ctx, "the left side");
        const b = toSel(r, ctx, "the right side");
        if (op === "-") return new SelV({ s: "minus", a, b });
        const any = [...(typeof a !== "string" && a.s === "or" ? a.a : [a]), b];
        this.tick(any.length, span);
        return new SelV({ s: "or", a: any });
      } finally {
        this.callSpan = saved;
      }
    }
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
    const pos: Value[] = [];
    const named: Record<string, Value> = {};
    for (const a of s.call.args) {
      const v = this.expr(a.value, null);
      if (v instanceof Pending) throw new EvalError("Component sizes cannot depend on measured geometry", a.span);
      if (a.name) named[a.name] = v;
      else pos.push(v);
    }
    // lib.connector("xt60_pair") is a catalog part; lib.connector(w: ...) the generic panel body
    const catalogForm = !!MACHINE_LIBRARY[key] && LIBRARY[key] !== MACHINE_LIBRARY[key] && typeof pos[0] === "string";
    // undefined for step(): an imported file has no library entry
    const entry: (typeof LIBRARY)[string] | undefined = catalogForm ? MACHINE_LIBRARY[key] : LIBRARY[key];
    const compProps = entry?.machine ? [...COMP_PROPS, ...MACHINE_PROPS] : COMP_PROPS;
    this.callSpan = s.call.span;
    const args = new Args(key === "step" ? "step" : `lib.${key}`, pos, named, this.ctx(), mergeParams((catalogForm ? undefined : POSITIONAL[key]) ?? entry?.positional ?? [], (catalogForm ? undefined : LIB_ARGS[key]) ?? entry?.params ?? []));

    // properties
    const props: Record<string, Value> = {};
    const flags = new Set<string>();
    const propSpans: Record<string, Span> = {};
    for (const it of s.items) {
      if (it.k === "prop") {
        if (!compProps.includes(it.name)) throw new EvalError(`Unknown component property "${it.name}". Use: ${compProps.join(", ")}`, it.span);
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
        def = entry!.make(libArgs, phase);
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
    if (def.catalog) {
      const cp = catalogPart(def.catalog.id);
      if (cp) {
        const load = props.load !== undefined ? this.num(props.load, propSpans.load, "load (torque at the output, N·mm)") : undefined;
        const price = props.price !== undefined ? this.num(props.price, propSpans.price, "price") : undefined;
        if (props.buy !== undefined && (typeof props.buy !== "string" || !/^https?:\/\//.test(props.buy))) throw new EvalError('buy: should be a web address in quotes, e.g. buy: "https://www.pololu.com/product/713"', propSpans.buy);
        if (props.role !== undefined && typeof props.role !== "string") throw new EvalError('role: should be text, e.g. role: "front screw"', propSpans.role);
        if (props.rating !== undefined && cp.kind !== "fuse") throw new EvalError("rating: is a fuse's rating in amps; only fuses take it", propSpans.rating);
        const rating = props.rating !== undefined ? this.num(props.rating, propSpans.rating, "rating (the fuse's rating, A)") : undefined;
        if (rating !== undefined && !(rating > 0)) throw new EvalError("rating: should be a current above zero, like 15A", propSpans.rating);
        this.machine.components.push({
          name: s.name,
          catalogId: cp.id,
          kind: cp.kind,
          label: typeof props.label === "string" ? props.label : cp.name,
          count: atList.length,
          role: typeof props.role === "string" ? props.role : undefined,
          load,
          length: def.catalog.length,
          buyUrl: typeof props.buy === "string" ? props.buy : undefined,
          price,
          rating,
          span: s.span,
        });
      }
    }

    if (this.opts.skipGeometry) return;
    const anyMoving = def.solids.some((sd) => sd.moving);
    const color = typeof props.color === "string" ? props.color : undefined;
    const group = typeof props.group === "string" ? props.group : def.catalog ? (groupForCatalog(def.catalog.id) ?? entry?.group ?? "Components") : (entry?.group ?? groupFor(key));
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
    const scope = new Scope();
    const state: PartState = {
      base: null,
      ops: [],
      props: {},
      propSpans: {},
      flags: new Set(),
      root: scope,
      cosmetic: false,
      feats: new Map(),
      auto: new Map(),
      strain: [],
    };
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
    const processSpan = state.propSpans.process;
    const process =
      state.props.process === undefined || state.props.process === null || state.props.process === false
        ? undefined
        : toProcess(state.props.process, (msg) => {
            throw new EvalError(msg, processSpan ?? s.span);
          });
    const material = partMaterial(typeof state.props.material === "string" ? state.props.material : undefined, process);
    const limit = allowableStrain(material);
    for (const c of state.strain) {
      if (c.strain > limit) {
        this.diags.push({
          message: `In part "${s.name}": this snap hook bends ${fmtNum(c.strain * 100, 1)}% at full deflection, more than the ~${fmtNum(limit * 100, 1)}% ${material} takes without cracking or creeping. Make it longer (strain falls with length²), thinner, or give it a shallower catch.`,
          start: c.span.start,
          end: c.span.end,
          severity: "warning",
          rule: `${s.name} snap hook strain`,
        });
      }
    }
    const recipe: PartRecipe = { base: state.base, ops: state.ops };
    if (state.baseName) recipe.baseName = state.baseName;
    this.parts.push({
      id: s.name,
      name: s.name,
      label: typeof state.props.label === "string" ? state.props.label : s.name,
      kind: "part",
      group: typeof state.props.group === "string" ? state.props.group : "Parts",
      color: typeof state.props.color === "string" ? state.props.color : DEFAULT_COLORS[this.colorIdx++ % DEFAULT_COLORS.length],
      material,
      finish: typeof state.props.finish === "string" ? state.props.finish : undefined,
      process,
      processSpan,
      ...(state.props.process === false ? { processNone: true } : {}),
      materialSpan: state.propSpans.material,
      recipe,
      hash: recipeHash(recipe),
      xf,
      locked: state.flags.has("locked"),
      hidden: state.flags.has("hidden"),
      removable: state.flags.has("removable"),
      span: s.span,
      deps: [],
      motion,
      features: [...state.feats].map(([name, f]) => ({ name, kind: f.kind, cosmetic: f.cosmetic })),
      detail: hasDetail(recipe),
    });
  }

  /** Register `as name` for an operation; returns the feature name to put in the recipe. */
  nameFeature(st: PartState, name: string, kind: string, span: Span): string {
    const prev = st.feats.get(name);
    if (prev) {
      // the same name again (often in a loop) adds more tools to the same feature
      if (!st.cosmetic) prev.cosmetic = false;
      return name;
    }
    if (this.globals.has(name) || this.builtins.has(name)) throw new EvalError(`"${name}" is already defined outside this part; give the feature another name`, span);
    if (st.root.vars.has(name)) throw new EvalError(`"${name}" is already used in this part`, span);
    st.feats.set(name, { kind, cosmetic: st.cosmetic });
    st.root.vars.set(name, new FeatRef(name, kind));
    return name;
  }

  /** Feature names a non-cosmetic step may not rely on (they are missing from fast builds). */
  checkSelFeatures(st: PartState, sel: Sel, span: Span) {
    if (st.cosmetic) return;
    for (const f of selFeatures(sel)) {
      if (st.feats.get(f)?.cosmetic) throw new EvalError(`"${f}" is cosmetic detail, so it is missing from fast builds. Move this step into the cosmetic { } block too.`, span);
    }
  }

  pushOp(st: PartState, op: PartOp, span: Span) {
    st.ops.push(st.cosmetic ? { ...op, cosmetic: true } : op);
    if (st.ops.length > 600) throw new EvalError("A part is limited to 600 operations", span);
  }

  items(items: Item[], scope: Scope, st: PartState, depth: number) {
    if (depth > 20) throw new EvalError("Blocks are nested too deeply", items[0]?.span ?? { start: 0, end: 0 });
    for (const it of items) {
      switch (it.k) {
        case "prop": {
          if (st.cosmetic) throw new EvalError("Properties belong outside the cosmetic { } block", it.span);
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
          const v = this.expr(it.shape, scope);
          const feats = flattenFeatures(v);
          if (feats) {
            if (it.op !== "add") throw new EvalError(`${feats[0].kind}() adds and cuts on its own: write add ${feats[0].kind}(...)`, it.span);
            if (!st.base) throw new EvalError(`${feats[0].kind}() needs a body to stand on; start the part with body ...`, it.span);
            for (const f of feats) {
              let name: string;
              if (it.name) name = this.nameFeature(st, it.name, f.kind, it.nameSpan ?? it.span);
              else {
                const k = (st.auto.get(f.kind) ?? 0) + 1;
                st.auto.set(f.kind, k);
                name = `${f.kind}#${k}`;
                st.feats.set(name, { kind: f.kind, cosmetic: st.cosmetic });
              }
              for (const step of f.steps) {
                if ("shape" in step) this.pushOp(st, { op: step.op, shape: step.shape, name }, it.span);
                else st.ops.push({ op: step.op, r: step.r, edges: { s: "feat", f: name, part: step.part }, cosmetic: true });
              }
              if (f.strain !== undefined) st.strain.push({ strain: f.strain, span: it.shape.span });
            }
            break;
          }
          const shapes = flattenShapes(v, it.shape.span);
          if (it.op === "body" && st.cosmetic) throw new EvalError("The body cannot be cosmetic; put body before the cosmetic { } block", it.span);
          for (const sh of shapes) {
            if (it.op === "body" || (it.op === "add" && !st.base)) {
              if (!st.base) {
                st.base = sh.recipe;
                if (it.name) st.baseName = this.nameFeature(st, it.name, "body", it.nameSpan ?? it.span);
              } else this.pushOp(st, { op: "add", shape: sh.recipe, name: it.name && this.nameFeature(st, it.name, "add", it.nameSpan ?? it.span) }, it.span);
            } else {
              if (!st.base) throw new EvalError(`"${it.op}" needs a body first (start the part with body ...)`, it.span);
              this.pushOp(st, { op: it.op, shape: sh.recipe, name: it.name && this.nameFeature(st, it.name, it.op, it.nameSpan ?? it.span) }, it.span);
            }
          }
          break;
        }
        case "cosmetic": {
          if (st.cosmetic) throw new EvalError("cosmetic { } blocks do not nest", it.span);
          st.cosmetic = true;
          try {
            this.items(it.body, new Scope(scope), st, depth + 1);
          } finally {
            st.cosmetic = false;
          }
          break;
        }
        case "modifier": {
          const callee = it.call.callee;
          if (callee.k !== "ident" || !(callee.name in MODIFIER_PARAMS)) {
            throw new EvalError("Only shell(), fillet(), chamfer() and draft() can be used as statements. Shapes need body/add/cut/intersect in front.", it.span);
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
          const ctx = this.ctx();
          const a = new Args(callee.name, pos, named, ctx, MODIFIER_PARAMS[callee.name]);
          if (callee.name === "shell") {
            const t = a.positive("t");
            const openV = a.value("open");
            let open: PartOp & { op: "shell" } extends { open: infer O } ? O : never;
            if (openV === undefined) open = [0, 0, 1];
            else if (openV instanceof Vec) open = a.dir("open");
            else {
              const list = Array.isArray(openV) ? openV : [openV];
              open = list.map((o, i): OpenSpec => {
                if (o instanceof Vec) return { dir: vnorm(o.v3()) };
                const sel = toSel(o, ctx, `shell(): open item ${i + 1}`);
                this.checkSelFeatures(st, sel, it.call.span);
                return { sel };
              });
            }
            this.pushOp(st, { op: "shell", t, open }, it.span);
          } else if (callee.name === "draft") {
            const angle = a.num("angle");
            if (Math.abs(angle) < 1e-6 || Math.abs(angle) > 30) ctx.error("draft(): angle must be between 0 and 30 degrees (1–3° is typical)");
            const faces = toSel(a.value("faces") ?? "vertical", ctx, "draft(): faces");
            this.checkSelFeatures(st, faces, it.call.span);
            this.pushOp(st, { op: "draft", angle, faces, pull: a.dir("pull", [0, 0, 1]), neutral: a.vec3("neutral", [0, 0, 0]) }, it.span);
          } else {
            const edges = toSel(a.value("edges") ?? "all", ctx, `${callee.name}(): edges`);
            this.checkSelFeatures(st, edges, it.call.span);
            this.pushOp(st, { op: callee.name as "fillet" | "chamfer", r: a.positive("r"), edges }, it.span);
          }
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
              case "tolerance":
                spec.tolerance = str(v, it.span, "tolerance");
                spec.toleranceSet = true;
                break;
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
              case "tol": {
                const t = tol();
                const fit = optStr("fit");
                if (!t && !fit) ctx().error('tol() needs a tolerance or a fit, e.g. tol("top:overall-width-x", 0.1)');
                spec.tols.push({ id: a.str("id"), tol: t, fit, span: it.call.span });
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
        if (n === "process") {
          // text, or a process value whose settings every part without its own process then takes
          const v = this.expr(it.value, null);
          if (v instanceof ProcessV) {
            b.process = specToSource(v.spec);
            b.processSpec = v.spec;
          } else if (typeof v === "string") {
            b.process = v;
            b.processSpec = processFromValue(v) ?? undefined;
          } else throw new EvalError(`process should be text like "FDM print", or a process like mfg.fdm(layer: 0.2)`, it.value.span);
        } else if ((BRIEF_TEXT as readonly string[]).includes(n)) {
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
      // calculators stand in 1e12 for "no limit" (a self-locking slot holds any moment)
      const shown = (n: number) => (Math.abs(n) >= 1e12 ? (n > 0 ? "∞" : "−∞") : fmtNum(n));
      return { ok, margin, detail: `${shown(ln)} ${sym} ${shown(rn)}` };
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
    const model: Model = {
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
      drawings: this.drawings,
      evalMs: 0,
      machine: hasMachine(this.machine) ? this.machine : undefined,
    };
    // the brief's "how it's made" is the default for every custom part
    const b = this.brief;
    if (b) applyDefaultProcess(model, b.processSpec ?? null, { buildVolume: b.buildVolume, material: b.material });
    return model;
  }
}

// ---------------- helpers ----------------

function hasMachine(m: MachineData): boolean {
  return m.components.length + m.wires.length + m.nets.length + m.calcs.length + m.firmware.length + m.tests.length + m.items.length > 0;
}

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

/** The ready-made features in a value (a feature or a list of them), or null when it holds none. */
function flattenFeatures(v: Value): FeatureV[] | null {
  if (v instanceof FeatureV) return [v];
  if (Array.isArray(v) && v.length && v.every((x) => x instanceof FeatureV)) return v as FeatureV[];
  return null;
}

function flattenShapes(v: Value, span: Span): ShapeV[] {
  if (v instanceof ShapeV) return [v];
  if (Array.isArray(v)) return v.flatMap((x) => flattenShapes(x, span));
  if (v instanceof ProfileV) throw new EvalError("This is a flat profile; turn it into a solid with extrude(), revolve(), sweep(), loft(), emboss() or engrave()", span);
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
