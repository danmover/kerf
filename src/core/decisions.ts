// Design decisions recorded in the source as `decision` blocks: how each one
// stands against the live parameters, and the text edits that record, switch
// and fine-tune them. Like every other change, these are edits to the text.

import type { DecisionOption, EvalDecision, Model } from "./model";
import { formatParamValue } from "./sourceEdit";
import { KEYWORDS } from "../lang/lexer";
import { fmtNum } from "../lang/values";

export type SetValue = number | string | boolean;
export type SetMap = Record<string, SetValue>;

export interface SpanEdit {
  start: number;
  end: number;
  text: string;
}

/** Apply replacements given as offsets into the same source, back to front. */
export function applySpanEdits(src: string, edits: SpanEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.end > limit) throw new Error("Edits overlap");
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

export const sameValue = (a: SetValue | undefined, b: SetValue | undefined) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);

/** A string literal the Kerf lexer reads back exactly. */
export function kerfString(s: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  return `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** A value written the way its parameter is written (keeping its unit). */
export function formatValue(model: Model, param: string, value: SetValue): string {
  const p = model.params.find((q) => q.name === param);
  if (p) return formatParamValue(p, value);
  if (typeof value === "number") return fmtNum(value, 3);
  if (typeof value === "string") return kerfString(value);
  return value ? "true" : "false";
}

/** The unit a parameter is written in ("mm", "deg", or ""). */
export function paramUnit(model: Model | null, param: string): string {
  const p = model?.params.find((q) => q.name === param);
  if (!p || typeof p.value !== "number") return "";
  const m = /^-?\d+(?:\.\d+)?\s*([a-zA-Z%]*)$/.exec(p.text.trim());
  if (!m) return "";
  const u = m[1];
  if (u === "deg" || u === "rad") return "°";
  if (u === "mm" || u === "cm" || u === "m" || u === "in") return "mm";
  return u === "%" ? "" : u;
}

// ---------- reading ----------

export interface DecisionStatus {
  chosen?: DecisionOption;
  /** recorded values of the chosen option that the parameters no longer match */
  drift: { param: string; recorded: SetValue; current: SetValue }[];
  /** the option whose values the parameters match right now */
  matching?: DecisionOption;
}

export function decisionStatus(d: EvalDecision, model: Model): DecisionStatus {
  const current = (name: string) => model.params.find((p) => p.name === name)?.value;
  const chosen = d.options.find((o) => o.label === d.chose);
  const drift = (chosen?.sets ?? []).flatMap((s) => {
    const c = current(s.param);
    return c === undefined || sameValue(c, s.value) ? [] : [{ param: s.param, recorded: s.value, current: c }];
  });
  const matching = d.options.find((o) => o.sets.length > 0 && o.sets.every((s) => sameValue(current(s.param), s.value)));
  return { chosen, drift, matching };
}

/** Every parameter any option of the decision sets. */
export function decisionParams(d: EvalDecision): string[] {
  return [...new Set(d.options.flatMap((o) => o.sets.map((s) => s.param)))];
}

/** Ids of the solids shaped, directly or downstream, by these parameters. */
export function partsAffectedBy(model: Model, params: string[]): string[] {
  const out = new Map<string, string[]>();
  for (const e of model.graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [...params];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of out.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return model.parts.filter((p) => seen.has(p.name)).map((p) => p.id);
}

/** The decisions in a few lines, for Claude's context. */
export function decisionsSummary(model: Model): string {
  if (!model.decisions.length) return "";
  const lines = model.decisions.map((d) => {
    const st = decisionStatus(d, model);
    const vals = st.chosen?.sets.length ? ` [${st.chosen.sets.map((s) => `${s.param}=${show(s.value)}`).join(", ")}]` : "";
    const drift = st.drift.length ? `; adjusted since: ${st.drift.map((x) => `${x.param} is now ${show(x.current)}`).join(", ")}` : "";
    const others = d.options.filter((o) => o.label !== d.chose).map((o) => `"${o.label}"`);
    return `  - ${d.name} "${d.title}"${d.by ? ` (by ${d.by})` : ""}: ${d.chose ? `chose "${d.chose}"${vals}` : "undecided"}${drift}${others.length ? `; alternatives: ${others.join(", ")}` : ""}`;
  });
  return "Decisions recorded in the source:\n" + lines.join("\n");
}

const show = (v: SetValue) => (typeof v === "number" ? fmtNum(v, 3) : JSON.stringify(v));

// ---------- writing ----------

export interface DecisionDraft {
  name?: string;
  title: string;
  ask?: string;
  chose?: string;
  by?: string;
  why?: string;
  options: { label: string; note?: string; set?: SetMap }[];
}

/** A unique identifier for a new decision, made from its title. */
export function decisionName(title: string, model: Model): string {
  let base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  if (!base || !/^[a-z_]/.test(base)) base = `decision_${base}`.replace(/_+$/, "");
  if (KEYWORDS.has(base)) base += "_choice";
  const taken = new Set([...model.decisions.map((d) => d.name), ...model.blocks.map((b) => b.name)]);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

export function formatDecision(d: DecisionDraft & { name: string }, model: Model): string {
  const lines = [`decision ${d.name} ${kerfString(d.title)} {`];
  if (d.ask) lines.push(`  ask: ${kerfString(d.ask)}`);
  if (d.chose) lines.push(`  chose: ${kerfString(d.chose)}`);
  if (d.by) lines.push(`  by: ${kerfString(d.by)}`);
  if (d.why) lines.push(`  why: ${kerfString(d.why)}`);
  for (const o of d.options) {
    const sets = Object.entries(o.set ?? {});
    const values = sets.length ? ` { ${sets.map(([k, v]) => `${k}: ${formatValue(model, k, v)}`).join(", ")} }` : "";
    lines.push(`  option ${kerfString(o.label)}${values}`);
    if (o.note) lines.push(`    ${kerfString(o.note)}`);
  }
  lines.push("}");
  return lines.join("\n");
}

const SECTION = "// ── Decisions " + "─".repeat(41);

/** Add a decision block, or replace the one with the same name. */
export function upsertDecision(src: string, model: Model, draft: DecisionDraft): { src: string; name: string } {
  const existing = draft.name ? model.decisions.find((d) => d.name === draft.name) : undefined;
  const name = existing?.name ?? draft.name ?? decisionName(draft.title, model);
  const text = formatDecision({ ...draft, name }, model);
  if (existing) return { src: applySpanEdits(src, [{ start: existing.span.start, end: existing.span.end, text }]), name };
  const last = model.decisions[model.decisions.length - 1];
  if (last) return { src: applySpanEdits(src, [{ start: last.span.end, end: last.span.end, text: "\n\n" + text }]), name };
  const body = src.replace(/\s+$/, "");
  return { src: `${body}${body ? "\n\n" : ""}${SECTION}\n${text}\n`, name };
}

/** Edits that set parameters to values; names that are not parameters are reported. */
export function paramEdits(model: Model, values: SetMap): { edits: SpanEdit[]; missing: string[]; changed: { param: string; from: SetValue; to: SetValue }[] } {
  const edits: SpanEdit[] = [];
  const missing: string[] = [];
  const changed: { param: string; from: SetValue; to: SetValue }[] = [];
  for (const [name, v] of Object.entries(values)) {
    const p = model.params.find((q) => q.name === name);
    if (!p) {
      missing.push(name);
      continue;
    }
    if (sameValue(p.value, v)) continue;
    edits.push({ start: p.valueSpan.start, end: p.valueSpan.end, text: formatParamValue(p, v) });
    changed.push({ param: name, from: p.value, to: v });
  }
  return { edits, missing, changed };
}

/** The source with these parameter values written in. */
export function withValues(src: string, model: Model, values: SetMap): string {
  return applySpanEdits(src, paramEdits(model, values).edits);
}

/** Remove a field line (and its line break) from a decision. */
function deleteLine(src: string, start: number, end: number): SpanEdit {
  let s = start;
  while (s > 0 && (src[s - 1] === " " || src[s - 1] === "\t")) s--;
  let e = end;
  while (e < src.length && (src[e] === " " || src[e] === "\t")) e++;
  if (src[e] === "\n" && (s === 0 || src[s - 1] === "\n")) e++;
  return { start: s, end: e, text: "" };
}

function fieldEdits(src: string, d: EvalDecision, fields: Record<string, string | null>): SpanEdit[] {
  const edits: SpanEdit[] = [];
  const insert: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const at = d.props[k];
    if (v === null) {
      if (at) edits.push(deleteLine(src, at.span.start, at.span.end));
    } else if (at) edits.push({ start: at.valueSpan.start, end: at.valueSpan.end, text: kerfString(v) });
    else insert.push(`\n  ${k}: ${kerfString(v)}`);
  }
  if (insert.length) edits.push({ start: d.bodyStart, end: d.bodyStart, text: insert.join("") });
  return edits;
}

/**
 * Make an option the decision's choice: write its values (with any the user
 * adjusted) into the parameters, record them on the option, and mark who chose.
 */
export function chooseOption(src: string, model: Model, name: string, label: string, opts: { values?: SetMap; by?: string } = {}): string {
  const d = model.decisions.find((x) => x.name === name);
  const o = d?.options.find((x) => x.label === label);
  if (!d || !o) throw new Error(`No option “${label}” in decision ${name}`);
  const final: SetMap = {};
  for (const s of o.sets) final[s.param] = opts.values?.[s.param] ?? s.value;
  const edits = paramEdits(model, final).edits;
  for (const s of o.sets) if (!sameValue(final[s.param], s.value)) edits.push({ start: s.valueSpan.start, end: s.valueSpan.end, text: formatValue(model, s.param, final[s.param]) });
  // switching makes it the user's choice and drops the old reason; re-applying the same option keeps both
  const switching = d.chose !== label;
  const fields: Record<string, string | null> = switching ? { chose: label, by: opts.by ?? "you", ...(d.why ? { why: null } : {}) } : opts.by ? { by: opts.by } : {};
  edits.push(...fieldEdits(src, d, fields));
  return applySpanEdits(src, edits);
}

/** Fine-tune one value of the chosen option: the parameter and the record move together. */
export function setDecisionValue(src: string, model: Model, name: string, param: string, value: SetValue): string {
  const d = model.decisions.find((x) => x.name === name);
  const chosen = d?.options.find((o) => o.label === d.chose);
  const edits = paramEdits(model, { [param]: value }).edits;
  const s = chosen?.sets.find((x) => x.param === param);
  if (s && !sameValue(s.value, value)) edits.push({ start: s.valueSpan.start, end: s.valueSpan.end, text: formatValue(model, param, value) });
  return applySpanEdits(src, edits);
}

/** Record the parameters' current values on the chosen option. */
export function recordCurrent(src: string, model: Model, name: string): string {
  const d = model.decisions.find((x) => x.name === name);
  const chosen = d?.options.find((o) => o.label === d.chose);
  if (!chosen) return src;
  const edits: SpanEdit[] = [];
  for (const s of chosen.sets) {
    const p = model.params.find((q) => q.name === s.param);
    if (p && !sameValue(p.value, s.value)) edits.push({ start: s.valueSpan.start, end: s.valueSpan.end, text: formatValue(model, s.param, p.value) });
  }
  return applySpanEdits(src, edits);
}

/** Remove a decision block entirely. */
export function removeDecision(src: string, model: Model, name: string): string {
  const d = model.decisions.find((x) => x.name === name);
  if (!d) return src;
  let end = d.span.end;
  while (src[end] === "\n" && src[end + 1] === "\n") end++;
  return applySpanEdits(src, [deleteLine(src, d.span.start, end)]);
}

/** Parameters a part depends on, nearest first (through lets and other parts). */
export function paramsDriving(model: Model, partName: string, limit = 8): string[] {
  const into = new Map<string, string[]>();
  for (const e of model.graph.edges) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  const params = new Set(model.params.map((p) => p.name));
  const out: string[] = [];
  const seen = new Set([partName]);
  let frontier = [partName];
  while (frontier.length && out.length < limit) {
    const next: string[] = [];
    for (const n of frontier)
      for (const m of into.get(n) ?? []) {
        if (seen.has(m)) continue;
        seen.add(m);
        next.push(m);
        if (params.has(m)) out.push(m);
      }
    frontier = next;
  }
  return out.slice(0, limit);
}

/** Decisions whose values shape a part. */
export function decisionsFor(model: Model, partId: string): EvalDecision[] {
  return model.decisions.filter((d) => {
    const ps = decisionParams(d);
    return ps.length > 0 && partsAffectedBy(model, ps).includes(partId);
  });
}
