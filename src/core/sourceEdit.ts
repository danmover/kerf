// Text-level edits on design source. Every change, from the editor, the
// parameter panel, the viewport or the AI, ends up as an edit to this text.

import type { EvalParam, Model } from "./model";
import { fmtNum } from "../lang/values";
import { parse } from "../lang/parser";

const KEEP_UNITS = new Set(["", "mm", "deg", "g", "N", "rpm"]);
const BASE_UNIT: Record<string, string> = { cm: "mm", m: "mm", in: "mm", rad: "deg", kg: "g", Nm: "Nm", "%": "" };

export function formatParamValue(p: EvalParam, value: number | string | boolean): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = p.text.trim();
  const m = /^-?\d+(?:\.\d+)?\s*([a-zA-Z%]*)$/.exec(text);
  let unit = m ? m[1] : "";
  if (!KEEP_UNITS.has(unit)) unit = BASE_UNIT[unit] ?? "";
  if (unit === "Nm") return `${fmtNum(value / 1000, 4)}Nm`;
  const digits = Math.abs(value) < 10 ? 3 : 2;
  return `${fmtNum(value, digits)}${unit}`;
}

/** Replace a parameter's value expression with a literal. */
export function setParamValue(src: string, p: EvalParam, value: number | string | boolean): string {
  return src.slice(0, p.valueSpan.start) + formatParamValue(p, value) + src.slice(p.valueSpan.end);
}

/** Smallest single replacement turning a into b. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export interface TextEdit {
  old_text: string;
  new_text: string;
}

/** Apply exact-match replacements in order. Each old_text must occur exactly once. */
export function applyTextEdits(src: string, edits: TextEdit[]): { src: string; errors: string[] } {
  let out = src;
  const errors: string[] = [];
  edits.forEach((e, i) => {
    if (!e.old_text) {
      errors.push(`Edit ${i + 1}: old_text is empty. Use it to name the exact text to replace, or append with insert_after.`);
      return;
    }
    const first = out.indexOf(e.old_text);
    if (first < 0) {
      errors.push(`Edit ${i + 1}: old_text was not found. Call get_design to see the current source; whitespace must match exactly.`);
      return;
    }
    if (out.indexOf(e.old_text, first + 1) >= 0) {
      errors.push(`Edit ${i + 1}: old_text appears more than once. Include more surrounding lines so it is unique.`);
      return;
    }
    out = out.slice(0, first) + e.new_text + out.slice(first + e.old_text.length);
  });
  return { src: out, errors };
}

/** Line-based diff for display (LCS on lines, fine for files of a few thousand lines). */
export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  a?: number;
  b?: number;
}

export function lineDiff(a: string, b: string, context = 2): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  // trim common head and tail so the LCS table stays small
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a2 = A.slice(head, A.length - tail);
  const b2 = B.slice(head, B.length - tail);
  const n = a2.length;
  const m = b2.length;
  const out: DiffLine[] = [];
  if (n * m > 4_000_000) {
    for (let i = 0; i < n; i++) out.push({ kind: "del", text: a2[i], a: head + i + 1 });
    for (let j = 0; j < m; j++) out.push({ kind: "add", text: b2[j], b: head + j + 1 });
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) {
        out.push({ kind: "same", text: a2[i], a: head + i + 1, b: head + j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        out.push({ kind: "add", text: b2[j], b: head + j + 1 });
        j++;
      } else {
        out.push({ kind: "del", text: a2[i], a: head + i + 1 });
        i++;
      }
    }
  }
  const pre: DiffLine[] = A.slice(Math.max(0, head - context), head).map((t, k) => ({ kind: "same", text: t, a: Math.max(0, head - context) + k + 1, b: Math.max(0, head - context) + k + 1 }));
  const post: DiffLine[] = A.slice(A.length - tail, Math.min(A.length, A.length - tail + context)).map((t, k) => ({ kind: "same", text: t, a: A.length - tail + k + 1, b: B.length - tail + k + 1 }));
  // collapse long unchanged runs inside the middle
  const mid: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (last: boolean) => {
    if (run.length > context * 2 + 1 && !last) {
      mid.push(...run.slice(0, context), { kind: "same", text: "…" }, ...run.slice(-context));
    } else mid.push(...run);
    run = [];
  };
  for (const l of out) {
    if (l.kind === "same") run.push(l);
    else {
      flush(false);
      mid.push(l);
    }
  }
  flush(false);
  return [...pre, ...mid, ...post];
}

export function diffStats(a: string, b: string) {
  const d = lineDiff(a, b, 0);
  return { added: d.filter((l) => l.kind === "add").length, removed: d.filter((l) => l.kind === "del").length };
}

/** Human summary of what changed between two evaluated models. */
export function describeChange(prev: Model | null, next: Model): string[] {
  if (!prev) return [];
  const out: string[] = [];
  for (const p of next.params) {
    const q = prev.params.find((x) => x.name === p.name);
    if (!q) out.push(`Added parameter ${p.name}`);
    else if (q.value !== p.value) out.push(`${p.name} ${show(q.value)} → ${show(p.value)}`);
  }
  for (const q of prev.params) if (!next.params.some((p) => p.name === q.name)) out.push(`Removed parameter ${q.name}`);
  const prevById = new Map(prev.parts.map((p) => [p.id, p]));
  const added = next.parts.filter((p) => !prevById.has(p.id));
  const removed = prev.parts.filter((p) => !next.parts.some((n) => n.id === p.id));
  const changed = next.parts.filter((p) => {
    const q = prevById.get(p.id);
    return q && (q.hash !== p.hash || JSON.stringify(q.xf) !== JSON.stringify(p.xf));
  });
  if (added.length) out.push(`${added.length} part${added.length > 1 ? "s" : ""} added`);
  if (removed.length) out.push(`${removed.length} part${removed.length > 1 ? "s" : ""} removed`);
  if (changed.length) out.push(`${changed.length} part${changed.length > 1 ? "s" : ""} updated`);
  return out;
}

const show = (v: number | string | boolean) => (typeof v === "number" ? fmtNum(v) : String(v));

/** Statement under a source offset, for linking editor and viewport. */
export function blockAt(model: Model, offset: number) {
  return model.blocks.find((b) => offset >= b.span.start && offset <= b.span.end);
}

/** Add or remove the `locked` keyword on a parameter statement. */
export function toggleParamLock(src: string, p: EvalParam): string {
  const text = src.slice(p.span.start, p.span.end);
  if (p.locked) {
    const next = text.replace(/\s+locked\b/, "");
    return src.slice(0, p.span.start) + next + src.slice(p.span.end);
  }
  return src.slice(0, p.span.end) + " locked" + src.slice(p.span.end);
}

/**
 * Set top-level properties on a part or component block, keeping the
 * block's formatting. Values are source text (`"PETG"`, `#4f7cff`); null
 * removes the property. Returns the source unchanged if the block is missing.
 */
export function setBlockProps(src: string, blockName: string, props: Record<string, string | null>): string {
  const { program } = parse(src);
  const stmt = program.stmts.find((s) => (s.k === "part" || s.k === "component") && s.name === blockName);
  if (!stmt || (stmt.k !== "part" && stmt.k !== "component")) return src;
  const edits: { start: number; end: number; text: string }[] = [];
  const missing: [string, string][] = [];
  for (const [name, value] of Object.entries(props)) {
    const it = stmt.items.find((i) => i.k === "prop" && i.name === name);
    if (it && it.k === "prop") {
      if (value === null) edits.push(removal(src, it.span.start, it.span.end));
      else edits.push({ start: it.value.span.start, end: it.value.span.end, text: value });
    } else if (value !== null) missing.push([name, value]);
  }
  if (missing.length) {
    const headEnd = stmt.k === "component" ? stmt.call.span.end : stmt.nameSpan.end;
    const open = src.indexOf("{", headEnd);
    const hasBlock = open >= 0 && open < stmt.span.end;
    if (!hasBlock) {
      edits.push({ start: headEnd, end: headEnd, text: ` { ${missing.map(([n, v]) => `${n}: ${v}`).join(", ")} }` });
    } else {
      const body = src.slice(open + 1, stmt.span.end - 1);
      if (body.includes("\n")) {
        const first = stmt.items[0];
        const lineStart = src.lastIndexOf("\n", (first?.span.start ?? open) - 1) + 1;
        const indent = first ? /^[ \t]*/.exec(src.slice(lineStart))![0] : /^[ \t]*/.exec(src.slice(src.lastIndexOf("\n", stmt.span.start - 1) + 1))![0] + "  ";
        edits.push({ start: open + 1, end: open + 1, text: missing.map(([n, v]) => `\n${indent}${n}: ${v}`).join("") });
      } else {
        const empty = body.trim() === "";
        edits.push({ start: open + 1, end: open + 1, text: " " + missing.map(([n, v]) => `${n}: ${v}`).join(", ") + (empty ? " " : ",") });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** The text range to delete for one property: its whole line, or the item and its separating comma. */
function removal(src: string, start: number, end: number) {
  const ls = src.lastIndexOf("\n", start - 1) + 1;
  let le = src.indexOf("\n", end);
  if (le < 0) le = src.length;
  const before = src.slice(ls, start);
  const after = src.slice(end, le);
  if (before.trim() === "" && /^\s*,?\s*(\/\/.*)?$/.test(after) && !after.includes("//")) return { start: ls, end: Math.min(src.length, le + 1), text: "" };
  const trail = /^\s*,\s*/.exec(src.slice(end));
  if (trail) return { start, end: end + trail[0].length, text: "" };
  const lead = /,\s*$/.exec(src.slice(ls, start));
  if (lead) return { start: start - lead[0].length, end, text: "" };
  return { start, end, text: "" };
}
