// Configurations: variants of one design in one file (S, M and L), each a row of the parameter values it changes:
//
//   configs "Sizes" {
//     show: "Medium"
//     config "Small" { width: 40, depth: 30 }
//     config "Medium" { width: 60, depth: 45 }
//     config "Large" { width: 80, depth: 60, wall: 3 } "For the big drill set"
//   }
//
// show: is the one the file is read as; the evaluator gives its values to the parameters and points their edits at
// the row. Here: switching configurations, saving the current values as one, reading each in turn for the checks,
// and the family table.

import { evaluate } from "../lang/evaluator";
import { fmtNum } from "../lang/values";
import type { CheckItem } from "./checks";
import { applySpanEdits, kerfString, type SetValue, type SpanEdit } from "./decisions";
import type { ConfigRow, ConfigTable, Model } from "./model";
import { formatParamValue } from "./sourceEdit";

/** The parameters the configurations set, in the order the design declares them. */
export function configColumns(model: Model): string[] {
  const t = model.configs;
  if (!t) return [];
  const set = new Set(t.rows.flatMap((r) => r.sets.map((s) => s.param)));
  const declared = model.params.map((p) => p.name).filter((n) => set.has(n));
  return [...declared, ...[...set].filter((n) => !declared.includes(n))];
}

/** A row's value for a parameter: its own, or the parameter's as written in the file (shared by every row that leaves it). */
export function rowValue(model: Model, row: ConfigRow, param: string): SetValue | undefined {
  const own = row.sets.find((s) => s.param === param);
  if (own) return own.value;
  const p = model.params.find((q) => q.name === param);
  return p ? (p.config ? p.asWritten : p.value) : undefined;
}

/** Show a configuration (null: the parameters as written): the show: field of the configs block. */
export function showConfig(src: string, model: Model, label: string | null): string {
  const t = model.configs;
  if (!t) return src;
  if (t.showSpan) {
    if (label === null) return applySpanEdits(src, [deleteLine(src, t.showSpan.span.start, t.showSpan.span.end)]);
    return applySpanEdits(src, [{ start: t.showSpan.valueSpan.start, end: t.showSpan.valueSpan.end, text: kerfString(label) }]);
  }
  if (label === null) return src;
  return applySpanEdits(src, [{ start: t.bodyStart, end: t.bodyStart, text: `\n  show: ${kerfString(label)}` }]);
}

/**
 * Save the design's current values as a configuration: a new row (with the block, if the design has none yet), or
 * the row of that name brought up to date. The values saved are the columns the rows set already, or every unlocked
 * parameter for the first row.
 */
export function saveConfig(src: string, model: Model, label: string, opts: { note?: string; show?: boolean } = {}): string {
  const t = model.configs;
  const cols = t && t.rows.length ? configColumns(model) : model.params.filter((p) => !p.locked).map((p) => p.name);
  const values = cols
    .map((c) => model.params.find((p) => p.name === c))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => `${p.name}: ${formatParamValue(p, p.value)}`);
  const old = t?.rows.find((r) => r.label === label);
  // a row brought up to date keeps what it is for, unless a new note is given
  const note = opts.note ?? old?.note;
  const row = `config ${kerfString(label)} { ${values.join(", ")} }${note ? ` ${kerfString(note)}` : ""}`;
  if (!t) {
    const body = src.replace(/\s+$/, "");
    return `${body}${body ? "\n\n" : ""}configs "Configurations" {\n${opts.show ? `  show: ${kerfString(label)}\n` : ""}  ${row}\n}\n`;
  }
  const edits: SpanEdit[] = [];
  if (old) edits.push({ start: old.span.start, end: old.span.end, text: row });
  else {
    // after the last row, or at the top of the block
    const at = t.rows.length ? t.rows[t.rows.length - 1].span.end : t.bodyStart;
    edits.push({ start: at, end: at, text: `\n  ${row}` });
  }
  const out = applySpanEdits(src, edits);
  if (!opts.show) return out;
  // the block moved by the edit above only after it, so show: (at the top) is placed on the edited text
  const m = evaluate(out, { skipGeometry: true });
  return m.configs ? showConfig(out, m, label) : out;
}

/** Take a configuration out (and show: off it, if it was the one shown). */
export function deleteConfig(src: string, model: Model, label: string): string {
  const t = model.configs;
  const row = t?.rows.find((r) => r.label === label);
  if (!t || !row) return src;
  const edits = [deleteLine(src, row.span.start, row.span.end)];
  if (t.shown === label && t.showSpan) edits.push(deleteLine(src, t.showSpan.span.start, t.showSpan.span.end));
  return applySpanEdits(src, edits);
}

/** Remove a line (and its line break) holding [start, end). */
function deleteLine(src: string, start: number, end: number): SpanEdit {
  let s = start;
  while (s > 0 && (src[s - 1] === " " || src[s - 1] === "\t")) s--;
  let e = end;
  while (e < src.length && (src[e] === " " || src[e] === "\t" || src[e] === ",")) e++;
  if (src[e] === "\n" && (s === 0 || src[s - 1] === "\n")) e++;
  return { start: s, end: e, text: "" };
}

/** What reading the design as one configuration gives: its errors, warnings and requirements. */
export interface ConfigVerdict {
  label: string;
  errors: string[];
  warnings: string[];
  requirements: { label: string; status: "pass" | "fail" | "pending" | "error"; level: "hard" | "soft"; margin?: number }[];
  ms: number;
}

export function configVerdict(model: Model, label: string): ConfigVerdict {
  // the design's own messages about the configs block are said once, for the configuration shown
  const own = (m: string) => !/^(Configuration "|show: ")/.test(m);
  return {
    label,
    errors: model.diagnostics.filter((d) => d.severity === "error").map((d) => d.message),
    warnings: model.diagnostics.filter((d) => d.severity === "warning" && own(d.message)).map((d) => d.message),
    requirements: model.requirements.map((r) => ({ label: r.label, status: r.status, level: r.level, ...(r.margin !== undefined ? { margin: r.margin } : {}) })),
    ms: model.evalMs ?? 0,
  };
}

/** Read the design as a configuration. */
export function readConfig(src: string, label: string): Model {
  return evaluate(src, { config: label });
}

// the checks read every configuration but the one shown: remembered by source and label, within a time budget
const verdicts = new Map<string, ConfigVerdict>();
const BUDGET_MS = 250;

function cachedVerdict(src: string, label: string): ConfigVerdict {
  const key = `${hashText(src)}|${label}`;
  const hit = verdicts.get(key);
  if (hit) return hit;
  const v = configVerdict(readConfig(src, label), label);
  verdicts.set(key, v);
  if (verdicts.size > 200) for (const k of [...verdicts.keys()].slice(0, verdicts.size - 200)) verdicts.delete(k);
  return v;
}

function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * The checks report's view of the configurations: each one other than the one shown (the rest of the report is that
 * one), read in turn, for what breaks or fails in it. What the time budget leaves unread is read on `more` (the
 * report composed again), so a slow design is read a few configurations at a time.
 */
export function configItems(model: Model, src: string | undefined, more?: () => void): CheckItem[] {
  const t = model.configs;
  if (!t || !src) return [];
  const out: CheckItem[] = [];
  const t0 = performance.now();
  let left = 0;
  for (const r of t.rows) {
    if (r.label === t.active) continue;
    if (performance.now() - t0 > BUDGET_MS && !verdicts.has(`${hashText(src)}|${r.label}`)) {
      left++;
      continue;
    }
    out.push(configItem(cachedVerdict(src, r.label), r, t));
  }
  if (left) {
    out.push({
      id: "config:more",
      category: "requirement",
      status: "info",
      title: `${plural(left, "configuration")} not read yet`,
      detail: "The design takes a while to read, so the checks read the configurations a few at a time; the rest follow in a moment.",
      span: t.span,
      basis: "parameters",
    });
    more?.();
  }
  return out;
}

function configItem(v: ConfigVerdict, row: ConfigRow, t: ConfigTable): CheckItem {
  const base = { id: `config:${row.label}`, category: "requirement" as const, span: row.span, basis: "parameters" as const };
  const name = `Configuration “${row.label}”`;
  if (v.errors.length)
    return { ...base, status: "fail", title: `${name} does not build`, detail: `Read as ${row.label}, the design stops at: ${v.errors.slice(0, 3).join("; ")}${v.errors.length > 3 ? ` (and ${v.errors.length - 3} more)` : ""}.`, fix: `Change ${row.label}'s values in configs, or show it (show: ${kerfString(row.label)}) to see where it breaks.` };
  const failing = v.requirements.filter((r) => r.status === "fail" || r.status === "error");
  const hard = failing.filter((r) => r.level === "hard");
  const met = v.requirements.filter((r) => r.status === "pass").length;
  const pending = v.requirements.filter((r) => r.status === "pending").length;
  const range = v.warnings.filter((w) => /is outside its range/.test(w));
  const counted = v.requirements.length ? `${met} of ${plural(v.requirements.length, "requirement")} met${pending ? ` (${pending} need the geometry built: show it to check them)` : ""}` : "no requirements to check";
  if (failing.length) {
    const words = failing.slice(0, 3).map((r) => `“${r.label}”${r.margin !== undefined && r.margin < 0 ? ` (short by ${fmtNum(-r.margin, 3)})` : ""}`);
    return { ...base, status: hard.length ? "fail" : "warn", title: `${name} fails ${failing.length === 1 ? words[0] : plural(failing.length, "requirement")}`, detail: `${counted}; failing: ${words.join(", ")}${failing.length > 3 ? " and more" : ""}.${range.length ? ` ${range.join(" ")}` : ""}`, fix: `Change ${row.label}'s values in configs, or the design, until it meets them.` };
  }
  if (range.length) return { ...base, status: "warn", title: `${name} goes outside a parameter's range`, detail: `${range.join(" ")} ${counted}.`, fix: `Bring ${row.label}'s value inside the range, or widen the range if the design takes it.` };
  return { ...base, status: "pass", title: `${name} reads cleanly`, detail: `${counted}${row.note ? `. ${row.note}` : ""}.` };
}

/** The family table as CSV: one row per configuration, a column per parameter they set, and how each fares. */
export function familyTableCsv(model: Model, results: Map<string, ConfigVerdict> = new Map()): string {
  const t = model.configs;
  if (!t) return "";
  const cols = configColumns(model);
  const cell = (v: unknown) => {
    const s = v === undefined ? "" : typeof v === "number" ? fmtNum(v, 4) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Configuration", ...cols, "Requirements", "Notes"];
  const lines = [head.map(cell).join(",")];
  for (const r of t.rows) {
    const v = results.get(r.label);
    const verdict = v ? (v.errors.length ? "does not build" : v.requirements.length ? `${v.requirements.filter((q) => q.status === "pass").length} of ${v.requirements.length} met` : "none") : "";
    lines.push([r.label, ...cols.map((c) => rowValue(model, r, c)), verdict, r.note ?? ""].map(cell).join(","));
  }
  return lines.join("\n") + "\n";
}
