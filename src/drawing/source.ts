// Writing drawing changes back into the design source. An automatic drawing
// becomes a drawing block first, so every change from the drawing view is a
// plain source edit that the editor, undo, history and the assistant all see.

import type { Model } from "../core/model";
import { lex, type Token } from "../lang/lexer";
import type { V3 } from "../kernel/recipe";
import type { SheetDim } from "./sheet";
import type { DrawingSpec } from "./spec";
import { scaleText } from "./spec";

const num = (n: number) => {
  const r = Math.round(n * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
};
const vec = (v: V3) => `(${v.map(num).join(", ")})`;
const str = (s: string) => JSON.stringify(s);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Source text of a drawing block for a spec (an automatic drawing written out). */
export function specToSource(spec: DrawingSpec, name: string): string {
  const lines = [`drawing ${name} {`, `  title: ${str(spec.title)}`];
  if (spec.of.length) lines.push(`  of: ${spec.of.length === 1 ? spec.of[0] : `[${spec.of.join(", ")}]`}`);
  if (spec.sheet) lines.push(`  sheet: ${str(spec.sheet)}`);
  if (spec.scale) lines.push(`  scale: ${str(scaleText(spec.scale))}`);
  if (spec.projection !== "first") lines.push(`  projection: ${str(spec.projection)}`);
  if (spec.hidden !== undefined) lines.push(`  hidden_lines: ${spec.hidden}`);
  if (spec.flat) lines.push("  flat_pattern: true");
  if (spec.gdt !== undefined) lines.push(`  gdt: ${spec.gdt}`);
  lines.push(`  views: [${spec.views.map((v) => str(v.kind)).join(", ")}]`);
  for (const s of spec.sections) lines.push(`  section(${str(s.label)}, at: ${vec(s.at)}, normal: ${vec(s.normal)}${s.view ? `, view: ${str(s.view)}` : ""})`);
  for (const d of spec.details) lines.push(`  detail(${str(d.label)}, view: ${str(d.view)}, at: ${vec(d.at)}, r: ${num(d.r)}, scale: ${num(d.scale)})`);
  for (const t of spec.tols) {
    const fit = t.fit ? tolCall(t.id, { kind: "fit", code: t.fit }) : null;
    const call = fit ?? (t.tol ? tolCall(t.id, close(t.tol[0], -t.tol[1]) ? { kind: "pm", t: t.tol[0] } : { kind: "limits", upper: t.tol[0], lower: t.tol[1] }) : null);
    if (call) lines.push(`  ${call}`);
  }
  for (const g of spec.frames ?? []) lines.push(`  gdt(${str(g.id)}, ${str(g.kind)}, ${num(g.tol)}${g.datums.length ? `, ${str(g.datums.join(" "))}` : ""}${g.mmc ? ", mmc: true" : ""})`);
  for (const n of spec.notes) lines.push(`  note(${str(n)})`);
  lines.push("}");
  return lines.join("\n");
}

/** A block name for an automatic drawing that is free in the design. */
export function blockNameFor(spec: DrawingSpec, model: Model): string {
  const base = `${(spec.name.startsWith("auto:") ? spec.name.slice(5) : spec.name).replace(/[^A-Za-z0-9_]/g, "_")}_drawing`;
  const taken = new Set([...model.drawings.map((d) => d.name), ...model.parts.map((p) => p.name), ...model.params.map((p) => p.name)]);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** The source with this drawing as a block; automatic drawings are appended. */
export function ensureBlock(src: string, model: Model, spec: DrawingSpec): { src: string; name: string; created: boolean } {
  if (!spec.auto) return { src, name: spec.name, created: false };
  const name = blockNameFor(spec, model);
  const sep = src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : "\n\n";
  return { src: `${src}${sep}${specToSource(spec, name)}\n`, name, created: true };
}

/**
 * Start and end offsets of a drawing block in the source, found by name with
 * the language's own lexer, so braces in strings and comments don't count.
 * The start is the beginning of the block's line. Null when the block isn't
 * there or the source doesn't lex.
 */
export function blockRange(src: string, name: string): { start: number; end: number } | null {
  let tokens: Token[];
  try {
    tokens = lex(src);
  } catch {
    return null;
  }
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [kw, id, open] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (kw.kind !== "ident" || kw.value !== "drawing" || id.kind !== "ident" || id.value !== name || open.kind !== "op" || open.value !== "{") continue;
    // a drawing block starts its line, as the parser requires
    const lineStart = src.lastIndexOf("\n", kw.start - 1) + 1;
    if (src.slice(lineStart, kw.start).trim()) continue;
    let depth = 0;
    for (let k = i + 2; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.kind !== "op") continue;
      if (t.value === "{") depth++;
      else if (t.value === "}" && --depth === 0) return { start: lineStart, end: t.end };
    }
    return null;
  }
  return null;
}

/** Sets a property line in a drawing block, replacing it or adding it after the title. */
export function setBlockProp(src: string, name: string, prop: string, value: string): string {
  const r = blockRange(src, name);
  if (!r) return src;
  const block = src.slice(r.start, r.end);
  const line = new RegExp(`\\n([ \\t]*)${prop}[ \\t]*:[^\\n]*`);
  let next: string;
  if (line.test(block)) next = block.replace(line, (_m, ind: string) => `\n${ind}${prop}: ${value}`);
  else {
    const at = block.search(/\n[ \t]*title[ \t]*:[^\n]*/);
    const end = at >= 0 ? block.indexOf("\n", at + 1) : block.indexOf("{") + 1;
    const cut = end < 0 ? block.length - 1 : end;
    next = `${block.slice(0, cut)}\n  ${prop}: ${value}${block.slice(cut)}`;
  }
  return src.slice(0, r.start) + next + src.slice(r.end);
}

/** Adds a statement at the end of a drawing block. */
export function addBlockLine(src: string, name: string, line: string): string {
  const r = blockRange(src, name);
  if (!r) return src;
  const close = r.end - 1;
  const before = src.slice(0, close).replace(/[ \t]*$/, "");
  return `${before}${before.endsWith("\n") ? "" : "\n"}  ${line}\n${src.slice(close)}`;
}

/** Sets (or with null removes) a named argument in a call's source text. */
export function setCallArg(call: string, arg: string, value: string | null): string {
  const re = new RegExp(`,\\s*${arg}\\s*:\\s*(\\([^)]*\\)|"[^"]*"|[^,)]+)`);
  const without = call.replace(re, "");
  if (value === null) return without;
  const close = without.lastIndexOf(")");
  return `${without.slice(0, close)}, ${arg}: ${value}${without.slice(close)}`;
}

/** A tolerance as source: ±t, (upper, lower) or a fit code. */
export type TolEdit = { kind: "none" } | { kind: "pm"; t: number } | { kind: "limits"; upper: number; lower: number } | { kind: "fit"; code: string };

function tolArgs(call: string, t: TolEdit): string {
  let c = setCallArg(setCallArg(call, "tol", null), "fit", null);
  if (t.kind === "pm") c = setCallArg(c, "tol", num(Math.abs(t.t)));
  else if (t.kind === "limits") c = setCallArg(c, "tol", `(${num(t.upper)}, ${num(t.lower)})`);
  else if (t.kind === "fit") c = setCallArg(c, "fit", str(t.code));
  return c;
}

/** A tol() call giving an automatic dimension a tolerance, or null for none. */
export function tolCall(id: string, t: TolEdit): string | null {
  if (t.kind === "pm") return `tol(${str(id)}, ${num(Math.abs(t.t))})`;
  if (t.kind === "limits") return `tol(${str(id)}, (${num(t.upper)}, ${num(t.lower)}))`;
  if (t.kind === "fit") return `tol(${str(id)}, fit: ${str(t.code)})`;
  return null;
}

/** The source without the line holding [start, end), or just the range when the line holds more. */
function cutStatement(src: string, start: number, end: number): string {
  const ls = src.lastIndexOf("\n", start - 1) + 1;
  const le = src.indexOf("\n", end);
  const lineEnd = le < 0 ? src.length : le;
  if (src.slice(ls, start).trim() || src.slice(end, lineEnd).trim()) return src.slice(0, start) + src.slice(end);
  return src.slice(0, ls) + src.slice(lineEnd < src.length ? lineEnd + 1 : lineEnd);
}

/**
 * The source after giving a dimension a tolerance. A dimension written in the
 * block has its own call edited; an automatic one gets a tol() line naming its
 * id, so the tolerance stays with it when the design changes.
 */
export function setDimTolerance(src: string, block: string, dim: SheetDim, viewName: string, t: TolEdit): string {
  if (dim.span) {
    const call = src.slice(dim.span.start, dim.span.end);
    if (/^\s*(dim|diameter)\s*\(/.test(call)) return src.slice(0, dim.span.start) + tolArgs(call, t) + src.slice(dim.span.end);
    if (/^\s*tol\s*\(/.test(call) && dim.id) {
      const next = tolCall(dim.id, t);
      return next ? src.slice(0, dim.span.start) + next + src.slice(dim.span.end) : cutStatement(src, dim.span.start, dim.span.end);
    }
  }
  if (dim.auto && dim.id) {
    const call = tolCall(dim.id, t);
    return call ? addBlockLine(src, block, call) : src;
  }
  if (t.kind === "none") return src;
  const call = dimCall(dim, viewName);
  if (!call) return src;
  return addBlockLine(src, block, tolArgs(call, t));
}

/** A dim() or diameter() call reproducing a dimension on the sheet. */
export function dimCall(dim: SheetDim, viewName: string): string | null {
  if (!dim.a) return null;
  if (dim.kind === "linear" && dim.b) return `dim(${vec(dim.a)}, ${vec(dim.b)}, view: ${str(viewName)}${dim.align && dim.align !== "aligned" ? `, align: ${str(dim.align)}` : ""})`;
  if (dim.kind === "callout" || dim.kind === "diameter") return `diameter(${vec(dim.a)}, ${num(dim.value)}, view: ${str(viewName)})`;
  return null;
}
