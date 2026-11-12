// The feature tree: the steps a part is built from, read straight off its
// source (body, adds, cuts, fillets, shells, loops), with the plain edits a
// CAD feature tree offers: change a value, suppress a step, move it up or
// down, delete it, roll the part back to a step, and pattern or mirror a
// step. Everything is a text edit on the design source, so undo, history and
// Claude need nothing extra. Nothing here calls Claude.

import type { Arg, Expr, Item, Span, Stmt } from "../lang/ast";
import { parse } from "../lang/parser";
import { MODIFIER_PARAMS, SHAPE_FNS, MATH_FNS } from "../lang/builtins";
import { MODELLING_FNS } from "../lang/modelling";
import { fmtNum } from "../lang/values";
import type { Model } from "./model";

export type StepKind = "body" | "add" | "cut" | "intersect" | "modifier" | "repeat" | "choice" | "let" | "cosmetic" | "place" | "library";

/** One value of a step that can be typed over, such as a fillet's radius or a hole's position. */
export interface StepField {
  /** the argument's name (positional ones are named from the function's signature) */
  label: string;
  /** the value as written */
  text: string;
  span: Span;
  /** the function the argument belongs to, when it is not the step's own (hole inside move()) */
  of?: string;
}

export interface Step {
  /** position among the part's items (props included), for edits */
  index: number;
  kind: StepKind;
  title: string;
  /** the main function the step calls (hole, fillet, extrude…), for its icon */
  fn?: string;
  span: Span;
  /** wrapped in `if false { }`: kept in the source but left out of the build */
  suppressed: boolean;
  fields: StepField[];
  /** `as name` */
  name?: string;
  /** the step can move up or down, be suppressed or deleted */
  editable: boolean;
  /** an add or cut that can be patterned or mirrored */
  repeatable: boolean;
}

export interface PartSteps {
  block: string;
  kind: "part" | "component";
  span: Span;
  steps: Step[];
}

type PartStmt = Extract<Stmt, { k: "part" }>;
type CompStmt = Extract<Stmt, { k: "component" }>;

// ---------------------------------------------------------------------------
// Function signatures, for naming positional arguments

let SIGS: Map<string, string[]> | null = null;
/** Signatures the docs give in a form the reader below can't use (revolve takes points or a profile). */
const SIG_OVERRIDES: Record<string, string[]> = {
  revolve: ["profile", "at", "axis", "angle", "rot", "dir"],
};

/** Positional argument names of a function, from its documented signature ("box(w, d, h, at: …)"). */
export function signatureOf(fn: string): string[] {
  if (!SIGS) {
    SIGS = new Map(Object.entries({ ...MODIFIER_PARAMS, ...SIG_OVERRIDES }));
    for (const [name, f] of Object.entries({
      ...MATH_FNS,
      ...SHAPE_FNS,
      ...MODELLING_FNS,
    })) {
      if (SIGS.has(name) || !f.doc) continue;
      const open = f.doc.indexOf("(");
      if (open < 0) continue;
      let depth = 0;
      let close = -1;
      for (let i = open; i < f.doc.length; i++) {
        const c = f.doc[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          depth--;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      if (close < 0) continue;
      const inner = f.doc.slice(open + 1, close);
      const names: string[] = [];
      depth = 0;
      let cur = "";
      for (const c of inner + ",") {
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        if (c === "," && depth === 0) {
          const m = /^\s*([a-z_][a-z0-9_]*)/i.exec(cur);
          if (m) names.push(m[1]);
          cur = "";
        } else cur += c;
      }
      SIGS.set(name, names);
    }
  }
  return SIGS.get(fn) ?? [];
}

// ---------------------------------------------------------------------------
// Reading the steps

const calleeName = (e: Expr): string | undefined => (e.k === "call" ? (e.callee.k === "ident" ? e.callee.name : e.callee.k === "member" ? e.callee.name : undefined) : undefined);

/** Functions that place or copy another shape; the step is about the shape inside them. */
const WRAPPERS = new Set(["move", "rotate", "mirror"]);

const LABELS: Record<string, string> = {
  box: "Box",
  cylinder: "Cylinder",
  tube: "Tube",
  cone: "Cone",
  sphere: "Sphere",
  prism: "Prism",
  rrect: "Rounded rectangle",
  slot: "Slot",
  hole: "Hole",
  gear: "Gear",
  flight: "Screw flight",
  extrude: "Extrude",
  revolve: "Revolve",
  sweep: "Sweep",
  pipe: "Pipe",
  loft: "Loft",
  thread: "Thread",
  knurl: "Knurl",
  emboss: "Emboss",
  engrave: "Engrave",
  rib: "Rib",
  gusset: "Gusset",
  oring_groove: "O-ring groove",
  screw_boss: "Screw boss",
  snap_hook: "Snap hook",
  flexure: "Flexure",
  union: "Shapes",
  sheet: "Sheet",
  flange: "Flange",
  mould: "Mould half",
  shape_of: "Copy of",
  aero_tube: "Aero tube",
  aero_path: "Aero tube",
  fillet: "Fillet",
  chamfer: "Chamfer",
  shell: "Shell",
  draft: "Draft",
};

const label = (fn: string) => LABELS[fn] ?? fn.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function short(text: string, max = 22): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The argument with this name, or the positional one in that slot. */
function argOf(call: Extract<Expr, { k: "call" }>, name: string, fn: string): Arg | undefined {
  const named = call.args.find((a) => a.name === name);
  if (named) return named;
  const sig = signatureOf(fn);
  const at = sig.indexOf(name);
  if (at < 0) return undefined;
  const pos = call.args.filter((a) => !a.name);
  return pos[at];
}

/** A few words for a shape expression: "Hole M3 through", "Box 40 × 30 × 10". */
function describeShape(e: Expr, src: string): string {
  const text = (x: Expr | undefined) => (x ? src.slice(x.span.start, x.span.end) : "");
  if (e.k === "list") return e.items.map((x) => describeShape(x, src)).join(" + ");
  if (e.k !== "call") return short(text(e), 28);
  const fn = calleeName(e) ?? "";
  const a = (n: string) => argOf(e, n, fn)?.value;
  const t = (n: string) => short(text(a(n)), 14);
  switch (fn) {
    case "move":
      return `${describeShape(a("shape") ?? e.args[0].value, src)}, moved`;
    case "rotate":
      return `${describeShape(a("shape") ?? e.args[0].value, src)}, turned`;
    case "mirror":
      return `Mirror of ${describeShape(a("shape") ?? e.args[0].value, src).replace(/^./, (c) => c.toLowerCase())}`;
    case "shape_of":
      return `Copy of ${t("part")}`;
    case "box":
      return [a("w"), a("d"), a("h")].every(Boolean) ? `Box ${t("w")} × ${t("d")} × ${t("h")}` : "Box";
    case "cylinder":
    case "tube":
    case "cone": {
      const d = a("d") ?? a("od") ?? a("d1");
      return `${label(fn)}${d ? ` ⌀${short(text(d), 12)}` : ""}${a("h") ? ` × ${t("h")}` : ""}`;
    }
    case "sphere":
      return `Sphere${a("d") ? ` ⌀${t("d")}` : ""}`;
    case "hole": {
      const fit = a("fit");
      const deep = a("depth");
      const through = a("through");
      return `Hole ${t("d")}${fit ? ` ${short(text(fit).replace(/"/g, ""), 10)}` : ""}${through && text(through) === "true" ? " through" : deep ? ` ${short(text(deep), 10)} deep` : ""}`;
    }
    case "extrude":
    case "revolve": {
      const first = e.args.find((x) => !x.name)?.value;
      const what = first && first.k === "ident" ? first.name : null;
      return fn === "extrude" ? (what ? `Extrusion of ${what}` : "Extrusion") : what ? `Revolved ${what}` : "Revolve";
    }
    default:
      return label(fn);
  }
}

/** The fields of a call (and of the shape inside a move/rotate/mirror around it). */
/** The design's own features and functions by name, with their parameters, while a part's steps are read. */
let OWN_SIGS = new Map<string, string[]>();

function fieldsOf(call: Extract<Expr, { k: "call" }>, src: string, depth = 0, of?: string): StepField[] {
  const fn = calleeName(call) ?? "";
  const sig = OWN_SIGS.get(fn) ?? signatureOf(fn);
  const out: StepField[] = [];
  let pos = 0;
  const inner: StepField[] = [];
  for (const a of call.args) {
    const name = a.name ?? sig[pos++] ?? `#${pos}`;
    // the shape a wrapper moves is listed as its own fields
    if (depth < 3 && a.value.k === "call" && (WRAPPERS.has(fn) || fn === "union") && (name === "shape" || !a.name)) {
      inner.push(...fieldsOf(a.value, src, depth + 1, calleeName(a.value)));
      continue;
    }
    out.push({
      label: name,
      text: src.slice(a.value.span.start, a.value.span.end),
      span: a.value.span,
      ...(of && depth ? { of } : {}),
    });
  }
  return [...inner, ...out];
}

type IfItem = Extract<Item, { k: "if" }>;
const isSuppressed = (it: Item): boolean => it.k === "if" && it.cond.k === "bool" && !it.cond.v && !it.else && it.then.length > 0;

function stepOf(it: Item, index: number, src: string, suppressed = false): Step | null {
  const text = (x: { span: Span }) => src.slice(x.span.start, x.span.end);
  switch (it.k) {
    case "prop":
    case "flag":
      return null;
    case "op": {
      const word = it.op === "body" ? "" : it.op === "add" ? "Add " : it.op === "cut" ? "Cut " : "Keep only ";
      const what = describeShape(it.shape, src);
      const fn = it.shape.k === "call" ? innerFn(it.shape) : undefined;
      return {
        index,
        kind: it.op,
        title: `${word}${it.op === "body" ? what : what.replace(/^./, (c) => c.toLowerCase())}${it.name ? ` (${it.name})` : ""}`,
        fn,
        span: it.span,
        suppressed,
        fields: it.shape.k === "call" ? fieldsOf(it.shape, src) : [{ label: "shape", text: text(it.shape), span: it.shape.span }],
        name: it.name,
        editable: it.op !== "body",
        repeatable: it.op === "add" || it.op === "cut",
      };
    }
    case "modifier": {
      const fn = calleeName(it.call) ?? "step";
      const a = (n: string) => argOf(it.call, n, fn)?.value;
      const t = (n: string) => short(a(n) ? text(a(n)!) : "", 16).replace(/"/g, "");
      let title = label(fn);
      if (fn === "fillet" || fn === "chamfer") title += `${a("r") ? ` ${t("r")}` : ""}${a("edges") ? ` · ${t("edges")}` : " · all edges"}`;
      else if (fn === "shell") title += `${a("t") ? ` ${t("t")}` : ""}${a("open") ? ` · open ${t("open")}` : ""}`;
      else if (fn === "draft") title += a("angle") ? ` ${t("angle")}°` : "";
      else if (fn === "full_round") title += a("faces") ? ` · ${t("faces")}` : "";
      return {
        index,
        kind: "modifier",
        title,
        fn,
        span: it.span,
        suppressed,
        fields: fieldsOf(it.call, src),
        ...(it.name ? { name: it.name } : {}),
        editable: true,
        repeatable: false,
      };
    }
    case "for": {
      const body = it.body.map((b, i) => stepOf(b, i, src)).filter((s): s is Step => !!s);
      const iter = it.iter;
      const count = iter.k === "call" && calleeName(iter) === "range" && iter.args.length === 1 ? text(iter.args[0].value) : null;
      const inner = body.length === 1 ? body[0] : null;
      const kindWord = inner && inner.fields.some((f) => f.label === "angle") && /rotate\(/.test(text(it)) ? "round" : "in a row";
      const title = inner ? `${inner.title} × ${count ?? `each ${it.varName} in ${short(text(iter), 16)}`}${count ? ` ${kindWord}` : ""}` : `Repeat for each ${it.varName} in ${short(text(iter), 18)} (${body.length} steps)`;
      const fields: StepField[] = [];
      if (count && iter.k === "call")
        fields.push({
          label: "count",
          text: count,
          span: iter.args[0].value.span,
        });
      else
        fields.push({
          label: `${it.varName} in`,
          text: text(iter),
          span: iter.span,
        });
      if (inner) fields.push(...inner.fields);
      return {
        index,
        kind: "repeat",
        title,
        fn: inner?.fn,
        span: it.span,
        suppressed,
        fields,
        editable: true,
        repeatable: false,
      };
    }
    case "if": {
      if (isSuppressed(it)) {
        const inner = it.then.length === 1 ? stepOf(it.then[0], index, src, true) : null;
        if (inner)
          return {
            ...inner,
            span: it.span,
            suppressed: true,
            editable: true,
            repeatable: false,
          };
        return {
          index,
          kind: "choice",
          title: `${it.then.length} steps`,
          span: it.span,
          suppressed: true,
          fields: [],
          editable: true,
          repeatable: false,
        };
      }
      return {
        index,
        kind: "choice",
        title: `Only if ${short(text(it.cond), 24)}`,
        span: it.span,
        suppressed,
        fields: [{ label: "if", text: text(it.cond), span: it.cond.span }],
        editable: true,
        repeatable: false,
      };
    }
    case "let": {
      const v = it.value;
      const what = v.k === "call" ? describeShape(v, src) : short(text(v), 24);
      return {
        index,
        kind: "let",
        title: `${it.name} = ${what}`,
        fn: v.k === "call" ? innerFn(v) : undefined,
        span: it.span,
        suppressed,
        fields: v.k === "call" ? fieldsOf(v, src) : [{ label: it.name, text: text(v), span: v.span }],
        editable: true,
        repeatable: false,
      };
    }
    case "cosmetic":
      return {
        index,
        kind: "cosmetic",
        title: `Fine detail (${it.body.length} step${it.body.length === 1 ? "" : "s"}, full-quality builds only)`,
        span: it.span,
        suppressed,
        fields: [],
        editable: true,
        repeatable: false,
      };
  }
}

/** The function a shape really is, inside any move/rotate/mirror around it. */
function innerFn(e: Extract<Expr, { k: "call" }>): string | undefined {
  const fn = calleeName(e);
  if (fn && WRAPPERS.has(fn) && e.args[0]?.value.k === "call") return innerFn(e.args[0].value);
  return fn;
}

function blockOf(src: string, block: string): PartStmt | CompStmt | undefined {
  const { program } = parse(src);
  return program.stmts.find((s): s is PartStmt | CompStmt => (s.k === "part" || s.k === "component") && s.name === block);
}

/** The steps of a part (or the library call of a component), in build order, with its placement last. */
export function partSteps(src: string, block: string): PartSteps | null {
  const { program } = parse(src);
  const stmt = program.stmts.find((s): s is PartStmt | CompStmt => (s.k === "part" || s.k === "component") && s.name === block);
  if (!stmt) return null;
  // a use of the design's own feature names its values by the feature's parameters
  const own = new Map<string, string[]>();
  for (const s of program.stmts) if (s.k === "feature" || s.k === "fn") own.set(s.name, s.params.map((p) => p.name));
  const saved = OWN_SIGS;
  OWN_SIGS = own;
  try {
    return readSteps(src, block, stmt);
  } finally {
    OWN_SIGS = saved;
  }
}

function readSteps(src: string, block: string, stmt: PartStmt | CompStmt): PartSteps {
  const steps: Step[] = [];
  if (stmt.k === "component") {
    const fn = calleeName(stmt.call) ?? "part";
    steps.push({
      index: -1,
      kind: "library",
      title: `Library part: ${fn.replace(/_/g, " ")}`,
      fn,
      span: stmt.call.span,
      suppressed: false,
      fields: fieldsOf(stmt.call, src),
      editable: false,
      repeatable: false,
    });
  }
  stmt.items.forEach((it, i) => {
    const s = stepOf(it, i, src);
    if (s) steps.push(s);
  });
  const place = stmt.items.filter((it): it is Extract<Item, { k: "prop" }> => it.k === "prop" && (it.name === "at" || it.name === "rotate" || it.name === "facing" || it.name === "axis"));
  if (place.length) {
    const at = place.find((p) => p.name === "at");
    steps.push({
      index: stmt.items.indexOf(place[0]),
      kind: "place",
      title: at ? `Placed at ${short(src.slice(at.value.span.start, at.value.span.end), 26)}` : "Placed",
      span: {
        start: place[0].span.start,
        end: place[place.length - 1].span.end,
      },
      suppressed: false,
      fields: place.map((p) => ({
        label: p.name,
        text: src.slice(p.value.span.start, p.value.span.end),
        span: p.value.span,
      })),
      editable: false,
      repeatable: false,
    });
  }
  return { block, kind: stmt.k, span: stmt.span, steps };
}

/** Every part and component of the design, in source order. */
export function designSteps(src: string, model: Model | null): PartSteps[] {
  const names = [...new Set((model?.parts ?? []).map((p) => p.name))];
  return names
    .map((n) => partSteps(src, n))
    .filter((p): p is PartSteps => !!p)
    .sort((a, b) => a.span.start - b.span.start);
}

// ---------------------------------------------------------------------------
// Edits

export type StepEdit = { ok: true; src: string; title: string } | { ok: false; why: string };

const ok = (src: string, title: string): StepEdit => ({ ok: true, src, title });
const no = (why: string): StepEdit => ({ ok: false, why });

function itemAt(src: string, block: string, index: number): { stmt: PartStmt | CompStmt; item: Item } | null {
  const stmt = blockOf(src, block);
  const item = stmt?.items[index];
  return stmt && item ? { stmt, item } : null;
}

/** Type a new value over one field of a step. */
export function setField(src: string, field: Pick<StepField, "span" | "label">, text: string): StepEdit {
  const t = text.trim();
  if (!t) return no("Type a value.");
  const next = src.slice(0, field.span.start) + t + src.slice(field.span.end);
  if (parse(next).diagnostics.some((d) => d.severity === "error")) return no(`“${short(t, 30)}” isn't a value Kerf can read.`);
  return ok(next, `Set ${field.label} to ${short(t, 30)}`);
}

/** Leave a step out of the build without deleting it (wraps it in `if false { }`), or bring it back. */
export function toggleSuppress(src: string, block: string, index: number): StepEdit {
  const at = itemAt(src, block, index);
  if (!at) return no("That step is gone; the design changed.");
  const { item } = at;
  if (isSuppressed(item)) {
    const then = (item as IfItem).then;
    const first = then[0].span.start;
    const last = then[then.length - 1].span.end;
    return ok(src.slice(0, item.span.start) + src.slice(first, last) + src.slice(item.span.end), "Brought a step back");
  }
  if (item.k === "prop" || item.k === "flag") return no("Properties can't be suppressed.");
  if (item.k === "op" && item.op === "body") return no("The body is what the part starts from, so it can't be left out. Delete the part instead.");
  return ok(src.slice(0, item.span.start) + `if false { ${src.slice(item.span.start, item.span.end)} }` + src.slice(item.span.end), "Suppressed a step");
}

const isBody = (it: Item) => it.k === "op" && it.op === "body";
const isStep = (it: Item) => it.k !== "prop" && it.k !== "flag";

/** Swap a step with the one above (-1) or below (+1). Nothing goes above the body. */
export function moveStep(src: string, block: string, index: number, dir: -1 | 1): StepEdit {
  const at = itemAt(src, block, index);
  if (!at) return no("That step is gone; the design changed.");
  const { stmt, item } = at;
  if (isBody(item)) return no("The body comes first: everything else is built on it.");
  let j = index + dir;
  while (j >= 0 && j < stmt.items.length && !isStep(stmt.items[j])) j += dir;
  const other = stmt.items[j];
  if (!other) return no(dir < 0 ? "It is already the first step." : "It is already the last step.");
  if (isBody(other)) return no("Nothing goes before the body: everything else is built on it.");
  const [a, b] = dir < 0 ? [other, item] : [item, other];
  const ta = src.slice(a.span.start, a.span.end);
  const tb = src.slice(b.span.start, b.span.end);
  const next = src.slice(0, a.span.start) + tb + src.slice(a.span.end, b.span.start) + ta + src.slice(b.span.end);
  return ok(next, dir < 0 ? "Moved a step earlier" : "Moved a step later");
}

/** Delete a step: its whole lines when it has them to itself. Refused when later steps use its name. */
export function deleteStep(src: string, block: string, index: number): StepEdit {
  const at = itemAt(src, block, index);
  if (!at) return no("That step is gone; the design changed.");
  const { stmt, item } = at;
  if (isBody(item)) return no("The body is what the part starts from. Delete the whole part instead (Delete in the modelling tools).");
  const name = item.k === "op" ? item.name : item.k === "let" ? item.name : undefined;
  if (name) {
    const rest = (src.slice(stmt.span.start, item.span.start) + src.slice(item.span.end, stmt.span.end)).replace(/\/\/[^\n]*/g, "");
    if (new RegExp(`\\b${name}\\b`).test(rest)) return no(`Other steps use “${name}”, so change them first.`);
  }
  const lineStart = src.lastIndexOf("\n", item.span.start - 1) + 1;
  let lineEnd = src.indexOf("\n", item.span.end);
  if (lineEnd < 0) lineEnd = src.length;
  const before = src.slice(lineStart, item.span.start);
  const after = src.slice(item.span.end, lineEnd);
  let next: string;
  if (/^\s*$/.test(before) && /^\s*(\/\/.*)?$/.test(after)) next = src.slice(0, lineStart) + src.slice(Math.min(src.length, lineEnd + 1));
  else {
    // shares its line with other steps: take it and one separator
    const semiAfter = /^\s*;/.exec(after);
    const end = semiAfter ? item.span.end + semiAfter[0].length : item.span.end;
    const semiBefore = !semiAfter ? /;\s*$/.exec(before) : null;
    const start = semiBefore ? item.span.start - semiBefore[0].length : item.span.start;
    next = src.slice(0, start) + src.slice(end);
  }
  return ok(next, "Deleted a step");
}

/** The design with every step of the part after `index` suppressed: the part as it was at that step, for a preview. */
export function rollbackTo(src: string, block: string, index: number): string | null {
  const stmt = blockOf(src, block);
  if (!stmt) return null;
  const later = stmt.items.filter((it, i) => i > index && isStep(it) && !isSuppressed(it) && !isBody(it));
  let out = src;
  for (const it of [...later].reverse()) out = out.slice(0, it.span.start) + `if false { ${out.slice(it.span.start, it.span.end)} }` + out.slice(it.span.end);
  return out;
}

export type Axis = "X" | "Y" | "Z";
export type PatternSpec =
  | { kind: "line"; count: number; step: [number, number, number] }
  | {
      kind: "round";
      count: number;
      angle: number;
      axis: Axis;
      center: [number, number, number];
    };

const n = (v: number) => fmtNum(Math.abs(v) < 1e-9 ? 0 : v, 3);
const vecText = (v: number[]) => `(${v.map(n).join(", ")})`;

/** A loop variable the step's own text doesn't use. */
function loopVar(text: string): string {
  return ["i", "j", "k", "copy_i"].find((v) => !new RegExp(`\\b${v}\\b`).test(text))!;
}

/** Repeat an add or cut: in a row (step apart) or round an axis (spread over angle). The original stays the first copy. */
export function patternStep(src: string, block: string, index: number, spec: PatternSpec): StepEdit {
  const at = itemAt(src, block, index);
  if (!at) return no("That step is gone; the design changed.");
  const { item } = at;
  if (item.k !== "op" || (item.op !== "add" && item.op !== "cut")) return no("Only adds and cuts can be patterned.");
  const count = Math.round(spec.count);
  if (!(count >= 2 && count <= 200)) return no("A pattern has 2 to 200 copies.");
  const shape = src.slice(item.shape.span.start, item.shape.span.end);
  const v = loopVar(shape);
  let placed: string;
  let title: string;
  if (spec.kind === "line") {
    if (spec.step.every((x) => Math.abs(x) < 1e-9)) return no("Give the spacing between copies.");
    placed = `move(${shape}, by: (${spec.step.map((x) => (Math.abs(x) < 1e-9 ? "0" : `${v} * ${n(x)}`)).join(", ")}))`;
    title = `Patterned a step ${count} times in a row, ${n(Math.hypot(...spec.step))} mm apart`;
  } else {
    if (!(Math.abs(spec.angle) > 1e-9 && Math.abs(spec.angle) <= 360)) return no("Give the angle to spread the copies over (360 for all the way round).");
    const full = Math.abs(Math.abs(spec.angle) - 360) < 1e-9;
    const each = spec.angle / (full ? count : count - 1);
    placed = `rotate(${shape}, ${v} * ${n(each)}, axis: ${spec.axis}, origin: ${vecText(spec.center)})`;
    title = `Patterned a step ${count} times round ${spec.axis}, ${n(each)}° apart`;
  }
  const op = `${item.op} ${placed}${item.name ? ` as ${item.name}` : ""}`;
  return ok(src.slice(0, item.span.start) + `for ${v} in range(${count}) { ${op} }` + src.slice(item.span.end), title);
}

/** Mirror an add or cut across a plane (normal along axis, through `at` along it), keeping both. Linked: change one, both follow. */
export function mirrorStep(src: string, block: string, index: number, axis: Axis, offset = 0): StepEdit {
  const at = itemAt(src, block, index);
  if (!at) return no("That step is gone; the design changed.");
  const { item } = at;
  if (item.k !== "op" || (item.op !== "add" && item.op !== "cut")) return no("Only adds and cuts can be mirrored.");
  const shape = src.slice(item.shape.span.start, item.shape.span.end);
  const base = (item.shape.k === "call" ? innerFn(item.shape) : undefined) ?? "shape";
  const name = freshWord(src, `${base}_`);
  const point = [0, 0, 0];
  point["XYZ".indexOf(axis)] = offset;
  const lineStart = src.lastIndexOf("\n", item.span.start - 1) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
  const ownLine = /^\s*$/.test(src.slice(lineStart, item.span.start));
  const text = `let ${name} = ${shape}${ownLine ? `\n${indent}` : "; "}${item.op} [${name}, mirror(${name}, normal: ${axis}, at: ${vecText(point)})]${item.name ? ` as ${item.name}` : ""}`;
  return ok(src.slice(0, item.span.start) + text + src.slice(item.span.end), `Mirrored a step across the ${axis === "X" ? "YZ" : axis === "Y" ? "XZ" : "XY"} plane`);
}

/** base1, base2… a word nothing in the source uses yet. */
export function freshWord(src: string, base: string): string {
  for (let i = 1; ; i++) if (!new RegExp(`\\b${base}${i}\\b`).test(src)) return `${base}${i}`;
}
