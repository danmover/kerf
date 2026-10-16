// Feasibility solver: when hard requirements cannot all hold, find the
// smallest parameter changes that satisfy every hard parametric requirement.
// Locked parameters (and any the caller holds fixed) are never changed.

import { evaluate } from "../lang/evaluator";
import type { Program } from "../lang/ast";
import type { Diagnostic } from "../lang/parser";
import type { Model } from "./model";
import { fmtNum } from "../lang/values";

export interface FixOption {
  changes: { param: string; from: number; to: number }[];
  /** sum of relative changes, lower is gentler */
  cost: number;
  summary: string;
}

export interface Conflict {
  failing: { label: string; detail: string; margin: number }[];
  adjustable: string[];
  options: FixOption[];
  /** true when no parameter change can satisfy the hard requirements */
  infeasible: boolean;
}

interface Ctx {
  src: string;
  parsed: { program: Program; diagnostics: Diagnostic[] };
  hardLabels: string[];
}

function minMargin(ctx: Ctx, overrides: Record<string, number>): number {
  const m = evaluate(ctx.src, { parsed: ctx.parsed, overrides, skipGeometry: true });
  let worst = Infinity;
  for (const r of m.requirements) {
    if (!ctx.hardLabels.includes(r.label)) continue;
    if (r.status === "error") return -1e9;
    if (r.status === "pending") continue;
    const margin = r.margin ?? (r.status === "pass" ? 0 : -1);
    worst = Math.min(worst, r.status === "pass" ? Math.max(margin, 0) : Math.min(margin, -1e-6));
  }
  return worst === Infinity ? 0 : worst;
}

function ancestors(model: Model, id: string): Set<string> {
  const parents = new Map<string, string[]>();
  for (const e of model.graph.edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const p of parents.get(cur) ?? []) {
      if (!out.has(p)) {
        out.add(p);
        stack.push(p);
      }
    }
  }
  return out;
}

const yieldNow = () => new Promise((r) => setTimeout(r, 0));

export async function solveConflict(
  src: string,
  parsed: { program: Program; diagnostics: Diagnostic[] },
  model: Model,
  opts: { hold?: string[]; maxOptions?: number } = {},
): Promise<Conflict | null> {
  const hard = model.requirements.filter((r) => r.level === "hard" && r.geo.length === 0);
  const failing = hard.filter((r) => r.status === "fail");
  if (!failing.length) return null;
  const ctx: Ctx = { src, parsed, hardLabels: hard.map((r) => r.label) };
  const hold = new Set(opts.hold ?? []);

  const cand = new Set<string>();
  for (const r of failing) for (const a of ancestors(model, `require:${r.label}`)) cand.add(a);
  const params = model.params.filter((p) => cand.has(p.name) && !p.locked && !hold.has(p.name) && typeof p.value === "number");
  const failingOut = failing.map((r) => ({ label: r.label, detail: r.detail, margin: r.margin ?? 0 }));
  if (!params.length) return { failing: failingOut, adjustable: [], options: [], infeasible: true };

  const options: FixOption[] = [];
  // 1. single-parameter fixes
  for (const p of params) {
    await yieldNow();
    const v0 = p.value as number;
    const lo = p.min ?? (v0 > 0 ? v0 * 0.2 : v0 - 50);
    const hi = p.max ?? (v0 > 0 ? v0 * 5 : v0 + 50);
    const best = searchParam(ctx, p.name, v0, lo, hi);
    if (best !== null) options.push(makeOption([{ param: p.name, from: v0, to: best }], params));
  }

  // 2. a balanced multi-parameter fix (pattern search on relative change)
  if (params.length >= 2) {
    await yieldNow();
    const joint = patternSearch(ctx, params.map((p) => ({ name: p.name, v0: p.value as number, lo: p.min ?? (p.value as number) * 0.2, hi: p.max ?? (p.value as number) * 5 })));
    if (joint) {
      const changes = joint.filter((c) => Math.abs(c.to - c.from) > 1e-6);
      if (changes.length >= 2 && !options.some((o) => sameChanges(o, changes))) options.push(makeOption(changes, params));
    }
  }

  options.sort((a, b) => a.cost - b.cost);
  return { failing: failingOut, adjustable: params.map((p) => p.name), options: options.slice(0, opts.maxOptions ?? 4), infeasible: options.length === 0 };
}

function searchParam(ctx: Ctx, name: string, v0: number, lo: number, hi: number): number | null {
  const f = (v: number) => minMargin(ctx, { [name]: v });
  let best: number | null = null;
  for (const dir of [1, -1]) {
    const limit = dir > 0 ? hi : lo;
    if ((limit - v0) * dir <= 0) continue;
    // march outward
    let prev = v0;
    let found: number | null = null;
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const v = v0 + ((limit - v0) * (i / steps) ** 2);
      if (f(v) >= 0) {
        found = v;
        break;
      }
      prev = v;
    }
    if (found === null) continue;
    // bisect between prev (infeasible) and found (feasible)
    let a = prev;
    let b = found;
    for (let k = 0; k < 18; k++) {
      const m = (a + b) / 2;
      if (f(m) >= 0) b = m;
      else a = m;
    }
    const rounded = roundFeasible(b, dir, (v) => f(v) >= 0);
    if (best === null || Math.abs(rounded - v0) < Math.abs(best - v0)) best = rounded;
  }
  return best;
}

/** Round to a friendly increment in the feasible direction. */
function roundFeasible(v: number, dir: number, ok: (v: number) => boolean): number {
  for (const step of [1, 0.5, 0.1, 0.05, 0.01]) {
    const near = Math.round(v / step) * step;
    const away = dir > 0 ? Math.ceil(v / step - 1e-9) * step : Math.floor(v / step + 1e-9) * step;
    for (const r of [near, away]) {
      if (Math.abs(r - v) <= Math.max(step, Math.abs(v) * 0.02) && ok(r)) return Math.round(r * 1000) / 1000;
    }
  }
  return Math.round(v * 1000) / 1000;
}

function patternSearch(ctx: Ctx, ps: { name: string; v0: number; lo: number; hi: number }[]) {
  const scale = ps.map((p) => Math.max(Math.abs(p.v0), 1));
  const x = ps.map((p) => p.v0);
  const cost = (xs: number[]) => {
    const ov: Record<string, number> = {};
    ps.forEach((p, i) => (ov[p.name] = xs[i]));
    const mm = minMargin(ctx, ov);
    const rel = xs.reduce((s, v, i) => s + ((v - ps[i].v0) / scale[i]) ** 2, 0);
    return rel + (mm < 0 ? 50 + 1000 * mm * mm : 0);
  };
  let fx = cost(x);
  let step = 0.2;
  let evals = 0;
  while (step > 0.002 && evals < 600) {
    let improved = false;
    for (let i = 0; i < x.length; i++) {
      for (const s of [1, -1]) {
        const y = [...x];
        y[i] = Math.min(ps[i].hi, Math.max(ps[i].lo, y[i] + s * step * scale[i]));
        const fy = cost(y);
        evals++;
        if (fy < fx - 1e-12) {
          x.splice(0, x.length, ...y);
          fx = fy;
          improved = true;
        }
      }
    }
    if (!improved) step /= 2;
  }
  const ov: Record<string, number> = {};
  ps.forEach((p, i) => (ov[p.name] = x[i]));
  if (minMargin(ctx, ov) < 0) return null;
  // friendly rounding, keep feasibility
  const rounded = x.map((v, i) => {
    const dir = v >= ps[i].v0 ? 1 : -1;
    const r = Math.round((dir > 0 ? Math.ceil(v * 10 - 1e-9) : Math.floor(v * 10 + 1e-9))) / 10;
    return r;
  });
  const ov2: Record<string, number> = {};
  ps.forEach((p, i) => (ov2[p.name] = rounded[i]));
  const final = minMargin(ctx, ov2) >= 0 ? rounded : x;
  return ps.map((p, i) => ({ param: p.name, from: p.v0, to: Math.round(final[i] * 1000) / 1000 }));
}

function makeOption(changes: { param: string; from: number; to: number }[], params: Model["params"]): FixOption {
  const cost = changes.reduce((s, c) => s + Math.abs(c.to - c.from) / Math.max(Math.abs(c.from), 1), 0);
  const summary = changes
    .map((c) => {
      const p = params.find((q) => q.name === c.param);
      const pct = c.from ? ((c.to - c.from) / Math.abs(c.from)) * 100 : 0;
      return `${c.param} ${fmtNum(c.from)} → ${fmtNum(c.to)}${p?.desc ? "" : ""} (${pct >= 0 ? "+" : ""}${fmtNum(pct, 1)}%)`;
    })
    .join(", ");
  return { changes, cost, summary };
}

function sameChanges(o: FixOption, changes: { param: string; to: number }[]) {
  return o.changes.length === changes.length && o.changes.every((c) => changes.some((d) => d.param === c.param && Math.abs(d.to - c.to) < 1e-6));
}
