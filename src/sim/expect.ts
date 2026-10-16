// Checks a scenario's expectations against a run's results. An expectation is
// a design-language expression kept from the design (`miss < exit_d / 2`)
// that reads the run's results by name, and design values captured when the
// design was evaluated. Results win over design names, so `through` means
// the run's result even if the design also has a value called that.
//
// Every scenario runs three times (pessimistic, expected, optimistic). An
// expectation passes when it holds in the expected run; it warns when the
// expected run passes but another fails, and fails when the expected run
// fails (a soft expectation only warns).

import type { Expr } from "../lang/ast";
import { suggest } from "../lang/suggest";
import { VARIANT_LABEL, type VariantName } from "./worlds/common";
import { COMMON_RESULTS, WORLD_RESULTS, fmtResult, resultInfo, type ResultUnit } from "./results";
import type { ScenarioExpect } from "./scenario";

type V = number | boolean | string;

class ExpectError extends Error {}

/** A result the expectation reads that this run did not record (time_to_wall when it never got there). */
class NotRecorded extends Error {
  constructor(public what: string) {
    super(`${what} was not recorded in this run`);
  }
}

export interface VariantCheck {
  variant: VariantName;
  /** null when the run could not be checked */
  ok: boolean | null;
  detail: string;
  /** how far inside (+) or outside (-) the limit, in the result's units, for a simple comparison */
  margin?: number;
}

export interface ExpectOutcome {
  label: string;
  level: "hard" | "soft";
  status: "pass" | "warn" | "fail";
  detail: string;
  variants: VariantCheck[];
  margin?: number;
}

const FNS: Record<string, (...a: number[]) => number> = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

/** Names a world's results can have, for "did you mean". */
function knownNames(results: Record<string, V>, world: string): string[] {
  const names = new Set(Object.keys(results));
  for (const k of [...Object.keys(COMMON_RESULTS), ...Object.keys(WORLD_RESULTS[world] ?? {})]) if (!k.includes("<")) names.add(k);
  return [...names];
}

interface Ctx {
  results: Record<string, V>;
  env: Record<string, V>;
  world: string;
  /** what each name read was, in order */
  read: Map<string, { value: V; unit?: ResultUnit }>;
}

function lookup(name: string, c: Ctx): V {
  if (name in c.results) {
    const value = c.results[name];
    c.read.set(name, { value, unit: resultInfo(name, c.world)?.unit });
    return value;
  }
  if (name in c.env) return c.env[name];
  // a documented result this run did not produce is a failed expectation, not a mistake in it
  if (resultInfo(name, c.world)) throw new NotRecorded(name);
  const sugg = suggest(name, knownNames(c.results, c.world));
  throw new ExpectError(`"${name}" is not a result of this run${sugg ? `. Did you mean "${sugg}"?` : ""}`);
}

function evalE(e: Expr, c: Ctx): V {
  switch (e.k) {
    case "num":
      return e.v;
    case "str":
      return e.v;
    case "bool":
      return e.v;
    case "ident":
      return lookup(e.name, c);
    case "member": {
      const path = memberPath(e);
      if (path) return lookup(path, c);
      throw new ExpectError("Read results by name, like m_front.max_temp");
    }
    case "unary": {
      const v = evalE(e.arg, c);
      if (e.op === "!") return !truthy(v);
      if (e.op === "-" && typeof v === "number") return -v;
      throw new ExpectError(`Cannot apply "${e.op}" to ${typeof v}`);
    }
    case "ternary":
      return truthy(evalE(e.cond, c)) ? evalE(e.a, c) : evalE(e.b, c);
    case "call": {
      const name = e.callee.k === "ident" ? e.callee.name : "";
      const f = FNS[name];
      if (!f) throw new ExpectError(`Expectations can use ${Object.keys(FNS).join(", ")}${name ? `, not ${name}()` : ""}`);
      const args = e.args.map((a) => evalE(a.value, c));
      if (args.some((a) => typeof a !== "number")) throw new ExpectError(`${name}() takes numbers`);
      return f(...(args as number[]));
    }
    case "binary":
      return binary(e.op, e.left, e.right, c);
    default:
      throw new ExpectError("Expectations compare results with numbers, like miss < 100mm");
  }
}

function binary(op: string, le: Expr, re: Expr, c: Ctx): V {
  if (op === "&&") return truthy(evalE(le, c)) && truthy(evalE(re, c));
  if (op === "||") return truthy(evalE(le, c)) || truthy(evalE(re, c));
  const l = evalE(le, c);
  const r = evalE(re, c);
  if (op === "==" || op === "!=") {
    const eq = typeof l === "number" && typeof r === "number" ? Math.abs(l - r) < 1e-9 : l === r;
    return op === "==" ? eq : !eq;
  }
  if (typeof l !== "number" || typeof r !== "number") throw new ExpectError(`Cannot apply "${op}" to ${typeof l} and ${typeof r}`);
  switch (op) {
    case "+":
      return l + r;
    case "-":
      return l - r;
    case "*":
      return l * r;
    case "/":
      if (r === 0) throw new ExpectError("Division by zero");
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
  throw new ExpectError(`Unknown operator "${op}"`);
}

const truthy = (v: V) => (typeof v === "number" ? v !== 0 : typeof v === "string" ? v.length > 0 : v);

function memberPath(e: Expr): string | null {
  if (e.k === "ident") return e.name;
  if (e.k === "member") {
    const base = memberPath(e.obj);
    return base ? `${base}.${e.name}` : null;
  }
  return null;
}

const CMP = new Set(["<", "<=", ">", ">=", "==", "!="]);
const CMP_TEXT: Record<string, string> = { "<": "under", "<=": "at most", ">": "over", ">=": "at least", "==": "exactly", "!=": "not" };

/** The first result name an expression reads, for the unit of the constant it is compared with. */
function unitOf(e: Expr, c: Ctx): ResultUnit | undefined {
  const path = memberPath(e);
  if (path) return resultInfo(path, c.world)?.unit;
  if (e.k === "binary") return unitOf(e.left, c) ?? unitOf(e.right, c);
  if (e.k === "unary") return unitOf(e.arg, c);
  if (e.k === "call") for (const a of e.args) {
    const u = unitOf(a.value, c);
    if (u) return u;
  }
  return undefined;
}

/** People's words for one part of an expectation and the values it read. */
function explain(e: Expr, c: Ctx, src: (e: Expr) => string): { text: string; margin?: number } {
  if (e.k === "binary" && e.op === "&&") {
    const a = explain(e.left, c, src);
    const b = explain(e.right, c, src);
    return { text: `${a.text}; ${b.text}`, margin: a.margin !== undefined && b.margin !== undefined ? Math.min(a.margin, b.margin) : (a.margin ?? b.margin) };
  }
  if (e.k === "binary" && CMP.has(e.op)) {
    const unit = unitOf(e.left, c) ?? unitOf(e.right, c);
    const l = safe(e.left, c);
    const r = safe(e.right, c);
    const name = memberPath(e.left) ?? src(e.left);
    const text = `${name} ${fmtResult(l, unit)} (needs ${CMP_TEXT[e.op]} ${fmtResult(r, unit)})`;
    let margin: number | undefined;
    if (typeof l === "number" && typeof r === "number") margin = e.op === "<" || e.op === "<=" ? r - l : e.op === ">" || e.op === ">=" ? l - r : undefined;
    return { text, margin };
  }
  const path = memberPath(e);
  if (path) return { text: `${path}: ${fmtResult(safe(e, c), resultInfo(path, c.world)?.unit)}` };
  if (e.k === "unary" && e.op === "!") {
    const p = memberPath(e.arg);
    if (p) return { text: `${p}: ${fmtResult(safe(e.arg, c), resultInfo(p, c.world)?.unit)}` };
  }
  const v = safe(e, c);
  const parts = [...c.read].map(([k, x]) => `${k} ${fmtResult(x.value, x.unit)}`);
  return { text: parts.length ? parts.join(", ") : `${src(e)} is ${fmtResult(v)}` };
}

function safe(e: Expr, c: Ctx): V | undefined {
  try {
    return evalE(e, c);
  } catch {
    return undefined;
  }
}

/** Check one expectation against one run's results. */
export function checkRun(ex: Pick<ScenarioExpect, "expr" | "env" | "text">, results: Record<string, V>, world: string): { ok: boolean | null; detail: string; margin?: number; error?: string } {
  const c: Ctx = { results, env: ex.env, world, read: new Map() };
  const src = (e: Expr) => ex.text.slice(e.span.start - ex.expr.span.start, e.span.end - ex.expr.span.start) || "it";
  let ok: boolean;
  try {
    ok = truthy(evalE(ex.expr, c));
  } catch (err) {
    if (err instanceof NotRecorded) return { ok: false, detail: `${err.what} was not recorded: ${notRecordedWhy(err.what, results)}` };
    if (err instanceof ExpectError) return { ok: null, detail: err.message, error: err.message };
    throw err;
  }
  const { text, margin } = explain(ex.expr, c, src);
  return { ok, detail: text, margin };
}

function notRecordedWhy(name: string, results: Record<string, V>): string {
  if (name === "time_to_wall" || name.startsWith("miss")) return `it never reached the far wall (${fmtResult(results.remaining as number, "mm")} short)`;
  if (name === "time_out") return "the front screw never came out of the far side";
  if (name.startsWith("battery_")) return "the design has no battery the simulation can follow";
  return "the run did not get that far";
}

/** Combine the runs into one verdict (see the top of this file). */
export function judge(ex: Pick<ScenarioExpect, "label" | "level" | "expr" | "env" | "text">, runs: { variant: VariantName; results: Record<string, V>; error?: string }[], world: string): ExpectOutcome {
  const variants: VariantCheck[] = runs.map((r) => {
    if (r.error) return { variant: r.variant, ok: null, detail: r.error };
    const c = checkRun(ex, r.results, world);
    return { variant: r.variant, ok: c.ok, detail: c.detail, margin: c.margin };
  });
  const base = variants.find((v) => v.variant === "expected") ?? variants[0];
  const out = { label: ex.label, level: ex.level, variants, margin: base?.margin };
  if (!base) return { ...out, status: "fail", detail: "The scenario did not run." };
  const broken = variants.find((v) => v.ok === null);
  if (broken) return { ...out, status: "fail", detail: `Cannot check this: ${broken.detail}` };
  const others = variants.filter((v) => v !== base);
  const label = (v: VariantCheck) => VARIANT_LABEL[v.variant].toLowerCase();
  void cap;
  const lead = `${label(base)} run: ${base.detail}.`;
  if (base.ok) {
    const bad = others.filter((v) => !v.ok);
    if (!bad.length) return { ...out, status: "pass", detail: `${lead}${others.length ? ` It also passes in the ${others.map(label).join(" and ")} run${others.length > 1 ? "s" : ""}.` : ""}` };
    return { ...out, status: "warn", detail: `${lead} It fails in the ${bad.map((v) => `${label(v)} run (${v.detail})`).join(" and ")}.` };
  }
  const good = others.filter((v) => v.ok);
  return { ...out, status: ex.level === "soft" ? "warn" : "fail", detail: `${lead}${good.length ? ` It passes only in the ${good.map(label).join(" and ")} run.` : ""}` };
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
